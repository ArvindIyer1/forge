import { z } from "zod";
import type { Tool } from "./types.js";
import { requireGitService } from "./git-tool-utils.js";

const argumentsSchema = z.object({ path: z.string().min(1).max(4096).optional() }).strict();

export const gitDiffTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "git_diff",
  description: "Inspect unstaged changes to tracked files. An optional literal workspace-relative path narrows the diff; untracked files are reported by git_status. Read only.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    const service = await requireGitService(context);
    const result = await service.runReadOnly("diff", { path: args.path, signal: context.signal });
    return { path: args.path ?? null, diff: result.stdout.toString("utf8"), bytes_returned: result.stdout.length, truncated: result.truncated };
  },
};
