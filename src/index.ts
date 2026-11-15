import "dotenv/config";
import { loadConfig } from "./config/env.js";
import { startTerminalChat } from "./cli/chat.js";
import { createProvider } from "./providers/factory.js";
import { Agent } from "./agent/agent.js";
import { createDefaultToolRegistry } from "./tools/create-default.js";
import { Workspace } from "./tools/workspace.js";
import { GitService } from "./git/git-service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createProvider(config);
  const workspace = await Workspace.create(config.workspaceRoot);
  let gitService: GitService | null = null;
  let gitServiceError: string | undefined;
  try {
    gitService = await GitService.create(workspace);
  } catch (error) {
    gitServiceError = error instanceof Error ? error.message : "Git is unavailable.";
  }
  const agent = new Agent(provider, createDefaultToolRegistry(), { workspace, gitService, gitServiceError });

  await startTerminalChat(provider, agent);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  process.stderr.write(`FORGE could not start: ${message}\n`);
  process.exitCode = 1;
});
