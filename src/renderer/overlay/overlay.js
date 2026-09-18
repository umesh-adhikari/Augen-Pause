// AugenPause – break screen. One instance per display; `?primary=1` marks the display that shows controls.
//
// The window is transparent (docs/ARCHITECTURE.md §11): a dark tint (settings.breaks.overlayOpacity) lies over the
// desktop and the content sits on glass panels. A "Pflicht-Pause" (strict) break ends ONLY by timeout: no snooze,
// no skip, no grace card, no Esc hint – just a calm chip with the end time. Drinking water stays possible.
//
// Timing model: the countdown is interpolated locally from state.break.endsAt (corrected by the offset
// between the scheduler clock and Date.now()). A self-aligning timeout fires just after each whole
// second; the ring gets a new stroke-dashoffset target with a linear transition lasting until the next
// tick, so it moves continuously without a JS animation loop. Everything else is CSS (transform/opacity).

import { getApi } from '../shared/api.js';
import { applyAppearance } from '../shared/theme.js';
import { createT } from '../shared/i18n.js';
import { formatClock, formatTimeOfDay } from '../shared/format.js';
import STRINGS from './strings.js';
import { ILLUSTRATIONS } from './illustrations.js';
import { buildSequence, exerciseAt } from './exercises.js';
import { playStartChime, playEndChime, primeAudio } from './sound.js';

const api = getApi();
const IS_PRIMARY = new URLSearchParams(location.search).get('primary') === '1';

const BREATH_HALF_MS = 4000;
const DONE_THRESHOLD_MS = 1500; // remaining time above this when the phase changes → ended early (skip/snooze)
const START_CHIME_WINDOW_MS = 8000; // only chime when the break really just started (not for late-opened overlays)
const FIRST_RING_MIN_MS = 900;
const BUSY_TIMEOUT_MS = 5000;
const GRACE_OPTIONS = [5, 15, 30];
const COMPACT_OPTIONS = [5, 15];
const MAX_CYCLE_DOTS = 12;
const SAME_BREAK_TOLERANCE_MS = 5000; // startedAt may be re-derived by the scheduler; bigger jumps = another break
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const OVERLAY_ALPHA_MIN = 0.2; // never lower: the window must keep capturing mouse input
const OVERLAY_ALPHA_DEFAULT = 0.6;
const READY_FALLBACK_MS = 1000; // the content is revealed at the latest this long after init() started

const DEFAULT_SETTINGS = Object.freeze({
  language: 'system',
  appearance: { theme: 'dark', accent: 'teal' },
  timer: { snoozeMinutes: 5 },
  breaks: {
    showExercises: true, soundEnabled: true, soundVolume: 0.5, graceSeconds: 15, strictMode: true, overlayOpacity: OVERLAY_ALPHA_DEFAULT,
  },
  hydration: { enabled: true },
});

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const ui = {
  app: $('app'),
  brandName: $('brandName'),
  clock: $('clock'),
  cycle: $('cycle'),
  cycleDots: $('cycleDots'),
  cycleText: $('cycleText'),
  hydration: $('hydration'),
  hydrationText: $('hydrationText'),
  drinkBtn: $('drinkBtn'),
  drinkLabel: $('drinkLabel'),
  stageInner: $('stageInner'),
  panel: $('panel'),
  ringBlock: document.querySelector('.ring-block'),
  ringWrap: $('ringWrap'),
  knob: $('knob'),
  arcs: Array.from(document.querySelectorAll('.ring-arc')),
  centerContent: $('centerContent'),
  breakTitle: $('breakTitle'),
  countdown: $('countdown'),
  breakSubtitle: $('breakSubtitle'),
  below: $('below'),
  doneContent: $('doneContent'),
  doneTitle: $('doneTitle'),
  doneSub: $('doneSub'),
  breathIn: $('breathIn'),
  breathOut: $('breathOut'),
  grace: $('grace'),
  graceTitle: $('graceTitle'),
  graceAction: $('graceAction'),
  graceOptions: $('graceOptions'),
  graceHint: $('graceHint'),
  graceBar: $('graceBar'),
  exercise: $('exercise'),
  exerciseStack: $('exerciseStack'),
  exerciseBar: $('exerciseBar'),
  controls: $('controls'),
  snoozeGroup: $('snoozeGroup'),
  snoozeLabel: $('snoozeLabel'),
  snoozeOptions: $('snoozeOptions'),
  snoozeLeft: $('snoozeLeft'),
  skipBtn: $('skipBtn'),
  skipLabel: $('skipLabel'),
  skipHint: $('skipHint'),
  strictChip: $('strictChip'),
  strictName: $('strictName'),
  strictEnds: $('strictEnds'),
  running: $('running'),
  runningLabel: $('runningLabel'),
  runningEnds: $('runningEnds'),
  escHint: $('escHint'),
  escHintText: $('escHintText'),
  live: $('live'),
  lockFallback: $('lockFallback'),
};

// ---------------------------------------------------------------------------------------------
// state
let settings = DEFAULT_SETTINGS;
let settingsKnown = false; // true once real settings arrived (until then only the state flags decide "strict")
let state = null;
let lang = 'de';
let t = createT(STRINGS, lang);
let clockOffset = 0; // scheduler clock − local clock
let demo = false;
let ready = false;

let mode = 'idle'; // 'idle' | 'break' | 'done'
let brk = null; // { type, rawStartedAt, startedAt, endsAt, durationMs, graceMs, sequence }
let doneVariant = null; // 'completed' | 'ended' | 'snoozed' | 'meeting'
let requested = null; // { kind: 'snooze', minutes } | { kind: 'skip' }
let busy = false;

let readyTimer = 0;
let tickTimer = 0;
let breathTimer = 0;
let graceTimer = 0;
let graceTimerFor = null;
let busyTimer = 0;
let sayTimer = 0;
let drinkAckTimer = 0;
let ringEndsAt = 0;
let exSlot = -1;
let graceBarKey = null;
let lastMinute = null;
let drinkAck = false;

const hold = { active: false, timer: 0, via: null };

// ---------------------------------------------------------------------------------------------
// helpers
const serverNow = () => Date.now() + clockOffset;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mod = (a, n) => ((a % n) + n) % n;

function setText(node, text) {
  const s = String(text ?? '');
  if (node.textContent !== s) node.textContent = s;
}
function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}
function setVar(node, name, value) {
  node.style.setProperty(name, value);
}

function breaksCfg() {
  return (settings && settings.breaks) || DEFAULT_SETTINGS.breaks;
}
function snoozeMinutes() {
  const m = Number(settings && settings.timer && settings.timer.snoozeMinutes);
  return Number.isFinite(m) && m >= 1 ? Math.min(60, Math.round(m)) : 5;
}
function soundVolume() {
  const cfg = breaksCfg();
  if (cfg.soundEnabled === false) return 0;
  const v = Number(cfg.soundVolume);
  return Number.isFinite(v) ? clamp01(v) : 0.5;
}
function hydrationEnabled() {
  if (state && state.hydration && typeof state.hydration.enabled === 'boolean') return state.hydration.enabled;
  return !(settings && settings.hydration && settings.hydration.enabled === false);
}
/** settings.breaks.overlayOpacity clamped to 0.2..1 (tint alpha of the transparent break screen). */
function overlayAlpha() {
  const v = breaksCfg().overlayOpacity;
  if (typeof v !== 'number' || !Number.isFinite(v)) return OVERLAY_ALPHA_DEFAULT;
  return Math.min(1, Math.max(OVERLAY_ALPHA_MIN, v));
}

/**
 * The dark tint is painted by <body> from `--overlay-alpha` on :root, NOT by a child of the fading `.app`
 * (docs/ARCHITECTURE.md §11): the lock has to look like a lock even if this page never finishes rendering.
 * Called at module load with the default (0.6) and again whenever settings arrive; the CSS clamps to ≥ 0.2
 * on top, so the window always keeps capturing mouse input.
 */
function applyTint() {
  setVar(root, '--overlay-alpha', overlayAlpha().toFixed(3));
}
applyTint();

/**
 * Reveal the content. Must stay unconditional (init()'s finally, a timeout and the error handlers all call it):
 * an invisible `.app` over a tinted, input-swallowing window would look like a frozen desktop.
 */
function markReady() {
  clearTimeout(readyTimer);
  readyTimer = 0;
  ready = true;
  ui.app.classList.add('is-ready');
}

// Log renderer problems (main mirrors the renderer console in --dev) and never leave the page invisible.
function installErrorNet() {
  window.addEventListener('error', (e) => {
    console.error('[overlay] uncaught error:', (e && (e.error || e.message)) || e);
    markReady();
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[overlay] unhandled rejection:', (e && e.reason) || e);
    markReady();
  });
}

/**
 * Pflicht-Pause: the break can only end by timeout. During a break the scheduler's `state.break.strict` (captured at
 * break start) decides; a break that can neither be skipped nor snoozed is shown the same way. Without that flag
 * (older main process) the setting decides.
 */
function isStrict() {
  const b = state && state.break;
  if (state && state.phase === 'break' && b) {
    if (b.strict === true) return true;
    if (b.canSkip === false && b.canSnooze === false) return true;
    if (b.strict === false) return false;
  }
  return settingsKnown && breaksCfg().strictMode === true;
}

/** Break end as local wall-clock time (the scheduler clock may differ slightly from Date.now()). */
function localEndsAt() {
  return brk ? brk.endsAt - clockOffset : Date.now();
}

function holdMs() {
  const s = Number(state && state.break && state.break.skipHoldSeconds);
  return Number.isFinite(s) && s > 0 ? Math.min(10, s) * 1000 : 0;
}

/** Snooze choices: preferred list with the configured default minutes swapped in for the nearest entry. */
function snoozeChoices(preferred) {
  const def = snoozeMinutes();
  if (preferred.includes(def)) return preferred.slice();
  let nearest = 0;
  preferred.forEach((m, i) => {
    if (Math.abs(m - def) < Math.abs(preferred[nearest] - def)) nearest = i;
  });
  return preferred.map((m, i) => (i === nearest ? def : m)).sort((a, b) => a - b);
}

function spokenDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return t('durSeconds', { n: sec });
  const min = Math.round(sec / 60);
  return min === 1 ? t('durMinute') : t('durMinutes', { n: min });
}

function say(text) {
  if (!IS_PRIMARY) return; // one announcement source is enough
  clearTimeout(sayTimer);
  setText(ui.live, '');
  sayTimer = setTimeout(() => setText(ui.live, text), 80);
}

// ---------------------------------------------------------------------------------------------
// break model
function graceMsFor(b, startedAt) {
  if (isStrict()) return 0; // a Pflicht-Pause has no grace period
  const until = Number(b && b.graceUntil);
  if (b && b.inGrace === true && Number.isFinite(until) && until > startedAt) return until - startedAt;
  const cfg = Number(breaksCfg().graceSeconds);
  return Number.isFinite(cfg) ? Math.min(120, Math.max(0, cfg)) * 1000 : 0;
}

/**
 * Duration of the running break. Prefers state.break.durationMs: the scheduler recomputes endsAt every tick
 * (tamper-resistant timing, resumed breaks), so endsAt − startedAt can differ from the real break length.
 */
function breakDuration(b, endsAt) {
  const d = Number(b.durationMs);
  if (Number.isFinite(d) && d > 0) return Math.max(1000, d);
  const fromStart = endsAt - Number(b.startedAt);
  return Number.isFinite(fromStart) && fromStart > 0 ? fromStart : 120000;
}

function makeBreak(b) {
  const endsAt = Number(b.endsAt);
  const durationMs = breakDuration(b, endsAt);
  const startedAt = endsAt - durationMs;
  const type = b.type === 'long' ? 'long' : 'short';
  const graceMs = Math.min(graceMsFor(b, startedAt), durationMs / 2);
  return {
    type,
    rawStartedAt: Number(b.startedAt),
    startedAt,
    endsAt,
    durationMs,
    graceMs,
    sequence: buildSequence(type, startedAt, hydrationEnabled()),
  };
}

const progressAt = (ts) => (brk ? clamp01((ts - brk.startedAt) / brk.durationMs) : 0);

/** Active grace period (primary shows big snooze buttons, Esc snoozes everywhere via main) or null. */
function graceInfo() {
  const b = state && state.break;
  if (mode !== 'break' || !brk || !b || b.inGrace !== true || isStrict()) return null;
  const until = Number(b.graceUntil);
  if (!Number.isFinite(until)) return { until: null, remaining: null, total: null };
  const now = serverNow();
  if (until <= now) return null;
  return { until, remaining: until - now, total: Math.max(until - brk.startedAt, until - now) };
}

// ---------------------------------------------------------------------------------------------
// ring + countdown
function setRing(p, durationMs, easing = 'linear') {
  const dur = Math.max(0, Math.round(durationMs));
  setVar(ui.ringWrap, '--tick-ms', `${dur}ms`);
  setVar(ui.ringWrap, '--tick-ease', easing);
  const offset = (1 - clamp01(p)).toFixed(5);
  for (const arc of ui.arcs) arc.style.setProperty('stroke-dashoffset', offset);
  ui.knob.style.setProperty('transform', `rotate(${(clamp01(p) * 360).toFixed(3)}deg)`);
  ui.ringWrap.classList.toggle('is-empty', p < 0.004);
  ringEndsAt = Date.now() + dur;
}

function resetRingInstantly() {
  setRing(0, 0);
  ui.ringWrap.getBoundingClientRect(); // commit the jump before the next transition starts
}

function tick(first = false) {
  clearTimeout(tickTimer);
  setText(ui.clock, formatTimeOfDay(Date.now(), lang));

  if (mode !== 'break' || !brk) {
    tickTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 25);
    return;
  }

  const now = serverNow();
  const rem = Math.max(0, brk.endsAt - now);
  setText(ui.countdown, formatClock(rem));

  // next tick just after the displayed second changes
  const delay = rem > 0 ? (rem % 1000 || 1000) + 20 : 1000;
  if (first) {
    const d = delay < FIRST_RING_MIN_MS ? delay + 1000 : delay;
    setRing(progressAt(now + d), d, EASE_OUT);
  } else if (ringEndsAt - Date.now() < 120) {
    setRing(progressAt(now + delay), delay);
  }

  renderBelow();
  renderControls();
  announceMinutes(rem);

  if (demo && rem <= 0) {
    demoPush({ phase: 'work' });
    return;
  }
  tickTimer = setTimeout(tick, delay);
}

function announceMinutes(rem) {
  const mins = Math.ceil(rem / 60000);
  if (lastMinute !== null && mins < lastMinute && mins >= 1 && rem > 2000) {
    say(mins === 1 ? t('srMinute') : t('srMinutes', { n: mins }));
  }
  lastMinute = mins;
}

// ---------------------------------------------------------------------------------------------
// breathing guide (CSS animation + label switch, both derived from the break start → synced across displays)
function startBreath() {
  clearTimeout(breathTimer);
  if (mode !== 'break' || !brk) return;
  const phase = mod(serverNow() - brk.startedAt, BREATH_HALF_MS * 2);
  setVar(root, '--breath-delay', `${-Math.round(phase)}ms`);
  ui.app.classList.remove('is-breathing');
  void ui.app.offsetWidth; // restart the CSS animations with the new delay
  ui.app.classList.add('is-breathing');
  updateBreathLabel();
}

function updateBreathLabel() {
  clearTimeout(breathTimer);
  if (mode !== 'break' || !brk) return;
  const cycle = BREATH_HALF_MS * 2;
  const phase = mod(serverNow() - brk.startedAt, cycle);
  const inhale = phase < BREATH_HALF_MS;
  ui.breathIn.classList.toggle('is-active', inhale);
  ui.breathOut.classList.toggle('is-active', !inhale);
  breathTimer = setTimeout(updateBreathLabel, (inhale ? BREATH_HALF_MS : cycle) - phase + 30);
}

// ---------------------------------------------------------------------------------------------
// progress bars (transform only)
function animateBar(bar, from, to, durationMs, delayMs = 0) {
  setVar(bar, '--bar-ms', '0ms');
  setVar(bar, '--bar-delay', '0ms');
  bar.style.setProperty('transform', `scaleX(${clamp01(from).toFixed(4)})`);
  bar.getBoundingClientRect();
  setVar(bar, '--bar-ms', `${Math.max(0, Math.round(durationMs))}ms`);
  setVar(bar, '--bar-delay', `${Math.max(0, Math.round(delayMs))}ms`);
  bar.style.setProperty('transform', `scaleX(${clamp01(to).toFixed(4)})`);
}

/** Smoothly glide the stage when the content below the ring changes height (FLIP, transform only). */
function flip(mutate) {
  if (!ready || reducedMotion.matches) {
    mutate();
    return;
  }
  const before = ui.ringWrap.getBoundingClientRect().top;
  mutate();
  const dy = Math.round(before - ui.ringWrap.getBoundingClientRect().top);
  if (Math.abs(dy) < 2) return;
  const s = ui.stageInner.style;
  s.setProperty('transition', 'none');
  s.setProperty('transform', `translateY(${dy}px)`);
  ui.stageInner.getBoundingClientRect();
  s.setProperty('transition', `transform 900ms ${EASE_OUT}`);
  s.setProperty('transform', 'translateY(0)');
}

// ---------------------------------------------------------------------------------------------
// grace card + exercise card
function renderBelow() {
  if (mode !== 'break' || !brk) return; // the done state fades the area out instead of collapsing it
  const grace = graceInfo(); // always null for a Pflicht-Pause
  const showGrace = IS_PRIMARY && Boolean(grace);
  const showEx = !showGrace && breaksCfg().showExercises !== false;

  if (ui.grace.hidden === showGrace || ui.exercise.hidden === showEx) {
    flip(() => {
      setHidden(ui.grace, !showGrace);
      setHidden(ui.exercise, !showEx);
      setHidden(ui.below, !showGrace && !showEx);
    });
  }

  if (grace) scheduleGraceEnd(grace);
  if (showGrace) renderGrace(grace);
  else graceBarKey = null;

  if (showEx) renderExercise();
  else if (exSlot !== -1) {
    exSlot = -1;
    ui.exerciseStack.replaceChildren();
  }
}

function scheduleGraceEnd(grace) {
  if (!grace.until || graceTimerFor === grace.until) return;
  clearTimeout(graceTimer);
  graceTimerFor = grace.until;
  graceTimer = setTimeout(() => {
    graceTimerFor = null;
    renderAll();
  }, grace.remaining + 40);
}

function buildSnoozeButtons(container, minutesList, variant) {
  const def = snoozeMinutes();
  const buttons = minutesList.map((min) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = variant === 'big' ? 'ov-btn ov-btn-big' : 'ov-btn ov-btn-chip';
    if (variant === 'big' && min === def) btn.classList.add('is-default');
    btn.dataset.minutes = String(min);
    btn.disabled = busy;
    btn.textContent = t('snoozeMin', { min });
    btn.setAttribute('aria-label', t('snoozeOptionAria', { min }));
    return btn;
  });
  container.replaceChildren(...buttons);
}

function renderGrace(grace) {
  const choices = snoozeChoices(GRACE_OPTIONS);
  const sig = `${lang}|${snoozeMinutes()}|${choices.join(',')}`;
  if (ui.graceOptions.dataset.sig !== sig) {
    ui.graceOptions.dataset.sig = sig;
    buildSnoozeButtons(ui.graceOptions, choices, 'big');
  }
  setText(ui.graceTitle, t('graceTitle'));
  setText(ui.graceAction, t('graceAction'));
  setText(ui.graceHint, t('graceHint', { min: snoozeMinutes() }));

  const hasDeadline = Boolean(grace.until);
  setHidden(ui.graceBar.parentElement, !hasDeadline);
  const key = hasDeadline ? `${brk.type}|${brk.rawStartedAt}|${grace.until}` : null;
  if (hasDeadline && graceBarKey !== key) {
    graceBarKey = key;
    animateBar(ui.graceBar, grace.remaining / grace.total, 0, grace.remaining);
  }
}

function renderExercise() {
  const now = serverNow();
  const exStart = brk.startedAt + brk.graceMs;
  const exDuration = Math.max(1000, brk.endsAt - exStart);
  const cur = exerciseAt(brk.sequence, brk.type, now - exStart, exDuration);
  if (cur.slot === exSlot) return;
  const instant = exSlot === -1;
  exSlot = cur.slot;
  showSlide(cur, instant);

  const slotStartAbs = exStart + cur.slotStart;
  const slotEndAbs = exStart + cur.slotEnd;
  const len = Math.max(1, slotEndAbs - slotStartAbs);
  const from = clamp01((now - slotStartAbs) / len);
  animateBar(ui.exerciseBar, from, 1, slotEndAbs - Math.max(now, slotStartAbs), slotStartAbs - now);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const illustrationCache = new Map(); // id → parsed <svg> template (null = missing / malformed)

/** Fresh DOM copy of a constant SVG illustration – parsed as XML, never via innerHTML. */
function illustration(id) {
  if (!illustrationCache.has(id)) {
    let template = null;
    const source = Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, id) ? ILLUSTRATIONS[id] : null;
    if (typeof source === 'string') {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svgRoot = doc.documentElement;
      if (svgRoot && svgRoot.namespaceURI === SVG_NS && svgRoot.localName === 'svg'
        && doc.getElementsByTagName('parsererror').length === 0) {
        template = svgRoot;
      } else {
        console.error(`[overlay] invalid illustration template: ${id}`);
      }
    }
    illustrationCache.set(id, template);
  }
  const template = illustrationCache.get(id);
  return template ? document.importNode(template, true) : null;
}

function buildSlide(cur) {
  const slide = document.createElement('div');
  slide.className = 'ex-slide';

  const art = document.createElement('div');
  art.className = 'ex-art';
  art.setAttribute('aria-hidden', 'true');
  const artSvg = illustration(cur.id);
  if (artSvg) art.append(artSvg);

  const body = document.createElement('div');
  body.className = 'ex-body';
  const kicker = document.createElement('p');
  kicker.className = 'ex-kicker';
  const label = document.createElement('span');
  label.textContent = t('exerciseLabel');
  const count = document.createElement('span');
  count.className = 'ex-count tabular';
  count.textContent = t('exerciseCount', { n: cur.slot + 1, total: cur.total });
  kicker.append(label, count);
  const title = document.createElement('h2');
  title.className = 'ex-title';
  title.textContent = t(`ex.${cur.id}.title`);
  const text = document.createElement('p');
  text.className = 'ex-text';
  text.textContent = t(`ex.${cur.id}.text`);
  body.append(kicker, title, text);

  slide.append(art, body);
  return slide;
}

function showSlide(cur, instant) {
  const slide = buildSlide(cur);
  if (instant) {
    slide.classList.add('no-anim');
    ui.exerciseStack.replaceChildren(slide);
    return;
  }
  for (const old of Array.from(ui.exerciseStack.children)) {
    if (old.classList.contains('is-leaving')) continue;
    old.classList.add('is-leaving');
    const remove = () => old.remove();
    old.addEventListener('animationend', (e) => { if (e.target === old) remove(); });
    setTimeout(remove, 900);
  }
  ui.exerciseStack.append(slide);
}

// ---------------------------------------------------------------------------------------------
// topbar: cycle info + hydration
function renderCycle() {
  const c = state && state.cycle;
  const every = Math.round(Number(c && c.longEvery));
  const show = Boolean(brk && c && c.longEnabled && every >= 2 && every <= MAX_CYCLE_DOTS);
  setHidden(ui.cycle, !show);
  if (!show) return;

  const long = brk.type === 'long';
  // cycle.index = breaks since the last long break → the running short break is number index + 1
  const n = long ? every : Math.min(Math.max(Math.round(Number(c.index) || 0) + 1, 1), every - 1);
  setText(ui.cycleText, long ? t('cycleLong') : t('cycleShort', { n, total: every }));

  const sig = `${n}/${every}`;
  if (ui.cycleDots.dataset.sig === sig) return;
  ui.cycleDots.dataset.sig = sig;
  const dots = [];
  for (let i = 0; i < every; i++) {
    const dot = document.createElement('span');
    dot.className = 'cycle-dot';
    if (i === every - 1) dot.classList.add('is-long');
    if (i < n - 1) dot.classList.add('is-done');
    else if (i === n - 1) dot.classList.add('is-current');
    dots.push(dot);
  }
  ui.cycleDots.replaceChildren(...dots);
}

function renderHydration() {
  if (mode === 'done') return;
  const h = state && state.hydration;
  const due = Boolean(h && h.enabled && h.due);
  const show = mode === 'break' && (due || drinkAck);
  setHidden(ui.hydration, !show);
  if (!show) return;
  setText(ui.hydrationText, drinkAck ? t('drankThanks') : t('hydration'));
  setText(ui.drinkLabel, t('drank'));
  const withButton = IS_PRIMARY && !drinkAck;
  setHidden(ui.drinkBtn, !withButton);
  ui.hydration.classList.toggle('has-action', withButton);
  ui.hydration.classList.toggle('is-ack', drinkAck);
}

// ---------------------------------------------------------------------------------------------
// dock
function renderControls() {
  if (mode !== 'break' || !brk) return;
  const b = (state && state.break) || {};

  if (isStrict()) {
    // Pflicht-Pause: the same calm chip on every display, nothing that could end the break early
    cancelHold();
    setHidden(ui.controls, true);
    setHidden(ui.skipHint, true);
    setHidden(ui.running, true);
    setHidden(ui.escHint, true);
    setHidden(ui.strictChip, false);
    setText(ui.strictName, t('strictName'));
    setText(ui.strictEnds, t('strictEnds', { time: formatTimeOfDay(localEndsAt(), lang) }));
    return;
  }

  const grace = graceInfo();
  setHidden(ui.strictChip, true);
  if (IS_PRIMARY) {
    const canSnooze = Boolean(b.canSnooze) && !grace; // during grace the big card offers snoozing
    const canSkip = Boolean(b.canSkip);

    setHidden(ui.snoozeGroup, !canSnooze);
    if (canSnooze) {
      const choices = snoozeChoices(COMPACT_OPTIONS);
      const sig = `${lang}|${choices.join(',')}`;
      if (ui.snoozeOptions.dataset.sig !== sig) {
        ui.snoozeOptions.dataset.sig = sig;
        buildSnoozeButtons(ui.snoozeOptions, choices, 'chip');
      }
      setText(ui.snoozeLabel, t('snoozeLabel'));
      const s = (state && state.snooze) || {};
      const left = Math.round(Number(s.max) - Number(s.count));
      setHidden(ui.snoozeLeft, !(left >= 1 && left <= 10));
      setText(ui.snoozeLeft, t('snoozeLeft', { n: left }));
    }

    setHidden(ui.skipBtn, !canSkip);
    setText(ui.skipLabel, busy && requested && requested.kind === 'skip' ? t('skipping') : t('skipClick'));
    setHidden(ui.skipHint, !(canSkip && holdMs() > 0));
    setText(ui.skipHint, hold.active ? t('skipHolding') : t('skipHold'));
    if (!canSkip) cancelHold();
    setHidden(ui.controls, !canSnooze && !canSkip);
  } else {
    setHidden(ui.controls, true);
    setHidden(ui.skipHint, true);
  }

  setHidden(ui.running, IS_PRIMARY);
  if (!IS_PRIMARY) {
    setText(ui.runningLabel, t('running'));
    setText(ui.runningEnds, t('endsAt', { time: formatTimeOfDay(localEndsAt(), lang) }));
  }

  setHidden(ui.escHint, IS_PRIMARY || !grace);
  setText(ui.escHintText, t('escHint'));
}

// ---------------------------------------------------------------------------------------------
// texts
function renderTexts() {
  document.title = t('docTitle');
  setText(ui.brandName, t('appName'));
  const long = Boolean(brk && brk.type === 'long');
  setText(ui.breakTitle, t(long ? 'titleLong' : 'titleShort'));
  setText(ui.breakSubtitle, t(long ? 'subtitleLong' : 'subtitleShort'));
  setText(ui.breathIn, t('inhale'));
  setText(ui.breathOut, t('exhale'));
  setText(ui.clock, formatTimeOfDay(Date.now(), lang));
  if (doneVariant) renderDoneText();
}

function renderDoneText() {
  const map = {
    completed: ['doneTitle', 'doneSub'],
    ended: ['endedTitle', 'endedSub'],
    snoozed: ['snoozedTitle', 'snoozedSub'],
    meeting: ['meetingTitle', 'meetingSub'],
  };
  const [title, sub] = map[doneVariant] || map.ended;
  setText(ui.doneTitle, t(title));
  setText(ui.doneSub, t(sub, { min: (requested && requested.minutes) || snoozeMinutes() }));
}

function renderAll() {
  renderTexts();
  renderCycle();
  renderHydration();
  renderBelow();
  renderControls();
}

// ---------------------------------------------------------------------------------------------
// phase transitions
function startBreak(b) {
  const followUp = mode !== 'idle';
  brk = makeBreak(b);
  mode = 'break';
  doneVariant = null;
  requested = null;
  setBusy(false);
  cancelHold();

  root.dataset.break = brk.type;
  root.classList.remove('is-done'); // the body tint is outside .app → it needs the flag on :root
  ui.app.classList.remove('is-done', 'done-completed', 'done-ended', 'done-snoozed', 'done-meeting');
  ui.centerContent.removeAttribute('aria-hidden');
  ui.doneContent.setAttribute('aria-hidden', 'true');
  exSlot = -1;
  ui.exerciseStack.replaceChildren();
  graceBarKey = null;
  lastMinute = null;
  ringEndsAt = 0;
  if (followUp) resetRingInstantly();

  renderAll();
  startBreath();
  tick(true);

  const rem = Math.max(0, brk.endsAt - serverNow());
  const grace = graceInfo();
  let extra = '';
  if (isStrict()) extra = ` ${t('srStrict', { time: formatTimeOfDay(localEndsAt(), lang) })}`;
  else if (grace) extra = ` ${t('srGrace')}`;
  say(`${t('srStart', { title: t(brk.type === 'long' ? 'titleLong' : 'titleShort'), time: spokenDuration(rem) })}${extra}`);

  const volume = soundVolume();
  if (IS_PRIMARY && volume > 0) {
    primeAudio();
    if (serverNow() - brk.startedAt < START_CHIME_WINDOW_MS) playStartChime(volume);
  }
}

function updateBreak(b) {
  const endsAt = Number(b.endsAt);
  if (!Number.isFinite(endsAt) || endsAt === brk.endsAt) return;
  const moved = Math.abs(endsAt - brk.endsAt);
  brk.endsAt = endsAt;
  brk.durationMs = breakDuration(b, endsAt);
  brk.startedAt = endsAt - brk.durationMs;
  if (moved >= 250) {
    // a real change (not per-tick jitter of the recomputed end time): retarget the ring right away
    ringEndsAt = 0;
    tick();
  }
}

function isSameBreak(b) {
  if (mode !== 'break' || !brk) return false;
  if ((b.type === 'long' ? 'long' : 'short') !== brk.type) return false;
  const raw = Number(b.startedAt);
  if (!Number.isFinite(raw) || !Number.isFinite(brk.rawStartedAt)) return Number.isFinite(raw) === Number.isFinite(brk.rawStartedAt);
  return Math.abs(raw - brk.rawStartedAt) <= SAME_BREAK_TOLERANCE_MS;
}

function enterDone(next, prev) {
  if (mode === 'done') return;
  const hadBreak = mode === 'break' && Boolean(brk);
  const rem = hadBreak ? brk.endsAt - serverNow() : 0;
  const meeting = next && next.meeting;
  const early = hadBreak && rem > DONE_THRESHOLD_MS;
  // snoozed outside this page (Esc handled by main, global shortcut, tray): the snooze counter went up
  const snoozedElsewhere = Boolean(prev && prev.snooze && next && next.snooze
    && Number(next.snooze.count) > Number(prev.snooze.count));

  let variant;
  if (meeting && (meeting.deferred === true || (early && meeting.active === true))) variant = 'meeting';
  else if (early) variant = (requested && requested.kind === 'snooze') || snoozedElsewhere ? 'snoozed' : 'ended';
  else if (!hadBreak && next && next.phase !== 'work') variant = 'ended';
  else variant = 'completed';

  mode = 'done';
  doneVariant = variant;
  clearTimeout(breathTimer);
  clearTimeout(graceTimer);
  graceTimerFor = null;
  cancelHold();
  ui.app.classList.remove('is-breathing');
  ui.app.classList.add('is-done', `done-${variant}`);
  root.classList.add('is-done'); // releases the body tint towards the 0.2 floor (never a hard dark cut)
  ui.centerContent.setAttribute('aria-hidden', 'true');
  ui.doneContent.setAttribute('aria-hidden', 'false');
  renderDoneText();
  centerRingInPanel();

  if (variant === 'completed') {
    setText(ui.countdown, formatClock(0));
    setRing(1, hadBreak && ready ? 900 : 0, EASE_OUT);
    const volume = soundVolume();
    if (IS_PRIMARY && hadBreak && volume > 0) playEndChime(volume);
  }
  say(t(`sr.${variant}`));
  tick();
}

/** Done state: the card below fades out, so the ring glides to the vertical centre of the glass panel. */
function centerRingInPanel() {
  const panel = ui.panel.getBoundingClientRect();
  const ring = ui.ringWrap.getBoundingClientRect();
  const shift = Math.round(panel.top + panel.height / 2 - (ring.top + ring.height / 2));
  setVar(ui.ringBlock, '--done-shift', `${Math.max(0, shift)}px`);
}

// ---------------------------------------------------------------------------------------------
// incoming data
function onState(next) {
  if (!next || typeof next !== 'object') return;
  // ignore a slightly older snapshot that resolves after a newer push (large gaps = clock change → accept)
  if (state && Number.isFinite(next.now) && Number.isFinite(state.now) && next.now < state.now && state.now - next.now < 5000) return;
  const prev = state;
  state = next;
  if (Number.isFinite(next.now)) clockOffset = next.now - Date.now();

  const b = next.break;
  if (next.phase === 'break' && b && Number.isFinite(Number(b.endsAt))) {
    if (!isSameBreak(b)) {
      startBreak(b);
      return;
    }
    updateBreak(b);
  } else {
    enterDone(next, prev);
  }
  renderAll();
}

function applySettings(next, known = true) {
  if (!next || typeof next !== 'object') return;
  settings = next;
  if (known) settingsKnown = true;
  applyTint();
  const prevLang = lang;
  lang = applyAppearance(settings, { forceTheme: 'dark' }).lang;
  t = createT(STRINGS, lang);
  setText(ui.lockFallback, t('lockFallback')); // keep the static fallback in the right language
  if (prevLang !== lang) {
    // rebuild language dependent generated content
    ui.graceOptions.dataset.sig = '';
    ui.snoozeOptions.dataset.sig = '';
    exSlot = -1;
    ui.exerciseStack.replaceChildren();
  }
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// actions
async function runAction(name, arg) {
  if (demo) return demoAction(name);
  try {
    const res = arg === undefined ? await api.action(name) : await api.action(name, arg);
    return res && typeof res === 'object' ? res : { ok: false };
  } catch {
    return { ok: false };
  }
}

function setBusy(on) {
  busy = on;
  clearTimeout(busyTimer);
  ui.app.classList.toggle('is-busy', on);
  for (const btn of document.querySelectorAll('.controls button, .grace button')) btn.disabled = on;
  if (!on) ui.skipBtn.classList.remove('is-holding', 'is-complete');
  if (on) {
    // safety net: if no phase change arrives, re-enable the controls
    busyTimer = setTimeout(() => {
      if (mode === 'break') {
        requested = null;
        setBusy(false);
        renderControls();
      }
    }, BUSY_TIMEOUT_MS);
  }
}

async function doSnooze(minutes) {
  if (busy || mode !== 'break' || isStrict()) return;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 60;
  requested = { kind: 'snooze', minutes: valid ? minutes : snoozeMinutes() };
  setBusy(true);
  const res = await runAction('snooze', valid ? minutes : undefined);
  if (!res.ok && mode === 'break') {
    requested = null;
    setBusy(false);
    renderControls();
  }
}

async function doSkip() {
  if (busy || mode !== 'break' || isStrict()) return;
  requested = { kind: 'skip' };
  setBusy(true);
  renderControls();
  const res = await runAction('skip-break');
  if (!res.ok && mode === 'break') {
    requested = null;
    setBusy(false);
    renderControls();
  }
}

async function doDrink() {
  if (ui.drinkBtn.disabled) return;
  ui.drinkBtn.disabled = true;
  const res = await runAction('drink');
  ui.drinkBtn.disabled = false;
  if (res.ok) {
    drinkAck = true;
    clearTimeout(drinkAckTimer);
    drinkAckTimer = setTimeout(() => {
      drinkAck = false;
      renderHydration();
    }, 2400);
  }
  renderHydration();
}

// hold-to-skip ---------------------------------------------------------------------------------
function startHold(via) {
  if (hold.active || busy || mode !== 'break' || isStrict()) return;
  const ms = holdMs();
  hold.active = true;
  hold.via = via;
  setVar(ui.skipBtn, '--hold-ms', `${ms}ms`);
  ui.skipBtn.classList.add('is-holding');
  setText(ui.skipHint, t('skipHolding'));
  hold.timer = setTimeout(() => {
    hold.active = false;
    ui.skipBtn.classList.add('is-complete');
    doSkip();
  }, ms);
}

function cancelHold(via) {
  if (!hold.active || (via && hold.via !== via)) return;
  hold.active = false;
  clearTimeout(hold.timer);
  ui.skipBtn.classList.remove('is-holding');
  setText(ui.skipHint, t('skipHold'));
}

function bindControls() {
  const skip = ui.skipBtn;
  skip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || holdMs() === 0) return;
    e.preventDefault();
    skip.focus({ preventScroll: true });
    try { skip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    startHold('pointer');
  });
  const endPointer = () => cancelHold('pointer');
  skip.addEventListener('pointerup', endPointer);
  skip.addEventListener('pointercancel', endPointer);
  skip.addEventListener('lostpointercapture', endPointer);
  skip.addEventListener('keydown', (e) => {
    if ((e.key !== ' ' && e.key !== 'Enter') || holdMs() === 0) return;
    e.preventDefault();
    if (!e.repeat) startHold('key');
  });
  skip.addEventListener('keyup', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    if (holdMs() > 0) e.preventDefault();
    cancelHold('key');
  });
  skip.addEventListener('blur', () => cancelHold());
  skip.addEventListener('click', () => {
    if (holdMs() === 0) doSkip();
  });

  const onSnoozeClick = (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-minutes]') : null;
    if (btn) doSnooze(Number(btn.dataset.minutes));
  };
  ui.graceOptions.addEventListener('click', onSnoozeClick);
  ui.snoozeOptions.addEventListener('click', onSnoozeClick);
  ui.drinkBtn.addEventListener('click', doDrink);

  window.addEventListener('blur', () => cancelHold());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelHold();
    else if (mode === 'break') {
      ringEndsAt = 0;
      tick();
      startBreath();
    }
  });
}

function installGuards() {
  const block = (e) => e.preventDefault();
  window.addEventListener('contextmenu', block);
  window.addEventListener('dragstart', block);
  window.addEventListener('dragover', block);
  window.addEventListener('drop', block);
  window.addEventListener('selectstart', block);
  window.addEventListener('auxclick', block);
  window.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc is handled by main (before-input-event): snooze for a flexible break, nothing at all for a
      // Pflicht-Pause. Should it reach the page anyway, it never triggers an action here.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const modKey = e.ctrlKey || e.metaKey;
    if ((modKey && /^[rwpfn0=+-]$/i.test(e.key)) || e.key === 'F5') e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------------------------------------
// demo mode (no bridge / no snapshot): a local 2-minute break
function demoSnapshot() {
  const now = Date.now();
  const dur = 120000;
  return {
    settings: { ...DEFAULT_SETTINGS, language: 'system' },
    state: {
      now,
      phase: 'break',
      warning: false,
      break: {
        type: 'short', startedAt: now, endsAt: now + dur, durationMs: dur, remainingMs: dur, progress: 0,
        canSkip: true, canSnooze: true, skipHoldSeconds: 3, lockScreen: true, inGrace: false, graceUntil: null,
      },
      cycle: { index: 1, longEvery: 4, longEnabled: true },
      snooze: { count: 0, max: 2, options: [5, 10, 15, 30] },
      meeting: { active: false, deferred: false, since: null },
      hydration: { enabled: true, due: false, glassesToday: 3, goal: 8 },
    },
  };
}

function demoPush(patch) {
  const next = JSON.parse(JSON.stringify(state));
  Object.assign(next, patch, { now: Date.now() });
  setTimeout(() => onState(next), 0);
}

function demoAction(name) {
  if (name === 'drink') {
    const next = JSON.parse(JSON.stringify(state));
    next.now = Date.now();
    next.hydration.due = false;
    setTimeout(() => onState(next), 0);
    return { ok: true };
  }
  if (name === 'skip-break' || name === 'snooze') {
    demoPush({ phase: 'work' });
    return { ok: true };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------------------------
/**
 * The page already counts as "ready" for main the moment `ap:get-snapshot` arrives, and a strict break blocks
 * the fail-open (§11). So anything that throws in here must NOT be able to leave the content invisible:
 * the reveal is armed by a timeout before the first statement and repeated in `finally`.
 */
async function init() {
  readyTimer = setTimeout(markReady, READY_FALLBACK_MS);
  try {
    installGuards();
    bindControls();
    applySettings(DEFAULT_SETTINGS, false);

    api.onState(onState);
    api.onSettings((next) => applySettings(next));

    let snap = null;
    try {
      snap = await api.getSnapshot();
    } catch {
      snap = null;
    }
    if (!snap || !snap.state) {
      demo = true;
      snap = demoSnapshot();
    }
    if (snap.settings) applySettings(snap.settings);
    if (IS_PRIMARY && soundVolume() > 0) primeAudio();
    onState(snap.state);
    if (mode === 'idle') tick();

    // the real UI is up – the static explanation is only for a page that never got this far
    setHidden(ui.lockFallback, true);
  } finally {
    requestAnimationFrame(() => requestAnimationFrame(markReady));
  }
}

installErrorNet();
init();
