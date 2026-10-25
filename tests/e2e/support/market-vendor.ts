/**
 * TEST-ONLY. A fake Twelve Data that answers for every watchlist instrument with deterministic,
 * chart-shaped numbers, so browser tests can exercise the connected path end to end. The numbers
 * are not market data. This file must never be imported from `src/`, `server/` or `api/`.
 */
import { findInstrument, INSTRUMENTS } from '../../../src/core/instruments.js';
import { TIMEFRAME_SECONDS, type Timeframe } from '../../../src/core/types.js';
import {
  createFakeVendor,
  quotePayload,
  timeSeriesPayload,
  vendorError,
  walkCandles,
  type FakeVendor,
  type VendorCall,
  type VendorReply,
} from '../../support/fake-vendor.js';
import { FIXTURE_NOW } from '../../support/fixtures.js';

/** Where each walk starts. Plausible magnitudes only, so axes and number formats look real. */
export const START_PRICE: Readonly<Record<string, number>> = {
  EURUSD: 1.1,
  GBPUSD: 1.27,
  USDJPY: 150.5,
  AUDUSD: 0.66,
  USDCAD: 1.36,
  USDCHF: 0.88,
  NZDUSD: 0.6,
  XAUUSD: 2340,
};

export const VENDOR_INTERVAL_TO_TIMEFRAME: Readonly<Record<string, Timeframe>> = {
  '5min': 'M5',
  '15min': 'M15',
  '30min': 'M30',
  '1h': 'H1',
  '4h': 'H4',
  '1day': 'D1',
};

export interface MarketVendorOptions {
  /** The newest bar opens at or before this instant. Defaults to the fixed fixture time. */
  readonly nowMs?: number;
  /** Return a Response (or a body) to replace the normal answer for a call; undefined keeps it. */
  readonly intercept?: (call: VendorCall) => VendorReply | Promise<VendorReply>;
  /** Per-symbol overrides merged into the `/quote` body, e.g. `is_market_open: false`. */
  readonly quoteOverrides?: (symbol: string) => Record<string, unknown> | undefined;
  /** Move the newest bar back by this many whole bars, to model a feed that stopped. */
  readonly barsBehind?: number;
}

function instrumentFor(symbol: string | undefined) {
  return symbol === undefined ? undefined : findInstrument(symbol);
}

export function createMarketVendor(options: MarketVendorOptions = {}): FakeVendor {
  const nowMs = options.nowMs ?? FIXTURE_NOW;
  return createFakeVendor(async (call) => {
    const intercepted = await options.intercept?.(call);
    if (intercepted !== undefined) return intercepted;

    const instrument = instrumentFor(call.params['symbol']);
    if (instrument === undefined) return vendorError(400, 'symbol not found');
    const start = START_PRICE[instrument.id] ?? 1;
    const decimals = instrument.pricePrecision;

    if (call.path === '/quote') {
      const bars = walkCandles(60, 'H1', start, nowMs);
      const last = bars[bars.length - 1];
      const dayAgo = bars[bars.length - 25];
      if (last === undefined || dayAgo === undefined) return vendorError(500, 'fixture failure');
      const change = last.close - dayAgo.close;
      return quotePayload(instrument.symbol, {
        close: last.close.toFixed(decimals),
        previous_close: dayAgo.close.toFixed(decimals),
        change: change.toFixed(decimals),
        percent_change: ((change / dayAgo.close) * 100).toFixed(5),
        last_quote_at: nowMs / 1000,
        timestamp: nowMs / 1000,
        ...(options.quoteOverrides?.(instrument.symbol) ?? {}),
      });
    }

    if (call.path === '/time_series') {
      const interval = call.params['interval'] ?? '';
      const timeframe = VENDOR_INTERVAL_TO_TIMEFRAME[interval];
      if (timeframe === undefined) return vendorError(400, `unsupported interval ${interval}`);
      const count = Math.min(Number(call.params['outputsize'] ?? '100') || 100, 500);
      const behind = (options.barsBehind ?? 0) * TIMEFRAME_SECONDS[timeframe] * 1000;
      const bars = walkCandles(count, timeframe, start, nowMs - behind);
      return timeSeriesPayload(instrument.symbol, interval, bars, decimals);
    }
    return vendorError(404, 'unknown endpoint');
  });
}

export const ALL_SYMBOLS: readonly string[] = INSTRUMENTS.map((instrument) => instrument.symbol);
