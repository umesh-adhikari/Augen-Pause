// Fallback data + normalisation, so the dashboard renders even when fields are missing
// (older main process, opened outside Electron, partial state objects).

export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  language: 'system',
  timer: {
    preset: 'halfhour', workMinutes: 30, shortBreakSeconds: 120, longBreakEnabled: true, longBreakSeconds: 600,
    longBreakEvery: 4, warnBeforeSeconds: 60, snoozeMinutes: 5, maxSnoozes: 2,
  },
  breaks: {
    // strictMode ("Pflicht-Pause") is ON by default, overlayOpacity = tint of the transparent break screen (§11)
    lockScreen: true, strictMode: true, skipHoldSeconds: 3, allDisplays: true, showExercises: true,
    soundEnabled: true, soundVolume: 0.5, graceSeconds: 15, overlayOpacity: 0.6,
  },
  meeting: { autoDetect: true },
  idle: { enabled: true, resetAfterMinutes: 5 },
  hydration: { enabled: true, intervalMinutes: 45, dailyGoalGlasses: 8, glassMl: 250 },
  schedule: { workingHoursEnabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' },
  widget: {
    visible: true, alwaysOnTop: true, size: 'medium', opacity: 0.95, showSeconds: true, showOnWarning: true, position: null,
  },
  appearance: { theme: 'system', accent: 'teal' },
  general: { autostart: false, globalShortcuts: true, notifications: true },
});

export const PRESETS = Object.freeze({
  halfhour: { workMinutes: 30, shortBreakSeconds: 120, longBreakSeconds: 600, longBreakEvery: 4 },
  hourly: { workMinutes: 60, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 3 },
  '20-20-20': { workMinutes: 20, shortBreakSeconds: 20, longBreakSeconds: 300, longBreakEvery: 6 },
  pomodoro: { workMinutes: 25, shortBreakSeconds: 300, longBreakSeconds: 900, longBreakEvery: 4 },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: values from `value` win, missing keys come from `defaults`. Never mutates inputs. */
function merge(defaults, value) {
  if (!isObj(defaults)) return value === undefined ? defaults : value;
  const out = {};
  const src = isObj(value) ? value : {};
  for (const key of Object.keys(defaults)) {
    const d = defaults[key];
    const v = src[key];
    if (isObj(d)) out[key] = merge(d, v);
    else if (Array.isArray(d)) out[key] = Array.isArray(v) ? v.slice() : d.slice();
    else out[key] = v === undefined ? d : v;
  }
  for (const key of Object.keys(src)) if (!(key in out)) out[key] = src[key];
  return out;
}

export function withDefaults(settings) {
  return merge(DEFAULT_SETTINGS, settings);
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const MIN = 60000;

function stateDefaults(now, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const work = s.timer.workMinutes * MIN;
  return {
    now,
    phase: 'work',
    warning: false,
    work: { startedAt: now, endsAt: now + work, durationMs: work, remainingMs: work, progress: 0 },
    break: {
      type: 'short', startedAt: null, endsAt: null, durationMs: s.timer.shortBreakSeconds * 1000,
      remainingMs: s.timer.shortBreakSeconds * 1000, progress: 0, canSkip: true, canSnooze: true,
      skipHoldSeconds: s.breaks.skipHoldSeconds, lockScreen: s.breaks.lockScreen, strict: Boolean(s.breaks.strictMode),
      inGrace: false, graceUntil: null,
    },
    cycle: { index: 0, longEvery: s.timer.longBreakEvery, longEnabled: s.timer.longBreakEnabled },
    pause: { until: null, reason: null },
    away: { since: null },
    snooze: { count: 0, max: s.timer.maxSnoozes, options: [5, 10, 15, 30] },
    meeting: { active: false, deferred: false, since: null },
    hydration: {
      enabled: s.hydration.enabled, nextAt: null, intervalMs: s.hydration.intervalMinutes * MIN, remainingMs: 0,
      progress: 0, due: false, glassesToday: 0, goal: s.hydration.dailyGoalGlasses,
    },
    today: { breaksCompleted: 0, breaksSkipped: 0, glasses: 0, workSeconds: 0 },
  };
}

/** Fills missing SchedulerState fields (e.g. meeting / snooze.options from older main processes). */
export function normalizeState(state, settings) {
  const now = (state && Number(state.now)) || Date.now();
  const out = merge(stateDefaults(now, settings), state);
  if (!Array.isArray(out.snooze.options) || out.snooze.options.length === 0) out.snooze.options = [5, 10, 15, 30];
  return out;
}

export function emptyDay(date) {
  return {
    date, breaksCompleted: 0, breaksSkipped: 0, breaksSnoozed: 0, shortBreaks: 0, longBreaks: 0,
    naturalBreaks: 0, breakSeconds: 0, workSeconds: 0, glasses: 0,
  };
}

export function normalizeDay(day) {
  return merge(emptyDay(day && day.date), day);
}
