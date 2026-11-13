import type { ChatMessage, ModelProvider } from "../providers/types.js";

export class ConversationSession {
  private messages: ChatMessage[] = [];

  constructor(private readonly provider: ModelProvider) {}

  get history(): readonly ChatMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  async *sendMessageStream(message: string): AsyncGenerator<string> {
    this.messages.push({ role: "user", content: message });
    let reply = "";
    let completed = false;

    try {
      for await (const text of this.provider.stream(this.history)) {
        reply += text;
        yield text;
      }

      this.messages.push({ role: "assistant", content: reply });
      completed = true;
    } finally {
      if (!completed) {
        this.messages.pop();
      }
    }
  }

  clear(): void {
    this.messages = [];
  }
}
