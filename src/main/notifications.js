'use strict';

/**
 * Native notifications (silent – the app plays its own chime).
 *
 *   const notifier = createNotifier({ t, getSettings, assetsDir, onAction });
 *   notifier.warning({ type, inMs })            "Augenpause in 60 Sekunden" – click = snooze (meeting safety)
 *   notifier.breakStart({ type, durationMs })   only without lock screen (the overlay covers it otherwise)
 *   notifier.breakEnd({ type, completed })      only for completed breaks
 *   notifier.hydration({ glassesToday, goal })
 *   notifier.meetingDeferred({ type })          "Meeting erkannt" – break follows after the meeting
 *   notifier.meetingDeferExpired()              "Pause wird jetzt nachgeholt" – deferral hit the 2 h limit (§10)
 *   notifier.closeAll()
 *
 * Every method is a no-op when settings.general.notifications === false or notifications are
 * unsupported, and never throws. Each method returns the shown Notification or null.
 * One notification per kind: showing a new one closes the previous one of the same kind.
 * macOS action buttons: warning "+5 Min" (snooze) / "Jetzt" (break-now), hydration "Getrunken" (drink).
 *
 * Mandatory break (§11): while isStrictBreak() is true nothing is shown (the break screen is the only UI) –
 * except breakStart, the plain "time for a break" note when the break runs without a lock screen. Clicks and
 * buttons always go through main's performAction, which rejects everything but drink during a strict break.
 */

const fs = require('node:fs');
const path = require('node:path');
const { formatDurationLong } = require('./i18n');

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {{
 *   t: (key: string, vars?: object) => string, getSettings: () => object,
 *   assetsDir: string, onAction: (name: string, arg: any, source: 'notification') => any,
 *   isStrictBreak?: () => boolean
 * }} options
 */
function createNotifier({ t, getSettings, assetsDir, onAction, isStrictBreak } = {}) {
  // eslint-disable-next-line global-require
  const { Notification, nativeImage } = require('electron');

  const isMac = process.platform === 'darwin';
  const tr = typeof t === 'function' ? t : (key) => String(key);
  /** kind → Notification (strong references so they are not garbage collected while visible) */
  const active = new Map();
  let icon; // undefined = not loaded yet, null = unavailable

  function settings() {
    try {
      const s = typeof getSettings === 'function' ? getSettings() : null;
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  function strictBreak() {
    try {
      return typeof isStrictBreak === 'function' && isStrictBreak() === true;
    } catch {
      return false;
    }
  }

  function enabled() {
    const general = settings().general || {};
    if (general.notifications === false) return false;
    try {
      return Boolean(Notification && Notification.isSupported());
    } catch {
      return false;
    }
  }

  function getIcon() {
    if (isMac) return undefined; // macOS always shows the app icon
    if (icon === undefined) {
      icon = null;
      const base = typeof assetsDir === 'string' && assetsDir ? assetsDir : path.join(__dirname, '..', '..', 'assets');
      search: for (const dir of [path.join(base, 'icons'), base]) {
        for (const file of ['icon-256.png', 'icon.png']) {
          const candidate = path.join(dir, file);
          try {
            if (!fs.existsSync(candidate)) continue;
            const image = nativeImage.createFromPath(candidate);
            if (!image.isEmpty()) {
              icon = image;
              break search;
            }
          } catch {
            // try next
          }
        }
      }
    }
    return icon || undefined;
  }

  function dispatch(name, arg) {
    try {
      if (typeof onAction !== 'function') return;
      const result = onAction(name, arg, 'notification');
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.warn('[notifications] action failed:', name, err && err.message));
      }
    } catch (err) {
      console.warn('[notifications] action failed:', name, err && err.message);
    }
  }

  function close(kind) {
    const previous = active.get(kind);
    if (!previous) return;
    active.delete(kind);
    try {
      previous.close();
    } catch {
      // already gone
    }
  }

  /**
   * @param {string} kind
   * @param {{ title: string, body: string, onClick?: Function, actions?: Array<{ text: string, run: Function }>,
   *   duringStrictBreak?: boolean }} spec  duringStrictBreak: may be shown while a mandatory break runs
   */
  function show(kind, { title, body, onClick, actions = [], duringStrictBreak = false }) {
    close(kind);
    if (!enabled()) return null;
    if (!duringStrictBreak && strictBreak()) return null;
    try {
      const options = { title, body, silent: true, timeoutType: 'default', urgency: 'normal' };
      const image = getIcon();
      if (image) options.icon = image;
      const macActions = isMac ? actions : [];
      if (macActions.length > 0) options.actions = macActions.map((a) => ({ type: 'button', text: a.text }));

      const notification = new Notification(options);
      notification.on('click', () => {
        if (active.get(kind) === notification) active.delete(kind);
        if (typeof onClick === 'function') onClick();
      });
      notification.on('action', (_event, index) => {
        if (active.get(kind) === notification) active.delete(kind);
        const action = macActions[index];
        if (action && typeof action.run === 'function') action.run();
      });
      notification.on('close', () => {
        if (active.get(kind) === notification) active.delete(kind);
      });
      notification.on('failed', (_event, error) => {
        if (active.get(kind) === notification) active.delete(kind);
        console.warn('[notifications] failed:', kind, error);
      });
      active.set(kind, notification);
      notification.show();
      return notification;
    } catch (err) {
      active.delete(kind);
      console.warn('[notifications] cannot show', kind, err && err.message);
      return null;
    }
  }

  const openOverview = () => dispatch('open-dashboard', 'overview');

  function snoozeMinutes() {
    const timer = settings().timer || {};
    return Math.min(60, Math.max(1, Math.round(num(timer.snoozeMinutes, 5))));
  }

  function lockScreenEnabled() {
    const breaks = settings().breaks || {};
    return breaks.lockScreen !== false;
  }

  return {
    warning({ type, inMs } = {}) {
      const minutes = snoozeMinutes();
      // whole seconds, rounded up: a warning fired at 59.4 s reads "60 Sekunden"
      const ms = Math.ceil(Math.max(0, num(inMs, 60000)) / 1000) * 1000;
      const time = formatDurationLong(tr, ms, 90);
      return show('warning', {
        title: tr(type === 'long' ? 'notify.warning.titleLong' : 'notify.warning.title', { time }),
        body: tr('notify.warning.body', { minutes }),
        onClick: () => dispatch('snooze'),
        actions: [
          { text: tr('notify.warning.snooze', { minutes }), run: () => dispatch('snooze') },
          { text: tr('notify.warning.now'), run: () => dispatch('break-now') },
        ],
      });
    },

    breakStart({ type, durationMs } = {}) {
      close('warning');
      close('meeting');
      if (lockScreenEnabled()) return null; // the fullscreen overlay is the notification
      const duration = formatDurationLong(tr, num(durationMs, type === 'long' ? 600000 : 120000));
      const long = type === 'long';
      return show('breakStart', {
        title: tr(long ? 'notify.breakStart.titleLong' : 'notify.breakStart.title'),
        body: tr(long ? 'notify.breakStart.bodyLong' : 'notify.breakStart.body', { duration }),
        onClick: openOverview,
        duringStrictBreak: true, // the only sign of a break without lock screen (widget peek aside)
      });
    },

    breakEnd({ completed } = {}) {
      close('warning');
      close('breakStart');
      if (completed !== true) return null;
      return show('breakEnd', {
        title: tr('notify.breakEnd.title'),
        body: tr('notify.breakEnd.body'),
        onClick: openOverview,
      });
    },

    hydration({ glassesToday, goal } = {}) {
      const glasses = Math.max(0, Math.round(num(glassesToday, 0)));
      const target = Math.max(1, Math.round(num(goal, 8)));
      return show('hydration', {
        title: tr('notify.hydration.title'),
        body: tr(glasses >= target ? 'notify.hydration.bodyGoal' : 'notify.hydration.body', { glasses, goal: target }),
        onClick: openOverview,
        actions: [{ text: tr('notify.hydration.done'), run: () => dispatch('drink') }],
      });
    },

    meetingDeferred() {
      close('warning');
      return show('meeting', {
        title: tr('notify.meeting.title'),
        body: tr('notify.meeting.body'),
        onClick: openOverview,
      });
    },

    /** §10: a break was deferred by a meeting for ≥ 2 h – it now follows the normal warning path. */
    meetingDeferExpired() {
      close('meeting');
      return show('meeting', {
        title: tr('notify.meetingExpired.title'),
        body: tr('notify.meetingExpired.body'),
        onClick: openOverview,
      });
    },

    closeAll() {
      for (const kind of [...active.keys()]) close(kind);
    },
  };
}

module.exports = { createNotifier };
