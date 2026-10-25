import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, envBlock, text } from './support/page-helpers.js';

/**
 * The macro bubble chart with a macro-series provider connected. Production Phase 1 has none
 * (its Bubbles tab says ENV NOT CONNECTION, which the real-server suite checks), so every figure
 * here is a TEST FIXTURE served only by the test-only component harness. The numbers are
 * fictional on purpose: USD 4.5 / 3.1 / 0, EUR 2.5 / 2.2 / +1.4, JPY -0.1 / 2.9 / -3.2,
 * GBP 4.75 / 3.4 / +0.6, AUD 4.1 / 3.6 / -0.9 (policy rate %, CPI %, one-month change %).
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const PANEL = '#bubbles-panel';
const HASH = '#/macro/bubbles';

async function withBubbles(
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

interface BubbleReading {
  readonly currency: string;
  readonly direction: string;
  readonly label: string;
  readonly pressed: string | null;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

const waitForChart = (page: Page): Promise<unknown> =>
  page.waitForSelector(`${PANEL} g.bubble`, { timeout: 10_000 });

async function bubbles(page: Page): Promise<Record<string, BubbleReading>> {
  const list = await page.$$eval(`${PANEL} g.bubble`, (groups) =>
    groups.map((group) => {
      const circle = group.querySelector('.bubble__dot');
      return {
        currency: group.getAttribute('data-currency') ?? '',
        direction: group.getAttribute('data-dir') ?? '',
        label: group.querySelector('text')?.textContent ?? '',
        pressed: group.getAttribute('aria-pressed'),
        cx: Number(circle?.getAttribute('cx')),
        cy: Number(circle?.getAttribute('cy')),
        r: Number(circle?.getAttribute('r')),
      };
    }),
  );
  return Object.fromEntries(list.map((entry) => [entry.currency, entry]));
}

const get = (all: Record<string, BubbleReading>, code: string): BubbleReading => {
  const found = all[code];
  assert.ok(found, `${code} is drawn`);
  return found;
};

const close = (actual: number, expected: number, tolerance: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
};

describe('macro bubbles: a validated series set from a connected provider', () => {
  it('draws one bubble per currency, each with a direction word, a glyph and a label', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const all = await bubbles(page);
      assert.deepEqual(Object.keys(all).sort(), ['AUD', 'EUR', 'GBP', 'JPY', 'USD']);
      assert.deepEqual(
        Object.fromEntries(
          Object.values(all).map((entry) => [entry.currency, [entry.direction, entry.label]]),
        ),
        {
          USD: ['flat', 'USD –'],
          EUR: ['up', 'EUR ▲'],
          JPY: ['down', 'JPY ▼'],
          GBP: ['up', 'GBP ▲'],
          AUD: ['down', 'AUD ▼'],
        },
      );
      assert.equal(await page.locator(`${PANEL} .macro__state`).isVisible(), false);
    });
  });

  it('puts the policy rate on the horizontal axis and inflation on the vertical, each on a linear scale', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const all = await bubbles(page);
      const rate: Record<string, number> = { JPY: -0.1, EUR: 2.5, AUD: 4.1, USD: 4.5, GBP: 4.75 };
      const cpi: Record<string, number> = { AUD: 3.6, GBP: 3.4, USD: 3.1, JPY: 2.9, EUR: 2.2 };
      const byX = Object.keys(rate).sort((a, b) => get(all, a).cx - get(all, b).cx);
      assert.deepEqual(
        byX,
        ['JPY', 'EUR', 'AUD', 'USD', 'GBP'],
        'left to right is lowest to highest policy rate',
      );
      const byY = Object.keys(cpi).sort((a, b) => get(all, a).cy - get(all, b).cy);
      assert.deepEqual(
        byY,
        ['AUD', 'GBP', 'USD', 'JPY', 'EUR'],
        'top to bottom is highest to lowest inflation',
      );
      // Pixels per percentage point must be the same between any two currencies.
      const pxPerPoint = (a: string, b: string): number =>
        (get(all, b).cx - get(all, a).cx) / ((rate[b] ?? 0) - (rate[a] ?? 0));
      close(pxPerPoint('JPY', 'EUR'), pxPerPoint('EUR', 'GBP'), 0.01, 'horizontal scale');
      close(
        pxPerPoint('JPY', 'GBP'),
        pxPerPoint('AUD', 'USD'),
        0.01,
        'horizontal scale across pairs',
      );
      const pyPerPoint = (a: string, b: string): number =>
        ((get(all, a).cy - get(all, b).cy) / ((cpi[b] ?? 0) - (cpi[a] ?? 0))) * -1;
      close(pyPerPoint('EUR', 'JPY'), pyPerPoint('JPY', 'AUD'), 0.01, 'vertical scale');
    });
  });

  it('sizes each bubble by the documented rule: radius = 5 + (largest − 5) × √(|change| ÷ largest |change|)', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const all = await bubbles(page);
      const largest = get(all, 'JPY').r; // |−3.2| is the largest change, so it takes the largest radius
      assert.ok(largest > 14 - 0.001 && largest <= 34 + 0.001, `the largest radius is ${largest}`);
      const expected = (change: number): number =>
        5 + (largest - 5) * Math.sqrt(Math.abs(change) / 3.2);
      close(get(all, 'EUR').r, expected(1.4), 0.01, 'EUR');
      close(get(all, 'GBP').r, expected(0.6), 0.01, 'GBP');
      close(get(all, 'AUD').r, expected(-0.9), 0.01, 'AUD');
      assert.equal(
        get(all, 'USD').r,
        5,
        'a currency with no change is drawn at the minimum so it stays visible',
      );
      // Area, not radius, carries the value: a bubble four times the change has twice the radius gain.
      const gain = (code: string): number => get(all, code).r - 5;
      close(
        gain('JPY') / gain('EUR'),
        Math.sqrt(3.2 / 1.4),
        0.001,
        'radius gain follows the square root',
      );
    });
  });

  it('gives every bubble a hit area of at least 24px, however small it is drawn', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const targets = await page.$$eval(`${PANEL} g.bubble`, (groups) =>
        groups.map((group) => ({
          currency: group.getAttribute('data-currency'),
          dot: Number(group.querySelector('.bubble__dot')?.getAttribute('r')),
          hit: Number(group.querySelector('.bubble__hit')?.getAttribute('r')),
        })),
      );
      assert.equal(targets.length, 5);
      for (const target of targets) {
        assert.ok(target.hit >= 12, `${target.currency} target radius ${target.hit}`);
        assert.ok(target.hit >= target.dot, `${target.currency} target covers its bubble`);
      }
      const usd = targets.find((target) => target.currency === 'USD');
      assert.equal(usd?.dot, 5);
      assert.equal(usd?.hit, 12, 'the smallest bubble still gets the full target');
      // A click just outside the drawn dot but inside the target still chooses it.
      const box = await page
        .locator(`${PANEL} g.bubble[data-currency="USD"] .bubble__dot`)
        .boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2 + 9, box.y + box.height / 2);
      await page.waitForSelector(`${PANEL} .bubbles__detail[data-currency="USD"]`);
    });
  });

  it('names its axes, its color-and-glyph key, and the largest mover in the legend', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const titles = await page.$$eval(`${PANEL} .bubbles__title`, (nodes) =>
        nodes.map((node) => node.textContent),
      );
      assert.deepEqual(titles, ['Policy rate (%)', 'CPI inflation, year on year (%)']);
      assert.equal(
        await text(page, `${PANEL} .bubbles__legend`),
        '▲ up ▼ down – flat Area grows with |one-month change|. Largest: JPY -3.20%.',
      );
      assert.equal(
        await page.locator(`${PANEL} svg.bubbles__svg`).getAttribute('aria-label'),
        'Macro bubble chart: policy rate against inflation, bubble size is the one-month price change',
      );
    });
  });

  it('describes each bubble in words for assistive technology', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      assert.equal(
        await page.locator(`${PANEL} g.bubble[data-currency="JPY"]`).getAttribute('aria-label'),
        'JPY: policy rate -0.10 percent, inflation 2.90 percent, one-month change down -3.20%',
      );
      assert.equal(
        await page.locator(`${PANEL} g.bubble[data-currency="EUR"]`).getAttribute('aria-label'),
        'EUR: policy rate 2.50 percent, inflation 2.20 percent, one-month change up +1.40%',
      );
    });
  });

  it('shows a hint until a bubble is chosen, then every value with its source and dates', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      assert.equal(
        await text(page, `${PANEL} .bubbles__side`),
        'Select a bubble to see its values, sources and dates.',
      );
      await page.locator(`${PANEL} g.bubble[data-currency="EUR"] .bubble__dot`).click();
      const detail = page.locator(`${PANEL} .bubbles__detail[data-currency="EUR"]`);
      await detail.waitFor();
      assert.equal(await detail.locator('.bubbles__detail-title').textContent(), 'EUR ▲');
      const body = (await detail.innerText()).replace(/\s+/g, ' ');
      assert.match(
        body,
        /Policy rate 2\.50% Fixture rates office · observed 2026-01-05 12:00 UTC · retrieved 2026-01-06 11:58 UTC/i,
      );
      assert.match(
        body,
        /CPI, year on year 2\.20% Fixture statistics office · observed 2026-01-05 12:00 UTC · retrieved 2026-01-06 11:58 UTC/i,
      );
      assert.match(
        body,
        /One-month change ▲ \+1\.40% \(up\) · vs USD, close to close Fixture price series · observed 2026-01-06 12:00 UTC · retrieved 2026-01-06 11:58 UTC/i,
      );
      assert.equal(
        await page.locator(`${PANEL} g.bubble[data-currency="EUR"]`).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(
        await page.locator(`${PANEL} g.bubble[data-currency="JPY"]`).getAttribute('aria-pressed'),
        'false',
      );
      // Sources are links that open elsewhere without handing over the opener.
      const links = await detail.locator('a').evaluateAll((nodes) =>
        nodes.map((node) => ({
          href: node.getAttribute('href'),
          target: node.getAttribute('target'),
          rel: node.getAttribute('rel'),
        })),
      );
      assert.equal(links.length, 3);
      for (const link of links) {
        assert.deepEqual(link, {
          href: 'https://example.invalid/source',
          target: '_blank',
          rel: 'noopener noreferrer',
        });
      }
      // Choosing it again clears the selection.
      await page.locator(`${PANEL} g.bubble[data-currency="EUR"] .bubble__dot`).click();
      await page.waitForSelector(`${PANEL} .bubbles__hint`);
      assert.equal(await page.locator(`${PANEL} .bubbles__detail`).count(), 0);
    });
  });

  it('shows a flat currency with a dash, "flat" and a signed zero-free change', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      await page.locator(`${PANEL} g.bubble[data-currency="USD"] .bubble__dot`).click();
      const body = (await page.locator(`${PANEL} .bubbles__detail`).innerText()).replace(
        /\s+/g,
        ' ',
      );
      assert.match(body, /USD –/);
      assert.match(body, /One-month change – 0\.00% \(flat\)/);
    });
  });

  it('can be operated from the keyboard: Tab to a bubble, Enter or Space to choose it', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const target = page.locator(`${PANEL} g.bubble[data-currency="JPY"]`);
      await target.focus();
      assert.equal(await target.getAttribute('role'), 'button');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${PANEL} .bubbles__detail[data-currency="JPY"]`);
      assert.match(await text(page, `${PANEL} .bubbles__detail`), /▼ -3\.20% \(down\)/);
      // Selecting redraws the chart; focus must not be lost to the page body.
      const other = page.locator(`${PANEL} g.bubble[data-currency="GBP"]`);
      await other.focus();
      await page.keyboard.press(' ');
      await page.waitForSelector(`${PANEL} .bubbles__detail[data-currency="GBP"]`);
      assert.equal(await page.locator(`${PANEL} g.bubble[aria-pressed="true"]`).count(), 1);
    });
  });

  it('lists every value, basis and source in a table sorted by currency', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      await page.locator(`${PANEL} details.disclosure summary`).click();
      await page.waitForSelector(`${PANEL} table.tbl tbody tr`);
      const header = await page.$$eval(`${PANEL} table.tbl thead th`, (cells) =>
        cells.map((cell) => cell.textContent),
      );
      assert.deepEqual(header, [
        'Currency',
        'Policy rate %',
        'CPI y/y %',
        '1-month change %',
        'Basis of change',
        'Sources',
      ]);
      const rows = await page.$$eval(`${PANEL} table.tbl tbody tr`, (trs) =>
        trs.map((tr) => Array.from(tr.children).map((cell) => cell.textContent)),
      );
      const sources = 'Fixture rates office, Fixture statistics office, Fixture price series';
      const basis = 'vs USD, close to close';
      assert.deepEqual(rows, [
        ['AUD', '4.10', '3.60', '-0.90%', basis, sources],
        ['EUR', '2.50', '2.20', '+1.40%', basis, sources],
        ['GBP', '4.75', '3.40', '+0.60%', basis, sources],
        ['JPY', '-0.10', '2.90', '-3.20%', basis, sources],
        ['USD', '4.50', '3.10', '0.00%', basis, sources],
      ]);
    });
  });

  it('explains the encoding beside the chart, including the size formula and that nothing is estimated', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const spec = await text(page, `${PANEL} .spec`);
      assert.match(
        spec,
        /Radius = minimum \+ \(maximum − minimum\) × √\(\|change\| ÷ largest \|change\|\)/,
      );
      assert.match(spec, /a currency missing any of the three is not drawn/);
      assert.match(spec, /color is never the only signal/);
      assert.match(spec, /Nothing is estimated or filled in/);
    });
  });

  it('draws a single currency without breaking its scales', async () => {
    await withBubbles({ bubbles: 'single' }, async ({ page }) => {
      await waitForChart(page);
      const all = await bubbles(page);
      assert.deepEqual(Object.keys(all), ['USD']);
      const usd = get(all, 'USD');
      assert.ok([usd.cx, usd.cy, usd.r].every(Number.isFinite), 'no coordinate is NaN or infinite');
      const markup = await page
        .locator(`${PANEL} svg.bubbles__svg`)
        .evaluate((node) => node.outerHTML);
      assert.doesNotMatch(markup, /NaN|Infinity/);
    });
  });
});

describe('macro bubbles: data that is rejected, failed or missing', () => {
  it('rejects series with an unattributed value, names the first problem, and draws nothing', async () => {
    await withBubbles({ bubbles: 'invalid' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.equal(
        await text(page, `${PANEL} .macro__state`),
        'SERIES REJECTED The provider returned series that failed validation: USD CPI does not name its source. Nothing is drawn.',
      );
      assert.equal(await page.locator(`${PANEL} g.bubble`).count(), 0);
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
    });
  });

  it('says MACRO SERIES FAILED when the provider is unreachable, and keeps offering Retry', async () => {
    await withBubbles({ bubbles: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.equal(
        await text(page, `${PANEL} .macro__state`),
        'MACRO SERIES FAILED The fixture series feed is unreachable. Retry',
      );
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.equal(await page.getByRole('button', { name: 'Retry' }).isVisible(), true);
      assert.equal(await page.locator(`${PANEL} g.bubble`).count(), 0);
    });
  });

  it('says ENV NOT CONNECTION, names what is missing and why, and still explains the encoding', async () => {
    await withBubbles({ bubbles: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .env-block`);
      assert.deepEqual(await envBlock(page, PANEL), {
        label: 'ENV NOT CONNECTION',
        detail: 'A macro-series provider is not connected.',
        note: 'No fixture series feed is connected.',
      });
      assert.equal(await page.locator(`${PANEL} svg`).count(), 0, 'no chart is drawn without data');
      assert.match(await text(page, `${PANEL} .spec`), /one bubble\s+One currency\./i);
    });
  });
});

describe('macro bubbles: layout', () => {
  for (const width of [1440, 1024, 390] as const) {
    it(`fits the page at ${width}px with every label inside the chart`, async () => {
      await withBubbles(
        { bubbles: 'available' },
        async ({ page }) => {
          await waitForChart(page);
          const measure = await page.evaluate(() => {
            const svg = document.querySelector('#bubbles-panel svg.bubbles__svg');
            if (svg === null) return null;
            const viewBox = svg.getAttribute('viewBox')?.split(' ').map(Number) ?? [];
            const box = svg.getBoundingClientRect();
            // Rendered boxes (rotation applied), measured against the chart's own box.
            const frame = svg.getBoundingClientRect();
            const outside = Array.from(svg.querySelectorAll('.bubble__label, .bubbles__title'))
              .map((label) => ({ text: label.textContent, box: label.getBoundingClientRect() }))
              .filter(
                ({ box: b }) =>
                  b.left < frame.left - 0.5 ||
                  b.top < frame.top - 0.5 ||
                  b.right > frame.right + 0.5 ||
                  b.bottom > frame.bottom + 0.5,
              )
              .map(({ text: content }) => content);
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              svgWidth: box.width,
              viewWidth: viewBox[2] ?? 0,
              outside,
            };
          });
          assert.ok(measure !== null);
          assert.ok(measure.overflow <= 0, `the page scrolls sideways by ${measure.overflow}px`);
          assert.ok(
            Math.abs(measure.svgWidth - measure.viewWidth) <= 1,
            `drawn at ${measure.viewWidth}px inside ${measure.svgWidth}px`,
          );
          assert.deepEqual(measure.outside, [], 'no label is cut off by the chart edge');
        },
        { width, height: 900 },
      );
    });
  }

  it('redraws at the new width when the window is resized', async () => {
    await withBubbles({ bubbles: 'available' }, async ({ page }) => {
      await waitForChart(page);
      const before = await page.locator(`${PANEL} svg.bubbles__svg`).getAttribute('viewBox');
      await page.setViewportSize({ width: 700, height: 900 });
      await page.waitForFunction(
        (previous) =>
          document.querySelector('#bubbles-panel svg.bubbles__svg')?.getAttribute('viewBox') !==
          previous,
        before,
        { timeout: 5_000 },
      );
      const bubblesAfter = await bubbles(page);
      assert.equal(Object.keys(bubblesAfter).length, 5);
    });
  });
});
