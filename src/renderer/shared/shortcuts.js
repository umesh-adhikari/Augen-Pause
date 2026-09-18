// Global shortcut table for display in renderers.
// Must stay identical to SHORTCUTS in src/main/shortcuts.js (docs/ARCHITECTURE.md §10).

const KEYS = {
  win32: { snooze: ['Ctrl', 'Alt', 'F9'], pauseToggle: ['Ctrl', 'Alt', 'F10'], dashboard: ['Ctrl', 'Alt', 'F11'] },
  darwin: { snooze: ['⌃', '⌥', '⌘', 'S'], pauseToggle: ['⌃', '⌥', '⌘', 'P'], dashboard: ['⌃', '⌥', '⌘', 'D'] },
  linux: { snooze: ['Ctrl', 'Shift', 'Alt', 'S'], pauseToggle: ['Ctrl', 'Shift', 'Alt', 'P'], dashboard: ['Ctrl', 'Shift', 'Alt', 'D'] },
};

const LABELS = {
  de: { snooze: 'Pause verschieben', pauseToggle: 'Pausieren / Fortsetzen', dashboard: 'Dashboard ein-/ausblenden' },
  en: { snooze: 'Snooze break', pauseToggle: 'Pause / resume', dashboard: 'Show / hide dashboard' },
};

const DE_KEYS = { Ctrl: 'Strg', Shift: 'Umschalt' };

/** @returns {{ action: string, label: string, keys: string[], text: string }[]} */
export function getShortcutRows(platform, lang = 'de') {
  const table = KEYS[platform] || KEYS.linux;
  const labels = LABELS[lang] || LABELS.en;
  return Object.keys(table).map((action) => {
    const keys = table[action].map((k) => (lang === 'de' && DE_KEYS[k]) || k);
    const text = platform === 'darwin' ? keys.join('') : keys.join('+');
    return { action, label: labels[action], keys, text };
  });
}
