// Guided exercise rotation. Deterministic per break (seeded by break.startedAt) so that
// every monitor's overlay shows the same exercise at the same moment.

export const SHORT_INTERVAL_MS = 20000;
export const LONG_INTERVAL_MS = 45000;
/** A trailing slot shorter than this is merged into the previous one (no 3-second flashes at the end). */
const MIN_TAIL_MS = 8000;

// Eye exercises (short + long breaks). 'far' (20-20-20) always opens a short break.
const EYE = ['far', 'blink', 'roll', 'nearfar', 'palming', 'eight'];

const intervalFor = (type) => (type === 'long' ? LONG_INTERVAL_MS : SHORT_INTERVAL_MS);

/**
 * @param {'short'|'long'} type
 * @param {number} startedAt break start timestamp (seed)
 * @param {boolean} hydrationEnabled include "drink a glass of water" in long breaks
 * @returns {string[]} exercise ids in display order
 */
export function buildSequence(type, startedAt, hydrationEnabled) {
  const seed = Math.abs(Math.floor((Number(startedAt) || 0) / 1000));
  const rotate = (list, by) => list.map((_, i) => list[(i + by) % list.length]);

  if (type !== 'long') {
    const rest = EYE.slice(1);
    return ['far', ...rotate(rest, seed % rest.length)];
  }

  // Long break: start by getting up, alternate body movement and eye relaxation.
  const eyes = rotate(EYE, seed % EYE.length);
  const body = ['shoulders'];
  if (hydrationEnabled) body.push('water');
  const out = ['stretch'];
  let b = 0;
  eyes.forEach((id, i) => {
    out.push(id);
    if (i % 2 === 1 && b < body.length) out.push(body[b++]);
  });
  while (b < body.length) out.push(body[b++]);
  return out;
}

/** Total number of slots a break of this length shows (for "2 of 6"). */
export function slotCount(type, durationMs) {
  const interval = intervalFor(type);
  const dur = Math.max(0, Number(durationMs) || 0);
  let count = Math.max(1, Math.ceil(dur / interval));
  if (count > 1 && dur - (count - 1) * interval < MIN_TAIL_MS) count -= 1;
  return count;
}

/**
 * Which exercise slot is active at `elapsedMs` into the (exercise part of the) break.
 * @returns {{ slot: number, index: number, id: string, slotStart: number, slotEnd: number, total: number }}
 *   slotStart/slotEnd are elapsed-ms offsets (the last slot ends at the break end)
 */
export function exerciseAt(sequence, type, elapsedMs, durationMs) {
  const interval = intervalFor(type);
  const dur = Math.max(1, Number(durationMs) || 0);
  const total = slotCount(type, dur);
  const elapsed = Math.max(0, Math.min(Number(elapsedMs) || 0, dur - 1));
  const slot = Math.min(Math.floor(elapsed / interval), total - 1);
  const index = slot % sequence.length;
  const slotStart = slot * interval;
  const slotEnd = slot === total - 1 ? dur : Math.min(slotStart + interval, dur);
  return { slot, index, id: sequence[index], slotStart, slotEnd, total };
}
