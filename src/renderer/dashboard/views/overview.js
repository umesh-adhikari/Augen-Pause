// Übersicht: live hero ring + actions, today's tiles and the tip of the day.
import { h, setText, setAttr, setStyleVar, toggleClass } from '../lib/dom.js';
import { icon } from '../icons.js';
import { formatDuration, formatMinutes, formatTimeOfDay, formatClock } from '../../shared/format.js';
import { fmtPercent, fmtMl, fmtDays, fmtDayLong, splitUnits, plural } from '../lib/fmt.js';
import { toneOf, phaseLabelKey, countdownOf, cycleInfo, nextWorkStart, isMandatoryBreak } from '../lib/phase.js';
import { createRing } from '../components/ring.js';
import { attachMenu } from '../components/menu.js';
import { sectionHeader } from '../components/section.js';
import { createUpdateHint } from '../components/update.js';

const TIP_COUNT = 14;
const TIP_ROTATE_MS = 45000;

export function createOverview(ctx) {
  const { t, lang } = ctx;

  // ---- header ---------------------------------------------------------------
  const header = sectionHeader(t('overview_title'), '');
  let headerDay = '';
  function updateHeader() {
    const now = new Date();
    const key = `${now.toDateString()}-${now.getHours() < 11 ? 0 : now.getHours() < 18 ? 1 : 2}`;
    if (key === headerDay) return;
    headerDay = key;
    const greet = now.getHours() < 5 ? 'greet_night' : now.getHours() < 11 ? 'greet_morning' : now.getHours() < 18 ? 'greet_day' : 'greet_evening';
    setText(header.sub, `${t(greet)} · ${fmtDayLong(now, lang)}`);
  }

  // ---- hero -------------------------------------------------------------------
  const ring = createRing();
  const centerIcon = h('span', { class: 'hero-center-icon', hidden: true });
  const countdown = h('div', { class: 'hero-countdown tabular', role: 'timer', 'aria-live': 'off' });
  const countdownLabel = h('div', { class: 'hero-countdown-label' });
  const ringWrap = h('div', { class: 'hero-ring' },
    h('div', { class: 'hero-ring-glow', 'aria-hidden': 'true' }),
    ring.el,
    h('div', { class: 'hero-center' }, centerIcon, countdown, countdownLabel));

  const chipText = h('span');
  const phaseChip = h('span', { class: 'chip tone-chip' }, h('span', { class: 'status-dot' }), chipText);
  const meetingChip = h('span', { class: 'chip chip-meeting', hidden: true }, icon('video', { size: 13 }), t('meeting_active_chip'));
  const title = h('h2', { class: 'hero-title' });

  function detailLine(iconName) {
    const text = h('span');
    const iconSlot = h('span', { class: 'detail-icon' }, icon(iconName, { size: 15 }));
    const el = h('li', { class: 'detail' }, iconSlot, text);
    let currentIcon = iconName;
    return {
      el,
      set(value, nextIcon) {
        el.hidden = !value;
        if (value) setText(text, value);
        if (nextIcon && nextIcon !== currentIcon) {
          currentIcon = nextIcon;
          iconSlot.replaceChildren(icon(nextIcon, { size: 15 }));
        }
      },
    };
  }
  const d1 = detailLine('clock');
  const d2 = detailLine('layers');
  const d3 = detailLine('snooze');
  const cycleDots = h('span', { class: 'cycle-dots', 'aria-hidden': 'true' });
  d2.el.appendChild(cycleDots);
  const details = h('ul', { class: 'hero-details' }, d1.el, d2.el, d3.el);

  const noticeText = h('span');
  const noticeIcon = h('span', { class: 'notice-icon' });
  const notice = h('div', { class: 'hero-notice', hidden: true, role: 'status' }, noticeIcon, noticeText);
  let noticeIconName = '';
  function setNotice(kind, iconName, text) {
    notice.hidden = !text;
    if (!text) return;
    setAttr(notice, 'data-kind', kind);
    if (iconName !== noticeIconName) {
      noticeIconName = iconName;
      noticeIcon.replaceChildren(icon(iconName, { size: 16 }));
    }
    setText(noticeText, text);
  }

  // actions
  const act = (name, arg, toastKey, vars) => async () => {
    const res = await ctx.runAction(name, arg);
    if (res && res.ok && toastKey) ctx.toast(t(toastKey, vars), { icon: 'check' });
  };

  const btnResume = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: act('resume', undefined, 'toast_resumed') },
    icon('play', { size: 16 }), t('act_resume'));
  const btnEndBreak = h('button', { type: 'button', class: 'btn btn-lg', onClick: act('skip-break', undefined, 'toast_break_ended') },
    icon('stop', { size: 16 }), t('act_end_break'));
  const btnBreak = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: act('break-now') },
    icon('coffee', { size: 16 }), t('act_break_now'));
  const btnSchedule = h('button', { type: 'button', class: 'btn btn-lg', onClick: () => ctx.navigate('settings', 'group-schedule') },
    icon('briefcase', { size: 16 }), t('act_edit_hours'));

  const snoozeMeta = h('span', { class: 'split-meta tabular' });
  const snoozeMain = h('button', {
    type: 'button',
    class: 'btn btn-lg split-main',
    onClick: () => {
      const min = ctx.settings.timer.snoozeMinutes;
      act('snooze', min, 'toast_snoozed', { duration: formatMinutes(min, lang) })();
    },
  }, icon('snooze', { size: 16 }), h('span', null, t('act_snooze')), snoozeMeta);
  const snoozeMore = h('button', { type: 'button', class: 'btn btn-lg split-more', 'aria-label': t('act_snooze_options') },
    icon('chevronDown', { size: 16 }));
  const snoozeSplit = h('div', { class: 'split menu-host' }, snoozeMain, snoozeMore);
  attachMenu(snoozeMore, () => {
    const st = ctx.state;
    const left = Math.max(0, st.snooze.max - st.snooze.count);
    const grace = st.phase === 'break' && st.break.inGrace;
    return [
      { heading: t('menu_snooze_heading') },
      ...st.snooze.options.map((min) => ({
        label: `+${formatMinutes(min, lang)}`,
        icon: 'snooze',
        disabled: !st.break.canSnooze,
        onSelect: act('snooze', min, 'toast_snoozed', { duration: formatMinutes(min, lang) }),
      })),
      'separator',
      { heading: grace ? t('snooze_grace_any') : left > 0 ? t('snooze_left', { n: left }) : t('snooze_none_left') },
    ];
  }, { className: 'menu-compact' });

  const btnSkip = h('button', { type: 'button', class: 'btn btn-lg', onClick: act('skip-break', undefined, 'toast_skipped') },
    icon('fastForward', { size: 16 }), t('act_skip'));

  const btnMeeting = h('button', { type: 'button', class: 'btn btn-meeting' },
    icon('video', { size: 16 }), t('act_meeting_mode'), icon('chevronDown', { size: 14, class: 'btn-caret' }));
  const btnMeetingHost = h('div', { class: 'menu-host' }, btnMeeting);
  const pauseItems = (withTomorrow) => [
    { label: formatMinutes(30, lang), icon: 'clock', onSelect: act('pause', 30, 'toast_paused_for', { duration: formatMinutes(30, lang) }) },
    { label: formatMinutes(60, lang), icon: 'clock', onSelect: act('pause', 60, 'toast_paused_for', { duration: formatMinutes(60, lang) }) },
    { label: formatMinutes(120, lang), icon: 'clock', onSelect: act('pause', 120, 'toast_paused_for', { duration: formatMinutes(120, lang) }) },
    withTomorrow ? { label: t('pause_tomorrow'), icon: 'sunrise', onSelect: act('pause', 'tomorrow', 'toast_paused_tomorrow') } : null,
    { label: t('pause_indefinite'), icon: 'infinity', onSelect: act('pause', null, 'toast_paused') },
  ].filter(Boolean);
  attachMenu(btnMeeting, () => [{ heading: t('menu_meeting_heading') }, ...pauseItems(false)]);

  const btnPause = h('button', { type: 'button', class: 'btn btn-ghost-soft', 'aria-label': t('act_pause') },
    icon('pause', { size: 15 }), h('span', { class: 'btn-label-collapsible' }, t('act_pause')), icon('chevronDown', { size: 14, class: 'btn-caret' }));
  const btnPauseHost = h('div', { class: 'menu-host' }, btnPause);
  attachMenu(btnPause, () => [{ heading: t('menu_pause_heading') }, ...pauseItems(true)]);

  const btnReset = h('button', {
    type: 'button',
    class: 'btn btn-ghost-soft btn-icon',
    title: t('act_reset_timer'),
    'aria-label': t('act_reset_timer'),
    onClick: act('reset-timer', undefined, 'toast_timer_reset'),
  }, icon('reset', { size: 15 }));

  const primaryRow = h('div', { class: 'hero-actions' }, btnResume, btnBreak, btnEndBreak, snoozeSplit, btnSkip, btnSchedule);
  const secondaryRow = h('div', { class: 'hero-toolbar' }, btnMeetingHost, btnPauseHost, btnReset);

  const hero = h('section', { class: 'card hero', 'aria-label': t('hero_label') },
    h('div', { class: 'hero-bg', 'aria-hidden': 'true' }),
    ringWrap,
    h('div', { class: 'hero-info' },
      h('div', { class: 'hero-chips' }, phaseChip, meetingChip),
      title,
      details,
      notice,
      secondaryRow),
    h('div', { class: 'hero-footer' }, primaryRow));

  // ---- today tiles ---------------------------------------------------------
  function tile(iconName, label, extra) {
    const value = h('div', { class: 'tile-value' });
    const sub = h('div', { class: 'tile-sub' });
    const el = h('div', { class: 'card tile' },
      h('div', { class: 'tile-head' }, h('span', { class: 'tile-icon' }, icon(iconName, { size: 16 })), h('span', { class: 'tile-label' }, label)),
      value, extra || null, sub);
    return { el, value, sub };
  }
  function setUnits(el, str) {
    const key = `u:${str}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...splitUnits(str).map((p) => (p.num
      ? h('span', { class: 'num' }, p.num)
      : h('span', { class: 'unit' }, p.unit))));
  }

  const tBreaks = tile('checkCircle', t('tile_breaks'));
  tBreaks.el.dataset.tone = 'break';
  const tScreen = tile('monitor', t('tile_screen'));

  const waterSegs = h('div', { class: 'water-segs', 'aria-hidden': 'true' });
  const waterMinus = h('button', { type: 'button', class: 'btn btn-icon btn-round', 'aria-label': t('water_undo'), title: t('water_undo'), onClick: act('undo-drink') },
    icon('minus', { size: 16 }));
  const waterPlus = h('button', { type: 'button', class: 'btn btn-icon btn-round btn-water', 'aria-label': t('water_add'), title: t('water_add'), onClick: act('drink', undefined, 'toast_drink') },
    icon('plus', { size: 16 }));
  const tWater = tile('droplet', t('tile_water'), waterSegs);
  tWater.el.classList.add('tile-water');
  tWater.el.dataset.tone = 'water';
  tWater.el.append(h('div', { class: 'water-btns' }, waterMinus, waterPlus));

  const quoteRing = h('span', { class: 'quote-ring', 'aria-hidden': 'true' });
  const tQuote = tile('percent', t('tile_quote'));
  tQuote.el.classList.add('tile-quote');
  tQuote.el.append(quoteRing);

  const tiles = h('section', { class: 'tiles', 'aria-label': t('today_label') }, tBreaks.el, tScreen.el, tWater.el, tQuote.el);

  // ---- tip of the day ------------------------------------------------------------
  const dayIndex = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const tipText = h('p', { class: 'tip-text' });
  const tipCount = h('span', { class: 'tip-count tabular' });
  const tipBody = h('div', { class: 'tip-body' }, tipText);
  let tipTimer = null;
  function tipIndex() {
    return (((dayIndex + ctx.ui.tipOffset) % TIP_COUNT) + TIP_COUNT) % TIP_COUNT;
  }
  function renderTip(animate) {
    const idx = tipIndex();
    setText(tipCount, `${idx + 1}/${TIP_COUNT}`);
    if (animate) {
      tipBody.classList.remove('is-swap');
      void tipBody.offsetWidth;
      tipBody.classList.add('is-swap');
    }
    setText(tipText, t(`tip_${idx}`));
  }
  function stepTip(delta) {
    ctx.ui.tipOffset += delta;
    renderTip(true);
    restartTipTimer();
  }
  function restartTipTimer() {
    clearInterval(tipTimer);
    tipTimer = setInterval(() => {
      if (!document.hidden) stepTip(1);
    }, TIP_ROTATE_MS);
  }
  const tipCard = h('section', { class: 'card tip-card' },
    h('span', { class: 'icon-tile icon-tile-tip' }, icon('bulb', { size: 18 })),
    h('div', { class: 'tip-main' },
      h('div', { class: 'tip-kicker' }, t('tip_title')),
      tipBody),
    h('div', { class: 'tip-nav' },
      h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': t('tip_prev'), onClick: () => stepTip(-1) }, icon('chevronLeft', { size: 16 })),
      tipCount,
      h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': t('tip_next'), onClick: () => stepTip(1) }, icon('chevronRight', { size: 16 }))));
  renderTip(false);

  // ---- update hint (§12) – slim, dismissible for the session ---------------------
  const updateHint = createUpdateHint(ctx);

  const el = h('div', { class: 'view view-overview' }, header.el, updateHint.el, hero, tiles, tipCard);

  // ---- updates ----------------------------------------------------------------
  let lastTone = '';
  let lastCycleKey = '';
  let lastWaterSegKey = '';

  function renderCycleDots(state) {
    const c = cycleInfo(state);
    const key = `${c.every}:${c.index}:${c.nextIsLong}:${c.enabled}`;
    if (key === lastCycleKey) return;
    lastCycleKey = key;
    cycleDots.replaceChildren(...Array.from({ length: c.every }, (_, i) => h('span', {
      class: ['cycle-dot', i < c.index && 'is-done', i === c.index && 'is-next', i === c.every - 1 && 'is-long'],
    })));
  }

  function snoozeDetail(state) {
    const left = Math.max(0, state.snooze.max - state.snooze.count);
    if (state.phase === 'break' && state.break.inGrace) return t('snooze_grace_any');
    if (isMandatoryBreak(state)) return t('snooze_strict');
    if (state.snooze.max === 0) return t('snooze_disabled');
    if (state.snooze.count > 0) return t('snooze_used', { count: state.snooze.count, left });
    return left > 0 ? t('snooze_left', { n: left }) : t('snooze_none_left');
  }

  function updateHero(state) {
    const tone = toneOf(state);
    const s = ctx.settings;
    if (tone !== lastTone) {
      lastTone = tone;
      setAttr(hero, 'data-tone', tone);
    }
    const cd = countdownOf(state, { warnMs: s.timer.warnBeforeSeconds * 1000 });
    ring.set(cd.fraction);
    setText(chipText, t(phaseLabelKey(state)));
    meetingChip.hidden = !(state.meeting.active && tone !== 'meeting');

    const breakType = state.break.type === 'long' ? 'long' : 'short';
    const breakName = t(`break_${breakType}_lc`);
    const breakDur = formatDuration(state.break.durationMs, lang);
    const inBreak = tone === 'break';
    const mandatory = isMandatoryBreak(state); // Pflicht-Pause: nothing here can end or postpone it (§11)
    const workLike = tone === 'work' || tone === 'warning' || tone === 'meeting';
    const c = cycleInfo(state);

    // centre
    let centerText = cd.text;
    let centerLabel = '';
    let centerIconName = null;
    switch (tone) {
      case 'work': centerLabel = t('center_until_break'); break;
      case 'warning': centerLabel = t('center_break_soon'); break;
      case 'break': centerLabel = t('center_remaining'); break;
      case 'meeting': centerLabel = t('center_in_meeting'); centerIconName = 'video'; break;
      case 'paused': centerLabel = state.pause.until ? t('center_until_resume') : t('center_indefinite'); centerIconName = state.pause.until ? null : 'pause'; break;
      case 'away':
        centerText = formatClock(state.work.remainingMs);
        centerLabel = t('center_frozen');
        break;
      default: {
        const next = nextWorkStart(s.schedule, new Date(state.now));
        centerText = next ? formatTimeOfDay(next.getTime(), lang) : '—';
        centerLabel = t('center_next_start');
        centerIconName = 'moon';
      }
    }
    if (centerIconName !== centerIcon.dataset.icon) {
      centerIcon.dataset.icon = centerIconName || '';
      centerIcon.hidden = !centerIconName;
      centerIcon.replaceChildren(...(centerIconName ? [icon(centerIconName, { size: 20 })] : []));
    }
    toggleClass(countdown, 'is-symbol', centerText === '∞');
    toggleClass(countdown, 'is-long', centerText.length > 5);
    setText(countdown, centerText);
    setText(countdownLabel, centerLabel);
    setAttr(countdown, 'aria-label', `${centerText} ${centerLabel}`);

    // title + details
    let titleText = '';
    let l1 = '';
    let l1Icon = 'clock';
    let l2 = '';
    let l3 = '';
    let noticeArgs = [null, null, ''];
    switch (tone) {
      case 'work':
      case 'warning':
        titleText = t('title_next', { type: breakName, duration: breakDur });
        l1 = state.work.endsAt ? t('detail_starts_at', { time: formatTimeOfDay(state.work.endsAt, lang) }) : '';
        l2 = c.enabled ? (c.nextIsLong ? t('detail_this_long') : plural(t, 'detail_long_in', c.shortBeforeLong)) : '';
        l3 = snoozeDetail(state);
        break;
      case 'meeting':
        titleText = t('title_meeting');
        l1 = state.meeting.since ? t('detail_meeting_since', { time: formatTimeOfDay(state.meeting.since, lang) }) : '';
        l1Icon = 'video';
        l2 = t('detail_meeting_after', { type: breakName, duration: breakDur });
        break;
      case 'break':
        titleText = t(breakType === 'long' ? 'title_break_long' : 'title_break_short');
        l1 = state.break.endsAt ? t('detail_ends_at', { time: formatTimeOfDay(state.break.endsAt, lang) }) : '';
        l3 = state.break.inGrace ? '' : snoozeDetail(state);
        if (state.break.inGrace) {
          const graceLeft = state.break.graceUntil ? Math.max(0, Math.ceil((state.break.graceUntil - state.now) / 1000)) : 0;
          noticeArgs = ['grace', 'hourglass', t('notice_grace', { s: graceLeft })];
        } else if (mandatory || !state.break.canSkip) {
          noticeArgs = ['strict', 'lock', t('notice_strict')];
        }
        break;
      case 'paused':
        titleText = t('title_paused');
        if (state.pause.until) {
          const until = new Date(state.pause.until);
          const sameDay = until.toDateString() === new Date(state.now).toDateString();
          l1 = sameDay
            ? t('detail_paused_until', { time: formatTimeOfDay(state.pause.until, lang) })
            : t('detail_paused_until_day', { day: until.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { weekday: 'short' }), time: formatTimeOfDay(state.pause.until, lang) });
        } else {
          l1 = t('detail_paused_indefinite');
        }
        l2 = t('detail_paused_hint');
        break;
      case 'away':
        titleText = t('title_away');
        l1 = state.away.since ? t('detail_away_since', { time: formatTimeOfDay(state.away.since, lang) }) : '';
        l1Icon = 'away';
        l2 = t('detail_away_rule', { duration: formatMinutes(s.idle.resetAfterMinutes, lang) });
        break;
      default: {
        titleText = t('title_off_hours');
        l1 = t('detail_hours', { days: fmtDays(s.schedule.days, t), start: s.schedule.start, end: s.schedule.end });
        l1Icon = 'calendar';
        const next = nextWorkStart(s.schedule, new Date(state.now));
        l2 = next ? t('detail_next_start', {
          day: next.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long' }),
          time: formatTimeOfDay(next.getTime(), lang),
        }) : '';
      }
    }
    setText(title, titleText);
    d1.set(l1, l1Icon);
    d2.set(l2, tone === 'paused' ? 'bulb' : tone === 'away' ? 'bulb' : tone === 'off-hours' ? 'sunrise' : tone === 'meeting' ? 'clock' : 'layers');
    toggleClass(cycleDots, 'is-hidden', !(workLike && tone !== 'meeting' && c.enabled));
    if (workLike) renderCycleDots(state);
    d3.set(l3, 'snooze');
    setNotice(...noticeArgs);

    // actions visibility
    btnResume.hidden = tone !== 'paused';
    btnBreak.hidden = inBreak || tone === 'off-hours';
    toggleClass(btnBreak, 'btn-primary', tone !== 'paused');
    btnEndBreak.hidden = !(inBreak && state.break.canSkip);
    snoozeSplit.hidden = !(workLike || inBreak);
    const canSnooze = Boolean(state.break.canSnooze);
    snoozeMain.disabled = !canSnooze;
    snoozeMore.disabled = !canSnooze;
    setText(snoozeMeta, `+${formatMinutes(s.timer.snoozeMinutes, lang)}`);
    setAttr(snoozeSplit, 'title', canSnooze ? snoozeDetail(state) : t('snooze_none_left'));
    btnSkip.hidden = !workLike;
    btnSchedule.hidden = tone !== 'off-hours';
    // a Pflicht-Pause cannot be postponed any more, so the meeting shortcut would only fail
    btnMeetingHost.hidden = tone === 'paused' || tone === 'off-hours' || mandatory;
    btnPauseHost.hidden = !(workLike || tone === 'away');
    btnReset.hidden = !(workLike || tone === 'away');
    secondaryRow.hidden = btnMeetingHost.hidden && btnPauseHost.hidden && btnReset.hidden;
    if (tone === 'off-hours') btnBreak.hidden = true;
  }

  function updateTiles(state) {
    const today = state.today || {};
    const day = ctx.today || {};
    const completed = Number(today.breaksCompleted) || 0;
    const skipped = Number(today.breaksSkipped) || 0;

    setText(tBreaks.value, String(completed));
    const natural = Number(day.naturalBreaks) || 0;
    setText(tBreaks.sub, [plural(t, 'sub_skipped', skipped), natural ? plural(t, 'sub_natural', natural) : null].filter(Boolean).join(' · '));

    setUnits(tScreen.value, formatDuration((Number(today.workSeconds) || 0) * 1000, lang));
    const breakSec = Number(day.breakSeconds) || 0;
    setText(tScreen.sub, breakSec > 0 ? t('sub_break_time', { duration: formatDuration(breakSec * 1000, lang) }) : t('sub_screen_hint'));

    const hyd = state.hydration;
    const glasses = Number(today.glasses ?? hyd.glassesToday) || 0;
    const goal = Math.max(1, Number(hyd.goal) || ctx.settings.hydration.dailyGoalGlasses);
    const waterKey = `${glasses}/${goal}`;
    if (waterKey !== lastWaterSegKey) {
      lastWaterSegKey = waterKey;
      tWater.value.replaceChildren(h('span', { class: 'num' }, String(glasses)), h('span', { class: 'unit' }, `/ ${goal}`));
      if (goal <= 16) {
        waterSegs.classList.remove('is-bar');
        waterSegs.replaceChildren(...Array.from({ length: goal }, (_, i) => h('span', { class: ['water-seg', i < glasses && 'is-full'] })));
      } else {
        waterSegs.classList.add('is-bar');
        const fill = h('span', { class: 'water-bar-fill' });
        fill.style.setProperty('--p', String(Math.min(1, glasses / goal)));
        waterSegs.replaceChildren(fill);
      }
      toggleClass(tWater.el, 'is-goal', glasses >= goal);
    }
    waterMinus.disabled = glasses <= 0;
    const ml = ctx.settings.hydration.glassMl;
    let waterSub = t('sub_water_ml', { ml: fmtMl(glasses * ml, lang), goal: fmtMl(goal * ml, lang) });
    if (hyd.due) {
      waterSub = t('water_due');
    } else if (hyd.enabled && hyd.nextAt && state.phase !== 'paused') {
      waterSub = t('sub_water_next', { duration: formatDuration(Math.max(60000, hyd.remainingMs), lang) });
    } else if (glasses >= goal) {
      waterSub = t('sub_water_goal');
    }
    setText(tWater.sub, waterSub);
    toggleClass(tWater.el, 'is-due', Boolean(hyd.due));

    const total = completed + skipped;
    if (total === 0) {
      setText(tQuote.value, '—');
      setText(tQuote.sub, t('sub_quote_empty'));
      setStyleVar(quoteRing, '--p', '0');
    } else {
      setUnits(tQuote.value, fmtPercent(completed / total, lang).replace(/\s*%/, ' %'));
      setText(tQuote.sub, t('sub_quote', { done: completed, total }));
      setStyleVar(quoteRing, '--p', (completed / total).toFixed(3));
    }
  }

  function onState(state) {
    if (!state) return;
    updateHero(state);
    updateTiles(state);
    updateHeader();
  }

  return {
    el,
    onShow() {
      restartTipTimer();
      onState(ctx.state);
      updateHint.render(ctx.update);
      ctx.pollUpdate(1);
    },
    onHide() {
      clearInterval(tipTimer);
    },
    onState,
    onUpdate(update) {
      updateHint.render(update);
    },
    onSettings() {
      lastWaterSegKey = '';
      onState(ctx.state);
    },
    onStats() {
      if (ctx.state) updateTiles(ctx.state);
    },
    destroy() {
      clearInterval(tipTimer);
    },
  };
}
