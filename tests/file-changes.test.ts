import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnifiedDiff } from "../src/tools/diff.js";
import { isProposalCurrent, prepareCreate, prepareEdit } from "../src/tools/file-changes.js";
import { Workspace } from "../src/tools/workspace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "forge-changes-test-"));
  temporaryRoots.push(root);
  return Workspace.create(root);
}

describe("file change preparation", () => {
  it("creates a unified diff without modifying the workspace", async () => {
    const workspace = await makeWorkspace();
    const proposal = await prepareCreate(workspace, "new.ts", "const answer = 42;\n");

    expect(proposal).toMatchObject({ operation: "create", path: "new.ts", before: "", after: "const answer = 42;\n", expected: { kind: "missing" } });
    expect(proposal.diff).toContain("--- new.ts\toriginal");
    expect(proposal.diff).toContain("+++ new.ts\tproposed");
    expect(proposal.diff).toContain("+const answer = 42;");
    await expect(workspace.resolveExisting("new.ts")).rejects.toThrow();
  });

  it("generates a replacement diff and captures the existing file hash and identity", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "hello.txt"), "before\nkeep this\n");

    const proposal = await prepareEdit(workspace, "hello.txt", "before", "after");

    expect(proposal).toMatchObject({
      operation: "edit",
      path: "hello.txt",
      before: "before\nkeep this\n",
      after: "after\nkeep this\n",
      expected: { kind: "file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: 17 },
    });
    expect(proposal.diff).toContain("-before");
    expect(proposal.diff).toContain("+after");
    expect(proposal.diff).toContain(" keep this");
    expect(await isProposalCurrent(workspace, proposal)).toBe(true);
    expect(await workspace.readTextFile("hello.txt")).toBe("before\nkeep this\n");
  });

  it("rejects replacements that match more than one location", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "repeat.txt"), "same and same");

    await expect(prepareEdit(workspace, "repeat.txt", "same", "changed")).rejects.toThrow("matches more than once");
  });

  it("rejects replacements that do not match and refuses stale edit or create proposals", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace.root, "edit.txt"), "original");
    await expect(prepareEdit(workspace, "edit.txt", "missing", "new")).rejects.toThrow("was not found");

    const edit = await prepareEdit(workspace, "edit.txt", "original", "approved");
    await writeFile(join(workspace.root, "edit.txt"), "changed externally");
    expect(await isProposalCurrent(workspace, edit)).toBe(false);

    const create = await prepareCreate(workspace, "new.txt", "new file");
    await writeFile(join(workspace.root, "new.txt"), "created externally");
    expect(await isProposalCurrent(workspace, create)).toBe(false);
  });

  it("formats a replacement as a unified diff with context", () => {
    const diff = createUnifiedDiff("sample.txt", "one\nold\nthree\n", "one\nnew\nthree\n");

    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain(" one");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
    expect(diff).toContain(" three");
  });
});
