import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allRules, colorToken, contrastRatio, varsIn } from '../support/css.js';

/** The three backgrounds anything is drawn on. */
const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;

/** Tokens that carry text. Each must be readable as normal-size text on every background. */
const TEXT_TOKENS = ['--text', '--text-2', '--neon', '--down', '--caution'] as const;

function ratio(foreground: string, background: string): number {
  return contrastRatio(colorToken(foreground), colorToken(background));
}

describe('contrast of the design tokens (WCAG 2)', () => {
  for (const foreground of TEXT_TOKENS) {
    for (const background of BACKGROUNDS) {
      it(`${foreground} is at least 4.5:1 on ${background}`, () => {
        const value = ratio(foreground, background);
        assert.ok(value >= 4.5, `${foreground} on ${background} is ${value.toFixed(2)}:1`);
      });
    }
  }

  it('keeps primary text at 7:1 or better on every background', () => {
    for (const background of BACKGROUNDS) {
      assert.ok(ratio('--text', background) >= 7, background);
    }
  });

  it('keeps the muted green, used for borders, dots and the bubble fill, at 3:1 or better as a graphic', () => {
    for (const background of BACKGROUNDS) {
      const value = ratio('--green-muted', background);
      assert.ok(value >= 3, `--green-muted on ${background} is ${value.toFixed(2)}:1`);
    }
  });

  it('is honest about the muted green: it is below 4.5:1 on some backgrounds, so it must never color text', () => {
    assert.ok(
      BACKGROUNDS.some((background) => ratio('--green-muted', background) < 4.5),
      'if --green-muted now passes as text everywhere, this test and the rule below can be relaxed',
    );
  });

  it('keeps the grid and border color decorative: it is not asked to meet a text ratio', () => {
    assert.ok(ratio('--border', '--bg') < 3);
  });
});

describe('where the stylesheets use color as text', () => {
  const colorDeclarations = allRules().flatMap((rule) =>
    rule.declarations
      .filter((declaration) => declaration.property === 'color')
      .map((declaration) => ({ rule, value: declaration.value })),
  );

  it('finds the declarations (the check below must not pass on an empty list)', () => {
    assert.ok(
      colorDeclarations.length > 30,
      `only ${colorDeclarations.length} color declarations found`,
    );
  });

  it('sets text color only from tokens verified above, or inherits it', () => {
    const allowed = new Set<string>(TEXT_TOKENS);
    const offenders = colorDeclarations
      .filter(({ value }) => {
        const normalized = value.replace(/\s*!important\s*$/, '').trim();
        if (normalized === 'inherit') return false;
        const used = varsIn(normalized);
        return used.length !== 1 || normalized !== `var(${used[0]})` || !allowed.has(used[0] ?? '');
      })
      .map(({ rule, value }) => `${rule.file}: ${rule.selector} { color: ${value} }`);
    assert.deepEqual(offenders, []);
  });

  it('never sets SVG text fill from a token that is not verified as text', () => {
    const allowed = new Set<string>([...TEXT_TOKENS, '--bg']);
    const offenders: string[] = [];
    for (const rule of allRules()) {
      if (!/\btext\b|__label|__glyph|__code|__value/.test(rule.selector)) continue;
      for (const declaration of rule.declarations) {
        if (declaration.property !== 'fill') continue;
        for (const used of varsIn(declaration.value)) {
          if (!allowed.has(used))
            offenders.push(`${rule.file}: ${rule.selector} { fill: ${declaration.value} }`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
