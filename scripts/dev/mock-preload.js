'use strict';
// DEV ONLY – mock implementation of window.augenpause for scripts/dev/preview.js.
const { contextBridge } = require('electron');

const raw = (process.argv.find((a) => a.startsWith('--ap-mock=')) || '--ap-mock={}').slice('--ap-mock='.length);
const opts = JSON.parse(raw);
const NOW = Date.now();
const MIN = 60000;

const settings = {
  version: 2,
  language: opts.lang || 'de',
  timer: { preset: 'halfhour', workMinutes: 30, shortBreakSeconds: 120, longBreakEnabled: true, longBreakSeconds: 600,
    longBreakEvery: 4, warnBeforeSeconds: 60, snoozeMinutes: 5, maxSnoozes: 2 },
  breaks: { lockScreen: true, strictMode: !['break-flex', 'break-grace'].includes(opts.scenario), skipHoldSeconds: 3, allDisplays: true,
    showExercises: true, soundEnabled: false, soundVolume: 0.5, graceSeconds: 15, overlayOpacity: Number(opts.opacity) || 0.6 },
  meeting: { autoDetect: true },
  idle: { enabled: true, resetAfterMinutes: 5 },
  hydration: { enabled: true, intervalMinutes: 45, dailyGoalGlasses: 8, glassMl: 250 },
  schedule: { workingHoursEnabled: opts.scenario === 'off-hours', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' },
  widget: { visible: true, alwaysOnTop: true, size: opts.size || 'medium', opacity: 0.95, showSeconds: true, showOnWarning: true, position: null },
  appearance: { theme: opts.theme || 'dark', accent: opts.accent || 'teal' },
  general: { autostart: false, globalShortcuts: true, notifications: true },
};

function baseState() {
  return {
    now: NOW,
    phase: 'work',
    warning: false,
    work: { startedAt: NOW - 17 * MIN, endsAt: NOW + 13 * MIN, durationMs: 30 * MIN, remainingMs: 13 * MIN, progress: 17 / 30 },
    break: { type: 'short', startedAt: null, endsAt: null, durationMs: 2 * MIN, remainingMs: 2 * MIN, progress: 0,
      canSkip: true, canSnooze: true, skipHoldSeconds: 3, lockScreen: true, inGrace: false, graceUntil: null, strict: settings.breaks.strictMode },
    cycle: { index: 1, longEvery: 4, longEnabled: true },
    pause: { until: null, reason: null },
    away: { since: null },
    snooze: { count: 0, max: 2, options: [5, 10, 15, 30] },
    meeting: { active: false, deferred: false, since: null },
    hydration: { enabled: true, nextAt: NOW + 20 * MIN, intervalMs: 45 * MIN, remainingMs: 20 * MIN, progress: 25 / 45,
      due: false, glassesToday: 3, goal: 8 },
    today: { breaksCompleted: 4, breaksSkipped: 1, glasses: 3, workSeconds: 3 * 3600 + 25 * 60 },
  };
}

function scenarioState(name) {
  const s = baseState();
  switch (name) {
    case 'warning':
      Object.assign(s.work, { endsAt: NOW + 42000, remainingMs: 42000, progress: 1 - 42000 / (30 * MIN) });
      s.warning = true;
      break;
    case 'break':
    case 'break-flex':
    case 'break-grace':
    case 'break-long':
    case 'break-strict': {
      const long = name === 'break-long';
      const dur = long ? 10 * MIN : 2 * MIN;
      const remaining = long ? 6 * MIN + 12000 : 83000;
      s.phase = 'break';
      Object.assign(s.work, { startedAt: null, endsAt: null, remainingMs: 0, progress: 1 });
      Object.assign(s.break, { type: long ? 'long' : 'short', startedAt: NOW - (dur - remaining), endsAt: NOW + remaining,
        durationMs: dur, remainingMs: remaining, progress: 1 - remaining / dur });
      s.break.strict = settings.breaks.strictMode;
      if (settings.breaks.strictMode) Object.assign(s.break, { canSkip: false, canSnooze: false });
      if (name === 'break-grace') Object.assign(s.break, { inGrace: true, graceUntil: NOW + 11000, startedAt: NOW - 4000, remainingMs: dur - 4000, endsAt: NOW + dur - 4000, progress: 4000 / dur });
      break;
    }
    case 'paused':
      s.phase = 'paused';
      s.pause = { until: NOW + 47 * MIN, reason: 'user' };
      Object.assign(s.work, { startedAt: null, endsAt: null });
      s.hydration.nextAt = null;
      break;
    case 'away':
      s.phase = 'away';
      s.away = { since: NOW - 3 * MIN };
      Object.assign(s.work, { startedAt: null, endsAt: null });
      break;
    case 'off-hours':
      s.phase = 'off-hours';
      Object.assign(s.work, { startedAt: null, endsAt: null, remainingMs: 30 * MIN, progress: 0 });
      s.hydration.nextAt = null;
      break;
    case 'meeting':
      Object.assign(s.work, { endsAt: NOW, remainingMs: 0, progress: 1 });
      s.meeting = { active: true, deferred: true, since: NOW - 25 * MIN };
      break;
    case 'meeting-active':
      s.meeting = { active: true, deferred: false, since: NOW - 5 * MIN };
      break;
    case 'hydration-due':
      Object.assign(s.hydration, { due: true, remainingMs: 0, progress: 1 });
      break;
    default:
      break;
  }
  return s;
}

const state = scenarioState(opts.scenario);

function days(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(NOW - i * 86400000);
    const seed = (d.getDate() * 7) % 11;
    out.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      breaksCompleted: 6 + seed, breaksSkipped: seed % 3, breaksSnoozed: seed % 2, shortBreaks: 5 + seed, longBreaks: 1,
      naturalBreaks: seed % 4, breakSeconds: (6 + seed) * 140, workSeconds: (4 + (seed % 5)) * 3600, glasses: 3 + (seed % 6),
    });
  }
  return out;
}

const listeners = { state: [], settings: [], stats: [], navigate: [] };
const on = (k) => (cb) => { listeners[k].push(cb); return () => { listeners[k] = listeners[k].filter((f) => f !== cb); }; };

// tick the mock state so countdowns animate in --show mode
setInterval(() => {
  const now = Date.now();
  const dt = now - state.now;
  state.now = now;
  if (state.phase === 'break') {
    state.break.remainingMs = Math.max(0, state.break.remainingMs - dt);
    state.break.progress = 1 - state.break.remainingMs / state.break.durationMs;
  } else if (state.phase === 'work') {
    state.work.remainingMs = Math.max(0, state.work.remainingMs - dt);
    state.work.progress = 1 - state.work.remainingMs / state.work.durationMs;
  }
  listeners.state.forEach((cb) => cb(JSON.parse(JSON.stringify(state))));
}, 1000);

// re-send a few times: the view may subscribe to onNavigate after the first push
if (opts.tab) [50, 250, 800].forEach((ms) => setTimeout(() => listeners.navigate.forEach((cb) => cb(opts.tab)), ms));

contextBridge.exposeInMainWorld('augenpause', {
  platform: process.platform,
  view: opts.view,
  getSnapshot: async () => ({ state: JSON.parse(JSON.stringify(state)), settings, stats: days(7), version: '1.0.0-dev', locale: opts.lang || 'de' }),
  updateSettings: async (patch) => { console.log('[mock] updateSettings', JSON.stringify(patch)); return { ok: true, settings, errors: [] }; },
  resetSettings: async () => settings,
  getStats: async (n) => days(n),
  resetStats: async () => ({ ok: true }),
  action: async (name, a) => { console.log('[mock] action', name, a); return { ok: true }; },
  showContextMenu: () => console.log('[mock] showContextMenu'),
  widgetDrag: (p) => console.log('[mock] widgetDrag', p),
  setWidgetInteractive: (v) => console.log('[mock] setWidgetInteractive', v),
  onState: on('state'),
  onSettings: on('settings'),
  onStats: on('stats'),
  onNavigate: on('navigate'),
});
