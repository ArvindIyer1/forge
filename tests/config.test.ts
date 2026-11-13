import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  it("defaults to Gemini and reads its settings", () => {
    expect(
      loadConfig({
        GEMINI_API_KEY: "gemini-test-key",
        GEMINI_MODEL: "gemini-model",
        FORGE_WORKSPACE: "/tmp/forge-workspace",
      }),
    ).toEqual({
      provider: "gemini",
      apiKey: "gemini-test-key",
      model: "gemini-model",
      workspaceRoot: "/tmp/forge-workspace",
    });
  });

  it("loads only the selected provider's settings", () => {
    expect(
      loadConfig({
        MODEL_PROVIDER: "groq",
        GROQ_API_KEY: "groq-test-key",
        GROQ_MODEL: "groq-model",
        FORGE_WORKSPACE: ".",
      }),
    ).toMatchObject({ provider: "groq", apiKey: "groq-test-key", model: "groq-model" });
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      loadConfig({ MODEL_PROVIDER: "other", GEMINI_API_KEY: "key", GEMINI_MODEL: "model" }),
    ).toThrow('Invalid MODEL_PROVIDER. Choose "gemini" or "groq".');
  });

  it("reports a missing selected API key and model", () => {
    expect(() => loadConfig({ MODEL_PROVIDER: "groq" })).toThrow("GROQ_API_KEY, GROQ_MODEL");
  });
});
