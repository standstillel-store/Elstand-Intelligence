import { envNotConnected, button, notice } from '../parts.js';
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
