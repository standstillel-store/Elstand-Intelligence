import type { ReadableStore } from '../core/store.js';
import type { Scope } from './dom.js';

/** Renders now and again on every change of the store, and unsubscribes with the scope. */
export function bind<S>(scope: Scope, store: ReadableStore<S>, render: (state: S) => void): void {
  render(store.get());
  scope.add(store.subscribe((state) => render(state)));
}

/** Sets text only when it differs, so a per-second tick does not churn the DOM. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Sets an attribute only when it differs; null removes it. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}
