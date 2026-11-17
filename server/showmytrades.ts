import { formatProviderTime } from '../src/core/provider-state.js';
import type {
  CalendarEvent,
  EventConfidence,
  EventStatus,
  ImpactLevel,
} from '../src/data/macro.js';
import {
  NO_QUOTA,
  figureText,
  restamped,
  surpriseBetween,
  uniqueSorted,
  type CalendarAttribution,
  type CalendarFetch,
  type CalendarWindow,
  type ExcludedEvent,
} from './calendar-shared.js';
import { ApiFailure } from './errors.js';
import {
  DAY_MS,
  EARLIEST_PLAUSIBLE_MS,
  cleanLabel,
  invalidData,
  isRecord,
  parseZonedInstant,
  safeHttpsUrl,
} from './parse.js';
import { callProvider, isEntityTag, type HttpDeps } from './provider-http.js';
import type { ValidatorStore } from './provider-runtime.js';

/**
 * ShowMyTrades economic calendar (https://showmytrades.com/docs/api/economic-calendar), the
 * primary source. It is free and needs no key.
 *
 *   GET calendar/v1?days=N&impact=high,medium,low
 *   -> { server_time, generated_at, from, to, count, events: [ { ts, time, currency, impact,
 *        title, forecast, previous, actual, id, status, moved_from, period, confidence } ],
 *        attribution: { text, url }, docs }
 *
 * How the request is shaped, and why:
 *  - The window is relative: it opens 6 hours before the request and spans `days` days (1 to 30).
 *    A request for a given calendar day is therefore translated into the fewest days that cover
 *    it, rounded up to a few fixed steps (`DAY_STEPS`), so that pages asking for different days
 *    share one cached answer instead of each costing a request. The answer is then cut back to
 *    the window that was asked for (`withinWindow`), and what the window leaves out is said aloud.
 *  - Market holidays are not requested (`impact=high,medium,low`): they are not releases, and
 *    they are timed at the start of a day.
 *  - The answer's `ETag` is kept with it, so a later request can ask "has it changed?" and
 *    receive a 304 instead of the whole body.
 *
 * What is and is not taken from the answer:
 *  - An event is kept only when its id, title, currency (one of the nine the provider covers),
 *    impact rating and time are present and well formed, and `ts` and `time` name the same instant.
 *    Anything else is excluded with its reason, never repaired.
 *  - Impact is the provider's own rating and is attributed to it. `confidence` is the provider's
 *    own statement of how well its sources agree.
 *  - The provider's statuses map onto Elstand's: scheduled, moved (rescheduled), tentative
 *    (estimated). `moved_from` is kept as the instant the event was first scheduled for.
 *  - A figure the provider left empty is null. Forecast and actual are shown as written, and a
 *    surprise exists only when both are plain numbers in the same written unit.
 *  - The API has no country field, so the country is null.
 *  - The provider's credit line is kept and shown with every answer. Its terms forbid reselling
 *    the calendar on its own or exposing it as a public calendar API; docs/ENVIRONMENT.md says
 *    what that means for a public deployment.
 */

export const SHOWMYTRADES_LABEL = 'ShowMyTrades';
export const SHOWMYTRADES_ENDPOINT = 'calendar/v1';
export const SHOWMYTRADES_HOST = 'showmytrades.com';

export const SHOWMYTRADES_ATTRIBUTION: CalendarAttribution = {
  name: 'Economic calendar by ShowMyTrades',
  url: 'https://showmytrades.com/tools/economic-calendar',
};

export const SHOWMYTRADES_IMPACT_SCHEME = 'ShowMyTrades impact rating';

/** The currencies the provider documents. */
const CURRENCIES: readonly string[] = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNY'];

const IMPACTS: Readonly<Record<string, ImpactLevel>> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const STATUSES: Readonly<Record<string, EventStatus>> = {
  scheduled: 'scheduled',
  moved: 'rescheduled',
  tentative: 'estimated',
  cancelled: 'cancelled',
};

const CONFIDENCES: readonly EventConfidence[] = [
  'official',
  'sources_agree',
  'single_source',
  'sources_disagree',
];

/** The provider's ids are slugs with a date: `usd-nonfarm-payrolls.20260107T1330`. */
const EVENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;

/** The window opens this long before the request. */
export const LOOK_BACK_MS = 6 * 3_600_000;
export const MAX_DAYS = 30;
/** The `days` values that are ever requested, so that cached answers are shared. */
export const DAY_STEPS: readonly number[] = [2, 8, 15, 30];

const SURPRISE_BASIS = 'actual minus forecast, both as published by ShowMyTrades';
const LATEST_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

export const SHOWMYTRADES_COVERAGE_NOTE =
  'ShowMyTrades covers USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF and CNY events rated high, medium or low. Market holidays are not requested.';

/** The fewest `days` (one of `DAY_STEPS`) whose window, opened at `nowMs`, reaches the end of `window`. */
export function daysFor(nowMs: number, window: CalendarWindow): number {
  const needed = Math.ceil((window.toMs + DAY_MS - (nowMs - LOOK_BACK_MS)) / DAY_MS);
  return DAY_STEPS.find((days) => days >= needed) ?? MAX_DAYS;
}

type EventParse =
  | { readonly kind: 'event'; readonly event: CalendarEvent }
  | { readonly kind: 'excluded'; readonly excluded: ExcludedEvent };

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseEvent(row: unknown, index: number, retrievedAt: number): EventParse {
  const exclude = (id: string, reason: string): EventParse => ({
    kind: 'excluded',
    excluded: { id, reason },
  });
  if (!isRecord(row)) return exclude(`row ${index}`, 'is not an object');

  const rawId = typeof row['id'] === 'string' ? row['id'].trim() : '';
  if (!EVENT_ID.test(rawId)) return exclude(`row ${index}`, 'has no usable id');
  const eventId = `showmytrades:${rawId}`;

  const title = cleanLabel(row['title'], 160);
  if (title === null) return exclude(eventId, 'has no title');

  const currency = typeof row['currency'] === 'string' ? row['currency'].trim().toUpperCase() : '';
  if (!CURRENCIES.includes(currency)) {
    return exclude(
      eventId,
      `its currency (${currency === '' ? 'none' : currency}) is not one the provider documents`,
    );
  }

  const level = IMPACTS[lower(row['impact'])];
  if (level === undefined) {
    const shown = lower(row['impact']);
    return exclude(
      eventId,
      `its impact rating (${shown === '' ? 'none' : shown}) is not one the provider documents`,
    );
  }

  const ts = row['ts'];
  const timeMs = parseZonedInstant(row['time']);
  if (typeof ts !== 'number' || !Number.isInteger(ts) || timeMs === null) {
    return exclude(eventId, 'its time is missing or malformed');
  }
  if (ts * 1000 !== timeMs) return exclude(eventId, 'its ts and time name different instants');
  if (timeMs < EARLIEST_PLAUSIBLE_MS || timeMs >= LATEST_PLAUSIBLE_MS) {
    return exclude(eventId, 'its time is not plausible');
  }

  const statusText = lower(row['status']);
  let status: EventStatus | undefined;
  if (statusText !== '') {
    status = STATUSES[statusText];
    if (status === undefined) {
      return exclude(eventId, `its status (${statusText}) is not one the provider documents`);
    }
  }

  const movedText = cleanLabel(row['moved_from'], 40);
  let movedFromMs: number | undefined;
  if (movedText !== null) {
    const moved = parseZonedInstant(movedText);
    if (moved === null) return exclude(eventId, 'its moved-from time is malformed');
    movedFromMs = moved;
  }

  const confidenceText = lower(row['confidence']);
  let confidence: EventConfidence | undefined;
  if (confidenceText !== '') {
    confidence = CONFIDENCES.find((known) => known === confidenceText);
    if (confidence === undefined) {
      return exclude(eventId, `its confidence (${confidenceText}) is not one the provider documents`);
    }
  }

  const actual = figureText(row['actual']);
  const forecast = figureText(row['forecast']);
  const previous = figureText(row['previous']);
  if (actual === undefined || forecast === undefined || previous === undefined) {
    return exclude(eventId, 'has a figure that is not text');
  }
  const surprise = surpriseBetween(actual, forecast, SURPRISE_BASIS);
  const period = cleanLabel(row['period'], 40);

  const event: CalendarEvent = {
    id: eventId,
    timeMs,
    timePrecision: 'exact',
    ...(status === undefined ? {} : { status }),
    ...(movedFromMs === undefined ? {} : { movedFromMs }),
    ...(period === null ? {} : { period }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(surprise === undefined ? {} : { surprise }),
    currency,
    country: null,
    title,
    impact: { level, classifiedBy: SHOWMYTRADES_IMPACT_SCHEME },
    actual,
    forecast,
    previous,
    source: {
      name: SHOWMYTRADES_LABEL,
      url: SHOWMYTRADES_ATTRIBUTION.url,
      retrievedAt,
    },
    elvoidInterpretation: null,
  };
  return { kind: 'event', event };
}

/** The credit line the provider sends, if it names the provider and links to its own site. */
function attributionOf(body: Readonly<Record<string, unknown>>): CalendarAttribution {
  const raw = body['attribution'];
  if (!isRecord(raw)) return SHOWMYTRADES_ATTRIBUTION;
  const text = cleanLabel(raw['text'], 80);
  const url = safeHttpsUrl(raw['url']);
  const ownSite = url !== null && new URL(url).hostname === SHOWMYTRADES_HOST;
  return {
    name:
      text !== null && /showmytrades/i.test(text) ? text : SHOWMYTRADES_ATTRIBUTION.name,
    url: ownSite ? url : SHOWMYTRADES_ATTRIBUTION.url,
  };
}

/** The stretch of time the answer says it covers, when it says so sensibly. */
function coverageOf(body: Readonly<Record<string, unknown>>): CalendarFetch['coverage'] {
  const fromMs = parseZonedInstant(body['from']);
  const toMs = parseZonedInstant(body['to']);
  return fromMs !== null && toMs !== null && toMs > fromMs ? { fromMs, toMs } : null;
}

export function parseShowMyTrades(body: unknown, retrievedAt: number): CalendarFetch {
  if (!isRecord(body) || !Array.isArray(body['events'])) {
    throw invalidData(SHOWMYTRADES_LABEL, 'the response has no events list');
  }
  const rows = body['events'] as unknown[];
  const events: CalendarEvent[] = [];
  const excluded: ExcludedEvent[] = [];
  rows.forEach((row, index) => {
    const parsed = parseEvent(row, index, retrievedAt);
    if (parsed.kind === 'event') events.push(parsed.event);
    else excluded.push(parsed.excluded);
  });
  const count = body['count'];
  const total =
    typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : rows.length;
  return {
    events: uniqueSorted(events),
    excluded,
    total,
    truncated: total > rows.length,
    quota: NO_QUOTA,
    attribution: attributionOf(body),
    notes: [SHOWMYTRADES_COVERAGE_NOTE],
    coverage: coverageOf(body),
  };
}

export interface ShowMyTradesConfig {
  readonly baseUrl: string;
}

/** One request for `days` days, conditional on the held `ETag` when there is one. */
export async function fetchShowMyTrades(
  http: HttpDeps,
  config: ShowMyTradesConfig,
  days: number,
  validators?: ValidatorStore,
): Promise<CalendarFetch> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new ApiFailure('bad_request', 'The calendar window is not one Elstand asks for.');
  }
  const key = `showmytrades:${days}`;
  const held = validators?.get<CalendarFetch>(key);
  const response = await callProvider(http, {
    label: SHOWMYTRADES_LABEL,
    baseUrl: config.baseUrl,
    path: SHOWMYTRADES_ENDPOINT,
    query: { days: String(days), impact: 'high,medium,low' },
    secrets: [],
    ...(held === undefined ? {} : { ifNoneMatch: held.etag }),
  });
  const retrievedAt = http.now();
  if (response.notModified) {
    if (held === undefined) {
      throw new ApiFailure(
        'provider_error',
        `${SHOWMYTRADES_LABEL} answered 304 to a plain request.`,
      );
    }
    return { ...held.value, events: restamped(held.value.events, retrievedAt) };
  }
  const result = parseShowMyTrades(response.body, retrievedAt);
  const etag = response.header('ETag');
  if (validators !== undefined && etag !== null && isEntityTag(etag.trim())) {
    validators.set(key, { etag: etag.trim(), value: result });
  }
  return result;
}

/**
 * The answer cut back to the window that was asked for, with what the provider's own window
 * leaves out said in words: an empty list must never be read as "nothing happens".
 */
export function withinWindow(fetched: CalendarFetch, window: CalendarWindow): CalendarFetch {
  const endMs = window.toMs + DAY_MS;
  const events = fetched.events.filter(
    (event) => event.timeMs >= window.fromMs && event.timeMs < endMs,
  );
  const notes = [...fetched.notes];
  const covered = fetched.coverage;
  if (covered !== null) {
    if (window.fromMs < covered.fromMs) {
      notes.push(
        `${SHOWMYTRADES_LABEL} answers only from ${formatProviderTime(covered.fromMs)}, so events before then are not covered.`,
      );
    }
    if (endMs > covered.toMs) {
      notes.push(
        `${SHOWMYTRADES_LABEL} answers only up to ${formatProviderTime(covered.toMs)}, so events after that are not covered.`,
      );
    }
  }
  return {
    ...fetched,
    events,
    total: fetched.truncated ? fetched.total : events.length,
    notes,
  };
}
