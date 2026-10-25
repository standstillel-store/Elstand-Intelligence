/**
 * Controlled improvement.
 *
 * ELVOID does not rewrite itself. "Improvement" means a change is proposed, tested,
 * evaluated, versioned and approved by a person, in that order, with every step recorded.
 * This module is the guard for that lifecycle: it makes the unsafe paths unrepresentable
 * (skipping a stage, approving or releasing without a human, changing a rejected proposal).
 * It applies nothing to production by itself; releasing is a recorded decision, not a deploy.
 */

export const CHANGE_STAGES = [
  'proposed',
  'testing',
  'evaluated',
  'approved',
  'rejected',
  'released',
] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];

export type ChangeTarget = 'strategy' | 'parameters' | 'prompt' | 'application-code';

export type Actor = { readonly kind: 'human'; readonly id: string } | { readonly kind: 'system' };

export interface StageRecord {
  readonly stage: ChangeStage;
  readonly at: number;
  readonly actor: Actor;
  readonly note: string | null;
}

export interface ChangeProposal {
  readonly id: string;
  readonly target: ChangeTarget;
  readonly summary: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly stage: ChangeStage;
  /** Append-only. Never reordered or edited. */
  readonly history: readonly StageRecord[];
}

export type TransitionResult =
  | { readonly ok: true; readonly proposal: ChangeProposal }
  | { readonly ok: false; readonly error: string };

const ALLOWED_NEXT: Readonly<Record<ChangeStage, readonly ChangeStage[]>> = {
  proposed: ['testing', 'rejected'],
  testing: ['evaluated', 'rejected'],
  evaluated: ['approved', 'rejected'],
  approved: ['released', 'rejected'],
  rejected: [],
  released: [],
};

/** Only a person may approve or release. A system may reject, which can only reduce risk. */
const HUMAN_ONLY: ReadonlySet<ChangeStage> = new Set<ChangeStage>(['approved', 'released']);

export function canTransition(from: ChangeStage, to: ChangeStage): boolean {
  return ALLOWED_NEXT[from].includes(to);
}

export interface NewProposal {
  readonly id: string;
  readonly target: ChangeTarget;
  readonly summary: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

export function createProposal(input: NewProposal, actor: Actor, at: number): ChangeProposal {
  return {
    ...input,
    stage: 'proposed',
    history: [{ stage: 'proposed', at, actor, note: null }],
  };
}

export function transition(
  proposal: ChangeProposal,
  to: ChangeStage,
  actor: Actor,
  at: number,
  note: string | null = null,
): TransitionResult {
  if (!canTransition(proposal.stage, to)) {
    return { ok: false, error: `Cannot move a change from ${proposal.stage} to ${to}.` };
  }
  if (HUMAN_ONLY.has(to) && actor.kind !== 'human') {
    return { ok: false, error: `Only a person can move a change to ${to}.` };
  }
  if (
    to === 'released' &&
    !proposal.history.some((record) => record.stage === 'approved' && record.actor.kind === 'human')
  ) {
    return { ok: false, error: 'A change cannot be released without a recorded human approval.' };
  }
  if (at < (proposal.history.at(-1)?.at ?? Number.NEGATIVE_INFINITY)) {
    return { ok: false, error: 'A history entry cannot be dated before the previous one.' };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      stage: to,
      history: [...proposal.history, { stage: to, at, actor, note }],
    },
  };
}
