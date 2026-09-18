'use strict';

/**
 * ipcMain handlers (docs/ARCHITECTURE.md §5, §7).
 *
 *   const ipc = registerIpc({ settingsStore, stats, scheduler, windows, performAction,
 *                             getLang, buildContextMenuTemplate, getSettings,
 *                             updateSettings?, isStrictBreakActive?, isBreakRunning?, log? });
 *   ipc.dispose();
 *
 * Every message is checked before anything else happens:
 *   1. event.senderFrame exists and is a main frame,
 *   2. its URL is app://augenpause/<view>/… with a known view,
 *   3. the sending webContents belongs to the managed window of exactly that view,
 *   4. the view may use the channel (and, for ap:action, the action),
 *   5. the payload passes the pure validators from ipc-validate.js.
 * Invoke channels reject with Error('forbidden'); send channels are ignored. Denials are logged once per reason.
 *
 * Updates (§12): `ap:get-snapshot` carries the update state as `update` (when main passes getUpdateState);
 * the update actions are allowlisted for the dashboard only (ipc-validate.js DASHBOARD_ONLY_ACTIONS) and
 * main's performAction refuses them during a mandatory break like every other action.
 *
 * Mandatory break (§11): settings patches go through main's updateSettings() (the same guard as menu / tray:
 * only language + appearance.* during a strict break), actions through performAction() (only drink / undo-drink),
 * reset-settings is rejected during ANY break ({ ok: false, error, settings }) and reset-stats during a
 * strict break ({ ok: false, error }).
 *
 * ap:update-settings is rate limited per sending window (MAX_SETTINGS_PATCHES_PER_SECOND): every accepted
 * patch means an atomic write plus a broadcast, so the channel must not be spinnable from a renderer.
 * Excess calls answer { ok: false, error: 'rate-limited', errors: ['rate-limited'] }.
 */

const { app, ipcMain } = require('electron');
const { IPC } = require('./constants');
const {
  viewFromUrl,
  isChannelAllowedForView,
  isActionAllowedForView,
  validateAction,
  validateSettingsPatch,
  validateStatsDays,
  validateDragPhase,
  validateInteractive,
} = require('./ipc-validate');
const { STRICT_ERROR } = require('./strict-guard');
// windows.js requires electron lazily (inside its factory), so this is a pure helper import.
const { createRateLimiter } = require('./windows');

const INVOKE_CHANNELS = Object.freeze([
  IPC.GET_SNAPSHOT,
  IPC.UPDATE_SETTINGS,
  IPC.RESET_SETTINGS,
  IPC.GET_STATS,
  IPC.RESET_STATS,
  IPC.ACTION,
]);
const SEND_CHANNELS = Object.freeze([IPC.CONTEXT_MENU, IPC.WIDGET_DRAG, IPC.WIDGET_INTERACTIVE]);
const MAX_LOGGED_KEYS = 200;
/**
 * L6: every accepted settings patch costs an atomic (fsync'ed) write plus a broadcast to all windows, so a
 * renderer must not be able to spin the channel. 20 patches/s per sending window is far above what the UI
 * needs (sliders are debounced) and far below what hurts.
 */
const MAX_SETTINGS_PATCHES_PER_SECOND = 20;
const RATE_WINDOW_MS = 1000;
/** Rate-limiter cache size – there are 2 + <displays> windows; a bigger map means webContents ids were reused. */
const MAX_RATE_LIMITED_SENDERS = 32;

/** Per-sender sliding-window rate limit (one createRateLimiter per webContents id). */
function createSenderRateLimiter(max, windowMs) {
  const limiters = new Map();
  return {
    tryAcquire(id, now) {
      const key = typeof id === 'number' ? id : -1;
      if (limiters.size > MAX_RATE_LIMITED_SENDERS && !limiters.has(key)) limiters.clear();
      let limiter = limiters.get(key);
      if (!limiter) {
        limiter = createRateLimiter(max, windowMs);
        limiters.set(key, limiter);
      }
      return limiter.tryAcquire(now);
    },
    reset() {
      limiters.clear();
    },
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return { ok: result !== false };
  const out = { ok: Boolean(result.ok) };
  if (result.error) out.error = String(result.error);
  return out;
}

/**
 * @param {{
 *   settingsStore: { get(): object, update(patch: object): object, reset(): object },
 *   stats: { getRange(days: number): object[], reset(): void },
 *   scheduler: { getState(): object },
 *   windows: ReturnType<typeof import('./windows').createWindowManager>,
 *   performAction: (name: string, arg: any, source: string) => ({ ok: boolean, error?: string } | Promise<any>),
 *   getLang: () => string,
 *   buildContextMenuTemplate: () => object[],
 *   getSettings?: () => object,
 *   getUpdateState?: () => object,
 *   updateSettings?: (patch: object, source: string) => { ok: boolean, settings: object, errors: string[] },
 *   isStrictBreakActive?: () => boolean,
 *   isBreakRunning?: () => boolean,
 *   log?: (msg: string) => void,
 * }} deps
 */
function registerIpc(deps) {
  const { settingsStore, stats, scheduler, windows, performAction, getLang, buildContextMenuTemplate } = deps;
  const updateSettings = deps.updateSettings || ((patch) => settingsStore.update(patch));
  const log = deps.log || ((msg) => console.warn(`[AugenPause:ipc] ${msg}`));

  const settingsLimiter = createSenderRateLimiter(MAX_SETTINGS_PATCHES_PER_SECOND, RATE_WINDOW_MS);
  const logged = new Set();
  function logOnce(key, msg) {
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_KEYS) logged.clear();
    logged.add(key);
    log(msg);
  }

  function deny(channel, reason, url) {
    logOnce(`${channel}|${reason}`, `rejected ${channel}: ${reason}${url ? ` (${String(url).slice(0, 120)})` : ''}`);
    return null;
  }

  /** @returns {'widget'|'dashboard'|'overlay'|null} */
  function senderView(event, channel) {
    const frame = event && event.senderFrame;
    if (!frame) return deny(channel, 'no sender frame');
    let url;
    let isMainFrame;
    try {
      url = frame.url;
      isMainFrame = frame.parent === null;
    } catch {
      return deny(channel, 'sender frame disposed');
    }
    if (!isMainFrame) return deny(channel, 'sub-frame sender', url);
    const view = viewFromUrl(url);
    if (!view) return deny(channel, 'untrusted sender url', url);
    if (windows.getViewForWebContents(event.sender) !== view) return deny(channel, `sender is not the ${view} window`, url);
    if (!isChannelAllowedForView(channel, view)) return deny(channel, `channel not allowed for ${view}`);
    return view;
  }

  /** fn(view, event, ...args) – runs only for an allowed sender. */
  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      const view = senderView(event, channel);
      if (!view) throw new Error('forbidden');
      return fn(view, event, ...args);
    });
  }

  function on(channel, fn) {
    ipcMain.on(channel, (event, ...args) => {
      const view = senderView(event, channel);
      if (!view) return;
      try {
        fn(event, view, ...args);
      } catch (err) {
        log(`${channel} handler failed: ${err && err.message}`);
      }
    });
  }

  const ask = (fn) => {
    try {
      return typeof fn === 'function' && fn() === true;
    } catch {
      return false;
    }
  };
  const strictBreakNow = () => ask(deps.isStrictBreakActive);
  const breakRunning = () =>
    ask(deps.isBreakRunning || (() => {
      const state = scheduler.getState();
      return Boolean(state && state.phase === 'break');
    }));

  // ---- invoke ----------------------------------------------------------------------------

  handle(IPC.GET_SNAPSHOT, (view, event) => {
    // §10: an overlay that asks for its snapshot has a working page → cancels the fail-open timer.
    if (view === 'overlay' && typeof windows.markOverlayReady === 'function') {
      try {
        windows.markOverlayReady(event.sender);
      } catch (err) {
        log(`markOverlayReady failed: ${err && err.message}`);
      }
    }
    const snapshot = {
      state: scheduler.getState(),
      settings: settingsStore.get(),
      stats: stats.getRange(7),
      version: app.getVersion(),
      locale: getLang(),
    };
    // §12: the update state travels with the snapshot and is pushed on ap:update afterwards.
    if (typeof deps.getUpdateState === 'function') {
      try {
        const update = deps.getUpdateState();
        if (update && typeof update === 'object') snapshot.update = update;
      } catch (err) {
        log(`getUpdateState failed: ${err && err.message}`);
      }
    }
    return snapshot;
  });

  handle(IPC.UPDATE_SETTINGS, (view, event, patch) => {
    // L6: throttle before anything is parsed, validated or written.
    if (!settingsLimiter.tryAcquire(event && event.sender && event.sender.id, Date.now())) {
      logOnce('update-settings|rate', `settings patches from ${view} are rate limited`);
      return { ok: false, error: 'rate-limited', errors: ['rate-limited'] };
    }
    const check = validateSettingsPatch(patch);
    if (!check.ok) {
      logOnce(`update-settings|${check.error}`, `rejected settings patch from ${view}: ${check.error}`);
      return { ok: false, settings: settingsStore.get(), errors: [check.error] };
    }
    return updateSettings(patch, `ipc:${view}`);
  });

  handle(IPC.RESET_SETTINGS, () => {
    // A reset would also switch breaks.strictMode (default on) – never while a break runs (§11).
    // L3: a blocked reset must be recognisable – returning the unchanged settings looked exactly like
    // success, so the dashboard reported "done". Shape as for ap:reset-stats plus the current settings,
    // so a caller that expects Settings can still keep its view in sync.
    if (breakRunning() || strictBreakNow()) {
      const error = strictBreakNow() ? STRICT_ERROR : 'break-running';
      logOnce('reset-settings|break', `reset-settings rejected while a break is running (${error})`);
      return { ok: false, error, settings: settingsStore.get() };
    }
    return settingsStore.reset();
  });

  handle(IPC.GET_STATS, (_view, _event, days) => {
    const check = validateStatsDays(days);
    if (!check.ok) throw new Error(check.error);
    return stats.getRange(check.days);
  });

  handle(IPC.RESET_STATS, () => {
    if (strictBreakNow()) {
      logOnce('reset-stats|strict', 'reset-stats rejected during a mandatory break');
      return { ok: false, error: STRICT_ERROR };
    }
    stats.reset();
    return { ok: true };
  });

  handle(IPC.ACTION, async (view, _event, name, arg) => {
    const check = validateAction(name, arg);
    if (!check.ok) {
      logOnce(`action|${check.error}`, `rejected action from ${view}: ${check.error}`);
      return { ok: false, error: check.error };
    }
    if (!isActionAllowedForView(check.name, view)) {
      logOnce(`action|${view}|${check.name}`, `action ${check.name} not allowed for ${view}`);
      return { ok: false, error: 'forbidden' };
    }
    try {
      return normalizeResult(await performAction(check.name, check.arg, `ipc:${view}`));
    } catch (err) {
      log(`action ${check.name} failed: ${err && err.message}`);
      return { ok: false, error: 'internal-error' };
    }
  });

  // ---- send ------------------------------------------------------------------------------

  on(IPC.CONTEXT_MENU, (event) => {
    windows.popupContextMenu(event.sender, buildContextMenuTemplate());
  });

  on(IPC.WIDGET_DRAG, (_event, view, phase) => {
    if (!validateDragPhase(phase)) return void logOnce('widget-drag|phase', `invalid widget drag phase from ${view}`);
    windows.handleWidgetDrag(phase);
  });

  on(IPC.WIDGET_INTERACTIVE, (_event, view, interactive) => {
    if (!validateInteractive(interactive)) {
      return void logOnce('widget-interactive|value', `invalid widget interactive value from ${view}`);
    }
    windows.setWidgetInteractive(interactive);
  });

  return {
    dispose() {
      for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
      for (const channel of SEND_CHANNELS) ipcMain.removeAllListeners(channel);
      settingsLimiter.reset();
    },
  };
}

module.exports = {
  registerIpc,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  // pure helper + budget (unit tests)
  createSenderRateLimiter,
  MAX_SETTINGS_PATCHES_PER_SECOND,
};
