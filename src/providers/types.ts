export type ProviderId = "gemini" | "groq";

export interface ToolCall {
  /** FORGE's unique identifier for correlating execution results. */
  id: string;
  /** Original provider call ID, when that provider supplied one. */
  providerCallId?: string;
  /** Opaque adapter-owned data needed to continue provider history. */
  providerMetadata?: unknown;
  name: string;
  arguments: unknown;
  argumentError?: string;
  rawArguments?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; providerCallId?: string; name: string; content: string };

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "turn_complete"; toolCalls: ToolCall[] };

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  streamTurn(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
  formatError(error: unknown): string;
}
