import { findInstrument, type Instrument } from '../src/core/instruments.js';
import type { Candle, Timeframe } from '../src/core/types.js';
import { DEFAULT_CANDLE_LIMIT, type Quote } from '../src/data/provider.js';
import { validateCandles, validateQuote } from '../src/data/validate.js';
import { fetchDailySeries, fetchSpotRate } from './alphavantage.js';
import type { DataClass } from './cache-policy.js';
import { STALE_AFTER_MS, readServerConfig } from './env.js';
import { ApiFailure } from './errors.js';
import { asFallback, failureReason, through, type Outcome, type ServiceDeps } from './service.js';
import { fetchCandles, fetchQuote } from './twelvedata.js';

/**
 * Forex quotes and candles: Twelve Data is the source, asked through the shared request path
 * (budget, bounded retry, last verified answer). Alpha Vantage is a fallback for two requests
 * only, and only for currency pairs:
 *
 *  - the daily candle series, which is the same kind of data as Twelve Data's daily bars;
 *  - a spot quote, but only when Twelve Data cannot answer AND nothing it answered earlier is
 *    left to show.
 *
 * It is never asked for intraday candles (it has no compatible free intraday series here), never
 * when Twelve Data is simply not configured (that is ENV NOT CONNECTION, not an outage), and
 * never after Twelve Data rejected its credential (that needs the operator, not a substitute).
 * An answer from the fallback says so in its provenance, with the reason.
 */

export const QUOTE_ENDPOINT = 'quote';
export const CANDLES_ENDPOINT = 'time_series';

/** Quotes may use at most this share of Twelve Data's budget, so candles always keep some. */
const QUOTE_SHARE = 0.75;

function needKey(key: string | null): string {
  if (key === null) throw new ApiFailure('not_connected', 'The Twelve Data credential is missing.');
  return key;
}

function liveFeed(deps: ServiceDeps): boolean {
  const reading = readServerConfig(deps.env);
  return 'config' in reading && reading.config.mode === 'live';
}

/**
 * A fallback is a substitute for an outage, not for a missing or rejected credential, and not for
 * a hold-back this server chose. Twelve Data is in outage when it refused (a rate limit or a
 * spent quota), could not be reached, sent data that did not validate, or when its DAILY allowance
 * is used up, which lasts until the next UTC day. A per-minute hold-back by Elstand's own budget
 * is not an outage: the next minute asks again, and the last verified answer covers the gap.
 */
function mayFallBack(outcome: Outcome<unknown>): boolean {
  if (outcome.kind !== 'withheld' || outcome.failure === null) return false;
  const { code, local, budget } = outcome.failure;
  if (code === 'rate_limited') return !local || budget === 'day';
  return code === 'provider_unreachable' || code === 'provider_error';
}

/** The Twelve Data quote alone, with no fallback: what a connection check of that provider asks. */
export function loadPrimaryQuote(
  deps: ServiceDeps,
  instrument: Instrument,
): Promise<Outcome<Quote>> {
  const live = liveFeed(deps);
  const window = live ? STALE_AFTER_MS.live : STALE_AFTER_MS.delayed;
  return through<Quote>(deps, {
    provider: 'twelvedata',
    capability: 'forex-market-data',
    endpoint: QUOTE_ENDPOINT,
    dataClass: 'quote',
    cacheKey: `quote:${instrument.id}`,
    endpointShare: QUOTE_SHARE,
    live,
    datumFreshMs: window,
    datumFreshText: live ? '5 minutes' : '30 minutes',
    // A market that is closed has no newer quote to show; its last one is not stale for that.
    isCurrent: (quote, now) => quote.marketOpen === false || now - quote.asOf <= window,
    dataAsOf: (quote) => quote.asOf,
    load: async (ready) => {
      const fetched = await fetchQuote(
        { fetch: deps.fetch, apiKey: needKey(ready.apiKey), now: deps.now },
        instrument,
      );
      const issues = validateQuote(fetched);
      if (issues.length > 0) {
        throw new ApiFailure(
          'provider_error',
          `The provider returned an invalid quote: ${issues[0] ?? 'unknown'}.`,
        );
      }
      return fetched;
    },
  });
}

export async function loadQuote(
  deps: ServiceDeps,
  instrument: Instrument,
): Promise<Outcome<Quote>> {
  const primary = await loadPrimaryQuote(deps, instrument);
  if (!mayFallBack(primary) || instrument.assetClass !== 'fx') return primary;

  const fallback = await alphaVantageSpot(
    deps,
    instrument,
    `alphavantage:spot:${instrument.id}`,
    'quote',
  );
  // If the fallback has nothing either, the answer is the primary's: that is the real cause.
  return fallback.kind === 'data'
    ? asFallback(fallback, 'twelvedata', failureReason(primary.provenance))
    : primary;
}

/** One Alpha Vantage spot rate, as a quote. It states no day change: the provider gives none. */
function alphaVantageSpot(
  deps: ServiceDeps,
  instrument: Instrument,
  cacheKey: string,
  dataClass: DataClass,
): Promise<Outcome<Quote>> {
  return through<Quote>(deps, {
    provider: 'alphavantage',
    capability: 'forex-market-data',
    endpoint: 'CURRENCY_EXCHANGE_RATE',
    dataClass,
    cacheKey,
    datumFreshMs: STALE_AFTER_MS.delayed,
    datumFreshText: '30 minutes',
    dataAsOf: (quote) => quote.asOf,
    load: async (ready) => {
      const spot = await fetchSpotRate(
        { fetch: deps.fetch, now: deps.now },
        { baseUrl: ready.baseUrl, apiKey: needKey(ready.apiKey) },
        instrument.base,
        instrument.quote,
      );
      const quote: Quote = {
        instrumentId: instrument.id,
        last: spot.rate,
        bid: spot.bid,
        ask: spot.ask,
        changeBasis: 'not provided',
        changeAbs: null,
        changePct: null,
        asOf: spot.asOf,
        marketOpen: null,
      };
      const issues = validateQuote(quote);
      if (issues.length > 0) {
        throw new ApiFailure(
          'provider_error',
          `The provider returned an invalid quote: ${issues[0] ?? 'unknown'}.`,
        );
      }
      return quote;
    },
  });
}

/** The pair a connection check asks for. */
const PROBE_PAIR = 'EURUSD';

/**
 * The explicit check of the Alpha Vantage connection: one spot rate, kept for as long as a
 * reference rate is, because it spends one of the few requests the free plan allows each day.
 * It never runs unless a person asks for it.
 */
export function loadSpotProbe(deps: ServiceDeps): Promise<Outcome<Quote>> {
  const instrument = findInstrument(PROBE_PAIR);
  if (instrument === undefined)
    throw new Error(`The probe pair ${PROBE_PAIR} is not a known instrument.`);
  return alphaVantageSpot(
    deps,
    instrument,
    `alphavantage:probe:${instrument.id}`,
    'reference-rates',
  );
}

export async function loadCandles(
  deps: ServiceDeps,
  instrument: Instrument,
  timeframe: Timeframe,
): Promise<Outcome<readonly Candle[]>> {
  const daily = timeframe === 'D1';
  const primary = await through<readonly Candle[]>(deps, {
    provider: 'twelvedata',
    capability: 'forex-market-data',
    endpoint: CANDLES_ENDPOINT,
    dataClass: daily ? 'candles-daily' : 'candles-intraday',
    cacheKey: `candles:${instrument.id}:${timeframe}`,
    endpointShare: 1,
    live: liveFeed(deps),
    // The newest bar's age says little about a market that closes; the browser judges that.
    isCurrent: () => true,
    dataAsOf: (candles) => candles[candles.length - 1]?.time ?? null,
    load: async (ready) => {
      const fetched = await fetchCandles(
        { fetch: deps.fetch, apiKey: needKey(ready.apiKey), now: deps.now },
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
  });
  if (!daily || !mayFallBack(primary) || instrument.assetClass !== 'fx') return primary;

  const fallback = await through<readonly Candle[]>(deps, {
    provider: 'alphavantage',
    capability: 'forex-market-data',
    endpoint: 'FX_DAILY',
    dataClass: 'candles-daily',
    cacheKey: `alphavantage:fx-daily:${instrument.id}`,
    isCurrent: () => true,
    dataAsOf: (candles) => candles[candles.length - 1]?.time ?? null,
    load: async (ready) => {
      const series = await fetchDailySeries(
        { fetch: deps.fetch, now: deps.now },
        { baseUrl: ready.baseUrl, apiKey: needKey(ready.apiKey) },
        instrument.base,
        instrument.quote,
      );
      const candles: Candle[] = series.bars.map((bar) => ({
        time: bar.timeMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }));
      const issues = validateCandles(candles);
      if (issues.length > 0) {
        throw new ApiFailure(
          'provider_error',
          `The provider returned invalid candles: ${issues.join('; ')}.`,
        );
      }
      return candles;
    },
  });
  return fallback.kind === 'data'
    ? asFallback(fallback, 'twelvedata', failureReason(primary.provenance))
    : primary;
}
