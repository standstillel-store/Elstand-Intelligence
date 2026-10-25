import type { SourceMode } from '../core/types.js';

/**
 * Implied-volatility surface contracts.
 *
 * FX options are conventionally quoted by delta (ATM, risk reversals, butterflies), not by
 * strike. A surface whose strike axis is moneyness or strike therefore requires converting
 * those quotes under a stated convention. The axis kind is part of the data so a plotted
 * number is never ambiguous.
 */

export type StrikeAxisKind = 'log-moneyness' | 'strike-over-forward' | 'delta';

export interface VolSurface {
  /** The instrument this surface describes, by its id in the instrument registry (e.g. `EURUSD`). */
  readonly instrumentId: string;
  /** When the underlying quotes were observed (epoch ms). */
  readonly asOf: number;
  /** Where the numbers come from. */
  readonly source: string;
  readonly strikeAxis: {
    readonly kind: StrikeAxisKind;
    /** Human-readable axis title, e.g. "ln(K/F)". */
    readonly label: string;
    /** Ascending. */
    readonly values: readonly number[];
  };
  /** Days to expiry, ascending. */
  readonly expiriesDays: readonly number[];
  /** Implied volatility in percent, indexed [expiry][strike]. */
  readonly iv: readonly (readonly number[])[];
}

export type VolSurfaceResult =
  | { readonly status: 'available'; readonly surface: VolSurface; readonly mode: SourceMode }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface VolSurfaceProvider {
  readonly label: string;
  getSurface(instrumentId: string, signal: AbortSignal): Promise<VolSurfaceResult>;
}

export const NO_OPTIONS_PROVIDER_REASON =
  'No options-data adapter exists in this build, so there is nothing to connect. A real FX ' +
  'volatility surface needs vendor option quotes plus a documented delta-to-strike convention ' +
  '(spot or forward delta, premium included or not).';

/** The only surface provider in Phase 1: it says plainly that no source exists. */
export function createUnconfiguredSurfaceProvider(): VolSurfaceProvider {
  return {
    label: 'No options adapter',
    getSurface: () =>
      Promise.resolve({ status: 'unavailable', reason: NO_OPTIONS_PROVIDER_REASON } as const),
  };
}

function isStrictlyAscending(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

/** Returns a list of problems; an empty list means the surface can be drawn. */
export function validateVolSurface(surface: VolSurface): string[] {
  const issues: string[] = [];
  const strikes = surface.strikeAxis.values;
  const expiries = surface.expiriesDays;
  if (strikes.length < 2) issues.push('strike axis needs at least 2 points');
  if (expiries.length < 2) issues.push('expiry axis needs at least 2 points');
  if (!strikes.every(Number.isFinite) || !isStrictlyAscending(strikes)) {
    issues.push('strike axis must be finite and strictly ascending');
  }
  if (
    !expiries.every((value) => Number.isFinite(value) && value > 0) ||
    !isStrictlyAscending(expiries)
  ) {
    issues.push('expiry axis must be positive, finite and strictly ascending');
  }
  if (surface.iv.length !== expiries.length) {
    issues.push('iv rows do not match the expiry axis');
    return issues;
  }
  for (let row = 0; row < surface.iv.length; row += 1) {
    const values = surface.iv[row];
    if (values === undefined || values.length !== strikes.length) {
      issues.push(`iv row ${row} does not match the strike axis`);
      break;
    }
    if (!values.every((value) => Number.isFinite(value) && value > 0)) {
      issues.push(`iv row ${row} has a non-positive or non-finite value`);
      break;
    }
  }
  return issues;
}

/**
 * `validateVolSurface`, plus the check that the surface is for the instrument that was asked
 * for. A surface for another instrument is never drawn under this selection.
 */
export function validateVolSurfaceFor(surface: VolSurface, instrumentId: string): string[] {
  const issues: string[] = [];
  if (surface.instrumentId !== instrumentId) {
    issues.push(`it describes ${surface.instrumentId}, not ${instrumentId}`);
  }
  issues.push(...validateVolSurface(surface));
  return issues;
}

/**
 * After this long without a new observation a surface is shown as STALE. This is the
 * interface's own policy, not a vendor statement: options quotes move more slowly than spot, so
 * the tolerance is wider than for spot quotes, and wider again for a feed not declared real-time.
 */
export const SURFACE_STALE_AFTER_MS: Readonly<Record<SourceMode, number>> = {
  live: 10 * 60_000,
  delayed: 60 * 60_000,
};

export interface VolRange {
  readonly min: number;
  readonly max: number;
}

export function volRange(surface: VolSurface): VolRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of surface.iv) {
    for (const value of row) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return { min, max };
}
