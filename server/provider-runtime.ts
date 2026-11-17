import type { ProviderId } from '../src/core/provider-state.js';
import { createTtlCache, type CachePolicy, type Served, type TtlCache } from './cache.js';
import { ApiFailure } from './errors.js';
import {
  createRateLimiter,
  nextUtcMidnight,
  type BudgetRequest,
  type RateLimiter,
} from './limiter.js';
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry.js';

/**
 * What every provider request goes through, in this order: the cache (a fresh answer is reused,
 * identical requests in flight share one), the request budget (nothing is sent once it is
 * spent), bounded retry (only for failures worth repeating), and, if the provider still cannot
 * be asked, the last verified answer, reported as such.
 *
 * One runtime lives for the life of a server instance. Tests and the local server make their
 * own, so no state leaks between them.
 */

/**
 * The `ETag` a provider sent with an answer, kept with the answer it belongs to. Asking again
 * with that tag lets the provider say `304 Not Modified`, which costs it (and the budget kept for
 * it) almost nothing and confirms the held answer instead of replacing it. Held per server
 * instance, bounded, and never the only copy: the answer cache decides what may still be served.
 */
export interface Validated<T> {
  readonly etag: string;
  readonly value: T;
}

export interface ValidatorStore {
  get<T>(key: string): Validated<T> | undefined;
  set<T>(key: string, entry: Validated<T>): void;
}

const MAX_VALIDATORS = 64;

export function createValidatorStore(): ValidatorStore {
  const held = new Map<string, Validated<unknown>>();
  return {
    get<T>(key: string): Validated<T> | undefined {
      return held.get(key) as Validated<T> | undefined;
    },
    set<T>(key: string, entry: Validated<T>): void {
      held.delete(key);
      held.set(key, entry);
      // Bounded however many keys arrive: the oldest entry goes first.
      for (const oldest of held.keys()) {
        if (held.size <= MAX_VALIDATORS) break;
        held.delete(oldest);
      }
    },
  };
}

export interface ProviderRuntime {
  readonly cache: TtlCache;
  readonly limiter: RateLimiter;
  readonly sleep: (ms: number) => Promise<void>;
  readonly validators: ValidatorStore;
}

export function createProviderRuntime(cache: TtlCache = createTtlCache()): ProviderRuntime {
  return {
    cache,
    limiter: createRateLimiter(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    validators: createValidatorStore(),
  };
}

const defaultRuntime = createProviderRuntime();
const byCache = new WeakMap<TtlCache, ProviderRuntime>();

/** The runtime a handler uses: the one given, or one that wraps the cache it was given. */
export function runtimeFor(deps: {
  readonly runtime?: ProviderRuntime;
  readonly cache?: TtlCache;
}): ProviderRuntime {
  if (deps.runtime !== undefined) return deps.runtime;
  if (deps.cache === undefined) return defaultRuntime;
  let runtime = byCache.get(deps.cache);
  if (runtime === undefined) {
    runtime = createProviderRuntime(deps.cache);
    byCache.set(deps.cache, runtime);
  }
  return runtime;
}

export interface ServeSpec<T> {
  readonly provider: ProviderId;
  /** What is being asked, e.g. "series/observations"; also names the cache entry. */
  readonly endpoint: string;
  readonly cacheKey: string;
  readonly policy: CachePolicy;
  /** What one upstream attempt costs. The first entry must be the provider-level budget. */
  readonly budgets: readonly BudgetRequest[];
  readonly retry?: RetryPolicy;
  /** One upstream attempt, already parsed and validated. */
  readonly load: () => Promise<T>;
}

export interface RuntimeClock {
  readonly now: () => number;
}

const DEFAULT_BLOCK_SECONDS = 60;

export function serve<T>(
  runtime: ProviderRuntime,
  clock: RuntimeClock,
  spec: ServeSpec<T>,
): Promise<Served<T>> {
  const providerBudget = spec.budgets[0];
  return runtime.cache.getOrLoadDetailed(spec.cacheKey, spec.policy, clock.now(), () =>
    withRetry(
      async () => {
        const now = clock.now();
        const verdict = runtime.limiter.acquire(spec.budgets, now);
        if (verdict.outcome === 'denied') {
          throw new ApiFailure(
            'rate_limited',
            'The request budget kept for this provider is spent for now.',
            Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)),
            // `blocked` is the pause after the provider itself refused; the others are our own budget.
            {
              budget: verdict.scope === 'day' ? 'day' : 'minute',
              local: verdict.scope !== 'blocked',
            },
          );
        }
        try {
          return await spec.load();
        } catch (error) {
          if (error instanceof ApiFailure && error.code === 'rate_limited') {
            // The provider told us to stop. Everything for this provider waits, not just this call.
            const until =
              error.budget === 'day'
                ? nextUtcMidnight(now)
                : now + (error.retryAfterSeconds ?? DEFAULT_BLOCK_SECONDS) * 1000;
            if (providerBudget !== undefined) runtime.limiter.block(providerBudget.key, now, until);
          }
          throw error;
        }
      },
      spec.retry ?? DEFAULT_RETRY,
      { now: clock.now, sleep: runtime.sleep },
    ),
  );
}
