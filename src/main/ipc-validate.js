'use strict';

/**
 * Pure (electron-free) IPC sender + payload validation (docs/ARCHITECTURE.md §5).
 * Used by ipc.js and main.js, unit-tested in test/ipc-validation.test.js.
 * Strict-break (Pflicht-Pause) decisions live in strict-guard.js (§11).
 */

const { IPC, ACTIONS, DASHBOARD_TABS } = require('./constants');
const { isAppUrl } = require('./protocol-path');

const VIEWS = Object.freeze(['widget', 'dashboard', 'overlay']);
const ALL_VIEWS = VIEWS;

/** Actions an overlay (break screen) may trigger. */
const OVERLAY_ACTIONS = Object.freeze(['skip-break', 'snooze', 'drink', 'undo-drink']);

/**
 * §12: the update actions belong to the About page – only the dashboard may use them.
 * The widget has no update UI and the break screen must not start a download or a quit-and-install.
 */
const DASHBOARD_ONLY_ACTIONS = Object.freeze(['check-updates', 'download-update', 'install-update', 'open-release-page']);

/**
 * Which views may use which channel (§10: the break overlay only reads the snapshot and triggers its
 * allowlisted actions – no settings writes, no stats reads, no resets).
 */
const CHANNEL_VIEWS = Object.freeze({
  [IPC.GET_SNAPSHOT]: ALL_VIEWS,
  [IPC.UPDATE_SETTINGS]: Object.freeze(['widget', 'dashboard']),
  [IPC.RESET_SETTINGS]: Object.freeze(['dashboard']),
  [IPC.GET_STATS]: Object.freeze(['widget', 'dashboard']),
  [IPC.RESET_STATS]: Object.freeze(['dashboard']),
  [IPC.ACTION]: ALL_VIEWS,
  [IPC.CONTEXT_MENU]: Object.freeze(['widget', 'dashboard']),
  [IPC.WIDGET_DRAG]: Object.freeze(['widget']),
  [IPC.WIDGET_INTERACTIVE]: Object.freeze(['widget']),
});

const DRAG_PHASES = Object.freeze(['start', 'move', 'end']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PATCH_DEPTH = 4;
const MAX_PATCH_JSON = 16 * 1024;
const MAX_PATCH_NODES = 1000;

const has = (list, value) => list.includes(value);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * View name for a sender frame URL, or null when the URL is not a trusted app page.
 * Accepts app://augenpause/<view>/… only.
 * @param {unknown} url
 * @returns {'widget'|'dashboard'|'overlay'|null}
 */
function viewFromUrl(url) {
  if (!isAppUrl(url)) return null;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/([a-z]+)\//.exec(pathname);
  if (!match || !has(VIEWS, match[1])) return null;
  return match[1];
}

/** @returns {boolean} */
function isChannelAllowedForView(channel, view) {
  const allowed = Object.prototype.hasOwnProperty.call(CHANNEL_VIEWS, channel) ? CHANNEL_VIEWS[channel] : null;
  return Boolean(allowed && has(allowed, view));
}

/** @returns {boolean} */
function isActionAllowedForView(name, view) {
  if (!has(ACTIONS, name)) return false;
  if (view === 'dashboard') return true;
  if (view === 'widget') return !has(DASHBOARD_ONLY_ACTIONS, name);
  if (view === 'overlay') return has(OVERLAY_ACTIONS, name);
  return false;
}

/**
 * Validate + normalise an action call.
 * @returns {{ ok: true, name: string, arg: any } | { ok: false, error: string }}
 */
function validateAction(name, arg) {
  if (typeof name !== 'string' || !has(ACTIONS, name)) return { ok: false, error: 'unknown-action' };
  const bad = () => ({ ok: false, error: `invalid-arg:${name}` });
  const none = arg === undefined || arg === null;

  switch (name) {
    case 'break-now':
      if (none) return { ok: true, name, arg: undefined };
      return arg === 'short' || arg === 'long' ? { ok: true, name, arg } : bad();
    case 'snooze':
      // minutes int 1..60 | undefined (§9: overlay offers 5/10/15/30, default = timer.snoozeMinutes)
      if (none) return { ok: true, name, arg: undefined };
      return isInt(arg, 1, 60) ? { ok: true, name, arg } : bad();
    case 'pause':
      // null (or omitted) = pause indefinitely
      if (none) return { ok: true, name, arg: null };
      return isInt(arg, 1, 1440) || arg === 'tomorrow' ? { ok: true, name, arg } : bad();
    case 'open-dashboard':
      if (none) return { ok: true, name, arg: undefined };
      return typeof arg === 'string' && has(DASHBOARD_TABS, arg) ? { ok: true, name, arg } : bad();
    default:
      // actions without an argument: any extra argument is dropped
      return { ok: true, name, arg: undefined };
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkValue(value, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_PATCH_NODES) return 'patch too large';
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return value.length > MAX_PATCH_JSON ? 'patch too large' : null;
  if (type === 'boolean') return null;
  if (type === 'number') return Number.isFinite(value) ? null : 'non-finite number';
  if (type !== 'object') return `unsupported type ${type}`;
  if (depth >= MAX_PATCH_DEPTH) return 'patch too deep';
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return 'unsupported array';
    if (value.length > MAX_PATCH_NODES) return 'patch too large';
    for (const item of value) {
      const err = checkValue(item, depth + 1, budget);
      if (err) return err;
    }
    return null;
  }
  if (!isPlainObject(value)) return 'unsupported object';
  return checkObject(value, depth + 1, budget);
}

function checkObject(obj, depth, budget) {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string') return 'symbol key';
    if (FORBIDDEN_KEYS.has(key)) return `forbidden key ${key}`;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !('value' in desc)) return 'accessor property';
    const err = checkValue(desc.value, depth, budget);
    if (err) return err;
  }
  return null;
}

/**
 * Structural validation of an untrusted settings patch (deep sanitising is done by settingsStore.update).
 * Plain object, depth ≤ 4 (top-level object = depth 1), no __proto__/constructor/prototype keys, JSON ≤ 16 KB
 * (plus a node budget so huge arrays are rejected before they are walked or serialised).
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) return { ok: false, error: 'patch must be a plain object' };
  const err = checkObject(patch, 1, { nodes: 0 });
  if (err) return { ok: false, error: err };
  let json;
  try {
    json = JSON.stringify(patch);
  } catch {
    return { ok: false, error: 'patch not serialisable' };
  }
  if (json.length > MAX_PATCH_JSON) return { ok: false, error: 'patch too large' };
  return { ok: true };
}

/** getStats(days): int 1..400 */
function validateStatsDays(days) {
  return isInt(days, 1, 400) ? { ok: true, days } : { ok: false, error: 'days must be an integer 1..400' };
}

function validateDragPhase(phase) {
  return typeof phase === 'string' && has(DRAG_PHASES, phase);
}

function validateInteractive(value) {
  return typeof value === 'boolean';
}

module.exports = {
  VIEWS,
  OVERLAY_ACTIONS,
  DASHBOARD_ONLY_ACTIONS,
  CHANNEL_VIEWS,
  DRAG_PHASES,
  MAX_PATCH_DEPTH,
  MAX_PATCH_JSON,
  MAX_PATCH_NODES,
  viewFromUrl,
  isChannelAllowedForView,
  isActionAllowedForView,
  validateAction,
  validateSettingsPatch,
  validateStatsDays,
  validateDragPhase,
  validateInteractive,
  isPlainObject,
};
