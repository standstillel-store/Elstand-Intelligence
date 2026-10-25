import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeHttpUrl } from '../../src/core/url.js';
import {
  bubbleDirection,
  createUnconfiguredBubbleProvider,
  NO_BUBBLE_FEED_REASON,
  validateBubblePoints,
  type CurrencyMacroPoint,
} from '../../src/data/macro-bubbles.js';
import { screenCalendar, screenNews } from '../../src/data/macro-validate.js';
import {
  createUnconfiguredMacroFeed,
  NO_MACRO_FEED_REASON,
  type CalendarEvent,
  type NewsItem,
} from '../../src/data/macro.js';
import {
  createUnconfiguredSurfaceProvider,
  NO_OPTIONS_PROVIDER_REASON,
  SURFACE_STALE_AFTER_MS,
  validateVolSurface,
  validateVolSurfaceFor,
  volRange,
  type VolSurface,
} from '../../src/data/options.js';
import {
  FIXTURE_NOW,
  fixtureBubblePoints,
  fixtureCalendar,
  fixtureNews,
  fixtureSurface,
} from '../support/fixtures.js';

/** Freezes a value and everything reachable from it, so a stray write throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const signal = new AbortController().signal;

describe('unconfigured providers: with nothing connected they say so and return no data', () => {
  it('the surface provider is unavailable, with the reason and never a surface', async () => {
    const provider = createUnconfiguredSurfaceProvider();
    for (const instrumentId of ['EURUSD', 'XAUUSD', '']) {
      const result = await provider.getSurface(instrumentId, signal);
      assert.deepEqual(result, { status: 'unavailable', reason: NO_OPTIONS_PROVIDER_REASON });
    }
    assert.match(provider.label, /no options adapter/i);
  });

  it('the bubble provider is unavailable, with the reason and no points', async () => {
    const provider = createUnconfiguredBubbleProvider();
    const result = await provider.getPoints(signal);
    assert.deepEqual(result, { status: 'unavailable', reason: NO_BUBBLE_FEED_REASON });
    assert.match(provider.label, /no macro-series adapter/i);
  });

  it('the macro feed has no calendar and no news, with the reason', async () => {
    const feed = createUnconfiguredMacroFeed();
    const range = { fromMs: FIXTURE_NOW, toMs: FIXTURE_NOW + 86_400_000 };
    assert.deepEqual(await feed.getCalendar(range, signal), {
      status: 'unavailable',
      reason: NO_MACRO_FEED_REASON,
    });
    assert.deepEqual(await feed.getNews(signal), {
      status: 'unavailable',
      reason: NO_MACRO_FEED_REASON,
    });
    assert.match(feed.label, /no macro adapter/i);
  });

  it('every reason states that nothing exists to connect and that nothing is estimated or simulated', () => {
    for (const reason of [
      NO_OPTIONS_PROVIDER_REASON,
      NO_BUBBLE_FEED_REASON,
      NO_MACRO_FEED_REASON,
    ]) {
      assert.match(reason, /nothing to connect/);
    }
    assert.match(NO_BUBBLE_FEED_REASON, /does not estimate/);
  });
});

describe('validateVolSurface', () => {
  it('accepts a complete, ordered, positive grid', () => {
    assert.deepEqual(validateVolSurface(fixtureSurface()), []);
  });

  it('needs at least two strikes and two expiries', () => {
    const base = fixtureSurface();
    const oneStrike: VolSurface = {
      ...base,
      strikeAxis: { ...base.strikeAxis, values: [0] },
      iv: base.iv.map((row) => row.slice(0, 1)),
    };
    assert.deepEqual(validateVolSurface(oneStrike), ['strike axis needs at least 2 points']);

    const oneExpiry: VolSurface = { ...base, expiriesDays: [30], iv: base.iv.slice(0, 1) };
    assert.deepEqual(validateVolSurface(oneExpiry), ['expiry axis needs at least 2 points']);
  });

  it('requires strikes that are finite and strictly ascending', () => {
    const base = fixtureSurface();
    const message = 'strike axis must be finite and strictly ascending';
    for (const values of [
      [0.04, 0.02, 0, -0.02, -0.04],
      [-0.04, -0.02, -0.02, 0.02, 0.04],
      [-0.04, -0.02, Number.NaN, 0.02, 0.04],
      [-0.04, -0.02, 0, 0.02, Number.POSITIVE_INFINITY],
    ]) {
      const issues = validateVolSurface({ ...base, strikeAxis: { ...base.strikeAxis, values } });
      assert.ok(issues.includes(message), `expected "${message}" for ${JSON.stringify(values)}`);
    }
  });

  it('requires expiries that are positive, finite and strictly ascending', () => {
    const base = fixtureSurface();
    const message = 'expiry axis must be positive, finite and strictly ascending';
    for (const expiriesDays of [
      [0, 30, 90],
      [-7, 30, 90],
      [30, 7, 90],
      [7, 30, 30],
      [7, Number.NaN, 90],
    ]) {
      const issues = validateVolSurface({ ...base, expiriesDays });
      assert.ok(
        issues.includes(message),
        `expected "${message}" for ${JSON.stringify(expiriesDays)}`,
      );
    }
  });

  it('rejects an iv matrix whose rows do not match the expiry axis, and says nothing else about it', () => {
    const base = fixtureSurface();
    const issues = validateVolSurface({ ...base, iv: base.iv.slice(0, 2) });
    assert.deepEqual(issues, ['iv rows do not match the expiry axis']);
  });

  it('rejects a row that does not match the strike axis, naming the row', () => {
    const base = fixtureSurface();
    const iv = base.iv.map((row, index) => (index === 1 ? row.slice(0, 4) : [...row]));
    assert.deepEqual(validateVolSurface({ ...base, iv }), [
      'iv row 1 does not match the strike axis',
    ]);
  });

  it('rejects zero, negative and non-finite volatilities, naming the row', () => {
    const base = fixtureSurface();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const iv = base.iv.map((row, index) =>
        index === 2 ? row.map((value, col) => (col === 3 ? bad : value)) : [...row],
      );
      assert.deepEqual(
        validateVolSurface({ ...base, iv }),
        ['iv row 2 has a non-positive or non-finite value'],
        `value ${String(bad)}`,
      );
    }
  });

  it('reports the first bad row only, not one line per cell', () => {
    const base = fixtureSurface();
    const iv = base.iv.map((row) => row.map(() => Number.NaN));
    assert.equal(validateVolSurface({ ...base, iv }).length, 1);
  });

  it('collects axis problems and cell problems together', () => {
    const base = fixtureSurface();
    const iv = base.iv.map((row, index) => (index === 0 ? row.map(() => -1) : [...row]));
    const issues = validateVolSurface({
      ...base,
      strikeAxis: { ...base.strikeAxis, values: [0.04, 0.02, 0, -0.02, -0.04] },
      iv,
    });
    assert.equal(issues.length, 2);
  });

  it('only inspects: it never writes to the surface it is given', () => {
    const frozen = deepFreeze(fixtureSurface());
    assert.deepEqual(validateVolSurface(frozen), []);
    const broken = deepFreeze({ ...fixtureSurface(), expiriesDays: [30, 7, 90] });
    assert.ok(validateVolSurface(broken).length > 0);
  });
});

describe('validateVolSurfaceFor', () => {
  it('accepts a valid surface for the instrument that was asked for', () => {
    assert.deepEqual(validateVolSurfaceFor(fixtureSurface('GBPUSD'), 'GBPUSD'), []);
  });

  it('never accepts a surface for another instrument, and names both', () => {
    const issues = validateVolSurfaceFor(fixtureSurface('EURUSD'), 'GBPUSD');
    assert.deepEqual(issues, ['it describes EURUSD, not GBPUSD']);
  });

  it('is case sensitive: ids are registry ids, not free text', () => {
    assert.equal(validateVolSurfaceFor(fixtureSurface('EURUSD'), 'eurusd').length, 1);
  });

  it('reports the wrong instrument and a structural problem together', () => {
    const base = fixtureSurface('EURUSD');
    const issues = validateVolSurfaceFor({ ...base, expiriesDays: [30, 7, 90] }, 'USDJPY');
    assert.equal(issues.length, 2);
    assert.match(issues[0] ?? '', /EURUSD, not USDJPY/);
  });
});

describe('volRange and the staleness policy', () => {
  it('returns the smallest and largest volatility in the grid', () => {
    assert.deepEqual(volRange(fixtureSurface()), { min: 8.1, max: 10.4 });
  });

  it('has min equal to max for a flat surface', () => {
    const base = fixtureSurface();
    const flat: VolSurface = { ...base, iv: base.iv.map((row) => row.map(() => 9)) };
    assert.deepEqual(volRange(flat), { min: 9, max: 9 });
  });

  it('finds the extremes wherever they are, including the last cell', () => {
    const base = fixtureSurface();
    const iv = base.iv.map((row) => [...row]);
    const lastRow = iv[iv.length - 1];
    assert.ok(lastRow !== undefined);
    lastRow[lastRow.length - 1] = 99;
    assert.equal(volRange({ ...base, iv }).max, 99);
  });

  it('tolerates less staleness for a live feed than for a delayed one, and both are finite', () => {
    assert.equal(SURFACE_STALE_AFTER_MS.live, 10 * 60_000);
    assert.equal(SURFACE_STALE_AFTER_MS.delayed, 60 * 60_000);
    assert.ok(SURFACE_STALE_AFTER_MS.live < SURFACE_STALE_AFTER_MS.delayed);
  });
});

describe('validateBubblePoints', () => {
  it('accepts attributed, well-formed points', () => {
    assert.deepEqual(validateBubblePoints(fixtureBubblePoints()), []);
  });

  it('accepts an empty list: nothing to draw is not a validation failure', () => {
    assert.deepEqual(validateBubblePoints([]), []);
  });

  it('accepts a source without a URL: attribution needs a name, not a link', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    const point: CurrencyMacroPoint = {
      ...first,
      policyRate: { ...first.policyRate, source: { ...first.policyRate.source, url: null } },
    };
    assert.deepEqual(validateBubblePoints([point]), []);
  });

  it('rejects anything that is not a three-letter code', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    for (const currency of ['', 'US', 'USDX', 'U5D', '€UR']) {
      const issues = validateBubblePoints([{ ...first, currency }]);
      assert.deepEqual(issues, [`"${currency}" is not an ISO 4217 code`], JSON.stringify(currency));
    }
  });

  it('reads a code case-insensitively, so USD and usd are the same currency', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    assert.deepEqual(validateBubblePoints([{ ...first, currency: ' usd ' }]), []);
    assert.deepEqual(validateBubblePoints([first, { ...first, currency: 'usd' }]), [
      'USD appears more than once',
    ]);
  });

  it('rejects a currency listed twice', () => {
    const points = fixtureBubblePoints();
    assert.deepEqual(validateBubblePoints([...points, ...points.slice(0, 1)]), [
      'USD appears more than once',
    ]);
  });

  it('rejects a non-finite value in each of the three series, naming the currency and series', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    const cases: ReadonlyArray<[string, CurrencyMacroPoint]> = [
      [
        'USD policy rate is not a finite number',
        { ...first, policyRate: { ...first.policyRate, value: Number.NaN } },
      ],
      [
        'USD CPI is not a finite number',
        { ...first, cpiYoY: { ...first.cpiYoY, value: Number.POSITIVE_INFINITY } },
      ],
      [
        'USD price change is not a finite number',
        { ...first, priceChange1m: { ...first.priceChange1m, value: Number.NEGATIVE_INFINITY } },
      ],
    ];
    for (const [message, point] of cases)
      assert.deepEqual(validateBubblePoints([point]), [message]);
  });

  it('allows zero and negative values: a policy rate can be negative, a change can be nil', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    const point: CurrencyMacroPoint = {
      ...first,
      policyRate: { ...first.policyRate, value: -0.1 },
      cpiYoY: { ...first.cpiYoY, value: 0 },
      priceChange1m: { ...first.priceChange1m, value: 0 },
    };
    assert.deepEqual(validateBubblePoints([point]), []);
  });

  it('rejects a value with no observation time', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    const point: CurrencyMacroPoint = { ...first, cpiYoY: { ...first.cpiYoY, asOf: Number.NaN } };
    assert.deepEqual(validateBubblePoints([point]), ['USD CPI has no observation time']);
  });

  it('rejects a value whose source has no name, including a blank one', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    for (const name of ['', '   ', '\t\n']) {
      const point: CurrencyMacroPoint = {
        ...first,
        policyRate: { ...first.policyRate, source: { ...first.policyRate.source, name } },
      };
      assert.deepEqual(validateBubblePoints([point]), ['USD policy rate does not name its source']);
    }
  });

  it('rejects a price change that does not say what it is measured against', () => {
    const [first] = fixtureBubblePoints();
    assert.ok(first !== undefined);
    for (const basis of ['', '  ']) {
      const point: CurrencyMacroPoint = {
        ...first,
        priceChange1m: { ...first.priceChange1m, basis },
      };
      assert.deepEqual(validateBubblePoints([point]), [
        'USD price change does not state its basis',
      ]);
    }
  });

  it('reports every problem of every point, so a provider can see all of what is wrong', () => {
    const [usd, eur] = fixtureBubblePoints();
    assert.ok(usd !== undefined && eur !== undefined);
    const badUsd: CurrencyMacroPoint = {
      ...usd,
      policyRate: { ...usd.policyRate, value: Number.NaN },
    };
    const badEur: CurrencyMacroPoint = { ...eur, cpiYoY: { ...eur.cpiYoY, asOf: Number.NaN } };
    assert.deepEqual(validateBubblePoints([badUsd, badEur]), [
      'USD policy rate is not a finite number',
      'EUR CPI has no observation time',
    ]);
  });

  it('only inspects: it never writes to the points it is given', () => {
    assert.deepEqual(validateBubblePoints(deepFreeze(fixtureBubblePoints())), []);
  });
});

describe('bubbleDirection', () => {
  it('is up, down or flat by the sign of the change', () => {
    assert.equal(bubbleDirection(0.01), 'up');
    assert.equal(bubbleDirection(-0.01), 'down');
    assert.equal(bubbleDirection(0), 'flat');
    assert.equal(bubbleDirection(-0), 'flat');
  });

  it('does not round a small move to flat', () => {
    assert.equal(bubbleDirection(1e-9), 'up');
    assert.equal(bubbleDirection(-1e-9), 'down');
  });
});

describe('screenCalendar', () => {
  const OFF = { engineConfigured: false } as const;
  const ON = { engineConfigured: true } as const;

  /** One valid event to break one rule at a time. */
  function valid(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const [first] = fixtureCalendar();
    assert.ok(first !== undefined);
    return { ...first, ...overrides };
  }

  it('keeps attributed events and says why it dropped the rest', () => {
    const screened = screenCalendar(fixtureCalendar(), OFF);
    assert.deepEqual(
      screened.items.map((event) => event.id),
      ['ev-1', 'ev-2', 'ev-3', 'ev-4'],
    );
    assert.deepEqual(screened.rejected, [{ id: 'ev-bad', reason: 'does not name its source' }]);
  });

  it('removes an ELVOID interpretation when no engine is connected, and counts it', () => {
    const screened = screenCalendar(fixtureCalendar(), OFF);
    assert.equal(screened.interpretationsRemoved, 1);
    assert.ok(screened.items.every((event) => event.elvoidInterpretation === null));
  });

  it('keeps an interpretation when an engine is configured', () => {
    const screened = screenCalendar(fixtureCalendar(), ON);
    assert.equal(screened.interpretationsRemoved, 0);
    assert.equal(
      screened.items.find((event) => event.id === 'ev-4')?.elvoidInterpretation,
      'Interpretation text supplied for the test.',
    );
  });

  it('does not count an interpretation on an event that was rejected anyway', () => {
    const screened = screenCalendar(
      [
        valid({
          id: 'x',
          source: { name: '', url: null, retrievedAt: 1 },
          elvoidInterpretation: 'text',
        }),
      ],
      OFF,
    );
    assert.equal(screened.items.length, 0);
    assert.equal(screened.interpretationsRemoved, 0);
  });

  it('rejects an event without a usable time', () => {
    for (const timeMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(screenCalendar([valid({ timeMs })], OFF).rejected, [
        { id: valid().id, reason: 'has no valid time' },
      ]);
    }
  });

  it('rejects an event whose currency is not an upper-case ISO 4217 code', () => {
    for (const currency of ['', 'usd', 'US', 'USDD', 'U$D']) {
      assert.equal(
        screenCalendar([valid({ currency })], OFF).rejected[0]?.reason,
        'has no ISO 4217 currency',
        currency,
      );
    }
  });

  it('rejects an event without a title', () => {
    for (const title of ['', '   ']) {
      assert.equal(screenCalendar([valid({ title })], OFF).rejected[0]?.reason, 'has no title');
    }
  });

  it('rejects an event whose source has no name or no retrieval time', () => {
    assert.equal(
      screenCalendar([valid({ source: { name: ' ', url: null, retrievedAt: 1 } })], OFF).rejected[0]
        ?.reason,
      'does not name its source',
    );
    assert.equal(
      screenCalendar([valid({ source: { name: 'Desk', url: null, retrievedAt: Number.NaN } })], OFF)
        .rejected[0]?.reason,
      'has no retrieval time',
    );
  });

  it('keeps an unrated event: impact is null and shown as unclassified, not guessed', () => {
    const screened = screenCalendar([valid({ impact: null })], OFF);
    assert.equal(screened.items.length, 1);
    assert.equal(screened.items[0]?.impact, null);
  });

  it('rejects an impact level that is not low, medium or high', () => {
    const impact = { level: 'extreme', classifiedBy: 'Desk' } as unknown as CalendarEvent['impact'];
    assert.equal(
      screenCalendar([valid({ impact })], OFF).rejected[0]?.reason,
      'has an unknown impact level',
    );
  });

  it('rejects an impact level that does not say who assigned it', () => {
    for (const classifiedBy of ['', '  ']) {
      assert.equal(
        screenCalendar([valid({ impact: { level: 'high', classifiedBy } })], OFF).rejected[0]
          ?.reason,
        'states an impact level without saying who assigned it',
      );
    }
  });

  it('rejects a missing id as "(no id)" and a repeated id as a repeat, keeping the first', () => {
    const screened = screenCalendar(
      [
        valid({ id: '' }),
        valid({ id: '  ' }),
        valid({ id: 'a' }),
        valid({ id: 'a', title: 'second' }),
      ],
      OFF,
    );
    assert.deepEqual(screened.rejected, [
      { id: '(no id)', reason: 'has no id' },
      { id: '  ', reason: 'has no id' },
      { id: 'a', reason: 'repeats an earlier id' },
    ]);
    assert.equal(screened.items.length, 1);
    assert.equal(screened.items[0]?.title, valid().title);
  });

  it('keeps the order the provider sent and keeps every field it does not change', () => {
    const input = [
      valid({ id: 'b', timeMs: 5 }),
      valid({ id: 'a', timeMs: 1 }),
      valid({ id: 'c', timeMs: 3 }),
    ];
    const screened = screenCalendar(input, OFF);
    assert.deepEqual(
      screened.items.map((event) => event.id),
      ['b', 'a', 'c'],
    );
    assert.deepEqual(screened.items, input);
  });

  it('never writes to its input', () => {
    const frozen = deepFreeze(fixtureCalendar());
    assert.equal(screenCalendar(frozen, OFF).items.length, 4);
  });

  it('returns nothing for nothing', () => {
    assert.deepEqual(screenCalendar([], OFF), {
      items: [],
      rejected: [],
      interpretationsRemoved: 0,
    });
  });
});

describe('screenNews', () => {
  const OFF = { engineConfigured: false } as const;
  const ON = { engineConfigured: true } as const;

  function valid(overrides: Partial<NewsItem> = {}): NewsItem {
    const [first] = fixtureNews();
    assert.ok(first !== undefined);
    return { ...first, ...overrides };
  }

  it('keeps well-formed items, including one that names no currency', () => {
    const screened = screenNews(fixtureNews(), OFF);
    assert.deepEqual(
      screened.items.map((item) => item.id),
      ['n-1', 'n-2', 'n-3', 'n-4'],
    );
    assert.deepEqual(screened.rejected, []);
  });

  it('rejects an item without a usable publication time or headline', () => {
    assert.equal(
      screenNews([valid({ publishedAt: Number.NaN })], OFF).rejected[0]?.reason,
      'has no valid publication time',
    );
    for (const headline of ['', '  ']) {
      assert.equal(screenNews([valid({ headline })], OFF).rejected[0]?.reason, 'has no headline');
    }
  });

  it('rejects an item that lists a malformed currency, even if another one is fine', () => {
    assert.equal(
      screenNews([valid({ currencies: ['USD', 'euro'] })], OFF).rejected[0]?.reason,
      'lists a malformed currency',
    );
  });

  it('rejects an item whose source is unnamed or has no retrieval time', () => {
    assert.equal(
      screenNews([valid({ source: { name: '', url: null, retrievedAt: 1 } })], OFF).rejected[0]
        ?.reason,
      'does not name its source',
    );
    assert.equal(
      screenNews([valid({ source: { name: 'Wire', url: null, retrievedAt: Number.NaN } })], OFF)
        .rejected[0]?.reason,
      'has no retrieval time',
    );
  });

  it('applies the same impact rules as the calendar', () => {
    assert.equal(screenNews([valid({ impact: null })], OFF).items.length, 1);
    assert.equal(
      screenNews([valid({ impact: { level: 'high', classifiedBy: ' ' } })], OFF).rejected[0]
        ?.reason,
      'states an impact level without saying who assigned it',
    );
    const unknown = { level: 'severe', classifiedBy: 'Desk' } as unknown as NewsItem['impact'];
    assert.equal(
      screenNews([valid({ impact: unknown })], OFF).rejected[0]?.reason,
      'has an unknown impact level',
    );
  });

  it('strips an interpretation that no engine produced, and keeps one when an engine is configured', () => {
    const input = [valid({ id: 'x', elvoidInterpretation: 'text' })];
    const off = screenNews(input, OFF);
    assert.equal(off.items[0]?.elvoidInterpretation, null);
    assert.equal(off.interpretationsRemoved, 1);
    const on = screenNews(input, ON);
    assert.equal(on.items[0]?.elvoidInterpretation, 'text');
    assert.equal(on.interpretationsRemoved, 0);
  });

  it('rejects a missing or repeated id', () => {
    const screened = screenNews([valid({ id: '' }), valid({ id: 'a' }), valid({ id: 'a' })], OFF);
    assert.deepEqual(screened.rejected, [
      { id: '(no id)', reason: 'has no id' },
      { id: 'a', reason: 'repeats an earlier id' },
    ]);
  });

  it('never writes to its input', () => {
    assert.equal(screenNews(deepFreeze(fixtureNews()), OFF).items.length, 4);
  });
});

describe('safeHttpUrl: a provider link is clickable only if it is a plain web address', () => {
  it('accepts http and https and returns the normalized address', () => {
    assert.equal(safeHttpUrl('https://example.com'), 'https://example.com/');
    assert.equal(safeHttpUrl('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c');
    assert.equal(safeHttpUrl('HTTPS://EXAMPLE.COM/Path'), 'https://example.com/Path');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(safeHttpUrl('  https://example.com/x \n'), 'https://example.com/x');
  });

  it('returns null for nothing', () => {
    for (const value of [null, undefined, '', '   ', '\n\t'])
      assert.equal(safeHttpUrl(value), null);
  });

  it('refuses every scheme that is not http or https', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'blob:https://example.com/1234',
      'mailto:someone@example.com',
      'tel:+123456789',
    ]) {
      assert.equal(safeHttpUrl(value), null, value);
    }
  });

  it('refuses anything that is not an absolute address', () => {
    for (const value of [
      '/relative/path',
      '//example.com/x',
      'example.com',
      'www.example.com/x',
      '#fragment',
      '?q=1',
    ]) {
      assert.equal(safeHttpUrl(value), null, value);
    }
  });

  it('refuses an address with credentials in it', () => {
    for (const value of [
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'http://:pass@example.com/',
    ]) {
      assert.equal(safeHttpUrl(value), null, value);
    }
  });
});
