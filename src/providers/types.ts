export type ProviderId = "gemini" | "groq";

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  stream(messages: readonly ChatMessage[]): AsyncIterable<string>;
  formatError(error: unknown): string;
}
