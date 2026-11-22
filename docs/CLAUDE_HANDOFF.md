# Claude handoff: Elstand Intelligence

A continuation brief for the next Claude chat. It describes the repository **as it was verified on
2026-11-21 (about 07:20 UTC, 14:20 WIB)**, on top of commit
`01094105f6c7032325a05fe56bfc6cc559660ae5` (`0109410`). The commit that adds this file comes after
it. Anything that could not be verified is written **UNKNOWN / NOT VERIFIED**. Nothing here is taken
from a plan alone.

How it was verified: `git` (branch, hashes, remote, working tree), the source and tests, `.env.example`,
`vercel.json`, the Vercel project (deployments, project settings, environment variable **names only**),
live `GET /api/providers`, `GET /api/calendar` and `GET /` on the production alias, and a full
`npm run check` run at `0109410`. No secret value was read, printed or written.

Read order for a new chat: this file, then [README.md](../README.md), [ENVIRONMENT.md](ENVIRONMENT.md),
[DATA-INTEGRITY.md](DATA-INTEGRITY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md).

---

## 1. Project identity

| Item                | Verified value                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                | `elstand-intelligence` 0.1.0 (private, `UNLICENSED`, ES modules). A forex and macro intelligence terminal; it evolves the ELVOID reasoning-engine project into a market workstation.                                                                                                                                            |
| Repository          | `https://github.com/standstillel-store/elstand-intelligence` (remote `origin`, no credentials in the URL). Vercel reports the repository as `standstillel-store/Elstand-Intelligence`.                                                                                                                                          |
| Framework           | None. Vanilla TypeScript (strict, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), **zero runtime dependencies**, esbuild bundle, hash-routed single-page app, no UI library.                                                                                           |
| Dev dependencies    | `@types/node` ^22.18.0, `esbuild` ^0.28.2, `playwright` ^1.56.0, `prettier` ^3.8.1, `typescript` ^6.0.3.                                                                                                                                                                                                                        |
| Runtime             | `package.json` says `engines.node` `22.x`; README says Node 22. The Vercel project setting says Node `24.x`. **Which one production actually runs: UNKNOWN / NOT VERIFIED.**                                                                                                                                                    |
| Deployment platform | Vercel. Project `elstand-intelligen` (`prj_CvNMuIrQe9HvFAzOVoWLKWFanSUT`), team `team_BSRAo26jBgvobWO6fPv1eiMe`, region `iad1`, `vercel.json` (build `npm run build`, output `dist`, security headers). Hobby plan (noted earlier in this project; not re-checked today).                                                       |
| Production URL      | `https://elstand-intelligen.vercel.app` (note the spelling: `intelligen`). No custom domain is configured. Vercel Authentication is enabled on the project (`all_except_custom_domains`), so the `vercel.app` addresses are not open to anonymous visitors by project settings (an unauthenticated request was **not** tested). |
| Main branch         | `main`                                                                                                                                                                                                                                                                                                                          |
| Package manager     | npm. **There is no `package-lock.json`**, so versions float within their ranges.                                                                                                                                                                                                                                                |
| Database / storage  | None. No database client, no browser storage API in `src/`, `server/` or `api/`. The server keeps an **in-memory cache and request budgets per server instance**.                                                                                                                                                               |
| Size                | About 20,000 lines of TypeScript in `src/`, `server/`, `api/` (76 files under `src/`, 42 under `server/` and `api/`), 60 TypeScript files under `tests/`.                                                                                                                                                                       |

### Architecture overview

The browser never talks to a data vendor. It talks to the Elstand API on its own origin (nine
functions in `api/`, each one call into `server/`), and the server talks to each provider with a key
the browser never sees. Full detail is in [ARCHITECTURE.md](ARCHITECTURE.md).

```text
browser (src/)  --validates--> GET /api/status | quotes | candles | calendar | news | macro | bubbles | rates | providers
                                  |
        server: registry -> request budget -> cache (+coalescing) -> one retry -> adapter -> validation -> provenance
                                  |
                  provider (Twelve Data, FRED, ShowMyTrades, ...)  -- keys read from the environment, never returned
```

Layers (`src/core` pure logic, `src/data` contracts and validation, `src/app` state and wiring,
`src/ui` DOM and canvas, `server` provider framework and services, `api` thin Vercel functions) obey a
one-way dependency rule enforced by `npm run lint:policy`. Every capability endpoint answers HTTP 200
with `{ provenance, data }`, because "no credential", "rate limited" and "the provider failed" are
product states shown in words. Pages (hash routes): `#/forex/<id>/<timeframe>`, `#/macro/vol-surface`,
`#/macro/bubbles`, `#/macro/news-calendar`, `#/providers`.

---

## 2. Current git state

Snapshot (verified 2026-11-21 by `git` and `git ls-remote`):

| Item                      | Value                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current branch            | `main`                                                                                                                                            |
| Latest commit (at verify) | `01094105f6c7032325a05fe56bfc6cc559660ae5` (`0109410`), 2026-11-21 13:43 +07:00, "docs: record the production check of the ShowMyTrades calendar" |
| Remote `main`             | `01094105f6c7032325a05fe56bfc6cc559660ae5` (equal to local)                                                                                       |
| Working tree              | Clean (`git status --short` empty) before this file was added                                                                                     |
| Total commits on `main`   | 12 before this file                                                                                                                               |
| Local git identity        | `Claude <noreply@anthropic.com>`; no repository hooks installed                                                                                   |

Recent commits that matter:

| Hash      | Date       | What                                                                                                              |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `0109410` | 2026-11-21 | Docs: production check of the ShowMyTrades calendar recorded (including the id/time anomaly)                      |
| `117a835` | 2026-11-21 | **Feature:** free economic calendar fallback; Finance Calendar made optional (squash of the WIP branch, 41 files) |
| `71583e1` | 2026-11-12 | Docs: production check of the Finance Calendar missing-key state                                                  |
| `aae7b02` | 2026-11-12 | Finance Calendar made key-required (superseded by `117a835`, where it became optional)                            |
| `1fd8290` | 2026-11-11 | Real provider data in the browser, the provider status page and the volatility-surface page                       |
| `8f3baba` | 2026-11-11 | Test: every provider key name is guarded from reaching the browser                                                |
| `77edf01` | 2026-11-07 | Service-layer and capability-endpoint tests                                                                       |
| `e4a61f8` | 2026-11-06 | Capability services and endpoints for every provider                                                              |
| `ede6b15` | 2026-11-05 | Adapters, registry and cache policy for the original ten providers                                                |
| `06dabeb` | 2026-10-27 | Shared provider framework (budgets, retry, cache, safe HTTP)                                                      |
| `211ab27` | 2026-10-25 | First commit: the terminal foundation                                                                             |

Branches on `origin`: `main` and **`wip/free-calendar-fallback`** (tip `67c3fe3`). The WIP branch is
the pre-squash history of `117a835`. Its code is identical to `main`; the only differences are three
documents (README, DATA-INTEGRITY, ENVIRONMENT) where `main` is newer. It has been left in place and
**not deleted**, and every push to it creates a Vercel preview deployment. A local branch of the same
name exists in the checkout that produced this file.

Re-verify with:

```bash
git status -sb
git rev-parse HEAD
git ls-remote origin refs/heads/main
git ls-remote --heads origin
```

---

## 3. Current production state

Verified through the Vercel integration on 2026-11-21.

| Item                           | Value                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current production deployment  | `dpl_9iZkUmp47o638dUn8jGaECn4RdbB`, state **READY**, created about 07:04 UTC, `source: redeploy` of commit `0109410`. It was made **after** four environment variables were added (see section 5).                                       |
| Production alias               | `elstand-intelligen.vercel.app` (also `elstand-intelligen-elridho181-9785s-projects.vercel.app` and `elstand-intelligen-git-main-elridho181-9785s-projects.vercel.app`)                                                                  |
| Latest deployed commit         | `0109410` (docs only; the code deployed is that of `117a835`)                                                                                                                                                                            |
| Earlier production deployments | `dpl_4GD6TNQ9L2ViUQPFJJRhyZecFiQf` (`0109410`), `dpl_7xbh2iuFXQCS7PogrA4pketxubaK` (`117a835`), `dpl_9Aoher56pQw1KEuybwHbekKAfqPE` (`71583e1`, recorded earlier in this project and not re-read today)                                   |
| Served bundle                  | `GET /` returned HTTP 200 with `assets/main-FL5WJVSV.js` and `assets/main-ZOGFGYRU.css`; a local production build at `0109410` produced the same two file names.                                                                         |
| Runtime errors                 | None in the hour after the `117a835` deployment (`get_runtime_errors`, 1 h window). Not re-read after the redeploy.                                                                                                                      |
| Endpoints                      | `GET /api/status`, `/api/quotes?ids=`, `/api/candles?id=&tf=`, `/api/calendar`, `/api/news`, `/api/macro`, `/api/bubbles`, `/api/rates`, `/api/providers` and `/api/providers?probe=<id>` (one real request to one provider, on demand). |

How to read production without the Vercel login wall: use the Vercel integration's `web_fetch_vercel_url`
(it creates a temporary share link). `curl` from the sandbox cannot reach the provider hosts.

### VERIFIED IN PRODUCTION

| What                                                                                                                                                                                       | When / on what                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **ShowMyTrades answers `/api/calendar`**: state DELAYED (not LIVE), 150 events, none excluded, cache fresh, no fallback, credit line and coverage notes present, `null` for absent figures | 2026-11-21 06:41 UTC, deployment of `117a835`                                   |
| `/api/providers` lists 13 providers with their real configuration state (read again at 07:16 UTC, after the redeploy)                                                                      | 2026-11-21                                                                      |
| Twelve Data: authentication, quotes for EUR/USD and XAU/USD, hourly EUR/USD candles                                                                                                        | 2026-11-10 and 2026-11-11, deployment of `1fd8290` (recorded in ENVIRONMENT.md) |
| Frankfurter, World Bank, BLS (keyless version 1): data answered and validated                                                                                                              | 2026-11-10 and 2026-11-11, deployment of `1fd8290` (recorded in ENVIRONMENT.md) |
| Finance Calendar without a key is refused with HTTP 401 (why it is optional now)                                                                                                           | 2026-11-10, historical                                                          |
| `GET /` serves the single-page app                                                                                                                                                         | 2026-11-21                                                                      |

None of these values was compared against the provider's own site.

### IMPLEMENTED BUT NOT VERIFIED

| What                                                                                            | Why it is not verified                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Alpha Vantage, FRED, BEA, Marketaux**                                                         | Their keys are present in Vercel as of about 07:04 UTC and `/api/providers` says `ready`, but **no request to any of them has been observed.** A variable is not a connection. |
| **XOOMAR (calendar fallback)**                                                                  | Never asked in production, on purpose. The fallback is proved only by tests that make the primary fail.                                                                        |
| The fallback path in production, and the stale / rate-limited / all-unavailable calendar states | Exercised only by tests.                                                                                                                                                       |
| Calendar `actual` and `surprise` with real provider data                                        | All 150 events observed were upcoming, so none had an actual.                                                                                                                  |
| Finance Calendar with a key                                                                     | No key exists.                                                                                                                                                                 |
| Macro series, macro bubbles and news in production with the newly added keys                    | Not requested after the keys were added.                                                                                                                                       |
| Real-time quotes (`LIVE`)                                                                       | `ELSTAND_FEED_REALTIME` is not set in production, so quotes are labelled DELAYED. Whether the plan is real-time: UNKNOWN.                                                      |
| Options data, order-book depth, the ELVOID engine                                               | Not built. See sections 4 and 8.                                                                                                                                               |

---

## 4. Provider inventory

"Status" is the live configuration state from `GET /api/providers` on 2026-11-21 at 07:16 UTC. `ready`
means only that a request **may** be sent. It does not mean the provider works. Details per provider:
[ENVIRONMENT.md](ENVIRONMENT.md#providers).

| Provider                  | Purpose                                                     | Adapter (in `server/`) | ENV                                            | Status (registry)                 | Production verified                          | Notes                                                                                                                             |
| ------------------------- | ----------------------------------------------------------- | ---------------------- | ---------------------------------------------- | --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Twelve Data               | Forex quotes and candles (primary)                          | `twelvedata.ts`        | `TWELVE_DATA_API_KEY` (required)               | ready, key present                | **Yes** (2026-11-10/11)                      | Basic plan assumed: 8 credits per minute, 800 per day. Labelled DELAYED. Public-display terms of the plan unconfirmed.            |
| Alpha Vantage             | Fallback for daily candles and spot quotes only             | `alphavantage.ts`      | `ALPHA_VANTAGE_API_KEY` (required)             | ready, key present                | **No**                                       | Free key: 25 requests per day; Elstand keeps to 5 per minute and 25 per day. Never for intraday or real-time.                     |
| FRED                      | Policy rates and inflation indices (macro primary)          | `fred.ts`              | `FRED_API_KEY` (required)                      | ready, key present                | **No**                                       | Elstand budget 60 per minute; each series read at most every 6 hours.                                                             |
| U.S. BEA                  | U.S. GDP growth                                             | `bea.ts`               | `BEA_API_KEY` (required)                       | ready, key present                | **No**                                       | Free key: 100 requests per minute per the provider documentation; Elstand budget 30 per minute.                                   |
| U.S. BLS                  | U.S. labour and CPI observations                            | `bls.ts`               | `BLS_API_KEY` (optional)                       | ready, no key (keyless version 1) | **Yes**, keyless (2026-11-10/11)             | Keyless: provider allows 25 queries per day, Elstand budget 5 per minute and 20 per day. Version 2 with a key has not been tried. |
| World Bank                | Annual GDP growth and inflation (reference)                 | `worldbank.ts`         | none (`WORLD_BANK_API_BASE_URL` override)      | ready                             | **Yes** (2026-11-10/11)                      | Answer was STALE as a whole once (US inflation newest value 2024).                                                                |
| IMF Data                  | none                                                        | none                   | none (`IMF_API_BASE_URL` reserved)             | no-endpoint (UNAVAILABLE)         | n/a                                          | No supported public endpoint has been verified. Nothing is requested.                                                             |
| Frankfurter               | Daily ECB reference rates (reference only)                  | `frankfurter.ts`       | none (`FRANKFURTER_API_BASE_URL` override)     | ready                             | **Yes** (2026-11-10/11)                      | Never a substitute for quotes or candles.                                                                                         |
| Marketaux                 | Financial news headlines                                    | `marketaux.ts`         | `MARKETAUX_API_KEY` (required)                 | ready, key present                | **No**                                       | Free plan: 100 requests per day, 3 articles per request. Elstand budget 3 per minute, 90 per day.                                 |
| **ShowMyTrades**          | Economic calendar, **primary**                              | `showmytrades.ts`      | none                                           | ready                             | **Yes** (2026-11-21)                         | Free, no key. DELAYED. Terms forbid reselling it on its own or exposing it as a public calendar API (see section 7).              |
| **XOOMAR**                | Economic calendar, **fallback** (U.S. agency releases only) | `xoomar.ts`            | `XOOMAR_API_KEY` (optional)                    | ready, no key                     | **No, never called**                         | Forecast always `null`. Free licence: personal, academic, internal; no redistribution.                                            |
| Finance Calendar          | Economic calendar, optional legacy                          | `financecalendar.ts`   | `FINANCE_CALENDAR_API_KEY` (optional, legacy)  | env-not-connected                 | Only that a keyless request is refused (401) | Paid key. Asked last, and only if the key exists. Nothing depends on it.                                                          |
| AriB Research             | Candidate economic calendar                                 | **none, by design**    | **none, by design**                            | license-gated                     | n/a                                          | Personal and internal use only. No adapter, no variable, no request can be made.                                                  |
| **Options-data provider** | Would feed the FX implied-volatility surface                | **none**               | none (a name is only suggested, see section 5) | not in the registry               | n/a                                          | **No candidate provider has been chosen or evaluated in the repository: UNKNOWN.** See section 8.                                 |
| Order-book depth provider | Would feed the depth panel                                  | none                   | none (names only suggested)                    | not in the registry               | n/a                                          | The depth panel says UNAVAILABLE.                                                                                                 |

The registry (`server/provider-registry.ts`) holds 13 providers and the project has 11 adapters (AriB
and the IMF have none).

---

## 5. Environment variables

Names only. No value appears here. Production holds exactly these five variables
(read from the Vercel project as names, 2026-11-21): `TWELVE_DATA_API_KEY`, `ALPHA_VANTAGE_API_KEY`,
`FRED_API_KEY`, `BEA_API_KEY`, `MARKETAUX_API_KEY` (all production-only, all stored as sensitive). **No
`ELSTAND_*` variable is set in production**, so the defaults apply. Server-only: no variable is ever
sent to the browser, and the build fails if a secret value reaches the bundle. Nothing is needed
to start the app; with none set every panel says ENV NOT CONNECTION and names the missing variable.

**Required to connect a capability (a secret each)**

| Name                    | Capability                     | In production Vercel | Verified by a request |
| ----------------------- | ------------------------------ | -------------------- | --------------------- |
| `TWELVE_DATA_API_KEY`   | Forex quotes and candles       | present              | yes                   |
| `ALPHA_VANTAGE_API_KEY` | Daily-candle and spot fallback | present              | **no**                |
| `FRED_API_KEY`          | Macro observations             | present              | **no**                |
| `BEA_API_KEY`           | U.S. GDP                       | present              | **no**                |
| `MARKETAUX_API_KEY`     | News                           | present              | **no**                |

**Optional**

| Name                                                                                                                 | Effect                                                                                                                   | In production |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `XOOMAR_API_KEY` (secret)                                                                                            | Raises the XOOMAR fallback allowance; the fallback is asked without it                                                   | absent        |
| `BLS_API_KEY` (secret)                                                                                               | Switches BLS from keyless version 1 (25 per day) to version 2                                                            | absent        |
| `ELSTAND_FEED_REALTIME`                                                                                              | Operator's statement that the Twelve Data plan is real-time; only then may fresh data be labelled LIVE. Default: DELAYED | absent        |
| `ELSTAND_REFRESH_SECONDS`                                                                                            | Refresh cadence, default 60, clamped 10 to 3600                                                                          | absent        |
| `TWELVE_DATA_CREDITS_PER_MINUTE`, `TWELVE_DATA_CREDITS_PER_DAY`                                                      | Elstand's own request budget for Twelve Data (defaults 8 and 800)                                                        | absent        |
| `ELSTAND_TTL_CALENDAR_SECONDS`, `ELSTAND_TTL_NEWS_SECONDS`, `ELSTAND_TTL_MACRO_SECONDS`, `ELSTAND_TTL_RATES_SECONDS` | Server cache lifetimes (defaults 900, 1800, 21600, 3600 seconds)                                                         | absent        |
| `FRANKFURTER_API_BASE_URL`, `WORLD_BANK_API_BASE_URL`                                                                | Address overrides (https, no credentials)                                                                                | absent        |

**Not connected** (defined, no value in production): `XOOMAR_API_KEY`, `BLS_API_KEY`,
`FINANCE_CALENDAR_API_KEY`, and the `ELSTAND_*` and `*_BASE_URL` overrides above.

**Legacy**: `FINANCE_CALENDAR_API_KEY` (secret, optional). A paid source kept as an optional extra;
the calendar does not depend on it. Without it the source says ENV NOT CONNECTED and is not asked.

**Reserved, changes nothing**: `IMF_API_BASE_URL` (no IMF endpoint exists).

**Planned, read by no code today** (suggested names in [ENVIRONMENT.md](ENVIRONMENT.md), and a test
fails if code reads one before it is documented): `ELSTAND_OPTIONS_API_KEY` (FX options),
`ELSTAND_DEPTH_API_KEY` and `ELSTAND_DEPTH_VENUE` (order-book depth), `ELVOID_ENGINE_URL` and
`ELVOID_ENGINE_API_KEY` (ELVOID engine). AriB Research has **no** variable and none may be added
without the provider's written permission.

---

## 6. Calendar architecture

Code: `server/feeds-service.ts` (the router, `loadCalendar`), `server/showmytrades.ts`,
`server/xoomar.ts`, `server/financecalendar.ts`, `server/calendar-shared.ts`, the shared request path
`server/service.ts`, and the UI in `src/ui/macro/news-calendar.ts`, `src/ui/macro/event-waves.ts` and
`src/ui/macro/calendar-words.ts`. The detailed prose is in [ENVIRONMENT.md](ENVIRONMENT.md#economic-calendar-sources).

| Aspect                  | Implementation (verified in code and tests)                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary provider        | **ShowMyTrades**, free, no key. Nine currencies (USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF, CNY), impact rated high, medium or low by the provider. Elstand assigns no impact. Market holidays are not requested.                                                                                                                                                                                                                              |
| Fallback provider       | **XOOMAR**, asked only when ShowMyTrades did not give a current validated answer. U.S. agency releases only (BLS, BEA, Census, the Federal Reserve, DOL, Treasury). Forecast always `null`; no status; ids are synthesized from publisher, title and time.                                                                                                                                                                                  |
| Optional third          | **Finance Calendar**, asked last, **only if** `FINANCE_CALENDAR_API_KEY` is set (the registry reading is `ready`). AriB is never asked.                                                                                                                                                                                                                                                                                                     |
| Router rule             | Sources are tried in order; the first **current, validated** answer wins. A copy served after a failure is not an answer (kept only as the best stale copy). When a fallback answers, the provenance carries a fallback reason listing every source that was passed over and why (for example `ShowMyTrades (ERROR): …`). When none answers, the result is UNAVAILABLE ("No economic calendar source answered.") with each source's reason. |
| Validation              | HTTP 200 is not valid. A row is kept only with a usable id, a title, a documented currency, a documented impact rating, a numeric `ts` and a `time` that name the **same instant**, and a plausible date. Anything else is excluded and reported, not repaired. Malformed JSON, an empty body, a non-calendar JSON body, a bad timestamp and unknown status or confidence values are rejected.                                              |
| Normalization           | One `CalendarEvent` shape (`src/data/macro.ts`): `id` (`showmytrades:<id>`), `timeMs`, `timePrecision`, `status` (scheduled, rescheduled, estimated), `movedFromMs`, `period`, `confidence`, `currency`, `impact` with who classified it, `actual`, `forecast`, `previous` as text exactly as the provider wrote them, and the source name, url and retrieval time.                                                                         |
| Forecast and actual     | `null` when the provider sent nothing. **Never `0`, never invented.** XOOMAR's forecast is always `null`.                                                                                                                                                                                                                                                                                                                                   |
| Surprise                | `actual − forecast` only when both are present, plain numbers and in the same unit (`surpriseBetween` in `server/calendar-shared.ts`). Otherwise the UI says `SURPRISE UNAVAILABLE` with the reason. Never calculated from a missing value.                                                                                                                                                                                                 |
| Cache and TTL           | Calendar class: **900 s** (`ELSTAND_TTL_CALENDAR_SECONDS`, clamped 300 to 86400). Fresh window for CACHED is 2 h; older is STALE. Stale-if-error window is 1 day. `Cache-Control` lets a CDN share an answer. ShowMyTrades cache key is `calendar:showmytrades:<days>`.                                                                                                                                                                     |
| Request window          | ShowMyTrades opens **6 hours before** the request and spans at most 30 days. `days` is rounded up to 2, 8, 15 or 30 so pages asking for different days share one answer. The answer is cut back to the asked window, and what the window does not cover is said in notes (for example "answers only from 2026-11-21 00:41 UTC").                                                                                                            |
| ETag                    | The answer's `ETag` is kept (`ValidatorStore`); the next request is conditional and a 304 is served from the held copy. An invalid ETag header is ignored.                                                                                                                                                                                                                                                                                  |
| Rate limiting           | Per-provider budgets, per server instance: ShowMyTrades 30 per minute (provider allows 600), XOOMAR 6 per minute without a key and 20 with one (provider 10 and 30), Finance Calendar 10 per minute and 750 per day, AriB 0. HTTP 429 becomes **RATE LIMITED**. One request per cache lifetime.                                                                                                                                             |
| Failure handling        | 401 or 403 from a keyed provider is ERROR (credential refused). A keyless provider that refuses says so without blaming a missing key (`callWithoutCredential`). 408 and 5xx are retried once. Unreachable, non-JSON and oversize answers are ERROR. A missing credential is ENV NOT CONNECTED, and that wording is **never** used for a source that needs no key.                                                                          |
| Stale behaviour         | A kept copy after a failure is labelled CACHED, then STALE, and is never drawn as current or as LIVE.                                                                                                                                                                                                                                                                                                                                       |
| Unavailable behaviour   | All sources failed: UNAVAILABLE (or ERROR) with every reason; the panels draw nothing and invent nothing. Surface VI says "Surface VI event waves are disabled." The UNAVAILABLE aggregate has no Retry button; ERROR and RATE LIMITED do.                                                                                                                                                                                                  |
| Provenance in the UI    | `EVENT DATA: SHOWMYTRADES` or `EVENT DATA: XOOMAR`, with state and retrieval time (`data-event-data` attribute), a FALLBACK SOURCE notice when the primary was passed over, the provider's credit line, and TIME ESTIMATED / TIME DISPUTED when the provider says so.                                                                                                                                                                       |
| Production verification | **ShowMyTrades: verified in production** (2026-11-21, 06:41 UTC, `117a835`): DELAYED, 150 events, 33 with a forecast, none with an actual (all upcoming), one `rescheduled` with a moved-from time, currencies EUR, USD, JPY, AUD, GBP, NZD, CAD, CHF. **XOOMAR: tested through stand-ins only, never called in production.**                                                                                                               |

Explicit statements, as the owner asked:

- ShowMyTrades **has been verified in production**.
- XOOMAR fallback **has been tested through tests but never called in production**.
- Finance Calendar is **optional** (and legacy).
- AriB is **license-gated**: no adapter, no variable, no request.

Observed anomaly (see also section 11): for 39 of the 150 production events, the date inside the
provider's own event id differs by one to three days from the event's `time`. The adapter reads the
time only from `time` and `ts`, which it requires to agree, and never from an id. Which of the two the
provider means was **not determined**.

---

## 7. DATA LICENSING RISKS

This is the operator's responsibility and the application cannot check it. **No legal conclusion is
drawn here.** For every provider below, whether a _public_ Elstand deployment is permitted is
UNKNOWN / NOT VERIFIED unless a line says otherwise. Fuller text: [ENVIRONMENT.md](ENVIRONMENT.md#licensing).

| Provider                                                          | What the repository records                                                                                                                          | Needs attribution                                         | Redistribution restriction | Needs permission                            | Terms verified for a public deployment |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------- | ------------------------------------------- | -------------------------------------- |
| **ShowMyTrades**                                                  | Terms forbid reselling the calendar on its own or exposing it as a public calendar API. `/api/calendar` is a relay in front of it.                   | Credit shown: `Economic calendar by ShowMyTrades`, linked | **Yes, as recorded**       | **Operator must confirm or obtain it**      | **No**                                 |
| **XOOMAR**                                                        | Free licence: personal, academic and internal use with a visible credit; no redistribution. No variable switches the fallback off.                   | Visible credit, shown with each event                     | **Yes, as recorded**       | **Operator must confirm or hold a licence** | **No**                                 |
| **AriB**                                                          | Free tier: personal and internal use only.                                                                                                           | n/a                                                       | Yes                        | **Yes, written permission** (never used)    | n/a (never used)                       |
| Finance Calendar                                                  | Paid plan. Terms ask for a visible link to its site and for the publisher links, licences, credits and notices supplied with each record to be kept. | Yes: link, plus each event's own credits and licences     | Not reviewed for your plan | Plan-dependent: UNKNOWN                     | **No**                                 |
| Twelve Data                                                       | Individual plans are for personal or internal use; public display needs a business plan or a redistribution agreement. Which plan is held: UNKNOWN.  | UNKNOWN                                                   | Recorded as above          | Likely, for public display (per the docs)   | **No**                                 |
| Alpha Vantage, FRED, BEA, BLS, World Bank, Frankfurter, Marketaux | Terms **have not been reviewed** on the owner's behalf.                                                                                              | UNKNOWN                                                   | UNKNOWN                    | UNKNOWN                                     | **No**                                 |
| IMF                                                               | No adapter; nothing is requested.                                                                                                                    | n/a                                                       | n/a                        | n/a                                         | n/a                                    |

**"Safe based on verified information": none.** No provider's terms have been confirmed for a public
deployment. Mitigations that exist: credits are shown; Elstand keeps below published rate limits;
AriB is never asked; Vercel Authentication is enabled on the project (a deployment setting, **not** a
licence answer). Calendar `/api/calendar` and `/api/providers` are the public-relay surfaces to think
about first.

---

## 8. Surface VI current state

Naming: the **Macro, Volatility surface** tab (`#/macro/vol-surface`) stacks two modules
(`src/ui/macro/page.ts`): the 3D implied-volatility surface (`src/ui/macro/vol-surface.ts`) and the panel titled
**"Event proximity · Surface VI"** (`src/ui/macro/event-waves.ts`). The code and
[EVENT-WAVES.md](EVENT-WAVES.md) treat "Surface VI" as that second panel ("the owner's 'Surface VI'
layer"), with a note that the name may be meant for something else.

### Existing UI

- **Event proximity · Surface VI** (real data when the calendar answers): a small static SVG wave per
  event, a countdown from the device clock, the source's own importance rating (default: only events
  the source rated high), `EVENT DATA: <PROVIDER>` provenance, an inspector (period, timing
  confidence, moved-from time, surprise or `SURPRISE UNAVAILABLE`). A wave means **proximity only**,
  rising over the 24 hours before the stated time and settling over the hour after
  (`src/core/event-waves.ts`). It is not measured or implied volatility and not a forecast.
- **3D volatility surface** (`src/ui/macro/vol-surface.ts`, `surface-view.ts`, `surface-render.ts`,
  `projection.ts`, `ramp.ts`): a genuine 3D mesh with orbit, zoom, keyboard, hover, a data table, an
  encoding explanation and axis-kind labels. It draws **only** a validated `VolSurface`.

### Existing backend / data

- Calendar only (section 6). No server code reads or returns options data.
- The contract is `src/data/options.ts`: `VolSurface` (instrument id, `asOf`, source, a strike axis
  whose kind is `log-moneyness`, `strike-over-forward` or `delta`, expiries in days, and
  `iv[expiry][strike]` in percent), `VolSurfaceProvider`, `validateVolSurface`,
  `validateVolSurfaceFor` (a surface for another instrument is never drawn), and staleness tolerances
  of 10 minutes (live) and 60 minutes (delayed). `volRange` (the minimum and maximum) is the only
  arithmetic done on the values.
- In the app, `ctx.macro.surface` defaults to `createUnconfiguredSurfaceProvider()` (`src/app/context.ts`),
  which always answers `unavailable`.

### Missing options infrastructure

**The project has no FX options-data adapter.** There is no registry entry, no variable read by code,
no server capability or endpoint, no wire shape for options, and no tests against a real vendor
response. It does **not** have, and must not claim: implied volatility, ATM IV, 25Δ risk reversal,
25Δ butterfly, a strike surface or a delta surface. The words appear in code only in one comment in
`src/data/options.ts`; nothing calculates them.

### Current empty state

On `#/macro/vol-surface` the surface module shows ENV NOT CONNECTION with "An options-data provider is
not connected." and the reason: "No options-data adapter exists in this build, so there is nothing to
connect. A real FX volatility surface needs vendor option quotes plus a documented delta-to-strike
convention (spot or forward delta, premium included or not)." The e2e suite checks this against the
real server. The 3D rendering of an available surface is verified **with test fixtures only**
(`tests/support/fixtures.ts`, served by the test harness, never bundled).

### Planned implementation (not started)

Only what the repository already says is planned: an options adapter behind the existing
`VolSurfaceProvider` contract, with the delta-to-strike convention stated in the adapter, a suggested
variable `ELSTAND_OPTIONS_API_KEY`, and ELVOID's "Volatility and liquidity analysis" module, which is
`CONTRACT ONLY` ([ELVOID-MODULES.md](ELVOID-MODULES.md)). **Which vendor, what quote types it
supplies, and whether its licence allows display: UNKNOWN / NOT VERIFIED.**

---

## 9. Data integrity rules (hard rules)

Source: [DATA-INTEGRITY.md](DATA-INTEGRITY.md), enforced by `npm run lint:policy` and the tests.

1. **No fake market data.** No sample, mock, simulated, seeded, random or placeholder source in the
   product. Nothing connected means the exact text **ENV NOT CONNECTION** (the single copy is in
   `src/core/connection-text.ts`) plus a sentence naming the missing variable.
2. **`null` stays `null`.** A figure a provider did not send is absent, never `0`, never filled in.
3. **Delayed is not live.** `LIVE` only when the operator declares it (`ELSTAND_FEED_REALTIME`);
   an HTTP 200 proves nothing about freshness.
4. **Unavailable is not zero.** A missing value is UNAVAILABLE, with the reason.
5. **Never fabricate a forecast, an actual, a surprise or a timestamp.** Surprise is actual minus
   forecast only when both exist in the same unit.
6. **Never infer a provider timestamp from a provider id.** By inspection the adapter uses an id
   only as an opaque identifier (a character check) and takes times from `time` and `ts`. **No test
   asserts this rule directly: NOT VERIFIED by a test.**
7. **Provider output is untrusted**: validated on the server and again in the browser. Nothing is
   repaired, clamped, interpolated or back-filled.
8. **Production fixtures are for tests only.** They live under `tests/` and the build refuses to
   bundle them (`scripts/guards.ts`).
9. **Every datum traces to a source**: provider, endpoint, state, retrieval time, data time, cache
   use. An item without attribution is rejected.
10. **Stale data is labelled** (CACHED, then STALE); a fallback says it is one and why, and is never
    used to cover a missing or rejected credential.
11. **A connection is what a request proved.** A variable that exists makes a provider "configured".
12. **Secrets stay on the server**, in no message, no log, no response; keys are never in the bundle.
13. **A wave is proximity, never "predicted volatility".** Elstand assigns no impact rating.

---

## 10. Test status

Run on 2026-11-21, 07:15 to 07:17 UTC, on `0109410` with a clean working tree, as one `npm run check`
(exit code 0). Environment: Node 22.23.4, Playwright 1.63.0 with Chromium, **`@types/node` 26.6.3** (the
project declares ^22.18.0; see section 11).

| Check             | Result                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests        | **957 of 957 pass**, 197 suites, 36 files in `tests/unit/`, 0 skipped                                                                                                    |
| End-to-end        | **280 of 280 pass**, 47 suites, 9 files in `tests/e2e/`, real Chromium, `--test-concurrency=1`. Chromium only.                                                           |
| Typecheck         | Pass (`tsconfig.json`, `tsconfig.node.json` which includes the tests, `tsconfig.vercel.json`)                                                                            |
| Lint (policy)     | Pass: "221 files checked against 21 rules" (`npm run lint:policy`; this is a policy linter, not a style linter)                                                          |
| Docs check        | Pass (`docs/ELVOID-MODULES.md` is generated and up to date); `tests/unit/docs.test.ts` ties documents to code                                                            |
| Format check      | Pass (Prettier)                                                                                                                                                          |
| Production build  | Pass (`npm run build`): `main-FL5WJVSV.js` 163.0 kB, `main-ZOGFGYRU.css` 25.7 kB; same names as served in production                                                     |
| **Security scan** | **NOT RUN.** HawkScan needs a `HAWK_API_KEY` that is not available; none was run and none may be claimed. `npm audit` and dependency scans were not run either: UNKNOWN. |

Test-only fixtures: `tests/support/` and the component harness. Run everything with `npm run check`
(`npm run test:e2e` builds first). Passing tests that use stand-ins for the network do **not** prove a
live provider integration ([TESTING.md](TESTING.md)).

---

## 11. Known issues

| #   | Issue                                                                                                                                                                                                                         | Impact                                                                                                                                                   | Current workaround                                                                        | Next action                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Provider licensing**: ShowMyTrades forbids a public calendar API relay; XOOMAR allows no redistribution; Twelve Data plan terms unconfirmed; other terms unreviewed (section 7)                                             | Public deployment may breach terms. Not a code defect.                                                                                                   | Credits shown; rate limits respected; Vercel Authentication currently on; AriB never used | Owner confirms or obtains permission per provider before any public exposure; record the answer in ENVIRONMENT.md                          |
| 2   | **Calendar timestamp anomaly**: 39 of 150 ShowMyTrades events have an id date 1 to 3 days off their `time` (for example a Japanese PMI: id 23 Nov, time 24 Nov 00:30 UTC)                                                     | If the ids are right and `time` is wrong, wave timing and countdowns would be wrong. Which is right: not determined.                                     | Time is read only from `time`/`ts`, which must agree; ids are opaque                      | Compare a sample against the publishers' schedules; add a test that a time is never taken from an id; consider asking ShowMyTrades         |
| 3   | **Options data unavailable**: no FX options adapter                                                                                                                                                                           | The 3D surface can never show real data; Surface VI (IV) is empty                                                                                        | Honest ENV NOT CONNECTION with the reason                                                 | Section 14, P1: research a provider, then build the adapter                                                                                |
| 4   | **XOOMAR fallback never observed in production**                                                                                                                                                                              | Unknown whether the live response matches the documented shape; fallback proved only by tests                                                            | Tests make the primary fail; no production call made to prove it                          | Owner decides whether a one-off `/api/providers?probe=xoomar` is acceptable (one real request, free licence terms apply)                   |
| 5   | **Four newly keyed providers unverified**: Alpha Vantage, FRED, BEA, Marketaux (keys present since about 07:04 UTC)                                                                                                           | Macro, bubbles, news and the daily-candle fallback may show ERROR or wrong shapes at first contact; adapters were written against documented shapes only | None needed to keep the app safe: failures are shown as ERROR                             | `/api/providers?probe=<id>` for each (one request each; Alpha Vantage 25 per day, Marketaux 100 per day), record results in ENVIRONMENT.md |
| 6   | **npm and type mismatch**: the sandbox that produced the tests had `@types/node` 26.6.3 (package asks ^22.18.0) and a `node_modules` assembled from symlinks because the registry was unreachable; **no `package-lock.json`** | A clean `npm install` may resolve different versions than were tested; Node-26 types may hide Node-22 API gaps                                           | Vercel's own build succeeds on every push                                                 | Run `npm install` where the registry is reachable, rerun `npm run check`, and commit a lockfile                                            |
| 7   | **Node version ambiguity**: `engines` 22.x vs Vercel project setting 24.x                                                                                                                                                     | Production may run a different Node major than the one tested                                                                                            | None                                                                                      | Check the deployment's runtime, then align the project setting and `engines`                                                               |
| 8   | **Security scan unavailable** (HawkScan needs an API key; not run)                                                                                                                                                            | No DAST result exists for any commit                                                                                                                     | Policy linter, CSP and headers in `vercel.json`, key-guard tests                          | Owner provides a key, or another scanner is chosen; never claim a scan that did not run                                                    |
| 9   | **Production access**: Vercel Authentication is on for the `vercel.app` addresses and there is no custom domain                                                                                                               | Anonymous visitors presumably cannot reach the app (not tested); matters for licensing and for any "public" claim                                        | Reading production through the Vercel integration                                         | Owner decides the exposure model together with issue 1                                                                                     |
| 10  | **Stale wording in docs**: README (intro and file tree) and ARCHITECTURE say "ten" providers or adapters; the registry has 13 providers and there are 11 adapters                                                             | Misleads a reader                                                                                                                                        | This file states the true counts                                                          | Fix the three sentences in README and ARCHITECTURE in a docs-only commit                                                                   |
| 11  | **Per-instance caches and budgets** on serverless hosting                                                                                                                                                                     | Several instances multiply the requests a provider sees; budgets are not the provider's own counter                                                      | `Cache-Control` lets the CDN share answers                                                | Only revisit if a quota problem is observed                                                                                                |
| 12  | **Calendar edge behaviour**: the UNAVAILABLE aggregate has no Retry button; while ShowMyTrades is down each uncached refresh also spends XOOMAR's small keyless budget                                                        | A user cannot retry an UNAVAILABLE calendar by button; XOOMAR may run out sooner                                                                         | Cache of 15 minutes; ERROR and RATE LIMITED do offer Retry                                | Decide if UNAVAILABLE needs Retry                                                                                                          |
| 13  | **ShowMyTrades window**: begins 6 hours before the request, at most 30 days; **actual and surprise never seen with real data**                                                                                                | Earlier events are not covered; the actual/surprise path is verified by tests only                                                                       | Notes state the uncovered part                                                            | Re-check `/api/calendar` after a release time when events carry an actual                                                                  |
| 14  | **Twelve Data labelling**: `ELSTAND_FEED_REALTIME` is not set, so quotes are DELAYED, and whether the plan is real-time is UNKNOWN                                                                                            | The UI never says LIVE; this is intended until the operator declares it                                                                                  | Default DELAYED                                                                           | Owner confirms the plan before setting the variable                                                                                        |
| 15  | **ELVOID interpretation edge** ([ARCHITECTURE.md](ARCHITECTURE.md)): once an engine is connected, nothing checks that an interpretation inside a provider's item was written by the engine                                    | Not reachable today (no engine; interpretations are stripped)                                                                                            | Stripped by `screenCalendar` and `screenNews`                                             | Before connecting an engine, take interpretations only from validated engine results                                                       |
| 16  | **WIP branch left on origin**: `wip/free-calendar-fallback`                                                                                                                                                                   | Creates preview deployments on push; clutter                                                                                                             | Its code equals `main`                                                                    | Delete only with the owner's approval                                                                                                      |
| 17  | The countdown runs on the **device clock**                                                                                                                                                                                    | A wrong device clock shows a wrong countdown                                                                                                             | Said in the panel; stated time shown in UTC                                               | None planned                                                                                                                               |

---

## 12. Important file map

| Area                      | Important files                                                                                                                                                                                        | Purpose                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Provider registry         | `server/provider-registry.ts`, `src/core/provider-state.ts`, `src/data/wire-providers.ts`                                                                                                              | The 13 providers, roles, variables, limits, budgets, license gate, state names. Start here for any provider question.   |
| Provider adapters         | `server/twelvedata.ts`, `alphavantage.ts`, `fred.ts`, `bea.ts`, `bls.ts`, `worldbank.ts`, `frankfurter.ts`, `marketaux.ts`, `showmytrades.ts`, `xoomar.ts`, `financecalendar.ts` (all under `server/`) | Build a request and parse the answer strictly. AriB and IMF have none by design.                                        |
| Shared request path       | `server/service.ts`, `server/provider-runtime.ts`, `server/provider-http.ts`, `server/limiter.ts`, `server/retry.ts`, `server/cache.ts`, `server/cache-policy.ts`, `server/probe.ts`                   | Budget, cache, retry, safe HTTP (https only, no redirects, timeout, size cap), TTLs, on-demand probe.                   |
| Calendar                  | `server/feeds-service.ts` (router), `server/calendar-shared.ts`, `server/showmytrades.ts`, `server/xoomar.ts`, `tests/unit/calendar-resilience.test.ts`, `tests/support/calendar-providers.ts`         | Order, fallback, validation, surprise, ETag; the resilience tests for both adapters and the router.                     |
| Feeds and endpoints       | `server/capability-handlers.ts`, `server/handlers.ts`, `server/router.ts`, `server/respond.ts`, `api/` (nine functions), `src/app/feeds.ts`, `src/data/http-macro.ts`                                  | Endpoints, parameter checks, headers; the browser's feeds.                                                              |
| Validation                | `src/data/validate.ts`, `src/data/macro-validate.ts`, `src/data/wire.ts`, `server/parse.ts`, `src/data/options.ts` (surface validation)                                                                | Quote, candle, macro, calendar and news screening, in the browser and on the server.                                    |
| Freshness                 | `src/core/freshness.ts`, `server/cache-policy.ts`, `server/env.ts`                                                                                                                                     | LIVE, DELAYED, STALE rules and stale tolerances; environment reading and clamping.                                      |
| Surface VI (event waves)  | `src/core/event-waves.ts`, `src/ui/macro/event-waves.ts`, `src/ui/macro/calendar-words.ts`, `docs/EVENT-WAVES.md`, `tests/unit/event-waves.test.ts`, `tests/e2e/component-event-waves.test.ts`         | Proximity maths, the panel, the shared wording, the rules and their tests.                                              |
| Volatility surface (3D)   | `src/data/options.ts`, `src/ui/macro/vol-surface.ts`, `surface-view.ts`, `surface-render.ts`, `projection.ts`, `ramp.ts`, `src/app/context.ts`, `tests/e2e/component-vol-surface.test.ts`              | The contract, the 3D drawing, and the unconfigured provider that says there is no adapter.                              |
| Macro UI                  | `src/ui/macro/page.ts`, `news-calendar.ts`, `bubbles.ts`, `observations-panel.ts`, `states.ts` (all under `src/ui/macro/`), `src/ui/providers/page.ts`, `src/app/provider-rows.ts`                     | Tabs, the calendar list, bubbles, observations, shared states (ENV NOT CONNECTION, FALLBACK SOURCE), the provider page. |
| ELVOID                    | `src/elvoid/contracts.ts`, `src/elvoid/modules.ts`, `docs/ELVOID.md`, `docs/ELVOID-MODULES.md` (generated)                                                                                             | The engine contract and validator; 13-module registry (no engine is shipped).                                           |
| Tests                     | `tests/unit/`, `tests/e2e/`, `tests/e2e/support/`, `tests/support/fixtures.ts`, `tests/unit/docs.test.ts`, `tests/e2e/no-env.test.ts`, `tests/e2e/providers.test.ts`                                   | Unit, browser, fixtures (test-only), the docs-to-code test, the no-environment run, the provider page.                  |
| Build guards              | `scripts/build.ts`, `scripts/guards.ts`, `scripts/lint-policy.ts`, `scripts/gen-docs.ts`                                                                                                               | The production build, the rule that fixtures and secrets cannot reach the bundle, the 21 policy rules, generated docs.  |
| Docs                      | `README.md`, `docs/ENVIRONMENT.md`, `docs/DATA-INTEGRITY.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/EVENT-WAVES.md`, `docs/MACRO-BUBBLES.md`, `docs/DESIGN.md`                              | Per-provider limits and live-check records (ENVIRONMENT), the rules, the layers, the tests.                             |
| Environment configuration | `.env.example` (every line commented out), `server/env.ts`, `server/provider-registry.ts`, `src/core/connection-text.ts`, `vercel.json`, `tsconfig.vercel.json`                                        | Variable names and meaning, the one ENV NOT CONNECTION text, security headers and the build command.                    |

---

## 13. Architectural decisions (do not reverse without a reason)

1. **Real data only; ENV NOT CONNECTION otherwise.** Never a sample, a placeholder or a guess.
2. **Provider abstraction.** One registry row and one adapter per provider; adapters build the request
   and parse strictly; everything else (budget, cache, retry, provenance) is shared. The browser never
   contacts a provider.
3. **Validate before analysis.** On the server and again in the browser; failures are states, not
   repaired values.
4. **Cache before repeated provider calls.** Per-class lifetimes, request coalescing, `ETag`
   conditional requests, per-provider budgets set below published limits.
5. **Fallback architecture.** A fallback serves data of the same kind only, says it is a fallback and
   why, and never covers a missing or rejected credential. The router returns the first current,
   validated answer; stale copies are never answers.
6. **`null` semantics.** Absent is `null`; unavailable is not zero; a surprise needs both inputs.
7. **Freshness states.** LIVE only by operator declaration; DELAYED by default; CACHED then STALE after
   failures; RATE LIMITED, ERROR, UNAVAILABLE and ENV NOT CONNECTED each mean one thing, and a keyless
   source is never called ENV NOT CONNECTED.
8. **Licensing awareness.** A license-gated provider (AriB) has no adapter and no variable. Credits
   travel with data. Public use is the operator's decision and is documented, not assumed.
9. **Secrets are server-only**, never in messages, logs, responses or the bundle (guarded by tests).
10. **Surface VI draws proximity, never predicted volatility**; Elstand assigns no impact rating.
11. **Future options provider abstraction.** Options data enters only through `VolSurfaceProvider`
    and `VolSurface` with an explicit strike-axis kind and a stated delta-to-strike convention; the
    surface shows only measured points, with no smoothing or extrapolation.
12. **Zero runtime dependencies**, strict TypeScript, and a one-way layer rule enforced by the linter.
13. **Fixtures live only under `tests/`**, and the build refuses to bundle them.

---

## 14. Current roadmap

Built from the repository's present state and its own documents. Priority order requested by the
owner: licensing, Surface VI real data, options provider research, provider validation, production
verification, cleanup.

**P0: Blocking**

1. **Licensing and data rights** (owner decisions, not code): confirm or obtain permission for
   ShowMyTrades (public relay), XOOMAR (redistribution) and the Twelve Data plan; review the unreviewed
   terms (Alpha Vantage, FRED, BEA, BLS, World Bank, Frankfurter, Marketaux); then record the answers in
   ENVIRONMENT.md. Decide the exposure model (Vercel Authentication, custom domain) together with it.

**P1: Next**

2. **Surface VI real-data implementation**: the event layer already draws real calendar data; the
   missing half is the IV surface. Design the options path end to end: registry entry, adapter, a
   server capability and endpoint, wire shape and validation, browser feed into `ctx.macro.surface`,
   tests with fixtures under `tests/` only, and docs. Do not show IV, ATM IV, 25Δ RR or BF, or any
   surface until a real source supplies them.
3. **Options provider research**: find which vendors supply FX option quotes (ATM, risk reversals,
   butterflies by delta, expiries), their delta-to-strike convention, their licence for display, and
   their free-tier limits. Nothing about a vendor is known in the repository: UNKNOWN. Verify each
   claim from the vendor's own documentation before writing an adapter.
4. **Provider validation**: probe Alpha Vantage, FRED, BEA and Marketaux once each with
   `/api/providers?probe=<id>`, then check `/api/macro`, `/api/bubbles`, `/api/news`; fix adapters if
   the live shape differs; record results under "Live check" in ENVIRONMENT.md.
5. **Production verification**: re-read `/api/calendar` after a release time to see a real `actual`
   and `surprise`; investigate the id/time anomaly (issue 2) and add a test that a time is never read
   from an id; decide whether XOOMAR gets a one-off probe.

**P2: Later**

6. **Cleanup**: delete `wip/free-calendar-fallback` with the owner's approval; commit a
   `package-lock.json` after a clean install; align Node (`engines` vs the Vercel setting); fix the
   "ten providers" wording; decide whether an UNAVAILABLE calendar needs a Retry button.
7. **Already-planned integrations** (documented, not started): an order-book depth provider and the
   ELVOID engine, with the suggested variable names in section 5.

---

## 15. Next chat starter

### COPY THIS INTO THE NEXT CLAUDE CHAT

```text
You are continuing development of ELSTAND INTELLIGENCE.

Read docs/CLAUDE_HANDOFF.md first.

Do not assume anything that is not verified in the repository.

Current priority:
1. Data licensing / data rights: ShowMyTrades (public relay), XOOMAR (no redistribution) and the
   Twelve Data plan are unconfirmed. Help the owner record decisions in docs/ENVIRONMENT.md; do not
   draw legal conclusions.
2. Surface VI real data: the event-proximity layer is real and calendar-driven; the FX implied-
   volatility surface has NO options-data adapter. Research options providers (verify every claim
   from the vendor's own documentation) before designing anything.
3. Provider validation: Alpha Vantage, FRED, BEA and Marketaux keys exist in Vercel but have never
   been verified by a real request. Probe each once with /api/providers?probe=<id>, then record
   what was observed.

Before modifying code:
1. inspect relevant files
2. verify current implementation
3. identify constraints
4. propose minimal architecture change
5. implement
6. run tests (npm run check)
7. verify production if applicable (Vercel integration, web_fetch_vercel_url)

Hard rules:
- no fake data
- null stays null
- do not expose secrets (names of variables only; never print or commit values)
- do not claim LIVE unless verified
- do not invent API capabilities
- preserve existing architecture unless change is justified
- never infer an event time from a provider id
- no force-push, no destructive git, no credentials in the remote URL; stage only your own files
- a security scan was never run (no HawkScan key): never claim one
```

Owner's standing working preferences, stated in earlier chats and **not verifiable from the
repository**: the owner writes in Indonesian and wants short Indonesian status updates during long
work and an Indonesian final report; commits end with the trailers
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the current
`Claude-Session: <session url>`; the free Claude plan applies (no scheduled tasks or browser control).

---

## 16. Handoff quality check (what this file is and is not)

- Every fact above was taken from the repository, `git`, the Vercel project, or a live read of the
  production alias on 2026-11-21. Test counts are from the run in section 10, not remembered.
- No secret is present. Environment variables appear by **name** only.
- Provider capabilities are only those the adapters and documents state. Where a capability or a term
  is not confirmed it says UNKNOWN / NOT VERIFIED.
- Production status is only what a request observed. **Configured is not connected.**
- Known limitations were not removed; section 11 lists them all, including ones that are not
  flattering (no lockfile, no security scan, a never-called fallback, an unexplained timestamp
  anomaly).
- This file will go stale. Re-run the commands in section 2 and re-read the Vercel project before
  trusting a hash, a deployment id or a variable list.
