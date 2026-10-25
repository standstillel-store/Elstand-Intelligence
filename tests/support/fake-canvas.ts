/**
 * A recording stand-in for CanvasRenderingContext2D, so the chart renderer can be tested in
 * Node. It draws nothing: it records what the renderer asked for. TEST CODE, NOT PRODUCT CODE.
 */

export interface RecordedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly style: string;
}

export interface RecordedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: string;
  readonly width: number;
  /** The fill style in force when the text was drawn. */
  readonly style: string;
}

export interface RecordedPoint {
  readonly x: number;
  readonly y: number;
}

/** A path that was filled: every point from `moveTo` and `lineTo`, in order. */
export interface RecordedPolygon {
  readonly points: readonly RecordedPoint[];
  readonly style: string;
}

/** A circle that was stroked. */
export interface RecordedArc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly style: string;
  readonly lineWidth: number;
}

export interface RecordedSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly style: string;
  readonly lineWidth: number;
}

/** Every glyph is 6.6 px wide, like an 11 px monospace face. */
export const GLYPH_WIDTH = 6.6;

export class FakeCanvasContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  globalAlpha = 1;

  readonly filled: RecordedRect[] = [];
  readonly stroked: RecordedRect[] = [];
  readonly texts: RecordedText[] = [];
  readonly segments: RecordedSegment[] = [];
  readonly polygons: RecordedPolygon[] = [];
  readonly arcs: RecordedArc[] = [];
  readonly dashes: number[][] = [];
  transform: readonly number[] = [];

  private pathStart: { x: number; y: number } | null = null;
  private pathEnd: { x: number; y: number } | null = null;
  private path: RecordedPoint[] = [];
  private pendingArc: { x: number; y: number; radius: number } | null = null;

  setTransform(...values: number[]): void {
    this.transform = values;
  }
  save(): void {}
  restore(): void {}
  rect(): void {}
  clip(): void {}
  setLineDash(segments: number[]): void {
    this.dashes.push(segments);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * GLYPH_WIDTH };
  }
  beginPath(): void {
    this.pathStart = null;
    this.pathEnd = null;
    this.path = [];
    this.pendingArc = null;
  }
  moveTo(x: number, y: number): void {
    this.pathStart = { x, y };
    this.path.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.pathEnd = { x, y };
    this.path.push({ x, y });
  }
  closePath(): void {}
  arc(x: number, y: number, radius: number): void {
    this.pendingArc = { x, y, radius };
  }
  fill(): void {
    this.polygons.push({ points: [...this.path], style: String(this.fillStyle) });
  }
  stroke(): void {
    if (this.pendingArc !== null) {
      this.arcs.push({
        ...this.pendingArc,
        style: String(this.strokeStyle),
        lineWidth: this.lineWidth,
      });
      this.pendingArc = null;
      return;
    }
    if (this.pathStart === null || this.pathEnd === null) return;
    this.segments.push({
      x1: this.pathStart.x,
      y1: this.pathStart.y,
      x2: this.pathEnd.x,
      y2: this.pathEnd.y,
      style: String(this.strokeStyle),
      lineWidth: this.lineWidth,
    });
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.filled.push({ x, y, width, height, style: String(this.fillStyle) });
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.stroked.push({ x, y, width, height, style: String(this.strokeStyle) });
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({
      text,
      x,
      y,
      align: this.textAlign,
      width: this.measureText(text).width,
      style: String(this.fillStyle),
    });
  }

  asCanvas(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}
