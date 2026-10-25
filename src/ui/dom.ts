/**
 * Minimal DOM construction. Everything is built with `createElement` and `textContent`, never
 * `innerHTML`, so no string from a provider, a URL or the network can become markup.
 */

export type Child = Node | string | number | null | undefined | false;

export type AttrValue = string | number | boolean | null | undefined;

export type Handlers = {
  readonly [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
};

export interface Props {
  readonly class?: string;
  /** Sets `textContent`. Use children for mixed content. */
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, AttrValue>>;
  readonly on?: Handlers;
}

function setAttr(el: Element, name: string, value: AttrValue): void {
  if (value === null || value === undefined) {
    el.removeAttribute(name);
  } else if (typeof value === 'boolean' && name.startsWith('aria-')) {
    // ARIA state attributes take the words "true" and "false". A boolean HTML attribute becomes
    // an empty string, and an empty `aria-pressed` reads as "undefined" to a screen reader.
    el.setAttribute(name, String(value));
  } else if (value === false) {
    el.removeAttribute(name);
  } else {
    el.setAttribute(name, value === true ? '' : String(value));
  }
}

function applyProps(el: Element, props: Props): void {
  if (props.class !== undefined) el.setAttribute('class', props.class);
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) setAttr(el, name, value);
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, handler as EventListener);
  }
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function replaceContent(parent: Element, children: readonly Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props !== null) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, AttrValue>> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) setAttr(el, name, value);
  append(el, children);
  return el;
}

/** Collects cleanups so a view can release every subscription and listener it made. */
export interface Scope {
  add(dispose: () => void): void;
  dispose(): void;
}

export function createScope(): Scope {
  let disposers: (() => void)[] = [];
  return {
    add(dispose) {
      disposers.push(dispose);
    },
    dispose() {
      const pending = disposers;
      disposers = [];
      for (const dispose of pending.reverse()) dispose();
    },
  };
}

/** Anything the application mounts: an element and the means to tear it down. */
export interface View {
  readonly el: HTMLElement;
  dispose(): void;
}
