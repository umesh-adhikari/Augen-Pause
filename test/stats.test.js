'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStatsStore,
  localDateKey,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_WORK_DEBOUNCE_MS,
  MAX_STATS_BYTES,
} = require('../src/main/stats');

const HOUR = 3600 * 1000;

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'augenpause-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'stats.json');
}

function setup(t, start = new Date(2026, 8, 16, 12, 0).getTime(), opts = {}) {
  const clock = { t: start };
  let stats = null;
  // registered before the temp dir removal hook → pending writes are flushed before the dir is deleted
  t.after(() => stats && stats.flush());
  const filePath = opts.filePath || tmpFile(t);
  stats = createStatsStore({
    filePath,
    now: () => clock.t,
    debounceMs: opts.debounceMs ?? 60 * 60 * 1000,
    workDebounceMs: opts.workDebounceMs ?? 60 * 60 * 1000,
  });
  return { stats, clock, filePath };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts atomic writes to `filePath` (renames onto it) while the test runs. */
function countWrites(t, filePath) {
  const original = fs.renameSync;
  const counter = { n: 0 };
  fs.renameSync = (from, to) => {
    if (to === filePath) counter.n += 1;
    return original(from, to);
  };
  t.after(() => {
    fs.renameSync = original;
  });
  return counter;
}

test('localDateKey uses the local date', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 0, 0, 1).getTime()), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59, 59).getTime()), '2026-12-31');
});

test('counters: breaks, snoozes, natural breaks, work seconds, glasses', (t) => {
  const { stats } = setup(t);
  const changes = [];
  stats.on('change', (today) => changes.push(today));

  stats.recordBreak({ type: 'short', completed: true, seconds: 120 });
  stats.recordBreak({ type: 'long', completed: true, seconds: 600 });
  stats.recordBreak({ type: 'short', completed: false, seconds: 0 });
  stats.recordBreak({ type: 'short', completed: false, seconds: 45 });
  stats.recordBreak({ type: 'long', completed: false, seconds: 30, skipped: false });
  stats.recordSnooze();
  stats.recordNaturalBreak();
  stats.addWorkSeconds(59.6);
  stats.addWorkSeconds(-10);
  stats.addWorkSeconds(NaN);
  assert.equal(stats.addGlass().glasses, 1);
  stats.addGlass();
  assert.equal(stats.removeGlass().glasses, 1);
  stats.removeGlass();
  assert.equal(stats.removeGlass().glasses, 0, 'never below 0');
  stats.recordBreak(null);

  const today = stats.getToday();
  assert.deepEqual(today, {
    date: '2026-09-16',
    breaksCompleted: 2,
    breaksSkipped: 3,
    breaksSnoozed: 1,
    shortBreaks: 1,
    longBreaks: 1,
    naturalBreaks: 1,
    breakSeconds: 795,
    workSeconds: 60,
    glasses: 0,
  });
  // 6× recordBreak, recordSnooze, recordNaturalBreak, 2× addGlass, 3× removeGlass – addWorkSeconds never emits
  assert.equal(changes.length, 13);
  assert.equal(changes.at(-1).date, '2026-09-16');
  // returned objects are copies
  today.glasses = 99;
  changes.at(-1).glasses = 42;
  assert.equal(stats.getToday().glasses, 0);
});

test('day rollover at local midnight and getRange zero-fill', (t) => {
  const { stats, clock } = setup(t, new Date(2026, 8, 14, 23, 59, 0).getTime());
  stats.addGlass();
  stats.addWorkSeconds(100);
  clock.t += 2 * 60 * 1000; // 00:01 on the 15th
  assert.equal(stats.getToday().date, '2026-09-15');
  assert.equal(stats.getToday().glasses, 0);
  stats.addGlass();
  stats.addGlass();
  clock.t += 2 * 24 * HOUR; // 17th
  stats.recordSnooze();

  const range = stats.getRange(5);
  assert.deepEqual(range.map((d) => d.date), ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
  assert.deepEqual(range.map((d) => d.glasses), [0, 1, 2, 0, 0]);
  assert.equal(range[1].workSeconds, 100);
  assert.equal(range[3].breaksSnoozed, 0);
  assert.equal(range[4].breaksSnoozed, 1);
  assert.equal(range[0].breaksCompleted, 0);

  assert.equal(stats.getRange(0).length, 1);
  assert.equal(stats.getRange(-5).length, 1);
  assert.equal(stats.getRange(10000).length, 400);
  assert.equal(stats.getRange(2.4).length, 2);
  assert.equal(stats.getRange('7').length, 7);
  assert.equal(stats.getRange(400)[399].date, '2026-09-17');
});

test('getRange across a DST change yields consecutive dates', (t) => {
  const { stats } = setup(t, new Date(2026, 10, 2, 12, 0).getTime());
  const dates = stats.getRange(60).map((d) => d.date);
  assert.equal(new Set(dates).size, 60);
  assert.equal(dates[59], '2026-11-02');
  assert.equal(dates[0], '2026-09-04');
});

test('debounced writes, flush and reload', (t) => {
  const { stats, filePath, clock } = setup(t);
  stats.addGlass();
  assert.equal(fs.existsSync(filePath), false, 'write is debounced');
  assert.deepEqual(stats.flush(), { ok: true, error: null });
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.days['2026-09-16'].glasses, 1);

  const reloaded = createStatsStore({ filePath, now: () => clock.t });
  assert.equal(reloaded.getToday().glasses, 1);
  assert.deepEqual(reloaded.flush(), { ok: true, error: null }, 'nothing pending');
});

test('debounce timer writes real events automatically (once per window)', async (t) => {
  const { stats, filePath } = setup(t, undefined, { debounceMs: 30 });
  const writes = countWrites(t, filePath);
  stats.addGlass();
  stats.recordSnooze();
  stats.addGlass();
  assert.equal(stats.hasPendingWrites, true);
  await wait(150);
  assert.equal(writes.n, 1, 'coalesced into one write');
  const day = JSON.parse(fs.readFileSync(filePath, 'utf8')).days['2026-09-16'];
  assert.equal(day.glasses, 2);
  assert.equal(day.breaksSnoozed, 1);
  assert.equal(stats.hasPendingWrites, false);
});

test('addWorkSeconds: no change event, persisted at most every workDebounceMs', async (t) => {
  const { stats, filePath } = setup(t, undefined, { debounceMs: 20, workDebounceMs: 250 });
  const writes = countWrites(t, filePath);
  let changes = 0;
  stats.on('change', () => {
    changes += 1;
  });
  for (let i = 0; i < 50; i += 1) assert.equal(stats.addWorkSeconds(1).workSeconds, i + 1);
  assert.equal(changes, 0, 'workSeconds-only changes do not emit');
  assert.equal(stats.getToday().workSeconds, 50, 'visible immediately via getToday()');

  await wait(80); // well past debounceMs, before workDebounceMs
  assert.equal(writes.n, 0, 'not written by the short event debounce');
  assert.equal(fs.existsSync(filePath), false);
  stats.addWorkSeconds(1);

  await wait(400); // past workDebounceMs
  assert.equal(writes.n, 1, 'exactly one write for the whole window');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).days['2026-09-16'].workSeconds, 51);
  assert.equal(stats.hasPendingWrites, false);
  assert.equal(changes, 0);
});

test('a real event while work seconds are pending writes everything after the short debounce', async (t) => {
  const { stats, filePath } = setup(t, undefined, { debounceMs: 30, workDebounceMs: 60 * 60 * 1000 });
  const writes = countWrites(t, filePath);
  const emitted = [];
  stats.on('change', (today) => emitted.push(today));
  stats.addWorkSeconds(120);
  stats.recordBreak({ type: 'short', completed: true, seconds: 120 });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].workSeconds, 120, 'the event payload carries the current work seconds');
  await wait(150);
  assert.equal(writes.n, 1);
  const day = JSON.parse(fs.readFileSync(filePath, 'utf8')).days['2026-09-16'];
  assert.equal(day.workSeconds, 120);
  assert.equal(day.breaksCompleted, 1);

  // the (cleared) slow work timer does not fire a second write
  stats.addWorkSeconds(5);
  assert.equal(stats.flush().ok, true, 'flush writes pending work seconds immediately');
  assert.equal(writes.n, 2);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).days['2026-09-16'].workSeconds, 125);
  assert.deepEqual(stats.flush(), { ok: true, error: null });
  assert.equal(writes.n, 2, 'nothing pending → no write');
});

test('stats file is compact JSON and written without fsync', (t) => {
  const { stats, filePath } = setup(t);
  stats.addGlass();
  stats.addWorkSeconds(10);
  const original = fs.fsyncSync;
  let fsyncs = 0;
  fs.fsyncSync = (fd) => {
    fsyncs += 1;
    return original(fd);
  };
  try {
    assert.deepEqual(stats.flush(), { ok: true, error: null });
  } finally {
    fs.fsyncSync = original;
  }
  assert.equal(fsyncs, 0);
  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`, 'no indentation');
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['stats.json'], 'atomic tmp + rename, no leftovers');
});

test('failed write keeps changes pending and reports lastWriteError', (t) => {
  const filePath = tmpFile(t);
  fs.mkdirSync(filePath); // target is a directory → every write fails
  const { stats } = setup(t, undefined, { filePath });
  stats.addGlass();
  const res = stats.flush();
  assert.equal(res.ok, false);
  assert.equal(stats.lastWriteError, res.error);
  assert.equal(stats.hasPendingWrites, true);
  fs.rmdirSync(filePath);
  assert.deepEqual(stats.flush(), { ok: true, error: null });
  assert.equal(stats.lastWriteError, null);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).days['2026-09-16'].glasses, 1);
});

test('corrupt stats file → backup + empty', (t) => {
  const filePath = tmpFile(t);
  fs.writeFileSync(filePath, 'not json at all');
  const { stats } = setup(t, undefined, { filePath });
  assert.equal(stats.getToday().glasses, 0);
  const dir = path.dirname(filePath);
  const backups = fs.readdirSync(dir).filter((f) => /^stats\.corrupt-\d+(-\d+)?\.json$/.test(f));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'not json at all');

  fs.writeFileSync(filePath, JSON.stringify({ days: [] }));
  setup(t, undefined, { filePath });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 2);
});

test('invalid entries are ignored and values sanitized on load; only 400 days kept', (t) => {
  const filePath = tmpFile(t);
  const days = {
    '2026-09-16': { glasses: 3.4, workSeconds: -5, breaksCompleted: 'x', breakSeconds: Infinity },
    'garbage': { glasses: 1 },
    '__proto__': { glasses: 1 },
    '2026-09-15': 'nope',
    '2025-08-12': { glasses: 7 }, // older than 400 days
    '2025-08-13': { glasses: 8 }, // exactly the 400th day back
  };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, days }));
  const { stats } = setup(t, undefined, { filePath });
  const today = stats.getToday();
  assert.equal(today.glasses, 3);
  assert.equal(today.workSeconds, 0);
  assert.equal(today.breaksCompleted, 0);
  assert.equal(today.breakSeconds, 0);
  const range = stats.getRange(400);
  assert.equal(range[0].date, '2025-08-13');
  assert.equal(range[0].glasses, 8);
  stats.addGlass();
  stats.flush();
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.days).sort(), ['2025-08-13', '2026-09-16']);
});

test('pruning after a long run keeps at most 400 days', (t) => {
  const { stats, clock, filePath } = setup(t, new Date(2025, 0, 1, 12).getTime());
  for (let i = 0; i < 450; i += 1) {
    stats.addGlass();
    clock.t += 24 * HOUR;
  }
  stats.addGlass();
  stats.flush();
  const keys = Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf8')).days);
  assert.ok(keys.length <= 400);
  assert.equal(keys.sort().at(-1), localDateKey(clock.t));
});

test('reset clears everything, persists and emits change', (t) => {
  const { stats, filePath } = setup(t);
  stats.addGlass();
  stats.recordSnooze();
  let emitted = null;
  stats.on('change', (today) => {
    emitted = today;
  });
  stats.reset();
  assert.equal(emitted.glasses, 0);
  assert.equal(stats.getToday().breaksSnoozed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { version: 1, days: {} });
});

test('createStatsStore validates options', () => {
  assert.throws(() => createStatsStore({}), TypeError);
  assert.throws(() => createStatsStore({ filePath: 'x.json', now: 5 }), TypeError);
  assert.equal(DEFAULT_DEBOUNCE_MS, 5000);
  assert.equal(DEFAULT_WORK_DEBOUNCE_MS, 60000);
});

test('oversized stats file → backup + empty, never parsed (review fix L1)', (t) => {
  const filePath = tmpFile(t);
  assert.equal(MAX_STATS_BYTES, 1024 * 1024);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, days: { '2026-09-16': { glasses: 3 } } }));
  fs.truncateSync(filePath, MAX_STATS_BYTES + 1);

  const { stats } = setup(t, undefined, { filePath });
  assert.equal(stats.getToday().glasses, 0, 'started empty instead of parsing a megabyte file');
  const dir = path.dirname(filePath);
  const backups = fs.readdirSync(dir).filter((f) => /^stats\.corrupt-\d+(-\d+)?\.json$/.test(f));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(dir, backups[0])).size, MAX_STATS_BYTES + 1);

  // a normal file of the same shape is still read
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, days: { [localDateKey(new Date(2026, 8, 16, 12, 0).getTime())]: { glasses: 3 } } }));
  const again = setup(t, undefined, { filePath });
  assert.equal(again.stats.getToday().glasses, 3);
});
