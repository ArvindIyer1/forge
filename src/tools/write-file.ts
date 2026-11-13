import { z } from "zod";
import { applyFileChange, prepareCreate } from "./file-changes.js";
import type { Tool } from "./types.js";
import { MAX_READ_BYTES } from "./workspace.js";

const argumentsSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(MAX_READ_BYTES),
}).strict();

export const writeFileTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "write_file",
  description: "Create a new UTF-8 text file inside the workspace. Existing files are never overwritten.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    const proposal = await prepareCreate(context.workspace, args.path, args.content);
    context.signal?.throwIfAborted();
    if (!context.requestApproval) throw new Error("File change approval is not configured.");
    const decision = await context.requestApproval(proposal, context.signal);
    context.signal?.throwIfAborted();
    if (decision !== "approved") return { status: "rejected", path: proposal.path, operation: proposal.operation };
    const applied = await applyFileChange(context.workspace, proposal, context.signal);
    return { status: "approved", ...applied };
  },
};
