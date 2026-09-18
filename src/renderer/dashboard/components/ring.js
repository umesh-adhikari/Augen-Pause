// Large SVG progress ring with gradient stroke, tick marks and an end knob.
// Colours come from CSS custom properties (--ring-1 / --ring-2 / --ring-glow) set per phase.
import { s, setAttr, nextId } from '../lib/dom.js';

const VIEW = 240;
const C = VIEW / 2;

export function createRing({ radius = 102, stroke = 12, className } = {}) {
  const gid = nextId('ring-grad');
  const circumference = 2 * Math.PI * radius;
  const tickR = radius + stroke / 2 + 7;
  const tickCirc = 2 * Math.PI * tickR;

  const arc = s('circle', {
    class: 'ring-arc', cx: C, cy: C, r: radius, fill: 'none', 'stroke-width': stroke, 'stroke-linecap': 'round',
    stroke: `url(#${gid})`, 'stroke-dasharray': circumference.toFixed(2), 'stroke-dashoffset': circumference.toFixed(2),
    transform: `rotate(-90 ${C} ${C})`,
  });
  const knob = s('circle', { class: 'ring-knob', cx: C, cy: C - radius, r: stroke / 2 - 2.5 });
  const knobGroup = s('g', { class: 'ring-knob-group' }, knob);

  const el = s('svg', { viewBox: `0 0 ${VIEW} ${VIEW}`, class: ['ring', className].filter(Boolean).join(' '), 'aria-hidden': 'true', focusable: 'false' },
    s('defs', null,
      s('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: 20, y1: 10, x2: 220, y2: 230 },
        s('stop', { offset: '0', class: 'ring-stop-1' }),
        s('stop', { offset: '1', class: 'ring-stop-2' }))),
    s('circle', {
      class: 'ring-ticks', cx: C, cy: C, r: tickR, fill: 'none', 'stroke-width': 3,
      'stroke-dasharray': `1.2 ${(tickCirc / 60 - 1.2).toFixed(3)}`, transform: `rotate(-90.3 ${C} ${C})`,
    }),
    s('circle', { class: 'ring-track', cx: C, cy: C, r: radius, fill: 'none', 'stroke-width': stroke }),
    s('g', { class: 'ring-arc-layer' }, arc),
    knobGroup);

  let last = -1;
  function set(fraction) {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const rounded = Math.round(f * 2000) / 2000;
    if (rounded === last) return;
    const jump = last < 0 || Math.abs(rounded - last) > 0.12;
    el.classList.toggle('is-jump', jump);
    last = rounded;
    setAttr(arc, 'stroke-dashoffset', (circumference * (1 - rounded)).toFixed(2));
    el.classList.toggle('is-empty', rounded < 0.003);
    knobGroup.style.setProperty('transform', `rotate(${(rounded * 360).toFixed(2)}deg)`);
  }

  return { el, set };
}
