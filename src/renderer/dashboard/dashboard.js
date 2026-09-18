// AugenPause dashboard – bootstrap, shell (titlebar, sidebar, sections), routing and data flow.
import { getApi } from '../shared/api.js';
import { applyAppearance } from '../shared/theme.js';
import { createT } from '../shared/i18n.js';
import STRINGS from './strings.js';
import { h, setText, toggleClass } from './lib/dom.js';
import { withDefaults, normalizeState, normalizeDay, emptyDay } from './lib/defaults.js';
import { todayKey } from './lib/fmt.js';
import { createToast } from './components/toast.js';
import { createSidebar, TABS } from './components/sidebar.js';
import { closeOpenMenu } from './components/menu.js';
import { createOverview } from './views/overview.js';
import { createSettingsView } from './views/settings.js';
import { createStatsView } from './views/stats.js';
import { createExercisesView } from './views/exercises.js';
import { createAboutView } from './views/about.js';

const FACTORIES = {
  overview: createOverview,
  settings: createSettingsView,
  stats: createStatsView,
  exercises: createExercisesView,
  about: createAboutView,
};

const api = getApi();
const root = document.documentElement;
const app = document.getElementById('app');

const ctx = {
  api,
  platform: ['win32', 'darwin', 'linux'].includes(api.platform) ? api.platform : 'linux',
  lang: 'de',
  t: createT(STRINGS, 'de'),
  settings: withDefaults(null),
  state: null,
  today: emptyDay(todayKey()),
  week: [],
  version: '',
  ui: { tab: 'overview', statsRange: 7, tipOffset: 0 },
  navigate,
  saveSettings,
  resetSettings,
  resetStats,
  runAction,
  toast: (message, opts) => shell && shell.toast.show(message, opts),
};

/** @type {null | { toast, sidebar, titleText: HTMLElement, titlebar: HTMLElement, scroller: HTMLElement, pages: Map<string, HTMLElement>, views: Map<string, any> }} */
let shell = null;
let pendingTab = null;

// ---------------------------------------------------------------------------
// shell

function build() {
  const previousTab = ctx.ui.tab;
  const previousScroll = shell ? shell.scroller.scrollTop : 0;
  if (shell) {
    closeOpenMenu();
    for (const view of shell.views.values()) view.destroy?.();
  }

  ctx.t = createT(STRINGS, ctx.lang);
  const { t } = ctx;

  const toast = createToast();
  const sidebar = createSidebar(ctx);
  const titleText = h('span', { class: 'titlebar-title' });
  const titlebar = h('div', { class: 'titlebar' },
    h('div', { class: 'titlebar-side' }),
    h('div', { class: 'titlebar-main' }, titleText));
  const scroller = h('main', { class: 'content', id: 'content', tabIndex: -1 });

  const pages = new Map();
  const views = new Map();
  for (const tab of TABS) {
    let view;
    try {
      view = FACTORIES[tab](ctx);
    } catch (err) {
      console.error(`[dashboard] failed to build view ${tab}`, err);
      view = { el: h('div', { class: 'view' }, h('p', { class: 'muted' }, t('view_error'))) };
    }
    const page = h('div', { class: 'page', dataset: { page: tab }, hidden: true, 'aria-label': t(`nav_${tab}`) }, view.el);
    pages.set(tab, page);
    views.set(tab, view);
    scroller.appendChild(page);
  }

  scroller.addEventListener('scroll', onScroll, { passive: true });

  app.replaceChildren(sidebar.el, h('div', { class: 'main' }, titlebar, scroller), toast.el);
  shell = { toast, sidebar, titleText, titlebar, scroller, pages, views };
  sidebar.update(ctx.state);

  ctx.ui.tab = null;
  navigate(pendingTab || previousTab || 'overview', null, { instant: true });
  pendingTab = null;
  if (previousScroll) scroller.scrollTop = previousScroll;
}

let scrollRaf = 0;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (shell) toggleClass(shell.titlebar, 'is-condensed', shell.scroller.scrollTop > 56);
  });
}

function navigate(tab, anchorId, opts = {}) {
  if (!TABS.includes(tab)) return;
  if (!shell) {
    pendingTab = tab;
    return;
  }
  closeOpenMenu();
  const prev = ctx.ui.tab;
  if (prev === tab) {
    if (anchorId) scrollToAnchor(anchorId);
    else shell.scroller.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (prev) {
    shell.views.get(prev)?.onHide?.();
    const oldPage = shell.pages.get(prev);
    oldPage.hidden = true;
    oldPage.classList.remove('is-entering');
  }
  ctx.ui.tab = tab;
  const page = shell.pages.get(tab);
  page.hidden = false;
  if (!opts.instant) {
    page.classList.remove('is-entering');
    void page.offsetWidth;
    page.classList.add('is-entering');
  }
  shell.scroller.scrollTop = 0;
  toggleClass(shell.titlebar, 'is-condensed', false);
  shell.sidebar.setActive(tab);
  setText(shell.titleText, ctx.t(`nav_${tab}`));
  document.title = `${ctx.t(`nav_${tab}`)} – ${ctx.t('app_name')}`;
  const view = shell.views.get(tab);
  view?.onShow?.();
  if (anchorId) requestAnimationFrame(() => scrollToAnchor(anchorId));
}

function scrollToAnchor(id) {
  const target = document.getElementById(id);
  if (!target || !shell) return;
  const top = target.getBoundingClientRect().top - shell.scroller.getBoundingClientRect().top + shell.scroller.scrollTop - 60;
  shell.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  target.classList.remove('is-highlight');
  void target.offsetWidth;
  target.classList.add('is-highlight');
}

// ---------------------------------------------------------------------------
// data flow

function applySettings(next) {
  const prev = ctx.settings;
  ctx.settings = withDefaults(next);
  const { lang } = applyAppearance(ctx.settings);
  if (lang !== ctx.lang) {
    ctx.lang = lang;
    build();
    return;
  }
  if (!shell) return;
  for (const view of shell.views.values()) view.onSettings?.(ctx.settings, prev);
  if (ctx.state) shell.sidebar.update(ctx.state);
}

async function saveSettings(patch) {
  let result = null;
  try {
    result = await api.updateSettings(patch);
  } catch (err) {
    console.warn('[dashboard] updateSettings failed', err);
  }
  if (!result || !result.settings) {
    ctx.toast(ctx.t('toast_save_failed'), { kind: 'error' });
    return { ok: false, settings: ctx.settings, errors: (result && result.errors) || ['unavailable'] };
  }
  applySettings(result.settings);
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.ok !== false && errors.length === 0) ctx.toast(ctx.t('toast_saved'));
  return { ok: result.ok !== false, settings: result.settings, errors };
}

async function resetSettings() {
  let next = null;
  try {
    next = await api.resetSettings();
  } catch (err) {
    console.warn('[dashboard] resetSettings failed', err);
  }
  if (!next) {
    ctx.toast(ctx.t('toast_action_failed'), { kind: 'error' });
    return false;
  }
  // main refuses the reset while a break is running: { ok: false, error, settings }
  if (next.ok === false) {
    const running = next.error === 'strict-mode' || next.error === 'break-running';
    ctx.toast(ctx.t(running ? 'toast_reset_blocked' : 'toast_action_failed'), { kind: 'error' });
    if (next.settings) applySettings(next.settings);
    return false;
  }
  applySettings(next);
  ctx.toast(ctx.t('toast_settings_reset'));
  return true;
}

async function resetStats() {
  let res = null;
  try {
    res = await api.resetStats();
  } catch (err) {
    console.warn('[dashboard] resetStats failed', err);
  }
  if (!res || !res.ok) {
    ctx.toast(ctx.t('toast_action_failed'), { kind: 'error' });
    return false;
  }
  ctx.toast(ctx.t('toast_stats_reset'));
  return true;
}

async function runAction(name, arg) {
  let res = null;
  try {
    res = await api.action(name, arg);
  } catch (err) {
    console.warn('[dashboard] action failed', name, err);
  }
  if (!res || !res.ok) ctx.toast(ctx.t('toast_action_failed'), { kind: 'error' });
  return res || { ok: false };
}

function onState(raw) {
  if (!raw) return;
  ctx.state = normalizeState(raw, ctx.settings);
  if (ctx.state.today && ctx.today) {
    // keep the full DayStats in sync with the convenience subset pushed every second
    const { breaksCompleted, breaksSkipped, glasses, workSeconds } = ctx.state.today;
    Object.assign(ctx.today, { breaksCompleted, breaksSkipped, glasses, workSeconds });
  }
  if (!shell) return;
  shell.sidebar.update(ctx.state);
  shell.views.get(ctx.ui.tab)?.onState?.(ctx.state);
}

function onStats(today) {
  if (!today) return;
  ctx.today = normalizeDay(today);
  if (!shell) return;
  for (const view of shell.views.values()) view.onStats?.(ctx.today);
}

// ---------------------------------------------------------------------------
// global keyboard shortcuts inside the window

document.addEventListener('keydown', (e) => {
  const mod = ctx.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return;
  if (/^[1-5]$/.test(e.key)) {
    e.preventDefault();
    navigate(TABS[Number(e.key) - 1]);
  } else if (e.key === ',') {
    e.preventDefault();
    navigate('settings');
  }
});

document.addEventListener('visibilitychange', () => toggleClass(root, 'is-window-hidden', document.hidden));

// ---------------------------------------------------------------------------
// startup

async function init() {
  root.dataset.platform = ctx.platform;

  api.onNavigate((tab) => navigate(tab));
  const boot = window.__augenpauseBoot;
  if (boot) {
    boot.unsubscribe?.();
    if (boot.tab) pendingTab = boot.tab;
  }
  api.onState(onState);
  api.onSettings((s) => { if (s) applySettings(s); });
  api.onStats(onStats);

  let snap = null;
  try {
    snap = await api.getSnapshot();
  } catch (err) {
    console.warn('[dashboard] getSnapshot failed', err);
  }

  ctx.settings = withDefaults(snap && snap.settings);
  ctx.lang = applyAppearance(ctx.settings).lang;
  if (!ctx.state || (snap && snap.state && snap.state.now > ctx.state.now)) {
    ctx.state = normalizeState(snap && snap.state, ctx.settings);
  }
  ctx.week = Array.isArray(snap && snap.stats) ? snap.stats.map(normalizeDay) : [];
  const last = ctx.week[ctx.week.length - 1];
  if (last && last.date === todayKey()) ctx.today = { ...last };
  ctx.version = (snap && snap.version) || '';

  build();
  requestAnimationFrame(() => root.classList.add('is-ready'));
}

init();
