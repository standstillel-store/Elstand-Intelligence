import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Candle } from '../../src/core/types.js';
import {
  DEFAULT_VISIBLE_BARS,
  MIN_VISIBLE_BARS,
  RIGHT_PAD_BARS,
  TARGET_BAR_SLOT_PX,
  bodyWidth,
  clampViewport,
  createLayout,
  createScale,
  crosshairTimeLabel,
  defaultBarsFor,
  defaultViewport,
  indexOfTime,
  isFollowingLatest,
  maxVisibleBars,
  niceTicks,
  panBy,
  priceRange,
  remapViewport,
  revealIndex,
  timeTicks,
  viewportWidth,
  visibleRange,
  zoomAt,
} from '../../src/ui/chart/geometry.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';

const close = (a: number, b: number, tolerance = 1e-9): void =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

describe('chart geometry: viewport', () => {
  it('shows the latest bars with a right margin', () => {
    const view = defaultViewport(500);
    assert.equal(viewportWidth(view), DEFAULT_VISIBLE_BARS);
    assert.equal(view.to, 500 + RIGHT_PAD_BARS);
  });

  it('shows a short series whole, including its first bar', () => {
    for (const total of [10, 50, 116]) {
      const view = defaultViewport(total);
      assert.equal(view.from, 0, `${total} bars start at the left edge`);
      assert.equal(view.to, total + RIGHT_PAD_BARS);
      assert.deepEqual(visibleRange(view, total), { first: 0, last: total - 1 });
    }
    // A long series shows only its newest bars.
    const long = defaultViewport(500);
    assert.deepEqual(visibleRange(long, 500), { first: 384, last: 499 });
  });

  it('shows fewer bars by default on a narrow plot, but never below the minimum or above the default', () => {
    assert.equal(defaultBarsFor(1000), DEFAULT_VISIBLE_BARS);
    assert.equal(defaultBarsFor(300), Math.floor(300 / TARGET_BAR_SLOT_PX));
    assert.equal(defaultBarsFor(20), MIN_VISIBLE_BARS);
    const narrow = defaultViewport(500, 50);
    assert.equal(viewportWidth(narrow), 50);
    assert.equal(narrow.to, 500 + RIGHT_PAD_BARS);
    assert.equal(
      viewportWidth(defaultViewport(500, 3)),
      MIN_VISIBLE_BARS,
      'a tiny cap is raised to the minimum',
    );
    assert.equal(
      viewportWidth(defaultViewport(20, 50)),
      20 + RIGHT_PAD_BARS,
      'a short series still fits whole',
    );
  });

  it('never shows fewer than the minimum number of bars, even for a short series', () => {
    assert.equal(viewportWidth(defaultViewport(3)), MIN_VISIBLE_BARS);
    assert.equal(viewportWidth(defaultViewport(0)), MIN_VISIBLE_BARS);
  });

  it('clamps width and keeps data in view', () => {
    const tooNarrow = clampViewport({ from: 10, to: 12 }, 100);
    assert.equal(viewportWidth(tooNarrow), MIN_VISIBLE_BARS);
    const tooWide = clampViewport({ from: 0, to: 10_000 }, 100);
    assert.equal(viewportWidth(tooWide), maxVisibleBars(100));
    const farRight = clampViewport({ from: 5_000, to: 5_050 }, 100);
    assert.ok(farRight.from <= 98, 'at least two bars stay visible on the left');
    const farLeft = clampViewport({ from: -5_000, to: -4_950 }, 100);
    assert.ok(farLeft.to >= 2, 'at least two bars stay visible on the right');
  });

  it('pans by whole or fractional bars and respects the clamp', () => {
    const start = defaultViewport(500);
    const moved = panBy(start, -10.5, 500);
    close(moved.from, start.from - 10.5);
    close(viewportWidth(moved), viewportWidth(start));
    const absurd = panBy(start, 1_000_000, 500);
    assert.ok(absurd.from <= 498);
  });

  it('zooms around an anchor without moving the anchor', () => {
    const view = { from: 100, to: 200 };
    const anchor = 150;
    const zoomedIn = zoomAt(view, anchor, 0.5, 500);
    close(viewportWidth(zoomedIn), 50);
    close((anchor - zoomedIn.from) / viewportWidth(zoomedIn), 0.5);
    const edgeAnchor = zoomAt(view, 120, 2, 500);
    close((120 - edgeAnchor.from) / viewportWidth(edgeAnchor), 0.2);
  });

  it('cannot zoom in past the minimum or out past the series', () => {
    const tiny = zoomAt({ from: 100, to: 120 }, 110, 0.001, 500);
    assert.equal(viewportWidth(tiny), MIN_VISIBLE_BARS);
    const huge = zoomAt({ from: 0, to: 300 }, 150, 1000, 500);
    assert.equal(viewportWidth(huge), maxVisibleBars(500));
  });

  it('knows when the chart is following the newest bar', () => {
    assert.equal(isFollowingLatest(defaultViewport(500), 500), true);
    assert.equal(isFollowingLatest(panBy(defaultViewport(500), -30, 500), 500), false);
  });
});

describe('chart geometry: remapViewport after a refresh', () => {
  const series = (count: number, endOffsetBars = 0): Candle[] =>
    fixtureCandles(count, 'H1', FIXTURE_NOW + endOffsetBars * 3_600_000);

  it('keeps following the newest bar when a new bar arrives', () => {
    const before = series(200);
    const after = series(200, 1); // provider returns the latest 200: one dropped, one added
    const next = remapViewport(before, after, defaultViewport(200));
    assert.equal(isFollowingLatest(next, 200), true);
    close(viewportWidth(next), DEFAULT_VISIBLE_BARS);
  });

  it('keeps the same bars on screen for a chart the user has panned away from the end', () => {
    const before = series(200);
    const view = panBy(defaultViewport(200), -50, 200);
    const firstVisibleTime = before[Math.ceil(view.from)]?.time;
    const after = series(200, 3); // three new bars, three oldest dropped
    const next = remapViewport(before, after, view);
    const shownTime = after[Math.ceil(next.from)]?.time;
    assert.equal(shownTime, firstVisibleTime, 'the left edge still shows the same bar');
    assert.equal(isFollowingLatest(next, 200), false);
  });

  it('falls back to the default view when nothing lines up, and handles empty series', () => {
    const before = series(50);
    const after = fixtureCandles(50, 'H1', FIXTURE_NOW + 1_000 * 3_600_000);
    const view = panBy(defaultViewport(50), -10, 50);
    assert.deepEqual(remapViewport(before, after, view), defaultViewport(50));
    assert.deepEqual(remapViewport(before, [], view), defaultViewport(0));
    assert.deepEqual(remapViewport([], after, view), defaultViewport(50));
  });
});

describe('chart geometry: ranges and ticks', () => {
  const bars: Candle[] = [
    { time: 1, open: 10, high: 12, low: 9, close: 11 },
    { time: 2, open: 11, high: 15, low: 10, close: 14 },
    { time: 3, open: 14, high: 14.5, low: 8, close: 9 },
  ];

  it('finds the visible bars, or none', () => {
    assert.deepEqual(visibleRange({ from: 0, to: 3 }, 3), { first: 0, last: 2 });
    assert.deepEqual(visibleRange({ from: 0.5, to: 1.5 }, 3), { first: 0, last: 1 });
    assert.deepEqual(visibleRange({ from: -5, to: 100 }, 3), { first: 0, last: 2 });
    assert.equal(visibleRange({ from: 10, to: 20 }, 3), null);
    assert.equal(visibleRange({ from: 0, to: 3 }, 0), null);
  });

  it('adds headroom to the price range and gives a flat series a height', () => {
    const range = priceRange(bars, { first: 0, last: 2 });
    assert.ok(range !== null);
    close(range.min, 8 - 7 * 0.06);
    close(range.max, 15 + 7 * 0.06);
    const flat = priceRange([{ time: 1, open: 5, high: 5, low: 5, close: 5 }], {
      first: 0,
      last: 0,
    });
    assert.ok(flat !== null && flat.max > flat.min);
    assert.equal(priceRange(bars, { first: 5, last: 9 }), null);
  });

  it('produces round ticks without floating-point residue', () => {
    const { ticks, step } = niceTicks(0, 1, 6);
    assert.equal(step, 0.2);
    assert.deepEqual(ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
    const fx = niceTicks(1.0801, 1.0859, 5);
    assert.ok(fx.ticks.every((tick) => tick >= 1.0801 && tick <= 1.0859));
    assert.ok(fx.ticks.every((tick) => Number(tick.toFixed(6)) === tick));
    assert.ok(fx.ticks.length >= 3 && fx.ticks.length <= 8);
    assert.deepEqual(niceTicks(5, 5, 5).ticks, []);
    assert.deepEqual(niceTicks(0, 1, 1).ticks, []);
  });
});

describe('chart geometry: scale', () => {
  const layout = createLayout(800, 400, 64);
  const view = { from: 0, to: 100 };
  const scale = createScale(layout, view, { min: 1, max: 2 });

  it('places the plot inside the canvas, leaving room for the axes', () => {
    assert.equal(layout.plot.x, 8);
    assert.equal(layout.plot.width, 800 - 8 - 64);
    assert.equal(layout.plot.height, 400 - 8 - 24);
  });

  it('maps bar index and price to pixels and back', () => {
    close(scale.barWidth, layout.plot.width / 100);
    close(scale.x(0), layout.plot.x + scale.barWidth / 2);
    close(scale.y(2), layout.plot.y);
    close(scale.y(1), layout.plot.y + layout.plot.height);
    close(scale.priceAt(scale.y(1.37)), 1.37, 1e-9);
    assert.equal(scale.indexAt(scale.x(42), 100), 42);
    assert.equal(scale.indexAt(-1000, 100), 0, 'clamped on the left');
    assert.equal(scale.indexAt(10_000, 100), 99, 'clamped on the right');
    close(scale.barSpaceAt(scale.x(10)), 10.5);
  });

  it('keeps candle bodies between 1 and 24 pixels', () => {
    assert.equal(bodyWidth(0.5), 1);
    assert.equal(bodyWidth(10), 7);
    assert.equal(bodyWidth(500), 24);
  });
});

describe('chart geometry: time axis', () => {
  const candles = fixtureCandles(48, 'H1');
  const range = { first: 0, last: candles.length - 1 };

  it('labels round UTC times, with dates at day changes', () => {
    const ticks = timeTicks(candles, range, 'H1', 20, 90);
    assert.ok(ticks.length >= 4);
    for (const tick of ticks) {
      const bar = candles[tick.index];
      assert.ok(bar !== undefined);
      const hour = new Date(bar.time).getUTCHours();
      assert.equal(hour % 6, 0, 'six-hour buckets at this zoom');
      const label = tick.major ? /^\d{2} [A-Z][a-z]{2}$/ : /^\d{2}:\d{2}$/;
      assert.match(tick.label, label);
      assert.equal(tick.major, hour === 0);
    }
  });

  it('keeps neighbors at least the minimum spacing apart', () => {
    for (const spacing of [60, 90, 140]) {
      const ticks = timeTicks(candles, range, 'H1', 20, spacing);
      for (let i = 1; i < ticks.length; i += 1) {
        const a = ticks[i - 1];
        const b = ticks[i];
        assert.ok(a !== undefined && b !== undefined && (b.index - a.index) * 20 >= spacing);
      }
    }
  });

  it('never labels the first bar of the series and ignores missing bars', () => {
    const ticks = timeTicks(candles, range, 'H1', 20, 90);
    assert.ok(ticks.every((tick) => tick.index > 0));
    // A weekend-like gap: drop 30 bars from the middle. Labels still sit on real bars.
    const gapped = [...candles.slice(0, 10), ...candles.slice(40)];
    const gappedTicks = timeTicks(gapped, { first: 0, last: gapped.length - 1 }, 'H1', 20, 90);
    assert.ok(gappedTicks.every((tick) => gapped[tick.index] !== undefined));
  });

  it('uses month labels for zoomed-out daily bars, with the year at January', () => {
    const daily: Candle[] = [];
    const start = Date.UTC(2025, 10, 3); // 3 Nov 2025
    for (let i = 0; i < 120; i += 1) {
      daily.push({ time: start + i * 86_400_000, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    const ticks = timeTicks(daily, { first: 0, last: 119 }, 'D1', 3, 70);
    const labels = ticks.map((tick) => tick.label);
    assert.ok(labels.includes('Dec'));
    assert.ok(labels.includes('2026'), 'January is labeled with the year');
    assert.ok(ticks.filter((tick) => tick.major).every((tick) => /^\d{4}$/.test(tick.label)));
  });

  it('formats the crosshair time label', () => {
    const t = Date.UTC(2026, 0, 6, 12, 5);
    assert.equal(crosshairTimeLabel(t, 'H1'), '2026-01-06 12:05');
    assert.equal(crosshairTimeLabel(t, 'D1'), '2026-01-06');
  });
});

describe('chart geometry: lookup and reveal', () => {
  const candles = fixtureCandles(50, 'H1');

  it('finds a bar by its exact open time', () => {
    for (const index of [0, 1, 24, 48, 49]) {
      assert.equal(indexOfTime(candles, candles[index]?.time ?? Number.NaN), index);
    }
  });

  it('returns -1 for a time with no bar, and for an empty series', () => {
    const first = candles[0]?.time ?? 0;
    assert.equal(indexOfTime(candles, first + 1), -1);
    assert.equal(indexOfTime(candles, first - 3_600_000), -1);
    assert.equal(indexOfTime([], first), -1);
  });

  it('pans only as far as needed to show a bar', () => {
    const view = { from: 10, to: 30 };
    assert.deepEqual(revealIndex(view, 15, 50), view, 'a visible bar changes nothing');
    const left = revealIndex(view, 4, 50);
    assert.equal(left.from, 4);
    close(viewportWidth(left), 20);
    const right = revealIndex(view, 35, 50);
    assert.equal(right.to, 36, 'the whole bar [35, 36) is in view');
    close(viewportWidth(right), 20);
  });
});
