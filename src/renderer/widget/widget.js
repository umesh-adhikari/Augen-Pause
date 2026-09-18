// AugenPause floating widget – analog clock with a "Time-Timer" work ring, hydration ring and action pill.
// Efficiency: no rAF loop. One aligned update per second (hands + countdown), compositor-only hand rotation,
// ring geometry only rewritten when it visibly changes, nothing runs while the document is hidden.

import { applyAppearance } from '../shared/theme.js';
import { createT } from '../shared/i18n.js';
import { formatClock, formatDuration } from '../shared/format.js';
import { getApi } from '../shared/api.js';
import strings from './strings.js';
import {
  SIZES, GEOMETRY, MAX_HYDRO_SEGMENTS, RAD, r2, polar, arcPath, arcGradientVector,
  buildDial, buildRings, buildHydro, buildHydroPulse, buildHands,
} from './dial.js';
import { createPill } from './pill.js';
import { setupPointer } from './pointer.js';

const api = getApi();
const HOUR_MS = 3600000;
const MIN_MS = 60000;
const params = new URLSearchParams(window.location.search);
const DEBUG_HOVER = params.get('debugHover') === '1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const el = {
  root: $('widget'),
  clock: $('clock'),
  dial: $('dial'),
  rings: $('rings'),
  hydroPulse: $('hydroPulse'),
  label: $('label'),
  count: $('count'),
  hour: $('handHour'),
  minute: $('handMinute'),
  second: $('handSecond'),
};

// ---------------------------------------------------------------- defaults / normalization

const DEFAULT_SETTINGS = {
  language: 'system',
  timer: { snoozeMinutes: 5, warnBeforeSeconds: 60 },
  hydration: { enabled: true, dailyGoalGlasses: 8 },
  widget: { size: 'medium', opacity: 0.95, showSeconds: true },
  appearance: { theme: 'system', accent: 'teal' },
};

const isObj = (v) => v !== null && typeof v === 'object';
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function normalizeSettings(input) {
  const src = isObj(input) ? input : {};
  const group = (key) => ({ ...DEFAULT_SETTINGS[key], ...(isObj(src[key]) ? src[key] : {}) });
  return {
    ...src,
    language: typeof src.language === 'string' ? src.language : DEFAULT_SETTINGS.language,
    timer: group('timer'),
    hydration: group('hydration'),
    widget: group('widget'),
    appearance: group('appearance'),
  };
}

function normalizeState(input) {
  if (!isObj(input)) return null;
  const sub = (key) => (isObj(input[key]) ? input[key] : {});
  const meeting = sub('meeting');
  const hydration = sub('hydration');
  return {
    ...input,
    now: num(input.now, Date.now()),
    phase: typeof input.phase === 'string' ? input.phase : 'work',
    warning: Boolean(input.warning),
    work: { startedAt: null, endsAt: null, durationMs: 0, remainingMs: 0, progress: 0, ...sub('work') },
    break: {
      type: 'short', startedAt: null, endsAt: null, durationMs: 0, remainingMs: 0, progress: 0,
      canSkip: true, canSnooze: true, lockScreen: true, inGrace: false, graceUntil: null, ...sub('break'),
    },
    pause: { until: null, reason: null, ...sub('pause') },
    away: { since: null, ...sub('away') },
    snooze: { count: 0, max: 0, ...sub('snooze') },
    hydration: {
      enabled: Boolean(hydration.enabled),
      due: Boolean(hydration.due),
      glassesToday: Math.max(0, Math.round(num(hydration.glassesToday, 0))),
      goal: Math.max(1, Math.round(num(hydration.goal, 8))),
    },
    meeting: { active: Boolean(meeting.active), deferred: Boolean(meeting.deferred), since: num(meeting.since, null) },
  };
}

/** Shown when there is no bridge / no snapshot (e.g. opened in a plain browser). */
function demoState() {
  const now = Date.now();
  return {
    now,
    phase: 'work',
    warning: false,
    work: { startedAt: now - 17 * MIN_MS, endsAt: now + 13 * MIN_MS, durationMs: 30 * MIN_MS, remainingMs: 13 * MIN_MS, progress: 17 / 30 },
    break: { type: 'short', durationMs: 2 * MIN_MS, remainingMs: 2 * MIN_MS, canSkip: true, canSnooze: true, lockScreen: true },
    hydration: { enabled: true, due: false, glassesToday: 3, goal: 8 },
    meeting: { active: false, deferred: false, since: null },
  };
}

// ---------------------------------------------------------------- module state

let settings = normalizeSettings(null);
let state = null;
let clockOffset = 0; // Date.now() - state.now at receipt (main clock vs renderer clock)
let lang = 'de';
let t = createT(strings, lang);
let sizeKey = '';
let geo = GEOMETRY.medium;
let rings = null;
let hydroSegs = [];
let tickTimer = 0;
let lastSignature = '';

const last = {
  mode: '',
  secDeg: null,
  rot: new WeakMap(),
  ringKey: '',
  hydroBuildKey: '',
  hydroKey: '',
  label: null,
  count: null,
  aria: '',
  flags: '',
};

const mainNow = () => Date.now() - clockOffset;

function remainingTo(endsAt, fallback) {
  if (Number.isFinite(endsAt)) return Math.max(0, endsAt - mainNow());
  return Math.max(0, num(fallback, 0));
}

/** "09:59" → "9:59", "00:42" → "0:42"; hours stay "1:02:03". */
const clockText = (ms) => formatClock(ms).replace(/^0(?=\d:)/, '');

function modeOf(s) {
  switch (s.phase) {
    case 'break': return 'break';
    case 'paused': return 'paused';
    case 'away': return 'away';
    case 'off-hours': return 'off';
    default:
      if (s.meeting.deferred) return 'meeting';
      return s.warning ? 'warning' : 'work';
  }
}

// ---------------------------------------------------------------- pill + pointer

let pointer = null;
const pill = createPill({
  api,
  forceVisible: DEBUG_HOVER,
  onVisibilityChange: () => {
    // a pill appearing/disappearing under a resting pointer changes click-through
    if (pointer) pointer.refresh();
  },
});

pointer = setupPointer({
  api,
  clock: el.clock,
  pill,
  onHoverChange: (hovered) => {
    el.root.classList.toggle('is-hover', hovered || DEBUG_HOVER);
    pill.setHovered(hovered);
  },
  onClick: () => {
    Promise.resolve().then(() => api.action('toggle-dashboard')).catch(() => {});
  },
});
if (DEBUG_HOVER) el.root.classList.add('is-hover');

// keyboard focus shows the pill (mouse focus does not)
el.root.addEventListener('focusin', (e) => {
  const target = e.target;
  pill.setFocused(Boolean(target && target.matches && target.matches(':focus-visible')));
});
el.root.addEventListener('focusout', (e) => {
  if (!e.relatedTarget || !el.root.contains(e.relatedTarget)) pill.setFocused(false);
});

// ---------------------------------------------------------------- building

function applySize() {
  const key = Object.prototype.hasOwnProperty.call(SIZES, settings.widget.size) ? settings.widget.size : 'medium';
  if (key === sizeKey) return;
  sizeKey = key;
  geo = GEOMETRY[key];
  document.documentElement.style.setProperty('--s', `${SIZES[key]}px`);
  el.root.dataset.size = key;
  buildDial(el.dial, geo);
  rings = buildRings(el.rings, geo);
  buildHands({ hour: el.hour, minute: el.minute, second: el.second }, geo);
  hydroSegs = [];
  last.hydroBuildKey = '';
  last.hydroKey = '';
  last.ringKey = '';
  last.secDeg = null;
}

function applyStaticTexts() {
  el.clock.setAttribute('aria-label', t('clockButton'));
  last.aria = '';
  last.label = null;
  last.count = null;
}

function applySettings(next) {
  settings = normalizeSettings(next);
  const appearance = applyAppearance(settings);
  if (appearance.lang !== lang) {
    lang = appearance.lang;
    t = createT(strings, lang);
  }
  applyStaticTexts();
  applySize();
  const opacity = clamp(num(Number(settings.widget.opacity), 0.95), 0.3, 1);
  el.clock.style.setProperty('--idle-opacity', String(opacity));
  el.root.classList.toggle('no-seconds', !settings.widget.showSeconds);
  last.secDeg = null;
  lastSignature = '';
  render(false);
}

// ---------------------------------------------------------------- rendering

function setRotation(node, deg) {
  const value = `rotate(${r2(deg)}deg)`;
  if (last.rot.get(node) === value) return;
  last.rot.set(node, value);
  node.style.setProperty('transform', value);
}

/** Hands from local wall-clock time. Returns the minute-hand angle (for the Time-Timer arc). */
function renderHands(animate) {
  const d = new Date();
  const sec = d.getSeconds();
  const minutes = d.getMinutes() + sec / 60;
  const hours = (d.getHours() % 12) + minutes / 60;
  setRotation(el.hour, hours * 30);
  setRotation(el.minute, minutes * 6);

  if (settings.widget.showSeconds) {
    const deg = sec * 6;
    const prev = last.secDeg;
    setRotation(el.second, deg);
    if (animate && prev !== null && !reducedMotion.matches && typeof el.second.animate === 'function') {
      let delta = deg - prev;
      if (delta < -180) delta += 360;
      if (delta > 0 && delta <= 12) {
        // quartz-style tick: short step with a tiny overshoot, runs on the compositor
        el.second.animate(
          [{ transform: `rotate(${r2(deg - delta)}deg)` }, { transform: `rotate(${r2(deg)}deg)` }],
          { duration: 240, easing: 'cubic-bezier(0.3, 1.8, 0.55, 1)' },
        );
      }
    }
    last.secDeg = deg;
  }
  return minutes * 6;
}

const q = (deg) => Math.round(deg * 2) / 2; // 0.5° steps – smaller changes are invisible

function renderRing(mode, s, minuteDeg) {
  let arc = null; // { from, span }
  let marker = null; // { deg, double }

  if (mode === 'work' || mode === 'warning' || mode === 'away') {
    const rem = mode === 'away' ? Math.max(0, num(s.work.remainingMs, 0)) : remainingTo(s.work.endsAt, s.work.remainingMs);
    const span = (rem / HOUR_MS) * 360;
    if (span >= 359.9) {
      arc = { from: minuteDeg, span: 359.9 };
      marker = { deg: minuteDeg + (span % 360), double: true };
    } else {
      if (span >= 0.5) arc = { from: minuteDeg, span };
      marker = { deg: minuteDeg + span, double: false };
    }
  } else if (mode === 'break') {
    const duration = s.break.durationMs > 0 ? s.break.durationMs : 1;
    const frac = clamp(remainingTo(s.break.endsAt, s.break.remainingMs) / duration, 0, 1);
    if (frac > 0) arc = { from: 360 * (1 - frac), span: Math.min(359.9, 360 * frac) };
  } else if (mode === 'meeting') {
    arc = { from: 0, span: 359.9 };
  } else if (mode === 'paused' && Number.isFinite(s.pause.until)) {
    const rem = s.pause.until - mainNow();
    if (rem > 0 && rem <= HOUR_MS) marker = { deg: minuteDeg + (rem / HOUR_MS) * 360, double: false };
  }

  const key = `${sizeKey}|${arc ? `${q(arc.from)}/${q(arc.span)}` : '-'}|${marker ? `${q(marker.deg)}/${marker.double}` : '-'}`;
  if (key === last.ringKey) return;
  last.ringKey = key;

  const R = geo.ringR;
  if (arc) {
    const from = q(arc.from);
    const span = Math.max(0.5, Math.min(359.9, q(arc.span)));
    const d = arcPath(from, span, R);
    rings.arc.setAttribute('d', d);
    rings.arcGlow.setAttribute('d', d);
    const v = arcGradientVector(from, span, R, geo.ringW / 2);
    rings.grad.setAttribute('x1', v.x1);
    rings.grad.setAttribute('y1', v.y1);
    rings.grad.setAttribute('x2', v.x2);
    rings.grad.setAttribute('y2', v.y2);
  }
  rings.arc.classList.toggle('is-hidden', !arc);
  rings.arcGlow.classList.toggle('is-hidden', !arc);

  if (marker) {
    const deg = q(marker.deg);
    const [hx, hy] = polar(deg, R);
    rings.halo.setAttribute('cx', r2(hx));
    rings.halo.setAttribute('cy', r2(hy));
    if (marker.double) {
      const offset = (Number(rings.dot1.getAttribute('r')) * 1.45 / R) / RAD;
      const [x1, y1] = polar(deg - offset, R);
      const [x2, y2] = polar(deg + offset, R);
      rings.dot1.setAttribute('cx', r2(x1));
      rings.dot1.setAttribute('cy', r2(y1));
      rings.dot2.setAttribute('cx', r2(x2));
      rings.dot2.setAttribute('cy', r2(y2));
    } else {
      rings.dot1.setAttribute('cx', r2(hx));
      rings.dot1.setAttribute('cy', r2(hy));
    }
    rings.dot2.classList.toggle('is-hidden', !marker.double);
  }
  rings.markers.classList.toggle('is-hidden', !marker);
}

function renderHydro(s) {
  const h = s.hydration;
  const count = Math.min(h.goal, MAX_HYDRO_SEGMENTS);
  const filled = h.goal <= MAX_HYDRO_SEGMENTS
    ? Math.min(count, h.glassesToday)
    : Math.min(count, Math.floor((h.glassesToday / h.goal) * count));
  const due = h.enabled && h.due && (s.phase === 'work' || s.phase === 'break');

  const key = `${sizeKey}|${h.enabled}|${count}|${filled}|${due}`;
  if (key === last.hydroKey) return;
  last.hydroKey = key;

  el.root.classList.toggle('has-hydro', h.enabled);
  if (!h.enabled) {
    el.root.classList.remove('is-water-due');
    return;
  }
  const buildKey = `${sizeKey}|${count}`;
  if (buildKey !== last.hydroBuildKey) {
    last.hydroBuildKey = buildKey;
    hydroSegs = buildHydro(rings.hydro, geo, count);
  }
  hydroSegs.forEach((seg, i) => seg.classList.toggle('is-filled', i < filled));
  buildHydroPulse(el.hydroPulse, geo, count, due ? Math.min(filled, count - 1) : -1);
  el.root.classList.toggle('is-water-due', due);
}

function setText(node, text, prop) {
  if (last[prop] === text) return;
  last[prop] = text;
  node.textContent = text;
}

function renderComplications(mode, s) {
  let label = '';
  let count = '';
  switch (mode) {
    case 'work':
      label = t('phaseWork');
      count = clockText(remainingTo(s.work.endsAt, s.work.remainingMs));
      break;
    case 'warning':
      label = t('phaseWarning');
      count = clockText(remainingTo(s.work.endsAt, s.work.remainingMs));
      break;
    case 'break':
      label = t(s.break.type === 'long' ? 'phaseBreakLong' : 'phaseBreakShort');
      count = clockText(remainingTo(s.break.endsAt, s.break.remainingMs));
      break;
    case 'paused':
      label = t('phasePaused');
      count = Number.isFinite(s.pause.until) ? clockText(Math.max(0, s.pause.until - mainNow())) : t('infinity');
      break;
    case 'away':
      label = t('phaseAway');
      break;
    case 'off':
      label = t('phaseOffHours');
      break;
    case 'meeting':
      label = t('phaseMeeting');
      count = t('noCountdown');
      break;
    default:
      break;
  }
  setText(el.label, label, 'label');
  if (last.count !== count) {
    setText(el.count, count, 'count');
    el.count.classList.toggle('is-long', count.length > 5);
    el.count.classList.toggle('is-placeholder', mode === 'meeting');
  }
}

function renderAria(mode, s) {
  const parts = [];
  const dur = (ms) => formatDuration(ms, lang);
  switch (mode) {
    case 'work':
      parts.push(t(s.break.type === 'long' ? 'ariaWorkLong' : 'ariaWork', { time: dur(remainingTo(s.work.endsAt, s.work.remainingMs)) }));
      break;
    case 'warning':
      parts.push(t('ariaWarning', { time: dur(remainingTo(s.work.endsAt, s.work.remainingMs)) }));
      break;
    case 'break':
      parts.push(t(s.break.type === 'long' ? 'ariaBreakLong' : 'ariaBreakShort', { time: dur(remainingTo(s.break.endsAt, s.break.remainingMs)) }));
      break;
    case 'paused':
      parts.push(Number.isFinite(s.pause.until)
        ? t('ariaPausedUntil', { time: dur(Math.max(0, s.pause.until - mainNow())) })
        : t('ariaPaused'));
      break;
    case 'away': parts.push(t('ariaAway')); break;
    case 'off': parts.push(t('ariaOffHours')); break;
    case 'meeting': parts.push(t('ariaMeeting')); break;
    default: parts.push(t('ariaNoData'));
  }
  if (s.meeting.active && mode !== 'meeting') parts.push(t('ariaMeetingActive'));
  if (s.hydration.enabled) {
    parts.push(t('ariaWater', { count: s.hydration.glassesToday, goal: s.hydration.goal }));
    if (s.hydration.due) parts.push(t('ariaWaterDue'));
  }
  const text = parts.join('. ');
  if (text !== last.aria) {
    last.aria = text;
    el.dial.setAttribute('aria-label', text);
  }
}

function render(animate) {
  if (!state || !rings) return;
  const s = state;
  const mode = modeOf(s);
  if (mode !== last.mode) {
    last.mode = mode;
    el.root.dataset.mode = mode;
  }
  const meetingBadge = s.meeting.active || mode === 'meeting';
  if (el.root.classList.contains('is-meeting') !== meetingBadge) el.root.classList.toggle('is-meeting', meetingBadge);

  const minuteDeg = renderHands(animate);
  renderRing(mode, s, minuteDeg);
  renderHydro(s);
  renderComplications(mode, s);
  renderAria(mode, s);
  pill.update({
    state: s,
    mode,
    settings,
    t,
    warnText: mode === 'warning' ? clockText(remainingTo(s.work.endsAt, s.work.remainingMs)) : '',
    breakText: mode === 'break' ? clockText(remainingTo(s.break.endsAt, s.break.remainingMs)) : '',
  });
}

// ---------------------------------------------------------------- ticking

function scheduleTick() {
  clearTimeout(tickTimer);
  tickTimer = 0;
  if (document.hidden) return;
  const delay = 1000 - (Date.now() % 1000) + 15; // just after the second boundary
  tickTimer = setTimeout(() => {
    tickTimer = 0;
    render(true);
    scheduleTick();
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(tickTimer);
    tickTimer = 0;
  } else {
    last.secDeg = null;
    render(false);
    scheduleTick();
  }
});

/** Only fields that change the picture outside the per-second interpolation. */
function signature(s) {
  return [
    s.phase, s.warning, s.work.endsAt, s.phase === 'work' ? '' : s.work.remainingMs,
    s.break.type, s.break.endsAt, s.break.durationMs, s.break.canSkip, s.break.canSnooze, s.break.strict, s.break.lockScreen, s.break.inGrace,
    s.pause.until, s.hydration.enabled, s.hydration.due, s.hydration.glassesToday, s.hydration.goal,
    s.meeting.active, s.meeting.deferred,
  ].join('|');
}

function acceptState(raw) {
  const next = normalizeState(raw);
  if (!next) return;
  clockOffset = Date.now() - next.now;
  state = next;
  const sig = signature(next);
  if (sig !== lastSignature) {
    lastSignature = sig;
    render(false);
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  let snap = null;
  try {
    snap = await api.getSnapshot();
  } catch {
    snap = null;
  }
  const initialState = snap && snap.state ? snap.state : demoState();
  settings = normalizeSettings(snap && snap.settings);
  state = normalizeState(initialState);
  clockOffset = Date.now() - state.now;
  applySettings(settings);
  lastSignature = signature(state);

  api.onState((s) => acceptState(s));
  api.onSettings((s) => applySettings(s));
  api.onStats((today) => {
    if (!state || !isObj(today) || !Number.isFinite(today.glasses)) return;
    if (state.hydration.glassesToday !== today.glasses) {
      state.hydration.glassesToday = Math.max(0, Math.round(today.glasses));
      lastSignature = '';
      render(false);
    }
  });

  scheduleTick();
}

boot();
