import Groq from "groq-sdk";
import type { AppConfig } from "../config/env.js";
import type { ChatMessage, ModelProvider } from "./types.js";
import { getErrorDetails, isNetworkError, redact } from "./error-utils.js";

export function toGroqMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message }));
}

export function createGroqProvider(config: AppConfig): ModelProvider {
  const groq = new Groq({ apiKey: config.apiKey });

  return {
    id: "groq",
    model: config.model,

    async *stream(messages: readonly ChatMessage[]): AsyncGenerator<string> {
      const response = await groq.chat.completions.create({
        model: config.model,
        messages: toGroqMessages(messages),
        stream: true,
      });

      for await (const chunk of response) {
        const text = chunk.choices[0]?.delta.content;
        if (typeof text === "string") {
          yield text;
        }
      }
    },

    formatError(error: unknown): string {
      return formatGroqError(error, config.model, config.apiKey);
    },
  };
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

