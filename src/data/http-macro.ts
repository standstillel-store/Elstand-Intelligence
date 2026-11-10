import { formatUtcDate } from '../core/format.js';
import type { ProviderId } from '../core/provider-state.js';
import { ApiClientError, type ApiClient } from './api-client.js';
import type { BubbleProvider, BubbleResult } from './macro-bubbles.js';
import type {
  CalendarEvent,
  FeedOrigin,
  FeedResult,
  MacroFeedProvider,
  NewsItem,
  TimeRange,
} from './macro.js';
import type { Provenance } from './provenance.js';
import {
  API_BUBBLES_PATH,
  API_CALENDAR_PATH,
  API_MACRO_PATH,
  API_NEWS_PATH,
  API_RATES_PATH,
  parseBubbles,
  parseCalendar,
  parseMacro,
  parseNews,
  parseRates,
  type WireExcluded,
  type WireMacro,
  type WireRates,
} from './wire-macro.js';
import type { Parsed } from './wire.js';

/**
 * The browser's macro providers. They talk only to the Elstand API on the same origin, never to
 * a data provider, and they ask the server every time: whether a provider is connected, rate
 * limited or failing is the server's to say, in the `provenance` of its answer, and this module
 * passes that statement on instead of deciding it again.
 *
 * Every answer's provenance is also handed to `record`, so the provider status page can show what
 * this browser has actually seen from each provider.
 */

export interface HttpMacroOptions {
  readonly client: ApiClient;
  /** Receives the provenance of every answer, with the time the answer arrived (epoch ms). */
  readonly record: (provenance: Provenance, attemptedAt: number) => void;
  readonly now: () => number;
}

/** The providers `/api/macro` answers for. IMF is not among them: it has no supported endpoint. */
export const MACRO_SERIES_PROVIDERS = ['fred', 'worldbank', 'bls', 'bea'] as const;
export type MacroSeriesProvider = (typeof MACRO_SERIES_PROVIDERS)[number];

const MAX_EXCLUDED_SHOWN = 1;

function unusable<T>(what: string, parsed: Parsed<T>): never {
  throw new ApiClientError(
    'bad_response',
    `The API sent an unusable ${what}: ${parsed.ok ? 'unknown problem' : parsed.error}.`,
  );
}

function excludedNote(what: string, excluded: readonly WireExcluded[]): string | null {
  const first = excluded.slice(0, MAX_EXCLUDED_SHOWN)[0];
  if (first === undefined) return null;
  const count = excluded.length;
  return (
    `${count} ${what}${count === 1 ? ' was' : 's were'} sent by the provider but not shown, ` +
    `because ${count === 1 ? 'it was' : 'they were'} incomplete. First: ${first.id}, ${first.reason}.`
  );
}

function present<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

export function createHttpMacroFeed(options: HttpMacroOptions): MacroFeedProvider {
  const { client } = options;
  return {
    label: 'Elstand server',

    async getCalendar(range: TimeRange, signal: AbortSignal): Promise<FeedResult<CalendarEvent>> {
      const body = await client.getJson(
        API_CALENDAR_PATH,
        { from: formatUtcDate(range.fromMs), to: formatUtcDate(range.toMs) },
        signal,
      );
      const parsed = parseCalendar(body);
      if (!parsed.ok) return unusable('calendar', parsed);
      const { provenance, data } = parsed.value;
      options.record(provenance, options.now());
      if (data === null) {
        return {
          status: 'unavailable',
          reason: provenance.message ?? provenance.state,
          origin: { provenance, attribution: null, notes: [] },
        };
      }
      const notes = present([
        data.truncated
          ? `The provider counts ${data.total === null ? 'more' : data.total} events in this window; ` +
            `only ${data.events.length} were read.`
          : null,
        excludedNote('event', data.excluded),
      ]);
      const origin: FeedOrigin = { provenance, attribution: data.attribution, notes };
      return {
        status: 'available',
        items: data.events,
        asOf: provenance.retrievedAt ?? options.now(),
        origin,
      };
    },

    async getNews(signal: AbortSignal): Promise<FeedResult<NewsItem>> {
      const body = await client.getJson(API_NEWS_PATH, {}, signal);
      const parsed = parseNews(body);
      if (!parsed.ok) return unusable('news feed', parsed);
      const { provenance, data } = parsed.value;
      options.record(provenance, options.now());
      if (data === null) {
        return {
          status: 'unavailable',
          reason: provenance.message ?? provenance.state,
          origin: { provenance, attribution: null, notes: [] },
        };
      }
      const notes = present([
        data.topic,
        data.found !== null && data.found > data.returned
          ? `${data.found} articles matched. The provider returned ${data.returned}` +
            `${data.limit === null ? '' : ` (at most ${data.limit} per request on this plan)`}, ` +
            'so this is the most recent sample, not everything published.'
          : null,
        excludedNote('article', data.excluded),
      ]);
      return {
        status: 'available',
        items: data.items,
        asOf: provenance.retrievedAt ?? options.now(),
        origin: { provenance, attribution: data.attribution, notes },
      };
    },
  };
}

export function createHttpBubbleProvider(options: HttpMacroOptions): BubbleProvider {
  const { client } = options;
  return {
    label: 'Elstand server',
    async getPoints(signal: AbortSignal): Promise<BubbleResult> {
      const body = await client.getJson(API_BUBBLES_PATH, {}, signal);
      const parsed = parseBubbles(body);
      if (!parsed.ok) return unusable('macro bubble answer', parsed);
      const { provenance, inputs, result } = parsed.value;
      const attemptedAt = options.now();
      options.record(provenance, attemptedAt);
      for (const input of inputs) options.record(input, attemptedAt);
      const origin: FeedOrigin = { provenance, attribution: null, notes: [], inputs };
      return result.status === 'available'
        ? { ...result, origin }
        : { status: 'unavailable', reason: result.reason, origin };
    },
  };
}

/** Macro observations and reference rates, answered as the server sent them. */
export interface ObservationsProvider {
  readonly label: string;
  getMacro(provider: MacroSeriesProvider, signal: AbortSignal): Promise<WireMacro>;
  getRates(signal: AbortSignal): Promise<WireRates>;
}

export function createHttpObservations(options: HttpMacroOptions): ObservationsProvider {
  const { client } = options;
  return {
    label: 'Elstand server',
    async getMacro(provider: ProviderId, signal: AbortSignal): Promise<WireMacro> {
      const body = await client.getJson(API_MACRO_PATH, { provider }, signal);
      const parsed = parseMacro(body);
      if (!parsed.ok) return unusable('macro observation answer', parsed);
      const attemptedAt = options.now();
      options.record(parsed.value.provenance, attemptedAt);
      for (const entry of parsed.value.entries) options.record(entry.provenance, attemptedAt);
      return parsed.value;
    },
    async getRates(signal: AbortSignal): Promise<WireRates> {
      const body = await client.getJson(API_RATES_PATH, {}, signal);
      const parsed = parseRates(body);
      if (!parsed.ok) return unusable('reference-rate answer', parsed);
      options.record(parsed.value.provenance, options.now());
      return parsed.value;
    },
  };
}
