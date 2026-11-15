import { z } from "zod";
import { parseGitLog } from "../git/git-parsers.js";
import { parseGitStatus } from "../git/git-parsers.js";
import type { Tool } from "./types.js";
import { requireGitService } from "./git-tool-utils.js";

const argumentsSchema = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict();

export const gitLogTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "git_log",
  description: "Show recent commit history for the configured repository (default 10, maximum 50). Returns commit hash, author, date, and message; read only.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    const service = await requireGitService(context);
    const statusResult = await service.runReadOnly("status", { signal: context.signal });
    if (parseGitStatus(statusResult).unborn) return { commits: [], truncated: statusResult.truncated };
    const result = await service.runReadOnly("log", { limit: args.limit ?? 10, signal: context.signal });
    const parsed = parseGitLog(result);
    return { commits: parsed.commits, truncated: parsed.truncated };
  },
};
