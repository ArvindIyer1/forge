import { z } from "zod";
import { parseGitStatus } from "../git/git-parsers.js";
import type { Tool } from "./types.js";
import { getGitService } from "./git-tool-utils.js";

const argumentsSchema = z.object({}).strict();

export const gitStatusTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "git_status",
  description: "Inspect the configured workspace's Git state. Reports branch, upstream, staged, unstaged, and untracked paths; read only.",
  schema: argumentsSchema,
  async execute(_args, context) {
    context.signal?.throwIfAborted();
    const service = await getGitService(context);
    if (!service) return { is_repository: false, state: "not_repository", current_branch: null, upstream: null, detached: false, unborn: false, staged: [], unstaged: [], untracked: [], truncated: false };
    const result = await service.runReadOnly("status", { signal: context.signal });
    const status = parseGitStatus(result);
    const hasChanges = status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;
    return {
      is_repository: true,
      state: status.truncated || !status.valid ? "unknown" : hasChanges ? "dirty" : "clean",
      current_branch: status.current_branch,
      upstream: status.upstream,
      detached: status.detached,
      unborn: status.unborn,
      parse_error: status.valid ? null : "Git returned malformed or invalidly encoded status output.",
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      truncated: status.truncated,
    };
  },
};
