# Architecture

Elstand Intelligence is a static single-page application and a small server API, written in strict
TypeScript with **no runtime dependencies**. The browser never talks to a data vendor. It talks to
the Elstand API on its own origin, and the API talks to the vendor with a key the browser never sees.

```text
 browser (src/)                         server (server/, api/)                  vendor
 ---------------                        ----------------------                  ------
 mountApp -> connection.check()  --->   GET /api/status        (names only)
 HTTP provider                   --->   GET /api/quotes?ids=…   -> TTL cache -> Twelve Data /quote
   validates every response      --->   GET /api/candles?id=…&tf=… -> TTL cache -> /time_series
 service -> feeds -> selectors          validates what the vendor sent, returns our own shapes
 panels (DOM, canvas)                   key read from the environment, never returned
```

## Layers and the dependency rule

Imports run one way. `npm run lint:policy` (rule `layering`) fails on any import that goes the other
way, and on any import that leaves the repository.

| Layer   | Directory     | May import                  | Responsibility                                                                                                                                |
| ------- | ------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| core    | `src/core`    | core                        | Pure logic with no I/O: types, the instrument registry, freshness rules, formatting, stores, resources, ticks, URLs.                          |
| data    | `src/data`    | data, core                  | Provider contracts, validation, the wire format shared with the server, the HTTP provider, the market-data service, the Macro data contracts. |
| elvoid  | `src/elvoid`  | elvoid, core                | ELVOID contracts, result validator, status machine, controller, improvement lifecycle, module registry.                                       |
| app     | `src/app`     | app, core, data, elvoid     | Application state: connection, router, polling, feeds, selectors, the shared context. Nothing here draws.                                     |
| ui      | `src/ui`      | ui, app, core, data, elvoid | Everything that builds DOM or draws on a canvas.                                                                                              |
| main    | `src/main.ts` | app, ui, styles             | Entry point. The only place that names the network primitive.                                                                                 |
| server  | `server`      | server, core, data          | API handlers, the Twelve Data adapter, environment reading, the cache. Shares only the validated contracts.                                   |
| api     | `api`         | api, server                 | Vercel function entries. One call each.                                                                                                       |
| scripts | `scripts`     | scripts, server             | Build, dev and preview servers, guards, policy linter, doc generator.                                                                         |
| tests   | `tests`       | anything                    |                                                                                                                                               |

Two single files get one more layer each (`FILE_EXCEPTIONS` in `scripts/lint-policy.ts`):
`src/app/app.ts`, the composition root that mounts the shell and the pages, may import `src/ui`; and
`scripts/gen-docs.ts` may import `src/elvoid`, because it renders the module registry into
[ELVOID-MODULES.md](ELVOID-MODULES.md). The exception cannot spread to the rest of the layer.

Why this shape: the rules that make the product trustworthy (what counts as stale, what a valid book
is) live in `core` and `data`, where nothing can reach the DOM or the network. The server can share
them without sharing anything that draws.

## Data flow

1. `mountApp` (`src/app/app.ts`) builds the application context and calls `connection.check()`.
2. The connection asks `GET /api/status`. The answer decides whether the application is
   **connected**, **not connected** (ENV NOT CONNECTION) or in **error** (SERVER ERROR). No
   component decides this for itself.
3. When connected, the HTTP provider (`src/data/http-provider.ts`) requests quotes for the whole
   watchlist and candles for the selected instrument and timeframe. It uses an injected `fetch`,
   same origin only.
4. On the server, the handler (`server/handlers.ts`) reads the environment, serves from a small
   in-memory cache with request coalescing, and otherwise asks Twelve Data. It validates what came
   back (`validateQuote`, `validateCandles`) and returns Elstand's own wire shapes
   (`src/data/wire.ts`). Provider failures become typed errors (`not_connected`, `provider_auth`,
   `rate_limited`, `provider_error`, `provider_unreachable`, `bad_request`) with fixed HTTP statuses.
5. In the browser, `wire.ts` parses the response, the service (`src/data/service.ts`) validates it
   again, and keyed resources hold it as `idle`, `loading`, `ready` or `error`.
6. A feed (`src/app/feeds.ts`) joins the connection and a key (the selected instrument) to the
   matching resource. When either changes it re-binds, so a response for an old selection or an old
   connection cannot be shown for the current one.
7. Selectors (`src/app/selectors.ts`) turn a ready value plus the source's declared mode and the
   clock into a `DataState`. Panels read states, never raw freshness arithmetic.

**Polling** (`src/app/polling.ts`). Quotes refresh every `pollSeconds.quotes`, and only the
**selected** chart's candles every `pollSeconds.candles`; both come from the server's
`ELSTAND_REFRESH_SECONDS`. Nothing is requested while the tab is hidden, while auto-refresh is
switched off, or off the Forex page. When a hidden tab becomes visible, data older than its interval
refreshes at once. A refresh keeps what is on screen while it runs. If it fails, the last good value
stays, `refreshError` is recorded, and the value keeps ageing, so it turns STALE honestly instead of
being blanked or frozen.

**Stale responses cannot win.** Every resource key carries a token. A response that belongs to a
superseded request is discarded, and a superseded request is aborted.

## The connection state machine

`src/app/connection.ts` holds the one authoritative state.

| From        | Event                                                                  | To                                                           |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| any         | `check()` (startup, Retry, the "Check connection" button)              | `checking`                                                   |
| `checking`  | `/api/status` says `connected: false`                                  | `not-connected`, with the **names** of the missing variables |
| `checking`  | `/api/status` says `connected: true` and the body is valid             | `connected`, with a service built on the declared source     |
| `checking`  | `/api/status` answers 404, or with something that is not JSON          | `not-connected` ("The Elstand server API is not available")  |
| `checking`  | a JSON error, a network failure or timeout, or a malformed status body | `error` (SERVER ERROR)                                       |
| `connected` | any data request fails with `not_connected` or `provider_auth`         | `not-connected`, with the server's message                   |

Anything else that fails on a data request is shown on the panel it affected and leaves the
connection alone. A newer `check()` supersedes an older one in flight.

## Stores, resources and the interface

- **Stores** (`src/core/store.ts`) are tiny synchronous observables with `derived` stores. Setting
  an identical value is a no-op.
- **Views** are `{ el, dispose }`. A `Scope` collects disposers, so leaving a page releases every
  subscription it made.
- **No markup from strings.** Elements are built with `h()` and `svg()` in `src/ui/dom.ts`, which
  set text as text. `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` are banned
  by the policy linter.
- **Routing** (`src/app/router.ts`). Hash routes: `#/forex/EURUSD/H1` and
  `#/macro/vol-surface | bubbles | news-calendar`. Parsing never fails: an unknown or hand-edited
  link falls back to a valid route and the address bar is rewritten to match. The selected chart
  survives a visit to the Macro page, and the document title follows the route.
- **Errors are shown, not swallowed** (`src/ui/error-boundary.ts`). An unexpected error or an
  unhandled rejection raises an UNEXPECTED ERROR banner, because a failure that leaves part of the
  screen stale-looking is exactly what Elstand promises never to show unmarked.
- **Canvas** draws the chart and the 3D surface. Each has a data table beside it for reading every
  value, keyboard control, and a text alternative.

## Integration points

`AppEnvironment` (`src/app/context.ts`) is the single place where a capability is plugged in:

- `elvoidEngine`: an `ElvoidEngine`. Unset in Phase 1, so ELVOID reports NOT CONFIGURED. Everything an
  engine returns is validated before it can be shown ([ELVOID.md](ELVOID.md)).
- `macro.surface`, `macro.feed`, `macro.bubbles`: providers for the Macro modules. Unset in Phase 1,
  so each module answers `unavailable` with the reason no adapter exists, shown as ENV NOT CONNECTION.
- `connection`: a ready-made connection, for tests.

Market data is different: it is connected by the server environment, not by the application
environment, because it needs a secret.

## Security posture

- **Secrets stay on the server.** `TWELVE_DATA_API_KEY` is read by `server/env.ts` and used by
  `server/twelvedata.ts`. The key travels in the `Authorization` header, never in a URL, redirects are
  refused, provider text is sanitized and any echo of the key redacted. `/api/status` lists variable
  _names_ only. The policy linter bans the name and any `process.env` read in browser code, and the
  build fails if the value of a credential-looking variable appears anywhere in `dist/`.
- **The browser calls its own origin only.** One `fetch` exists, injected in `src/main.ts`. The
  policy linter bans absolute URLs and network primitives elsewhere in browser code.
- **Content-Security-Policy** (`vercel.json`): `default-src 'none'; script-src 'self'; style-src
'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri
'none'; form-action 'none'; frame-ancestors 'none'`. No inline script or style, no `eval`, no
  third-party host. The browser tests run under this policy and fail on any console error.
- Also set: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, a `Permissions-Policy` that disables camera, microphone and geolocation,
  and immutable caching for the hashed files under `/assets/`.
- **External links** (a source URL on a news item or a bubble) pass `safeHttpUrl`, which admits only an
  absolute `http` or `https` address without embedded credentials. Anything else, such as
  `javascript:` or `data:`, is shown as plain text and never linked. Links open with
  `rel="noopener noreferrer"`.

## Build and delivery

`npm run build` (`scripts/build.ts`) bundles `src/main.ts` with esbuild into one hashed JavaScript file
and one hashed CSS file, rewrites `index.html` to point at them, copies `public/`, and then runs the
**guards** (`scripts/guards.ts`). If a guard fails, the build fails and nothing is left in `dist/`.
The guards refuse test code, fixtures, mocks, samples, simulators and server code as inputs of the
browser bundle; any credential-looking variable's value in the output; `process.env`, `eval`,
`new Function` or the vendor host in the bundle; and inline script or style in `index.html`.

`npm run dev` and `npm run preview` use one HTTP server (`scripts/serve.ts`) for the static files
and the API, and apply the headers from `vercel.json`, so what is tested locally is what is
configured for production. On Vercel the platform serves the files and the `api/*` functions instead.

TypeScript is strict, with `erasableSyntaxOnly`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax` and unused-symbol errors. Relative imports are
written with `.js` and resolved to `.ts` by `scripts/register-ts.mjs` when running scripts and tests;
esbuild resolves them itself. Nothing suppresses a type error, and the policy linter fails on any
attempt to.

## Known limitations

- **ELVOID interpretation on news and calendar items.** `screenCalendar` and `screenNews` remove any
  interpretation attached to an item while no engine is configured. Once an engine is configured, an
  interpretation that arrives inside a _provider's_ item is shown as ELVOID's, and nothing checks that
  the engine wrote it. Before a news or calendar adapter is connected alongside a real engine, the
  interpretation should be taken only from validated engine results.
- **Depth polling.** The depth feed loads on selection and has a Refresh button, but is not polled,
  because the only provider returns UNAVAILABLE. A real depth adapter needs its own cadence.
- **One warm instance, one cache.** The server cache is in memory per instance. On serverless hosting,
  instances do not share it; the `Cache-Control` headers let a CDN share answers instead.
- **Vercel packaging is unverified.** The functions in `api/` import `../server/*.js` and `../src/*.js`,
  which Vercel's TypeScript build must resolve to `.ts` files. This build has not been deployed.
  Check `/api/status` after the first deploy.
- **Dependencies are not locked** in this repository (no `package-lock.json`), so `npm install` may
  resolve newer versions within the declared ranges until a lockfile is committed.
- **The 3D surface and the bubble chart have no real data source yet.** Their available-state
  rendering is verified with test fixtures only.
