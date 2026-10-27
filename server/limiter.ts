/**
 * Request budgets for providers.
 *
 * Provider plans meter requests (or credits), and a request refused for being over budget
 * still counts against some plans, so Elstand keeps its own budget and does not ask once it is
 * spent. A budget has a per-minute limit, measured over any sliding sixty seconds (never a
 * burst at a window edge), and a per-day limit that resets at 00:00 UTC.
 *
 * The state lives in one server instance. On a platform that runs several instances, each
 * has its own count, and the CDN cache (`s-maxage` on every response) is what shares results
 * between them. docs/ENVIRONMENT.md says what that means for choosing a refresh interval.
 */

export interface BudgetSpec {
  /** Credits per sliding minute, or null for no per-minute limit. */
  readonly perMinute: number | null;
  /** Credits per UTC day, or null for no per-day limit. */
  readonly perDay: number | null;
}

export interface BudgetRequest {
  /** What is metered: a provider id, or `provider:endpoint`. */
  readonly key: string;
  readonly budget: BudgetSpec;
  readonly cost: number;
}

export type Acquisition =
  | { readonly outcome: 'granted' }
  | {
      readonly outcome: 'denied';
      readonly retryAfterMs: number;
      /** `blocked` means the provider itself said to stop. */
      readonly scope: 'minute' | 'day' | 'blocked';
    };

export interface BudgetUsage {
  readonly minuteUsed: number;
  readonly dayUsed: number;
  readonly blockedUntil: number | null;
}

export interface RateLimiter {
  /** Takes the credits for every request, or none of them: all-or-nothing. */
  acquire(requests: readonly BudgetRequest[], now: number): Acquisition;
  /** The provider said to stop (a rate limit, an exhausted quota): ask nothing until `until`. */
  block(key: string, now: number, until: number): void;
  usage(key: string, now: number): BudgetUsage;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

interface Meter {
  events: { at: number; cost: number }[];
  day: number;
  dayUsed: number;
  blockedUntil: number | null;
}

export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

export function createRateLimiter(): RateLimiter {
  const meters = new Map<string, Meter>();

  function meterFor(key: string, now: number): Meter {
    let meter = meters.get(key);
    if (meter === undefined) {
      meter = { events: [], day: Math.floor(now / DAY_MS), dayUsed: 0, blockedUntil: null };
      meters.set(key, meter);
    }
    const today = Math.floor(now / DAY_MS);
    if (meter.day !== today) {
      meter.day = today;
      meter.dayUsed = 0;
    }
    meter.events = meter.events.filter((event) => event.at > now - MINUTE_MS);
    if (meter.blockedUntil !== null && meter.blockedUntil <= now) meter.blockedUntil = null;
    return meter;
  }

  function check(request: BudgetRequest, now: number): Acquisition {
    const meter = meterFor(request.key, now);
    if (meter.blockedUntil !== null) {
      return { outcome: 'denied', retryAfterMs: meter.blockedUntil - now, scope: 'blocked' };
    }
    const { perMinute, perDay } = request.budget;
    if (perDay !== null && meter.dayUsed + request.cost > perDay) {
      return { outcome: 'denied', retryAfterMs: nextUtcMidnight(now) - now, scope: 'day' };
    }
    if (perMinute !== null) {
      const used = meter.events.reduce((sum, event) => sum + event.cost, 0);
      if (used + request.cost > perMinute) {
        // Wait until enough of the oldest requests have left the sliding minute.
        let remaining = used;
        let waitUntil = now + MINUTE_MS;
        for (const event of meter.events) {
          remaining -= event.cost;
          waitUntil = event.at + MINUTE_MS;
          if (remaining + request.cost <= perMinute) break;
        }
        return { outcome: 'denied', retryAfterMs: Math.max(1, waitUntil - now), scope: 'minute' };
      }
    }
    return { outcome: 'granted' };
  }

  return {
    acquire(requests, now) {
      for (const request of requests) {
        const verdict = check(request, now);
        if (verdict.outcome === 'denied') return verdict;
      }
      for (const request of requests) {
        const meter = meterFor(request.key, now);
        meter.events.push({ at: now, cost: request.cost });
        meter.dayUsed += request.cost;
      }
      return { outcome: 'granted' };
    },
    block(key, now, until) {
      const meter = meterFor(key, now);
      meter.blockedUntil = Math.max(meter.blockedUntil ?? 0, until);
    },
    usage(key, now) {
      const meter = meterFor(key, now);
      return {
        minuteUsed: meter.events.reduce((sum, event) => sum + event.cost, 0),
        dayUsed: meter.dayUsed,
        blockedUntil: meter.blockedUntil,
      };
    },
  };
}
