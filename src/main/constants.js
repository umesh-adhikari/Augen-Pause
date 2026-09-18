'use strict';

/**
 * Shared constants for the main process.
 * NOTE: the sandboxed preload cannot require this file – it duplicates the IPC
 * channel names. test/constants.test.js keeps both in sync.
 */

const APP_ID = 'com.augenpause.app';
const PROTOCOL_SCHEME = 'app';
const PROTOCOL_HOST = 'augenpause';
const APP_ORIGIN = `${PROTOCOL_SCHEME}://${PROTOCOL_HOST}`;

const IPC = Object.freeze({
  // renderer → main (invoke)
  GET_SNAPSHOT: 'ap:get-snapshot',
  UPDATE_SETTINGS: 'ap:update-settings',
  RESET_SETTINGS: 'ap:reset-settings',
  GET_STATS: 'ap:get-stats',
  RESET_STATS: 'ap:reset-stats',
  ACTION: 'ap:action',
  // renderer → main (send)
  CONTEXT_MENU: 'ap:context-menu',
  WIDGET_DRAG: 'ap:widget-drag',
  WIDGET_INTERACTIVE: 'ap:widget-interactive',
  // main → renderer (push)
  STATE: 'ap:state',
  SETTINGS: 'ap:settings',
  STATS: 'ap:stats',
  NAVIGATE: 'ap:navigate',
  UPDATE: 'ap:update',
});

const PHASES = Object.freeze(['work', 'break', 'paused', 'away', 'off-hours']);

const ACTIONS = Object.freeze([
  'break-now',
  'skip-break',
  'snooze',
  'pause',
  'resume',
  'reset-timer',
  'drink',
  'undo-drink',
  'open-dashboard',
  'toggle-dashboard',
  'show-widget',
  'hide-widget',
  'reset-widget-position',
  // §12 updates – dashboard only (see ipc-validate.js DASHBOARD_ONLY_ACTIONS)
  'check-updates',
  'download-update',
  'install-update',
  'open-release-page',
  'quit',
]);

const DASHBOARD_TABS = Object.freeze(['overview', 'settings', 'stats', 'exercises', 'about']);

const WIDGET_SIZES = Object.freeze({ small: 120, medium: 160, large: 210 });
const WIDGET_MIN_CONTENT_WIDTH = 176;
const WIDGET_PADDING = 12;
const WIDGET_PILL_HEIGHT = 52;

/** Widget window size for a given size key (see docs/ARCHITECTURE.md §6). */
function widgetWindowSize(sizeKey) {
  const s = WIDGET_SIZES[sizeKey] || WIDGET_SIZES.medium;
  return {
    clock: s,
    width: Math.max(s, WIDGET_MIN_CONTENT_WIDTH) + WIDGET_PADDING * 2,
    height: s + WIDGET_PADDING * 2 + WIDGET_PILL_HEIGHT,
  };
}

const OVERLAY_BACKGROUND = '#0b1020';

module.exports = {
  APP_ID,
  PROTOCOL_SCHEME,
  PROTOCOL_HOST,
  APP_ORIGIN,
  IPC,
  PHASES,
  ACTIONS,
  DASHBOARD_TABS,
  WIDGET_SIZES,
  WIDGET_PADDING,
  WIDGET_PILL_HEIGHT,
  widgetWindowSize,
  OVERLAY_BACKGROUND,
};
