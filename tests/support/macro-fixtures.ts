import type { Candle } from '../../src/core/types.js';
import { json, type ProviderCallRecord, type ProviderReply } from './fake-provider.js';
import { timeSeriesPayload } from './fake-vendor.js';

/**
 * Stand-in provider payloads for the macro tests, in the shapes the providers document. The
 * numbers are fixtures chosen to make a rule visible (a stale series, a missing base month); they
 * are not market data and nothing here proves a live provider answers this way.
 */

export const DAY = 86_400_000;

export type Route = (call: ProviderCallRecord) => ProviderReply;

export const day = (year: number, month1: number, date: number): number =>
  Date.UTC(year, month1 - 1, date);
export const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const fredRow = (date: number, value: number, published: number) => ({
  realtime_start: iso(published),
  realtime_end: '9999-12-31',
  date: iso(date),
  value: String(value),
});

/** `months` monthly observations ending with `lastYear`-`lastMonth`, published mid-next-month. */
export function fredMonthly(
  months: number,
  lastYear: number,
  lastMonth1: number,
  first: number,
  step: number,
): Record<string, unknown> {
  const observations = Array.from({ length: months }, (_, index) => {
    const offset = index - (months - 1);
    const date = Date.UTC(lastYear, lastMonth1 - 1 + offset, 1);
    const published = Date.UTC(lastYear, lastMonth1 + offset, 15);
    return fredRow(date, Number((first + index * step).toFixed(3)), published);
  });
  return { units: 'lin', observations };
}

export const fredDaily = (value: number, newest = day(2026, 1, 5)): Record<string, unknown> => ({
  units: 'lin',
  observations: [
    fredRow(newest - 3 * DAY, value, newest - 3 * DAY),
    fredRow(newest, value, newest),
  ],
});

export interface FredOverrides {
  readonly DFEDTARU?: ProviderReply;
  readonly ECBDFR?: ProviderReply;
  readonly CPIAUCNS?: ProviderReply;
  readonly CP0000EZ19M086NEST?: ProviderReply;
}

export function fredRoute(over: FredOverrides = {}, rest: Route = () => undefined): Route {
  return (call) => {
    if (call.host !== 'api.stlouisfed.org') return rest(call);
    const id = call.params['series_id'] as keyof FredOverrides;
    if (over[id] !== undefined) return over[id];
    switch (id) {
      case 'DFEDTARU':
        return fredDaily(3.75);
      case 'ECBDFR':
        return fredDaily(2.0);
      case 'CPIAUCNS':
        return fredMonthly(13, 2025, 11, 316, 0.8);
      case 'CP0000EZ19M086NEST':
        return fredMonthly(13, 2025, 11, 124, 0.2);
      default:
        return json({ error_message: `unexpected series ${String(id)}` }, 400);
    }
  };
}

export function dailyBars(count: number, endMs: number, start = 1.1, step = 0.001): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = Number((start + index * step).toFixed(5));
    return {
      time: endMs - (count - 1 - index) * DAY,
      open: Number((close - 0.0005).toFixed(5)),
      high: Number((close + 0.001).toFixed(5)),
      low: Number((close - 0.001).toFixed(5)),
      close,
    };
  });
}

export const twelveRoute = (bars: Candle[]): Route => {
  return (call) =>
    call.host === 'api.twelvedata.com' && call.path === '/time_series'
      ? timeSeriesPayload(call.params['symbol'] ?? '', '1day', bars)
      : undefined;
};

export const avDailyPayload = (bars: Candle[]): Record<string, unknown> => ({
  'Meta Data': {
    '1. Information': 'Forex Daily Prices (open, high, low, close)',
    '2. From Symbol': 'EUR',
    '3. To Symbol': 'USD',
    '4. Output Size': 'Compact',
    '5. Last Refreshed': '2026-01-06 11:59:00',
    '6. Time Zone': 'UTC',
  },
  'Time Series FX (Daily)': Object.fromEntries(
    bars.map((bar) => [
      iso(bar.time),
      {
        '1. open': bar.open.toFixed(5),
        '2. high': bar.high.toFixed(5),
        '3. low': bar.low.toFixed(5),
        '4. close': bar.close.toFixed(5),
      },
    ]),
  ),
});

export function combine(...routes: Route[]): Route {
  return (call) => {
    for (const route of routes) {
      const reply = route(call);
      if (reply !== undefined) return reply;
    }
    throw new Error(`unexpected request to ${call.host}${call.path}`);
  };
}

export const blsMonths = (id: string, newest: [number, number], count: number, base: number) => ({
  seriesID: id,
  data: Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(newest[0], newest[1] - 1 - index, 1));
    return {
      year: String(date.getUTCFullYear()),
      period: `M${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
      periodName: 'month',
      value: String(Number((base - index * 0.1).toFixed(1))),
    };
  }),
});
