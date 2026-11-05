import { STALE_AFTER_MS, readBoundedInteger, readRefreshCadence, type Env } from './env.js';
import type { CachePolicy } from './cache.js';

/**
 * How long each kind of data is kept, and why.
 *
 * Every provider plan meters requests, so a result is reused for as long as the data can be
 * trusted not to have changed in a way that matters. A slow macro series is read a few times a
 * day; a quote follows the refresh cadence. Historical bars and macro series have their own
 * lifetimes and their own cache entries, so a slow series is never re-requested at the pace of
 * an intraday chart.
 *
 *  - `ttlMs`: how long a result is served without asking the provider again. It is also the
 *    `s-maxage` of the response, so a CDN shares the result between server instances.
 *  - `staleIfErrorMs`: how long past that a result may still be served, labelled CACHED or
 *    STALE, when the provider cannot be asked.
 *  - `freshWindowMs`: how old a result may be and still be called CACHED. Older is STALE.
 *
 * Four lifetimes can be changed with optional variables (documented in docs/ENVIRONMENT.md).
 * They only change how often a provider is asked, never what is shown.
 */

export const DATA_CLASSES = [
  'quote',
  'candles-intraday',
  'candles-daily',
  'calendar',
  'news',
  'macro-series',
  'reference-rates',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const ENV_TTL_NEWS = 'ELSTAND_TTL_NEWS_SECONDS';
export const ENV_TTL_CALENDAR = 'ELSTAND_TTL_CALENDAR_SECONDS';
export const ENV_TTL_MACRO = 'ELSTAND_TTL_MACRO_SECONDS';
export const ENV_TTL_RATES = 'ELSTAND_TTL_RATES_SECONDS';

export interface ClassPolicy extends CachePolicy {
  readonly freshWindowMs: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Seconds, with the range an override is clamped to. */
interface Tunable {
  readonly variable: string;
  readonly defaultSeconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

const TUNABLE: Readonly<Partial<Record<DataClass, Tunable>>> = {
  news: { variable: ENV_TTL_NEWS, defaultSeconds: 1_800, minSeconds: 300, maxSeconds: 86_400 },
  calendar: {
    variable: ENV_TTL_CALENDAR,
    defaultSeconds: 900,
    minSeconds: 300,
    maxSeconds: 86_400,
  },
  'macro-series': {
    variable: ENV_TTL_MACRO,
    defaultSeconds: 21_600,
    minSeconds: 900,
    maxSeconds: 604_800,
  },
  'reference-rates': {
    variable: ENV_TTL_RATES,
    defaultSeconds: 3_600,
    minSeconds: 900,
    maxSeconds: 604_800,
  },
};

/** The tunable variables, for documentation and for the check that ties docs to code. */
export const TTL_VARIABLES: readonly string[] = Object.values(TUNABLE).map(
  (entry) => entry.variable,
);

function ttlSeconds(env: Env, dataClass: DataClass): number {
  const tunable = TUNABLE[dataClass];
  if (tunable === undefined) return 0;
  return readBoundedInteger(
    env[tunable.variable],
    tunable.defaultSeconds,
    tunable.minSeconds,
    tunable.maxSeconds,
  );
}

/** The daily bar only changes once a day, so it is not re-read at the intraday pace. */
const DAILY_CANDLES_MIN_TTL_SECONDS = 900;

export function policyFor(env: Env, dataClass: DataClass): ClassPolicy {
  const refresh = readRefreshCadence(env);
  switch (dataClass) {
    case 'quote':
      return {
        ttlMs: refresh * 1000,
        staleIfErrorMs: 30 * MINUTE,
        freshWindowMs: STALE_AFTER_MS.delayed,
      };
    case 'candles-intraday':
      return {
        ttlMs: refresh * 1000,
        staleIfErrorMs: 30 * MINUTE,
        freshWindowMs: STALE_AFTER_MS.delayed,
      };
    case 'candles-daily':
      return {
        ttlMs: Math.max(refresh, DAILY_CANDLES_MIN_TTL_SECONDS) * 1000,
        staleIfErrorMs: 6 * HOUR,
        freshWindowMs: 6 * HOUR,
      };
    case 'calendar':
      return {
        ttlMs: ttlSeconds(env, dataClass) * 1000,
        staleIfErrorMs: DAY,
        freshWindowMs: 2 * HOUR,
      };
    case 'news':
      return {
        ttlMs: ttlSeconds(env, dataClass) * 1000,
        staleIfErrorMs: DAY,
        freshWindowMs: 6 * HOUR,
      };
    case 'macro-series':
      return {
        ttlMs: ttlSeconds(env, dataClass) * 1000,
        staleIfErrorMs: 7 * DAY,
        freshWindowMs: DAY,
      };
    case 'reference-rates':
      return {
        ttlMs: ttlSeconds(env, dataClass) * 1000,
        staleIfErrorMs: 3 * DAY,
        freshWindowMs: DAY,
      };
  }
}

/** The `Cache-Control` for a response that may be shared by a CDN for `ttlMs`. */
export function sharedCacheControl(ttlMs: number): string {
  return `public, max-age=0, s-maxage=${Math.max(1, Math.floor(ttlMs / 1000))}`;
}
