import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALPHA_VANTAGE_LABEL,
  fetchDailySeries,
  fetchSpotRate,
  parseDailySeries,
} from '../../server/alphavantage.js';
import { fetchBeaSeries } from '../../server/bea.js';
import { fetchBlsSeries } from '../../server/bls.js';
import { currenciesOfSymbol } from '../../server/currencies.js';
import { ApiFailure } from '../../server/errors.js';
import {
  CALENDAR_ATTRIBUTION,
  IMPACT_SCHEME,
  fetchCalendar,
} from '../../server/financecalendar.js';
import { fetchFredObservations } from '../../server/fred.js';
import { fetchReferenceRates } from '../../server/frankfurter.js';
import { NEWS_SEARCH, fetchNews } from '../../server/marketaux.js';
import { DAY_MS, formatIsoDate, parseUtcField, parseZonedInstant } from '../../server/parse.js';
import type { HttpDeps } from '../../server/provider-http.js';
import { fetchWorldBankIndicator } from '../../server/worldbank.js';
import { createFakeProviders, json, type ProviderReply } from '../support/fake-provider.js';

/**
 * These tests drive the real adapters and the real HTTP helper against a stand-in for each
 * provider that answers in the shape the provider documents. They prove that parsing,
 * validation and error handling are right. They do NOT prove that a live service answers this
 * way today, and they say nothing about a real key: that is checked against the deployed app.
 */

const T0 = Date.UTC(2026, 0, 6, 12, 0, 0);
const KEY = 'test-key-1234';

const depsFor = (reply: (url: URL) => ProviderReply | Promise<ProviderReply>) => {
  const fake = createFakeProviders((call) => reply(new URL(call.url)));
  const deps: HttpDeps = { fetch: fake.fetch, now: () => T0 };
  return { fake, deps };
};

async function failureOf(run: () => Promise<unknown>): Promise<ApiFailure> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ApiFailure, `expected an ApiFailure, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the call to fail');
}

describe('parsing helpers', () => {
  it('reads a UTC field with or without a zone, and nothing else', () => {
    const expected = Date.UTC(2026, 0, 7, 13, 30, 0);
    assert.equal(parseUtcField('2026-01-07T13:30:00Z'), expected);
    assert.equal(parseUtcField('2026-01-07 13:30:00'), expected);
    assert.equal(parseUtcField('2026-01-07 13:30'), expected);
    assert.equal(parseUtcField('2026-01-07T15:30:00+02:00'), expected);
    assert.equal(parseUtcField('2026-01-07'), null);
    assert.equal(parseUtcField('2026-02-30 10:00:00'), null);
    assert.equal(parseUtcField('2026-01-07 25:00:00'), null);
    assert.equal(parseUtcField(20260107), null);
  });

  it('refuses a zone-less instant where a zone is required', () => {
    assert.equal(parseZonedInstant('2026-01-07 13:30:00'), null);
    assert.equal(parseZonedInstant('2026-01-07T13:30:00'), null);
    assert.equal(
      parseZonedInstant('2021-03-01T14:58:55.000000Z'),
      Date.UTC(2021, 2, 1, 14, 58, 55),
    );
  });

  it('turns provider symbols into currencies only when every code is recognized', () => {
    assert.deepEqual(currenciesOfSymbol('EUR'), ['EUR']);
    assert.deepEqual(currenciesOfSymbol('EURUSD'), ['EUR', 'USD']);
    assert.deepEqual(currenciesOfSymbol('eur/usd'), ['EUR', 'USD']);
    assert.deepEqual(currenciesOfSymbol('EURUSD=X'), ['EUR', 'USD']);
    assert.deepEqual(currenciesOfSymbol('EURXYZ'), []);
    assert.deepEqual(currenciesOfSymbol('AAPL'), []);
    assert.deepEqual(currenciesOfSymbol('EUREUR'), []);
  });
});

describe('FRED adapter', () => {
  const row = (date: string, value: string, start: string) => ({
    realtime_start: start,
    realtime_end: '9999-12-31',
    date,
    value,
  });
  const request = { seriesId: 'CPIAUCNS', lookbackDays: 800 };

  it('reads observations with the day each value was first published', async () => {
    const { fake, deps } = depsFor(() => ({
      units: 'lin',
      observations: [
        row('2025-10-01', '319.5', '2025-11-13'),
        row('2025-11-01', '.', '2025-12-10'),
        row('2025-12-01', '321.0', '2026-01-05'),
      ],
    }));
    const points = await fetchFredObservations(
      deps,
      { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' },
      request,
    );
    assert.deepEqual(points, [
      { date: Date.UTC(2025, 9, 1), value: 319.5, knownFrom: Date.UTC(2025, 10, 14) },
      { date: Date.UTC(2025, 11, 1), value: 321, knownFrom: Date.UTC(2026, 0, 6) },
    ]);
    const sent = fake.calls[0];
    assert.equal(sent?.host, 'api.stlouisfed.org');
    assert.equal(sent?.path, '/fred/series/observations');
    assert.equal(sent?.params['series_id'], 'CPIAUCNS');
    assert.equal(sent?.params['output_type'], '4');
    assert.equal(sent?.params['observation_start'], formatIsoDate(T0 - 800 * DAY_MS));
    assert.equal(sent?.params['api_key'], KEY);
  });

  it('records no publication date for a value that predates the vintage records', async () => {
    const { deps } = depsFor(() => ({
      units: 'lin',
      observations: [row('2025-12-01', '4.5', '2025-01-01')],
    }));
    const points = await fetchFredObservations(
      deps,
      { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' },
      request,
    );
    assert.equal(points[0]?.knownFrom, null);
  });

  it('rejects transformed series, malformed values, future dates and empty answers', async () => {
    const config = { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' };
    const bad: unknown[] = [
      { units: 'pch', observations: [row('2025-12-01', '1', '2026-01-05')] },
      { units: 'lin', observations: [row('2025-12-01', '1e3', '2026-01-05')] },
      { units: 'lin', observations: [row('2026-12-01', '1', '2026-12-05')] },
      { units: 'lin', observations: [row('2025-12-01', '.', '2026-01-05')] },
      {
        units: 'lin',
        observations: [row('2025-12-01', '1', '2026-01-05'), row('2025-12-01', '2', '2026-01-05')],
      },
      { nothing: true },
    ];
    for (const body of bad) {
      const { deps } = depsFor(() => body as Record<string, unknown>);
      const failure = await failureOf(() => fetchFredObservations(deps, config, request));
      assert.equal(failure.code, 'provider_error', JSON.stringify(body));
    }
  });

  it('reports a bad key as an authentication failure, asks once, and never echoes the key', async () => {
    const { fake, deps } = depsFor(() =>
      json(
        {
          error_code: 400,
          error_message: `Bad Request. The value for variable api_key is not registered. ${KEY}`,
        },
        400,
      ),
    );
    const failure = await failureOf(() =>
      fetchFredObservations(
        deps,
        { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' },
        request,
      ),
    );
    assert.equal(failure.code, 'provider_auth');
    assert.equal(fake.calls.length, 1, 'an authentication failure is not retried');
    assert.ok(!failure.message.includes(KEY));
  });

  it('asks again without vintage parameters when FRED refuses them, and then records no publication dates', async () => {
    const { fake, deps } = depsFor((url) =>
      url.searchParams.has('output_type')
        ? json({ error_code: 400, error_message: 'Bad Request. realtime_start is not valid.' }, 400)
        : { units: 'lin', observations: [row('2025-12-01', '321.0', '2026-01-05')] },
    );
    const points = await fetchFredObservations(
      deps,
      { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' },
      request,
    );
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1]?.params['output_type'], undefined);
    assert.deepEqual(points, [{ date: Date.UTC(2025, 11, 1), value: 321, knownFrom: null }]);
  });

  it('reports a 429 as a rate limit with the wait the provider gave', async () => {
    const { deps } = depsFor(() =>
      json({ error_code: 429, error_message: 'Too many' }, 429, { 'Retry-After': '45' }),
    );
    const failure = await failureOf(() =>
      fetchFredObservations(
        deps,
        { apiKey: KEY, baseUrl: 'https://api.stlouisfed.org/fred' },
        request,
      ),
    );
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryAfterSeconds, 45);
  });
});

describe('BLS adapter', () => {
  const body = {
    status: 'REQUEST_SUCCEEDED',
    message: [],
    Results: {
      series: [
        {
          seriesID: 'LNS14000000',
          data: [
            { year: '2025', period: 'M12', periodName: 'December', value: '4.1' },
            { year: '2025', period: 'M13', periodName: 'Annual', value: '4.0' },
            { year: '2025', period: 'M11', periodName: 'November', value: '-' },
            { year: '2025', period: 'M10', periodName: 'October', value: '4.2' },
          ],
        },
      ],
    },
  };
  const request = { seriesIds: ['LNS14000000'], startYear: 2024, endYear: 2025 };
  const base = 'https://api.bls.gov/publicAPI';

  it('reads months only, skips annual averages and missing values, and has no publication dates', async () => {
    const { deps } = depsFor(() => body);
    const result = await fetchBlsSeries(deps, { baseUrl: base, apiKey: null }, request);
    assert.deepEqual(result.series.get('LNS14000000'), [
      { date: Date.UTC(2025, 9, 1), value: 4.2, knownFrom: null },
      { date: Date.UTC(2025, 11, 1), value: 4.1, knownFrom: null },
    ]);
    assert.deepEqual(result.missing, []);
  });

  it('uses the keyless endpoint without a key, and puts a key in the body, never the address', async () => {
    const keyless = depsFor(() => body);
    await fetchBlsSeries(keyless.deps, { baseUrl: base, apiKey: null }, request);
    assert.equal(keyless.fake.calls[0]?.path, '/publicAPI/v1/timeseries/data/');
    assert.equal(keyless.fake.calls[0]?.method, 'POST');
    assert.ok(!(keyless.fake.calls[0]?.body ?? '').includes('registrationkey'));

    const keyed = depsFor(() => body);
    await fetchBlsSeries(keyed.deps, { baseUrl: base, apiKey: KEY }, request);
    assert.equal(keyed.fake.calls[0]?.path, '/publicAPI/v2/timeseries/data/');
    assert.ok(!(keyed.fake.calls[0]?.url ?? '').includes(KEY));
    assert.equal(
      (JSON.parse(keyed.fake.calls[0]?.body ?? '{}') as Record<string, unknown>)['registrationkey'],
      KEY,
    );
  });

  it('reports the daily threshold as a spent daily budget, not as a failure of the key', async () => {
    const { deps } = depsFor(() => ({
      status: 'REQUEST_NOT_PROCESSED',
      message: [
        'Request could not be serviced, as the daily threshold for total number of requests has been reached.',
      ],
      Results: {},
    }));
    const failure = await failureOf(() =>
      fetchBlsSeries(deps, { baseUrl: base, apiKey: null }, request),
    );
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.budget, 'day');
  });

  it('reports an invalid registration key as an authentication failure without echoing it', async () => {
    const { deps } = depsFor(() => ({
      status: 'REQUEST_NOT_PROCESSED',
      message: [`The key ${KEY} provided by the User is invalid.`],
      Results: {},
    }));
    const failure = await failureOf(() =>
      fetchBlsSeries(deps, { baseUrl: base, apiKey: KEY }, request),
    );
    assert.equal(failure.code, 'provider_auth');
    assert.ok(!failure.message.includes(KEY));
  });

  it('rejects a series it was not asked for and a malformed value', async () => {
    const other = depsFor(() => ({
      ...body,
      Results: { series: [{ seriesID: 'XXXXXXXXXX', data: [] }] },
    }));
    assert.equal(
      (await failureOf(() => fetchBlsSeries(other.deps, { baseUrl: base, apiKey: null }, request)))
        .code,
      'provider_error',
    );
    const malformed = depsFor(() => ({
      ...body,
      Results: {
        series: [
          { seriesID: 'LNS14000000', data: [{ year: '2025', period: 'M10', value: 'four' }] },
        ],
      },
    }));
    assert.equal(
      (
        await failureOf(() =>
          fetchBlsSeries(malformed.deps, { baseUrl: base, apiKey: null }, request),
        )
      ).code,
      'provider_error',
    );
  });
});

describe('BEA adapter', () => {
  const request = {
    table: 'T10101',
    seriesCode: 'A191RL',
    lineNumber: '1',
    years: [2025],
    unitContains: 'Percent change',
  };
  const data = (over: Record<string, unknown>) => ({
    TableName: 'T10101',
    SeriesCode: 'A191RL',
    LineNumber: '1',
    TimePeriod: '2025Q2',
    CL_UNIT: 'Percent change, annual rate',
    UNIT_MULT: '0',
    DataValue: '3.8',
    ...over,
  });
  const reply = (rows: unknown[]) => ({
    BEAAPI: {
      Request: { RequestParam: [{ ParameterName: 'USERID', ParameterValue: KEY }] },
      Results: { Data: rows },
    },
  });
  const config = { baseUrl: 'https://apps.bea.gov/api', apiKey: KEY };

  it('reads the requested series, skips (NA) and other series, and passes nothing else on', async () => {
    const { fake, deps } = depsFor(() =>
      reply([
        data({ TimePeriod: '2025Q1', DataValue: '-0.6' }),
        data({ TimePeriod: '2025Q2' }),
        data({ TimePeriod: '2025Q3', DataValue: '(NA)' }),
        data({ SeriesCode: 'A253RL', DataValue: '9.9' }),
      ]),
    );
    const points = await fetchBeaSeries(deps, config, request);
    assert.deepEqual(points, [
      { date: Date.UTC(2025, 0, 1), value: -0.6, knownFrom: null },
      { date: Date.UTC(2025, 3, 1), value: 3.8, knownFrom: null },
    ]);
    assert.ok(
      !JSON.stringify(points).includes(KEY),
      'the echoed request, key included, is dropped',
    );
    assert.equal(fake.calls[0]?.params['UserID'], KEY);
    assert.equal(fake.calls[0]?.params['TableName'], 'T10101');
    assert.equal(fake.calls[0]?.params['Year'], '2025');
  });

  it('reports an error sent inside an HTTP 200 answer, and never echoes the key', async () => {
    const auth = depsFor(() => ({
      BEAAPI: {
        Results: {
          Error: { APIErrorCode: '3', APIErrorDescription: `Invalid UserID parameter ${KEY}` },
        },
      },
    }));
    const failure = await failureOf(() => fetchBeaSeries(auth.deps, config, request));
    assert.equal(failure.code, 'provider_auth');
    assert.ok(!failure.message.includes(KEY));

    const limited = depsFor(() => ({
      BEAAPI: {
        Results: {
          Error: { APIErrorCode: '7', APIErrorDescription: 'Exceeded the request limit.' },
        },
      },
    }));
    assert.equal(
      (await failureOf(() => fetchBeaSeries(limited.deps, config, request))).code,
      'rate_limited',
    );
  });

  it('rejects a series whose unit is not the one expected and a rescaled value', async () => {
    const unit = depsFor(() => reply([data({ CL_UNIT: 'Level' })]));
    assert.equal(
      (await failureOf(() => fetchBeaSeries(unit.deps, config, request))).code,
      'provider_error',
    );
    const scaled = depsFor(() => reply([data({ UNIT_MULT: '6' })]));
    assert.equal(
      (await failureOf(() => fetchBeaSeries(scaled.deps, config, request))).code,
      'provider_error',
    );
  });
});

describe('World Bank adapter', () => {
  const config = { baseUrl: 'https://api.worldbank.org/v2' };
  const request = { countries: ['USA', 'EMU'], indicator: 'NY.GDP.MKTP.KD.ZG', latest: 2 };
  const entry = (country: string, date: string, value: number | null) => ({
    indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
    country: { id: country.slice(0, 2), value: country },
    countryiso3code: country,
    date,
    value,
  });

  it('reads annual values per country, skips empty years and lists countries without data', async () => {
    const { fake, deps } = depsFor(() => [
      { page: 1, pages: 1, per_page: 50, total: 3 },
      [entry('USA', '2024', 2.8), entry('USA', '2023', 2.9), entry('USA', '2022', null)],
    ]);
    const result = await fetchWorldBankIndicator(deps, config, request);
    assert.deepEqual(result.series.get('USA'), [
      { date: Date.UTC(2023, 0, 1), value: 2.9, knownFrom: null },
      { date: Date.UTC(2024, 0, 1), value: 2.8, knownFrom: null },
    ]);
    assert.deepEqual(result.missing, ['EMU']);
    assert.equal(fake.calls[0]?.path, '/v2/country/USA;EMU/indicator/NY.GDP.MKTP.KD.ZG');
    assert.equal(fake.calls[0]?.params['mrnev'], '2');
    assert.equal(fake.calls[0]?.headers['authorization'], undefined, 'no credential is sent');
  });

  it('treats an empty data list as no data, and reports an error sent with HTTP 200', async () => {
    const empty = depsFor(() => [{ page: 0, pages: 0, per_page: 50, total: 0 }, null]);
    const result = await fetchWorldBankIndicator(empty.deps, config, request);
    assert.deepEqual(result.missing, ['USA', 'EMU']);

    const error = depsFor(() => [
      { message: [{ id: '120', key: 'Invalid value', value: 'The indicator was not found.' }] },
    ]);
    const failure = await failureOf(() => fetchWorldBankIndicator(error.deps, config, request));
    assert.equal(failure.code, 'provider_error');
  });

  it('rejects an answer for another country or indicator', async () => {
    const stranger = depsFor(() => [{ page: 1 }, [entry('FRA', '2024', 1.1)]]);
    assert.equal(
      (await failureOf(() => fetchWorldBankIndicator(stranger.deps, config, request))).code,
      'provider_error',
    );
  });

  it('refuses a malformed request before sending anything', async () => {
    const { fake, deps } = depsFor(() => ({}));
    const failure = await failureOf(() =>
      fetchWorldBankIndicator(deps, config, { ...request, indicator: '../admin' }),
    );
    assert.equal(failure.code, 'bad_request');
    assert.equal(fake.calls.length, 0);
  });
});

describe('Frankfurter adapter', () => {
  const config = { baseUrl: 'https://api.frankfurter.dev/v1' };

  it('reads reference rates with their fixing date, and sends no credential', async () => {
    const { fake, deps } = depsFor(() => ({
      amount: 1,
      base: 'USD',
      date: '2026-01-05',
      rates: { EUR: 0.85, GBP: 0.74 },
    }));
    const result = await fetchReferenceRates(deps, config, 'USD', ['EUR', 'GBP']);
    assert.equal(result.date, Date.UTC(2026, 0, 5));
    assert.deepEqual(result.rates, [
      { currency: 'EUR', rate: 0.85 },
      { currency: 'GBP', rate: 0.74 },
    ]);
    assert.deepEqual(result.missing, []);
    assert.equal(fake.calls[0]?.path, '/v1/latest');
    assert.equal(fake.calls[0]?.params['symbols'], 'EUR,GBP');
    assert.equal(fake.calls[0]?.headers['authorization'], undefined);
  });

  it('lists a currency it was asked for and not answered', async () => {
    const { deps } = depsFor(() => ({
      amount: 1,
      base: 'USD',
      date: '2026-01-05',
      rates: { EUR: 0.85 },
    }));
    const result = await fetchReferenceRates(deps, config, 'USD', ['EUR', 'JPY']);
    assert.deepEqual(result.missing, ['JPY']);
  });

  it('rejects a wrong base, an unrequested currency, a bad rate and a future fixing', async () => {
    const cases: Array<Record<string, unknown>> = [
      { amount: 1, base: 'EUR', date: '2026-01-05', rates: { EUR: 0.85 } },
      { amount: 1, base: 'USD', date: '2026-01-05', rates: { CHF: 0.8 } },
      { amount: 1, base: 'USD', date: '2026-01-05', rates: { EUR: -1 } },
      { amount: 1, base: 'USD', date: '2026-03-05', rates: { EUR: 0.85 } },
      { amount: 100, base: 'USD', date: '2026-01-05', rates: { EUR: 85 } },
    ];
    for (const body of cases) {
      const { deps } = depsFor(() => body);
      const failure = await failureOf(() => fetchReferenceRates(deps, config, 'USD', ['EUR']));
      assert.equal(failure.code, 'provider_error', JSON.stringify(body));
    }
  });
});

describe('Finance Calendar adapter', () => {
  const config = { baseUrl: 'https://www.financecalendar.com/wp-json/fc/v1', apiKey: null };
  const window = { fromMs: T0 - DAY_MS, toMs: T0 + 7 * DAY_MS };
  const event = (over: Record<string, unknown> = {}) => ({
    id: 101,
    name: 'Consumer Price Index (YoY)',
    country: 'US',
    category: 'inflation',
    impact: 'high',
    date: '2026-01-07',
    release_at_utc: '2026-01-07T13:30:00Z',
    status: 'confirmed',
    consensus: null,
    prior: '2.7',
    actual: null,
    unit: '%',
    source_name: 'U.S. Bureau of Labor Statistics',
    source_url: 'https://www.bls.gov/cpi/',
    ...over,
  });
  const page = (events: unknown[], total = events.length) => ({
    events,
    count: events.length,
    total,
  });

  it('keeps an exact release time exactly, attributes the impact to the provider and invents nothing', async () => {
    const { fake, deps } = depsFor(() => page([event()]));
    const result = await fetchCalendar(deps, config, window);
    const first = result.events[0];
    assert.equal(first?.id, 'financecalendar:101');
    assert.equal(first?.timeMs, Date.UTC(2026, 0, 7, 13, 30));
    assert.equal(first?.timePrecision, 'exact');
    assert.equal(first?.status, 'scheduled');
    assert.equal(first?.currency, 'USD');
    assert.deepEqual(first?.impact, { level: 'high', classifiedBy: IMPACT_SCHEME });
    assert.equal(first?.previous, '2.7%');
    assert.equal(first?.actual, null);
    assert.equal(first?.forecast, null);
    assert.equal(first?.surprise, undefined);
    assert.equal(first?.elvoidInterpretation, null);
    assert.equal(first?.source.name, 'Finance Calendar · U.S. Bureau of Labor Statistics');
    assert.equal(first?.source.url, 'https://www.bls.gov/cpi/');
    assert.equal(first?.source.retrievedAt, T0);
    assert.equal(CALENDAR_ATTRIBUTION.url, 'https://www.financecalendar.com');
    const sent = fake.calls[0];
    assert.equal(sent?.path, '/wp-json/fc/v1/calendar');
    assert.equal(sent?.params['from'], '2026-01-05');
    assert.equal(sent?.params['to'], '2026-01-13');
    assert.equal(sent?.headers['x-api-key'], undefined, 'no key header without a key');
  });

  it('marks a date-only event as date precision and never gives it a clock time', async () => {
    const { deps } = depsFor(() => page([event({ release_at_utc: null, date: '2026-01-08' })]));
    const first = (await fetchCalendar(deps, config, window)).events[0];
    assert.equal(first?.timePrecision, 'date');
    assert.equal(first?.timeMs, Date.UTC(2026, 0, 8));
  });

  it('maps statuses as stated and leaves out a status it does not know', async () => {
    const { deps } = depsFor(() =>
      page([
        event({ id: 1, status: 'estimated' }),
        event({ id: 2, status: 'rescheduled' }),
        event({ id: 3, status: 'cancelled' }),
        event({ id: 4, status: 'something-new' }),
      ]),
    );
    const byId = new Map((await fetchCalendar(deps, config, window)).events.map((e) => [e.id, e]));
    assert.equal(byId.get('financecalendar:1')?.status, 'estimated');
    assert.equal(byId.get('financecalendar:2')?.status, 'rescheduled');
    assert.equal(byId.get('financecalendar:3')?.status, 'cancelled');
    assert.equal(byId.get('financecalendar:4')?.status, undefined);
  });

  it('computes a surprise only from an actual and a forecast that are both numbers', async () => {
    const { deps } = depsFor(() =>
      page([
        event({ id: 1, status: 'released', actual: 3.1, consensus: '2.9' }),
        event({ id: 2, status: 'released', actual: '1.2M', consensus: '1.0M' }),
        event({ id: 3, status: 'released', actual: 3.1, consensus: null }),
      ]),
    );
    const byId = new Map((await fetchCalendar(deps, config, window)).events.map((e) => [e.id, e]));
    assert.deepEqual(byId.get('financecalendar:1')?.surprise, {
      value: 0.2,
      unit: '%',
      basis: 'actual minus consensus, both as supplied by Finance Calendar',
    });
    assert.equal(byId.get('financecalendar:1')?.actual, '3.1%');
    assert.equal(byId.get('financecalendar:1')?.forecast, '2.9%');
    assert.equal(byId.get('financecalendar:2')?.surprise, undefined);
    assert.equal(byId.get('financecalendar:3')?.surprise, undefined);
  });

  it('excludes, with the reason, an event it cannot place on a currency or a time', async () => {
    const { deps } = depsFor(() =>
      page([
        event({ id: 1, country: 'ZZ' }),
        event({ id: 2, release_at_utc: 'sometime', date: null }),
        event({ id: 3, name: '', title: '' }),
        event({ id: '', name: 'No id' }),
        event({ id: 5 }),
      ]),
    );
    const result = await fetchCalendar(deps, config, window);
    assert.deepEqual(
      result.events.map((e) => e.id),
      ['financecalendar:5'],
    );
    assert.equal(result.excluded.length, 4);
    assert.ok(result.excluded.some((entry) => entry.reason.includes('ZZ')));
  });

  it('gives a provider rating that is not low, medium or high no impact at all', async () => {
    const { deps } = depsFor(() =>
      page([event({ impact: 'holiday' }), event({ id: 2, impact: null })]),
    );
    for (const item of (await fetchCalendar(deps, config, window)).events)
      assert.equal(item.impact, null);
  });

  it('sends a key in a header, never in the address, and never echoes it', async () => {
    const { fake, deps } = depsFor(() => json({ error: `unknown key ${KEY}` }, 401));
    const failure = await failureOf(() => fetchCalendar(deps, { ...config, apiKey: KEY }, window));
    assert.equal(failure.code, 'provider_auth');
    assert.ok(!failure.message.includes(KEY));
    assert.equal(fake.calls[0]?.headers['x-api-key'], KEY);
    assert.ok(!(fake.calls[0]?.url ?? '').includes(KEY));
  });

  it('reads further pages until it has everything, and says when it could not', async () => {
    const all = depsFor((url) => {
      const offset = Number(url.searchParams.get('offset'));
      return page(offset === 0 ? [event({ id: 1 }), event({ id: 2 })] : [event({ id: 3 })], 3);
    });
    const complete = await fetchCalendar(all.deps, config, window);
    assert.equal(complete.events.length, 3);
    assert.equal(complete.truncated, false);
    assert.equal(all.fake.calls[1]?.params['offset'], '2');

    let id = 0;
    const endless = depsFor(() => page([event({ id: (id += 1) })], 10));
    const partial = await fetchCalendar(endless.deps, config, window);
    assert.equal(partial.truncated, true);
    assert.equal(partial.total, 10);
    assert.equal(endless.fake.calls.length, 3, 'paging is bounded');
  });

  it('reads the quota the provider reports and a 429 with its wait', async () => {
    const ok = depsFor(() =>
      json(page([event()]), 200, {
        'X-RateLimit-Limit': '2000',
        'X-RateLimit-Remaining': '1990',
        'X-RateLimit-Tier': 'anonymous',
      }),
    );
    assert.deepEqual((await fetchCalendar(ok.deps, config, window)).quota, {
      limit: 2000,
      remaining: 1990,
      tier: 'anonymous',
    });
    const limited = depsFor(() =>
      json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '120' }),
    );
    const failure = await failureOf(() => fetchCalendar(limited.deps, config, window));
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryAfterSeconds, 120);
  });

  it('refuses a window longer than the provider allows without sending anything', async () => {
    const { fake, deps } = depsFor(() => page([]));
    const failure = await failureOf(() =>
      fetchCalendar(deps, config, { fromMs: T0, toMs: T0 + 100 * DAY_MS }),
    );
    assert.equal(failure.code, 'bad_request');
    assert.equal(fake.calls.length, 0);
  });
});

describe('Marketaux adapter', () => {
  const config = { baseUrl: 'https://api.marketaux.com/v1', apiKey: KEY };
  const request = { sinceMs: T0 - 3 * DAY_MS, limit: 3 };
  const article = (over: Record<string, unknown> = {}) => ({
    uuid: 'a1b2c3',
    title: 'Central bank holds rates steady',
    description: 'not kept',
    url: 'https://news.example.org/story-1',
    published_at: '2026-01-06T10:15:00.000000Z',
    source: 'news.example.org',
    entities: [{ symbol: 'EURUSD', name: 'EUR/USD', type: 'currency', sentiment_score: 0.25 }],
    ...over,
  });
  const reply = (data: unknown[], found = data.length) => ({
    meta: { found, returned: data.length, limit: 3, page: 1 },
    data,
  });

  it('asks for a fixed, visible filter and reads headlines with their publisher and times', async () => {
    const { fake, deps } = depsFor(() => reply([article()], 812));
    const result = await fetchNews(deps, config, request);
    const sent = fake.calls[0];
    assert.equal(sent?.path, '/v1/news/all');
    assert.equal(sent?.params['search'], NEWS_SEARCH);
    assert.equal(sent?.params['language'], 'en');
    assert.equal(sent?.params['limit'], '3');
    assert.equal(sent?.params['published_after'], '2026-01-03T12:00:00');
    assert.equal(sent?.params['api_token'], KEY);

    const first = result.items[0];
    assert.equal(first?.id, 'marketaux:a1b2c3');
    assert.equal(first?.publishedAt, Date.UTC(2026, 0, 6, 10, 15));
    assert.equal(first?.headline, 'Central bank holds rates steady');
    assert.equal(first?.url, 'https://news.example.org/story-1');
    assert.equal(first?.publisher, 'news.example.org');
    assert.equal(first?.source.name, 'Marketaux');
    assert.equal(first?.source.retrievedAt, T0);
    assert.equal(first?.impact, null, 'Marketaux does not classify impact');
    assert.equal(result.found, 812);
    assert.equal(result.returned, 1);
    assert.equal(result.limit, 3);
    assert.ok(result.topic.includes('central banks'));
  });

  it('tags currencies only from entities the provider typed as currency', async () => {
    const { deps } = depsFor(() =>
      reply([
        article({ uuid: 'c1' }),
        article({
          uuid: 'c2',
          entities: [{ symbol: 'AAPL', type: 'equity', sentiment_score: 0.9 }],
        }),
        article({ uuid: 'c3', entities: [] }),
        article({ uuid: 'c4', title: 'Euro slides against the dollar', entities: undefined }),
      ]),
    );
    const byId = new Map(
      (await fetchNews(deps, config, request)).items.map((item) => [item.id, item]),
    );
    assert.deepEqual(byId.get('marketaux:c1')?.currencies, ['EUR', 'USD']);
    assert.deepEqual(byId.get('marketaux:c2')?.currencies, []);
    assert.deepEqual(byId.get('marketaux:c3')?.currencies, []);
    assert.deepEqual(
      byId.get('marketaux:c4')?.currencies,
      [],
      'no currency is inferred from words',
    );
  });

  it('keeps the provider sentiment apart and only when it is unambiguous', async () => {
    const { deps } = depsFor(() =>
      reply([
        article({ uuid: 's1' }),
        article({
          uuid: 's2',
          entities: [
            { symbol: 'EUR', type: 'currency', sentiment_score: 0.1 },
            { symbol: 'USD', type: 'currency', sentiment_score: -0.4 },
          ],
        }),
        article({
          uuid: 's3',
          entities: [{ symbol: 'EUR', type: 'currency', sentiment_score: 7 }],
        }),
      ]),
    );
    const byId = new Map(
      (await fetchNews(deps, config, request)).items.map((item) => [item.id, item]),
    );
    assert.deepEqual(byId.get('marketaux:s1')?.providerSentiment, {
      score: 0.25,
      basis: 'Marketaux entity sentiment for EURUSD',
    });
    assert.equal(
      byId.get('marketaux:s2')?.providerSentiment,
      undefined,
      'two entities are not averaged',
    );
    assert.equal(
      byId.get('marketaux:s3')?.providerSentiment,
      undefined,
      'a score outside -1..1 is dropped',
    );
  });

  it('excludes, with the reason, an article without an id, a headline or a valid past time', async () => {
    const { deps } = depsFor(() =>
      reply([
        article({ uuid: '' }),
        article({ uuid: 'n2', title: '   ' }),
        article({ uuid: 'n3', published_at: 'yesterday' }),
        article({ uuid: 'n4', published_at: '2026-01-09T00:00:00Z' }),
        article({ uuid: 'n5' }),
        article({ uuid: 'n5', title: 'The same article again' }),
        article({ uuid: 'n6', url: 'http://insecure.example.org/x' }),
      ]),
    );
    const result = await fetchNews(deps, config, request);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    assert.deepEqual([...byId.keys()].sort(), ['marketaux:n5', 'marketaux:n6']);
    assert.equal(byId.get('marketaux:n5')?.url, 'https://news.example.org/story-1');
    assert.equal(byId.get('marketaux:n5')?.headline, 'Central bank holds rates steady');
    assert.equal(
      byId.get('marketaux:n6')?.url,
      null,
      'a link that is not https is dropped, not kept',
    );
    assert.equal(result.excluded.length, 5);
    assert.ok(result.excluded.some((entry) => entry.reason.includes('future')));
    assert.ok(result.excluded.some((entry) => entry.reason.includes('repeats')));
  });

  it('turns the provider’s error codes into the right failures and never echoes the token', async () => {
    const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
      depsFor(() => json({ error: { code, message: `${code} ${KEY}` } }, status, headers));

    const auth = await failureOf(() =>
      fetchNews(fail(401, 'invalid_api_token').deps, config, request),
    );
    assert.equal(auth.code, 'provider_auth');
    assert.ok(!auth.message.includes(KEY));

    const spent = await failureOf(() =>
      fetchNews(fail(402, 'usage_limit_reached').deps, config, request),
    );
    assert.equal(spent.code, 'rate_limited');
    assert.equal(spent.budget, 'day');

    const burst = await failureOf(() =>
      fetchNews(fail(429, 'rate_limit_reached', { 'Retry-After': '30' }).deps, config, request),
    );
    assert.equal(burst.code, 'rate_limited');
    assert.equal(burst.retryAfterSeconds, 30);

    const plan = await failureOf(() =>
      fetchNews(fail(403, 'endpoint_access_restricted').deps, config, request),
    );
    assert.equal(plan.code, 'provider_error', 'a plan restriction is not a bad key');

    const params = await failureOf(() =>
      fetchNews(fail(400, 'malformed_parameters').deps, config, request),
    );
    assert.equal(params.code, 'provider_error');
    assert.ok(!params.message.includes(KEY));
  });

  it('does not send a request with an invalid size', async () => {
    const { fake, deps } = depsFor(() => reply([]));
    const failure = await failureOf(() => fetchNews(deps, config, { ...request, limit: 0 }));
    assert.equal(failure.code, 'bad_request');
    assert.equal(fake.calls.length, 0);
  });
});

describe('Alpha Vantage adapter', () => {
  const config = { baseUrl: 'https://www.alphavantage.co', apiKey: KEY };
  const spot = (over: Record<string, unknown> = {}) => ({
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
  const daily = (
    bars: Record<string, Record<string, string>>,
    meta: Record<string, string> = {},
  ) => ({
    'Meta Data': {
      '1. Information': 'Forex Daily Prices (open, high, low, close)',
      '2. From Symbol': 'EUR',
      '3. To Symbol': 'USD',
      '4. Output Size': 'Compact',
      '5. Last Refreshed': '2026-01-06 11:59:00',
      '6. Time Zone': 'UTC',
      ...meta,
    },
    'Time Series FX (Daily)': bars,
  });
  const bar = (open: string, high: string, low: string, close: string) => ({
    '1. open': open,
    '2. high': high,
    '3. low': low,
    '4. close': close,
  });

  it('reads a spot rate with its own time, in UTC only, and sends the key as a parameter', async () => {
    const { fake, deps } = depsFor(() => spot());
    const rate = await fetchSpotRate(deps, config, 'EUR', 'USD');
    assert.deepEqual(rate, {
      from: 'EUR',
      to: 'USD',
      rate: 1.1725,
      bid: 1.1724,
      ask: 1.1726,
      asOf: Date.UTC(2026, 0, 6, 11, 59),
    });
    assert.equal(fake.calls[0]?.params['function'], 'CURRENCY_EXCHANGE_RATE');
    assert.equal(fake.calls[0]?.params['apikey'], KEY);

    const zone = depsFor(() => spot({ '7. Time Zone': 'US/Eastern' }));
    assert.equal(
      (await failureOf(() => fetchSpotRate(zone.deps, config, 'EUR', 'USD'))).code,
      'provider_error',
    );
    const crossed = depsFor(() => spot({ '8. Bid Price': '1.2', '9. Ask Price': '1.1' }));
    assert.equal(
      (await failureOf(() => fetchSpotRate(crossed.deps, config, 'EUR', 'USD'))).code,
      'provider_error',
    );
    const other = depsFor(() => spot({ '3. To_Currency Code': 'JPY' }));
    assert.equal(
      (await failureOf(() => fetchSpotRate(other.deps, config, 'EUR', 'USD'))).code,
      'provider_error',
    );
  });

  it('reads the daily series ascending and rejects an inconsistent bar', async () => {
    const { fake, deps } = depsFor(() =>
      daily({
        '2026-01-06': bar('1.1700', '1.1760', '1.1690', '1.1725'),
        '2026-01-05': bar('1.1650', '1.1710', '1.1640', '1.1700'),
      }),
    );
    const series = await fetchDailySeries(deps, config, 'EUR', 'USD');
    assert.deepEqual(
      series.bars.map((b) => b.timeMs),
      [Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 6)],
    );
    assert.equal(series.bars[1]?.close, 1.1725);
    assert.equal(series.lastRefreshed, Date.UTC(2026, 0, 6, 11, 59));
    assert.equal(fake.calls[0]?.params['function'], 'FX_DAILY');
    assert.equal(fake.calls[0]?.params['outputsize'], 'compact');

    const crossed = daily({ '2026-01-06': bar('1.17', '1.10', '1.19', '1.17') });
    assert.throws(
      () => parseDailySeries(crossed, 'EUR', 'USD', T0),
      (error: unknown) => {
        assert.ok(error instanceof ApiFailure);
        assert.match(error.message, /not consistent/);
        return true;
      },
    );
    assert.throws(() => parseDailySeries(daily({}), 'EUR', 'USD', T0), ApiFailure);
  });

  it('tells a spent allowance, a paid-only endpoint and a bad key apart, with the key never shown', async () => {
    const perMinute = await failureOf(() =>
      fetchSpotRate(
        depsFor(() => ({
          Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.',
        })).deps,
        config,
        'EUR',
        'USD',
      ),
    );
    assert.equal(perMinute.code, 'rate_limited');
    assert.equal(perMinute.budget, null);
    assert.equal(perMinute.retryAfterSeconds, 60);

    const perDay = await failureOf(() =>
      fetchDailySeries(
        depsFor(() => ({
          Information:
            'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans.',
        })).deps,
        config,
        'EUR',
        'USD',
      ),
    );
    assert.equal(perDay.code, 'rate_limited');
    assert.equal(perDay.budget, 'day');

    const premium = await failureOf(() =>
      fetchDailySeries(
        depsFor(() => ({
          Information: 'This is a premium endpoint. You may subscribe to any of the premium plans.',
        })).deps,
        config,
        'EUR',
        'USD',
      ),
    );
    assert.equal(premium.code, 'provider_error');
    assert.match(premium.message, /paid plan/);

    const key = await failureOf(() =>
      fetchSpotRate(
        depsFor(() => ({ 'Error Message': `the parameter apikey is invalid or missing: ${KEY}` }))
          .deps,
        config,
        'EUR',
        'USD',
      ),
    );
    assert.equal(key.code, 'provider_auth');
    assert.ok(!key.message.includes(KEY));
    assert.ok(key.message.startsWith(ALPHA_VANTAGE_LABEL));
  });

  it('refuses a request that is not a currency pair without sending anything', async () => {
    const { fake, deps } = depsFor(() => spot());
    assert.equal(
      (await failureOf(() => fetchSpotRate(deps, config, 'EUR', 'EUR'))).code,
      'bad_request',
    );
    assert.equal(
      (await failureOf(() => fetchDailySeries(deps, config, 'euro', 'USD'))).code,
      'bad_request',
    );
    assert.equal(fake.calls.length, 0);
  });
});
