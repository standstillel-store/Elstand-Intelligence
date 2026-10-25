import type { Candle } from '../core/types.js';
import type { Quote } from './provider.js';

/**
 * Provider output is untrusted. These checks run at the boundary and the results are shown
 * as errors; bad data is never silently repaired, because a repaired price is a made-up price.
 */

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Returns a list of problems; an empty list means the series is structurally valid. */
export function validateCandles(candles: readonly Candle[]): string[] {
  const issues: string[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle === undefined) continue;
    const { time, open, high, low, close } = candle;
    if (!Number.isFinite(time)) {
      issues.push(`bar ${index} has an invalid time`);
      continue;
    }
    if (![open, high, low, close].every(isPositiveFinite)) {
      issues.push(`bar ${index} has a non-positive or non-finite price`);
      continue;
    }
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      issues.push(`bar ${index} violates high/low bounds`);
    }
    if (time <= previousTime) issues.push(`bar ${index} is out of order or duplicated`);
    previousTime = time;
    if (issues.length >= 5) break;
  }
  return issues;
}

export function validateQuote(quote: Quote): string[] {
  const issues: string[] = [];
  if (!isPositiveFinite(quote.last)) issues.push('invalid last price');
  if (!Number.isFinite(quote.asOf)) issues.push('invalid timestamp');
  const hasBid = quote.bid !== null;
  const hasAsk = quote.ask !== null;
  if (hasBid !== hasAsk) issues.push('only one side of bid/ask supplied');
  if (quote.bid !== null && quote.ask !== null) {
    if (!isPositiveFinite(quote.bid) || !isPositiveFinite(quote.ask)) {
      issues.push('invalid bid/ask');
    } else if (quote.bid > quote.ask) {
      issues.push('bid is above ask');
    }
  }
  if (quote.changePct !== null && !Number.isFinite(quote.changePct)) {
    issues.push('invalid change percent');
  }
  if (quote.changeAbs !== null && !Number.isFinite(quote.changeAbs)) {
    issues.push('invalid change');
  }
  return issues;
}
