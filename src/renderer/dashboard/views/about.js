// Über: updates, name, version, privacy, security, break-lock note, shortcuts, licence.
// The only outbound link is the release page – opened by main via the `open-release-page` action.
import { h } from '../lib/dom.js';
import { icon, logoMark } from '../icons.js';
import { sectionHeader, groupCard } from '../components/section.js';
import { shortcutList } from '../components/shortcuts.js';
import { createUpdateCard } from '../components/update.js';
import { isMandatoryBreak } from '../lib/phase.js';

export function createAboutView(ctx) {
  const { t } = ctx;
  const version = ctx.version ? t('about_version', { version: ctx.version }) : t('about_version_unknown');

  const hero = h('section', { class: 'card about-hero' },
    h('div', { class: 'about-logo' }, logoMark(72, 'about')),
    h('div', { class: 'about-hero-text' },
      h('div', { class: 'about-name-row' },
        h('h2', { class: 'about-name' }, t('app_name')),
        h('span', { class: 'chip chip-accent tabular' }, version)),
      h('p', { class: 'about-tagline' }, t('about_tagline')),
      h('p', { class: 'about-desc' }, t('about_desc'))));

  const bullets = (keys, iconName = 'check') => h('ul', { class: 'bullets' },
    keys.map((k) => h('li', null, h('span', { class: 'bullet-icon' }, icon(iconName, { size: 14 })), h('span', null, t(k)))));

  const privacy = groupCard({ iconName: 'cloudOff', title: t('about_privacy'), tone: 'break' },
    h('p', { class: 'about-text' }, t('about_privacy_text')),
    bullets(['about_privacy_b1', 'about_privacy_b2', 'about_privacy_b3', 'about_privacy_b4']),
    h('p', { class: 'about-note' }, icon('about', { size: 15 }), h('span', null, t('about_privacy_update'))));

  const security = groupCard({ iconName: 'shield', title: t('about_security') },
    bullets(['about_sec_sandbox', 'about_sec_isolation', 'about_sec_csp', 'about_sec_scripts']));

  const lockKey = ctx.platform === 'darwin' ? 'about_lock_mac' : ctx.platform === 'win32' ? 'about_lock_win' : 'about_lock_linux';
  const lock = groupCard({ iconName: 'lock', title: t('about_lock') },
    h('p', { class: 'about-text' }, t('about_lock_text')),
    bullets(['about_lock_b1', 'about_lock_b2', 'about_lock_b3']),
    h('p', { class: 'about-note' }, icon('about', { size: 15 }), h('span', null, t(lockKey))));

  const shortcuts = groupCard({ iconName: 'keyboard', title: t('about_shortcuts') },
    shortcutList(ctx),
    h('p', { class: 'about-note' }, icon('about', { size: 15 }), h('span', null, t('about_shortcuts_note', { mod: ctx.platform === 'darwin' ? '⌘' : (ctx.lang === 'de' ? 'Strg' : 'Ctrl') }))));

  const license = groupCard({ iconName: 'file', title: t('about_license') },
    h('p', { class: 'about-text' }, t('about_license_text')));

  const update = createUpdateCard(ctx);

  const header = sectionHeader(t('about_title'), t('about_subtitle'));
  const el = h('div', { class: 'view view-about' },
    header.el,
    update.el,
    hero,
    h('div', { class: 'about-grid' }, privacy, security, lock, license, shortcuts),
    h('p', { class: 'about-footer' }, icon('heart', { size: 14 }), h('span', null, t('about_footer'))));

  // the state arrives every second, but only the Pflicht-Pause (§11) changes anything here
  let lastMandatory = isMandatoryBreak(ctx.state);

  return {
    el,
    onShow() {
      lastMandatory = isMandatoryBreak(ctx.state);
      update.render(ctx.update, ctx.state);
      update.measure();
      // no push channel → pull the current state once when the page becomes visible
      ctx.pollUpdate(1);
    },
    onUpdate(next) {
      update.render(next, ctx.state);
    },
    onState(state) {
      const mandatory = isMandatoryBreak(state);
      if (mandatory === lastMandatory) return;
      lastMandatory = mandatory;
      update.render(ctx.update, state);
    },
    onSettings() {
      update.render(ctx.update, ctx.state);
    },
  };
}
