import type { AppContext } from '../../app/context.js';
import type { FeedState } from '../../app/feeds.js';
import {
  directionOf,
  formatAge,
  formatPercent,
  formatPrice,
  formatSignedPrice,
  formatUtcDateTime,
  formatUtcTime,
  NO_VALUE,
} from '../../core/format.js';
import { requireInstrument } from '../../core/instruments.js';
import { TIMEFRAMES, type Candle, type Timeframe } from '../../core/types.js';
import type { CandleSeries } from '../../data/provider.js';
import { bind, setAttr, setText } from '../bind.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { button, createPanel, envNotConnected, notice, stateBadge, updateBadge } from '../parts.js';
import { crosshairTimeLabel, defaultBarsFor, visibleRange } from './geometry.js';
import { attachChartInteraction } from './interaction.js';
import {
  emptyModel,
  hoverIndexOf,
  NO_CANDLES,
  resetView,
  withDefaultBars,
  withSeries,
  zoomAnchor,
  zoomModel,
  type ChartModel,
  type ChartSelection,
} from './model.js';
import { clearChart, drawChart, readChartTheme, type ChartTheme, type Frame } from './renderer.js';

const TIMEFRAME_TITLE: Readonly<Record<Timeframe, string>> = {
  M5: '5-minute',
  M15: '15-minute',
  M30: '30-minute',
  H1: '1-hour',
  H4: '4-hour',
  D1: 'daily',
};

const HELP_TEXT =
  'Drag to pan · Ctrl + wheel or pinch to zoom · double-click to reset · focus the chart, then ← → ' +
  'move the crosshair, + − zoom, 0 resets';

const ZOOM_STEP = 1.25;

interface TimeframeButton {
  readonly timeframe: Timeframe;
  readonly el: HTMLButtonElement;
}

/**
 * The candlestick chart panel: quote header, timeframe switch, canvas, and the plain-table twin
 * of the same bars. It draws only what the connected provider returned. Every state without
 * data (checking, loading, ENV NOT CONNECTION, error, empty) replaces the canvas with words.
 */
export function createChartPanel(ctx: AppContext): View {
  const scope = createScope();
  const win = ctx.window;
  const panel = createPanel({ title: 'Chart', id: 'chart-panel', flush: true, className: 'chart' });
  panel.meta.append(h('span', { text: 'All times UTC' }));

  // ---- header: instrument, price, timeframe, tools ----------------------------------------
  const symbol = h('span', { class: 'chart__symbol' });
  const name = h('span', { class: 'chart__name' });
  const price = h('span', { class: 'chart__price', text: NO_VALUE });
  const change = h('span', {
    class: 'chart__change',
    text: NO_VALUE,
    attrs: { 'data-dir': 'none' },
  });
  const quoteBadge = stateBadge('unavailable');
  const quoteNote = h('span', { class: 'chart__note', attrs: { hidden: true } });

  const timeframeButtons: TimeframeButton[] = TIMEFRAMES.map((timeframe) => ({
    timeframe,
    el: h('button', {
      class: 'seg__btn',
      text: timeframe,
      attrs: {
        type: 'button',
        'aria-pressed': 'false',
        title: `${TIMEFRAME_TITLE[timeframe]} candles`,
      },
      on: {
        click: () =>
          ctx.navigate({
            page: 'forex',
            instrumentId: ctx.selection.get().instrumentId,
            timeframe,
          }),
      },
    }),
  }));

  const zoomOut = button('−', () => setModel(zoomModel(model, zoomAnchor(model), ZOOM_STEP)), {
    small: true,
    title: 'Zoom out (show more bars)',
  });
  zoomOut.setAttribute('aria-label', 'Zoom out');
  const zoomIn = button('+', () => setModel(zoomModel(model, zoomAnchor(model), 1 / ZOOM_STEP)), {
    small: true,
    title: 'Zoom in (show fewer bars)',
  });
  zoomIn.setAttribute('aria-label', 'Zoom in');
  const resetButton = button('Reset', () => setModel(resetView(model)), {
    small: true,
    title: 'Default zoom, showing the newest bar',
  });
  const refreshButton = button('Refresh', () => ctx.feeds.candles.refresh(), {
    small: true,
    title: 'Fetch these candles from the provider again',
  });

  const bar = h(
    'div',
    { class: 'chart__bar' },
    h('div', { class: 'chart__id' }, symbol, name),
    h('div', { class: 'chart__quote' }, price, change, quoteBadge, quoteNote),
    h(
      'div',
      { class: 'chart__tools' },
      h(
        'div',
        { class: 'seg', attrs: { role: 'group', 'aria-label': 'Timeframe' } },
        ...timeframeButtons.map((entry) => entry.el),
      ),
      zoomOut,
      zoomIn,
      resetButton,
      refreshButton,
    ),
  );

  // ---- OHLC readout -----------------------------------------------------------------------
  const readoutTime = h('span', {});
  const readoutOpen = h('b', {});
  const readoutHigh = h('b', {});
  const readoutLow = h('b', {});
  const readoutClose = h('b', {});
  const readoutChange = h('b', {});
  const readout = h(
    'div',
    { class: 'chart__readout', attrs: { 'data-empty': 'true' } },
    readoutTime,
    h('span', {}, 'O ', readoutOpen),
    h('span', {}, 'H ', readoutHigh),
    h('span', {}, 'L ', readoutLow),
    h('span', {}, 'C ', readoutClose),
    h('span', {}, 'Chg ', readoutChange),
  );

  // ---- stage: canvas, overlay, announcements ----------------------------------------------
  const notices = h('div', { class: 'chart__notices', attrs: { hidden: true } });
  const canvas = h('canvas', {
    class: 'chart__canvas',
    attrs: {
      tabindex: 0,
      role: 'application',
      'aria-roledescription': 'candlestick chart',
      'aria-describedby': 'chart-help',
      'data-dragging': 'false',
    },
  });
  const overlay = h('div', { class: 'chart__overlay' });
  const live = h('div', {
    class: 'visually-hidden',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const stage = h('div', { class: 'chart__stage' }, canvas, overlay, live);

  // ---- status line ------------------------------------------------------------------------
  const seriesBadge = stateBadge('unavailable');
  const statusSeries = h('span', { class: 'chart__status-item' }, seriesBadge, ' Candles');
  const statusSource = h('span', {});
  const statusNewest = h('span', {});
  const statusRange = h('span', {});
  const statusLoaded = h('span', {});
  const help = h('span', { class: 'chart__help', attrs: { id: 'chart-help' }, text: HELP_TEXT });
  const status = h(
    'div',
    { class: 'chart__status' },
    statusSeries,
    statusSource,
    statusNewest,
    statusRange,
    statusLoaded,
    help,
  );

  // ---- table twin of the chart ------------------------------------------------------------
  const tableSummary = h('summary', { text: 'Data table' });
  const tableHost = h('div', { class: 'scroll-y' });
  const details = h(
    'details',
    { class: 'disclosure' },
    tableSummary,
    h('div', { class: 'disclosure__body' }, tableHost),
  );

  panel.body.append(bar, readout, notices, stage, status, details);

  // ---- state ------------------------------------------------------------------------------
  let model: ChartModel = emptyModel();
  let frame: Frame | null = null;
  let theme: ChartTheme | null = null;
  let drawHandle: number | null = null;
  let context2d: CanvasRenderingContext2D | null = null;
  let contextAsked = false;
  let canvasProblem: string | null = null;

  function setModel(next: ChartModel): void {
    if (next === model) return;
    const viewportChanged = next.viewport !== model.viewport;
    model = next;
    scheduleDraw();
    renderReadout();
    if (viewportChanged) renderStatus();
  }

  // ---- drawing ----------------------------------------------------------------------------
  function scheduleDraw(): void {
    if (drawHandle !== null) return;
    drawHandle = win.requestAnimationFrame(() => {
      drawHandle = null;
      draw();
    });
  }

  function draw(): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (width === 0 || height === 0) return;
    syncDefaultBars();
    if (!contextAsked) {
      contextAsked = true;
      context2d = canvas.getContext('2d');
      if (context2d === null) {
        canvasProblem =
          'This browser did not give the page a 2D canvas, so the chart cannot be drawn.';
        renderOverlay(ctx.feeds.candles.store.get());
        return;
      }
    }
    if (context2d === null) return;
    theme ??= readChartTheme(canvas);
    const dpr = win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const selection = model.selection;
    if (selection === null || model.candles.length === 0) {
      clearChart(context2d, width, height, dpr, theme);
      frame = null;
      return;
    }
    const hoverIndex = hoverIndexOf(model);
    frame = drawChart({
      ctx: context2d,
      width,
      height,
      dpr,
      candles: model.candles,
      instrument: requireInstrument(selection.instrumentId),
      timeframe: selection.timeframe,
      viewport: model.viewport,
      hover: hoverIndex === null ? null : { index: hoverIndex, y: model.hoverY },
      theme,
    });
  }

  /**
   * Narrow screens show fewer bars by default so candles stay legible. The plot is roughly the
   * stage minus the price axis; the exact width does not matter for choosing a bar count.
   */
  function syncDefaultBars(): void {
    const width = stage.clientWidth;
    if (width === 0) return;
    const next = withDefaultBars(model, defaultBarsFor(width - 80));
    if (next === model) return;
    setModel(next);
  }

  const observer = new ResizeObserver(() => {
    syncDefaultBars();
    scheduleDraw();
  });
  observer.observe(stage);
  scope.add(() => observer.disconnect());
  scope.add(() => {
    if (drawHandle !== null) win.cancelAnimationFrame(drawHandle);
    drawHandle = null;
  });

  // ---- feed -> model ----------------------------------------------------------------------
  function currentSelection(): ChartSelection {
    const { instrumentId, timeframe } = ctx.selection.get();
    return { instrumentId, timeframe };
  }

  /** The loaded series, but only if it is for the selection on screen. */
  function seriesFor(
    feed: FeedState<CandleSeries>,
    selection: ChartSelection,
  ): CandleSeries | null {
    if (feed.kind !== 'ready') return null;
    const { instrumentId, timeframe } = feed.value;
    return instrumentId === selection.instrumentId && timeframe === selection.timeframe
      ? feed.value
      : null;
  }

  function applyFeed(feed: FeedState<CandleSeries>): void {
    const selection = currentSelection();
    const series = seriesFor(feed, selection);
    syncDefaultBars();
    model = withSeries(model, selection, series === null ? NO_CANDLES : series.candles);
    renderOverlay(feed);
    renderNotices();
    renderReadout();
    renderStatus();
    renderControls();
    renderLabels();
    renderTable();
    scheduleDraw();
  }

  // ---- overlay: every state that has no chart ---------------------------------------------
  let overlayKey = '';
  function renderOverlay(feed: FeedState<CandleSeries>): void {
    const selection = currentSelection();
    const label = `${requireInstrument(selection.instrumentId).symbol} ${selection.timeframe}`;
    const hasChart = model.candles.length > 0 && canvasProblem === null;
    let key: string;
    let content: Child[] = [];
    if (canvasProblem !== null) {
      key = `canvas:${canvasProblem}`;
      content = [
        notice(
          'down',
          'CHART UNAVAILABLE',
          canvasProblem,
          ' The data table below lists every bar.',
        ),
      ];
    } else if (hasChart) {
      key = 'chart';
    } else {
      switch (feed.kind) {
        case 'checking':
          key = 'checking';
          content = [notice('neutral', null, 'Checking the server connection…')];
          break;
        case 'not-connected':
          key = `not-connected:${feed.detail}`;
          content = [
            envNotConnected({
              detail: feed.detail,
              note: 'The chart stays empty on purpose: Elstand never draws sample or simulated candles.',
              variant: 'fill',
              onCheck: () => ctx.connection.check(),
            }),
          ];
          break;
        case 'connection-error':
          key = `connection-error:${feed.message}`;
          content = [
            notice('down', 'SERVER ERROR', feed.message),
            h(
              'div',
              { class: 'env-block__actions' },
              button('Retry', () => ctx.connection.check(), { small: true }),
            ),
          ];
          break;
        case 'error':
          key = `error:${label}:${feed.message}`;
          content = [
            notice('down', 'CHART FAILED', `${label}: ${feed.message}`),
            h(
              'div',
              { class: 'env-block__actions' },
              button('Retry', () => ctx.feeds.candles.reload(), { small: true }),
            ),
          ];
          break;
        case 'ready':
          if (model.candles.length === 0 && seriesFor(feed, selection) !== null) {
            key = `empty:${label}`;
            content = [
              notice('caution', 'NO CANDLES', `The provider returned no ${label} bars.`),
              h(
                'div',
                { class: 'env-block__actions' },
                button('Reload', () => ctx.feeds.candles.reload(), { small: true }),
              ),
            ];
            break;
          }
          key = `loading:${label}`;
          content = [notice('neutral', null, `Loading ${label} candles…`)];
          break;
        case 'loading':
          key = `loading:${label}`;
          content = [notice('neutral', null, `Loading ${label} candles…`)];
          break;
      }
    }
    canvas.hidden = !hasChart;
    canvas.tabIndex = hasChart ? 0 : -1;
    overlay.hidden = hasChart;
    if (key === overlayKey) return;
    overlayKey = key;
    replaceContent(overlay, content);
  }

  // ---- notices above the chart (stale, refresh failed) ------------------------------------
  let noticeKey = '';
  function renderNotices(): void {
    const feed = ctx.feeds.candles.store.get();
    const series = ctx.selectedSeries.get();
    const quote = ctx.selectedQuote.get().quote;
    const items: HTMLElement[] = [];
    let key = '';
    if (feed.kind === 'ready' && model.candles.length > 0) {
      if (feed.refreshError !== null) {
        key += `refresh:${feed.refreshError}:${feed.loadedAt};`;
        items.push(
          notice(
            'caution',
            'REFRESH FAILED',
            `${feed.refreshError} Showing bars loaded at ${formatUtcTime(feed.loadedAt, true)} UTC.`,
          ),
        );
      }
      if (series.state === 'stale' && series.newestBarOpen !== null) {
        const closed = quote?.marketOpen === false;
        key += `stale:${series.newestBarOpen}:${closed};`;
        items.push(
          notice(
            'caution',
            'STALE',
            `The newest bar opened ${formatUtcDateTime(series.newestBarOpen)}. ` +
              (closed
                ? 'The provider reports the market as closed. '
                : 'The market may be closed, or the feed has stopped. ') +
              'Do not treat this chart as current.',
          ),
        );
      }
    }
    if (key === noticeKey) return;
    noticeKey = key;
    replaceContent(notices, items);
    notices.hidden = items.length === 0;
  }

  // ---- header: quote and instrument -------------------------------------------------------
  function renderQuote(): void {
    const instrument = requireInstrument(ctx.selection.get().instrumentId);
    const view = ctx.selectedQuote.get();
    const connected = ctx.source.get() !== null;
    const quote = view.quote;
    setText(symbol, instrument.symbol);
    setText(
      name,
      instrument.quoteNote === undefined
        ? instrument.name
        : `${instrument.name} · ${instrument.quoteNote}`,
    );
    setText(price, formatPrice(quote?.last, instrument));
    setAttr(price, 'data-state', connected ? view.state : null);
    const parts =
      quote === null
        ? []
        : [formatSignedPrice(quote.changeAbs, instrument), formatPercent(quote.changePct)].filter(
            (part) => part !== NO_VALUE,
          );
    setText(change, parts.length === 0 ? NO_VALUE : parts.join('  '));
    setAttr(change, 'data-dir', directionOf(quote?.changePct));
    setAttr(change, 'data-verified', String(view.state === 'live' || view.state === 'delayed'));
    setAttr(
      change,
      'title',
      quote === null
        ? null
        : `Change versus ${quote.changeBasis}. Price as of ${formatUtcDateTime(quote.asOf)}.`,
    );
    quoteBadge.hidden = !connected;
    if (connected) updateBadge(quoteBadge, view.state);
    const note = connected ? view.note : null;
    quoteNote.hidden = note === null;
    setText(quoteNote, note === null ? '' : `No quote: ${note}`);
  }

  // ---- header: controls -------------------------------------------------------------------
  function renderControls(): void {
    const selection = ctx.selection.get();
    for (const entry of timeframeButtons) {
      setAttr(entry.el, 'aria-pressed', String(entry.timeframe === selection.timeframe));
    }
    const hasData = model.candles.length > 0;
    zoomOut.disabled = !hasData;
    zoomIn.disabled = !hasData;
    resetButton.disabled = !hasData;
    refreshButton.disabled =
      ctx.connection.state.get().status !== 'connected' ||
      ctx.feeds.candles.store.get().kind === 'loading';
  }

  // ---- OHLC readout -----------------------------------------------------------------------
  function renderReadout(): void {
    const index = hoverIndexOf(model);
    const candle = index === null ? model.candles[model.candles.length - 1] : model.candles[index];
    const selection = model.selection;
    if (candle === undefined || selection === null) {
      setAttr(readout, 'data-empty', 'true');
      return;
    }
    const instrument = requireInstrument(selection.instrumentId);
    const delta = candle.close - candle.open;
    setAttr(readout, 'data-empty', 'false');
    setText(
      readoutTime,
      `${index === null ? 'Newest bar' : 'Bar'} ${formatUtcDateTime(candle.time)}`,
    );
    setText(readoutOpen, formatPrice(candle.open, instrument));
    setText(readoutHigh, formatPrice(candle.high, instrument));
    setText(readoutLow, formatPrice(candle.low, instrument));
    setText(readoutClose, formatPrice(candle.close, instrument));
    setText(
      readoutChange,
      `${formatSignedPrice(delta, instrument)} (${formatPercent((delta / candle.open) * 100)})`,
    );
  }

  /** Reads a bar aloud for the keyboard user. Sighted users get the same text in the readout. */
  function announce(index: number): void {
    const candle = model.candles[index];
    const selection = model.selection;
    if (candle === undefined || selection === null) return;
    const instrument = requireInstrument(selection.instrumentId);
    setText(
      live,
      `${crosshairTimeLabel(candle.time, selection.timeframe)} UTC. ` +
        `Open ${formatPrice(candle.open, instrument)}, high ${formatPrice(candle.high, instrument)}, ` +
        `low ${formatPrice(candle.low, instrument)}, close ${formatPrice(candle.close, instrument)}.`,
    );
  }

  // ---- status line ------------------------------------------------------------------------
  function renderStatus(): void {
    const feed = ctx.feeds.candles.store.get();
    const source = ctx.source.get();
    const showData = feed.kind === 'ready' && model.candles.length > 0 && source !== null;
    for (const item of [statusSeries, statusSource, statusNewest, statusRange, statusLoaded]) {
      item.hidden = !showData;
    }
    if (!showData || feed.kind !== 'ready' || source === null) return;

    const series = ctx.selectedSeries.get();
    updateBadge(seriesBadge, series.state);
    setText(statusSource, source.label);

    const newest = model.candles[model.candles.length - 1];
    const now = ctx.now.get();
    setText(
      statusNewest,
      newest === undefined
        ? ''
        : `Newest bar ${formatUtcDateTime(newest.time)} · ${formatAge(Math.max(0, now - newest.time))} ago`,
    );

    const range = visibleRange(model.viewport, model.candles.length);
    const first = range === null ? undefined : model.candles[range.first];
    const last = range === null ? undefined : model.candles[range.last];
    setText(
      statusRange,
      range === null || first === undefined || last === undefined
        ? ''
        : `Showing ${range.last - range.first + 1} of ${model.candles.length} bars · ` +
            `${formatUtcDateTime(first.time)} → ${formatUtcDateTime(last.time)}`,
    );

    const connection = ctx.connection.state.get();
    const pollSeconds = connection.status === 'connected' ? connection.pollSeconds.candles : null;
    const autoOn = ctx.autoRefresh.get() && pollSeconds !== null;
    setText(
      statusLoaded,
      `Loaded ${formatUtcTime(feed.loadedAt, true)} UTC · ${autoOn ? `auto-refresh ${pollSeconds}s` : 'auto-refresh off'}`,
    );
  }

  // ---- labels for assistive technology ----------------------------------------------------
  function renderLabels(): void {
    const selection = model.selection;
    if (selection === null) return;
    const instrument = requireInstrument(selection.instrumentId);
    setAttr(
      canvas,
      'aria-label',
      model.candles.length === 0
        ? `${instrument.symbol} ${selection.timeframe} chart. No candles are loaded.`
        : `${instrument.symbol} ${selection.timeframe} candlestick chart with ${model.candles.length} bars. ` +
            'The same bars are listed in the data table below the chart.',
    );
  }

  // ---- data table -------------------------------------------------------------------------
  let tableCandles: readonly Candle[] | null = null;
  let tableSelection: ChartSelection | null = null;
  function renderTable(): void {
    const count = model.candles.length;
    setText(tableSummary, count === 0 ? 'Data table' : `Data table · ${count} bars, newest first`);
    if (!details.open) return;
    if (tableCandles === model.candles && tableSelection === model.selection) return;
    tableCandles = model.candles;
    tableSelection = model.selection;
    const selection = model.selection;
    if (selection === null || count === 0) {
      replaceContent(tableHost, [h('p', { class: 'wl__empty', text: 'No bars are loaded.' })]);
      return;
    }
    const instrument = requireInstrument(selection.instrumentId);
    const body = h('tbody');
    for (let index = count - 1; index >= 0; index -= 1) {
      const candle = model.candles[index];
      if (candle === undefined) continue;
      body.append(
        h(
          'tr',
          {},
          h('td', { text: formatUtcDateTime(candle.time) }),
          h('td', { class: 'num', text: formatPrice(candle.open, instrument) }),
          h('td', { class: 'num', text: formatPrice(candle.high, instrument) }),
          h('td', { class: 'num', text: formatPrice(candle.low, instrument) }),
          h('td', { class: 'num', text: formatPrice(candle.close, instrument) }),
        ),
      );
    }
    replaceContent(tableHost, [
      h(
        'table',
        { class: 'tbl' },
        h('caption', {
          class: 'visually-hidden',
          text: `${instrument.symbol} ${selection.timeframe} bars, newest first, times in UTC`,
        }),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { text: 'Open time (UTC)', attrs: { scope: 'col' } }),
            h('th', { class: 'num', text: 'Open', attrs: { scope: 'col' } }),
            h('th', { class: 'num', text: 'High', attrs: { scope: 'col' } }),
            h('th', { class: 'num', text: 'Low', attrs: { scope: 'col' } }),
            h('th', { class: 'num', text: 'Close', attrs: { scope: 'col' } }),
          ),
        ),
        body,
      ),
    ]);
  }
  details.addEventListener('toggle', renderTable);

  // ---- wiring -----------------------------------------------------------------------------
  scope.add(
    attachChartInteraction({
      canvas,
      model: () => model,
      frame: () => frame,
      update: setModel,
      announce,
    }),
  );

  renderQuote();
  bind(scope, ctx.feeds.candles.store, applyFeed);
  bind(scope, ctx.selection, () => {
    renderQuote();
    applyFeed(ctx.feeds.candles.store.get());
  });
  scope.add(
    ctx.selectedQuote.subscribe(() => {
      renderQuote();
      renderNotices();
    }),
  );
  scope.add(
    ctx.selectedSeries.subscribe(() => {
      renderNotices();
      renderStatus();
    }),
  );
  scope.add(ctx.now.subscribe(() => renderStatus()));
  scope.add(
    ctx.source.subscribe(() => {
      renderQuote();
      renderStatus();
    }),
  );
  scope.add(ctx.autoRefresh.subscribe(() => renderStatus()));
  scope.add(
    ctx.connection.state.subscribe(() => {
      renderControls();
      renderStatus();
    }),
  );

  return {
    el: panel.el,
    dispose: () => scope.dispose(),
  };
}
