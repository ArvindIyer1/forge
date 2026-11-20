import { describe, expect, it } from "vitest";
import { renderGitToolResult } from "../src/cli/git-renderers.js";
import type { ToolExecutionResult } from "../src/tools/types.js";

function result(name: string, value: unknown): ToolExecutionResult {
  return { callId: "call", name, ok: true, content: JSON.stringify({ ok: true, result: value }) };
}

describe("Git terminal renderers", () => {
  it("renders clean, dirty, unknown, detached, and unborn status clearly", () => {
    const clean = renderGitToolResult(result("git_status", {
      is_repository: true, state: "clean", current_branch: "main", upstream: "origin/main",
      detached: false, unborn: false, staged: [], unstaged: [], untracked: [], truncated: false,
    }))!;
    expect(clean).toContain("Repository: available");
    expect(clean).toContain("Branch: main");
    expect(clean).toContain("Upstream: origin/main");
    expect(clean).toContain("State: clean");

    const dirty = renderGitToolResult(result("git_status", {
      is_repository: true, state: "dirty", current_branch: "main", detached: false, unborn: false,
      staged: [{ path: "staged.txt", status: "M" }],
      unstaged: [{ path: "work.txt", status: "D" }], untracked: ["new.txt"], truncated: false,
    }))!;
    expect(dirty).toContain("Staged (1)");
    expect(dirty).toContain("Unstaged (1)");
    expect(dirty).toContain("Untracked (1)");
    expect(dirty).toContain("State: dirty");

    const unknown = renderGitToolResult(result("git_status", {
      is_repository: true, state: "clean", current_branch: null, detached: false, unborn: false,
      staged: [], unstaged: [], untracked: [], truncated: true,
    }))!;
    expect(unknown).toContain("State: unknown");
    expect(unknown).not.toContain("State: clean");
    expect(unknown).toContain("Status output was truncated");

    expect(renderGitToolResult(result("git_status", {
      is_repository: true, state: "dirty", current_branch: null, detached: true, unborn: false,
      staged: [], unstaged: [], untracked: [], truncated: false,
    }))!).toContain("HEAD: detached");
    expect(renderGitToolResult(result("git_status", {
      is_repository: true, state: "clean", current_branch: "main", detached: false, unborn: true,
      staged: [], unstaged: [], untracked: [], truncated: false,
    }))!).toContain("Branch: main (unborn)");
  });

  it("shows no-change diffs, stage labels, and truncation warnings", () => {
    expect(renderGitToolResult(result("git_diff", { path: null, diff: "", truncated: false }))).toContain("Git diff (unstaged)\n  No changes.");
    expect(renderGitToolResult(result("git_diff_staged", { path: "file.txt", diff: "", truncated: true })))
      .toContain("Git diff (staged)\n  Path: file.txt\n  No visible diff content.");
    expect(renderGitToolResult(result("git_diff", { diff: "diff --git a/a b/a\n", truncated: true })))
      .toContain("Diff output truncated by the Git service");
  });

  it("renders empty and populated logs as compact subject summaries", () => {
    expect(renderGitToolResult(result("git_log", { commits: [], truncated: false }))).toContain("No commits.");
    const text = renderGitToolResult(result("git_log", { commits: [
      { hash: "1234567890abcdef", author: "Ada", date: "2026-11-19", message: "Subject line\n\nLong body" },
    ], truncated: false }))!;
    expect(text).toContain("12345678 Subject line");
    expect(text).toContain("Ada · 2026-11-19");
    expect(text).not.toContain("Long body");
  });

  it("marks the current branch and handles detached or empty branch lists", () => {
    const branches = renderGitToolResult(result("git_branch", {
      current_branch: "main", detached: false, truncated: false,
      branches: [{ name: "main", current: true }, { name: "feature", current: false }],
    }))!;
    expect(branches).toContain("* main (current)");
    expect(branches).toContain("feature");
    expect(renderGitToolResult(result("git_branch", { current_branch: null, detached: true, branches: [], truncated: false })))
      .toContain("HEAD: detached");
    expect(renderGitToolResult(result("git_branch", { current_branch: "main", detached: false, branches: [], truncated: false })))
      .toContain("* main (current; no commits yet)");
  });

  it("escapes terminal controls in unusual paths and keeps path rows narrow", () => {
    const name = "line\nbreak\t\u001b[31m.txt";
    const text = renderGitToolResult(result("git_status", {
      is_repository: true, state: "dirty", current_branch: "main", detached: false, unborn: false,
      staged: [], unstaged: [{ path: name, status: "M" }], untracked: [], truncated: false,
    }), 30)!;
    expect(text).toContain("line");
    expect(text).toContain("break⇥␛[31m.txt");
    expect(text).not.toContain("\u001b");
    const rows = text.split("\n").filter((line) => line.includes("line") || line.includes("break⇥"));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => Array.from(row).length <= 30)).toBe(true);
  });

  it("leaves non-Git tool output to the existing CLI flow", () => {
    expect(renderGitToolResult(result("read_file", { content: "unchanged" }))).toBeNull();
  });
});
