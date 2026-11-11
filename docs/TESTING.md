# Testing

`npm run check` runs everything that must pass before a change is committed: typecheck, the policy
linter, the generated-docs check, the formatting check, the unit tests and the browser tests.

## Why fixtures exist, and why they cannot reach the product

Elstand ships no simulated or sample data. But some code can only be exercised with a datum in hand:
validation, rendering, the connected data path, and the available states of modules that have no
real provider (depth, the volatility surface) or whose provider a test cannot reach (the bubbles,
news and calendar, Surface VI, an ELVOID result). Tests therefore use **test-only fixtures and a
stand-in for the vendor**, and the rules below keep them out of the product:

- They live under `tests/`, are deterministic (no randomness, a fixed clock `FIXTURE_NOW`, 2026-01-06
  12:00 UTC), and say so: `tests/support/fixtures.ts` opens with "TEST FIXTURES. NOT MARKET DATA."
- **The build refuses them.** The guards in `scripts/guards.ts` fail the production build if any file
  under `tests/`, `server/`, `api/` or `scripts/`, or any file named like a fixture, mock, sample, demo,
  simulator, test or spec, is an input of the browser bundle (`tests/unit/guards.test.ts`,
  `tests/unit/build.test.ts`, which also run real builds in temporary directories).
- **The policy linter refuses the vocabulary in product code.** Identifiers that say mock, fake, dummy,
  stub or simulated, names such as sample or demo data, and any source of randomness are banned in
  `src/`, `server/` and `api/` (`npm run lint:policy`, `tests/unit/lint-policy.test.ts`).
- The fixtures are never a substitute for a real source. The connected path is verified against
  documented response shapes only; see "What the tests do not cover".

## Unit tests

`npm test` runs `tests/unit/**/*.test.ts` with Node's built-in test runner. Scripts and tests are
TypeScript run by Node's type stripping, with `scripts/register-ts.mjs` resolving the `.js` import
specifiers to `.ts` files.

| Area                                                                                                                                                                             | Files                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core rules: freshness, formatting, instruments, URLs, stores, resources, ticks                                                                                                   | `core.test.ts`, `store-resource.test.ts`                                                                                                                                           |
| Provider contracts and validation, the wire format                                                                                                                               | `data.test.ts`, `wire.test.ts`                                                                                                                                                     |
| Server: handlers, status, caching, secrets never in a response, the Twelve Data adapter                                                                                          | `server-handlers.test.ts`, `server-twelvedata.test.ts`                                                                                                                             |
| Providers: request budgets, retry, caching, the shared HTTP helper, the registry, cache policy, and every adapter against the response shapes it documents                       | `provider-framework.test.ts`, `provider-registry.test.ts`, `provider-adapters.test.ts`                                                                                             |
| Service layer: failure wording, fallback rules, derived-data states, the capability endpoints and the provider page                                                              | `service-layer.test.ts`, `forex-service.test.ts`, `macro-service.test.ts`, `capability-handlers.test.ts`                                                                           |
| Application state: connection classification, feeds, routing, polling                                                                                                            | `connection.test.ts`, `feeds.test.ts`, `router-polling.test.ts`                                                                                                                    |
| Chart: model, geometry, rendering against a recording canvas                                                                                                                     | `chart-model.test.ts`, `chart-geometry.test.ts`, `chart-renderer.test.ts`                                                                                                          |
| Depth arithmetic and formatting                                                                                                                                                  | `depth-format.test.ts`                                                                                                                                                             |
| Macro: data contracts and screening, the browser's reading of the macro endpoints, 3D projection, surface drawing, color ramp, bubble layout, Surface VI proximity and countdown | `macro-data.test.ts`, `http-macro.test.ts`, `macro-projection.test.ts`, `macro-surface-render.test.ts`, `macro-ramp.test.ts`, `macro-bubble-layout.test.ts`, `event-waves.test.ts` |
| Provider status: the ledger of what was really retrieved, the rows of the provider page, one honest state per capability and endpoint                                            | `provider-status.test.ts`                                                                                                                                                          |
| ELVOID: contracts, validator, status machine, controller, improvement lifecycle, registry                                                                                        | `elvoid.test.ts`                                                                                                                                                                   |
| Design rules read from the real stylesheets: palette, neon allowlist, contrast, no gradients, animation or blur                                                                  | `design-tokens.test.ts`, `contrast.test.ts`                                                                                                                                        |
| Build and policy: the guards, real builds, every lint rule, and the real repository                                                                                              | `guards.test.ts`, `build.test.ts`, `lint-policy.test.ts`                                                                                                                           |
| Documentation does not drift from the code                                                                                                                                       | `docs.test.ts`                                                                                                                                                                     |

Support code is in `tests/support/`: the fixtures, a stand-in for the vendor's HTTP API built from its
published response shapes (`fake-vendor.ts`), a recording canvas (`fake-canvas.ts`), a `fetch` that
answers `/api/*` with the real handlers over that stand-in (`app-fetch.ts`), and a small CSS reader
(`css.ts`).

## Browser tests

`npm run test:e2e` builds the product and then runs `tests/e2e/**/*.test.ts` in Playwright's
Chromium, one test file at a time. Run `npm run build` first if you run a file directly.

- **The product, for real.** The browser loads the real production bundle from `dist/`, through the
  same server and the same `vercel.json` headers that `npm run preview` uses, so the
  Content-Security-Policy is enforced exactly as configured. Any console error, uncaught exception or
  failed request fails the test.
- `no-env.test.ts` runs the product with **no environment at all**, which is the state the project's
  main rule is about. The shell, Forex Intelligence, the ELVOID workspace and Macro Intelligence must
  render and stay operable; every data region must say ENV NOT CONNECTION; no simulated or sample data
  may appear anywhere; the server must answer honestly with and without a status endpoint; and
  addresses, layout and accessibility basics are checked too.
- `chart.test.ts` connects the product to a stand-in vendor and exercises the connected path
  through to the canvas: candles drawn from provider bars, every timeframe, the address bar, the
  watchlist, pan, zoom, the crosshair and keyboard control, the data table, loading and failure with
  a Retry, a provider that rejects the key, staleness and a closed market, and layout from desktop
  to phone.
- `providers.test.ts` opens the provider status page with no environment and with Twelve Data
  configured against the stand-in vendor: the ten providers by name, configuration shown by
  variable name only, a variable that exists shown as CONFIGURED — NOT VERIFIED until a real request
  has been answered, a check that makes exactly one request, IMF shown as UNAVAILABLE, and no
  credential anywhere in the page.
- `component-*.test.ts` mount the application with fixtures for a module that has no real provider
  or whose provider a test cannot reach (depth, the volatility surface, the bubbles, news and
  calendar, Surface VI, ELVOID). `component-event-waves.test.ts` covers Surface VI: the waves drawn
  only for the events the calendar rated high, the countdown moving with the clock, the details a
  source gave and only those, the exact words with no calendar, and the phone layout. The harness
  (`tests/e2e/support/component.ts`) builds a **test-only bundle into a temporary directory**, with the
  production content guards off and the secret scan still on, and serves it with the same headers.
  The product's own `dist/` never contains it.

The browser tests cover viewports from 390 to 1920 px wide.

## Running things

```bash
npm test                                   # every unit test
node --import ./scripts/register-ts.mjs --test tests/unit/data.test.ts   # one file
npm run build && node --import ./scripts/register-ts.mjs --test tests/e2e/no-env.test.ts
npm run test:e2e                           # all browser tests, after building
npm run check                              # everything
```

Browser tests need Chromium (`npx playwright install chromium`). Tests that need a scratch
directory use `mkdtemp` under the operating system's temporary directory.

## What the tests do not cover

Said plainly, so a green run is not read as more than it is. **Passing tests that replace the
network do not prove that a live API integration works.**

- **Live provider APIs.** Twelve Data, Frankfurter, the World Bank and the BLS were checked against
  their live APIs from the production deployment, by hand, following the first-connection checklist
  in [ENVIRONMENT.md](ENVIRONMENT.md#first-connection-checklist). Every other adapter is verified
  only against the response shapes its provider documents, through a stand-in. Alpha Vantage, FRED,
  Marketaux, the BEA and Finance Calendar need a key that was not available when they were written;
  Finance Calendar has no anonymous access, and a keyless request to it was refused with HTTP 401 on
  the production deployment. Each provider's status is in [ENVIRONMENT.md](ENVIRONMENT.md#providers).
- **Provider accounting.** The request budgets are Elstand's own counts, tested against a clock. They
  are not compared with a provider's counter, and each server instance keeps its own.
- **Vercel.** The static build, the headers and the handlers are tested locally through one shared
  server. Vercel's packaging of the `api/` functions is proved only by the platform's build and a
  request to the deployment, which no test here can make.
- **Real depth or options data**, which have no provider.
- **Browsers other than Chromium**, and any screen reader. See the accessibility notes in
  [DESIGN.md](DESIGN.md#accessibility).
- **Visual regression and performance.** Layout and behavior are asserted; pixels and frame times
  are not compared against a baseline.
