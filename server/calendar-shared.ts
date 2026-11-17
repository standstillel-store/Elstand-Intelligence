import type { CalendarEvent, EventSurprise } from '../src/data/macro.js';
import { cleanLabel } from './parse.js';

/**
 * What every economic-calendar adapter hands back, and the few helpers they share.
 *
 * The contract is the one rule of this product applied to calendars: an adapter returns what the
 * provider said, validated, with what it could not use named in `excluded`, and what its coverage
 * leaves out named in `coverage`. A field the provider left empty is `null`, never a stand-in.
 */

export interface CalendarWindow {
  /** Inclusive start, as a UTC instant; the request names its UTC day. */
  readonly fromMs: number;
  readonly toMs: number;
}

export interface QuotaReading {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly tier: string | null;
}

export interface ExcludedEvent {
  readonly id: string;
  readonly reason: string;
}

/** The credit a provider asks for, with its link. Travels with every answer. */
export interface CalendarAttribution {
  readonly name: string;
  readonly url: string;
}

/** The instants the provider's answer actually covers. A window outside them is not "empty". */
export interface CalendarCoverage {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface CalendarFetch {
  readonly events: readonly CalendarEvent[];
  readonly excluded: readonly ExcludedEvent[];
  /** The provider's count for the window, which can exceed what was read. */
  readonly total: number | null;
  readonly truncated: boolean;
  readonly quota: QuotaReading;
  readonly attribution: CalendarAttribution;
  /** What this provider never covers or never supplies, in plain words, shown with its data. */
  readonly notes: readonly string[];
  /** When the provider only answers for a stretch of time, that stretch; otherwise null. */
  readonly coverage: CalendarCoverage | null;
}

export const NO_QUOTA: QuotaReading = { limit: null, remaining: null, tier: null };

/** A figure as a calendar writes it: a number, an optional unit suffix, nothing else. */
interface ParsedFigure {
  readonly value: number;
  /** "%", "K", "M", "B", "T" or "" : compared as written, never converted. */
  readonly unit: string;
}

const FIGURE = /^([+-]?\d+(?:\.\d+)?)\s*(%|[KMBT])?$/;

function parseFigure(text: string): ParsedFigure | null {
  const match = FIGURE.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, unit: match[2] ?? '' } : null;
}

/**
 * actual minus forecast, and only when it means something: both figures present, both plain
 * numbers, and both in the same written unit. Anything else is no surprise at all (the interface
 * says SURPRISE UNAVAILABLE); a figure is never rescaled, guessed or defaulted to make one fit.
 * The event is a single release of a single period, so the two figures share their period.
 */
export function surpriseBetween(
  actual: string | null,
  forecast: string | null,
  basis: string,
): EventSurprise | undefined {
  if (actual === null || forecast === null) return undefined;
  const a = parseFigure(actual);
  const f = parseFigure(forecast);
  if (a === null || f === null || a.unit !== f.unit) return undefined;
  return {
    value: Number((a.value - f.value).toPrecision(12)),
    unit: a.unit,
    basis,
  };
}

/** A figure the provider wrote as text. Empty text means the provider has no figure: null. */
export function figureText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return cleanLabel(value, 40);
}

/** Keeps the first of each id and orders events by time, then id, so every answer reads the same. */
export function uniqueSorted(events: readonly CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const unique = events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  unique.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  return unique;
}

/** The same events, stamped as retrieved at `retrievedAt` (a `304` confirms them again). */
export function restamped(events: readonly CalendarEvent[], retrievedAt: number): CalendarEvent[] {
  return events.map((event) => ({ ...event, source: { ...event.source, retrievedAt } }));
}
