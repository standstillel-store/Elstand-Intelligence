import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runBuild } from '../../scripts/build.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const made: string[] = [];
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listAll(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listAll(join(dir, entry.name), base)
        : Promise.resolve([join(dir, entry.name).slice(base.length + 1)]),
    ),
  );
  return nested.flat().sort();
}

const CANARY = 'canary-twelve-data-key-0123456789';

describe('the production build of this repository', () => {
  const state: { outDir: string; files: readonly string[]; js: string; css: string; html: string } =
    {
      outDir: '',
      files: [],
      js: '',
      css: '',
      html: '',
    };

  it('builds with a credential-looking variable in the environment', async () => {
    state.outDir = await scratch('elstand-prod-');
    const report = await runBuild({
      rootDir: REPO,
      outDir: join(state.outDir, 'dist'),
      env: { TWELVE_DATA_API_KEY: CANARY, NODE_ENV: 'production' },
    });
    state.files = await listAll(join(state.outDir, 'dist'));
    state.js = await readFile(join(state.outDir, 'dist', report.js), 'utf8');
    state.css = await readFile(join(state.outDir, 'dist', report.css), 'utf8');
    state.html = await readFile(join(state.outDir, 'dist', 'index.html'), 'utf8');
    assert.match(report.js, /^\/assets\/main-[A-Za-z0-9]+\.js$/);
    assert.match(report.css, /^\/assets\/main-[A-Za-z0-9]+\.css$/);
  });

  it('ships exactly the page, one script, one stylesheet and the icon', () => {
    assert.equal(state.files.length, 4, state.files.join(', '));
    assert.ok(state.files.includes('index.html'));
    assert.ok(state.files.includes('favicon.svg'));
    assert.equal(
      state.files.filter((file) => /^assets\/main-[A-Za-z0-9]+\.js$/.test(file)).length,
      1,
    );
    assert.equal(
      state.files.filter((file) => /^assets\/main-[A-Za-z0-9]+\.css$/.test(file)).length,
      1,
    );
    assert.equal(state.files.filter((file) => file.endsWith('.map')).length, 0, 'no source maps');
  });

  it('points the page at the hashed files, with no leftover template reference', () => {
    assert.doesNotMatch(state.html, /\/assets\/main\.(js|css)/);
    for (const file of state.files.filter((name) => name.startsWith('assets/'))) {
      assert.ok(state.html.includes(`/${file}`), `index.html does not reference ${file}`);
    }
  });

  it('keeps the credential out of every shipped file', async () => {
    for (const file of state.files) {
      const content = await readFile(join(state.outDir, 'dist', file), 'utf8');
      assert.ok(!content.includes(CANARY), `${file} contains the canary value`);
    }
  });

  it('reads no environment in the browser, and has no eval and no vendor host', () => {
    assert.doesNotMatch(state.js, /process\.env/);
    assert.doesNotMatch(state.js, /\beval\s*\(/);
    assert.doesNotMatch(state.js, /new\s+Function\s*\(/);
    assert.doesNotMatch(state.js, /twelvedata/i);
    assert.doesNotMatch(
      state.js,
      /TWELVE_DATA_API_KEY/,
      'the browser does not even know the variable name',
    );
  });

  it('contains no absolute URL except the SVG namespace, so nothing can phone home', async () => {
    const urls = new Set<string>();
    for (const file of state.files) {
      const content = await readFile(join(state.outDir, 'dist', file), 'utf8');
      for (const match of content.matchAll(/https?:\/\/[^\s"'`)\\<>]+/g)) urls.add(match[0]);
    }
    assert.deepEqual([...urls], ['http://www.w3.org/2000/svg']);
  });

  it('contains the words the product promises, and no marker of test fixtures or sample data', () => {
    assert.ok(state.js.includes('ENV NOT CONNECTION'));
    for (const marker of [
      'TEST FIXTURES',
      'NOT MARKET DATA',
      'test fixture, not market data',
      'Fixture ',
      'example.invalid',
    ]) {
      assert.ok(!state.js.includes(marker), `the bundle contains "${marker}"`);
    }
  });

  it('has no inline script or style, because the CSP would block them', () => {
    assert.doesNotMatch(state.html, /<script(?![^>]*\ssrc=)/i);
    assert.doesNotMatch(state.html, /<style[\s>]/i);
    assert.doesNotMatch(state.html, /\sstyle\s*=/i);
    assert.doesNotMatch(state.html, /\son[a-z]+\s*=/i);
  });

  it('stays small: it has no runtime dependencies, so a size jump means something was pulled in', () => {
    const jsGzip = gzipSync(state.js).length;
    const cssGzip = gzipSync(state.css).length;
    assert.ok(jsGzip < 80 * 1024, `JavaScript is ${(jsGzip / 1024).toFixed(1)} kB gzipped`);
    assert.ok(cssGzip < 12 * 1024, `CSS is ${(cssGzip / 1024).toFixed(1)} kB gzipped`);
  });

  it('is reproducible: building the same source twice gives the same file names and bytes', async () => {
    const again = await scratch('elstand-prod-again-');
    await runBuild({ rootDir: REPO, outDir: join(again, 'dist'), env: {} });
    const files = await listAll(join(again, 'dist'));
    assert.deepEqual(files, state.files);
    for (const file of files) {
      assert.equal(
        await readFile(join(again, 'dist', file), 'utf8'),
        await readFile(join(state.outDir, 'dist', file), 'utf8'),
        `${file} differs between builds`,
      );
    }
  });
});

describe('the build guards, on small projects that break each rule', () => {
  const HTML = [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/assets/main.css">',
    '<script type="module" src="/assets/main.js"></script>',
    '</head><body><div id="app"></div></body></html>',
  ].join('');

  async function project(files: Record<string, string>): Promise<{ root: string; out: string }> {
    const root = await scratch('elstand-mini-');
    const all: Record<string, string> = {
      'index.html': HTML,
      'src/main.ts': "import './style.css';\ndocument.title = 'ok';\n",
      'src/style.css': 'body{margin:0}\n',
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return { root, out: join(root, 'out') };
  }

  const build = (
    root: string,
    out: string,
    extra: Partial<Parameters<typeof runBuild>[0]> = {},
  ): ReturnType<typeof runBuild> =>
    runBuild({ rootDir: root, outDir: out, publicDir: null, env: {}, ...extra });

  it('accepts a clean project (so the failures below are caused by what they break)', async () => {
    const { root, out } = await project({});
    const report = await build(root, out);
    assert.ok(report.js.startsWith('/assets/main-'));
    assert.ok(await exists(join(out, 'index.html')));
  });

  it('fails the build when a credential value reaches the output, naming the variable and never the value', async () => {
    const value = 'leaky-secret-value-0001';
    const { root, out } = await project({
      'src/main.ts': `import './style.css';\nconst k = '${value}';\ndocument.title = k;\n`,
    });
    await assert.rejects(build(root, out, { env: { DEMO_API_KEY: value } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Build guard failed/);
      assert.match(error.message, /DEMO_API_KEY/);
      assert.ok(!error.message.includes(value), 'the error message printed the secret');
      return true;
    });
    assert.equal(await exists(out), false, 'a failed build must leave no output behind');
  });

  it('fails the build when browser code imports test code', async () => {
    const { root, out } = await project({
      'src/main.ts':
        "import './style.css';\nimport { sample } from '../tests/helper.js';\ndocument.title = sample;\n",
      'tests/helper.ts': "export const sample = 'x';\n",
    });
    await assert.rejects(
      build(root, out),
      /forbidden input in the browser bundle: tests\/helper\.ts/,
    );
    assert.equal(await exists(out), false);
  });

  it('fails the build when browser code imports a file named like a fixture or a mock', async () => {
    for (const name of ['quotes.fixture', 'mock-feed', 'sample']) {
      const { root, out } = await project({
        'src/main.ts': `import './style.css';\nimport { value } from './${name}.js';\ndocument.title = value;\n`,
        [`src/${name}.ts`]: "export const value = 'x';\n",
      });
      await assert.rejects(
        build(root, out),
        new RegExp(`forbidden input in the browser bundle: src/${name.replace('.', '\\.')}\\.ts`),
        name,
      );
    }
  });

  it('fails the build when browser code imports server code', async () => {
    const { root, out } = await project({
      'src/main.ts':
        "import './style.css';\nimport { key } from '../server/env.js';\ndocument.title = key;\n",
      'server/env.ts': "export const key = 'x';\n",
    });
    await assert.rejects(
      build(root, out),
      /forbidden input in the browser bundle: server\/env\.ts/,
    );
  });

  it('fails the build when the bundle reads process.env or calls eval', async () => {
    for (const [code, pattern] of [
      ['document.title = String(process.env.SOMETHING);', /process\.env/],
      ["document.title = String(globalThis.eval('1'));", /eval\(\)/],
      ["document.title = String(new Function('return 1')());", /new Function\(\)/],
    ] as const) {
      const { root, out } = await project({ 'src/main.ts': `import './style.css';\n${code}\n` });
      await assert.rejects(build(root, out), pattern, code);
    }
  });

  it('fails the build when the page carries inline script, inline style or an event handler', async () => {
    for (const [html, pattern] of [
      [HTML.replace('</head>', '<script>1</script></head>'), /inline <script> without src/],
      [HTML.replace('</head>', '<style>a{}</style></head>'), /inline <style> element/],
      [
        HTML.replace('<div id="app">', '<div id="app" style="color:red">'),
        /inline style="" attribute/,
      ],
      [
        HTML.replace('<div id="app">', '<div id="app" onclick="x()">'),
        /inline event-handler attribute/,
      ],
    ] as const) {
      const { root, out } = await project({ 'index.html': html });
      await assert.rejects(build(root, out), pattern);
    }
  });

  it('fails the build when the page does not reference its own bundle exactly once', async () => {
    const { root, out } = await project({
      'index.html': HTML.replace('<link rel="stylesheet" href="/assets/main.css">', ''),
    });
    await assert.rejects(build(root, out), /Expected exactly one reference to \/assets\/main\.css/);
    const twice = await project({
      'index.html': HTML.replace(
        '</head>',
        '<link rel="stylesheet" href="/assets/main.css"></head>',
      ),
    });
    await assert.rejects(build(twice.root, twice.out), /found 2/);
  });

  it('lets the browser-test harness include fixtures, but still refuses a leaked secret', async () => {
    const value = 'leaky-secret-value-0002';
    const withTests = await project({
      'src/main.ts':
        "import './style.css';\nimport { sample } from '../tests/helper.js';\ndocument.title = sample;\n",
      'tests/helper.ts': "export const sample = 'x';\n",
    });
    await build(withTests.root, withTests.out, { productionGuards: false });
    assert.ok(await exists(join(withTests.out, 'index.html')));

    const leaking = await project({
      'src/main.ts': `import './style.css';\ndocument.title = '${value}';\n`,
    });
    await assert.rejects(
      build(leaking.root, leaking.out, { productionGuards: false, env: { HARNESS_TOKEN: value } }),
      /HARNESS_TOKEN/,
    );
  });

  it('clears an earlier build first, so a stale file can never be served', async () => {
    const { root, out } = await project({});
    await mkdir(join(out, 'assets'), { recursive: true });
    await writeFile(join(out, 'assets', 'stale.js'), 'old');
    await build(root, out);
    assert.equal(await exists(join(out, 'assets', 'stale.js')), false);
  });

  it('copies the public directory next to the page', async () => {
    const { root, out } = await project({
      'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    await build(root, out, { publicDir: 'public' });
    assert.ok(await exists(join(out, 'favicon.svg')));
  });

  it('names the files by their content: a change to the code changes the name, so caches cannot go stale', async () => {
    const one = await project({});
    const two = await project({
      'src/main.ts': "import './style.css';\ndocument.title = 'different';\n",
    });
    const a = await build(one.root, one.out);
    const b = await build(two.root, two.out);
    assert.notEqual(a.js, b.js);
    assert.equal(a.css, b.css, 'the stylesheet did not change, so its name did not');
  });
});
