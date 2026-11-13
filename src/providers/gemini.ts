import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config/env.js";
import { getErrorDetails, isNetworkError, redact } from "./error-utils.js";
import type { ChatMessage, ModelProvider } from "./types.js";

export function createGeminiProvider(config: AppConfig): ModelProvider {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });

  return {
    id: "gemini",
    model: config.model,

    async *stream(messages: readonly ChatMessage[]): AsyncGenerator<string> {
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const contents = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        }));

      const response = await ai.models.generateContentStream({
        model: config.model,
        contents,
        ...(systemText ? { config: { systemInstruction: systemText } } : {}),
      });

      for await (const chunk of response) {
        if (chunk.text) {
          yield chunk.text;
        }
      }
    },

    formatError(error: unknown): string {
      return formatGeminiError(error, config.model, config.apiKey);
    },
  };
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
