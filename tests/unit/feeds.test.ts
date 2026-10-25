import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFeed, type FeedState } from '../../src/app/feeds.js';
import type { ConnectionState } from '../../src/app/connection.js';
import { quoteView, seriesView } from '../../src/app/selectors.js';
import { worstState } from '../../src/core/freshness.js';
import { createStore, derived, type Store } from '../../src/core/store.js';
import type { SourceInfo, Timeframe } from '../../src/core/types.js';
import type { CandleSeries } from '../../src/data/provider.js';
import { createMarketDataService, type QuoteBook } from '../../src/data/service.js';
import { FIXTURE_NOW, fixtureCandles, fixtureProvider, fixtureQuote } from '../support/fixtures.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('derived store', () => {
  it('recomputes from its sources and only notifies on a real change', () => {
    const a = createStore(1);
    const b = createStore(10);
    const sum = derived([a, b], (x, y) => x + y);
    const seen: number[] = [];
    sum.subscribe((value) => seen.push(value));
    assert.equal(sum.get(), 11);
    a.set(2);
    b.set(10); // unchanged source value: no recompute notification
    b.set(20);
    assert.deepEqual(seen, [12, 22]);

    const parity = derived([a], (x) => x % 2);
    const parities: number[] = [];
    parity.subscribe((value) => parities.push(value));
    a.set(4); // still even: the derived value did not change
    a.set(5);
    assert.deepEqual(parities, [1]);
  });

  it('supports structural equality and stops after dispose', () => {
    const source = createStore({ id: 'A', noise: 1 });
    const picked = derived(
      [source],
      (value) => ({ id: value.id }),
      (x, y) => x.id === y.id,
    );
    const seen: string[] = [];
    picked.subscribe((value) => seen.push(value.id));
    source.set({ id: 'A', noise: 2 });
    source.set({ id: 'B', noise: 2 });
    picked.dispose();
    source.set({ id: 'C', noise: 3 });
    assert.deepEqual(seen, ['B']);
    assert.equal(picked.get().id, 'B');
  });
});

describe('worstState', () => {
  it('returns the least trustworthy state', () => {
    assert.equal(worstState(['live', 'live']), 'live');
    assert.equal(worstState(['live', 'delayed']), 'delayed');
    assert.equal(worstState(['delayed', 'stale', 'live']), 'stale');
    assert.equal(worstState(['stale', 'unavailable']), 'unavailable');
    assert.equal(worstState([]), 'unavailable');
  });
});

function connectedState(
  provider = fixtureProvider(),
): Extract<ConnectionState, { status: 'connected' }> {
  const service = createMarketDataService(provider, { now: () => FIXTURE_NOW });
  return {
    status: 'connected',
    source: provider.info,
    service,
    pollSeconds: { quotes: 60, candles: 60 },
  };
}

interface Selection {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
}

function candlesFeed(connection: Store<ConnectionState>) {
  const key = createStore<Selection>({ instrumentId: 'EURUSD', timeframe: 'H1' });
  const feed = createFeed<CandleSeries, Selection>(connection, key, (service, current) => ({
    store: service.candles(current.instrumentId, current.timeframe),
    load: () => service.loadCandles(current.instrumentId, current.timeframe),
    reload: () => service.reloadCandles(current.instrumentId, current.timeframe),
  }));
  return { feed, key };
}

describe('feeds', () => {
  it('maps every connection state to a feed state without touching the provider', () => {
    const connection = createStore<ConnectionState>({ status: 'checking' });
    const { feed } = candlesFeed(connection);
    assert.equal(feed.store.get().kind, 'checking');
    connection.set({
      status: 'not-connected',
      detail: 'Server environment variable X is not set.',
      missing: ['X'],
    });
    assert.deepEqual(feed.store.get(), {
      kind: 'not-connected',
      detail: 'Server environment variable X is not set.',
      missing: ['X'],
    });
    connection.set({ status: 'error', message: 'offline' });
    assert.deepEqual(feed.store.get(), { kind: 'connection-error', message: 'offline' });
    feed.dispose();
  });

  it('loads through the connected service and follows key changes', async () => {
    const requested: string[] = [];
    const provider = fixtureProvider({
      getCandles: async (request) => {
        requested.push(`${request.instrumentId}:${request.timeframe}`);
        return {
          instrumentId: request.instrumentId,
          timeframe: request.timeframe,
          candles: fixtureCandles(5, request.timeframe),
        };
      },
    });
    const connection = createStore<ConnectionState>(connectedState(provider));
    const { feed, key } = candlesFeed(connection);
    assert.equal(feed.store.get().kind, 'loading');
    await settle();
    const first = feed.store.get();
    assert.equal(first.kind, 'ready');

    key.set({ instrumentId: 'GBPUSD', timeframe: 'D1' });
    await settle();
    const second = feed.store.get();
    assert.ok(
      second.kind === 'ready' &&
        second.value.instrumentId === 'GBPUSD' &&
        second.value.timeframe === 'D1',
    );
    assert.deepEqual(requested, ['EURUSD:H1', 'GBPUSD:D1']);
    feed.dispose();
  });

  it('never shows a late response for a previous selection', async () => {
    const pending = new Map<string, (series: CandleSeries) => void>();
    const provider = fixtureProvider({
      getCandles: (request) =>
        new Promise<CandleSeries>((resolve) => {
          pending.set(request.instrumentId, resolve);
        }),
    });
    const connection = createStore<ConnectionState>(connectedState(provider));
    const { feed, key } = candlesFeed(connection);
    await settle();
    key.set({ instrumentId: 'GBPUSD', timeframe: 'H1' });
    await settle();
    // The EURUSD answer arrives after the user already moved to GBPUSD.
    pending.get('EURUSD')?.({
      instrumentId: 'EURUSD',
      timeframe: 'H1',
      candles: fixtureCandles(3, 'H1'),
    });
    await settle();
    assert.equal(feed.store.get().kind, 'loading');
    pending.get('GBPUSD')?.({
      instrumentId: 'GBPUSD',
      timeframe: 'H1',
      candles: fixtureCandles(3, 'H1'),
    });
    await settle();
    const state = feed.store.get();
    assert.ok(state.kind === 'ready' && state.value.instrumentId === 'GBPUSD');
    feed.dispose();
  });

  it('flips to ENV NOT CONNECTION mid-session and recovers with a fresh service', async () => {
    const connection = createStore<ConnectionState>(connectedState());
    const { feed } = candlesFeed(connection);
    await settle();
    assert.equal(feed.store.get().kind, 'ready');
    connection.set({
      status: 'not-connected',
      detail: 'The provider rejected the configured API key (HTTP 401).',
      missing: [],
    });
    assert.equal(feed.store.get().kind, 'not-connected');
    connection.set({ status: 'checking' });
    connection.set(connectedState());
    assert.equal(feed.store.get().kind, 'loading', 'a new service starts from scratch');
    await settle();
    assert.equal(feed.store.get().kind, 'ready');
    feed.dispose();
  });

  it('reload asks the provider again, and dispose stops all updates', async () => {
    let calls = 0;
    const provider = fixtureProvider({
      getCandles: async (request) => {
        calls += 1;
        return {
          instrumentId: request.instrumentId,
          timeframe: request.timeframe,
          candles: fixtureCandles(3, request.timeframe),
        };
      },
    });
    const connection = createStore<ConnectionState>(connectedState(provider));
    const { feed } = candlesFeed(connection);
    await settle();
    feed.reload();
    await settle();
    assert.equal(calls, 2);
    feed.dispose();
    connection.set({ status: 'error', message: 'x' });
    assert.equal(
      feed.store.get().kind,
      'ready',
      'a disposed feed no longer follows the connection',
    );
  });

  it('keeps the last quotes and reports refreshError when a background refresh fails', async () => {
    let fail = false;
    const provider = fixtureProvider({
      getQuotes: async (ids) => {
        if (fail) throw new Error('rate limited');
        return { quotes: ids.map((id) => fixtureQuote(id)), failures: new Map<string, string>() };
      },
    });
    const state = connectedState(provider);
    const connection = createStore<ConnectionState>(state);
    const feed = createFeed<QuoteBook, string>(connection, createStore('all'), (service) => ({
      store: service.quotes,
      load: () => service.loadQuotes(),
      reload: () => service.reloadQuotes(),
    }));
    await settle();
    assert.equal(feed.store.get().kind, 'ready');
    fail = true;
    state.service.refreshQuotes();
    await settle();
    const after = feed.store.get();
    assert.ok(after.kind === 'ready' && after.refreshError === 'rate limited');
    assert.ok(after.kind === 'ready' && after.value.quotes.size === 8);
    feed.dispose();
  });
});

describe('selectors', () => {
  const delayed: SourceInfo = { id: 't', label: 'T', mode: 'delayed', staleAfterMs: 60_000 };
  const live: SourceInfo = { ...delayed, mode: 'live' };
  const book = (quoteAsOf: number): FeedState<QuoteBook> => ({
    kind: 'ready',
    loadedAt: FIXTURE_NOW,
    refreshError: null,
    value: {
      quotes: new Map([['EURUSD', fixtureQuote('EURUSD', { asOf: quoteAsOf })]]),
      rejected: new Map([['GBPUSD', 'The provider request limit was reached (HTTP 429).']]),
    },
  });

  it('classifies a quote by the source mode and its own timestamp', () => {
    assert.equal(
      quoteView(book(FIXTURE_NOW - 5_000), 'EURUSD', delayed, FIXTURE_NOW).state,
      'delayed',
    );
    assert.equal(quoteView(book(FIXTURE_NOW - 5_000), 'EURUSD', live, FIXTURE_NOW).state, 'live');
    assert.equal(
      quoteView(book(FIXTURE_NOW - 3_600_000), 'EURUSD', live, FIXTURE_NOW).state,
      'stale',
    );
  });

  it('explains a missing quote and never invents one', () => {
    const rejected = quoteView(book(FIXTURE_NOW), 'GBPUSD', live, FIXTURE_NOW);
    assert.deepEqual([rejected.state, rejected.quote], ['unavailable', null]);
    assert.match(rejected.note ?? '', /429/);
    const absent = quoteView(book(FIXTURE_NOW), 'USDJPY', live, FIXTURE_NOW);
    assert.match(absent.note ?? '', /no quote/i);
    assert.equal(quoteView({ kind: 'loading' }, 'EURUSD', live, FIXTURE_NOW).state, 'unavailable');
    assert.equal(
      quoteView({ kind: 'not-connected', detail: 'x', missing: [] }, 'EURUSD', null, FIXTURE_NOW)
        .note,
      null,
    );
    assert.equal(
      quoteView({ kind: 'error', message: 'boom' }, 'EURUSD', live, FIXTURE_NOW).note,
      'boom',
    );
  });

  it('classifies a series by its newest bar and allows one bar length of age', () => {
    const series = (age: number): FeedState<CandleSeries> => ({
      kind: 'ready',
      loadedAt: FIXTURE_NOW,
      refreshError: null,
      value: {
        instrumentId: 'EURUSD',
        timeframe: 'H1',
        candles: fixtureCandles(3, 'H1', FIXTURE_NOW - age),
      },
    });
    assert.equal(seriesView(series(0), live, 'H1', FIXTURE_NOW).state, 'live');
    assert.equal(
      seriesView(series(3_000_000), live, 'H1', FIXTURE_NOW).state,
      'live',
      'inside one H1 bar plus tolerance',
    );
    assert.equal(seriesView(series(5 * 3_600_000), live, 'H1', FIXTURE_NOW).state, 'stale');
    assert.deepEqual(seriesView({ kind: 'loading' }, live, 'H1', FIXTURE_NOW), {
      state: 'unavailable',
      newestBarOpen: null,
    });
    const empty: FeedState<CandleSeries> = {
      kind: 'ready',
      loadedAt: FIXTURE_NOW,
      refreshError: null,
      value: { instrumentId: 'EURUSD', timeframe: 'H1', candles: [] },
    };
    assert.deepEqual(seriesView(empty, live, 'H1', FIXTURE_NOW), {
      state: 'unavailable',
      newestBarOpen: null,
    });
  });
});
