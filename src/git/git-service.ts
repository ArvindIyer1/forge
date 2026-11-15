import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSensitivePath as isWorkspaceSensitivePath } from "../tools/workspace.js";
import type { Workspace } from "../tools/workspace.js";
import { parseGitStatus } from "./git-parsers.js";

export const GIT_TIMEOUT_MS = 5_000;
export const GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const STDERR_MAX_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const MAX_BOUNDARY_SCAN_ENTRIES = 20_000;
const MAX_BOUNDARY_SCAN_DEPTH = 64;
const MAX_DIFF_PATHS = 1_000;
const MAX_DIFF_PATH_ARGUMENT_BYTES = 128 * 1024;

export interface GitServiceOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitCommandResult {
  stdout: Buffer;
  truncated: boolean;
}

interface InternalOptions extends Required<GitServiceOptions> {
  gitExecutable: string;
}

export type GitReadOperation = "status" | "diff" | "diff_staged" | "log" | "branches";

/** Executes only fixed, read-only Git operations within the configured workspace repository. */
export class GitService {
  private constructor(
    private readonly repositoryRoot: string,
    private readonly options: InternalOptions,
  ) {}

  static async create(workspace: Workspace, options: GitServiceOptions = {}): Promise<GitService | null> {
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new Error("Git service limits must be positive whole numbers.");
    }

    const workspaceRoot = await realpath(workspace.root);
    const workspaceInfo = await stat(workspaceRoot);
    if (!workspaceInfo.isDirectory()) throw new Error("The configured workspace is not a directory.");
    const defaults: InternalOptions = {
      timeoutMs,
      maxOutputBytes,
      gitExecutable: await resolveGitExecutable(workspaceRoot),
    };

    let discovery: ProcessResult;
    try {
      discovery = await runProcess(
        { ...defaults, maxOutputBytes: Math.max(defaults.maxOutputBytes, STDERR_MAX_BYTES) },
        workspaceRoot,
        ["rev-parse", "--show-toplevel"],
      );
    } catch (error) {
      if (error instanceof GitProcessError && isNotRepositoryFailure(error.stderr)) {
        if (!(await hasGitMarker(workspaceRoot))) return null;
      }
      throw sanitizeDiscoveryError(error);
    }
    const discovered = decodeUtf8(discovery.stdout).trim();
    if (!discovered || discovery.truncated) throw new Error("Unable to identify the workspace Git repository.");

    let canonicalRepository: string;
    try {
      canonicalRepository = await realpath(discovered);
      const info = await stat(canonicalRepository);
      if (!info.isDirectory()) throw new Error();
    } catch {
      throw new Error("Unable to validate the workspace Git repository.");
    }
    if (!isInside(workspaceRoot, canonicalRepository) || canonicalRepository !== workspaceRoot) {
      throw new Error("Git repository root must match the configured workspace root.");
    }
    return new GitService(canonicalRepository, defaults);
  }

  get root(): string {
    return this.repositoryRoot;
  }

  async runReadOnly(
    operation: GitReadOperation,
    options: { path?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<GitCommandResult> {
    if (operation === "diff" || operation === "diff_staged") return this.runSafeDiff(operation, options.path, options.signal);
    const path = options.path === undefined ? undefined : await this.validatePath(options.path);
    if (options.path === undefined) await this.assertNoNestedRepositories();
    const args = buildArgs(operation, { ...options, path });
    const result = await runProcess(this.options, this.repositoryRoot, args, options.signal);
    return { stdout: result.stdout, truncated: result.truncated };
  }

  private async runSafeDiff(
    operation: "diff" | "diff_staged",
    requestedPath: string | undefined,
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    await this.assertNoNestedRepositories();
    signal?.throwIfAborted();
    const rawStatus = await runProcess(this.options, this.repositoryRoot, buildArgs("status", {}), signal);
    const status = parseGitStatus(rawStatus);
    // A partial or undecodable status cannot establish safe rename counterparts. Fail closed.
    if (!status.valid || status.truncated) {
      if (requestedPath !== undefined) throw new Error("Unable to verify repository paths; diff was not returned.");
      return { stdout: Buffer.alloc(0), truncated: true };
    }

    const entries = operation === "diff" ? status.unstaged : status.staged;
    const sensitiveRenamePaths = new Set<string>();
    for (const entry of entries) {
      if (entry.other_path !== undefined &&
          (isSensitivePath(entry.path) || isSensitivePath(entry.other_path))) {
        sensitiveRenamePaths.add(normalizeGitPath(entry.path));
        sensitiveRenamePaths.add(normalizeGitPath(entry.other_path));
      }
    }
    const sensitiveDeletion = entries.some((entry) => entry.status === "D" && isSensitivePath(entry.path));
    const sensitiveOmitted = entries.some((entry) =>
      isSensitivePath(entry.path) || (entry.other_path !== undefined && isSensitivePath(entry.other_path))) ||
      sensitiveRenamePaths.size > 0;
    const changedCandidates = entries.map((entry) => entry.path);

    if (requestedPath !== undefined) {
      const path = await this.validatePathWithinRoot(requestedPath);
      const normalized = normalizeGitPath(path);
      if (sensitiveRenamePaths.has(normalized) ||
          (sensitiveDeletion && changedCandidates.some((candidate) => normalizeGitPath(candidate) !== normalized))) {
        throw new Error("The requested diff may include a sensitive file change and was not returned.");
      }
      const result = await runProcess(this.options, this.repositoryRoot, buildArgs(operation, { path }), signal);
      return { stdout: result.stdout, truncated: result.truncated };
    }

    if (sensitiveDeletion && changedCandidates.some((candidate) => !isSensitivePath(candidate))) {
      return { stdout: Buffer.alloc(0), truncated: true };
    }
    const candidates = [...new Set(changedCandidates.map(normalizeGitPath))]
      .filter((candidate) => !isSensitivePath(candidate) && !sensitiveRenamePaths.has(candidate));
    const paths: string[] = [];
    let pathBytes = 0;
    let pathsTruncated = false;
    for (const candidate of candidates) {
      if (paths.length >= MAX_DIFF_PATHS || pathBytes + Buffer.byteLength(candidate, "utf8") > MAX_DIFF_PATH_ARGUMENT_BYTES) {
        pathsTruncated = true;
        break;
      }
      try {
        paths.push(await this.validatePathWithinRoot(candidate));
        pathBytes += Buffer.byteLength(candidate, "utf8");
      } catch {
        // Exclude paths that are blocked, inaccessible, symlinked, or outside this repository.
      }
    }
    if (!paths.length) return { stdout: Buffer.alloc(0), truncated: pathsTruncated || sensitiveOmitted };
    const result = await runProcess(this.options, this.repositoryRoot, buildArgs(operation, { paths }), signal);
    return { stdout: result.stdout, truncated: result.truncated || pathsTruncated || sensitiveOmitted };
  }

  async validatePath(input: string): Promise<string> {
    await this.assertNoNestedRepositories();
    return this.validatePathWithinRoot(input);
  }

  private async validatePathWithinRoot(input: string): Promise<string> {
    if (!input || input.includes("\0") || isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
      throw new Error("A safe repository-relative path is required.");
    }
    const normalized = input.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((part) => part === "." || part === ".." || isSensitive(part))) {
      throw new Error("The requested Git path is blocked.");
    }
    const path = segments.join("/");
    const absolute = join(this.repositoryRoot, ...segments);
    const rel = relative(this.repositoryRoot, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("The requested path is outside the workspace.");
    }

    // Check each existing component without following symlinks. Deleted paths remain valid.
    let current = this.repositoryRoot;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("Symbolic links are not allowed for Git paths.");
      } catch (error) {
        if (isFsError(error, "ENOENT")) break;
        throw error;
      }
    }
    return path;
  }

  private async assertNoNestedRepositories(): Promise<void> {
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_BOUNDARY_SCAN_DEPTH || ++visited > MAX_BOUNDARY_SCAN_ENTRIES) {
        throw new Error("Unable to verify repository boundaries within the configured scan limit.");
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") {
          if (directory !== this.repositoryRoot) {
            throw new Error("Nested Git repositories are outside the selected repository boundary.");
          }
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1);
      }
    };
    await walk(this.repositoryRoot, 0);
  }
}

interface ProcessResult extends GitCommandResult {
  stderr: Buffer;
}

class GitProcessError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: Buffer, readonly cause?: unknown) {
    super(message);
  }
}

function buildArgs(operation: GitReadOperation, options: { path?: string; paths?: string[]; limit?: number }): string[] {
  const isolation = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external="];
  switch (operation) {
    case "status": return [...isolation, "--no-pager", "status", "--porcelain=v1", "-z", "--branch", "--renames", "--untracked-files=all"];
    case "diff": return [...isolation, "--literal-pathspecs", "--no-pager", "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--", ...(options.path ? [options.path] : options.paths ?? [])];
    case "diff_staged": return [...isolation, "--literal-pathspecs", "--no-pager", "diff", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv", "--", ...(options.path ? [options.path] : options.paths ?? [])];
    case "log": {
      const limit = options.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Git log limit must be between 1 and 50.");
      return [...isolation, "--no-pager", "log", `-${limit}`, "--format=%H%x00%an%x00%aI%x00%B%x00"];
    }
    case "branches": return [...isolation, "--no-pager", "branch", "--list", "--format=%(HEAD)%00%(refname:short)%00"];
  }
}

function runProcess(
  options: InternalOptions,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(options.gitExecutable, args, {
      cwd,
      shell: false,
      detached,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let terminationError: Error | undefined;
    let terminationStarted = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (terminationError) reject(terminationError);
      else if (truncated) resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), truncated: true });
      else if (code !== 0) reject(new GitProcessError("Git command failed.", code, Buffer.concat(stderrChunks)));
      else resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), truncated: false });
    };
    const signalTree = (force: boolean) => {
      if (process.platform === "win32") {
        if (force && child.pid) {
          const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
          const taskkill = join(systemRoot, "System32", "taskkill.exe");
          const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore", env: safeEnvironment(),
          });
          killer.on("error", () => child.kill("SIGKILL"));
          killer.on("close", () => child.kill("SIGKILL"));
        } else {
          child.kill("SIGTERM");
        }
        return;
      }
      if (child.pid) {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
          return;
        } catch {
          // The process group may already have exited; try the direct child as a fallback.
        }
      }
      child.kill(force ? "SIGKILL" : "SIGTERM");
    };
    const beginTermination = (error?: Error) => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminationError = error;
      signalTree(false);
      escalation = setTimeout(() => signalTree(true), TERMINATION_GRACE_MS);
    };
    const onStdout = (chunk: Buffer) => {
      if (settled || truncated) return;
      const remaining = options.maxOutputBytes - stdoutBytes;
      const keep = chunk.subarray(0, Math.max(0, remaining));
      if (keep.length) stdoutChunks.push(keep);
      stdoutBytes += keep.length;
      if (chunk.length > remaining) {
        truncated = true;
        beginTermination();
      }
    };
    const onStderr = (chunk: Buffer) => {
      const remaining = STDERR_MAX_BYTES - stderrBytes;
      const keep = chunk.subarray(0, Math.max(0, remaining));
      if (keep.length) stderrChunks.push(keep);
      stderrBytes += keep.length;
      // Continue draining after the cap so Git cannot block on a full stderr pipe.
    };
    const onError = (error: Error) => finish(new GitProcessError("Git could not be started.", null, Buffer.concat(stderrChunks), error));
    const onClose = (code: number | null) => finish(undefined, code);
    const onAbort = () => beginTermination(new Error("Git operation cancelled."));

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => beginTermination(new Error("Git operation timed out.")), options.timeoutMs);
    if (signal?.aborted) onAbort();
  });
}

async function resolveGitExecutable(workspaceRoot: string): Promise<string> {
  const searchPath = process.env.PATH ?? "";
  // Relative PATH entries (including ".") would let workspace contents affect lookup.
  const candidates = searchPath.split(delimiter).filter((directory) => directory && isAbsolute(directory));
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of candidates) {
    let canonicalDirectory: string;
    try { canonicalDirectory = await realpath(directory); }
    catch { continue; }
    if (isInside(workspaceRoot, canonicalDirectory)) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `git${extension}`);
      if (isInside(workspaceRoot, candidate)) continue;
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const canonical = await realpath(candidate);
        if ((await stat(canonical)).isFile() && !isInside(workspaceRoot, canonical)) return canonical;
      } catch {
        // Continue searching the fixed executable name in the startup PATH.
      }
    }
  }
  throw new Error("Git is unavailable.");
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
}

function decodeUtf8(buffer: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error("Git returned invalid repository metadata."); }
}

function isNotRepositoryFailure(stderr: Buffer): boolean {
  return /^fatal: not a git repository\b/im.test(stderr.toString("utf8"));
}

async function hasGitMarker(workspaceRoot: string): Promise<boolean> {
  try {
    await lstat(join(workspaceRoot, ".git"));
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false;
    throw new Error("Unable to inspect the workspace Git marker.");
  }
}

function sanitizeDiscoveryError(error: unknown): Error {
  if (!(error instanceof GitProcessError)) {
    if (error instanceof Error && (error.message.includes("timed out") || error.message.includes("cancelled"))) return error;
    return error instanceof Error && error.message === "Git is unavailable."
      ? error
      : new Error("Unable to inspect this Git repository.");
  }
  const stderr = error.stderr.toString("utf8");
  if (/dubious ownership/i.test(stderr)) return new Error("Git rejected this repository because its ownership is not trusted.");
  if (/permission denied|access is denied/i.test(stderr)) return new Error("Git could not access the repository.");
  return new Error(`Git repository discovery failed (exit code ${error.exitCode ?? "unknown"}).`);
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isSensitive(segment: string): boolean {
  return isWorkspaceSensitivePath(segment);
}

function isSensitivePath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some(isSensitive);
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}
