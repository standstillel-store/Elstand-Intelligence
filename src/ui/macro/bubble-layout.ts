import { niceTicks } from '../../core/ticks.js';
import {
  bubbleDirection,
  type BubbleDirection,
  type CurrencyMacroPoint,
} from '../../data/macro-bubbles.js';

/**
 * Layout for the macro bubble chart. Pure: it turns validated points and a pixel size into
 * positions, radii and axis ticks. The encoding is documented on the page and in
 * docs/MACRO-BUBBLES.md:
 *
 *   x      policy rate, percent
 *   y      year-on-year CPI inflation, percent
 *   size   radius = RADIUS_MIN + (radiusMax - RADIUS_MIN) * sqrt(|change| / largest |change|)
 *   color  direction of that change (always paired with a glyph)
 */

export const RADIUS_MIN = 5;

export interface AxisScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
  /** Pixel position of a value on this axis. */
  toPx(value: number): number;
}

export interface PlotBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface BubbleNode {
  readonly currency: string;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly direction: BubbleDirection;
  readonly point: CurrencyMacroPoint;
}

export interface BubbleLayout {
  readonly width: number;
  readonly height: number;
  readonly plot: PlotBox;
  readonly x: AxisScale;
  readonly y: AxisScale;
  /** Largest first, so small bubbles are drawn on top of large ones. */
  readonly nodes: readonly BubbleNode[];
  readonly maxAbsChange: number;
  readonly radiusMax: number;
}

const MARGIN = { top: 16, right: 20, bottom: 52, left: 60 } as const;

/**
 * Radius for a bubble: `RADIUS_MIN` plus the rest of the range scaled by the square root of
 * the change's share of the largest change, so area grows with `|change|`. The minimum keeps a
 * zero change visible, which means area is NOT strictly proportional to `|change|`; the page
 * and docs/MACRO-BUBBLES.md say so.
 */
export function bubbleRadius(absChange: number, maxAbsChange: number, radiusMax: number): number {
  if (!(maxAbsChange > 0) || !Number.isFinite(absChange)) return RADIUS_MIN;
  const share = Math.min(1, Math.max(0, absChange / maxAbsChange));
  return RADIUS_MIN + (radiusMax - RADIUS_MIN) * Math.sqrt(share);
}

function makeAxis(values: readonly number[], from: number, to: number): AxisScale {
  let low = Math.min(...values);
  let high = Math.max(...values);
  const span = high - low;
  const pad = span > 0 ? span * 0.14 : 1;
  low -= pad;
  high += pad;
  const { ticks } = niceTicks(low, high, 6);
  const min = low;
  const max = high;
  return {
    min,
    max,
    ticks,
    toPx: (value) => from + ((value - min) / (max - min)) * (to - from),
  };
}

/** Lays out the points; the caller guarantees at least one and that they passed validation. */
export function layoutBubbles(
  points: readonly CurrencyMacroPoint[],
  width: number,
  height: number,
): BubbleLayout {
  const plot: PlotBox = {
    left: MARGIN.left,
    top: MARGIN.top,
    right: Math.max(MARGIN.left + 40, width - MARGIN.right),
    bottom: Math.max(MARGIN.top + 40, height - MARGIN.bottom),
  };
  const x = makeAxis(
    points.map((point) => point.policyRate.value),
    plot.left,
    plot.right,
  );
  // Pixel y grows downwards, so the axis runs from the bottom edge to the top edge.
  const y = makeAxis(
    points.map((point) => point.cpiYoY.value),
    plot.bottom,
    plot.top,
  );
  const maxAbsChange = Math.max(0, ...points.map((point) => Math.abs(point.priceChange1m.value)));
  const radiusMax = Math.min(
    34,
    Math.max(14, Math.min(plot.right - plot.left, plot.bottom - plot.top) * 0.09),
  );
  const nodes = points
    .map(
      (point): BubbleNode => ({
        currency: point.currency.toUpperCase(),
        cx: x.toPx(point.policyRate.value),
        cy: y.toPx(point.cpiYoY.value),
        r: bubbleRadius(Math.abs(point.priceChange1m.value), maxAbsChange, radiusMax),
        direction: bubbleDirection(point.priceChange1m.value),
        point,
      }),
    )
    .sort((a, b) => b.r - a.r || a.currency.localeCompare(b.currency));
  return { width, height, plot, x, y, nodes, maxAbsChange, radiusMax };
}

export const DIRECTION_GLYPH: Readonly<Record<BubbleDirection, string>> = {
  up: '▲',
  down: '▼',
  flat: '–',
};

export const DIRECTION_WORD: Readonly<Record<BubbleDirection, string>> = {
  up: 'up',
  down: 'down',
  flat: 'flat',
};
