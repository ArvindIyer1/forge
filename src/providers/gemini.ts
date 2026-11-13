import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config/env.js";

export interface StreamingChat {
  sendMessageStream(message: string): AsyncIterable<string>;
}

export interface ChatProvider {
  createChat(): StreamingChat;
}

export function createGeminiProvider(config: AppConfig): ChatProvider {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });

  return {
    createChat() {
      const chat = ai.chats.create({ model: config.model });

      return {
        async *sendMessageStream(message: string): AsyncGenerator<string> {
          const response = await chat.sendMessageStream({ message });

          for await (const chunk of response) {
            if (chunk.text) {
              yield chunk.text;
            }
          }
        },
      };
    },
  };
}

export function formatGeminiError(error: unknown, config: AppConfig): string {
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
    (message.includes("model") || message.includes(config.model.toLowerCase()))
  ) {
    return `Gemini could not use model "${config.model}". Check GEMINI_MODEL in your .env file.`;
  }

  if (
    details.code?.startsWith("ECONN") ||
    details.code === "ENOTFOUND" ||
    details.code === "ETIMEDOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out")
  ) {
    return "Could not connect to Gemini. Check your internet connection and try again.";
  }

  const safeMessage = details.message.split(config.apiKey).join("[redacted]");
  return `Gemini request failed: ${safeMessage || "unknown error"}`;
}

function getErrorDetails(error: unknown): {
  message: string;
  status?: number;
  code?: string;
} {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }

  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
  };

  return {
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
  };
}
