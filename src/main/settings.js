'use strict';

/**
 * Settings: defaults, presets, strict validation and the persistent store.
 * Contract: docs/ARCHITECTURE.md §2 (+ §9 additions: breaks.graceSeconds, widget.showOnWarning,
 * meeting.autoDetect; §11: breaks.strictMode default true ("Pflicht-Pause"), breaks.overlayOpacity).
 * Pure Node – must not require('electron').
 *
 * Versions / migrations – applied by sanitizeSettings() when the input carries an explicit numeric
 * `version` lower than SETTINGS_VERSION (objects without a version are treated as current):
 * - v1 → v2 (§11): breaks.strictMode = true (the mandatory break lock is switched on for existing
 *   installations too), breaks.overlayOpacity added with its default. The former §10 clamp
 *   "graceSeconds ≥ 5 in strict mode" is gone: a strict break has no grace period at all,
 *   graceSeconds only applies to non-strict breaks.
 * - v2 → v3 (§12): the `updates` group (autoCheck, intervalHours, autoDownload, includePrerelease).
 *   Older files simply get the defaults – the update check is on, so an existing installation learns
 *   about new versions; it can be switched off in the settings.
 *
 * Every value that reaches this module from a renderer is untrusted. Only keys
 * declared in SCHEMA are ever read (own properties only), so unknown keys and
 * prototype-pollution keys (__proto__, constructor, prototype) are ignored.
 * Inputs are never mutated; all returned objects are fresh deep copies.
 *
 * Review fix L1: the store checks the file size before reading/parsing – a settings.json larger
 * than MAX_SETTINGS_BYTES is treated exactly like a corrupt one (backup + defaults) instead of
 * stalling the startup.
 */

const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, backupCorrupt } = require('./store');

const SETTINGS_VERSION = 3;
/** settings.json is a few KB; anything above this is treated as corrupt instead of being parsed (L1). */
const MAX_SETTINGS_BYTES = 1024 * 1024;

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/** Deep copy of plain JSON data. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false; // e.g. a hostile Proxy
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const DEFAULT_SETTINGS = deepFreeze({
  version: SETTINGS_VERSION,
  language: 'system',
  timer: {
    preset: 'halfhour',
    workMinutes: 30,
    shortBreakSeconds: 120,
    longBreakEnabled: true,
    longBreakSeconds: 600,
    longBreakEvery: 4,
    warnBeforeSeconds: 60,
    snoozeMinutes: 5,
    maxSnoozes: 2,
  },
  breaks: {
    lockScreen: true,
    strictMode: true,
    skipHoldSeconds: 3,
    graceSeconds: 15,
    allDisplays: true,
    showExercises: true,
    soundEnabled: true,
    soundVolume: 0.5,
    overlayOpacity: 0.6,
  },
  idle: {
    enabled: true,
    resetAfterMinutes: 5,
  },
  hydration: {
    enabled: true,
    intervalMinutes: 45,
    dailyGoalGlasses: 8,
    glassMl: 250,
  },
  schedule: {
    workingHoursEnabled: false,
    days: [1, 2, 3, 4, 5],
    start: '08:00',
    end: '18:00',
  },
  widget: {
    visible: true,
    alwaysOnTop: true,
    size: 'medium',
    opacity: 0.95,
    showSeconds: true,
    showOnWarning: true,
    position: null,
  },
  appearance: {
    theme: 'system',
    accent: 'teal',
  },
  general: {
    autostart: false,
    globalShortcuts: true,
    notifications: true,
  },
  meeting: {
    autoDetect: true,
  },
  updates: {
    autoCheck: true,
    intervalHours: 24,
    autoDownload: false,
    includePrerelease: false,
  },
});

const PRESETS = deepFreeze({
  halfhour: { workMinutes: 30, shortBreakSeconds: 120, longBreakSeconds: 600, longBreakEvery: 4 },
  hourly: { workMinutes: 60, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 3 },
  '20-20-20': { workMinutes: 20, shortBreakSeconds: 20, longBreakSeconds: 300, longBreakEvery: 6 },
  pomodoro: { workMinutes: 25, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 4 },
});

/** Timer fields controlled by a preset. */
const PRESET_FIELDS = Object.freeze(['workMinutes', 'shortBreakSeconds', 'longBreakSeconds', 'longBreakEvery']);

// ---------------------------------------------------------------------------
// Leaf validators: (value) → { ok: true, value } | { ok: false, error }

const valid = (value) => ({ ok: true, value });
const invalid = (error) => ({ ok: false, error });

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const bool = () => (v) => (typeof v === 'boolean' ? valid(v) : invalid('expected boolean'));

const int = (min, max) => (v) =>
  isFiniteNumber(v)
    ? valid(clamp(Math.round(v), min, max) + 0) // `+ 0` normalises -0
    : invalid(`expected integer ${min}..${max}`);

const num = (min, max) => (v) =>
  isFiniteNumber(v)
    ? valid(clamp(Math.round(v * 100) / 100, min, max) + 0)
    : invalid(`expected number ${min}..${max}`);

const oneOf = (list) => (v) =>
  typeof v === 'string' && list.includes(v) ? valid(v) : invalid(`expected one of ${list.join(', ')}`);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = () => (v) => (typeof v === 'string' && TIME_RE.test(v) ? valid(v) : invalid("expected 'HH:MM' (00:00-23:59)"));

const MAX_DAYS_ENTRIES = 100;
const days = () => (v) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_DAYS_ENTRIES) {
    return invalid('expected non-empty array of weekdays 0..6');
  }
  const set = new Set();
  for (let i = 0; i < v.length; i += 1) {
    const d = v[i];
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
      return invalid('expected non-empty array of weekdays 0..6');
    }
    set.add(d);
  }
  return valid([...set].sort((a, b) => a - b));
};

const POSITION_LIMIT = 100000;
const position = () => (v) => {
  if (v === null) return valid(null);
  if (isPlainObject(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y)) {
    const x = Math.round(v.x) + 0;
    const y = Math.round(v.y) + 0;
    if (Math.abs(x) <= POSITION_LIMIT && Math.abs(y) <= POSITION_LIMIT) return valid({ x, y });
  }
  return invalid(`expected null or { x, y } integers within ±${POSITION_LIMIT}`);
};

/** Schema of all user-changeable settings (`version` is managed internally). */
const SCHEMA = {
  language: oneOf(['system', 'de', 'en']),
  timer: {
    preset: oneOf(['halfhour', 'hourly', '20-20-20', 'pomodoro', 'custom']),
    workMinutes: int(1, 240),
    shortBreakSeconds: int(20, 1800),
    longBreakEnabled: bool(),
    longBreakSeconds: int(60, 3600),
    longBreakEvery: int(2, 12),
    warnBeforeSeconds: int(0, 600),
    snoozeMinutes: int(1, 30),
    maxSnoozes: int(0, 10),
  },
  breaks: {
    lockScreen: bool(),
    strictMode: bool(),
    skipHoldSeconds: int(0, 10),
    graceSeconds: int(0, 120),
    allDisplays: bool(),
    showExercises: bool(),
    soundEnabled: bool(),
    soundVolume: num(0, 1),
    overlayOpacity: num(0.2, 1),
  },
  idle: {
    enabled: bool(),
    resetAfterMinutes: int(1, 60),
  },
  hydration: {
    enabled: bool(),
    intervalMinutes: int(10, 240),
    dailyGoalGlasses: int(1, 30),
    glassMl: int(50, 1000),
  },
  schedule: {
    workingHoursEnabled: bool(),
    days: days(),
    start: time(),
    end: time(),
  },
  widget: {
    visible: bool(),
    alwaysOnTop: bool(),
    size: oneOf(['small', 'medium', 'large']),
    opacity: num(0.3, 1),
    showSeconds: bool(),
    showOnWarning: bool(),
    position: position(),
  },
  appearance: {
    theme: oneOf(['system', 'dark', 'light']),
    accent: oneOf(['teal', 'violet', 'blue', 'green', 'orange', 'pink']),
  },
  general: {
    autostart: bool(),
    globalShortcuts: bool(),
    notifications: bool(),
  },
  meeting: {
    autoDetect: bool(),
  },
  updates: {
    autoCheck: bool(),
    intervalHours: int(6, 168),
    autoDownload: bool(),
    includePrerelease: bool(),
  },
};

/**
 * Walks `schema`, copying validated leaves from `src` into `dst`.
 * Only own properties named in the schema are read.
 */
function applyTree(schema, src, dst, prefix, errors, applied) {
  for (const key of Object.keys(schema)) {
    if (!hasOwn(src, key)) continue;
    const node = schema[key];
    const value = src[key];
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof node === 'function') {
      const result = node(value);
      if (result.ok) {
        dst[key] = result.value;
        applied.add(keyPath);
      } else {
        errors.push(`${keyPath}: ${result.error}`);
      }
    } else if (isPlainObject(value)) {
      applyTree(node, value, dst[key], keyPath, errors, applied);
    } else {
      errors.push(`${keyPath}: expected object`);
    }
  }
}

function presetMatches(timer, presetName) {
  const preset = PRESETS[presetName];
  return Boolean(preset) && PRESET_FIELDS.every((f) => timer[f] === preset[f]);
}

/** Explicit numeric `version` of an untrusted settings object, or null (missing / not a number / unreadable). */
function readVersion(input) {
  try {
    if (!hasOwn(input, 'version')) return null;
    return isFiniteNumber(input.version) ? input.version : null;
  } catch {
    return null; // e.g. a throwing getter
  }
}

/**
 * Migrates an already sanitized settings object `out` (mutated) that was created from an input of
 * `fromVersion`. Only applied for an explicit older version – never for current, future or
 * unversioned objects (the scheduler sanitizes in-memory settings on every change).
 */
function migrate(out, fromVersion) {
  if (fromVersion === null || fromVersion >= SETTINGS_VERSION) return;
  if (fromVersion < 2) {
    // §11: the mandatory break lock ("Pflicht-Pause") becomes the default for existing installations.
    // overlayOpacity needs no step: a missing value already got its default during sanitizing.
    out.breaks.strictMode = true;
  }
  // v2 → v3 (§12) needs no step either: the whole `updates` group is missing in an older file and
  // therefore already carries its defaults (autoCheck on, every 24 h, no auto download, no prereleases).
}

/**
 * Full sanitize of an untrusted, possibly partial/old settings object (e.g. from disk).
 * Missing or invalid values fall back to defaults. Never throws, never mutates input.
 */
function sanitizeSettings(input) {
  const out = clone(DEFAULT_SETTINGS);
  const applied = new Set();
  if (isPlainObject(input)) {
    try {
      applyTree(SCHEMA, input, out, '', [], applied);
    } catch {
      return clone(DEFAULT_SETTINGS);
    }
  }

  // Preset consistency: fields missing in the input follow the named preset;
  // explicit values that differ from it turn the preset into 'custom'.
  if (out.timer.preset !== 'custom') {
    const preset = PRESETS[out.timer.preset];
    for (const f of PRESET_FIELDS) {
      if (!applied.has(`timer.${f}`)) out.timer[f] = preset[f];
    }
    if (!presetMatches(out.timer, out.timer.preset)) out.timer.preset = 'custom';
  }

  if (!(out.schedule.end > out.schedule.start)) {
    out.schedule.start = DEFAULT_SETTINGS.schedule.start;
    out.schedule.end = DEFAULT_SETTINGS.schedule.end;
  }

  migrate(out, readVersion(input));

  out.version = SETTINGS_VERSION;
  return out;
}

// ---------------------------------------------------------------------------

class SettingsStore extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    /** Last persistence error code (null when the last write succeeded). */
    this.lastWriteError = null;
    this._isFirstRun = false;
    this._current = null;
    this._load();
  }

  /** true when no settings file existed at startup. */
  get isFirstRun() {
    return this._isFirstRun;
  }

  _load() {
    // A file above the size cap is never parsed and counts as corrupt (review fix L1).
    const res = readJson(this.filePath, { maxBytes: MAX_SETTINGS_BYTES });
    if (res.ok && isPlainObject(res.data)) {
      this._current = sanitizeSettings(res.data);
      // Migrate old / partial / hand-edited files to the canonical shape.
      if (JSON.stringify(this._current) !== JSON.stringify(res.data)) this._persist();
      return;
    }
    this._current = clone(DEFAULT_SETTINGS);
    if (res.ok || res.error === 'EPARSE' || res.error === 'ETOOBIG') {
      // Valid JSON of the wrong shape, unparsable or absurdly large → keep a copy for the user.
      backupCorrupt(this.filePath);
      this._persist();
    } else if (res.error === 'ENOENT') {
      this._isFirstRun = true;
      this._persist();
    }
    // Other read errors (e.g. EACCES): run with defaults but do not overwrite the file.
  }

  _persist() {
    const res = writeJsonAtomic(this.filePath, this._current);
    this.lastWriteError = res.ok ? null : res.error;
    return res.ok;
  }

  get() {
    return clone(this._current);
  }

  /**
   * Applies an untrusted deep-partial patch.
   *
   * - `ok` is false only when nothing could be applied and there are validation errors.
   * - Persist failure: when the (changed) settings cannot be written, `errors` contains
   *   `'persist: …'`, but `ok` stays true and `settings` is the new in-memory state – the change
   *   IS active for this session (and 'change' is emitted, main relies on it); it is just not saved.
   *   While the file is out of date (`lastWriteError` set), every later update retries the write,
   *   even a no-op one, and reports the result the same way.
   * @returns {{ ok: boolean, settings: object, errors: string[] }}
   */
  update(patch) {
    const prev = this._current;
    if (!isPlainObject(patch)) {
      return { ok: false, settings: clone(prev), errors: ['patch: expected object'] };
    }

    const next = clone(prev);
    const errors = [];
    const applied = new Set();
    try {
      applyTree(SCHEMA, patch, next, '', errors, applied);
    } catch {
      return { ok: false, settings: clone(prev), errors: ['patch: unreadable'] };
    }

    // Preset logic.
    if (applied.has('timer.preset') && next.timer.preset !== 'custom') {
      // Selecting a preset wins over other preset-controlled values in the same patch.
      Object.assign(next.timer, PRESETS[next.timer.preset]);
    } else if (
      next.timer.preset !== 'custom' &&
      PRESET_FIELDS.some((f) => applied.has(`timer.${f}`)) &&
      !presetMatches(next.timer, next.timer.preset)
    ) {
      next.timer.preset = 'custom';
    }

    // Working hours must be a non-empty range.
    if ((applied.has('schedule.start') || applied.has('schedule.end')) && !(next.schedule.end > next.schedule.start)) {
      next.schedule.start = prev.schedule.start;
      next.schedule.end = prev.schedule.end;
      applied.delete('schedule.start');
      applied.delete('schedule.end');
      errors.push('schedule.end: must be later than schedule.start');
    }

    const ok = !(errors.length > 0 && applied.size === 0);
    const changed = JSON.stringify(next) !== JSON.stringify(prev);
    if (changed) this._current = next;
    if (changed || this.lastWriteError !== null) {
      if (!this._persist()) errors.push(`persist: settings could not be saved (${this.lastWriteError})`);
    }
    if (changed) this.emit('change', clone(next), clone(prev));
    return { ok, settings: clone(this._current), errors };
  }

  /** Restores defaults (persisted). */
  reset() {
    const prev = this._current;
    this._current = clone(DEFAULT_SETTINGS);
    this._persist();
    if (JSON.stringify(this._current) !== JSON.stringify(prev)) {
      this.emit('change', clone(this._current), clone(prev));
    }
    return clone(this._current);
  }
}

function createSettingsStore({ filePath } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createSettingsStore: filePath must be a non-empty string');
  }
  return new SettingsStore(filePath);
}

module.exports = {
  SETTINGS_VERSION,
  MAX_SETTINGS_BYTES,
  DEFAULT_SETTINGS,
  PRESETS,
  PRESET_FIELDS,
  sanitizeSettings,
  createSettingsStore,
};
