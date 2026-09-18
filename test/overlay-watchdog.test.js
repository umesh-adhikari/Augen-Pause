'use strict';

/**
 * Review fixes M3 (focus watchdog must not self-feed) and L6 (ap:update-settings throttle).
 * Only the pure decisions are tested here – windows.js / ipc.js require electron lazily, so both
 * modules can be loaded in plain Node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  overlayWatchdogPlan,
  createRateLimiter,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_COALESCE_MS,
  MAX_REFOCUS_PER_SECOND,
  MAX_WATCHDOG_RUNS_PER_SECOND,
} = require('../src/main/windows');
const { createSenderRateLimiter, MAX_SETTINGS_PATCHES_PER_SECOND } = require('../src/main/ipc');

const NOTHING = { restore: false, show: false, setOnTop: false, moveTop: false };

test('overlayWatchdogPlan: an overlay that sits where it belongs is not touched', () => {
  // the steady state of a break: the primary overlay has the focus, every overlay is visible and on top.
  // Raising a window here could blur a sibling, and that blur asks for the next pass → busy loop.
  assert.deepEqual(
    overlayWatchdogPlan({ minimized: false, visible: true, onTop: true, anyOverlayFocused: true }),
    NOTHING,
  );
});

test('overlayWatchdogPlan: lost focus raises the whole stack again', () => {
  // Alt+Tab / Win+D / a foreign window: no overlay has the focus any more
  assert.deepEqual(overlayWatchdogPlan({ visible: true, onTop: true, anyOverlayFocused: false }), {
    restore: false,
    show: false,
    setOnTop: false,
    moveTop: true,
  });
});

test('overlayWatchdogPlan: everything that is actually wrong is repaired', () => {
  assert.deepEqual(overlayWatchdogPlan({ minimized: true, visible: false, onTop: false, anyOverlayFocused: true }), {
    restore: true,
    show: true,
    setOnTop: true,
    moveTop: true,
  });
  // a single defect is enough to act, even while a sibling holds the focus
  assert.deepEqual(overlayWatchdogPlan({ onTop: false, anyOverlayFocused: true }), {
    restore: false, show: false, setOnTop: true, moveTop: true,
  });
  assert.deepEqual(overlayWatchdogPlan({ visible: false, anyOverlayFocused: true }), {
    restore: false, show: true, setOnTop: false, moveTop: true,
  });
  assert.deepEqual(overlayWatchdogPlan({ minimized: true, anyOverlayFocused: true }), {
    restore: true, show: false, setOnTop: false, moveTop: true,
  });
});

test('overlayWatchdogPlan: unknown window state is treated as "needs work", never as ok', () => {
  // no argument / garbage: assume nothing is focused → re-assert (fail closed, the lock must stay up)
  assert.equal(overlayWatchdogPlan().moveTop, true);
  assert.equal(overlayWatchdogPlan({}).moveTop, true);
  assert.deepEqual(overlayWatchdogPlan({ visible: 'yes', onTop: 1, anyOverlayFocused: 'true' }), {
    restore: false, show: true, setOnTop: true, moveTop: true,
  });
});

test('the watchdog is rate limited and coalesced (M3: no unbounded setImmediate loop)', () => {
  assert.ok(WATCHDOG_COALESCE_MS >= 25 && WATCHDOG_COALESCE_MS <= 100, 'coalesce window 25..100 ms');
  assert.ok(MAX_WATCHDOG_RUNS_PER_SECOND <= 1000 / WATCHDOG_COALESCE_MS, 'the limiter is the binding constraint');
  assert.equal(MAX_WATCHDOG_RUNS_PER_SECOND, 10, '§11: max 10 event driven passes per second');
  assert.equal(MAX_REFOCUS_PER_SECOND, 10, '§11: max 10 refocus attempts per second');
  assert.equal(WATCHDOG_INTERVAL_MS, 400);

  // the event driven path: a blur storm cannot buy more than MAX_WATCHDOG_RUNS_PER_SECOND passes
  const limiter = createRateLimiter(MAX_WATCHDOG_RUNS_PER_SECOND, 1000);
  let passes = 0;
  for (let i = 0; i < 10_000; i += 1) if (limiter.tryAcquire(1_000_000)) passes += 1;
  assert.equal(passes, MAX_WATCHDOG_RUNS_PER_SECOND);
  // …and the budget comes back as the window slides
  assert.equal(limiter.tryAcquire(1_000_999), false);
  assert.equal(limiter.tryAcquire(1_001_000), true);
  limiter.reset();
  assert.equal(limiter.tryAcquire(1_000_000), true, 'reset() at break start clears the window');
});

test('L6: ap:update-settings is throttled per sending window', () => {
  assert.equal(MAX_SETTINGS_PATCHES_PER_SECOND, 20);
  const limiter = createSenderRateLimiter(MAX_SETTINGS_PATCHES_PER_SECOND, 1000);
  const spin = (id, now, times) => {
    let accepted = 0;
    for (let i = 0; i < times; i += 1) if (limiter.tryAcquire(id, now)) accepted += 1;
    return accepted;
  };
  assert.equal(spin(7, 5_000, 500), MAX_SETTINGS_PATCHES_PER_SECOND, 'a spinning renderer is cut off');
  // a second window has its own budget (the dashboard must not be blocked by the widget)
  assert.equal(spin(8, 5_000, 500), MAX_SETTINGS_PATCHES_PER_SECOND);
  assert.equal(limiter.tryAcquire(7, 5_999), false, 'still within the window');
  assert.equal(limiter.tryAcquire(7, 6_000), true, 'budget returns after 1 s');
  // an unknown / missing sender id is tracked as one bucket instead of being waved through
  assert.equal(spin(undefined, 9_000, 100), MAX_SETTINGS_PATCHES_PER_SECOND);
  assert.equal(limiter.tryAcquire(null, 9_000), false, 'null and undefined share that bucket');
  // many senders (ids are not reused in practice) must not grow the map without bound
  for (let id = 100; id < 300; id += 1) assert.equal(limiter.tryAcquire(id, 10_000), true);
  limiter.reset();
  assert.equal(limiter.tryAcquire(7, 10_000), true);
});
