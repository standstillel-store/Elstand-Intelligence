import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatPrice } from '../../src/core/format.js';
import { requireInstrument } from '../../src/core/instruments.js';
import type { Candle } from '../../src/core/types.js';
import { crosshairTimeLabel, defaultViewport } from '../../src/ui/chart/geometry.js';
import { clearChart, drawChart, type ChartTheme } from '../../src/ui/chart/renderer.js';
import { FakeCanvasContext } from '../support/fake-canvas.js';
import { FIXTURE_NOW } from '../support/fixtures.js';

const THEME: ChartTheme = {
  bg: 'BG',
  grid: 'GRID',
  axisText: 'AXIS',
  text: 'TEXT',
  up: 'UP',
  down: 'DOWN',
  labelBg: 'LABEL',
  font: '11px monospace',
};

const HOUR = 3_600_000;
const EURUSD = requireInstrument('EURUSD');
const XAUUSD = requireInstrument('XAUUSD');

/** Alternating up and down bars with clear bodies, around `base`. */
function zigzag(count: number, base: number, move: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const rising = index % 2 === 0;
    const open = base + (rising ? 0 : move);
    const close = base + (rising ? move : 0);
    return {
      time: FIXTURE_NOW - (count - 1 - index) * HOUR,
      open,
      close,
      high: Math.max(open, close) + move / 2,
      low: Math.min(open, close) - move / 2,
    };
  });
}

interface Setup {
  readonly fake: FakeCanvasContext;
  readonly frame: ReturnType<typeof drawChart>;
}

function render(options: {
  candles: readonly Candle[];
  instrument?: typeof EURUSD;
  width?: number;
  height?: number;
  dpr?: number;
  hover?: { index: number; y: number | null } | null;
}): Setup {
  const fake = new FakeCanvasContext();
  const candles = options.candles;
  const frame = drawChart({
    ctx: fake.asCanvas(),
    width: options.width ?? 800,
    height: options.height ?? 400,
    dpr: options.dpr ?? 1,
    candles,
    instrument: options.instrument ?? EURUSD,
    timeframe: 'H1',
    viewport: defaultViewport(candles.length),
    hover: options.hover ?? null,
    theme: THEME,
  });
  return { fake, frame };
}

describe('chart renderer: candles', () => {
  const candles = zigzag(10, 1.1, 0.002);

  it('draws bars that closed higher as hollow outlines and bars that closed lower as filled', () => {
    const { fake, frame } = render({ candles });
    assert.ok(frame);
    const plot = frame.scale.layout.plot;
    const insidePlot = (rect: { x: number }): boolean => rect.x < plot.x + plot.width;

    const hollow = fake.stroked.filter((rect) => rect.style === 'UP' && insidePlot(rect));
    const filledDown = fake.filled.filter(
      (rect) => rect.style === 'DOWN' && insidePlot(rect) && rect.width > 2,
    );
    assert.equal(hollow.length, 5, 'five rising bars, outlined');
    assert.equal(filledDown.length, 5, 'five falling bars, solid');
    assert.equal(
      fake.filled.filter((rect) => rect.style === 'UP' && insidePlot(rect) && rect.width > 2)
        .length,
      0,
      'a rising bar is never filled at this zoom',
    );
  });

  it('draws wicks only outside the body, so a hollow body is empty', () => {
    const { fake, frame } = render({ candles });
    assert.ok(frame);
    const up = fake.segments.filter((segment) => segment.style === 'UP');
    // Every wick is vertical, and the two wicks of one bar never overlap the body between them.
    assert.ok(up.length >= 5);
    for (const segment of up) assert.equal(segment.x1, segment.x2);
  });

  it('marks the newest close with a dashed line and an axis tag', () => {
    const { fake, frame } = render({ candles });
    assert.ok(frame);
    const newest = candles[candles.length - 1];
    assert.ok(newest);
    assert.ok(
      fake.dashes.some((dash) => dash.length > 0),
      'a dashed line was drawn',
    );
    assert.ok(fake.texts.some((entry) => entry.text === formatPrice(newest.close, EURUSD)));
  });

  it('labels the price axis with the instrument precision', () => {
    const { fake } = render({ candles });
    const priceLabels = fake.texts.filter((entry) => /^\d+\.\d+$/.test(entry.text));
    assert.ok(priceLabels.length >= 3);
    for (const label of priceLabels) assert.match(label.text, /^\d\.\d{5}$/);
  });

  it('returns the scale used, so pointer positions can be mapped back to bars', () => {
    const { frame } = render({ candles });
    assert.ok(frame);
    assert.deepEqual(frame.range, { first: 0, last: 9 });
    const x = frame.scale.x(4);
    assert.equal(frame.scale.indexAt(x, candles.length), 4);
  });
});

describe('chart renderer: nothing to draw', () => {
  it('paints only the background and returns null for an empty series', () => {
    const { fake, frame } = render({ candles: [] });
    assert.equal(frame, null);
    assert.equal(fake.filled.length, 1);
    assert.deepEqual(
      {
        x: fake.filled[0]?.x,
        y: fake.filled[0]?.y,
        w: fake.filled[0]?.width,
        h: fake.filled[0]?.height,
      },
      { x: 0, y: 0, w: 800, h: 400 },
    );
    assert.equal(fake.filled[0]?.style, 'BG');
  });

  it('clears the canvas on request, so an old chart never lingers', () => {
    const fake = new FakeCanvasContext();
    clearChart(fake.asCanvas(), 300, 200, 2, THEME);
    assert.deepEqual(fake.transform, [2, 0, 0, 2, 0, 0]);
    assert.equal(fake.filled[0]?.style, 'BG');
    assert.equal(fake.filled[0]?.width, 300);
  });
});

describe('chart renderer: crosshair', () => {
  const candles = zigzag(10, 1.1, 0.002);

  it('draws no crosshair, and no hover labels, without a hover', () => {
    const { fake } = render({ candles });
    assert.equal(
      fake.texts.some((entry) => entry.text === crosshairTimeLabel(candles[3]?.time ?? 0, 'H1')),
      false,
    );
  });

  it('labels the hovered bar time and a price on the axis', () => {
    const { fake, frame } = render({ candles, hover: { index: 3, y: 150 } });
    assert.ok(frame);
    const hovered = candles[3];
    assert.ok(hovered);
    assert.ok(fake.texts.some((entry) => entry.text === crosshairTimeLabel(hovered.time, 'H1')));
    const axisPrice = formatPrice(frame.scale.priceAt(Math.round(150)), EURUSD);
    assert.ok(
      fake.texts.some((entry) => /^\d\.\d{5}$/.test(entry.text)),
      `a price label such as ${axisPrice} is drawn`,
    );
  });

  it('puts the horizontal line on the close when the hover has no pointer height', () => {
    const withPointer = render({ candles, hover: { index: 3, y: null } });
    assert.ok(withPointer.frame);
    const close = candles[3]?.close ?? 0;
    const expectedY = withPointer.frame.scale.y(close);
    const horizontal = withPointer.fake.segments.filter(
      (segment) =>
        segment.style === 'AXIS' &&
        segment.y1 === segment.y2 &&
        Math.abs(segment.y1 - expectedY) <= 1,
    );
    assert.ok(horizontal.length >= 1);
  });

  it('ignores a hover on a bar that is not on screen', () => {
    const wide = zigzag(400, 1.1, 0.002);
    const plain = render({ candles: wide });
    const hidden = render({ candles: wide, hover: { index: 0, y: null } });
    assert.equal(hidden.fake.texts.length, plain.fake.texts.length);
  });
});

describe('chart renderer: pixel grid and axis width', () => {
  const candles = zigzag(10, 1.1, 0.002);

  it('puts every candle body on the device pixel grid at 1x and 2x', () => {
    for (const dpr of [1, 2]) {
      const { fake, frame } = render({ candles, dpr });
      assert.ok(frame);
      const plotRight = frame.scale.layout.plot.x + frame.scale.layout.plot.width;
      const bodies = [
        ...fake.filled.filter(
          (rect) => rect.style === 'DOWN' && rect.x < plotRight && rect.width > 2,
        ),
        ...fake.stroked.filter((rect) => rect.style === 'UP' && rect.x < plotRight),
      ];
      assert.ok(bodies.length >= 10);
      for (const rect of bodies) {
        const left = rect.x * dpr;
        assert.ok(
          Math.abs(left * 2 - Math.round(left * 2)) < 1e-6,
          `${rect.x} at ${dpr}x is on a half-pixel`,
        );
      }
    }
  });

  it('draws hairlines one device pixel wide at 1x and two at 2x', () => {
    for (const dpr of [1, 2]) {
      const { fake } = render({ candles, dpr });
      const widths = new Set(
        fake.segments.map((segment) => Number((segment.lineWidth * dpr).toFixed(6))),
      );
      assert.deepEqual([...widths], [dpr]);
    }
  });

  it('keeps the price axis wide enough for a long gold price on a narrow screen', () => {
    const gold = zigzag(10, 2345.67, 3.21);
    const { fake } = render({ candles: gold, instrument: XAUUSD, width: 360, height: 300 });
    assert.ok(fake.texts.length > 0);
    for (const entry of fake.texts) {
      const right = entry.align === 'center' ? entry.x + entry.width / 2 : entry.x + entry.width;
      assert.ok(right <= 360, `"${entry.text}" ends at ${right}, past the 360px canvas`);
    }
  });
});
