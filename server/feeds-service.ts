import { fetchCalendar, type CalendarFetch } from './financecalendar.js';
import { fetchReferenceRates, type ReferenceRates } from './frankfurter.js';
import { REFERENCE_BASE, REFERENCE_SOURCE_LINK, REFERENCE_SYMBOLS } from './macro-catalog.js';
import { DEFAULT_NEWS_LIMIT, fetchNews, type NewsFetch } from './marketaux.js';
import { formatIsoDate } from './parse.js';
import { credentialOf, through, type Outcome, type ServiceDeps } from './service.js';

/**
 * The economic calendar, the news feed and the reference exchange rates.
 *
 * Each is one request through the shared path. Their answers say what they contain and what they
 * left out (`excluded`, `total`, `found`), so a short list is never mistaken for a quiet day:
 * the free news plan returns a few articles per request, and the calendar can be longer than one
 * answer holds. Nothing is added to fill a gap.
 */

export const NEWS_ATTRIBUTION = { name: 'Marketaux', url: 'https://www.marketaux.com' } as const;

export const RATES_ATTRIBUTION = {
  name: 'Frankfurter, European Central Bank reference rates',
  url: REFERENCE_SOURCE_LINK,
} as const;

export const CALENDAR_ENDPOINT = 'calendar';
export const NEWS_ENDPOINT = 'news/all';
export const RATES_ENDPOINT = 'latest';

const DAY_MS = 86_400_000;

/** News older than this is not asked for. Published times are kept as the provider gives them. */
export const NEWS_WINDOW_MS = 3 * DAY_MS;

/**
 * A reference rate is one fixing per ECB working day, so across a weekend or a holiday the
 * newest datum is days old without anything being wrong. Beyond this it is STALE.
 */
export const RATES_FRESH_MS = 5 * DAY_MS;

const httpOf = (deps: ServiceDeps): { fetch: typeof fetch; now: () => number } => ({
  fetch: deps.fetch,
  now: deps.now,
});

/** The window the calendar is asked for by default: today and the next seven days, in UTC. */
export const DEFAULT_CALENDAR_DAYS = 7;

export function dayStart(timeMs: number): number {
  return Math.floor(timeMs / DAY_MS) * DAY_MS;
}

export function defaultCalendarDays(now: number): CalendarDays {
  const fromMs = dayStart(now);
  return { fromMs, toMs: fromMs + DEFAULT_CALENDAR_DAYS * DAY_MS };
}

export interface CalendarDays {
  /** 00:00 UTC of the first day. */
  readonly fromMs: number;
  /** 00:00 UTC of the last day, which is included. */
  readonly toMs: number;
}

export function loadCalendar(
  deps: ServiceDeps,
  days: CalendarDays,
): Promise<Outcome<CalendarFetch>> {
  return through<CalendarFetch>(deps, {
    provider: 'financecalendar',
    capability: 'economic-calendar',
    endpoint: CALENDAR_ENDPOINT,
    dataClass: 'calendar',
    cacheKey: `calendar:${formatIsoDate(days.fromMs)}:${formatIsoDate(days.toMs)}`,
    // A calendar has no "newest datum": its freshness is the age of the retrieval.
    isCurrent: () => true,
    dataAsOf: () => null,
    load: (ready) =>
      fetchCalendar(
        httpOf(deps),
        { baseUrl: ready.baseUrl, apiKey: credentialOf(ready) },
        { fromMs: days.fromMs, toMs: days.toMs },
      ),
  });
}

export function loadNews(deps: ServiceDeps): Promise<Outcome<NewsFetch>> {
  return through<NewsFetch>(deps, {
    provider: 'marketaux',
    capability: 'financial-news',
    endpoint: NEWS_ENDPOINT,
    dataClass: 'news',
    cacheKey: 'news:latest',
    // Every article carries its own publication time; a quiet weekend is not a stale feed.
    isCurrent: () => true,
    dataAsOf: (news) => news.items[0]?.publishedAt ?? null,
    load: (ready) =>
      fetchNews(
        httpOf(deps),
        { baseUrl: ready.baseUrl, apiKey: credentialOf(ready) },
        { sinceMs: deps.now() - NEWS_WINDOW_MS, limit: DEFAULT_NEWS_LIMIT },
      ),
  });
}

export function loadRates(deps: ServiceDeps): Promise<Outcome<ReferenceRates>> {
  return through<ReferenceRates>(deps, {
    provider: 'frankfurter',
    capability: 'reference-rates',
    endpoint: RATES_ENDPOINT,
    dataClass: 'reference-rates',
    cacheKey: `rates:${REFERENCE_BASE}`,
    datumFreshMs: RATES_FRESH_MS,
    datumFreshText: '5 days',
    dataAsOf: (rates) => rates.date,
    load: (ready) =>
      fetchReferenceRates(
        httpOf(deps),
        { baseUrl: ready.baseUrl },
        REFERENCE_BASE,
        REFERENCE_SYMBOLS,
      ),
  });
}
