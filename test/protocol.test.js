'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  MIME_TYPES,
  CONTENT_SECURITY_POLICY,
  isAppUrl,
  resolveAppRequest,
  responseHeaders,
} = require('../src/main/protocol-path');

const ROOT = path.resolve(__dirname, '../src/renderer');
const resolve = (url, method) => resolveAppRequest({ url, method }, ROOT);

function assertInsideRoot(filePath) {
  const rel = path.relative(ROOT, filePath);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${filePath} must be inside ${ROOT}`);
}

test('serves files below src/renderer with the right MIME type', () => {
  const cases = [
    ['app://augenpause/widget/index.html', 'text/html; charset=utf-8', ['widget', 'index.html']],
    ['app://augenpause/overlay/index.html?primary=1', 'text/html; charset=utf-8', ['overlay', 'index.html']],
    ['app://augenpause/shared/api.js', 'text/javascript; charset=utf-8', ['shared', 'api.js']],
    ['app://augenpause/shared/tokens.css', 'text/css; charset=utf-8', ['shared', 'tokens.css']],
    ['app://augenpause/dashboard/icons/x.svg', 'image/svg+xml', ['dashboard', 'icons', 'x.svg']],
    ['app://augenpause/a/b.png', 'image/png', ['a', 'b.png']],
    ['app://augenpause/a/data.json', 'application/json; charset=utf-8', ['a', 'data.json']],
    ['app://augenpause/fonts/inter.woff2', 'font/woff2', ['fonts', 'inter.woff2']],
    ['app://augenpause/widget/My%20File.js', 'text/javascript; charset=utf-8', ['widget', 'My File.js']],
    ['app://augenpause/widget/INDEX.HTML', 'text/html; charset=utf-8', ['widget', 'INDEX.HTML']],
  ];
  for (const [url, mime, segments] of cases) {
    const r = resolve(url);
    assert.equal(r.ok, true, url);
    assert.equal(r.status, 200);
    assert.equal(r.mimeType, mime, url);
    assert.equal(r.filePath, path.join(ROOT, ...segments), url);
    assertInsideRoot(r.filePath);
  }
});

test('MIME whitelist is exactly the contract list', () => {
  assert.deepEqual(Object.keys(MIME_TYPES).sort(), ['.css', '.html', '.js', '.json', '.png', '.svg', '.woff2']);
});

test('rejects path traversal in all encodings', () => {
  const attacks = [
    'app://augenpause/../main/main.js',
    'app://augenpause/widget/../../main/main.js',
    'app://augenpause/%2e%2e/main/main.js',
    'app://augenpause/%2E%2E/main/main.js',
    'app://augenpause/widget/%2e%2e/%2e%2e/main/main.js',
    'app://augenpause/.%2e/main/main.js',
    'app://augenpause/widget/..%2f..%2fmain%2fmain.js',
    'app://augenpause/..%5cmain%5cmain.js',
    'app://augenpause/widget/..%5C..%5Cmain%5Cmain.js',
    'app://augenpause/widget\\..\\..\\main\\main.js',
    'app://augenpause/./widget/index.html',
    'app://augenpause/widget/./index.html',
  ];
  for (const url of attacks) {
    const r = resolve(url);
    assert.equal(r.ok, false, url);
    assert.ok([400, 403].includes(r.status), `${url} → ${r.status}`);
  }
});

test('rejects encoded NUL and other control characters', () => {
  for (const url of [
    'app://augenpause/widget/index.html%00.js',
    'app://augenpause/widget/%00/index.html',
    'app://augenpause/widget/a%0a.js',
    'app://augenpause/widget/a%7f.js',
  ]) {
    const r = resolve(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.status, 403, url);
  }
});

test('rejects absolute Windows paths, UNC paths and drive letters', () => {
  for (const url of [
    'app://augenpause/C:/Windows/win.ini',
    'app://augenpause/C%3A/Windows/win.ini',
    'app://augenpause/C%3A%5CWindows%5Cwin.ini',
    'app://augenpause/%5C%5Cserver%5Cshare%5Cx.js',
    'app://augenpause//server/share/x.js',
    'app://augenpause/widget/index.html::$DATA',
    'app://augenpause/widget/index.js%3A%24DATA',
  ]) {
    const r = resolve(url);
    if (r.ok) {
      // "//server/share/x.js" collapses to server/share/x.js below the root – still harmless.
      assertInsideRoot(r.filePath);
    } else {
      assert.ok([400, 403].includes(r.status), `${url} → ${r.status}`);
    }
  }
  assert.equal(resolve('app://augenpause/C:/Windows/win.ini').ok, false);
  assert.equal(resolve('app://augenpause/C%3A%5CWindows%5Cwin.ini').ok, false);
});

test('rejects Windows device names, trailing dots/spaces and dotfiles', () => {
  for (const url of [
    'app://augenpause/widget/CON.js',
    'app://augenpause/widget/nul.html',
    'app://augenpause/widget/com1.css',
    'app://augenpause/widget/index.js.',
    'app://augenpause/widget/index.js%20',
    'app://augenpause/.git/config.json',
    'app://augenpause/widget/.hidden.js',
  ]) {
    const r = resolve(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.status, 403, url);
  }
});

test('double encoding stays a literal file name inside the root', () => {
  const r = resolve('app://augenpause/%252e%252e/main/main.js');
  if (r.ok) assertInsideRoot(r.filePath);
  else assert.ok([400, 403, 404].includes(r.status));
});

test('rejects bad percent encoding', () => {
  const r = resolve('app://augenpause/widget/%E0%A4%A.js');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('rejects non-whitelisted extensions, directories and the bare origin', () => {
  assert.equal(resolve('app://augenpause/widget/evil.exe').status, 403);
  assert.equal(resolve('app://augenpause/widget/favicon.ico').status, 403);
  assert.equal(resolve('app://augenpause/widget/README').status, 403);
  assert.equal(resolve('app://augenpause/main.mjs').status, 403);
  assert.equal(resolve('app://augenpause/widget/').status, 404);
  assert.equal(resolve('app://augenpause/').status, 404);
});

test('only GET is allowed', () => {
  assert.equal(resolve('app://augenpause/widget/index.html', 'POST').status, 405);
  assert.equal(resolve('app://augenpause/widget/index.html', 'PUT').status, 405);
  assert.equal(resolve('app://augenpause/widget/index.html', 'get').ok, true);
  assert.equal(resolve('app://augenpause/widget/index.html', undefined).ok, true);
});

test('rejects foreign origins', () => {
  for (const url of [
    'app://evil/widget/index.html',
    'app://augenpause.evil/widget/index.html',
    'app://augenpause@evil/widget/index.html',
    'app://user:pw@augenpause/widget/index.html',
    'app://augenpause:8080/widget/index.html',
    'http://augenpause/widget/index.html',
    'https://augenpause/widget/index.html',
    'file:///C:/Windows/win.ini',
    'app:augenpause/widget/index.html',
    '',
    null,
  ]) {
    const r = resolve(url);
    assert.equal(r.ok, false, String(url));
    assert.equal(r.status, 403, String(url));
  }
});

test('isAppUrl', () => {
  assert.equal(isAppUrl('app://augenpause/widget/index.html'), true);
  assert.equal(isAppUrl('app://augenpause/'), true);
  assert.equal(isAppUrl('app://augenpause'), false);
  assert.equal(isAppUrl('app://augenpausex/'), false);
  assert.equal(isAppUrl('https://example.com/'), false);
  assert.equal(isAppUrl('devtools://devtools/bundled/inspector.html'), false);
  assert.equal(isAppUrl(`app://augenpause/${'a'.repeat(5000)}`), false);
  assert.equal(isAppUrl(42), false);
});

test('response headers carry the §7 CSP and hardening headers', () => {
  const expectedCsp =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'none'; media-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'";
  assert.equal(CONTENT_SECURITY_POLICY, expectedCsp);
  const h = responseHeaders('text/html; charset=utf-8');
  assert.equal(h['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(h['Content-Security-Policy'], expectedCsp);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Cache-Control'], 'no-cache');
  assert.equal(responseHeaders(null)['Content-Type'], 'text/plain; charset=utf-8');
});
