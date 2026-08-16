/**
 * DRAGGING THE PANEL, AND REMEMBERING WHERE YOU PUT IT.
 *
 * There is one `#panel` element and half a dozen menus that render into it, so
 * "remember where I put it" has to mean *per menu*: the supplier opens where you
 * last left the supplier, a hire opens where you last left a hire. One shared
 * position would be a panel that jumps every time you opened a different menu
 * and looked like it had forgotten.
 *
 * The position is stored by `openPanel` id in localStorage, so it survives a
 * reload — the point of moving a menu is that it was covering something you
 * wanted to watch, and that is still true tomorrow.
 *
 * Default is no stored position at all, which leaves the CSS anchoring alone
 * (bottom-centre, above the bar). Dragging switches the element to explicit
 * `left`/`top`; double-clicking the header throws that away and gives the
 * anchoring back, which is the way out for a panel dragged somewhere silly.
 */

const STORE = 'sns-panel-pos';

/** localStorage is a hostile environment: private mode, quota, a stale value. */
function saved() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
function store(map) {
  try { localStorage.setItem(STORE, JSON.stringify(map)); } catch { /* not worth a toast */ }
}

/** A drag in flight, module-wide, so a repaint can tell not to fight it. */
let drag = null;

/**
 * Pin the panel at a screen position, clamped so it can never be dropped where
 * you cannot reach it back. Clearing `bottom` and `transform` is what takes it
 * out of the CSS anchoring — leaving either would fight the `top` we just set.
 */
function place(el, x, y) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // Set explicitly, because not everything draggable was already taking itself
  // out of the flow. `#panel` is `.hud` and has always been fixed, so this is a
  // no-op for it; the demand meter is a plain child of the top-left column and
  // would otherwise take `left`/`top` as static offsets and not move at all.
  el.style.position = 'fixed';
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  el.style.bottom = 'auto';
  el.style.transform = 'none';
}

/**
 * Back to wherever the stylesheet says this thing lives.
 *
 * Clearing `position` too is what makes the reset honest for something that
 * lived in a flow column: it goes back INTO the column, under whatever is above
 * it, rather than staying fixed at the last place the stylesheet's own left/top
 * happened to put it.
 */
export function clearPos(el) {
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.bottom = '';
  el.style.transform = '';
}

/**
 * Put the panel where this menu was last left.
 *
 * Called from `showPanel`, which for a fixture or a hire runs again every time
 * the snapshot moves — hence the guard: re-applying a stored position mid-drag
 * would drop the panel back under the cursor ten times a second.
 */
export function restorePos(el, id) {
  if (drag) return;
  const at = id ? saved()[id] : null;
  if (at) place(el, at.x, at.y);
  else clearPos(el);
}

/**
 * Make `handle` drag `el`. `idOf()` says which menu is open at the moment the
 * drag ends, because that is what the position gets filed under.
 */
export function wireDrag(el, handle, idOf) {
  handle.addEventListener('pointerdown', (e) => {
    // The close button lives in this bar and is not a place to grab it by.
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.moved = true;
    place(el, e.clientX - drag.dx, e.clientY - drag.dy);
  });

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    // A press that never moved is not a reposition, and filing one would pin
    // the panel at wherever it happened to be the first time you touched it.
    if (!moved) return;
    const id = idOf();
    if (!id) return;
    const r = el.getBoundingClientRect();
    const map = saved();
    map[id] = { x: Math.round(r.left), y: Math.round(r.top) };
    store(map);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  handle.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    clearPos(el);
    const id = idOf();
    if (!id) return;
    const map = saved();
    delete map[id];
    store(map);
  });

  // A window that got smaller must not leave a panel half off the edge. Only
  // one that has actually been placed — an anchored panel is the stylesheet's
  // problem and pinning it here would quietly make every panel dragged.
  addEventListener('resize', () => {
    if (!el.style.left) return;
    const r = el.getBoundingClientRect();
    place(el, r.left, r.top);
  });
}
