import type { AppContext } from '../../app/context.js';
import { formatUtcDate, formatUtcDateTime, formatZoned } from '../../core/format.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import { safeHttpUrl } from '../../core/url.js';
import {
  screenCalendar,
  screenNews,
  type ScreenOptions,
  type Screened,
} from '../../data/macro-validate.js';
import type {
  CalendarEvent,
  FeedResult,
  ImpactClassification,
  NewsItem,
  SourceAttribution,
} from '../../data/macro.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { createPanel, notice } from '../parts.js';
import { failedBlock, loadingNotice, noSourceBlock } from './states.js';

const DAY_MS = 86_400_000;
export const CALENDAR_WINDOW_DAYS = 7;
const CALENDAR_KEY = 'calendar';
const NEWS_KEY = 'news';
const ALL = 'ALL';

const MARKET_ZONES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

function browserZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : null;
  } catch {
    return null;
  }
}

/** UTC and four market centers, plus the browser's own zone when it is none of those. */
export function zoneOptions(
  browser: string | null = browserZone(),
): { id: string; label: string }[] {
  const options = MARKET_ZONES.map((zone) => ({ ...zone }));
  if (browser !== null && !options.some((zone) => zone.id === browser)) {
    options.push({ id: browser, label: `Your browser (${browser})` });
  }
  return options;
}

function impactBadge(impact: ImpactClassification | null): Child[] {
  if (impact === null) {
    return [
      h('span', {
        class: 'impact',
        text: 'UNCLASSIFIED',
        attrs: {
          'data-level': 'none',
          title: 'The source did not rate this item. Elstand assigns no impact of its own.',
        },
      }),
    ];
  }
  return [
    h('span', {
      class: 'impact',
      text: impact.level.toUpperCase(),
      attrs: {
        'data-level': impact.level,
        title: `Rated ${impact.level} by ${impact.classifiedBy}`,
      },
    }),
    h('span', { text: `rated by ${impact.classifiedBy}` }),
  ];
}

function sourceLine(source: SourceAttribution): HTMLElement {
  const link = safeHttpUrl(source.url);
  return h(
    'div',
    { class: 'feed__meta' },
    h(
      'span',
      {},
      'Source: ',
      link === null
        ? source.name
        : h('a', {
            text: source.name,
            attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
          }),
    ),
    h('span', { text: `retrieved ${formatUtcDateTime(source.retrievedAt)}` }),
  );
}

function interpretation(text: string | null): HTMLElement | null {
  if (text === null) return null;
  return h(
    'p',
    { class: 'feed__elvoid' },
    h('strong', { text: 'ELVOID interpretation' }),
    ' ',
    text,
  );
}

function figures(event: CalendarEvent): HTMLElement {
  const parts: [string, string | null][] = [
    ['Actual', event.actual],
    ['Forecast', event.forecast],
    ['Previous', event.previous],
  ];
  const present = parts.filter((part): part is [string, string] => part[1] !== null);
  return h(
    'div',
    { class: 'feed__meta' },
    ...(present.length === 0
      ? [h('span', { text: 'No figures published yet' })]
      : present.map(([label, value]) => h('span', {}, `${label} `, h('b', { text: value })))),
  );
}

export function calendarItem(event: CalendarEvent, zone: string): HTMLElement {
  return h(
    'article',
    { class: 'feed__item', attrs: { 'data-event-id': event.id } },
    h(
      'div',
      { class: 'feed__meta' },
      h('time', {
        text: formatZoned(event.timeMs, zone),
        attrs: { datetime: new Date(event.timeMs).toISOString() },
      }),
      h('span', {
        text: event.country === null ? event.currency : `${event.currency} · ${event.country}`,
      }),
      ...impactBadge(event.impact),
    ),
    h('h4', { class: 'feed__title', text: event.title }),
    figures(event),
    sourceLine(event.source),
    interpretation(event.elvoidInterpretation),
  );
}

export function newsItem(item: NewsItem, zone: string): HTMLElement {
  const link = safeHttpUrl(item.url);
  return h(
    'article',
    { class: 'feed__item', attrs: { 'data-news-id': item.id } },
    h(
      'div',
      { class: 'feed__meta' },
      h('time', {
        text: formatZoned(item.publishedAt, zone),
        attrs: { datetime: new Date(item.publishedAt).toISOString() },
      }),
      h('span', {
        text: item.currencies.length === 0 ? 'No currency tagged' : item.currencies.join(' '),
      }),
      ...impactBadge(item.impact),
    ),
    h(
      'h4',
      { class: 'feed__title' },
      link === null
        ? item.headline
        : h('a', {
            text: item.headline,
            attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
          }),
    ),
    sourceLine(item.source),
    interpretation(item.elvoidInterpretation),
  );
}

function screeningNotices<T>(screened: Screened<T>): HTMLElement[] {
  const notices: HTMLElement[] = [];
  const first = screened.rejected[0];
  if (first !== undefined) {
    notices.push(
      notice(
        'caution',
        'ITEMS REJECTED',
        `${screened.rejected.length} item${screened.rejected.length === 1 ? ' was' : 's were'} not shown ` +
          `because ${screened.rejected.length === 1 ? 'it was' : 'they were'} unattributed or malformed. ` +
          `First: ${first.id} ${first.reason}.`,
      ),
    );
  }
  if (screened.interpretationsRemoved > 0) {
    notices.push(
      notice(
        'caution',
        'INTERPRETATION REMOVED',
        `${screened.interpretationsRemoved} ELVOID interpretation${screened.interpretationsRemoved === 1 ? ' was' : 's were'} ` +
          'removed. No ELVOID engine is connected, and only an engine may supply one.',
      ),
    );
  }
  return notices;
}

function matchesCurrency(currencies: readonly string[], selected: string): boolean {
  return selected === ALL || currencies.includes(selected);
}

/**
 * The news and calendar module. Every item shows its source, and its impact exactly as the
 * source rated it (or UNCLASSIFIED); times follow the chosen zone. ELVOID interpretation
 * appears only when an engine supplied it. With no provider, each list says ENV NOT CONNECTION.
 */
export function createNewsCalendarModule(ctx: AppContext): View {
  const scope = createScope();

  const calendarResource = createKeyedResource<FeedResult<CalendarEvent>>(
    (_key, signal) => {
      const from = Math.floor(ctx.now.get() / DAY_MS) * DAY_MS;
      return ctx.macro.feed.getCalendar(
        { fromMs: from, toMs: from + CALENDAR_WINDOW_DAYS * DAY_MS },
        signal,
      );
    },
    () => ctx.now.get(),
  );
  const newsResource = createKeyedResource<FeedResult<NewsItem>>(
    (_key, signal) => ctx.macro.feed.getNews(signal),
    () => ctx.now.get(),
  );

  // ---- controls -----------------------------------------------------------------------------
  const zones = zoneOptions();
  let zone = 'UTC';
  let currency = ALL;
  const zoneSelect = h(
    'select',
    { attrs: { id: 'macro-zone' } },
    ...zones.map((option) => h('option', { text: option.label, attrs: { value: option.id } })),
  );
  zoneSelect.value = zone;
  zoneSelect.addEventListener('change', () => {
    zone = zoneSelect.value;
    renderCalendar();
    renderNews();
  });
  const currencySelect = h(
    'select',
    { attrs: { id: 'macro-currency' } },
    h('option', { text: 'All currencies', attrs: { value: ALL } }),
  );
  currencySelect.addEventListener('change', () => {
    currency = currencySelect.value;
    renderCalendar();
    renderNews();
  });
  const controls = h(
    'div',
    { class: 'macro__controls' },
    h('label', { class: 'field', attrs: { for: 'macro-zone' } }, 'Time zone', zoneSelect),
    h('label', { class: 'field', attrs: { for: 'macro-currency' } }, 'Currency', currencySelect),
  );

  // ---- the two lists --------------------------------------------------------------------------
  const calendarPanel = createPanel({
    title: 'Economic calendar',
    id: 'calendar-panel',
    flush: true,
  });
  const newsPanel = createPanel({ title: 'News', id: 'news-panel', flush: true });
  const calendarMeta = h('span', {});
  const newsMeta = h('span', {});
  calendarPanel.meta.append(calendarMeta);
  newsPanel.meta.append(newsMeta);
  const calendarHost = h('div', { class: 'feed' });
  const newsHost = h('div', { class: 'feed' });
  calendarPanel.body.append(calendarHost);
  newsPanel.body.append(newsHost);

  const engineConfigured = (): boolean => ctx.elvoid.store.get().engine !== null;
  const screenOptions = (): ScreenOptions => ({ engineConfigured: engineConfigured() });

  let calendar: Loadable<FeedResult<CalendarEvent>> = calendarResource.store(CALENDAR_KEY).get();
  let news: Loadable<FeedResult<NewsItem>> = newsResource.store(NEWS_KEY).get();

  /**
   * Keeps the currency list in step with what the source returned, and turns off a control that
   * would change nothing: with no items on screen there is no time to re-zone and nothing to
   * filter, and a control that does nothing should not look like it works.
   */
  function syncControls(): void {
    const codes = new Set<string>();
    let itemCount = 0;
    if (calendar.status === 'ready' && calendar.value.status === 'available') {
      for (const event of screenCalendar(calendar.value.items, screenOptions()).items) {
        codes.add(event.currency);
        itemCount += 1;
      }
    }
    if (news.status === 'ready' && news.value.status === 'available') {
      for (const item of screenNews(news.value.items, screenOptions()).items) {
        itemCount += 1;
        for (const code of item.currencies) codes.add(code);
      }
    }
    zoneSelect.disabled = itemCount === 0;
    currencySelect.disabled = codes.size === 0;
    const sorted = [...codes].sort();
    if (currency !== ALL && !codes.has(currency)) currency = ALL;
    replaceContent(currencySelect, [
      h('option', { text: 'All currencies', attrs: { value: ALL } }),
      ...sorted.map((code) => h('option', { text: code, attrs: { value: code } })),
    ]);
    currencySelect.value = currency;
  }

  function renderCalendar(): void {
    calendarMeta.textContent = '';
    switch (calendar.status) {
      case 'idle':
      case 'loading':
        replaceContent(calendarHost, [
          h('div', { class: 'feed__item' }, loadingNotice('Loading the economic calendar…')),
        ]);
        return;
      case 'error':
        replaceContent(calendarHost, [
          h(
            'div',
            { class: 'feed__item' },
            failedBlock('CALENDAR FAILED', calendar.message, () =>
              calendarResource.reload(CALENDAR_KEY),
            ),
          ),
        ]);
        return;
      case 'ready': {
        const result = calendar.value;
        if (result.status === 'unavailable') {
          replaceContent(calendarHost, [
            h('div', { class: 'feed__item' }, noSourceBlock('A calendar provider', result.reason)),
          ]);
          return;
        }
        const screened = screenCalendar(result.items, screenOptions());
        const shown = screened.items
          .filter((event) => matchesCurrency([event.currency], currency))
          .sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
        calendarMeta.textContent = `as of ${formatUtcDateTime(result.asOf)}`;
        replaceContent(calendarHost, [
          ...screeningNotices(screened).map((entry) => h('div', { class: 'feed__item' }, entry)),
          ...(shown.length === 0
            ? [
                h(
                  'div',
                  { class: 'feed__item' },
                  h('p', {
                    class: 'feed__empty',
                    text:
                      currency === ALL
                        ? 'The source returned no events for the next 7 days.'
                        : `No ${currency} events in the source’s next 7 days.`,
                  }),
                ),
              ]
            : shown.map((event) => calendarItem(event, zone))),
        ]);
      }
    }
  }

  function renderNews(): void {
    newsMeta.textContent = '';
    switch (news.status) {
      case 'idle':
      case 'loading':
        replaceContent(newsHost, [
          h('div', { class: 'feed__item' }, loadingNotice('Loading news…')),
        ]);
        return;
      case 'error':
        replaceContent(newsHost, [
          h(
            'div',
            { class: 'feed__item' },
            failedBlock('NEWS FAILED', news.message, () => newsResource.reload(NEWS_KEY)),
          ),
        ]);
        return;
      case 'ready': {
        const result = news.value;
        if (result.status === 'unavailable') {
          replaceContent(newsHost, [
            h('div', { class: 'feed__item' }, noSourceBlock('A news provider', result.reason)),
          ]);
          return;
        }
        const screened = screenNews(result.items, screenOptions());
        const shown = screened.items
          .filter((item) => matchesCurrency(item.currencies, currency))
          .sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
        newsMeta.textContent = `as of ${formatUtcDateTime(result.asOf)}`;
        replaceContent(newsHost, [
          ...screeningNotices(screened).map((entry) => h('div', { class: 'feed__item' }, entry)),
          ...(shown.length === 0
            ? [
                h(
                  'div',
                  { class: 'feed__item' },
                  h('p', {
                    class: 'feed__empty',
                    text:
                      currency === ALL
                        ? 'The source returned no news items.'
                        : `No ${currency} news items.`,
                  }),
                ),
              ]
            : shown.map((item) => newsItem(item, zone))),
        ]);
      }
    }
  }

  scope.add(
    calendarResource.store(CALENDAR_KEY).subscribe((state) => {
      calendar = state;
      syncControls();
      renderCalendar();
      renderNews();
    }),
  );
  scope.add(
    newsResource.store(NEWS_KEY).subscribe((state) => {
      news = state;
      syncControls();
      renderCalendar();
      renderNews();
    }),
  );
  scope.add(
    ctx.elvoid.store.subscribe(() => {
      renderCalendar();
      renderNews();
    }),
  );

  const range = (): string => {
    const from = Math.floor(ctx.now.get() / DAY_MS) * DAY_MS;
    return `${formatUtcDate(from)} to ${formatUtcDate(from + CALENDAR_WINDOW_DAYS * DAY_MS)}`;
  };

  const notes = h(
    'dl',
    { class: 'spec' },
    h('dt', { text: 'Time zone' }),
    h('dd', {
      text: 'Each source schedules in UTC and Elstand stores it that way; the zone above only changes how a time is shown.',
    }),
    h('dt', { text: 'Impact' }),
    h('dd', {
      text: 'Impact is the rating the source supplies, and who assigned it is printed beside it. Elstand assigns no impact of its own. An item the source did not rate shows UNCLASSIFIED.',
    }),
    h('dt', { text: 'ELVOID interpretation' }),
    h('dd', {
      text: 'It appears under an item only when an ELVOID engine supplied it. Without an engine none is shown, and any interpretation a provider sends is removed.',
    }),
    h('dt', { text: 'Calendar window' }),
    h('dd', {
      text: `From the start of today (UTC) for ${CALENDAR_WINDOW_DAYS} days: ${range()}.`,
    }),
  );

  const el = h(
    'div',
    { class: 'macro__body' },
    controls,
    h('div', { class: 'macro__split' }, calendarPanel.el, newsPanel.el),
    notes,
  );

  syncControls();
  renderCalendar();
  renderNews();
  calendarResource.ensure(CALENDAR_KEY);
  newsResource.ensure(NEWS_KEY);

  return { el, dispose: () => scope.dispose() };
}
