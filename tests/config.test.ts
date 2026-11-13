import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  it("reads the Gemini API key and model", () => {
    expect(
      loadConfig({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "test-model" }),
    ).toEqual({ apiKey: "test-key", model: "test-model" });
  });

  it("reports missing settings without exposing an API key", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "", GEMINI_MODEL: undefined })).toThrow(
      "GEMINI_API_KEY, GEMINI_MODEL",
    );
  });
});
