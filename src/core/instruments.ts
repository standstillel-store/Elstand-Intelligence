export type AssetClass = 'fx' | 'metal';

export interface Instrument {
  /** Stable machine id, e.g. `EURUSD`. */
  readonly id: string;
  /** Display symbol, e.g. `EUR/USD`. */
  readonly symbol: string;
  readonly name: string;
  readonly assetClass: AssetClass;
  readonly base: string;
  readonly quote: string;
  /** Decimal places used when displaying a price. */
  readonly pricePrecision: number;
  /** Quote convention worth stating next to the price, if it is not obvious. */
  readonly quoteNote?: string;
  /** Why a consolidated order book does or does not exist for this instrument. */
  readonly depthNote: string;
}

const FX_DEPTH_NOTE =
  'Spot FX is traded over the counter across many dealers and venues, so no single consolidated ' +
  'order book exists. Depth is only meaningful from a named venue, and it describes that venue alone.';

const GOLD_DEPTH_NOTE =
  'Spot gold is quoted over the counter in USD per troy ounce, with liquidity split across ' +
  'venues and brokers. Exchange-traded gold futures (for example COMEX GC) are a different ' +
  'instrument with an expiry and their own order book. They are never substituted for XAU/USD spot.';

function fx(base: string, quote: string, name: string, pricePrecision: number): Instrument {
  return {
    id: `${base}${quote}`,
    symbol: `${base}/${quote}`,
    name,
    assetClass: 'fx',
    base,
    quote,
    pricePrecision,
    depthNote: FX_DEPTH_NOTE,
  };
}

/** Phase 1 watchlist, in display order. */
export const INSTRUMENTS: readonly Instrument[] = [
  fx('EUR', 'USD', 'Euro vs US Dollar', 5),
  fx('GBP', 'USD', 'British Pound vs US Dollar', 5),
  fx('USD', 'JPY', 'US Dollar vs Japanese Yen', 3),
  fx('AUD', 'USD', 'Australian Dollar vs US Dollar', 5),
  fx('USD', 'CAD', 'US Dollar vs Canadian Dollar', 5),
  fx('USD', 'CHF', 'US Dollar vs Swiss Franc', 5),
  fx('NZD', 'USD', 'New Zealand Dollar vs US Dollar', 5),
  {
    id: 'XAUUSD',
    symbol: 'XAU/USD',
    name: 'Gold vs US Dollar (spot)',
    assetClass: 'metal',
    base: 'XAU',
    quote: 'USD',
    pricePrecision: 2,
    quoteNote: 'USD per troy ounce',
    depthNote: GOLD_DEPTH_NOTE,
  },
];

export const DEFAULT_INSTRUMENT_ID = 'EURUSD';

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** Finds an instrument by id or display symbol (`EURUSD`, `eur/usd`). */
export function findInstrument(idOrSymbol: string): Instrument | undefined {
  const key = normalizeKey(idOrSymbol);
  return INSTRUMENTS.find((instrument) => instrument.id === key);
}

/**
 * For ids that already passed routing or came from the watchlist. An unknown id here is a
 * programming error, not user input, so it throws instead of inventing an instrument.
 */
export function requireInstrument(idOrSymbol: string): Instrument {
  const instrument = findInstrument(idOrSymbol);
  if (instrument === undefined) throw new Error(`Unknown instrument: ${idOrSymbol}`);
  return instrument;
}

/** Case-insensitive filter on symbol and name; slashes and spaces are ignored. */
export function filterInstruments(
  instruments: readonly Instrument[],
  query: string,
): readonly Instrument[] {
  const needle = normalizeKey(query);
  const text = query.trim().toLowerCase();
  if (needle === '' && text === '') return instruments;
  return instruments.filter(
    (instrument) =>
      (needle !== '' && instrument.id.includes(needle)) ||
      (text !== '' && instrument.name.toLowerCase().includes(text)),
  );
}
