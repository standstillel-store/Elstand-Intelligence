import type { Page } from 'playwright';

/** TEST-ONLY. Reads what the 3D surface canvas actually painted, so tests check pixels, not intentions. */

export const SURFACE_CANVAS = '#vol-surface-panel .surface3d__canvas';

export interface SurfaceInk {
  /** Pixels painted in the ramp's green (the surface faces and the hover ring). */
  readonly ramp: number;
  readonly total: number;
  /** Bounding box of the ramp-colored pixels, or null when there are none. */
  readonly box: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  } | null;
  /** A hash of every pixel, so two different pictures differ and the same picture matches. */
  readonly hash: number;
}

/**
 * Copies the canvas to a scratch canvas (never reading the visible one back) and measures it.
 * The ramp runs from #256f3a to #d4ffdc. Every ramp color has a green channel at least 43 above
 * its red channel, while the background, grid lines and text greys differ by under 20, so
 * `g - r > 40` isolates the surface faces.
 */
export async function surfaceInk(page: Page): Promise<SurfaceInk> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (canvas === null || canvas.width === 0 || canvas.height === 0) {
      return { ramp: 0, total: 0, box: null, hash: 0 };
    }
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (context === null) return { ramp: 0, total: 0, box: null, hash: 0 };
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    let ramp = 0;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = -1;
    let y1 = -1;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      hash = Math.imul(hash ^ r, 16777619);
      hash = Math.imul(hash ^ g, 16777619);
      hash = Math.imul(hash ^ b, 16777619);
      if (g - r > 40) {
        ramp += 1;
        const pixel = i / 4;
        const x = pixel % scratch.width;
        const y = Math.floor(pixel / scratch.width);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return {
      ramp,
      total: scratch.width * scratch.height,
      box: ramp === 0 ? null : { x0, y0, x1, y1 },
      hash: hash >>> 0,
    };
  }, SURFACE_CANVAS);
}

/** Waits until the surface faces have been painted. */
export async function waitForSurface(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => {
      const canvas = document.querySelector<HTMLCanvasElement>(selector);
      if (canvas === null || canvas.width === 0) return false;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      if (context === null) return false;
      context.drawImage(canvas, 0, 0);
      const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
      let ramp = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 1] ?? 0) - (data[i] ?? 0) > 40) ramp += 1;
        if (ramp > 300) return true;
      }
      return false;
    },
    SURFACE_CANVAS,
    { timeout: 10_000 },
  );
}

export interface CameraReading {
  readonly yaw: number;
  readonly pitch: number;
  readonly zoom: number;
}

/** The camera as the canvas publishes it: degrees for yaw and pitch, a factor for zoom. */
export async function cameraOf(page: Page): Promise<CameraReading> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    const read = (name: string): number => Number(canvas?.getAttribute(name) ?? Number.NaN);
    return { yaw: read('data-yaw'), pitch: read('data-pitch'), zoom: read('data-zoom') };
  }, SURFACE_CANVAS);
}

/** Waits until the canvas has settled on a picture (two equal hashes a frame apart). */
export async function settled(page: Page): Promise<SurfaceInk> {
  let previous = await surfaceInk(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(40);
    const next = await surfaceInk(page);
    if (next.hash === previous.hash) return next;
    previous = next;
  }
  return previous;
}
