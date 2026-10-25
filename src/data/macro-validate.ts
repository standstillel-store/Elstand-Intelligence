import type { CalendarEvent, ImpactClassification, NewsItem, SourceAttribution } from './macro.js';

export interface RejectedItem {
  readonly id: string;
  readonly reason: string;
}

export interface Screened<T> {
  readonly items: readonly T[];
  readonly rejected: readonly RejectedItem[];
  /**
   * Items that carried an ELVOID interpretation although no ELVOID engine is connected. The
   * interpretation is removed: only an engine's result may populate it.
   */
  readonly interpretationsRemoved: number;
}

export interface ScreenOptions {
  /** True only when a real ELVOID engine is configured. */
  readonly engineConfigured: boolean;
}

const CURRENCY = /^[A-Z]{3}$/;
const IMPACT_LEVELS: readonly string[] = ['low', 'medium', 'high'];

function sourceIssue(source: SourceAttribution): string | null {
  if (source.name.trim() === '') return 'does not name its source';
  if (!Number.isFinite(source.retrievedAt)) return 'has no retrieval time';
  return null;
}

function impactIssue(impact: ImpactClassification | null): string | null {
  if (impact === null) return null;
  if (!IMPACT_LEVELS.includes(impact.level)) return 'has an unknown impact level';
  if (impact.classifiedBy.trim() === '')
    return 'states an impact level without saying who assigned it';
  return null;
}

function screen<T extends { readonly id: string; readonly elvoidInterpretation: string | null }>(
  items: readonly T[],
  issueOf: (item: T) => string | null,
  options: ScreenOptions,
): Screened<T> {
  const accepted: T[] = [];
  const rejected: RejectedItem[] = [];
  const seen = new Set<string>();
  let interpretationsRemoved = 0;
  for (const item of items) {
    const issue =
      item.id.trim() === ''
        ? 'has no id'
        : seen.has(item.id)
          ? 'repeats an earlier id'
          : issueOf(item);
    if (issue !== null) {
      rejected.push({ id: item.id === '' ? '(no id)' : item.id, reason: issue });
      continue;
    }
    seen.add(item.id);
    if (item.elvoidInterpretation !== null && !options.engineConfigured) {
      interpretationsRemoved += 1;
      accepted.push({ ...item, elvoidInterpretation: null });
    } else {
      accepted.push(item);
    }
  }
  return { items: accepted, rejected, interpretationsRemoved };
}

/** Keeps the calendar events that are attributed and well formed; says why it dropped the rest. */
export function screenCalendar(
  events: readonly CalendarEvent[],
  options: ScreenOptions,
): Screened<CalendarEvent> {
  return screen(
    events,
    (event) => {
      if (!Number.isFinite(event.timeMs)) return 'has no valid time';
      if (!CURRENCY.test(event.currency)) return 'has no ISO 4217 currency';
      if (event.title.trim() === '') return 'has no title';
      const source = sourceIssue(event.source);
      if (source !== null) return source;
      return impactIssue(event.impact);
    },
    options,
  );
}

export function screenNews(items: readonly NewsItem[], options: ScreenOptions): Screened<NewsItem> {
  return screen(
    items,
    (item) => {
      if (!Number.isFinite(item.publishedAt)) return 'has no valid publication time';
      if (item.headline.trim() === '') return 'has no headline';
      if (!item.currencies.every((code) => CURRENCY.test(code)))
        return 'lists a malformed currency';
      const source = sourceIssue(item.source);
      if (source !== null) return source;
      return impactIssue(item.impact);
    },
    options,
  );
}
