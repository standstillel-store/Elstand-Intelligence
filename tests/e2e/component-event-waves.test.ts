import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, text } from './support/page-helpers.js';

/**
 * Surface VI: the event-proximity waves under the volatility surface. They are drawn from the
 * economic calendar and nothing else, so these tests give the page a calendar and look at what it
 * draws, says and refuses to draw. Every event is a TEST FIXTURE served only by the test-only
 * component harness; none of it is market data.
 *
 * The fixture clock is 2026-01-06 12:00 UTC. ev-1 USD +2 h (rated high, with actual, forecast and
 * previous), ev-2 EUR +26 h (medium), ev-3 JPY +50 h (not rated, no figures), ev-4 GBP +74 h
 * (rated high), ev-bad (no source, so it is rejected).
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const PANEL = '#event-waves-panel';
const HASH = '#/macro/vol-surface';

async function withWaves(
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

const ids = (page: Page): Promise<(string | null)[]> =>
  page.$$eval(`${PANEL} details[data-event-id]`, (nodes) =>
    nodes.map((node) => node.getAttribute('data-event-id')),
  );
const row = (id: string): string => `${PANEL} details[data-event-id="${id}"]`;
const wavePathOf = (page: Page, id: string): Promise<string> =>
  page
    .locator(`${row(id)} path.wave__line`)
    .getAttribute('d')
    .then((d) => d ?? '');
const flat = (d: string): boolean => /^(?:[ML][\d.]+,12\.00 ?)+$/.test(d);

describe('Surface VI: waves from a connected calendar', () => {
  it('draws one wave per event the source rated high, and none for the others', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      assert.deepEqual(await ids(page), ['ev-1', 'ev-4']);
      for (const id of ['ev-1', 'ev-4']) {
        assert.equal(await page.locator(`${row(id)} svg.wave__svg`).count(), 1);
        assert.equal(
          await page.locator(`${row(id)} svg.wave__svg`).getAttribute('aria-hidden'),
          'true',
        );
      }
    });
  });

  it('draws a wave for an event close in time and a flat line for one far away', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      assert.equal(flat(await wavePathOf(page, 'ev-1')), false, 'two hours away: a wave');
      assert.equal(flat(await wavePathOf(page, 'ev-4')), true, 'three days away: a flat line');
    });
  });

  it('counts down to the stated time, with the time and zone shown', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      const summary = await text(page, `${row('ev-1')} summary`);
      assert.match(summary, /Fixture inflation release/);
      assert.match(summary, /USD · US/);
      assert.match(summary, /06 Jan 2026, 14:00 UTC/);
      assert.match(summary, /in 2h 00m/);
      assert.match(summary, /HIGH/);
    });
  });

  it('moves the countdown and the wave as the clock advances, with no new request', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      const before = await wavePathOf(page, 'ev-1');
      await page.evaluate(() => window.__harness?.advance(90 * 60_000));
      await page.waitForFunction(
        () =>
          /in (?:29|30)m/.test(
            document.querySelector('#event-waves-panel details[data-event-id="ev-1"] summary')
              ?.textContent ?? '',
          ),
        undefined,
        { timeout: 5_000 },
      );
      assert.notEqual(await wavePathOf(page, 'ev-1'), before, 'the wave follows the clock');
      assert.equal(
        await page.evaluate(() => window.__harness?.calendarRanges.length),
        1,
        'the calendar was asked for once',
      );
    });
  });

  it('shows what a wave is and is not, and what the countdown runs on', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      const help = await text(page, PANEL);
      assert.match(help, /how close a scheduled event is/);
      assert.match(help, /not measured or implied volatility and not a forecast/);
      assert.match(help, /Countdowns use this device’s clock/);
    });
  });

  it('rejects the unattributed event and says why, as the lists do', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      const notices = await page.$$eval(`${PANEL} .notice`, (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
      );
      assert.ok(
        notices.includes(
          'ITEMS REJECTED 1 item was not shown because it was unattributed or malformed. First: ev-bad does not name its source.',
        ),
        `notices: ${notices.join(' | ')}`,
      );
      assert.equal(await page.locator(`${PANEL} [data-event-id="ev-bad"]`).count(), 0);
    });
  });

  it('offers every event with a stated time on request, and rates none of its own', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      await page.locator('#waves-all').check();
      assert.deepEqual(await ids(page), ['ev-1', 'ev-2', 'ev-3', 'ev-4']);
      assert.match(await text(page, `${row('ev-3')} summary`), /NOT RATED/);
      assert.match(await text(page, `${row('ev-2')} summary`), /MEDIUM/);
      await page.locator('#waves-all').uncheck();
      assert.deepEqual(await ids(page), ['ev-1', 'ev-4']);
    });
  });

  it('opens an event to the figures the source gave, and only those', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      await page.locator('#waves-all').check();
      await page.locator(`${row('ev-1')} summary`).click();
      const given = await text(page, `${row('ev-1')} dl`);
      assert.match(given, /Scheduled\s*06 Jan 2026, 14:00 UTC/);
      assert.match(given, /Impact\s*HIGH · rated by Fixture calendar rating/);
      assert.match(given, /Actual\s*2\.3%/);
      assert.match(given, /Forecast\s*2\.1%/);
      assert.match(given, /Previous\s*2\.0%/);
      assert.match(given, /Source\s*Fixture calendar/);
      assert.match(given, /Retrieved\s*2026-01-06 11:58 UTC/);
      assert.doesNotMatch(
        given,
        /Surprise/,
        'no surprise is shown without two figures to compute it',
      );

      await page.locator(`${row('ev-3')} summary`).click();
      const sparse = await text(page, `${row('ev-3')} dl`);
      assert.match(sparse, /Impact\s*NOT RATED by the source/);
      assert.doesNotMatch(
        sparse,
        /Actual|Forecast|Previous/,
        'a figure the source did not give is not shown',
      );
    });
  });

  it('states where the data came from and when it was retrieved', async () => {
    await withWaves({ calendar: 'available' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      assert.match(await text(page, `${PANEL} .panel__meta`), /retrieved 2026-01-06 11:59 UTC/);
    });
  });
});

describe('Surface VI: with no calendar', () => {
  it('says, in the owner’s exact words, that the provider is unavailable and the waves are disabled', async () => {
    await withWaves({ calendar: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .env-block`);
      assert.equal(await text(page, `${PANEL} .env-block__label`), 'ENV NOT CONNECTION');
      assert.equal(
        await text(page, `${PANEL} .env-block__detail`),
        'ENV NOT CONNECTED — Economic calendar provider unavailable. Surface VI event waves are disabled.',
      );
      assert.equal(
        await page.locator(`${PANEL} details[data-event-id]`).count(),
        0,
        'nothing is drawn',
      );
      assert.equal(await page.locator(`${PANEL} svg`).count(), 0, 'not even an empty wave');
      assert.equal(await page.locator('#waves-all').isDisabled(), true);
    });
  });

  it('says it failed, keeps the waves off, and offers a retry', async () => {
    await withWaves({ calendar: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .macro__failed`);
      const failed = await text(page, `${PANEL} .macro__failed`);
      assert.match(failed, /CALENDAR FAILED/);
      assert.match(
        failed,
        /The fixture feed is unreachable\. Surface VI event waves are disabled\./,
      );
      assert.equal(await page.getByRole('button', { name: 'Retry' }).first().isVisible(), true);
      assert.equal(await page.locator(`${PANEL} details[data-event-id]`).count(), 0);
    });
  });

  it('says there is nothing to draw when the calendar holds nothing, and invents no event', async () => {
    await withWaves({ calendar: 'empty' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .feed__empty`);
      assert.equal(
        await text(page, `${PANEL} .feed__empty`),
        'No event in the calendar’s window is rated high by its source. Elstand assigns no rating of its own.',
      );
      assert.equal(await page.locator(`${PANEL} details[data-event-id]`).count(), 0);
    });
  });
});

describe('Surface VI: the page it lives on', () => {
  it('keeps the volatility surface as it was, and puts the waves beneath it', async () => {
    await withWaves({ calendar: 'available', surface: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} details[data-event-id]`);
      assert.equal(
        await page.locator('#vol-surface-panel').count(),
        1,
        'the surface panel is still there',
      );
      const surface = await page.locator('#vol-surface-panel').boundingBox();
      const waves = await page.locator(PANEL).boundingBox();
      assert.ok(surface !== null && waves !== null);
      assert.ok(waves.y > surface.y, 'the waves come after the surface');
    });
  });

  it('fits a phone: no sideways scroll', async () => {
    await withWaves(
      { calendar: 'available' },
      async ({ page }) => {
        await page.waitForSelector(`${PANEL} details[data-event-id]`);
        await page.locator('#waves-all').check();
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        assert.equal(widths.scroll, widths.client, 'the page does not scroll sideways');
      },
      { width: 390, height: 844 },
    );
  });
});
