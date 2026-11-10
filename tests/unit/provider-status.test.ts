import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProviderLedger } from '../../src/app/provider-ledger.js';
import { buildProviderGroups, freshnessOf, NOT_VERIFIED } from '../../src/app/provider-rows.js';
import { NO_VALUE } from '../../src/core/format.js';
import type { Provenance } from '../../src/data/provenance.js';
import type { WireProbe, WireProviderConfig } from '../../src/data/wire-providers.js';

/**
 * The provider status page is built from two things kept apart on purpose: what the server says
 * it is configured to read, and what this browser has actually been told by real requests.
 * These tests pin that separation: a variable that exists is never shown as a connection.
 *
 * The values below are test fixtures for the logic, not market data and not provider output.
 */

const T0 = Date.UTC(2026, 0, 6, 12, 0, 0);
const MINUTE = 60_000;

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    provider: 'twelvedata',
    providerLabel: 'Twelve Data',
    capability: 'forex-market-data',
    endpoint: 'quote',
    state: 'DELAYED',
    retrievedAt: T0,
    dataAsOf: T0 - MINUTE,
    cache: 'fresh',
    fallback: null,
    message: null,
    ...overrides,
  };
}

function config(overrides: Partial<WireProviderConfig> = {}): WireProviderConfig {
  return {
    id: 'twelvedata',
    label: 'Twelve Data',
    capabilities: ['forex-market-data'],
    role: 'primary',
    roleText: 'Primary source of forex quotes and candles',
    keyVariable: 'TWELVE_DATA_API_KEY',
    keyRequirement: 'required',
    baseUrlVariable: null,
    config: 'ready',
    keyed: true,
    message: null,
    limits: 'Free tier limits, as published.',
    ...overrides,
  };
}

function probe(overrides: Partial<WireProbe> = {}): WireProbe {
  return {
    provider: 'twelvedata',
    capability: 'forex-market-data',
    endpoint: 'quote',
    state: 'DELAYED',
    authentication: 'accepted',
    dataRetrieved: true,
    message: 'Twelve Data answered and its data passed validation.',
    attemptedAt: T0,
    retrievedAt: T0,
    dataAsOf: T0,
    ...overrides,
  };
}

function groupOf(
  configuration: WireProviderConfig,
  record: (ledger: ReturnType<typeof createProviderLedger>) => void = () => undefined,
  now: number = T0 + MINUTE,
) {
  const ledger = createProviderLedger();
  record(ledger);
  const [group] = buildProviderGroups([configuration], ledger.store.get(), now);
  assert.ok(group !== undefined);
  return group;
}

describe('the provider ledger', () => {
  it('starts empty and holds only what it was told', () => {
    const snapshot = createProviderLedger().store.get();
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.subjects.size, 0);
    assert.equal(snapshot.probes.size, 0);
  });

  it('keeps one entry per provider, capability and endpoint, the newest answer', () => {
    const ledger = createProviderLedger();
    ledger.record(provenance({ state: 'DELAYED' }), T0);
    ledger.record(provenance({ state: 'STALE' }), T0 + MINUTE);
    ledger.record(provenance({ endpoint: 'time_series' }), T0 + MINUTE);
    const entries = ledger.store.get().entries;
    assert.equal(entries.length, 2);
    const quote = entries.find((entry) => entry.endpoint === 'quote');
    assert.equal(quote?.state, 'STALE');
    assert.equal(quote?.attemptedAt, T0 + MINUTE);
  });

  it('remembers the last successful retrieval across a failed attempt', () => {
    const ledger = createProviderLedger();
    ledger.record(provenance(), T0);
    ledger.record(
      provenance({
        state: 'ERROR',
        retrievedAt: null,
        dataAsOf: null,
        message: 'ERROR — rejected.',
      }),
      T0 + 5 * MINUTE,
    );
    const [entry] = ledger.store.get().entries;
    assert.equal(entry?.state, 'ERROR');
    assert.equal(entry?.attemptedAt, T0 + 5 * MINUTE);
    assert.equal(entry?.lastRetrievedAt, T0, 'a failure does not erase the last good retrieval');
    assert.equal(entry?.dataAsOf, T0 - MINUTE, 'nor the data timestamp it had');
  });

  it('never moves the last retrieval backwards', () => {
    const ledger = createProviderLedger();
    ledger.record(provenance({ retrievedAt: T0 }), T0);
    ledger.record(provenance({ retrievedAt: T0 - 10 * MINUTE }), T0 + MINUTE);
    assert.equal(ledger.store.get().entries[0]?.lastRetrievedAt, T0);
  });

  it('keeps the newest provenance for each subject, apart from the endpoint entries', () => {
    const ledger = createProviderLedger();
    ledger.record(provenance({ state: 'DELAYED' }), T0, 'quote:EURUSD');
    ledger.record(provenance({ state: 'STALE' }), T0 + MINUTE, 'quote:EURUSD');
    ledger.record(provenance(), T0 + MINUTE, 'quote:XAUUSD');
    const { subjects } = ledger.store.get();
    assert.equal(subjects.size, 2);
    assert.equal(subjects.get('quote:EURUSD')?.state, 'STALE');
  });

  it('records the newest check of each provider', () => {
    const ledger = createProviderLedger();
    ledger.recordProbe(probe({ attemptedAt: T0 }));
    ledger.recordProbe(probe({ attemptedAt: T0 + MINUTE, state: 'ERROR' }));
    const { probes } = ledger.store.get();
    assert.equal(probes.size, 1);
    assert.equal(probes.get('twelvedata')?.state, 'ERROR');
  });
});

describe('the provider rows: configuration is not connection', () => {
  it('shows a provider with no supported endpoint as UNAVAILABLE, whatever the ledger holds', () => {
    const imf = config({
      id: 'imf',
      label: 'IMF',
      capabilities: ['macro-observations'],
      role: 'unavailable',
      keyVariable: null,
      keyRequirement: 'none',
      config: 'no-endpoint',
      keyed: false,
      message: 'UNAVAILABLE — No supported public endpoint is configured for this dataset.',
    });
    const group = groupOf(imf, (ledger) =>
      ledger.record(
        provenance({ provider: 'imf', providerLabel: 'IMF', capability: 'macro-observations' }),
        T0,
      ),
    );
    assert.equal(group.rows.length, 1);
    assert.equal(group.rows[0]?.status, 'UNAVAILABLE');
    assert.equal(group.rows[0]?.note, imf.message);
    assert.equal(group.rows[0]?.endpoint, null);
    assert.equal(group.configuration, 'No supported endpoint exists in this build.');
  });

  it('shows a missing variable as ENV NOT CONNECTED and names it', () => {
    const fred = config({
      id: 'fred',
      label: 'FRED',
      capabilities: ['macro-observations'],
      keyVariable: 'FRED_API_KEY',
      config: 'env-not-connected',
      keyed: false,
      message:
        'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    });
    const group = groupOf(fred);
    assert.equal(group.rows[0]?.status, 'ENV NOT CONNECTED');
    assert.equal(group.rows[0]?.note, fred.message);
    assert.equal(group.missing, 'FRED_API_KEY');
    assert.equal(group.configuration, 'FRED_API_KEY is not set.');
  });

  it('shows a variable that is set but unusable as ERROR, without the value', () => {
    const group = groupOf(
      config({
        id: 'fred',
        label: 'FRED',
        capabilities: ['macro-observations'],
        keyVariable: 'FRED_API_KEY',
        config: 'invalid',
        message: 'ERROR — FRED_API_KEY is set, but its value is not in the form FRED issues.',
      }),
    );
    assert.equal(group.rows[0]?.status, 'ERROR');
    assert.equal(group.missing, null, 'it is not missing, it is unusable');
    assert.equal(group.configuration, 'FRED_API_KEY is set, but its value cannot be used.');
  });

  it('shows a configured provider nobody has asked as CONFIGURED — NOT VERIFIED, never connected', () => {
    const group = groupOf(
      config({ capabilities: ['forex-market-data', 'economic-calendar'] }),
      () => undefined,
    );
    assert.equal(group.rows.length, 2);
    for (const row of group.rows) {
      assert.equal(row.status, NOT_VERIFIED);
      assert.equal(row.endpoint, null);
      assert.equal(row.lastSuccessAt, null);
      assert.equal(row.freshness, NO_VALUE);
    }
  });

  it('takes the status from the newest answer this browser received', () => {
    const group = groupOf(config(), (ledger) => ledger.record(provenance(), T0));
    const [row] = group.rows;
    assert.equal(row?.status, 'DELAYED');
    assert.equal(row?.endpoint, 'quote');
    assert.equal(row?.lastSuccessAt, T0);
    assert.equal(row?.lastAttemptAt, T0);
    assert.equal(row?.dataAsOf, T0 - MINUTE);
    assert.equal(row?.freshness, '2m 00s old', 'the data is two minutes old at T0 + 1 minute');
    assert.equal(row?.cached, false);
  });

  it('says when an answer was a kept copy, and when another provider answered', () => {
    const group = groupOf(config(), (ledger) =>
      ledger.record(
        provenance({
          state: 'CACHED',
          cache: 'stale-if-error',
          fallback: { from: 'twelvedata', reason: 'Twelve Data could not be reached.' },
        }),
        T0,
      ),
    );
    assert.equal(group.rows[0]?.cached, true);
    assert.equal(group.rows[0]?.fallback, 'Twelve Data could not be reached.');
  });

  it('shows one row per endpoint the browser has heard from', () => {
    const group = groupOf(config(), (ledger) => {
      ledger.record(provenance({ endpoint: 'time_series' }), T0);
      ledger.record(provenance({ endpoint: 'quote' }), T0);
    });
    assert.deepEqual(
      group.rows.map((row) => row.endpoint),
      ['quote', 'time_series'],
    );
  });
});

describe('a check applies only to what it checked', () => {
  const twoEndpoints = (ledger: ReturnType<typeof createProviderLedger>): void => {
    ledger.record(provenance({ endpoint: 'quote', state: 'DELAYED' }), T0);
    ledger.record(provenance({ endpoint: 'time_series', state: 'DELAYED' }), T0);
  };

  it('replaces the row of the endpoint it asked, and leaves the other row as it was', () => {
    const group = groupOf(config(), (ledger) => {
      twoEndpoints(ledger);
      ledger.recordProbe(
        probe({
          endpoint: 'quote',
          state: 'ERROR',
          dataRetrieved: false,
          authentication: 'rejected',
          message: 'ERROR — Twelve Data rejected the credential.',
          attemptedAt: T0 + MINUTE,
          retrievedAt: null,
          dataAsOf: null,
        }),
      );
    });
    const quote = group.rows.find((row) => row.endpoint === 'quote');
    const series = group.rows.find((row) => row.endpoint === 'time_series');
    assert.equal(quote?.status, 'ERROR');
    assert.equal(quote?.note, 'ERROR — Twelve Data rejected the credential.');
    assert.equal(quote?.lastSuccessAt, T0, 'the last good retrieval is still shown');
    assert.equal(series?.status, 'DELAYED', 'a check of the quotes says nothing about the candles');
  });

  it('ignores a check that is older than what the browser has seen since', () => {
    const group = groupOf(config(), (ledger) => {
      ledger.recordProbe(probe({ state: 'ERROR', attemptedAt: T0 - MINUTE }));
      ledger.record(provenance({ state: 'DELAYED' }), T0);
    });
    assert.equal(group.rows[0]?.status, 'DELAYED');
  });

  it('shows the checked endpoint when nothing else had been seen, and leaves other capabilities unverified', () => {
    const group = groupOf(
      config({ capabilities: ['forex-market-data', 'economic-calendar'] }),
      (ledger) => ledger.recordProbe(probe()),
    );
    const market = group.rows.find((row) => row.capability === 'forex-market-data');
    const calendar = group.rows.find((row) => row.capability === 'economic-calendar');
    assert.equal(market?.status, 'DELAYED');
    assert.equal(market?.endpoint, 'quote');
    assert.equal(calendar?.status, NOT_VERIFIED);
  });

  it('does not apply a check to a provider that is not ready', () => {
    const group = groupOf(
      config({
        config: 'env-not-connected',
        keyed: false,
        message: 'ENV NOT CONNECTED — TWELVE_DATA_API_KEY is missing. Forex data is unavailable.',
      }),
      (ledger) => ledger.recordProbe(probe()),
    );
    assert.equal(group.rows[0]?.status, 'ENV NOT CONNECTED');
  });
});

describe('the configuration in words', () => {
  it('says a keyless provider needs no credential', () => {
    const group = groupOf(
      config({ id: 'frankfurter', keyVariable: null, keyRequirement: 'none', keyed: false }),
    );
    assert.equal(group.configuration, 'No credential is needed.');
  });

  it('says whether an optional key is in use', () => {
    const optional = { keyVariable: 'BLS_API_KEY', keyRequirement: 'optional' } as const;
    assert.equal(
      groupOf(config({ ...optional, id: 'bls', keyed: true })).configuration,
      'BLS_API_KEY is set (optional).',
    );
    assert.equal(
      groupOf(config({ ...optional, id: 'bls', keyed: false })).configuration,
      'BLS_API_KEY is not set; used without a key (optional).',
    );
  });

  it('says a required key is set without ever showing it', () => {
    assert.equal(groupOf(config()).configuration, 'TWELVE_DATA_API_KEY is set.');
  });
});

describe('freshness text', () => {
  it('prefers the data timestamp, then the retrieval time, then a dash', () => {
    assert.equal(freshnessOf(T0 - 90_000, T0 - 10 * MINUTE, T0), '1m 30s old');
    assert.equal(freshnessOf(null, T0 - 10 * MINUTE, T0), 'retrieved 10m 00s ago');
    assert.equal(freshnessOf(null, null, T0), NO_VALUE);
  });
});
