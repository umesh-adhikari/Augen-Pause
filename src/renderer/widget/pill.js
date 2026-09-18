// Action pill below the clock: hover quick actions, warning (snooze-first) and break variants.

const $ = (id) => document.getElementById(id);

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setLabel(node, text) {
  if (node.title !== text) node.title = text;
  if (node.getAttribute('aria-label') !== text) node.setAttribute('aria-label', text);
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setDisabled(node, disabled) {
  if (node.disabled !== disabled) node.disabled = disabled;
}

/** Second snooze option: the next "bigger" step after the configured default. */
function secondSnooze(first) {
  if (first < 15) return 15;
  if (first < 30) return 30;
  return 60;
}

/**
 * @param {{ api: object, forceVisible?: boolean, onVisibilityChange?: (visible: boolean) => void }} opts
 */
export function createPill({ api, forceVisible = false, onVisibilityChange }) {
  const pill = $('pill');
  const views = { actions: $('pvActions'), warning: $('pvWarning'), break: $('pvBreak') };
  const b = {
    breakNow: $('btnBreak'),
    pause: $('btnPause'),
    drink: $('btnDrink'),
    dash: $('btnDash'),
    snoozeA: $('btnSnoozeA'),
    snoozeB: $('btnSnoozeB'),
    now: $('btnNow'),
    breakSnooze: $('btnBreakSnooze'),
    end: $('btnEnd'),
  };
  const drinkBadge = $('drinkBadge');
  const warnLabel = $('warnLabel');
  const warnTime = $('warnTime');
  const breakLabel = $('breakLabel');
  const breakTime = $('breakTime');
  const strictLock = $('strictLock');

  let hovered = false;
  let focused = false;
  let auto = false;
  let visible = false;
  let variant = 'actions';
  let paused = false;
  let snoozeA = 5;
  let snoozeB = 15;

  const run = (name, arg) => {
    Promise.resolve()
      .then(() => (arg === undefined ? api.action(name) : api.action(name, arg)))
      .catch(() => {});
  };

  b.breakNow.addEventListener('click', () => run('break-now'));
  b.pause.addEventListener('click', () => (paused ? run('resume') : run('pause', null)));
  b.drink.addEventListener('click', () => run('drink'));
  b.dash.addEventListener('click', () => run('toggle-dashboard'));
  b.snoozeA.addEventListener('click', () => run('snooze', snoozeA));
  b.snoozeB.addEventListener('click', () => run('snooze', snoozeB));
  b.breakSnooze.addEventListener('click', () => run('snooze', snoozeA));
  b.now.addEventListener('click', () => run('break-now'));
  b.end.addEventListener('click', () => run('skip-break'));

  function applyVisibility() {
    const next = forceVisible || auto || hovered || focused;
    if (next === visible) return;
    visible = next;
    pill.classList.toggle('is-visible', visible);
    if (!visible && pill.contains(document.activeElement)) document.activeElement.blur();
    if (onVisibilityChange) onVisibilityChange(visible);
  }

  /**
   * @param {object} p
   * @param {object} p.state normalized SchedulerState
   * @param {string} p.mode visual mode
   * @param {object} p.settings normalized settings
   * @param {Function} p.t translate
   * @param {string} p.warnText countdown for the warning variant
   * @param {string} p.breakText countdown for the break variant
   */
  function update({ state, mode, settings, t, warnText, breakText }) {
    const nextVariant = mode === 'break' ? 'break' : mode === 'warning' ? 'warning' : 'actions';
    if (nextVariant !== variant) {
      variant = nextVariant;
      pill.dataset.variant = variant;
    }
    for (const key of Object.keys(views)) setHidden(views[key], key !== variant);
    auto = variant === 'warning' || (variant === 'break' && !state.break.lockScreen);
    setLabel(pill, t('actionsLabel'));

    const first = Math.min(60, Math.max(1, Math.round(Number(settings.timer.snoozeMinutes) || 5)));
    snoozeA = first;
    snoozeB = secondSnooze(first);
    // Pflicht-Pause: a running break ends only by timeout (state.break.strict is captured at break start)
    const strictBreak = variant === 'break'
      && (state.break.strict === true || (state.break.canSkip === false && state.break.canSnooze === false));
    const canSnooze = !strictBreak && Boolean(state.break.canSnooze);

    if (variant === 'actions') {
      setLabel(b.breakNow, t('breakNow'));
      paused = state.phase === 'paused';
      b.pause.classList.toggle('is-paused', paused);
      setLabel(b.pause, t(paused ? 'resume' : 'pause'));
      const h = state.hydration;
      setHidden(b.drink, !h.enabled);
      if (h.enabled) {
        setText(drinkBadge, t('drinkBadge', { count: h.glassesToday, goal: h.goal }));
        setLabel(b.drink, t('drink'));
      }
      setLabel(b.dash, t('dashboard'));
    } else if (variant === 'warning') {
      setText(warnLabel, t('warnIn'));
      setText(warnTime, warnText);
      for (const [btn, min] of [[b.snoozeA, snoozeA], [b.snoozeB, snoozeB]]) {
        setText(btn, t('snooze', { min }));
        setDisabled(btn, !canSnooze);
        setLabel(btn, canSnooze ? t('snoozeTitle', { min }) : t('snoozeDisabledTitle'));
      }
      setText(b.now, t('warnNow'));
      setLabel(b.now, t('warnNowTitle'));
    } else {
      setText(breakLabel, t(state.break.type === 'long' ? 'breakPillLong' : 'breakPill'));
      setText(breakTime, breakText);
      setHidden(b.breakSnooze, !canSnooze);
      views.break.classList.toggle('has-snooze', canSnooze);
      views.break.classList.toggle('is-strict', strictBreak);
      b.breakSnooze.classList.toggle('is-prominent', canSnooze && Boolean(state.break.inGrace));
      if (canSnooze) {
        setText(b.breakSnooze, t('snooze', { min: snoozeA }));
        setLabel(b.breakSnooze, t('snoozeTitle', { min: snoozeA }));
      }
      const canSkip = !strictBreak && Boolean(state.break.canSkip);
      setHidden(b.end, !canSkip);
      // lock glyph whenever the break cannot be ended here (always for a Pflicht-Pause)
      setHidden(strictLock, canSkip);
      if (canSkip) {
        setText(b.end, t('endBreak'));
        setLabel(b.end, t('endBreakTitle'));
      } else {
        setLabel(strictLock, t(strictBreak ? 'strictTitle' : 'lockedTitle'));
      }
    }
    applyVisibility();
  }

  return {
    element: pill,
    update,
    isVisible: () => visible,
    setHovered(value) {
      hovered = Boolean(value);
      applyVisibility();
    },
    setFocused(value) {
      focused = Boolean(value);
      applyVisibility();
    },
  };
}
