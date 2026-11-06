import { API_CANDLES_PATH, API_QUOTES_PATH, API_STATUS_PATH } from '../src/data/wire.js';
import {
  API_BUBBLES_PATH,
  API_CALENDAR_PATH,
  API_MACRO_PATH,
  API_NEWS_PATH,
  API_RATES_PATH,
} from '../src/data/wire-macro.js';
import { API_PROVIDERS_PATH } from '../src/data/wire-providers.js';
import {
  handleBubbles,
  handleCalendar,
  handleMacro,
  handleNews,
  handleProviders,
  handleRates,
} from './capability-handlers.js';
import { handleCandles, handleQuotes, handleStatus, type HandlerDeps } from './handlers.js';

/**
 * Path-to-handler routing for hosts that serve the whole API themselves (the local dev
 * server and the test harness). On Vercel each handler is its own file under `api/`, so this
 * is not used there. Returns null for a path that is not an API route.
 */
export function routeApi(request: Request, deps: HandlerDeps): Promise<Response> | null {
  switch (new URL(request.url).pathname) {
    case API_STATUS_PATH:
      return handleStatus(request, deps);
    case API_QUOTES_PATH:
      return handleQuotes(request, deps);
    case API_CANDLES_PATH:
      return handleCandles(request, deps);
    case API_CALENDAR_PATH:
      return handleCalendar(request, deps);
    case API_NEWS_PATH:
      return handleNews(request, deps);
    case API_MACRO_PATH:
      return handleMacro(request, deps);
    case API_BUBBLES_PATH:
      return handleBubbles(request, deps);
    case API_RATES_PATH:
      return handleRates(request, deps);
    case API_PROVIDERS_PATH:
      return handleProviders(request, deps);
    default:
      return null;
  }
}
