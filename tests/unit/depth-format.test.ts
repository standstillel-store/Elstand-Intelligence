import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spreadOf, withCumulative, type DepthLevel } from '../../src/data/depth.js';
import { barPercent, MAX_DEPTH_LEVELS, sizeDigits } from '../../src/ui/forex/depth-panel.js';
import { fixtureDepth } from '../support/fixtures.js';

const levels = (...sizes: number[]): DepthLevel[] =>
  sizes.map((size, index) => ({ price: 1 - index / 1000, size }));

describe('sizeDigits: show every size exactly, never rounded for display', () => {
  it('needs no decimals for whole sizes, and for an empty side', () => {
    assert.equal(sizeDigits(levels(1, 5, 250)), 0);
    assert.equal(sizeDigits([]), 0);
  });

  it('uses the fewest decimals that keep every size exact', () => {
    assert.equal(sizeDigits(levels(2, 3.5)), 1);
    assert.equal(sizeDigits(levels(1, 0.25)), 2);
    assert.equal(sizeDigits(levels(0.125, 4)), 3);
    assert.equal(sizeDigits(levels(0.0625)), 4);
  });

  it('is set by the most precise size on the side', () => {
    assert.equal(sizeDigits(levels(1, 2, 3, 0.5, 4, 0.25)), 2);
  });

  it('stops at four decimals rather than inventing precision', () => {
    assert.equal(sizeDigits(levels(0.00001)), 4);
    assert.equal(sizeDigits(levels(0.1 + 0.2)), 4);
  });
});

describe('barPercent: bar widths are drawn from the book, to scale', () => {
  it('is linear in the cumulative size', () => {
    assert.equal(barPercent(5, 20), 25);
    assert.equal(barPercent(10, 20), 50);
    assert.equal(barPercent(20, 20), 100);
  });

  it('is 0 for no size, and never negative or past 100', () => {
    assert.equal(barPercent(0, 20), 0);
    assert.equal(barPercent(-4, 20), 0);
    assert.equal(barPercent(25, 20), 100);
  });

  it('is 0 rather than NaN when there is nothing to scale against, or the size is not a number', () => {
    for (const [cumulative, largest] of [
      [5, 0],
      [5, -1],
      [5, Number.NaN],
      [Number.NaN, 20],
      [Number.POSITIVE_INFINITY, 20],
    ] as const) {
      assert.equal(barPercent(cumulative, largest), 0, `${cumulative} of ${largest}`);
    }
  });

  it('scales both sides against the same total, so a bid bar and an ask bar can be compared', () => {
    const book = fixtureDepth();
    const bids = withCumulative(book.bids);
    const asks = withCumulative(book.asks);
    const largest = Math.max(
      bids[bids.length - 1]?.cumulative ?? 0,
      asks[asks.length - 1]?.cumulative ?? 0,
    );
    const widths = [...bids, ...asks].map((level) => barPercent(level.cumulative, largest));
    assert.ok(widths.every((width) => width > 0 && width <= 100));
    assert.equal(Math.max(...widths), 100);
  });
});

describe('the depth book arithmetic the bars and spread rely on', () => {
  it('accumulates size from the best level outward', () => {
    const cumulative = withCumulative(levels(2, 5, 3.5));
    assert.deepEqual(
      cumulative.map((level) => level.cumulative),
      [2, 7, 10.5],
    );
    assert.deepEqual(withCumulative([]), []);
  });

  it('measures the spread from the best ask to the best bid, and has none for a one-sided book', () => {
    const book = fixtureDepth();
    const spread = spreadOf(book);
    assert.ok(spread !== null);
    assert.ok(Math.abs(spread - (1.08432 - 1.0843)) < 1e-12);
    assert.equal(spreadOf({ ...book, bids: [] }), null);
    assert.equal(spreadOf({ ...book, asks: [] }), null);
  });

  it('draws at most ten levels a side, and the panel says how many it cut', () => {
    assert.equal(MAX_DEPTH_LEVELS, 10);
  });
});
