import { build as bundle, type Metafile } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runGuards } from './guards.js';

/**
 * Production build: one JS bundle and one CSS file with content-hashed names, `index.html`
 * rewritten to point at them, `public/` copied alongside, then the guards in `guards.ts`.
 * If a guard fails, the build fails and nothing is left in the output directory.
 */

export interface BuildOptions {
  readonly rootDir: string;
  readonly outDir: string;
  /** Repo-relative entry, e.g. `src/main.ts`. */
  readonly entry?: string;
  /** Repo-relative HTML template that references `/assets/<entry name>.js` and `.css`. */
  readonly htmlTemplate?: string;
  /** Repo-relative directory copied into the output, or null for none. */
  readonly publicDir?: string | null;
  readonly minify?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** False only for the browser-test harness, which deliberately includes test fixtures. */
  readonly productionGuards?: boolean;
  readonly log?: (line: string) => void;
}

export interface BuiltFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface BuildReport {
  readonly files: readonly BuiltFile[];
  readonly js: string;
  readonly css: string;
}

async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    names.map((entry) =>
      entry.isDirectory()
        ? listFiles(join(dir, entry.name))
        : Promise.resolve([join(dir, entry.name)]),
    ),
  );
  return nested.flat();
}

function findEntryOutputs(metafile: Metafile, entry: string): { js: string; css: string } {
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint === entry && path.endsWith('.js') && output.cssBundle !== undefined) {
      return { js: path, css: output.cssBundle };
    }
  }
  throw new Error(`esbuild produced no JS and CSS output for ${entry}.`);
}

function replaceOnce(html: string, from: string, to: string): string {
  const parts = html.split(from);
  if (parts.length !== 2) {
    throw new Error(
      `Expected exactly one reference to ${from} in the HTML template, found ${parts.length - 1}.`,
    );
  }
  return parts.join(to);
}

export async function runBuild(options: BuildOptions): Promise<BuildReport> {
  const { rootDir, outDir } = options;
  const entry = options.entry ?? 'src/main.ts';
  const template = options.htmlTemplate ?? 'index.html';
  const publicDir = options.publicDir === undefined ? 'public' : options.publicDir;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const name = basename(entry).replace(/\.[^.]+$/, '');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'assets'), { recursive: true });

  try {
    const result = await bundle({
      absWorkingDir: rootDir,
      entryPoints: [entry],
      outdir: join(outDir, 'assets'),
      entryNames: '[name]-[hash]',
      bundle: true,
      format: 'esm',
      target: ['es2022', 'chrome110', 'firefox110', 'safari16'],
      platform: 'browser',
      minify: options.minify ?? true,
      legalComments: 'none',
      charset: 'utf8',
      metafile: true,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    const { js, css } = findEntryOutputs(result.metafile, entry);
    const jsUrl = `/assets/${basename(js)}`;
    const cssUrl = `/assets/${basename(css)}`;

    let html = await readFile(join(rootDir, template), 'utf8');
    html = replaceOnce(html, `/assets/${name}.js`, jsUrl);
    html = replaceOnce(html, `/assets/${name}.css`, cssUrl);
    await writeFile(join(outDir, 'index.html'), html);

    if (publicDir !== null) {
      const source = join(rootDir, publicDir);
      try {
        await stat(source);
        await cp(source, outDir, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const paths = await listFiles(outDir);
    const contents = new Map<string, string>();
    const files: BuiltFile[] = [];
    for (const path of paths) {
      const buffer = await readFile(path);
      const rel = relative(outDir, path).split('\\').join('/');
      contents.set(rel, buffer.toString('utf8'));
      files.push({ path: rel, bytes: buffer.length, gzipBytes: gzipSync(buffer).length });
    }

    const problems = runGuards({
      inputPaths: Object.keys(result.metafile.inputs),
      outputFiles: contents,
      html,
      env,
      checkBundleContent: options.productionGuards ?? true,
    });
    if (problems.length > 0) {
      throw new Error(
        `Build guard failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
      );
    }

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      log(
        `  ${file.path.padEnd(34)} ${(file.bytes / 1024).toFixed(1).padStart(7)} kB   gzip ${(file.gzipBytes / 1024).toFixed(1)} kB`,
      );
    }
    return { files, js: jsUrl, css: cssUrl };
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  console.log('Building Elstand Intelligence');
  runBuild({ rootDir, outDir: join(rootDir, 'dist'), log: (line) => console.log(line) }).then(
    () => console.log('Build complete.'),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
