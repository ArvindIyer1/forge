import type { ToolCall } from "../providers/types.js";
import type { ToolDefinition } from "../providers/types.js";
import type { ToolContext, ToolExecutionResult } from "./types.js";
import { ToolRegistry } from "./registry.js";

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  definitions(): ToolDefinition[] {
    return this.registry.definitions();
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return failure(call, `Unknown tool: ${call.name || "(empty name)"}.`);
    }
    if (call.argumentError) {
      return failure(call, call.argumentError);
    }

    const parsed = tool.schema.safeParse(call.arguments);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
        .join("; ");
      return failure(call, `Invalid arguments: ${details}`);
    }

    try {
      context.signal?.throwIfAborted();
      const result = await tool.execute(parsed.data, context);
      return {
        callId: call.id,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
        name: call.name,
        ok: true,
        content: safeJson({ ok: true, result }),
      };
    } catch (error) {
      context.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      const safeMessage = message.split(context.workspace.root).join("<workspace>");
      return failure(call, safeMessage);
    }
  }

  async executeMany(calls: readonly ToolCall[], context: ToolContext): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const call of calls) {
      context.signal?.throwIfAborted();
      results.push(await this.execute(call, context));
    }
    return results;
  }
}

function failure(call: ToolCall, error: string): ToolExecutionResult {
  return {
    callId: call.id,
    ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
    name: call.name,
    ok: false,
    content: safeJson({ ok: false, error }),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ ok: false, error: "Tool returned a value that could not be serialized." });
  }
}
