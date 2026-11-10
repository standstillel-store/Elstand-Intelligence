import { findInstrument } from '../core/instruments.js';
import { derived } from '../core/store.js';
import { createForexPage } from '../ui/forex/page.js';
import { createMacroPage } from '../ui/macro/page.js';
import { createProvidersPage } from '../ui/providers/page.js';
import { bind } from '../ui/bind.js';
import { createScope, replaceContent, type View } from '../ui/dom.js';
import { createShell } from '../ui/shell.js';
import { createAppContext, type AppEnvironment } from './context.js';
import { MACRO_TAB_LABEL } from './router.js';

export interface MountedApp {
  readonly context: ReturnType<typeof createAppContext>;
  dispose(): void;
}

/** The composition root: builds the context and shell, and swaps pages as the route changes. */
export function mountApp(root: HTMLElement, env: AppEnvironment): MountedApp {
  const scope = createScope();
  const ctx = createAppContext(env);
  scope.add(() => ctx.dispose());

  const shell = createShell(ctx);
  scope.add(() => shell.dispose());
  replaceContent(root, [shell.el]);

  const page = derived([ctx.route], (route) => route.page);
  scope.add(() => page.dispose());
  let current: View | null = null;
  bind(scope, page, (kind) => {
    current?.dispose();
    current =
      kind === 'forex'
        ? createForexPage(ctx)
        : kind === 'macro'
          ? createMacroPage(ctx)
          : createProvidersPage(ctx);
    replaceContent(shell.main, [current.el]);
  });
  scope.add(() => current?.dispose());

  bind(
    scope,
    derived([ctx.route], (route) => route),
    (route) => {
      const title =
        route.page === 'forex'
          ? `${findInstrument(route.instrumentId)?.symbol ?? route.instrumentId} ${route.timeframe} · Forex Intelligence`
          : route.page === 'macro'
            ? `${MACRO_TAB_LABEL[route.tab]} · Macro Intelligence`
            : 'Provider status';
      env.window.document.title = `${title} · Elstand Intelligence`;
    },
  );

  ctx.connection.check();
  return { context: ctx, dispose: () => scope.dispose() };
}
