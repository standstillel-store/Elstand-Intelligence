# Data integrity

Elstand Intelligence is a place where people look at numbers and make decisions. The principle
this project is built on is that **the numbers are real, or they are not there**. This document
says what that means in code, where each rule lives and which tests hold it in place.

## Principles

1. **Real data or ENV NOT CONNECTION.** There is no simulated, sample, mock, seeded, random or
   placeholder source anywhere in the product. When nothing is connected the interface says
   exactly **ENV NOT CONNECTION** (`src/core/connection-text.ts` holds the one copy of the text),
   and a sentence beside it names the variable that is missing. Test fixtures exist, but only
   under `tests/`, and the build refuses to bundle them (see [TESTING.md](TESTING.md)).
2. **Provider output is untrusted.** It is validated on the server before it is returned, and
   validated again in the browser before it reaches a panel. A misconfigured proxy or a static host
   that answers `/api/status` with an HTML page is treated as untrusted exactly like a vendor.
3. **Nothing is repaired.** A price that fails a check is an error or an UNAVAILABLE state. It is
   never clamped, rounded into range, interpolated, back-filled or replaced by the previous value,
   because a repaired price is a made-up price.
4. **The source declares what it is.** Whether data is `live` or `delayed` is declared by the
   operator (`ELSTAND_FEED_REALTIME`). The interface never infers "live" from numbers that look
   plausible.
5. **Every datum has a time and a state.** A number without an observation time and one of the
   states below is not shown as current.
6. **Attribution travels with the value.** Macro values, news and calendar items carry their source,
   observation or retrieval time and, for impact, who assigned it. An item without them is rejected.
7. **Absence is stated, with the reason.** A missing book, surface or analysis says it is missing and
   why. An empty panel is a defect.
8. **A connection is what a request proved.** A variable that exists makes a provider "configured",
   never "connected". Only a request that was answered and validated makes data LIVE, DELAYED,
   CACHED or CALCULATED, and the provider page says which step a provider has reached.
9. **A substitute says it is one.** A fallback is allowed only for data of the same kind, states
   that it is a fallback and why, and is never used to cover a missing or rejected credential. A
   daily reference rate is never shown as an intraday candle.
10. **A derived value names its inputs.** It is CALCULATED, only from real, attributed, validated
    inputs, and where an input is missing the value is not drawn and the page says which.

## Data states

`DataState` is the vocabulary the market-data screens use for freshness (`src/core/types.ts`,
`src/core/freshness.ts`). The labels are fixed.

| State       | Meaning                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| LIVE        | Real data from the provider, whose feed the operator declared real-time, and recent enough.                              |
| DELAYED     | Real data from the provider. The feed is not declared real-time, so it may lag the market. This is the default.          |
| STALE       | Real data that has not updated recently. The market may be closed. It is not current and must not be treated as current. |
| UNAVAILABLE | There is no datum from the configured source.                                                                            |

How a state is decided (`classifyFreshness`):

- No datum, or a timestamp that is not a finite number: **UNAVAILABLE**.
- Otherwise the source's declared mode (`live` or `delayed`), unless the datum's age exceeds the
  mode's tolerance, which makes it **STALE**. The tolerance is declared by the server per mode:
  **5 minutes for live, 30 minutes for delayed** (`STALE_AFTER_MS` in `server/env.ts`). A closed
  market therefore reads STALE, which is accurate: the number is real and not current.
- A timestamp slightly in the future (clock skew) counts as age zero.
- A candle series (`classifySeriesFreshness`) is judged by the **open time of its newest bar**, and
  the tolerance is widened by one bar length, because a bar is open for its whole length and the
  newest bar of a perfectly current series can be nearly one bar old.
- When a conclusion rests on more than one datum (a quote and a candle series), the state is the
  least trustworthy of them (`worstState`).
- Only LIVE and DELAYED data may feed an analysis (`isAnalysisEligible`). STALE and UNAVAILABLE data
  hold an analysis back, and the ELVOID workspace says so.
- The volatility surface has its own tolerance, because option quotes move more slowly than spot:
  10 minutes for live and 60 minutes for delayed (`SURFACE_STALE_AFTER_MS` in `src/data/options.ts`).
  This is the interface's own policy, not a statement by any vendor.

Freshness is recomputed from the clock every second, so a panel that was LIVE turns STALE on its
own while you watch it, without a request.

## Provider states

The provider layer (`src/core/provider-state.ts`) says more than freshness: it also says why there
is nothing to show. `DataState` maps onto it one to one (`providerStateOf`), and nothing already
built changes meaning.

| State             | Meaning                                                                                            | Where it comes from                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| LIVE              | The provider answered and the feed is declared real-time.                                          | Twelve Data only, and only when `ELSTAND_FEED_REALTIME` says so. No other provider is ever LIVE.                       |
| DELAYED           | The provider answered; the feed is not declared real-time.                                         | The default for every answer that is recent enough.                                                                    |
| CACHED            | The provider could not be asked, so this is its last verified answer, kept on the server.          | An answer served after a failure, inside its freshness window. The words give the time it was retrieved.               |
| STALE             | The newest datum, or the retrieval, is older than its documented window. Not current.              | The same answer once it is older than the window (see the table in [ENVIRONMENT.md](ENVIRONMENT.md)).                  |
| UNAVAILABLE       | No datum exists, or no supported source exists for this dataset.                                   | A dataset with no verified endpoint (the IMF), or a module none of whose inputs could be retrieved.                    |
| ENV NOT CONNECTED | A server environment variable this source needs is not set.                                        | A keyed provider with no key. The sentence names the variable and what is lost.                                        |
| RATE LIMITED      | The provider, or the request budget Elstand keeps for it, allows no more requests now.             | A refusal (HTTP 429, a spent quota) or Elstand's own budget. The words say which: nothing was sent in the second case. |
| ERROR             | The provider rejected the credential, failed, was unreachable, or sent data that did not validate. | Any other failure, with the provider's own words, scrubbed of control characters and any credential.                   |
| CALCULATED        | Derived by Elstand from real, attributed inputs, which are named.                                  | The macro bubbles, a year-on-year change, an event surprise. See [Derived values](#derived-values).                    |

The established label of the interface stays **ENV NOT CONNECTION** wherever no source is connected
(`ENV_NOT_CONNECTED` in `src/core/connection-text.ts`). The provider layer writes the canonical
sentence beside it, so a screen reads, for example, the label and then the detail. These are the
sentences, with `<time>` where the server writes a timestamp in UTC:

- `ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.`
- `UNAVAILABLE — No supported public endpoint is configured for this dataset.`
- `RATE LIMITED — Alpha Vantage rejected the request. Last verified data: <time>.`
- `RATE LIMITED — The request budget kept for Twelve Data is spent, so this request was not sent. Last verified data: <time>.`
- `STALE — Last successful retrieval: <time>. Current data could not be verified.`

The "Last verified data" part is left out when there is none, because there is none to show.

## Provenance

Every answer from the capability endpoints, and every quote and candle series, carries a provenance
(`src/data/provenance.ts`, parsed again in the browser):

- the **provider** (id and name), the **capability** and the **endpoint** it was asked;
- the **state**, and the **words** that explain a state that is not good news;
- **`retrievedAt`**: when Elstand last had the answer from the provider (not when the browser
  asked), and **`dataAsOf`**: the time of the newest datum at the source;
- **`cache`**: `fresh`, `cache` (served from the server's copy while still valid) or
  `stale-if-error` (the last verified answer, served because the provider could not be asked);
- **`fallback`**: `null`, or which provider it substitutes for and why.

Times shown to a person from a provider are in UTC and say so. The countdown on Surface VI runs on
the device's clock and says so; see [EVENT-WAVES.md](EVENT-WAVES.md).

The provider status page (`#/providers`) is built from these. For each provider and each
capability and endpoint it shows the provider, the capability, the state, the last successful
retrieval, the last attempt, the time of the data, whether the answer came from the cache, and the
variable that is missing. It shows no credential and no raw error body. **Check connection** makes
one real request, applies only to the capability and endpoint it asked, and answers from the
server's copy when that is still fresh, so it spends nothing extra then.

## Fallback

A fallback exists to cover an outage of the same kind of data, and nothing else
(`mayFallBack` in `server/forex-service.ts`):

- Alpha Vantage may stand in for Twelve Data for **the daily candle series** and for **a spot quote
  of a currency pair**, and only when Twelve Data cannot answer: it refused, could not be reached,
  sent data that did not validate, or its daily allowance is spent.
- A spot quote is taken from it only when nothing Twelve Data answered earlier is left to show.
- It is **never** asked for intraday candles, never for gold, never when Twelve Data is merely not
  configured, never after Twelve Data rejected its credential, and never for a per-minute hold-back
  by Elstand's own budget (the next minute asks again).
- Its answer says it is a fallback, from whom and why, and is never LIVE.
- Frankfurter's daily reference rates are reference data. They are never offered as a quote or a
  candle, in any state.

## What is checked, and where

**Twelve Data adapter** (`server/twelvedata.ts`). Vendor numbers arrive as strings and are parsed
strictly: only a plain decimal (`^[+-]?\d+(\.\d+)?$`) is accepted. A missing or malformed field is
an error, not a default. Timestamps must fall between 2000-01-01 and one day ahead of now, which also
catches milliseconds mistaken for seconds. A calendar overflow such as 31 February is rejected. The
symbol and interval the vendor echoes back must match the request. The quote's change is computed
here from two vendor prices (`close` and `previous_close`) instead of trusting the vendor's own
percent field, whose units are not worth guessing. `last_quote_at` is preferred over `timestamp`,
because the fallback can only make a quote look older, never fresher. The vendor's error envelope is
honored whether or not the HTTP status agrees. Text from the provider that is shown to a person has
control characters removed and any echo of the key redacted. The key travels in the `Authorization`
header, never in the URL, and redirects are refused so the header cannot be forwarded elsewhere.

**Every other adapter** (`server/alphavantage.ts`, `fred.ts`, `financecalendar.ts`, `marketaux.ts`,
`frankfurter.ts`, `worldbank.ts`, `bls.ts`, `bea.ts`) goes through one HTTP helper
(`server/provider-http.ts`): https only, to the host of the configured address, with no credential in
the address; redirects refused, so a credential cannot be forwarded to another host; a timeout and a
size cap on every request; no URL in any message, because a URL can carry a credential; and any
credential removed from every provider text. Each adapter then reads the response strictly, as its
provider documents it: numbers as numbers (a missing value marker such as `.` is an absent
observation, never a zero), times as real instants, and anything else rejected rather than
defaulted. A provider's own error envelope is recognized (several providers send a refusal with an
HTTP 200 status), so a refusal is never read as data.

**Quotes** (`validateQuote` in `src/data/validate.ts`). `last` positive and finite. Timestamp finite.
Bid and ask both present or both absent, positive, and `bid <= ask`. Change figures finite or null.

**Candles** (`validateCandles`). Finite time. Open, high, low and close positive and finite.
`high >= max(open, close)`, `low <= min(open, close)`, `high >= low`. Times strictly ascending, no
duplicates. The service additionally rejects a series for the wrong instrument or timeframe.

**Depth** (`validateDepthSnapshot` in `src/data/depth.ts`). The book names its venue, carries an
observation time and states its size unit. Both sides are non-empty, with positive finite prices and
sizes, strictly ordered best first, and not crossed. The book must be for the instrument asked
about. Anything else becomes UNAVAILABLE with the first problem as its reason.

**Volatility surface** (`validateVolSurfaceFor` in `src/data/options.ts`). At least two points on
each axis. Strikes finite and strictly ascending. Expiries positive and strictly ascending. The
matrix matches both axes, with positive finite implied volatilities. The surface is for the
instrument selected, never for another one drawn under it. The strike axis states its kind
(`log-moneyness`, `strike-over-forward` or `delta`) so a plotted number is never ambiguous.

**Macro observations** (`src/data/observations.ts`, `src/data/http-macro.ts`). A series names its
unit, its frequency, whether it is seasonally adjusted, how it is revised and where it came from. An
observation has a real date and a finite value; the browser validates the series again and rejects
what it cannot trust.

**Macro bubbles** (`validateBubblePoints` in `src/data/macro-bubbles.ts`). An ISO 4217 code, once.
Each of the three values (policy rate, CPI, one-month price change) a finite number with an
observation time and a named source. The price change states its basis. See
[MACRO-BUBBLES.md](MACRO-BUBBLES.md).

**News and calendar** (`screenCalendar`, `screenNews` in `src/data/macro-validate.ts`). Every item
has a unique id, a valid time, an ISO currency (calendar) or valid currency list (news), a title or
headline, a named source and a retrieval time. An impact level is one of low, medium or high **and**
names who assigned it (for the calendar, the source's own rating), or the item is shown as
UNCLASSIFIED. Elstand rates nothing itself. Rejected items are listed with the reason, not dropped
silently. With no ELVOID engine configured, any interpretation attached to an item is removed and
the page says how many were.

**Event waves** (`src/core/event-waves.ts`). Only events the provider supplied, screened the same
way as the lists. See [EVENT-WAVES.md](EVENT-WAVES.md).

**ELVOID results** (`validateAnalysisResult`). See [ELVOID.md](ELVOID.md).

## Derived values

A derived value is CALCULATED and is shown with its inputs and their sources. It exists only when
every input exists and passed validation; where one is missing, the value is not drawn and the page
says which input and why. Nothing is estimated to fill a gap.

- **Year-on-year inflation**: the newest monthly index against the observation twelve months
  earlier. Without that observation: "the provider did not supply it. Elstand does not estimate it."
- **One-month price change**: two daily closes about 30 days apart, close to close, with the basis
  stated (the pair, the days and the dates). A base bar further back than 37 days is not "one month
  ago", and the change is not drawn.
- **Event surprise**: the actual figure minus the consensus, both as the calendar supplied them, and
  only when both are numbers. Otherwise there is no surprise.
- **The macro bubbles** are built from those, for the currencies that have a current policy-rate and
  consumer-price series. A currency without them is listed as omitted, with the reason.

## ENV NOT CONNECTION versus SERVER ERROR

These two are different statements and the interface keeps them apart.

- **ENV NOT CONNECTION** means no real data source is connected: the server has no credentials, the
  provider rejected them, or the server API is not present at all. The fix is configuration.
- **SERVER ERROR** means the server was asked and did not answer properly: the status request
  failed, the network dropped, or the status body was malformed. The fix may be nothing, and it
  has a Retry button.
- A failure of one request to a connected provider (a rate limit, an invalid answer) is neither. It
  is shown on the panel it affected, with Retry, and the connection stays.
- A provider other than Twelve Data that has no key does not disconnect the terminal. Only its own
  panels say ENV NOT CONNECTION, with the variable named.

The full matrix, with the HTTP statuses, is in [ENVIRONMENT.md](ENVIRONMENT.md#what-the-interface-shows-in-each-situation).
The classification lives in one place (`src/app/connection.ts`) so that no component decides it for
itself.

## Depth is a venue's book, never the market's

Spot FX and spot gold are traded over the counter across many dealers and venues. No consolidated
order book exists, so none is drawn. A depth snapshot must name its venue, and the panel shows the
venue, the observation time and the size unit next to the numbers. Bid and ask are drawn as separate
sides, each scaled against the same total so the two can be compared. Sizes are shown with the
fewest decimals that keep every size intact, and never more than four (the panel does not invent
precision). At most ten levels per side are drawn, and the panel says how many it cut. Exchange gold futures are a different instrument with their own expiry and book,
and are never shown as XAU/USD spot.

No provider has a depth adapter in this build, so depth is always UNAVAILABLE with a stated
reason (`DEPTH_UNAVAILABLE_REASON` in `server/handlers.ts`, plus the instrument's own `depthNote`).

## What enforces this

| Rule                                                                                          | Held by                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No fabricated data in product code (mock, fake, dummy, stub, sample, demo, simulated, random) | `npm run lint:policy`, rules `no-placeholder-data` and `no-randomness`                                                                                                                                                                                             |
| Fixtures, mocks, simulators and server code cannot be bundled for the browser                 | The build guards in `scripts/guards.ts`, tested in `tests/unit/guards.test.ts` and `tests/unit/build.test.ts`                                                                                                                                                      |
| No provider key reaches the browser                                                           | `no-secret-name-in-browser` (policy, for every key name), the secret-value scan of the build output (guards), and `tests/unit/server-handlers.test.ts` and `tests/unit/capability-handlers.test.ts` (no response contains a key, even when the provider echoes it) |
| The browser calls only its own origin                                                         | `no-absolute-url-in-browser` and `network-only-at-the-edge` (policy), `connect-src 'self'` (CSP)                                                                                                                                                                   |
| Freshness rules                                                                               | `tests/unit/core.test.ts`, `tests/unit/feeds.test.ts`                                                                                                                                                                                                              |
| Provider validation                                                                           | `tests/unit/data.test.ts`, `tests/unit/wire.test.ts`, `tests/unit/server-twelvedata.test.ts`, `tests/unit/provider-adapters.test.ts`                                                                                                                               |
| Budgets, retry, cache and the registry                                                        | `tests/unit/provider-framework.test.ts`, `tests/unit/provider-registry.test.ts`                                                                                                                                                                                    |
| State wording, fallback rules, derived-data states                                            | `tests/unit/service-layer.test.ts`, `tests/unit/forex-service.test.ts`, `tests/unit/macro-service.test.ts`                                                                                                                                                         |
| The capability endpoints and the provider page                                                | `tests/unit/capability-handlers.test.ts`, `tests/unit/provider-status.test.ts`, `tests/e2e/providers.test.ts`                                                                                                                                                      |
| Connection classification                                                                     | `tests/unit/connection.test.ts`, and `tests/e2e/no-env.test.ts` in a real browser with no environment                                                                                                                                                              |
| Macro validation and attribution                                                              | `tests/unit/macro-data.test.ts`, `tests/unit/http-macro.test.ts`                                                                                                                                                                                                   |
| Surface VI draws nothing the calendar did not supply                                          | `tests/unit/event-waves.test.ts`, `tests/e2e/component-event-waves.test.ts`                                                                                                                                                                                        |
| ELVOID result validation                                                                      | `tests/unit/elvoid.test.ts`                                                                                                                                                                                                                                        |

## What is not verified

Said plainly. **Passing tests with a stand-in for the network does not prove that a live API
integration works.**

- **Live providers.** Four have been checked against their live APIs from the production
  deployment (2026-11-10 and 2026-11-11): Twelve Data (authentication, quotes for EUR/USD and
  XAU/USD, hourly candles for EUR/USD) and the three that need no key, Frankfurter, the World Bank
  and the BLS (its keyless version 1). The values were not compared against the providers' own
  sites. Five have **not** been run against a live API: Alpha Vantage, FRED, Marketaux and the BEA
  need a key that was not available when this was written, and so does Finance Calendar, which has
  no anonymous access (its keyless request, sent before its reference was read again, was refused
  with HTTP 401). Their adapters are written from the providers' published documentation and tested
  against the response shapes they document. The IMF has no endpoint. The status of each provider is
  in [ENVIRONMENT.md](ENVIRONMENT.md#providers).
- **Free-tier limits** are the ones each provider's documentation states. The ones that could not be
  confirmed against a live account are marked as such there. Elstand's budgets are set below them.
- **What a screen shows on the production deployment** has not been compared against a provider's own
  site except where ENVIRONMENT.md says so.
- **Depth and the volatility surface** have no real provider. Their available-state rendering is
  verified with test fixtures only.
