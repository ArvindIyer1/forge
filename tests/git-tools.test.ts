import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ToolCall } from "../src/providers/types.js";
import { GitService } from "../src/git/git-service.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { createDefaultToolRegistry } from "../src/tools/create-default.js";
import { Workspace } from "../src/tools/workspace.js";
import type { ToolContext } from "../src/tools/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-git-tools-"));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`fixture git failed (${code})`)));
  });
}

async function makeRepo(files: Record<string, string> = {}): Promise<{ root: string; workspace: Workspace; context: ToolContext }> {
  const root = await temp();
  await git(root, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  if (Object.keys(files).length) {
    await git(root, ["add", "--all"]);
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture commit"]);
  } else {
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial commit"]);
  }
  const workspace = await Workspace.create(root);
  const gitService = await GitService.create(workspace);
  return { root, workspace, context: { workspace, gitService } };
}

async function call(context: ToolContext, name: string, args: unknown = {}): Promise<{ ok: boolean; result?: any; error?: string }> {
  const executor = new ToolExecutor(createDefaultToolRegistry());
  const toolCall: ToolCall = { id: `${name}-call`, name, arguments: args };
  const executed = await executor.execute(toolCall, context);
  return JSON.parse(executed.content);
}

describe("read-only Git tools", () => {
  it("reports a clean repository, current branch, and upstream", async () => {
    const { root, context } = await makeRepo({ "tracked.txt": "clean\n" });
    await git(root, ["remote", "add", "origin", root]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["branch", "--set-upstream-to=origin/main", "main"]);

    const result = await call(context, "git_status");
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      is_repository: true,
      state: "clean",
      current_branch: "main",
      upstream: "origin/main",
      detached: false,
      staged: [],
      unstaged: [],
      untracked: [],
      truncated: false,
    });
  });

  it("separates staged, unstaged, and untracked paths, including a file dirty in both states", async () => {
    const { root, context } = await makeRepo({
      "staged.txt": "base staged\n",
      "both.txt": "base both\n",
      "unstaged.txt": "base unstaged\n",
    });
    await writeFile(join(root, "staged.txt"), "staged change\n");
    await writeFile(join(root, "both.txt"), "index change\n");
    await git(root, ["add", "--", "staged.txt", "both.txt"]);
    await writeFile(join(root, "both.txt"), "worktree change\n");
    await writeFile(join(root, "unstaged.txt"), "unstaged change\n");
    await writeFile(join(root, "new.txt"), "untracked\n");

    const result = await call(context, "git_status");
    expect(result.ok).toBe(true);
    expect(result.result.state).toBe("dirty");
    expect(result.result.staged.map((entry: any) => entry.path)).toEqual(expect.arrayContaining(["staged.txt", "both.txt"]));
    expect(result.result.unstaged.map((entry: any) => entry.path)).toEqual(expect.arrayContaining(["both.txt", "unstaged.txt"]));
    expect(result.result.untracked).toContain("new.txt");
  });

  it("classifies staged renames and staged/unstaged deletions", async () => {
    const { root, context } = await makeRepo({ "old-name.txt": "rename me\n", "delete-staged.txt": "staged deletion\n", "delete-worktree.txt": "worktree deletion\n" });
    await git(root, ["mv", "old-name.txt", "new-name.txt"]);
    await unlink(join(root, "delete-worktree.txt"));
    await git(root, ["rm", "--", "delete-staged.txt"]);
    const status = await call(context, "git_status");
    expect(status.ok).toBe(true);
    expect(status.result.staged).toContainEqual(expect.objectContaining({ path: "new-name.txt", status: "R", other_path: "old-name.txt" }));
    expect(status.result.staged).toContainEqual(expect.objectContaining({ path: "delete-staged.txt", status: "D" }));
    expect(status.result.unstaged).toContainEqual(expect.objectContaining({ path: "delete-worktree.txt", status: "D" }));
  });

  it("reports sensitive names in staged and unstaged status without returning their contents", async () => {
    const { root, context } = await makeRepo({ ".env": "base env\n", "secrets.prod": "base secret\n" });
    await writeFile(join(root, ".env"), "unstaged sensitive change\n");
    await writeFile(join(root, "secrets.prod"), "staged sensitive change\n");
    await git(root, ["add", "--", "secrets.prod"]);
    const status = await call(context, "git_status");
    expect(status.ok).toBe(true);
    expect(status.result.unstaged).toContainEqual(expect.objectContaining({ path: ".env", status: "M" }));
    expect(status.result.staged).toContainEqual(expect.objectContaining({ path: "secrets.prod", status: "M" }));
    const unstagedDiff = await call(context, "git_diff");
    const stagedDiff = await call(context, "git_diff_staged");
    expect(unstagedDiff.result.diff).not.toContain("unstaged sensitive change");
    expect(stagedDiff.result.diff).not.toContain("staged sensitive change");
    expect(unstagedDiff.result.truncated).toBe(true);
    expect(stagedDiff.result.truncated).toBe(true);
  });

  it("classifies conflicted paths in both index and worktree status", async () => {
    const { root, context } = await makeRepo({ "conflict.txt": "base\n" });
    await git(root, ["checkout", "-b", "topic"]);
    await writeFile(join(root, "conflict.txt"), "topic change\n");
    await git(root, ["add", "--", "conflict.txt"]);
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "topic change"]);
    await git(root, ["checkout", "main"]);
    await writeFile(join(root, "conflict.txt"), "main change\n");
    await git(root, ["add", "--", "conflict.txt"]);
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "main change"]);
    await expect(git(root, ["merge", "topic"])).rejects.toThrow("fixture git failed");
    const status = await call(context, "git_status");
    expect(status.ok).toBe(true);
    expect(status.result.staged).toContainEqual(expect.objectContaining({ path: "conflict.txt", status: "U" }));
    expect(status.result.unstaged).toContainEqual(expect.objectContaining({ path: "conflict.txt", status: "U" }));
  });

  it("parses unusual status filenames without splitting NUL-delimited records", async () => {
    const { root, context } = await makeRepo();
    const names = ["space name.txt", "tab\tname.txt", 'quote"name.txt', "line\nbreak.txt"];
    for (const [index, name] of names.entries()) await writeFile(join(root, name), `before-${index}\n`);
    await git(root, ["add", "--all"]);
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unusual names"]);
    for (const [index, name] of names.entries()) await writeFile(join(root, name), `after-${index}\n`);
    const untracked = "untracked\twith\ncontrols.txt";
    await writeFile(join(root, untracked), "new\n");
    const status = await call(context, "git_status");
    expect(status.ok).toBe(true);
    expect(status.result.state).toBe("dirty");
    expect(status.result.unstaged.map((entry: any) => entry.path)).toEqual(expect.arrayContaining(names));
    expect(status.result.untracked).toContain(untracked);
  });

  it("returns distinct unstaged and staged diffs", async () => {
    const { root, context } = await makeRepo({ "both.txt": "base\n" });
    await writeFile(join(root, "both.txt"), "index version\n");
    await git(root, ["add", "--", "both.txt"]);
    await writeFile(join(root, "both.txt"), "worktree version\n");

    const staged = await call(context, "git_diff_staged", { path: "both.txt" });
    const unstaged = await call(context, "git_diff", { path: "both.txt" });
    expect(staged.ok).toBe(true);
    expect(staged.result.diff).toContain("index version");
    expect(staged.result.diff).not.toContain("worktree version");
    expect(unstaged.ok).toBe(true);
    expect(unstaged.result.diff).toContain("+worktree version");
    expect(unstaged.result.diff).toContain("-index version");
    expect(unstaged.result.diff).not.toContain("+index version");
    expect(staged.result).toMatchObject({ path: "both.txt", truncated: false });
  });

  it("filters sensitive paths from unfiltered diffs and treats scoped pathspec syntax literally", async () => {
    const { root, context } = await makeRepo({
      ".env": "secret before\n",
      "public.txt": "public before\n",
      ":(glob)**": "glob before\n",
    });
    await writeFile(join(root, ".env"), "VERY_SECRET_AFTER\n");
    await writeFile(join(root, "public.txt"), "public after\n");
    await writeFile(join(root, ":(glob)**"), "glob after\n");

    const unfiltered = await call(context, "git_diff");
    expect(unfiltered.ok).toBe(true);
    expect(unfiltered.result.diff).toContain("public after");
    expect(unfiltered.result.diff).not.toContain("VERY_SECRET_AFTER");
    await git(root, ["add", "--", ".env", "public.txt"]);
    const stagedUnfiltered = await call(context, "git_diff_staged");
    expect(stagedUnfiltered.ok).toBe(true);
    expect(stagedUnfiltered.result.diff).not.toContain("VERY_SECRET_AFTER");
    const literal = await call(context, "git_diff", { path: ":(glob)**" });
    expect(literal.ok).toBe(true);
    expect(literal.result.diff).toContain("glob after");
    expect(literal.result.diff).not.toContain("public after");
    await git(root, ["add", "--", ":(glob)**"]);
    const stagedLiteral = await call(context, "git_diff_staged", { path: ":(glob)**" });
    expect(stagedLiteral.ok).toBe(true);
    expect(stagedLiteral.result.diff).toContain("glob after");
    expect(stagedLiteral.result.diff).not.toContain("public after");
    const sensitive = await call(context, "git_diff", { path: ".env" });
    expect(sensitive.ok).toBe(false);
    expect((await call(context, "git_diff_staged", { path: ".env" })).ok).toBe(false);
  });

  it("never returns sensitive content from staged or unstaged sensitive-file renames", async () => {
    const secret = "SENSITIVE_RENAME_CONTENT_9a81";
    const { root, context } = await makeRepo({ ".env": `${secret}\n` });
    await rename(join(root, ".env"), join(root, "public.txt"));

    const unstagedAll = await call(context, "git_diff");
    expect(unstagedAll.ok).toBe(true);
    expect(unstagedAll.result.diff).not.toContain(secret);
    const unstagedDestination = await call(context, "git_diff", { path: "public.txt" });
    expect(unstagedDestination.ok).toBe(false);
    expect(JSON.stringify(unstagedDestination)).not.toContain(secret);

    await git(root, ["add", "--all"]);
    const stagedAll = await call(context, "git_diff_staged");
    expect(stagedAll.ok).toBe(true);
    expect(stagedAll.result.diff).not.toContain(secret);
    const stagedDestination = await call(context, "git_diff_staged", { path: "public.txt" });
    expect(stagedDestination.ok).toBe(false);
    expect(JSON.stringify(stagedDestination)).not.toContain(secret);

    // The staged rename's old blob must not leak through a later unstaged edit at the destination.
    await writeFile(join(root, "public.txt"), `${secret}\nadditional worktree edit\n`);
    const afterRenameEdit = await call(context, "git_diff", { path: "public.txt" });
    expect(afterRenameEdit.ok).toBe(false);
    expect(JSON.stringify(afterRenameEdit)).not.toContain(secret);
  });

  it.each(["credentials.json", "secrets.production", "private.pem", ".aws", "id_rsa", "id_ed25519"]) (
    "omits sensitive rename counterpart content for protected pattern %s",
    async (source) => {
      const secret = `SECRET_FROM_${source}`;
      const { root, context } = await makeRepo({ [source]: `${secret}\n` });
      const destination = `renamed-${source.replaceAll(/[^a-z0-9]/gi, "-")}.txt`;
      await git(root, ["mv", source, destination]);
      const all = await call(context, "git_diff_staged");
      const explicit = await call(context, "git_diff_staged", { path: destination });
      expect(all.ok).toBe(true);
      expect(all.result.diff).not.toContain(secret);
      expect(explicit.ok).toBe(false);
      expect(JSON.stringify(explicit)).not.toContain(secret);
    },
  );

  it("filters content when sensitive files are deleted", async () => {
    const secret = "SENSITIVE_DELETED_CONTENT_32fe";
    const { root, context } = await makeRepo({ ".env": `${secret}\n`, "private.key": `${secret}-key\n` });
    await unlink(join(root, ".env"));
    const unstaged = await call(context, "git_diff");
    expect(unstaged.ok).toBe(true);
    expect(unstaged.result.diff).not.toContain(secret);
    expect((await call(context, "git_diff", { path: ".env" })).ok).toBe(false);

    await git(root, ["rm", "--", "private.key"]);
    const staged = await call(context, "git_diff_staged");
    expect(staged.ok).toBe(true);
    expect(staged.result.diff).not.toContain(secret);
    expect((await call(context, "git_diff_staged", { path: "private.key" })).ok).toBe(false);
  });

  it("returns structured recent commit data and respects the limit", async () => {
    const { context } = await makeRepo({ "tracked.txt": "one\n" });
    const defaultLog = await call(context, "git_log");
    expect(defaultLog.ok).toBe(true);
    expect(defaultLog.result.commits[0]).toMatchObject({ author: "Git Tool Fixture" });
    expect(defaultLog.result.commits[0].message).toContain("fixture commit");
    expect(defaultLog.result.commits[0].hash).toMatch(/^[a-f0-9]{40,64}$/);
    expect(defaultLog.result.commits[0].date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await call(context, "git_log", { limit: 1 })).result.commits).toHaveLength(1);
  });

  it("returns the full multiline commit message", async () => {
    const { root, context } = await makeRepo();
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "release subject", "-m", "body paragraph one", "-m", "body paragraph two"]);
    const result = await call(context, "git_log", { limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.result.commits[0].message).toContain("release subject");
    expect(result.result.commits[0].message).toContain("body paragraph one");
    expect(result.result.commits[0].message).toContain("body paragraph two");
  });

  it("lists local branches and identifies the current branch, or detached HEAD", async () => {
    const { root, context } = await makeRepo({ "tracked.txt": "x\n" });
    await git(root, ["branch", "feature"]);
    const attached = await call(context, "git_branch");
    expect(attached.ok).toBe(true);
    expect(attached.result.current_branch).toBe("main");
    expect(attached.result.branches).toEqual(expect.arrayContaining([
      { name: "main", current: true },
      { name: "feature", current: false },
    ]));

    await git(root, ["checkout", "--detach", "HEAD"]);
    const detached = await call(context, "git_branch");
    expect(detached.result.current_branch).toBeNull();
    expect(detached.result.detached).toBe(true);
    expect(detached.result.branches.every((branch: { current: boolean }) => !branch.current)).toBe(true);
    expect((await call(context, "git_status")).result).toMatchObject({ current_branch: null, detached: true });
  });

  it("handles an empty repository and a non-Git workspace", async () => {
    const root = await temp();
    await git(root, ["init", "-q", "-b", "main"]);
    const workspace = await Workspace.create(root);
    const emptyContext: ToolContext = { workspace, gitService: await GitService.create(workspace) };
    expect((await call(emptyContext, "git_status")).result).toMatchObject({ state: "clean", current_branch: "main" });
    expect((await call(emptyContext, "git_log")).result.commits).toEqual([]);
    expect((await call(emptyContext, "git_branch")).result).toMatchObject({ current_branch: "main", branches: [] });

    const plain = await temp();
    const plainWorkspace = await Workspace.create(plain);
    const noRepo: ToolContext = { workspace: plainWorkspace, gitService: null };
    expect((await call(noRepo, "git_status")).result).toMatchObject({ is_repository: false, state: "not_repository" });
    expect((await call(noRepo, "git_branch")).result.is_repository).toBe(false);
    expect((await call(noRepo, "git_diff")).ok).toBe(false);
  });

  it("enforces strict argument schemas and reports bounded output truncation", async () => {
    const { root, workspace } = await makeRepo({ "large.txt": "before\n" });
    await writeFile(join(root, "large.txt"), `after\n${"x".repeat(2_000)}\n`);
    const gitService = await GitService.create(workspace, { maxOutputBytes: 128 });
    const context: ToolContext = { workspace, gitService };
    const truncated = await call(context, "git_diff", { path: "large.txt" });
    expect(truncated.ok).toBe(true);
    expect(truncated.result.truncated).toBe(true);
    expect(truncated.result.bytes_returned).toBeLessThanOrEqual(128);

    expect((await call(context, "git_diff", { extra: true })).ok).toBe(false);
    expect((await call(context, "git_diff", { path: "../escape" })).ok).toBe(false);
    for (const limit of [0, 51, 1.5]) expect((await call(context, "git_log", { limit })).ok).toBe(false);
    expect((await call(context, "git_status", { extra: true })).ok).toBe(false);
  });

  it("reports truncated status as unknown", async () => {
    const { workspace } = await makeRepo({ "tracked.txt": "content\n" });
    const gitService = await GitService.create(workspace, { maxOutputBytes: 7 });
    const result = await call({ workspace, gitService }, "git_status");
    expect(result.ok).toBe(true);
    expect(result.result.state).toBe("unknown");
    expect(result.result.truncated).toBe(true);
  });

  it("reports malformed complete status output as unknown", async () => {
    const { workspace, context } = await makeRepo();
    context.gitService!.runReadOnly = async () => ({ stdout: Buffer.from("not-a-status-record\0", "utf8"), truncated: false });
    const result = await call(context, "git_status");
    expect(result.ok).toBe(true);
    expect(result.result.state).toBe("unknown");
    expect(result.result.parse_error).toBe("Git returned malformed or invalidly encoded status output.");
    expect(result.result.staged).toEqual([]);
  });

  it.runIf(process.platform === "linux")("marks status unknown and withholds diffs for invalid UTF-8 filenames", async () => {
    const root = await temp();
    await git(root, ["init", "-q", "-b", "main"]);
    const invalidPath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]);
    await writeFile(invalidPath, "before\n");
    await writeFile(join(root, "safe.txt"), "safe before\n");
    await git(root, ["add", "--all"]);
    await git(root, ["-c", "user.name=Git Tool Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "invalid byte path"]);
    await writeFile(invalidPath, "INVALID_FILENAME_CONTENT\n");
    await writeFile(join(root, "safe.txt"), "safe after\n");
    const workspace = await Workspace.create(root);
    const gitService = await GitService.create(workspace);
    const context: ToolContext = { workspace, gitService };

    const status = await call(context, "git_status");
    expect(status.ok).toBe(true);
    expect(status.result.state).toBe("unknown");
    expect(status.result.parse_error).toContain("invalidly encoded");
    const diff = await call(context, "git_diff");
    expect(diff.ok).toBe(true);
    expect(diff.result.diff).toBe("");
    expect(diff.result.truncated).toBe(true);
    expect(JSON.stringify(diff)).not.toContain("INVALID_FILENAME_CONTENT");
    await expect(call(context, "git_diff", { path: "safe.txt" })).resolves.toMatchObject({ ok: false });
  });

  it("propagates cancellation and returns sanitized Git availability errors", async () => {
    const { workspace, context } = await makeRepo({ "tracked.txt": "x\n" });
    const controller = new AbortController();
    const service = context.gitService!;
    service.runReadOnly = async (_operation, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("Git operation cancelled.");
    };
    await expect(createDefaultToolRegistry().get("git_status")!.execute({}, { ...context, signal: controller.signal }))
      .rejects.toThrow("cancelled");

    const executor = new ToolExecutor(createDefaultToolRegistry());
    const failed = await executor.execute(
      { id: "git-status", name: "git_status", arguments: {} },
      { workspace, gitServiceError: "Git is unavailable." },
    );
    expect(failed.ok).toBe(false);
    expect(JSON.parse(failed.content).error).toBe("Git is unavailable.");
    expect(failed.content).not.toContain(workspace.root);
  });
});
