import { button } from './parts.js';
import { h } from './dom.js';

function describe(reason: unknown): string {
  if (reason instanceof Error && reason.message !== '') return reason.message;
  if (typeof reason === 'string' && reason !== '') return reason;
  return 'An unknown error occurred.';
}

/**
 * Anything the application did not expect is shown, not swallowed: a failure that leaves part
 * of the screen stale must be visible, because stale-looking data is exactly what Elstand
 * promises never to show unmarked.
 */
export function installErrorBoundary(win: Window, host: HTMLElement): () => void {
  let banner: HTMLElement | null = null;

  const show = (reason: unknown): void => {
    banner?.remove();
    const current = h(
      'div',
      { class: 'fatal', attrs: { role: 'alert' } },
      h('p', { class: 'fatal__title', text: 'UNEXPECTED ERROR' }),
      h('p', { text: describe(reason) }),
      h('p', {
        class: 'wl__sub',
        text: 'Reload the page. If it keeps happening, the data on screen may be out of date.',
      }),
      button('Dismiss', () => current.remove(), { small: true }),
    );
    banner = current;
    host.prepend(current);
  };

  const onError = (event: ErrorEvent): void => show(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent): void => show(event.reason);
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
    banner?.remove();
  };
}
