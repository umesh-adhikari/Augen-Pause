'use strict';
/**
 * DEV ONLY – renders one view with mock data and writes a PNG screenshot.
 *
 *   npx electron scripts/dev/preview.js --view widget    --scenario work    --out shot.png
 *   npx electron scripts/dev/preview.js --view dashboard --scenario break   --tab settings --theme light --lang en --out d.png
 *   npx electron scripts/dev/preview.js --view overlay   --scenario break-long --width 1600 --height 900 --out o.png
 *
 * Options: --view widget|dashboard|overlay  --scenario work|warning|break|break-grace|break-long|break-strict|paused|away|off-hours|hydration-due|meeting|meeting-active
 *          --theme dark|light  --accent teal|violet|…  --lang de|en  --tab <dashboard tab>  --size small|medium|large
 *          --width N --height N  --delay ms (default 1200)  --out file.png  --show (keep window open, no screenshot)
 *          --opacity 0.2..1 (overlay tint)  --backdrop (overlay: paint a fake desktop behind the transparent page)
 *          --update up-to-date|checking|available-auto|available-manual|downloading|ready|error|legacy
 *          scenarios: break = Pflicht-Pause (strict, default), break-flex / break-grace = Pflicht-Pause off
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const view = arg('view', 'widget');
const scenario = arg('scenario', 'work');
const out = path.resolve(arg('out', `preview-${view}-${scenario}.png`));
const show = arg('show', false) === true;
const delay = Number(arg('delay', 1200));
const size = arg('size', 'medium');
const clock = { small: 120, medium: 160, large: 210 }[size] || 160;

const defaults = {
  widget: { width: Math.max(clock, 176) + 24, height: clock + 24 + 52 },
  dashboard: { width: 1040, height: 720 },
  overlay: { width: 1440, height: 900 },
}[view];
const width = Number(arg('width', defaults.width));
const height = Number(arg('height', defaults.height));

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(RENDERER_ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const mockArgs = JSON.stringify({
    view, scenario, size,
    theme: arg('theme', 'dark'), accent: arg('accent', 'teal'), lang: arg('lang', 'de'), tab: arg('tab', null), opacity: arg('opacity', null), update: arg('update', null),
  });

  const win = new BrowserWindow({
    width, height,
    show,
    frame: view === 'dashboard',
    transparent: view === 'widget' || view === 'overlay',
    backgroundColor: view === 'widget' || view === 'overlay' ? '#00000000' : '#0b1020',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [`--ap-mock=${mockArgs}`],
      autoplayPolicy: 'no-user-gesture-required',
      offscreen: !show,
    },
  });
  win.webContents.on('console-message', (e) => {
    const { level, message, lineNumber, sourceId } = e;
    console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('LOAD FAILED', code, desc, url));

  const primary = view === 'overlay' ? '?primary=1' : '';
  await win.loadURL(`app://augenpause/${view}/index.html${primary}`);
  if (arg('backdrop', false) === true) {
    // fake desktop (light editor window, dark terminal, wallpaper) painted UNDER the page's own background layers
    await win.webContents.insertCSS(`html { background:
      linear-gradient(#e5e7eb, #e5e7eb) 6% 9% / 46% 5% no-repeat,
      repeating-linear-gradient(#ffffff 0 18px, #f1f5f9 18px 36px) 6% 14% / 46% 62% no-repeat,
      linear-gradient(#111827, #111827) 58% 22% / 36% 50% no-repeat,
      linear-gradient(135deg, #1d4ed8, #0f766e 60%, #f59e0b) !important; }`);
  }
  if (show) return;
  await new Promise((r) => setTimeout(r, delay));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('screenshot written:', out);
  app.exit(0);
});
