# ELVOID

ELVOID is the reasoning engine this terminal is built around. **Phase 1 does not ship an engine.**
It ships everything an engine needs to plug into safely: the workspace that shows its work, the
contract its results must satisfy, the validator that refuses results that do not, the status
machine, a 13-module registry that states what is and is not built, and the guard for how ELVOID
may change. With no engine the workspace says **NOT CONFIGURED**, and it fills no section with an
example.

Two commitments shape all of it:

- **ELVOID does not present an opinion as a measurement.** The contract has no confidence score,
  probability, win rate, expected return, profit projection or backtest figure, and the validator
  rejects a result that carries one. When backtesting exists it will report through its own
  versioned, sourced record, never as a number attached to an opinion.
- **ELVOID does not rewrite itself.** A change is proposed, tested, evaluated, versioned and approved
  by a person, in that order, with every step recorded.

## The five states

The workspace is always in exactly one of these (`src/elvoid/status.ts`, labels in
`src/elvoid/contracts.ts`). The header's ELVOID chip shows the same state and takes you to the
workspace.

| State            | When                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| NOT CONFIGURED   | No engine is connected. Always the case in Phase 1.                                                                         |
| WAITING FOR DATA | An engine exists, but the selected instrument's data is STALE or UNAVAILABLE, so nothing is started. The reason says which. |
| ANALYZING        | The engine is working on the selected instrument and timeframe (or a run is queued).                                        |
| RESULT AVAILABLE | The engine returned a result and it passed validation.                                                                      |
| ERROR            | The engine failed, or returned a result that failed validation. The message is shown, with a Retry.                         |

Precedence, in order: an engine must exist; then a failure, a run in progress and a finished result
outrank data eligibility (a finished result stays valid history); only then does ineligible data
hold back a new analysis. The data that counts is the least trustworthy of the selected quote and
the selected candle series. Only LIVE and DELAYED data may feed an analysis. If a result is on
screen and its input data later turns STALE, the workspace says so next to the result.

## What a result is

The workspace has eight sections, in this order: **Evidence, Technical context, Macro context,
Bullish case, Bearish case, Invalidation, Risks, Final state.** A result (`AnalysisResult`) carries:

- an `id`, the engine's `id` and `version`, the `instrumentId`, the `timeframe`, and `requestedAt` and
  `completedAt`;
- `evidence`: items with an `id`, a `kind` (market-data, technical, macro, news, cross-asset,
  volatility, liquidity), a `summary`, a `sourceId`, an `observedAt` time and the `dataState` the data
  had when it was used;
- `technical` and `macro`: a summary plus the ids of the evidence behind it;
- `bullish` and `bearish`: a summary plus the evidence behind each;
- `invalidations`: conditions that would void the view, each with its evidence;
- `risks`: risk factors;
- a `conclusion`: a state and a summary.

The three conclusion states are not forecasts:

| State       | Meaning in this interface                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| WAIT        | ELVOID does not take a view on the evidence it has.                                                                                     |
| RESEARCHING | ELVOID is still gathering evidence.                                                                                                     |
| VALIDATED   | The result passed Elstand's structure and evidence checks. This is not a forecast, and it carries no probability, confidence or return. |

## What the validator refuses

`validateAnalysisResult` (`src/elvoid/validate-result.ts`) checks everything an engine returns before
the interface may show it. A result is accepted whole or not at all, and the output is **built
from the known fields**, so an unknown field is dropped and never passed through.

- **Measured-looking opinions.** A key named confidence, probability, win rate, hit rate, accuracy,
  expected return, expected profit, profit projection, backtest, backtest result, Sharpe, Sharpe ratio
  or PnL, at any depth up to eight levels, in any letter case and with any punctuation (`win_rate`,
  `Win-Rate`), rejects the result.
- **Structure.** Every field above must be present with the right type. The instrument must be one
  the terminal knows. `completedAt` cannot precede `requestedAt`.
- **Evidence integrity.** Evidence ids are unique and every reference resolves to one. Evidence that
  used UNAVAILABLE data is not admissible.
- **A VALIDATED conclusion** additionally needs: evidence that is only LIVE or DELAYED; at least one
  market-data or technical item; evidence behind both the bullish and the bearish case; at least one
  invalidation condition; and at least one risk factor.

The controller (`src/elvoid/controller.ts`) adds two rules of its own. A result for a different
instrument or timeframe than the one requested is refused. A result that arrives after the selection
changed is discarded, and the superseded request is aborted.

## Connecting an engine

An engine implements `ElvoidEngine` (`src/elvoid/contracts.ts`): an `id`, a `version`, and
`analyze(request, signal)`, which returns `unknown` on purpose, because the controller validates it.

1. Write the engine. It receives the instrument, the timeframe and the request time, and an abort signal.
2. **If it needs a credential or heavy computation, it runs on the server.** The browser-side
   `ElvoidEngine` is then a thin client of a server endpoint (a new function under `api/`, built on the
   same pattern as `server/handlers.ts`). The key never enters the browser: the policy linter bans the
   key's name and `process.env` in browser code, and the build fails if a secret value reaches the bundle.
   The names suggested for this are in [ENVIRONMENT.md](ENVIRONMENT.md#planned-variables-not-read-by-this-build).
3. Pass it to `mountApp` as `elvoidEngine` (`src/main.ts` passes none today). That is the single
   place an engine is plugged in.
4. Return results that satisfy the contract. Anything that does not shows ERROR with the first
   three problems.
5. Decide what feeds the engine's evidence. The registry in [ELVOID-MODULES.md](ELVOID-MODULES.md)
   says which modules are implemented, which have a contract only, and which do not exist.

Until a real engine runs, the news and calendar interpretation field has one rule: with no engine
configured it is always removed. See the limitation recorded in
[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations) for what happens once one is.

## Controlled improvement

`src/elvoid/improvement.ts` is the guard for how ELVOID may change. It applies nothing by itself:
releasing is a recorded decision, not a deploy. It makes the unsafe paths impossible to express.

| From               | May move to             |
| ------------------ | ----------------------- |
| proposed           | testing, rejected       |
| testing            | evaluated, rejected     |
| evaluated          | approved, rejected      |
| approved           | released, rejected      |
| rejected, released | nothing: both are final |

- A change targets a strategy, parameters, a prompt or application code, from one version to another.
- **Only a person can approve or release.** A system may reject, which can only reduce risk.
- A change cannot be released without a recorded human approval.
- The history is append-only and chronological: an entry cannot be dated before the previous one.
- Skipping a stage, or changing a rejected or released change, is refused with a stated reason.

## Modules

ELVOID is organized into 13 modules with explicit boundaries, so each one names what it takes in,
what it puts out and how it fails before code is written for it. Each module is one of three things:
implemented (it runs, has tests and documented error states), contract only (types and validation
exist, no analytical logic does), or not implemented (nothing exists beyond its registry entry). In
Phase 1 almost all of them are not implemented, and the documents say so rather than imply
otherwise. The registry is `src/elvoid/modules.ts`, and [ELVOID-MODULES.md](ELVOID-MODULES.md) is
generated from it, so the two cannot disagree. The same registry is shown inside the workspace.
