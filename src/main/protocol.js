'use strict';

/**
 * app://augenpause/ protocol – serves src/renderer (docs/ARCHITECTURE.md §6/§7).
 *
 *   registerPrivilegedScheme()   → MUST be called before app 'ready'
 *   registerAppProtocol({ rootDir, log }) → after 'ready' (default session)
 */

const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');
const { PROTOCOL_SCHEME } = require('./constants');
const { resolveAppRequest, responseHeaders } = require('./protocol-path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', 'renderer');

function registerPrivilegedScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

function errorResponse(status, text) {
  return new Response(text, { status, headers: responseHeaders(null) });
}

/**
 * @param {{ rootDir?: string, log?: (msg: string) => void, protocolModule?: Electron.Protocol }} [options]
 */
function registerAppProtocol(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const log = options.log || ((msg) => console.warn(`[AugenPause:protocol] ${msg}`));
  const target = options.protocolModule || protocol;

  target.handle(PROTOCOL_SCHEME, async (request) => {
    const resolved = resolveAppRequest({ url: request.url, method: request.method }, rootDir);
    if (!resolved.ok) {
      log(`${resolved.status} ${resolved.reason}: ${String(request.url).slice(0, 200)}`);
      const text = resolved.status === 404 ? 'Not found' : resolved.status === 405 ? 'Method not allowed' : 'Forbidden';
      return errorResponse(resolved.status, text);
    }
    try {
      // fs.promises.readFile is asar-aware inside Electron's main process.
      const body = await fs.promises.readFile(resolved.filePath);
      return new Response(body, { status: 200, headers: responseHeaders(resolved.mimeType) });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR')) {
        log(`404 not found: ${String(request.url).slice(0, 200)}`);
        return errorResponse(404, 'Not found');
      }
      log(`500 ${err && err.message}`);
      return errorResponse(500, 'Internal error');
    }
  });

  return { rootDir };
}

module.exports = { registerPrivilegedScheme, registerAppProtocol, RENDERER_ROOT: DEFAULT_ROOT };
