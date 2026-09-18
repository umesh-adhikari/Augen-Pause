// Time formatting helpers shared by all renderers.

const pad = (n) => String(n).padStart(2, '0');

/** 754000 → "12:34", 3723000 → "1:02:03". Rounds up so a countdown never shows 0:00 early. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Human duration: "45 s", "12 Min", "1 Std 5 Min" / "12 min", "1 h 5 min". */
export function formatDuration(ms, lang = 'de') {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec} s`;
  const totalMin = Math.round(totalSec / 60);
  return formatMinutes(totalMin, lang);
}

/** 5 → "5 Min", 90 → "1 Std 30 Min" (de) / "1 h 30 min" (en). */
export function formatMinutes(min, lang = 'de') {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hU = lang === 'de' ? 'Std' : 'h';
  const mU = lang === 'de' ? 'Min' : 'min';
  if (h === 0) return `${rest} ${mU}`;
  if (rest === 0) return `${h} ${hU}`;
  return `${h} ${hU} ${rest} ${mU}`;
}

/** Local time "14:05" for a timestamp. */
export function formatTimeOfDay(ts, lang = 'de') {
  return new Date(ts).toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}
