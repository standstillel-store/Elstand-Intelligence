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

const calendarEvent = (over: Record<string, unknown> = {}) => ({
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

const calendarRoute =
  (events: unknown[] = [calendarEvent()]): Route =>
  (call) =>
    call.host === 'www.financecalendar.com'
      ? { events, count: events.length, total: events.length }
      : undefined;

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
  it('answers for today and the next seven days without a credential, with its attribution', async () => {
    const deps = harness({}, calendarRoute());
    const response = await handleCalendar(get('/api/calendar'), deps);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control') ?? '', PUBLIC_CACHE);
    const parsed = parseCalendar(await bodyOf(response));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(parsed.value.provenance.state, 'DELAYED');
    assert.equal(parsed.value.provenance.provider, 'financecalendar');
    assert.equal(parsed.value.data?.events.length, 1);
    assert.equal(parsed.value.data?.events[0]?.timePrecision, 'exact');
    assert.equal(parsed.value.data?.attribution.url, 'https://www.financecalendar.com');
    const sent = deps.fake.calls[0];
    assert.equal(sent?.params['from'], '2026-01-06');
    assert.equal(sent?.params['to'], '2026-01-13');
  });

  it('passes a requested window through, and sends the optional key only to the provider', async () => {
    const deps = harness({ [ENV_FINANCE_CALENDAR_KEY]: KEY }, calendarRoute());
    const response = await handleCalendar(get('/api/calendar?from=2026-01-08&to=2026-01-10'), deps);
    assert.equal(response.status, 200);
    assert.equal(deps.fake.calls[0]?.params['from'], '2026-01-08');
    assert.equal(deps.fake.calls[0]?.params['to'], '2026-01-10');
    assert.equal(deps.fake.calls[0]?.headers['x-api-key'], KEY);
    assert.ok(
      !(await read(response)).everything.includes(KEY),
      'the key never reaches the browser',
    );
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

  it('answers 200 with the state when the provider fails, and shares nothing', async () => {
    const failing = harness({}, () => json({ error: 'down' }, 503));
    const response = await handleCalendar(get('/api/calendar'), failing);
    assert.equal(
      response.status,
      200,
      'a provider outage is a state of the product, not a fault of the request',
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseCalendar(await bodyOf(response));
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.data, null);
    assert.equal(parsed.value.provenance.state, 'ERROR');

    const limited = harness({}, () => json({ error: 'slow down' }, 429));
    const limitedBody = parseCalendar(
      await bodyOf(await handleCalendar(get('/api/calendar'), limited)),
    );
    assert.ok(limitedBody.ok);
    assert.equal(limitedBody.ok && limitedBody.value.provenance.state, 'RATE LIMITED');
    assert.match(
      (limitedBody.ok && limitedBody.value.provenance.message) || '',
      /^RATE LIMITED — Finance Calendar rejected the request\./,
    );
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
    assert.equal(parsed.value.providers.length, 10);
    const fred = parsed.value.providers.find((entry) => entry.id === 'fred');
    assert.equal(fred?.config, 'ready');
    assert.equal(
      fred?.keyVariable,
      'FRED_API_KEY',
      'the NAME of the variable is shown, never its value',
    );
    const imf = parsed.value.providers.find((entry) => entry.id === 'imf');
    assert.equal(imf?.config, 'no-endpoint');
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
