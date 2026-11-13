import { z } from "zod";

const environmentSchema = z.object({
  GEMINI_API_KEY: z.string().trim().min(1),
  GEMINI_MODEL: z.string().trim().min(1),
});

export interface AppConfig {
  apiKey: string;
  model: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const missingVariables = result.error.issues
      .map((issue) => issue.path[0])
      .filter((name): name is string => typeof name === "string");
    const uniqueNames = [...new Set(missingVariables)];

    throw new Error(
      `Missing required environment variable${uniqueNames.length === 1 ? "" : "s"}: ${uniqueNames.join(", ")}. ` +
        "Add them to your .env file. See .env.example for the expected format.",
    );
  }

  return {
    apiKey: result.data.GEMINI_API_KEY,
    model: result.data.GEMINI_MODEL,
  };
}
