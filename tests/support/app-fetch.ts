/**
 * TEST-ONLY. A `fetch` for the browser-side code that answers `/api/*` with the real server
 * handlers, which in turn talk to a fake vendor. It exercises the whole connected path (client,
 * handlers, adapter, validation) in one process, with no network.
 */
import { createTtlCache } from '../../server/cache.js';
import type { HandlerDeps } from '../../server/handlers.js';
import { routeApi } from '../../server/router.js';
import { FIXTURE_NOW } from './fixtures.js';
import type { FakeVendor } from './fake-vendor.js';

export function createAppFetch(
  env: Record<string, string | undefined>,
  vendor: FakeVendor,
  now: () => number = () => FIXTURE_NOW,
): typeof fetch {
  const deps: HandlerDeps = { env, fetch: vendor.fetch, now, cache: createTtlCache() };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), 'http://elstand.test'), init);
    return (
      routeApi(request, deps) ??
      new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    );
  }) as typeof fetch;
}
