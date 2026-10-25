import { createStore, type ReadableStore } from '../core/store.js';
import type { SourceInfo } from '../core/types.js';
import { ApiClientError, createApiClient, isAbortError } from '../data/api-client.js';
import { createHttpProvider } from '../data/http-provider.js';
import { createMarketDataService, type MarketDataService } from '../data/service.js';
import { API_STATUS_PATH, parseStatus } from '../data/wire.js';

/**
 * Whether the application is connected to a real market-data provider, and if so the service
 * that reads from it. This is the single place that decides between showing data and showing
 * ENV NOT CONNECTION; no component decides that for itself.
 */
export type ConnectionState =
  | { readonly status: 'checking' }
  | {
      readonly status: 'not-connected';
      /** One factual sentence: what is missing or what the provider refused. */
      readonly detail: string;
      /** Names of the server environment variables that are not set (never values). */
      readonly missing: readonly string[];
    }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'connected';
      readonly source: SourceInfo;
      readonly service: MarketDataService;
      readonly pollSeconds: { readonly quotes: number; readonly candles: number };
    };

export interface Connection {
  readonly state: ReadableStore<ConnectionState>;
  /** Ask the server again. Safe to call at any time, for example from a Retry button. */
  check(): void;
  dispose(): void;
}

export interface ConnectionOptions {
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

export function createConnection(options: ConnectionOptions): Connection {
  const state = createStore<ConnectionState>({ status: 'checking' });
  const client = createApiClient(options.fetch);
  let generation = 0;
  let controller: AbortController | null = null;

  async function run(): Promise<void> {
    controller?.abort();
    const mine = ++generation;
    const own = new AbortController();
    controller = own;
    state.set({ status: 'checking' });
    try {
      const body = await client.getJson(API_STATUS_PATH, {}, own.signal);
      if (mine !== generation) return;
      const parsed = parseStatus(body);
      if (!parsed.ok) {
        state.set({
          status: 'error',
          message: `The API sent an unusable status: ${parsed.error}.`,
        });
        return;
      }
      const status = parsed.value;
      if (!status.connected) {
        state.set({
          status: 'not-connected',
          detail: `Server environment variable ${status.missing.join(', ')} is not set.`,
          missing: status.missing,
        });
        return;
      }
      const provider = createHttpProvider({
        client,
        source: status.source,
        depthReason: status.depth.reason,
        onNotConnected: (reason) => {
          if (mine === generation)
            state.set({ status: 'not-connected', detail: reason, missing: [] });
        },
      });
      const serviceOptions = options.now === undefined ? {} : { now: options.now };
      state.set({
        status: 'connected',
        source: status.source,
        pollSeconds: status.pollSeconds,
        service: createMarketDataService(provider, serviceOptions),
      });
    } catch (error) {
      if (mine !== generation || isAbortError(error)) return;
      if (
        error instanceof ApiClientError &&
        (error.code === 'not_found' || error.code === 'bad_response')
      ) {
        state.set({
          status: 'not-connected',
          detail: `The Elstand server API is not available at ${API_STATUS_PATH}. ${error.message}`,
          missing: [],
        });
        return;
      }
      state.set({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not check the server connection.',
      });
    }
  }

  return {
    state,
    check() {
      void run();
    },
    dispose() {
      generation += 1;
      controller?.abort();
    },
  };
}
