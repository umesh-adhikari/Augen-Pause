'use strict';

/**
 * Sandboxed preload – exposes window.augenpause (docs/ARCHITECTURE.md §5).
 *
 * Sandbox rules: only require('electron') is available here, so the channel names are
 * duplicated from src/main/constants.js (test/constants.test.js keeps them in sync).
 * Never expose ipcRenderer or IPC event objects to the page.
 */

const { contextBridge, ipcRenderer } = require('electron');

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
});

function detectView() {
  let pathname = '';
  try {
    pathname = String(window.location.pathname || '');
  } catch {
    pathname = '';
  }
  if (pathname.startsWith('/widget/')) return 'widget';
  if (pathname.startsWith('/dashboard/')) return 'dashboard';
  if (pathname.startsWith('/overlay/')) return 'overlay';
  return 'unknown';
}

/** Subscription helper: the callback only ever receives the payload; returns an unsubscribe function. */
function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error(`[augenpause] listener for ${channel} failed:`, err);
      }
    };
    ipcRenderer.on(channel, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api = {
  platform: process.platform,
  view: detectView(),

  getSnapshot: () => ipcRenderer.invoke(IPC.GET_SNAPSHOT),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.UPDATE_SETTINGS, patch),
  resetSettings: () => ipcRenderer.invoke(IPC.RESET_SETTINGS),
  getStats: (days) => ipcRenderer.invoke(IPC.GET_STATS, days),
  resetStats: () => ipcRenderer.invoke(IPC.RESET_STATS),
  action: (name, arg) => ipcRenderer.invoke(IPC.ACTION, name, arg),

  showContextMenu: () => {
    ipcRenderer.send(IPC.CONTEXT_MENU);
  },
  widgetDrag: (phase) => {
    ipcRenderer.send(IPC.WIDGET_DRAG, phase);
  },
  setWidgetInteractive: (interactive) => {
    ipcRenderer.send(IPC.WIDGET_INTERACTIVE, Boolean(interactive));
  },

  onState: subscribe(IPC.STATE),
  onSettings: subscribe(IPC.SETTINGS),
  onStats: subscribe(IPC.STATS),
  onNavigate: subscribe(IPC.NAVIGATE),
};

// Only trusted app://augenpause/ pages get the bridge (navigation elsewhere is blocked anyway).
let trusted = false;
try {
  trusted = window.location.protocol === 'app:' && window.location.host === 'augenpause';
} catch {
  trusted = false;
}
if (trusted) contextBridge.exposeInMainWorld('augenpause', api);
