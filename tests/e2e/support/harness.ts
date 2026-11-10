/**
 * TEST-ONLY browser harness. It serves the REAL production bundle from `dist/` through the same
 * server the dev and preview commands use, with a fake vendor behind the API, and drives it with
 * Playwright's Chromium. Run `node scripts/build.ts` first (the `test:e2e` script does).
 */
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadHeaderRules, startServer, type RunningServer } from '../../../scripts/serve.js';
import type { FakeVendor } from '../../support/fake-vendor.js';
import { FIXTURE_NOW } from '../../support/fixtures.js';

const ROOT = new URL('../../..', import.meta.url).pathname;

export interface StartedApp {
  readonly server: RunningServer;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Server environment. Empty (the default) means "no provider connected". */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The fake vendor behind the API. Without one, any vendor call fails the test. */
  readonly vendor?: FakeVendor;
  /** The server's clock. Defaults to the fixed fixture time. */
  readonly now?: () => number;
}

/** A key that is obviously not real. The fake vendor ignores it; the server only needs it set. */
export const TEST_API_KEY = 'test-key-not-a-real-credential';

/**
 * The stand-in vendor has no plan, but the server keeps its own request budget for Twelve Data,
 * which defaults to the free Basic plan (8 credits a minute). This harness freezes the server's
 * clock, so a budget window never slides, and loading the 8-instrument watchlist alone would
 * spend the whole budget. So the tests declare a large plan; the budget itself is tested in
 * tests/unit, and `FREE_PLAN_ENV` below shows what the page says when the real default runs out.
 */
export const CONNECTED_ENV = {
  TWELVE_DATA_API_KEY: TEST_API_KEY,
  TWELVE_DATA_CREDITS_PER_MINUTE: '10000',
  TWELVE_DATA_CREDITS_PER_DAY: '1000000',
} as const;

/** A key and nothing else: the server assumes the free plan's budget, as it does in production. */
export const FREE_PLAN_ENV = {
  TWELVE_DATA_API_KEY: TEST_API_KEY,
} as const;

export async function startApp(options: StartOptions = {}): Promise<StartedApp> {
  const rejectingFetch = (async () => {
    throw new Error('The server tried to reach a data vendor, but this test provided none.');
  }) as unknown as typeof fetch;
  const server = await startServer({
    rootDir: join(ROOT, 'dist'),
    headerRules: await loadHeaderRules(join(ROOT, 'vercel.json')),
    env: options.env ?? {},
    fetch: options.vendor?.fetch ?? rejectingFetch,
    now: options.now ?? (() => FIXTURE_NOW),
  });
  return { server, url: server.url, close: () => server.close() };
}

export interface BrowserSession {
  readonly browser: Browser;
  newPage(options?: PageOptions): Promise<WatchedPage>;
  close(): Promise<void>;
}

export interface PageOptions {
  readonly width?: number;
  readonly height?: number;
  /** Fix the browser clock at the fixture time, so data states are the same on every run. */
  readonly fixedClock?: boolean;
  readonly deviceScaleFactor?: number;
  readonly hasTouch?: boolean;
  /** The browser's own time zone. Defaults to UTC so a test never depends on the machine's zone. */
  readonly timezoneId?: string;
}

/** A page that records everything the product must never do. Tests assert these are empty. */
export interface WatchedPage {
  readonly page: Page;
  readonly context: BrowserContext;
  /** console.error / console.warn text, uncaught exceptions and failed requests. */
  readonly problems: string[];
  /** Every URL the page requested, so tests can prove nothing left the origin. */
  readonly requested: string[];
}

export async function launchBrowser(): Promise<BrowserSession> {
  const browser = await chromium.launch();
  return {
    browser,
    async newPage(options = {}) {
      const context = await browser.newContext({
        viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        hasTouch: options.hasTouch ?? false,
        timezoneId: options.timezoneId ?? 'UTC',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const problems: string[] = [];
      const requested: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          problems.push(`console.${message.type()}: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
      page.on('request', (request) => requested.push(request.url()));
      if (options.fixedClock !== false) await page.clock.setFixedTime(FIXTURE_NOW);
      return { page, context, problems, requested };
    },
    close: () => browser.close(),
  };
}
