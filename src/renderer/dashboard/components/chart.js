// Pure SVG column chart: stacked series, optional goal line, hover + keyboard tooltip, screen-reader table.
import { h, s, setText } from '../lib/dom.js';

const PAD = { top: 16, right: 10, bottom: 28, left: 34 };
const MAX_BAR = 24;
const GAP = 2;

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 && pow >= 10 ? 2.5 : n <= 5 ? 5 : 10;
  return Math.max(1, f * pow);
}

function niceScale(max, count = 4) {
  if (!(max > 0)) return { max: count, ticks: Array.from({ length: count + 1 }, (_, i) => i) };
  const step = niceStep(max / count);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

/** Path for a column with rounded top corners (square at the baseline). */
function columnPath(x, y, w, hgt, r) {
  const rr = Math.max(0, Math.min(r, w / 2, hgt));
  if (rr === 0) return `M${x} ${y + hgt}V${y}H${x + w}V${y + hgt}Z`;
  return `M${x} ${y + hgt}V${y + rr}A${rr} ${rr} 0 0 1 ${x + rr} ${y}H${x + w - rr}A${rr} ${rr} 0 0 1 ${x + w} ${y + rr}V${y + hgt}Z`;
}

/**
 * @param {{
 *   series: Array<{ key: string, label: string, className: string }>,
 *   height?: number,
 *   ariaLabel: string,
 *   xLabel: (day: object, index: number, count: number) => string,
 *   tooltipTitle: (day: object) => string,
 *   formatValue?: (v: number) => string,
 *   goalLabel?: (goal: number) => string,
 * }} opts
 */
export function createBarChart(opts) {
  const height = opts.height || 210;
  const fmt = opts.formatValue || ((v) => String(v));
  const svgHost = h('div', { class: 'chart-svg' });
  const tipTitle = h('div', { class: 'chart-tip-title' });
  const tipRows = h('div', { class: 'chart-tip-rows' });
  const tooltip = h('div', { class: 'chart-tip', role: 'presentation', 'aria-hidden': 'true' }, tipTitle, tipRows);
  const table = h('table', { class: 'sr-only' });
  const el = h('div', {
    class: 'chart',
    tabIndex: 0,
    role: 'img',
    'aria-label': opts.ariaLabel,
  }, svgHost, tooltip, table);

  let data = [];
  let goal = null;
  let width = 0;
  let geometry = null;
  let active = -1;
  let hoverRect = null;

  function render(days, { animate = false, goal: nextGoal = null } = {}) {
    data = days || [];
    goal = nextGoal;
    draw(animate);
    buildTable();
  }

  function draw(animate) {
    width = Math.max(240, Math.round(el.clientWidth || 600));
    const n = Math.max(1, data.length);
    const plotW = width - PAD.left - PAD.right - (goal != null ? 8 : 0);
    const plotH = height - PAD.top - PAD.bottom;
    const totals = data.map((d) => opts.series.reduce((sum, ser) => sum + (Number(d[ser.key]) || 0), 0));
    const scale = niceScale(Math.max(1, ...totals, goal != null ? goal * 1.1 : 0));
    const y = (v) => PAD.top + plotH - (v / scale.max) * plotH;
    const band = plotW / n;
    const barW = Math.max(3, Math.min(MAX_BAR, band * 0.62));

    const grid = s('g', { class: 'chart-grid' });
    for (const tick of scale.ticks) {
      const yy = Math.round(y(tick)) + 0.5;
      grid.appendChild(s('line', { x1: PAD.left, x2: width - PAD.right, y1: yy, y2: yy, class: tick === 0 ? 'chart-baseline' : 'chart-gridline' }));
      grid.appendChild(s('text', { x: PAD.left - 8, y: yy, class: 'chart-ytick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmt(tick)));
    }

    hoverRect = s('rect', { class: 'chart-hover', x: 0, y: PAD.top - 6, width: band, height: plotH + 6, rx: 6, opacity: 0 });
    const bars = s('g', { class: 'chart-bars' });
    const labels = s('g', { class: 'chart-xlabels' });
    const hits = s('g', { class: 'chart-hits' });

    data.forEach((d, i) => {
      const cx = PAD.left + band * i + band / 2;
      const x = cx - barW / 2;
      const group = s('g', { class: 'chart-bar' });
      group.style.setProperty('--i', String(i));
      const segs = opts.series.map((ser) => ({ ser, v: Number(d[ser.key]) || 0 })).filter((seg) => seg.v > 0);
      if (segs.length === 0) {
        const stubW = Math.min(barW, 8);
        group.appendChild(s('rect', { class: 'chart-stub', x: cx - stubW / 2, y: y(0) - 2, width: stubW, height: 2, rx: 1 }));
      }
      let cum = 0;
      let lastTop = y(0);
      segs.forEach((seg, si) => {
        const bottom = Math.min(y(cum), lastTop) - (si > 0 ? GAP : 0);
        cum += seg.v;
        const yTop = Math.min(y(cum), bottom - 1.5);
        lastTop = yTop;
        const top = si === segs.length - 1;
        group.appendChild(s('path', { class: `chart-seg ${seg.ser.className}`, d: columnPath(x, yTop, barW, bottom - yTop, top ? 4 : 0) }));
      });
      bars.appendChild(group);

      const label = opts.xLabel(d, i, n);
      if (label) {
        labels.appendChild(s('text', {
          x: cx, y: height - 8, class: ['chart-xtick', i === n - 1 && 'is-today'].filter(Boolean).join(' '), 'text-anchor': 'middle',
        }, label));
      }
      const hit = s('rect', { class: 'chart-hit', x: PAD.left + band * i, y: PAD.top - 6, width: band, height: plotH + 6 + PAD.bottom - 4, fill: 'transparent' });
      hit.addEventListener('pointerenter', () => show(i));
      hits.appendChild(hit);
    });

    const layers = [grid, hoverRect, bars];
    if (goal != null) {
      const gy = Math.round(y(goal)) + 0.5;
      layers.push(s('g', { class: 'chart-goal' },
        s('line', { x1: PAD.left, x2: width - PAD.right, y1: gy, y2: gy, class: 'chart-goal-line' }),
        s('text', { x: width - PAD.right, y: gy - 6, 'text-anchor': 'end', class: 'chart-goal-label' }, opts.goalLabel ? opts.goalLabel(goal) : String(goal))));
    }
    layers.push(labels, hits);

    const svg = s('svg', {
      class: ['chart-root', animate && 'is-animating'].filter(Boolean).join(' '),
      viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false',
    }, ...layers);
    svg.addEventListener('pointerleave', hide);
    svgHost.replaceChildren(svg);
    geometry = { band, plotH, n };
    if (active >= 0 && active < n) show(active, true);
  }

  function show(i, silent) {
    if (!geometry || !data[i]) return;
    active = i;
    const { band } = geometry;
    hoverRect.setAttribute('x', String(PAD.left + band * i + 2));
    hoverRect.setAttribute('width', String(Math.max(4, band - 4)));
    hoverRect.setAttribute('opacity', '1');
    const d = data[i];
    setText(tipTitle, opts.tooltipTitle(d));
    const rows = (opts.tooltipRows ? opts.tooltipRows(d) : opts.series.map((ser) => ({ className: ser.className, value: fmt(Number(d[ser.key]) || 0), label: ser.label })));
    tipRows.replaceChildren(...rows.map((r) => h('div', { class: 'chart-tip-row' },
      r.className ? h('span', { class: `chart-tip-key ${r.className}` }) : h('span', { class: 'chart-tip-key is-none' }),
      h('span', { class: 'chart-tip-value tabular' }, r.value),
      h('span', { class: 'chart-tip-label' }, r.label))));
    tooltip.classList.add('is-visible');
    const tipW = tooltip.offsetWidth || 160;
    const cx = PAD.left + band * i + band / 2;
    let left = cx + band / 2 + 10;
    if (left + tipW > width - 4) left = cx - band / 2 - 10 - tipW;
    tooltip.style.setProperty('left', `${Math.max(0, Math.round(left))}px`);
    tooltip.style.setProperty('top', `${PAD.top}px`);
    if (!silent) el.dataset.active = String(i);
  }

  function hide() {
    active = -1;
    tooltip.classList.remove('is-visible');
    if (hoverRect) hoverRect.setAttribute('opacity', '0');
  }

  el.addEventListener('keydown', (e) => {
    if (!data.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = active < 0 ? data.length - 1 : Math.min(data.length - 1, Math.max(0, active + (e.key === 'ArrowRight' ? 1 : -1)));
      show(next);
    } else if (e.key === 'Escape') {
      hide();
    }
  });
  el.addEventListener('focus', () => { if (el.matches(':focus-visible') && data.length) show(data.length - 1); });
  el.addEventListener('blur', hide);

  function buildTable() {
    table.replaceChildren(
      h('caption', null, opts.ariaLabel),
      h('thead', null, h('tr', null, h('th', null, ''), opts.series.map((ser) => h('th', null, ser.label)))),
      h('tbody', null, data.map((d) => h('tr', null,
        h('th', null, opts.tooltipTitle(d)),
        opts.series.map((ser) => h('td', null, fmt(Number(d[ser.key]) || 0)))))));
  }

  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      const w = Math.round(el.clientWidth);
      if (w > 0 && Math.abs(w - width) > 1 && data.length) draw(false);
    });
  });
  ro.observe(el);

  return {
    el,
    render,
    destroy() {
      ro.disconnect();
    },
  };
}
