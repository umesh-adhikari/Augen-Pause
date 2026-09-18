// Access to the preload bridge. Returns a safe no-op fallback when opened outside Electron
// (e.g. for quick layout checks in a browser), so views never crash on startup.

const noop = () => {};
const unsub = () => noop;

const fallback = Object.freeze({
  platform: 'linux',
  view: 'unknown',
  getSnapshot: async () => null,
  updateSettings: async () => ({ ok: false, errors: ['no bridge'] }),
  resetSettings: async () => null,
  getStats: async () => [],
  resetStats: async () => ({ ok: false }),
  action: async () => ({ ok: false, error: 'no bridge' }),
  showContextMenu: noop,
  widgetDrag: noop,
  setWidgetInteractive: noop,
  onState: unsub,
  onSettings: unsub,
  onStats: unsub,
  onNavigate: unsub,
});

/** @returns {typeof fallback} */
export function getApi() {
  return window.augenpause || fallback;
}

export const hasBridge = () => Boolean(window.augenpause);
