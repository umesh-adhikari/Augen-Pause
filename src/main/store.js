'use strict';

/**
 * Atomic JSON persistence helpers (pure Node, no Electron).
 *
 * - readJson(filePath, options?)           → { ok, data, error }   error: 'ENOENT' | 'EPARSE' | 'ETOOBIG' | <fs error code>
 *     options.maxBytes (default MAX_READ_BYTES = 4 MB)  larger files are NOT read/parsed → 'ETOOBIG'
 * - writeJsonAtomic(filePath, d, options?) → { ok, error }         never throws
 *     options.fsync  (default true)  fsync the temp file before the rename (false = cheaper, less durable)
 *     options.pretty (default true)  2-space indented JSON (false = compact)
 * - backupCorrupt(filePath)                → backup path | null    never throws
 * - createJsonFileSlot(filePath, options?) → { filePath, maxBytes, lastError, load(), save(obj), clear() }
 *     never throws. A single small JSON document (e.g. `session.json` for the scheduler's
 *     `breakStore`, §11).
 *     load() → parsed value | null (missing / unreadable / corrupt / larger than `options.maxBytes`,
 *     default SLOT_MAX_BYTES = 1 MB), save(obj) → boolean, clear() → boolean (file removed, already
 *     absent or overwritten with `null`). Writes are atomic, compact and – by default – without
 *     fsync (`options.fsync`), because they happen every few seconds.
 *     `lastError` (review fix L5) holds the error code of the last failed save()/clear() – `null`
 *     after a successful one – so the caller (main) can log a slot that cannot be written or
 *     deleted at all. A record that can never be cleared cannot resume a break forever either:
 *     the scheduler additionally rejects records older than its resume window (§11).
 *
 * Size caps (review fix L1): a huge file (a 24 MB `session.json` parses in ~70 ms, a 2 GB one stalls
 * the app) is treated like a corrupt file instead of being read into memory and parsed. The size is
 * checked with fs.statSync BEFORE readFileSync, so nothing large is ever allocated.
 *
 * Writes go to `<file>.tmp-<pid>` first (fsync'ed unless `fsync: false`) and are then
 * renamed over the target, so the target is always either the old or the new complete
 * file. On Windows an antivirus scanner / indexer frequently holds a short-lived
 * handle on the target which makes rename fail with EPERM/EBUSY/EACCES – those
 * errors are retried with a small synchronous back-off.
 */

const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
/** Default size cap for readJson (settings.json / stats.json are a few KB; 400 days of stats ≈ 50 KB). */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Default size cap for a createJsonFileSlot document (session.json is ~120 bytes). */
const SLOT_MAX_BYTES = 1024 * 1024;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

/** Runs fn, retrying on transient Windows file-locking errors. */
function withRetry(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!err || !RETRYABLE_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/** Size cap from an options object (`maxBytes`), falling back to `fallback`. */
function maxBytesOf(options, fallback) {
  const v = options !== null && typeof options === 'object' ? options.maxBytes : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Reads and parses a JSON file. Files larger than `options.maxBytes` (default MAX_READ_BYTES) are
 * reported as 'ETOOBIG' without being read – the caller treats them like a corrupt file (L1).
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: true, data: any, error: null } | { ok: false, data: null, error: string }}
 */
function readJson(filePath, options) {
  const maxBytes = maxBytesOf(options, MAX_READ_BYTES);
  try {
    const st = withRetry(() => fs.statSync(filePath));
    if (st.isFile() && st.size > maxBytes) return { ok: false, data: null, error: 'ETOOBIG' };
  } catch (err) {
    return { ok: false, data: null, error: (err && err.code) || 'ESTAT' };
  }
  let text;
  try {
    text = withRetry(() => fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, data: null, error: (err && err.code) || 'EREAD' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM (hand-edited files)
  try {
    return { ok: true, data: JSON.parse(text), error: null };
  } catch {
    return { ok: false, data: null, error: 'EPARSE' };
  }
}

function writeFileDurable(filePath, contents, fsync) {
  const buf = Buffer.from(contents, 'utf8');
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    for (let offset = 0; offset < buf.length; ) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset, offset);
    }
    if (fsync) {
      try {
        fs.fsyncSync(fd);
      } catch {
        /* fsync unsupported on some file systems – not fatal */
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomically writes `data` as JSON to `filePath` (creates parent dirs).
 * @param {string} filePath
 * @param {any} data
 * @param {{ fsync?: boolean, pretty?: boolean }} [options] defaults: fsync true, pretty true
 * @returns {{ ok: boolean, error: string|null }}
 */
function writeJsonAtomic(filePath, data, options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const fsync = opts.fsync !== false;
  const pretty = opts.pretty !== false;
  let json;
  try {
    json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  } catch {
    return { ok: false, error: 'ESERIALIZE' };
  }
  if (typeof json !== 'string') return { ok: false, error: 'ESERIALIZE' };

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    withRetry(() => writeFileDurable(tmpPath, `${json}\n`, fsync));
  } catch (err) {
    safeUnlink(tmpPath);
    return { ok: false, error: (err && err.code) || 'EWRITE' };
  }

  try {
    withRetry(() => fs.renameSync(tmpPath, filePath));
    return { ok: true, error: null };
  } catch (err) {
    // Last resort for a target that stays locked against delete/rename: copy the
    // fully written temp file over it (not atomic, but a torn file would be
    // detected as corrupt on the next load and backed up).
    if (err && RETRYABLE_CODES.has(err.code)) {
      try {
        fs.copyFileSync(tmpPath, filePath);
        safeUnlink(tmpPath);
        return { ok: true, error: null };
      } catch {
        /* fall through */
      }
    }
    safeUnlink(tmpPath);
    return { ok: false, error: (err && err.code) || 'ERENAME' };
  }
}

/**
 * Moves a corrupt file aside to `<name>.corrupt-<timestamp><ext>` so a fresh
 * file can be written. Returns the backup path or null if nothing was moved.
 */
function backupCorrupt(filePath) {
  const ext = path.extname(filePath) || '.json';
  const base = path.extname(filePath) ? filePath.slice(0, -ext.length) : filePath;
  const stamp = Date.now();
  let target = `${base}.corrupt-${stamp}${ext}`;
  for (let n = 1; fs.existsSync(target) && n < 1000; n += 1) {
    target = `${base}.corrupt-${stamp}-${n}${ext}`;
  }
  try {
    withRetry(() => fs.renameSync(filePath, target));
    return target;
  } catch {
    try {
      fs.copyFileSync(filePath, target);
      safeUnlink(filePath);
      return target;
    } catch {
      return null;
    }
  }
}

/**
 * A single JSON document with load / save / clear – shaped like the scheduler's `breakStore` option.
 *
 * `lastError` is the error code of the last failed save() / clear() and `null` after a successful
 * one, so main can log a slot it can neither write nor delete (review fix L5). Note that a `clear()`
 * which fails permanently cannot resume a break forever: the scheduler rejects saved records that
 * are older than its resume window (§11).
 *
 * @param {string} filePath
 * @param {{ fsync?: boolean, maxBytes?: number }} [options] fsync default false (frequent, small,
 *   non-critical writes); maxBytes default SLOT_MAX_BYTES – a larger file counts as corrupt (null).
 */
function createJsonFileSlot(filePath, options) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createJsonFileSlot: filePath must be a non-empty string');
  }
  const fsync = options !== null && typeof options === 'object' && options.fsync === true;
  const maxBytes = maxBytesOf(options, SLOT_MAX_BYTES);
  const write = (data) => {
    const res = writeJsonAtomic(filePath, data, { fsync, pretty: false });
    slot.lastError = res.ok ? null : res.error || 'EWRITE';
    return res.ok;
  };
  const slot = {
    filePath,
    maxBytes,
    /** Error code of the last failed save() / clear(), null when the last one succeeded. */
    lastError: null,
    load() {
      const res = readJson(filePath, { maxBytes });
      return res.ok ? res.data : null;
    },
    save(data) {
      return write(data);
    },
    clear() {
      try {
        withRetry(() => fs.unlinkSync(filePath));
        slot.lastError = null;
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          slot.lastError = null;
          return true;
        }
        // File stays locked: overwrite it with `null` (load() → null = nothing saved).
        return write(null);
      }
    },
  };
  return slot;
}

module.exports = {
  readJson,
  writeJsonAtomic,
  backupCorrupt,
  createJsonFileSlot,
  MAX_READ_BYTES,
  SLOT_MAX_BYTES,
};
