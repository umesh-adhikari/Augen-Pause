'use strict';

/**
 * AugenPause – main process entry point.
 * Lifecycle, module wiring and the central action dispatcher (docs/ARCHITECTURE.md §5–7, §9–11).
 *
 * Mandatory break ("Pflicht-Pause", §11) – isStrictBreakActive() is the single decision (strict flag captured at
 * 'break-start', never weaker than the scheduler's state.break.strict). While it is true:
 *   - performAction() accepts only drink / undo-drink, from every source (IPC, menu, tray, shortcut, notification,
 *     overlay Esc, second instance, activate …) → { ok: false, error: 'strict-mode' },
 *   - updateSettings() (menu, tray, IPC, widget drag) applies only language + appearance.*,
 *   - quitting is blocked unless the OS shuts down / logs off / sends SIGTERM (then scheduler.onSystemShutdown()
 *     persists the break first; a killed app resumes it on the next start – a bare SIGTERM is reported as
 *     "not a session end", so the break keeps the long resume window),
 *   - the break screen is fail-closed (windows.js) and closes only when the scheduler ends the break.
 *
 * Because that lock is absolute it needs one escape hatch that does not depend on the scheduler:
 * checkBreakSafety() runs every second and releases the lock (forceEndBreakLock: breakStrict = null,
 * overlays closed, widget back, application menu restored) when the break passed its own deadline –
 * taken at 'break-start' from a monotonic clock – or has been reporting 0 s remaining for 10 s
 * (what a scheduler.tick() that keeps throwing looks like).
 *
 * Flags:  --dev     DevTools enabled (unpackaged builds only), renderer console forwarded, F12 toggles DevTools
 *         --hidden  started by autostart → never opens the dashboard on its own
 * Dev only: AUGENPAUSE_USER_DATA=<dir> uses a separate userData directory (unpackaged builds only).
 *           AUGENPAUSE_UPDATE_FEED / _DEV_CHECKS / _FIRST_DELAY_MS steer the update check (see updater.js).
 *
 * Updates (§12): wireUpdater() creates the updater after the settings / scheduler / IPC wiring. It is the
 * only part of the app that talks to the network (api.github.com, switchable via settings.updates.autoCheck);
 * its state is pushed on `ap:update` and travels with `ap:get-snapshot`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, dialog, Menu, nativeTheme, net, powerMonitor, session, shell } = require('electron');
const { APP_ID, IPC } = require('./constants');
const { registerPrivilegedScheme, registerAppProtocol } = require('./protocol');
const { installGlobalSecurity, hardenSession } = require('./security');
const { validateAction, validateSettingsPatch } = require('./ipc-validate');
const {
  STRICT_ERROR,
  OVERDUE_BREAK_MS,
  isActionAllowedDuringStrictBreak,
  guardSettingsPatch,
  strictFlagForBreakStart,
  isStrictBreakState,
  breakLockDeadline,
  evaluateBreakOverdue,
} = require('./strict-guard');

const TAG = '[AugenPause]';
const isDev = process.argv.includes('--dev') && !app.isPackaged;
const ASSETS_DIR = path.join(__dirname, '../../assets/icons');
const PRELOAD_PATH = path.join(__dirname, '../preload/preload.js');
/** "Done" animation time – only after a completed break; skip / snooze / meeting close immediately (§10). */
const OVERLAY_CLOSE_DELAY_MS = 1500;
const ORPHAN_OVERLAY_MS = 3000;
const SAFETY_CHECK_INTERVAL_MS = 1000;
/** Monotonic clock for the break-lock deadline – immune to wall-clock changes (§11 tamper resistance). */
const monoNow = () => performance.now();

// ---------------------------------------------------------------------------------------------
// Logging & optional modules

/**
 * Fail-safe logging. When stdout / stderr are gone (app started from a terminal that was closed, a pipe whose
 * reader exited, a redirect into a killed process, `--dev` output piped into another tool), every further write
 * emits EPIPE / EBADF. Without an 'error' listener that would become an uncaught exception – and Electron answers
 * an uncaught main-process exception with a modal "A JavaScript error occurred in the main process" dialog.
 * So: listen on both streams, remember a dead sink and never let logging throw. The app keeps running silently.
 */
const brokenStream = { stdout: false, stderr: false };
for (const name of ['stdout', 'stderr']) {
  const stream = process[name];
  if (stream && typeof stream.on === 'function') {
    // swallow every stream error (EPIPE / EBADF / ERR_STREAM_DESTROYED …): a log sink must never crash the app
    stream.on('error', () => {
      brokenStream[name] = true;
    });
  }
}

/** console[method](...) that survives a broken stdout / stderr (and a console that throws synchronously). */
function write(method, args) {
  const sink = method === 'log' ? 'stdout' : 'stderr';
  if (brokenStream[sink]) return;
  try {
    console[method](...args);
  } catch {
    brokenStream[sink] = true;
  }
}

function logInfo(...args) {
  write('log', args);
}

function logError(context, err) {
  write('error', [`${TAG} ${context}:`, err && err.stack ? err.stack : err]);
}

function logWarn(...args) {
  write('warn', [TAG, ...args]);
}

/** Runs fn; logs and swallows errors so one broken module never takes the app down. */
function safe(context, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    logError(context, err);
    return fallback;
  }
}

/** require() for [MAIN-UX] modules: missing or broken → logged + no-op fallback. */
function optionalRequire(name, fallback) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(name);
  } catch (err) {
    write('error', [`${TAG} module ${name} unavailable – continuing without it: ${err && err.message}`]);
    return fallback;
  }
}

const NOOP_TRAY = Object.freeze({ update() {}, refreshMenu() {}, destroy() {} });
const NOOP_NOTIFIER = Object.freeze({
  warning() {},
  breakStart() {},
  breakEnd() {},
  hydration() {},
  meetingDeferred() {},
  meetingDeferExpired() {},
  updateAvailable() {},
});
/** §12: used until the updater is wired, and when updater.js itself is broken. */
const NOOP_UPDATER = Object.freeze({
  start() {},
  stop() {},
  check: async () => ({ ok: false, error: 'not-ready' }),
  download: async () => ({ ok: false, error: 'not-ready' }),
  install: () => ({ ok: false, error: 'not-ready' }),
  openReleasePage: () => ({ ok: false, error: 'not-ready' }),
  getUpdateState: () => null,
  onSettingsChanged() {},
});
const FALLBACK = Object.freeze({
  i18n: { createMainI18n: () => ({ t: (key) => String(key), lang: () => 'en' }) },
  menu: {
    buildMenuTemplate: ({ onAction }) => [
      { label: 'Dashboard', click: () => onAction('open-dashboard', 'overview') },
      { type: 'separator' },
      { label: 'Quit', click: () => onAction('quit') },
    ],
    // §11 (M3): without the menu module macOS gets no application menu at all – that is the safe side
    // (no ⌘H / ⌘Q key equivalents), it only costs the Edit roles.
    buildAppMenuTemplate: () => null,
  },
  tray: { createTray: () => NOOP_TRAY },
  notifications: { createNotifier: () => NOOP_NOTIFIER },
  autostart: { applyAutostart: async () => {} },
  shortcuts: { registerShortcuts: () => ({ registered: [], failed: [] }), unregisterShortcuts: () => {} },
});

/** Fills missing methods of an object returned by an optional module with no-ops. */
function withDefaults(instance, defaults) {
  const out = instance && typeof instance === 'object' ? instance : {};
  for (const key of Object.keys(defaults)) {
    if (typeof out[key] !== 'function') out[key] = defaults[key];
  }
  return out;
}

// These two handlers keep the app alive after a bug in one module – and they must never throw themselves:
// an exception inside an 'uncaughtException' listener is fatal and pops up Electron's error dialog. logError()
// swallows everything, including a broken stdout/stderr (see above).
process.on('uncaughtException', (err) => logError('uncaught exception', err));
process.on('unhandledRejection', (reason) => logError('unhandled promise rejection', reason));

// ---------------------------------------------------------------------------------------------
// Application context

const ctx = {
  ready: false,
  quitting: false,
  systemShutdown: false,
  cleanedUp: false,
  pendingDashboard: false,
  overlayOrphanSince: null,
  /** the break screen of the current break failed and was closed (fail-open, §10) → widget peeks */
  overlayFailed: false,
  safetyTimer: null,
  /** §11: strict flag of the running break, captured at 'break-start' (null = no break seen / break ended) */
  breakStrict: null,
  /** scheduler.onSystemShutdown() already called for this session end: null | 'pending' | 'real' */
  breakPersistedForShutdown: null,
  /** a real OS session end was observed (powerMonitor 'shutdown' / Windows session-end or logoff query) */
  realSessionEnd: false,
  /**
   * H1: monotonic deadline of the running break, taken at 'break-start' and NEVER from the scheduler again
   * (state.break.endsAt is re-projected to now + remainingMs on every getState(), so it can never look overdue).
   */
  breakDeadline: null,
  /** H1: monotonic timestamp since which state.break.remainingMs has been 0 (a stalled tick loop) */
  breakZeroSince: null,
  /**
   * H1: the safety net gave control back although the scheduler still reports phase 'break'. Overrides the
   * (deliberately fail-closed) strict decision until the next break starts – clearing ctx.breakStrict alone
   * would not help, because isStrictBreakState() also trusts the scheduler's own state.break.strict.
   */
  breakLockReleased: false,

  settingsStore: null,
  stats: null,
  scheduler: null,
  windows: null,
  meeting: null,
  ipc: null,
  i18n: FALLBACK.i18n.createMainI18n(),
  tray: NOOP_TRAY,
  notifier: NOOP_NOTIFIER,
  /** §12 update check (the only network access of the app) */
  updater: NOOP_UPDATER,
  modules: { ...FALLBACK },

  /** §11 break slot (session.json) – main clears it when the safety net gives up on a break */
  breakStore: null,

  /** cached current settings (replaced on every store 'change') */
  settings: null,
};

const getSettings = () => ctx.settings;
const t = (key, vars) => ctx.i18n.t(key, vars);
const currentState = () => (ctx.scheduler ? safe('scheduler.getState', () => ctx.scheduler.getState(), null) : null);
/**
 * §11: the single strict-break decision (phase break && the running break is a mandatory one).
 * @param {object} [state] a SchedulerState that is already at hand (saves a getState() call)
 */
function isStrictBreakActive(state) {
  if (ctx.breakLockReleased) return false; // H1: released by the safety net, the user is in control again
  const st = state && typeof state === 'object' ? state : currentState();
  return safe('isStrictBreakActive', () => isStrictBreakState(st, ctx.settings, ctx.breakStrict), false);
}

function isBreakRunning() {
  const state = currentState();
  return Boolean(state && state.phase === 'break');
}

function flushStats() {
  if (ctx.stats) safe('stats.flush', () => ctx.stats.flush());
}

// ---------------------------------------------------------------------------------------------
// Actions (§5)

function schedulerResult(result) {
  if (!result || typeof result !== 'object') return { ok: true };
  return result.error ? { ok: Boolean(result.ok), error: String(result.error) } : { ok: Boolean(result.ok) };
}

function settingsResult(result) {
  if (!result || typeof result !== 'object') return { ok: true };
  return result.ok ? { ok: true } : { ok: false, error: (result.errors || []).join('; ') || 'settings-rejected' };
}

function requestQuit() {
  if (!ctx.systemShutdown && isStrictBreakActive()) return { ok: false, error: STRICT_ERROR };
  setImmediate(() => app.quit()); // lets an IPC reply go out first
  return { ok: true };
}

/**
 * Central dispatcher for tray, context menu, shortcuts, notifications and renderers.
 * @param {string} name
 * @param {any} [arg]
 * @param {string} [source] 'ipc:<view>' | 'tray' | 'menu' | 'shortcut' | 'notification' | 'overlay-esc' | … (logged in --dev)
 * @returns {{ ok: boolean, error?: string }}
 */
function performAction(name, arg, source = 'internal') {
  const result = dispatchAction(name, arg, source);
  if (isDev) {
    const argText = arg === undefined ? '' : ` ${JSON.stringify(arg)}`;
    // the update actions answer asynchronously (§12) – log what they finally returned
    if (result && typeof result.then === 'function') {
      result.then(
        (value) => logInfo(`${TAG}[dev] action ${name}${argText} from ${source} →`, value),
        (err) => logError(`action ${name} from ${source}`, err),
      );
    } else {
      logInfo(`${TAG}[dev] action ${name}${argText} from ${source} →`, result);
    }
  }
  return result;
}

function dispatchAction(name, arg, source = 'internal') {
  const check = validateAction(name, arg);
  if (!check.ok) return { ok: false, error: check.error };
  // §11: a mandatory break ends only by timeout – whatever the source, only the water entries work.
  if (ctx.ready && !isActionAllowedDuringStrictBreak(check.name) && isStrictBreakActive()) {
    return { ok: false, error: STRICT_ERROR };
  }
  if (!ctx.ready) {
    if (check.name === 'open-dashboard' || check.name === 'toggle-dashboard') ctx.pendingDashboard = true;
    return { ok: false, error: 'not-ready' };
  }
  const { scheduler, windows } = ctx;
  try {
    switch (check.name) {
      case 'break-now':
        return schedulerResult(scheduler.startBreak(check.arg));
      case 'skip-break':
        return schedulerResult(scheduler.skipBreak());
      case 'snooze':
        return schedulerResult(scheduler.snooze(check.arg));
      case 'pause':
        return schedulerResult(scheduler.pause(check.arg)); // null = indefinitely
      case 'resume':
        return schedulerResult(scheduler.resume());
      case 'reset-timer':
        return schedulerResult(scheduler.resetWorkTimer());
      case 'drink':
        return schedulerResult(scheduler.drinkWater());
      case 'undo-drink':
        return schedulerResult(scheduler.undoDrink());
      case 'open-dashboard':
        windows.openDashboard(check.arg);
        return { ok: true };
      case 'toggle-dashboard':
        windows.toggleDashboard();
        return { ok: true };
      // L2: the widget actions write settings – they go through the guarded updateSettings() like every other
      // settings change (never straight to the store, even though the strict check above already covers them).
      case 'show-widget': {
        const result = settingsResult(updateSettings({ widget: { visible: true } }, source));
        windows.showWidget();
        return result;
      }
      case 'hide-widget':
        // windows.applySettings hides it (unless it is temporarily shown for a warning / meeting deferral, §9)
        return settingsResult(updateSettings({ widget: { visible: false } }, source));
      case 'reset-widget-position':
        return settingsResult(updateSettings({ widget: { position: null } }, source));
      // §12 updates – dashboard only (ipc-validate), and like everything else refused during a
      // mandatory break by the strict guard above.
      case 'check-updates':
        return ctx.updater.check({ manual: true });
      case 'download-update':
        return ctx.updater.download();
      case 'install-update':
        return ctx.updater.install();
      case 'open-release-page':
        return ctx.updater.openReleasePage();
      case 'quit':
        return requestQuit();
      default:
        return { ok: false, error: 'unknown-action' };
    }
  } catch (err) {
    logError(`action ${check.name} failed`, err);
    return { ok: false, error: 'internal-error' };
  }
}

/**
 * Every settings change from menu, tray, IPC and main itself goes through here (§11): during a mandatory break only
 * `language` and `appearance.*` are applied, during any break `breaks.strictMode` keeps its value.
 * Rejected keys are reported in `errors` ('strict-break: <key>' / 'break-running: breaks.strictMode').
 * @param {object} patch deep partial settings (untrusted)
 * @param {string} [source] logged in --dev
 * @returns {{ ok: boolean, settings: object|null, errors: string[] }}
 */
function updateSettings(patch, source = 'internal') {
  const store = ctx.settingsStore;
  if (!store) return { ok: false, settings: null, errors: ['not-ready'] };
  const check = validateSettingsPatch(patch);
  if (!check.ok) return { ok: false, settings: store.get(), errors: [check.error] };
  const state = currentState();
  const guarded = guardSettingsPatch(patch, {
    strictBreak: isStrictBreakActive(state),
    inBreak: Boolean(state && state.phase === 'break'),
    strictMode: Boolean(ctx.settings && ctx.settings.breaks && ctx.settings.breaks.strictMode === true),
  });
  if (guarded.errors.length > 0 && isDev) {
    logInfo(`${TAG}[dev] settings from ${source} rejected during the break: ${guarded.errors.join(', ')}`);
  }
  if (guarded.empty) return { ok: false, settings: store.get(), errors: guarded.errors };
  const result = store.update(guarded.patch);
  if (guarded.errors.length === 0) return result;
  return { ...result, errors: [...((result && result.errors) || []), ...guarded.errors] };
}

// ---------------------------------------------------------------------------------------------
// Before ready

function preReady() {
  if (!app.isPackaged && process.env.AUGENPAUSE_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.AUGENPAUSE_USER_DATA));
  }

  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' && !app.commandLine.hasSwitch('ozone-platform')) {
    // Native Wayland does not let clients position windows or keep them above other windows, so the
    // widget and the break overlays would not work → run through XWayland.
    // CAVEAT: Electron picks the Ozone platform very early during startup; depending on the Electron
    // version a switch appended from JS may come too late. Packaged Linux launchers should therefore also
    // pass --ozone-platform=x11 on the command line. Requires XWayland to be installed.
    app.commandLine.appendSwitch('ozone-platform', 'x11');
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // Windows notifications
  app.enableSandbox();
  registerPrivilegedScheme();
  installGlobalSecurity({ isDev });

  const showDashboardOrBreakScreen = (source) => {
    const result = performAction('open-dashboard', undefined, source);
    // §11: during a mandatory break the dashboard stays closed – bring the break screen to the front instead.
    if (result && result.error === STRICT_ERROR && ctx.windows) safe('focusOverlays', () => ctx.windows.focusOverlays());
  };
  app.on('second-instance', () => showDashboardOrBreakScreen('second-instance'));
  app.on('activate', () => {
    if (ctx.ready) showDashboardOrBreakScreen('activate');
  });
  app.on('window-all-closed', () => {
    /* tray app: keep running without windows */
  });
  app.on('before-quit', onBeforeQuit);
  app.on('will-quit', cleanup);
  // Linux/macOS logout or `kill`: the session manager sends SIGTERM – a mandatory break must not block it
  // (it is persisted first). Not delivered on Windows (session end is handled via the window events there).
  // M1: a bare SIGTERM is NOT proof of a session end (`kill`, System Monitor, Activity Monitor "Quit" send
  // the same signal), so the break is persisted as "killed" unless a real session end was observed before.
  process.on('SIGTERM', () => {
    onSystemShutdown('SIGTERM', false);
    app.quit();
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Quit / shutdown

function onBeforeQuit(event) {
  if (ctx.ready && !ctx.systemShutdown && isStrictBreakActive()) {
    event.preventDefault();
    logWarn('quit blocked: a mandatory break is running (it ends by itself)');
    return;
  }
  ctx.quitting = true;
  if (ctx.windows) ctx.windows.setQuitting(true);
  flushStats();
}

function cleanup() {
  if (ctx.cleanedUp) return;
  ctx.cleanedUp = true;
  if (ctx.safetyTimer) clearInterval(ctx.safetyTimer);
  safe('updater.stop', () => ctx.updater.stop());
  safe('meeting.stop', () => ctx.meeting && ctx.meeting.stop());
  safe('scheduler.stop', () => ctx.scheduler && ctx.scheduler.stop());
  flushStats();
  safe('tray.destroy', () => ctx.tray.destroy());
  safe('unregisterShortcuts', () => ctx.modules.shortcuts.unregisterShortcuts());
  safe('ipc.dispose', () => ctx.ipc && ctx.ipc.dispose());
  safe('windows.dispose', () => ctx.windows && ctx.windows.dispose());
}

/**
 * §11: lets the scheduler persist a running break before the process goes away.
 *
 * M1: `interrupted: 'system'` shortens the resume window to idle.resetAfterMinutes (5 min) – that must only
 * happen when the OS really ends the session. A bare SIGTERM (`kill`, GNOME System Monitor, Activity Monitor
 * "Quit") and a Windows logoff QUERY (which the user may still cancel) are no proof of that, so they are
 * reported with realSessionEnd = false and the break stays resumable within the 8 h kill window.
 * Called at most once per session end, but a "not a real session end" persist is escalated once when the
 * real session end follows. Older schedulers without the parameter simply ignore it.
 * @param {boolean} [realSessionEnd] true only for an observed OS shutdown / logoff / session end
 */
function persistBreakForShutdown(realSessionEnd = false) {
  if (realSessionEnd === true) ctx.realSessionEnd = true;
  const real = ctx.realSessionEnd === true;
  if (!ctx.scheduler || typeof ctx.scheduler.onSystemShutdown !== 'function') return;
  if (ctx.breakPersistedForShutdown === 'real') return; // nothing can follow a real session end
  if (ctx.breakPersistedForShutdown === 'pending' && !real) return; // already saved as "killed"
  ctx.breakPersistedForShutdown = real ? 'real' : 'pending';
  safe('scheduler.onSystemShutdown', () => ctx.scheduler.onSystemShutdown(real));
}

/**
 * OS shutdown / logout / SIGTERM: quitting must never be blocked, stats and a running break must be on disk.
 * @param {string} reason
 * @param {boolean} [realSessionEnd] see persistBreakForShutdown()
 */
function onSystemShutdown(reason, realSessionEnd = false) {
  if (!ctx.systemShutdown) logWarn(`system ${reason} – allowing quit (session end: ${realSessionEnd === true})`);
  persistBreakForShutdown(realSessionEnd);
  ctx.systemShutdown = true;
  ctx.quitting = true;
  if (ctx.windows) ctx.windows.setQuitting(true);
  flushStats();
}

/** Windows only (BrowserWindow events). */
function onWindowsSessionEnd(kind) {
  if (kind === 'session-end') {
    onSystemShutdown('session end', true);
    app.quit();
    return;
  }
  // query-session-end: persist the break already, but the user may still cancel the logoff → a manual quit
  // stays blocked (only the real session end unblocks it) and the break is NOT yet marked as a session end
  // (M1). When the logoff really happens, 'session-end' escalates the record.
  persistBreakForShutdown(false);
  flushStats();
}

// ---------------------------------------------------------------------------------------------
// Wiring helpers

function registerGlobalShortcuts() {
  const result = safe(
    'registerShortcuts',
    () =>
      ctx.modules.shortcuts.registerShortcuts({
        enabled: (ctx.settings.general || {}).globalShortcuts !== false,
        onAction: performAction,
        getState: currentState,
        isStrictBreak: () => isStrictBreakActive(),
      }),
    null,
  );
  if (result && Array.isArray(result.failed) && result.failed.length > 0) {
    logWarn('global shortcuts not available:', result.failed.join(', '));
  }
  if (isDev && result && Array.isArray(result.registered)) {
    logInfo(`${TAG}[dev] global shortcuts registered: ${result.registered.join(', ') || '(none)'}`);
  }
}

function applyAutostartSetting() {
  const enabled = (ctx.settings.general || {}).autostart === true;
  Promise.resolve()
    .then(() => ctx.modules.autostart.applyAutostart(enabled))
    .catch((err) => logError('applyAutostart', err));
}

/**
 * §11 (M3): the macOS application menu is rebuilt whenever the lock state changes, because AppKit executes
 * the key equivalents of its items (⌘H hide, ⌘⌥H hideOthers, ⌘M minimize, ⌘W close, ⌘Q quit) BEFORE the
 * overlay's before-input-event can block them – ⌘H would simply hide the break lock. During a strict break
 * the menu is therefore reduced to a single inert entry; the full menu (incl. the Edit roles for copy/paste)
 * returns at break end. Called on startup, on 'break-start' / 'break-end', on the forced unlock and on every
 * language change.
 * @param {boolean} [strictBreak] lock state to build for (default: the current one)
 */
function setApplicationMenu(strictBreak) {
  const strict = typeof strictBreak === 'boolean' ? strictBreak : isStrictBreakActive();
  const template = safe(
    'app menu template',
    () =>
      ctx.modules.menu.buildAppMenuTemplate({
        platform: process.platform,
        appName: app.name,
        t,
        strictBreak: strict,
        onQuit: () => performAction('quit', undefined, 'app-menu'),
      }),
    null,
  );
  // null = no application menu at all (Windows / Linux, or a broken menu module): also removes Electron's
  // default accelerators (reload, devtools, close) – and on macOS it means no ⌘H / ⌘Q either.
  if (!Array.isArray(template) || template.length === 0) {
    safe('setApplicationMenu', () => Menu.setApplicationMenu(null));
    return;
  }
  safe('setApplicationMenu', () => Menu.setApplicationMenu(Menu.buildFromTemplate(template)));
}

function buildContextMenuTemplate() {
  return ctx.modules.menu.buildMenuTemplate({
    state: currentState(),
    settings: ctx.settings,
    update: safe('updater.getUpdateState', () => ctx.updater.getUpdateState(), null),
    t,
    strictBreak: isStrictBreakActive(),
    onAction: (name, arg) => performAction(name, arg, 'menu'),
    onSettings: (patch) => updateSettings(patch, 'menu'),
  });
}

/**
 * §11 break persistence slot (`session.json`) with loud reporting of a failing clear() (L5).
 * A userData directory that cannot be written (read-only volume, ACLs, full disk) keeps the finished break
 * on disk – and a saved strict break is resumed on the next launch, so the user would be greeted by the
 * same mandatory break over and over. The scheduler swallows store errors, so main logs them.
 * @param {string} filePath
 */
function createBreakStore(filePath) {
  // eslint-disable-next-line global-require
  const { createJsonFileSlot } = require('./store');
  const slot = createJsonFileSlot(filePath);
  return {
    load: () => slot.load(),
    save: (value) => slot.save(value),
    clear: () => {
      const result = slot.clear();
      if (result === false) {
        const code = slot.lastError ? ` (${slot.lastError})` : '';
        write('error', [
          `${TAG} could not delete the saved break${code} – the same break would be resumed on every start. ` +
            `Please check the file and its directory (read-only? full? locked?): ${filePath}`,
        ]);
      }
      return result;
    },
  };
}

function closeOverlaysAndRestoreWidget(delayMs) {
  ctx.windows
    .closeOverlays(delayMs)
    .then((closed) => {
      if (closed) ctx.windows.showWidget();
    })
    .catch((err) => logError('closeOverlays', err));
}

/**
 * Show a widget that is hidden by settings (inactive, no focus steal) while
 *  - §9: the pre-break warning or a meeting deferral runs (widget.showOnWarning),
 *  - §10: a break runs without a break screen (breaks.lockScreen off, or the overlay failed) – otherwise the
 *    break would be invisible.
 */
function updateWidgetPeek(state) {
  if (!state || !ctx.settings) return;
  const w = ctx.settings.widget || {};
  const warningPeek =
    w.showOnWarning !== false &&
    state.phase === 'work' &&
    (state.warning === true || Boolean(state.meeting && state.meeting.deferred));
  const breakPeek =
    state.phase === 'break' && (Boolean(state.break && state.break.lockScreen === false) || ctx.overlayFailed);
  ctx.windows.setWidgetPeek(w.visible === false && (warningPeek || breakPeek));
}

/**
 * H1: (re)arms the break-lock deadline from a 'break-start' payload or from a running break's state.
 * Called at break start (also for a resumed break) and after suspend / lock, where the scheduler credits
 * the downtime to the break and the original deadline would be too early.
 * @param {{ durationMs?: number, endsAt?: number, remainingMs?: number }|null} info
 * @param {number} [wallNow] the wall clock `info.endsAt` belongs to
 */
function armBreakDeadline(info, wallNow = Date.now()) {
  ctx.breakDeadline = safe(
    'breakLockDeadline',
    () => breakLockDeadline(info, { monoNow: monoNow(), wallNow, overdueMs: OVERDUE_BREAK_MS }),
    null,
  );
  ctx.breakZeroSince = null;
}

/** H1: re-arms the deadline of a break that is still running (after resume / unlock), otherwise clears it. */
function rearmBreakDeadline() {
  const state = currentState();
  if (!state || state.phase !== 'break') {
    ctx.breakDeadline = null;
    ctx.breakZeroSince = null;
    return;
  }
  armBreakDeadline(state.break, Number.isFinite(state.now) ? state.now : Date.now());
}

/**
 * H1: last resort when a break does not end – e.g. scheduler.tick() throwing on every interval tick keeps
 * the phase at 'break' with 0 s remaining forever. Without this the user would be locked out for good:
 * overlays up, watchdog stealing focus, quit blocked and every action rejected with 'strict-mode'.
 * So: drop the strict flag FIRST (quitting and all actions work again), then let the screen go.
 * @param {string} reason
 */
function forceEndBreakLock(reason) {
  if (ctx.breakLockReleased) return; // already released – do not log / close again every second
  write('error', [`${TAG} break lock released by the safety net: ${reason} – the break screen is closing`]);
  ctx.breakDeadline = null;
  ctx.breakZeroSince = null;
  ctx.breakStrict = null;
  // unblocks quit (onBeforeQuit) and every action (dispatchAction), even though the scheduler still
  // reports a strict break – see ctx.breakLockReleased.
  ctx.breakLockReleased = true;
  ctx.overlayFailed = false;
  ctx.breakPersistedForShutdown = null;
  // …and it must not come back: the scheduler saved this break and would resume it on the next start
  // (§11). A failing clear() is reported loudly by the slot wrapper (L5).
  safe('breakStore.clear', () => ctx.breakStore && ctx.breakStore.clear());
  safe('application menu', () => setApplicationMenu(false)); // M3: ⌘H … work again
  if (ctx.windows) {
    if (ctx.windows.hasOverlays()) closeOverlaysAndRestoreWidget(0);
    else safe('windows.showWidget', () => ctx.windows.showWidget());
  }
  safe('tray.update', () => ctx.tray.update(currentState(), ctx.settings));
}

/**
 * Runs every SAFETY_CHECK_INTERVAL_MS:
 *  - a running break that is past its deadline or stuck at 0 s remaining releases the lock (H1),
 *  - overlays must never outlive a break: close them if the phase is not 'break' for > 3 s (§10).
 * The break check also runs without overlays (breaks.lockScreen off), because the strict lock blocks
 * quitting and all actions there too.
 */
function checkBreakSafety() {
  const state = currentState();
  if (state && state.phase === 'break') {
    ctx.overlayOrphanSince = null;
    if (ctx.breakLockReleased) return; // this break was already given up on
    const verdict = safe(
      'isBreakOverdue',
      () =>
        evaluateBreakOverdue({
          state,
          now: monoNow(),
          deadline: ctx.breakDeadline,
          zeroSince: ctx.breakZeroSince,
          overdueMs: OVERDUE_BREAK_MS,
        }),
      null,
    );
    if (!verdict) return;
    ctx.breakZeroSince = verdict.zeroSince;
    if (verdict.overdue) forceEndBreakLock(verdict.reason || 'break overdue');
    return;
  }
  ctx.breakZeroSince = null;
  if (!ctx.windows || !ctx.windows.hasOverlays()) {
    ctx.overlayOrphanSince = null;
    return;
  }
  const now = Date.now();
  if (ctx.overlayOrphanSince === null) {
    ctx.overlayOrphanSince = now;
  } else if (now - ctx.overlayOrphanSince > ORPHAN_OVERLAY_MS) {
    logWarn('closing break overlays without a running break');
    ctx.overlayOrphanSince = null;
    closeOverlaysAndRestoreWidget(0);
  }
}

function changed(next, prev, pick) {
  try {
    return pick(next) !== pick(prev);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Event handlers

function onSchedulerState(state) {
  ctx.windows.broadcast(IPC.STATE, state);
  safe('tray.update', () => ctx.tray.update(state, ctx.settings));
  safe('widget peek', () => updateWidgetPeek(state));
}

function onBreakStart(info) {
  ctx.overlayFailed = false;
  ctx.breakLockReleased = false; // a new break is locked again
  ctx.breakStrict = strictFlagForBreakStart(info, ctx.settings); // fixed for the whole break (§11)
  ctx.breakPersistedForShutdown = null;
  // H1: own deadline for this break (also for a resumed one – its 'break-start' carries the remaining time),
  // tracked independently of the scheduler so a stalled scheduler cannot keep the lock alive.
  armBreakDeadline(info);
  safe('application menu', () => setApplicationMenu(ctx.breakStrict === true)); // M3
  if ((ctx.settings.breaks || {}).lockScreen !== false) {
    ctx.windows.hideWidget();
    ctx.windows.openOverlays();
    if (typeof ctx.notifier.closeAll === 'function') safe('notifier.closeAll', () => ctx.notifier.closeAll());
  } else {
    safe('notifier.breakStart', () => ctx.notifier.breakStart(info));
  }
}

function onBreakEnd(info) {
  const meeting = Boolean(info && info.reason === 'meeting');
  const completed = Boolean(info && info.completed === true);
  ctx.overlayFailed = false;
  ctx.breakStrict = null;
  ctx.breakDeadline = null;
  ctx.breakZeroSince = null;
  ctx.breakLockReleased = false;
  safe('application menu', () => setApplicationMenu(false)); // M3: hide / window / quit roles are back
  if (ctx.windows.hasOverlays()) {
    // Completed → short "done" state; every partial end (skip / snooze / meeting / reason 'clock-jump' after a
    // suspend with a wall-clock jump) → get out of the way immediately (§10).
    closeOverlaysAndRestoreWidget(completed ? OVERLAY_CLOSE_DELAY_MS : 0);
  } else {
    ctx.windows.showWidget();
  }
  if ((ctx.settings.breaks || {}).lockScreen === false && !meeting) {
    safe('notifier.breakEnd', () => ctx.notifier.breakEnd(info));
  }
}

function onSettingsChange(next, prev) {
  ctx.settings = next;
  safe('scheduler.onSettingsChanged', () => ctx.scheduler.onSettingsChanged(next, prev));
  ctx.windows.broadcast(IPC.SETTINGS, next);
  safe('windows.applySettings', () => ctx.windows.applySettings(next, prev));

  if (changed(next, prev, (s) => s.appearance.theme)) {
    safe('nativeTheme', () => {
      nativeTheme.themeSource = next.appearance.theme;
    });
  }
  if (changed(next, prev, (s) => s.general.autostart)) applyAutostartSetting();
  if (changed(next, prev, (s) => s.general.globalShortcuts)) registerGlobalShortcuts();
  if (changed(next, prev, (s) => s.language)) {
    safe('tray.refreshMenu', () => ctx.tray.refreshMenu());
    safe('application menu', setApplicationMenu);
  }
  if (changed(next, prev, (s) => s.meeting && s.meeting.autoDetect) && ctx.meeting) {
    // The scheduler forgets the meeting state when detection is switched off → on: re-send the current value
    // right away (covers a probe that is still in flight) and probe again.
    if ((next.meeting || {}).autoDetect !== false && typeof ctx.scheduler.setMeetingActive === 'function') {
      safe('scheduler.setMeetingActive', () => ctx.scheduler.setMeetingActive(ctx.meeting.isActive()));
    }
    ctx.meeting.checkNow().catch((err) => logError('meeting.checkNow', err));
  }
  // §12: interval / autoCheck / prerelease changes reschedule and reconfigure the update check.
  if (changed(next, prev, (s) => JSON.stringify(s.updates || null))) {
    safe('updater.onSettingsChanged', () => ctx.updater.onSettingsChanged(next, prev));
  }
  const state = currentState();
  safe('tray.update', () => ctx.tray.update(state, next));
  safe('widget peek', () => updateWidgetPeek(state));
}

function wireScheduler() {
  const { scheduler, windows } = ctx;
  if (isDev) {
    const events = [
      'warning', 'break-start', 'break-end', 'hydration-reminder', 'natural-break', 'meeting-deferred', 'meeting-defer-expired',
    ];
    for (const name of events) {
      scheduler.on(name, (info) => logInfo(`${TAG}[dev] scheduler ${name}`, info));
    }
  }
  scheduler.on('state', (state) => safe('state handler', () => onSchedulerState(state)));
  scheduler.on('warning', (info) =>
    safe('warning handler', () => {
      const state = currentState();
      if (state && state.phase === 'work') ctx.notifier.warning(info);
    }));
  scheduler.on('break-start', (info) => safe('break-start handler', () => onBreakStart(info)));
  scheduler.on('break-end', (info) => safe('break-end handler', () => onBreakEnd(info)));
  scheduler.on('hydration-reminder', (info) =>
    safe('hydration handler', () => {
      if (!windows.hasOverlays()) ctx.notifier.hydration(info);
    }));
  scheduler.on('meeting-deferred', (info) =>
    safe('meeting-deferred handler', () => {
      if (typeof ctx.notifier.meetingDeferred === 'function') ctx.notifier.meetingDeferred({ type: info && info.type });
    }));
  // §10: a meeting deferred the break for ≥ 2 h – the break now follows the normal warning path.
  scheduler.on('meeting-defer-expired', (info) =>
    safe('meeting-defer-expired handler', () => {
      if (typeof ctx.notifier.meetingDeferExpired === 'function') ctx.notifier.meetingDeferExpired(info || {});
    }));
}

/**
 * §10: Esc on the break screen – handled in main so it works even with a broken overlay page.
 * §11: does nothing during a mandatory break (windows.js does not even call this then).
 */
function onOverlayEscape() {
  const state = currentState();
  if (!state || state.phase !== 'break') return;
  if (isStrictBreakActive(state)) {
    if (isDev) logInfo(`${TAG}[dev] Esc ignored: mandatory break`);
    return;
  }
  performAction('snooze', undefined, 'overlay-esc');
}

/** §10: the break screen was closed because it failed – keep the (still running) break visible via the widget. */
function onOverlayFailure(reason) {
  ctx.overlayFailed = true;
  logWarn(`break screen closed (fail-open): ${reason}`);
  safe('widget peek', () => updateWidgetPeek(currentState()));
}

function wirePowerMonitor() {
  const { scheduler } = ctx;
  const call = (method) => () => safe(`scheduler.${method}`, () => scheduler[method]());
  powerMonitor.on('lock-screen', call('onLock'));
  powerMonitor.on('unlock-screen', () => {
    call('onUnlock')();
    safe('rearm break deadline', rearmBreakDeadline);
  });
  powerMonitor.on('suspend', () => {
    call('onSuspend')();
    flushStats();
  });
  // H1: the scheduler credits the suspended wall-clock time to the break, so the deadline taken at break
  // start would now be too early → take it again from the (already advanced) state. It can only move later.
  powerMonitor.on('resume', () => {
    call('onResume')();
    safe('rearm break deadline', rearmBreakDeadline);
  });
  // Linux / macOS: system shutdown or logout – the only powerMonitor signal that proves a real session end.
  powerMonitor.on('shutdown', (event) => {
    onSystemShutdown('shutdown', true);
    if (event && typeof event.preventDefault === 'function') event.preventDefault(); // delay shutdown until we quit
    app.quit();
  });
}

/**
 * §12: the update check – the only outgoing network request of the app, switchable via
 * `settings.updates.autoCheck`. Everything it decides lives in update-util.js / updater.js; main only
 * hands in the dependencies, pushes the state on `ap:update` and keeps the tray in sync.
 * A broken or missing updater module must never stop the app (NOOP_UPDATER).
 */
function wireUpdater() {
  const { createUpdater } = optionalRequire('./updater', { createUpdater: null });
  if (typeof createUpdater !== 'function') return;
  const updater = safe(
    'updater',
    () =>
      createUpdater({
        app,
        settings: { get: getSettings },
        getState: currentState,
        onState: (update) => safe('update state', () => onUpdateState(update)),
        notifier: { updateAvailable: (info) => ctx.notifier.updateAvailable(info) },
        // the allowlist (§12) is checked inside the updater before anything reaches the shell
        shellOpen: (url) => shell.openExternal(url),
        net,
        // few and far between (one line per check at most) and the only diagnostics for a failing
        // update check or a missing electron-updater – so not gated behind --dev
        log: (...args) => logInfo(`${TAG}[update]`, ...args),
        isStrictBreak: () => isStrictBreakActive(),
        isBreakRunning,
        // quitAndInstall() must not lose the day's statistics
        prepareQuit: () => {
          ctx.quitting = true;
          if (ctx.windows) safe('windows.setQuitting', () => ctx.windows.setQuitting(true));
          flushStats();
        },
      }),
    null,
  );
  if (!updater) return;
  ctx.updater = withDefaults(updater, NOOP_UPDATER);
  safe('updater.start', () => ctx.updater.start());
}

/** §12: push the update state to the renderers and refresh the tray tooltip / menu. */
function onUpdateState(update) {
  ctx.windows.broadcast(IPC.UPDATE, update);
  safe('tray.update', () => ctx.tray.update(currentState(), ctx.settings));
}

function wireMeetingDetector() {
  const { createMeetingDetector } = optionalRequire('./meeting', { createMeetingDetector: null });
  if (typeof createMeetingDetector !== 'function') return;
  ctx.meeting = safe(
    'meeting detector',
    () =>
      createMeetingDetector({
        platform: process.platform,
        getState: currentState,
        getSettings,
        isStrictBreak: () => isStrictBreakActive(),
        onChange: (active) => {
          if (typeof ctx.scheduler.setMeetingActive === 'function') {
            safe('scheduler.setMeetingActive', () => ctx.scheduler.setMeetingActive(active));
          } else {
            logWarn('scheduler.setMeetingActive is not available – meeting detection has no effect');
          }
        },
        log: isDev ? (...args) => logInfo(`${TAG}[meeting]`, ...args) : undefined,
      }),
    null,
  );
  if (ctx.meeting) ctx.meeting.start();
}

function wasLaunchedHidden() {
  if (process.argv.includes('--hidden')) return true;
  if (process.platform === 'darwin') {
    return safe('getLoginItemSettings', () => app.getLoginItemSettings().wasOpenedAtLogin === true, false);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Startup

async function bootstrap() {
  registerAppProtocol();
  hardenSession(session.defaultSession, { isDev });

  // [CORE] – required
  const { createSettingsStore } = require('./settings');
  const { createStatsStore } = require('./stats');
  const { Scheduler } = require('./scheduler');
  const { createWindowManager } = require('./windows');
  const { registerIpc } = require('./ipc');

  const userData = app.getPath('userData');
  ctx.settingsStore = createSettingsStore({ filePath: path.join(userData, 'settings.json') });
  ctx.stats = createStatsStore({ filePath: path.join(userData, 'stats.json') });
  ctx.settings = ctx.settingsStore.get();
  safe('nativeTheme', () => {
    nativeTheme.themeSource = (ctx.settings.appearance || {}).theme || 'system';
  });

  // [MAIN-UX] – optional
  for (const name of Object.keys(FALLBACK)) {
    ctx.modules[name] = optionalRequire(`./${name}`, FALLBACK[name]);
  }
  ctx.i18n = withDefaults(
    safe('i18n', () => ctx.modules.i18n.createMainI18n(() => ctx.settings.language, () => app.getLocale()), null),
    { t: (key) => String(key), lang: () => 'en' },
  );

  ctx.breakStore = createBreakStore(path.join(userData, 'session.json'));
  ctx.scheduler = new Scheduler({
    getSettings,
    stats: ctx.stats,
    now: Date.now,
    monotonicNow: monoNow,
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    // §11: a mandatory break survives a killed app (compact JSON, no fsync – saved every few seconds)
    breakStore: ctx.breakStore,
  });

  const iconFile = path.join(ASSETS_DIR, 'icon.png');
  ctx.windows = createWindowManager({
    preloadPath: PRELOAD_PATH,
    getSettings,
    isDev,
    iconPath: fs.existsSync(iconFile) ? iconFile : null,
    onWidgetMoved: (position) => updateSettings({ widget: { position } }, 'widget-drag'),
    onWidgetCloseRequested: () => performAction('hide-widget', undefined, 'widget-close'),
    onSessionEnd: onWindowsSessionEnd,
    onOverlayEscape,
    onOverlayFailure,
    isStrictBreak: () => isStrictBreakActive(),
  });

  setApplicationMenu();

  ctx.notifier = withDefaults(
    safe(
      'notifier',
      () =>
        ctx.modules.notifications.createNotifier({
          t,
          getSettings,
          assetsDir: ASSETS_DIR,
          onAction: performAction,
          isStrictBreak: () => isStrictBreakActive(),
        }),
      null,
    ),
    NOOP_NOTIFIER,
  );
  const tray = safe(
    'tray',
    () =>
      ctx.modules.tray.createTray({
        assetsDir: ASSETS_DIR,
        t,
        getState: currentState,
        getSettings,
        getUpdate: () => ctx.updater.getUpdateState(),
        onAction: performAction,
        onSettings: (patch) => updateSettings(patch, 'tray'),
        isStrictBreak: (state) => isStrictBreakActive(state),
      }),
    null,
  );
  const hasTray = Boolean(tray && typeof tray === 'object');
  ctx.tray = hasTray ? withDefaults(tray, NOOP_TRAY) : NOOP_TRAY;

  ctx.ipc = registerIpc({
    settingsStore: ctx.settingsStore,
    stats: ctx.stats,
    scheduler: ctx.scheduler,
    windows: ctx.windows,
    performAction,
    getLang: () => ctx.i18n.lang(),
    buildContextMenuTemplate,
    getSettings,
    getUpdateState: () => ctx.updater.getUpdateState(),
    updateSettings,
    isStrictBreakActive: () => isStrictBreakActive(),
    isBreakRunning,
  });

  wireUpdater();

  ctx.settingsStore.on('change', (next, prev) => safe('settings change handler', () => onSettingsChange(next, prev)));
  ctx.stats.on('change', (today) => safe('stats change handler', () => ctx.windows.broadcast(IPC.STATS, today)));
  wireScheduler();
  wirePowerMonitor();
  registerGlobalShortcuts();
  if (app.isPackaged) applyAutostartSetting(); // keep the login item in sync with the installed path

  ctx.ready = true;
  // May resume a persisted mandatory break: 'break-start' { resumed: true } is emitted inside start() → the
  // listeners above open the overlays right away.
  ctx.scheduler.start();
  wireMeetingDetector();
  ctx.safetyTimer = setInterval(() => safe('break safety net', checkBreakSafety), SAFETY_CHECK_INTERVAL_MS);

  // macOS: tray-first app – the dock icon only shows while the dashboard is visible.
  if (process.platform === 'darwin' && app.dock) safe('dock.hide', () => app.dock.hide());

  const widgetVisible = (ctx.settings.widget || {}).visible !== false;
  if (widgetVisible) ctx.windows.createWidget();

  const hidden = wasLaunchedHidden();
  const firstRun = ctx.settingsStore.isFirstRun === true;
  if (ctx.pendingDashboard || (!hidden && (firstRun || (!widgetVisible && !hasTray)))) {
    ctx.pendingDashboard = false;
    if (!isStrictBreakActive()) ctx.windows.openDashboard('overview');
  }
  safe('tray.update', () => ctx.tray.update(currentState(), ctx.settings));
}

if (preReady()) {
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      logError('startup failed', err);
      safe('error dialog', () => dialog.showErrorBox('AugenPause', `AugenPause could not start:\n\n${err && err.message}`));
      app.exit(1);
    });
}
