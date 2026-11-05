import type { NewsItem, ProviderSentiment } from '../src/data/macro.js';
import { currenciesOfSymbol } from './currencies.js';
import { ApiFailure } from './errors.js';
import {
  cleanLabel,
  invalidData,
  isRecord,
  parseWholeNumber,
  parseZonedInstant,
  safeHttpsUrl,
} from './parse.js';
import { callProvider, sanitizeText, type HttpDeps } from './provider-http.js';

/**
 * Marketaux adapter (https://www.marketaux.com/documentation), financial news.
 *
 *   GET news/all?api_token=KEY&search=...&language=en&limit=N&published_after=YYYY-MM-DDTHH:MM:SS
 *   -> { meta: { found, returned, limit, page },
 *        data: [ { uuid, title, url, published_at, source, entities: [ { symbol, type,
 *                  sentiment_score, ... } ], ... } ] }
 *   errors: { error: { code, message } } with HTTP 400 malformed_parameters, 401
 *   invalid_api_token, 402 usage_limit_reached, 403 endpoint_access_restricted, 429
 *   rate_limit_reached, 500 server_error, 503 maintenance_mode.
 *
 * The key (`api_token`) is a query parameter, so the address is a secret and is never logged.
 *
 * What is and is not taken from the answer:
 *  - The headline, the article link, the publication instant and the publisher's domain, as
 *    supplied. The article body and description are not kept.
 *  - Currencies come only from entities the provider itself typed as `currency`, and only when
 *    the symbol is recognizable. Nothing is inferred from the words of a headline.
 *  - The provider's sentiment is kept apart (`providerSentiment`), and only when it is
 *    unambiguous: a single currency entity with a score. It is the provider's number, never an
 *    Elstand prediction, and it is not averaged or combined.
 *  - Impact is never set. Marketaux does not classify impact, so a headline has none.
 *
 * The request is filtered by words (`NEWS_SEARCH`), not by a hidden ranking: the filter is
 * returned with the result so the interface can show what the feed contains. The free plan
 * returns only a few articles per request, and `found` says how many matched.
 */

export const MARKETAUX_LABEL = 'Marketaux';

/** The words a headline or its text must match to appear in the feed. Operators: | is OR. */
export const NEWS_SEARCH =
  'forex | "foreign exchange" | "exchange rate" | "central bank" | "interest rate" | inflation';

export const NEWS_TOPIC =
  'Headlines that mention forex, foreign exchange, exchange rates, central banks, interest rates or inflation.';

/** The free plan returns at most 3 articles per request, so that is what is asked for. */
export const DEFAULT_NEWS_LIMIT = 3;
const MAX_NEWS_LIMIT = 50;

export interface MarketauxConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface NewsRequest {
  /** Articles published at or after this instant (UTC epoch ms). */
  readonly sinceMs: number;
  readonly limit: number;
}

export interface ExcludedArticle {
  readonly id: string;
  readonly reason: string;
}

export interface NewsFetch {
  readonly items: readonly NewsItem[];
  readonly excluded: readonly ExcludedArticle[];
  /** How many articles matched, which can exceed what the plan returns. */
  readonly found: number | null;
  readonly returned: number;
  /** The per-request limit the provider applied. */
  readonly limit: number | null;
  readonly topic: string;
  /** Requests left today, when the provider says. */
  readonly dailyRemaining: number | null;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function formatSince(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Marketaux sends its error envelope with the HTTP status that goes with it. */
function recognizeMarketauxError(
  apiKey: string,
): (status: number, body: unknown) => ApiFailure | null {
  return (_status, body) => {
    if (!isRecord(body) || !isRecord(body['error'])) return null;
    const code = typeof body['error']['code'] === 'string' ? body['error']['code'] : '';
    const detail = sanitizeText(
      typeof body['error']['message'] === 'string' ? body['error']['message'] : '',
      [apiKey],
    );
    const suffix = detail === '' ? '' : ` ${detail}`;
    switch (code) {
      case 'invalid_api_token':
        return new ApiFailure(
          'provider_auth',
          `${MARKETAUX_LABEL} rejected the configured API token.`,
        );
      case 'usage_limit_reached':
        // The plan's daily allowance is spent: nothing more is requested until it resets.
        return new ApiFailure(
          'rate_limited',
          `${MARKETAUX_LABEL} refused the request because the plan’s usage limit was reached.`,
          null,
          { budget: 'day' },
        );
      case 'endpoint_access_restricted':
        return new ApiFailure(
          'provider_error',
          `${MARKETAUX_LABEL} does not offer this endpoint on the current plan.`,
        );
      case 'malformed_parameters':
        return new ApiFailure(
          'provider_error',
          `${MARKETAUX_LABEL} rejected the request parameters.${suffix}`,
        );
      default:
        // 429 (with Retry-After) and 5xx are handled by status, which keeps their retry hints.
        return null;
    }
  };
}

interface CurrencyEntity {
  readonly currencies: readonly string[];
  readonly symbol: string;
  readonly score: number | null;
}

function currencyEntities(value: unknown): CurrencyEntity[] {
  if (!Array.isArray(value)) return [];
  const found: CurrencyEntity[] = [];
  for (const entity of value as unknown[]) {
    if (!isRecord(entity) || entity['type'] !== 'currency') continue;
    const symbol = typeof entity['symbol'] === 'string' ? entity['symbol'].trim() : '';
    if (symbol === '') continue;
    const currencies = currenciesOfSymbol(symbol);
    if (currencies.length === 0) continue;
    const raw = entity['sentiment_score'];
    const score =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= -1 && raw <= 1 ? raw : null;
    found.push({ currencies, symbol: symbol.toUpperCase(), score });
  }
  return found;
}

function sentimentOf(entities: readonly CurrencyEntity[]): ProviderSentiment | undefined {
  if (entities.length !== 1) return undefined;
  const only = entities[0] as CurrencyEntity;
  if (only.score === null) return undefined;
  return { score: only.score, basis: `${MARKETAUX_LABEL} entity sentiment for ${only.symbol}` };
}

type ArticleParse =
  | { readonly kind: 'item'; readonly item: NewsItem }
  | { readonly kind: 'excluded'; readonly excluded: ExcludedArticle };

function parseArticle(row: unknown, index: number, retrievedAt: number): ArticleParse {
  const exclude = (id: string, reason: string): ArticleParse => ({
    kind: 'excluded',
    excluded: { id, reason },
  });
  if (!isRecord(row)) return exclude(`article ${index}`, 'is not an object');
  const uuid = typeof row['uuid'] === 'string' ? row['uuid'].trim() : '';
  if (uuid === '' || uuid.length > 80) return exclude(`article ${index}`, 'has no usable id');
  const id = `marketaux:${uuid}`;
  const headline = cleanLabel(row['title']);
  if (headline === null) return exclude(id, 'has no headline');
  const publishedAt = parseZonedInstant(row['published_at']);
  if (publishedAt === null) return exclude(id, 'has no valid publication time');
  if (publishedAt > retrievedAt + MAX_FUTURE_SKEW_MS) {
    return exclude(id, 'is dated in the future');
  }
  const entities = currencyEntities(row['entities']);
  const currencies = [...new Set(entities.flatMap((entity) => entity.currencies))];
  const publisher = cleanLabel(row['source'], 80);
  const sentiment = sentimentOf(entities);
  const item: NewsItem = {
    id,
    publishedAt,
    headline,
    currencies,
    source: { name: MARKETAUX_LABEL, url: null, retrievedAt },
    url: safeHttpsUrl(row['url']),
    impact: null,
    elvoidInterpretation: null,
    ...(publisher === null ? {} : { publisher }),
    ...(sentiment === undefined ? {} : { providerSentiment: sentiment }),
  };
  return { kind: 'item', item };
}

export interface ParsedNews {
  readonly items: readonly NewsItem[];
  readonly excluded: readonly ExcludedArticle[];
  readonly found: number | null;
  readonly returned: number;
  readonly limit: number | null;
}

function wholeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseNewsResponse(body: unknown, retrievedAt: number): ParsedNews {
  if (!isRecord(body) || !Array.isArray(body['data'])) {
    throw invalidData(MARKETAUX_LABEL, 'the response has no data list');
  }
  const rows = body['data'] as unknown[];
  const items: NewsItem[] = [];
  const excluded: ExcludedArticle[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const parsed = parseArticle(row, index, retrievedAt);
    if (parsed.kind === 'excluded') {
      excluded.push(parsed.excluded);
    } else if (seen.has(parsed.item.id)) {
      excluded.push({ id: parsed.item.id, reason: 'repeats an earlier article' });
    } else {
      seen.add(parsed.item.id);
      items.push(parsed.item);
    }
  });
  items.sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  const meta = isRecord(body['meta']) ? body['meta'] : {};
  return {
    items,
    excluded,
    found: wholeOrNull(meta['found']),
    returned: rows.length,
    limit: wholeOrNull(meta['limit']),
  };
}

export async function fetchNews(
  http: HttpDeps,
  config: MarketauxConfig,
  request: NewsRequest,
): Promise<NewsFetch> {
  if (
    !Number.isFinite(request.sinceMs) ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_NEWS_LIMIT
  ) {
    throw new ApiFailure('bad_request', 'The news request is not valid.');
  }
  const response = await callProvider(http, {
    label: MARKETAUX_LABEL,
    baseUrl: config.baseUrl,
    path: 'news/all',
    query: {
      api_token: config.apiKey,
      search: NEWS_SEARCH,
      language: 'en',
      limit: String(request.limit),
      published_after: formatSince(request.sinceMs),
    },
    secrets: [config.apiKey],
    recognizeError: recognizeMarketauxError(config.apiKey),
  });
  const parsed = parseNewsResponse(response.body, http.now());
  return {
    ...parsed,
    topic: NEWS_TOPIC,
    dailyRemaining: parseWholeNumber(response.header('X-UsageLimit-Remaining')),
  };
}
