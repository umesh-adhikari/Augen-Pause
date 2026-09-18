'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler, isWithinWorkingHours, pauseUntilTomorrow, MEETING_MAX_DEFER_MS } = require('../src/main/scheduler');
const { DEFAULT_SETTINGS } = require('../src/main/settings');
const { createStatsStore } = require('../src/main/stats');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Wednesday 2026-09-16 10:00 local time. */
const BASE = new Date(2026, 8, 16, 10, 0, 0).getTime();
const EVENTS = [
  'warning', 'break-start', 'break-end', 'hydration-reminder', 'natural-break', 'meeting-deferred', 'meeting-defer-expired',
];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function createFakeStats() {
  const today = {
    breaksCompleted: 0,
    breaksSkipped: 0,
    breaksSnoozed: 0,
    shortBreaks: 0,
    longBreaks: 0,
    naturalBreaks: 0,
    breakSeconds: 0,
    workSeconds: 0,
    glasses: 0,
  };
  const calls = [];
  return {
    today,
    calls,
    callsOf(name) {
      return calls.filter((c) => c[0] === name).map((c) => c[1]);
    },
    recordBreak(o) {
      calls.push(['recordBreak', o]);
      if (o.completed) {
        today.breaksCompleted += 1;
        if (o.type === 'long') today.longBreaks += 1;
        else today.shortBreaks += 1;
      } else if (o.skipped !== false) {
        today.breaksSkipped += 1;
      }
      today.breakSeconds += o.seconds;
    },
    recordSnooze() {
      calls.push(['recordSnooze']);
      today.breaksSnoozed += 1;
    },
    recordNaturalBreak() {
      calls.push(['recordNaturalBreak']);
      today.naturalBreaks += 1;
    },
    addWorkSeconds(s) {
      today.workSeconds += s;
    },
    addGlass() {
      today.glasses += 1;
      return { ...today };
    },
    removeGlass() {
      today.glasses = Math.max(0, today.glasses - 1);
      return { ...today };
    },
    getToday() {
      return { date: '2026-09-16', ...today };
    },
  };
}

function setup({ settings, start = BASE, stats } = {}) {
  /** t = wall clock, mono = monotonic clock (advances with real time passing, never backwards). */
  const clock = { t: start, mono: 1000 };
  let current = deepMerge(clone(DEFAULT_SETTINGS), settings);
  const idle = { since: null };
  const fakeStats = stats || createFakeStats();
  const s = new Scheduler({
    getSettings: () => clone(current),
    stats: fakeStats,
    now: () => clock.t,
    monotonicNow: () => clock.mono,
    getIdleSeconds: () => (idle.since === null ? 0 : Math.max(0, (clock.t - idle.since) / 1000)),
  });
  const events = [];
  for (const name of EVENTS) s.on(name, (payload) => events.push({ name, payload, at: clock.t - start }));
  return {
    s,
    clock,
    idle,
    stats: fakeStats,
    events,
    /** Advance the fake clock in `step` increments, ticking after each step. */
    advance(ms, step = SEC) {
      const end = clock.t + ms;
      while (clock.t < end) {
        const next = Math.min(end, clock.t + step);
        clock.mono += next - clock.t;
        clock.t = next;
        s.tick();
      }
    },
    /** Jump the clock without intermediate ticks, then tick once (negative = wall clock set back). */
    jump(ms) {
      clock.t += ms;
      clock.mono += Math.max(0, ms);
      s.tick();
    },
    state: () => s.getState(),
    of: (name) => events.filter((e) => e.name === name),
    /** Update settings like main does (store change → onSettingsChanged). */
    change(patch) {
      const prev = current;
      current = deepMerge(clone(current), patch);
      return s.onSettingsChanged(clone(current), clone(prev));
    },
  };
}

// ---------------------------------------------------------------------------

test('initial state has exactly the documented shape and is JSON-serializable', () => {
  const h = setup();
  const st = h.state();
  assert.deepEqual(Object.keys(st).sort(), [
    'away', 'break', 'cycle', 'hydration', 'meeting', 'now', 'pause', 'phase', 'snooze', 'today', 'warning', 'work',
  ]);
  assert.deepEqual(Object.keys(st.work).sort(), ['durationMs', 'endsAt', 'progress', 'remainingMs', 'startedAt']);
  assert.deepEqual(Object.keys(st.break).sort(), [
    'canSkip', 'canSnooze', 'durationMs', 'endsAt', 'graceUntil', 'inGrace', 'lockScreen', 'progress', 'remainingMs',
    'skipHoldSeconds', 'startedAt', 'strict', 'type',
  ]);
  assert.equal(st.break.strict, true, 'Pflicht-Pause is the default (§11)');
  assert.deepEqual(Object.keys(st.cycle).sort(), ['index', 'longEnabled', 'longEvery']);
  assert.deepEqual(Object.keys(st.hydration).sort(), [
    'due', 'enabled', 'glassesToday', 'goal', 'intervalMs', 'nextAt', 'progress', 'remainingMs',
  ]);
  assert.deepEqual(Object.keys(st.today).sort(), ['breaksCompleted', 'breaksSkipped', 'glasses', 'workSeconds']);
  assert.deepEqual(st.snooze, { count: 0, max: 2, options: [5, 10, 15, 30] });
  assert.deepEqual(st.meeting, { active: false, deferred: false, since: null });
  assert.deepEqual(st.pause, { until: null, reason: null });
  assert.deepEqual(st.away, { since: null });
  assert.equal(st.phase, 'work');
  assert.equal(st.now, BASE);
  assert.deepEqual(st.work, { startedAt: BASE, endsAt: BASE + 30 * MIN, durationMs: 30 * MIN, remainingMs: 30 * MIN, progress: 0 });
  assert.equal(st.break.type, 'short');
  assert.equal(st.break.durationMs, 120 * SEC);
  assert.equal(st.hydration.nextAt, BASE + 45 * MIN);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);

  // fresh object every time
  st.work.remainingMs = -1;
  st.snooze.options.push(99);
  assert.equal(h.state().work.remainingMs, 30 * MIN);
  assert.deepEqual(h.state().snooze.options, [5, 10, 15, 30]);
});

test('default flow: 30 min work → warning → 2 min short break → work', () => {
  const h = setup();
  const states = [];
  h.s.on('state', (st) => states.push(st));

  h.advance(29 * MIN - SEC);
  assert.equal(h.of('warning').length, 0);
  assert.equal(h.state().warning, false);
  h.advance(SEC);
  assert.equal(h.of('warning').length, 1);
  assert.deepEqual(h.of('warning')[0].payload, { type: 'short', inMs: 60 * SEC });
  assert.equal(h.state().warning, true);

  h.advance(60 * SEC - SEC);
  assert.equal(h.state().phase, 'work');
  h.advance(SEC);
  let st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.warning, false);
  assert.deepEqual(h.of('break-start')[0].payload, { type: 'short', durationMs: 120 * SEC, endsAt: BASE + 32 * MIN });
  assert.equal(st.break.startedAt, BASE + 30 * MIN);
  assert.equal(st.break.remainingMs, 120 * SEC);
  assert.equal(st.work.startedAt, null);

  h.advance(60 * SEC);
  assert.equal(h.state().break.progress, 0.5);
  h.advance(60 * SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.deepEqual(h.of('break-end')[0].payload, { type: 'short', completed: true, skipped: false, snoozed: false });
  assert.equal(st.cycle.index, 1);
  assert.equal(st.work.startedAt, BASE + 32 * MIN);
  assert.equal(st.work.endsAt, BASE + 62 * MIN);
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: true, seconds: 120 }]);
  // work seconds only while phase work
  assert.equal(h.stats.today.workSeconds, 30 * 60);
  assert.equal(h.of('warning').length, 1, 'warning fired exactly once');
  // 'state' emitted on every tick
  assert.equal(states.length, 32 * 60);
  assert.equal(st.today.breaksCompleted, 1);
});

test('every 4th break is long; cycle resets after the long break', () => {
  const h = setup();
  h.advance(4 * 32 * MIN + 10 * MIN, 5 * SEC);
  const starts = h.of('break-start').map((e) => e.payload.type);
  assert.deepEqual(starts, ['short', 'short', 'short', 'long']);
  assert.equal(h.of('break-start')[3].payload.durationMs, 600 * SEC);
  assert.equal(h.state().cycle.index, 0);
  assert.equal(h.state().break.type, 'short');
  assert.deepEqual(h.state().cycle, { index: 0, longEvery: 4, longEnabled: true });
});

test('long breaks disabled → only short breaks', () => {
  const h = setup({ settings: { timer: { longBreakEnabled: false, workMinutes: 10 } } });
  h.advance(6 * 12 * MIN, 5 * SEC);
  const types = h.of('break-start').map((e) => e.payload.type);
  assert.equal(types.length, 6);
  assert.ok(types.every((t) => t === 'short'));
});

test('warning: once per work period, not with warnBeforeSeconds=0, re-armed after snooze', () => {
  const h0 = setup({ settings: { timer: { warnBeforeSeconds: 0 } } });
  h0.advance(31 * MIN, 5 * SEC);
  assert.equal(h0.of('warning').length, 0);
  assert.equal(h0.of('break-start').length, 1);

  const h = setup({ settings: { timer: { warnBeforeSeconds: 120 } } });
  h.advance(28 * MIN + 30 * SEC);
  assert.equal(h.of('warning').length, 1);
  assert.equal(h.of('warning')[0].payload.inMs, 120 * SEC);
  assert.equal(h.of('warning')[0].at, 28 * MIN);
  assert.deepEqual(h.s.snooze(), { ok: true });
  assert.equal(h.state().warning, false);
  h.advance(5 * MIN);
  assert.equal(h.of('warning').length, 2, 'warns again before the snoozed break');
  assert.equal(h.of('warning')[1].at, 33 * MIN);
});

test('snooze in work: extends the period, counts, respects the limit, resets after the break', () => {
  const h = setup();
  h.advance(29 * MIN + 30 * SEC);
  assert.equal(h.state().break.canSnooze, true);
  assert.deepEqual(h.s.snooze(), { ok: true });
  let st = h.state();
  assert.equal(st.work.endsAt, BASE + 35 * MIN);
  assert.equal(st.work.durationMs, 35 * MIN);
  assert.equal(st.work.startedAt, BASE);
  assert.equal(st.snooze.count, 1);
  assert.equal(h.stats.callsOf('recordSnooze').length, 1);

  assert.deepEqual(h.s.snooze(10), { ok: true });
  st = h.state();
  assert.equal(st.work.endsAt, BASE + 45 * MIN);
  assert.equal(st.snooze.count, 2);
  assert.equal(st.break.canSnooze, false);
  assert.deepEqual(h.s.snooze(), { ok: false, error: 'snooze-limit' });
  assert.equal(h.state().work.endsAt, BASE + 45 * MIN);

  assert.deepEqual(h.s.snooze('5'), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(h.s.snooze(-3), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(h.s.snooze(NaN), { ok: false, error: 'invalid-argument' });

  h.advance(15 * MIN + 30 * SEC); // → break at 45:00
  assert.equal(h.state().phase, 'break');
  h.advance(2 * MIN);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.snooze.count, 0);
  assert.equal(st.break.canSnooze, true);
});

test('snooze minutes are clamped to 1..60 and a snooze after the end time counts from now', () => {
  const h = setup({ settings: { timer: { maxSnoozes: 10 } } });
  h.s.snooze(500);
  assert.equal(h.state().work.endsAt, BASE + 90 * MIN);
  h.s.snooze(0.2);
  assert.equal(h.state().work.endsAt, BASE + 91 * MIN);
});

test('snooze during a break ends it (not completed, not skipped) and keeps the break type', () => {
  const h = setup({ settings: { breaks: { strictMode: false, graceSeconds: 0 } } });
  assert.deepEqual(h.s.startBreak('long'), { ok: true });
  assert.equal(h.state().break.type, 'long');
  h.advance(90 * SEC);
  assert.deepEqual(h.s.snooze(), { ok: true });
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.durationMs, 5 * MIN);
  assert.equal(st.work.endsAt, BASE + 90 * SEC + 5 * MIN);
  assert.equal(st.break.type, 'long', 'next break keeps the snoozed type');
  assert.equal(st.cycle.index, 0, 'cycle does not advance');
  assert.equal(st.snooze.count, 1);
  assert.deepEqual(h.of('break-end')[0].payload, { type: 'long', completed: false, skipped: false, snoozed: true });
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'long', completed: false, seconds: 90, skipped: false }]);
  assert.equal(h.stats.today.breaksSkipped, 0);
  assert.equal(h.stats.callsOf('recordSnooze').length, 1);

  h.advance(5 * MIN);
  assert.equal(h.state().phase, 'break');
  assert.equal(h.of('break-start')[1].payload.type, 'long');
  h.advance(10 * MIN);
  assert.equal(h.state().cycle.index, 0);
  assert.equal(h.state().snooze.count, 0);
});

test('snooze limit applies during a break after the grace period', () => {
  const h = setup({ settings: { timer: { maxSnoozes: 1 }, breaks: { strictMode: false, graceSeconds: 10 } } });
  h.s.startBreak();
  h.advance(20 * SEC);
  assert.deepEqual(h.s.snooze(1), { ok: true });
  h.advance(1 * MIN);
  assert.equal(h.state().phase, 'break');
  h.advance(20 * SEC);
  assert.equal(h.state().break.canSnooze, false);
  assert.deepEqual(h.s.snooze(), { ok: false, error: 'snooze-limit' });
});

test('skip in work: counts as skipped, new work period, cycle advances', () => {
  const h = setup();
  h.advance(10 * MIN);
  assert.deepEqual(h.s.skipBreak(), { ok: true });
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, BASE + 10 * MIN);
  assert.equal(st.work.endsAt, BASE + 40 * MIN);
  assert.equal(st.cycle.index, 1);
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: false, seconds: 0 }]);
  assert.equal(st.today.breaksSkipped, 1);
  assert.equal(h.of('break-end').length, 0);
  assert.deepEqual(h.s.pause(null), { ok: true });
  assert.deepEqual(h.s.skipBreak(), { ok: false, error: 'invalid-phase' });
});

test('skipping resets the snooze count; skipping a long break keeps the next break long', () => {
  const h = setup({ settings: { timer: { longBreakEvery: 2 } } });
  h.s.snooze();
  assert.equal(h.state().snooze.count, 1);
  h.s.skipBreak();
  assert.equal(h.state().snooze.count, 0);
  assert.equal(h.state().break.type, 'long');
  h.s.skipBreak();
  assert.equal(h.state().break.type, 'long');
});

test('skip in break: ends it early, recorded as not completed with partial seconds', () => {
  const h = setup({ settings: { breaks: { strictMode: false } } });
  h.advance(30 * MIN);
  h.advance(45 * SEC);
  assert.deepEqual(h.s.skipBreak(), { ok: true });
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, BASE + 30 * MIN + 45 * SEC);
  assert.equal(st.cycle.index, 1);
  assert.deepEqual(h.of('break-end')[0].payload, { type: 'short', completed: false, skipped: true, snoozed: false });
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: false, seconds: 45, skipped: true }]);
});

test('strict mode (§11, default): no grace; every command that could end the break is rejected; allowed in work', () => {
  const h = setup({ settings: { breaks: { graceSeconds: 30 }, timer: { maxSnoozes: 5 } } });
  let st = h.state();
  assert.equal(st.break.canSkip, true);
  assert.equal(st.break.canSnooze, true);
  assert.deepEqual(h.s.snooze(), { ok: true }, 'snooze in work allowed');

  assert.deepEqual(h.s.startBreak(), { ok: true });
  const check = () => {
    assert.deepEqual(h.s.startBreak('long'), { ok: false, error: 'strict-mode' });
    assert.deepEqual(h.s.startBreak(), { ok: false, error: 'strict-mode' });
    assert.deepEqual(h.s.skipBreak(), { ok: false, error: 'strict-mode' });
    for (const arg of [undefined, 1, 10, 60]) assert.deepEqual(h.s.snooze(arg), { ok: false, error: 'strict-mode' });
    for (const arg of [null, undefined, 30, 'tomorrow']) {
      assert.deepEqual(h.s.pause(arg), { ok: false, error: 'strict-mode' }, String(arg));
    }
    assert.deepEqual(h.s.resume(), { ok: false, error: 'strict-mode' });
    assert.deepEqual(h.s.resetWorkTimer(), { ok: false, error: 'strict-mode' });
    // argument validation still comes first
    assert.deepEqual(h.s.pause('later'), { ok: false, error: 'invalid-argument' });
    assert.deepEqual(h.s.snooze('5'), { ok: false, error: 'invalid-argument' });
    assert.deepEqual(h.s.startBreak('medium'), { ok: false, error: 'invalid-argument' });
    // hydration stays available
    assert.deepEqual(h.s.drinkWater(), { ok: true });
    assert.deepEqual(h.s.undoDrink(), { ok: true });
    const s = h.state();
    assert.equal(s.phase, 'break');
    assert.equal(s.break.strict, true);
    assert.equal(s.break.inGrace, false, 'no grace period in strict mode');
    assert.equal(s.break.graceUntil, null);
    assert.equal(s.break.canSkip, false);
    assert.equal(s.break.canSnooze, false);
  };
  check(); // what used to be the grace period
  h.advance(10 * SEC);
  check();
  h.advance(60 * SEC);
  check();
  assert.equal(h.of('break-end').length, 0);
  assert.equal(h.stats.callsOf('recordSnooze').length, 1, 'only the snooze in work');

  h.advance(50 * SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.deepEqual(h.of('break-end')[0].payload, { type: 'short', completed: true, skipped: false, snoozed: false });
  assert.equal(st.break.canSkip, true);
  assert.deepEqual(h.s.skipBreak(), { ok: true }, 'skip in work allowed in strict mode');
  assert.deepEqual(h.s.pause(5), { ok: true }, 'pause outside a break allowed');
  assert.deepEqual(h.s.resume(), { ok: true });
  assert.deepEqual(h.s.resetWorkTimer(), { ok: true });
});

test('non-strict: pause and skip during grace end the break', () => {
  const h = setup({ settings: { breaks: { strictMode: false, graceSeconds: 30 } } });
  h.s.startBreak();
  assert.equal(h.state().break.inGrace, true);
  assert.equal(h.state().break.strict, false);
  assert.deepEqual(h.s.resume(), { ok: false, error: 'not-paused' });
  assert.deepEqual(h.s.resetWorkTimer(), { ok: false, error: 'in-break' });
  assert.deepEqual(h.s.startBreak(), { ok: false, error: 'already-in-break' });
  assert.deepEqual(h.s.pause(null), { ok: true });
  assert.equal(h.state().phase, 'paused');

  const h2 = setup({ settings: { breaks: { strictMode: false, graceSeconds: 30 } } });
  h2.s.startBreak();
  h2.advance(5 * SEC);
  assert.deepEqual(h2.s.skipBreak(), { ok: true });
  assert.deepEqual(h2.of('break-end')[0].payload, { type: 'short', completed: false, skipped: true, snoozed: false });
});

test('grace period (non-strict): snooze allowed beyond the limit, skip allowed, limit applies after grace', () => {
  const h = setup({ settings: { breaks: { strictMode: false }, timer: { maxSnoozes: 0 } } });
  assert.equal(h.state().break.canSnooze, false);
  assert.deepEqual(h.s.snooze(), { ok: false, error: 'snooze-limit' });

  h.s.startBreak();
  let st = h.state();
  assert.equal(st.break.inGrace, true);
  assert.equal(st.break.graceUntil, BASE + 15 * SEC);
  assert.equal(st.break.canSnooze, true);
  assert.equal(st.break.canSkip, true);

  h.advance(14 * SEC);
  st = h.state();
  assert.equal(st.break.inGrace, true);
  assert.equal(st.break.graceUntil, BASE + 15 * SEC, 'graceUntil stays stable while the break progresses');
  assert.deepEqual(h.s.snooze(10), { ok: true });
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.snooze.count, 1, 'grace snoozes still count');
  assert.equal(st.work.durationMs, 10 * MIN);
  assert.equal(st.break.inGrace, false);
  assert.equal(st.break.graceUntil, null);

  h.advance(10 * MIN);
  st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.break.canSnooze, true, 'in grace even though count >= max');
  h.advance(15 * SEC);
  st = h.state();
  assert.equal(st.break.inGrace, false);
  assert.equal(st.break.graceUntil, null);
  assert.equal(st.break.canSnooze, false);
  assert.equal(st.break.canSkip, true);
  assert.deepEqual(h.s.snooze(), { ok: false, error: 'snooze-limit' });
  assert.deepEqual(h.s.skipBreak(), { ok: true });
});

test('grace period disabled with graceSeconds=0', () => {
  const h = setup({ settings: { breaks: { strictMode: false, graceSeconds: 0 } } });
  h.s.startBreak();
  assert.equal(h.state().break.inGrace, false);
  assert.equal(h.state().break.graceUntil, null);
});

test('startBreak: explicit type, from pause/off-hours, invalid argument', () => {
  const h = setup();
  assert.deepEqual(h.s.startBreak('medium'), { ok: false, error: 'invalid-argument' });
  h.s.pause(null);
  assert.deepEqual(h.s.startBreak(), { ok: true });
  let st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.pause.until, null);
  assert.equal(h.of('break-start')[0].payload.type, 'short');
  h.advance(2 * MIN);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.cycle.index, 1);
});

test('pause for minutes: frozen, auto resume with a fresh work period', () => {
  const h = setup();
  h.advance(10 * MIN);
  assert.deepEqual(h.s.pause(15), { ok: true });
  let st = h.state();
  assert.equal(st.phase, 'paused');
  assert.deepEqual(st.pause, { until: BASE + 25 * MIN, reason: 'user' });
  assert.equal(st.work.startedAt, null);
  assert.equal(st.hydration.nextAt, null);
  assert.equal(st.hydration.remainingMs, 35 * MIN);
  const workSeconds = h.stats.today.workSeconds;

  h.advance(15 * MIN - SEC);
  assert.equal(h.state().phase, 'paused');
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, BASE + 25 * MIN);
  assert.equal(st.work.endsAt, BASE + 55 * MIN);
  assert.deepEqual(st.pause, { until: null, reason: null });
  assert.equal(h.stats.today.workSeconds, workSeconds, 'no work seconds while paused');
  assert.equal(st.hydration.nextAt, BASE + 25 * MIN + 35 * MIN, 'hydration continued with remaining time');
  assert.equal(h.of('break-start').length, 0);
});

test('pause indefinitely, resume, argument validation', () => {
  const h = setup();
  assert.deepEqual(h.s.resume(), { ok: false, error: 'not-paused' });
  assert.deepEqual(h.s.pause('later'), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(h.s.pause(0), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(h.s.pause({}), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(h.s.pause(null), { ok: true });
  h.advance(3 * 60 * MIN, MIN);
  assert.equal(h.state().phase, 'paused');
  assert.equal(h.state().pause.until, null);
  assert.deepEqual(h.s.resetWorkTimer(), { ok: false, error: 'paused' });
  assert.deepEqual(h.s.resume(), { ok: true });
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, h.clock.t);
  assert.equal(st.work.remainingMs, 30 * MIN);
});

test('pause during a break (non strict) ends the break then pauses', () => {
  const h = setup({ settings: { breaks: { strictMode: false } } });
  h.s.startBreak();
  h.advance(30 * SEC);
  assert.deepEqual(h.s.pause(60), { ok: true });
  assert.equal(h.state().phase, 'paused');
  assert.deepEqual(h.of('break-end')[0].payload, { type: 'short', completed: false, skipped: true, snoozed: false });
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: false, seconds: 30, skipped: true }]);
});

test("pause('tomorrow') until next local midnight and auto resume", () => {
  const h = setup();
  h.s.pause('tomorrow');
  const midnight = new Date(2026, 8, 17, 0, 0, 0).getTime();
  assert.equal(h.state().pause.until, midnight);
  h.jump(midnight - h.clock.t - SEC);
  assert.equal(h.state().phase, 'paused');
  h.advance(SEC);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.state().work.startedAt, midnight);
});

test("pause('tomorrow') with working hours → next working day start", () => {
  const schedule = { workingHoursEnabled: true, days: [1, 2, 3, 4, 5], start: '08:30', end: '17:00' };
  const friday = new Date(2026, 8, 18, 15, 0).getTime();
  assert.equal(pauseUntilTomorrow(friday, schedule), new Date(2026, 8, 21, 8, 30).getTime());
  const wednesdayEarly = new Date(2026, 8, 16, 6, 0).getTime();
  assert.equal(pauseUntilTomorrow(wednesdayEarly, schedule), new Date(2026, 8, 17, 8, 30).getTime());
  assert.equal(pauseUntilTomorrow(friday, { ...schedule, workingHoursEnabled: false }), new Date(2026, 8, 19).getTime());

  const h = setup({ start: friday, settings: { schedule } });
  h.s.pause('tomorrow');
  assert.equal(h.state().pause.until, new Date(2026, 8, 21, 8, 30).getTime());
  h.jump(new Date(2026, 8, 21, 8, 30).getTime() - h.clock.t);
  assert.equal(h.state().phase, 'work');
});

test('idle: long absence → natural break, fresh work period, no work seconds for idle time', () => {
  const h = setup();
  h.advance(10 * MIN);
  const workBefore = h.stats.today.workSeconds;
  assert.equal(workBefore, 600);
  h.idle.since = h.clock.t;
  h.advance(5 * MIN - SEC);
  assert.equal(h.state().phase, 'work');
  h.advance(SEC);
  let st = h.state();
  assert.equal(st.phase, 'away');
  assert.equal(st.away.since, BASE + 10 * MIN);
  assert.equal(st.work.remainingMs, 20 * MIN, 'frozen at the start of the absence');
  assert.equal(st.hydration.nextAt, null);

  h.advance(3 * MIN, 5 * SEC);
  assert.equal(h.state().phase, 'away');
  h.idle.since = null; // user is back after 8 minutes
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('natural-break').length, 1);
  assert.deepEqual(h.of('natural-break')[0].payload, { awayMs: 8 * MIN + SEC });
  assert.equal(h.stats.callsOf('recordNaturalBreak').length, 1);
  assert.equal(st.work.startedAt, h.clock.t);
  assert.equal(st.work.remainingMs, 30 * MIN);
  assert.equal(st.cycle.index, 1, 'shorter than longBreakSeconds → advances like a short break');
  assert.ok(h.stats.today.workSeconds - workBefore <= 5, 'idle time not counted as work');
});

test('idle: absence ≥ longBreakSeconds resets the cycle like a long break', () => {
  const h = setup({ settings: { timer: { longBreakEvery: 2 } } });
  h.s.skipBreak();
  assert.equal(h.state().cycle.index, 1);
  h.idle.since = h.clock.t;
  h.advance(20 * MIN, 10 * SEC);
  assert.equal(h.state().phase, 'away');
  h.idle.since = null;
  h.advance(SEC);
  assert.equal(h.state().cycle.index, 0);
  assert.equal(h.state().break.type, 'short');
});

test('idle: short absence (clamped to the work period start) resumes the remaining time', () => {
  const h = setup();
  h.advance(5 * MIN);
  h.idle.since = h.clock.t - 4 * MIN; // user has been idle for a while already
  h.s.resetWorkTimer(); // fresh period starts while the user is idle
  const periodStart = h.clock.t;
  h.advance(1 * MIN);
  let st = h.state();
  assert.equal(st.phase, 'away');
  assert.equal(st.away.since, periodStart);
  assert.equal(st.work.remainingMs, 30 * MIN);
  h.advance(1 * MIN);
  h.idle.since = null;
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('natural-break').length, 0);
  assert.equal(st.work.remainingMs, 30 * MIN);
  assert.equal(st.work.endsAt, h.clock.t + 30 * MIN);
});

test('idle detection disabled → never away', () => {
  const h = setup({ settings: { idle: { enabled: false } } });
  h.idle.since = h.clock.t;
  h.advance(20 * MIN);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.stats.today.workSeconds, 20 * 60);
});

test('lock/unlock: short absence resumes remaining time, long absence = natural break', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.s.onLock();
  let st = h.state();
  assert.equal(st.phase, 'away');
  assert.equal(st.away.since, BASE + 10 * MIN);
  const ws = h.stats.today.workSeconds;
  h.advance(2 * MIN);
  assert.equal(h.state().phase, 'away', 'lock-away is not left by low idle time');
  h.s.onUnlock();
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.remainingMs, 20 * MIN);
  assert.equal(st.work.endsAt, BASE + 32 * MIN);
  assert.equal(st.work.durationMs, 30 * MIN);
  assert.equal(st.work.startedAt, BASE + 2 * MIN);
  assert.equal(h.stats.today.workSeconds, ws, 'no work seconds while locked');
  assert.equal(h.of('natural-break').length, 0);

  h.advance(5 * MIN);
  h.s.onLock();
  h.advance(6 * MIN, 10 * SEC);
  h.s.onUnlock();
  assert.equal(h.of('natural-break').length, 1);
  assert.equal(h.state().work.remainingMs, 30 * MIN);
});

test('lock during a break does not interrupt it; lock+suspend needs both to end', () => {
  const h = setup();
  h.s.startBreak();
  h.s.onLock();
  assert.equal(h.state().phase, 'break');
  h.s.onUnlock();

  h.advance(3 * MIN);
  assert.equal(h.state().phase, 'work');
  h.advance(MIN);
  h.s.onLock();
  h.s.onSuspend();
  h.jump(2 * MIN); // sleep: tick gap while already away
  assert.equal(h.state().phase, 'away');
  h.s.onResume();
  assert.equal(h.state().phase, 'away', 'still locked');
  h.s.onUnlock();
  assert.equal(h.state().phase, 'work');
  assert.equal(h.state().work.remainingMs, 28 * MIN, 'work started at 2:00, locked at 4:00');
});

test('suspend/resume: long sleep → natural break', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.s.onSuspend();
  h.clock.t += 60 * MIN;
  h.s.onResume();
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('natural-break').length, 1);
  assert.equal(h.of('natural-break')[0].payload.awayMs, 60 * MIN);
  assert.equal(st.cycle.index, 0);
});

test('tick gap > 60 s is handled like an absence', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.jump(3 * MIN); // short gap
  let st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.remainingMs, 20 * MIN);
  assert.equal(st.work.endsAt, BASE + 33 * MIN);
  assert.equal(st.hydration.nextAt, BASE + 48 * MIN, 'hydration frozen during the gap');
  assert.equal(h.of('natural-break').length, 0);
  assert.equal(h.stats.today.workSeconds, 600);

  h.jump(30 * SEC); // below threshold → normal tick
  assert.equal(h.state().work.remainingMs, 19.5 * 60 * SEC);

  h.jump(10 * MIN); // long gap
  st = h.state();
  assert.equal(h.of('natural-break').length, 1);
  assert.equal(h.of('natural-break')[0].payload.awayMs, 10 * MIN);
  assert.equal(st.work.remainingMs, 30 * MIN);
  assert.equal(h.of('break-start').length, 0);
});

test('hydration: reminder, re-remind, drink, undo, frozen while paused', () => {
  const h = setup();
  h.advance(45 * MIN - SEC, 5 * SEC);
  assert.equal(h.of('hydration-reminder').length, 0);
  h.advance(SEC);
  let st = h.state();
  assert.equal(h.of('hydration-reminder').length, 1);
  assert.deepEqual(h.of('hydration-reminder')[0].payload, { glassesToday: 0, goal: 8 });
  assert.equal(st.hydration.due, true);
  assert.equal(st.hydration.nextAt, BASE + 90 * MIN);

  h.advance(45 * MIN, 5 * SEC);
  assert.equal(h.of('hydration-reminder').length, 2, 're-reminds while not acknowledged');

  assert.deepEqual(h.s.drinkWater(), { ok: true });
  st = h.state();
  assert.equal(st.hydration.due, false);
  assert.equal(st.hydration.nextAt, h.clock.t + 45 * MIN);
  assert.equal(st.hydration.glassesToday, 1);
  assert.equal(st.today.glasses, 1);
  assert.deepEqual(h.s.undoDrink(), { ok: true });
  assert.equal(h.state().hydration.glassesToday, 0);

  h.advance(15 * MIN, 5 * SEC);
  h.s.pause(null);
  st = h.state();
  assert.equal(st.hydration.nextAt, null);
  assert.equal(st.hydration.remainingMs, 30 * MIN);
  h.advance(2 * 60 * MIN, MIN);
  assert.equal(h.of('hydration-reminder').length, 2, 'no reminders while paused');
  assert.equal(h.state().hydration.remainingMs, 30 * MIN);
  h.s.resume();
  assert.equal(h.state().hydration.nextAt, h.clock.t + 30 * MIN);
});

test('hydration: disabled → null/0 fields; enabling starts fresh; interval change keeps start, ≥ 60 s', () => {
  const h = setup({ settings: { hydration: { enabled: false } } });
  let hy = h.state().hydration;
  assert.deepEqual(
    { enabled: hy.enabled, nextAt: hy.nextAt, intervalMs: hy.intervalMs, remainingMs: hy.remainingMs, progress: hy.progress, due: hy.due },
    { enabled: false, nextAt: null, intervalMs: 0, remainingMs: 0, progress: 0, due: false },
  );
  h.advance(60 * MIN, 10 * SEC);
  assert.equal(h.of('hydration-reminder').length, 0);

  h.change({ hydration: { enabled: true } });
  const t0 = h.clock.t;
  assert.equal(h.state().hydration.nextAt, t0 + 45 * MIN);
  h.advance(10 * MIN);
  h.change({ hydration: { intervalMinutes: 20 } });
  assert.equal(h.state().hydration.nextAt, t0 + 20 * MIN);
  h.advance(9 * MIN + 30 * SEC);
  h.change({ hydration: { intervalMinutes: 10 } });
  assert.equal(h.state().hydration.nextAt, t0 + 20 * MIN, 'not later than before, but never sooner than 60 s');
  h.advance(10 * SEC);
  h.change({ hydration: { intervalMinutes: 60 } });
  h.change({ hydration: { intervalMinutes: 10 } });
  assert.equal(h.state().hydration.nextAt, h.clock.t + 60 * SEC);
  assert.equal(h.of('hydration-reminder').length, 0);

  h.change({ hydration: { enabled: false } });
  assert.equal(h.state().hydration.nextAt, null);
  assert.equal(h.state().hydration.due, false);
});

test('off-hours: enter at end of day, leave at start, breaks finish first, pause has priority', () => {
  const schedule = { workingHoursEnabled: true, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
  const early = new Date(2026, 8, 16, 7, 0).getTime();
  const h = setup({ start: early, settings: { schedule } });
  let st = h.state();
  assert.equal(st.phase, 'off-hours');
  assert.equal(st.work.startedAt, null);
  assert.equal(st.hydration.nextAt, null);
  h.advance(60 * MIN - SEC, 30 * SEC);
  assert.equal(h.state().phase, 'off-hours');
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, new Date(2026, 8, 16, 8, 0).getTime());

  // break running at 18:00 finishes first
  h.jump(new Date(2026, 8, 16, 17, 59, 30).getTime() - h.clock.t); // (gap → natural break, irrelevant here)
  h.s.startBreak();
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'break');
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'off-hours');
  assert.equal(h.of('break-end').at(-1).payload.completed, true);

  // no breaks / hydration reminders at night
  const reminders = h.of('hydration-reminder').length;
  const breaks = h.of('break-start').length;
  h.advance(13 * 60 * MIN, 5 * MIN);
  assert.equal(h.state().phase, 'off-hours');
  h.advance(60 * MIN, 30 * SEC); // Thursday 08:00 + a bit
  assert.equal(h.state().phase, 'work');
  assert.equal(h.of('hydration-reminder').length, reminders);
  assert.equal(h.of('break-start').length, breaks);
  assert.equal(h.state().cycle.index, 0, 'cycle reset after a night off');

  // pause keeps priority until it expires
  h.jump(new Date(2026, 8, 17, 17, 30).getTime() - h.clock.t);
  h.s.pause(60);
  h.advance(45 * MIN, 30 * SEC);
  assert.equal(h.state().phase, 'paused');
  h.advance(15 * MIN, 30 * SEC);
  assert.equal(h.state().phase, 'off-hours');

  // weekend
  h.jump(new Date(2026, 8, 19, 10, 0).getTime() - h.clock.t);
  assert.equal(h.state().phase, 'off-hours');
  assert.deepEqual(h.s.resetWorkTimer(), { ok: false, error: 'off-hours' });
});

test('working hours toggled via settings are re-evaluated immediately', () => {
  const h = setup();
  h.change({ schedule: { workingHoursEnabled: true, days: [0, 6] } });
  assert.equal(h.state().phase, 'off-hours');
  h.change({ schedule: { workingHoursEnabled: false } });
  assert.equal(h.state().phase, 'work');
  assert.equal(h.state().work.startedAt, h.clock.t);
});

test('isWithinWorkingHours', () => {
  const schedule = { workingHoursEnabled: true, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 16, 8, 0).getTime(), schedule), true);
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 16, 7, 59).getTime(), schedule), false);
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 16, 17, 59).getTime(), schedule), true);
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 16, 18, 0).getTime(), schedule), false);
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 20, 12, 0).getTime(), schedule), false); // Sunday
  assert.equal(isWithinWorkingHours(new Date(2026, 8, 20, 12, 0).getTime(), { ...schedule, workingHoursEnabled: false }), true);
});

test('settings change during work never triggers a break within 60 s', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.change({ timer: { workMinutes: 45, preset: 'custom' } });
  let st = h.state();
  assert.equal(st.work.startedAt, BASE, 'elapsed time kept');
  assert.equal(st.work.endsAt, BASE + 45 * MIN);

  h.advance(15 * MIN); // 25 min elapsed
  h.change({ timer: { workMinutes: 10 } });
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.endsAt, h.clock.t + 60 * SEC);
  h.advance(59 * SEC);
  assert.equal(h.state().phase, 'work');
  // dragging the slider further does not bring the break closer
  h.change({ timer: { workMinutes: 5 } });
  h.change({ timer: { workMinutes: 1 } });
  assert.equal(h.state().work.endsAt, BASE + 26 * MIN);
  h.advance(SEC);
  assert.equal(h.state().phase, 'break');
});

test('settings change: break already close stays put, snooze extensions kept, running break unaffected', () => {
  const h = setup();
  h.advance(29 * MIN + 30 * SEC);
  h.change({ timer: { workMinutes: 20 } });
  assert.equal(h.state().work.endsAt, BASE + 30 * MIN, 'not postponed beyond the previous end');

  h.s.snooze(); // → 35 min
  h.change({ timer: { workMinutes: 40 } });
  assert.equal(h.state().work.endsAt, BASE + 45 * MIN, 'new duration + snooze extension');

  h.s.startBreak();
  const brk = h.state().break;
  h.change({ timer: { shortBreakSeconds: 600, workMinutes: 60 } });
  assert.equal(h.state().break.endsAt, brk.endsAt);
  assert.equal(h.state().break.durationMs, 120 * SEC);

  const before = h.state();
  h.change({ language: 'en', appearance: { theme: 'light' }, widget: { size: 'large' } });
  const after = h.state();
  assert.deepEqual(after.break, before.break);
  assert.deepEqual(after.work, before.work);
});

test('settings change while away adjusts the frozen remaining time', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.s.onLock();
  h.change({ timer: { workMinutes: 60 } });
  assert.equal(h.state().work.remainingMs, 50 * MIN);
  h.change({ timer: { workMinutes: 5 } });
  assert.equal(h.state().work.remainingMs, 60 * SEC);
  h.s.onUnlock();
  assert.equal(h.state().work.endsAt, h.clock.t + 60 * SEC);
});

test('meeting: due break is deferred, no warning during meeting, released after meeting ends', () => {
  const h = setup();
  h.advance(20 * MIN);
  assert.deepEqual(h.s.setMeetingActive(true), { ok: true });
  let st = h.state();
  assert.deepEqual(st.meeting, { active: true, deferred: false, since: BASE + 20 * MIN });

  h.advance(10 * MIN - SEC);
  assert.equal(h.of('warning').length, 0, 'no warning while in a meeting');
  assert.equal(h.state().warning, false);
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.remainingMs, 0);
  assert.equal(st.warning, false);
  assert.equal(st.meeting.deferred, true);
  assert.equal(h.of('break-start').length, 0);
  assert.equal(h.of('meeting-deferred').length, 1);
  assert.deepEqual(h.of('meeting-deferred')[0].payload, { type: 'short' });

  h.advance(20 * MIN, 5 * SEC);
  assert.equal(h.of('meeting-deferred').length, 1, 'emitted once per deferral');
  assert.equal(h.of('break-start').length, 0);
  assert.equal(h.state().work.remainingMs, 0);

  h.s.setMeetingActive(false);
  st = h.state();
  assert.deepEqual(st.meeting, { active: false, deferred: false, since: null });
  assert.equal(st.work.endsAt, h.clock.t + 60 * SEC);
  assert.equal(st.work.remainingMs, 60 * SEC);
  assert.equal(h.of('warning').length, 1, 'warning fires again normally');
  assert.equal(st.warning, true);
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'break');
});

test('meeting: release uses warnBeforeSeconds when longer than 60 s; snooze clears deferral', () => {
  const h = setup({ settings: { timer: { warnBeforeSeconds: 180 } } });
  h.s.setMeetingActive(true);
  h.advance(30 * MIN, 5 * SEC);
  assert.equal(h.state().meeting.deferred, true);
  h.s.setMeetingActive(false);
  assert.equal(h.state().work.remainingMs, 180 * SEC);

  const h2 = setup();
  h2.s.setMeetingActive(true);
  h2.advance(30 * MIN, 5 * SEC);
  assert.equal(h2.state().meeting.deferred, true);
  assert.deepEqual(h2.s.snooze(10), { ok: true });
  assert.equal(h2.state().meeting.deferred, false);
  assert.equal(h2.state().work.remainingMs, 10 * MIN);
});

test('meeting starting during a non-strict break ends it (not skipped, no snooze count) and defers it', () => {
  const h = setup({ settings: { breaks: { strictMode: false } } });
  h.advance(30 * MIN);
  h.advance(40 * SEC);
  assert.equal(h.state().phase, 'break');
  h.s.setMeetingActive(true);
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.remainingMs, 0);
  assert.equal(st.meeting.deferred, true);
  assert.equal(st.snooze.count, 0);
  assert.equal(st.cycle.index, 0);
  assert.equal(st.break.type, 'short');
  assert.deepEqual(h.of('break-end')[0].payload, {
    type: 'short', completed: false, skipped: false, snoozed: true, reason: 'meeting',
  });
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: false, seconds: 40, skipped: false }]);
  assert.equal(h.stats.today.breaksSkipped, 0);
  assert.equal(h.of('meeting-deferred').length, 1);

  h.advance(5 * MIN, 5 * SEC);
  assert.equal(h.of('break-start').length, 1);
  h.s.setMeetingActive(false);
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'break');
  assert.equal(h.of('break-start').length, 2);
});

test('meeting: manual break during a meeting is allowed; idle does not cause away during a meeting', () => {
  const h = setup();
  h.s.setMeetingActive(true);
  h.idle.since = h.clock.t;
  h.advance(10 * MIN);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.stats.today.workSeconds, 600);
  assert.deepEqual(h.s.startBreak(), { ok: true });
  h.advance(30 * SEC);
  assert.equal(h.state().phase, 'break', 'meeting that was already active does not end a manual break');
});

test('meeting: ignored when autoDetect is off; turning it off releases a deferral', () => {
  const h = setup({ settings: { meeting: { autoDetect: false } } });
  assert.deepEqual(h.s.setMeetingActive(true), { ok: true });
  assert.equal(h.state().meeting.active, false);
  h.advance(30 * MIN, 5 * SEC);
  assert.equal(h.state().phase, 'break');
  assert.deepEqual(h.s.setMeetingActive('yes'), { ok: false, error: 'invalid-argument' });

  const h2 = setup();
  h2.s.setMeetingActive(true);
  h2.advance(30 * MIN, 5 * SEC);
  assert.equal(h2.state().meeting.deferred, true);
  h2.change({ meeting: { autoDetect: false } });
  const st = h2.state();
  assert.equal(st.meeting.active, false);
  assert.equal(st.meeting.deferred, false);
  assert.equal(st.work.remainingMs, 60 * SEC);
});

test('meeting: max deferral 2 h → signal ignored until it reports false; break follows the warning path', () => {
  assert.equal(MEETING_MAX_DEFER_MS, 2 * HOUR);
  const h = setup({ settings: { breaks: { strictMode: false } } });
  h.s.setMeetingActive(true);
  h.advance(30 * MIN, 5 * SEC);
  assert.equal(h.state().meeting.deferred, true);
  assert.equal(h.of('meeting-deferred').length, 1);
  const deferredAt = h.clock.t;

  h.advance(2 * HOUR - SEC, 10 * SEC);
  let st = h.state();
  assert.equal(st.meeting.deferred, true, 'still deferred just before 2 h');
  assert.equal(h.of('meeting-defer-expired').length, 0);
  assert.equal(h.of('warning').length, 0);

  h.advance(SEC);
  const expiredAt = h.clock.t;
  assert.equal(expiredAt - deferredAt, 2 * HOUR);
  assert.equal(h.of('meeting-defer-expired').length, 1);
  assert.deepEqual(h.of('meeting-defer-expired')[0].payload, { type: 'short', deferredMs: 2 * HOUR });
  st = h.state();
  assert.deepEqual(st.meeting, { active: true, deferred: false, since: BASE }, 'raw signal still reported');
  assert.equal(st.phase, 'work');
  assert.equal(st.work.endsAt, expiredAt + 60 * SEC);
  assert.equal(st.work.remainingMs, 60 * SEC);
  assert.equal(st.warning, true, 'normal warning path despite the meeting signal');
  assert.equal(h.of('warning').length, 1);
  const names = h.events.map((e) => e.name);
  assert.ok(names.indexOf('meeting-defer-expired') < names.indexOf('warning'));

  h.advance(60 * SEC - SEC);
  assert.equal(h.state().phase, 'work');
  h.advance(SEC);
  assert.equal(h.state().phase, 'break', 'break starts although the meeting signal is still true');
  h.advance(2 * MIN, 5 * SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.deepEqual(h.of('break-end').at(-1).payload, { type: 'short', completed: true, skipped: false, snoozed: false });

  // next work period: no new deferral while ignored
  h.advance(30 * MIN, 5 * SEC);
  st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.meeting.active, true);
  assert.equal(st.meeting.deferred, false);
  assert.equal(h.of('meeting-deferred').length, 1);
  assert.equal(h.of('warning').length, 2);
  assert.equal(h.of('meeting-defer-expired').length, 1, 'emitted once');

  // the signal reports false once → honoured again: a new meeting ends the running break
  h.s.setMeetingActive(false);
  st = h.state();
  assert.equal(st.phase, 'break');
  assert.deepEqual(st.meeting, { active: false, deferred: false, since: null });
  h.advance(10 * SEC);
  h.s.setMeetingActive(true);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.meeting.deferred, true);
  assert.equal(h.of('break-end').at(-1).payload.reason, 'meeting');
  assert.equal(h.of('meeting-deferred').length, 2);
});

test('meeting: max deferral uses warnBeforeSeconds and counts from a break ended by a meeting', () => {
  const h = setup({ settings: { timer: { warnBeforeSeconds: 180 }, breaks: { strictMode: false } } });
  h.advance(30 * MIN);
  assert.equal(h.state().phase, 'break');
  h.advance(20 * SEC);
  h.s.setMeetingActive(true); // ends the break → deferred from now
  const deferredAt = h.clock.t;
  assert.equal(h.state().meeting.deferred, true);

  h.advance(2 * HOUR - SEC, 30 * SEC);
  assert.equal(h.state().meeting.deferred, true);
  assert.equal(h.of('meeting-defer-expired').length, 0);
  h.advance(SEC);
  const st = h.state();
  assert.equal(h.clock.t - deferredAt, 2 * HOUR);
  assert.deepEqual(h.of('meeting-defer-expired').map((e) => e.payload), [{ type: 'short', deferredMs: 2 * HOUR }]);
  assert.equal(st.work.remainingMs, 180 * SEC);
  assert.equal(st.work.endsAt, h.clock.t + 180 * SEC);
  assert.equal(h.of('warning').length, 2, '1st before the original break, 2nd after the expiry');
  h.advance(180 * SEC, 5 * SEC);
  assert.equal(h.state().phase, 'break');
  assert.equal(h.of('break-start').at(-1).payload.type, 'short');
});

test('meeting: a snooze during a deferral restarts the 2 h clock; clock set back keeps it', () => {
  const h = setup({ settings: { timer: { maxSnoozes: 5 } } });
  h.s.setMeetingActive(true);
  h.advance(30 * MIN, 10 * SEC);
  assert.equal(h.state().meeting.deferred, true);
  h.advance(HOUR, 10 * SEC);
  assert.deepEqual(h.s.snooze(5), { ok: true });
  assert.equal(h.state().meeting.deferred, false);
  h.advance(5 * MIN, 10 * SEC); // deferred again (new deferral)
  assert.equal(h.state().meeting.deferred, true);
  h.jump(-10 * MIN); // wall clock set back
  h.advance(2 * HOUR - SEC, 10 * SEC);
  assert.equal(h.of('meeting-defer-expired').length, 0);
  h.advance(SEC);
  assert.equal(h.of('meeting-defer-expired').length, 1);
  assert.equal(h.of('meeting-defer-expired')[0].payload.deferredMs, 2 * HOUR);
});

test('meeting: idle during the meeting is not absence – neither after the meeting ends nor after a max deferral', () => {
  const h = setup();
  h.s.setMeetingActive(true);
  h.idle.since = h.clock.t; // no input during the whole meeting (camera/mic ⇒ present)
  h.advance(30 * MIN, 10 * SEC);
  assert.equal(h.state().meeting.deferred, true);
  h.advance(2 * HOUR, 10 * SEC);
  let st = h.state();
  const expiredAt = h.clock.t;
  assert.equal(h.of('meeting-defer-expired').length, 1);
  // the (possibly stuck) signal no longer suppresses idle detection – but the absence starts now, not 2.5 h ago
  assert.equal(st.phase, 'away');
  assert.equal(st.away.since, expiredAt);
  assert.equal(st.work.remainingMs, 60 * SEC);
  h.advance(20 * SEC);
  h.idle.since = null; // user touches the mouse
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('natural-break').length, 0, 'short absence → no natural break');
  assert.equal(st.work.remainingMs, 60 * SEC);

  // regular meeting end after a long idle meeting
  const h2 = setup();
  h2.s.setMeetingActive(true);
  h2.advance(10 * MIN);
  h2.idle.since = h2.clock.t;
  h2.advance(15 * MIN, 5 * SEC);
  assert.equal(h2.state().phase, 'work');
  h2.s.setMeetingActive(false);
  let st2 = h2.state();
  assert.equal(st2.phase, 'away');
  assert.equal(st2.away.since, h2.clock.t);
  assert.equal(st2.work.remainingMs, 5 * MIN);
  h2.idle.since = null;
  h2.advance(SEC);
  st2 = h2.state();
  assert.equal(st2.phase, 'work');
  assert.equal(h2.of('natural-break').length, 0);
});

test('settings cache: in-place changes of the settings object are picked up; cached config is not exposed', () => {
  const settings = clone(DEFAULT_SETTINGS);
  const clock = { t: BASE };
  const s = new Scheduler({ getSettings: () => settings, now: () => clock.t });
  assert.equal(s.getState().break.skipHoldSeconds, 3);
  settings.breaks.skipHoldSeconds = 7; // same object identity, different content
  assert.equal(s.getState().break.skipHoldSeconds, 7);
  settings.breaks.skipHoldSeconds = 999; // still sanitized
  assert.equal(s.getState().break.skipHoldSeconds, 10);
  settings.breaks.strictMode = false;
  settings.breaks.graceSeconds = 7;
  s.startBreak();
  assert.equal(s.getState().break.graceUntil, BASE + 7 * SEC);
  assert.equal(s.getState().break.strict, false);
  const st = s.getState();
  st.snooze.options.push(1);
  st.cycle.longEvery = 99;
  assert.equal(s.getState().cycle.longEvery, 4);
});

test('commands emit state; listener errors do not break the scheduler', () => {
  const h = setup();
  let count = 0;
  h.s.on('state', () => {
    count += 1;
  });
  const origError = console.error;
  console.error = () => {};
  try {
    h.s.on('break-start', () => {
      throw new Error('listener failure');
    });
    h.s.startBreak();
    h.s.tick();
  } finally {
    console.error = origError;
  }
  assert.equal(count, 2);
  assert.equal(h.state().phase, 'break');
});

test('listeners may call back into the scheduler and see consistent state', () => {
  const h = setup({ settings: { breaks: { strictMode: false } } });
  const seen = [];
  h.s.on('break-start', () => {
    seen.push(h.s.getState().phase);
    h.s.snooze(); // e.g. auto-snooze from a notification action
  });
  h.advance(30 * MIN);
  assert.deepEqual(seen, ['break']);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.state().snooze.count, 1);
});

test('clock set backwards keeps remaining times', () => {
  const h = setup();
  h.advance(10 * MIN);
  h.jump(-60 * MIN);
  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.remainingMs, 20 * MIN);
});

test('start() ticks every second, stop() clears the interval', async () => {
  const h = setup({ start: Date.now() });
  h.clock.t = Date.now();
  let states = 0;
  h.s.on('state', () => {
    states += 1;
  });
  h.s.start();
  h.s.start(); // idempotent
  assert.equal(states, 1, 'immediate tick on start');
  await new Promise((resolve) => setTimeout(resolve, 1150));
  h.s.stop();
  const n = states;
  assert.ok(n >= 2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(states, n);
});

test('integration with the real stats store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'augenpause-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: BASE };
  const stats = createStatsStore({ filePath: path.join(dir, 'stats.json'), now: () => clock.t });
  const s = new Scheduler({ getSettings: () => clone(DEFAULT_SETTINGS), stats, now: () => clock.t });
  for (let i = 0; i < 32 * 60; i += 1) {
    clock.t += SEC;
    s.tick();
  }
  s.drinkWater();
  s.skipBreak();
  s.snooze();
  const today = stats.getToday();
  assert.equal(today.breaksCompleted, 1);
  assert.equal(today.shortBreaks, 1);
  assert.equal(today.breakSeconds, 120);
  assert.equal(today.workSeconds, 1800);
  assert.equal(today.glasses, 1);
  assert.equal(today.breaksSkipped, 1);
  assert.equal(today.breaksSnoozed, 1);
  assert.deepEqual(s.getState().today, { breaksCompleted: 1, breaksSkipped: 1, glasses: 1, workSeconds: 1800 });
  stats.flush();
});

test('constructor validates getSettings; missing stats store is tolerated', () => {
  assert.throws(() => new Scheduler({}), TypeError);
  const s = new Scheduler({ getSettings: () => clone(DEFAULT_SETTINGS), now: () => BASE });
  assert.deepEqual(s.drinkWater(), { ok: true });
  assert.equal(s.getState().today.glasses, 0);
  const broken = new Scheduler({ getSettings: () => ({ timer: { workMinutes: 'x' } }), now: () => BASE });
  assert.equal(broken.getState().work.durationMs, 30 * MIN, 'invalid settings fall back to defaults');
});
