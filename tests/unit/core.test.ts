import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFreshness,
  classifySeriesFreshness,
  DATA_STATE_LABEL,
  isAnalysisEligible,
} from '../../src/core/freshness.js';
import {
  formatAge,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSignedPrice,
  formatUtcDateTime,
  formatUtcDayMonth,
  formatUtcTime,
  formatZoned,
  NO_VALUE,
} from '../../src/core/format.js';
import {
  DEFAULT_INSTRUMENT_ID,
  filterInstruments,
  findInstrument,
  INSTRUMENTS,
} from '../../src/core/instruments.js';
import {
  TIMEFRAME_SECONDS,
  TIMEFRAMES,
  isTimeframe,
  type DataState,
} from '../../src/core/types.js';

const EURUSD = { pricePrecision: 5, assetClass: 'fx' } as const;
const USDJPY = { pricePrecision: 3, assetClass: 'fx' } as const;
const XAUUSD = { pricePrecision: 2, assetClass: 'metal' } as const;

describe('format', () => {
  it('formats prices with the instrument precision', () => {
    assert.equal(formatPrice(1.1, EURUSD), '1.10000');
    assert.equal(formatPrice(150, USDJPY), '150.000');
    assert.equal(formatPrice(2000.5, XAUUSD), '2,000.50');
  });

  it('never prints a number for a missing or non-finite value', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(formatPrice(value, EURUSD), NO_VALUE);
      assert.equal(formatSignedPrice(value, EURUSD), NO_VALUE);
      assert.equal(formatPercent(value), NO_VALUE);
      assert.equal(formatNumber(value), NO_VALUE);
    }
  });

  it('signs deltas, and shows no sign when the rounded value is zero', () => {
    assert.equal(formatSignedPrice(0.00123, EURUSD), '+0.00123');
    assert.equal(formatSignedPrice(-0.5, EURUSD), '-0.50000');
    assert.equal(formatSignedPrice(0, EURUSD), '0.00000');
    assert.equal(formatSignedPrice(-0.000001, EURUSD), '0.00000');
    assert.equal(formatPercent(0.3456), '+0.35%');
    assert.equal(formatPercent(-1.2), '-1.20%');
    assert.equal(formatPercent(0), '0.00%');
    assert.equal(formatPercent(-0.001), '0.00%');
  });

  it('formats UTC timestamps', () => {
    const time = Date.UTC(2026, 0, 2, 21, 5, 9);
    assert.equal(formatUtcDateTime(time), '2026-01-02 21:05 UTC');
    assert.equal(formatUtcTime(time), '21:05');
    assert.equal(formatUtcTime(time, true), '21:05:09');
    assert.equal(formatUtcDayMonth(time), '02 Jan');
    assert.equal(formatUtcDateTime(Number.NaN), NO_VALUE);
  });

  it('converts to a named zone and names the zone', () => {
    const text = formatZoned(Date.UTC(2026, 0, 2, 21, 0), 'Asia/Jakarta');
    assert.match(text, /03 Jan 2026/);
    assert.match(text, /04:00/);
    assert.match(text, /GMT\+7/);
  });

  it('formats ages compactly', () => {
    assert.equal(formatAge(12_000), '12s');
    assert.equal(formatAge(185_000), '3m 05s');
    assert.equal(formatAge(7_500_000), '2h 05m');
    assert.equal(formatAge(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');
    assert.equal(formatAge(-1), NO_VALUE);
  });
});

describe('freshness', () => {
  const now = 1_000_000;
  const staleAfterMs = 10_000;

  it('reports unavailable when there is no datum', () => {
    for (const asOf of [null, undefined, Number.NaN]) {
      assert.equal(classifyFreshness({ mode: 'live', asOf, now, staleAfterMs }), 'unavailable');
    }
  });

  it('turns live and delayed data stale only once it is older than the limit', () => {
    assert.equal(
      classifyFreshness({ mode: 'live', asOf: now - 10_000, now, staleAfterMs }),
      'live',
    );
    assert.equal(
      classifyFreshness({ mode: 'live', asOf: now - 10_001, now, staleAfterMs }),
      'stale',
    );
    assert.equal(
      classifyFreshness({ mode: 'delayed', asOf: now - 5_000, now, staleAfterMs }),
      'delayed',
    );
    assert.equal(
      classifyFreshness({ mode: 'delayed', asOf: now - 60_000, now, staleAfterMs }),
      'stale',
    );
  });

  it('treats a timestamp slightly in the future (clock skew) as fresh', () => {
    assert.equal(classifyFreshness({ mode: 'live', asOf: now + 3_000, now, staleAfterMs }), 'live');
  });

  it('allows a series one full bar plus the tolerance before it is stale', () => {
    const base = { mode: 'live', timeframe: 'H1', now, staleAfterMs } as const;
    const hour = 3_600_000;
    assert.equal(classifySeriesFreshness({ ...base, newestBarOpen: now - hour - 10_000 }), 'live');
    assert.equal(classifySeriesFreshness({ ...base, newestBarOpen: now - hour - 10_001 }), 'stale');
    assert.equal(classifySeriesFreshness({ ...base, newestBarOpen: null }), 'unavailable');
    assert.equal(
      classifySeriesFreshness({ ...base, mode: 'delayed', newestBarOpen: now - 1_000 }),
      'delayed',
    );
  });

  it('has no simulated state: the only states are live, delayed, stale and unavailable', () => {
    assert.deepEqual(Object.keys(DATA_STATE_LABEL).sort(), [
      'delayed',
      'live',
      'stale',
      'unavailable',
    ]);
  });

  it('only lets live or delayed data feed an analysis', () => {
    const states: DataState[] = ['live', 'delayed', 'stale', 'unavailable'];
    assert.deepEqual(
      states.filter((state) => isAnalysisEligible(state)),
      ['live', 'delayed'],
    );
    for (const state of states) assert.ok(DATA_STATE_LABEL[state].length > 0);
  });
});

describe('instruments', () => {
  it('lists the Phase 1 watchlist in order', () => {
    assert.deepEqual(
      INSTRUMENTS.map((instrument) => instrument.symbol),
      ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'XAU/USD'],
    );
    assert.equal(new Set(INSTRUMENTS.map((instrument) => instrument.id)).size, INSTRUMENTS.length);
    assert.ok(findInstrument(DEFAULT_INSTRUMENT_ID));
  });

  it('finds instruments by id or symbol, ignoring case and punctuation', () => {
    assert.equal(findInstrument('eur/usd')?.id, 'EURUSD');
    assert.equal(findInstrument('XAUUSD')?.symbol, 'XAU/USD');
    assert.equal(findInstrument('nope'), undefined);
  });

  it('filters by symbol and by name', () => {
    const ids = (query: string): string[] => filterInstruments(INSTRUMENTS, query).map((i) => i.id);
    assert.equal(ids('').length, 8);
    assert.equal(ids('   ').length, 8);
    assert.deepEqual(ids('xau'), ['XAUUSD']);
    assert.deepEqual(ids('gold'), ['XAUUSD']);
    assert.deepEqual(ids('jpy'), ['USDJPY']);
    assert.deepEqual(ids('yen'), ['USDJPY']);
    assert.deepEqual(ids('eur/usd'), ['EURUSD']);
    assert.equal(ids('usd').length, 8);
    assert.deepEqual(ids('zzz'), []);
  });

  it('states depth semantics for every instrument, and keeps gold futures separate', () => {
    for (const instrument of INSTRUMENTS) assert.ok(instrument.depthNote.length > 40);
    assert.match(findInstrument('EURUSD')?.depthNote ?? '', /over the counter/i);
    const gold = findInstrument('XAUUSD')?.depthNote ?? '';
    assert.match(gold, /futures/i);
    assert.match(gold, /never substituted/i);
  });
});

describe('timeframes', () => {
  it('has consistent second counts, each a multiple of the previous shorter one', () => {
    assert.deepEqual([...TIMEFRAMES], ['M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
    assert.deepEqual(
      TIMEFRAMES.map((timeframe) => TIMEFRAME_SECONDS[timeframe]),
      [300, 900, 1800, 3600, 14400, 86400],
    );
    for (let index = 1; index < TIMEFRAMES.length; index += 1) {
      const longer = TIMEFRAME_SECONDS[TIMEFRAMES[index] ?? 'D1'];
      const shorter = TIMEFRAME_SECONDS[TIMEFRAMES[index - 1] ?? 'M5'];
      assert.equal(longer % shorter, 0);
    }
  });

  it('recognizes only supported timeframes', () => {
    assert.ok(isTimeframe('H1'));
    assert.ok(!isTimeframe('h1'));
    assert.ok(!isTimeframe('W1'));
    assert.ok(!isTimeframe(5));
  });
});
