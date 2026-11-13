import { z } from "zod";
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, MAX_SEARCH_BYTES, MAX_SEARCH_FILES, MAX_SEARCH_RESULTS } from "./workspace.js";
import type { Tool } from "./types.js";

const argumentsSchema = z
  .object({
    query: z.string().min(1).max(200),
    path: z.string().min(1).optional(),
  })
  .strict();

const PREVIEW_LENGTH = 240;

export const searchFilesTool: Tool<z.infer<typeof argumentsSchema>> = {
  name: "search_files",
  description: "Search workspace text files for a literal, case-insensitive text string.",
  schema: argumentsSchema,
  async execute(args, context) {
    const listing = await context.workspace.listFiles(args.path ?? ".", true);
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const searchNeedle = args.query.toLocaleLowerCase();
    let bytesRead = 0;
    let scannedFiles = 0;
    let skippedFiles = 0;
    let truncated = listing.truncated || listing.files.length > MAX_LIST_ENTRIES;

    for (const path of listing.files.slice(0, MAX_SEARCH_FILES)) {
      context.signal?.throwIfAborted();
      if (bytesRead >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }

      const remainingBytes = MAX_SEARCH_BYTES - bytesRead;
      try {
        const content = await context.workspace.readTextFile(
          path,
          Math.min(MAX_READ_BYTES, remainingBytes),
        );
        bytesRead += Buffer.byteLength(content, "utf8");
        scannedFiles += 1;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLocaleLowerCase().includes(searchNeedle)) {
            matches.push({
              path,
              line: index + 1,
              preview: lines[index].slice(0, PREVIEW_LENGTH),
            });
            if (matches.length >= MAX_SEARCH_RESULTS) {
              truncated = true;
              break;
            }
          }
        }
      } catch (error) {
        context.signal?.throwIfAborted();
        skippedFiles += 1;
        if (error instanceof Error && error.message.includes("exceeds the")) {
          truncated = true;
        }
      }
    }

    if (listing.files.length > MAX_SEARCH_FILES) truncated = true;
    return { matches, scannedFiles, skippedFiles, truncated };
  },
};
