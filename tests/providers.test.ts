import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/env.js";
import { createProvider } from "../src/providers/factory.js";
import type { ChatMessage, ToolDefinition } from "../src/providers/types.js";
import { createDefaultToolRegistry } from "../src/tools/create-default.js";

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
  workspaceRoot: "/tmp/forge-test",
});

const fileTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

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

  it("maps Gemini function calls and streams mocked text", async () => {
    sdkMocks.geminiStream.mockResolvedValue(
      chunks([
        { text: "Looking. " },
        {
          text: "",
          candidates: [{ content: { parts: [{ functionCall: { id: "g-call-1", name: "read_file", args: { path: "README.md" } }, thoughtSignature: "opaque-signature" }] } }],
        },
      ]),
    );
    const provider = createProvider(config("gemini"));
    const messages: ChatMessage[] = [
      { role: "system", content: "Read-only assistant." },
      { role: "user", content: "Read README" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "prior-call", providerCallId: "prior-provider-call", providerMetadata: { thoughtSignature: "prior-signature" }, name: "read_file", arguments: { path: "README.md" } }],
      },
      {
        role: "tool",
        toolCallId: "prior-call",
        providerCallId: "prior-provider-call",
        name: "read_file",
        content: "{\"ok\":true,\"result\":{\"content\":\"hello\"}}",
      },
      { role: "user", content: "Summarize it" },
    ];
    const events = [];
    for await (const event of provider.streamTurn(messages, fileTools)) events.push(event);

    expect(events).toEqual([
      { type: "text_delta", text: "Looking. " },
      {
        type: "turn_complete",
        toolCalls: [{ id: "g-call-1", providerCallId: "g-call-1", providerMetadata: { thoughtSignature: "opaque-signature" }, name: "read_file", arguments: { path: "README.md" } }],
      },
    ]);
    expect(sdkMocks.geminiStream).toHaveBeenCalledWith({
      model: "gemini-test-model",
      contents: [
        { role: "user", parts: [{ text: "Read README" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "prior-provider-call",
                name: "read_file",
                args: { path: "README.md" },
                thoughtSignature: "prior-signature",
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "prior-provider-call",
                name: "read_file",
                response: { result: { ok: true, result: { content: "hello" } } },
              },
            },
          ],
        },
        { role: "user", parts: [{ text: "Summarize it" }] },
      ],
      config: {
        systemInstruction: "Read-only assistant.",
        tools: [
          {
            functionDeclarations: [
              {
                name: "read_file",
                description: "Read a workspace file.",
                parametersJsonSchema: fileTools[0].parameters,
              },
            ],
          },
        ],
      },
    });
  });

  it("assembles Groq streamed argument fragments and maps the tool request", async () => {
    sdkMocks.groqStream.mockResolvedValue(
      chunks([
        {
          choices: [
            {
              delta: {
                content: "Checking. ",
                tool_calls: [
                  {
                    index: 0,
                    id: "groq-call-1",
                    function: { name: "read_file", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }],
              },
            },
          ],
        },
      ]),
    );
    const provider = createProvider(config("groq"));
    const messages: ChatMessage[] = [
      { role: "system", content: "Read-only assistant." },
      { role: "user", content: "Read README" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "old-call", providerCallId: "old-call", name: "read_file", arguments: { path: "README.md" } }],
      },
      {
        role: "tool",
        toolCallId: "old-call",
        providerCallId: "old-call",
        name: "read_file",
        content: "{\"ok\":true}",
      },
    ];
    const events = [];
    for await (const event of provider.streamTurn(messages, fileTools)) events.push(event);

    expect(events).toEqual([
      { type: "text_delta", text: "Checking. " },
      {
        type: "turn_complete",
        toolCalls: [
          { id: "groq-call-1", providerCallId: "groq-call-1", name: "read_file", arguments: { path: "README.md" } },
        ],
      },
    ]);
    expect(sdkMocks.groqStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "groq-test-model",
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a workspace file.",
              parameters: fileTools[0].parameters,
            },
          },
        ],
        messages: expect.arrayContaining([
          { role: "assistant", content: null, tool_calls: [expect.objectContaining({ id: "old-call" })] },
          { role: "tool", tool_call_id: "old-call", content: "{\"ok\":true}" },
        ]),
      }),
      undefined,
    );
  });

  it("formats authentication, quota, network, and secret-safe provider errors", () => {
    const groq = createProvider(config("groq"));
    const gemini = createProvider(config("gemini"));

    expect(groq.formatError({ status: 401, message: "invalid api key" })).toContain("GROQ_API_KEY");
    expect(groq.formatError({ status: 429, message: "rate limit reached" })).toContain("quota or rate limit");
    expect(groq.formatError({ code: "ENOTFOUND", message: "network unavailable" })).toContain("internet connection");
    expect(gemini.formatError({ status: 401, message: "gemini-secret-key invalid" })).not.toContain("gemini-secret-key");
  });

  it("sends write and edit declarations through both provider adapters", async () => {
    const definitions = createDefaultToolRegistry().definitions();
    sdkMocks.geminiStream.mockResolvedValue(chunks([{ candidates: [{ content: { parts: [] } }] }]));
    const gemini = createProvider(config("gemini"));
    for await (const _event of gemini.streamTurn([{ role: "user", content: "Change a file" }], definitions)) {
      // Consume the mocked response so the request is made.
    }
    const geminiRequest = sdkMocks.geminiStream.mock.calls[0][0];
    const geminiNames = geminiRequest.config.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name);
    expect(geminiNames).toContain("write_file");
    expect(geminiNames).toContain("edit_file");

    sdkMocks.groqStream.mockResolvedValue(chunks([{ choices: [{ delta: {} }] }]));
    const groq = createProvider(config("groq"));
    for await (const _event of groq.streamTurn([{ role: "user", content: "Change a file" }], definitions)) {
      // Consume the mocked response so the request is made.
    }
    const groqRequest = sdkMocks.groqStream.mock.calls[0][0];
    const groqNames = groqRequest.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(groqNames).toContain("write_file");
    expect(groqNames).toContain("edit_file");
  });
});
