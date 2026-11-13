import { createPatch } from "diff";

/** Build a readable unified diff for the exact contents shown for approval. */
export function createUnifiedDiff(path: string, before: string, after: string): string {
  return createPatch(path, before, after, "original", "proposed", { context: 3 });
}
