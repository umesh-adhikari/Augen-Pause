'use strict';

/**
 * Scheduler – the break / hydration timer state machine.
 * Contract: docs/ARCHITECTURE.md §4, §9 (meeting safety), §10 and §11 (mandatory break lock).
 * Pure Node – must not require('electron').
 *
 *   new Scheduler({ getSettings, stats?, now? = Date.now, monotonicNow? = performance.now,
 *                   getIdleSeconds? = () => 0, breakStore? = { load(), save(obj), clear() } })
 *   start() / stop() / tick() / getState()
 *   commands → { ok, error? }: startBreak, skipBreak, snooze, pause, resume, resetWorkTimer, drinkWater,
 *     undoDrink, onSettingsChanged, setMeetingActive, onLock, onUnlock, onSuspend, onResume,
 *     onSystemShutdown(realSessionEnd = true)
 *   events: 'state', 'warning', 'break-start' { type, durationMs, endsAt, resumed? },
 *     'break-end' { type, completed, skipped, snoozed, reason? ('meeting' | 'clock-jump') },
 *     'hydration-reminder', 'natural-break', 'meeting-deferred', 'meeting-defer-expired'
 *
 * Design:
 * - Work periods, pauses, absences and hydration are wall-clock based: they are stored as timestamps
 *   from the injected `now()`. `start()` only drives `tick()` once per second; tests call `tick()`
 *   with a fake clock.
 * - Breaks are tamper-resistant (§11): a running break accumulates `elapsedMs`. Per advance the
 *   wall-clock delta is credited when it is ≥ 0 and agrees with the monotonic delta within
 *   CLOCK_TOLERANCE_MS, otherwise the monotonic delta – so changing the system clock can neither
 *   shorten nor freeze a break. Wall-clock time between onSuspend() and onResume() is credited,
 *   capped at the remaining time (+ CLOCK_TOLERANCE_MS) and at MAX_SUSPEND_CREDIT_MS; a delta beyond
 *   that bound is indistinguishable from an RTC change and ends the break as a PARTIAL one
 *   (`completed: false`, review fix M4). The break ends when elapsedMs ≥ durationMs;
 *   `state.break.endsAt = now + remaining` is recomputed on every tick.
 * - Strict mode ("Pflicht-Pause", §11) is captured when a break starts (`strict`) and used for that
 *   break only – a settings change while the break runs neither ends nor relaxes it. A strict break
 *   has no grace period, cannot be skipped / snoozed / paused (resume + resetWorkTimer + startBreak
 *   are rejected too, all with 'strict-mode') and is not ended by a meeting (state.meeting.active
 *   still reflects the signal; the normal deferral rules apply to the next break).
 *   It ends only when its time is up.
 * - Break persistence (§11): with a `breakStore`, the running break is saved as
 *   { type, durationMs, elapsedMs, strict, savedAt, interrupted: null|'system' } at its start, every
 *   BREAK_SAVE_INTERVAL_MS of break progress, on onSuspend() and on onSystemShutdown()
 *   (interrupted 'system' for a real session end, null for onSystemShutdown(false)), and cleared
 *   whenever a break ends. The first start() validates a saved record strictly and resumes a STRICT
 *   break with its remaining time (downtime is not credited): after a system shutdown only within
 *   idle.resetAfterMinutes (otherwise it counts as a natural break), after a kill / crash within
 *   BREAK_RESUME_MAX_GAP_MS – which is also the hard upper bound for `savedAt`, so a record that can
 *   never be deleted stops resuming after 8 h (review fix L5). Resuming emits
 *   'break-start' { …, resumed: true } during start(), so listeners registered before start() get it.
 *   The 'system' marker is not sticky (review fix L4): when the break keeps progressing for
 *   SHUTDOWN_MARK_TTL_MS after it was set (a cancelled logoff query), it is dropped and the record
 *   rewritten, so the 8 h window applies again instead of idle.resetAfterMinutes.
 * - SchedulerState addition (§11, backwards compatible): `break.strict` = strict mode of the running
 *   break (as captured at its start) while phase break, otherwise breaks.strictMode for the next break.
 * - Every command first advances the state machine to `now()` (so it acts on up-to-date state), then
 *   applies its change. Events are queued while the state is being mutated and emitted afterwards, so
 *   listeners always observe a consistent state (and may safely call back into the scheduler).
 * - Settings are re-read on every tick. Differences to the running period (work duration, hydration
 *   interval, …) are reconciled on every tick, so the scheduler also self-heals if
 *   `onSettingsChanged()` is not called. The sanitized settings are cached by the JSON text of the
 *   last raw settings object (sanitizing costs ~10x more than serializing), and frozen.
 *
 * Notable rules (beyond the contract text):
 * - Snoozing a running break keeps the type of that break for the next break ("type override").
 * - A natural break (absence ≥ idle.resetAfterMinutes) resets the cycle (like a long break) when it
 *   lasted ≥ timer.longBreakSeconds, otherwise it advances the cycle like a short break.
 * - Leaving off-hours after ≥ timer.longBreakSeconds (e.g. over night) resets cycle index and snooze count.
 * - Idle absence start is clamped to the start of the current work segment (a break the user walked
 *   away from is not counted twice).
 * - Work time is committed to stats only while the user is not idle (≥ 5 s idle time is held back and
 *   discarded when the idle period turns into an absence).
 * - While a meeting is active, idle time does not lead to 'away' (camera/mic in use ⇒ user present);
 *   after the meeting (or when its signal becomes ignored) an idle absence starts at that moment at the earliest.
 * - Max meeting deferral (§10): once a due break has been deferred for ≥ MEETING_MAX_DEFER_MS, the
 *   meeting signal is ignored until it reports false once ('meeting-defer-expired'). The break then
 *   follows the normal warning path. While ignored, `state.meeting.active` still reports the raw
 *   signal, but the meeting has no effect at all: no deferral, no warning suppression, no ending of
 *   a break, no idle suppression (a signal stuck for hours must not disable idle detection either).
 * - Grace period (non-strict breaks only, §9): measured in break progress (elapsedMs < graceMs);
 *   it only unlocks snoozing beyond snooze.max.
 * - pause('tomorrow') = next local midnight, or – with working hours enabled – the first working-hours
 *   start on a later calendar day.
 * - Lock + suspend are tracked separately: a lock/suspend absence ends only when neither is active.
 *
 * Command error codes: 'invalid-argument', 'invalid-phase', 'already-in-break', 'strict-mode',
 * 'snooze-limit', 'not-paused', 'in-break', 'off-hours', 'paused'.
 */

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { sanitizeSettings } = require('./settings');

const TICK_INTERVAL_MS = 1000;
/** Max. disagreement between wall-clock and monotonic delta for the wall-clock delta to be trusted (§11). */
const CLOCK_TOLERANCE_MS = 2000;
/** A running break is persisted whenever it progressed by this much since the last save (§11). */
const BREAK_SAVE_INTERVAL_MS = 5000;
/** A break saved by an app that was killed / crashed is resumed only within this time (§11). */
const BREAK_RESUME_MAX_GAP_MS = 8 * 60 * 60 * 1000;
/**
 * Longest suspend that still counts as real break time (review fix M4). A break needs at most its
 * remaining time (≤ 1 h), so anything beyond this is not a plausible sleep any more but a wall-clock
 * change (RTC set while asleep, dual boot): the break is finished, but NOT booked as completed.
 */
const MAX_SUSPEND_CREDIT_MS = 2 * 60 * 60 * 1000;
/**
 * `interrupted: 'system'` is only meaningful while a session end is actually happening. When the
 * break progresses by more than this after the marker was set, the shutdown obviously did not happen
 * (a cancelled Windows logoff query) and the marker is dropped again (review fix L4).
 */
const SHUTDOWN_MARK_TTL_MS = 60 * 1000;
/** Longest break a saved record may describe (settings allow at most 3600 s). */
const MAX_SAVED_BREAK_MS = 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 8.64e15;
/** A tick gap larger than this is handled like an absence (sleep without events). */
const GAP_THRESHOLD_MS = 60 * 1000;
/** Max. work time credited per tick (ignores gaps / stalls). */
const MAX_WORK_TICK_MS = 2000;
/** Idle below this many seconds = user is back / active. */
const IDLE_ACTIVE_SECONDS = 5;
/** A settings change never lets a break (or hydration reminder) start sooner than this. */
const SETTINGS_GRACE_MS = 60 * 1000;
/** After a meeting that deferred a break ends, the break follows after max(this, warnBeforeSeconds). */
const MEETING_RELEASE_MIN_MS = 60 * 1000;
/** A break is deferred by a meeting for at most this long (§10). */
const MEETING_MAX_DEFER_MS = 2 * 60 * 60 * 1000;
const SNOOZE_MIN_MINUTES = 1;
const SNOOZE_MAX_MINUTES = 60;
const SNOOZE_OPTIONS = Object.freeze([5, 10, 15, 30]);
const PAUSE_MAX_MINUTES = 7 * 24 * 60;
const MAX_CYCLE_INDEX = 1000;

function ok() {
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ratio(part, whole) {
  if (!(whole > 0)) return part >= 0 ? 1 : 0;
  return Math.round(clamp(part / whole, 0, 1) * 10000) / 10000;
}

function nonNegInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/** true when `ts` lies inside the configured working hours (or working hours are disabled). */
function isWithinWorkingHours(ts, schedule) {
  if (!schedule || schedule.workingHoursEnabled !== true) return true;
  const d = new Date(ts);
  if (!Array.isArray(schedule.days) || !schedule.days.includes(d.getDay())) return false;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return schedule.start <= hm && hm < schedule.end;
}

/**
 * End of a pause('tomorrow'): next local midnight, or – when working hours are enabled – the start of
 * working hours on the next working day after today.
 */
function pauseUntilTomorrow(ts, schedule) {
  const d = new Date(ts);
  if (schedule && schedule.workingHoursEnabled === true && Array.isArray(schedule.days) && schedule.days.length > 0) {
    const [h, m] = String(schedule.start).split(':').map(Number);
    if (Number.isInteger(h) && Number.isInteger(m)) {
      for (let i = 1; i <= 7; i += 1) {
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
        if (schedule.days.includes(c.getDay())) return c.getTime();
      }
    }
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Strict validation of a saved break record (it comes from disk – untrusted).
 *
 * Hard caps: `durationMs` an integer 1..MAX_SAVED_BREAK_MS (settings allow at most 3600 s),
 * `elapsedMs` a finite number 0..durationMs, `savedAt` a plausible timestamp, `interrupted` only
 * null | 'system', plain own properties only (no prototypes, getters or proxies).
 *
 * @param {any} raw
 * @param {number} [now] when given: records whose `savedAt` is older than BREAK_RESUME_MAX_GAP_MS
 *   are rejected as stale (review fix L5 – a session.json that can never be deleted must not resume
 *   the same break forever). A `savedAt` in the future is kept: downtime can never shorten a break.
 * @returns {{ type: 'short'|'long', durationMs: number, elapsedMs: number, strict: boolean,
 *   savedAt: number, interrupted: null|'system' } | null}  null = invalid
 */
function parseSavedBreak(raw, now) {
  try {
    if (!isObject(raw)) return null;
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = (key) => (Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined);
    const type = own('type');
    const durationMs = own('durationMs');
    const elapsedMs = own('elapsedMs');
    const strict = own('strict');
    const savedAt = own('savedAt');
    const interrupted = own('interrupted');
    if (type !== 'short' && type !== 'long') return null;
    if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_SAVED_BREAK_MS) return null;
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > durationMs) return null;
    if (typeof strict !== 'boolean') return null;
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0 || savedAt > MAX_TIMESTAMP_MS) return null;
    if (interrupted !== null && interrupted !== 'system') return null;
    // L5: stale record (older than the longest resume window) – e.g. a file that cannot be cleared.
    if (typeof now === 'number' && Number.isFinite(now) && now - savedAt >= BREAK_RESUME_MAX_GAP_MS) return null;
    return { type, durationMs, elapsedMs: Math.floor(elapsedMs), strict, savedAt, interrupted };
  } catch {
    return null; // hostile object (throwing getter / proxy)
  }
}

const NULL_STATS = Object.freeze({
  getToday: () => ({ breaksCompleted: 0, breaksSkipped: 0, glasses: 0, workSeconds: 0 }),
});

class Scheduler extends EventEmitter {
  /**
   * @param {{
   *   getSettings: () => object,
   *   stats?: object,
   *   now?: () => number,                 wall clock (ms since epoch)
   *   monotonicNow?: () => number,        monotonic clock (ms), default performance.now()
   *   getIdleSeconds?: () => number,
   *   breakStore?: { load: () => object|null, save: (obj: object) => void, clear: () => void },
   * }} options
   */
  constructor({
    getSettings,
    stats,
    now = Date.now,
    monotonicNow = () => performance.now(),
    getIdleSeconds = () => 0,
    breakStore,
  } = {}) {
    super();
    if (typeof getSettings !== 'function') throw new TypeError('Scheduler: getSettings must be a function');
    this._getSettings = getSettings;
    this._statsStore = stats && typeof stats === 'object' ? stats : NULL_STATS;
    this._nowFn = typeof now === 'function' ? now : Date.now;
    this._monoFn = typeof monotonicNow === 'function' ? monotonicNow : () => performance.now();
    this._idleFn = typeof getIdleSeconds === 'function' ? getIdleSeconds : () => 0;
    this._breakStore = breakStore && typeof breakStore === 'object' ? breakStore : null;

    /** Last valid monotonic reading (used when the monotonic clock fails). */
    this._lastMonoValue = 0;
    /** Monotonic time of the current advance (set in _advance, used when a break begins). */
    this._tickMono = this._mono();
    /** The saved break (breakStore) is checked once, on the first start(). */
    this._restoreChecked = false;
    this._interval = null;
    this._lastCfg = null;
    /** JSON text of the raw settings `_lastCfg` was sanitized from (null = not cacheable). */
    this._lastCfgKey = null;
    this._eventQueue = [];
    this._idleCache = null;

    const t = this._now();
    const cfg = this._config();

    this._lastTick = t;
    this._phase = 'work';
    /** Active work period (phase work) or the frozen one (phase away). */
    this._work = null;
    /**
     * While phase break: { type, startedAt, durationMs, elapsedMs, strict, graceMs, lastWall, lastMono,
     * suspend: null | { wallAt, elapsedAt }, savedElapsedMs, interrupted: null | 'system' }.
     */
    this._break = null;
    /** { since, reason: 'idle'|'lock'|'suspend'|'gap', locked, suspended, remainingMs } while phase away. */
    this._away = null;
    this._pause = { until: null, reason: null };
    this._offHoursSince = null;
    this._cycleIndex = 0;
    this._snoozeCount = 0;
    this._nextTypeOverride = null;
    this._warned = false;
    this._workMsCommitted = 0;
    this._workMsPending = 0;
    this._hyd = { enabled: false, startedAt: null, nextAt: null, intervalMs: 0, frozenAt: null, due: false };
    /** Raw flag from setMeetingActive(); effective only while meeting.autoDetect is on. */
    this._meetingRaw = false;
    /** active/since = raw signal (as reported); deferredSince = start of the current deferral. */
    this._meeting = { active: false, deferred: false, since: null, deferredSince: null };
    /** true after a deferral expired (§10): the meeting signal is ignored until it reports false. */
    this._meetingIgnored = false;
    /** Last moment the meeting signal was effective (user present) – idle before it is not absence. */
    this._meetingPresentAt = null;

    this._startWork(t, cfg);
    this._reconcileSettings(t, cfg);
    this._evaluateWorkingHours(t, cfg);
    this._syncHydration(t);
    this._eventQueue.length = 0;
  }

  // -------------------------------------------------------------------------
  // lifecycle

  start() {
    if (this._interval) return;
    if (!this._restoreChecked) {
      this._restoreChecked = true;
      // Resume a strict break interrupted by a kill / crash / shutdown. Its events stay queued and are
      // emitted by the tick below (after listeners registered before start() are in place).
      const now = this._now();
      const cfg = this._config();
      try {
        this._advance(now, cfg);
        this._restoreSavedBreak(now, cfg);
        this._evaluateWorkingHours(now, cfg);
        this._syncHydration(now);
      } catch (err) {
        this._reportError(err);
      }
    }
    this._interval = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this._reportError(err);
      }
    }, TICK_INTERVAL_MS);
    if (typeof this._interval.unref === 'function') this._interval.unref();
    this.tick();
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Advances the state machine to now() and emits 'state'. */
  tick() {
    const now = this._now();
    const cfg = this._config();
    try {
      this._advance(now, cfg);
    } finally {
      this._flushEvents();
    }
    this._emit('state', this._buildState(now, cfg, this._tickMono));
  }

  /** @returns {object} fresh, JSON-serializable SchedulerState (a running break is projected to now) */
  getState() {
    return this._buildState(this._now(), this._config(), this._mono());
  }

  // -------------------------------------------------------------------------
  // commands

  startBreak(type) {
    return this._command((now, cfg) => {
      if (type !== undefined && type !== null && type !== 'short' && type !== 'long') return fail('invalid-argument');
      if (this._phase === 'break') return fail(this._break.strict ? 'strict-mode' : 'already-in-break');
      this._startBreak(now, type || this._nextBreakType(cfg), cfg);
      return ok();
    });
  }

  skipBreak() {
    return this._command((now, cfg) => {
      if (this._phase === 'break') {
        if (this._break.strict) return fail('strict-mode');
        this._endBreakEarly(now, { skipped: true, snoozed: false });
        this._advanceCycle(false);
        this._snoozeCount = 0;
        this._startWork(now, cfg);
        return ok();
      }
      if (this._phase === 'work') {
        const type = this._nextBreakType(cfg);
        this._commitPendingWork();
        this._stats('recordBreak', { type, completed: false, seconds: 0 });
        this._advanceCycle(false);
        this._snoozeCount = 0;
        this._nextTypeOverride = null;
        this._startWork(now, cfg);
        return ok();
      }
      return fail('invalid-phase');
    });
  }

  snooze(minutes) {
    return this._command((now, cfg) => {
      let mins;
      if (minutes === undefined || minutes === null) mins = cfg.timer.snoozeMinutes;
      else if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
        mins = clamp(Math.round(minutes), SNOOZE_MIN_MINUTES, SNOOZE_MAX_MINUTES);
      } else return fail('invalid-argument');
      const ms = mins * 60000;

      if (this._phase === 'work') {
        if (this._snoozeCount >= cfg.timer.maxSnoozes) return fail('snooze-limit');
        const w = this._work;
        const endsAt = Math.max(w.endsAt, now) + ms;
        w.extraMs += endsAt - w.endsAt;
        w.endsAt = endsAt;
        w.durationMs = endsAt - w.startedAt;
        this._snoozeCount += 1;
        this._warned = false;
        this._clearDeferral();
        this._stats('recordSnooze');
        return ok();
      }

      if (this._phase === 'break') {
        if (this._break.strict) return fail('strict-mode');
        if (!this._inGrace(this._break.elapsedMs) && this._snoozeCount >= cfg.timer.maxSnoozes) {
          return fail('snooze-limit');
        }
        const b = this._endBreakEarly(now, { skipped: false, snoozed: true });
        this._snoozeCount += 1;
        this._startWork(now, cfg, ms);
        this._nextTypeOverride = b.type;
        this._stats('recordSnooze');
        return ok();
      }

      return fail('invalid-phase');
    });
  }

  pause(arg) {
    return this._command((now, cfg) => {
      let until;
      if (arg === undefined || arg === null) until = null;
      else if (arg === 'tomorrow') until = pauseUntilTomorrow(now, cfg.schedule);
      else if (typeof arg === 'number' && Number.isFinite(arg) && arg > 0) {
        until = now + clamp(Math.round(arg), 1, PAUSE_MAX_MINUTES) * 60000;
      } else return fail('invalid-argument');

      if (this._phase === 'break') {
        if (this._break.strict) return fail('strict-mode');
        this._endBreakEarly(now, { skipped: true, snoozed: false });
        this._advanceCycle(false);
        this._snoozeCount = 0;
      } else if (this._phase === 'work') {
        this._commitPendingWork();
      }
      this._clearPhaseData();
      this._phase = 'paused';
      this._pause = { until, reason: 'user' };
      return ok();
    });
  }

  resume() {
    return this._command((now, cfg) => {
      if (this._phase === 'break' && this._break.strict) return fail('strict-mode');
      if (this._phase !== 'paused') return fail('not-paused');
      this._startWork(now, cfg);
      return ok();
    });
  }

  resetWorkTimer() {
    return this._command((now, cfg) => {
      if (this._phase === 'break') return fail(this._break.strict ? 'strict-mode' : 'in-break');
      if (this._phase === 'off-hours') return fail('off-hours');
      if (this._phase === 'paused') return fail('paused');
      if (this._phase === 'work') this._commitPendingWork();
      this._startWork(now, cfg);
      return ok();
    });
  }

  drinkWater() {
    return this._command((now) => {
      this._stats('addGlass');
      const h = this._hyd;
      if (h.enabled) {
        h.due = false;
        h.startedAt = now;
        h.nextAt = now + h.intervalMs;
        if (h.frozenAt !== null) h.frozenAt = now;
      }
      return ok();
    });
  }

  undoDrink() {
    return this._command(() => {
      this._stats('removeGlass');
      return ok();
    });
  }

  onSettingsChanged(newSettings /* , prevSettings */) {
    return this._command(() => ok(), isObject(newSettings) ? newSettings : undefined);
  }

  /** §9: camera/microphone in use. Ignored (treated as false) while meeting.autoDetect is off. */
  setMeetingActive(active) {
    if (typeof active !== 'boolean') return fail('invalid-argument');
    const cfg = this._config();
    this._meetingRaw = active && cfg.meeting.autoDetect === true;
    return this._command(() => ok());
  }

  onLock() {
    return this._command((now) => this._systemAway(now, 'lock'));
  }

  onSuspend() {
    return this._command((now) => this._systemAway(now, 'suspend'));
  }

  onUnlock() {
    return this._command((now, cfg) => this._systemReturn(now, cfg, 'lock'));
  }

  onResume() {
    return this._command((now, cfg) => this._systemReturn(now, cfg, 'suspend'));
  }

  /**
   * §11: OS shutdown / logoff / session end / SIGTERM. Persists a running break so the next start
   * can resume it.
   *
   * @param {boolean} [realSessionEnd=true] whether a real session end was observed (OS shutdown,
   *   logoff, `WM_ENDSESSION`). Then the break is saved with `interrupted: 'system'` and is resumed
   *   on the next start only within idle.resetAfterMinutes (a longer gap counts as a natural break).
   *   `false` – a bare SIGTERM, which any user can send, or a logoff query that may still be
   *   cancelled – saves the break with `interrupted: null`, so the regular kill/crash window of
   *   BREAK_RESUME_MAX_GAP_MS (8 h) applies instead (review fix L4). Anything other than `false`
   *   counts as a real session end (backwards compatible: no argument = true).
   */
  onSystemShutdown(realSessionEnd = true) {
    return this._command((now) => {
      if (this._phase === 'break' && this._break) {
        const b = this._break;
        b.interrupted = realSessionEnd === false ? null : 'system';
        // Marker time (in break progress): it is dropped again when the session end does not happen.
        b.shutdownElapsedMs = b.interrupted === null ? null : b.elapsedMs;
        this._saveBreak(now);
      }
      return ok();
    });
  }

  // -------------------------------------------------------------------------
  // internals: infrastructure

  _now() {
    let t;
    try {
      t = Number(this._nowFn());
    } catch {
      t = NaN;
    }
    return Number.isFinite(t) ? Math.round(t) : Date.now();
  }

  /** Monotonic clock (ms, may be fractional); a failing clock repeats its last valid reading. */
  _mono() {
    let t;
    try {
      t = Number(this._monoFn());
    } catch {
      t = NaN;
    }
    if (Number.isFinite(t)) this._lastMonoValue = t;
    return this._lastMonoValue;
  }

  _callBreakStore(method, ...args) {
    const s = this._breakStore;
    if (!s || typeof s[method] !== 'function') return undefined;
    try {
      return s[method](...args);
    } catch (err) {
      this._reportError(err);
      return undefined;
    }
  }

  _config(override) {
    let raw = override;
    if (raw === undefined) {
      try {
        raw = this._getSettings();
      } catch (err) {
        this._reportError(err);
        raw = undefined;
      }
    }
    if (!isObject(raw)) return this._lastCfg || deepFreeze(sanitizeSettings(null));
    let key = null;
    try {
      key = JSON.stringify(raw);
    } catch {
      key = null; // not serializable (cyclic, throwing getter …) → sanitize without caching
    }
    if (key !== null && key === this._lastCfgKey && this._lastCfg) return this._lastCfg;
    const cfg = deepFreeze(sanitizeSettings(raw));
    this._lastCfg = cfg;
    this._lastCfgKey = typeof key === 'string' ? key : null;
    return cfg;
  }

  /** Meeting signal as it affects breaks / warnings / idle (false while ignored after a max deferral). */
  _meetingEffective() {
    return this._meeting.active && !this._meetingIgnored;
  }

  _clearDeferral() {
    this._meeting.deferred = false;
    this._meeting.deferredSince = null;
  }

  _setDeferred(now) {
    this._meeting.deferred = true;
    this._meeting.deferredSince = now;
  }

  _idleSeconds() {
    if (this._idleCache === null) {
      let v;
      try {
        v = Number(this._idleFn());
      } catch {
        v = 0;
      }
      this._idleCache = Number.isFinite(v) && v > 0 ? v : 0;
    }
    return this._idleCache;
  }

  _stats(method, ...args) {
    const s = this._statsStore;
    if (!s || typeof s[method] !== 'function') return undefined;
    try {
      return s[method](...args);
    } catch (err) {
      this._reportError(err);
      return undefined;
    }
  }

  _today() {
    const t = this._stats('getToday');
    const src = isObject(t) ? t : {};
    return {
      breaksCompleted: nonNegInt(src.breaksCompleted),
      breaksSkipped: nonNegInt(src.breaksSkipped),
      glasses: nonNegInt(src.glasses),
      workSeconds: nonNegInt(src.workSeconds),
    };
  }

  _queue(name, payload) {
    this._eventQueue.push([name, payload]);
  }

  _flushEvents() {
    while (this._eventQueue.length > 0) {
      const [name, payload] = this._eventQueue.shift();
      this._emit(name, payload);
    }
  }

  _emit(name, payload) {
    try {
      this.emit(name, payload);
    } catch (err) {
      this._reportError(err);
    }
  }

  _reportError(err) {
    // eslint-disable-next-line no-console
    console.error('[scheduler]', err);
  }

  _command(fn, settingsOverride) {
    const now = this._now();
    const cfg = this._config(settingsOverride);
    let result;
    try {
      this._advance(now, cfg);
      result = fn(now, cfg) || ok();
      this._evaluateWorkingHours(now, cfg);
      this._syncHydration(now);
    } finally {
      this._flushEvents();
    }
    this._emit('state', this._buildState(now, cfg, this._tickMono));
    return result;
  }

  // -------------------------------------------------------------------------
  // internals: state machine

  _advance(now, cfg) {
    this._idleCache = null;
    this._tickMono = this._mono();
    let delta = now - this._lastTick;
    if (delta < 0) {
      this._shiftTimeline(delta); // wall clock was set back: keep remaining times
      delta = 0;
    }
    this._lastTick = now;

    if (delta > GAP_THRESHOLD_MS) this._handleGap(now - delta, now, cfg);
    else if (this._phase === 'work') this._accumulateWork(delta, cfg);

    this._reconcileSettings(now, cfg);

    if (this._phase === 'paused' && this._pause.until !== null && now >= this._pause.until) {
      this._startWork(now, cfg); // automatic resume
    }

    if (this._phase === 'away' && this._away.reason === 'idle') {
      if (!cfg.idle.enabled || this._idleSeconds() < IDLE_ACTIVE_SECONDS) this._leaveAway(now, cfg);
    }

    if (this._phase === 'break') this._advanceBreak(now, this._tickMono, cfg);

    this._syncMeeting(now, cfg);
    this._evaluateWorkingHours(now, cfg);

    if (this._phase === 'work' && cfg.idle.enabled && !this._meetingEffective()) {
      const idle = this._idleSeconds();
      if (idle >= cfg.idle.resetAfterMinutes * 60) {
        let since = Math.max(now - Math.round(idle * 1000), this._work.segmentStart);
        if (this._meetingPresentAt !== null) since = Math.max(since, this._meetingPresentAt);
        this._enterAway(since, 'idle');
      }
    }

    if (this._phase === 'work') this._checkWorkProgress(now, cfg);

    this._syncHydration(now);
    this._checkHydration(now, cfg);
  }

  _nextBreakType(cfg) {
    if (this._nextTypeOverride) return this._nextTypeOverride;
    const t = cfg.timer;
    return t.longBreakEnabled && this._cycleIndex >= t.longBreakEvery - 1 ? 'long' : 'short';
  }

  _advanceCycle(long) {
    this._cycleIndex = long ? 0 : Math.min(MAX_CYCLE_INDEX, this._cycleIndex + 1);
  }

  _clearPhaseData() {
    this._work = null;
    this._break = null;
    this._away = null;
    this._pause = { until: null, reason: null };
    this._offHoursSince = null;
    this._warned = false;
    this._clearDeferral();
  }

  /** Fresh work period. `baseMs` given = snooze period of that length (not tied to timer.workMinutes). */
  _startWork(now, cfg, baseMs) {
    const fromSettings = baseMs === undefined;
    const base = fromSettings ? cfg.timer.workMinutes * 60000 : baseMs;
    this._clearPhaseData();
    this._phase = 'work';
    this._work = {
      startedAt: now,
      endsAt: now + base,
      durationMs: base,
      baseMs: base,
      extraMs: 0,
      fromSettings,
      segmentStart: now,
    };
  }

  _startBreak(now, type, cfg) {
    if (this._phase === 'work') this._commitPendingWork();
    const durationMs = (type === 'long' ? cfg.timer.longBreakSeconds : cfg.timer.shortBreakSeconds) * 1000;
    const strict = cfg.breaks.strictMode === true;
    this._beginBreak(now, { type, durationMs, elapsedMs: 0, strict, graceMs: strict ? 0 : cfg.breaks.graceSeconds * 1000 });
    this._queue('break-start', { type, durationMs, endsAt: now + durationMs });
  }

  /** Enters phase break (new or resumed break) and persists it. `strict` / `graceMs` are fixed for this break. */
  _beginBreak(now, { type, durationMs, elapsedMs, strict, graceMs }) {
    this._clearPhaseData();
    this._nextTypeOverride = null;
    this._phase = 'break';
    this._break = {
      type,
      startedAt: now - elapsedMs,
      durationMs,
      elapsedMs,
      strict,
      graceMs,
      lastWall: now,
      lastMono: this._tickMono,
      suspend: null,
      savedElapsedMs: elapsedMs,
      interrupted: null,
      shutdownElapsedMs: null,
    };
    this._saveBreak(now);
  }

  /** Break progress to credit since the last advance (§11 tamper-resistant timing). */
  _breakDelta(b, now, mono) {
    const wallDelta = now - b.lastWall;
    const monoDelta = mono - b.lastMono;
    const delta = wallDelta >= 0 && Math.abs(wallDelta - monoDelta) <= CLOCK_TOLERANCE_MS ? wallDelta : monoDelta;
    return delta > 0 ? delta : 0;
  }

  _advanceBreak(now, mono, cfg) {
    const b = this._break;
    b.elapsedMs = Math.min(b.durationMs, b.elapsedMs + this._breakDelta(b, now, mono));
    b.lastWall = now;
    b.lastMono = mono;
    this._dropStaleShutdownMark(now);
    this._checkBreakProgress(now, cfg);
  }

  /**
   * Review fix L4: `interrupted: 'system'` must not be sticky. A Windows logoff query that the user
   * cancels would otherwise leave the running break marked as interrupted by the system for good,
   * silently shrinking its resume window from BREAK_RESUME_MAX_GAP_MS to idle.resetAfterMinutes.
   * The app is still running and the break still progressing SHUTDOWN_MARK_TTL_MS after the marker
   * was set ⇒ no shutdown is in progress ⇒ drop the marker and rewrite the record.
   */
  _dropStaleShutdownMark(now) {
    const b = this._break;
    if (!b || b.interrupted === null) return;
    if (b.shutdownElapsedMs !== null && b.elapsedMs - b.shutdownElapsedMs < SHUTDOWN_MARK_TTL_MS) return;
    b.interrupted = null;
    b.shutdownElapsedMs = null;
    this._saveBreak(now);
  }

  /** Completes the break when its time is up, otherwise persists it every BREAK_SAVE_INTERVAL_MS of progress. */
  _checkBreakProgress(now, cfg) {
    if (this._phase !== 'break') return;
    const b = this._break;
    if (b.elapsedMs >= b.durationMs) this._completeBreak(now, cfg);
    else if (b.elapsedMs - b.savedElapsedMs >= BREAK_SAVE_INTERVAL_MS) this._saveBreak(now);
  }

  _saveBreak(now) {
    const b = this._break;
    if (!b || !this._breakStore) return;
    b.savedElapsedMs = b.elapsedMs;
    this._callBreakStore('save', {
      type: b.type,
      durationMs: b.durationMs,
      elapsedMs: Math.floor(b.elapsedMs),
      strict: b.strict,
      savedAt: now,
      interrupted: b.interrupted,
    });
  }

  /** Grace period of the running break at progress `elapsedMs` (never for strict breaks). */
  _inGrace(elapsedMs) {
    const b = this._break;
    return this._phase === 'break' && b !== null && !b.strict && b.graceMs > 0 && elapsedMs < b.graceMs;
  }

  _completeBreak(now, cfg) {
    const b = this._break;
    this._callBreakStore('clear');
    this._advanceCycle(b.type === 'long');
    this._snoozeCount = 0;
    this._startWork(now, cfg);
    this._stats('recordBreak', { type: b.type, completed: true, seconds: Math.round(b.durationMs / 1000) });
    this._queue('break-end', { type: b.type, completed: true, skipped: false, snoozed: false });
  }

  /**
   * Ends the running break before its end (records partial seconds). Caller sets the next phase.
   * @returns the ended break
   */
  _endBreakEarly(now, { skipped, snoozed, reason }) {
    const b = this._break;
    this._break = null;
    this._callBreakStore('clear');
    const seconds = Math.round(clamp(b.elapsedMs, 0, b.durationMs) / 1000);
    this._stats('recordBreak', { type: b.type, completed: false, seconds, skipped });
    const payload = { type: b.type, completed: false, skipped, snoozed };
    if (reason) payload.reason = reason;
    this._queue('break-end', payload);
    return b;
  }

  /**
   * §11: resumes a strict break saved by a previous run (called once, from the first start()).
   * Invalid, non-strict, finished or expired records are cleared.
   */
  _restoreSavedBreak(now, cfg) {
    // A break started before start() already owns (and has overwritten) the saved record.
    if (!this._breakStore || this._phase === 'break') return;
    const raw = this._callBreakStore('load');
    if (raw === null || raw === undefined) return;
    // `now` also rejects a stale record (> BREAK_RESUME_MAX_GAP_MS old), e.g. one that could never be cleared (L5).
    const saved = parseSavedBreak(raw, now);
    if (saved === null || !saved.strict || saved.elapsedMs >= saved.durationMs) {
      this._callBreakStore('clear');
      return;
    }
    // A savedAt in the future (clock set back) still resumes: the downtime can never shorten a break.
    const gap = now - saved.savedAt;
    if (saved.interrupted === 'system') {
      if (gap >= cfg.idle.resetAfterMinutes * 60000) {
        // Machine was off at least as long as a natural break: no resume, fresh work period.
        this._callBreakStore('clear');
        this._advanceCycle(gap >= cfg.timer.longBreakSeconds * 1000);
        this._snoozeCount = 0;
        this._nextTypeOverride = null;
        if (this._phase === 'work') {
          this._commitPendingWork();
          this._startWork(now, cfg);
        }
        this._stats('recordNaturalBreak');
        this._queue('natural-break', { awayMs: gap });
        return;
      }
    } else if (gap >= BREAK_RESUME_MAX_GAP_MS) {
      this._callBreakStore('clear');
      return;
    }
    if (this._phase === 'work') this._commitPendingWork();
    this._beginBreak(now, {
      type: saved.type,
      durationMs: saved.durationMs,
      elapsedMs: saved.elapsedMs,
      strict: true,
      graceMs: 0,
    });
    const remainingMs = saved.durationMs - saved.elapsedMs;
    this._queue('break-start', { type: saved.type, durationMs: saved.durationMs, endsAt: now + remainingMs, resumed: true });
  }

  _checkWorkProgress(now, cfg) {
    const w = this._work;
    const remaining = w.endsAt - now;
    const warnMs = cfg.timer.warnBeforeSeconds * 1000;
    if (warnMs <= 0 || remaining > warnMs) {
      this._warned = false;
    } else if (!this._warned && remaining > 0 && !this._meetingEffective()) {
      this._warned = true;
      this._queue('warning', { type: this._nextBreakType(cfg), inMs: remaining });
    }
    if (remaining <= 0) {
      if (this._meetingEffective()) {
        if (!this._meeting.deferred) {
          this._setDeferred(now);
          this._queue('meeting-deferred', { type: this._nextBreakType(cfg) });
        }
      } else {
        this._startBreak(now, this._nextBreakType(cfg), cfg);
      }
    }
  }

  // --- work seconds ---------------------------------------------------------

  _accumulateWork(delta, cfg) {
    const ms = clamp(delta, 0, MAX_WORK_TICK_MS);
    if (cfg.idle.enabled && !this._meetingEffective() && this._idleSeconds() >= IDLE_ACTIVE_SECONDS) {
      this._workMsPending += ms; // maybe the start of an absence – decide later
    } else {
      this._workMsCommitted += this._workMsPending + ms;
      this._workMsPending = 0;
      this._flushWorkSeconds();
    }
  }

  _commitPendingWork() {
    this._workMsCommitted += this._workMsPending;
    this._workMsPending = 0;
    this._flushWorkSeconds();
  }

  _flushWorkSeconds() {
    const whole = Math.floor(this._workMsCommitted / 1000);
    if (whole > 0) {
      this._workMsCommitted -= whole * 1000;
      this._stats('addWorkSeconds', whole);
    }
  }

  // --- away -------------------------------------------------------------------

  /** Phase work → away. The remaining work time is frozen at `since`. */
  _enterAway(since, reason) {
    if (reason === 'idle') this._workMsPending = 0; // idle time is absence, not work
    else this._commitPendingWork();
    const w = this._work;
    this._phase = 'away';
    this._away = {
      since,
      reason,
      locked: reason === 'lock',
      suspended: reason === 'suspend',
      remainingMs: clamp(w.endsAt - since, 0, w.durationMs),
    };
  }

  _leaveAway(now, cfg) {
    const a = this._away;
    const w = this._work;
    const awayMs = Math.max(0, now - a.since);
    this._away = null;
    if (awayMs >= cfg.idle.resetAfterMinutes * 60000) {
      this._advanceCycle(awayMs >= cfg.timer.longBreakSeconds * 1000);
      this._snoozeCount = 0;
      this._nextTypeOverride = null;
      this._startWork(now, cfg);
      this._stats('recordNaturalBreak');
      this._queue('natural-break', { awayMs });
      return;
    }
    const elapsed = w.durationMs - a.remainingMs;
    this._phase = 'work';
    w.startedAt = now - elapsed;
    w.endsAt = now + a.remainingMs;
    w.segmentStart = now;
    this._workMsPending = 0;
  }

  _systemAway(now, reason) {
    if (this._phase === 'work') {
      this._enterAway(now, reason);
    } else if (this._phase === 'away') {
      const a = this._away;
      if (reason === 'lock') a.locked = true;
      else a.suspended = true;
      if (a.reason === 'idle' || a.reason === 'gap') a.reason = reason;
    } else if (this._phase === 'break' && reason === 'suspend') {
      // The break keeps running while the machine sleeps: remember where, credit it on resume (§11).
      const b = this._break;
      b.suspend = { wallAt: now, elapsedAt: b.elapsedMs };
      this._saveBreak(now);
    }
    // break / paused / off-hours: otherwise ignored (a lock during a break does not interrupt it)
    return ok();
  }

  _systemReturn(now, cfg, reason) {
    if (this._phase === 'break' && reason === 'suspend') {
      this._creditSuspend(now, cfg);
      return ok();
    }
    if (this._phase !== 'away') return ok();
    const a = this._away;
    if (reason === 'lock') a.locked = false;
    else a.suspended = false;
    if ((a.reason === 'lock' || a.reason === 'suspend') && !a.locked && !a.suspended) this._leaveAway(now, cfg);
    return ok();
  }

  /**
   * Resume after a suspend during a break: the wall-clock time since onSuspend() counts as break
   * time. Progress already credited by ticks since then is not counted twice.
   *
   * Review fix M4: the wall clock is the only source here (the monotonic clock usually stands still
   * while the machine sleeps), so it cannot be cross-checked as in _breakDelta() and is capped:
   * at the break's remaining time (+ CLOCK_TOLERANCE_MS – a break never needs more) and at
   * MAX_SUSPEND_CREDIT_MS. A delta beyond that bound is not a plausible sleep any more (RTC changed
   * while asleep, dual boot): the break is ended, but as a PARTIAL break (`completed: false` in the
   * break-end payload and in the stats, only the seconds really observed) so that a clock jump can
   * never book a break the user did not take. A long sleep whose length the monotonic clock confirms
   * is credited by the regular tick path (_breakDelta) and completes the break normally.
   */
  _creditSuspend(now, cfg) {
    const b = this._break;
    const s = b.suspend;
    if (!s) return;
    b.suspend = null;
    const wallDelta = Math.max(0, now - s.wallAt);
    const remaining = Math.max(0, b.durationMs - s.elapsedAt);
    if (wallDelta > MAX_SUSPEND_CREDIT_MS) {
      // Capped by the plausibility bound: end the break with the progress really observed.
      const ended = this._endBreakEarly(now, { skipped: false, snoozed: false, reason: 'clock-jump' });
      this._advanceCycle(ended.type === 'long');
      this._snoozeCount = 0;
      this._startWork(now, cfg);
      return;
    }
    const credit = Math.min(wallDelta, remaining + CLOCK_TOLERANCE_MS, MAX_SUSPEND_CREDIT_MS);
    b.elapsedMs = Math.min(b.durationMs, Math.max(b.elapsedMs, s.elapsedAt + credit));
    this._checkBreakProgress(now, cfg);
  }

  _handleGap(from, now, cfg) {
    const gap = now - from;
    const h = this._hyd;
    if (h.enabled && h.frozenAt === null && (this._phase === 'work' || this._phase === 'break')) {
      h.startedAt += gap; // hydration is frozen during an absence
      h.nextAt += gap;
    }
    if (this._phase === 'work') {
      this._enterAway(from, 'gap');
      this._leaveAway(now, cfg);
    }
  }

  _shiftTimeline(delta) {
    const shift = (obj, keys) => {
      if (!obj) return;
      for (const k of keys) if (typeof obj[k] === 'number') obj[k] += delta;
    };
    shift(this._work, ['startedAt', 'endsAt', 'segmentStart']);
    // A break's progress does not depend on wall-clock timestamps (see _breakDelta); only its display start moves.
    shift(this._break, ['startedAt']);
    shift(this._away, ['since']);
    shift(this._hyd, ['startedAt', 'nextAt', 'frozenAt']);
    shift(this._meeting, ['since', 'deferredSince']);
    if (this._meetingPresentAt !== null) this._meetingPresentAt += delta;
    if (this._offHoursSince !== null) this._offHoursSince += delta;
  }

  // --- working hours ---------------------------------------------------------

  _evaluateWorkingHours(now, cfg) {
    const inHours = isWithinWorkingHours(now, cfg.schedule);
    if (!inHours && (this._phase === 'work' || this._phase === 'away')) {
      if (this._phase === 'work') this._commitPendingWork();
      this._clearPhaseData();
      this._phase = 'off-hours';
      this._offHoursSince = now;
    } else if (inHours && this._phase === 'off-hours') {
      const since = this._offHoursSince !== null ? this._offHoursSince : now;
      if (now - since >= cfg.timer.longBreakSeconds * 1000) {
        this._cycleIndex = 0;
        this._snoozeCount = 0;
        this._nextTypeOverride = null;
      }
      this._startWork(now, cfg);
    }
  }

  // --- meeting (§9) ------------------------------------------------------------

  _syncMeeting(now, cfg) {
    if (!cfg.meeting.autoDetect) this._meetingRaw = false;
    const active = this._meetingRaw;
    const m = this._meeting;
    const wasEffective = this._meetingEffective();
    if (!active) this._meetingIgnored = false; // the signal reported false once → honoured again
    if (active && !m.active) {
      m.active = true;
      m.since = now;
      if (this._phase === 'break' && !this._meetingIgnored && !this._break.strict) {
        // A meeting starting during a (non-strict) break ends it immediately; the break is deferred.
        // A strict break (§11) keeps running – meeting protection only happens before a break.
        const b = this._endBreakEarly(now, { skipped: false, snoozed: true, reason: 'meeting' });
        this._startWork(now, cfg, 0);
        this._nextTypeOverride = b.type;
        this._setDeferred(now);
        this._queue('meeting-deferred', { type: b.type });
      }
    } else if (!active && m.active) {
      m.active = false;
      m.since = null;
      if (m.deferred) {
        this._clearDeferral();
        this._releaseDeferredBreak(now, cfg);
      }
    }

    // §10: a break is deferred for at most MEETING_MAX_DEFER_MS.
    if (m.deferred && this._meetingEffective() && m.deferredSince !== null && now - m.deferredSince >= MEETING_MAX_DEFER_MS) {
      const deferredMs = now - m.deferredSince;
      this._meetingIgnored = true;
      this._clearDeferral();
      this._releaseDeferredBreak(now, cfg);
      this._queue('meeting-defer-expired', { type: this._nextBreakType(cfg), deferredMs });
    }

    // Camera/mic in use ⇒ user present: idle time up to here never counts as an absence.
    if (wasEffective && !this._meetingEffective()) this._meetingPresentAt = now;
  }

  /** A deferred break follows after max(60 s, warnBeforeSeconds) – via the normal warning path. */
  _releaseDeferredBreak(now, cfg) {
    const releaseMs = Math.max(MEETING_RELEASE_MIN_MS, cfg.timer.warnBeforeSeconds * 1000);
    if (this._phase === 'work') {
      const w = this._work;
      const endsAt = now + releaseMs;
      w.extraMs += endsAt - w.endsAt;
      w.endsAt = endsAt;
      w.durationMs = endsAt - w.startedAt;
      this._warned = false;
    } else if (this._phase === 'away') {
      const w = this._work;
      const a = this._away;
      const elapsed = w.durationMs - a.remainingMs;
      w.extraMs += releaseMs - a.remainingMs;
      a.remainingMs = releaseMs;
      w.durationMs = elapsed + releaseMs;
    }
  }

  // --- settings reconciliation ---------------------------------------------------

  _reconcileSettings(now, cfg) {
    // Work duration of a regular work period (keeps startedAt and snooze extensions).
    const w = this._work;
    if (w && w.fromSettings) {
      const base = cfg.timer.workMinutes * 60000;
      if (base !== w.baseMs) {
        w.baseMs = base;
        const target = base + w.extraMs;
        if (this._phase === 'work' && !this._meeting.deferred) {
          let endsAt = w.startedAt + target;
          if (endsAt < now + SETTINGS_GRACE_MS) endsAt = Math.max(endsAt, Math.min(w.endsAt, now + SETTINGS_GRACE_MS));
          w.endsAt = endsAt;
          w.durationMs = endsAt - w.startedAt;
        } else if (this._phase === 'away') {
          const a = this._away;
          const elapsed = w.durationMs - a.remainingMs;
          let remaining = target - elapsed;
          if (remaining < SETTINGS_GRACE_MS) remaining = Math.max(remaining, Math.min(a.remainingMs, SETTINGS_GRACE_MS));
          a.remainingMs = remaining;
          w.durationMs = elapsed + remaining;
        }
      }
    }

    // Hydration.
    const h = this._hyd;
    if (!cfg.hydration.enabled) {
      if (h.enabled) {
        this._hyd = { enabled: false, startedAt: null, nextAt: null, intervalMs: 0, frozenAt: null, due: false };
      }
    } else {
      const intervalMs = cfg.hydration.intervalMinutes * 60000;
      if (!h.enabled) {
        this._hyd = { enabled: true, startedAt: now, nextAt: now + intervalMs, intervalMs, frozenAt: null, due: false };
      } else if (h.intervalMs !== intervalMs) {
        const ref = h.frozenAt !== null ? h.frozenAt : now;
        let nextAt = h.startedAt + intervalMs;
        if (nextAt < ref + SETTINGS_GRACE_MS) nextAt = Math.max(nextAt, Math.min(h.nextAt, ref + SETTINGS_GRACE_MS));
        h.nextAt = nextAt;
        h.intervalMs = intervalMs;
      }
    }

    if (this._nextTypeOverride === 'long' && !cfg.timer.longBreakEnabled) this._nextTypeOverride = null;
  }

  // --- hydration -------------------------------------------------------------------

  _syncHydration(now) {
    const h = this._hyd;
    if (!h.enabled) return;
    const running = this._phase === 'work' || this._phase === 'break';
    if (running && h.frozenAt !== null) {
      const shift = Math.max(0, now - h.frozenAt);
      h.startedAt += shift;
      h.nextAt += shift;
      h.frozenAt = null;
    } else if (!running && h.frozenAt === null) {
      h.frozenAt = now;
    }
  }

  _checkHydration(now, cfg) {
    const h = this._hyd;
    if (!h.enabled || h.frozenAt !== null) return;
    if (this._phase !== 'work' && this._phase !== 'break') return;
    if (now >= h.nextAt) {
      h.due = true;
      h.startedAt = now;
      h.nextAt = now + h.intervalMs;
      this._queue('hydration-reminder', {
        glassesToday: this._today().glasses,
        goal: cfg.hydration.dailyGoalGlasses,
      });
    }
  }

  // --- state -----------------------------------------------------------------------

  /** @param {number} mono monotonic time belonging to `now` (a running break is projected to it) */
  _buildState(now, cfg, mono) {
    const phase = this._phase;
    const t = cfg.timer;
    const runningBreak = phase === 'break' && this._break ? this._break : null;
    const strictBreak = runningBreak !== null && runningBreak.strict;
    const configuredWorkMs = t.workMinutes * 60000;

    let work;
    if (phase === 'work' && this._work) {
      const w = this._work;
      const remainingMs = Math.max(0, w.endsAt - now);
      work = {
        startedAt: w.startedAt,
        endsAt: w.endsAt,
        durationMs: w.durationMs,
        remainingMs,
        progress: ratio(w.durationMs - remainingMs, w.durationMs),
      };
    } else if (phase === 'away' && this._work && this._away) {
      const w = this._work;
      const remainingMs = this._away.remainingMs;
      work = {
        startedAt: null,
        endsAt: null,
        durationMs: w.durationMs,
        remainingMs,
        progress: ratio(w.durationMs - remainingMs, w.durationMs),
      };
    } else {
      work = { startedAt: null, endsAt: null, durationMs: configuredWorkMs, remainingMs: configuredWorkMs, progress: 0 };
    }

    let brk;
    let inGrace = false;
    let graceUntil = null;
    if (runningBreak) {
      const b = runningBreak;
      const elapsed = Math.min(b.durationMs, b.elapsedMs + this._breakDelta(b, now, mono));
      const remainingMs = Math.max(0, Math.round(b.durationMs - elapsed));
      brk = {
        type: b.type,
        startedAt: b.startedAt,
        endsAt: now + remainingMs,
        durationMs: b.durationMs,
        remainingMs,
        progress: ratio(b.durationMs - remainingMs, b.durationMs),
      };
      inGrace = this._inGrace(elapsed);
      if (inGrace) graceUntil = now + Math.round(b.graceMs - elapsed);
    } else {
      const type = this._nextBreakType(cfg);
      const durationMs = (type === 'long' ? t.longBreakSeconds : t.shortBreakSeconds) * 1000;
      brk = { type, startedAt: null, endsAt: null, durationMs, remainingMs: durationMs, progress: 0 };
    }
    brk.canSkip = !strictBreak;
    brk.canSnooze = strictBreak ? false : inGrace || this._snoozeCount < t.maxSnoozes;
    brk.skipHoldSeconds = cfg.breaks.skipHoldSeconds;
    brk.lockScreen = cfg.breaks.lockScreen;
    brk.inGrace = inGrace;
    brk.graceUntil = graceUntil;
    // §11 addition: strict mode of the running break (captured at its start), otherwise of the next break.
    brk.strict = runningBreak ? runningBreak.strict : cfg.breaks.strictMode === true;

    const warnMs = t.warnBeforeSeconds * 1000;
    const warning =
      phase === 'work' && warnMs > 0 && !this._meetingEffective() && work.remainingMs > 0 && work.remainingMs <= warnMs;

    const today = this._today();
    const h = this._hyd;
    let hydration;
    if (h.enabled) {
      const frozen = h.frozenAt !== null || (phase !== 'work' && phase !== 'break');
      const ref = h.frozenAt !== null ? h.frozenAt : now;
      const remainingMs = Math.max(0, h.nextAt - ref);
      hydration = {
        enabled: true,
        nextAt: frozen ? null : h.nextAt,
        intervalMs: h.intervalMs,
        remainingMs,
        progress: ratio(ref - h.startedAt, h.nextAt - h.startedAt),
        due: h.due,
        glassesToday: today.glasses,
        goal: cfg.hydration.dailyGoalGlasses,
      };
    } else {
      hydration = {
        enabled: false,
        nextAt: null,
        intervalMs: 0,
        remainingMs: 0,
        progress: 0,
        due: false,
        glassesToday: today.glasses,
        goal: cfg.hydration.dailyGoalGlasses,
      };
    }

    return {
      now,
      phase,
      warning,
      work,
      break: brk,
      cycle: { index: this._cycleIndex, longEvery: t.longBreakEvery, longEnabled: t.longBreakEnabled },
      pause: phase === 'paused' ? { until: this._pause.until, reason: 'user' } : { until: null, reason: null },
      away: { since: phase === 'away' && this._away ? this._away.since : null },
      snooze: { count: this._snoozeCount, max: t.maxSnoozes, options: [...SNOOZE_OPTIONS] },
      meeting: {
        active: this._meeting.active,
        deferred: this._meeting.deferred,
        since: this._meeting.active ? this._meeting.since : null,
      },
      hydration,
      today,
    };
  }
}

module.exports = {
  Scheduler,
  isWithinWorkingHours,
  pauseUntilTomorrow,
  parseSavedBreak,
  SNOOZE_OPTIONS,
  MEETING_MAX_DEFER_MS,
  MEETING_RELEASE_MIN_MS,
  BREAK_RESUME_MAX_GAP_MS,
  BREAK_SAVE_INTERVAL_MS,
  CLOCK_TOLERANCE_MS,
  MAX_SUSPEND_CREDIT_MS,
  SHUTDOWN_MARK_TTL_MS,
  MAX_SAVED_BREAK_MS,
};
