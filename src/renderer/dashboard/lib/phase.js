// Derives display information (tone, labels, ring values) from a SchedulerState.
import { formatClock } from '../../shared/format.js';

/**
 * Visual tone of the current state:
 * 'work' | 'warning' | 'break' | 'meeting' | 'paused' | 'away' | 'off-hours'
 */
export function toneOf(state) {
  if (!state) return 'work';
  if (state.phase === 'break') return 'break';
  if (state.phase === 'work' && state.meeting && state.meeting.deferred) return 'meeting';
  if (state.phase === 'work') return state.warning ? 'warning' : 'work';
  return state.phase;
}

/**
 * Pflicht-Pause (docs/ARCHITECTURE.md §11): a running break that ends only by timeout.
 * `state.break.strict` is captured at break start; a break that can neither be skipped nor
 * snoozed counts the same way (older main process without the flag).
 */
export function isMandatoryBreak(state) {
  if (!state || state.phase !== 'break' || !state.break) return false;
  const b = state.break;
  if (typeof b.strict === 'boolean') return b.strict;
  return b.canSkip === false && b.canSnooze === false;
}

/** Short phase label key for chips. */
export function phaseLabelKey(state) {
  const tone = toneOf(state);
  if (tone === 'break') return state.break.type === 'long' ? 'phase_break_long' : 'phase_break_short';
  return `phase_${tone.replace('-', '_')}`;
}

/** Index of the upcoming break within the long-break cycle, and how many short breaks come before the long one. */
export function cycleInfo(state) {
  const c = (state && state.cycle) || {};
  const every = Math.max(2, Number(c.longEvery) || 4);
  const index = Math.min(Math.max(0, Number(c.index) || 0), every - 1);
  const enabled = c.longEnabled !== false;
  const nextIsLong = state && state.break && state.break.type === 'long';
  return { every, index, enabled, nextIsLong, shortBeforeLong: nextIsLong ? 0 : Math.max(0, every - 1 - index) };
}

/**
 * Main countdown for the current state.
 * @param {object} state
 * @param {{ warnMs?: number }} [opts] warnMs: length of the warning window – during the warning the ring
 *   counts down within that window instead of showing an almost empty work ring
 * @returns {{ ms: number|null, fraction: number, text: string }}
 *   fraction: 0..1 visible ring fill (remaining share)
 */
export function countdownOf(state, opts = {}) {
  if (!state) return { ms: null, fraction: 0, text: '--:--' };
  const now = Number(state.now) || Date.now();
  const tone = toneOf(state);
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  switch (tone) {
    case 'warning': {
      const ms = state.work.remainingMs;
      const warnMs = Number(opts.warnMs) || 0;
      const fraction = warnMs > 0 ? clamp(ms / warnMs) : clamp(1 - state.work.progress);
      return { ms, fraction, text: formatClock(ms) };
    }
    case 'break': {
      const ms = state.break.remainingMs;
      return { ms, fraction: clamp(1 - state.break.progress), text: formatClock(ms) };
    }
    case 'meeting': {
      const since = state.meeting.since;
      const ms = since ? Math.max(0, now - since) : 0;
      return { ms, fraction: 1, text: since ? formatClock(ms) : '--:--' };
    }
    case 'paused': {
      const until = state.pause && state.pause.until;
      if (until) {
        const ms = Math.max(0, until - now);
        return { ms, fraction: clamp(1 - state.work.progress), text: formatClock(ms) };
      }
      return { ms: null, fraction: clamp(1 - state.work.progress), text: '∞' };
    }
    case 'off-hours':
      return { ms: null, fraction: 0, text: '--:--' };
    default: {
      const ms = state.work.remainingMs;
      return { ms, fraction: clamp(1 - state.work.progress), text: formatClock(ms) };
    }
  }
}

const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Next start of the working hours (Date) or null. */
export function nextWorkStart(schedule, from = new Date()) {
  if (!schedule || !Array.isArray(schedule.days) || schedule.days.length === 0) return null;
  const m = TIME_RE.exec(schedule.start || '');
  if (!m) return null;
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh, mm, 0, 0);
    if (schedule.days.includes(d.getDay()) && d.getTime() > from.getTime()) return d;
  }
  return null;
}

export function minutesOfDay(hhmm) {
  const m = TIME_RE.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
