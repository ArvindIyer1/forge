import { afterEach, describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { startTerminalChat } from "../src/cli/chat.js";
import type { ModelProvider, ProviderEvent } from "../src/providers/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Workspace } from "../src/tools/workspace.js";
import { writeFileTool } from "../src/tools/write-file.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "forge-cli-test-"));
  temporaryRoots.push(root);
  return Workspace.create(root);
}

class WriteThenFinishProvider implements ModelProvider {
  readonly id = "gemini" as const;
  readonly model = "mock-model";
  private turn = 0;

  constructor(private readonly content = "hello\n") {}

  async *streamTurn(): AsyncGenerator<ProviderEvent> {
    if (this.turn++ === 0) {
      yield {
        type: "turn_complete",
        toolCalls: [{ id: "write-1", name: "write_file", arguments: { path: "new.txt", content: this.content } }],
      };
    } else {
      yield { type: "text_delta", text: "Finished." };
      yield { type: "turn_complete", toolCalls: [] };
    }
  }

  formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

class CaptureOutput extends Writable {
  text = "";
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    this.emit("captured");
    callback();
  }
}

async function waitForOutput(output: CaptureOutput, text: string): Promise<void> {
  if (output.text.includes(text)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      output.off("captured", onCaptured);
      reject(new Error(`Timed out waiting for terminal output: ${text}`));
    }, 2000);
    const onCaptured = () => {
      if (!output.text.includes(text)) return;
      clearTimeout(timeout);
      output.off("captured", onCaptured);
      resolve();
    };
    output.on("captured", onCaptured);
  });
}

function makeAgent(workspace: Workspace, provider = new WriteThenFinishProvider()): Agent {
  const registry = new ToolRegistry();
  registry.register(writeFileTool);
  return new Agent(provider, registry, { workspace });
}

describe("terminal file approval", () => {
  it("shows a unified diff and requires an explicit A to approve", async () => {
    const workspace = await makeWorkspace();
    const input = new PassThrough();
    const output = new CaptureOutput();
    const running = startTerminalChat(new WriteThenFinishProvider(), makeAgent(workspace), { input, output });

    input.write("create a file\n");
    await waitForOutput(output, "[A]pprove / [R]eject (Enter rejects)");
    expect(output.text).toContain("Proposed create: new.txt");
    expect(output.text).toContain("+hello");
    input.write("a\n/exit\n");
    await running;

    expect(await workspace.readTextFile("new.txt")).toBe("hello\n");
    expect(output.text).toContain("Approved.");
  });

  it("treats Enter as rejection and makes no change", async () => {
    const workspace = await makeWorkspace();
    const input = new PassThrough();
    const output = new CaptureOutput();
    const running = startTerminalChat(new WriteThenFinishProvider(), makeAgent(workspace), { input, output });

    input.write("create a file\n");
    await waitForOutput(output, "[A]pprove / [R]eject (Enter rejects)");
    input.write("\n/exit\n");
    await running;

    await expect(workspace.readTextFile("new.txt")).rejects.toThrow();
    expect(output.text).toContain("Rejected. No file change was made.");
  });

  it("renders file supplied terminal escape codes as harmless text", async () => {
    const workspace = await makeWorkspace();
    const input = new PassThrough();
    const output = new CaptureOutput();
    const provider = new WriteThenFinishProvider("\u001b[31mred\u001b[0m\n");
    const running = startTerminalChat(provider, makeAgent(workspace, provider), { input, output });

    input.write("create a file\n");
    await waitForOutput(output, "[A]pprove / [R]eject (Enter rejects)");
    expect(output.text).toContain("␛[31mred␛[0m");
    expect(output.text).not.toContain("\u001b");
    input.write("r\n/exit\n");
    await running;
  });

  it("cancels a pending approval on Ctrl+C", async () => {
    const workspace = await makeWorkspace();
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => PassThrough };
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new CaptureOutput();
    const agent = makeAgent(workspace);
    const running = startTerminalChat(new WriteThenFinishProvider(), agent, { input, output });

    input.write("create a file\n");
    await waitForOutput(output, "[A]pprove / [R]eject (Enter rejects)");
    input.write("\u0003");
    await running;

    await expect(workspace.readTextFile("new.txt")).rejects.toThrow();
    expect(agent.history).toHaveLength(1);
    expect(output.text).toContain("Turn cancelled.");
  });
});
