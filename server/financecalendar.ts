import type {
  CalendarEvent,
  EventStatus,
  EventSurprise,
  ImpactClassification,
} from '../src/data/macro.js';
import { ApiFailure } from './errors.js';
import {
  DAY_MS,
  cleanLabel,
  formatIsoDate,
  invalidData,
  isRecord,
  parseDecimalText,
  parseIsoDate,
  parseUtcField,
  parseWholeNumber,
  safeHttpsUrl,
} from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * Finance Calendar adapter (https://www.financecalendar.com, API documented at
 * https://github.com/awarenessdays/financecalendar-api).
 *
 *   GET calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=500&offset=N
 *   -> { events: [ { id, name, country, impact, date, release_at_utc, status, consensus, prior,
 *                    actual, unit, release_stage, source_name, source_url, ... } ], count, total }
 *
 * A key is optional. Without one the API allows 2,000 requests per day per IP address; with a
 * free key (`X-API-Key` header, so the key never appears in an address) 10,000.
 *
 * What is and is not taken from the answer:
 *  - A time is exact only when `release_at_utc` is set. A row with a date and no instant keeps
 *    its date (`timePrecision: 'date'`); no time is ever invented for it.
 *  - The API has no currency field. The currency is derived from the country by a fixed table
 *    (`CURRENCY_OF_COUNTRY`); a country that is not in the table is excluded, with the reason.
 *  - Impact is the provider's own rating, and is attributed to it. A row without one has none.
 *  - `consensus` becomes the forecast, exactly as supplied. The API says it does not collect
 *    consensus estimates yet, so the forecast is usually empty, and then so is the surprise.
 *  - Figures are shown as the provider wrote them. Nothing is converted between units.
 *
 * The data may only be shown with a visible link to financecalendar.com; the link travels with
 * every answer (`CALENDAR_ATTRIBUTION`) so the interface never has to hard-code it.
 */

export const FINANCE_CALENDAR_LABEL = 'Finance Calendar';
export const FINANCE_CALENDAR_HOME = 'https://www.financecalendar.com';

export const CALENDAR_ATTRIBUTION = {
  name: 'Finance Calendar',
  url: FINANCE_CALENDAR_HOME,
} as const;

export const IMPACT_SCHEME = 'Finance Calendar impact rating';

/** Which currency a country's releases move. Fixed, documented, and never guessed beyond it. */
export const CURRENCY_OF_COUNTRY: Readonly<Record<string, string>> = {
  US: 'USD',
  GB: 'GBP',
  EU: 'EUR',
  DE: 'EUR',
  JP: 'JPY',
  CA: 'CAD',
  AU: 'AUD',
  CN: 'CNY',
  CH: 'CHF',
  NZ: 'NZD',
  NO: 'NOK',
  SE: 'SEK',
  IN: 'INR',
  HK: 'HKD',
};

export interface FinanceCalendarConfig {
  readonly baseUrl: string;
  /** The optional key. Null uses the keyless allowance. */
  readonly apiKey: string | null;
}

export interface CalendarWindow {
  /** Inclusive start, as a UTC instant; the request names its UTC day. */
  readonly fromMs: number;
  readonly toMs: number;
}

export interface QuotaReading {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly tier: string | null;
}

export interface ExcludedEvent {
  readonly id: string;
  readonly reason: string;
}

export interface CalendarFetch {
  readonly events: readonly CalendarEvent[];
  readonly excluded: readonly ExcludedEvent[];
  /** The provider's count for the window, which can exceed what was read. */
  readonly total: number | null;
  readonly truncated: boolean;
  readonly quota: QuotaReading;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 3;

const STATUS_OF: Readonly<Record<string, EventStatus>> = {
  confirmed: 'scheduled',
  scheduled: 'scheduled',
  estimated: 'estimated',
  released: 'released',
  rescheduled: 'rescheduled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function impactOf(value: unknown): ImpactClassification | null {
  if (typeof value !== 'string') return null;
  const level = value.trim().toLowerCase();
  return level === 'high' || level === 'medium' || level === 'low'
    ? { level, classifiedBy: IMPACT_SCHEME }
    : null;
}

/** A figure as the provider supplied it: a number or text, with its unit when it has one. */
interface Figure {
  readonly text: string;
  readonly number: number | null;
}

function figureOf(value: unknown, unit: string | null): Figure | null {
  if (value === null || value === undefined) return null;
  let text: string;
  let number: number | null = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    number = value;
    text = String(Number(value.toPrecision(12)));
  } else if (typeof value === 'string') {
    const cleaned = cleanLabel(value, 40);
    if (cleaned === null) return null;
    text = cleaned;
    number = parseDecimalText(cleaned);
  } else {
    return null;
  }
  if (unit !== null && !text.endsWith(unit)) {
    text = unit === '%' ? `${text}%` : `${text} ${unit}`;
  }
  return { text, number };
}

function surpriseOf(
  actual: Figure | null,
  forecast: Figure | null,
  unit: string | null,
): EventSurprise | undefined {
  if (actual === null || forecast === null) return undefined;
  if (actual.number === null || forecast.number === null) return undefined;
  const value = Number((actual.number - forecast.number).toPrecision(12));
  return {
    value,
    unit: unit ?? '',
    basis: 'actual minus consensus, both as supplied by Finance Calendar',
  };
}

type EventParse =
  | { readonly kind: 'event'; readonly event: CalendarEvent }
  | { readonly kind: 'excluded'; readonly excluded: ExcludedEvent };

function parseEvent(row: unknown, index: number, retrievedAt: number): EventParse {
  const exclude = (id: string, reason: string): EventParse => ({
    kind: 'excluded',
    excluded: { id, reason },
  });
  if (!isRecord(row)) return exclude(`row ${index}`, 'is not an object');

  const rawId = row['id'];
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  if (id === '') return exclude(`row ${index}`, 'has no id');
  const eventId = `financecalendar:${id}`;

  const country = typeof row['country'] === 'string' ? row['country'].trim().toUpperCase() : '';
  const currency = CURRENCY_OF_COUNTRY[country];
  if (currency === undefined) {
    return exclude(
      eventId,
      `its country (${country === '' ? 'none' : country}) has no mapped currency`,
    );
  }

  const title =
    cleanLabel(row['name']) ?? cleanLabel(row['title']) ?? cleanLabel(row['series_name']);
  if (title === null) return exclude(eventId, 'has no title');

  const exactMs = row['release_at_utc'] === null ? null : parseUtcField(row['release_at_utc']);
  if (row['release_at_utc'] !== null && row['release_at_utc'] !== undefined && exactMs === null) {
    return exclude(eventId, 'its release time is malformed');
  }
  const dayMs = parseIsoDate(row['date']);
  if (exactMs === null && dayMs === null) return exclude(eventId, 'has neither a time nor a date');
  const precision = exactMs === null ? 'date' : 'exact';
  const timeMs = exactMs ?? (dayMs as number);

  const unit = cleanLabel(row['unit'], 16);
  const actual = figureOf(row['actual'], unit);
  const forecast = figureOf(row['consensus'], unit);
  const previous = figureOf(row['prior'], unit);

  const statusText = typeof row['status'] === 'string' ? row['status'].trim().toLowerCase() : '';
  const status = STATUS_OF[statusText];
  const stage = cleanLabel(row['release_stage'], 60);
  const surprise = surpriseOf(actual, forecast, unit);
  const sourceName = cleanLabel(row['source_name'], 80);
  const link = safeHttpsUrl(row['source_url']) ?? safeHttpsUrl(row['url']);

  const event: CalendarEvent = {
    id: eventId,
    timeMs,
    timePrecision: precision,
    ...(status === undefined ? {} : { status }),
    ...(stage === null ? {} : { stage }),
    ...(surprise === undefined ? {} : { surprise }),
    currency,
    country,
    title,
    impact: impactOf(row['impact']),
    actual: actual?.text ?? null,
    forecast: forecast?.text ?? null,
    previous: previous?.text ?? null,
    source: {
      name:
        sourceName === null ? FINANCE_CALENDAR_LABEL : `${FINANCE_CALENDAR_LABEL} · ${sourceName}`,
      url: link,
      retrievedAt,
    },
    elvoidInterpretation: null,
  };
  return { kind: 'event', event };
}

export interface ParsedPage {
  readonly events: readonly CalendarEvent[];
  readonly excluded: readonly ExcludedEvent[];
  readonly count: number;
  readonly total: number | null;
}

export function parseCalendarPage(body: unknown, retrievedAt: number): ParsedPage {
  if (!isRecord(body) || !Array.isArray(body['events'])) {
    throw invalidData(FINANCE_CALENDAR_LABEL, 'the response has no events list');
  }
  const rows = body['events'] as unknown[];
  const events: CalendarEvent[] = [];
  const excluded: ExcludedEvent[] = [];
  rows.forEach((row, index) => {
    const parsed = parseEvent(row, index, retrievedAt);
    if (parsed.kind === 'event') events.push(parsed.event);
    else excluded.push(parsed.excluded);
  });
  const total = body['total'];
  return {
    events,
    excluded,
    count: rows.length,
    total: typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null,
  };
}

/** The API answers a bad request as `{ error: "..." }`. Statuses are handled by the HTTP helper. */
function recognizeCalendarError(
  secrets: readonly string[],
): (status: number, body: unknown) => ApiFailure | null {
  return (status, body) => {
    if (!isRecord(body) || typeof body['error'] !== 'string' || status === 429) return null;
    const message = sanitizeText(body['error'], secrets);
    if (status === 401 || status === 403) {
      return new ApiFailure(
        'provider_auth',
        `${FINANCE_CALENDAR_LABEL} rejected the configured API key (HTTP ${status}).`,
      );
    }
    if (status >= 500) return null;
    return new ApiFailure(
      'provider_error',
      `${FINANCE_CALENDAR_LABEL} could not serve this request (HTTP ${status}). ${message}`.trim(),
    );
  };
}

export async function fetchCalendar(
  http: HttpDeps,
  config: FinanceCalendarConfig,
  window: CalendarWindow,
): Promise<CalendarFetch> {
  if (
    !Number.isFinite(window.fromMs) ||
    !Number.isFinite(window.toMs) ||
    window.toMs < window.fromMs
  ) {
    throw new ApiFailure('bad_request', 'The calendar window is not valid.');
  }
  if (window.toMs - window.fromMs > 90 * DAY_MS) {
    throw new ApiFailure('bad_request', 'The calendar window is longer than the provider allows.');
  }
  const secrets = config.apiKey === null ? [] : [config.apiKey];
  const headers = config.apiKey === null ? {} : { 'X-API-Key': config.apiKey };

  const events: CalendarEvent[] = [];
  const excluded: ExcludedEvent[] = [];
  let total: number | null = null;
  let read = 0;
  let quota: QuotaReading = { limit: null, remaining: null, tier: null };

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await callProvider(http, {
      label: FINANCE_CALENDAR_LABEL,
      baseUrl: config.baseUrl,
      path: 'calendar',
      query: {
        from: formatIsoDate(window.fromMs),
        to: formatIsoDate(window.toMs),
        limit: String(PAGE_SIZE),
        offset: String(read),
      },
      headers,
      secrets,
      recognizeError: recognizeCalendarError(secrets),
    });
    quota = {
      limit: parseWholeNumber(response.header('X-RateLimit-Limit')),
      remaining: parseWholeNumber(response.header('X-RateLimit-Remaining')),
      tier: cleanLabel(response.header('X-RateLimit-Tier'), 20),
    };
    const parsed = parseCalendarPage(response.body, http.now());
    events.push(...parsed.events);
    excluded.push(...parsed.excluded);
    read += parsed.count;
    total = parsed.total ?? total;
    if (parsed.count === 0 || total === null || read >= total) break;
  }

  const seen = new Set<string>();
  const unique = events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  unique.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  return {
    events: unique,
    excluded,
    total,
    truncated: total !== null && read < total,
    quota,
  };
}
