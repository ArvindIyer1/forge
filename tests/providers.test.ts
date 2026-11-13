import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/env.js";
import { createProvider } from "../src/providers/factory.js";
import { toGroqMessages } from "../src/providers/groq.js";
import type { ChatMessage } from "../src/providers/types.js";

const sdkMocks = vi.hoisted(() => ({
  geminiStream: vi.fn(),
  groqStream: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: sdkMocks.geminiStream };
  },
}));

vi.mock("groq-sdk", () => ({
  default: class {
    chat = { completions: { create: sdkMocks.groqStream } };
  },
}));

const config = (provider: "gemini" | "groq"): AppConfig => ({
  provider,
  apiKey: `${provider}-secret-key`,
  model: `${provider}-test-model`,
});

async function* chunks<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

describe("provider adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects the configured provider through the factory", () => {
    const gemini = createProvider(config("gemini"));
    const groq = createProvider(config("groq"));

    expect([gemini.id, gemini.model]).toEqual(["gemini", "gemini-test-model"]);
    expect([groq.id, groq.model]).toEqual(["groq", "groq-test-model"]);
  });

  it("converts common messages to Gemini roles and streams mocked text", async () => {
    sdkMocks.geminiStream.mockResolvedValue(
      chunks([{ text: "first " }, { text: "reply" }]),
    );
    const provider = createProvider(config("gemini"));
    const messages: ChatMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Again" },
    ];
    const reply: string[] = [];

    for await (const part of provider.stream(messages)) reply.push(part);

    expect(reply.join("")).toBe("first reply");
    expect(sdkMocks.geminiStream).toHaveBeenCalledWith({
      model: "gemini-test-model",
      contents: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi" }] },
        { role: "user", parts: [{ text: "Again" }] },
      ],
      config: { systemInstruction: "Be concise." },
    });
  });

  it("preserves common roles in Groq messages and streams mocked text", async () => {
    sdkMocks.groqStream.mockResolvedValue(
      chunks([
        { choices: [{ delta: { content: "groq " } }] },
        { choices: [{ delta: { content: "reply" } }] },
      ]),
    );
    const provider = createProvider(config("groq"));
    const messages: ChatMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ];
    const reply: string[] = [];

    for await (const part of provider.stream(messages)) reply.push(part);

    expect(reply.join("")).toBe("groq reply");
    expect(toGroqMessages(messages)).toEqual(messages);
    expect(sdkMocks.groqStream).toHaveBeenCalledWith({
      model: "groq-test-model",
      messages,
      stream: true,
    });
  });

  it("gives useful provider errors without exposing the API key", () => {
    const groq = createProvider(config("groq"));
    const gemini = createProvider(config("gemini"));

    expect(groq.formatError({ status: 401, message: "invalid api key" })).toContain(
      "Check GROQ_API_KEY",
    );
    expect(groq.formatError({ status: 429, message: "rate limit reached" })).toContain(
      "quota or rate limit",
    );
    expect(groq.formatError({ code: "ENOTFOUND", message: "network unavailable" })).toContain(
      "internet connection",
    );
    expect(gemini.formatError({ status: 401, message: "gemini-secret-key invalid" })).not.toContain(
      "gemini-secret-key",
    );
  });
});
