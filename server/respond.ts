import { ApiFailure, httpStatusFor } from './errors.js';

/**
 * How every handler answers: JSON, never sniffed, with an explicit cache policy. Written against
 * the Web `Response` type so it runs unchanged on Vercel's Node runtime, in the local server and
 * in tests.
 */

export const NO_STORE = 'no-store';

export function json(
  body: unknown,
  status: number,
  cacheControl: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cacheControl,
      ...extra,
    },
  });
}

export function errorResponse(failure: ApiFailure): Response {
  const extra =
    failure.retryAfterSeconds === null ? {} : { 'Retry-After': String(failure.retryAfterSeconds) };
  return json(
    { error: { code: failure.code, message: failure.message } },
    httpStatusFor(failure.code),
    NO_STORE,
    extra,
  );
}

/** Null for a GET, otherwise the 405 to send. */
export function notGet(request: Request): Response | null {
  if (request.method === 'GET') return null;
  return json(
    { error: { code: 'bad_request', message: 'Only GET is supported.' } },
    405,
    NO_STORE,
    {
      Allow: 'GET',
    },
  );
}

/** A request this server will not act on, written so that it can be shown to a person. */
export function badRequest(message: string): ApiFailure {
  return new ApiFailure('bad_request', message);
}
