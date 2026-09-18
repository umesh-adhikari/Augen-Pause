'use strict';

/**
 * App-wide hardening (docs/ARCHITECTURE.md §7).
 *
 *   installGlobalSecurity({ isDev, log })  → before or after 'ready' (uses app 'web-contents-created')
 *   hardenSession(session, { isDev, log }) → after 'ready'
 */

const { app, shell } = require('electron');
const { isAppUrl } = require('./protocol-path');

/**
 * https URLs that may be opened in the user's browser via window.open / target=_blank.
 * Intentionally empty – nothing needs external links right now.
 */
const EXTERNAL_URL_ALLOWLIST = Object.freeze([]);

/** Schemes a renderer request may use (everything else – http(s), ws(s), ftp, file … – is cancelled). */
const ALLOWED_REQUEST_PROTOCOLS = Object.freeze(['app:', 'data:', 'blob:', 'about:']);
/** Additionally allowed with --dev (DevTools front-end). */
const DEV_REQUEST_PROTOCOLS = Object.freeze(['devtools:']);

function defaultLog(msg) {
  console.warn(`[AugenPause:security] ${msg}`);
}

function short(url) {
  return String(url || '').slice(0, 200);
}

function isAllowedExternal(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_URL_ALLOWLIST.some((prefix) => url.startsWith(prefix));
  } catch {
    return false;
  }
}

let installed = false;

/**
 * Registers the global web-contents hardening. Idempotent.
 * @param {{ isDev?: boolean, log?: (msg: string) => void }} [options]
 */
function installGlobalSecurity(options = {}) {
  if (installed) return;
  installed = true;
  const log = options.log || defaultLog;
  const isDev = Boolean(options.isDev);

  app.on('web-contents-created', (_event, contents) => {
    // No new windows. External https links only for an explicit allowlist (currently none).
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternal(url)) {
        shell.openExternal(url).catch((err) => log(`openExternal failed: ${err && err.message}`));
      } else {
        log(`blocked window.open: ${short(url)}`);
      }
      return { action: 'deny' };
    });

    const guardNavigation = (kind) => (event, legacyUrl) => {
      const url = (event && event.url) || legacyUrl;
      if (!isAppUrl(url)) {
        event.preventDefault();
        log(`blocked ${kind}: ${short(url)}`);
      }
    };
    contents.on('will-navigate', guardNavigation('navigation'));
    contents.on('will-frame-navigate', guardNavigation('frame navigation'));
    contents.on('will-redirect', guardNavigation('redirect'));

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      log('blocked <webview>');
    });

    if (!isDev) {
      // devTools is already false in webPreferences for production; belt and braces.
      contents.on('devtools-opened', () => contents.closeDevTools());
    }
  });
}

/**
 * Deny all permissions, downloads and non-app network requests for a session.
 * @param {Electron.Session} ses
 * @param {{ isDev?: boolean, log?: (msg: string) => void }} [options]
 */
function hardenSession(ses, options = {}) {
  const log = options.log || defaultLog;
  const allowedProtocols = new Set([...ALLOWED_REQUEST_PROTOCOLS, ...(options.isDev ? DEV_REQUEST_PROTOCOLS : [])]);

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    log(`denied permission request: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    try {
      item.cancel();
    } catch {
      /* ignore */
    }
    log(`blocked download: ${short(item && item.getURL && item.getURL())}`);
  });

  // Defense in depth on top of the CSP: renderers never talk to the network or the file system.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      allowed = allowedProtocols.has(new URL(details.url).protocol);
    } catch {
      allowed = false;
    }
    if (!allowed) log(`blocked request: ${short(details.url)}`);
    callback({ cancel: !allowed });
  });

  if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);
}

module.exports = { installGlobalSecurity, hardenSession, EXTERNAL_URL_ALLOWLIST };
