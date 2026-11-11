import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import {
  CONNECTED_ENV,
  launchBrowser,
  startApp,
  TEST_API_KEY,
  type BrowserSession,
  type StartedApp,
  type WatchedPage,
} from './support/harness.js';
import { createMarketVendor } from './support/market-vendor.js';
import { auditBasics, emptyAriaStates, text } from './support/page-helpers.js';

/**
 * The provider status page, on the real production bundle. Its rule is the product's: a variable
 * that exists is not a connection. So a provider shows CONFIGURED — NOT VERIFIED until a real
 * request has been answered and validated, a check is one real request made only on a click, and
 * no value of a credential ever reaches the page.
 *
 * Nothing here is market data. The "vendor" is the test-only stand-in; with none, any request the
 * server tries to make to a provider fails, which the page must then report as an error in words.
 */

let session: BrowserSession;
before(async () => {
  session = await launchBrowser();
});
after(async () => {
  await session.close();
});

const NOT_VERIFIED = 'CONFIGURED — NOT VERIFIED';

async function withProviders(
  app: StartedApp,
  run: (watched: WatchedPage) => Promise<void>,
): Promise<void> {
  const watched = await session.newPage();
  try {
    await watched.page.goto(`${app.url}/#/providers`);
    await watched.page.waitForSelector('#providers-panel article.provider');
    await run(watched);
    assert.deepEqual(watched.problems, [], 'no console errors, CSP violations or failed requests');
    assert.deepEqual(await emptyAriaStates(watched.page), [], 'no ARIA state attribute is empty');
    assert.deepEqual(await auditBasics(watched.page), [], 'the page passes the structural audit');
  } finally {
    await watched.context.close();
  }
}

const provider = (id: string): string => `#providers-panel article[data-provider="${id}"]`;
const states = (page: Page, id: string): Promise<string[]> =>
  page.$$eval(`${provider(id)} tbody .pstate`, (nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim()),
  );

describe('provider status: no environment', () => {
  let app: StartedApp;
  before(async () => {
    app = await startApp({});
  });
  after(async () => {
    await app.close();
  });

  it('is one link away in the footer, and lists the ten providers by name', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.goto(`${app.url}/`);
      await watched.page.getByRole('link', { name: 'Provider status' }).click();
      await watched.page.waitForSelector('#providers-panel article.provider');
      assert.equal(new URL(watched.page.url()).hash, '#/providers');
      assert.deepEqual(
        await watched.page.$$eval('#providers-panel .provider__name', (nodes) =>
          nodes.map((node) => node.textContent),
        ),
        [
          'Twelve Data',
          'Alpha Vantage',
          'FRED',
          'Finance Calendar',
          'Marketaux',
          'Frankfurter',
          'World Bank',
          'IMF Data',
          'U.S. Bureau of Labor Statistics',
          'U.S. Bureau of Economic Analysis',
        ],
      );
    } finally {
      await watched.context.close();
    }
  });

  it('shows configuration by variable name only, and a missing variable as ENV NOT CONNECTED', async () => {
    await withProviders(app, async ({ page }) => {
      const twelve = await text(page, provider('twelvedata'));
      assert.match(twelve, /TWELVE_DATA_API_KEY is not set\./);
      assert.match(twelve, /Missing TWELVE_DATA_API_KEY/);
      assert.deepEqual(await states(page, 'twelvedata'), ['ENV NOT CONNECTED']);
      assert.match(
        twelve,
        /ENV NOT CONNECTED — TWELVE_DATA_API_KEY is missing\./,
        'the same sentence the data screens use',
      );
      for (const id of ['alphavantage', 'fred', 'financecalendar', 'marketaux', 'bea']) {
        assert.deepEqual(await states(page, id), ['ENV NOT CONNECTED'], id);
      }
      const calendar = await text(page, provider('financecalendar'));
      assert.match(calendar, /FINANCE_CALENDAR_API_KEY is not set\./);
      assert.match(
        calendar,
        /ENV NOT CONNECTED — FINANCE_CALENDAR_API_KEY is missing\. Economic calendar events from Finance Calendar are unavailable\./,
        'the provider has no anonymous access, so a missing key is a missing connection',
      );
    });
  });

  it('says UNAVAILABLE, not “not connected”, for a dataset with no supported public endpoint', async () => {
    await withProviders(app, async ({ page }) => {
      assert.deepEqual(await states(page, 'imf'), ['UNAVAILABLE']);
      const imf = await text(page, provider('imf'));
      assert.match(imf, /No supported endpoint exists in this build\./);
      assert.match(
        imf,
        /UNAVAILABLE — No supported public endpoint is configured for this dataset\./,
      );
    });
  });

  it('shows a provider that needs no key as configured but not verified, never as connected', async () => {
    await withProviders(app, async ({ page }) => {
      for (const id of ['frankfurter', 'worldbank', 'bls']) {
        assert.deepEqual(await states(page, id), [NOT_VERIFIED], id);
      }
      assert.match(await text(page, provider('frankfurter')), /No credential is needed\./);
      assert.match(
        await text(page, provider('bls')),
        /BLS_API_KEY is not set; used without a key \(optional\)\./,
      );
      const everything = await text(page, '#providers-panel');
      const withoutEnv = everything.replaceAll('ENV NOT CONNECTED', '');
      assert.doesNotMatch(withoutEnv, /\bCONNECTED\b/, 'nothing is called connected');
      assert.doesNotMatch(everything, /\bLIVE\b/, 'nothing is called live without an answer');
    });
  });

  it('sends no request to any provider when it opens: only the page, its assets and the lists', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.goto(`${app.url}/#/providers`);
      await watched.page.waitForSelector('#providers-panel article.provider');
      const paths = watched.requested.map(
        (url) => `${new URL(url).pathname}${new URL(url).search}`,
      );
      const api = paths.filter((path) => path.startsWith('/api/'));
      assert.deepEqual(api.sort(), ['/api/providers', '/api/status']);
      assert.ok(
        watched.requested.every((url) => url.startsWith(app.url)),
        'every request stayed on this origin',
      );
    } finally {
      await watched.context.close();
    }
  });

  it('offers a check only where a request can be made', async () => {
    await withProviders(app, async ({ page }) => {
      for (const id of [
        'twelvedata',
        'alphavantage',
        'fred',
        'financecalendar',
        'marketaux',
        'bea',
        'imf',
      ]) {
        assert.equal(
          await page.locator(`[data-verify="${id}"]`).isDisabled(),
          true,
          `${id} is off`,
        );
      }
      for (const id of ['frankfurter', 'worldbank', 'bls']) {
        assert.equal(await page.locator(`[data-verify="${id}"]`).isEnabled(), true, `${id} is on`);
      }
      assert.equal(await page.locator('[data-verify="imf"]').innerText(), 'No endpoint to check');
    });
  });

  it('makes one real request when a check is asked for, and reports in words that it failed', async () => {
    const watched = await session.newPage();
    try {
      await watched.page.goto(`${app.url}/#/providers`);
      await watched.page.waitForSelector('#providers-panel article.provider');
      const before = watched.requested.length;
      await watched.page.locator('[data-verify="frankfurter"]').click();
      await watched.page
        .locator(`${provider('frankfurter')} .notice`, { hasText: 'CHECK · ERROR' })
        .waitFor();
      const made = watched.requested
        .slice(before)
        .map((url) => new URL(url).pathname + new URL(url).search);
      assert.deepEqual(
        made,
        ['/api/providers?probe=frankfurter'],
        'exactly one check, to one provider',
      );
      const checked = await text(watched.page, provider('frankfurter'));
      assert.match(checked, /ERROR — Could not reach Frankfurter\./);
      assert.match(checked, /no valid data was retrieved/);
      assert.deepEqual(await states(watched.page, 'frankfurter'), ['ERROR']);
      assert.deepEqual(
        await states(watched.page, 'worldbank'),
        [NOT_VERIFIED],
        'others are untouched',
      );
    } finally {
      await watched.context.close();
    }
  });
});

describe('provider status: Twelve Data configured, against a stand-in vendor', () => {
  let app: StartedApp;
  const vendor = createMarketVendor();
  before(async () => {
    app = await startApp({ env: CONNECTED_ENV, vendor });
  });
  after(async () => {
    await app.close();
  });

  /** The application polls quotes and the chart's candles on its own; wait until it was answered. */
  async function answered(page: Page): Promise<void> {
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll(
            '#providers-panel article[data-provider="twelvedata"] tbody .pstate',
          ),
        ).some((node) => node.textContent === 'DELAYED' || node.textContent === 'LIVE'),
      undefined,
      { timeout: 10_000 },
    );
  }

  it('shows what real requests have returned to this browser, with the endpoint and the time', async () => {
    await withProviders(app, async ({ page }) => {
      await answered(page);
      const twelve = await text(page, provider('twelvedata'));
      assert.match(twelve, /TWELVE_DATA_API_KEY is set\./);
      const endpoints = await page.$$eval(`${provider('twelvedata')} tbody tr`, (rows) =>
        rows.map((row) => row.children[1]?.textContent ?? ''),
      );
      assert.deepEqual(endpoints.sort(), ['quote', 'time_series']);
      const retrieved = await page.$$eval(`${provider('twelvedata')} tbody tr`, (rows) =>
        rows.map((row) => row.children[3]?.textContent ?? ''),
      );
      for (const cell of retrieved) assert.match(cell, /^2026-01-06 \d\d:\d\d UTC$/);
    });
  });

  it('checks the connection on a click, answers from a fresh copy without spending the allowance, and never shows the credential', async () => {
    await withProviders(app, async ({ page }) => {
      await answered(page);
      const callsBefore = vendor.calls.length;
      await page.locator('[data-verify="twelvedata"]').click();
      await page.locator(`${provider('twelvedata')} .notice`, { hasText: /CHECK · / }).waitFor();
      assert.equal(
        vendor.calls.length,
        callsBefore,
        'the quote was fresh in the server, so the check spent nothing',
      );
      const checked = await text(page, provider('twelvedata'));
      assert.match(checked, /CHECK · (?:LIVE|DELAYED)/);
      assert.match(checked, /valid data was retrieved/);
      assert.doesNotMatch(await text(page, 'body'), new RegExp(TEST_API_KEY));
      assert.equal(
        (await page.content()).includes(TEST_API_KEY),
        false,
        'the credential is nowhere in the page',
      );
    });
  });
});
