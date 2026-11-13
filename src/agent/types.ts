import type { ToolCall } from "../providers/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { ApprovalDecision } from "../tools/types.js";
import type { ProposedFileChange } from "../tools/file-changes.js";

export interface AgentCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  requestApproval?: (proposal: ProposedFileChange, signal?: AbortSignal) => Promise<ApprovalDecision>;
}

export interface AgentOptions {
  maxIterations?: number;
  maxToolCallsPerTask?: number;
  maxToolCallsPerResponse?: number;
}

export interface AgentResult {
  status: "completed" | "iteration_limit";
  finalText: string;
  iterations: number;
  toolCalls: number;
}

export type ToolCallHandler = (call: ToolCall) => Promise<ToolExecutionResult>;
