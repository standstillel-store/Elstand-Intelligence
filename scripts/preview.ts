import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './local-env.js';
import { loadHeaderRules, startServer } from './serve.js';

/** Serves the production build in `dist/` together with the API, using the real environment. */
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(rootDir, 'dist');

try {
  await stat(join(distDir, 'index.html'));
} catch {
  console.error('dist/ does not exist yet. Run "npm run build" first.');
  process.exit(1);
}

const env = loadLocalEnv(rootDir);
const server = await startServer({
  rootDir: distDir,
  headerRules: await loadHeaderRules(join(rootDir, 'vercel.json')),
  env,
  fetch: globalThis.fetch,
  port: Number(env['PORT'] ?? 4173),
  log: (line) => console.log(line),
});
console.log(`Elstand Intelligence (production build) at ${server.url}`);
console.log(
  env['TWELVE_DATA_API_KEY'] === undefined || env['TWELVE_DATA_API_KEY'] === ''
    ? 'TWELVE_DATA_API_KEY is not set: the app will show ENV NOT CONNECTION.'
    : 'TWELVE_DATA_API_KEY is set: the API will request real data from Twelve Data.',
);
