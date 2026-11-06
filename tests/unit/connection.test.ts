import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConnection, type ConnectionState } from '../../src/app/connection.js';
import { ApiClientError, createApiClient, isAbortError } from '../../src/data/api-client.js';
import { ENV_API_KEY, ENV_REALTIME } from '../../server/env.js';
import {
  ENV_TWELVE_DATA_PER_DAY,
  ENV_TWELVE_DATA_PER_MINUTE,
} from '../../server/provider-registry.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';
import { createAppFetch } from '../support/app-fetch.js';
import {
  createFakeVendor,
  jsonResponse,
  quotePayload,
  timeSeriesPayload,
  vendorError,
  type FakeVendor,
} from '../support/fake-vendor.js';

const KEY = 'sk-test-key-123456';

/**
 * A plan whose request budget covers the whole watchlist in one refresh. The default budget (the
 * free Twelve Data plan: 8 credits a minute, quotes held to three quarters of that) does not, so a
 * test that needs all eight quotes at once says which plan it is simulating.
 */
const WIDE_PLAN = {
  [ENV_API_KEY]: KEY,
  [ENV_TWELVE_DATA_PER_MINUTE]: '600',
  [ENV_TWELVE_DATA_PER_DAY]: '50000',
};
const signal = new AbortController().signal;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new assert.AssertionError({ message: `timed out waiting for: ${label}` });
}

function healthyVendor(): FakeVendor {
  return createFakeVendor((call) => {
    const symbol = call.params['symbol'] ?? '';
    if (call.path === '/quote') return quotePayload(symbol);
    if (call.path === '/time_series') {
      return timeSeriesPayload(symbol, call.params['interval'] ?? '', fixtureCandles(6, 'H1'));
    }
    return undefined;
  });
}

function connectedState(state: ConnectionState): Extract<ConnectionState, { status: 'connected' }> {
  if (state.status !== 'connected')
    throw new assert.AssertionError({ message: `state is ${state.status}` });
  return state;
}

describe('api client', () => {
  const respond = (reply: () => Response | Promise<Response>): typeof fetch =>
    (async () => reply()) as typeof fetch;

  it('returns the JSON body and sends parameters in the query string', async () => {
    let seen = '';
    const client = createApiClient((async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ ok: true }, 200);
    }) as typeof fetch);
    assert.deepEqual(await client.getJson('/api/x', { a: '1', b: 'two words' }, signal), {
      ok: true,
    });
    assert.equal(seen, '/api/x?a=1&b=two+words');
  });

  async function codeOf(fetchImpl: typeof fetch): Promise<ApiClientError> {
    try {
      await createApiClient(fetchImpl).getJson('/api/x', {}, signal);
    } catch (error) {
      if (error instanceof ApiClientError) return error;
      throw error;
    }
    throw new assert.AssertionError({ message: 'expected a failure' });
  }

  it('reports a missing path as not_found, and an HTML page or bad JSON as bad_response', async () => {
    assert.equal(
      (await codeOf(respond(() => new Response('nope', { status: 404 })))).code,
      'not_found',
    );
    const html = new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    assert.equal((await codeOf(respond(() => html))).code, 'bad_response');
    const broken = new Response('{oops', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal((await codeOf(respond(() => broken))).code, 'bad_response');
  });

  it('maps the server error envelope to its code, and any other failure body to bad_response', async () => {
    const limited = await codeOf(
      respond(() => jsonResponse({ error: { code: 'rate_limited', message: 'slow down' } }, 429)),
    );
    assert.equal(limited.code, 'rate_limited');
    assert.equal(limited.message, 'slow down');
    assert.equal(limited.httpStatus, 429);
    assert.equal(
      (await codeOf(respond(() => jsonResponse({ nope: 1 }, 500)))).code,
      'bad_response',
    );
  });

  it('reports unreachable and timed-out hosts, but passes an abort through untouched', async () => {
    const down = await codeOf((async () =>
      Promise.reject(new TypeError('failed to fetch'))) as typeof fetch);
    assert.equal(down.code, 'unreachable');
    assert.match(down.message, /Cannot reach/);

    const hangs = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const slow = createApiClient(hangs, 20);
    // Node's AbortSignal.timeout timer does not keep the event loop alive, so a test that waits
    // on it must hold the loop open itself. Browsers have no such behaviour.
    const keepAlive = setTimeout(() => undefined, 2_000);
    try {
      await assert.rejects(slow.getJson('/api/x', {}, signal), (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.code, 'unreachable');
        assert.match(error.message, /did not answer in time/);
        return true;
      });
    } finally {
      clearTimeout(keepAlive);
    }

    const controller = new AbortController();
    const pending = createApiClient(hangs).getJson('/api/x', {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => isAbortError(error));
  });
});

describe('connection: not connected', () => {
  it('shows nothing but ENV NOT CONNECTION state when the server has no key', async () => {
    const vendor = healthyVendor();
    const connection = createConnection({ fetch: createAppFetch({}, vendor) });
    assert.equal(connection.state.get().status, 'checking');
    connection.check();
    await until(() => connection.state.get().status !== 'checking', 'status answer');
    const state = connection.state.get();
    assert.equal(state.status, 'not-connected');
    if (state.status === 'not-connected') {
      assert.deepEqual(state.missing, [ENV_API_KEY]);
      assert.match(state.detail, new RegExp(ENV_API_KEY));
    }
    assert.equal(vendor.calls.length, 0, 'no provider call without credentials');
  });

  it('is not connected when the host has no API at all, whether it 404s or serves a page', async () => {
    for (const reply of [
      () => new Response('missing', { status: 404 }),
      () =>
        new Response('<html>spa</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ]) {
      const connection = createConnection({ fetch: (async () => reply()) as typeof fetch });
      connection.check();
      await until(() => connection.state.get().status !== 'checking', 'status answer');
      const state = connection.state.get();
      assert.equal(state.status, 'not-connected');
      assert.match(
        state.status === 'not-connected' ? state.detail : '',
        /API is not available at \/api\/status/,
      );
    }
  });

  it('reports an unreachable API as an error that can be retried, not as ENV NOT CONNECTION', async () => {
    let up = false;
    const vendor = healthyVendor();
    const working = createAppFetch({ [ENV_API_KEY]: KEY }, vendor);
    const flaky = ((input: RequestInfo | URL, init?: RequestInit) =>
      up ? working(input, init) : Promise.reject(new TypeError('offline'))) as typeof fetch;
    const connection = createConnection({ fetch: flaky });
    connection.check();
    await until(() => connection.state.get().status !== 'checking', 'first answer');
    assert.equal(connection.state.get().status, 'error');
    up = true;
    connection.check();
    await until(() => connection.state.get().status === 'connected', 'recovery');
  });

  it('recovers when the environment is configured and the check is repeated', async () => {
    const env: Record<string, string | undefined> = {};
    const connection = createConnection({ fetch: createAppFetch(env, healthyVendor()) });
    connection.check();
    await until(() => connection.state.get().status === 'not-connected', 'not connected');
    env[ENV_API_KEY] = KEY;
    connection.check();
    await until(() => connection.state.get().status === 'connected', 'connected');
  });

  it('ignores an answer that arrives after dispose', async () => {
    const connection = createConnection({
      fetch: createAppFetch({ [ENV_API_KEY]: KEY }, healthyVendor()),
    });
    connection.check();
    connection.dispose();
    await tick();
    await tick();
    assert.equal(connection.state.get().status, 'checking');
  });
});

describe('connection: connected', () => {
  async function connect(
    env: Record<string, string | undefined>,
    vendor: FakeVendor,
  ): Promise<ReturnType<typeof createConnection>> {
    const connection = createConnection({
      fetch: createAppFetch(env, vendor),
      now: () => FIXTURE_NOW,
    });
    connection.check();
    await until(() => connection.state.get().status !== 'checking', 'status answer');
    return connection;
  }

  it('declares the source honestly: delayed unless the operator says real-time', async () => {
    const delayed = connectedState(
      (await connect({ [ENV_API_KEY]: KEY }, healthyVendor())).state.get(),
    );
    assert.equal(delayed.source.id, 'twelvedata');
    assert.equal(delayed.source.mode, 'delayed');
    assert.equal(delayed.pollSeconds.quotes, 60);
    const live = connectedState(
      (await connect({ [ENV_API_KEY]: KEY, [ENV_REALTIME]: 'true' }, healthyVendor())).state.get(),
    );
    assert.equal(live.source.mode, 'live');
  });

  it('loads validated quotes, candles and an honest depth answer through the whole chain', async () => {
    const vendor = healthyVendor();
    const { service } = connectedState((await connect(WIDE_PLAN, vendor)).state.get());

    service.loadQuotes();
    service.loadCandles('EURUSD', 'H1');
    service.loadDepth('EURUSD');
    await until(
      () =>
        service.quotes.get().status === 'ready' &&
        service.candles('EURUSD', 'H1').get().status === 'ready' &&
        service.depth('EURUSD').get().status === 'ready',
      'data loaded',
    );

    const quotes = service.quotes.get();
    assert.equal(quotes.status === 'ready' ? quotes.value.quotes.size : -1, 8);
    const eur = quotes.status === 'ready' ? quotes.value.quotes.get('EURUSD') : undefined;
    assert.equal(eur?.last, 1.1025);
    assert.equal(eur?.asOf, FIXTURE_NOW);

    const candles = service.candles('EURUSD', 'H1').get();
    assert.equal(candles.status === 'ready' ? candles.value.candles.length : -1, 6);
    const last = candles.status === 'ready' ? candles.value.candles.at(-1) : undefined;
    assert.equal(last?.time, fixtureCandles(6, 'H1').at(-1)?.time);

    const depth = service.depth('EURUSD').get();
    assert.equal(depth.status === 'ready' ? depth.value.status : null, 'unavailable');
    assert.match(
      depth.status === 'ready' && depth.value.status === 'unavailable' ? depth.value.reason : '',
      /No order-book depth adapter exists/,
    );
  });

  it('asks the provider for the interval that matches each timeframe', async () => {
    const vendor = healthyVendor();
    const { service } = connectedState((await connect({ [ENV_API_KEY]: KEY }, vendor)).state.get());
    for (const timeframe of ['M5', 'H4', 'D1'] as const) service.loadCandles('EURUSD', timeframe);
    await until(() => vendor.calls.length === 3, 'three provider calls');
    assert.deepEqual(vendor.calls.map((call) => call.params['interval']).sort(), [
      '1day',
      '4h',
      '5min',
    ]);
  });

  it('flips to ENV NOT CONNECTION when the provider rejects the key', async () => {
    const vendor = createFakeVendor(() => vendorError(401, 'invalid key'));
    const connection = await connect({ [ENV_API_KEY]: KEY }, vendor);
    const { service } = connectedState(connection.state.get());
    service.loadQuotes();
    await until(() => connection.state.get().status === 'not-connected', 'flip to not connected');
    const state = connection.state.get();
    assert.match(
      state.status === 'not-connected' ? state.detail : '',
      /rejected the configured API key/,
    );
  });

  it('stays connected and reports the reason when the provider rate-limits', async () => {
    const vendor = createFakeVendor(() =>
      jsonResponse({ code: 429, message: 'limit', status: 'error' }, 429),
    );
    const connection = await connect({ [ENV_API_KEY]: KEY }, vendor);
    const { service } = connectedState(connection.state.get());
    service.loadQuotes();
    await until(() => service.quotes.get().status === 'error', 'quotes error');
    assert.equal(connection.state.get().status, 'connected');
    const quotes = service.quotes.get();
    assert.match(quotes.status === 'error' ? quotes.message : '', /request limit was reached/);
  });

  it('keeps good quotes and attaches the reason to the instrument the provider refused', async () => {
    const vendor = createFakeVendor((call) =>
      call.params['symbol'] === 'XAU/USD'
        ? vendorError(403, 'XAU/USD is not included in your plan')
        : quotePayload(call.params['symbol'] ?? ''),
    );
    const { service } = connectedState((await connect(WIDE_PLAN, vendor)).state.get());
    service.loadQuotes();
    await until(() => service.quotes.get().status === 'ready', 'quotes');
    const quotes = service.quotes.get();
    if (quotes.status !== 'ready')
      throw new assert.AssertionError({ message: 'expected ready quotes' });
    assert.equal(quotes.value.quotes.size, 7);
    assert.match(quotes.value.rejected.get('XAUUSD') ?? '', /not included in your plan/);
  });
});
