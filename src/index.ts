import "dotenv/config";
import { loadConfig } from "./config/env.js";
import { startTerminalChat } from "./cli/chat.js";
import { createGeminiProvider } from "./providers/gemini.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createGeminiProvider(config);

  await startTerminalChat(provider, config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  process.stderr.write(`FORGE could not start: ${message}\n`);
  process.exitCode = 1;
});
