import type { AppConfig } from "../config/env.js";
import { createGeminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import type { ModelProvider } from "./types.js";

export function createProvider(config: AppConfig): ModelProvider {
  switch (config.provider) {
    case "gemini":
      return createGeminiProvider(config);
    case "groq":
      return createGroqProvider(config);
  }
}
