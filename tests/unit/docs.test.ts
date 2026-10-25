import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULES_DOC_PATH, renderModulesDoc } from '../../scripts/gen-docs.js';
import { ALLOWED_IMPORTS, FILE_EXCEPTIONS } from '../../scripts/lint-policy.js';
import { FAILURE_MEMORY_MS } from '../../server/cache.js';
import {
  DEFAULT_REFRESH_SECONDS,
  ENV_API_KEY,
  ENV_REALTIME,
  ENV_REFRESH,
  MAX_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  STALE_AFTER_MS,
} from '../../server/env.js';
import { httpStatusFor } from '../../server/errors.js';
import { INSTRUMENTS } from '../../src/core/instruments.js';
import { TIMEFRAMES } from '../../src/core/types.js';
import { SURFACE_STALE_AFTER_MS } from '../../src/data/options.js';
import { API_ERROR_CODES, type ApiErrorCode } from '../../src/data/wire.js';
import {
  ANALYSIS_STATUS_LABEL,
  CONCLUSION_STATES,
  EVIDENCE_KINDS,
} from '../../src/elvoid/contracts.js';
import { CHANGE_STAGES, canTransition, type ChangeStage } from '../../src/elvoid/improvement.js';
import { ELVOID_MODULES } from '../../src/elvoid/modules.js';
import { FORBIDDEN_FIELDS } from '../../src/elvoid/validate-result.js';
import { MAX_DEPTH_LEVELS } from '../../src/ui/forex/depth-panel.js';
import { bubbleRadius, layoutBubbles, RADIUS_MIN } from '../../src/ui/macro/bubble-layout.js';
import { RAMP_STOPS } from '../../src/ui/macro/ramp.js';
import { ELVOID_SECTIONS } from '../../src/ui/elvoid/panel.js';
import { colorToken, contrastRatio, tokens } from '../support/css.js';
import { fixtureBubblePoints } from '../support/fixtures.js';

/**
 * The documents state facts that live in code: thresholds, defaults, tables, names. This file is
 * what keeps them honest. A fact in a document that stops matching the code fails here, with the
 * document and the fact named, instead of quietly misleading the next reader.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

function exists(path: string): boolean {
  try {
    statSync(`${ROOT}${path}`);
    return true;
  } catch {
    return false;
  }
}

function listFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${ROOT}${directory}`, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(path));
    else found.push(path);
  }
  return found;
}

function markdownFiles(): string[] {
  const docs = readdirSync(`${ROOT}docs`)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${name}`);
  return ['README.md', ...docs];
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/** The text under a heading of any level, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines: string[] = [];
  let level = 0;
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match !== null) {
      const depth = (match[1] ?? '').length;
      if (level === 0 && (match[2] ?? '') === heading) {
        level = depth;
        continue;
      }
      if (level !== 0 && depth <= level) break;
    }
    if (level !== 0) lines.push(line);
  }
  assert.notEqual(level, 0, `no heading "${heading}"`);
  return lines.join('\n');
}

/** Table rows of a section as trimmed cells, without the header and separator rows. */
function tableRows(sectionText: string): string[][] {
  return sectionText
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))
    .slice(1);
}

const withoutFences = (text: string): string =>
  text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
const withoutCode = (text: string): string => withoutFences(text).replace(/`[^`\n]*`/g, '');

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function slugOf(heading: string): string {
  return heading
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of withoutFences(text).split('\n')) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match === null) continue;
    const base = slugOf(match[1] ?? '');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const ENV_NAME = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
const namesIn = (text: string): string[] =>
  [...text.matchAll(ENV_NAME)].map((match) => match[1] ?? '');
const REAL_ENV = [ENV_API_KEY, ENV_REALTIME, ENV_REFRESH].sort();

describe('the generated module document', () => {
  it('is exactly what the registry produces (run `npm run docs:gen` after changing the registry)', () => {
    assert.equal(
      read(MODULES_DOC_PATH),
      renderModulesDoc(),
      `${MODULES_DOC_PATH} is out of date. Run \`npm run docs:gen\`.`,
    );
  });

  it('points only at contracts that exist, and every module with a status above not-implemented has one', () => {
    for (const module of ELVOID_MODULES) {
      if (module.status === 'not-implemented') {
        assert.equal(
          module.contract,
          null,
          `${module.id} claims to be unbuilt but names a contract`,
        );
        continue;
      }
      assert.notEqual(
        module.contract,
        null,
        `${module.id} is ${module.status} but names no contract`,
      );
      for (const path of (module.contract ?? '').split(',').map((entry) => entry.trim())) {
        assert.ok(exists(path), `${module.id}: ${path} does not exist`);
      }
    }
  });

  it('is the 13 modules the prose says it is', () => {
    assert.equal(ELVOID_MODULES.length, 13);
    for (const file of ['README.md', 'docs/ELVOID.md', MODULES_DOC_PATH]) {
      assert.match(read(file), /\b13 modules\b/, file);
    }
  });
});

describe('links, paths and commands in the documents', () => {
  for (const file of markdownFiles()) {
    it(`${file}: every relative link and anchor resolves`, () => {
      const problems: string[] = [];
      for (const match of withoutCode(read(file)).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const link = match[1] ?? '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
        const [target = '', anchor] = link.split('#');
        const targetPath =
          target === '' ? file : posix.normalize(posix.join(posix.dirname(file), target));
        if (!exists(targetPath)) {
          problems.push(`${link}: ${targetPath} does not exist`);
          continue;
        }
        if (anchor === undefined || anchor === '') continue;
        if (!targetPath.endsWith('.md')) problems.push(`${link}: ${targetPath} is not a document`);
        else if (!anchorsOf(read(targetPath)).has(anchor)) {
          problems.push(`${link}: ${targetPath} has no heading for #${anchor}`);
        }
      }
      assert.deepEqual(problems, []);
    });

    it(`${file}: every repository path in backticks exists, and so does every test file it names`, () => {
      const text = withoutFences(read(file));
      const missing: string[] = [];
      for (const match of text.matchAll(
        /`((?:src|server|api|scripts|tests|docs)\/[A-Za-z0-9_./-]*)`/g,
      )) {
        const path = (match[1] ?? '').replace(/\/$/, '');
        if (!exists(path)) missing.push(path);
      }
      for (const match of text.matchAll(/`([a-z0-9-]+\.test\.ts)`/g)) {
        const name = match[1] ?? '';
        if (!exists(`tests/unit/${name}`) && !exists(`tests/e2e/${name}`)) missing.push(name);
      }
      assert.deepEqual(missing, []);
    });

    it(`${file}: every \`npm run\` command it shows is a script in package.json`, () => {
      const scripts = new Set(
        Object.keys(
          (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
        ),
      );
      const unknown = [...read(file).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)]
        .map((match) => match[1] ?? '')
        .filter((name) => !scripts.has(name));
      assert.deepEqual(unknown, []);
    });
  }

  it('the README links to every document in docs/', () => {
    const readme = read('README.md');
    const unlinked = readdirSync(`${ROOT}docs`)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => !readme.includes(`(docs/${name})`));
    assert.deepEqual(unlinked, []);
  });

  it('docs/TESTING.md names every unit test file', () => {
    const testing = read('docs/TESTING.md');
    const unnamed = readdirSync(`${ROOT}tests/unit`)
      .filter((name) => name.endsWith('.test.ts'))
      .filter((name) => !testing.includes(`\`${name}\``));
    assert.deepEqual(unnamed, []);
  });
});

describe('the README', () => {
  const readme = read('README.md');

  it('lists the watchlist and the timeframes the product has, in order', () => {
    assert.ok(readme.includes(INSTRUMENTS.map((instrument) => instrument.symbol).join(', ')));
    assert.ok(readme.includes(TIMEFRAMES.join(', ')));
  });

  it('asks for the Node version the package declares', () => {
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines
      .node;
    const major = /^(\d+)/.exec(engines)?.[1];
    assert.ok(major !== undefined);
    assert.ok(
      readme.includes(`Requires Node ${major}`),
      `README does not say "Requires Node ${major}"`,
    );
  });
});

describe('environment variables', () => {
  const environment = read('docs/ENVIRONMENT.md');
  const example = read('.env.example');

  it('are documented, all of them and only them, in docs/ENVIRONMENT.md and .env.example', () => {
    assert.deepEqual([...new Set(namesIn(section(environment, 'Variables')))].sort(), REAL_ENV);
    const inExample = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
      (match) => match[1] ?? '',
    );
    assert.deepEqual([...new Set(inExample)].sort(), REAL_ENV);
  });

  it('keeps every line of .env.example commented out, so copying it sets nothing', () => {
    const active = example
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    assert.deepEqual(active, []);
  });

  it('states the defaults, the clamp and the stale tolerances the code uses', () => {
    // Prettier pads table cells to align the columns, so the document is compared with spacing collapsed.
    const flat = collapse(environment);
    assert.ok(flat.includes(`| \`${ENV_REFRESH}\` | no | \`${DEFAULT_REFRESH_SECONDS}\` |`));
    assert.ok(flat.includes('| `ELSTAND_FEED_REALTIME` | no | `false` |'));
    assert.ok(flat.includes(`**${MIN_REFRESH_SECONDS} to ${MAX_REFRESH_SECONDS}**`));
    assert.ok(flat.includes(`falls back to ${DEFAULT_REFRESH_SECONDS}`));
    assert.ok(flat.includes(`becomes STALE after ${STALE_AFTER_MS.live / 60_000} minutes`));
    assert.ok(flat.includes(`becomes STALE after ${STALE_AFTER_MS.delayed / 60_000} minutes`));
    const exampleProse = collapse(example.replace(/^#\s?/gm, ''));
    assert.ok(
      exampleProse.includes(
        `Default ${DEFAULT_REFRESH_SECONDS}, clamped to the range ${MIN_REFRESH_SECONDS} to ${MAX_REFRESH_SECONDS}`,
      ),
    );
  });

  it('states how long the server remembers a rate limit and a rejected key', () => {
    const rateLimit = FAILURE_MEMORY_MS['rate_limited'];
    const rejectedKey = FAILURE_MEMORY_MS['provider_auth'];
    assert.ok(rateLimit !== undefined && rejectedKey !== undefined);
    const flat = collapse(environment);
    assert.ok(flat.includes(`remembers the limit for ${rateLimit / 1000} seconds`));
    assert.ok(flat.includes(`remembers the rejection for ${rejectedKey / 1000} seconds`));
  });

  it('gives each failure the HTTP status the server really uses', () => {
    const stated = [...environment.matchAll(/\b(\d{3}) `([a-z_]+)`/g)].map(
      (match) => [Number(match[1]), match[2] ?? ''] as const,
    );
    assert.notEqual(stated.length, 0);
    for (const [status, code] of stated) {
      assert.ok(
        (API_ERROR_CODES as readonly string[]).includes(code),
        `${code} is not an API error code`,
      );
      assert.equal(httpStatusFor(code as ApiErrorCode), status, code);
    }
  });

  it('lists planned variables that no code reads yet, and none that it does', () => {
    const planned = [
      ...new Set(namesIn(section(environment, 'Planned variables (not read by this build)'))),
    ];
    assert.notEqual(planned.length, 0);
    const sources = ['src', 'server', 'api', 'scripts'].flatMap(listFiles);
    for (const name of planned) {
      assert.ok(!REAL_ENV.includes(name), `${name} is real, so it belongs in the variables table`);
      const readers = sources.filter((path) => read(path).includes(name));
      assert.deepEqual(
        readers,
        [],
        `${name} is read by the code, so document it as a real variable and add it to .env.example`,
      );
    }
  });
});

describe('docs/DATA-INTEGRITY.md', () => {
  const integrity = read('docs/DATA-INTEGRITY.md');

  it('states the stale tolerances the code uses', () => {
    assert.ok(
      integrity.includes(
        `**${STALE_AFTER_MS.live / 60_000} minutes for live, ${STALE_AFTER_MS.delayed / 60_000} minutes for delayed**`,
      ),
    );
    assert.ok(
      integrity.includes(
        `${SURFACE_STALE_AFTER_MS.live / 60_000} minutes for live and ${SURFACE_STALE_AFTER_MS.delayed / 60_000} minutes for delayed`,
      ),
    );
  });

  it('states how many depth levels are drawn', () => {
    assert.equal(MAX_DEPTH_LEVELS, 10);
    assert.ok(integrity.includes('At most ten levels per side'));
  });
});

describe('docs/ARCHITECTURE.md', () => {
  const architecture = read('docs/ARCHITECTURE.md');

  it('has the layering table the policy linter enforces', () => {
    const rows = tableRows(section(architecture, 'Layers and the dependency rule')).filter(
      (cells) => cells[0] !== 'tests',
    );
    assert.equal(rows.length, Object.keys(ALLOWED_IMPORTS).length);
    for (const cells of rows) {
      const directory = (cells[1] ?? '').replace(/`/g, '');
      const layer = directory === 'src/main.ts' ? 'src/main' : directory;
      const allowed = ALLOWED_IMPORTS[layer];
      assert.ok(allowed !== undefined, `${directory} is not a layer in the policy linter`);
      assert.deepEqual(
        (cells[2] ?? '')
          .split(',')
          .map((name) => name.trim())
          .sort(),
        allowed.map((entry) => entry.replace(/^src\//, '')).sort(),
        `${directory} may import a different set of layers than the document says`,
      );
    }
  });

  it('names the single files that get an extra layer', () => {
    for (const path of Object.keys(FILE_EXCEPTIONS)) {
      assert.ok(
        architecture.includes(`\`${path}\``),
        `${path} is an exception in the linter but not in the document`,
      );
    }
  });

  it('names every API error code', () => {
    for (const code of API_ERROR_CODES) assert.ok(architecture.includes(`\`${code}\``), code);
  });

  it('quotes the Content-Security-Policy and the other headers vercel.json sets', () => {
    const config = JSON.parse(read('vercel.json')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const all = config.headers.flatMap((rule) => rule.headers);
    const policy = all.find((header) => header.key === 'Content-Security-Policy');
    assert.ok(policy !== undefined);
    assert.ok(
      collapse(architecture).includes(collapse(policy.value)),
      'the CSP in the document differs from vercel.json',
    );
    for (const header of all) {
      if (header.key === 'Cache-Control') continue;
      assert.ok(
        architecture.includes(header.key),
        `${header.key} is set by vercel.json but not documented`,
      );
    }
  });
});

describe('docs/ELVOID.md', () => {
  const elvoid = read('docs/ELVOID.md');

  it('names every status, conclusion state, evidence kind and workspace section, in order', () => {
    for (const label of Object.values(ANALYSIS_STATUS_LABEL))
      assert.ok(elvoid.includes(label), label);
    for (const state of CONCLUSION_STATES) assert.ok(elvoid.includes(state), state);
    for (const kind of EVIDENCE_KINDS) assert.ok(elvoid.includes(kind), kind);
    const sections = ELVOID_SECTIONS.map((entry) => entry.title);
    assert.ok(
      collapse(elvoid).includes(`**${sections.join(', ').replace(/, ([^,]+)$/, ', $1')}.**`),
      'the list of workspace sections differs from the panel',
    );
  });

  it('mentions every field name the validator refuses', () => {
    const letters = elvoid.toLowerCase().replace(/[^a-z]/g, '');
    for (const name of FORBIDDEN_FIELDS)
      assert.ok(letters.includes(name), `${name} is refused but not documented`);
  });

  it('has the transition table the improvement guard enforces', () => {
    const rows = tableRows(section(elvoid, 'Controlled improvement'));
    assert.equal(rows.length, 5);
    const documented = new Map<string, readonly string[]>();
    for (const [from = '', to = ''] of rows) {
      const targets =
        to === 'nothing: both are final' ? [] : to.split(',').map((name) => name.trim());
      for (const stage of from.split(',').map((name) => name.trim()))
        documented.set(stage, targets);
    }
    for (const stage of CHANGE_STAGES) {
      const expected = CHANGE_STAGES.filter((next) => canTransition(stage, next));
      assert.deepEqual(
        [...(documented.get(stage) ?? [])].sort(),
        [...expected].sort(),
        `transitions from ${stage}`,
      );
    }
    assert.deepEqual([...documented.keys()].sort(), [...CHANGE_STAGES].sort() as ChangeStage[]);
  });
});

describe('docs/DESIGN.md', () => {
  const design = read('docs/DESIGN.md');
  const rowIn = (text: string, needle: string): string => {
    // Prettier pads table cells to align the columns, so rows are compared with spacing collapsed.
    const row = text
      .split('\n')
      .find((line) => line.startsWith('|') && collapse(line).includes(collapse(needle)));
    assert.ok(row !== undefined, `no table row for ${needle}`);
    return row;
  };
  const rowFor = (needle: string): string => rowIn(section(design, 'Palette'), needle);

  it('lists the palette exactly as tokens.css declares it', () => {
    const colors = [...tokens().entries()].filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value));
    assert.equal(colors.length, 10);
    for (const [name, hex] of colors) {
      const row = rowFor(`\`${name}\` | \`${hex}\``);
      assert.ok(row.includes(hex), name);
    }
  });

  it('states the contrast ratios the design tokens really have', () => {
    const backgrounds = ['--bg', '--surface', '--surface-2'] as const;
    const rows: readonly (readonly [token: string, needle: string])[] = [
      ['--text', '| `--text` |'],
      ['--text-2', '| `--text-2` |'],
      ['--neon', '| `--neon` |'],
      ['--down', '| `--down` |'],
      ['--caution', '| `--caution` |'],
      ['--green-muted', '| `--green-muted` (graphics) |'],
      ['--border', '| `--border` |'],
    ];
    const contrast = section(design, 'Measured contrast');
    for (const [token, needle] of rows) {
      const row = rowIn(contrast, needle);
      const stated = [...row.matchAll(/(\d+\.\d+):1/g)].map((match) => match[1]);
      const measured = backgrounds.map((background) =>
        contrastRatio(colorToken(token), colorToken(background)).toFixed(2),
      );
      assert.deepEqual(stated, measured, token);
    }
  });

  it('states the ramp and its darkest stop as they are', () => {
    const first = RAMP_STOPS[0];
    const last = RAMP_STOPS[RAMP_STOPS.length - 1];
    assert.ok(design.includes(`\`${first}\` to \`${last}\``));
    assert.ok(
      design.includes(`in ${RAMP_STOPS.length === 7 ? 'seven' : String(RAMP_STOPS.length)} stops`),
    );
    const onBg = contrastRatio(first, colorToken('--bg')).toFixed(2);
    const onSurface = contrastRatio(first, colorToken('--surface')).toFixed(2);
    assert.ok(design.includes(`**${onBg}:1** on \`--bg\``));
    assert.ok(design.includes(`**${onSurface}:1** on \`--surface\``));
  });
});

describe('docs/MACRO-BUBBLES.md', () => {
  const bubbles = read('docs/MACRO-BUBBLES.md');

  it('states the minimum radius and how the largest radius follows the plot', () => {
    assert.ok(bubbles.includes(`\`RADIUS_MIN\` is ${RADIUS_MIN} px`));
    const points = fixtureBubblePoints();
    assert.equal(layoutBubbles(points, 2000, 1400).radiusMax, 34, 'a large plot stops at 34 px');
    assert.equal(layoutBubbles(points, 220, 220).radiusMax, 14, 'a small plot stops at 14 px');
    const middle = layoutBubbles(points, 500, 400);
    const shorter = Math.min(
      middle.plot.right - middle.plot.left,
      middle.plot.bottom - middle.plot.top,
    );
    assert.ok(
      Math.abs(middle.radiusMax - shorter * 0.09) < 1e-9,
      'in between it is 9% of the shorter side',
    );
    assert.ok(
      bubbles.includes('9% of the shorter side of the plot area, kept between 14 px and 34 px'),
    );
  });

  it('works its example with the code: area grows with the change but is not proportional to it', () => {
    const quarter = bubbleRadius(1, 4, 34);
    const share = Math.round((quarter / 34) ** 2 * 100);
    assert.ok(
      bubbles.includes(`${quarter} px`),
      `a quarter of the largest change is drawn at ${quarter} px`,
    );
    assert.ok(bubbles.includes(`about ${share}% of the largest bubble's, not 25%`));
    assert.equal(bubbleRadius(0, 4, 34), RADIUS_MIN);
    assert.equal(bubbleRadius(4, 4, 34), 34);
    assert.ok(share > 25, 'if area were proportional the share would be 25%');
  });
});
