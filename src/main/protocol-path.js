'use strict';

/**
 * Pure (electron-free) request → file resolution for the app:// protocol.
 * Used by protocol.js and unit-tested in test/protocol.test.js.
 */

const path = require('node:path');
const { PROTOCOL_SCHEME, PROTOCOL_HOST, APP_ORIGIN } = require('./constants');

/** Strict extension → MIME map. Anything else is refused. */
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

/** Content-Security-Policy – docs/ARCHITECTURE.md §7 (sent as response header on every app:// response). */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_URL_LENGTH = 2048;
const MAX_SEGMENTS = 16;

// Windows reserved device names (CON, NUL, COM1 …) – never valid renderer files.
const WIN_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function fail(status, reason) {
  return { ok: false, status, reason };
}

/**
 * True when `url` is an app://augenpause/… URL (exact origin, no credentials, no port).
 * @param {string} url
 */
function isAppUrl(url) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === `${PROTOCOL_SCHEME}:` &&
    u.hostname === PROTOCOL_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    url.toLowerCase().startsWith(`${APP_ORIGIN}/`)
  );
}

/**
 * Resolve an app:// request to a file below `rootDir`.
 *
 * @param {{ url: string, method?: string }} request
 * @param {string} rootDir absolute path of src/renderer
 * @returns {{ ok: true, status: 200, filePath: string, mimeType: string }
 *         | { ok: false, status: 400|403|404|405, reason: string }}
 */
function resolveAppRequest(request, rootDir) {
  const method = String((request && request.method) || 'GET').toUpperCase();
  if (method !== 'GET') return fail(405, 'method-not-allowed');

  const url = request && request.url;
  if (!isAppUrl(url)) return fail(403, 'foreign-origin');

  // Work on the raw (still percent-encoded) path so that encoded traversal
  // attempts are visible to us before the URL parser normalises anything.
  const afterOrigin = url.slice(APP_ORIGIN.length);
  const rawPath = afterOrigin.split(/[?#]/, 1)[0];
  if (!rawPath.startsWith('/')) return fail(400, 'bad-path');
  if (rawPath.includes('\\')) return fail(403, 'backslash');

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return fail(400, 'bad-encoding');
  }

  if (/[\u0000-\u001f\u007f]/.test(decoded)) return fail(403, 'control-char');
  if (decoded.includes('\\')) return fail(403, 'backslash');
  if (decoded.includes(':')) return fail(403, 'colon'); // drive letters, NTFS streams

  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.length === 0) return fail(404, 'no-file');
  if (segments.length > MAX_SEGMENTS) return fail(403, 'too-deep');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return fail(403, 'traversal');
    if (seg.startsWith('.')) return fail(403, 'dotfile');
    if (/[<>"|?*]/.test(seg)) return fail(403, 'bad-char');
    if (WIN_DEVICE_RE.test(seg) || /[. ]$/.test(seg)) return fail(403, 'bad-name');
  }
  if (decoded.endsWith('/')) return fail(404, 'directory');

  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, ...segments);
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return fail(403, 'outside-root');

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = Object.prototype.hasOwnProperty.call(MIME_TYPES, ext) ? MIME_TYPES[ext] : null;
  if (!mimeType) return fail(403, 'mime-not-allowed');

  return { ok: true, status: 200, filePath, mimeType };
}

/** Response headers for a served file (or an error response when mimeType is omitted). */
function responseHeaders(mimeType) {
  return {
    'Content-Type': mimeType || 'text/plain; charset=utf-8',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
  };
}

module.exports = {
  MIME_TYPES,
  CONTENT_SECURITY_POLICY,
  isAppUrl,
  resolveAppRequest,
  responseHeaders,
};
