import type { ObservationPoint } from '../src/data/observations.js';
import { ApiFailure } from './errors.js';
import { invalidData, isRecord, parseDecimalText } from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * World Bank indicators API (https://datahelpdesk.worldbank.org/knowledgebase/articles/889392).
 *
 * Public: no key, no credential of any kind. `WORLD_BANK_API_BASE_URL` can point at another
 * host that serves the same API, but the built-in address is the official one.
 *
 *   GET country/{iso3;iso3;...}/indicator/{code}?format=json&mrnev={n}
 *
 * answers `[ { page, pages, per_page, total, ... }, [ { indicator: { id }, countryiso3code,
 * date, value } ] ]`, where `value` is a number or null, and the second element is null when
 * nothing matched. Errors are answered with HTTP 200 and `[ { message: [ { id, key, value } ] } ]`.
 *
 * Indicators are ANNUAL and published long after the year they describe. A point is dated at the
 * start of its year and has no publication date.
 */

export const WORLD_BANK_LABEL = 'World Bank';

export interface WorldBankConfig {
  readonly baseUrl: string;
}

export interface WorldBankRequest {
  /** Three-letter codes (`USA`, `EMU`), as the World Bank writes them. */
  readonly countries: readonly string[];
  /** An indicator code, e.g. `NY.GDP.MKTP.KD.ZG`. */
  readonly indicator: string;
  /** How many of the most recent non-empty values to read per country. */
  readonly latest: number;
}

export interface WorldBankResult {
  readonly series: ReadonlyMap<string, readonly ObservationPoint[]>;
  readonly missing: readonly string[];
}

const COUNTRY = /^[A-Z]{3}$/;
const INDICATOR = /^[A-Z0-9]{2,6}(\.[A-Z0-9]{2,8}){1,5}$/;

function recognizeWorldBankError(): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    if (!Array.isArray(body) || body.length === 0) return null;
    const first = (body as unknown[])[0];
    if (!isRecord(first) || !Array.isArray(first['message'])) return null;
    const entry = (first['message'] as unknown[])[0];
    const text = isRecord(entry) && typeof entry['value'] === 'string' ? entry['value'] : '';
    const message = sanitizeText(text, []);
    return new ApiFailure(
      'provider_error',
      `${WORLD_BANK_LABEL} could not serve this request.${message === '' ? '' : ` ${message}`}`,
    );
  };
}

export function parseWorldBankResponse(body: unknown, request: WorldBankRequest): WorldBankResult {
  if (!Array.isArray(body) || body.length !== 2 || !isRecord((body as unknown[])[0])) {
    throw invalidData(WORLD_BANK_LABEL, 'the response is not a page header and a data list');
  }
  const rows = (body as unknown[])[1];
  const byCountry = new Map<string, Map<number, ObservationPoint>>();

  if (rows !== null) {
    if (!Array.isArray(rows)) throw invalidData(WORLD_BANK_LABEL, 'the data list is malformed');
    (rows as unknown[]).forEach((row, index) => {
      if (!isRecord(row)) throw invalidData(WORLD_BANK_LABEL, `row ${index} is not an object`);
      const indicator = row['indicator'];
      if (!isRecord(indicator) || indicator['id'] !== request.indicator) {
        throw invalidData(WORLD_BANK_LABEL, `row ${index} is for another indicator`);
      }
      const country = row['countryiso3code'];
      if (typeof country !== 'string' || !request.countries.includes(country)) {
        throw invalidData(WORLD_BANK_LABEL, `row ${index} is for an unrequested country`);
      }
      const year = row['date'];
      if (typeof year !== 'string' || !/^\d{4}$/.test(year)) {
        throw invalidData(WORLD_BANK_LABEL, `row ${index} has no valid year`);
      }
      if (row['value'] === null) return; // no value for that year
      const value = typeof row['value'] === 'number' ? parseDecimalText(row['value']) : null;
      if (value === null) throw invalidData(WORLD_BANK_LABEL, `row ${index} has a malformed value`);
      const date = Date.UTC(Number(year), 0, 1);
      const points = byCountry.get(country) ?? new Map<number, ObservationPoint>();
      if (points.has(date))
        throw invalidData(WORLD_BANK_LABEL, `${country} repeats the year ${year}`);
      points.set(date, { date, value, knownFrom: null });
      byCountry.set(country, points);
    });
  }

  const series = new Map<string, readonly ObservationPoint[]>();
  for (const [country, points] of byCountry) {
    series.set(
      country,
      [...points.values()].sort((a, b) => a.date - b.date),
    );
  }
  return { series, missing: request.countries.filter((country) => !series.has(country)) };
}

export async function fetchWorldBankIndicator(
  http: HttpDeps,
  config: WorldBankConfig,
  request: WorldBankRequest,
): Promise<WorldBankResult> {
  if (
    request.countries.length === 0 ||
    !request.countries.every((code) => COUNTRY.test(code)) ||
    !INDICATOR.test(request.indicator) ||
    !Number.isInteger(request.latest) ||
    request.latest < 1 ||
    request.latest > 20
  ) {
    throw new ApiFailure('bad_request', 'The World Bank request is not valid.');
  }
  const response = await callProvider(http, {
    label: WORLD_BANK_LABEL,
    baseUrl: config.baseUrl,
    path: `country/${request.countries.join(';')}/indicator/${request.indicator}`,
    query: {
      format: 'json',
      mrnev: String(request.latest),
      per_page: String(request.countries.length * request.latest + 10),
    },
    secrets: [],
    recognizeError: recognizeWorldBankError(),
  });
  return parseWorldBankResponse(response.body, request);
}
