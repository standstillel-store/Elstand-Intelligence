import { worstState } from '../core/freshness.js';
import { DEFAULT_INSTRUMENT_ID } from '../core/instruments.js';
import { createStore, derived, type ReadableStore, type Store } from '../core/store.js';
import type { DataState, SourceInfo, Timeframe } from '../core/types.js';
import { createUnconfiguredBubbleProvider, type BubbleProvider } from '../data/macro-bubbles.js';
import { createUnconfiguredMacroFeed, type MacroFeedProvider } from '../data/macro.js';
import { createUnconfiguredSurfaceProvider, type VolSurfaceProvider } from '../data/options.js';
import { createApiClient } from '../data/api-client.js';
import type { DepthResult } from '../data/depth.js';
import {
  createHttpBubbleProvider,
  createHttpMacroFeed,
  createHttpObservations,
  type ObservationsProvider,
} from '../data/http-macro.js';
import { createProvidersApi, type ProvidersApi } from '../data/http-providers.js';
import { candlesSubject, quoteSubject, type Provenance } from '../data/provenance.js';
import type { CandleSeries } from '../data/provider.js';
import type { QuoteBook } from '../data/service.js';
import type { ElvoidEngine } from '../elvoid/contracts.js';
import { createAnalysisController, type AnalysisController } from '../elvoid/controller.js';
import { createClock, type Clock } from './clock.js';
import { createConnection, type Connection } from './connection.js';
import { createFeed, type Feed } from './feeds.js';
import { createProviderLedger, type ProviderLedger } from './provider-ledger.js';
import { startPolling } from './polling.js';
import { createRouter, DEFAULT_TIMEFRAME, type Route, type Router } from './router.js';
import { quoteView, seriesView, type QuoteView, type SeriesView } from './selectors.js';

export interface Selection {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
}

export interface AppEnvironment {
  readonly window: Window;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  /**
   * A ready-made connection, for tests. Production leaves this unset and the context builds
   * its own from `fetch`. The caller keeps ownership of an injected connection.
   */
  readonly connection?: Connection;
  /**
   * The ELVOID engine to run. Phase 1 ships none, so production leaves this unset and ELVOID
   * reports NOT CONFIGURED. This is the single place a real engine is plugged in; everything
   * it returns is validated before it can be shown.
   */
  readonly elvoidEngine?: ElvoidEngine;
  /**
   * Providers for the macro modules, for tests. Production leaves this unset and the context
   * builds providers that ask the Elstand server. When it is set, a provider left out stays
   * unconfigured (the module says ENV NOT CONNECTION), so a test never reaches a server it did
   * not ask for. There is no options-data adapter, so the surface is unconfigured either way.
   */
  readonly macro?: {
    readonly surface?: VolSurfaceProvider;
    readonly feed?: MacroFeedProvider;
    readonly bubbles?: BubbleProvider;
    readonly observations?: ObservationsProvider;
  };
}

/** The provenance the server sent with the quote and the candles of the selected chart. */
export interface SelectedProvenance {
  readonly quote: Provenance | null;
  readonly candles: Provenance | null;
}

/** Everything the screens share. Screens read from here and never build their own data paths. */
export interface AppContext {
  /** The browser window this application was mounted in (injected, so tests can supply one). */
  readonly window: Window;
  readonly connection: Connection;
  readonly route: ReadableStore<Route>;
  readonly navigate: Router['navigate'];
  /** Epoch ms, republished every second. */
  readonly now: ReadableStore<number>;
  /** The user's auto-refresh switch. Polling also stops by itself off the Forex page. */
  readonly autoRefresh: Store<boolean>;
  /** The selected chart. It survives a visit to the Macro page. */
  readonly selection: ReadableStore<Selection>;
  readonly source: ReadableStore<SourceInfo | null>;
  readonly feeds: {
    readonly quotes: Feed<QuoteBook>;
    readonly candles: Feed<CandleSeries>;
    readonly depth: Feed<DepthResult>;
  };
  readonly selectedQuote: ReadableStore<QuoteView>;
  readonly selectedSeries: ReadableStore<SeriesView>;
  /** The least trustworthy of the selected quote and series. This is what ELVOID may rely on. */
  readonly selectedState: ReadableStore<DataState>;
  readonly elvoid: AnalysisController;
  readonly macro: {
    readonly surface: VolSurfaceProvider;
    readonly feed: MacroFeedProvider;
    readonly bubbles: BubbleProvider;
    /** Macro observations and reference rates. Null when a test supplied macro providers without it. */
    readonly observations: ObservationsProvider | null;
  };
  /** What this browser has seen from each provider: statements the server made, never data. */
  readonly ledger: ProviderLedger;
  /** The provenance of the quote and candles on screen, when the server sent it. */
  readonly provenance: ReadableStore<SelectedProvenance>;
  /** The provider configuration, and the check a person can ask for. */
  readonly providersApi: ProvidersApi;
  dispose(): void;
}

function selectionFrom(route: Route): Selection {
  return route.page === 'forex'
    ? { instrumentId: route.instrumentId, timeframe: route.timeframe }
    : { instrumentId: DEFAULT_INSTRUMENT_ID, timeframe: DEFAULT_TIMEFRAME };
}

const sameQuoteView = (a: QuoteView, b: QuoteView): boolean =>
  a.state === b.state && a.quote === b.quote && a.note === b.note;

const sameSeriesView = (a: SeriesView, b: SeriesView): boolean =>
  a.state === b.state && a.newestBarOpen === b.newestBarOpen;

export function createAppContext(env: AppEnvironment): AppContext {
  const win = env.window;
  const now = env.now ?? Date.now;

  const clock: Clock = createClock(
    now,
    (handler, ms) => win.setInterval(handler, ms),
    (handle) => win.clearInterval(handle as number),
  );
  const router = createRouter(win);
  const ownsConnection = env.connection === undefined;
  const api = createApiClient(env.fetch);
  const ledger = createProviderLedger();
  const connection =
    env.connection ??
    createConnection({
      fetch: env.fetch,
      now,
      onProvenance: (provenance, attemptedAt, subject) =>
        ledger.record(provenance, attemptedAt, subject),
    });
  const autoRefresh = createStore(true);
  const macroHttp = { client: api, record: ledger.record, now };
  const injectedMacro = env.macro !== undefined;

  const selection = createStore<Selection>(selectionFrom(router.route.get()));
  const stopSelection = router.route.subscribe((route) => {
    if (route.page !== 'forex') return;
    const current = selection.get();
    if (route.instrumentId !== current.instrumentId || route.timeframe !== current.timeframe) {
      selection.set({ instrumentId: route.instrumentId, timeframe: route.timeframe });
    }
  });

  const source = derived([connection.state], (state) =>
    state.status === 'connected' ? state.source : null,
  );
  const instrumentKey = derived([selection], (current) => current.instrumentId);

  const feeds = {
    quotes: createFeed<QuoteBook, string>(connection.state, createStore('all'), (service) => ({
      store: service.quotes,
      load: () => service.loadQuotes(),
      reload: () => service.reloadQuotes(),
      refresh: () => service.refreshQuotes(),
    })),
    candles: createFeed<CandleSeries, Selection>(
      connection.state,
      selection,
      (service, current) => ({
        store: service.candles(current.instrumentId, current.timeframe),
        load: () => service.loadCandles(current.instrumentId, current.timeframe),
        reload: () => service.reloadCandles(current.instrumentId, current.timeframe),
        refresh: () => service.refreshCandles(current.instrumentId, current.timeframe),
      }),
    ),
    depth: createFeed<DepthResult, string>(
      connection.state,
      instrumentKey,
      (service, instrumentId) => ({
        store: service.depth(instrumentId),
        load: () => service.loadDepth(instrumentId),
        reload: () => service.reloadDepth(instrumentId),
      }),
    ),
  };

  const selectedQuote = derived(
    [feeds.quotes.store, selection, source, clock.now],
    (feed, current, src, time) => quoteView(feed, current.instrumentId, src, time),
    sameQuoteView,
  );
  const selectedSeries = derived(
    [feeds.candles.store, selection, source, clock.now],
    (feed, current, src, time) => seriesView(feed, src, current.timeframe, time),
    sameSeriesView,
  );
  const selectedState = derived([selectedQuote, selectedSeries], (quote, series) =>
    worstState([quote.state, series.state]),
  );
  const provenance = derived(
    [ledger.store, selection],
    (snapshot, current): SelectedProvenance => ({
      quote: snapshot.subjects.get(quoteSubject(current.instrumentId)) ?? null,
      candles:
        snapshot.subjects.get(candlesSubject(current.instrumentId, current.timeframe)) ?? null,
    }),
    (a, b) => a.quote === b.quote && a.candles === b.candles,
  );

  // Without an engine (Phase 1) this only keeps ELVOID's status and inputs current.
  const elvoid = createAnalysisController(env.elvoidEngine ?? null, now);
  const elvoidInput = derived(
    [selection, selectedState],
    (current, state) => ({ current, state }),
    (a, b) => a.current === b.current && a.state === b.state,
  );
  elvoid.select(selection.get().instrumentId, selection.get().timeframe, selectedState.get());
  const stopElvoid = elvoidInput.subscribe(({ current, state }) =>
    elvoid.select(current.instrumentId, current.timeframe, state),
  );

  // Polling runs only while connected, on the Forex page, with the switch on and the tab visible.
  const pollingEnabled = derived(
    [autoRefresh, router.route],
    (on, route) => on && route.page === 'forex',
  );
  let stopPolling: (() => void) | null = null;
  const restartPolling = (): void => {
    stopPolling?.();
    stopPolling = null;
    const state = connection.state.get();
    if (state.status !== 'connected') return;
    stopPolling = startPolling({
      service: state.service,
      pollSeconds: state.pollSeconds,
      selection,
      enabled: pollingEnabled,
      isHidden: () => win.document.hidden,
      now,
      setInterval: (handler, ms) => win.setInterval(handler, ms),
      clearInterval: (handle) => win.clearInterval(handle as number),
      onVisible: (handler) => {
        const listener = (): void => {
          if (!win.document.hidden) handler();
        };
        win.document.addEventListener('visibilitychange', listener);
        return () => win.document.removeEventListener('visibilitychange', listener);
      },
    });
  };
  const stopConnectionWatch = connection.state.subscribe(restartPolling);
  restartPolling();

  return {
    window: win,
    connection,
    route: router.route,
    navigate: router.navigate,
    now: clock.now,
    autoRefresh,
    selection,
    source,
    feeds,
    selectedQuote,
    selectedSeries,
    selectedState,
    elvoid,
    macro: {
      surface: env.macro?.surface ?? createUnconfiguredSurfaceProvider(),
      feed:
        env.macro?.feed ??
        (injectedMacro ? createUnconfiguredMacroFeed() : createHttpMacroFeed(macroHttp)),
      bubbles:
        env.macro?.bubbles ??
        (injectedMacro ? createUnconfiguredBubbleProvider() : createHttpBubbleProvider(macroHttp)),
      observations:
        env.macro?.observations ?? (injectedMacro ? null : createHttpObservations(macroHttp)),
    },
    ledger,
    provenance,
    providersApi: createProvidersApi(api),
    dispose() {
      stopPolling?.();
      stopConnectionWatch();
      stopElvoid();
      stopSelection();
      for (const store of [
        provenance,
        selectedState,
        selectedSeries,
        selectedQuote,
        elvoidInput,
        pollingEnabled,
        instrumentKey,
        source,
      ]) {
        store.dispose();
      }
      feeds.quotes.dispose();
      feeds.candles.dispose();
      feeds.depth.dispose();
      elvoid.dispose();
      if (ownsConnection) connection.dispose();
      router.dispose();
      clock.dispose();
    },
  };
}
