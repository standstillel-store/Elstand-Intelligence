# Environment

**Nothing here is required.** With no environment variable at all, the application builds, starts
and renders, and every panel that needs provider data shows the exact text **ENV NOT CONNECTION**.
There is no sample data to fall back to, by design (see [DATA-INTEGRITY.md](DATA-INTEGRITY.md)).

Every variable is read **only by the server** (`api/*`, `npm run dev`, `npm run preview`). None is
sent to the browser. `/api/status` reports the _names_ of missing variables and never a value.
`.env.example` lists the same variables with every line commented out.

## Variables

| Name                      | Secret  | Default | What it does                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWELVE_DATA_API_KEY`     | **yes** | unset   | Your Twelve Data API key. Unset or blank: the server reports `connected: false` and the whole interface shows ENV NOT CONNECTION.                                                                                                                                                                                                                                                       |
| `ELSTAND_FEED_REALTIME`   | no      | `false` | Declares whether your Twelve Data plan delivers real-time forex. **Only the value `true`** (any letter case, surrounding spaces ignored) declares the feed real-time: fresh data is then labelled LIVE and becomes STALE after 5 minutes. Any other value, or none, labels fresh data DELAYED, which becomes STALE after 30 minutes. The application never assumes a feed is real-time. |
| `ELSTAND_REFRESH_SECONDS` | no      | `60`    | Seconds between refreshes. It is both the server cache lifetime and the browser's polling interval. A plain whole number is clamped to **10 to 3600**. Anything else (blank, `abc`, `1.5`, `-5`, `1e2`) is a misconfiguration and falls back to 60.                                                                                                                                     |

Setting the same name in `.env.local` and in the real environment: the real environment wins.
`npm run dev` and `npm run preview` read `.env` and `.env.local`; both are git-ignored, as is every
`.env.*` file except `.env.example`.

## What the interface shows in each situation

| Situation                                                                                                                        | What the server answers                                                   | What you see                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `TWELVE_DATA_API_KEY`                                                                                                         | `/api/status`: `{"connected": false, "missing": ["TWELVE_DATA_API_KEY"]}` | **ENV NOT CONNECTION** in the header and every data panel. Detail: "Server environment variable TWELVE_DATA_API_KEY is not set."                                                                                                                                         |
| The server API is not there at all (a static host without functions, so `/api/status` answers 404 or something that is not JSON) | none                                                                      | **ENV NOT CONNECTION**. Detail: "The Elstand server API is not available at /api/status." A non-JSON server failure (for example an HTML 5xx page from a proxy) reads the same way, because from the browser the two cannot be told apart.                               |
| Key set, but the provider refuses it (HTTP 401)                                                                                  | `/api/quotes` or `/api/candles`: 502 `provider_auth`                      | The application turns **ENV NOT CONNECTION** with the provider's refusal as the detail. `/api/status` cannot know this in advance, so the first data request is what reveals it. The server remembers the rejection for 60 seconds instead of asking the provider again. |
| Provider request limit reached                                                                                                   | 429 `rate_limited`, with `Retry-After` when the provider sends one        | The affected panel shows the failure and a Retry button. The connection stays up. The server remembers the limit for 15 seconds instead of asking again.                                                                                                                 |
| Provider unreachable, or it returned data that failed validation                                                                 | 504 `provider_unreachable`, or 502 `provider_error`                       | The affected panel shows the failure and a Retry button. Nothing is repaired or filled in.                                                                                                                                                                               |
| `/api/status` itself fails (a JSON error, a network failure, a malformed status body)                                            | varies                                                                    | **SERVER ERROR** with a Retry button. This is deliberately different from ENV NOT CONNECTION: the environment may be fine, the server is not answering properly.                                                                                                         |

## Licensing

Reading a provider's data is not the same as being allowed to show it. This is the operator's
responsibility, and the application cannot check it.

- Twelve Data's individual plans are for personal or internal use. Showing the data to the public
  (a public Elstand deployment) needs a business plan or a redistribution agreement. Confirm this
  with Twelve Data for the plan you hold before you deploy publicly.
- Each request consumes credits under your plan, and plans have per-minute and per-day limits.
  With one visible tab open and the default 60-second refresh, a warm server instance makes up to
  nine upstream requests per minute: one quote per instrument (eight) and one candle series for the
  selected chart. Serverless instances each keep their own cache, so several instances multiply this.
  The `Cache-Control` headers let a CDN share answers across them. Check your plan's current limits
  on Twelve Data's pricing page and raise `ELSTAND_REFRESH_SECONDS` if you are close to them.
- `ELSTAND_FEED_REALTIME=true` is your statement that the plan delivers real-time forex. If it does
  not, the interface would call delayed data LIVE. Do not set it on a guess.

## First-connection checklist

The Twelve Data adapter was written against the vendor's published documentation and tested with a
stand-in for the network. **It has not talked to the live API.** Do these checks the first time you
connect a real key, in this order, and stop at the first one that does not match.

1. Set `TWELVE_DATA_API_KEY` on the server and restart or redeploy. Leave `ELSTAND_FEED_REALTIME`
   unset until step 5.
2. Open `/api/status`. Expect `connected: true`, `source.id` `twelvedata`, `source.mode`
   `delayed`, `depth.available` `false` with a reason, and `pollSeconds`. The key must appear
   nowhere in the response.
3. Open `/api/quotes?ids=EURUSD,XAUUSD`. Each quote needs a positive `last`, an `asOf` that is a
   recent time in epoch milliseconds, `bid` and `ask` of `null` (this adapter does not supply them),
   and `changeBasis` of `prev. close`. Compare `last` with the provider's own dashboard.
4. Open `/api/candles?id=EURUSD&tf=H1`. Each bar is `[openTimeMs, open, high, low, close]`, ascending.
   Compare the newest bars with the provider's chart, and **check that the open times are UTC**: the
   adapter requests `timezone=UTC` and reads the times as UTC, so a whole-hour offset means the
   provider did not honor it. Stop and report it if you see one.
5. If your plan is real-time, set `ELSTAND_FEED_REALTIME=true` and confirm the header shows LIVE on
   a quote that is moving. Otherwise leave it unset.
6. Select every instrument and every timeframe once. Each must either draw or show a clear failure.
   A failure for one instrument (a symbol your plan does not cover, say) is shown for that
   instrument only; the others stay.
7. Confirm in the browser's developer tools that the page talks to its own origin only and that no
   response or script contains your key.

## Planned variables (not read by this build)

Phase 1 reads exactly the three variables above. The rest of the modules have no adapter. When one
is built, these are the variables it should take. The names are suggestions, they appear nowhere in
the code today, and a test fails if one of them is read before it is documented here as a real
variable.

| Integration                      | Suggested variables                                | Notes                                                                                              |
| -------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Order-book depth                 | `ELSTAND_DEPTH_API_KEY`, `ELSTAND_DEPTH_VENUE`     | A book is only meaningful from a named venue, so the venue name is configuration, not a guess.     |
| FX options (volatility surface)  | `ELSTAND_OPTIONS_API_KEY`                          | Needs a stated delta-to-strike convention, which belongs in the adapter, not the environment.      |
| Macro series (policy rates, CPI) | `ELSTAND_MACRO_API_KEY`                            | One licensed source per currency, each attributed per value.                                       |
| News and economic calendar       | `ELSTAND_NEWS_API_KEY`, `ELSTAND_CALENDAR_API_KEY` | Every item must carry source attribution and an impact level with its author.                      |
| ELVOID engine                    | `ELVOID_ENGINE_URL`, `ELVOID_ENGINE_API_KEY`       | A credential means the engine runs on the server. See [ELVOID.md](ELVOID.md#connecting-an-engine). |

Whatever is added follows the rules of the current three: server-only, optional, and a clear
ENV NOT CONNECTION when missing.
