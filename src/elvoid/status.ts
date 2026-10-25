import { isAnalysisEligible } from '../core/freshness.js';
import type { DataState } from '../core/types.js';
import type { AnalysisResult, AnalysisStatus } from './contracts.js';

export type AnalysisJob =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done'; readonly result: AnalysisResult };

export interface StatusInputs {
  readonly engineConfigured: boolean;
  /** Data state of the selected instrument. */
  readonly dataState: DataState;
  readonly job: AnalysisJob;
}

export interface StatusOutcome {
  readonly status: AnalysisStatus;
  readonly reason: string;
}

export const NOT_CONFIGURED_REASON =
  'No ELVOID engine is connected. Phase 1 provides the interface, data contracts and result ' +
  'validation only. No analysis is produced and none is simulated.';

function waitingReason(state: DataState): string {
  switch (state) {
    case 'stale':
      return 'The latest data for the selected instrument is stale. ELVOID waits for fresh data.';
    case 'unavailable':
      return 'No data is available for the selected instrument yet.';
    default:
      return 'Waiting for data.';
  }
}

/**
 * Pure mapping from inputs to one of the five explicit states. Precedence: an engine must
 * exist; then a failure, a run in progress and a finished result take precedence over data
 * eligibility (a finished result stays valid history); only then does ineligible data hold
 * a new analysis back.
 */
export function deriveAnalysisStatus(inputs: StatusInputs): StatusOutcome {
  if (!inputs.engineConfigured) {
    return { status: 'NOT_CONFIGURED', reason: NOT_CONFIGURED_REASON };
  }
  switch (inputs.job.kind) {
    case 'failed':
      return { status: 'ERROR', reason: inputs.job.message };
    case 'running':
      return { status: 'ANALYZING', reason: 'The engine is working on the selected instrument.' };
    case 'done':
      return { status: 'RESULT_AVAILABLE', reason: 'Result returned by the engine and validated.' };
    case 'idle':
      break;
  }
  if (!isAnalysisEligible(inputs.dataState)) {
    return { status: 'WAITING_FOR_DATA', reason: waitingReason(inputs.dataState) };
  }
  return { status: 'ANALYZING', reason: 'Analysis is being queued.' };
}
