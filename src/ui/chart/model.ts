import type { Candle, Timeframe } from '../../core/types.js';
import {
  DEFAULT_VISIBLE_BARS,
  clampViewport,
  defaultViewport,
  indexOfTime,
  panBy,
  remapViewport,
  revealIndex,
  RIGHT_PAD_BARS,
  viewportWidth,
  visibleRange,
  zoomAt,
  type Viewport,
} from './geometry.js';

/**
 * Everything the chart remembers between frames, as plain immutable data. Each operation
 * returns the SAME object when nothing changed, so the panel can skip a redraw by identity.
 * No DOM here: this is what the unit tests exercise.
 */

export interface ChartSelection {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
}

export interface ChartModel {
  /** What the candles are for. Candles are never shown under any other selection. */
  readonly selection: ChartSelection | null;
  readonly candles: readonly Candle[];
  readonly viewport: Viewport;
  /** Open time of the bar under the crosshair. A time, not an index, so a refresh cannot move it. */
  readonly hoverTime: number | null;
  /** Pointer height in CSS pixels, or null to put the horizontal line on the bar's close. */
  readonly hoverY: number | null;
  /** How many bars the default view shows. Narrow screens show fewer, so candles stay legible. */
  readonly defaultBars: number;
}

export const NO_CANDLES: readonly Candle[] = [];

export function emptyModel(): ChartModel {
  return {
    selection: null,
    candles: NO_CANDLES,
    viewport: defaultViewport(0),
    hoverTime: null,
    hoverY: null,
    defaultBars: DEFAULT_VISIBLE_BARS,
  };
}

export function sameSelection(a: ChartSelection | null, b: ChartSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.instrumentId === b.instrumentId && a.timeframe === b.timeframe;
}

/**
 * Installs a series. For the same selection the window onto the data is kept (matched by bar
 * time, so a new bar does not shove the view); for a different selection it starts fresh.
 */
export function withSeries(
  model: ChartModel,
  selection: ChartSelection | null,
  candles: readonly Candle[],
): ChartModel {
  const same = sameSelection(model.selection, selection);
  if (same && model.candles === candles) return model;
  const viewport = same
    ? remapViewport(model.candles, candles, model.viewport, model.defaultBars)
    : defaultViewport(candles.length, model.defaultBars);
  const keepHover = same && model.hoverTime !== null && indexOfTime(candles, model.hoverTime) >= 0;
  return {
    selection,
    candles,
    viewport,
    hoverTime: keepHover ? model.hoverTime : null,
    hoverY: keepHover ? model.hoverY : null,
    defaultBars: model.defaultBars,
  };
}

/**
 * Changes how many bars the default view shows (the screen got wider or narrower). A view the
 * user has not touched follows the new default; a view they panned or zoomed is left alone.
 */
export function withDefaultBars(model: ChartModel, bars: number): ChartModel {
  if (bars === model.defaultBars) return model;
  const current = defaultViewport(model.candles.length, model.defaultBars);
  const untouched = current.from === model.viewport.from && current.to === model.viewport.to;
  return {
    ...model,
    defaultBars: bars,
    viewport: untouched ? defaultViewport(model.candles.length, bars) : model.viewport,
  };
}

export function hoverIndexOf(model: ChartModel): number | null {
  if (model.hoverTime === null) return null;
  const index = indexOfTime(model.candles, model.hoverTime);
  return index < 0 ? null : index;
}

export function clearHover(model: ChartModel): ChartModel {
  if (model.hoverTime === null && model.hoverY === null) return model;
  return { ...model, hoverTime: null, hoverY: null };
}

/** Puts the crosshair on bar `index`; an index with no bar clears it. */
export function hoverBar(model: ChartModel, index: number, y: number | null): ChartModel {
  const candle = model.candles[index];
  if (candle === undefined) return clearHover(model);
  if (model.hoverTime === candle.time && model.hoverY === y) return model;
  return { ...model, hoverTime: candle.time, hoverY: y };
}

function withViewport(model: ChartModel, viewport: Viewport): ChartModel {
  if (viewport.from === model.viewport.from && viewport.to === model.viewport.to) return model;
  return { ...model, viewport };
}

export function panModel(model: ChartModel, deltaBars: number): ChartModel {
  return withViewport(model, panBy(model.viewport, deltaBars, model.candles.length));
}

/** Sets an absolute window, for drag and pinch, which compute from where the gesture started. */
export function setViewport(model: ChartModel, viewport: Viewport): ChartModel {
  return withViewport(model, clampViewport(viewport, model.candles.length));
}

/** Zooms by `factor` (above 1 shows more bars) keeping bar-space position `anchor` fixed. */
export function zoomModel(model: ChartModel, anchor: number, factor: number): ChartModel {
  return withViewport(model, zoomAt(model.viewport, anchor, factor, model.candles.length));
}

/** Where keyboard and button zoom pivot: the crosshair bar if there is one, else the middle. */
export function zoomAnchor(model: ChartModel): number {
  const index = hoverIndexOf(model);
  return index === null ? (model.viewport.from + model.viewport.to) / 2 : index + 0.5;
}

/** Default zoom, following the newest bar. */
export function resetView(model: ChartModel): ChartModel {
  return withViewport(model, defaultViewport(model.candles.length, model.defaultBars));
}

/**
 * Keyboard crosshair. The first press lands on the newest visible bar; later presses step by
 * `delta` bars. The window pans just enough to keep the bar on screen.
 */
export function stepHover(model: ChartModel, delta: number): ChartModel {
  const total = model.candles.length;
  if (total === 0) return model;
  const current = hoverIndexOf(model);
  const visible = visibleRange(model.viewport, total);
  const target =
    current === null
      ? (visible?.last ?? total - 1)
      : Math.min(total - 1, Math.max(0, current + delta));
  const candle = model.candles[target];
  if (candle === undefined) return model;
  return {
    ...model,
    viewport: revealIndex(model.viewport, target, total),
    hoverTime: candle.time,
    hoverY: null,
  };
}

/** Crosshair to the oldest or newest loaded bar, bringing it into view at the current zoom. */
export function jumpHover(model: ChartModel, edge: 'first' | 'last'): ChartModel {
  const total = model.candles.length;
  const candle = edge === 'first' ? model.candles[0] : model.candles[total - 1];
  if (candle === undefined) return model;
  const width = viewportWidth(model.viewport);
  const viewport =
    edge === 'first'
      ? revealIndex(model.viewport, 0, total)
      : clampViewport({ from: total + RIGHT_PAD_BARS - width, to: total + RIGHT_PAD_BARS }, total);
  return { ...model, viewport, hoverTime: candle.time, hoverY: null };
}

/** Bars to move for PageUp / PageDown: most of a screen, never less than one bar. */
export function pageBars(model: ChartModel): number {
  return Math.max(1, Math.floor(viewportWidth(model.viewport) * 0.8));
}
