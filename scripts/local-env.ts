import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Local development convenience: reads `.env` and `.env.local` (both git-ignored) and layers
 * the real process environment on top, the way a host would. Never prints values.
 */
export function loadLocalEnv(rootDir: string): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const file of ['.env', '.env.local']) {
    try {
      Object.assign(merged, parseEnv(readFileSync(join(rootDir, file), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { ...merged, ...process.env };
}
