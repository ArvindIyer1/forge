import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { searchFilesTool } from "./search-files.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { gitStatusTool } from "./git-status.js";
import { gitDiffTool } from "./git-diff.js";
import { gitDiffStagedTool } from "./git-diff-staged.js";
import { gitLogTool } from "./git-log.js";
import { gitBranchTool } from "./git-branch.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(searchFilesTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitDiffStagedTool);
  registry.register(gitLogTool);
  registry.register(gitBranchTool);
  return registry;
}
