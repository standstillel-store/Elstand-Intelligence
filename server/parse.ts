import { ApiFailure } from './errors.js';

/**
 * Strict parsing helpers shared by the provider adapters.
 *
 * A provider's answer is untrusted input. A number that does not parse, a date that does not
 * exist or a field that is missing is an error, never a default: a wrong value shown as real is
 * worse than no value. Every failure here is an `ApiFailure` of code `provider_error`, whose
 * message names the provider and the problem and never repeats the provider's raw text.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidData(label: string, what: string): ApiFailure {
  return new ApiFailure('provider_error', `${label} returned unusable data: ${what}.`);
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;
const GROUPED_DECIMAL = /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/;

/** A plain decimal, as a number or a string. Anything else (including "NaN", "1e3", "") is null. */
export function parseDecimalText(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Like `parseDecimalText`, and also accepts thousands separators ("1,234.5"), as BEA writes them. */
export function parseGroupedDecimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!GROUPED_DECIMAL.test(text)) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const EARLIEST_PLAUSIBLE_MS = Date.UTC(1900, 0, 1);

/** "2026-10-26" to the start of that day in UTC. Calendar overflow (Feb 31) is rejected. */
export function parseIsoDate(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = ISO_DATE.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  const roundTrips =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return roundTrips && ms >= EARLIEST_PLAUSIBLE_MS ? ms : null;
}

/** An instant written with an explicit zone ("2026-10-26T12:30:00Z" or "+00:00"). Anything else is null. */
export function parseZonedInstant(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE_MS ? ms : null;
}

export function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const DAY_MS = 86_400_000;

/** Text meant for people: control characters removed, length bounded. */
export function cleanLabel(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return null;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/**
 * A link the interface may show: https, a host, no credentials, no whitespace. Provider links
 * are untrusted text, so anything else is dropped rather than repaired.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 500 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

/** A whole number from a header such as `X-RateLimit-Remaining`, or null. */
export function parseWholeNumber(text: string | null): number | null {
  if (text === null || !/^\d{1,12}$/.test(text.trim())) return null;
  return Number(text.trim());
}

/**
 * An instant from a field the provider documents as UTC. It accepts an explicit zone, and also
 * the zone-less `YYYY-MM-DD HH:MM[:SS]` form, which is read as UTC because the field is. Use
 * this only for fields whose name or documentation says UTC; anywhere else a missing zone is a
 * reason to reject the value.
 */
export function parseUtcField(text: unknown): number | null {
  const zoned = parseZonedInstant(text);
  if (zoned !== null) return zoned;
  if (typeof text !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text.trim());
  if (match === null) return null;
  const day = parseIsoDate(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (day === null || hour > 23 || minute > 59 || second > 59) return null;
  return day + ((hour * 60 + minute) * 60 + second) * 1000;
}
