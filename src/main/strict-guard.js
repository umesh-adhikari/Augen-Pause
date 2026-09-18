'use strict';

/**
 * Mandatory break ("Pflicht-Pause") guard – pure decision logic, no electron (docs/ARCHITECTURE.md §11).
 * Used by main.js (performAction, settings from menu / tray / IPC), ipc.js, windows.js, tray.js, shortcuts.js,
 * notifications.js and meeting.js; unit-tested in test/strict-guard.test.js.
 *
 * During a strict break
 *   - only the actions `drink` and `undo-drink` are allowed (every source: IPC, menu, tray, shortcut, notification,
 *     overlay Esc, second instance, macOS activate …),
 *   - settings patches may only change `language` and `appearance.*`,
 *   - reset-settings / reset-stats are rejected, quitting is blocked (except OS shutdown / logoff / SIGTERM).
 * During ANY break `breaks.strictMode` cannot be changed (the mode of a running break is fixed at its start).
 *
 * Because that lock is so tight it needs an escape hatch that does NOT depend on the scheduler:
 * breakLockDeadline() + evaluateBreakOverdue() decide when a break has to be considered stuck
 * (see main.js → checkBreakSafety / forceEndBreakLock).
 */

const STRICT_ALLOWED_ACTIONS = Object.freeze(['drink', 'undo-drink']);
/** Top-level settings keys a strict break lets through unchanged (`appearance` = the whole group). */
const STRICT_ALLOWED_SETTINGS = Object.freeze(['language', 'appearance']);
const STRICT_ERROR = 'strict-mode';
const STRICT_SETTINGS_ERROR_PREFIX = 'strict-break';
const BREAK_SETTINGS_ERROR_PREFIX = 'break-running';
/** Grace a break gets past its own end before it counts as stuck (§10 safety net, §11 escape hatch). */
const OVERDUE_BREAK_MS = 10000;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** true when a (validated) patch still contains at least one value to apply. */
function hasAnyLeaf(value) {
  if (!isPlainObject(value)) return value !== undefined;
  return Object.keys(value).some((key) => hasAnyLeaf(value[key]));
}

/** @returns {boolean} */
function isActionAllowedDuringStrictBreak(name) {
  return typeof name === 'string' && STRICT_ALLOWED_ACTIONS.includes(name);
}

/**
 * Keeps only `language` and `appearance.*` of a settings patch. The input is never mutated.
 * Rejected keys are reported as dotted paths one level deep: 'breaks.strictMode', 'timer.workMinutes', 'widget.position'.
 * @param {object} patch a patch that already passed validateSettingsPatch()
 * @returns {{ patch: object, rejectedKeys: string[] }}
 */
function filterSettingsPatchForStrictBreak(patch) {
  const out = {};
  const rejectedKeys = [];
  if (!isPlainObject(patch)) return { patch: out, rejectedKeys };
  for (const key of Object.keys(patch)) {
    if (STRICT_ALLOWED_SETTINGS.includes(key)) {
      out[key] = patch[key];
      continue;
    }
    const value = patch[key];
    if (isPlainObject(value)) {
      for (const sub of Object.keys(value)) rejectedKeys.push(`${key}.${sub}`);
    } else {
      rejectedKeys.push(key);
    }
  }
  return { patch: out, rejectedKeys };
}

/**
 * Removes a change of `breaks.strictMode` (any break – strict or not – keeps the mode it started with).
 * A value equal to the current setting is harmless and kept.
 * @returns {{ patch: object, rejectedKeys: string[] }}
 */
function stripStrictModeChange(patch, currentStrictMode) {
  const breaks = patch && patch.breaks;
  if (!isPlainObject(breaks) || !own(breaks, 'strictMode') || breaks.strictMode === currentStrictMode) {
    return { patch, rejectedKeys: [] };
  }
  const { strictMode: _dropped, ...rest } = breaks;
  return { patch: { ...patch, breaks: rest }, rejectedKeys: ['breaks.strictMode'] };
}

/**
 * Settings guard for every settings source (menu, tray, IPC, internal).
 * @param {object} patch validated patch
 * @param {{ strictBreak?: boolean, inBreak?: boolean, strictMode?: boolean }} context
 * @returns {{ patch: object, errors: string[], empty: boolean }}
 *   errors: 'strict-break: <key>' (strict break) or 'break-running: breaks.strictMode' (any other break);
 *   empty: something was rejected and nothing is left to apply (→ do not call the store at all).
 */
function guardSettingsPatch(patch, { strictBreak = false, inBreak = false, strictMode } = {}) {
  if (strictBreak) {
    const filtered = filterSettingsPatchForStrictBreak(patch);
    return {
      patch: filtered.patch,
      errors: filtered.rejectedKeys.map((key) => `${STRICT_SETTINGS_ERROR_PREFIX}: ${key}`),
      empty: filtered.rejectedKeys.length > 0 && !hasAnyLeaf(filtered.patch),
    };
  }
  if (inBreak) {
    const stripped = stripStrictModeChange(patch, strictMode === true);
    return {
      patch: stripped.patch,
      errors: stripped.rejectedKeys.map((key) => `${BREAK_SETTINGS_ERROR_PREFIX}: ${key}`),
      empty: stripped.rejectedKeys.length > 0 && !hasAnyLeaf(stripped.patch),
    };
  }
  return { patch, errors: [], empty: false };
}

/**
 * Whether the break that just started is a strict one – captured once at 'break-start' so that nothing
 * that happens during the break can change it.
 * @param {{ strict?: boolean, resumed?: boolean }|null} info 'break-start' payload
 * @param {object|null} settings
 */
function strictFlagForBreakStart(info, settings) {
  if (info && typeof info.strict === 'boolean') return info.strict;
  if (info && info.resumed === true) return true; // only strict breaks are resumed after a restart (§11)
  return Boolean(settings && settings.breaks && settings.breaks.strictMode === true);
}

/**
 * The single strict-break decision. Fail-closed: strict as soon as either main's captured flag or the scheduler
 * (state.break.strict – captured by the scheduler at break start – or canSkip:false) says so; settings only matter
 * when neither knows.
 * @param {object|null} state SchedulerState
 * @param {object|null} settings Settings (only used when nothing was captured)
 * @param {boolean|null} [captured] strictFlagForBreakStart() of the running break, null when unknown
 * @returns {boolean}
 */
function isStrictBreakState(state, settings, captured = null) {
  if (!state || state.phase !== 'break') return false;
  const brk = state.break && typeof state.break === 'object' ? state.break : {};
  if (captured === true || brk.strict === true || brk.canSkip === false) return true;
  if (captured === false || brk.strict === false) return false;
  return Boolean(settings && settings.breaks && settings.breaks.strictMode === true);
}

// ---------------------------------------------------------------------------------------------
// Stuck break detection – the escape hatch out of the lock (H1)

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Deadline after which a starting break must be considered stuck, measured on a MONOTONIC clock so that
 * changing the wall clock can neither shorten the break (§11) nor trip the safety net.
 *
 * The scheduler is deliberately not asked again later: `state.break.endsAt` is re-projected to
 * `now + remainingMs` on every getState() (§11), so a scheduler whose tick() keeps throwing reports a
 * break that is never overdue. The deadline is therefore taken ONCE, from the 'break-start' payload
 * (`endsAt` – correct for a resumed break too – otherwise the full `durationMs`), plus `overdueMs` grace.
 *
 * @param {{ durationMs?: number, endsAt?: number, remainingMs?: number }|null} info 'break-start' payload
 *   or `state.break` (both carry endsAt / durationMs)
 * @param {{ monoNow: number, wallNow: number, overdueMs?: number }} clocks
 *   monoNow: monotonic reading (performance.now()), wallNow: the wall clock `endsAt` belongs to
 * @returns {number|null} monotonic deadline, null when the payload carries no usable duration
 */
function breakLockDeadline(info, { monoNow, wallNow, overdueMs = OVERDUE_BREAK_MS } = {}) {
  if (!finite(monoNow)) return null;
  const grace = finite(overdueMs) && overdueMs >= 0 ? overdueMs : OVERDUE_BREAK_MS;
  const brk = info && typeof info === 'object' ? info : {};
  let remaining = null;
  if (finite(brk.endsAt) && finite(wallNow)) remaining = brk.endsAt - wallNow;
  else if (finite(brk.remainingMs)) remaining = brk.remainingMs;
  if (remaining === null || remaining < 0) {
    if (!finite(brk.durationMs) || brk.durationMs < 0) return null;
    remaining = brk.durationMs;
  }
  return monoNow + remaining + grace;
}

/**
 * Is the running break stuck? Two independent signals, either is enough:
 *   1. the monotonic deadline from breakLockDeadline() has passed (scheduler is not ending the break),
 *   2. `state.break.remainingMs` has been 0 for longer than `overdueMs` (a tick loop that throws leaves
 *      the projected remaining time at 0 forever – the case the old `now > endsAt + 10 s` net could not see).
 *
 * Pure: the caller keeps `zeroSince` (the returned value replaces it) and acts on `overdue`.
 * @param {{ state: object|null, now: number, deadline?: number|null, zeroSince?: number|null, overdueMs?: number }} input
 *   now / deadline / zeroSince are readings of the same monotonic clock.
 * @returns {{ overdue: boolean, reason: string|null, zeroSince: number|null }}
 */
function evaluateBreakOverdue({ state, now, deadline = null, zeroSince = null, overdueMs = OVERDUE_BREAK_MS } = {}) {
  const idle = { overdue: false, reason: null, zeroSince: null };
  if (!state || typeof state !== 'object' || state.phase !== 'break') return idle;
  if (!finite(now)) return { overdue: false, reason: null, zeroSince: finite(zeroSince) ? zeroSince : null };
  const grace = finite(overdueMs) && overdueMs >= 0 ? overdueMs : OVERDUE_BREAK_MS;
  const brk = state.break && typeof state.break === 'object' ? state.break : {};

  const remaining = finite(brk.remainingMs) ? brk.remainingMs : null;
  const stalled = remaining !== null && remaining <= 0;
  const nextZeroSince = stalled ? (finite(zeroSince) ? zeroSince : now) : null;

  if (finite(deadline) && now > deadline) {
    const late = Math.round((now - deadline) / 1000);
    return { overdue: true, reason: `break deadline exceeded by ${late} s`, zeroSince: nextZeroSince };
  }
  if (stalled && finite(nextZeroSince) && now - nextZeroSince > grace) {
    const stuck = Math.round((now - nextZeroSince) / 1000);
    return { overdue: true, reason: `break stuck at 0 s remaining for ${stuck} s`, zeroSince: nextZeroSince };
  }
  return { overdue: false, reason: null, zeroSince: nextZeroSince };
}

/** Boolean shorthand of evaluateBreakOverdue() (same input). */
function isBreakOverdue(input) {
  return evaluateBreakOverdue(input).overdue === true;
}

module.exports = {
  STRICT_ALLOWED_ACTIONS,
  STRICT_ALLOWED_SETTINGS,
  STRICT_ERROR,
  OVERDUE_BREAK_MS,
  isActionAllowedDuringStrictBreak,
  filterSettingsPatchForStrictBreak,
  stripStrictModeChange,
  guardSettingsPatch,
  strictFlagForBreakStart,
  isStrictBreakState,
  hasAnyLeaf,
  breakLockDeadline,
  evaluateBreakOverdue,
  isBreakOverdue,
};
