import { z } from "zod";
import type { Tool } from "./types.js";

const argumentsSchema = z.object({ path: z.string().min(1).max(4096).optional() }).strict();

export const getChangeAttributionTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "get_change_attribution",
  description: "Inspect file-level change attribution for the current task. Read only; attribution is conservative and does not claim line-level authorship.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    if (!context.changeAttribution) return { task_id: null, baseline_complete: false, files: [], state: "unknown" };
    return context.changeAttribution.report(args.path);
  },
};
