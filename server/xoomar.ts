import type { CalendarEvent, ImpactLevel } from '../src/data/macro.js';
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
  cleanLabel,
  formatIsoDate,
  invalidData,
  isRecord,
  parseUtcField,
  safeHttpsUrl,
} from './parse.js';
import { callProvider, isEntityTag, type HttpDeps } from './provider-http.js';
import type { ValidatorStore } from './provider-runtime.js';

/**
 * XOOMAR economic calendar (https://xoomar.com/markets/api/calendar), the fallback source.
 *
 *   GET calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   -> { data: [ { source, eventName, importance, scheduledAt, periodLabel, previous, forecast,
 *                  actual, unit, canonicalUrl } ], updatedAt, meta: { sourceAttribution }, ... }
 *
 * A key is optional: without one the API allows 10 requests per minute per IP, with a free
 * account key (`X-API-Key`) 30. What is and is not taken from it:
 *  - It carries U.S. agency releases only (`source` is bls, bea, census, fed, dol or treasury),
 *    so every event is USD and US. That is how the provider documents its data, and the answer
 *    says so aloud (`notes`). A source it does not name is excluded, never guessed.
 *  - `forecast` is always null: the provider publishes no consensus. It stays null here, so no
 *    surprise is ever calculated from it.
 *  - The provider has no event id. Elstand's id is built from the publisher, the event name and
 *    the scheduled instant, which is stable for one release and invented for nothing.
 *  - `actual` and `previous` are decimal strings in `unit`. They are shown as written with the
 *    unit after them; nothing is converted.
 *  - The provider states no schedule status, so none is set.
 *  - The free licence is for personal, academic and internal use with a visible credit
 *    (https://xoomar.com/terms). The credit travels with every answer; the limits are documented
 *    in docs/ENVIRONMENT.md and are the owner's to weigh.
 */

export const XOOMAR_LABEL = 'XOOMAR';

export const XOOMAR_ATTRIBUTION: CalendarAttribution = {
  name: 'XOOMAR',
  url: 'https://xoomar.com/markets/api/calendar',
};

export const XOOMAR_IMPACT_SCHEME = 'XOOMAR importance rating';

/** The publishers the provider documents. All are U.S. federal bodies. */
const PUBLISHERS: readonly string[] = ['bls', 'bea', 'census', 'fed', 'dol', 'treasury'];

const IMPORTANCE: Readonly<Record<string, ImpactLevel>> = {
  high: 'high',
  med: 'medium',
  medium: 'medium',
  low: 'low',
};

export const XOOMAR_COVERAGE_NOTE =
  'XOOMAR covers U.S. agency releases only (BLS, BEA, Census, Federal Reserve, DOL, Treasury), so there are no events for other currencies.';
export const XOOMAR_FORECAST_NOTE =
  'XOOMAR publishes no forecast. Forecast stays empty and no surprise is calculated.';

const SURPRISE_BASIS = 'actual minus forecast, both as published by XOOMAR';

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function compactUtc(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 16).replace(/[-:]/g, '');
}

function withUnit(text: string | null, unit: string | null): string | null {
  if (text === null) return null;
  return unit === null ? text : `${text} ${unit}`;
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

  const title = cleanLabel(row['eventName']);
  if (title === null) return exclude(`row ${index}`, 'has no event name');

  const publisher = typeof row['source'] === 'string' ? row['source'].trim().toLowerCase() : '';
  if (!PUBLISHERS.includes(publisher)) {
    return exclude(
      `row ${index}`,
      `its publisher (${publisher === '' ? 'none' : publisher}) is not one the provider documents`,
    );
  }

  const timeMs = parseUtcField(row['scheduledAt']);
  if (timeMs === null) return exclude(`row ${index}`, 'its scheduled time is missing or malformed');
  const eventId = `xoomar:${publisher}:${slug(title)}:${compactUtc(timeMs)}`;

  const importanceText =
    typeof row['importance'] === 'string' ? row['importance'].trim().toLowerCase() : '';
  const level = IMPORTANCE[importanceText];

  const unit = cleanLabel(row['unit'], 40);
  const actualText = figureText(row['actual']);
  const forecastText = figureText(row['forecast']);
  const previousText = figureText(row['previous']);
  if (actualText === undefined || forecastText === undefined || previousText === undefined) {
    return exclude(eventId, 'has a figure that is not text');
  }
  const actual = withUnit(actualText, unit);
  const previous = withUnit(previousText, unit);
  // A forecast the provider does send is kept as written; it is never produced here.
  const forecast = withUnit(forecastText, unit);
  const surprise = surpriseBetween(actualText, forecastText, SURPRISE_BASIS);

  const period = cleanLabel(row['periodLabel'], 40);
  const link = safeHttpsUrl(row['canonicalUrl']) ?? XOOMAR_ATTRIBUTION.url;

  const event: CalendarEvent = {
    id: eventId,
    timeMs,
    timePrecision: 'exact',
    ...(period === null ? {} : { period }),
    ...(surprise === undefined ? {} : { surprise }),
    currency: 'USD',
    country: 'US',
    title,
    impact: level === undefined ? null : { level, classifiedBy: XOOMAR_IMPACT_SCHEME },
    actual,
    forecast,
    previous,
    source: {
      name: `${XOOMAR_LABEL} · ${publisher.toUpperCase()}`,
      url: link,
      retrievedAt,
    },
    elvoidInterpretation: null,
  };
  return { kind: 'event', event };
}

export function parseXoomar(body: unknown, retrievedAt: number): CalendarFetch {
  if (!isRecord(body) || !Array.isArray(body['data'])) {
    throw invalidData(XOOMAR_LABEL, 'the response has no data list');
  }
  const rows = body['data'] as unknown[];
  const events: CalendarEvent[] = [];
  const excluded: ExcludedEvent[] = [];
  rows.forEach((row, index) => {
    const parsed = parseEvent(row, index, retrievedAt);
    if (parsed.kind === 'event') events.push(parsed.event);
    else excluded.push(parsed.excluded);
  });
  const meta = body['meta'];
  const credit = isRecord(meta) ? cleanLabel(meta['sourceAttribution'], 240) : null;
  return {
    events: uniqueSorted(events),
    excluded,
    total: rows.length,
    truncated: false,
    quota: NO_QUOTA,
    attribution: XOOMAR_ATTRIBUTION,
    notes: [
      XOOMAR_COVERAGE_NOTE,
      XOOMAR_FORECAST_NOTE,
      ...(credit === null ? [] : [`Data credit: ${credit}`]),
    ],
    coverage: null,
  };
}

export interface XoomarConfig {
  readonly baseUrl: string;
  /** The free account key, when the operator has one. Without it the keyless limit applies. */
  readonly apiKey: string | null;
}

/** One request for the window's days, conditional on the held `ETag` when there is one. */
export async function fetchXoomar(
  http: HttpDeps,
  config: XoomarConfig,
  window: CalendarWindow,
  validators?: ValidatorStore,
): Promise<CalendarFetch> {
  if (
    !Number.isFinite(window.fromMs) ||
    !Number.isFinite(window.toMs) ||
    window.toMs < window.fromMs
  ) {
    throw new ApiFailure('bad_request', 'The calendar window is not valid.');
  }
  if (window.toMs - window.fromMs > 31 * DAY_MS) {
    throw new ApiFailure('bad_request', 'The calendar window is longer than Elstand asks for.');
  }
  const from = formatIsoDate(window.fromMs);
  const to = formatIsoDate(window.toMs);
  const key = `xoomar:${from}:${to}`;
  const held = validators?.get<CalendarFetch>(key);
  const response = await callProvider(http, {
    label: XOOMAR_LABEL,
    baseUrl: config.baseUrl,
    path: 'calendar',
    query: { from, to },
    secrets: config.apiKey === null ? [] : [config.apiKey],
    ...(config.apiKey === null ? {} : { headers: { 'X-API-Key': config.apiKey } }),
    ...(held === undefined ? {} : { ifNoneMatch: held.etag }),
  });
  const retrievedAt = http.now();
  if (response.notModified) {
    if (held === undefined) {
      throw new ApiFailure('provider_error', `${XOOMAR_LABEL} answered 304 to a plain request.`);
    }
    return { ...held.value, events: restamped(held.value.events, retrievedAt) };
  }
  const parsed = parseXoomar(response.body, retrievedAt);
  const inWindow = parsed.events.filter(
    (event) => event.timeMs >= window.fromMs && event.timeMs < window.toMs + DAY_MS,
  );
  const result: CalendarFetch = { ...parsed, events: inWindow };
  const etag = response.header('ETag');
  if (validators !== undefined && etag !== null && isEntityTag(etag.trim())) {
    validators.set(key, { etag: etag.trim(), value: result });
  }
  return result;
}
