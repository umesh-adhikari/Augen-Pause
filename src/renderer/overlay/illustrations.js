// Static line-art illustrations for the guided exercises (viewBox 120×120).
// Constant templates (no dynamic data). overlay.js parses them as standalone SVG documents
// (DOMParser 'image/svg+xml' + importNode) – there are no innerHTML sinks in the renderers.
// Every template therefore is a well-formed XML document with the SVG namespace on its root.
// Animations live in overlay.css and only use transform / opacity.
// Paint servers #il-grad / #il-water-grad are defined once in index.html.

const svg = (name, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="il il-${name}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">${body}</svg>`;

const EYE = 'M14 60 Q60 18 106 60 Q60 102 14 60 Z';

// Lemniscate x = 60 − 44·cos θ, y = 60 − 16·sin 2θ – matches the eight-x / eight-y CSS motion exactly.
const EIGHT =
  'M16 60 C16 57.33 16.52 54.31 17.5 52 C18.48 49.69 20 47.48 21.89 46.14 C23.79 44.81 26.2 44 28.89 44 ' +
  'C31.57 44 34.71 44.81 38 46.14 C41.29 47.48 44.95 49.69 48.61 52 C52.28 54.31 56.2 57.33 60 60 ' +
  'C63.8 62.67 67.72 65.69 71.39 68 C75.05 70.31 78.71 72.52 82 73.86 C85.29 75.19 88.43 76 91.11 76 ' +
  'C93.8 76 96.21 75.19 98.11 73.86 C100 72.52 101.52 70.31 102.5 68 C103.48 65.69 104 62.67 104 60 ' +
  'C104 57.33 103.48 54.31 102.5 52 C101.52 49.69 100 47.48 98.11 46.14 C96.21 44.81 93.8 44 91.11 44 ' +
  'C88.43 44 85.29 44.81 82 46.14 C78.71 47.48 75.05 49.69 71.39 52 C67.72 54.31 63.8 57.33 60 60 ' +
  'C56.2 62.67 52.28 65.69 48.61 68 C44.95 70.31 41.29 72.52 38 73.86 C34.71 75.19 31.57 76 28.89 76 ' +
  'C26.2 76 23.79 75.19 21.89 73.86 C20 72.52 18.48 70.31 17.5 68 C16.52 65.69 16 62.67 16 60Z';

export const ILLUSTRATIONS = Object.freeze({
  // 20-20-20: eye looking at a far horizon
  far: svg('far', `
    <circle class="il-glow far-glow" cx="90" cy="32" r="15"/>
    <circle class="il-accent" cx="90" cy="32" r="6.5"/>
    <path class="il-soft" d="M48 70 H114"/>
    <path class="il-line" d="M54 70 L71 50 L80 59 L91 45 L110 70"/>
    <path class="il-soft il-dash" d="M38 84 L78 58"/>
    <circle class="il-fill-accent far-dot" cx="44" cy="80" r="2.4"/>
    <g class="far-eye">
      <path class="il-line" d="M6 92 Q22 74 38 92 Q22 110 6 92 Z"/>
      <circle class="il-fill-accent" cx="25.5" cy="90" r="4.6"/>
    </g>
  `),

  // Slow, deliberate blinking
  blink: svg('blink', `
    <g class="blink-eye">
      <path class="il-line" d="${EYE}"/>
      <circle class="il-accent" cx="60" cy="60" r="16"/>
      <circle class="il-fill-accent" cx="60" cy="60" r="6"/>
    </g>
    <g class="blink-lashes">
      <path class="il-accent" d="M18 60 Q60 84 102 60"/>
      <path class="il-soft" d="M36 70 L31 78"/>
      <path class="il-soft" d="M60 73 V82"/>
      <path class="il-soft" d="M84 70 L89 78"/>
    </g>
  `),

  // Eye circles – pupil orbits, direction alternates
  roll: svg('roll', `
    <defs><clipPath id="il-roll-clip"><path d="${EYE}"/></clipPath></defs>
    <path class="il-soft" d="M14.7 38.9 A50 50 0 0 1 105.3 38.9"/>
    <path class="il-soft" d="M106.5 32 L105.3 38.9 L99.2 35.4"/>
    <path class="il-soft" d="M105.3 81.1 A50 50 0 0 1 14.7 81.1"/>
    <path class="il-soft" d="M13.5 88 L14.7 81.1 L20.8 84.6"/>
    <path class="il-line" d="${EYE}"/>
    <g clip-path="url(#il-roll-clip)">
      <g class="roll-orbit">
        <circle class="il-accent" cx="70" cy="60" r="14"/>
        <circle class="il-fill-accent" cx="70" cy="60" r="5"/>
      </g>
    </g>
  `),

  // Near–far focus: thumb ↔ horizon
  nearfar: svg('nearfar', `
    <g class="nf-far">
      <path class="il-soft" d="M58 40 H114"/>
      <path class="il-line" d="M64 40 L77 26 L85 34 L94 24 L108 40"/>
    </g>
    <g class="nf-near">
      <path class="il-line" d="M20 116 V80 Q20 62 34 62 Q48 62 48 80 V116"/>
      <path class="il-soft" d="M27 76 Q34 68 41 76"/>
    </g>
    <g class="nf-focus">
      <circle class="il-accent" cx="34" cy="80" r="20"/>
      <path class="il-soft" d="M34 54 V60 M34 100 V106 M8 80 H14 M54 80 H60"/>
    </g>
  `),

  // Palming: warm hands gently cupped over the eyes
  palming: svg('palming', `
    <circle class="il-glow pm-glow" cx="60" cy="66" r="36"/>
    <path class="il-soft" d="M24 72 C24 44 40 26 60 26 C80 26 96 44 96 72 C96 94 80 112 60 112 C40 112 24 94 24 72 Z"/>
    <g class="pm-eyes">
      <path class="il-soft" d="M36 70 Q44 76 52 70"/>
      <path class="il-soft" d="M68 70 Q76 76 84 70"/>
    </g>
    <path class="il-soft" d="M52 94 Q60 99 68 94"/>
    <g class="pm-hand pm-hand-l">
      <path class="il-cover il-accent" d="M22 104 C15 90 14 66 22 50 C26 41 35 38 42 42 C49 46 55 56 57 68 C58 76 55 84 49 88 L40 106 Z"/>
      <path class="il-soft" d="M30 47 C29 58 31 66 35 74"/>
      <path class="il-soft" d="M40 44 C40 55 43 64 47 72"/>
    </g>
    <g class="pm-hand pm-hand-r">
      <path class="il-cover il-accent" d="M98 104 C105 90 106 66 98 50 C94 41 85 38 78 42 C71 46 65 56 63 68 C62 76 65 84 71 88 L80 106 Z"/>
      <path class="il-soft" d="M90 47 C91 58 89 66 85 74"/>
      <path class="il-soft" d="M80 44 C80 55 77 64 73 72"/>
    </g>
    <g class="pm-warmth">
      <path class="il-soft pm-wisp pm-wisp-1" d="M46 18 Q43 13 46 8"/>
      <path class="il-soft pm-wisp pm-wisp-2" d="M60 15 Q57 10 60 5"/>
      <path class="il-soft pm-wisp pm-wisp-3" d="M74 18 Q71 13 74 8"/>
    </g>
  `),

  // Trace a sideways figure eight – a glowing dot follows the curve (composited Lissajous motion)
  eight: svg('eight', `
    <path class="il-soft" d="${EIGHT}"/>
    <g class="eight-x">
      <g class="eight-y">
        <circle class="il-glow" cx="60" cy="60" r="11"/>
        <circle class="il-fill-accent" cx="60" cy="60" r="5"/>
      </g>
    </g>
  `),

  // Stand up & stretch
  stretch: svg('stretch', `
    <path class="il-soft" d="M30 110 H90"/>
    <circle class="il-glow st-glow" cx="60" cy="22" r="18"/>
    <g class="st-body">
      <circle class="il-line" cx="60" cy="26" r="8"/>
      <path class="il-line" d="M60 38 V72"/>
      <path class="il-line" d="M60 72 L50 106 M60 72 L70 106"/>
      <g class="st-arm st-arm-l"><path class="il-accent" d="M60 44 L42 62"/></g>
      <g class="st-arm st-arm-r"><path class="il-accent" d="M60 44 L78 62"/></g>
    </g>
  `),

  // Shoulder rolls
  shoulders: svg('shoulders', `
    <circle class="il-line" cx="60" cy="42" r="15"/>
    <g class="sh-shoulders">
      <path class="il-line" d="M14 108 C14 86 26 72 46 70 C54 69 66 69 74 70 C94 72 106 86 106 108"/>
    </g>
    <g class="sh-arrow sh-arrow-l">
      <path class="il-accent" d="M31 52 A9 9 0 1 1 22 43"/>
      <path class="il-accent" d="M18 39 L22 43 L18 47"/>
    </g>
    <g class="sh-arrow sh-arrow-r">
      <path class="il-accent" d="M89 52 A9 9 0 1 0 98 43"/>
      <path class="il-accent" d="M102 39 L98 43 L102 47"/>
    </g>
  `),

  // A glass of water
  water: svg('water', `
    <defs><clipPath id="il-water-clip"><path d="M37 32 L44 100 Q45 106 51 106 H69 Q75 106 76 100 L83 32 Z"/></clipPath></defs>
    <path class="wa-drop" d="M60 6 C60 6 54 13.5 54 17.5 A6 6 0 0 0 66 17.5 C66 13.5 60 6 60 6 Z"/>
    <g clip-path="url(#il-water-clip)">
      <g class="wa-wave">
        <path class="wa-water" d="M-40 62 Q-30 56 -20 62 T0 62 T20 62 T40 62 T60 62 T80 62 T100 62 T120 62 T140 62 V130 H-40 Z"/>
      </g>
      <circle class="wa-bubble wa-bubble-1" cx="52" cy="96" r="2"/>
      <circle class="wa-bubble wa-bubble-2" cx="66" cy="92" r="1.6"/>
    </g>
    <path class="il-line" d="M37 32 L44 100 Q45 106 51 106 H69 Q75 106 76 100 L83 32"/>
    <path class="il-soft" d="M34 32 H86"/>
  `),
});
