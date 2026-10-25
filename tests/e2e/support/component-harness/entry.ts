/**
 * TEST-ONLY browser entry. It mounts the real application with fixture providers in the
 * places a production deployment has none (order-book depth, an ELVOID engine, options,
 * macro series, calendar and news), so the "data is present" states of those panels can be
 * checked in a real browser. It is built only by the browser tests, never by `npm run build`.
 */
import '../../../../src/styles/main.css';
import { mountApp, type MountedApp } from '../../../../src/app/app.js';
import type { Connection, ConnectionState } from '../../../../src/app/connection.js';
import { createStore } from '../../../../src/core/store.js';
import type { BubbleProvider, BubbleResult } from '../../../../src/data/macro-bubbles.js';
import type { FeedResult, MacroFeedProvider } from '../../../../src/data/macro.js';
import type { VolSurfaceProvider, VolSurfaceResult } from '../../../../src/data/options.js';
import type { MarketDataProvider } from '../../../../src/data/provider.js';
import { createMarketDataService } from '../../../../src/data/service.js';
import type { ElvoidEngine } from '../../../../src/elvoid/contracts.js';
import {
  FIXTURE_NOW,
  fixtureAnalysisResult,
  fixtureBubblePoints,
  fixtureCalendar,
  fixtureDepth,
  fixtureNews,
  fixtureProvider,
  fixtureSurfaceLarge,
} from '../../../support/fixtures.js';
import type { DepthVariant, EngineVariant, FeedVariant, HarnessApi, HarnessSpec } from './spec.js';

declare global {
  interface Window {
    __harness?: HarnessApi;
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function depth(variant: DepthVariant | undefined): MarketDataProvider['getDepth'] {
  switch (variant) {
    case 'available':
      return async (id) => ({ status: 'available', snapshot: fixtureDepth(id) });
    case 'stale':
      return async (id) => ({
        status: 'available',
        snapshot: fixtureDepth(id, { asOf: FIXTURE_NOW - 2 * 3_600_000 }),
      });
    case 'crossed':
      return async (id) => ({
        status: 'available',
        snapshot: fixtureDepth(id, {
          bids: [{ price: 1.085, size: 1 }],
          asks: [{ price: 1.084, size: 1 }],
        }),
      });
    case 'wrong-instrument':
      return async () => ({ status: 'available', snapshot: fixtureDepth('GBPUSD') });
    case 'deep':
      return async (id) => ({
        status: 'available',
        snapshot: fixtureDepth(id, {
          bids: Array.from({ length: 14 }, (_, i) => ({
            price: 1.0843 - i * 0.00002,
            size: i + 1,
          })),
          asks: Array.from({ length: 14 }, (_, i) => ({
            price: 1.08432 + i * 0.00002,
            size: i + 1,
          })),
        }),
      });
    case 'error':
      return async () => {
        throw new Error('The fixture venue refused the request.');
      };
    case 'fail-then-succeed': {
      let calls = 0;
      return async (id) => {
        calls += 1;
        if (calls === 1) throw new Error('The fixture venue refused the first request.');
        return { status: 'available', snapshot: fixtureDepth(id) };
      };
    }
    default:
      return async () => ({ status: 'unavailable', reason: 'The fixture has no order book.' });
  }
}

const requests: { instrumentId: string; timeframe: string }[] = [];
const calendarRanges: { fromMs: number; toMs: number }[] = [];
let releaseEngine: (() => void) | null = null;

function engine(variant: EngineVariant | undefined): ElvoidEngine | undefined {
  if (variant === undefined || variant === 'none') return undefined;
  let calls = 0;
  return {
    id: 'fixture-engine',
    version: '0.0.0-test',
    async analyze(request) {
      requests.push({ instrumentId: request.instrumentId, timeframe: request.timeframe });
      calls += 1;
      switch (variant) {
        case 'validated':
          return fixtureAnalysisResult(request, 'VALIDATED');
        case 'wait':
          return fixtureAnalysisResult(request, 'WAIT');
        case 'researching':
          return fixtureAnalysisResult(request, 'RESEARCHING');
        case 'error':
          throw new Error('Fixture engine failure.');
        case 'forbidden-field':
          return { ...fixtureAnalysisResult(request, 'WAIT'), confidence: 0.93 };
        case 'wrong-selection':
          return {
            ...fixtureAnalysisResult(request, 'WAIT'),
            instrumentId: request.instrumentId === 'GBPUSD' ? 'EURUSD' : 'GBPUSD',
          };
        case 'pending':
          await new Promise<void>((resolve) => {
            releaseEngine = resolve;
          });
          return fixtureAnalysisResult(request, 'WAIT');
        case 'fail-then-succeed':
          if (calls === 1) throw new Error('Fixture engine failed on the first try.');
          return fixtureAnalysisResult(request, 'WAIT');
      }
    },
  };
}

function feed<T>(variant: FeedVariant | undefined, items: readonly T[]): Promise<FeedResult<T>> {
  switch (variant) {
    case 'available':
      return Promise.resolve({ status: 'available', items, asOf: FIXTURE_NOW - 30_000 });
    case 'empty':
      return Promise.resolve({ status: 'available', items: [], asOf: FIXTURE_NOW - 30_000 });
    case 'error':
      return Promise.reject(new Error('The fixture feed is unreachable.'));
    default:
      return Promise.resolve({ status: 'unavailable', reason: 'No fixture feed is connected.' });
  }
}

function surfaceProvider(spec: HarnessSpec): VolSurfaceProvider {
  return {
    label: 'fixture surface',
    getSurface(instrumentId): Promise<VolSurfaceResult> {
      switch (spec.surface) {
        case 'available':
          return Promise.resolve({
            status: 'available',
            surface: fixtureSurfaceLarge(instrumentId),
            mode: 'delayed',
          });
        case 'wrong-instrument':
          return Promise.resolve({
            status: 'available',
            surface: fixtureSurfaceLarge('USDJPY'),
            mode: 'delayed',
          });
        case 'stale':
          return Promise.resolve({
            status: 'available',
            surface: { ...fixtureSurfaceLarge(instrumentId), asOf: FIXTURE_NOW - 3 * 3_600_000 },
            mode: 'delayed',
          });
        case 'invalid':
          return Promise.resolve({
            status: 'available',
            surface: { ...fixtureSurfaceLarge(instrumentId), expiriesDays: [30, 7, 90, 180, 365] },
            mode: 'live',
          });
        case 'error':
          return Promise.reject(new Error('The fixture options feed is unreachable.'));
        case 'pending':
          return never();
        default:
          return Promise.resolve({
            status: 'unavailable',
            reason: 'No fixture options feed is connected.',
          });
      }
    },
  };
}

function bubbleProvider(spec: HarnessSpec): BubbleProvider {
  return {
    label: 'fixture series',
    getPoints(): Promise<BubbleResult> {
      switch (spec.bubbles) {
        case 'available':
          return Promise.resolve({ status: 'available', points: fixtureBubblePoints() });
        case 'single':
          return Promise.resolve({
            status: 'available',
            points: fixtureBubblePoints().slice(0, 1),
          });
        case 'invalid': {
          const [first, ...rest] = fixtureBubblePoints();
          if (first === undefined) return Promise.resolve({ status: 'available', points: [] });
          return Promise.resolve({
            status: 'available',
            points: [
              {
                ...first,
                cpiYoY: { ...first.cpiYoY, source: { ...first.cpiYoY.source, name: '' } },
              },
              ...rest,
            ],
          });
        }
        case 'error':
          return Promise.reject(new Error('The fixture series feed is unreachable.'));
        default:
          return Promise.resolve({
            status: 'unavailable',
            reason: 'No fixture series feed is connected.',
          });
      }
    },
  };
}

function macroFeed(spec: HarnessSpec): MacroFeedProvider {
  return {
    label: 'fixture feed',
    getCalendar: (range) => {
      calendarRanges.push({ fromMs: range.fromMs, toMs: range.toMs });
      return feed(spec.calendar, fixtureCalendar());
    },
    getNews: () => feed(spec.news, fixtureNews()),
  };
}

let mounted: MountedApp | null = null;
let clockOffsetMs = 0;

function mount(spec: HarnessSpec): void {
  mounted?.dispose();
  const root = document.getElementById('app');
  if (root === null) throw new Error('The harness page has no #app element.');
  root.replaceChildren();
  requests.length = 0;
  calendarRanges.length = 0;
  window.history.replaceState(null, '', spec.hash);

  clockOffsetMs = spec.nowOffsetMs ?? 0;
  const now = (): number => FIXTURE_NOW + clockOffsetMs;
  const provider = fixtureProvider({
    info: { id: 'fixture', label: 'Test fixture', mode: 'live', staleAfterMs: 60_000 },
    getDepth: depth(spec.depth),
  });
  const state = createStore<ConnectionState>({
    status: 'connected',
    source: provider.info,
    pollSeconds: { quotes: 3600, candles: 3600 },
    service: createMarketDataService(provider, { now }),
  });
  const connection: Connection = { state, check: () => undefined, dispose: () => undefined };
  const elvoidEngine = engine(spec.engine);

  mounted = mountApp(root, {
    window,
    fetch: (input, init) => window.fetch(input, init),
    now,
    connection,
    ...(elvoidEngine === undefined ? {} : { elvoidEngine }),
    macro: {
      surface: surfaceProvider(spec),
      bubbles: bubbleProvider(spec),
      feed: macroFeed(spec),
    },
  });
}

window.__harness = {
  mount,
  unmount() {
    mounted?.dispose();
    mounted = null;
    document.getElementById('app')?.replaceChildren();
  },
  release() {
    releaseEngine?.();
    releaseEngine = null;
  },
  advance(ms) {
    clockOffsetMs += ms;
  },
  requests,
  calendarRanges,
};
