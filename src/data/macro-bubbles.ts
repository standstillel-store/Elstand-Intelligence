import type { FeedOrigin, SourceAttribution } from './macro.js';

/**
 * Macro bubble contracts. One bubble is one currency.
 *
 *   x      policy rate, percent
 *   y      year-on-year CPI inflation, percent
 *   size   absolute one-month price change, percent
 *   color  direction of that price change (up, down, flat)
 *
 * Every value is attributed: a number with no named source and observation time is rejected
 * by `validateBubblePoints`. The encoding is documented in docs/MACRO-BUBBLES.md and on the page.
 */

export interface AttributedValue {
  readonly value: number;
  /** When the value was observed or published at its source (epoch ms). */
  readonly asOf: number;
  readonly source: SourceAttribution;
}

export interface CurrencyMacroPoint {
  /** ISO 4217 code, e.g. "USD". */
  readonly currency: string;
  readonly policyRate: AttributedValue;
  readonly cpiYoY: AttributedValue;
  readonly priceChange1m: AttributedValue & {
    /** What the change is measured against, e.g. "vs USD, close to close". */
    readonly basis: string;
  };
}

/** A currency that is not drawn, and why: a missing input is stated, never filled in. */
export interface BubbleOmission {
  /** ISO 4217 code, e.g. "GBP". */
  readonly currency: string;
  readonly reason: string;
}

export type BubbleResult =
  | {
      readonly status: 'available';
      readonly points: readonly CurrencyMacroPoint[];
      /** Currencies that are not drawn, each with the reason. Absent when the source gives none. */
      readonly omitted?: readonly BubbleOmission[];
      /** Which providers supplied the inputs, and in which state. Absent for a test double. */
      readonly origin?: FeedOrigin;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /** The server's own statement of why (ENV NOT CONNECTED, RATE LIMITED, ERROR, …). */
      readonly origin?: FeedOrigin;
    };

export interface BubbleProvider {
  readonly label: string;
  getPoints(signal: AbortSignal): Promise<BubbleResult>;
}

export const NO_BUBBLE_FEED_REASON =
  'No macro-series adapter exists in this build, so there is nothing to connect. Policy rates ' +
  'and CPI need a licensed source for each currency, and the one-month price change needs a ' +
  'stated basis. Elstand does not estimate any of them.';

/** The only bubble provider in Phase 1: it says plainly that no source exists. */
export function createUnconfiguredBubbleProvider(): BubbleProvider {
  return {
    label: 'No macro-series adapter',
    getPoints: () =>
      Promise.resolve({ status: 'unavailable', reason: NO_BUBBLE_FEED_REASON } as const),
  };
}

function attributionIssues(label: string, value: AttributedValue): string[] {
  const issues: string[] = [];
  if (!Number.isFinite(value.value)) issues.push(`${label} is not a finite number`);
  if (!Number.isFinite(value.asOf)) issues.push(`${label} has no observation time`);
  if (value.source.name.trim() === '') issues.push(`${label} does not name its source`);
  return issues;
}

/** Returns a list of problems; an empty list means the points can be drawn. */
export function validateBubblePoints(points: readonly CurrencyMacroPoint[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const code = point.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) issues.push(`"${point.currency}" is not an ISO 4217 code`);
    if (seen.has(code)) issues.push(`${code} appears more than once`);
    seen.add(code);
    issues.push(
      ...attributionIssues(`${code} policy rate`, point.policyRate),
      ...attributionIssues(`${code} CPI`, point.cpiYoY),
      ...attributionIssues(`${code} price change`, point.priceChange1m),
    );
    if (point.priceChange1m.basis.trim() === '') {
      issues.push(`${code} price change does not state its basis`);
    }
  }
  return issues;
}

export type BubbleDirection = 'up' | 'down' | 'flat';

export function bubbleDirection(change: number): BubbleDirection {
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}
