import type { Instrument } from './instruments.js';

/** Shown wherever a value is missing. Never substitute a zero or a guess. */
export const NO_VALUE = '—';

type PriceFormat = Pick<Instrument, 'pricePrecision' | 'assetClass'>;

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(digits: number, grouping: boolean): Intl.NumberFormat {
  const key = `${digits}:${grouping}`;
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping,
    });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** Price with the instrument's own precision. Metals use thousands separators; FX does not. */
export function formatPrice(value: number | null | undefined, instrument: PriceFormat): string {
  if (isMissing(value)) return NO_VALUE;
  return numberFormatter(instrument.pricePrecision, instrument.assetClass === 'metal').format(
    value,
  );
}

/** Signed price difference, e.g. `+0.00123`. Zero is shown without a sign. */
export function formatSignedPrice(
  delta: number | null | undefined,
  instrument: PriceFormat,
): string {
  if (isMissing(delta)) return NO_VALUE;
  const rounded = Number(delta.toFixed(instrument.pricePrecision));
  const text = numberFormatter(instrument.pricePrecision, instrument.assetClass === 'metal').format(
    Math.abs(rounded),
  );
  if (rounded === 0) return text;
  return `${rounded > 0 ? '+' : '-'}${text}`;
}

/** Signed percentage, e.g. `+0.34%`. Uses ASCII minus so values copy and paste cleanly. */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return NO_VALUE;
  const rounded = Number(value.toFixed(digits));
  const text = numberFormatter(digits, false).format(Math.abs(rounded));
  if (rounded === 0) return `${text}%`;
  return `${rounded > 0 ? '+' : '-'}${text}%`;
}

export type Direction = 'up' | 'down' | 'flat' | 'none';

/**
 * The direction a figure is shown to move, judged on the rounded value that is displayed, so
 * a change shown as `0.00%` is never colored as a gain or a loss.
 */
export function directionOf(value: number | null | undefined, digits = 2): Direction {
  if (isMissing(value)) return 'none';
  const rounded = Number(value.toFixed(digits));
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
}

/** Plain number with fixed digits and thousands separators. */
export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (isMissing(value)) return NO_VALUE;
  return numberFormatter(digits, true).format(value);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `2026-01-02` in UTC. */
export function formatUtcDate(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

/** `21:00` or `21:00:05` in UTC. */
export function formatUtcTime(timeMs: number, withSeconds = false): string {
  const iso = new Date(timeMs).toISOString();
  return withSeconds ? iso.slice(11, 19) : iso.slice(11, 16);
}

/** `2026-01-02 21:00 UTC`. Every timestamp in the terminal is UTC unless it says otherwise. */
export function formatUtcDateTime(timeMs: number): string {
  if (!Number.isFinite(timeMs)) return NO_VALUE;
  return `${formatUtcDate(timeMs)} ${formatUtcTime(timeMs)} UTC`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `02 Jan` in UTC. */
export function formatUtcDayMonth(timeMs: number): string {
  const date = new Date(timeMs);
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''}`;
}

/** Wall-clock time in a given IANA zone, with the zone name, e.g. `02 Jan 2026, 21:00 GMT+7`. */
export function formatZoned(timeMs: number, timeZone?: string): string {
  if (!Number.isFinite(timeMs)) return NO_VALUE;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  };
  if (timeZone !== undefined) options.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', options).format(new Date(timeMs));
}

/** Compact age such as `12s`, `3m 05s`, `2h 05m`, `3d 4h`. */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return NO_VALUE;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
