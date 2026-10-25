import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, text } from './support/page-helpers.js';

/**
 * Market depth, in the states a production Phase 1 deployment never reaches (it has no depth
 * adapter, so its panel always says DEPTH UNAVAILABLE). The fixture book is TEST DATA, served
 * only by the test-only component harness, under the production Content-Security-Policy.
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const VENUE = 'Test venue (fixture, not a market)';
const PANEL = '#depth-panel';

async function withDepth(
  spec: Omit<HarnessSpec, 'hash'> & { hash?: string },
  run: (watched: WatchedPage) => Promise<void>,
  options?: PageOptions,
): Promise<void> {
  const watched = await harness.open({ hash: '#/forex/EURUSD/H1', ...spec }, options);
  try {
    await run(watched);
    assert.deepEqual(watched.problems, [], 'no console errors, CSP violations or failed requests');
    assert.deepEqual(await emptyAriaStates(watched.page), [], 'no ARIA state attribute is empty');
    assert.deepEqual(await auditBasics(watched.page), [], 'the page passes the structural audit');
  } finally {
    await watched.context.close();
  }
}

/** Visible text of every cell of every data row on one side of the book. */
async function sideRows(page: Page, side: 'bid' | 'ask'): Promise<string[][]> {
  return page.$$eval(
    `${PANEL} .depth__side[data-side="${side}"] .depth__row:not(.depth__row--head)`,
    (rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll('.depth__cell')).map((cell) =>
          (cell.textContent ?? '').trim(),
        ),
      ),
  );
}

async function barWidths(page: Page, side: 'bid' | 'ask'): Promise<number[]> {
  return page.$$eval(`${PANEL} .depth__side[data-side="${side}"] .depth__bar`, (bars) =>
    bars.map((bar) => Number.parseFloat((bar as HTMLElement).style.getPropertyValue('--depth'))),
  );
}

const waitForBook = (page: Page): Promise<unknown> =>
  page.waitForSelector(`${PANEL} .depth__book`, { timeout: 10_000 });

describe('depth panel: a book is present', () => {
  it('shows the venue, the observation time and the size unit beside the numbers', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      assert.equal(await page.locator(`${PANEL} .panel__title`).textContent(), 'Market depth');
      assert.equal(
        await text(page, `${PANEL} .panel__meta`).then((value) => value.startsWith(VENUE)),
        true,
      );
      const facts = await text(page, `${PANEL} .depth__facts`);
      assert.match(facts, new RegExp(`Venue ${VENUE.replace(/[()]/g, '\\$&')}`));
      assert.match(facts, /Observed 2026-01-06 11:59 UTC · 5s ago/);
      assert.match(facts, /Size unit lots/);
      const scope = await text(page, `${PANEL} .depth__scope`);
      assert.match(scope, /This book describes Test venue \(fixture, not a market\) only\./);
      assert.match(scope, /It is not a consolidated market book\./);
      assert.match(await text(page, `${PANEL} .depth__note`), /over[- ]the[- ]counter|OTC/i);
    });
  });

  it('draws bids and asks as two separate, ordered tables with exact figures', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      // Sizes go to one decimal because the book contains a 3.5 and a 1.5; nothing is rounded.
      assert.deepEqual(await sideRows(page, 'bid'), [
        ['1.08430', '2.0', '2.0'],
        ['1.08428', '5.0', '7.0'],
        ['1.08425', '3.5', '10.5'],
        ['1.08420', '8.0', '18.5'],
        ['1.08415', '4.0', '22.5'],
      ]);
      assert.deepEqual(await sideRows(page, 'ask'), [
        ['1.08432', '1.5', '1.5'],
        ['1.08435', '4.0', '5.5'],
        ['1.08440', '6.5', '12.0'],
        ['1.08445', '2.0', '14.0'],
        ['1.08450', '9.0', '23.0'],
      ]);
      assert.equal(await page.locator(`${PANEL} .depth__side`).count(), 2);
      assert.match(
        await text(page, `${PANEL} .depth__side[data-side="bid"] .depth__side-title`),
        /^bids best 1\.08430$/i,
      );
      assert.match(
        await text(page, `${PANEL} .depth__side[data-side="ask"] .depth__side-title`),
        /^asks best 1\.08432$/i,
      );
      assert.equal(
        await page
          .locator(`${PANEL} .depth__side[data-side="bid"] .depth__table`)
          .getAttribute('aria-label'),
        `Bids at ${VENUE}`,
      );
      assert.match(
        await text(page, `${PANEL} .depth__spread`),
        /^Spread 0\.00002 \(best ask minus best bid\)$/,
      );
    });
  });

  it('scales every bar to the larger side, so the two sides compare honestly', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      const bids = await barWidths(page, 'bid');
      const asks = await barWidths(page, 'ask');
      // Cumulative totals are 2, 7, 10.5, 18.5, 22.5 against 1.5, 5.5, 12, 14, 23. The largest is 23.
      const expectBars = (actual: number[], totals: number[]): void => {
        assert.equal(actual.length, totals.length);
        totals.forEach((total, index) => {
          const expected = Number(((total / 23) * 100).toFixed(1));
          assert.equal(actual[index], expected, `bar ${index} is ${expected}%`);
        });
      };
      expectBars(bids, [2, 7, 10.5, 18.5, 22.5]);
      expectBars(asks, [1.5, 5.5, 12, 14, 23]);
      assert.equal(Math.max(...bids, ...asks), 100);
    });
  });

  it('labels a fresh book LIVE and keeps the data state on the book itself', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      assert.equal(await text(page, `${PANEL} .panel__meta .badge`), 'LIVE');
      assert.equal(await page.locator(`${PANEL} .depth__book`).getAttribute('data-state'), 'live');
      assert.equal(
        await page.locator(`${PANEL} .notice`).count(),
        1,
        'only the hidden stale notice exists',
      );
      assert.equal(await page.locator(`${PANEL} .notice`).isVisible(), false);
    });
  });

  it('marks a book older than the freshness limit STALE and says not to treat it as current', async () => {
    await withDepth({ depth: 'stale' }, async ({ page }) => {
      await waitForBook(page);
      assert.equal(await text(page, `${PANEL} .panel__meta .badge`), 'STALE');
      assert.equal(await page.locator(`${PANEL} .depth__book`).getAttribute('data-state'), 'stale');
      const notice = page.locator(`${PANEL} .depth__book .notice`);
      assert.equal(await notice.isVisible(), true);
      assert.match(
        await notice.innerText(),
        /STALE\s+This book is older than the provider’s freshness limit\. Do not treat it as current\./,
      );
      assert.match(
        await text(page, `${PANEL} .depth__facts`),
        /Observed 2026-01-06 10:00 UTC · 2h 00m ago/,
      );
      // The figures stay readable: STALE is a label, not a removal.
      assert.equal((await sideRows(page, 'bid')).length, 5);
    });
  });

  it('turns STALE as the clock advances, without any new request', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      assert.equal(await text(page, `${PANEL} .panel__meta .badge`), 'LIVE');
      await page.evaluate(() => window.__harness?.advance(10 * 60_000));
      await page.waitForFunction(
        () => document.querySelector('#depth-panel .panel__meta .badge')?.textContent === 'STALE',
        undefined,
        { timeout: 5_000 },
      );
      assert.equal(await page.locator(`${PANEL} .depth__book`).getAttribute('data-state'), 'stale');
      assert.match(await text(page, `${PANEL} .depth__facts`), /· 10m 05s ago/);
      assert.equal(await page.locator(`${PANEL} .depth__book .notice`).isVisible(), true);
    });
  });

  it('cuts a deep book at ten levels per side and says how many were reported', async () => {
    await withDepth({ depth: 'deep' }, async ({ page }) => {
      await waitForBook(page);
      assert.equal((await sideRows(page, 'bid')).length, 10);
      assert.equal((await sideRows(page, 'ask')).length, 10);
      assert.match(
        await text(page, `${PANEL} .depth__legend`),
        /Showing the best 10 levels per side\. 14 bid and 14 ask levels were reported\./,
      );
      // The cumulative column still counts from the best level, so the cut hides nothing it claims.
      const bids = await sideRows(page, 'bid');
      assert.deepEqual(bids[9], ['1.08412', '10', '55']);
    });
  });

  it('does not claim a cut when nothing was cut', async () => {
    await withDepth({ depth: 'available' }, async ({ page }) => {
      await waitForBook(page);
      assert.doesNotMatch(await text(page, `${PANEL} .depth__legend`), /Showing the best/);
    });
  });

  it('shows no figure outside the book: a different instrument selected shows that instrument’s book', async () => {
    await withDepth({ depth: 'wrong-instrument' }, async ({ page }) => {
      // The provider answers every request with a GBP/USD book.
      await page.waitForSelector(`${PANEL} .notice`);
      assert.match(await text(page, `${PANEL} .depth__content`), /DEPTH UNAVAILABLE/);
      assert.match(
        await text(page, `${PANEL} .depth__content`),
        /Provider returned a book for GBPUSD, not EURUSD\./,
      );
      assert.equal(
        await page.locator(`${PANEL} .depth__book`).count(),
        0,
        'a foreign book is never drawn',
      );
      assert.equal(await page.locator(`${PANEL} .depth__row`).count(), 0);
      await page.locator('.wl__row[data-instrument="GBPUSD"]').click();
      await waitForBook(page);
      assert.equal(await page.locator(`${PANEL} .depth__book`).count(), 1);
      assert.equal((await sideRows(page, 'bid')).length, 5);
    });
  });
});

describe('depth panel: no usable book', () => {
  it('says DEPTH UNAVAILABLE with the provider’s reason, and draws no figures', async () => {
    await withDepth({ depth: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice`);
      const content = await text(page, `${PANEL} .depth__content`);
      assert.match(content, /DEPTH UNAVAILABLE The fixture has no order book\./);
      assert.match(content, /Elstand never estimates, interpolates or draws a book of its own\./);
      assert.equal(await page.locator(`${PANEL} .depth__row`).count(), 0);
      assert.equal(await page.locator(`${PANEL} .panel__meta .badge`).isVisible(), false);
      assert.equal(await page.locator(`${PANEL} .panel__meta .btn`).isVisible(), false);
      // The OTC explanation is still there, because it is why a single book is never "the market".
      assert.match(content, /over[- ]the[- ]counter|OTC/i);
    });
  });

  it('refuses a crossed book instead of repairing it', async () => {
    await withDepth({ depth: 'crossed' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice`);
      const content = await text(page, `${PANEL} .depth__content`);
      assert.match(content, /DEPTH UNAVAILABLE/);
      assert.match(content, /Provider returned an invalid order book: book is crossed/);
      assert.equal(await page.locator(`${PANEL} .depth__book`).count(), 0);
      assert.equal(await page.locator(`${PANEL} .depth__row`).count(), 0);
    });
  });

  it('reports a failed request, keeps no stale book, and recovers when Retry succeeds', async () => {
    await withDepth({ depth: 'fail-then-succeed' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice`);
      const content = await text(page, `${PANEL} .depth__content`);
      assert.match(content, /DEPTH FAILED/);
      assert.match(content, /The fixture venue refused the first request\./);
      assert.equal(await page.locator(`${PANEL} .depth__row`).count(), 0);
      await page.getByRole('button', { name: 'Retry' }).click();
      await waitForBook(page);
      assert.equal((await sideRows(page, 'ask')).length, 5);
      assert.equal(
        await page.locator(`${PANEL} .notice[data-tone="down"]`).count(),
        0,
        'the failure notice is gone',
      );
    });
  });

  it('keeps showing DEPTH FAILED when the venue keeps refusing', async () => {
    await withDepth({ depth: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice`);
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.match(
        await text(page, `${PANEL} .depth__content`),
        /DEPTH FAILED The fixture venue refused the request\./,
      );
      assert.equal(await page.locator(`${PANEL} .depth__book`).count(), 0);
    });
  });
});

describe('depth panel: layout', () => {
  const widths = [1920, 1600, 1440, 1024, 768, 390] as const;
  for (const width of widths) {
    it(`never truncates a figure and never overflows the page at ${width}px`, async () => {
      await withDepth(
        { depth: 'available' },
        async ({ page }) => {
          await waitForBook(page);
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            clipped: Array.from(document.querySelectorAll<HTMLElement>('#depth-panel .depth__cell'))
              .filter((cell) => cell.scrollWidth > cell.clientWidth)
              .map((cell) => cell.textContent),
          }));
          assert.ok(overflow.page <= 0, `the page scrolls sideways by ${overflow.page}px`);
          assert.deepEqual(overflow.clipped, [], 'no price or size is cut off with an ellipsis');
        },
        { width, height: 900 },
      );
    });
  }

  const sideBoxes = async (page: Page) => {
    const box = async (side: 'bid' | 'ask') => {
      const found = await page.locator(`${PANEL} .depth__side[data-side="${side}"]`).boundingBox();
      assert.ok(found, `${side} side has a box`);
      return found;
    };
    return { bid: await box('bid'), ask: await box('ask') };
  };

  it('puts bids left of asks, on one row, when the panel is wide (below the chart at 1440px)', async () => {
    await withDepth(
      { depth: 'available' },
      async ({ page }) => {
        await waitForBook(page);
        const { bid, ask } = await sideBoxes(page);
        assert.ok(ask.x >= bid.x + bid.width - 1, 'asks start where bids end');
        assert.ok(Math.abs(ask.y - bid.y) < 2, 'both sides begin on the same row');
      },
      { width: 1440, height: 900 },
    );
  });

  it('stacks bids above asks when the panel is narrow (the side column at 1600px, a phone at 390px)', async () => {
    for (const width of [1600, 390]) {
      await withDepth(
        { depth: 'available' },
        async ({ page }) => {
          await waitForBook(page);
          const { bid, ask } = await sideBoxes(page);
          assert.ok(ask.y >= bid.y + bid.height - 1, `at ${width}px the asks sit below the bids`);
          assert.ok(Math.abs(ask.x - bid.x) < 2, `at ${width}px they share the same left edge`);
        },
        { width, height: 900 },
      );
    }
  });
});
