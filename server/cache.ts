import { ApiFailure } from './errors.js';

/**
 * A small in-memory cache with request coalescing, in front of the providers.
 *
 * Provider plans meter requests, so identical concurrent requests share one upstream call and
 * a result is reused for its lifetime. Failures are not kept, except those that mean "stop
 * asking for a while": a rate limit and a rejected key. Without that, every poll from every
 * visitor would hit the provider again.
 *
 * `getOrLoadDetailed` adds stale-if-error. When the provider cannot be asked (it is down, it
 * refused, Elstand's own budget for it is spent), the last verified answer is served instead,
 * for as long as the caller allows, and it is reported as such: the caller gets the time the
 * answer was really retrieved and why the provider was not asked, so it can be labelled CACHED
 * rather than passed off as fresh.
 *
 * This only helps within one warm server instance; the `Cache-Control` headers set by the
 * handlers let a CDN share results across instances.
 */

export interface CachePolicy {
  readonly ttlMs: number;
  /** How long after expiry the value may still be served when the provider cannot be asked. */
  readonly staleIfErrorMs: number;
}

export type CacheOrigin = 'fresh' | 'cache' | 'stale-if-error';

export interface Served<T> {
  readonly value: T;
  /** When the provider actually answered (epoch ms), which is not when this call was made. */
  readonly retrievedAt: number;
  readonly origin: CacheOrigin;
  /** Why the provider was not asked, when `origin` is `stale-if-error`. */
  readonly failure: ApiFailure | null;
}

export interface TtlCache {
  getOrLoad<T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T>;
  getOrLoadDetailed<T>(
    key: string,
    policy: CachePolicy,
    now: number,
    load: () => Promise<T>,
  ): Promise<Served<T>>;
}

export const FAILURE_MEMORY_MS: Readonly<Record<string, number>> = {
  rate_limited: 15_000,
  provider_auth: 60_000,
};

/** A provider's own `Retry-After` is honoured, within sane bounds. */
const MIN_MEMORY_MS = 1_000;
const MAX_MEMORY_MS = 3_600_000;

const MAX_ENTRIES = 256;

interface Stored {
  readonly value: unknown;
  readonly retrievedAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
}

interface Remembered {
  readonly failure: ApiFailure;
  readonly until: number;
}

function memoryFor(failure: ApiFailure): number | null {
  const base = FAILURE_MEMORY_MS[failure.code];
  if (base === undefined) return null;
  if (failure.retryAfterSeconds === null) return base;
  return Math.min(MAX_MEMORY_MS, Math.max(MIN_MEMORY_MS, failure.retryAfterSeconds * 1000));
}

export function createTtlCache(): TtlCache {
  const values = new Map<string, Stored>();
  const failures = new Map<string, Remembered>();
  const inFlight = new Map<string, Promise<unknown>>();

  function sweep(now: number): void {
    if (values.size >= MAX_ENTRIES) {
      for (const [key, stored] of values) if (stored.staleUntil <= now) values.delete(key);
      // Still full: drop the oldest entries, so memory stays bounded however many keys arrive.
      for (const key of values.keys()) {
        if (values.size < MAX_ENTRIES) break;
        values.delete(key);
      }
    }
    for (const [key, remembered] of failures) if (remembered.until <= now) failures.delete(key);
  }

  function detailed<T>(
    key: string,
    policy: CachePolicy,
    now: number,
    load: () => Promise<T>,
  ): Promise<Served<T>> {
    const stored = values.get(key);
    if (stored !== undefined && stored.expiresAt > now) {
      return Promise.resolve({
        value: stored.value as T,
        retrievedAt: stored.retrievedAt,
        origin: 'cache',
        failure: null,
      });
    }

    const stale = (failure: ApiFailure): Served<T> | null =>
      stored !== undefined && stored.staleUntil > now && failure.code !== 'bad_request'
        ? {
            value: stored.value as T,
            retrievedAt: stored.retrievedAt,
            origin: 'stale-if-error',
            failure,
          }
        : null;

    const remembered = failures.get(key);
    if (remembered !== undefined && remembered.until > now) {
      const served = stale(remembered.failure);
      return served === null ? Promise.reject(remembered.failure) : Promise.resolve(served);
    }

    const pending = inFlight.get(key);
    if (pending !== undefined) return pending as Promise<Served<T>>;

    const promise: Promise<Served<T>> = load().then(
      (value) => {
        sweep(now);
        failures.delete(key);
        values.set(key, {
          value,
          retrievedAt: now,
          expiresAt: now + policy.ttlMs,
          staleUntil: now + policy.ttlMs + policy.staleIfErrorMs,
        });
        return { value, retrievedAt: now, origin: 'fresh', failure: null } as Served<T>;
      },
      (error: unknown) => {
        if (error instanceof ApiFailure) {
          const memory = memoryFor(error);
          if (memory !== null) failures.set(key, { failure: error, until: now + memory });
          const served = stale(error);
          if (served !== null) return served;
        }
        throw error;
      },
    );
    const tracked = promise.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  }

  return {
    getOrLoadDetailed: detailed,
    // The original contract: no stale serving, just the value.
    getOrLoad<T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> {
      return detailed(key, { ttlMs, staleIfErrorMs: 0 }, now, load).then((served) => served.value);
    },
  };
}
