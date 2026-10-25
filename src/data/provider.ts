import type { Candle, SourceInfo, Timeframe } from '../core/types.js';
import type { DepthResult } from './depth.js';

/**
 * The market-data integration boundary.
 *
 * Nothing outside `src/data` knows what a real provider's payloads look like. A concrete
 * adapter translates its vendor's schema into these types and declares, in `info.mode`,
 * what the data actually is. The UI derives LIVE / DELAYED / STALE from that declaration
 * plus the datum's own timestamp; it never infers "live" from plausible numbers.
 *
 * There is no simulated provider. If nothing is connected, nothing is shown.
 */

export interface Quote {
  readonly instrumentId: string;
  /** Latest price. Present on every quote. */
  readonly last: number;
  /** Venue-specific top of book. Both null when the source does not supply them. */
  readonly bid: number | null;
  readonly ask: number | null;
  /** What the change figures are measured against, e.g. "prev. close". */
  readonly changeBasis: string;
  readonly changeAbs: number | null;
  readonly changePct: number | null;
  /** When the price was observed at the source (epoch ms). */
  readonly asOf: number;
  /** The provider's own statement about whether the market is open, or null if it makes none. */
  readonly marketOpen: boolean | null;
}

export interface CandleRequest {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  /** Maximum number of most-recent bars wanted. */
  readonly limit: number;
}

export interface CandleSeries {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  /** Ascending by open time, no duplicates. Freshness comes from the newest bar's open time. */
  readonly candles: readonly Candle[];
}

/** What a provider returned for a batch of instruments, including the ones it could not quote. */
export interface QuoteBatch {
  readonly quotes: readonly Quote[];
  /** Instrument id to the reason it has no quote, e.g. a rate limit. Never silently dropped. */
  readonly failures: ReadonlyMap<string, string>;
}

export interface MarketDataProvider {
  readonly info: SourceInfo;
  getQuotes(instrumentIds: readonly string[], signal: AbortSignal): Promise<QuoteBatch>;
  getCandles(request: CandleRequest, signal: AbortSignal): Promise<CandleSeries>;
  /** Real, venue-named depth, or `unavailable` with a reason. Never an estimate. */
  getDepth(instrumentId: string, signal: AbortSignal): Promise<DepthResult>;
}

/** Bars requested per timeframe. D1 is capped by what a provider can sensibly serve. */
export const DEFAULT_CANDLE_LIMIT: Readonly<Record<Timeframe, number>> = {
  M5: 500,
  M15: 500,
  M30: 500,
  H1: 500,
  H4: 500,
  D1: 120,
};
