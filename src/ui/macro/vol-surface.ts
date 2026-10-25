import type { AppContext } from '../../app/context.js';
import { formatAge, formatUtcDateTime } from '../../core/format.js';
import { classifyFreshness } from '../../core/freshness.js';
import {
  findInstrument,
  INSTRUMENTS,
  requireInstrument,
  type Instrument,
} from '../../core/instruments.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import {
  SURFACE_STALE_AFTER_MS,
  validateVolSurfaceFor,
  volRange,
  type VolSurface,
  type VolSurfaceResult,
} from '../../data/options.js';
import { bind, setText } from '../bind.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { button, createPanel, notice, stateBadge, updateBadge } from '../parts.js';
import type { ExpirySpacing } from './projection.js';
import { rampGradient } from './ramp.js';
import { failedBlock, loadingNotice, noSourceBlock } from './states.js';
import { formatStrike } from './surface-render.js';
import { createSurfaceView } from './surface-view.js';

const HELP_ID = 'surface-help';
const ZOOM_STEP = 1.25;

const SPACING_LABEL: Readonly<Record<ExpirySpacing, string>> = {
  calendar: 'Calendar days',
  equal: 'Equal steps',
};

const STRIKE_KIND_LABEL = {
  'log-moneyness': 'log-moneyness, ln(K/F)',
  'strike-over-forward': 'strike over forward, K/F',
  delta: 'delta',
} as const;

function specEntry(term: string, description: string): Child[] {
  return [h('dt', { text: term }), h('dd', { text: description })];
}

/** What the chart encodes, shown whether or not data is present, so the picture is never ambiguous. */
function encodingSpec(): HTMLElement {
  return h(
    'dl',
    { class: 'spec' },
    ...specEntry(
      'Axes',
      'Left to right: the strike axis, whose kind is stated in the facts above. Front to back: days to expiry, shortest at the front. Up: implied volatility in percent.',
    ),
    ...specEntry(
      'Height and color',
      'Both show implied volatility. Color runs from the lowest value on this surface (dark) to the highest (light), and the two ends are printed under the chart.',
    ),
    ...specEntry(
      'Vertical axis',
      'It spans this surface’s own range, rounded outward, and does not start at zero. Heights compare points on this surface only.',
    ),
    ...specEntry(
      'Mesh',
      'Each facet joins four measured points. Nothing is smoothed, interpolated or extrapolated, so the surface exists only where the source supplied a value.',
    ),
    ...specEntry(
      'Expiry spacing',
      'Calendar days places each expiry by its true time to expiry. Equal steps gives each listed expiry one step, which spreads short expiries apart.',
    ),
    ...specEntry(
      'FX convention',
      'FX options are quoted by delta, not strike. The strike axis kind states what the axis holds; the source’s delta-to-strike convention applies to any converted axis.',
    ),
  );
}

function buildTable(surface: VolSurface): HTMLElement {
  const head = h(
    'tr',
    {},
    h('th', { text: 'Days to expiry', attrs: { scope: 'col' } }),
    ...surface.strikeAxis.values.map((strike) =>
      h('th', { class: 'num', text: formatStrike(strike), attrs: { scope: 'col' } }),
    ),
  );
  const rows = surface.expiriesDays.map((days, row) =>
    h(
      'tr',
      {},
      h('th', { text: String(days), attrs: { scope: 'row' } }),
      ...(surface.iv[row] ?? []).map((value) => h('td', { class: 'num', text: value.toFixed(2) })),
    ),
  );
  return h(
    'div',
    { class: 'scroll-y' },
    h(
      'table',
      { class: 'tbl' },
      h('caption', {
        class: 'visually-hidden',
        text: `Implied volatility in percent by expiry and ${surface.strikeAxis.label}`,
      }),
      h('thead', {}, head),
      h('tbody', {}, ...rows),
    ),
  );
}

/**
 * The implied-volatility module: a real 3D surface, drawn only from a validated surface that a
 * connected options provider returned. With no provider it says ENV NOT CONNECTION and why.
 */
export function createVolSurfaceModule(ctx: AppContext): View {
  const scope = createScope();
  const win = ctx.window;
  const panel = createPanel({ title: 'Implied volatility surface', id: 'vol-surface-panel' });

  const resource = createKeyedResource<VolSurfaceResult>(
    (instrumentId, signal) => ctx.macro.surface.getSurface(instrumentId, signal),
    () => ctx.now.get(),
  );
  let underlying = ctx.selection.get().instrumentId;
  let spacing: ExpirySpacing = 'calendar';
  let shown: VolSurface | null = null;
  let shownMode: 'live' | 'delayed' = 'delayed';
  let stopLoad: (() => void) | null = null;

  // ---- panel meta ---------------------------------------------------------------------------
  const sourceMeta = h('span', {});
  const badge = stateBadge('unavailable');
  badge.hidden = true;
  panel.meta.append(sourceMeta, badge);

  // ---- controls -----------------------------------------------------------------------------
  const select = h(
    'select',
    { attrs: { id: 'surface-underlying' } },
    ...INSTRUMENTS.map((instrument) =>
      h('option', { text: instrument.symbol, attrs: { value: instrument.id } }),
    ),
  );
  select.value = underlying;
  select.addEventListener('change', () => choose(select.value));
  const field = h(
    'label',
    { class: 'field', attrs: { for: 'surface-underlying' } },
    'Underlying',
    select,
  );

  const view = createSurfaceView(win, HELP_ID);
  scope.add(() => view.dispose());

  const spacingButtons = (Object.keys(SPACING_LABEL) as ExpirySpacing[]).map((value) =>
    h('button', {
      class: 'seg__btn',
      text: SPACING_LABEL[value],
      attrs: { type: 'button', 'aria-pressed': value === spacing, 'data-spacing': value },
      on: { click: () => setSpacing(value) },
    }),
  );
  const spacingGroup = h(
    'div',
    { class: 'seg', attrs: { role: 'group', 'aria-label': 'Expiry spacing' } },
    ...spacingButtons,
  );
  const resetButton = button('Reset view', () => view.resetView(), { small: true });
  const zoomOut = button('−', () => view.zoom(1 / ZOOM_STEP), { small: true, title: 'Zoom out' });
  zoomOut.setAttribute('aria-label', 'Zoom out');
  const zoomIn = button('+', () => view.zoom(ZOOM_STEP), { small: true, title: 'Zoom in' });
  zoomIn.setAttribute('aria-label', 'Zoom in');
  const viewButtons = [resetButton, zoomOut, zoomIn];
  const controls = h(
    'div',
    { class: 'macro__controls' },
    field,
    spacingGroup,
    h('div', { class: 'macro__controls-end' }, ...viewButtons),
  );

  // ---- state and plot -------------------------------------------------------------------------
  const stateHost = h('div', { class: 'macro__state' });
  const factsHost = h('div', {});
  const ageText = h('span', { class: 'mono' });
  const staleHost = h('div', {});
  const legendHost = h('div', {});
  const tableHost = h('div', {});
  const tableDetails = h(
    'details',
    { class: 'disclosure' },
    h('summary', { text: 'Data table · every implied volatility on the surface' }),
    h('div', { class: 'disclosure__body' }, tableHost),
  );
  const help = h('p', {
    class: 'macro__help',
    attrs: { id: HELP_ID },
    text:
      'Drag to rotate · Ctrl + wheel or pinch to zoom · double-click to reset · focus the chart, then ' +
      '← → ↑ ↓ rotate, + − zoom, 0 resets · point at a vertex to read it.',
  });
  const plotHost = h(
    'div',
    { class: 'macro__plot' },
    factsHost,
    staleHost,
    view.el,
    legendHost,
    help,
    tableDetails,
  );
  plotHost.hidden = true;

  panel.body.append(
    h('div', { class: 'macro__body' }, controls, stateHost, plotHost, encodingSpec()),
  );

  function enableViewControls(enabled: boolean): void {
    for (const control of viewButtons) control.disabled = !enabled;
    for (const control of spacingButtons) control.disabled = !enabled;
  }
  enableViewControls(false);

  // ---- behaviour ------------------------------------------------------------------------------
  function setSpacing(next: ExpirySpacing): void {
    spacing = next;
    for (const control of spacingButtons) {
      control.setAttribute('aria-pressed', String(control.getAttribute('data-spacing') === next));
    }
    view.setSpacing(next);
  }

  function updateFreshness(now: number): void {
    if (shown === null) return;
    const state = classifyFreshness({
      mode: shownMode,
      asOf: shown.asOf,
      now,
      staleAfterMs: SURFACE_STALE_AFTER_MS[shownMode],
    });
    updateBadge(badge, state);
    staleHost.hidden = state !== 'stale';
    setText(ageText, formatAge(Math.max(0, now - shown.asOf)));
  }

  function showSurface(surface: VolSurface, mode: 'live' | 'delayed'): void {
    const range = volRange(surface);
    shown = surface;
    shownMode = mode;
    replaceContent(stateHost, []);
    stateHost.hidden = true;
    plotHost.hidden = false;
    replaceContent(factsHost, [
      h(
        'dl',
        { class: 'kv macro__facts' },
        h('dt', { text: 'Underlying' }),
        h('dd', { text: findInstrument(surface.instrumentId)?.symbol ?? surface.instrumentId }),
        h('dt', { text: 'Source' }),
        h('dd', { text: surface.source }),
        h('dt', { text: 'Observed' }),
        h('dd', {}, formatUtcDateTime(surface.asOf), ' · ', ageText, ' ago'),
        h('dt', { text: 'Strike axis' }),
        h('dd', {
          text: `${STRIKE_KIND_LABEL[surface.strikeAxis.kind]} · ${surface.strikeAxis.label}`,
        }),
        h('dt', { text: 'Grid' }),
        h('dd', {
          text: `${surface.expiriesDays.length} expiries (${surface.expiriesDays[0]}–${surface.expiriesDays[surface.expiriesDays.length - 1]} days) by ${surface.strikeAxis.values.length} points`,
        }),
      ),
    ]);
    replaceContent(staleHost, [
      notice(
        'caution',
        'STALE',
        'This surface is older than the freshness limit for its feed. Do not treat it as current.',
      ),
    ]);
    const bar = h('span', { class: 'scale__bar', attrs: { 'aria-hidden': 'true' } });
    bar.style.setProperty('background', rampGradient());
    replaceContent(legendHost, [
      h(
        'div',
        { class: 'scale' },
        h('span', { text: `${range.min.toFixed(2)}%` }),
        bar,
        h('span', { text: `${range.max.toFixed(2)}%` }),
        h('span', { text: 'implied volatility on this surface' }),
      ),
    ]);
    tableDetails.open = false;
    replaceContent(tableHost, []);
    view.show(surface);
    badge.hidden = false;
    setText(sourceMeta, surface.source);
    enableViewControls(true);
    updateFreshness(ctx.now.get());
  }

  function clearSurface(): void {
    shown = null;
    plotHost.hidden = true;
    badge.hidden = true;
    setText(sourceMeta, '');
    enableViewControls(false);
    view.show(null);
  }

  function showState(children: readonly Child[]): void {
    clearSurface();
    replaceContent(stateHost, children);
    stateHost.hidden = false;
  }

  tableDetails.addEventListener('toggle', () => {
    if (tableDetails.open && shown !== null && tableHost.childNodes.length === 0) {
      replaceContent(tableHost, [buildTable(shown)]);
    }
  });

  function render(state: Loadable<VolSurfaceResult>, instrument: Instrument): void {
    switch (state.status) {
      case 'idle':
      case 'loading':
        showState([loadingNotice(`Loading the volatility surface for ${instrument.symbol}…`)]);
        return;
      case 'error':
        showState([
          failedBlock('SURFACE FAILED', state.message, () => resource.reload(underlying)),
        ]);
        return;
      case 'ready': {
        const result = state.value;
        if (result.status === 'unavailable') {
          showState([noSourceBlock('An options-data provider', result.reason)]);
          return;
        }
        const issues = validateVolSurfaceFor(result.surface, instrument.id);
        if (issues.length > 0) {
          showState([
            notice(
              'down',
              'SURFACE REJECTED',
              `The provider returned a surface that failed validation: ${issues[0] ?? 'unknown problem'}. It is not drawn.`,
            ),
          ]);
          return;
        }
        showSurface(result.surface, result.mode);
      }
    }
  }

  function choose(instrumentId: string): void {
    underlying = instrumentId;
    stopLoad?.();
    const store = resource.store(instrumentId);
    const instrument = requireInstrument(instrumentId);
    stopLoad = store.subscribe((state) => render(state, instrument));
    resource.ensure(instrumentId);
    render(store.get(), instrument);
  }
  scope.add(() => stopLoad?.());

  bind(scope, ctx.now, updateFreshness);
  choose(underlying);

  return { el: panel.el, dispose: () => scope.dispose() };
}
