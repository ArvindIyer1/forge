import { GitService } from "../git/git-service.js";
import type { ToolContext } from "./types.js";

export async function getGitService(context: ToolContext): Promise<GitService | null> {
  if (context.gitServiceError) throw new Error(context.gitServiceError);
  if (context.gitService !== undefined) return context.gitService;
  return GitService.create(context.workspace);
}

export async function requireGitService(context: ToolContext): Promise<GitService> {
  const service = await getGitService(context);
  if (!service) throw new Error("This workspace is not a Git repository.");
  return service;
}
