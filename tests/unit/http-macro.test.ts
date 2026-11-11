import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MACRO_PROVIDERS } from '../../server/macro-service.js';
import { ApiClientError, type ApiClient } from '../../src/data/api-client.js';
import {
  createHttpBubbleProvider,
  createHttpMacroFeed,
  createHttpObservations,
  MACRO_SERIES_PROVIDERS,
} from '../../src/data/http-macro.js';
import { createProvidersApi } from '../../src/data/http-providers.js';
import type { Provenance } from '../../src/data/provenance.js';

/**
 * The browser's macro and provider clients talk only to the Elstand API. These tests give them a
 * stand-in for that API (a function that answers a path), so they check how the browser reads and
 * passes on what the server said: the state is the server's, the browser never decides it again,
 * every answer's provenance is recorded for the provider page, and an answer that does not fit
 * the contract is refused, not shown.
 *
 * The payloads are test fixtures for the parsing, not provider output.
 */

const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);
const MINUTE = 60_000;
const SIGNAL = new AbortController().signal;

interface Call {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

function fakeApi(answer: (call: Call) => unknown): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async getJson(path, params) {
        const call = { path, params };
        calls.push(call);
        return answer(call);
      },
    },
  };
}

function recorder() {
  const seen: { provenance: Provenance; attemptedAt: number }[] = [];
  return {
    seen,
    record: (provenance: Provenance, attemptedAt: number): void => {
      seen.push({ provenance, attemptedAt });
    },
  };
}

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    provider: 'financecalendar',
    providerLabel: 'Finance Calendar',
    capability: 'economic-calendar',
    endpoint: 'events',
    state: 'DELAYED',
    retrievedAt: NOW - MINUTE,
    dataAsOf: null,
    cache: 'fresh',
    fallback: null,
    message: null,
    ...overrides,
  };
}

const ATTRIBUTION = { name: 'Finance Calendar', url: 'https://www.financecalendar.com' };

function calendarAnswer(overrides: Record<string, unknown> = {}) {
  return {
    provenance: provenance(),
    data: {
      events: [],
      excluded: [],
      total: 0,
      truncated: false,
      quota: { limit: null, remaining: null, tier: null },
      attribution: ATTRIBUTION,
      ...overrides,
    },
  };
}

function options(api: ReturnType<typeof fakeApi>, sink: ReturnType<typeof recorder>) {
  return { client: api.client, record: sink.record, now: () => NOW };
}

describe('the calendar feed', () => {
  it('asks the server for the window in UTC dates, and records what it answered', async () => {
    const api = fakeApi(() => calendarAnswer());
    const sink = recorder();
    const feed = createHttpMacroFeed(options(api, sink));
    const result = await feed.getCalendar(
      { fromMs: Date.UTC(2026, 0, 6), toMs: Date.UTC(2026, 0, 13) },
      SIGNAL,
    );
    assert.deepEqual(api.calls, [
      { path: '/api/calendar', params: { from: '2026-01-06', to: '2026-01-13' } },
    ]);
    assert.equal(result.status, 'available');
    assert.equal(sink.seen.length, 1);
    assert.equal(sink.seen[0]?.provenance.provider, 'financecalendar');
    assert.equal(sink.seen[0]?.attemptedAt, NOW);
  });

  it('passes the server’s state and the provider’s attribution on, as the origin of what it shows', async () => {
    const api = fakeApi(() => calendarAnswer());
    const feed = createHttpMacroFeed(options(api, recorder()));
    const result = await feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL);
    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    assert.equal(result.origin?.provenance.state, 'DELAYED');
    assert.deepEqual(result.origin?.attribution, ATTRIBUTION);
    assert.equal(result.asOf, NOW - MINUTE, 'as of when the server last verified the data');
  });

  it('says plainly when the provider counted more events than were read, and when some were left out', async () => {
    const api = fakeApi(() =>
      calendarAnswer({
        total: 120,
        truncated: true,
        excluded: [{ id: 'evt-9', reason: 'it states no time' }],
      }),
    );
    const feed = createHttpMacroFeed(options(api, recorder()));
    const result = await feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL);
    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    const notes = result.origin?.notes ?? [];
    assert.equal(notes.length, 2);
    assert.match(notes[0] ?? '', /counts 120 events in this window; only 0 were read/);
    assert.match(
      notes[1] ?? '',
      /1 event was sent by the provider but not shown.*evt-9, it states no time/,
    );
  });

  it('turns a withheld answer into an unavailable result carrying the server’s own words', async () => {
    const message =
      'RATE LIMITED — Finance Calendar rejected the request. Last verified data: 2026-01-06 11:00 UTC.';
    const api = fakeApi(() => ({
      provenance: provenance({ state: 'RATE LIMITED', retrievedAt: null, message }),
      data: null,
    }));
    const sink = recorder();
    const feed = createHttpMacroFeed(options(api, sink));
    const result = await feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL);
    assert.equal(result.status, 'unavailable');
    if (result.status !== 'unavailable') return;
    assert.equal(result.reason, message);
    assert.equal(result.origin?.provenance.state, 'RATE LIMITED');
    assert.equal(sink.seen.length, 1, 'a withheld answer is a fact about the provider too');
  });

  it('refuses an answer that does not fit the contract, and records nothing from it', async () => {
    const api = fakeApi(() => ({ provenance: provenance(), data: { events: 'many' } }));
    const sink = recorder();
    const feed = createHttpMacroFeed(options(api, sink));
    await assert.rejects(
      feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL),
      (error: unknown) => error instanceof ApiClientError && error.code === 'bad_response',
    );
    assert.equal(sink.seen.length, 0);
  });

  it('refuses data that comes with a state that cannot carry it', async () => {
    const api = fakeApi(() => ({
      ...calendarAnswer(),
      provenance: provenance({ state: 'ENV NOT CONNECTED', message: 'ENV NOT CONNECTED — x.' }),
    }));
    const feed = createHttpMacroFeed(options(api, recorder()));
    await assert.rejects(
      feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL),
      (error: unknown) => error instanceof ApiClientError && error.code === 'bad_response',
    );
  });

  describe('the credit, license and reuse notice that come with an event', () => {
    const eventWith = (source: Record<string, unknown>) => ({
      id: 'financecalendar:101',
      timeMs: NOW + 60 * MINUTE,
      currency: 'USD',
      country: 'US',
      title: 'Consumer Price Index (YoY)',
      impact: { level: 'high', classifiedBy: 'Finance Calendar impact rating' },
      actual: null,
      forecast: null,
      previous: '2.7%',
      source: { name: 'Finance Calendar', url: null, retrievedAt: NOW, ...source },
      elvoidInterpretation: null,
    });

    it('keeps them exactly as the server sent them', async () => {
      const rights = {
        credit: 'Data: Example Statistics Office',
        creditUrl: 'https://stats.example.org/',
        license: 'CC-BY-4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        notice: 'Reuse is allowed with credit.',
      };
      const api = fakeApi(() =>
        calendarAnswer({ events: [eventWith({ rights }), eventWith({ rights: { notice: 'n' } })] }),
      );
      const feed = createHttpMacroFeed(options(api, recorder()));
      const result = await feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL);
      assert.equal(result.status, 'available');
      if (result.status !== 'available') return;
      assert.deepEqual(result.items[0]?.source.rights, rights);
      assert.deepEqual(result.items[1]?.source.rights, { notice: 'n' });
    });

    it('shows an event that has none as having none, not as having empty ones', async () => {
      const api = fakeApi(() => calendarAnswer({ events: [eventWith({})] }));
      const feed = createHttpMacroFeed(options(api, recorder()));
      const result = await feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL);
      assert.equal(result.status, 'available');
      if (result.status !== 'available') return;
      assert.equal(result.items[0]?.source.rights, undefined);
      assert.ok(!('rights' in (result.items[0]?.source ?? {})));
    });

    it('refuses an answer whose rights are not text, rather than showing a guess', async () => {
      for (const rights of [
        'CC-BY',
        null,
        { credit: 7 },
        { license: '' },
        { licenseUrl: ['https://x.example/'] },
        { notice: { text: 'n' } },
      ]) {
        const api = fakeApi(() => calendarAnswer({ events: [eventWith({ rights })] }));
        const sink = recorder();
        const feed = createHttpMacroFeed(options(api, sink));
        await assert.rejects(
          feed.getCalendar({ fromMs: NOW, toMs: NOW + 1 }, SIGNAL),
          (error: unknown) => error instanceof ApiClientError && error.code === 'bad_response',
          JSON.stringify(rights),
        );
        assert.equal(sink.seen.length, 0);
      }
    });
  });
});

describe('the news feed', () => {
  const newsProvenance = (overrides: Partial<Provenance> = {}) =>
    provenance({
      provider: 'marketaux',
      providerLabel: 'Marketaux',
      capability: 'financial-news',
      endpoint: 'news/all',
      ...overrides,
    });

  it('explains that a plan returns a sample of what matched, not everything published', async () => {
    const api = fakeApi(() => ({
      provenance: newsProvenance(),
      data: {
        items: [],
        excluded: [],
        found: 400,
        returned: 3,
        limit: 3,
        topic: 'Articles tagged with forex and macro entities.',
        dailyRemaining: 90,
        attribution: { name: 'Marketaux', url: 'https://www.marketaux.com' },
      },
    }));
    const feed = createHttpMacroFeed(options(api, recorder()));
    const result = await feed.getNews(SIGNAL);
    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    const notes = result.origin?.notes ?? [];
    assert.equal(notes[0], 'Articles tagged with forex and macro entities.');
    assert.match(
      notes[1] ?? '',
      /400 articles matched\. The provider returned 3 \(at most 3 per request on this plan\)/,
    );
    assert.match(notes[1] ?? '', /most recent sample, not everything published/);
    assert.deepEqual(api.calls, [{ path: '/api/news', params: {} }]);
  });

  it('shows ENV NOT CONNECTED exactly as the server said it, not a message of its own', async () => {
    const message =
      'ENV NOT CONNECTED — MARKETAUX_API_KEY is missing. Financial news from Marketaux is unavailable.';
    const api = fakeApi(() => ({
      provenance: newsProvenance({
        state: 'ENV NOT CONNECTED',
        retrievedAt: null,
        message,
      }),
      data: null,
    }));
    const feed = createHttpMacroFeed(options(api, recorder()));
    const result = await feed.getNews(SIGNAL);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, message);
  });
});

describe('the bubbles', () => {
  it('records the provenance of the answer and of every input behind it', async () => {
    const answer = provenance({
      provider: 'fred',
      providerLabel: 'FRED',
      capability: 'macro-observations',
      endpoint: 'series/observations',
      state: 'ENV NOT CONNECTED',
      retrievedAt: null,
      message:
        'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    });
    const input = provenance({ ...answer, provider: 'worldbank', providerLabel: 'World Bank' });
    const api = fakeApi(() => ({
      provenance: answer,
      inputs: [input],
      result: { status: 'unavailable', reason: answer.message },
    }));
    const sink = recorder();
    const result = await createHttpBubbleProvider(options(api, sink)).getPoints(SIGNAL);
    assert.equal(result.status, 'unavailable');
    if (result.status !== 'unavailable') return;
    assert.equal(result.reason, answer.message);
    assert.deepEqual(
      sink.seen.map((entry) => entry.provenance.provider),
      ['fred', 'worldbank'],
    );
    assert.equal(result.origin?.inputs?.length, 1);
  });
});

describe('the observations', () => {
  it('asks for one provider at a time, by id, and for the reference rates on their own path', async () => {
    const api = fakeApi((call) =>
      call.path === '/api/macro'
        ? {
            provider: call.params['provider'],
            provenance: provenance({
              provider: 'worldbank',
              providerLabel: 'World Bank',
              capability: 'macro-observations',
              endpoint: 'indicator',
              state: 'UNAVAILABLE',
              retrievedAt: null,
              message: 'UNAVAILABLE — nothing was returned.',
            }),
            entries: [],
          }
        : {
            provenance: provenance({
              provider: 'frankfurter',
              providerLabel: 'Frankfurter',
              capability: 'reference-rates',
              endpoint: 'latest',
            }),
            data: {
              base: 'USD',
              date: Date.UTC(2026, 0, 5),
              rates: [{ currency: 'EUR', rate: 0.92 }],
              missing: ['XAU'],
              attribution: { name: 'Frankfurter', url: 'https://frankfurter.dev' },
            },
          },
    );
    const sink = recorder();
    const observations = createHttpObservations(options(api, sink));
    const macro = await observations.getMacro('worldbank', SIGNAL);
    const rates = await observations.getRates(SIGNAL);
    assert.deepEqual(api.calls, [
      { path: '/api/macro', params: { provider: 'worldbank' } },
      { path: '/api/rates', params: {} },
    ]);
    assert.equal(macro.provenance.state, 'UNAVAILABLE');
    assert.equal(rates.data?.base, 'USD');
    assert.deepEqual(
      sink.seen.map((entry) => entry.provenance.provider),
      ['worldbank', 'frankfurter'],
    );
  });

  it('asks for exactly the providers the server answers for, so none is asked for in vain', () => {
    assert.deepEqual([...MACRO_SERIES_PROVIDERS].sort(), [...MACRO_PROVIDERS].sort());
  });
});

describe('the provider list and the check a person asks for', () => {
  const config = {
    id: 'fred',
    label: 'FRED',
    capabilities: ['macro-observations'],
    role: 'primary',
    roleText: 'Primary source of macro observations.',
    keyVariable: 'FRED_API_KEY',
    keyRequirement: 'required',
    baseUrlVariable: null,
    config: 'env-not-connected',
    keyed: false,
    message:
      'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    limits: 'Published limits.',
  };

  it('lists providers without making a check', async () => {
    const api = fakeApi(() => ({ providers: [config] }));
    const answer = await createProvidersApi(api.client).list(SIGNAL);
    assert.deepEqual(api.calls, [{ path: '/api/providers', params: {} }]);
    assert.equal(answer.providers.length, 1);
    assert.equal(answer.probe, null);
  });

  it('makes a check only when asked for one, and reads what it found', async () => {
    const api = fakeApi(() => ({
      providers: [config],
      probe: {
        provider: 'fred',
        capability: 'macro-observations',
        endpoint: 'series/observations',
        state: 'ENV NOT CONNECTED',
        authentication: 'unknown',
        dataRetrieved: false,
        message: config.message,
        attemptedAt: NOW,
        retrievedAt: null,
        dataAsOf: null,
      },
    }));
    const answer = await createProvidersApi(api.client).probe('fred', SIGNAL);
    assert.deepEqual(api.calls, [{ path: '/api/providers', params: { probe: 'fred' } }]);
    assert.equal(answer.probe?.capability, 'macro-observations');
    assert.equal(answer.probe?.dataRetrieved, false);
  });

  it('refuses a check that does not say which capability it exercised', async () => {
    const api = fakeApi(() => ({
      providers: [config],
      probe: {
        provider: 'fred',
        state: 'ERROR',
        authentication: 'rejected',
        dataRetrieved: false,
        message: 'ERROR — rejected.',
        attemptedAt: NOW,
        retrievedAt: null,
        dataAsOf: null,
      },
    }));
    await assert.rejects(
      createProvidersApi(api.client).probe('fred', SIGNAL),
      (error: unknown) => error instanceof ApiClientError && error.code === 'bad_response',
    );
  });

  it('refuses a list with a provider it does not know or a state without a reason', async () => {
    const unknownProvider = fakeApi(() => ({ providers: [{ ...config, id: 'nobody' }] }));
    await assert.rejects(createProvidersApi(unknownProvider.client).list(SIGNAL));
    const noReason = fakeApi(() => ({ providers: [{ ...config, message: null }] }));
    await assert.rejects(createProvidersApi(noReason.client).list(SIGNAL));
  });
});
