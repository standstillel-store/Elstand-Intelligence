/**
 * TEST FIXTURES. NOT MARKET DATA.
 *
 * Stand-ins for the answers of the economic-calendar providers, in the shape each one documents,
 * so tests can drive the real adapters, the HTTP helper and the router without a network. The
 * events, titles and numbers are invented for tests and mean nothing. `scripts/build.ts` fails
 * the build if anything under `tests/` reaches the bundle, and nothing under `src/` or `server/`
 * may import this file.
 */

import { FIXTURE_NOW } from './fixtures.js';

const HOUR = 3_600_000;

export const SMT_HOST = 'showmytrades.com';
export const XOOMAR_HOST = 'xoomar.com';
export const FC_HOST = 'www.financecalendar.com';

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** A ShowMyTrades event: every field the provider documents, `ts` and `time` agreeing. */
export function smtEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  const timeMs = Date.UTC(2026, 0, 7, 13, 30);
  return {
    ts: timeMs / 1000,
    time: iso(timeMs),
    currency: 'USD',
    impact: 'high',
    title: 'Test inflation release',
    forecast: '2.9%',
    previous: '2.7%',
    actual: '',
    id: 'usd-test-inflation-release.20260107T1330',
    status: 'scheduled',
    moved_from: '',
    period: '2025-12',
    confidence: 'sources_agree',
    ...over,
  };
}

/** A ShowMyTrades answer for a request made at FIXTURE_NOW with `days` = 8. */
export function smtBody(
  events: unknown[] = [smtEvent()],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    server_time: FIXTURE_NOW / 1000,
    server_time_iso: iso(FIXTURE_NOW),
    generated_at: iso(FIXTURE_NOW),
    from: iso(FIXTURE_NOW - 6 * HOUR),
    to: iso(FIXTURE_NOW + 8 * 24 * HOUR),
    count: events.length,
    events,
    attribution: {
      required: false,
      text: 'Economic calendar by ShowMyTrades',
      url: 'https://showmytrades.com/tools/economic-calendar',
    },
    docs: 'https://showmytrades.com/docs/api/economic-calendar',
    ...over,
  };
}

/** A XOOMAR record: U.S. agency release, forecast always null. */
export function xoomarEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'bls',
    eventName: 'Test employment report',
    importance: 'high',
    scheduledAt: '2026-01-09T13:30:00Z',
    periodLabel: 'December 2025',
    previous: '227',
    forecast: null,
    actual: null,
    unit: 'thousands',
    ...over,
  };
}

export function xoomarBody(
  data: unknown[] = [xoomarEvent()],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data,
    updatedAt: iso(FIXTURE_NOW),
    source: 'test',
    meta: { source: 'test', sourceAttribution: 'Test credit line for XOOMAR data' },
    nextReleaseAt: null,
    ...over,
  };
}

/** A Finance Calendar answer (the optional legacy source), one event. */
export function financeCalendarBody(): Record<string, unknown> {
  const events = [
    {
      id: 101,
      name: 'Test legacy release',
      country: 'US',
      impact: 'high',
      date: '2026-01-07',
      release_at_utc: '2026-01-07T13:30:00Z',
      status: 'confirmed',
      consensus: null,
      prior: '2.7',
      actual: null,
      unit: '%',
      source_name: 'Test statistics office',
      source_url: 'https://example.invalid/legacy',
    },
  ];
  return { events, count: 1, total: 1 };
}
