import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent } from "../agent/agent.js";
import type { ModelProvider } from "../providers/types.js";
import type { ProposedFileChange } from "../tools/file-changes.js";
import type { ApprovalDecision } from "../tools/types.js";

interface TerminalOptions {
  input?: Readable;
  output?: Writable;
}

interface LineWaiter {
  resolve: (line: string | null) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
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
  const queuedLines: string[] = [];
  const waiters: LineWaiter[] = [];
  let closed = false;
  let activeController: AbortController | undefined;
  let interrupted = false;

  const removeWaiter = (waiter: LineWaiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  };

  const nextLine = (signal?: AbortSignal): Promise<string | null> => {
    signal?.throwIfAborted();
    if (queuedLines.length) return Promise.resolve(queuedLines.shift()!);
    if (closed) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          removeWaiter(waiter);
          reject(signal.reason ?? new Error("Approval cancelled."));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  };

  terminal.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      removeWaiter(waiter);
      waiter.resolve(line);
    } else {
      queuedLines.push(line);
    }
  });
  terminal.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      removeWaiter(waiter);
      waiter.resolve(null);
    }
  });
  terminal.on("SIGINT", () => {
    interrupted = true;
    activeController?.abort(new Error("Cancelled by user."));
    terminal.close();
  });

  const requestApproval = async (
    proposal: ProposedFileChange,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> => {
    output.write(`\nProposed ${proposal.operation}: ${escapeTerminalControls(proposal.path)}\n`);
    output.write(`${escapeTerminalControls(proposal.diff)}\n`);
    output.write("Approve this change? [A]pprove / [R]eject (Enter rejects): ");

    while (true) {
      const answer = (await nextLine(signal))?.trim().toLowerCase();
      if (answer === null) throw new Error("Approval prompt closed.");
      if (answer === "a" || answer === "approve") {
        output.write("Approved.\n");
        return "approved";
      }
      if (!answer || answer === "r" || answer === "reject") {
        output.write("Rejected. No file change was made.\n");
        return "rejected";
      }
      output.write("Enter A to approve or R to reject. Pressing Enter rejects.\n");
      output.write("[A]pprove / [R]eject: ");
    }
  };

  output.write(`FORGE agent (${provider.id}/${provider.model}). Type /clear to reset or /exit to quit.\n`);

  try {
    while (!interrupted) {
      const line = await nextLine();
      if (line === null) break;

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
            requestApproval,
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

function escapeTerminalControls(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\u001b") return "␛";
    if (character === "\r") return "␍";
    if (character === "\t") return "⇥";
    if (character === "\u007f") return "␡";
    const code = character.charCodeAt(0);
    if (code <= 0x1f) return String.fromCharCode(0x2400 + code);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
