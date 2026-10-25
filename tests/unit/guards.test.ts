import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BANNED_BUNDLE_PATTERNS,
  findBannedBundleStrings,
  findForbiddenInputs,
  findInlineCodeInHtml,
  findSecretLeaks,
  runGuards,
  SECRET_NAME_PATTERN,
} from '../../scripts/guards.js';

const files = (entries: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(entries));

describe('findForbiddenInputs: what must never reach the browser bundle', () => {
  it('flags test code, fixtures, mocks, samples, demos and simulators by directory', () => {
    const bad = [
      'tests/support/fixtures.ts',
      'src/tests/helper.ts',
      'src/__tests__/a.ts',
      'src/fixtures/quotes.ts',
      'src/fixture/quotes.ts',
      'src/mocks/provider.ts',
      'src/samples/data.ts',
      'src/demo/page.ts',
      'src/simulation/feed.ts',
      'src/simulator/feed.ts',
    ];
    assert.deepEqual(findForbiddenInputs(bad), bad);
  });

  it('flags server-only code and tooling by directory', () => {
    const bad = ['server/twelvedata.ts', 'api/quotes.ts', 'scripts/build.ts', 'src/server/env.ts'];
    assert.deepEqual(findForbiddenInputs(bad), bad);
  });

  it('flags files named like fixtures, mocks, samples, demos, simulations, tests or specs', () => {
    const bad = [
      'src/data/quotes.fixture.ts',
      'src/data/quotes-fixtures.ts',
      'src/data/mock-provider.ts',
      'src/data/provider.mock.ts',
      'src/data/sample.ts',
      'src/data/demo.ts',
      'src/data/simulated-feed.ts',
      'src/data/simulate.ts',
      'src/core/format.test.ts',
      'src/core/format.spec.ts',
      'src/core/test-utils.ts',
      'src/core/test.ts',
    ];
    assert.deepEqual(findForbiddenInputs(bad), bad);
  });

  it('lets the real source through, including names that only contain those words', () => {
    const fine = [
      'src/main.ts',
      'src/app/app.ts',
      'src/data/api-client.ts',
      'src/data/http-provider.ts',
      'src/data/service.ts',
      'src/ui/forex/page.ts',
      'src/ui/macro/surface-render.ts',
      'src/ui/latest.ts',
      'src/core/contest.ts',
      'src/core/attestation.ts',
      'src/core/resource.ts',
      'src/styles/main.css',
      'node_modules/esbuild/lib/main.js',
    ];
    assert.deepEqual(findForbiddenInputs(fine), []);
  });

  it('matches names without case sensitivity', () => {
    assert.deepEqual(
      findForbiddenInputs(['src/Fixtures/a.ts', 'src/data/Mock-Provider.ts']).length,
      2,
    );
  });
});

describe('findSecretLeaks: no credential value may appear in the build output', () => {
  const env = {
    TWELVE_DATA_API_KEY: 'twelve-secret-value-1234',
    SOME_TOKEN: 'token-value-98765',
    NODE_ENV: 'production',
    PATH: '/usr/bin:/bin',
  };

  it('finds the value of a credential-looking variable in any output file, and reports only the name', () => {
    const leaks = findSecretLeaks(
      files({
        'assets/main.js': 'const a = "twelve-secret-value-1234";',
        'assets/main.css': 'body{}',
        'index.html': '<p>token-value-98765</p>',
      }),
      env,
    );
    assert.deepEqual(leaks, [
      { file: 'assets/main.js', variable: 'TWELVE_DATA_API_KEY' },
      { file: 'index.html', variable: 'SOME_TOKEN' },
    ]);
    assert.doesNotMatch(JSON.stringify(leaks), /twelve-secret-value-1234|token-value-98765/);
  });

  it('finds a value embedded in a longer string', () => {
    assert.equal(
      findSecretLeaks(
        files({ 'a.js': 'fetch("https://x.test/?apikey=twelve-secret-value-1234&y=1")' }),
        env,
      ).length,
      1,
    );
  });

  it('finds nothing in a clean output', () => {
    assert.deepEqual(
      findSecretLeaks(
        files({ 'assets/main.js': 'console.warn("hi")', 'index.html': '<html></html>' }),
        env,
      ),
      [],
    );
  });

  it('ignores variables that do not look like credentials, such as NODE_ENV and PATH', () => {
    assert.deepEqual(findSecretLeaks(files({ 'a.js': 'production /usr/bin:/bin' }), env), []);
  });

  it('ignores short or missing values, which would match almost anything', () => {
    assert.deepEqual(
      findSecretLeaks(files({ 'a.js': 'abc 1234567 undefined' }), {
        SHORT_KEY: 'abc',
        API_SECRET: '1234567',
        EMPTY_TOKEN: '',
        MISSING_KEY: undefined,
      }),
      [],
    );
    assert.equal(
      findSecretLeaks(files({ 'a.js': '12345678' }), { API_SECRET: '12345678' }).length,
      1,
      'eight characters is enough',
    );
  });

  it('recognises credential names in any case and in any position', () => {
    for (const name of [
      'API_KEY',
      'api_key',
      'MY_SECRET',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      'DB_PASSWD',
      'AWS_CREDENTIALS',
      'PRIVATE_THING',
      'BASIC_AUTH',
      'KEYCHAIN',
    ]) {
      assert.match(name, SECRET_NAME_PATTERN, name);
    }
    for (const name of [
      'NODE_ENV',
      'PATH',
      'HOME',
      'ELSTAND_FEED_REALTIME',
      'ELSTAND_REFRESH_SECONDS',
    ]) {
      assert.doesNotMatch(name, SECRET_NAME_PATTERN, name);
    }
  });
});

describe('findBannedBundleStrings', () => {
  it('flags process.env, eval, new Function and the vendor host in JavaScript', () => {
    const found = findBannedBundleStrings(
      files({
        'a.js': 'x = process.env.FOO',
        'b.js': 'eval("1")',
        'c.js': 'new Function("return 1")',
        'd.js': 'fetch("https://api.twelvedata.com/quote")',
      }),
    );
    assert.equal(found.length, 4);
    assert.ok(found[0]?.startsWith('a.js: process.env'));
    assert.ok(found[1]?.startsWith('b.js: eval()'));
    assert.ok(found[2]?.startsWith('c.js: new Function()'));
    assert.ok(found[3]?.startsWith('d.js: the vendor API host'));
  });

  it('looks only at JavaScript files', () => {
    assert.deepEqual(
      findBannedBundleStrings(
        files({
          'a.css': '/* process.env eval( */',
          'index.html': '<p>api.twelvedata.com</p>',
          'icon.svg': 'eval(',
        }),
      ),
      [],
    );
  });

  it('does not mistake longer words for eval', () => {
    assert.deepEqual(
      findBannedBundleStrings(
        files({ 'a.js': 'evaluate(1); retrieval (2); medieval(3); x.eval2(4)' }),
      ),
      [],
    );
  });

  it('catches eval written with a space before the bracket', () => {
    assert.equal(findBannedBundleStrings(files({ 'a.js': 'eval  ("1")' })).length, 1);
  });

  it('keeps a named rule for each banned pattern', () => {
    assert.equal(BANNED_BUNDLE_PATTERNS.length, 4);
    for (const rule of BANNED_BUNDLE_PATTERNS) assert.ok(rule.name.length > 4);
  });
});

describe('findInlineCodeInHtml: the CSP runs no inline code, so none may ship', () => {
  it('accepts a page whose script and style are external', () => {
    assert.deepEqual(
      findInlineCodeInHtml(
        '<!doctype html><html><head><link rel="stylesheet" href="/a.css"><script type="module" src="/a.js"></script></head><body><div id="app" data-style="x"></div></body></html>',
      ),
      [],
    );
  });

  it('flags an inline script, an inline style element, a style attribute and an event handler', () => {
    assert.deepEqual(findInlineCodeInHtml('<script>alert(1)</script>'), [
      'inline <script> without src',
    ]);
    assert.deepEqual(findInlineCodeInHtml('<style>body{}</style>'), ['inline <style> element']);
    assert.deepEqual(findInlineCodeInHtml('<div style="color:red"></div>'), [
      'inline style="" attribute',
    ]);
    assert.deepEqual(findInlineCodeInHtml('<button onclick="go()">x</button>'), [
      'inline event-handler attribute',
    ]);
  });

  it('flags a script tag that has attributes but no src', () => {
    assert.deepEqual(findInlineCodeInHtml('<script type="module">import "./a.js"</script>'), [
      'inline <script> without src',
    ]);
  });
});

describe('runGuards', () => {
  const clean = {
    inputPaths: ['src/main.ts', 'src/app/app.ts'],
    outputFiles: files({
      'assets/main.js': 'ok',
      'index.html': '<script type="module" src="/assets/main.js"></script>',
    }),
    html: '<script type="module" src="/assets/main.js"></script>',
    env: { NODE_ENV: 'production' },
    checkBundleContent: true,
  } as const;

  it('passes a clean production build', () => {
    assert.deepEqual(runGuards(clean), []);
  });

  it('collects every kind of violation, one line each', () => {
    const problems = runGuards({
      inputPaths: ['src/main.ts', 'tests/support/fixtures.ts', 'server/env.ts'],
      outputFiles: files({ 'assets/main.js': 'secret-token-value process.env.X eval("1")' }),
      html: '<script>1</script>',
      env: { MY_TOKEN: 'secret-token-value' },
      checkBundleContent: true,
    });
    assert.deepEqual(problems, [
      'secret leak: the value of MY_TOKEN appears in assets/main.js',
      'forbidden input in the browser bundle: tests/support/fixtures.ts',
      'forbidden input in the browser bundle: server/env.ts',
      'banned content: assets/main.js: process.env (the browser must not read the environment)',
      'banned content: assets/main.js: eval()',
      'index.html: inline <script> without src',
    ]);
    assert.doesNotMatch(
      problems.join('\n'),
      /secret-token-value/,
      'the secret itself is never printed',
    );
  });

  it('still checks secrets, and only secrets, for the browser-test harness build', () => {
    const harness = {
      inputPaths: ['tests/support/fixtures.ts'],
      outputFiles: files({ 'assets/entry.js': 'process.env eval("1")' }),
      html: '<script>1</script>',
      env: {},
      checkBundleContent: false,
    } as const;
    assert.deepEqual(runGuards(harness), []);
    assert.equal(
      runGuards({
        ...harness,
        outputFiles: files({ 'assets/entry.js': 'keep-this-value-out' }),
        env: { A_SECRET: 'keep-this-value-out' },
      }).length,
      1,
    );
  });
});
