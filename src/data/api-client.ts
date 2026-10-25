import { parseError, type ApiErrorCode } from './wire.js';

/** Everything that can go wrong between the browser and the Elstand API. */
export type ClientFailureCode =
  | ApiErrorCode
  /** The API could not be reached, or did not answer in time. */
  | 'unreachable'
  /** The path does not exist on this host: the server functions are not deployed. */
  | 'not_found'
  /** The host answered with something that is not the API (an HTML page, malformed JSON). */
  | 'bad_response';

export class ApiClientError extends Error {
  readonly code: ClientFailureCode;
  readonly httpStatus: number | null;

  constructor(code: ClientFailureCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface ApiClient {
  getJson(
    path: string,
    params: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export const DEFAULT_API_TIMEOUT_MS = 20_000;

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createApiClient(
  fetchImpl: typeof fetch,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): ApiClient {
  return {
    async getJson(path, params, signal) {
      const query = new URLSearchParams(params).toString();
      const url = query === '' ? path : `${path}?${query}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiClientError(
          'unreachable',
          error instanceof DOMException && error.name === 'TimeoutError'
            ? 'The Elstand API did not answer in time.'
            : 'Cannot reach the Elstand API.',
        );
      }

      if (response.status === 404) {
        throw new ApiClientError(
          'not_found',
          `The Elstand API was not found at ${path} (HTTP 404).`,
          404,
        );
      }

      let body: unknown;
      const looksJson = (response.headers.get('Content-Type') ?? '').toLowerCase().includes('json');
      try {
        if (!looksJson) throw new Error('not json');
        body = await response.json();
      } catch {
        throw new ApiClientError(
          'bad_response',
          `${path} did not answer with JSON (HTTP ${response.status}).`,
          response.status,
        );
      }

      if (!response.ok) {
        const parsed = parseError(body);
        throw parsed.ok
          ? new ApiClientError(parsed.value.error.code, parsed.value.error.message, response.status)
          : new ApiClientError(
              'bad_response',
              `${path} failed (HTTP ${response.status}).`,
              response.status,
            );
      }
      return body;
    },
  };
}
