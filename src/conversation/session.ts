import type { ChatProvider, StreamingChat } from "../providers/gemini.js";

export class ConversationSession {
  private chat: StreamingChat;

  constructor(private readonly provider: ChatProvider) {
    this.chat = provider.createChat();
  }

  sendMessageStream(message: string): AsyncIterable<string> {
    return this.chat.sendMessageStream(message);
  }

  clear(): void {
    this.chat = this.provider.createChat();
  }
}
