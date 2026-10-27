import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTtlCache } from '../../server/cache.js';
import { ApiFailure } from '../../server/errors.js';
import { createRateLimiter, nextUtcMidnight } from '../../server/limiter.js';
import {
  callProvider,
  parseBaseUrl,
  parseRetryAfter,
  sanitizeText,
  type HttpDeps,
} from '../../server/provider-http.js';
import { createProviderRuntime, serve } from '../../server/provider-runtime.js';
import { backoffDelay, seededUnit, withRetry } from '../../server/retry.js';
import { createFakeProviders, text, unreachableFetch } from '../support/fake-provider.js';

const T0 = Date.UTC(2026, 0, 6, 12, 0, 0);
const KEY = 'test-key-1234';

describe('rate limiter', () => {
  const budget = { perMinute: 3, perDay: 5 } as const;
  const ask = (now: number, limiter = createRateLimiter(), cost = 1) =>
    limiter.acquire([{ key: 'p', budget, cost }], now);

  it('grants up to the per-minute limit over any sliding minute, then says when to retry', () => {
    const limiter = createRateLimiter();
    assert.equal(ask(T0, limiter).outcome, 'granted');
    assert.equal(ask(T0 + 10_000, limiter).outcome, 'granted');
    assert.equal(ask(T0 + 20_000, limiter).outcome, 'granted');
    const denied = ask(T0 + 30_000, limiter);
    assert.deepEqual(denied, { outcome: 'denied', retryAfterMs: 30_000, scope: 'minute' });
    // 61 s after the first request, one credit has left the window.
    assert.equal(ask(T0 + 60_001, limiter).outcome, 'granted');
    assert.equal(ask(T0 + 60_002, limiter).outcome, 'denied');
  });

  it('does not let a burst straddle a minute boundary', () => {
    const limiter = createRateLimiter();
    for (const offset of [50_000, 55_000, 59_000]) {
      assert.equal(ask(T0 + offset, limiter).outcome, 'granted');
    }
    // Just after the next clock minute, the three requests are still inside the sliding minute.
    assert.equal(ask(T0 + 61_000, limiter).outcome, 'denied');
  });

  it('enforces the per-day limit and resets at 00:00 UTC', () => {
    const limiter = createRateLimiter();
    const wide = { perMinute: null, perDay: 2 } as const;
    const request = [{ key: 'q', budget: wide, cost: 1 }] as const;
    assert.equal(limiter.acquire(request, T0).outcome, 'granted');
    assert.equal(limiter.acquire(request, T0 + 1).outcome, 'granted');
    const denied = limiter.acquire(request, T0 + 2);
    assert.equal(denied.outcome, 'denied');
    if (denied.outcome === 'denied') {
      assert.equal(denied.scope, 'day');
      assert.equal(denied.retryAfterMs, nextUtcMidnight(T0 + 2) - (T0 + 2));
    }
    assert.equal(limiter.acquire(request, nextUtcMidnight(T0)).outcome, 'granted');
  });

  it('is all-or-nothing across a provider budget and an endpoint budget', () => {
    const limiter = createRateLimiter();
    const provider = { key: 'p', budget: { perMinute: 10, perDay: null }, cost: 1 };
    const tight = { key: 'p:e', budget: { perMinute: 1, perDay: null }, cost: 1 };
    assert.equal(limiter.acquire([provider, tight], T0).outcome, 'granted');
    assert.equal(limiter.acquire([provider, tight], T0 + 1).outcome, 'denied');
    assert.equal(limiter.usage('p', T0 + 1).minuteUsed, 1, 'the denied request took no credit');
  });

  it('stops everything for a provider that said to stop, until the time it gave', () => {
    const limiter = createRateLimiter();
    limiter.block('p', T0, T0 + 90_000);
    const denied = ask(T0 + 1_000, limiter);
    assert.deepEqual(denied, { outcome: 'denied', retryAfterMs: 89_000, scope: 'blocked' });
    assert.equal(ask(T0 + 90_000, limiter).outcome, 'granted');
  });

  it('charges a request its cost', () => {
    const limiter = createRateLimiter();
    assert.equal(ask(T0, limiter, 3).outcome, 'granted');
    assert.equal(ask(T0 + 1, limiter, 1).outcome, 'denied');
  });
});

describe('retry', () => {
  const policy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 } as const;
  const retryable = (retryAfter: number | null = null) =>
    new ApiFailure('provider_error', 'down', retryAfter, { retryable: true });

  function harness() {
    const waited: number[] = [];
    return {
      waited,
      deps: {
        now: () => T0,
        sleep: (ms: number) => {
          waited.push(ms);
          return Promise.resolve();
        },
      },
    };
  }

  it('retries a failure that is worth repeating, with growing waits, and then succeeds', async () => {
    const { waited, deps } = harness();
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(retryable()) : Promise.resolve('ok');
      },
      policy,
      deps,
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.equal(waited.length, 2);
    assert.ok(waited[0] !== undefined && waited[0] >= 100 && waited[0] < 200);
    assert.ok(waited[1] !== undefined && waited[1] >= 200 && waited[1] < 300);
  });

  it('is bounded: it gives up after the allowed attempts and rethrows the failure', async () => {
    const { deps } = harness();
    let calls = 0;
    await assert.rejects(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(retryable());
        },
        policy,
        deps,
      ),
      (error: unknown) => error instanceof ApiFailure && error.message === 'down',
    );
    assert.equal(calls, 3);
  });

  it('never retries a rejected key, a rate limit or a bad request', async () => {
    for (const failure of [
      new ApiFailure('provider_auth', 'key'),
      new ApiFailure('rate_limited', 'limit', 2),
      new ApiFailure('bad_request', 'bad'),
      new ApiFailure('provider_error', 'plain 4xx'),
    ]) {
      const { waited, deps } = harness();
      let calls = 0;
      await assert.rejects(
        withRetry(
          () => {
            calls += 1;
            return Promise.reject(failure);
          },
          policy,
          deps,
        ),
      );
      assert.equal(calls, 1, failure.code);
      assert.deepEqual(waited, []);
    }
  });

  it('honours Retry-After, and gives up when it asks for longer than the policy allows', () => {
    const unit = seededUnit(1);
    const short = backoffDelay(retryable(1), 1, policy, unit);
    assert.equal(short, 1_000, 'waits the full second it was asked to');
    assert.equal(backoffDelay(retryable(30), 1, policy, unit), null, 'asked for 30 s, allowed 1 s');
  });

  it('is deterministic for a given clock and spreads for different ones', () => {
    const a = seededUnit(T0);
    const b = seededUnit(T0);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notEqual(seededUnit(T0)(), seededUnit(T0 + 1)());
  });
});

describe('cache: stale-if-error', () => {
  const policy = { ttlMs: 1_000, staleIfErrorMs: 10_000 } as const;
  const down = (): Promise<never> =>
    Promise.reject(new ApiFailure('provider_unreachable', 'down', null, { retryable: true }));

  it('serves a fresh value from the cache inside its lifetime and says so', async () => {
    const cache = createTtlCache();
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return Promise.resolve('v1');
    };
    const first = await cache.getOrLoadDetailed('k', policy, T0, load);
    const second = await cache.getOrLoadDetailed('k', policy, T0 + 500, load);
    assert.equal(first.origin, 'fresh');
    assert.equal(second.origin, 'cache');
    assert.equal(second.retrievedAt, T0);
    assert.equal(loads, 1);
  });

  it('serves the last verified value when the provider cannot be asked, with the time it was retrieved', async () => {
    const cache = createTtlCache();
    await cache.getOrLoadDetailed('k', policy, T0, () => Promise.resolve('v1'));
    const served = await cache.getOrLoadDetailed('k', policy, T0 + 5_000, down);
    assert.equal(served.value, 'v1');
    assert.equal(served.origin, 'stale-if-error');
    assert.equal(served.retrievedAt, T0, 'the retrieval time is the original one');
    assert.equal(served.failure?.code, 'provider_unreachable');
  });

  it('stops serving a stale value once its window has passed', async () => {
    const cache = createTtlCache();
    await cache.getOrLoadDetailed('k', policy, T0, () => Promise.resolve('v1'));
    await assert.rejects(cache.getOrLoadDetailed('k', policy, T0 + 20_000, down));
  });

  it('never serves a stale value for a bad request, which is the caller’s fault', async () => {
    const cache = createTtlCache();
    await cache.getOrLoadDetailed('k', policy, T0, () => Promise.resolve('v1'));
    await assert.rejects(
      cache.getOrLoadDetailed('k', policy, T0 + 5_000, () =>
        Promise.reject(new ApiFailure('bad_request', 'no')),
      ),
    );
  });

  it('remembers a rate limit, so it is not asked again while the provider said to wait', async () => {
    const cache = createTtlCache();
    let loads = 0;
    const limited = (): Promise<never> => {
      loads += 1;
      return Promise.reject(new ApiFailure('rate_limited', 'slow down', 30));
    };
    await assert.rejects(cache.getOrLoadDetailed('k', policy, T0, limited));
    await assert.rejects(cache.getOrLoadDetailed('k', policy, T0 + 20_000, limited));
    assert.equal(loads, 1, 'still inside the 30 s the provider asked for');
    await assert.rejects(cache.getOrLoadDetailed('k', policy, T0 + 31_000, limited));
    assert.equal(loads, 2);
  });

  it('shares one upstream call between identical requests in flight', async () => {
    const cache = createTtlCache();
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      await Promise.resolve();
      return 7;
    };
    const all = await Promise.all([
      cache.getOrLoadDetailed('k', policy, T0, load),
      cache.getOrLoadDetailed('k', policy, T0, load),
      cache.getOrLoadDetailed('k', policy, T0, load),
    ]);
    assert.equal(loads, 1);
    assert.deepEqual(
      all.map((served) => served.value),
      [7, 7, 7],
    );
  });

  it('keeps the original getOrLoad contract: the value only, and no stale serving', async () => {
    const cache = createTtlCache();
    assert.equal(await cache.getOrLoad('k', 1_000, T0, () => Promise.resolve('v')), 'v');
    await assert.rejects(cache.getOrLoad('k', 1_000, T0 + 2_000, down));
  });
});

describe('provider HTTP helper', () => {
  const base = 'https://api.example.org/v2';
  const call = {
    label: 'Example',
    baseUrl: base,
    path: 'things',
    query: { q: '1' },
    secrets: [KEY],
  } as const;
  const depsFor = (fetchImpl: typeof fetch): HttpDeps => ({ fetch: fetchImpl, now: () => T0 });

  it('sends a GET to the base URL, refuses redirects, and parses JSON', async () => {
    const fake = createFakeProviders(() => ({ ok: [1, 2] }));
    const response = await callProvider(depsFor(fake.fetch), call);
    assert.deepEqual(response.body, { ok: [1, 2] });
    const sent = fake.calls[0];
    assert.equal(sent?.host, 'api.example.org');
    assert.equal(sent?.path, '/v2/things');
    assert.deepEqual(sent?.params, { q: '1' });
    assert.equal(sent?.redirect, 'error');
    assert.equal(sent?.method, 'GET');
  });

  it('posts a JSON body when it is given one', async () => {
    const fake = createFakeProviders(() => ({ ok: true }));
    await callProvider(depsFor(fake.fetch), { ...call, method: 'POST', jsonBody: { a: 1 } });
    assert.equal(fake.calls[0]?.method, 'POST');
    assert.equal(fake.calls[0]?.body, '{"a":1}');
    assert.equal(fake.calls[0]?.headers['content-type'], 'application/json');
  });

  it('maps statuses to the failures the browser understands, with no URL or key in the message', async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, 'provider_auth', false],
      [403, 'provider_auth', false],
      [429, 'rate_limited', false],
      [404, 'provider_error', false],
      [500, 'provider_error', true],
      [503, 'provider_error', true],
    ];
    for (const [status, code, retryable] of cases) {
      const fake = createFakeProviders(() => text(`nope ${KEY}`, status, { 'Retry-After': '7' }));
      await assert.rejects(callProvider(depsFor(fake.fetch), call), (error: unknown) => {
        assert.ok(error instanceof ApiFailure);
        assert.equal(error.code, code, String(status));
        assert.equal(error.retryable, retryable, String(status));
        assert.doesNotMatch(error.message, /https?:|api\.example|test-key/);
        return true;
      });
    }
  });

  it('carries Retry-After from a 429, as seconds or as an HTTP date', async () => {
    for (const [header, expected] of [
      ['7', 7],
      [new Date(T0 + 12_000).toUTCString(), 12],
    ] as const) {
      const fake = createFakeProviders(() => text('', 429, { 'Retry-After': header }));
      await assert.rejects(callProvider(depsFor(fake.fetch), call), (error: unknown) => {
        assert.ok(error instanceof ApiFailure);
        assert.equal(error.retryAfterSeconds, expected);
        return true;
      });
    }
    assert.equal(parseRetryAfter('0', T0), null);
    assert.equal(parseRetryAfter('soon', T0), null);
    assert.equal(parseRetryAfter(null, T0), null);
  });

  it('reports an unreachable provider as retryable, and a body that is not JSON as an error', async () => {
    await assert.rejects(callProvider(depsFor(unreachableFetch), call), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.code, 'provider_unreachable');
      assert.equal(error.retryable, true);
      return true;
    });
    const html = createFakeProviders(() => text('<html>maintenance</html>', 200));
    await assert.rejects(callProvider(depsFor(html.fetch), call), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.code, 'provider_error');
      assert.match(error.message, /did not answer with JSON/);
      return true;
    });
  });

  it("lets an adapter recognize the provider's own error envelope, even on HTTP 200", async () => {
    const fake = createFakeProviders(() => ({ Note: 'limit' }));
    await assert.rejects(
      callProvider(depsFor(fake.fetch), {
        ...call,
        recognizeError: (_status, body) =>
          typeof body === 'object' && body !== null && 'Note' in body
            ? new ApiFailure('rate_limited', 'Example limit reached.')
            : null,
      }),
      (error: unknown) => error instanceof ApiFailure && error.code === 'rate_limited',
    );
  });

  it('refuses a response larger than the cap', async () => {
    const big = createFakeProviders(() => text(JSON.stringify({ pad: 'x'.repeat(5_000) })));
    await assert.rejects(
      callProvider(depsFor(big.fetch), { ...call, maxBytes: 1_000 }),
      (error: unknown) => error instanceof ApiFailure && /larger than allowed/.test(error.message),
    );
  });

  it('accepts only https base URLs with no credentials, query or fragment', async () => {
    assert.equal(parseBaseUrl('https://api.example.org/v2/'), 'https://api.example.org/v2');
    assert.equal(parseBaseUrl('https://api.example.org'), 'https://api.example.org');
    // Built with the URL API so that no address with credentials in it is written in a file.
    const withLogin = new URL('https://api.example.org');
    withLogin.username = 'someone';
    withLogin.password = 'something';
    for (const bad of [
      'http://api.example.org',
      withLogin.href,
      'https://api.example.org?x=1',
      'https://api.example.org#x',
      'not a url',
      '',
    ]) {
      assert.equal(parseBaseUrl(bad), null, bad);
    }
    const fake = createFakeProviders(() => ({}));
    await assert.rejects(
      callProvider(depsFor(fake.fetch), { ...call, baseUrl: 'http://api.example.org' }),
      (error: unknown) =>
        error instanceof ApiFailure && /not a valid https address/.test(error.message),
    );
    assert.equal(fake.calls.length, 0, 'nothing was sent');
  });

  it('cannot be steered to another host by the path', async () => {
    const fake = createFakeProviders(() => ({}));
    for (const path of ['/evil.example.net/x', '//evil.example.net/x', '@evil.example.net/x']) {
      await callProvider(depsFor(fake.fetch), { ...call, path });
    }
    assert.equal(fake.calls.length, 3);
    assert.ok(fake.calls.every((sent) => sent.host === 'api.example.org'));
  });

  it('removes credentials and control characters from text that will be shown', () => {
    assert.equal(sanitizeText(`bad key ${KEY}\n\tplease`, [KEY]), 'bad key [redacted] please');
    assert.equal(sanitizeText('x'.repeat(500), []).length, 240);
  });
});

describe('serve: cache, budget, retry and last verified answer together', () => {
  const policy = { ttlMs: 1_000, staleIfErrorMs: 60_000 } as const;
  const budgets = [{ key: 'example', budget: { perMinute: 2, perDay: null }, cost: 1 }] as const;

  function spec(load: () => Promise<string>, key = 'k') {
    return { provider: 'fred', endpoint: 'e', cacheKey: key, policy, budgets, load } as const;
  }

  it('does not ask the provider again inside the cache lifetime', async () => {
    const runtime = createProviderRuntime();
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return Promise.resolve('v');
    };
    await serve(runtime, { now: () => T0 }, spec(load));
    const second = await serve(runtime, { now: () => T0 + 500 }, spec(load));
    assert.equal(loads, 1);
    assert.equal(second.origin, 'cache');
  });

  it('spends the budget and then serves the last verified answer instead of asking', async () => {
    const runtime = createProviderRuntime();
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return Promise.resolve(`v${loads}`);
    };
    await serve(runtime, { now: () => T0 }, spec(load, 'a'));
    await serve(runtime, { now: () => T0 + 100 }, spec(load, 'b'));
    // Budget (2 per minute) is spent. Key "a" has expired, and must not reach the provider.
    const served = await serve(runtime, { now: () => T0 + 2_000 }, spec(load, 'a'));
    assert.equal(loads, 2);
    assert.equal(served.origin, 'stale-if-error');
    assert.equal(served.value, 'v1');
    assert.equal(served.failure?.code, 'rate_limited');
    // A key with no earlier answer has nothing to serve, and says it is rate limited.
    await assert.rejects(
      serve(runtime, { now: () => T0 + 2_100 }, spec(load, 'c')),
      (error: unknown) => error instanceof ApiFailure && error.code === 'rate_limited',
    );
    assert.equal(loads, 2);
  });

  it('stops asking a provider that said to stop, including for other keys', async () => {
    const runtime = createProviderRuntime();
    let loads = 0;
    const refuse = (): Promise<string> => {
      loads += 1;
      return Promise.reject(new ApiFailure('rate_limited', 'limit', 90));
    };
    await assert.rejects(serve(runtime, { now: () => T0 }, spec(refuse, 'a')));
    await assert.rejects(
      serve(
        runtime,
        { now: () => T0 + 30_000 },
        spec(() => Promise.resolve('x'), 'other'),
      ),
      (error: unknown) => error instanceof ApiFailure && error.code === 'rate_limited',
    );
    assert.equal(loads, 1);
    const later = await serve(
      runtime,
      { now: () => T0 + 91_000 },
      spec(() => Promise.resolve('x'), 'other'),
    );
    assert.equal(later.value, 'x');
  });

  it('retries a transient failure once and then succeeds, spending a credit per attempt', async () => {
    const waits: number[] = [];
    const runtime = {
      ...createProviderRuntime(),
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
    let loads = 0;
    const flaky = (): Promise<string> => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new ApiFailure('provider_unreachable', 'down', null, { retryable: true }))
        : Promise.resolve('ok');
    };
    const served = await serve(runtime, { now: () => T0 }, spec(flaky));
    assert.equal(served.value, 'ok');
    assert.equal(loads, 2);
    assert.equal(waits.length, 1);
    assert.equal(runtime.limiter.usage('example', T0).minuteUsed, 2);
  });
});
