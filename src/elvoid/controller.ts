import { isAnalysisEligible } from '../core/freshness.js';
import { createStore, type ReadableStore } from '../core/store.js';
import type { DataState, Timeframe } from '../core/types.js';
import type { AnalysisResult, AnalysisStatus, ElvoidEngine, EngineIdentity } from './contracts.js';
import { deriveAnalysisStatus, type AnalysisJob } from './status.js';
import { validateAnalysisResult } from './validate-result.js';

export interface AnalysisSnapshot {
  readonly status: AnalysisStatus;
  readonly reason: string;
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly requestedAt: number | null;
  /** Present only with RESULT_AVAILABLE. */
  readonly result: AnalysisResult | null;
  /** Present only with ERROR. */
  readonly error: string | null;
  readonly engine: EngineIdentity | null;
}

export interface AnalysisController {
  readonly store: ReadableStore<AnalysisSnapshot>;
  /**
   * Tells the controller what is selected and how fresh its data is. Starts a run when an
   * engine exists, the data is eligible and nothing is running for this selection.
   */
  select(instrumentId: string, timeframe: Timeframe, dataState: DataState): void;
  /** Re-runs after an ERROR. No-op in any other state. */
  retry(): void;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return typeof error === 'string' && error !== '' ? error : 'The engine failed without a message.';
}

function same(a: AnalysisSnapshot, b: AnalysisSnapshot): boolean {
  return (
    a.status === b.status &&
    a.reason === b.reason &&
    a.instrumentId === b.instrumentId &&
    a.timeframe === b.timeframe &&
    a.requestedAt === b.requestedAt &&
    a.result === b.result &&
    a.error === b.error &&
    a.engine === b.engine
  );
}

/**
 * Owns the lifecycle of analysis for the current selection. With `engine === null` (Phase 1)
 * it simply reports NOT CONFIGURED. With an engine, everything the engine returns passes
 * through `validateAnalysisResult` before it can reach the UI, and a result that belongs to
 * a previous selection is discarded.
 */
export function createAnalysisController(
  engine: ElvoidEngine | null,
  now: () => number = Date.now,
): AnalysisController {
  const identity: EngineIdentity | null =
    engine === null ? null : { id: engine.id, version: engine.version };
  let key = '';
  let instrumentId = '';
  let timeframe: Timeframe = 'H1';
  let dataState: DataState = 'unavailable';
  let job: AnalysisJob = { kind: 'idle' };
  let requestedAt: number | null = null;
  let abort: AbortController | null = null;
  let token = 0;

  function snapshot(): AnalysisSnapshot {
    const outcome = deriveAnalysisStatus({ engineConfigured: engine !== null, dataState, job });
    return {
      status: outcome.status,
      reason: outcome.reason,
      instrumentId,
      timeframe,
      requestedAt,
      result: job.kind === 'done' ? job.result : null,
      error: job.kind === 'failed' ? job.message : null,
      engine: identity,
    };
  }

  const store = createStore<AnalysisSnapshot>(snapshot());

  function publish(): void {
    const next = snapshot();
    if (!same(store.get(), next)) store.set(next);
  }

  function start(activeEngine: ElvoidEngine): void {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    token += 1;
    const mine = token;
    const startedAt = now();
    requestedAt = startedAt;
    job = { kind: 'running', startedAt };
    const request = { instrumentId, timeframe, requestedAt: startedAt };

    Promise.resolve()
      .then(() => activeEngine.analyze(request, controller.signal))
      .then(
        (raw) => {
          if (mine !== token) return;
          const outcome = validateAnalysisResult(raw);
          if (!outcome.ok) {
            job = {
              kind: 'failed',
              message: `The engine returned a result that failed validation: ${outcome.issues.slice(0, 3).join('; ')}`,
            };
          } else if (
            outcome.value.instrumentId !== request.instrumentId ||
            outcome.value.timeframe !== request.timeframe
          ) {
            job = {
              kind: 'failed',
              message: 'The engine returned a result for a different selection.',
            };
          } else {
            job = { kind: 'done', result: outcome.value };
          }
          publish();
        },
        (error: unknown) => {
          if (mine !== token) return;
          job = { kind: 'failed', message: errorMessage(error) };
          publish();
        },
      );
  }

  function maybeStart(): void {
    if (engine === null || job.kind !== 'idle' || !isAnalysisEligible(dataState)) return;
    start(engine);
  }

  return {
    store,
    select(nextInstrumentId, nextTimeframe, nextDataState) {
      const nextKey = `${nextInstrumentId}|${nextTimeframe}`;
      if (nextKey !== key) {
        abort?.abort();
        abort = null;
        token += 1;
        key = nextKey;
        job = { kind: 'idle' };
        requestedAt = null;
      }
      instrumentId = nextInstrumentId;
      timeframe = nextTimeframe;
      dataState = nextDataState;
      maybeStart();
      publish();
    },
    retry() {
      if (job.kind !== 'failed') return;
      job = { kind: 'idle' };
      maybeStart();
      publish();
    },
    dispose() {
      abort?.abort();
      abort = null;
      token += 1;
    },
  };
}
