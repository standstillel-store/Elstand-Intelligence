import type { StrikeAxisKind } from '../../data/options.js';
import { rampColor } from './ramp.js';
import {
  BOX_HEIGHT,
  ivFraction,
  project,
  quadsOf,
  type Camera,
  type Projected,
  type SurfaceMesh,
  type Vec3,
  type ViewSize,
} from './projection.js';

/** Colors and font read from the stylesheet, so the canvas can never drift from the tokens. */
export interface SurfaceTheme {
  readonly bg: string;
  readonly grid: string;
  readonly axisText: string;
  readonly text: string;
  readonly highlight: string;
  readonly font: string;
}

export function readSurfaceTheme(element: Element): SurfaceTheme {
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
    highlight: read('--neon'),
    font: `11px ${read('--font-mono')}`,
  };
}

export interface SurfaceLabels {
  readonly strikeTitle: string;
  readonly strikeKind: StrikeAxisKind;
  readonly strikeValues: readonly number[];
  readonly expiryTitle: string;
  readonly expiryDays: readonly number[];
  readonly ivTitle: string;
}

export interface SurfaceFrameInput {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: ViewSize;
  readonly dpr: number;
  readonly theme: SurfaceTheme;
  readonly mesh: SurfaceMesh;
  readonly camera: Camera;
  readonly labels: SurfaceLabels;
  /** Index into `mesh.vertices` of the vertex under the pointer, or -1. */
  readonly hover: number;
}

export interface SurfaceFrame {
  /** One entry per mesh vertex, for hit-testing against the pointer. */
  readonly projected: readonly Projected[];
}

/** At most this many tick labels per axis, so a dense grid never turns into a smear of text. */
const MAX_TICK_LABELS = 7;
const LABEL_OFFSET = 12;
const TITLE_OFFSET = 30;

export function formatStrike(value: number): string {
  return String(Number(value.toPrecision(4)));
}

export function formatIvTick(value: number): string {
  return `${Number(value.toPrecision(4))}%`;
}

/** Every k-th index, always including the first and last, at most `max` of them. */
export function labelIndices(count: number, max: number = MAX_TICK_LABELS): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / (max - 1));
  const picked: number[] = [];
  for (let index = 0; index < count; index += step) picked.push(index);
  if (picked[picked.length - 1] !== count - 1) picked.push(count - 1);
  return picked;
}

function line(
  ctx: CanvasRenderingContext2D,
  a: Projected,
  b: Projected,
  color: string,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function labelAt(
  ctx: CanvasRenderingContext2D,
  text: string,
  anchor: Projected,
  center: Projected,
  distance: number,
): void {
  let dx = anchor.sx - center.sx;
  let dy = anchor.sy - center.sy;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    dx = 0;
    dy = 1;
  } else {
    dx /= length;
    dy /= length;
  }
  ctx.textAlign = dx > 0.35 ? 'left' : dx < -0.35 ? 'right' : 'center';
  ctx.textBaseline = dy > 0.35 ? 'top' : dy < -0.35 ? 'bottom' : 'middle';
  ctx.fillText(text, anchor.sx + dx * distance, anchor.sy + dy * distance);
}

/**
 * Draws one frame: floor grid, the two back walls with IV gridlines, the surface as flat-shaded
 * quads painted far to near, axis labels on the near edges, and the hovered vertex. The mesh
 * connects measured points only; nothing is smoothed, interpolated or extrapolated.
 */
export function drawSurface(input: SurfaceFrameInput): SurfaceFrame {
  const { ctx, view, dpr, theme, mesh, camera, labels } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.font = theme.font;

  const at = (point: Vec3): Projected => project(point, camera, view);
  const projected = mesh.vertices.map(at);

  // ---- floor and walls ----------------------------------------------------------------------
  const corners: readonly Vec3[] = [
    { x: -1, y: 0, z: -1 },
    { x: 1, y: 0, z: -1 },
    { x: 1, y: 0, z: 1 },
    { x: -1, y: 0, z: 1 },
  ];
  const cornerP = corners.map(at);
  const center = at({ x: 0, y: 0, z: 0 });
  const depthOf = (index: number): number => cornerP[index]?.depth ?? 0;

  let back = 0;
  for (let index = 1; index < 4; index += 1) if (depthOf(index) < depthOf(back)) back = index;

  const xAt = (index: number): number => mesh.xs[index] ?? 0;
  const zAt = (index: number): number => mesh.zs[index] ?? 0;

  for (let index = 0; index < mesh.cols; index += 1) {
    line(ctx, at({ x: xAt(index), y: 0, z: -1 }), at({ x: xAt(index), y: 0, z: 1 }), theme.grid, 1);
  }
  for (let index = 0; index < mesh.rows; index += 1) {
    line(ctx, at({ x: -1, y: 0, z: zAt(index) }), at({ x: 1, y: 0, z: zAt(index) }), theme.grid, 1);
  }
  for (let index = 0; index < 4; index += 1) {
    const a = cornerP[index];
    const b = cornerP[(index + 1) % 4];
    if (a !== undefined && b !== undefined) line(ctx, a, b, theme.axisText, 1);
  }

  for (const neighbour of [(back + 1) % 4, (back + 3) % 4]) {
    const from = corners[back];
    const to = corners[neighbour];
    if (from === undefined || to === undefined) continue;
    for (const tick of mesh.axis.ticks) {
      const height = ivFraction(tick, mesh.axis) * BOX_HEIGHT;
      line(
        ctx,
        at({ x: from.x, y: height, z: from.z }),
        at({ x: to.x, y: height, z: to.z }),
        theme.grid,
        1,
      );
    }
    line(
      ctx,
      at({ x: to.x, y: 0, z: to.z }),
      at({ x: to.x, y: BOX_HEIGHT, z: to.z }),
      theme.grid,
      1,
    );
  }
  const backCorner = corners[back];
  if (backCorner !== undefined) {
    line(
      ctx,
      at({ x: backCorner.x, y: 0, z: backCorner.z }),
      at({ x: backCorner.x, y: BOX_HEIGHT, z: backCorner.z }),
      theme.grid,
      1,
    );
  }

  // ---- surface, far to near -------------------------------------------------------------
  const span = mesh.range.max - mesh.range.min;
  const quads = quadsOf(mesh)
    .map((quad) => {
      const indices = [
        quad.row * mesh.cols + quad.col,
        quad.row * mesh.cols + quad.col + 1,
        (quad.row + 1) * mesh.cols + quad.col + 1,
        (quad.row + 1) * mesh.cols + quad.col,
      ];
      const points = indices.map((index) => projected[index]);
      const values = indices.map((index) => mesh.iv[index] ?? mesh.range.min);
      const depth = points.reduce((sum, point) => sum + (point?.depth ?? 0), 0) / 4;
      const mean = values.reduce((sum, value) => sum + value, 0) / 4;
      return { points, depth, t: span > 0 ? (mean - mesh.range.min) / span : 0.5 };
    })
    .sort((a, b) => a.depth - b.depth);

  for (const quad of quads) {
    const [first, ...rest] = quad.points;
    if (first === undefined) continue;
    ctx.beginPath();
    ctx.moveTo(first.sx, first.sy);
    for (const point of rest) if (point !== undefined) ctx.lineTo(point.sx, point.sy);
    ctx.closePath();
    ctx.fillStyle = rampColor(quad.t);
    ctx.fill();
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---- axis labels on the near edges ----------------------------------------------------
  ctx.fillStyle = theme.axisText;
  const nearZ =
    (cornerP[2]?.depth ?? 0) + (cornerP[3]?.depth ?? 0) >=
    (cornerP[0]?.depth ?? 0) + (cornerP[1]?.depth ?? 0)
      ? 1
      : -1;
  const nearX =
    (cornerP[1]?.depth ?? 0) + (cornerP[2]?.depth ?? 0) >=
    (cornerP[0]?.depth ?? 0) + (cornerP[3]?.depth ?? 0)
      ? 1
      : -1;

  for (const index of labelIndices(mesh.cols)) {
    labelAt(
      ctx,
      formatStrike(labels.strikeValues[index] ?? Number.NaN),
      at({ x: xAt(index), y: 0, z: nearZ }),
      center,
      LABEL_OFFSET,
    );
  }
  for (const index of labelIndices(mesh.rows)) {
    labelAt(
      ctx,
      `${labels.expiryDays[index] ?? ''}d`,
      at({ x: nearX, y: 0, z: zAt(index) }),
      center,
      LABEL_OFFSET,
    );
  }

  // IV labels on the vertical edge that is leftmost on screen.
  let left = 0;
  for (let index = 1; index < 4; index += 1) {
    if ((cornerP[index]?.sx ?? 0) < (cornerP[left]?.sx ?? 0)) left = index;
  }
  const leftCorner = corners[left];
  if (leftCorner !== undefined) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of mesh.axis.ticks) {
      const anchor = at({
        x: leftCorner.x,
        y: ivFraction(tick, mesh.axis) * BOX_HEIGHT,
        z: leftCorner.z,
      });
      ctx.fillText(formatIvTick(tick), anchor.sx - 8, anchor.sy);
    }
  }

  // ---- axis titles ----------------------------------------------------------------------
  ctx.fillStyle = theme.text;
  labelAt(ctx, labels.strikeTitle, at({ x: 0, y: 0, z: nearZ }), center, TITLE_OFFSET);
  labelAt(ctx, labels.expiryTitle, at({ x: nearX, y: 0, z: 0 }), center, TITLE_OFFSET);
  if (leftCorner !== undefined) {
    const top = at({ x: leftCorner.x, y: BOX_HEIGHT, z: leftCorner.z });
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(labels.ivTitle, top.sx - 8, top.sy - 10);
  }

  // ---- hovered vertex -------------------------------------------------------------------
  const hovered = input.hover >= 0 ? projected[input.hover] : undefined;
  if (hovered !== undefined) {
    ctx.beginPath();
    ctx.arc(hovered.sx, hovered.sy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = theme.highlight;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  return { projected };
}
