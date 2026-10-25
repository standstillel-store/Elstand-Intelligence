import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import {
  launchBrowser,
  startApp,
  type BrowserSession,
  type PageOptions,
  type StartedApp,
  type WatchedPage,
} from './support/harness.js';
import { auditBasics, emptyAriaStates, envBlock, text } from './support/page-helpers.js';
import { SURFACE_CANVAS } from './support/surface-helpers.js';

/**
 * Elstand Intelligence on the real production bundle with NO server environment at all: no API
 * key, no vendor, nothing connected. This is the state a fresh deployment is in, so it is the
 * state the product must handle best. The rule being tested is the owner's: no simulated data,
 * and where there is no connection every data region says exactly ENV NOT CONNECTION.
 *
 * Nothing in this file is market data. Where a number appears it is a count of elements or a
 * clock fixed at 2026-01-06 12:00 UTC.
 */

/** The owner's words, written out here on purpose rather than imported from the product. */
const ENV_NOT_CONNECTION = 'ENV NOT CONNECTION';
const API_KEY_MISSING = 'Server environment variable TWELVE_DATA_API_KEY is not set.';
const NO_VALUE = '—';

let app: StartedApp;
let session: BrowserSession;
before(async () => {
  app = await startApp();
  session = await launchBrowser();
});
after(async () => {
  await session.close();
  await app.close();
});

const FOREX = '#/forex/EURUSD/H1';
const ROUTES = [
  {
    hash: FOREX,
    title: 'EUR/USD H1 · Forex Intelligence · Elstand Intelligence',
    h1: 'Forex Intelligence',
  },
  {
    hash: '#/macro/vol-surface',
    title: 'Volatility surface · Macro Intelligence · Elstand Intelligence',
    h1: 'Macro Intelligence',
  },
  {
    hash: '#/macro/bubbles',
    title: 'Macro bubbles · Macro Intelligence · Elstand Intelligence',
    h1: 'Macro Intelligence',
  },
  {
    hash: '#/macro/news-calendar',
    title: 'News & calendar · Macro Intelligence · Elstand Intelligence',
    h1: 'Macro Intelligence',
  },
] as const;

/** Every region that would show provider data, with what it must say instead. */
const ENV_REGIONS: readonly {
  readonly name: string;
  readonly hash: string;
  readonly scope: string;
  readonly detail: string;
  readonly note: RegExp | null;
}[] = [
  {
    name: 'chart',
    hash: FOREX,
    scope: '#chart-panel',
    detail: API_KEY_MISSING,
    note: /never draws sample or simulated candles/,
  },
  { name: 'watchlist', hash: FOREX, scope: '.wl', detail: API_KEY_MISSING, note: null },
  {
    name: 'market depth',
    hash: FOREX,
    scope: '#depth-panel',
    detail: API_KEY_MISSING,
    note: /named venue/,
  },
  {
    name: 'volatility surface',
    hash: '#/macro/vol-surface',
    scope: '#vol-surface-panel',
    detail: 'An options-data provider is not connected.',
    note: /No options-data adapter exists in this build/,
  },
  {
    name: 'macro bubbles',
    hash: '#/macro/bubbles',
    scope: '#bubbles-panel',
    detail: 'A macro-series provider is not connected.',
    note: /No macro-series adapter exists in this build/,
  },
  {
    name: 'economic calendar',
    hash: '#/macro/news-calendar',
    scope: '#calendar-panel',
    detail: 'A calendar provider is not connected.',
    note: /No macro-data adapter exists in this build/,
  },
  {
    name: 'news',
    hash: '#/macro/news-calendar',
    scope: '#news-panel',
    detail: 'A news provider is not connected.',
    note: /No macro-data adapter exists in this build/,
  },
];

// ---- helpers --------------------------------------------------------------------------------

interface RunOptions extends PageOptions {
  /** Skip the end-of-test audit, for tests that deliberately provoke a console error. */
  readonly audit?: boolean;
}

/**
 * Opens a route on the real server and waits until the server connection has been decided, so a
 * test never reads the transient CHECKING… state. Unless told otherwise, it ends every test with
 * the same checks: no console error, CSP violation or failed request; no empty ARIA state; and
 * the structural audit.
 */
async function withPage(
  hash: string,
  run: (watched: WatchedPage) => Promise<void>,
  options: RunOptions = {},
): Promise<void> {
  const { audit = true, ...pageOptions } = options;
  const watched = await session.newPage(pageOptions);
  try {
    await watched.page.goto(`${app.url}/${hash}`);
    await decided(watched.page);
    await run(watched);
    if (audit) {
      assert.deepEqual(
        watched.problems,
        [],
        'no console errors, CSP violations or failed requests',
      );
      assert.deepEqual(await emptyAriaStates(watched.page), [], 'no ARIA state attribute is empty');
      assert.deepEqual(await auditBasics(watched.page), [], 'the page passes the structural audit');
    }
  } finally {
    await watched.context.close();
  }
}

const SOURCE_VALUE = '.chip[aria-label="Data source status"] .chip__value';

/** The server has answered, whichever way: the SOURCE chip is no longer CHECKING…. */
async function decided(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => {
      const value = document.querySelector(selector)?.textContent ?? '';
      return value !== '' && value !== 'CHECKING…';
    },
    SOURCE_VALUE,
    { timeout: 10_000 },
  );
}

async function chipValue(page: Page, label: 'ELVOID' | 'INSTRUMENT' | 'SOURCE'): Promise<string> {
  const chip = page.locator('.chips .chip', {
    has: page.locator('.chip__label', { hasText: new RegExp(`^${label}$`) }),
  });
  return ((await chip.locator('.chip__value').first().textContent()) ?? '').trim();
}

const hashOf = (page: Page): Promise<string> => page.evaluate(() => window.location.hash);

const SYMBOL_OF: Readonly<Record<string, string>> = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
  NZDUSD: 'NZD/USD',
  XAUUSD: 'XAU/USD',
};
const MACRO_TITLE: Readonly<Record<string, string>> = {
  'vol-surface': 'Volatility surface',
  bubbles: 'Macro bubbles',
  'news-calendar': 'News & calendar',
};

/** The document title the application sets for a canonical address. Written out, not imported. */
function titleFor(hash: string): string {
  const [, page, first = '', second = ''] = hash.split('/');
  return page === 'forex'
    ? `${SYMBOL_OF[first] ?? first} ${second} · Forex Intelligence · Elstand Intelligence`
    : `${MACRO_TITLE[first] ?? first} · Macro Intelligence · Elstand Intelligence`;
}

/**
 * Waits until the address is `expected` AND the page has rendered it. Setting the hash is
 * instant, but the route change reaches the page a moment later, so waiting for the hash alone
 * would read the previous screen. The title is set from the route, so it is the proof.
 */
async function waitForHash(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ([hash, title]) => window.location.hash === hash && document.title === title,
    [expected, titleFor(expected)] as const,
    { timeout: 5_000 },
  );
}

/** Text as written in the DOM, not as CSS capitalizes it (panel titles are shown in capitals). */
async function written(page: Page, selector: string): Promise<string> {
  return ((await page.locator(selector).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

const statusRequests = (requested: readonly string[]): string[] =>
  requested.filter((url) => new URL(url).pathname === '/api/status');

const visibleText = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);

/**
 * Counts pixels on a canvas that are not the page background (#070907), reading a copy so the
 * real canvas is untouched. A canvas may be filled with the background; it may not hold ink.
 */
async function inkPixels(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const canvas = document.querySelector<HTMLCanvasElement>(query);
    if (canvas === null || canvas.width === 0 || canvas.height === 0) return 0;
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (context === null) return 0;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] ?? 0;
      const isBackground = data[i] === 7 && data[i + 1] === 9 && data[i + 2] === 7;
      if (alpha > 0 && !isBackground) ink += 1;
    }
    return ink;
  }, selector);
}

const visibleSymbols = (page: Page): Promise<string[]> =>
  page.locator('li:not([hidden]) > button.wl__row .wl__sym > span:first-child').allTextContents();

const activeInstrument = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-instrument') ?? null);

// ---- the application shell ------------------------------------------------------------------

describe('no env: application shell', () => {
  for (const route of ROUTES) {
    it(`${route.hash} has the right title, one h1 and the dark color scheme`, async () => {
      await withPage(route.hash, async ({ page }) => {
        assert.equal(await page.title(), route.title);
        assert.equal(await text(page, 'h1'), route.h1);
        assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
        const scheme = await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        );
        assert.equal(scheme, 'dark');
        const colors = await page.evaluate(() => ({
          page: getComputedStyle(document.body).backgroundColor,
          text: getComputedStyle(document.body).color,
        }));
        assert.equal(colors.page, 'rgb(7, 9, 7)', 'the page background is #070907');
        assert.equal(colors.text, 'rgb(232, 240, 233)', 'the text is #E8F0E9');
      });
    });
  }

  it('shows the wordmark and two working navigation links, with the current page marked', async () => {
    await withPage(FOREX, async ({ page }) => {
      assert.match(await text(page, '.brand'), /^ELSTAND ?INTELLIGENCE$/);
      const links = page.locator('nav[aria-label="Primary"] a.nav__link');
      assert.deepEqual(await links.allTextContents(), ['Forex Intelligence', 'Macro Intelligence']);
      assert.deepEqual(
        await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
        ['#/forex/EURUSD/H1', '#/macro/vol-surface'],
      );
      assert.deepEqual(
        await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-current'))),
        ['page', null],
      );

      await links.nth(1).click();
      await waitForHash(page, '#/macro/vol-surface');
      assert.equal(await text(page, 'h1'), 'Macro Intelligence');
      assert.deepEqual(
        await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-current'))),
        [null, 'page'],
      );
      assert.equal(await page.locator('#vol-surface-panel').isVisible(), true);
      assert.equal(
        await page.locator('#chart-panel').count(),
        0,
        'the Forex page is gone, not hidden',
      );

      await links.nth(0).click();
      await waitForHash(page, FOREX);
      assert.equal(await text(page, 'h1'), 'Forex Intelligence');
      assert.equal(await page.locator('#chart-panel').isVisible(), true);
    });
  });

  it('remembers the instrument across a visit to Macro and the macro tab across a visit to Forex', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('button.wl__row[data-instrument="USDJPY"]').click();
      await waitForHash(page, '#/forex/USDJPY/H1');
      await page.locator('nav[aria-label="Primary"] a', { hasText: 'Macro Intelligence' }).click();
      await waitForHash(page, '#/macro/vol-surface');
      await page.locator('nav.tabs a[data-tab="bubbles"]').click();
      await waitForHash(page, '#/macro/bubbles');
      assert.equal(
        await chipValue(page, 'INSTRUMENT'),
        'USD/JPY · H1',
        'the chip still names the chart',
      );

      await page.locator('nav[aria-label="Primary"] a', { hasText: 'Forex Intelligence' }).click();
      await waitForHash(page, '#/forex/USDJPY/H1');
      assert.equal(await text(page, '.chart__symbol'), 'USD/JPY');
      assert.equal(
        await page
          .locator('nav[aria-label="Primary"] a', { hasText: 'Macro Intelligence' })
          .getAttribute('href'),
        '#/macro/bubbles',
        'the Macro link returns to the tab that was open',
      );
    });
  });

  it('shows ELVOID, INSTRUMENT and SOURCE status chips with the true state of each', async () => {
    await withPage(FOREX, async ({ page }) => {
      assert.equal(await chipValue(page, 'ELVOID'), 'NOT CONFIGURED');
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'EUR/USD · H1');
      assert.equal(await chipValue(page, 'SOURCE'), ENV_NOT_CONNECTION);

      const source = page.locator('.chip[aria-label="Data source status"]');
      assert.equal(await source.getAttribute('role'), 'group');
      assert.equal(await source.locator('.chip__value').getAttribute('data-tone'), 'caution');
      assert.equal(
        await source.getAttribute('title'),
        API_KEY_MISSING,
        'the chip explains what is missing',
      );
      assert.equal(
        await source.locator('.badge').isVisible(),
        false,
        'no data-state badge without a source',
      );

      const elvoid = page.locator('button.chip[title="Go to the ELVOID reasoning workspace"]');
      assert.equal(await elvoid.locator('.chip__value').getAttribute('data-tone'), 'caution');
      const instrument = page.locator('a.chip[title="Open the selected instrument"]');
      assert.equal(await instrument.getAttribute('href'), '#/forex/EURUSD/H1');
      assert.equal(await instrument.getAttribute('aria-current'), 'page');
    });
  });

  it('shows the same SOURCE and ELVOID chips on every route', async () => {
    for (const route of ROUTES) {
      await withPage(route.hash, async ({ page }) => {
        assert.equal(await chipValue(page, 'SOURCE'), ENV_NOT_CONNECTION, route.hash);
        assert.equal(await chipValue(page, 'ELVOID'), 'NOT CONFIGURED', route.hash);
        assert.equal(await chipValue(page, 'INSTRUMENT'), 'EUR/USD · H1', route.hash);
      });
    }
  });

  it('the ELVOID chip leads to the ELVOID workspace and focuses it, from the Macro page too', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('button.chip[title="Go to the ELVOID reasoning workspace"]').click();
      await page.waitForFunction(() => document.activeElement?.id === 'elvoid-panel');
      assert.equal(await hashOf(page), FOREX);
    });
    await withPage('#/macro/bubbles', async ({ page }) => {
      await page.locator('button.chip[title="Go to the ELVOID reasoning workspace"]').click();
      await waitForHash(page, FOREX);
      await page.waitForFunction(() => document.activeElement?.id === 'elvoid-panel');
      assert.equal(await page.locator('#elvoid-panel').isVisible(), true);
    });
  });

  it('the INSTRUMENT chip leads back to the selected chart', async () => {
    await withPage('#/forex/GBPUSD/M30', async ({ page }) => {
      await page.locator('nav[aria-label="Primary"] a', { hasText: 'Macro Intelligence' }).click();
      await waitForHash(page, '#/macro/vol-surface');
      await page.locator('a.chip[title="Open the selected instrument"]').click();
      await waitForHash(page, '#/forex/GBPUSD/M30');
      assert.equal(await text(page, '.chart__symbol'), 'GBP/USD');
    });
  });

  it('is keyboard reachable: the skip link comes first and moves focus to the main region', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => ({
        cls: document.activeElement?.className,
        text: document.activeElement?.textContent,
      }));
      assert.equal(first.cls, 'skip-link');
      assert.equal(first.text, 'Skip to main content');
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      assert.equal(outline.style, 'solid', 'the focused skip link has a visible outline');
      assert.equal(outline.width, '2px');
      const top = await page.evaluate(
        () => (document.activeElement as HTMLElement).getBoundingClientRect().top,
      );
      assert.ok(top >= 0, 'the skip link is on screen once it has focus');

      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
      assert.equal(await hashOf(page), FOREX, 'the skip link does not disturb the route');

      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(
          () => document.querySelector('main')?.contains(document.activeElement) ?? false,
        ),
        true,
        'the next Tab lands inside the main region',
      );
    });
  });

  it('tabs through the header in reading order: skip link, two pages, ELVOID, instrument', async () => {
    await withPage(FOREX, async ({ page }) => {
      const order: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('Tab');
        order.push(
          await page.evaluate(() =>
            (document.activeElement?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          ),
        );
      }
      assert.deepEqual(order, [
        'Skip to main content',
        'Forex Intelligence',
        'Macro Intelligence',
        'ELVOIDNOT CONFIGURED',
        'INSTRUMENTEUR/USD · H1',
      ]);
    });
  });

  it('shows the fixed UTC clock and the plain-language disclaimer in the footer', async () => {
    await withPage(FOREX, async ({ page }) => {
      assert.equal(await text(page, '.footer__clock'), 'UTC 2026-01-06 12:00:00');
      const footer = await text(page, 'footer');
      assert.match(footer, /every timestamp is UTC unless it says otherwise/);
      assert.match(
        footer,
        /Not investment advice\. Elstand shows provider data as received and does not forecast prices\./,
      );
    });
  });
});

// ---- the owner's rule: ENV NOT CONNECTION, in exactly those words ----------------------------

describe('no env: every data region says ENV NOT CONNECTION', () => {
  for (const region of ENV_REGIONS) {
    it(`${region.name}: the label, what is missing and why`, async () => {
      await withPage(region.hash, async ({ page }) => {
        await page.waitForSelector(`${region.scope} .env-block__label`);
        const block = await envBlock(page, region.scope);
        assert.notEqual(block, null);
        assert.equal(block?.label, ENV_NOT_CONNECTION);
        assert.equal(block?.detail, region.detail);
        if (region.note === null) assert.equal(block?.note, null);
        else assert.match(block?.note ?? '', region.note);
        const shown = await text(page, `${region.scope} .env-block__label`);
        assert.equal(shown, ENV_NOT_CONNECTION, 'what the person reads is the exact phrase');
        assert.equal(
          await page.locator(`${region.scope} .env-block__label`).first().isVisible(),
          true,
        );
      });
    });
  }

  it('offers Check connection only where an environment variable is the missing piece', async () => {
    await withPage(FOREX, async ({ page }) => {
      for (const scope of ['#chart-panel', '.wl', '#depth-panel']) {
        const buttons = page.locator(`${scope} .env-block button`);
        assert.deepEqual(await buttons.allTextContents(), ['Check connection'], scope);
      }
    });
    for (const route of ROUTES.slice(1)) {
      await withPage(route.hash, async ({ page }) => {
        assert.equal(
          await page.locator('.env-block button').count(),
          0,
          `${route.hash}: no button for a provider that has no adapter in this build`,
        );
      });
    }
  });

  it('Check connection asks the server again, shows CHECKING… while it waits, then ENV NOT CONNECTION', async () => {
    await withPage(FOREX, async ({ page, requested }) => {
      assert.equal(statusRequests(requested).length, 1, 'one status request on load');

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/status', async (route) => {
        await gate;
        await route.continue();
      });
      await page.locator('#depth-panel button', { hasText: 'Check connection' }).click();

      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent === 'CHECKING…',
        SOURCE_VALUE,
      );
      assert.match(await text(page, '.wl__env'), /Checking the server connection…/);
      assert.match(
        await text(page, '#chart-panel .chart__overlay'),
        /Checking the server connection…/,
      );
      assert.equal(
        await page.locator('#depth-panel .env-block').count(),
        0,
        'no stale ENV block while checking',
      );
      assert.equal(await chipValue(page, 'SOURCE'), 'CHECKING…');

      release();
      await decided(page);
      assert.equal(await chipValue(page, 'SOURCE'), ENV_NOT_CONNECTION);
      assert.equal(statusRequests(requested).length, 2, 'exactly one more status request');
      for (const scope of ['#chart-panel', '.wl', '#depth-panel']) {
        await page.waitForSelector(`${scope} .env-block__label`);
        assert.equal((await envBlock(page, scope))?.label, ENV_NOT_CONNECTION, scope);
      }
      await page.unroute('**/api/status');
    });
  });

  it('draws and loads nothing on any route: no request except the page, its assets and /api/status', async () => {
    await withPage(FOREX, async ({ page, requested }) => {
      for (const route of ROUTES.slice(1)) {
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, route.hash);
        await waitForHash(page, route.hash);
        await page.waitForSelector('.env-block__label');
      }
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, '#/forex/XAUUSD/D1');
      await waitForHash(page, '#/forex/XAUUSD/D1');
      await page.waitForSelector('#chart-panel .env-block__label');

      assert.ok(
        requested.every((url) => url.startsWith(app.url)),
        'every request stayed on this origin',
      );
      const paths = requested.map((url) => new URL(url).pathname);
      const allowed = paths.filter(
        (path) => path === '/' || path.startsWith('/assets/') || path === '/api/status',
      );
      assert.deepEqual(
        paths,
        allowed,
        `unexpected requests: ${paths.filter((path) => !allowed.includes(path)).join(', ')}`,
      );
      assert.equal(
        statusRequests(requested).length,
        1,
        'the connection is checked once, not on every route',
      );
      assert.equal(
        paths.filter((path) => path.startsWith('/api/')).length,
        1,
        'no quote, candle or depth request',
      );
    });
  });
});

// ---- Forex Intelligence ---------------------------------------------------------------------

describe('no env: Forex Intelligence', () => {
  it('lists the eight instruments in order with no price, change or data state', async () => {
    await withPage(FOREX, async ({ page }) => {
      const rows = page.locator('button.wl__row');
      assert.equal(await rows.count(), 8);
      assert.deepEqual(
        await page.locator('button.wl__row .wl__sym > span:first-child').allTextContents(),
        ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'XAU/USD'],
      );
      assert.deepEqual(await page.locator('button.wl__row .wl__sub').allTextContents(), [
        'Euro vs US Dollar',
        'British Pound vs US Dollar',
        'US Dollar vs Japanese Yen',
        'Australian Dollar vs US Dollar',
        'US Dollar vs Canadian Dollar',
        'US Dollar vs Swiss Franc',
        'New Zealand Dollar vs US Dollar',
        'Gold vs US Dollar (spot)',
      ]);
      assert.deepEqual(
        new Set(await page.locator('.wl__price').allTextContents()),
        new Set([NO_VALUE]),
      );
      assert.deepEqual(
        new Set(await page.locator('.wl__chg').allTextContents()),
        new Set([NO_VALUE]),
      );
      assert.deepEqual(
        new Set(
          await page
            .locator('.wl__chg')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-dir'))),
        ),
        new Set(['none']),
      );
      assert.equal(
        await page.locator('.wl__row .badge:visible').count(),
        0,
        'no row claims LIVE, DLY or STALE',
      );
      assert.equal(await page.locator('.wl__price[data-state]').count(), 0);
    });
  });

  it('keeps the watchlist controls off, because there is nothing to refresh', async () => {
    await withPage(FOREX, async ({ page }) => {
      const auto = page.locator('.wl button', { hasText: /^Auto/ });
      assert.equal(await auto.textContent(), 'Auto off');
      assert.equal(await auto.isDisabled(), true);
      assert.equal(await auto.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.wl button', { hasText: 'Refresh' }).isDisabled(), true);
      assert.equal(
        await page.locator('#chart-panel button', { hasText: 'Refresh' }).isDisabled(),
        true,
      );
      for (const name of ['Zoom in', 'Zoom out', 'Reset']) {
        assert.equal(
          await page
            .locator('#chart-panel')
            .getByRole('button', { name, exact: true })
            .isDisabled(),
          true,
          name,
        );
      }
    });
  });

  it('filters the watchlist as you type, matching symbol, pair with slash, or name', async () => {
    await withPage(FOREX, async ({ page }) => {
      const search = page.getByLabel('Filter instruments');
      const empty = page.locator('.wl__empty');
      assert.equal(await empty.isVisible(), false);

      await search.fill('jpy');
      assert.deepEqual(await visibleSymbols(page), ['USD/JPY']);
      await search.fill('usd');
      assert.equal((await visibleSymbols(page)).length, 8, 'every instrument contains USD');
      await search.fill('gold');
      assert.deepEqual(await visibleSymbols(page), ['XAU/USD']);
      await search.fill('eur/usd');
      assert.deepEqual(await visibleSymbols(page), ['EUR/USD']);
      await search.fill('  gbp ');
      assert.deepEqual(await visibleSymbols(page), ['GBP/USD']);

      await search.fill('zzz');
      assert.deepEqual(await visibleSymbols(page), []);
      assert.equal(await empty.isVisible(), true);
      assert.equal(await empty.textContent(), 'No instrument matches “zzz”.');

      await search.press('Escape');
      assert.equal(await search.inputValue(), '');
      assert.equal((await visibleSymbols(page)).length, 8);
      assert.equal(await empty.isVisible(), false);
    });
  });

  it('selects by click: the URL, chips, chart header, ELVOID instrument and title all follow', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('button.wl__row[data-instrument="GBPUSD"]').click();
      await waitForHash(page, '#/forex/GBPUSD/H1');
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'GBP/USD · H1');
      assert.equal(await text(page, '.chart__symbol'), 'GBP/USD');
      assert.equal(await page.title(), 'GBP/USD H1 · Forex Intelligence · Elstand Intelligence');
      const current = await page
        .locator('button.wl__row')
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              `${node.getAttribute('data-instrument')}:${node.getAttribute('aria-current')}`,
          ),
        );
      assert.deepEqual(current, [
        'EURUSD:false',
        'GBPUSD:true',
        'USDJPY:false',
        'AUDUSD:false',
        'USDCAD:false',
        'USDCHF:false',
        'NZDUSD:false',
        'XAUUSD:false',
      ]);
      assert.equal(await text(page, '#elvoid-panel .elvoid__facts dd'), 'GBP/USD · H1');
      assert.equal(
        await chipValue(page, 'SOURCE'),
        ENV_NOT_CONNECTION,
        'selecting does not change the connection',
      );
      assert.equal((await envBlock(page, '#chart-panel'))?.label, ENV_NOT_CONNECTION);
    });
  });

  it('selects every instrument in turn, and each one gets its own symbol and ENV NOT CONNECTION', async () => {
    await withPage(FOREX, async ({ page }) => {
      const expected: [string, string][] = [
        ['EURUSD', 'EUR/USD'],
        ['GBPUSD', 'GBP/USD'],
        ['USDJPY', 'USD/JPY'],
        ['AUDUSD', 'AUD/USD'],
        ['USDCAD', 'USD/CAD'],
        ['USDCHF', 'USD/CHF'],
        ['NZDUSD', 'NZD/USD'],
        ['XAUUSD', 'XAU/USD'],
      ];
      for (const [id, symbol] of expected) {
        await page.locator(`button.wl__row[data-instrument="${id}"]`).click();
        await waitForHash(page, `#/forex/${id}/H1`);
        assert.equal(await text(page, '.chart__symbol'), symbol, id);
        assert.equal(await text(page, '.chart__price'), NO_VALUE, `${id} shows no price`);
        assert.equal((await envBlock(page, '#chart-panel'))?.label, ENV_NOT_CONNECTION, id);
      }
    });
  });

  it('moves through the list with the keyboard and selects with Enter', async () => {
    await withPage(FOREX, async ({ page }) => {
      const search = page.getByLabel('Filter instruments');
      await search.focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await activeInstrument(page), 'EURUSD');
      await page.keyboard.press('ArrowDown');
      assert.equal(await activeInstrument(page), 'GBPUSD');
      await page.keyboard.press('End');
      assert.equal(await activeInstrument(page), 'XAUUSD');
      await page.keyboard.press('Home');
      assert.equal(await activeInstrument(page), 'EURUSD');
      await page.keyboard.press('ArrowUp');
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Filter instruments',
      );

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      assert.equal(await activeInstrument(page), 'USDJPY');
      await page.keyboard.press('Enter');
      await waitForHash(page, '#/forex/USDJPY/H1');
      assert.equal(await text(page, '.chart__symbol'), 'USD/JPY');
    });
  });

  it('selects the first match when Enter is pressed in the filter', async () => {
    await withPage(FOREX, async ({ page }) => {
      const search = page.getByLabel('Filter instruments');
      await search.fill('chf');
      await search.press('Enter');
      await waitForHash(page, '#/forex/USDCHF/H1');
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'USD/CHF · H1');
    });
  });

  it('offers six timeframes, M5 to D1, and each one changes the selection even with no data', async () => {
    await withPage(FOREX, async ({ page }) => {
      const buttons = page.locator('#chart-panel .seg__btn');
      assert.deepEqual(await buttons.allTextContents(), ['M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
      for (const timeframe of ['M5', 'M15', 'M30', 'H4', 'D1', 'H1']) {
        await page
          .locator('#chart-panel .seg__btn', { hasText: new RegExp(`^${timeframe}$`) })
          .click();
        await waitForHash(page, `#/forex/EURUSD/${timeframe}`);
        assert.equal(await chipValue(page, 'INSTRUMENT'), `EUR/USD · ${timeframe}`);
        assert.equal(await text(page, '#chart-panel .seg__btn[aria-pressed="true"]'), timeframe);
        assert.equal(await page.locator('#chart-panel .seg__btn[aria-pressed="true"]').count(), 1);
        assert.equal(
          await page.title(),
          `EUR/USD ${timeframe} · Forex Intelligence · Elstand Intelligence`,
        );
        assert.equal(await text(page, '#elvoid-panel .elvoid__facts dd'), `EUR/USD · ${timeframe}`);
      }
    });
  });

  it('chart: no price, no candles, no data badge, and an empty crosshair readout', async () => {
    await withPage(FOREX, async ({ page }) => {
      assert.equal(await text(page, '.chart__symbol'), 'EUR/USD');
      assert.equal(await text(page, '.chart__price'), NO_VALUE);
      assert.equal(await page.locator('.chart__quote .badge').isVisible(), false);
      assert.equal(await page.locator('.chart__canvas').isVisible(), false, 'the canvas is hidden');
      assert.equal(
        await inkPixels(page, '.chart__canvas'),
        0,
        'and nothing but the background is painted on it',
      );
      assert.equal(await page.locator('.chart__readout').getAttribute('data-empty'), 'true');
      assert.deepEqual(await page.locator('.chart__readout b').allTextContents(), [
        '',
        '',
        '',
        '',
        '',
      ]);
      assert.equal(
        await page.locator('#chart-panel .chart__notices').isVisible(),
        false,
        'no STALE notice without data',
      );
      assert.match(
        await text(page, '#chart-panel .chart__overlay'),
        /The chart stays empty on purpose/,
      );
    });
  });

  it('chart: the data table has no rows to list', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('#chart-panel details > summary').click();
      assert.equal(await page.locator('#chart-panel table tbody tr').count(), 0);
      assert.match(await text(page, '#chart-panel details > summary'), /data table/i);
    });
  });

  it('depth: no book, no bid or ask, no venue: only ENV NOT CONNECTION and what depth needs', async () => {
    await withPage(FOREX, async ({ page }) => {
      const panel = '#depth-panel';
      assert.equal(await written(page, `${panel} .panel__title`), 'Market depth');
      assert.equal((await envBlock(page, panel))?.label, ENV_NOT_CONNECTION);
      assert.equal(await page.locator(`${panel} table`).count(), 0);
      const shown = await page.locator(panel).innerText();
      assert.doesNotMatch(shown, /\b(bid|ask|spread)\b/i, 'no book is drawn');
      assert.match(
        await text(page, `${panel} .env-block__note`),
        /never estimates, interpolates or draws a book of its own/,
      );
      const buttons = await page.locator(`${panel} button:visible`).allTextContents();
      assert.deepEqual(
        buttons,
        ['Check connection'],
        'the only control offered is the one that does something',
      );
    });
  });
});

// ---- ELVOID ---------------------------------------------------------------------------------

describe('no env: ELVOID reasoning workspace', () => {
  const PANEL = '#elvoid-panel';

  it('says NOT CONFIGURED and why, and offers no analysis it cannot run', async () => {
    await withPage(FOREX, async ({ page }) => {
      assert.equal(await written(page, `${PANEL} .panel__title`), 'ELVOID reasoning workspace');
      assert.equal(await text(page, `${PANEL} .elvoid__state`), 'NOT CONFIGURED');
      assert.equal(
        await page.locator(`${PANEL} .elvoid__state`).getAttribute('data-status'),
        'NOT_CONFIGURED',
      );
      const reason = await text(page, `${PANEL} .elvoid__reason`);
      assert.match(reason, /No ELVOID engine is connected\./);
      assert.match(reason, /No analysis is produced and none is simulated\./);
      assert.equal(
        await page.locator(`${PANEL} [role="status"]`).count(),
        1,
        'the state is announced politely',
      );
      assert.equal(
        await page.locator(`${PANEL} button:visible`).count(),
        0,
        'no visible button: a retry for a missing engine would be a dead button',
      );
      const retry = page.locator(`${PANEL} button`, { hasText: 'Retry analysis' });
      assert.equal(await retry.count(), 1, 'the retry exists, for the ERROR state');
      assert.equal(
        await retry.isVisible(),
        false,
        'and is not offered while there is no engine to retry',
      );
    });
  });

  it('states the instrument, the data it would use, the engine, and that nothing was requested or completed', async () => {
    await withPage(FOREX, async ({ page }) => {
      const terms = await page.locator(`${PANEL} .elvoid__facts dt`).allTextContents();
      assert.deepEqual(
        terms.map((term) => term.trim().toLowerCase()),
        ['instrument', 'input data', 'engine', 'requested', 'completed'],
      );
      const values = await page.locator(`${PANEL} .elvoid__facts dd`).allTextContents();
      assert.equal(values[0], 'EUR/USD · H1');
      assert.match(values[1] ?? '', /UNAVAILABLE/);
      assert.equal(
        await page.locator(`${PANEL} .elvoid__facts dd .badge`).first().getAttribute('data-state'),
        'unavailable',
      );
      assert.equal(values[2], 'none connected');
      assert.equal(values[3]?.trim(), NO_VALUE);
      assert.equal(values[4]?.trim(), NO_VALUE);
      assert.equal(await text(page, `${PANEL} .panel__meta`), 'no engine connected');
    });
  });

  it('has the eight sections in reading order, each saying plainly that nothing was produced', async () => {
    await withPage(FOREX, async ({ page }) => {
      const sections = page.locator(`${PANEL} section.elvoid__section`);
      assert.deepEqual(
        await sections.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-section')),
        ),
        ['evidence', 'technical', 'macro', 'bullish', 'bearish', 'invalidation', 'risks', 'final'],
      );
      assert.deepEqual(
        (await sections.locator('h3').allTextContents()).map((title) => title.trim().toLowerCase()),
        [
          'evidence',
          'technical context',
          'macro context',
          'bullish case',
          'bearish case',
          'invalidation',
          'risks',
          'final state',
        ],
      );
      const bodies = await sections.locator('.elvoid__section-body').allTextContents();
      assert.deepEqual(bodies.slice(0, 7), Array(7).fill('Not produced.'));
      assert.equal(bodies[7], 'No conclusion. ELVOID has not run.');
      assert.equal(
        await page.locator(`${PANEL} .elvoid__section-body li`).count(),
        0,
        'no evidence, condition or risk is listed',
      );
      assert.equal(
        await page.locator(`${PANEL} .elvoid__conclusion`).count(),
        0,
        'no WAIT, RESEARCHING or VALIDATED verdict',
      );
      assert.equal(await page.locator(`${PANEL} .elvoid__provenance`).isVisible(), false);
    });
  });

  it('shows no confidence, probability, win rate, profit, return or backtest figure', async () => {
    await withPage(FOREX, async ({ page }) => {
      const shown = await page.locator(`${PANEL} .elvoid__body`).innerText();
      const visibleBeforeModules = shown.split('ELVOID modules')[0] ?? '';
      assert.doesNotMatch(
        visibleBeforeModules,
        /confidence|probabilit|win rate|win-rate|profit|return|backtest|accuracy|score|%/i,
      );
      assert.doesNotMatch(visibleBeforeModules, /\d+(\.\d+)?\s?%/);
      assert.doesNotMatch(
        visibleBeforeModules,
        /\b(buy|sell|long|short)\b/i,
        'no trade instruction',
      );
    });
  });

  it('lists the thirteen module boundaries and says that only one is implemented', async () => {
    await withPage(FOREX, async ({ page }) => {
      const summary = page.locator(`${PANEL} details[data-role="modules"] > summary`);
      assert.equal(await summary.textContent(), 'ELVOID modules · 1 of 13 implemented');
      assert.equal(await page.locator(`${PANEL} details.module`).count(), 13);
      await summary.click();
      assert.equal(
        await page.locator(`${PANEL} details[data-role="modules"]`).getAttribute('open'),
        '',
      );

      const entries = await page.locator(`${PANEL} details.module`).evaluateAll((nodes) =>
        nodes.map((node) => ({
          id: node.getAttribute('data-module'),
          status: node.querySelector('.module__status')?.getAttribute('data-status'),
        })),
      );
      assert.equal(entries.length, 13);
      assert.equal(new Set(entries.map((entry) => entry.id)).size, 13, 'thirteen distinct modules');
      const tally = (status: string): number =>
        entries.filter((entry) => entry.status === status).length;
      assert.equal(tally('implemented'), 1);
      assert.equal(tally('contract-only'), 3);
      assert.equal(tally('not-implemented'), 9);
      assert.equal(
        entries.find((entry) => entry.status === 'implemented')?.id,
        'market-data-normalization',
        'the one implemented module is the one that guards the data',
      );

      const first = page.locator(`${PANEL} details.module`).first();
      await first.locator('summary').click();
      const terms = await first.locator('dt').allTextContents();
      assert.deepEqual(
        terms.map((term) => term.trim().toLowerCase()),
        ['takes in', 'puts out', 'refuses or fails on', 'contract in the repository'],
      );
    });
  });

  it('says ELVOID does not change itself, and never claims it learns or evolves on its own', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator(`${PANEL} details[data-role="modules"] > summary`).click();
      const intro = await text(page, `${PANEL} .modules__intro`);
      assert.match(intro, /ELVOID does not change itself/);
      assert.match(
        intro,
        /tested, evaluated, versioned and approved by a person before it is released/,
      );
      const all = await page.locator(PANEL).evaluate((node) => node.textContent ?? '');
      assert.doesNotMatch(all, /self[- ](evolv|improv|learn|modif|optimi)/i);
      assert.doesNotMatch(all, /autonomous(ly)?\s+(learn|improv|evolv|trad)/i);
    });
  });
});

// ---- Macro Intelligence ---------------------------------------------------------------------

describe('no env: Macro Intelligence', () => {
  it('has three real tab links, one per address, and the current one is marked', async () => {
    await withPage('#/macro/vol-surface', async ({ page }) => {
      const tabs = page.locator('nav.tabs a.tabs__tab');
      assert.deepEqual(await tabs.allTextContents(), [
        'Volatility surface',
        'Macro bubbles',
        'News & calendar',
      ]);
      assert.deepEqual(
        await tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
        ['#/macro/vol-surface', '#/macro/bubbles', '#/macro/news-calendar'],
      );
      for (const [index, route] of ROUTES.slice(1).entries()) {
        await tabs.nth(index).click();
        await waitForHash(page, route.hash);
        assert.equal(await page.title(), route.title);
        assert.deepEqual(
          await tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-current'))),
          [0, 1, 2].map((slot) => (slot === index ? 'page' : null)),
        );
      }
    });
  });

  it('volatility surface: no surface, no plot, and every view control off', async () => {
    await withPage('#/macro/vol-surface', async ({ page }) => {
      assert.equal(await page.locator(SURFACE_CANVAS).isVisible(), false);
      assert.equal(await inkPixels(page, SURFACE_CANVAS), 0);
      assert.equal(
        await page.locator('#vol-surface-panel .macro__facts, #vol-surface-panel .scale').count(),
        0,
        'no facts, no color legend',
      );
      assert.equal(await page.locator('#vol-surface-panel .badge:visible').count(), 0);
      for (const control of ['Reset view', 'Zoom in', 'Zoom out']) {
        assert.equal(
          await page
            .locator(
              `#vol-surface-panel button:text-is("${control}"), #vol-surface-panel button[aria-label="${control}"]`,
            )
            .first()
            .isDisabled(),
          true,
          control,
        );
      }
      const spacing = page.locator('#vol-surface-panel .seg__btn');
      assert.deepEqual(await spacing.allTextContents(), ['Calendar days', 'Equal steps']);
      assert.equal(await spacing.nth(0).isDisabled(), true);
      assert.equal(await spacing.nth(1).isDisabled(), true);
    });
  });

  it('volatility surface: the underlying list is the eight instruments, and choosing one keeps the honest state', async () => {
    await withPage('#/macro/vol-surface', async ({ page }) => {
      const select = page.getByLabel('Underlying');
      assert.deepEqual(await select.locator('option').allTextContents(), [
        'EUR/USD',
        'GBP/USD',
        'USD/JPY',
        'AUD/USD',
        'USD/CAD',
        'USD/CHF',
        'NZD/USD',
        'XAU/USD',
      ]);
      assert.equal(await select.inputValue(), 'EURUSD');
      for (const id of ['USDJPY', 'XAUUSD', 'EURUSD']) {
        await select.selectOption(id);
        assert.equal(await select.inputValue(), id);
        const block = await envBlock(page, '#vol-surface-panel');
        assert.equal(block?.label, ENV_NOT_CONNECTION, id);
        assert.equal(block?.detail, 'An options-data provider is not connected.', id);
      }
    });
  });

  it('volatility surface: documents what the chart will encode, before any data exists', async () => {
    await withPage('#/macro/vol-surface', async ({ page }) => {
      const terms = await page.locator('#vol-surface-panel dl.spec dt').allTextContents();
      assert.deepEqual(
        terms.map((term) => term.trim().toLowerCase()),
        ['axes', 'height and color', 'vertical axis', 'mesh', 'expiry spacing', 'fx convention'],
      );
      const spec = await text(page, '#vol-surface-panel dl.spec');
      assert.match(spec, /does not start at zero/);
      assert.match(spec, /Nothing is smoothed, interpolated or extrapolated/);
      assert.match(spec, /FX options are quoted by delta, not strike/);
    });
  });

  it('macro bubbles: no bubble, no axis, and the encoding is documented in words', async () => {
    await withPage('#/macro/bubbles', async ({ page }) => {
      assert.equal(await page.locator('#bubbles-panel svg:visible').count(), 0);
      assert.equal(await page.locator('#bubbles-panel .bubble').count(), 0);
      const terms = await page.locator('#bubbles-panel dl.spec dt').allTextContents();
      assert.deepEqual(
        terms.map((term) => term.trim().toLowerCase()),
        [
          'one bubble',
          'horizontal position',
          'vertical position',
          'size',
          'color and glyph',
          'dates and sources',
        ],
      );
      const spec = await text(page, '#bubbles-panel dl.spec');
      assert.match(
        spec,
        /Radius = minimum \+ \(maximum − minimum\) × √\(\|change\| ÷ largest \|change\|\)/,
      );
      assert.match(
        spec,
        /Nothing is estimated or filled in: a currency missing any of the three is not drawn\./,
      );
    });
  });

  it('news and calendar: both lists say ENV NOT CONNECTION, list nothing, and turn their controls off', async () => {
    await withPage('#/macro/news-calendar', async ({ page }) => {
      assert.equal(await page.locator('#calendar-panel article, #news-panel article').count(), 0);
      assert.equal(
        await page.locator('#calendar-panel .feed__empty, #news-panel .feed__empty').count(),
        0,
        'unconnected is not the same as empty',
      );
      assert.deepEqual(await page.getByLabel('Time zone').locator('option').allTextContents(), [
        'UTC',
        'New York',
        'London',
        'Tokyo',
        'Sydney',
      ]);
      assert.equal(await page.getByLabel('Time zone').isDisabled(), true, 'nothing to re-zone');
      assert.equal(await page.getByLabel('Currency').isDisabled(), true, 'nothing to filter');
      assert.deepEqual(await page.getByLabel('Currency').locator('option').allTextContents(), [
        'All currencies',
      ]);
    });
  });

  it('news and calendar: states the window it would ask for, the zone rule, and that Elstand rates nothing itself', async () => {
    await withPage('#/macro/news-calendar', async ({ page }) => {
      const notes = await text(page, 'dl.spec');
      assert.match(notes, /From the start of today \(UTC\) for 7 days: 2026-01-06 to 2026-01-13\./);
      assert.match(notes, /Elstand assigns no impact of its own/);
      assert.match(notes, /An item the source did not rate shows UNCLASSIFIED/);
      assert.match(
        notes,
        /Without an engine none is shown, and any interpretation a provider sends is removed\./,
      );
    });
  });
});

// ---- nothing invented -----------------------------------------------------------------------

describe('no env: no simulated or sample data anywhere', () => {
  for (const route of ROUTES) {
    it(`${route.hash}: no market-looking number, no percentage, no data badge but N/A`, async () => {
      await withPage(route.hash, async ({ page }) => {
        const shown = await visibleText(page);
        assert.doesNotMatch(
          shown,
          /\d+\.\d{3,}/,
          'no price-like number with three or more decimals',
        );
        assert.doesNotMatch(shown, /\d\s?%/, 'no percentage');

        const badges = await page
          .locator('.badge')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.getClientRects().length > 0)
              .map((node) => `${node.getAttribute('data-state')}:${node.textContent}`),
          );
        assert.ok(
          badges.every((badge) => badge === 'unavailable:N/A'),
          `only the unavailable state is shown: ${badges.join(', ')}`,
        );
        assert.equal(await inkPixels(page, '.chart__canvas'), 0);
        assert.equal(await inkPixels(page, SURFACE_CANVAS), 0);
        assert.equal(await page.locator('canvas:visible').count(), 0, 'no canvas is on screen');
        assert.equal(await page.locator('table:visible').count(), 0, 'no table is on screen');
      });
    });
  }

  it('says nothing like "demo", "sample", "example data" or "simulated" except to say it never uses them', async () => {
    for (const route of ROUTES) {
      await withPage(route.hash, async ({ page }) => {
        // Each text node on its own, hidden ones included, so one denial cannot excuse a
        // different sentence that happens to sit next to it.
        const nodes = await page.evaluate(() => {
          const found: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (value !== '') found.push(value);
          }
          return found;
        });
        assert.ok(nodes.length > 20, 'the walk found the page text');
        for (const value of nodes) {
          // "sample size" and "sample too small" are statistics, not invented data.
          const invented =
            /\b(demo|simulat\w*|mock|dummy|fake|placeholder|example data|sample (?:data|candles?|prices?|quotes?|values?|surface|book))\b/i;
          if (!invented.test(value)) continue;
          assert.match(
            value,
            /\b(never|not|no|none|without|does not|stays empty on purpose)\b/i,
            `${route.hash}: "${value}" mentions invented data without denying it`,
          );
        }
      });
    }
  });
});

// ---- the API a fresh deployment answers with -------------------------------------------------

describe('no env: the server', () => {
  it('/api/status says not connected and names the missing variable, never a value', async () => {
    const response = await fetch(`${app.url}/api/status`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { connected: false, missing: ['TWELVE_DATA_API_KEY'] });
  });

  it('/api/quotes and /api/candles refuse with 503 not_connected and say what to set', async () => {
    for (const path of [
      '/api/quotes?ids=EURUSD',
      '/api/quotes',
      '/api/candles?instrument=EURUSD&timeframe=H1',
    ]) {
      const response = await fetch(`${app.url}${path}`);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'not_connected', path);
      assert.match(body.error.message, /Set TWELVE_DATA_API_KEY on the server\./, path);
      assert.deepEqual(Object.keys(body), ['error'], 'no data field next to the error');
    }
  });

  it('accepts GET only, answers an unknown API path with a JSON 404, and never serves a file outside dist', async () => {
    const post = await fetch(`${app.url}/api/status`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    const unknown = await fetch(`${app.url}/api/nope`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get('content-type') ?? '', /^application\/json/);
    const page = await fetch(`${app.url}/`, { method: 'POST' });
    assert.equal(page.status, 405);
    for (const path of [
      '/nope.js',
      '/.env',
      '/..%2f..%2fpackage.json',
      '/%2e%2e/package.json',
      '/assets/main.js.map',
      '/server/env.ts',
    ]) {
      const missing = await fetch(`${app.url}${path}`);
      assert.equal(missing.status, 404, path);
      assert.equal(await missing.text(), 'Not found.', path);
    }
  });

  it('serves the page with a strict Content-Security-Policy and the other security headers', async () => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy') ?? '';
    const directives = new Map(
      policy
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
          const [name = '', ...values] = part.split(/\s+/);
          return [name, values.join(' ')] as const;
        }),
    );
    assert.equal(directives.get('default-src'), "'none'");
    assert.equal(directives.get('script-src'), "'self'");
    assert.equal(directives.get('style-src'), "'self'");
    assert.equal(directives.get('connect-src'), "'self'");
    assert.equal(directives.get('img-src'), "'self' data:");
    assert.equal(directives.get('base-uri'), "'none'");
    assert.equal(directives.get('form-action'), "'none'");
    assert.equal(directives.get('frame-ancestors'), "'none'");
    assert.doesNotMatch(
      policy,
      /unsafe-inline|unsafe-eval|\*|https?:/,
      'no wildcard, no remote origin, no inline code',
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const permissions = response.headers.get('permissions-policy') ?? '';
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()'])
      assert.ok(permissions.includes(feature), feature);
  });

  it('caches hashed assets for a year and never the page itself', async () => {
    const html = await (await fetch(`${app.url}/`)).text();
    const assets = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    assert.equal(assets.length, 2, 'one stylesheet and one script');
    assert.ok(
      assets.every((asset) => /-[A-Z0-9]{8}\.(css|js)$/.test(asset)),
      `content-hashed names: ${assets.join(', ')}`,
    );
    for (const asset of assets) {
      const response = await fetch(`${app.url}${asset}`);
      assert.equal(response.status, 200, asset);
      assert.equal(
        response.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
        asset,
      );
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', asset);
    }
    assert.equal((await fetch(`${app.url}/`)).headers.get('cache-control'), 'no-cache');
  });

  it('loads the page with no inline script, no inline style and no third-party origin', async () => {
    const html = await (await fetch(`${app.url}/`)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'every script has a src');
    assert.doesNotMatch(html, /<style[\s>]/i);
    assert.doesNotMatch(html, /\sstyle="/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handler');
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.match(
      html,
      /<noscript>Elstand Intelligence needs JavaScript\. Without it nothing can be shown\.<\/noscript>/,
    );
  });
});

// ---- when the server answers oddly: not the same thing as "no env" ---------------------------

describe('no env: a server that cannot say whether it is connected', () => {
  const RESOURCE_ERROR = /^console\.error: Failed to load resource/;

  /** Console lines the browser itself prints for a non-2xx response. Nothing else is tolerated. */
  const unexpected = (problems: readonly string[]): string[] =>
    problems.filter((line) => !RESOURCE_ERROR.test(line));

  it('treats a missing API (404) as ENV NOT CONNECTION: a static host has no server environment', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.route('**/api/status', (route) =>
        route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found.' }),
      );
      await watched.page.goto(`${app.url}/${FOREX}`);
      await decided(watched.page);
      assert.equal(await chipValue(watched.page, 'SOURCE'), ENV_NOT_CONNECTION);
      const block = await envBlock(watched.page, '#chart-panel');
      assert.equal(block?.label, ENV_NOT_CONNECTION);
      assert.match(
        block?.detail ?? '',
        /^The Elstand server API is not available at \/api\/status\./,
      );
      assert.deepEqual(unexpected(watched.problems), []);
    } finally {
      await watched.context.close();
    }
  });

  it('treats an HTML page where the API should be (a rewrite to index.html) as ENV NOT CONNECTION', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.route('**/api/status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Elstand</title>',
        }),
      );
      await watched.page.goto(`${app.url}/${FOREX}`);
      await decided(watched.page);
      assert.equal(await chipValue(watched.page, 'SOURCE'), ENV_NOT_CONNECTION);
      assert.equal((await envBlock(watched.page, '#chart-panel'))?.label, ENV_NOT_CONNECTION);
      assert.deepEqual(watched.problems, []);
    } finally {
      await watched.context.close();
    }
  });

  it('says SERVER ERROR, not ENV NOT CONNECTION, when the server fails, and recovers on Retry', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.route('**/api/status', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'provider_error', message: 'Something broke.' } }),
        }),
      );
      await watched.page.goto(`${app.url}/${FOREX}`);
      await decided(watched.page);
      assert.equal(await chipValue(watched.page, 'SOURCE'), 'SERVER ERROR');
      assert.equal(
        await watched.page.locator(SOURCE_VALUE).getAttribute('data-tone'),
        'down',
        'a failure is not drawn in the same tone as a missing connection',
      );
      await watched.page.waitForSelector('.wl__env .notice');
      assert.match(await text(watched.page, '.wl__env'), /SERVER ERROR/);
      assert.equal(
        await watched.page.locator('.env-block').count(),
        0,
        'no ENV NOT CONNECTION claim for a server that failed',
      );

      await watched.page.unroute('**/api/status');
      await watched.page.locator('.wl__env button', { hasText: 'Retry' }).click();
      await watched.page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent === 'ENV NOT CONNECTION',
        SOURCE_VALUE,
      );
      assert.equal((await envBlock(watched.page, '#chart-panel'))?.label, ENV_NOT_CONNECTION);
      assert.deepEqual(unexpected(watched.problems), []);
    } finally {
      await watched.context.close();
    }
  });

  it('treats a gateway error that is not the Elstand error envelope as an API that is not there, and says which HTTP status it got', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.route('**/api/status', (route) =>
        route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad gateway' }),
      );
      await watched.page.goto(`${app.url}/${FOREX}`);
      await decided(watched.page);
      assert.equal(await chipValue(watched.page, 'SOURCE'), ENV_NOT_CONNECTION);
      const block = await envBlock(watched.page, '#chart-panel');
      assert.equal(block?.label, ENV_NOT_CONNECTION);
      assert.match(block?.detail ?? '', /\/api\/status did not answer with JSON \(HTTP 502\)\./);
      assert.deepEqual(unexpected(watched.problems), []);
    } finally {
      await watched.context.close();
    }
  });

  it('says SERVER ERROR when the network call fails, and when the status is malformed', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.route('**/api/status', (route) => route.abort('connectionrefused'));
      await watched.page.goto(`${app.url}/${FOREX}`);
      await decided(watched.page);
      assert.equal(await chipValue(watched.page, 'SOURCE'), 'SERVER ERROR');
      assert.equal(await watched.page.locator('.env-block').count(), 0);

      await watched.page.unroute('**/api/status');
      await watched.page.route('**/api/status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ connected: 'maybe' }),
        }),
      );
      await watched.page.locator('.wl__env button', { hasText: 'Retry' }).click();
      await watched.page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent === 'SERVER ERROR',
        SOURCE_VALUE,
      );
      await watched.page.waitForFunction(() =>
        /unusable status/.test(document.querySelector('.wl__env')?.textContent ?? ''),
      );
      assert.equal(await watched.page.locator('.env-block').count(), 0);
      assert.deepEqual(
        watched.problems.filter((line) => !/ERR_CONNECTION_REFUSED|requestfailed/.test(line)),
        [],
      );
    } finally {
      await watched.context.close();
    }
  });
});

// ---- addresses ------------------------------------------------------------------------------

describe('no env: addresses', () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['', '#/forex/EURUSD/H1'],
    ['#/', '#/forex/EURUSD/H1'],
    ['#/nope', '#/forex/EURUSD/H1'],
    ['#/forex', '#/forex/EURUSD/H1'],
    ['#/forex/FOO/H1', '#/forex/EURUSD/H1'],
    ['#/forex/EURUSD/ZZ', '#/forex/EURUSD/H1'],
    ['#/forex/gbpusd/m15', '#/forex/GBPUSD/M15'],
    ['#/forex/GBP%2FUSD/h4', '#/forex/GBPUSD/H4'],
    ['#/forex/xauusd/d1', '#/forex/XAUUSD/D1'],
    ['#/forex/%E0%A4%A/H1', '#/forex/EURUSD/H1'],
    ['#/macro', '#/macro/vol-surface'],
    ['#/macro/BUBBLES', '#/macro/bubbles'],
    ['#/macro/zzz', '#/macro/vol-surface'],
    ['#/MACRO/news-calendar', '#/macro/news-calendar'],
  ];
  for (const [entered, canonical] of CASES) {
    it(`${entered === '' ? '(no hash)' : entered} becomes ${canonical} and renders`, async () => {
      const watched = await session.newPage();
      try {
        await watched.page.goto(`${app.url}/${entered}`);
        await decided(watched.page);
        await waitForHash(watched.page, canonical);
        assert.equal(await hashOf(watched.page), canonical);
        assert.equal(await watched.page.locator('h1').count(), 1);
        assert.equal(await watched.page.locator('.env-block__label').first().isVisible(), true);
        assert.deepEqual(watched.problems, [], 'a bad address is repaired, never an error');
      } finally {
        await watched.context.close();
      }
    });
  }

  it('opens a deep link straight onto the right chart', async () => {
    await withPage('#/forex/XAUUSD/D1', async ({ page }) => {
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'XAU/USD · D1');
      assert.equal(await text(page, '.chart__symbol'), 'XAU/USD');
      assert.equal(await text(page, '#chart-panel .seg__btn[aria-pressed="true"]'), 'D1');
      assert.equal(
        await page.locator('button.wl__row[aria-current="true"]').getAttribute('data-instrument'),
        'XAUUSD',
      );
      assert.equal(await text(page, '#elvoid-panel .elvoid__facts dd'), 'XAU/USD · D1');
    });
  });

  it('follows the browser Back and Forward buttons', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('button.wl__row[data-instrument="GBPUSD"]').click();
      await waitForHash(page, '#/forex/GBPUSD/H1');
      await page.locator('#chart-panel .seg__btn', { hasText: /^H4$/ }).click();
      await waitForHash(page, '#/forex/GBPUSD/H4');

      await page.goBack();
      await waitForHash(page, '#/forex/GBPUSD/H1');
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'GBP/USD · H1');
      await page.goBack();
      await waitForHash(page, FOREX);
      assert.equal(await chipValue(page, 'INSTRUMENT'), 'EUR/USD · H1');
      assert.equal(await text(page, '.chart__symbol'), 'EUR/USD');
      await page.goForward();
      await waitForHash(page, '#/forex/GBPUSD/H1');
      assert.equal(await text(page, '.chart__symbol'), 'GBP/USD');
    });
  });
});

// ---- layout ---------------------------------------------------------------------------------

describe('no env: layout', () => {
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    for (const route of ROUTES) {
      it(`${route.hash} fits ${size.width}px with no sideways page scroll and nothing cut off`, async () => {
        await withPage(
          route.hash,
          async ({ page }) => {
            const metrics = await page.evaluate(() => {
              const clientWidth = document.documentElement.clientWidth;
              const wide: string[] = [];
              for (const node of Array.from(
                document.querySelectorAll(
                  'header, nav, main, footer, section.panel, .chips, .chip, .env-block',
                ),
              )) {
                const rect = node.getBoundingClientRect();
                if (rect.width > 0 && (rect.right > clientWidth + 1 || rect.left < -1)) {
                  wide.push(
                    `${node.tagName.toLowerCase()}.${(node.getAttribute('class') ?? '').split(' ')[0]} spans ${Math.round(rect.left)}–${Math.round(rect.right)}`,
                  );
                }
              }
              return { scrollWidth: document.documentElement.scrollWidth, clientWidth, wide };
            });
            assert.ok(
              metrics.scrollWidth <= metrics.clientWidth,
              `the page is ${metrics.scrollWidth}px wide in a ${metrics.clientWidth}px window`,
            );
            assert.deepEqual(metrics.wide, [], 'every landmark and panel stays inside the window');
            for (const region of ENV_REGIONS.filter((entry) => entry.hash === route.hash)) {
              const label = page.locator(`${region.scope} .env-block__label`).first();
              await label.scrollIntoViewIfNeeded();
              assert.equal(
                await label.isVisible(),
                true,
                `${region.name} still shows ENV NOT CONNECTION at ${size.width}px`,
              );
            }
          },
          size,
        );
      });
    }
  }

  it('keeps the header usable at 390px: wordmark, two links and three chips all on screen', async () => {
    await withPage(
      FOREX,
      async ({ page }) => {
        const boxes = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll('header .brand, header .nav__link, header .chip'),
          ).map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              name: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
          }),
        );
        assert.equal(boxes.length, 6);
        for (const box of boxes) {
          assert.ok(box.width > 20, `${box.name} has a box`);
          assert.ok(
            box.left >= 0 && box.right <= 390 + 1,
            `${box.name} is inside the 390px window`,
          );
        }
        const source = boxes.find((box) => box.name.startsWith('SOURCE'));
        assert.match(source?.name ?? '', /ENV NOT CONNECTION/);
        const clipped = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll('header .chip, header .chip__value, header .nav__link'),
          )
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => `${node.className}: ${node.scrollWidth}px of ${node.clientWidth}px`),
        );
        assert.deepEqual(clipped, [], 'no header text is cut off');
      },
      { width: 390, height: 844 },
    );
  });
});

// ---- structure ------------------------------------------------------------------------------

describe('no env: structure and accessibility basics', () => {
  for (const route of ROUTES) {
    it(`${route.hash}: one h1, one main, unique ids, named controls, no empty ARIA state`, async () => {
      await withPage(route.hash, async ({ page }) => {
        assert.deepEqual(await auditBasics(page), []);
        assert.deepEqual(await emptyAriaStates(page), []);
        const landmarks = await page.evaluate(() => ({
          banner: document.querySelectorAll('.app > header').length,
          main: document.querySelectorAll('main').length,
          footer: document.querySelectorAll('footer').length,
          navs: Array.from(document.querySelectorAll('nav')).map((node) =>
            node.getAttribute('aria-label'),
          ),
        }));
        assert.equal(landmarks.banner, 1);
        assert.equal(landmarks.main, 1);
        assert.equal(landmarks.footer, 1);
        assert.ok(
          landmarks.navs.every((label) => label !== null && label !== ''),
          'every navigation landmark has a name',
        );
      });
    });
  }

  it('every panel is a labelled region whose name is its visible title', async () => {
    for (const route of ROUTES) {
      await withPage(route.hash, async ({ page }) => {
        const panels = await page.evaluate(() =>
          Array.from(document.querySelectorAll('section.panel')).map((node) => {
            const labelledBy = node.getAttribute('aria-labelledby') ?? '';
            const title = document.getElementById(labelledBy);
            return {
              labelledBy,
              title: title?.textContent ?? null,
              heading: title?.tagName ?? null,
            };
          }),
        );
        assert.ok(panels.length >= 1);
        for (const panel of panels) {
          assert.notEqual(panel.labelledBy, '');
          assert.ok((panel.title ?? '').trim() !== '', `${route.hash}: a panel has an empty title`);
          assert.equal(panel.heading, 'H2');
        }
      });
    }
  });

  it('announces state changes politely and never steals focus', async () => {
    await withPage(FOREX, async ({ page }) => {
      await page.locator('button.wl__row[data-instrument="AUDUSD"]').focus();
      await page.keyboard.press('Enter');
      await waitForHash(page, '#/forex/AUDUSD/H1');
      assert.equal(
        await activeInstrument(page),
        'AUDUSD',
        'selecting a row leaves focus on that row',
      );
      const assertive = await page.locator('[aria-live="assertive"], [role="alert"]').count();
      assert.equal(assertive, 0, 'no alert for a state that is simply the truth');
    });
  });
});
