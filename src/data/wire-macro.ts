import { carriesData, isProviderId, type ProviderId } from '../core/provider-state.js';
import {
  validateBubblePoints,
  type BubbleOmission,
  type BubbleResult,
  type CurrencyMacroPoint,
} from './macro-bubbles.js';
import type {
  CalendarEvent,
  EventStatus,
  EventSurprise,
  EventTimePrecision,
  ImpactClassification,
  NewsItem,
  ProviderSentiment,
  SourceAttribution,
  SourceRights,
} from './macro.js';
import {
  isObservationFrequency,
  type ObservationPoint,
  type ObservationSeries,
} from './observations.js';
import { parseProvenance, type Provenance } from './provenance.js';
import type { Parsed } from './wire.js';

/**
 * The contract between the capability endpoints of the Elstand server and the browser: the
 * economic calendar, the news feed, macro observations, the macro bubbles and the reference
 * exchange rates.
 *
 * Every answer is an envelope of `provenance` (which provider answered, when, in which state)
 * and `data`. A provider that was not heard from is not an HTTP error, because "the provider has
 * no credential" and "the provider is rate limited" are states of the product, not faults of the
 * request: the envelope says so in `provenance` and carries `data: null`.
 *
 * The browser validates everything again. Data with a state that cannot carry data, or a state
 * that claims data with none, is rejected, so a mislabelled answer never reaches a screen.
 */

export const API_CALENDAR_PATH = '/api/calendar';
export const API_NEWS_PATH = '/api/news';
export const API_MACRO_PATH = '/api/macro';
export const API_BUBBLES_PATH = '/api/bubbles';
export const API_RATES_PATH = '/api/rates';

export interface WireAttribution {
  readonly name: string;
  readonly url: string;
}

export interface WireExcluded {
  readonly id: string;
  readonly reason: string;
}

export interface WireEnvelope<T> {
  readonly provenance: Provenance;
  /** The data, or null when the provider could not supply it (see `provenance.state`). */
  readonly data: T | null;
}

// ---- the five payloads --------------------------------------------------------------------------------

export interface WireCalendarData {
  readonly events: readonly CalendarEvent[];
  /** Events the provider sent that were not shown because they were incomplete, with why. */
  readonly excluded: readonly WireExcluded[];
  /** The provider's count for the window, which can be more than was read. */
  readonly total: number | null;
  readonly truncated: boolean;
  readonly quota: {
    readonly limit: number | null;
    readonly remaining: number | null;
    readonly tier: string | null;
  };
  readonly attribution: WireAttribution;
}

export interface WireNewsData {
  readonly items: readonly NewsItem[];
  readonly excluded: readonly WireExcluded[];
  /** How many articles matched, which can be more than the plan returns. */
  readonly found: number | null;
  readonly returned: number;
  /** The per-request limit the provider applied. */
  readonly limit: number | null;
  /** What the feed contains, in one sentence. */
  readonly topic: string;
  readonly dailyRemaining: number | null;
  readonly attribution: WireAttribution;
}

export interface WireRatesData {
  /** Units of each currency per one unit of `base`. */
  readonly base: string;
  /** The day of the fixing (00:00 UTC). */
  readonly date: number;
  readonly rates: readonly { readonly currency: string; readonly rate: number }[];
  readonly missing: readonly string[];
  readonly attribution: WireAttribution;
}

export interface WireMacroEntry {
  readonly key: string;
  readonly title: string;
  readonly region: string;
  /** The provider's own page for the series. */
  readonly link: string;
  readonly provenance: Provenance;
  readonly series: ObservationSeries | null;
}

export interface WireMacro {
  readonly provider: ProviderId;
  readonly provenance: Provenance;
  readonly entries: readonly WireMacroEntry[];
}

export interface WireBubbles {
  readonly provenance: Provenance;
  /** The provenance of every input behind a drawn bubble. */
  readonly inputs: readonly Provenance[];
  readonly result: BubbleResult;
}

export type WireCalendar = WireEnvelope<WireCalendarData>;
export type WireNews = WireEnvelope<WireNewsData>;
export type WireRates = WireEnvelope<WireRatesData>;

// ---- small checks -------------------------------------------------------------------------------------

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

/** A string that may be empty, e.g. a figure the source left blank. */
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isTime = (value: unknown): value is number => isNumber(value) && value >= 0;

const isTimeOrNull = (value: unknown): value is number | null => value === null || isTime(value);

const isCount = (value: unknown): value is number => isTime(value) && Number.isInteger(value);

const isCountOrNull = (value: unknown): value is number | null => value === null || isCount(value);

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

const CURRENCY = /^[A-Z]{3}$/;
const IMPACT_LEVELS = ['low', 'medium', 'high'] as const;
const TIME_PRECISIONS: readonly EventTimePrecision[] = ['exact', 'date'];
const EVENT_STATUSES: readonly EventStatus[] = [
  'scheduled',
  'estimated',
  'released',
  'rescheduled',
  'cancelled',
];
const ADJUSTMENTS = ['seasonally adjusted', 'not seasonally adjusted'] as const;
const isAdjustmentOrNull = (value: unknown): value is (typeof ADJUSTMENTS)[number] | null =>
  value === null || oneOf(ADJUSTMENTS, value);

/** A field of a source's rights: absent, or text. Anything else is a malformed answer. */
function rightsText(input: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const value = input[key];
  if (value === undefined) return ok(undefined);
  return isText(value) ? ok(value) : fail(`the ${key} of a source's rights is malformed`);
}

function parseRights(input: unknown): Parsed<SourceRights> {
  if (!isRecord(input)) return fail("a source's rights are not an object");
  const credit = rightsText(input, 'credit');
  if (credit.ok === false) return fail(credit.error);
  const creditUrl = rightsText(input, 'creditUrl');
  if (creditUrl.ok === false) return fail(creditUrl.error);
  const license = rightsText(input, 'license');
  if (license.ok === false) return fail(license.error);
  const licenseUrl = rightsText(input, 'licenseUrl');
  if (licenseUrl.ok === false) return fail(licenseUrl.error);
  const notice = rightsText(input, 'notice');
  if (notice.ok === false) return fail(notice.error);
  return ok({
    ...(credit.value === undefined ? {} : { credit: credit.value }),
    ...(creditUrl.value === undefined ? {} : { creditUrl: creditUrl.value }),
    ...(license.value === undefined ? {} : { license: license.value }),
    ...(licenseUrl.value === undefined ? {} : { licenseUrl: licenseUrl.value }),
    ...(notice.value === undefined ? {} : { notice: notice.value }),
  });
}

function parseSource(input: unknown): Parsed<SourceAttribution> {
  if (!isRecord(input)) return fail('a source is not an object');
  const { name, url, retrievedAt } = input;
  if (!isText(name) || !isTextOrNull(url) || !isTime(retrievedAt)) {
    return fail('a source is malformed');
  }
  const rawRights = input['rights'];
  if (rawRights === undefined) return ok({ name, url, retrievedAt });
  const rights = parseRights(rawRights);
  if (rights.ok === false) return fail(rights.error);
  return ok({ name, url, retrievedAt, rights: rights.value });
}

function parseImpact(input: unknown): Parsed<ImpactClassification | null> {
  if (input === null) return ok(null);
  if (!isRecord(input)) return fail('an impact is not an object');
  const { level, classifiedBy } = input;
  if (!oneOf(IMPACT_LEVELS, level) || !isText(classifiedBy)) return fail('an impact is malformed');
  return ok({ level, classifiedBy });
}

function parseAttribution(input: unknown): Parsed<WireAttribution> {
  if (!isRecord(input) || !isText(input['name']) || !isText(input['url'])) {
    return fail('the attribution is malformed');
  }
  return ok({ name: input['name'], url: input['url'] });
}

function parseExcluded(input: unknown): Parsed<readonly WireExcluded[]> {
  if (!Array.isArray(input)) return fail('the list of excluded items is malformed');
  const list: WireExcluded[] = [];
  for (const entry of input as unknown[]) {
    if (!isRecord(entry) || !isText(entry['id']) || !isText(entry['reason'])) {
      return fail('an excluded item is malformed');
    }
    list.push({ id: entry['id'], reason: entry['reason'] });
  }
  return ok(list);
}

// ---- calendar -----------------------------------------------------------------------------------------

function parseSurprise(input: unknown): Parsed<EventSurprise> {
  if (!isRecord(input)) return fail('a surprise is not an object');
  const { value, unit, basis } = input;
  if (!isNumber(value) || !isText(unit) || !isText(basis)) return fail('a surprise is malformed');
  return ok({ value, unit, basis });
}

function parseEvent(input: unknown): Parsed<CalendarEvent> {
  if (!isRecord(input)) return fail('an event is not an object');
  const { id, timeMs, currency, country, title, actual, forecast, previous } = input;
  if (!isText(id) || !isTime(timeMs) || !isText(title)) return fail('an event is malformed');
  if (!isText(currency) || !CURRENCY.test(currency)) return fail(`event ${id} has no currency`);
  if (!isTextOrNull(country)) return fail(`event ${id} has a malformed country`);
  if (!isStringOrNull(actual) || !isStringOrNull(forecast) || !isStringOrNull(previous)) {
    return fail(`event ${id} has a malformed figure`);
  }
  const interpretation = input['elvoidInterpretation'];
  if (!isTextOrNull(interpretation)) return fail(`event ${id} has a malformed interpretation`);
  const impact = parseImpact(input['impact']);
  if (impact.ok === false) return fail(`event ${id}: ${impact.error}`);
  const source = parseSource(input['source']);
  if (source.ok === false) return fail(`event ${id}: ${source.error}`);

  let precision: EventTimePrecision | undefined;
  const rawPrecision = input['timePrecision'];
  if (rawPrecision !== undefined) {
    if (!oneOf(TIME_PRECISIONS, rawPrecision)) {
      return fail(`event ${id} has an unknown time precision`);
    }
    precision = rawPrecision;
  }
  let status: EventStatus | undefined;
  const rawStatus = input['status'];
  if (rawStatus !== undefined) {
    if (!oneOf(EVENT_STATUSES, rawStatus)) return fail(`event ${id} has an unknown status`);
    status = rawStatus;
  }
  let stage: string | undefined;
  const rawStage = input['stage'];
  if (rawStage !== undefined) {
    if (!isText(rawStage)) return fail(`event ${id} has a malformed stage`);
    stage = rawStage;
  }
  const surpriseInput = input['surprise'];
  let surprise: EventSurprise | undefined;
  if (surpriseInput !== undefined) {
    const parsed = parseSurprise(surpriseInput);
    if (parsed.ok === false) return fail(`event ${id}: ${parsed.error}`);
    surprise = parsed.value;
  }

  return ok({
    id,
    timeMs,
    ...(precision === undefined ? {} : { timePrecision: precision }),
    ...(status === undefined ? {} : { status }),
    ...(stage === undefined ? {} : { stage }),
    ...(surprise === undefined ? {} : { surprise }),
    currency,
    country,
    title,
    impact: impact.value,
    actual,
    forecast,
    previous,
    source: source.value,
    elvoidInterpretation: interpretation,
  });
}

function parseCalendarData(input: unknown): Parsed<WireCalendarData> {
  if (!isRecord(input) || !Array.isArray(input['events'])) {
    return fail('the calendar has no event list');
  }
  const events: CalendarEvent[] = [];
  for (const raw of input['events'] as unknown[]) {
    const parsed = parseEvent(raw);
    if (parsed.ok === false) return fail(parsed.error);
    events.push(parsed.value);
  }
  const excluded = parseExcluded(input['excluded']);
  if (excluded.ok === false) return fail(excluded.error);
  const attribution = parseAttribution(input['attribution']);
  if (attribution.ok === false) return fail(attribution.error);
  const quota = input['quota'];
  if (
    !isRecord(quota) ||
    !isCountOrNull(quota['limit']) ||
    !isCountOrNull(quota['remaining']) ||
    !isTextOrNull(quota['tier'])
  ) {
    return fail('the calendar quota is malformed');
  }
  if (!isCountOrNull(input['total']) || typeof input['truncated'] !== 'boolean') {
    return fail('the calendar totals are malformed');
  }
  return ok({
    events,
    excluded: excluded.value,
    total: input['total'],
    truncated: input['truncated'],
    quota: { limit: quota['limit'], remaining: quota['remaining'], tier: quota['tier'] },
    attribution: attribution.value,
  });
}

// ---- news ---------------------------------------------------------------------------------------------

function parseSentiment(input: unknown): Parsed<ProviderSentiment> {
  if (!isRecord(input) || !isNumber(input['score']) || !isText(input['basis'])) {
    return fail('a sentiment is malformed');
  }
  return ok({ score: input['score'], basis: input['basis'] });
}

function parseNewsItem(input: unknown): Parsed<NewsItem> {
  if (!isRecord(input)) return fail('a news item is not an object');
  const { id, publishedAt, headline, currencies, url } = input;
  if (!isText(id) || !isTime(publishedAt) || !isText(headline)) {
    return fail('a news item is malformed');
  }
  if (
    !Array.isArray(currencies) ||
    !currencies.every((code) => isText(code) && CURRENCY.test(code))
  ) {
    return fail(`news item ${id} lists a malformed currency`);
  }
  if (!isTextOrNull(url)) return fail(`news item ${id} has a malformed link`);
  const interpretation = input['elvoidInterpretation'];
  if (!isTextOrNull(interpretation)) return fail(`news item ${id} has a malformed interpretation`);
  const impact = parseImpact(input['impact']);
  if (impact.ok === false) return fail(`news item ${id}: ${impact.error}`);
  const source = parseSource(input['source']);
  if (source.ok === false) return fail(`news item ${id}: ${source.error}`);
  let publisher: string | undefined;
  const rawPublisher = input['publisher'];
  if (rawPublisher !== undefined) {
    if (!isText(rawPublisher)) return fail(`news item ${id} has a malformed publisher`);
    publisher = rawPublisher;
  }
  let sentiment: ProviderSentiment | undefined;
  if (input['providerSentiment'] !== undefined) {
    const parsed = parseSentiment(input['providerSentiment']);
    if (parsed.ok === false) return fail(`news item ${id}: ${parsed.error}`);
    sentiment = parsed.value;
  }
  return ok({
    id,
    publishedAt,
    headline,
    currencies: currencies as string[],
    source: source.value,
    url,
    impact: impact.value,
    elvoidInterpretation: interpretation,
    ...(publisher === undefined ? {} : { publisher }),
    ...(sentiment === undefined ? {} : { providerSentiment: sentiment }),
  });
}

function parseNewsData(input: unknown): Parsed<WireNewsData> {
  if (!isRecord(input) || !Array.isArray(input['items'])) return fail('the news has no item list');
  const items: NewsItem[] = [];
  for (const raw of input['items'] as unknown[]) {
    const parsed = parseNewsItem(raw);
    if (parsed.ok === false) return fail(parsed.error);
    items.push(parsed.value);
  }
  const excluded = parseExcluded(input['excluded']);
  if (excluded.ok === false) return fail(excluded.error);
  const attribution = parseAttribution(input['attribution']);
  if (attribution.ok === false) return fail(attribution.error);
  if (
    !isCountOrNull(input['found']) ||
    !isCount(input['returned']) ||
    !isCountOrNull(input['limit']) ||
    !isText(input['topic']) ||
    !isCountOrNull(input['dailyRemaining'])
  ) {
    return fail('the news totals are malformed');
  }
  return ok({
    items,
    excluded: excluded.value,
    found: input['found'],
    returned: input['returned'],
    limit: input['limit'],
    topic: input['topic'],
    dailyRemaining: input['dailyRemaining'],
    attribution: attribution.value,
  });
}

// ---- reference rates ----------------------------------------------------------------------------------

function parseRatesData(input: unknown): Parsed<WireRatesData> {
  if (!isRecord(input) || !Array.isArray(input['rates']) || !Array.isArray(input['missing'])) {
    return fail('the reference rates are malformed');
  }
  if (!isText(input['base']) || !CURRENCY.test(input['base']) || !isTime(input['date'])) {
    return fail('the reference rates have no base or date');
  }
  const rates: { currency: string; rate: number }[] = [];
  for (const raw of input['rates'] as unknown[]) {
    if (
      !isRecord(raw) ||
      !isText(raw['currency']) ||
      !CURRENCY.test(raw['currency']) ||
      !isNumber(raw['rate']) ||
      !(raw['rate'] > 0)
    ) {
      return fail('a reference rate is malformed');
    }
    rates.push({ currency: raw['currency'], rate: raw['rate'] });
  }
  const missing = input['missing'] as unknown[];
  if (!missing.every((code) => isText(code))) return fail('the missing list is malformed');
  const attribution = parseAttribution(input['attribution']);
  if (attribution.ok === false) return fail(attribution.error);
  return ok({
    base: input['base'],
    date: input['date'],
    rates,
    missing: missing as string[],
    attribution: attribution.value,
  });
}

// ---- observations -------------------------------------------------------------------------------------

function parsePoint(input: unknown): Parsed<ObservationPoint> {
  if (!isRecord(input)) return fail('an observation is not an object');
  const { date, value, knownFrom } = input;
  if (!isTime(date) || !isNumber(value) || !isTimeOrNull(knownFrom)) {
    return fail('an observation is malformed');
  }
  return ok({ date, value, knownFrom });
}

export function parseSeries(input: unknown): Parsed<ObservationSeries> {
  if (!isRecord(input)) return fail('a series is not an object');
  const { provider, seriesId, title, unit, frequency, adjustment, revisions, retrievedAt } = input;
  if (!isProviderId(provider)) return fail('a series names an unknown provider');
  if (!isText(seriesId) || !isText(title) || !isText(unit) || !isText(revisions)) {
    return fail('a series is missing its id, title, unit or revision note');
  }
  if (!isObservationFrequency(frequency))
    return fail(`series ${seriesId} has an unknown frequency`);
  if (!isAdjustmentOrNull(adjustment)) {
    return fail(`series ${seriesId} has an unknown adjustment`);
  }
  if (!isTime(retrievedAt)) return fail(`series ${seriesId} has no retrieval time`);
  if (!Array.isArray(input['points'])) return fail(`series ${seriesId} has no observations`);
  const points: ObservationPoint[] = [];
  for (const raw of input['points'] as unknown[]) {
    const parsed = parsePoint(raw);
    if (parsed.ok === false) return fail(`series ${seriesId}: ${parsed.error}`);
    points.push(parsed.value);
  }
  return ok({
    provider,
    seriesId,
    title,
    unit,
    frequency,
    adjustment,
    revisions,
    retrievedAt,
    points,
  });
}

// ---- envelopes ----------------------------------------------------------------------------------------

function provenanceOf(input: unknown): Parsed<Provenance> {
  const parsed = parseProvenance(input);
  return parsed.kind === 'parsed' ? ok(parsed.value) : fail(parsed.error);
}

/**
 * Data and state must agree: data comes only with a state that carries data, and a state that
 * carries data must come with some. A mismatch is a mislabelled answer and is rejected.
 */
function consistent(provenance: Provenance, hasData: boolean, what: string): string | null {
  if (hasData && !carriesData(provenance.state)) {
    return `${what} has data although its state is ${provenance.state}`;
  }
  if (!hasData && carriesData(provenance.state)) {
    return `${what} says ${provenance.state} but has no data`;
  }
  return null;
}

function parseEnvelope<T>(
  input: unknown,
  what: string,
  parseData: (data: unknown) => Parsed<T>,
): Parsed<WireEnvelope<T>> {
  if (!isRecord(input)) return fail(`the ${what} answer is not an object`);
  const provenance = provenanceOf(input['provenance']);
  if (provenance.ok === false) return fail(`the ${what} ${provenance.error}`);
  const raw = input['data'];
  if (raw === null) {
    const issue = consistent(provenance.value, false, `the ${what} answer`);
    return issue === null ? ok({ provenance: provenance.value, data: null }) : fail(issue);
  }
  const data = parseData(raw);
  if (data.ok === false) return fail(`the ${what} answer is unusable: ${data.error}`);
  const issue = consistent(provenance.value, true, `the ${what} answer`);
  return issue === null ? ok({ provenance: provenance.value, data: data.value }) : fail(issue);
}

export const parseCalendar = (input: unknown): Parsed<WireCalendar> =>
  parseEnvelope(input, 'calendar', parseCalendarData);

export const parseNews = (input: unknown): Parsed<WireNews> =>
  parseEnvelope(input, 'news', parseNewsData);

export const parseRates = (input: unknown): Parsed<WireRates> =>
  parseEnvelope(input, 'reference-rates', parseRatesData);

export function parseMacro(input: unknown): Parsed<WireMacro> {
  if (!isRecord(input)) return fail('the macro answer is not an object');
  if (!isProviderId(input['provider'])) return fail('the macro answer names an unknown provider');
  const provenance = provenanceOf(input['provenance']);
  if (provenance.ok === false) return fail(`the macro ${provenance.error}`);
  if (!Array.isArray(input['entries'])) return fail('the macro answer has no entry list');
  const entries: WireMacroEntry[] = [];
  const keys = new Set<string>();
  for (const raw of input['entries'] as unknown[]) {
    if (!isRecord(raw)) return fail('a macro entry is not an object');
    const { key, title, region, link } = raw;
    if (!isText(key) || !isText(title) || !isText(region) || !isText(link)) {
      return fail('a macro entry is missing its key, title, region or link');
    }
    if (keys.has(key)) return fail(`macro entry ${key} is listed twice`);
    keys.add(key);
    const entryProvenance = provenanceOf(raw['provenance']);
    if (entryProvenance.ok === false) return fail(`macro entry ${key}: ${entryProvenance.error}`);
    let series: ObservationSeries | null = null;
    if (raw['series'] !== null) {
      const parsed = parseSeries(raw['series']);
      if (parsed.ok === false) return fail(`macro entry ${key}: ${parsed.error}`);
      series = parsed.value;
    }
    const issue = consistent(entryProvenance.value, series !== null, `macro entry ${key}`);
    if (issue !== null) return fail(issue);
    entries.push({ key, title, region, link, provenance: entryProvenance.value, series });
  }
  return ok({ provider: input['provider'], provenance: provenance.value, entries });
}

// ---- bubbles ------------------------------------------------------------------------------------------

function parseAttributedValue(
  input: unknown,
  what: string,
): Parsed<{ value: number; asOf: number; source: SourceAttribution }> {
  if (!isRecord(input) || !isNumber(input['value']) || !isTime(input['asOf'])) {
    return fail(`${what} is malformed`);
  }
  const source = parseSource(input['source']);
  if (source.ok === false) return fail(`${what}: ${source.error}`);
  return ok({ value: input['value'], asOf: input['asOf'], source: source.value });
}

function parseBubblePoint(input: unknown): Parsed<CurrencyMacroPoint> {
  if (!isRecord(input) || !isText(input['currency'])) return fail('a bubble has no currency');
  const code = input['currency'];
  const rate = parseAttributedValue(input['policyRate'], `${code} policy rate`);
  if (rate.ok === false) return fail(rate.error);
  const cpi = parseAttributedValue(input['cpiYoY'], `${code} CPI`);
  if (cpi.ok === false) return fail(cpi.error);
  const change = parseAttributedValue(input['priceChange1m'], `${code} price change`);
  if (change.ok === false) return fail(change.error);
  const basis = isRecord(input['priceChange1m']) ? input['priceChange1m']['basis'] : undefined;
  if (!isText(basis)) return fail(`${code} price change does not state its basis`);
  return ok({
    currency: code,
    policyRate: rate.value,
    cpiYoY: cpi.value,
    priceChange1m: { ...change.value, basis },
  });
}

function parseBubbleResult(input: unknown): Parsed<BubbleResult> {
  if (!isRecord(input)) return fail('the bubble result is not an object');
  if (input['status'] === 'unavailable') {
    return isText(input['reason'])
      ? ok({ status: 'unavailable', reason: input['reason'] })
      : fail('an unavailable bubble result gives no reason');
  }
  if (input['status'] !== 'available' || !Array.isArray(input['points'])) {
    return fail('the bubble result is malformed');
  }
  const points: CurrencyMacroPoint[] = [];
  for (const raw of input['points'] as unknown[]) {
    const parsed = parseBubblePoint(raw);
    if (parsed.ok === false) return fail(parsed.error);
    points.push(parsed.value);
  }
  const issues = validateBubblePoints(points);
  if (issues.length > 0) return fail(issues[0] ?? 'the bubble points do not validate');
  const rawOmitted = input['omitted'];
  if (rawOmitted === undefined) return ok({ status: 'available', points });
  if (!Array.isArray(rawOmitted)) return fail('the omitted list is malformed');
  const omitted: BubbleOmission[] = [];
  for (const entry of rawOmitted as unknown[]) {
    if (
      !isRecord(entry) ||
      !isText(entry['currency']) ||
      !CURRENCY.test(entry['currency']) ||
      !isText(entry['reason'])
    ) {
      return fail('an omitted currency is malformed');
    }
    omitted.push({ currency: entry['currency'], reason: entry['reason'] });
  }
  return ok({ status: 'available', points, omitted });
}

export function parseBubbles(input: unknown): Parsed<WireBubbles> {
  if (!isRecord(input)) return fail('the bubble answer is not an object');
  const provenance = provenanceOf(input['provenance']);
  if (provenance.ok === false) return fail(`the bubble ${provenance.error}`);
  if (!Array.isArray(input['inputs'])) return fail('the bubble answer has no input list');
  const inputs: Provenance[] = [];
  for (const raw of input['inputs'] as unknown[]) {
    const parsed = provenanceOf(raw);
    if (parsed.ok === false) return fail(`a bubble input ${parsed.error}`);
    inputs.push(parsed.value);
  }
  const result = parseBubbleResult(input['result']);
  if (result.ok === false) return fail(result.error);
  const drawn = result.value.status === 'available' && result.value.points.length > 0;
  const issue = consistent(provenance.value, drawn, 'the bubble answer');
  if (issue !== null) return fail(issue);
  return ok({ provenance: provenance.value, inputs, result: result.value });
}
