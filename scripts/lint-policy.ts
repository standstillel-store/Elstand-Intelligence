import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Project policy checks: `npm run lint:policy`.
 *
 * This is not a style linter (Prettier owns formatting, `tsc --strict` owns types). It
 * enforces the rules this product is built on, so that a later change cannot quietly break
 * them: no fabricated data, no secrets in the browser, no markup injection, no suppressed
 * type errors, and a one-way dependency order between the layers of the codebase.
 *
 * `lintFiles` is pure (it takes files and returns violations) so every rule is tested in
 * tests/unit/lint-policy.test.ts, and the real repository is checked there as well.
 */

export interface PolicyFile {
  /** Repository-relative, with forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface Violation {
  readonly path: string;
  /** 1-based; 0 for a whole-file finding. */
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

// ---- scopes ---------------------------------------------------------------------------------

const isCode = (path: string): boolean => /\.(ts|mjs)$/.test(path);
const under = (path: string, ...dirs: string[]): boolean =>
  dirs.some((dir) => path.startsWith(`${dir}/`));

const isBrowserCode = (path: string): boolean => isCode(path) && under(path, 'src');
const isProductCode = (path: string): boolean =>
  isCode(path) && under(path, 'src', 'server', 'api');
const isAnyCode = (path: string): boolean =>
  isCode(path) && under(path, 'src', 'server', 'api', 'scripts', 'tests');

/** The files that name the banned constructs in order to ban them. */
const POLICY_SOURCES: readonly string[] = [
  'scripts/lint-policy.ts',
  'scripts/guards.ts',
  'tests/unit/lint-policy.test.ts',
  'tests/unit/guards.test.ts',
  'tests/unit/build.test.ts',
];

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

// ---- line rules -----------------------------------------------------------------------------

interface LineRule {
  readonly id: string;
  readonly message: string;
  readonly appliesTo: (path: string) => boolean;
  readonly pattern: RegExp;
  /** True when comment-only lines should not be tested (prose may name what the code avoids). */
  readonly skipComments: boolean;
  /** True when the rule is about identifiers: text inside quotes is blanked before testing. */
  readonly ignoreStrings?: boolean;
  readonly except?: readonly string[];
}

const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** The line with the inside of every string literal removed, so prose in a message is not code. */
function withoutStrings(text: string): string {
  return text.replace(STRING_LITERAL, '""');
}

const LINE_RULES: readonly LineRule[] = [
  {
    id: 'no-dynamic-code',
    message:
      'Code built from strings (eval, new Function) is banned: the CSP forbids it and it is an injection route.',
    appliesTo: (path) => isProductCode(path) || (isCode(path) && under(path, 'scripts')),
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/,
    skipComments: true,
    except: POLICY_SOURCES,
  },
  {
    id: 'no-html-injection',
    message:
      'Never build markup from strings. Use the helpers in src/ui/dom.ts, which create elements and set text.',
    appliesTo: isBrowserCode,
    pattern:
      /\.\s*(?:innerHTML|outerHTML)\b|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(/,
    skipComments: true,
  },
  {
    id: 'no-type-suppression',
    message:
      'Do not suppress TypeScript errors. Fix the type, or narrow the value with a real check.',
    appliesTo: isAnyCode,
    pattern: /@ts-(?:ignore|nocheck|expect-error)\b/,
    skipComments: false,
    except: POLICY_SOURCES,
  },
  {
    id: 'no-any',
    message: 'Do not use `any`. Use `unknown` and narrow it, or write the type.',
    appliesTo: isAnyCode,
    pattern: /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]|\bArray<any>|,\s*any>/,
    skipComments: true,
    ignoreStrings: true,
    except: POLICY_SOURCES,
  },
  {
    id: 'no-debugger',
    message: 'Remove the debugger statement.',
    appliesTo: isAnyCode,
    pattern: /^\s*debugger\s*;?\s*$/,
    skipComments: true,
  },
  {
    id: 'no-console-noise',
    message:
      'No console.log, debug, info, trace or dir in product code. The app reports problems on screen and the server in its error responses.',
    appliesTo: isProductCode,
    pattern: /\bconsole\s*\.\s*(?:log|debug|info|trace|dir)\s*\(/,
    skipComments: true,
  },
  {
    id: 'no-randomness',
    message: 'Nothing in the product may be random: randomness is how simulated data gets made.',
    appliesTo: isProductCode,
    pattern:
      /\bMath\s*\.\s*random\s*\(|\bcrypto\s*\.\s*(?:getRandomValues|randomUUID|randomInt)\b|\brandomBytes\b/,
    skipComments: true,
  },
  {
    id: 'no-placeholder-data',
    message:
      'No mock, fake, dummy, stub, sample, demo or simulated data or helpers in product code. With nothing connected the product says ENV NOT CONNECTION.',
    appliesTo: isProductCode,
    pattern:
      /\w*(?:mock|fake|dummy|stub|simulat)\w*|\b(?:sample|demo|seeded?)[-_]?(?:data|quotes?|candles?|prices?|feed|series|book|depth|surface|news|calendar|events?|points?)\b|lorem ipsum/i,
    skipComments: true,
    ignoreStrings: true,
  },
  {
    id: 'no-unfinished-markers',
    message:
      'Unfinished markers do not ship. Finish the work, or say plainly in the docs what is not built.',
    appliesTo: (path) => isAnyCode(path) || under(path, 'docs') || path === 'README.md',
    pattern: /\b(?:TODO|FIXME|HACK)\b/,
    skipComments: false,
    except: POLICY_SOURCES,
  },
  {
    id: 'no-secret-name-in-browser',
    message:
      'The browser code must not know the provider key or read an environment. Secrets live on the server only.',
    appliesTo: isBrowserCode,
    pattern:
      /(?:TWELVE_DATA|ALPHA_VANTAGE|FRED|FINANCE_CALENDAR|MARKETAUX|BLS|BEA)_API_KEY|\bprocess\s*\.\s*env\b|\bimport\s*\.\s*meta\s*\.\s*env\b/,
    skipComments: true,
  },
  {
    id: 'no-absolute-url-in-browser',
    message:
      'The browser calls only its own origin. An absolute web address in browser code is a second destination.',
    appliesTo: isBrowserCode,
    pattern: /['"`](?:https?:)?\/\/(?!www\.w3\.org\/2000\/svg['"`])[a-z0-9.-]+/i,
    skipComments: true,
  },
  {
    id: 'network-only-at-the-edge',
    message:
      'Network primitives belong in src/main.ts, which injects fetch. Everything else takes the injected function.',
    appliesTo: (path) => isBrowserCode(path) && path !== 'src/main.ts',
    pattern:
      /\b(?:window|globalThis|self)\s*\.\s*fetch\b|(?<![\w.$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bnew\s+Worker\s*\(|\bserviceWorker\b/,
    skipComments: true,
  },
  {
    id: 'tests-must-run',
    message: 'A focused or skipped test silently hides the rest. Remove .only, .skip and .todo.',
    appliesTo: (path) => isCode(path) && under(path, 'tests'),
    pattern: /\b(?:describe|it|test|suite)\s*\.\s*(?:only|skip|todo)\s*\(/,
    skipComments: true,
    except: POLICY_SOURCES,
  },
];

// ---- secrets, anywhere --------------------------------------------------------------------------

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'a GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { name: 'an API secret key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    name: 'a web address with credentials in it',
    pattern:
      /\bhttps?:\/\/(?!(?:user|username|login|admin|test):(?:pass|password|secret|pwd|test)@)[^/\s:@'"`]+:[^/\s@'"`]+@/,
  },
  {
    name: 'a literal secret assigned to a credential-looking name',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|token|passw(?:or)?d)\b['"]?\s*[:=]\s*['"][A-Za-z0-9_\-./+=]{16,}['"]/i,
  },
];

const ENV_FILE = /(^|\/)\.env(\..+)?$/;

/** The rules that are not a single-line pattern, by the id they report under. */
const STRUCTURAL_RULE_IDS: readonly string[] = [
  'layering',
  'import-outside-repo',
  'no-hardcoded-secret',
  'package-policy',
  'gitignore-policy',
  'no-env-file',
  'env-example-values',
  'no-external-asset',
];

/** Every id a violation can carry. */
export const RULE_IDS: readonly string[] = [
  ...LINE_RULES.map((rule) => rule.id),
  ...STRUCTURAL_RULE_IDS,
];

// ---- layering ---------------------------------------------------------------------------------

/**
 * Which layer may import which. The order is one-way: `core` knows nothing; `data` and
 * `elvoid` know `core`; `app` (state, connection, routing) knows those three and nothing that
 * draws; `ui` knows all of them; `server` shares `core` and `data` (the validated contracts)
 * and nothing that draws; `api` only wraps `server`. Two single files get one more layer each
 * (`FILE_EXCEPTIONS`): the composition root, which mounts the shell and the pages, and the
 * documentation generator, which renders the ELVOID module registry.
 */
export const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'src/core': ['src/core'],
  'src/data': ['src/data', 'src/core'],
  'src/elvoid': ['src/elvoid', 'src/core'],
  'src/app': ['src/app', 'src/core', 'src/data', 'src/elvoid'],
  'src/ui': ['src/ui', 'src/app', 'src/core', 'src/data', 'src/elvoid'],
  'src/main': ['src/app', 'src/ui', 'src/styles'],
  server: ['server', 'src/core', 'src/data'],
  api: ['api', 'server'],
  scripts: ['scripts', 'server'],
};

/**
 * Layers one named file may import beyond its layer's list. Kept to single files on purpose, so
 * the exception cannot spread to the rest of the layer.
 */
export const FILE_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  /** The composition root of the application: it mounts the shell and the pages. */
  'src/app/app.ts': ['src/ui'],
  /** Renders `docs/ELVOID-MODULES.md` from the registry, which is the single source of truth. */
  'scripts/gen-docs.ts': ['src/elvoid'],
};

export function layerOf(path: string): string | null {
  if (path === 'src/main.ts') return 'src/main';
  const parts = path.split('/');
  const [first, second] = parts;
  if (first === 'src' && second !== undefined && parts.length > 2) return `src/${second}`;
  if (first === 'server' || first === 'api' || first === 'scripts' || first === 'tests')
    return first;
  return null;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\bexport\s+\*\s+from\s+)['"](\.{1,2}\/[^'"]*)['"]/g;

function layeringViolations(file: PolicyFile): Violation[] {
  if (!isCode(file.path)) return [];
  const from = layerOf(file.path);
  if (from === null) return [];
  const allowed = ALLOWED_IMPORTS[from];
  if (allowed === undefined) return [];
  const found: Violation[] = [];
  file.content.split('\n').forEach((text, index) => {
    if (COMMENT_LINE.test(text)) return;
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? '';
      const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      if (target.startsWith('../')) {
        found.push({
          path: file.path,
          line: index + 1,
          rule: 'import-outside-repo',
          message: `${specifier} leaves the repository.`,
        });
        continue;
      }
      const to = layerOf(target);
      if (to === null || to === from || allowed.includes(to)) continue;
      if (FILE_EXCEPTIONS[file.path]?.includes(to) === true) continue;
      found.push({
        path: file.path,
        line: index + 1,
        rule: 'layering',
        message: `${from} must not import ${to} (${specifier}). Allowed: ${allowed.join(', ')}.`,
      });
    }
  });
  return found;
}

// ---- whole-file rules ---------------------------------------------------------------------------

function packageViolations(file: PolicyFile): Violation[] {
  if (file.path !== 'package.json') return [];
  const found: Violation[] = [];
  const add = (message: string): void => {
    found.push({ path: file.path, line: 0, rule: 'package-policy', message });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    add('package.json is not valid JSON.');
    return found;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    add('package.json is not an object.');
    return found;
  }
  const manifest = parsed as Record<string, unknown>;
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = manifest[key];
    if (typeof value === 'object' && value !== null && Object.keys(value).length > 0) {
      add(
        `${key} must be empty: the product has no runtime dependencies, so nothing can be pulled into the browser or the server by accident.`,
      );
    }
  }
  const scripts = manifest['scripts'];
  if (typeof scripts === 'object' && scripts !== null) {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      if (name in scripts) add(`The "${name}" script runs code on install and is not allowed.`);
    }
  }
  if (manifest['private'] !== true) add('package.json must say "private": true.');
  return found;
}

function gitignoreViolations(file: PolicyFile): Violation[] {
  if (file.path !== '.gitignore') return [];
  const lines = new Set(file.content.split('\n').map((line) => line.trim()));
  const found: Violation[] = [];
  for (const required of ['node_modules/', 'dist/', '.env', '.env.*', '!.env.example']) {
    if (!lines.has(required)) {
      found.push({
        path: file.path,
        line: 0,
        rule: 'gitignore-policy',
        message: `.gitignore must contain "${required}" so build output and environment files are never committed.`,
      });
    }
  }
  return found;
}

function envFileViolations(file: PolicyFile): Violation[] {
  if (!ENV_FILE.test(file.path) || file.path.endsWith('.env.example')) return [];
  return [
    {
      path: file.path,
      line: 0,
      rule: 'no-env-file',
      message:
        'An environment file must not be committed. Only .env.example, with no values, belongs in the repository.',
    },
  ];
}

function envExampleViolations(file: PolicyFile): Violation[] {
  if (!file.path.endsWith('.env.example')) return [];
  const found: Violation[] = [];
  file.content.split('\n').forEach((text, index) => {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(text);
    if (match === null) return;
    const value = match[2] ?? '';
    // A value is allowed only if it is empty, a boolean, a number, or an obvious placeholder.
    if (
      value === '' ||
      /^(true|false|\d+)$/.test(value) ||
      /^<[^>]+>$/.test(value) ||
      /^your[-_ ]/i.test(value)
    )
      return;
    found.push({
      path: file.path,
      line: index + 1,
      rule: 'env-example-values',
      message: `${match[1] ?? 'A variable'} has a value in .env.example. Keep it empty, or use a <placeholder>.`,
    });
  });
  return found;
}

function htmlViolations(file: PolicyFile): Violation[] {
  if (!file.path.endsWith('.html')) return [];
  const found: Violation[] = [];
  file.content.split('\n').forEach((text, index) => {
    if (/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(text)) {
      found.push({
        path: file.path,
        line: index + 1,
        rule: 'no-external-asset',
        message: 'The page loads nothing from another origin. Serve the asset from this project.',
      });
    }
  });
  return found;
}

// ---- driver -----------------------------------------------------------------------------------

function lineViolations(file: PolicyFile): Violation[] {
  const rules = LINE_RULES.filter(
    (rule) => rule.appliesTo(file.path) && !(rule.except ?? []).includes(file.path),
  );
  const found: Violation[] = [];
  const lines = file.content.split('\n');
  lines.forEach((text, index) => {
    const isComment = COMMENT_LINE.test(text);
    for (const rule of rules) {
      if (rule.skipComments && isComment) continue;
      if (rule.pattern.test(rule.ignoreStrings === true ? withoutStrings(text) : text)) {
        found.push({ path: file.path, line: index + 1, rule: rule.id, message: rule.message });
      }
    }
  });
  return found;
}

function secretViolations(file: PolicyFile): Violation[] {
  const found: Violation[] = [];
  file.content.split('\n').forEach((text, index) => {
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(text)) {
        found.push({
          path: file.path,
          line: index + 1,
          rule: 'no-hardcoded-secret',
          message: `This looks like ${secret.name}. Credentials live in the host's environment, never in a file.`,
        });
      }
    }
  });
  return found;
}

/** Every violation in the given files, ordered by path and line. */
export function lintFiles(files: readonly PolicyFile[]): Violation[] {
  const found = files.flatMap((file) => [
    ...lineViolations(file),
    ...layeringViolations(file),
    ...secretViolations(file),
    ...packageViolations(file),
    ...gitignoreViolations(file),
    ...envFileViolations(file),
    ...envExampleViolations(file),
    ...htmlViolations(file),
  ]);
  return found.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

// ---- reading the repository ---------------------------------------------------------------------

const ALWAYS_SKIPPED = [
  'node_modules/',
  'dist/',
  '.git/',
  '.dev/',
  'coverage/',
  'test-results/',
  '.vercel/',
];
const MAX_BYTES = 1_500_000;

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const relative = full
      .slice(root.length + 1)
      .split(sep)
      .join('/');
    if (ALWAYS_SKIPPED.some((skipped) => `${relative}/`.startsWith(skipped))) continue;
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(relative);
  }
  return out;
}

/**
 * The files that could end up in a commit: tracked, plus untracked and not ignored. Falls back
 * to walking the tree when git is not available. Ignored files (`.env.local`, `dist/`) are
 * deliberately not read.
 */
export function candidatePaths(root: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return output.split('\0').filter((path) => path !== '');
  } catch {
    return walk(root);
  }
}

export function readProjectFiles(
  root: string,
  paths: readonly string[] = candidatePaths(root),
): PolicyFile[] {
  const files: PolicyFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (ALWAYS_SKIPPED.some((skipped) => path.startsWith(skipped))) continue;
    const full = join(root, path);
    let buffer: Buffer;
    try {
      if (statSync(full).size > MAX_BYTES) continue;
      buffer = readFileSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (buffer.includes(0)) continue; // binary
    files.push({ path, content: buffer.toString('utf8') });
  }
  return files;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.path}${violation.line > 0 ? `:${violation.line}` : ''}  [${violation.rule}]  ${violation.message}`,
    )
    .join('\n');
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = readProjectFiles(root);
  const violations = lintFiles(files);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    console.error(
      `\nPolicy check failed: ${violations.length} violation${violations.length === 1 ? '' : 's'}.`,
    );
    process.exit(1);
  }
  console.log(
    `Policy check passed: ${files.length} files checked against ${RULE_IDS.length} rules.`,
  );
}
