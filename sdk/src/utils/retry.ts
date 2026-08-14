// =============================================================================
// @stacks-shield/sdk -- retry with exponential backoff
// =============================================================================
// Applies to API calls, relayer calls and authentication. 3 attempts by
// default with exponential backoff. Only retries transient failures; a caller
// can opt out per-error via `shouldRetry`.

export interface RetryOptions {
  retries?: number; // default 3
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 8000
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const retry = async <T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> => {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error, attempt)) break;
      const delay = Math.min(max, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
      await sleep(delay);
    }
  }
  throw lastError;
};
