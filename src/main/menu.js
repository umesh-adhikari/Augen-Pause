'use strict';

/**
 * Shared native context menu (tray + widget right-click).
 * PURE: no electron require – returns plain MenuItemConstructorOptions objects with click callbacks.
 *
 *   buildMenuTemplate({ state, settings, t, onAction, onSettings, precision?, platform?, strictBreak?, update? })
 *     update: the §12 update state – adds "Nach Updates suchen" and, while an update is known,
 *             "Update verfügbar: {version}" (opens the dashboard's About page)
 *     precision: 'second' (default, exact countdown for a menu that is popped up right now)
 *              | 'minute' (status text at minute resolution – for long-lived menus such as the Linux tray)
 *     platform:  accelerator hints show this platform's global shortcuts (default process.platform, §10)
 *     strictBreak: main's isStrictBreakActive() (flag captured at break start); when omitted it is derived from
 *                state + settings (phase break && (break.strict || break.canSkip === false || breaks.strictMode))
 *
 * Every item carries a stable `id` (used by tests and handy for main.js).
 * Hidden entries are omitted (not `visible:false`), superfluous separators are removed.
 *
 * Meeting safety (docs/ARCHITECTURE.md §9): during the pre-break warning and during a break the
 * "Pause verschieben" submenu is the first entry after the status line.
 *
 * Mandatory break (§11): during a strict break the status line reads "Pflicht-Pause – noch 1:23" and every
 * actionable item (incl. settings checkboxes, dashboard entries and quit) is disabled – only the water entries
 * (drink / undo-drink, the only actions main accepts then) stay usable.
 *
 *   buildAppMenuTemplate({ platform?, appName?, t?, strictBreak?, onQuit? })  → template | null
 *     The macOS application menu (main.js → Menu.setApplicationMenu). null = no application menu at all
 *     (Windows / Linux). During a strict break the template is reduced to a single inert entry, because
 *     AppKit runs the key equivalents of menu items (⌘H, ⌘M, ⌘W, ⌘Q) BEFORE before-input-event can block
 *     them – an enabled Hide item would hide the break lock (§11 M3).
 */

const {
  formatDurationWith,
  formatClock,
  formatTimeOfDay,
} = require('./i18n');
const { shortcutsFor } = require('./shortcuts'); // constants only – electron is required lazily there

/** Display values for the preset radio items (see docs/ARCHITECTURE.md §2). */
const PRESET_INFO = Object.freeze([
  { id: 'halfhour', workMinutes: 30, shortBreakSeconds: 120 },
  { id: 'hourly', workMinutes: 60, shortBreakSeconds: 300 },
  { id: '20-20-20', workMinutes: 20, shortBreakSeconds: 20 },
  { id: 'pomodoro', workMinutes: 25, shortBreakSeconds: 300 },
]);

/** "Meeting-Modus / Pausieren" entries → action 'pause' with this argument. */
const PAUSE_OPTIONS = Object.freeze([
  { id: 'pause-30', key: 'menu.pause30', arg: 30 },
  { id: 'pause-60', key: 'menu.pause60', arg: 60 },
  { id: 'pause-120', key: 'menu.pause120', arg: 120 },
  { id: 'pause-tomorrow', key: 'menu.pauseTomorrow', arg: 'tomorrow' },
  { id: 'pause-indefinitely', key: 'menu.pauseIndefinitely', arg: null },
]);

const DEFAULT_SNOOZE_OPTIONS = Object.freeze([5, 10, 15, 30]);

const WIDGET_SIZE_KEYS = Object.freeze(['small', 'medium', 'large']);

const DAY_MS = 24 * 60 * 60 * 1000;

function identityT(key) {
  return String(key);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function breakTypeOf(state) {
  return state && state.break && state.break.type === 'long' ? 'long' : 'short';
}

function remainingWorkMs(state) {
  const work = (state && state.work) || {};
  if (Number.isFinite(work.remainingMs)) return work.remainingMs;
  if (Number.isFinite(work.endsAt)) return Math.max(0, work.endsAt - num(state.now, Date.now()));
  return 0;
}

function remainingBreakMs(state) {
  const brk = (state && state.break) || {};
  if (Number.isFinite(brk.remainingMs)) return brk.remainingMs;
  if (Number.isFinite(brk.endsAt)) return Math.max(0, brk.endsAt - num(state.now, Date.now()));
  return 0;
}

function localDayIndex(ts) {
  const d = new Date(ts);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
}

function pausedStatus(state, t) {
  const until = state.pause && Number.isFinite(state.pause.until) ? state.pause.until : null;
  if (until === null) return t('status.paused');
  const now = num(state.now, Date.now());
  const time = formatTimeOfDay(until);
  const dayDiff = localDayIndex(until) - localDayIndex(now);
  if (dayDiff <= 0) return t('status.pausedUntil', { time });
  if (dayDiff === 1) return t('status.pausedUntilTomorrow', { time });
  return t('status.pausedUntilDay', { day: t(`weekday.${new Date(until).getDay()}`), time });
}

function isMeetingDeferred(state) {
  return Boolean(state && state.meeting && state.meeting.deferred === true);
}

/**
 * Snooze minutes offered in the submenu: state.snooze.options (fallback 5/10/15/30) plus the
 * configured default (so the global snooze shortcut hint always has a matching entry). Sorted, unique, 1..60.
 */
function snoozeOptions(state, defaultMinutes) {
  const raw = state && state.snooze && Array.isArray(state.snooze.options) && state.snooze.options.length > 0
    ? state.snooze.options
    : DEFAULT_SNOOZE_OPTIONS;
  const set = new Set();
  for (const value of [...raw, defaultMinutes]) {
    const n = Math.round(Number(value));
    if (Number.isFinite(n) && n >= 1 && n <= 60) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Human readable status line, e.g. "Nächste Pause in 12 Min (kurz)".
 * @param {{ state: any, t?: Function, precision?: 'second'|'minute', compact?: boolean, strict?: boolean }} options
 *   compact: omit the break type ("Nächste Pause in 12 Min") – used for the tray tooltip.
 *   strict:  a mandatory break runs → "Pflicht-Pause – noch 1:23" (§11)
 */
function buildStatusLine({ state, t = identityT, precision = 'second', compact = false, strict = false } = {}) {
  if (!state || typeof state !== 'object') return t('status.starting');
  const minuteRes = precision === 'minute';
  switch (state.phase) {
    case 'work': {
      if (isMeetingDeferred(state)) return t('status.meetingDeferred');
      const ms = remainingWorkMs(state);
      if (state.warning === true) {
        const time = minuteRes ? formatDurationWith(t, ms, 'countdown-minutes') : formatClock(ms);
        return t('status.warning', { time });
      }
      const time = formatDurationWith(t, ms, minuteRes ? 'countdown-minutes' : 'countdown');
      return compact
        ? t('status.nextBreakCompact', { time })
        : t('status.nextBreak', { time, type: t(`breakTypeAdj.${breakTypeOf(state)}`) });
    }
    case 'break': {
      const ms = remainingBreakMs(state);
      const time = minuteRes ? formatDurationWith(t, ms, 'countdown-minutes') : formatClock(ms);
      if (strict) return t('status.strictBreakRunning', { time });
      return compact
        ? t('status.breakRunningCompact', { time })
        : t('status.breakRunning', { time, type: t(`breakType.${breakTypeOf(state)}`) });
    }
    case 'paused':
      return pausedStatus(state, t);
    case 'away':
      return t('status.away');
    case 'off-hours':
      return t('status.offHours');
    default:
      return t('status.starting');
  }
}

/** Items that stay usable during a strict break (main's performAction allows exactly these actions). */
const STRICT_BREAK_ENABLED_IDS = Object.freeze(['drink', 'undo-drink']);

/**
 * §12: version of a found update, or null when there is none to point at.
 * @param {{ status?: string, latestVersion?: string }|null} update the update state (see §12)
 */
function updateAvailableVersion(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.status !== 'available' && update.status !== 'downloading' && update.status !== 'ready') return null;
  const version = update.latestVersion;
  return typeof version === 'string' && version.length > 0 && version.length <= 64 ? version : null;
}

/** Disables an item and its whole submenu (some Linux menu hosts ignore a disabled parent). */
function disableDeep(item) {
  if (!item || item.type === 'separator') return;
  item.enabled = false;
  if (Array.isArray(item.submenu)) item.submenu.forEach(disableDeep);
}

/** Whether a strict (mandatory) break runs, derived from state + settings (used when main passes no flag). */
function deriveStrictBreak(state, settings) {
  if (!state || typeof state !== 'object' || state.phase !== 'break') return false;
  const breaks = (settings && settings.breaks) || {};
  const brk = state.break || {};
  return breaks.strictMode === true || brk.strict === true || brk.canSkip === false;
}

/** Remove leading/trailing/double separators (recursively for submenus). */
function compactTemplate(items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue;
      out.push(item);
      continue;
    }
    if (Array.isArray(item.submenu)) item.submenu = compactTemplate(item.submenu);
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function checkedAfterClick(menuItem, current) {
  return menuItem && typeof menuItem.checked === 'boolean' ? menuItem.checked : !current;
}

/**
 * @param {{
 *   state: object|null, settings: object|null, t: (key: string, vars?: object) => string,
 *   onAction: (name: string, arg?: any) => any, onSettings: (patch: object) => any,
 *   precision?: 'second'|'minute', platform?: string, strictBreak?: boolean, update?: object|null
 * }} options
 * @returns {object[]} Electron MenuItemConstructorOptions[]
 */
function buildMenuTemplate({
  state, settings, t, onAction, onSettings, precision = 'second', platform = process.platform,
  strictBreak: strictOverride, update = null,
} = {}) {
  const tr = typeof t === 'function' ? t : identityT;
  const act = (name, arg) => {
    if (typeof onAction !== 'function') return;
    if (arg === undefined) onAction(name);
    else onAction(name, arg);
  };
  const patch = (p) => {
    if (typeof onSettings === 'function') onSettings(p);
  };

  const s = settings && typeof settings === 'object' ? settings : {};
  const timer = s.timer || {};
  const breaks = s.breaks || {};
  const hydration = s.hydration || {};
  const widget = s.widget || {};
  const general = s.general || {};
  const meeting = s.meeting || {};

  const st = state && typeof state === 'object' ? state : null;
  const phase = st ? st.phase : null;
  const inBreak = phase === 'break';
  const brk = (st && st.break) || {};
  const strict = breaks.strictMode === true;
  const strictBreak = typeof strictOverride === 'boolean' ? inBreak && strictOverride : deriveStrictBreak(st, s);
  const warning = phase === 'work' && st.warning === true && !isMeetingDeferred(st);

  // Display-only hints for the registered global shortcuts: snooze, pause/resume, dashboard (§10).
  const keys = shortcutsFor(platform);
  const showHints = general.globalShortcuts !== false;
  const hint = (accelerator) => (showHints && accelerator ? { accelerator, registerAccelerator: false } : {});

  const shortMs = num(timer.shortBreakSeconds, 120) * 1000;
  const longMs = num(timer.longBreakSeconds, 600) * 1000;

  const items = [];

  // status line
  items.push({ id: 'status', label: buildStatusLine({ state: st, t: tr, precision, strict: strictBreak }), enabled: false });
  items.push({ type: 'separator' });

  // snooze submenu (phase work + break) – first entry during warning / break
  let snoozeItem = null;
  if (phase === 'work' || inBreak) {
    const defaultMinutes = Math.min(60, Math.max(1, Math.round(num(timer.snoozeMinutes, 5))));
    snoozeItem = {
      id: 'snooze',
      label: tr('menu.snooze'),
      enabled: brk.canSnooze === true,
      submenu: snoozeOptions(st, defaultMinutes).map((minutes) => ({
        id: `snooze-${minutes}`,
        label: tr('menu.snoozeBy', { duration: formatDurationWith(tr, minutes * 60000) }),
        ...(minutes === defaultMinutes ? hint(keys.snooze) : {}),
        click: () => act('snooze', minutes),
      })),
    };
  }
  const snoozeFirst = warning || inBreak;
  if (snoozeItem && snoozeFirst) items.push(snoozeItem);

  // break now (hidden during a break)
  if (!inBreak) {
    items.push({
      id: 'break-now',
      label: tr('menu.breakNow'),
      submenu: [
        {
          id: 'break-now-short',
          label: tr('menu.breakShort', { duration: formatDurationWith(tr, shortMs, 'exact') }),
          click: () => act('break-now', 'short'),
        },
        {
          id: 'break-now-long',
          label: tr('menu.breakLong', { duration: formatDurationWith(tr, longMs, 'exact') }),
          click: () => act('break-now', 'long'),
        },
      ],
    });
  }
  if (snoozeItem && !snoozeFirst) items.push(snoozeItem);

  // skip / end / reset
  if (phase === 'work') {
    items.push({
      id: 'skip-break',
      label: tr('menu.skipNext'),
      enabled: brk.canSkip !== false,
      click: () => act('skip-break'),
    });
    items.push({ id: 'reset-timer', label: tr('menu.resetTimer'), click: () => act('reset-timer') });
  } else if (inBreak) {
    items.push({
      id: 'end-break',
      label: tr('menu.endBreak'),
      enabled: brk.canSkip === true,
      click: () => act('skip-break'),
    });
  }
  items.push({ type: 'separator' });

  // meeting mode / pause – or resume
  if (phase === 'paused') {
    items.push({ id: 'resume', label: tr('menu.resume'), ...hint(keys.pauseToggle), click: () => act('resume') });
  } else {
    items.push({
      id: 'pause',
      label: tr('menu.meetingMode'),
      // Strict mode must not be bypassed by pausing – not even during the grace period (the scheduler rejects
      // pause there, §10). Getting out of the way for a meeting stays possible via "Pause verschieben".
      enabled: !strictBreak,
      submenu: PAUSE_OPTIONS.map((opt) => ({
        id: opt.id,
        label: tr(opt.key),
        ...(opt.arg === null ? hint(keys.pauseToggle) : {}),
        click: () => act('pause', opt.arg),
      })),
    });
  }
  const autoDetect = meeting.autoDetect !== false;
  items.push({
    id: 'meeting-auto-detect',
    type: 'checkbox',
    label: tr('menu.meetingAutoDetect'),
    checked: autoDetect,
    click: (menuItem) => patch({ meeting: { autoDetect: checkedAfterClick(menuItem, autoDetect) } }),
  });
  items.push({ type: 'separator' });

  // hydration
  if (hydration.enabled === true) {
    const glasses = Math.max(0, Math.round(num(st && st.hydration && st.hydration.glassesToday,
      num(st && st.today && st.today.glasses, 0))));
    const goal = Math.max(1, Math.round(num(st && st.hydration && st.hydration.goal, num(hydration.dailyGoalGlasses, 8))));
    items.push({
      id: 'drink',
      label: tr('menu.drink', { glasses, goal }),
      click: () => act('drink'),
    });
    items.push({
      id: 'undo-drink',
      label: tr('menu.undoDrink'),
      enabled: glasses > 0,
      click: () => act('undo-drink'),
    });
    items.push({ type: 'separator' });
  }

  // interval presets
  const preset = typeof timer.preset === 'string' ? timer.preset : 'halfhour';
  items.push({
    id: 'interval',
    label: tr('menu.interval'),
    submenu: [
      ...PRESET_INFO.map((p) => ({
        id: `preset-${p.id}`,
        type: 'radio',
        label: tr('menu.presetLabel', {
          name: tr(`preset.${p.id}`),
          work: formatDurationWith(tr, p.workMinutes * 60000, 'exact'),
          break: formatDurationWith(tr, p.shortBreakSeconds * 1000, 'exact'),
        }),
        checked: preset === p.id,
        click: () => {
          if (preset !== p.id) patch({ timer: { preset: p.id } });
        },
      })),
      { type: 'separator' },
      {
        id: 'preset-custom',
        type: 'radio',
        label: tr('preset.custom'),
        checked: preset === 'custom',
        click: () => act('open-dashboard', 'settings'),
      },
    ],
  });

  // break behaviour
  const lockScreen = breaks.lockScreen !== false;
  items.push({
    id: 'lock-screen',
    type: 'checkbox',
    label: tr('menu.lockScreen'),
    checked: lockScreen,
    click: (menuItem) => patch({ breaks: { lockScreen: checkedAfterClick(menuItem, lockScreen) } }),
  });
  items.push({
    id: 'strict-mode',
    type: 'checkbox',
    label: tr('menu.strictMode'),
    checked: strict,
    enabled: !inBreak, // the mode of a running break is fixed (§11)
    click: (menuItem) => patch({ breaks: { strictMode: checkedAfterClick(menuItem, strict) } }),
  });

  // widget
  const widgetVisible = widget.visible !== false;
  const alwaysOnTop = widget.alwaysOnTop !== false;
  const size = WIDGET_SIZE_KEYS.includes(widget.size) ? widget.size : 'medium';
  items.push({
    id: 'widget',
    label: tr('menu.widget'),
    submenu: [
      {
        id: 'widget-visible',
        type: 'checkbox',
        label: tr('menu.widgetShow'),
        checked: widgetVisible,
        click: (menuItem) => act(checkedAfterClick(menuItem, widgetVisible) ? 'show-widget' : 'hide-widget'),
      },
      {
        id: 'widget-on-top',
        type: 'checkbox',
        label: tr('menu.widgetOnTop'),
        checked: alwaysOnTop,
        click: (menuItem) => patch({ widget: { alwaysOnTop: checkedAfterClick(menuItem, alwaysOnTop) } }),
      },
      {
        id: 'widget-size',
        label: tr('menu.widgetSize'),
        submenu: WIDGET_SIZE_KEYS.map((key) => ({
          id: `widget-size-${key}`,
          type: 'radio',
          label: tr(`menu.size.${key}`),
          checked: size === key,
          click: () => {
            if (size !== key) patch({ widget: { size: key } });
          },
        })),
      },
      { type: 'separator' },
      {
        id: 'widget-reset-position',
        label: tr('menu.widgetResetPosition'),
        click: () => act('reset-widget-position'),
      },
    ],
  });

  // hydration reminder toggle
  const hydrationEnabled = hydration.enabled === true;
  items.push({
    id: 'hydration',
    type: 'checkbox',
    label: tr('menu.hydration'),
    checked: hydrationEnabled,
    click: (menuItem) => patch({ hydration: { enabled: checkedAfterClick(menuItem, hydrationEnabled) } }),
  });
  items.push({ type: 'separator' });

  // dashboard
  items.push({
    id: 'open-dashboard',
    label: tr('menu.openDashboard'),
    ...hint(keys.dashboard),
    click: () => act('open-dashboard', 'overview'),
  });
  items.push({ id: 'open-settings', label: tr('menu.settings'), click: () => act('open-dashboard', 'settings') });
  items.push({ id: 'open-stats', label: tr('menu.stats'), click: () => act('open-dashboard', 'stats') });

  // updates (§12) – the "Update verfügbar" line only exists while there is one, and it is the entry
  // that stands out (first of the update group, with the version in the label); it opens the About page.
  const updateVersion = updateAvailableVersion(update);
  if (updateVersion !== null) {
    items.push({
      id: 'update-available',
      label: tr('menu.updateAvailable', { version: updateVersion }),
      click: () => act('open-dashboard', 'about'),
    });
  }
  items.push({ id: 'check-updates', label: tr('menu.checkUpdates'), click: () => act('check-updates') });
  items.push({ type: 'separator' });

  // quit
  items.push({ id: 'quit', label: tr('menu.quit'), enabled: !strictBreak, click: () => act('quit') });

  if (strictBreak) {
    for (const item of items) {
      if (item.id !== 'status' && !STRICT_BREAK_ENABLED_IDS.includes(item.id)) disableDeep(item);
    }
  }
  return compactTemplate(items);
}

/**
 * Cheap fingerprint of everything that influences the template (except click targets).
 * The tray rebuilds its long-lived (Linux) menu only when this string changes.
 */
function menuSignature({ state, settings, t, precision = 'minute', strictBreak, update = null } = {}) {
  const tr = typeof t === 'function' ? t : identityT;
  const st = state && typeof state === 'object' ? state : {};
  const s = settings && typeof settings === 'object' ? settings : {};
  const timer = s.timer || {};
  const breaks = s.breaks || {};
  const hydration = s.hydration || {};
  const widget = s.widget || {};
  const brk = st.break || {};
  const hyd = st.hydration || {};
  const strict = typeof strictBreak === 'boolean' ? st.phase === 'break' && strictBreak : deriveStrictBreak(state, settings);
  return JSON.stringify([
    tr('menu.quit'), // language
    strict,
    buildStatusLine({ state, t: tr, precision, strict }),
    st.phase, st.warning, brk.type, brk.canSnooze, brk.canSkip, brk.inGrace,
    st.snooze && st.snooze.options, st.meeting && st.meeting.deferred,
    hyd.glassesToday, hyd.goal, st.today && st.today.glasses,
    timer.preset, timer.shortBreakSeconds, timer.longBreakSeconds, timer.snoozeMinutes,
    breaks.lockScreen, breaks.strictMode,
    hydration.enabled, hydration.dailyGoalGlasses,
    widget.visible, widget.alwaysOnTop, widget.size,
    s.general && s.general.globalShortcuts,
    s.meeting && s.meeting.autoDetect,
    updateAvailableVersion(update), // §12
  ]);
}

/**
 * macOS application menu (§11 M3). On every other platform there is no application menu at all
 * (`null` → Menu.setApplicationMenu(null), which also drops Electron's default accelerators).
 *
 * AppKit dispatches the key equivalents of application-menu items before the renderer's
 * before-input-event fires, so ⌘H / ⌘⌥H / ⌘M / ⌘W / ⌘Q cannot be swallowed by the overlay –
 * they have to be absent from the menu. During a strict break the menu is therefore reduced to
 * the (inert) About entry: no hide / hideOthers / unhide, no windowMenu, no editMenu, no quit.
 * The full menu – including the Edit roles needed for copy & paste – comes back at break end.
 *
 * @param {{ platform?: string, appName?: string, t?: (key: string) => string,
 *           strictBreak?: boolean, onQuit?: () => void }} [options]
 * @returns {object[]|null} MenuItemConstructorOptions template, or null for "no application menu"
 */
function buildAppMenuTemplate({
  platform = process.platform,
  appName = 'AugenPause',
  t = identityT,
  strictBreak = false,
  onQuit = null,
} = {}) {
  if (platform !== 'darwin') return null;
  const label = appName || 'AugenPause';
  if (strictBreak === true) return [{ label, submenu: [{ role: 'about' }] }];
  return [
    {
      label,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          id: 'app-quit',
          label: t('menu.quit'),
          accelerator: 'Command+Q',
          click: typeof onQuit === 'function' ? onQuit : undefined,
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}

/** Depth-first search for a template item by id (tests / main.js convenience). */
function findMenuItem(template, id) {
  for (const item of template || []) {
    if (item && item.id === id) return item;
    if (item && Array.isArray(item.submenu)) {
      const found = findMenuItem(item.submenu, id);
      if (found) return found;
    }
  }
  return null;
}

module.exports = {
  buildMenuTemplate,
  buildAppMenuTemplate,
  buildStatusLine,
  menuSignature,
  findMenuItem,
  deriveStrictBreak,
  updateAvailableVersion,
  STRICT_BREAK_ENABLED_IDS,
  PRESET_INFO,
  DEFAULT_SNOOZE_OPTIONS,
};
