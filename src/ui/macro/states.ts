import { formatUtcDateTime } from '../../core/format.js';
import type { ProviderState } from '../../core/provider-state.js';
import { safeHttpUrl } from '../../core/url.js';
import type { Screened } from '../../data/macro-validate.js';
import type { FeedOrigin } from '../../data/macro.js';
import { envNotConnected, button, notice, type NoticeTone } from '../parts.js';
import { h } from '../dom.js';

/** The states every macro module shares, so the wording is the same wherever data is missing. */

export function loadingNotice(text: string): HTMLElement {
  return notice('neutral', null, text);
}

export function failedBlock(lead: string, message: string, onRetry: () => void): HTMLElement {
  return h(
    'div',
    { class: 'macro__failed' },
    notice('down', lead, message),
    h('div', { class: 'env-block__actions' }, button('Retry', onRetry, { small: true })),
  );
}

/**
 * ENV NOT CONNECTION for a macro module. `source` names what is not connected ("An options-data
 * provider"); `reason` is the provider's own statement of why there is nothing to show.
 */
export function noSourceBlock(source: string, reason: string): HTMLElement {
  return envNotConnected({ detail: `${source} is not connected.`, note: reason });
}

const TONE: Readonly<Record<ProviderState, NoticeTone>> = {
  LIVE: 'neutral',
  DELAYED: 'neutral',
  CALCULATED: 'neutral',
  CACHED: 'caution',
  STALE: 'caution',
  'RATE LIMITED': 'caution',
  UNAVAILABLE: 'caution',
  'ENV NOT CONNECTED': 'caution',
  ERROR: 'down',
};

/**
 * What a module shows when the server answered but had no data. No state or ENV NOT CONNECTED
 * keeps the ENV NOT CONNECTION block (a missing connection); every other state is shown under
 * its own name with the server's own words, so a rate limit or an outage is never presented as a
 * missing connection. A retry is offered only for states a retry can change.
 */
export function unavailableBlock(options: {
  readonly source: string;
  readonly reason: string;
  readonly origin: FeedOrigin | undefined;
  readonly onRetry: () => void;
}): HTMLElement {
  const state = options.origin?.provenance.state;
  if (state === undefined || state === 'ENV NOT CONNECTED') {
    return noSourceBlock(options.source, options.reason);
  }
  const retry = state === 'ERROR' || state === 'RATE LIMITED';
  return h(
    'div',
    { class: 'macro__failed' },
    notice(TONE[state], state, options.reason),
    retry
      ? h('div', { class: 'env-block__actions' }, button('Retry', options.onRetry, { small: true }))
      : null,
  );
}

/** The statements that go with data: its state when that is not good news, a fallback, what is left out. */
export function originNotices(origin: FeedOrigin | undefined): HTMLElement[] {
  if (origin === undefined) return [];
  const { provenance, notes } = origin;
  const out: HTMLElement[] = [];
  const plain =
    provenance.state === 'LIVE' ||
    provenance.state === 'DELAYED' ||
    provenance.state === 'CALCULATED';
  if (provenance.message !== null && !plain) {
    out.push(notice(TONE[provenance.state], provenance.state, provenance.message));
  }
  if (provenance.fallback !== null) {
    out.push(
      notice(
        'caution',
        'FALLBACK SOURCE',
        `${provenance.providerLabel} answered instead of the primary source. ${provenance.fallback.reason}`,
      ),
    );
  }
  for (const note of notes) out.push(notice('neutral', null, note));
  return out;
}

/** The acknowledgement a data provider asks for, with a link only when the address is safe. */
export function attributionLine(origin: FeedOrigin | undefined): HTMLElement | null {
  if (origin === undefined || origin.attribution === null) return null;
  const link = safeHttpUrl(origin.attribution.url);
  const { name } = origin.attribution;
  const retrieved = origin.provenance.retrievedAt;
  return h(
    'p',
    { class: 'feed__attribution' },
    'Data: ',
    link === null
      ? name
      : h('a', { text: name, attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' } }),
    retrieved === null ? null : ` · retrieved ${formatUtcDateTime(retrieved)}`,
  );
}

/**
 * What screening dropped from a list, in words: items that were unattributed or malformed, and
 * interpretations removed because no ELVOID engine is connected. Shared by every module that
 * screens provider items, so the wording is the same wherever it happens.
 */
export function screeningNotices<T>(screened: Screened<T>): HTMLElement[] {
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
