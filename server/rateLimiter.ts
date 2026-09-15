/**
 * Модуль обработки вызовов с защитой от Rate Limit (429) и тайм-аутов.
 * Предоставляет безопасное выполнение асинхронных запросов к биржам и AI API.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryOnStatusCodes?: number[];
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffFactor: 2.0,
  retryOnStatusCodes: [429, 500, 502, 503, 504]
};

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  taskName: string = 'ApiTask',
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let attempt = 0;
  let delay = opts.initialDelayMs!;

  while (attempt < opts.maxRetries!) {
    try {
      attempt++;
      return await fn();
    } catch (err: any) {
      const statusCode = err?.status || err?.response?.status || err?.code;
      const isRateLimit = statusCode === 429 || (err?.message && err.message.includes('429'));
      const isNetworkError = err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.message?.includes('fetch failed');

      if (attempt >= opts.maxRetries! || (!isRateLimit && !isNetworkError && !opts.retryOnStatusCodes!.includes(statusCode))) {
        throw err;
      }

      const jitter = Math.random() * 200;
      const currentDelay = Math.min(opts.maxDelayMs!, delay + jitter);

      console.warn(`[RATE LIMITER] Attempt ${attempt}/${opts.maxRetries} for '${taskName}' failed (${err?.message || err}). Retrying in ${Math.round(currentDelay)}ms...`);
      await new Promise(r => setTimeout(r, currentDelay));
      delay *= opts.backoffFactor!;
    }
  }

  throw new Error(`[RATE LIMITER] Task '${taskName}' failed after ${opts.maxRetries} retries.`);
}
