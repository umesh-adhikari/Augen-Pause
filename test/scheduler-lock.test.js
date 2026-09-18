'use strict';

/**
 * docs/ARCHITECTURE.md §11 – mandatory break lock: strict breaks, tamper-resistant break timing,
 * break persistence and resume. (General scheduler behaviour: scheduler.test.js.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Scheduler,
  parseSavedBreak,
  BREAK_RESUME_MAX_GAP_MS,
  BREAK_SAVE_INTERVAL_MS,
  CLOCK_TOLERANCE_MS,
  MAX_SUSPEND_CREDIT_MS,
  SHUTDOWN_MARK_TTL_MS,
  MAX_SAVED_BREAK_MS,
} = require('../src/main/scheduler');
const { DEFAULT_SETTINGS } = require('../src/main/settings');

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
  const calls = [];
  const today = { breaksCompleted: 0, breaksSkipped: 0, glasses: 0, workSeconds: 0 };
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    callsOf: (name) => calls.filter((c) => c[0] === name).map((c) => c[1]),
    recordBreak: record('recordBreak'),
    recordSnooze: record('recordSnooze'),
    recordNaturalBreak: record('recordNaturalBreak'),
    addWorkSeconds(s) {
      today.workSeconds += s;
    },
    addGlass: record('addGlass'),
    removeGlass: record('removeGlass'),
    getToday: () => ({ ...today }),
  };
}

/** In-memory breakStore (JSON round trip like a file). */
function createMemoryBreakStore(initial = null) {
  const store = {
    data: initial === null ? null : clone(initial),
    saves: [],
    clears: 0,
    loads: 0,
    load() {
      store.loads += 1;
      return store.data === null ? null : clone(store.data);
    },
    save(obj) {
      store.saves.push(clone(obj));
      store.data = clone(obj);
    },
    clear() {
      store.clears += 1;
      store.data = null;
    },
  };
  return store;
}

function setup({ settings, start = BASE, mono = 5000, breakStore } = {}) {
  /** t = wall clock, mono = monotonic clock. */
  const clock = { t: start, mono };
  let current = deepMerge(clone(DEFAULT_SETTINGS), settings);
  const stats = createFakeStats();
  const s = new Scheduler({
    getSettings: () => clone(current),
    stats,
    now: () => clock.t,
    monotonicNow: () => clock.mono,
    breakStore,
  });
  const events = [];
  for (const name of EVENTS) s.on(name, (payload) => events.push({ name, payload }));
  return {
    s,
    clock,
    stats,
    events,
    /** Real time passes: both clocks advance, one tick per step. */
    advance(ms, step = SEC) {
      const end = clock.t + ms;
      while (clock.t < end) {
        const next = Math.min(end, clock.t + step);
        clock.mono += next - clock.t;
        clock.t = next;
        s.tick();
      }
    },
    /** One tick after `realMs` of real time during which the wall clock moved by `wallMs`. */
    tickWith(wallMs, realMs) {
      clock.t += wallMs;
      clock.mono += realMs;
      s.tick();
    },
    state: () => s.getState(),
    of: (name) => events.filter((e) => e.name === name),
    change(patch) {
      const prev = current;
      current = deepMerge(clone(current), patch);
      return s.onSettingsChanged(clone(current), clone(prev));
    },
    startStop() {
      s.start();
      s.stop();
    },
  };
}

function withSilentConsole(fn) {
  const orig = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return errors;
}

function assertLocked(h) {
  for (const [name, args] of [
    ['startBreak', []], ['startBreak', ['long']], ['skipBreak', []], ['snooze', []], ['snooze', [10]],
    ['pause', [null]], ['pause', [30]], ['pause', ['tomorrow']], ['resume', []], ['resetWorkTimer', []],
  ]) {
    assert.deepEqual(h.s[name](...args), { ok: false, error: 'strict-mode' }, `${name}(${args.join(',')})`);
  }
  const st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.break.strict, true);
  assert.equal(st.break.canSkip, false);
  assert.equal(st.break.canSnooze, false);
  assert.equal(st.break.inGrace, false);
  assert.equal(st.break.graceUntil, null);
}

// ---------------------------------------------------------------------------
// strict break

test('strict break: a meeting starting during the break does not end it; deferral applies after the break', () => {
  const h = setup();
  h.advance(30 * MIN);
  assert.equal(h.state().phase, 'break');
  h.advance(40 * SEC);
  assert.deepEqual(h.s.setMeetingActive(true), { ok: true });
  let st = h.state();
  assert.equal(st.phase, 'break');
  assert.deepEqual(st.meeting, { active: true, deferred: false, since: BASE + 30 * MIN + 40 * SEC });
  assert.equal(st.break.remainingMs, 80 * SEC);
  assert.equal(h.of('break-end').length, 0);
  assert.equal(h.of('meeting-deferred').length, 0);
  assertLocked(h);

  h.advance(80 * SEC - SEC);
  assert.equal(h.state().phase, 'break');
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.deepEqual(h.of('break-end').map((e) => e.payload), [{ type: 'short', completed: true, skipped: false, snoozed: false }]);
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: true, seconds: 120 }]);
  assert.equal(st.meeting.active, true);

  // the next break is deferred by the still active meeting as usual
  h.advance(30 * MIN, 5 * SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.meeting.deferred, true);
  assert.equal(h.of('meeting-deferred').length, 1);
  assert.equal(h.of('break-start').length, 1);
  h.s.setMeetingActive(false);
  assert.equal(h.state().work.remainingMs, 60 * SEC);
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'break');
});

test('strict mode is captured at break start: a settings change during the break neither relaxes nor tightens it', () => {
  const h = setup({ settings: { breaks: { graceSeconds: 30 } } });
  h.s.startBreak();
  h.advance(10 * SEC);
  h.change({ breaks: { strictMode: false } });
  assertLocked(h);
  h.s.setMeetingActive(true);
  assert.equal(h.state().phase, 'break', 'meeting does not end the (captured) strict break');
  h.s.setMeetingActive(false);
  h.advance(110 * SEC);
  let st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('break-end')[0].payload.completed, true);
  assert.equal(st.break.strict, false, 'the next break follows the new setting');

  h.s.startBreak();
  assert.equal(h.state().break.inGrace, true);
  h.change({ breaks: { strictMode: true } });
  st = h.state();
  assert.equal(st.break.strict, false);
  assert.equal(st.break.inGrace, true);
  assert.equal(st.break.canSkip, true);
  assert.deepEqual(h.s.skipBreak(), { ok: true });
});

test('non-strict break keeps meeting release, snooze and skip', () => {
  const h = setup({ settings: { breaks: { strictMode: false } } });
  h.advance(30 * MIN);
  h.advance(20 * SEC);
  h.s.setMeetingActive(true);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.state().meeting.deferred, true);
  assert.equal(h.of('break-end')[0].payload.reason, 'meeting');
  h.s.setMeetingActive(false);
  h.advance(60 * SEC);
  assert.equal(h.state().phase, 'break');
  assert.deepEqual(h.s.snooze(), { ok: true });
  h.advance(5 * MIN);
  assert.equal(h.state().phase, 'break');
  assert.deepEqual(h.s.skipBreak(), { ok: true });
  assert.equal(h.state().phase, 'work');
});

// ---------------------------------------------------------------------------
// tamper-resistant timing

test('clock jump forward during a break does not end it (strict and non-strict)', () => {
  assert.equal(CLOCK_TOLERANCE_MS, 2000);
  for (const strictMode of [true, false]) {
    const h = setup({ settings: { breaks: { strictMode } } });
    h.advance(30 * MIN);
    h.advance(30 * SEC);
    h.tickWith(10 * MIN + SEC, SEC); // clock set 10 minutes ahead
    let st = h.state();
    assert.equal(st.phase, 'break', `strict=${strictMode}`);
    assert.equal(st.break.remainingMs, 89 * SEC);
    assert.equal(st.break.endsAt, h.clock.t + 89 * SEC, 'endsAt follows the new wall clock');
    assert.equal(st.break.progress, 0.2583);
    assert.equal(h.of('break-end').length, 0);

    h.advance(88 * SEC);
    assert.equal(h.state().phase, 'break');
    h.advance(SEC);
    st = h.state();
    assert.equal(st.phase, 'work');
    assert.equal(h.of('break-end')[0].payload.completed, true);
    assert.equal(st.work.startedAt, h.clock.t);
    assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: true, seconds: 120 }]);
  }
});

test('repeated clock nudges beyond the tolerance are ignored; small corrections are accepted', () => {
  const h = setup();
  h.s.startBreak();
  for (let i = 0; i < 60; i += 1) h.tickWith(3500, SEC);
  assert.equal(h.state().phase, 'break');
  assert.equal(h.state().break.remainingMs, 60 * SEC, '3.5 s of wall clock per real second is not trusted');
  h.tickWith(2500, 1000); // e.g. an NTP correction inside the tolerance
  assert.equal(h.state().break.remainingMs, 57500);
  h.tickWith(-SEC, SEC); // wall clock went backwards
  assert.equal(h.state().break.remainingMs, 56500, 'monotonic time is credited');
});

test('clock set back during a break: the break neither freezes nor gets longer', () => {
  const h = setup();
  h.s.startBreak();
  h.advance(30 * SEC);
  h.tickWith(-HOUR, SEC);
  let st = h.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.break.remainingMs, 89 * SEC);
  assert.equal(st.break.endsAt, h.clock.t + 89 * SEC);
  h.advance(89 * SEC - SEC);
  assert.equal(h.state().phase, 'break');
  h.advance(SEC);
  st = h.state();
  assert.equal(st.phase, 'work');
  assert.equal(h.of('break-end')[0].payload.completed, true);
});

test('getState() between ticks projects the running break with the same rule', () => {
  const h = setup();
  h.s.startBreak();
  h.advance(10 * SEC);
  h.clock.t += 400;
  h.clock.mono += 400;
  let st = h.state();
  assert.equal(st.break.remainingMs, 109600);
  assert.equal(st.break.endsAt, h.clock.t + 109600);
  h.clock.t += 10 * MIN; // wall clock jump, no tick yet
  st = h.state();
  assert.equal(st.break.remainingMs, 109600);
  assert.equal(st.phase, 'break');
});

test('a failing monotonic clock: plausible wall-clock ticks still count, jumps do not', () => {
  for (const monotonicNow of [() => { throw new Error('no clock'); }, () => NaN, 'not a function']) {
    const clock = { t: BASE };
    const s = new Scheduler({ getSettings: () => clone(DEFAULT_SETTINGS), now: () => clock.t, monotonicNow });
    s.startBreak();
    for (let i = 0; i < 30; i += 1) {
      clock.t += SEC;
      s.tick();
    }
    assert.equal(s.getState().break.remainingMs, 90 * SEC);
    clock.t += 10 * MIN;
    s.tick();
    if (typeof monotonicNow === 'function') {
      assert.equal(s.getState().break.remainingMs, 90 * SEC, 'jump not credited');
    }
    for (let i = 0; i < 95; i += 1) {
      clock.t += SEC;
      s.tick();
    }
    assert.equal(s.getState().phase, 'work');
  }
});

test('suspend during a break: wall time until resume is credited once, capped at the remaining time', () => {
  // Linux / macOS: the monotonic clock stands still while the machine sleeps
  const h = setup();
  h.s.startBreak();
  h.advance(20 * SEC);
  assert.deepEqual(h.s.onSuspend(), { ok: true });
  assert.equal(h.state().phase, 'break');
  h.tickWith(50 * SEC, 0); // a timer fires before the resume event arrives
  assert.equal(h.state().break.remainingMs, 100 * SEC, 'not credited by the tick (clocks disagree)');
  assert.deepEqual(h.s.onResume(), { ok: true });
  assert.equal(h.state().break.remainingMs, 50 * SEC);
  h.advance(50 * SEC);
  assert.equal(h.state().phase, 'work');
  assert.equal(h.of('break-end')[0].payload.completed, true);

  // Windows: the monotonic clock keeps running – no double credit
  const h2 = setup();
  h2.s.startBreak();
  h2.advance(20 * SEC);
  h2.s.onSuspend();
  h2.tickWith(50 * SEC, 50 * SEC);
  assert.equal(h2.state().break.remainingMs, 50 * SEC);
  h2.s.onResume();
  assert.equal(h2.state().break.remainingMs, 50 * SEC);

  // long sleep → the break is over right at resume
  const h3 = setup();
  h3.s.startBreak();
  h3.advance(20 * SEC);
  h3.s.onSuspend();
  h3.clock.t += HOUR;
  h3.s.onResume();
  const st = h3.state();
  assert.equal(st.phase, 'work');
  assert.equal(st.work.startedAt, h3.clock.t);
  assert.deepEqual(h3.of('break-end').map((e) => e.payload), [{ type: 'short', completed: true, skipped: false, snoozed: false }]);
  assert.deepEqual(h3.stats.callsOf('recordBreak'), [{ type: 'short', completed: true, seconds: 120 }]);
  assert.equal(h3.of('natural-break').length, 0);

  // resume without a suspend during the break credits nothing; lock/unlock credits nothing
  const h4 = setup();
  h4.s.startBreak();
  h4.clock.t += 30 * SEC;
  h4.s.onResume();
  assert.equal(h4.state().break.remainingMs, 120 * SEC);
  h4.s.onLock();
  h4.clock.t += 30 * SEC;
  h4.s.onUnlock();
  assert.equal(h4.state().break.remainingMs, 120 * SEC);
  assert.equal(h4.state().phase, 'break');
});

// ---------------------------------------------------------------------------
// persistence

test('persistence: saved at break start, every 5 s of progress and on suspend; cleared at break end', () => {
  assert.equal(BREAK_SAVE_INTERVAL_MS, 5 * SEC);
  const store = createMemoryBreakStore();
  const h = setup({ breakStore: store });
  h.advance(10 * MIN);
  assert.equal(store.saves.length, 0, 'nothing saved during work');
  assert.equal(store.clears, 0);

  h.s.startBreak();
  const t0 = h.clock.t;
  const rec = (elapsedMs, savedAt) => ({ type: 'short', durationMs: 120000, elapsedMs, strict: true, savedAt, interrupted: null });
  assert.deepEqual(store.saves, [rec(0, t0)]);
  h.advance(4 * SEC);
  assert.equal(store.saves.length, 1);
  h.advance(SEC);
  assert.equal(store.saves.length, 2);
  assert.deepEqual(store.saves[1], rec(5000, t0 + 5 * SEC));
  h.advance(55 * SEC);
  assert.equal(store.saves.length, 13);
  assert.deepEqual(store.data, rec(60000, t0 + 60 * SEC));

  h.clock.t += 500;
  h.clock.mono += 500;
  h.s.onSuspend();
  assert.equal(store.saves.length, 14);
  assert.deepEqual(store.data, rec(60500, t0 + 60500));
  h.s.onResume();

  h.advance(59500);
  assert.equal(h.state().phase, 'work');
  assert.equal(store.saves.length, 25);
  assert.equal(store.saves[24].elapsedMs, 115500);
  assert.equal(store.clears, 1);
  assert.equal(store.data, null);
  h.advance(5 * MIN, 5 * SEC);
  assert.equal(store.saves.length, 25, 'no saves during work');

  // non-strict breaks are saved too (strict: false) and cleared however they end
  const store2 = createMemoryBreakStore();
  const h2 = setup({ breakStore: store2, settings: { breaks: { strictMode: false } } });
  h2.s.startBreak();
  assert.equal(store2.data.strict, false);
  h2.s.skipBreak();
  assert.deepEqual([store2.clears, store2.data], [1, null]);
  h2.s.startBreak();
  h2.s.snooze();
  assert.deepEqual([store2.clears, store2.data], [2, null]);
  h2.s.startBreak();
  h2.s.pause(null);
  assert.deepEqual([store2.clears, store2.data], [3, null]);
  h2.s.startBreak();
  h2.s.setMeetingActive(true);
  assert.deepEqual([store2.clears, store2.data], [4, null]);
  assert.equal(store2.saves.length, 4);
});

test('onSystemShutdown() marks a running break as interrupted by the system', () => {
  const store = createMemoryBreakStore();
  const h = setup({ breakStore: store });
  assert.deepEqual(h.s.onSystemShutdown(), { ok: true });
  assert.equal(store.saves.length, 0, 'no break → nothing saved');

  h.s.startBreak();
  h.advance(12 * SEC);
  assert.equal(store.saves.length, 3);
  assert.deepEqual(h.s.onSystemShutdown(), { ok: true });
  assert.deepEqual(store.data, {
    type: 'short', durationMs: 120000, elapsedMs: 12000, strict: true, savedAt: h.clock.t, interrupted: 'system',
  });
  h.advance(5 * SEC); // still quitting
  assert.equal(store.saves.length, 5);
  assert.equal(store.data.interrupted, 'system', 'later periodic saves keep the marker');
  assert.equal(h.state().phase, 'break', 'the break itself is not affected');
});

test('breakStore failures are reported but never break the scheduler', () => {
  const throwing = {
    load() {
      throw new Error('load');
    },
    save() {
      throw new Error('save');
    },
    clear() {
      throw new Error('clear');
    },
  };
  const errors = withSilentConsole(() => {
    const h = setup({ breakStore: throwing });
    h.startStop();
    h.s.startBreak();
    h.advance(2 * MIN);
    assert.equal(h.state().phase, 'work');
    assert.equal(h.of('break-end')[0].payload.completed, true);
  });
  assert.ok(errors.length >= 3);

  for (const breakStore of [{}, 42, 'x', null, { load: 1, save: 'no', clear: {} }]) {
    const h = setup({ breakStore });
    h.startStop();
    h.s.startBreak();
    h.s.onSystemShutdown();
    h.advance(2 * MIN);
    assert.equal(h.state().phase, 'work');
  }
});

// ---------------------------------------------------------------------------
// resume

test('resume after a kill: the break continues with its remaining time (downtime not credited) and stays locked', () => {
  const store = createMemoryBreakStore();
  const h1 = setup({ breakStore: store });
  h1.advance(30 * MIN);
  h1.advance(52 * SEC); // last periodic save at 50 s, then the app is killed
  assert.equal(store.data.elapsedMs, 50000);
  const killedAt = h1.clock.t;

  // restarted 2 h later; Pflicht-Pause meanwhile switched off in the settings file – the saved break stays strict
  const h2 = setup({ breakStore: store, start: killedAt + 2 * HOUR, mono: 7, settings: { breaks: { strictMode: false } } });
  const phases = [];
  h2.s.on('state', (st) => phases.push(st.phase));
  assert.equal(h2.state().phase, 'work', 'nothing happens before start()');
  assert.equal(store.loads, 0);
  h2.startStop();
  const now = h2.clock.t;
  assert.equal(store.loads, 1);
  assert.deepEqual(h2.of('break-start').map((e) => e.payload), [
    { type: 'short', durationMs: 120000, endsAt: now + 70000, resumed: true },
  ]);
  assert.deepEqual(phases, ['break'], 'the first state already shows the resumed break');
  const st = h2.state();
  assert.equal(st.break.remainingMs, 70000);
  assert.equal(st.break.endsAt, now + 70000);
  assert.equal(st.break.startedAt, now - 50000);
  assert.equal(st.break.progress, 0.4167);
  assert.deepEqual(store.data, { type: 'short', durationMs: 120000, elapsedMs: 50000, strict: true, savedAt: now, interrupted: null });
  assertLocked(h2);
  h2.s.setMeetingActive(true);
  assert.equal(h2.state().phase, 'break');
  h2.s.setMeetingActive(false);

  h2.advance(69 * SEC);
  assert.equal(h2.state().phase, 'break');
  h2.advance(SEC);
  assert.equal(h2.state().phase, 'work');
  assert.deepEqual(h2.of('break-end').map((e) => e.payload), [{ type: 'short', completed: true, skipped: false, snoozed: false }]);
  assert.equal(store.data, null);

  // the saved break is only checked on the first start()
  store.data = { type: 'short', durationMs: 120000, elapsedMs: 0, strict: true, savedAt: h2.clock.t, interrupted: null };
  h2.startStop();
  assert.equal(store.loads, 1);
  assert.equal(h2.state().phase, 'work');

  // a break started before start() is not replaced by a restore
  const store3 = createMemoryBreakStore({ type: 'long', durationMs: 600000, elapsedMs: 0, strict: true, savedAt: BASE, interrupted: null });
  const h3 = setup({ breakStore: store3 });
  h3.s.startBreak('short');
  h3.startStop();
  assert.equal(h3.state().break.type, 'short');
  assert.equal(h3.of('break-start').length, 1);
  assert.equal(store3.data.type, 'short');
});

test('resume after a kill only within 8 h', () => {
  assert.equal(BREAK_RESUME_MAX_GAP_MS, 8 * HOUR);
  const saved = { type: 'long', durationMs: 600000, elapsedMs: 100000, strict: true, savedAt: BASE, interrupted: null };
  for (const [gap, resumed] of [[SEC, true], [8 * HOUR - SEC, true], [8 * HOUR, false], [3 * 24 * HOUR, false], [-2 * HOUR, true]]) {
    const store = createMemoryBreakStore(saved);
    const h = setup({ breakStore: store, start: BASE + gap });
    h.startStop();
    const st = h.state();
    const label = `gap ${gap}`;
    assert.equal(st.phase, resumed ? 'break' : 'work', label);
    assert.equal(h.of('break-start').length, resumed ? 1 : 0, label);
    assert.equal(h.of('natural-break').length, 0, label);
    assert.equal(h.stats.callsOf('recordNaturalBreak').length, 0, label);
    if (resumed) {
      assert.equal(st.break.type, 'long');
      assert.equal(st.break.remainingMs, 500000);
      assert.equal(store.data.savedAt, BASE + gap);
    } else {
      assert.equal(store.data, null, label);
      assert.equal(store.clears, 1, label);
      assert.equal(st.work.startedAt, BASE + gap);
    }
  }
});

test('resume after a system shutdown only within idle.resetAfterMinutes, otherwise a natural break', () => {
  // end to end: shutdown during a break, machine back 3 minutes later
  const store = createMemoryBreakStore();
  const h0 = setup({ breakStore: store });
  h0.s.startBreak();
  h0.advance(30 * SEC);
  h0.s.onSystemShutdown();
  assert.equal(store.data.interrupted, 'system');
  const h1 = setup({ breakStore: store, start: h0.clock.t + 3 * MIN, mono: 1 });
  h1.startStop();
  assert.equal(h1.state().phase, 'break');
  assert.equal(h1.state().break.remainingMs, 90 * SEC);
  assert.equal(h1.of('break-start')[0].payload.resumed, true);
  assert.equal(store.data.interrupted, null, 'the resumed break is saved as a regular one');

  const rec = { type: 'short', durationMs: 120000, elapsedMs: 30000, strict: true, savedAt: BASE, interrupted: 'system' };
  const within = setup({ breakStore: createMemoryBreakStore(rec), start: BASE + 5 * MIN - SEC });
  within.startStop();
  assert.equal(within.state().phase, 'break');

  const store2 = createMemoryBreakStore(rec);
  const h2 = setup({ breakStore: store2, start: BASE + 5 * MIN });
  h2.startStop();
  const st = h2.state();
  assert.equal(st.phase, 'work');
  assert.equal(h2.of('break-start').length, 0);
  assert.equal(store2.data, null);
  assert.equal(store2.clears, 1);
  assert.equal(h2.stats.callsOf('recordNaturalBreak').length, 1);
  assert.deepEqual(h2.of('natural-break').map((e) => e.payload), [{ awayMs: 5 * MIN }]);
  assert.equal(st.work.startedAt, BASE + 5 * MIN);
  assert.equal(st.work.remainingMs, 30 * MIN);
  assert.equal(st.cycle.index, 1, 'shorter than longBreakSeconds → advances like a short break');

  const longOff = setup({ breakStore: createMemoryBreakStore(rec), start: BASE + 10 * HOUR });
  longOff.startStop();
  assert.equal(longOff.state().phase, 'work');
  assert.equal(longOff.state().cycle.index, 0, 'long absence resets the cycle');

  const custom = setup({ breakStore: createMemoryBreakStore(rec), start: BASE + 20 * MIN, settings: { idle: { resetAfterMinutes: 30 } } });
  custom.startStop();
  assert.equal(custom.state().phase, 'break');

  // the same gap after a kill (no system marker) resumes under the 8 h rule
  const killed = setup({ breakStore: createMemoryBreakStore({ ...rec, interrupted: null }), start: BASE + 2 * HOUR });
  killed.startStop();
  assert.equal(killed.state().phase, 'break');
});

test('hostile or invalid saved records are cleared and never resumed', () => {
  const valid = { type: 'short', durationMs: 120000, elapsedMs: 1000, strict: true, savedAt: BASE, interrupted: null };
  const { interrupted: _omit, ...noInterrupted } = valid;
  const throwingGetter = { ...valid };
  Object.defineProperty(throwingGetter, 'type', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  class Saved {
    constructor() {
      Object.assign(this, valid);
    }
  }
  const bad = [
    42, 'break', true, [], [valid], {},
    { ...valid, type: 'medium' }, { ...valid, type: null },
    { ...valid, durationMs: 3600001 }, { ...valid, durationMs: 0 }, { ...valid, durationMs: -120000 },
    { ...valid, durationMs: 1200.5 }, { ...valid, durationMs: '120000' }, { ...valid, durationMs: NaN }, { ...valid, durationMs: Infinity },
    { ...valid, elapsedMs: -1 }, { ...valid, elapsedMs: 120001 }, { ...valid, elapsedMs: '1000' }, { ...valid, elapsedMs: NaN },
    { ...valid, elapsedMs: null },
    { ...valid, strict: 'true' }, { ...valid, strict: 1 },
    { ...valid, savedAt: '2026-09-16' }, { ...valid, savedAt: 0 }, { ...valid, savedAt: -5 }, { ...valid, savedAt: 1e300 },
    { ...valid, savedAt: NaN },
    { ...valid, interrupted: 'user' }, { ...valid, interrupted: false }, noInterrupted,
    Object.create(valid), new Saved(), throwingGetter,
    new Proxy({ ...valid }, { getPrototypeOf() { throw new Error('trap'); } }),
    JSON.parse('{"__proto__": {"type": "short"}, "durationMs": 120000, "elapsedMs": 0, "strict": true, "savedAt": 1, "interrupted": null}'),
    { ...valid, strict: false }, // non-strict breaks are not resumed
    { ...valid, elapsedMs: 120000 }, // already over
  ];
  for (const [i, raw] of bad.entries()) {
    let clears = 0;
    const saves = [];
    const store = { load: () => raw, save: (o) => saves.push(o), clear: () => { clears += 1; } };
    const h = setup({ breakStore: store });
    assert.doesNotThrow(() => h.startStop(), `#${i}`);
    assert.equal(h.state().phase, 'work', `#${i}`);
    assert.equal(h.of('break-start').length, 0, `#${i}`);
    assert.equal(clears, 1, `#${i} cleared`);
    assert.equal(saves.length, 0, `#${i}`);
  }

  // nothing saved / unreadable → nothing to clear
  for (const load of [() => null, () => undefined, () => { throw new Error('io'); }]) {
    let clears = 0;
    const h = setup({ breakStore: { load, save() {}, clear: () => { clears += 1; } } });
    withSilentConsole(() => h.startStop());
    assert.equal(h.state().phase, 'work');
    assert.equal(clears, 0);
  }

  // a record with extra keys and a null prototype is fine
  const extra = Object.assign(Object.create(null), valid, { note: 'x' });
  const h = setup({ breakStore: { load: () => extra, save() {}, clear() {} } });
  h.startStop();
  assert.equal(h.state().phase, 'break');
});

test('parseSavedBreak normalizes a valid record and rejects everything else', () => {
  const valid = { type: 'long', durationMs: 3600000, elapsedMs: 1234.9, strict: false, savedAt: BASE, interrupted: 'system', x: 1 };
  assert.deepEqual(parseSavedBreak(valid), {
    type: 'long', durationMs: 3600000, elapsedMs: 1234, strict: false, savedAt: BASE, interrupted: 'system',
  });
  assert.deepEqual(parseSavedBreak({ ...valid, elapsedMs: 3600000 }).elapsedMs, 3600000);
  for (const v of [null, undefined, 0, '', [], { ...valid, durationMs: 3600001 }]) assert.equal(parseSavedBreak(v), null);
});

// ---------------------------------------------------------------------------
// review fix M4: the suspend credit is capped (a wall-clock jump must not book a break)

test('suspend credit is capped: a 5 h wall-clock jump ends the break as PARTIAL, not as completed', () => {
  assert.equal(MAX_SUSPEND_CREDIT_MS, 2 * HOUR);
  assert.ok(MAX_SUSPEND_CREDIT_MS > MAX_SAVED_BREAK_MS, 'a break never needs more than its remaining time');
  const store = createMemoryBreakStore();
  const h = setup({ breakStore: store, settings: { timer: { shortBreakSeconds: 600 } } });
  h.s.startBreak();
  h.advance(3 * SEC);
  assert.deepEqual(h.s.onSuspend(), { ok: true });
  h.clock.t += 5 * HOUR; // RTC set while asleep / dual boot – the monotonic clock stood still
  assert.deepEqual(h.s.onResume(), { ok: true });

  const st = h.state();
  assert.equal(st.phase, 'work');
  assert.deepEqual(h.of('break-end').map((e) => e.payload), [
    { type: 'short', completed: false, skipped: false, snoozed: false, reason: 'clock-jump' },
  ]);
  assert.deepEqual(
    h.stats.callsOf('recordBreak'),
    [{ type: 'short', completed: false, seconds: 3, skipped: false }],
    'only the 3 seconds really taken – not booked as completed and not as skipped',
  );
  assert.equal(h.of('natural-break').length, 0);
  assert.equal(st.work.startedAt, h.clock.t, 'a fresh work period follows');
  assert.equal(st.cycle.index, 1);
  assert.deepEqual([store.data, store.clears], [null, 1], 'the saved record is cleared');
});

test('suspend credit boundary: exactly MAX_SUSPEND_CREDIT_MS completes the break, one ms more does not', () => {
  for (const [sleepMs, completed] of [[MAX_SUSPEND_CREDIT_MS, true], [MAX_SUSPEND_CREDIT_MS + 1, false]]) {
    const h = setup({ settings: { timer: { shortBreakSeconds: 600 } } });
    h.s.startBreak();
    h.advance(3 * SEC);
    h.s.onSuspend();
    h.clock.t += sleepMs;
    h.s.onResume();
    const label = `sleep ${sleepMs}`;
    assert.equal(h.state().phase, 'work', label);
    assert.equal(h.of('break-end')[0].payload.completed, completed, label);
    assert.deepEqual(
      h.stats.callsOf('recordBreak'),
      [completed
        ? { type: 'short', completed: true, seconds: 600 }
        : { type: 'short', completed: false, seconds: 3, skipped: false }],
      label,
    );
  }
});

test('a plausible sleep is credited exactly as before (10 min completes the break, 200 s continues it)', () => {
  const h = setup({ settings: { timer: { shortBreakSeconds: 600 } } });
  h.s.startBreak();
  h.advance(3 * SEC);
  h.s.onSuspend();
  h.clock.t += 10 * MIN;
  h.s.onResume();
  assert.equal(h.state().phase, 'work');
  assert.deepEqual(h.of('break-end').map((e) => e.payload), [{ type: 'short', completed: true, skipped: false, snoozed: false }]);
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: true, seconds: 600 }]);

  // a sleep shorter than the remaining time is credited to the millisecond and the break runs on
  const h2 = setup({ settings: { timer: { shortBreakSeconds: 600 } } });
  h2.s.startBreak();
  h2.advance(3 * SEC);
  h2.s.onSuspend();
  h2.clock.t += 200 * SEC;
  h2.s.onResume();
  const st = h2.state();
  assert.equal(st.phase, 'break');
  assert.equal(st.break.remainingMs, 397 * SEC);
  assert.equal(st.break.endsAt, h2.clock.t + 397 * SEC);
  assert.equal(h2.of('break-end').length, 0);
  assertLocked(h2);
  h2.advance(397 * SEC);
  assert.equal(h2.state().phase, 'work');
  assert.equal(h2.of('break-end')[0].payload.completed, true);
});

// ---------------------------------------------------------------------------
// review fix L4: `interrupted` is not sticky and a bare SIGTERM is not a session end

test('onSystemShutdown(false) saves without the system marker, so the 8 h kill window applies', () => {
  const store = createMemoryBreakStore();
  const h = setup({ breakStore: store });
  h.s.startBreak();
  h.advance(30 * SEC);
  assert.deepEqual(h.s.onSystemShutdown(false), { ok: true });
  assert.deepEqual(store.data, {
    type: 'short', durationMs: 120000, elapsedMs: 30000, strict: true, savedAt: h.clock.t, interrupted: null,
  });
  h.advance(5 * SEC);
  assert.equal(store.data.interrupted, null, 'later periodic saves keep it unmarked');

  const back = setup({ breakStore: store, start: h.clock.t + 2 * HOUR, mono: 11 });
  back.startStop();
  assert.equal(back.state().phase, 'break', 'a SIGTERM 2 h ago must not eat the mandatory break');
  assert.equal(back.state().break.remainingMs, 85 * SEC);
  assert.equal(back.of('natural-break').length, 0);

  // no argument / true / anything but false = a real session end -> 'system' (idle.resetAfterMinutes)
  for (const args of [[], [true], ['session end']]) {
    const s2 = createMemoryBreakStore();
    const g = setup({ breakStore: s2 });
    g.s.startBreak();
    g.advance(30 * SEC);
    assert.deepEqual(g.s.onSystemShutdown(...args), { ok: true });
    assert.equal(s2.data.interrupted, 'system', JSON.stringify(args));
    const late = setup({ breakStore: s2, start: g.clock.t + 2 * HOUR, mono: 13 });
    late.startStop();
    assert.equal(late.state().phase, 'work', 'a real session end 2 h ago counts as a natural break');
    assert.equal(late.of('natural-break').length, 1);
  }
});

test('a cancelled logoff query does not mark the running break as system-interrupted for good', () => {
  assert.equal(SHUTDOWN_MARK_TTL_MS, 60 * SEC);
  const store = createMemoryBreakStore();
  const h = setup({ breakStore: store, settings: { timer: { shortBreakSeconds: 600 } } });
  h.s.startBreak();
  h.advance(10 * SEC);
  h.s.onSystemShutdown(); // Windows query-session-end – the user may still cancel the logoff
  assert.equal(store.data.interrupted, 'system');
  h.advance(SHUTDOWN_MARK_TTL_MS - SEC);
  assert.equal(store.data.interrupted, 'system', 'a real session end kills the app within seconds');

  h.advance(SEC); // the app is still running and the break still progressing -> no shutdown happened
  assert.equal(store.data.interrupted, null, 'the marker is dropped and the record rewritten');
  assert.equal(store.data.elapsedMs, 70 * SEC);
  assert.equal(h.state().phase, 'break', 'the break itself is untouched');
  assert.equal(h.state().break.remainingMs, 530 * SEC);
  assertLocked(h);

  // killed now, the break still resumes 2 h later (8 h window instead of 5 minutes)
  const back = setup({ breakStore: store, start: h.clock.t + 2 * HOUR, mono: 17 });
  back.startStop();
  assert.equal(back.state().phase, 'break');
  assert.equal(back.state().break.remainingMs, 530 * SEC);

  // the next shutdown call marks it again (a second query, or the real session end)
  h.s.onSystemShutdown();
  assert.equal(store.data.interrupted, 'system');
  h.advance(30 * SEC);
  assert.equal(store.data.interrupted, 'system');
});

// ---------------------------------------------------------------------------
// review fix L5: a stale record cannot resume the same break forever

test('a saved record older than the resume window is rejected, also when it can never be cleared', () => {
  const rec = { type: 'long', durationMs: 600000, elapsedMs: 100000, strict: true, savedAt: BASE, interrupted: null };
  assert.ok(parseSavedBreak(rec, BASE + BREAK_RESUME_MAX_GAP_MS - SEC));
  assert.equal(parseSavedBreak(rec, BASE + BREAK_RESUME_MAX_GAP_MS), null, 'exactly at the window it is stale');
  assert.equal(parseSavedBreak(rec, BASE + 9 * HOUR), null);
  assert.ok(parseSavedBreak(rec, BASE - HOUR), 'a savedAt in the future is kept: downtime never shortens a break');
  for (const now of [undefined, null, NaN, Infinity, '2026-09-16', {}]) {
    assert.ok(parseSavedBreak(rec, now), `no usable clock means no age check (${String(now)})`);
  }

  // save() and clear() fail permanently (locked file): the same record keeps coming back
  const stuck = { load: () => clone(rec), save: () => false, clear: () => false };
  const within = setup({ breakStore: stuck, start: BASE + 7 * HOUR });
  within.startStop();
  assert.equal(within.state().phase, 'break', 'inside the window it still resumes');

  const after = setup({ breakStore: stuck, start: BASE + BREAK_RESUME_MAX_GAP_MS });
  after.startStop();
  assert.equal(after.state().phase, 'work', 'after 8 h the stale record never resumes again');
  assert.equal(after.of('break-start').length, 0);

  const sys = { load: () => ({ ...clone(rec), interrupted: 'system' }), save: () => false, clear: () => false };
  const late = setup({ breakStore: sys, start: BASE + 9 * HOUR });
  late.startStop();
  assert.equal(late.state().phase, 'work');
  assert.equal(late.of('break-start').length, 0);
});

test('hard caps still hold: durationMs at most 1 h, elapsedMs clamped, hostile records rejected', () => {
  assert.equal(MAX_SAVED_BREAK_MS, 60 * MIN);
  const now = BASE + MIN;
  const valid = { type: 'short', durationMs: MAX_SAVED_BREAK_MS, elapsedMs: 1500.9, strict: true, savedAt: BASE, interrupted: null };
  assert.deepEqual(parseSavedBreak(valid, now), { ...valid, elapsedMs: 1500 });
  for (const bad of [
    { ...valid, durationMs: MAX_SAVED_BREAK_MS + 1 }, { ...valid, durationMs: 0 }, { ...valid, durationMs: -1 },
    { ...valid, durationMs: 1.5 }, { ...valid, durationMs: '600000' },
    { ...valid, elapsedMs: -1 }, { ...valid, elapsedMs: MAX_SAVED_BREAK_MS + 1 }, { ...valid, elapsedMs: NaN },
    { ...valid, savedAt: 0 }, { ...valid, savedAt: 1e300 }, { ...valid, interrupted: 'user' },
    { ...valid, type: 'medium' }, { ...valid, strict: 'true' }, Object.create(valid),
  ]) {
    assert.equal(parseSavedBreak(bad, now), null, JSON.stringify(bad));
  }

  // a resumed break never exceeds its own duration and a capped suspend cannot stretch it either
  const store = createMemoryBreakStore({ ...valid, elapsedMs: MAX_SAVED_BREAK_MS - 5 * SEC });
  const h = setup({ breakStore: store, start: now });
  h.startStop();
  const st = h.state();
  assert.equal(st.break.durationMs, MAX_SAVED_BREAK_MS);
  assert.equal(st.break.remainingMs, 5 * SEC);
  h.s.onSuspend();
  h.clock.t += 10 * HOUR;
  h.s.onResume();
  assert.equal(h.state().phase, 'work');
  assert.deepEqual(h.stats.callsOf('recordBreak'), [{ type: 'short', completed: false, seconds: 3595, skipped: false }]);
});
