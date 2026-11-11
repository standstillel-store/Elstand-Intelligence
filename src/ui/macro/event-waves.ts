import type { AppContext } from '../../app/context.js';
import { ENV_NOT_CONNECTED } from '../../core/connection-text.js';
import {
  countdownText,
  isWaveEligible,
  wavePath,
  waveProximity,
  WAVE_HEIGHT,
  WAVE_SETTLE_MS,
  WAVE_WIDTH,
} from '../../core/event-waves.js';
import { formatUtcDateTime, formatZoned } from '../../core/format.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import { safeHttpUrl } from '../../core/url.js';
import { screenCalendar } from '../../data/macro-validate.js';
import type { CalendarEvent, FeedResult } from '../../data/macro.js';
import { createScope, h, replaceContent, svg, type View } from '../dom.js';
import { createPanel, notice } from '../parts.js';
import {
  attributionLine,
  failedBlock,
  loadingNotice,
  originNotices,
  rightsParts,
  screeningNotices,
  unavailableBlock,
} from './states.js';

/** Shown, word for word, when there is no economic-calendar provider to draw waves from. */
export const EVENT_WAVES_DISCONNECTED =
  'ENV NOT CONNECTED — Economic calendar provider unavailable. Surface VI event waves are disabled.';

export const EVENT_WAVES_DISCLAIMER =
  'A wave shows how close a scheduled event is: it rises over the 24 hours before the stated ' +
  'time and settles over the hour after. It is not measured or implied volatility and not a ' +
  'forecast of what any price will do.';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const KEY = 'calendar';

const impactText = (event: CalendarEvent): string =>
  event.impact === null
    ? 'NOT RATED by the source'
    : `${event.impact.level.toUpperCase()} · rated by ${event.impact.classifiedBy}`;

function wave(proximity: number): { readonly el: SVGElement; readonly path: SVGElement } {
  const path = svg('path', { d: wavePath(proximity), class: 'wave__line', fill: 'none' });
  const el = svg(
    'svg',
    {
      class: 'wave__svg',
      viewBox: `0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`,
      width: WAVE_WIDTH,
      height: WAVE_HEIGHT,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    path,
  );
  return { el, path };
}

function inspector(event: CalendarEvent): HTMLElement {
  const link = safeHttpUrl(event.source.url);
  const entries: [string, string | HTMLElement][] = [
    ['Scheduled', `${formatZoned(event.timeMs, 'UTC')} · ${formatZoned(event.timeMs)}`],
    ['Impact', impactText(event)],
  ];
  if (event.status !== undefined) entries.push(['Status', event.status]);
  if (event.stage !== undefined) entries.push(['Stage', event.stage]);
  if (event.actual !== null) entries.push(['Actual', event.actual]);
  if (event.forecast !== null) entries.push(['Forecast', event.forecast]);
  if (event.previous !== null) entries.push(['Previous', event.previous]);
  if (event.surprise !== undefined) {
    const { value, unit, basis } = event.surprise;
    entries.push([
      'Surprise',
      `${value > 0 ? '+' : ''}${value} ${unit} · ${basis} · CALCULATED by Elstand from two figures the source supplied`,
    ]);
  }
  entries.push([
    'Source',
    link === null
      ? event.source.name
      : h('a', {
          text: event.source.name,
          attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
        }),
  ]);
  entries.push(...rightsParts(event.source.rights));
  entries.push(['Retrieved', formatUtcDateTime(event.source.retrievedAt)]);
  return h(
    'dl',
    { class: 'kv wave__body' },
    ...entries.flatMap(([term, value]) => [h('dt', { text: term }), h('dd', {}, value)]),
  );
}

interface Row {
  readonly el: HTMLElement;
  tick(now: number): void;
}

function eventRow(event: CalendarEvent, now: number): Row {
  const drawing = wave(waveProximity(event.timeMs, now));
  const countdown = h('span', { class: 'wave__countdown' });
  let lastPath = '';
  let lastText = '';
  const tick = (at: number): void => {
    const text = countdownText(event.timeMs, at);
    if (text !== lastText) {
      lastText = text;
      countdown.textContent = text;
    }
    const d = wavePath(waveProximity(event.timeMs, at));
    if (d !== lastPath) {
      lastPath = d;
      drawing.path.setAttribute('d', d);
    }
  };
  tick(now);
  const el = h(
    'details',
    { class: 'wave', attrs: { 'data-event-id': event.id } },
    h(
      'summary',
      { class: 'wave__summary' },
      drawing.el,
      h(
        'span',
        { class: 'wave__text' },
        h('strong', { class: 'wave__title', text: event.title }),
        h(
          'span',
          { class: 'wave__meta' },
          h('span', {
            text: event.country === null ? event.currency : `${event.currency} · ${event.country}`,
          }),
          h('time', {
            text: formatZoned(event.timeMs, 'UTC'),
            attrs: { datetime: new Date(event.timeMs).toISOString() },
          }),
          countdown,
          h('span', {
            text: event.impact === null ? 'NOT RATED' : event.impact.level.toUpperCase(),
          }),
        ),
      ),
    ),
    inspector(event),
  );
  return { el, tick };
}

/**
 * Event proximity, drawn from the economic calendar's verified events and nothing else. This is
 * the owner's "Surface VI" layer on the volatility surface page: it needs only a calendar, so it
 * works without the options data the surface itself waits for. With no calendar it says so, in
 * the owner's words, and draws nothing.
 */
export function createEventWavesModule(ctx: AppContext): View {
  const scope = createScope();
  const panel = createPanel({ title: 'Event proximity · Surface VI', id: 'event-waves-panel' });
  const resource = createKeyedResource<FeedResult<CalendarEvent>>(
    (_key, signal) => {
      const from = Math.floor(ctx.now.get() / DAY_MS) * DAY_MS;
      return ctx.macro.feed.getCalendar(
        { fromMs: from, toMs: from + WINDOW_DAYS * DAY_MS },
        signal,
      );
    },
    () => ctx.now.get(),
  );
  const host = h('div', { class: 'waves' });
  const metaText = h('span', {});
  panel.meta.append(metaText);

  let showEvery = false;
  const toggle = h('input', { attrs: { type: 'checkbox', id: 'waves-all' } });
  toggle.addEventListener('change', () => {
    showEvery = toggle.checked;
    render(resource.store(KEY).get());
  });
  const toggleLabel = h(
    'label',
    { class: 'field field--inline', attrs: { for: 'waves-all' } },
    toggle,
    'Show every event with a stated time, not only those the source rated high',
  );
  panel.body.append(
    h(
      'div',
      { class: 'macro__body' },
      h('p', { class: 'macro__help', text: EVENT_WAVES_DISCLAIMER }),
      h('p', {
        class: 'macro__help',
        text: 'Countdowns use this device’s clock. Times are shown in UTC and in this browser’s zone.',
      }),
      toggleLabel,
      host,
    ),
  );

  let rows: Row[] = [];

  function disabled(children: readonly (HTMLElement | null)[]): void {
    rows = [];
    toggle.disabled = true;
    metaText.textContent = '';
    replaceContent(host, children);
  }

  function render(state: Loadable<FeedResult<CalendarEvent>>): void {
    switch (state.status) {
      case 'idle':
      case 'loading':
        disabled([loadingNotice('Loading the economic calendar…')]);
        return;
      case 'error':
        disabled([
          failedBlock(
            'CALENDAR FAILED',
            `${state.message} Surface VI event waves are disabled.`,
            () => resource.reload(KEY),
          ),
        ]);
        return;
      case 'ready': {
        const result = state.value;
        if (result.status === 'unavailable') {
          const connected =
            result.origin !== undefined && result.origin.provenance.state !== 'ENV NOT CONNECTED';
          disabled(
            connected
              ? [
                  unavailableBlock({
                    source: 'A calendar provider',
                    reason: `${result.reason} Surface VI event waves are disabled.`,
                    origin: result.origin,
                    onRetry: () => resource.reload(KEY),
                  }),
                ]
              : [
                  h(
                    'div',
                    { class: 'env-block env-block--compact' },
                    h('p', { class: 'env-block__label', text: ENV_NOT_CONNECTED }),
                    h('p', { class: 'env-block__detail', text: EVENT_WAVES_DISCONNECTED }),
                  ),
                ],
          );
          return;
        }
        toggle.disabled = false;
        const now = ctx.now.get();
        // The same screening as the lists: an event that names no source, no currency or no valid
        // time is not drawn, and the page says how many were left out and why.
        const screened = screenCalendar(result.items, { engineConfigured: false });
        const stated = screened.items.filter(isWaveEligible);
        const upcoming = stated
          .filter((event) => event.timeMs >= now - WAVE_SETTLE_MS)
          .sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
        const rated = upcoming.filter((event) => event.impact?.level === 'high');
        const shown = showEvery ? upcoming : rated;
        const dateOnly = screened.items.length - stated.length;
        rows = shown.map((event) => eventRow(event, now));
        metaText.textContent = `${result.origin?.provenance.state ?? 'as received'} · retrieved ${formatUtcDateTime(result.asOf)}`;
        replaceContent(host, [
          ...originNotices(result.origin).map((entry) => entry),
          ...screeningNotices({ ...screened, interpretationsRemoved: 0 }),
          ...(shown.length === 0
            ? [
                h('p', {
                  class: 'feed__empty',
                  text: showEvery
                    ? 'The calendar has no event with a stated time in its window.'
                    : 'No event in the calendar’s window is rated high by its source. ' +
                      'Elstand assigns no rating of its own.',
                }),
              ]
            : rows.map((row) => row.el)),
          dateOnly > 0
            ? notice(
                'neutral',
                null,
                `${dateOnly} event${dateOnly === 1 ? ' gives' : 's give'} a date or a cancelled schedule and no stated time, so ${dateOnly === 1 ? 'it is' : 'they are'} not drawn.`,
              )
            : null,
          attributionLine(result.origin),
        ]);
      }
    }
  }

  scope.add(resource.store(KEY).subscribe(render));
  scope.add(
    ctx.now.subscribe((now) => {
      for (const row of rows) row.tick(now);
    }),
  );
  render(resource.store(KEY).get());
  resource.ensure(KEY);
  return { el: panel.el, dispose: () => scope.dispose() };
}
