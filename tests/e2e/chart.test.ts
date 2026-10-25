import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ENV_NOT_CONNECTED } from '../../src/core/connection-text.js';
import { jsonResponse, vendorError, type VendorCall } from '../support/fake-vendor.js';
import {
  CONNECTED_ENV,
  launchBrowser,
  startApp,
  type BrowserSession,
  type StartedApp,
} from './support/harness.js';
import { createMarketVendor } from './support/market-vendor.js';
import {
  canvasBox,
  canvasInk,
  shownBars,
  text,
  waitForCandles,
  waitForChart,
} from './support/page-helpers.js';

const INTERVAL_FOR = {
  M5: '5min',
  M15: '15min',
  M30: '30min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
} as const;
const STEP_MINUTES = { M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 } as const;

let session: BrowserSession;
before(async () => {
  session = await launchBrowser();
});
after(async () => {
  await session.close();
});

async function connected(
  options: Parameters<typeof createMarketVendor>[0] = {},
  size: { width?: number; height?: number } = {},
) {
  const vendor = createMarketVendor(options);
  const app = await startApp({ env: CONNECTED_ENV, vendor });
  const watched = await session.newPage(size);
  await watched.page.goto(`${app.url}/#/forex/EURUSD/H1`);
  return { vendor, app, ...watched };
}

async function dispose(app: StartedApp, context: { close(): Promise<void> }): Promise<void> {
  await context.close();
  await app.close();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const chartCalls = (calls: readonly VendorCall[]): VendorCall[] =>
  calls.filter((call) => call.path === '/time_series');

describe('chart: connected', () => {
  it('draws hollow-up and filled-down candles from provider bars, with no console problems', async () => {
    const { page, app, context, problems, requested, vendor } = await connected();
    try {
      await waitForCandles(page);
      const ink = await canvasInk(page);
      assert.ok(ink.up > 20 && ink.down > 20, `both directions are drawn: ${JSON.stringify(ink)}`);
      assert.ok(ink.background > ink.total * 0.5, 'most of the canvas is background');
      assert.deepEqual(problems, [], 'no console errors, CSP violations or failed requests');
      assert.ok(
        requested.every((url) => url.startsWith(app.url)),
        `nothing left the origin: ${requested.filter((url) => !url.startsWith(app.url)).join(', ')}`,
      );
      assert.ok(chartCalls(vendor.calls).length >= 1);
      assert.equal(await page.locator('.chart__overlay').isVisible(), false);
    } finally {
      await dispose(app, context);
    }
  });

  it('shows the selected instrument, a verified badge and the data source', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      assert.equal(await text(page, '.chart__symbol'), 'EUR/USD');
      assert.match(await text(page, '.chart__quote'), /^\d\.\d{5}/);
      assert.equal(
        await page.locator('.chart__quote .badge').getAttribute('data-state'),
        'delayed',
      );
      const status = await text(page, '.chart__status');
      assert.match(status, /Twelve Data/);
      assert.match(status, /Newest bar 2026-01-06 12:00 UTC/);
      assert.match(status, /Showing \d+ of 500 bars/);
    } finally {
      await dispose(app, context);
    }
  });

  it('changes the dataset for every timeframe, using the matching provider interval', async () => {
    const { page, app, context, vendor } = await connected();
    try {
      await waitForCandles(page);
      await page.locator('.chart details.disclosure > summary').click();
      for (const timeframe of ['M5', 'M15', 'M30', 'H4', 'D1'] as const) {
        await page.locator('.seg__btn', { hasText: new RegExp(`^${timeframe}$`) }).click();
        await waitForChart(page, 'EUR/USD', timeframe);
        assert.equal(
          await page.locator(`.seg__btn[aria-pressed="true"]`).innerText(),
          timeframe,
          `${timeframe} is the pressed timeframe`,
        );
        assert.ok(
          chartCalls(vendor.calls).some(
            (call) => call.params['interval'] === INTERVAL_FOR[timeframe],
          ),
          `${timeframe} asked the provider for ${INTERVAL_FOR[timeframe]}`,
        );
        // The table lists the same bars: consecutive rows are exactly one bar apart.
        await page.locator('.chart table tbody tr').first().waitFor();
        const rows = await page.locator('.chart table tbody tr td:first-child').allInnerTexts();
        const parse = (cell: string): number =>
          Date.parse(`${cell.replace(' UTC', '').replace(' ', 'T')}:00Z`);
        const first = parse(rows[0] ?? '');
        const second = parse(rows[1] ?? '');
        assert.equal(
          (first - second) / 60_000,
          STEP_MINUTES[timeframe],
          `${timeframe} bars are ${STEP_MINUTES[timeframe]} minutes apart`,
        );
      }
    } finally {
      await dispose(app, context);
    }
  });

  it('follows the address bar: opening a chart URL selects that instrument and timeframe', async () => {
    const vendor = createMarketVendor();
    const app = await startApp({ env: CONNECTED_ENV, vendor });
    const { page, context } = await session.newPage();
    try {
      await page.goto(`${app.url}/#/forex/xauusd/h4`);
      await waitForCandles(page);
      assert.equal(await text(page, '.chart__symbol'), 'XAU/USD');
      assert.equal(await page.locator('.seg__btn[aria-pressed="true"]').innerText(), 'H4');
      assert.ok(
        vendor.calls.some(
          (call) =>
            call.path === '/time_series' &&
            call.params['symbol'] === 'XAU/USD' &&
            call.params['interval'] === '4h',
        ),
      );
      assert.match(await text(page, '.chart__quote'), /^[\d,]+\.\d{2}/, 'gold shows two decimals');
    } finally {
      await dispose(app, context);
    }
  });

  it('selects another instrument from the watchlist and redraws for it', async () => {
    const { page, app, context, vendor } = await connected();
    try {
      await waitForCandles(page);
      await page.locator('.wl__row[data-instrument="USDJPY"]').click();
      await waitForChart(page, 'USD/JPY', 'H1');
      assert.equal(await text(page, '.chart__symbol'), 'USD/JPY');
      assert.ok(
        vendor.calls.some(
          (call) => call.path === '/time_series' && call.params['symbol'] === 'USD/JPY',
        ),
      );
      const axis = await page.evaluate(
        () => document.querySelector('.chart__readout')?.textContent ?? '',
      );
      assert.match(axis, /O \d{3}\.\d{3}/, 'prices use the yen precision of three decimals');
    } finally {
      await dispose(app, context);
    }
  });
});

describe('chart: interaction', () => {
  it('shows a crosshair and the hovered bar, and returns to the newest bar when the pointer leaves', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      const box = await canvasBox(page);
      assert.match(await text(page, '.chart__readout'), /^Newest bar /);

      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      const left = await text(page, '.chart__readout');
      assert.match(left, /^Bar 2026-/);
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
      const right = await text(page, '.chart__readout');
      assert.match(right, /^Bar 2026-/);
      const time = (readout: string): number =>
        Date.parse(`${/Bar (\d{4}-\d\d-\d\d) (\d\d:\d\d)/.exec(readout)?.slice(1).join('T')}:00Z`);
      assert.ok(time(left) < time(right), 'a pointer further right reads a later bar');

      await page.mouse.move(box.x + box.width + 40, box.y - 40);
      assert.match(await text(page, '.chart__readout'), /^Newest bar /);
    } finally {
      await dispose(app, context);
    }
  });

  it('pans by dragging and returns to the newest bars on double-click', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      const before = await text(page, '.chart__status');
      const box = await canvasBox(page);
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 200, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 500, y, { steps: 6 });
      await page.mouse.up();
      const panned = await text(page, '.chart__status');
      const windowOf = (status: string): string =>
        /(\d{4}-\d\d-\d\d \d\d:\d\d UTC → \d{4}-\d\d-\d\d \d\d:\d\d UTC)/.exec(status)?.[1] ?? '';
      assert.notEqual(windowOf(panned), windowOf(before), 'the window moved');
      const [, endBefore] = windowOf(before).split(' → ');
      const [, endPanned] = windowOf(panned).split(' → ');
      assert.ok(
        Date.parse((endPanned ?? '').replace(' UTC', '').replace(' ', 'T') + ':00Z') <
          Date.parse((endBefore ?? '').replace(' UTC', '').replace(' ', 'T') + ':00Z'),
        'dragging right shows earlier bars',
      );

      await page.mouse.dblclick(box.x + 300, y);
      assert.equal(windowOf(await text(page, '.chart__status')), windowOf(before));
    } finally {
      await dispose(app, context);
    }
  });

  it('zooms with Ctrl + wheel and with the zoom buttons, and leaves a plain wheel for page scroll', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      const start = (await shownBars(page)).shown;
      const box = await canvasBox(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -240);
      await page.keyboard.up('Control');
      const zoomedIn = (await shownBars(page)).shown;
      assert.ok(zoomedIn < start, `Ctrl + wheel up shows fewer bars (${start} -> ${zoomedIn})`);

      await page.locator('button[aria-label="Zoom out"]').click();
      await page.locator('button[aria-label="Zoom out"]').click();
      assert.ok((await shownBars(page)).shown > zoomedIn, 'the zoom-out button shows more bars');
      await page.locator('button[aria-label="Zoom in"]').click();

      const before = await text(page, '.chart__status');
      await page.mouse.wheel(0, 300);
      assert.equal(
        await text(page, '.chart__status'),
        before,
        'a plain vertical wheel does not touch the chart',
      );

      await page.locator('.chart .btn', { hasText: /^Reset$/ }).click();
      assert.equal((await shownBars(page)).shown, start);
    } finally {
      await dispose(app, context);
    }
  });

  it('works from the keyboard: arrows move the crosshair and announce the bar, Escape clears, 0 resets', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      await page.locator('.chart__canvas').focus();
      await page.keyboard.press('ArrowLeft');
      const first = await text(page, '.chart__readout');
      assert.match(first, /^Bar 2026-01-06 12:00 UTC/, 'the first press lands on the newest bar');
      await page.keyboard.press('ArrowLeft');
      assert.match(await text(page, '.chart__readout'), /^Bar 2026-01-06 11:00 UTC/);
      const announced = await page.locator('.chart [role="status"]').innerText();
      assert.match(
        announced,
        /^2026-01-06 11:00 UTC\. Open \d\.\d{5}, high \d\.\d{5}, low \d\.\d{5}, close \d\.\d{5}\.$/,
      );

      await page.keyboard.press('Shift+ArrowLeft');
      assert.match(
        await text(page, '.chart__readout'),
        /^Bar 2026-01-06 01:00 UTC/,
        'Shift moves ten bars',
      );

      await page.keyboard.press('Escape');
      assert.match(await text(page, '.chart__readout'), /^Newest bar /);

      const start = (await shownBars(page)).shown;
      await page.keyboard.press('+');
      assert.ok((await shownBars(page)).shown < start);
      await page.keyboard.press('0');
      assert.equal((await shownBars(page)).shown, start);
      await page.keyboard.press('Home');
      assert.match(
        await text(page, '.chart__readout'),
        /^Bar 2025-12-16 17:00 UTC/,
        'Home goes to the oldest loaded bar',
      );
    } finally {
      await dispose(app, context);
    }
  });

  it('lists every bar in a table that matches the chart, newest first', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      assert.match(
        await text(page, '.chart details > summary'),
        /data table · 500 bars, newest first/i,
      );
      await page.locator('.chart details > summary').click();
      await page.locator('.chart table tbody tr').first().waitFor();
      assert.equal(await page.locator('.chart table tbody tr').count(), 500);
      const headers = await page.locator('.chart table thead th').allInnerTexts();
      assert.deepEqual(
        headers.map((header) => header.trim().toLowerCase()),
        ['open time (utc)', 'open', 'high', 'low', 'close'],
      );
      const first = await page.locator('.chart table tbody tr').first().innerText();
      assert.match(first, /2026-01-06 12:00 UTC/);
    } finally {
      await dispose(app, context);
    }
  });
});

describe('chart: states without a chart', () => {
  it('says ENV NOT CONNECTION and draws nothing when no provider is connected', async () => {
    const app = await startApp();
    const { page, context, problems, requested } = await session.newPage();
    try {
      await page.goto(`${app.url}/`);
      await page.waitForSelector('.chart__overlay .env-block__label');
      assert.equal(await text(page, '.chart__overlay .env-block__label'), ENV_NOT_CONNECTED);
      assert.equal(await page.locator('.chart__canvas').isVisible(), false, 'the canvas is hidden');
      assert.equal(await text(page, '.chart__price'), '—', 'no price is shown');
      assert.equal(
        await page.locator('.chart__quote .badge').isVisible(),
        false,
        'no data badge without data',
      );
      assert.match(await text(page, '.chart__overlay'), /never draws sample or simulated candles/);
      assert.deepEqual(problems, []);
      assert.ok(requested.every((url) => url.startsWith(app.url)));
    } finally {
      await dispose(app, context);
    }
  });

  it('shows a loading state, not a fake chart, while the provider answers', async () => {
    const gate = deferred();
    const { page, app, context } = await connected({
      intercept: async (call) => {
        if (call.path === '/time_series') await gate.promise;
        return undefined;
      },
    });
    try {
      await page.waitForSelector('.chart__overlay');
      assert.match(await text(page, '.chart__overlay'), /Loading EUR\/USD H1 candles…/);
      assert.equal(await page.locator('.chart__canvas').isVisible(), false);
      gate.resolve();
      await waitForCandles(page);
      assert.equal(await page.locator('.chart__overlay').isVisible(), false);
    } finally {
      gate.resolve();
      await dispose(app, context);
    }
  });

  it('shows the provider failure with a Retry that recovers once the provider does', async () => {
    let failing = true;
    const { page, app, context } = await connected({
      intercept: (call) =>
        call.path === '/time_series' && failing ? vendorError(500, 'upstream exploded') : undefined,
    });
    try {
      await page.waitForSelector('.chart__overlay .notice');
      const message = await text(page, '.chart__overlay');
      assert.match(message, /CHART FAILED/);
      assert.match(message, /EUR\/USD H1/);
      assert.equal(await page.locator('.chart__canvas').isVisible(), false);
      failing = false;
      await page.locator('.chart__overlay .btn', { hasText: 'Retry' }).click();
      await waitForCandles(page);
      assert.equal(await page.locator('.chart__overlay').isVisible(), false);
    } finally {
      await dispose(app, context);
    }
  });

  it('flips the chart to ENV NOT CONNECTION when the provider rejects the key', async () => {
    const { page, app, context } = await connected({
      intercept: (call) =>
        call.path === '/time_series'
          ? jsonResponse({ code: 401, message: 'bad key', status: 'error' }, 401)
          : undefined,
    });
    try {
      await page.waitForSelector('.chart__overlay .env-block__label');
      assert.equal(await text(page, '.chart__overlay .env-block__label'), ENV_NOT_CONNECTED);
      assert.equal(await page.locator('.chart__canvas').isVisible(), false);
    } finally {
      await dispose(app, context);
    }
  });
});

describe('chart: freshness', () => {
  it('marks a feed that stopped as STALE, with the newest bar time and no claim that it is current', async () => {
    const { page, app, context } = await connected({ barsBehind: 120 });
    try {
      await waitForCandles(page);
      const notice = await text(page, '.chart__notices');
      assert.match(notice, /STALE/);
      assert.match(notice, /The newest bar opened 2026-01-01 12:00 UTC/);
      assert.match(notice, /Do not treat this chart as current/);
      assert.equal(await page.locator('.chart__status .badge').getAttribute('data-state'), 'stale');
    } finally {
      await dispose(app, context);
    }
  });

  it('says the provider reports a closed market when it does', async () => {
    const { page, app, context } = await connected({
      barsBehind: 120,
      quoteOverrides: () => ({ is_market_open: false }),
    });
    try {
      await waitForCandles(page);
      assert.match(
        await text(page, '.chart__notices'),
        /The provider reports the market as closed/,
      );
    } finally {
      await dispose(app, context);
    }
  });

  it('shows no STALE notice for current data', async () => {
    const { page, app, context } = await connected();
    try {
      await waitForCandles(page);
      assert.equal(await page.locator('.chart__notices').isVisible(), false);
    } finally {
      await dispose(app, context);
    }
  });
});

describe('chart: layout', () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    it(`fits ${size.width}px without sideways page scroll`, async () => {
      const { page, app, context, problems } = await connected({}, size);
      try {
        await waitForCandles(page);
        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          canvasWidth:
            document.querySelector<HTMLCanvasElement>('.chart__canvas')?.getBoundingClientRect()
              .width ?? 0,
        }));
        assert.ok(
          metrics.scrollWidth <= metrics.clientWidth,
          `page is ${metrics.scrollWidth}px wide in a ${metrics.clientWidth}px window`,
        );
        assert.ok(metrics.canvasWidth > 200);
        assert.deepEqual(problems, []);
        const toolbar = await page.locator('.chart__tools').boundingBox();
        assert.ok(
          toolbar !== null && toolbar.x + toolbar.width <= size.width + 1,
          'the toolbar stays inside the window',
        );
      } finally {
        await dispose(app, context);
      }
    });
  }

  it('shows fewer bars by default on a phone than on a desktop, so candles stay legible', async () => {
    const desktop = await connected({}, { width: 1440, height: 900 });
    const phone = await connected({}, { width: 390, height: 844 });
    try {
      await waitForCandles(desktop.page);
      await waitForCandles(phone.page);
      const wide = (await shownBars(desktop.page)).shown;
      const narrow = (await shownBars(phone.page)).shown;
      assert.ok(wide >= 100, `desktop shows ${wide} bars`);
      assert.ok(narrow < 60 && narrow >= 8, `phone shows ${narrow} bars`);
    } finally {
      await dispose(desktop.app, desktop.context);
      await dispose(phone.app, phone.context);
    }
  });

  it('keeps every button at least 24px tall for touch', async () => {
    const { page, app, context } = await connected({}, { width: 390, height: 844 });
    try {
      await waitForCandles(page);
      const heights = await page.locator('.chart button').evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: button.textContent ?? '',
          height: button.getBoundingClientRect().height,
        })),
      );
      for (const entry of heights)
        assert.ok(entry.height >= 24, `"${entry.label}" is ${entry.height}px tall`);
    } finally {
      await dispose(app, context);
    }
  });
});
