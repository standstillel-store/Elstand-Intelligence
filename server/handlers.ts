import { INSTRUMENTS, findInstrument, type Instrument } from '../src/core/instruments.js';
import { isTimeframe } from '../src/core/types.js';
import type { Quote } from '../src/data/provider.js';
import type { Provenance } from '../src/data/provenance.js';
import type { ApiErrorCode } from '../src/data/wire.js';
import type {
  WireCandlesAnswer,
  WireQuotesAnswer,
  WireStatusBody,
} from '../src/data/wire-providers.js';
import { sharedCacheControl } from './cache-policy.js';
import type { TtlCache } from './cache.js';
import { ENV_API_KEY, readServerConfig, type ServerConfig } from './env.js';
import { ApiFailure, toApiFailure } from './errors.js';
import { loadCandles, loadQuote } from './forex-service.js';
import { describeProviders } from './provider-registry.js';
import { runtimeFor, type ProviderRuntime } from './provider-runtime.js';
import { NO_STORE, errorResponse, json, notGet } from './respond.js';
import type { ServiceDeps } from './service.js';

/**
 * The status, quotes and candles handlers, written against the Web `Request` / `Response` types
 * so they run unchanged on Vercel's Node runtime, in the local dev server and in tests.
 * Everything the handlers touch from the outside (environment, network, clock, cache) is
 * passed in.
 *
 * Quotes and candles are asked through the shared service path (request budget, bounded retry,
 * the last verified answer when the provider cannot be asked), and each answer says in its
 * `provenance` which provider answered and in which state.
 */

export interface HandlerDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Defaults to one shared in-memory cache per server instance. */
  readonly cache?: TtlCache;
  /**
   * The request budgets, retry and caches of the provider calls. Defaults to one per `cache`,
   * or one per server instance when there is no cache either.
   */
  readonly runtime?: ProviderRuntime;
}

export const TWELVE_DATA_SOURCE_ID = 'twelvedata';
export const TWELVE_DATA_LABEL = 'Twelve Data';
export const DEPTH_UNAVAILABLE_REASON =
  'No order-book depth adapter exists for this provider in this build. Spot FX and XAU/USD are ' +
  'traded over the counter, so there is no consolidated book to show.';

/** The pieces the capability services take. */
export function serviceDepsOf(deps: HandlerDeps): ServiceDeps {
  return { env: deps.env, fetch: deps.fetch, now: deps.now, runtime: runtimeFor(deps) };
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

export function handleStatus(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return Promise.resolve(blocked);
  const reading = readServerConfig(deps.env);
  const providers = describeProviders(deps.env);
  // `in` rather than the boolean flag: the Vercel builder type-checks without strictNullChecks,
  // where a boolean discriminant does not narrow (see tsconfig.vercel.json).
  if ('missing' in reading) {
    const notConnected: WireStatusBody = { connected: false, missing: reading.missing, providers };
    return Promise.resolve(json(notConnected, 200, NO_STORE));
  }
  const body: WireStatusBody = {
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
    providers,
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

/**
 * The same list starting `seed` places further on. The provider's request budget can be smaller
 * than the watchlist (the free Twelve Data plan allows 8 credits a minute), and requests are
 * served in order, so a fixed order would starve the same instruments at every refresh. Turning
 * the order with the refresh interval gives every instrument its turn. Nothing is random: the
 * same instant always gives the same order.
 */
function turned<T>(items: readonly T[], seed: number): T[] {
  if (items.length === 0) return [];
  const offset = seed % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export async function handleQuotes(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const config = requireConfig(deps);
    const instruments = parseInstrumentList(new URL(request.url).searchParams.get('ids'));
    const service = serviceDepsOf(deps);
    const ttlMs = config.refreshSeconds * 1000;

    const answered = await Promise.all(
      turned(instruments, Math.floor(deps.now() / ttlMs)).map(async (instrument) => ({
        instrument,
        outcome: await loadQuote(service, instrument),
      })),
    );
    const byId = new Map(answered.map((item) => [item.instrument.id, item.outcome]));

    const quotes: Quote[] = [];
    const failures: Record<string, { code: ApiErrorCode; message: string }> = {};
    const provenance: Record<string, Provenance> = {};
    const causes: ApiFailure[] = [];
    let shareMs = Number.POSITIVE_INFINITY;
    // The answer keeps the order the browser asked in, whatever order the requests ran in.
    for (const instrument of instruments) {
      const outcome = byId.get(instrument.id);
      if (outcome === undefined) continue;
      provenance[instrument.id] = outcome.provenance;
      if (outcome.kind === 'data') {
        quotes.push(outcome.value);
        shareMs = Math.min(shareMs, outcome.shareMs);
        continue;
      }
      const failure =
        outcome.failure ??
        new ApiFailure(
          'not_connected',
          outcome.provenance.message ?? 'The provider is not connected.',
        );
      causes.push(failure);
      failures[instrument.id] = { code: failure.code, message: failure.message };
    }

    if (quotes.length === 0) {
      // Nothing to show: report the cause that explains it, so the browser can react to it.
      throw (
        representativeCause(causes) ?? new ApiFailure('provider_error', 'No quotes were returned.')
      );
    }

    const body: WireQuotesAnswer = { quotes, failures, provenance };
    const hasFailures = Object.keys(failures).length > 0;
    return json(body, 200, hasFailures ? NO_STORE : sharedCacheControl(shareMs));
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleCandles(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    requireConfig(deps);
    const params = new URL(request.url).searchParams;
    const instrument = findInstrument(params.get('id') ?? '');
    if (instrument === undefined) throw new ApiFailure('bad_request', 'Unknown instrument.');
    const timeframe = params.get('tf');
    if (!isTimeframe(timeframe)) throw new ApiFailure('bad_request', 'Unknown timeframe.');

    const outcome = await loadCandles(serviceDepsOf(deps), instrument, timeframe);
    if (outcome.kind === 'withheld') {
      throw (
        outcome.failure ??
        new ApiFailure(
          'not_connected',
          outcome.provenance.message ?? 'The provider is not connected.',
        )
      );
    }
    const body: WireCandlesAnswer = {
      instrumentId: instrument.id,
      timeframe,
      candles: outcome.value.map(
        (bar) => [bar.time, bar.open, bar.high, bar.low, bar.close] as const,
      ),
      provenance: outcome.provenance,
    };
    return json(body, 200, sharedCacheControl(outcome.shareMs));
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

/**
 * The failure that stands for a response with nothing to show. A rejected credential is the root
 * cause of whatever else happened (a request this server's own budget held back says nothing
 * about the provider), and it is what lets the browser flip to ENV NOT CONNECTION. Otherwise the
 * requests the provider actually answered decide; only when none did does a local refusal count.
 */
export function representativeCause(causes: readonly ApiFailure[]): ApiFailure | undefined {
  const rejected = causes.find((failure) => failure.code === 'provider_auth');
  if (rejected !== undefined) return rejected;
  const asked = causes.filter((failure) => !failure.local);
  const pool = asked.length > 0 ? asked : causes;
  const first = pool[0];
  if (first === undefined) return undefined;
  return pool.every((failure) => failure.code === first.code)
    ? first
    : new ApiFailure('provider_error', first.message);
}

/** The instruments the API will quote. Exposed so tests can assert the watchlist order. */
export const SERVED_INSTRUMENT_IDS: readonly string[] = INSTRUMENTS.map(
  (instrument) => instrument.id,
);
