import type { ChatMessage } from "../providers/types.js";

export class ConversationSession {
  private messages: ChatMessage[] = [];

  get history(): readonly ChatMessage[] {
    return this.messages.map((message) => structuredClone(message));
  }

  append(message: ChatMessage): void {
    this.messages.push(structuredClone(message));
  }

  truncate(length: number): void {
    this.messages.length = Math.max(0, Math.min(length, this.messages.length));
  }

  clear(): void {
    this.messages = [];
  }
}
