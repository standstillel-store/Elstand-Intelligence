import type { AppContext } from '../../app/context.js';
import { formatAge, formatUtcDateTime, NO_VALUE } from '../../core/format.js';
import { isAnalysisEligible } from '../../core/freshness.js';
import { findInstrument } from '../../core/instruments.js';
import { DATA_STATE_LABEL } from '../../core/freshness.js';
import {
  ANALYSIS_STATUS_LABEL,
  type AnalysisResult,
  type AnalysisStatus,
  type ConclusionState,
  type ContextSection,
  type Evidence,
} from '../../elvoid/contracts.js';
import type { AnalysisSnapshot } from '../../elvoid/controller.js';
import {
  countImplemented,
  ELVOID_MODULES,
  MODULE_STATUS_LABEL,
  type ElvoidModuleSpec,
} from '../../elvoid/modules.js';
import { bind, setAttr, setText } from '../bind.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { ELVOID_PANEL_ID } from '../ids.js';
import { button, createPanel, notice, stateBadge, updateBadge } from '../parts.js';

/** The reasoning workspace's sections, in reading order. */
export const ELVOID_SECTIONS = [
  { key: 'evidence', title: 'Evidence' },
  { key: 'technical', title: 'Technical context' },
  { key: 'macro', title: 'Macro context' },
  { key: 'bullish', title: 'Bullish case' },
  { key: 'bearish', title: 'Bearish case' },
  { key: 'invalidation', title: 'Invalidation' },
  { key: 'risks', title: 'Risks' },
  { key: 'final', title: 'Final state' },
] as const;
type SectionKey = (typeof ELVOID_SECTIONS)[number]['key'];

type Absent = Exclude<AnalysisStatus, 'RESULT_AVAILABLE'>;

/**
 * What an empty section says. Each is a statement of fact about why nothing is there; the
 * status line above the sections carries the explanation, so these stay short.
 */
const ABSENT: Readonly<Record<Absent, string>> = {
  NOT_CONFIGURED: 'Not produced.',
  WAITING_FOR_DATA: 'Not produced. Waiting for data.',
  ANALYZING: 'In progress.',
  ERROR: 'Not produced. The analysis failed.',
};

const NO_CONCLUSION: Readonly<Record<Absent, string>> = {
  NOT_CONFIGURED: 'No conclusion. ELVOID has not run.',
  WAITING_FOR_DATA: 'No conclusion yet.',
  ANALYZING: 'No conclusion yet.',
  ERROR: 'No conclusion.',
};

/** What each final state means in this interface. None of them is a forecast. */
export const CONCLUSION_MEANING: Readonly<Record<ConclusionState, string>> = {
  WAIT: 'ELVOID does not take a view on the evidence it has.',
  RESEARCHING: 'ELVOID is still gathering evidence.',
  VALIDATED:
    'The result passed Elstand’s structure and evidence checks. This is not a forecast and it carries no probability, confidence or return.',
};

function references(ids: readonly string[]): HTMLElement {
  return h('p', {
    class: 'elvoid__refs',
    text: ids.length === 0 ? 'Evidence: none referenced' : `Evidence: ${ids.join(', ')}`,
  });
}

function evidenceItem(item: Evidence): HTMLElement {
  return h(
    'li',
    { class: 'elvoid__item', attrs: { 'data-evidence': item.id } },
    h(
      'div',
      { class: 'elvoid__item-head' },
      h('span', { class: 'elvoid__id', text: item.id }),
      h('span', { class: 'elvoid__kind', text: item.kind }),
      stateBadge(item.dataState),
    ),
    h('p', { text: item.summary }),
    h('p', {
      class: 'elvoid__refs',
      text: `${item.sourceId} · observed ${formatUtcDateTime(item.observedAt)}`,
    }),
  );
}

function contextBlock(section: ContextSection): Child[] {
  return [h('p', { text: section.summary }), references(section.evidenceIds)];
}

function resultSection(key: SectionKey, result: AnalysisResult): Child[] {
  switch (key) {
    case 'evidence':
      return result.evidence.length === 0
        ? [h('p', { class: 'elvoid__absent', text: 'The engine cited no evidence.' })]
        : [h('ul', { class: 'elvoid__list' }, ...result.evidence.map(evidenceItem))];
    case 'technical':
      return contextBlock(result.technical);
    case 'macro':
      return contextBlock(result.macro);
    case 'bullish':
      return contextBlock(result.bullish);
    case 'bearish':
      return contextBlock(result.bearish);
    case 'invalidation':
      return result.invalidations.length === 0
        ? [
            h('p', {
              class: 'elvoid__absent',
              text: 'The engine stated no invalidation condition.',
            }),
          ]
        : [
            h(
              'ul',
              { class: 'elvoid__list' },
              ...result.invalidations.map((condition) =>
                h(
                  'li',
                  { class: 'elvoid__item' },
                  h('p', { text: condition.description }),
                  references(condition.evidenceIds),
                ),
              ),
            ),
          ];
    case 'risks':
      return result.risks.length === 0
        ? [h('p', { class: 'elvoid__absent', text: 'The engine stated no risk factor.' })]
        : [
            h(
              'ul',
              { class: 'elvoid__list' },
              ...result.risks.map((risk) =>
                h('li', { class: 'elvoid__item', text: risk.description }),
              ),
            ),
          ];
    case 'final':
      return [
        h(
          'div',
          { class: 'elvoid__conclusion', attrs: { 'data-state': result.conclusion.state } },
          h('strong', { text: result.conclusion.state }),
          h('span', { text: result.conclusion.summary }),
        ),
        h('p', { class: 'elvoid__refs', text: CONCLUSION_MEANING[result.conclusion.state] }),
      ];
  }
}

function absentSection(key: SectionKey, status: Absent): Child[] {
  const text = key === 'final' ? NO_CONCLUSION[status] : ABSENT[status];
  return [h('p', { class: 'elvoid__absent', text })];
}

function list(items: readonly string[]): HTMLElement {
  return h('ul', {}, ...items.map((item) => h('li', { text: item })));
}

function moduleEntry(spec: ElvoidModuleSpec): HTMLElement {
  return h(
    'details',
    { class: 'module', attrs: { 'data-module': spec.id } },
    h(
      'summary',
      {},
      h('span', { text: spec.name }),
      h('span', {
        class: 'module__status',
        text: MODULE_STATUS_LABEL[spec.status],
        attrs: { 'data-status': spec.status },
      }),
    ),
    h(
      'div',
      { class: 'module__body' },
      h('p', { text: spec.purpose }),
      h(
        'dl',
        {},
        h('dt', { text: 'Takes in' }),
        h('dd', {}, list(spec.inputs)),
        h('dt', { text: 'Puts out' }),
        h('dd', {}, list(spec.outputs)),
        h('dt', { text: 'Refuses or fails on' }),
        h('dd', {}, list(spec.errorStates)),
        h('dt', { text: 'Contract in the repository' }),
        h('dd', { text: spec.contract ?? 'none yet' }),
      ),
    ),
  );
}

function moduleRegistry(): HTMLElement {
  const implemented = countImplemented();
  return h(
    'details',
    { class: 'disclosure', attrs: { 'data-role': 'modules' } },
    h('summary', {
      text: `ELVOID modules · ${implemented} of ${ELVOID_MODULES.length} implemented`,
    }),
    h(
      'div',
      { class: 'disclosure__body' },
      h('p', {
        class: 'modules__intro',
        text:
          'Each module names what it takes in, puts out and refuses before any code exists for it. ' +
          'CONTRACT ONLY means types and validation exist but no analytical logic does. ' +
          'ELVOID does not change itself: a proposed change is tested, evaluated, versioned and ' +
          'approved by a person before it is released.',
      }),
      h('div', { class: 'modules' }, ...ELVOID_MODULES.map(moduleEntry)),
    ),
  );
}

/**
 * The ELVOID reasoning workspace. It always shows one of five explicit states, and it shows
 * an analysis only when an engine returned one that passed validation. With no engine (Phase 1)
 * it says NOT CONFIGURED and every section says that nothing was produced; it never fills a
 * section with an example, and it never shows a confidence, probability, win rate or backtest.
 */
export function createElvoidPanel(ctx: AppContext): View {
  const scope = createScope();
  const panel = createPanel({
    title: 'ELVOID reasoning workspace',
    id: ELVOID_PANEL_ID,
    className: 'elvoid',
  });
  // The header's ELVOID chip moves focus here.
  panel.el.setAttribute('tabindex', '-1');

  const engineMeta = h('span', {});
  panel.meta.append(engineMeta);

  // ---- status -----------------------------------------------------------------------------
  const stateEl = h('span', { class: 'elvoid__state' });
  const reasonEl = h('span', { class: 'elvoid__reason' });
  const status = h(
    'div',
    { class: 'elvoid__status', attrs: { role: 'status' } },
    stateEl,
    reasonEl,
  );
  const retry = button('Retry analysis', () => ctx.elvoid.retry(), { small: true });
  const actions = h('div', { class: 'elvoid__actions' }, retry);

  // ---- facts: instrument, input data, timestamps --------------------------------------------
  const instrumentDd = h('dd', {});
  const inputBadge = stateBadge('unavailable');
  const inputText = h('span', {});
  const inputDd = h('dd', {}, inputBadge, inputText);
  const engineDd = h('dd', {});
  const requestedDd = h('dd', {});
  const requestedText = h('span', {});
  const runningText = h('span', { class: 'mono' });
  requestedDd.append(requestedText, runningText);
  const completedDd = h('dd', {});
  const facts = h(
    'dl',
    { class: 'kv elvoid__facts' },
    h('dt', { text: 'Instrument' }),
    instrumentDd,
    h('dt', { text: 'Input data' }),
    inputDd,
    h('dt', { text: 'Engine' }),
    engineDd,
    h('dt', { text: 'Requested' }),
    requestedDd,
    h('dt', { text: 'Completed' }),
    completedDd,
  );

  const staleHost = h('div', {});

  // ---- sections ---------------------------------------------------------------------------
  const bodies = new Map<SectionKey, HTMLElement>();
  const sections = h(
    'div',
    { class: 'elvoid__sections' },
    ...ELVOID_SECTIONS.map(({ key, title }) => {
      const body = h('div', { class: 'elvoid__section-body' });
      bodies.set(key, body);
      return h(
        'section',
        { class: 'elvoid__section', attrs: { 'data-section': key } },
        h('h3', { class: 'elvoid__section-title', text: title }),
        body,
      );
    }),
  );
  const provenance = h('p', { class: 'elvoid__provenance' });

  panel.body.append(
    h(
      'div',
      { class: 'elvoid__body' },
      status,
      actions,
      facts,
      staleHost,
      sections,
      provenance,
      moduleRegistry(),
    ),
  );

  // ---- rendering --------------------------------------------------------------------------
  let snapshot: AnalysisSnapshot = ctx.elvoid.store.get();
  let staleKey = '';

  function renderStale(): void {
    const state = ctx.selectedState.get();
    const result = snapshot.status === 'RESULT_AVAILABLE' ? snapshot.result : null;
    const key =
      result === null || isAnalysisEligible(state) ? '' : `${state}|${result.completedAt}`;
    if (key === staleKey) return;
    staleKey = key;
    replaceContent(
      staleHost,
      result === null || key === ''
        ? []
        : [
            notice(
              'caution',
              `INPUT DATA NOW ${DATA_STATE_LABEL[state]}`,
              `This result was completed at ${formatUtcDateTime(result.completedAt)}. ` +
                'The selected instrument’s data has changed state since then, so the result may no ' +
                'longer describe the market.',
            ),
          ],
    );
  }

  function renderSnapshot(next: AnalysisSnapshot): void {
    snapshot = next;
    const instrument = findInstrument(next.instrumentId);
    setText(stateEl, ANALYSIS_STATUS_LABEL[next.status]);
    setAttr(stateEl, 'data-status', next.status);
    setText(reasonEl, next.status === 'ERROR' && next.error !== null ? next.error : next.reason);
    retry.hidden = next.status !== 'ERROR';
    actions.hidden = retry.hidden;
    setText(instrumentDd, `${instrument?.symbol ?? next.instrumentId} · ${next.timeframe}`);
    setText(
      engineDd,
      next.engine === null ? 'none connected' : `${next.engine.id} v${next.engine.version}`,
    );
    setText(engineMeta, next.engine === null ? 'no engine connected' : `engine ${next.engine.id}`);
    setText(
      requestedText,
      next.requestedAt === null ? NO_VALUE : formatUtcDateTime(next.requestedAt),
    );
    setText(
      completedDd,
      next.result === null ? NO_VALUE : formatUtcDateTime(next.result.completedAt),
    );

    for (const { key } of ELVOID_SECTIONS) {
      const body = bodies.get(key);
      if (body === undefined) continue;
      replaceContent(
        body,
        next.status === 'RESULT_AVAILABLE' && next.result !== null
          ? resultSection(key, next.result)
          : absentSection(key, next.status === 'RESULT_AVAILABLE' ? 'ERROR' : next.status),
      );
    }

    provenance.hidden = next.result === null;
    setText(
      provenance,
      next.result === null
        ? ''
        : `analysis ${next.result.id} · engine ${next.result.engine.id} v${next.result.engine.version}`,
    );
    renderStale();
    renderRunning(ctx.now.get());
  }

  function renderRunning(now: number): void {
    setText(
      runningText,
      snapshot.status === 'ANALYZING' && snapshot.requestedAt !== null
        ? ` · running ${formatAge(Math.max(0, now - snapshot.requestedAt))}`
        : '',
    );
  }

  bind(scope, ctx.elvoid.store, renderSnapshot);
  bind(scope, ctx.selectedState, (state) => {
    updateBadge(inputBadge, state);
    setText(inputText, ` ${DATA_STATE_LABEL[state]}`);
    renderStale();
  });
  bind(scope, ctx.now, renderRunning);

  return { el: panel.el, dispose: () => scope.dispose() };
}
