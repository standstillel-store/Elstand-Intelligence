import type { ObservationPoint } from '../src/data/observations.js';
import { ApiFailure } from './errors.js';
import {
  DAY_MS,
  formatIsoDate,
  invalidData,
  isRecord,
  parseDecimalText,
  parseIsoDate,
} from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * FRED adapter (https://fred.stlouisfed.org/docs/api/fred/series_observations.html).
 *
 * One endpoint is used: `series/observations`, with the key in the `api_key` query parameter
 * (FRED offers no header form, so the address is a secret: it is never logged and never put in a
 * message). The response is read as
 *
 *   { units, observations: [ { realtime_start, realtime_end, date, value } ] }
 *
 * where `value` is a string and "." marks a missing observation, which is skipped and never read
 * as zero.
 *
 * Publication dates. The request uses `output_type=4` (initial release only) over every
 * real-time period, so each row's `realtime_start` is the day that value was first published.
 * FRED records that day, not a time, so a value is treated as known from the START OF THE NEXT
 * UTC DAY. That can never let a value be used before it existed; it costs up to a day of lag in
 * historical use. A row whose `realtime_start` is before its own period (FRED's marker for
 * values that predate its vintage records) has no recorded publication date and gets none.
 *
 * Only series whose published values are not revised are configured (policy rates and
 * not-seasonally-adjusted price indices), so the initial release is also the current value.
 * That is a property of the catalog (server/macro-catalog.ts), not something this adapter
 * assumes for a series it is handed.
 */

export const FRED_LABEL = 'FRED';

export interface FredConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface FredRequest {
  readonly seriesId: string;
  /** How far back to read, so the answer is a handful of rows and not the whole history. */
  readonly lookbackDays: number;
}

/** A real-time period that covers every vintage FRED has ever recorded. */
const ALL_VINTAGES_START = '1776-07-04';
const ALL_VINTAGES_END = '9999-12-31';

const SERIES_ID = /^[A-Za-z0-9_]{1,40}$/;

/** FRED answers errors as `{ error_code, error_message }` with the same HTTP status. */
function recognizeFredError(apiKey: string): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    if (!isRecord(body) || typeof body['error_code'] !== 'number') return null;
    const code = body['error_code'];
    const message = sanitizeText(
      typeof body['error_message'] === 'string' ? body['error_message'] : '',
      [apiKey],
    );
    const suffix = message === '' ? '' : ` ${message}`;
    if (code === 400 && /api[_ ]key/i.test(message)) {
      return new ApiFailure(
        'provider_auth',
        `${FRED_LABEL} rejected the configured API key (HTTP 400).${suffix}`,
      );
    }
    if (code === 400 || code === 404) {
      return new ApiFailure(
        'provider_error',
        `${FRED_LABEL} could not serve this request (HTTP ${code}).${suffix}`,
      );
    }
    // 429 and 5xx are handled by status, which also reads Retry-After.
    return null;
  };
}

export function parseFredObservations(
  body: unknown,
  seriesId: string,
  now: number,
): ObservationPoint[] {
  if (!isRecord(body) || !Array.isArray(body['observations'])) {
    throw invalidData(FRED_LABEL, 'the response has no observations list');
  }
  const units = body['units'];
  if (typeof units === 'string' && units !== 'lin') {
    // A transformed series (percent change, index) is not the published level.
    throw invalidData(FRED_LABEL, `series ${seriesId} came back transformed (units=${units})`);
  }

  const points: ObservationPoint[] = [];
  let previousDate = Number.NEGATIVE_INFINITY;
  (body['observations'] as unknown[]).forEach((row, index) => {
    if (!isRecord(row)) throw invalidData(FRED_LABEL, `observation ${index} is not an object`);
    const date = parseIsoDate(row['date']);
    if (date === null) throw invalidData(FRED_LABEL, `observation ${index} has no valid date`);
    if (date > now + DAY_MS)
      throw invalidData(FRED_LABEL, `observation ${index} is dated in the future`);
    const raw = row['value'];
    if (raw === '.') return; // FRED's marker for "no value": skipped, never zero.
    const value = parseDecimalText(raw);
    if (value === null) throw invalidData(FRED_LABEL, `observation ${index} has a malformed value`);
    if (date <= previousDate) {
      throw invalidData(FRED_LABEL, `observation ${index} repeats or precedes an earlier date`);
    }
    previousDate = date;

    const publishedOn = parseIsoDate(row['realtime_start']);
    // The first release is known from the next UTC day (see the note at the top of this file).
    const knownFrom = publishedOn !== null && publishedOn >= date ? publishedOn + DAY_MS : null;
    points.push({ date, value, knownFrom });
  });

  if (points.length === 0) {
    throw new ApiFailure(
      'provider_error',
      `${FRED_LABEL} returned no observations for series ${seriesId}.`,
    );
  }
  return points;
}

async function requestObservations(
  http: HttpDeps,
  config: FredConfig,
  request: FredRequest,
  withPublicationDates: boolean,
): Promise<ObservationPoint[]> {
  const now = http.now();
  const response = await callProvider(http, {
    label: FRED_LABEL,
    baseUrl: config.baseUrl,
    path: 'series/observations',
    query: {
      series_id: request.seriesId,
      api_key: config.apiKey,
      file_type: 'json',
      observation_start: formatIsoDate(now - request.lookbackDays * DAY_MS),
      sort_order: 'asc',
      ...(withPublicationDates
        ? {
            output_type: '4',
            realtime_start: ALL_VINTAGES_START,
            realtime_end: ALL_VINTAGES_END,
          }
        : {}),
    },
    secrets: [config.apiKey],
    recognizeError: recognizeFredError(config.apiKey),
  });
  const points = parseFredObservations(response.body, request.seriesId, now);
  // Without the vintage parameters the rows carry today's real-time period, which says nothing
  // about when a value was first published, so no publication date is recorded.
  return withPublicationDates ? points : points.map((point) => ({ ...point, knownFrom: null }));
}

export async function fetchFredObservations(
  http: HttpDeps,
  config: FredConfig,
  request: FredRequest,
): Promise<ObservationPoint[]> {
  if (!SERIES_ID.test(request.seriesId)) {
    throw new ApiFailure('bad_request', 'The series id is not valid.');
  }
  try {
    return await requestObservations(http, config, request, true);
  } catch (error) {
    // FRED refused the vintage parameters (HTTP 400, not a key problem). The levels are still
    // real and still attributed, so ask once more without them and record that the publication
    // dates are unknown. Anything else (a bad key, a limit, an outage) is not retried here.
    const refusedVintage =
      error instanceof ApiFailure &&
      error.code === 'provider_error' &&
      !error.retryable &&
      error.message.includes('(HTTP 400)');
    if (!refusedVintage) throw error;
    return requestObservations(http, config, request, false);
  }
}
