import { ENV_NOT_CONNECTED } from '../core/connection-text.js';
import { DATA_STATE_DESCRIPTION, DATA_STATE_LABEL, DATA_STATE_SHORT } from '../core/freshness.js';
import type { DataState } from '../core/types.js';
import { h, type Child } from './dom.js';

/** The data-state badge: LIVE, DLY, STALE or N/A. The word is always present, never color alone. */
export function stateBadge(state: DataState, form: 'short' | 'long' = 'short'): HTMLElement {
  return h('span', {
    class: 'badge',
    text: form === 'short' ? DATA_STATE_SHORT[state] : DATA_STATE_LABEL[state],
    attrs: { 'data-state': state, title: DATA_STATE_DESCRIPTION[state] },
  });
}

export function updateBadge(
  badge: HTMLElement,
  state: DataState,
  form: 'short' | 'long' = 'short',
): void {
  const text = form === 'short' ? DATA_STATE_SHORT[state] : DATA_STATE_LABEL[state];
  if (badge.textContent !== text) badge.textContent = text;
  badge.setAttribute('data-state', state);
  badge.setAttribute('title', DATA_STATE_DESCRIPTION[state]);
}

export function button(
  label: string,
  onClick: () => void,
  options: { readonly small?: boolean; readonly pressed?: boolean; readonly title?: string } = {},
): HTMLButtonElement {
  const attrs: Record<string, string | boolean> = { type: 'button' };
  if (options.pressed !== undefined) attrs['aria-pressed'] = options.pressed;
  if (options.title !== undefined) attrs['title'] = options.title;
  return h('button', {
    class: options.small === true ? 'btn btn--small' : 'btn',
    text: label,
    attrs,
    on: { click: onClick },
  });
}

export interface EnvBlockOptions {
  /** One factual sentence: what is missing or what was refused. */
  readonly detail: string;
  /** Optional second paragraph, for what the missing connection affects. */
  readonly note?: string;
  readonly variant?: 'default' | 'compact' | 'fill';
  /** When given, the block offers a "Check connection" button. */
  readonly onCheck?: () => void;
}

/**
 * The ENV NOT CONNECTION state. Every panel that would show provider data renders this exact
 * block when the application has no connected data source, so the wording never varies.
 */
export function envNotConnected(options: EnvBlockOptions): HTMLElement {
  const variant = options.variant ?? 'default';
  const classes = ['env-block'];
  if (variant === 'compact') classes.push('env-block--compact');
  if (variant === 'fill') classes.push('env-block--fill');
  return h(
    'div',
    { class: classes.join(' ') },
    h('p', { class: 'env-block__label', text: ENV_NOT_CONNECTED }),
    h('p', { class: 'env-block__detail', text: options.detail }),
    options.note === undefined ? null : h('p', { class: 'env-block__note', text: options.note }),
    options.onCheck === undefined
      ? null
      : h(
          'div',
          { class: 'env-block__actions' },
          button('Check connection', options.onCheck, { small: true }),
        ),
  );
}

export type NoticeTone = 'neutral' | 'caution' | 'down';

/** An inline status line. A bold lead word keeps the meaning readable without color. */
export function notice(tone: NoticeTone, lead: string | null, ...children: Child[]): HTMLElement {
  return h(
    'p',
    { class: 'notice', attrs: { 'data-tone': tone } },
    lead === null ? null : h('strong', { text: lead }),
    lead === null ? null : ' ',
    ...children,
  );
}

export interface PanelParts {
  readonly el: HTMLElement;
  readonly title: HTMLElement;
  readonly meta: HTMLElement;
  readonly body: HTMLElement;
}

let panelCounter = 0;

export function createPanel(options: {
  readonly title: string;
  readonly id?: string;
  readonly className?: string;
  readonly flush?: boolean;
}): PanelParts {
  panelCounter += 1;
  const titleId = `panel-title-${panelCounter}`;
  const title = h('h2', { class: 'panel__title', text: options.title, attrs: { id: titleId } });
  const meta = h('div', { class: 'panel__meta' });
  const body = h('div', {
    class: options.flush === true ? 'panel__body panel__body--flush' : 'panel__body',
  });
  const attrs: Record<string, string> = { 'aria-labelledby': titleId };
  if (options.id !== undefined) attrs['id'] = options.id;
  const el = h(
    'section',
    { class: options.className === undefined ? 'panel' : `panel ${options.className}`, attrs },
    h('header', { class: 'panel__head' }, title, meta),
    body,
  );
  return { el, title, meta, body };
}
