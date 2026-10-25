import { register } from 'node:module';

// The scripts and tests run TypeScript directly through Node's built-in type stripping
// (default-on from Node 22.18). Fail with a clear message instead of a parse error elsewhere.
if (!process.features.typescript) {
  console.error(
    `Elstand needs Node 22.18 or newer (built-in TypeScript type stripping). Found ${process.version}.`,
  );
  process.exit(1);
}

register('./ts-resolve-hook.mjs', import.meta.url);
