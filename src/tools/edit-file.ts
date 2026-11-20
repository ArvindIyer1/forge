import { z } from "zod";
import { applyFileChange, prepareEdit } from "./file-changes.js";
import type { Tool } from "./types.js";
import { MAX_READ_BYTES } from "./workspace.js";

const argumentsSchema = z.object({
  path: z.string().min(1).max(4096),
  old_text: z.string().min(1).max(MAX_READ_BYTES),
  new_text: z.string().max(MAX_READ_BYTES),
}).strict();

export const editFileTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "edit_file",
  description: "Replace one exact, unique text match in an existing UTF-8 workspace file.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    const proposal = await prepareEdit(context.workspace, args.path, args.old_text, args.new_text);
    context.signal?.throwIfAborted();
    if (!context.requestApproval) throw new Error("File change approval is not configured.");
    const decision = await context.requestApproval(proposal, context.signal);
    context.signal?.throwIfAborted();
    if (decision !== "approved") return { status: "rejected", path: proposal.path, operation: proposal.operation };
    const applied = await applyFileChange(context.workspace, proposal, context.signal);
    context.changeAttribution?.recordApplied(applied.path, applied.operation, applied.evidence, proposal.expected);
    return { status: "approved", path: applied.path, operation: applied.operation, bytesWritten: applied.bytesWritten };
  },
};
