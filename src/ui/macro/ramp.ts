/**
 * The sequential color ramp for implied volatility: low values are dark green, high values
 * pale green. It is one hue so it reads as "more of the same thing", and lightness rises
 * monotonically so the order survives grayscale and color-vision deficiency. Every value is
 * checked in tests/unit/macro-ramp.test.ts (monotone lightness, no step below 1.2:1, and the
 * darkest stop at least 3:1 against the canvas and panel backgrounds).
 */
export const RAMP_STOPS = [
  '#256f3a',
  '#3c7c4c',
  '#579766',
  '#72b380',
  '#8ed09c',
  '#abeeb8',
  '#d4ffdc',
] as const;

type Rgb = readonly [number, number, number];

function parse(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const STOPS_RGB: readonly Rgb[] = RAMP_STOPS.map(parse);

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/** Color for `t` in [0, 1] (clamped; NaN reads as 0), interpolated between the stops. */
export function rampColor(t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const position = clamped * (STOPS_RGB.length - 1);
  const lower = Math.min(STOPS_RGB.length - 2, Math.floor(position));
  const fraction = position - lower;
  const a = STOPS_RGB[lower];
  const b = STOPS_RGB[lower + 1];
  if (a === undefined || b === undefined) return RAMP_STOPS[0];
  return `#${toHex(a[0] + (b[0] - a[0]) * fraction)}${toHex(a[1] + (b[1] - a[1]) * fraction)}${toHex(a[2] + (b[2] - a[2]) * fraction)}`;
}

/** CSS gradient for the legend bar, left (low) to right (high). */
export function rampGradient(): string {
  return `linear-gradient(to right, ${RAMP_STOPS.join(', ')})`;
}

/** WCAG relative luminance of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parse(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
