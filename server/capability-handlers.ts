import { isProviderId } from '../src/core/provider-state.js';
import type {
  WireBubbles,
  WireCalendarData,
  WireEnvelope,
  WireMacro,
  WireNewsData,
  WireRatesData,
} from '../src/data/wire-macro.js';
import type { WireProvidersAnswer } from '../src/data/wire-providers.js';
import { sharedCacheControl } from './cache-policy.js';
import { toApiFailure } from './errors.js';
import { CALENDAR_ATTRIBUTION } from './financecalendar.js';
import {
  dayStart,
  defaultCalendarDays,
  loadCalendar,
  loadNews,
  loadRates,
  NEWS_ATTRIBUTION,
  RATES_ATTRIBUTION,
} from './feeds-service.js';
import { serviceDepsOf, type HandlerDeps } from './handlers.js';
import { isMacroProvider, loadBubbles, loadMacro, MACRO_PROVIDERS } from './macro-service.js';
import { probeProvider } from './probe.js';
import { describeProviders } from './provider-registry.js';
import { NO_STORE, badRequest, errorResponse, json, notGet } from './respond.js';
import type { Outcome } from './service.js';

/**
 * The capability handlers: calendar, news, macro observations, macro bubbles, reference rates
 * and the provider page. Every one answers HTTP 200 with a provenance, whatever the provider
 * did, because "no credential", "rate limited" and "provider failed" are states of the product
 * that the browser shows in words, not faults of the request. Only a request that cannot be
 * understood (400), the wrong method (405) or a defect in this server (500) is an HTTP error.
 *
 * An answer that carries no data is never cached by a shared cache.
 */

const DAY_MS = 86_400_000;

/** How far from today a calendar window may reach. It keeps cache keys and provider use bounded. */
const MAX_CALENDAR_SPAN_DAYS = 31;
const MAX_CALENDAR_PAST_DAYS = 60;
const MAX_CALENDAR_AHEAD_DAYS = 120;

function envelope<T, D>(outcome: Outcome<T>, shape: (value: T) => D): Response {
  if (outcome.kind === 'data') {
    const body: WireEnvelope<D> = { provenance: outcome.provenance, data: shape(outcome.value) };
    return json(body, 200, sharedCacheControl(outcome.shareMs));
  }
  const body: WireEnvelope<D> = { provenance: outcome.provenance, data: null };
  return json(body, 200, NO_STORE);
}

const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day written YYYY-MM-DD, as 00:00 UTC, or null when it was not given. */
function parseDay(raw: string | null, name: string): number | null {
  if (raw === null || raw === '') return null;
  if (!DAY_TEXT.test(raw)) throw badRequest(`${name} must be a date written YYYY-MM-DD.`);
  const timeMs = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString().slice(0, 10) !== raw) {
    throw badRequest(`${name} is not a real calendar date.`);
  }
  return timeMs;
}

export async function handleCalendar(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const params = new URL(request.url).searchParams;
    const now = deps.now();
    const fallback = defaultCalendarDays(now);
    const fromMs = parseDay(params.get('from'), 'from') ?? fallback.fromMs;
    const toMs = parseDay(params.get('to'), 'to') ?? fromMs + (fallback.toMs - fallback.fromMs);
    const today = dayStart(now);
    if (toMs < fromMs) throw badRequest('to must not be before from.');
    if (toMs - fromMs > MAX_CALENDAR_SPAN_DAYS * DAY_MS) {
      throw badRequest(`The window may span at most ${MAX_CALENDAR_SPAN_DAYS} days.`);
    }
    if (
      fromMs < today - MAX_CALENDAR_PAST_DAYS * DAY_MS ||
      toMs > today + MAX_CALENDAR_AHEAD_DAYS * DAY_MS
    ) {
      throw badRequest('The window is too far from today.');
    }
    const outcome = await loadCalendar(serviceDepsOf(deps), { fromMs, toMs });
    return envelope(
      outcome,
      (value): WireCalendarData => ({
        events: value.events,
        excluded: value.excluded,
        total: value.total,
        truncated: value.truncated,
        quota: value.quota,
        attribution: CALENDAR_ATTRIBUTION,
      }),
    );
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleNews(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const outcome = await loadNews(serviceDepsOf(deps));
    return envelope(
      outcome,
      (value): WireNewsData => ({
        items: value.items,
        excluded: value.excluded,
        found: value.found,
        returned: value.returned,
        limit: value.limit,
        topic: value.topic,
        dailyRemaining: value.dailyRemaining,
        attribution: NEWS_ATTRIBUTION,
      }),
    );
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleRates(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const outcome = await loadRates(serviceDepsOf(deps));
    return envelope(
      outcome,
      (value): WireRatesData => ({
        base: value.base,
        date: value.date,
        rates: value.rates,
        missing: value.missing,
        attribution: RATES_ATTRIBUTION,
      }),
    );
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleMacro(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const provider = new URL(request.url).searchParams.get('provider');
    if (!isMacroProvider(provider)) {
      throw badRequest(`provider must be one of: ${MACRO_PROVIDERS.join(', ')}.`);
    }
    const answer = await loadMacro(serviceDepsOf(deps), provider);
    const body: WireMacro = {
      provider: answer.provider,
      provenance: answer.provenance,
      entries: answer.entries,
    };
    // A provider that was never asked (no credential) has no entries and nothing worth sharing.
    return json(
      body,
      200,
      answer.entries.length === 0 ? NO_STORE : sharedCacheControl(answer.shareMs),
    );
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleBubbles(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const answer = await loadBubbles(serviceDepsOf(deps));
    const body: WireBubbles = {
      provenance: answer.provenance,
      inputs: answer.inputs,
      result: answer.result,
    };
    return json(
      body,
      200,
      answer.result.status === 'available' ? sharedCacheControl(answer.shareMs) : NO_STORE,
    );
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}

export async function handleProviders(request: Request, deps: HandlerDeps): Promise<Response> {
  const blocked = notGet(request);
  if (blocked !== null) return blocked;
  try {
    const providers = describeProviders(deps.env);
    const probe = new URL(request.url).searchParams.get('probe');
    if (probe === null) {
      const body: WireProvidersAnswer = { providers };
      return json(body, 200, NO_STORE);
    }
    if (!isProviderId(probe)) throw badRequest('probe must name one of the providers.');
    const body: WireProvidersAnswer = {
      providers,
      probe: await probeProvider(serviceDepsOf(deps), probe),
    };
    return json(body, 200, NO_STORE);
  } catch (error) {
    return errorResponse(toApiFailure(error));
  }
}
