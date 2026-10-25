import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  candidatePaths,
  formatViolations,
  layerOf,
  lintFiles,
  readProjectFiles,
  RULE_IDS,
  type Violation,
} from '../../scripts/lint-policy.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Every rule id that some test below has seen fire. The last test requires all of them. */
const seen = new Set<string>();

function run(path: string, content: string): Violation[] {
  const found = lintFiles([{ path, content }]);
  for (const violation of found) seen.add(violation.rule);
  return found;
}

function ids(path: string, content: string): string[] {
  return [...new Set(run(path, content).map((violation) => violation.rule))];
}

/** Asserts that this file, with this content, breaks exactly the given rule. */
function breaks(rule: string, path: string, content: string): void {
  assert.deepEqual(ids(path, content), [rule], `${path}: ${content}`);
}

function clean(path: string, content: string): void {
  assert.deepEqual(run(path, content), [], `${path}: ${content}`);
}

const made: string[] = [];
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('no-dynamic-code', () => {
  it('bans eval and new Function in product code and tooling', () => {
    for (const path of ['src/ui/a.ts', 'server/a.ts', 'api/a.ts', 'scripts/a.ts']) {
      breaks('no-dynamic-code', path, "const x = eval('1');");
      breaks('no-dynamic-code', path, 'const y = eval  (code);');
      breaks('no-dynamic-code', path, "const f = new Function('return 1');");
    }
  });

  it('does not mistake other words, comments, tests or the policy files for it', () => {
    clean('src/ui/a.ts', 'const a = evaluate(1) + retrieval(2) + medieval(3);');
    clean('src/ui/a.ts', '// eval(x) is banned here\n * new Function() too');
    clean('tests/unit/a.test.ts', "const x = eval('1');");
    clean('scripts/guards.ts', "{ name: 'eval()' }");
  });
});

describe('no-html-injection', () => {
  it('bans building markup from strings in browser code', () => {
    breaks('no-html-injection', 'src/ui/a.ts', 'el.innerHTML = value;');
    breaks('no-html-injection', 'src/ui/a.ts', 'const s = node.outerHTML;');
    breaks('no-html-injection', 'src/ui/a.ts', "el.insertAdjacentHTML('beforeend', value);");
    breaks('no-html-injection', 'src/ui/a.ts', "document.write('x');");
    breaks('no-html-injection', 'src/ui/a.ts', 'document . writeln(x);');
    breaks('no-html-injection', 'src/ui/a.ts', 'el .innerHTML += x');
  });

  it('leaves comments, the server and the tests alone', () => {
    clean('src/ui/a.ts', '// never use .innerHTML here');
    clean('src/ui/a.ts', ' * so no `.innerHTML` is needed');
    clean('tests/e2e/a.test.ts', 'document.body.innerHTML = "";');
    clean('server/a.ts', 'x.innerHTML');
  });
});

describe('no-type-suppression', () => {
  it('bans every kind of suppression directive, even in a comment, in any code', () => {
    for (const directive of ['@ts' + '-ignore', '@ts' + '-nocheck', '@ts' + '-expect-error']) {
      for (const path of [
        'src/a.ts',
        'server/a.ts',
        'api/a.ts',
        'scripts/a.ts',
        'tests/unit/a.test.ts',
      ]) {
        breaks('no-type-suppression', path, `// ${directive}\nconst x: number = 'a';`);
      }
    }
  });

  it('leaves ordinary comments alone', () => {
    clean('src/a.ts', '// ts is the language we use\nconst x = 1;');
  });
});

describe('no-any', () => {
  it('bans the any type in each of its spellings', () => {
    for (const code of [
      'let x: any = 1;',
      'const y = value as any;',
      'const z = <any>value;',
      'let list: any[] = [];',
      'let list: Array<any> = [];',
      'let map: Record<string, any> = {};',
    ]) {
      breaks('no-any', 'src/core/a.ts', code);
      breaks('no-any', 'tests/unit/a.test.ts', code);
    }
  });

  it('does not mistake other words, strings or comments for it', () => {
    clean('src/core/a.ts', 'const company = many + anything;');
    clean('src/core/a.ts', "const label = 'type: any is not allowed';");
    clean('src/core/a.ts', '// type: any would be wrong\nconst x: unknown = 1;');
  });
});

describe('no-debugger', () => {
  it('bans a debugger statement', () => {
    breaks('no-debugger', 'src/a.ts', 'debugger;');
    breaks('no-debugger', 'tests/unit/a.test.ts', '  debugger');
  });

  it('allows the word elsewhere', () => {
    clean('src/a.ts', 'const debuggerAttached = false;\n// debugger;');
  });
});

describe('no-console-noise', () => {
  it('bans console.log, debug, info, trace and dir in product code', () => {
    for (const method of ['log', 'debug', 'info', 'trace', 'dir']) {
      breaks('no-console-noise', 'src/app/a.ts', `console.${method}(1);`);
      breaks('no-console-noise', 'server/a.ts', `console . ${method} (1);`);
    }
  });

  it('allows warn and error, and anything in tooling and tests', () => {
    clean('src/app/a.ts', 'console.warn(1);\nconsole.error(2);');
    clean('scripts/a.ts', 'console.log(1);');
    clean('tests/unit/a.test.ts', 'console.log(1);');
  });
});

describe('no-randomness', () => {
  it('bans randomness in product code', () => {
    breaks('no-randomness', 'src/core/a.ts', 'const r = Math.random();');
    breaks('no-randomness', 'server/a.ts', 'crypto.getRandomValues(buffer);');
    breaks('no-randomness', 'server/a.ts', 'const id = crypto.randomUUID();');
    breaks('no-randomness', 'api/a.ts', 'const b = randomBytes(8);');
  });

  it('allows it in tests and tooling', () => {
    clean('tests/unit/a.test.ts', 'Math.random();');
    clean('scripts/a.ts', 'Math.random();');
    clean('src/core/a.ts', '// no Math.random() anywhere');
  });
});

describe('no-placeholder-data', () => {
  it('bans identifiers that name mock, fake, dummy, stub, sample, demo or simulated data', () => {
    for (const code of [
      'const mockQuotes = [];',
      'const fakeCandles = [];',
      'const dummy_data = 1;',
      'function simulateFeed() {}',
      'const simulatedPrice = 1;',
      'const sampleData = [];',
      'const demo_prices = [];',
      'class StubProvider {}',
      'import { x } from "./mock-feed.js";'.replace('"./mock-feed.js"', 'mockFeed'),
    ]) {
      breaks('no-placeholder-data', 'src/data/a.ts', code);
    }
    breaks('no-placeholder-data', 'server/a.ts', 'const fakeBook = {};');
  });

  it('lets a message say what the product refuses to do, since text in quotes is not code', () => {
    clean('src/ui/a.ts', "const note = 'Elstand never draws sample or simulated candles.';");
    clean('src/ui/a.ts', '// there is no sample data, no mock feed and nothing simulated');
  });

  it('allows test code to use them', () => {
    clean('tests/support/fixtures.ts', 'export const sampleData = []; const mockProvider = {};');
  });
});

describe('no-unfinished-markers', () => {
  it('bans unfinished markers in code, docs and the README, even in comments', () => {
    const marker = (word: string): string => `// ${word}: later`;
    for (const word of ['TO' + 'DO', 'FIX' + 'ME', 'HA' + 'CK']) {
      breaks('no-unfinished-markers', 'src/a.ts', marker(word));
      breaks('no-unfinished-markers', 'tests/unit/a.test.ts', marker(word));
      breaks('no-unfinished-markers', 'docs/ARCHITECTURE.md', `${word} write this section`);
      breaks('no-unfinished-markers', 'README.md', `- ${word}`);
    }
  });

  it('leaves other words alone', () => {
    clean('src/a.ts', '// todos are tracked elsewhere; TODOS list; hackathon');
    clean('docs/A.md', 'The to-do list is not part of Phase 1.');
  });
});

describe('no-secret-name-in-browser', () => {
  it('keeps the key name and any environment access out of browser code', () => {
    breaks('no-secret-name-in-browser', 'src/data/a.ts', "const name = 'TWELVE_DATA_API_KEY';");
    breaks('no-secret-name-in-browser', 'src/app/a.ts', 'const x = process.env.NODE_ENV;');
    breaks('no-secret-name-in-browser', 'src/app/a.ts', 'const x = import.meta.env.MODE;');
  });

  it('allows the server to use them', () => {
    clean('server/env.ts', "export const ENV_API_KEY = 'TWELVE_DATA_API_KEY';");
    clean('scripts/dev.ts', 'const e = process.env;');
  });
});

describe('no-absolute-url-in-browser', () => {
  it('bans an address on another origin in browser code', () => {
    breaks('no-absolute-url-in-browser', 'src/data/a.ts', "const u = 'https://example.com/x';");
    breaks('no-absolute-url-in-browser', 'src/data/a.ts', 'const u = "http://example.com";');
    breaks('no-absolute-url-in-browser', 'src/data/a.ts', 'const u = `//cdn.example.com/x.js`;');
  });

  it('allows the SVG namespace, same-origin paths, comments and the server', () => {
    clean('src/ui/dom.ts', "const SVG_NS = 'http://www.w3.org/2000/svg';");
    clean('src/data/a.ts', "const path = '/api/quotes';");
    clean('src/data/a.ts', '// see https://example.com/docs');
    clean('server/twelvedata.ts', "export const BASE = 'https://api.example.com';");
  });
});

describe('network-only-at-the-edge', () => {
  it('bans network primitives anywhere in browser code except src/main.ts', () => {
    for (const code of [
      'window.fetch(url);',
      'globalThis.fetch(url);',
      'const r = await fetch(url);',
      'const x = new XMLHttpRequest();',
      'const s = new WebSocket(url);',
      'const e = new EventSource(url);',
      'navigator.sendBeacon(url, data);',
      'const w = new Worker(url);',
      'navigator.serviceWorker.register(url);',
    ]) {
      breaks('network-only-at-the-edge', 'src/data/a.ts', code);
    }
  });

  it('allows the one place that injects fetch, and code that uses the injected function', () => {
    clean(
      'src/main.ts',
      'mountApp(root, { window, fetch: (input, init) => window.fetch(input, init) });',
    );
    clean('src/data/api-client.ts', 'const response = await fetchImpl(url, init);');
    clean('src/app/context.ts', 'readonly fetch: typeof fetch;');
    clean('src/app/context.ts', 'const r = await env.fetch(url);');
    clean('tests/e2e/a.test.ts', 'await fetch(url);');
  });
});

describe('tests-must-run', () => {
  it('bans focused, skipped and todo tests', () => {
    for (const code of [
      'describe.on' + 'ly("a", () => {});',
      'it.ski' + 'p("a", () => {});',
      'test.to' + 'do("a");',
      'it . on' + 'ly ("a", f);',
    ]) {
      breaks('tests-must-run', 'tests/unit/a.test.ts', code);
    }
  });

  it('allows ordinary tests and other directories', () => {
    clean('tests/unit/a.test.ts', 'describe("a", () => { it("b", () => {}); });');
    clean('src/a.ts', 'const o = { only: 1 }; list.only(1);');
  });
});

describe('no-hardcoded-secret', () => {
  const examples: ReadonlyArray<readonly [string, string]> = [
    ['a GitHub token', 'gh' + 'p_' + 'A'.repeat(36)],
    ['a GitHub token', 'github' + '_pat_' + 'A'.repeat(30)],
    ['an API secret key', 'sk' + '-' + 'a'.repeat(30)],
    ['an AWS access key id', 'AK' + 'IA' + 'A'.repeat(16)],
    ['a Google API key', 'AI' + 'za' + 'a'.repeat(35)],
    ['a Slack token', 'xo' + 'xb-' + '1234567890'],
    ['a private key', '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----'],
    ['a bearer token', 'Bear' + 'er ' + 'abcdefghijklmnopqrstuvwxyz012345'],
    ['a web address with credentials in it', 'https://' + 'bob:hunter2hunter2' + '@example.com/'],
    ['a literal secret', 'api' + 'Key: "' + 'a'.repeat(24) + '"'],
    ['a literal secret', 'pass' + "word = '" + 'x'.repeat(20) + "'"],
  ];

  it('finds a credential of each common kind in any file, and says what it looks like', () => {
    for (const [, value] of examples) {
      for (const path of [
        'server/a.ts',
        'docs/NOTES.md',
        'vercel.json',
        'index.html',
        'tests/unit/a.test.ts',
      ]) {
        breaks('no-hardcoded-secret', path, `const value = ${JSON.stringify(value)};\n${value}`);
      }
    }
    const message = run('src/a.ts', examples[0]?.[1] ?? '')[0]?.message ?? '';
    assert.match(message, /GitHub token/);
    assert.doesNotMatch(
      message,
      new RegExp((examples[0]?.[1] ?? 'x').slice(0, 12)),
      'the message never repeats the secret',
    );
  });

  it('does not flag empty values, short values, names, or documentation placeholders', () => {
    clean('.env.example', '# TWELVE_DATA_API_KEY=');
    clean('src/a.ts', "const token = 'abc'; const secret = 'x';");
    clean('src/a.ts', 'const key = process_env_value;');
    clean('docs/A.md', 'Send the header `Authorization: Bearer <your key>`.');
    clean('docs/A.md', 'Example: https://user:pass@example.com/ (never use real credentials).');
    clean('server/a.ts', "export const ENV_API_KEY = 'TWELVE_DATA_API_KEY';");
    clean('tests/unit/a.test.ts', "env: { TWELVE_DATA_API_KEY: 'twelve-secret-value-1234' }");
  });
});

describe('layering', () => {
  const imports = (...specs: string[]): string =>
    specs.map((spec) => `import { x } from '${spec}';`).join('\n');

  it('keeps core independent of everything', () => {
    breaks('layering', 'src/core/a.ts', imports('../data/x.js'));
    breaks('layering', 'src/core/a.ts', imports('../ui/x.js'));
    clean('src/core/a.ts', imports('./b.js', '../core/c.js'));
  });

  it('lets data and elvoid depend on core and nothing above it', () => {
    for (const above of ['../ui/x.js', '../app/x.js', '../elvoid/x.js', '../../server/x.js']) {
      breaks('layering', 'src/data/a.ts', imports(above));
    }
    breaks('layering', 'src/elvoid/a.ts', imports('../data/x.js'));
    breaks('layering', 'src/elvoid/a.ts', imports('../ui/x.js'));
    clean('src/data/a.ts', imports('../core/x.js', './y.js'));
    clean('src/elvoid/a.ts', imports('../core/x.js', './y.js'));
  });

  it('keeps browser code away from the server, the functions, the scripts and the tests', () => {
    for (const layer of ['src/ui/a.ts', 'src/app/a.ts']) {
      const up = layer.split('/').length - 1;
      const root = '../'.repeat(up);
      for (const forbidden of ['server', 'api', 'scripts', 'tests']) {
        breaks('layering', layer, imports(`${root}${forbidden}/x.js`));
      }
    }
    clean(
      'src/ui/a.ts',
      imports('../app/x.js', '../core/x.js', '../data/x.js', '../elvoid/x.js', './y.js'),
    );
    clean('src/app/a.ts', imports('../core/x.js', '../data/x.js', '../elvoid/x.js', './y.js'));
  });

  it('keeps application state free of the interface, except in the composition root', () => {
    breaks('layering', 'src/app/context.ts', imports('../ui/x.js'));
    breaks('layering', 'src/app/router.ts', imports('../ui/dom.js'));
    clean(
      'src/app/app.ts',
      imports('../ui/shell.js', '../ui/forex/page.js', './context.js', '../core/x.js'),
    );
    breaks('layering', 'src/app/app.ts', imports('../../server/x.js'));
  });

  it('lets the server share core and data, and nothing that draws', () => {
    clean('server/a.ts', imports('../src/core/x.js', '../src/data/x.js', './b.js'));
    breaks('layering', 'server/a.ts', imports('../src/ui/x.js'));
    breaks('layering', 'server/a.ts', imports('../src/app/x.js'));
    breaks('layering', 'server/a.ts', imports('../src/elvoid/x.js'));
    breaks('layering', 'server/a.ts', imports('../tests/x.js'));
  });

  it('lets the function entries wrap the server and nothing else', () => {
    clean('api/a.ts', imports('../server/handlers.js'));
    breaks('layering', 'api/a.ts', imports('../src/core/x.js'));
  });

  it('lets scripts use the server, but not the interface', () => {
    clean('scripts/a.ts', imports('../server/x.js', './b.js'));
    breaks('layering', 'scripts/a.ts', imports('../src/ui/x.js'));
  });

  it('lets only the documentation generator read the ELVOID registry', () => {
    clean('scripts/gen-docs.ts', imports('../src/elvoid/modules.js', './b.js'));
    breaks('layering', 'scripts/gen-docs.ts', imports('../src/ui/x.js'));
    breaks('layering', 'scripts/build.ts', imports('../src/elvoid/modules.js'));
  });

  it('lets src/main.ts wire the app, the interface and the stylesheet', () => {
    clean('src/main.ts', imports('./app/app.js', './ui/x.js', './styles/main.css'));
    breaks('layering', 'src/main.ts', imports('./data/x.js'));
  });

  it('lets tests import anything', () => {
    clean(
      'tests/unit/a.test.ts',
      imports('../../src/ui/x.js', '../../server/x.js', '../../scripts/x.js'),
    );
  });

  it('reads dynamic imports, re-exports and multi-line imports, and skips comments and packages', () => {
    breaks('layering', 'src/core/a.ts', "const m = await import('../ui/x.js');");
    breaks('layering', 'src/core/a.ts', "export * from '../ui/x.js';");
    breaks('layering', 'src/core/a.ts', "export { a } from '../ui/x.js';");
    breaks('layering', 'src/core/a.ts', "import {\n  a,\n  b,\n} from '../ui/x.js';");
    breaks('layering', 'src/core/a.ts', "import '../ui/side-effect.js';");
    clean('src/core/a.ts', "// import { x } from '../ui/x.js';\n * import '../ui/y.js'");
    clean('src/core/a.ts', "import { readFile } from 'node:fs'; import esbuild from 'esbuild';");
  });

  it('reports the line, and names both layers and what is allowed', () => {
    const [violation] = run('src/core/a.ts', "const a = 1;\nimport { x } from '../ui/x.js';");
    assert.equal(violation?.line, 2);
    assert.match(
      violation?.message ?? '',
      /src\/core must not import src\/ui \(\.\.\/ui\/x\.js\)\. Allowed: src\/core\./,
    );
  });

  it('refuses an import that leaves the repository', () => {
    breaks('import-outside-repo', 'src/core/a.ts', imports('../../../x.js'));
  });

  it('knows the layer of each path', () => {
    assert.equal(layerOf('src/main.ts'), 'src/main');
    assert.equal(layerOf('src/core/format.ts'), 'src/core');
    assert.equal(layerOf('src/ui/macro/page.ts'), 'src/ui');
    assert.equal(layerOf('src/env.d.ts'), null);
    assert.equal(layerOf('server/env.ts'), 'server');
    assert.equal(layerOf('api/status.ts'), 'api');
    assert.equal(layerOf('scripts/build.ts'), 'scripts');
    assert.equal(layerOf('tests/unit/a.test.ts'), 'tests');
    assert.equal(layerOf('package.json'), null);
  });
});

describe('package-policy', () => {
  const manifest = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      name: 'x',
      private: true,
      scripts: { build: 'x' },
      devDependencies: { a: '1' },
      ...overrides,
    });

  it('accepts a private package with dev dependencies only', () => {
    clean('package.json', manifest({}));
    clean('package.json', manifest({ dependencies: {} }));
  });

  it('bans runtime dependencies of every kind', () => {
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      breaks('package-policy', 'package.json', manifest({ [key]: { left: '1' } }));
    }
  });

  it('bans scripts that run on install', () => {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      breaks('package-policy', 'package.json', manifest({ scripts: { [name]: 'node x.js' } }));
    }
  });

  it('requires private, and valid JSON', () => {
    breaks('package-policy', 'package.json', manifest({ private: false }));
    breaks('package-policy', 'package.json', '{ not json');
    breaks('package-policy', 'package.json', '[]');
  });

  it('applies to the root package.json only', () => {
    clean('docs/package.json', manifest({ dependencies: { left: '1' } }));
  });
});

describe('gitignore-policy and no-env-file', () => {
  const GOOD = 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n';

  it('requires the entries that keep builds and environment files out of git', () => {
    clean('.gitignore', GOOD);
    for (const required of ['node_modules/', 'dist/', '.env', '.env.*', '!.env.example']) {
      breaks('gitignore-policy', '.gitignore', GOOD.replace(`${required}\n`, ''));
    }
  });

  it('refuses a committed environment file, but not the example', () => {
    for (const path of ['.env', '.env.local', '.env.production', 'config/.env', 'api/.env.test']) {
      breaks('no-env-file', path, 'X=1');
    }
    clean('.env.example', '# X=\n');
  });
});

describe('env-example-values', () => {
  it('allows empty values, booleans, numbers and placeholders, commented or not', () => {
    clean(
      '.env.example',
      [
        '# A=',
        'B=',
        '# C=true',
        'D=60',
        'E=<your key>',
        '# F=your-key-here',
        '# prose with = signs in it',
      ].join('\n'),
    );
  });

  it('refuses a value that could be a real credential, commented or not', () => {
    breaks('env-example-values', '.env.example', '# TWELVE_DATA_API_KEY=abcdef1234567890');
    breaks('env-example-values', '.env.example', 'SOME_SETTING=production-value');
  });

  it('reports the variable name and line, never the value', () => {
    const [violation] = run('.env.example', '\n# MY_VAR=hunter2');
    assert.equal(violation?.line, 2);
    assert.match(violation?.message ?? '', /MY_VAR/);
    assert.doesNotMatch(violation?.message ?? '', /hunter2/);
  });
});

describe('no-external-asset', () => {
  it('refuses a page that loads from another origin', () => {
    breaks(
      'no-external-asset',
      'index.html',
      '<script src="https://cdn.example.com/a.js"></script>',
    );
    breaks(
      'no-external-asset',
      'index.html',
      '<link rel="stylesheet" href="//cdn.example.com/a.css">',
    );
    breaks('no-external-asset', 'public/page.html', "<img src='http://example.com/a.png'>");
  });

  it('accepts same-origin assets and ordinary links in prose', () => {
    clean(
      'index.html',
      '<script type="module" src="/assets/main.js"></script><link rel="icon" href="/favicon.svg">',
    );
  });
});

describe('the policy as a whole', () => {
  it('reports violations in path and line order', () => {
    const found = lintFiles([
      { path: 'src/b.ts', content: 'let a: unknown = 1;\nconsole.log(1);\nMath.random();' },
      { path: 'src/a.ts', content: 'debugger;' },
    ]);
    assert.deepEqual(
      found.map((violation) => `${violation.path}:${violation.line}:${violation.rule}`),
      ['src/a.ts:1:no-debugger', 'src/b.ts:2:no-console-noise', 'src/b.ts:3:no-randomness'],
    );
  });

  it('can report more than one rule for one line', () => {
    assert.deepEqual(
      ids('src/data/a.ts', "const mockFeed = fetch('https://example.com');").sort(),
      ['network-only-at-the-edge', 'no-absolute-url-in-browser', 'no-placeholder-data'],
    );
  });

  it('formats a violation as path:line [rule] message, and omits line 0', () => {
    assert.equal(
      formatViolations([
        { path: 'src/a.ts', line: 3, rule: 'r1', message: 'm1' },
        { path: 'package.json', line: 0, rule: 'r2', message: 'm2' },
      ]),
      'src/a.ts:3  [r1]  m1\npackage.json  [r2]  m2',
    );
  });

  it('keeps unique rule ids', () => {
    assert.equal(new Set(RULE_IDS).size, RULE_IDS.length);
  });

  it('passes the real repository: nothing that could be committed breaks a rule', () => {
    const violations = lintFiles(readProjectFiles(REPO));
    assert.equal(violations.length, 0, `\n${formatViolations(violations)}`);
  });

  it('reads the repository for real: the sources, the docs and the config are all in view', () => {
    const paths = readProjectFiles(REPO).map((file) => file.path);
    for (const expected of [
      'package.json',
      '.gitignore',
      '.env.example',
      'index.html',
      'src/main.ts',
      'server/handlers.ts',
      'scripts/build.ts',
      'tests/unit/core.test.ts',
    ]) {
      assert.ok(paths.includes(expected), `${expected} is not being checked`);
    }
    for (const unexpected of ['dist/', 'node_modules/', '.git/']) {
      assert.ok(
        !paths.some((path) => path.startsWith(unexpected)),
        `${unexpected} should be skipped`,
      );
    }
  });
});

describe('reading a project from disk', () => {
  async function scratch(files: Record<string, string | Buffer>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'elstand-policy-'));
    made.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  }

  it('walks a folder that is not a git repository, skipping installed and built files', async () => {
    const root = await scratch({
      'a.ts': 'x',
      'src/b.ts': 'y',
      'node_modules/p/c.ts': 'z',
      'dist/d.js': 'w',
      '.git/config': 'v',
    });
    assert.deepEqual(candidatePaths(root).sort(), ['a.ts', 'src/b.ts']);
  });

  it('reads text, and skips binary files and listed paths that are gone', async () => {
    const root = await scratch({
      'a.ts': 'const a = 1;',
      'image.bin': Buffer.from([1, 2, 0, 3]),
      'node_modules/x.ts': 'no',
    });
    const files = readProjectFiles(root, [
      'a.ts',
      'image.bin',
      'missing.ts',
      'node_modules/x.ts',
      'a.ts',
    ]);
    assert.deepEqual(files, [{ path: 'a.ts', content: 'const a = 1;' }]);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;');
  });
});

describe('every rule has been shown to fire', () => {
  it('lists no rule that the tests above never triggered', () => {
    const silent = RULE_IDS.filter((id) => !seen.has(id));
    assert.deepEqual(silent, []);
  });
});
