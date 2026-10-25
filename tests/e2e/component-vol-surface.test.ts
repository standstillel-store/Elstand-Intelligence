import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { fixtureSurfaceLarge } from '../support/fixtures.js';
import { startComponentHarness, type ComponentHarness } from './support/component.js';
import type { HarnessSpec } from './support/component-harness/spec.js';
import type { PageOptions, WatchedPage } from './support/harness.js';
import { auditBasics, emptyAriaStates, envBlock, text } from './support/page-helpers.js';
import {
  cameraOf,
  settled,
  surfaceInk,
  SURFACE_CANVAS,
  waitForSurface,
} from './support/surface-helpers.js';

/**
 * The implied-volatility surface with an options provider connected. Production Phase 1 has no
 * options adapter (its Macro page says ENV NOT CONNECTION, which the real-server suite checks), so
 * every surface here is a TEST FIXTURE served only by the test-only component harness, under
 * the production Content-Security-Policy. The numbers are not market data.
 */

let harness: ComponentHarness;
before(async () => {
  harness = await startComponentHarness();
});
after(async () => {
  await harness.close();
});

const PANEL = '#vol-surface-panel';
const HASH = '#/macro/vol-surface';
const FIXTURE = fixtureSurfaceLarge('EURUSD');

async function withSurface(
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

async function canvasCenter(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(SURFACE_CANVAS).boundingBox();
  assert.ok(box, 'the surface canvas has a box');
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    width: box.width,
    height: box.height,
  };
}

async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const center = await canvasCenter(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + dx, center.y + dy, { steps: 6 });
  await page.mouse.up();
}

const DEGREES = 180 / Math.PI;
const near = (actual: number, expected: number, tolerance: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
};

/** `String(Number(value.toPrecision(4)))`, the way the page prints a strike value. */
const strikeText = (value: number): string => String(Number(value.toPrecision(4)));

const ivRange = (() => {
  const all = FIXTURE.iv.flat();
  return { min: Math.min(...all), max: Math.max(...all) };
})();

describe('vol surface: a validated surface from a connected provider', () => {
  it('states what it shows: underlying, source, observation time, axis kind and grid size', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      assert.equal(await page.locator(`${PANEL} .macro__state`).isVisible(), false);
      const facts = await text(page, `${PANEL} .macro__facts`);
      assert.match(facts, /Underlying EUR\/USD/);
      assert.match(facts, /Source test fixture, not market data/);
      assert.match(facts, /Observed 2026-01-06 11:59 UTC · 1m 00s ago/);
      assert.match(facts, /Strike axis log-moneyness, ln\(K\/F\) · ln\(K\/F\)/);
      assert.match(facts, /Grid 5 expiries \(7–365 days\) by 7 points/);
      assert.equal(await text(page, `${PANEL} .panel__meta`), 'test fixture, not market data DLY');
      assert.equal(
        await page.locator(`${PANEL} .panel__meta .badge`).getAttribute('data-state'),
        'delayed',
      );
    });
  });

  it('prints the two ends of the color scale, which are the lowest and highest values on the surface', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const legend = await text(page, `${PANEL} .scale`);
      assert.match(
        legend,
        new RegExp(
          `^${ivRange.min.toFixed(2)}% .*${ivRange.max.toFixed(2)}% implied volatility on this surface$`,
        ),
      );
      // The ends are real values from the grid, not rounded axis limits.
      assert.ok(FIXTURE.iv.flat().includes(ivRange.min));
      assert.ok(FIXTURE.iv.flat().includes(ivRange.max));
    });
  });

  it('paints the surface faces on the canvas, in the ramp colors, inside the canvas', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const ink = await settled(page);
      assert.ok(ink.ramp > 2_000, `ramp-colored pixels: ${ink.ramp}`);
      assert.ok(ink.box !== null);
      const canvas = await page.locator(SURFACE_CANVAS).evaluate((node) => {
        const element = node as HTMLCanvasElement;
        return { width: element.width, height: element.height };
      });
      assert.ok(ink.box.x0 >= 0 && ink.box.y0 >= 0, 'nothing is drawn before the canvas edge');
      assert.ok(
        ink.box.x1 < canvas.width && ink.box.y1 < canvas.height,
        'nothing is clipped by the canvas edge',
      );
      assert.ok(ink.ramp < ink.total * 0.6, 'the surface does not flood the canvas');
    });
  });

  it('describes itself to assistive technology with the grid and the value range', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const canvas = page.locator(SURFACE_CANVAS);
      assert.equal(await canvas.getAttribute('role'), 'application');
      assert.equal(await canvas.getAttribute('tabindex'), '0');
      assert.equal(
        await canvas.getAttribute('aria-label'),
        `Implied volatility surface for EUR/USD. 5 expiries by 7 points on ln(K/F). Implied volatility from ${ivRange.min.toFixed(2)}% to ${ivRange.max.toFixed(2)}%. Drag or use the arrow keys to rotate. The data table lists every value.`,
      );
      const describedBy = await canvas.getAttribute('aria-describedby');
      assert.ok(describedBy !== null);
      assert.match(await text(page, `#${describedBy}`), /Drag to rotate/);
    });
  });

  it('lists every value in a data table that matches the provider’s grid exactly', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await page.locator(`${PANEL} details.disclosure summary`).click();
      await page.waitForSelector(`${PANEL} table.tbl tbody tr`);
      const header = await page.$$eval(`${PANEL} table.tbl thead th`, (cells) =>
        cells.map((cell) => cell.textContent),
      );
      assert.deepEqual(header, ['Days to expiry', ...FIXTURE.strikeAxis.values.map(strikeText)]);
      const rows = await page.$$eval(`${PANEL} table.tbl tbody tr`, (trs) =>
        trs.map((tr) => Array.from(tr.children).map((cell) => cell.textContent)),
      );
      assert.deepEqual(
        rows,
        FIXTURE.expiriesDays.map((days, row) => [
          String(days),
          ...(FIXTURE.iv[row] ?? []).map((value) => value.toFixed(2)),
        ]),
      );
      assert.equal(
        await page.locator(`${PANEL} table.tbl caption`).textContent(),
        'Implied volatility in percent by expiry and ln(K/F)',
      );
    });
  });

  it('explains its encoding next to the chart: axes, color, a vertical axis that does not start at zero, no smoothing', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const spec = await text(page, `${PANEL} .spec`);
      assert.match(spec, /Front to back: days to expiry, shortest at the front/);
      assert.match(spec, /does not start at zero/);
      assert.match(spec, /Nothing is smoothed, interpolated or extrapolated/);
      assert.match(spec, /FX options are quoted by delta, not strike/);
    });
  });
});

describe('vol surface: the camera', () => {
  it('starts at the documented default view', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      assert.deepEqual(await cameraOf(page), { yaw: -37.2, pitch: 28.6, zoom: 1 });
    });
  });

  it('turns when dragged, by an amount that follows the pointer, and repaints', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const before = await settled(page);
      await drag(page, 120, 0);
      const camera = await cameraOf(page);
      near(camera.yaw, -37.2 + 120 * 0.009 * DEGREES, 1.5, 'yaw after a 120px drag');
      assert.equal(camera.pitch, 28.6, 'a horizontal drag leaves the elevation alone');
      const after = await settled(page);
      assert.notEqual(after.hash, before.hash, 'the picture changed');
      assert.ok(after.ramp > 2_000, 'and it is still a surface');
    });
  });

  it('tilts when dragged vertically, and stops at the floor and at the top', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await drag(page, 0, -200);
      assert.equal(
        (await cameraOf(page)).pitch,
        6.9,
        'pitch stops at the lowest elevation, 0.12 rad',
      );
      await drag(page, 0, 400);
      assert.equal(
        (await cameraOf(page)).pitch,
        77.3,
        'pitch stops at the highest elevation, 1.35 rad',
      );
    });
  });

  it('is a real projection: seen from above the surface covers more of the canvas height than seen from the side', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await drag(page, 0, 400);
      const above = await settled(page);
      await drag(page, 0, -400);
      const side = await settled(page);
      assert.ok(above.box !== null && side.box !== null);
      const heightAbove = above.box.y1 - above.box.y0;
      const heightSide = side.box.y1 - side.box.y0;
      assert.ok(
        heightAbove > heightSide * 1.3,
        `from above ${heightAbove}px tall, from the side ${heightSide}px`,
      );
    });
  });

  it('leaves a plain wheel to the page, which keeps scrolling, and claims only Ctrl + wheel', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const prevented = await page.locator(SURFACE_CANVAS).evaluate((node) => {
        const plain = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
        node.dispatchEvent(plain);
        const withCtrl = new WheelEvent('wheel', {
          deltaY: 0,
          ctrlKey: true,
          cancelable: true,
          bubbles: true,
        });
        node.dispatchEvent(withCtrl);
        const withMeta = new WheelEvent('wheel', {
          deltaY: 0,
          metaKey: true,
          cancelable: true,
          bubbles: true,
        });
        node.dispatchEvent(withMeta);
        return {
          plain: plain.defaultPrevented,
          withCtrl: withCtrl.defaultPrevented,
          withMeta: withMeta.defaultPrevented,
        };
      });
      assert.deepEqual(prevented, { plain: false, withCtrl: true, withMeta: true });
      assert.equal(
        (await cameraOf(page)).zoom,
        1,
        'a plain wheel does not zoom, and a zero-distance wheel does not either',
      );
    });
  });

  it('zooms in a real browser with Ctrl + wheel, in proportion to how far the wheel turns', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const center = await canvasCenter(page);
      await page.mouse.move(center.x, center.y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (selector) => Number(document.querySelector(selector)?.getAttribute('data-zoom')) > 1.5,
        SURFACE_CANVAS,
        { timeout: 5_000 },
      );
      // exp(200 × 0.0022) = 1.55
      near((await cameraOf(page)).zoom, 1.55, 0.02, 'zoom after Ctrl + wheel up by 200');
    });
  });

  it('zooms with the buttons in fixed steps, stays within 0.5 and 3, and resets', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await page.getByRole('button', { name: 'Zoom in' }).click();
      assert.equal((await cameraOf(page)).zoom, 1.25);
      await page.getByRole('button', { name: 'Zoom out' }).click();
      assert.equal((await cameraOf(page)).zoom, 1);
      for (let i = 0; i < 12; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click();
      assert.equal((await cameraOf(page)).zoom, 3, 'the closest view');
      for (let i = 0; i < 20; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
      assert.equal((await cameraOf(page)).zoom, 0.5, 'the widest view');
      await drag(page, 80, -40);
      await page.getByRole('button', { name: 'Reset view' }).click();
      assert.deepEqual(await cameraOf(page), { yaw: -37.2, pitch: 28.6, zoom: 1 });
    });
  });

  it('rotates and zooms from the keyboard once the canvas has focus, and resets with 0', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await page.locator(SURFACE_CANVAS).focus();
      await page.keyboard.press('ArrowLeft');
      near((await cameraOf(page)).yaw, -37.2 - 0.08 * DEGREES, 0.2, 'yaw after one ArrowLeft');
      await page.keyboard.press('Shift+ArrowRight');
      near(
        (await cameraOf(page)).yaw,
        -37.2 - 0.08 * DEGREES + 0.24 * DEGREES,
        0.2,
        'yaw after Shift + ArrowRight',
      );
      await page.keyboard.press('ArrowUp');
      near((await cameraOf(page)).pitch, 28.6 + 0.08 * DEGREES, 0.2, 'pitch after ArrowUp');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      near((await cameraOf(page)).pitch, 28.6 - 0.08 * DEGREES, 0.2, 'pitch after two ArrowDown');
      await page.keyboard.press('+');
      assert.equal((await cameraOf(page)).zoom, 1.25);
      await page.keyboard.press('-');
      assert.equal((await cameraOf(page)).zoom, 1);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('0');
      assert.deepEqual(await cameraOf(page), { yaw: -37.2, pitch: 28.6, zoom: 1 });
    });
  });

  it('leaves the keyboard to the page when a modifier is held, so browser shortcuts still work', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await page.locator(SURFACE_CANVAS).focus();
      const handled = await page.locator(SURFACE_CANVAS).evaluate((node) => {
        const event = new KeyboardEvent('keydown', {
          key: '+',
          ctrlKey: true,
          cancelable: true,
          bubbles: true,
        });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(handled, false);
      assert.equal((await cameraOf(page)).zoom, 1);
    });
  });

  it('resets on double-click', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await drag(page, 100, 60);
      assert.notDeepEqual(await cameraOf(page), { yaw: -37.2, pitch: 28.6, zoom: 1 });
      const center = await canvasCenter(page);
      await page.mouse.dblclick(center.x, center.y);
      assert.deepEqual(await cameraOf(page), { yaw: -37.2, pitch: 28.6, zoom: 1 });
    });
  });

  it('switches expiry spacing between calendar days and equal steps, and repaints', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const calendar = page.locator(`${PANEL} .seg__btn[data-spacing="calendar"]`);
      const equal = page.locator(`${PANEL} .seg__btn[data-spacing="equal"]`);
      assert.equal(await calendar.getAttribute('aria-pressed'), 'true');
      assert.equal(await equal.getAttribute('aria-pressed'), 'false');
      const before = await settled(page);
      await equal.click();
      assert.equal(await equal.getAttribute('aria-pressed'), 'true');
      assert.equal(await calendar.getAttribute('aria-pressed'), 'false');
      const after = await settled(page);
      assert.notEqual(after.hash, before.hash, 'equal steps place the expiries differently');
      await calendar.click();
      assert.equal(
        (await settled(page)).hash,
        before.hash,
        'back to calendar days restores the same picture',
      );
    });
  });
});

describe('vol surface: reading a value', () => {
  /** Moves across the canvas until the tooltip appears; returns where. */
  async function hoverSomeVertex(page: Page): Promise<void> {
    const center = await canvasCenter(page);
    const tip = page.locator(`${PANEL} .surface3d__tip`);
    for (let radius = 0; radius <= 220; radius += 12) {
      for (let angle = 0; angle < 360; angle += 30) {
        const x = center.x + radius * Math.cos((angle * Math.PI) / 180);
        const y = center.y + radius * Math.sin((angle * Math.PI) / 180);
        await page.mouse.move(x, y);
        if (await tip.isVisible()) return;
      }
    }
    assert.fail('no vertex was found under the pointer');
  }

  it('shows the exact implied volatility, strike and expiry of the point under the pointer', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await hoverSomeVertex(page);
      const tip = await text(page, `${PANEL} .surface3d__tip`);
      const match = /^IV (\d+\.\d\d)% ln\(K\/F\) (-?[\d.]+) (\d+) days to expiry$/.exec(tip);
      assert.ok(match, `tooltip text: "${tip}"`);
      const [, iv, strike, days] = match;
      const row = FIXTURE.expiriesDays.indexOf(Number(days));
      const col = FIXTURE.strikeAxis.values.findIndex((value) => strikeText(value) === strike);
      assert.ok(row >= 0 && col >= 0, `${days} days and strike ${strike} are on the grid`);
      assert.equal(iv, (FIXTURE.iv[row]?.[col] ?? Number.NaN).toFixed(2));
    });
  });

  it('rings the vertex it reports, and drops the tooltip when the pointer leaves or Escape is pressed', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await hoverSomeVertex(page);
      await page.waitForFunction(
        (selector) => {
          const canvas = document.querySelector<HTMLCanvasElement>(selector);
          if (canvas === null) return false;
          const scratch = document.createElement('canvas');
          scratch.width = canvas.width;
          scratch.height = canvas.height;
          const context = scratch.getContext('2d', { willReadFrequently: true });
          if (context === null) return false;
          context.drawImage(canvas, 0, 0);
          const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
          for (let i = 0; i < data.length; i += 4) {
            // The highlight ring is the neon token, #8CFF4D.
            if (
              Math.abs((data[i] ?? 0) - 140) < 8 &&
              (data[i + 1] ?? 0) > 245 &&
              Math.abs((data[i + 2] ?? 0) - 77) < 12
            )
              return true;
          }
          return false;
        },
        SURFACE_CANVAS,
        { timeout: 5_000 },
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page.locator(`${PANEL} .surface3d__tip`).isVisible(),
        true,
        'Escape only acts on the focused canvas',
      );
      await page.locator(SURFACE_CANVAS).focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator(`${PANEL} .surface3d__tip`).isVisible(), false);
      await hoverSomeVertex(page);
      await page.mouse.move(2, 2);
      assert.equal(
        await page.locator(`${PANEL} .surface3d__tip`).isVisible(),
        false,
        'the tooltip leaves with the pointer',
      );
    });
  });

  it('keeps the tooltip inside the canvas', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      await hoverSomeVertex(page);
      const boxes = await page.evaluate(() => {
        const tip = document
          .querySelector('#vol-surface-panel .surface3d__tip')
          ?.getBoundingClientRect();
        const host = document
          .querySelector('#vol-surface-panel .surface3d')
          ?.getBoundingClientRect();
        return tip === undefined || host === undefined
          ? null
          : { tip: tip.toJSON(), host: host.toJSON() };
      });
      assert.ok(boxes !== null);
      assert.ok(boxes.tip.left >= boxes.host.left - 1 && boxes.tip.right <= boxes.host.right + 1);
      assert.ok(boxes.tip.top >= boxes.host.top - 1 && boxes.tip.bottom <= boxes.host.bottom + 1);
    });
  });
});

describe('vol surface: choosing the underlying', () => {
  const underlyingShown = (page: Page): Promise<string | null> =>
    page.locator(`${PANEL} .macro__facts dd`).first().textContent();

  it('asks the provider for the chosen instrument and shows that instrument’s surface', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      assert.equal(await underlyingShown(page), 'EUR/USD');
      await page.locator(`${PANEL} #surface-underlying`).selectOption('GBPUSD');
      await page.waitForFunction(
        () =>
          document.querySelector('#vol-surface-panel .macro__facts dd')?.textContent === 'GBP/USD',
        undefined,
        { timeout: 5_000 },
      );
      await waitForSurface(page);
      assert.match(
        (await page.locator(SURFACE_CANVAS).getAttribute('aria-label')) ?? '',
        /^Implied volatility surface for GBP\/USD\./,
      );
    });
  });

  it('follows the instrument selected on the Forex page when the Macro page opens', async () => {
    await withSurface({ surface: 'available', hash: '#/forex/GBPUSD/H1' }, async ({ page }) => {
      await page.waitForSelector('.wl__row[data-instrument="GBPUSD"]');
      await page.getByRole('link', { name: 'Macro Intelligence' }).first().click();
      await page.waitForSelector(`${PANEL} .macro__facts`);
      assert.equal(await underlyingShown(page), 'GBP/USD');
      assert.equal(await page.locator(`${PANEL} #surface-underlying`).inputValue(), 'GBPUSD');
    });
  });
});

describe('vol surface: data that is old, wrong or missing', () => {
  it('labels a surface older than its freshness limit STALE and says not to treat it as current', async () => {
    await withSurface({ surface: 'stale' }, async ({ page }) => {
      await waitForSurface(page);
      assert.equal(await text(page, `${PANEL} .panel__meta .badge`), 'STALE');
      const notice = page.locator(`${PANEL} .macro__plot .notice`);
      assert.equal(await notice.isVisible(), true);
      assert.match(
        await notice.innerText(),
        /STALE\s+This surface is older than the freshness limit for its feed\. Do not treat it as current\./,
      );
      assert.match(
        await text(page, `${PANEL} .macro__facts`),
        /Observed 2026-01-06 09:00 UTC · 3h 00m ago/,
      );
    });
  });

  it('turns STALE as the clock advances past the limit, with no new request', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      assert.equal(await page.locator(`${PANEL} .macro__plot .notice`).isVisible(), false);
      await page.evaluate(() => window.__harness?.advance(2 * 3_600_000));
      await page.waitForFunction(
        () =>
          document.querySelector('#vol-surface-panel .panel__meta .badge')?.textContent === 'STALE',
        undefined,
        { timeout: 5_000 },
      );
      assert.equal(await page.locator(`${PANEL} .macro__plot .notice`).isVisible(), true);
    });
  });

  it('rejects a surface whose expiries are out of order, and draws nothing', async () => {
    await withSurface({ surface: 'invalid' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      const notice = await text(page, `${PANEL} .macro__state`);
      assert.match(
        notice,
        /SURFACE REJECTED The provider returned a surface that failed validation: expiry axis must be positive, finite and strictly ascending\. It is not drawn\./,
      );
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
      assert.equal(await page.locator(`${PANEL} .panel__meta .badge`).isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'Zoom in' }).isDisabled(), true);
    });
  });

  it('rejects a surface that belongs to another instrument', async () => {
    await withSurface({ surface: 'wrong-instrument' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.match(
        await text(page, `${PANEL} .macro__state`),
        /SURFACE REJECTED The provider returned a surface that failed validation: it describes USDJPY, not EURUSD\. It is not drawn\./,
      );
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
      // Choosing the instrument the provider actually answered with makes the same surface valid.
      await page.locator(`${PANEL} #surface-underlying`).selectOption('USDJPY');
      await waitForSurface(page);
      const terms = await page.$$eval(`${PANEL} .macro__facts dd`, (nodes) =>
        nodes.map((node) => node.textContent),
      );
      assert.equal(terms[0], 'USD/JPY');
    });
  });

  it('says SURFACE FAILED when the provider is unreachable, and keeps offering Retry', async () => {
    await withSurface({ surface: 'error' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.match(
        await text(page, `${PANEL} .macro__state`),
        /SURFACE FAILED The fixture options feed is unreachable\./,
      );
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.waitForSelector(`${PANEL} .notice[data-tone="down"]`);
      assert.equal(await page.getByRole('button', { name: 'Retry' }).isVisible(), true);
    });
  });

  it('shows a loading line while the provider has not answered, and no surface', async () => {
    await withSurface({ surface: 'pending' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .macro__state .notice`);
      assert.equal(
        await text(page, `${PANEL} .macro__state`),
        'Loading the volatility surface for EUR/USD…',
      );
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
      assert.equal(await page.locator(`${PANEL} .panel__meta .badge`).isVisible(), false);
    });
  });

  it('says ENV NOT CONNECTION, names what is missing and why, and still explains the encoding', async () => {
    await withSurface({ surface: 'unavailable' }, async ({ page }) => {
      await page.waitForSelector(`${PANEL} .env-block`);
      const block = await envBlock(page, PANEL);
      assert.deepEqual(block, {
        label: 'ENV NOT CONNECTION',
        detail: 'An options-data provider is not connected.',
        note: 'No fixture options feed is connected.',
      });
      assert.equal(await page.locator(`${PANEL} .macro__plot`).isVisible(), false);
      assert.equal(
        await page.locator(SURFACE_CANVAS).isVisible(),
        false,
        'no canvas is shown without data',
      );
      assert.equal(await page.getByRole('button', { name: 'Reset view' }).isDisabled(), true);
      assert.equal(
        await page.locator(`${PANEL} .seg__btn[data-spacing="equal"]`).isDisabled(),
        true,
      );
      assert.match(await text(page, `${PANEL} .spec`), /Front to back: days to expiry/);
    });
  });
});

describe('vol surface: layout', () => {
  for (const width of [1440, 1024, 390] as const) {
    it(`fits the page at ${width}px, with a canvas that is drawn at its own size`, async () => {
      await withSurface(
        { surface: 'available' },
        async ({ page }) => {
          await waitForSurface(page);
          const measure = await page.evaluate((selector) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector);
            const panel = document.getElementById('vol-surface-panel');
            if (canvas === null || panel === null) return null;
            const box = canvas.getBoundingClientRect();
            const panelBox = panel.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              canvasWidth: box.width,
              canvasHeight: box.height,
              bitmapWidth: canvas.width,
              bitmapHeight: canvas.height,
              inside: box.left >= panelBox.left - 1 && box.right <= panelBox.right + 1,
            };
          }, SURFACE_CANVAS);
          assert.ok(measure !== null);
          assert.ok(measure.overflow <= 0, `the page scrolls sideways by ${measure.overflow}px`);
          assert.ok(measure.inside, 'the canvas stays inside its panel');
          assert.ok(measure.canvasHeight >= 280, `the canvas is ${measure.canvasHeight}px tall`);
          assert.equal(measure.bitmapWidth, Math.round(measure.canvasWidth));
          assert.equal(measure.bitmapHeight, Math.round(measure.canvasHeight));
        },
        { width, height: 900 },
      );
    });
  }

  it('draws at the device’s pixel ratio so the picture is sharp on a dense screen', async () => {
    await withSurface(
      { surface: 'available' },
      async ({ page }) => {
        await waitForSurface(page);
        const sizes = await page.locator(SURFACE_CANVAS).evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          return { client: canvas.clientWidth, bitmap: canvas.width };
        });
        assert.equal(sizes.bitmap, sizes.client * 2);
      },
      { width: 1024, height: 800, deviceScaleFactor: 2 },
    );
  });

  it('repaints at the new size when the window is resized', async () => {
    await withSurface({ surface: 'available' }, async ({ page }) => {
      await waitForSurface(page);
      const wide = await page
        .locator(SURFACE_CANVAS)
        .evaluate((node) => (node as HTMLCanvasElement).width);
      await page.setViewportSize({ width: 600, height: 900 });
      await page.waitForFunction(
        ([selector, previous]) => {
          const canvas = document.querySelector<HTMLCanvasElement>(selector as string);
          return canvas !== null && canvas.width > 0 && canvas.width < (previous as number);
        },
        [SURFACE_CANVAS, wide],
        { timeout: 5_000 },
      );
      await waitForSurface(page);
      const ink = await surfaceInk(page);
      assert.ok(ink.ramp > 1_000, `the surface is still drawn after the resize: ${ink.ramp}px`);
    });
  });
});
