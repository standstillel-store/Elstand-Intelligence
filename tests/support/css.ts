/**
 * TEST-ONLY helpers that read the real stylesheets in `src/styles/`, so design rules (the
 * palette, contrast, where the accent color may appear) are checked against what ships and not
 * against a copy of it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeLuminance } from '../../src/ui/macro/ramp.js';

export const STYLES_DIR = fileURLToPath(new URL('../../src/styles/', import.meta.url));

export function styleFileNames(): string[] {
  return readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .sort();
}

export function readStyle(name: string): string {
  return readFileSync(join(STYLES_DIR, name), 'utf8');
}

// ---- tokens and contrast --------------------------------------------------------------------

/** The custom properties declared in `tokens.css`, by name including the leading `--`. */
export function tokens(): ReadonlyMap<string, string> {
  const source = readStyle('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map<string, string>();
  for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) map.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return map;
}

/** A token that must be a six-digit hex color, returned lower-case. Throws otherwise. */
export function colorToken(name: string): string {
  const value = tokens().get(name);
  if (value === undefined) throw new Error(`tokens.css does not define ${name}.`);
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${name} is "${value}", not a six-digit hex color.`);
  return value.toLowerCase();
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors, in either order. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---- a small CSS rule reader ------------------------------------------------------------------

export interface CssDeclaration {
  readonly property: string;
  readonly value: string;
}

export interface CssRule {
  readonly file: string;
  readonly selector: string;
  /** Enclosing at-rule preludes, outermost first, such as `@media (min-width: 1100px)`. */
  readonly context: readonly string[];
  readonly declarations: readonly CssDeclaration[];
}

interface Frame {
  readonly selector: string | null;
  readonly context: readonly string[];
  readonly declarations: CssDeclaration[];
}

/**
 * Reads style rules out of a stylesheet: selector, enclosing at-rules and declarations.
 * It understands comments, strings, parentheses and nested blocks (`@media`, `@container`,
 * `@keyframes`), which is what these stylesheets use. It is not a general CSS parser.
 */
export function parseCss(file: string, source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const stack: Frame[] = [{ selector: null, context: [], declarations: [] }];
  let index = 0;

  while (index < text.length) {
    let paren = 0;
    let quote: string | null = null;
    const start = index;
    while (index < text.length) {
      const char = text[index];
      if (quote !== null) {
        if (char === quote && text[index - 1] !== '\\') quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '(') paren += 1;
      else if (char === ')') paren -= 1;
      else if (paren === 0 && (char === '{' || char === ';' || char === '}')) break;
      index += 1;
    }
    const prelude = text.slice(start, index).trim();
    const terminator = text[index];
    index += 1;
    const current = stack[stack.length - 1];
    if (current === undefined) throw new Error(`${file}: unbalanced braces.`);

    if (terminator === '{') {
      if (prelude.startsWith('@')) {
        stack.push({ selector: null, context: [...current.context, prelude], declarations: [] });
      } else {
        const parent = current.selector;
        stack.push({
          selector: parent === null ? prelude : `${parent} ${prelude}`,
          context: current.context,
          declarations: [],
        });
      }
      continue;
    }

    if (prelude !== '' && current.selector !== null) {
      const colon = prelude.indexOf(':');
      if (colon > 0) {
        current.declarations.push({
          property: prelude.slice(0, colon).trim().toLowerCase(),
          value: prelude.slice(colon + 1).trim(),
        });
      }
    }
    if (terminator === '}') {
      const closed = stack.pop();
      if (closed === undefined || stack.length === 0)
        throw new Error(`${file}: unbalanced braces.`);
      if (closed.selector !== null) {
        rules.push({
          file,
          selector: closed.selector.replace(/\s+/g, ' '),
          context: closed.context,
          declarations: closed.declarations,
        });
      }
    }
  }
  if (stack.length !== 1) throw new Error(`${file}: unbalanced braces.`);
  return rules;
}

/** Every rule of every stylesheet in `src/styles/`. */
export function allRules(): CssRule[] {
  return styleFileNames().flatMap((name) => parseCss(name, readStyle(name)));
}

/** The names of the custom properties a value reads, e.g. `1px solid var(--border)` gives `--border`. */
export function varsIn(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? '');
}
