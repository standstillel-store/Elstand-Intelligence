import { findInstrument, type Instrument } from '../src/core/instruments.js';
import { formatUtcDate } from '../src/core/format.js';
import {
  formatProviderTime,
  staleMessage,
  type ProviderId,
  type ProviderState,
} from '../src/core/provider-state.js';
import type { Candle } from '../src/core/types.js';
import {
  validateBubblePoints,
  type BubbleOmission,
  type BubbleResult,
  type CurrencyMacroPoint,
} from '../src/data/macro-bubbles.js';
import {
  OBSERVATION_STALE_AFTER_DAYS,
  isObservationStale,
  latestPoint,
  validateSeries,
  yearOnYear,
  type ObservationFrequency,
  type ObservationPoint,
  type ObservationSeries,
} from '../src/data/observations.js';
import type { Provenance } from '../src/data/provenance.js';
import { fetchBeaSeries } from './bea.js';
import { fetchBlsSeries } from './bls.js';
import { ApiFailure } from './errors.js';
import { loadCandles } from './forex-service.js';
import { fetchFredObservations } from './fred.js';
import {
  BEA_SERIES,
  BEA_YEARS_BACK,
  BLS_SERIES,
  BLS_YEARS_BACK,
  BUBBLE_BASE,
  BUBBLE_CURRENCIES,
  BUBBLE_UNCOVERED,
  FRED_LOOKBACK_DAYS,
  FRED_SERIES,
  PRICE_CHANGE_DAYS,
  PRICE_CHANGE_MAX_DAYS,
  UNCOVERED_OMISSION,
  USD_OMISSION,
  WORLD_BANK_COUNTRIES,
  WORLD_BANK_INDICATORS,
  WORLD_BANK_LATEST,
  worldBankLink,
  type SeriesDefinition,
  type WorldBankIndicator,
} from './macro-catalog.js';
import { readProvider } from './provider-registry.js';
import {
  credentialOf,
  severityOf,
  through,
  unreadyProvenance,
  worstProvenance,
  type Outcome,
  type ServiceDeps,
} from './service.js';
import { fetchWorldBankIndicator } from './worldbank.js';

/**
 * Macro observations and the macro bubbles.
 *
 * Every series is asked for through the shared request path (cache, budget, bounded retry, last
 * verified answer) and carries its own provenance. Two things are decided here and nowhere else:
 *
 *  - How OLD a datum may be is decided per series, from its frequency, because a policy rate that
 *    has not changed for a month is current and a monthly index that is four months old is not.
 *    A value older than its window is still real and is still shown, labelled STALE.
 *  - A value Elstand derives (a year-on-year change, a one-month price change) is never presented
 *    as better than its worst input: if an input is STALE or CACHED, so is the result.
 *
 * Nothing here fills a gap. A series that was not answered has an entry with no values and the
 * reason; a bubble that cannot be computed from real inputs is listed as omitted, with the reason.
 */

export const MACRO_PROVIDERS = ['fred', 'bls', 'bea', 'worldbank'] as const;
export type MacroProviderId = (typeof MACRO_PROVIDERS)[number];

export function isMacroProvider(value: unknown): value is MacroProviderId {
  return typeof value === 'string' && (MACRO_PROVIDERS as readonly string[]).includes(value);
}

export const MACRO_ENDPOINT: Readonly<Record<MacroProviderId, string>> = {
  fred: 'series/observations',
  bls: 'timeseries/data',
  bea: 'data/NIPA',
  worldbank: 'country/indicator',
};

export const BUBBLES_ENDPOINT = 'bubbles';

const DAY_MS = 86_400_000;
const DEGRADED_SHARE_MS = 30_000;

export interface MacroEntry {
  /** Stable key, e.g. `fred:DFEDTARU`. */
  readonly key: string;
  readonly title: string;
  readonly region: string;
  /** The provider's own page for the series. */
  readonly link: string;
  readonly provenance: Provenance;
  /** The observations, or null when the provider did not answer for this series. */
  readonly series: ObservationSeries | null;
}

export interface MacroAnswer {
  readonly provider: MacroProviderId;
  /** The worst state among the entries, or the reason the provider was not asked. */
  readonly provenance: Provenance;
  readonly entries: readonly MacroEntry[];
  readonly shareMs: number;
}

interface SeriesMeta {
  readonly seriesId: string;
  readonly title: string;
  readonly unit: string;
  readonly frequency: ObservationFrequency;
  readonly adjustment: ObservationSeries['adjustment'];
  readonly revisions: string;
}

export interface SeriesGroup {
  readonly series: readonly ObservationSeries[];
  /** Ids that were asked for and not answered with usable data. */
  readonly missing: readonly string[];
}

const httpOf = (deps: ServiceDeps): { fetch: typeof fetch; now: () => number } => ({
  fetch: deps.fetch,
  now: deps.now,
});

function buildSeries(
  provider: ProviderId,
  label: string,
  meta: SeriesMeta,
  points: readonly ObservationPoint[],
  now: number,
): ObservationSeries {
  if (points.length === 0) {
    throw new ApiFailure(
      'provider_error',
      `${label} returned no usable observations for ${meta.seriesId}.`,
    );
  }
  const series: ObservationSeries = {
    provider,
    seriesId: meta.seriesId,
    title: meta.title,
    unit: meta.unit,
    frequency: meta.frequency,
    adjustment: meta.adjustment,
    revisions: meta.revisions,
    retrievedAt: now,
    points,
  };
  const issues = validateSeries(series, now);
  if (issues.length > 0) {
    throw new ApiFailure(
      'provider_error',
      `${label} sent a series that did not validate: ${issues[0] ?? 'unknown'}.`,
    );
  }
  return series;
}

function newestDate(series: ObservationSeries): number | null {
  return latestPoint(series)?.date ?? null;
}

function newestOfGroup(group: SeriesGroup): number | null {
  let newest: number | null = null;
  for (const series of group.series) {
    const date = newestDate(series);
    if (date !== null && (newest === null || date > newest)) newest = date;
  }
  return newest;
}

/**
 * The provenance of one series: the answer's own, with the datum's age judged against the window
 * for THIS series. An answer that is current as a request can still carry an old datum.
 */
export function judgeDatum(base: Provenance, series: ObservationSeries, now: number): Provenance {
  const newest = newestDate(series);
  const withDatum: Provenance = { ...base, dataAsOf: newest };
  if (newest === null || !isObservationStale(series.frequency, newest, now)) return withDatum;
  if (base.state === 'CACHED') {
    return { ...withDatum, state: 'STALE', message: staleMessage(base.retrievedAt ?? now) };
  }
  if (base.state === 'LIVE' || base.state === 'DELAYED' || base.state === 'CALCULATED') {
    const window = OBSERVATION_STALE_AFTER_DAYS[series.frequency];
    const retrieved = base.retrievedAt === null ? 'unknown' : formatProviderTime(base.retrievedAt);
    return {
      ...withDatum,
      state: 'STALE',
      message: `STALE — The newest observation is for ${formatUtcDate(newest)}, older than ${window} days. Last successful retrieval: ${retrieved}.`,
    };
  }
  return withDatum;
}

// ---- one request per provider --------------------------------------------------------------------

export function loadFredSeries(
  deps: ServiceDeps,
  definition: SeriesDefinition,
): Promise<Outcome<ObservationSeries>> {
  return through<ObservationSeries>(deps, {
    provider: 'fred',
    capability: 'macro-observations',
    endpoint: MACRO_ENDPOINT.fred,
    dataClass: 'macro-series',
    cacheKey: `fred:${definition.seriesId}`,
    // The age of the datum is judged per series afterwards (`judgeDatum`).
    isCurrent: () => true,
    dataAsOf: newestDate,
    load: async (ready) => {
      const points = await fetchFredObservations(
        httpOf(deps),
        { apiKey: credentialOf(ready), baseUrl: ready.baseUrl },
        { seriesId: definition.seriesId, lookbackDays: FRED_LOOKBACK_DAYS[definition.frequency] },
      );
      return buildSeries('fred', ready.spec.label, definition, points, deps.now());
    },
  });
}

export function loadBlsGroup(deps: ServiceDeps): Promise<Outcome<SeriesGroup>> {
  return through<SeriesGroup>(deps, {
    provider: 'bls',
    capability: 'macro-observations',
    endpoint: MACRO_ENDPOINT.bls,
    dataClass: 'macro-series',
    cacheKey: 'bls:catalog',
    isCurrent: () => true,
    dataAsOf: newestOfGroup,
    load: async (ready) => {
      const now = deps.now();
      const year = new Date(now).getUTCFullYear();
      const result = await fetchBlsSeries(
        httpOf(deps),
        { baseUrl: ready.baseUrl, apiKey: ready.apiKey },
        {
          seriesIds: BLS_SERIES.map((definition) => definition.seriesId),
          startYear: year - BLS_YEARS_BACK,
          endYear: year,
        },
      );
      const series: ObservationSeries[] = [];
      const missing: string[] = [...result.missing];
      for (const definition of BLS_SERIES) {
        const points = result.series.get(definition.seriesId);
        if (points !== undefined && points.length > 0) {
          series.push(buildSeries('bls', ready.spec.label, definition, points, now));
        } else if (!missing.includes(definition.seriesId)) {
          missing.push(definition.seriesId);
        }
      }
      return { series, missing };
    },
  });
}

export function loadBeaGroup(deps: ServiceDeps): Promise<Outcome<SeriesGroup>> {
  return through<SeriesGroup>(deps, {
    provider: 'bea',
    capability: 'macro-observations',
    endpoint: MACRO_ENDPOINT.bea,
    dataClass: 'macro-series',
    cacheKey: 'bea:catalog',
    // One request per series in the catalog.
    cost: BEA_SERIES.length,
    isCurrent: () => true,
    dataAsOf: newestOfGroup,
    load: async (ready) => {
      const now = deps.now();
      const last = new Date(now).getUTCFullYear();
      const years = Array.from({ length: BEA_YEARS_BACK }, (_, index) => last - index).reverse();
      const series: ObservationSeries[] = [];
      const missing: string[] = [];
      for (const definition of BEA_SERIES) {
        const points = await fetchBeaSeries(
          httpOf(deps),
          { baseUrl: ready.baseUrl, apiKey: credentialOf(ready) },
          {
            table: definition.table,
            seriesCode: definition.seriesCode,
            lineNumber: definition.lineNumber,
            years,
            unitContains: definition.unitContains,
          },
        );
        if (points.length > 0) {
          series.push(buildSeries('bea', ready.spec.label, definition, points, now));
        } else {
          missing.push(definition.seriesId);
        }
      }
      return { series, missing };
    },
  });
}

function worldBankId(indicator: WorldBankIndicator, code: string): string {
  return `${indicator.id}/${code}`;
}

export function loadWorldBankGroup(
  deps: ServiceDeps,
  indicator: WorldBankIndicator,
): Promise<Outcome<SeriesGroup>> {
  return through<SeriesGroup>(deps, {
    provider: 'worldbank',
    capability: 'macro-observations',
    endpoint: MACRO_ENDPOINT.worldbank,
    dataClass: 'macro-series',
    cacheKey: `worldbank:${indicator.id}`,
    isCurrent: () => true,
    dataAsOf: newestOfGroup,
    load: async (ready) => {
      const now = deps.now();
      const result = await fetchWorldBankIndicator(
        httpOf(deps),
        { baseUrl: ready.baseUrl },
        {
          countries: WORLD_BANK_COUNTRIES.map((country) => country.code),
          indicator: indicator.id,
          latest: WORLD_BANK_LATEST,
        },
      );
      const series: ObservationSeries[] = [];
      const missing: string[] = [];
      for (const country of WORLD_BANK_COUNTRIES) {
        const points = result.series.get(country.code);
        const id = worldBankId(indicator, country.code);
        if (points === undefined || points.length === 0) {
          missing.push(id);
          continue;
        }
        series.push(
          buildSeries(
            'worldbank',
            ready.spec.label,
            {
              seriesId: id,
              title: `${indicator.title} — ${country.name}`,
              unit: indicator.unit,
              frequency: 'annual',
              adjustment: null,
              revisions: indicator.revisions,
            },
            points,
            now,
          ),
        );
      }
      return { series, missing };
    },
  });
}

// ---- entries ---------------------------------------------------------------------------------------

interface EntryDefinition {
  readonly key: string;
  readonly seriesId: string;
  readonly title: string;
  readonly region: string;
  readonly link: string;
}

function withheldEntry(definition: EntryDefinition, provenance: Provenance): MacroEntry {
  return {
    key: definition.key,
    title: definition.title,
    region: definition.region,
    link: definition.link,
    provenance,
    series: null,
  };
}

function entryOf(
  definition: EntryDefinition,
  series: ObservationSeries,
  provenance: Provenance,
  now: number,
): MacroEntry {
  return {
    key: definition.key,
    title: definition.title,
    region: definition.region,
    link: definition.link,
    provenance: judgeDatum(provenance, series, now),
    series,
  };
}

/** A series the provider answered without: its own state, not a copy of the group's good news. */
function notAnswered(base: Provenance, definition: EntryDefinition): Provenance {
  return {
    ...base,
    state: 'UNAVAILABLE',
    dataAsOf: null,
    message: `UNAVAILABLE — ${base.providerLabel} returned no usable data for ${definition.seriesId}.`,
  };
}

function groupEntries(
  definitions: readonly EntryDefinition[],
  outcome: Outcome<SeriesGroup>,
  now: number,
): MacroEntry[] {
  if (outcome.kind === 'withheld') {
    return definitions.map((definition) => withheldEntry(definition, outcome.provenance));
  }
  return definitions.map((definition) => {
    const series = outcome.value.series.find((item) => item.seriesId === definition.seriesId);
    return series === undefined
      ? withheldEntry(definition, notAnswered(outcome.provenance, definition))
      : entryOf(definition, series, outcome.provenance, now);
  });
}

function sharedFor(outcomes: readonly Outcome<unknown>[]): number {
  let share = Number.POSITIVE_INFINITY;
  for (const outcome of outcomes) {
    share = Math.min(share, outcome.kind === 'data' ? outcome.shareMs : DEGRADED_SHARE_MS);
  }
  return Number.isFinite(share) ? share : DEGRADED_SHARE_MS;
}

export async function loadMacro(
  deps: ServiceDeps,
  provider: MacroProviderId,
): Promise<MacroAnswer> {
  const reading = readProvider(provider, deps.env);
  if (reading.kind !== 'ready') {
    return {
      provider,
      provenance: unreadyProvenance(
        provider,
        'macro-observations',
        MACRO_ENDPOINT[provider],
        reading,
      ),
      entries: [],
      shareMs: DEGRADED_SHARE_MS,
    };
  }

  let entries: MacroEntry[];
  let outcomes: Outcome<unknown>[];
  if (provider === 'fred') {
    const loaded = await Promise.all(
      FRED_SERIES.map(async (definition) => ({
        definition,
        outcome: await loadFredSeries(deps, definition),
      })),
    );
    const now = deps.now();
    entries = loaded.map(({ definition, outcome }) =>
      outcome.kind === 'data'
        ? entryOf(definition, outcome.value, outcome.provenance, now)
        : withheldEntry(definition, outcome.provenance),
    );
    outcomes = loaded.map((item) => item.outcome);
  } else if (provider === 'bls') {
    const outcome = await loadBlsGroup(deps);
    entries = groupEntries(BLS_SERIES, outcome, deps.now());
    outcomes = [outcome];
  } else if (provider === 'bea') {
    const outcome = await loadBeaGroup(deps);
    entries = groupEntries(BEA_SERIES, outcome, deps.now());
    outcomes = [outcome];
  } else {
    const loaded = await Promise.all(
      WORLD_BANK_INDICATORS.map(async (indicator) => ({
        indicator,
        outcome: await loadWorldBankGroup(deps, indicator),
      })),
    );
    const now = deps.now();
    entries = loaded.flatMap(({ indicator, outcome }) =>
      groupEntries(
        WORLD_BANK_COUNTRIES.map((country) => ({
          key: `worldbank:${worldBankId(indicator, country.code)}`,
          seriesId: worldBankId(indicator, country.code),
          title: `${indicator.title} — ${country.name}`,
          region: country.name,
          link: worldBankLink(indicator.id),
        })),
        outcome,
        now,
      ),
    );
    outcomes = loaded.map((item) => item.outcome);
  }

  const summary = worstProvenance(entries.map((entry) => entry.provenance));
  if (summary === null) {
    throw new ApiFailure('provider_error', 'The macro catalog for this provider is empty.');
  }
  return { provider, provenance: summary, entries, shareMs: sharedFor(outcomes) };
}

// ---- the macro bubbles --------------------------------------------------------------------------------

export interface BubblesAnswer {
  readonly result: BubbleResult;
  /** CALCULATED when drawn from fresh inputs, never better than the worst input; else the cause. */
  readonly provenance: Provenance;
  /** The provenance of every input behind a drawn bubble, one per request. */
  readonly inputs: readonly Provenance[];
  readonly shareMs: number;
}

interface PriceChange {
  readonly percent: number;
  readonly last: Candle;
  readonly base: Candle;
  readonly days: number;
}

/**
 * The change of `currency` against the other currency of the pair over about a month, close to
 * close. Nothing is interpolated: the base is the last daily bar at or before one month earlier,
 * and if that bar is much older, or there is none, there is no change.
 */
export function priceChangeOver(
  candles: readonly Candle[],
  instrument: Instrument,
  currency: string,
): PriceChange | null {
  const last = candles[candles.length - 1];
  if (last === undefined) return null;
  if (instrument.base !== currency && instrument.quote !== currency) return null;
  const target = last.time - PRICE_CHANGE_DAYS * DAY_MS;
  let base: Candle | null = null;
  for (const bar of candles) {
    if (bar.time <= target) base = bar;
    else break;
  }
  if (base === null) return null;
  const days = Math.round((last.time - base.time) / DAY_MS);
  if (days > PRICE_CHANGE_MAX_DAYS) return null;
  const ratio = last.close / base.close;
  if (!Number.isFinite(ratio) || !(ratio > 0)) return null;
  // The pair quotes `quote` per `base`: a rising pair is a rising base and a falling quote.
  const percent = instrument.base === currency ? (ratio - 1) * 100 : (1 / ratio - 1) * 100;
  return { percent, last, base, days };
}

function olderOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function degradedCache(list: readonly Provenance[]): Provenance['cache'] {
  if (list.some((item) => item.cache === 'stale-if-error')) return 'stale-if-error';
  if (list.some((item) => item.cache === 'cache')) return 'cache';
  return 'fresh';
}

function summarizeDrawn(inputs: readonly Provenance[], candlesLabel: string): Provenance {
  const worst = worstProvenance(inputs);
  const state: ProviderState =
    worst !== null && worst.state === 'STALE'
      ? 'STALE'
      : worst !== null && worst.state === 'CACHED'
        ? 'CACHED'
        : 'CALCULATED';
  const message =
    state === 'CALCULATED'
      ? `CALCULATED — Policy rate and CPI levels come from FRED; the year-on-year CPI change and the one-month price change are computed by Elstand from them and from ${candlesLabel} daily closes.`
      : (worst?.message ?? null);
  let retrievedAt: number | null = null;
  let dataAsOf: number | null = null;
  for (const input of inputs) {
    retrievedAt = olderOf(retrievedAt, input.retrievedAt);
    dataAsOf = olderOf(dataAsOf, input.dataAsOf);
  }
  const fallback = inputs.find((input) => input.fallback !== null)?.fallback ?? null;
  return {
    provider: 'fred',
    providerLabel: 'Calculated by Elstand',
    capability: 'macro-observations',
    endpoint: BUBBLES_ENDPOINT,
    state,
    retrievedAt,
    dataAsOf,
    cache: degradedCache(inputs),
    fallback,
    message,
  };
}

function withheldSummary(causes: readonly Provenance[], reason: string): Provenance {
  const worst = worstProvenance(causes);
  if (worst !== null)
    return { ...worst, endpoint: BUBBLES_ENDPOINT, capability: 'macro-observations' };
  return {
    provider: 'fred',
    providerLabel: 'Calculated by Elstand',
    capability: 'macro-observations',
    endpoint: BUBBLES_ENDPOINT,
    state: 'UNAVAILABLE',
    retrievedAt: null,
    dataAsOf: null,
    cache: 'fresh',
    fallback: null,
    message: `UNAVAILABLE — ${reason}`,
  };
}

const NO_YEAR_BASE =
  'The year-on-year CPI change needs the observation twelve months before the newest one, and the ' +
  'provider did not supply it. Elstand does not estimate it.';

const NO_MONTH_BASE =
  'The daily history has no close from about one month before its newest bar, so no one-month ' +
  'price change can be measured. Elstand does not estimate it.';

export async function loadBubbles(deps: ServiceDeps): Promise<BubblesAnswer> {
  const reading = readProvider('fred', deps.env);
  if (reading.kind !== 'ready') {
    return {
      result: { status: 'unavailable', reason: reading.message },
      provenance: unreadyProvenance('fred', 'macro-observations', BUBBLES_ENDPOINT, reading),
      inputs: [],
      shareMs: DEGRADED_SHARE_MS,
    };
  }

  const now = deps.now();
  const omitted: BubbleOmission[] = [
    { currency: BUBBLE_BASE, reason: USD_OMISSION },
    ...BUBBLE_UNCOVERED.map((currency) => ({ currency, reason: UNCOVERED_OMISSION })),
  ];
  const points: CurrencyMacroPoint[] = [];
  const used: Provenance[] = [];
  const failed: Provenance[] = [];
  const outcomes: Outcome<unknown>[] = [];
  let candlesLabel = 'daily';

  for (const entry of BUBBLE_CURRENCIES) {
    const instrument = findInstrument(entry.pairId);
    if (instrument === undefined) {
      throw new Error(`The bubble catalog names an unknown instrument: ${entry.pairId}`);
    }
    const [policy, inflation, candles] = await Promise.all([
      loadFredSeries(deps, entry.policyRate),
      loadFredSeries(deps, entry.inflation),
      loadCandles(deps, instrument, 'D1'),
    ]);
    outcomes.push(policy, inflation, candles);

    const withheld = [policy, inflation, candles].flatMap((outcome) =>
      outcome.kind === 'withheld' ? [outcome.provenance] : [],
    );
    if (policy.kind !== 'data' || inflation.kind !== 'data' || candles.kind !== 'data') {
      failed.push(...withheld);
      omitted.push({
        currency: entry.currency,
        reason:
          `An input could not be retrieved. ${withheld.map((item) => item.message ?? '').join(' ')}`.trim(),
      });
      continue;
    }

    const policyProvenance = judgeDatum(policy.provenance, policy.value, now);
    const inflationProvenance = judgeDatum(inflation.provenance, inflation.value, now);
    const newestRate = latestPoint(policy.value);
    const yoy = yearOnYear(inflation.value);
    const change = priceChangeOver(candles.value, instrument, entry.currency);
    if (newestRate === null) {
      omitted.push({
        currency: entry.currency,
        reason: 'The policy-rate series has no observation.',
      });
      continue;
    }
    if (yoy === null) {
      omitted.push({ currency: entry.currency, reason: NO_YEAR_BASE });
      continue;
    }
    if (change === null) {
      omitted.push({ currency: entry.currency, reason: NO_MONTH_BASE });
      continue;
    }

    const rateSource = {
      name: `${policy.value.title} (FRED ${policy.value.seriesId})`,
      url: entry.policyRate.link,
      retrievedAt: policy.value.retrievedAt,
    };
    const cpiSource = {
      name: `${inflation.value.title} (FRED ${inflation.value.seriesId}); year-on-year change computed by Elstand`,
      url: entry.inflation.link,
      retrievedAt: inflation.value.retrievedAt,
    };
    const candlesProvenance = candles.provenance;
    candlesLabel = candlesProvenance.providerLabel;
    const priceSource = {
      name: `${candlesProvenance.providerLabel} ${instrument.symbol} daily closes; change computed by Elstand`,
      url: null,
      retrievedAt: candlesProvenance.retrievedAt ?? now,
    };
    const point: CurrencyMacroPoint = {
      currency: entry.currency,
      policyRate: { value: newestRate.value, asOf: newestRate.date, source: rateSource },
      cpiYoY: { value: yoy.percent, asOf: yoy.latest.date, source: cpiSource },
      priceChange1m: {
        value: change.percent,
        asOf: change.last.time,
        source: priceSource,
        basis: `vs ${instrument.base === entry.currency ? instrument.quote : instrument.base}, close to close, ${change.days} days (${formatUtcDate(change.base.time)} to ${formatUtcDate(change.last.time)})`,
      },
    };
    const issues = validateBubblePoints([point]);
    if (issues.length > 0) {
      omitted.push({
        currency: entry.currency,
        reason: `The computed values did not validate: ${issues[0] ?? 'unknown'}.`,
      });
      continue;
    }
    points.push(point);
    used.push(policyProvenance, inflationProvenance, candlesProvenance);
  }

  if (points.length === 0) {
    const first = failed[0];
    const reason =
      first !== undefined && first.message !== null
        ? `No bubble can be drawn. ${first.message}`
        : `No bubble can be drawn. ${omitted.map((item) => `${item.currency}: ${item.reason}`).join(' ')}`;
    return {
      result: { status: 'unavailable', reason },
      provenance: withheldSummary(failed, reason),
      inputs: [],
      shareMs: DEGRADED_SHARE_MS,
    };
  }
  const degraded = used.some((item) => severityOf(item.state) >= severityOf('CACHED'));
  return {
    result: { status: 'available', points, omitted },
    provenance: summarizeDrawn(used, candlesLabel),
    inputs: used,
    shareMs: degraded ? DEGRADED_SHARE_MS : sharedFor(outcomes),
  };
}
