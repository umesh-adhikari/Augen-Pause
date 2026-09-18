// Pointer handling for the widget: hover detection, click-through, drag, click and context menu.
// Main forwards mouse moves while the window ignores mouse events, so pointermove keeps arriving
// over transparent areas and we can switch interactivity on/off precisely.

const DRAG_THRESHOLD = 4; // px – below this a press is a click
const HIDE_DELAY = 600; // ms after the pointer left clock + pill

/**
 * @param {object} opts
 * @param {object} opts.api window.augenpause (or fallback)
 * @param {HTMLElement} opts.clock circular clock element
 * @param {{ element: HTMLElement, isVisible: () => boolean }} opts.pill
 * @param {(hovered: boolean) => void} opts.onHoverChange
 * @param {() => void} opts.onClick left click on the clock (no drag)
 */
export function setupPointer({ api, clock, pill, onHoverChange, onClick }) {
  let interactive = null;
  let hovered = false;
  let hideTimer = 0;
  let pos = null; // last pointer position in client coords, null = outside window
  let drag = null;

  function setInteractive(value) {
    if (value === interactive) return;
    interactive = value;
    try { api.setWidgetInteractive(value); } catch { /* bridge gone */ }
  }

  function overClock(x, y) {
    const r = clock.getBoundingClientRect();
    const radius = r.width / 2;
    return Math.hypot(x - (r.left + radius), y - (r.top + r.height / 2)) <= radius;
  }

  function overPill(x, y) {
    if (!pill.isVisible()) return false;
    const r = pill.element.getBoundingClientRect();
    return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
  }

  function setHovered(value) {
    if (value === hovered) return;
    hovered = value;
    onHoverChange(value);
  }

  function evaluate() {
    const inside = Boolean(drag) || (pos !== null && (overClock(pos.x, pos.y) || overPill(pos.x, pos.y)));
    setInteractive(inside);
    if (inside) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      setHovered(true);
    } else if (hovered && !hideTimer) {
      hideTimer = setTimeout(() => {
        hideTimer = 0;
        setHovered(false);
        evaluate();
      }, HIDE_DELAY);
    }
  }

  document.addEventListener('pointermove', (e) => {
    pos = { x: e.clientX, y: e.clientY };
    evaluate();
  }, { passive: true });

  const leave = () => {
    if (drag) return;
    pos = null;
    evaluate();
  };
  document.documentElement.addEventListener('pointerleave', leave);
  document.documentElement.addEventListener('mouseleave', leave);

  // ----- drag / click on the clock -----
  clock.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    if (!overClock(e.clientX, e.clientY)) return;
    e.preventDefault();
    // client coords are exact for the threshold: the window only moves after the first widgetDrag('move')
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, raf: 0 };
    try { clock.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    api.widgetDrag('start');
  });

  clock.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !clock.hasPointerCapture(e.pointerId)) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      clock.classList.add('is-dragging');
    }
    if (!drag.raf) {
      const current = drag;
      current.raf = requestAnimationFrame(() => {
        current.raf = 0;
        if (drag === current) api.widgetDrag('move');
      });
    }
  });

  function endDrag(e, cancelled) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const done = drag;
    drag = null;
    if (done.raf) cancelAnimationFrame(done.raf);
    clock.classList.remove('is-dragging');
    if (clock.hasPointerCapture(done.id)) {
      try { clock.releasePointerCapture(done.id); } catch { /* ignore */ }
    }
    api.widgetDrag('end');
    if (!done.moved && !cancelled) onClick();
    if (e) pos = { x: e.clientX, y: e.clientY };
    evaluate();
  }

  clock.addEventListener('pointerup', (e) => endDrag(e, false));
  clock.addEventListener('pointercancel', (e) => endDrag(e, true));
  clock.addEventListener('lostpointercapture', (e) => endDrag(e, true));

  // ----- keyboard on the clock -----
  clock.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });

  // ----- context menu (native, from main) -----
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = e.target instanceof Node ? e.target : null;
    // mouse: target under the cursor; keyboard (Menu key / Shift+F10): the focused clock or pill button
    if (target && (clock.contains(target) || pill.element.contains(target))) api.showContextMenu();
  });

  setInteractive(false);

  return {
    /** Re-run hit testing (e.g. after the pill appeared/disappeared under a resting pointer). */
    refresh: evaluate,
    isHovered: () => hovered,
  };
}
