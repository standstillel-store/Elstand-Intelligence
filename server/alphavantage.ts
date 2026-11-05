import { ApiFailure } from './errors.js';
import {
  DAY_MS,
  invalidData,
  isRecord,
  parseDecimalText,
  parseIsoDate,
  parseUtcField,
} from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * Alpha Vantage adapter (https://www.alphavantage.co/documentation), used only as a fallback for
 * the two requests below. It is never asked for intraday candles and never described as
 * real-time: the name of its spot endpoint says "Realtime", but nothing here depends on that.
 *
 *   GET query?function=CURRENCY_EXCHANGE_RATE&from_currency=EUR&to_currency=USD&apikey=KEY
 *   -> { "Realtime Currency Exchange Rate": { "1. From_Currency Code", "3. To_Currency Code",
 *        "5. Exchange Rate", "6. Last Refreshed", "7. Time Zone", "8. Bid Price", "9. Ask Price" } }
 *
 *   GET query?function=FX_DAILY&from_symbol=EUR&to_symbol=USD&outputsize=compact&apikey=KEY
 *   -> { "Meta Data": { "2. From Symbol", "3. To Symbol", "5. Last Refreshed", "6. Time Zone" },
 *        "Time Series FX (Daily)": { "YYYY-MM-DD": { "1. open", "2. high", "3. low", "4. close" } } }
 *
 * Alpha Vantage reports almost every failure inside an HTTP 200 answer, as `Error Message`,
 * `Note` or `Information`, so those are read before the status. The key is a query parameter,
 * so the address is a secret and is never logged. Times are accepted only when the answer says
 * they are UTC. These two calls have not been tested against the live service from this
 * project's environment; the tests use recorded-shape answers and prove the parsing, not the
 * integration.
 */

export const ALPHA_VANTAGE_LABEL = 'Alpha Vantage';

export interface AlphaVantageConfig {
  /** `https://www.alphavantage.co`; the `query` path is added here. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface SpotRate {
  readonly from: string;
  readonly to: string;
  readonly rate: number;
  readonly bid: number | null;
  readonly ask: number | null;
  /** The instant the provider says the rate refers to (UTC epoch ms). */
  readonly asOf: number;
}

export interface DailyBar {
  /** The day, 00:00 UTC. */
  readonly timeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface DailySeries {
  readonly from: string;
  readonly to: string;
  readonly bars: readonly DailyBar[];
  readonly lastRefreshed: number;
}

const CODE = /^[A-Z]{3}$/;

function textOf(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Alpha Vantage's own failure messages, in the order they are told apart: a bad key, a spent
 * allowance, an endpoint that needs a paid plan, and anything else it refuses.
 */
function recognizeAlphaVantageError(
  apiKey: string,
): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    if (!isRecord(body)) return null;
    const text =
      textOf(body, 'Error Message') ?? textOf(body, 'Information') ?? textOf(body, 'Note');
    if (text === null) return null;
    const message = sanitizeText(text, [apiKey]);
    const suffix = message === '' ? '' : ` ${message}`;

    if (/api\s?key/i.test(text) && /invalid|missing|not valid|unauthor/i.test(text)) {
      return new ApiFailure(
        'provider_auth',
        `${ALPHA_VANTAGE_LABEL} rejected the configured API key.${suffix}`,
      );
    }
    if (
      /rate limit|call frequency|requests? per (day|minute)|calls? per (day|minute)/i.test(text)
    ) {
      const daily = /per day|daily/i.test(text);
      return new ApiFailure(
        'rate_limited',
        `${ALPHA_VANTAGE_LABEL} refused the request because its usage limit was reached.`,
        daily ? null : 60,
        daily ? { budget: 'day' } : undefined,
      );
    }
    if (/premium/i.test(text)) {
      return new ApiFailure(
        'provider_error',
        `${ALPHA_VANTAGE_LABEL} offers this request only on a paid plan.`,
      );
    }
    return new ApiFailure(
      'provider_error',
      `${ALPHA_VANTAGE_LABEL} could not serve this request.${suffix}`,
    );
  };
}

function requireUtc(zone: unknown, what: string): void {
  if (zone !== 'UTC') throw invalidData(ALPHA_VANTAGE_LABEL, `${what} is not stated in UTC`);
}

function positive(value: unknown, what: string): number {
  const number = parseDecimalText(value);
  if (number === null || !(number > 0)) {
    throw invalidData(ALPHA_VANTAGE_LABEL, `${what} is not a positive number`);
  }
  return number;
}

export function parseSpotRate(body: unknown, from: string, to: string, now: number): SpotRate {
  if (!isRecord(body) || !isRecord(body['Realtime Currency Exchange Rate'])) {
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the response has no exchange rate');
  }
  const entry = body['Realtime Currency Exchange Rate'];
  if (entry['1. From_Currency Code'] !== from || entry['3. To_Currency Code'] !== to) {
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the rate is not for the pair asked for');
  }
  requireUtc(entry['7. Time Zone'], 'the rate’s time zone');
  const asOf = parseUtcField(entry['6. Last Refreshed']);
  if (asOf === null) throw invalidData(ALPHA_VANTAGE_LABEL, 'the rate has no valid time');
  if (asOf > now + 5 * 60_000)
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the rate is dated in the future');
  const rate = positive(entry['5. Exchange Rate'], 'the exchange rate');
  const bid =
    entry['8. Bid Price'] === undefined ? null : positive(entry['8. Bid Price'], 'the bid');
  const ask =
    entry['9. Ask Price'] === undefined ? null : positive(entry['9. Ask Price'], 'the ask');
  if (bid !== null && ask !== null && bid > ask) {
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the bid is above the ask');
  }
  return { from, to, rate, bid, ask, asOf };
}

export function parseDailySeries(
  body: unknown,
  from: string,
  to: string,
  now: number,
): DailySeries {
  if (
    !isRecord(body) ||
    !isRecord(body['Meta Data']) ||
    !isRecord(body['Time Series FX (Daily)'])
  ) {
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the response has no daily series');
  }
  const meta = body['Meta Data'];
  if (meta['2. From Symbol'] !== from || meta['3. To Symbol'] !== to) {
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the series is not for the pair asked for');
  }
  requireUtc(meta['6. Time Zone'], 'the series’ time zone');
  const lastRefreshed = parseUtcField(meta['5. Last Refreshed']);
  if (lastRefreshed === null)
    throw invalidData(ALPHA_VANTAGE_LABEL, 'the series has no valid refresh time');

  const bars: DailyBar[] = [];
  for (const [day, row] of Object.entries(body['Time Series FX (Daily)'])) {
    const timeMs = parseIsoDate(day);
    if (timeMs === null) throw invalidData(ALPHA_VANTAGE_LABEL, `"${day}" is not a valid date`);
    if (timeMs > now + DAY_MS)
      throw invalidData(ALPHA_VANTAGE_LABEL, `the bar for ${day} is in the future`);
    if (!isRecord(row))
      throw invalidData(ALPHA_VANTAGE_LABEL, `the bar for ${day} is not an object`);
    const open = positive(row['1. open'], `the open of ${day}`);
    const high = positive(row['2. high'], `the high of ${day}`);
    const low = positive(row['3. low'], `the low of ${day}`);
    const close = positive(row['4. close'], `the close of ${day}`);
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw invalidData(ALPHA_VANTAGE_LABEL, `the bar for ${day} is not consistent`);
    }
    bars.push({ timeMs, open, high, low, close });
  }
  if (bars.length === 0) throw invalidData(ALPHA_VANTAGE_LABEL, 'the series holds no bars');
  bars.sort((a, b) => a.timeMs - b.timeMs);
  return { from, to, bars, lastRefreshed };
}

function checkPair(from: string, to: string): void {
  if (!CODE.test(from) || !CODE.test(to) || from === to) {
    throw new ApiFailure('bad_request', 'The Alpha Vantage request is not a valid currency pair.');
  }
}

export async function fetchSpotRate(
  http: HttpDeps,
  config: AlphaVantageConfig,
  from: string,
  to: string,
): Promise<SpotRate> {
  checkPair(from, to);
  const response = await callProvider(http, {
    label: ALPHA_VANTAGE_LABEL,
    baseUrl: config.baseUrl,
    path: 'query',
    query: {
      function: 'CURRENCY_EXCHANGE_RATE',
      from_currency: from,
      to_currency: to,
      apikey: config.apiKey,
    },
    secrets: [config.apiKey],
    recognizeError: recognizeAlphaVantageError(config.apiKey),
  });
  return parseSpotRate(response.body, from, to, http.now());
}

export async function fetchDailySeries(
  http: HttpDeps,
  config: AlphaVantageConfig,
  from: string,
  to: string,
): Promise<DailySeries> {
  checkPair(from, to);
  const response = await callProvider(http, {
    label: ALPHA_VANTAGE_LABEL,
    baseUrl: config.baseUrl,
    path: 'query',
    query: {
      function: 'FX_DAILY',
      from_symbol: from,
      to_symbol: to,
      outputsize: 'compact',
      apikey: config.apiKey,
    },
    secrets: [config.apiKey],
    recognizeError: recognizeAlphaVantageError(config.apiKey),
  });
  return parseDailySeries(response.body, from, to, http.now());
}
