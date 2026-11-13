import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolCall } from "../src/providers/types.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { createDefaultToolRegistry } from "../src/tools/create-default.js";
import { listFilesTool } from "../src/tools/list-files.js";
import { readFileTool } from "../src/tools/read-file.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { searchFilesTool } from "../src/tools/search-files.js";
import { MAX_READ_BYTES, Workspace } from "../src/tools/workspace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "forge-workspace-test-"));
  temporaryRoots.push(root);
  return Workspace.create(root);
}

function makeCall(name: string, args: unknown, id = "call-1"): ToolCall {
  return { id, name, arguments: args };
}

describe("tool registry and executor", () => {
  it("registers the three read-only tools and produces provider-neutral definitions", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.size).toBe(3);
    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "list_files",
      "read_file",
      "search_files",
    ]);
    expect(registry.definitions()[1].parameters).toMatchObject({ type: "object" });
  });

  it("rejects duplicate registrations", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "echo",
      description: "Echo a string.",
      schema: z.object({ text: z.string() }),
      execute: ({ text }: { text: string }) => text,
    };

    registry.register(tool);
    expect(() => registry.register(tool)).toThrow('A tool named "echo" is already registered.');
  });

  it("returns structured results for unknown tools and invalid arguments", async () => {
    const workspace = await makeWorkspace();
    const executor = new ToolExecutor(createDefaultToolRegistry());
    const context = { workspace };

    const unknown = await executor.execute(makeCall("run_shell", {}), context);
    const invalid = await executor.execute(makeCall("read_file", { path: "file.txt", extra: true }), context);

    expect(unknown.ok).toBe(false);
    expect(JSON.parse(unknown.content).error).toContain("Unknown tool");
    expect(invalid.ok).toBe(false);
    expect(JSON.parse(invalid.content).error).toContain("Invalid arguments");
  });

  it("catches tool execution errors and handles several calls in order", async () => {
    const workspace = await makeWorkspace();
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "record",
      description: "Record a value.",
      schema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        order.push(value);
        if (value === "fail") throw new Error("expected failure");
        return { value };
      },
    });
    const executor = new ToolExecutor(registry);

    const results = await executor.executeMany(
      [makeCall("record", { value: "first" }, "1"), makeCall("record", { value: "fail" }, "2")],
      { workspace },
    );

    expect(order).toEqual(["first", "fail"]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(JSON.parse(results[1].content).error).toBe("expected failure");
  });
});

describe("workspace file tools", () => {
  it("blocks traversal, absolute paths, symlinks, and sensitive files", async () => {
    const workspace = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-test-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "outside.txt"), "private");
    await symlink(outside, join(workspace.root, "outside-link"));
    await writeFile(join(workspace.root, ".env"), "SECRET=value");
    await writeFile(join(workspace.root, "visible.txt"), "visible");

    await expect(workspace.readTextFile("../outside.txt")).rejects.toThrow("Path traversal");
    await expect(workspace.readTextFile(join(outside, "outside.txt"))).rejects.toThrow("Absolute paths");
    await expect(workspace.readTextFile("outside-link/outside.txt")).rejects.toThrow("Symbolic links");
    await expect(workspace.readTextFile(".env")).rejects.toThrow("blocked");

    const listing = await workspace.listFiles();
    expect(listing.files).toEqual(["visible.txt"]);
  });

  it("rejects oversized, binary, and invalid UTF-8 files", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "large.txt"), Buffer.alloc(MAX_READ_BYTES + 1, 65));
    await writeFile(join(workspace.root, "binary.dat"), Buffer.from([65, 0, 66]));
    await writeFile(join(workspace.root, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    await expect(workspace.readTextFile("large.txt")).rejects.toThrow("read limit");
    await expect(workspace.readTextFile("binary.dat")).rejects.toThrow("Binary files");
    await expect(workspace.readTextFile("invalid.txt")).rejects.toThrow("valid UTF-8");
  });

  it("lists and searches literal text while excluding sensitive files", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "one.ts"), "Agent tools are read only.\nNo shell here.");
    await writeFile(join(workspace.root, "src", "two.ts"), "The agent loop is bounded.");
    await writeFile(join(workspace.root, ".env.local"), "agent secret");

    const listed = await listFilesTool.execute({ path: "." }, { workspace });
    const result = await searchFilesTool.execute({ query: "agent" }, { workspace });

    expect(listed.files).toEqual(["src/one.ts", "src/two.ts"]);
    expect(result.matches).toEqual([
      { path: "src/one.ts", line: 1, preview: "Agent tools are read only." },
      { path: "src/two.ts", line: 1, preview: "The agent loop is bounded." },
    ]);
    await expect(readFileTool.execute({ path: ".env.local" }, { workspace })).rejects.toThrow("blocked");
  });
});
