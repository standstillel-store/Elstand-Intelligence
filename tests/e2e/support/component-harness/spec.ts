/** TEST-ONLY. What a browser test asks the component harness to mount. Plain data, so it can cross into the page. */

export type DepthVariant =
  | 'unavailable'
  | 'available'
  | 'stale'
  | 'crossed'
  | 'wrong-instrument'
  | 'deep'
  | 'error'
  | 'fail-then-succeed';
export type EngineVariant =
  | 'none'
  | 'validated'
  | 'wait'
  | 'researching'
  | 'error'
  | 'forbidden-field'
  | 'wrong-selection'
  | 'pending'
  | 'fail-then-succeed';
export type SurfaceVariant =
  | 'unavailable'
  | 'available'
  | 'invalid'
  | 'error'
  | 'pending'
  | 'stale'
  | 'wrong-instrument';
export type BubbleVariant = 'unavailable' | 'available' | 'invalid' | 'error' | 'single';
export type FeedVariant = 'unavailable' | 'available' | 'empty' | 'error';

export interface HarnessSpec {
  /** The hash route to open, e.g. `#/forex/EURUSD/H1`. */
  readonly hash: string;
  readonly depth?: DepthVariant;
  readonly engine?: EngineVariant;
  readonly surface?: SurfaceVariant;
  readonly bubbles?: BubbleVariant;
  readonly calendar?: FeedVariant;
  readonly news?: FeedVariant;
  /** Milliseconds added to the fixture clock, to age every datum without waiting. */
  readonly nowOffsetMs?: number;
}

export interface HarnessApi {
  mount(spec: HarnessSpec): void;
  unmount(): void;
  /** Resolves the engine run that a `pending` engine is holding. */
  release(): void;
  /** Moves the fixture clock forward. The application's own clock picks it up on its next tick. */
  advance(ms: number): void;
  /** Every request the fake engine received, in order. */
  readonly requests: readonly { readonly instrumentId: string; readonly timeframe: string }[];
  /** Every window the calendar was asked for, in order. */
  readonly calendarRanges: readonly { readonly fromMs: number; readonly toMs: number }[];
}
