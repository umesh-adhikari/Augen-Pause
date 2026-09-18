// Setting controls. Every control object has the shape
//   { el, paths: string[], sync(settings), setError(message|null), busy(): boolean, pending(): [path, value][] }
// `env` = { commit(control, patch) → Promise, draft(path, value) → void, t }
import { h, setText, setAttr, setStyleVar, toggleClass, debounce, nextId, getPath, patchFor } from '../lib/dom.js';
import { icon } from '../icons.js';

const SLIDER_DEBOUNCE_MS = 200;

function baseControl(paths) {
  return { paths, inflight: 0, busy() { return this.inflight > 0; }, pending() { return []; } };
}

function rowShell({ label, help, control, forId, variant, extra, iconName, className }) {
  const errorEl = h('p', { class: 'set-error', role: 'alert', hidden: true });
  const noteEl = h('p', { class: 'set-note', id: nextId('note'), hidden: true });
  const labelEl = forId
    ? h('label', { class: 'set-label', htmlFor: forId }, label)
    : h('span', { class: 'set-label' }, label);
  const el = h('div', { class: ['set-row', variant && `set-row--${variant}`, className] },
    iconName ? h('span', { class: 'set-icon' }, icon(iconName, { size: 16 })) : null,
    h('div', { class: 'set-text' }, labelEl, help ? h('p', { class: 'set-help' }, help) : null, noteEl, errorEl),
    control ? h('div', { class: 'set-control' }, control) : null,
    extra || null);
  return {
    el,
    labelEl,
    noteEl,
    setError(msg) {
      errorEl.hidden = !msg;
      setText(errorEl, msg || '');
      toggleClass(el, 'has-error', Boolean(msg));
    },
    /** Contextual hint below the help text (e.g. a constraint that currently applies). */
    setNote(msg) {
      if (noteEl.hidden !== !msg) noteEl.hidden = !msg;
      setText(noteEl, msg || '');
    },
    /** Dims the whole row while its control is not changeable. */
    setRowDisabled(disabled) {
      toggleClass(el, 'is-disabled', Boolean(disabled));
    },
  };
}

/** Toggle switch row. */
export function switchRow(env, { path, label, help, iconName }) {
  const id = nextId('sw');
  const ctrl = baseControl([path]);
  const input = h('input', {
    type: 'checkbox',
    id,
    role: 'switch',
    onChange: () => {
      env.draft(path, input.checked);
      env.commit(ctrl, patchFor(path, input.checked));
    },
  });
  const shell = rowShell({ label, help, forId: id, iconName, control: h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' })) });
  return Object.assign(ctrl, {
    el: shell.el,
    input,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      const v = Boolean(getPath(s, path));
      if (input.checked !== v) input.checked = v;
    },
    pending() { return ctrl.busy() ? [[path, input.checked]] : []; },
    /** e.g. „Pflicht-Pause“ cannot be toggled while a break is running. */
    setDisabled(disabled) {
      input.disabled = Boolean(disabled);
      shell.setRowDisabled(disabled);
    },
    setNote(msg) {
      shell.setNote(msg);
      setAttr(input, 'aria-describedby', msg ? shell.noteEl.id : null);
    },
  });
}

function nearestIndex(stops, value) {
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i] - value) < Math.abs(stops[best] - value)) best = i;
  }
  return best;
}

/**
 * Slider row. Either linear (min/max/step, optional toSetting/fromSetting scale) or
 * non-linear via `stops` (array of setting values; the slider moves over the indices).
 * `preview` puts an extra (decorative) node left of the slider, `onValue` reports every
 * rendered setting value so such a preview can follow the drag live.
 */
export function sliderRow(env, opts) {
  const { path, label, help, format, iconName, preview, onValue } = opts;
  const stops = opts.stops || null;
  const toSetting = opts.toSetting || ((v) => v);
  const fromSetting = opts.fromSetting || ((v) => v);
  const id = nextId('sl');
  const ctrl = baseControl([path]);
  let dragging = false;
  let localValue = null; // setting value currently shown

  const min = stops ? 0 : opts.min;
  const max = stops ? stops.length - 1 : opts.max;
  const input = h('input', { type: 'range', class: 'slider', id, min, max, step: stops ? 1 : (opts.step || 1) });
  const output = h('output', { class: 'set-value tabular', htmlFor: id });

  const send = debounce(() => {
    env.commit(ctrl, patchFor(path, localValue));
  }, SLIDER_DEBOUNCE_MS);

  const toSlider = (settingValue) => (stops ? nearestIndex(stops, settingValue) : fromSetting(settingValue));
  const fromSlider = (sliderValue) => (stops ? stops[sliderValue] : toSetting(sliderValue));

  function render(settingValue, sliderValue) {
    const sv = sliderValue ?? toSlider(settingValue);
    if (Number(input.value) !== sv) input.value = String(sv);
    const pct = max === min ? 0 : ((Number(input.value) - min) / (max - min)) * 100;
    setStyleVar(input, '--fill', `${pct.toFixed(2)}%`);
    setText(output, format(settingValue));
    setAttr(input, 'aria-valuetext', format(settingValue));
    if (onValue) onValue(settingValue);
  }

  input.addEventListener('input', () => {
    const raw = Math.max(min, Number(input.value));
    localValue = fromSlider(raw);
    render(localValue, raw);
    env.draft(path, localValue);
    send();
  });
  input.addEventListener('pointerdown', () => { dragging = true; });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
  };
  input.addEventListener('pointerup', endDrag);
  input.addEventListener('pointercancel', endDrag);
  input.addEventListener('change', endDrag);
  input.addEventListener('blur', endDrag);

  const sliderWrap = h('div', { class: 'slider-wrap' }, input, output);
  const control = preview ? h('div', { class: 'slider-preview-wrap' }, preview, sliderWrap) : sliderWrap;
  const shell = rowShell({ label, help, forId: id, control, variant: 'slider', className: preview ? 'set-row--with-preview' : null, iconName });

  ctrl.busy = () => dragging || send.pending() || ctrl.inflight > 0;
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      localValue = getPath(s, path);
      render(localValue);
    },
    pending() { return ctrl.busy() && localValue != null ? [[path, localValue]] : []; },
    setDisabled(disabled) {
      input.disabled = Boolean(disabled);
      shell.setRowDisabled(disabled);
    },
    setNote(msg) {
      shell.setNote(msg);
      setAttr(input, 'aria-describedby', msg ? shell.noteEl.id : null);
    },
  });
}

/** − value + stepper for small integer ranges. */
export function stepperRow(env, { path, label, help, min, max, format, iconName, unitLabel }) {
  const ctrl = baseControl([path]);
  let localValue = min;
  const valueEl = h('span', { class: 'stepper-value tabular', 'aria-live': 'polite' });
  const send = debounce(() => env.commit(ctrl, patchFor(path, localValue)), 350);

  function change(delta) {
    const next = Math.min(max, Math.max(min, localValue + delta));
    if (next === localValue) return;
    localValue = next;
    render();
    env.draft(path, localValue);
    send();
  }
  const dec = h('button', { type: 'button', class: 'stepper-btn', onClick: () => change(-1) }, icon('minus', { size: 14 }));
  const inc = h('button', { type: 'button', class: 'stepper-btn', onClick: () => change(1) }, icon('plus', { size: 14 }));
  const group = h('div', {
    class: 'stepper',
    role: 'spinbutton',
    tabIndex: 0,
    'aria-valuemin': min,
    'aria-valuemax': max,
    onKeydown: (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); change(1); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); change(-1); }
    },
  }, dec, valueEl, inc);

  function render() {
    setText(valueEl, format ? format(localValue) : String(localValue));
    setAttr(group, 'aria-valuenow', localValue);
    dec.disabled = localValue <= min;
    inc.disabled = localValue >= max;
  }

  const shell = rowShell({ label, help, control: group, iconName });
  group.setAttribute('aria-label', label);
  dec.setAttribute('aria-label', `${label} −`);
  inc.setAttribute('aria-label', `${label} +`);
  if (unitLabel) group.insertBefore(h('span', { class: 'stepper-unit' }, unitLabel), inc);
  ctrl.busy = () => send.pending() || ctrl.inflight > 0;
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      localValue = Number(getPath(s, path)) || min;
      render();
    },
    pending() { return ctrl.busy() ? [[path, localValue]] : []; },
  });
}

/** Keyboard support for radio-like button groups (arrow keys move + select). */
function radioKeys(container, buttons, select) {
  container.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    const idx = buttons.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = buttons[(idx + keys[e.key] + buttons.length) % buttons.length];
    next.focus();
    select(next);
  });
}

/** Segmented control row (single choice). options: [{ value, label, icon? }] */
export function segmentedRow(env, { path, label, help, options, iconName, variant }) {
  const ctrl = baseControl([path]);
  let current = null;
  const buttons = options.map((opt) => h('button', {
    type: 'button',
    role: 'radio',
    dataset: { value: opt.value },
    onClick: () => choose(opt.value),
  }, opt.icon ? icon(opt.icon, { size: 15 }) : null, h('span', null, opt.label)));
  const group = h('div', { class: ['segmented', 'segmented-lg'], role: 'radiogroup', 'aria-label': label }, buttons);
  radioKeys(group, buttons, (btn) => choose(btn.dataset.value));

  function render() {
    for (const b of buttons) {
      const on = b.dataset.value === String(current);
      setAttr(b, 'aria-pressed', on ? 'true' : 'false');
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
  function choose(value) {
    if (value === current) return;
    current = value;
    render();
    env.draft(path, value);
    env.commit(ctrl, patchFor(path, value));
  }
  const shell = rowShell({ label, help, control: group, iconName, variant });
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      current = String(getPath(s, path));
      render();
    },
    pending() { return ctrl.busy() ? [[path, current]] : []; },
  });
}

/** Accent colour swatches. options: [{ value, label }] */
export function swatchRow(env, { path, label, help, options, iconName }) {
  const ctrl = baseControl([path]);
  let current = null;
  const buttons = options.map((opt) => h('button', {
    type: 'button',
    class: 'swatch',
    role: 'radio',
    title: opt.label,
    'aria-label': opt.label,
    dataset: { swatch: opt.value },
    onClick: () => choose(opt.value),
  }, h('span', { class: 'swatch-dot' }, icon('check', { size: 14, class: 'swatch-check' }))));
  const group = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label }, buttons);
  radioKeys(group, buttons, (btn) => choose(btn.dataset.swatch));

  function render() {
    for (const b of buttons) {
      const on = b.dataset.swatch === current;
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
  function choose(value) {
    if (value === current) return;
    current = value;
    render();
    env.draft(path, value);
    env.commit(ctrl, patchFor(path, value));
  }
  const shell = rowShell({ label, help, control: group, iconName });
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      current = String(getPath(s, path));
      render();
    },
    pending() { return ctrl.busy() ? [[path, current]] : []; },
  });
}

/** Weekday chips (Mon-first display, values 0 = Sunday). */
export function daysRow(env, { path, label, help, dayLabel, dayName, order, emptyError, iconName }) {
  const ctrl = baseControl([path]);
  let current = new Set();
  const buttons = order.map((d) => h('button', {
    type: 'button',
    class: 'day-chip',
    title: dayName(d),
    'aria-label': dayName(d),
    dataset: { day: d },
    onClick: () => toggle(d),
  }, dayLabel(d)));
  const group = h('div', { class: 'day-chips', role: 'group', 'aria-label': label }, buttons);
  const shell = rowShell({ label, help, control: group, iconName, variant: 'wide' });

  function render() {
    for (const b of buttons) setAttr(b, 'aria-pressed', current.has(Number(b.dataset.day)) ? 'true' : 'false');
  }
  function toggle(d) {
    const next = new Set(current);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    if (next.size === 0) {
      shell.setError(emptyError);
      const btn = buttons[order.indexOf(d)];
      btn.classList.remove('shake');
      void btn.offsetWidth;
      btn.classList.add('shake');
      return;
    }
    shell.setError(null);
    current = next;
    render();
    const days = [...current].sort((a, b) => a - b);
    env.draft(path, days);
    env.commit(ctrl, patchFor(path, days));
  }
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      current = new Set(getPath(s, path) || []);
      render();
    },
    pending() { return ctrl.busy() ? [[path, [...current].sort((a, b) => a - b)]] : []; },
  });
}

/** Start/end <input type="time"> pair with local validation (end > start). */
export function timeRangeRow(env, { startPath, endPath, label, help, startLabel, endLabel, orderError, iconName }) {
  const ctrl = baseControl([startPath, endPath]);
  const startId = nextId('tm');
  const endId = nextId('tm');
  const start = h('input', { type: 'time', class: 'input time-input', id: startId, step: 60, 'aria-label': startLabel });
  const end = h('input', { type: 'time', class: 'input time-input', id: endId, step: 60, 'aria-label': endLabel });
  let editing = false;

  function validateAndSend() {
    const a = start.value;
    const b = end.value;
    if (!a || !b) return;
    if (!(b > a)) {
      shell.setError(orderError);
      toggleClass(end, 'is-invalid', true);
      return;
    }
    toggleClass(end, 'is-invalid', false);
    shell.setError(null);
    env.draft(startPath, a);
    env.draft(endPath, b);
    const patch = patchFor(startPath, a);
    Object.assign(patch[startPath.split('.')[0]], { [endPath.split('.')[1]]: b });
    env.commit(ctrl, patch);
  }
  for (const input of [start, end]) {
    input.addEventListener('focus', () => { editing = true; });
    input.addEventListener('blur', () => { editing = false; });
    input.addEventListener('change', validateAndSend);
  }
  const control = h('div', { class: 'time-range' },
    start, h('span', { class: 'time-sep', 'aria-hidden': 'true' }, '–'), end);
  const shell = rowShell({ label, help, control, iconName });
  ctrl.busy = () => editing || ctrl.inflight > 0;
  return Object.assign(ctrl, {
    el: shell.el,
    setError: shell.setError,
    sync(s) {
      if (ctrl.busy()) return;
      const a = getPath(s, startPath);
      const b = getPath(s, endPath);
      if (start.value !== a) start.value = a;
      if (end.value !== b) end.value = b;
      toggleClass(end, 'is-invalid', false);
    },
  });
}

/** Plain row with a button (actions that are not settings). */
export function buttonRow({ label, help, buttonLabel, iconName, buttonIcon, onClick }) {
  const btn = h('button', { type: 'button', class: 'btn btn-sm-md', onClick }, buttonIcon ? icon(buttonIcon, { size: 15 }) : null, buttonLabel);
  const shell = rowShell({ label, help, control: btn, iconName });
  return {
    el: shell.el,
    button: btn,
    paths: [],
    sync() {},
    setError: shell.setError,
    busy: () => false,
    pending: () => [],
    /** e.g. „Jetzt prüfen“ is refused while a Pflicht-Pause runs. */
    setDisabled(disabled) {
      btn.disabled = Boolean(disabled);
      shell.setRowDisabled(disabled);
    },
    setNote(msg) {
      shell.setNote(msg);
      setAttr(btn, 'aria-describedby', msg ? shell.noteEl.id : null);
    },
  };
}

/** Free-form row (custom right side content). */
export function customRow({ label, help, content, iconName, variant }) {
  const shell = rowShell({ label, help, control: content, iconName, variant });
  return { el: shell.el, paths: [], sync() {}, setError: shell.setError, busy: () => false, pending: () => [] };
}

/**
 * Collapsible group of rows that is only shown while `when(settings)` is true.
 * Returns a pseudo control so the settings view can sync it like the others.
 */
export function collapsible(when, rows) {
  const inner = h('div', { class: 'collapse-inner' }, rows.map((r) => r.el));
  const el = h('div', { class: 'collapse' }, inner);
  let open = null;
  return {
    el,
    paths: [],
    busy: () => false,
    pending: () => [],
    setError() {},
    sync(s, draftSettings) {
      const next = Boolean(when(draftSettings || s));
      if (next === open) return;
      open = next;
      toggleClass(el, 'is-collapsed', !open);
      if (open) inner.removeAttribute('inert');
      else inner.setAttribute('inert', '');
    },
  };
}
