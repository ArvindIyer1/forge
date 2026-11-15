import type { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import type { Workspace } from "./workspace.js";
import type { ProposedFileChange } from "./file-changes.js";
import type { GitService } from "../git/git-service.js";

export type ApprovalDecision = "approved" | "rejected";

export interface ToolContext {
  workspace: Workspace;
  /** Git service availability is captured at startup; undefined permits lazy initialization in tests/embedders. */
  gitService?: GitService | null;
  gitServiceError?: string;
  signal?: AbortSignal;
  requestApproval?: (
    proposal: ProposedFileChange,
    signal?: AbortSignal,
  ) => Promise<ApprovalDecision>;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  execute(args: TArgs, context: ToolContext): Promise<unknown> | unknown;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  schema: z.ZodType;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolExecutionResult {
  callId: string;
  providerCallId?: string;
  name: string;
  ok: boolean;
  content: string;
}
