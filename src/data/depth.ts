/**
 * Order-book contracts.
 *
 * Spot FX and spot gold are traded over the counter across many dealers and venues, so
 * there is no consolidated order book. A depth snapshot therefore ALWAYS names the venue
 * it describes, and the UI shows that venue next to the numbers. A provider that cannot
 * supply a genuine, valid book returns `unavailable`; it never returns a guess.
 */

export interface DepthLevel {
  readonly price: number;
  readonly size: number;
}

export interface DepthSnapshot {
  readonly instrumentId: string;
  /** The venue or broker this book belongs to. Required: there is no "market" depth. */
  readonly venue: string;
  /** When the book was observed at the venue (epoch ms). */
  readonly asOf: number;
  /** What `size` is measured in, e.g. "lots" or "oz". */
  readonly sizeUnit: string;
  /** Best (highest) price first. */
  readonly bids: readonly DepthLevel[];
  /** Best (lowest) price first. */
  readonly asks: readonly DepthLevel[];
}

export type DepthResult =
  | { readonly status: 'available'; readonly snapshot: DepthSnapshot }
  | { readonly status: 'unavailable'; readonly reason: string };

function levelIssues(side: 'bid' | 'ask', levels: readonly DepthLevel[]): string[] {
  const issues: string[] = [];
  let previous: number | null = null;
  levels.forEach((level, index) => {
    if (!Number.isFinite(level.price) || level.price <= 0) {
      issues.push(`${side} level ${index} has an invalid price`);
    }
    if (!Number.isFinite(level.size) || level.size <= 0) {
      issues.push(`${side} level ${index} has an invalid size`);
    }
    if (previous !== null && Number.isFinite(level.price)) {
      const ordered = side === 'bid' ? level.price < previous : level.price > previous;
      if (!ordered) issues.push(`${side} levels are not strictly ordered at level ${index}`);
    }
    if (Number.isFinite(level.price)) previous = level.price;
  });
  return issues;
}

/** Returns a list of problems; an empty list means the book is structurally valid. */
export function validateDepthSnapshot(snapshot: DepthSnapshot): string[] {
  const issues: string[] = [];
  if (snapshot.venue.trim() === '') issues.push('book does not name its venue');
  if (!Number.isFinite(snapshot.asOf)) issues.push('book has no valid timestamp');
  if (snapshot.sizeUnit.trim() === '') issues.push('book does not state its size unit');
  if (snapshot.bids.length === 0 || snapshot.asks.length === 0) {
    issues.push('book is one-sided or empty');
    return issues;
  }
  issues.push(...levelIssues('bid', snapshot.bids), ...levelIssues('ask', snapshot.asks));
  const bestBid = snapshot.bids[0]?.price;
  const bestAsk = snapshot.asks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined && bestBid > bestAsk) {
    issues.push('book is crossed (best bid is above best ask)');
  }
  return issues;
}

/** Turns a provider result into one the UI may show: invalid books become `unavailable`. */
export function normalizeDepthResult(result: DepthResult, instrumentId: string): DepthResult {
  if (result.status === 'unavailable') return result;
  if (result.snapshot.instrumentId !== instrumentId) {
    return {
      status: 'unavailable',
      reason: `Provider returned a book for ${result.snapshot.instrumentId}, not ${instrumentId}.`,
    };
  }
  const issues = validateDepthSnapshot(result.snapshot);
  if (issues.length > 0) {
    return {
      status: 'unavailable',
      reason: `Provider returned an invalid order book: ${issues[0] ?? 'unknown problem'}.`,
    };
  }
  return result;
}

export interface CumulativeLevel extends DepthLevel {
  /** Sum of sizes from the best level down to and including this one. */
  readonly cumulative: number;
}

export function withCumulative(levels: readonly DepthLevel[]): readonly CumulativeLevel[] {
  let total = 0;
  return levels.map((level) => {
    total += level.size;
    return { ...level, cumulative: total };
  });
}

/** Best ask minus best bid, or null for an empty or one-sided book. */
export function spreadOf(snapshot: DepthSnapshot): number | null {
  const bid = snapshot.bids[0]?.price;
  const ask = snapshot.asks[0]?.price;
  if (bid === undefined || ask === undefined) return null;
  return ask - bid;
}
