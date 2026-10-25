import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../../core/types.js';
import { niceTicks, type Ticks } from '../../core/ticks.js';

/**
 * Pure chart geometry: no DOM, no canvas. Bars live in "bar space": bar `i` occupies
 * `[i, i + 1)` and is drawn centered at `i + 0.5`. The viewport is a real-valued window onto
 * that space, so panning and zooming are smooth and never snap to whole bars.
 */

export interface Viewport {
  readonly from: number;
  readonly to: number;
}

export const MIN_VISIBLE_BARS = 8;
export const DEFAULT_VISIBLE_BARS = 120;
/** Empty bar-widths kept to the right of the newest bar so it is not glued to the axis. */
export const RIGHT_PAD_BARS = 4;
/** At least this many bars always stay in view, so the chart can never be panned empty. */
const KEEP_BARS = 2;

export function viewportWidth(viewport: Viewport): number {
  return viewport.to - viewport.from;
}

export function defaultViewport(total: number, maxBars: number = DEFAULT_VISIBLE_BARS): Viewport {
  const cap = Math.max(MIN_VISIBLE_BARS, maxBars);
  // A short series fits whole, with its right margin; a long one shows its newest bars.
  const width = Math.min(Math.max(total + RIGHT_PAD_BARS, MIN_VISIBLE_BARS), cap);
  const to = Math.max(total, 0) + RIGHT_PAD_BARS;
  return { from: to - width, to };
}

/** Pixels each bar slot gets in the default view, so candles stay legible on a narrow screen. */
export const TARGET_BAR_SLOT_PX = 6;

/** How many bars the default view should show for a plot this wide. */
export function defaultBarsFor(plotWidthPx: number): number {
  const fit = Math.floor(plotWidthPx / TARGET_BAR_SLOT_PX);
  return Math.min(DEFAULT_VISIBLE_BARS, Math.max(MIN_VISIBLE_BARS, fit));
}

export function maxVisibleBars(total: number): number {
  return Math.max(MIN_VISIBLE_BARS, total * 1.25);
}

export function clampViewport(viewport: Viewport, total: number): Viewport {
  const width = Math.min(
    Math.max(viewportWidth(viewport), MIN_VISIBLE_BARS),
    maxVisibleBars(total),
  );
  const keep = Math.min(KEEP_BARS, Math.max(total, 1));
  const from = Math.min(Math.max(viewport.from, keep - width), Math.max(total, 1) - keep);
  return { from, to: from + width };
}

export function panBy(viewport: Viewport, deltaBars: number, total: number): Viewport {
  return clampViewport({ from: viewport.from + deltaBars, to: viewport.to + deltaBars }, total);
}

/** Zooms by `factor` (above 1 shows more bars) keeping bar-space position `anchor` fixed. */
export function zoomAt(
  viewport: Viewport,
  anchor: number,
  factor: number,
  total: number,
): Viewport {
  const width = viewportWidth(viewport);
  const nextWidth = Math.min(Math.max(width * factor, MIN_VISIBLE_BARS), maxVisibleBars(total));
  const ratio = width === 0 ? 0.5 : (anchor - viewport.from) / width;
  const from = anchor - ratio * nextWidth;
  return clampViewport({ from, to: from + nextWidth }, total);
}

/** True when the newest bar is in view with its right margin, i.e. the chart follows live data. */
export function isFollowingLatest(viewport: Viewport, total: number): boolean {
  return viewport.to >= total + RIGHT_PAD_BARS - 0.5;
}

/** Index of the bar that opened exactly at `time`, or -1. `candles` must be ascending by time. */
export function indexOfTime(candles: readonly Candle[], time: number): number {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = candles[mid]?.time;
    if (value === undefined) return -1;
    if (value === time) return mid;
    if (value < time) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** Pans the least amount needed to bring bar `index` fully into view. */
export function revealIndex(viewport: Viewport, index: number, total: number): Viewport {
  if (index < viewport.from) return panBy(viewport, index - viewport.from, total);
  if (index + 1 > viewport.to) return panBy(viewport, index + 1 - viewport.to, total);
  return viewport;
}

/**
 * Keeps the same bars on screen when a refreshed series replaces the old one. Providers return
 * "the latest N bars", so a new bar also drops the oldest and every index shifts by one: the
 * windows are matched by bar open time, never by index. A viewport that was following the
 * newest bar keeps following it.
 */
export function remapViewport(
  previous: readonly Candle[],
  next: readonly Candle[],
  viewport: Viewport,
  defaultBars: number = DEFAULT_VISIBLE_BARS,
): Viewport {
  if (next.length === 0) return defaultViewport(0, defaultBars);
  if (previous.length === 0) return defaultViewport(next.length, defaultBars);
  if (isFollowingLatest(viewport, previous.length)) {
    const width = viewportWidth(viewport);
    const to = next.length + RIGHT_PAD_BARS;
    return clampViewport({ from: to - width, to }, next.length);
  }
  const indexByTime = new Map<number, number>();
  next.forEach((candle, index) => indexByTime.set(candle.time, index));
  for (let k = 0; k < previous.length; k += 1) {
    const old = previous[k];
    const found = old === undefined ? undefined : indexByTime.get(old.time);
    if (found !== undefined) {
      const shift = found - k;
      return clampViewport({ from: viewport.from + shift, to: viewport.to + shift }, next.length);
    }
  }
  return defaultViewport(next.length, defaultBars);
}

export interface VisibleRange {
  readonly first: number;
  readonly last: number;
}

/** Indexes of the first and last bars that intersect the viewport, or null if none do. */
export function visibleRange(viewport: Viewport, total: number): VisibleRange | null {
  if (total === 0) return null;
  const first = Math.max(0, Math.floor(viewport.from));
  const last = Math.min(total - 1, Math.ceil(viewport.to) - 1);
  return first > last ? null : { first, last };
}

export interface PriceRange {
  readonly min: number;
  readonly max: number;
}

/** Low and high over a span of bars, with 6% headroom; a flat span still gets a visible height. */
export function priceRange(candles: readonly Candle[], range: VisibleRange): PriceRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = range.first; index <= range.last; index += 1) {
    const candle = candles[index];
    if (candle === undefined) continue;
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) {
    const spread = Math.max(Math.abs(max) * 0.001, 1e-9);
    return { min: min - spread, max: max + spread };
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

export { niceTicks };
export type { Ticks };

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly plot: Rect;
}

const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 24;
const MARGIN_LEFT = 8;

/** Plot area inside the canvas, leaving room for the price axis on the right and time axis below. */
export function createLayout(width: number, height: number, priceAxisWidth: number): Layout {
  const plotWidth = Math.max(1, width - MARGIN_LEFT - priceAxisWidth);
  const plotHeight = Math.max(1, height - MARGIN_TOP - MARGIN_BOTTOM);
  return {
    width,
    height,
    plot: { x: MARGIN_LEFT, y: MARGIN_TOP, width: plotWidth, height: plotHeight },
  };
}

export interface Scale {
  readonly layout: Layout;
  readonly viewport: Viewport;
  readonly prices: PriceRange;
  /** Pixel width of one bar slot. */
  readonly barWidth: number;
  x(index: number): number;
  y(price: number): number;
  /** Bar-space position (real-valued) under a pixel x. */
  barSpaceAt(x: number): number;
  /** Nearest bar index under a pixel x, clamped to `[0, total - 1]`. */
  indexAt(x: number, total: number): number;
  priceAt(y: number): number;
}

export function createScale(layout: Layout, viewport: Viewport, prices: PriceRange): Scale {
  const { plot } = layout;
  const span = viewportWidth(viewport);
  const barWidth = plot.width / span;
  const priceSpan = prices.max - prices.min;
  return {
    layout,
    viewport,
    prices,
    barWidth,
    x: (index) => plot.x + (index + 0.5 - viewport.from) * barWidth,
    y: (price) => plot.y + (1 - (price - prices.min) / priceSpan) * plot.height,
    barSpaceAt: (x) => viewport.from + (x - plot.x) / barWidth,
    indexAt: (x, total) =>
      Math.min(
        Math.max(Math.floor(viewport.from + (x - plot.x) / barWidth), 0),
        Math.max(total - 1, 0),
      ),
    priceAt: (y) => prices.min + (1 - (y - plot.y) / plot.height) * priceSpan,
  };
}

/** Candle body width in pixels: 70% of the slot, never thicker than 24px, never thinner than 1px. */
export function bodyWidth(barWidth: number): number {
  return Math.min(24, Math.max(1, Math.floor(barWidth * 0.7)));
}

export interface TimeTick {
  readonly index: number;
  readonly label: string;
  /** A tick at a day boundary, drawn emphasized with its date. */
  readonly major: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Bucket {
  /** Nominal length in ms, used only to estimate label spacing. */
  readonly nominalMs: number;
  /** Which bucket a bar open time falls in; a label goes on the first bar of each bucket. */
  readonly key: (timeMs: number) => number;
  /** True for buckets of a day or more, labeled with dates instead of clock times. */
  readonly calendar: boolean;
}

function monthKey(timeMs: number): number {
  const date = new Date(timeMs);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function quarterKey(timeMs: number): number {
  const date = new Date(timeMs);
  return date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
}

const fixedBucket = (ms: number): Bucket => ({
  nominalMs: ms,
  key: (timeMs) => Math.floor(timeMs / ms),
  calendar: ms >= DAY,
});

const BUCKETS: readonly Bucket[] = [
  fixedBucket(5 * MINUTE),
  fixedBucket(15 * MINUTE),
  fixedBucket(30 * MINUTE),
  fixedBucket(HOUR),
  fixedBucket(2 * HOUR),
  fixedBucket(3 * HOUR),
  fixedBucket(4 * HOUR),
  fixedBucket(6 * HOUR),
  fixedBucket(12 * HOUR),
  fixedBucket(DAY),
  fixedBucket(2 * DAY),
  // 1970-01-01 was a Thursday, so Monday-based weeks start 4 days after the epoch.
  {
    nominalMs: 7 * DAY,
    key: (timeMs) => Math.floor((timeMs - 4 * DAY) / (7 * DAY)),
    calendar: true,
  },
  { nominalMs: 30.4 * DAY, key: monthKey, calendar: true },
  { nominalMs: 91 * DAY, key: quarterKey, calendar: true },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function dayLabel(timeMs: number): string {
  const date = new Date(timeMs);
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''}`;
}

function monthLabel(timeMs: number): string {
  const date = new Date(timeMs);
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return date.getUTCMonth() === 0 ? `${date.getUTCFullYear()}` : month;
}

function clockLabel(timeMs: number): string {
  const date = new Date(timeMs);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

const dayNumber = (timeMs: number): number => Math.floor(timeMs / DAY);

/**
 * Time-axis labels on the first bar of each round UTC bucket (hour, 4 hours, day, week,
 * month...), with the bucket chosen so neighbors are at least `minSpacingPx` apart. The text
 * is always the true open time of the bar it sits on, so a market-closed gap never produces
 * a label for a time that has no bar. Day changes are labeled with their date.
 */
export function timeTicks(
  candles: readonly Candle[],
  range: VisibleRange,
  timeframe: Timeframe,
  barWidthPx: number,
  minSpacingPx: number,
): TimeTick[] {
  const barMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const bucket =
    BUCKETS.find(
      (candidate) =>
        candidate.nominalMs >= barMs && (candidate.nominalMs / barMs) * barWidthPx >= minSpacingPx,
    ) ??
    BUCKETS[BUCKETS.length - 1] ??
    fixedBucket(DAY);
  const ticks: TimeTick[] = [];
  let lastLabeled = Number.NEGATIVE_INFINITY;
  for (let index = range.first; index <= range.last; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    // The first bar of the whole series is never labeled: nothing before it shows whether it
    // starts a bucket, and a date label there would imply a boundary that may not exist.
    if (candle === undefined || previous === undefined) continue;
    if (bucket.key(previous.time) === bucket.key(candle.time)) continue;
    if ((index - lastLabeled) * barWidthPx < minSpacingPx) continue;
    if (bucket.calendar) {
      const monthly = bucket.nominalMs >= 28 * DAY;
      ticks.push({
        index,
        label: monthly ? monthLabel(candle.time) : dayLabel(candle.time),
        major: monthly && new Date(candle.time).getUTCMonth() === 0,
      });
    } else {
      const newDay = dayNumber(previous.time) !== dayNumber(candle.time);
      ticks.push({
        index,
        label: newDay ? dayLabel(candle.time) : clockLabel(candle.time),
        major: newDay,
      });
    }
    lastLabeled = index;
  }
  return ticks;
}

/** Full crosshair time label: date and time, or date only for daily bars. */
export function crosshairTimeLabel(timeMs: number, timeframe: Timeframe): string {
  const iso = new Date(timeMs).toISOString();
  return timeframe === 'D1' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
