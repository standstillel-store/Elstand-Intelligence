import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ANALYSIS_STATUS_LABEL,
  ANALYSIS_STATUSES,
  CONCLUSION_STATES,
  EVIDENCE_KINDS,
  type AnalysisRequest,
  type ElvoidEngine,
} from '../../src/elvoid/contracts.js';
import { createAnalysisController } from '../../src/elvoid/controller.js';
import {
  CHANGE_STAGES,
  canTransition,
  createProposal,
  transition,
  type Actor,
  type ChangeProposal,
  type ChangeStage,
} from '../../src/elvoid/improvement.js';
import {
  countImplemented,
  ELVOID_MODULES,
  MODULE_STATUS_LABEL,
  type ModuleStatus,
} from '../../src/elvoid/modules.js';
import {
  deriveAnalysisStatus,
  NOT_CONFIGURED_REASON,
  type AnalysisJob,
} from '../../src/elvoid/status.js';
import { validateAnalysisResult } from '../../src/elvoid/validate-result.js';
import { FIXTURE_NOW, fixtureAnalysisResult } from '../support/fixtures.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const REQUEST: AnalysisRequest = {
  instrumentId: 'EURUSD',
  timeframe: 'H1',
  requestedAt: FIXTURE_NOW,
};
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The result with `change` applied, for breaking exactly one rule at a time. */
function result(
  change: (value: Record<string, unknown>) => void = () => undefined,
  conclusion: 'WAIT' | 'RESEARCHING' | 'VALIDATED' = 'WAIT',
): Record<string, unknown> {
  const value = fixtureAnalysisResult(REQUEST, conclusion);
  change(value);
  return value;
}

function issuesOf(input: unknown): string[] {
  const outcome = validateAnalysisResult(input);
  assert.equal(outcome.ok, false, 'expected the result to be rejected');
  return outcome.ok ? [] : [...outcome.issues];
}

const mentions = (issues: readonly string[], pattern: RegExp): boolean =>
  issues.some((issue) => pattern.test(issue));

// ---- contracts ------------------------------------------------------------------------------

describe('ELVOID contracts', () => {
  it('names the five states exactly as the product shows them', () => {
    assert.deepEqual(
      [...ANALYSIS_STATUSES],
      ['NOT_CONFIGURED', 'WAITING_FOR_DATA', 'ANALYZING', 'RESULT_AVAILABLE', 'ERROR'],
    );
    assert.deepEqual(
      ANALYSIS_STATUSES.map((status) => ANALYSIS_STATUS_LABEL[status]),
      ['NOT CONFIGURED', 'WAITING FOR DATA', 'ANALYZING', 'RESULT AVAILABLE', 'ERROR'],
    );
  });

  it('allows exactly three conclusions: WAIT, RESEARCHING and VALIDATED', () => {
    assert.deepEqual([...CONCLUSION_STATES], ['WAIT', 'RESEARCHING', 'VALIDATED']);
  });

  it('knows seven kinds of evidence', () => {
    assert.deepEqual(
      [...EVIDENCE_KINDS],
      ['market-data', 'technical', 'macro', 'news', 'cross-asset', 'volatility', 'liquidity'],
    );
  });
});

// ---- the result validator -------------------------------------------------------------------

describe('ELVOID result validation: structure', () => {
  it('accepts a well-formed result for every conclusion, and returns it typed', () => {
    for (const conclusion of CONCLUSION_STATES) {
      const outcome = validateAnalysisResult(result(() => undefined, conclusion));
      assert.equal(outcome.ok, true, conclusion);
      if (!outcome.ok) continue;
      assert.equal(outcome.value.conclusion.state, conclusion);
      assert.equal(outcome.value.instrumentId, 'EURUSD');
      assert.equal(outcome.value.timeframe, 'H1');
      assert.equal(outcome.value.evidence.length, 2);
      assert.equal(outcome.value.completedAt - outcome.value.requestedAt, 1500);
    }
  });

  it('rejects anything that is not an object', () => {
    for (const input of [null, undefined, 'WAIT', 42, true, [], [result()]]) {
      assert.deepEqual(issuesOf(input), ['result must be an object']);
    }
  });

  it('names each missing or malformed field, so an engine author can fix it', () => {
    const cases: readonly [string, (value: Record<string, unknown>) => void, RegExp][] = [
      ['id', (v) => delete v['id'], /^id must be a non-empty string$/],
      ['blank id', (v) => (v['id'] = '   '), /^id must be a non-empty string$/],
      ['engine', (v) => delete v['engine'], /^engine must be an object$/],
      [
        'engine id',
        (v) => (v['engine'] = { version: '1' }),
        /^engine\.id must be a non-empty string$/,
      ],
      [
        'engine version',
        (v) => (v['engine'] = { id: 'x' }),
        /^engine\.version must be a non-empty string$/,
      ],
      ['instrument', (v) => delete v['instrumentId'], /^instrumentId must be a non-empty string$/],
      [
        'unknown instrument',
        (v) => (v['instrumentId'] = 'BTCUSD'),
        /instrumentId BTCUSD is not a known instrument/,
      ],
      [
        'timeframe',
        (v) => (v['timeframe'] = 'W1'),
        /timeframe must be one of M5, M15, M30, H1, H4, D1/,
      ],
      ['requestedAt', (v) => (v['requestedAt'] = 'now'), /^requestedAt must be a finite number$/],
      [
        'completedAt',
        (v) => (v['completedAt'] = Number.NaN),
        /^completedAt must be a finite number$/,
      ],
      ['evidence', (v) => (v['evidence'] = 'E1'), /^evidence must be an array$/],
      ['evidence entry', (v) => (v['evidence'] = [null]), /^evidence\[0\] must be an object$/],
      [
        'evidence kind',
        (v) => (v['evidence'] = [{ ...(v['evidence'] as object[])[0], kind: 'rumor' }]),
        /evidence\[0\]\.kind must be one of/,
      ],
      [
        'evidence state',
        (v) => (v['evidence'] = [{ ...(v['evidence'] as object[])[0], dataState: 'simulated' }]),
        /evidence\[0\]\.dataState must be one of: live, delayed, stale, unavailable/,
      ],
      [
        'evidence summary',
        (v) => (v['evidence'] = [{ ...(v['evidence'] as object[])[0], summary: '' }]),
        /evidence\[0\]\.summary must be a non-empty string/,
      ],
      [
        'evidence source',
        (v) => (v['evidence'] = [{ ...(v['evidence'] as object[])[0], sourceId: undefined }]),
        /evidence\[0\]\.sourceId must be a non-empty string/,
      ],
      [
        'evidence time',
        (v) => (v['evidence'] = [{ ...(v['evidence'] as object[])[0], observedAt: '1' }]),
        /evidence\[0\]\.observedAt must be a finite number/,
      ],
      ['technical', (v) => delete v['technical'], /^technical must be an object$/],
      [
        'technical summary',
        (v) => (v['technical'] = { evidenceIds: ['E1'] }),
        /^technical\.summary must be a non-empty string$/,
      ],
      [
        'macro ids',
        (v) => (v['macro'] = { summary: 's', evidenceIds: 'E2' }),
        /^macro\.evidenceIds must be an array$/,
      ],
      [
        'bullish id entry',
        (v) => (v['bullish'] = { summary: 's', evidenceIds: [''] }),
        /^bullish\.evidenceIds\[0\] must be a non-empty string$/,
      ],
      ['bearish', (v) => (v['bearish'] = 'bearish'), /^bearish must be an object$/],
      ['invalidations', (v) => (v['invalidations'] = {}), /^invalidations must be an array$/],
      [
        'invalidation entry',
        (v) => (v['invalidations'] = ['x']),
        /^invalidations\[0\] must be an object$/,
      ],
      [
        'invalidation text',
        (v) => (v['invalidations'] = [{ evidenceIds: [] }]),
        /invalidations\[0\]\.description must be a non-empty string/,
      ],
      ['risks', (v) => (v['risks'] = null), /^risks must be an array$/],
      ['risk entry', (v) => (v['risks'] = [3]), /^risks\[0\] must be an object$/],
      [
        'risk text',
        (v) => (v['risks'] = [{}]),
        /risks\[0\]\.description must be a non-empty string/,
      ],
      ['conclusion', (v) => delete v['conclusion'], /^conclusion must be an object$/],
      [
        'conclusion state',
        (v) => (v['conclusion'] = { state: 'BUY', summary: 's' }),
        /conclusion\.state must be one of: WAIT, RESEARCHING, VALIDATED/,
      ],
      [
        'conclusion summary',
        (v) => (v['conclusion'] = { state: 'WAIT' }),
        /^conclusion\.summary must be a non-empty string$/,
      ],
    ];
    for (const [name, change, expected] of cases) {
      const issues = issuesOf(result(change));
      assert.ok(mentions(issues, expected), `${name}: ${JSON.stringify(issues)}`);
    }
  });

  it('rejects a result that finished before it was requested', () => {
    const issues = issuesOf(result((v) => (v['completedAt'] = FIXTURE_NOW - 1)));
    assert.ok(mentions(issues, /completedAt is earlier than requestedAt/));
  });

  it('reports every problem at once, not only the first', () => {
    const issues = issuesOf(
      result((v) => {
        delete v['id'];
        v['timeframe'] = 'W1';
        v['risks'] = [{}];
        v['conclusion'] = { state: 'BUY', summary: '' };
      }),
    );
    assert.ok(issues.length >= 4, JSON.stringify(issues));
  });

  it('does not carry unknown fields into the value it returns', () => {
    const outcome = validateAnalysisResult({ ...result(), notes: 'hidden', extra: { deep: true } });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(Object.keys(outcome.value).sort(), [
      'bearish',
      'bullish',
      'completedAt',
      'conclusion',
      'engine',
      'evidence',
      'id',
      'instrumentId',
      'invalidations',
      'macro',
      'requestedAt',
      'risks',
      'technical',
      'timeframe',
    ]);
  });
});

describe('ELVOID result validation: no measured-looking opinions', () => {
  const FORBIDDEN = [
    'confidence',
    'probability',
    'winRate',
    'hitRate',
    'accuracy',
    'expectedReturn',
    'expectedProfit',
    'profitProjection',
    'backtest',
    'backtestResult',
    'sharpe',
    'sharpeRatio',
    'pnl',
  ];

  it('rejects each forbidden field at the top level', () => {
    for (const field of FORBIDDEN) {
      const issues = issuesOf(result((v) => (v[field] = 0.8)));
      assert.ok(
        mentions(issues, new RegExp(`result\\.${field} is not permitted`)),
        `${field}: ${JSON.stringify(issues)}`,
      );
    }
  });

  it('rejects them however the key is spelled', () => {
    for (const key of [
      'Win Rate',
      'win_rate',
      'win-rate',
      'WINRATE',
      'Hit_Rate',
      'Sharpe Ratio',
      'P N L'.replace(/ /g, ''),
      'Expected-Return',
    ]) {
      const issues = issuesOf(result((v) => (v[key] = 1)));
      assert.ok(mentions(issues, /is not permitted/), `${key}: ${JSON.stringify(issues)}`);
    }
  });

  it('finds them nested in evidence, scenarios, invalidations, risks and the conclusion', () => {
    const nested: readonly [string, (v: Record<string, unknown>) => void, RegExp][] = [
      [
        'evidence',
        (v) =>
          (v['evidence'] = [
            { ...(v['evidence'] as object[])[0], confidence: 0.9 },
            (v['evidence'] as object[])[1],
          ]),
        /result\.evidence\[0\]\.confidence/,
      ],
      [
        'bullish',
        (v) => (v['bullish'] = { summary: 's', evidenceIds: ['E1'], probability: 0.7 }),
        /result\.bullish\.probability/,
      ],
      [
        'invalidation',
        (v) => (v['invalidations'] = [{ description: 'd', evidenceIds: [], accuracy: 0.5 }]),
        /result\.invalidations\[0\]\.accuracy/,
      ],
      ['risk', (v) => (v['risks'] = [{ description: 'r', pnl: -1 }]), /result\.risks\[0\]\.pnl/],
      [
        'conclusion',
        (v) => (v['conclusion'] = { state: 'WAIT', summary: 's', winRate: 0.6 }),
        /result\.conclusion\.winRate/,
      ],
      [
        'engine',
        (v) => (v['engine'] = { id: 'x', version: '1', backtest: { sharpe: 2 } }),
        /result\.engine\.backtest/,
      ],
    ];
    for (const [name, change, expected] of nested) {
      const issues = issuesOf(result(change));
      assert.ok(mentions(issues, expected), `${name}: ${JSON.stringify(issues)}`);
    }
  });

  it('says why: a result may not carry measured-looking opinions', () => {
    const issues = issuesOf(result((v) => (v['confidence'] = 0.93)));
    assert.ok(mentions(issues, /results may not carry measured-looking opinions/));
  });

  it('accepts the words in ordinary text, because only field names are checked', () => {
    const outcome = validateAnalysisResult(
      result(
        (v) =>
          (v['technical'] = {
            summary: 'No confidence is claimed and no win rate exists.',
            evidenceIds: ['E1'],
          }),
      ),
    );
    assert.equal(outcome.ok, true);
  });
});

describe('ELVOID result validation: evidence integrity', () => {
  it('requires every evidence reference to resolve', () => {
    const cases: readonly [string, (v: Record<string, unknown>) => void, RegExp][] = [
      [
        'technical',
        (v) => (v['technical'] = { summary: 's', evidenceIds: ['E9'] }),
        /technical references unknown evidence E9/,
      ],
      [
        'macro',
        (v) => (v['macro'] = { summary: 's', evidenceIds: ['E1', 'E8'] }),
        /macro references unknown evidence E8/,
      ],
      [
        'bullish',
        (v) => (v['bullish'] = { summary: 's', evidenceIds: ['nope'] }),
        /bullish references unknown evidence nope/,
      ],
      [
        'bearish',
        (v) => (v['bearish'] = { summary: 's', evidenceIds: ['nope'] }),
        /bearish references unknown evidence nope/,
      ],
      [
        'invalidation',
        (v) => (v['invalidations'] = [{ description: 'd', evidenceIds: ['E7'] }]),
        /invalidations\[0\] references unknown evidence E7/,
      ],
    ];
    for (const [name, change, expected] of cases) {
      for (const conclusion of CONCLUSION_STATES) {
        const issues = issuesOf(result(change, conclusion));
        assert.ok(mentions(issues, expected), `${name}/${conclusion}: ${JSON.stringify(issues)}`);
      }
    }
  });

  it('rejects two pieces of evidence with the same id', () => {
    const issues = issuesOf(
      result((v) => {
        const [first] = v['evidence'] as Record<string, unknown>[];
        v['evidence'] = [first, { ...first }];
      }),
    );
    assert.ok(mentions(issues, /duplicate evidence id E1/));
  });

  it('never admits evidence that rests on unavailable data', () => {
    for (const conclusion of CONCLUSION_STATES) {
      const issues = issuesOf(
        result((v) => {
          const [first, second] = v['evidence'] as Record<string, unknown>[];
          v['evidence'] = [{ ...first, dataState: 'unavailable' }, second];
        }, conclusion),
      );
      assert.ok(
        mentions(issues, /evidence E1 used unavailable data, which is not admissible/),
        conclusion,
      );
    }
  });
});

describe('ELVOID result validation: what VALIDATED requires', () => {
  const evidenceWith = (v: Record<string, unknown>, patch: Record<string, unknown>[]): void => {
    v['evidence'] = patch;
  };
  const e1 = {
    id: 'E1',
    kind: 'market-data',
    summary: 'price',
    sourceId: 'feed',
    observedAt: FIXTURE_NOW,
    dataState: 'live',
  };
  const e2 = {
    id: 'E2',
    kind: 'macro',
    summary: 'macro',
    sourceId: 'feed',
    observedAt: FIXTURE_NOW,
    dataState: 'delayed',
  };

  it('accepts a result that meets every requirement', () => {
    assert.equal(validateAnalysisResult(result(() => undefined, 'VALIDATED')).ok, true);
  });

  it('refuses stale evidence', () => {
    const issues = issuesOf(
      result((v) => evidenceWith(v, [e1, { ...e2, dataState: 'stale' }]), 'VALIDATED'),
    );
    assert.ok(mentions(issues, /may only rest on live or delayed evidence/));
  });

  it('needs market-data or technical evidence, not macro alone', () => {
    const issues = issuesOf(
      result((v) => {
        evidenceWith(v, [
          { ...e2, id: 'E1' },
          { ...e2, id: 'E2' },
        ]);
      }, 'VALIDATED'),
    );
    assert.ok(mentions(issues, /needs market-data or technical evidence/));
    assert.equal(
      validateAnalysisResult(
        result((v) => evidenceWith(v, [{ ...e1, kind: 'technical' }, e2]), 'VALIDATED'),
      ).ok,
      true,
      'technical evidence satisfies it too',
    );
  });

  it('needs evidence behind both scenarios', () => {
    for (const side of ['bullish', 'bearish']) {
      const issues = issuesOf(
        result((v) => (v[side] = { summary: 's', evidenceIds: [] }), 'VALIDATED'),
      );
      assert.ok(mentions(issues, /needs evidence behind both scenarios/), side);
    }
  });

  it('needs an invalidation condition and a risk factor', () => {
    assert.ok(
      mentions(
        issuesOf(result((v) => (v['invalidations'] = []), 'VALIDATED')),
        /at least one invalidation condition/,
      ),
    );
    assert.ok(
      mentions(issuesOf(result((v) => (v['risks'] = []), 'VALIDATED')), /at least one risk factor/),
    );
  });

  it('asks none of that of WAIT or RESEARCHING, which claim nothing', () => {
    for (const conclusion of ['WAIT', 'RESEARCHING'] as const) {
      const outcome = validateAnalysisResult(
        result((v) => {
          evidenceWith(v, [
            { ...e2, id: 'E1' },
            { ...e2, id: 'E2', dataState: 'stale' },
          ]);
          v['bullish'] = { summary: 's', evidenceIds: [] };
          v['bearish'] = { summary: 's', evidenceIds: [] };
          v['invalidations'] = [];
          v['risks'] = [];
        }, conclusion),
      );
      assert.equal(outcome.ok, true, conclusion);
    }
  });
});

// ---- status ---------------------------------------------------------------------------------

describe('ELVOID status', () => {
  const done = (): AnalysisJob => {
    const outcome = validateAnalysisResult(result());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error('fixture result is invalid');
    return { kind: 'done', result: outcome.value };
  };

  it('is NOT CONFIGURED without an engine, whatever else is true', () => {
    for (const dataState of ['live', 'delayed', 'stale', 'unavailable'] as const) {
      for (const job of [
        { kind: 'idle' },
        { kind: 'running', startedAt: 1 },
        { kind: 'failed', message: 'x' },
        done(),
      ] as AnalysisJob[]) {
        const outcome = deriveAnalysisStatus({ engineConfigured: false, dataState, job });
        assert.equal(outcome.status, 'NOT_CONFIGURED');
        assert.equal(outcome.reason, NOT_CONFIGURED_REASON);
      }
    }
  });

  it('says plainly that nothing is produced or simulated', () => {
    assert.match(NOT_CONFIGURED_REASON, /^No ELVOID engine is connected\./);
    assert.match(NOT_CONFIGURED_REASON, /No analysis is produced and none is simulated\.$/);
  });

  it('reports a failure, a run and a result ahead of the state of the data', () => {
    for (const dataState of ['live', 'stale', 'unavailable'] as const) {
      assert.deepEqual(
        deriveAnalysisStatus({
          engineConfigured: true,
          dataState,
          job: { kind: 'failed', message: 'boom' },
        }),
        {
          status: 'ERROR',
          reason: 'boom',
        },
      );
      assert.equal(
        deriveAnalysisStatus({
          engineConfigured: true,
          dataState,
          job: { kind: 'running', startedAt: 1 },
        }).status,
        'ANALYZING',
      );
      assert.equal(
        deriveAnalysisStatus({ engineConfigured: true, dataState, job: done() }).status,
        'RESULT_AVAILABLE',
      );
    }
  });

  it('waits for data that is stale or unavailable, and says which', () => {
    const stale = deriveAnalysisStatus({
      engineConfigured: true,
      dataState: 'stale',
      job: { kind: 'idle' },
    });
    assert.equal(stale.status, 'WAITING_FOR_DATA');
    assert.match(stale.reason, /stale/);
    const none = deriveAnalysisStatus({
      engineConfigured: true,
      dataState: 'unavailable',
      job: { kind: 'idle' },
    });
    assert.equal(none.status, 'WAITING_FOR_DATA');
    assert.match(none.reason, /No data is available/);
  });

  it('queues an analysis only on live or delayed data', () => {
    for (const dataState of ['live', 'delayed'] as const) {
      assert.equal(
        deriveAnalysisStatus({ engineConfigured: true, dataState, job: { kind: 'idle' } }).status,
        'ANALYZING',
      );
    }
  });
});

// ---- controller -----------------------------------------------------------------------------

describe('ELVOID controller: no engine', () => {
  it('stays NOT CONFIGURED, names no engine, and never starts anything', () => {
    const controller = createAnalysisController(null, () => FIXTURE_NOW);
    const seen: string[] = [];
    controller.store.subscribe((snapshot) => seen.push(snapshot.status));
    controller.select('EURUSD', 'H1', 'live');
    controller.select('GBPUSD', 'M15', 'live');
    controller.retry();
    const snapshot = controller.store.get();
    assert.equal(snapshot.status, 'NOT_CONFIGURED');
    assert.equal(snapshot.engine, null);
    assert.equal(snapshot.result, null);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.requestedAt, null);
    assert.equal(snapshot.reason, NOT_CONFIGURED_REASON);
    assert.equal(snapshot.instrumentId, 'GBPUSD');
    assert.equal(snapshot.timeframe, 'M15');
    assert.ok(seen.every((status) => status === 'NOT_CONFIGURED'));
    controller.dispose();
  });

  it('starts with no selection and still reports NOT CONFIGURED', () => {
    const snapshot = createAnalysisController(null).store.get();
    assert.equal(snapshot.status, 'NOT_CONFIGURED');
    assert.equal(snapshot.result, null);
  });
});

describe('ELVOID controller: with an engine', () => {
  interface Call {
    readonly request: AnalysisRequest;
    readonly signal: AbortSignal;
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }

  function fakeEngine(): { engine: ElvoidEngine; calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      engine: {
        id: 'fixture-engine',
        version: '0.0.0-test',
        analyze: (request, signal) =>
          new Promise((resolve, reject) => {
            calls.push({ request, signal, resolve, reject });
          }),
      },
    };
  }

  const last = (calls: readonly Call[]): Call => {
    const call = calls.at(-1);
    assert.ok(call !== undefined, 'the engine was called');
    return call;
  };

  it('runs on live data, validates what comes back, and shows it', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(last(calls).request, {
      instrumentId: 'EURUSD',
      timeframe: 'H1',
      requestedAt: FIXTURE_NOW,
    });
    assert.equal(controller.store.get().status, 'ANALYZING');
    assert.equal(controller.store.get().requestedAt, FIXTURE_NOW);
    assert.deepEqual(controller.store.get().engine, {
      id: 'fixture-engine',
      version: '0.0.0-test',
    });

    last(calls).resolve(fixtureAnalysisResult(last(calls).request, 'VALIDATED'));
    await tick();
    const snapshot = controller.store.get();
    assert.equal(snapshot.status, 'RESULT_AVAILABLE');
    assert.equal(snapshot.result?.conclusion.state, 'VALIDATED');
    assert.equal(snapshot.error, null);
    controller.dispose();
  });

  it('waits on stale or unavailable data without calling the engine, then runs once the data is eligible', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'unavailable');
    await tick();
    assert.equal(controller.store.get().status, 'WAITING_FOR_DATA');
    controller.select('EURUSD', 'H1', 'stale');
    await tick();
    assert.equal(controller.store.get().status, 'WAITING_FOR_DATA');
    assert.equal(
      calls.length,
      0,
      'the engine is never asked to reason over data that is not eligible',
    );
    controller.select('EURUSD', 'H1', 'delayed');
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(controller.store.get().status, 'ANALYZING');
    controller.dispose();
  });

  it('does not start a second run for the same selection while one is going', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    controller.select('EURUSD', 'H1', 'live');
    controller.select('EURUSD', 'H1', 'delayed');
    await tick();
    assert.equal(calls.length, 1);
    controller.dispose();
  });

  it('keeps a finished result when the data later goes stale, and does not run again', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    last(calls).resolve(fixtureAnalysisResult(last(calls).request, 'WAIT'));
    await tick();
    controller.select('EURUSD', 'H1', 'stale');
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    assert.equal(controller.store.get().status, 'RESULT_AVAILABLE');
    assert.equal(calls.length, 1);
    controller.dispose();
  });

  it('aborts the previous run when the selection changes, and discards its late result', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    const first = last(calls);
    controller.select('GBPUSD', 'H1', 'live');
    await tick();
    assert.equal(first.signal.aborted, true, 'the first run was told to stop');
    assert.equal(calls.length, 2);

    // An engine that ignores the abort and answers anyway must not reach the screen.
    first.resolve(fixtureAnalysisResult(first.request, 'WAIT'));
    await tick();
    assert.equal(controller.store.get().status, 'ANALYZING');
    assert.equal(controller.store.get().result, null);
    assert.equal(controller.store.get().instrumentId, 'GBPUSD');

    const second = last(calls);
    second.resolve(fixtureAnalysisResult(second.request, 'WAIT'));
    await tick();
    assert.equal(controller.store.get().status, 'RESULT_AVAILABLE');
    assert.equal(controller.store.get().result?.instrumentId, 'GBPUSD');
    controller.dispose();
  });

  it('discards a late failure from a superseded run too', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    const first = last(calls);
    controller.select('EURUSD', 'M15', 'live');
    await tick();
    first.reject(new Error('late failure'));
    await tick();
    assert.equal(controller.store.get().status, 'ANALYZING');
    assert.equal(controller.store.get().error, null);
    controller.dispose();
  });

  it('shows ERROR with the first three problems when the engine returns an invalid result', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    last(calls).resolve({ nonsense: true });
    await tick();
    const snapshot = controller.store.get();
    assert.equal(snapshot.status, 'ERROR');
    assert.equal(snapshot.result, null, 'an invalid result is never shown');
    assert.match(snapshot.reason, /^The engine returned a result that failed validation: /);
    assert.equal(snapshot.reason.split('; ').length, 3, 'three problems, not a wall of text');
    assert.equal(snapshot.error, snapshot.reason);
    controller.dispose();
  });

  it('rejects a result that carries a confidence figure, even if it is otherwise valid', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    last(calls).resolve({
      ...fixtureAnalysisResult(last(calls).request, 'VALIDATED'),
      confidence: 0.93,
    });
    await tick();
    assert.equal(controller.store.get().status, 'ERROR');
    assert.equal(controller.store.get().result, null);
    assert.match(controller.store.get().error ?? '', /confidence is not permitted/);
    controller.dispose();
  });

  it('rejects a valid result that is for a different selection', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    last(calls).resolve(
      fixtureAnalysisResult({ ...last(calls).request, instrumentId: 'GBPUSD' }, 'WAIT'),
    );
    await tick();
    assert.equal(controller.store.get().status, 'ERROR');
    assert.equal(
      controller.store.get().error,
      'The engine returned a result for a different selection.',
    );
    controller.dispose();

    const other = fakeEngine();
    const again = createAnalysisController(other.engine, () => FIXTURE_NOW);
    again.select('EURUSD', 'H1', 'live');
    await tick();
    last(other.calls).resolve(
      fixtureAnalysisResult({ ...last(other.calls).request, timeframe: 'D1' }, 'WAIT'),
    );
    await tick();
    assert.equal(
      again.store.get().error,
      'The engine returned a result for a different selection.',
    );
    again.dispose();
  });

  it('shows the engine’s own message on failure, and a plain one when it gives none', async () => {
    const cases: readonly [unknown, string][] = [
      [new Error('upstream refused'), 'upstream refused'],
      ['plain text failure', 'plain text failure'],
      [new Error(''), 'The engine failed without a message.'],
      [undefined, 'The engine failed without a message.'],
      [{ code: 7 }, 'The engine failed without a message.'],
    ];
    for (const [failure, expected] of cases) {
      const { engine, calls } = fakeEngine();
      const controller = createAnalysisController(engine, () => FIXTURE_NOW);
      controller.select('EURUSD', 'H1', 'live');
      await tick();
      last(calls).reject(failure);
      await tick();
      assert.equal(controller.store.get().status, 'ERROR');
      assert.equal(controller.store.get().error, expected);
      controller.dispose();
    }
  });

  it('treats an engine that throws synchronously as a failure, not a crash', async () => {
    const engine: ElvoidEngine = {
      id: 'throws',
      version: '1',
      analyze: () => {
        throw new Error('threw before returning a promise');
      },
    };
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    assert.equal(controller.store.get().status, 'ERROR');
    assert.equal(controller.store.get().error, 'threw before returning a promise');
    controller.dispose();
  });

  it('retries only after a failure, and the retry can succeed', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    controller.retry();
    await tick();
    assert.equal(calls.length, 1, 'retry does nothing while a run is going');

    last(calls).reject(new Error('first try failed'));
    await tick();
    assert.equal(controller.store.get().status, 'ERROR');
    controller.retry();
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(controller.store.get().status, 'ANALYZING');
    assert.equal(controller.store.get().error, null);
    last(calls).resolve(fixtureAnalysisResult(last(calls).request, 'WAIT'));
    await tick();
    assert.equal(controller.store.get().status, 'RESULT_AVAILABLE');
    controller.retry();
    await tick();
    assert.equal(calls.length, 2, 'retry does nothing once there is a result');
    controller.dispose();
  });

  it('ignores a result that arrives after dispose, and aborts the run', async () => {
    const { engine, calls } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    controller.select('EURUSD', 'H1', 'live');
    await tick();
    const run = last(calls);
    controller.dispose();
    assert.equal(run.signal.aborted, true);
    run.resolve(fixtureAnalysisResult(run.request, 'WAIT'));
    await tick();
    assert.equal(controller.store.get().status, 'ANALYZING', 'nothing was published after dispose');
    assert.equal(controller.store.get().result, null);
  });

  it('publishes a change only when something changed', async () => {
    const { engine } = fakeEngine();
    const controller = createAnalysisController(engine, () => FIXTURE_NOW);
    let notifications = 0;
    controller.store.subscribe(() => {
      notifications += 1;
    });
    const base = notifications;
    controller.select('EURUSD', 'H1', 'live');
    const afterFirst = notifications;
    assert.ok(afterFirst > base);
    controller.select('EURUSD', 'H1', 'live');
    controller.select('EURUSD', 'H1', 'live');
    assert.equal(notifications, afterFirst, 'identical input is not re-published');
    controller.dispose();
  });
});

// ---- controlled improvement -----------------------------------------------------------------

describe('ELVOID controlled improvement', () => {
  const person: Actor = { kind: 'human', id: 'reviewer-1' };
  const system: Actor = { kind: 'system' };
  const proposal = (): ChangeProposal =>
    createProposal(
      {
        id: 'chg-1',
        target: 'strategy',
        summary: 'Change a parameter',
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
      },
      system,
      1000,
    );

  function advance(path: readonly [ChangeStage, Actor][], start = proposal()): ChangeProposal {
    let current = start;
    let at = start.history.at(-1)?.at ?? 1000;
    for (const [stage, actor] of path) {
      at += 10;
      const outcome = transition(current, stage, actor, at);
      assert.equal(
        outcome.ok,
        true,
        `${current.stage} -> ${stage}: ${outcome.ok ? '' : outcome.error}`,
      );
      if (outcome.ok) current = outcome.proposal;
    }
    return current;
  }

  it('starts proposed, with its first history entry', () => {
    const created = proposal();
    assert.equal(created.stage, 'proposed');
    assert.deepEqual(created.history, [{ stage: 'proposed', at: 1000, actor: system, note: null }]);
  });

  it('allows exactly proposed, testing, evaluated, approved, released', () => {
    const released = advance([
      ['testing', system],
      ['evaluated', system],
      ['approved', person],
      ['released', person],
    ]);
    assert.equal(released.stage, 'released');
    assert.deepEqual(
      released.history.map((record) => record.stage),
      ['proposed', 'testing', 'evaluated', 'approved', 'released'],
    );
    assert.deepEqual(
      released.history.map((record) => record.actor.kind),
      ['system', 'system', 'system', 'human', 'human'],
    );
  });

  it('allows no other path between stages', () => {
    const allowed: Readonly<Record<ChangeStage, readonly ChangeStage[]>> = {
      proposed: ['testing', 'rejected'],
      testing: ['evaluated', 'rejected'],
      evaluated: ['approved', 'rejected'],
      approved: ['released', 'rejected'],
      rejected: [],
      released: [],
    };
    for (const from of CHANGE_STAGES) {
      for (const to of CHANGE_STAGES) {
        assert.equal(canTransition(from, to), allowed[from].includes(to), `${from} -> ${to}`);
      }
    }
  });

  it('refuses to skip a stage', () => {
    const skips: readonly [ChangeStage[], ChangeStage][] = [
      [[], 'evaluated'],
      [[], 'approved'],
      [[], 'released'],
      [['testing'], 'approved'],
      [['testing'], 'released'],
      [['testing', 'evaluated'], 'released'],
    ];
    for (const [path, target] of skips) {
      const current = advance(path.map((stage) => [stage, system] as [ChangeStage, Actor]));
      const outcome = transition(current, target, person, 5000);
      assert.equal(outcome.ok, false, `${current.stage} -> ${target}`);
      assert.match(
        outcome.ok ? '' : outcome.error,
        new RegExp(`Cannot move a change from ${current.stage} to ${target}`),
      );
    }
  });

  it('lets only a person approve or release', () => {
    const evaluated = advance([
      ['testing', system],
      ['evaluated', system],
    ]);
    const approvedBySystem = transition(evaluated, 'approved', system, 5000);
    assert.equal(approvedBySystem.ok, false);
    assert.match(
      approvedBySystem.ok ? '' : approvedBySystem.error,
      /Only a person can move a change to approved/,
    );

    const approved = advance([['approved', person]], evaluated);
    const releasedBySystem = transition(approved, 'released', system, 5000);
    assert.equal(releasedBySystem.ok, false);
    assert.match(
      releasedBySystem.ok ? '' : releasedBySystem.error,
      /Only a person can move a change to released/,
    );
  });

  it('lets a system reject at any open stage, because rejecting can only reduce risk', () => {
    const stages: readonly [ChangeStage, Actor][][] = [
      [],
      [['testing', system]],
      [
        ['testing', system],
        ['evaluated', system],
      ],
      [
        ['testing', system],
        ['evaluated', system],
        ['approved', person],
      ],
    ];
    for (const path of stages) {
      const current = advance(path);
      const outcome = transition(current, 'rejected', system, 9000, 'not worth the risk');
      assert.equal(outcome.ok, true, current.stage);
      if (outcome.ok) assert.equal(outcome.proposal.history.at(-1)?.note, 'not worth the risk');
    }
  });

  it('treats rejected and released as final', () => {
    const rejected = advance([['rejected', system]]);
    const released = advance([
      ['testing', system],
      ['evaluated', system],
      ['approved', person],
      ['released', person],
    ]);
    for (const final of [rejected, released]) {
      for (const to of CHANGE_STAGES) {
        assert.equal(transition(final, to, person, 99_999).ok, false, `${final.stage} -> ${to}`);
      }
    }
  });

  it('will not release without a recorded human approval, even if the stage says approved', () => {
    const forged: ChangeProposal = {
      ...proposal(),
      stage: 'approved',
      history: [
        { stage: 'proposed', at: 1000, actor: system, note: null },
        { stage: 'approved', at: 1010, actor: system, note: null },
      ],
    };
    const outcome = transition(forged, 'released', person, 2000);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.error, /without a recorded human approval/);
  });

  it('will not date an entry before the one it follows', () => {
    const outcome = transition(proposal(), 'testing', system, 999);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.error, /cannot be dated before the previous one/);
    assert.equal(
      transition(proposal(), 'testing', system, 1000).ok,
      true,
      'the same instant is fine',
    );
  });

  it('never changes the proposal it was given', () => {
    const before = proposal();
    const frozen = JSON.stringify(before);
    const outcome = transition(before, 'testing', system, 2000, 'note');
    assert.equal(JSON.stringify(before), frozen);
    assert.equal(before.history.length, 1);
    assert.equal(outcome.ok && outcome.proposal !== before, true);
    assert.equal(outcome.ok && outcome.proposal.history.length, 2);
  });
});

// ---- the module registry --------------------------------------------------------------------

describe('ELVOID module registry', () => {
  it('names the thirteen modules, once each, in a fixed order', () => {
    assert.deepEqual(
      ELVOID_MODULES.map((module) => module.id),
      [
        'market-data-normalization',
        'technical-analysis',
        'macro-analysis',
        'news-interpretation',
        'cross-asset-relationships',
        'volatility-liquidity',
        'hypothesis-generation',
        'scenario-comparison',
        'backtesting',
        'performance-evaluation',
        'controlled-improvement',
        'decision-logging',
        'notification-events',
      ],
    );
  });

  it('gives every module a purpose, inputs, outputs and error states, before any code exists', () => {
    for (const module of ELVOID_MODULES) {
      assert.ok(module.name.trim() !== '' && module.purpose.trim() !== '', module.id);
      for (const list of [module.inputs, module.outputs, module.errorStates]) {
        assert.ok(list.length >= 1, `${module.id} has an empty list`);
        assert.ok(
          list.every((entry) => entry.trim() !== ''),
          `${module.id} has a blank entry`,
        );
      }
      assert.match(module.id, /^[a-z]+(?:-[a-z]+)*$/, `${module.id} is kebab-case`);
    }
  });

  it('says honestly how far each module goes: one implemented, three contracts, nine nothing', () => {
    const byStatus = (status: ModuleStatus): string[] =>
      ELVOID_MODULES.filter((module) => module.status === status).map((module) => module.id);
    assert.deepEqual(byStatus('implemented'), ['market-data-normalization']);
    assert.deepEqual(byStatus('contract-only'), [
      'volatility-liquidity',
      'scenario-comparison',
      'controlled-improvement',
    ]);
    assert.equal(byStatus('not-implemented').length, 9);
    assert.equal(countImplemented(), 1);
    assert.equal(countImplemented([]), 0);
    for (const status of Object.keys(MODULE_STATUS_LABEL) as ModuleStatus[]) {
      assert.match(MODULE_STATUS_LABEL[status], /^[A-Z ]+$/);
    }
  });

  it('points a contract at files that exist, and only modules that have one', () => {
    for (const module of ELVOID_MODULES) {
      if (module.status === 'not-implemented') {
        assert.equal(
          module.contract,
          null,
          `${module.id}: nothing exists, so no contract is claimed`,
        );
        continue;
      }
      assert.notEqual(module.contract, null, `${module.id} claims a status without a contract`);
      for (const path of (module.contract ?? '').split(',').map((entry) => entry.trim())) {
        assert.ok(existsSync(join(ROOT, path)), `${module.id}: ${path} does not exist`);
      }
    }
  });

  it('does not describe ELVOID as changing itself', () => {
    const everything = JSON.stringify(ELVOID_MODULES);
    assert.doesNotMatch(everything, /self[- ](evolv|improv|learn|modif|optimi)/i);
    const improvement = ELVOID_MODULES.find((module) => module.id === 'controlled-improvement');
    assert.ok(improvement !== undefined);
    assert.match(improvement.purpose, /ELVOID never changes itself/);
    assert.ok(
      improvement.errorStates.some((entry) =>
        /Approval or release by anything other than a person/.test(entry),
      ),
    );
    assert.ok(
      improvement.errorStates.some((entry) => /without a recorded human approval/.test(entry)),
    );
  });

  it('keeps a validation rule behind every contract-only claim about analysis results', () => {
    const scenario = ELVOID_MODULES.find((module) => module.id === 'scenario-comparison');
    assert.ok(scenario !== undefined);
    assert.ok(scenario.errorStates.some((entry) => /unknown evidence/.test(entry)));
    assert.ok(scenario.errorStates.some((entry) => /without invalidation conditions/.test(entry)));
  });
});
