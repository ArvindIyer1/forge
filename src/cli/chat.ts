import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent } from "../agent/agent.js";
import type { ModelProvider } from "../providers/types.js";

interface TerminalOptions {
  input?: Readable;
  output?: Writable;
}

export async function startTerminalChat(
  provider: ModelProvider,
  agent: Agent,
  options: TerminalOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTerminal = Boolean((input as Readable & { isTTY?: boolean }).isTTY);
  const terminal = createInterface({ input, output, terminal: isTerminal });
  let activeController: AbortController | undefined;
  let interrupted = false;

  terminal.on("SIGINT", () => {
    interrupted = true;
    activeController?.abort(new Error("Cancelled by user."));
    terminal.close();
  });

  output.write(`FORGE agent (${provider.id}/${provider.model}). Type /clear to reset or /exit to quit.\n`);

  try {
    for await (const line of terminal) {
      if (interrupted) break;

      const message = line.trim();
      if (!message) continue;
      if (message === "/exit") break;

      if (message === "/clear") {
        agent.clear();
        output.write("Conversation cleared.\n");
        continue;
      }

      const controller = new AbortController();
      activeController = controller;
      output.write("FORGE> ");

      try {
        const result = await agent.runTask(
          message,
          {
            onText: (text) => output.write(text),
            onToolCall: (call) => output.write(`\n[calling ${call.name}]\n`),
          },
          controller.signal,
        );
        if (result.status === "iteration_limit") {
          output.write("\nAgent stopped at its iteration limit. Try asking for a narrower task.\n");
        } else {
          output.write("\n");
        }
      } catch (error) {
        if (controller.signal.aborted) {
          output.write("\nTurn cancelled.\n");
        } else {
          output.write(`\n${provider.formatError(error)}\n`);
        }
      } finally {
        if (activeController === controller) activeController = undefined;
      }
    }
  } finally {
    terminal.close();
    output.write("Goodbye!\n");
  }
}
