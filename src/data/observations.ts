import type { ProviderId } from '../core/provider-state.js';

/**
 * Macro observations: one value for one period of one series, with the dates that decide how
 * it may be used.
 *
 * A macro number has three different times, and mixing them up is how look-ahead bias gets
 * in. `date` is the period the value describes. `knownFrom` is when the value was first
 * published, which is when anyone could have used it. `retrievedAt` (on the series) is when
 * Elstand asked. A value is never treated as known at a time before its `knownFrom`, and a
 * later revision of a value is never applied to an earlier moment (`pointsKnownAt`).
 */

export const OBSERVATION_FREQUENCIES = ['daily', 'monthly', 'quarterly', 'annual'] as const;
export type ObservationFrequency = (typeof OBSERVATION_FREQUENCIES)[number];

export function isObservationFrequency(value: unknown): value is ObservationFrequency {
  return (
    typeof value === 'string' && (OBSERVATION_FREQUENCIES as readonly string[]).includes(value)
  );
}

export interface ObservationPoint {
  /** Start of the period the value describes (epoch ms, UTC). */
  readonly date: number;
  readonly value: number;
  /** When the value was first published (epoch ms), or null when the provider does not say. */
  readonly knownFrom: number | null;
}

export interface ObservationSeries {
  readonly provider: ProviderId;
  /** The provider's own id for the series, so a reader can look it up there. */
  readonly seriesId: string;
  readonly title: string;
  readonly unit: string;
  readonly frequency: ObservationFrequency;
  readonly adjustment: 'seasonally adjusted' | 'not seasonally adjusted' | null;
  /** How the provider treats revisions of published values, in plain words. */
  readonly revisions: string;
  /** When Elstand received this series from the provider (epoch ms). */
  readonly retrievedAt: number;
  /** Ascending by `date`. */
  readonly points: readonly ObservationPoint[];
}

/**
 * How old the newest observation may be before it is STALE: the length of the period plus the
 * usual publication lag, rounded up. A value that is older than this is still real, and is
 * still shown, but it is labelled as not current. The windows are documented in
 * docs/DATA-INTEGRITY.md.
 */
export const OBSERVATION_STALE_AFTER_DAYS: Readonly<Record<ObservationFrequency, number>> = {
  daily: 7,
  monthly: 75,
  quarterly: 215,
  annual: 800,
};

const DAY_MS = 86_400_000;

export function isObservationStale(
  frequency: ObservationFrequency,
  newestDate: number,
  now: number,
): boolean {
  return now - newestDate > OBSERVATION_STALE_AFTER_DAYS[frequency] * DAY_MS;
}

export function latestPoint(series: ObservationSeries): ObservationPoint | null {
  return series.points[series.points.length - 1] ?? null;
}

/**
 * The points that could have been used at `at`. A point whose publication date is unknown is
 * not included, because it cannot be shown to have been known then.
 */
export function pointsKnownAt(series: ObservationSeries, at: number): readonly ObservationPoint[] {
  return series.points.filter((point) => point.knownFrom !== null && point.knownFrom <= at);
}

export function latestKnownAt(series: ObservationSeries, at: number): ObservationPoint | null {
  const known = pointsKnownAt(series, at);
  return known[known.length - 1] ?? null;
}

/** The same calendar day `months` earlier or later, in UTC. */
export function addMonthsUtc(timeMs: number, months: number): number {
  const date = new Date(timeMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );
}

export interface YearOnYear {
  /** Percent change of the index over twelve months. */
  readonly percent: number;
  readonly latest: ObservationPoint;
  readonly base: ObservationPoint;
}

/**
 * Year-on-year change of an index series: the newest observation against the observation
 * twelve months before it. Nothing is estimated: if the base month is missing, there is no
 * answer. With `at`, only values that were known at that time are used.
 */
export function yearOnYear(series: ObservationSeries, at: number | null = null): YearOnYear | null {
  if (series.frequency !== 'monthly') return null;
  const points = at === null ? series.points : pointsKnownAt(series, at);
  const latest = points[points.length - 1];
  if (latest === undefined) return null;
  const baseDate = addMonthsUtc(latest.date, -12);
  const base = points.find((point) => point.date === baseDate);
  if (base === undefined || !(base.value > 0)) return null;
  return { percent: (latest.value / base.value - 1) * 100, latest, base };
}

/** Returns a list of problems; an empty list means the series can be used. */
export function validateSeries(series: ObservationSeries, now: number): string[] {
  const issues: string[] = [];
  const name = `${series.provider}:${series.seriesId}`;
  if (series.seriesId.trim() === '') issues.push('a series has no id');
  if (series.unit.trim() === '') issues.push(`${name} does not state its unit`);
  if (!Number.isFinite(series.retrievedAt)) issues.push(`${name} has no retrieval time`);
  let previous = Number.NEGATIVE_INFINITY;
  series.points.forEach((point, index) => {
    if (!Number.isFinite(point.value)) issues.push(`${name} point ${index} is not a finite number`);
    if (!Number.isFinite(point.date)) issues.push(`${name} point ${index} has no period date`);
    if (point.date <= previous) issues.push(`${name} point ${index} is not in ascending order`);
    previous = point.date;
    if (point.knownFrom !== null) {
      if (!Number.isFinite(point.knownFrom)) {
        issues.push(`${name} point ${index} has a malformed publication date`);
      } else if (point.knownFrom < point.date) {
        issues.push(`${name} point ${index} was published before its period began`);
      } else if (point.knownFrom > Math.max(now, series.retrievedAt) + DAY_MS) {
        issues.push(`${name} point ${index} claims a publication date in the future`);
      }
    }
  });
  return issues;
}
