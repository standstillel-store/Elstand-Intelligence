import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROVIDER_STATES, type ProviderState } from '../../src/core/provider-state.js';
import type { Provenance } from '../../src/data/provenance.js';
import { createTtlCache } from '../../server/cache.js';
import { policyFor } from '../../server/cache-policy.js';
import { ApiFailure } from '../../server/errors.js';
import { readProvider } from '../../server/provider-registry.js';
import { createProviderRuntime } from '../../server/provider-runtime.js';
import {
  asFallback,
  credentialOf,
  failureReason,
  severityOf,
  through,
  unreadyProvenance,
  worstProvenance,
  type Outcome,
  type ServiceDeps,
  type ThroughSpec,
} from '../../server/service.js';
import { FIXTURE_NOW } from '../support/fixtures.js';

/**
 * The shared request path every capability goes through. These tests use a keyless provider and
 * loaders that return or throw, so they prove the states and the words of an answer without
 * involving any provider's wire format (the adapter tests do that).
 */

const T0 = FIXTURE_NOW;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function setup(env: Record<string, string | undefined> = {}) {
  const clock = { now: T0 };
  const runtime = {
    ...createProviderRuntime(createTtlCache()),
    sleep: async (): Promise<void> => {},
  };
  const deps: ServiceDeps = {
    env,
    fetch: (async () => {
      throw new Error('the network must not be used by these tests');
    }) as typeof fetch,
    now: () => clock.now,
    runtime,
  };
  return { clock, deps };
}

/** A loader that returns the time of its newest datum, here a point in the past. */
function numberSpec(
  load: () => Promise<number>,
  over: Partial<ThroughSpec<number>> = {},
): ThroughSpec<number> {
  return {
    provider: 'frankfurter',
    capability: 'reference-rates',
    endpoint: 'latest',
    dataClass: 'reference-rates',
    cacheKey: 'test:value',
    dataAsOf: (value) => value,
    load,
    ...over,
  };
}

function dataOf<T>(outcome: Outcome<T>): Extract<Outcome<T>, { readonly kind: 'data' }> {
  assert.ok(
    outcome.kind === 'data',
    `expected data, got ${outcome.provenance.state}: ${outcome.provenance.message ?? ''}`,
  );
  return outcome;
}

function withheldOf<T>(outcome: Outcome<T>): Extract<Outcome<T>, { readonly kind: 'withheld' }> {
  assert.ok(
    outcome.kind === 'withheld',
    `expected nothing to show, got ${outcome.provenance.state}`,
  );
  return outcome;
}

const unreachable = (): ApiFailure =>
  new ApiFailure('provider_unreachable', 'down', null, { retryable: true });

describe('through: what an answer says it is', () => {
  it('labels a retrieved answer DELAYED, and LIVE only when the feed is declared live', async () => {
    const { deps } = setup();
    const delayed = dataOf(
      await through(
        deps,
        numberSpec(async () => T0 - 1_000),
      ),
    );
    assert.equal(delayed.provenance.state, 'DELAYED');
    assert.equal(delayed.provenance.cache, 'fresh');
    assert.equal(delayed.provenance.retrievedAt, T0);
    assert.equal(delayed.provenance.dataAsOf, T0 - 1_000);
    assert.equal(delayed.provenance.message, null);
    assert.equal(delayed.provenance.fallback, null);
    assert.equal(delayed.provenance.provider, 'frankfurter');
    assert.equal(delayed.provenance.capability, 'reference-rates');

    const other = setup();
    const live = dataOf(
      await through(
        other.deps,
        numberSpec(async () => T0 - 1_000, { live: true }),
      ),
    );
    assert.equal(live.provenance.state, 'LIVE');
  });

  it('reuses an answer for its lifetime and says it came from the server cache', async () => {
    const { deps, clock } = setup();
    let calls = 0;
    const load = async (): Promise<number> => {
      calls += 1;
      return T0 - 1_000;
    };
    await through(deps, numberSpec(load));
    clock.now = T0 + 10 * 60_000;
    const again = dataOf(await through(deps, numberSpec(load)));
    assert.equal(calls, 1, 'the provider was asked once');
    assert.equal(again.provenance.cache, 'cache');
    assert.equal(
      again.provenance.retrievedAt,
      T0,
      'the retrieval time is the provider answer, not this call',
    );
    assert.ok(again.shareMs <= policyFor({}, 'reference-rates').ttlMs);
    assert.ok(again.shareMs >= 1_000);
  });

  it('is ENV NOT CONNECTED, in the documented words, when the credential is missing, and asks nothing', async () => {
    const { deps } = setup({});
    let asked = false;
    const outcome = withheldOf(
      await through(deps, {
        ...numberSpec(async () => {
          asked = true;
          return 0;
        }),
        provider: 'fred',
        capability: 'macro-observations',
        endpoint: 'series/observations',
        dataClass: 'macro-series',
      }),
    );
    assert.equal(asked, false);
    assert.equal(outcome.failure, null, 'the provider was never asked');
    assert.equal(outcome.provenance.state, 'ENV NOT CONNECTED');
    assert.equal(
      outcome.provenance.message,
      'ENV NOT CONNECTED — FRED_API_KEY is missing. Macro observations from FRED are unavailable.',
    );
    assert.equal(outcome.provenance.retrievedAt, null);
    assert.equal(outcome.provenance.dataAsOf, null);
  });

  it('is UNAVAILABLE, in the documented words, for a dataset with no supported endpoint', async () => {
    const { deps } = setup({});
    const outcome = withheldOf(
      await through(deps, {
        ...numberSpec(async () => 0),
        provider: 'imf',
        capability: 'macro-observations',
        endpoint: 'none',
        dataClass: 'macro-series',
      }),
    );
    assert.equal(outcome.provenance.state, 'UNAVAILABLE');
    assert.equal(
      outcome.provenance.message,
      'UNAVAILABLE — No supported public endpoint is configured for this dataset.',
    );
  });

  it('reports a provider that refused as RATE LIMITED and pauses instead of asking again', async () => {
    const { deps, clock } = setup();
    let calls = 0;
    const load = async (): Promise<number> => {
      calls += 1;
      throw new ApiFailure('rate_limited', 'slow down', 30);
    };
    const first = withheldOf(await through(deps, numberSpec(load)));
    assert.equal(first.provenance.state, 'RATE LIMITED');
    assert.equal(first.provenance.message, 'RATE LIMITED — Frankfurter rejected the request.');
    assert.equal(first.failure?.local, false, 'the provider itself refused');
    assert.equal(calls, 1, 'a rate limit is never retried');

    clock.now = T0 + 2_000;
    const paused = withheldOf(await through(deps, numberSpec(load, { cacheKey: 'test:other' })));
    assert.equal(calls, 1, 'nothing is sent to a provider that said to stop');
    assert.equal(paused.provenance.state, 'RATE LIMITED');
    assert.equal(paused.failure?.local, false, 'the pause follows a refusal by the provider');
  });

  it("says so when Elstand's own budget held the request back, instead of blaming the provider", async () => {
    const { deps } = setup();
    let asked = false;
    const outcome = withheldOf(
      await through(
        deps,
        // Frankfurter's budget is 30 a minute; a request that costs 31 can never be sent.
        numberSpec(
          async () => {
            asked = true;
            return 0;
          },
          { cost: 31 },
        ),
      ),
    );
    assert.equal(asked, false);
    assert.equal(outcome.provenance.state, 'RATE LIMITED');
    assert.equal(
      outcome.provenance.message,
      'RATE LIMITED — The request budget kept for Frankfurter is spent, so this request was not sent.',
    );
    assert.doesNotMatch(outcome.provenance.message ?? '', /rejected/);
    assert.equal(outcome.failure?.local, true);
    assert.equal(outcome.failure?.budget, 'minute');
  });

  it('reports a failed request as ERROR with the reason, and never a success', async () => {
    const { deps } = setup();
    const outcome = withheldOf(
      await through(
        deps,
        numberSpec(async () => {
          throw new ApiFailure('provider_error', 'The provider sent data that did not validate.');
        }),
      ),
    );
    assert.equal(outcome.provenance.state, 'ERROR');
    assert.equal(
      outcome.provenance.message,
      'ERROR — The provider sent data that did not validate.',
    );
  });

  it('lets a request this server built wrongly surface as the defect it is', async () => {
    const { deps } = setup();
    await assert.rejects(
      through(
        deps,
        numberSpec(async () => {
          throw new ApiFailure('bad_request', 'The request was built wrongly.');
        }),
      ),
      (error: unknown) => error instanceof ApiFailure && error.code === 'bad_request',
    );
  });

  it('retries only what is worth repeating, a bounded number of times', async () => {
    const { deps } = setup();
    let calls = 0;
    await through(
      deps,
      numberSpec(async () => {
        calls += 1;
        throw unreachable();
      }),
    );
    assert.equal(calls, 2, 'one retry, then it stops');

    const auth = setup();
    let authCalls = 0;
    const rejected = withheldOf(
      await through(
        auth.deps,
        numberSpec(async () => {
          authCalls += 1;
          throw new ApiFailure('provider_auth', 'The provider rejected the credential.');
        }),
      ),
    );
    assert.equal(authCalls, 1, 'a rejected credential is not retried');
    assert.equal(rejected.provenance.state, 'ERROR');
  });
});

describe('through: when the newest datum is old', () => {
  it('labels an answer STALE when the datum is older than its window, though it was just retrieved', async () => {
    const { deps } = setup();
    const outcome = dataOf(
      await through(
        deps,
        numberSpec(async () => T0 - 2 * HOUR, { datumFreshMs: HOUR, datumFreshText: '1 hour' }),
      ),
    );
    assert.equal(outcome.provenance.state, 'STALE');
    assert.match(outcome.provenance.message ?? '', /^STALE — The newest datum is from /);
    assert.match(outcome.provenance.message ?? '', /older than 1 hour/);
    assert.match(outcome.provenance.message ?? '', /Last successful retrieval: /);
    assert.equal(outcome.shareMs, 30_000, 'a degraded answer is shared only briefly');
  });

  it('lets the caller say that age alone proves nothing (a closed market is not stale)', async () => {
    const { deps } = setup();
    const outcome = dataOf(
      await through(
        deps,
        numberSpec(async () => T0 - 5 * DAY, { datumFreshMs: HOUR, isCurrent: () => true }),
      ),
    );
    assert.equal(outcome.provenance.state, 'DELAYED');
  });
});

describe('through: the last verified answer', () => {
  const failing = async (): Promise<number> => {
    throw unreachable();
  };

  it('serves it as CACHED, with the reason and the time it was verified', async () => {
    const { deps, clock } = setup();
    await through(
      deps,
      numberSpec(async () => T0 - 1_000),
    );
    const ttl = policyFor({}, 'reference-rates').ttlMs;
    clock.now = T0 + ttl + 60_000;
    const outcome = dataOf(await through(deps, numberSpec(failing)));
    assert.equal(outcome.provenance.state, 'CACHED');
    assert.equal(outcome.provenance.cache, 'stale-if-error');
    assert.equal(outcome.provenance.retrievedAt, T0, 'the time the provider last answered');
    assert.match(
      outcome.provenance.message ?? '',
      /^CACHED — Frankfurter could not be asked: it could not be reached\./,
    );
    assert.match(outcome.provenance.message ?? '', /Showing its last verified answer, retrieved /);
    assert.equal(outcome.shareMs, 30_000);
  });

  it('becomes STALE once the last verified answer is older than the freshness window', async () => {
    const { deps, clock } = setup();
    await through(
      deps,
      numberSpec(async () => T0 - 1_000),
    );
    const { freshWindowMs, staleIfErrorMs, ttlMs } = policyFor({}, 'reference-rates');
    clock.now = T0 + freshWindowMs + 1_000;
    assert.ok(clock.now < T0 + ttlMs + staleIfErrorMs, 'still inside the window it may be shown');
    const outcome = dataOf(await through(deps, numberSpec(failing)));
    assert.equal(outcome.provenance.state, 'STALE');
    assert.match(
      outcome.provenance.message ?? '',
      /^STALE — Last successful retrieval: .+\. Current data could not be verified\.$/,
    );
  });

  it('shows nothing, rather than something older, after the window it may be shown', async () => {
    const { deps, clock } = setup();
    await through(
      deps,
      numberSpec(async () => T0 - 1_000),
    );
    const { staleIfErrorMs, ttlMs } = policyFor({}, 'reference-rates');
    clock.now = T0 + ttlMs + staleIfErrorMs + 1_000;
    const outcome = withheldOf(await through(deps, numberSpec(failing)));
    assert.equal(outcome.provenance.state, 'ERROR');
  });

  it('uses the RATE LIMITED words, with the last verified time, when the provider refused', async () => {
    const { deps, clock } = setup();
    await through(
      deps,
      numberSpec(async () => T0 - 1_000),
    );
    clock.now = T0 + policyFor({}, 'reference-rates').ttlMs + 60_000;
    const outcome = dataOf(
      await through(
        deps,
        numberSpec(async () => {
          throw new ApiFailure('rate_limited', 'slow down');
        }),
      ),
    );
    assert.equal(outcome.provenance.state, 'CACHED');
    assert.match(
      outcome.provenance.message ?? '',
      /^RATE LIMITED — Frankfurter rejected the request\. Last verified data: .+\.$/,
    );
  });
});

describe('what a group of answers is called', () => {
  const provenance = (state: ProviderState, label: string = state): Provenance => ({
    provider: 'fred',
    providerLabel: label,
    capability: 'macro-observations',
    endpoint: 'x',
    state,
    retrievedAt: null,
    dataAsOf: null,
    cache: 'fresh',
    fallback: null,
    message: null,
  });

  it('ranks every state, worst first, with no state left out', () => {
    for (const state of PROVIDER_STATES) assert.equal(typeof severityOf(state), 'number', state);
    const order: ProviderState[] = [
      'ENV NOT CONNECTED',
      'ERROR',
      'RATE LIMITED',
      'UNAVAILABLE',
      'STALE',
      'CACHED',
      'DELAYED',
      'LIVE',
    ];
    for (let index = 1; index < order.length; index += 1) {
      const worse = order[index - 1];
      const better = order[index];
      assert.ok(
        worse !== undefined && better !== undefined && severityOf(worse) > severityOf(better),
        `${worse} is worse than ${better}`,
      );
    }
  });

  it('summarizes a group by its worst member, the first of equals, and an empty group by nothing', () => {
    assert.equal(worstProvenance([]), null);
    const stale = provenance('STALE', 'a');
    const staleToo = provenance('STALE', 'b');
    const live = provenance('LIVE');
    assert.equal(worstProvenance([live, stale, staleToo]), stale);
    assert.equal(worstProvenance([live, provenance('ERROR'), stale])?.state, 'ERROR');
  });

  it('stamps a fallback on data only, and leaves a withheld answer as it is', () => {
    const data: Outcome<number> = {
      kind: 'data',
      value: 1,
      shareMs: 1_000,
      provenance: provenance('DELAYED'),
    };
    const stamped = dataOf(asFallback(data, 'twelvedata', 'because'));
    assert.deepEqual(stamped.provenance.fallback, { from: 'twelvedata', reason: 'because' });
    assert.equal(data.provenance.fallback, null, 'the original is not changed');

    const withheld: Outcome<number> = {
      kind: 'withheld',
      provenance: provenance('ERROR'),
      failure: null,
    };
    assert.equal(asFallback(withheld, 'twelvedata', 'because'), withheld);
  });

  it('gives the words of a failed provider as the reason for a fallback', () => {
    assert.equal(
      failureReason({ ...provenance('ERROR', 'Twelve Data'), message: 'ERROR — it broke' }),
      'ERROR — it broke',
    );
    assert.equal(failureReason(provenance('ERROR', 'Twelve Data')), 'Twelve Data did not answer.');
  });
});

describe('credentials and unready providers', () => {
  it('refuses to hand out a credential a provider does not have', () => {
    const reading = readProvider('frankfurter', {});
    assert.equal(reading.kind, 'ready');
    if (reading.kind !== 'ready') return;
    assert.throws(
      () => credentialOf(reading),
      (error: unknown) => error instanceof ApiFailure && error.code === 'not_connected',
    );
  });

  it('describes a provider that cannot be asked without naming any value', () => {
    const reading = readProvider('fred', {});
    assert.notEqual(reading.kind, 'ready');
    if (reading.kind === 'ready') return;
    const provenance = unreadyProvenance(
      'fred',
      'macro-observations',
      'series/observations',
      reading,
    );
    assert.equal(provenance.state, 'ENV NOT CONNECTED');
    assert.equal(provenance.retrievedAt, null);
    assert.equal(provenance.cache, 'fresh');
    assert.equal(provenance.fallback, null);
    assert.ok(!JSON.stringify(provenance).includes('undefined'));
  });
});
