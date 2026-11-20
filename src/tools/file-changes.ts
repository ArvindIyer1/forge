import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { open, link, lstat, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_READ_BYTES, Workspace } from "./workspace.js";
import { createUnifiedDiff } from "./diff.js";
import type { AppliedFileEvidence } from "./change-attribution.js";

export type ExpectedFileState =
  | { kind: "missing" }
  | {
      kind: "file";
      sha256: string;
      size: number;
      device: number;
      inode: number;
      modifiedAt: number;
      mode: number;
    };

export interface ProposedFileChange {
  operation: "create" | "edit";
  /** Workspace-relative, normalized path safe to display in the terminal. */
  path: string;
  before: string;
  after: string;
  expected: ExpectedFileState;
  diff: string;
}

export async function prepareCreate(
  workspace: Workspace,
  path: string,
  content: string,
): Promise<ProposedFileChange> {
  validateText(content);
  const target = await workspace.resolveNewFileTarget(path);
  return {
    operation: "create",
    path: target.relativePath,
    before: "",
    after: content,
    expected: { kind: "missing" },
    diff: createUnifiedDiff(target.relativePath, "", content),
  };
}

export async function prepareEdit(
  workspace: Workspace,
  path: string,
  oldText: string,
  newText: string,
): Promise<ProposedFileChange> {
  if (!oldText) throw new Error("The text to replace must not be empty.");
  validateText(newText);

  const snapshot = await workspace.readTextSnapshot(path);
  const firstMatch = snapshot.content.indexOf(oldText);
  if (firstMatch === -1) throw new Error("The text to replace was not found in the file.");
  if (snapshot.content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
    throw new Error("The text to replace matches more than once; provide a more specific replacement.");
  }

  const after =
    snapshot.content.slice(0, firstMatch) +
    newText +
    snapshot.content.slice(firstMatch + oldText.length);
  validateText(after);

  const expected: ExpectedFileState = {
    kind: "file",
    sha256: hash(snapshot.content),
    size: snapshot.size,
    device: snapshot.device,
    inode: snapshot.inode,
    modifiedAt: snapshot.modifiedAt,
    mode: snapshot.mode,
  };

  return {
    operation: "edit",
    path: snapshot.relativePath,
    before: snapshot.content,
    after,
    expected,
    diff: createUnifiedDiff(snapshot.relativePath, snapshot.content, after),
  };
}

/** Check whether the prepared destination still has the exact state reviewed. */
export async function isProposalCurrent(
  workspace: Workspace,
  proposal: ProposedFileChange,
): Promise<boolean> {
  if (proposal.expected.kind === "missing") {
    try {
      await workspace.resolveNewFileTarget(proposal.path);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const current = await workspace.readTextSnapshot(proposal.path);
    return (
      hash(current.content) === proposal.expected.sha256 &&
      current.size === proposal.expected.size &&
      current.device === proposal.expected.device &&
      current.inode === proposal.expected.inode &&
      current.modifiedAt === proposal.expected.modifiedAt &&
      current.mode === proposal.expected.mode
    );
  } catch {
    return false;
  }
}

/** Apply a previously prepared proposal after the caller has authorized it. */
export async function applyFileChange(
  workspace: Workspace,
  proposal: ProposedFileChange,
  signal?: AbortSignal,
): Promise<{ path: string; operation: ProposedFileChange["operation"]; bytesWritten: number; evidence: AppliedFileEvidence }> {
  signal?.throwIfAborted();
  const initialTarget = await resolveProposalTarget(workspace, proposal);
  if (!(await isProposalCurrent(workspace, proposal))) {
    throw new Error("The file changed after the proposed diff was prepared. Prepare a new proposal.");
  }

  const temporaryPath = join(dirname(initialTarget.absolutePath), `.forge-${randomUUID()}.tmp`);
  const mode = proposal.expected.kind === "file" ? proposal.expected.mode & 0o777 : 0o600;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(proposal.after, { encoding: "utf8" });
    if (proposal.expected.kind === "file") await handle.chmod(proposal.expected.mode & 0o777);
    await handle.sync();
    const temporaryInfo = await handle.stat();
    await handle.close();
    handle = undefined;

    const currentTarget = await resolveProposalTarget(workspace, proposal);
    if (currentTarget.absolutePath !== initialTarget.absolutePath) {
      throw new Error("The workspace path changed while preparing the file update.");
    }
    if (!(await isProposalCurrent(workspace, proposal))) {
      throw new Error("The file changed after the proposed diff was prepared. Prepare a new proposal.");
    }
    signal?.throwIfAborted();

    if (proposal.expected.kind === "missing") {
      // link() publishes the complete temp file atomically and fails if the target exists.
      await link(temporaryPath, initialTarget.absolutePath);
    } else {
      // Same-directory rename publishes the complete replacement atomically where supported.
      await rename(temporaryPath, initialTarget.absolutePath);
    }

    const expectedHash = hash(proposal.after);
    let evidence: AppliedFileEvidence = {
      sha256: expectedHash,
      size: temporaryInfo.size,
      device: temporaryInfo.dev,
      inode: temporaryInfo.ino,
      modifiedAt: temporaryInfo.mtimeMs,
      mode: temporaryInfo.mode,
      verified: false,
    };
    try {
      const published = await workspace.readTextSnapshot(proposal.path);
      const publishedInfo = await lstat(initialTarget.absolutePath);
      const contentMatches = published.content === proposal.after;
      // Compare the actual target identity with the inode written and atomically published.
      const identityMatches = temporaryInfo.dev !== 0 && temporaryInfo.ino !== 0 &&
        published.device === temporaryInfo.dev && published.inode === temporaryInfo.ino &&
        publishedInfo.dev === temporaryInfo.dev && publishedInfo.ino === temporaryInfo.ino;
      const metadataMatches = published.size === temporaryInfo.size && published.modifiedAt === temporaryInfo.mtimeMs &&
        published.mode === temporaryInfo.mode;
      evidence = {
        sha256: hash(published.content),
        size: published.size,
        device: published.device,
        inode: published.inode,
        modifiedAt: published.modifiedAt,
        mode: published.mode,
        verified: contentMatches && identityMatches && metadataMatches && hash(published.content) === expectedHash,
      };
    } catch {
      // Publication succeeded but final state could not be verified; attribution stays unknown.
    }

    return {
      path: proposal.path,
      operation: proposal.operation,
      bytesWritten: Buffer.byteLength(proposal.after, "utf8"),
      evidence,
    };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function resolveProposalTarget(
  workspace: Workspace,
  proposal: ProposedFileChange,
): Promise<{ relativePath: string; absolutePath: string }> {
  return proposal.expected.kind === "missing"
    ? workspace.resolveNewFileTarget(proposal.path)
    : workspace.resolveExistingFileTarget(proposal.path);
}

function validateText(content: string): void {
  if (content.includes("\0")) throw new Error("Binary file content is not allowed.");
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    throw new Error(`File content exceeds the ${MAX_READ_BYTES}-byte limit.`);
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
