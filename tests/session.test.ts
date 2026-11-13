import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/conversation/session.js";
import type { ChatProvider, StreamingChat } from "../src/providers/gemini.js";

describe("ConversationSession", () => {
  it("streams a reply and starts a fresh chat after clear", async () => {
    const messages: string[] = [];
    let chatsCreated = 0;

    const provider: ChatProvider = {
      createChat(): StreamingChat {
        chatsCreated += 1;
        const chatNumber = chatsCreated;

        return {
          async *sendMessageStream(message: string): AsyncGenerator<string> {
            messages.push(message);
            yield `reply ${chatNumber}`;
          },
        };
      },
    };

    const session = new ConversationSession(provider);
    const firstReply: string[] = [];
    for await (const chunk of session.sendMessageStream("hello")) {
      firstReply.push(chunk);
    }

    session.clear();
    const secondReply: string[] = [];
    for await (const chunk of session.sendMessageStream("hello again")) {
      secondReply.push(chunk);
    }

    expect(firstReply).toEqual(["reply 1"]);
    expect(secondReply).toEqual(["reply 2"]);
    expect(messages).toEqual(["hello", "hello again"]);
    expect(chatsCreated).toBe(2);
  });
});
