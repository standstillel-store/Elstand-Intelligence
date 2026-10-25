/**
 * Build-time checks that keep the product honest. They are pure functions so the tests can
 * show that each one fires, and `scripts/build.ts` runs all of them on every production build.
 */

/**
 * Directories and file names that must never reach the browser bundle: test code and fixtures
 * (Elstand ships no sample data), and server-only code (the provider key lives there).
 */
const FORBIDDEN_SEGMENT =
  /^(tests?|__tests__|fixtures?|mocks?|samples?|demo|simulat\w*|server|api|scripts)$/i;
const FORBIDDEN_FILE_WORD =
  /(^|[.-])(fixtures?|mocks?|samples?|demo|simulat\w*|test|spec)([.-]|$)/i;

export function findForbiddenInputs(inputPaths: readonly string[]): string[] {
  return inputPaths.filter((path) => {
    const segments = path.split('/');
    const file = (segments[segments.length - 1] ?? '').replace(/\.[^.]+$/, '');
    return (
      segments.slice(0, -1).some((segment) => FORBIDDEN_SEGMENT.test(segment)) ||
      FORBIDDEN_FILE_WORD.test(file)
    );
  });
}

/** Environment variable names that look like they hold a credential. */
export const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)/i;
const MIN_SECRET_LENGTH = 8;

export interface SecretLeak {
  readonly file: string;
  /** The NAME of the variable whose value was found. The value is never reported. */
  readonly variable: string;
}

/**
 * Looks for the VALUE of every credential-looking environment variable inside the build
 * output. Reports names only, so a failing build log cannot itself leak the secret.
 */
export function findSecretLeaks(
  files: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): SecretLeak[] {
  const secrets = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      SECRET_NAME_PATTERN.test(entry[0]) &&
      typeof entry[1] === 'string' &&
      entry[1].length >= MIN_SECRET_LENGTH,
  );
  const leaks: SecretLeak[] = [];
  for (const [file, content] of files) {
    for (const [variable, value] of secrets) {
      if (content.includes(value)) leaks.push({ file, variable });
    }
  }
  return leaks;
}

export interface BannedPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Things that must not appear in shipped JavaScript. */
export const BANNED_BUNDLE_PATTERNS: readonly BannedPattern[] = [
  { name: 'process.env (the browser must not read the environment)', pattern: /process\.env/ },
  { name: 'eval()', pattern: /\beval\s*\(/ },
  { name: 'new Function()', pattern: /new\s+Function\s*\(/ },
  { name: 'the vendor API host (only the server may call it)', pattern: /api\.twelvedata\.com/ },
];

export function findBannedBundleStrings(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, content] of files) {
    if (!file.endsWith('.js')) continue;
    for (const banned of BANNED_BUNDLE_PATTERNS) {
      if (banned.pattern.test(content)) found.push(`${file}: ${banned.name}`);
    }
  }
  return found;
}

/**
 * The CSP is `script-src 'self'; style-src 'self'`, so inline code would simply not run. Catch
 * it at build time instead of discovering a blank page in production.
 */
export function findInlineCodeInHtml(html: string): string[] {
  const found: string[] = [];
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) found.push('inline <script> without src');
  if (/<style[\s>]/i.test(html)) found.push('inline <style> element');
  if (/\sstyle\s*=/i.test(html)) found.push('inline style="" attribute');
  if (/\son[a-z]+\s*=/i.test(html)) found.push('inline event-handler attribute');
  return found;
}

export interface GuardInput {
  readonly inputPaths: readonly string[];
  readonly outputFiles: ReadonlyMap<string, string>;
  readonly html: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Harness builds for tests deliberately include fixtures, so they skip the bundle checks. */
  readonly checkBundleContent: boolean;
}

/** Returns every violation as one line each; an empty list means the build may ship. */
export function runGuards(input: GuardInput): string[] {
  const problems: string[] = [];
  for (const leak of findSecretLeaks(input.outputFiles, input.env)) {
    problems.push(`secret leak: the value of ${leak.variable} appears in ${leak.file}`);
  }
  if (input.checkBundleContent) {
    for (const path of findForbiddenInputs(input.inputPaths)) {
      problems.push(`forbidden input in the browser bundle: ${path}`);
    }
    for (const banned of findBannedBundleStrings(input.outputFiles)) {
      problems.push(`banned content: ${banned}`);
    }
    for (const issue of findInlineCodeInHtml(input.html)) {
      problems.push(`index.html: ${issue}`);
    }
  }
  return problems;
}
