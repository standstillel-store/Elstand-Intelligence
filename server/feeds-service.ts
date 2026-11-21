import type { Provenance } from '../src/data/provenance.js';
import type { CalendarFetch } from './calendar-shared.js';
import { fetchCalendar } from './financecalendar.js';
import { fetchReferenceRates, type ReferenceRates } from './frankfurter.js';
import { REFERENCE_BASE, REFERENCE_SOURCE_LINK, REFERENCE_SYMBOLS } from './macro-catalog.js';
import { DEFAULT_NEWS_LIMIT, fetchNews, type NewsFetch } from './marketaux.js';
import { formatIsoDate } from './parse.js';
import { readProvider } from './provider-registry.js';
import { SHOWMYTRADES_ENDPOINT, daysFor, fetchShowMyTrades, withinWindow } from './showmytrades.js';
import { asFallback, credentialOf, through, type Outcome, type ServiceDeps } from './service.js';
import { fetchXoomar } from './xoomar.js';

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

const calendarKey = (provider: string, days: CalendarDays): string =>
  `calendar:${provider}:${formatIsoDate(days.fromMs)}:${formatIsoDate(days.toMs)}`;

/** The primary source. Free, no key; asked for the fewest days that cover the window. */
export async function loadShowMyTrades(
  deps: ServiceDeps,
  days: CalendarDays,
): Promise<Outcome<CalendarFetch>> {
  const window = { fromMs: days.fromMs, toMs: days.toMs };
  const requestDays = daysFor(deps.now(), window);
  const outcome = await through<CalendarFetch>(deps, {
    provider: 'showmytrades',
    capability: 'economic-calendar',
    endpoint: SHOWMYTRADES_ENDPOINT,
    dataClass: 'calendar',
    // Pages asking for different days share the answer of the same step.
    cacheKey: `calendar:showmytrades:${requestDays}`,
    // A calendar has no "newest datum": its freshness is the age of the retrieval.
    isCurrent: () => true,
    dataAsOf: () => null,
    load: (ready) =>
      fetchShowMyTrades(
        httpOf(deps),
        { baseUrl: ready.baseUrl },
        requestDays,
        deps.runtime.validators,
      ),
  });
  return outcome.kind === 'data'
    ? { ...outcome, value: withinWindow(outcome.value, window) }
    : outcome;
}

/** The fallback. U.S. agency releases only, and never a forecast. */
export function loadXoomar(deps: ServiceDeps, days: CalendarDays): Promise<Outcome<CalendarFetch>> {
  return through<CalendarFetch>(deps, {
    provider: 'xoomar',
    capability: 'economic-calendar',
    endpoint: CALENDAR_ENDPOINT,
    dataClass: 'calendar',
    cacheKey: calendarKey('xoomar', days),
    isCurrent: () => true,
    dataAsOf: () => null,
    load: (ready) =>
      fetchXoomar(
        httpOf(deps),
        { baseUrl: ready.baseUrl, apiKey: ready.apiKey },
        { fromMs: days.fromMs, toMs: days.toMs },
        deps.runtime.validators,
      ),
  });
}

/** The optional legacy source. Asked only when its key is set, and only after the free ones. */
export function loadFinanceCalendar(
  deps: ServiceDeps,
  days: CalendarDays,
): Promise<Outcome<CalendarFetch>> {
  return through<CalendarFetch>(deps, {
    provider: 'financecalendar',
    capability: 'economic-calendar',
    endpoint: CALENDAR_ENDPOINT,
    dataClass: 'calendar',
    cacheKey: calendarKey('financecalendar', days),
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

/** `ERROR — Could not reach X.` becomes `X (ERROR): Could not reach X.` */
function reasonLine(provenance: Provenance): string {
  const message = provenance.message ?? provenance.state;
  const at = message.indexOf(' — ');
  const text = at === -1 ? message : message.slice(at + 3);
  return `${provenance.providerLabel} (${provenance.state}): ${text}`;
}

/** Every source was asked and none gave a current answer: the interface is told exactly that. */
function nobodyAnswered(reasons: readonly Provenance[]): Outcome<CalendarFetch> {
  const first = reasons[0];
  return {
    kind: 'withheld',
    provenance: {
      provider: 'showmytrades',
      providerLabel: first?.providerLabel ?? 'ShowMyTrades',
      capability: 'economic-calendar',
      endpoint: first?.endpoint ?? CALENDAR_ENDPOINT,
      state: 'UNAVAILABLE',
      retrievedAt: null,
      dataAsOf: null,
      cache: 'fresh',
      fallback: null,
      message: `UNAVAILABLE — No economic calendar source answered. ${reasons.map(reasonLine).join(' ')}`,
    },
    failure: null,
  };
}

/**
 * The economic calendar: ShowMyTrades, then XOOMAR when it cannot answer, then Finance Calendar
 * when its key is set. The first source that gives a current, validated answer wins, and the
 * answer says which source it is and, when it is not the primary, why the primary was passed over.
 *
 * A copy kept from an earlier answer (state CACHED or STALE) does not count as an answer for this
 * purpose: a source that can still be asked is preferred to it. Only when no source answers is the
 * best kept copy shown, still labelled as old. When there is none, the answer is UNAVAILABLE with
 * each source's reason, and no event is made up.
 */
export async function loadCalendar(
  deps: ServiceDeps,
  days: CalendarDays,
): Promise<Outcome<CalendarFetch>> {
  const sources: ((d: ServiceDeps, w: CalendarDays) => Promise<Outcome<CalendarFetch>>)[] = [
    loadShowMyTrades,
    loadXoomar,
  ];
  if (readProvider('financecalendar', deps.env).kind === 'ready') sources.push(loadFinanceCalendar);

  const unanswered: Provenance[] = [];
  let kept: Outcome<CalendarFetch> | null = null;
  for (const load of sources) {
    const outcome = await load(deps, days);
    if (outcome.kind === 'data' && outcome.provenance.cache !== 'stale-if-error') {
      // Every source that was passed over is named with its own reason, in the order asked.
      return unanswered.length === 0
        ? outcome
        : asFallback(outcome, 'showmytrades', unanswered.map(reasonLine).join(' '));
    }
    if (outcome.kind === 'data' && kept === null) kept = outcome;
    unanswered.push(outcome.provenance);
  }
  return kept ?? nobodyAnswered(unanswered);
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
