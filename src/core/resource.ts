import { createStore, type ReadableStore, type Store } from './store.js';

/** The four honest states of anything fetched from a provider. */
export type Loadable<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly value: T;
      readonly loadedAt: number;
      /** Set when a background refresh failed. The value is the last good one and keeps ageing. */
      readonly refreshError?: string;
    }
  | { readonly status: 'error'; readonly message: string };

export interface KeyedResource<T> {
  /** The store for one key. Created on first use; safe to subscribe before loading. */
  store(key: string): ReadableStore<Loadable<T>>;
  /** Starts loading only if the key has never been requested. */
  ensure(key: string): void;
  /** Starts a fresh load, aborting and ignoring any request still in flight for this key. */
  reload(key: string): void;
  /**
   * Background update. A ready value stays on screen while the request runs, and a failed
   * update keeps that value and records `refreshError` instead of blanking the panel. Does
   * nothing if a request is already in flight; behaves like `reload` if nothing is loaded.
   */
  refresh(key: string): void;
}

interface Entry<T> {
  readonly store: Store<Loadable<T>>;
  controller: AbortController | null;
  token: number;
}

type ReadyState<T> = Extract<Loadable<T>, { status: 'ready' }>;

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'Unknown error';
}

/**
 * One loader, many keys. Each key has its own store, so switching instrument or timeframe
 * can never show a response that belongs to a different selection, and a slow response for
 * an old request is discarded rather than overwriting a newer one.
 */
export function createKeyedResource<T>(
  load: (key: string, signal: AbortSignal) => Promise<T>,
  now: () => number = Date.now,
): KeyedResource<T> {
  const entries = new Map<string, Entry<T>>();

  function entryFor(key: string): Entry<T> {
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { store: createStore<Loadable<T>>({ status: 'idle' }), controller: null, token: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  function start(key: string, keep: ReadyState<T> | null = null): void {
    const entry = entryFor(key);
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    entry.token += 1;
    const token = entry.token;
    if (keep === null) entry.store.set({ status: 'loading' });
    Promise.resolve()
      .then(() => load(key, controller.signal))
      .then(
        (value) => {
          if (token !== entry.token) return;
          entry.controller = null;
          entry.store.set({ status: 'ready', value, loadedAt: now() });
        },
        (error: unknown) => {
          if (token !== entry.token) return;
          entry.controller = null;
          const message = toMessage(error);
          entry.store.set(
            keep === null
              ? { status: 'error', message }
              : {
                  status: 'ready',
                  value: keep.value,
                  loadedAt: keep.loadedAt,
                  refreshError: message,
                },
          );
        },
      );
  }

  return {
    store: (key) => entryFor(key).store,
    ensure(key) {
      if (entryFor(key).store.get().status === 'idle') start(key);
    },
    reload: (key) => start(key),
    refresh(key) {
      const entry = entryFor(key);
      const current = entry.store.get();
      if (current.status === 'ready') {
        if (entry.controller === null) start(key, current);
      } else if (current.status !== 'loading') {
        start(key);
      }
    },
  };
}
