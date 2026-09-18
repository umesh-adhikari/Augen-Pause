'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readJson,
  writeJsonAtomic,
  backupCorrupt,
  createJsonFileSlot,
  MAX_READ_BYTES,
  SLOT_MAX_BYTES,
} = require('../src/main/store');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'augenpause-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('readJson: missing, invalid, BOM, valid', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readJson(path.join(dir, 'missing.json')), { ok: false, data: null, error: 'ENOENT' });

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ nope');
  assert.deepEqual(readJson(bad), { ok: false, data: null, error: 'EPARSE' });

  const bom = path.join(dir, 'bom.json');
  fs.writeFileSync(bom, '﻿{"a":1}');
  assert.deepEqual(readJson(bom), { ok: true, data: { a: 1 }, error: null });

  assert.equal(readJson(dir).ok, false, 'directory is not readable as JSON');
});

test('writeJsonAtomic: creates parent dirs, round-trips, overwrites, leaves no temp files', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a', 'b', 'data.json');
  const data = { text: 'Größe ✓ 😀', list: [1, 2, 3], nested: { ok: true } };
  assert.deepEqual(writeJsonAtomic(file, data), { ok: true, error: null });
  assert.deepEqual(readJson(file).data, data);

  assert.deepEqual(writeJsonAtomic(file, { v: 2 }), { ok: true, error: null });
  assert.deepEqual(readJson(file).data, { v: 2 });

  const big = { items: Array.from({ length: 20000 }, (_, i) => ({ i, s: 'x'.repeat(20) })) };
  assert.equal(writeJsonAtomic(file, big).ok, true);
  assert.equal(readJson(file).data.items.length, 20000);

  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['data.json']);
});

test('writeJsonAtomic options: fsync by default, { fsync: false } skips it; { pretty: false } writes compact JSON', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  const data = { a: 1, nested: { list: [1, 2] } };
  const original = fs.fsyncSync;
  let fsyncs = 0;
  fs.fsyncSync = (fd) => {
    fsyncs += 1;
    return original(fd);
  };
  try {
    assert.deepEqual(writeJsonAtomic(file, data), { ok: true, error: null });
    assert.equal(fsyncs, 1, 'default: fsync');
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(data, null, 2)}\n`, 'default: pretty');

    assert.deepEqual(writeJsonAtomic(file, data, { fsync: false, pretty: false }), { ok: true, error: null });
    assert.equal(fsyncs, 1, 'fsync skipped');
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(data)}\n`, 'compact');

    assert.equal(writeJsonAtomic(file, data, { pretty: false }).ok, true);
    assert.equal(fsyncs, 2, 'only fsync: false disables fsync');
    assert.equal(writeJsonAtomic(file, data, null).ok, true, 'invalid options → defaults');
    assert.equal(fsyncs, 3);
  } finally {
    fs.fsyncSync = original;
  }
  assert.deepEqual(readJson(file).data, data);
  assert.deepEqual(fs.readdirSync(dir), ['data.json'], 'still tmp + rename, no leftovers');
});

test('writeJsonAtomic: target path is a directory → error, directory untouched, no temp file', (t) => {
  const dir = tmpDir(t);
  const target = path.join(dir, 'settings.json');
  fs.mkdirSync(target);
  const res = writeJsonAtomic(target, { v: 1 });
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
  assert.ok(fs.statSync(target).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('writeJsonAtomic: unserializable data is rejected without touching the file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  writeJsonAtomic(file, { keep: true });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual(writeJsonAtomic(file, cyclic), { ok: false, error: 'ESERIALIZE' });
  assert.deepEqual(writeJsonAtomic(file, undefined), { ok: false, error: 'ESERIALIZE' });
  assert.deepEqual(readJson(file).data, { keep: true });
});

test('writeJsonAtomic: writes via temp file + rename (never a partially written target)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  writeJsonAtomic(file, { v: 1 });
  const original = fs.renameSync;
  const renames = [];
  fs.renameSync = (from, to) => {
    renames.push([from, to]);
    // at rename time the target still holds the old complete content, the temp file the new one
    assert.deepEqual(JSON.parse(fs.readFileSync(to, 'utf8')), { v: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8')), { v: 2 });
    return original(from, to);
  };
  try {
    assert.equal(writeJsonAtomic(file, { v: 2 }).ok, true);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][0], `${file}.tmp-${process.pid}`);
  assert.equal(renames[0][1], file);
  assert.deepEqual(readJson(file).data, { v: 2 });
});

test('writeJsonAtomic: retries transient EPERM/EBUSY on rename', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  const original = fs.renameSync;
  let failures = 0;
  fs.renameSync = (from, to) => {
    if (failures < 3) {
      failures += 1;
      const err = new Error('locked');
      err.code = failures % 2 ? 'EPERM' : 'EBUSY';
      throw err;
    }
    return original(from, to);
  };
  try {
    assert.deepEqual(writeJsonAtomic(file, { retried: true }), { ok: true, error: null });
  } finally {
    fs.renameSync = original;
  }
  assert.equal(failures, 3);
  assert.deepEqual(readJson(file).data, { retried: true });
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);
});

test('writeJsonAtomic: non-retryable error is reported and the temp file removed', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  writeJsonAtomic(file, { v: 1 });
  const original = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('boom');
    err.code = 'EIO';
    throw err;
  };
  let res;
  try {
    res = writeJsonAtomic(file, { v: 2 });
  } finally {
    fs.renameSync = original;
  }
  assert.deepEqual(res, { ok: false, error: 'EIO' });
  assert.deepEqual(readJson(file).data, { v: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);
});

test('backupCorrupt: moves the file aside, unique names, null when missing', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'broken-1');
  const b1 = backupCorrupt(file);
  assert.match(path.basename(b1), /^settings\.corrupt-\d+(-\d+)?\.json$/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(b1, 'utf8'), 'broken-1');

  fs.writeFileSync(file, 'broken-2');
  const b2 = backupCorrupt(file);
  assert.notEqual(b1, b2);
  assert.equal(fs.readFileSync(b2, 'utf8'), 'broken-2');

  assert.equal(backupCorrupt(path.join(dir, 'missing.json')), null);
});

test('createJsonFileSlot: load / save / clear round trip, compact, no fsync by default', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'session.json');
  assert.throws(() => createJsonFileSlot(''), TypeError);
  const slot = createJsonFileSlot(file);
  assert.equal(slot.filePath, file);
  assert.equal(slot.load(), null, 'missing → null');
  assert.equal(slot.clear(), true, 'clearing a missing file is fine');

  const record = { type: 'short', durationMs: 120000, elapsedMs: 5000, strict: true, savedAt: 1758100000000, interrupted: null };
  const original = fs.fsyncSync;
  let fsyncs = 0;
  fs.fsyncSync = (fd) => {
    fsyncs += 1;
    return original(fd);
  };
  try {
    assert.equal(slot.save(record), true);
    assert.equal(fsyncs, 0, 'no fsync by default');
    assert.equal(createJsonFileSlot(file, { fsync: true }).save(record), true);
    assert.equal(fsyncs, 1, '{ fsync: true } enables it');
  } finally {
    fs.fsyncSync = original;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(record)}\n`);
  assert.deepEqual(slot.load(), record);

  assert.equal(slot.clear(), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(slot.load(), null);
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp files left');

  fs.writeFileSync(file, '{ torn');
  assert.equal(slot.load(), null, 'corrupt → null');
  assert.equal(slot.save({ a: 1 }), true, 'corrupt file is simply overwritten');
  assert.deepEqual(slot.load(), { a: 1 });
});

test('createJsonFileSlot: clear falls back to writing null when the file cannot be removed', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'session.json');
  const slot = createJsonFileSlot(file);
  slot.save({ keep: false });
  const original = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (p === file) {
      const err = new Error('locked');
      err.code = 'EIO';
      throw err;
    }
    return original(p);
  };
  try {
    assert.equal(slot.clear(), true);
  } finally {
    fs.unlinkSync = original;
  }
  assert.equal(slot.load(), null);
  const dirSlot = createJsonFileSlot(dir); // a directory can neither be removed nor written
  assert.equal(dirSlot.save({ a: 1 }), false);
  assert.equal(dirSlot.load(), null);
});

// ---------------------------------------------------------------------------
// review fix L1: size caps (a huge file must never be read into memory and parsed)

test('readJson: a file above the size cap counts as corrupt and is never read', (t) => {
  const dir = tmpDir(t);
  assert.equal(MAX_READ_BYTES, 4 * 1024 * 1024);
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{"days":{}}');
  fs.truncateSync(file, MAX_READ_BYTES + 1); // grown by an accident / on purpose

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    reads += 1;
    return original(...args);
  };
  t.after(() => {
    fs.readFileSync = original;
  });
  try {
    assert.deepEqual(readJson(file), { ok: false, data: null, error: 'ETOOBIG' });
    assert.equal(reads, 0, 'the size is checked with statSync before any read');
    assert.equal(readJson(file, { maxBytes: MAX_READ_BYTES + 1 }).error, 'EPARSE', 'a raised cap reads (and rejects) it');
    assert.equal(reads, 1);
  } finally {
    fs.readFileSync = original;
  }
});

test('readJson: maxBytes boundary and invalid options', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  const payload = `{"pad":"${'x'.repeat(200)}"}`;
  fs.writeFileSync(file, payload);
  assert.equal(readJson(file, { maxBytes: payload.length }).ok, true, 'exactly at the cap is fine');
  assert.deepEqual(readJson(file, { maxBytes: payload.length - 1 }), { ok: false, data: null, error: 'ETOOBIG' });
  assert.equal(readJson(file, { maxBytes: 0 }).error, 'ETOOBIG');
  for (const options of [undefined, null, 42, {}, { maxBytes: 'lots' }, { maxBytes: NaN }, { maxBytes: -1 }]) {
    assert.equal(readJson(file, options).ok, true, `invalid options → default cap (${JSON.stringify(options)})`);
  }
  assert.deepEqual(readJson(path.join(dir, 'missing.json')), { ok: false, data: null, error: 'ENOENT' }, 'still ENOENT');
});

test('createJsonFileSlot: an oversized document counts as corrupt, maxBytes is configurable', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'session.json');
  assert.equal(SLOT_MAX_BYTES, 1024 * 1024);
  const slot = createJsonFileSlot(file);
  assert.equal(slot.maxBytes, SLOT_MAX_BYTES);
  const record = { type: 'short', durationMs: 120000, elapsedMs: 5000, strict: true, savedAt: 1758100000000, interrupted: null };
  assert.equal(slot.save(record), true);
  assert.deepEqual(slot.load(), record);

  fs.truncateSync(file, SLOT_MAX_BYTES + 1);
  assert.equal(slot.load(), null, 'oversized → null, exactly like a corrupt file');
  assert.equal(slot.save(record), true, 'and it is simply overwritten by the next save');
  assert.deepEqual(slot.load(), record);

  const tiny = createJsonFileSlot(file, { maxBytes: 8 });
  assert.equal(tiny.maxBytes, 8);
  assert.equal(tiny.load(), null);
  assert.equal(createJsonFileSlot(file, { maxBytes: 'big' }).maxBytes, SLOT_MAX_BYTES, 'invalid → default');
});

// ---------------------------------------------------------------------------
// review fix L5: failed save / clear is visible to the caller

test('createJsonFileSlot: lastError reports a failed save / clear and is reset by a successful one', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'session.json');
  const slot = createJsonFileSlot(file);
  assert.equal(slot.lastError, null);
  assert.equal(slot.save({ a: 1 }), true);
  assert.equal(slot.lastError, null);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  t.after(() => {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  });
  const failRename = () => {
    const err = new Error('boom');
    err.code = 'EIO'; // not retryable → no copy fallback either
    throw err;
  };

  fs.renameSync = failRename;
  try {
    assert.equal(slot.save({ a: 2 }), false);
    assert.equal(slot.lastError, 'EIO');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(slot.save({ a: 3 }), true);
  assert.equal(slot.lastError, null, 'reset after a successful save');

  // clear(): the file can neither be removed nor overwritten
  fs.unlinkSync = (p) => {
    if (p === file) {
      const err = new Error('locked');
      err.code = 'EIO';
      throw err;
    }
    return originalUnlink(p);
  };
  fs.renameSync = failRename;
  try {
    assert.equal(slot.clear(), false, 'clear reports the failure');
    assert.equal(slot.lastError, 'EIO');
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }
  assert.deepEqual(slot.load(), { a: 3 }, 'the record is still there – the scheduler rejects it once it is stale');
  assert.equal(slot.clear(), true);
  assert.equal(slot.lastError, null);
  assert.equal(slot.clear(), true, 'clearing an already missing file succeeds');
  assert.equal(slot.lastError, null);
});
