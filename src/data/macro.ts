/**
 * Macro feed contracts: economic calendar and global news.
 *
 * Two rules are built into the types so that no provider and no UI can bypass them:
 *  1. Every item carries source attribution.
 *  2. Impact is never a bare label. It is `{ level, classifiedBy }`, or null (shown as
 *     UNCLASSIFIED). "High impact" is a claim, and a claim needs an author.
 */

export interface SourceAttribution {
  readonly name: string;
  readonly url: string | null;
  /** When Elstand retrieved the item from the source (epoch ms). */
  readonly retrievedAt: number;
}

export type ImpactLevel = 'low' | 'medium' | 'high';

export interface ImpactClassification {
  readonly level: ImpactLevel;
  /** Who assigned this level and under which scheme, e.g. "Provider X impact rating". */
  readonly classifiedBy: string;
}

export interface CalendarEvent {
  readonly id: string;
  /** Scheduled time in UTC epoch ms. Display converts to a chosen zone; storage never does. */
  readonly timeMs: number;
  /** ISO 4217 currency the event is relevant to, e.g. "USD". */
  readonly currency: string;
  readonly country: string | null;
  readonly title: string;
  readonly impact: ImpactClassification | null;
  readonly actual: string | null;
  readonly forecast: string | null;
  readonly previous: string | null;
  readonly source: SourceAttribution;
  /** Only an ELVOID engine result may populate this. Null until one exists. */
  readonly elvoidInterpretation: string | null;
}

export interface NewsItem {
  readonly id: string;
  readonly publishedAt: number;
  readonly headline: string;
  readonly currencies: readonly string[];
  readonly source: SourceAttribution;
  readonly url: string | null;
  readonly impact: ImpactClassification | null;
  readonly elvoidInterpretation: string | null;
}

export type FeedResult<T> =
  | { readonly status: 'available'; readonly items: readonly T[]; readonly asOf: number }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface TimeRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MacroFeedProvider {
  readonly label: string;
  getCalendar(range: TimeRange, signal: AbortSignal): Promise<FeedResult<CalendarEvent>>;
  getNews(signal: AbortSignal): Promise<FeedResult<NewsItem>>;
}

export const NO_MACRO_FEED_REASON =
  'No macro-data adapter exists in this build, so there is nothing to connect. Calendar events ' +
  'and news need a licensed source with per-item attribution and a documented impact ' +
  'classification.';

/** The only macro provider in Phase 1: it says plainly that no source exists. */
export function createUnconfiguredMacroFeed(): MacroFeedProvider {
  return {
    label: 'No macro adapter',
    getCalendar: () =>
      Promise.resolve({ status: 'unavailable', reason: NO_MACRO_FEED_REASON } as const),
    getNews: () =>
      Promise.resolve({ status: 'unavailable', reason: NO_MACRO_FEED_REASON } as const),
  };
}
