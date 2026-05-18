/**
 * Rate limit retry utility for OpenAI-compatible API calls.
 * Extracts retry-after timing from response headers when available,
 * falls back to exponential backoff.
 */

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export async function retryOnRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isRateLimit = error instanceof Error && 'status' in error && (error as { status: number }).status === 429;
      if (!isRateLimit || attempt === MAX_RETRIES - 1) throw error;
      const retryAfterMs = extractRetryAfterMs(error) ?? BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`Rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(retryAfterMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }
  throw new Error('retryOnRateLimit: unreachable');
}

function extractRetryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: Record<string, string> }).headers;
  if (!headers) return null;
  const retryAfterMs = headers['retry-after-ms'];
  if (retryAfterMs) {
    const parsed = parseInt(retryAfterMs, 10);
    if (Number.isFinite(parsed)) return parsed + 500;
  }
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const parsed = parseFloat(retryAfter);
    if (Number.isFinite(parsed)) return parsed * 1000 + 500;
  }
  return null;
}
