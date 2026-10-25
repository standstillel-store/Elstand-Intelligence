export type Listener<S> = (state: S, previous: S) => void;

export interface ReadableStore<S> {
  get(): S;
  /** Returns an unsubscribe function. Listeners run synchronously, in subscription order. */
  subscribe(listener: Listener<S>): () => void;
}

export interface Store<S> extends ReadableStore<S> {
  /** Accepts a value or an updater. Setting an identical value (Object.is) is a no-op. */
  set(next: S | ((previous: S) => S)): void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (previous: S) => S)(state) : next;
      if (Object.is(resolved, state)) return;
      const previous = state;
      state = resolved;
      for (const listener of [...listeners]) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface SelectOptions {
  /** Call `onChange` once immediately with the current value. */
  readonly immediate?: boolean;
}

/** Subscribes to a derived slice of a store and only fires when that slice changes. */
export function subscribeSelected<S, T>(
  store: ReadableStore<S>,
  select: (state: S) => T,
  onChange: (value: T, previous: T) => void,
  equals: (a: T, b: T) => boolean = Object.is,
  options: SelectOptions = {},
): () => void {
  let current = select(store.get());
  if (options.immediate === true) onChange(current, current);
  return store.subscribe((state) => {
    const next = select(state);
    if (equals(next, current)) return;
    const previous = current;
    current = next;
    onChange(next, previous);
  });
}

type Values<T extends readonly ReadableStore<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends ReadableStore<infer V> ? V : never;
};

export interface DerivedStore<R> extends ReadableStore<R> {
  /** Stop listening to the source stores. */
  dispose(): void;
}

/**
 * A store computed from other stores. It recomputes whenever a source changes and only
 * notifies its own listeners when the result differs under `equals`.
 */
export function derived<const T extends readonly ReadableStore<unknown>[], R>(
  stores: T,
  compute: (...values: Values<T>) => R,
  equals: (a: R, b: R) => boolean = Object.is,
): DerivedStore<R> {
  const read = (): R => compute(...(stores.map((store) => store.get()) as unknown as Values<T>));
  const inner = createStore<R>(read());
  const unsubscribers = stores.map((store) =>
    store.subscribe(() => {
      const next = read();
      if (!equals(next, inner.get())) inner.set(next);
    }),
  );
  return {
    get: inner.get,
    subscribe: inner.subscribe,
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
