// Dashboard-specific formatting helpers (on top of shared/format.js).
import { formatMinutes } from '../../shared/format.js';

const locale = (lang) => (lang === 'de' ? 'de-DE' : 'en-GB');

/** 45 → "45 s", 120 → "2 Min", 90 → "1 Min 30 s" */
export function fmtSeconds(sec, lang) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return `${total} s`;
  if (total % 60 === 0) return formatMinutes(total / 60, lang);
  const m = Math.floor(total / 60);
  const rest = total % 60;
  return `${formatMinutes(m, lang)} ${rest} s`;
}

export function fmtNumber(n, lang, digits = 0) {
  return new Intl.NumberFormat(locale(lang), {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(n) || 0);
}

/** 0.92 → "92 %" (de) / "92%" (en) */
export function fmtPercent(ratio, lang) {
  return new Intl.NumberFormat(locale(lang), { style: 'percent', maximumFractionDigits: 0 }).format(ratio || 0);
}

/** 4 → "4." (de) / "4th" (en) */
export function ordinal(n, lang) {
  if (lang === 'de') return `${n}.`;
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

/** 750 → "750 ml", 2000 → "2 l", 2250 → "2,25 l" */
export function fmtMl(ml, lang) {
  const v = Math.max(0, Math.round(Number(ml) || 0));
  if (v < 1000) return `${fmtNumber(v, lang)} ml`;
  return `${fmtNumber(v / 1000, lang, 2)} l`;
}

/** 'YYYY-MM-DD' → local Date */
export function parseDay(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isToday(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDayLong(date, lang) {
  return date.toLocaleDateString(locale(lang), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Plural helper: expects keys `<base>_one` and `<base>_other` with {n}. */
export function plural(t, base, n, vars = {}) {
  return t(`${base}_${n === 1 ? 'one' : 'other'}`, { n, ...vars });
}

const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** [1,2,3,4,5] → "Mo–Fr", [1,3,5] → "Mo, Mi, Fr" */
export function fmtDays(days, t) {
  const set = new Set(days || []);
  const ordered = MON_FIRST.filter((d) => set.has(d));
  if (ordered.length === 7) return t('days_all');
  const runs = [];
  let run = [];
  for (const d of MON_FIRST) {
    if (set.has(d)) run.push(d);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs
    .map((r) => (r.length >= 3
      ? `${t(`day_short_${r[0]}`)}–${t(`day_short_${r[r.length - 1]}`)}`
      : r.map((d) => t(`day_short_${d}`)).join(', ')))
    .join(', ');
}

export { MON_FIRST };

/** Splits "3 Std 25 Min" into [{num:'3'},{unit:'Std'},…] for typographic rendering. */
export function splitUnits(str) {
  const parts = [];
  for (const token of String(str).split(' ')) {
    if (!token) continue;
    parts.push(/^[\d.,:–-]+$/.test(token) ? { num: token } : { unit: token });
  }
  return parts;
}
