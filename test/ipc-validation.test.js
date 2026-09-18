'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { IPC, ACTIONS, DASHBOARD_TABS } = require('../src/main/constants');
const v = require('../src/main/ipc-validate');

test('viewFromUrl accepts only app://augenpause/<view>/…', () => {
  assert.equal(v.viewFromUrl('app://augenpause/widget/index.html'), 'widget');
  assert.equal(v.viewFromUrl('app://augenpause/dashboard/index.html'), 'dashboard');
  assert.equal(v.viewFromUrl('app://augenpause/overlay/index.html?primary=1'), 'overlay');
  assert.equal(v.viewFromUrl('app://augenpause/dashboard/index.html#settings'), 'dashboard');

  for (const url of [
    'app://augenpause/widget',
    'app://augenpause/widgets/index.html',
    'app://augenpause/shared/api.js',
    'app://augenpause/Widget/index.html',
    'app://evil/widget/index.html',
    'app://augenpause.evil/widget/index.html',
    'https://augenpause/widget/index.html',
    'file:///widget/index.html',
    'about:blank',
    'devtools://devtools/bundled/inspector.html',
    '',
    null,
    undefined,
    {},
  ]) {
    assert.equal(v.viewFromUrl(url), null, String(url));
  }
});

test('channel allowlist per view', () => {
  const all = ['widget', 'dashboard', 'overlay'];
  for (const view of all) {
    assert.equal(v.isChannelAllowedForView(IPC.GET_SNAPSHOT, view), true);
    assert.equal(v.isChannelAllowedForView(IPC.ACTION, view), true);
  }
  // §10: the overlay may not write settings or read stats
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.UPDATE_SETTINGS, view)), ['widget', 'dashboard']);
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.GET_STATS, view)), ['widget', 'dashboard']);
  assert.equal(v.isChannelAllowedForView(IPC.UPDATE_SETTINGS, 'overlay'), false);
  assert.equal(v.isChannelAllowedForView(IPC.GET_STATS, 'overlay'), false);
  // reset-* only from the dashboard
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.RESET_SETTINGS, view)), ['dashboard']);
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.RESET_STATS, view)), ['dashboard']);
  // context menu from widget + dashboard
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.CONTEXT_MENU, view)), ['widget', 'dashboard']);
  // drag / interactive only from the widget
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.WIDGET_DRAG, view)), ['widget']);
  assert.deepEqual(all.filter((view) => v.isChannelAllowedForView(IPC.WIDGET_INTERACTIVE, view)), ['widget']);
  // push channels and unknown channels are never accepted from renderers
  for (const channel of [IPC.STATE, IPC.SETTINGS, IPC.STATS, IPC.NAVIGATE, 'ap:unknown', '__proto__', 'constructor']) {
    for (const view of all) assert.equal(v.isChannelAllowedForView(channel, view), false, `${channel}/${view}`);
  }
  assert.equal(v.isChannelAllowedForView(IPC.GET_SNAPSHOT, 'unknown'), false);
  assert.equal(v.isChannelAllowedForView(IPC.GET_SNAPSHOT, null), false);
});

test('overlay channel set is minimal (§10)', () => {
  const overlayChannels = Object.keys(v.CHANNEL_VIEWS).filter((channel) => v.isChannelAllowedForView(channel, 'overlay'));
  assert.deepEqual(overlayChannels.sort(), [IPC.ACTION, IPC.GET_SNAPSHOT].sort());
  // allowlists are frozen – nothing can widen them at runtime
  for (const views of Object.values(v.CHANNEL_VIEWS)) assert.ok(Object.isFrozen(views));
  assert.ok(Object.isFrozen(v.CHANNEL_VIEWS));
});

test('every renderer → main channel has an allowlist entry', () => {
  const rendererChannels = [
    IPC.GET_SNAPSHOT, IPC.UPDATE_SETTINGS, IPC.RESET_SETTINGS, IPC.GET_STATS, IPC.RESET_STATS, IPC.ACTION,
    IPC.CONTEXT_MENU, IPC.WIDGET_DRAG, IPC.WIDGET_INTERACTIVE,
  ];
  assert.deepEqual(Object.keys(v.CHANNEL_VIEWS).sort(), [...rendererChannels].sort());
});

test('action allowlist per view', () => {
  for (const name of ACTIONS) {
    assert.equal(v.isActionAllowedForView(name, 'widget'), true, name);
    assert.equal(v.isActionAllowedForView(name, 'dashboard'), true, name);
  }
  assert.deepEqual(
    ACTIONS.filter((name) => v.isActionAllowedForView(name, 'overlay')).sort(),
    ['drink', 'skip-break', 'snooze', 'undo-drink'],
  );
  assert.equal(v.isActionAllowedForView('quit', 'overlay'), false);
  assert.equal(v.isActionAllowedForView('pause', 'overlay'), false);
  assert.equal(v.isActionAllowedForView('unknown', 'widget'), false);
  assert.equal(v.isActionAllowedForView('drink', 'unknown'), false);
});

test('validateAction: names', () => {
  assert.deepEqual(v.validateAction('nope'), { ok: false, error: 'unknown-action' });
  assert.equal(v.validateAction(42).ok, false);
  assert.equal(v.validateAction(null).ok, false);
  assert.equal(v.validateAction('__proto__').ok, false);
  assert.equal(v.validateAction('toString').ok, false);
});

test('validateAction: break-now', () => {
  assert.deepEqual(v.validateAction('break-now'), { ok: true, name: 'break-now', arg: undefined });
  assert.deepEqual(v.validateAction('break-now', 'short'), { ok: true, name: 'break-now', arg: 'short' });
  assert.deepEqual(v.validateAction('break-now', 'long'), { ok: true, name: 'break-now', arg: 'long' });
  assert.equal(v.validateAction('break-now', 'medium').ok, false);
  assert.equal(v.validateAction('break-now', 1).ok, false);
});

test('validateAction: snooze minutes int 1..60 | undefined', () => {
  assert.deepEqual(v.validateAction('snooze'), { ok: true, name: 'snooze', arg: undefined });
  assert.deepEqual(v.validateAction('snooze', null), { ok: true, name: 'snooze', arg: undefined });
  for (const m of [1, 5, 10, 15, 30, 60]) assert.deepEqual(v.validateAction('snooze', m), { ok: true, name: 'snooze', arg: m });
  for (const bad of [0, 61, -5, 2.5, NaN, Infinity, '5', true, {}]) {
    assert.equal(v.validateAction('snooze', bad).ok, false, String(bad));
  }
});

test('validateAction: pause minutes int 1..1440 | tomorrow | null', () => {
  assert.deepEqual(v.validateAction('pause', null), { ok: true, name: 'pause', arg: null });
  assert.deepEqual(v.validateAction('pause'), { ok: true, name: 'pause', arg: null });
  assert.deepEqual(v.validateAction('pause', 'tomorrow'), { ok: true, name: 'pause', arg: 'tomorrow' });
  assert.deepEqual(v.validateAction('pause', 1), { ok: true, name: 'pause', arg: 1 });
  assert.deepEqual(v.validateAction('pause', 1440), { ok: true, name: 'pause', arg: 1440 });
  for (const bad of [0, 1441, 30.5, '30', 'today', 'Tomorrow', [], {}]) {
    assert.equal(v.validateAction('pause', bad).ok, false, String(bad));
  }
});

test('validateAction: open-dashboard tabs', () => {
  assert.deepEqual(v.validateAction('open-dashboard'), { ok: true, name: 'open-dashboard', arg: undefined });
  for (const tab of DASHBOARD_TABS) {
    assert.deepEqual(v.validateAction('open-dashboard', tab), { ok: true, name: 'open-dashboard', arg: tab });
  }
  for (const bad of ['home', 'Settings', '../', 1, {}]) assert.equal(v.validateAction('open-dashboard', bad).ok, false);
});

test('validateAction: argument-less actions drop any argument', () => {
  for (const name of ['skip-break', 'resume', 'reset-timer', 'drink', 'undo-drink', 'toggle-dashboard',
    'show-widget', 'hide-widget', 'reset-widget-position', 'quit']) {
    assert.deepEqual(v.validateAction(name, { evil: true }), { ok: true, name, arg: undefined });
  }
});

test('validateSettingsPatch: accepts realistic patches', () => {
  assert.deepEqual(v.validateSettingsPatch({}), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ language: 'en' }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ timer: { preset: 'pomodoro', workMinutes: 25 } }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ widget: { position: { x: 10, y: -20 } } }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ widget: { position: null } }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ schedule: { days: [1, 2, 3], start: '08:00' } }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch({ meeting: { autoDetect: false } }), { ok: true });
  assert.deepEqual(v.validateSettingsPatch(Object.assign(Object.create(null), { language: 'de' })), { ok: true });
});

test('validateSettingsPatch: rejects non plain objects', () => {
  for (const bad of [null, undefined, 1, 'x', true, [], [1], new Date(), new Map(), () => {}]) {
    assert.equal(v.validateSettingsPatch(bad).ok, false, String(bad));
  }
  assert.equal(v.validateSettingsPatch({ widget: new Date() }).ok, false);
  assert.equal(v.validateSettingsPatch({ widget: new Map() }).ok, false);
  assert.equal(v.validateSettingsPatch({ widget: () => {} }).ok, false);
  assert.equal(v.validateSettingsPatch({ widget: { size: Symbol('x') } }).ok, false);
  assert.equal(v.validateSettingsPatch({ timer: { workMinutes: NaN } }).ok, false);
  assert.equal(v.validateSettingsPatch({ timer: { workMinutes: Infinity } }).ok, false);
  assert.equal(v.validateSettingsPatch({ timer: { workMinutes: 10n } }).ok, false);
  assert.equal(v.validateSettingsPatch({ [Symbol('s')]: 1 }).ok, false);
  const withGetter = {};
  Object.defineProperty(withGetter, 'language', { enumerable: true, get: () => 'de' });
  assert.equal(v.validateSettingsPatch(withGetter).ok, false);
});

test('validateSettingsPatch: rejects prototype pollution keys at any depth', () => {
  const cases = [
    JSON.parse('{"__proto__": {"polluted": true}}'),
    JSON.parse('{"widget": {"__proto__": {"polluted": true}}}'),
    { constructor: { prototype: { polluted: true } } },
    { timer: { prototype: 1 } },
    { widget: { position: { constructor: 1 } } },
  ];
  for (const patch of cases) {
    const r = v.validateSettingsPatch(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, /forbidden key/);
  }
  assert.equal({}.polluted, undefined);
});

test('validateSettingsPatch: depth ≤ 4', () => {
  assert.deepEqual(v.validateSettingsPatch({ a: { b: { c: { d: 1 } } } }), { ok: true }); // 4 object levels
  assert.equal(v.validateSettingsPatch({ a: { b: { c: { d: { e: 1 } } } } }).ok, false);
  assert.equal(v.validateSettingsPatch({ a: { b: { c: [[1]] } } }).ok, false);
  assert.match(v.validateSettingsPatch({ a: { b: { c: { d: {} } } } }).error, /too deep/);
});

test('validateSettingsPatch: JSON size ≤ 16 KB and node budget', () => {
  assert.deepEqual(v.validateSettingsPatch({ language: 'x'.repeat(16000) }), { ok: true });
  assert.equal(v.validateSettingsPatch({ language: 'x'.repeat(16 * 1024 + 1) }).ok, false);
  assert.equal(v.validateSettingsPatch({ schedule: { days: new Array(5000).fill(1) } }).ok, false);
  const wide = {};
  for (let i = 0; i < 2000; i += 1) wide[`k${i}`] = 1;
  assert.equal(v.validateSettingsPatch(wide).ok, false);
});

test('validateStatsDays: int 1..400', () => {
  for (const d of [1, 7, 30, 400]) assert.deepEqual(v.validateStatsDays(d), { ok: true, days: d });
  for (const bad of [0, 401, -1, 7.5, '7', null, undefined, NaN, Infinity, [7]]) {
    assert.equal(v.validateStatsDays(bad).ok, false, String(bad));
  }
});

test('validateDragPhase / validateInteractive', () => {
  for (const phase of ['start', 'move', 'end']) assert.equal(v.validateDragPhase(phase), true);
  for (const bad of ['START', 'drag', '', null, 1, {}]) assert.equal(v.validateDragPhase(bad), false);
  assert.equal(v.validateInteractive(true), true);
  assert.equal(v.validateInteractive(false), true);
  for (const bad of [0, 1, 'true', null, undefined]) assert.equal(v.validateInteractive(bad), false);
});

test('isPlainObject: only literal / prototype-less objects', () => {
  for (const good of [{}, { a: 1 }, Object.create(null), Object.assign(Object.create(null), { a: 1 }), JSON.parse('{}')]) {
    assert.equal(v.isPlainObject(good), true, JSON.stringify(good));
  }
  class Settings {}
  for (const bad of [null, undefined, 0, '', 'x', true, [], [1], new Date(), new Map(), new Settings(),
    Object.create({ a: 1 }), () => {}, Symbol('s')]) {
    assert.equal(v.isPlainObject(bad), false, String(bad));
  }
});

test('exported views, overlay actions and patch limits', () => {
  assert.deepEqual([...v.VIEWS], ['widget', 'dashboard', 'overlay']);
  assert.ok(Object.isFrozen(v.VIEWS));
  assert.deepEqual([...v.OVERLAY_ACTIONS].sort(), ['drink', 'skip-break', 'snooze', 'undo-drink']);
  assert.ok(Object.isFrozen(v.OVERLAY_ACTIONS));
  for (const name of v.OVERLAY_ACTIONS) assert.ok(ACTIONS.includes(name), `${name} is a real action`);
  assert.deepEqual([...v.DRAG_PHASES], ['start', 'move', 'end']);
  assert.ok(Object.isFrozen(v.DRAG_PHASES));
  assert.equal(v.MAX_PATCH_DEPTH, 4);
  assert.equal(v.MAX_PATCH_JSON, 16 * 1024);
  assert.equal(v.MAX_PATCH_NODES, 1000);
});

test('the mandatory-break decisions live in strict-guard.js (§11), not here', () => {
  // ipc-validate stays a pure payload validator; the Pflicht-Pause guard moved to its own module.
  for (const name of ['isStrictBreak', 'guardStrictModePatch', 'isStrictBreakState', 'guardSettingsPatch']) {
    assert.equal(name in v, false, `ipc-validate must not export ${name}`);
  }
  const guard = require('../src/main/strict-guard');
  for (const name of ['isStrictBreakState', 'isActionAllowedDuringStrictBreak', 'guardSettingsPatch',
    'strictFlagForBreakStart']) {
    assert.equal(typeof guard[name], 'function', `strict-guard exports ${name}`);
  }
  // the validator does not know about strict breaks: a snooze payload stays valid, main rejects it later
  assert.deepEqual(v.validateAction('snooze', 5), { ok: true, name: 'snooze', arg: 5 });
  assert.deepEqual(v.validateSettingsPatch({ breaks: { strictMode: false } }), { ok: true });
});
