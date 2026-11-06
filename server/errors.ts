import type { ApiErrorCode } from '../src/data/wire.js';

export interface FailureOptions {
  /** True when asking again a moment later can reasonably succeed (a 5xx, a timeout). */
  readonly retryable?: boolean;
  /** Which budget ran out, when the failure is a rate limit. */
  readonly budget?: 'minute' | 'day';
  /**
   * True when this server's own request budget refused the request, so the provider was never
   * asked. A refusal the provider itself gave (an HTTP 429, a quota note) is not local, and
   * neither is the pause that follows one.
   */
  readonly local?: boolean;
}

/**
 * A failure the API can describe to the browser. The message is written to be shown to a
 * person and never contains a credential.
 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;
  readonly budget: 'minute' | 'day' | null;
  readonly local: boolean;

  constructor(
    code: ApiErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
    options: FailureOptions = {},
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = options.retryable ?? false;
    this.budget = options.budget ?? null;
    this.local = options.local ?? false;
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
