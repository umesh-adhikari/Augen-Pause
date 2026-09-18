// SVG geometry + builders for the widget clock. All coordinates are in viewBox units
// (0..200, centre 100/100, face radius 100) so every layer scales crisply with S.
// Only static structure is built here (once per size / goal change); widget.js updates attributes.

const NS = 'http://www.w3.org/2000/svg';
export const RAD = Math.PI / 180;

/** Clock diameter in px per settings.widget.size (docs/ARCHITECTURE.md §6). */
export const SIZES = Object.freeze({ small: 120, medium: 160, large: 210 });

/**
 * Per-size tuning. Small clocks get relatively thicker strokes so rings/hands stay legible,
 * large clocks get finer lines + minute dots.
 */
export const GEOMETRY = Object.freeze({
  small: {
    ringR: 87.5, ringW: 11,
    hydroR: 72, hydroW: 5, hydroGap: 5.5,
    tickOuter: 62, tickInner: 56, quarterInner: 51, tickW: 3.2, quarterW: 4.4, minuteDots: false,
    hourW: 8, hourLen: 38, minW: 6, minLen: 56, connW: 3.6, connLen: 13,
    secW: 2.6, secLen: 66, secTail: 15, weightW: 6, capR: 7, pinR: 2.6,
  },
  medium: {
    ringR: 88.5, ringW: 9,
    hydroR: 75.5, hydroW: 4, hydroGap: 4.5,
    tickOuter: 66, tickInner: 60.5, quarterInner: 55, tickW: 2.4, quarterW: 3.4, minuteDots: false,
    hourW: 6.6, hourLen: 41, minW: 5, minLen: 60, connW: 2.8, connLen: 13,
    secW: 2, secLen: 70, secTail: 16, weightW: 5, capR: 5.8, pinR: 2.1,
  },
  large: {
    ringR: 89.5, ringW: 8,
    hydroR: 77.5, hydroW: 3.5, hydroGap: 4,
    tickOuter: 68.5, tickInner: 63.5, quarterInner: 58, tickW: 2, quarterW: 2.9, minuteDots: true,
    hourW: 6, hourLen: 43, minW: 4.4, minLen: 63, connW: 2.4, connLen: 13,
    secW: 1.6, secLen: 73, secTail: 17, weightW: 4.4, capR: 5, pinR: 1.8,
  },
});

export const MAX_HYDRO_SEGMENTS = 16;

export function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  if (attrs) for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  if (parent) parent.appendChild(node);
  return node;
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export const r2 = (n) => String(Math.round(n * 100) / 100);

/** Point on a circle; 0° = 12 o'clock, clockwise. */
export function polar(deg, r) {
  const a = (deg - 90) * RAD;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
}

/** Clockwise arc path from `fromDeg` spanning `span` degrees (0 < span < 360). */
export function arcPath(fromDeg, span, r) {
  const s = Math.min(359.9, Math.max(0.01, span)); // zero-length subpath with round caps still renders a dot
  const [x0, y0] = polar(fromDeg, r);
  const [x1, y1] = polar(fromDeg + s, r);
  const large = s > 180 ? 1 : 0;
  return `M${r2(x0)} ${r2(y0)}A${r} ${r} 0 ${large} 1 ${r2(x1)} ${r2(y1)}`;
}

/**
 * Linear gradient vector that runs "along" a clockwise arc: from the start side to the end side,
 * perpendicular to the arc's symmetry axis. Works for any span (no conic gradients in SVG).
 * @returns {{x1:string,y1:string,x2:string,y2:string}}
 */
export function arcGradientVector(fromDeg, span, r, pad) {
  const mid = (fromDeg + span / 2) * RAD;
  const dx = Math.cos(mid);
  const dy = Math.sin(mid); // clockwise tangent at the arc midpoint (0° = up)
  const half = (span >= 180 ? r : Math.max(r * Math.sin((span / 2) * RAD), 1)) + pad;
  return { x1: r2(100 - dx * half), y1: r2(100 - dy * half), x2: r2(100 + dx * half), y2: r2(100 + dy * half) };
}

/** Static dial: ring track + hour ticks (+ minute dots on large). */
export function buildDial(svg, g) {
  clearNode(svg);
  svgEl('circle', { class: 'track', cx: 100, cy: 100, r: g.ringR, 'stroke-width': g.ringW }, svg);
  const ticks = svgEl('g', { class: 'ticks' }, svg);
  if (g.minuteDots) {
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) continue;
      const [x, y] = polar(i * 6, g.tickOuter - 1);
      svgEl('circle', { class: 'minute-dot', cx: r2(x), cy: r2(y), r: 0.8 }, ticks);
    }
  }
  for (let i = 0; i < 12; i++) {
    const quarter = i % 3 === 0;
    const [x1, y1] = polar(i * 30, quarter ? g.quarterInner : g.tickInner);
    const [x2, y2] = polar(i * 30, g.tickOuter);
    svgEl('line', {
      class: quarter ? 'tick tick-q' : 'tick',
      x1: r2(x1), y1: r2(y1), x2: r2(x2), y2: r2(y2),
      'stroke-width': quarter ? g.quarterW : g.tickW,
    }, ticks);
  }
}

/**
 * Dynamic ring layer: gradient, dashed "paused" ring, arc (+ soft underglow), break marker(s),
 * and an (initially empty) hydration group. Returns references for fast attribute updates.
 */
export function buildRings(svg, g) {
  clearNode(svg);
  const defs = svgEl('defs', null, svg);
  const grad = svgEl('linearGradient', { id: 'apArcGrad', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 200, y2: 200 }, defs);
  svgEl('stop', { offset: 0, class: 'stop-a' }, grad);
  svgEl('stop', { offset: 1, class: 'stop-b' }, grad);

  const hydro = svgEl('g', { class: 'hydro' }, svg);

  // paused: 60 short dashes (one per minute), butt caps
  const circumference = 2 * Math.PI * g.ringR;
  const step = circumference / 60;
  const dashed = svgEl('circle', {
    class: 'ring-dashed', cx: 100, cy: 100, r: g.ringR, 'stroke-width': r2(g.ringW * 0.62),
    'stroke-dasharray': `${r2(step * 0.42)} ${r2(step * 0.58)}`, transform: 'rotate(-90 100 100)',
  }, svg);
  // offset so a dash is centred on 12 o'clock
  dashed.setAttribute('stroke-dashoffset', r2(step * 0.21));

  const arcGlow = svgEl('path', { class: 'arc-glow', 'stroke-width': r2(g.ringW * 2.1), d: 'M0 0' }, svg);
  const arc = svgEl('path', { class: 'arc', 'stroke-width': g.ringW, d: 'M0 0' }, svg);

  const markers = svgEl('g', { class: 'markers' }, svg);
  const dotR = r2(Math.max(1.6, g.ringW * 0.23));
  const halo = svgEl('circle', { class: 'marker-halo', cx: 100, cy: 100, r: r2(g.ringW * 0.5) }, markers);
  const dot1 = svgEl('circle', { class: 'marker-dot', cx: 100, cy: 100, r: dotR }, markers);
  const dot2 = svgEl('circle', { class: 'marker-dot marker-dot-2', cx: 100, cy: 100, r: dotR }, markers);

  return { grad, hydro, dashed, arcGlow, arc, markers, halo, dot1, dot2 };
}

function segmentAngles(g, count) {
  const capDeg = (g.hydroW / 2 / g.hydroR) / RAD;
  const gapDeg = (g.hydroGap / g.hydroR) / RAD + 2 * capDeg;
  const step = 360 / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    let a0 = i * step + gapDeg / 2;
    let a1 = (i + 1) * step - gapDeg / 2;
    if (a1 <= a0) { const mid = (a0 + a1) / 2; a0 = mid; a1 = mid + 0.01; }
    out.push([a0, a1 - a0]);
  }
  return out;
}

/** Hydration ring: `count` segments with gaps (round caps). Returns the segment paths. */
export function buildHydro(group, g, count) {
  clearNode(group);
  const segments = [];
  if (count < 1) return segments;
  for (const [a0, span] of segmentAngles(g, count)) {
    segments.push(svgEl('path', { class: 'seg', d: arcPath(a0, span, g.hydroR), 'stroke-width': g.hydroW }, group));
  }
  return segments;
}

/** Glow copy of a single hydration segment (the next glass) on its own compositor layer. */
export function buildHydroPulse(svg, g, count, index) {
  clearNode(svg);
  if (count < 1 || index < 0 || index >= count) return;
  const [a0, span] = segmentAngles(g, count)[index];
  const d = arcPath(a0, span, g.hydroR);
  svgEl('path', { class: 'pulse-glow', d, 'stroke-width': r2(g.hydroW * 2.6) }, svg);
  svgEl('path', { class: 'pulse-seg', d, 'stroke-width': g.hydroW }, svg);
}

/** Hands pointing to 12 o'clock; rotated by CSS transforms on their own SVG layers. */
export function buildHands(nodes, g) {
  const { hour, minute, second } = nodes;
  for (const svg of [hour, minute, second]) clearNode(svg);

  const handGroup = (svg) => svgEl('g', { class: 'hand-g', filter: 'url(#apHandShadow)' }, svg);

  const h = handGroup(hour);
  svgEl('line', { class: 'hand-conn', x1: 100, y1: 100, x2: 100, y2: 100 - g.connLen, 'stroke-width': g.connW }, h);
  svgEl('line', { class: 'hand-body', x1: 100, y1: 100 - g.connLen, x2: 100, y2: 100 - g.hourLen, 'stroke-width': g.hourW }, h);

  const m = handGroup(minute);
  svgEl('line', { class: 'hand-conn', x1: 100, y1: 100, x2: 100, y2: 100 - g.connLen, 'stroke-width': g.connW }, m);
  svgEl('line', { class: 'hand-body', x1: 100, y1: 100 - g.connLen, x2: 100, y2: 100 - g.minLen, 'stroke-width': g.minW }, m);
  svgEl('circle', { class: 'hand-cap', cx: 100, cy: 100, r: g.capR }, m);
  svgEl('circle', { class: 'hand-pin', cx: 100, cy: 100, r: g.pinR }, m);

  const s = handGroup(second);
  svgEl('line', { class: 'sec-line', x1: 100, y1: 100 + g.secTail, x2: 100, y2: 100 - g.secLen, 'stroke-width': g.secW }, s);
  svgEl('line', { class: 'sec-weight', x1: 100, y1: 100 + 5, x2: 100, y2: 100 + g.secTail, 'stroke-width': g.weightW }, s);
  svgEl('circle', { class: 'sec-cap', cx: 100, cy: 100, r: r2(g.capR * 0.72) }, s);
  svgEl('circle', { class: 'hand-pin', cx: 100, cy: 100, r: r2(g.pinR * 0.8) }, s);
}
