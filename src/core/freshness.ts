import { TIMEFRAME_SECONDS, type DataState, type SourceMode, type Timeframe } from './types.js';

export interface FreshnessInput {
  /** What the source declares about itself. */
  readonly mode: SourceMode;
  /** Timestamp of the datum itself (epoch ms), or null when there is no datum. */
  readonly asOf: number | null | undefined;
  readonly now: number;
  readonly staleAfterMs: number;
}

/**
 * Decides what the UI may claim about a datum.
 *
 * - No datum, or a non-finite timestamp: `unavailable`.
 * - Otherwise the source's own mode (`live` or `delayed`), unless the datum is older than
 *   `staleAfterMs`, in which case it is `stale`. A closed market is therefore reported as
 *   stale, which is accurate: the number is real and it is not current.
 * - Timestamps slightly in the future (clock skew) count as age zero.
 */
export function classifyFreshness(input: FreshnessInput): DataState {
  const { mode, asOf, now, staleAfterMs } = input;
  if (asOf === null || asOf === undefined || !Number.isFinite(asOf)) return 'unavailable';
  const age = Math.max(0, now - asOf);
  return age > staleAfterMs ? 'stale' : mode;
}

export interface SeriesFreshnessInput {
  readonly mode: SourceMode;
  /** Open time of the newest bar (epoch ms), or null for an empty series. */
  readonly newestBarOpen: number | null | undefined;
  readonly timeframe: Timeframe;
  readonly now: number;
  readonly staleAfterMs: number;
}

/**
 * A bar is open for its whole length, so the newest bar of a perfectly current series can be
 * nearly one bar old. A series is stale once its newest bar opened more than one bar length
 * plus the source tolerance ago.
 */
export function classifySeriesFreshness(input: SeriesFreshnessInput): DataState {
  return classifyFreshness({
    mode: input.mode,
    asOf: input.newestBarOpen,
    now: input.now,
    staleAfterMs: input.staleAfterMs + TIMEFRAME_SECONDS[input.timeframe] * 1000,
  });
}

const STATE_RANK: Readonly<Record<DataState, number>> = {
  live: 0,
  delayed: 1,
  stale: 2,
  unavailable: 3,
};

/**
 * The least trustworthy of several states, for a conclusion that rests on more than one
 * datum (a quote and a candle series): one stale input makes the whole thing stale.
 */
export function worstState(states: readonly DataState[]): DataState {
  let worst: DataState = 'live';
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  }
  return states.length === 0 ? 'unavailable' : worst;
}

/** Only live or delayed data may feed an analysis. Stale or missing data may not. */
export function isAnalysisEligible(state: DataState): boolean {
  return state === 'live' || state === 'delayed';
}

export const DATA_STATE_LABEL: Readonly<Record<DataState, string>> = {
  live: 'LIVE',
  delayed: 'DELAYED',
  stale: 'STALE',
  unavailable: 'UNAVAILABLE',
};

/** Short badge text used in dense rows. */
export const DATA_STATE_SHORT: Readonly<Record<DataState, string>> = {
  live: 'LIVE',
  delayed: 'DLY',
  stale: 'STALE',
  unavailable: 'N/A',
};

export const DATA_STATE_DESCRIPTION: Readonly<Record<DataState, string>> = {
  live: 'Real data from the provider, whose feed the operator declared real-time.',
  delayed:
    'Real data from the provider. The feed is not declared real-time, so it may lag the market.',
  stale:
    'Real data that has not updated recently. The market may be closed. Do not treat it as current.',
  unavailable: 'No data is available from the configured source.',
};
