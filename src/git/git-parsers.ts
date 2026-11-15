import type { GitCommandResult } from "./git-service.js";

export interface GitStatusPath {
  path: string;
  status: string;
  other_path?: string;
}

export interface ParsedGitStatus {
  valid: boolean;
  current_branch: string | null;
  upstream: string | null;
  detached: boolean;
  unborn: boolean;
  staged: GitStatusPath[];
  unstaged: GitStatusPath[];
  untracked: string[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

const MAX_STATUS_ENTRIES = 1_000;
const MAX_BRANCH_ENTRIES = 2_000;

export function parseGitStatus(result: GitCommandResult): ParsedGitStatus {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    return invalidStatus(result.truncated);
  }
  const tokens = nulTokens(text, result.truncated);
  const parsed: ParsedGitStatus = {
    valid: true,
    current_branch: null,
    upstream: null,
    detached: false,
    unborn: false,
    staged: [],
    unstaged: [],
    untracked: [],
    truncated: result.truncated,
  };

  let entries = 0;
  let headers = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.startsWith("## ")) {
      headers += 1;
      if (headers > 1 || !parseBranchHeader(record.slice(3), parsed)) parsed.valid = false;
      continue;
    }
    if (record.length < 4 || record[2] !== " ") {
      parsed.valid = false;
      continue;
    }
    if (++entries > MAX_STATUS_ENTRIES) {
      parsed.truncated = true;
      break;
    }

    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path || (code !== "??" && (!/^[ MADRCTU][ MADRCTU]$/.test(code) || code === "  "))) {
      parsed.valid = false;
      continue;
    }
    let otherPath: string | undefined;
    if (/[RC]/.test(code)) {
      otherPath = tokens[index + 1];
      if (!otherPath) {
        parsed.valid = false;
        if (result.truncated) parsed.truncated = true;
      }
      else index += 1;
    }

    if (code === "??") {
      parsed.untracked.push(path);
      continue;
    }
    if (code[0] !== " ") {
      parsed.staged.push({ path, status: code[0], ...(otherPath !== undefined ? { other_path: otherPath } : {}) });
    }
    if (code[1] !== " ") {
      parsed.unstaged.push({ path, status: code[1], ...(otherPath !== undefined ? { other_path: otherPath } : {}) });
    }
  }
  if (!result.truncated && headers !== 1) parsed.valid = false;
  if (!parsed.valid) {
    parsed.current_branch = null;
    parsed.upstream = null;
    parsed.detached = false;
    parsed.unborn = false;
    parsed.staged = [];
    parsed.unstaged = [];
    parsed.untracked = [];
  }
  return parsed;
}

export function parseGitLog(result: GitCommandResult): { commits: GitCommit[]; truncated: boolean } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
  catch { return { commits: [], truncated: true }; }
  const fields = text.split("\0");
  const commits: GitCommit[] = [];
  let truncated = result.truncated;
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const hash = fields[index].replace(/^[\r\n]+/, "");
    const author = fields[index + 1];
    const date = fields[index + 2];
    const message = fields[index + 3];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) continue;
    commits.push({ hash, author, date, message });
  }
  if (commits.length > 50) {
    commits.length = 50;
    truncated = true;
  }
  return { commits, truncated };
}

export function parseGitBranches(result: GitCommandResult): { branches: GitBranch[]; truncated: boolean } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
  catch { return { branches: [], truncated: true }; }
  const fields = text.split("\0");
  const branches: GitBranch[] = [];
  let truncated = result.truncated;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const marker = fields[index].replace(/^[\r\n]+/, "");
    const name = fields[index + 1].replace(/[\r\n]+$/, "");
    if (!name) continue;
    if (branches.length >= MAX_BRANCH_ENTRIES) {
      truncated = true;
      break;
    }
    branches.push({ name, current: marker.trim() === "*" });
  }
  return { branches, truncated };
}

function nulTokens(text: string, truncated: boolean): string[] {
  const tokens = text.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  else if (truncated) tokens.pop();
  return tokens;
}

function parseBranchHeader(header: string, result: ParsedGitStatus): boolean {
  if (header === "HEAD (no branch)") {
    result.detached = true;
    return true;
  }
  if (header.startsWith("No commits yet on ") || header.startsWith("Initial commit on ")) {
    result.unborn = true;
    const prefix = header.startsWith("No commits yet on ") ? "No commits yet on " : "Initial commit on ";
    result.current_branch = header.slice(prefix.length) || null;
    return result.current_branch !== null;
  }
  const separator = header.indexOf("...");
  const branchPart = separator >= 0 ? header.slice(0, separator) : header;
  result.current_branch = branchPart || null;
  if (separator >= 0) {
    const upstreamPart = header.slice(separator + 3).replace(/\s+\[[^\]]*\]$/, "");
    result.upstream = upstreamPart || null;
    if (!result.upstream) return false;
  }
  return result.current_branch !== null;
}

function invalidStatus(truncated: boolean): ParsedGitStatus {
  return {
    valid: false,
    current_branch: null,
    upstream: null,
    detached: false,
    unborn: false,
    staged: [],
    unstaged: [],
    untracked: [],
    truncated,
  };
}
