import { classifyFreshness, classifySeriesFreshness } from '../core/freshness.js';
import type { DataState, SourceInfo, Timeframe } from '../core/types.js';
import type { CandleSeries, Quote } from '../data/provider.js';
import type { QuoteBook } from '../data/service.js';
import type { FeedState } from './feeds.js';

export interface QuoteView {
  /** What the interface may claim about this quote. `unavailable` when there is none. */
  readonly state: DataState;
  readonly quote: Quote | null;
  /** Why there is no quote (rate limit, rejected by validation), when there is none. */
  readonly note: string | null;
}

/** One instrument's quote and its honest freshness, derived from the shared quote feed. */
export function quoteView(
  feed: FeedState<QuoteBook>,
  instrumentId: string,
  source: SourceInfo | null,
  now: number,
): QuoteView {
  if (feed.kind === 'error') return { state: 'unavailable', quote: null, note: feed.message };
  if (feed.kind !== 'ready' || source === null)
    return { state: 'unavailable', quote: null, note: null };
  const quote = feed.value.quotes.get(instrumentId);
  if (quote === undefined) {
    return {
      state: 'unavailable',
      quote: null,
      note:
        feed.value.rejected.get(instrumentId) ??
        'The provider returned no quote for this instrument.',
    };
  }
  return {
    state: classifyFreshness({
      mode: source.mode,
      asOf: quote.asOf,
      now,
      staleAfterMs: source.staleAfterMs,
    }),
    quote,
    note: null,
  };
}

export interface SeriesView {
  readonly state: DataState;
  /** Open time of the newest bar (epoch ms), or null when there is no bar. */
  readonly newestBarOpen: number | null;
}

export function seriesView(
  feed: FeedState<CandleSeries>,
  source: SourceInfo | null,
  timeframe: Timeframe,
  now: number,
): SeriesView {
  if (feed.kind !== 'ready' || source === null)
    return { state: 'unavailable', newestBarOpen: null };
  const newest = feed.value.candles[feed.value.candles.length - 1];
  const newestBarOpen = newest === undefined ? null : newest.time;
  return {
    state: classifySeriesFreshness({
      mode: source.mode,
      newestBarOpen,
      timeframe,
      now,
      staleAfterMs: source.staleAfterMs,
    }),
    newestBarOpen,
  };
}
