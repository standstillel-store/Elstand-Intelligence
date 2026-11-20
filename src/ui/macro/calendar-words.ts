import { formatUtcDateTime } from '../../core/format.js';
import type { CalendarEvent, EventConfidence, FeedOrigin } from '../../data/macro.js';
import { h } from '../dom.js';

/**
 * The words the economic calendar uses about where an event came from and what is not known
 * about it. They are shared by the calendar list and Surface VI so the same fact is said the same
 * way wherever it appears. Nothing here is computed from market data: it only names what a
 * provider supplied, or says plainly that it did not.
 */

/** The reason a surprise cannot be given, for an event that has none. */
export function surpriseUnavailableReason(event: CalendarEvent): string {
  if (event.actual === null && event.forecast === null) {
    return 'the source has published neither an actual nor a forecast';
  }
  if (event.actual === null) return 'the event has no actual yet';
  if (event.forecast === null) return 'the source publishes no forecast for this event';
  return 'the actual and the forecast are not comparable (different units or not plain numbers)';
}

export const SURPRISE_UNAVAILABLE = 'SURPRISE UNAVAILABLE';

/** What the inspector says about the surprise of an event that has none. */
export function surpriseUnavailableText(event: CalendarEvent): string {
  return (
    `${SURPRISE_UNAVAILABLE} — ${surpriseUnavailableReason(event)}. ` +
    'A surprise is actual minus forecast and is calculated only when both are present and in the same unit.'
  );
}

/**
 * `EVENT DATA: SHOWMYTRADES`: which provider the events on screen came from, in the provider's own
 * name. It is derived from the provenance the server attached, never assumed to be the primary.
 */
export function eventDataLabel(origin: FeedOrigin | undefined): string | null {
  if (origin === undefined) return null;
  return `EVENT DATA: ${origin.provenance.providerLabel.toUpperCase()}`;
}

/** The provenance line above a list or a set of waves: provider, state and retrieval time. */
export function eventDataLine(origin: FeedOrigin | undefined): HTMLElement | null {
  const label = eventDataLabel(origin);
  if (origin === undefined || label === null) return null;
  const { provenance } = origin;
  const retrieved =
    provenance.retrievedAt === null
      ? ''
      : ` · retrieved ${formatUtcDateTime(provenance.retrievedAt)}`;
  return h('p', {
    class: 'feed__attribution',
    text: `${label} · ${provenance.state}${retrieved}`,
    attrs: { 'data-event-data': provenance.provider },
  });
}

const CONFIDENCE_TEXT: Readonly<Record<EventConfidence, string>> = {
  official: 'the publisher’s own schedule',
  sources_agree: 'the provider’s sources agree',
  single_source: 'one source only',
  sources_disagree: 'the provider’s sources disagree',
};

export function confidenceText(confidence: EventConfidence): string {
  return CONFIDENCE_TEXT[confidence];
}

/**
 * What a provider said about the timing of an event, as labelled parts: the period the figures
 * describe, how well its sources agree on the time, and when the event was first scheduled if it
 * was moved. Only what the provider stated is returned.
 */
export function timingParts(event: CalendarEvent): [string, string][] {
  const parts: [string, string][] = [];
  if (event.period !== undefined) parts.push(['Period', event.period]);
  if (event.confidence !== undefined) {
    parts.push(['Timing', `${event.confidence} (${confidenceText(event.confidence)})`]);
  }
  if (event.movedFromMs !== undefined) {
    parts.push(['Moved from', formatUtcDateTime(event.movedFromMs)]);
  }
  return parts;
}
