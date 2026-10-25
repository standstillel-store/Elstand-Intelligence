import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allRules, colorToken, readStyle, styleFileNames, tokens, varsIn } from '../support/css.js';

/** The brand palette from the product brief, exactly. */
const BRAND_PALETTE: ReadonlyArray<readonly [name: string, hex: string]> = [
  ['--bg', '#070907'],
  ['--surface', '#0d120f'],
  ['--surface-2', '#121a15'],
  ['--border', '#243329'],
  ['--green-muted', '#4a805b'],
  ['--neon', '#8cff4d'],
  ['--text', '#e8f0e9'],
  ['--text-2', '#89968c'],
  ['--down', '#ff626c'],
];

describe('the palette', () => {
  for (const [name, hex] of BRAND_PALETTE) {
    it(`${name} is ${hex}`, () => {
      assert.equal(colorToken(name), hex);
    });
  }

  it('adds exactly one color to the brand palette, --caution, and says why in tokens.css', () => {
    const brand = new Set(BRAND_PALETTE.map(([name]) => name));
    const colors = [...tokens().entries()]
      .filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value))
      .map(([name]) => name)
      .filter((name) => !brand.has(name));
    assert.deepEqual(colors, ['--caution']);
    assert.match(
      readStyle('tokens.css'),
      /Added for two states the brand palette has no color for/,
    );
  });

  it('never uses --caution for price movement: only up and down colors mark direction', () => {
    const offenders = allRules()
      .filter((rule) => /\[data-dir/.test(rule.selector))
      .filter((rule) =>
        rule.declarations.some((declaration) => varsIn(declaration.value).includes('--caution')),
      )
      .map((rule) => rule.selector);
    assert.deepEqual(offenders, []);
  });

  it('declares every color in tokens.css and nowhere else: no hex, rgb or hsl literal in any other stylesheet', () => {
    const offenders: string[] = [];
    for (const name of styleFileNames()) {
      if (name === 'tokens.css') continue;
      const source = readStyle(name).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of source.matchAll(
        /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi,
      )) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('refers only to tokens that exist, unless it gives a fallback for a value the script sets per element', () => {
    const known = new Set(tokens().keys());
    const missing: string[] = [];
    for (const rule of allRules()) {
      for (const declaration of rule.declarations) {
        // `var(--name)` with no fallback must name a token. `var(--depth, 0%)` is the one form
        // that is allowed to name something else: the depth bars get --depth from the script.
        for (const match of declaration.value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
          const used = match[1] ?? '';
          if (!known.has(used)) missing.push(`${rule.file}: ${rule.selector} uses ${used}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('keeps per-element properties to the one the depth bars set, and gives it a fallback', () => {
    const withFallback = new Set<string>();
    const known = new Set(tokens().keys());
    for (const rule of allRules()) {
      for (const declaration of rule.declarations) {
        for (const match of declaration.value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/gi)) {
          if (!known.has(match[1] ?? '')) withFallback.add(match[1] ?? '');
        }
      }
    }
    assert.deepEqual([...withFallback], ['--depth']);
  });
});

/**
 * Where the neon accent may appear. The brief reserves it for the active navigation item, the
 * selected instrument, important interactions and verified positive states. Every use today is
 * listed with the reason; adding a new one means editing this list on purpose.
 */
const NEON_USES: ReadonlyArray<readonly [use: string, reason: string]> = [
  // Interaction and focus.
  ['base.css | :focus-visible | outline', 'keyboard focus ring'],
  ['base.css | .skip-link | border', 'skip link, visible only on keyboard focus'],
  ["components.css | .btn[aria-pressed='true'] | border-color", 'toggled button'],
  ["components.css | .btn[aria-pressed='true'] | color", 'toggled button'],
  ["components.css | .seg__btn[aria-pressed='true'] | color", 'selected timeframe'],
  ["components.css | .seg__btn[aria-pressed='true'] | box-shadow", 'selected timeframe underline'],
  [
    "macro.css | .bubble[aria-pressed='true'] .bubble__dot, .bubble:focus-visible .bubble__dot, .bubble:hover .bubble__dot | stroke",
    'selected, focused or hovered bubble ring',
  ],
  // Navigation and selection.
  ["layout.css | .nav__link[aria-current='page'] | color", 'active navigation item'],
  ["layout.css | .nav__link[aria-current='page'] | border-bottom-color", 'active navigation item'],
  ["components.css | .tabs__tab[aria-current='page'] | color", 'active macro tab'],
  ["components.css | .tabs__tab[aria-current='page'] | border-bottom-color", 'active macro tab'],
  ["components.css | .wl__row[aria-current='true'] | border-left-color", 'selected instrument'],
  ["components.css | .wl__row[aria-current='true'] .wl__sym | color", 'selected instrument'],
  ["layout.css | .chip__value[data-tone='selected'] | color", 'selected instrument in the header'],
  // Verified positive states.
  ["components.css | .badge[data-state='live'] | color", 'data verified live'],
  ["components.css | .badge[data-state='live'] | border-color", 'data verified live'],
  [
    "components.css | [data-dir][data-verified='true'][data-dir='up'] | color",
    'a verified price rise',
  ],
  [
    "elvoid.css | .elvoid__state[data-status='RESULT_AVAILABLE'] | color",
    'an ELVOID result is available',
  ],
  [
    "elvoid.css | .elvoid__conclusion[data-state='VALIDATED'] strong | color",
    'an ELVOID conclusion passed validation',
  ],
  [
    "elvoid.css | .module__status[data-status='implemented'] | color",
    'a module that is implemented',
  ],
  // Identity.
  ['layout.css | .brand__bar-a | fill', 'the mark'],
];

describe('the neon accent', () => {
  it('appears only in the places listed above', () => {
    const found = allRules().flatMap((rule) =>
      rule.declarations
        .filter((declaration) => varsIn(declaration.value).includes('--neon'))
        .map((declaration) => `${rule.file} | ${rule.selector} | ${declaration.property}`),
    );
    assert.deepEqual([...found].sort(), NEON_USES.map(([use]) => use).sort());
  });

  it('is never a background or a fill behind text', () => {
    const offenders = allRules().flatMap((rule) =>
      rule.declarations
        .filter(
          (declaration) =>
            /^background/.test(declaration.property) &&
            varsIn(declaration.value).includes('--neon'),
        )
        .map(() => `${rule.file}: ${rule.selector}`),
    );
    assert.deepEqual(offenders, []);
  });

  it('every listed use has a reason', () => {
    for (const [use, reason] of NEON_USES) assert.ok(reason.length > 3, use);
  });
});

describe('the interface stays a workstation, not a landing page', () => {
  const declarations = allRules().flatMap((rule) =>
    rule.declarations.map((declaration) => ({
      ...declaration,
      selector: rule.selector,
      file: rule.file,
    })),
  );

  it('uses no gradients in stylesheets', () => {
    assert.deepEqual(
      declarations
        .filter((d) => /gradient\(/i.test(d.value))
        .map((d) => `${d.file}: ${d.selector}`),
      [],
    );
  });

  it('uses no blur, glow or text shadow', () => {
    assert.deepEqual(
      declarations
        .filter(
          (d) =>
            /backdrop-filter|^filter$|text-shadow/.test(d.property) || /\bblur\(/.test(d.value),
        )
        .map((d) => `${d.file}: ${d.selector} { ${d.property} }`),
      [],
    );
  });

  it('has one box shadow, the selected-timeframe underline, and no soft drop shadows', () => {
    const shadows = declarations.filter((d) => d.property === 'box-shadow');
    assert.deepEqual(
      shadows.map((d) => d.value),
      ['inset 0 -2px 0 var(--neon)'],
    );
  });

  it('has no animation or transition: nothing moves to look busy', () => {
    assert.deepEqual(
      declarations
        .filter((d) => /^(animation|transition)/.test(d.property))
        .map((d) => `${d.file}: ${d.selector}`),
      [],
    );
    assert.doesNotMatch(readStyle('base.css') + readStyle('components.css'), /@keyframes/);
  });

  it('rounds only the status dot', () => {
    const rounded = declarations.filter((d) => d.property === 'border-radius' && d.value !== '0');
    assert.deepEqual(
      rounded.map((d) => `${d.selector} { border-radius: ${d.value} }`),
      ['.badge::before { border-radius: 50% }'],
    );
  });

  it('sets numbers in the monospace face wherever it matters: the font tokens exist and are used', () => {
    const fontFamilies = new Set(
      declarations.filter((d) => d.property === 'font-family').map((d) => d.value),
    );
    assert.deepEqual([...fontFamilies].sort(), ['var(--font-mono)', 'var(--font-sans)']);
    assert.match(tokens().get('--font-mono') ?? '', /monospace/);
  });
});
