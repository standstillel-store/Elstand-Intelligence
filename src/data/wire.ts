import { TIMEFRAMES, isTimeframe, type SourceMode, type Timeframe } from '../core/types.js';
import type { Quote } from './provider.js';

/**
 * The contract between the Elstand server API (`/api/*`) and the browser.
 *
 * The provider API key lives only on the server. The browser never sees a vendor payload:
 * the server translates it into these shapes, and the browser validates them again here
 * before anything reaches the UI, because a misconfigured proxy, a CDN or a static host that
 * answers `/api/status` with an HTML page is just as untrusted as a vendor.
 */

export const API_STATUS_PATH = '/api/status';
export const API_QUOTES_PATH = '/api/quotes';
export const API_CANDLES_PATH = '/api/candles';

export const API_ERROR_CODES = [
  /** The server has no provider credentials. */
  'not_connected',
  /** The provider rejected the configured key or plan. */
  'provider_auth',
  'rate_limited',
  /** The provider answered with an error or with data that failed validation. */
  'provider_error',
  'provider_unreachable',
  'bad_request',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

export interface WireSource {
  readonly id: string;
  readonly label: string;
  readonly mode: SourceMode;
  readonly staleAfterMs: number;
}

export type WireStatus =
  | {
      readonly connected: false;
      /** Names of the server environment variables that are not set. Never values. */
      readonly missing: readonly string[];
    }
  | {
      readonly connected: true;
      readonly source: WireSource;
      /** Whether the provider supplies order-book depth, and why not when it does not. */
      readonly depth: { readonly available: false; readonly reason: string };
      /** How often the server refreshes what it serves; the browser polls no faster. */
      readonly pollSeconds: { readonly quotes: number; readonly candles: number };
    };

export interface WireQuotes {
  readonly quotes: readonly Quote[];
  readonly failures: Readonly<
    Record<string, { readonly code: ApiErrorCode; readonly message: string }>
  >;
}

/** Each bar is `[openTimeMs, open, high, low, close]`. */
export type WireBar = readonly [number, number, number, number, number];

export interface WireCandles {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly candles: readonly WireBar[];
}

export interface WireError {
  readonly error: { readonly code: ApiErrorCode; readonly message: string };
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function parseStatus(input: unknown): Parsed<WireStatus> {
  if (!isRecord(input)) return fail('status is not an object');
  if (input['connected'] === false) {
    const missing = input['missing'];
    if (!Array.isArray(missing) || !missing.every((name) => typeof name === 'string')) {
      return fail('status.missing must be a list of variable names');
    }
    return ok({ connected: false, missing: missing as string[] });
  }
  if (input['connected'] !== true) return fail('status.connected must be true or false');

  const source = input['source'];
  if (!isRecord(source)) return fail('status.source is missing');
  const mode = source['mode'];
  if (
    !isNonEmptyString(source['id']) ||
    !isNonEmptyString(source['label']) ||
    (mode !== 'live' && mode !== 'delayed') ||
    !isPositive(source['staleAfterMs'])
  ) {
    return fail('status.source is malformed');
  }
  const depth = input['depth'];
  if (!isRecord(depth) || depth['available'] !== false || !isNonEmptyString(depth['reason'])) {
    return fail('status.depth must state that depth is unavailable and why');
  }
  const poll = input['pollSeconds'];
  if (!isRecord(poll) || !isPositive(poll['quotes']) || !isPositive(poll['candles'])) {
    return fail('status.pollSeconds is malformed');
  }
  return ok({
    connected: true,
    source: {
      id: source['id'],
      label: source['label'],
      mode,
      staleAfterMs: source['staleAfterMs'],
    },
    depth: { available: false, reason: depth['reason'] },
    pollSeconds: { quotes: poll['quotes'], candles: poll['candles'] },
  });
}

function parseQuote(input: unknown): Parsed<Quote> {
  if (!isRecord(input)) return fail('quote is not an object');
  const nullableNumber = (value: unknown): value is number | null =>
    value === null || isFiniteNumber(value);
  const marketOpen = input['marketOpen'];
  if (
    !isNonEmptyString(input['instrumentId']) ||
    !isFiniteNumber(input['last']) ||
    !nullableNumber(input['bid']) ||
    !nullableNumber(input['ask']) ||
    !isNonEmptyString(input['changeBasis']) ||
    !nullableNumber(input['changeAbs']) ||
    !nullableNumber(input['changePct']) ||
    !isFiniteNumber(input['asOf']) ||
    (marketOpen !== null && typeof marketOpen !== 'boolean')
  ) {
    return fail('quote is malformed');
  }
  return ok({
    instrumentId: input['instrumentId'],
    last: input['last'],
    bid: input['bid'],
    ask: input['ask'],
    changeBasis: input['changeBasis'],
    changeAbs: input['changeAbs'],
    changePct: input['changePct'],
    asOf: input['asOf'],
    marketOpen: typeof marketOpen === 'boolean' ? marketOpen : null,
  });
}

export function parseQuotes(input: unknown): Parsed<WireQuotes> {
  if (!isRecord(input) || !Array.isArray(input['quotes']))
    return fail('quotes response is malformed');
  const quotes: Quote[] = [];
  for (const raw of input['quotes'] as unknown[]) {
    const parsed = parseQuote(raw);
    if (parsed.ok === false) return fail(parsed.error);
    quotes.push(parsed.value);
  }
  const failures: Record<string, { code: ApiErrorCode; message: string }> = {};
  const rawFailures = input['failures'];
  if (!isRecord(rawFailures)) return fail('quotes.failures is malformed');
  for (const [id, detail] of Object.entries(rawFailures)) {
    if (
      !isRecord(detail) ||
      !isApiErrorCode(detail['code']) ||
      !isNonEmptyString(detail['message'])
    ) {
      return fail('quotes.failures is malformed');
    }
    failures[id] = { code: detail['code'], message: detail['message'] };
  }
  return ok({ quotes, failures });
}

export function parseCandles(input: unknown): Parsed<WireCandles> {
  if (!isRecord(input) || !Array.isArray(input['candles']))
    return fail('candles response is malformed');
  const timeframe = input['timeframe'];
  if (!isNonEmptyString(input['instrumentId']) || !isTimeframe(timeframe)) {
    return fail(`candles response must name its instrument and one of ${TIMEFRAMES.join(', ')}`);
  }
  const candles: WireBar[] = [];
  for (const raw of input['candles'] as unknown[]) {
    if (!Array.isArray(raw) || raw.length !== 5 || !raw.every(isFiniteNumber)) {
      return fail('candles contain a malformed bar');
    }
    candles.push(raw as unknown as WireBar);
  }
  return ok({ instrumentId: input['instrumentId'], timeframe, candles });
}

/** Recognizes the error envelope the server uses for every failure. */
export function parseError(input: unknown): Parsed<WireError> {
  if (!isRecord(input) || !isRecord(input['error'])) return fail('not an error envelope');
  const { code, message } = input['error'];
  if (!isApiErrorCode(code) || !isNonEmptyString(message))
    return fail('error envelope is malformed');
  return ok({ error: { code, message } });
}
