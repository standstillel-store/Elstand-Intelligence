import { formatAge, NO_VALUE } from '../core/format.js';
import { CAPABILITY_LABEL, type Capability, type ProviderState } from '../core/provider-state.js';
import type { WireProbe, WireProviderConfig } from '../data/wire-providers.js';
import type { LedgerEntry, LedgerSnapshot } from './provider-ledger.js';

/**
 * The rows of the provider status page, built from two sources that are kept apart on purpose:
 * what the server says it is configured to read (names only, never values), and what this
 * browser has actually been told by real requests. A variable that exists is configuration; only
 * an answered, validated request is a connection. So a provider that is configured and has never
 * been asked is CONFIGURED — NOT VERIFIED, never "connected".
 */

export const NOT_VERIFIED = 'CONFIGURED — NOT VERIFIED';
export type RowStatus = ProviderState | typeof NOT_VERIFIED;

export interface ProviderRow {
  readonly key: string;
  readonly capability: Capability;
  readonly capabilityLabel: string;
  /** The endpoint that answered, or null when nothing has been asked yet. */
  readonly endpoint: string | null;
  readonly status: RowStatus;
  /** The words behind a status that is not plain good news. */
  readonly note: string | null;
  /** When the server last verified data from the provider, as this browser was told (epoch ms). */
  readonly lastSuccessAt: number | null;
  /** When this browser last received an answer, or the person's check last ran (epoch ms). */
  readonly lastAttemptAt: number | null;
  readonly dataAsOf: number | null;
  /** The age of the data, or when it was retrieved; a dash when neither is known. */
  readonly freshness: string;
  /** True when the answer was a kept copy because the provider could not be asked. */
  readonly cached: boolean;
  /** Set when a provider other than the primary one answered, with why. */
  readonly fallback: string | null;
}

export interface ProviderGroup {
  readonly config: WireProviderConfig;
  /** The configuration in words. Names a variable, never shows a value. */
  readonly configuration: string;
  /** What the missing configuration is, when something is missing (a variable name). */
  readonly missing: string | null;
  readonly rows: readonly ProviderRow[];
  /** The newest check a person asked for, if any. */
  readonly probe: WireProbe | null;
}

function configurationText(config: WireProviderConfig): string {
  if (config.config === 'no-endpoint') return 'No supported endpoint exists in this build.';
  if (config.config === 'env-not-connected') {
    return config.keyVariable === null
      ? 'A required setting is missing.'
      : `${config.keyVariable} is not set.`;
  }
  if (config.config === 'invalid') {
    return config.keyVariable === null
      ? 'A setting has a value that cannot be used.'
      : `${config.keyVariable} is set, but its value cannot be used.`;
  }
  if (config.keyRequirement === 'none' || config.keyVariable === null) {
    return 'No credential is needed.';
  }
  if (config.keyRequirement === 'optional') {
    return config.keyed
      ? `${config.keyVariable} is set (optional).`
      : `${config.keyVariable} is not set; used without a key (optional).`;
  }
  return `${config.keyVariable} is set.`;
}

function missingVariable(config: WireProviderConfig): string | null {
  return config.config === 'env-not-connected' && config.keyVariable !== null
    ? config.keyVariable
    : null;
}

export function freshnessOf(
  dataAsOf: number | null,
  lastSuccessAt: number | null,
  now: number,
): string {
  if (dataAsOf !== null) return `${formatAge(now - dataAsOf)} old`;
  if (lastSuccessAt !== null) return `retrieved ${formatAge(now - lastSuccessAt)} ago`;
  return NO_VALUE;
}

function labelled(capability: Capability): {
  readonly capability: Capability;
  readonly capabilityLabel: string;
} {
  return { capability, capabilityLabel: CAPABILITY_LABEL[capability] };
}

/** The provider cannot be asked at all: say that, whatever an old answer once said. */
function unreadyRow(config: WireProviderConfig, capability: Capability): ProviderRow {
  const status: RowStatus =
    config.config === 'no-endpoint'
      ? 'UNAVAILABLE'
      : config.config === 'env-not-connected'
        ? 'ENV NOT CONNECTED'
        : 'ERROR';
  return {
    ...labelled(capability),
    key: `${config.id}|${capability}|`,
    endpoint: null,
    status,
    note: config.message,
    lastSuccessAt: null,
    lastAttemptAt: null,
    dataAsOf: null,
    freshness: NO_VALUE,
    cached: false,
    fallback: null,
  };
}

/** Nothing prevents a request, and none has been answered: configured, not verified. */
function unaskedRow(config: WireProviderConfig, capability: Capability): ProviderRow {
  return {
    ...labelled(capability),
    key: `${config.id}|${capability}|`,
    endpoint: null,
    status: NOT_VERIFIED,
    note: 'Nothing prevents a request, but no request to this provider has been answered in this browser yet.',
    lastSuccessAt: null,
    lastAttemptAt: null,
    dataAsOf: null,
    freshness: NO_VALUE,
    cached: false,
    fallback: null,
  };
}

function seenRow(capability: Capability, entry: LedgerEntry, now: number): ProviderRow {
  return {
    ...labelled(capability),
    key: entry.key,
    endpoint: entry.endpoint,
    status: entry.state,
    note: entry.message,
    lastSuccessAt: entry.lastRetrievedAt,
    lastAttemptAt: entry.attemptedAt,
    dataAsOf: entry.dataAsOf,
    freshness: freshnessOf(entry.dataAsOf, entry.lastRetrievedAt, now),
    cached: entry.cache === 'cache' || entry.cache === 'stale-if-error',
    fallback: entry.fallback === null ? null : entry.fallback.reason,
  };
}

/** A check the person asked for, newer than anything the browser had seen for this endpoint. */
function checkedRow(
  capability: Capability,
  probe: WireProbe,
  entry: LedgerEntry | undefined,
  now: number,
): ProviderRow {
  const dataAsOf = probe.dataAsOf ?? entry?.dataAsOf ?? null;
  const lastSuccessAt = probe.retrievedAt ?? entry?.lastRetrievedAt ?? null;
  return {
    ...labelled(capability),
    key: `${probe.provider}|${capability}|${probe.endpoint}`,
    endpoint: probe.endpoint,
    status: probe.state,
    note: probe.message,
    lastSuccessAt,
    lastAttemptAt: probe.attemptedAt,
    dataAsOf,
    freshness: freshnessOf(dataAsOf, lastSuccessAt, now),
    cached: entry?.cache === 'cache' || entry?.cache === 'stale-if-error',
    fallback: null,
  };
}

/**
 * The rows of one capability. A check is one real request to one endpoint, so it is applied to
 * that capability's row for that endpoint and to nothing else: a check of the quotes says
 * nothing about the candles, and the candles row stays as the browser last saw it.
 */
function capabilityRows(
  config: WireProviderConfig,
  capability: Capability,
  entries: readonly LedgerEntry[],
  probe: WireProbe | null,
  now: number,
): ProviderRow[] {
  if (config.config !== 'ready') return [unreadyRow(config, capability)];
  const check = probe !== null && probe.capability === capability ? probe : null;
  const rows: ProviderRow[] = [];
  let checkShown = false;
  for (const entry of entries) {
    if (
      check !== null &&
      check.endpoint === entry.endpoint &&
      check.attemptedAt >= entry.attemptedAt
    ) {
      rows.push(checkedRow(capability, check, entry, now));
      checkShown = true;
    } else {
      rows.push(seenRow(capability, entry, now));
    }
  }
  if (check !== null && !checkShown && !entries.some((e) => e.endpoint === check.endpoint)) {
    rows.push(checkedRow(capability, check, undefined, now));
  }
  return rows.length === 0 ? [unaskedRow(config, capability)] : rows;
}

/**
 * One group per provider the server listed, in the server's order. Each capability the provider
 * supplies has one row per endpoint this browser has heard from, or a single row when it has
 * heard from none.
 */
export function buildProviderGroups(
  configs: readonly WireProviderConfig[],
  snapshot: LedgerSnapshot,
  now: number,
): ProviderGroup[] {
  return configs.map((config) => {
    const probe = snapshot.probes.get(config.id) ?? null;
    const rows: ProviderRow[] = [];
    for (const capability of config.capabilities) {
      const entries = snapshot.entries
        .filter((entry) => entry.provider === config.id && entry.capability === capability)
        .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
      rows.push(...capabilityRows(config, capability, entries, probe, now));
    }
    return {
      config,
      configuration: configurationText(config),
      missing: missingVariable(config),
      rows,
      probe,
    };
  });
}
