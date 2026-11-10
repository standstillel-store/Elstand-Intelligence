import type { AppContext } from '../../app/context.js';
import {
  buildProviderGroups,
  freshnessOf,
  NOT_VERIFIED,
  type ProviderGroup,
  type ProviderRow,
} from '../../app/provider-rows.js';
import { formatRoute } from '../../app/router.js';
import { formatUtcDateTime, NO_VALUE } from '../../core/format.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import type { ProviderId } from '../../core/provider-state.js';
import type { ProvidersAnswer } from '../../data/http-providers.js';
import { isAbortError } from '../../data/api-client.js';
import { createScope, h, replaceContent, type View } from '../dom.js';
import { failedBlock, loadingNotice } from '../macro/states.js';
import { button, createPanel, notice } from '../parts.js';

const KEY = 'providers';

type CheckState =
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly message: string };

function timeCell(timeMs: number | null): string {
  return timeMs === null ? NO_VALUE : formatUtcDateTime(timeMs);
}

function cacheCell(row: ProviderRow): string {
  if (row.cached) return 'Kept copy (the provider was not asked)';
  if (row.fallback !== null) return `Fallback: ${row.fallback}`;
  const answered =
    row.status === 'LIVE' ||
    row.status === 'DELAYED' ||
    row.status === 'STALE' ||
    row.status === 'CALCULATED';
  return answered ? 'Fresh answer' : NO_VALUE;
}

function statusCell(row: ProviderRow): HTMLElement {
  return h(
    'div',
    {},
    h('span', { class: 'pstate', text: row.status, attrs: { 'data-pstate': row.status } }),
    row.note === null ? null : h('p', { class: 'provider__note', text: row.note }),
  );
}

function rowView(row: ProviderRow, now: number): HTMLElement {
  const fresh = h('td', {
    text: row.freshness,
    attrs: {
      'data-age': 'true',
      'data-as-of': row.dataAsOf === null ? '' : String(row.dataAsOf),
      'data-retrieved': row.lastSuccessAt === null ? '' : String(row.lastSuccessAt),
    },
  });
  fresh.textContent = freshnessOf(row.dataAsOf, row.lastSuccessAt, now);
  return h(
    'tr',
    { attrs: { 'data-status': row.status } },
    h('td', { text: row.capabilityLabel }),
    h('td', { text: row.endpoint ?? NO_VALUE }),
    h('td', {}, statusCell(row)),
    h('td', { text: timeCell(row.lastSuccessAt) }),
    h('td', { text: timeCell(row.lastAttemptAt) }),
    h('td', { text: timeCell(row.dataAsOf) }),
    fresh,
    h('td', { text: cacheCell(row) }),
  );
}

function checkView(group: ProviderGroup, check: CheckState | undefined): HTMLElement | null {
  if (check?.kind === 'running') {
    return notice('neutral', 'CHECKING', `Sending one real request to ${group.config.label}…`);
  }
  if (check?.kind === 'failed') {
    return notice('down', 'CHECK FAILED', check.message);
  }
  const probe = group.probe;
  if (probe === null) return null;
  const auth =
    probe.authentication === 'accepted'
      ? 'the provider accepted the credential'
      : probe.authentication === 'rejected'
        ? 'the provider rejected the credential'
        : probe.authentication === 'not-required'
          ? 'no credential is needed'
          : 'authentication could not be determined';
  return notice(
    probe.dataRetrieved ? 'neutral' : 'caution',
    `CHECK · ${probe.state}`,
    `${probe.message} (${auth}; ${probe.dataRetrieved ? 'valid data was retrieved' : 'no valid data was retrieved'}; ` +
      `checked ${formatUtcDateTime(probe.attemptedAt)})`,
  );
}

/**
 * The provider status page. It separates configuration (what the server is set up to read, by
 * variable name only) from observation (what real requests have returned to this browser), and
 * never calls a provider "connected" because a variable exists. A check is a real request, made
 * only when a person presses the button, because it spends part of the provider's allowance.
 */
export function createProvidersPage(ctx: AppContext): View {
  const scope = createScope();
  const resource = createKeyedResource<ProvidersAnswer>(
    (_key, signal) => ctx.providersApi.list(signal),
    () => ctx.now.get(),
  );
  const checks = new Map<ProviderId, CheckState>();
  let state: Loadable<ProvidersAnswer> = resource.store(KEY).get();
  let configs: ProvidersAnswer['providers'] | null = null;
  const controllers = new Set<AbortController>();

  const panel = createPanel({ title: 'Provider status', id: 'providers-panel' });
  const listHost = h('div', { class: 'providers' });
  const intro = h(
    'dl',
    { class: 'spec' },
    h('dt', { text: 'Configuration is not connection' }),
    h('dd', {
      text:
        'A provider whose variable is set can be asked, which is all “configured” means. It shows ' +
        `${NOT_VERIFIED} until a real request has been answered and validated.`,
    }),
    h('dt', { text: 'What “last” means' }),
    h('dd', {
      text:
        'The server runs as many short-lived instances that do not share memory, so the times below ' +
        'are the ones this browser has been told by real answers since this page was opened.',
    }),
    h('dt', { text: 'Secrets' }),
    h('dd', {
      text: 'Only the names of variables appear here. A value is never sent to the browser.',
    }),
  );
  panel.body.append(h('div', { class: 'macro__body' }, intro, listHost));
  panel.meta.append(
    button('Reload list', () => resource.reload(KEY), {
      small: true,
      title: 'Read the server’s configuration again. This sends no request to any provider.',
    }),
  );

  function runCheck(id: ProviderId): void {
    if (checks.get(id)?.kind === 'running') return;
    checks.set(id, { kind: 'running' });
    render();
    const controller = new AbortController();
    controllers.add(controller);
    ctx.providersApi
      .probe(id, controller.signal)
      .then((answer) => {
        controllers.delete(controller);
        checks.delete(id);
        if (answer.probe !== null) ctx.ledger.recordProbe(answer.probe);
        configs = answer.providers;
        render();
      })
      .catch((error: unknown) => {
        controllers.delete(controller);
        if (isAbortError(error)) return;
        checks.set(id, {
          kind: 'failed',
          message: error instanceof Error ? error.message : 'The check could not be made.',
        });
        render();
      });
  }

  function groupView(group: ProviderGroup, now: number): HTMLElement {
    const { config } = group;
    const check = checks.get(config.id);
    const verify = button(
      config.config === 'no-endpoint' ? 'No endpoint to check' : 'Verify connection',
      () => runCheck(config.id),
      {
        small: true,
        title:
          'Sends one real request to this provider. It counts against the provider’s allowance.',
      },
    );
    verify.setAttribute('data-verify', config.id);
    verify.disabled =
      check?.kind === 'running' ||
      config.config === 'no-endpoint' ||
      config.config === 'env-not-connected';
    return h(
      'article',
      { class: 'provider', attrs: { 'data-provider': config.id } },
      h(
        'header',
        { class: 'provider__head' },
        h('h3', { class: 'provider__name', text: config.label }),
        h('span', { class: 'provider__role', text: config.roleText }),
        verify,
      ),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: 'Configuration' }),
        h('dd', { text: group.configuration }),
        h('dt', { text: 'Allowance' }),
        h('dd', { text: config.limits }),
        group.missing === null ? null : h('dt', { text: 'Missing' }),
        group.missing === null ? null : h('dd', { text: group.missing }),
      ),
      checkView(group, check),
      h(
        'div',
        { class: 'scroll-x' },
        h(
          'table',
          { class: 'tbl provider__table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...[
                'Capability',
                'Endpoint',
                'Status',
                'Last successful retrieval',
                'Last attempt',
                'Data timestamp',
                'Freshness',
                'Cache',
              ].map((label) => h('th', { text: label, attrs: { scope: 'col' } })),
            ),
          ),
          h('tbody', {}, ...group.rows.map((row) => rowView(row, now))),
        ),
      ),
    );
  }

  function render(): void {
    if (configs === null) {
      switch (state.status) {
        case 'idle':
        case 'loading':
          replaceContent(listHost, [loadingNotice('Reading the server’s provider configuration…')]);
          return;
        case 'error':
          replaceContent(listHost, [
            failedBlock('PROVIDER LIST FAILED', state.message, () => resource.reload(KEY)),
          ]);
          return;
        case 'ready':
          configs = state.value.providers;
      }
    }
    const focused = ctx.window.document.activeElement?.getAttribute('data-verify') ?? null;
    const groups = buildProviderGroups(configs, ctx.ledger.store.get(), ctx.now.get());
    replaceContent(
      listHost,
      groups.map((group) => groupView(group, ctx.now.get())),
    );
    if (focused !== null) {
      listHost
        .querySelector<HTMLElement>(`[data-verify="${focused}"]:not(:disabled)`)
        ?.focus({ preventScroll: true });
    }
  }

  scope.add(
    resource.store(KEY).subscribe((next) => {
      state = next;
      if (next.status === 'ready') configs = next.value.providers;
      render();
    }),
  );
  scope.add(ctx.ledger.store.subscribe(() => render()));
  // Ages move with the clock; only the age cells are rewritten, so nothing under a hand is rebuilt.
  scope.add(
    ctx.now.subscribe((now) => {
      for (const cell of listHost.querySelectorAll<HTMLElement>('td[data-age="true"]')) {
        const asOf = cell.getAttribute('data-as-of');
        const retrieved = cell.getAttribute('data-retrieved');
        const text = freshnessOf(
          asOf === null || asOf === '' ? null : Number(asOf),
          retrieved === null || retrieved === '' ? null : Number(retrieved),
          now,
        );
        if (cell.textContent !== text) cell.textContent = text;
      }
    }),
  );
  scope.add(() => {
    for (const controller of controllers) controller.abort();
  });

  const el = h(
    'div',
    { class: 'macro' },
    h('h1', { class: 'visually-hidden', text: 'Provider status' }),
    panel.el,
    h(
      'p',
      { class: 'macro__help' },
      h('a', {
        text: 'Back to Forex Intelligence',
        attrs: {
          href: formatRoute({
            page: 'forex',
            instrumentId: ctx.selection.get().instrumentId,
            timeframe: ctx.selection.get().timeframe,
          }),
        },
      }),
    ),
  );

  render();
  resource.ensure(KEY);
  return { el, dispose: () => scope.dispose() };
}
