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

import { hudPx } from './ui-scale.js';

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
  // `offset*` is already in the HUD's own pixels, which is the space an inline
  // `left` is written in — so these two are the ones that do NOT convert. The
  // pointer and the window do, below. See client/ui-scale.js.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // Set explicitly, because not everything draggable was already taking itself
  // out of the flow. `#panel` is `.hud` and has always been fixed, so this is a
  // no-op for it; the demand meter is a plain child of the top-left column and
  // would otherwise take `left`/`top` as static offsets and not move at all.
  el.style.position = 'fixed';
  // `x`/`y` arrive from a pointer or a rect and the window is the window, so all
  // four are viewport pixels being written into a HUD that may be drawn smaller
  // than one. Unconverted the panel trails the cursor by a growing fraction of
  // how far it is from the top-left corner — which reads as the drag being laggy
  // rather than as a scale.
  const vw = hudPx(innerWidth);
  const vh = hudPx(innerHeight);
  el.style.left = `${Math.max(8, Math.min(hudPx(x), vw - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(hudPx(y), vh - h - 8))}px`;
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
    // A RELEASE WE NEVER SAW, and this is the one drag in the game where that
    // is visible as a bug rather than merely felt: the panel stays welded to
    // the pointer, and `restorePos` bows out for as long as `drag` is set, so
    // every menu opened afterwards comes up wherever the last one was left.
    // Capture normally guarantees the pointerup, and capture is taken away by
    // things that are none of this file's business — see `healLostPress` in
    // client/main.js, which is the same repair for the drags on the world.
    if (e.buttons === 0) { end(e); return; }
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
  // The moment the handle stops being told anything is the last moment this
  // drag can be ended honestly. After an ordinary release it fires with `drag`
  // already null and does nothing, which is what makes it safe to add.
  handle.addEventListener('lostpointercapture', end);

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
    // A widget that has been put away (client/corner.js) measures 0×0, and
    // clamping against that files it hard against the right-hand edge for
    // whenever it is brought back — a resize with nothing on screen moving it.
    if (!el.offsetWidth) return;
    const r = el.getBoundingClientRect();
    place(el, r.left, r.top);
  });
}
