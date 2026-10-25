import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCandles, parseError, parseQuotes, parseStatus } from '../../src/data/wire.js';
import { fixtureQuote } from '../support/fixtures.js';

const connected = {
  connected: true,
  source: { id: 'twelvedata', label: 'Twelve Data', mode: 'delayed', staleAfterMs: 1_800_000 },
  depth: { available: false, reason: 'no adapter' },
  pollSeconds: { quotes: 60, candles: 60 },
};

describe('wire: status', () => {
  it('accepts both connected and not-connected answers', () => {
    assert.equal(parseStatus(connected).ok, true);
    assert.deepEqual(parseStatus({ connected: false, missing: ['TWELVE_DATA_API_KEY'] }), {
      ok: true,
      value: { connected: false, missing: ['TWELVE_DATA_API_KEY'] },
    });
  });

  it('rejects anything else, including an HTML page that answered with 200', () => {
    for (const bad of [
      null,
      '<html></html>',
      [],
      {},
      { connected: 'yes' },
      { connected: false },
      { connected: false, missing: [1] },
      { ...connected, source: { ...connected.source, mode: 'simulated' } },
      { ...connected, source: { ...connected.source, staleAfterMs: 0 } },
      { ...connected, source: { ...connected.source, label: '' } },
      { ...connected, depth: { available: true, reason: 'x' } },
      { ...connected, pollSeconds: { quotes: 60 } },
    ]) {
      assert.equal(parseStatus(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('wire: quotes', () => {
  it('accepts quotes with per-instrument failures', () => {
    const parsed = parseQuotes({
      quotes: [fixtureQuote('EURUSD')],
      failures: { GBPUSD: { code: 'rate_limited', message: 'limit' } },
    });
    assert.ok(parsed.ok);
  });

  it('rejects malformed quotes and failures', () => {
    const good = fixtureQuote('EURUSD');
    for (const bad of [
      { quotes: 'x', failures: {} },
      { quotes: [{ ...good, last: 'high' }], failures: {} },
      { quotes: [{ ...good, bid: 1.1 }, 5], failures: {} },
      { quotes: [{ ...good, asOf: null }], failures: {} },
      { quotes: [{ ...good, marketOpen: 'yes' }], failures: {} },
      { quotes: [good] },
      { quotes: [good], failures: { A: { code: 'mystery', message: 'x' } } },
      { quotes: [good], failures: { A: { code: 'rate_limited', message: '' } } },
    ]) {
      assert.equal(parseQuotes(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('wire: candles', () => {
  const bars = [
    [1, 10, 12, 9, 11],
    [2, 11, 13, 10, 12],
  ];

  it('accepts bars of five numbers for a known timeframe', () => {
    assert.ok(parseCandles({ instrumentId: 'EURUSD', timeframe: 'H1', candles: bars }).ok);
    assert.ok(parseCandles({ instrumentId: 'EURUSD', timeframe: 'H1', candles: [] }).ok);
  });

  it('rejects a wrong timeframe, short bars and non-numbers', () => {
    for (const bad of [
      { instrumentId: 'EURUSD', timeframe: 'W1', candles: bars },
      { instrumentId: '', timeframe: 'H1', candles: bars },
      { instrumentId: 'EURUSD', timeframe: 'H1', candles: [[1, 2, 3, 4]] },
      { instrumentId: 'EURUSD', timeframe: 'H1', candles: [[1, 2, 3, 4, '5']] },
      { instrumentId: 'EURUSD', timeframe: 'H1', candles: [[1, 2, 3, 4, Number.NaN]] },
      { instrumentId: 'EURUSD', timeframe: 'H1' },
    ]) {
      assert.equal(parseCandles(bad).ok, false);
    }
  });
});

describe('wire: error envelope', () => {
  it('recognizes known codes only', () => {
    assert.ok(parseError({ error: { code: 'not_connected', message: 'x' } }).ok);
    assert.equal(parseError({ error: { code: 'teapot', message: 'x' } }).ok, false);
    assert.equal(parseError({ error: { code: 'rate_limited' } }).ok, false);
    assert.equal(parseError({}).ok, false);
  });
});
