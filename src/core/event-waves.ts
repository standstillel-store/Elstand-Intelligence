import { formatAge } from './format.js';

/**
 * How the event-proximity waves are drawn. A wave is a picture of one thing only: how close a
 * scheduled event is. It is not measured volatility, not implied volatility and not a forecast of
 * what a price will do. Nothing here reads a market: the inputs are an event's scheduled time
 * (which the calendar provider stated) and the clock.
 */

/** A wave starts to rise this long before the event. */
export const WAVE_HORIZON_MS = 24 * 3_600_000;

/** After the event the wave settles back to flat over this long. */
export const WAVE_SETTLE_MS = 3_600_000;

/** The least an event must say about itself to be drawn: a stated instant, and not cancelled. */
export interface WaveSubject {
  readonly timeMs: number;
  readonly timePrecision?: 'exact' | 'date';
  readonly status?: string;
}

/**
 * Only an event with a time the source stated can have a proximity. A date-only event has a
 * placeholder instant, and a cancelled event is not going to happen, so neither gets a wave.
 */
export function isWaveEligible(event: WaveSubject): boolean {
  return event.timePrecision !== 'date' && event.status !== 'cancelled';
}

/**
 * 0 when the event is more than the horizon away, rising linearly to 1 at the scheduled
 * instant, then falling linearly back to 0 over the settle window. Always within [0, 1].
 */
export function waveProximity(eventMs: number, nowMs: number): number {
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return 0;
  const ahead = eventMs - nowMs;
  if (ahead >= 0) return ahead >= WAVE_HORIZON_MS ? 0 : 1 - ahead / WAVE_HORIZON_MS;
  const behind = -ahead;
  return behind >= WAVE_SETTLE_MS ? 0 : 1 - behind / WAVE_SETTLE_MS;
}

/** "in 2h 05m", "now", or "12m 03s ago": the distance between the clock and the event. */
export function countdownText(eventMs: number, nowMs: number): string {
  const delta = eventMs - nowMs;
  if (!Number.isFinite(delta)) return '—';
  if (Math.abs(delta) < 1000) return 'now';
  return delta > 0 ? `in ${formatAge(delta)}` : `${formatAge(-delta)} ago`;
}

export const WAVE_WIDTH = 120;
export const WAVE_HEIGHT = 24;
const WAVE_CYCLES = 3;
const WAVE_STEP = 2;

/**
 * An SVG path for the wave: a sine of fixed length whose height is `amplitude` (0 to 1) of the
 * available height, and a straight line at 0. It is deterministic: the same proximity always
 * draws the same wave, and nothing about it moves.
 */
export function wavePath(amplitude: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(amplitude) ? amplitude : 0));
  const middle = WAVE_HEIGHT / 2;
  const reach = (WAVE_HEIGHT / 2 - 2) * clamped;
  const points: string[] = [];
  for (let x = 0; x <= WAVE_WIDTH; x += WAVE_STEP) {
    const y = middle - reach * Math.sin((2 * Math.PI * WAVE_CYCLES * x) / WAVE_WIDTH);
    points.push(`${x === 0 ? 'M' : 'L'}${x},${y.toFixed(2)}`);
  }
  return points.join(' ');
}
