import type { ReadableStore } from '../core/store.js';
import type { Timeframe } from '../core/types.js';
import type { MarketDataService } from '../data/service.js';

export interface PollSelection {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
}

export interface PollingOptions {
  readonly service: MarketDataService;
  readonly pollSeconds: { readonly quotes: number; readonly candles: number };
  readonly selection: ReadableStore<PollSelection>;
  /** The user's auto-refresh switch. */
  readonly enabled: ReadableStore<boolean>;
  readonly isHidden: () => boolean;
  readonly now: () => number;
  readonly setInterval: (handler: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  /** Subscribe to the tab becoming visible again; returns an unsubscribe. */
  readonly onVisible: (handler: () => void) => () => void;
}

/**
 * Keeps what is on screen current without wasting provider credits: nothing is requested
 * while the tab is hidden or auto-refresh is switched off, only the selected chart is
 * refreshed (never every instrument and timeframe), and a refresh never blanks a panel.
 * On return to a hidden tab, data older than its interval is refreshed at once.
 */
export function startPolling(options: PollingOptions): () => void {
  const { service, pollSeconds, selection, enabled } = options;
  const active = (): boolean => enabled.get() && !options.isHidden();

  const refreshQuotes = (): void => {
    if (active()) service.refreshQuotes();
  };
  const refreshCandles = (): void => {
    if (!active()) return;
    const { instrumentId, timeframe } = selection.get();
    service.refreshCandles(instrumentId, timeframe);
  };

  const quotesTimer = options.setInterval(refreshQuotes, pollSeconds.quotes * 1000);
  const candlesTimer = options.setInterval(refreshCandles, pollSeconds.candles * 1000);

  const isOlderThan = (loadedAt: number, seconds: number): boolean =>
    options.now() - loadedAt >= seconds * 1000;

  const stopVisible = options.onVisible(() => {
    if (!active()) return;
    const quotes = service.quotes.get();
    if (quotes.status === 'ready' && isOlderThan(quotes.loadedAt, pollSeconds.quotes)) {
      service.refreshQuotes();
    }
    const { instrumentId, timeframe } = selection.get();
    const candles = service.candles(instrumentId, timeframe).get();
    if (candles.status === 'ready' && isOlderThan(candles.loadedAt, pollSeconds.candles)) {
      service.refreshCandles(instrumentId, timeframe);
    }
  });

  return () => {
    options.clearInterval(quotesTimer);
    options.clearInterval(candlesTimer);
    stopVisible();
  };
}
