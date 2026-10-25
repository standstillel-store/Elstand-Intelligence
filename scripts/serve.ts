import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createTtlCache, type TtlCache } from '../server/cache.js';
import type { HandlerDeps } from '../server/handlers.js';
import { routeApi } from '../server/router.js';

/**
 * One HTTP server for the built site and the API, shared by `npm run dev`, `npm run preview`
 * and the browser tests, so all three behave the same way. On Vercel the static files and the
 * `api/*` functions are served by the platform instead; the response headers come from the
 * same `vercel.json`, so what is tested locally is what is configured for production.
 */

export interface ServeOptions {
  /** Directory holding `index.html` and `assets/`. */
  readonly rootDir: string;
  /** Response headers declared in vercel.json, from `loadHeaderRules`. */
  readonly headerRules: readonly HeaderRule[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  /** Defaults to a new cache per server, so two servers in one process never share answers. */
  readonly cache?: TtlCache;
  readonly port?: number;
  readonly host?: string;
  /** Called with a one-line summary per request. Never receives headers or bodies. */
  readonly log?: (line: string) => void;
}

export interface HeaderRule {
  /** `/(.*)` for every path, or `/prefix/(.*)` for one directory. */
  readonly source: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

interface VercelConfig {
  readonly headers?: readonly {
    readonly source: string;
    readonly headers: readonly { readonly key: string; readonly value: string }[];
  }[];
}

/** Reads the `headers` section of vercel.json. Anything this server cannot honour is an error. */
export async function loadHeaderRules(vercelJsonPath: string): Promise<readonly HeaderRule[]> {
  const config = JSON.parse(await readFile(vercelJsonPath, 'utf8')) as VercelConfig;
  return (config.headers ?? []).map((rule) => {
    if (!/^\/(?:[a-z0-9_-]+\/)?\(\.\*\)$/i.test(rule.source)) {
      throw new Error(
        `vercel.json header source "${rule.source}" is not supported by scripts/serve.ts. ` +
          'Use "/(.*)" or "/directory/(.*)", or teach serve.ts the new pattern.',
      );
    }
    return {
      source: rule.source,
      headers: Object.fromEntries(rule.headers.map((header) => [header.key, header.value])),
    };
  });
}

function matches(source: string, pathname: string): boolean {
  if (source === '/(.*)') return true;
  return pathname.startsWith(source.slice(0, source.length - '(.*)'.length));
}

export function headersFor(rules: readonly HeaderRule[], pathname: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rule of rules) {
    if (matches(rule.source, pathname)) Object.assign(merged, rule.headers);
  }
  return merged;
}

/** Maps a URL path to a file inside `rootDir`, or null if it would escape it. */
export function resolveStaticPath(rootDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const root = resolve(rootDir);
  const full = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  return full === root || full.startsWith(root + sep) ? full : null;
}

function toRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  return new Request(new URL(incoming.url ?? '/', 'http://localhost'), {
    method: incoming.method ?? 'GET',
    headers,
  });
}

async function send(
  outgoing: ServerResponse,
  response: Response,
  extraHeaders: Readonly<Record<string, string>>,
  headOnly: boolean,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (!(name.toLowerCase() in headers)) headers[name.toLowerCase()] = value;
  }
  const body = Buffer.from(await response.arrayBuffer());
  headers['content-length'] = String(body.length);
  outgoing.writeHead(response.status, headers);
  outgoing.end(headOnly ? undefined : body);
}

function plain(status: number, text: string, allow?: string): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(allow === undefined ? {} : { Allow: allow }),
    },
  });
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const deps: HandlerDeps = {
    env: options.env,
    fetch: options.fetch,
    now: options.now ?? Date.now,
    cache: options.cache ?? createTtlCache(),
  };

  async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const request = toRequest(incoming);
    const { pathname } = new URL(request.url);
    const common = headersFor(options.headerRules, pathname);
    const respond = (response: Response, headOnly = false): Promise<void> =>
      send(outgoing, response, common, headOnly);

    if (pathname.startsWith('/api/')) {
      const routed = routeApi(request, deps);
      options.log?.(`${request.method} ${pathname}`);
      await respond(
        routed === null
          ? new Response(
              JSON.stringify({ error: { code: 'bad_request', message: 'No such API route.' } }),
              {
                status: 404,
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Cache-Control': 'no-store',
                },
              },
            )
          : await routed,
      );
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      await respond(plain(405, 'Method not allowed.', 'GET, HEAD'));
      return;
    }
    const file = resolveStaticPath(options.rootDir, pathname);
    if (file === null) {
      await respond(plain(404, 'Not found.'), request.method === 'HEAD');
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      await respond(plain(404, 'Not found.'), request.method === 'HEAD');
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    await respond(
      new Response(new Uint8Array(content), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Cache-Control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      }),
      request.method === 'HEAD',
    );
  }

  const server: Server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Internal server error.');
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => done());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
