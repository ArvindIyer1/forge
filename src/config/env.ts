import { z } from "zod";
import type { ProviderId } from "../providers/types.js";

export interface AppConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
}

const providerSchema = z.enum(["gemini", "groq"]);
const requiredValue = z.string().trim().min(1);

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerValue = environment.MODEL_PROVIDER ?? "gemini";
  const providerResult = providerSchema.safeParse(providerValue.trim());

  if (!providerResult.success) {
    throw new Error('Invalid MODEL_PROVIDER. Choose "gemini" or "groq".');
  }

  const provider = providerResult.data;
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY";
  const modelName = provider === "gemini" ? "GEMINI_MODEL" : "GROQ_MODEL";
  const values = z
    .object({ apiKey: requiredValue, model: requiredValue })
    .safeParse({ apiKey: environment[keyName], model: environment[modelName] });

  if (!values.success) {
    const missingNames = values.error.issues.map((issue) =>
      issue.path[0] === "apiKey" ? keyName : modelName,
    );
    const uniqueNames = [...new Set(missingNames)];
    throw new Error(
      `Missing required environment variable${uniqueNames.length === 1 ? "" : "s"}: ${uniqueNames.join(", ")}. ` +
        "Add the selected provider's settings to your .env file. See .env.example.",
    );
  }

  return { provider, ...values.data };
}
