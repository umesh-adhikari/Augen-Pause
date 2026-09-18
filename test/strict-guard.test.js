'use strict';

/**
 * Mandatory break ("Pflicht-Pause") guard – pure decision logic (docs/ARCHITECTURE.md §11).
 * The logic tested here used to live in ipc-validate.js (isStrictBreak / guardStrictModePatch).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTIONS } = require('../src/main/constants');
const g = require('../src/main/strict-guard');

const strictSettings = { breaks: { strictMode: true } };
const relaxedSettings = { breaks: { strictMode: false } };

function breakState(overrides = {}) {
  return {
    phase: 'break',
    now: 1_000_000,
    break: { type: 'short', endsAt: 1_083_000, remainingMs: 83000, canSkip: false, canSnooze: false, ...overrides },
  };
}

test('exported allowlists are frozen and minimal', () => {
  assert.deepEqual([...g.STRICT_ALLOWED_ACTIONS], ['drink', 'undo-drink']);
  assert.deepEqual([...g.STRICT_ALLOWED_SETTINGS], ['language', 'appearance']);
  assert.ok(Object.isFrozen(g.STRICT_ALLOWED_ACTIONS));
  assert.ok(Object.isFrozen(g.STRICT_ALLOWED_SETTINGS));
  assert.equal(g.STRICT_ERROR, 'strict-mode');
  for (const name of g.STRICT_ALLOWED_ACTIONS) assert.ok(ACTIONS.includes(name), `${name} is a real action`);
});

test('isActionAllowedDuringStrictBreak: only the water entries, hostile names rejected', () => {
  const allowed = ACTIONS.filter((name) => g.isActionAllowedDuringStrictBreak(name));
  assert.deepEqual(allowed, ['drink', 'undo-drink']);
  for (const name of ['skip-break', 'snooze', 'pause', 'resume', 'reset-timer', 'break-now',
    'open-dashboard', 'toggle-dashboard', 'show-widget', 'hide-widget', 'reset-widget-position', 'quit']) {
    assert.equal(g.isActionAllowedDuringStrictBreak(name), false, name);
  }
  for (const bad of ['__proto__', 'constructor', 'toString', 'includes', 'DRINK', 'drink ', '', null, undefined,
    0, 1, true, {}, [], ['drink']]) {
    assert.equal(g.isActionAllowedDuringStrictBreak(bad), false, String(bad));
  }
});

// ---- settings filter -----------------------------------------------------------------------------

test('filterSettingsPatchForStrictBreak keeps language + the whole appearance group', () => {
  const patch = { language: 'en', appearance: { theme: 'dark', accent: 'violet' } };
  const result = g.filterSettingsPatchForStrictBreak(patch);
  assert.deepEqual(result.patch, patch);
  assert.deepEqual(result.rejectedKeys, []);
  assert.notEqual(result.patch, patch, 'a fresh object is returned');
});

test('filterSettingsPatchForStrictBreak rejects everything else with dotted keys', () => {
  const patch = {
    language: 'de',
    appearance: { theme: 'light' },
    breaks: { strictMode: false, overlayOpacity: 0.2, lockScreen: false },
    timer: { workMinutes: 240 },
    widget: { position: { x: 0, y: 0 } },
    hydration: { enabled: false },
    version: 1,
  };
  const frozen = JSON.stringify(patch);
  const result = g.filterSettingsPatchForStrictBreak(patch);
  assert.deepEqual(result.patch, { language: 'de', appearance: { theme: 'light' } });
  assert.deepEqual(result.rejectedKeys.sort(), [
    'breaks.lockScreen', 'breaks.overlayOpacity', 'breaks.strictMode',
    'hydration.enabled', 'timer.workMinutes', 'version', 'widget.position',
  ]);
  assert.equal(JSON.stringify(patch), frozen, 'the input is never mutated');
});

test('filterSettingsPatchForStrictBreak: hostile patches (own __proto__, deep nesting, prototype-less)', () => {
  // an own "__proto__" data property (JSON.parse) must be reported, not applied – and never pollute Object
  const polluting = JSON.parse('{"__proto__": {"polluted": true}, "breaks": {"strictMode": false}}');
  const hostile = g.filterSettingsPatchForStrictBreak(polluting);
  assert.deepEqual(Object.keys(hostile.patch), []);
  assert.deepEqual(hostile.rejectedKeys.sort(), ['__proto__.polluted', 'breaks.strictMode']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // nested objects below an allowed key stay untouched (settingsStore sanitizes them)
  const nested = g.filterSettingsPatchForStrictBreak({ appearance: { theme: 'dark', deep: { a: { b: 1 } } } });
  assert.deepEqual(nested.patch, { appearance: { theme: 'dark', deep: { a: { b: 1 } } } });
  assert.deepEqual(nested.rejectedKeys, []);

  // prototype-less patch object
  const bare = Object.assign(Object.create(null), { language: 'en', timer: { snoozeMinutes: 30 } });
  const bareResult = g.filterSettingsPatchForStrictBreak(bare);
  assert.deepEqual(bareResult.patch, { language: 'en' });
  assert.deepEqual(bareResult.rejectedKeys, ['timer.snoozeMinutes']);

  // non-objects and exotic values never throw and never let anything through
  for (const bad of [null, undefined, 42, 'language', true, [], [{ language: 'de' }], new Date()]) {
    const r = g.filterSettingsPatchForStrictBreak(bad);
    assert.deepEqual(r.patch, {}, String(bad));
    assert.deepEqual(r.rejectedKeys, [], String(bad));
  }
  // an empty group is rejected as a whole (no leaf to report)
  assert.deepEqual(g.filterSettingsPatchForStrictBreak({ breaks: {} }).rejectedKeys, []);
  assert.deepEqual(g.filterSettingsPatchForStrictBreak({ breaks: {} }).patch, {});
});

test('stripStrictModeChange: only a real change of breaks.strictMode is removed', () => {
  const patch = { breaks: { strictMode: false, soundEnabled: false }, language: 'en' };
  const stripped = g.stripStrictModeChange(patch, true);
  assert.deepEqual(stripped.patch, { breaks: { soundEnabled: false }, language: 'en' });
  assert.deepEqual(stripped.rejectedKeys, ['breaks.strictMode']);
  assert.deepEqual(patch.breaks, { strictMode: false, soundEnabled: false }, 'input not mutated');

  // same value as the current setting → harmless, kept as-is (same reference)
  const same = { breaks: { strictMode: true } };
  assert.equal(g.stripStrictModeChange(same, true).patch, same);
  assert.deepEqual(g.stripStrictModeChange(same, true).rejectedKeys, []);
  // turning it on during a non-strict break is a change as well
  assert.deepEqual(g.stripStrictModeChange({ breaks: { strictMode: true } }, false).rejectedKeys, ['breaks.strictMode']);
  // untouched patches are passed through unchanged
  const other = { language: 'de', breaks: { soundVolume: 1 } };
  assert.equal(g.stripStrictModeChange(other, true).patch, other);
  assert.equal(g.stripStrictModeChange(null, true).patch, null);
  assert.equal(g.stripStrictModeChange({ breaks: null }, true).patch.breaks, null);
});

// ---- guardSettingsPatch (the entry point used by main.js) -----------------------------------------

test('guardSettingsPatch during a strict break: language + appearance only', () => {
  const result = g.guardSettingsPatch(
    { language: 'en', appearance: { accent: 'blue' }, breaks: { overlayOpacity: 1 }, timer: { workMinutes: 1 } },
    { strictBreak: true, inBreak: true, strictMode: true },
  );
  assert.deepEqual(result.patch, { language: 'en', appearance: { accent: 'blue' } });
  assert.deepEqual(result.errors.sort(), ['strict-break: breaks.overlayOpacity', 'strict-break: timer.workMinutes']);
  assert.equal(result.empty, false, 'something is left to apply');

  const nothingLeft = g.guardSettingsPatch({ breaks: { strictMode: false } }, { strictBreak: true, inBreak: true });
  assert.deepEqual(nothingLeft.patch, {});
  assert.deepEqual(nothingLeft.errors, ['strict-break: breaks.strictMode']);
  assert.equal(nothingLeft.empty, true, 'the store must not be called at all');

  const appearanceOnly = g.guardSettingsPatch({ appearance: { theme: 'dark' } }, { strictBreak: true, inBreak: true });
  assert.deepEqual(appearanceOnly.patch, { appearance: { theme: 'dark' } });
  assert.deepEqual(appearanceOnly.errors, []);
  assert.equal(appearanceOnly.empty, false);

  // an empty patch is not "empty" in the guard sense (nothing was rejected)
  const empty = g.guardSettingsPatch({}, { strictBreak: true, inBreak: true });
  assert.deepEqual(empty.patch, {});
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.empty, false);
});

test('guardSettingsPatch during a non-strict break: only breaks.strictMode is frozen', () => {
  const result = g.guardSettingsPatch(
    { breaks: { strictMode: true, graceSeconds: 30 }, timer: { workMinutes: 45 } },
    { strictBreak: false, inBreak: true, strictMode: false },
  );
  assert.deepEqual(result.patch, { breaks: { graceSeconds: 30 }, timer: { workMinutes: 45 } });
  assert.deepEqual(result.errors, ['break-running: breaks.strictMode']);
  assert.equal(result.empty, false);

  const only = g.guardSettingsPatch({ breaks: { strictMode: true } }, { strictBreak: false, inBreak: true, strictMode: false });
  assert.equal(only.empty, true);
  assert.deepEqual(only.errors, ['break-running: breaks.strictMode']);
});

test('guardSettingsPatch outside a break passes the patch through untouched', () => {
  const patch = { breaks: { strictMode: false }, timer: { workMinutes: 20 } };
  const result = g.guardSettingsPatch(patch, { strictBreak: false, inBreak: false, strictMode: true });
  assert.equal(result.patch, patch, 'same reference – no copying outside a break');
  assert.deepEqual(result.errors, []);
  assert.equal(result.empty, false);
  assert.equal(g.guardSettingsPatch(patch).patch, patch, 'missing context = no break');
});

test('hasAnyLeaf recognises patches that still carry a value', () => {
  assert.equal(g.hasAnyLeaf({}), false);
  assert.equal(g.hasAnyLeaf({ a: {} }), false);
  assert.equal(g.hasAnyLeaf({ a: { b: {} } }), false);
  assert.equal(g.hasAnyLeaf({ a: { b: null } }), true, 'null is a value (widget.position: null)');
  assert.equal(g.hasAnyLeaf({ a: { b: false } }), true);
  assert.equal(g.hasAnyLeaf({ a: 0 }), true);
  assert.equal(g.hasAnyLeaf({ a: [] }), true);
  assert.equal(g.hasAnyLeaf(undefined), false);
  assert.equal(g.hasAnyLeaf('x'), true);
});

// ---- the strict flag of a running break ----------------------------------------------------------

test('strictFlagForBreakStart: the break-start payload wins, a resumed break is always strict', () => {
  assert.equal(g.strictFlagForBreakStart({ type: 'short', strict: true }, relaxedSettings), true);
  assert.equal(g.strictFlagForBreakStart({ type: 'short', strict: false }, strictSettings), false);
  // §11: only strict breaks are persisted and resumed after a restart
  assert.equal(g.strictFlagForBreakStart({ type: 'short', resumed: true }, relaxedSettings), true);
  assert.equal(g.strictFlagForBreakStart({ type: 'short', strict: false, resumed: true }, strictSettings), false);
  // no hint in the payload → the current setting decides
  assert.equal(g.strictFlagForBreakStart({ type: 'long' }, strictSettings), true);
  assert.equal(g.strictFlagForBreakStart({ type: 'long' }, relaxedSettings), false);
  assert.equal(g.strictFlagForBreakStart(null, strictSettings), true);
  assert.equal(g.strictFlagForBreakStart(undefined, null), false);
  assert.equal(g.strictFlagForBreakStart({ strict: 'yes' }, strictSettings), true, 'non-boolean strict is ignored');
  assert.equal(g.strictFlagForBreakStart({}, { breaks: {} }), false);
});

test('isStrictBreakState is fail-closed while a break runs', () => {
  // the captured flag wins over the settings
  assert.equal(g.isStrictBreakState(breakState({ canSkip: true }), relaxedSettings, true), true);
  assert.equal(g.isStrictBreakState(breakState({ canSkip: true }), strictSettings, false), false);
  // the scheduler's own flag
  assert.equal(g.isStrictBreakState(breakState({ strict: true, canSkip: true }), relaxedSettings), true);
  assert.equal(g.isStrictBreakState(breakState({ strict: false, canSkip: true }), strictSettings), false);
  // canSkip:false means the break cannot be ended → treat it as mandatory (older scheduler without `strict`)
  assert.equal(g.isStrictBreakState(breakState({ canSkip: false }), relaxedSettings), true);
  // nothing captured, nothing in the state → the setting decides
  assert.equal(g.isStrictBreakState(breakState({ canSkip: true }), strictSettings), true);
  assert.equal(g.isStrictBreakState(breakState({ canSkip: true }), relaxedSettings), false);
  // a strict flag beats a "skippable" break even when both are present
  assert.equal(g.isStrictBreakState(breakState({ strict: true, canSkip: true }), relaxedSettings, null), true);

  // never strict outside a break
  for (const phase of ['work', 'paused', 'away', 'off-hours', undefined]) {
    const state = { ...breakState({ canSkip: false }), phase };
    assert.equal(g.isStrictBreakState(state, strictSettings, true), false, String(phase));
  }
  assert.equal(g.isStrictBreakState(null, strictSettings, true), false);
  assert.equal(g.isStrictBreakState(undefined, strictSettings), false);
  assert.equal(g.isStrictBreakState({ phase: 'break' }, strictSettings), true, 'no break object → settings');
  assert.equal(g.isStrictBreakState({ phase: 'break', break: null }, relaxedSettings), false);
  assert.equal(g.isStrictBreakState({ phase: 'break' }, null), false, 'no settings, nothing captured → not strict');
});

// ---------------------------------------------------------------------------------------------
// Stuck break detection (review fix H1): the escape hatch out of the lock.
// The old net (`state.now > state.break.endsAt + 10 s`) was dead code – §11 re-projects
// endsAt to `now + remainingMs` on every getState(), so it can never be in the past.

test('the old endsAt net is unreachable – a projected state never looks overdue', () => {
  // what getState() returns while tick() keeps throwing: remaining 0, endsAt = now
  const projected = { phase: 'break', now: 5_000_000, break: { endsAt: 5_000_000, remainingMs: 0, strict: true } };
  assert.equal(projected.now > projected.break.endsAt + g.OVERDUE_BREAK_MS, false);
  // the new decision does see it (after the grace period)
  const first = g.evaluateBreakOverdue({ state: projected, now: 1000, deadline: null });
  assert.equal(first.overdue, false);
  assert.equal(first.zeroSince, 1000);
  assert.equal(g.isBreakOverdue({ state: projected, now: 11_001, zeroSince: first.zeroSince }), true);
});

test('breakLockDeadline: from the break-start payload, on the monotonic clock', () => {
  const clocks = { monoNow: 50_000, wallNow: 1_700_000_000_000 };
  // a new break: endsAt = wallNow + durationMs
  assert.equal(
    g.breakLockDeadline({ type: 'short', durationMs: 20_000, endsAt: clocks.wallNow + 20_000 }, clocks),
    50_000 + 20_000 + g.OVERDUE_BREAK_MS,
  );
  // a resumed break: endsAt carries the REMAINING time, durationMs the whole break
  assert.equal(
    g.breakLockDeadline({ durationMs: 600_000, endsAt: clocks.wallNow + 90_000, resumed: true }, clocks),
    50_000 + 90_000 + g.OVERDUE_BREAK_MS,
  );
  // state.break also works (endsAt + remainingMs)
  assert.equal(g.breakLockDeadline({ remainingMs: 5000 }, clocks), 50_000 + 5000 + g.OVERDUE_BREAK_MS);
  // a custom grace
  assert.equal(g.breakLockDeadline({ durationMs: 1000 }, { ...clocks, overdueMs: 0 }), 51_000);
  // no usable duration / no clock → no deadline (the zero-remaining detector still guards the lock)
  assert.equal(g.breakLockDeadline(null, clocks), null);
  assert.equal(g.breakLockDeadline({}, clocks), null);
  assert.equal(g.breakLockDeadline({ durationMs: NaN, endsAt: Infinity }, clocks), null);
  assert.equal(g.breakLockDeadline({ durationMs: 1000 }, { monoNow: NaN, wallNow: 1 }), null);
  assert.equal(g.breakLockDeadline({ durationMs: 20_000 }, {}), null);
  // an endsAt in the past (clock moved) falls back to the full duration instead of expiring at once
  assert.equal(
    g.breakLockDeadline({ durationMs: 20_000, endsAt: clocks.wallNow - 60_000 }, clocks),
    50_000 + 20_000 + g.OVERDUE_BREAK_MS,
  );
});

test('evaluateBreakOverdue: the deadline releases a break the scheduler does not end', () => {
  const state = { phase: 'break', now: 9, break: { endsAt: 9, remainingMs: 4000, strict: true } };
  const deadline = 30_000;
  assert.equal(g.evaluateBreakOverdue({ state, now: 29_999, deadline }).overdue, false);
  assert.equal(g.evaluateBreakOverdue({ state, now: 30_000, deadline }).overdue, false, 'not before the deadline');
  const late = g.evaluateBreakOverdue({ state, now: 33_000, deadline });
  assert.equal(late.overdue, true);
  assert.match(late.reason, /deadline exceeded by 3 s/);
  // remainingMs > 0 keeps the zero tracker empty
  assert.equal(g.evaluateBreakOverdue({ state, now: 1000, deadline, zeroSince: 500 }).zeroSince, null);
});

test('evaluateBreakOverdue: remainingMs stuck at 0 releases the break after the grace period', () => {
  const stalled = { phase: 'break', now: 100, break: { endsAt: 100, remainingMs: 0, strict: true } };
  let zeroSince = null;
  let verdict = g.evaluateBreakOverdue({ state: stalled, now: 1000, zeroSince });
  assert.deepEqual(verdict, { overdue: false, reason: null, zeroSince: 1000 });
  zeroSince = verdict.zeroSince;
  // the start time is remembered, not refreshed
  verdict = g.evaluateBreakOverdue({ state: stalled, now: 8000, zeroSince });
  assert.equal(verdict.zeroSince, 1000);
  assert.equal(verdict.overdue, false, '7 s at 0 is not yet stuck');
  verdict = g.evaluateBreakOverdue({ state: stalled, now: 11_000, zeroSince });
  assert.equal(verdict.overdue, false, 'exactly 10 s is still fine');
  verdict = g.evaluateBreakOverdue({ state: stalled, now: 11_001, zeroSince });
  assert.equal(verdict.overdue, true);
  assert.match(verdict.reason, /stuck at 0 s remaining for 10 s/);
  // negative remaining counts as 0 as well
  const negative = { phase: 'break', break: { remainingMs: -5 } };
  assert.equal(g.evaluateBreakOverdue({ state: negative, now: 50_000, zeroSince: 1000 }).overdue, true);
});

test('evaluateBreakOverdue: no false positive at the regular end of a break', () => {
  // 20 s and 600 s breaks, ticking down second by second – nothing may fire before the scheduler ends them
  for (const durationMs of [20_000, 600_000]) {
    const monoStart = 12_345.6;
    const wallStart = 1_700_000_000_000;
    const deadline = g.breakLockDeadline({ durationMs, endsAt: wallStart + durationMs }, {
      monoNow: monoStart,
      wallNow: wallStart,
    });
    let zeroSince = null;
    for (let elapsed = 0; elapsed <= durationMs; elapsed += 250) {
      const remainingMs = durationMs - elapsed;
      const wallNow = wallStart + elapsed;
      const state = { phase: 'break', now: wallNow, break: { endsAt: wallNow + remainingMs, remainingMs, strict: true } };
      const verdict = g.evaluateBreakOverdue({ state, now: monoStart + elapsed, deadline, zeroSince });
      zeroSince = verdict.zeroSince;
      assert.equal(verdict.overdue, false, `${durationMs} ms break cut short after ${elapsed} ms`);
    }
    // the very last state (0 remaining) only starts the tracker – the phase changes in the same tick
    assert.equal(zeroSince, monoStart + durationMs);
    // …and after the break the tracker is dropped again
    const afterwards = g.evaluateBreakOverdue({ state: { phase: 'work' }, now: monoStart + durationMs + 60_000, deadline, zeroSince });
    assert.deepEqual(afterwards, { overdue: false, reason: null, zeroSince: null });
  }
});

test('evaluateBreakOverdue: garbage in, no release', () => {
  const deadline = 1000;
  for (const state of [null, undefined, {}, { phase: 'work' }, { phase: 'paused', break: { remainingMs: 0 } }, 'break']) {
    assert.equal(g.isBreakOverdue({ state, now: 9_000_000, deadline, zeroSince: 1 }), false, String(state));
  }
  // a broken monotonic clock must not release the break – but it must not lose the tracker either
  const stalled = { phase: 'break', break: { remainingMs: 0 } };
  assert.deepEqual(g.evaluateBreakOverdue({ state: stalled, now: NaN, deadline, zeroSince: 77 }), {
    overdue: false, reason: null, zeroSince: 77,
  });
  assert.equal(g.evaluateBreakOverdue({ state: stalled, now: 20_000, deadline: 'soon' }).overdue, false);
  // remainingMs missing / not a number → only the deadline can release
  const noRemaining = { phase: 'break', break: { endsAt: 5 } };
  assert.equal(g.evaluateBreakOverdue({ state: noRemaining, now: 999_999, zeroSince: 1 }).overdue, false);
  assert.equal(g.evaluateBreakOverdue({ state: noRemaining, now: 999_999, deadline: 2000 }).overdue, true);
  assert.equal(g.evaluateBreakOverdue().overdue, false);
  assert.equal(g.isBreakOverdue(), false);
});
