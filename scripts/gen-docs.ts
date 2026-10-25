import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ELVOID_MODULES,
  MODULE_STATUS_LABEL,
  MODULE_STATUS_MEANING,
  type ElvoidModuleSpec,
  type ModuleStatus,
} from '../src/elvoid/modules.js';

/**
 * Generates the documentation that must not drift from the code. Today that is
 * `docs/ELVOID-MODULES.md`, rendered from the registry in `src/elvoid/modules.ts`.
 *
 *   npm run docs:gen     writes the file
 *   npm run docs:check   fails if the file on disk is not what the registry produces
 *
 * `tests/unit/docs.test.ts` runs the same check, so a registry change without a regenerated
 * document fails the test suite.
 */

export const MODULES_DOC_PATH = 'docs/ELVOID-MODULES.md';

const STATUS_ORDER: readonly ModuleStatus[] = ['implemented', 'contract-only', 'not-implemented'];

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function contractPaths(module: ElvoidModuleSpec): string[] {
  return module.contract === null ? [] : module.contract.split(',').map((path) => path.trim());
}

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export function renderModulesDoc(modules: readonly ElvoidModuleSpec[] = ELVOID_MODULES): string {
  const counts = new Map<ModuleStatus, number>(STATUS_ORDER.map((status) => [status, 0]));
  for (const module of modules) counts.set(module.status, (counts.get(module.status) ?? 0) + 1);
  const implemented = counts.get('implemented') ?? 0;

  const lines: string[] = [
    '<!-- GENERATED FILE. Do not edit by hand. -->',
    '<!-- Source: src/elvoid/modules.ts. Regenerate with `npm run docs:gen`. A test fails if this file is out of date. -->',
    '',
    '# ELVOID modules',
    '',
    `ELVOID is organized as ${modules.length} modules with explicit boundaries. Each one names what it takes in, what it puts out and how it fails before any code is written for it. This page is generated from the registry in \`src/elvoid/modules.ts\`, which is the single source of truth.`,
    '',
    `**${implemented} of ${modules.length} modules ${implemented === 1 ? 'is' : 'are'} implemented.** ${counts.get('contract-only') ?? 0} ${(counts.get('contract-only') ?? 0) === 1 ? 'has' : 'have'} a contract only, and ${counts.get('not-implemented') ?? 0} ${(counts.get('not-implemented') ?? 0) === 1 ? 'is' : 'are'} not implemented. ELVOID does not change itself: a change is proposed, tested, evaluated, versioned and then approved by a person.`,
    '',
    '## Status',
    '',
    ...STATUS_ORDER.map(
      (status) => `- **${MODULE_STATUS_LABEL[status]}**: ${MODULE_STATUS_MEANING[status]}`,
    ),
    '',
    '## Overview',
    '',
    '| # | Module | Status | Contract in the repository |',
    '| --- | --- | --- | --- |',
    ...modules.map((module, index) => {
      const paths = contractPaths(module);
      return `| ${index + 1} | [${cell(module.name)}](#${index + 1}-${slug(module.name)}) | ${MODULE_STATUS_LABEL[module.status]} | ${paths.length === 0 ? 'none' : paths.map((path) => `\`${path}\``).join(', ')} |`;
    }),
    '',
  ];

  modules.forEach((module, index) => {
    const paths = contractPaths(module);
    lines.push(
      `## ${index + 1}. ${module.name}`,
      '',
      `**Status:** ${MODULE_STATUS_LABEL[module.status]}  `,
      `**Id:** \`${module.id}\`  `,
      `**Contract:** ${paths.length === 0 ? 'none yet' : paths.map((path) => `\`${path}\``).join(', ')}`,
      '',
      module.purpose,
      '',
      '**Inputs**',
      '',
      list(module.inputs),
      '',
      '**Outputs**',
      '',
      list(module.outputs),
      '',
      '**Error states**',
      '',
      list(module.errorStates),
      '',
    );
  });

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** The anchor GitHub gives a heading like `## 1. Market data normalization`. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-');
}

export async function readModulesDoc(rootDir: string): Promise<string | null> {
  try {
    return await readFile(join(rootDir, MODULES_DOC_PATH), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const expected = renderModulesDoc();
  if (process.argv.includes('--check')) {
    const actual = await readModulesDoc(rootDir);
    if (actual !== expected) {
      console.error(
        `${MODULES_DOC_PATH} is ${actual === null ? 'missing' : 'out of date'}. Run \`npm run docs:gen\`.`,
      );
      process.exit(1);
    }
    console.log(`${MODULES_DOC_PATH} is up to date.`);
  } else {
    const target = join(rootDir, MODULES_DOC_PATH);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, expected);
    console.log(`Wrote ${MODULES_DOC_PATH}.`);
  }
}
