import { createHash, randomUUID } from "node:crypto";
import type { GitService } from "../git/git-service.js";
import { parseGitStatus } from "../git/git-parsers.js";
import type { Workspace, WorkspaceFileSnapshot } from "./workspace.js";
import type { ExpectedFileState } from "./file-changes.js";

export type AttributionClassification = "clean" | "pre_existing" | "forge_applied" | "modified_after_forge" | "unknown";
export type BaselineClassification = "clean" | "pre_existing" | "unknown";

export interface AppliedFileEvidence {
  sha256: string;
  size: number;
  device: number;
  inode: number;
  modifiedAt: number;
  mode: number;
  verified: boolean;
}

export interface AttributionFileRecord {
  path: string;
  classification: AttributionClassification;
  baseline_classification: BaselineClassification;
  operations: Array<"create" | "edit">;
  forge_applied: boolean;
  baseline_fingerprint: string | null;
  resulting_fingerprint: string | null;
}

export interface AttributionReport {
  task_id: string;
  baseline_complete: boolean;
  files: AttributionFileRecord[];
}

interface BaselineFile {
  classification: BaselineClassification;
  fingerprint: string | null;
  snapshot?: WorkspaceFileSnapshot;
}

interface AppliedRecord {
  operation: "create" | "edit";
  evidence: AppliedFileEvidence;
  baselineMatch: boolean;
}

/** In-memory, single-task attribution. Git state establishes only what predated the task;
 * successful atomic publication and later filesystem identity checks establish FORGE attribution. */
export class ChangeAttributionTracker {
  readonly taskId = randomUUID();
  private baselineComplete = false;
  private baseline = new Map<string, BaselineFile>();
  private preExistingPaths = new Set<string>();
  private unknownPaths = new Set<string>();
  private records = new Map<string, AppliedRecord[]>();

  private constructor(private readonly workspace: Workspace, private readonly gitService?: GitService | null) {}

  static async capture(workspace: Workspace, gitService?: GitService | null, signal?: AbortSignal): Promise<ChangeAttributionTracker> {
    const tracker = new ChangeAttributionTracker(workspace, gitService);
    await tracker.captureBaseline(gitService, signal);
    return tracker;
  }

  recordApplied(path: string, operation: "create" | "edit", evidence: AppliedFileEvidence, expected: ExpectedFileState): void {
    const records = this.records.get(path) ?? [];
    const previous = records.at(-1);
    const baselineMatch = previous
      ? previous.baselineMatch && previous.evidence.verified && expectedMatchesEvidence(expected, previous.evidence)
      : this.expectedMatchesBaseline(path, expected);
    records.push({ operation, evidence: { ...evidence }, baselineMatch });
    this.records.set(path, records);
  }

  async report(path?: string): Promise<AttributionReport> {
    const currentPaths = await this.currentChangedPaths();
    const paths = path ? [path] : [...new Set([
      ...this.preExistingPaths, ...this.unknownPaths, ...this.records.keys(), ...currentPaths,
    ])].sort();
    const files: AttributionFileRecord[] = [];
    for (const relativePath of paths) {
      const baseline = this.baselineFor(relativePath);
      const records = this.records.get(relativePath) ?? [];
      const latest = records.at(-1);
      let classification: AttributionClassification;
      if (!latest) {
        if (baseline.classification === "pre_existing") {
          classification = baseline.snapshot && !(await this.matchesBaselineState(relativePath, baseline.snapshot))
            ? "unknown"
            : "pre_existing";
        }
        else if (baseline.classification === "clean" && baseline.snapshot) {
          classification = currentPaths.has(relativePath) || !(await this.matchesBaselineState(relativePath, baseline.snapshot))
            ? "unknown"
            : "clean";
        } else classification = "unknown";
      } else if (!latest.evidence.verified || !latest.baselineMatch || baseline.classification === "unknown") {
        classification = "unknown";
      } else {
        const currentMatches = await this.matchesCurrentState(relativePath, latest.evidence);
        if (currentMatches === "unknown") classification = "unknown";
        else if (!currentMatches) classification = "modified_after_forge";
        else classification = baseline.classification === "pre_existing" ? "pre_existing" : "forge_applied";
      }
      if (!path && classification === "clean") continue;
      files.push({
        path: relativePath,
        classification,
        baseline_classification: baseline.classification,
        operations: records.map((record) => record.operation),
        forge_applied: records.length > 0,
        baseline_fingerprint: baseline.fingerprint,
        resulting_fingerprint: latest?.evidence.sha256 ?? null,
      });
    }
    return { task_id: this.taskId, baseline_complete: this.baselineComplete, files };
  }

  private baselineFor(path: string): BaselineFile {
    const recorded = this.baseline.get(path);
    if (recorded) return recorded;
    const ignoredParent = path.split("/").slice(0, -1).some((segment) =>
      ["node_modules", "dist", "coverage", ".git"].includes(segment.toLowerCase()));
    if (ignoredParent) return { classification: "unknown", fingerprint: null };
    // Absence is meaningful only when both Git status and the workspace inventory
    // completed at task start.
    return { classification: this.baselineComplete ? "clean" : "unknown", fingerprint: null };
  }

  private expectedMatchesBaseline(path: string, expected: ExpectedFileState): boolean {
    const baseline = this.baselineFor(path);
    if (expected.kind === "missing") return baseline.classification === "clean" && !baseline.snapshot;
    const snapshot = baseline.snapshot;
    return Boolean(snapshot && baseline.fingerprint === expected.sha256 && snapshot.size === expected.size &&
      snapshot.device === expected.device && snapshot.inode === expected.inode && snapshot.modifiedAt === expected.modifiedAt &&
      snapshot.mode === expected.mode);
  }

  private async captureBaseline(gitService?: GitService | null, signal?: AbortSignal): Promise<void> {
    let listed: { files: string[]; truncated: boolean } | undefined;
    let changedPaths = new Set<string>();
    try {
      if (!gitService) throw new Error("Git status unavailable");
      signal?.throwIfAborted();
      const before = parseGitStatus(await gitService.runReadOnly("status", { signal }));
      signal?.throwIfAborted();
      listed = await this.workspace.listFiles(".", true);
      const snapshots = await Promise.all(listed.files.map(async (path) => {
        signal?.throwIfAborted();
        try { return { path, snapshot: await this.workspace.readTextSnapshot(path) }; }
        catch { return { path, snapshot: undefined }; }
      }));
      signal?.throwIfAborted();
      const after = parseGitStatus(await gitService.runReadOnly("status", { signal }));
      const stableStatus = before.valid && !before.truncated && after.valid && !after.truncated &&
        JSON.stringify(statusSignature(before)) === JSON.stringify(statusSignature(after));
      if (!stableStatus) {
        for (const { path, snapshot } of snapshots) this.baseline.set(path, {
          classification: "unknown", fingerprint: snapshot ? fingerprint(snapshot.content) : null, ...(snapshot ? { snapshot } : {}),
        });
        for (const { path } of snapshots) this.unknownPaths.add(path);
        this.baselineComplete = false;
        return;
      }
      changedPaths = statusChangedPaths(after);
      for (const changedPath of changedPaths) {
        this.preExistingPaths.add(changedPath);
        this.baseline.set(changedPath, { classification: "pre_existing", fingerprint: null });
      }
      for (const { path, snapshot } of snapshots) {
        const classification = changedPaths.has(path) ? "pre_existing" : snapshot ? "clean" : "unknown";
        this.baseline.set(path, {
          classification,
          fingerprint: snapshot ? fingerprint(snapshot.content) : null,
          ...(snapshot ? { snapshot } : {}),
        });
        if (classification === "pre_existing") this.preExistingPaths.add(path);
        if (classification === "unknown") this.unknownPaths.add(path);
      }
      this.baselineComplete = !listed.truncated && snapshots.every(({ snapshot }) => Boolean(snapshot));
    } catch {
      if (signal?.aborted) throw signal.reason ?? new Error("Task cancelled.");
      try { listed ??= await this.workspace.listFiles(".", true); }
      catch { /* Inventory itself may be unavailable; explicit queries remain unknown. */ }
      if (listed) {
        await Promise.all(listed.files.map(async (path) => {
          let snapshot: WorkspaceFileSnapshot | undefined;
          try { snapshot = await this.workspace.readTextSnapshot(path); } catch { /* retain unknown */ }
          this.baseline.set(path, {
            classification: "unknown", fingerprint: snapshot ? fingerprint(snapshot.content) : null, ...(snapshot ? { snapshot } : {}),
          });
          this.unknownPaths.add(path);
        }));
      }
      this.baselineComplete = false;
    }
  }

  private async matchesCurrentState(path: string, evidence: AppliedFileEvidence): Promise<boolean | "unknown"> {
    try {
      const snapshot = await this.workspace.readTextSnapshot(path);
      return snapshot.size === evidence.size && snapshot.device === evidence.device && snapshot.inode === evidence.inode &&
        snapshot.modifiedAt === evidence.modifiedAt && snapshot.mode === evidence.mode &&
        fingerprint(snapshot.content) === evidence.sha256;
    } catch (error) {
      if (isMissing(error)) return false;
      return "unknown";
    }
  }

  private async matchesBaselineState(path: string, baseline: WorkspaceFileSnapshot): Promise<boolean> {
    try {
      const current = await this.workspace.readTextSnapshot(path);
      return current.size === baseline.size && current.device === baseline.device && current.inode === baseline.inode &&
        current.modifiedAt === baseline.modifiedAt && current.mode === baseline.mode &&
        fingerprint(current.content) === fingerprint(baseline.content);
    } catch {
      return false;
    }
  }

  private async currentChangedPaths(): Promise<Set<string>> {
    if (!this.gitService) return new Set();
    try {
      const status = parseGitStatus(await this.gitService.runReadOnly("status"));
      if (!status.valid || status.truncated) return new Set();
      return statusChangedPaths(status);
    } catch {
      return new Set();
    }
  }
}

function statusSignature(status: ReturnType<typeof parseGitStatus>): unknown {
  return {
    current_branch: status.current_branch, upstream: status.upstream, detached: status.detached, unborn: status.unborn,
    staged: status.staged, unstaged: status.unstaged, untracked: status.untracked,
  };
}

function statusChangedPaths(status: ReturnType<typeof parseGitStatus>): Set<string> {
  const paths = new Set<string>(status.untracked);
  for (const entry of [...status.staged, ...status.unstaged]) {
    paths.add(entry.path);
    if (entry.other_path) paths.add(entry.other_path);
  }
  return paths;
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function expectedMatchesEvidence(expected: ExpectedFileState, evidence: AppliedFileEvidence): boolean {
  return expected.kind === "file" && expected.sha256 === evidence.sha256 && expected.size === evidence.size &&
    expected.device === evidence.device && expected.inode === evidence.inode && expected.modifiedAt === evidence.modifiedAt &&
    expected.mode === evidence.mode;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
