import Groq from "groq-sdk";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import type { AppConfig } from "../config/env.js";
import { getErrorDetails, isNetworkError, redact } from "./error-utils.js";
import type { ChatMessage, ModelProvider, ProviderEvent, ToolCall, ToolDefinition } from "./types.js";

interface PendingToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export function createGroqProvider(config: AppConfig): ModelProvider {
  const groq = new Groq({ apiKey: config.apiKey });
  let generatedId = 0;

  return {
    id: "groq",
    model: config.model,

    async *streamTurn(
      messages: readonly ChatMessage[],
      tools: readonly ToolDefinition[],
      signal?: AbortSignal,
    ): AsyncGenerator<ProviderEvent> {
      const request = {
        model: config.model,
        messages: toGroqMessages(messages),
        ...(tools.length > 0 ? { tools: toGroqTools(tools), parallel_tool_calls: true } : {}),
        stream: true as const,
      };
      const response = await groq.chat.completions.create(
        request,
        signal ? { signal } : undefined,
      );
      const pendingCalls = new Map<number, PendingToolCall>();

      for await (const chunk of response) {
        if (signal?.aborted) throw new Error("Request cancelled.");
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const call = pendingCalls.get(toolCall.index) ?? { arguments: "" };
          if (toolCall.id) call.id = toolCall.id;
          if (toolCall.function?.name) call.name = (call.name ?? "") + toolCall.function.name;
          if (toolCall.function?.arguments) call.arguments += toolCall.function.arguments;
          pendingCalls.set(toolCall.index, call);
        }
      }

      const toolCalls = [...pendingCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => normalizeGroqToolCall(index, call, () => generatedId++));

      yield { type: "turn_complete", toolCalls };
    },

    formatError(error: unknown): string {
      return formatGroqError(error, config.model, config.apiKey);
    },
  };
}

function toGroqMessages(messages: readonly ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.providerCallId ?? message.toolCallId,
        content: message.content,
      };
    }

    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.providerCallId ?? call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: call.rawArguments ?? JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      };
    }

    return { role: message.role, content: message.content };
  });
}

function toGroqTools(tools: readonly ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function normalizeGroqToolCall(
  index: number,
  call: PendingToolCall,
  nextId: () => number,
): ToolCall {
  const rawArguments = call.arguments || "{}";
  const id = call.id ?? `groq-call-${nextId()}`;
  try {
    return {
      id,
      providerCallId: id,
      name: call.name ?? "",
      arguments: JSON.parse(rawArguments) as unknown,
      ...(!call.name ? { argumentError: `Tool call ${index} did not include a name.` } : {}),
    };
  } catch {
    return {
      id,
      providerCallId: id,
      name: call.name ?? "",
      arguments: null,
      argumentError: "Tool arguments were not valid JSON.",
      rawArguments,
    };
  }
}

function formatGroqError(error: unknown, model: string, apiKey: string): string {
  const details = getErrorDetails(error);
  const message = details.message.toLowerCase();

  if (
    details.status === 401 ||
    message.includes("invalid_api_key") ||
    message.includes("invalid api key") ||
    message.includes("authentication")
  ) {
    return "Groq rejected the API key. Check GROQ_API_KEY in your .env file.";
  }
  if (
    details.status === 402 ||
    details.status === 429 ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit")
  ) {
    return "Groq quota or rate limit reached. Check your Groq account limits and try again later.";
  }
  if (
    (details.status === 400 || details.status === 404) &&
    (message.includes("model") || message.includes(model.toLowerCase()))
  ) {
    return `Groq could not use model "${model}". Check GROQ_MODEL in your .env file.`;
  }
  if (isNetworkError(details)) {
    return "Could not connect to Groq. Check your internet connection and try again.";
  }
  if (details.status === 403) {
    return "Groq denied this request. Check the API key's access and your account status.";
  }

  return `Groq request failed: ${redact(details.message, apiKey)}`;
}
