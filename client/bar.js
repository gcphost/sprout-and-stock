/**
 * THE BOTTOM BAR — one tiered picker, two things picking with it.
 *
 * Build wanted tabs because its palette is a database anyone can add to; the
 * roster wanted the same thing about ten minutes later, for the same reason —
 * five hires is a list and twenty is a problem, and both were already solved
 * once. So the shape moved here and the two callers describe their contents
 * rather than drawing them.
 *
 * Five tiers and only TWO rows, because the first three share one and the last
 * is not in the bar at all:
 *
 *   groups   what sort of thing        — tabs
 *   subs     which part of that        — quieter chips beside them, when a tab has any
 *   caption  what one entry is called  — the far end of that same row
 *   items    that tab's entries        — scrolls sideways, 1–9 reach the first nine
 *   choice   a choice about the picked entry — a card floating over its tile
 *
 * The caption is where a build entry's NAME lives, because the tiles stopped
 * carrying it: a strip of pictures is a row of *things*, and a name is long,
 * ragged and only ever a question about the one under the pointer or the one you
 * have armed. Its price stayed on it — that is four characters and it is the
 * comparison you are actually making. So this file answers hover directly
 * (`setCaption` on `mouseenter`, back to the resting caption on the way out)
 * rather than calling back: a caller that had to re-render the whole bar to name
 * a button would repaint it on every pixel of mouse movement.
 *
 * A caller supplies data and callbacks and never touches the DOM, which is what
 * lets the number keys, the tab cycling, the scroll-the-selection-into-view and
 * the height measurement be written once instead of twice.
 *
 * A sub-tab is the same shape as a tab and is drawn by the same code, because it
 * is the same question asked once more — Building grew a catalogue of floors and
 * a yard on top of the walls it started with, and a tab you have to scroll is a
 * tab whose far end nobody knows exists. What a group does *not* get is a third
 * level: two is the depth at which you can still see where you are.
 *
 * Shapes:
 *   group   = { id, name, icon, blurb, items: [item], subs?: [group] }
 *   item    = { id, icon, art, name, note, badge, title, warn, last }
 *   choice  = { options: [{ id, name, art }], picked, open, onPick } | null
 *   caption = string | null
 *
 * `art` is a picture of the thing itself where one can be drawn (see
 * `client/thumb.js`) and `icon` the glyph to fall back on. Two fields rather
 * than one because they are not the same size or the same claim: a glyph is a
 * category and art is *that shelf*, so the button that has art gets more room
 * for it and one that doesn't must not be sized as though it did.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** How many entries wear a number. That is how many number keys there are. */
export const KEYED = 9;

/** How long a press on a tile has to last to be asking for its shapes. */
const HOLD_MS = 400;

/**
 * Entries a caller wants pinned to the end of every tab they appear on —
 * Demolish. A stable sort, so everything else keeps the order it was
 * given; without it a pinned entry lands wherever the source list happened to
 * put it, which on some tabs is slot one, under the 1 key.
 */
export const pinLast = (items) => [...items]
  .sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));

/**
 * The tab to draw, resolved against what exists.
 *
 * A remembered tab can stop existing — the last person of a kind is let go, the
 * only appliance in the game is deleted — and falling through to the first one
 * keeps the bar showing something rather than nothing.
 */
export const groupAt = (groups, id) => groups.find((g) => g.id === id) ?? groups[0] ?? null;

/**
 * Draw the bar into its elements.
 *
 * Returns the tab and sub-tab actually drawn, so the caller can write back a
 * choice that resolved to something other than what it asked for.
 */
export function renderBar(el, {
  groups, at, atSub, picked, choice, caption, onTab, onSubTab, onPick, onShapes,
}) {
  const open = groupAt(groups, at);
  const subs = open?.subs ?? null;
  const sub = subs ? groupAt(subs, atSub) : null;
  const items = (sub ?? open)?.items ?? [];

  // `data-tip-wait`: a tab is five words you learn once and then read past all
  // session, and the pointer crosses this row on its way to everything below it.
  // Making the tip wait for a real dwell is what tells "what is this" apart from
  // "I am on my way past" — see `DWELL_MS` in `tip.js`.
  el.groups.innerHTML = groups.map((g) => `
    <button class="cat${g.id === open?.id ? ' on' : ''}" data-cat="${esc(g.id)}"
      data-tip-wait title="${esc(g.blurb ?? g.name)}">
      <span class="ico">${g.icon}</span><span class="nm">${esc(g.name)}</span>
    </button>`).join('');

  renderSubTabs(el.subs, subs, sub?.id);
  // What the caption says when nothing is under the pointer. A caller passing
  // none gets an empty slot rather than a missing one — it is reserved space, so
  // that it cannot move anything by filling and emptying.
  const resting = caption ?? null;
  setCaption(el.caption, resting);

  el.items.innerHTML = items.map((it, i) => `
    <button class="tool${it.id === picked ? ' on' : ''}${it.warn ? ' warn' : ''}"
      data-slot="${i}" title="${esc(it.title ?? it.name)}">
      ${i < KEYED ? `<span class="key">${i + 1}</span>` : ''}
      ${it.badge ? `<span class="have">${esc(it.badge)}</span>` : ''}
      <span class="ico${it.art ? ' art' : ''}">${it.art ?? it.icon}</span>
      <span class="nm">${esc(it.name)}</span>
      ${it.note ? `<span class="cost">${esc(it.note)}</span>` : ''}
      ${it.shapes ? '<span class="more" data-more="1">▾</span>' : ''}
    </button>`).join('');

  // The last tier is a choice *about the picked entry*, so it only belongs on
  // screen while that entry is. Browsing to another tab used to leave the shape
  // row behind, labelling a fixture that was no longer anywhere in front of you
  // — which reads as a row of buttons that do nothing, since picking a shape for
  // something you cannot see changes nothing you can see.
  renderChoice(el.choice, items.some((it) => it.id === picked) ? choice : null);

  el.groups.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => onTab(b.dataset.cat);
  });
  el.subs?.querySelectorAll('[data-subcat]').forEach((b) => {
    b.onclick = () => onSubTab?.(b.dataset.subcat);
  });
  el.items.querySelectorAll('[data-slot]').forEach((b) => {
    const it = items[Number(b.dataset.slot)];
    // A tile with shapes has two things a press can mean, and which one it is
    // is HOW LONG you press: a tap arms it, a hold asks what shapes it comes in.
    // The same sentence build mode already speaks on the world canvas, where a
    // hold on a fixture picks it up rather than opening it.
    //
    // The chevron is the same door with a handle on it — a hold nothing on
    // screen mentions is a gesture nobody finds, and a shape is cosmetic enough
    // that never finding it would simply look like the game not having them.
    let timer = null;
    let held = false;
    let from = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    b.onpointerdown = (e) => {
      if (!it.shapes || !onShapes) return;
      held = false;
      from = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => { held = true; onShapes(it); }, HOLD_MS);
    };
    // A strip that scrolls sideways is a strip you drag, and a drag begins as a
    // press that has not let go yet. Without this, pulling the far end of a tab
    // into view opens the shapes of whichever tile you happened to start on.
    b.onpointermove = (e) => {
      if (!timer || !from) return;
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) stop();
    };
    b.onpointerup = stop;
    b.onpointerleave = stop;
    b.onpointercancel = stop;
    b.onclick = (e) => {
      stop();
      // The hold already answered this press. Arming as well would put the
      // popover up over a tile and then re-render it out from under itself.
      if (held) { held = false; return; }
      if (it.shapes && onShapes && e.target.closest('[data-more]')) return onShapes(it);
      return onPick(it);
    };
    // Pointing at a tile names it, and leaving the strip hands the caption back
    // to whatever is armed. `mouseenter` on each button rather than `mouseover`
    // on the strip, because the gaps between tiles are the strip.
    b.onmouseenter = () => setCaption(el.caption, it.name);
  });
  if (el.items) el.items.onmouseleave = () => setCaption(el.caption, resting);
  // Over the tile it belongs to, and only once it is drawn and has a width.
  placeChoice(el.choice, el.items.querySelector('.tool.on'));

  // A tab can hold more entries than fit, and the selected one is exactly the
  // one you must be able to see — after a tab change, after something is picked
  // from off the bar, and after the list shifts under you.
  el.items.querySelector('.tool.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  return { group: open, sub };
}

/**
 * The second tier, and only for a tab that was given one.
 *
 * Empty and one-entry rows never reach here — `buildGroups` drops them, the same
 * way it drops a tab nobody has authored anything for. A lone sub-tab is a row
 * of chrome that answers a question with one answer.
 */
function renderSubTabs(el, subs, at) {
  if (!el) return;
  el.hidden = !subs;
  if (!subs) { el.innerHTML = ''; return; }
  el.innerHTML = subs.map((s) => `
    <button class="subcat${s.id === at ? ' on' : ''}" data-subcat="${esc(s.id)}"
      data-tip-wait title="${esc(s.blurb ?? s.name)}">
      <span class="ico">${s.icon}</span><span class="nm">${esc(s.name)}</span>
    </button>`).join('');
}

/**
 * Name one entry, in the slot at the end of the tab row.
 *
 * Written in place rather than through a re-render: this changes on every
 * mouseenter, and repainting three tiers of buttons to relabel one of them would
 * also blow away the sideways scroll position the pointer is sitting in.
 */
function setCaption(el, text) {
  if (!el) return;
  el.textContent = text ?? '';
  // The whole thing, for a name the slot had to cut short.
  el.title = text ?? '';
}

/**
 * The last tier, and only when there is a choice worth showing AND you asked.
 *
 * It was a row inside the bar, drawn whenever the armed piece had shapes. Two
 * things wrong with that and only one of them is the size: a row appearing and
 * disappearing changed the height of the bar, which moved every tab on it and
 * the tile you were aiming at, on the way in and again on the way out. It is a
 * card floating over the world now (`placeChoice`), so it costs the bar no
 * height at all — and since it can no longer be free, it is asked for.
 */
function renderChoice(el, choice) {
  if (!el) return;
  const show = !!choice?.open && (choice?.options?.length ?? 0) >= 2;
  el.hidden = !show;
  if (!show) { el.innerHTML = ''; return; }

  // No heading. The card only ever opens *out of* a tile you held, over that
  // tile, showing that thing in six shapes — a word saying "shape" is answering
  // a question the gesture already asked.
  el.innerHTML = choice.options.map((o) => `
    <button class="shape${o.id === choice.picked ? ' on' : ''}" data-opt="${esc(o.id)}">
      ${o.art ? `<span class="ico art">${o.art}</span>` : ''}<span class="nm">${esc(o.name)}</span>
    </button>`).join('');
  el.querySelectorAll('[data-opt]').forEach((b) => {
    b.onclick = () => choice.onPick(b.dataset.opt);
  });
}

/**
 * Sit the choice card over the tile it is about.
 *
 * Positioned against `#build-bar` rather than the strip, because the strip is
 * the one element here with `overflow` on it and a card inside it would be
 * clipped to a 58px slot. Which means the sideways scroll has to come out of the
 * sums: both rects are read live, so a tile scrolled halfway off the end still
 * gets its card over what is left of it.
 *
 * Clamped to the bar rather than centred on the tile at the ends, or the card
 * for slot one hangs off the left of a bar that is centred on screen.
 */
function placeChoice(el, anchor) {
  if (!el || el.hidden || !anchor) return;
  const bar = el.offsetParent;
  if (!bar) return;
  const a = anchor.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const pad = 6;
  const mid = (a.left - b.left) + a.width / 2;
  const room = b.width - el.offsetWidth - pad;
  el.style.left = `${Math.max(pad, Math.min(mid - el.offsetWidth / 2, Math.max(pad, room)))}px`;
}

/** Round the tabs, for the key that cycles them. */
export function nextGroup(groups, at, dir = 1) {
  if (groups.length < 2) return at;
  const i = Math.max(0, groups.findIndex((g) => g.id === at));
  return groups[(i + dir + groups.length) % groups.length].id;
}
