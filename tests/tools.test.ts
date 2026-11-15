import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolCall } from "../src/providers/types.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { createDefaultToolRegistry } from "../src/tools/create-default.js";
import { listFilesTool } from "../src/tools/list-files.js";
import { readFileTool } from "../src/tools/read-file.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { prepareCreate, prepareEdit, applyFileChange } from "../src/tools/file-changes.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { searchFilesTool } from "../src/tools/search-files.js";
import { writeFileTool } from "../src/tools/write-file.js";
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
  it("registers workspace and Git tools with provider-neutral definitions", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.size).toBe(10);
    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "write_file",
      "edit_file",
      "git_status",
      "git_diff",
      "git_diff_staged",
      "git_log",
      "git_branch",
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

describe("write and edit file tools", () => {
  it("creates a new file but never overwrites an existing destination", async () => {
    const workspace = await makeWorkspace();
    const context = { workspace, requestApproval: async () => "approved" as const };
    const created = await writeFileTool.execute({ path: "new.txt", content: "new content\n" }, context);
    expect(created).toMatchObject({ operation: "create", path: "new.txt" });
    expect(await workspace.readTextFile("new.txt")).toBe("new content\n");

    await expect(writeFileTool.execute({ path: "new.txt", content: "replacement" }, context))
      .rejects.toThrow("cannot overwrite");
    expect(await workspace.readTextFile("new.txt")).toBe("new content\n");
  });

  it("requires existing parents, validates paths, and rejects protected or binary targets", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, ".env"), "secret");
    await writeFile(join(workspace.root, "ordinary.txt"), "text");
    await symlink(join(workspace.root, "ordinary.txt"), join(workspace.root, "alias.txt"));

    const context = { workspace, requestApproval: async () => "approved" as const };
    await expect(writeFileTool.execute({ path: "missing/new.txt", content: "x" }, context)).rejects.toThrow();
    await expect(writeFileTool.execute({ path: "../escape.txt", content: "x" }, context)).rejects.toThrow("Path traversal");
    await expect(writeFileTool.execute({ path: ".env", content: "x" }, context)).rejects.toThrow("safe workspace-relative");
    await expect(editFileTool.execute({ path: ".env", old_text: "secret", new_text: "x" }, context)).rejects.toThrow("blocked");
    await expect(editFileTool.execute({ path: "alias.txt", old_text: "text", new_text: "x" }, context)).rejects.toThrow("Symbolic links");
    await expect(writeFileTool.execute({ path: "binary", content: "a\0b" }, context)).rejects.toThrow("Binary");
    await expect(writeFileTool.execute({ path: "large", content: "x".repeat(MAX_READ_BYTES + 1) }, context)).rejects.toThrow();
  });

  it("edits one unique match and preserves the rest of the file", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "code.ts"), "const old = 1;\nkeep this\n");

    const result = await editFileTool.execute(
      { path: "code.ts", old_text: "old = 1", new_text: "new = 2" },
      { workspace, requestApproval: async () => "approved" as const },
    );

    expect(result).toMatchObject({ operation: "edit", path: "code.ts" });
    expect(await workspace.readTextFile("code.ts")).toBe("const new = 2;\nkeep this\n");
  });

  it("preserves a UTF-8 byte order mark when editing text", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "bom.txt"), Buffer.from("\uFEFFbefore and after", "utf8"));

    await editFileTool.execute(
      { path: "bom.txt", old_text: "before", new_text: "updated" },
      { workspace, requestApproval: async () => "approved" },
    );

    expect(await workspace.readTextFile("bom.txt")).toBe("\uFEFFupdated and after");
  });

  it("does not publish stale proposals and cleans up temporary files", async () => {
    const workspace = await makeWorkspace();
    const create = await prepareCreate(workspace, "race.txt", "approved content");
    const originalTarget = workspace.resolveNewFileTarget.bind(workspace);
    let targetChecks = 0;
    workspace.resolveNewFileTarget = async (path) => {
      targetChecks += 1;
      if (targetChecks === 4) await writeFile(join(workspace.root, "race.txt"), "created concurrently");
      return originalTarget(path);
    };

    await expect(applyFileChange(workspace, create)).rejects.toThrow();
    expect(await workspace.readTextFile("race.txt")).toBe("created concurrently");
    expect((await readdir(workspace.root)).filter((name) => name.startsWith(".forge-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects an edit if the target changes while the replacement is being staged", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "edit.txt"), "before");
    const proposal = await prepareEdit(workspace, "edit.txt", "before", "after");
    const originalSnapshot = workspace.readTextSnapshot.bind(workspace);
    let snapshotReads = 0;
    workspace.readTextSnapshot = async (...args) => {
      snapshotReads += 1;
      if (snapshotReads === 2) await writeFile(join(workspace.root, "edit.txt"), "concurrent edit");
      return originalSnapshot(...args);
    };

    await expect(applyFileChange(workspace, proposal)).rejects.toThrow("changed after");
    expect(await originalSnapshot("edit.txt").then((snapshot) => snapshot.content)).toBe("concurrent edit");
    expect((await readdir(workspace.root)).filter((name) => name.startsWith(".forge-") && name.endsWith(".tmp"))).toEqual([]);
  });
});
