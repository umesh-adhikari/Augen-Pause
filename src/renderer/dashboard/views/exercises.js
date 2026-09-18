// Übungen: animated exercise cards + "start a break now".
import { h } from '../lib/dom.js';
import { icon } from '../icons.js';
import { sectionHeader } from '../components/section.js';
import { illustration, EXERCISE_IDS } from '../components/illustrations.js';

export function createExercisesView(ctx) {
  const { t } = ctx;

  const startBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary btn-lg',
    onClick: () => ctx.runAction('break-now'),
  }, icon('play', { size: 16 }), t('ex_start_break'));

  const banner = h('section', { class: 'card ex-banner' },
    h('span', { class: 'icon-tile icon-tile-lg' }, icon('sparkles', { size: 22 })),
    h('div', { class: 'ex-banner-text' },
      h('h2', { class: 'ex-banner-title' }, t('ex_banner_title')),
      h('p', { class: 'ex-banner-desc' }, t('ex_banner_desc'))),
    startBtn);

  const cards = EXERCISE_IDS.map((id) => h('article', { class: 'card ex-card', dataset: { exercise: id, tone: id === 'water' ? 'water' : null } },
    h('div', { class: 'ex-art' }, illustration(id)),
    h('div', { class: 'ex-body' },
      h('div', { class: 'ex-head' },
        h('h3', { class: 'ex-title' }, t(`ex_${id}_title`)),
        h('span', { class: 'chip ex-duration' }, icon('clock', { size: 12 }), t(`ex_${id}_duration`))),
      h('ol', { class: 'ex-steps' },
        [1, 2, 3].map((n) => h('li', null, h('span', { class: 'ex-step-num tabular' }, String(n)), h('span', null, t(`ex_${id}_step${n}`))))))))
    .map((card, i) => {
      card.style.setProperty('--stagger', String(i));
      return card;
    });

  const grid = h('section', { class: 'ex-grid', 'aria-label': t('nav_exercises') }, cards);
  const header = sectionHeader(t('ex_title'), t('ex_subtitle'));
  const el = h('div', { class: 'view view-exercises' }, header.el, banner, grid);

  // play animations only for cards that are on screen (and while the section is shown)
  let observer = null;
  function observe() {
    const rootEl = el.closest('.content');
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) entry.target.classList.toggle('is-playing', entry.isIntersecting);
    }, { root: rootEl || null, threshold: 0.15 });
    cards.forEach((c) => observer.observe(c));
  }

  return {
    el,
    onShow() {
      if (!observer) observe();
    },
    onHide() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      cards.forEach((c) => c.classList.remove('is-playing'));
    },
    destroy() {
      if (observer) observer.disconnect();
    },
  };
}
