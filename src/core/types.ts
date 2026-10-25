/** Chart intervals supported by the terminal, shortest first. */
export const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Length of one bar in seconds. */
export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = {
  M5: 300,
  M15: 900,
  M30: 1_800,
  H1: 3_600,
  H4: 14_400,
  D1: 86_400,
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
}

/** One OHLC bar. `time` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * What a data source declares about itself. The adapter (or its operator) chooses this; the
 * UI never infers it. Elstand has no simulated source: every value shown comes from a real
 * provider.
 *
 *  - `live`: the operator declared the provider feed real-time.
 *  - `delayed`: a real feed that is NOT declared real-time and may lag the market. This is
 *    the conservative default, because a provider's plan decides what its feed is.
 */
export type SourceMode = 'live' | 'delayed';

/**
 * What the UI may claim about a specific datum. Derived from the source mode and the
 * datum's own timestamp (see `classifyFreshness`).
 */
export type DataState = 'live' | 'delayed' | 'stale' | 'unavailable';

export interface SourceInfo {
  readonly id: string;
  readonly label: string;
  readonly mode: SourceMode;
  /** After this many ms without an update, a live or delayed datum is shown as STALE. */
  readonly staleAfterMs: number;
}
