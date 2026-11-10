import { DATA_STATE_DESCRIPTION } from '../core/freshness.js';
import { ENV_NOT_CONNECTED } from '../core/connection-text.js';
import { formatUtcDate, formatUtcTime } from '../core/format.js';
import { findInstrument } from '../core/instruments.js';
import { derived } from '../core/store.js';
import { ANALYSIS_STATUS_LABEL, type AnalysisStatus } from '../elvoid/contracts.js';
import type { AppContext } from '../app/context.js';
import { formatRoute, MACRO_TABS, type MacroTab } from '../app/router.js';
import { bind, setAttr, setText } from './bind.js';
import { createScope, h, replaceContent, svg, type View } from './dom.js';
import { ELVOID_PANEL_ID } from './ids.js';
import { stateBadge, updateBadge } from './parts.js';

export interface Shell extends View {
  /** The element pages mount into. */
  readonly main: HTMLElement;
}

function brandMark(): SVGElement {
  return svg(
    'svg',
    { class: 'brand__mark', viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { x: 7, y: 7, width: 18, height: 3.5, class: 'brand__bar-a' }),
    svg('rect', { x: 7, y: 14.25, width: 12, height: 3.5, class: 'brand__bar-b' }),
    svg('rect', { x: 7, y: 21.5, width: 18, height: 3.5, class: 'brand__bar-a' }),
  );
}

type Tone = 'default' | 'selected' | 'caution' | 'down';

const ELVOID_TONE: Readonly<Record<AnalysisStatus, Tone>> = {
  NOT_CONFIGURED: 'caution',
  WAITING_FOR_DATA: 'caution',
  ANALYZING: 'default',
  RESULT_AVAILABLE: 'selected',
  ERROR: 'down',
};

export function createShell(ctx: AppContext): Shell {
  const scope = createScope();

  // ---- navigation ---------------------------------------------------------------------
  const forexLink = h('a', { class: 'nav__link', text: 'Forex Intelligence' });
  const macroLink = h('a', { class: 'nav__link', text: 'Macro Intelligence' });
  let lastMacroTab: MacroTab = MACRO_TABS[0];
  const nav = h('nav', { class: 'nav', attrs: { 'aria-label': 'Primary' } }, forexLink, macroLink);

  const navState = derived([ctx.route, ctx.selection], (route, selection) => ({
    route,
    selection,
  }));
  scope.add(() => navState.dispose());
  bind(scope, navState, ({ route, selection }) => {
    if (route.page === 'macro') lastMacroTab = route.tab;
    forexLink.setAttribute(
      'href',
      formatRoute({
        page: 'forex',
        instrumentId: selection.instrumentId,
        timeframe: selection.timeframe,
      }),
    );
    macroLink.setAttribute('href', formatRoute({ page: 'macro', tab: lastMacroTab }));
    setAttr(forexLink, 'aria-current', route.page === 'forex' ? 'page' : null);
    setAttr(macroLink, 'aria-current', route.page === 'macro' ? 'page' : null);
  });

  // ---- chips --------------------------------------------------------------------------
  const elvoidValue = h('span', { class: 'chip__value' });
  const elvoidChip = h(
    'button',
    {
      class: 'chip',
      attrs: { type: 'button', title: 'Go to the ELVOID reasoning workspace' },
      on: {
        click: () => {
          if (ctx.route.get().page !== 'forex') {
            const selection = ctx.selection.get();
            ctx.navigate({
              page: 'forex',
              instrumentId: selection.instrumentId,
              timeframe: selection.timeframe,
            });
          }
          ctx.window.requestAnimationFrame(() => {
            const panel = ctx.window.document.getElementById(ELVOID_PANEL_ID);
            panel?.scrollIntoView({ block: 'start' });
            panel?.focus({ preventScroll: true });
          });
        },
      },
    },
    h('span', { class: 'chip__label', text: 'ELVOID' }),
    elvoidValue,
  );
  bind(scope, ctx.elvoid.store, (snapshot) => {
    setText(elvoidValue, ANALYSIS_STATUS_LABEL[snapshot.status]);
    setAttr(elvoidValue, 'data-tone', ELVOID_TONE[snapshot.status]);
  });

  const instrumentValue = h('span', { class: 'chip__value', attrs: { 'data-tone': 'selected' } });
  const instrumentChip = h(
    'a',
    { class: 'chip', attrs: { title: 'Open the selected instrument' } },
    h('span', { class: 'chip__label', text: 'INSTRUMENT' }),
    instrumentValue,
  );
  bind(scope, ctx.selection, (selection) => {
    const instrument = findInstrument(selection.instrumentId);
    setText(
      instrumentValue,
      `${instrument?.symbol ?? selection.instrumentId} · ${selection.timeframe}`,
    );
    instrumentChip.setAttribute('href', formatRoute({ page: 'forex', ...selection }));
  });
  bind(scope, ctx.route, (route) =>
    setAttr(instrumentChip, 'aria-current', route.page === 'forex' ? 'page' : null),
  );

  const sourceValue = h('span', { class: 'chip__value' });
  const sourceBadge = stateBadge('unavailable');
  const sourceChip = h(
    'div',
    { class: 'chip', attrs: { role: 'group', 'aria-label': 'Data source status' } },
    h('span', { class: 'chip__label', text: 'SOURCE' }),
    sourceValue,
    sourceBadge,
  );
  const sourceState = derived([ctx.connection.state, ctx.selectedQuote], (connection, quote) => ({
    connection,
    quote,
  }));
  scope.add(() => sourceState.dispose());
  bind(scope, sourceState, ({ connection, quote }) => {
    switch (connection.status) {
      case 'checking':
        setText(sourceValue, 'CHECKING…');
        setAttr(sourceValue, 'data-tone', null);
        sourceBadge.hidden = true;
        setAttr(sourceChip, 'title', 'Asking the Elstand server which data source is connected.');
        return;
      case 'not-connected':
        setText(sourceValue, ENV_NOT_CONNECTED);
        setAttr(sourceValue, 'data-tone', 'caution');
        sourceBadge.hidden = true;
        setAttr(sourceChip, 'title', connection.detail);
        return;
      case 'error':
        setText(sourceValue, 'SERVER ERROR');
        setAttr(sourceValue, 'data-tone', 'down');
        sourceBadge.hidden = true;
        setAttr(sourceChip, 'title', connection.message);
        return;
      case 'connected':
        setText(sourceValue, connection.source.label);
        setAttr(sourceValue, 'data-tone', null);
        sourceBadge.hidden = false;
        updateBadge(sourceBadge, quote.state);
        setAttr(
          sourceChip,
          'title',
          `Feed declared ${connection.source.mode} by the operator. Selected instrument: ${DATA_STATE_DESCRIPTION[quote.state]}`,
        );
    }
  });

  const header = h(
    'header',
    { class: 'header' },
    h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('span', { class: 'brand__word', text: 'ELSTAND' }),
      h('span', { class: 'brand__sub', text: 'INTELLIGENCE' }),
    ),
    nav,
    h('div', { class: 'chips' }, elvoidChip, instrumentChip, sourceChip),
  );

  // ---- main and footer ----------------------------------------------------------------
  const main = h('main', { class: 'main', attrs: { id: 'main', tabindex: -1 } });

  const clock = h('span', { class: 'footer__clock' });
  bind(scope, ctx.now, (now) =>
    setText(clock, `UTC ${formatUtcDate(now)} ${formatUtcTime(now, true)}`),
  );
  const footer = h(
    'footer',
    { class: 'footer' },
    h('span', {}, clock, ' · every timestamp is UTC unless it says otherwise'),
    h('a', {
      class: 'footer__link',
      text: 'Provider status',
      attrs: { href: formatRoute({ page: 'providers' }) },
    }),
    h('span', {
      text: 'Not investment advice. Elstand shows provider data as received and does not forecast prices.',
    }),
  );

  const root = h(
    'div',
    { class: 'app' },
    h('a', {
      class: 'skip-link',
      text: 'Skip to main content',
      attrs: { href: '#main' },
      on: {
        click: (event) => {
          event.preventDefault();
          main.focus();
        },
      },
    }),
    header,
    main,
    footer,
  );

  return {
    el: root,
    main,
    dispose: () => {
      scope.dispose();
      replaceContent(root, []);
    },
  };
}
