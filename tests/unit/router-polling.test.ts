import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createClock } from '../../src/app/clock.js';
import { startPolling, type PollSelection } from '../../src/app/polling.js';
import { DEFAULT_ROUTE, createRouter, formatRoute, parseHash } from '../../src/app/router.js';
import { createStore } from '../../src/core/store.js';
import { createMarketDataService } from '../../src/data/service.js';
import { FIXTURE_NOW, fixtureCandles, fixtureProvider, fixtureQuote } from '../support/fixtures.js';

describe('router: parseHash', () => {
  it('reads forex and macro routes', () => {
    assert.deepEqual(parseHash('#/forex/GBPUSD/H4'), {
      page: 'forex',
      instrumentId: 'GBPUSD',
      timeframe: 'H4',
    });
    assert.deepEqual(parseHash('#/macro/bubbles'), { page: 'macro', tab: 'bubbles' });
  });

  it('accepts symbols, encoded slashes and any case for instrument, timeframe and page', () => {
    assert.deepEqual(parseHash('#/forex/xauusd/d1'), {
      page: 'forex',
      instrumentId: 'XAUUSD',
      timeframe: 'D1',
    });
    assert.deepEqual(parseHash('#/forex/eur%2Fusd/m5'), {
      page: 'forex',
      instrumentId: 'EURUSD',
      timeframe: 'M5',
    });
    assert.deepEqual(parseHash('#/FOREX/gbpusd/h4'), {
      page: 'forex',
      instrumentId: 'GBPUSD',
      timeframe: 'H4',
    });
    assert.deepEqual(parseHash('#/Macro/Bubbles'), { page: 'macro', tab: 'bubbles' });
  });

  it('survives a malformed percent escape instead of throwing', () => {
    assert.deepEqual(parseHash('#/forex/%E0%A4%A/H1'), DEFAULT_ROUTE);
    assert.deepEqual(parseHash('#/macro/%'), { page: 'macro', tab: 'vol-surface' });
  });

  it('falls back to valid values for anything unknown, never failing', () => {
    assert.deepEqual(parseHash(''), DEFAULT_ROUTE);
    assert.deepEqual(parseHash('#'), DEFAULT_ROUTE);
    assert.deepEqual(parseHash('#/nope'), DEFAULT_ROUTE);
    assert.deepEqual(parseHash('#/forex/NOPE/W1'), DEFAULT_ROUTE);
    assert.deepEqual(parseHash('#/forex/USDJPY'), {
      page: 'forex',
      instrumentId: 'USDJPY',
      timeframe: 'H1',
    });
    assert.deepEqual(parseHash('#/macro'), { page: 'macro', tab: 'vol-surface' });
    assert.deepEqual(parseHash('#/macro/unknown'), { page: 'macro', tab: 'vol-surface' });
  });

  it('round-trips through formatRoute', () => {
    for (const hash of [
      '#/forex/EURUSD/H1',
      '#/forex/XAUUSD/D1',
      '#/macro/vol-surface',
      '#/macro/news-calendar',
    ]) {
      assert.equal(formatRoute(parseHash(hash)), hash);
    }
  });
});

describe('router: createRouter', () => {
  function fakeWindow(initialHash: string) {
    const listeners = new Set<() => void>();
    const location = { hash: initialHash, pathname: '/', search: '' };
    const replaced: string[] = [];
    return {
      win: {
        location,
        history: {
          replaceState: (_s: unknown, _t: string, url: string) => {
            replaced.push(url);
            location.hash = url.slice(url.indexOf('#'));
          },
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      } as unknown as Window,
      fire: (hash: string) => {
        location.hash = hash;
        for (const l of [...listeners]) l();
      },
      replaced,
      listeners,
    };
  }

  it('rewrites a non-canonical address and follows hash changes', () => {
    const fake = fakeWindow('#/forex/eurusd/h1');
    const router = createRouter(fake.win);
    assert.deepEqual(router.route.get(), DEFAULT_ROUTE);
    assert.deepEqual(fake.replaced, ['/#/forex/EURUSD/H1']);
    fake.fire('#/macro/bubbles');
    assert.deepEqual(router.route.get(), { page: 'macro', tab: 'bubbles' });
    fake.fire('#/garbage');
    assert.deepEqual(router.route.get(), DEFAULT_ROUTE);
    router.navigate({ page: 'forex', instrumentId: 'USDCHF', timeframe: 'M30' });
    assert.equal(fake.win.location.hash, '#/forex/USDCHF/M30');
    router.dispose();
    assert.equal(fake.listeners.size, 0);
  });
});

describe('clock', () => {
  it('republishes the time every second and stops on dispose', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      let time = 1_000;
      const clock = createClock(() => time);
      const seen: number[] = [];
      clock.now.subscribe((value) => seen.push(value));
      time = 2_000;
      mock.timers.tick(1_000);
      time = 3_000;
      mock.timers.tick(1_000);
      clock.dispose();
      time = 4_000;
      mock.timers.tick(5_000);
      assert.deepEqual(seen, [2_000, 3_000]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('polling', () => {
  function setup(overrides: { hidden?: boolean; enabled?: boolean } = {}) {
    const requests: string[] = [];
    const provider = fixtureProvider({
      getQuotes: async (ids) => {
        requests.push('quotes');
        return { quotes: ids.map((id) => fixtureQuote(id)), failures: new Map<string, string>() };
      },
      getCandles: async (request) => {
        requests.push(`candles:${request.instrumentId}:${request.timeframe}`);
        return {
          instrumentId: request.instrumentId,
          timeframe: request.timeframe,
          candles: fixtureCandles(20, request.timeframe),
        };
      },
    });
    const state = { hidden: overrides.hidden ?? false, now: FIXTURE_NOW };
    const service = createMarketDataService(provider, { now: () => state.now });
    const selection = createStore<PollSelection>({ instrumentId: 'EURUSD', timeframe: 'H1' });
    const enabled = createStore(overrides.enabled ?? true);
    const timers = new Map<number, { handler: () => void; ms: number }>();
    let nextHandle = 1;
    let visibleHandler: () => void = () => undefined;
    const stop = startPolling({
      service,
      pollSeconds: { quotes: 60, candles: 90 },
      selection,
      enabled,
      isHidden: () => state.hidden,
      now: () => state.now,
      setInterval: (handler, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { handler, ms });
        return handle;
      },
      clearInterval: (handle) => {
        timers.delete(handle as number);
      },
      onVisible: (handler) => {
        visibleHandler = handler;
        return () => {
          visibleHandler = () => undefined;
        };
      },
    });
    const fire = (ms: number): void => {
      for (const timer of timers.values()) if (timer.ms === ms) timer.handler();
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      requests,
      state,
      selection,
      enabled,
      timers,
      stop,
      fire,
      service,
      settle,
      visible: () => visibleHandler(),
    };
  }

  it('uses the server-declared cadence and refreshes only the selected chart', async () => {
    const t = setup();
    assert.deepEqual(
      [...t.timers.values()].map((x) => x.ms).sort((a, b) => a - b),
      [60_000, 90_000],
    );
    t.fire(60_000);
    t.fire(90_000);
    await t.settle();
    t.selection.set({ instrumentId: 'XAUUSD', timeframe: 'D1' });
    t.fire(90_000);
    await t.settle();
    assert.deepEqual(t.requests, ['quotes', 'candles:EURUSD:H1', 'candles:XAUUSD:D1']);
  });

  it('requests nothing while the tab is hidden or auto-refresh is off', async () => {
    const hidden = setup({ hidden: true });
    hidden.fire(60_000);
    hidden.fire(90_000);
    await hidden.settle();
    assert.deepEqual(hidden.requests, []);

    const off = setup({ enabled: false });
    off.fire(60_000);
    await off.settle();
    assert.deepEqual(off.requests, []);
    off.enabled.set(true);
    off.fire(60_000);
    await off.settle();
    assert.deepEqual(off.requests, ['quotes']);
  });

  it('refreshes data older than its interval when the tab becomes visible, and only that data', async () => {
    const t = setup();
    t.service.loadQuotes();
    t.service.loadCandles('EURUSD', 'H1');
    await t.settle();
    assert.deepEqual(t.requests, ['quotes', 'candles:EURUSD:H1']);

    // 70 s later: quotes (60 s interval) are due, candles (90 s interval) are not.
    t.state.now = FIXTURE_NOW + 70_000;
    t.visible();
    await t.settle();
    assert.deepEqual(t.requests, ['quotes', 'candles:EURUSD:H1', 'quotes']);

    // Fresh data is left alone.
    t.visible();
    await t.settle();
    assert.equal(t.requests.length, 3);
  });

  it('does not refresh on becoming visible while auto-refresh is off', async () => {
    const t = setup({ enabled: false });
    t.service.loadQuotes();
    await t.settle();
    t.state.now = FIXTURE_NOW + 10 * 60_000;
    t.visible();
    await t.settle();
    assert.deepEqual(t.requests, ['quotes']);
  });

  it('keeps the old data on screen while a background refresh runs', async () => {
    const t = setup();
    t.service.loadQuotes();
    await t.settle();
    const before = t.service.quotes.get();
    assert.equal(before.status, 'ready');
    t.fire(60_000);
    const during = t.service.quotes.get();
    assert.equal(during.status, 'ready', 'a refresh never blanks the panel');
    await t.settle();
  });

  it('clears its timers and visibility hook when stopped', () => {
    const t = setup();
    t.stop();
    assert.equal(t.timers.size, 0);
  });
});
