import { createStore, type ReadableStore } from '../core/store.js';
import { DEFAULT_INSTRUMENT_ID, findInstrument } from '../core/instruments.js';
import { isTimeframe, type Timeframe } from '../core/types.js';

export const MACRO_TABS = ['vol-surface', 'bubbles', 'news-calendar'] as const;
export type MacroTab = (typeof MACRO_TABS)[number];

export const MACRO_TAB_LABEL: Readonly<Record<MacroTab, string>> = {
  'vol-surface': 'Volatility surface',
  bubbles: 'Macro bubbles',
  'news-calendar': 'News & calendar',
};

export const DEFAULT_TIMEFRAME: Timeframe = 'H1';

export type Route =
  | { readonly page: 'forex'; readonly instrumentId: string; readonly timeframe: Timeframe }
  | { readonly page: 'macro'; readonly tab: MacroTab }
  /** The provider status page. It is reached from the footer, not from the navigation. */
  | { readonly page: 'providers' };

export const DEFAULT_ROUTE: Route = {
  page: 'forex',
  instrumentId: DEFAULT_INSTRUMENT_ID,
  timeframe: DEFAULT_TIMEFRAME,
};

function isMacroTab(value: string | undefined): value is MacroTab {
  return value !== undefined && (MACRO_TABS as readonly string[]).includes(value);
}

/**
 * Hash routes: `#/forex/EURUSD/H1`, `#/macro/vol-surface` and `#/providers`. Parsing never fails: anything
 * unknown falls back to a valid route, and the router rewrites the address bar to match, so a
 * stale or hand-edited link can never leave the interface in an undefined state.
 */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter((part) => part !== '')
    .map(safeDecode);
  const [page, first, second] = parts;
  if (page?.toLowerCase() === 'macro') {
    const tab = first?.toLowerCase();
    return { page: 'macro', tab: isMacroTab(tab) ? tab : 'vol-surface' };
  }
  if (page?.toLowerCase() === 'providers') return { page: 'providers' };
  if (page?.toLowerCase() === 'forex') {
    const timeframe = second?.toUpperCase();
    return {
      page: 'forex',
      instrumentId:
        (first === undefined ? undefined : findInstrument(first)?.id) ?? DEFAULT_INSTRUMENT_ID,
      timeframe: isTimeframe(timeframe) ? timeframe : DEFAULT_TIMEFRAME,
    };
  }
  return DEFAULT_ROUTE;
}

export function formatRoute(route: Route): string {
  switch (route.page) {
    case 'forex':
      return `#/forex/${route.instrumentId}/${route.timeframe}`;
    case 'macro':
      return `#/macro/${route.tab}`;
    case 'providers':
      return '#/providers';
  }
}

export interface Router {
  readonly route: ReadableStore<Route>;
  navigate(route: Route): void;
  dispose(): void;
}

type RouterWindow = Pick<
  Window,
  'location' | 'history' | 'addEventListener' | 'removeEventListener'
>;

export function createRouter(win: RouterWindow): Router {
  const read = (): Route => {
    const route = parseHash(win.location.hash);
    const canonical = formatRoute(route);
    if (win.location.hash !== canonical) {
      win.history.replaceState(
        null,
        '',
        `${win.location.pathname}${win.location.search}${canonical}`,
      );
    }
    return route;
  };
  const route = createStore<Route>(read());
  const onChange = (): void => {
    const next = read();
    const current = route.get();
    if (formatRoute(next) !== formatRoute(current)) route.set(next);
  };
  win.addEventListener('hashchange', onChange);
  return {
    route,
    navigate(next) {
      win.location.hash = formatRoute(next);
    },
    dispose() {
      win.removeEventListener('hashchange', onChange);
    },
  };
}
