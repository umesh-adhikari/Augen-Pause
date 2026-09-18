'use strict';

/**
 * Global keyboard shortcuts (docs/ARCHITECTURE.md §10).
 *
 *   registerShortcuts({ enabled, onAction, getState, isStrictBreak?, platform? }) → { registered: string[], failed: string[] }
 *   unregisterShortcuts()
 *   shortcutLabel(action, platform, lang) → 'Strg+Alt+F9' | 'Ctrl+Shift+Alt+S' | '⌃⌥⌘S' | ''
 *   shortcutKeys(action, platform, lang)  → ['Strg', 'Alt', 'F9'] (display tokens)
 *
 * Only three shortcuts exist – break-now and drink are deliberately NOT global:
 *
 *   action        Windows          macOS                   Linux
 *   snooze        Control+Alt+F9   Control+Alt+Command+S   Control+Shift+Alt+S   (default minutes; no-op in a mandatory break)
 *   pauseToggle   Control+Alt+F10  Control+Alt+Command+P   Control+Shift+Alt+P   (pause indefinitely / resume)
 *   dashboard     Control+Alt+F11  Control+Alt+Command+D   Control+Shift+Alt+D   (show / hide dashboard)
 *
 * Why not Ctrl+Alt+<letter>: on Windows that is AltGr (breaks typing `{`, `|`, `ś` …) and collides with IDE
 * shortcuts; Ctrl+Alt+F<n> switches virtual terminals on Linux.
 * The renderer copy in src/renderer/shared/shortcuts.js must stay identical (test/shortcuts.test.js).
 *
 * Only this module's own accelerators are (un)registered – never globalShortcut.unregisterAll().
 * `electron` is required lazily so that menu.js can import SHORTCUTS without pulling in Electron.
 */

const SHORTCUTS = Object.freeze({
  win32: Object.freeze({
    snooze: 'Control+Alt+F9',
    pauseToggle: 'Control+Alt+F10',
    dashboard: 'Control+Alt+F11',
  }),
  darwin: Object.freeze({
    snooze: 'Control+Alt+Command+S',
    pauseToggle: 'Control+Alt+Command+P',
    dashboard: 'Control+Alt+Command+D',
  }),
  linux: Object.freeze({
    snooze: 'Control+Shift+Alt+S',
    pauseToggle: 'Control+Shift+Alt+P',
    dashboard: 'Control+Shift+Alt+D',
  }),
});

/** Action names (§5) that map onto a shortcut table key. */
const ACTION_ALIASES = Object.freeze({
  snooze: 'snooze',
  pause: 'pauseToggle',
  resume: 'pauseToggle',
  pauseToggle: 'pauseToggle',
  'toggle-dashboard': 'dashboard',
  'open-dashboard': 'dashboard',
  dashboard: 'dashboard',
});

const MAC_SYMBOLS = Object.freeze({ Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' });
const KEY_NAMES = Object.freeze({
  de: Object.freeze({ Control: 'Strg', Shift: 'Umschalt', Alt: 'Alt', Command: 'Cmd' }),
  en: Object.freeze({ Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Command: 'Cmd' }),
});

/** Ignore auto-repeat / accidental double presses within this window. */
const REPEAT_GUARD_MS = 500;

let ownAccelerators = [];

/** Shortcut table for a platform (unknown platforms use the Linux table). */
function shortcutsFor(platform = process.platform) {
  return Object.prototype.hasOwnProperty.call(SHORTCUTS, platform) ? SHORTCUTS[platform] : SHORTCUTS.linux;
}

function tableKey(action) {
  return typeof action === 'string' && Object.prototype.hasOwnProperty.call(ACTION_ALIASES, action)
    ? ACTION_ALIASES[action]
    : null;
}

/** Accelerator string for an action on a platform, or null. */
function acceleratorFor(action, platform = process.platform) {
  const key = tableKey(action);
  return key ? shortcutsFor(platform)[key] : null;
}

/**
 * Display tokens, e.g. ['Strg', 'Alt', 'F9'] (de, Windows), ['Ctrl', 'Shift', 'Alt', 'S'] (en, Linux),
 * ['⌃', '⌥', '⌘', 'S'] (macOS). Empty array for unknown actions.
 */
function shortcutKeys(action, platform = process.platform, lang = 'de') {
  const accelerator = acceleratorFor(action, platform);
  if (!accelerator) return [];
  const mac = platform === 'darwin';
  const names = KEY_NAMES[lang] || KEY_NAMES.en;
  return accelerator.split('+').map((token) => (mac ? MAC_SYMBOLS[token] : names[token]) || token);
}

/** 'Strg+Alt+F9' (de) · 'Ctrl+Shift+Alt+S' (en) · '⌃⌥⌘S' (macOS). Empty string for unknown actions. */
function shortcutLabel(action, platform = process.platform, lang = 'de') {
  const keys = shortcutKeys(action, platform, lang);
  return platform === 'darwin' ? keys.join('') : keys.join('+');
}

function getGlobalShortcut() {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  return electron && typeof electron === 'object' ? electron.globalShortcut : undefined;
}

function safeDispatch(onAction, name, arg) {
  try {
    let result;
    if (typeof onAction === 'function') result = onAction(name, arg, 'shortcut');
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('[shortcuts] action failed:', name, err && err.message));
    }
  } catch (err) {
    console.warn('[shortcuts] action failed:', name, err && err.message);
  }
}

function currentPhase(getState) {
  try {
    const state = typeof getState === 'function' ? getState() : null;
    return state && typeof state.phase === 'string' ? state.phase : null;
  } catch {
    return null;
  }
}

function strictBreakRunning(isStrictBreak) {
  try {
    return typeof isStrictBreak === 'function' && isStrictBreak() === true;
  } catch {
    return false; // main's performAction still rejects everything during a strict break
  }
}

/**
 * Handlers per shortcut table key. Exported for tests (no Electron needed).
 * During a mandatory break (§11, isStrictBreak() true) every handler is a no-op: nothing is dispatched, so no
 * dashboard / focus side effects can happen (main's performAction would reject the actions anyway).
 * @param {{ onAction?: Function, getState?: Function, isStrictBreak?: () => boolean }} options
 * @returns {Record<'snooze'|'pauseToggle'|'dashboard', () => void>}
 */
function createHandlers({ onAction, getState, isStrictBreak } = {}) {
  const unlessStrict = (fn) => () => {
    if (strictBreakRunning(isStrictBreak)) return;
    fn();
  };
  return {
    snooze: unlessStrict(() => safeDispatch(onAction, 'snooze', undefined)),
    pauseToggle: unlessStrict(() => {
      if (currentPhase(getState) === 'paused') safeDispatch(onAction, 'resume', undefined);
      else safeDispatch(onAction, 'pause', null);
    }),
    dashboard: unlessStrict(() => safeDispatch(onAction, 'toggle-dashboard', undefined)),
  };
}

function unregisterShortcuts() {
  const accelerators = ownAccelerators;
  ownAccelerators = [];
  if (accelerators.length === 0) return;
  let globalShortcut;
  try {
    globalShortcut = getGlobalShortcut();
  } catch {
    return;
  }
  if (!globalShortcut) return;
  for (const accelerator of accelerators) {
    try {
      globalShortcut.unregister(accelerator);
    } catch (err) {
      console.warn('[shortcuts] unregister failed:', accelerator, err && err.message);
    }
  }
}

/**
 * @param {{
 *   enabled: boolean,
 *   onAction: (name: string, arg: any, source: 'shortcut') => any,
 *   getState: () => any,
 *   isStrictBreak?: () => boolean,
 *   platform?: string,
 * }} options
 * @returns {{ registered: string[], failed: string[] }}
 */
function registerShortcuts({ enabled, onAction, getState, isStrictBreak, platform = process.platform } = {}) {
  unregisterShortcuts();
  const result = { registered: [], failed: [] };
  if (!enabled) return result;

  let globalShortcut;
  try {
    globalShortcut = getGlobalShortcut();
  } catch (err) {
    console.warn('[shortcuts] globalShortcut unavailable:', err && err.message);
  }

  const table = shortcutsFor(platform);
  const handlers = createHandlers({ onAction, getState, isStrictBreak });

  for (const key of Object.keys(table)) {
    const accelerator = table[key];
    const handler = handlers[key];
    let lastFired = 0;
    const guarded = () => {
      const now = Date.now();
      if (now - lastFired < REPEAT_GUARD_MS) return;
      lastFired = now;
      handler();
    };
    let ok = false;
    if (globalShortcut) {
      try {
        ok = globalShortcut.register(accelerator, guarded) === true;
      } catch (err) {
        console.warn('[shortcuts] register failed:', accelerator, err && err.message);
        ok = false;
      }
    }
    if (ok) result.registered.push(accelerator);
    else result.failed.push(accelerator);
  }

  ownAccelerators = result.registered.slice();
  if (result.failed.length > 0) {
    console.warn('[shortcuts] not available (used by another app?):', result.failed.join(', '));
  }
  return result;
}

module.exports = {
  SHORTCUTS,
  shortcutsFor,
  acceleratorFor,
  shortcutKeys,
  shortcutLabel,
  createHandlers,
  registerShortcuts,
  unregisterShortcuts,
};
