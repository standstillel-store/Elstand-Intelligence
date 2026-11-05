import type { ObservationPoint } from '../src/data/observations.js';
import { ApiFailure } from './errors.js';
import { invalidData, isRecord, parseDecimalText } from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * U.S. Bureau of Labor Statistics adapter
 * (https://www.bls.gov/developers/api_signature_v2.htm).
 *
 * One endpoint, two versions. With a registration key the v2 endpoint is used (500 queries per
 * day, 50 series per query, 20 years); without one, the v1 endpoint (25 queries per day, 25
 * series per query, 10 years). A key is optional, so a missing key is never reported as an error.
 * The v2 key travels in the JSON body, never in the address.
 *
 * Request:  POST { seriesid: [..], startyear, endyear, registrationkey? }
 * Response: { status, message: [..], Results: { series: [ { seriesID, data: [
 *             { year, period, periodName, value, footnotes } ] } ] } }
 *
 * `period` M01..M12 is a month and M13 is the annual average, which is skipped. `value` is a
 * string and "-" marks a missing value, which is skipped and never read as zero. BLS gives no
 * publication timestamp, so no point has a publication date.
 */

export const BLS_LABEL = 'U.S. Bureau of Labor Statistics';

export interface BlsConfig {
  /** `https://api.bls.gov/publicAPI`; the version path is added here. */
  readonly baseUrl: string;
  /** The registration key, or null to use the keyless v1 endpoint. */
  readonly apiKey: string | null;
}

export interface BlsRequest {
  readonly seriesIds: readonly string[];
  readonly startYear: number;
  readonly endYear: number;
}

export interface BlsResult {
  /** Points by series id, ascending by month. */
  readonly series: ReadonlyMap<string, readonly ObservationPoint[]>;
  /** Series that were asked for and not answered with usable data. */
  readonly missing: readonly string[];
}

const SERIES_ID = /^[A-Z0-9]{5,30}$/;
const PERIOD = /^M(0[1-9]|1[0-2])$/;

function messagesOf(body: Record<string, unknown>, secrets: readonly string[]): string {
  const raw = body['message'];
  const parts = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === 'string')
    : [];
  return sanitizeText(parts.join(' '), secrets);
}

/** BLS reports most failures as HTTP 200 with `status` other than REQUEST_SUCCEEDED. */
function recognizeBlsError(
  secrets: readonly string[],
): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    if (!isRecord(body) || typeof body['status'] !== 'string') return null;
    if (body['status'] === 'REQUEST_SUCCEEDED') return null;
    const message = messagesOf(body, secrets);
    const suffix = message === '' ? '' : ` ${message}`;
    if (/threshold|daily limit/i.test(message)) {
      return new ApiFailure(
        'rate_limited',
        `${BLS_LABEL} refused the request because its daily limit was reached.${suffix}`,
        null,
        { budget: 'day' },
      );
    }
    if (
      /\bkey\b/i.test(message) &&
      /invalid|not valid|unregistered|expired|not found/i.test(message)
    ) {
      return new ApiFailure(
        'provider_auth',
        `${BLS_LABEL} rejected the configured registration key.${suffix}`,
      );
    }
    return new ApiFailure('provider_error', `${BLS_LABEL} could not serve this request.${suffix}`);
  };
}

export function parseBlsResponse(body: unknown, requested: readonly string[]): BlsResult {
  if (!isRecord(body) || !isRecord(body['Results']) || !Array.isArray(body['Results']['series'])) {
    throw invalidData(BLS_LABEL, 'the response has no series list');
  }
  const series = new Map<string, readonly ObservationPoint[]>();
  for (const entry of body['Results']['series'] as unknown[]) {
    if (!isRecord(entry) || typeof entry['seriesID'] !== 'string') {
      throw invalidData(BLS_LABEL, 'a series has no id');
    }
    const id = entry['seriesID'];
    if (!requested.includes(id))
      throw invalidData(BLS_LABEL, `it answered for unrequested series ${id}`);
    if (!Array.isArray(entry['data']))
      throw invalidData(BLS_LABEL, `series ${id} has no data list`);

    const byDate = new Map<number, ObservationPoint>();
    (entry['data'] as unknown[]).forEach((row, index) => {
      if (!isRecord(row))
        throw invalidData(BLS_LABEL, `series ${id} row ${index} is not an object`);
      const period = row['period'];
      if (typeof period !== 'string')
        throw invalidData(BLS_LABEL, `series ${id} row ${index} has no period`);
      if (period === 'M13') return; // annual average
      if (!PERIOD.test(period)) return; // quarterly or other periods are not monthly points
      const yearText = row['year'];
      if (typeof yearText !== 'string' || !/^\d{4}$/.test(yearText)) {
        throw invalidData(BLS_LABEL, `series ${id} row ${index} has no valid year`);
      }
      if (row['value'] === '-') return; // BLS's marker for "no value"
      const value = parseDecimalText(row['value']);
      if (value === null)
        throw invalidData(BLS_LABEL, `series ${id} row ${index} has a malformed value`);
      const date = Date.UTC(Number(yearText), Number(period.slice(1)) - 1, 1);
      if (byDate.has(date)) throw invalidData(BLS_LABEL, `series ${id} repeats a month`);
      byDate.set(date, { date, value, knownFrom: null });
    });
    const points = [...byDate.values()].sort((a, b) => a.date - b.date);
    if (points.length > 0) series.set(id, points);
  }
  return { series, missing: requested.filter((id) => !series.has(id)) };
}

export async function fetchBlsSeries(
  http: HttpDeps,
  config: BlsConfig,
  request: BlsRequest,
): Promise<BlsResult> {
  if (request.seriesIds.length === 0 || !request.seriesIds.every((id) => SERIES_ID.test(id))) {
    throw new ApiFailure('bad_request', 'The BLS series ids are not valid.');
  }
  const keyed = config.apiKey !== null;
  const response = await callProvider(http, {
    label: BLS_LABEL,
    baseUrl: config.baseUrl,
    path: keyed ? 'v2/timeseries/data/' : 'v1/timeseries/data/',
    method: 'POST',
    jsonBody: {
      seriesid: request.seriesIds,
      startyear: String(request.startYear),
      endyear: String(request.endYear),
      ...(config.apiKey === null ? {} : { registrationkey: config.apiKey }),
    },
    secrets: config.apiKey === null ? [] : [config.apiKey],
    recognizeError: recognizeBlsError(config.apiKey === null ? [] : [config.apiKey]),
  });
  return parseBlsResponse(response.body, request.seriesIds);
}
