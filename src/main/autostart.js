'use strict';

/**
 * Start at login.
 *
 *   await applyAutostart(enabled)   // never throws
 *
 * Windows  app.setLoginItemSettings (HKCU Run key) with `--hidden`; portable builds register the
 *          portable exe (PORTABLE_EXECUTABLE_FILE) instead of the temporary extraction directory.
 * macOS    app.setLoginItemSettings with `--hidden` (macOS 13+ uses SMAppService, which ignores args –
 *          main.js can use app.getLoginItemSettings().wasOpenedAtLogin where available).
 * Linux    ~/.config/autostart/augenpause.desktop (XDG_CONFIG_HOME respected); Exec = $APPIMAGE (only when
 *          running from inside $APPDIR) or the installed binary, `--ozone-platform=x11` like the packaged
 *          launchers, plus `--hidden`.
 * Development runs (!app.isPackaged) only log – registering the bare Electron binary would be wrong.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN_ARG = '--hidden';
const DESKTOP_FILE_NAME = 'augenpause.desktop';
const LINUX_EXTRA_ARGS = Object.freeze(['--ozone-platform=x11']);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const PLAIN_ARG = /^[A-Za-z0-9_=.,/:+@-]+$/;

/**
 * Quote one Exec argument per the Desktop Entry spec. Plain arguments (e.g. `--hidden`) stay as they are;
 * everything else is wrapped in double quotes with the characters " ` $ \ backslash-escaped and % doubled
 * (field codes); finally the string-value escaping of backslashes is applied.
 */
function quoteExecArg(arg, { force = false } = {}) {
  const value = String(arg);
  if (CONTROL_CHARS.test(value)) throw new Error('control characters are not allowed in Exec arguments');
  if (!force && PLAIN_ARG.test(value)) return value;
  const quoted = `"${value.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`;
  return quoted.replace(/\\/g, '\\\\');
}

function sanitizeValue(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
}

function buildDesktopEntry({ execPath, args = [], name = 'AugenPause', comment = '' }) {
  const exec = [quoteExecArg(execPath, { force: true }), ...args.map((a) => quoteExecArg(a))].join(' ');
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${sanitizeValue(name)}`,
  ];
  if (comment) lines.push(`Comment=${sanitizeValue(comment)}`);
  lines.push(
    `Exec=${exec}`,
    'Icon=augenpause',
    'Terminal=false',
    'StartupWMClass=AugenPause',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=3',
    'X-KDE-autostart-after=panel',
    'Hidden=false',
    'NoDisplay=false',
  );
  return `${lines.join('\n')}\n`;
}

function linuxAutostartFile(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', DESKTOP_FILE_NAME);
}

/**
 * Binary for the Linux autostart entry. $APPIMAGE is only trusted when this process really runs from the
 * mounted AppImage (execPath inside $APPDIR) – an inherited/foreign APPIMAGE variable (e.g. a .deb install
 * started from an AppImage terminal) must not end up in the login item.
 */
function linuxExecPath(env = process.env, execPath = process.execPath) {
  const appDir = typeof env.APPDIR === 'string' ? env.APPDIR.replace(/\/+$/, '') : '';
  const inside = Boolean(appDir) && typeof execPath === 'string' && execPath.startsWith(`${appDir}/`);
  return env.APPIMAGE && inside ? env.APPIMAGE : execPath;
}

async function applyLinux(enabled) {
  const file = linuxAutostartFile();
  if (!enabled) {
    await fs.promises.rm(file, { force: true });
    return;
  }
  const execPath = linuxExecPath();
  const content = buildDesktopEntry({
    execPath,
    args: [...LINUX_EXTRA_ARGS, HIDDEN_ARG],
    comment: 'Erinnert dich an Augenpausen und ans Trinken',
  });
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const existing = await fs.promises.readFile(file, 'utf8').catch(() => null);
  if (existing === content) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    await fs.promises.rename(tmp, file);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
async function applyAutostart(enabled) {
  const on = enabled === true;
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (!app || !app.isPackaged) {
      console.info(`[autostart] development run – not ${on ? 'registering' : 'unregistering'} the login item`);
      return;
    }
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: on,
        path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        args: [HIDDEN_ARG],
      });
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
    } else {
      await applyLinux(on);
    }
  } catch (err) {
    console.warn('[autostart] could not apply:', err && err.message);
  }
}

module.exports = {
  applyAutostart,
  buildDesktopEntry,
  quoteExecArg,
  linuxAutostartFile,
  linuxExecPath,
  HIDDEN_ARG,
};
