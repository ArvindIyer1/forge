import { afterEach, describe, expect, it } from "vitest";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { GitService } from "../src/git/git-service.js";
import { Workspace } from "../src/tools/workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(prefix = "forge-git-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
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

async function makeRepo(root?: string): Promise<{ root: string; workspace: Workspace; service: GitService }> {
  const repo = root ?? await temp();
  await git(repo, ["init", "-q"]);
  await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  const workspace = await Workspace.create(repo);
  const service = await GitService.create(workspace);
  if (!service) throw new Error("Expected a Git repository.");
  return { root: repo, workspace, service };
}

async function addAndCommit(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture files"]);
}

async function currentGitExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return realpath(candidate);
    } catch { /* keep looking */ }
  }
  throw new Error("Git executable not found for test setup.");
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return (await readFile(path, "utf8")).trim(); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("Timed out waiting for fake Git child PID.");
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} is still running.`);
}

describe("GitService repository discovery and boundaries", () => {
  it("accepts a repository root and directly verifies a linked worktree .git file", async () => {
    const { root, service } = await makeRepo();
    expect(service.root).toBe(await realpath(root));

    const worktree = join(await temp(), "linked");
    await git(root, ["worktree", "add", "-b", "linked", worktree, "HEAD"]);
    const gitMarker = await lstat(join(worktree, ".git"));
    expect(gitMarker.isFile()).toBe(true);
    const worktreeService = await GitService.create(await Workspace.create(worktree));
    expect(worktreeService?.root).toBe(await realpath(worktree));
  });

  it("returns null only for a genuine non-repository and rejects a parent repository outside the workspace", async () => {
    const plain = await temp();
    expect(await GitService.create(await Workspace.create(plain))).toBeNull();

    const parent = await temp();
    await git(parent, ["init", "-q"]);
    const child = join(parent, "workspace");
    await mkdir(child);
    await expect(GitService.create(await Workspace.create(child))).rejects.toThrow("root must match");
  });

  it("surfaces malformed repository configuration instead of classifying it as non-Git", async () => {
    const root = await temp();
    await git(root, ["init", "-q"]);
    await writeFile(join(root, ".git", "config"), "[broken\n");
    await expect(GitService.create(await Workspace.create(root))).rejects.toThrow("Git repository discovery failed");
  });

  it("surfaces an invalid .git marker instead of returning null", async () => {
    const root = await temp();
    await writeFile(join(root, ".git"), "not a git directory\n");
    await expect(GitService.create(await Workspace.create(root))).rejects.toThrow("Git repository discovery failed");
  });

  it("reports a missing Git installation without leaking executable lookup details", async () => {
    const plain = await temp();
    const originalPath = process.env.PATH;
    process.env.PATH = join(plain, "no-bin");
    try {
      await expect(GitService.create(await Workspace.create(plain))).rejects.toThrow("Git is unavailable");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not resolve Git from workspace content, including a workspace symlink", async () => {
    const { root, workspace } = await makeRepo();
    const externalBin = await temp("forge-git-shadow-");
    const shadow = join(externalBin, "git");
    await writeFile(shadow, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await symlink(shadow, join(root, "git"));
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
    try {
      const service = await GitService.create(workspace);
      expect(service?.root).toBe(await realpath(root));
      expect((await service!.runReadOnly("status")).truncated).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects nested repositories consistently, including unfiltered status", async () => {
    const outer = await temp();
    await git(outer, ["init", "-q"]);
    const nested = join(outer, "nested");
    await mkdir(nested);
    await git(nested, ["init", "-q"]);
    const outerService = await GitService.create(await Workspace.create(outer));
    expect(outerService?.root).toBe(await realpath(outer));
    await expect(outerService!.runReadOnly("status")).rejects.toThrow("Nested Git repositories");
    await expect(outerService!.runReadOnly("diff")).rejects.toThrow("Nested Git repositories");
    await expect(outerService!.validatePath("nested/file.txt")).rejects.toThrow("Nested Git repositories");
    expect((await GitService.create(await Workspace.create(nested)))?.root).toBe(await realpath(nested));
  });
});

describe("GitService read-only invocation and path validation", () => {
  it("rejects traversal, sensitive paths, symlink files, and symlinked parents while allowing deleted paths", async () => {
    const { root, service } = await makeRepo();
    const outside = await temp("forge-git-outside-");
    await writeFile(join(outside, "file.txt"), "outside");
    await writeFile(join(root, "ordinary.txt"), "x");
    await symlink(join(root, "ordinary.txt"), join(root, "alias.txt"));
    await symlink(outside, join(root, "alias-dir"));
    await expect(service.validatePath("../escape")).rejects.toThrow();
    await expect(service.validatePath("/tmp/escape")).rejects.toThrow();
    await expect(service.validatePath(".env.local")).rejects.toThrow();
    await expect(service.validatePath("alias.txt")).rejects.toThrow("Symbolic links");
    await expect(service.validatePath("alias-dir/file.txt")).rejects.toThrow("Symbolic links");
    await expect(service.validatePath("deleted.txt")).resolves.toBe("deleted.txt");
  });

  it("treats Git pathspec magic and wildcard characters as literal filenames", async () => {
    const { root, service } = await makeRepo();
    await addAndCommit(root, {
      ".env": "secret-before\n",
      "public.txt": "public-before\n",
      ":(glob)**": "glob-before\n",
      ":(top)some/path": "top-before\n",
      "wild*.txt": "wild-before\n",
    });
    await writeFile(join(root, ".env"), "VERY_SECRET_AFTER\n");
    await writeFile(join(root, "public.txt"), "public-after\n");
    await writeFile(join(root, ":(glob)**"), "glob-after\n");
    await writeFile(join(root, ":(top)some/path"), "top-after\n");
    await writeFile(join(root, "wild*.txt"), "wild-after\n");

    const literalGlob = (await service.runReadOnly("diff", { path: ":(glob)**" })).stdout.toString();
    expect(literalGlob).toContain("glob-after");
    expect(literalGlob).not.toContain("VERY_SECRET_AFTER");
    expect(literalGlob).not.toContain("public-after");
    const literalTop = (await service.runReadOnly("diff", { path: ":(top)some/path" })).stdout.toString();
    expect(literalTop).toContain("top-after");
    expect(literalTop).not.toContain("VERY_SECRET_AFTER");
    const literalWildcard = (await service.runReadOnly("diff", { path: "wild*.txt" })).stdout.toString();
    expect(literalWildcard).toContain("wild-after");
    expect(literalWildcard).not.toContain("public-after");
    const selectedFile = (await service.runReadOnly("diff", { path: "public.txt" })).stdout.toString();
    expect(selectedFile).toContain("public-after");
    expect(selectedFile).not.toContain("VERY_SECRET_AFTER");
    await git(root, ["add", "--", ":(glob)**", ".env", "public.txt"]);
    const stagedLiteral = (await service.runReadOnly("diff_staged", { path: ":(glob)**" })).stdout.toString();
    expect(stagedLiteral).toContain("glob-after");
    expect(stagedLiteral).not.toContain("VERY_SECRET_AFTER");
    await expect(service.runReadOnly("diff", { path: ".env" })).rejects.toThrow("blocked");
  });

  it("handles spaces, tabs, quotes, newlines, and leading-dash filenames literally", async () => {
    const { root, service } = await makeRepo();
    const filenames = ["space name.txt", "tab\tname.txt", 'quote"name.txt', "line\nbreak.txt", "-leading.txt"];
    const before: Record<string, string> = {};
    for (const [index, name] of filenames.entries()) before[name] = `before-${index}\n`;
    await addAndCommit(root, before);
    for (const [index, name] of filenames.entries()) await writeFile(join(root, name), `after-${index}\n`);
    for (const [index, name] of filenames.entries()) {
      const result = (await service.runReadOnly("diff", { path: name })).stdout.toString();
      expect(result).toContain(`after-${index}`);
      for (const otherIndex of filenames.keys()) if (otherIndex !== index) expect(result).not.toContain(`after-${otherIndex}`);
    }
  });

  it("keeps option-looking names behind the terminator and bounds log limits", async () => {
    const { service } = await makeRepo();
    await expect(service.runReadOnly("diff", { path: "--help" })).resolves.toBeDefined();
    await expect(service.runReadOnly("log", { limit: 51 })).rejects.toThrow("between 1 and 50");
  });
});

describe("GitService process lifecycle", () => {
  async function createFakeGit(options: { outputOverflow?: boolean; ignoreTerm?: boolean; stderrFlood?: boolean; dumpEnvironment?: boolean } = {}) {
    const { root, workspace } = await makeRepo();
    const realGit = await currentGitExecutable();
    const fakeBin = await temp("forge-fake-git-");
    const pidFile = join(fakeBin, "child.pid");
    const ignoreTerm = options.ignoreTerm ? "trap '' TERM\n" : "";
    const body = options.outputOverflow
      ? "i=0\nwhile [ $i -lt 2000 ]; do printf '%0100d' $i; i=$((i+1)); done\n"
      : "";
    const mode = options.stderrFlood
      ? "i=0\nwhile [ $i -lt 2000 ]; do printf '%0100d' $i >&2; i=$((i+1)); done\nexit 1\n"
      : options.dumpEnvironment
        ? `/usr/bin/env > '${join(fakeBin, "environment.txt")}'\n`
        : "";
    const script = `#!/bin/sh\nif [ \"$1\" = \"rev-parse\" ]; then exec '${realGit}' \"$@\"; fi\n${ignoreTerm}${mode}${options.stderrFlood || options.dumpEnvironment ? "" : `/bin/sleep 30 &\necho $! > '${pidFile}'\n${body}wait\n`}`;
    const fakeExecutable = join(fakeBin, "git");
    await writeFile(fakeExecutable, script, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
    try {
      const discoveredService = await GitService.create(workspace, { timeoutMs: 2_000, maxOutputBytes: options.outputOverflow ? 1024 : 1024 * 1024 });
      if (!discoveredService) throw new Error("Expected fake Git discovery to delegate to the real Git repository.");
      const service = Object.create(discoveredService) as GitService;
      Object.defineProperty(service, "options", {
        value: { timeoutMs: 120, maxOutputBytes: options.outputOverflow ? 1024 : 1024 * 1024, gitExecutable: fakeExecutable },
      });
      return { service, pidFile, originalPath, fakeBin };
    } catch (error) {
      process.env.PATH = originalPath;
      throw error;
    }
  }

  it.runIf(process.platform !== "win32")("pins Git executable resolution and terminates subprocess trees after timeout", async () => {
    const { service, pidFile, originalPath } = await createFakeGit({ ignoreTerm: true });
    process.env.PATH = originalPath;
    try {
      const pending = service.runReadOnly("status");
      const pid = Number(await waitForFile(pidFile));
      await expect(pending).rejects.toThrow("timed out");
      await expectProcessGone(pid);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it.runIf(process.platform !== "win32")("terminates subprocess trees after cancellation and stdout overflow", async () => {
    const cancellation = await createFakeGit({ ignoreTerm: true });
    process.env.PATH = cancellation.originalPath;
    try {
      const controller = new AbortController();
      const pending = cancellation.service.runReadOnly("status", { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("cancelled");
      const pid = Number(await waitForFile(cancellation.pidFile));
      controller.abort();
      await rejected;
      await expectProcessGone(pid);
    } finally {
      process.env.PATH = cancellation.originalPath;
    }

    const overflow = await createFakeGit({ outputOverflow: true });
    process.env.PATH = overflow.originalPath;
    try {
      const pending = overflow.service.runReadOnly("status");
      const completed = await pending;
      const pid = Number(await waitForFile(overflow.pidFile));
      expect(completed.truncated).toBe(true);
      expect(completed.stdout.length).toBeLessThanOrEqual(1024);
      await expectProcessGone(pid);
    } finally {
      process.env.PATH = overflow.originalPath;
    }
  });

  it("keeps child environment minimal and drains excessive stderr without unbounded capture", async () => {
    const dumped = await createFakeGit({ dumpEnvironment: true });
    process.env.PATH = dumped.originalPath;
    try {
      await dumped.service.runReadOnly("status");
      const environment = await readFile(join(dumped.fakeBin, "environment.txt"), "utf8");
      expect(environment).not.toMatch(/^PATH=/m);
      expect(environment).not.toMatch(/^HOME=/m);
      expect(environment).not.toMatch(/^AWS_/m);
      expect(environment).toContain("GIT_TERMINAL_PROMPT=0");
    } finally {
      process.env.PATH = dumped.originalPath;
    }

    const flood = await createFakeGit({ stderrFlood: true });
    process.env.PATH = flood.originalPath;
    try {
      await expect(flood.service.runReadOnly("status")).rejects.toThrow("Git command failed");
    } finally {
      process.env.PATH = flood.originalPath;
    }
  });
});
