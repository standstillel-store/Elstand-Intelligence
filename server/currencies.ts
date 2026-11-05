/**
 * The currencies Elstand recognizes in provider data (ISO 4217 codes).
 *
 * A provider symbol is turned into currencies only when every code in it is on this list. A code
 * that is not listed leaves the item untagged: guessing which currency an unfamiliar symbol means
 * would be inventing a fact.
 */
export const TRACKED_CURRENCIES: readonly string[] = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
  'CNY',
  'HKD',
  'SGD',
  'NOK',
  'SEK',
  'DKK',
  'INR',
  'KRW',
  'MXN',
  'BRL',
  'ZAR',
  'TRY',
  'PLN',
];

export function isTrackedCurrency(code: string): boolean {
  return TRACKED_CURRENCIES.includes(code);
}

const SINGLE = /^[A-Z]{3}$/;
const PAIR = /^([A-Z]{3})[/\-_]?([A-Z]{3})(=X)?$/;

/**
 * The currencies a provider symbol names: "EUR" gives EUR, "EURUSD", "EUR/USD" and "EURUSD=X"
 * give EUR and USD. Anything else, including a pair with an unlisted code, gives none.
 */
export function currenciesOfSymbol(symbol: string): string[] {
  const text = symbol.trim().toUpperCase();
  if (SINGLE.test(text)) return isTrackedCurrency(text) ? [text] : [];
  const pair = PAIR.exec(text);
  if (pair === null) return [];
  const base = pair[1] as string;
  const quote = pair[2] as string;
  return isTrackedCurrency(base) && isTrackedCurrency(quote) && base !== quote ? [base, quote] : [];
}
