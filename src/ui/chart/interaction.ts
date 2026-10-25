import { panBy, zoomAt, type Viewport } from './geometry.js';
import {
  clearHover,
  hoverBar,
  hoverIndexOf,
  jumpHover,
  pageBars,
  panModel,
  resetView,
  setViewport,
  stepHover,
  zoomAnchor,
  zoomModel,
  type ChartModel,
} from './model.js';
import type { Frame } from './renderer.js';

/**
 * Pointer, wheel and keyboard input for the chart canvas, translated into model operations.
 * It owns no state beyond the gesture in progress: the model lives in the panel.
 *
 *   mouse        move: crosshair · drag: pan · Ctrl/Cmd + wheel: zoom · Shift + wheel or sideways
 *                wheel: pan · double-click: reset. A plain vertical wheel is left alone so the
 *                page still scrolls.
 *   touch        drag: pan · two fingers: zoom · tap: crosshair
 *   keyboard     ← →: move the crosshair (Shift: 10 bars) · Home / End: first / newest bar ·
 *                PageUp / PageDown: pan · + −: zoom · 0: reset · Escape: clear the crosshair
 */

export interface InteractionHost {
  readonly canvas: HTMLCanvasElement;
  model(): ChartModel;
  /** The last drawn frame, for converting pixels to bars. Null when nothing is drawn. */
  frame(): Frame | null;
  /** Installs a new model; the host redraws. */
  update(next: ChartModel): void;
  /** Called after the keyboard moves the crosshair, so assistive technology can read the bar. */
  announce(index: number): void;
}

const DRAG_THRESHOLD_PX = 3;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_RATE = 0.0022;
const WHEEL_LINE_PX = 16;

interface Point {
  x: number;
  y: number;
}

interface Drag {
  readonly id: number;
  readonly startX: number;
  readonly startViewport: Viewport;
  readonly barWidth: number;
  moved: boolean;
}

interface Pinch {
  readonly startDistance: number;
  readonly startViewport: Viewport;
  readonly anchorBar: number;
}

export function attachChartInteraction(host: InteractionHost): () => void {
  const { canvas } = host;
  const pointers = new Map<number, Point>();
  let drag: Drag | null = null;
  let pinch: Pinch | null = null;

  const local = (event: MouseEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const setDragging = (on: boolean): void => {
    canvas.setAttribute('data-dragging', String(on));
  };

  /** Crosshair at a pixel position; outside the plot or beyond the data it is cleared. */
  const hoverAt = (x: number, y: number): void => {
    const frame = host.frame();
    const model = host.model();
    if (frame === null) return;
    const { plot } = frame.scale.layout;
    const barSpace = frame.scale.barSpaceAt(x);
    const inside =
      x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height;
    if (!inside || barSpace < 0 || barSpace >= model.candles.length) {
      host.update(clearHover(model));
      return;
    }
    host.update(hoverBar(model, Math.floor(barSpace), y));
  };

  const distanceBetween = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

  const startPinch = (): void => {
    const frame = host.frame();
    const [first, second] = [...pointers.values()];
    if (frame === null || first === undefined || second === undefined) return;
    const distance = distanceBetween(first, second);
    if (distance < 1) return;
    drag = null;
    setDragging(true);
    pinch = {
      startDistance: distance,
      startViewport: host.model().viewport,
      anchorBar: frame.scale.barSpaceAt((first.x + second.x) / 2),
    };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const frame = host.frame();
    if (frame === null) return;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The browser refused capture (the pointer already ended). Dragging still works without it.
    }
    const point = local(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      drag = {
        id: event.pointerId,
        startX: point.x,
        startViewport: host.model().viewport,
        barWidth: frame.scale.barWidth,
        moved: false,
      };
    } else if (pointers.size === 2) {
      startPinch();
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const point = local(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);

    if (pinch !== null && pointers.size >= 2) {
      const [first, second] = [...pointers.values()];
      if (first === undefined || second === undefined) return;
      const distance = distanceBetween(first, second);
      if (distance < 1) return;
      const model = host.model();
      // Fingers apart (distance grows) means fewer, larger bars: a factor below 1.
      host.update(
        setViewport(
          clearHover(model),
          zoomAt(
            pinch.startViewport,
            pinch.anchorBar,
            pinch.startDistance / distance,
            model.candles.length,
          ),
        ),
      );
      return;
    }

    if (drag !== null && drag.id === event.pointerId) {
      const dx = point.x - drag.startX;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        setDragging(true);
      }
      const model = clearHover(host.model());
      host.update(
        setViewport(model, panBy(drag.startViewport, -dx / drag.barWidth, model.candles.length)),
      );
      return;
    }

    if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
      if (pointers.size === 0) hoverAt(point.x, point.y);
    }
  };

  const endPointer = (event: PointerEvent, cancelled: boolean): void => {
    const point = local(event);
    const wasTap = drag !== null && drag.id === event.pointerId && !drag.moved && !cancelled;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    if (pinch !== null && pointers.size < 2) {
      pinch = null;
      // The finger left behind keeps panning from where it is now.
      const [remaining] = [...pointers.entries()];
      const frame = host.frame();
      if (remaining !== undefined && frame !== null) {
        drag = {
          id: remaining[0],
          startX: remaining[1].x,
          startViewport: host.model().viewport,
          barWidth: frame.scale.barWidth,
          moved: true,
        };
        return;
      }
    }
    if (drag !== null && drag.id === event.pointerId) drag = null;
    if (pointers.size === 0) setDragging(false);

    // A touch has no hover, so a tap is how a finger reads a bar.
    if (wasTap && event.pointerType !== 'mouse') hoverAt(point.x, point.y);
  };

  const onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && drag === null && pinch === null) {
      host.update(clearHover(host.model()));
    }
  };

  const onDoubleClick = (): void => {
    host.update(resetView(host.model()));
  };

  const onWheel = (event: WheelEvent): void => {
    const frame = host.frame();
    const model = host.model();
    if (frame === null || model.candles.length === 0) return;
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : 1;
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as a Ctrl + wheel event, so this also covers pinch on a laptop.
      event.preventDefault();
      const delta = Math.max(-120, Math.min(120, event.deltaY * unit));
      const anchor = frame.scale.barSpaceAt(local(event).x);
      host.update(zoomModel(clearHover(model), anchor, Math.exp(delta * WHEEL_ZOOM_RATE)));
      return;
    }
    const sideways =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.shiftKey
          ? event.deltaY
          : 0;
    if (sideways === 0) return;
    event.preventDefault();
    host.update(panModel(clearHover(model), (sideways * unit) / frame.scale.barWidth));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const model = host.model();
    if (model.candles.length === 0) return;
    const fast = event.shiftKey;
    let next: ChartModel;
    switch (event.key) {
      case 'ArrowLeft':
        next = stepHover(model, fast ? -10 : -1);
        break;
      case 'ArrowRight':
        next = stepHover(model, fast ? 10 : 1);
        break;
      case 'Home':
        next = jumpHover(model, 'first');
        break;
      case 'End':
        next = jumpHover(model, 'last');
        break;
      case 'PageUp':
        next = panModel(model, -pageBars(model));
        break;
      case 'PageDown':
        next = panModel(model, pageBars(model));
        break;
      case '+':
      case '=':
        next = zoomModel(model, zoomAnchor(model), 1 / ZOOM_STEP);
        break;
      case '-':
      case '_':
        next = zoomModel(model, zoomAnchor(model), ZOOM_STEP);
        break;
      case '0':
        next = resetView(model);
        break;
      case 'Escape':
        next = clearHover(model);
        break;
      default:
        return;
    }
    event.preventDefault();
    host.update(next);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const index = hoverIndexOf(next);
      if (index !== null) host.announce(index);
    }
  };

  const onUp = (event: PointerEvent): void => endPointer(event, false);
  const onCancel = (event: PointerEvent): void => endPointer(event, true);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  // Not passive: Ctrl + wheel must be stopped from zooming the whole page.
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('wheel', onWheel);
    pointers.clear();
    drag = null;
    pinch = null;
  };
}
