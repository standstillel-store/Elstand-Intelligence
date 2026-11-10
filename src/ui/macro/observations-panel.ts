import type { AppContext } from '../../app/context.js';
import { formatUtcDate, formatUtcDateTime, NO_VALUE } from '../../core/format.js';
import { createKeyedResource, type Loadable } from '../../core/resource.js';
import { safeHttpUrl } from '../../core/url.js';
import {
  MACRO_SERIES_PROVIDERS,
  type MacroSeriesProvider,
  type ObservationsProvider,
} from '../../data/http-macro.js';
import { latestPoint } from '../../data/observations.js';
import type { WireMacro, WireMacroEntry, WireRates } from '../../data/wire-macro.js';
import { createScope, h, replaceContent, type Child, type View } from '../dom.js';
import { createPanel } from '../parts.js';
import {
  attributionLine,
  failedBlock,
  loadingNotice,
  originNotices,
  unavailableBlock,
} from './states.js';

/** Section headings before an answer arrives; once one does, the server's own label is used. */
const HEADING: Readonly<Record<MacroSeriesProvider, string>> = {
  fred: 'FRED',
  worldbank: 'World Bank',
  bls: 'BLS',
  bea: 'BEA',
};

const VALUE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const RATES_KEY = 'rates';

function stateBadge(state: string): HTMLElement {
  return h('span', { class: 'pstate', text: state, attrs: { 'data-pstate': state } });
}

function entryRow(entry: WireMacroEntry): HTMLElement {
  const link = safeHttpUrl(entry.link);
  const title =
    link === null
      ? entry.title
      : h('a', {
          text: entry.title,
          attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' },
        });
  const series = entry.series;
  if (series === null) {
    return h(
      'tr',
      { attrs: { 'data-series': entry.key } },
      h('td', {}, title, h('p', { class: 'provider__note', text: entry.region })),
      h(
        'td',
        { attrs: { colspan: 5 } },
        stateBadge(entry.provenance.state),
        entry.provenance.message === null
          ? null
          : h('p', { class: 'provider__note', text: entry.provenance.message }),
      ),
    );
  }
  const latest = latestPoint(series);
  return h(
    'tr',
    { attrs: { 'data-series': entry.key } },
    h(
      'td',
      {},
      title,
      h('p', { class: 'provider__note', text: `${entry.region} · ${series.seriesId}` }),
    ),
    h('td', {
      class: 'num',
      text: latest === null ? NO_VALUE : `${VALUE_FORMAT.format(latest.value)} ${series.unit}`,
    }),
    h('td', {
      text: latest === null ? NO_VALUE : `${formatUtcDate(latest.date)} (${series.frequency})`,
    }),
    h('td', { text: series.adjustment ?? 'adjustment not stated' }),
    h('td', { text: formatUtcDateTime(series.retrievedAt) }),
    h(
      'td',
      {},
      stateBadge(entry.provenance.state),
      entry.provenance.message === null
        ? null
        : h('p', { class: 'provider__note', text: entry.provenance.message }),
    ),
  );
}

function macroSection(
  id: MacroSeriesProvider,
  state: Loadable<WireMacro>,
  retry: () => void,
): HTMLElement {
  const heading = h('h3', { class: 'provider__name', text: HEADING[id] });
  const body = ((): Child => {
    switch (state.status) {
      case 'idle':
      case 'loading':
        return loadingNotice(`Loading ${HEADING[id]} series…`);
      case 'error':
        return failedBlock(`${HEADING[id].toUpperCase()} FAILED`, state.message, retry);
      case 'ready': {
        const macro = state.value;
        const origin = { provenance: macro.provenance, attribution: null, notes: [] } as const;
        if (macro.entries.length === 0) {
          return unavailableBlock({
            source: `${macro.provenance.providerLabel} observations`,
            reason: macro.provenance.message ?? macro.provenance.state,
            origin,
            onRetry: retry,
          });
        }
        return h(
          'div',
          {},
          ...originNotices(origin),
          h(
            'div',
            { class: 'scroll-x' },
            h(
              'table',
              { class: 'tbl' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ...['Series', 'Latest', 'Observation', 'Adjustment', 'Retrieved', 'State'].map(
                    (label) => h('th', { text: label, attrs: { scope: 'col' } }),
                  ),
                ),
              ),
              h('tbody', {}, ...macro.entries.map(entryRow)),
            ),
          ),
        );
      }
    }
  })();
  return h('section', { class: 'provider', attrs: { 'data-macro-provider': id } }, heading, body);
}

function ratesSection(state: Loadable<WireRates>, retry: () => void): HTMLElement {
  const heading = h('h3', { class: 'provider__name', text: 'Reference exchange rates' });
  const body = ((): Child => {
    switch (state.status) {
      case 'idle':
      case 'loading':
        return loadingNotice('Loading reference rates…');
      case 'error':
        return failedBlock('REFERENCE RATES FAILED', state.message, retry);
      case 'ready': {
        const { provenance, data } = state.value;
        if (data === null) {
          return unavailableBlock({
            source: 'A reference-rate provider',
            reason: provenance.message ?? provenance.state,
            origin: { provenance, attribution: null, notes: [] },
            onRetry: retry,
          });
        }
        const origin = { provenance, attribution: data.attribution, notes: [] } as const;
        return h(
          'div',
          {},
          ...originNotices(origin),
          h('p', {
            class: 'macro__help',
            text:
              `Units of each currency per 1 ${data.base} on the fixing of ${formatUtcDate(data.date)}. ` +
              'These are reference rates published once per working day. They are not intraday ' +
              'quotes and are never shown in place of one.',
          }),
          h(
            'div',
            { class: 'scroll-x' },
            h(
              'table',
              { class: 'tbl' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ...['Currency', `Per 1 ${data.base}`, 'Fixing', 'State'].map((label) =>
                    h('th', { text: label, attrs: { scope: 'col' } }),
                  ),
                ),
              ),
              h(
                'tbody',
                {},
                ...data.rates.map((rate) =>
                  h(
                    'tr',
                    { attrs: { 'data-currency': rate.currency } },
                    h('td', { text: rate.currency }),
                    h('td', { class: 'num', text: VALUE_FORMAT.format(rate.rate) }),
                    h('td', { text: formatUtcDate(data.date) }),
                    h('td', {}, stateBadge(provenance.state)),
                  ),
                ),
              ),
            ),
          ),
          data.missing.length === 0
            ? null
            : h('p', {
                class: 'macro__help',
                text: `No reference rate was returned for: ${data.missing.join(', ')}. Nothing is filled in.`,
              }),
          attributionLine(origin),
        );
      }
    }
  })();
  return h('section', { class: 'provider', attrs: { 'data-rates': 'true' } }, heading, body);
}

/**
 * Macro observations (FRED, World Bank, BLS, BEA) and reference exchange rates, exactly as the
 * server validated and attributed them. Each series shows its unit, frequency, the period it
 * describes, when it was retrieved and the state the server gave it; a provider that is not
 * connected, rate limited or failing says so under its own heading and never blanks the others.
 */
export function createObservationsModule(
  ctx: AppContext,
  observations: ObservationsProvider,
): View {
  const scope = createScope();
  const panel = createPanel({
    title: 'Macro observations and reference rates',
    id: 'observations-panel',
  });
  const macro = createKeyedResource<WireMacro>(
    (key, signal) => observations.getMacro(key as MacroSeriesProvider, signal),
    () => ctx.now.get(),
  );
  const rates = createKeyedResource<WireRates>(
    (_key, signal) => observations.getRates(signal),
    () => ctx.now.get(),
  );
  const host = h('div', { class: 'providers' });
  panel.body.append(
    h(
      'div',
      { class: 'macro__body' },
      h('p', {
        class: 'macro__help',
        text:
          'Real series as the providers publish them. Observation dates are the period a value ' +
          'describes; a value is never treated as known before it was published.',
      }),
      host,
    ),
  );

  function render(): void {
    replaceContent(host, [
      ...MACRO_SERIES_PROVIDERS.map((id) =>
        macroSection(id, macro.store(id).get(), () => macro.reload(id)),
      ),
      ratesSection(rates.store(RATES_KEY).get(), () => rates.reload(RATES_KEY)),
    ]);
  }

  for (const id of MACRO_SERIES_PROVIDERS) scope.add(macro.store(id).subscribe(render));
  scope.add(rates.store(RATES_KEY).subscribe(render));
  render();
  for (const id of MACRO_SERIES_PROVIDERS) macro.ensure(id);
  rates.ensure(RATES_KEY);

  return { el: panel.el, dispose: () => scope.dispose() };
}
