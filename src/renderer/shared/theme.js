// Applies theme / accent / language from settings to <html>.
import { resolveLang } from './i18n.js';

const ACCENTS = new Set(['teal', 'violet', 'blue', 'green', 'orange', 'pink']);
const media = window.matchMedia('(prefers-color-scheme: dark)');
let currentThemeSetting = 'system';
let listening = false;

function effectiveTheme(setting) {
  if (setting === 'dark' || setting === 'light') return setting;
  return media.matches ? 'dark' : 'light';
}

function onSystemSchemeChange() {
  if (currentThemeSetting === 'system') {
    document.documentElement.dataset.theme = effectiveTheme('system');
  }
}

/**
 * @param {object} settings full Settings object (see docs/ARCHITECTURE.md §2)
 * @param {{ forceTheme?: 'dark'|'light' }} [opts]
 * @returns {{ theme: 'dark'|'light', lang: 'de'|'en' }}
 */
export function applyAppearance(settings, opts = {}) {
  const appearance = (settings && settings.appearance) || {};
  currentThemeSetting = appearance.theme || 'system';
  const theme = opts.forceTheme || effectiveTheme(currentThemeSetting);
  const accent = ACCENTS.has(appearance.accent) ? appearance.accent : 'teal';
  const lang = resolveLang(settings && settings.language);

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
  root.lang = lang;

  if (!listening && !opts.forceTheme) {
    media.addEventListener('change', onSystemSchemeChange);
    listening = true;
  }
  return { theme, lang };
}
