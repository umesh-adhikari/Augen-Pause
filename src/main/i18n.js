'use strict';

/**
 * Main-process strings (menus, tray, notifications) in German and English.
 * PURE module – no electron require, unit-testable with node:test.
 *
 *   const i18n = createMainI18n(() => settings.language, () => app.getLocale());
 *   i18n.t('menu.quit')                       → 'Beenden'
 *   i18n.t('status.pausedUntil', { time })    → 'Pausiert bis 15:30'
 *   i18n.lang()                               → 'de' | 'en'
 *   formatDurationMs(5_400_000, 'de')         → '1 Std 30 Min'
 */

const STRINGS = Object.freeze({
  de: Object.freeze({
    'app.name': 'AugenPause',

    // ---- units / durations -------------------------------------------------
    'unit.seconds': '{n} s',
    'unit.minutes': '{n} Min',
    'unit.hours': '{n} Std',
    'unit.hoursMinutes': '{h} Std {m} Min',
    'unit.minutesSeconds': '{m} Min {s} s',
    'unit.lessThanMinute': '< 1 Min',
    'long.second': '1 Sekunde',
    'long.seconds': '{n} Sekunden',
    'long.minute': '1 Minute',
    'long.minutes': '{n} Minuten',
    'long.hour': '1 Stunde',
    'long.hours': '{n} Stunden',

    // ---- phases & break types ---------------------------------------------
    'phase.work': 'Arbeitsphase',
    'phase.break': 'Pause',
    'phase.paused': 'Pausiert',
    'phase.away': 'Abwesend',
    'phase.off-hours': 'Außerhalb der Arbeitszeit',
    'breakType.short': 'Kurze Pause',
    'breakType.long': 'Lange Pause',
    'breakTypeAdj.short': 'kurz',
    'breakTypeAdj.long': 'lang',

    'weekday.0': 'Sonntag',
    'weekday.1': 'Montag',
    'weekday.2': 'Dienstag',
    'weekday.3': 'Mittwoch',
    'weekday.4': 'Donnerstag',
    'weekday.5': 'Freitag',
    'weekday.6': 'Samstag',

    // ---- status line (menu + tray tooltip) ----------------------------------
    'status.starting': 'AugenPause startet …',
    'status.nextBreak': 'Nächste Pause in {time} ({type})',
    'status.nextBreakCompact': 'Nächste Pause in {time}',
    'status.warning': 'Pause in {time}',
    'status.meetingDeferred': 'Meeting erkannt – Pause wird danach nachgeholt',
    'status.breakRunning': '{type} läuft – noch {time}',
    'status.breakRunningCompact': 'Pause läuft – noch {time}',
    'status.strictBreakRunning': 'Pflicht-Pause – noch {time}',
    'status.paused': 'Pausiert',
    'status.pausedUntil': 'Pausiert bis {time}',
    'status.pausedUntilTomorrow': 'Pausiert bis morgen, {time}',
    'status.pausedUntilDay': 'Pausiert bis {day}, {time}',
    'status.away': 'Abwesend',
    'status.offHours': 'Außerhalb der Arbeitszeit',

    // ---- context menu -----------------------------------------------------
    'menu.breakNow': 'Jetzt Pause machen',
    'menu.breakShort': 'Kurze Pause ({duration})',
    'menu.breakLong': 'Lange Pause ({duration})',
    'menu.snooze': 'Pause verschieben',
    'menu.snoozeBy': '+{duration}',
    'menu.skipNext': 'Nächste Pause überspringen',
    'menu.endBreak': 'Pause beenden',
    'menu.resetTimer': 'Timer zurücksetzen',
    'menu.resume': 'Fortsetzen',
    'menu.meetingMode': 'Meeting-Modus / Pausieren',
    'menu.meetingAutoDetect': 'Meetings automatisch erkennen',
    'menu.pause30': '30 Minuten',
    'menu.pause60': '1 Stunde',
    'menu.pause120': '2 Stunden',
    'menu.pauseTomorrow': 'Bis morgen',
    'menu.pauseIndefinitely': 'Bis ich fortsetze',
    'menu.drink': 'Wasser getrunken ({glasses}/{goal})',
    'menu.undoDrink': 'Letztes Glas zurücknehmen',
    'menu.interval': 'Intervall',
    'menu.presetLabel': '{name} ({work} / {break})',
    'preset.halfhour': 'Halbstündlich',
    'preset.hourly': 'Stündlich',
    'preset.20-20-20': '20-20-20',
    'preset.pomodoro': 'Pomodoro',
    'preset.custom': 'Benutzerdefiniert…',
    'menu.lockScreen': 'Bildschirm während Pause sperren',
    'menu.strictMode': 'Pflicht-Pause',
    'menu.widget': 'Widget',
    'menu.widgetShow': 'Widget anzeigen',
    'menu.widgetOnTop': 'Immer im Vordergrund',
    'menu.widgetSize': 'Größe',
    'menu.size.small': 'Klein',
    'menu.size.medium': 'Mittel',
    'menu.size.large': 'Groß',
    'menu.widgetResetPosition': 'Position zurücksetzen',
    'menu.hydration': 'Trink-Erinnerung',
    'menu.openDashboard': 'Dashboard öffnen',
    'menu.settings': 'Einstellungen…',
    'menu.stats': 'Statistik',
    'menu.checkUpdates': 'Nach Updates suchen',
    'menu.updateAvailable': 'Update verfügbar: {version}',
    'menu.quit': 'Beenden',

    // ---- tray -------------------------------------------------------------
    'tray.tooltip': 'AugenPause – {status}',
    'tray.water': 'Wasser heute: {glasses} von {goal} Gläsern',
    'tray.titleBreak': 'Pause',
    'tray.titleMeeting': 'Meeting',

    // ---- notifications ----------------------------------------------------
    'notify.warning.title': 'Augenpause in {time}',
    'notify.warning.titleLong': 'Lange Augenpause in {time}',
    'notify.warning.body': 'Klicken zum Verschieben um {minutes} Min',
    'notify.warning.snooze': '+{minutes} Min',
    'notify.warning.now': 'Jetzt',
    'notify.meeting.title': 'Meeting erkannt',
    'notify.meeting.body': 'Deine Augenpause wird nach dem Meeting nachgeholt.',
    'notify.meetingExpired.title': 'Pause wird jetzt nachgeholt',
    'notify.meetingExpired.body': 'Das Meeting dauert schon über 2 Stunden – Zeit für deine Augen.',
    'notify.breakStart.title': 'Zeit für eine Augenpause',
    'notify.breakStart.titleLong': 'Zeit für eine lange Pause',
    'notify.breakStart.body': 'Schau {duration} in die Ferne – blinzle bewusst.',
    'notify.breakStart.bodyLong': 'Steh auf, streck dich und schau {duration} in die Ferne.',
    'notify.breakEnd.title': 'Pause beendet',
    'notify.breakEnd.body': 'Weiter geht’s – deine Augen danken dir.',
    'notify.hydration.title': 'Zeit für ein Glas Wasser',
    'notify.hydration.body': 'Heute: {glasses} von {goal} Gläsern',
    'notify.hydration.bodyGoal': 'Tagesziel erreicht: {glasses} von {goal} Gläsern – weiter so!',
    'notify.hydration.done': 'Getrunken',
    'notify.update.title': 'Neue Version verfügbar',
    'notify.update.body': 'AugenPause {version} steht bereit.',
  }),

  en: Object.freeze({
    'app.name': 'AugenPause',

    'unit.seconds': '{n} s',
    'unit.minutes': '{n} min',
    'unit.hours': '{n} h',
    'unit.hoursMinutes': '{h} h {m} min',
    'unit.minutesSeconds': '{m} min {s} s',
    'unit.lessThanMinute': '< 1 min',
    'long.second': '1 second',
    'long.seconds': '{n} seconds',
    'long.minute': '1 minute',
    'long.minutes': '{n} minutes',
    'long.hour': '1 hour',
    'long.hours': '{n} hours',

    'phase.work': 'Working',
    'phase.break': 'Break',
    'phase.paused': 'Paused',
    'phase.away': 'Away',
    'phase.off-hours': 'Outside working hours',
    'breakType.short': 'Short break',
    'breakType.long': 'Long break',
    'breakTypeAdj.short': 'short',
    'breakTypeAdj.long': 'long',

    'weekday.0': 'Sunday',
    'weekday.1': 'Monday',
    'weekday.2': 'Tuesday',
    'weekday.3': 'Wednesday',
    'weekday.4': 'Thursday',
    'weekday.5': 'Friday',
    'weekday.6': 'Saturday',

    'status.starting': 'AugenPause is starting …',
    'status.nextBreak': 'Next break in {time} ({type})',
    'status.nextBreakCompact': 'Next break in {time}',
    'status.warning': 'Break in {time}',
    'status.meetingDeferred': 'Meeting detected – break will follow afterwards',
    'status.breakRunning': '{type} – {time} left',
    'status.breakRunningCompact': 'Break – {time} left',
    'status.strictBreakRunning': 'Mandatory break – {time} left',
    'status.paused': 'Paused',
    'status.pausedUntil': 'Paused until {time}',
    'status.pausedUntilTomorrow': 'Paused until tomorrow, {time}',
    'status.pausedUntilDay': 'Paused until {day}, {time}',
    'status.away': 'Away',
    'status.offHours': 'Outside working hours',

    'menu.breakNow': 'Take a break now',
    'menu.breakShort': 'Short break ({duration})',
    'menu.breakLong': 'Long break ({duration})',
    'menu.snooze': 'Snooze break',
    'menu.snoozeBy': '+{duration}',
    'menu.skipNext': 'Skip next break',
    'menu.endBreak': 'End break',
    'menu.resetTimer': 'Reset timer',
    'menu.resume': 'Resume',
    'menu.meetingMode': 'Meeting mode / Pause',
    'menu.meetingAutoDetect': 'Detect meetings automatically',
    'menu.pause30': '30 minutes',
    'menu.pause60': '1 hour',
    'menu.pause120': '2 hours',
    'menu.pauseTomorrow': 'Until tomorrow',
    'menu.pauseIndefinitely': 'Until I resume',
    'menu.drink': 'Had a glass of water ({glasses}/{goal})',
    'menu.undoDrink': 'Undo last glass',
    'menu.interval': 'Interval',
    'menu.presetLabel': '{name} ({work} / {break})',
    'preset.halfhour': 'Every half hour',
    'preset.hourly': 'Hourly',
    'preset.20-20-20': '20-20-20',
    'preset.pomodoro': 'Pomodoro',
    'preset.custom': 'Custom…',
    'menu.lockScreen': 'Lock screen during breaks',
    'menu.strictMode': 'Mandatory break',
    'menu.widget': 'Widget',
    'menu.widgetShow': 'Show widget',
    'menu.widgetOnTop': 'Always on top',
    'menu.widgetSize': 'Size',
    'menu.size.small': 'Small',
    'menu.size.medium': 'Medium',
    'menu.size.large': 'Large',
    'menu.widgetResetPosition': 'Reset position',
    'menu.hydration': 'Water reminder',
    'menu.openDashboard': 'Open dashboard',
    'menu.settings': 'Settings…',
    'menu.stats': 'Statistics',
    'menu.checkUpdates': 'Check for updates',
    'menu.updateAvailable': 'Update available: {version}',
    'menu.quit': 'Quit',

    'tray.tooltip': 'AugenPause – {status}',
    'tray.water': 'Water today: {glasses} of {goal} glasses',
    'tray.titleBreak': 'Break',
    'tray.titleMeeting': 'Meeting',

    'notify.warning.title': 'Eye break in {time}',
    'notify.warning.titleLong': 'Long eye break in {time}',
    'notify.warning.body': 'Click to snooze for {minutes} min',
    'notify.warning.snooze': '+{minutes} min',
    'notify.warning.now': 'Now',
    'notify.meeting.title': 'Meeting detected',
    'notify.meeting.body': 'Your eye break will follow after the meeting.',
    'notify.meetingExpired.title': 'Your break is coming up now',
    'notify.meetingExpired.body': 'The meeting has been running for over 2 hours – time for your eyes.',
    'notify.breakStart.title': 'Time for an eye break',
    'notify.breakStart.titleLong': 'Time for a long break',
    'notify.breakStart.body': 'Look into the distance for {duration} – blink consciously.',
    'notify.breakStart.bodyLong': 'Stand up, stretch and look into the distance for {duration}.',
    'notify.breakEnd.title': 'Break finished',
    'notify.breakEnd.body': 'Back to work – your eyes thank you.',
    'notify.hydration.title': 'Time for a glass of water',
    'notify.hydration.body': 'Today: {glasses} of {goal} glasses',
    'notify.hydration.bodyGoal': 'Daily goal reached: {glasses} of {goal} glasses – keep it up!',
    'notify.hydration.done': 'Done',
    'notify.update.title': 'New version available',
    'notify.update.body': 'AugenPause {version} is ready.',
  }),
});

const LANGS = Object.freeze(['de', 'en']);

/** 'system' → 'de' if the locale starts with 'de', otherwise 'en'. */
function resolveLanguage(setting, locale) {
  if (setting === 'de' || setting === 'en') return setting;
  const loc = typeof locale === 'string' ? locale.trim().toLowerCase() : '';
  return loc.startsWith('de') ? 'de' : 'en';
}

/** Replace `{name}` placeholders; unknown placeholders are left untouched. */
function interpolate(text, vars) {
  if (!vars || typeof text !== 'string') return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : match);
}

/** Lookup with fallback chain lang → en → de → key. */
function translate(lang, key, vars) {
  const dict = STRINGS[lang] || STRINGS.en;
  let text = dict[key];
  if (text === undefined) text = STRINGS.en[key];
  if (text === undefined) text = STRINGS.de[key];
  if (text === undefined) text = String(key);
  return interpolate(text, vars);
}

function makeT(lang) {
  return (key, vars) => translate(lang, key, vars);
}

function toMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatMinutesWith(t, totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return t('unit.minutes', { n: m });
  if (m === 0) return t('unit.hours', { n: h });
  return t('unit.hoursMinutes', { h, m });
}

/**
 * Format a duration with any `t` function (so menu.js can stay language-agnostic).
 * Modes:
 *  - 'round'             "45 s", "12 Min", "1 Std 30 Min" (nearest minute ≥ 60 s) – like the renderer's formatDuration
 *  - 'countdown'         remaining time, rounded UP: "45 s" below one minute, else whole minutes rounded up
 *  - 'countdown-minutes' remaining time, rounded UP to minutes: "< 1 Min" below one minute (minute resolution)
 *  - 'exact'             configured durations: "20 s", "1 Min 30 s", "2 Min", "1 Std 5 Min"
 */
function formatDurationWith(t, ms, mode = 'round') {
  const value = toMs(ms);
  if (mode === 'countdown' || mode === 'countdown-minutes') {
    const sec = Math.ceil(value / 1000);
    if (sec < 60) {
      return mode === 'countdown' ? t('unit.seconds', { n: sec }) : t('unit.lessThanMinute');
    }
    return formatMinutesWith(t, Math.ceil(sec / 60));
  }
  if (mode === 'exact') {
    const sec = Math.round(value / 1000);
    if (sec < 60) return t('unit.seconds', { n: sec });
    const min = Math.floor(sec / 60);
    const rest = sec % 60;
    if (rest === 0 || min >= 60) return formatMinutesWith(t, rest >= 30 && min >= 60 ? min + 1 : min);
    return t('unit.minutesSeconds', { m: min, s: rest });
  }
  const sec = Math.round(value / 1000);
  if (sec < 60) return t('unit.seconds', { n: sec });
  return formatMinutesWith(t, Math.round(sec / 60));
}

/** "2 Min" / "1 Std 30 Min" (de) · "2 min" / "1 h 30 min" (en). */
function formatDurationMs(ms, lang = 'de', mode = 'round') {
  return formatDurationWith(makeT(lang === 'de' ? 'de' : 'en'), ms, mode);
}

/**
 * Written-out duration for sentences: "20 Sekunden", "1 Minute", "10 Minuten", "1 Stunde".
 * @param {number} [secondsUpTo]  durations up to this many seconds are always written in seconds
 *   (e.g. 90 → "60 Sekunden" for a warning countdown instead of "1 Minute").
 */
function formatDurationLong(t, ms, secondsUpTo = 0) {
  const sec = Math.round(toMs(ms) / 1000);
  if (sec < 60 || sec <= secondsUpTo || (sec < 120 && sec % 60 !== 0)) {
    return sec === 1 ? t('long.second') : t('long.seconds', { n: sec });
  }
  const min = Math.round(sec / 60);
  if (min >= 60 && min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? t('long.hour') : t('long.hours', { n: h });
  }
  return min === 1 ? t('long.minute') : t('long.minutes', { n: min });
}

/** Countdown clock "1:23" / "12:05" / "1:02:03" (seconds rounded up). */
function formatClock(ms) {
  const total = Math.ceil(toMs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Local time of day "15:30" (24 h, same for de and en-GB like the renderers). */
function formatTimeOfDay(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function safeCall(fn) {
  try {
    return typeof fn === 'function' ? fn() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {() => ('system'|'de'|'en')} getLanguageSetting
 * @param {() => string} getSystemLocale  e.g. () => app.getLocale()
 */
function createMainI18n(getLanguageSetting, getSystemLocale) {
  const lang = () => resolveLanguage(safeCall(getLanguageSetting), safeCall(getSystemLocale));
  const t = (key, vars) => translate(lang(), key, vars);
  return {
    t,
    lang,
    formatDuration: (ms, mode) => formatDurationMs(ms, lang(), mode),
  };
}

module.exports = {
  STRINGS,
  LANGS,
  createMainI18n,
  resolveLanguage,
  translate,
  interpolate,
  formatDurationMs,
  formatDurationWith,
  formatDurationLong,
  formatClock,
  formatTimeOfDay,
};
