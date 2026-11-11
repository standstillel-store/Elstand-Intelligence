# Environment

**Nothing here is required.** With no environment variable at all, the application builds, starts
and renders, and every panel that needs provider data shows the exact text **ENV NOT CONNECTION**,
followed by a sentence that names the missing variable. There is no sample data to fall back to, by
design (see [DATA-INTEGRITY.md](DATA-INTEGRITY.md)).

Every variable is read **only by the server** (`api/*`, `npm run dev`, `npm run preview`). None is
sent to the browser. `/api/status` and `/api/providers` report the _names_ of missing variables and
never a value. `.env.example` lists the same variables with every line commented out.

**A variable that exists is not a connection.** Five things can be true, one after the other, and
the product never reports a later one on the strength of an earlier one:

1. The deployment succeeded: the code is running. Nothing is known about any provider yet.
2. The variable is set: the provider page says **CONFIGURED — NOT VERIFIED**.
3. The provider accepted the credential: a real request was answered without a rejection.
4. Valid data was retrieved: the answer passed validation, and a screen can say LIVE, DELAYED,
   CACHED or CALCULATED.
5. The data is displayed: the module that uses it draws it, with its source and time.

Only a real request moves a provider past step 2, and the provider page says which step it has
reached (see [Verifying a provider](#first-connection-checklist)).

## Variables

| Name                             | Secret  | Default                          | What it does                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWELVE_DATA_API_KEY`            | **yes** | unset                            | Your Twelve Data API key. Unset or blank: the server reports `connected: false` and the whole interface shows ENV NOT CONNECTION.                                                                                                                                                                                                                                                       |
| `ELSTAND_FEED_REALTIME`          | no      | `false`                          | Declares whether your Twelve Data plan delivers real-time forex. **Only the value `true`** (any letter case, surrounding spaces ignored) declares the feed real-time: fresh data is then labelled LIVE and becomes STALE after 5 minutes. Any other value, or none, labels fresh data DELAYED, which becomes STALE after 30 minutes. The application never assumes a feed is real-time. |
| `ELSTAND_REFRESH_SECONDS`        | no      | `60`                             | Seconds between refreshes. It is both the server cache lifetime and the browser's polling interval. A plain whole number is clamped to **10 to 3600**. Anything else (blank, `abc`, `1.5`, `-5`, `1e2`) is a misconfiguration and falls back to 60.                                                                                                                                     |
| `TWELVE_DATA_CREDITS_PER_MINUTE` | no      | `8`                              | Elstand's own request budget for Twelve Data, per minute and per server instance, in credits (one request costs one). The default is the Basic plan. Set it to what **your** plan allows. A plain whole number, clamped to **1 to 10000**; anything else falls back to the default.                                                                                                     |
| `TWELVE_DATA_CREDITS_PER_DAY`    | no      | `800`                            | The same budget per day. A plain whole number, clamped to **1 to 10000000**; anything else falls back to the default.                                                                                                                                                                                                                                                                   |
| `ALPHA_VANTAGE_API_KEY`          | **yes** | unset                            | Alpha Vantage key. Enables the fallback for daily candles and spot quotes. Unset: the fallback is off and the rest is unaffected.                                                                                                                                                                                                                                                       |
| `FRED_API_KEY`                   | **yes** | unset                            | FRED key (32 lowercase letters and digits). Unset: policy rates and inflation indices are ENV NOT CONNECTED.                                                                                                                                                                                                                                                                            |
| `FINANCE_CALENDAR_API_KEY`       | **yes** | unset                            | Finance Calendar key, from a paid plan: the provider has no anonymous access. Unset: the economic calendar is ENV NOT CONNECTED and Surface VI event waves are disabled.                                                                                                                                                                                                                |
| `MARKETAUX_API_KEY`              | **yes** | unset                            | Marketaux key. Unset: financial news is ENV NOT CONNECTED.                                                                                                                                                                                                                                                                                                                              |
| `FRANKFURTER_API_BASE_URL`       | no      | `https://api.frankfurter.dev/v1` | Optional override of the Frankfurter address, for a copy you host yourself. Must be an https address with no credentials, query or fragment.                                                                                                                                                                                                                                            |
| `WORLD_BANK_API_BASE_URL`        | no      | `https://api.worldbank.org/v2`   | Optional override of the World Bank address. The same rule applies.                                                                                                                                                                                                                                                                                                                     |
| `IMF_API_BASE_URL`               | no      | unset                            | Reserved. No supported public IMF endpoint has been verified, so no IMF adapter exists and setting this changes nothing: the IMF stays UNAVAILABLE, and says so.                                                                                                                                                                                                                        |
| `BLS_API_KEY`                    | **yes** | unset                            | BLS registration key. **Optional**: without it the keyless version 1 of the API is used, with a much smaller daily allowance.                                                                                                                                                                                                                                                           |
| `BEA_API_KEY`                    | **yes** | unset                            | BEA key. Unset: U.S. GDP growth from the BEA is ENV NOT CONNECTED.                                                                                                                                                                                                                                                                                                                      |
| `ELSTAND_TTL_CALENDAR_SECONDS`   | no      | `900`                            | How long an economic-calendar answer is kept on the server before the provider is asked again. A plain whole number, clamped to **300 to 86400**; anything else falls back to the default.                                                                                                                                                                                              |
| `ELSTAND_TTL_NEWS_SECONDS`       | no      | `1800`                           | The same for financial news, clamped to **300 to 86400**. The Marketaux allowance is small, so this is the setting that protects it.                                                                                                                                                                                                                                                    |
| `ELSTAND_TTL_MACRO_SECONDS`      | no      | `21600`                          | The same for macro series (policy rates, inflation, labor, GDP), clamped to **900 to 604800**. These series change monthly or slower.                                                                                                                                                                                                                                                   |
| `ELSTAND_TTL_RATES_SECONDS`      | no      | `3600`                           | The same for the Frankfurter reference rates, clamped to **900 to 604800**. They are published once per working day.                                                                                                                                                                                                                                                                    |

Setting the same name in `.env.local` and in the real environment: the real environment wins.
`npm run dev` and `npm run preview` read `.env` and `.env.local`; both are git-ignored, as is every
`.env.*` file except `.env.example`.

A value that is set but is not one clean token (it holds a space, a quote or an angle bracket, which
is what an unfilled placeholder or a value pasted with its quotes looks like) is **not sent to any
provider**. The provider page says `ERROR — NAME is set but …`, and the value is never shown.

## Providers

The ten providers, in the order of the provider status page (`#/providers`, linked from the footer).
Each one supplies one capability and is asked only for what it can supply: a daily reference rate is
never offered as an intraday candle, and Alpha Vantage is never a blind fallback for real-time data.

| Provider                         | Variables                  | Credential | Capability                   | Adapter                     |
| -------------------------------- | -------------------------- | ---------- | ---------------------------- | --------------------------- |
| Twelve Data                      | `TWELVE_DATA_API_KEY`      | required   | Forex market data            | `server/twelvedata.ts`      |
| Alpha Vantage                    | `ALPHA_VANTAGE_API_KEY`    | required   | Forex market data            | `server/alphavantage.ts`    |
| FRED                             | `FRED_API_KEY`             | required   | Macro observations           | `server/fred.ts`            |
| Finance Calendar                 | `FINANCE_CALENDAR_API_KEY` | required   | Economic calendar            | `server/financecalendar.ts` |
| Marketaux                        | `MARKETAUX_API_KEY`        | required   | Financial news               | `server/marketaux.ts`       |
| Frankfurter                      | `FRANKFURTER_API_BASE_URL` | none       | Exchange-rate reference data | `server/frankfurter.ts`     |
| World Bank                       | `WORLD_BANK_API_BASE_URL`  | none       | Macro observations           | `server/worldbank.ts`       |
| IMF Data                         | `IMF_API_BASE_URL`         | none       | Macro observations           | none (no endpoint)          |
| U.S. Bureau of Labor Statistics  | `BLS_API_KEY`              | optional   | Macro observations           | `server/bls.ts`             |
| U.S. Bureau of Economic Analysis | `BEA_API_KEY`              | required   | Macro observations           | `server/bea.ts`             |

"Credential" says what the provider asks for. **required**: without the variable the provider is
not asked and its panels say ENV NOT CONNECTED. **optional**: it works without, under a smaller
allowance. **none**: no key exists; the variable, where there is one, is only an address override.

Common to every provider: its **required environment** is the server that answers `/api/*`. On
Vercel that is Production at least, and Preview if you open preview deployments. A change to a
variable takes effect only for a deployment made after the change (see
[Setting the variables on Vercel](#setting-the-variables-on-vercel)). The services that ask the
providers are `server/forex-service.ts` (quotes and candles), `server/macro-service.ts` (macro
series and the bubbles) and `server/feeds-service.ts` (calendar, news and reference rates), all
through the shared request path in `server/service.ts`.

### Twelve Data

- **Credential:** required (secret): `TWELVE_DATA_API_KEY`. Four related variables are not secrets: `ELSTAND_FEED_REALTIME`, `ELSTAND_REFRESH_SECONDS`, `TWELVE_DATA_CREDITS_PER_MINUTE` and `TWELVE_DATA_CREDITS_PER_DAY`.
- **Official source:** [Twelve Data documentation](https://twelvedata.com/docs) and [pricing](https://twelvedata.com/pricing).
- **Used by:** `server/twelvedata.ts` (the adapter) and `server/forex-service.ts`.
- **Capability:** Forex market data. It asks `quote` once per instrument and `time_series` for the chart that is open (M5 to D1). It is the only source of intraday candles.
- **Limits (verified):** Basic plan: 8 API credits per minute and 800 per day. What the feed delivers (real-time or delayed) depends on the plan, and the plan’s terms govern public display of the data.
- **How Elstand spends it:** one budget per server instance, 8 a minute and 800 a day unless you set the two budget variables. Quotes may use at most three quarters of it (6 a minute and 600 a day on the default plan) so that candles always keep a share. A refresh asks for up to eight quotes at once; on the Basic plan six are sent and the other two wait for the next refresh, **in a turn that moves on every refresh**, so no instrument is starved. A quote that was not sent shows the last verified answer, labelled CACHED, then STALE.
- **What that means in practice:** at the default 60-second refresh the day's quote budget (600 credits, at most six per refresh) lasts under two hours of an open page. On the Basic plan, raise `ELSTAND_REFRESH_SECONDS` (300 makes it last about eight hours), and on a larger plan set both budget variables to what the plan allows.
- **Verify:** `/api/status` says `connected: true` and never contains the key. `/api/quotes?ids=EURUSD,XAUUSD` returns positive prices with a recent `asOf`. `/api/providers?probe=twelvedata` makes one real request for EUR/USD and reports whether it was answered, accepted and valid.
- **When missing:** the whole terminal says ENV NOT CONNECTION. Wording: ENV NOT CONNECTED — TWELVE_DATA_API_KEY is missing. Forex quotes and candles from Twelve Data are unavailable.
- **When the key is rejected:** the provider answers HTTP 401. The terminal turns ENV NOT CONNECTION with the provider's refusal as the detail, and the server does not ask again for a minute.
- **When rate limited:** RATE LIMITED. If Elstand's own budget held the request back, the words say that nothing was sent; if the provider refused, they say it rejected the request. The last verified data stays on screen, labelled CACHED, then STALE.
- **Live check:** verified from the production deployment: authentication, and valid quotes and candles for EUR/USD and XAU/USD. Repeated on 2026-11-11 against the deployment of commit `1fd8290`: `/api/quotes?ids=EURUSD,XAUUSD` returned both quotes (DELAYED, fresh), and `/api/candles?id=EURUSD&tf=H1` returned hourly bars with whole-hour UTC open times. The plan's terms for public display of the data have not been confirmed (see [Licensing](#licensing)).

### Alpha Vantage

- **Credential:** required (secret): `ALPHA_VANTAGE_API_KEY`.
- **Official source:** [Alpha Vantage documentation](https://www.alphavantage.co/documentation/).
- **Used by:** `server/alphavantage.ts` (the adapter), called from `server/forex-service.ts`.
- **Capability:** Forex market data, **as a fallback only**: a spot quote (`CURRENCY_EXCHANGE_RATE`) and the daily candle series (`FX_DAILY`), for currency pairs. Never intraday candles, never gold, and never a claim of real-time.
- **Limits (verified):** Free key: 25 requests per day (official support page). Elstand also keeps to 5 per minute. Some forex endpoints are premium, so only the daily series and the spot rate are requested.
- **When it is used:** only when Twelve Data cannot answer: it refused, it could not be reached, it sent data that did not validate, or its daily allowance is spent. A spot quote is taken from it only when nothing Twelve Data answered earlier is left to show. It is **not** used when Twelve Data is simply not configured, and not after Twelve Data rejected its key: those need the operator, not a substitute. An answer from the fallback says so (`fallback` in its provenance, with the reason) and is never labelled LIVE.
- **Verify:** `/api/providers?probe=alphavantage` makes one real request for a spot rate. It spends one of the 25 daily requests, which is why it only ever runs when a person asks for it.
- **When missing:** ENV NOT CONNECTED — ALPHA_VANTAGE_API_KEY is missing. The Alpha Vantage fallback for daily candles and spot quotes is unavailable. Nothing else changes: Twelve Data is still the source.
- **When rate limited:** RATE LIMITED, with the last verified data and its time. With 25 requests a day the budget is spent quickly; it renews at the next UTC day.
- **Live check:** not live-tested. No key was available when this was written. Only the adapter's handling of the documented response shapes is tested, which does not prove the live integration.

### FRED

- **Credential:** required (secret): `FRED_API_KEY`. A FRED key is 32 lowercase letters and digits; any other shape is reported as invalid and is not sent.
- **Official source:** [FRED API documentation](https://fred.stlouisfed.org/docs/api/fred/).
- **Used by:** `server/fred.ts` (the adapter) and `server/macro-service.ts`. The series are listed in `server/macro-catalog.ts`.
- **Capability:** Macro observations: the Federal funds target range (upper limit), the ECB deposit facility rate, U.S. CPI and the euro-area HICP, through the `series/observations` endpoint. A series FRED no longer updates is not listed, and nothing fills the gap.
- **Limits (verified):** Free key. FRED rate-limits each key (a 429 is reported as RATE LIMITED); Elstand keeps to 60 requests per minute and reads each series at most every 6 hours.
- **Verify:** `/api/providers?probe=fred` reads one series and reports whether the key was accepted and the observations passed validation. `/api/macro?provider=fred` returns every FRED series with its source link and retrieval time.
- **When missing:** ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.
- **When rejected or invalid:** a key of the wrong shape is reported as ERROR and not sent; a key FRED refuses is reported as ERROR with FRED's own words.
- **Live check:** not live-tested. No key was available when this was written. Only the documented response shapes are tested.

### Finance Calendar

- **Credential:** required (secret): `FINANCE_CALENDAR_API_KEY`. The provider has no anonymous access: the key belongs to a paid plan.
- **Official source:** [Finance Calendar API reference](https://www.financecalendar.com/api/reference/) and [service terms](https://www.financecalendar.com/?p=3216).
- **Used by:** `server/financecalendar.ts` (the adapter) and `server/feeds-service.ts`.
- **Capability:** Economic calendar. Impact is the source's own rating; Elstand assigns none. An event the source gave no rating is shown as UNCLASSIFIED (NOT RATED in Surface VI).
- **Limits (verified):** No anonymous access: every request needs the API key of a paid plan, and a request without one is refused with HTTP 401. The Starter plan allows 1,000 requests per day and 25,000 per month. Use requires a visible link to financecalendar.com wherever the data is shown, and the credits, licenses and notices supplied with each event.
- **How Elstand spends it:** 10 a minute and 750 a day, which is 22,500 over a 30-day month against the Starter plan's 25,000. The calendar is kept for 15 minutes (`ELSTAND_TTL_CALENDAR_SECONDS`). A larger plan allows more; the budget does not change by itself.
- **Credits, licenses and notices:** the terms ask for the publisher links, source licenses, credits and reuse notices supplied with records to be kept. The adapter keeps `source_url`, and from `source_license` and `source_rights` the credit, its link, the license, its link and the notice, in the provider's own words (`source.rights`). The calendar list and the Surface VI details show them with the event. Nothing is composed, and an event without them shows none.
- **Verify:** `/api/calendar` returns events with their source and retrieval time. `/api/providers?probe=financecalendar` makes one real request. The data screens show the required link to the source.
- **When missing:** ENV NOT CONNECTED — FINANCE_CALENDAR_API_KEY is missing. Economic calendar events from Finance Calendar are unavailable. Surface VI then says, word for word: ENV NOT CONNECTED — Economic calendar provider unavailable. Surface VI event waves are disabled. Nothing is requested and nothing is drawn.
- **When rejected:** ERROR with the provider's refusal: HTTP 401 for a missing or invalid key, 403 for a revoked key or a disallowed account, and HTTP 402 when the account needs payment to activate or renew access. A refused key is not retried.
- **Live check:** **not live-tested with a key**: none was available. What was observed on the production deployment (2026-11-10, 23:28 UTC): the first version of this adapter sent the request **without** a key, on the strength of an earlier reading of the provider's documentation, and the provider refused it with HTTP 401. That is why the key is now required. The documented response fields, including `source_license` and `source_rights`, are tested with stand-ins only, which does not prove the live integration.

### Marketaux

- **Credential:** required (secret): `MARKETAUX_API_KEY`.
- **Official source:** [Marketaux documentation](https://www.marketaux.com/documentation).
- **Used by:** `server/marketaux.ts` (the adapter) and `server/feeds-service.ts`.
- **Capability:** Financial news headlines, each with its source, time and link. Elstand writes no headline and no summary of its own.
- **Limits (verified):** Free plan: 100 requests per day and at most 3 articles per request. Elstand asks at most once per cache lifetime (30 minutes by default).
- **Verify:** `/api/providers?probe=marketaux` makes one real request. It spends one of the 100 daily requests, so it only runs when a person asks. `/api/news` returns the items with their source and time.
- **When missing:** ENV NOT CONNECTED — MARKETAUX_API_KEY is missing. Financial news from Marketaux is unavailable.
- **When rate limited or over quota:** RATE LIMITED, with the last verified headlines and their time when there are any.
- **Live check:** not live-tested. No key was available when this was written. Only the documented response shapes are tested.

### Frankfurter

- **Credential:** none. `FRANKFURTER_API_BASE_URL` is an optional address override.
- **Official source:** [frankfurter.dev](https://frankfurter.dev).
- **Used by:** `server/frankfurter.ts` (the adapter) and `server/feeds-service.ts`.
- **Capability:** Exchange-rate reference data: the daily ECB reference rates, quoted per U.S. dollar for the currencies of the watchlist. It is reference data only: never a quote, never a candle.
- **Limits (verified):** No key and no documented rate limit. Elstand keeps to 30 requests per minute. Rates are published once per ECB working day.
- **Verify:** `/api/rates` returns the rates with their reference date. `/api/providers?probe=frankfurter` makes one real request.
- **When missing:** nothing is missing. If the request fails, the reference-rate panel says ERROR with the reason; an override that is not a valid https address is reported as ERROR and not used.
- **Live check:** verified on the production deployment of commit `1fd8290` on 2026-11-10 and 2026-11-11: `/api/rates` returned the ECB reference rates for AUD, CAD, CHF, EUR, GBP, JPY and NZD per U.S. dollar, dated 2026-11-10, state DELAYED, and `/api/providers?probe=frankfurter` reported that Frankfurter answered and its data passed validation (no credential is involved). A value was not compared against the provider's own site.

### World Bank

- **Credential:** none. `WORLD_BANK_API_BASE_URL` is an optional address override.
- **Official source:** [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation).
- **Used by:** `server/worldbank.ts` (the adapter) and `server/macro-service.ts`.
- **Capability:** Macro observations: annual GDP growth and consumer-price inflation for eight economies, the two latest non-empty values each. Historical context, not a current reading.
- **Limits (verified):** No key and no documented rate limit. Elstand keeps to 30 requests per minute. Values are annual and arrive well after the year they describe.
- **Verify:** `/api/macro?provider=worldbank` returns the observations with their source link. `/api/providers?probe=worldbank` makes one real request.
- **When missing:** nothing is missing. If the request fails, the series say ERROR with the reason.
- **Live check:** verified on the production deployment of commit `1fd8290` on 2026-11-10 and 2026-11-11: `/api/macro?provider=worldbank` returned GDP growth and consumer-price inflation for eight economies, two annual values each, and `/api/providers?probe=worldbank` reported that the World Bank answered and its data passed validation (no credential is involved). The answer was labelled STALE as a whole because the newest United States inflation value the World Bank had was for 2024, more than 800 days old; the other series were DELAYED with 2025 values. Values were not compared against the provider's own site.

### IMF Data

- **Credential:** none. `IMF_API_BASE_URL` is reserved and changes nothing.
- **Official source:** [IMF Data](https://data.imf.org).
- **Used by:** nothing. No adapter exists, because no supported public IMF endpoint has been verified.
- **Capability:** Macro observations, **not available**. The IMF does not serve its data through one uniform API, and Elstand does not guess at one.
- **Limits (verified):** Not applicable: no IMF endpoint is used.
- **Verify:** the provider page shows UNAVAILABLE, and its check button says there is no endpoint to check.
- **When missing:** it is never "missing". The words are always UNAVAILABLE — No supported public endpoint is configured for this dataset.
- **Live check:** nothing to test. When an IMF endpoint is verified and an adapter is written, this section changes with it.

### U.S. Bureau of Labor Statistics

- **Credential:** optional (secret): `BLS_API_KEY`. With it the version 2 endpoint is used; without it, the keyless version 1.
- **Official source:** [BLS Public Data API](https://www.bls.gov/developers/).
- **Used by:** `server/bls.ts` (the adapter) and `server/macro-service.ts`.
- **Capability:** Macro observations: the unemployment rate, total nonfarm payrolls and the CPI for all urban consumers, through `timeseries/data`. BLS gives no publication dates, so none is shown.
- **Limits (verified):** Without a key (version 1): 25 queries per day. With a free registration key (version 2): 500 queries per day. Both allow 50 requests per 10 seconds.
- **How Elstand spends it:** keyless, 5 a minute and 20 a day; with a key, 20 a minute and 400 a day. The three series are one request, kept for 6 hours (`ELSTAND_TTL_MACRO_SECONDS`).
- **Verify:** `/api/macro?provider=bls` returns the observations. `/api/providers?probe=bls` makes one real request.
- **When missing:** nothing is missing: the key is optional. If the request fails or the daily query allowance is spent, the series say ERROR or RATE LIMITED with the last verified data and its time.
- **Live check:** verified **without a key** (version 1) on the production deployment of commit `1fd8290` on 2026-11-10 and 2026-11-11: `/api/macro?provider=bls` returned the unemployment rate, total nonfarm payrolls and the CPI through October 2026, state DELAYED, and `/api/providers?probe=bls` reported that the BLS answered and its data passed validation. A month BLS did not publish (October 2025 in the unemployment and CPI series) is absent, not filled in. The version 2 endpoint, used with a key, has not been tried. Values were not compared against the provider's own site.

### U.S. Bureau of Economic Analysis

- **Credential:** required (secret): `BEA_API_KEY`.
- **Official source:** [BEA API](https://apps.bea.gov/API/signup/).
- **Used by:** `server/bea.ts` (the adapter) and `server/macro-service.ts`.
- **Capability:** Macro observations: real U.S. GDP growth (percent change from the preceding quarter, annual rate), from the NIPA dataset, table T10101.
- **Limits (verified):** Free key: 100 requests per minute, 100 MB per minute and 30 errors per minute.
- **Verify:** `/api/macro?provider=bea` returns the observation. `/api/providers?probe=bea` makes one real request.
- **When missing:** ENV NOT CONNECTED — BEA_API_KEY is missing. U.S. GDP observations from the BEA are unavailable.
- **When rejected:** ERROR with the provider's refusal. The BEA reports some failures inside an HTTP 200 answer; the adapter reads those too.
- **Live check:** not live-tested. No key was available when this was written. Only the documented response shapes are tested, which does not prove the live integration.

## What the interface shows in each situation

| Situation                                                                                                                        | What the server answers                                                   | What you see                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `TWELVE_DATA_API_KEY`                                                                                                         | `/api/status`: `{"connected": false, "missing": ["TWELVE_DATA_API_KEY"]}` | **ENV NOT CONNECTION** in the header and every market-data panel. Detail: "Server environment variable TWELVE_DATA_API_KEY is not set."                                                                                                                                  |
| The server API is not there at all (a static host without functions, so `/api/status` answers 404 or something that is not JSON) | none                                                                      | **ENV NOT CONNECTION**. Detail: "The Elstand server API is not available at /api/status." A non-JSON server failure (for example an HTML 5xx page from a proxy) reads the same way, because from the browser the two cannot be told apart.                               |
| Key set, but the provider refuses it (HTTP 401)                                                                                  | `/api/quotes` or `/api/candles`: 502 `provider_auth`                      | The application turns **ENV NOT CONNECTION** with the provider's refusal as the detail. `/api/status` cannot know this in advance, so the first data request is what reveals it. The server remembers the rejection for 60 seconds instead of asking the provider again. |
| Provider request limit reached                                                                                                   | 429 `rate_limited`, with `Retry-After` when the provider sends one        | The affected panel shows RATE LIMITED and a Retry button. The connection stays up. The server remembers the limit for 15 seconds instead of asking again.                                                                                                                |
| Provider unreachable, or it returned data that failed validation                                                                 | 504 `provider_unreachable`, or 502 `provider_error`                       | The affected panel shows the failure and a Retry button. Nothing is repaired or filled in.                                                                                                                                                                               |
| `/api/status` itself fails (a JSON error, a network failure, a malformed status body)                                            | varies                                                                    | **SERVER ERROR** with a Retry button. This is deliberately different from ENV NOT CONNECTION: the environment may be fine, the server is not answering properly.                                                                                                         |
| Another keyed provider (FRED, Marketaux, BEA, Alpha Vantage, Finance Calendar) has no key                                        | HTTP 200 with `provenance.state` `ENV NOT CONNECTED` and no data          | Only that provider's panels say ENV NOT CONNECTION, and the sentence names the variable, for example: ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable. The rest of the terminal is unaffected.                                 |
| A provider that was answered earlier cannot be asked now (limit, outage)                                                         | HTTP 200 with the last verified answer and `cache` `stale-if-error`       | CACHED with the time of the last verified retrieval, then STALE once that answer is older than its freshness window. The words say which.                                                                                                                                |
| A dataset with no supported endpoint (the IMF)                                                                                   | HTTP 200 with `provenance.state` `UNAVAILABLE` and no data                | UNAVAILABLE — No supported public endpoint is configured for this dataset.                                                                                                                                                                                               |

The capability endpoints (`/api/calendar`, `/api/news`, `/api/macro`, `/api/bubbles`, `/api/rates`
and `/api/providers`) answer HTTP 200 whatever the provider did, with a `provenance` that says what
the answer is. "No credential", "rate limited" and "the provider failed" are states of the product
that the browser shows in words, not faults of the request. Only a request that cannot be understood
(400), the wrong method (405) or a defect in this server (500) is an HTTP error.

## Request budgets and caching

Every provider plan meters requests, so a result is reused for as long as the data can be trusted
not to have changed in a way that matters. Each kind of data has its own cache entries, so a slow
macro series is never asked for at the pace of an intraday chart. A result is first served from the
server's copy; when that has expired, one request is made (a retryable failure such as a timeout or
a 5xx is retried once, never a rejected credential or a rate limit); and when the provider cannot be
asked, the last verified answer is served, labelled CACHED, then STALE.

| Data               | Lifetime on the server                                  | Shown after a failure, for up to | Called CACHED, then STALE, after |
| ------------------ | ------------------------------------------------------- | -------------------------------- | -------------------------------- |
| `quote`            | `ELSTAND_REFRESH_SECONDS` (60 by default)               | 30 minutes                       | 30 minutes                       |
| `candles-intraday` | `ELSTAND_REFRESH_SECONDS` (60 by default)               | 30 minutes                       | 30 minutes                       |
| `candles-daily`    | the larger of `ELSTAND_REFRESH_SECONDS` and 900 seconds | 6 hours                          | 6 hours                          |
| `calendar`         | 900 seconds (`ELSTAND_TTL_CALENDAR_SECONDS`)            | 1 day                            | 2 hours                          |
| `news`             | 1800 seconds (`ELSTAND_TTL_NEWS_SECONDS`)               | 1 day                            | 6 hours                          |
| `macro-series`     | 21600 seconds (`ELSTAND_TTL_MACRO_SECONDS`)             | 7 days                           | 1 day                            |
| `reference-rates`  | 3600 seconds (`ELSTAND_TTL_RATES_SECONDS`)              | 3 days                           | 1 day                            |

The lifetime is also the `s-maxage` of the response, so a CDN shares one answer between visitors and
between server instances. Request budgets and caches are kept **per server instance**: several
instances multiply the requests a provider sees, and the CDN is what keeps that down. An answer
served from the last verified copy after a failure, or one that is STALE, is shared for only 30
seconds so that recovery shows quickly, and an answer with no data is not shared at all.

A request that would exceed a provider's budget is **not sent**. The words then say that Elstand's
own request budget for the provider is spent and nothing was sent; they never say the provider
rejected something it was not asked. Budgets are set below the published limits (see each
provider's limits above).

## Setting the variables on Vercel

No access to your Vercel account is needed from this repository, and no secret is ever typed into a
chat or committed. In the Vercel dashboard:

1. Open your Elstand project, then **Settings → Environment Variables**.
2. Add each variable by name. Put secrets (the keys) under **Production**, and under **Preview** if
   you open preview deployments. Mark each key **Sensitive** where Vercel offers it, so its value
   can no longer be read back.
3. Never expose a key to the browser, for example through a build-time public variable. These
   variables are read by the server functions only, and the build fails if a secret value reaches
   the bundle.
4. **Redeploy.** A deployment sees the variables as they were when it was made, so a new variable
   takes effect only on the next deployment.
5. Open `/api/providers` (or the provider page) on the new deployment and check each provider you
   configured, as described below. Do not set `ELSTAND_FEED_REALTIME` to `true` until you know your
   plan is real-time.

## Licensing

Reading a provider's data is not the same as being allowed to show it. This is the operator's
responsibility, and the application cannot check it.

- Twelve Data's individual plans are for personal or internal use. Showing the data to the public
  (a public Elstand deployment) needs a business plan or a redistribution agreement. Confirm this
  with Twelve Data for the plan you hold before you deploy publicly.
- Each request consumes credits under your plan, and plans have per-minute and per-day limits.
  The arithmetic is under [Twelve Data](#twelve-data); a larger plan changes it. Serverless
  instances each keep their own budget and cache, so several instances multiply the requests. The
  `Cache-Control` headers let a CDN share answers across them.
- `ELSTAND_FEED_REALTIME=true` is your statement that the plan delivers real-time forex. If it does
  not, the interface would call delayed data LIVE. Do not set it on a guess.
- Finance Calendar has no anonymous access: its API needs the key of a paid plan. Its terms ask for
  a visible link to its site wherever its data is shown, and for the publisher links, source
  licenses, credits and reuse notices supplied with each record to be kept; the calendar screens
  carry the link and show what each event supplied. They allow use in your own tools, apps and
  products within the plan's allowances, and caching on your own servers. Read them for the plan you
  hold. Every other provider has its own terms on commercial use, redistribution, caching and
  attribution. They have not been reviewed on your behalf: confirm them for your use before a
  public deployment.

## First-connection checklist

Connect one provider at a time, and stop at the first check that does not match. For every
provider:

1. Set its variable on the server and restart or redeploy. Leave `ELSTAND_FEED_REALTIME` unset
   until step 6 below.
2. Open `/api/providers`. The provider should say `config: "ready"`, and no value appears anywhere
   in the response. That is "configured", and nothing more.
3. Open the provider status page (`#/providers`) and press **Check connection** for that provider,
   or open `/api/providers?probe=<id>` (the ids are `twelvedata`, `alphavantage`, `fred`,
   `financecalendar`, `marketaux`, `frankfurter`, `worldbank`, `bls` and `bea`). One real request is
   made, and the answer says whether the provider answered, whether it accepted the credential, and
   whether the data passed validation. A check answers from the server's copy when it is still
   fresh, so it spends nothing extra then.
4. Open the data endpoint of that provider (listed in its section) and compare a value with the
   provider's own site: a quote with the provider's dashboard, a calendar event with its page, a
   series with its source link.
5. Open the module that shows the data. It must draw the data with its source and time, or say in
   words why it cannot.
6. Twelve Data only: `/api/status` shows `connected: true` and `source.mode` `delayed`;
   `/api/candles?id=EURUSD&tf=H1` returns bars as `[openTimeMs, open, high, low, close]`, ascending,
   and **the open times are UTC** (the adapter requests `timezone=UTC`, so a whole-hour offset means
   the provider did not honor it: stop and report it). If your plan is real-time, set
   `ELSTAND_FEED_REALTIME=true` and confirm the header shows LIVE on a quote that is moving.
7. Confirm in the browser's developer tools that the page talks to its own origin only and that no
   response or script contains a key.

## Planned variables (not read by this build)

Order-book depth, FX options and the ELVOID engine have no adapter. When one is built, these are the
variables it should take. The names are suggestions, they appear nowhere in the code today, and a
test fails if one of them is read before it is documented here as a real variable.

| Integration                     | Suggested variables                            | Notes                                                                                              |
| ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Order-book depth                | `ELSTAND_DEPTH_API_KEY`, `ELSTAND_DEPTH_VENUE` | A book is only meaningful from a named venue, so the venue name is configuration, not a guess.     |
| FX options (volatility surface) | `ELSTAND_OPTIONS_API_KEY`                      | Needs a stated delta-to-strike convention, which belongs in the adapter, not the environment.      |
| ELVOID engine                   | `ELVOID_ENGINE_URL`, `ELVOID_ENGINE_API_KEY`   | A credential means the engine runs on the server. See [ELVOID.md](ELVOID.md#connecting-an-engine). |

Whatever is added follows the rules of the current variables: server-only, optional, and a clear
ENV NOT CONNECTION when missing.
