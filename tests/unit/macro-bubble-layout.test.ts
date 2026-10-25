import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CurrencyMacroPoint } from '../../src/data/macro-bubbles.js';
import {
  bubbleRadius,
  DIRECTION_GLYPH,
  DIRECTION_WORD,
  layoutBubbles,
  RADIUS_MIN,
} from '../../src/ui/macro/bubble-layout.js';
import { fixtureBubblePoints } from '../support/fixtures.js';

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);
}

/** The fixture point for a currency with some values replaced. */
function pointWith(
  currency: string,
  values: { rate?: number; cpi?: number; change?: number },
): CurrencyMacroPoint {
  const [template] = fixtureBubblePoints();
  assert.ok(template !== undefined);
  return {
    ...template,
    currency,
    policyRate: { ...template.policyRate, value: values.rate ?? template.policyRate.value },
    cpiYoY: { ...template.cpiYoY, value: values.cpi ?? template.cpiYoY.value },
    priceChange1m: {
      ...template.priceChange1m,
      value: values.change ?? template.priceChange1m.value,
    },
  };
}

describe('bubbleRadius', () => {
  it('is the minimum for no change and the maximum for the largest change', () => {
    assert.equal(bubbleRadius(0, 3, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(3, 3, 34), 34);
  });

  it('scales with the square root of the share, so the area grows with the change', () => {
    near(bubbleRadius(0.75, 3, 34), RADIUS_MIN + (34 - RADIUS_MIN) * 0.5);
    let previousArea = -1;
    for (let step = 0; step <= 30; step += 1) {
      const radius = bubbleRadius(step / 10, 3, 34);
      const area = Math.PI * radius * radius;
      assert.ok(area > previousArea, `area did not grow at ${step / 10}`);
      previousArea = area;
    }
  });

  it('is not strictly area-proportional, because of the minimum radius, and the page says so', () => {
    const quarter = bubbleRadius(0.75, 3, 34);
    const full = bubbleRadius(3, 3, 34);
    const areaShare = (quarter * quarter) / (full * full);
    assert.ok(Math.abs(areaShare - 0.25) > 0.05, `area share ${areaShare} would be proportional`);
  });

  it('uses the minimum when there is no usable largest change or the change is not a number', () => {
    assert.equal(bubbleRadius(2, 0, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(2, -1, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(2, Number.NaN, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(Number.NaN, 3, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(Number.POSITIVE_INFINITY, 3, 34), RADIUS_MIN);
  });

  it('never exceeds the maximum, even for a change larger than the stated largest', () => {
    assert.equal(bubbleRadius(10, 3, 34), 34);
  });
});

describe('layoutBubbles', () => {
  const points = fixtureBubblePoints();
  const layout = layoutBubbles(points, 800, 500);

  it('has the plot box inside fixed margins', () => {
    assert.deepEqual(layout.plot, { left: 60, top: 16, right: 780, bottom: 448 });
    assert.equal(layout.width, 800);
    assert.equal(layout.height, 500);
  });

  it('has exactly one bubble per currency, named in capitals', () => {
    assert.equal(layout.nodes.length, points.length);
    assert.deepEqual(layout.nodes.map((node) => node.currency).sort(), [
      'AUD',
      'EUR',
      'GBP',
      'JPY',
      'USD',
    ]);
    const lower = layoutBubbles([pointWith('eur', {})], 800, 500);
    assert.equal(lower.nodes[0]?.currency, 'EUR');
  });

  it('puts the larger policy rate further right and the higher inflation higher up the screen', () => {
    const byCode = new Map(layout.nodes.map((node) => [node.currency, node]));
    const jpy = byCode.get('JPY');
    const gbp = byCode.get('GBP');
    const eur = byCode.get('EUR');
    const aud = byCode.get('AUD');
    assert.ok(jpy !== undefined && gbp !== undefined && eur !== undefined && aud !== undefined);
    assert.ok(jpy.cx < eur.cx && eur.cx < aud.cx && aud.cx < gbp.cx, 'x follows the policy rate');
    assert.ok(
      aud.cy < gbp.cy && gbp.cy < jpy.cy && jpy.cy < eur.cy,
      'y runs the other way: higher CPI is higher up',
    );
  });

  it('keeps every bubble centre inside the plot box', () => {
    for (const node of layout.nodes) {
      assert.ok(node.cx >= layout.plot.left && node.cx <= layout.plot.right, node.currency);
      assert.ok(node.cy >= layout.plot.top && node.cy <= layout.plot.bottom, node.currency);
    }
  });

  it('pads each axis beyond the data, so no bubble sits on the frame, and maps the ends to the box edges', () => {
    const rates = points.map((point) => point.policyRate.value);
    const inflation = points.map((point) => point.cpiYoY.value);
    assert.ok(layout.x.min < Math.min(...rates) && layout.x.max > Math.max(...rates));
    assert.ok(layout.y.min < Math.min(...inflation) && layout.y.max > Math.max(...inflation));
    near(layout.x.toPx(layout.x.min), layout.plot.left);
    near(layout.x.toPx(layout.x.max), layout.plot.right);
    near(layout.y.toPx(layout.y.min), layout.plot.bottom);
    near(layout.y.toPx(layout.y.max), layout.plot.top);
  });

  it('offers ascending round ticks inside each axis', () => {
    for (const axis of [layout.x, layout.y]) {
      assert.ok(axis.ticks.length >= 2);
      axis.ticks.forEach((tick, index) => {
        assert.ok(
          tick >= axis.min - 1e-9 && tick <= axis.max + 1e-9,
          `tick ${tick} outside the axis`,
        );
        if (index > 0) assert.ok(tick > (axis.ticks[index - 1] ?? Number.POSITIVE_INFINITY));
      });
    }
  });

  it('sizes the bubbles by the absolute one-month change, with the direction from its sign', () => {
    const byCode = new Map(layout.nodes.map((node) => [node.currency, node]));
    assert.equal(layout.maxAbsChange, 3.2);
    assert.equal(byCode.get('JPY')?.r, layout.radiusMax, 'the largest move is the largest bubble');
    assert.equal(byCode.get('USD')?.r, RADIUS_MIN, 'no move is the smallest bubble');
    assert.equal(byCode.get('JPY')?.direction, 'down');
    assert.equal(byCode.get('EUR')?.direction, 'up');
    assert.equal(byCode.get('AUD')?.direction, 'down');
    assert.equal(byCode.get('GBP')?.direction, 'up');
    assert.equal(byCode.get('USD')?.direction, 'flat');
    // A fall of 0.9 and a rise of 0.9 are the same size.
    const mirrored = layoutBubbles(
      [pointWith('AUD', { change: -0.9 }), pointWith('NZD', { change: 0.9 })],
      800,
      500,
    );
    assert.equal(mirrored.nodes[0]?.r, mirrored.nodes[1]?.r);
  });

  it('lists the largest bubble first, so a small one is drawn on top of a large one, and breaks ties by code', () => {
    const radii = layout.nodes.map((node) => node.r);
    radii.forEach((radius, index) => {
      if (index > 0) assert.ok(radius <= (radii[index - 1] ?? Number.POSITIVE_INFINITY));
    });
    const tied = layoutBubbles(
      [
        pointWith('NZD', { rate: 1, cpi: 1, change: 1 }),
        pointWith('AUD', { rate: 2, cpi: 2, change: -1 }),
        pointWith('CAD', { rate: 3, cpi: 3, change: 1 }),
      ],
      800,
      500,
    );
    assert.deepEqual(
      tied.nodes.map((node) => node.currency),
      ['AUD', 'CAD', 'NZD'],
    );
  });

  it('keeps the original point with each bubble, so the detail shows the real values and sources', () => {
    for (const node of layout.nodes) {
      assert.equal(node.point.currency.toUpperCase(), node.currency);
      assert.ok(points.includes(node.point));
    }
  });

  it('keeps the maximum radius between 14 and 34 pixels whatever the size of the view', () => {
    assert.equal(layoutBubbles(points, 3000, 2000).radiusMax, 34);
    assert.equal(layoutBubbles(points, 200, 200).radiusMax, 14);
    const middle = layoutBubbles(points, 500, 350).radiusMax;
    assert.ok(middle > 14 && middle < 34, `${middle}`);
  });

  it('keeps a usable plot box even in a tiny view', () => {
    const tiny = layoutBubbles(points, 50, 40);
    assert.ok(tiny.plot.right - tiny.plot.left >= 40);
    assert.ok(tiny.plot.bottom - tiny.plot.top >= 40);
    for (const node of tiny.nodes)
      assert.ok(Number.isFinite(node.cx) && Number.isFinite(node.cy) && Number.isFinite(node.r));
  });

  it('draws every currency at the minimum size, and flat, when none of them moved', () => {
    const still = layoutBubbles(
      [pointWith('USD', { change: 0 }), pointWith('EUR', { rate: 2, change: 0 })],
      800,
      500,
    );
    assert.equal(still.maxAbsChange, 0);
    for (const node of still.nodes) {
      assert.equal(node.r, RADIUS_MIN);
      assert.equal(node.direction, 'flat');
    }
  });

  it('centres a single currency instead of dividing by zero', () => {
    const single = layoutBubbles([pointWith('USD', { rate: 4.5, cpi: 3.1, change: 1 })], 800, 500);
    const [node] = single.nodes;
    assert.ok(node !== undefined);
    near(node.cx, (single.plot.left + single.plot.right) / 2);
    near(node.cy, (single.plot.top + single.plot.bottom) / 2);
    assert.ok(Number.isFinite(single.x.min) && single.x.max > single.x.min);
  });

  it('is deterministic and does not modify the points it is given', () => {
    const frozen = Object.freeze(points.map((point) => Object.freeze({ ...point })));
    assert.deepEqual(
      layoutBubbles(frozen, 800, 500).nodes.map((node) => [
        node.currency,
        node.cx,
        node.cy,
        node.r,
      ]),
      layout.nodes.map((node) => [node.currency, node.cx, node.cy, node.r]),
    );
  });
});

describe('direction marks', () => {
  it('pair every direction with its own glyph and word, so color is never the only signal', () => {
    assert.deepEqual(DIRECTION_WORD, { up: 'up', down: 'down', flat: 'flat' });
    assert.equal(new Set(Object.values(DIRECTION_GLYPH)).size, 3);
    for (const glyph of Object.values(DIRECTION_GLYPH)) assert.ok(glyph.length > 0);
  });
});
