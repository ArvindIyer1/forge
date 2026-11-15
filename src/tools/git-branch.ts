import { z } from "zod";
import { parseGitBranches, parseGitStatus } from "../git/git-parsers.js";
import type { Tool } from "./types.js";
import { getGitService } from "./git-tool-utils.js";

const argumentsSchema = z.object({}).strict();

export const gitBranchTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "git_branch",
  description: "List local branches and identify the checked-out branch. Reports a null current branch when HEAD is detached; read only.",
  schema: argumentsSchema,
  async execute(_args, context) {
    context.signal?.throwIfAborted();
    const service = await getGitService(context);
    if (!service) return { is_repository: false, current_branch: null, detached: false, branches: [], truncated: false };
    const [branchResult, statusResult] = await Promise.all([
      service.runReadOnly("branches", { signal: context.signal }),
      service.runReadOnly("status", { signal: context.signal }),
    ]);
    const branches = parseGitBranches(branchResult);
    const status = parseGitStatus(statusResult);
    return {
      is_repository: true,
      current_branch: status.current_branch,
      detached: status.detached,
      branches: status.detached ? branches.branches.map((branch) => ({ ...branch, current: false })) : branches.branches,
      truncated: branches.truncated || status.truncated,
    };
  },
};
