import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTtlCache } from '../../server/cache.js';
import type { CalendarFetch } from '../../server/calendar-shared.js';
import { ApiFailure } from '../../server/errors.js';
import { defaultCalendarDays, loadCalendar } from '../../server/feeds-service.js';
import { readProvider } from '../../server/provider-registry.js';
import { createProviderRuntime, createValidatorStore } from '../../server/provider-runtime.js';
import type { ServiceDeps } from '../../server/service.js';
import { fetchShowMyTrades } from '../../server/showmytrades.js';
import { fetchXoomar } from '../../server/xoomar.js';
import {
  FC_HOST,
  SMT_HOST,
  XOOMAR_HOST,
  financeCalendarBody,
  smtBody,
  smtEvent,
  xoomarBody,
  xoomarEvent,
} from '../support/calendar-providers.js';
import {
  createFakeProviders,
  json,
  text,
  type ProviderCallRecord,
} from '../support/fake-provider.js';
import { FIXTURE_NOW } from '../support/fixtures.js';

/**
 * How the economic calendar behaves when its sources do not behave: the adapters against the
 * failures a provider can show, the router against a primary that fails, and the rules that keep a
 * missing figure from becoming a number. Every answer here is a stand-in in the documented shape;
 * none of it proves that a live provider answers this way today.
 */

const SMT_BASE = 'https://showmytrades.com/api/public';
const XOOMAR_BASE = 'https://xoomar.com/api/markets';
const WINDOW = { fromMs: Date.UTC(2026, 0, 6), toMs: Date.UTC(2026, 0, 9) };

type Respond = (call: ProviderCallRecord) => Response | Record<string, unknown> | undefined;

function http(respond: Respond, now = FIXTURE_NOW) {
  const fake = createFakeProviders(respond);
  return { fake, deps: { fetch: fake.fetch, now: () => now } };
}

async function failureOf(run: () => Promise<unknown>): Promise<ApiFailure> {
  try {
    await run();
  } catch (failure) {
    assert.ok(failure instanceof ApiFailure, `expected an ApiFailure, got ${String(failure)}`);
    return failure;
  }
  throw new Error('expected the request to fail');
}

interface Source {
  readonly name: string;
  readonly host: string;
  /** One valid answer carrying `rows`. */
  readonly answer: (rows: unknown[]) => Record<string, unknown>;
  readonly row: (over?: Record<string, unknown>) => Record<string, unknown>;
  readonly fetch: (
    deps: ReturnType<typeof http>['deps'],
    validators?: ReturnType<typeof createValidatorStore>,
  ) => Promise<CalendarFetch>;
  /** A row whose time cannot be read. */
  readonly badTime: Record<string, unknown>;
}

const SOURCES: readonly Source[] = [
  {
    name: 'ShowMyTrades',
    host: SMT_HOST,
    answer: (rows) => smtBody(rows),
    row: smtEvent,
    fetch: (deps, validators) => fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, 8, validators),
    badTime: smtEvent({ time: 'next tuesday', ts: 'soon' }),
  },
  {
    name: 'XOOMAR',
    host: XOOMAR_HOST,
    answer: (rows) => xoomarBody(rows),
    row: xoomarEvent,
    fetch: (deps, validators) =>
      fetchXoomar(deps, { baseUrl: XOOMAR_BASE, apiKey: null }, WINDOW, validators),
    badTime: xoomarEvent({ scheduledAt: 'next tuesday' }),
  },
];

describe('calendar providers: what each failure becomes', () => {
  for (const source of SOURCES) {
    describe(source.name, () => {
      it('reads a successful answer', async () => {
        const { deps } = http(() => source.answer([source.row()]));
        const result = await source.fetch(deps);
        assert.equal(result.events.length, 1);
        assert.equal(result.excluded.length, 0);
        assert.equal(result.total, 1);
      });

      it('reads an empty answer as no events, not as a failure and not as a quiet day', async () => {
        const { deps } = http(() => source.answer([]));
        const result = await source.fetch(deps);
        assert.equal(result.events.length, 0);
        assert.equal(result.total, 0);
      });

      it('refuses a body that is not JSON, even with HTTP 200', async () => {
        const { deps } = http(() => text('<html>maintenance</html>', 200));
        const failure = await failureOf(() => source.fetch(deps));
        assert.equal(failure.code, 'provider_error');
      });

      it('refuses valid JSON that is not a calendar, even with HTTP 200', async () => {
        const { deps } = http(() => ({ ok: true }));
        const failure = await failureOf(() => source.fetch(deps));
        assert.equal(failure.code, 'provider_error');
      });

      for (const status of [401, 403]) {
        it(`says the provider refused the request on HTTP ${status}, and blames no credential`, async () => {
          const { deps } = http(() => json({ error: 'no' }, status));
          const failure = await failureOf(() => source.fetch(deps));
          assert.equal(failure.code, 'provider_error', 'a keyless request has no key to reject');
          assert.match(failure.message, /needs none/);
          assert.doesNotMatch(failure.message, /rejected the configured credential/);
        });
      }

      it('reads HTTP 429 as rate limited', async () => {
        const { deps } = http(() => json({ error: 'slow down' }, 429, { 'Retry-After': '30' }));
        const failure = await failureOf(() => source.fetch(deps));
        assert.equal(failure.code, 'rate_limited');
        assert.equal(failure.retryAfterSeconds, 30);
      });

      it('reads HTTP 500 as a failure that may be retried', async () => {
        const { deps } = http(() => json({ error: 'boom' }, 500));
        const failure = await failureOf(() => source.fetch(deps));
        assert.equal(failure.code, 'provider_error');
        assert.equal(failure.retryable, true);
      });

      it('reads a dropped connection or a timeout as unreachable', async () => {
        const deps = {
          fetch: (async () => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
          }) as typeof fetch,
          now: () => FIXTURE_NOW,
        };
        const failure = await failureOf(() => source.fetch(deps));
        assert.equal(failure.code, 'provider_unreachable');
      });

      it('excludes an event whose time cannot be read, and says why, keeping the others', async () => {
        const { deps } = http(() => source.answer([source.badTime, source.row()]));
        const result = await source.fetch(deps);
        assert.equal(result.events.length, 1);
        assert.equal(result.excluded.length, 1);
        assert.match(result.excluded[0]?.reason ?? '', /time/i);
      });

      it('never follows a redirect and never sends a credential it does not have', async () => {
        const { deps, fake } = http(() => source.answer([source.row()]));
        await source.fetch(deps);
        const sent = fake.calls[0];
        assert.equal(sent?.redirect, 'error');
        assert.equal(sent?.host, source.host);
        assert.equal(sent?.headers['x-api-key'], undefined);
        assert.equal(sent?.headers['authorization'], undefined);
      });
    });
  }

  it('keeps a missing actual, forecast and previous as null: a missing figure is not a zero', async () => {
    const { deps } = http(() => smtBody([smtEvent({ actual: '', forecast: '', previous: '' })]));
    const result = await fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, 8);
    const event = result.events[0];
    assert.equal(event?.actual, null);
    assert.equal(event?.forecast, null);
    assert.equal(event?.previous, null);
    assert.equal(event?.surprise, undefined, 'no surprise is made from nothing');
  });

  it('keeps a real zero as a real zero and does not confuse it with a missing figure', async () => {
    const { deps } = http(() =>
      smtBody([smtEvent({ actual: '0', forecast: '0.2', previous: '0.1' })]),
    );
    const event = (await fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, 8)).events[0];
    assert.equal(event?.actual, '0');
    assert.equal(event?.surprise?.value, -0.2);
  });

  it('calculates a surprise only from an actual and a forecast in the same unit', async () => {
    const same = smtEvent({ id: 'a.1', actual: '3.1%', forecast: '2.9%' });
    const mixed = smtEvent({ id: 'a.2', actual: '3.1%', forecast: '2.9' });
    const noForecast = smtEvent({ id: 'a.3', actual: '3.1%', forecast: '' });
    const noActual = smtEvent({ id: 'a.4', actual: '', forecast: '2.9%' });
    const words = smtEvent({ id: 'a.5', actual: 'n/a', forecast: '2.9%' });
    const { deps } = http(() => smtBody([same, mixed, noForecast, noActual, words]));
    const events = (await fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, 8)).events;
    const surprise = (id: string) => events.find((event) => event.id.endsWith(id))?.surprise;
    assert.deepEqual(
      { value: surprise('a.1')?.value, unit: surprise('a.1')?.unit },
      { value: 0.2, unit: '%' },
    );
    assert.equal(surprise('a.2'), undefined, 'different units');
    assert.equal(surprise('a.3'), undefined, 'no forecast');
    assert.equal(surprise('a.4'), undefined, 'no actual');
    assert.equal(surprise('a.5'), undefined, 'not a number');
  });

  it('gives XOOMAR events no surprise: it publishes no forecast', async () => {
    const { deps } = http(() => xoomarBody([xoomarEvent({ actual: '250' })]));
    const result = await fetchXoomar(deps, { baseUrl: XOOMAR_BASE, apiKey: null }, WINDOW);
    assert.equal(result.events[0]?.forecast, null);
    assert.equal(result.events[0]?.surprise, undefined);
  });

  it('drops a repeated event id instead of listing the event twice', async () => {
    const { deps } = http(() => smtBody([smtEvent(), smtEvent()]));
    const result = await fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, 8);
    assert.equal(result.events.length, 1);
  });

  it('refuses a window it does not ask for', async () => {
    const { deps, fake } = http(() => smtBody());
    for (const days of [0, 31, 2.5]) {
      const failure = await failureOf(() => fetchShowMyTrades(deps, { baseUrl: SMT_BASE }, days));
      assert.equal(failure.code, 'bad_request');
    }
    assert.equal(fake.calls.length, 0, 'nothing is sent for a window that is refused');
  });

  it('sends XOOMAR key only to XOOMAR, in the header, and rejects a bad key as a credential failure', async () => {
    const key = 'k'.repeat(32);
    const { deps, fake } = http(() => json({ error: 'bad key' }, 401));
    const failure = await failureOf(() =>
      fetchXoomar(deps, { baseUrl: XOOMAR_BASE, apiKey: key }, WINDOW),
    );
    assert.equal(failure.code, 'provider_auth');
    assert.equal(fake.calls[0]?.headers['x-api-key'], key);
    assert.ok(!failure.message.includes(key), 'the key is never echoed');
    assert.ok(!(fake.calls[0]?.url ?? '').includes(key), 'the key is never in the address');
  });
});

describe('calendar providers: conditional requests', () => {
  for (const source of SOURCES) {
    it(`${source.name}: asks whether its answer changed, and keeps the held answer on 304`, async () => {
      const validators = createValidatorStore();
      let n = 0;
      const clock = { now: FIXTURE_NOW };
      const fake = createFakeProviders((call) => {
        n += 1;
        if (n === 1) {
          return new Response(JSON.stringify(source.answer([source.row()])), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
          });
        }
        assert.equal(call.headers['if-none-match'], '"v1"', 'the held tag is sent');
        return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      });
      const deps = { fetch: fake.fetch, now: () => clock.now };
      const first = await source.fetch(deps, validators);
      clock.now += 15 * 60_000;
      const second = await source.fetch(deps, validators);
      assert.equal(fake.calls.length, 2);
      assert.equal(second.events.length, first.events.length, 'the held answer is kept');
      assert.equal(first.events[0]?.source.retrievedAt, FIXTURE_NOW);
      assert.equal(
        second.events[0]?.source.retrievedAt,
        clock.now,
        'it is stamped as confirmed now',
      );
    });

    it(`${source.name}: sends no tag it was not given, and ignores a tag that is not one`, async () => {
      const validators = createValidatorStore();
      const fake = createFakeProviders(
        () =>
          new Response(JSON.stringify(source.answer([source.row()])), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'not a tag' },
          }),
      );
      const deps = { fetch: fake.fetch, now: () => FIXTURE_NOW };
      await source.fetch(deps, validators);
      await source.fetch(deps, validators);
      assert.equal(fake.calls[0]?.headers['if-none-match'], undefined);
      assert.equal(fake.calls[1]?.headers['if-none-match'], undefined);
    });

    it(`${source.name}: a 304 to a request that carried no tag is an error, never data`, async () => {
      const deps = http(() => new Response(null, { status: 304 })).deps;
      const failure = await failureOf(() => source.fetch(deps, createValidatorStore()));
      assert.equal(failure.code, 'provider_error');
    });
  }
});

// ---- the router -------------------------------------------------------------------------------------

interface Rig {
  readonly deps: ServiceDeps;
  readonly calls: ProviderCallRecord[];
  readonly clock: { now: number };
}

function rig(respond: Respond, env: Record<string, string | undefined> = {}): Rig {
  const fake = createFakeProviders(respond);
  const clock = { now: FIXTURE_NOW };
  const runtime = {
    ...createProviderRuntime(createTtlCache()),
    sleep: async (): Promise<void> => {},
  };
  return {
    deps: { env, fetch: fake.fetch, now: () => clock.now, runtime },
    calls: fake.calls,
    clock,
  };
}

const hostsOf = (calls: readonly ProviderCallRecord[]): string[] => calls.map((call) => call.host);

describe('calendar router', () => {
  const days = () => defaultCalendarDays(FIXTURE_NOW);

  it('ShowMyTrades answers: XOOMAR and Finance Calendar are never asked, even with a key', async () => {
    const { deps, calls } = rig((call) => (call.host === SMT_HOST ? smtBody() : undefined), {
      FINANCE_CALENDAR_API_KEY: 'f'.repeat(32),
      XOOMAR_API_KEY: 'x'.repeat(32),
    });
    const outcome = await loadCalendar(deps, days());
    assert.equal(outcome.kind, 'data');
    assert.equal(outcome.provenance.provider, 'showmytrades');
    assert.equal(outcome.provenance.fallback, null);
    assert.deepEqual(hostsOf(calls), [SMT_HOST]);
  });

  it('asks the source once per refresh, not once per reader', async () => {
    const { deps, calls } = rig((call) => (call.host === SMT_HOST ? smtBody() : undefined));
    await loadCalendar(deps, days());
    await loadCalendar(deps, days());
    await loadCalendar(deps, days());
    assert.equal(calls.length, 1, 'identical requests are answered from the cache');
  });

  it('ShowMyTrades fails: XOOMAR is asked, and the answer says it is the fallback and why', async () => {
    const { deps, calls } = rig((call) => {
      if (call.host === SMT_HOST) return json({ error: 'down' }, 503);
      if (call.host === XOOMAR_HOST) return xoomarBody();
      return undefined;
    });
    const outcome = await loadCalendar(deps, days());
    assert.equal(outcome.kind, 'data');
    assert.equal(outcome.provenance.provider, 'xoomar');
    assert.equal(outcome.provenance.fallback?.from, 'showmytrades');
    assert.match(outcome.provenance.fallback?.reason ?? '', /ShowMyTrades \(ERROR\)/);
    assert.ok(hostsOf(calls).includes(XOOMAR_HOST));
    assert.ok(!hostsOf(calls).includes(FC_HOST), 'Finance Calendar has no key and is not asked');
  });

  it('treats HTTP 200 with a body that is not a calendar as a failure of that source', async () => {
    const { deps } = rig((call) => {
      if (call.host === SMT_HOST) return { status: 'ok', message: 'welcome' };
      if (call.host === XOOMAR_HOST) return xoomarBody();
      return undefined;
    });
    const outcome = await loadCalendar(deps, days());
    assert.equal(outcome.kind, 'data');
    assert.equal(outcome.provenance.provider, 'xoomar');
    assert.match(outcome.provenance.fallback?.reason ?? '', /ShowMyTrades \(ERROR\)/);
  });

  it('a rate limit at the primary passes to the fallback and is reported as RATE LIMITED', async () => {
    const { deps } = rig((call) => {
      if (call.host === SMT_HOST) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
      if (call.host === XOOMAR_HOST) return xoomarBody();
      return undefined;
    });
    const outcome = await loadCalendar(deps, days());
    assert.equal(outcome.kind, 'data');
    assert.equal(outcome.provenance.provider, 'xoomar');
    assert.match(outcome.provenance.fallback?.reason ?? '', /ShowMyTrades \(RATE LIMITED\)/);
  });

  it('every source unavailable: UNAVAILABLE with each reason, and not one event', async () => {
    const { deps } = rig(() => json({ error: 'down' }, 503));
    const outcome = await loadCalendar(deps, days());
    assert.equal(outcome.kind, 'withheld');
    assert.equal(outcome.provenance.state, 'UNAVAILABLE');
    const message = outcome.provenance.message ?? '';
    assert.match(message, /ShowMyTrades \(ERROR\)/);
    assert.match(message, /XOOMAR \(ERROR\)/);
    assert.doesNotMatch(
      message,
      /ENV NOT CONNECTED/,
      'no credential is missing, so none is blamed',
    );
  });

  it('asks the optional Finance Calendar last, and only with its key', async () => {
    const respond: Respond = (call) => {
      if (call.host === FC_HOST) return financeCalendarBody();
      return json({ error: 'down' }, 503);
    };
    const withoutKey = rig(respond);
    const none = await loadCalendar(withoutKey.deps, days());
    assert.equal(none.kind, 'withheld');
    assert.ok(!hostsOf(withoutKey.calls).includes(FC_HOST));

    const withKey = rig(respond, { FINANCE_CALENDAR_API_KEY: 'f'.repeat(32) });
    const answered = await loadCalendar(withKey.deps, days());
    assert.equal(answered.kind, 'data');
    assert.equal(answered.provenance.provider, 'financecalendar');
    const order = hostsOf(withKey.calls);
    assert.ok(order.indexOf(FC_HOST) > order.indexOf(SMT_HOST));
    assert.ok(order.indexOf(FC_HOST) > order.indexOf(XOOMAR_HOST));
  });

  it('AriB without written permission is never asked, with or without any variable', async () => {
    for (const env of [
      {},
      { ARIB_API_KEY: 'a'.repeat(32), ARIB_RESEARCH_API_KEY: 'a'.repeat(32) },
    ]) {
      const { deps, calls } = rig(() => json({ error: 'down' }, 503), env);
      await loadCalendar(deps, days());
      assert.ok(
        calls.every((call) => !/arib/i.test(call.host)),
        'no request reaches an AriB host',
      );
      const reading = readProvider('arib', env);
      assert.equal(reading.kind, 'license-gated');
    }
  });

  it('a kept copy is never presented as live: once old and the sources fail it is labelled', async () => {
    let sourcesUp = true;
    const { deps, clock } = rig((call) => {
      if (!sourcesUp) return json({ error: 'down' }, 503);
      return call.host === SMT_HOST ? smtBody() : undefined;
    });
    const first = await loadCalendar(deps, days());
    assert.equal(first.kind, 'data');
    assert.ok(['LIVE', 'DELAYED'].includes(first.provenance.state));

    sourcesUp = false;
    clock.now += 40 * 60_000; // past the cache lifetime, inside the window a copy may be kept
    const old = await loadCalendar(deps, days());
    assert.equal(old.kind, 'data');
    assert.equal(old.provenance.cache, 'stale-if-error');
    assert.ok(
      !['LIVE', 'DELAYED'].includes(old.provenance.state),
      `a copy kept after a failure is ${old.provenance.state}, not live`,
    );

    clock.now += 3 * 24 * 3_600_000; // far too old to keep
    const gone = await loadCalendar(deps, days());
    assert.equal(gone.kind, 'withheld', 'a copy that old is not shown at all');
  });
});

// ---- nothing fake in production ----------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('no stand-in calendar reaches the product', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('server'), ...sourceFiles('api')];

  it('nothing under src, server or api imports from tests', () => {
    const offenders = files.filter((file) =>
      /from '(\.\.?\/)+tests\//.test(readFileSync(file, 'utf8')),
    );
    assert.deepEqual(offenders, []);
  });

  it('no event title, schedule or figure of a fixture is written in product code', () => {
    const markers = [
      'Test inflation release',
      'Test employment report',
      'Test legacy release',
      'TEST FIXTURES',
    ];
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return markers.some((marker) => source.includes(marker));
    });
    assert.deepEqual(offenders, []);
  });
});
