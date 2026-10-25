import { findInstrument } from '../../core/instruments.js';
import { volRange, type VolRange, type VolSurface } from '../../data/options.js';
import { h } from '../dom.js';
import {
  buildMesh,
  clampCamera,
  DEFAULT_CAMERA,
  nearestVertex,
  rotateCamera,
  zoomCamera,
  type Camera,
  type ExpirySpacing,
  type SurfaceMesh,
} from './projection.js';
import {
  drawSurface,
  formatStrike,
  readSurfaceTheme,
  type SurfaceFrame,
  type SurfaceTheme,
} from './surface-render.js';

/**
 * The interactive 3D canvas. Mouse and pen: drag rotates, Ctrl/Cmd + wheel (or a trackpad
 * pinch) zooms, double-click resets, hover reads the nearest measured point. Touch: a sideways
 * drag rotates (vertical swipes still scroll the page). Keyboard, with the canvas focused:
 * arrows rotate (Shift: larger steps), + and - zoom, 0 resets. Tooltips only enhance: every
 * value is also in the data table beside the chart.
 */

export interface SurfaceView {
  readonly el: HTMLElement;
  /** Draws a validated surface, or clears the canvas when given null. */
  show(surface: VolSurface | null): void;
  setSpacing(spacing: ExpirySpacing): void;
  resetView(): void;
  zoom(factor: number): void;
  dispose(): void;
}

const DRAG_RADIANS_PER_PIXEL = 0.009;
const KEY_STEP = 0.08;
const KEY_STEP_LARGE = 0.24;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_RATE = 0.0022;
const HOVER_RADIUS_PX = 22;
const DRAG_THRESHOLD_PX = 3;

const toDegrees = (radians: number): string => ((radians * 180) / Math.PI).toFixed(1);

export function createSurfaceView(win: Window, helpId: string): SurfaceView {
  const canvas = h('canvas', {
    class: 'surface3d__canvas',
    attrs: {
      tabindex: 0,
      role: 'application',
      'aria-label': 'Implied volatility surface. No surface is loaded.',
      'aria-describedby': helpId,
    },
  });
  const tip = h('div', { class: 'surface3d__tip', attrs: { hidden: true, 'aria-hidden': 'true' } });
  const el = h('div', { class: 'surface3d' }, canvas, tip);

  let surface: VolSurface | null = null;
  let range: VolRange | null = null;
  let spacing: ExpirySpacing = 'calendar';
  let mesh: SurfaceMesh | null = null;
  let camera: Camera = DEFAULT_CAMERA;
  let frame: SurfaceFrame | null = null;
  let hover = -1;
  let theme: SurfaceTheme | null = null;
  let context2d: CanvasRenderingContext2D | null = null;
  let drawHandle: number | null = null;
  const abort = new AbortController();
  const { signal } = abort;

  function publishCamera(): void {
    canvas.setAttribute('data-yaw', toDegrees(camera.yaw));
    canvas.setAttribute('data-pitch', toDegrees(camera.pitch));
    canvas.setAttribute('data-zoom', camera.zoom.toFixed(2));
  }

  function hideTip(): void {
    tip.hidden = true;
    tip.replaceChildren();
  }

  function schedule(): void {
    if (drawHandle !== null) return;
    drawHandle = win.requestAnimationFrame(() => {
      drawHandle = null;
      draw();
    });
  }

  function draw(): void {
    context2d ??= canvas.getContext('2d');
    const ctx = context2d;
    if (ctx === null) return;
    const dpr = win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    theme ??= readSurfaceTheme(canvas);
    if (mesh === null || surface === null) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
      frame = null;
      return;
    }
    frame = drawSurface({
      ctx,
      view: { width, height },
      dpr,
      theme,
      mesh,
      camera,
      labels: {
        strikeTitle: surface.strikeAxis.label,
        strikeKind: surface.strikeAxis.kind,
        strikeValues: surface.strikeAxis.values,
        expiryTitle: 'Days to expiry',
        expiryDays: surface.expiriesDays,
        ivTitle: 'Implied vol',
      },
      hover,
    });
  }

  function rebuild(): void {
    mesh = surface === null || range === null ? null : buildMesh(surface, range, spacing);
    hover = -1;
    hideTip();
    schedule();
  }

  function setCamera(next: Camera): void {
    const clamped = clampCamera(next);
    if (clamped === camera) return;
    camera = clamped;
    hover = -1;
    hideTip();
    publishCamera();
    schedule();
  }

  function showTip(index: number, x: number, y: number): void {
    if (surface === null || mesh === null) return;
    const row = Math.floor(index / mesh.cols);
    const col = index % mesh.cols;
    const iv = mesh.iv[index];
    const strike = surface.strikeAxis.values[col];
    const days = surface.expiriesDays[row];
    if (iv === undefined || strike === undefined || days === undefined) return;
    tip.replaceChildren(
      h('div', {}, h('b', { text: `IV ${iv.toFixed(2)}%` })),
      h('div', { text: `${surface.strikeAxis.label} ${formatStrike(strike)}` }),
      h('div', { text: `${days} days to expiry` }),
    );
    tip.hidden = false;
    const left = Math.min(Math.max(4, x + 14), Math.max(4, el.clientWidth - tip.offsetWidth - 4));
    const top = Math.min(Math.max(4, y + 14), Math.max(4, el.clientHeight - tip.offsetHeight - 4));
    tip.style.setProperty('left', `${left}px`);
    tip.style.setProperty('top', `${top}px`);
  }

  // ---- input ------------------------------------------------------------------------------
  interface Drag {
    readonly id: number;
    readonly pointerType: string;
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    moved: boolean;
  }
  let drag: Drag | null = null;

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || surface === null) return;
      drag = {
        id: event.pointerId,
        pointerType: event.pointerType,
        lastX: event.clientX,
        lastY: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
    },
    { signal },
  );

  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (drag !== null && event.pointerId === drag.id) {
        if (
          !drag.moved &&
          Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        drag.moved = true;
        canvas.setAttribute('data-dragging', 'true');
        const dx = event.clientX - drag.lastX;
        const dy = event.clientY - drag.lastY;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        setCamera(
          rotateCamera(
            camera,
            dx * DRAG_RADIANS_PER_PIXEL,
            // A touch drag only turns the surface; vertical swipes belong to the page.
            drag.pointerType === 'touch' ? 0 : dy * DRAG_RADIANS_PER_PIXEL,
          ),
        );
        return;
      }
      if (event.pointerType === 'touch' || frame === null) return;
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const nearest = nearestVertex(frame.projected, x, y, HOVER_RADIUS_PX);
      if (nearest !== hover) {
        hover = nearest;
        schedule();
      }
      if (nearest < 0) hideTip();
      else showTip(nearest, x, y);
    },
    { signal },
  );

  const endDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.id) return;
    drag = null;
    canvas.removeAttribute('data-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag, { signal });
  canvas.addEventListener('pointercancel', endDrag, { signal });
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (hover !== -1) {
        hover = -1;
        schedule();
      }
      hideTip();
    },
    { signal },
  );

  canvas.addEventListener(
    'wheel',
    (event) => {
      // A plain wheel scrolls the page. Ctrl/Cmd + wheel, and a trackpad pinch, zoom.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setCamera(zoomCamera(camera, Math.exp(-event.deltaY * WHEEL_ZOOM_RATE)));
    },
    { signal, passive: false },
  );

  canvas.addEventListener('dblclick', () => setCamera(DEFAULT_CAMERA), { signal });

  canvas.addEventListener(
    'keydown',
    (event) => {
      if (surface === null || event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      switch (event.key) {
        case 'ArrowLeft':
          setCamera(rotateCamera(camera, -step, 0));
          break;
        case 'ArrowRight':
          setCamera(rotateCamera(camera, step, 0));
          break;
        case 'ArrowUp':
          setCamera(rotateCamera(camera, 0, step));
          break;
        case 'ArrowDown':
          setCamera(rotateCamera(camera, 0, -step));
          break;
        case '+':
        case '=':
          setCamera(zoomCamera(camera, ZOOM_STEP));
          break;
        case '-':
        case '_':
          setCamera(zoomCamera(camera, 1 / ZOOM_STEP));
          break;
        case '0':
          setCamera(DEFAULT_CAMERA);
          break;
        case 'Escape':
          hover = -1;
          hideTip();
          schedule();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    { signal },
  );

  const observer = new ResizeObserver(() => schedule());
  observer.observe(canvas);
  publishCamera();

  return {
    el,
    show(next) {
      surface = next;
      range = next === null ? null : volRange(next);
      canvas.setAttribute(
        'aria-label',
        next === null || range === null
          ? 'Implied volatility surface. No surface is loaded.'
          : `Implied volatility surface for ${findInstrument(next.instrumentId)?.symbol ?? next.instrumentId}. ` +
              `${next.expiriesDays.length} expiries by ` +
              `${next.strikeAxis.values.length} points on ${next.strikeAxis.label}. Implied volatility ` +
              `from ${range.min.toFixed(2)}% to ${range.max.toFixed(2)}%. ` +
              'Drag or use the arrow keys to rotate. The data table lists every value.',
      );
      rebuild();
    },
    setSpacing(next) {
      if (next === spacing) return;
      spacing = next;
      rebuild();
    },
    resetView() {
      setCamera(DEFAULT_CAMERA);
    },
    zoom(factor) {
      setCamera(zoomCamera(camera, factor));
    },
    dispose() {
      abort.abort();
      observer.disconnect();
      if (drawHandle !== null) win.cancelAnimationFrame(drawHandle);
      drawHandle = null;
    },
  };
}
