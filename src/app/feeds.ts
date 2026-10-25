import type { Loadable } from '../core/resource.js';
import type { ReadableStore } from '../core/store.js';
import { createStore } from '../core/store.js';
import type { MarketDataService } from '../data/service.js';
import type { ConnectionState } from './connection.js';

/**
 * What a panel needs to know to render one kind of data: not just the data, but whether the
 * application is connected at all. ENV NOT CONNECTION is a state of the connection, so it
 * arrives here as `not-connected` and every panel shows it the same way.
 */
export type FeedState<T> =
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'not-connected';
      readonly detail: string;
      readonly missing: readonly string[];
    }
  | { readonly kind: 'connection-error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly value: T;
      readonly loadedAt: number;
      /** Set when the last background refresh failed; `value` is then the last good one. */
      readonly refreshError: string | null;
    };

export interface Feed<T> {
  readonly store: ReadableStore<FeedState<T>>;
  /** A fresh load that clears what is shown first. For a Retry after an error. */
  reload(): void;
  /** An update that keeps what is shown on screen while it runs. For a Refresh button. */
  refresh(): void;
  dispose(): void;
}

export interface Binding<T> {
  readonly store: ReadableStore<Loadable<T>>;
  load(): void;
  reload(): void;
  /** Background update; falls back to `reload` when the resource has no gentler form. */
  refresh?(): void;
}

function fromLoadable<T>(loadable: Loadable<T>): FeedState<T> {
  switch (loadable.status) {
    case 'idle':
    case 'loading':
      return { kind: 'loading' };
    case 'error':
      return { kind: 'error', message: loadable.message };
    case 'ready':
      return {
        kind: 'ready',
        value: loadable.value,
        loadedAt: loadable.loadedAt,
        refreshError: loadable.refreshError ?? null,
      };
  }
}

/**
 * Follows the connection and a key (the selected instrument, say) and exposes the matching
 * resource from the connected service. When either changes the feed re-binds, so a response
 * for an old selection or an old connection can never be shown for the current one.
 */
export function createFeed<T, K>(
  connection: ReadableStore<ConnectionState>,
  key: ReadableStore<K>,
  bind: (service: MarketDataService, key: K) => Binding<T>,
): Feed<T> {
  const out = createStore<FeedState<T>>({ kind: 'checking' });
  let binding: Binding<T> | null = null;
  let stopBinding: (() => void) | null = null;

  function publish(): void {
    if (binding !== null) out.set(fromLoadable(binding.store.get()));
  }

  function rebind(): void {
    stopBinding?.();
    stopBinding = null;
    binding = null;
    const state = connection.get();
    switch (state.status) {
      case 'checking':
        out.set({ kind: 'checking' });
        return;
      case 'not-connected':
        out.set({ kind: 'not-connected', detail: state.detail, missing: state.missing });
        return;
      case 'error':
        out.set({ kind: 'connection-error', message: state.message });
        return;
      case 'connected': {
        const next = bind(state.service, key.get());
        binding = next;
        stopBinding = next.store.subscribe(publish);
        next.load();
        publish();
      }
    }
  }

  rebind();
  const stopConnection = connection.subscribe(rebind);
  const stopKey = key.subscribe(rebind);

  return {
    store: out,
    reload: () => binding?.reload(),
    refresh: () => {
      if (binding === null) return;
      if (binding.refresh === undefined) binding.reload();
      else binding.refresh();
    },
    dispose() {
      stopConnection();
      stopKey();
      stopBinding?.();
      stopBinding = null;
      binding = null;
    },
  };
}
