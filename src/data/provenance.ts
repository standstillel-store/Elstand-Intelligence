import {
  isCapability,
  isProviderId,
  isProviderState,
  type Capability,
  type ProviderId,
  type ProviderState,
} from '../core/provider-state.js';

/**
 * Where a response came from and how much it can be trusted. The server attaches one to every
 * data response, and the browser keeps what it has seen (src/app/provider-status.ts), because
 * server instances do not share memory: the response itself is the only honest record.
 *
 * `state` is what the server could say at the moment it answered. A response that is kept
 * for a while by a CDN or the browser is older than its `state` claims, so the browser also
 * judges freshness from `retrievedAt` and `dataAsOf`, never from `state` alone.
 */

export const CACHE_ORIGINS = [
  /** The provider was asked for this response. */
  'fresh',
  /** Served from the server cache, still inside its lifetime. */
  'cache',
  /** The provider could not be asked, so the last verified answer is served (state CACHED). */
  'stale-if-error',
] as const;
export type CacheOrigin = (typeof CACHE_ORIGINS)[number];

export interface Provenance {
  readonly provider: ProviderId;
  /** Display name, e.g. "Twelve Data". */
  readonly providerLabel: string;
  readonly capability: Capability;
  /** Which of the provider's endpoints answered, e.g. "time_series". */
  readonly endpoint: string;
  readonly state: ProviderState;
  /** When the server last received a verified answer from the provider (epoch ms), if ever. */
  readonly retrievedAt: number | null;
  /** The data's own timestamp, when it has one (epoch ms). */
  readonly dataAsOf: number | null;
  readonly cache: CacheOrigin;
  /** Set when a provider other than the primary one for this capability answered. */
  readonly fallback: { readonly from: ProviderId; readonly reason: string } | null;
  /** For every state that is not plain good news: the words to show. */
  readonly message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNullableTime = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export type ProvenanceParse =
  | { readonly kind: 'parsed'; readonly value: Provenance }
  | { readonly kind: 'invalid'; readonly error: string };

/** Provenance is untrusted input in the browser, like everything else that crosses `/api`. */
export function parseProvenance(input: unknown): ProvenanceParse {
  const bad = (error: string): ProvenanceParse => ({ kind: 'invalid', error });
  if (!isRecord(input)) return bad('provenance is not an object');
  const { provider, providerLabel, capability, endpoint, state, cache } = input;
  if (!isProviderId(provider)) return bad('provenance.provider is unknown');
  if (!isText(providerLabel)) return bad('provenance.providerLabel is missing');
  if (!isCapability(capability)) return bad('provenance.capability is unknown');
  if (!isText(endpoint)) return bad('provenance.endpoint is missing');
  if (!isProviderState(state)) return bad('provenance.state is unknown');
  if (cache !== 'fresh' && cache !== 'cache' && cache !== 'stale-if-error') {
    return bad('provenance.cache is unknown');
  }
  if (!isNullableTime(input['retrievedAt']) || !isNullableTime(input['dataAsOf'])) {
    return bad('provenance times must be epoch milliseconds or null');
  }
  const message = input['message'];
  if (message !== null && !isText(message)) return bad('provenance.message must be text or null');

  const fallbackInput = input['fallback'];
  let fallback: Provenance['fallback'] = null;
  if (fallbackInput !== null) {
    if (!isRecord(fallbackInput) || !isProviderId(fallbackInput['from'])) {
      return bad('provenance.fallback is malformed');
    }
    const reason = fallbackInput['reason'];
    if (!isText(reason)) return bad('provenance.fallback.reason is missing');
    fallback = { from: fallbackInput['from'], reason };
  }

  return {
    kind: 'parsed',
    value: {
      provider,
      providerLabel,
      capability,
      endpoint,
      state,
      retrievedAt: input['retrievedAt'],
      dataAsOf: input['dataAsOf'],
      cache,
      fallback,
      message,
    },
  };
}
