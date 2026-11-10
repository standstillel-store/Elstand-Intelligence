import type { SourceInfo } from '../core/types.js';
import type { Candle } from '../core/types.js';
import { ApiClientError, type ApiClient } from './api-client.js';
import { candlesSubject, quoteSubject, type Provenance } from './provenance.js';
import type { CandleSeries, MarketDataProvider, QuoteBatch } from './provider.js';
import { API_CANDLES_PATH, API_QUOTES_PATH, parseCandles, parseQuotes } from './wire.js';
import { parseCandlesProvenance, parseQuotesProvenance } from './wire-providers.js';

export interface HttpProviderOptions {
  readonly client: ApiClient;
  readonly source: SourceInfo;
  /** Why the provider supplies no order-book depth, as stated by the server. */
  readonly depthReason: string;
  /**
   * Called when the server reports that it has no credentials, or that the provider rejected
   * them. The whole application is then not connected, not merely this one request.
   */
  readonly onNotConnected: (reason: string) => void;
  /**
   * Receives the provenance the server attached to an answer, with the time the answer arrived
   * and the subject it is for (`quote:EURUSD`, `candles:EURUSD:H1`). Provenance is metadata: an
   * answer without it still yields its data, and nothing is recorded for it.
   */
  readonly onProvenance?: (provenance: Provenance, attemptedAt: number, subject: string) => void;
  readonly now?: () => number;
}

/**
 * The browser's market-data provider: it talks only to the Elstand API on the same origin.
 * It never sees a vendor payload or a credential, and validates every response before the
 * service and the UI do.
 */
export function createHttpProvider(options: HttpProviderOptions): MarketDataProvider {
  const { client } = options;
  const now = options.now ?? Date.now;

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        (error.code === 'not_connected' || error.code === 'provider_auth')
      ) {
        options.onNotConnected(error.message);
      }
      throw error;
    }
  }

  return {
    info: options.source,

    getQuotes: (instrumentIds, signal) =>
      guarded(async (): Promise<QuoteBatch> => {
        const body = await client.getJson(
          API_QUOTES_PATH,
          { ids: instrumentIds.join(',') },
          signal,
        );
        const parsed = parseQuotes(body);
        if (!parsed.ok) {
          throw new ApiClientError(
            'bad_response',
            `The API sent unusable quotes: ${parsed.error}.`,
          );
        }
        const arrivedAt = now();
        for (const [id, provenance] of Object.entries(parseQuotesProvenance(body))) {
          options.onProvenance?.(provenance, arrivedAt, quoteSubject(id));
        }
        return {
          quotes: parsed.value.quotes,
          failures: new Map(
            Object.entries(parsed.value.failures).map(
              ([id, failure]) => [id, failure.message] as const,
            ),
          ),
        };
      }),

    getCandles: (request, signal) =>
      guarded(async (): Promise<CandleSeries> => {
        const body = await client.getJson(
          API_CANDLES_PATH,
          { id: request.instrumentId, tf: request.timeframe },
          signal,
        );
        const parsed = parseCandles(body);
        if (!parsed.ok) {
          throw new ApiClientError(
            'bad_response',
            `The API sent unusable candles: ${parsed.error}.`,
          );
        }
        const provenance = parseCandlesProvenance(body);
        if (provenance !== null) {
          options.onProvenance?.(
            provenance,
            now(),
            candlesSubject(request.instrumentId, request.timeframe),
          );
        }
        const candles: Candle[] = parsed.value.candles.map(([time, open, high, low, close]) => ({
          time,
          open,
          high,
          low,
          close,
        }));
        return {
          instrumentId: parsed.value.instrumentId,
          timeframe: parsed.value.timeframe,
          candles,
        };
      }),

    getDepth: () =>
      Promise.resolve({ status: 'unavailable', reason: options.depthReason } as const),
  };
}
