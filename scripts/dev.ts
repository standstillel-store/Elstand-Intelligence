import { context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './local-env.js';
import { loadHeaderRules, startServer } from './serve.js';

/** Development server: rebuilds on change (unminified, with source maps) and serves the API. */
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(rootDir, '.dev');

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'assets'), { recursive: true });

async function copyStatic(): Promise<void> {
  await writeFile(join(outDir, 'index.html'), await readFile(join(rootDir, 'index.html'), 'utf8'));
  await cp(join(rootDir, 'public'), outDir, { recursive: true });
}
await copyStatic();
watch(join(rootDir, 'index.html'), () => void copyStatic());

const bundler = await context({
  absWorkingDir: rootDir,
  entryPoints: ['src/main.ts'],
  outdir: join(outDir, 'assets'),
  entryNames: '[name]',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
});
await bundler.watch();

const env = loadLocalEnv(rootDir);
const server = await startServer({
  rootDir: outDir,
  headerRules: await loadHeaderRules(join(rootDir, 'vercel.json')),
  env,
  fetch: globalThis.fetch,
  port: Number(env['PORT'] ?? 5173),
  log: (line) => console.log(line),
});
console.log(`Elstand Intelligence (dev) at ${server.url}`);
console.log(
  env['TWELVE_DATA_API_KEY'] === undefined || env['TWELVE_DATA_API_KEY'] === ''
    ? 'TWELVE_DATA_API_KEY is not set: the app will show ENV NOT CONNECTION.'
    : 'TWELVE_DATA_API_KEY is set: the API will request real data from Twelve Data.',
);
