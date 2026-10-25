/**
 * TEST-ONLY. Builds the component harness bundle (fixtures included) into a scratch directory
 * and serves it through the same server and the same vercel.json headers as the product, so
 * the Content-Security-Policy is enforced exactly as in production. Every console error,
 * uncaught exception and failed request lands in `problems`, and tests assert it is empty.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuild } from '../../../scripts/build.js';
import { loadHeaderRules, startServer, type RunningServer } from '../../../scripts/serve.js';
import {
  launchBrowser,
  type BrowserSession,
  type PageOptions,
  type WatchedPage,
} from './harness.js';
import type { HarnessSpec } from './component-harness/spec.js';

const ROOT = new URL('../../..', import.meta.url).pathname;

export interface ComponentHarness {
  readonly url: string;
  readonly session: BrowserSession;
  /** Opens a page, mounts the application with the given fixtures, and waits for the shell. */
  open(spec: HarnessSpec, options?: PageOptions): Promise<WatchedPage>;
  close(): Promise<void>;
}

export async function startComponentHarness(): Promise<ComponentHarness> {
  const outDir = await mkdtemp(join(tmpdir(), 'elstand-harness-'));
  await runBuild({
    rootDir: ROOT,
    outDir,
    entry: 'tests/e2e/support/component-harness/entry.ts',
    htmlTemplate: 'tests/e2e/support/component-harness/index.html',
    publicDir: null,
    minify: false,
    env: {},
    productionGuards: false,
  });
  const rejectingFetch = (async () => {
    throw new Error('The harness server must not call a data vendor.');
  }) as unknown as typeof fetch;
  const server: RunningServer = await startServer({
    rootDir: outDir,
    headerRules: await loadHeaderRules(join(ROOT, 'vercel.json')),
    env: {},
    fetch: rejectingFetch,
  });
  const session = await launchBrowser();
  return {
    url: server.url,
    session,
    async open(spec, options) {
      const watched = await session.newPage(options);
      await watched.page.goto(`${server.url}/index.html`);
      await watched.page.waitForFunction(() => window.__harness !== undefined);
      await watched.page.evaluate((value) => window.__harness?.mount(value), spec);
      await watched.page.waitForSelector('.app');
      return watched;
    },
    async close() {
      await session.close();
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    },
  };
}
