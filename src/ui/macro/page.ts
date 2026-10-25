import type { AppContext } from '../../app/context.js';
import { formatRoute, MACRO_TAB_LABEL, MACRO_TABS, type MacroTab } from '../../app/router.js';
import { derived } from '../../core/store.js';
import { bind, setAttr } from '../bind.js';
import { createScope, h, type View } from '../dom.js';
import { createBubbleModule } from './bubbles.js';
import { createNewsCalendarModule } from './news-calendar.js';
import { createVolSurfaceModule } from './vol-surface.js';

function createModule(ctx: AppContext, tab: MacroTab): View {
  switch (tab) {
    case 'vol-surface':
      return createVolSurfaceModule(ctx);
    case 'bubbles':
      return createBubbleModule(ctx);
    case 'news-calendar':
      return createNewsCalendarModule(ctx);
  }
}

/** The Macro Intelligence workspace: three modules behind real links, one per address. */
export function createMacroPage(ctx: AppContext): View {
  const scope = createScope();
  const links = new Map<MacroTab, HTMLAnchorElement>();
  const tabs = h(
    'nav',
    { class: 'tabs', attrs: { 'aria-label': 'Macro Intelligence modules' } },
    ...MACRO_TABS.map((tab) => {
      const link = h('a', {
        class: 'tabs__tab',
        text: MACRO_TAB_LABEL[tab],
        attrs: { href: formatRoute({ page: 'macro', tab }), 'data-tab': tab },
      });
      links.set(tab, link);
      return link;
    }),
  );
  const host = h('div', { class: 'macro__module' });
  const el = h(
    'div',
    { class: 'macro' },
    h('h1', { class: 'visually-hidden', text: 'Macro Intelligence' }),
    tabs,
    host,
  );

  const tab = derived([ctx.route], (route) => (route.page === 'macro' ? route.tab : null));
  scope.add(() => tab.dispose());
  let current: View | null = null;
  let shown: MacroTab | null = null;
  bind(scope, tab, (next) => {
    for (const [name, link] of links) setAttr(link, 'aria-current', name === next ? 'page' : null);
    if (next === null || next === shown) return;
    shown = next;
    current?.dispose();
    current = createModule(ctx, next);
    host.replaceChildren(current.el);
  });
  scope.add(() => current?.dispose());

  return { el, dispose: () => scope.dispose() };
}
