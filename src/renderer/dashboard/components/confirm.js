// Inline confirmation: a button that morphs into "Really? [Cancel] [Confirm]" instead of a modal dialog.
import { h } from '../lib/dom.js';
import { icon } from '../icons.js';

/**
 * @param {{ label: string, question: string, confirmLabel: string, cancelLabel: string, icon?: string,
 *           onConfirm: () => Promise<void>|void }} opts
 */
export function inlineConfirm(opts) {
  let timer = null;
  const root = h('div', { class: 'confirm' });

  const trigger = h('button', { type: 'button', class: 'btn btn-danger', onClick: () => ask() },
    icon(opts.icon || 'trash', { size: 16 }), opts.label);

  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => reset(true) }, opts.cancelLabel);
  const confirmBtn = h('button', {
    type: 'button',
    class: 'btn btn-danger-solid btn-sm',
    onClick: async () => {
      confirmBtn.disabled = true;
      try {
        await opts.onConfirm();
      } finally {
        confirmBtn.disabled = false;
        reset(false);
      }
    },
  }, opts.confirmLabel);
  const box = h('div', { class: 'confirm-box', role: 'group', hidden: true },
    h('span', { class: 'confirm-question' }, icon('alert', { size: 15 }), opts.question), cancelBtn, confirmBtn);

  root.append(trigger, box);

  function ask() {
    trigger.hidden = true;
    box.hidden = false;
    root.classList.add('is-asking');
    cancelBtn.focus();
    clearTimeout(timer);
    timer = setTimeout(() => reset(false), 8000);
  }

  function reset(focus) {
    clearTimeout(timer);
    box.hidden = true;
    trigger.hidden = false;
    root.classList.remove('is-asking');
    if (focus) trigger.focus();
  }

  return root;
}
