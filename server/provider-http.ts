import { ApiFailure } from './errors.js';

/**
 * The one way the server talks to a data provider (apart from the Twelve Data adapter, which
 * predates it and keeps its own, tested, request code).
 *
 *  - Only `https:` to the host of the configured base URL, with no credentials in the address.
 *  - Redirects are refused, so a credential can never be forwarded to another host.
 *  - Every request has a timeout and the body is read with a size cap.
 *  - Provider output is untrusted: it is parsed here and validated by the adapter, never
 *    repaired. A provider's words are shown to people only after control characters and any
 *    credential have been removed.
 *  - Failures become `ApiFailure`s with the same vocabulary the browser already understands.
 *    No message contains a URL, because a URL can carry a credential.
 */

export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2_000_000;

export interface ProviderCall {
  /** The provider's display name, for messages. */
  readonly label: string;
  /** An https address, with or without a path prefix: `https://api.example.org/v2`. */
  readonly baseUrl: string;
  /** Relative to the base, no leading slash. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET' | 'POST';
  readonly jsonBody?: unknown;
  /** Every credential the call carries, so none can appear in a message. */
  readonly secrets: readonly string[];
  readonly maxBytes?: number;
  /** Recognizes the provider's own error envelope, which several providers send with HTTP 200. */
  readonly recognizeError?: (status: number, body: unknown) => ApiFailure | null;
}

export interface ProviderResponse {
  readonly body: unknown;
  readonly status: number;
  /** One response header, case-insensitively, or null. Used for quota headers only. */
  readonly header: (name: string) => string | null;
}

/** Text from a provider is shown to people: strip control characters and any credential. */
export function sanitizeText(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret !== '') clean = clean.split(secret).join('[redacted]');
  }
  clean = clean
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

/** `Retry-After` is either whole seconds or an HTTP date. Returns whole seconds, or null. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds : null;
  }
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return null;
  const seconds = Math.ceil((date - now) / 1000);
  return seconds > 0 ? seconds : null;
}

/** A base URL an operator may set: https, a host, no credentials, no query, no fragment. */
export function parseBaseUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function buildUrl(call: ProviderCall): URL {
  const base = parseBaseUrl(call.baseUrl);
  if (base === null) {
    throw new ApiFailure(
      'provider_error',
      `The ${call.label} address is not a valid https address.`,
    );
  }
  const url = new URL(`${base}/${call.path}`);
  if (url.origin !== new URL(base).origin || url.username !== '' || url.password !== '') {
    throw new ApiFailure('provider_error', `The ${call.label} request address is not allowed.`);
  }
  for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, value);
  return url;
}

/** Reads at most `maxBytes`; null means the body was larger than allowed. */
async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function httpFailure(
  label: string,
  status: number,
  retryAfterSeconds: number | null,
): ApiFailure {
  if (status === 401 || status === 403) {
    return new ApiFailure(
      'provider_auth',
      `${label} rejected the configured credential (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return new ApiFailure(
      'rate_limited',
      `${label} refused the request because its limit was reached (HTTP 429).`,
      retryAfterSeconds,
    );
  }
  if (status === 408 || status >= 500) {
    return new ApiFailure(
      'provider_error',
      `${label} failed (HTTP ${status}).`,
      retryAfterSeconds,
      {
        retryable: true,
      },
    );
  }
  return new ApiFailure(
    'provider_error',
    `${label} could not serve this request (HTTP ${status}).`,
  );
}

export async function callProvider(deps: HttpDeps, call: ProviderCall): Promise<ProviderResponse> {
  const url = buildUrl(call);
  const method = call.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...call.headers };
  if (call.jsonBody !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method,
      headers,
      ...(call.jsonBody === undefined ? {} : { body: JSON.stringify(call.jsonBody) }),
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new ApiFailure('provider_unreachable', `Could not reach ${call.label}.`, null, {
      retryable: true,
    });
  }

  let text: string | null;
  try {
    text = await readLimited(response, call.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch {
    throw new ApiFailure('provider_unreachable', `The ${call.label} response was cut off.`, null, {
      retryable: true,
    });
  }
  if (text === null) {
    throw new ApiFailure('provider_error', `${call.label} sent a response larger than allowed.`);
  }

  let body: unknown = null;
  let isJson = false;
  try {
    body = JSON.parse(text);
    isJson = true;
  } catch {
    // Handled below, by status.
  }

  if (isJson) {
    const recognized = call.recognizeError?.(response.status, body) ?? null;
    if (recognized !== null) throw recognized;
  }
  if (!response.ok) {
    throw httpFailure(
      call.label,
      response.status,
      parseRetryAfter(response.headers.get('Retry-After'), deps.now()),
    );
  }
  if (!isJson) {
    throw new ApiFailure('provider_error', `${call.label} did not answer with JSON.`);
  }
  return { body, status: response.status, header: (name) => response.headers.get(name) };
}
