import type { ObservationFrequency, ObservationSeries } from '../src/data/observations.js';

/**
 * Which macro series Elstand asks for, and what each one is.
 *
 * A series is listed here only after its provider's documentation was checked for the id, the
 * unit, the frequency and whether it is still being published. Nothing here is a guess about a
 * number: this file holds names and units, never values. A series a provider has stopped
 * publishing is not listed, which is why most currencies other than USD and EUR have no policy
 * rate or inflation here: the series FRED offers for them are derived from an OECD feed that is
 * no longer current, and Elstand does not fill the gap with estimates.
 */

export interface SeriesDefinition {
  /** Stable key used on the wire, e.g. `fred:DFEDTARU`. */
  readonly key: string;
  readonly seriesId: string;
  readonly title: string;
  readonly region: string;
  readonly unit: string;
  readonly frequency: ObservationFrequency;
  readonly adjustment: ObservationSeries['adjustment'];
  readonly revisions: string;
  /** The provider's own page for the series, shown as its source. */
  readonly link: string;
}

const fredLink = (id: string): string => `https://fred.stlouisfed.org/series/${id}`;

export const FRED_SERIES: readonly SeriesDefinition[] = [
  {
    key: 'fred:DFEDTARU',
    seriesId: 'DFEDTARU',
    title: 'Federal funds target range, upper limit',
    region: 'United States',
    unit: 'percent',
    frequency: 'daily',
    adjustment: 'not seasonally adjusted',
    revisions: 'A policy rate is a decision, not an estimate, so it is not revised.',
    link: fredLink('DFEDTARU'),
  },
  {
    key: 'fred:ECBDFR',
    seriesId: 'ECBDFR',
    title: 'ECB deposit facility rate',
    region: 'Euro area',
    unit: 'percent',
    frequency: 'daily',
    adjustment: 'not seasonally adjusted',
    revisions: 'A policy rate is a decision, not an estimate, so it is not revised.',
    link: fredLink('ECBDFR'),
  },
  {
    key: 'fred:CPIAUCNS',
    seriesId: 'CPIAUCNS',
    title: 'Consumer price index for all urban consumers, all items',
    region: 'United States',
    unit: 'index, 1982–1984 = 100',
    frequency: 'monthly',
    adjustment: 'not seasonally adjusted',
    revisions:
      'The not-seasonally-adjusted index is not revised after publication; the first-release date ' +
      'is kept where FRED supplies it.',
    link: fredLink('CPIAUCNS'),
  },
  {
    key: 'fred:CP0000EZ19M086NEST',
    seriesId: 'CP0000EZ19M086NEST',
    title: 'Harmonised index of consumer prices, all items',
    region: 'Euro area',
    unit: 'index, 2015 = 100',
    frequency: 'monthly',
    adjustment: 'not seasonally adjusted',
    revisions:
      'Eurostat can revise published values; the first-release date is kept where FRED supplies it.',
    link: fredLink('CP0000EZ19M086NEST'),
  },
];

/** How far back each FRED series is read, in days: enough for a year-on-year change, no more. */
export const FRED_LOOKBACK_DAYS: Readonly<Record<ObservationFrequency, number>> = {
  daily: 60,
  monthly: 800,
  quarterly: 1_500,
  annual: 3_000,
};

const blsLink = (id: string): string => `https://data.bls.gov/timeseries/${id}`;

export const BLS_SERIES: readonly SeriesDefinition[] = [
  {
    key: 'bls:LNS14000000',
    seriesId: 'LNS14000000',
    title: 'Unemployment rate',
    region: 'United States',
    unit: 'percent',
    frequency: 'monthly',
    adjustment: 'seasonally adjusted',
    revisions:
      'Seasonally adjusted values are revised each year; BLS gives no publication dates, so none are kept.',
    link: blsLink('LNS14000000'),
  },
  {
    key: 'bls:CES0000000001',
    seriesId: 'CES0000000001',
    title: 'All employees, total nonfarm',
    region: 'United States',
    unit: 'thousands of persons',
    frequency: 'monthly',
    adjustment: 'seasonally adjusted',
    revisions:
      'Payrolls are revised in the two months after first publication and again each year; BLS ' +
      'gives no publication dates, so none are kept.',
    link: blsLink('CES0000000001'),
  },
  {
    key: 'bls:CUUR0000SA0',
    seriesId: 'CUUR0000SA0',
    title: 'Consumer price index for all urban consumers, all items',
    region: 'United States',
    unit: 'index, 1982–1984 = 100',
    frequency: 'monthly',
    adjustment: 'not seasonally adjusted',
    revisions:
      'The not-seasonally-adjusted index is not revised after publication; BLS gives no ' +
      'publication dates, so none are kept.',
    link: blsLink('CUUR0000SA0'),
  },
];

/** How many calendar years of BLS months are asked for (the keyless endpoint allows ten). */
export const BLS_YEARS_BACK = 2;

export interface BeaDefinition extends SeriesDefinition {
  readonly table: string;
  readonly seriesCode: string;
  readonly lineNumber: string;
  /** What the unit text of every row must contain, so a redefined series is rejected. */
  readonly unitContains: string;
}

export const BEA_SERIES: readonly BeaDefinition[] = [
  {
    key: 'bea:T10101:A191RL',
    seriesId: 'A191RL',
    title: 'Real gross domestic product, change from the preceding quarter (annual rate)',
    region: 'United States',
    unit: 'percent change, annual rate',
    frequency: 'quarterly',
    adjustment: 'seasonally adjusted',
    revisions:
      'GDP is revised several times after first publication; BEA shows the current vintage and ' +
      'gives no publication dates, so none are kept.',
    link: 'https://www.bea.gov/data/gdp/gross-domestic-product',
    table: 'T10101',
    seriesCode: 'A191RL',
    lineNumber: '1',
    unitContains: 'Percent change',
  },
];

/** BEA is asked for this many calendar years ending with the current one. */
export const BEA_YEARS_BACK = 3;

export interface WorldBankIndicator {
  readonly id: string;
  readonly title: string;
  readonly unit: string;
  readonly revisions: string;
}

export const WORLD_BANK_INDICATORS: readonly WorldBankIndicator[] = [
  {
    id: 'NY.GDP.MKTP.KD.ZG',
    title: 'GDP growth',
    unit: 'percent per year',
    revisions:
      'Revised by national statistical offices; the World Bank gives no publication dates.',
  },
  {
    id: 'FP.CPI.TOTL.ZG',
    title: 'Inflation, consumer prices',
    unit: 'percent per year',
    revisions:
      'Revised by national statistical offices; the World Bank gives no publication dates.',
  },
];

export interface WorldBankCountry {
  readonly code: string;
  readonly name: string;
}

export const WORLD_BANK_COUNTRIES: readonly WorldBankCountry[] = [
  { code: 'USA', name: 'United States' },
  { code: 'EMU', name: 'Euro area' },
  { code: 'GBR', name: 'United Kingdom' },
  { code: 'JPN', name: 'Japan' },
  { code: 'CAN', name: 'Canada' },
  { code: 'AUS', name: 'Australia' },
  { code: 'CHE', name: 'Switzerland' },
  { code: 'NZL', name: 'New Zealand' },
];

/** The two most recent non-empty annual values are read per country. */
export const WORLD_BANK_LATEST = 2;

export const worldBankLink = (indicator: string): string =>
  `https://data.worldbank.org/indicator/${indicator}`;

/** ECB euro foreign exchange reference rates, quoted per one US dollar. */
export const REFERENCE_BASE = 'USD';
export const REFERENCE_SYMBOLS: readonly string[] = [
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
];
export const REFERENCE_SOURCE_LINK = 'https://frankfurter.dev';

// ---- the macro bubbles ------------------------------------------------------------------------------

/** A currency Elstand can draw as a bubble: its policy rate and inflation series, and its pair. */
export interface BubbleCurrency {
  readonly currency: string;
  readonly policyRate: SeriesDefinition;
  readonly inflation: SeriesDefinition;
  /** The instrument whose daily candles give the one-month change against the base currency. */
  readonly pairId: string;
}

const byKey = (key: string): SeriesDefinition => {
  const found = FRED_SERIES.find((series) => series.key === key);
  if (found === undefined) throw new Error(`The FRED catalog has no series ${key}.`);
  return found;
};

/** Every price change is measured against this currency, so it has no change of its own. */
export const BUBBLE_BASE = 'USD';

export const BUBBLE_CURRENCIES: readonly BubbleCurrency[] = [
  {
    currency: 'EUR',
    policyRate: byKey('fred:ECBDFR'),
    inflation: byKey('fred:CP0000EZ19M086NEST'),
    pairId: 'EURUSD',
  },
];

/** Currencies of the watchlist for which no current policy-rate and inflation series is listed. */
export const BUBBLE_UNCOVERED: readonly string[] = ['GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

export const USD_OMISSION =
  'Every price change here is measured against the US dollar, so USD has no one-month change to ' +
  'draw. Its policy rate and inflation are shown in the macro series table.';

export const UNCOVERED_OMISSION =
  'No current policy-rate and consumer-price series is configured for this currency: the ones ' +
  'FRED offers are no longer updated, and Elstand does not estimate missing values.';

/** The one-month change is measured between daily closes this many days apart. */
export const PRICE_CHANGE_DAYS = 30;
/** A base bar further back than this is not "one month ago", and the change is not drawn. */
export const PRICE_CHANGE_MAX_DAYS = 37;
