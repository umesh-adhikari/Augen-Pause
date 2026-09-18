// Statistik: range switch, KPI tiles, break + water charts, reset.
import { h, setText, setAttr } from '../lib/dom.js';
import { icon } from '../icons.js';
import { formatMinutes, formatDuration } from '../../shared/format.js';
import { fmtNumber, fmtPercent, parseDay, splitUnits, plural } from '../lib/fmt.js';
import { normalizeDay } from '../lib/defaults.js';
import { sectionHeader } from '../components/section.js';
import { createBarChart } from '../components/chart.js';
import { inlineConfirm } from '../components/confirm.js';

const RANGES = [7, 30];
const LIVE_THROTTLE_MS = 4000;

export function createStatsView(ctx) {
  const { t, lang } = ctx;
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' });
  const longFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'long' });

  let days = ctx.ui.statsRange === 7 && ctx.week.length === 7 ? ctx.week.map(normalizeDay) : [];
  let visible = false;
  let dirty = true;
  let animated = false;
  let liveTimer = null;
  let requestId = 0;
  let destroyed = false;

  // ---- header + range --------------------------------------------------------
  const rangeButtons = RANGES.map((n) => h('button', {
    type: 'button',
    role: 'radio',
    dataset: { range: n },
    onClick: () => setRange(n),
  }, t('range_days', { n })));
  const rangeGroup = h('div', { class: 'segmented segmented-lg', role: 'radiogroup', 'aria-label': t('range_label') }, rangeButtons);
  const header = sectionHeader(t('stats_title'), t('stats_subtitle'), rangeGroup);

  function renderRange() {
    for (const b of rangeButtons) {
      const on = Number(b.dataset.range) === ctx.ui.statsRange;
      setAttr(b, 'aria-pressed', on ? 'true' : 'false');
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
    }
  }

  // ---- KPI tiles ------------------------------------------------------------
  function kpi(iconName, label, tone) {
    const value = h('div', { class: 'tile-value' });
    const sub = h('div', { class: 'tile-sub' });
    const el = h('div', { class: 'card tile kpi', dataset: { tone } },
      h('div', { class: 'tile-head' }, h('span', { class: 'tile-icon' }, icon(iconName, { size: 16 })), h('span', { class: 'tile-label' }, label)),
      value, sub);
    return { el, value, sub };
  }
  const kBreaks = kpi('checkCircle', t('kpi_breaks'));
  const kQuote = kpi('percent', t('kpi_quote'));
  const kScreen = kpi('monitor', t('kpi_screen'));
  const kWater = kpi('droplet', t('kpi_water'), 'water');
  const kNatural = kpi('leaf', t('kpi_natural'), 'break');
  const kpis = h('section', { class: 'kpis' }, kBreaks.el, kQuote.el, kScreen.el, kWater.el, kNatural.el);

  function setValue(el, str) {
    el.replaceChildren(...splitUnits(str).map((p) => (p.num ? h('span', { class: 'num' }, p.num) : h('span', { class: 'unit' }, p.unit))));
  }

  // ---- charts ---------------------------------------------------------------------
  const xLabel = (d, i, n) => {
    const date = parseDay(d.date);
    if (n <= 7) return i === n - 1 ? t('today_short') : weekdayFmt.format(date).replace('.', '');
    return (n - 1 - i) % 5 === 0 ? dayFmt.format(date) : '';
  };
  const tooltipTitle = (d) => {
    const date = parseDay(d.date);
    const today = parseDay(days.length ? days[days.length - 1].date : d.date);
    return date.getTime() === today.getTime() ? `${t('today')} · ${longFmt.format(date)}` : longFmt.format(date);
  };

  const breakChart = createBarChart({
    ariaLabel: t('chart_breaks'),
    series: [
      { key: 'breaksCompleted', label: t('legend_completed'), className: 'series-completed' },
      { key: 'breaksSkipped', label: t('legend_skipped'), className: 'series-skipped' },
    ],
    xLabel,
    tooltipTitle,
    formatValue: (v) => fmtNumber(v, lang, 1),
    tooltipRows: (d) => [
      { className: 'series-completed', value: fmtNumber(d.breaksCompleted, lang), label: t('legend_completed') },
      { className: 'series-skipped', value: fmtNumber(d.breaksSkipped, lang), label: t('legend_skipped') },
      { value: fmtNumber(d.breaksSnoozed, lang), label: t('tip_snoozed') },
      { value: formatDuration((d.workSeconds || 0) * 1000, lang), label: t('tip_screen') },
    ],
  });
  const waterChart = createBarChart({
    ariaLabel: t('chart_water'),
    series: [{ key: 'glasses', label: t('legend_glasses'), className: 'series-water' }],
    xLabel,
    tooltipTitle,
    formatValue: (v) => fmtNumber(v, lang, 1),
    goalLabel: (g) => t('goal_label', { n: g }),
    tooltipRows: (d) => [
      { className: 'series-water', value: fmtNumber(d.glasses, lang), label: t('legend_glasses') },
      { value: `${fmtNumber(d.glasses * ctx.settings.hydration.glassMl, lang)} ml`, label: t('tip_amount') },
    ],
  });

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch series-completed' }), t('legend_completed')),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch series-skipped' }), t('legend_skipped')));
  const breakCardSub = h('p', { class: 'chart-card-sub' });
  const waterCardSub = h('p', { class: 'chart-card-sub' });
  const breakCard = h('section', { class: 'card chart-card' },
    h('header', { class: 'chart-card-head' },
      h('div', null, h('h2', { class: 'chart-card-title' }, t('chart_breaks')), breakCardSub),
      legend),
    breakChart.el);
  const waterCard = h('section', { class: 'card chart-card', dataset: { tone: 'water' } },
    h('header', { class: 'chart-card-head' },
      h('div', null, h('h2', { class: 'chart-card-title' }, t('chart_water')), waterCardSub)),
    waterChart.el);

  const empty = h('section', { class: 'card empty-state', hidden: true },
    h('span', { class: 'empty-icon' }, icon('stats', { size: 26 })),
    h('h2', { class: 'empty-title' }, t('empty_title')),
    h('p', { class: 'empty-text' }, t('empty_text')));

  const resetCard = h('section', { class: 'card reset-row' },
    h('div', { class: 'reset-text' },
      h('h2', { class: 'group-title' }, t('stats_reset_title')),
      h('p', { class: 'group-desc' }, t('stats_reset_desc'))),
    inlineConfirm({
      label: t('btn_reset_stats'),
      question: t('confirm_question'),
      confirmLabel: t('btn_confirm_reset'),
      cancelLabel: t('btn_cancel'),
      onConfirm: async () => {
        if (await ctx.resetStats()) await load(false);
      },
    }));

  const chartsWrap = h('div', { class: 'charts' }, breakCard, waterCard);
  const el = h('div', { class: 'view view-stats' }, header.el, kpis, empty, chartsWrap, resetCard);

  // ---- rendering --------------------------------------------------------------
  function render(animate) {
    dirty = false;
    const n = days.length;
    const sum = (k) => days.reduce((acc, d) => acc + (Number(d[k]) || 0), 0);
    const active = days.filter((d) => d.workSeconds > 0 || d.breaksCompleted > 0 || d.glasses > 0 || d.breaksSkipped > 0);
    const hasData = active.length > 0;

    const completed = sum('breaksCompleted');
    const skipped = sum('breaksSkipped');
    const snoozed = sum('breaksSnoozed');
    const goal = ctx.settings.hydration.dailyGoalGlasses;

    setText(kBreaks.value, fmtNumber(completed, lang));
    setText(kBreaks.sub, [plural(t, 'sub_skipped', skipped), plural(t, 'sub_snoozed', snoozed)].join(' · '));

    if (completed + skipped > 0) {
      setValue(kQuote.value, fmtPercent(completed / (completed + skipped), lang).replace(/\s*%/, ' %'));
      setText(kQuote.sub, t('kpi_quote_sub', { short: fmtNumber(sum('shortBreaks'), lang), long: fmtNumber(sum('longBreaks'), lang) }));
    } else {
      setText(kQuote.value, '—');
      setText(kQuote.sub, t('kpi_no_breaks'));
    }

    const activeWork = days.filter((d) => d.workSeconds > 0);
    if (activeWork.length) {
      const avg = activeWork.reduce((a, d) => a + d.workSeconds, 0) / activeWork.length;
      setValue(kScreen.value, avg >= 3600
        ? `${fmtNumber(avg / 3600, lang, 1)} ${lang === 'de' ? 'Std' : 'h'}`
        : formatMinutes(avg / 60, lang));
      setText(kScreen.sub, plural(t, 'kpi_active_days', activeWork.length));
    } else {
      setText(kScreen.value, '—');
      setText(kScreen.sub, t('kpi_no_data'));
    }

    if (hasData) {
      const avgWater = sum('glasses') / active.length;
      setValue(kWater.value, `${fmtNumber(avgWater, lang, 1)} ${t('unit_glasses')}`);
      const reached = days.filter((d) => d.glasses >= goal).length;
      setText(kWater.sub, t('kpi_water_sub', { goal, reached, n }));
    } else {
      setText(kWater.value, '—');
      setText(kWater.sub, t('kpi_no_data'));
    }

    setText(kNatural.value, fmtNumber(sum('naturalBreaks'), lang));
    setText(kNatural.sub, t('kpi_natural_sub', { duration: formatMinutes(ctx.settings.idle.resetAfterMinutes, lang) }));

    empty.hidden = hasData;
    chartsWrap.hidden = !hasData;
    if (hasData) {
      setText(breakCardSub, t('chart_breaks_sub', { n, avg: fmtNumber(completed / Math.max(1, active.length), lang, 1) }));
      setText(waterCardSub, t('chart_water_sub', { goal, ml: fmtNumber(goal * ctx.settings.hydration.glassMl, lang) }));
      const doAnimate = animate || !animated;
      animated = true;
      requestAnimationFrame(() => {
        if (destroyed) return;
        breakChart.render(days, { animate: doAnimate });
        waterChart.render(days, { animate: doAnimate, goal });
      });
    }
  }

  async function load(animate) {
    const id = ++requestId;
    const n = ctx.ui.statsRange;
    el.classList.add('is-loading');
    let result = null;
    try {
      result = await ctx.api.getStats(n);
    } catch (err) {
      console.warn('[dashboard] getStats failed', err);
    }
    if (destroyed || id !== requestId) return;
    el.classList.remove('is-loading');
    if (Array.isArray(result)) {
      const next = result.map(normalizeDay);
      const same = JSON.stringify(next) === JSON.stringify(days);
      days = next;
      if (n === 7) ctx.week = days.slice();
      if (same && !animate && !dirty) return;
    }
    if (visible) render(animate);
    else dirty = true;
  }

  function setRange(n) {
    if (ctx.ui.statsRange === n) return;
    ctx.ui.statsRange = n;
    renderRange();
    load(true);
  }

  renderRange();

  return {
    el,
    onShow() {
      visible = true;
      if (days.length && dirty) render(false);
      load(false);
    },
    onHide() {
      visible = false;
      clearTimeout(liveTimer);
      liveTimer = null;
    },
    onStats(today) {
      if (!days.length || !today) return;
      const last = days[days.length - 1];
      if (last.date === today.date) days[days.length - 1] = { ...today };
      else if (today.date > last.date) days = [...days.slice(1), { ...today }];
      dirty = true;
      if (!visible || liveTimer) return;
      liveTimer = setTimeout(() => {
        liveTimer = null;
        if (visible && !destroyed) render(false);
      }, LIVE_THROTTLE_MS);
    },
    onSettings(settings, prev) {
      if (!prev || settings.hydration.dailyGoalGlasses !== prev.hydration.dailyGoalGlasses
        || settings.hydration.glassMl !== prev.hydration.glassMl || settings.idle.resetAfterMinutes !== prev.idle.resetAfterMinutes) {
        dirty = true;
        if (visible && days.length) render(false);
      }
    },
    destroy() {
      destroyed = true;
      clearTimeout(liveTimer);
      breakChart.destroy();
      waterChart.destroy();
    },
  };
}
