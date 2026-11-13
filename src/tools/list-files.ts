import { z } from "zod";
import type { Tool } from "./types.js";

const argumentsSchema = z
  .object({
    path: z.string().min(1).optional(),
    recursive: z.boolean().optional(),
  })
  .strict();

export const listFilesTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "list_files",
  description: "List files beneath a workspace-relative directory. Sensitive and generated folders are excluded.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    return context.workspace.listFiles(args.path ?? ".", args.recursive ?? true);
  },
};
