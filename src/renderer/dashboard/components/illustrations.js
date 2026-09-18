// Small looping line-art illustrations for the exercise cards (viewBox 160×120).
// Built with DOM APIs; animations live in dashboard.css (.ill-*), paused unless the card is visible.
import { s, nextId } from '../lib/dom.js';

const svg = (name, ...children) => s('svg', {
  class: `ill ill-${name}`, viewBox: '0 0 160 120', 'aria-hidden': 'true', focusable: 'false',
}, ...children);

const line = (d, cls = 'il-line', extra = {}) => s('path', { d, class: cls, ...extra });
const EYE = (cx, cy, w, hgt) => `M${cx - w} ${cy} Q${cx} ${cy - hgt} ${cx + w} ${cy} Q${cx} ${cy + hgt} ${cx - w} ${cy} Z`;

const BUILDERS = {
  far() {
    return svg('far',
      line('M66 84 H152', 'il-soft'),
      line('M80 84 L100 58 L110 69 L124 50 L146 84', 'il-line'),
      s('circle', { cx: 132, cy: 30, r: 7, class: 'il-accent far-sun' }),
      line('M50 76 L96 60', 'il-accent far-sight', { 'stroke-dasharray': '2 6' }),
      s('g', { class: 'far-eye' },
        line(EYE(30, 78, 20, 26), 'il-line'),
        s('circle', { cx: 30, cy: 78, r: 8, class: 'il-accent' }),
        s('circle', { cx: 32, cy: 76.5, r: 3.4, class: 'il-fill far-pupil' })));
  },

  blink() {
    return svg('blink',
      s('g', { class: 'blink-eye' },
        line(EYE(80, 56, 50, 58), 'il-line'),
        s('circle', { cx: 80, cy: 56, r: 17, class: 'il-accent' }),
        s('circle', { cx: 80, cy: 56, r: 7, class: 'il-fill' }),
        s('circle', { cx: 85, cy: 51, r: 2.2, class: 'il-shine' })),
      s('g', { class: 'blink-lashes' },
        line('M52 78 L46 88', 'il-soft'),
        line('M80 84 V95', 'il-soft'),
        line('M108 78 L114 88', 'il-soft')));
  },

  roll() {
    const clip = nextId('ill-clip');
    return svg('roll',
      s('defs', null, s('clipPath', { id: clip }, s('path', { d: EYE(80, 60, 46, 56) }))),
      line('M36 30 A52 52 0 0 1 124 30', 'il-soft'),
      line('M118 22 L124 30 L114 32', 'il-soft'),
      line('M124 90 A52 52 0 0 1 36 90', 'il-soft'),
      line('M42 98 L36 90 L46 88', 'il-soft'),
      line(EYE(80, 60, 46, 56), 'il-line'),
      s('g', { 'clip-path': `url(#${clip})` },
        s('g', { class: 'roll-orbit' },
          s('circle', { cx: 92, cy: 60, r: 14, class: 'il-accent' }),
          s('circle', { cx: 92, cy: 60, r: 5.5, class: 'il-fill' }))));
  },

  nearfar() {
    return svg('nearfar',
      line('M88 70 H152', 'il-soft'),
      line('M96 70 L110 52 L118 60 L128 48 L146 70', 'il-line'),
      s('rect', { x: 34, y: 38, width: 20, height: 66, rx: 10, class: 'il-line' }),
      line('M38 50 H50', 'il-soft'),
      s('circle', { cx: 44, cy: 52, r: 22, class: 'il-accent nf-ring nf-near', 'stroke-dasharray': '4 5' }),
      s('circle', { cx: 121, cy: 58, r: 22, class: 'il-accent nf-ring nf-far', 'stroke-dasharray': '4 5' }));
  },

  palming() {
    return svg('palming',
      line('M40 112 Q40 84 56 76 M120 112 Q120 84 104 76', 'il-soft'),
      s('ellipse', { cx: 80, cy: 62, rx: 32, ry: 38, class: 'il-soft' }),
      s('g', { class: 'palm-hands' },
        s('path', { d: 'M46 82 C42 64 46 44 60 40 C72 37 80 46 80 58 L80 80 C72 86 54 88 46 82 Z', class: 'il-accent il-tint' }),
        s('path', { d: 'M114 82 C118 64 114 44 100 40 C88 37 80 46 80 58 L80 80 C88 86 106 88 114 82 Z', class: 'il-accent il-tint' }),
        line('M54 46 L58 62 M63 40 L65 60 M72 42 L72 60', 'il-accent palm-finger'),
        line('M106 46 L102 62 M97 40 L95 60 M88 42 L88 60', 'il-accent palm-finger')),
      s('g', { class: 'palm-warmth' },
        line('M62 22 Q66 16 62 10', 'il-soft palm-wave w1'),
        line('M80 20 Q84 14 80 8', 'il-soft palm-wave w2'),
        line('M98 22 Q102 16 98 10', 'il-soft palm-wave w3')));
  },

  eight() {
    const path = 'M80 60 C96 36 136 34 136 60 C136 86 96 84 80 60 C64 36 24 34 24 60 C24 86 64 84 80 60 Z';
    return svg('eight',
      line(path, 'il-soft'),
      s('path', { d: path, class: 'il-accent eight-trail', pathLength: 100 }),
      s('path', { d: path, class: 'il-accent eight-tracer', pathLength: 100 }));
  },

  neck() {
    return svg('neck',
      line('M34 106 Q38 78 66 74 Q80 72 94 74 Q122 78 126 106', 'il-line neck-shoulders'),
      s('g', { class: 'neck-head' },
        line('M80 74 V60', 'il-line'),
        s('circle', { cx: 80, cy: 40, r: 17, class: 'il-line' }),
        s('circle', { cx: 74, cy: 38, r: 1.8, class: 'il-fill' }),
        s('circle', { cx: 86, cy: 38, r: 1.8, class: 'il-fill' })),
      line('M44 34 A40 40 0 0 1 52 20', 'il-accent neck-arc left'),
      line('M116 34 A40 40 0 0 0 108 20', 'il-accent neck-arc right'));
  },

  water() {
    const clip = nextId('ill-clip');
    const glass = 'M58 34 H102 L95 104 Q94 110 88 110 H72 Q66 110 65 104 Z';
    return svg('water',
      s('defs', null, s('clipPath', { id: clip }, s('path', { d: glass }))),
      s('g', { 'clip-path': `url(#${clip})` },
        s('g', { class: 'water-level' },
          s('path', { d: 'M40 70 Q50 64 60 70 T80 70 T100 70 T120 70 V120 H40 Z', class: 'il-water' }))),
      line(glass, 'il-line'),
      s('path', { d: 'M80 6 C80 6 73 15 73 19.5 A7 7 0 0 0 87 19.5 C87 15 80 6 80 6 Z', class: 'il-water-stroke water-drop' }),
      s('g', { class: 'water-person' },
        s('circle', { cx: 132, cy: 50, r: 5, class: 'il-line' }),
        line('M132 56 V80 M132 80 L124 98 M132 80 L140 98 M120 64 L132 60 L144 64', 'il-line')));
  },
};

export const EXERCISE_IDS = Object.freeze(Object.keys(BUILDERS));

export function illustration(id) {
  return (BUILDERS[id] || BUILDERS.blink)();
}
