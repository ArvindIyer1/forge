import type { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import type { Workspace } from "./workspace.js";

export interface ToolContext {
  workspace: Workspace;
  signal?: AbortSignal;
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
