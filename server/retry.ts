import { ApiFailure } from './errors.js';

/**
 * Bounded retry with exponential backoff and jitter.
 *
 * Only a failure that says it is worth repeating is repeated: a 5xx, a timeout, a dropped
 * connection. A rejected credential, a rate limit and an exhausted quota are never retried,
 * because repeating them cannot help and can cost quota. A `Retry-After` the provider sent is
 * honoured, and if it asks for longer than the policy allows, the failure is returned at once.
 *
 * Nothing in the product may be random (scripts/lint-policy.ts), so the jitter comes from a
 * small deterministic generator seeded from the clock. That spreads retries from different
 * instances apart just as well, which is all jitter is for.
 */

export interface RetryPolicy {
  /** Total tries, including the first. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 2, baseDelayMs: 250, maxDelayMs: 2_000 };

export interface RetryDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** mulberry32: a small, fast generator with good spread. Returns a function giving [0, 1). */
export function seededUnit(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The wait before retry number `retry` (1 for the first retry), or null when it must not retry. */
export function backoffDelay(
  failure: ApiFailure,
  retry: number,
  policy: RetryPolicy,
  unit: () => number,
): number | null {
  if (!failure.retryable) return null;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  const jitter = Math.floor(unit() * policy.baseDelayMs);
  const own = Math.min(policy.maxDelayMs, exponential + jitter);
  if (failure.retryAfterSeconds === null) return own;
  const asked = failure.retryAfterSeconds * 1000;
  return asked > policy.maxDelayMs ? null : Math.max(own, asked);
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  const unit = seededUnit(deps.now());
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!(error instanceof ApiFailure) || attempt >= policy.attempts) throw error;
      const delay = backoffDelay(error, attempt, policy, unit);
      if (delay === null) throw error;
      await deps.sleep(delay);
    }
  }
}
