'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('../src/main/constants');
const windows = require('../src/main/windows');

const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');

/** Extracts `KEY: 'value'` pairs of the `const IPC = Object.freeze({ … })` block in preload.js. */
function preloadIpcChannels() {
  const block = /const IPC = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(PRELOAD_SOURCE);
  assert.ok(block, 'preload.js must define const IPC = Object.freeze({ … })');
  const out = {};
  for (const m of block[1].matchAll(/^\s*([A-Z_]+)\s*:\s*'([^']+)'\s*,?\s*$/gm)) out[m[1]] = m[2];
  return out;
}

test('preload IPC channel names equal constants.IPC', () => {
  assert.deepEqual(preloadIpcChannels(), { ...constants.IPC });
});

test('preload uses no channel string outside its IPC table', () => {
  const known = new Set(Object.values(constants.IPC));
  const literals = [...PRELOAD_SOURCE.matchAll(/'(ap:[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(literals.length >= Object.keys(constants.IPC).length);
  for (const channel of literals) assert.ok(known.has(channel), channel);
});

test('preload only requires electron (sandboxed preload)', () => {
  const requires = [...PRELOAD_SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ['electron']);
  assert.doesNotMatch(PRELOAD_SOURCE, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
});

test('preload exposes the complete §5 API', () => {
  const block = /const api = \{([\s\S]*?)\n\};/.exec(PRELOAD_SOURCE);
  assert.ok(block, 'preload.js must define const api = { … }');
  const keys = [...block[1].matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [
    'action', 'getSnapshot', 'getStats', 'onNavigate', 'onSettings', 'onState', 'onStats', 'platform',
    'resetSettings', 'resetStats', 'setWidgetInteractive', 'showContextMenu', 'updateSettings', 'view', 'widgetDrag',
  ]);
  assert.match(PRELOAD_SOURCE, /exposeInMainWorld\('augenpause', api\)/);
});

test('app identity and origin', () => {
  assert.equal(constants.APP_ID, 'com.augenpause.app');
  assert.equal(constants.APP_ORIGIN, 'app://augenpause');
  assert.equal(constants.OVERLAY_BACKGROUND, '#0b1020');
});

test('ACTIONS and dashboard tabs match the contract', () => {
  assert.deepEqual([...constants.ACTIONS].sort(), [
    'break-now', 'drink', 'hide-widget', 'open-dashboard', 'pause', 'quit', 'reset-timer', 'reset-widget-position',
    'resume', 'show-widget', 'skip-break', 'snooze', 'toggle-dashboard', 'undo-drink',
  ]);
  assert.deepEqual([...constants.DASHBOARD_TABS], ['overview', 'settings', 'stats', 'exercises', 'about']);
});

test('widgetWindowSize follows §6', () => {
  assert.deepEqual(constants.widgetWindowSize('small'), { clock: 120, width: 200, height: 196 });
  assert.deepEqual(constants.widgetWindowSize('medium'), { clock: 160, width: 200, height: 236 });
  assert.deepEqual(constants.widgetWindowSize('large'), { clock: 210, width: 234, height: 286 });
  assert.deepEqual(constants.widgetWindowSize('huge'), constants.widgetWindowSize('medium'));
});

// ---- windows.js pure geometry helpers (built on widgetWindowSize) ------------------------------

const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SECOND = { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, workArea: { x: 1920, y: -200, width: 2560, height: 1400 } };
const DISPLAYS = [PRIMARY, SECOND];

test('default widget position: top-right of the primary work area, 24 px margin', () => {
  const size = constants.widgetWindowSize('medium');
  assert.deepEqual(windows.resolveWidgetBounds(null, size, DISPLAYS, PRIMARY), { x: 1920 - 200 - 24, y: 24, width: 200, height: 236 });
  const offsetPrimary = { workArea: { x: 100, y: 50, width: 1000, height: 700 } };
  assert.deepEqual(windows.defaultWidgetBounds(offsetPrimary.workArea, size), { x: 876, y: 74, width: 200, height: 236 });
});

test('saved widget position is used when it lies on a connected display', () => {
  const size = constants.widgetWindowSize('medium');
  assert.deepEqual(windows.resolveWidgetBounds({ x: 100, y: 100 }, size, DISPLAYS, PRIMARY), { x: 100, y: 100, width: 200, height: 236 });
  // on the second display (negative y)
  assert.deepEqual(windows.resolveWidgetBounds({ x: 3000, y: -150 }, size, DISPLAYS, PRIMARY), { x: 3000, y: -150, width: 200, height: 236 });
  // partly outside → clamped into that display's work area
  assert.deepEqual(windows.resolveWidgetBounds({ x: 1800, y: 900 }, size, [PRIMARY], PRIMARY), { x: 1720, y: 804, width: 200, height: 236 });
  // display disconnected → default corner
  assert.deepEqual(windows.resolveWidgetBounds({ x: 3000, y: 300 }, size, [PRIMARY], PRIMARY), { x: 1696, y: 24, width: 200, height: 236 });
  assert.deepEqual(windows.resolveWidgetBounds({ x: NaN, y: 1 }, size, DISPLAYS, PRIMARY), { x: 1696, y: 24, width: 200, height: 236 });
});

test('size change keeps the clock centre stable', () => {
  const medium = constants.widgetWindowSize('medium');
  const large = constants.widgetWindowSize('large');
  const bounds = { x: 500, y: 300, width: medium.width, height: medium.height };
  const before = windows.widgetClockCentre(bounds, medium.clock);
  const next = windows.resizeKeepingClockCentre(bounds, medium.clock, large);
  const after = windows.widgetClockCentre(next, large.clock);
  assert.ok(Math.abs(before.x - after.x) <= 0.5 && Math.abs(before.y - after.y) <= 0.5);
  assert.equal(next.width, large.width);
  assert.equal(next.height, large.height);
  assert.ok(Number.isInteger(next.x) && Number.isInteger(next.y));
});

test('clampRectToArea and nearestDisplay', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(windows.clampRectToArea({ x: -50, y: 790, width: 200, height: 100 }, area), { x: 0, y: 700, width: 200, height: 100 });
  assert.deepEqual(windows.clampRectToArea({ x: 10.4, y: 10.6, width: 20, height: 20 }, area), { x: 10, y: 11, width: 20, height: 20 });
  assert.deepEqual(windows.clampRectToArea({ x: 50, y: 50, width: 2000, height: 20 }, area), { x: 0, y: 50, width: 2000, height: 20 });
  assert.equal(windows.nearestDisplay(DISPLAYS, { x: 2500, y: 0 }).id, 2);
  assert.equal(windows.nearestDisplay(DISPLAYS, { x: -300, y: 500 }).id, 1);
  assert.equal(windows.nearestDisplay(DISPLAYS, { x: 1950, y: 1200 }).id, 2);
  assert.equal(windows.nearestDisplay([], { x: 0, y: 0 }), null);
});

test('overlay key blocking (Escape is handled separately)', () => {
  const blocked = (input) => windows.isBlockedOverlayInput({ type: 'keyDown', ...input });
  assert.equal(blocked({ key: 'F4', alt: true }), true);
  assert.equal(blocked({ key: 'w', control: true, code: 'KeyW' }), true);
  assert.equal(blocked({ key: 'W', control: true, shift: true, code: 'KeyW' }), true);
  assert.equal(blocked({ key: 'w', meta: true, code: 'KeyW' }), true);
  assert.equal(blocked({ key: 'q', meta: true, code: 'KeyQ' }), true);
  assert.equal(blocked({ key: 'h', meta: true, code: 'KeyH' }), true);
  assert.equal(blocked({ key: 'm', meta: true, code: 'KeyM' }), true);
  assert.equal(blocked({ key: 'F11' }), true);
  assert.equal(blocked({ key: 'Escape', code: 'Escape' }), false);
  assert.equal(blocked({ key: 'F4' }), false);
  assert.equal(blocked({ key: 'w', code: 'KeyW' }), false);
  assert.equal(blocked({ key: 'q', control: true, code: 'KeyQ' }), false);
  assert.equal(blocked({ key: ' ', code: 'Space' }), false);
  assert.equal(windows.isBlockedOverlayInput(null), false);
});

test('overlay Escape is consumed by main: keyDown snoozes, repeats / keyUp are only swallowed (§10)', () => {
  assert.equal(windows.overlayEscapeAction({ type: 'keyDown', key: 'Escape', code: 'Escape' }), 'snooze');
  assert.equal(windows.overlayEscapeAction({ type: 'keyDown', key: 'Escape', isAutoRepeat: true }), 'swallow');
  assert.equal(windows.overlayEscapeAction({ type: 'keyUp', key: 'Escape' }), 'swallow');
  assert.equal(windows.overlayEscapeAction({ type: 'keyDown', key: 'Enter' }), null);
  assert.equal(windows.overlayEscapeAction({ type: 'keyDown', key: 'F4', alt: true }), null);
  assert.equal(windows.overlayEscapeAction(null), null);
  assert.equal(windows.OVERLAY_READY_TIMEOUT_MS, 10000);
});

test('dashboard title bar overlay colours', () => {
  assert.deepEqual({ ...windows.THEME_COLORS.dark.overlay }, { color: '#0b1020', symbolColor: '#e8ecf6', height: 44 });
  assert.deepEqual({ ...windows.THEME_COLORS.light.overlay }, { color: '#f4f6fb', symbolColor: '#0f172a', height: 44 });
});
