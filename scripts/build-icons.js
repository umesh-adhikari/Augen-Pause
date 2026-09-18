#!/usr/bin/env node
'use strict';

/**
 * AugenPause icon generator – zero dependencies (node:zlib only).
 *
 *   node scripts/build-icons.js            → assets/icons/*
 *   node scripts/build-icons.js --out dir  → custom output directory
 *
 * Everything is drawn from signed distance fields (SDF) with analytic anti-aliasing (one-pixel box filter
 * on the distance) and composited in premultiplied float RGBA, then encoded as 8-bit RGBA PNG (adaptive
 * row filters + deflate). Small sizes are rendered natively (not downscaled) with pixel-hinted geometry
 * so the ring and the eye stay crisp at 16–32 px. Output is deterministic (no timestamps).
 *
 * Design: rounded square with continuous corners (8 % transparent margin), navy → indigo diagonal
 * gradient with a cool top light, luminous teal → cyan 75 % progress ring with soft glow, stylised eye
 * (almond lids, gradient iris, pupil, highlight).
 *
 * Outputs
 *   icon.png (1024)  source for electron-builder (.ico / .icns / Linux icon set)
 *   icon-512.png, icon-256.png, icon-64.png
 *   icon.ico         16/20/24/32/40/48/64/256 natively rendered (for win.icon / BrowserWindow on Windows)
 *   tray.png (32) + tray@2x.png (64)             light glyph – dark taskbars / panels
 *   tray-dark.png (32) + tray-dark@2x.png (64)   dark glyph – light Windows taskbar
 *   tray.ico, tray-dark.ico                      16…64 px natively rendered (Windows tray, every DPI)
 *   trayTemplate.png (16) + trayTemplate@2x.png (32)  macOS template image (black + alpha)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// =====================================================================================================
// PNG / ICO encoding
// =====================================================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encode 8-bit RGBA pixels (Uint8Array, length w*h*4) as PNG with per-row adaptive filtering. */
function encodePNG(width, height, rgba) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = (y - 1) * stride;
    let bestSum = Infinity;
    let bestFilter = 0;
    for (let filter = 0; filter < 5; filter++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const cur = rgba[row + x];
        const left = x >= bpp ? rgba[row + x - bpp] : 0;
        const up = y > 0 ? rgba[prev + x] : 0;
        const upLeft = y > 0 && x >= bpp ? rgba[prev + x - bpp] : 0;
        let v;
        switch (filter) {
          case 0: v = cur; break;
          case 1: v = cur - left; break;
          case 2: v = cur - up; break;
          case 3: v = cur - ((left + up) >> 1); break;
          default: v = cur - paeth(left, up, upLeft); break;
        }
        v &= 0xff;
        candidate[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestFilter = filter;
        candidate.copy(best);
      }
    }
    const offset = y * (stride + 1);
    raw[offset] = bestFilter;
    best.copy(raw, offset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO with 32-bit BMP entries below 256 px (best compatibility) and a PNG entry for 256 px. */
function encodeICO(images /* [{ size, rgba }] */) {
  const entries = images.map(({ size, rgba }) => {
    if (size >= 256) return { size, data: encodePNG(size, size, rgba) };
    const maskStride = Math.ceil(size / 32) * 4;
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // XOR + AND mask
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(size * size * 4 + maskStride * size, 20);
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size; // bottom-up
      for (let x = 0; x < size; x++) {
        const s = (src + x) * 4;
        const d = (y * size + x) * 4;
        pixels[d] = rgba[s + 2];
        pixels[d + 1] = rgba[s + 1];
        pixels[d + 2] = rgba[s];
        pixels[d + 3] = rgba[s + 3];
      }
    }
    const mask = Buffer.alloc(maskStride * size); // all zero – alpha channel is authoritative
    return { size, data: Buffer.concat([header, pixels, mask]) };
  });
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((entry, i) => {
    const o = 6 + i * 16;
    dir[o] = entry.size >= 256 ? 0 : entry.size;
    dir[o + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(entry.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

// =====================================================================================================
// Math, colour & SDF helpers
// =====================================================================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function hex(value) {
  const n = parseInt(value.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mixColor(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

/** Multi-stop gradient: stops = [[t, color], ...] sorted by t. */
function gradient(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mixColor(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Rounded box with "continuous" (superelliptic, exponent p) corners.
 * h = half extent, r = corner radius. Distance is normalised by the gradient length so the
 * anti-aliasing width stays exactly one pixel along the whole contour.
 */
function sdSquircleBox(x, y, h, r, p) {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  if (qx > 0 && qy > 0) {
    const n = Math.pow(Math.pow(qx, p) + Math.pow(qy, p), 1 / p);
    const gx = Math.pow(qx / n, p - 1);
    const gy = Math.pow(qy / n, p - 1);
    return (n - r) / Math.hypot(gx, gy);
  }
  return Math.max(qx, qy) - r;
}

/** Horizontal almond (vesica): tips at (±a, 0), half height b. */
function makeAlmond(a, b) {
  const r = (a * a / b + b) / 2;
  const d = r - b;
  return (x, y) => {
    // vertical vesica formula (iq) with swapped axes
    const px = Math.abs(y);
    const py = Math.abs(x);
    return (py - a) * d > px * a ? Math.hypot(px, py - a) : Math.hypot(px + d, py) - r;
  };
}

/**
 * Open ring arc starting at 12 o'clock, running clockwise over `sweep` radians, rounded caps.
 * Returns [distance, t] where t ∈ [0,1] is the position along the arc (for gradients).
 */
function sdArc(x, y, radius, halfWidth, sweep) {
  let angle = Math.atan2(x, -y); // 0 at 12 o'clock, clockwise positive (y points down)
  if (angle < 0) angle += Math.PI * 2;
  const len = Math.hypot(x, y);
  if (angle <= sweep) return [Math.abs(len - radius) - halfWidth, angle / sweep];
  const ex = radius * Math.sin(sweep);
  const ey = -radius * Math.cos(sweep);
  const dStart = Math.hypot(x, y + radius);
  const dEnd = Math.hypot(x - ex, y - ey);
  return dStart < dEnd ? [dStart - halfWidth, 0] : [dEnd - halfWidth, 1];
}

/** Coverage of a shape with signed distance d for a pixel of size ps (box-filter approximation). */
const cover = (d, ps) => clamp01(0.5 - d / ps);

// =====================================================================================================
// Canvas (premultiplied float RGBA)
// =====================================================================================================

function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function toRGBA8(canvas) {
  const { size, data } = canvas;
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const a = clamp01(data[o + 3]);
    const a8 = Math.round(a * 255);
    out[o + 3] = a8;
    if (a8 === 0) continue;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(clamp01(data[o + c] / a) * 255);
  }
  return out;
}

/**
 * Run a per-pixel shader. shader(x, y, ps, px) receives centred unit coordinates (-0.5..0.5, y down),
 * the pixel size in unit coordinates and a scratch "pen" with an over() compositor.
 */
function render(size, shader) {
  const canvas = createCanvas(size);
  const ps = 1 / size;
  const d = canvas.data;
  const pen = {
    o: 0,
    over(color, alpha) {
      if (alpha <= 0) return;
      const a = alpha > 1 ? 1 : alpha;
      const k = 1 - a;
      const o = this.o;
      d[o] = color[0] * a + d[o] * k;
      d[o + 1] = color[1] * a + d[o + 1] * k;
      d[o + 2] = color[2] * a + d[o + 2] * k;
      d[o + 3] = a + d[o + 3] * k;
    },
    /** screen blend of light onto what is already there (keeps alpha) */
    light(color, alpha) {
      if (alpha <= 0) return;
      const o = this.o;
      const dstA = d[o + 3];
      for (let c = 0; c < 3; c++) {
        const s = color[c] * alpha * dstA;
        d[o + c] = d[o + c] + s - (d[o + c] * s) / Math.max(dstA, 1e-6);
      }
    },
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      pen.o = (j * size + i) * 4;
      shader((i + 0.5) / size - 0.5, (j + 0.5) / size - 0.5, ps, pen);
    }
  }
  return canvas;
}

// =====================================================================================================
// Design
// =====================================================================================================

const COLORS = {
  bgTop: hex('#0b1020'),
  bgBottom: hex('#1e2a5a'),
  teal: hex('#2dd4bf'),
  cyan: hex('#22d3ee'),
  cyanLight: hex('#a5f3fc'),
  topLight: hex('#5b6bb8'),
  eye: hex('#e8ecf6'),
  eyeTop: hex('#ffffff'),
  eyeBottom: hex('#c9d2e8'),
  irisInner: hex('#67e8f9'),
  irisMid: hex('#22d3ee'),
  irisOuter: hex('#4f46e5'),
  irisRim: hex('#1e1b4b'),
  pupil: hex('#070b18'),
  white: [1, 1, 1],
  black: [0, 0, 0],
  trayDarkEye: hex('#1e2a5a'),
  trayDarkRingA: hex('#0d9488'),
  trayDarkRingB: hex('#0891b2'),
};

const SWEEP = Math.PI * 1.5; // 75 % progress ring

/**
 * Geometry of the app icon for a given pixel size. Unit coordinates (canvas = 1).
 * Large sizes use the macOS-style grid (8 % margin); small native sizes (ICO) snap the margin to whole
 * pixels and enforce minimum stroke widths so the glyph never dissolves.
 */
/**
 * Pixel-hinted geometry for the smallest sizes (values in pixels from the centre). Stroke edges of the ring
 * land on whole pixels at the cardinal points, which keeps 16–32 px renders crisp.
 */
const APP_HINTED = {
  16: { half: 7, ringOuter: 6, ringInner: 4, eyeA: 3.25, eyeB: 2.15, eyeHW: 0.55, irisR: 1.9, pupilR: 0.95 },
  20: { half: 9, ringOuter: 7.5, ringInner: 5.5, eyeA: 4.1, eyeB: 2.6, eyeHW: 0.62, irisR: 2.2, pupilR: 1 },
  24: { half: 11, ringOuter: 9, ringInner: 7, eyeA: 5, eyeB: 3.1, eyeHW: 0.72, irisR: 2.6, pupilR: 1.1 },
  32: { half: 14, ringOuter: 12, ringInner: 9, eyeA: 6.6, eyeB: 4.1, eyeHW: 0.9, irisR: 3.4, pupilR: 1.45 },
};

function appIconGeometry(size) {
  const px = 1 / size;
  const hinted = APP_HINTED[size];
  if (hinted) {
    const u = (value) => value * px;
    return {
      half: u(hinted.half),
      radius: u(hinted.half) * 2 * 0.225 * 1.5,
      corner: 3.2,
      ringR: u((hinted.ringOuter + hinted.ringInner) / 2),
      ringHW: u((hinted.ringOuter - hinted.ringInner) / 2),
      eyeA: u(hinted.eyeA),
      eyeB: u(hinted.eyeB),
      eyeHW: u(hinted.eyeHW),
      irisR: u(hinted.irisR),
      pupilR: u(hinted.pupilR),
      glintR: 0,
      glintX: 0,
      glintY: 0,
      shadow: false,
      glow: false,
      track: size >= 24,
      detail: false,
    };
  }
  // 0 at 16 px … 1 from 128 px: small renders get a fuller canvas, a bigger glyph and bolder strokes
  const k = clamp01((size - 16) / (128 - 16));
  const lerp = (smallValue, largeValue) => mix(smallValue, largeValue, k);
  const half = size >= 128 ? 0.42 : 0.5 - Math.max(1, Math.round(size * 0.04)) * px;
  return {
    half,
    // continuous corner: superellipse exponent 3.2 with 1.5 × the nominal 22.5 % radius
    radius: half * 2 * 0.225 * 1.5,
    corner: 3.2,
    ringR: lerp(0.298, 0.262),
    ringHW: Math.max(lerp(0.052, 0.037), 0.8 * px),
    eyeA: lerp(0.19, 0.172),
    eyeB: lerp(0.116, 0.103),
    eyeHW: Math.max(lerp(0.036, 0.02), 0.55 * px),
    irisR: lerp(0.088, 0.084),
    pupilR: Math.max(lerp(0.034, 0.036), 0.5 * px),
    glintR: 0.0135,
    glintX: 0.027,
    glintY: -0.028,
    shadow: size >= 128,
    glow: size >= 40,
    track: size >= 24,
    detail: size >= 48, // iris gradient + rim, highlight, rim light
  };
}

function appIconShader(size) {
  const g = appIconGeometry(size);
  const almond = makeAlmond(g.eyeA, g.eyeB);
  const glowSigma = 0.036;

  return (x, y, ps, pen) => {
    const body = sdSquircleBox(x, y, g.half, g.radius, g.corner);

    // soft drop shadow in the transparent margin (large sizes only)
    if (g.shadow && body > -2 * ps) {
      const sd = sdSquircleBox(x, y - 0.011, g.half - 0.006, g.radius, g.corner);
      const shadow = 0.34 * Math.exp(-Math.pow(Math.max(sd, 0) / 0.02, 2));
      pen.over(COLORS.black, shadow * (1 - cover(body, ps)));
    }

    const bodyCov = cover(body, ps);
    if (bodyCov <= 0) return;
    const centre = Math.hypot(x, y);

    // background: deep navy → indigo, diagonal
    const diag = clamp01(((x + y) / (2 * g.half)) * 0.5 + 0.5);
    let bg = mixColor(COLORS.bgTop, COLORS.bgBottom, smoothstep(0, 1, diag));
    // subtle cool top light
    const topLight = Math.pow(clamp01(1 - Math.hypot(x / 0.7, (y + g.half) / 0.55)), 2) * 0.22;
    bg = mixColor(bg, COLORS.topLight, topLight);
    // faint teal ambience inside the ring
    bg = mixColor(bg, COLORS.teal, 0.07 * Math.pow(clamp01(1 - centre / (g.ringR + 0.04)), 1.5));
    pen.over(bg, bodyCov);

    // glassy rim light along the upper edge
    if (g.detail) {
      const rimWidth = Math.max(0.005, 1.2 * ps);
      const rimBand = clamp01(1 - Math.abs(body + rimWidth) / rimWidth) * clamp01(-y / g.half + 0.2);
      pen.light(COLORS.white, 0.2 * rimBand * bodyCov);
    }

    // ring track (visible in the gap)
    if (g.track) {
      const track = Math.abs(centre - g.ringR) - g.ringHW;
      pen.over(COLORS.white, 0.08 * cover(track, ps) * bodyCov);
    }

    // progress arc with glow
    const [arcD, arcT] = sdArc(x, y, g.ringR, g.ringHW, SWEEP);
    let arcColor = mixColor(COLORS.teal, COLORS.cyan, smoothstep(0, 1, arcT));
    arcColor = mixColor(arcColor, COLORS.cyanLight, 0.3 * smoothstep(0.85, 1, arcT));
    if (g.glow && arcD > 0) {
      const glow = Math.exp(-Math.pow(arcD / glowSigma, 2));
      pen.light(arcColor, 0.42 * glow * bodyCov);
    }
    pen.over(arcColor, cover(arcD, ps) * bodyCov);

    // eye
    const eyeD = almond(x, y);
    if (eyeD < g.eyeHW + 2 * ps) {
      // sclera tint
      pen.over(COLORS.white, 0.06 * cover(eyeD, ps) * bodyCov);

      // iris (clipped by the lids)
      const inside = cover(Math.max(centre - g.irisR, eyeD), ps);
      if (inside > 0) {
        let iris = COLORS.irisMid;
        if (g.detail) {
          const s = clamp01(centre / g.irisR);
          iris = gradient([[0, COLORS.irisInner], [0.5, COLORS.irisMid], [1, COLORS.irisOuter]], s);
          iris = mixColor(iris, COLORS.irisRim, 0.5 * smoothstep(0.84, 1, s));
        }
        pen.over(iris, inside * bodyCov);
        pen.over(COLORS.pupil, cover(centre - g.pupilR, ps) * bodyCov);
        if (g.detail) {
          const glint = Math.hypot(x - g.glintX, y - g.glintY) - g.glintR;
          pen.over(COLORS.white, 0.95 * cover(glint, ps) * bodyCov);
        }
      }

      // lid outline (top brighter)
      const outline = Math.abs(eyeD) - g.eyeHW;
      const lid = mixColor(COLORS.eyeTop, COLORS.eyeBottom, clamp01((y + g.eyeB) / (2 * g.eyeB)));
      pen.over(lid, cover(outline, ps) * bodyCov);
    }
  };
}

/**
 * Tray glyph (transparent background): progress ring + eye.
 * variant: 'light' (light glyph for dark bars), 'dark' (dark glyph for light bars), 'template' (black + alpha)
 * Geometry is defined in 16-unit "points" and scaled to the pixel size.
 */
/** Tray glyph geometry in pixels from the centre; other sizes scale the 32 px design. */
const TRAY_HINTED = {
  16: { ringOuter: 7, ringInner: 5, eyeA: 3.9, eyeB: 2.6, eyeHW: 0.5, irisR: 1.05, pupilR: 0 },
  20: { ringOuter: 9, ringInner: 7, eyeA: 5, eyeB: 3, eyeHW: 0.7, irisR: 2.15, pupilR: 0.75 },
  24: { ringOuter: 11, ringInner: 9, eyeA: 6.05, eyeB: 3.65, eyeHW: 0.85, irisR: 2.6, pupilR: 0.95 },
  32: { ringOuter: 15, ringInner: 12, eyeA: 8.2, eyeB: 4.9, eyeHW: 1.05, irisR: 3.45, pupilR: 1.35 },
};

function trayGeometry(size) {
  const base = TRAY_HINTED[size];
  const g = base || Object.fromEntries(Object.entries(TRAY_HINTED[32]).map(([k, v]) => [k, (v * size) / 32]));
  const u = (value) => value / size;
  return {
    ringR: u((g.ringOuter + g.ringInner) / 2),
    ringHW: u((g.ringOuter - g.ringInner) / 2),
    eyeA: u(g.eyeA),
    eyeB: u(g.eyeB),
    eyeHW: u(g.eyeHW),
    irisR: u(g.irisR),
    pupilR: u(g.pupilR),
  };
}

function trayShader(size, variant) {
  const { ringR, ringHW, eyeA, eyeB, eyeHW, irisR, pupilR } = trayGeometry(size);
  const almond = makeAlmond(eyeA, eyeB);

  let ringA;
  let ringB;
  let eyeColor;
  if (variant === 'template') {
    ringA = COLORS.black;
    ringB = COLORS.black;
    eyeColor = COLORS.black;
  } else if (variant === 'dark') {
    ringA = COLORS.trayDarkRingA;
    ringB = COLORS.trayDarkRingB;
    eyeColor = COLORS.trayDarkEye;
  } else {
    ringA = COLORS.teal;
    ringB = COLORS.cyan;
    eyeColor = COLORS.eye;
  }

  return (x, y, ps, pen) => {
    const [arcD, arcT] = sdArc(x, y, ringR, ringHW, SWEEP);
    pen.over(mixColor(ringA, ringB, arcT), cover(arcD, ps));

    const eyeD = almond(x, y);
    const centre = Math.hypot(x, y);
    // iris (filled, clipped by lids) with the pupil punched out
    let irisCov = cover(Math.max(centre - irisR, eyeD), ps);
    if (pupilR > 0) irisCov *= 1 - cover(centre - pupilR, ps);
    pen.over(eyeColor, irisCov);
    pen.over(eyeColor, cover(Math.abs(eyeD) - eyeHW, ps));
  };
}

// =====================================================================================================
// Build
// =====================================================================================================

function renderAppIcon(size) {
  return toRGBA8(render(size, appIconShader(size)));
}

function renderTray(size, variant) {
  return toRGBA8(render(size, trayShader(size, variant)));
}

function build(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, buffer) => {
    const file = path.join(outDir, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    written.push(`${name} (${buffer.length} B)`);
  };
  const png = (size, rgba) => encodePNG(size, size, rgba);

  write('icon.png', png(1024, renderAppIcon(1024)));
  for (const size of [512, 256, 64]) write(`icon-${size}.png`, png(size, renderAppIcon(size)));

  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 256];
  write('icon.ico', encodeICO(icoSizes.map((size) => ({ size, rgba: renderAppIcon(size) }))));

  write('tray.png', png(32, renderTray(32, 'light')));
  write('tray@2x.png', png(64, renderTray(64, 'light')));
  write('tray-dark.png', png(32, renderTray(32, 'dark')));
  write('tray-dark@2x.png', png(64, renderTray(64, 'dark')));
  // Windows picks the exact size for the current DPI from an ICO (16 px at 100 %, 20 at 125 %, 24 at 150 % …)
  const trayIcoSizes = [16, 20, 24, 32, 40, 48, 64];
  write('tray.ico', encodeICO(trayIcoSizes.map((size) => ({ size, rgba: renderTray(size, 'light') }))));
  write('tray-dark.ico', encodeICO(trayIcoSizes.map((size) => ({ size, rgba: renderTray(size, 'dark') }))));
  write('trayTemplate.png', png(16, renderTray(16, 'template')));
  write('trayTemplate@2x.png', png(32, renderTray(32, 'template')));
  return written;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 && args[outIndex + 1]
    ? path.resolve(args[outIndex + 1])
    : path.join(__dirname, '..', 'assets', 'icons');
  const started = Date.now();
  const written = build(outDir);
  console.log(`AugenPause icons → ${outDir}`);
  for (const line of written) console.log(`  ${line}`);
  console.log(`done in ${Date.now() - started} ms`);
}

if (require.main === module) main();

module.exports = { encodePNG, encodeICO, renderAppIcon, renderTray, appIconGeometry, build };
