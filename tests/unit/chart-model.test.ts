import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VISIBLE_BARS,
  RIGHT_PAD_BARS,
  defaultViewport,
  isFollowingLatest,
  viewportWidth,
  visibleRange,
} from '../../src/ui/chart/geometry.js';
import {
  NO_CANDLES,
  clearHover,
  emptyModel,
  hoverBar,
  hoverIndexOf,
  jumpHover,
  pageBars,
  panModel,
  resetView,
  setViewport,
  stepHover,
  withDefaultBars,
  withSeries,
  zoomAnchor,
  zoomModel,
  type ChartModel,
  type ChartSelection,
} from '../../src/ui/chart/model.js';
import { FIXTURE_NOW, fixtureCandles } from '../support/fixtures.js';

const HOUR = 3_600_000;
const EURUSD_H1: ChartSelection = { instrumentId: 'EURUSD', timeframe: 'H1' };
const EURUSD_H4: ChartSelection = { instrumentId: 'EURUSD', timeframe: 'H4' };

const loaded = (count = 300, selection = EURUSD_H1): ChartModel =>
  withSeries(emptyModel(), selection, fixtureCandles(count, selection.timeframe));

describe('chart model: installing a series', () => {
  it('starts empty, with nothing hovered', () => {
    const model = emptyModel();
    assert.equal(model.selection, null);
    assert.equal(model.candles, NO_CANDLES);
    assert.equal(hoverIndexOf(model), null);
  });

  it('shows the newest bars of a fresh series, following the newest bar', () => {
    const model = loaded(300);
    assert.equal(isFollowingLatest(model.viewport, 300), true);
    assert.deepEqual(visibleRange(model.viewport, 300)?.last, 299);
  });

  it('returns the same object when asked to install what it already has', () => {
    const model = loaded(300);
    assert.equal(withSeries(model, { ...EURUSD_H1 }, model.candles), model);
  });

  it('keeps a following view following when a new bar arrives', () => {
    const model = loaded(300);
    const next = fixtureCandles(300, 'H1', FIXTURE_NOW + HOUR);
    const after = withSeries(model, EURUSD_H1, next);
    assert.equal(isFollowingLatest(after.viewport, 300), true);
    assert.equal(viewportWidth(after.viewport), viewportWidth(model.viewport));
  });

  it('keeps the same bars on screen when the user has panned back and a new bar arrives', () => {
    const first = fixtureCandles(300, 'H1', FIXTURE_NOW);
    const panned = panModel(withSeries(emptyModel(), EURUSD_H1, first), -50);
    assert.equal(isFollowingLatest(panned.viewport, 300), false);
    const leftEdge = first[visibleRange(panned.viewport, 300)?.first ?? 0];

    // The provider returns "the latest 300 bars", so the oldest bar drops off.
    const next = fixtureCandles(300, 'H1', FIXTURE_NOW + HOUR);
    const after = withSeries(panned, EURUSD_H1, next);
    const leftAfter = next[visibleRange(after.viewport, 300)?.first ?? 0];
    assert.equal(leftAfter?.time, leftEdge?.time);
  });

  it('starts fresh for a different selection and drops the crosshair', () => {
    const hovered = hoverBar(panModel(loaded(300), -40), 100, 50);
    assert.notEqual(hoverIndexOf(hovered), null);
    const other = withSeries(hovered, EURUSD_H4, fixtureCandles(300, 'H4'));
    assert.equal(other.selection, EURUSD_H4);
    assert.equal(other.hoverTime, null);
    assert.deepEqual(other.viewport, defaultViewport(300));
  });

  it('keeps the crosshair on the same bar across a refresh, and drops it if the bar is gone', () => {
    const first = fixtureCandles(300, 'H1', FIXTURE_NOW);
    const model = hoverBar(withSeries(emptyModel(), EURUSD_H1, first), 200, 80);
    const hoveredTime = first[200]?.time;

    const next = fixtureCandles(300, 'H1', FIXTURE_NOW + HOUR);
    const after = withSeries(model, EURUSD_H1, next);
    assert.equal(after.hoverTime, hoveredTime);
    assert.equal(after.hoverY, 80);
    assert.equal(
      next[hoverIndexOf(after) ?? -1]?.time,
      hoveredTime,
      'the index moved with the data',
    );

    const gone = hoverBar(withSeries(emptyModel(), EURUSD_H1, first), 0, 80);
    const muchLater = fixtureCandles(300, 'H1', FIXTURE_NOW + 10 * HOUR);
    assert.equal(withSeries(gone, EURUSD_H1, muchLater).hoverTime, null);
  });

  it('empties the view when the series becomes empty', () => {
    const after = withSeries(loaded(300), EURUSD_H1, NO_CANDLES);
    assert.equal(after.candles.length, 0);
    assert.deepEqual(after.viewport, defaultViewport(0));
    assert.equal(after.hoverTime, null);
  });
});

describe('chart model: default view width', () => {
  it('starts at the standard default and shows that many bars of a long series', () => {
    assert.equal(emptyModel().defaultBars, DEFAULT_VISIBLE_BARS);
    assert.equal(viewportWidth(loaded(500).viewport), DEFAULT_VISIBLE_BARS);
  });

  it('moves an untouched view to the new default when the screen narrows or widens', () => {
    const wide = loaded(500);
    const narrow = withDefaultBars(wide, 40);
    assert.equal(narrow.defaultBars, 40);
    assert.equal(viewportWidth(narrow.viewport), 40);
    assert.equal(isFollowingLatest(narrow.viewport, 500), true);
    const wideAgain = withDefaultBars(narrow, DEFAULT_VISIBLE_BARS);
    assert.deepEqual(wideAgain.viewport, wide.viewport);
  });

  it('leaves a view the user changed alone', () => {
    const panned = panModel(loaded(500), -30);
    const after = withDefaultBars(panned, 40);
    assert.equal(after.defaultBars, 40);
    assert.deepEqual(after.viewport, panned.viewport);
    // ...but Reset now goes to the new default.
    assert.equal(viewportWidth(resetView(after).viewport), 40);
  });

  it('returns the same object when the default is unchanged', () => {
    const model = loaded(500);
    assert.equal(withDefaultBars(model, model.defaultBars), model);
  });

  it('applies the default to a series that arrives after the screen was measured', () => {
    const measured = withDefaultBars(emptyModel(), 40);
    const model = withSeries(measured, EURUSD_H1, fixtureCandles(500, 'H1'));
    assert.equal(viewportWidth(model.viewport), 40);
  });
});

describe('chart model: crosshair', () => {
  it('puts the crosshair on a bar by index and clears it for an index with no bar', () => {
    const model = loaded(50);
    const hovered = hoverBar(model, 10, 33);
    assert.equal(hoverIndexOf(hovered), 10);
    assert.equal(hovered.hoverY, 33);
    assert.equal(hoverIndexOf(hoverBar(hovered, 50, null)), null);
    assert.equal(hoverIndexOf(hoverBar(hovered, -1, null)), null);
  });

  it('returns the same object when nothing changes', () => {
    const model = loaded(50);
    assert.equal(clearHover(model), model);
    const hovered = hoverBar(model, 10, 33);
    assert.equal(hoverBar(hovered, 10, 33), hovered);
    assert.notEqual(hoverBar(hovered, 10, 34), hovered);
  });

  it('steps from the newest visible bar on the first press, then by the given amount', () => {
    const model = loaded(300);
    const first = stepHover(model, -1);
    assert.equal(hoverIndexOf(first), 299, 'the first press lands on the newest bar');
    const second = stepHover(first, -1);
    assert.equal(hoverIndexOf(second), 298);
    assert.equal(hoverIndexOf(stepHover(second, -10)), 288);
    assert.equal(hoverIndexOf(stepHover(second, 1)), 299);
  });

  it('starts from the newest bar that is on screen when the view is panned back', () => {
    const panned = panModel(loaded(300), -100);
    const visible = visibleRange(panned.viewport, 300);
    assert.equal(hoverIndexOf(stepHover(panned, 1)), visible?.last);
  });

  it('stops at the first and last bars', () => {
    const model = loaded(20);
    assert.equal(hoverIndexOf(stepHover(hoverBar(model, 0, null), -5)), 0);
    assert.equal(hoverIndexOf(stepHover(hoverBar(model, 19, null), 5)), 19);
  });

  it('pans the view when the crosshair walks off the edge', () => {
    const panned = panModel(loaded(300), -100);
    const visible = visibleRange(panned.viewport, 300);
    const edge = hoverBar(panned, visible?.first ?? 0, null);
    const stepped = stepHover(edge, -1);
    const after = hoverIndexOf(stepped) ?? -1;
    assert.equal(after, (visible?.first ?? 0) - 1);
    assert.ok(stepped.viewport.from <= after, 'the bar is back in view');
    assert.equal(viewportWidth(stepped.viewport), viewportWidth(panned.viewport));
  });

  it('does nothing without bars', () => {
    const model = emptyModel();
    assert.equal(stepHover(model, 1), model);
    assert.equal(jumpHover(model, 'first'), model);
    assert.equal(jumpHover(model, 'last'), model);
  });

  it('jumps to the oldest or newest bar', () => {
    const model = panModel(loaded(300), -60);
    const last = jumpHover(model, 'last');
    assert.equal(hoverIndexOf(last), 299);
    assert.equal(isFollowingLatest(last.viewport, 300), true);
    assert.equal(viewportWidth(last.viewport), viewportWidth(model.viewport), 'zoom is kept');

    const first = jumpHover(last, 'first');
    assert.equal(hoverIndexOf(first), 0);
    assert.ok(first.viewport.from <= 0);
  });
});

describe('chart model: view', () => {
  it('pans and zooms, and returns the same object for a move that changes nothing', () => {
    const model = loaded(300);
    const moved = panModel(model, -20);
    assert.notEqual(moved, model);
    assert.equal(panModel(model, 0), model);
    const pinned = panModel(model, 1_000_000);
    assert.equal(panModel(pinned, 1_000_000), pinned, 'already at the right limit');

    const zoomed = zoomModel(model, 250, 2);
    assert.equal(viewportWidth(zoomed.viewport) > viewportWidth(model.viewport), true);
    assert.equal(zoomModel(zoomed, 250, 1), zoomed);
  });

  it('resets to the default view, following the newest bar', () => {
    const model = zoomModel(panModel(loaded(300), -80), 200, 0.5);
    const reset = resetView(model);
    assert.deepEqual(reset.viewport, defaultViewport(300));
    assert.equal(resetView(reset), reset);
  });

  it('sets an absolute window within the limits, for drag and pinch', () => {
    const model = loaded(300);
    const set = setViewport(model, { from: -5_000, to: -4_950 });
    assert.ok(set.viewport.to >= 2, 'at least two bars stay on screen');
    assert.equal(setViewport(model, model.viewport), model);
  });

  it('zooms around the crosshair bar when there is one, otherwise around the middle', () => {
    const model = loaded(300);
    const middle = (model.viewport.from + model.viewport.to) / 2;
    assert.equal(zoomAnchor(model), middle);
    assert.equal(zoomAnchor(hoverBar(model, 250, null)), 250.5);
  });

  it('pages by most of a screen', () => {
    const model = loaded(300);
    assert.equal(pageBars(model), Math.floor(viewportWidth(model.viewport) * 0.8));
    assert.ok(pageBars(loaded(3)) >= 1);
  });

  it('keeps the right margin of the default view', () => {
    const model = loaded(300);
    assert.equal(model.viewport.to, 300 + RIGHT_PAD_BARS);
  });
});
