// Lightweight popover menu anchored to a trigger button (keyboard + outside click aware).
import { h } from '../lib/dom.js';
import { icon } from '../icons.js';

let openMenu = null;

export function closeOpenMenu() {
  if (openMenu) openMenu.close();
}

/**
 * @param {HTMLElement} trigger button that toggles the menu
 * @param {() => Array<{ label: string, hint?: string, icon?: string, onSelect: () => void, disabled?: boolean } | 'separator' | { heading: string }>} getItems
 * @param {{ align?: 'start'|'end', className?: string }} [opts]
 */
export function attachMenu(trigger, getItems, opts = {}) {
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  let panel = null;

  function onDocPointer(e) {
    if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) close();
  }
  function onKey(e) {
    if (!panel) return;
    const items = [...panel.querySelectorAll('.menu-item:not(:disabled)')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      trigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  }

  function open(focusFirst) {
    if (openMenu) openMenu.close();
    const entries = getItems();
    panel = h('div', { class: ['menu', opts.className], role: 'menu', 'data-align': opts.align || 'start' },
      entries.map((item) => {
        if (item === 'separator') return h('div', { class: 'menu-sep', role: 'separator' });
        if (item.heading) return h('div', { class: 'menu-heading' }, item.heading);
        return h('button', {
          type: 'button',
          class: 'menu-item',
          role: 'menuitem',
          disabled: Boolean(item.disabled),
          onClick: () => {
            close();
            item.onSelect();
          },
        },
        item.icon ? icon(item.icon, { size: 16 }) : null,
        h('span', { class: 'menu-label' }, item.label),
        item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null);
      }));
    const host = trigger.closest('.menu-host') || trigger.parentElement;
    host.appendChild(panel);
    // position below the trigger, relative to the host
    const hostRect = host.getBoundingClientRect();
    const r = trigger.getBoundingClientRect();
    panel.style.setProperty('top', `${Math.round(r.bottom - hostRect.top + 6)}px`);
    if (opts.align === 'end') panel.style.setProperty('right', `${Math.round(hostRect.right - r.right)}px`);
    else panel.style.setProperty('left', `${Math.round(r.left - hostRect.left)}px`);
    // flip upwards when there is not enough room below
    const pr = panel.getBoundingClientRect();
    if (pr.bottom > window.innerHeight - 12 && r.top - pr.height - 6 > 50) {
      panel.style.setProperty('top', `${Math.round(r.top - hostRect.top - pr.height - 6)}px`);
      panel.classList.add('is-up');
    }
    requestAnimationFrame(() => panel && panel.classList.add('is-open'));
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    openMenu = api;
    if (focusFirst) panel.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (openMenu === api) openMenu = null;
  }

  trigger.addEventListener('click', (e) => {
    if (panel) close();
    else open(e.detail === 0);
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !panel) {
      e.preventDefault();
      open(true);
    }
  });

  const api = { open, close, isOpen: () => Boolean(panel) };
  return api;
}
