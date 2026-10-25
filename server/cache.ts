import { ApiFailure } from './errors.js';

/**
 * A small in-memory cache with request coalescing, in front of the provider.
 *
 * Provider plans meter requests, so identical concurrent requests share one upstream call and
 * a result is reused for its lifetime. Failures are not kept, except those that mean "stop
 * asking for a while": a rate limit and a rejected key. Without that, every poll from every
 * visitor would hit the provider again.
 *
 * This only helps within one warm server instance; the `Cache-Control` headers set by the
 * handlers let a CDN share results across instances.
 */

export interface TtlCache {
  getOrLoad<T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T>;
}

export const FAILURE_MEMORY_MS: Readonly<Record<string, number>> = {
  rate_limited: 15_000,
  provider_auth: 60_000,
};

const MAX_ENTRIES = 256;

interface Hit {
  readonly value?: unknown;
  readonly failure?: ApiFailure;
  readonly expiresAt: number;
}

export function createTtlCache(): TtlCache {
  const settled = new Map<string, Hit>();
  const inFlight = new Map<string, Promise<unknown>>();

  function sweep(now: number): void {
    if (settled.size < MAX_ENTRIES) return;
    for (const [key, hit] of settled) if (hit.expiresAt <= now) settled.delete(key);
  }

  return {
    getOrLoad<T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> {
      const hit = settled.get(key);
      if (hit !== undefined && hit.expiresAt > now) {
        return hit.failure !== undefined
          ? Promise.reject(hit.failure)
          : Promise.resolve(hit.value as T);
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending as Promise<T>;

      const promise = load().then(
        (value) => {
          sweep(now);
          settled.set(key, { value, expiresAt: now + ttlMs });
          return value;
        },
        (error: unknown) => {
          if (error instanceof ApiFailure) {
            const memory = FAILURE_MEMORY_MS[error.code];
            if (memory !== undefined) settled.set(key, { failure: error, expiresAt: now + memory });
          }
          throw error;
        },
      );
      const tracked = promise.finally(() => inFlight.delete(key));
      inFlight.set(key, tracked);
      return tracked;
    },
  };
}
