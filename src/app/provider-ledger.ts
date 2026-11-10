import type { Capability, ProviderId, ProviderState } from '../core/provider-state.js';
import { createStore, type ReadableStore } from '../core/store.js';
import type { CacheOrigin, Provenance } from '../data/provenance.js';
import type { WireProbe } from '../data/wire-providers.js';

/**
 * What this browser has actually seen from each provider.
 *
 * The server runs as many short-lived instances, none of which can report on the others, so the
 * one dependable record of "what did provider X last do" is the `provenance` that every data
 * response carries. The ledger keeps the newest of those per provider, capability and endpoint,
 * and the newest per subject (one instrument's quote, one series of candles). It holds
 * statements the server made about real requests; it never holds data, and it never invents a
 * state: with nothing recorded, a provider has no entry.
 */

export interface LedgerEntry {
  readonly key: string;
  readonly provider: ProviderId;
  readonly providerLabel: string;
  readonly capability: Capability;
  readonly endpoint: string;
  /** The state of the newest answer this browser received for this endpoint. */
  readonly state: ProviderState;
  readonly message: string | null;
  readonly cache: CacheOrigin;
  readonly fallback: Provenance['fallback'];
  /** When this browser last received an answer for the endpoint (epoch ms). */
  readonly attemptedAt: number;
  /** When the provider last had its data verified by the server, as any answer said (epoch ms). */
  readonly lastRetrievedAt: number | null;
  /** The data's own timestamp in the newest answer that had one (epoch ms). */
  readonly dataAsOf: number | null;
}

export interface LedgerSnapshot {
  readonly entries: readonly LedgerEntry[];
  /** The newest provenance for one subject, such as `quote:EURUSD` or `candles:EURUSD:H1`. */
  readonly subjects: ReadonlyMap<string, Provenance>;
  /** The newest user-initiated check of each provider. */
  readonly probes: ReadonlyMap<ProviderId, WireProbe>;
}

export interface ProviderLedger {
  readonly store: ReadableStore<LedgerSnapshot>;
  /** Records one answer's provenance, and the subject it answered for when it has one. */
  record(provenance: Provenance, attemptedAt: number, subject?: string): void;
  /** Records the result of a check the person asked for. */
  recordProbe(probe: WireProbe): void;
}

const EMPTY: LedgerSnapshot = { entries: [], subjects: new Map(), probes: new Map() };

const keyOf = (p: Provenance): string => `${p.provider}|${p.capability}|${p.endpoint}`;

function merge(previous: LedgerEntry | undefined, p: Provenance, attemptedAt: number): LedgerEntry {
  const lastRetrievedAt =
    p.retrievedAt === null
      ? (previous?.lastRetrievedAt ?? null)
      : Math.max(p.retrievedAt, previous?.lastRetrievedAt ?? 0);
  return {
    key: keyOf(p),
    provider: p.provider,
    providerLabel: p.providerLabel,
    capability: p.capability,
    endpoint: p.endpoint,
    state: p.state,
    message: p.message,
    cache: p.cache,
    fallback: p.fallback,
    attemptedAt,
    lastRetrievedAt,
    dataAsOf: p.dataAsOf ?? previous?.dataAsOf ?? null,
  };
}

export function createProviderLedger(): ProviderLedger {
  const store = createStore<LedgerSnapshot>(EMPTY);
  return {
    store,
    record(provenance, attemptedAt, subject) {
      store.set((snapshot) => {
        const key = keyOf(provenance);
        const existing = snapshot.entries.find((entry) => entry.key === key);
        const next = merge(existing, provenance, attemptedAt);
        const entries = [...snapshot.entries.filter((entry) => entry.key !== key), next];
        const subjects =
          subject === undefined
            ? snapshot.subjects
            : new Map(snapshot.subjects).set(subject, provenance);
        return { ...snapshot, entries, subjects };
      });
    },
    recordProbe(probe) {
      store.set((snapshot) => ({
        ...snapshot,
        probes: new Map(snapshot.probes).set(probe.provider, probe),
      }));
    },
  };
}
