// Global shortcut list (display only – registration lives in the main process).
// Keys and labels come from the shared table (docs/ARCHITECTURE.md §10), so they always match main.
import { h } from '../lib/dom.js';
import { icon } from '../icons.js';
import { getShortcutRows } from '../../shared/shortcuts.js';

const ICONS = { snooze: 'snooze', pauseToggle: 'pause', dashboard: 'overview' };

/** Keys rendered as <kbd> chips; "+" separators on win/linux, none on macOS (⌃⌥⌘S). */
export function keyCombo(ctx, row) {
  const sep = ctx.platform === 'darwin' ? null : '+';
  const parts = [];
  row.keys.forEach((k, i) => {
    if (i > 0 && sep) parts.push(h('span', { class: 'kbd-plus', 'aria-hidden': 'true' }, sep));
    parts.push(h('kbd', { class: 'kbd' }, k));
  });
  return h('span', { class: 'kbd-combo', 'aria-label': row.text }, parts);
}

export function shortcutList(ctx, { disabled = false } = {}) {
  return h('ul', { class: ['shortcut-list', disabled && 'is-disabled'] },
    getShortcutRows(ctx.platform, ctx.lang).map((row) => h('li', { class: 'shortcut', dataset: { action: row.action } },
      h('span', { class: 'shortcut-icon' }, icon(ICONS[row.action] || 'keyboard', { size: 15 })),
      h('span', { class: 'shortcut-label' }, row.label),
      keyCombo(ctx, row))));
}
