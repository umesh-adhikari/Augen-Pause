'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_SETTINGS,
  PRESETS,
  SETTINGS_VERSION,
  MAX_SETTINGS_BYTES,
  sanitizeSettings,
  createSettingsStore,
} = require('../src/main/settings');
const settingsModule = require('../src/main/settings');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'augenpause-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

test('defaults match the documented contract (incl. §9, §11 and §12 additions)', () => {
  assert.equal(SETTINGS_VERSION, 3);
  assert.equal(DEFAULT_SETTINGS.version, 3);
  assert.equal(DEFAULT_SETTINGS.language, 'system');
  assert.deepEqual(DEFAULT_SETTINGS.timer, {
    preset: 'halfhour',
    workMinutes: 30,
    shortBreakSeconds: 120,
    longBreakEnabled: true,
    longBreakSeconds: 600,
    longBreakEvery: 4,
    warnBeforeSeconds: 60,
    snoozeMinutes: 5,
    maxSnoozes: 2,
  });
  assert.deepEqual(DEFAULT_SETTINGS.breaks, {
    lockScreen: true,
    strictMode: true,
    skipHoldSeconds: 3,
    graceSeconds: 15,
    allDisplays: true,
    showExercises: true,
    soundEnabled: true,
    soundVolume: 0.5,
    overlayOpacity: 0.6,
  });
  assert.equal(settingsModule.STRICT_MIN_GRACE_SECONDS, undefined, 'the §10 grace clamp is gone (§11)');
  assert.equal(DEFAULT_SETTINGS.widget.showOnWarning, true);
  assert.equal(DEFAULT_SETTINGS.widget.position, null);
  assert.deepEqual(DEFAULT_SETTINGS.meeting, { autoDetect: true });
  assert.deepEqual(DEFAULT_SETTINGS.updates, {
    autoCheck: true,
    intervalHours: 24,
    autoDownload: false,
    includePrerelease: false,
  });
  assert.deepEqual(DEFAULT_SETTINGS.schedule, { workingHoursEnabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' });
  assert.deepEqual(DEFAULT_SETTINGS.hydration, { enabled: true, intervalMinutes: 45, dailyGoalGlasses: 8, glassMl: 250 });
  assert.deepEqual(PRESETS.hourly, { workMinutes: 60, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 3 });
  assert.deepEqual(PRESETS['20-20-20'], { workMinutes: 20, shortBreakSeconds: 20, longBreakSeconds: 300, longBreakEvery: 6 });
  assert.deepEqual(PRESETS.pomodoro, { workMinutes: 25, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 4 });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.timer));
});

test('sanitizeSettings: non-objects → defaults (deep copy)', () => {
  for (const input of [undefined, null, 42, 'x', [], [1, 2], true]) {
    const out = sanitizeSettings(input);
    assert.deepEqual(out, clone(DEFAULT_SETTINGS));
  }
  const a = sanitizeSettings(null);
  a.timer.workMinutes = 99;
  a.schedule.days.push(0);
  assert.equal(DEFAULT_SETTINGS.timer.workMinutes, 30);
  assert.deepEqual(sanitizeSettings(null).schedule.days, [1, 2, 3, 4, 5]);
});

test('sanitizeSettings: hostile input – wrong types, huge numbers, bad enums, prototype pollution', () => {
  const input = JSON.parse(`{
    "__proto__": { "polluted": true },
    "constructor": { "prototype": { "polluted": true } },
    "version": 999,
    "language": "fr",
    "unknown": { "deep": 1 },
    "timer": {
      "__proto__": { "polluted": true },
      "workMinutes": 1e308,
      "shortBreakSeconds": -50,
      "longBreakEnabled": "yes",
      "longBreakSeconds": "600",
      "longBreakEvery": 3.6,
      "warnBeforeSeconds": null,
      "snoozeMinutes": 0,
      "maxSnoozes": -0.2,
      "preset": "custom"
    },
    "breaks": { "soundVolume": 7, "skipHoldSeconds": 4.4, "graceSeconds": 9999, "strictMode": 0, "overlayOpacity": "0.3" },
    "idle": "nope",
    "hydration": { "intervalMinutes": 5, "glassMl": 99999 },
    "schedule": { "days": [3, 1, 1, 5], "start": "7:00", "end": "24:00" },
    "widget": { "size": "huge", "opacity": 0, "position": { "x": 10.6, "y": -20.2 }, "showOnWarning": "false" },
    "appearance": { "theme": "dark", "accent": "<script>" },
    "general": { "autostart": true },
    "meeting": { "autoDetect": 0 },
    "updates": { "autoCheck": "yes", "intervalHours": 9999, "autoDownload": true, "includePrerelease": null }
  }`);
  const snapshot = JSON.stringify(input);
  const out = sanitizeSettings(input);
  assert.equal(JSON.stringify(input), snapshot, 'input not mutated');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf(out.timer), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.equal(out.timer.polluted, undefined);
  assert.equal(out.unknown, undefined);

  assert.equal(out.version, 3);
  assert.equal(out.language, 'system');
  assert.equal(out.timer.workMinutes, 240);
  assert.equal(out.timer.shortBreakSeconds, 20);
  assert.equal(out.timer.longBreakEnabled, true);
  assert.equal(out.timer.longBreakSeconds, 600);
  assert.equal(out.timer.longBreakEvery, 4);
  assert.equal(out.timer.warnBeforeSeconds, 60);
  assert.equal(out.timer.snoozeMinutes, 1);
  assert.ok(Object.is(out.timer.maxSnoozes, 0), 'no negative zero');
  assert.equal(out.timer.preset, 'custom');
  assert.equal(out.breaks.soundVolume, 1);
  assert.equal(out.breaks.skipHoldSeconds, 4);
  assert.equal(out.breaks.graceSeconds, 120);
  assert.equal(out.breaks.strictMode, true, 'invalid → default (true)');
  assert.equal(out.breaks.overlayOpacity, 0.6, 'numeric string rejected');
  assert.deepEqual(out.idle, DEFAULT_SETTINGS.idle);
  assert.equal(out.hydration.intervalMinutes, 10);
  assert.equal(out.hydration.glassMl, 1000);
  assert.deepEqual(out.schedule.days, [1, 3, 5]);
  assert.equal(out.schedule.start, '08:00');
  assert.equal(out.schedule.end, '18:00');
  assert.equal(out.widget.size, 'medium');
  assert.equal(out.widget.opacity, 0.3);
  assert.deepEqual(out.widget.position, { x: 11, y: -20 });
  assert.equal(out.widget.showOnWarning, true);
  assert.equal(out.appearance.theme, 'dark');
  assert.equal(out.appearance.accent, 'teal');
  assert.equal(out.general.autostart, true);
  assert.equal(out.meeting.autoDetect, true);
  assert.equal(out.updates.autoCheck, true, 'invalid → default (true)');
  assert.equal(out.updates.intervalHours, 168, 'clamped to the §12 range');
  assert.equal(out.updates.autoDownload, true);
  assert.equal(out.updates.includePrerelease, false, 'invalid → default (false)');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('sanitizeSettings: NaN / Infinity / numeric strings rejected; positions validated', () => {
  const out = sanitizeSettings({
    timer: { workMinutes: NaN, shortBreakSeconds: Infinity, longBreakSeconds: -Infinity },
    widget: { position: { x: 100001, y: 0 } },
    hydration: { dailyGoalGlasses: '8' },
  });
  assert.equal(out.timer.workMinutes, 30);
  assert.equal(out.timer.shortBreakSeconds, 120);
  assert.equal(out.timer.longBreakSeconds, 600);
  assert.equal(out.widget.position, null);
  assert.equal(out.hydration.dailyGoalGlasses, 8);
  assert.equal(out.timer.preset, 'halfhour');

  for (const bad of [{ x: NaN, y: 1 }, { x: 1 }, [1, 2], 'top-left', { x: '1', y: 2 }, { x: 1, y: -100001 }]) {
    assert.equal(sanitizeSettings({ widget: { position: bad } }).widget.position, null);
  }
  assert.deepEqual(sanitizeSettings({ widget: { position: { x: -100000, y: 100000 } } }).widget.position, { x: -100000, y: 100000 });
});

test('sanitizeSettings: HH:MM and days validation', () => {
  const bad = ['24:00', '7:00', '12:60', '12:5', ' 12:00', '12:00 ', 'aa:bb', 1200, null, '23:59:00'];
  for (const v of bad) {
    assert.equal(sanitizeSettings({ schedule: { start: v } }).schedule.start, '08:00', String(v));
  }
  assert.equal(sanitizeSettings({ schedule: { start: '00:00' } }).schedule.start, '00:00');
  assert.equal(sanitizeSettings({ schedule: { start: '09:30', end: '23:59' } }).schedule.end, '23:59');
  // end <= start → schedule times fall back to defaults
  const inverted = sanitizeSettings({ schedule: { start: '18:00', end: '08:00' } });
  assert.equal(inverted.schedule.start, '08:00');
  assert.equal(inverted.schedule.end, '18:00');

  const badDays = [[], [7], [-1], [1.5], ['1'], 'mon', null, new Array(200).fill(1)];
  for (const d of badDays) assert.deepEqual(sanitizeSettings({ schedule: { days: d } }).schedule.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(sanitizeSettings({ schedule: { days: [6, 0, 6, 3] } }).schedule.days, [0, 3, 6]);
});

test('sanitizeSettings: old/partial files merge with defaults and presets stay consistent', () => {
  const out = sanitizeSettings({ language: 'de', timer: { preset: 'hourly' } });
  assert.equal(out.language, 'de');
  assert.equal(out.timer.preset, 'hourly');
  assert.equal(out.timer.workMinutes, 60);
  assert.equal(out.timer.longBreakEvery, 3);
  assert.equal(out.breaks.graceSeconds, 15, 'new fields get defaults');
  assert.deepEqual(out.meeting, { autoDetect: true });

  const custom = sanitizeSettings({ timer: { preset: 'pomodoro', workMinutes: 50 } });
  assert.equal(custom.timer.preset, 'custom');
  assert.equal(custom.timer.workMinutes, 50);

  const implicit = sanitizeSettings({ timer: { workMinutes: 45 } });
  assert.equal(implicit.timer.preset, 'custom');
});

test('store: missing file → defaults written, isFirstRun', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'nested', 'settings.json');
  const store = createSettingsStore({ filePath });
  assert.equal(store.isFirstRun, true);
  assert.deepEqual(store.get(), clone(DEFAULT_SETTINGS));
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), clone(DEFAULT_SETTINGS));

  const again = createSettingsStore({ filePath });
  assert.equal(again.isFirstRun, false);
  assert.throws(() => createSettingsStore({}), TypeError);
});

test('store: corrupt file is backed up and replaced by defaults', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'settings.json');
  fs.writeFileSync(filePath, '{"timer": {"workMinutes": 45,');
  const store = createSettingsStore({ filePath });
  assert.equal(store.isFirstRun, false);
  assert.deepEqual(store.get(), clone(DEFAULT_SETTINGS));
  const backups = fs.readdirSync(dir).filter((f) => /^settings\.corrupt-\d+(-\d+)?\.json$/.test(f));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"timer": {"workMinutes": 45,');
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), clone(DEFAULT_SETTINGS));

  // valid JSON of the wrong shape counts as corrupt too
  fs.writeFileSync(filePath, '[1,2,3]');
  createSettingsStore({ filePath });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 2);
});

test('store: partial old file is migrated and persisted', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'settings.json');
  fs.writeFileSync(filePath, '﻿' + JSON.stringify({ version: 0, language: 'en', timer: { workMinutes: 20 }, legacy: true }));
  const store = createSettingsStore({ filePath });
  const s = store.get();
  assert.equal(s.language, 'en');
  assert.equal(s.timer.workMinutes, 20);
  assert.equal(s.timer.preset, 'custom');
  assert.equal(s.version, 3);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, s);
  assert.equal(onDisk.legacy, undefined);
});

test('store.update: applies valid leaves, rejects invalid ones with errors, persists, emits change', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'settings.json');
  const store = createSettingsStore({ filePath });
  const changes = [];
  store.on('change', (next, prev) => changes.push({ next, prev }));

  const patch = deepFreeze({
    language: 'de',
    timer: { warnBeforeSeconds: 120.4, snoozeMinutes: 'ten' },
    breaks: { graceSeconds: 30 },
    widget: { showOnWarning: false },
    meeting: { autoDetect: false },
    nope: 1,
  });
  const res = store.update(patch);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /timer\.snoozeMinutes/);
  assert.equal(res.settings.language, 'de');
  assert.equal(res.settings.timer.warnBeforeSeconds, 120);
  assert.equal(res.settings.timer.snoozeMinutes, 5);
  assert.equal(res.settings.breaks.graceSeconds, 30);
  assert.equal(res.settings.widget.showOnWarning, false);
  assert.equal(res.settings.meeting.autoDetect, false);
  assert.equal(res.settings.nope, undefined);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].prev.language, 'system');
  assert.equal(changes[0].next.language, 'de');

  // persisted
  assert.deepEqual(createSettingsStore({ filePath }).get(), store.get());

  // returned objects are copies
  res.settings.timer.workMinutes = 1;
  store.get().timer.workMinutes = 2;
  changes[0].next.timer.workMinutes = 3;
  assert.equal(store.get().timer.workMinutes, 30);

  // no-op update → no change event
  const same = store.update({ language: 'de' });
  assert.equal(same.ok, true);
  assert.equal(changes.length, 1);

  // only errors → ok=false, nothing changes
  const bad = store.update({ timer: { workMinutes: 'x' }, widget: 'big' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(changes.length, 1);

  for (const p of [null, 42, 'x', [], undefined]) {
    const r = store.update(p);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
  }
  const polluted = store.update(JSON.parse('{"__proto__": {"language": "en"}, "constructor": {"prototype": {"x": 1}}}'));
  assert.equal(polluted.settings.language, 'de');
  assert.equal({}.x, undefined);
  assert.equal(changes.length, 1);
});

test('store.update: schedule end must be later than start', (t) => {
  const store = createSettingsStore({ filePath: path.join(tmpDir(t), 'settings.json') });
  let res = store.update({ schedule: { start: '19:00' } });
  assert.equal(res.ok, false, 'the only change was rejected → nothing applied');
  assert.ok(res.errors.some((e) => /schedule\.end/.test(e)));
  assert.equal(res.settings.schedule.start, '08:00');

  res = store.update({ schedule: { start: '09:00', end: '09:00', workingHoursEnabled: true } });
  assert.ok(res.errors.some((e) => /later than/.test(e)));
  assert.equal(res.settings.schedule.start, '08:00');
  assert.equal(res.settings.schedule.end, '18:00');
  assert.equal(res.settings.schedule.workingHoursEnabled, true, 'other values of the patch still applied');

  res = store.update({ schedule: { start: '07:30', end: '16:00' } });
  assert.deepEqual(res.errors, []);
  assert.equal(res.settings.schedule.start, '07:30');
  assert.equal(res.settings.schedule.end, '16:00');

  res = store.update({ schedule: { end: '25:00' } });
  assert.equal(res.ok, false);
  assert.equal(res.settings.schedule.end, '16:00');
});

test('store.update: preset switching and automatic custom', (t) => {
  const store = createSettingsStore({ filePath: path.join(tmpDir(t), 'settings.json') });

  let s = store.update({ timer: { preset: 'hourly' } }).settings;
  assert.equal(s.timer.preset, 'hourly');
  assert.equal(s.timer.workMinutes, 60);
  assert.equal(s.timer.shortBreakSeconds, 300);
  assert.equal(s.timer.longBreakSeconds, 900);
  assert.equal(s.timer.longBreakEvery, 3);

  // same value as the preset → preset stays
  s = store.update({ timer: { workMinutes: 60, warnBeforeSeconds: 30 } }).settings;
  assert.equal(s.timer.preset, 'hourly');
  assert.equal(s.timer.warnBeforeSeconds, 30);

  // non-preset field → preset stays
  s = store.update({ timer: { snoozeMinutes: 10, longBreakEnabled: false } }).settings;
  assert.equal(s.timer.preset, 'hourly');

  // preset field changed → custom
  s = store.update({ timer: { shortBreakSeconds: 240 } }).settings;
  assert.equal(s.timer.preset, 'custom');
  assert.equal(s.timer.shortBreakSeconds, 240);
  assert.equal(s.timer.workMinutes, 60);

  // preset wins over other timer values in the same patch
  s = store.update({ timer: { preset: '20-20-20', workMinutes: 99, longBreakEvery: 12 } }).settings;
  assert.equal(s.timer.preset, '20-20-20');
  assert.deepEqual(
    { w: s.timer.workMinutes, sb: s.timer.shortBreakSeconds, lb: s.timer.longBreakSeconds, e: s.timer.longBreakEvery },
    { w: 20, sb: 20, lb: 300, e: 6 },
  );

  // clamped value different from the preset → custom
  s = store.update({ timer: { longBreakEvery: 100 } }).settings;
  assert.equal(s.timer.preset, 'custom');
  assert.equal(s.timer.longBreakEvery, 12);

  // explicit custom keeps values
  s = store.update({ timer: { preset: 'pomodoro' } }).settings;
  s = store.update({ timer: { preset: 'custom', workMinutes: 33 } }).settings;
  assert.equal(s.timer.preset, 'custom');
  assert.equal(s.timer.workMinutes, 33);

  // invalid preset rejected
  const r = store.update({ timer: { preset: 'turbo' } });
  assert.equal(r.ok, false);
  assert.equal(r.settings.timer.preset, 'custom');
});

test('§11: no grace clamp any more – graceSeconds is independent of strictMode', (t) => {
  for (const strictMode of [true, false]) {
    for (const [graceSeconds, expected] of [[0, 0], [3.4, 3], [12, 12], ['x', 15], [-5, 0], [500, 120]]) {
      assert.equal(sanitizeSettings({ breaks: { strictMode, graceSeconds } }).breaks.graceSeconds, expected, `${strictMode} ${graceSeconds}`);
    }
  }
  const filePath = path.join(tmpDir(t), 'settings.json');
  const store = createSettingsStore({ filePath });
  let res = store.update({ breaks: { strictMode: true, graceSeconds: 0 } });
  assert.deepEqual(res.errors, []);
  assert.equal(res.settings.breaks.strictMode, true);
  assert.equal(res.settings.breaks.graceSeconds, 0);
  res = store.update({ breaks: { graceSeconds: 2 } });
  assert.equal(res.settings.breaks.graceSeconds, 2);
  fs.writeFileSync(filePath, JSON.stringify({ version: 2, breaks: { strictMode: true, graceSeconds: 1 } }));
  assert.equal(createSettingsStore({ filePath }).get().breaks.graceSeconds, 1);
});

test('breaks.overlayOpacity: number 0.2..1, rounded to 2 decimals, invalid → default / rejected', (t) => {
  const cases = [
    [0.6, 0.6], [0.2, 0.2], [1, 1], [0, 0.2], [0.1, 0.2], [-3, 0.2], [5, 1], [0.456, 0.46], [0.999, 1],
    ['0.5', 0.6], [null, 0.6], [NaN, 0.6], [Infinity, 0.6], [true, 0.6], [[0.5], 0.6], [{}, 0.6],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeSettings({ breaks: { overlayOpacity: input } }).breaks.overlayOpacity, expected, String(input));
  }
  assert.equal(sanitizeSettings({}).breaks.overlayOpacity, 0.6);

  const store = createSettingsStore({ filePath: path.join(tmpDir(t), 'settings.json') });
  let res = store.update({ breaks: { overlayOpacity: 0.35 } });
  assert.deepEqual(res.errors, []);
  assert.equal(res.settings.breaks.overlayOpacity, 0.35);
  res = store.update({ breaks: { overlayOpacity: 0.05 } });
  assert.equal(res.ok, true);
  assert.equal(res.settings.breaks.overlayOpacity, 0.2, 'clamped');
  res = store.update({ breaks: { overlayOpacity: 'dark' } });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^breaks\.overlayOpacity: expected number 0\.2\.\.1/);
  assert.equal(res.settings.breaks.overlayOpacity, 0.2, 'previous value kept');
});

test('migration v1 → v2 → v3 (sanitizeSettings): strictMode forced on, overlayOpacity + updates added', () => {
  const v1 = clone(DEFAULT_SETTINGS);
  v1.version = 1;
  v1.breaks.strictMode = false;
  v1.breaks.graceSeconds = 0;
  delete v1.breaks.overlayOpacity;
  delete v1.updates;
  v1.language = 'de';
  const out = sanitizeSettings(v1);
  assert.equal(out.version, 3);
  assert.equal(out.breaks.strictMode, true);
  assert.equal(out.breaks.overlayOpacity, 0.6);
  assert.equal(out.breaks.graceSeconds, 0, 'no clamp');
  assert.deepEqual(out.updates, DEFAULT_SETTINGS.updates, '§12: the updates group gets its defaults');
  assert.equal(out.language, 'de', 'other values kept');
  assert.equal(v1.breaks.strictMode, false, 'input not mutated');

  const older = sanitizeSettings({ version: 0, breaks: { strictMode: false, overlayOpacity: 0.9 } });
  assert.equal(older.breaks.strictMode, true);
  assert.equal(older.breaks.overlayOpacity, 0.9, 'a valid value present in an old file is kept');
  assert.deepEqual(older.updates, DEFAULT_SETTINGS.updates);

  // a v2 file only gains the updates defaults – strictMode is NOT forced on again
  const v2 = sanitizeSettings({ version: 2, breaks: { strictMode: false }, updates: { autoCheck: false } });
  assert.equal(v2.version, 3);
  assert.equal(v2.breaks.strictMode, false);
  assert.equal(v2.updates.autoCheck, false, 'an explicit value in the old file wins');
  assert.equal(v2.updates.intervalHours, 24);

  // no migration for current, future or unversioned / invalidly versioned objects
  for (const version of [3, 4, 999, undefined, '1', null, NaN]) {
    const input = { breaks: { strictMode: false } };
    if (version !== undefined) input.version = version;
    const res = sanitizeSettings(input);
    assert.equal(res.breaks.strictMode, false, `version ${String(version)}`);
    assert.equal(res.version, 3);
  }
  const hostile = { breaks: { strictMode: false } };
  Object.defineProperty(hostile, 'version', { enumerable: true, get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => sanitizeSettings(hostile));
});

test('store: v1 file is migrated once and persisted; a later strictMode=false stays', (t) => {
  const filePath = path.join(tmpDir(t), 'settings.json');
  const v1 = clone(DEFAULT_SETTINGS);
  v1.version = 1;
  v1.breaks.strictMode = false;
  delete v1.breaks.overlayOpacity;
  v1.timer.workMinutes = 45;
  v1.timer.preset = 'custom';
  fs.writeFileSync(filePath, JSON.stringify(v1, null, 2));

  const store = createSettingsStore({ filePath });
  assert.equal(store.isFirstRun, false);
  const s = store.get();
  assert.equal(s.version, 3);
  assert.equal(s.breaks.strictMode, true);
  assert.equal(s.breaks.overlayOpacity, 0.6);
  assert.deepEqual(s.updates, DEFAULT_SETTINGS.updates);
  assert.equal(s.timer.workMinutes, 45);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), s, 'migrated file persisted');
  assert.equal(fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes('.corrupt-')).length, 0, 'no backup');

  // the user may switch Pflicht-Pause off again – no re-migration on the next start
  assert.equal(store.update({ breaks: { strictMode: false } }).settings.breaks.strictMode, false);
  const again = createSettingsStore({ filePath });
  assert.equal(again.get().breaks.strictMode, false);
  assert.equal(again.get().version, 3);
});

test('§12: updates group – validation, clamping and rejection of wrong types', (t) => {
  const store = createSettingsStore({ filePath: path.join(tmpDir(t), 'settings.json') });
  assert.deepEqual(store.get().updates,
    { autoCheck: true, intervalHours: 24, autoDownload: false, includePrerelease: false });

  let res = store.update({ updates: { autoCheck: false, intervalHours: 6, autoDownload: true, includePrerelease: true } });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.settings.updates,
    { autoCheck: false, intervalHours: 6, autoDownload: true, includePrerelease: true });

  // int 6..168, rounded and clamped
  for (const [input, expected] of [[1, 6], [5.6, 6], [168, 168], [1000, 168], [23.4, 23], [-4, 6]]) {
    assert.equal(store.update({ updates: { intervalHours: input } }).settings.updates.intervalHours, expected, String(input));
  }
  res = store.update({ updates: { intervalHours: 'daily' } });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^updates\.intervalHours: expected integer 6\.\.168/);
  res = store.update({ updates: { autoCheck: 'off' } });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^updates\.autoCheck: expected boolean/);
  assert.equal(store.get().updates.autoCheck, false, 'previous value kept');
  // unknown keys inside the group are ignored
  assert.equal(store.update({ updates: { feedUrl: 'https://evil.example/' } }).settings.updates.feedUrl, undefined);
});

test('store.update: failed persist is reported in errors, in-memory change stays active and emits change', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'settings.json');
  fs.mkdirSync(filePath); // target is a directory → reading and writing fail
  const store = createSettingsStore({ filePath });
  assert.deepEqual(store.get(), clone(DEFAULT_SETTINGS), 'unreadable file → defaults');
  const changes = [];
  store.on('change', (next, prev) => changes.push({ next, prev }));

  let res = store.update({ language: 'en' });
  assert.equal(res.ok, true, 'the change was applied in memory');
  assert.equal(res.settings.language, 'en');
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^persist: /);
  assert.equal(typeof store.lastWriteError, 'string');
  assert.equal(store.get().language, 'en');
  assert.equal(changes.length, 1, "'change' is emitted – the in-memory state did change");
  assert.equal(changes[0].next.language, 'en');
  assert.ok(fs.statSync(filePath).isDirectory());

  // validation errors and the persist error are both reported
  res = store.update({ language: 'fr', widget: { size: 'large' } });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /^language: /);
  assert.match(res.errors[1], /^persist: /);

  // while the file is out of date even a no-op update retries the write and reports the failure
  res = store.update({ language: 'en' });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^persist: /);
  assert.equal(changes.length, 2, 'no change event for a no-op update');

  // storage is writable again → the retry succeeds, no error
  fs.rmdirSync(filePath);
  res = store.update({ language: 'en' });
  assert.deepEqual(res.errors, []);
  assert.equal(store.lastWriteError, null);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.language, 'en');
  assert.equal(onDisk.widget.size, 'large');
  res = store.update({ language: 'en' });
  assert.deepEqual(res.errors, []);
});

test('store.reset restores defaults, persists and emits change once', (t) => {
  const filePath = path.join(tmpDir(t), 'settings.json');
  const store = createSettingsStore({ filePath });
  store.update({ language: 'en', widget: { position: { x: 5, y: 6 } } });
  let n = 0;
  store.on('change', () => {
    n += 1;
  });
  assert.deepEqual(store.reset(), clone(DEFAULT_SETTINGS));
  assert.equal(n, 1);
  store.reset();
  assert.equal(n, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), clone(DEFAULT_SETTINGS));
});

test('store: an oversized settings file is treated as corrupt and never parsed (review fix L1)', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'settings.json');
  assert.equal(MAX_SETTINGS_BYTES, 1024 * 1024);
  fs.writeFileSync(filePath, JSON.stringify({ ...clone(DEFAULT_SETTINGS), language: 'en' }));
  fs.truncateSync(filePath, MAX_SETTINGS_BYTES + 1);

  const store = createSettingsStore({ filePath });
  assert.equal(store.isFirstRun, false);
  assert.deepEqual(store.get(), clone(DEFAULT_SETTINGS), 'defaults instead of a multi-megabyte parse');
  const backups = fs.readdirSync(dir).filter((f) => /^settings\.corrupt-\d+(-\d+)?\.json$/.test(f));
  assert.equal(backups.length, 1, 'the huge file is kept for the user');
  assert.equal(fs.statSync(path.join(dir, backups[0])).size, MAX_SETTINGS_BYTES + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), clone(DEFAULT_SETTINGS), 'a fresh file was written');

  // just below the cap the file is read normally
  const ok = path.join(dir, 'ok.json');
  fs.writeFileSync(ok, JSON.stringify({ ...clone(DEFAULT_SETTINGS), language: 'en' }));
  assert.equal(createSettingsStore({ filePath: ok }).get().language, 'en');
});
