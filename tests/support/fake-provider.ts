/**
 * TEST-ONLY stand-in for a provider's HTTP API, for the adapters other than Twelve Data. It
 * records every request (host, path, query, headers, body) and answers from a function, so a
 * test can drive a real adapter, the shared HTTP helper and the handlers without a network or a
 * key. Nothing it returns is market or macro data, and nothing here may reach `dist`.
 */

export interface ProviderCallRecord {
  readonly host: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly body: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly url: string;
}

export type ProviderReply = Response | Record<string, unknown> | unknown[] | undefined;

export interface FakeProviders {
  readonly fetch: typeof fetch;
  readonly calls: ProviderCallRecord[];
}

export function createFakeProviders(
  respond: (call: ProviderCallRecord) => ProviderReply | Promise<ProviderReply>,
): FakeProviders {
  const calls: ProviderCallRecord[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const call: ProviderCallRecord = {
      host: url.host,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      headers,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
      url: url.toString(),
    };
    calls.push(call);
    const reply = await respond(call);
    if (reply instanceof Response) return reply;
    if (reply === undefined) return json({ message: 'not found' }, 404);
    return json(reply, 200);
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });
}

/** A fetch that always fails like a dropped connection. */
export const unreachableFetch = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;
