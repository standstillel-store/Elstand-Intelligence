import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { volRange, type VolSurface } from '../../src/data/options.js';
import { rampColor, relativeLuminance } from '../../src/ui/macro/ramp.js';
import {
  buildMesh,
  DEFAULT_CAMERA,
  project,
  type Camera,
  type ExpirySpacing,
  type SurfaceMesh,
} from '../../src/ui/macro/projection.js';
import {
  drawSurface,
  formatIvTick,
  formatStrike,
  labelIndices,
  type SurfaceLabels,
  type SurfaceTheme,
} from '../../src/ui/macro/surface-render.js';
import { FakeCanvasContext } from '../support/fake-canvas.js';
import { fixtureSurface, fixtureSurfaceLarge } from '../support/fixtures.js';

const THEME: SurfaceTheme = {
  bg: 'BG',
  grid: 'GRID',
  axisText: 'AXIS',
  text: 'TEXT',
  highlight: 'HILITE',
  font: '11px monospace',
};

const VIEW = { width: 640, height: 420 } as const;

function labelsFor(surface: VolSurface): SurfaceLabels {
  return {
    strikeTitle: 'ln(K/F)',
    strikeKind: surface.strikeAxis.kind,
    strikeValues: surface.strikeAxis.values,
    expiryTitle: 'Expiry (days)',
    expiryDays: surface.expiriesDays,
    ivTitle: 'Implied vol (%)',
  };
}

interface Drawn {
  readonly fake: FakeCanvasContext;
  readonly mesh: SurfaceMesh;
  readonly surface: VolSurface;
  readonly frame: ReturnType<typeof drawSurface>;
  readonly camera: Camera;
}

function draw(
  options: {
    surface?: VolSurface;
    camera?: Camera;
    hover?: number;
    dpr?: number;
    spacing?: ExpirySpacing;
    view?: { width: number; height: number };
  } = {},
): Drawn {
  const surface = options.surface ?? fixtureSurface();
  const mesh = buildMesh(surface, volRange(surface), options.spacing ?? 'equal');
  const camera = options.camera ?? DEFAULT_CAMERA;
  const fake = new FakeCanvasContext();
  const frame = drawSurface({
    ctx: fake.asCanvas(),
    view: options.view ?? VIEW,
    dpr: options.dpr ?? 1,
    theme: THEME,
    mesh,
    camera,
    labels: labelsFor(surface),
    hover: options.hover ?? -1,
  });
  return { fake, mesh, surface, frame, camera };
}

/** Index of the vertex a polygon corner was drawn at, by exact position. */
function vertexIndexAt(drawn: Drawn, x: number, y: number): number {
  return drawn.frame.projected.findIndex((point) => point.sx === x && point.sy === y);
}

describe('labelIndices', () => {
  it('is empty for nothing to label', () => {
    assert.deepEqual(labelIndices(0), []);
    assert.deepEqual(labelIndices(-3), []);
  });

  it('labels every point when there are few enough', () => {
    assert.deepEqual(labelIndices(1), [0]);
    assert.deepEqual(labelIndices(5), [0, 1, 2, 3, 4]);
    assert.deepEqual(labelIndices(7), [0, 1, 2, 3, 4, 5, 6]);
  });

  it('thins a dense axis, keeping the first and the last', () => {
    assert.deepEqual(labelIndices(8), [0, 2, 4, 6, 7]);
    assert.deepEqual(labelIndices(13), [0, 2, 4, 6, 8, 10, 12]);
  });

  it('never exceeds the limit, always spans the axis, and always ascends', () => {
    for (const max of [2, 3, 5, 7, 10]) {
      for (let count = 1; count <= 300; count += 1) {
        const picked = labelIndices(count, max);
        assert.ok(
          picked.length <= Math.max(max, Math.min(count, max)),
          `count ${count} max ${max} gave ${picked.length}`,
        );
        assert.equal(picked[0], 0);
        assert.equal(picked[picked.length - 1], count - 1);
        picked.forEach((value, index) => {
          if (index > 0) assert.ok(value > (picked[index - 1] ?? -1));
        });
      }
    }
  });
});

describe('number labels', () => {
  it('prints strikes to four significant digits, without trailing zeros or float residue', () => {
    assert.equal(formatStrike(0.02), '0.02');
    assert.equal(formatStrike(-0.06), '-0.06');
    assert.equal(formatStrike(0), '0');
    assert.equal(formatStrike(0.1 + 0.2), '0.3');
    assert.equal(formatStrike(1234.5678), '1235');
    assert.equal(formatStrike(1.1), '1.1');
  });

  it('prints volatility ticks as percentages', () => {
    assert.equal(formatIvTick(9.5), '9.5%');
    assert.equal(formatIvTick(10), '10%');
    assert.equal(formatIvTick(8.0000000001), '8%');
  });
});

describe('drawSurface: one frame', () => {
  it('sets the device pixel ratio, then paints the background over the whole view first', () => {
    const { fake } = draw({ dpr: 2 });
    assert.deepEqual(fake.transform, [2, 0, 0, 2, 0, 0]);
    const first = fake.filled[0];
    assert.deepEqual(
      { x: first?.x, y: first?.y, width: first?.width, height: first?.height, style: first?.style },
      { x: 0, y: 0, width: VIEW.width, height: VIEW.height, style: 'BG' },
    );
  });

  it('returns one projected point per vertex, exactly where the camera puts it', () => {
    const drawn = draw();
    assert.equal(drawn.frame.projected.length, drawn.mesh.vertices.length);
    drawn.mesh.vertices.forEach((vertex, index) => {
      assert.deepEqual(drawn.frame.projected[index], project(vertex, drawn.camera, VIEW));
    });
  });

  it('paints one face per cell between measured points, and only measured points', () => {
    const drawn = draw();
    assert.equal(drawn.fake.polygons.length, (drawn.mesh.rows - 1) * (drawn.mesh.cols - 1));
    for (const polygon of drawn.fake.polygons) {
      assert.equal(polygon.points.length, 4);
      for (const point of polygon.points) {
        assert.ok(
          vertexIndexAt(drawn, point.x, point.y) >= 0,
          'a face corner that is not a measured vertex',
        );
      }
    }
  });

  it('colors each face by the mean volatility of its four corners, on the ramp', () => {
    const drawn = draw({ surface: fixtureSurfaceLarge() });
    const { mesh } = drawn;
    const { min, max } = mesh.range;
    for (const polygon of drawn.fake.polygons) {
      const indices = polygon.points.map((point) => vertexIndexAt(drawn, point.x, point.y));
      const rows = indices.map((index) => Math.floor(index / mesh.cols));
      const cols = indices.map((index) => index % mesh.cols);
      const row = Math.min(...rows);
      const col = Math.min(...cols);
      const corners = [
        mesh.iv[row * mesh.cols + col],
        mesh.iv[row * mesh.cols + col + 1],
        mesh.iv[(row + 1) * mesh.cols + col + 1],
        mesh.iv[(row + 1) * mesh.cols + col],
      ];
      const mean = corners.reduce<number>((sum, value) => sum + (value ?? 0), 0) / 4;
      assert.equal(polygon.style, rampColor((mean - min) / (max - min)));
    }
  });

  it('paints far faces before near ones, so near faces cover far ones', () => {
    for (const camera of [
      DEFAULT_CAMERA,
      { yaw: 2.2, pitch: 0.9, zoom: 1 },
      { yaw: -1.1, pitch: 0.3, zoom: 1.4 },
    ]) {
      const drawn = draw({ camera, surface: fixtureSurfaceLarge() });
      const depths = drawn.fake.polygons.map((polygon) => {
        const total = polygon.points.reduce(
          (sum, point) =>
            sum + (drawn.frame.projected[vertexIndexAt(drawn, point.x, point.y)]?.depth ?? 0),
          0,
        );
        return total / 4;
      });
      depths.forEach((depth, index) => {
        if (index > 0)
          assert.ok(
            depth >= (depths[index - 1] ?? Number.NEGATIVE_INFINITY) - 1e-9,
            `face ${index} out of order`,
          );
      });
    }
  });

  it('draws a higher volatility lighter than a lower one', () => {
    const drawn = draw({ surface: fixtureSurfaceLarge() });
    const { mesh } = drawn;
    const byMean = drawn.fake.polygons.map((polygon) => {
      const indices = polygon.points.map((point) => vertexIndexAt(drawn, point.x, point.y));
      const mean = indices.reduce((sum, index) => sum + (mesh.iv[index] ?? 0), 0) / 4;
      return { mean, luminance: relativeLuminance(polygon.style) };
    });
    byMean.sort((a, b) => a.mean - b.mean);
    byMean.forEach((entry, index) => {
      if (index > 0) assert.ok(entry.luminance >= (byMean[index - 1]?.luminance ?? 0) - 1e-9);
    });
    assert.ok((byMean[byMean.length - 1]?.luminance ?? 0) > (byMean[0]?.luminance ?? 1));
  });

  it('draws a flat surface in the middle of the ramp, not NaN and not the dark end', () => {
    const base = fixtureSurface();
    const flat: VolSurface = { ...base, iv: base.iv.map((row) => row.map(() => 9)) };
    const drawn = draw({ surface: flat });
    assert.ok(drawn.fake.polygons.length > 0);
    for (const polygon of drawn.fake.polygons) assert.equal(polygon.style, rampColor(0.5));
  });

  it('draws one gridline per axis tick on each of the two back walls, and a frame around the floor', () => {
    const drawn = draw();
    const { mesh, fake } = drawn;
    const grid = fake.segments.filter((segment) => segment.style === 'GRID').length;
    // Floor: one line per strike and per expiry. Each of two walls: a line per tick and one edge.
    // Plus the vertical edge at the back corner.
    assert.equal(grid, mesh.cols + mesh.rows + 2 * (mesh.axis.ticks.length + 1) + 1);
    assert.equal(fake.segments.filter((segment) => segment.style === 'AXIS').length, 4);
  });

  it('labels the strikes, the expiries and the volatility ticks, and titles all three axes', () => {
    const drawn = draw();
    const { mesh, surface, fake } = drawn;
    const texts = fake.texts.map((entry) => entry.text);

    const strikes = labelIndices(mesh.cols).map((index) =>
      formatStrike(surface.strikeAxis.values[index] ?? Number.NaN),
    );
    const expiries = labelIndices(mesh.rows).map(
      (index) => `${surface.expiriesDays[index] ?? ''}d`,
    );
    const ticks = mesh.axis.ticks.map(formatIvTick);
    for (const label of [...strikes, ...expiries, ...ticks]) {
      assert.ok(texts.includes(label), `missing label ${label}`);
    }
    for (const label of [...strikes, ...expiries, ...ticks]) {
      assert.equal(fake.texts.find((entry) => entry.text === label)?.style, 'AXIS', label);
    }

    const titles = fake.texts.filter((entry) => entry.style === 'TEXT').map((entry) => entry.text);
    assert.deepEqual(titles.sort(), ['Expiry (days)', 'Implied vol (%)', 'ln(K/F)']);
    assert.equal(fake.texts.length, strikes.length + expiries.length + ticks.length + 3);
  });

  it('thins the labels of a dense grid instead of printing every one', () => {
    const dense: VolSurface = {
      ...fixtureSurface(),
      strikeAxis: {
        kind: 'log-moneyness',
        label: 'ln(K/F)',
        values: Array.from({ length: 21 }, (_, i) => (i - 10) / 100),
      },
      expiriesDays: Array.from({ length: 12 }, (_, i) => (i + 1) * 15),
      iv: Array.from({ length: 12 }, (_, row) =>
        Array.from({ length: 21 }, (_, col) => 8 + row * 0.1 + Math.abs(col - 10) * 0.05),
      ),
    };
    const drawn = draw({ surface: dense });
    const strikeLabels = drawn.fake.texts.filter(
      (entry) => /^-?\d(\.\d+)?$/.test(entry.text) && entry.style === 'AXIS',
    );
    const expiryLabels = drawn.fake.texts.filter((entry) => /^\d+d$/.test(entry.text));
    assert.ok(strikeLabels.length <= 7, `${strikeLabels.length} strike labels`);
    assert.ok(expiryLabels.length <= 7, `${expiryLabels.length} expiry labels`);
    assert.ok(drawn.fake.polygons.length === 11 * 20, 'every cell is still drawn');
  });

  it('draws no hover ring without a hovered vertex, or for an index that does not exist', () => {
    assert.equal(draw({ hover: -1 }).fake.arcs.length, 0);
    assert.equal(draw({ hover: 9999 }).fake.arcs.length, 0);
  });

  it('rings the hovered vertex in the highlight color', () => {
    const drawn = draw({ hover: 7 });
    const target = drawn.frame.projected[7];
    assert.ok(target !== undefined);
    assert.deepEqual(drawn.fake.arcs, [
      { x: target.sx, y: target.sy, radius: 5, style: 'HILITE', lineWidth: 2 },
    ]);
  });

  it('only ever hands the context finite numbers, from any viewpoint and in any spacing', () => {
    for (const spacing of ['equal', 'calendar'] as const) {
      for (let turn = 0; turn < 12; turn += 1) {
        const camera: Camera = {
          yaw: (turn / 12) * Math.PI * 2 - Math.PI,
          pitch: 0.12 + (turn % 4) * 0.4,
          zoom: 0.5 + (turn % 3) * 1.2,
        };
        const { fake } = draw({ camera, spacing, hover: turn });
        const numbers = [
          ...fake.filled.flatMap((rect) => [rect.x, rect.y, rect.width, rect.height]),
          ...fake.segments.flatMap((segment) => [segment.x1, segment.y1, segment.x2, segment.y2]),
          ...fake.polygons.flatMap((polygon) =>
            polygon.points.flatMap((point) => [point.x, point.y]),
          ),
          ...fake.arcs.flatMap((arc) => [arc.x, arc.y, arc.radius]),
          ...fake.texts.flatMap((entry) => [entry.x, entry.y]),
        ];
        assert.ok(numbers.length > 100);
        assert.ok(
          numbers.every(Number.isFinite),
          `non-finite number, yaw ${camera.yaw} pitch ${camera.pitch}`,
        );
      }
    }
  });

  it('is deterministic: the same inputs draw the same picture', () => {
    const a = draw({ hover: 3 }).fake;
    const b = draw({ hover: 3 }).fake;
    assert.deepEqual(a.polygons, b.polygons);
    assert.deepEqual(a.segments, b.segments);
    assert.deepEqual(a.texts, b.texts);
    assert.deepEqual(a.arcs, b.arcs);
  });
});
