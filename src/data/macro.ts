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

/**
 *  - `exact`: `timeMs` is a scheduled instant that the source states.
 *  - `date`: the source gives the day only. `timeMs` is 00:00 UTC of that day, a placeholder
 *    that is never shown as a time, never counted down to and never drawn as an event wave.
 * An event without the field is `exact` (the contract before time precision existed).
 */
export type EventTimePrecision = 'exact' | 'date';

/** What the source says about the event's schedule. Only what it states is ever set. */
export type EventStatus = 'scheduled' | 'estimated' | 'released' | 'rescheduled' | 'cancelled';

/** A difference Elstand computed from two figures the source supplied (state CALCULATED). */
export interface EventSurprise {
  /** actual minus forecast, in the unit of the figures. */
  readonly value: number;
  readonly unit: string;
  readonly basis: string;
}

export interface CalendarEvent {
  readonly id: string;
  /** Scheduled time in UTC epoch ms. Display converts to a chosen zone; storage never does. */
  readonly timeMs: number;
  readonly timePrecision?: EventTimePrecision;
  readonly status?: EventStatus;
  /** The source's own wording for the release stage (e.g. "preliminary"), shown as written. */
  readonly stage?: string;
  /** Present only when the source supplied both an actual and a forecast in the same unit. */
  readonly surprise?: EventSurprise;
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

/**
 * The sentiment a news provider attached to an article. It is the provider's number, kept apart
 * from everything Elstand derives, and it is never an Elstand prediction.
 */
export interface ProviderSentiment {
  /** The provider's score, in the provider's own scale (Marketaux: -1 to 1). */
  readonly score: number;
  /** How to read it, in the provider's words, e.g. "Marketaux entity sentiment". */
  readonly basis: string;
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
  /** The publisher the provider names (a news source, not the data provider), when it says. */
  readonly publisher?: string;
  readonly providerSentiment?: ProviderSentiment;
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
