// Subtle bottom-centre toast ("Gespeichert ✓"). One toast at a time; repeated calls just refresh it.
import { h, setText } from '../lib/dom.js';
import { icon } from '../icons.js';

export function createToast() {
  const iconSlot = h('span', { class: 'toast-icon' });
  const text = h('span', { class: 'toast-text' });
  const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, iconSlot, text);
  let hideTimer = null;
  let kind = '';

  function show(message, opts = {}) {
    const nextKind = opts.kind || 'success';
    if (nextKind !== kind || !iconSlot.firstChild) {
      kind = nextKind;
      iconSlot.replaceChildren(icon(opts.icon || (kind === 'error' ? 'alert' : 'check'), { size: 15 }));
      el.dataset.kind = kind;
    }
    setText(text, message);
    el.classList.add('is-visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('is-visible'), opts.duration || (kind === 'error' ? 4200 : 1600));
  }

  return { el, show };
}
