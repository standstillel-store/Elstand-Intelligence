import type { AppContext } from '../../app/context.js';
import type { Provenance } from '../../data/provenance.js';
import { bind } from '../bind.js';
import { createScope, h, replaceContent, type View } from '../dom.js';
import { notice, type NoticeTone } from '../parts.js';

/**
 * Says so when what is on the chart did not come from the primary provider in the ordinary way:
 * a fallback answered, the server kept a copy because the provider could not be asked, the data
 * is stale, or the provider is rate limited or failing. It names the provider that actually
 * answered, so a fallback is never mistaken for the primary source. With a plain answer it shows
 * nothing at all.
 */

const TONE: Readonly<Record<Provenance['state'], NoticeTone>> = {
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

function notices(subject: string, provenance: Provenance | null): HTMLElement[] {
  if (provenance === null) return [];
  const out: HTMLElement[] = [];
  if (provenance.fallback !== null) {
    out.push(
      notice(
        'caution',
        'FALLBACK SOURCE',
        `${subject} come from ${provenance.providerLabel}, not the primary source. ${provenance.fallback.reason}`,
      ),
    );
  }
  const plain =
    provenance.state === 'LIVE' ||
    provenance.state === 'DELAYED' ||
    provenance.state === 'CALCULATED';
  if (!plain && provenance.message !== null) {
    out.push(notice(TONE[provenance.state], provenance.state, `${subject}: ${provenance.message}`));
  }
  return out;
}

export function createSourceNotice(ctx: AppContext): View {
  const scope = createScope();
  const el = h('div', { class: 'forex__notices', attrs: { 'aria-live': 'polite' } });
  bind(scope, ctx.provenance, ({ quote, candles }) => {
    replaceContent(el, [...notices('Quote', quote), ...notices('Candles', candles)]);
  });
  return { el, dispose: () => scope.dispose() };
}
