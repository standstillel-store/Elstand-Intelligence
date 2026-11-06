import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findInstrument, type Instrument } from '../../src/core/instruments.js';
import { createTtlCache } from '../../server/cache.js';
import { ENV_API_KEY } from '../../server/env.js';
import { loadCandles, loadQuote, loadSpotProbe } from '../../server/forex-service.js';
import {
  ENV_ALPHA_VANTAGE_KEY,
  ENV_TWELVE_DATA_PER_DAY,
  ENV_TWELVE_DATA_PER_MINUTE,
} from '../../server/provider-registry.js';
import { createProviderRuntime } from '../../server/provider-runtime.js';
import type { Outcome, ServiceDeps } from '../../server/service.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';
import {
  createFakeProviders,
  json,
  type ProviderCallRecord,
  type ProviderReply,
} from '../support/fake-provider.js';
import { quotePayload, timeSeriesPayload, vendorError } from '../support/fake-vendor.js';

/**
 * Forex quotes and candles through Twelve Data, and the narrow fallback to Alpha Vantage. The
 * providers here are stand-ins that answer in the shape each documents; nothing proves a live
 * service answers this way today.
 */

const TD_HOST = 'api.twelvedata.com';
const AV_HOST = 'www.alphavantage.co';
const TD_KEY = 'td-test-key-1234';
const AV_KEY = 'av-test-key-1234';

const BOTH = { [ENV_API_KEY]: TD_KEY, [ENV_ALPHA_VANTAGE_KEY]: AV_KEY };

function instrument(id: string): Instrument {
  const found = findInstrument(id);
  assert.ok(found !== undefined, `${id} is a known instrument`);
  return found;
}

interface Routes {
  readonly twelve?: (call: ProviderCallRecord) => ProviderReply;
  readonly alpha?: (call: ProviderCallRecord) => ProviderReply;
}

function setup(env: Record<string, string | undefined>, routes: Routes) {
  const clock = { now: FIXTURE_NOW };
  const fake = createFakeProviders((call) => {
    if (call.host === TD_HOST && routes.twelve !== undefined) return routes.twelve(call);
    if (call.host === AV_HOST && routes.alpha !== undefined) return routes.alpha(call);
    throw new Error(`unexpected request to ${call.host}${call.path}`);
  });
  const runtime = {
    ...createProviderRuntime(createTtlCache()),
    sleep: async (): Promise<void> => {},
  };
  const deps: ServiceDeps = { env, fetch: fake.fetch, now: () => clock.now, runtime };
  const callsTo = (host: string): ProviderCallRecord[] => fake.calls.filter((c) => c.host === host);
  return { deps, clock, fake, callsTo };
}

const tdQuote = (call: ProviderCallRecord): ProviderReply =>
  quotePayload(call.params['symbol'] ?? '');

const avSpot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'Realtime Currency Exchange Rate': {
    '1. From_Currency Code': 'EUR',
    '2. From_Currency Name': 'Euro',
    '3. To_Currency Code': 'USD',
    '4. To_Currency Name': 'United States Dollar',
    '5. Exchange Rate': '1.17250000',
    '6. Last Refreshed': '2026-01-06 11:59:00',
    '7. Time Zone': 'UTC',
    '8. Bid Price': '1.17240000',
    '9. Ask Price': '1.17260000',
    ...over,
  },
});

const avBar = (open: string, high: string, low: string, close: string) => ({
  '1. open': open,
  '2. high': high,
  '3. low': low,
  '4. close': close,
});

const avDaily = (): Record<string, unknown> => ({
  'Meta Data': {
    '1. Information': 'Forex Daily Prices (open, high, low, close)',
    '2. From Symbol': 'EUR',
    '3. To Symbol': 'USD',
    '4. Output Size': 'Compact',
    '5. Last Refreshed': '2026-01-06 11:59:00',
    '6. Time Zone': 'UTC',
  },
  'Time Series FX (Daily)': {
    '2026-01-06': avBar('1.1700', '1.1760', '1.1690', '1.1725'),
    '2026-01-05': avBar('1.1650', '1.1710', '1.1640', '1.1700'),
  },
});

const limited = (): ProviderReply => vendorError(429, 'You have run out of API credits');

function dataOf<T>(outcome: Outcome<T>): Extract<Outcome<T>, { readonly kind: 'data' }> {
  assert.ok(
    outcome.kind === 'data',
    `expected data, got ${outcome.provenance.state}: ${outcome.provenance.message ?? ''}`,
  );
  return outcome;
}

function withheldOf<T>(outcome: Outcome<T>): Extract<Outcome<T>, { readonly kind: 'withheld' }> {
  assert.ok(
    outcome.kind === 'withheld',
    `expected nothing to show, got ${outcome.provenance.state}`,
  );
  return outcome;
}

describe('forex quotes', () => {
  it('come from Twelve Data, labelled DELAYED, and never touch the fallback provider', async () => {
    const { deps, callsTo } = setup(BOTH, { twelve: tdQuote });
    const outcome = dataOf(await loadQuote(deps, instrument('EURUSD')));
    assert.equal(outcome.value.instrumentId, 'EURUSD');
    assert.equal(outcome.provenance.provider, 'twelvedata');
    assert.equal(outcome.provenance.state, 'DELAYED');
    assert.equal(outcome.provenance.fallback, null);
    assert.equal(outcome.provenance.endpoint, 'quote');
    assert.equal(callsTo(AV_HOST).length, 0);
    assert.equal(callsTo(TD_HOST).length, 1);
  });

  it('are labelled LIVE only when the operator declared the feed real-time', async () => {
    const { deps } = setup({ ...BOTH, ELSTAND_FEED_REALTIME: 'true' }, { twelve: tdQuote });
    assert.equal(dataOf(await loadQuote(deps, instrument('EURUSD'))).provenance.state, 'LIVE');
  });

  it('are ENV NOT CONNECTED without the Twelve Data key, whatever else is configured', async () => {
    const { deps, fake } = setup({ [ENV_ALPHA_VANTAGE_KEY]: AV_KEY }, {});
    const outcome = withheldOf(await loadQuote(deps, instrument('EURUSD')));
    assert.equal(outcome.provenance.state, 'ENV NOT CONNECTED');
    assert.match(outcome.provenance.message ?? '', /TWELVE_DATA_API_KEY/);
    assert.equal(fake.calls.length, 0, 'a missing credential is not an outage to route around');
  });

  it('do not fall back when Twelve Data rejected the key: that needs the operator', async () => {
    const { deps, callsTo } = setup(BOTH, { twelve: () => vendorError(401, 'invalid key') });
    const outcome = withheldOf(await loadQuote(deps, instrument('EURUSD')));
    assert.equal(outcome.failure?.code, 'provider_auth');
    assert.equal(outcome.provenance.state, 'ERROR');
    assert.equal(callsTo(AV_HOST).length, 0);
  });

  it('fall back to an Alpha Vantage spot rate, said so, when Twelve Data is rate limited', async () => {
    const { deps, callsTo } = setup(BOTH, { twelve: limited, alpha: () => avSpot() });
    const outcome = dataOf(await loadQuote(deps, instrument('EURUSD')));
    assert.equal(outcome.provenance.provider, 'alphavantage');
    assert.equal(outcome.provenance.state, 'DELAYED');
    assert.equal(outcome.provenance.fallback?.from, 'twelvedata');
    assert.match(outcome.provenance.fallback?.reason ?? '', /RATE LIMITED/);
    assert.equal(outcome.value.last, 1.1725);
    assert.equal(outcome.value.asOf, Date.UTC(2026, 0, 6, 11, 59));
    assert.equal(outcome.value.changeBasis, 'not provided', 'Alpha Vantage states no day change');
    assert.equal(outcome.value.changePct, null);
    const sent = callsTo(AV_HOST)[0];
    assert.equal(sent?.params['function'], 'CURRENCY_EXCHANGE_RATE');
    assert.equal(sent?.params['from_currency'], 'EUR');
    assert.equal(sent?.params['to_currency'], 'USD');
  });

  it('fall back when Twelve Data cannot be reached or sends an invalid quote', async () => {
    const down = setup(BOTH, {
      twelve: () => {
        throw new TypeError('fetch failed');
      },
      alpha: () => avSpot(),
    });
    assert.equal(
      dataOf(await loadQuote(down.deps, instrument('EURUSD'))).provenance.provider,
      'alphavantage',
    );
    const invalid = setup(BOTH, {
      twelve: (call) => quotePayload(call.params['symbol'] ?? '', { close: '-1' }),
      alpha: () => avSpot(),
    });
    const outcome = dataOf(await loadQuote(invalid.deps, instrument('EURUSD')));
    assert.equal(outcome.provenance.fallback?.from, 'twelvedata');
    assert.match(outcome.provenance.fallback?.reason ?? '', /unusable data/);
  });

  it('never fall back for an instrument that is not a currency pair', async () => {
    const { deps, callsTo } = setup(BOTH, { twelve: limited, alpha: () => avSpot() });
    const outcome = withheldOf(await loadQuote(deps, instrument('XAUUSD')));
    assert.equal(outcome.provenance.state, 'RATE LIMITED');
    assert.equal(callsTo(AV_HOST).length, 0);
  });

  it('report the real cause when the fallback has nothing either, or is not configured', async () => {
    const neither = setup(BOTH, {
      twelve: limited,
      alpha: () => ({ Note: 'Our standard API call frequency is 5 calls per minute.' }),
    });
    const refused = withheldOf(await loadQuote(neither.deps, instrument('EURUSD')));
    assert.equal(refused.provenance.provider, 'twelvedata', 'the answer is the primary one');
    assert.equal(refused.provenance.state, 'RATE LIMITED');

    const unconfigured = setup({ [ENV_API_KEY]: TD_KEY }, { twelve: limited });
    const alone = withheldOf(await loadQuote(unconfigured.deps, instrument('EURUSD')));
    assert.equal(alone.provenance.provider, 'twelvedata');
    assert.equal(unconfigured.callsTo(AV_HOST).length, 0, 'no request is made without its key');
  });

  it('keep serving the last verified Twelve Data quote instead of substituting another provider', async () => {
    const { deps, clock, callsTo } = setup(BOTH, { twelve: tdQuote, alpha: () => avSpot() });
    dataOf(await loadQuote(deps, instrument('EURUSD')));
    // The cached answer has expired and Twelve Data now refuses. The same runtime (and so the same
    // cache) asks again, over a network where Twelve Data says no and Alpha Vantage would say yes.
    clock.now = FIXTURE_NOW + 61_000;
    const second = createFakeProviders((call) =>
      call.host === TD_HOST ? limited() : call.host === AV_HOST ? json(avSpot()) : undefined,
    );
    const later = { ...deps, fetch: second.fetch };
    const outcome = dataOf(await loadQuote(later, instrument('EURUSD')));
    assert.equal(outcome.provenance.provider, 'twelvedata');
    assert.equal(outcome.provenance.state, 'CACHED');
    assert.equal(outcome.provenance.cache, 'stale-if-error');
    assert.equal(outcome.provenance.fallback, null);
    assert.equal(second.calls.filter((c) => c.host === AV_HOST).length, 0);
    assert.equal(callsTo(AV_HOST).length, 0);
  });

  it("do not borrow a fallback when only Elstand's per-minute budget held the request back", async () => {
    const { deps, callsTo } = setup(
      { ...BOTH, [ENV_TWELVE_DATA_PER_MINUTE]: '1' },
      { twelve: tdQuote, alpha: () => avSpot() },
    );
    dataOf(await loadQuote(deps, instrument('EURUSD')));
    // One credit a minute: the second pair is held back by Elstand, and nothing is wrong.
    const held = withheldOf(await loadQuote(deps, instrument('GBPUSD')));
    assert.equal(held.failure?.local, true);
    assert.equal(held.provenance.state, 'RATE LIMITED');
    assert.match(held.provenance.message ?? '', /request budget kept for Twelve Data is spent/);
    assert.equal(
      callsTo(AV_HOST).length,
      0,
      'the small Alpha Vantage allowance is not spent on it',
    );
  });

  it('do fall back once the Twelve Data DAILY allowance is spent, which lasts until tomorrow', async () => {
    const { deps, callsTo } = setup(
      { ...BOTH, [ENV_TWELVE_DATA_PER_DAY]: '1', [ENV_TWELVE_DATA_PER_MINUTE]: '100' },
      { twelve: tdQuote, alpha: () => avSpot() },
    );
    dataOf(await loadQuote(deps, instrument('GBPUSD')));
    const outcome = dataOf(await loadQuote(deps, instrument('EURUSD')));
    assert.equal(outcome.provenance.provider, 'alphavantage');
    assert.equal(outcome.provenance.fallback?.from, 'twelvedata');
    assert.equal(callsTo(AV_HOST).length, 1);
  });
});

describe('forex candles', () => {
  const tdSeries = (call: ProviderCallRecord): ProviderReply => {
    const interval = call.params['interval'] ?? '';
    return timeSeriesPayload(
      call.params['symbol'] ?? '',
      interval,
      fixtureCandles(5, interval === '1day' ? 'D1' : 'H1'),
    );
  };

  it('come from Twelve Data and carry the time of the newest bar', async () => {
    const { deps } = setup(BOTH, { twelve: tdSeries });
    const outcome = dataOf(await loadCandles(deps, instrument('EURUSD'), 'H1'));
    assert.equal(outcome.value.length, 5);
    assert.equal(outcome.provenance.provider, 'twelvedata');
    assert.equal(outcome.provenance.endpoint, 'time_series');
    assert.equal(outcome.provenance.dataAsOf, outcome.value[4]?.time);
  });

  it('never fall back for intraday bars: no compatible intraday series exists to substitute', async () => {
    for (const timeframe of ['M5', 'M15', 'M30', 'H1', 'H4'] as const) {
      const { deps, callsTo } = setup(BOTH, { twelve: limited, alpha: () => avDaily() });
      const outcome = withheldOf(await loadCandles(deps, instrument('EURUSD'), timeframe));
      assert.equal(outcome.provenance.provider, 'twelvedata', timeframe);
      assert.equal(callsTo(AV_HOST).length, 0, `${timeframe} never reaches Alpha Vantage`);
    }
  });

  it('fall back for DAILY bars only, said so, in ascending order, with provider-given times', async () => {
    const { deps, callsTo } = setup(BOTH, { twelve: limited, alpha: () => avDaily() });
    const outcome = dataOf(await loadCandles(deps, instrument('EURUSD'), 'D1'));
    assert.equal(outcome.provenance.provider, 'alphavantage');
    assert.equal(outcome.provenance.endpoint, 'FX_DAILY');
    assert.equal(outcome.provenance.fallback?.from, 'twelvedata');
    assert.deepEqual(
      outcome.value.map((bar) => bar.time),
      [Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 6)],
    );
    assert.equal(outcome.value[1]?.close, 1.1725);
    assert.equal(callsTo(AV_HOST)[0]?.params['function'], 'FX_DAILY');
  });

  it('do not fall back for daily bars without a Twelve Data key, after a rejected key, or for gold', async () => {
    const noKey = setup({ [ENV_ALPHA_VANTAGE_KEY]: AV_KEY }, {});
    assert.equal(
      withheldOf(await loadCandles(noKey.deps, instrument('EURUSD'), 'D1')).provenance.state,
      'ENV NOT CONNECTED',
    );
    const rejected = setup(BOTH, {
      twelve: () => vendorError(401, 'invalid key'),
      alpha: () => avDaily(),
    });
    withheldOf(await loadCandles(rejected.deps, instrument('EURUSD'), 'D1'));
    assert.equal(rejected.callsTo(AV_HOST).length, 0);
    const gold = setup(BOTH, { twelve: limited, alpha: () => avDaily() });
    withheldOf(await loadCandles(gold.deps, instrument('XAUUSD'), 'D1'));
    assert.equal(gold.callsTo(AV_HOST).length, 0);
  });
});

describe('the Alpha Vantage connection check', () => {
  it('asks for one spot rate through its own cache entry, and is ENV NOT CONNECTED without a key', async () => {
    const missing = setup({}, {});
    assert.equal(
      withheldOf(await loadSpotProbe(missing.deps)).provenance.state,
      'ENV NOT CONNECTED',
    );
    assert.equal(missing.fake.calls.length, 0);

    const { deps, callsTo } = setup(BOTH, { alpha: () => avSpot() });
    const outcome = dataOf(await loadSpotProbe(deps));
    assert.equal(outcome.provenance.provider, 'alphavantage');
    assert.equal(callsTo(AV_HOST).length, 1);
    await loadSpotProbe(deps);
    assert.equal(callsTo(AV_HOST).length, 1, 'a second check inside its lifetime costs nothing');
  });
});
