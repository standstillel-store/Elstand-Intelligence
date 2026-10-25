import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { volRange } from '../../src/data/options.js';
import {
  axisPositions,
  BOX_HEIGHT,
  buildMesh,
  clampCamera,
  DEFAULT_CAMERA,
  fitScale,
  ivAxis,
  ivFraction,
  nearestVertex,
  PITCH_MAX,
  PITCH_MIN,
  project,
  quadsOf,
  rotateCamera,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomCamera,
  type Camera,
  type Projected,
  type Vec3,
} from '../../src/ui/macro/projection.js';
import { fixtureSurface, fixtureSurfaceLarge } from '../support/fixtures.js';

const VIEW = { width: 800, height: 500 } as const;
const FLAT: Camera = { yaw: 0, pitch: 0, zoom: 1 };
const CENTER: Vec3 = { x: 0, y: BOX_HEIGHT / 2, z: 0 };

function near(actual: number, expected: number, message?: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `${actual} is not ${expected}`);
}

/** The eight corners of the world box. */
const CORNERS: readonly Vec3[] = [-1, 1].flatMap((x) =>
  [0, BOX_HEIGHT].flatMap((y) => [-1, 1].map((z) => ({ x, y, z }))),
);

describe('fitScale', () => {
  it('fits the bounding sphere of the box into 78% of the smaller half-dimension', () => {
    const radius = Math.hypot(1, BOX_HEIGHT / 2, 1);
    near(fitScale({ width: 600, height: 400 }), (200 * 0.78) / radius);
  });

  it('is set by the smaller dimension, so a tall or wide view does not stretch the box', () => {
    assert.equal(fitScale({ width: 400, height: 900 }), fitScale({ width: 400, height: 400 }));
    assert.equal(fitScale({ width: 900, height: 400 }), fitScale({ width: 400, height: 400 }));
  });

  it('grows in proportion to the view', () => {
    near(fitScale({ width: 800, height: 800 }), 2 * fitScale({ width: 400, height: 400 }));
  });

  it('is zero for an empty view rather than a negative or non-finite number', () => {
    assert.equal(fitScale({ width: 0, height: 300 }), 0);
  });
});

describe('project', () => {
  it('puts the center of the box at the center of the view, whatever the camera', () => {
    for (const camera of [
      FLAT,
      DEFAULT_CAMERA,
      { yaw: 2.1, pitch: 1.2, zoom: 2.5 },
      { yaw: -3, pitch: PITCH_MIN, zoom: ZOOM_MIN },
    ]) {
      const point = project(CENTER, camera, VIEW);
      near(point.sx, VIEW.width / 2);
      near(point.sy, VIEW.height / 2);
      near(point.depth, 0);
    }
  });

  it('looking straight on: x runs right, height runs up, and z is depth', () => {
    const scale = fitScale(VIEW);
    const origin = project(CENTER, FLAT, VIEW);
    const right = project({ ...CENTER, x: 1 }, FLAT, VIEW);
    const up = project({ ...CENTER, y: CENTER.y + 0.2 }, FLAT, VIEW);
    const front = project({ ...CENTER, z: 1 }, FLAT, VIEW);
    near(right.sx - origin.sx, scale);
    near(right.sy, origin.sy);
    near(up.sy - origin.sy, -0.2 * scale, 'higher points are drawn higher (smaller y)');
    near(up.sx, origin.sx);
    near(front.depth, 1);
    near(front.sx, origin.sx);
  });

  it('zoom scales distances from the center and nothing else', () => {
    const point: Vec3 = { x: 0.6, y: 0.5, z: -0.3 };
    const base = project(point, DEFAULT_CAMERA, VIEW);
    const zoomed = project(point, { ...DEFAULT_CAMERA, zoom: 2 }, VIEW);
    near(zoomed.sx - VIEW.width / 2, 2 * (base.sx - VIEW.width / 2));
    near(zoomed.sy - VIEW.height / 2, 2 * (base.sy - VIEW.height / 2));
    near(zoomed.depth, base.depth);
  });

  it('is orthographic: the same offset gives the same screen vector wherever it starts', () => {
    const delta: Vec3 = { x: 0.3, y: 0.1, z: -0.2 };
    const starts: Vec3[] = [CENTER, { x: -0.9, y: 0.05, z: 0.8 }, { x: 0.7, y: 0.7, z: -0.6 }];
    const vectors = starts.map((start) => {
      const a = project(start, DEFAULT_CAMERA, VIEW);
      const b = project(
        { x: start.x + delta.x, y: start.y + delta.y, z: start.z + delta.z },
        DEFAULT_CAMERA,
        VIEW,
      );
      return { dx: b.sx - a.sx, dy: b.sy - a.sy, dz: b.depth - a.depth };
    });
    for (const vector of vectors) {
      near(vector.dx, vectors[0]?.dx ?? 0);
      near(vector.dy, vectors[0]?.dy ?? 0);
      near(vector.dz, vectors[0]?.dz ?? 0);
    }
  });

  it('shows the shortest expiry side nearer by default: the front edge is closer than the back edge', () => {
    const front = project({ x: 0, y: 0, z: 1 }, DEFAULT_CAMERA, VIEW);
    const back = project({ x: 0, y: 0, z: -1 }, DEFAULT_CAMERA, VIEW);
    assert.ok(
      front.depth > back.depth,
      `front ${front.depth} should be nearer than back ${back.depth}`,
    );
  });

  it('keeps the whole box inside the view at every angle and zoom 1, so nothing is cut off', () => {
    for (const view of [VIEW, { width: 320, height: 480 }, { width: 1200, height: 360 }]) {
      const reach = (Math.min(view.width, view.height) / 2) * 0.78 + 1e-9;
      for (let turn = 0; turn < 36; turn += 1) {
        const yaw = (turn / 36) * Math.PI * 2 - Math.PI;
        for (const pitch of [PITCH_MIN, 0.5, 1, PITCH_MAX]) {
          for (const corner of CORNERS) {
            const point = project(corner, { yaw, pitch, zoom: 1 }, view);
            assert.ok(
              Math.abs(point.sx - view.width / 2) <= reach,
              `x, yaw ${yaw.toFixed(2)} pitch ${pitch}`,
            );
            assert.ok(
              Math.abs(point.sy - view.height / 2) <= reach,
              `y, yaw ${yaw.toFixed(2)} pitch ${pitch}`,
            );
          }
        }
      }
    }
  });
});

describe('the camera', () => {
  it('returns the very same object when nothing needs to change', () => {
    assert.equal(clampCamera(DEFAULT_CAMERA), DEFAULT_CAMERA);
    const edge: Camera = { yaw: Math.PI, pitch: PITCH_MAX, zoom: ZOOM_MAX };
    assert.equal(clampCamera(edge), edge);
  });

  it('keeps pitch between the floor and just short of straight down, and zoom within its limits', () => {
    assert.equal(clampCamera({ yaw: 0, pitch: -1, zoom: 1 }).pitch, PITCH_MIN);
    assert.equal(clampCamera({ yaw: 0, pitch: 3, zoom: 1 }).pitch, PITCH_MAX);
    assert.equal(clampCamera({ yaw: 0, pitch: 0.5, zoom: 0.01 }).zoom, ZOOM_MIN);
    assert.equal(clampCamera({ yaw: 0, pitch: 0.5, zoom: 100 }).zoom, ZOOM_MAX);
  });

  it('wraps yaw into (-π, π] instead of clamping it, so the box can be turned all the way round', () => {
    near(clampCamera({ yaw: Math.PI * 2 + 0.25, pitch: 0.5, zoom: 1 }).yaw, 0.25);
    near(clampCamera({ yaw: -Math.PI * 2 - 0.25, pitch: 0.5, zoom: 1 }).yaw, -0.25);
    for (let step = -40; step <= 40; step += 1) {
      const { yaw } = clampCamera({ yaw: step * 0.7, pitch: 0.5, zoom: 1 });
      assert.ok(yaw > -Math.PI && yaw <= Math.PI + 1e-12, `yaw ${step * 0.7} wrapped to ${yaw}`);
    }
  });

  it('rotates by the deltas and clamps pitch', () => {
    const turned = rotateCamera(DEFAULT_CAMERA, 0.2, -0.1);
    near(turned.yaw, DEFAULT_CAMERA.yaw + 0.2);
    near(turned.pitch, DEFAULT_CAMERA.pitch - 0.1);
    assert.equal(turned.zoom, DEFAULT_CAMERA.zoom);
    assert.equal(rotateCamera(DEFAULT_CAMERA, 0, 10).pitch, PITCH_MAX);
    assert.equal(rotateCamera(DEFAULT_CAMERA, 0, -10).pitch, PITCH_MIN);
  });

  it('never leaves its limits however long it is dragged', () => {
    let camera = DEFAULT_CAMERA;
    for (let step = 0; step < 500; step += 1) {
      camera = rotateCamera(
        camera,
        0.37 * (step % 2 === 0 ? 1 : 1.9),
        step % 3 === 0 ? 0.4 : -0.55,
      );
      assert.ok(camera.pitch >= PITCH_MIN && camera.pitch <= PITCH_MAX);
      assert.ok(camera.yaw > -Math.PI && camera.yaw <= Math.PI + 1e-12);
    }
  });

  it('zooms by a factor, within limits', () => {
    near(zoomCamera(DEFAULT_CAMERA, 1.5).zoom, 1.5);
    assert.equal(zoomCamera(DEFAULT_CAMERA, 1e6).zoom, ZOOM_MAX);
    assert.equal(zoomCamera(DEFAULT_CAMERA, 1e-6).zoom, ZOOM_MIN);
  });

  it('ignores a factor that is zero, negative or not a number', () => {
    for (const factor of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(zoomCamera(DEFAULT_CAMERA, factor), DEFAULT_CAMERA, String(factor));
    }
  });
});

describe('axisPositions', () => {
  it('has nothing to place for no values and puts a single value in the middle', () => {
    assert.deepEqual(axisPositions([], 'equal'), []);
    assert.deepEqual(axisPositions([], 'calendar'), []);
    assert.deepEqual(axisPositions([30], 'equal'), [0]);
    assert.deepEqual(axisPositions([30], 'calendar'), [0]);
  });

  it('spaces equally when asked, whatever the values are', () => {
    const positions = axisPositions([7, 30, 90, 365], 'equal');
    const expected = [-1, -1 / 3, 1 / 3, 1];
    assert.equal(positions.length, expected.length);
    expected.forEach((value, index) => near(positions[index] ?? Number.NaN, value));
  });

  it('spaces by the values themselves for a calendar axis', () => {
    const positions = axisPositions([7, 30, 90], 'calendar');
    assert.equal(positions[0], -1);
    near(positions[1] ?? 0, (23 / 83) * 2 - 1);
    assert.equal(positions[2], 1);
  });

  it('spans -1 to 1 and stays strictly ascending for ascending values', () => {
    for (const spacing of ['equal', 'calendar'] as const) {
      const positions = axisPositions([-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06], spacing);
      assert.equal(positions[0], -1);
      assert.equal(positions[positions.length - 1], 1);
      positions.forEach((value, index) => {
        if (index > 0) assert.ok(value > (positions[index - 1] ?? 0));
      });
    }
  });

  it('falls back to equal spacing instead of dividing by zero when every value is the same', () => {
    assert.deepEqual(axisPositions([5, 5], 'calendar'), [-1, 1]);
  });
});

describe('ivAxis', () => {
  it('rounds outward to round tick values and does not start at zero', () => {
    const axis = ivAxis({ min: 8.1, max: 10.4 });
    assert.deepEqual(axis, { min: 8, max: 10.5, ticks: [8, 8.5, 9, 9.5, 10, 10.5] });
  });

  it('always covers the range, with evenly spaced ascending ticks from its minimum to its maximum', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 300; round += 1) {
      const min = 0.5 + next() * 80;
      const span = 0.001 + next() * next() * 50;
      const range = { min, max: min + span };
      const axis = ivAxis(range);
      assert.ok(axis.min <= range.min + 1e-9, `min ${axis.min} above ${range.min}`);
      assert.ok(axis.max >= range.max - 1e-9, `max ${axis.max} below ${range.max}`);
      assert.equal(axis.ticks[0], axis.min);
      assert.equal(axis.ticks[axis.ticks.length - 1], axis.max);
      assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 51, `${axis.ticks.length} ticks`);
      const step = (axis.ticks[1] ?? 0) - (axis.ticks[0] ?? 0);
      assert.ok(step > 0);
      axis.ticks.forEach((tick, index) => {
        if (index > 0) near(tick - (axis.ticks[index - 1] ?? 0), step, 'uneven ticks', step * 1e-6);
      });
    }
  });

  it('opens up a flat surface to a half point either side instead of drawing a zero-height box', () => {
    const axis = ivAxis({ min: 9, max: 9 });
    assert.ok(axis.min < 9 && axis.max > 9);
    assert.ok(axis.max - axis.min >= 1);
  });

  it('gives back ticks free of floating-point residue', () => {
    const axis = ivAxis({ min: 0.1, max: 0.7 });
    for (const tick of axis.ticks) assert.equal(tick, Number(tick.toFixed(10)));
  });
});

describe('ivFraction', () => {
  const axis = { min: 8, max: 10.5, ticks: [8, 10.5] };

  it('is 0 at the bottom of the axis, 1 at the top, and linear between', () => {
    assert.equal(ivFraction(8, axis), 0);
    assert.equal(ivFraction(10.5, axis), 1);
    near(ivFraction(9.25, axis), 0.5);
  });

  it('does not clamp: a value off the axis is off the box, which would be a bug worth seeing', () => {
    assert.ok(ivFraction(7, axis) < 0);
    assert.ok(ivFraction(12, axis) > 1);
  });

  it('is 0 for an axis with no span', () => {
    assert.equal(ivFraction(9, { min: 9, max: 9, ticks: [] }), 0);
  });
});

describe('buildMesh', () => {
  const surface = fixtureSurface();
  const range = volRange(surface);

  it('has one vertex per measured point, row-major, and nothing else', () => {
    const mesh = buildMesh(surface, range, 'equal');
    assert.equal(mesh.rows, 3);
    assert.equal(mesh.cols, 5);
    assert.equal(mesh.vertices.length, 15);
    assert.deepEqual(mesh.iv, surface.iv.flat());
  });

  it('draws each vertex at the height of its own volatility on the rounded axis', () => {
    const mesh = buildMesh(surface, range, 'equal');
    mesh.vertices.forEach((vertex, index) => {
      near(
        vertex.y,
        (((mesh.iv[index] ?? 0) - mesh.axis.min) / (mesh.axis.max - mesh.axis.min)) * BOX_HEIGHT,
      );
      assert.ok(vertex.y >= 0 && vertex.y <= BOX_HEIGHT);
    });
    near(mesh.vertices[0]?.y ?? 0, 0.56 * BOX_HEIGHT);
  });

  it('puts the strikes along x from -1 to 1 and the shortest expiry at the front (largest z)', () => {
    const mesh = buildMesh(surface, range, 'equal');
    assert.equal(mesh.xs[0], -1);
    assert.equal(mesh.xs[mesh.cols - 1], 1);
    assert.equal(mesh.zs[0], 1, 'first and shortest expiry is at the front');
    assert.equal(mesh.zs[mesh.rows - 1], -1);
    for (const vertex of mesh.vertices.slice(0, mesh.cols)) assert.equal(vertex.z, 1);
  });

  it('spaces the expiries by calendar days or equally, as chosen', () => {
    const equal = buildMesh(surface, range, 'equal');
    const calendar = buildMesh(surface, range, 'calendar');
    near(equal.zs[1] ?? 1, 0);
    near(calendar.zs[1] ?? 0, -((23 / 83) * 2 - 1));
    assert.notEqual(equal.zs[1], calendar.zs[1]);
    assert.equal(calendar.zs[0], 1);
    assert.equal(calendar.zs[2], -1);
  });

  it('keeps the range it was given, for the color ramp, and the axis it computed', () => {
    const mesh = buildMesh(surface, range, 'equal');
    assert.deepEqual(mesh.range, range);
    assert.deepEqual(mesh.axis, ivAxis(range));
  });

  it('handles a larger grid and keeps every strike column aligned across rows', () => {
    const large = fixtureSurfaceLarge();
    const mesh = buildMesh(large, volRange(large), 'calendar');
    assert.equal(mesh.vertices.length, mesh.rows * mesh.cols);
    for (let row = 0; row < mesh.rows; row += 1) {
      for (let col = 0; col < mesh.cols; col += 1) {
        assert.equal(mesh.vertices[row * mesh.cols + col]?.x, mesh.xs[col]);
        assert.equal(mesh.vertices[row * mesh.cols + col]?.z, mesh.zs[row]);
      }
    }
  });

  it('does not smooth, interpolate or extrapolate: every volatility in the mesh is one that was supplied', () => {
    const large = fixtureSurfaceLarge();
    const supplied = new Set(large.iv.flat());
    const mesh = buildMesh(large, volRange(large), 'equal');
    for (const value of mesh.iv) assert.ok(supplied.has(value), `${value} was not supplied`);
  });
});

describe('quadsOf', () => {
  it('has one quad between each four neighbouring vertices, in row-major order', () => {
    const mesh = buildMesh(fixtureSurface(), volRange(fixtureSurface()), 'equal');
    const quads = quadsOf(mesh);
    assert.equal(quads.length, (mesh.rows - 1) * (mesh.cols - 1));
    assert.deepEqual(quads[0], { row: 0, col: 0 });
    assert.deepEqual(quads[quads.length - 1], { row: mesh.rows - 2, col: mesh.cols - 2 });
    for (const quad of quads) {
      assert.ok(quad.row < mesh.rows - 1 && quad.col < mesh.cols - 1);
    }
  });
});

describe('nearestVertex', () => {
  const points: Projected[] = [
    { sx: 0, sy: 0, depth: 0 },
    { sx: 10, sy: 0, depth: 0 },
    { sx: 20, sy: 0, depth: 0 },
  ];

  it('picks the closest vertex', () => {
    assert.equal(nearestVertex(points, 9, 1, 8), 1);
    assert.equal(nearestVertex(points, 17, -2, 8), 2);
    assert.equal(nearestVertex(points, -3, 0, 8), 0);
  });

  it('returns -1 when nothing is near enough, or there is nothing to find', () => {
    assert.equal(nearestVertex(points, 100, 100, 8), -1);
    assert.equal(nearestVertex([], 0, 0, 8), -1);
  });

  it('includes a vertex exactly at the limit and excludes one just beyond it', () => {
    const only: Projected[] = [{ sx: 0, sy: 0, depth: 0 }];
    assert.equal(nearestVertex(only, 5, 0, 5), 0, 'exactly at the limit counts');
    assert.equal(nearestVertex(only, 5.001, 0, 5), -1, 'just beyond the limit does not');
    assert.equal(
      nearestVertex(points, 15.01, 0, 5),
      2,
      'the next vertex is 4.99 away, so it is the one chosen',
    );
  });
});
