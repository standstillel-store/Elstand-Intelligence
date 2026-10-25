import { niceTicks } from '../../core/ticks.js';
import type { VolRange, VolSurface } from '../../data/options.js';

/**
 * Pure 3D geometry for the implied-volatility surface: no DOM and no canvas.
 *
 * World space is a box. `x` is the strike axis and `z` the expiry axis, both spanning
 * [-1, 1]; `y` is implied volatility, spanning [0, BOX_HEIGHT]. The shortest expiry sits at
 * the front (z = +1) so the steepest smile is the first thing seen. The camera is an
 * orthographic orbit around the center of the box: parallel lines stay parallel, so the
 * picture can be read like a chart rather than a perspective painting.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

export interface Camera {
  /** Rotation about the vertical axis, radians. */
  readonly yaw: number;
  /** Elevation above the floor, radians. */
  readonly pitch: number;
  readonly zoom: number;
}

export interface Projected {
  readonly sx: number;
  readonly sy: number;
  /** Larger is closer to the viewer. */
  readonly depth: number;
}

export const BOX_HEIGHT = 0.8;
export const DEFAULT_CAMERA: Camera = { yaw: -0.65, pitch: 0.5, zoom: 1 };
export const PITCH_MIN = 0.12;
export const PITCH_MAX = 1.35;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

const CENTER_Y = BOX_HEIGHT / 2;
/** Distance from the box center to a corner, so the whole box fits at any angle. */
const BOUNDING_RADIUS = Math.hypot(1, CENTER_Y, 1);
/** Share of the canvas the bounding sphere may use, leaving room for axis labels. */
const FILL = 0.78;

function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  let wrapped = angle % turn;
  if (wrapped > Math.PI) wrapped -= turn;
  else if (wrapped <= -Math.PI) wrapped += turn;
  return wrapped;
}

export function clampCamera(camera: Camera): Camera {
  const yaw = wrapAngle(camera.yaw);
  const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, camera.pitch));
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom));
  return yaw === camera.yaw && pitch === camera.pitch && zoom === camera.zoom
    ? camera
    : { yaw, pitch, zoom };
}

export function rotateCamera(camera: Camera, deltaYaw: number, deltaPitch: number): Camera {
  return clampCamera({ ...camera, yaw: camera.yaw + deltaYaw, pitch: camera.pitch + deltaPitch });
}

export function zoomCamera(camera: Camera, factor: number): Camera {
  if (!(factor > 0) || !Number.isFinite(factor)) return camera;
  return clampCamera({ ...camera, zoom: camera.zoom * factor });
}

/** Pixels per world unit at zoom 1. */
export function fitScale(view: ViewSize): number {
  return ((Math.min(view.width, view.height) / 2) * FILL) / BOUNDING_RADIUS;
}

export function project(point: Vec3, camera: Camera, view: ViewSize): Projected {
  const x = point.x;
  const y = point.y - CENTER_Y;
  const z = point.z;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x1 = x * cosYaw + z * sinYaw;
  const z1 = -x * sinYaw + z * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const y2 = y * cosPitch - z1 * sinPitch;
  const z2 = y * sinPitch + z1 * cosPitch;
  const scale = fitScale(view) * camera.zoom;
  return { sx: view.width / 2 + x1 * scale, sy: view.height / 2 - y2 * scale, depth: z2 };
}

// ---- axes ---------------------------------------------------------------------------------

/** How the expiry axis is laid out: true calendar days, or one equal step per listed expiry. */
export type ExpirySpacing = 'calendar' | 'equal';

/** Positions in [-1, 1] for ascending axis values. */
export function axisPositions(values: readonly number[], spacing: ExpirySpacing): number[] {
  const count = values.length;
  if (count === 0) return [];
  if (count === 1) return [0];
  const first = values[0] ?? 0;
  const last = values[count - 1] ?? 0;
  return values.map((value, index) =>
    spacing === 'equal' || last === first
      ? (index / (count - 1)) * 2 - 1
      : ((value - first) / (last - first)) * 2 - 1,
  );
}

export interface IvAxis {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

/**
 * The vertical axis spans the surface's own range, rounded outwards to tick values. It does
 * not start at zero (a surface of 8 to 10 percent would otherwise be a flat sheet), and the
 * page says so.
 */
export function ivAxis(range: VolRange): IvAxis {
  let low = range.min;
  let high = range.max;
  if (!(high - low > 1e-9)) {
    low -= 0.5;
    high += 0.5;
  }
  const { step } = niceTicks(low, high, 5);
  if (step === 0) return { min: low, max: high, ticks: [low, high] };
  const min = Math.floor(low / step + 1e-9) * step;
  const max = Math.ceil(high / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 50) break;
  }
  return { min: Number(min.toPrecision(12)), max: Number(max.toPrecision(12)), ticks };
}

/** IV as a fraction of the vertical axis, 0 to 1. */
export function ivFraction(iv: number, axis: IvAxis): number {
  return axis.max > axis.min ? (iv - axis.min) / (axis.max - axis.min) : 0;
}

// ---- mesh ---------------------------------------------------------------------------------

export interface SurfaceMesh {
  /** Expiries (rows) by strikes (columns). */
  readonly rows: number;
  readonly cols: number;
  /** Row-major, `rows * cols` long. */
  readonly vertices: readonly Vec3[];
  readonly iv: readonly number[];
  /** Strike positions in [-1, 1], one per column. */
  readonly xs: readonly number[];
  /** Expiry positions in [-1, 1], one per row. */
  readonly zs: readonly number[];
  readonly axis: IvAxis;
  /** The surface's own minimum and maximum, which span the color ramp. */
  readonly range: VolRange;
}

/** Builds the mesh from a surface that already passed `validateVolSurface`. */
export function buildMesh(
  surface: VolSurface,
  range: VolRange,
  spacing: ExpirySpacing,
): SurfaceMesh {
  const xs = axisPositions(surface.strikeAxis.values, 'calendar');
  // Short expiries at the front: the first expiry gets the largest z.
  const zs = axisPositions(surface.expiriesDays, spacing).map((position) => -position);
  const axis = ivAxis(range);
  const vertices: Vec3[] = [];
  const iv: number[] = [];
  for (let row = 0; row < surface.expiriesDays.length; row += 1) {
    const values = surface.iv[row] ?? [];
    for (let col = 0; col < xs.length; col += 1) {
      const value = values[col] ?? Number.NaN;
      iv.push(value);
      vertices.push({
        x: xs[col] ?? 0,
        y: ivFraction(value, axis) * BOX_HEIGHT,
        z: zs[row] ?? 0,
      });
    }
  }
  return { rows: surface.expiriesDays.length, cols: xs.length, vertices, iv, xs, zs, axis, range };
}

export interface Quad {
  readonly row: number;
  readonly col: number;
}

export function quadsOf(mesh: SurfaceMesh): Quad[] {
  const quads: Quad[] = [];
  for (let row = 0; row < mesh.rows - 1; row += 1) {
    for (let col = 0; col < mesh.cols - 1; col += 1) quads.push({ row, col });
  }
  return quads;
}

/** Index of the vertex nearest to a pixel, if it lies within `maxDistance`; otherwise -1. */
export function nearestVertex(
  projected: readonly Projected[],
  x: number,
  y: number,
  maxDistance: number,
): number {
  let best = -1;
  let bestDistance = maxDistance;
  projected.forEach((point, index) => {
    const distance = Math.hypot(point.sx - x, point.sy - y);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
