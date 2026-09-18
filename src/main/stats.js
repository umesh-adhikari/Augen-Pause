'use strict';

/**
 * Daily statistics store. Contract: docs/ARCHITECTURE.md §3.
 * Pure Node – must not require('electron').
 *
 * File format (stats.json):
 *   { "version": 1, "days": { "YYYY-MM-DD": { breaksCompleted, breaksSkipped, … } } }
 *
 * Counting rules:
 * - recordBreak({ type, completed: true, seconds })  → breaksCompleted++, shortBreaks++ / longBreaks++,
 *                                                       breakSeconds += seconds
 * - recordBreak({ type, completed: false, seconds }) → breaksSkipped++, breakSeconds += seconds
 *   (a skipped upcoming break is recorded with seconds: 0, an aborted break with the partial seconds).
 *   Optional `skipped: false` (API addition) records only the partial seconds without counting a skip –
 *   used by the scheduler for a break that was snoozed (the snooze itself is counted via recordSnooze())
 *   or interrupted by a meeting (§9: not counted as skipped).
 * - Dates are local dates. Only the last 400 days are kept.
 *
 * Persistence / events (review fix, ARCHITECTURE §10):
 * - Real events (recordBreak, recordSnooze, recordNaturalBreak, addGlass, removeGlass, reset) emit
 *   'change' and are persisted debounced (`debounceMs`, default 5 s).
 * - addWorkSeconds() (called by the scheduler every second) does NOT emit 'change' and is persisted
 *   at most every `workDebounceMs` (default 60 s). Live work time is available via getToday() /
 *   SchedulerState.today.
 * - Both timers are unref'ed and coalesce: whichever fires first writes everything pending.
 *   flush() writes pending changes immediately (call it on quit / suspend / session end).
 * - stats.json is written compact (no indentation) and without fsync (atomic tmp + rename is kept);
 *   losing the last few seconds of counters on a power cut is acceptable, 585 MB/day of writes is not.
 * - Review fix L1: the file size is checked before reading/parsing – a stats.json larger than
 *   MAX_STATS_BYTES (400 days of counters are ~50 KB) counts as corrupt: backup + start empty.
 */

const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, backupCorrupt } = require('./store');

const STATS_VERSION = 1;
/** stats.json holds at most 400 days of counters (~50 KB); above this it counts as corrupt (L1). */
const MAX_STATS_BYTES = 1024 * 1024;
const MAX_DAYS = 400;
const DEFAULT_DEBOUNCE_MS = 5000;
const DEFAULT_WORK_DEBOUNCE_MS = 60 * 1000;
const WRITE_OPTIONS = Object.freeze({ fsync: false, pretty: false });
const MAX_COUNTER = 1e12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const COUNTERS = Object.freeze([
  'breaksCompleted',
  'breaksSkipped',
  'breaksSnoozed',
  'shortBreaks',
  'longBreaks',
  'naturalBreaks',
  'breakSeconds',
  'workSeconds',
  'glasses',
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local calendar date 'YYYY-MM-DD' of a timestamp. */
function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local date key `offsetDays` calendar days from the date of `ts` (DST-safe). */
function shiftedDateKey(ts, offsetDays) {
  const d = new Date(ts);
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, 12).getTime());
}

function emptyCounters() {
  const c = {};
  for (const k of COUNTERS) c[k] = 0;
  return c;
}

function toNonNegativeInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(MAX_COUNTER, Math.round(v)) : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class StatsStore extends EventEmitter {
  constructor({ filePath, now = Date.now, debounceMs = DEFAULT_DEBOUNCE_MS, workDebounceMs = DEFAULT_WORK_DEBOUNCE_MS }) {
    super();
    this.filePath = filePath;
    /** Last persistence error code (null when the last write succeeded). */
    this.lastWriteError = null;
    this._now = now;
    this._debounceMs = debounceMs;
    this._workDebounceMs = workDebounceMs;
    /** @type {Map<string, object>} date → counters */
    this._days = new Map();
    this._dirty = false;
    /** Debounce timer for real events (short). */
    this._timer = null;
    /** Throttle timer for workSeconds-only changes (long). */
    this._workTimer = null;
    this._load();
  }

  _load() {
    const res = readJson(this.filePath, { maxBytes: MAX_STATS_BYTES });
    if (!res.ok) {
      // Unparsable or absurdly large (never parsed, review fix L1) → keep a copy for the user.
      if (res.error === 'EPARSE' || res.error === 'ETOOBIG') backupCorrupt(this.filePath);
      return; // ENOENT or unreadable → start empty
    }
    const data = res.data;
    if (!isPlainObject(data) || !isPlainObject(data.days)) {
      backupCorrupt(this.filePath);
      return;
    }
    for (const key of Object.keys(data.days)) {
      const entry = data.days[key];
      if (!DATE_RE.test(key) || !isPlainObject(entry)) continue;
      const counters = emptyCounters();
      for (const c of COUNTERS) counters[c] = toNonNegativeInt(entry[c]);
      this._days.set(key, counters);
    }
    this._prune();
  }

  _prune() {
    const cutoff = shiftedDateKey(this._now(), -(MAX_DAYS - 1));
    for (const key of this._days.keys()) {
      if (key < cutoff) this._days.delete(key);
    }
    if (this._days.size > MAX_DAYS) {
      // Guard against entries "from the future" after a clock change.
      const keys = [...this._days.keys()].sort();
      for (const key of keys.slice(0, keys.length - MAX_DAYS)) this._days.delete(key);
    }
  }

  _dayStats(key) {
    const counters = this._days.get(key) || emptyCounters();
    return { date: key, ...counters };
  }

  _startTimer(ms) {
    const timer = setTimeout(() => this.flush(), ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  _clearTimers() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._workTimer) {
      clearTimeout(this._workTimer);
      this._workTimer = null;
    }
  }

  /** Real event: write at most `debounceMs` later (first change of a window starts the timer). */
  _scheduleWrite() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = this._startTimer(this._debounceMs);
  }

  /** workSeconds-only change: write at most every `workDebounceMs` (or with the next event write). */
  _scheduleWorkWrite() {
    this._dirty = true;
    if (this._timer || this._workTimer) return;
    this._workTimer = this._startTimer(this._workDebounceMs);
  }

  /**
   * Applies `fn` to today's counters.
   * @param {boolean} event  true = real event ('change' + short debounce), false = workSeconds only
   */
  _mutate(fn, event = true) {
    const key = localDateKey(this._now());
    let counters = this._days.get(key);
    if (!counters) {
      counters = emptyCounters();
      this._days.set(key, counters);
      this._prune();
    }
    fn(counters);
    const today = this._dayStats(key);
    if (event) {
      this._scheduleWrite();
      this.emit('change', { ...today });
    } else {
      this._scheduleWorkWrite();
    }
    return today;
  }

  _serialize() {
    const days = {};
    for (const key of [...this._days.keys()].sort()) days[key] = { ...this._days.get(key) };
    return { version: STATS_VERSION, days };
  }

  recordBreak(info) {
    const { type, completed, seconds, skipped } = info && typeof info === 'object' ? info : {};
    const isCompleted = completed === true;
    const countSkip = !isCompleted && (typeof skipped === 'boolean' ? skipped : true);
    const secs = toNonNegativeInt(seconds);
    return this._mutate((d) => {
      if (isCompleted) {
        d.breaksCompleted += 1;
        if (type === 'long') d.longBreaks += 1;
        else d.shortBreaks += 1;
      } else if (countSkip) {
        d.breaksSkipped += 1;
      }
      d.breakSeconds += secs;
    });
  }

  recordSnooze() {
    return this._mutate((d) => {
      d.breaksSnoozed += 1;
    });
  }

  recordNaturalBreak() {
    return this._mutate((d) => {
      d.naturalBreaks += 1;
    });
  }

  /** No 'change' event; persisted at most every `workDebounceMs` (see header). */
  addWorkSeconds(seconds) {
    const secs = toNonNegativeInt(seconds);
    if (secs === 0) return this.getToday();
    return this._mutate((d) => {
      d.workSeconds += secs;
    }, false);
  }

  addGlass() {
    return this._mutate((d) => {
      d.glasses += 1;
    });
  }

  removeGlass() {
    return this._mutate((d) => {
      d.glasses = Math.max(0, d.glasses - 1);
    });
  }

  getToday() {
    return this._dayStats(localDateKey(this._now()));
  }

  /** `days` entries ending today, oldest → newest, gaps zero-filled. */
  getRange(days) {
    let n = typeof days === 'number' && Number.isFinite(days) ? Math.round(days) : 7;
    n = Math.min(MAX_DAYS, Math.max(1, n));
    const now = this._now();
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) out.push(this._dayStats(shiftedDateKey(now, -i)));
    return out;
  }

  reset() {
    this._days.clear();
    this._dirty = true;
    this.flush();
    this.emit('change', this.getToday());
  }

  /** true while changes are waiting to be written. */
  get hasPendingWrites() {
    return this._dirty;
  }

  /**
   * Writes pending changes now (compact JSON, no fsync, atomic tmp + rename).
   * A failed write keeps the changes pending; the next change schedules another attempt.
   * @returns {{ ok: boolean, error: string|null }}
   */
  flush() {
    this._clearTimers();
    if (!this._dirty) return { ok: true, error: null };
    this._prune();
    const res = writeJsonAtomic(this.filePath, this._serialize(), WRITE_OPTIONS);
    this.lastWriteError = res.ok ? null : res.error;
    if (res.ok) this._dirty = false;
    return res;
  }
}

function nonNegativeMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * @param {{ filePath: string, now?: () => number, debounceMs?: number, workDebounceMs?: number }} options
 *   debounceMs: write delay after a real event (default 5 s);
 *   workDebounceMs: max. write frequency for workSeconds-only changes (default 60 s).
 */
function createStatsStore({
  filePath,
  now = Date.now,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  workDebounceMs = DEFAULT_WORK_DEBOUNCE_MS,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createStatsStore: filePath must be a non-empty string');
  }
  if (typeof now !== 'function') throw new TypeError('createStatsStore: now must be a function');
  return new StatsStore({
    filePath,
    now,
    debounceMs: nonNegativeMs(debounceMs, DEFAULT_DEBOUNCE_MS),
    workDebounceMs: nonNegativeMs(workDebounceMs, DEFAULT_WORK_DEBOUNCE_MS),
  });
}

module.exports = {
  createStatsStore,
  localDateKey,
  MAX_DAYS,
  MAX_STATS_BYTES,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_WORK_DEBOUNCE_MS,
};
