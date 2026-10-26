import { INSTRUMENTS, findInstrument, type Instrument } from '../src/core/instruments.js';
import { isTimeframe } from '../src/core/types.js';
import { DEFAULT_CANDLE_LIMIT, type Quote } from '../src/data/provider.js';
import { validateCandles, validateQuote } from '../src/data/validate.js';
import type { ApiErrorCode, WireCandles, WireQuotes, WireStatus } from '../src/data/wire.js';
import { createTtlCache, type TtlCache } from './cache.js';
import { ENV_API_KEY, readServerConfig, type ServerConfig } from './env.js';
import { ApiFailure, httpStatusFor, toApiFailure } from './errors.js';
import { fetchCandles, fetchQuote, type UpstreamDeps } from './twelvedata.js';

/**
 * The three API handlers, written against the Web `Request` / `Response` types so they run
 * unchanged on Vercel's Node runtime, in the local dev server and in tests. Everything the
 * handlers touch from the outside (environment, network, clock, cache) is passed in.
 */

export interface HandlerDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Defaults to one shared in-memory cache per server instance. */
  readonly cache?: TtlCache;
}

export const TWELVE_DATA_SOURCE_ID = 'twelvedata';
export const TWELVE_DATA_LABEL = 'Twelve Data';
export const DEPTH_UNAVAILABLE_REASON =
  'No order-book depth adapter exists for this provider in this build. Spot FX and XAU/USD are ' +
  'traded over the counter, so there is no consolidated book to show.';

const defaultCache = createTtlCache();

const NO_STORE = 'no-store';
const sharedCache = (seconds: number): string => `public, max-age=0, s-maxage=${seconds}`;

function json(
  body: unknown,
  status: number,
  cacheControl: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cacheControl,
      ...extra,
    },
  });
}

function errorResponse(failure: ApiFailure): Response {
  const extra =
    failure.retryAfterSeconds === null ? {} : { 'Retry-After': String(failure.retryAfterSeconds) };
  return json(
    { error: { code: failure.code, message: failure.message } },
    httpStatusFor(failure.code),
    NO_STORE,
    extra,
  );
}

function notGet(request: Request): Response | null {
  if (request.method === 'GET') return null;
  return json(
    { error: { code: 'bad_request', message: 'Only GET is supported.' } },
    405,
    NO_STORE,
    { Allow: 'GET' },
  );
}

function requireConfig(deps: HandlerDeps): ServerConfig {
  const reading = readServerConfig(deps.env);
  if (!reading.connected) {
    throw new ApiFailure(
      'not_connected',
      `The server has no data-provider credentials. Set ${ENV_API_KEY} on the server.`,
    );
  }
  return reading.config;
}

function upstreamFor(config: ServerConfig, deps: HandlerDeps): UpstreamDeps {
  return { fetch: deps.fetch, apiKey: config.apiKey, now: deps.now };
}

export function handleStatus(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return Promise.resolve(blocked);
  const reading = readServerConfig(deps.env);
  // `in` rather than the boolean flag: the Vercel builder type-checks without strictNullChecks,
  // where a boolean discriminant does not narrow (see tsconfig.vercel.json).
  if ('missing' in reading) {
    const notConnected: WireStatus = { connected: false, missing: reading.missing };
    return Promise.resolve(json(notConnected, 200, NO_STORE));
  }
  const body: WireStatus = {
    connected: true,
    source: {
      id: TWELVE_DATA_SOURCE_ID,
      label: TWELVE_DATA_LABEL,
      mode: reading.config.mode,
      staleAfterMs: reading.config.staleAfterMs,
    },
    depth: { available: false, reason: DEPTH_UNAVAILABLE_REASON },
    pollSeconds: {
      quotes: reading.config.refreshSeconds,
      candles: reading.config.refreshSeconds,
    },
  };
  return Promise.resolve(json(body, 200, NO_STORE));
}

function parseInstrumentList(raw: string | null): Instrument[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) throw new ApiFailure('bad_request', 'The ids parameter is required.');
  const found = new Map<string, Instrument>();
  for (const name of names) {
    const instrument = findInstrument(name);
    if (instrument === undefined)
      throw new ApiFailure('bad_request', `Unknown instrument: ${name.slice(0, 20)}.`);
    found.set(instrument.id, instrument);
  }
  return [...found.values()];
}

type QuoteOutcome =
  | { readonly kind: 'quote'; readonly instrument: Instrument; readonly quote: Quote }
  | { readonly kind: 'failure'; readonly instrument: Instrument; readonly failure: ApiFailure };

export async function handleQuotes(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const config = requireConfig(deps);
    const instruments = parseInstrumentList(new URL(request.url).searchParams.get('ids'));
    const upstream = upstreamFor(config, deps);
    const cache = deps.cache ?? defaultCache;
    const ttlMs = config.refreshSeconds * 1000;

    const outcomes = await Promise.all(
      instruments.map(async (instrument): Promise<QuoteOutcome> => {
        try {
          const quote = await cache.getOrLoad(
            `quote:${instrument.id}`,
            ttlMs,
            deps.now(),
            async () => {
              const fetched = await fetchQuote(upstream, instrument);
              const issues = validateQuote(fetched);
              if (issues.length > 0) {
                throw new ApiFailure(
                  'provider_error',
                  `The provider returned an invalid quote: ${issues[0] ?? 'unknown'}.`,
                );
              }
              return fetched;
            },
          );
          return { kind: 'quote', instrument, quote };
        } catch (error) {
          return { kind: 'failure', instrument, failure: toApiFailure(error) };
        }
      }),
    );

    const quotes: Quote[] = [];
    const failures: Record<string, { code: ApiErrorCode; message: string }> = {};
    for (const outcome of outcomes) {
      if (outcome.kind === 'quote') quotes.push(outcome.quote);
      else
        failures[outcome.instrument.id] = {
          code: outcome.failure.code,
          message: outcome.failure.message,
        };
    }

    if (quotes.length === 0) {
      // Nothing to show. If every request failed the same way (a rejected key, a rate limit)
      // report that cause as the response, so the browser can react to it.
      const failed = outcomes.flatMap((outcome) =>
        outcome.kind === 'failure' ? [outcome.failure] : [],
      );
      const first = failed[0];
      if (first === undefined) throw new ApiFailure('provider_error', 'No quotes were returned.');
      throw failed.every((failure) => failure.code === first.code)
        ? first
        : new ApiFailure('provider_error', first.message);
    }

    const body: WireQuotes = { quotes, failures };
    const hasFailures = Object.keys(failures).length > 0;
    return json(body, 200, hasFailures ? NO_STORE : sharedCache(config.refreshSeconds));
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleCandles(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const config = requireConfig(deps);
    const params = new URL(request.url).searchParams;
    const instrument = findInstrument(params.get('id') ?? '');
    if (instrument === undefined) throw new ApiFailure('bad_request', 'Unknown instrument.');
    const timeframe = params.get('tf');
    if (!isTimeframe(timeframe)) throw new ApiFailure('bad_request', 'Unknown timeframe.');

    const upstream = upstreamFor(config, deps);
    const cache = deps.cache ?? defaultCache;
    const candles = await cache.getOrLoad(
      `candles:${instrument.id}:${timeframe}`,
      config.refreshSeconds * 1000,
      deps.now(),
      async () => {
        const fetched = await fetchCandles(
          upstream,
          instrument,
          timeframe,
          DEFAULT_CANDLE_LIMIT[timeframe],
        );
        const issues = validateCandles(fetched);
        if (issues.length > 0) {
          throw new ApiFailure(
            'provider_error',
            `The provider returned invalid candles: ${issues.join('; ')}.`,
          );
        }
        return fetched;
      },
    );

    const body: WireCandles = {
      instrumentId: instrument.id,
      timeframe,
      candles: candles.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close] as const),
    };
    return json(body, 200, sharedCache(config.refreshSeconds));
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

/** The instruments the API will quote. Exposed so tests can assert the watchlist order. */
export const SERVED_INSTRUMENT_IDS: readonly string[] = INSTRUMENTS.map(
  (instrument) => instrument.id,
);
