import {
  budgetSpentMessage,
  formatProviderTime,
  rateLimitedMessage,
  staleMessage,
  type Capability,
  type ProviderId,
  type ProviderState,
} from '../src/core/provider-state.js';
import type { Provenance } from '../src/data/provenance.js';
import type { Served } from './cache.js';
import { policyFor, type DataClass } from './cache-policy.js';
import type { Env } from './env.js';
import { ApiFailure, toApiFailure } from './errors.js';
import type { BudgetRequest, BudgetSpec } from './limiter.js';
import { budgetFor, readProvider, type ProviderReading } from './provider-registry.js';
import { serve, type ProviderRuntime } from './provider-runtime.js';

/**
 * The one path every capability service takes to a provider, so that every answer states, in the
 * same words, what it is.
 *
 *   configuration -> cache -> request budget -> bounded retry -> (last verified answer)
 *
 * The result is either DATA, with a provenance that says which provider answered, when, how old
 * the newest datum is and whether the answer came from the server cache, or WITHHELD, with a
 * provenance that says why there is nothing to show (no credential, no endpoint, rate limited,
 * error). A withheld result is never an empty list dressed up as "no events": it says that the
 * provider was not heard from.
 *
 * Nothing here decides what the data MEANS. That stays with the adapters, which validate, and
 * the browser, which validates again.
 */

export interface ServiceDeps {
  readonly env: Env;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly runtime: ProviderRuntime;
}

export type ReadyProvider = Extract<ProviderReading, { readonly kind: 'ready' }>;

export type Outcome<T> =
  | {
      readonly kind: 'data';
      readonly value: T;
      readonly provenance: Provenance;
      /** How long a shared cache may keep this answer: the rest of its lifetime, or briefly. */
      readonly shareMs: number;
    }
  | {
      readonly kind: 'withheld';
      readonly provenance: Provenance;
      /** The failure that left nothing to show, or null when the provider was never asked. */
      readonly failure: ApiFailure | null;
    };

export interface ThroughSpec<T> {
  readonly provider: ProviderId;
  readonly capability: Capability;
  /** Which of the provider's endpoints is asked, e.g. "series/observations". */
  readonly endpoint: string;
  readonly dataClass: DataClass;
  readonly cacheKey: string;
  /** What one upstream attempt costs against the provider's budget. Default 1. */
  readonly cost?: number;
  /**
   * Keeps a share of the provider's budget for this endpoint alone (0 to 1), so that one busy
   * endpoint cannot use up what another needs.
   */
  readonly endpointShare?: number;
  /** One upstream attempt, already parsed and validated by the adapter. */
  readonly load: (ready: ReadyProvider) => Promise<T>;
  /** The time of the newest datum in the answer, or null when it has none. */
  readonly dataAsOf: (value: T) => number | null;
  /** How old the newest datum may be before the answer is STALE. Default: the class's window. */
  readonly datumFreshMs?: number;
  /**
   * Overrides the age check when age alone says nothing, e.g. a quote from a market that is
   * closed is not stale because it is two days old.
   */
  readonly isCurrent?: (value: T, now: number) => boolean;
  /** Words for that window, e.g. "75 days", used in the STALE message. */
  readonly datumFreshText?: string;
  /** True only when the operator declared this feed real-time and this data qualifies. */
  readonly live?: boolean;
}

/** A shared cache keeps a degraded answer only briefly, so recovery is seen quickly. */
const DEGRADED_SHARE_MS = 30_000;

function shareOf(budget: BudgetSpec, share: number): BudgetSpec {
  const part = (limit: number | null): number | null =>
    limit === null ? null : Math.max(1, Math.floor(limit * share));
  return { perMinute: part(budget.perMinute), perDay: part(budget.perDay) };
}

/**
 * The RATE LIMITED words. When the provider refused, it "rejected the request"; when Elstand's own
 * budget refused, nothing was sent, and saying the provider rejected anything would be untrue.
 */
function rateLimitText(label: string, lastVerifiedMs: number | null, failure: ApiFailure): string {
  return failure.local
    ? budgetSpentMessage(label, lastVerifiedMs)
    : rateLimitedMessage(label, lastVerifiedMs);
}

/** Why a provider could not be asked, in a few plain words, for the CACHED message. */
function reasonOf(failure: ApiFailure): string {
  switch (failure.code) {
    case 'provider_auth':
      return 'it rejected the configured credential';
    case 'rate_limited':
      return 'it, or the request budget kept for it, refused further requests';
    case 'provider_unreachable':
      return 'it could not be reached';
    default:
      return 'it failed or sent data that did not validate';
  }
}

function provenanceFor<T>(
  spec: ThroughSpec<T>,
  label: string,
  fields: Pick<Provenance, 'state' | 'retrievedAt' | 'dataAsOf' | 'cache' | 'fallback' | 'message'>,
): Provenance {
  return {
    provider: spec.provider,
    providerLabel: label,
    capability: spec.capability,
    endpoint: spec.endpoint,
    ...fields,
  };
}

/** The state and words for a provider that cannot be asked at all, before any request is made. */
export function unreadyProvenance(
  provider: ProviderId,
  capability: Capability,
  endpoint: string,
  reading: Exclude<ProviderReading, { readonly kind: 'ready' }>,
): Provenance {
  const state: ProviderState =
    reading.kind === 'env-missing'
      ? 'ENV NOT CONNECTED'
      : reading.kind === 'no-endpoint'
        ? 'UNAVAILABLE'
        : 'ERROR';
  return {
    provider,
    providerLabel: reading.spec.label,
    capability,
    endpoint,
    state,
    retrievedAt: null,
    dataAsOf: null,
    cache: 'fresh',
    fallback: null,
    message: reading.message,
  };
}

/** The state and words for a request that failed and left nothing to show. */
function failedProvenance<T>(spec: ThroughSpec<T>, label: string, failure: ApiFailure): Provenance {
  const rateLimited = failure.code === 'rate_limited';
  return provenanceFor(spec, label, {
    state: rateLimited ? 'RATE LIMITED' : 'ERROR',
    retrievedAt: null,
    dataAsOf: null,
    cache: 'fresh',
    fallback: null,
    message: rateLimited ? rateLimitText(label, null, failure) : `ERROR — ${failure.message}`,
  });
}

function describeAnswer<T>(
  spec: ThroughSpec<T>,
  label: string,
  served: Served<T>,
  dataAsOf: number | null,
  freshWindowMs: number,
  now: number,
): Pick<Provenance, 'state' | 'message'> {
  const datumWindow = spec.datumFreshMs ?? freshWindowMs;
  const datumOld =
    spec.isCurrent !== undefined
      ? !spec.isCurrent(served.value, now)
      : dataAsOf !== null && now - dataAsOf > datumWindow;

  if (served.origin === 'stale-if-error' && served.failure !== null) {
    const retrievalOld = now - served.retrievedAt > freshWindowMs;
    if (retrievalOld || datumOld) {
      return { state: 'STALE', message: staleMessage(served.retrievedAt) };
    }
    return {
      state: 'CACHED',
      message:
        served.failure.code === 'rate_limited'
          ? rateLimitText(label, served.retrievedAt, served.failure)
          : `CACHED — ${label} could not be asked: ${reasonOf(served.failure)}. Showing its last verified answer, retrieved ${formatProviderTime(served.retrievedAt)}.`,
    };
  }
  if (datumOld) {
    const window = spec.datumFreshText ?? 'its freshness window';
    const from = dataAsOf === null ? 'an unknown time' : formatProviderTime(dataAsOf);
    return {
      state: 'STALE',
      message: `STALE — The newest datum is from ${from}, older than ${window}. Last successful retrieval: ${formatProviderTime(served.retrievedAt)}.`,
    };
  }
  return { state: spec.live === true ? 'LIVE' : 'DELAYED', message: null };
}

export async function through<T>(deps: ServiceDeps, spec: ThroughSpec<T>): Promise<Outcome<T>> {
  const reading = readProvider(spec.provider, deps.env);
  if (reading.kind !== 'ready') {
    return {
      kind: 'withheld',
      provenance: unreadyProvenance(spec.provider, spec.capability, spec.endpoint, reading),
      failure: null,
    };
  }
  const label = reading.spec.label;
  const policy = policyFor(deps.env, spec.dataClass);
  const cost = spec.cost ?? 1;
  const providerBudget = budgetFor(spec.provider, deps.env, reading.apiKey !== null);
  const budgets: BudgetRequest[] = [{ key: spec.provider, budget: providerBudget, cost }];
  if (spec.endpointShare !== undefined) {
    budgets.push({
      key: `${spec.provider}:${spec.endpoint}`,
      budget: shareOf(providerBudget, spec.endpointShare),
      cost,
    });
  }

  let served: Served<T>;
  try {
    served = await serve(deps.runtime, deps, {
      provider: spec.provider,
      endpoint: spec.endpoint,
      cacheKey: spec.cacheKey,
      policy: { ttlMs: policy.ttlMs, staleIfErrorMs: policy.staleIfErrorMs },
      budgets,
      load: () => spec.load(reading),
    });
  } catch (error) {
    const failure = toApiFailure(error);
    // A request this server built wrongly is a defect, not a provider state: let it surface.
    if (failure.code === 'bad_request') throw failure;
    return { kind: 'withheld', provenance: failedProvenance(spec, label, failure), failure };
  }

  const now = deps.now();
  const dataAsOf = spec.dataAsOf(served.value);
  const { state, message } = describeAnswer(
    spec,
    label,
    served,
    dataAsOf,
    policy.freshWindowMs,
    now,
  );
  const degraded = served.origin === 'stale-if-error' || state === 'STALE';
  const remaining = served.retrievedAt + policy.ttlMs - now;
  return {
    kind: 'data',
    value: served.value,
    shareMs: degraded ? DEGRADED_SHARE_MS : Math.max(1_000, remaining),
    provenance: provenanceFor(spec, label, {
      state,
      retrievedAt: served.retrievedAt,
      dataAsOf,
      cache: served.origin,
      fallback: null,
      message,
    }),
  };
}

/** The same answer, stamped as having come from a fallback for `from`. */
export function asFallback<T>(outcome: Outcome<T>, from: ProviderId, reason: string): Outcome<T> {
  if (outcome.kind !== 'data') return outcome;
  return {
    ...outcome,
    provenance: { ...outcome.provenance, fallback: { from, reason } },
  };
}

/** Plain text for a failed primary, used as the reason on a fallback's provenance. */
export function failureReason(provenance: Provenance): string {
  return provenance.message ?? `${provenance.providerLabel} did not answer.`;
}

/** The credential of a provider that was read as ready, or a failure if it has none. */
export function credentialOf(ready: ReadyProvider): string {
  if (ready.apiKey === null) {
    throw new ApiFailure('not_connected', `The ${ready.spec.label} credential is missing.`);
  }
  return ready.apiKey;
}

/**
 * How bad each state is for someone relying on the data, worst highest. A group of answers is
 * summarized by its worst member, and a value derived from several inputs is never presented as
 * better than its worst input.
 */
const SEVERITY: Readonly<Record<ProviderState, number>> = {
  'ENV NOT CONNECTED': 8,
  ERROR: 7,
  'RATE LIMITED': 6,
  UNAVAILABLE: 5,
  STALE: 4,
  CACHED: 3,
  DELAYED: 1,
  CALCULATED: 1,
  LIVE: 0,
};

export function severityOf(state: ProviderState): number {
  return SEVERITY[state];
}

/** The worst provenance of a group (the first wins a tie), or null for an empty group. */
export function worstProvenance(list: readonly Provenance[]): Provenance | null {
  let worst: Provenance | null = null;
  for (const item of list) {
    if (worst === null || severityOf(item.state) > severityOf(worst.state)) worst = item;
  }
  return worst;
}
