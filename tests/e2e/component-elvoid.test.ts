import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { NOT_CONFIGURED_REASON } from '../../src/elvoid/status.js';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, text } from './support/page-helpers.js';

/**
 * The ELVOID reasoning workspace with an engine connected. Production Phase 1 has no engine
 * (its panel always says NOT CONFIGURED, which the real-server suite checks), so every engine
 * here is a TEST ENGINE served only by the test-only component harness, under the production
 * Content-Security-Policy. Nothing in these results is analysis.
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const PANEL = '#elvoid-panel';
const SECTION_TITLES = [
  'Evidence',
  'Technical context',
  'Macro context',
  'Bullish case',
  'Bearish case',
  'Invalidation',
  'Risks',
  'Final state',
] as const;
const SECTION_KEYS = [
  'evidence',
  'technical',
  'macro',
  'bullish',
  'bearish',
  'invalidation',
  'risks',
  'final',
] as const;

async function withElvoid(
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

const waitForStatus = (page: Page, label: string): Promise<unknown> =>
  page.waitForFunction(
    (expected) => document.querySelector('#elvoid-panel .elvoid__state')?.textContent === expected,
    label,
    { timeout: 10_000 },
  );

const CHIP = 'button.chip[title="Go to the ELVOID reasoning workspace"]';

const waitForChip = (page: Page, label: string): Promise<unknown> =>
  page.waitForFunction(
    ([selector, expected]) =>
      document.querySelector(selector as string)?.textContent?.includes(expected as string) ===
      true,
    [CHIP, label],
    { timeout: 10_000 },
  );

const section = (page: Page, key: (typeof SECTION_KEYS)[number]): Promise<string> =>
  text(page, `${PANEL} [data-section="${key}"] .elvoid__section-body`);

const requests = (page: Page): Promise<readonly { instrumentId: string; timeframe: string }[]> =>
  page.evaluate(() => [...(window.__harness?.requests ?? [])]);

/** The words that would present an opinion as a measurement. None may appear in a result. */
const MEASUREMENT_WORDS =
  /\b(confidence|probability|win ?rate|hit ?rate|accuracy|backtest\w*|sharpe|profit|expected return)\b/i;

describe('ELVOID: a validated result from a connected engine', () => {
  it('shows the status, the instrument, the engine and when it asked and finished', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      assert.equal(
        await text(page, `${PANEL} .elvoid__reason`),
        'Result returned by the engine and validated.',
      );
      const facts = await text(page, `${PANEL} .elvoid__facts`);
      assert.match(facts, /Instrument EUR\/USD · H1/);
      assert.match(facts, /Input data LIVE LIVE/);
      assert.match(facts, /Engine fixture-engine v0\.0\.0-test/);
      assert.match(facts, /Requested 2026-01-06 12:00 UTC/);
      assert.match(facts, /Completed 2026-01-06 12:00 UTC/);
      assert.equal(await text(page, `${PANEL} .panel__meta`), 'engine fixture-engine');
      assert.equal(
        await text(page, `${PANEL} .elvoid__provenance`),
        'analysis analysis-EURUSD-H1 · engine fixture-engine v0.0.0-test',
      );
      assert.equal(await page.locator(`${PANEL} .elvoid__status`).getAttribute('role'), 'status');
      assert.equal(
        await page.locator(`${PANEL} .elvoid__actions`).isVisible(),
        false,
        'no Retry after a result',
      );
    });
  });

  it('fills all eight sections, in reading order, from the engine’s own words', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const titles = await page.$$eval(`${PANEL} .elvoid__section-title`, (nodes) =>
        nodes.map((node) => node.textContent),
      );
      assert.deepEqual(titles, [...SECTION_TITLES]);
      const keys = await page.$$eval(`${PANEL} .elvoid__section`, (nodes) =>
        nodes.map((node) => node.getAttribute('data-section')),
      );
      assert.deepEqual(keys, [...SECTION_KEYS]);

      assert.equal(
        await page.locator(`${PANEL} [data-section="evidence"] .elvoid__item`).count(),
        2,
      );
      assert.match(await section(page, 'technical'), /^Fixture technical context\. Evidence: E1$/);
      assert.match(await section(page, 'macro'), /^Fixture macro context\. Evidence: E2$/);
      assert.match(await section(page, 'bullish'), /^Fixture bullish case\. Evidence: E1$/);
      assert.match(await section(page, 'bearish'), /^Fixture bearish case\. Evidence: E2$/);
      assert.match(
        await section(page, 'invalidation'),
        /^Fixture invalidation condition\. Evidence: E1$/,
      );
      assert.equal(await section(page, 'risks'), 'Fixture risk factor.');
    });
  });

  it('attributes every piece of evidence: id, kind, data state, source and observation time', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const first = page.locator(`${PANEL} [data-evidence="E1"]`);
      const second = page.locator(`${PANEL} [data-evidence="E2"]`);
      assert.match(await first.innerText(), /E1\s+market-data\s+LIVE/i);
      assert.match(await first.innerText(), /Fixture evidence about price\./);
      assert.match(await first.innerText(), /fixture-feed · observed 2026-01-06 11:59 UTC/);
      assert.match(await second.innerText(), /E2\s+macro\s+DLY/i);
      assert.match(await second.innerText(), /fixture-macro · observed 2026-01-06 11:00 UTC/);
      assert.equal(await first.locator('.badge').getAttribute('data-state'), 'live');
      assert.equal(await second.locator('.badge').getAttribute('data-state'), 'delayed');
    });
  });

  it('states what VALIDATED means: it passed structure and evidence checks and is not a forecast', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const final = page.locator(`${PANEL} [data-section="final"]`);
      assert.equal(
        await final.locator('.elvoid__conclusion').getAttribute('data-state'),
        'VALIDATED',
      );
      assert.match(await final.innerText(), /VALIDATED\s+Fixture validated summary\./);
      assert.match(
        await final.innerText(),
        /The result passed Elstand’s structure and evidence checks\. This is not a forecast and it carries no probability, confidence or return\./,
      );
    });
  });

  it('shows WAIT and RESEARCHING as final states with their own plain meaning', async () => {
    await withElvoid({ engine: 'wait' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const final = page.locator(`${PANEL} [data-section="final"]`);
      assert.equal(await final.locator('.elvoid__conclusion').getAttribute('data-state'), 'WAIT');
      assert.match(await final.innerText(), /WAIT\s+Fixture wait summary\./);
      assert.match(await final.innerText(), /ELVOID does not take a view on the evidence it has\./);
    });
    await withElvoid({ engine: 'researching' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const final = page.locator(`${PANEL} [data-section="final"]`);
      assert.equal(
        await final.locator('.elvoid__conclusion').getAttribute('data-state'),
        'RESEARCHING',
      );
      assert.match(await final.innerText(), /ELVOID is still gathering evidence\./);
    });
  });

  it('adds no confidence, probability, win rate, return or backtest of its own', async () => {
    await withElvoid({ engine: 'wait' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const sections = await text(page, `${PANEL} .elvoid__sections`);
      assert.doesNotMatch(sections, MEASUREMENT_WORDS);
      assert.doesNotMatch(sections, /\d+(\.\d+)?\s*%/, 'no percentage is shown in a result');
      const facts = await text(page, `${PANEL} .elvoid__facts`);
      assert.doesNotMatch(facts, MEASUREMENT_WORDS);
    });
  });

  it('asks the engine exactly once for the selected instrument and timeframe', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      assert.deepEqual(await requests(page), [{ instrumentId: 'EURUSD', timeframe: 'H1' }]);
    });
  });

  it('puts the status in the header chip, and the chip takes focus to the workspace', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const chip = page.locator(CHIP);
      assert.match(await chip.innerText(), /ELVOID\s+RESULT AVAILABLE/);
      await chip.click();
      await page.waitForFunction(() => document.activeElement?.id === 'elvoid-panel', undefined, {
        timeout: 5_000,
      });
    });
  });

  it('takes focus to the workspace from another page, by going back to Forex first', async () => {
    await withElvoid({ engine: 'validated', hash: '#/macro/vol-surface' }, async ({ page }) => {
      await waitForChip(page, 'RESULT AVAILABLE');
      const chip = page.locator(CHIP);
      assert.equal(await page.locator(PANEL).count(), 0, 'the workspace is not on the Macro page');
      await chip.click();
      await page.waitForFunction(() => document.activeElement?.id === 'elvoid-panel', undefined, {
        timeout: 5_000,
      });
      assert.match(new URL(page.url()).hash, /^#\/forex\/EURUSD\/H1$/);
    });
  });
});

describe('ELVOID: what the panel does before, during and after a run', () => {
  it('says ANALYZING while the engine works, shows how long, and never shows a result early', async () => {
    await withElvoid({ engine: 'pending' }, async ({ page }) => {
      await waitForStatus(page, 'ANALYZING');
      assert.equal(
        await text(page, `${PANEL} .elvoid__reason`),
        'The engine is working on the selected instrument.',
      );
      assert.match(
        await text(page, `${PANEL} .elvoid__facts`),
        /Requested 2026-01-06 12:00 UTC · running 0s/,
      );
      for (const key of SECTION_KEYS.filter((name) => name !== 'final')) {
        assert.equal(await section(page, key), 'In progress.', `${key} is in progress`);
      }
      assert.equal(await section(page, 'final'), 'No conclusion yet.');
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 0);
      assert.equal(await page.locator(`${PANEL} .elvoid__provenance`).isVisible(), false);
      assert.match(await text(page, `${PANEL} .elvoid__facts`), /Completed —/);

      await page.evaluate(() => window.__harness?.advance(65_000));
      await page.waitForFunction(
        () =>
          /running 1m 05s/.test(
            document.querySelector('#elvoid-panel .elvoid__facts')?.textContent ?? '',
          ),
        undefined,
        { timeout: 5_000 },
      );
    });
  });

  it('moves from ANALYZING to RESULT AVAILABLE when the engine finishes', async () => {
    await withElvoid({ engine: 'pending' }, async ({ page }) => {
      await waitForStatus(page, 'ANALYZING');
      await page.evaluate(() => window.__harness?.release());
      await waitForStatus(page, 'RESULT AVAILABLE');
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 1);
      assert.doesNotMatch(await text(page, `${PANEL} .elvoid__facts`), /running/);
      assert.match(await text(page, CHIP), /RESULT AVAILABLE/);
    });
  });

  it('asks again for each new selection and discards the old result', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      await page.locator('.wl__row[data-instrument="GBPUSD"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('#elvoid-panel .elvoid__provenance')
            ?.textContent?.includes('analysis-GBPUSD-H1') === true,
        undefined,
        { timeout: 10_000 },
      );
      assert.match(await text(page, `${PANEL} .elvoid__facts`), /Instrument GBP\/USD · H1/);
      assert.doesNotMatch(await text(page, PANEL), /analysis-EURUSD-H1/);
      assert.deepEqual(await requests(page), [
        { instrumentId: 'EURUSD', timeframe: 'H1' },
        { instrumentId: 'GBPUSD', timeframe: 'H1' },
      ]);
    });
  });

  it('asks again when the timeframe changes', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      await page.evaluate(() => {
        window.location.hash = '#/forex/EURUSD/H4';
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector('#elvoid-panel .elvoid__provenance')
            ?.textContent?.includes('analysis-EURUSD-H4') === true,
        undefined,
        { timeout: 10_000 },
      );
      assert.match(await text(page, `${PANEL} .elvoid__facts`), /Instrument EUR\/USD · H4/);
      assert.deepEqual(await requests(page), [
        { instrumentId: 'EURUSD', timeframe: 'H1' },
        { instrumentId: 'EURUSD', timeframe: 'H4' },
      ]);
    });
  });

  it('warns that a finished result may no longer describe the market once its inputs go stale', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      assert.equal(
        await page.locator(`${PANEL} .notice`).count(),
        0,
        'no warning while inputs are current',
      );
      await page.evaluate(() => window.__harness?.advance(30 * 60_000));
      await page.waitForSelector(`${PANEL} .notice`, { timeout: 5_000 });
      const warning = await text(page, `${PANEL} .notice`);
      assert.match(warning, /INPUT DATA NOW STALE/);
      assert.match(warning, /This result was completed at 2026-01-06 12:00 UTC\./);
      assert.match(warning, /may no longer describe the market/);
      assert.match(await text(page, `${PANEL} .elvoid__facts`), /Input data STALE STALE/);
      // The result itself stays: it is history, and it is labelled.
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 1);
    });
  });
});

describe('ELVOID: what the panel refuses to show', () => {
  it('shows an engine failure as ERROR with the engine’s message, and every section says nothing was produced', async () => {
    await withElvoid({ engine: 'error' }, async ({ page }) => {
      await waitForStatus(page, 'ERROR');
      assert.equal(await text(page, `${PANEL} .elvoid__reason`), 'Fixture engine failure.');
      for (const key of SECTION_KEYS.filter((name) => name !== 'final')) {
        assert.equal(await section(page, key), 'Not produced. The analysis failed.');
      }
      assert.equal(await section(page, 'final'), 'No conclusion.');
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 0);
      assert.equal(await page.locator(`${PANEL} .elvoid__provenance`).isVisible(), false);
      assert.match(await text(page, CHIP), /ELVOID\s+ERROR/);
    });
  });

  it('runs the engine again on Retry, and shows the result when the second run succeeds', async () => {
    await withElvoid({ engine: 'fail-then-succeed' }, async ({ page }) => {
      await waitForStatus(page, 'ERROR');
      assert.equal(
        await text(page, `${PANEL} .elvoid__reason`),
        'Fixture engine failed on the first try.',
      );
      await page.getByRole('button', { name: 'Retry analysis' }).click();
      await waitForStatus(page, 'RESULT AVAILABLE');
      assert.equal(await page.locator(`${PANEL} .elvoid__actions`).isVisible(), false);
      assert.equal((await requests(page)).length, 2);
    });
  });

  it('stays in ERROR when Retry fails again, and keeps offering Retry', async () => {
    await withElvoid({ engine: 'error' }, async ({ page }) => {
      await waitForStatus(page, 'ERROR');
      await page.getByRole('button', { name: 'Retry analysis' }).click();
      await page.waitForFunction(() => (window.__harness?.requests.length ?? 0) === 2, undefined, {
        timeout: 5_000,
      });
      await waitForStatus(page, 'ERROR');
      assert.equal(await page.getByRole('button', { name: 'Retry analysis' }).isVisible(), true);
    });
  });

  it('rejects a result that carries a confidence figure, and shows none of it', async () => {
    await withElvoid({ engine: 'forbidden-field' }, async ({ page }) => {
      await waitForStatus(page, 'ERROR');
      const reason = await text(page, `${PANEL} .elvoid__reason`);
      assert.match(reason, /^The engine returned a result that failed validation: /);
      assert.match(reason, /confidence/);
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 0);
      assert.equal(
        await page.locator(`${PANEL} [data-evidence]`).count(),
        0,
        'no part of a rejected result is shown',
      );
      assert.doesNotMatch(await text(page, `${PANEL} .elvoid__sections`), /0\.93|93/);
    });
  });

  it('rejects a result that answers a different instrument', async () => {
    await withElvoid({ engine: 'wrong-selection' }, async ({ page }) => {
      await waitForStatus(page, 'ERROR');
      assert.equal(
        await text(page, `${PANEL} .elvoid__reason`),
        'The engine returned a result for a different selection.',
      );
      assert.equal(await page.locator(`${PANEL} .elvoid__conclusion`).count(), 0);
    });
  });
});

describe('ELVOID: the module registry', () => {
  it('lists the thirteen modules with what each takes in, puts out and refuses', async () => {
    await withElvoid({ engine: 'validated' }, async ({ page }) => {
      await waitForStatus(page, 'RESULT AVAILABLE');
      const registry = page.locator(`${PANEL} details[data-role="modules"]`);
      assert.equal(
        await registry.locator('summary').first().textContent(),
        'ELVOID modules · 1 of 13 implemented',
      );
      await registry.locator('summary').first().click();
      assert.equal(await registry.locator('details.module').count(), 13);
      const intro = await registry.locator('.modules__intro').innerText();
      assert.match(intro, /ELVOID does not change itself/);
      assert.match(intro, /approved by a person before it is released/);
      const first = registry.locator('details.module').first();
      await first.locator('summary').click();
      const body = await first.locator('.module__body').innerText();
      assert.match(body, /Takes in/i);
      assert.match(body, /Puts out/i);
      assert.match(body, /Refuses or fails on/i);
      assert.match(body, /Contract in the repository/i);
    });
  });
});

describe('ELVOID: layout', () => {
  for (const width of [1440, 1024, 390] as const) {
    it(`fits a full result without sideways scrolling or clipped text at ${width}px`, async () => {
      await withElvoid(
        { engine: 'validated' },
        async ({ page }) => {
          await waitForStatus(page, 'RESULT AVAILABLE');
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panel: (() => {
              const panel = document.getElementById('elvoid-panel');
              return panel === null ? -1 : panel.scrollWidth - panel.clientWidth;
            })(),
          }));
          assert.ok(overflow.page <= 0, `the page scrolls sideways by ${overflow.page}px`);
          assert.ok(
            overflow.panel <= 0,
            `the panel overflows its own width by ${overflow.panel}px`,
          );
        },
        { width, height: 900 },
      );
    });
  }
});

describe('ELVOID: wording', () => {
  it('uses the contract’s own words for the not-configured reason', () => {
    // The production panel shows this exact sentence when no engine is connected; the
    // real-server suite checks it on screen. Here it only has to stay free of invented claims.
    assert.match(NOT_CONFIGURED_REASON, /No ELVOID engine is connected\./);
    assert.match(NOT_CONFIGURED_REASON, /none is simulated\./);
  });
});
