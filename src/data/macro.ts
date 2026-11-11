/**
 * Macro feed contracts: economic calendar and global news.
 *
 * Two rules are built into the types so that no provider and no UI can bypass them:
 *  1. Every item carries source attribution.
 *  2. Impact is never a bare label. It is `{ level, classifiedBy }`, or null (shown as
 *     UNCLASSIFIED). "High impact" is a claim, and a claim needs an author.
 */

import type { Provenance } from './provenance.js';

/**
 * What a data provider asks to be kept with an item: the credit it wants shown, the license of
 * the underlying source and its reuse notice. Every field is the provider's own wording, shown as
 * written. Elstand composes none of it, and a field the provider did not supply is absent.
 */
export interface SourceRights {
  readonly credit?: string;
  readonly creditUrl?: string;
  readonly license?: string;
  readonly licenseUrl?: string;
  readonly notice?: string;
}

export interface SourceAttribution {
  readonly name: string;
  readonly url: string | null;
  /** When Elstand retrieved the item from the source (epoch ms). */
  readonly retrievedAt: number;
  /** The credit, license and reuse notice the provider supplied with the item, when it did. */
  readonly rights?: SourceRights;
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

/**
 * Where a feed's answer came from, for a provider that reports it (the Elstand server does).
 * A feed without it (a test double, an adapter that predates provenance) is shown as before.
 */
export interface FeedOrigin {
  /** Which provider answered, when, in which state, and from which cache. */
  readonly provenance: Provenance;
  /** The acknowledgement the data provider asks for, with its link. Null when none is asked for. */
  readonly attribution: { readonly name: string; readonly url: string } | null;
  /** Plain statements of what the list leaves out: items not shown, how many more exist. */
  readonly notes: readonly string[];
  /** For a derived answer: the provenance of every input behind it. */
  readonly inputs?: readonly Provenance[];
}

export type FeedResult<T> =
  | {
      readonly status: 'available';
      readonly items: readonly T[];
      readonly asOf: number;
      readonly origin?: FeedOrigin;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /** The provider's own statement of why (ENV NOT CONNECTED, RATE LIMITED, ERROR, …). */
      readonly origin?: FeedOrigin;
    };

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
