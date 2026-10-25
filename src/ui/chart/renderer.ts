import { formatPrice } from '../../core/format.js';
import type { Instrument } from '../../core/instruments.js';
import type { Candle, Timeframe } from '../../core/types.js';
import {
  bodyWidth,
  createLayout,
  createScale,
  crosshairTimeLabel,
  niceTicks,
  priceRange,
  timeTicks,
  visibleRange,
  type Scale,
  type Viewport,
  type VisibleRange,
} from './geometry.js';

export interface ChartTheme {
  readonly bg: string;
  readonly grid: string;
  readonly axisText: string;
  readonly text: string;
  readonly up: string;
  readonly down: string;
  readonly labelBg: string;
  readonly font: string;
}

/** Colors come from the CSS tokens, so the stylesheet stays the single source of truth. */
export function readChartTheme(element: Element): ChartTheme {
  const css = getComputedStyle(element);
  const read = (name: string): string => {
    const value = css.getPropertyValue(name).trim();
    if (value === '') throw new Error(`The stylesheet does not define ${name}.`);
    return value;
  };
  return {
    bg: read('--bg'),
    grid: read('--border'),
    axisText: read('--text-2'),
    text: read('--text'),
    up: read('--green-muted'),
    down: read('--down'),
    labelBg: read('--surface-2'),
    font: `11px ${read('--font-mono')}`,
  };
}

export interface HoverState {
  readonly index: number;
  /** Pointer height in CSS pixels, or null to sit the horizontal line on the bar's close. */
  readonly y: number | null;
}

export interface FrameInput {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly candles: readonly Candle[];
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly viewport: Viewport;
  readonly hover: HoverState | null;
  readonly theme: ChartTheme;
}

export interface Frame {
  readonly scale: Scale;
  readonly range: VisibleRange;
}

const MIN_LABEL_SPACING_PX = 84;
const TAG_HEIGHT = 18;

/** Paints the empty background. Used when there is nothing to draw, so old pixels never linger. */
export function clearChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  theme: ChartTheme,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draws one frame and returns the scale it used (for hit-testing), or null when there is
 * nothing to draw.
 *
 * Candle convention: a bar that closed above its open is hollow and one that closed below is
 * filled, so direction never depends on telling green from red apart. Hairlines are one device
 * pixel wide at 1x and snap to the pixel grid at any display ratio.
 */
export function drawChart(input: FrameInput): Frame | null {
  const { ctx, width, height, dpr, candles, instrument, timeframe, viewport, hover, theme } = input;
  clearChart(ctx, width, height, dpr, theme);

  const range = visibleRange(viewport, candles.length);
  const newest = candles[candles.length - 1];
  if (range === null || newest === undefined) return null;
  const prices = priceRange(candles, range);
  if (prices === null) return null;

  // The price axis is as wide as its widest label, so a long gold price is never clipped.
  ctx.font = theme.font;
  const widestLabel = Math.max(
    ctx.measureText(formatPrice(prices.min, instrument)).width,
    ctx.measureText(formatPrice(prices.max, instrument)).width,
    ctx.measureText(formatPrice(newest.close, instrument)).width,
  );
  const axisWidth = Math.min(Math.ceil(widestLabel) + 22, Math.max(40, Math.floor(width / 3)));
  const layout = createLayout(width, height, axisWidth);
  const scale = createScale(layout, viewport, prices);
  const { plot } = layout;
  const plotRight = plot.x + plot.width;
  const plotBottom = plot.y + plot.height;

  const deviceLine = Math.max(1, Math.round(dpr));
  const line = deviceLine / dpr;
  const gridOffset = (deviceLine % 2) / 2;
  const crisp = (value: number): number =>
    (Math.round(value * dpr - gridOffset) + gridOffset) / dpr;
  const snap = (value: number): number => Math.round(value * dpr) / dpr;
  const segment = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const directionColor = (candle: Candle): string =>
    candle.close > candle.open
      ? theme.up
      : candle.close < candle.open
        ? theme.down
        : theme.axisText;

  /** A label box on the price axis, with optional outline. */
  const axisTag = (
    text: string,
    y: number,
    fill: string,
    ink: string,
    edge: string | null,
  ): void => {
    const boxWidth = ctx.measureText(text).width + 10;
    const left = plotRight + 2;
    ctx.fillStyle = fill;
    ctx.fillRect(left, y - TAG_HEIGHT / 2, boxWidth, TAG_HEIGHT);
    if (edge !== null) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = line;
      ctx.strokeRect(
        left + line / 2,
        y - TAG_HEIGHT / 2 + line / 2,
        boxWidth - line,
        TAG_HEIGHT - line,
      );
    }
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 5, y);
  };

  ctx.lineWidth = line;
  ctx.textBaseline = 'middle';

  // ---- grid and axis labels ---------------------------------------------------------------
  const priceGrid = niceTicks(prices.min, prices.max, Math.max(3, Math.floor(plot.height / 56)));
  ctx.textAlign = 'left';
  for (const tick of priceGrid.ticks) {
    const y = crisp(scale.y(tick));
    if (y < plot.y || y > plotBottom) continue;
    ctx.strokeStyle = theme.grid;
    segment(plot.x, y, plotRight, y);
    ctx.fillStyle = theme.axisText;
    ctx.fillText(formatPrice(tick, instrument), plotRight + 8, y);
  }
  ctx.textAlign = 'center';
  for (const tick of timeTicks(candles, range, timeframe, scale.barWidth, MIN_LABEL_SPACING_PX)) {
    const x = crisp(scale.x(tick.index));
    ctx.strokeStyle = theme.grid;
    segment(x, plot.y, x, plotBottom);
    ctx.fillStyle = tick.major ? theme.text : theme.axisText;
    ctx.fillText(tick.label, x, plotBottom + 14);
  }

  // ---- hovered bar column -----------------------------------------------------------------
  if (hover !== null && hover.index >= range.first && hover.index <= range.last) {
    ctx.fillStyle = theme.labelBg;
    const left = Math.max(plot.x, plot.x + (hover.index - viewport.from) * scale.barWidth);
    const right = Math.min(plotRight, plot.x + (hover.index + 1 - viewport.from) * scale.barWidth);
    ctx.fillRect(left, plot.y, Math.max(0, right - left), plot.height);
  }

  // ---- candles (clipped to the plot) ------------------------------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.width, plot.height);
  ctx.clip();
  const bodyDeviceRaw = Math.max(1, Math.round(bodyWidth(scale.barWidth) * dpr));
  // Match the body's pixel parity to the wick's, so the wick sits exactly in the body's middle.
  const bodyDevice = bodyDeviceRaw % 2 === deviceLine % 2 ? bodyDeviceRaw : bodyDeviceRaw + 1;
  const bodyPx = bodyDevice / dpr;
  for (let index = range.first; index <= range.last; index += 1) {
    const candle = candles[index];
    if (candle === undefined) continue;
    const color = directionColor(candle);
    const cx = crisp(scale.x(index));
    const top = snap(Math.min(scale.y(candle.open), scale.y(candle.close)));
    const bottom = snap(Math.max(scale.y(candle.open), scale.y(candle.close)));
    const bodyHeight = Math.max(line, bottom - top);
    const left = cx - bodyPx / 2;

    // Wicks stop at the body, so a hollow body really is empty.
    ctx.strokeStyle = color;
    const highY = scale.y(candle.high);
    const lowY = scale.y(candle.low);
    if (top > highY) segment(cx, highY, cx, top);
    if (lowY > bottom) segment(cx, bottom, cx, lowY);

    const rising = candle.close > candle.open;
    const hollow = rising && bodyDevice >= 4 && bodyHeight >= 3 * line;
    if (hollow) {
      ctx.lineWidth = line;
      ctx.strokeRect(left + line / 2, top + line / 2, bodyPx - line, bodyHeight - line);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(left, top, bodyPx, bodyHeight);
    }
  }
  ctx.restore();

  // ---- newest close -----------------------------------------------------------------------
  const lastY = crisp(scale.y(newest.close));
  if (lastY >= plot.y && lastY <= plotBottom) {
    const color = directionColor(newest);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.setLineDash([2, 3]);
    segment(plot.x, lastY, plotRight, lastY);
    ctx.restore();
    axisTag(formatPrice(newest.close, instrument), lastY, theme.labelBg, theme.text, color);
  }

  // ---- crosshair --------------------------------------------------------------------------
  const hovered = hover === null ? undefined : candles[hover.index];
  if (
    hover !== null &&
    hovered !== undefined &&
    hover.index >= range.first &&
    hover.index <= range.last
  ) {
    const x = crisp(scale.x(hover.index));
    const rawY = hover.y ?? scale.y(hovered.close);
    const y = crisp(Math.min(Math.max(rawY, plot.y), plotBottom));
    ctx.save();
    ctx.strokeStyle = theme.axisText;
    ctx.lineWidth = line;
    ctx.globalAlpha = 0.7;
    segment(x, plot.y, x, plotBottom);
    segment(plot.x, y, plotRight, y);
    ctx.restore();

    axisTag(formatPrice(scale.priceAt(y), instrument), y, theme.axisText, theme.bg, null);

    const timeText = crosshairTimeLabel(hovered.time, timeframe);
    const timeWidth = ctx.measureText(timeText).width + 12;
    const timeLeft = Math.min(Math.max(x - timeWidth / 2, plot.x), width - timeWidth);
    ctx.fillStyle = theme.axisText;
    ctx.fillRect(timeLeft, plotBottom + 3, timeWidth, TAG_HEIGHT);
    ctx.fillStyle = theme.bg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeText, timeLeft + timeWidth / 2, plotBottom + 3 + TAG_HEIGHT / 2);
  }

  return { scale, range };
}
