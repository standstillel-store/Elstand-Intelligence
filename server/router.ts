import { API_CANDLES_PATH, API_QUOTES_PATH, API_STATUS_PATH } from '../src/data/wire.js';
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
    default:
      return null;
  }
}
