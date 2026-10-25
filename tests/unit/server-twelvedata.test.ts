import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findInstrument } from '../../src/core/instruments.js';
import { TIMEFRAMES } from '../../src/core/types.js';
import { ApiFailure } from '../../server/errors.js';
import {
  fetchCandles,
  fetchQuote,
  parseDatetimeUtc,
  parseDecimal,
  parseQuote,
  parseTimeSeries,
  parseUnixSeconds,
  sanitizeProviderText,
  TWELVE_DATA_INTERVAL,
  type UpstreamDeps,
} from '../../server/twelvedata.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';
import {
  createFakeVendor,
  jsonResponse,
  quotePayload,
  timeSeriesPayload,
  vendorError,
} from '../support/fake-vendor.js';

const eurusd = findInstrument('EURUSD');
if (eurusd === undefined) throw new Error('EURUSD missing from the instrument list');
const KEY = 'sk-test-key-123456';
const NOW_SECONDS = FIXTURE_NOW / 1000;

function depsFor(vendor: ReturnType<typeof createFakeVendor>): UpstreamDeps {
  return { fetch: vendor.fetch, apiKey: KEY, now: () => FIXTURE_NOW };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiFailure) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: 'expected an ApiFailure' });
}

describe('twelvedata parsing primitives', () => {
  it('reads plain decimals, as strings or numbers, and nothing else', () => {
    assert.equal(parseDecimal('148.73500'), 148.735);
    assert.equal(parseDecimal('-0.5'), -0.5);
    assert.equal(parseDecimal(5), 5);
    for (const bad of [
      '',
      ' ',
      'abc',
      '1e5',
      'NaN',
      'Infinity',
      '1,5',
      '--1',
      null,
      undefined,
      {},
      Number.NaN,
    ]) {
      assert.equal(parseDecimal(bad), null, String(bad));
    }
  });

  it('reads unix seconds inside a plausible window and rejects a milliseconds value', () => {
    assert.equal(parseUnixSeconds(NOW_SECONDS, FIXTURE_NOW), FIXTURE_NOW);
    assert.equal(parseUnixSeconds(String(NOW_SECONDS), FIXTURE_NOW), FIXTURE_NOW);
    assert.equal(
      parseUnixSeconds(FIXTURE_NOW, FIXTURE_NOW),
      null,
      'milliseconds mistaken for seconds',
    );
    assert.equal(parseUnixSeconds(-5, FIXTURE_NOW), null);
    assert.equal(parseUnixSeconds(86_400, FIXTURE_NOW), null, 'before 2000');
    assert.equal(
      parseUnixSeconds(NOW_SECONDS + 2 * 86_400, FIXTURE_NOW),
      null,
      'more than a day ahead',
    );
    assert.equal(
      parseUnixSeconds(NOW_SECONDS + 3_600, FIXTURE_NOW),
      FIXTURE_NOW + 3_600_000,
      'small skew is fine',
    );
    assert.equal(parseUnixSeconds(1.5, FIXTURE_NOW), null);
    assert.equal(parseUnixSeconds(null, FIXTURE_NOW), null);
  });

  it('reads vendor datetimes as UTC and rejects calendar overflow and other formats', () => {
    assert.equal(parseDatetimeUtc('2026-01-02 21:05:00'), Date.UTC(2026, 0, 2, 21, 5, 0));
    assert.equal(parseDatetimeUtc('2026-01-02'), Date.UTC(2026, 0, 2));
    for (const bad of [
      '2026-02-31',
      '2026-01-02T21:05:00Z',
      '2026-13-01',
      '2026-01-02 25:00:00',
      'garbage',
      '',
      20260102,
      null,
    ]) {
      assert.equal(parseDatetimeUtc(bad), null, String(bad));
    }
  });

  it('removes control characters and any echo of the key from provider text', () => {
    assert.equal(
      sanitizeProviderText(`bad key ${KEY}\n\tplease`, KEY),
      'bad key [redacted] please',
    );
    assert.equal(sanitizeProviderText('x'.repeat(500), KEY).length, 240);
  });
});

describe('twelvedata quote parsing', () => {
  it('maps the documented fields and computes the change from the previous close', () => {
    const quote = parseQuote(quotePayload('EUR/USD'), eurusd, FIXTURE_NOW);
    assert.equal(quote.instrumentId, 'EURUSD');
    assert.equal(quote.last, 1.1025);
    assert.equal(quote.asOf, FIXTURE_NOW);
    assert.equal(quote.bid, null);
    assert.equal(quote.ask, null);
    assert.equal(quote.changeBasis, 'prev. close');
    assert.ok(Math.abs((quote.changeAbs ?? 0) - 0.0025) < 1e-12);
    assert.ok(Math.abs((quote.changePct ?? 0) - 0.227272727) < 1e-6);
    assert.equal(quote.marketOpen, true);
  });

  it("ignores the vendor's own change fields, whose units are not trusted", () => {
    const quote = parseQuote(
      quotePayload('EUR/USD', { change: '999', percent_change: '-12345' }),
      eurusd,
      FIXTURE_NOW,
    );
    assert.ok(Math.abs((quote.changePct ?? 0) - 0.227272727) < 1e-6);
  });

  it('has no change when there is no usable previous close', () => {
    const quote = parseQuote(
      quotePayload('EUR/USD', { previous_close: undefined }),
      eurusd,
      FIXTURE_NOW,
    );
    assert.equal(quote.changeAbs, null);
    assert.equal(quote.changePct, null);
    const zero = parseQuote(quotePayload('EUR/USD', { previous_close: '0' }), eurusd, FIXTURE_NOW);
    assert.equal(zero.changePct, null);
  });

  it('falls back to the bar timestamp, which can only look older, and refuses to guess otherwise', () => {
    const fallback = parseQuote(
      quotePayload('EUR/USD', { last_quote_at: undefined }),
      eurusd,
      FIXTURE_NOW,
    );
    assert.equal(fallback.asOf, (NOW_SECONDS - 43_200) * 1000);
    assert.throws(
      () =>
        parseQuote(
          quotePayload('EUR/USD', { last_quote_at: undefined, timestamp: undefined }),
          eurusd,
          FIXTURE_NOW,
        ),
      /no usable timestamp/,
    );
  });

  it('reports market state only when the provider states it', () => {
    const closed = parseQuote(
      quotePayload('EUR/USD', { is_market_open: false }),
      eurusd,
      FIXTURE_NOW,
    );
    assert.equal(closed.marketOpen, false);
    const silent = parseQuote(
      quotePayload('EUR/USD', { is_market_open: undefined }),
      eurusd,
      FIXTURE_NOW,
    );
    assert.equal(silent.marketOpen, null);
  });

  it('rejects an answer for another symbol, a missing price and a non-object', () => {
    assert.throws(() => parseQuote(quotePayload('GBP/USD'), eurusd, FIXTURE_NOW), /not EUR\/USD/);
    assert.throws(
      () => parseQuote(quotePayload('EUR/USD', { close: undefined }), eurusd, FIXTURE_NOW),
      /no usable price/,
    );
    assert.throws(
      () => parseQuote(quotePayload('EUR/USD', { close: '0' }), eurusd, FIXTURE_NOW),
      /no usable price/,
    );
    assert.throws(
      () => parseQuote(quotePayload('EUR/USD', { close: 'n/a' }), eurusd, FIXTURE_NOW),
      /no usable price/,
    );
    assert.throws(() => parseQuote('nope', eurusd, FIXTURE_NOW), /not an object/);
  });

  it('accepts the symbol with different punctuation, as the gold pair is written by some feeds', () => {
    const gold = findInstrument('XAUUSD');
    assert.ok(gold);
    const quote = parseQuote(
      quotePayload('XAU/USD', { close: '2650.12', previous_close: '2640.00' }),
      gold,
      FIXTURE_NOW,
    );
    assert.equal(quote.instrumentId, 'XAUUSD');
    assert.equal(parseQuote(quotePayload('xauusd'), gold, FIXTURE_NOW).instrumentId, 'XAUUSD');
  });
});

describe('twelvedata time series parsing', () => {
  const candles = fixtureCandles(3, 'H1');

  it('maps documented values to bars with UTC open times', () => {
    const bars = parseTimeSeries(timeSeriesPayload('EUR/USD', '1h', candles), eurusd, 'H1');
    assert.equal(bars.length, 3);
    assert.equal(bars[2]?.time, candles[2]?.time);
    assert.ok(Math.abs((bars[0]?.open ?? 0) - (candles[0]?.open ?? 1)) < 1e-4);
  });

  it('reads daily bars dated without a time as UTC midnight', () => {
    const daily = fixtureCandles(2, 'D1', Date.UTC(2026, 0, 6));
    const bars = parseTimeSeries(timeSeriesPayload('EUR/USD', '1day', daily), eurusd, 'D1');
    assert.equal(bars[1]?.time, Date.UTC(2026, 0, 6));
  });

  it('returns an empty list for an empty answer rather than inventing bars', () => {
    assert.deepEqual(parseTimeSeries(timeSeriesPayload('EUR/USD', '1h', []), eurusd, 'H1'), []);
  });

  it('rejects the wrong symbol, the wrong interval and any malformed bar', () => {
    assert.throws(
      () => parseTimeSeries(timeSeriesPayload('GBP/USD', '1h', candles), eurusd, 'H1'),
      /not EUR\/USD/,
    );
    assert.throws(
      () => parseTimeSeries(timeSeriesPayload('EUR/USD', '5min', candles), eurusd, 'H1'),
      /interval 5min instead of 1h/,
    );
    const broken = timeSeriesPayload('EUR/USD', '1h', candles);
    (broken['values'] as Record<string, unknown>[])[1] = {
      datetime: '2026-01-06 11:00:00',
      open: '1.1',
    };
    assert.throws(
      () => parseTimeSeries(broken, eurusd, 'H1'),
      /bar 1 has a missing or malformed field/,
    );
    assert.throws(() => parseTimeSeries({ values: [] }, eurusd, 'H1'), /no meta or values/);
    assert.throws(() => parseTimeSeries(null, eurusd, 'H1'), /no meta or values/);
  });
});

describe('twelvedata requests', () => {
  it('asks /quote for one symbol and sends the key in a header, never in the URL', async () => {
    const vendor = createFakeVendor(() => quotePayload('EUR/USD'));
    const quote = await fetchQuote(depsFor(vendor), eurusd);
    assert.equal(quote.last, 1.1025);
    assert.equal(vendor.calls.length, 1);
    const call = vendor.calls[0];
    assert.equal(call?.path, '/quote');
    assert.equal(call?.params['symbol'], 'EUR/USD');
    assert.equal(call?.authorization, `apikey ${KEY}`);
    assert.equal(call?.redirect, 'error', 'a redirect could forward the key to another host');
    assert.ok(!call?.url.includes(KEY), 'the key must not appear in the URL');
    assert.ok(!('apikey' in (call?.params ?? {})));
  });

  it('maps every timeframe to the documented interval and asks for ascending UTC bars', async () => {
    assert.deepEqual(
      TIMEFRAMES.map((timeframe) => TWELVE_DATA_INTERVAL[timeframe]),
      ['5min', '15min', '30min', '1h', '4h', '1day'],
    );
    for (const timeframe of TIMEFRAMES) {
      const vendor = createFakeVendor((call) =>
        timeSeriesPayload('EUR/USD', call.params['interval'] ?? '', fixtureCandles(4, timeframe)),
      );
      const bars = await fetchCandles(depsFor(vendor), eurusd, timeframe, 123);
      assert.equal(bars.length, 4);
      const call = vendor.calls[0];
      assert.equal(call?.path, '/time_series');
      assert.equal(call?.params['symbol'], 'EUR/USD');
      assert.equal(call?.params['interval'], TWELVE_DATA_INTERVAL[timeframe]);
      assert.equal(call?.params['outputsize'], '123');
      assert.equal(call?.params['order'], 'asc');
      assert.equal(call?.params['timezone'], 'UTC');
    }
  });
});

describe('twelvedata error mapping', () => {
  it('maps 401 to a rejected key', async () => {
    const vendor = createFakeVendor(() => vendorError(401, `**apikey** ${KEY} is invalid`));
    const failure = await failureOf(fetchQuote(depsFor(vendor), eurusd));
    assert.equal(failure.code, 'provider_auth');
    assert.ok(!failure.message.includes(KEY), 'the key must never be echoed');
    assert.match(failure.message, /\[redacted\]/);
  });

  it('maps 403 to a provider error about the request, not to a rejected key', async () => {
    const vendor = createFakeVendor(() =>
      vendorError(403, 'This symbol is not included in your plan'),
    );
    const failure = await failureOf(fetchQuote(depsFor(vendor), eurusd));
    assert.equal(failure.code, 'provider_error');
    assert.match(failure.message, /not included in your plan/);
  });

  it('maps 429, in the body or as the HTTP status, to a rate limit and keeps Retry-After', async () => {
    const inBody = createFakeVendor(() =>
      jsonResponse({ code: 429, message: 'limit', status: 'error' }, 200),
    );
    assert.equal((await failureOf(fetchQuote(depsFor(inBody), eurusd))).code, 'rate_limited');

    const header = createFakeVendor(() =>
      jsonResponse({ code: 429, message: 'limit', status: 'error' }, 429, { 'Retry-After': '17' }),
    );
    const failure = await failureOf(fetchQuote(depsFor(header), eurusd));
    assert.equal(failure.code, 'rate_limited');
    assert.equal(failure.retryAfterSeconds, 17);
  });

  it('maps 400, 404 and 5xx to provider errors, and unusable bodies to provider errors', async () => {
    for (const status of [400, 404, 500, 503]) {
      const vendor = createFakeVendor(() => vendorError(status, 'nope'));
      assert.equal(
        (await failureOf(fetchQuote(depsFor(vendor), eurusd))).code,
        'provider_error',
        String(status),
      );
    }
    const html = createFakeVendor(() => new Response('<html>gateway</html>', { status: 502 }));
    assert.equal((await failureOf(fetchQuote(depsFor(html), eurusd))).code, 'provider_error');
    const wrongShape = createFakeVendor(() => ({ unexpected: true }));
    assert.equal((await failureOf(fetchQuote(depsFor(wrongShape), eurusd))).code, 'provider_error');
  });

  it('maps a network failure to unreachable without leaking its details', async () => {
    const deps: UpstreamDeps = {
      fetch: (() => Promise.reject(new TypeError(`connect ECONNREFUSED ${KEY}`))) as typeof fetch,
      apiKey: KEY,
      now: () => FIXTURE_NOW,
    };
    const failure = await failureOf(fetchQuote(deps, eurusd));
    assert.equal(failure.code, 'provider_unreachable');
    assert.ok(!failure.message.includes(KEY));
  });
});
