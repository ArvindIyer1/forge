export interface ProviderErrorDetails {
  message: string;
  status?: number;
  code?: string;
}

export function getErrorDetails(error: unknown): ProviderErrorDetails {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }

  const candidate = error as { message?: unknown; status?: unknown; code?: unknown };
  return {
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
  };
}

export function isNetworkError(details: ProviderErrorDetails): boolean {
  const message = details.message.toLowerCase();
  return (
    details.code?.startsWith("ECONN") === true ||
    details.code === "ENOTFOUND" ||
    details.code === "ETIMEDOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out")
  );
}

export function redact(message: string, secret: string): string {
  return message.split(secret).join("[redacted]") || "unknown error";
}
