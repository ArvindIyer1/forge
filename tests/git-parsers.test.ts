import { describe, expect, it } from "vitest";
import { parseGitLog, parseGitStatus } from "../src/git/git-parsers.js";

describe("Git output parsers", () => {
  it("rejects malformed complete status records instead of accepting a clean state", () => {
    const parsed = parseGitStatus({ stdout: Buffer.from("not-a-porcelain-record\0", "utf8"), truncated: false });
    expect(parsed.valid).toBe(false);
    expect(parsed.staged).toEqual([]);
    expect(parsed.unstaged).toEqual([]);
    expect(parsed.untracked).toEqual([]);
  });

  it.each(["## ", "## main...", "## main [ahead nope]", "## main\0?? broken\0"]) (
    "rejects malformed complete branch/status output %s",
    (output) => {
      const parsed = parseGitStatus({ stdout: Buffer.from(`${output}\0`, "utf8"), truncated: false });
      expect(parsed.valid).toBe(false);
      expect(parsed.staged).toEqual([]);
      expect(parsed.unstaged).toEqual([]);
      expect(parsed.untracked).toEqual([]);
    },
  );

  it("preserves truncation as an unknown status condition", () => {
    const parsed = parseGitStatus({ stdout: Buffer.from("## main\0 M file", "utf8"), truncated: true });
    expect(parsed.truncated).toBe(true);
  });

  it("rejects a non-truncated stream with an incomplete final record", () => {
    const parsed = parseGitStatus({ stdout: Buffer.from("## main\0 M unfinished", "utf8"), truncated: false });
    expect(parsed.valid).toBe(false);
    expect(parsed.staged).toEqual([]);
    expect(parsed.unstaged).toEqual([]);
  });

  it("rejects invalid UTF-8 status and log output rather than replacing bytes", () => {
    const invalid = Buffer.from([0x23, 0x23, 0x20, 0x6d, 0x61, 0x69, 0x6e, 0x00, 0x20, 0x4d, 0x20, 0xff, 0x00]);
    const status = parseGitStatus({ stdout: invalid, truncated: false });
    expect(status.valid).toBe(false);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(parseGitLog({ stdout: Buffer.from([0xff]), truncated: false })).toEqual({ commits: [], truncated: true });
  });

  it("returns the full multiline commit body", () => {
    const hash = "a".repeat(40);
    const date = "2026-01-02T03:04:05+00:00";
    const output = Buffer.from(`\x1e${hash}\0Author\0${date}\0subject\n\nbody line one\nbody line two\n\x1e`, "utf8");
    const parsed = parseGitLog({ stdout: output, truncated: false });
    expect(parsed.commits).toHaveLength(1);
    expect(parsed.commits[0].message).toContain("subject");
    expect(parsed.commits[0].message).toContain("body line one");
    expect(parsed.commits[0].message).toContain("body line two");
  });
});
