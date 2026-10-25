import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Candle } from '../../src/core/types.js';
import {
  normalizeDepthResult,
  spreadOf,
  validateDepthSnapshot,
  withCumulative,
  type DepthSnapshot,
} from '../../src/data/depth.js';
import { createUnconfiguredMacroFeed, NO_MACRO_FEED_REASON } from '../../src/data/macro.js';
import {
  createUnconfiguredSurfaceProvider,
  NO_OPTIONS_PROVIDER_REASON,
  validateVolSurface,
  volRange,
  type VolSurface,
} from '../../src/data/options.js';
import type { Quote } from '../../src/data/provider.js';
import { createMarketDataService, normalizeQuotes } from '../../src/data/service.js';
import { validateCandles, validateQuote } from '../../src/data/validate.js';
import { fixtureProvider, fixtureQuote, fixtureSurface } from '../support/fixtures.js';

const signal = new AbortController().signal;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('validation', () => {
  const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({
    time,
    open,
    high,
    low,
    close,
  });

  it('accepts a well-formed series', () => {
    assert.deepEqual(validateCandles([bar(1, 10, 12, 9, 11), bar(2, 11, 11, 11, 11)]), []);
  });

  it('rejects bounds violations, bad prices and ordering problems', () => {
    assert.match(validateCandles([bar(1, 10, 10.5, 9, 11)]).join(), /high\/low/);
    assert.match(validateCandles([bar(1, 10, 12, 10.5, 11)]).join(), /high\/low/);
    assert.match(validateCandles([bar(1, 10, 12, 9, 0)]).join(), /non-positive/);
    assert.match(
      validateCandles([bar(1, 10, 12, 9, Number.NaN)]).join(),
      /non-positive|non-finite/,
    );
    assert.match(validateCandles([bar(Number.NaN, 10, 12, 9, 11)]).join(), /invalid time/);
    assert.match(
      validateCandles([bar(2, 10, 12, 9, 11), bar(1, 10, 12, 9, 11)]).join(),
      /out of order/,
    );
    assert.match(
      validateCandles([bar(1, 10, 12, 9, 11), bar(1, 10, 12, 9, 11)]).join(),
      /duplicated/,
    );
  });

  it('stops reporting after five problems', () => {
    const bad = Array.from({ length: 20 }, (_, index) => bar(index + 1, 10, 9, 9, 10));
    assert.ok(validateCandles(bad).length <= 5);
  });

  it('validates quotes', () => {
    const quote = (overrides: Partial<Quote> = {}): Quote => fixtureQuote('EURUSD', overrides);
    assert.deepEqual(validateQuote(quote()), []);
    assert.deepEqual(validateQuote(quote({ bid: 1.0999, ask: 1.1001 })), []);
    assert.match(validateQuote(quote({ last: 0 })).join(), /last price/);
    assert.match(validateQuote(quote({ bid: 1.1 })).join(), /one side/);
    assert.match(validateQuote(quote({ bid: 1.2, ask: 1.1 })).join(), /bid is above ask/);
    assert.match(validateQuote(quote({ changePct: Number.NaN })).join(), /change percent/);
    assert.match(validateQuote(quote({ asOf: Number.NaN })).join(), /timestamp/);
  });
});

describe('depth', () => {
  const snapshot = (overrides: Partial<DepthSnapshot> = {}): DepthSnapshot => ({
    instrumentId: 'EURUSD',
    venue: 'Venue A',
    asOf: 1,
    sizeUnit: 'lots',
    bids: [
      { price: 1.0999, size: 2 },
      { price: 1.0998, size: 3 },
    ],
    asks: [
      { price: 1.1001, size: 1 },
      { price: 1.1002, size: 4 },
    ],
    ...overrides,
  });

  it('accepts a valid book, including a locked one', () => {
    assert.deepEqual(validateDepthSnapshot(snapshot()), []);
    assert.deepEqual(
      validateDepthSnapshot(
        snapshot({ bids: [{ price: 1.1, size: 1 }], asks: [{ price: 1.1, size: 1 }] }),
      ),
      [],
    );
  });

  it('rejects crossed, unsorted, empty and malformed books', () => {
    assert.match(
      validateDepthSnapshot(snapshot({ bids: [{ price: 1.2, size: 1 }] })).join(),
      /crossed/,
    );
    assert.match(
      validateDepthSnapshot(
        snapshot({
          bids: [
            { price: 1.0998, size: 1 },
            { price: 1.0999, size: 1 },
          ],
        }),
      ).join(),
      /not strictly ordered/,
    );
    assert.match(
      validateDepthSnapshot(
        snapshot({
          asks: [
            { price: 1.1002, size: 1 },
            { price: 1.1001, size: 1 },
          ],
        }),
      ).join(),
      /not strictly ordered/,
    );
    assert.match(
      validateDepthSnapshot(
        snapshot({
          asks: [
            { price: 1.1001, size: 1 },
            { price: 1.1001, size: 1 },
          ],
        }),
      ).join(),
      /not strictly ordered/,
    );
    assert.match(validateDepthSnapshot(snapshot({ asks: [] })).join(), /one-sided/);
    assert.match(
      validateDepthSnapshot(snapshot({ bids: [{ price: 1.0999, size: 0 }] })).join(),
      /invalid size/,
    );
    assert.match(
      validateDepthSnapshot(snapshot({ bids: [{ price: -1, size: 1 }] })).join(),
      /invalid price/,
    );
    assert.match(validateDepthSnapshot(snapshot({ venue: '  ' })).join(), /venue/);
    assert.match(validateDepthSnapshot(snapshot({ sizeUnit: '' })).join(), /size unit/);
    assert.match(validateDepthSnapshot(snapshot({ asOf: Number.NaN })).join(), /timestamp/);
  });

  it('turns an invalid or mismatched provider book into unavailable, and passes the rest through', () => {
    const valid = { status: 'available', snapshot: snapshot() } as const;
    assert.equal(normalizeDepthResult(valid, 'EURUSD'), valid);

    const crossed = normalizeDepthResult(
      { status: 'available', snapshot: snapshot({ bids: [{ price: 2, size: 1 }] }) },
      'EURUSD',
    );
    assert.equal(crossed.status, 'unavailable');
    assert.match(
      crossed.status === 'unavailable' ? crossed.reason : '',
      /invalid order book.*crossed/,
    );

    const wrong = normalizeDepthResult(valid, 'GBPUSD');
    assert.equal(wrong.status, 'unavailable');
    assert.match(wrong.status === 'unavailable' ? wrong.reason : '', /EURUSD, not GBPUSD/);

    const unavailable = { status: 'unavailable', reason: 'nope' } as const;
    assert.equal(normalizeDepthResult(unavailable, 'EURUSD'), unavailable);
  });

  it('computes cumulative size and spread', () => {
    const book = snapshot();
    assert.deepEqual(
      withCumulative(book.bids).map((l) => l.cumulative),
      [2, 5],
    );
    assert.deepEqual(
      withCumulative(book.asks).map((l) => l.cumulative),
      [1, 5],
    );
    assert.ok(Math.abs((spreadOf(book) ?? 0) - 0.0002) < 1e-12);
    assert.equal(spreadOf(snapshot({ asks: [] })), null);
  });
});

describe('market data service', () => {
  it('drops invalid quotes individually and ignores unrequested ones', () => {
    const good = fixtureQuote('EURUSD');
    const book = normalizeQuotes(
      {
        quotes: [
          good,
          { ...good, instrumentId: 'GBPUSD', last: -1 },
          { ...good, instrumentId: 'USDJPY' },
        ],
        failures: new Map([
          ['AUDUSD', 'rate limited'],
          ['NZDUSD', 'not requested'],
        ]),
      },
      ['EURUSD', 'GBPUSD', 'AUDUSD'],
    );
    assert.deepEqual([...book.quotes.keys()], ['EURUSD']);
    assert.match(book.rejected.get('GBPUSD') ?? '', /last price/);
    assert.equal(
      book.rejected.get('AUDUSD'),
      'rate limited',
      'provider failures keep their reason',
    );
    assert.equal(book.rejected.has('NZDUSD'), false);
    assert.equal(book.quotes.has('USDJPY'), false);
  });

  it('serves validated candles, quotes and depth through the keyed stores', async () => {
    const service = createMarketDataService(fixtureProvider());
    service.loadCandles('EURUSD', 'H1');
    await tick();
    const state = service.candles('EURUSD', 'H1').get();
    assert.equal(state.status, 'ready');
    if (state.status === 'ready') assert.equal(state.value.candles.length, 50);
    assert.equal(service.candles('EURUSD', 'M5').get().status, 'idle', 'other keys are untouched');

    service.loadQuotes();
    service.loadDepth('XAUUSD');
    await tick();
    const quotes = service.quotes.get();
    assert.equal(quotes.status === 'ready' ? quotes.value.quotes.size : -1, 8);
    const depth = service.depth('XAUUSD').get();
    assert.equal(depth.status === 'ready' ? depth.value.status : null, 'unavailable');
  });

  it('turns a wrong-instrument or invalid series into an error state, never into chart data', async () => {
    const wrongInstrument = createMarketDataService(
      fixtureProvider({
        getCandles: async (request) => ({
          instrumentId: 'GBPUSD',
          timeframe: request.timeframe,
          candles: [],
        }),
      }),
    );
    wrongInstrument.loadCandles('EURUSD', 'H1');
    await tick();
    const wrong = wrongInstrument.candles('EURUSD', 'H1').get();
    assert.equal(wrong.status, 'error');
    assert.match(wrong.status === 'error' ? wrong.message : '', /GBPUSD H1 instead of EURUSD H1/);

    const invalid = createMarketDataService(
      fixtureProvider({
        getCandles: async (request) => ({
          instrumentId: request.instrumentId,
          timeframe: request.timeframe,
          candles: [{ time: 1, open: 10, high: 9, low: 8, close: 10 }],
        }),
      }),
    );
    invalid.loadCandles('EURUSD', 'H1');
    await tick();
    const state = invalid.candles('EURUSD', 'H1').get();
    assert.equal(state.status, 'error');
    assert.match(state.status === 'error' ? state.message : '', /invalid candles/);
  });

  it('surfaces a provider failure as an error state that can be reloaded', async () => {
    let fail = true;
    const healthy = fixtureProvider();
    const service = createMarketDataService(
      fixtureProvider({
        getCandles: (request, sig) =>
          fail ? Promise.reject(new Error('503 from provider')) : healthy.getCandles(request, sig),
      }),
    );
    service.loadCandles('EURUSD', 'D1');
    await tick();
    assert.equal(service.candles('EURUSD', 'D1').get().status, 'error');
    fail = false;
    service.reloadCandles('EURUSD', 'D1');
    await tick();
    assert.equal(service.candles('EURUSD', 'D1').get().status, 'ready');
  });
});

describe('implied volatility surface contract', () => {
  const surface = fixtureSurface();

  it('accepts a well-formed grid with a stated strike axis', () => {
    assert.deepEqual(validateVolSurface(surface), []);
    assert.equal(surface.strikeAxis.kind, 'log-moneyness');
    assert.deepEqual(volRange(surface), { min: 8.1, max: 10.4 });
  });

  it('rejects malformed surfaces', () => {
    const broken = (patch: Partial<VolSurface>): string =>
      validateVolSurface({ ...surface, ...patch }).join();
    assert.match(broken({ iv: surface.iv.slice(1) }), /rows do not match the expiry axis/);
    assert.match(
      broken({ iv: [[1, 2], ...surface.iv.slice(1)] }),
      /row 0 does not match the strike axis/,
    );
    assert.match(
      broken({ expiriesDays: [...surface.expiriesDays].reverse() }),
      /expiry axis must be positive, finite and strictly ascending/,
    );
    assert.match(
      broken({ strikeAxis: { ...surface.strikeAxis, values: [0, 0, 0, 0, 0] } }),
      /strike axis must be finite and strictly ascending/,
    );
    assert.match(
      broken({ iv: surface.iv.map((row, index) => (index === 2 ? row.map(() => -1) : row)) }),
      /non-positive/,
    );
  });

  it('reports unavailable, with the reason, because no adapter exists', async () => {
    const provider = createUnconfiguredSurfaceProvider();
    assert.deepEqual(await provider.getSurface('EURUSD', signal), {
      status: 'unavailable',
      reason: NO_OPTIONS_PROVIDER_REASON,
    });
    assert.match(NO_OPTIONS_PROVIDER_REASON, /no options-data adapter exists/i);
  });
});

describe('macro feeds', () => {
  it('report unavailable, with the reason, because no adapter exists', async () => {
    const feed = createUnconfiguredMacroFeed();
    const range = { fromMs: 0, toMs: 1 };
    assert.deepEqual(await feed.getCalendar(range, signal), {
      status: 'unavailable',
      reason: NO_MACRO_FEED_REASON,
    });
    assert.deepEqual(await feed.getNews(signal), {
      status: 'unavailable',
      reason: NO_MACRO_FEED_REASON,
    });
    assert.match(NO_MACRO_FEED_REASON, /no macro-data adapter exists/i);
  });
});
