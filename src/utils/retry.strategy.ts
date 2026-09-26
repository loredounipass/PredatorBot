/**
 * Computes exponential backoff delay for retry attempts.
 *
 * Formula: delay(n) = baseDelayMs × 2^(attempt - 1)
 * Capped at maxDelayMs to prevent unbounded waits.
 *
 * @param attempt       - Current retry attempt number (1-indexed)
 * @param baseDelayMs   - Base delay in milliseconds (default: 500)
 * @param maxDelayMs    - Maximum delay cap in milliseconds (default: 30000)
 * @returns Computed delay in milliseconds
 */
export function computeExponentialBackoff(
  attempt: number,
  baseDelayMs: number = 500,
  maxDelayMs: number = 30_000
): number {
  const unboundedDelay = baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(unboundedDelay, maxDelayMs);
}

/**
 * Adds jitter to a delay value to prevent thundering herd on retries.
 * Applies ±25% random variance.
 *
 * @param delayMs - Base delay in milliseconds
 * @returns Jittered delay in milliseconds
 */
export function applyJitter(delayMs: number): number {
  const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
  return Math.floor(delayMs * jitterFactor);
}

/**
 * Convenience: computes backoff with jitter in one call.
 */
export function computeRetryDelay(
  attempt: number,
  baseDelayMs: number = 500,
  maxDelayMs: number = 30_000
): number {
  return applyJitter(computeExponentialBackoff(attempt, baseDelayMs, maxDelayMs));
}
