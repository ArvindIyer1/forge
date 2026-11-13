import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { searchFilesTool } from "./search-files.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(searchFilesTool);
  return registry;
}
