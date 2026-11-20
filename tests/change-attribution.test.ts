import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ChangeAttributionTracker } from "../src/tools/change-attribution.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { GitService } from "../src/git/git-service.js";
import { Workspace } from "../src/tools/workspace.js";
import type { ToolContext } from "../src/tools/types.js";
import { Agent } from "../src/agent/agent.js";
import { createDefaultToolRegistry } from "../src/tools/create-default.js";
import type { ModelProvider, ProviderEvent, ToolCall } from "../src/providers/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-attribution-"));
  roots.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, shell: false, stdio: "ignore", env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    } });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("fixture git failed")));
  });
}

async function repo(files: Record<string, string> = {}) {
  const root = await temp();
  await git(root, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "baseline"]);
  const workspace = await Workspace.create(root);
  const gitService = await GitService.create(workspace);
  if (!gitService) throw new Error("Expected Git service");
  return { root, workspace, gitService };
}

async function create(context: ToolContext, path: string, content: string, approved = true) {
  return writeFileTool.execute({ path, content }, { ...context, requestApproval: async () => approved ? "approved" : "rejected" });
}

async function edit(context: ToolContext, path: string, old_text: string, new_text: string, approved = true) {
  return editFileTool.execute({ path, old_text, new_text }, { ...context, requestApproval: async () => approved ? "approved" : "rejected" });
}

function entry(report: Awaited<ReturnType<ChangeAttributionTracker["report"]>>, path: string) {
  return report.files.find((file) => file.path === path);
}

class TaskProvider implements ModelProvider {
  readonly id = "gemini" as const;
  readonly model = "fixture";
  private index = 0;
  constructor(private readonly turns: Array<{ calls?: ToolCall[]; text?: string }>) {}
  async *streamTurn(): AsyncGenerator<ProviderEvent> {
    const turn = this.turns[this.index++] ?? { text: "done" };
    if (turn.text) yield { type: "text_delta", text: turn.text };
    yield { type: "turn_complete", toolCalls: turn.calls ?? [] };
  }
  formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}

describe("task change attribution", () => {
  it("captures clean baseline and attributes a successfully created file", async () => {
    const { workspace, gitService } = await repo({ "clean.txt": "baseline\n" });
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    expect(tracker.taskId).toBeTruthy();
    expect(entry(await tracker.report("clean.txt"), "clean.txt")?.classification).toBe("clean");
    await create({ workspace, gitService, changeAttribution: tracker }, "created.txt", "forge content\n");
    expect(entry(await tracker.report(), "created.txt")).toMatchObject({
      classification: "forge_applied", baseline_classification: "clean", forge_applied: true, operations: ["create"],
    });
  });

  it("classifies pre-existing modified, staged, and untracked files", async () => {
    const { root, workspace, gitService } = await repo({ "modified.txt": "base\n", "staged.txt": "base\n" });
    await writeFile(join(root, "modified.txt"), "user edit\n");
    await writeFile(join(root, "staged.txt"), "staged edit\n");
    await git(root, ["add", "--", "staged.txt"]);
    await writeFile(join(root, "untracked.txt"), "already here\n");
    const report = await (await ChangeAttributionTracker.capture(workspace, gitService)).report();
    for (const path of ["modified.txt", "staged.txt", "untracked.txt"]) {
      expect(entry(report, path)).toMatchObject({ classification: "pre_existing", forge_applied: false });
    }
  });

  it("records only approved successful edits and leaves rejected proposals unclaimed", async () => {
    const { workspace, gitService } = await repo({ "edit.txt": "before\n" });
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    const context = { workspace, gitService, changeAttribution: tracker };
    await edit(context, "edit.txt", "before", "after", false);
    expect(entry(await tracker.report("edit.txt"), "edit.txt")).toMatchObject({ classification: "clean", forge_applied: false });
    await edit(context, "edit.txt", "before", "after");
    expect(entry(await tracker.report(), "edit.txt")).toMatchObject({ classification: "forge_applied", operations: ["edit"] });
  });

  it("does not record stale approved proposals or canceled writes", async () => {
    const { workspace, gitService } = await repo({ "edit.txt": "before\n" });
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    await expect(editFileTool.execute({ path: "edit.txt", old_text: "before", new_text: "forge" }, {
      workspace, gitService, changeAttribution: tracker,
      requestApproval: async () => { await writeFile(join(workspace.root, "edit.txt"), "external\n"); return "approved"; },
    })).rejects.toThrow("changed after");
    expect(entry(await tracker.report("edit.txt"), "edit.txt")).toMatchObject({ classification: "unknown", forge_applied: false });

    const canceled = await ChangeAttributionTracker.capture(workspace, gitService);
    const controller = new AbortController();
    await expect(writeFileTool.execute({ path: "new.txt", content: "x" }, {
      workspace, gitService, changeAttribution: canceled, signal: controller.signal,
      requestApproval: async () => { controller.abort(new Error("cancelled")); return "approved"; },
    })).rejects.toThrow("cancelled");
    expect(entry(await canceled.report("new.txt"), "new.txt")).toMatchObject({ classification: "unknown", forge_applied: false });

    const failed = await ChangeAttributionTracker.capture(workspace, gitService);
    await expect(writeFileTool.execute({ path: "external-create.txt", content: "forge" }, {
      workspace, gitService, changeAttribution: failed,
      requestApproval: async () => {
        await writeFile(join(workspace.root, "external-create.txt"), "external\n");
        return "approved";
      },
    })).rejects.toThrow("cannot overwrite");
    expect(entry(await failed.report("external-create.txt"), "external-create.txt")).toMatchObject({
      classification: "unknown", forge_applied: false,
    });
  });

  it("detects later external modification, deletion, and replacement", async () => {
    const { workspace, gitService } = await repo();
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    const context = { workspace, gitService, changeAttribution: tracker };
    await create(context, "modified.txt", "forge\n");
    await writeFile(join(workspace.root, "modified.txt"), "external\n");
    expect(entry(await tracker.report(), "modified.txt")?.classification).toBe("modified_after_forge");

    await create(context, "deleted.txt", "forge\n");
    await unlink(join(workspace.root, "deleted.txt"));
    expect(entry(await tracker.report(), "deleted.txt")?.classification).toBe("modified_after_forge");

    await create(context, "replaced.txt", "same\n");
    const replacement = join(workspace.root, "replacement.tmp");
    await writeFile(replacement, "same\n");
    await rename(replacement, join(workspace.root, "replaced.txt"));
    expect(entry(await tracker.report(), "replaced.txt")?.classification).toBe("modified_after_forge");

    await create(context, "renamed.txt", "forge\n");
    await rename(join(workspace.root, "renamed.txt"), join(workspace.root, "moved.txt"));
    const report = await tracker.report();
    expect(entry(report, "renamed.txt")?.classification).toBe("modified_after_forge");
    expect(entry(report, "moved.txt")?.classification).toBe("unknown");
  });

  it("keeps multiple edit events and preserves pre-existing classification", async () => {
    const { root, workspace, gitService } = await repo({ "edit.txt": "one\n", "dirty.txt": "base\n" });
    await writeFile(join(root, "dirty.txt"), "user change\n");
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    const context = { workspace, gitService, changeAttribution: tracker };
    await edit(context, "edit.txt", "one", "two");
    await edit(context, "edit.txt", "two", "three");
    expect(entry(await tracker.report(), "edit.txt")).toMatchObject({ classification: "forge_applied", operations: ["edit", "edit"] });
    await edit(context, "dirty.txt", "user change", "combined");
    expect(entry(await tracker.report(), "dirty.txt")).toMatchObject({
      classification: "pre_existing", baseline_classification: "pre_existing", forge_applied: true, operations: ["edit"],
    });
  });

  it("isolates tasks and reports unknown for incomplete baselines or external changes", async () => {
    const { root, workspace, gitService } = await repo({ "file.txt": "base\n" });
    const first = await ChangeAttributionTracker.capture(workspace, gitService);
    await create({ workspace, gitService, changeAttribution: first }, "task-one.txt", "one\n");
    const second = await ChangeAttributionTracker.capture(workspace, gitService);
    expect(second.taskId).not.toBe(first.taskId);
    expect(entry(await second.report(), "task-one.txt")).toMatchObject({ classification: "pre_existing", forge_applied: false });

    const incomplete = await ChangeAttributionTracker.capture(workspace, null);
    expect((await incomplete.report()).baseline_complete).toBe(false);
    expect(entry(await incomplete.report("never-seen.txt"), "never-seen.txt")?.classification).toBe("unknown");
    expect(entry(await incomplete.report(), "file.txt")?.classification).toBe("unknown");

    const originalListFiles = workspace.listFiles.bind(workspace);
    workspace.listFiles = async () => ({ files: [], truncated: true });
    const truncatedInventory = await ChangeAttributionTracker.capture(workspace, gitService);
    expect((await truncatedInventory.report()).baseline_complete).toBe(false);
    expect(entry(await truncatedInventory.report("missing-from-inventory.txt"), "missing-from-inventory.txt")?.classification)
      .toBe("unknown");
    workspace.listFiles = originalListFiles;

    const cleanBaseline = await ChangeAttributionTracker.capture(workspace, gitService);
    await writeFile(join(root, "file.txt"), "external change\n");
    expect(entry(await cleanBaseline.report("file.txt"), "file.txt")).toMatchObject({ classification: "unknown", forge_applied: false });
  });

  it("uses one tracker per Agent task and exposes it to the attribution tool", async () => {
    const { workspace, gitService } = await repo();
    const provider = new TaskProvider([
      { calls: [{ id: "write", name: "write_file", arguments: { path: "task.txt", content: "created\n" } }] },
      { calls: [{ id: "query", name: "get_change_attribution", arguments: { path: "task.txt" } }] },
      { text: "done" },
      { text: "done again" },
    ]);
    const agent = new Agent(provider, createDefaultToolRegistry(), { workspace, gitService });
    const first = await agent.runTask("create", { requestApproval: async () => "approved" });
    expect(entry(first.attribution, "task.txt")?.classification).toBe("forge_applied");
    const queryResult = agent.history.find((message) => message.role === "tool" && message.name === "get_change_attribution");
    expect(queryResult?.role === "tool" ? queryResult.content : "").toContain('"classification":"forge_applied"');

    const second = await agent.runTask("next task");
    expect(second.attribution.task_id).not.toBe(first.attribution.task_id);
    expect(entry(second.attribution, "task.txt")).toMatchObject({ classification: "pre_existing", forge_applied: false });
  });

  it("keeps attribution unknown when a file changes after baseline but before proposal creation", async () => {
    const { root, workspace, gitService } = await repo({ "file.txt": "task-start\n" });
    const tracker = await ChangeAttributionTracker.capture(workspace, gitService);
    await writeFile(join(root, "file.txt"), "external before proposal\n");
    await edit({ workspace, gitService, changeAttribution: tracker }, "file.txt", "external before proposal", "combined");
    expect(entry(await tracker.report(), "file.txt")).toMatchObject({
      classification: "unknown", baseline_classification: "clean", forge_applied: true, operations: ["edit"],
    });
  });

  it("emits conservative attribution on task cancellation", async () => {
    const { workspace, gitService } = await repo();
    const provider = new TaskProvider([
      { calls: [{ id: "write", name: "write_file", arguments: { path: "cancel.txt", content: "created\n" } }] },
    ]);
    const agent = new Agent(provider, createDefaultToolRegistry(), { workspace, gitService });
    const controller = new AbortController();
    let report: Awaited<ReturnType<ChangeAttributionTracker["report"]>> | undefined;
    await expect(agent.runTask("cancel", {
      requestApproval: async () => { controller.abort(new Error("cancelled")); return "approved"; },
      onAttribution: (value) => { report = value; },
    }, controller.signal)).rejects.toThrow("cancelled");
    expect(report?.files).toEqual([]);
    await expect(workspace.readTextFile("cancel.txt")).rejects.toThrow();
  });

  it("rejects overlapping tasks so their attribution trackers cannot be shared", async () => {
    const { workspace, gitService } = await repo();
    const provider = new TaskProvider([
      { calls: [{ id: "write", name: "write_file", arguments: { path: "concurrent.txt", content: "created\n" } }] },
      { text: "done" },
    ]);
    const agent = new Agent(provider, createDefaultToolRegistry(), { workspace, gitService });
    let approve!: (decision: "approved" | "rejected") => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const first = agent.runTask("first", { requestApproval: async () => {
      approvalStarted();
      return new Promise((resolve) => { approve = resolve; });
    } });
    await started;
    await expect(agent.runTask("overlap")).rejects.toThrow("already running");
    approve("approved");
    const result = await first;
    expect(entry(result.attribution, "concurrent.txt")?.classification).toBe("forge_applied");
  });
});
