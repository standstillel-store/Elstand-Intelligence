import type { AppContext } from '../../app/context.js';
import { formatNumber, formatPercent, formatUtcDateTime } from '../../core/format.js';
import { CAPABILITY_LABEL } from '../../core/provider-state.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import { safeHttpUrl } from '../../core/url.js';
import {
  validateBubblePoints,
  type AttributedValue,
  type BubbleResult,
  type CurrencyMacroPoint,
} from '../../data/macro-bubbles.js';
import { createScope, h, replaceContent, svg, type Child, type View } from '../dom.js';
import { createPanel, notice } from '../parts.js';
import {
  DIRECTION_GLYPH,
  DIRECTION_WORD,
  layoutBubbles,
  type BubbleLayout,
} from './bubble-layout.js';
import { failedBlock, loadingNotice, originNotices, unavailableBlock } from './states.js';

const KEY = 'all';
const MIN_WIDTH = 280;
/** Every bubble can be hit within a 24px circle (WCAG 2.5.8), however small it is drawn. */
const MIN_TARGET_RADIUS = 12;

function specEntry(term: string, description: string): Child[] {
  return [h('dt', { text: term }), h('dd', { text: description })];
}

/** The encoding, shown whether or not data is present. Mirrors docs/MACRO-BUBBLES.md. */
function encodingSpec(): HTMLElement {
  return h(
    'dl',
    { class: 'spec' },
    ...specEntry('One bubble', 'One currency.'),
    ...specEntry(
      'Horizontal position',
      'Policy rate, in percent, as published by the source named for it.',
    ),
    ...specEntry('Vertical position', 'Consumer price inflation, year on year, in percent.'),
    ...specEntry(
      'Size',
      'Radius = minimum + (maximum − minimum) × √(|change| ÷ largest |change|), so the bubble’s area grows with the absolute one-month price change. Because of the minimum, area is not strictly proportional to it: a change of zero is drawn at the minimum size so the currency stays visible.',
    ),
    ...specEntry(
      'Color and glyph',
      'Direction of the one-month price change: ▲ up in muted green, ▼ down in red, – flat in grey. The glyph and the signed number are always shown, so color is never the only signal. The basis of the change (what it is measured against) is stated per currency in its detail.',
    ),
    ...specEntry(
      'Dates and sources',
      'The three numbers of a currency can come from different sources and different dates. Select a bubble to see each value with its source and observation time. Nothing is estimated or filled in: a currency missing any of the three is not drawn.',
    ),
  );
}

function sourceCell(value: AttributedValue): HTMLElement {
  const link = safeHttpUrl(value.source.url);
  return h(
    'span',
    {},
    link === null
      ? value.source.name
      : h('a', {
          text: value.source.name,
          attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
        }),
    ` · observed ${formatUtcDateTime(value.asOf)} · retrieved ${formatUtcDateTime(value.source.retrievedAt)}`,
  );
}

function detailCard(
  point: CurrencyMacroPoint,
  direction: keyof typeof DIRECTION_GLYPH,
): HTMLElement {
  return h(
    'div',
    { class: 'bubbles__detail', attrs: { 'data-currency': point.currency.toUpperCase() } },
    h('h3', {
      class: 'bubbles__detail-title',
      text: `${point.currency.toUpperCase()} ${DIRECTION_GLYPH[direction]}`,
    }),
    h(
      'dl',
      { class: 'kv' },
      h('dt', { text: 'Policy rate' }),
      h(
        'dd',
        {},
        h('span', { class: 'mono', text: `${formatNumber(point.policyRate.value, 2)}%` }),
        h('br'),
        sourceCell(point.policyRate),
      ),
      h('dt', { text: 'CPI, year on year' }),
      h(
        'dd',
        {},
        h('span', { class: 'mono', text: `${formatNumber(point.cpiYoY.value, 2)}%` }),
        h('br'),
        sourceCell(point.cpiYoY),
      ),
      h('dt', { text: 'One-month change' }),
      h(
        'dd',
        {},
        h('span', {
          class: 'mono',
          text: `${DIRECTION_GLYPH[direction]} ${formatPercent(point.priceChange1m.value)}`,
        }),
        ` (${DIRECTION_WORD[direction]}) · ${point.priceChange1m.basis}`,
        h('br'),
        sourceCell(point.priceChange1m),
      ),
    ),
  );
}

function buildTable(points: readonly CurrencyMacroPoint[]): HTMLElement {
  const sorted = [...points].sort((a, b) => a.currency.localeCompare(b.currency));
  return h(
    'div',
    { class: 'scroll-y' },
    h(
      'table',
      { class: 'tbl' },
      h('caption', {
        class: 'visually-hidden',
        text: 'Policy rate, inflation and one-month price change by currency',
      }),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Currency', attrs: { scope: 'col' } }),
          h('th', { class: 'num', text: 'Policy rate %', attrs: { scope: 'col' } }),
          h('th', { class: 'num', text: 'CPI y/y %', attrs: { scope: 'col' } }),
          h('th', { class: 'num', text: '1-month change %', attrs: { scope: 'col' } }),
          h('th', { text: 'Basis of change', attrs: { scope: 'col' } }),
          h('th', { text: 'Sources', attrs: { scope: 'col' } }),
        ),
      ),
      h(
        'tbody',
        {},
        ...sorted.map((point) => {
          const names = [
            ...new Set(
              [point.policyRate, point.cpiYoY, point.priceChange1m].map((v) => v.source.name),
            ),
          ];
          return h(
            'tr',
            {},
            h('th', { text: point.currency.toUpperCase(), attrs: { scope: 'row' } }),
            h('td', { class: 'num', text: formatNumber(point.policyRate.value, 2) }),
            h('td', { class: 'num', text: formatNumber(point.cpiYoY.value, 2) }),
            h('td', { class: 'num', text: formatPercent(point.priceChange1m.value) }),
            h('td', { text: point.priceChange1m.basis }),
            h('td', { text: names.join(', ') }),
          );
        }),
      ),
    ),
  );
}

function axisTitle(text: string, x: number, y: number, rotate: boolean): SVGElement {
  return svg(
    'text',
    {
      class: 'bubbles__title',
      x,
      y,
      'text-anchor': 'middle',
      transform: rotate ? `rotate(-90 ${x} ${y})` : null,
    },
    text,
  );
}

function buildSvg(
  layout: BubbleLayout,
  selected: string | null,
  onSelect: (currency: string) => void,
): SVGElement {
  const { plot, x, y } = layout;
  const children: SVGElement[] = [];
  for (const tick of x.ticks) {
    children.push(
      svg('line', {
        class: 'bubbles__grid',
        x1: x.toPx(tick),
        x2: x.toPx(tick),
        y1: plot.top,
        y2: plot.bottom,
      }),
    );
    children.push(
      svg(
        'text',
        { x: x.toPx(tick), y: plot.bottom + 16, 'text-anchor': 'middle' },
        formatNumber(tick, tick % 1 === 0 ? 0 : 1),
      ),
    );
  }
  for (const tick of y.ticks) {
    children.push(
      svg('line', {
        class: 'bubbles__grid',
        x1: plot.left,
        x2: plot.right,
        y1: y.toPx(tick),
        y2: y.toPx(tick),
      }),
    );
    children.push(
      svg(
        'text',
        { x: plot.left - 8, y: y.toPx(tick) + 4, 'text-anchor': 'end' },
        formatNumber(tick, tick % 1 === 0 ? 0 : 1),
      ),
    );
  }
  if (x.min < 0 && x.max > 0) {
    children.push(
      svg('line', {
        class: 'bubbles__axis',
        x1: x.toPx(0),
        x2: x.toPx(0),
        y1: plot.top,
        y2: plot.bottom,
      }),
    );
  }
  if (y.min < 0 && y.max > 0) {
    children.push(
      svg('line', {
        class: 'bubbles__axis',
        x1: plot.left,
        x2: plot.right,
        y1: y.toPx(0),
        y2: y.toPx(0),
      }),
    );
  }
  children.push(
    svg('rect', {
      class: 'bubbles__frame',
      x: plot.left,
      y: plot.top,
      width: plot.right - plot.left,
      height: plot.bottom - plot.top,
    }),
  );
  children.push(
    axisTitle('Policy rate (%)', (plot.left + plot.right) / 2, layout.height - 8, false),
  );
  children.push(
    axisTitle('CPI inflation, year on year (%)', 16, (plot.top + plot.bottom) / 2, true),
  );

  for (const node of layout.nodes) {
    const labelRight = node.cx + node.r + 4 + 48 <= layout.width - 4;
    const group = svg(
      'g',
      {
        class: 'bubble',
        tabindex: 0,
        role: 'button',
        'data-currency': node.currency,
        'data-dir': node.direction,
        'aria-pressed': String(selected === node.currency),
        'aria-label':
          `${node.currency}: policy rate ${formatNumber(node.point.policyRate.value, 2)} percent, ` +
          `inflation ${formatNumber(node.point.cpiYoY.value, 2)} percent, ` +
          `one-month change ${DIRECTION_WORD[node.direction]} ${formatPercent(node.point.priceChange1m.value)}`,
      },
      svg('circle', {
        class: 'bubble__hit',
        cx: node.cx,
        cy: node.cy,
        r: Math.max(node.r, MIN_TARGET_RADIUS),
      }),
      svg('circle', { class: 'bubble__dot', cx: node.cx, cy: node.cy, r: node.r }),
      svg(
        'text',
        {
          class: 'bubble__label',
          x: labelRight ? node.cx + node.r + 4 : node.cx - node.r - 4,
          y: node.cy + 4,
          'text-anchor': labelRight ? 'start' : 'end',
        },
        `${node.currency} ${DIRECTION_GLYPH[node.direction]}`,
      ),
    );
    group.addEventListener('click', () => onSelect(node.currency));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(node.currency);
      }
    });
    children.push(group);
  }

  return svg(
    'svg',
    {
      class: 'bubbles__svg',
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: layout.width,
      height: layout.height,
      role: 'group',
      'aria-label':
        'Macro bubble chart: policy rate against inflation, bubble size is the one-month price change',
    },
    ...children,
  );
}

/**
 * The macro bubble module. One bubble per currency, drawn only from validated, attributed
 * series that a connected macro-series provider returned. With none it says ENV NOT CONNECTION.
 */
export function createBubbleModule(ctx: AppContext): View {
  const scope = createScope();
  const panel = createPanel({ title: 'Macro bubbles', id: 'bubbles-panel' });
  const resource = createKeyedResource<BubbleResult>(
    (_key, signal) => ctx.macro.bubbles.getPoints(signal),
    () => ctx.now.get(),
  );

  const stateHost = h('div', { class: 'macro__state' });
  const notesHost = h('div', { class: 'macro__notes' });
  const chartHost = h('div', { class: 'bubbles__chart' });
  const legendHost = h('div', {});
  const detailHost = h('div', { class: 'bubbles__side' });
  const tableHost = h('div', {});
  const tableDetails = h(
    'details',
    { class: 'disclosure' },
    h('summary', { text: 'Data table · every value, basis and source' }),
    h('div', { class: 'disclosure__body' }, tableHost),
  );
  const plotHost = h(
    'div',
    { class: 'macro__plot' },
    h('div', { class: 'bubbles' }, h('div', {}, chartHost, legendHost), detailHost),
    tableDetails,
  );
  plotHost.hidden = true;
  panel.body.append(
    h('div', { class: 'macro__body' }, stateHost, plotHost, notesHost, encodingSpec()),
  );

  let points: readonly CurrencyMacroPoint[] = [];
  let selected: string | null = null;
  let width = 0;

  function selectCurrency(currency: string): void {
    selected = selected === currency ? null : currency;
    draw();
  }

  function draw(): void {
    if (points.length === 0 || width < MIN_WIDTH) return;
    const height = Math.round(Math.max(300, Math.min(520, width * 0.58)));
    const layout = layoutBubbles(points, width, height);
    replaceContent(chartHost, [buildSvg(layout, selected, selectCurrency)]);
    const node = layout.nodes.find((candidate) => candidate.currency === selected);
    replaceContent(
      detailHost,
      node === undefined
        ? [
            h('p', {
              class: 'bubbles__hint',
              text: 'Select a bubble to see its values, sources and dates.',
            }),
          ]
        : [detailCard(node.point, node.direction)],
    );
    const largest = layout.nodes.reduce<(typeof layout.nodes)[number] | null>(
      (best, candidate) =>
        best === null ||
        Math.abs(candidate.point.priceChange1m.value) > Math.abs(best.point.priceChange1m.value)
          ? candidate
          : best,
      null,
    );
    replaceContent(legendHost, [
      h(
        'div',
        { class: 'bubbles__legend' },
        h('span', { text: '▲ up' }),
        h('span', { text: '▼ down' }),
        h('span', { text: '– flat' }),
        h('span', {
          text:
            largest === null
              ? ''
              : `Area grows with |one-month change|. Largest: ${largest.currency} ${formatPercent(largest.point.priceChange1m.value)}.`,
        }),
      ),
    ]);
  }

  function showState(children: readonly Child[]): void {
    points = [];
    plotHost.hidden = true;
    replaceContent(stateHost, children);
    replaceContent(notesHost, []);
    notesHost.hidden = true;
    panel.meta.textContent = '';
    stateHost.hidden = false;
  }

  /** What was left out, and which providers supplied what, shown with a drawn chart. */
  function showOrigin(result: Extract<BubbleResult, { status: 'available' }>): void {
    const { origin } = result;
    const omitted = result.omitted ?? [];
    const children: HTMLElement[] = [
      ...(omitted.length === 0
        ? []
        : [
            notice(
              'caution',
              'NOT DRAWN',
              omitted.map((entry) => `${entry.currency}: ${entry.reason}`).join(' · '),
            ),
          ]),
      ...originNotices(origin),
    ];
    const inputs = origin?.inputs ?? [];
    if (inputs.length > 0) {
      children.push(
        h(
          'dl',
          { class: 'spec' },
          h('dt', { text: 'Inputs' }),
          ...inputs.map((input) =>
            h('dd', {
              text:
                `${input.providerLabel} · ${CAPABILITY_LABEL[input.capability]} · ${input.state}` +
                (input.retrievedAt === null
                  ? ''
                  : ` · retrieved ${formatUtcDateTime(input.retrievedAt)}`),
            }),
          ),
        ),
      );
    }
    replaceContent(notesHost, children);
    notesHost.hidden = children.length === 0;
    const retrieved = origin?.provenance.retrievedAt ?? null;
    panel.meta.textContent =
      origin === undefined
        ? ''
        : `${origin.provenance.state}${retrieved === null ? '' : ` · retrieved ${formatUtcDateTime(retrieved)}`}`;
  }

  tableDetails.addEventListener('toggle', () => {
    if (tableDetails.open && tableHost.childNodes.length === 0 && points.length > 0) {
      replaceContent(tableHost, [buildTable(points)]);
    }
  });

  function render(state: Loadable<BubbleResult>): void {
    switch (state.status) {
      case 'idle':
      case 'loading':
        showState([loadingNotice('Loading macro series…')]);
        return;
      case 'error':
        showState([failedBlock('MACRO SERIES FAILED', state.message, () => resource.reload(KEY))]);
        return;
      case 'ready': {
        const result = state.value;
        if (result.status === 'unavailable') {
          showState([
            unavailableBlock({
              source: 'A macro-series provider',
              reason: result.reason,
              origin: result.origin,
              onRetry: () => resource.reload(KEY),
            }),
          ]);
          return;
        }
        const issues = validateBubblePoints(result.points);
        if (issues.length > 0 || result.points.length === 0) {
          showState([
            notice(
              'down',
              'SERIES REJECTED',
              result.points.length === 0
                ? 'The provider returned no currencies. Nothing is drawn.'
                : `The provider returned series that failed validation: ${issues[0] ?? 'unknown problem'}. Nothing is drawn.`,
            ),
          ]);
          return;
        }
        points = result.points;
        selected = null;
        stateHost.hidden = true;
        replaceContent(stateHost, []);
        plotHost.hidden = false;
        tableDetails.open = false;
        replaceContent(tableHost, []);
        draw();
        showOrigin(result);
      }
    }
  }

  const stop = resource.store(KEY).subscribe(render);
  scope.add(stop);
  resource.ensure(KEY);
  render(resource.store(KEY).get());

  const observer = new ResizeObserver((entries) => {
    const next = Math.floor(entries[0]?.contentRect.width ?? 0);
    if (next !== width && next >= MIN_WIDTH) {
      width = next;
      draw();
    }
  });
  observer.observe(chartHost);
  scope.add(() => observer.disconnect());

  return { el: panel.el, dispose: () => scope.dispose() };
}
