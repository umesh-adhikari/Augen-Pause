// Section scaffolding shared by all views.
import { h } from '../lib/dom.js';
import { icon } from '../icons.js';

/** Large page header: title, subtitle and optional trailing actions. */
export function sectionHeader(title, subtitle, ...actions) {
  const sub = h('p', { class: 'page-subtitle' }, subtitle);
  const el = h('header', { class: 'page-header' },
    h('div', { class: 'page-heading' }, h('h1', { class: 'page-title' }, title), sub),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
  return { el, sub };
}

/** Card with an icon tile, title and description. */
export function groupCard({ id, iconName, title, description, tone, className }, ...children) {
  return h('section', { class: ['card', 'group-card', className], id, dataset: { tone } },
    h('header', { class: 'group-head' },
      h('span', { class: 'icon-tile' }, icon(iconName, { size: 18 })),
      h('div', { class: 'group-heading' },
        h('h2', { class: 'group-title' }, title),
        description ? h('p', { class: 'group-desc' }, description) : null)),
    h('div', { class: 'group-body' }, children));
}
