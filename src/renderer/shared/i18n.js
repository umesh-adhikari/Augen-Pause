// Tiny i18n helpers for renderers. Each view keeps its own `strings.js`:
//   export default { de: { key: 'Text {name}' }, en: { key: 'Text {name}' } }

/** @returns {'de'|'en'} */
export function resolveLang(setting) {
  if (setting === 'de' || setting === 'en') return setting;
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

/**
 * @param {{de: Record<string,string>, en: Record<string,string>}} dict
 * @param {'de'|'en'} lang
 * @returns {(key: string, vars?: Record<string, string|number>) => string}
 */
export function createT(dict, lang) {
  const primary = dict[lang] || {};
  const fallback = dict.en || {};
  return function t(key, vars) {
    let text = primary[key] ?? fallback[key] ?? key;
    if (vars) {
      text = text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
    }
    return text;
  };
}
