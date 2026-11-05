import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STALE_AFTER_MS } from '../../server/env.js';
import {
  TTL_VARIABLES,
  policyFor,
  sharedCacheControl,
  type DataClass,
} from '../../server/cache-policy.js';
import {
  PROVIDER_ORDER,
  PROVIDER_SPECS,
  budgetFor,
  describeProviders,
  providersFor,
  readAllProviders,
  readProvider,
  unreadyMessage,
} from '../../server/provider-registry.js';
import { NO_ENDPOINT_MESSAGE, PROVIDER_IDS } from '../../src/core/provider-state.js';

/** A credential-shaped value that is not one: built at run time, so no literal looks like a secret. */
const token = (name: string): string => `value-of-${name}-${'x'.repeat(6)}`;
const fredKey = (): string => 'a'.repeat(32);

describe('provider registry', () => {
  it('knows every provider once, in the order of the brief', () => {
    assert.deepEqual([...PROVIDER_ORDER], [...PROVIDER_IDS]);
    assert.equal(new Set(PROVIDER_IDS).size, 10);
    for (const id of PROVIDER_IDS) assert.equal(PROVIDER_SPECS[id].id, id);
  });

  it('with an empty environment, says exactly what is missing and keeps public providers usable', () => {
    const all = readAllProviders({});
    assert.equal(
      unreadyMessage(all.fred),
      'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    );
    for (const id of ['twelvedata', 'alphavantage', 'fred', 'marketaux', 'bea'] as const) {
      assert.equal(all[id].kind, 'env-missing', id);
      assert.match(unreadyMessage(all[id]) ?? '', /^ENV NOT CONNECTED — [A-Z_]+ is missing\. /, id);
    }
    // Keys that are optional, and providers that need none, are ready without any variable.
    for (const id of ['financecalendar', 'bls', 'frankfurter', 'worldbank'] as const) {
      const reading = all[id];
      assert.equal(reading.kind, 'ready', id);
      assert.equal(reading.kind === 'ready' ? reading.apiKey : 'x', null, `${id} runs keyless`);
    }
    assert.equal(unreadyMessage(all.imf), NO_ENDPOINT_MESSAGE);
    assert.equal(all.imf.kind, 'no-endpoint');
  });

  it('does not let one missing or invalid variable affect another provider', () => {
    const all = readAllProviders({ FRED_API_KEY: fredKey(), MARKETAUX_API_KEY: 'has space in it' });
    assert.equal(all.fred.kind, 'ready');
    assert.equal(all.marketaux.kind, 'invalid');
    assert.equal(all.bea.kind, 'env-missing');
    assert.equal(all.frankfurter.kind, 'ready');
  });

  it('refuses a credential that is not one clean token, without repeating it', () => {
    for (const bad of ['two words', '"quoted"', "it's", 'tab\there']) {
      const reading = readProvider('marketaux', { MARKETAUX_API_KEY: bad });
      assert.equal(reading.kind, 'invalid', bad);
      const message = unreadyMessage(reading) ?? '';
      assert.match(message, /^ERROR — MARKETAUX_API_KEY is set but /);
      assert.ok(!message.includes(bad), 'the value is never shown');
    }
  });

  it('checks the shape of a FRED key, which is 32 lowercase letters and digits', () => {
    assert.equal(readProvider('fred', { FRED_API_KEY: fredKey() }).kind, 'ready');
    assert.equal(readProvider('fred', { FRED_API_KEY: 'A'.repeat(32) }).kind, 'invalid');
    assert.equal(readProvider('fred', { FRED_API_KEY: 'a'.repeat(31) }).kind, 'invalid');
    assert.equal(readProvider('fred', { FRED_API_KEY: '   ' }).kind, 'env-missing');
  });

  it('takes a base-URL override only if it is a plain https address', () => {
    const ok = readProvider('frankfurter', {
      FRANKFURTER_API_BASE_URL: 'https://rates.example.org/v1/',
    });
    assert.equal(ok.kind === 'ready' ? ok.baseUrl : '', 'https://rates.example.org/v1');
    const standard = readProvider('worldbank', {});
    assert.equal(standard.kind === 'ready' ? standard.baseUrl : '', 'https://api.worldbank.org/v2');

    const credentialed = new URL('https://rates.example.org/v1');
    credentialed.username = 'someone';
    credentialed.password = 'hunter2';
    for (const bad of [
      'http://rates.example.org',
      credentialed.href,
      'not a url',
      'https://x.org/?k=1',
    ]) {
      const reading = readProvider('frankfurter', { FRANKFURTER_API_BASE_URL: bad });
      assert.equal(reading.kind, 'invalid', bad);
      const message = unreadyMessage(reading) ?? '';
      assert.ok(
        !message.includes('hunter2') && !message.includes(bad),
        'the address is never repeated',
      );
      assert.match(message, /FRANKFURTER_API_BASE_URL/);
    }
  });

  it('never uses IMF_API_BASE_URL and says so when it is set', () => {
    const reading = readProvider('imf', { IMF_API_BASE_URL: 'https://imf.example.org' });
    assert.equal(reading.kind, 'no-endpoint');
    assert.match(
      unreadyMessage(reading) ?? '',
      /IMF_API_BASE_URL is set, but no IMF endpoint adapter exists/,
    );
  });

  it('describes providers to the browser by name and state only, never with a credential or address', () => {
    const env = {
      TWELVE_DATA_API_KEY: token('twelve'),
      ALPHA_VANTAGE_API_KEY: token('alpha'),
      FRED_API_KEY: fredKey(),
      FINANCE_CALENDAR_API_KEY: token('calendar'),
      MARKETAUX_API_KEY: token('marketaux'),
      BLS_API_KEY: token('bls'),
      BEA_API_KEY: token('bea'),
      FRANKFURTER_API_BASE_URL: 'https://private-mirror.example.org/v1',
      WORLD_BANK_API_BASE_URL: 'http://not-https.example.org',
    };
    const text = JSON.stringify(describeProviders(env));
    for (const secret of Object.values(env)) assert.ok(!text.includes(secret), secret);
    assert.ok(!text.includes('private-mirror'));

    const byId = new Map(describeProviders(env).map((entry) => [entry.id, entry]));
    assert.equal(byId.get('fred')?.config, 'ready');
    assert.equal(byId.get('fred')?.keyed, true);
    assert.equal(byId.get('fred')?.keyVariable, 'FRED_API_KEY');
    assert.equal(byId.get('worldbank')?.config, 'invalid');
    assert.equal(byId.get('imf')?.config, 'no-endpoint');
    assert.equal(byId.get('frankfurter')?.baseUrlVariable, 'FRANKFURTER_API_BASE_URL');
  });

  it('reports a key as present only when it is, and a keyless provider as not keyed', () => {
    const byId = new Map(
      describeProviders({ BLS_API_KEY: token('bls') }).map((entry) => [entry.id, entry]),
    );
    assert.equal(byId.get('bls')?.keyed, true);
    assert.equal(byId.get('financecalendar')?.keyed, false);
    assert.equal(byId.get('financecalendar')?.config, 'ready');
    assert.equal(byId.get('fred')?.keyed, false);
    assert.equal(byId.get('fred')?.config, 'env-not-connected');
  });

  it('lists the providers that can supply a capability, primary first', () => {
    assert.deepEqual(
      providersFor('forex-market-data').map((spec) => spec.id),
      ['twelvedata', 'alphavantage'],
    );
    assert.deepEqual(
      providersFor('macro-observations').map((spec) => spec.id),
      ['fred', 'worldbank', 'imf', 'bls', 'bea'],
    );
    assert.deepEqual(
      providersFor('economic-calendar').map((spec) => spec.id),
      ['financecalendar'],
    );
    assert.deepEqual(
      providersFor('financial-news').map((spec) => spec.id),
      ['marketaux'],
    );
    assert.deepEqual(
      providersFor('reference-rates').map((spec) => spec.id),
      ['frankfurter'],
    );
  });

  it('keeps every budget below the published limit it is based on', () => {
    assert.deepEqual(budgetFor('twelvedata', {}, true), { perMinute: 8, perDay: 800 });
    assert.deepEqual(budgetFor('alphavantage', {}, true), { perMinute: 5, perDay: 25 });
    assert.deepEqual(budgetFor('marketaux', {}, true), { perMinute: 3, perDay: 90 });
    assert.deepEqual(budgetFor('financecalendar', {}, false), { perMinute: 20, perDay: 1_500 });
    assert.deepEqual(budgetFor('financecalendar', {}, true), { perMinute: 30, perDay: 9_000 });
    assert.deepEqual(budgetFor('bls', {}, false), { perMinute: 5, perDay: 20 });
    assert.deepEqual(budgetFor('bls', {}, true), { perMinute: 20, perDay: 400 });
    assert.deepEqual(budgetFor('imf', {}, false), { perMinute: 0, perDay: 0 });
  });

  it('lets a paid Twelve Data plan raise its budget, and ignores a value that is not a number', () => {
    const paid = { TWELVE_DATA_CREDITS_PER_MINUTE: '55', TWELVE_DATA_CREDITS_PER_DAY: '50000' };
    assert.deepEqual(budgetFor('twelvedata', paid, true), { perMinute: 55, perDay: 50_000 });
    const nonsense = { TWELVE_DATA_CREDITS_PER_MINUTE: 'lots', TWELVE_DATA_CREDITS_PER_DAY: '-4' };
    assert.deepEqual(budgetFor('twelvedata', nonsense, true), { perMinute: 8, perDay: 800 });
    const zero = { TWELVE_DATA_CREDITS_PER_MINUTE: '0' };
    assert.equal(
      budgetFor('twelvedata', zero, true).perMinute,
      1,
      'a zero budget is raised to the minimum',
    );
  });
});

describe('cache policy', () => {
  const ttl = (dataClass: DataClass, env: Record<string, string> = {}) =>
    policyFor(env, dataClass).ttlMs / 1000;

  it('gives each kind of data its own lifetime', () => {
    assert.equal(ttl('quote'), 60);
    assert.equal(ttl('candles-intraday'), 60);
    assert.equal(ttl('candles-daily'), 900);
    assert.equal(ttl('calendar'), 900);
    assert.equal(ttl('news'), 1_800);
    assert.equal(ttl('macro-series'), 21_600);
    assert.equal(ttl('reference-rates'), 3_600);
  });

  it('follows the refresh cadence for quotes and intraday candles, and never re-reads a daily bar faster than 15 minutes', () => {
    assert.equal(ttl('quote', { ELSTAND_REFRESH_SECONDS: '30' }), 30);
    assert.equal(ttl('candles-intraday', { ELSTAND_REFRESH_SECONDS: '30' }), 30);
    assert.equal(ttl('candles-daily', { ELSTAND_REFRESH_SECONDS: '10' }), 900);
    assert.equal(ttl('candles-daily', { ELSTAND_REFRESH_SECONDS: '3600' }), 3_600);
  });

  it('lets four lifetimes be tuned, clamps them, and ignores nonsense', () => {
    assert.equal(ttl('news', { ELSTAND_TTL_NEWS_SECONDS: '7200' }), 7_200);
    assert.equal(ttl('news', { ELSTAND_TTL_NEWS_SECONDS: '10' }), 300);
    assert.equal(ttl('news', { ELSTAND_TTL_NEWS_SECONDS: '9999999' }), 86_400);
    assert.equal(ttl('news', { ELSTAND_TTL_NEWS_SECONDS: 'soon' }), 1_800);
    assert.equal(ttl('calendar', { ELSTAND_TTL_CALENDAR_SECONDS: '600' }), 600);
    assert.equal(ttl('macro-series', { ELSTAND_TTL_MACRO_SECONDS: '60' }), 900);
    assert.equal(ttl('reference-rates', { ELSTAND_TTL_RATES_SECONDS: '1e3' }), 3_600);
    assert.deepEqual([...TTL_VARIABLES].sort(), [
      'ELSTAND_TTL_CALENDAR_SECONDS',
      'ELSTAND_TTL_MACRO_SECONDS',
      'ELSTAND_TTL_NEWS_SECONDS',
      'ELSTAND_TTL_RATES_SECONDS',
    ]);
  });

  it('keeps a result for longer than it is fresh, so an outage is reported as CACHED and then STALE', () => {
    for (const dataClass of [
      'quote',
      'candles-daily',
      'calendar',
      'news',
      'macro-series',
      'reference-rates',
    ] as const) {
      const policy = policyFor({}, dataClass);
      assert.ok(policy.staleIfErrorMs > policy.ttlMs, dataClass);
      assert.ok(policy.freshWindowMs >= policy.ttlMs, dataClass);
    }
    assert.equal(policyFor({}, 'quote').freshWindowMs, STALE_AFTER_MS.delayed);
    // Slow macro data is current for a day; a quote for half an hour.
    assert.ok(policyFor({}, 'macro-series').freshWindowMs > policyFor({}, 'quote').freshWindowMs);
  });

  it('builds a shared-cache header from the lifetime, never below one second', () => {
    assert.equal(sharedCacheControl(900_000), 'public, max-age=0, s-maxage=900');
    assert.equal(sharedCacheControl(10), 'public, max-age=0, s-maxage=1');
  });
});
