import type { ObservationPoint } from '../src/data/observations.js';
import { ApiFailure } from './errors.js';
import { invalidData, isRecord, parseGroupedDecimal } from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * U.S. Bureau of Economic Analysis adapter (https://apps.bea.gov/API/docs/index.htm).
 *
 * One request shape is used: `GetData` on the NIPA dataset, for one table and one series code.
 * The key (`UserID`) is a query parameter, so the address is a secret and is never logged. BEA
 * also echoes the request, key included, in every answer, so the answer is never passed on: only
 * the fields read below leave this module.
 *
 * Success:  { BEAAPI: { Results: { Data: [ { TableName, SeriesCode, LineNumber, TimePeriod,
 *             CL_UNIT, UNIT_MULT, DataValue } ] } } }
 * Failure:  { BEAAPI: { Results: { Error: { APIErrorCode, APIErrorDescription } } } }
 *           (the same Error object is also looked for directly under BEAAPI)
 *
 * `DataValue` is a string that may carry thousands separators; "(NA)" and similar markers are
 * skipped, never read as zero. BEA publishes the values of its current vintage and does not
 * expose publication dates, so no point has one.
 */

export const BEA_LABEL = 'U.S. Bureau of Economic Analysis';

export interface BeaConfig {
  /** `https://apps.bea.gov/api`; the `data` path is added here. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface BeaRequest {
  /** A NIPA table, e.g. `T10101`. */
  readonly table: string;
  /** The series code within the table, e.g. `A191RL`. */
  readonly seriesCode: string;
  /** The line number of that series in the table, as BEA writes it, e.g. `1`. */
  readonly lineNumber: string;
  /** Calendar years to read. Explicit years keep the answer under BEA's response-size cap. */
  readonly years: readonly number[];
  /** What `CL_UNIT` must contain, so a re-defined series is rejected rather than shown. */
  readonly unitContains: string;
}

const TABLE = /^T\d{5}$/;
const SERIES_CODE = /^[A-Z0-9]{3,20}$/;
const TIME_PERIOD = /^(\d{4})Q([1-4])$/;

function findBeaError(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body['BEAAPI'])) return null;
  const api = body['BEAAPI'];
  if (isRecord(api['Error'])) return api['Error'];
  const results = api['Results'];
  if (isRecord(results) && isRecord(results['Error'])) return results['Error'];
  if (Array.isArray(results)) {
    for (const entry of results as unknown[]) {
      if (isRecord(entry) && isRecord(entry['Error'])) return entry['Error'];
    }
  }
  return null;
}

/** BEA reports errors inside an HTTP 200 answer. */
function recognizeBeaError(apiKey: string): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    const error = findBeaError(body);
    if (error === null) return null;
    const code = String(error['APIErrorCode'] ?? '');
    const description = sanitizeText(String(error['APIErrorDescription'] ?? ''), [apiKey]);
    const suffix = description === '' ? '' : ` ${description}`;
    if (
      /user\s?id/i.test(description) &&
      /invalid|not valid|not found|unknown/i.test(description)
    ) {
      return new ApiFailure(
        'provider_auth',
        `${BEA_LABEL} rejected the configured API key.${suffix}`,
      );
    }
    if (code === '7' || /exceed|quota|too many|limit/i.test(description)) {
      return new ApiFailure(
        'rate_limited',
        `${BEA_LABEL} refused the request because a usage limit was reached.${suffix}`,
        60,
      );
    }
    return new ApiFailure(
      'provider_error',
      `${BEA_LABEL} could not serve this request (error ${code === '' ? 'unknown' : code}).${suffix}`,
    );
  };
}

export function parseBeaResponse(body: unknown, request: BeaRequest): ObservationPoint[] {
  if (!isRecord(body) || !isRecord(body['BEAAPI']) || !isRecord(body['BEAAPI']['Results'])) {
    throw invalidData(BEA_LABEL, 'the response has no results');
  }
  const data = body['BEAAPI']['Results']['Data'];
  if (!Array.isArray(data)) throw invalidData(BEA_LABEL, 'the response has no data list');

  const byDate = new Map<number, ObservationPoint>();
  for (const [index, row] of (data as unknown[]).entries()) {
    if (!isRecord(row)) throw invalidData(BEA_LABEL, `row ${index} is not an object`);
    if (
      row['SeriesCode'] !== request.seriesCode ||
      String(row['LineNumber']) !== request.lineNumber
    ) {
      continue;
    }
    if (row['TableName'] !== request.table) {
      throw invalidData(BEA_LABEL, `row ${index} belongs to another table`);
    }
    const unit = row['CL_UNIT'];
    if (typeof unit !== 'string' || !unit.includes(request.unitContains)) {
      throw invalidData(BEA_LABEL, `row ${index} is not stated in "${request.unitContains}"`);
    }
    // UNIT_MULT 0 means the number is in the stated unit; anything else would need rescaling,
    // and a percent series has no business having one.
    if (String(row['UNIT_MULT'] ?? '0') !== '0') {
      throw invalidData(BEA_LABEL, `row ${index} has an unexpected unit multiplier`);
    }
    const period =
      typeof row['TimePeriod'] === 'string' ? TIME_PERIOD.exec(row['TimePeriod']) : null;
    if (period === null) throw invalidData(BEA_LABEL, `row ${index} has no valid quarter`);
    const value = parseGroupedDecimal(row['DataValue']);
    if (value === null) continue; // "(NA)": no value, never zero.
    const date = Date.UTC(Number(period[1]), (Number(period[2]) - 1) * 3, 1);
    if (byDate.has(date))
      throw invalidData(BEA_LABEL, `quarter ${String(row['TimePeriod'])} is repeated`);
    byDate.set(date, { date, value, knownFrom: null });
  }
  const points = [...byDate.values()].sort((a, b) => a.date - b.date);
  if (points.length === 0) {
    throw new ApiFailure(
      'provider_error',
      `${BEA_LABEL} returned no values for ${request.table} ${request.seriesCode}.`,
    );
  }
  return points;
}

export async function fetchBeaSeries(
  http: HttpDeps,
  config: BeaConfig,
  request: BeaRequest,
): Promise<ObservationPoint[]> {
  if (
    !TABLE.test(request.table) ||
    !SERIES_CODE.test(request.seriesCode) ||
    request.years.length === 0 ||
    !request.years.every((year) => Number.isInteger(year) && year >= 1947 && year <= 2200)
  ) {
    throw new ApiFailure('bad_request', 'The BEA request is not valid.');
  }
  const response = await callProvider(http, {
    label: BEA_LABEL,
    baseUrl: config.baseUrl,
    path: 'data',
    query: {
      UserID: config.apiKey,
      method: 'GetData',
      datasetname: 'NIPA',
      TableName: request.table,
      Frequency: 'Q',
      Year: request.years.join(','),
      ResultFormat: 'JSON',
    },
    secrets: [config.apiKey],
    recognizeError: recognizeBeaError(config.apiKey),
  });
  return parseBeaResponse(response.body, request);
}
