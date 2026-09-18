'use strict';

/**
 * Window manager – floating widget, dashboard and break overlays (docs/ARCHITECTURE.md §6, §9, §10, §11).
 *
 *   const windows = createWindowManager({ preloadPath, getSettings, isDev, onWidgetMoved,
 *                                         iconPath?, onSessionEnd?, onWidgetCloseRequested?,
 *                                         onOverlayEscape?, onOverlayFailure?, isStrictBreak?, log? });
 *
 * Break screen (overlay) windows are TRANSPARENT (§11): the page paints a dark tint (alpha ≥ 0.2) over the desktop,
 * so the user sees the desktop but every mouse click lands on the overlay.
 *
 * Break screen fail-open (§10) – only for NON-strict breaks:
 *   - Escape in an overlay is handled here (before-input-event) → onOverlayEscape(); the page never sees it,
 *     so Esc works even when the overlay page is broken and never snoozes twice.
 *   - An overlay is "ready" once its page asked for the snapshot (ipc.js → markOverlayReady). If the primary
 *     overlay is not ready OVERLAY_READY_TIMEOUT_MS after openOverlays(), or any overlay fails to load, or its
 *     renderer is gone beyond the reload budget → all overlays close immediately, the widget comes back,
 *     console.error, onOverlayFailure(reason).
 *
 * Mandatory break (§11, isStrictBreak() true):
 *   - Escape is swallowed without snoozing.
 *   - No fail-open: a broken overlay page is reloaded (budget OVERLAY_MAX_RELOADS per window); when it is still
 *     broken the window stays (tinted via its background colour) until main closes the overlays at break end.
 *   - Closing overlay windows is prevented while the break runs (all breaks).
 *
 * Focus watchdog (§11, all breaks, while overlays are open): every WATCHDOG_INTERVAL_MS and right after an overlay
 * blurs / hides / minimizes / closes it recreates missing overlays, shows hidden ones, re-asserts the
 * 'screen-saver' level + moveTop() and focuses the primary overlay when none of them has focus (max
 * MAX_REFOCUS_PER_SECOND attempts per second; Windows: always-on-top toggle after repeated misses).
 * The event-driven passes are coalesced (WATCHDOG_COALESCE_MS) and rate limited
 * (MAX_WATCHDOG_RUNS_PER_SECOND), and a pass only touches windows that are actually misplaced
 * (overlayWatchdogPlan) – raising a window can blur a sibling, whose 'blur' would ask for the next pass.
 *
 * Electron is required inside the factory, so the pure geometry / input helpers exported at the
 * bottom can be unit-tested with plain Node.
 */

const {
  APP_ORIGIN,
  DASHBOARD_TABS,
  IPC,
  WIDGET_PADDING,
  widgetWindowSize,
} = require('./constants');

const WIDGET_MARGIN = 24;
const TRANSPARENT = '#00000000';
const DASHBOARD_BOUNDS = Object.freeze({ width: 1040, height: 720, minWidth: 860, minHeight: 600 });
const THEME_COLORS = Object.freeze({
  dark: Object.freeze({ background: '#0b1020', overlay: Object.freeze({ color: '#0b1020', symbolColor: '#e8ecf6', height: 44 }) }),
  light: Object.freeze({ background: '#f4f6fb', overlay: Object.freeze({ color: '#f4f6fb', symbolColor: '#0f172a', height: 44 }) }),
});
const NAVIGATE_RESEND_MS = 400;
const MAX_RENDERER_RELOADS = 5;
/** §11: reload budget of one break overlay window (crashes, load failures and missed ready timeouts together). */
const OVERLAY_MAX_RELOADS = 3;
const OVERLAY_RELOAD_DELAY_MS = 500;
/** §11: background of a strict-break overlay whose page stays broken (#AARRGGBB, alpha 0x99 = 0.6). */
const BROKEN_OVERLAY_TINT = '#990b1020';
/** §11 focus watchdog */
const WATCHDOG_INTERVAL_MS = 400;
const MAX_REFOCUS_PER_SECOND = 10;
/**
 * A watchdog pass can itself blur / raise overlay windows, and on some window managers that produces the
 * very 'blur' event that asks for the next pass. The event-driven path is therefore coalesced into one
 * pending timer (WATCHDOG_COALESCE_MS) and rate limited (MAX_WATCHDOG_RUNS_PER_SECOND) – otherwise the
 * feedback loop would spin setImmediate at 100 % CPU for the whole break.
 */
const WATCHDOG_COALESCE_MS = 50;
const MAX_WATCHDOG_RUNS_PER_SECOND = 10;
/** Windows: after this many consecutive checks without focus, toggle always-on-top before focusing. */
const TOPMOST_TOGGLE_AFTER_MISSES = 3;
const TOPMOST_TOGGLE_MIN_INTERVAL_MS = 2000;
const ON_TOP_CHECK_MS = 2000;
const READY_FALLBACK_MS = 500;
const READY_HARD_TIMEOUT_MS = 5000;
/** §10: the primary overlay must have requested its snapshot within this time, otherwise the break screen closes. */
const OVERLAY_READY_TIMEOUT_MS = 10000;
const ERR_ABORTED = -3;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no electron)

function rectContainsPoint(rect, point) {
  return (
    point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
  );
}

function distanceToRect(rect, point) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** Moves `rect` so it lies completely inside `area` (top/left edge wins when it is larger). Integers. */
function clampRectToArea(rect, area) {
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height));
  return { x: Math.round(x), y: Math.round(y), width: rect.width, height: rect.height };
}

/** Clock centre of a widget window (clock centred horizontally, WIDGET_PADDING below the top edge). */
function widgetClockCentre(bounds, clock) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + WIDGET_PADDING + clock / 2 };
}

/** Display whose bounds contain `point`, otherwise the nearest one (null for an empty list). */
function nearestDisplay(displays, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const display of displays || []) {
    const distance = distanceToRect(display.bounds, point);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

/** Default widget bounds: top-right corner of the work area, WIDGET_MARGIN px margin. */
function defaultWidgetBounds(workArea, size) {
  return clampRectToArea(
    {
      x: workArea.x + workArea.width - size.width - WIDGET_MARGIN,
      y: workArea.y + WIDGET_MARGIN,
      width: size.width,
      height: size.height,
    },
    workArea,
  );
}

/**
 * Widget bounds for a saved position: used when the clock centre lies on a connected display
 * (then clamped into that display's work area), otherwise the default corner of the primary display.
 * @param {{x:number,y:number}|null} position
 * @param {{clock:number,width:number,height:number}} size widgetWindowSize()
 * @param {Array<{bounds:object, workArea:object}>} displays
 * @param {{workArea:object}} primary
 */
function resolveWidgetBounds(position, size, displays, primary) {
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    const rect = { x: Math.round(position.x), y: Math.round(position.y), width: size.width, height: size.height };
    const centre = widgetClockCentre(rect, size.clock);
    const display = (displays || []).find((d) => rectContainsPoint(d.bounds, centre));
    if (display) return clampRectToArea(rect, display.workArea);
  }
  return defaultWidgetBounds(primary.workArea, size);
}

/** Bounds after a widget size change that keep the clock centre where it was. */
function resizeKeepingClockCentre(bounds, oldClock, newSize) {
  const centre = widgetClockCentre(bounds, oldClock);
  return {
    x: Math.round(centre.x - newSize.width / 2),
    y: Math.round(centre.y - WIDGET_PADDING - newSize.clock / 2),
    width: newSize.width,
    height: newSize.height,
  };
}

/**
 * Keyboard input swallowed by break overlays: Alt+F4, Ctrl/Cmd+W, Cmd+Q, Cmd+H, Cmd+M, F11.
 * Escape is not part of this list: main consumes it and snoozes (§10, see overlayEscapeAction) – never during a
 * mandatory break (§11).
 * OS security shortcuts (Ctrl+Alt+Del, Win+L, Cmd+Ctrl+Q) cannot and must not be blocked.
 */
function isBlockedOverlayInput(input) {
  if (!input) return false;
  if (input.key === 'Escape') return false; // handled separately (isOverlayEscape)
  const key = String(input.key || '');
  const lower = key.toLowerCase();
  const code = String(input.code || '');
  const is = (letter) => lower === letter || code === `Key${letter.toUpperCase()}`;
  if (key === 'F4' && input.alt) return true;
  if (key === 'F11') return true;
  if ((input.control || input.meta) && is('w')) return true;
  if (input.meta && (is('q') || is('h') || is('m'))) return true;
  return false;
}

/**
 * §10: Escape during a break is consumed by main (keyDown and keyUp, so the page never sees it).
 * @returns {'snooze'|'swallow'|null} 'snooze' for a fresh keyDown, 'swallow' for keyUp / auto-repeat, null otherwise
 */
function overlayEscapeAction(input) {
  if (!input || input.key !== 'Escape') return null;
  if (input.type === 'keyDown' && !input.isAutoRepeat) return 'snooze';
  return 'swallow';
}

/**
 * BrowserWindow options of a break overlay (§6 + §11): transparent, no shadow, frameless, covering `bounds`.
 * @param {{x:number,y:number,width:number,height:number}} bounds display bounds
 * @param {object} webPreferences
 */
function overlayWindowOptions(bounds, webPreferences) {
  return {
    ...bounds,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: TRANSPARENT,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    focusable: true,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    enableLargerThanScreen: true,
    title: 'AugenPause',
    webPreferences,
  };
}

/**
 * Sliding-window rate limiter: at most `max` acquisitions within `windowMs`.
 * @returns {{ tryAcquire(now: number): boolean, reset(): void }}
 */
function createRateLimiter(max, windowMs) {
  let stamps = [];
  return {
    tryAcquire(now) {
      stamps = stamps.filter((stamp) => now - stamp < windowMs && stamp <= now);
      if (stamps.length >= max) return false;
      stamps.push(now);
      return true;
    },
    reset() {
      stamps = [];
    },
  };
}

/**
 * Pure decision of one focus-watchdog pass for ONE overlay window (§11, review fix M3).
 *
 * The watchdog used to re-assert `setAlwaysOnTop()` + `moveTop()` on every overlay of every pass. Raising a
 * window can move the focus, on some window managers to another overlay, whose 'blur' event schedules the
 * next pass – an unbounded loop that burns a core for the whole break. So a window that already sits where
 * it belongs (always-on-top, visible, not minimized) is left alone as long as ANY overlay holds the focus;
 * only when the focus is gone (Alt+Tab, Win+D, a foreign window) is the whole stack raised again.
 *
 * @param {{ minimized?: boolean, visible?: boolean, onTop?: boolean, anyOverlayFocused?: boolean }} status
 * @returns {{ restore: boolean, show: boolean, setOnTop: boolean, moveTop: boolean }}
 */
function overlayWatchdogPlan({ minimized = false, visible = true, onTop = true, anyOverlayFocused = false } = {}) {
  const misplaced = minimized === true || visible !== true || onTop !== true;
  return {
    restore: minimized === true,
    show: visible !== true,
    setOnTop: onTop !== true,
    moveTop: misplaced || anyOverlayFocused !== true,
  };
}

function sameBounds(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function samePosition(a, b) {
  if (!a || !b) return a === b || (!a && !b);
  return a.x === b.x && a.y === b.y;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {{
 *   preloadPath: string,
 *   getSettings: () => object,
 *   isDev?: boolean,
 *   onWidgetMoved?: (position: {x:number,y:number}) => void,
 *   onWidgetCloseRequested?: () => void,
 *   onSessionEnd?: (kind: 'session-end'|'query-session-end') => void,
 *   onOverlayEscape?: () => void,
 *   onOverlayFailure?: (reason: string) => void,
 *   isStrictBreak?: () => boolean,
 *   iconPath?: string|null,
 *   log?: (...args: any[]) => void,
 * }} options
 */
function createWindowManager(options = {}) {
  // eslint-disable-next-line global-require
  const { app, BrowserWindow, Menu, nativeTheme, screen } = require('electron');

  const {
    preloadPath,
    getSettings,
    isDev = false,
    onWidgetMoved = () => {},
    onWidgetCloseRequested = null,
    onSessionEnd = () => {},
    onOverlayEscape = () => {},
    onOverlayFailure = () => {},
    isStrictBreak = () => false,
    iconPath = null,
  } = options;
  const log = options.log || ((...args) => console.warn('[AugenPause:windows]', ...args));

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const isWindows = process.platform === 'win32';

  /** §11: main's single strict-break decision. Errors count as strict (fail closed while a break runs). */
  function strictBreak() {
    try {
      return isStrictBreak() === true;
    } catch (err) {
      log('isStrictBreak failed:', err && err.message);
      return true;
    }
  }

  /** @type {Electron.BrowserWindow|null} */
  let widget = null;
  let widgetReady = false;
  let widgetPeek = false;
  let drag = null;

  /** @type {Electron.BrowserWindow|null} */
  let dashboard = null;
  let dashboardReady = false;
  let dashboardLoaded = false;
  let dashboardPendingShow = false;
  let dashboardPendingTab = null;
  let navigateTimer = null;

  /** displayId → { win, displayId, primary, bounds } */
  const overlays = new Map();
  let breakActive = false;
  let closeTimer = null;
  let closeAt = 0;
  let closeWaiters = [];
  let readyTimer = null;
  let watchdogTimer = null;
  let watchdogSoonTimer = null;
  let lastWatchdogRun = 0;
  let focusMisses = 0;
  let lastTopmostToggle = 0;
  const refocusLimiter = createRateLimiter(MAX_REFOCUS_PER_SECOND, 1000);
  const watchdogLimiter = createRateLimiter(MAX_WATCHDOG_RUNS_PER_SECOND, 1000);

  let quitting = false;
  let disposed = false;

  const alive = (win) => Boolean(win && !win.isDestroyed());
  const viewUrl = (view, query = '') => `${APP_ORIGIN}/${view}/index.html${query}`;

  function settings() {
    try {
      return getSettings() || {};
    } catch (err) {
      log('getSettings failed:', err && err.message);
      return {};
    }
  }

  function webPreferences(extra = {}) {
    return {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: Boolean(isDev),
      ...extra,
    };
  }

  /**
   * Calls `callback` once on 'ready-to-show'. That event needs a first visually non-empty paint, so a page
   * that renders nothing (yet) would keep its window hidden forever → fall back shortly after the load
   * finished or failed, and after a hard timeout.
   */
  function whenReadyToShow(win, callback) {
    let done = false;
    let fallbackTimer = null;
    const fire = () => {
      if (done) return;
      done = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
      if (alive(win)) callback();
    };
    const soon = () => {
      if (!done && !fallbackTimer) fallbackTimer = setTimeout(fire, READY_FALLBACK_MS);
    };
    const hardTimer = setTimeout(fire, READY_HARD_TIMEOUT_MS);
    win.once('ready-to-show', fire);
    win.webContents.once('did-finish-load', soon);
    win.webContents.once('did-fail-load', soon);
    win.once('closed', () => {
      done = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
    });
  }

  function load(win, url, name) {
    win.loadURL(url).catch((err) => {
      if (alive(win)) log(`${name}: loading ${url} failed:`, err && err.message);
    });
  }

  /**
   * Hooks shared by all window types.
   * @param {{ onReload?: () => void, onGiveUp?: (reason: string) => void, onLoadFailed?: (reason: string) => void,
   *   budget?: { used: number, max: number } }} [hooks]
   *   onReload: the renderer crashed and is reloaded; onGiveUp: renderer gone for good (clean exit or reload budget
   *   used up); onLoadFailed: the main frame failed to load (not ERR_ABORTED); budget: reload budget (shared with the
   *   caller's own reloads), default MAX_RENDERER_RELOADS.
   */
  function attachCommonHooks(win, name, url, hooks = {}) {
    const wc = win.webContents;
    const budget = hooks.budget || { used: 0, max: MAX_RENDERER_RELOADS };
    const call = (fn, ...args) => {
      if (typeof fn !== 'function') return;
      try {
        fn(...args);
      } catch (err) {
        log(`${name} hook failed:`, err && err.message);
      }
    };

    // Windows only: logoff / shutdown (Electron emits these on BrowserWindow).
    win.on('query-session-end', () => onSessionEnd('query-session-end'));
    win.on('session-end', () => onSessionEnd('session-end'));

    wc.on('render-process-gone', (_event, details) => {
      const reason = details && details.reason;
      log(`${name} renderer gone (${reason})`);
      if (quitting) return;
      if (reason === 'clean-exit' || budget.used >= budget.max) {
        call(hooks.onGiveUp, `renderer gone (${reason}, ${budget.used} reloads)`);
        return;
      }
      budget.used += 1;
      setTimeout(() => {
        if (alive(win) && !quitting) {
          call(hooks.onReload);
          load(win, url(), name);
        }
      }, 500);
    });
    wc.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      log(`${name} failed to load ${failedUrl}: ${code} ${description}`);
      call(hooks.onLoadFailed, `load failed (${code} ${description})`);
    });
    wc.on('preload-error', (_event, preload, err) => log(`${name} preload error in ${preload}:`, err && err.message));

    if (isDev) {
      wc.on('console-message', (event) => {
        const { level, message, lineNumber, sourceId } = event;
        console.log(`[renderer:${name}:${level}] ${message} (${sourceId}:${lineNumber})`);
      });
      wc.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
          event.preventDefault();
          wc.toggleDevTools();
        }
      });
    }
  }

  // ------------------------------------------------------------------------------------------
  // macOS dock: visible only while the dashboard is open

  function dashboardWantsDock() {
    return alive(dashboard) && (dashboard.isVisible() || dashboard.isMinimized());
  }

  function syncDock() {
    if (!isMac || !app.dock) return;
    try {
      const want = dashboardWantsDock();
      const visible = app.dock.isVisible();
      if (want && !visible) {
        const p = app.dock.show();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else if (!want && visible) {
        app.dock.hide();
      }
    } catch (err) {
      log('dock update failed:', err && err.message);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Widget

  function widgetSize() {
    return widgetWindowSize((settings().widget || {}).size);
  }

  function computeWidgetBounds(position) {
    return resolveWidgetBounds(position, widgetSize(), screen.getAllDisplays(), screen.getPrimaryDisplay());
  }

  function setWidgetBounds(bounds) {
    if (!alive(widget)) return;
    if (sameBounds(widget.getBounds(), bounds)) return;
    // setBounds (not setPosition) keeps the DIP size when crossing displays with different scale factors.
    widget.setBounds(bounds);
    if (isLinux) {
      // Some X11 window managers ignore programmatic resizes of non-resizable windows.
      const after = widget.getBounds();
      if (Math.abs(after.width - bounds.width) > 1 || Math.abs(after.height - bounds.height) > 1) {
        widget.setResizable(true);
        widget.setBounds(bounds);
        widget.setResizable(false);
      }
    }
  }

  function applyWidgetAlwaysOnTop() {
    if (!alive(widget)) return;
    const onTop = (settings().widget || {}).alwaysOnTop !== false;
    if (onTop) widget.setAlwaysOnTop(true, 'floating');
    else widget.setAlwaysOnTop(false);
  }

  /**
   * Windows: level 'floating' places the widget directly behind the taskbar. While a fullscreen window
   * (e.g. our overlays or a fullscreen video) is in front, Windows demotes the taskbar from topmost and the
   * widget silently loses its topmost flag as well → re-assert it periodically.
   */
  function healWidgetAlwaysOnTop() {
    if (!alive(widget) || !widget.isVisible() || hasOverlays()) return;
    if ((settings().widget || {}).alwaysOnTop === false) return;
    if (!widget.isAlwaysOnTop()) applyWidgetAlwaysOnTop();
  }

  function shouldShowWidget() {
    const w = settings().widget || {};
    return (w.visible !== false || widgetPeek) && !hasOverlays() && !quitting;
  }

  function createWidget() {
    if (alive(widget)) return widget;
    const s = settings();
    const w = s.widget || {};
    const bounds = computeWidgetBounds(w.position || null);
    widgetReady = false;

    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: TRANSPARENT,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      thickFrame: false,
      roundedCorners: false,
      alwaysOnTop: w.alwaysOnTop !== false,
      title: 'AugenPause',
      webPreferences: webPreferences({ backgroundThrottling: false }),
    });
    widget = win;

    applyWidgetAlwaysOnTop();
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (err) {
      log('widget setVisibleOnAllWorkspaces failed:', err && err.message);
    }
    syncDock(); // setVisibleOnAllWorkspaces(visibleOnFullScreen) hides the dock on macOS

    attachCommonHooks(win, 'widget', () => viewUrl('widget'));
    whenReadyToShow(win, () => {
      widgetReady = true;
      if (shouldShowWidget()) {
        win.showInactive(); // never steal focus
        applyWidgetAlwaysOnTop();
      }
    });
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault(); // e.g. Alt+F4 while the widget has focus
      if (typeof onWidgetCloseRequested === 'function') onWidgetCloseRequested();
      else hideWidget();
    });
    win.on('closed', () => {
      if (widget === win) {
        widget = null;
        widgetReady = false;
        drag = null;
      }
    });

    load(win, viewUrl('widget'), 'widget');
    return win;
  }

  /** Shows the widget (inactive) when settings / peek allow it and no overlay is open. */
  function showWidget() {
    if (!shouldShowWidget()) return false;
    const win = createWidget();
    if (widgetReady && !win.isVisible()) {
      win.showInactive();
      applyWidgetAlwaysOnTop();
    }
    return true;
  }

  function hideWidget() {
    drag = null;
    if (alive(widget) && widget.isVisible()) widget.hide();
  }

  /**
   * §9: temporarily show a widget that is hidden by settings (warning / meeting deferral).
   * Turning the peek off hides it again only when settings still say hidden.
   */
  function setWidgetPeek(flag) {
    const next = Boolean(flag);
    if (next === widgetPeek) return;
    widgetPeek = next;
    if (next) showWidget();
    else if ((settings().widget || {}).visible === false) hideWidget();
  }

  function revalidateWidget() {
    if (!alive(widget) || drag) return;
    setWidgetBounds(computeWidgetBounds((settings().widget || {}).position || null));
  }

  function handleWidgetDrag(phase) {
    if (!alive(widget)) return;
    if (phase === 'start') {
      drag = { cursor: screen.getCursorScreenPoint(), bounds: widget.getBounds(), moved: false };
      return;
    }
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const x = Math.round(drag.bounds.x + cursor.x - drag.cursor.x);
    const y = Math.round(drag.bounds.y + cursor.y - drag.cursor.y);

    if (phase === 'move') {
      if (x !== drag.bounds.x || y !== drag.bounds.y) drag.moved = true;
      widget.setBounds({ x, y, width: drag.bounds.width, height: drag.bounds.height });
      return;
    }
    if (phase === 'end') {
      const start = drag.bounds;
      const moved = drag.moved || x !== start.x || y !== start.y;
      drag = null;
      if (!moved) return;
      const size = widgetSize();
      const rect = { x, y, width: size.width, height: size.height };
      const display = nearestDisplay(screen.getAllDisplays(), widgetClockCentre(rect, size.clock)) || screen.getPrimaryDisplay();
      const final = clampRectToArea(rect, display.workArea);
      setWidgetBounds(final);
      try {
        onWidgetMoved({ x: final.x, y: final.y });
      } catch (err) {
        log('onWidgetMoved failed:', err && err.message);
      }
    }
  }

  function setWidgetInteractive(interactive) {
    if (!alive(widget) || isLinux) return; // click-through with forwarding is not supported on Linux
    if (interactive) widget.setIgnoreMouseEvents(false);
    else widget.setIgnoreMouseEvents(true, { forward: true });
  }

  // ------------------------------------------------------------------------------------------
  // Dashboard

  function themeColors() {
    const theme = (settings().appearance || {}).theme;
    const dark = theme === 'dark' ? true : theme === 'light' ? false : nativeTheme.shouldUseDarkColors;
    return dark ? THEME_COLORS.dark : THEME_COLORS.light;
  }

  function updateDashboardTheme() {
    if (!alive(dashboard)) return;
    const colors = themeColors();
    try {
      dashboard.setBackgroundColor(colors.background);
      if (!isMac && typeof dashboard.setTitleBarOverlay === 'function') {
        dashboard.setTitleBarOverlay({ ...colors.overlay });
      }
    } catch (err) {
      log('dashboard theme update failed:', err && err.message);
    }
  }

  function sendNavigate(tab) {
    if (!alive(dashboard)) return;
    try {
      dashboard.webContents.send(IPC.NAVIGATE, tab);
    } catch (err) {
      log('navigate failed:', err && err.message);
    }
  }

  function navigateDashboard(tab) {
    if (!DASHBOARD_TABS.includes(tab) || !alive(dashboard)) return;
    if (navigateTimer) {
      clearTimeout(navigateTimer);
      navigateTimer = null;
    }
    if (!dashboardLoaded) {
      dashboardPendingTab = tab;
      return;
    }
    sendNavigate(tab);
  }

  function createDashboard() {
    if (alive(dashboard)) return dashboard;
    const colors = themeColors();
    dashboardReady = false;
    dashboardLoaded = false;

    const win = new BrowserWindow({
      ...DASHBOARD_BOUNDS,
      show: false,
      title: 'AugenPause',
      backgroundColor: colors.background,
      titleBarStyle: 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 16, y: 14 } } : { titleBarOverlay: { ...colors.overlay } }),
      ...(iconPath && !isMac ? { icon: iconPath } : {}),
      webPreferences: webPreferences(),
    });
    dashboard = win;

    attachCommonHooks(win, 'dashboard', () => viewUrl('dashboard'));
    whenReadyToShow(win, () => {
      dashboardReady = true;
      if (dashboardPendingShow) {
        dashboardPendingShow = false;
        revealDashboard();
      }
    });
    win.webContents.on('did-finish-load', () => {
      dashboardLoaded = true;
      const tab = dashboardPendingTab;
      dashboardPendingTab = null;
      if (!tab) return;
      sendNavigate(tab);
      // The renderer may subscribe to onNavigate only after its first async getSnapshot() – resend once.
      navigateTimer = setTimeout(() => {
        navigateTimer = null;
        sendNavigate(tab);
      }, NAVIGATE_RESEND_MS);
    });
    win.webContents.on('did-start-loading', () => {
      dashboardLoaded = false;
    });
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault(); // hidden, not destroyed
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => alive(win) && win.hide());
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    });
    win.on('show', syncDock);
    win.on('hide', syncDock);
    win.on('minimize', syncDock);
    win.on('restore', syncDock);
    win.on('closed', () => {
      if (dashboard === win) {
        dashboard = null;
        dashboardReady = false;
        dashboardLoaded = false;
      }
      syncDock();
    });

    load(win, viewUrl('dashboard'), 'dashboard');
    return win;
  }

  function revealDashboard() {
    const win = dashboard;
    if (!alive(win)) return;
    if (isMac && app.dock) {
      try {
        const p = app.dock.show();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (isMac) app.focus({ steal: true });
  }

  function openDashboard(tab) {
    createDashboard();
    if (tab !== undefined && tab !== null) navigateDashboard(tab);
    if (dashboardReady) revealDashboard();
    else dashboardPendingShow = true;
  }

  function isDashboardVisible() {
    return alive(dashboard) && dashboard.isVisible() && !dashboard.isMinimized();
  }

  function toggleDashboard() {
    if (isDashboardVisible()) dashboard.hide();
    else openDashboard();
  }

  // ------------------------------------------------------------------------------------------
  // Break overlays

  function hasOverlays() {
    for (const entry of overlays.values()) if (alive(entry.win)) return true;
    return false;
  }

  function primaryOverlay() {
    let fallback = null;
    for (const entry of overlays.values()) {
      if (!alive(entry.win)) continue;
      if (entry.primary) return entry;
      fallback = fallback || entry;
    }
    return fallback;
  }

  function overlayUrl(entry) {
    return viewUrl('overlay', `?primary=${entry.primary ? 1 : 0}`);
  }

  function focusPrimaryOverlay() {
    const entry = primaryOverlay();
    if (!entry || !entry.win.isVisible()) return;
    const win = entry.win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    if (isMac) app.focus({ steal: true });
    win.focus();
  }

  function overlayTargets() {
    const primary = screen.getPrimaryDisplay();
    const displays = (settings().breaks || {}).allDisplays === false ? [primary] : screen.getAllDisplays();
    return { primaryId: primary.id, displays };
  }

  function destroyOverlayEntry(entry) {
    overlays.delete(entry.displayId);
    if (alive(entry.win)) entry.win.destroy();
  }

  function createOverlay(display, primary) {
    const bounds = { ...display.bounds };
    const win = new BrowserWindow(
      overlayWindowOptions(
        bounds,
        webPreferences({ autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }),
      ),
    );
    const entry = {
      win,
      displayId: display.id,
      primary,
      bounds,
      ready: false,
      /** shown once (ready-to-show); only then the watchdog re-shows it */
      shown: false,
      /** §11: page still broken after the reload budget – tinted window kept until the break ends */
      broken: false,
      budget: { used: 0, max: OVERLAY_MAX_RELOADS },
    };
    overlays.set(display.id, entry);

    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (err) {
      log('overlay setVisibleOnAllWorkspaces failed:', err && err.message);
    }

    attachCommonHooks(win, 'overlay', () => overlayUrl(entry), {
      budget: entry.budget,
      onReload: () => {
        entry.ready = false;
        if (entry.primary && breakActive) armReadyTimer();
      },
      onGiveUp: (reason) => handleOverlayFailure(entry, reason),
      onLoadFailed: (reason) => handleOverlayFailure(entry, reason),
    });
    win.on('close', (event) => {
      if (breakActive && !quitting) event.preventDefault();
    });
    // §11 watchdog: react right away when an overlay loses focus / visibility.
    win.on('blur', runWatchdogSoon);
    win.on('hide', runWatchdogSoon);
    win.on('minimize', runWatchdogSoon);
    win.webContents.on('before-input-event', (event, input) => {
      if (!breakActive || quitting) return;
      const escape = overlayEscapeAction(input);
      if (escape) {
        // §10: main is the single source of Esc → snooze (works with a broken page, never twice).
        // §11: during a mandatory break Esc is swallowed and does nothing.
        event.preventDefault();
        if (escape === 'snooze' && !strictBreak()) {
          try {
            onOverlayEscape();
          } catch (err) {
            log('onOverlayEscape failed:', err && err.message);
          }
        }
        return;
      }
      if (isBlockedOverlayInput(input)) event.preventDefault();
    });
    whenReadyToShow(win, () => {
      entry.shown = true;
      if (entry.primary) win.show();
      else win.showInactive();
      // Re-apply bounds after show: Windows may mis-size windows created on a display with another scale factor.
      win.setBounds(entry.bounds);
      if (isLinux) win.setFullScreen(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      if (entry.primary) focusPrimaryOverlay();
    });
    win.on('closed', () => {
      const current = overlays.get(entry.displayId);
      if (current && current.win === win) overlays.delete(entry.displayId);
      runWatchdogSoon(); // a break screen that disappeared during a break is recreated
    });

    load(win, overlayUrl(entry), 'overlay');
    return entry;
  }

  /** Makes sure every target display has exactly one overlay with the right primary flag. */
  function reconcileOverlays() {
    const { primaryId, displays } = overlayTargets();
    const targetIds = new Set(displays.map((d) => d.id));
    for (const entry of [...overlays.values()]) {
      if (!alive(entry.win) || !targetIds.has(entry.displayId)) destroyOverlayEntry(entry);
    }
    for (const display of displays) {
      const isPrimary = display.id === primaryId;
      const entry = overlays.get(display.id);
      if (!entry) {
        createOverlay(display, isPrimary);
        if (isPrimary && breakActive && !readyTimer) armReadyTimer();
        continue;
      }
      if (!sameBounds(entry.bounds, display.bounds)) {
        entry.bounds = { ...display.bounds };
        if (!(isLinux && entry.win.isFullScreen())) entry.win.setBounds(entry.bounds);
      }
      if (entry.primary !== isPrimary) {
        entry.primary = isPrimary;
        entry.ready = false;
        load(entry.win, overlayUrl(entry), 'overlay');
        if (isPrimary) armReadyTimer();
      }
    }
  }

  // ---- focus watchdog (§11) -----------------------------------------------------------------

  function startWatchdog() {
    if (watchdogTimer) return;
    focusMisses = 0;
    refocusLimiter.reset();
    watchdogLimiter.reset();
    watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (watchdogSoonTimer) clearTimeout(watchdogSoonTimer);
    watchdogTimer = null;
    watchdogSoonTimer = null;
    focusMisses = 0;
  }

  /**
   * Event-driven pass (an overlay blurred / was hidden / minimized / closed), coalesced and rate limited:
   * one pending timer at a time, never sooner than WATCHDOG_COALESCE_MS after the last pass and at most
   * MAX_WATCHDOG_RUNS_PER_SECOND times per second. The WATCHDOG_INTERVAL_MS interval keeps running
   * either way, so dropping a pass only delays it.
   */
  function runWatchdogSoon() {
    if (!breakActive || quitting || disposed || watchdogSoonTimer) return;
    const wait = Math.max(0, WATCHDOG_COALESCE_MS - (Date.now() - lastWatchdogRun));
    watchdogSoonTimer = setTimeout(() => {
      watchdogSoonTimer = null;
      if (!breakActive || quitting || disposed) return;
      if (!watchdogLimiter.tryAcquire(Date.now())) return;
      runWatchdog();
    }, wait);
  }

  function runWatchdog() {
    if (!breakActive || quitting || disposed) {
      stopWatchdog();
      return;
    }
    lastWatchdogRun = Date.now();
    try {
      reconcileOverlays(); // recreates destroyed overlays, covers newly connected displays
    } catch (err) {
      log('watchdog reconcile failed:', err && err.message);
    }
    // 1. read the state of every overlay first – whether a pass has to act at all depends on the others
    //    (an overlay that is on top and visible while a sibling has the focus is exactly where we want it).
    const live = [];
    let focused = false;
    for (const entry of overlays.values()) {
      const win = entry.win;
      if (!alive(win) || !entry.shown) continue; // not shown yet → whenReadyToShow does it
      try {
        const status = {
          entry,
          win,
          minimized: win.isMinimized(),
          visible: win.isVisible(),
          onTop: win.isAlwaysOnTop(),
          focused: win.isFocused(),
        };
        if (status.focused) focused = true;
        live.push(status);
      } catch (err) {
        log('watchdog check failed:', err && err.message);
      }
    }
    // 2. only touch what is actually wrong: an unconditional setAlwaysOnTop() + moveTop() can blur another
    //    overlay (some Linux WMs), and that blur would schedule the next pass → busy loop (M3).
    for (const status of live) {
      const plan = overlayWatchdogPlan({ ...status, anyOverlayFocused: focused });
      try {
        if (plan.restore) status.win.restore();
        if (plan.show) {
          if (status.entry.primary) status.win.show();
          else status.win.showInactive();
        }
        if (plan.setOnTop) status.win.setAlwaysOnTop(true, 'screen-saver');
        if (plan.moveTop) status.win.moveTop();
      } catch (err) {
        log('watchdog check failed:', err && err.message);
      }
    }
    if (focused) {
      focusMisses = 0;
      return;
    }
    refocusPrimaryOverlay();
  }

  function refocusPrimaryOverlay() {
    const entry = primaryOverlay();
    if (!entry || !entry.shown || !entry.win.isVisible()) return;
    const now = Date.now();
    if (!refocusLimiter.tryAcquire(now)) return;
    focusMisses += 1;
    const win = entry.win;
    try {
      if (isWindows && focusMisses >= TOPMOST_TOGGLE_AFTER_MISSES && now - lastTopmostToggle >= TOPMOST_TOGGLE_MIN_INTERVAL_MS) {
        // Windows may refuse SetForegroundWindow repeatedly – re-inserting the window into the topmost band helps.
        lastTopmostToggle = now;
        win.setAlwaysOnTop(false);
        win.setAlwaysOnTop(true, 'screen-saver');
      }
      win.moveTop();
      if (isMac) app.focus({ steal: true });
      win.focus();
    } catch (err) {
      log('refocus failed:', err && err.message);
    }
  }

  /** Brings the break screen to the front (e.g. a second app instance was started during a mandatory break). */
  function focusOverlays() {
    if (!breakActive || !hasOverlays()) return false;
    runWatchdog();
    focusPrimaryOverlay();
    return true;
  }

  // ---- overlay failures: fail-open (§10) / fail-closed in a mandatory break (§11) ----------

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  /** (Re)starts the readiness check for the primary overlay. */
  function armReadyTimer() {
    clearReadyTimer();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!breakActive || quitting || disposed) return;
      const entry = primaryOverlay();
      if (entry && (entry.ready || entry.broken)) return;
      const reason = entry ? `primary overlay not ready after ${OVERLAY_READY_TIMEOUT_MS / 1000} s` : 'no overlay window';
      if (entry) handleOverlayFailure(entry, reason);
      else if (!strictBreak()) failOpen(reason);
    }, OVERLAY_READY_TIMEOUT_MS);
  }

  /** Called by ipc.js when an overlay page requested its snapshot. @returns {boolean} */
  function markOverlayReady(wc) {
    if (!wc || typeof wc.id !== 'number') return false;
    for (const entry of overlays.values()) {
      if (alive(entry.win) && entry.win.webContents.id === wc.id) {
        entry.ready = true;
        return true;
      }
    }
    return false;
  }

  /**
   * An overlay page failed (load failure, renderer gone after its crash reloads, not ready in time).
   * Non-strict break → fail-open. Mandatory break → reload within the window's budget, then keep the tinted window.
   */
  function handleOverlayFailure(entry, reason) {
    if (!breakActive || quitting || disposed) return;
    if (!strictBreak()) {
      failOpen(reason);
      return;
    }
    if (!alive(entry.win) || entry.broken) return; // a destroyed window is recreated by the watchdog
    if (entry.budget.used < entry.budget.max) {
      entry.budget.used += 1;
      entry.ready = false;
      console.error(
        `[AugenPause:windows] break overlay failed (${reason}) – mandatory break: reloading ` +
          `(${entry.budget.used}/${entry.budget.max}), the break screen stays`,
      );
      setTimeout(() => {
        if (!alive(entry.win) || !breakActive || quitting || disposed) return;
        load(entry.win, overlayUrl(entry), 'overlay');
        if (entry.primary) armReadyTimer();
      }, OVERLAY_RELOAD_DELAY_MS);
      return;
    }
    entry.broken = true;
    console.error(
      `[AugenPause:windows] break overlay still broken (${reason}) – mandatory break: keeping the tinted break ` +
        'screen until the break ends',
    );
    try {
      entry.win.setBackgroundColor(BROKEN_OVERLAY_TINT); // the page paints nothing – keep the screen visibly locked
      if (!entry.win.isVisible()) {
        if (entry.primary) entry.win.show();
        else entry.win.showInactive();
      }
      entry.shown = true;
    } catch (err) {
      log('keeping the broken overlay failed:', err && err.message);
    }
  }

  /** A broken break screen of a NON-strict break must never lock the user out: close everything, widget back. */
  function failOpen(reason) {
    if (!breakActive || quitting || disposed) return;
    console.error(`[AugenPause:windows] break overlay failed – closing the break screen (fail-open): ${reason}`);
    closeOverlays(0)
      .then((closed) => {
        if (closed) showWidget();
        onOverlayFailure(reason);
      })
      .catch((err) => log('fail-open failed:', err && err.message));
  }

  function flushCloseWaiters(result) {
    const waiters = closeWaiters;
    closeWaiters = [];
    for (const resolve of waiters) resolve(result);
  }

  function openOverlays() {
    breakActive = true;
    if (closeTimer) {
      // A new break started while the previous overlays were still showing their "done" state.
      clearTimeout(closeTimer);
      closeTimer = null;
      flushCloseWaiters(false);
    }
    reconcileOverlays();
    if (hasOverlays()) focusPrimaryOverlay();
    armReadyTimer();
    startWatchdog();
  }

  /**
   * Allows closing immediately and destroys all overlays after `delayMs`.
   * @returns {Promise<boolean>} true once destroyed, false when a new break re-used them.
   */
  function closeOverlays(delayMs = 0) {
    breakActive = false;
    clearReadyTimer();
    stopWatchdog();
    if (!hasOverlays()) {
      overlays.clear();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      closeWaiters.push(resolve);
      const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
      const at = Date.now() + delay;
      if (closeTimer && closeAt <= at) return; // an earlier close is already scheduled
      if (closeTimer) clearTimeout(closeTimer);
      closeAt = at;
      closeTimer = setTimeout(() => {
        closeTimer = null;
        for (const entry of [...overlays.values()]) destroyOverlayEntry(entry);
        syncDock();
        flushCloseWaiters(true);
      }, delay);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Settings, displays, broadcast, IPC helpers

  function applySettings(next, prev) {
    const w = (next && next.widget) || {};
    const pw = (prev && prev.widget) || {};

    if (w.visible !== pw.visible) {
      if (w.visible !== false) showWidget();
      else if (!widgetPeek) hideWidget();
    }

    if (alive(widget)) {
      if (w.alwaysOnTop !== pw.alwaysOnTop) applyWidgetAlwaysOnTop();
      if (w.size !== pw.size) {
        const newSize = widgetWindowSize(w.size);
        if (w.position) {
          const rect = resizeKeepingClockCentre(widget.getBounds(), widgetWindowSize(pw.size).clock, newSize);
          const display =
            nearestDisplay(screen.getAllDisplays(), widgetClockCentre(rect, newSize.clock)) || screen.getPrimaryDisplay();
          const final = clampRectToArea(rect, display.workArea);
          setWidgetBounds(final);
          if (final.x !== w.position.x || final.y !== w.position.y) onWidgetMoved({ x: final.x, y: final.y });
        } else {
          setWidgetBounds(computeWidgetBounds(null));
        }
      } else if (!samePosition(w.position, pw.position) && !drag) {
        setWidgetBounds(computeWidgetBounds(w.position || null));
      }
    }

    const theme = next && next.appearance && next.appearance.theme;
    const prevTheme = prev && prev.appearance && prev.appearance.theme;
    if (theme !== prevTheme) updateDashboardTheme();
  }

  function onDisplaysChanged() {
    if (disposed) return;
    try {
      if (breakActive && hasOverlays()) reconcileOverlays();
      revalidateWidget();
    } catch (err) {
      log('display change handling failed:', err && err.message);
    }
  }

  const onThemeUpdated = () => updateDashboardTheme();
  const healTimer = setInterval(() => {
    try {
      healWidgetAlwaysOnTop();
    } catch (err) {
      log('always-on-top check failed:', err && err.message);
    }
  }, ON_TOP_CHECK_MS);
  if (typeof healTimer.unref === 'function') healTimer.unref();
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
  nativeTheme.on('updated', onThemeUpdated);

  function allWindows() {
    const list = [widget, dashboard];
    for (const entry of overlays.values()) list.push(entry.win);
    return list.filter(alive);
  }

  function broadcast(channel, payload) {
    for (const win of allWindows()) {
      const wc = win.webContents;
      if (!wc || wc.isDestroyed() || wc.isCrashed()) continue;
      try {
        wc.send(channel, payload);
      } catch (err) {
        log(`broadcast ${channel} failed:`, err && err.message);
      }
    }
  }

  /** 'widget' | 'dashboard' | 'overlay' for a managed window's webContents, otherwise null. */
  function getViewForWebContents(wc) {
    if (!wc || typeof wc.id !== 'number') return null;
    if (alive(widget) && widget.webContents.id === wc.id) return 'widget';
    if (alive(dashboard) && dashboard.webContents.id === wc.id) return 'dashboard';
    for (const entry of overlays.values()) {
      if (alive(entry.win) && entry.win.webContents.id === wc.id) return 'overlay';
    }
    return null;
  }

  function popupContextMenu(wc, template) {
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    if (!alive(win) || !Array.isArray(template) || template.length === 0) return;
    try {
      Menu.buildFromTemplate(template).popup({ window: win });
    } catch (err) {
      log('context menu failed:', err && err.message);
    }
  }

  function setQuitting(flag) {
    quitting = Boolean(flag);
  }

  function dispose() {
    disposed = true;
    clearInterval(healTimer);
    stopWatchdog();
    for (const timer of [closeTimer, navigateTimer, readyTimer]) if (timer) clearTimeout(timer);
    closeTimer = null;
    navigateTimer = null;
    readyTimer = null;
    flushCloseWaiters(false);
    screen.removeListener('display-added', onDisplaysChanged);
    screen.removeListener('display-removed', onDisplaysChanged);
    screen.removeListener('display-metrics-changed', onDisplaysChanged);
    nativeTheme.removeListener('updated', onThemeUpdated);
  }

  return {
    createWidget,
    showWidget,
    hideWidget,
    setWidgetPeek,
    applySettings,
    toggleDashboard,
    openDashboard,
    isDashboardVisible,
    openOverlays,
    closeOverlays,
    hasOverlays,
    focusOverlays,
    markOverlayReady,
    broadcast,
    getViewForWebContents,
    handleWidgetDrag,
    setWidgetInteractive,
    popupContextMenu,
    setQuitting,
    dispose,
  };
}

module.exports = {
  createWindowManager,
  // pure helpers (unit tests)
  WIDGET_MARGIN,
  THEME_COLORS,
  clampRectToArea,
  widgetClockCentre,
  nearestDisplay,
  defaultWidgetBounds,
  resolveWidgetBounds,
  resizeKeepingClockCentre,
  overlayWindowOptions,
  createRateLimiter,
  overlayWatchdogPlan,
  isBlockedOverlayInput,
  overlayEscapeAction,
  OVERLAY_READY_TIMEOUT_MS,
  OVERLAY_MAX_RELOADS,
  BROKEN_OVERLAY_TINT,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_COALESCE_MS,
  MAX_REFOCUS_PER_SECOND,
  MAX_WATCHDOG_RUNS_PER_SECOND,
};
