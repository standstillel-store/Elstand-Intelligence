<!-- GENERATED FILE. Do not edit by hand. -->
<!-- Source: src/elvoid/modules.ts. Regenerate with `npm run docs:gen`. A test fails if this file is out of date. -->

# ELVOID modules

ELVOID is organized as 13 modules with explicit boundaries. Each one names what it takes in, what it puts out and how it fails before any code is written for it. This page is generated from the registry in `src/elvoid/modules.ts`, which is the single source of truth.

**1 of 13 modules is implemented.** 3 have a contract only, and 9 are not implemented. ELVOID does not change itself: a change is proposed, tested, evaluated, versioned and then approved by a person.

## Status

- **IMPLEMENTED**: It runs, has tests, and is covered by documented error states.
- **CONTRACT ONLY**: A TypeScript contract exists in the repository (types and, where noted, validation), but no analytical logic does.
- **NOT IMPLEMENTED**: Nothing exists beyond the entry in this registry.

## Overview

| # | Module | Status | Contract in the repository |
| --- | --- | --- | --- |
| 1 | [Market data normalization](#1-market-data-normalization) | IMPLEMENTED | `src/data/provider.ts`, `src/data/validate.ts`, `src/data/service.ts` |
| 2 | [Technical analysis](#2-technical-analysis) | NOT IMPLEMENTED | none |
| 3 | [Macro analysis](#3-macro-analysis) | NOT IMPLEMENTED | none |
| 4 | [News interpretation](#4-news-interpretation) | NOT IMPLEMENTED | none |
| 5 | [Cross-asset relationships](#5-cross-asset-relationships) | NOT IMPLEMENTED | none |
| 6 | [Volatility and liquidity analysis](#6-volatility-and-liquidity-analysis) | CONTRACT ONLY | `src/data/options.ts`, `src/data/depth.ts` |
| 7 | [Hypothesis generation](#7-hypothesis-generation) | NOT IMPLEMENTED | none |
| 8 | [Scenario comparison](#8-scenario-comparison) | CONTRACT ONLY | `src/elvoid/contracts.ts`, `src/elvoid/validate-result.ts` |
| 9 | [Backtesting](#9-backtesting) | NOT IMPLEMENTED | none |
| 10 | [Performance evaluation](#10-performance-evaluation) | NOT IMPLEMENTED | none |
| 11 | [Controlled improvement](#11-controlled-improvement) | CONTRACT ONLY | `src/elvoid/improvement.ts` |
| 12 | [Decision logging](#12-decision-logging) | NOT IMPLEMENTED | none |
| 13 | [Notification events](#13-notification-events) | NOT IMPLEMENTED | none |

## 1. Market data normalization

**Status:** IMPLEMENTED  
**Id:** `market-data-normalization`  
**Contract:** `src/data/provider.ts`, `src/data/validate.ts`, `src/data/service.ts`

Turn vendor payloads into validated quotes, candles and depth, each with an honest data state.

**Inputs**

- Provider quote, candle and depth payloads
- Source mode declaration (live or delayed)

**Outputs**

- Quote, CandleSeries and DepthResult
- Data state per datum: LIVE, DELAYED, STALE or UNAVAILABLE

**Error states**

- Invalid, crossed or unsorted data is rejected, never repaired
- A series for the wrong instrument or timeframe is rejected
- Provider unreachable or timed out

## 2. Technical analysis

**Status:** NOT IMPLEMENTED  
**Id:** `technical-analysis`  
**Contract:** none yet

Describe price structure and indicator readings with stated parameters.

**Inputs**

- Validated CandleSeries (live or delayed only)

**Outputs**

- Evidence of kind technical, with indicator definitions and parameters

**Error states**

- Too few bars for the stated method
- Data state not eligible for analysis

## 3. Macro analysis

**Status:** NOT IMPLEMENTED  
**Id:** `macro-analysis`  
**Contract:** none yet

Relate scheduled releases and policy settings to a currency's outlook.

**Inputs**

- CalendarEvent list with source attribution and classified impact
- Policy-rate and inflation series (provider required)

**Outputs**

- Evidence of kind macro
- Macro context section with evidence references

**Error states**

- Event without source attribution is rejected
- Impact claimed without a classification is rejected
- Series older than its stated freshness limit

## 4. News interpretation

**Status:** NOT IMPLEMENTED  
**Id:** `news-interpretation`  
**Contract:** none yet

Read attributed news items and state their relevance to the selected instrument.

**Inputs**

- NewsItem list with source attribution

**Outputs**

- Evidence of kind news
- Interpretation text attributed to the item it came from

**Error states**

- Unattributed item is rejected
- Syndicated copies of one story are not counted as independent evidence

## 5. Cross-asset relationships

**Status:** NOT IMPLEMENTED  
**Id:** `cross-asset-relationships`  
**Contract:** none yet

Measure how the selected instrument relates to other instruments, rates and indices.

**Inputs**

- Time-aligned series for several instruments
- Rates and index series (provider required)

**Outputs**

- Evidence of kind cross-asset, with window length and method stated

**Error states**

- Series not time-aligned
- Window too short for the stated method

## 6. Volatility and liquidity analysis

**Status:** CONTRACT ONLY  
**Id:** `volatility-liquidity`  
**Contract:** `src/data/options.ts`, `src/data/depth.ts`

Interpret implied volatility and venue-level depth without generalizing either.

**Inputs**

- VolSurface with a stated strike axis
- DepthSnapshot naming its venue

**Outputs**

- Evidence of kind volatility or liquidity, scoped to the named source or venue

**Error states**

- Surface fails validation
- Book is crossed or one-sided
- Venue depth presented as market-wide is rejected

## 7. Hypothesis generation

**Status:** NOT IMPLEMENTED  
**Id:** `hypothesis-generation`  
**Contract:** none yet

Propose explanations for observed price behavior that can be tested against evidence.

**Inputs**

- Evidence set

**Outputs**

- Candidate hypotheses, each naming the evidence that would confirm or refute it

**Error states**

- A hypothesis with no refutation condition is rejected

## 8. Scenario comparison

**Status:** CONTRACT ONLY  
**Id:** `scenario-comparison`  
**Contract:** `src/elvoid/contracts.ts`, `src/elvoid/validate-result.ts`

Set bullish and bearish scenarios side by side with what would invalidate each.

**Inputs**

- Hypotheses
- Evidence set

**Outputs**

- Bullish and bearish Scenario, each with evidence references
- Invalidation conditions and risk factors

**Error states**

- A scenario references unknown evidence
- A conclusion without invalidation conditions

## 9. Backtesting

**Status:** NOT IMPLEMENTED  
**Id:** `backtesting`  
**Contract:** none yet

Test a versioned strategy definition against historical data.

**Inputs**

- Versioned strategy definition
- Historical data with stated source and period

**Outputs**

- A report stating data range, cost assumptions and parameters, produced only by a real run

**Error states**

- Look-ahead detected
- Insufficient history
- Cost assumptions not stated

## 10. Performance evaluation

**Status:** NOT IMPLEMENTED  
**Id:** `performance-evaluation`  
**Contract:** none yet

Compare past analyses with what subsequently happened.

**Inputs**

- Decision log
- Realized outcomes

**Outputs**

- An evaluation report that states its sample size

**Error states**

- Sample too small to report
- Outcomes missing for logged decisions

## 11. Controlled improvement

**Status:** CONTRACT ONLY  
**Id:** `controlled-improvement`  
**Contract:** `src/elvoid/improvement.ts`

Move a proposed change through testing, evaluation and human approval. ELVOID never changes itself.

**Inputs**

- Evaluation reports
- A proposed change with from and to versions

**Outputs**

- A ChangeProposal moving proposed, testing, evaluated, approved, released, with full history

**Error states**

- A stage is skipped
- Approval or release by anything other than a person
- Release without a recorded human approval
- Any change to a rejected or released proposal

## 12. Decision logging

**Status:** NOT IMPLEMENTED  
**Id:** `decision-logging`  
**Contract:** none yet

Keep an append-only record of what ELVOID concluded, from what, and under which version.

**Inputs**

- AnalysisResult
- Operator action

**Outputs**

- Append-only decision record with engine version and evidence references

**Error states**

- A failed write is surfaced, never dropped
- Editing a record after the fact is rejected

## 13. Notification events

**Status:** NOT IMPLEMENTED  
**Id:** `notification-events`  
**Contract:** none yet

Emit events for decisions and data conditions; delivery channels come in a later phase.

**Inputs**

- Decision records
- User notification rules

**Outputs**

- Notification event payloads

**Error states**

- A failed delivery is surfaced
- Duplicate events are suppressed
