// Inline SVG icon set (24×24 grid, stroke 1.75, rounded caps). Built with DOM APIs – no innerHTML.
import { s } from './lib/dom.js';

// Each icon: list of shapes. String = path `d`; objects: { c: [cx, cy, r] }, { r: [x, y, w, h, rx] }, { dot: [cx, cy] }.
const ICONS = {
  overview: ['M3.34 19a10 10 0 1 1 17.32 0', 'm12 14 4-4', { dot: [12, 14] }],
  settings: ['M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3', 'M14 2v4', 'M8 10v4', 'M16 18v4'],
  stats: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
  exercises: ['M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0', { c: [12, 12, 3] }],
  about: [{ c: [12, 12, 10] }, 'M12 16v-4', 'M12 8h.01'],

  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  play: ['M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z'],
  pause: [{ r: [6, 4, 4, 16, 1.2] }, { r: [14, 4, 4, 16, 1.2] }],
  skip: ['M5 4.8v14.4a.8.8 0 0 0 1.24.66L16 13.2a1.4 1.4 0 0 0 0-2.4L6.24 4.14A.8.8 0 0 0 5 4.8Z', 'M20 5v14'],
  reset: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  snooze: [{ c: [12, 13, 8] }, 'M5 3 2 6', 'm22 6-3-3', 'M12 10v6', 'M9 13h6'],
  coffee: ['M10 2v2', 'M14 2v2', 'M6 2v2', 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1'],
  stop: [{ r: [5, 5, 14, 14, 3] }],
  droplet: ['M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'],
  glass: ['M15.2 22H8.8a2 2 0 0 1-2-1.79L5 3h14l-1.81 17.21A2 2 0 0 1 15.2 22Z', 'M6 12a5 5 0 0 1 6 0 5 5 0 0 0 6 0'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  sun: [{ c: [12, 12, 4] }, 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  sunrise: ['M12 2v8', 'm4.93 10.93 1.41 1.41', 'M2 18h2', 'M20 18h2', 'm19.07 10.93-1.41 1.41', 'M22 22H2', 'm8 6 4-4 4 4', 'M16 18a4 4 0 0 0-8 0'],
  infinity: ['M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8'],
  clock: [{ c: [12, 12, 10] }, 'M12 6v6l4 2'],
  timer: ['M10 2h4', 'm12 14 3-3', { c: [12, 14, 8] }],
  monitor: [{ r: [2, 3, 20, 14, 2] }, 'M8 21h8', 'M12 17v4'],
  bulb: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
  lock: [{ r: [3, 11, 18, 11, 2] }, 'M7 11V7a5 5 0 0 1 10 0v4'],
  keyboard: [{ r: [2, 4, 20, 16, 2] }, 'M6 8h.01', 'M10 8h.01', 'M14 8h.01', 'M18 8h.01', 'M8 12h.01', 'M12 12h.01', 'M16 12h.01', 'M7 16h10'],
  bell: ['M10.27 21a2 2 0 0 0 3.46 0', 'M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33'],
  volume: ['M11 4.7a.7.7 0 0 0-1.2-.5L6.41 7.59A1.4 1.4 0 0 1 5.42 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.42a1.4 1.4 0 0 1 .99.41l3.39 3.39a.7.7 0 0 0 1.2-.5z', 'M16 9a5 5 0 0 1 0 6', 'M19.36 18.36a9 9 0 0 0 0-12.72'],
  palette: ['M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z', { dot: [13.5, 6.5] }, { dot: [17.5, 10.5] }, { dot: [6.5, 12.5] }, { dot: [8.5, 7.5] }],
  globe: [{ c: [12, 12, 10] }, 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  power: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.77.04'],
  briefcase: ['M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16', { r: [2, 6, 20, 14, 2] }],
  widget: [{ c: [12, 12, 9] }, 'M12 7v5l3 2'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  sparkles: ['M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z'],
  checkCircle: [{ c: [12, 12, 10] }, 'm9 12 2 2 4-4'],
  percent: ['M19 5 5 19', { c: [6.5, 6.5, 2.5] }, { c: [17.5, 17.5, 2.5] }],
  activity: ['M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2'],
  away: ['M2 21a8 8 0 0 1 11.87-7', { c: [10, 8, 5] }, 'm17 17 5 5', 'm22 17-5 5'],
  leaf: ['M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z', 'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  layers: ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65', 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  drive: ['M22 12H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', 'M6 16h.01', 'M10 16h.01'],
  cloudOff: ['m2 2 20 20', 'M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.19', 'M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 10 5.07'],
  wifiOff: ['M12 20h.01', 'M8.5 16.43a5 5 0 0 1 7 0', 'M5 12.86a10 10 0 0 1 5.17-2.69', 'M19 12.86a10 10 0 0 0-2-1.52', 'M2 8.82a15 15 0 0 1 4.18-2.64', 'M22 8.82a15 15 0 0 0-11.29-3.76', 'm2 2 20 20'],
  box: ['M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
  code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  heart: ['M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'],
  calendar: [{ r: [3, 4, 18, 18, 2] }, 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  move: ['M12 2v20', 'm15 19-3 3-3-3', 'm19 9 3 3-3 3', 'M2 12h20', 'm5 9-3 3 3 3', 'm9 5 3-3 3 3'],
  target: [{ c: [12, 12, 10] }, { c: [12, 12, 6] }, { c: [12, 12, 2] }],
  eyeOff: ['M10.73 5.08A10.74 10.74 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49', 'M14.08 14.16a3 3 0 0 1-4.24-4.24', 'M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14', 'm2 2 20 20'],
  video: ['m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5', { r: [2, 6, 14, 12, 2] }],
  person: [{ c: [12, 5, 1.5] }, 'm9 20 3-6 3 6', 'm6 8 6 2 6-2', 'M12 10v4'],
  hourglass: ['M5 22h14', 'M5 2h14', 'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22', 'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'],
  fastForward: ['M12 6.5v11a.5.5 0 0 0 .8.4l7.4-5.5a.5.5 0 0 0 0-.8l-7.4-5.5a.5.5 0 0 0-.8.4Z', 'M3 6.5v11a.5.5 0 0 0 .8.4l7.4-5.5a.5.5 0 0 0 0-.8L3.8 6.1a.5.5 0 0 0-.8.4Z'],
  hand: ['M18 11V6a2 2 0 0 0-4 0v1', 'M14 10V4a2 2 0 0 0-4 0v2', 'M10 10.5V6a2 2 0 0 0-4 0v8', 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'],
};

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * @param {string} name
 * @param {{ size?: number, class?: string, label?: string }} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const shapes = ICONS[name] || ICONS.about;
  const size = opts.size || 18;
  const svg = s('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: ['icon', opts.class].filter(Boolean).join(' '),
    'aria-hidden': opts.label ? null : 'true',
    role: opts.label ? 'img' : null,
    'aria-label': opts.label || null,
    focusable: 'false',
  });
  for (const shape of shapes) {
    if (typeof shape === 'string') svg.appendChild(s('path', { d: shape }));
    else if (shape.c) svg.appendChild(s('circle', { cx: shape.c[0], cy: shape.c[1], r: shape.c[2] }));
    else if (shape.r) svg.appendChild(s('rect', { x: shape.r[0], y: shape.r[1], width: shape.r[2], height: shape.r[3], rx: shape.r[4] || 0 }));
    else if (shape.dot) svg.appendChild(s('circle', { cx: shape.dot[0], cy: shape.dot[1], r: 1, fill: 'currentColor', stroke: 'none' }));
  }
  return svg;
}

/** App logo mark: gradient tile with a progress ring and an eye. */
export function logoMark(size = 28, idSuffix = 'a') {
  const gid = `ap-logo-grad-${idSuffix}`;
  return s('svg', { viewBox: '0 0 32 32', width: size, height: size, class: 'logo-mark', 'aria-hidden': 'true', focusable: 'false' },
    s('defs', null,
      s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 },
        s('stop', { offset: '0%', class: 'logo-stop-1' }),
        s('stop', { offset: '100%', class: 'logo-stop-2' }))),
    s('rect', { x: 0, y: 0, width: 32, height: 32, rx: 9, fill: `url(#${gid})` }),
    s('circle', { cx: 16, cy: 16, r: 10.5, fill: 'none', class: 'logo-track', 'stroke-width': 2 }),
    s('circle', {
      cx: 16, cy: 16, r: 10.5, fill: 'none', class: 'logo-arc', 'stroke-width': 2.2, 'stroke-linecap': 'round',
      'stroke-dasharray': '50 66', transform: 'rotate(-90 16 16)',
    }),
    s('path', { d: 'M9.6 16c1.6-2.5 3.8-3.8 6.4-3.8s4.8 1.3 6.4 3.8c-1.6 2.5-3.8 3.8-6.4 3.8S11.2 18.5 9.6 16Z', class: 'logo-eye', fill: 'none', 'stroke-width': 1.7, 'stroke-linejoin': 'round' }),
    s('circle', { cx: 16, cy: 16, r: 1.9, class: 'logo-pupil' }));
}
