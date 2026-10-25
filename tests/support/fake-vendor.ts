/**
 * TEST-ONLY stand-in for the Twelve Data HTTP API, built from the response shapes in its
 * published documentation. It lets tests drive the real adapter and handlers without a
 * network or a key. Nothing it returns is market data, and nothing here may reach `dist`.
 */
import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../../src/core/types.js';
import { FIXTURE_NOW } from './fixtures.js';

export interface VendorCall {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly url: string;
}

export type VendorReply = Response | Record<string, unknown> | undefined;

export interface FakeVendor {
  readonly fetch: typeof fetch;
  readonly calls: VendorCall[];
}

/** `respond` may return a Response, or a plain object that becomes a 200 JSON body. */
export function createFakeVendor(
  respond: (call: VendorCall) => VendorReply | Promise<VendorReply>,
): FakeVendor {
  const calls: VendorCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const call: VendorCall = {
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      authorization: headers.get('Authorization'),
      redirect: init?.redirect,
      url: url.toString(),
    };
    calls.push(call);
    const reply = await respond(call);
    if (reply instanceof Response) return reply;
    if (reply === undefined) return vendorError(404, 'not found');
    return jsonResponse(reply, 200);
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The documented error envelope: `{ code, message, status: "error" }`. */
export function vendorError(code: number, message: string, httpStatus: number = code): Response {
  return jsonResponse({ code, message, status: 'error' }, httpStatus);
}

const NOW_SECONDS = FIXTURE_NOW / 1000;

/** A `/quote` body in the documented shape. Numbers are strings, timestamps are integers. */
export function quotePayload(
  symbol: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol,
    name: symbol,
    currency: 'USD',
    datetime: '2026-01-06',
    timestamp: NOW_SECONDS - 43_200,
    last_quote_at: NOW_SECONDS,
    open: '1.10000',
    high: '1.10500',
    low: '1.09500',
    close: '1.10250',
    previous_close: '1.10000',
    change: '0.00250',
    percent_change: '0.22727',
    is_market_open: true,
    ...overrides,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm:ss` for intraday bars and `YYYY-MM-DD` for daily bars, in UTC. */
export function vendorDatetime(ms: number, daily: boolean): string {
  const date = new Date(ms);
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return daily
    ? day
    : `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** A `/time_series` body in the documented shape: bars ascending, prices as strings. */
export function timeSeriesPayload(
  symbol: string,
  interval: string,
  candles: readonly Candle[],
  decimals = 5,
): Record<string, unknown> {
  const daily = interval === '1day';
  return {
    meta: {
      symbol,
      interval,
      currency: 'USD',
      exchange_timezone: 'UTC',
      type: 'Physical Currency',
    },
    values: candles.map((bar) => ({
      datetime: vendorDatetime(bar.time, daily),
      open: bar.open.toFixed(decimals),
      high: bar.high.toFixed(decimals),
      low: bar.low.toFixed(decimals),
      close: bar.close.toFixed(decimals),
    })),
    status: 'ok',
  };
}

/**
 * A deterministic, chart-shaped series for browser tests (a seeded walk, not a model of any
 * market). Bars are valid and end at `endOpen`, aligned to the timeframe.
 */
export function walkCandles(
  count: number,
  timeframe: Timeframe,
  start: number,
  endOpen: number = FIXTURE_NOW,
  seed = 7,
): Candle[] {
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  const alignedEnd = Math.floor(endOpen / step) * step;
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
  let price = start;
  const bars: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = open * (1 + next() * 0.004);
    const high = Math.max(open, close) * (1 + Math.abs(next()) * 0.0015);
    const low = Math.min(open, close) * (1 - Math.abs(next()) * 0.0015);
    bars.push({ time: alignedEnd - (count - 1 - index) * step, open, high, low, close });
    price = close;
  }
  return bars;
}
