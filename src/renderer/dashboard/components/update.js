// Update UI (docs/ARCHITECTURE.md §12): the full card for the Über page and the slim hint
// for the Übersicht page. Both render from the normalised update state and never re-create
// their DOM, so live pushes (ap:update) only change text, classes and the progress bar.
// Release notes are inserted with textContent only – never innerHTML.
import { h, setText, setAttr, setStyleVar, toggleClass } from '../lib/dom.js';
import { icon } from '../icons.js';
import { formatTimeOfDay } from '../../shared/format.js';
import { isMandatoryBreak } from '../lib/phase.js';

const NOTES_LINES = 10;

/** Short chip label + colour per status. */
const CHIP = {
  idle: ['upd_chip_idle', null],
  checking: ['upd_chip_checking', 'chip-water'],
  'up-to-date': ['upd_chip_uptodate', 'chip-break'],
  available: ['upd_chip_available', 'chip-accent'],
  downloading: ['upd_chip_downloading', 'chip-water'],
  ready: ['upd_chip_ready', 'chip-accent'],
  error: ['upd_chip_error', 'chip-danger'],
};
const CHIP_CLASSES = ['chip-water', 'chip-break', 'chip-accent', 'chip-danger'];

const TONE = {
  'up-to-date': 'break',
  available: 'work',
  ready: 'work',
  downloading: 'water',
  checking: 'water',
  error: 'danger',
};

/**
 * Short error codes from main (net-unavailable, timeout, http-503, bad-json, …) become a readable
 * sentence; anything unknown is still shown – as the raw code, never a stack.
 */
function errorReason(t, code) {
  if (!code) return t('upd_err_generic');
  const key = String(code).toLowerCase();
  if (/^http-(403|429)$/.test(key)) return t('upd_err_ratelimit');
  const http = /^http-(\d{3})$/.exec(key);
  if (http) return t('upd_err_http', { code: http[1] });
  if (/net-unavailable|offline|network|enotfound|econnrefused|enetunreach|eai_again|dns/.test(key)) return t('upd_err_offline');
  if (/timeout|etimedout|aborted/.test(key)) return t('upd_err_timeout');
  if (/bad-json|bad-url|too-large|parse|invalid/.test(key)) return t('upd_err_parse');
  if (/download-failed|updater-error|no-feed/.test(key)) return t('upd_err_download');
  return t('upd_err_code', { code: String(code).slice(0, 60) });
}

/**
 * Honest note about what this installation can and cannot do.
 * Derived from capability + legacyBuild + platform – never guessed beyond that.
 */
function platformNoteKey(update, platform) {
  if (update.legacyBuild) return 'upd_note_legacy';
  if (update.capability === 'auto') return 'upd_note_auto';
  if (platform === 'darwin') return 'upd_note_mac';
  if (platform === 'win32') return 'upd_note_portable';
  return 'upd_note_linux';
}

// ---------------------------------------------------------------------------
// Über page: the full card

export function createUpdateCard(ctx) {
  const { t, lang } = ctx;
  // "Später" only mutes the restart prompt for this session (per version).
  let laterFor = null;

  const run = (name) => async () => {
    await ctx.runUpdateAction(name);
  };

  const chipText = h('span');
  const chip = h('span', { class: 'chip update-chip' }, chipText);
  const versionLine = h('p', { class: 'group-desc' });

  const statusIcon = h('span', { class: 'update-status-icon' });
  const statusText = h('span', { class: 'update-status-text' });
  const status = h('p', { class: 'update-status', role: 'status' }, statusIcon, statusText);
  const meta = h('p', { class: 'update-meta', hidden: true });

  const barFill = h('span', { class: 'update-bar-fill' });
  const bar = h('div', {
    class: 'update-bar', hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
  }, barFill);

  const notesTitle = h('div', { class: 'update-notes-title' });
  const notesText = h('div', { class: 'update-notes-text is-clamped' });
  const notesToggle = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm update-notes-toggle', hidden: true, 'aria-expanded': 'false',
    onClick: () => setNotesOpen(notesText.classList.contains('is-clamped')),
  }, h('span', null, t('upd_notes_more')), icon('chevronDown', { size: 14 }));
  const notes = h('div', { class: 'update-notes', hidden: true }, notesTitle, notesText, notesToggle);

  function setNotesOpen(open) {
    toggleClass(notesText, 'is-clamped', !open);
    setAttr(notesToggle, 'aria-expanded', open ? 'true' : 'false');
    setText(notesToggle.firstChild, t(open ? 'upd_notes_less' : 'upd_notes_more'));
    toggleClass(notesToggle, 'is-open', open);
  }

  const btnDownload = h('button', { type: 'button', class: 'btn btn-primary btn-sm-md', onClick: run('download-update') },
    icon('download', { size: 15 }), t('upd_btn_download'));
  const btnOpen = h('button', { type: 'button', class: 'btn btn-primary btn-sm-md', onClick: run('open-release-page') },
    icon('external', { size: 15 }), t('upd_btn_open'));
  const btnInstall = h('button', { type: 'button', class: 'btn btn-primary btn-sm-md', onClick: run('install-update') },
    icon('refresh', { size: 15 }), t('upd_btn_install'));
  const btnLater = h('button', {
    type: 'button',
    class: 'btn btn-sm-md',
    onClick: () => {
      laterFor = current.latestVersion || 'ready';
      render();
    },
  }, t('upd_btn_later'));
  const btnCheck = h('button', { type: 'button', class: 'btn btn-sm-md', onClick: run('check-updates') },
    icon('refresh', { size: 15 }), t('upd_btn_check'));
  const btnRelease = h('button', { type: 'button', class: 'btn btn-ghost btn-sm update-link', onClick: run('open-release-page') },
    h('span', null, t('upd_btn_release')), icon('external', { size: 13 }));

  const actions = h('div', { class: 'update-actions' }, btnDownload, btnOpen, btnInstall, btnLater, btnCheck, btnRelease);
  const blockedNote = h('p', { class: 'update-blocked', hidden: true }, icon('lock', { size: 14 }), h('span', null, t('upd_install_blocked')));
  const platformNote = h('p', { class: 'about-note update-platform-note' }, icon('about', { size: 15 }), h('span'));

  const el = h('section', { class: 'card group-card update-card', id: 'about-updates' },
    h('header', { class: 'group-head' },
      h('span', { class: 'icon-tile' }, icon('download', { size: 18 })),
      h('div', { class: 'group-heading' }, h('h2', { class: 'group-title' }, t('upd_title')), versionLine),
      chip),
    h('div', { class: 'group-body' }, status, meta, bar, notes, actions, blockedNote, platformNote));

  let current = ctx.update;
  let lastNotes = null;
  let lastPlatformKey = null;

  function lastCheckLabel(ts) {
    if (!ts) return t('upd_last_check_never');
    const d = new Date(ts);
    const time = formatTimeOfDay(ts, lang);
    const sameDay = d.toDateString() === new Date().toDateString();
    const value = sameDay
      ? t('upd_today_at', { time })
      : `${d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${time}`;
    return t('upd_last_check', { time: value });
  }

  /** Shows the toggle only when the clamped notes really overflow (needs a laid-out element). */
  function measureNotes() {
    if (notes.hidden || !notesText.textContent) return;
    if (!notesText.classList.contains('is-clamped')) return;
    const overflowing = notesText.scrollHeight - notesText.clientHeight > 4;
    if (notesToggle.hidden !== !overflowing) notesToggle.hidden = !overflowing;
  }

  function render(update = current, state = ctx.state) {
    current = update || current;
    const u = current;
    const s = u.status;
    const auto = u.capability === 'auto';
    const version = u.latestVersion || '';
    const pct = Math.round(u.progress * 100);
    const mandatory = isMandatoryBreak(state);

    setAttr(el, 'data-tone', TONE[s] || null);
    toggleClass(el, 'is-busy', s === 'checking');

    const [chipKey, chipClass] = CHIP[s] || CHIP.idle;
    setText(chipText, t(chipKey));
    for (const cls of CHIP_CLASSES) toggleClass(chip, cls, cls === chipClass);
    setText(versionLine, u.currentVersion ? t('upd_current', { version: u.currentVersion }) : t('upd_current_unknown'));

    // ---- status line + meta ----
    let line = '';
    let metaText = '';
    let iconName = 'about';
    switch (s) {
      case 'checking':
        line = t('upd_status_checking');
        iconName = 'refresh';
        break;
      case 'up-to-date':
        line = t('upd_status_uptodate');
        iconName = 'checkCircle';
        metaText = lastCheckLabel(u.lastCheckAt);
        break;
      case 'available':
        line = version ? t('upd_status_available', { version }) : t('upd_status_available_unknown');
        iconName = 'sparkles';
        metaText = u.assetName && !auto ? t('upd_asset', { name: u.assetName }) : lastCheckLabel(u.lastCheckAt);
        break;
      case 'downloading':
        line = t('upd_status_downloading', { percent: pct });
        iconName = 'download';
        metaText = u.assetName ? t('upd_asset', { name: u.assetName }) : '';
        break;
      case 'ready':
        line = t('upd_status_ready');
        iconName = 'checkCircle';
        metaText = version ? t('upd_ready_meta', { version }) : '';
        break;
      case 'error':
        line = t('upd_status_error');
        iconName = 'alert';
        metaText = errorReason(t, u.error);
        break;
      default:
        line = t('upd_status_idle');
        iconName = 'about';
        metaText = ctx.settings.updates.autoCheck ? lastCheckLabel(u.lastCheckAt) : t('upd_auto_off');
    }
    setText(statusText, line);
    if (statusIcon.dataset.icon !== iconName) {
      statusIcon.dataset.icon = iconName;
      statusIcon.replaceChildren(icon(iconName, { size: 17 }));
    }
    meta.hidden = !metaText;
    setText(meta, metaText);

    // ---- progress ----
    bar.hidden = s !== 'downloading';
    if (s === 'downloading') {
      setStyleVar(barFill, '--p', u.progress.toFixed(3));
      setAttr(bar, 'aria-valuenow', String(pct));
      setAttr(bar, 'aria-label', line);
    }

    // ---- release notes ----
    const showNotes = Boolean(u.notes) && ['available', 'downloading', 'ready'].includes(s);
    notes.hidden = !showNotes;
    if (showNotes) {
      setText(notesTitle, version ? t('upd_notes_title', { version }) : t('upd_notes_title_plain'));
      if (u.notes !== lastNotes) {
        lastNotes = u.notes;
        setText(notesText, u.notes);
        setNotesOpen(false);
        notesToggle.hidden = true;
        requestAnimationFrame(measureNotes);
      }
    }

    // ---- buttons ----
    const hasTarget = Boolean(u.releaseUrl || u.assetUrl);
    const offerManual = !auto && (s === 'available' || s === 'ready') && hasTarget;
    const muted = laterFor && laterFor === (u.latestVersion || 'ready');
    btnDownload.hidden = !(auto && s === 'available');
    btnOpen.hidden = !offerManual;
    btnInstall.hidden = !(auto && s === 'ready' && !muted);
    btnLater.hidden = btnInstall.hidden;
    btnCheck.hidden = s === 'checking' || s === 'downloading';
    toggleClass(btnCheck, 'btn-primary', s === 'idle' || s === 'error');
    btnRelease.hidden = !(hasTarget && ['available', 'downloading', 'ready'].includes(s));
    const buttons = [btnDownload, btnOpen, btnInstall, btnLater, btnCheck, btnRelease];
    actions.hidden = buttons.every((b) => b.hidden);
    // the release link only floats to the right when there is something to float away from
    toggleClass(btnRelease, 'is-alone', buttons.slice(0, -1).every((b) => b.hidden));
    // §11: main refuses every update action while a Pflicht-Pause runs – so none of them pretends to work
    for (const b of [btnDownload, btnOpen, btnInstall, btnCheck, btnRelease]) b.disabled = mandatory;
    blockedNote.hidden = !(mandatory && !actions.hidden);

    const noteKey = platformNoteKey(u, ctx.platform);
    if (noteKey !== lastPlatformKey) {
      lastPlatformKey = noteKey;
      setText(platformNote.lastChild, t(noteKey));
    }
    // the install prompt was muted → still say what happens on quit
    if (muted && auto && s === 'ready') {
      meta.hidden = false;
      setText(meta, t('upd_later_note'));
    }
  }

  render(ctx.update, ctx.state);
  return { el, render, measure: measureNotes };
}

// ---------------------------------------------------------------------------
// Übersicht page: the slim hint

export function createUpdateHint(ctx) {
  const { t } = ctx;
  const title = h('div', { class: 'update-hint-title' });
  const sub = h('div', { class: 'update-hint-sub' });
  const open = h('button', {
    type: 'button', class: 'btn btn-primary btn-sm-md', onClick: () => ctx.navigate('about', 'about-updates'),
  }, t('upd_hint_show'));
  const close = h('button', {
    type: 'button',
    class: 'btn btn-icon btn-ghost btn-round update-hint-close',
    'aria-label': t('upd_hint_dismiss'),
    title: t('upd_hint_dismiss'),
    onClick: () => {
      ctx.ui.updateHintDismissed = hintKey(ctx.update);
      render();
    },
  }, icon('x', { size: 15 }));

  const el = h('section', { class: 'card update-hint', dataset: { tone: 'work' }, hidden: true, role: 'status' },
    h('span', { class: 'icon-tile' }, icon('download', { size: 17 })),
    h('div', { class: 'update-hint-text' }, title, sub),
    open, close);

  function hintKey(u) {
    return `${u.status}:${u.latestVersion || ''}`;
  }

  function render(update = ctx.update) {
    const u = update || ctx.update;
    const relevant = u.status === 'available' || u.status === 'ready';
    const show = relevant && ctx.ui.updateHintDismissed !== hintKey(u);
    el.hidden = !show;
    if (!show) return;
    const version = u.latestVersion || '';
    setText(title, u.status === 'ready'
      ? t('upd_hint_ready')
      : (version ? t('upd_hint_available', { version }) : t('upd_status_available_unknown')));
    setText(sub, t(u.status === 'ready' ? 'upd_hint_sub_ready' : 'upd_hint_sub'));
  }

  render(ctx.update);
  return { el, render };
}
