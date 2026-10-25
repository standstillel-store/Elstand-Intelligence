import { INSTRUMENTS } from '../core/instruments.js';
import { createKeyedResource, type Loadable } from '../core/resource.js';
import type { ReadableStore } from '../core/store.js';
import { isTimeframe, type SourceInfo, type Timeframe } from '../core/types.js';
import { normalizeDepthResult, type DepthResult } from './depth.js';
import {
  DEFAULT_CANDLE_LIMIT,
  type CandleSeries,
  type MarketDataProvider,
  type Quote,
  type QuoteBatch,
} from './provider.js';
import { validateCandles, validateQuote } from './validate.js';

export interface QuoteBook {
  readonly quotes: ReadonlyMap<string, Quote>;
  /** Quotes the provider returned that failed validation, with the first problem found. */
  readonly rejected: ReadonlyMap<string, string>;
}

export interface MarketDataService {
  readonly source: SourceInfo;
  readonly quotes: ReadableStore<Loadable<QuoteBook>>;
  candles(instrumentId: string, timeframe: Timeframe): ReadableStore<Loadable<CandleSeries>>;
  depth(instrumentId: string): ReadableStore<Loadable<DepthResult>>;
  /** Start loading only if never requested. */
  loadQuotes(): void;
  loadCandles(instrumentId: string, timeframe: Timeframe): void;
  loadDepth(instrumentId: string): void;
  /** Start a fresh load, discarding anything still in flight for the same key. */
  reloadQuotes(): void;
  reloadCandles(instrumentId: string, timeframe: Timeframe): void;
  reloadDepth(instrumentId: string): void;
  /** Update in the background: the current value stays on screen (see `KeyedResource.refresh`). */
  refreshQuotes(): void;
  refreshCandles(instrumentId: string, timeframe: Timeframe): void;
}

export interface MarketDataServiceOptions {
  readonly instrumentIds?: readonly string[];
  readonly now?: () => number;
}

const QUOTES_KEY = 'all';

function candleKey(instrumentId: string, timeframe: Timeframe): string {
  return `${instrumentId}|${timeframe}`;
}

function parseCandleKey(key: string): { instrumentId: string; timeframe: Timeframe } {
  const [instrumentId, timeframe] = key.split('|');
  if (instrumentId === undefined || !isTimeframe(timeframe)) {
    throw new Error(`Malformed candle key: ${key}`);
  }
  return { instrumentId, timeframe };
}

export function normalizeQuotes(batch: QuoteBatch, requestedIds: readonly string[]): QuoteBook {
  const quotes = new Map<string, Quote>();
  const rejected = new Map<string, string>();
  for (const [instrumentId, reason] of batch.failures) {
    if (requestedIds.includes(instrumentId)) rejected.set(instrumentId, reason);
  }
  for (const quote of batch.quotes) {
    if (!requestedIds.includes(quote.instrumentId)) continue;
    const issues = validateQuote(quote);
    if (issues.length > 0) {
      rejected.set(quote.instrumentId, issues[0] ?? 'invalid quote');
    } else {
      quotes.set(quote.instrumentId, quote);
    }
  }
  return { quotes, rejected };
}

export function normalizeSeries(
  series: CandleSeries,
  instrumentId: string,
  timeframe: Timeframe,
): CandleSeries {
  if (series.instrumentId !== instrumentId || series.timeframe !== timeframe) {
    throw new Error(
      `Provider returned ${series.instrumentId} ${series.timeframe} instead of ` +
        `${instrumentId} ${timeframe}`,
    );
  }
  const issues = validateCandles(series.candles);
  if (issues.length > 0) {
    throw new Error(`Provider returned invalid candles: ${issues.join('; ')}`);
  }
  return series;
}

export function createMarketDataService(
  provider: MarketDataProvider,
  options: MarketDataServiceOptions = {},
): MarketDataService {
  const ids = options.instrumentIds ?? INSTRUMENTS.map((instrument) => instrument.id);
  const now = options.now ?? Date.now;

  const quotesResource = createKeyedResource<QuoteBook>(async (_key, signal) => {
    return normalizeQuotes(await provider.getQuotes(ids, signal), ids);
  }, now);

  const candlesResource = createKeyedResource<CandleSeries>(async (key, signal) => {
    const { instrumentId, timeframe } = parseCandleKey(key);
    const series = await provider.getCandles(
      { instrumentId, timeframe, limit: DEFAULT_CANDLE_LIMIT[timeframe] },
      signal,
    );
    return normalizeSeries(series, instrumentId, timeframe);
  }, now);

  const depthResource = createKeyedResource<DepthResult>(async (instrumentId, signal) => {
    return normalizeDepthResult(await provider.getDepth(instrumentId, signal), instrumentId);
  }, now);

  return {
    source: provider.info,
    quotes: quotesResource.store(QUOTES_KEY),
    candles: (instrumentId, timeframe) => candlesResource.store(candleKey(instrumentId, timeframe)),
    depth: (instrumentId) => depthResource.store(instrumentId),
    loadQuotes: () => quotesResource.ensure(QUOTES_KEY),
    loadCandles: (instrumentId, timeframe) =>
      candlesResource.ensure(candleKey(instrumentId, timeframe)),
    loadDepth: (instrumentId) => depthResource.ensure(instrumentId),
    reloadQuotes: () => quotesResource.reload(QUOTES_KEY),
    reloadCandles: (instrumentId, timeframe) =>
      candlesResource.reload(candleKey(instrumentId, timeframe)),
    reloadDepth: (instrumentId) => depthResource.reload(instrumentId),
    refreshQuotes: () => quotesResource.refresh(QUOTES_KEY),
    refreshCandles: (instrumentId, timeframe) =>
      candlesResource.refresh(candleKey(instrumentId, timeframe)),
  };
}
