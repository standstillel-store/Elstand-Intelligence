import { formatUtcDate, formatUtcTime } from './format.js';
import type { DataState } from './types.js';

/**
 * The vocabulary for what a provider connection, and the data it supplied, can be.
 *
 * Two rules sit under it. A connection is never "working" because a variable exists: only a
 * request that was answered and validated makes data LIVE, DELAYED, CACHED or CALCULATED. And
 * every state that is not good news says so in words, never only in a color.
 *
 * Existing contracts keep working. `DataState` (live, delayed, stale, unavailable) maps onto
 * this set one to one (`providerStateOf`), and the interface keeps its established label
 * ENV NOT CONNECTION where no source is connected (src/core/connection-text.ts). The canonical
 * name used by the provider layer, and in the messages it writes, is ENV NOT CONNECTED. The
 * mapping is in docs/DATA-INTEGRITY.md.
 */

export const PROVIDER_STATES = [
  /** The provider answered a moment ago and the feed is declared real-time. */
  'LIVE',
  /** The provider answered, and its feed is not declared real-time. */
  'DELAYED',
  /** The provider could not be reached or refused; this is its last verified answer. */
  'CACHED',
  /** The newest datum is older than its documented freshness window. */
  'STALE',
  /** No datum exists, or no supported endpoint exists for the dataset. */
  'UNAVAILABLE',
  /** A required environment variable is not set on the server. */
  'ENV NOT CONNECTED',
  /** The provider (or Elstand's own budget for it) refused further requests for now. */
  'RATE LIMITED',
  /** The provider rejected the credential, answered with an error, or sent invalid data. */
  'ERROR',
  /** Derived by Elstand from real, attributed inputs (a year-on-year change, a surprise). */
  'CALCULATED',
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === 'string' && (PROVIDER_STATES as readonly string[]).includes(value);
}

export const PROVIDER_STATE_DESCRIPTION: Readonly<Record<ProviderState, string>> = {
  LIVE: 'Real data from the provider, whose feed the operator declared real-time.',
  DELAYED:
    'Real data from the provider. The feed is not declared real-time, so it may lag the market.',
  CACHED:
    'The provider could not be asked just now, so this is its last verified answer, kept on the server.',
  STALE: 'Real data that is older than its freshness window. Do not treat it as current.',
  UNAVAILABLE: 'No data is available, or no supported source exists for this dataset.',
  'ENV NOT CONNECTED': 'A server environment variable this source needs is not set.',
  'RATE LIMITED':
    'The provider, or the request budget Elstand keeps for it, allows no more requests now.',
  ERROR: 'The provider rejected the request, failed, or sent data that did not validate.',
  CALCULATED: 'Computed by Elstand from real, attributed inputs. The inputs are named.',
};

/** Existing data states map onto the canonical set. */
export function providerStateOf(state: DataState): ProviderState {
  switch (state) {
    case 'live':
      return 'LIVE';
    case 'delayed':
      return 'DELAYED';
    case 'stale':
      return 'STALE';
    case 'unavailable':
      return 'UNAVAILABLE';
  }
}

/** True for states whose numbers may be shown as data (with their own label), not as an error. */
export function carriesData(state: ProviderState): boolean {
  return (
    state === 'LIVE' ||
    state === 'DELAYED' ||
    state === 'CACHED' ||
    state === 'STALE' ||
    state === 'CALCULATED'
  );
}

// ---- providers and capabilities ---------------------------------------------------------------

export const PROVIDER_IDS = [
  'twelvedata',
  'alphavantage',
  'fred',
  'financecalendar',
  'marketaux',
  'frankfurter',
  'worldbank',
  'imf',
  'bls',
  'bea',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** What a provider is used for. A provider is only ever asked for what it can actually supply. */
export const CAPABILITIES = [
  'forex-market-data',
  'macro-observations',
  'economic-calendar',
  'financial-news',
  'reference-rates',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export const CAPABILITY_LABEL: Readonly<Record<Capability, string>> = {
  'forex-market-data': 'Forex market data',
  'macro-observations': 'Macro observations',
  'economic-calendar': 'Economic calendar',
  'financial-news': 'Financial news',
  'reference-rates': 'Exchange-rate reference data',
};

// ---- the words ----------------------------------------------------------------------------------

/** "2026-10-26 14:21 UTC": provider timestamps in messages are always UTC and always say so. */
export function formatProviderTime(timeMs: number): string {
  return `${formatUtcDate(timeMs)} ${formatUtcTime(timeMs)} UTC`;
}

/** What is lost when a variable is missing is named by the caller, e.g. "Macro observations from FRED are unavailable." */
export function envNotConnectedMessage(variable: string, consequence: string): string {
  return `ENV NOT CONNECTED — ${variable} is missing. ${consequence}`;
}

export const NO_ENDPOINT_MESSAGE =
  'UNAVAILABLE — No supported public endpoint is configured for this dataset.';

export function rateLimitedMessage(providerLabel: string, lastVerifiedMs: number | null): string {
  const lead = `RATE LIMITED — ${providerLabel} rejected the request.`;
  return lastVerifiedMs === null
    ? lead
    : `${lead} Last verified data: ${formatProviderTime(lastVerifiedMs)}.`;
}

/**
 * The same state when Elstand's own request budget for a provider is spent: the provider was not
 * asked, so it cannot be said to have rejected anything.
 */
export function budgetSpentMessage(providerLabel: string, lastVerifiedMs: number | null): string {
  const lead = `RATE LIMITED — The request budget kept for ${providerLabel} is spent, so this request was not sent.`;
  return lastVerifiedMs === null
    ? lead
    : `${lead} Last verified data: ${formatProviderTime(lastVerifiedMs)}.`;
}

export function staleMessage(lastRetrievalMs: number): string {
  return `STALE — Last successful retrieval: ${formatProviderTime(lastRetrievalMs)}. Current data could not be verified.`;
}
