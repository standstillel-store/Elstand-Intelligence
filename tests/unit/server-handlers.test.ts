import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSTRUMENTS } from '../../src/core/instruments.js';
import { DEFAULT_CANDLE_LIMIT } from '../../src/data/provider.js';
import { TIMEFRAMES } from '../../src/core/types.js';
import { parseCandles, parseError, parseQuotes, parseStatus } from '../../src/data/wire.js';
import { createTtlCache } from '../../server/cache.js';
import {
  DEFAULT_REFRESH_SECONDS,
  ENV_API_KEY,
  ENV_REALTIME,
  ENV_REFRESH,
  MAX_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  STALE_AFTER_MS,
  readServerConfig,
} from '../../server/env.js';
import { ApiFailure } from '../../server/errors.js';
import {
  DEPTH_UNAVAILABLE_REASON,
  handleCandles,
  handleQuotes,
  handleStatus,
  representativeCause,
  type HandlerDeps,
} from '../../server/handlers.js';
import {
  ENV_TWELVE_DATA_PER_DAY,
  ENV_TWELVE_DATA_PER_MINUTE,
} from '../../server/provider-registry.js';
import { parseQuotesProvenance } from '../../src/data/wire-providers.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';
import {
  createFakeVendor,
  jsonResponse,
  quotePayload,
  timeSeriesPayload,
  vendorError,
  type FakeVendor,
  type VendorCall,
} from '../support/fake-vendor.js';

const KEY = 'sk-test-key-123456';
const CONNECTED_ENV = { [ENV_API_KEY]: KEY };

/**
 * A plan whose request budget covers the whole watchlist in one refresh. The default budget (the
 * free Twelve Data plan: 8 credits a minute, 800 a day, quotes held to three quarters of that)
 * does not; the tests of that case use `CONNECTED_ENV` and say so.
 */
const WIDE_PLAN_ENV = {
  ...CONNECTED_ENV,
  [ENV_TWELVE_DATA_PER_MINUTE]: '600',
  [ENV_TWELVE_DATA_PER_DAY]: '50000',
};

function symbolOf(call: VendorCall): string {
  return call.params['symbol'] ?? '';
}

/** A vendor that answers every quote and series request with valid documented payloads. */
function healthyVendor(): FakeVendor {
  return createFakeVendor((call) => {
    if (call.path === '/quote') return quotePayload(symbolOf(call));
    if (call.path === '/time_series') {
      const timeframe = TIMEFRAMES.find(
        (tf) =>
          call.params['interval'] ===
          (tf === 'D1'
            ? '1day'
            : tf === 'H4'
              ? '4h'
              : tf === 'H1'
                ? '1h'
                : tf === 'M30'
                  ? '30min'
                  : tf === 'M15'
                    ? '15min'
                    : '5min'),
      );
      return timeSeriesPayload(
        symbolOf(call),
        call.params['interval'] ?? '',
        fixtureCandles(5, timeframe ?? 'H1'),
      );
    }
    return undefined;
  });
}

function depsFor(
  vendor: FakeVendor,
  env: Record<string, string | undefined> = CONNECTED_ENV,
): HandlerDeps {
  return { env, fetch: vendor.fetch, now: () => FIXTURE_NOW, cache: createTtlCache() };
}

const get = (path: string): Request => new Request(`http://elstand.test${path}`);

async function bodyOf(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('server environment', () => {
  it('is not connected without a key, and lists only the variable NAME', () => {
    for (const env of [{}, { [ENV_API_KEY]: '' }, { [ENV_API_KEY]: '   ' }]) {
      assert.deepEqual(readServerConfig(env), { connected: false, missing: [ENV_API_KEY] });
    }
  });

  it('labels the feed delayed unless the operator declares it real-time', () => {
    const delayed = readServerConfig(CONNECTED_ENV);
    assert.ok(delayed.connected);
    assert.equal(delayed.connected && delayed.config.mode, 'delayed');
    assert.equal(delayed.connected && delayed.config.staleAfterMs, STALE_AFTER_MS.delayed);
    for (const value of ['true', ' TRUE ', 'True']) {
      const live = readServerConfig({ ...CONNECTED_ENV, [ENV_REALTIME]: value });
      assert.equal(live.connected && live.config.mode, 'live');
    }
    for (const value of ['false', '1', 'yes', '']) {
      const other = readServerConfig({ ...CONNECTED_ENV, [ENV_REALTIME]: value });
      assert.equal(other.connected && other.config.mode, 'delayed', value);
    }
  });

  it('reads the refresh cadence with a default and clamps it', () => {
    const seconds = (value: string | undefined): number | null => {
      const reading = readServerConfig({ ...CONNECTED_ENV, [ENV_REFRESH]: value });
      return reading.connected ? reading.config.refreshSeconds : null;
    };
    assert.equal(seconds(undefined), 60);
    assert.equal(seconds('abc'), 60);
    assert.equal(seconds('1.5'), 60);
    assert.equal(seconds('30'), 30);
    assert.equal(seconds(' 45 '), 45);
    assert.equal(seconds('1'), MIN_REFRESH_SECONDS);
    assert.equal(seconds('0'), MIN_REFRESH_SECONDS);
    assert.equal(seconds('999999'), MAX_REFRESH_SECONDS);
    assert.equal(seconds('99999999999999999999'), MAX_REFRESH_SECONDS);
  });

  it('treats a blank or oddly written refresh value as a misconfiguration, not as a number', () => {
    const seconds = (value: string): number | null => {
      const reading = readServerConfig({ ...CONNECTED_ENV, [ENV_REFRESH]: value });
      return reading.connected ? reading.config.refreshSeconds : null;
    };
    // `Number('')` is 0 and `Number('1e2')` is 100: a blank line in .env.local must not turn
    // into a 10-second poll against a metered provider.
    for (const value of ['', '   ', '-5', '1e2', '0x10', '+30', '3 0', '٣٠']) {
      assert.equal(seconds(value), DEFAULT_REFRESH_SECONDS, JSON.stringify(value));
    }
  });
});

describe('GET /api/status', () => {
  it('says ENV is not connected, with names only, and never calls the provider', async () => {
    const vendor = healthyVendor();
    const response = await handleStatus(get('/api/status'), depsFor(vendor, {}));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const parsed = parseStatus(await bodyOf(response));
    assert.deepEqual(parsed, { ok: true, value: { connected: false, missing: [ENV_API_KEY] } });
    assert.equal(vendor.calls.length, 0);
  });

  it('declares the source, mode, staleness, cadence and why depth is absent, without the key', async () => {
    const vendor = healthyVendor();
    const response = await handleStatus(get('/api/status'), depsFor(vendor));
    const text = await response.text();
    assert.ok(!text.includes(KEY));
    const parsed = parseStatus(JSON.parse(text));
    assert.ok(parsed.ok);
    if (parsed.ok && parsed.value.connected) {
      assert.equal(parsed.value.source.id, 'twelvedata');
      assert.equal(parsed.value.source.mode, 'delayed');
      assert.equal(parsed.value.source.staleAfterMs, STALE_AFTER_MS.delayed);
      assert.equal(parsed.value.pollSeconds.quotes, 60);
      assert.equal(parsed.value.depth.reason, DEPTH_UNAVAILABLE_REASON);
    }
    assert.equal(vendor.calls.length, 0, 'status never spends provider credits');
  });

  it('rejects anything but GET', async () => {
    const response = await handleStatus(
      new Request('http://elstand.test/api/status', { method: 'POST' }),
      depsFor(healthyVendor()),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET');
  });
});

describe('GET /api/quotes', () => {
  const allIds = INSTRUMENTS.map((instrument) => instrument.id).join(',');

  it('returns not_connected (503) when the server has no key', async () => {
    const vendor = healthyVendor();
    const response = await handleQuotes(get(`/api/quotes?ids=${allIds}`), depsFor(vendor, {}));
    assert.equal(response.status, 503);
    const parsed = parseError(await bodyOf(response));
    assert.ok(parsed.ok);
    assert.equal(parsed.ok && parsed.value.error.code, 'not_connected');
    assert.equal(vendor.calls.length, 0);
  });

  it('serves validated quotes for every requested instrument and allows shared caching', async () => {
    const vendor = healthyVendor();
    const response = await handleQuotes(
      get(`/api/quotes?ids=${allIds}`),
      depsFor(vendor, WIDE_PLAN_ENV),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=60');
    const parsed = parseQuotes(await bodyOf(response));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepEqual(
        parsed.value.quotes.map((quote) => quote.instrumentId).sort(),
        INSTRUMENTS.map((i) => i.id).sort(),
      );
      assert.deepEqual(parsed.value.failures, {});
    }
    assert.equal(vendor.calls.length, 8, 'one provider call per instrument');
  });

  it('reuses results within the refresh window and coalesces concurrent requests', async () => {
    const vendor = healthyVendor();
    const deps = depsFor(vendor);
    await Promise.all([
      handleQuotes(get('/api/quotes?ids=EURUSD'), deps),
      handleQuotes(get('/api/quotes?ids=EURUSD'), deps),
    ]);
    assert.equal(vendor.calls.length, 1, 'two concurrent requests share one provider call');
    await handleQuotes(get('/api/quotes?ids=EURUSD'), deps);
    assert.equal(vendor.calls.length, 1, 'a later request inside the window is served from memory');
    await handleQuotes(get('/api/quotes?ids=EURUSD'), { ...deps, now: () => FIXTURE_NOW + 61_000 });
    assert.equal(vendor.calls.length, 2, 'after the window the provider is asked again');
  });

  it('keeps good quotes when one instrument fails, and names the reason', async () => {
    const vendor = createFakeVendor((call) =>
      symbolOf(call) === 'GBP/USD' ? vendorError(403, 'not in plan') : quotePayload(symbolOf(call)),
    );
    const response = await handleQuotes(get('/api/quotes?ids=EURUSD,GBPUSD'), depsFor(vendor));
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('Cache-Control'),
      'no-store',
      'partial results are not shared',
    );
    const parsed = parseQuotes(await bodyOf(response));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepEqual(
        parsed.value.quotes.map((quote) => quote.instrumentId),
        ['EURUSD'],
      );
      assert.equal(parsed.value.failures['GBPUSD']?.code, 'provider_error');
      assert.match(parsed.value.failures['GBPUSD']?.message ?? '', /not in plan/);
    }
  });

  it('reports a rejected key as the response when every request failed that way', async () => {
    const vendor = createFakeVendor(() => vendorError(401, 'invalid key'));
    const response = await handleQuotes(
      get(`/api/quotes?ids=${allIds}`),
      depsFor(vendor, WIDE_PLAN_ENV),
    );
    assert.equal(response.status, 502);
    const parsed = parseError(await bodyOf(response));
    assert.equal(parsed.ok && parsed.value.error.code, 'provider_auth');
    assert.equal(vendor.calls.length, 8, 'every instrument was asked');
  });

  it('still reports a rejected key when part of the batch was held back by the request budget', async () => {
    // The default budget lets six of the eight requests out. Those six are refused for the key;
    // the other two never reach the provider and say nothing about it, so they must not hide it.
    const vendor = createFakeVendor(() => vendorError(401, 'invalid key'));
    const response = await handleQuotes(get(`/api/quotes?ids=${allIds}`), depsFor(vendor));
    assert.equal(vendor.calls.length, 6, 'the budget held two requests back');
    assert.equal(response.status, 502);
    const parsed = parseError(await bodyOf(response));
    assert.equal(parsed.ok && parsed.value.error.code, 'provider_auth');
  });

  it('reports a rate limit as 429 when every request hit it, and remembers it briefly', async () => {
    const vendor = createFakeVendor(() =>
      jsonResponse({ code: 429, message: 'limit', status: 'error' }, 429, { 'Retry-After': '9' }),
    );
    const deps = depsFor(vendor);
    const response = await handleQuotes(get('/api/quotes?ids=EURUSD,GBPUSD'), deps);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '9');
    const before = vendor.calls.length;
    const again = await handleQuotes(get('/api/quotes?ids=EURUSD,GBPUSD'), {
      ...deps,
      now: () => FIXTURE_NOW + 5_000,
    });
    assert.equal(again.status, 429);
    assert.equal(vendor.calls.length, before, 'a rate-limited provider is not hammered');
    await handleQuotes(get('/api/quotes?ids=EURUSD,GBPUSD'), {
      ...deps,
      now: () => FIXTURE_NOW + 20_000,
    });
    assert.ok(vendor.calls.length > before, 'asks again once the pause has passed');
  });

  it('turns a quote that fails validation into a failure instead of passing it on', async () => {
    const vendor = createFakeVendor((call) => quotePayload(symbolOf(call), { close: '-1' }));
    const response = await handleQuotes(get('/api/quotes?ids=EURUSD'), depsFor(vendor));
    assert.equal(response.status, 502);
    const parsed = parseError(await bodyOf(response));
    assert.equal(parsed.ok && parsed.value.error.code, 'provider_error');
  });

  it('rejects missing, empty and unknown ids and non-GET methods', async () => {
    const deps = depsFor(healthyVendor());
    for (const path of [
      '/api/quotes',
      '/api/quotes?ids=',
      '/api/quotes?ids=EURUSD,NOPE',
      '/api/quotes?ids=,,',
    ]) {
      const response = await handleQuotes(get(path), deps);
      assert.equal(response.status, 400, path);
    }
    const post = await handleQuotes(
      new Request('http://elstand.test/api/quotes?ids=EURUSD', { method: 'POST' }),
      deps,
    );
    assert.equal(post.status, 405);
  });

  it('accepts display symbols as well as ids and ignores duplicates', async () => {
    const vendor = healthyVendor();
    const response = await handleQuotes(
      get('/api/quotes?ids=EUR/USD,eurusd,EURUSD'),
      depsFor(vendor),
    );
    assert.equal(response.status, 200);
    assert.equal(vendor.calls.length, 1);
  });
});

describe('GET /api/quotes under the default request budget', () => {
  // The free Twelve Data plan allows 8 credits a minute and one quote costs one credit. Elstand
  // keeps a quarter of that for chart requests, so six quotes a minute can be asked for.
  const allIds = INSTRUMENTS.map((instrument) => instrument.id).join(',');

  it('asks only as many instruments as the quote share allows and labels the rest honestly', async () => {
    const vendor = healthyVendor();
    const response = await handleQuotes(get(`/api/quotes?ids=${allIds}`), depsFor(vendor));
    assert.equal(vendor.calls.length, 6, 'three quarters of 8 credits a minute');
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('Cache-Control'),
      'no-store',
      'a partial answer is not shared',
    );
    const body = await bodyOf(response);
    const parsed = parseQuotes(body);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.value.quotes.length, 6);
    const held = Object.entries(parsed.value.failures);
    assert.equal(held.length, 2);

    const provenance = parseQuotesProvenance(body);
    for (const [id, failure] of held) {
      assert.equal(failure.code, 'rate_limited');
      const entry = provenance[id];
      assert.equal(entry?.state, 'RATE LIMITED');
      assert.match(entry?.message ?? '', /request budget kept for Twelve Data is spent/);
      assert.doesNotMatch(
        entry?.message ?? '',
        /rejected the request/,
        'Elstand held the request back; the provider rejected nothing',
      );
    }
    for (const quote of parsed.value.quotes) {
      assert.equal(provenance[quote.instrumentId]?.state, 'DELAYED');
    }
  });

  it('turns the order with the refresh interval so no instrument is starved', async () => {
    const heldAt = async (timeMs: number): Promise<string[]> => {
      const vendor = healthyVendor();
      const response = await handleQuotes(get(`/api/quotes?ids=${allIds}`), {
        ...depsFor(vendor),
        now: () => timeMs,
      });
      const parsed = parseQuotes(await bodyOf(response));
      assert.ok(parsed.ok);
      return parsed.ok ? Object.keys(parsed.value.failures).sort() : [];
    };
    const first = await heldAt(FIXTURE_NOW);
    const next = await heldAt(FIXTURE_NOW + 60_000);
    assert.equal(first.length, 2);
    assert.equal(next.length, 2);
    assert.notDeepEqual(first, next, 'the same two instruments are not held back every time');
  });

  it('serves the last verified quote, labelled, for an instrument the budget holds back', async () => {
    const vendor = healthyVendor();
    const deps = depsFor(vendor);
    await handleQuotes(get(`/api/quotes?ids=${allIds}`), deps);
    const later = FIXTURE_NOW + 61_000;
    const response = await handleQuotes(get(`/api/quotes?ids=${allIds}`), {
      ...deps,
      now: () => later,
    });
    const body = await bodyOf(response);
    const parsed = parseQuotes(body);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const provenance = parseQuotesProvenance(body);
    const cached = parsed.value.quotes.filter(
      (quote) => provenance[quote.instrumentId]?.state === 'CACHED',
    );
    assert.ok(cached.length >= 1, 'a quote from the first answer stands in for a held request');
    for (const quote of cached) {
      const entry = provenance[quote.instrumentId];
      assert.equal(entry?.cache, 'stale-if-error');
      assert.match(entry?.message ?? '', /^RATE LIMITED — /);
      assert.match(entry?.message ?? '', /Last verified data: /);
      assert.match(entry?.message ?? '', /request budget kept for Twelve Data is spent/);
    }
  });
});

describe('representativeCause', () => {
  const rejected = new ApiFailure('provider_auth', 'The provider rejected the key.');
  const limited = (local: boolean): ApiFailure =>
    new ApiFailure('rate_limited', 'Over the limit.', 5, { local });
  const broken = new ApiFailure('provider_error', 'No data for this symbol.');

  it('reports a rejected key whatever else happened', () => {
    assert.equal(representativeCause([limited(true), broken, rejected, limited(false)]), rejected);
  });

  it('prefers what the provider answered over a refusal that never reached it', () => {
    assert.equal(representativeCause([limited(true), broken, limited(true)]), broken);
    const providerLimit = limited(false);
    assert.equal(representativeCause([limited(true), providerLimit]), providerLimit);
  });

  it('keeps a single shared cause as it is, local or not', () => {
    const [first, second] = [limited(true), limited(true)];
    assert.equal(representativeCause([first, second]), first);
    assert.equal(representativeCause([broken, broken]), broken);
  });

  it('reports a provider error when the answered requests failed in different ways', () => {
    const cause = representativeCause([broken, limited(false)]);
    assert.equal(cause?.code, 'provider_error');
    assert.equal(cause?.message, broken.message);
  });

  it('has no cause when nothing failed', () => {
    assert.equal(representativeCause([]), undefined);
  });
});

describe('GET /api/candles', () => {
  it('returns not_connected (503) without a key', async () => {
    const response = await handleCandles(
      get('/api/candles?id=EURUSD&tf=H1'),
      depsFor(healthyVendor(), {}),
    );
    assert.equal(response.status, 503);
  });

  it('serves bars as [time, open, high, low, close] with the documented interval for each timeframe', async () => {
    for (const timeframe of TIMEFRAMES) {
      const vendor = healthyVendor();
      const response = await handleCandles(
        get(`/api/candles?id=EURUSD&tf=${timeframe}`),
        depsFor(vendor),
      );
      assert.equal(response.status, 200, timeframe);
      const parsed = parseCandles(await bodyOf(response));
      assert.ok(parsed.ok, timeframe);
      if (parsed.ok) {
        assert.equal(parsed.value.timeframe, timeframe);
        assert.equal(parsed.value.instrumentId, 'EURUSD');
        assert.equal(parsed.value.candles.length, 5);
        assert.equal(parsed.value.candles[0]?.length, 5);
      }
      assert.equal(vendor.calls[0]?.params['outputsize'], String(DEFAULT_CANDLE_LIMIT[timeframe]));
    }
  });

  it('never returns bars that fail validation', async () => {
    const vendor = createFakeVendor((call) => {
      const payload = timeSeriesPayload(symbolOf(call), '1h', fixtureCandles(3, 'H1'));
      (payload['values'] as Record<string, string>[])[1] = {
        datetime: '2026-01-06 11:00:00',
        open: '10',
        high: '9',
        low: '8',
        close: '10',
      };
      return payload;
    });
    const response = await handleCandles(get('/api/candles?id=EURUSD&tf=H1'), depsFor(vendor));
    assert.equal(response.status, 502);
    const parsed = parseError(await bodyOf(response));
    assert.match(parsed.ok ? parsed.value.error.message : '', /invalid candles/);
  });

  it('maps provider failures to the documented codes and reuses a good answer within the window', async () => {
    const limited = createFakeVendor(() => vendorError(429, 'limit'));
    const response = await handleCandles(get('/api/candles?id=EURUSD&tf=M5'), depsFor(limited));
    assert.equal(response.status, 429);

    const vendor = healthyVendor();
    const deps = depsFor(vendor);
    await handleCandles(get('/api/candles?id=EURUSD&tf=H1'), deps);
    await handleCandles(get('/api/candles?id=EURUSD&tf=H1'), deps);
    assert.equal(vendor.calls.length, 1);
    await handleCandles(get('/api/candles?id=EURUSD&tf=H4'), deps);
    assert.equal(vendor.calls.length, 2, 'another timeframe is a different request');
  });

  it('rejects an unknown instrument or timeframe', async () => {
    const deps = depsFor(healthyVendor());
    for (const path of [
      '/api/candles',
      '/api/candles?id=NOPE&tf=H1',
      '/api/candles?id=EURUSD',
      '/api/candles?id=EURUSD&tf=h1',
      '/api/candles?id=EURUSD&tf=W1',
    ]) {
      assert.equal((await handleCandles(get(path), deps)).status, 400, path);
    }
  });
});

describe('secrets', () => {
  it('never appear in any response, even when the provider echoes the key back', async () => {
    const echo = createFakeVendor(() => vendorError(400, `bad request for key ${KEY}`));
    const deps = depsFor(echo);
    for (const response of [
      await handleQuotes(get('/api/quotes?ids=EURUSD'), deps),
      await handleCandles(get('/api/candles?id=EURUSD&tf=H1'), deps),
      await handleStatus(get('/api/status'), deps),
    ]) {
      const text = await response.text();
      assert.ok(!text.includes(KEY), text);
      assert.ok(!JSON.stringify([...response.headers]).includes(KEY));
    }
  });
});
