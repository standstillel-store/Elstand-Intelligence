# Data integrity

Elstand Intelligence is a place where people look at numbers and make decisions. The principle
this project is built on is that **the numbers are real, or they are not there**. This document
says what that means in code, where each rule lives and which tests hold it in place.

## Principles

1. **Real data or ENV NOT CONNECTION.** There is no simulated, sample, mock, seeded, random or
   placeholder source anywhere in the product. When nothing is connected the interface says
   exactly **ENV NOT CONNECTION** (`src/core/connection-text.ts` holds the one copy of the text).
   Test fixtures exist, but only under `tests/`, and the build refuses to bundle them
   (see [TESTING.md](TESTING.md)).
2. **Provider output is untrusted.** It is validated on the server before it is returned, and
   validated again in the browser before it reaches a panel. A misconfigured proxy or a static host
   that answers `/api/status` with an HTML page is treated as untrusted exactly like a vendor.
3. **Nothing is repaired.** A price that fails a check is an error or an UNAVAILABLE state. It is
   never clamped, rounded into range, interpolated, back-filled or replaced by the previous value,
   because a repaired price is a made-up price.
4. **The source declares what it is.** Whether data is `live` or `delayed` is declared by the
   operator (`ELSTAND_FEED_REALTIME`). The interface never infers "live" from numbers that look
   plausible.
5. **Every datum has a time and a state.** A number without an observation time and one of the four
   states below is not shown as current.
6. **Attribution travels with the value.** Macro values, news and calendar items carry their source,
   observation or retrieval time and, for impact, who assigned it. An item without them is rejected.
7. **Absence is stated, with the reason.** A missing book, surface or analysis says it is missing and
   why. An empty panel is a defect.

## Data states

`DataState` is the only vocabulary the interface uses for freshness (`src/core/types.ts`,
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

**Macro bubbles** (`validateBubblePoints` in `src/data/macro-bubbles.ts`). An ISO 4217 code, once.
Each of the three values (policy rate, CPI, one-month price change) a finite number with an
observation time and a named source. The price change states its basis. See
[MACRO-BUBBLES.md](MACRO-BUBBLES.md).

**News and calendar** (`screenCalendar`, `screenNews` in `src/data/macro-validate.ts`). Every item
has a unique id, a valid time, an ISO currency (calendar) or valid currency list (news), a title or
headline, a named source and a retrieval time. An impact level is one of low, medium or high **and**
names who assigned it, or the item is shown as UNCLASSIFIED. Rejected items are listed with the
reason, not dropped silently. With no ELVOID engine configured, any interpretation attached to an
item is removed and the page says how many were.

**ELVOID results** (`validateAnalysisResult`). See [ELVOID.md](ELVOID.md).

## ENV NOT CONNECTION versus SERVER ERROR

These two are different statements and the interface keeps them apart.

- **ENV NOT CONNECTION** means no real data source is connected: the server has no credentials, the
  provider rejected them, or the server API is not present at all. The fix is configuration.
- **SERVER ERROR** means the server was asked and did not answer properly: the status request
  failed, the network dropped, or the status body was malformed. The fix may be nothing, and it
  has a Retry button.
- A failure of one request to a connected provider (a rate limit, an invalid answer) is neither. It
  is shown on the panel it affected, with Retry, and the connection stays.

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

In Phase 1 the only provider has no depth adapter, so depth is always UNAVAILABLE with a stated
reason (`DEPTH_UNAVAILABLE_REASON` in `server/handlers.ts`, plus the instrument's own `depthNote`).

## What enforces this

| Rule                                                                                          | Held by                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fabricated data in product code (mock, fake, dummy, stub, sample, demo, simulated, random) | `npm run lint:policy`, rules `no-placeholder-data` and `no-randomness`                                                                                                                              |
| Fixtures, mocks, simulators and server code cannot be bundled for the browser                 | The build guards in `scripts/guards.ts`, tested in `tests/unit/guards.test.ts` and `tests/unit/build.test.ts`                                                                                       |
| The provider key never reaches the browser                                                    | `no-secret-name-in-browser` (policy), the secret-value scan of the build output (guards), and `tests/unit/server-handlers.test.ts` (no response contains the key, even when the provider echoes it) |
| The browser calls only its own origin                                                         | `no-absolute-url-in-browser` and `network-only-at-the-edge` (policy), `connect-src 'self'` (CSP)                                                                                                    |
| Freshness rules                                                                               | `tests/unit/core.test.ts`, `tests/unit/feeds.test.ts`                                                                                                                                               |
| Provider validation                                                                           | `tests/unit/data.test.ts`, `tests/unit/wire.test.ts`, `tests/unit/server-twelvedata.test.ts`                                                                                                        |
| Connection classification                                                                     | `tests/unit/connection.test.ts`, and `tests/e2e/no-env.test.ts` in a real browser with no environment                                                                                               |
| Macro validation and attribution                                                              | `tests/unit/macro-data.test.ts`                                                                                                                                                                     |
| ELVOID result validation                                                                      | `tests/unit/elvoid.test.ts`                                                                                                                                                                         |

## What is not verified

- The Twelve Data adapter has not run against the live API. It is written from the published
  documentation and tested against a stand-in for the network. The checklist in
  [ENVIRONMENT.md](ENVIRONMENT.md#first-connection-checklist) exists to close this gap.
- Depth, the volatility surface, the macro bubbles and the news and calendar feeds have no real
  provider in Phase 1. Their available-state rendering is verified with test fixtures only.
