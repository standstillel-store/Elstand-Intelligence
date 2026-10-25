import type { Page } from 'playwright';

/** Theme colors as the canvas holds them, so tests can tell candles from background. */
export const THEME_RGB = {
  bg: [7, 9, 7],
  up: [74, 128, 91],
  down: [255, 98, 108],
} as const;

export interface Ink {
  readonly up: number;
  readonly down: number;
  readonly background: number;
  readonly total: number;
}

/** Counts exact-color pixels on the chart canvas. Candle bodies are solid, so counts are exact. */
export async function canvasInk(page: Page): Promise<Ink> {
  return page.evaluate((rgb) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.chart__canvas');
    if (!canvas || canvas.width === 0) return { up: 0, down: 0, background: 0, total: 0 };
    // Read a copy, never the chart canvas itself: reading back would change how the browser
    // accelerates the real one, and the browser warns about repeated reads.
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (!context) return { up: 0, down: 0, background: 0, total: 0 };
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, scratch.width, scratch.height).data;
    const count = { up: 0, down: 0, background: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r === rgb.up[0] && g === rgb.up[1] && b === rgb.up[2]) count.up += 1;
      else if (r === rgb.down[0] && g === rgb.down[1] && b === rgb.down[2]) count.down += 1;
      else if (r === rgb.bg[0] && g === rgb.bg[1] && b === rgb.bg[2]) count.background += 1;
    }
    return { ...count, total: scratch.width * scratch.height };
  }, THEME_RGB);
}

/** Waits until candles of both directions have been painted. */
export async function waitForCandles(page: Page): Promise<void> {
  await page.waitForFunction(
    (rgb) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.chart__canvas');
      if (!canvas || canvas.hidden || canvas.width === 0) return false;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(0, 0, scratch.width, scratch.height).data;
      let up = 0;
      let down = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === rgb.up[0] && data[i + 1] === rgb.up[1] && data[i + 2] === rgb.up[2])
          up += 1;
        else if (
          data[i] === rgb.down[0] &&
          data[i + 1] === rgb.down[1] &&
          data[i + 2] === rgb.down[2]
        )
          down += 1;
        if (up > 20 && down > 20) return true;
      }
      return false;
    },
    THEME_RGB,
    { timeout: 10_000 },
  );
}

/**
 * Waits until the chart on screen is the given instrument and timeframe, with its bars painted.
 * The canvas label is set only when that selection's series is installed, so unlike a URL check
 * it cannot be satisfied by the previous chart that is still on screen.
 */
export async function waitForChart(page: Page, symbol: string, timeframe: string): Promise<void> {
  await page.waitForSelector(
    `.chart__canvas[aria-label^="${symbol} ${timeframe} candlestick chart"]:not([hidden])`,
    { timeout: 10_000 },
  );
  await waitForCandles(page);
}

export const text = async (page: Page, selector: string): Promise<string> =>
  (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim();

export async function canvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.chart__canvas').boundingBox();
  if (box === null) throw new Error('The chart canvas has no box (it is hidden or detached).');
  return box;
}

/** Number of bars shown, from the status line: "Showing 116 of 500 bars". */
export async function shownBars(page: Page): Promise<{ shown: number; total: number }> {
  const status = await text(page, '.chart__status');
  const match = /Showing (\d+) of (\d+) bars/.exec(status);
  if (match === null) throw new Error(`The status line has no bar count: "${status}"`);
  return { shown: Number(match[1]), total: Number(match[2]) };
}

export interface EnvBlockReading {
  readonly label: string;
  readonly detail: string;
  readonly note: string | null;
}

/**
 * Reads an ENV NOT CONNECTION block inside `scope`. Tests assert the label against the literal
 * words the product owner specified, not against the constant the product itself imports.
 */
export async function envBlock(page: Page, scope: string): Promise<EnvBlockReading | null> {
  const block = page.locator(`${scope} .env-block`).first();
  if ((await block.count()) === 0 || !(await block.isVisible())) return null;
  const read = async (selector: string): Promise<string | null> => {
    const node = block.locator(selector).first();
    return (await node.count()) === 0 ? null : ((await node.textContent()) ?? '').trim();
  };
  return {
    label: (await read('.env-block__label')) ?? '',
    detail: (await read('.env-block__detail')) ?? '',
    note: await read('.env-block__note'),
  };
}

const ARIA_STATES = [
  'aria-pressed',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-hidden',
  'aria-current',
  'aria-busy',
  'aria-disabled',
] as const;

/**
 * Lists every element whose ARIA state attribute is empty. `aria-pressed=""` is what a boolean
 * HTML attribute produces, and assistive technology reads it as "undefined", so a toggle that
 * is on would not be announced as on. The page must have none.
 */
export async function emptyAriaStates(page: Page): Promise<string[]> {
  return page.evaluate((names) => {
    const found: string[] = [];
    for (const name of names) {
      for (const node of Array.from(document.querySelectorAll(`[${name}=""]`))) {
        found.push(
          `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}[${name}]`,
        );
      }
    }
    return found;
  }, ARIA_STATES);
}

/**
 * A small structural audit that needs no library: the page has a language, one h1 and one main
 * landmark, no duplicate ids, no image without alt, and every control that is on screen has an
 * accessible name. It is not a substitute for a full accessibility review (see docs/DESIGN.md),
 * but it catches the regressions that are easiest to introduce.
 */
export async function auditBasics(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.lang.trim() === '') problems.push('the document has no lang');
    const counts = new Map<string, number>();
    for (const node of Array.from(document.querySelectorAll('[id]'))) {
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    }
    for (const [id, count] of counts)
      if (count > 1) problems.push(`id "${id}" is used ${count} times`);

    const nameOf = (node: Element): string => {
      const label = node.getAttribute('aria-label')?.trim();
      if (label !== undefined && label !== '') return label;
      const labelledBy = node.getAttribute('aria-labelledby');
      if (labelledBy !== null) {
        const joined = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (joined !== '') return joined;
      }
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement
      ) {
        const joined = Array.from(node.labels ?? [])
          .map((entry) => entry.textContent ?? '')
          .join(' ')
          .trim();
        if (joined !== '') return joined;
      }
      const content = (node.textContent ?? '').trim();
      if (content !== '') return content;
      return node.getAttribute('title')?.trim() ?? '';
    };
    const selector =
      'button, a[href], select, input, textarea, [role="button"], canvas[role], svg[role]';
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (node.getClientRects().length === 0) continue; // not on screen, so not exposed
      if (nameOf(node) === '') {
        problems.push(
          `${node.tagName.toLowerCase()}.${(node.getAttribute('class') ?? '').split(' ')[0]} has no accessible name`,
        );
      }
    }
    for (const image of Array.from(document.querySelectorAll('img'))) {
      if (!image.hasAttribute('alt')) problems.push('an image has no alt attribute');
    }
    const h1 = document.querySelectorAll('h1').length;
    if (h1 !== 1) problems.push(`expected one h1, found ${h1}`);
    const mains = document.querySelectorAll('main').length;
    if (mains !== 1) problems.push(`expected one main landmark, found ${mains}`);
    return problems;
  });
}
