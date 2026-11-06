import type { Instrument } from '../src/core/instruments.js';
import type { Candle, Timeframe } from '../src/core/types.js';
import type { Quote } from '../src/data/provider.js';
import { ApiFailure } from './errors.js';

/**
 * Twelve Data adapter (https://twelvedata.com/docs).
 *
 * Endpoints used, with the fields read from each:
 *  - GET /quote        symbol, close, previous_close, last_quote_at | timestamp, is_market_open
 *  - GET /time_series  meta.symbol, meta.interval, values[].datetime|open|high|low|close
 *
 * Vendor numbers arrive as strings and are parsed strictly. A field that is missing or does
 * not parse is an error, not a default: a wrong price is worse than no price.
 *
 * The API key travels in the `Authorization` header, never in the URL, and redirects are
 * refused so the header cannot be forwarded to another host.
 *
 * Verified against the published documentation only. This build has not talked to the live
 * API (no key was available when it was written); see docs/ENVIRONMENT.md for the checks to
 * run on first connection.
 */

export const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';

export const TWELVE_DATA_INTERVAL: Readonly<Record<Timeframe, string>> = {
  M5: '5min',
  M15: '15min',
  M30: '30min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
};

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface UpstreamDeps {
  readonly fetch: typeof fetch;
  readonly apiKey: string;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text from the provider is shown to people, so strip control characters and any key echo. */
export function sanitizeProviderText(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[redacted]');
  const clean = withoutKey
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

function failureFor(status: number, detail: string, retryAfterHeader: string | null): ApiFailure {
  const suffix = detail === '' ? '' : ` ${detail}`;
  if (status === 401) {
    return new ApiFailure(
      'provider_auth',
      `The provider rejected the configured API key (HTTP 401).${suffix}`,
    );
  }
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    // The plan's daily allowance and its per-minute allowance are different waits.
    const daily = /\b(day|daily)\b/i.test(detail);
    return new ApiFailure(
      'rate_limited',
      `The provider's request limit was reached (HTTP 429).${suffix}`,
      Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null,
      daily ? { budget: 'day' } : undefined,
    );
  }
  if (status === 400 || status === 403 || status === 404) {
    return new ApiFailure(
      'provider_error',
      `The provider could not serve this request (HTTP ${status}).${suffix}`,
    );
  }
  // A 5xx is the provider's own failure and can pass: worth one bounded retry.
  return new ApiFailure('provider_error', `The provider failed (HTTP ${status}).${suffix}`, null, {
    retryable: status >= 500,
  });
}

async function getUpstream(
  deps: UpstreamDeps,
  path: string,
  params: Readonly<Record<string, string>>,
): Promise<unknown> {
  const url = new URL(path, TWELVE_DATA_BASE_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `apikey ${deps.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new ApiFailure('provider_unreachable', 'Could not reach the data provider.', null, {
      retryable: true,
    });
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is handled below by status.
  }

  // The vendor reports errors as `{ code, message, status: "error" }`, with or without a
  // matching HTTP status, so both signals are honoured.
  const envelope = isRecord(body) && body['status'] === 'error' ? body : null;
  if (envelope !== null || !response.ok) {
    const code = typeof envelope?.['code'] === 'number' ? envelope['code'] : response.status;
    const message = typeof envelope?.['message'] === 'string' ? envelope['message'] : '';
    throw failureFor(
      code,
      sanitizeProviderText(message, deps.apiKey),
      response.headers.get('Retry-After'),
    );
  }
  return body;
}

const invalid = (what: string): ApiFailure =>
  new ApiFailure('provider_error', `The provider returned unusable data: ${what}.`);

function normalizeSymbol(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function assertSymbol(returned: unknown, instrument: Instrument): void {
  if (
    typeof returned !== 'string' ||
    normalizeSymbol(returned) !== normalizeSymbol(instrument.symbol)
  ) {
    throw invalid(
      `it answered for ${typeof returned === 'string' ? returned : 'no symbol'}, not ${instrument.symbol}`,
    );
  }
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

/** The vendor sends decimals as strings. Anything that is not a plain decimal is rejected. */
export function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 3_600_000;

/**
 * Unix SECONDS to epoch milliseconds. A value outside a plausible window (before 2000, or
 * more than a day ahead of now) is rejected, which also catches a milliseconds value that was
 * mistaken for seconds.
 */
export function parseUnixSeconds(value: unknown, nowMs: number): number | null {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(seconds)) return null;
  const ms = seconds * 1000;
  return ms >= EARLIEST_PLAUSIBLE_MS && ms <= nowMs + MAX_FUTURE_SKEW_MS ? ms : null;
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;

/** "2026-01-02 21:05:00" or "2026-01-02", read as UTC. Calendar overflow (Feb 31) is rejected. */
export function parseDatetimeUtc(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = DATETIME.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  const roundTrips =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  return roundTrips && ms >= EARLIEST_PLAUSIBLE_MS ? ms : null;
}

export function parseQuote(body: unknown, instrument: Instrument, nowMs: number): Quote {
  if (!isRecord(body)) throw invalid('the quote response is not an object');
  assertSymbol(body['symbol'], instrument);

  const last = parseDecimal(body['close']);
  if (last === null || last <= 0) throw invalid('the quote has no usable price');

  // `last_quote_at` is the time of the latest quote. `timestamp` is only the fallback: it is
  // the time of the bar, which can be hours older, and an older time can only make the quote
  // look staler, never fresher.
  const asOf =
    parseUnixSeconds(body['last_quote_at'], nowMs) ?? parseUnixSeconds(body['timestamp'], nowMs);
  if (asOf === null) throw invalid('the quote has no usable timestamp');

  // The change is computed here from two vendor prices rather than trusting the vendor's own
  // `change` / `percent_change`, whose units are not worth guessing.
  const previous = parseDecimal(body['previous_close']);
  const changeAbs = previous !== null && previous > 0 ? last - previous : null;
  const changePct = previous !== null && previous > 0 ? ((last - previous) / previous) * 100 : null;

  return {
    instrumentId: instrument.id,
    last,
    bid: null,
    ask: null,
    changeBasis: 'prev. close',
    changeAbs,
    changePct,
    asOf,
    marketOpen: typeof body['is_market_open'] === 'boolean' ? body['is_market_open'] : null,
  };
}

export function parseTimeSeries(
  body: unknown,
  instrument: Instrument,
  timeframe: Timeframe,
): Candle[] {
  if (!isRecord(body) || !isRecord(body['meta']) || !Array.isArray(body['values'])) {
    throw invalid('the time series response has no meta or values');
  }
  assertSymbol(body['meta']['symbol'], instrument);
  const expectedInterval = TWELVE_DATA_INTERVAL[timeframe];
  const interval = body['meta']['interval'];
  if (typeof interval === 'string' && interval !== expectedInterval) {
    throw invalid(`it answered with interval ${interval} instead of ${expectedInterval}`);
  }

  const candles: Candle[] = [];
  (body['values'] as unknown[]).forEach((row, index) => {
    if (!isRecord(row)) throw invalid(`bar ${index} is not an object`);
    const time = parseDatetimeUtc(row['datetime']);
    const open = parseDecimal(row['open']);
    const high = parseDecimal(row['high']);
    const low = parseDecimal(row['low']);
    const close = parseDecimal(row['close']);
    if (time === null || open === null || high === null || low === null || close === null) {
      throw invalid(`bar ${index} has a missing or malformed field`);
    }
    candles.push({ time, open, high, low, close });
  });
  return candles;
}

export async function fetchQuote(deps: UpstreamDeps, instrument: Instrument): Promise<Quote> {
  const body = await getUpstream(deps, '/quote', { symbol: instrument.symbol });
  return parseQuote(body, instrument, deps.now());
}

export async function fetchCandles(
  deps: UpstreamDeps,
  instrument: Instrument,
  timeframe: Timeframe,
  limit: number,
): Promise<Candle[]> {
  const body = await getUpstream(deps, '/time_series', {
    symbol: instrument.symbol,
    interval: TWELVE_DATA_INTERVAL[timeframe],
    outputsize: String(limit),
    order: 'asc',
    timezone: 'UTC',
  });
  return parseTimeSeries(body, instrument, timeframe);
}
