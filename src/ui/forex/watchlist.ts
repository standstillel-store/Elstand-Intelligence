import type { AppContext } from '../../app/context.js';
import { quoteView } from '../../app/selectors.js';
import type { FeedState } from '../../app/feeds.js';
import {
  directionOf,
  formatPercent,
  formatPrice,
  formatUtcDateTime,
  formatUtcTime,
  NO_VALUE,
} from '../../core/format.js';
import { filterInstruments, INSTRUMENTS, type Instrument } from '../../core/instruments.js';
import { derived } from '../../core/store.js';
import type { QuoteBook } from '../../data/service.js';
import { bind, setAttr, setText } from '../bind.js';
import { createScope, h, replaceContent, type View } from '../dom.js';
import { button, createPanel, envNotConnected, notice, stateBadge, updateBadge } from '../parts.js';

interface Row {
  readonly instrument: Instrument;
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly badge: HTMLElement;
  readonly price: HTMLElement;
  readonly sub: HTMLElement;
  readonly change: HTMLElement;
}

function buildRow(instrument: Instrument, onSelect: (instrument: Instrument) => void): Row {
  const badge = stateBadge('unavailable');
  const price = h('span', { class: 'wl__price', text: NO_VALUE });
  const sub = h('span', { class: 'wl__sub', text: instrument.name });
  const change = h('span', { class: 'wl__chg', text: NO_VALUE, attrs: { 'data-dir': 'none' } });
  const rowButton = h(
    'button',
    {
      class: 'wl__row',
      attrs: { type: 'button', 'data-instrument': instrument.id, 'aria-current': 'false' },
      on: { click: () => onSelect(instrument) },
    },
    h('span', { class: 'wl__sym' }, h('span', { text: instrument.symbol }), badge),
    price,
    sub,
    change,
  );
  return { instrument, item: h('li', {}, rowButton), button: rowButton, badge, price, sub, change };
}

/** The persistent instrument list: search, click to select, per-row data state. */
export function createWatchlist(ctx: AppContext): View {
  const scope = createScope();
  const panel = createPanel({ title: 'Watchlist', flush: true, className: 'wl' });

  // ---- header controls ------------------------------------------------------------------
  const metaText = h('span', {});
  const autoButton = button('Auto', () => ctx.autoRefresh.set((on) => !on), { small: true });
  const refreshButton = button('Refresh', () => ctx.feeds.quotes.refresh(), { small: true });
  panel.meta.append(metaText, autoButton, refreshButton);

  // ---- search and list ------------------------------------------------------------------
  const search = h('input', {
    class: 'wl__search',
    attrs: {
      type: 'search',
      placeholder: 'Filter instruments',
      'aria-label': 'Filter instruments',
      autocomplete: 'off',
      spellcheck: false,
      'aria-controls': 'wl-list',
    },
  });
  const notices = h('div', { class: 'wl__env' });
  const emptyMessage = h('p', { class: 'wl__empty', attrs: { hidden: true } });
  const rows = INSTRUMENTS.map((instrument) =>
    buildRow(instrument, (selected) => {
      const timeframe = ctx.selection.get().timeframe;
      ctx.navigate({ page: 'forex', instrumentId: selected.id, timeframe });
    }),
  );
  const list = h(
    'ul',
    { class: 'wl__list', attrs: { id: 'wl-list' } },
    ...rows.map((row) => row.item),
  );

  function visibleRows(): Row[] {
    return rows.filter((row) => !row.item.hidden);
  }

  function applyFilter(): void {
    const matches = new Set(
      filterInstruments(INSTRUMENTS, search.value).map((instrument) => instrument.id),
    );
    for (const row of rows) row.item.hidden = !matches.has(row.instrument.id);
    const none = matches.size === 0;
    emptyMessage.hidden = !none;
    emptyMessage.textContent = none ? `No instrument matches “${search.value.trim()}”.` : '';
  }
  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      visibleRows()[0]?.button.focus();
    } else if (event.key === 'Enter') {
      visibleRows()[0]?.button.click();
    } else if (event.key === 'Escape' && search.value !== '') {
      search.value = '';
      applyFilter();
    }
  });
  list.addEventListener('keydown', (event) => {
    const visible = visibleRows();
    const current = visible.findIndex((row) => row.button === ctx.window.document.activeElement);
    let target: number | null = null;
    if (event.key === 'ArrowDown') target = Math.min(visible.length - 1, current + 1);
    else if (event.key === 'ArrowUp') target = current <= 0 ? -1 : current - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = visible.length - 1;
    if (target === null) return;
    event.preventDefault();
    if (target < 0) search.focus();
    else visible[target]?.button.focus();
  });

  panel.body.append(h('div', { class: 'wl__tools' }, search), notices, list, emptyMessage);

  // ---- state ----------------------------------------------------------------------------
  const state = derived(
    [
      ctx.feeds.quotes.store,
      ctx.selection,
      ctx.source,
      ctx.now,
      ctx.autoRefresh,
      ctx.connection.state,
    ],
    (feed, selection, source, now, auto, connection) => ({
      feed,
      selection,
      source,
      now,
      auto,
      connection,
    }),
  );
  scope.add(() => state.dispose());

  let noticeKey = '';
  function renderNotices(feed: FeedState<QuoteBook>): void {
    const key =
      feed.kind === 'not-connected'
        ? `nc:${feed.detail}`
        : feed.kind === 'connection-error' || feed.kind === 'error'
          ? `${feed.kind}:${feed.message}`
          : feed.kind === 'ready'
            ? `ready:${feed.refreshError ?? ''}:${feed.loadedAt}`
            : feed.kind;
    if (key === noticeKey) return;
    noticeKey = key;
    switch (feed.kind) {
      case 'checking':
        replaceContent(notices, [notice('neutral', null, 'Checking the server connection…')]);
        break;
      case 'loading':
        replaceContent(notices, [notice('neutral', null, 'Loading quotes…')]);
        break;
      case 'not-connected':
        replaceContent(notices, [
          envNotConnected({
            detail: feed.detail,
            variant: 'compact',
            onCheck: () => ctx.connection.check(),
          }),
        ]);
        break;
      case 'connection-error':
        replaceContent(notices, [
          notice('down', 'SERVER ERROR', feed.message),
          h(
            'div',
            { class: 'env-block__actions' },
            button('Retry', () => ctx.connection.check(), { small: true }),
          ),
        ]);
        break;
      case 'error':
        replaceContent(notices, [
          notice('down', 'QUOTES FAILED', feed.message),
          h(
            'div',
            { class: 'env-block__actions' },
            button('Retry', () => ctx.feeds.quotes.reload(), { small: true }),
          ),
        ]);
        break;
      case 'ready':
        replaceContent(
          notices,
          feed.refreshError === null
            ? []
            : [
                notice(
                  'caution',
                  'REFRESH FAILED',
                  `${feed.refreshError} Showing quotes loaded at ${formatUtcTime(feed.loadedAt, true)} UTC.`,
                ),
              ],
        );
        break;
    }
    notices.hidden = notices.childNodes.length === 0;
  }

  bind(scope, state, ({ feed, selection, source, now, auto, connection }) => {
    renderNotices(feed);

    const pollSeconds = connection.status === 'connected' ? connection.pollSeconds.quotes : null;
    const autoOn = auto && pollSeconds !== null;
    const showData = feed.kind === 'ready';
    autoButton.disabled = pollSeconds === null;
    refreshButton.disabled = pollSeconds === null || feed.kind === 'loading';
    setText(autoButton, autoOn ? `Auto ${pollSeconds}s` : 'Auto off');
    autoButton.setAttribute('aria-pressed', String(autoOn));
    setText(
      metaText,
      feed.kind === 'ready' && source !== null
        ? `${source.label} · loaded ${formatUtcTime(feed.loadedAt, true)} UTC`
        : feed.kind === 'loading'
          ? 'Loading quotes…'
          : '',
    );

    for (const row of rows) {
      const view = quoteView(feed, row.instrument.id, source, now);
      const verified = view.state === 'live' || view.state === 'delayed';
      const quote = view.quote;
      row.badge.hidden = !showData;
      if (showData) updateBadge(row.badge, view.state);
      setText(row.price, quote === null ? NO_VALUE : formatPrice(quote.last, row.instrument));
      setAttr(row.price, 'data-state', showData ? view.state : null);
      setText(row.change, quote === null ? NO_VALUE : formatPercent(quote.changePct));
      setAttr(row.change, 'data-dir', directionOf(quote?.changePct));
      setAttr(row.change, 'data-verified', String(verified));
      setAttr(
        row.change,
        'title',
        quote === null
          ? null
          : `Change versus ${quote.changeBasis}. Price as of ${formatUtcDateTime(quote.asOf)}.`,
      );
      if (view.note !== null && showData) {
        setText(row.sub, `No quote: ${view.note}`);
        setAttr(row.sub, 'data-tone', 'caution');
        setAttr(row.sub, 'title', view.note);
      } else {
        setText(row.sub, row.instrument.name);
        setAttr(row.sub, 'data-tone', null);
        setAttr(row.sub, 'title', null);
      }
      setAttr(row.button, 'aria-current', String(row.instrument.id === selection.instrumentId));
    }
  });

  applyFilter();
  return {
    el: panel.el,
    dispose: () => {
      scope.dispose();
    },
  };
}
