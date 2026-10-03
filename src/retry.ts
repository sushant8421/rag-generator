/**
 * Retries transient failures (network errors, 429, 5xx) with exponential backoff.
 * Anything else (bad request, auth) fails immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return err.message.includes("fetch failed") || err.name === "AbortError";
}
