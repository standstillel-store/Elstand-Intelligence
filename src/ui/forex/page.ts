import type { AppContext } from '../../app/context.js';
import { createScope, h, type View } from '../dom.js';
import { createChartPanel } from '../chart/chart-panel.js';
import { createElvoidPanel } from '../elvoid/panel.js';
import { createDepthPanel } from './depth-panel.js';
import { createSourceNotice } from './source-notice.js';
import { createWatchlist } from './watchlist.js';

/** The Forex Intelligence workspace: chart, depth, ELVOID, and the persistent watchlist. */
export function createForexPage(ctx: AppContext): View {
  const scope = createScope();
  const parts = {
    chart: createChartPanel(ctx),
    watch: createWatchlist(ctx),
    depth: createDepthPanel(ctx),
    elvoid: createElvoidPanel(ctx),
    source: createSourceNotice(ctx),
  };
  for (const part of Object.values(parts)) scope.add(() => part.dispose());
  const el = h(
    'div',
    { class: 'forex' },
    h('h1', { class: 'visually-hidden', text: 'Forex Intelligence' }),
    h('div', { class: 'forex__chart' }, parts.source.el, parts.chart.el),
    h('div', { class: 'forex__watch' }, parts.watch.el),
    h('div', { class: 'forex__depth' }, parts.depth.el),
    h('div', { class: 'forex__elvoid' }, parts.elvoid.el),
  );
  return { el, dispose: () => scope.dispose() };
}
