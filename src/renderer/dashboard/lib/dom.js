// Tiny DOM helpers – CSP friendly (no innerHTML, no inline styles/handlers).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Keys that are assigned as DOM properties (so `false` values are meaningful).
const PROPS = new Set([
  'value', 'checked', 'disabled', 'hidden', 'type', 'min', 'max', 'step', 'tabIndex',
  'htmlFor', 'id', 'title', 'name', 'placeholder', 'selected', 'open',
]);

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === 'class') {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'text') {
      if (v != null) el.textContent = String(v);
    } else if (key === 'dataset') {
      for (const d of Object.keys(v || {})) if (v[d] != null) el.dataset[d] = String(v[d]);
    } else if (key === 'style') {
      for (const p of Object.keys(v || {})) if (v[p] != null) el.style.setProperty(p, String(v[p]));
    } else if (key === 'ref') {
      if (typeof v === 'function') v(el);
    } else if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (!isSvg && PROPS.has(key)) {
      if (v !== undefined) el[key] = v;
    } else if (v != null && v !== false) {
      el.setAttribute(key, v === true ? '' : String(v));
    }
  }
}

/** h('div', { class: 'x', onClick: fn }, 'text', child) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  appendChildren(el, children);
  return el;
}

/** SVG element factory: s('circle', { cx: 5, cy: 5, r: 3 }) */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  appendChildren(el, children);
  return el;
}

/** Only touches the DOM when the text actually changed. */
export function setText(el, text) {
  const value = text == null ? '' : String(text);
  if (el && el.textContent !== value) el.textContent = value;
}

/** Only touches the DOM when the attribute actually changed. */
export function setAttr(el, name, value) {
  if (!el) return;
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const str = value === true ? '' : String(value);
  if (el.getAttribute(name) !== str) el.setAttribute(name, str);
}

export function setStyleVar(el, name, value) {
  if (!el) return;
  const str = String(value);
  if (el.style.getPropertyValue(name) !== str) el.style.setProperty(name, str);
}

export function toggleClass(el, cls, on) {
  if (el && el.classList.contains(cls) !== Boolean(on)) el.classList.toggle(cls, Boolean(on));
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

let uid = 0;
export const nextId = (prefix = 'ap') => `${prefix}-${++uid}`;

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}

/** 'timer.workMinutes', 30 → { timer: { workMinutes: 30 } } */
export function patchFor(path, value) {
  return setPath({}, path, value);
}
