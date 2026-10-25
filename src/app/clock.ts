import { createStore, type ReadableStore } from '../core/store.js';

export interface Clock {
  /** Current time in epoch ms, republished every second so ages and staleness stay honest. */
  readonly now: ReadableStore<number>;
  dispose(): void;
}

export function createClock(
  read: () => number = Date.now,
  every: (handler: () => void, ms: number) => unknown = (handler, ms) => setInterval(handler, ms),
  stop: (handle: unknown) => void = (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
): Clock {
  const now = createStore(read());
  const handle = every(() => now.set(read()), 1000);
  return { now, dispose: () => stop(handle) };
}
