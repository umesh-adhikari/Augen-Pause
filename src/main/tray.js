'use strict';

/**
 * System tray / menu bar icon.
 *
 *   const tray = createTray({ assetsDir, t, getState, getSettings, onAction, onSettings, isStrictBreak? });
 *   tray.update(state, settings)   // call every second – cheap, only touches the OS on real changes
 *   tray.refreshMenu()             // force tooltip/title/menu rebuild (e.g. after a language change)
 *   tray.destroy()
 *
 * Platform behaviour
 *   Windows  tray.ico (light glyph) or tray-dark.ico (dark glyph for a light taskbar, follows the OS theme),
 *            PNG fallback;
 *            left click → 'toggle-dashboard', right click → context menu built fresh (exact countdown).
 *   macOS    trayTemplate.png template image (+@2x), compact title " 12m" next to the icon;
 *            left and right click → context menu built fresh.
 *   Linux    tray.png; AppIndicator/StatusNotifierItem needs setContextMenu(), so the menu is kept
 *            up to date but only rebuilt when menuSignature() changes (minute resolution).
 *            Left click (where the desktop supports it) → 'toggle-dashboard'.
 *
 * `assetsDir` may be the project `assets` folder or `assets/icons` directly.
 *
 * Mandatory break (§11): isStrictBreak(state) (main's single strict-break decision) switches the tooltip to
 * "AugenPause – Pflicht-Pause – noch 2 Min" and disables every menu item except the water entries. Clicks on
 * the icon still go to main's performAction, which rejects them during a strict break.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildMenuTemplate, buildStatusLine, menuSignature, deriveStrictBreak } = require('./menu');

const DOUBLE_CLICK_GUARD_MS = 400;

function resolveIconsDir(assetsDir) {
  const base = typeof assetsDir === 'string' && assetsDir ? assetsDir : path.join(__dirname, '..', '..', 'assets');
  for (const dir of [path.join(base, 'icons'), base]) {
    try {
      if (fs.existsSync(path.join(dir, 'tray.png'))) return dir;
    } catch {
      // ignore
    }
  }
  return path.join(base, 'icons');
}

function safeCall(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback;
  } catch (err) {
    console.warn('[tray]', err && err.message);
    return fallback;
  }
}

function remainingWorkMs(state) {
  const work = (state && state.work) || {};
  if (Number.isFinite(work.remainingMs)) return Math.max(0, work.remainingMs);
  if (Number.isFinite(work.endsAt) && Number.isFinite(state.now)) return Math.max(0, work.endsAt - state.now);
  return 0;
}

/** Compact macOS menu bar title (leading space separates it from the icon). Minute resolution. */
function macTitle(state, t) {
  if (!state || typeof state !== 'object') return '';
  if (state.phase === 'work') {
    if (state.meeting && state.meeting.deferred === true) return ` ${t('tray.titleMeeting')}`;
    const ms = remainingWorkMs(state);
    if (ms < 60000) return ' <1m';
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return ` ${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? ` ${h}h` : ` ${h}h ${m}m`;
  }
  if (state.phase === 'break') return ` ${t('tray.titleBreak')}`;
  return '';
}

/** @param {boolean} [strict] a mandatory break runs (§11); undefined → derived from state + settings */
function buildTooltip(state, settings, t, strict) {
  const strictBreak = typeof strict === 'boolean' ? strict : deriveStrictBreak(state, settings);
  const status = buildStatusLine({ state, t, precision: 'minute', compact: true, strict: strictBreak });
  let text = t('tray.tooltip', { status });
  const hydrationEnabled = settings && settings.hydration && settings.hydration.enabled === true;
  const hyd = state && state.hydration;
  if (hydrationEnabled && hyd && Number.isFinite(hyd.glassesToday) && Number.isFinite(hyd.goal)) {
    text += `\n${t('tray.water', { glasses: hyd.glassesToday, goal: hyd.goal })}`;
  }
  return text.length > 120 ? `${text.slice(0, 119)}…` : text; // Windows limit: 127 chars
}

/**
 * @param {{
 *   assetsDir: string, t: (key: string, vars?: object) => string,
 *   getState: () => object, getSettings: () => object,
 *   onAction: (name: string, arg: any, source: 'menu'|'tray') => any, onSettings: (patch: object) => any,
 *   isStrictBreak?: (state: object|null) => boolean
 * }} options
 */
function createTray({ assetsDir, t, getState, getSettings, onAction, onSettings, isStrictBreak } = {}) {
  // eslint-disable-next-line global-require
  const { Tray, Menu, nativeImage, nativeTheme } = require('electron');

  const platform = process.platform;
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const isLinux = !isMac && !isWin;
  const tr = typeof t === 'function' ? t : (key) => String(key);
  const iconsDir = resolveIconsDir(assetsDir);

  let tray = null;
  let lastState = null;
  let lastSettings = null;
  let lastTooltip = null;
  let lastTitle = null;
  let lastSignature = null;
  let lastIconVariant = null;
  let contextMenu = null; // keep a reference (GC)
  let lastToggleAt = 0;
  let refreshTimer = null;

  const alive = () => tray !== null && !tray.isDestroyed();

  function loadImage(file) {
    try {
      const image = nativeImage.createFromPath(path.join(iconsDir, file)); // picks up file@2x.png automatically
      if (!image.isEmpty()) return image;
    } catch (err) {
      console.warn('[tray] cannot load', file, err && err.message);
    }
    return null;
  }

  /** Base name without extension. */
  function iconVariant() {
    if (isMac) return 'trayTemplate';
    if (isWin) {
      // dark glyph on a light taskbar
      const darkTaskbar = nativeTheme && typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
        ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
        : true;
      return darkTaskbar ? 'tray' : 'tray-dark';
    }
    return 'tray';
  }

  function createImage(variant) {
    // Windows: the ICO holds natively rendered 16…64 px glyphs, the OS picks the one for the current DPI
    let image = (isWin && loadImage(`${variant}.ico`)) || loadImage(`${variant}.png`)
      || (variant !== 'tray' ? loadImage('tray.png') : null);
    if (!image) {
      const fallback = loadImage('icon-64.png') || loadImage('icon.png');
      image = fallback ? fallback.resize({ width: isMac ? 16 : 32, height: isMac ? 16 : 32, quality: 'best' }) : nativeImage.createEmpty();
    }
    if (isMac) image.setTemplateImage(true);
    return image;
  }

  const current = () => ({
    state: lastState || safeCall(getState, null),
    settings: lastSettings || safeCall(getSettings, null),
  });

  /** boolean from main, or undefined (no callback) → menu.js derives it from state + settings */
  function strictFor(state) {
    if (typeof isStrictBreak !== 'function') return undefined;
    return safeCall(() => isStrictBreak(state) === true, false);
  }

  function scheduleRefresh() {
    if (!isLinux || refreshTimer) return;
    // Native checkbox/radio items flip themselves on click – rebuild from the real settings afterwards.
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastState = safeCall(getState, lastState);
      lastSettings = safeCall(getSettings, lastSettings);
      lastSignature = null;
      syncMenu();
    }, 50);
  }

  /** @param {'menu'|'tray'} source logged by main's performAction in --dev (§10) */
  function dispatchAction(name, arg, source = 'menu') {
    try {
      const result = typeof onAction === 'function' ? onAction(name, arg, source) : undefined;
      if (result && typeof result.catch === 'function') result.catch((err) => console.warn('[tray] action failed:', name, err && err.message));
    } catch (err) {
      console.warn('[tray] action failed:', name, err && err.message);
    }
    scheduleRefresh();
  }

  function dispatchSettings(patch) {
    try {
      const result = typeof onSettings === 'function' ? onSettings(patch) : undefined;
      if (result && typeof result.catch === 'function') result.catch((err) => console.warn('[tray] settings failed:', err && err.message));
    } catch (err) {
      console.warn('[tray] settings failed:', err && err.message);
    }
    scheduleRefresh();
  }

  function buildMenu(precision) {
    const { state, settings } = current();
    const template = buildMenuTemplate({
      state,
      settings,
      strictBreak: strictFor(state),
      t: tr,
      onAction: (name, arg) => dispatchAction(name, arg, 'menu'),
      onSettings: dispatchSettings,
      precision,
    });
    return Menu.buildFromTemplate(template);
  }

  function popUpMenu() {
    if (!alive()) return;
    try {
      lastState = safeCall(getState, lastState);
      lastSettings = safeCall(getSettings, lastSettings);
      contextMenu = buildMenu('second');
      tray.popUpContextMenu(contextMenu);
    } catch (err) {
      console.warn('[tray] popup failed:', err && err.message);
    }
  }

  function syncMenu() {
    if (!isLinux || !alive()) return;
    const { state, settings } = current();
    const signature = menuSignature({ state, settings, t: tr, precision: 'minute', strictBreak: strictFor(state) });
    if (signature === lastSignature) return;
    lastSignature = signature;
    contextMenu = buildMenu('minute');
    tray.setContextMenu(contextMenu);
  }

  function syncIcon() {
    if (!isWin || !alive()) return;
    const variant = iconVariant();
    if (variant === lastIconVariant) return;
    lastIconVariant = variant;
    tray.setImage(createImage(variant));
  }

  function update(state, settings) {
    if (!alive()) return;
    try {
      if (state && typeof state === 'object') lastState = state;
      else lastState = safeCall(getState, lastState);
      if (settings && typeof settings === 'object') lastSettings = settings;
      else lastSettings = safeCall(getSettings, lastSettings);

      const tooltip = buildTooltip(lastState, lastSettings, tr, strictFor(lastState));
      if (tooltip !== lastTooltip) {
        lastTooltip = tooltip;
        tray.setToolTip(tooltip);
      }
      if (isMac) {
        const title = macTitle(lastState, tr);
        if (title !== lastTitle) {
          lastTitle = title;
          tray.setTitle(title, { fontType: 'monospacedDigit' });
        }
      }
      syncMenu();
    } catch (err) {
      console.warn('[tray] update failed:', err && err.message);
    }
  }

  function refreshMenu() {
    lastTooltip = null;
    lastTitle = null;
    lastSignature = null;
    update();
  }

  const onThemeUpdated = () => syncIcon();

  function destroy() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (isWin && nativeTheme) nativeTheme.removeListener('updated', onThemeUpdated);
    if (alive()) tray.destroy();
    tray = null;
    contextMenu = null;
  }

  // ---- create -------------------------------------------------------------
  lastIconVariant = iconVariant();
  tray = new Tray(createImage(lastIconVariant));

  if (isMac) {
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', popUpMenu);
    tray.on('right-click', popUpMenu);
  } else {
    tray.on('click', () => {
      const now = Date.now();
      if (now - lastToggleAt < DOUBLE_CLICK_GUARD_MS) return; // double click must not show + hide
      lastToggleAt = now;
      dispatchAction('toggle-dashboard', undefined, 'tray');
    });
    if (isWin) {
      tray.on('right-click', popUpMenu);
      if (nativeTheme) nativeTheme.on('updated', onThemeUpdated);
    }
  }

  update();
  return { update, refreshMenu, destroy };
}

module.exports = { createTray, macTitle, buildTooltip };
