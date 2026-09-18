// Sidebar: brand, navigation and a live mini status at the bottom.
import { h, setText, setAttr, setStyleVar } from '../lib/dom.js';
import { icon, logoMark } from '../icons.js';
import { toneOf, phaseLabelKey, countdownOf, nextWorkStart } from '../lib/phase.js';
import { formatClock, formatTimeOfDay } from '../../shared/format.js';

export const TABS = ['overview', 'settings', 'stats', 'exercises', 'about'];
const TAB_ICONS = { overview: 'overview', settings: 'settings', stats: 'stats', exercises: 'exercises', about: 'about' };

export function createSidebar(ctx) {
  const { t } = ctx;
  const mod = ctx.platform === 'darwin' ? '⌘' : (ctx.lang === 'de' ? 'Strg+' : 'Ctrl+');

  const buttons = new Map();
  const nav = h('nav', { class: 'nav', 'aria-label': t('nav_label') },
    TABS.map((tab, i) => {
      const btn = h('button', {
        type: 'button',
        class: 'nav-item',
        dataset: { tab },
        title: `${t(`nav_${tab}`)}  ${mod}${i + 1}`,
        onClick: () => ctx.navigate(tab),
      },
      h('span', { class: 'nav-icon' }, icon(TAB_ICONS[tab], { size: 18 })),
      h('span', { class: 'nav-label' }, t(`nav_${tab}`)));
      buttons.set(tab, btn);
      return btn;
    }));

  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = [...buttons.values()];
    const idx = list.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = list[(idx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    next.focus();
    ctx.navigate(next.dataset.tab);
  });

  // ---- mini status --------------------------------------------------------
  const dot = h('span', { class: 'status-dot' });
  const phaseText = h('span', { class: 'mini-phase' });
  const time = h('span', { class: 'mini-time tabular' });
  const sub = h('span', { class: 'mini-sub' });
  const bar = h('span', { class: 'mini-bar-fill' });
  const meetingChip = h('span', { class: 'mini-meeting', hidden: true, title: t('meeting_active_chip'), 'aria-label': t('meeting_active_chip') },
    icon('video', { size: 12 }));
  const mini = h('button', {
    type: 'button',
    class: 'mini-status',
    onClick: () => ctx.navigate('overview'),
    'aria-label': t('nav_overview'),
  },
  h('span', { class: 'mini-head' }, dot, phaseText, meetingChip),
  h('span', { class: 'mini-body' }, time, sub),
  h('span', { class: 'mini-bar' }, bar));

  const el = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, logoMark(26, 'side'), h('span', { class: 'brand-name' }, t('app_name'))),
    nav,
    h('div', { class: 'sidebar-spacer' }),
    mini);

  function setActive(tab) {
    for (const [name, btn] of buttons) {
      const on = name === tab;
      btn.classList.toggle('is-active', on);
      setAttr(btn, 'aria-current', on ? 'page' : null);
    }
  }

  function update(state) {
    if (!state) return;
    const tone = toneOf(state);
    setAttr(mini, 'data-tone', tone);
    setText(phaseText, t(phaseLabelKey(state)));
    const cd = countdownOf(state, { warnMs: ctx.settings.timer.warnBeforeSeconds * 1000 });
    let timeText = cd.text;
    let subText = '';
    switch (tone) {
      case 'work':
      case 'warning': subText = t('mini_until_break'); break;
      case 'break': subText = t('mini_remaining'); break;
      case 'meeting': subText = t('mini_meeting'); break;
      case 'paused': subText = state.pause.until ? t('mini_until_resume') : t('mini_indefinite'); break;
      case 'away':
        timeText = formatClock(state.work.remainingMs);
        subText = t('mini_frozen');
        break;
      default: {
        const next = nextWorkStart(ctx.settings.schedule, new Date(state.now));
        timeText = next ? formatTimeOfDay(next.getTime(), ctx.lang) : '--:--';
        subText = next ? t('mini_next_start') : t('mini_no_reminders');
      }
    }
    setText(time, timeText);
    setText(sub, subText);
    setStyleVar(bar, '--p', (tone === 'off-hours' ? 0 : cd.fraction).toFixed(4));
    meetingChip.hidden = !(state.meeting && state.meeting.active) || tone === 'meeting';
  }

  return { el, setActive, update };
}
