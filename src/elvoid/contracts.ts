import type { DataState, Timeframe } from '../core/types.js';

/**
 * ELVOID analysis contracts.
 *
 * Deliberately absent from every type here: confidence scores, probabilities, win rates,
 * expected returns, profit projections and backtest results. Phase 1 has no engine that
 * could honestly produce them, and the validator rejects any result that carries them.
 * When real backtesting exists it will report through its own versioned, sourced record,
 * never as an inline number attached to an opinion.
 *
 * ELVOID is not self-evolving. Changes to strategies or code go through the lifecycle in
 * `improvement.ts`, which only a person can complete.
 */

export const ANALYSIS_STATUSES = [
  'NOT_CONFIGURED',
  'WAITING_FOR_DATA',
  'ANALYZING',
  'RESULT_AVAILABLE',
  'ERROR',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_STATUS_LABEL: Readonly<Record<AnalysisStatus, string>> = {
  NOT_CONFIGURED: 'NOT CONFIGURED',
  WAITING_FOR_DATA: 'WAITING FOR DATA',
  ANALYZING: 'ANALYZING',
  RESULT_AVAILABLE: 'RESULT AVAILABLE',
  ERROR: 'ERROR',
};

export const EVIDENCE_KINDS = [
  'market-data',
  'technical',
  'macro',
  'news',
  'cross-asset',
  'volatility',
  'liquidity',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  /** The provider, feed or module this evidence came from. */
  readonly sourceId: string;
  /** When the underlying datum was observed (epoch ms). */
  readonly observedAt: number;
  /** What the data was when it was used. Unavailable data is never admissible. */
  readonly dataState: DataState;
}

export interface ContextSection {
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface Scenario {
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface InvalidationCondition {
  readonly description: string;
  readonly evidenceIds: readonly string[];
}

export interface RiskFactor {
  readonly description: string;
}

export const CONCLUSION_STATES = ['WAIT', 'RESEARCHING', 'VALIDATED'] as const;
export type ConclusionState = (typeof CONCLUSION_STATES)[number];

export interface Conclusion {
  readonly state: ConclusionState;
  readonly summary: string;
}

export interface EngineIdentity {
  readonly id: string;
  readonly version: string;
}

export interface AnalysisResult {
  readonly id: string;
  readonly engine: EngineIdentity;
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly requestedAt: number;
  readonly completedAt: number;
  readonly evidence: readonly Evidence[];
  readonly technical: ContextSection;
  readonly macro: ContextSection;
  readonly bullish: Scenario;
  readonly bearish: Scenario;
  readonly invalidations: readonly InvalidationCondition[];
  readonly risks: readonly RiskFactor[];
  readonly conclusion: Conclusion;
}

export interface AnalysisRequest {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly requestedAt: number;
}

/**
 * The integration boundary for a real ELVOID engine. `analyze` returns `unknown` on
 * purpose: the controller validates everything an engine returns before it can be shown.
 */
export interface ElvoidEngine {
  readonly id: string;
  readonly version: string;
  analyze(request: AnalysisRequest, signal: AbortSignal): Promise<unknown>;
}
