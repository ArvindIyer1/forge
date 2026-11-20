import type { ToolExecutionResult } from "../tools/types.js";
import { escapeTerminalControls, wrapTerminalText } from "./terminal-format.js";

const DIFF_DISPLAY_LIMIT = 24_000;
const GIT_TOOLS = new Set(["git_status", "git_diff", "git_diff_staged", "git_log", "git_branch"]);

/** Return null for non-Git tools so their existing terminal behavior is unchanged. */
export function renderGitToolResult(
  result: ToolExecutionResult,
  width = process.stdout.columns ?? 80,
): string | null {
  if (!GIT_TOOLS.has(result.name)) return null;
  let payload: any;
  try { payload = JSON.parse(result.content); }
  catch { return `\nGit tool error\n  Invalid tool result.\n`; }
  if (!result.ok || payload?.ok === false) {
    return `\n${headingFor(result.name)}\n  Error: ${safe(payload?.error ?? "Git operation failed.")}\n`;
  }
  const value = payload?.result;
  switch (result.name) {
    case "git_status": return renderStatus(value, width);
    case "git_diff": return renderDiff(value, "unstaged", width);
    case "git_diff_staged": return renderDiff(value, "staged", width);
    case "git_log": return renderLog(value);
    case "git_branch": return renderBranches(value, width);
    default: return null;
  }
}

function renderStatus(value: any, width: number): string {
  if (!value?.is_repository) return "\nGit status\n  Repository: unavailable (not a Git repository)\n";
  const state = value.truncated || value.state === "unknown" ? "unknown" : value.state;
  const lines = ["", "Git status", "  Repository: available"];
  if (value.detached) lines.push("  HEAD: detached");
  else if (value.current_branch) lines.push(`  Branch: ${safe(value.current_branch)}${value.unborn ? " (unborn)" : ""}`);
  else lines.push(`  Branch: ${value.unborn ? "unborn" : "unknown"}`);
  if (value.upstream) lines.push(`  Upstream: ${safe(value.upstream)}`);
  lines.push(`  State: ${state}`);
  if (state === "unknown") lines.push("  ! Status is incomplete or could not be parsed; repository state is unknown.");
  appendPaths(lines, "Staged", value.staged, width, (entry) => `${entry.status ?? "?"} ${entry.path ?? "(unknown path)"}${entry.other_path ? ` ← ${entry.other_path}` : ""}`);
  appendPaths(lines, "Unstaged", value.unstaged, width, (entry) => `${entry.status ?? "?"} ${entry.path ?? "(unknown path)"}${entry.other_path ? ` ← ${entry.other_path}` : ""}`);
  appendPaths(lines, "Untracked", value.untracked, width, (path) => `? ${path}`);
  if (value.truncated) lines.push("  ! Status output was truncated.");
  if (value.parse_error) lines.push(`  ! ${safe(value.parse_error)}`);
  return `${lines.join("\n")}\n`;
}

function appendPaths(lines: string[], title: string, entries: unknown, width: number, format: (entry: any) => string): void {
  const paths = Array.isArray(entries) ? entries : [];
  lines.push(`  ${title} (${paths.length})`);
  if (paths.length === 0) { lines.push("    (none)"); return; }
  for (const entry of paths) lines.push(wrapTerminalText(safe(format(entry)), width, "    "));
}

function renderDiff(value: any, kind: "staged" | "unstaged", width: number): string {
  const lines = ["", `Git diff (${kind})`];
  if (value?.path) lines.push(`  Path: ${safe(value.path)}`);
  const raw = typeof value?.diff === "string" ? value.diff : "";
  const points = Array.from(raw);
  const clipped = points.length > DIFF_DISPLAY_LIMIT;
  if (!raw.trim()) lines.push(value?.truncated ? "  No visible diff content." : "  No changes.");
  else lines.push(safe(points.slice(0, DIFF_DISPLAY_LIMIT).join("")));
  if (value?.truncated || clipped) lines.push(`  ! Diff output truncated${clipped ? ` for terminal display at ${DIFF_DISPLAY_LIMIT} characters` : " by the Git service"}.`);
  // Keep narrow-terminal output legible without changing patch lines or tool data.
  if (width < 60) lines.push("  (Narrow terminal: long diff lines may continue horizontally.)");
  return `${lines.join("\n")}\n`;
}

function renderLog(value: any): string {
  const commits = Array.isArray(value?.commits) ? value.commits : [];
  const lines = ["", "Git log"];
  if (commits.length === 0) lines.push("  No commits.");
  for (const commit of commits) {
    const hash = typeof commit.hash === "string" ? commit.hash.slice(0, 8) : "????????";
    const message = typeof commit.message === "string" ? commit.message : "";
    const subject = message.split(/\r?\n/).find((line: string) => line.trim())?.trim() || "(no message)";
    lines.push(`  ${hash} ${safe(subject)}`);
    lines.push(`    ${safe(commit.author ?? "Unknown author")} · ${safe(commit.date ?? "Unknown date")}`);
  }
  if (value?.truncated) lines.push("  ! Commit list is truncated.");
  return `${lines.join("\n")}\n`;
}

function renderBranches(value: any, width: number): string {
  const branches = Array.isArray(value?.branches) ? value.branches : [];
  const lines = ["", "Git branches"];
  if (value?.detached) lines.push("  HEAD: detached");
  if (branches.length === 0) {
    if (value?.current_branch) lines.push(wrapTerminalText(`* ${value.current_branch} (current; no commits yet)`, width, "  "));
    else lines.push("  No local branches.");
  }
  for (const branch of branches) {
    const current = Boolean(branch.current);
    lines.push(wrapTerminalText(`${current ? "*" : " "} ${branch.name}${current ? " (current)" : ""}`, width, "  "));
  }
  if (value?.truncated) lines.push("  ! Branch list or status is truncated.");
  return `${lines.join("\n")}\n`;
}

function headingFor(name: string): string {
  switch (name) {
    case "git_status": return "Git status";
    case "git_diff": return "Git diff (unstaged)";
    case "git_diff_staged": return "Git diff (staged)";
    case "git_log": return "Git log";
    case "git_branch": return "Git branches";
    default: return "Git tool";
  }
}

function safe(value: unknown): string {
  return escapeTerminalControls(String(value));
}
