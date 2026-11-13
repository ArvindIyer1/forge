import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import type { ChatMessage, ModelProvider, ProviderEvent, ToolCall } from "../src/providers/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Workspace } from "../src/tools/workspace.js";
import { writeFileTool } from "../src/tools/write-file.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-test-"));
  temporaryRoots.push(root);
  return Workspace.create(root);
}

class FakeProvider implements ModelProvider {
  readonly id = "gemini" as const;
  readonly model = "fake-model";
  readonly requests: Array<{ messages: readonly ChatMessage[]; toolNames: string[] }> = [];

  constructor(private readonly turns: ProviderEvent[][]) {}

  async *streamTurn(
    messages: readonly ChatMessage[],
    tools: readonly { name: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    signal?.throwIfAborted();
    this.requests.push({ messages: structuredClone(messages), toolNames: tools.map((tool) => tool.name) });
    const turn = this.turns.shift();
    if (!turn) throw new Error("No fake response was configured.");
    yield* turn;
  }

  formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function makeCall(id: string, name: string, value = "ok"): ToolCall {
  return { id, name, arguments: { value } };
}

function registryWith(...names: string[]) {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `Test tool ${name}.`,
      schema: z.object({ value: z.string() }).strict(),
      execute: ({ value }: { value: string }) => ({ name, value }),
    });
  }
  return registry;
}

describe("Agent loop", () => {
  it("executes a tool and continues until the provider returns a final answer", async () => {
    const workspace = await makeWorkspace();
    const provider = new FakeProvider([
      [{ type: "text_delta", text: "I will inspect that. " }, { type: "turn_complete", toolCalls: [makeCall("1", "inspect")] }],
      [{ type: "text_delta", text: "Here is the result." }, { type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registryWith("inspect"), { workspace });
    const output: string[] = [];

    const result = await agent.runTask("Inspect the project", { onText: (text) => output.push(text) });

    expect(result).toMatchObject({ status: "completed", iterations: 2, toolCalls: 1 });
    expect(output.join("")).toBe("I will inspect that. Here is the result.");
    expect(provider.requests[0].toolNames).toEqual(["inspect"]);
    expect(provider.requests[1].messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: "Inspect the project" },
      {
        role: "assistant",
        content: "I will inspect that. ",
        toolCalls: [makeCall("1", "inspect")],
      },
      {
        role: "tool",
        toolCallId: "1",
        name: "inspect",
        content: JSON.stringify({ ok: true, result: { name: "inspect", value: "ok" } }),
      },
    ]);
    expect(agent.history.at(-1)).toEqual({ role: "assistant", content: "Here is the result." });
  });

  it("executes multiple calls from the same model turn", async () => {
    const workspace = await makeWorkspace();
    const executionOrder: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ["first", "second"]) {
      registry.register({
        name,
        description: name,
        schema: z.object({ value: z.string() }),
        execute: () => {
          executionOrder.push(name);
          return name;
        },
      });
    }
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [makeCall("1", "first"), makeCall("2", "second")] }],
      [{ type: "text_delta", text: "Done." }, { type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });

    const result = await agent.runTask("Run both read operations");

    expect(result).toMatchObject({ status: "completed", toolCalls: 2 });
    expect(executionOrder).toEqual(["first", "second"]);
    expect(agent.history.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("stops before executing calls on the final allowed iteration", async () => {
    const workspace = await makeWorkspace();
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "repeat",
      description: "A repeat tool.",
      schema: z.object({ value: z.string() }),
      execute: () => {
        executions += 1;
        return "ok";
      },
    });
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [makeCall("1", "repeat")] }],
      [{ type: "turn_complete", toolCalls: [makeCall("2", "repeat")] }],
    ]);
    const agent = new Agent(provider, registry, { workspace }, { maxIterations: 2 });

    const result = await agent.runTask("Repeat forever");

    expect(result).toMatchObject({ status: "iteration_limit", iterations: 2 });
    expect(executions).toBe(1);
    expect(JSON.parse(agent.history.at(-1)!.content)).toMatchObject({ ok: false });
  });

  it("enforces the total tool-call budget and leaves a result for rejected calls", async () => {
    const workspace = await makeWorkspace();
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "once",
      description: "A counted tool.",
      schema: z.object({ value: z.string() }),
      execute: () => {
        executions += 1;
        return "ok";
      },
    });
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [makeCall("1", "once")] }],
      [{ type: "turn_complete", toolCalls: [makeCall("2", "once")] }],
      [{ type: "text_delta", text: "Finished." }, { type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace }, { maxToolCallsPerTask: 1 });

    const result = await agent.runTask("Use the tool only once");

    expect(result.status).toBe("completed");
    expect(executions).toBe(1);
    expect(agent.history.some((message) => message.role === "tool" && message.content.includes("maximum number"))).toBe(true);
  });

  it("limits the number of calls in one model response", async () => {
    const workspace = await makeWorkspace();
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "once",
      description: "A counted tool.",
      schema: z.object({ value: z.string() }),
      execute: () => {
        executions += 1;
        return "ok";
      },
    });
    const provider = new FakeProvider([
      [{
        type: "turn_complete",
        toolCalls: [
          makeCall("1", "once"),
          makeCall("2", "once"),
          makeCall("3", "once"),
          makeCall("4", "once"),
          makeCall("5", "once"),
        ],
      }],
      [{ type: "text_delta", text: "Finished." }, { type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });

    const result = await agent.runTask("Use the tool a few times");

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(5);
    expect(executions).toBe(4);
    expect(agent.history.some((message) => message.role === "tool" && message.content.includes("At most 4"))).toBe(true);
  });

  it("rolls back the current task if cancellation happens before a model request", async () => {
    const workspace = await makeWorkspace();
    const provider = new FakeProvider([]);
    const agent = new Agent(provider, registryWith("inspect"), { workspace });
    const controller = new AbortController();
    controller.abort();

    await expect(agent.runTask("cancel me", {}, controller.signal)).rejects.toThrow();
    expect(agent.history).toHaveLength(1);
    expect(agent.history[0].role).toBe("system");
    expect(provider.requests).toHaveLength(0);
  });

  it("returns a rejected approval to the model without creating the file", async () => {
    const workspace = await makeWorkspace();
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [{ id: "write-1", name: "write_file", arguments: { path: "new.txt", content: "content" } }] }],
      [{ type: "text_delta", text: "I left it unchanged." }, { type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });
    let proposals = 0;

    const result = await agent.runTask("Create a file", {
      requestApproval: async (proposal) => {
        proposals += 1;
        expect(proposal.path).toBe("new.txt");
        return "rejected";
      },
    });

    expect(result.status).toBe("completed");
    expect(proposals).toBe(1);
    await expect(workspace.readTextFile("new.txt")).rejects.toThrow();
    expect(provider.requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({ ok: true, result: { status: "rejected", path: "new.txt", operation: "create" } }),
    });
  });

  it("does not accept model arguments as approval", async () => {
    const workspace = await makeWorkspace();
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [{ id: "write-1", name: "write_file", arguments: { path: "new.txt", content: "content", approved: true } }] }],
      [{ type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });
    let approvalRequests = 0;

    await agent.runTask("Create a file", {
      requestApproval: async () => {
        approvalRequests += 1;
        return "approved";
      },
    });

    expect(approvalRequests).toBe(0);
    await expect(workspace.readTextFile("new.txt")).rejects.toThrow();
    expect(provider.requests[1].messages.at(-1)?.content).toContain("Invalid arguments");
  });

  it("requests separate approval for each proposed operation in a model turn", async () => {
    const workspace = await makeWorkspace();
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const provider = new FakeProvider([
      [{
        type: "turn_complete",
        toolCalls: [
          { id: "write-1", name: "write_file", arguments: { path: "one.txt", content: "one" } },
          { id: "write-2", name: "write_file", arguments: { path: "two.txt", content: "two" } },
        ],
      }],
      [{ type: "turn_complete", toolCalls: [] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });
    const approvedPaths: string[] = [];

    await agent.runTask("Create two files", {
      requestApproval: async (proposal) => {
        approvedPaths.push(proposal.path);
        return proposal.path === "one.txt" ? "approved" : "rejected";
      },
    });

    expect(approvedPaths).toEqual(["one.txt", "two.txt"]);
    expect(await workspace.readTextFile("one.txt")).toBe("one");
    await expect(workspace.readTextFile("two.txt")).rejects.toThrow();
  });

  it("cancels a pending approval without applying or retaining the task", async () => {
    const workspace = await makeWorkspace();
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const provider = new FakeProvider([
      [{ type: "turn_complete", toolCalls: [{ id: "write-1", name: "write_file", arguments: { path: "new.txt", content: "content" } }] }],
    ]);
    const agent = new Agent(provider, registry, { workspace });
    const controller = new AbortController();
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });

    const task = agent.runTask("Create a file", {
      requestApproval: async (_proposal, signal) => {
        approvalStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }, controller.signal);
    await started;
    controller.abort(new Error("Cancelled by test."));

    await expect(task).rejects.toThrow("Cancelled by test");
    await expect(workspace.readTextFile("new.txt")).rejects.toThrow();
    expect(agent.history).toHaveLength(1);
  });
});
