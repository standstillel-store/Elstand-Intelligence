# Elstand Intelligence

A forex and macro intelligence terminal. Phase 1 is the foundation: the interface, the data
contracts, the validation rules and the server boundary, built so that **every number on screen
comes from a real provider, or it is not shown at all.**

> **The rule this project is built on.** Elstand ships no sample, simulated, mock or placeholder
> data. Where a data source is not connected, the interface says exactly **ENV NOT CONNECTION**.
> The application starts, renders and stays usable with no environment variables at all.

Phase 1 evolves the ELVOID project (the reasoning engine, described in
[docs/ELVOID.md](docs/ELVOID.md)) into a market workstation. It is deliberately dense and plain:
a watchlist, a chart, a depth panel and a reasoning workspace, not a dashboard of decoration.

## What Phase 1 contains

| Area                       | What exists                                                                                                                                  | With nothing connected                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Forex watchlist            | EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, XAU/USD. Search, select, LIVE / DELAYED / STALE label per quote.              | ENV NOT CONNECTION                                                                                                  |
| Candlestick chart          | M5, M15, M30, H1, H4, D1. Pan, zoom, crosshair, keyboard control, data table.                                                                | ENV NOT CONNECTION                                                                                                  |
| Market depth               | Bids and asks drawn separately, with the venue and the observation time beside every number.                                                 | ENV NOT CONNECTION, then (once connected) UNAVAILABLE with the reason. See [Depth](#depth-is-not-a-universal-book). |
| ELVOID reasoning workspace | Five explicit states, eight fixed sections, a validator for everything an engine returns, a 13-module registry.                              | NOT CONFIGURED. No engine is shipped.                                                                               |
| Macro: volatility surface  | A genuine 3D surface (orbit, zoom, keyboard, hover), its data contract and validation.                                                       | ENV NOT CONNECTION and the reason no adapter exists                                                                 |
| Macro: bubbles             | One bubble per currency (policy rate, CPI, one-month change) with a documented encoding. See [docs/MACRO-BUBBLES.md](docs/MACRO-BUBBLES.md). | ENV NOT CONNECTION and the reason                                                                                   |
| Macro: news and calendar   | Attributed items, time zones, impact classification shown with who assigned it.                                                              | ENV NOT CONNECTION and the reason                                                                                   |

**The one live connection in Phase 1** is market data (quotes and candles) from
[Twelve Data](https://twelvedata.com), through a server-side API in this repository. Its API key
is read on the server only and never reaches the browser. **Depth, options, macro series, news
and calendar have no adapter yet**, so those modules show what they are missing. They are not
filled in. Read [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) before connecting a key: the data
license of your Twelve Data plan decides whether you may show the data publicly.

Not in Phase 1: Telegram, subscriptions, referrals, accounts and authentication, a full ELVOID
engine, backtesting, and order execution. There is no fake login and no placeholder for any of
them.

## Quick start

Requires Node 22. For the browser tests, Playwright's Chromium (`npx playwright install chromium`).

```bash
npm install
npm run dev
```

Open the address it prints (<http://localhost:5173>). With no key set you will see
ENV NOT CONNECTION in the header and in every data panel, which is the correct result.

To connect real market data locally, copy `.env.example` to `.env.local` (git-ignored), set
`TWELVE_DATA_API_KEY`, and restart. Never commit a key. Nothing in the repository contains one,
and the build fails if a secret value reaches the browser bundle.

## Commands

| Command                | What it does                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | Development server: rebuilds on change, serves the app and the API. Reads `.env` and `.env.local`.                                                                    |
| `npm run build`        | Production build into `dist/`, then the build guards (below).                                                                                                         |
| `npm run preview`      | Serves `dist/` and the API with your real environment.                                                                                                                |
| `npm run typecheck`    | `tsc` in strict mode for the browser code and for the server, scripts and tests.                                                                                      |
| `npm run lint:policy`  | The project policy checks: no fabricated data, no secrets or network calls in the browser, no markup built from strings, no suppressed type errors, one-way layering. |
| `npm run docs:check`   | Fails if a generated document is out of date. `npm run docs:gen` rewrites it.                                                                                         |
| `npm run format:check` | Prettier check. `npm run format` applies it.                                                                                                                          |
| `npm test`             | Unit tests (Node's test runner).                                                                                                                                      |
| `npm run test:e2e`     | Builds, then runs the browser tests in Chromium against the production bundle.                                                                                        |
| `npm run check`        | All of the above, in order. This is what must pass before a change is committed.                                                                                      |

The **build guards** fail the build if test code, fixtures, mocks, samples, simulators or server
code are inputs of the browser bundle; if the value of any credential-looking environment variable
appears in the output; if the bundle reads `process.env`, calls `eval` or `new Function`, or
names the vendor host; or if `index.html` carries inline script or style (the CSP forbids both).

## Deploying to Vercel

`vercel.json` sets the build (`npm run build`, output `dist`) and the response headers, including
a strict Content-Security-Policy (`default-src 'none'`, scripts and styles from the same origin
only, `connect-src 'self'`). Set the variables from `.env.example` in the project's Environment
Variables, as server variables. The functions in `api/` are thin entries over `server/`.

**Not verified:** this build has not been deployed to Vercel, and its Twelve Data adapter has not
talked to the live API (no key was available). Both are written against the vendor's published
documentation and covered by tests that replace the network. After the first deploy, check
`/api/status` and follow the first-connection checklist in
[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

## Depth is not a universal book

Spot FX and spot gold trade over the counter across many dealers and venues, so **no single,
consolidated order book exists**. Elstand never draws one. A depth snapshot always names its
venue, shows its observation time, states the unit of its sizes, and describes that venue alone.
A provider that cannot supply a genuine, valid book yields UNAVAILABLE with a reason. Exchange
gold futures are a different instrument and are never substituted for XAU/USD spot.

## Repository layout

```text
src/
  core/      Pure logic with no I/O: types, instruments, freshness rules, formatting, stores.
  data/      Provider contracts, validation, the wire format, the market-data service.
  elvoid/    ELVOID contracts, result validator, status machine, controller, module registry.
  app/       Connection state, router, polling, feeds, the shared application context.
  ui/        Shell, Forex page (chart, watchlist, depth), ELVOID panel, Macro pages.
  styles/    Design tokens and stylesheets.
  main.ts    The only place that touches the network primitive; it injects fetch.
server/      API handlers, the Twelve Data adapter, environment reading, cache.
api/         Vercel function entries (one line of logic each).
scripts/     Build, dev and preview servers, build guards, policy linter, doc generator.
tests/       unit/ (Node), e2e/ (Playwright, production bundle), support/ (test-only fixtures).
docs/        Documentation (below).
```

The dependency order is one-way and enforced by `npm run lint:policy`; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Document                                         | Covers                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | Layers, data flow, the connection state machine, UI conventions, security headers, the build.                                             |
| [docs/DATA-INTEGRITY.md](docs/DATA-INTEGRITY.md) | What "real data only" means in code: data states, validation, nothing repaired, ENV NOT CONNECTION versus SERVER ERROR.                   |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)       | Every environment variable, behavior when each is missing, licensing, the first-connection checklist, variables planned for later phases. |
| [docs/ELVOID.md](docs/ELVOID.md)                 | The five states, the result contract, what the validator refuses, the improvement lifecycle, how an engine would be connected.            |
| [docs/ELVOID-MODULES.md](docs/ELVOID-MODULES.md) | The 13 modules and their status. Generated from the registry.                                                                             |
| [docs/MACRO-BUBBLES.md](docs/MACRO-BUBBLES.md)   | The bubble chart encoding, to the formula.                                                                                                |
| [docs/DESIGN.md](docs/DESIGN.md)                 | Palette, where the neon green may be used, measured contrast, density and accessibility rules.                                            |
| [docs/TESTING.md](docs/TESTING.md)               | Test layers, why fixtures cannot reach the product, how to run each suite.                                                                |

## Known limitations

These are stated here so nobody has to discover them.

- **No `package-lock.json` is committed.** The environment this was built in could not reach the npm
  registry, so dependencies were installed from a local tool cache. Run `npm install` once and
  commit the lockfile it creates, so installs are reproducible.
- **No ESLint.** The project's own rules are enforced by `npm run lint:policy`, which is a policy
  check and not a style linter. Formatting is Prettier's; types are `tsc --strict`'s.
- **Depth has no provider.** The depth panel is complete, but the only provider returns
  UNAVAILABLE. Its book rendering is verified against test fixtures, not against a real venue.
- **The Macro modules have no data adapter**, so their available-state rendering is verified with
  test fixtures only. The fixtures live under `tests/` and cannot be bundled into the product.
- **The Twelve Data adapter and the Vercel deployment are unverified against the real services**
  (see above).
- **ELVOID interpretations on news and calendar items.** With no engine configured, an
  interpretation carried by a provider's item is always removed, and the page says how many were.
  Once an engine is configured, an interpretation that arrives inside a provider's item is shown as
  ELVOID's, and nothing checks that the engine wrote it. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations).
- **Twelve Data's terms.** Individual plans are for personal or internal use. Showing the data to
  the public needs a business plan or a redistribution agreement. See
  [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md#licensing).
