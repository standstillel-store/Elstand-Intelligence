import type { AppContext } from '../../app/context.js';
import type { FeedState } from '../../app/feeds.js';
import { classifyFreshness } from '../../core/freshness.js';
import {
  formatAge,
  formatNumber,
  formatPrice,
  formatUtcDateTime,
  NO_VALUE,
} from '../../core/format.js';
import { requireInstrument, type Instrument } from '../../core/instruments.js';
import { derived } from '../../core/store.js';
import type { DataState, SourceInfo } from '../../core/types.js';
import {
  spreadOf,
  withCumulative,
  type CumulativeLevel,
  type DepthLevel,
  type DepthResult,
  type DepthSnapshot,
} from '../../data/depth.js';
import { bind, setAttr, setText } from '../bind.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { DEPTH_PANEL_ID } from '../ids.js';
import { button, createPanel, envNotConnected, notice, stateBadge, updateBadge } from '../parts.js';

/** Levels drawn per side. A deeper book is cut off, and the panel says how many were dropped. */
export const MAX_DEPTH_LEVELS = 10;

const NEEDS_A_NAMED_VENUE =
  'Depth appears here only when the connected provider returns an order book from a named venue. ' +
  'Elstand never estimates, interpolates or draws a book of its own.';

/** The fewest decimals (up to four) that show every size exactly, so no size is rounded for display. */
export function sizeDigits(levels: readonly DepthLevel[]): number {
  for (let digits = 0; digits < 4; digits += 1) {
    if (levels.every((level) => Number(level.size.toFixed(digits)) === level.size)) return digits;
  }
  return 4;
}

/** Width of a depth bar as a percentage of the larger side's visible total. */
export function barPercent(cumulative: number, largestCumulative: number): number {
  if (!(largestCumulative > 0) || !Number.isFinite(cumulative)) return 0;
  return Math.min(100, Math.max(0, (cumulative / largestCumulative) * 100));
}

interface SideView {
  readonly el: HTMLElement;
  readonly cut: number;
}

function buildSide(
  side: 'bid' | 'ask',
  levels: readonly CumulativeLevel[],
  largest: number,
  instrument: Instrument,
  digits: number,
  venue: string,
  sizeUnit: string,
  totalLevels: number,
): SideView {
  const label = side === 'bid' ? 'Bids' : 'Asks';
  const best = levels[0];
  const rows = levels.map((level) => {
    const bar = h('div', { class: 'depth__bar', attrs: { 'aria-hidden': 'true' } });
    bar.style.setProperty('--depth', `${barPercent(level.cumulative, largest).toFixed(1)}%`);
    return h(
      'div',
      { class: 'depth__row', attrs: { role: 'row' } },
      bar,
      h('span', {
        class: 'depth__cell depth__price',
        text: formatPrice(level.price, instrument),
        attrs: { role: 'cell' },
      }),
      h('span', {
        class: 'depth__cell',
        text: formatNumber(level.size, digits),
        attrs: { role: 'cell' },
      }),
      h('span', {
        class: 'depth__cell',
        text: formatNumber(level.cumulative, digits),
        attrs: { role: 'cell' },
      }),
    );
  });
  const columns = ['Price', `Size (${sizeUnit})`, 'Total'].map((name, index) =>
    h('span', {
      class: index === 0 ? 'depth__cell depth__price' : 'depth__cell',
      text: name,
      attrs: { role: 'columnheader' },
    }),
  );
  const table = h(
    'div',
    { class: 'depth__table', attrs: { role: 'table', 'aria-label': `${label} at ${venue}` } },
    h('div', { class: 'depth__row depth__row--head', attrs: { role: 'row' } }, ...columns),
    ...rows,
  );
  const el = h(
    'section',
    { class: 'depth__side', attrs: { 'data-side': side } },
    h(
      'h3',
      { class: 'depth__side-title' },
      h('span', { text: label }),
      h('span', {
        class: 'depth__best',
        text: best === undefined ? NO_VALUE : `best ${formatPrice(best.price, instrument)}`,
      }),
    ),
    table,
  );
  return { el, cut: Math.max(0, totalLevels - levels.length) };
}

interface BookView {
  readonly el: HTMLElement;
  readonly age: HTMLElement;
  readonly staleNote: HTMLElement;
  readonly snapshot: DepthSnapshot;
}

function buildBook(snapshot: DepthSnapshot, instrument: Instrument): BookView {
  const bids = withCumulative(snapshot.bids).slice(0, MAX_DEPTH_LEVELS);
  const asks = withCumulative(snapshot.asks).slice(0, MAX_DEPTH_LEVELS);
  const largest = Math.max(bids.at(-1)?.cumulative ?? 0, asks.at(-1)?.cumulative ?? 0);
  const digits = sizeDigits([...snapshot.bids, ...snapshot.asks]);
  const bidSide = buildSide(
    'bid',
    bids,
    largest,
    instrument,
    digits,
    snapshot.venue,
    snapshot.sizeUnit,
    snapshot.bids.length,
  );
  const askSide = buildSide(
    'ask',
    asks,
    largest,
    instrument,
    digits,
    snapshot.venue,
    snapshot.sizeUnit,
    snapshot.asks.length,
  );
  const spread = spreadOf(snapshot);
  const age = h('span', { class: 'mono' });
  const staleNote = notice(
    'caution',
    'STALE',
    'This book is older than the provider’s freshness limit. Do not treat it as current.',
  );
  staleNote.hidden = true;

  const cutNotes: string[] = [];
  if (bidSide.cut > 0 || askSide.cut > 0) {
    cutNotes.push(
      `Showing the best ${MAX_DEPTH_LEVELS} levels per side. ` +
        `${snapshot.bids.length} bid and ${snapshot.asks.length} ask levels were reported.`,
    );
  }

  const el = h(
    'div',
    { class: 'depth__book', attrs: { 'data-state': 'unavailable' } },
    h(
      'p',
      { class: 'depth__scope' },
      'This book describes ',
      h('strong', { text: snapshot.venue }),
      ' only. It is not a consolidated market book.',
    ),
    staleNote,
    h(
      'dl',
      { class: 'kv depth__facts' },
      h('dt', { text: 'Venue' }),
      h('dd', { text: snapshot.venue }),
      h('dt', { text: 'Observed' }),
      h('dd', {}, formatUtcDateTime(snapshot.asOf), ' · ', age, ' ago'),
      h('dt', { text: 'Size unit' }),
      h('dd', { text: snapshot.sizeUnit }),
    ),
    h('div', { class: 'depth__sides' }, bidSide.el, askSide.el),
    h('p', {
      class: 'depth__spread mono',
      text: `Spread ${spread === null ? NO_VALUE : formatPrice(spread, instrument)} (best ask minus best bid)`,
    }),
    h('p', {
      class: 'depth__legend',
      text:
        `Total is cumulative from the best level. Bar length is the cumulative total relative to ` +
        `the larger side. ${cutNotes.join(' ')}`.trim(),
    }),
    h('p', { class: 'depth__note', text: instrument.depthNote }),
  );
  return { el, age, staleNote, snapshot };
}

/**
 * Market depth for the selected instrument. Spot FX and gold are traded over the counter, so
 * a book always belongs to one named venue; the panel shows that venue and the observation
 * time beside every number and never presents a book as the whole market. When no book exists
 * it says so and why. It has no sample book.
 */
export function createDepthPanel(ctx: AppContext): View {
  const scope = createScope();
  const panel = createPanel({ title: 'Market depth', id: DEPTH_PANEL_ID, className: 'depth' });

  const venueText = h('span', {});
  const badge = stateBadge('unavailable');
  badge.hidden = true;
  const refresh = button('Refresh', () => ctx.feeds.depth.refresh(), { small: true });
  refresh.hidden = true;
  panel.meta.append(venueText, badge, refresh);

  const content = h('div', { class: 'depth__content', attrs: { 'aria-live': 'polite' } });
  panel.body.append(content);

  let book: BookView | null = null;
  let source: SourceInfo | null = null;
  let renderedFeed: FeedState<DepthResult> | null = null;
  let renderedInstrument = '';

  function updateFreshness(now: number): void {
    if (book === null) return;
    const dataState: DataState =
      source === null
        ? 'unavailable'
        : classifyFreshness({
            mode: source.mode,
            asOf: book.snapshot.asOf,
            now,
            staleAfterMs: source.staleAfterMs,
          });
    updateBadge(badge, dataState);
    setAttr(book.el, 'data-state', dataState);
    book.staleNote.hidden = dataState !== 'stale';
    setText(book.age, formatAge(Math.max(0, now - book.snapshot.asOf)));
  }

  function show(children: readonly Child[]): void {
    replaceContent(content, children);
  }

  function render(feed: FeedState<DepthResult>, instrument: Instrument): void {
    book = null;
    badge.hidden = true;
    refresh.hidden = true;
    setText(venueText, '');

    switch (feed.kind) {
      case 'checking':
        show([notice('neutral', null, 'Checking the server connection…')]);
        return;
      case 'not-connected':
        show([
          envNotConnected({
            detail: feed.detail,
            note: NEEDS_A_NAMED_VENUE,
            variant: 'compact',
            onCheck: () => ctx.connection.check(),
          }),
        ]);
        return;
      case 'connection-error':
        show([
          notice('down', 'SERVER ERROR', feed.message),
          h(
            'div',
            { class: 'env-block__actions' },
            button('Retry', () => ctx.connection.check(), { small: true }),
          ),
        ]);
        return;
      case 'loading':
        show([notice('neutral', null, `Loading depth for ${instrument.symbol}…`)]);
        return;
      case 'error':
        show([
          notice('down', 'DEPTH FAILED', feed.message),
          h(
            'div',
            { class: 'env-block__actions' },
            button('Retry', () => ctx.feeds.depth.reload(), { small: true }),
          ),
        ]);
        return;
      case 'ready': {
        const result = feed.value;
        if (result.status === 'unavailable') {
          show([
            notice('caution', 'DEPTH UNAVAILABLE', result.reason),
            h('p', { class: 'depth__note', text: instrument.depthNote }),
            h('p', { class: 'depth__note', text: NEEDS_A_NAMED_VENUE }),
          ]);
          return;
        }
        if (result.snapshot.instrumentId !== instrument.id) {
          // A book for another instrument is never shown under this selection.
          show([notice('neutral', null, `Loading depth for ${instrument.symbol}…`)]);
          return;
        }
        book = buildBook(result.snapshot, instrument);
        show([book.el]);
        setText(venueText, result.snapshot.venue);
        badge.hidden = false;
        refresh.hidden = false;
        updateFreshness(ctx.now.get());
      }
    }
  }

  const state = derived(
    [ctx.feeds.depth.store, ctx.selection, ctx.source],
    (feed, selection, src) => ({
      feed,
      selection,
      src,
    }),
  );
  scope.add(() => state.dispose());
  bind(scope, state, ({ feed, selection, src }) => {
    source = src;
    if (feed !== renderedFeed || selection.instrumentId !== renderedInstrument) {
      renderedFeed = feed;
      renderedInstrument = selection.instrumentId;
      render(feed, requireInstrument(selection.instrumentId));
    } else {
      updateFreshness(ctx.now.get());
    }
  });
  bind(scope, ctx.now, updateFreshness);

  return { el: panel.el, dispose: () => scope.dispose() };
}
