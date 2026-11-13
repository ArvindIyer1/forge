import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config/env.js";
import { getErrorDetails, isNetworkError, redact } from "./error-utils.js";
import type { ChatMessage, ModelProvider, ToolCall, ToolDefinition } from "./types.js";

export function createGeminiProvider(config: AppConfig): ModelProvider {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });

  return {
    id: "gemini",
    model: config.model,

    async *streamTurn(
      messages: readonly ChatMessage[],
      tools: readonly ToolDefinition[],
      signal?: AbortSignal,
    ): AsyncGenerator<import("./types.js").ProviderEvent> {
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const contents = toGeminiContents(messages);
      const toolDeclarations = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      }));
      const response = await ai.models.generateContentStream({
        model: config.model,
        contents,
        config: {
          ...(systemText ? { systemInstruction: systemText } : {}),
          ...(toolDeclarations.length > 0
            ? { tools: [{ functionDeclarations: toolDeclarations }] }
            : {}),
          ...(signal ? { abortSignal: signal } : {}),
        },
      });

      const toolCalls: ToolCall[] = [];
      let generatedId = 0;

      for await (const chunk of response) {
        if (signal?.aborted) throw new Error("Request cancelled.");

        if (chunk.text) {
          yield { type: "text_delta", text: chunk.text };
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          const functionCall = part.functionCall;
          if (!functionCall) continue;
          const id = functionCall.id ?? `forge-gemini-call-${generatedId++}`;
          toolCalls.push({
            id,
            ...(functionCall.id ? { providerCallId: functionCall.id } : {}),
            ...(part.thoughtSignature
              ? { providerMetadata: { thoughtSignature: part.thoughtSignature } }
              : {}),
            name: functionCall.name ?? "",
            arguments: functionCall.args ?? {},
          });
        }
      }

      yield { type: "turn_complete", toolCalls };
    },

    formatError(error: unknown): string {
      return formatGeminiError(error, config.model, config.apiKey);
    },
  };
}

function toGeminiContents(messages: readonly ChatMessage[]) {
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      let result: unknown = message.content;
      try {
        result = JSON.parse(message.content);
      } catch {
        // Keep plain text results as text when they are not JSON.
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              ...(message.providerCallId ? { id: message.providerCallId } : {}),
              name: message.name,
              response: { result },
            },
          },
        ],
      });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (message.content) parts.push({ text: message.content });
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            ...(toolCall.providerCallId ? { id: toolCall.providerCallId } : {}),
            name: toolCall.name,
            args: isObject(toolCall.arguments) ? toolCall.arguments : {},
            ...(getThoughtSignature(toolCall.providerMetadata)
              ? { thoughtSignature: getThoughtSignature(toolCall.providerMetadata) }
              : {}),
          },
        });
      }
    }
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }

  return contents;
}

function getThoughtSignature(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const signature = (metadata as { thoughtSignature?: unknown }).thoughtSignature;
  return typeof signature === "string" ? signature : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatGeminiError(error: unknown, model: string, apiKey: string): string {
  const details = getErrorDetails(error);
  const message = details.message.toLowerCase();

  if (
    details.status === 401 ||
    details.status === 403 ||
    message.includes("api key") ||
    message.includes("unauthenticated") ||
    message.includes("permission denied")
  ) {
    return "Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.";
  }
  if (
    details.status === 429 ||
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit")
  ) {
    return "Gemini quota or rate limit reached. Check your Google AI Studio usage and try again later.";
  }
  if (
    (details.status === 400 || details.status === 404) &&
    (message.includes("model") || message.includes(model.toLowerCase()))
  ) {
    return `Gemini could not use model "${model}". Check GEMINI_MODEL in your .env file.`;
  }
  if (isNetworkError(details)) {
    return "Could not connect to Gemini. Check your internet connection and try again.";
  }

  return `Gemini request failed: ${redact(details.message, apiKey)}`;
}
