import { findInstrument } from '../core/instruments.js';
import { isTimeframe, type DataState } from '../core/types.js';
import {
  CONCLUSION_STATES,
  EVIDENCE_KINDS,
  type AnalysisResult,
  type ConclusionState,
  type ContextSection,
  type Evidence,
  type EvidenceKind,
  type InvalidationCondition,
  type RiskFactor,
  type Scenario,
} from './contracts.js';

export type ValidationOutcome =
  | { readonly ok: true; readonly value: AnalysisResult }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Field names that would present an opinion as a measured quantity. Phase 1 has no engine
 * that could compute them honestly, so a result carrying any of them is rejected.
 */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'confidence',
  'probability',
  'winrate',
  'hitrate',
  'accuracy',
  'expectedreturn',
  'expectedprofit',
  'profitprojection',
  'backtest',
  'backtestresult',
  'sharpe',
  'sharperatio',
  'pnl',
]);

const DATA_STATES: readonly DataState[] = ['live', 'delayed', 'stale', 'unavailable'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findForbiddenFields(value: unknown, path: string, found: string[], depth = 0): void {
  if (depth > 8 || typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      findForbiddenFields(child, `${path}[${index}]`, found, depth + 1),
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase().replace(/[^a-z]/g, '')))
      found.push(`${path}.${key}`);
    findForbiddenFields(child, `${path}.${key}`, found, depth + 1);
  }
}

class Reader {
  readonly issues: string[] = [];

  string(source: Record<string, unknown>, key: string, path: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim() === '') {
      this.issues.push(`${path}${key} must be a non-empty string`);
      return '';
    }
    return value;
  }

  number(source: Record<string, unknown>, key: string, path: string): number {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.issues.push(`${path}${key} must be a finite number`);
      return Number.NaN;
    }
    return value;
  }

  record(source: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
    const value = source[key];
    if (!isRecord(value)) {
      this.issues.push(`${path}${key} must be an object`);
      return {};
    }
    return value;
  }

  array(source: Record<string, unknown>, key: string, path: string): readonly unknown[] {
    const value = source[key];
    if (!Array.isArray(value)) {
      this.issues.push(`${path}${key} must be an array`);
      return [];
    }
    return value;
  }

  stringArray(source: Record<string, unknown>, key: string, path: string): readonly string[] {
    const list = this.array(source, key, path);
    const strings: string[] = [];
    list.forEach((item, index) => {
      if (typeof item === 'string' && item !== '') strings.push(item);
      else this.issues.push(`${path}${key}[${index}] must be a non-empty string`);
    });
    return strings;
  }

  oneOf<T extends string>(
    source: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
    path: string,
  ): T | null {
    const value = source[key];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
      return value as T;
    this.issues.push(`${path}${key} must be one of: ${allowed.join(', ')}`);
    return null;
  }
}

function readEvidence(reader: Reader, list: readonly unknown[]): Evidence[] {
  const evidence: Evidence[] = [];
  list.forEach((item, index) => {
    const path = `evidence[${index}].`;
    if (!isRecord(item)) {
      reader.issues.push(`evidence[${index}] must be an object`);
      return;
    }
    const kind = reader.oneOf<EvidenceKind>(item, 'kind', EVIDENCE_KINDS, path);
    const dataState = reader.oneOf<DataState>(item, 'dataState', DATA_STATES, path);
    const entry = {
      id: reader.string(item, 'id', path),
      summary: reader.string(item, 'summary', path),
      sourceId: reader.string(item, 'sourceId', path),
      observedAt: reader.number(item, 'observedAt', path),
    };
    if (kind !== null && dataState !== null) evidence.push({ ...entry, kind, dataState });
  });
  return evidence;
}

function readContext(reader: Reader, source: Record<string, unknown>, key: string): ContextSection {
  const section = reader.record(source, key, '');
  return {
    summary: reader.string(section, 'summary', `${key}.`),
    evidenceIds: reader.stringArray(section, 'evidenceIds', `${key}.`),
  };
}

function readScenario(reader: Reader, source: Record<string, unknown>, key: string): Scenario {
  return readContext(reader, source, key);
}

function readInvalidations(reader: Reader, list: readonly unknown[]): InvalidationCondition[] {
  const conditions: InvalidationCondition[] = [];
  list.forEach((item, index) => {
    const path = `invalidations[${index}].`;
    if (!isRecord(item)) {
      reader.issues.push(`invalidations[${index}] must be an object`);
      return;
    }
    conditions.push({
      description: reader.string(item, 'description', path),
      evidenceIds: reader.stringArray(item, 'evidenceIds', path),
    });
  });
  return conditions;
}

function readRisks(reader: Reader, list: readonly unknown[]): RiskFactor[] {
  const risks: RiskFactor[] = [];
  list.forEach((item, index) => {
    const path = `risks[${index}].`;
    if (!isRecord(item)) {
      reader.issues.push(`risks[${index}] must be an object`);
      return;
    }
    risks.push({ description: reader.string(item, 'description', path) });
  });
  return risks;
}

/**
 * Checks everything an ELVOID engine returns before the UI may present it. Structure first,
 * then the integrity rules that make a conclusion more than a sentence:
 *
 * - every evidence reference resolves, and evidence ids are unique;
 * - unavailable data is never admissible as evidence;
 * - VALIDATED requires live or delayed evidence including market data or technical
 *   evidence, support for both scenarios, at least one invalidation condition and at least
 *   one risk factor.
 */
export function validateAnalysisResult(input: unknown): ValidationOutcome {
  if (!isRecord(input)) return { ok: false, issues: ['result must be an object'] };

  const reader = new Reader();
  const forbidden: string[] = [];
  findForbiddenFields(input, 'result', forbidden);
  for (const field of forbidden) {
    reader.issues.push(
      `${field} is not permitted: results may not carry measured-looking opinions`,
    );
  }

  const id = reader.string(input, 'id', '');
  const engineRecord = reader.record(input, 'engine', '');
  const engine = {
    id: reader.string(engineRecord, 'id', 'engine.'),
    version: reader.string(engineRecord, 'version', 'engine.'),
  };
  const instrumentId = reader.string(input, 'instrumentId', '');
  if (instrumentId !== '' && findInstrument(instrumentId) === undefined) {
    reader.issues.push(`instrumentId ${instrumentId} is not a known instrument`);
  }
  const timeframeValue = input['timeframe'];
  const timeframe = isTimeframe(timeframeValue) ? timeframeValue : null;
  if (timeframe === null) reader.issues.push('timeframe must be one of M5, M15, M30, H1, H4, D1');

  const requestedAt = reader.number(input, 'requestedAt', '');
  const completedAt = reader.number(input, 'completedAt', '');
  if (completedAt < requestedAt) reader.issues.push('completedAt is earlier than requestedAt');

  const evidence = readEvidence(reader, reader.array(input, 'evidence', ''));
  const technical = readContext(reader, input, 'technical');
  const macro = readContext(reader, input, 'macro');
  const bullish = readScenario(reader, input, 'bullish');
  const bearish = readScenario(reader, input, 'bearish');
  const invalidations = readInvalidations(reader, reader.array(input, 'invalidations', ''));
  const risks = readRisks(reader, reader.array(input, 'risks', ''));

  const conclusionRecord = reader.record(input, 'conclusion', '');
  const conclusionState = reader.oneOf<ConclusionState>(
    conclusionRecord,
    'state',
    CONCLUSION_STATES,
    'conclusion.',
  );
  const conclusionSummary = reader.string(conclusionRecord, 'summary', 'conclusion.');

  const ids = new Set<string>();
  for (const item of evidence) {
    if (ids.has(item.id)) reader.issues.push(`duplicate evidence id ${item.id}`);
    ids.add(item.id);
    if (item.dataState === 'unavailable') {
      reader.issues.push(
        `evidence ${item.id} used ${item.dataState} data, which is not admissible`,
      );
    }
  }
  const references: readonly (readonly [string, readonly string[]])[] = [
    ['technical', technical.evidenceIds],
    ['macro', macro.evidenceIds],
    ['bullish', bullish.evidenceIds],
    ['bearish', bearish.evidenceIds],
    ...invalidations.map(
      (condition, index) => [`invalidations[${index}]`, condition.evidenceIds] as const,
    ),
  ];
  for (const [owner, referenced] of references) {
    for (const evidenceId of referenced) {
      if (!ids.has(evidenceId))
        reader.issues.push(`${owner} references unknown evidence ${evidenceId}`);
    }
  }

  if (conclusionState === 'VALIDATED') {
    if (evidence.some((item) => item.dataState !== 'live' && item.dataState !== 'delayed')) {
      reader.issues.push('a VALIDATED conclusion may only rest on live or delayed evidence');
    }
    if (!evidence.some((item) => item.kind === 'market-data' || item.kind === 'technical')) {
      reader.issues.push('a VALIDATED conclusion needs market-data or technical evidence');
    }
    if (bullish.evidenceIds.length === 0 || bearish.evidenceIds.length === 0) {
      reader.issues.push('a VALIDATED conclusion needs evidence behind both scenarios');
    }
    if (invalidations.length === 0) {
      reader.issues.push('a VALIDATED conclusion needs at least one invalidation condition');
    }
    if (risks.length === 0)
      reader.issues.push('a VALIDATED conclusion needs at least one risk factor');
  }

  if (reader.issues.length > 0 || timeframe === null || conclusionState === null) {
    return { ok: false, issues: reader.issues };
  }
  return {
    ok: true,
    value: {
      id,
      engine,
      instrumentId,
      timeframe,
      requestedAt,
      completedAt,
      evidence,
      technical,
      macro,
      bullish,
      bearish,
      invalidations,
      risks,
      conclusion: { state: conclusionState, summary: conclusionSummary },
    },
  };
}
