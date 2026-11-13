import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/conversation/session.js";
import type { ChatMessage, ModelProvider } from "../src/providers/types.js";

describe("ConversationSession", () => {
  it("keeps conversation history and streams the reply", async () => {
    const requests: ChatMessage[][] = [];
    const provider: ModelProvider = {
      id: "gemini",
      model: "test-model",
      async *stream(messages) {
        requests.push(messages.map((message) => ({ ...message })));
        yield "hello ";
        yield "back";
      },
      formatError: (error) => String(error),
    };

    const session = new ConversationSession(provider);
    const firstReply: string[] = [];
    for await (const part of session.sendMessageStream("hi")) firstReply.push(part);

    const secondReply: string[] = [];
    for await (const part of session.sendMessageStream("how are you?")) secondReply.push(part);

    expect(firstReply.join("")).toBe("hello back");
    expect(secondReply.join("")).toBe("hello back");
    expect(requests[1]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
      { role: "user", content: "how are you?" },
    ]);
    expect(session.history).toHaveLength(4);
  });

  it("clears the stored conversation", () => {
    const provider: ModelProvider = {
      id: "groq",
      model: "test-model",
      async *stream() {
        yield "unused";
      },
      formatError: (error) => String(error),
    };
    const session = new ConversationSession(provider);

    session.clear();

    expect(session.history).toEqual([]);
  });
});
