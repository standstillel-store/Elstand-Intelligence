import type { ApiErrorCode } from '../src/data/wire.js';

/**
 * A failure the API can describe to the browser. The message is written to be shown to a
 * person and never contains a credential.
 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: ApiErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  not_connected: 503,
  provider_auth: 502,
  rate_limited: 429,
  provider_error: 502,
  provider_unreachable: 504,
  bad_request: 400,
};

export function httpStatusFor(code: ApiErrorCode): number {
  return HTTP_STATUS[code];
}

/** Anything that is not already an ApiFailure is reported generically, never with its details. */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure('provider_error', 'The server failed while handling this request.');
}
