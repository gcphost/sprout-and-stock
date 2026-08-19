/**
 * A SCROLLER YOU DRAG, and a mark at whichever end has more past it.
 *
 * A game does not get the operating system's scrollbar, and the thin one this
 * replaces was still a bar of chrome doing two jobs badly at once: "is there
 * more this way" and "take me there". They are split now — the ends of the box
 * say whether there is more (a fade, or an arrow the bar puts over it), and
 * getting there is the drag, which is the gesture the world behind the HUD
 * already answers to.
 *
 * One function for both axes because the bottom bar and every panel list want
 * exactly the same thing, and the three traps below are ones you only find
 * once. Callers style the marks themselves off `more-back` / `more-on`: the
 * bar fades a wrapper and lights an arrow, a panel masks its own top and
 * bottom, and neither shape belongs in here.
 *
 * The drag's move and up listeners go on the WINDOW rather than on a captured
 * pointer. `setPointerCapture` retargets every subsequent event at the
 * scroller, so a child's own `pointermove`/`pointerup` — which is what cancels
 * the bar's hold-for-shapes timer — would never fire, and pulling the row along
 * would open a popover 400ms in. On the window they still bubble past it.
 *
 * A drag ends in a `click` on whatever it let go over, and that click would arm
 * a shelf or open a menu nobody asked for. It is swallowed in the CAPTURE
 * phase, before the child's own handler, and the flag is cleared on the next
 * `pointerdown` rather than on a timer — a click always follows a press, so
 * that ordering is guaranteed where a `setTimeout(0)` race is not.
 *
 * And the wiring happens ONCE per element (`data-scrolled`) while the ends are
 * re-read every call, because every caller here rewrites its contents wholesale
 * and often: the box survives, its listeners survive with it, and what changes
 * is how far it can go.
 *
 * The wheel is a SIDEWAYS box's problem only. A vertical list is an ordinary
 * scroll container and the browser already spins it — handling it here would
 * move it twice per notch — but a mouse reports a notch as `deltaY` whatever the
 * box under it does, so a horizontal strip is the one shape where turning the
 * wheel over a scroller does nothing at all, and reads as the row being stuck.
 * Three things about that. The delta is normalised by `deltaMode` first, because
 * Firefox reports a notch as 3 *lines* and scrolling three pixels is
 * indistinguishable from the bug; the dominant axis wins, so a trackpad's own
 * sideways swipe drives it rather than fighting the `deltaY` branch; and a wheel
 * at either END is left alone — no `preventDefault`, so the notch goes on to
 * whatever is behind the strip instead of being swallowed by a row that had
 * nowhere left to go.
 */
export function wireScroll(box, { axis = 'x', ends } = {}) {
  if (!box) return;
  const horiz = axis === 'x';
  const at = () => (horiz ? box.scrollLeft : box.scrollTop);

  const mark = () => {
    const max = horiz
      ? box.scrollWidth - box.clientWidth
      : box.scrollHeight - box.clientHeight;
    // A couple of pixels of slack at each end: sub-pixel sizes mean the scroll
    // offset can land a fraction short of `max`, which would leave a fade up
    // over nothing to scroll to.
    const back = at() > 2;
    const on = at() < max - 2;
    box.classList.toggle('more-back', back);
    box.classList.toggle('more-on', on);
    ends?.(back, on);
  };

  if (!box.dataset.scrolled) {
    box.dataset.scrolled = '1';
    let dragged = false;
    box.addEventListener('pointerdown', (e) => {
      dragged = false;
      // Touch and pen already flick it natively, and a second scroll on top of
      // that one is a list that moves twice as fast as your finger.
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const from = horiz ? e.clientX : e.clientY;
      const was = at();
      const move = (ev) => {
        const d = (horiz ? ev.clientX : ev.clientY) - from;
        // The same 8px the bar's hold timer treats as "this is a drag, not a
        // press", so one gesture is never both.
        if (!dragged && Math.abs(d) < 8) return;
        dragged = true;
        if (horiz) box.scrollLeft = was - d;
        else box.scrollTop = was - d;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    if (horiz) box.addEventListener('wheel', (e) => {
      // Pixels, lines, pages — the same three modes `main.js` normalises for the
      // zoom, in the unit this box measures itself in.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientWidth : 1;
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      if (!d) return;
      const max = box.scrollWidth - box.clientWidth;
      const to = Math.max(0, Math.min(max, box.scrollLeft + d));
      if (to === box.scrollLeft) return;
      e.preventDefault();
      box.scrollLeft = to;
    }, { passive: false });
    box.addEventListener('click', (e) => {
      if (!dragged) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    box.addEventListener('scroll', mark, { passive: true });
    window.addEventListener('resize', mark);
  }

  mark();
}
