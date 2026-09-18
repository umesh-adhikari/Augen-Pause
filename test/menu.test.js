'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMenuTemplate, buildAppMenuTemplate, buildStatusLine, menuSignature, findMenuItem, deriveStrictBreak,
  updateAvailableVersion, STRICT_BREAK_ENABLED_IDS,
} = require('../src/main/menu');
const { createMainI18n } = require('../src/main/i18n');

const NOW = new Date(2026, 8, 17, 14, 0, 0).getTime(); // local 17.09.2026 14:00

function merge(base, overrides) {
  for (const [section, values] of Object.entries(overrides)) {
    base[section] = typeof values === 'object' && values !== null && !Array.isArray(values)
      ? { ...base[section], ...values }
      : values;
  }
  return base;
}

function makeSettings(overrides = {}) {
  return merge({
    version: 2,
    language: 'de',
    timer: {
      preset: 'halfhour', workMinutes: 30, shortBreakSeconds: 120, longBreakEnabled: true,
      longBreakSeconds: 600, longBreakEvery: 4, warnBeforeSeconds: 60, snoozeMinutes: 5, maxSnoozes: 2,
    },
    breaks: {
      // §11: strictMode ("Pflicht-Pause") defaults to true – switched off here, the strict tests turn it on
      lockScreen: true, strictMode: false, overlayOpacity: 0.6, skipHoldSeconds: 3, allDisplays: true,
      showExercises: true, soundEnabled: true, soundVolume: 0.5, graceSeconds: 15,
    },
    idle: { enabled: true, resetAfterMinutes: 5 },
    hydration: { enabled: true, intervalMinutes: 45, dailyGoalGlasses: 8, glassMl: 250 },
    schedule: { workingHoursEnabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' },
    widget: {
      visible: true, alwaysOnTop: true, size: 'medium', opacity: 0.95, showSeconds: true, position: null, showOnWarning: true,
    },
    appearance: { theme: 'system', accent: 'teal' },
    general: { autostart: false, globalShortcuts: true, notifications: true },
    meeting: { autoDetect: true },
  }, overrides);
}

function makeState(overrides = {}) {
  return merge({
    now: NOW,
    phase: 'work',
    warning: false,
    work: { startedAt: NOW - 18 * 60000, endsAt: NOW + 12 * 60000, durationMs: 1800000, remainingMs: 12 * 60000, progress: 0.6 },
    break: {
      type: 'short', startedAt: null, endsAt: null, durationMs: 120000, remainingMs: 120000, progress: 0,
      canSkip: true, canSnooze: true, skipHoldSeconds: 3, lockScreen: true, inGrace: false, graceUntil: null,
    },
    cycle: { index: 1, longEvery: 4, longEnabled: true },
    pause: { until: null, reason: null },
    away: { since: null },
    snooze: { count: 0, max: 2, options: [5, 10, 15, 30] },
    meeting: { active: false, deferred: false, since: null },
    hydration: {
      enabled: true, nextAt: NOW + 1500000, intervalMs: 2700000, remainingMs: 1500000, progress: 0.44,
      due: false, glassesToday: 3, goal: 8,
    },
    today: { breaksCompleted: 4, breaksSkipped: 0, glasses: 3, workSeconds: 7200 },
  }, overrides);
}

function harness({
  state = makeState(), settings = makeSettings(), lang = 'de', precision, platform = 'win32', strictBreak,
  update = null,
} = {}) {
  const actions = [];
  const patches = [];
  const i18n = createMainI18n(() => lang, () => 'de-DE');
  const template = buildMenuTemplate({
    state,
    settings,
    update,
    t: i18n.t,
    onAction: (name, ...rest) => actions.push(rest.length ? [name, rest[0]] : [name]),
    onSettings: (patch) => patches.push(patch),
    precision,
    platform,
    strictBreak,
  });
  return { template, actions, patches, find: (id) => findMenuItem(template, id) };
}

function ids(template) {
  return template.map((item) => (item.type === 'separator' ? '---' : item.id));
}

/** All item ids (submenus included) that the user could still click. */
function enabledIds(template, out = []) {
  for (const item of template) {
    if (!item || item.type === 'separator') continue;
    if (item.enabled !== false) out.push(item.id);
    if (Array.isArray(item.submenu)) enabledIds(item.submenu, out);
  }
  return out;
}

function assertNoSeparatorGlitches(template) {
  assert.notEqual(template[0].type, 'separator', 'no leading separator');
  assert.notEqual(template[template.length - 1].type, 'separator', 'no trailing separator');
  for (let i = 1; i < template.length; i++) {
    assert.ok(!(template[i].type === 'separator' && template[i - 1].type === 'separator'), 'no double separators');
  }
  for (const item of template) if (Array.isArray(item.submenu)) assertNoSeparatorGlitches(item.submenu);
}

function assertPlainTemplate(template) {
  for (const item of template) {
    assert.equal(typeof item, 'object');
    if (item.type !== 'separator') {
      assert.equal(typeof item.id, 'string', 'every item has an id');
      assert.equal(typeof item.label, 'string', `label of ${item.id}`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(item.label), `no emoji in ${item.label}`);
      if (item.accelerator) assert.equal(item.registerAccelerator, false, `accelerator of ${item.id} is display-only`);
    }
    if (Array.isArray(item.submenu)) assertPlainTemplate(item.submenu);
  }
}

const TAIL = [
  'interval', 'lock-screen', 'strict-mode', 'widget', 'hydration', '---',
  'open-dashboard', 'open-settings', 'open-stats', 'check-updates', '---',
  'quit',
];

test('work phase: full structure, labels and hints', () => {
  const { template, find } = harness();
  assert.deepEqual(ids(template), [
    'status', '---',
    'break-now', 'snooze', 'skip-break', 'reset-timer', '---',
    'pause', 'meeting-auto-detect', '---',
    'drink', 'undo-drink', '---',
    ...TAIL,
  ]);
  assertNoSeparatorGlitches(template);
  assertPlainTemplate(template);

  assert.equal(find('status').label, 'Nächste Pause in 12 Min (kurz)');
  assert.equal(find('status').enabled, false);
  assert.equal(find('break-now').label, 'Jetzt Pause machen');
  assert.equal(find('break-now-short').label, 'Kurze Pause (2 Min)');
  assert.equal(find('break-now-long').label, 'Lange Pause (10 Min)');
  assert.equal(find('break-now-short').accelerator, undefined, 'break-now is no global shortcut (§10)');
  assert.equal(find('break-now-long').accelerator, undefined);
  assert.equal(find('snooze').label, 'Pause verschieben');
  assert.equal(find('snooze').enabled, true);
  assert.deepEqual(find('snooze').submenu.map((i) => i.label), ['+5 Min', '+10 Min', '+15 Min', '+30 Min']);
  assert.equal(find('snooze-5').accelerator, 'Control+Alt+F9', 'hint on the default snooze minutes');
  assert.equal(find('snooze-5').registerAccelerator, false);
  assert.equal(find('snooze-10').accelerator, undefined);
  assert.equal(find('skip-break').label, 'Nächste Pause überspringen');
  assert.equal(find('reset-timer').label, 'Timer zurücksetzen');
  assert.equal(find('pause').label, 'Meeting-Modus / Pausieren');
  assert.equal(find('pause').enabled, true);
  assert.deepEqual(find('pause').submenu.map((i) => i.label),
    ['30 Minuten', '1 Stunde', '2 Stunden', 'Bis morgen', 'Bis ich fortsetze']);
  assert.equal(find('pause-indefinitely').accelerator, 'Control+Alt+F10');
  assert.equal(find('pause-30').accelerator, undefined);
  assert.equal(find('meeting-auto-detect').label, 'Meetings automatisch erkennen');
  assert.equal(find('meeting-auto-detect').type, 'checkbox');
  assert.equal(find('meeting-auto-detect').checked, true);
  assert.equal(find('drink').label, 'Wasser getrunken (3/8)');
  assert.equal(find('drink').accelerator, undefined, 'drink is no global shortcut (§10)');
  assert.equal(find('undo-drink').enabled, true);
  assert.deepEqual(find('interval').submenu.filter((i) => i.type !== 'separator').map((i) => i.label), [
    'Halbstündlich (30 Min / 2 Min)',
    'Stündlich (1 Std / 5 Min)',
    '20-20-20 (20 Min / 20 s)',
    'Pomodoro (25 Min / 5 Min)',
    'Benutzerdefiniert…',
  ]);
  assert.equal(find('preset-halfhour').checked, true);
  assert.equal(find('preset-custom').checked, false);
  assert.equal(find('lock-screen').label, 'Bildschirm während Pause sperren');
  assert.equal(find('lock-screen').checked, true);
  assert.equal(find('strict-mode').label, 'Pflicht-Pause'); // §11 wording
  assert.equal(find('strict-mode').checked, false);
  assert.equal(find('strict-mode').enabled, true);
  assert.equal(find('widget-visible').checked, true);
  assert.equal(find('widget-size-medium').checked, true);
  assert.equal(find('hydration').label, 'Trink-Erinnerung');
  assert.equal(find('hydration').checked, true);
  assert.equal(find('open-dashboard').label, 'Dashboard öffnen');
  assert.equal(find('open-dashboard').accelerator, 'Control+Alt+F11');
  assert.equal(find('open-settings').label, 'Einstellungen…');
  assert.equal(find('open-stats').label, 'Statistik');
  assert.equal(find('quit').label, 'Beenden');
  assert.equal(find('quit').enabled, true);
});

test('work phase: click callbacks dispatch actions and settings patches', () => {
  const { find, actions, patches } = harness();
  find('break-now-short').click();
  find('break-now-long').click();
  find('snooze-5').click();
  find('snooze-30').click();
  find('skip-break').click();
  find('reset-timer').click();
  find('pause-30').click();
  find('pause-60').click();
  find('pause-120').click();
  find('pause-tomorrow').click();
  find('pause-indefinitely').click();
  find('drink').click();
  find('undo-drink').click();
  find('preset-custom').click();
  find('widget-visible').click({ checked: false });
  find('widget-reset-position').click();
  find('open-dashboard').click();
  find('open-settings').click();
  find('open-stats').click();
  find('quit').click();
  assert.deepEqual(actions, [
    ['break-now', 'short'],
    ['break-now', 'long'],
    ['snooze', 5],
    ['snooze', 30],
    ['skip-break'],
    ['reset-timer'],
    ['pause', 30],
    ['pause', 60],
    ['pause', 120],
    ['pause', 'tomorrow'],
    ['pause', null],
    ['drink'],
    ['undo-drink'],
    ['open-dashboard', 'settings'],
    ['hide-widget'],
    ['reset-widget-position'],
    ['open-dashboard', 'overview'],
    ['open-dashboard', 'settings'],
    ['open-dashboard', 'stats'],
    ['quit'],
  ]);

  find('preset-hourly').click();
  find('preset-halfhour').click(); // already active → no patch
  find('lock-screen').click({ checked: false }); // Electron flips `checked` before calling click
  find('strict-mode').click(); // without menu item → toggles the current value
  find('widget-on-top').click({ checked: false });
  find('widget-size-large').click();
  find('widget-size-medium').click(); // already active → no patch
  find('hydration').click({ checked: false });
  find('meeting-auto-detect').click({ checked: false });
  assert.deepEqual(patches, [
    { timer: { preset: 'hourly' } },
    { breaks: { lockScreen: false } },
    { breaks: { strictMode: true } },
    { widget: { alwaysOnTop: false } },
    { widget: { size: 'large' } },
    { hydration: { enabled: false } },
    { meeting: { autoDetect: false } },
  ]);
});

test('warning phase: snooze submenu first, countdown status, long break hint, exhausted snoozes', () => {
  const state = makeState({
    warning: true,
    work: { remainingMs: 42000, endsAt: NOW + 42000 },
    break: { type: 'long', durationMs: 600000, remainingMs: 600000, canSnooze: false },
    snooze: { count: 2, max: 2 },
  });
  const { template, find } = harness({ state });
  assert.deepEqual(ids(template).slice(0, 7), [
    'status', '---', 'snooze', 'break-now', 'skip-break', 'reset-timer', '---',
  ]);
  assertNoSeparatorGlitches(template);
  assert.equal(find('status').label, 'Pause in 0:42');
  assert.equal(find('snooze').enabled, false);
  assert.equal(find('break-now-long').accelerator, undefined);
  assert.equal(find('break-now-short').accelerator, undefined);
  assert.equal(find('snooze-5').accelerator, 'Control+Alt+F9');

  const minute = harness({ state, precision: 'minute' });
  assert.equal(minute.find('status').label, 'Pause in < 1 Min');

  const en = harness({ state, lang: 'en' });
  assert.equal(en.find('status').label, 'Break in 0:42');
  assert.equal(en.find('snooze').label, 'Snooze break');
});

test('meeting deferred: status line explains the postponed break', () => {
  const state = makeState({
    work: { remainingMs: 0, endsAt: NOW },
    meeting: { active: true, deferred: true, since: NOW - 600000 },
  });
  const { template, find } = harness({ state });
  assert.equal(find('status').label, 'Meeting erkannt – Pause wird danach nachgeholt');
  assert.equal(ids(template)[2], 'break-now', 'snooze is not forced to the top while deferred');
  assert.ok(find('snooze'));
  assert.equal(
    buildStatusLine({ state, t: createMainI18n(() => 'en', () => '').t, precision: 'minute', compact: true }),
    'Meeting detected – break will follow afterwards',
  );
});

/** A running mandatory break (§11): no grace, nothing can end it. */
function strictBreakState(overrides = {}) {
  return makeState({
    phase: 'break',
    work: { startedAt: null, endsAt: null, remainingMs: 0 },
    break: {
      type: 'short', startedAt: NOW - 37000, endsAt: NOW + 83000, remainingMs: 83000, strict: true,
      canSkip: false, canSnooze: false, inGrace: false, graceUntil: null, ...overrides,
    },
  });
}

test('mandatory break (§11): status line "Pflicht-Pause", every actionable item but the water entries disabled', () => {
  const state = strictBreakState();
  const settings = makeSettings({ breaks: { strictMode: true } });
  const { template, find } = harness({ state, settings });
  assert.deepEqual(ids(template), [
    'status', '---',
    'snooze', 'end-break', '---',
    'pause', 'meeting-auto-detect', '---',
    'drink', 'undo-drink', '---',
    ...TAIL,
  ]);
  assertNoSeparatorGlitches(template);
  assertPlainTemplate(template);
  assert.equal(find('status').label, 'Pflicht-Pause – noch 1:23');
  assert.equal(find('status').enabled, false);
  assert.equal(find('break-now'), null, 'no new break during a break');
  assert.equal(find('skip-break'), null);
  assert.equal(find('reset-timer'), null);

  // only drink / undo-drink stay clickable – exactly the actions main's performAction accepts (§11)
  assert.deepEqual(enabledIds(template), ['drink', 'undo-drink']);
  assert.deepEqual([...STRICT_BREAK_ENABLED_IDS], ['drink', 'undo-drink']);
  // spelled out for the important ones, incl. the whole pause / meeting submenu
  assert.equal(find('snooze').enabled, false);
  assert.equal(find('snooze-5').enabled, false, 'the snooze submenu is disabled too');
  assert.equal(find('end-break').label, 'Pause beenden');
  assert.equal(find('end-break').enabled, false);
  assert.equal(find('pause').enabled, false);
  for (const id of ['pause-30', 'pause-60', 'pause-120', 'pause-tomorrow', 'pause-indefinitely']) {
    assert.equal(find(id).enabled, false, id);
  }
  assert.equal(find('meeting-auto-detect').enabled, false, 'meeting detection cannot be toggled either');
  assert.equal(find('interval').enabled, false);
  assert.equal(find('preset-pomodoro').enabled, false);
  assert.equal(find('lock-screen').enabled, false);
  assert.equal(find('strict-mode').checked, true);
  assert.equal(find('strict-mode').enabled, false, 'the mode of a running break is fixed');
  assert.equal(find('widget').enabled, false);
  assert.equal(find('widget-size-large').enabled, false);
  assert.equal(find('hydration').enabled, false);
  assert.equal(find('open-dashboard').enabled, false, 'the dashboard stays closed during a mandatory break');
  assert.equal(find('open-settings').enabled, false);
  assert.equal(find('open-stats').enabled, false);
  assert.equal(find('quit').enabled, false);

  // the water entries still work
  const { find: f2, actions } = harness({ state, settings });
  f2('drink').click();
  f2('undo-drink').click();
  assert.deepEqual(actions, [['drink'], ['undo-drink']]);

  const minute = harness({ state, settings, precision: 'minute' });
  assert.equal(minute.find('status').label, 'Pflicht-Pause – noch 2 Min');
  const en = harness({ state, settings, lang: 'en' });
  assert.equal(en.find('status').label, 'Mandatory break – 1:23 left');
  assert.equal(en.find('strict-mode').label, 'Mandatory break');
});

test('mandatory break: no grace escape hatch – a state claiming inGrace/canSnooze stays locked', () => {
  // §11 removes the grace period for strict breaks; a stale/hostile state must not re-open snoozing.
  const state = strictBreakState({
    type: 'long', durationMs: 600000, remainingMs: 595000, endsAt: NOW + 595000,
    canSnooze: true, inGrace: true, graceUntil: NOW + 10000,
  });
  const settings = makeSettings({ breaks: { strictMode: true, graceSeconds: 15 } });
  const { template, find } = harness({ state, settings });
  assert.equal(find('status').label, 'Pflicht-Pause – noch 9:55');
  assert.equal(find('snooze').enabled, false, 'no snooze in a mandatory break, grace flag or not');
  assert.equal(find('end-break').enabled, false);
  assert.equal(find('pause').enabled, false);
  assert.equal(find('quit').enabled, false);
  assert.deepEqual(enabledIds(template), ['drink', 'undo-drink']);
});

test('mandatory break: main\'s strictBreak flag and deriveStrictBreak (fail-closed)', () => {
  // A resumed break (§11) is strict even when the setting was switched off in the meantime.
  const relaxedSettings = makeSettings({ breaks: { strictMode: false } });
  const state = strictBreakState({ strict: undefined, canSkip: true, canSnooze: true });
  const override = harness({ state, settings: relaxedSettings, strictBreak: true });
  assert.equal(override.find('status').label, 'Pflicht-Pause – noch 1:23');
  assert.deepEqual(enabledIds(override.template), ['drink', 'undo-drink']);

  // the flag only matters during a break
  const working = harness({ state: makeState(), settings: relaxedSettings, strictBreak: true });
  assert.equal(working.find('quit').enabled, true);
  assert.equal(working.find('status').label, 'Nächste Pause in 12 Min (kurz)');

  // main says "not strict" → the normal break menu, even with strictMode on in the settings
  const strictSettings = makeSettings({ breaks: { strictMode: true } });
  const relaxed = harness({ state, settings: strictSettings, strictBreak: false });
  assert.equal(relaxed.find('status').label, 'Kurze Pause läuft – noch 1:23');
  assert.equal(relaxed.find('end-break').enabled, true);
  assert.equal(relaxed.find('quit').enabled, true);

  // without a flag the state decides: break.strict, canSkip === false or the setting
  assert.equal(deriveStrictBreak(strictBreakState({ strict: true, canSkip: true }), relaxedSettings), true);
  assert.equal(deriveStrictBreak(strictBreakState({ strict: undefined, canSkip: false }), relaxedSettings), true);
  assert.equal(deriveStrictBreak(strictBreakState({ strict: undefined, canSkip: true }), strictSettings), true);
  assert.equal(deriveStrictBreak(strictBreakState({ strict: undefined, canSkip: true }), relaxedSettings), false);
  assert.equal(deriveStrictBreak(makeState(), strictSettings), false, 'never strict outside a break');
  assert.equal(deriveStrictBreak(null, strictSettings), false);
});

test('menuSignature reacts to the mandatory-break flag', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  const state = strictBreakState({ strict: undefined, canSkip: true, canSnooze: true });
  const settings = makeSettings({ breaks: { strictMode: false } });
  const relaxed = menuSignature({ state, settings, t, strictBreak: false });
  const strict = menuSignature({ state, settings, t, strictBreak: true });
  assert.notEqual(relaxed, strict, 'the tray menu must be rebuilt when a mandatory break starts');
  assert.match(strict, /Pflicht-Pause/);
  assert.equal(menuSignature({ state: makeState(), settings, t, strictBreak: true }),
    menuSignature({ state: makeState(), settings, t, strictBreak: false }), 'the flag is ignored outside a break');
});

test('non-strict break: end break enabled and dispatches skip-break', () => {
  const state = makeState({
    phase: 'break',
    break: { type: 'long', startedAt: NOW, endsAt: NOW + 600000, remainingMs: 600000, canSkip: true },
  });
  const { find, actions } = harness({ state });
  assert.equal(find('status').label, 'Lange Pause läuft – noch 10:00');
  assert.equal(find('end-break').enabled, true);
  assert.equal(find('snooze').enabled, true);
  assert.equal(find('quit').enabled, true);
  assert.equal(find('pause').enabled, true);
  assert.equal(find('strict-mode').enabled, false);
  find('end-break').click();
  assert.deepEqual(actions, [['skip-break']]);
});

test('paused: resume instead of the pause submenu, status with until time', () => {
  const until = new Date(2026, 8, 17, 15, 30, 0).getTime();
  const state = makeState({ phase: 'paused', pause: { until, reason: 'user' } });
  const { template, find, actions } = harness({ state });
  assert.equal(find('status').label, 'Pausiert bis 15:30');
  assert.equal(find('pause'), null);
  assert.equal(find('snooze'), null);
  assert.equal(find('skip-break'), null);
  assert.ok(find('break-now'), 'break now stays available');
  assert.ok(find('meeting-auto-detect'));
  assert.equal(find('resume').label, 'Fortsetzen');
  assert.equal(find('resume').accelerator, 'Control+Alt+F10');
  assertNoSeparatorGlitches(template);
  find('resume').click();
  assert.deepEqual(actions, [['resume']]);

  const indefinitely = harness({ state: makeState({ phase: 'paused', pause: { until: null, reason: 'user' } }) });
  assert.equal(indefinitely.find('status').label, 'Pausiert');

  const tomorrow = new Date(2026, 8, 18, 8, 0, 0).getTime();
  const tm = harness({ state: makeState({ phase: 'paused', pause: { until: tomorrow, reason: 'user' } }) });
  assert.equal(tm.find('status').label, 'Pausiert bis morgen, 08:00');

  const monday = new Date(2026, 8, 21, 8, 0, 0).getTime();
  const mo = harness({ state: makeState({ phase: 'paused', pause: { until: monday, reason: 'user' } }), lang: 'en' });
  assert.equal(mo.find('status').label, 'Paused until Monday, 08:00');
});

test('away / off-hours status lines, no snooze entry', () => {
  const away = harness({ state: makeState({ phase: 'away', away: { since: NOW } }) });
  assert.equal(away.find('status').label, 'Abwesend');
  assert.equal(away.find('snooze'), null);
  assertNoSeparatorGlitches(away.template);
  assert.equal(harness({ state: makeState({ phase: 'off-hours' }) }).find('status').label, 'Außerhalb der Arbeitszeit');
});

test('hydration disabled: no drink entries and no double separators', () => {
  const settings = makeSettings({ hydration: { enabled: false }, meeting: { autoDetect: false } });
  const { template, find } = harness({ settings });
  assert.equal(find('drink'), null);
  assert.equal(find('undo-drink'), null);
  assert.equal(find('hydration').checked, false);
  assert.equal(find('meeting-auto-detect').checked, false);
  assertNoSeparatorGlitches(template);
  assert.deepEqual(ids(template), [
    'status', '---', 'break-now', 'snooze', 'skip-break', 'reset-timer', '---',
    'pause', 'meeting-auto-detect', '---',
    ...TAIL,
  ]);
});

test('no glasses yet: undo disabled; custom preset, snooze default and widget settings reflected', () => {
  const state = makeState({ hydration: { glassesToday: 0, goal: 10 } });
  const settings = makeSettings({
    timer: { preset: 'custom', shortBreakSeconds: 90, snoozeMinutes: 20 },
    widget: { visible: false, alwaysOnTop: false, size: 'small' },
    general: { globalShortcuts: false },
  });
  const { find, actions } = harness({ state, settings });
  assert.equal(find('drink').label, 'Wasser getrunken (0/10)');
  assert.equal(find('undo-drink').enabled, false);
  assert.equal(find('preset-custom').checked, true);
  assert.equal(find('preset-halfhour').checked, false);
  assert.equal(find('break-now-short').label, 'Kurze Pause (1 Min 30 s)');
  assert.deepEqual(find('snooze').submenu.map((i) => i.id), ['snooze-5', 'snooze-10', 'snooze-15', 'snooze-20', 'snooze-30'],
    'configured default is always offered');
  assert.equal(find('widget-visible').checked, false);
  assert.equal(find('widget-on-top').checked, false);
  assert.equal(find('widget-size-small').checked, true);
  assert.equal(find('snooze-20').accelerator, undefined, 'no hints when global shortcuts are disabled');
  assert.equal(find('open-dashboard').accelerator, undefined);
  find('widget-visible').click({ checked: true });
  assert.deepEqual(actions, [['show-widget']]);
});

test('accelerator hints follow the platform shortcut table (§10)', () => {
  const hints = (platform, state = makeState()) => {
    const { find, template } = harness({ platform, state });
    assertPlainTemplate(template);
    return {
      snooze: find('snooze-5').accelerator,
      pause: find('pause-indefinitely') ? find('pause-indefinitely').accelerator : undefined,
      dashboard: find('open-dashboard').accelerator,
    };
  };
  assert.deepEqual(hints('win32'), { snooze: 'Control+Alt+F9', pause: 'Control+Alt+F10', dashboard: 'Control+Alt+F11' });
  assert.deepEqual(hints('darwin'), {
    snooze: 'Control+Alt+Command+S', pause: 'Control+Alt+Command+P', dashboard: 'Control+Alt+Command+D',
  });
  assert.deepEqual(hints('linux'), {
    snooze: 'Control+Shift+Alt+S', pause: 'Control+Shift+Alt+P', dashboard: 'Control+Shift+Alt+D',
  });
  assert.deepEqual(hints('freebsd'), hints('linux'), 'unknown platforms use the Linux table');
  const paused = harness({ platform: 'darwin', state: makeState({ phase: 'paused', pause: { until: null, reason: 'user' } }) });
  assert.equal(paused.find('resume').accelerator, 'Control+Alt+Command+P');

  // only the three global shortcuts carry a hint
  const withHints = [];
  const walk = (items) => items.forEach((item) => {
    if (item.accelerator) withHints.push(item.id);
    if (Array.isArray(item.submenu)) walk(item.submenu);
  });
  walk(harness({ platform: 'linux' }).template);
  assert.deepEqual(withHints.sort(), ['open-dashboard', 'pause-indefinitely', 'snooze-5']);
});

// ---------------------------------------------------------------------------------------------
// updates (§12)

const UPDATE_AVAILABLE = {
  capability: 'manual',
  status: 'available',
  currentVersion: '1.0.0',
  latestVersion: '1.2.0',
  releaseUrl: 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0',
  assetUrl: null,
  assetName: null,
  progress: 0,
  lastCheckAt: 1,
  error: null,
  legacyBuild: false,
  notes: null,
};

test('§12: "Nach Updates suchen" is always there, "Update verfügbar" only with an update', () => {
  const plain = harness();
  assert.equal(plain.find('check-updates').label, 'Nach Updates suchen');
  assert.equal(plain.find('update-available'), null, 'no update, no entry');
  assert.equal(ids(plain.template).indexOf('check-updates'), ids(plain.template).indexOf('open-stats') + 1);

  const { template, find, actions } = harness({ update: UPDATE_AVAILABLE });
  assert.deepEqual(ids(template).slice(-5), ['open-stats', 'update-available', 'check-updates', '---', 'quit']);
  assert.equal(find('update-available').label, 'Update verfügbar: 1.2.0');
  assert.equal(find('update-available').enabled, undefined, 'enabled');
  assertNoSeparatorGlitches(template);
  assertPlainTemplate(template);

  find('check-updates').click();
  find('update-available').click();
  assert.deepEqual(actions, [['check-updates'], ['open-dashboard', 'about']]);

  const en = harness({ update: UPDATE_AVAILABLE, lang: 'en' });
  assert.equal(en.find('check-updates').label, 'Check for updates');
  assert.equal(en.find('update-available').label, 'Update available: 1.2.0');
});

test('§12: the update entries are disabled during a mandatory break', () => {
  const state = strictBreakState();
  const settings = makeSettings({ breaks: { strictMode: true } });
  const { template, find } = harness({ state, settings, update: UPDATE_AVAILABLE });
  assert.equal(find('check-updates').enabled, false);
  assert.equal(find('update-available').enabled, false);
  assert.deepEqual(enabledIds(template), ['drink', 'undo-drink'], 'still only the water entries');
});

test('§12: updateAvailableVersion ignores anything but a real, named update', () => {
  assert.equal(updateAvailableVersion(UPDATE_AVAILABLE), '1.2.0');
  assert.equal(updateAvailableVersion({ ...UPDATE_AVAILABLE, status: 'downloading' }), '1.2.0');
  assert.equal(updateAvailableVersion({ ...UPDATE_AVAILABLE, status: 'ready' }), '1.2.0');
  for (const status of ['idle', 'checking', 'up-to-date', 'error']) {
    assert.equal(updateAvailableVersion({ ...UPDATE_AVAILABLE, status }), null, status);
  }
  for (const version of [null, '', 42, {}, 'x'.repeat(80)]) {
    assert.equal(updateAvailableVersion({ ...UPDATE_AVAILABLE, latestVersion: version }), null, String(version));
  }
  for (const bad of [null, undefined, 'x', 42, []]) assert.equal(updateAvailableVersion(bad), null, String(bad));
  // and the menu simply leaves the entry out
  assert.equal(harness({ update: { status: 'error', error: 'http-403' } }).find('update-available'), null);
});

test('menuSignature reacts to a found update (the Linux tray menu must be rebuilt)', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  const state = makeState();
  const settings = makeSettings();
  const without = menuSignature({ state, settings, t });
  assert.equal(menuSignature({ state, settings, t, update: { status: 'checking' } }), without, 'no visible change');
  assert.notEqual(menuSignature({ state, settings, t, update: UPDATE_AVAILABLE }), without);
});

test('english labels', () => {
  const { find } = harness({ lang: 'en' });
  assert.equal(find('status').label, 'Next break in 12 min (short)');
  assert.equal(find('break-now-short').label, 'Short break (2 min)');
  assert.equal(find('snooze-10').label, '+10 min');
  assert.equal(find('pause').label, 'Meeting mode / Pause');
  assert.equal(find('meeting-auto-detect').label, 'Detect meetings automatically');
  assert.equal(find('quit').label, 'Quit');
});

test('robust against missing state/settings and callbacks', () => {
  const template = buildMenuTemplate({ state: null, settings: null, t: undefined });
  assert.ok(Array.isArray(template));
  assertNoSeparatorGlitches(template);
  assert.equal(findMenuItem(template, 'status').label, 'status.starting');
  assert.equal(findMenuItem(template, 'snooze'), null);
  assert.doesNotThrow(() => findMenuItem(template, 'quit').click());
  assert.doesNotThrow(() => findMenuItem(template, 'lock-screen').click());
  // template must be plain data apart from click callbacks
  assert.doesNotThrow(() => JSON.stringify(template));

  // state without the §9 additions (older scheduler) still yields a usable snooze submenu
  const legacy = makeState();
  delete legacy.meeting;
  legacy.snooze = { count: 0, max: 2 };
  const { find } = harness({ state: legacy, settings: makeSettings({ meeting: undefined }) });
  assert.deepEqual(find('snooze').submenu.map((i) => i.id), ['snooze-5', 'snooze-10', 'snooze-15', 'snooze-30']);
  assert.equal(find('meeting-auto-detect').checked, true);
});

test('buildStatusLine compact variant for the tray tooltip', () => {
  const i18n = createMainI18n(() => 'de', () => 'en-US');
  assert.equal(buildStatusLine({ state: makeState(), t: i18n.t, precision: 'minute', compact: true }), 'Nächste Pause in 12 Min');
  assert.equal(
    buildStatusLine({ state: makeState({ work: { remainingMs: 12 * 60000 + 1 } }), t: i18n.t, precision: 'minute' }),
    'Nächste Pause in 13 Min (kurz)',
  );
  const brk = makeState({ phase: 'break', break: { remainingMs: 61000 } });
  assert.equal(buildStatusLine({ state: brk, t: i18n.t, precision: 'minute', compact: true }), 'Pause läuft – noch 2 Min');
});

test('menuSignature only changes when the menu would change', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  const settings = makeSettings();
  const sig = (state, s = settings) => menuSignature({ state, settings: s, t });
  const a = sig(makeState({ now: NOW, work: { remainingMs: 12 * 60000 - 1000 } }));
  const b = sig(makeState({ now: NOW + 1000, work: { remainingMs: 12 * 60000 - 2000 } }));
  assert.equal(a, b, 'same minute → same signature');
  assert.notEqual(a, sig(makeState({ work: { remainingMs: 10 * 60000 } })), 'minute changed');
  assert.notEqual(a, sig(makeState({ hydration: { glassesToday: 4 } })), 'glasses changed');
  assert.notEqual(a, sig(makeState({ break: { canSnooze: false } })), 'snooze availability changed');
  assert.notEqual(a, sig(makeState({ meeting: { deferred: true } })), 'meeting deferral');
  assert.notEqual(a, sig(makeState(), makeSettings({ widget: { size: 'large' } })), 'settings changed');
  const en = createMainI18n(() => 'en', () => '').t;
  assert.notEqual(a, menuSignature({ state: makeState(), settings, t: en }), 'language changed');
});

// ---------------------------------------------------------------------------------------------
// macOS application menu (§11, review fix M3): AppKit runs the key equivalents of application-menu
// items before before-input-event, so ⌘H & friends must not exist while the lock is up.

test('buildAppMenuTemplate: no application menu outside macOS', () => {
  for (const platform of ['win32', 'linux', 'freebsd', undefined, null, '']) {
    assert.equal(buildAppMenuTemplate({ platform, strictBreak: false }), null, String(platform));
    assert.equal(buildAppMenuTemplate({ platform, strictBreak: true }), null, String(platform));
  }
});

test('buildAppMenuTemplate: the normal macOS menu keeps hide / edit / window / quit', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  const clicks = [];
  const template = buildAppMenuTemplate({
    platform: 'darwin',
    appName: 'AugenPause',
    t,
    strictBreak: false,
    onQuit: () => clicks.push('quit'),
  });
  assert.equal(template.length, 3);
  assert.equal(template[0].label, 'AugenPause');
  const roles = template[0].submenu.map((item) => item.role || item.type || item.id);
  assert.deepEqual(roles, ['about', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'app-quit']);
  // the Edit roles are needed for copy & paste in the dashboard
  assert.deepEqual(template.slice(1).map((item) => item.role), ['editMenu', 'windowMenu']);
  const quit = findMenuItem(template, 'app-quit');
  assert.equal(quit.accelerator, 'Command+Q');
  assert.equal(quit.label, t('menu.quit'));
  quit.click();
  assert.deepEqual(clicks, ['quit'], 'quit goes through main (which blocks it during a mandatory break)');
  // no click target given → no click handler, never a crash
  assert.equal(findMenuItem(buildAppMenuTemplate({ platform: 'darwin' }), 'app-quit').click, undefined);
});

test('buildAppMenuTemplate: a strict break leaves nothing that could hide the lock', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  const template = buildAppMenuTemplate({
    platform: 'darwin',
    appName: 'AugenPause',
    t,
    strictBreak: true,
    onQuit: () => assert.fail('there is no quit item during a mandatory break'),
  });
  assert.equal(template.length, 1, 'only the application menu itself');
  assert.equal(template[0].label, 'AugenPause');
  assert.deepEqual(template[0].submenu, [{ role: 'about' }]);
  const json = JSON.stringify(template);
  for (const forbidden of ['hide', 'hideOthers', 'unhide', 'windowMenu', 'editMenu', 'minimize', 'close', 'quit']) {
    assert.equal(json.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
  assert.equal(json.includes('Command'), false, 'no accelerator at all');
  assert.equal(findMenuItem(template, 'app-quit'), null);
});
