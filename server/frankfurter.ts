import { ApiFailure } from './errors.js';
import { DAY_MS, invalidData, isRecord, parseDecimalText, parseIsoDate } from './parse.js';
import { callProvider, type HttpDeps } from './provider-http.js';

/**
 * Frankfurter adapter (https://frankfurter.dev): the European Central Bank's daily euro foreign
 * exchange reference rates, as a public API.
 *
 * No key and no credential of any kind. `FRANKFURTER_API_BASE_URL` can point at a self-hosted
 * instance, but the built-in address is the public one.
 *
 *   GET latest?base=USD&symbols=EUR,GBP      { amount, base, date, rates: { EUR: 0.86, ... } }
 *
 * These are REFERENCE rates: one fixing per ECB working day, published around 16:00 CET. They
 * are shown as reference data and are never used in place of a quote or a candle. A request
 * made on a weekend or a holiday is answered with the last fixing, and its `date` says so.
 */

export const FRANKFURTER_LABEL = 'Frankfurter';

export interface FrankfurterConfig {
  readonly baseUrl: string;
}

export interface ReferenceRate {
  readonly currency: string;
  /** Units of `currency` per one unit of the base. */
  readonly rate: number;
}

export interface ReferenceRates {
  readonly base: string;
  /** The day of the fixing, 00:00 UTC. */
  readonly date: number;
  /** Currencies that were asked for and not answered. */
  readonly missing: readonly string[];
  readonly rates: readonly ReferenceRate[];
}

const CODE = /^[A-Z]{3}$/;

export function parseFrankfurterRates(
  body: unknown,
  base: string,
  symbols: readonly string[],
  now: number,
): ReferenceRates {
  if (!isRecord(body) || !isRecord(body['rates'])) {
    throw invalidData(FRANKFURTER_LABEL, 'the response has no rates');
  }
  if (body['base'] !== base)
    throw invalidData(FRANKFURTER_LABEL, 'the base currency is not the one asked for');
  if (body['amount'] !== 1) throw invalidData(FRANKFURTER_LABEL, 'the amount is not 1');
  const date = parseIsoDate(body['date']);
  if (date === null) throw invalidData(FRANKFURTER_LABEL, 'the fixing date is not valid');
  if (date > now + DAY_MS)
    throw invalidData(FRANKFURTER_LABEL, 'the fixing is dated in the future');

  const rates: ReferenceRate[] = [];
  for (const [currency, raw] of Object.entries(body['rates'])) {
    if (!symbols.includes(currency)) {
      throw invalidData(FRANKFURTER_LABEL, `it answered for an unrequested currency ${currency}`);
    }
    const rate = parseDecimalText(raw);
    if (rate === null || !(rate > 0)) {
      throw invalidData(FRANKFURTER_LABEL, `the rate for ${currency} is not a positive number`);
    }
    rates.push({ currency, rate });
  }
  if (rates.length === 0) throw invalidData(FRANKFURTER_LABEL, 'the response holds no rates');
  const answered = new Set(rates.map((entry) => entry.currency));
  return { base, date, rates, missing: symbols.filter((symbol) => !answered.has(symbol)) };
}

export async function fetchReferenceRates(
  http: HttpDeps,
  config: FrankfurterConfig,
  base: string,
  symbols: readonly string[],
): Promise<ReferenceRates> {
  if (!CODE.test(base) || symbols.length === 0 || !symbols.every((code) => CODE.test(code))) {
    throw new ApiFailure('bad_request', 'The reference-rate request is not valid.');
  }
  const response = await callProvider(http, {
    label: FRANKFURTER_LABEL,
    baseUrl: config.baseUrl,
    path: 'latest',
    query: { base, symbols: symbols.join(',') },
    secrets: [],
  });
  return parseFrankfurterRates(response.body, base, symbols, http.now());
}
