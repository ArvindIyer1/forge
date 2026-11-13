import { z } from "zod";
import type { Tool } from "./types.js";

const argumentsSchema = z.object({ path: z.string().min(1) }).strict();

export const readFileTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "read_file",
  description: "Read a UTF-8 text file beneath the workspace, up to the configured file-size limit.",
  schema: argumentsSchema,
  async execute(args, context) {
    context.signal?.throwIfAborted();
    const content = await context.workspace.readTextFile(args.path);
    return { path: args.path, content };
  },
};
