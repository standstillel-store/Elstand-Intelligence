import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTtlCache } from '../../server/cache.js';
import { ENV_API_KEY } from '../../server/env.js';
import {
  handleBubbles,
  handleCalendar,
  handleMacro,
  handleNews,
  handleProviders,
  handleRates,
} from '../../server/capability-handlers.js';
import type { HandlerDeps } from '../../server/handlers.js';
import {
  ENV_ALPHA_VANTAGE_KEY,
  ENV_FINANCE_CALENDAR_KEY,
  ENV_FRED_KEY,
  ENV_MARKETAUX_KEY,
} from '../../server/provider-registry.js';
import { createProviderRuntime } from '../../server/provider-runtime.js';
import { parseProvidersAnswer } from '../../src/data/wire-providers.js';
import {
  parseBubbles,
  parseCalendar,
  parseMacro,
  parseNews,
  parseRates,
} from '../../src/data/wire-macro.js';
import {
  FC_HOST,
  SMT_HOST,
  XOOMAR_HOST,
  financeCalendarBody,
  smtBody,
  smtEvent,
  xoomarBody,
} from '../support/calendar-providers.js';
import { FIXTURE_NOW } from '../support/fixtures.js';
import {
  createFakeProviders,
  json,
  type FakeProviders,
  type ProviderCallRecord,
  type ProviderReply,
} from '../support/fake-provider.js';
import { vendorError } from '../support/fake-vendor.js';
import {
  blsMonths,
  dailyBars,
  day,
  fredRoute,
  twelveRoute,
  type Route,
} from '../support/macro-fixtures.js';

/**
 * The capability endpoints, called the way Vercel calls them, against stand-ins that answer in
 * the shapes the providers document. They prove what the endpoints send and what they never
 * send. They do not prove that any live provider answers this way today.
 */

const KEY = 'a1'.repeat(16); // key-shaped (FRED's 32 lowercase characters) without writing one out
const ORIGIN = 'https://elstand.test';

interface Harness extends HandlerDeps {
  readonly fake: FakeProviders;
}

function harness(env: Record<string, string | undefined>, route: Route): Harness {
  const fake = createFakeProviders(route);
  const runtime = {
    ...createProviderRuntime(createTtlCache()),
    sleep: async (): Promise<void> => {},
  };
  return { env, fetch: fake.fetch, now: () => FIXTURE_NOW, runtime, fake };
}

const nothing: Route = () => {
  throw new Error('no provider may be asked');
};

const get = (path: string): Request => new Request(`${ORIGIN}${path}`);

async function bodyOf(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

/** A response read once: its parsed body, and every header and the body as one string. */
interface Reading {
  readonly body: unknown;
  /** Everything the response says, for "never contains the key" checks. */
  readonly everything: string;
}

async function read(response: Response): Promise<Reading> {
  const text = await response.text();
  const headers = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  return { body: JSON.parse(text), everything: `${headers}\n${text}` };
}

const PUBLIC_CACHE = /^public, max-age=0, s-maxage=\d+$/;

// ---- stand-in provider payloads ------------------------------------------------------------------

/** ShowMyTrades answers; every other host is unknown to this route. */
const smtRoute =
  (events?: unknown[]): Route =>
  (call) =>
    call.host === SMT_HOST ? smtBody(events) : undefined;

/** ShowMyTrades is down, XOOMAR answers, and the optional Finance Calendar is asked last. */
const xoomarOnlyRoute =
  (events?: unknown[]): Route =>
  (call) => {
    if (call.host === SMT_HOST) return json({ error: 'down' }, 503);
    if (call.host === XOOMAR_HOST) return xoomarBody(events);
    return undefined;
  };

const newsArticle = (over: Record<string, unknown> = {}) => ({
  uuid: 'a1b2c3',
  title: 'Central bank holds rates steady',
  description: 'not kept',
  url: 'https://news.example.org/story-1',
  published_at: '2026-01-06T10:15:00.000000Z',
  source: 'news.example.org',
  entities: [{ symbol: 'EURUSD', name: 'EUR/USD', type: 'currency', sentiment_score: 0.25 }],
  ...over,
});

const newsRoute =
  (articles: unknown[] = [newsArticle()]): Route =>
  (call) =>
    call.host === 'api.marketaux.com'
      ? { meta: { found: 812, returned: articles.length, limit: 3, page: 1 }, data: articles }
      : undefined;

const ratesRoute =
  (date = '2026-01-05', rates: Record<string, number> = { EUR: 0.85, GBP: 0.74 }): Route =>
  (call) =>
    call.host === 'api.frankfurter.dev' ? { amount: 1, base: 'USD', date, rates } : undefined;

const blsRoute: Route = (call) =>
  call.host === 'api.bls.gov'
    ? {
        status: 'REQUEST_SUCCEEDED',
        message: [],
        Results: {
          series: ['LNS14000000', 'CES0000000001', 'CUUR0000SA0'].map((id) =>
            blsMonths(id, [2025, 11], 4, 4.2),
          ),
        },
      }
    : undefined;

// ---- calendar ---------------------------------------------------------------------------------------

describe('GET /api/calendar', () => {
  it('answers with no credential at all, from ShowMyTrades, and says so', async () => {
    const deps = harness({}, smtRoute());
    const response = await handleCalendar(get('/api/calendar'), deps);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control') ?? '', PUBLIC_CACHE);
    const parsed = parseCalendar(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    const { provenance, data } = parsed.value;
    assert.equal(provenance.provider, 'showmytrades');
    assert.equal(provenance.state, 'DELAYED', 'an HTTP 200 is not "live"');
    assert.equal(provenance.fallback, null);
    assert.equal(provenance.cache, 'fresh');
    assert.equal(data?.events.length, 1);
    const event = data?.events[0];
    assert.equal(event?.id, 'showmytrades:usd-test-inflation-release.20260107T1330');
    assert.equal(event?.currency, 'USD');
    assert.equal(event?.country, null);
    assert.equal(event?.timePrecision, 'exact');
    assert.equal(event?.impact?.classifiedBy, 'ShowMyTrades impact rating');
    assert.equal(event?.forecast, '2.9%');
    assert.equal(event?.actual, null, 'an empty actual is null, never a stand-in');
    assert.equal(event?.period, '2025-12');
    assert.equal(event?.confidence, 'sources_agree');
    assert.equal(data?.attribution.name, 'Economic calendar by ShowMyTrades');
    assert.equal(data?.attribution.url, 'https://showmytrades.com/tools/economic-calendar');
    assert.ok(data?.notes.some((note) => note.includes('answers only from')));
    const sent = deps.fake.calls;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.path, '/api/public/calendar/v1');
    assert.equal(sent[0]?.params['days'], '8');
    assert.equal(sent[0]?.params['impact'], 'high,medium,low');
    assert.equal(sent[0]?.headers['x-api-key'], undefined, 'it sends no credential');
  });

  it('does not depend on the Finance Calendar key: it is never ENV NOT CONNECTED for want of it', async () => {
    const deps = harness({}, smtRoute());
    const parsed = parseCalendar(await bodyOf(await handleCalendar(get('/api/calendar'), deps)));
    assert.ok(parsed.ok);
    assert.notEqual(parsed.ok && parsed.value.provenance.state, 'ENV NOT CONNECTED');
    assert.ok(deps.fake.calls.every((call) => call.host !== FC_HOST));
  });

  it('shares one request between windows that need the same number of days', async () => {
    const deps = harness({}, smtRoute());
    await handleCalendar(get('/api/calendar?from=2026-01-06&to=2026-01-08'), deps);
    await handleCalendar(get('/api/calendar?from=2026-01-07&to=2026-01-09'), deps);
    await handleCalendar(get('/api/calendar'), deps);
    const asked = deps.fake.calls.filter((call) => call.host === SMT_HOST);
    assert.deepEqual(
      asked.map((call) => call.params['days']),
      ['8'],
      'all three windows are covered by the same eight-day answer, so ShowMyTrades is asked once',
    );
  });

  it('cuts the answer back to the requested window and says what the provider does not cover', async () => {
    const early = smtEvent({
      id: 'usd-early.20260106T0200',
      ts: Date.UTC(2026, 0, 6, 2, 0) / 1000,
      time: '2026-01-06T02:00:00Z',
    });
    const deps = harness({}, smtRoute([early, smtEvent()]));
    const parsed = parseCalendar(
      await bodyOf(await handleCalendar(get('/api/calendar?from=2026-01-07&to=2026-01-07'), deps)),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    const ids = parsed.value.data?.events.map((event) => event.id);
    assert.deepEqual(ids, ['showmytrades:usd-test-inflation-release.20260107T1330']);
    assert.equal(
      parsed.value.data?.notes.some((note) => note.includes('answers only from')),
      false,
      'that window starts after the provider’s own, so nothing is missing from it',
    );
  });

  it('falls back to XOOMAR when ShowMyTrades cannot answer, and says why', async () => {
    const deps = harness({}, xoomarOnlyRoute());
    const response = await read(await handleCalendar(get('/api/calendar'), deps));
    const parsed = parseCalendar(response.body);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    const { provenance, data } = parsed.value;
    assert.equal(provenance.provider, 'xoomar');
    assert.equal(provenance.fallback?.from, 'showmytrades');
    assert.match(provenance.fallback?.reason ?? '', /ShowMyTrades/);
    assert.equal(data?.events[0]?.forecast, null, 'XOOMAR never publishes a forecast');
    assert.equal(data?.events[0]?.surprise, undefined);
    assert.ok(data?.notes.some((note) => note.includes('U.S. agency releases only')));
    assert.equal(data?.attribution.name, 'XOOMAR');
    assert.ok(deps.fake.calls.every((call) => call.host !== FC_HOST));
  });

  it('is UNAVAILABLE, with every source’s reason and no event, when nobody answers', async () => {
    const deps = harness({}, () => json({ error: 'down' }, 503));
    const response = await handleCalendar(get('/api/calendar'), deps);
    assert.equal(
      response.status,
      200,
      'a provider outage is a state of the product, not a fault of the request',
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseCalendar(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.data, null);
    assert.equal(parsed.value.provenance.state, 'UNAVAILABLE');
    const message = parsed.value.provenance.message ?? '';
    assert.match(message, /^UNAVAILABLE — No economic calendar source answered\./);
    assert.match(message, /ShowMyTrades \(ERROR\)/);
    assert.match(message, /XOOMAR \(ERROR\)/);
  });

  it('asks the optional Finance Calendar only when its key is set, and only after the free sources', async () => {
    const withKey = { [ENV_FINANCE_CALENDAR_KEY]: KEY };
    const down = (call: ProviderCallRecord): ProviderReply => {
      if (call.host === FC_HOST) return financeCalendarBody();
      return json({ error: 'down' }, 503);
    };
    const keyed = harness(withKey, down);
    const parsed = parseCalendar(await bodyOf(await handleCalendar(get('/api/calendar'), keyed)));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    assert.equal(parsed.ok && parsed.value.provenance.provider, 'financecalendar');
    assert.equal(parsed.ok && parsed.value.provenance.fallback?.from, 'showmytrades');
    const hosts = keyed.fake.calls.map((call) => call.host);
    assert.ok(hosts.indexOf(SMT_HOST) < hosts.indexOf(XOOMAR_HOST));
    assert.ok(hosts.indexOf(XOOMAR_HOST) < hosts.indexOf(FC_HOST));
    assert.equal(keyed.fake.calls.find((call) => call.host === FC_HOST)?.headers['x-api-key'], KEY);

    const keyless = harness({}, down);
    await handleCalendar(get('/api/calendar'), keyless);
    assert.ok(keyless.fake.calls.every((call) => call.host !== FC_HOST));
  });

  it('passes a requested window through to the sources it asks', async () => {
    const deps = harness({}, xoomarOnlyRoute());
    await handleCalendar(get('/api/calendar?from=2026-01-08&to=2026-01-10'), deps);
    const xoomar = deps.fake.calls.find((call) => call.host === XOOMAR_HOST);
    assert.equal(xoomar?.params['from'], '2026-01-08');
    assert.equal(xoomar?.params['to'], '2026-01-10');
    assert.equal(xoomar?.headers['x-api-key'], undefined, 'without a key none is sent');
  });

  it('sends the optional XOOMAR key only to XOOMAR, and never to the browser', async () => {
    const deps = harness({ XOOMAR_API_KEY: KEY }, xoomarOnlyRoute());
    const response = await read(await handleCalendar(get('/api/calendar'), deps));
    const xoomar = deps.fake.calls.find((call) => call.host === XOOMAR_HOST);
    assert.equal(xoomar?.headers['x-api-key'], KEY);
    assert.ok(
      deps.fake.calls
        .filter((call) => call.host !== XOOMAR_HOST)
        .every((call) => !call.url.includes(KEY)),
    );
    assert.ok(!response.everything.includes(KEY), 'the key never reaches the browser');
  });

  it('refuses a window it cannot understand or should not allow, without asking the provider', async () => {
    const cases = [
      '?from=yesterday',
      '?from=2026-02-30',
      '?from=2026-01-10&to=2026-01-08',
      '?from=2026-01-06&to=2026-03-01',
      '?from=2025-01-01&to=2025-01-05',
      '?from=2026-09-01&to=2026-09-05',
    ];
    for (const query of cases) {
      const deps = harness({}, nothing);
      const response = await handleCalendar(get(`/api/calendar${query}`), deps);
      assert.equal(response.status, 400, query);
      assert.equal(deps.fake.calls.length, 0, query);
    }
  });

  it('accepts GET only', async () => {
    const response = await handleCalendar(
      new Request(`${ORIGIN}/api/calendar`, { method: 'POST' }),
      harness({}, nothing),
    );
    assert.equal(response.status, 405);
  });
});

// ---- news ---------------------------------------------------------------------------------------------

describe('GET /api/news', () => {
  it('is ENV NOT CONNECTED, naming the variable, without the Marketaux key, and asks nothing', async () => {
    const deps = harness({}, nothing);
    const response = await handleNews(get('/api/news'), deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(deps.fake.calls.length, 0);
    const parsed = parseNews(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.data, null);
    assert.equal(parsed.value.provenance.state, 'ENV NOT CONNECTED');
    assert.match(parsed.value.provenance.message ?? '', /MARKETAUX_API_KEY/);
  });

  it('carries real headlines with their publisher, times and attribution, and never the key', async () => {
    const deps = harness({ [ENV_MARKETAUX_KEY]: KEY }, newsRoute());
    const response = await handleNews(get('/api/news'), deps);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control') ?? '', PUBLIC_CACHE);
    assert.equal(deps.fake.calls[0]?.params['api_token'], KEY, 'the provider is sent the key');
    const reading = await read(response);
    assert.ok(!reading.everything.includes(KEY), 'the browser never is');
    const parsed = parseNews(reading.body);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const data = parsed.value.data;
    assert.equal(parsed.value.provenance.state, 'DELAYED');
    assert.equal(data?.items.length, 1);
    assert.equal(data?.items[0]?.publisher, 'news.example.org');
    assert.equal(data?.items[0]?.publishedAt, Date.UTC(2026, 0, 6, 10, 15));
    assert.equal(data?.found, 812, 'a short list is never mistaken for a quiet day');
    assert.equal(data?.attribution.name, 'Marketaux');
    assert.equal(parsed.value.provenance.dataAsOf, Date.UTC(2026, 0, 6, 10, 15));
  });

  it('says RATE LIMITED when the provider refuses, and shares nothing', async () => {
    const deps = harness({ [ENV_MARKETAUX_KEY]: KEY }, () => json({ error: 'limit' }, 429));
    const response = await handleNews(get('/api/news'), deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseNews(await bodyOf(response));
    assert.equal(parsed.ok && parsed.value.provenance.state, 'RATE LIMITED');
  });
});

// ---- reference rates -------------------------------------------------------------------------------------

describe('GET /api/rates', () => {
  it('answers without a credential, as reference rates with their fixing date', async () => {
    const deps = harness({}, ratesRoute());
    const response = await handleRates(get('/api/rates'), deps);
    assert.equal(response.status, 200);
    const parsed = parseRates(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.provenance.state, 'DELAYED');
    assert.equal(parsed.value.provenance.dataAsOf, Date.UTC(2026, 0, 5));
    assert.equal(parsed.value.data?.base, 'USD');
    assert.equal(parsed.value.data?.rates.length, 2);
    assert.deepEqual(
      parsed.value.data?.missing,
      ['JPY', 'CHF', 'CAD', 'AUD', 'NZD'],
      'symbols the provider did not answer are listed, not filled in',
    );
    assert.match(parsed.value.data?.attribution.name ?? '', /Frankfurter/);
  });

  it('labels a fixing older than five days STALE, though it was just retrieved', async () => {
    const deps = harness({}, ratesRoute('2025-12-20'));
    const response = await handleRates(get('/api/rates'), deps);
    const parsed = parseRates(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.provenance.state, 'STALE');
    assert.match(parsed.value.provenance.message ?? '', /older than 5 days/);
    assert.equal(parsed.value.data?.rates.length, 2, 'the old values are still shown, as stale');
  });
});

// ---- macro series and bubbles ---------------------------------------------------------------------------

describe('GET /api/macro', () => {
  it('needs a known macro provider', async () => {
    for (const query of [
      '',
      '?provider=',
      '?provider=imf',
      '?provider=twelvedata',
      '?provider=FRED',
    ]) {
      const response = await handleMacro(get(`/api/macro${query}`), harness({}, nothing));
      assert.equal(response.status, 400, query);
    }
  });

  it('is ENV NOT CONNECTED for FRED without its key and shares nothing', async () => {
    const response = await handleMacro(get('/api/macro?provider=fred'), harness({}, nothing));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseMacro(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.entries, []);
    assert.equal(
      parsed.value.provenance.message,
      'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    );
  });

  it('answers for a keyless provider, with each series carrying its own provenance', async () => {
    const response = await handleMacro(get('/api/macro?provider=bls'), harness({}, blsRoute));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control') ?? '', PUBLIC_CACHE);
    const parsed = parseMacro(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.entries.length, 3);
    for (const entry of parsed.value.entries) {
      assert.equal(entry.provenance.provider, 'bls');
      assert.equal(entry.provenance.state, 'DELAYED');
      assert.ok(entry.series !== null && entry.series.unit !== '');
    }
  });
});

describe('GET /api/bubbles', () => {
  it('is unavailable, with the state and no data, when an input is not connected', async () => {
    const response = await handleBubbles(get('/api/bubbles'), harness({}, nothing));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseBubbles(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.result.status, 'unavailable');
    assert.equal(parsed.value.provenance.state, 'ENV NOT CONNECTED');
  });

  it('draws what real inputs support, shared briefly, and lists every input it used', async () => {
    const route: Route = (call: ProviderCallRecord): ProviderReply =>
      fredRoute({}, twelveRoute(dailyBars(40, day(2026, 1, 5))))(call);
    const deps = harness({ [ENV_FRED_KEY]: KEY, [ENV_API_KEY]: 'td-test-key-1234' }, route);
    const response = await handleBubbles(get('/api/bubbles'), deps);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control') ?? '', PUBLIC_CACHE);
    const reading = await read(response);
    const parsed = parseBubbles(reading.body);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.result.status, 'available');
    assert.equal(parsed.value.provenance.state, 'CALCULATED');
    assert.equal(parsed.value.inputs.length, 3);
    assert.ok(
      !reading.everything.includes(KEY) && !reading.everything.includes('td-test-key-1234'),
    );
  });
});

// ---- the provider page ------------------------------------------------------------------------------------

describe('GET /api/providers', () => {
  it('lists every provider with what is configured, and no value', async () => {
    const env = { [ENV_FRED_KEY]: KEY, [ENV_API_KEY]: 'td-test-key-1234' };
    const response = await handleProviders(get('/api/providers'), harness(env, nothing));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const reading = await read(response);
    assert.ok(
      !reading.everything.includes(KEY) && !reading.everything.includes('td-test-key-1234'),
    );
    const parsed = parseProvidersAnswer(reading.body);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.probe, null, 'no check was asked for, so none is reported');
    assert.equal(parsed.value.providers.length, 13);
    const fred = parsed.value.providers.find((entry) => entry.id === 'fred');
    assert.equal(fred?.config, 'ready');
    assert.equal(
      fred?.keyVariable,
      'FRED_API_KEY',
      'the NAME of the variable is shown, never its value',
    );
    const imf = parsed.value.providers.find((entry) => entry.id === 'imf');
    assert.equal(imf?.config, 'no-endpoint');
    const configOf = (id: string): string | undefined =>
      parsed.value.providers.find((entry) => entry.id === id)?.config;
    assert.equal(configOf('showmytrades'), 'ready', 'the primary calendar needs no key');
    assert.equal(configOf('xoomar'), 'ready', 'the fallback calendar works without a key');
    assert.equal(configOf('arib'), 'license-gated', 'AriB is never reported as connected');
    assert.equal(configOf('financecalendar'), 'env-not-connected');
    assert.equal(
      parsed.value.providers.find((entry) => entry.id === 'financecalendar')?.role,
      'optional',
    );
  });

  it('makes no provider request unless a check is asked for', async () => {
    const deps = harness({ [ENV_ALPHA_VANTAGE_KEY]: KEY }, nothing);
    await handleProviders(get('/api/providers'), deps);
    assert.equal(deps.fake.calls.length, 0, 'listing never spends a provider allowance');
  });

  it('refuses a check for something that is not a provider', async () => {
    const response = await handleProviders(
      get('/api/providers?probe=nonsense'),
      harness({}, nothing),
    );
    assert.equal(response.status, 400);
  });

  it('checks a keyless provider with one real request and reports what came back', async () => {
    const deps = harness({}, ratesRoute());
    const response = await handleProviders(get('/api/providers?probe=frankfurter'), deps);
    const parsed = parseProvidersAnswer(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(deps.fake.calls.length, 1);
    assert.equal(parsed.value.probe?.provider, 'frankfurter');
    assert.equal(parsed.value.probe?.state, 'DELAYED');
    assert.equal(parsed.value.probe?.authentication, 'not-required');
    assert.equal(parsed.value.probe?.dataRetrieved, true);
    assert.equal(parsed.value.probe?.dataAsOf, Date.UTC(2026, 0, 5));
  });

  it('says a provider without its credential is not connected, and asks nothing', async () => {
    const deps = harness({}, nothing);
    const response = await handleProviders(get('/api/providers?probe=fred'), deps);
    const parsed = parseProvidersAnswer(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(deps.fake.calls.length, 0);
    assert.equal(parsed.value.probe?.state, 'ENV NOT CONNECTED');
    assert.equal(parsed.value.probe?.dataRetrieved, false);
    assert.equal(parsed.value.probe?.authentication, 'unknown');
    assert.match(parsed.value.probe?.message ?? '', /FRED_API_KEY is missing/);
  });

  it('tells a rejected key from an accepted one, and never shows either', async () => {
    const rejecting = harness({ [ENV_FRED_KEY]: KEY }, () =>
      json(
        { error_code: 400, error_message: `Bad Request. The api_key ${KEY} is not registered.` },
        400,
      ),
    );
    const rejectedResponse = await handleProviders(get('/api/providers?probe=fred'), rejecting);
    const rejectedReading = await read(rejectedResponse);
    assert.ok(
      !rejectedReading.everything.includes(KEY),
      'a key the provider echoed back is never passed on',
    );
    const rejected = parseProvidersAnswer(rejectedReading.body);
    assert.ok(rejected.ok);
    assert.equal(rejected.ok && rejected.value.probe?.authentication, 'rejected');
    assert.equal(rejected.ok && rejected.value.probe?.dataRetrieved, false);
    assert.equal(rejected.ok && rejected.value.probe?.state, 'ERROR');

    const accepting = harness({ [ENV_FRED_KEY]: KEY }, fredRoute());
    const accepted = parseProvidersAnswer(
      await bodyOf(await handleProviders(get('/api/providers?probe=fred'), accepting)),
    );
    assert.ok(accepted.ok);
    assert.equal(accepted.ok && accepted.value.probe?.authentication, 'accepted');
    assert.equal(accepted.ok && accepted.value.probe?.dataRetrieved, true);
    assert.equal(accepting.fake.calls.length, 1, 'one request, not the whole catalog');
  });

  it('never presents IMF as connected: it has no supported endpoint', async () => {
    const deps = harness({}, nothing);
    const parsed = parseProvidersAnswer(
      await bodyOf(await handleProviders(get('/api/providers?probe=imf'), deps)),
    );
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(deps.fake.calls.length, 0);
    assert.equal(parsed.value.probe?.state, 'UNAVAILABLE');
    assert.equal(parsed.value.probe?.dataRetrieved, false);
  });

  it('reports a Twelve Data rate limit as RATE LIMITED, not as a working connection', async () => {
    const deps = harness({ [ENV_API_KEY]: 'td-test-key-1234' }, () => vendorError(429, 'credits'));
    const parsed = parseProvidersAnswer(
      await bodyOf(await handleProviders(get('/api/providers?probe=twelvedata'), deps)),
    );
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.probe?.state, 'RATE LIMITED');
    assert.equal(parsed.value.probe?.dataRetrieved, false);
  });
});
