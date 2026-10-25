/**
 * TEST FIXTURES. NOT MARKET DATA.
 *
 * Elstand ships no simulated or sample data: with nothing connected the product shows
 * "ENV NOT CONNECTION". These fixtures exist only so unit and browser tests can exercise code
 * paths that need a datum, such as validation, rendering and the connected data path. They are
 * deterministic on purpose (no randomness) and must never be imported from `src/`.
 * `scripts/build.ts` fails the build if any file under `tests/` reaches the bundle.
 */
import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../../src/core/types.js';
import type { DepthSnapshot } from '../../src/data/depth.js';
import type { CurrencyMacroPoint } from '../../src/data/macro-bubbles.js';
import type { CalendarEvent, NewsItem, SourceAttribution } from '../../src/data/macro.js';
import type { VolSurface } from '../../src/data/options.js';
import type { MarketDataProvider, Quote } from '../../src/data/provider.js';
import type { AnalysisRequest, ConclusionState } from '../../src/elvoid/contracts.js';

/** A fixed instant, so nothing in a test depends on the wall clock. */
export const FIXTURE_NOW = Date.UTC(2026, 0, 6, 12, 0, 0);

/** A structurally valid series ending at `endOpen`. The shape is a fixed wave, not a model. */
export function fixtureCandles(
  count: number,
  timeframe: Timeframe,
  endOpen: number = FIXTURE_NOW,
): Candle[] {
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.05 + Math.sin(index / 4);
    return {
      time: endOpen - (count - 1 - index) * step,
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + 0.2,
    };
  });
}

export function fixtureQuote(instrumentId = 'EURUSD', overrides: Partial<Quote> = {}): Quote {
  return {
    instrumentId,
    last: 1.1,
    bid: null,
    ask: null,
    changeBasis: 'prev. close',
    changeAbs: 0.001,
    changePct: 0.09,
    asOf: FIXTURE_NOW,
    marketOpen: true,
    ...overrides,
  };
}

export function fixtureProvider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  const base: MarketDataProvider = {
    info: { id: 'fixture', label: 'Test fixture', mode: 'live', staleAfterMs: 60_000 },
    getQuotes: async (ids) => ({
      quotes: ids.map((id) => fixtureQuote(id)),
      failures: new Map<string, string>(),
    }),
    getCandles: async (request) => ({
      instrumentId: request.instrumentId,
      timeframe: request.timeframe,
      candles: fixtureCandles(Math.min(request.limit, 50), request.timeframe),
    }),
    getDepth: async () => ({ status: 'unavailable', reason: 'The fixture has no order book.' }),
  };
  return { ...base, ...overrides };
}

/** A small explicit grid: 3 expiries by 5 strikes. */
export function fixtureSurface(instrumentId = 'EURUSD'): VolSurface {
  return {
    instrumentId,
    asOf: FIXTURE_NOW,
    source: 'test fixture, not market data',
    strikeAxis: { kind: 'log-moneyness', label: 'ln(K/F)', values: [-0.04, -0.02, 0, 0.02, 0.04] },
    expiriesDays: [7, 30, 90],
    iv: [
      [9.4, 8.6, 8.1, 8.4, 9.0],
      [9.9, 9.1, 8.6, 8.8, 9.3],
      [10.4, 9.6, 9.1, 9.3, 9.8],
    ],
  };
}

/** A valid two-sided book. The venue name says out loud that it is not a market. */
export function fixtureDepth(
  instrumentId = 'EURUSD',
  overrides: Partial<DepthSnapshot> = {},
): DepthSnapshot {
  return {
    instrumentId,
    venue: 'Test venue (fixture, not a market)',
    asOf: FIXTURE_NOW - 5_000,
    sizeUnit: 'lots',
    bids: [
      { price: 1.0843, size: 2 },
      { price: 1.08428, size: 5 },
      { price: 1.08425, size: 3.5 },
      { price: 1.0842, size: 8 },
      { price: 1.08415, size: 4 },
    ],
    asks: [
      { price: 1.08432, size: 1.5 },
      { price: 1.08435, size: 4 },
      { price: 1.0844, size: 6.5 },
      { price: 1.08445, size: 2 },
      { price: 1.0845, size: 9 },
    ],
    ...overrides,
  };
}

/** A larger grid than `fixtureSurface`: 5 expiries by 7 points, with a smile and a term slope. */
export function fixtureSurfaceLarge(instrumentId = 'EURUSD'): VolSurface {
  const strikes = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06];
  const expiries = [7, 30, 90, 180, 365];
  return {
    instrumentId,
    asOf: FIXTURE_NOW - 60_000,
    source: 'test fixture, not market data',
    strikeAxis: { kind: 'log-moneyness', label: 'ln(K/F)', values: strikes },
    expiriesDays: expiries,
    iv: expiries.map((_days, row) =>
      strikes.map((strike) => Number((7 + row * 0.8 + 900 * strike * strike).toFixed(2))),
    ),
  };
}

function attribution(name: string, retrievedAt = FIXTURE_NOW - 120_000): SourceAttribution {
  return { name, url: 'https://example.invalid/source', retrievedAt };
}

/** Five currencies with obviously fictional numbers and a named (fictional) source each. */
export function fixtureBubblePoints(): CurrencyMacroPoint[] {
  const observed = FIXTURE_NOW - 86_400_000;
  const point = (
    currency: string,
    rate: number,
    cpi: number,
    change: number,
  ): CurrencyMacroPoint => ({
    currency,
    policyRate: { value: rate, asOf: observed, source: attribution('Fixture rates office') },
    cpiYoY: { value: cpi, asOf: observed, source: attribution('Fixture statistics office') },
    priceChange1m: {
      value: change,
      asOf: FIXTURE_NOW,
      source: attribution('Fixture price series'),
      basis: 'vs USD, close to close',
    },
  });
  return [
    point('USD', 4.5, 3.1, 0),
    point('EUR', 2.5, 2.2, 1.4),
    point('JPY', -0.1, 2.9, -3.2),
    point('GBP', 4.75, 3.4, 0.6),
    point('AUD', 4.1, 3.6, -0.9),
  ];
}

/** Calendar events: two rated, one unrated, one carrying an interpretation, one unattributed. */
export function fixtureCalendar(): CalendarEvent[] {
  const event = (
    id: string,
    hoursFromNow: number,
    currency: string,
    title: string,
    overrides: Partial<CalendarEvent> = {},
  ): CalendarEvent => ({
    id,
    timeMs: FIXTURE_NOW + hoursFromNow * 3_600_000,
    currency,
    country: null,
    title,
    impact: { level: 'high', classifiedBy: 'Fixture calendar rating' },
    actual: null,
    forecast: '2.1%',
    previous: '2.0%',
    source: attribution('Fixture calendar'),
    elvoidInterpretation: null,
    ...overrides,
  });
  return [
    event('ev-1', 2, 'USD', 'Fixture inflation release', { country: 'US', actual: '2.3%' }),
    event('ev-2', 26, 'EUR', 'Fixture policy statement', {
      impact: { level: 'medium', classifiedBy: 'Fixture calendar rating' },
    }),
    event('ev-3', 50, 'JPY', 'Fixture trade balance', {
      impact: null,
      forecast: null,
      previous: null,
    }),
    event('ev-4', 74, 'GBP', 'Fixture labour report', {
      elvoidInterpretation: 'Interpretation text supplied for the test.',
    }),
    event('ev-bad', 90, 'USD', 'Fixture unattributed event', {
      source: { name: '', url: null, retrievedAt: FIXTURE_NOW },
    }),
  ];
}

export function fixtureNews(): NewsItem[] {
  const item = (
    id: string,
    minutesAgo: number,
    headline: string,
    currencies: string[],
    overrides: Partial<NewsItem> = {},
  ): NewsItem => ({
    id,
    publishedAt: FIXTURE_NOW - minutesAgo * 60_000,
    headline,
    currencies,
    source: attribution('Fixture wire'),
    url: 'https://example.invalid/story',
    impact: null,
    elvoidInterpretation: null,
    ...overrides,
  });
  return [
    item('n-1', 10, 'Fixture headline about the dollar', ['USD']),
    item('n-2', 45, 'Fixture headline about the euro', ['EUR'], {
      impact: { level: 'low', classifiedBy: 'Fixture wire desk' },
    }),
    item('n-3', 90, 'Fixture headline with an unsafe link', ['JPY'], {
      url: 'javascript:alert(1)',
    }),
    item('n-4', 120, 'Fixture headline with no currency', []),
  ];
}

/**
 * What a fixture ELVOID engine returns: a result that satisfies every rule in
 * `validateAnalysisResult`, whatever the conclusion. It is `unknown`-shaped on purpose (an
 * engine returns `unknown`), so tests can add or remove fields to break exactly one rule. The
 * text is labelled as a fixture; no engine exists in Phase 1 and this is not an analysis.
 */
export function fixtureAnalysisResult(
  request: AnalysisRequest,
  conclusion: ConclusionState = 'WAIT',
): Record<string, unknown> {
  return {
    id: `analysis-${request.instrumentId}-${request.timeframe}`,
    engine: { id: 'fixture-engine', version: '0.0.0-test' },
    instrumentId: request.instrumentId,
    timeframe: request.timeframe,
    requestedAt: request.requestedAt,
    completedAt: request.requestedAt + 1500,
    evidence: [
      {
        id: 'E1',
        kind: 'market-data',
        summary: 'Fixture evidence about price.',
        sourceId: 'fixture-feed',
        observedAt: FIXTURE_NOW - 1000,
        dataState: 'live',
      },
      {
        id: 'E2',
        kind: 'macro',
        summary: 'Fixture macro evidence.',
        sourceId: 'fixture-macro',
        observedAt: FIXTURE_NOW - 3_600_000,
        dataState: 'delayed',
      },
    ],
    technical: { summary: 'Fixture technical context.', evidenceIds: ['E1'] },
    macro: { summary: 'Fixture macro context.', evidenceIds: ['E2'] },
    bullish: { summary: 'Fixture bullish case.', evidenceIds: ['E1'] },
    bearish: { summary: 'Fixture bearish case.', evidenceIds: ['E2'] },
    invalidations: [{ description: 'Fixture invalidation condition.', evidenceIds: ['E1'] }],
    risks: [{ description: 'Fixture risk factor.' }],
    conclusion: { state: conclusion, summary: `Fixture ${conclusion.toLowerCase()} summary.` },
  };
}
