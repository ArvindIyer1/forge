import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ConversationSession } from "../conversation/session.js";
import type { ModelProvider } from "../providers/types.js";

interface TerminalOptions {
  input?: Readable;
  output?: Writable;
}

export async function startTerminalChat(
  provider: ModelProvider,
  options: TerminalOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTerminal = Boolean((input as Readable & { isTTY?: boolean }).isTTY);
  const terminal = createInterface({ input, output, terminal: isTerminal });
  const session = new ConversationSession(provider);
  let interrupted = false;

  terminal.on("SIGINT", () => {
    interrupted = true;
    terminal.close();
  });

  output.write(`FORGE chat (${provider.id}/${provider.model}). Type /clear to reset or /exit to quit.\n`);

  try {
    for await (const line of terminal) {
      if (interrupted) break;

      const message = line.trim();
      if (!message) continue;

      if (message === "/exit") {
        break;
      }

      if (message === "/clear") {
        session.clear();
        output.write("Conversation cleared.\n");
        continue;
      }

      output.write("FORGE> ");

      try {
        for await (const text of session.sendMessageStream(message)) {
          if (interrupted) break;
          output.write(text);
        }
        output.write("\n");
      } catch (error) {
        output.write(`\n${provider.formatError(error)}\n`);
      }
    }
  } finally {
    terminal.close();
    output.write("Goodbye!\n");
  }
}
