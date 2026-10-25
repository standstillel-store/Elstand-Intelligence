import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, envBlock, text } from './support/page-helpers.js';

/**
 * The economic calendar and the news list with a macro-data provider connected. Production
 * Phase 1 has none (both lists say ENV NOT CONNECTION, which the real-server suite checks), so
 * every item here is a TEST FIXTURE served only by the test-only component harness.
 *
 * The fixture clock is 2026-01-06 12:00 UTC. Calendar events: ev-1 USD at 14:00 (high), ev-2 EUR
 * the next day (medium), ev-3 JPY (unrated), ev-4 GBP (carries an ELVOID interpretation), and
 * ev-bad (no source, so it is rejected). News, newest first: n-1 USD, n-2 EUR (low), n-3 JPY with
 * a `javascript:` link, n-4 with no currency tag.
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const CALENDAR = '#calendar-panel';
const NEWS = '#news-panel';
const HASH = '#/macro/news-calendar';

async function withFeeds(
  spec: Omit<HarnessSpec, 'hash'> & { hash?: string },
  run: (watched: WatchedPage) => Promise<void>,
  options?: PageOptions,
): Promise<void> {
  const watched = await harness.open({ hash: HASH, ...spec }, options);
  try {
    await run(watched);
    assert.deepEqual(watched.problems, [], 'no console errors, CSP violations or failed requests');
    assert.deepEqual(await emptyAriaStates(watched.page), [], 'no ARIA state attribute is empty');
    assert.deepEqual(await auditBasics(watched.page), [], 'the page passes the structural audit');
  } finally {
    await watched.context.close();
  }
}

const both = { calendar: 'available', news: 'available' } as const;

/** With no item on screen there is nothing to re-zone or filter, so neither control is offered. */
async function assertControlsOff(page: Page): Promise<void> {
  assert.equal(
    await page.locator('#macro-zone').isDisabled(),
    true,
    'the time zone control is off',
  );
  assert.equal(
    await page.locator('#macro-currency').isDisabled(),
    true,
    'the currency control is off',
  );
  assert.deepEqual(
    await page.$$eval('#macro-currency option', (nodes) => nodes.map((node) => node.textContent)),
    ['All currencies'],
    'the currency list holds only what the lists contain: nothing',
  );
}
const ids = (
  page: Page,
  panel: string,
  attribute: 'data-event-id' | 'data-news-id',
): Promise<(string | null)[]> =>
  page.$$eval(
    `${panel} article[${attribute}]`,
    (nodes, name) => nodes.map((node) => node.getAttribute(name)),
    attribute,
  );
const item = (page: Page, panel: string, id: string): Promise<string> =>
  text(page, `${panel} article[data-event-id="${id}"], ${panel} article[data-news-id="${id}"]`);
const times = (page: Page, panel: string): Promise<(string | null)[]> =>
  page.$$eval(`${panel} time`, (nodes) => nodes.map((node) => node.textContent));

describe('calendar: events from a connected provider', () => {
  it('lists the events in time order, hides the unattributed one, and says why', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      assert.deepEqual(await ids(page, CALENDAR, 'data-event-id'), [
        'ev-1',
        'ev-2',
        'ev-3',
        'ev-4',
      ]);
      const notices = await page.$$eval(`${CALENDAR} .notice`, (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
      );
      assert.deepEqual(notices, [
        'ITEMS REJECTED 1 item was not shown because it was unattributed or malformed. First: ev-bad does not name its source.',
        'INTERPRETATION REMOVED 1 ELVOID interpretation was removed. No ELVOID engine is connected, and only an engine may supply one.',
      ]);
      assert.equal(await page.locator(`${CALENDAR} [data-event-id="ev-bad"]`).count(), 0);
      assert.equal(await text(page, `${CALENDAR} .panel__meta`), 'as of 2026-01-06 11:59 UTC');
    });
  });

  it('shows each event’s currency, country, source, retrieval time and the figures the source gave', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      assert.equal(
        await item(page, CALENDAR, 'ev-1'),
        '06 Jan 2026, 14:00 UTC USD · US HIGH rated by Fixture calendar rating Fixture inflation release Actual 2.3% Forecast 2.1% Previous 2.0% Source: Fixture calendar retrieved 2026-01-06 11:58 UTC',
      );
      // Only the figures that exist are shown: no placeholder, no zero.
      assert.equal(
        await item(page, CALENDAR, 'ev-2'),
        '07 Jan 2026, 14:00 UTC EUR MEDIUM rated by Fixture calendar rating Fixture policy statement Forecast 2.1% Previous 2.0% Source: Fixture calendar retrieved 2026-01-06 11:58 UTC',
      );
      assert.match(await item(page, CALENDAR, 'ev-3'), /No figures published yet/);
    });
  });

  it('marks an event the source did not rate UNCLASSIFIED, and invents no impact', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      const badge = page.locator(`${CALENDAR} [data-event-id="ev-3"] .impact`);
      assert.equal(await badge.textContent(), 'UNCLASSIFIED');
      assert.equal(await badge.getAttribute('data-level'), 'none');
      assert.equal(
        await badge.getAttribute('title'),
        'The source did not rate this item. Elstand assigns no impact of its own.',
      );
      assert.doesNotMatch(await item(page, CALENDAR, 'ev-3'), /rated by/);
      // A rated event names who rated it.
      const rated = page.locator(`${CALENDAR} [data-event-id="ev-1"] .impact`);
      assert.equal(await rated.getAttribute('title'), 'Rated high by Fixture calendar rating');
    });
  });

  it('keeps every time as a machine-readable UTC instant, whatever zone it is shown in', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      const readInstants = (): Promise<(string | null)[]> =>
        page.$$eval(`${CALENDAR} time`, (nodes) =>
          nodes.map((node) => node.getAttribute('datetime')),
        );
      const expected = [
        '2026-01-06T14:00:00.000Z',
        '2026-01-07T14:00:00.000Z',
        '2026-01-08T14:00:00.000Z',
        '2026-01-09T14:00:00.000Z',
      ];
      assert.deepEqual(await readInstants(), expected);
      await page.locator('#macro-zone').selectOption('Asia/Tokyo');
      await page.waitForFunction(
        () =>
          document.querySelector('#calendar-panel time')?.textContent?.includes('GMT+9') === true,
      );
      assert.deepEqual(
        await readInstants(),
        expected,
        'changing the zone changes the display, never the instant',
      );
    });
  });

  it('asks the provider for seven days starting at 00:00 UTC today, and says so', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      assert.deepEqual(await page.evaluate(() => [...(window.__harness?.calendarRanges ?? [])]), [
        { fromMs: Date.UTC(2026, 0, 6), toMs: Date.UTC(2026, 0, 13) },
      ]);
      assert.match(
        await text(page, '.macro__body > .spec'),
        /Calendar window From the start of today \(UTC\) for 7 days: 2026-01-06 to 2026-01-13\./i,
      );
    });
  });
});

describe('news: items from a connected provider', () => {
  it('lists the newest first, each with its source, rating and every currency it names', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${NEWS} article[data-news-id]`);
      assert.deepEqual(await ids(page, NEWS, 'data-news-id'), ['n-1', 'n-2', 'n-3', 'n-4']);
      assert.equal(
        await item(page, NEWS, 'n-1'),
        '06 Jan 2026, 11:50 UTC USD UNCLASSIFIED Fixture headline about the dollar Source: Fixture wire retrieved 2026-01-06 11:58 UTC',
      );
      assert.equal(
        await item(page, NEWS, 'n-2'),
        '06 Jan 2026, 11:15 UTC EUR LOW rated by Fixture wire desk Fixture headline about the euro Source: Fixture wire retrieved 2026-01-06 11:58 UTC',
      );
      assert.match(await item(page, NEWS, 'n-4'), /No currency tagged/);
      assert.equal(await text(page, `${NEWS} .panel__meta`), 'as of 2026-01-06 11:59 UTC');
    });
  });

  it('links a headline and its source only when the address is a safe http(s) URL', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${NEWS} article[data-news-id]`);
      const safe = page.locator(`${NEWS} [data-news-id="n-1"] h4 a`);
      assert.equal(await safe.getAttribute('href'), 'https://example.invalid/story');
      assert.equal(await safe.getAttribute('target'), '_blank');
      assert.equal(await safe.getAttribute('rel'), 'noopener noreferrer');
      // A `javascript:` address is text, never a link, anywhere in the item.
      assert.equal(await page.locator(`${NEWS} [data-news-id="n-3"] h4 a`).count(), 0);
      assert.equal(
        await page.locator(`${NEWS} [data-news-id="n-3"] [href^="javascript"]`).count(),
        0,
      );
      assert.equal(
        await page
          .locator(`${NEWS} [href^="javascript"], ${CALENDAR} [href^="javascript"]`)
          .count(),
        0,
      );
      assert.match(await item(page, NEWS, 'n-3'), /Fixture headline with an unsafe link/);
      const sources = await page.$$eval(`${NEWS} a, ${CALENDAR} a`, (nodes) =>
        nodes.map((node) => `${node.getAttribute('target')}|${node.getAttribute('rel')}`),
      );
      assert.ok(sources.length > 0);
      assert.ok(
        sources.every((value) => value === '_blank|noopener noreferrer'),
        `links: ${sources.join(', ')}`,
      );
    });
  });
});

describe('calendar and news: viewing', () => {
  it('offers UTC and four market centers, and changes every time on both lists together', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      const options = await page.$$eval('#macro-zone option', (nodes) =>
        nodes.map((node) => `${node.getAttribute('value')}|${node.textContent}`),
      );
      assert.deepEqual(options, [
        'UTC|UTC',
        'America/New_York|New York',
        'Europe/London|London',
        'Asia/Tokyo|Tokyo',
        'Australia/Sydney|Sydney',
      ]);
      assert.equal(await page.locator('#macro-zone').inputValue(), 'UTC');
      const expectations: [string, string, string][] = [
        ['America/New_York', '06 Jan 2026, 09:00 GMT-5', '06 Jan 2026, 06:50 GMT-5'],
        ['Europe/London', '06 Jan 2026, 14:00 GMT', '06 Jan 2026, 11:50 GMT'],
        ['Asia/Tokyo', '06 Jan 2026, 23:00 GMT+9', '06 Jan 2026, 20:50 GMT+9'],
        ['Australia/Sydney', '07 Jan 2026, 01:00 GMT+11', '06 Jan 2026, 22:50 GMT+11'],
        ['UTC', '06 Jan 2026, 14:00 UTC', '06 Jan 2026, 11:50 UTC'],
      ];
      for (const [zone, firstEvent, firstNews] of expectations) {
        await page.locator('#macro-zone').selectOption(zone);
        await page.waitForFunction(
          (expected) => document.querySelector('#calendar-panel time')?.textContent === expected,
          firstEvent,
          { timeout: 5_000 },
        );
        assert.equal((await times(page, CALENDAR))[0], firstEvent, `${zone} calendar`);
        assert.equal((await times(page, NEWS))[0], firstNews, `${zone} news`);
      }
    });
  });

  it('turns the zone and currency controls on only while an item is on screen', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      assert.equal(await page.locator('#macro-zone').isDisabled(), false);
      assert.equal(await page.locator('#macro-currency').isDisabled(), false);
    });
    // One list is enough to give both controls something to act on.
    await withFeeds({ calendar: 'available', news: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      await page.waitForSelector(`${NEWS} .env-block`);
      assert.equal(await page.locator('#macro-zone').isDisabled(), false);
      assert.equal(await page.locator('#macro-currency').isDisabled(), false);
    });
    await withFeeds({ calendar: 'unavailable', news: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${NEWS} article[data-news-id]`);
      await page.waitForSelector(`${CALENDAR} .env-block`);
      assert.equal(await page.locator('#macro-zone').isDisabled(), false);
      assert.equal(await page.locator('#macro-currency').isDisabled(), false);
    });
  });

  it('adds the browser’s own zone when it is not one of those, and shows times in it', async () => {
    await withFeeds(
      both,
      async ({ page }) => {
        await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
        const options = await page.$$eval('#macro-zone option', (nodes) =>
          nodes.map((node) => `${node.getAttribute('value')}|${node.textContent}`),
        );
        assert.equal(options.at(-1), 'Asia/Jakarta|Your browser (Asia/Jakarta)');
        await page.locator('#macro-zone').selectOption('Asia/Jakarta');
        await page.waitForFunction(
          () =>
            document.querySelector('#calendar-panel time')?.textContent?.includes('GMT+7') === true,
        );
        assert.equal((await times(page, CALENDAR))[0], '06 Jan 2026, 21:00 GMT+7');
      },
      { timezoneId: 'Asia/Jakarta' },
    );
  });

  it('filters both lists by currency, built from what the lists actually contain', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      const options = await page.$$eval('#macro-currency option', (nodes) =>
        nodes.map((node) => node.getAttribute('value')),
      );
      assert.deepEqual(options, ['ALL', 'EUR', 'GBP', 'JPY', 'USD']);
      await page.locator('#macro-currency').selectOption('EUR');
      await page.waitForFunction(
        () => document.querySelectorAll('#calendar-panel article[data-event-id]').length === 1,
      );
      assert.deepEqual(await ids(page, CALENDAR, 'data-event-id'), ['ev-2']);
      assert.deepEqual(await ids(page, NEWS, 'data-news-id'), ['n-2']);
      await page.locator('#macro-currency').selectOption('USD');
      await page.waitForFunction(
        () =>
          document
            .querySelector('#calendar-panel article[data-event-id]')
            ?.getAttribute('data-event-id') === 'ev-1',
      );
      assert.deepEqual(await ids(page, CALENDAR, 'data-event-id'), ['ev-1']);
      assert.deepEqual(await ids(page, NEWS, 'data-news-id'), ['n-1']);
      await page.locator('#macro-currency').selectOption('ALL');
      await page.waitForFunction(
        () => document.querySelectorAll('#calendar-panel article[data-event-id]').length === 4,
      );
    });
  });

  it('says so plainly when a currency has events but no news', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      await page.locator('#macro-currency').selectOption('GBP');
      await page.waitForSelector(`${NEWS} .feed__empty`);
      assert.equal(await text(page, `${NEWS} .feed__empty`), 'No GBP news items.');
      assert.deepEqual(await ids(page, CALENDAR, 'data-event-id'), ['ev-4']);
    });
  });

  it('keeps the chosen zone and currency when the lists are filtered and cleared', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      await page.locator('#macro-zone').selectOption('Asia/Tokyo');
      await page.locator('#macro-currency').selectOption('JPY');
      await page.waitForFunction(
        () => document.querySelectorAll('#calendar-panel article[data-event-id]').length === 1,
      );
      assert.equal((await times(page, CALENDAR))[0], '08 Jan 2026, 23:00 GMT+9');
      assert.equal((await times(page, NEWS))[0], '06 Jan 2026, 19:30 GMT+9');
    });
  });
});

describe('calendar and news: ELVOID interpretation', () => {
  it('removes an interpretation the provider sent when no engine is connected', async () => {
    await withFeeds(both, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      assert.equal(await page.locator(`${CALENDAR} .feed__elvoid`).count(), 0);
      assert.doesNotMatch(await text(page, CALENDAR), /Interpretation text supplied for the test/);
      assert.match(
        await text(page, '.macro__body > .spec'),
        /Without an engine none is shown, and any interpretation a provider sends is removed\./,
      );
    });
  });

  it('shows the interpretation under the item, labelled, when an engine is connected', async () => {
    await withFeeds({ ...both, engine: 'validated' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} [data-event-id="ev-4"] .feed__elvoid`);
      const interpretation = page.locator(`${CALENDAR} [data-event-id="ev-4"] .feed__elvoid`);
      assert.equal(
        ((await interpretation.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
        'ELVOID interpretation Interpretation text supplied for the test.',
      );
      assert.equal(
        await page.locator(`${CALENDAR} .notice`).count(),
        1,
        'only the rejected-item notice remains',
      );
      assert.doesNotMatch(await text(page, CALENDAR), /INTERPRETATION REMOVED/);
    });
  });
});

describe('calendar and news: no data', () => {
  it('says the source returned nothing, in the same words for each list', async () => {
    await withFeeds({ calendar: 'empty', news: 'empty' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} .feed__empty`);
      assert.equal(
        await text(page, `${CALENDAR} .feed__empty`),
        'The source returned no events for the next 7 days.',
      );
      assert.equal(await text(page, `${NEWS} .feed__empty`), 'The source returned no news items.');
      assert.equal(await page.locator('article').count(), 0);
      await assertControlsOff(page);
    });
  });

  it('says CALENDAR FAILED and NEWS FAILED with the provider’s message, and each Retry reloads only its own list', async () => {
    await withFeeds({ calendar: 'error', news: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} .notice[data-tone="down"]`);
      await page.waitForSelector(`${NEWS} .notice[data-tone="down"]`);
      assert.match(await text(page, CALENDAR), /CALENDAR FAILED The fixture feed is unreachable\./);
      assert.match(await text(page, NEWS), /NEWS FAILED The fixture feed is unreachable\./);
      await page.locator(`${CALENDAR}`).getByRole('button', { name: 'Retry' }).click();
      await page.waitForFunction(
        () => (window.__harness?.calendarRanges.length ?? 0) === 2,
        undefined,
        { timeout: 5_000 },
      );
      await page.waitForSelector(`${CALENDAR} .notice[data-tone="down"]`);
      assert.equal(
        await page.locator(NEWS).getByRole('button', { name: 'Retry' }).isVisible(),
        true,
      );
    });
  });

  it('shows one list while the other fails, so a failure never hides data that did arrive', async () => {
    await withFeeds({ calendar: 'available', news: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
      await page.waitForSelector(`${NEWS} .notice[data-tone="down"]`);
      assert.deepEqual(await ids(page, CALENDAR, 'data-event-id'), [
        'ev-1',
        'ev-2',
        'ev-3',
        'ev-4',
      ]);
      assert.match(await text(page, NEWS), /NEWS FAILED/);
    });
  });

  it('says ENV NOT CONNECTION in each list, names what is missing and why, and shows no item', async () => {
    await withFeeds({ calendar: 'unavailable', news: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} .env-block`);
      await page.waitForSelector(`${NEWS} .env-block`);
      assert.deepEqual(await envBlock(page, CALENDAR), {
        label: 'ENV NOT CONNECTION',
        detail: 'A calendar provider is not connected.',
        note: 'No fixture feed is connected.',
      });
      assert.deepEqual(await envBlock(page, NEWS), {
        label: 'ENV NOT CONNECTION',
        detail: 'A news provider is not connected.',
        note: 'No fixture feed is connected.',
      });
      assert.equal(await page.locator('article').count(), 0);
      assert.equal(
        await page
          .locator('#calendar-panel .panel__meta, #news-panel .panel__meta')
          .first()
          .textContent(),
        '',
      );
      await assertControlsOff(page);
    });
  });

  it('keeps the notes on time zone, impact and interpretation visible whether or not data arrived', async () => {
    await withFeeds({ calendar: 'unavailable', news: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${CALENDAR} .env-block`);
      const notes = await text(page, '.macro__body > .spec');
      assert.match(notes, /Each source schedules in UTC and Elstand stores it that way/);
      assert.match(
        notes,
        /Elstand assigns no impact of its own\. An item the source did not rate shows UNCLASSIFIED\./,
      );
    });
  });
});

describe('calendar and news: layout', () => {
  for (const width of [1440, 1024, 390] as const) {
    it(`fits the page at ${width}px without sideways scrolling`, async () => {
      await withFeeds(
        both,
        async ({ page }) => {
          await page.waitForSelector(`${CALENDAR} article[data-event-id]`);
          const measure = await page.evaluate(() => {
            const calendar = document.getElementById('calendar-panel')?.getBoundingClientRect();
            const news = document.getElementById('news-panel')?.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              calendar:
                calendar === undefined
                  ? null
                  : {
                      left: calendar.left,
                      top: calendar.top,
                      right: calendar.right,
                      bottom: calendar.bottom,
                    },
              news:
                news === undefined
                  ? null
                  : { left: news.left, top: news.top, right: news.right, bottom: news.bottom },
              clipped: Array.from(document.querySelectorAll<HTMLElement>('.feed__item')).filter(
                (node) => node.scrollWidth > node.clientWidth + 1,
              ).length,
            };
          });
          assert.ok(measure.overflow <= 0, `the page scrolls sideways by ${measure.overflow}px`);
          assert.equal(measure.clipped, 0, 'no item is wider than its list');
          assert.ok(measure.calendar !== null && measure.news !== null);
          if (width >= 1100) {
            assert.ok(
              measure.news.left >= measure.calendar.right - 1,
              'the lists sit side by side on a wide screen',
            );
            assert.ok(Math.abs(measure.news.top - measure.calendar.top) < 2);
          } else {
            assert.ok(
              measure.news.top >= measure.calendar.bottom - 1,
              'the lists stack on a narrow screen',
            );
          }
        },
        { width, height: 900 },
      );
    });
  }
});
