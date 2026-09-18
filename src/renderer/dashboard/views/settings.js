// Einstellungen: grouped cards, every control applies live via api.updateSettings(patch).
import { h, setText, setAttr, setPath, setStyleVar } from '../lib/dom.js';
import { icon } from '../icons.js';
import { formatMinutes } from '../../shared/format.js';
import { fmtSeconds, fmtMl, fmtDays, ordinal, MON_FIRST } from '../lib/fmt.js';
import { PRESETS, clone } from '../lib/defaults.js';
import { minutesOfDay } from '../lib/phase.js';
import { sectionHeader, groupCard } from '../components/section.js';
import { inlineConfirm } from '../components/confirm.js';
import { shortcutList } from '../components/shortcuts.js';
import {
  switchRow, sliderRow, stepperRow, segmentedRow, swatchRow, daysRow, timeRangeRow, buttonRow, customRow, collapsible,
} from '../components/controls.js';

const range = (from, to, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

const STOPS = {
  workMinutes: [...range(1, 10), 12, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 75, 80, 90, 100, 105, 110, 120, 135, 150, 165, 180, 195, 210, 225, 240],
  shortBreakSeconds: [20, 25, 30, 40, 45, 50, 60, 75, 90, 105, 120, 150, 180, 210, 240, 270, 300, 360, 420, 480, 540, 600, 720, 900, 1080, 1200, 1500, 1800],
  longBreakSeconds: [60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600, 720, 900, 1080, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600],
  warnBeforeSeconds: [0, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, 540, 600],
  graceSeconds: [0, 5, 10, 15, 20, 25, 30, 45, 60, 75, 90, 105, 120],
  intervalMinutes: [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 75, 80, 90, 100, 105, 110, 120, 135, 150, 165, 180, 195, 210, 225, 240],
  glassMl: [50, 100, 150, 200, 250, 300, 330, 350, 400, 450, 500, 600, 700, 750, 800, 900, 1000],
};

const PRESET_ORDER =['halfhour', 'hourly', '20-20-20', 'pomodoro', 'custom'];
const ACCENTS = ['teal', 'violet', 'blue', 'green', 'orange', 'pink'];
const OPACITY_MIN_PCT = 20;
const OPACITY_MAX_PCT = 100;
const OPACITY_STEP_PCT = 5;

/**
 * Live preview of the transparent break screen (docs/ARCHITECTURE.md §11): a mini fake desktop
 * (pure CSS gradients – a light editor window, a dark terminal, a colourful wallpaper) under the
 * tint rgba(11, 16, 32, overlayOpacity) plus the little glass chip the real overlay shows.
 */
function tintPreview() {
  const el = h('div', { class: 'tint-preview', 'aria-hidden': 'true' },
    h('span', { class: 'tint-desk' },
      h('span', { class: 'tint-win tint-win--editor' }),
      h('span', { class: 'tint-win tint-win--term' })),
    h('span', { class: 'tint-veil' }),
    h('span', { class: 'tint-aurora' }),
    h('span', { class: 'tint-chip' }, h('span', { class: 'tint-dot' }), h('span', { class: 'tabular' }, '16:32')));
  return {
    el,
    set(value) {
      const alpha = Math.min(1, Math.max(0.2, Number(value) || 0.6));
      setStyleVar(el, '--tint-a', alpha.toFixed(2));
    },
  };
}

export function createSettingsView(ctx) {
  const { t, lang } = ctx;
  let destroyed = false;
  let draft = clone(ctx.settings);
  const controls = [];
  const derived = [];

  const add = (control) => {
    controls.push(control);
    return control;
  };

  // ---- env for controls ----------------------------------------------------
  const env = {
    t,
    draft(path, value) {
      setPath(draft, path, value);
      refreshDerived();
    },
    async commit(ctrl, patch) {
      ctrl.inflight = (ctrl.inflight || 0) + 1;
      let result;
      try {
        result = await ctx.saveSettings(patch);
      } finally {
        ctrl.inflight -= 1;
      }
      if (destroyed) return;
      ctrl.setError(null);
      const unmatched = [];
      for (const err of result.errors || []) {
        if (err === 'unavailable') continue;
        const path = String(err).split(':')[0].trim();
        const target = controls.find((c) => c.paths.some((p) => p === path || path.startsWith(`${p}.`)));
        const msg = path.startsWith('schedule.start') || path.startsWith('schedule.end') ? t('err_end_after_start') : t('err_invalid');
        if (target) target.setError(msg);
        else unmatched.push(err);
      }
      if (unmatched.length) ctx.toast(t('err_generic'), { kind: 'error' });
      resync(ctx.settings);
    },
  };

  function resync(settings) {
    draft = clone(settings);
    for (const c of controls) for (const [p, v] of c.pending()) setPath(draft, p, v);
    for (const c of controls) c.sync(settings, draft);
    refreshDerived();
  }

  function refreshDerived() {
    for (const fn of derived) fn(draft);
    for (const c of controls) if (c.el.classList.contains('collapse')) c.sync(ctx.settings, draft);
  }

  // ---- formatters --------------------------------------------------------
  const fmtMin = (v) => formatMinutes(v, lang);
  const fmtSec = (v) => fmtSeconds(v, lang);
  const fmtOffSec = (v) => (v === 0 ? t('value_off') : fmtSeconds(v, lang));
  const fmtPct = (v) => `${Math.round(v * 100)} %`;

  // ======================================================================
  // 1. Timer
  const summaryText = h('span');
  derived.push((d) => setText(summaryText, timerSummary(d)));
  const summary = h('div', { class: 'summary-banner' }, h('span', { class: 'summary-icon' }, icon('sparkles', { size: 16 })), summaryText);

  const presetButtons = PRESET_ORDER.map((p) => {
    const meta = p === 'custom'
      ? t('preset_custom_meta')
      : `${fmtMin(PRESETS[p].workMinutes)} · ${fmtSec(PRESETS[p].shortBreakSeconds)}`;
    return h('button', {
      type: 'button', class: 'preset', role: 'radio', dataset: { preset: p }, onClick: () => choosePreset(p),
    },
    h('span', { class: 'preset-name' }, t(`preset_${p.replace(/-/g, '')}`)),
    h('span', { class: 'preset-meta tabular' }, meta));
  });
  const presetGroup = h('div', { class: 'presets', role: 'radiogroup', 'aria-label': t('set_preset') }, presetButtons);
  presetGroup.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    const idx = presetButtons.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = presetButtons[(idx + dir + presetButtons.length) % presetButtons.length];
    next.focus();
    choosePreset(next.dataset.preset);
  });
  const presetCtrl = add({
    el: h('div', { class: 'set-row set-row--block' },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, t('set_preset')), h('p', { class: 'set-help' }, t('set_preset_help'))),
      presetGroup),
    paths: ['timer.preset'],
    inflight: 0,
    busy() { return this.inflight > 0; },
    pending() { return []; },
    setError() {},
    sync(s, d) {
      const current = (d || s).timer.preset;
      for (const b of presetButtons) {
        const on = b.dataset.preset === current;
        setAttr(b, 'aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    },
  });
  function choosePreset(p) {
    if (draft.timer.preset === p) return;
    draft.timer.preset = p;
    if (PRESETS[p]) Object.assign(draft.timer, PRESETS[p]);
    presetCtrl.sync(ctx.settings, draft);
    for (const c of controls) if (c.paths.some((x) => x.startsWith('timer.')) && c !== presetCtrl && !c.busy()) c.sync(draft, draft);
    refreshDerived();
    env.commit(presetCtrl, { timer: { preset: p } });
  }
  // manual changes of preset-controlled fields switch the highlight to "custom" immediately
  derived.push((d) => {
    const p = d.timer.preset;
    if (p !== 'custom' && PRESETS[p] && ['workMinutes', 'shortBreakSeconds', 'longBreakSeconds', 'longBreakEvery'].some((f) => d.timer[f] !== PRESETS[p][f])) {
      d.timer.preset = 'custom';
    }
    presetCtrl.sync(ctx.settings, d);
  });

  const timerCard = groupCard({ id: 'group-timer', iconName: 'timer', title: t('grp_timer'), description: t('grp_timer_desc') },
    summary,
    presetCtrl.el,
    add(sliderRow(env, { path: 'timer.workMinutes', label: t('set_work'), help: t('set_work_help'), stops: STOPS.workMinutes, format: fmtMin })).el,
    add(sliderRow(env, { path: 'timer.shortBreakSeconds', label: t('set_short'), help: t('set_short_help'), stops: STOPS.shortBreakSeconds, format: fmtSec })).el,
    add(switchRow(env, { path: 'timer.longBreakEnabled', label: t('set_long_enabled'), help: t('set_long_enabled_help') })).el,
    add(collapsible((d) => d.timer.longBreakEnabled, [
      add(sliderRow(env, { path: 'timer.longBreakSeconds', label: t('set_long_duration'), help: t('set_long_duration_help'), stops: STOPS.longBreakSeconds, format: fmtSec })),
      add(stepperRow(env, { path: 'timer.longBreakEvery', label: t('set_long_every'), help: t('set_long_every_help'), min: 2, max: 12, format: (v) => ordinal(v, lang) })),
    ])).el);

  // ======================================================================
  // 2. Meetings & interruptions
  const graceCtrl = add(sliderRow(env, { path: 'breaks.graceSeconds', label: t('set_grace'), help: t('set_grace_help'), stops: STOPS.graceSeconds, format: fmtOffSec }));
  const meetingCard = groupCard({ id: 'group-meeting', iconName: 'video', title: t('grp_meeting'), description: t('grp_meeting_desc'), tone: 'meeting' },
    add(switchRow(env, { path: 'meeting.autoDetect', label: t('set_meeting_detect'), help: t('set_meeting_detect_help') })).el,
    add(sliderRow(env, { path: 'timer.warnBeforeSeconds', label: t('set_warn'), help: t('set_warn_help'), stops: STOPS.warnBeforeSeconds, format: fmtOffSec })).el,
    add(switchRow(env, { path: 'widget.showOnWarning', label: t('set_show_on_warning'), help: t('set_show_on_warning_help') })).el,
    graceCtrl.el,
    add(sliderRow(env, { path: 'timer.snoozeMinutes', label: t('set_snooze'), help: t('set_snooze_help'), min: 1, max: 30, step: 1, format: fmtMin })).el,
    add(stepperRow(env, { path: 'timer.maxSnoozes', label: t('set_max_snoozes'), help: t('set_max_snoozes_help'), min: 0, max: 10, format: (v) => (v === 0 ? t('value_never') : `${v}×`) })).el);

  // ======================================================================
  // 3. Breaks
  const tint = tintPreview();
  const lockCtrl = add(switchRow(env, { path: 'breaks.lockScreen', label: t('set_lock'), help: t('set_lock_help') }));
  const strictCtrl = add(switchRow(env, { path: 'breaks.strictMode', label: t('set_strict'), help: t('set_strict_help') }));
  const skipHoldCtrl = add(sliderRow(env, {
    path: 'breaks.skipHoldSeconds', label: t('set_skip_hold'), help: t('set_skip_hold_help'), min: 0, max: 10, step: 1,
    format: (v) => (v === 0 ? t('value_click') : `${v} s`),
  }));
  // Pflicht-Pause (§11): there is no skipping and no grace period, so both controls only matter without it.
  // Pflicht-Pause WITHOUT the lock screen is a reachable trap: nothing appears on screen, yet every action
  // (and quitting) stays blocked for the whole break → warn right on the "Bildschirm sperren" row.
  derived.push((d) => {
    const strict = Boolean(d.breaks.strictMode);
    for (const c of [graceCtrl, skipHoldCtrl]) {
      c.setDisabled(strict);
      c.setNote(strict ? t('set_flex_only_note') : null);
    }
    lockCtrl.setNote(strict && d.breaks.lockScreen === false ? t('set_lock_strict_note') : null);
  });

  const breaksCard = groupCard({ id: 'group-breaks', iconName: 'coffee', title: t('grp_breaks'), description: t('grp_breaks_desc') },
    lockCtrl.el,
    add(collapsible((d) => d.breaks.lockScreen, [
      add(switchRow(env, { path: 'breaks.allDisplays', label: t('set_all_displays'), help: t('set_all_displays_help') })),
      add(switchRow(env, { path: 'breaks.showExercises', label: t('set_exercises'), help: t('set_exercises_help') })),
      add(sliderRow(env, {
        path: 'breaks.overlayOpacity', label: t('set_overlay_opacity'), help: t('set_overlay_opacity_help'),
        min: OPACITY_MIN_PCT, max: OPACITY_MAX_PCT, step: OPACITY_STEP_PCT,
        toSetting: (v) => Math.round(v) / 100,
        fromSetting: (v) => Math.round(Number(v) * 100),
        format: (v) => t('value_opacity', { n: Math.round(Number(v) * 100) }),
        preview: tint.el,
        onValue: (v) => tint.set(v),
      })),
    ])).el,
    strictCtrl.el,
    skipHoldCtrl.el,
    add(switchRow(env, { path: 'breaks.soundEnabled', label: t('set_sound'), help: t('set_sound_help') })).el,
    add(collapsible((d) => d.breaks.soundEnabled, [
      add(sliderRow(env, {
        path: 'breaks.soundVolume', label: t('set_volume'), min: 0, max: 100, step: 5,
        toSetting: (v) => v / 100, fromSetting: (v) => Math.round(v * 100), format: fmtPct,
      })),
    ])).el);

  // ======================================================================
  // 4. Idle
  const idleCard = groupCard({ id: 'group-idle', iconName: 'away', title: t('grp_idle'), description: t('grp_idle_desc') },
    add(switchRow(env, { path: 'idle.enabled', label: t('set_idle'), help: t('set_idle_help') })).el,
    add(collapsible((d) => d.idle.enabled, [
      add(sliderRow(env, { path: 'idle.resetAfterMinutes', label: t('set_idle_after'), help: t('set_idle_after_help'), min: 1, max: 60, step: 1, format: fmtMin })),
    ])).el);

  // ======================================================================
  // 5. Hydration
  const waterSummary = h('span', { class: 'inline-summary tabular' });
  derived.push((d) => setText(waterSummary, t('water_daily_summary', {
    total: fmtMl(d.hydration.dailyGoalGlasses * d.hydration.glassMl, lang),
    n: d.hydration.dailyGoalGlasses,
    ml: fmtMl(d.hydration.glassMl, lang),
  })));
  const hydrationCard = groupCard({ id: 'group-hydration', iconName: 'droplet', title: t('grp_water'), description: t('grp_water_desc'), tone: 'water' },
    add(switchRow(env, { path: 'hydration.enabled', label: t('set_water'), help: t('set_water_help') })).el,
    add(collapsible((d) => d.hydration.enabled, [
      add(sliderRow(env, { path: 'hydration.intervalMinutes', label: t('set_water_interval'), help: t('set_water_interval_help'), stops: STOPS.intervalMinutes, format: fmtMin })),
    ])).el,
    add(stepperRow(env, { path: 'hydration.dailyGoalGlasses', label: t('set_water_goal'), help: t('set_water_goal_help'), min: 1, max: 30, format: (v) => String(v), unitLabel: t('unit_glasses') })).el,
    add(sliderRow(env, { path: 'hydration.glassMl', label: t('set_glass'), stops: STOPS.glassMl, format: (v) => fmtMl(v, lang) })).el,
    h('div', { class: 'set-footer' }, icon('glass', { size: 15 }), waterSummary));

  // ======================================================================
  // 6. Working hours
  const scheduleSummary = h('span', { class: 'inline-summary tabular' });
  derived.push((d) => {
    const a = minutesOfDay(d.schedule.start);
    const b = minutesOfDay(d.schedule.end);
    setText(scheduleSummary, t('schedule_summary', {
      days: fmtDays(d.schedule.days, t),
      start: d.schedule.start,
      end: d.schedule.end,
      duration: a != null && b != null && b > a ? formatMinutes(b - a, lang) : '—',
    }));
  });
  const dayLongFmt = new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long' });
  const scheduleCard = groupCard({ id: 'group-schedule', iconName: 'briefcase', title: t('grp_schedule'), description: t('grp_schedule_desc') },
    add(switchRow(env, { path: 'schedule.workingHoursEnabled', label: t('set_hours'), help: t('set_hours_help') })).el,
    add(collapsible((d) => d.schedule.workingHoursEnabled, [
      add(daysRow(env, {
        path: 'schedule.days', label: t('set_days'), order: MON_FIRST,
        dayLabel: (d) => t(`day_short_${d}`),
        dayName: (d) => dayLongFmt.format(new Date(2024, 0, 7 + d)),
        emptyError: t('err_days_empty'),
      })),
      add(timeRangeRow(env, {
        startPath: 'schedule.start', endPath: 'schedule.end', label: t('set_time'), help: t('set_time_help'),
        startLabel: t('set_time_start'), endLabel: t('set_time_end'), orderError: t('err_end_after_start'),
      })),
      { el: h('div', { class: 'set-footer' }, icon('calendar', { size: 15 }), scheduleSummary), paths: [], sync() {}, setError() {}, busy: () => false, pending: () => [] },
    ])).el);

  // ======================================================================
  // 7. Widget
  const widgetCard = groupCard({ id: 'group-widget', iconName: 'widget', title: t('grp_widget'), description: t('grp_widget_desc') },
    add(switchRow(env, { path: 'widget.visible', label: t('set_widget_visible'), help: t('set_widget_visible_help') })).el,
    add(collapsible((d) => d.widget.visible, [
      add(switchRow(env, { path: 'widget.alwaysOnTop', label: t('set_widget_top'), help: t('set_widget_top_help') })),
      add(segmentedRow(env, {
        path: 'widget.size', label: t('set_widget_size'),
        options: [{ value: 'small', label: t('size_small') }, { value: 'medium', label: t('size_medium') }, { value: 'large', label: t('size_large') }],
      })),
      add(sliderRow(env, {
        path: 'widget.opacity', label: t('set_widget_opacity'), min: 30, max: 100, step: 5,
        toSetting: (v) => v / 100, fromSetting: (v) => Math.round(v * 100), format: fmtPct,
      })),
      add(switchRow(env, { path: 'widget.showSeconds', label: t('set_widget_seconds'), help: t('set_widget_seconds_help') })),
      add(buttonRow({
        label: t('set_widget_position'), help: t('set_widget_position_help'), buttonLabel: t('btn_reset_position'), buttonIcon: 'move',
        onClick: async () => {
          const res = await ctx.runAction('reset-widget-position');
          if (res.ok) ctx.toast(t('toast_position_reset'));
        },
      })),
    ])).el);

  // ======================================================================
  // 8. Appearance
  const appearanceCard = groupCard({ id: 'group-appearance', iconName: 'palette', title: t('grp_appearance'), description: t('grp_appearance_desc') },
    add(segmentedRow(env, {
      path: 'appearance.theme', label: t('set_theme'),
      options: [
        { value: 'system', label: t('theme_system'), icon: 'monitor' },
        { value: 'dark', label: t('theme_dark'), icon: 'moon' },
        { value: 'light', label: t('theme_light'), icon: 'sun' },
      ],
    })).el,
    add(swatchRow(env, { path: 'appearance.accent', label: t('set_accent'), options: ACCENTS.map((a) => ({ value: a, label: t(`accent_${a}`) })) })).el,
    add(segmentedRow(env, {
      path: 'language', label: t('set_language'), help: t('set_language_help'),
      options: [{ value: 'system', label: t('lang_system') }, { value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }],
    })).el);

  // ======================================================================
  // 9. General
  const shortcutsHost = h('div', { class: 'shortcuts-host' }, shortcutList(ctx));
  derived.push((d) => shortcutsHost.firstChild.classList.toggle('is-disabled', !d.general.globalShortcuts));
  const generalCard = groupCard({ id: 'group-general', iconName: 'power', title: t('grp_general'), description: t('grp_general_desc') },
    add(switchRow(env, { path: 'general.autostart', label: t('set_autostart'), help: t('set_autostart_help') })).el,
    add(switchRow(env, { path: 'general.notifications', label: t('set_notifications'), help: t('set_notifications_help') })).el,
    add(switchRow(env, { path: 'general.globalShortcuts', label: t('set_shortcuts'), help: t('set_shortcuts_help') })).el,
    shortcutsHost);

  // ======================================================================
  // 10. Danger zone
  const dangerCard = groupCard({ id: 'group-reset', iconName: 'alert', title: t('grp_reset'), description: t('grp_reset_desc'), tone: 'danger', className: 'danger-card' },
    customRow({
      label: t('set_reset'),
      help: t('set_reset_help'),
      content: inlineConfirm({
        label: t('btn_reset_settings'),
        question: t('confirm_question'),
        confirmLabel: t('btn_confirm_reset'),
        cancelLabel: t('btn_cancel'),
        icon: 'reset',
        onConfirm: () => ctx.resetSettings(),
      }),
    }).el);

  // ---- jump bar -------------------------------------------------------------
  const groups = [
    ['group-timer', 'grp_timer', 'timer'], ['group-meeting', 'grp_meeting_short', 'video'], ['group-breaks', 'grp_breaks', 'coffee'],
    ['group-idle', 'grp_idle', 'away'], ['group-hydration', 'grp_water', 'droplet'], ['group-schedule', 'grp_schedule', 'briefcase'],
    ['group-widget', 'grp_widget', 'widget'], ['group-appearance', 'grp_appearance', 'palette'], ['group-general', 'grp_general', 'power'],
  ];
  const jump = h('nav', { class: 'jump-bar', 'aria-label': t('jump_label') },
    groups.map(([id, key, ic]) => h('button', { type: 'button', class: 'jump-chip', onClick: () => ctx.navigate('settings', id) },
      icon(ic, { size: 14 }), t(key))));

  const header = sectionHeader(t('settings_title'), t('settings_subtitle'));
  const el = h('div', { class: 'view view-settings' },
    header.el, jump,
    h('div', { class: 'groups' }, timerCard, meetingCard, breaksCard, idleCard, hydrationCard, scheduleCard, widgetCard, appearanceCard, generalCard, dangerCard));

  // ---- summary text -------------------------------------------------------
  function timerSummary(d) {
    const tm = d.timer;
    const work = fmtMin(tm.workMinutes);
    const sec = tm.shortBreakSeconds;
    let text;
    if (sec < 60) text = t('summary_short_seconds', { work, n: sec });
    else if (sec % 60 === 0) text = t('summary_short_minutes', { work, n: sec / 60 });
    else text = t('summary_short_mixed', { work, duration: fmtSec(sec) });
    if (tm.longBreakEnabled) text += t('summary_long', { nth: ordinal(tm.longBreakEvery, lang), duration: fmtSec(tm.longBreakSeconds) });
    else text += t('summary_end');
    return text;
  }

  // ---- break lock ----------------------------------------------------------
  // §11: "Pflicht-Pause" may only be switched while no break is running (main rejects it anyway).
  let lockedForBreak = null;
  function applyPhase(state) {
    const inBreak = Boolean(state && state.phase === 'break');
    if (inBreak === lockedForBreak) return;
    lockedForBreak = inBreak;
    strictCtrl.setDisabled(inBreak);
    strictCtrl.setNote(inBreak ? t('set_strict_break_note') : null);
  }

  resync(ctx.settings);
  applyPhase(ctx.state);

  return {
    el,
    onShow() {
      applyPhase(ctx.state);
    },
    onState(state) {
      applyPhase(state);
    },
    onSettings(settings) {
      resync(settings);
      applyPhase(ctx.state);
    },
    destroy() {
      destroyed = true;
    },
  };
}
