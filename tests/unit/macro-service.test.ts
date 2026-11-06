import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findInstrument } from '../../src/core/instruments.js';
import type { ObservationSeries } from '../../src/data/observations.js';
import type { Provenance } from '../../src/data/provenance.js';
import { createTtlCache } from '../../server/cache.js';
import { ENV_API_KEY } from '../../server/env.js';
import {
  isMacroProvider,
  judgeDatum,
  loadBubbles,
  loadMacro,
  priceChangeOver,
  type MacroAnswer,
} from '../../server/macro-service.js';
import {
  ENV_ALPHA_VANTAGE_KEY,
  ENV_BEA_KEY,
  ENV_FRED_KEY,
} from '../../server/provider-registry.js';
import { createProviderRuntime } from '../../server/provider-runtime.js';
import type { ServiceDeps } from '../../server/service.js';
import { FIXTURE_NOW } from '../support/fixtures.js';
import { createFakeProviders, json, type ProviderReply } from '../support/fake-provider.js';
import { vendorError } from '../support/fake-vendor.js';
import {
  DAY,
  avDailyPayload,
  blsMonths,
  dailyBars,
  day,
  fredMonthly,
  fredRoute,
  twelveRoute,
  type Route,
} from '../support/macro-fixtures.js';

/**
 * Macro observations and the macro bubbles, through stand-ins that answer in the shapes the
 * providers document. They prove the freshness rules, the provenance and the refusal to fill
 * gaps. They do not prove that any live provider answers this way today.
 */

const T0 = FIXTURE_NOW; // 2026-01-06 12:00 UTC
// A FRED key is 32 lowercase letters and digits; built here so no key-shaped literal is written out.
const KEY = 'a1'.repeat(16);

const FRED_ENV = { [ENV_FRED_KEY]: KEY };
const BUBBLE_ENV = { [ENV_FRED_KEY]: KEY, [ENV_API_KEY]: 'td-test-key-1234' };

function setup(env: Record<string, string | undefined>, route: Route) {
  const clock = { now: T0 };
  const fake = createFakeProviders(route);
  const runtime = {
    ...createProviderRuntime(createTtlCache()),
    sleep: async (): Promise<void> => {},
  };
  const deps: ServiceDeps = { env, fetch: fake.fetch, now: () => clock.now, runtime };
  return { deps, clock, fake };
}

function seriesOf(over: Partial<ObservationSeries> = {}): ObservationSeries {
  return {
    provider: 'fred',
    seriesId: 'TEST',
    title: 'A test series',
    unit: 'percent',
    frequency: 'monthly',
    adjustment: null,
    revisions: 'not revised',
    retrievedAt: T0,
    points: [{ date: day(2025, 11, 1), value: 1, knownFrom: null }],
    ...over,
  };
}

const delayed = (over: Partial<Provenance> = {}): Provenance => ({
  provider: 'fred',
  providerLabel: 'FRED',
  capability: 'macro-observations',
  endpoint: 'series/observations',
  state: 'DELAYED',
  retrievedAt: T0,
  dataAsOf: null,
  cache: 'fresh',
  fallback: null,
  message: null,
  ...over,
});

const entryOf = (answer: MacroAnswer, key: string) => {
  const found = answer.entries.find((entry) => entry.key === key);
  assert.ok(found !== undefined, `the answer has an entry ${key}`);
  return found;
};

// ---- freshness per series --------------------------------------------------------------------------

describe('judging the age of one series', () => {
  it('keeps the state of a current datum and records the time of the newest one', () => {
    const judged = judgeDatum(delayed(), seriesOf(), T0);
    assert.equal(judged.state, 'DELAYED');
    assert.equal(judged.dataAsOf, day(2025, 11, 1));
  });

  it('labels an old datum STALE for ITS frequency: a monthly index is stale after 75 days, a daily rate after 7', () => {
    const monthly = seriesOf({ points: [{ date: day(2025, 10, 20), value: 1, knownFrom: null }] });
    const old = judgeDatum(delayed(), monthly, T0); // 78 days
    assert.equal(old.state, 'STALE');
    assert.match(
      old.message ?? '',
      /^STALE — The newest observation is for 2025-10-20, older than 75 days\./,
    );
    assert.match(old.message ?? '', /Last successful retrieval: /);

    const sameAge = seriesOf({
      frequency: 'daily',
      points: [{ date: day(2025, 12, 20), value: 3.75, knownFrom: null }],
    });
    assert.equal(
      judgeDatum(delayed(), sameAge, T0).state,
      'STALE',
      '17 days is old for a daily rate',
    );

    const slow = seriesOf({
      frequency: 'annual',
      points: [{ date: day(2024, 1, 1), value: 2.1, knownFrom: null }],
    });
    assert.equal(
      judgeDatum(delayed(), slow, T0).state,
      'DELAYED',
      '735 days is current for an annual figure',
    );
  });

  it('turns a CACHED answer with an old datum into STALE, with the retrieval time that matters', () => {
    const monthly = seriesOf({ points: [{ date: day(2025, 6, 1), value: 1, knownFrom: null }] });
    const judged = judgeDatum(
      delayed({ state: 'CACHED', retrievedAt: T0 - DAY, cache: 'stale-if-error' }),
      monthly,
      T0,
    );
    assert.equal(judged.state, 'STALE');
    assert.match(judged.message ?? '', /^STALE — Last successful retrieval: /);
  });

  it('never improves a state, and does not touch one that already says nothing was retrieved', () => {
    const monthly = seriesOf({ points: [{ date: day(2025, 6, 1), value: 1, knownFrom: null }] });
    assert.equal(judgeDatum(delayed({ state: 'ERROR' }), monthly, T0).state, 'ERROR');
    assert.equal(judgeDatum(delayed({ state: 'CACHED' }), seriesOf(), T0).state, 'CACHED');
  });
});

// ---- the four macro providers -----------------------------------------------------------------------

describe('macro observations from FRED', () => {
  it('are ENV NOT CONNECTED, in the documented words, without the key, and nothing is asked', async () => {
    const { deps, fake } = setup({}, () => {
      throw new Error('nothing may be requested');
    });
    const answer = await loadMacro(deps, 'fred');
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(answer.entries, []);
    assert.equal(answer.provenance.state, 'ENV NOT CONNECTED');
    assert.equal(
      answer.provenance.message,
      'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    );
  });

  it('carry values, units, the period they describe and their own provenance, and never the key', async () => {
    const { deps, fake } = setup(FRED_ENV, fredRoute());
    const answer = await loadMacro(deps, 'fred');
    assert.equal(fake.calls.length, 4, 'one request per series');
    assert.equal(answer.entries.length, 4);
    assert.equal(answer.provenance.state, 'DELAYED');
    assert.ok(!JSON.stringify(answer).includes(KEY));

    const rate = entryOf(answer, 'fred:DFEDTARU');
    assert.equal(rate.series?.unit, 'percent');
    assert.equal(rate.series?.frequency, 'daily');
    assert.equal(rate.provenance.state, 'DELAYED');
    assert.equal(rate.provenance.dataAsOf, day(2026, 1, 5));
    assert.equal(rate.provenance.provider, 'fred');
    assert.equal(rate.link, 'https://fred.stlouisfed.org/series/DFEDTARU');
    assert.equal(rate.series?.points.at(-1)?.value, 3.75);

    const cpi = entryOf(answer, 'fred:CPIAUCNS');
    assert.equal(cpi.series?.points.length, 13);
    assert.equal(cpi.series?.points[0]?.date, day(2024, 11, 1));
    assert.equal(cpi.series?.points.at(-1)?.date, day(2025, 11, 1));
    assert.equal(
      cpi.series?.points.at(-1)?.knownFrom,
      day(2025, 12, 16),
      'the first-publication date is kept, so no value is used before it was known',
    );
  });

  it('judge each series against its own window and let the group say its worst state', async () => {
    const { deps } = setup(
      FRED_ENV,
      // The euro-area price index is three months behind; the rest are current.
      fredRoute({ CP0000EZ19M086NEST: fredMonthly(13, 2025, 9, 124, 0.2) }),
    );
    const answer = await loadMacro(deps, 'fred');
    assert.equal(entryOf(answer, 'fred:CP0000EZ19M086NEST').provenance.state, 'STALE');
    assert.equal(entryOf(answer, 'fred:CPIAUCNS').provenance.state, 'DELAYED');
    assert.equal(entryOf(answer, 'fred:DFEDTARU').provenance.state, 'DELAYED');
    assert.equal(answer.provenance.state, 'STALE', 'the group is no better than its worst member');
  });

  it('keep the series that answered when another failed, and say which one did not', async () => {
    const { deps } = setup(FRED_ENV, fredRoute({ ECBDFR: { units: 'pch', observations: [] } }));
    const answer = await loadMacro(deps, 'fred');
    const failed = entryOf(answer, 'fred:ECBDFR');
    assert.equal(failed.series, null);
    assert.equal(failed.provenance.state, 'ERROR');
    assert.equal(entryOf(answer, 'fred:DFEDTARU').series?.points.length, 2);
    assert.equal(answer.provenance.state, 'ERROR');
  });

  it('report a rejected key as an error on every series, without retrying and without echoing it', async () => {
    const { deps, fake } = setup(FRED_ENV, () =>
      json(
        { error_code: 400, error_message: `Bad Request. api_key is not registered: ${KEY}` },
        400,
        {},
      ),
    );
    const answer = await loadMacro(deps, 'fred');
    assert.equal(fake.calls.length, 4, 'one request each, no retry of an authentication failure');
    for (const entry of answer.entries) {
      assert.equal(entry.provenance.state, 'ERROR', entry.key);
      assert.equal(entry.series, null);
    }
    assert.ok(!JSON.stringify(answer).includes(KEY));
  });

  it('serve the cache inside its lifetime, and label it CACHED when the provider then fails', async () => {
    const { deps, clock, fake } = setup(FRED_ENV, fredRoute());
    await loadMacro(deps, 'fred');
    clock.now = T0 + 60_000;
    const again = await loadMacro(deps, 'fred');
    assert.equal(fake.calls.length, 4, 'nothing new was asked');
    assert.equal(entryOf(again, 'fred:DFEDTARU').provenance.cache, 'cache');

    clock.now = T0 + 7 * 3_600_000; // past the six-hour lifetime
    const failing = createFakeProviders(() => json({ error_message: 'unavailable' }, 503));
    const later = await loadMacro({ ...deps, fetch: failing.fetch }, 'fred');
    const entry = entryOf(later, 'fred:DFEDTARU');
    assert.equal(entry.provenance.state, 'CACHED');
    assert.equal(entry.provenance.cache, 'stale-if-error');
    assert.equal(entry.provenance.retrievedAt, T0, 'the time the provider last answered');
    assert.ok(entry.series !== null, 'the last verified values are still shown');
  });
});

describe('macro observations from BLS, which needs no key', () => {
  const reply = (
    ids: readonly string[] = ['LNS14000000', 'CES0000000001', 'CUUR0000SA0'],
  ): ProviderReply => ({
    status: 'REQUEST_SUCCEEDED',
    message: [],
    Results: { series: ids.map((id) => blsMonths(id, [2025, 11], 6, 4.2)) },
  });

  it('are asked without a credential, and every series carries its unit and adjustment', async () => {
    const { deps, fake } = setup({}, (call) => (call.host === 'api.bls.gov' ? reply() : undefined));
    const answer = await loadMacro(deps, 'bls');
    assert.equal(fake.calls.length, 1, 'one request for the whole catalog');
    assert.equal(fake.calls[0]?.path, '/publicAPI/v1/timeseries/data/');
    assert.equal(answer.entries.length, 3);
    const unemployment = entryOf(answer, 'bls:LNS14000000');
    assert.equal(unemployment.series?.adjustment, 'seasonally adjusted');
    assert.equal(unemployment.series?.unit, 'percent');
    assert.equal(unemployment.provenance.state, 'DELAYED');
    assert.equal(unemployment.provenance.dataAsOf, day(2025, 11, 1));
    assert.equal(
      unemployment.series?.points[0]?.knownFrom,
      null,
      'BLS gives no publication date, so none is invented',
    );
  });

  it('list a series the provider left out as UNAVAILABLE, never as zero or as the group state', async () => {
    const { deps } = setup({}, (call) =>
      call.host === 'api.bls.gov' ? reply(['LNS14000000']) : undefined,
    );
    const answer = await loadMacro(deps, 'bls');
    const missing = entryOf(answer, 'bls:CES0000000001');
    assert.equal(missing.series, null);
    assert.equal(missing.provenance.state, 'UNAVAILABLE');
    assert.match(missing.provenance.message ?? '', /returned no usable data for CES0000000001/);
    assert.equal(entryOf(answer, 'bls:LNS14000000').provenance.state, 'DELAYED');
    assert.equal(answer.provenance.state, 'UNAVAILABLE');
  });

  it('say RATE LIMITED, with the provider as the one who refused, when the daily threshold is reached', async () => {
    const { deps } = setup({}, () => ({
      status: 'REQUEST_NOT_PROCESSED',
      message: [
        'Request could not be serviced, as the daily threshold for total number of requests has been reached.',
      ],
      Results: {},
    }));
    const answer = await loadMacro(deps, 'bls');
    assert.equal(answer.provenance.state, 'RATE LIMITED');
    for (const entry of answer.entries) assert.equal(entry.series, null);
  });
});

describe('macro observations from BEA', () => {
  const row = (period: string, value: string) => ({
    TableName: 'T10101',
    SeriesCode: 'A191RL',
    LineNumber: '1',
    TimePeriod: period,
    CL_UNIT: 'Percent change, annual rate',
    UNIT_MULT: '0',
    DataValue: value,
  });
  const replyWith =
    (...rows: Array<ReturnType<typeof row>>): Route =>
    (call) =>
      call.host === 'apps.bea.gov' ? { BEAAPI: { Results: { Data: rows } } } : undefined;

  it('are ENV NOT CONNECTED without the key, naming the variable', async () => {
    const { deps, fake } = setup({}, replyWith());
    const answer = await loadMacro(deps, 'bea');
    assert.equal(fake.calls.length, 0);
    assert.equal(answer.provenance.state, 'ENV NOT CONNECTED');
    assert.match(answer.provenance.message ?? '', /BEA_API_KEY/);
  });

  it('read a quarterly figure and judge it against the quarterly window, not the monthly one', async () => {
    const current = setup(
      { [ENV_BEA_KEY]: KEY },
      replyWith(row('2025Q2', '3.8'), row('2025Q3', '4.3')),
    );
    const fresh = entryOf(await loadMacro(current.deps, 'bea'), 'bea:T10101:A191RL');
    assert.equal(fresh.series?.frequency, 'quarterly');
    assert.equal(fresh.provenance.dataAsOf, day(2025, 7, 1));
    assert.equal(fresh.provenance.state, 'DELAYED', '189 days is current for a quarterly series');

    const old = setup(
      { [ENV_BEA_KEY]: KEY },
      replyWith(row('2025Q1', '-0.5'), row('2025Q2', '3.8')),
    );
    const stale = entryOf(await loadMacro(old.deps, 'bea'), 'bea:T10101:A191RL');
    assert.equal(stale.provenance.state, 'STALE', '280 days is older than the 215-day window');
    assert.equal(stale.series?.points.at(-1)?.value, 3.8, 'a stale value is still shown, as stale');
  });

  it('refuse a series whose unit is not the one Elstand expects', async () => {
    const { deps } = setup({ [ENV_BEA_KEY]: KEY }, (call) =>
      call.host === 'apps.bea.gov'
        ? { BEAAPI: { Results: { Data: [{ ...row('2025Q3', '4.3'), CL_UNIT: 'Level' }] } } }
        : undefined,
    );
    const answer = await loadMacro(deps, 'bea');
    assert.equal(entryOf(answer, 'bea:T10101:A191RL').series, null);
    assert.equal(answer.provenance.state, 'ERROR');
  });
});

describe('macro observations from the World Bank, which needs no key', () => {
  const entry = (iso3: string, date: string, value: number | null, indicator: string) => ({
    indicator: { id: indicator, value: 'x' },
    country: { id: iso3.slice(0, 2), value: iso3 },
    countryiso3code: iso3,
    date,
    value,
  });
  const route: Route = (call) => {
    if (call.host !== 'api.worldbank.org') return undefined;
    const indicator = call.path.split('/').at(-1) ?? '';
    return [
      { page: 1, pages: 1, per_page: 50, total: 4 },
      [
        entry('USA', '2024', 2.8, indicator),
        entry('USA', '2023', 2.9, indicator),
        entry('EMU', '2024', 0.9, indicator),
        entry('EMU', '2023', 0.5, indicator),
      ],
    ];
  };

  it('answer per indicator and country, with annual values judged by the annual window', async () => {
    const { deps, fake } = setup({}, route);
    const answer = await loadMacro(deps, 'worldbank');
    assert.equal(fake.calls.length, 2, 'one request per indicator, for all countries together');
    assert.equal(answer.entries.length, 16);
    const usa = entryOf(answer, 'worldbank:NY.GDP.MKTP.KD.ZG/USA');
    assert.equal(usa.series?.frequency, 'annual');
    assert.equal(usa.series?.points.at(-1)?.value, 2.8);
    assert.equal(usa.provenance.state, 'DELAYED', '735 days is current for an annual figure');
    assert.equal(usa.provenance.dataAsOf, day(2024, 1, 1));
  });

  it('list a country the World Bank has no value for as UNAVAILABLE, not as an empty success', async () => {
    const { deps } = setup({}, route);
    const answer = await loadMacro(deps, 'worldbank');
    const japan = entryOf(answer, 'worldbank:NY.GDP.MKTP.KD.ZG/JPN');
    assert.equal(japan.series, null);
    assert.equal(japan.provenance.state, 'UNAVAILABLE');
    assert.equal(answer.provenance.state, 'UNAVAILABLE');
  });
});

describe('the macro provider names', () => {
  it('accept the four macro providers and nothing else', () => {
    for (const id of ['fred', 'bls', 'bea', 'worldbank']) assert.ok(isMacroProvider(id), id);
    for (const id of ['imf', 'twelvedata', 'FRED', '', null, undefined, 4]) {
      assert.equal(isMacroProvider(id), false, String(id));
    }
  });
});

// ---- price change --------------------------------------------------------------------------------------

describe('the one-month price change', () => {
  const eurusd = findInstrument('EURUSD');
  assert.ok(eurusd !== undefined);
  const end = day(2026, 1, 5);

  it('is the close-to-close change over 30 days, and the base currency rises when the pair does', () => {
    const bars = dailyBars(40, end); // 1.100 ... 1.139
    const change = priceChangeOver(bars, eurusd, 'EUR');
    assert.ok(change !== null);
    assert.equal(change.days, 30);
    assert.equal(change.last.time, end);
    assert.equal(change.base.time, end - 30 * DAY);
    assert.ok(Math.abs(change.percent - (1.139 / 1.109 - 1) * 100) < 1e-9);
    const quote = priceChangeOver(bars, eurusd, 'USD');
    assert.ok(quote !== null);
    assert.ok(
      Math.abs(quote.percent - (1.109 / 1.139 - 1) * 100) < 1e-9,
      'USD falls when EUR/USD rises',
    );
    assert.ok(quote.percent < 0);
  });

  it('is not measured when there is no history, no close near one month back, or the wrong currency', () => {
    assert.equal(priceChangeOver([], eurusd, 'EUR'), null);
    assert.equal(priceChangeOver(dailyBars(10, end), eurusd, 'EUR'), null, 'no bar a month back');
    assert.equal(priceChangeOver(dailyBars(40, end), eurusd, 'JPY'), null, 'JPY is not in EUR/USD');
    // A hole in the history: the nearest earlier bar is 40 days back, further than a month means.
    const gap = [...dailyBars(3, end - 40 * DAY), ...dailyBars(2, end)];
    assert.equal(priceChangeOver(gap, eurusd, 'EUR'), null, 'a stale base is not interpolated');
  });
});

// ---- the macro bubbles ------------------------------------------------------------------------------------

describe('the macro bubbles', () => {
  const bars = dailyBars(40, day(2026, 1, 5));

  it('are unavailable, in the documented words, without the FRED key, and ask nothing', async () => {
    const { deps, fake } = setup({ [ENV_API_KEY]: 'td' }, () => {
      throw new Error('nothing may be requested');
    });
    const answer = await loadBubbles(deps);
    assert.equal(fake.calls.length, 0);
    assert.equal(answer.result.status, 'unavailable');
    assert.equal(answer.provenance.state, 'ENV NOT CONNECTED');
    assert.match(answer.provenance.message ?? '', /FRED_API_KEY is missing/);
  });

  it('are unavailable, naming the input, when the price history cannot be had', async () => {
    const { deps } = setup(FRED_ENV, fredRoute());
    const answer = await loadBubbles(deps);
    assert.equal(answer.result.status, 'unavailable');
    assert.match(
      answer.result.status === 'unavailable' ? answer.result.reason : '',
      /TWELVE_DATA_API_KEY/,
    );
    assert.equal(answer.provenance.state, 'ENV NOT CONNECTED');
  });

  it('draw only what real inputs support, say what was left out and why, and label the result CALCULATED', async () => {
    const { deps } = setup(BUBBLE_ENV, fredRoute({}, twelveRoute(bars)));
    const answer = await loadBubbles(deps);
    assert.equal(answer.result.status, 'available');
    if (answer.result.status !== 'available') return;
    assert.equal(answer.result.points.length, 1);
    const point = answer.result.points[0];
    assert.equal(point?.currency, 'EUR');
    assert.equal(point?.policyRate.value, 2.0);
    assert.ok(
      Math.abs((point?.cpiYoY.value ?? 0) - ((124 + 12 * 0.2) / 124 - 1) * 100) < 1e-6,
      'the year-on-year change is computed from the real index values',
    );
    assert.ok(Math.abs((point?.priceChange1m.value ?? 0) - (1.139 / 1.109 - 1) * 100) < 1e-6);
    assert.match(point?.priceChange1m.basis ?? '', /^vs USD, close to close, 30 days \(/);
    assert.match(point?.policyRate.source.name ?? '', /FRED ECBDFR/);
    assert.match(point?.cpiYoY.source.name ?? '', /computed by Elstand/);

    const omitted = new Map(answer.result.omitted?.map((item) => [item.currency, item.reason]));
    for (const currency of ['USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']) {
      assert.ok(
        (omitted.get(currency) ?? '') !== '',
        `${currency} is listed as left out, with a reason`,
      );
    }
    assert.equal(answer.provenance.state, 'CALCULATED');
    assert.equal(answer.provenance.providerLabel, 'Calculated by Elstand');
    assert.equal(answer.inputs.length, 3);
    assert.deepEqual(answer.inputs.map((input) => input.provider).sort(), [
      'fred',
      'fred',
      'twelvedata',
    ]);
  });

  it('are never better than their worst input: a stale CPI series makes the bubble STALE', async () => {
    const { deps } = setup(
      BUBBLE_ENV,
      fredRoute({ CP0000EZ19M086NEST: fredMonthly(13, 2025, 8, 124, 0.2) }, twelveRoute(bars)),
    );
    const answer = await loadBubbles(deps);
    assert.equal(answer.result.status, 'available');
    assert.equal(answer.provenance.state, 'STALE');
    assert.ok(answer.shareMs <= 30_000, 'a degraded answer is shared only briefly');
  });

  it('draw from the Alpha Vantage daily series when Twelve Data is rate limited, and say so', async () => {
    const { deps } = setup(
      { ...BUBBLE_ENV, [ENV_ALPHA_VANTAGE_KEY]: 'av-test-key-1234' },
      fredRoute({}, (call) => {
        if (call.host === 'api.twelvedata.com') return vendorError(429, 'out of credits');
        if (call.host === 'www.alphavantage.co') return avDailyPayload(bars);
        return undefined;
      }),
    );
    const answer = await loadBubbles(deps);
    assert.equal(answer.result.status, 'available');
    if (answer.result.status !== 'available') return;
    assert.match(
      answer.result.points[0]?.priceChange1m.source.name ?? '',
      /^Alpha Vantage EUR\/USD daily closes/,
    );
    const fallback = answer.inputs.find((input) => input.fallback !== null);
    assert.equal(fallback?.provider, 'alphavantage');
    assert.equal(fallback?.fallback?.from, 'twelvedata');
    assert.equal(answer.provenance.fallback?.from, 'twelvedata');
  });

  it('leave a bubble out, with the reason, when a figure cannot be computed from real data', async () => {
    const noBase = setup(
      BUBBLE_ENV,
      fredRoute({ CP0000EZ19M086NEST: fredMonthly(6, 2025, 11, 124, 0.2) }, twelveRoute(bars)),
    );
    const noYear = await loadBubbles(noBase.deps);
    assert.equal(noYear.result.status, 'unavailable');
    assert.match(
      noYear.result.status === 'unavailable' ? noYear.result.reason : '',
      /twelve months before the newest one/,
    );

    const shortHistory = setup(
      BUBBLE_ENV,
      fredRoute({}, twelveRoute(dailyBars(10, day(2026, 1, 5)))),
    );
    const noMonth = await loadBubbles(shortHistory.deps);
    assert.equal(noMonth.result.status, 'unavailable');
    assert.match(
      noMonth.result.status === 'unavailable' ? noMonth.result.reason : '',
      /no close from about one month before/,
    );
    assert.equal(noMonth.inputs.length, 0, 'nothing is claimed about inputs that drew nothing');
  });
});
