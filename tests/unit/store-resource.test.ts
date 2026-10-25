import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKeyedResource } from '../../src/core/resource.js';
import { createStore, subscribeSelected } from '../../src/core/store.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('store', () => {
  it('notifies in subscription order, skips identical values and supports updaters', () => {
    const store = createStore(1);
    const seen: string[] = [];
    store.subscribe((value, previous) => seen.push(`a:${previous}->${value}`));
    store.subscribe((value) => seen.push(`b:${value}`));
    store.set(1);
    store.set(2);
    store.set((current) => current + 1);
    assert.deepEqual(seen, ['a:1->2', 'b:2', 'a:2->3', 'b:3']);
    assert.equal(store.get(), 3);
  });

  it('stops notifying after unsubscribe, even from inside a listener', () => {
    const store = createStore(0);
    const seen: number[] = [];
    const stop = store.subscribe((value) => {
      seen.push(value);
      stop();
    });
    store.subscribe((value) => seen.push(value * 10));
    store.set(1);
    store.set(2);
    assert.deepEqual(seen, [1, 10, 20]);
  });

  it('fires a selected slice only when that slice changes', () => {
    const store = createStore({ a: 1, b: 1 });
    const seen: string[] = [];
    subscribeSelected(
      store,
      (state) => state.a,
      (value, previous) => seen.push(`${previous}->${value}`),
      Object.is,
      { immediate: true },
    );
    store.set({ a: 1, b: 2 });
    store.set({ a: 2, b: 2 });
    assert.deepEqual(seen, ['1->1', '1->2']);
  });
});

describe('keyed resource', () => {
  it('moves idle, loading, ready and loads each key once with ensure', async () => {
    let calls = 0;
    const resource = createKeyedResource<string>(
      async (key) => {
        calls += 1;
        return `value:${key}`;
      },
      () => 42,
    );
    const store = resource.store('x');
    assert.equal(store.get().status, 'idle');
    resource.ensure('x');
    assert.equal(store.get().status, 'loading');
    resource.ensure('x');
    await tick();
    const state = store.get();
    assert.equal(state.status, 'ready');
    if (state.status === 'ready') {
      assert.equal(state.value, 'value:x');
      assert.equal(state.loadedAt, 42);
    }
    resource.ensure('x');
    assert.equal(calls, 1);
  });

  it('reports errors as a state with the message', async () => {
    const resource = createKeyedResource<string>(async () => {
      throw new Error('provider unreachable');
    });
    resource.ensure('k');
    await tick();
    assert.deepEqual(resource.store('k').get(), {
      status: 'error',
      message: 'provider unreachable',
    });
  });

  it('discards a slow response that was superseded by a reload', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const pending = [first, second];
    const resource = createKeyedResource<string>((_key, signal) => {
      signals.push(signal);
      const next = pending.shift();
      if (next === undefined) throw new Error('unexpected call');
      return next.promise;
    });
    resource.reload('k');
    await tick();
    resource.reload('k');
    await tick();
    assert.equal(signals.length, 2);
    assert.equal(signals[0]?.aborted, true, 'the first request is aborted by the reload');
    assert.equal(signals[1]?.aborted, false);

    second.resolve('fresh');
    await tick();
    first.resolve('stale');
    await tick();
    const state = resource.store('k').get();
    assert.equal(state.status, 'ready');
    if (state.status === 'ready') assert.equal(state.value, 'fresh');
  });

  it('also discards a superseded failure', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    const resource = createKeyedResource<string>(() => {
      const next = pending.shift();
      if (next === undefined) throw new Error('unexpected call');
      return next.promise;
    });
    resource.reload('k');
    await tick();
    resource.reload('k');
    await tick();
    second.resolve('ok');
    await tick();
    first.reject(new Error('late failure'));
    await tick();
    assert.equal(resource.store('k').get().status, 'ready');
  });

  it('keeps keys independent, so a response can never land under another selection', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const resource = createKeyedResource<string>((key) => (key === 'a' ? a.promise : b.promise));
    resource.ensure('a');
    resource.ensure('b');
    b.resolve('B');
    await tick();
    assert.equal(resource.store('a').get().status, 'loading');
    assert.equal(resource.store('b').get().status, 'ready');
    a.resolve('A');
    await tick();
    const state = resource.store('a').get();
    assert.equal(state.status === 'ready' ? state.value : null, 'A');
  });
});

describe('keyed resource: background refresh', () => {
  it('keeps the value on screen while refreshing, then replaces it', async () => {
    let n = 0;
    const gate = deferred<string>();
    const resource = createKeyedResource<string>(async () => {
      n += 1;
      return n === 1 ? 'first' : gate.promise;
    });
    resource.reload('k');
    await tick();
    resource.refresh('k');
    assert.equal(resource.store('k').get().status, 'ready', 'never drops to loading');
    gate.resolve('second');
    await tick();
    const state = resource.store('k').get();
    assert.equal(state.status === 'ready' ? state.value : null, 'second');
  });

  it('keeps the last good value and records the error when a refresh fails', async () => {
    let fail = false;
    const resource = createKeyedResource<string>(
      async () => {
        if (fail) throw new Error('rate limited');
        return 'good';
      },
      () => 7,
    );
    resource.reload('k');
    await tick();
    fail = true;
    resource.refresh('k');
    await tick();
    assert.deepEqual(resource.store('k').get(), {
      status: 'ready',
      value: 'good',
      loadedAt: 7,
      refreshError: 'rate limited',
    });
    fail = false;
    resource.refresh('k');
    await tick();
    assert.equal(
      'refreshError' in resource.store('k').get(),
      false,
      'a good refresh clears the error',
    );
  });

  it('does not pile up requests while one is in flight', async () => {
    let calls = 0;
    const gate = deferred<string>();
    const resource = createKeyedResource<string>(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve('first') : gate.promise;
    });
    resource.reload('k');
    await tick();
    resource.refresh('k');
    resource.refresh('k');
    resource.refresh('k');
    await tick();
    assert.equal(calls, 2);
    gate.resolve('x');
  });

  it('behaves like a first load when nothing is loaded yet, and does not interrupt one', async () => {
    let calls = 0;
    const resource = createKeyedResource<string>(async () => {
      calls += 1;
      return 'v';
    });
    resource.refresh('k');
    assert.equal(resource.store('k').get().status, 'loading');
    resource.refresh('k');
    await tick();
    assert.equal(calls, 1);
    assert.equal(resource.store('k').get().status, 'ready');
  });
});
