/**
 * THE BOTTOM BAR — one tiered picker, two things picking with it.
 *
 * Build wanted tabs because its palette is a database anyone can add to; the
 * roster wanted the same thing about ten minutes later, for the same reason —
 * five hires is a list and twenty is a problem, and both were already solved
 * once. So the shape moved here and the two callers describe their contents
 * rather than drawing them.
 *
 * Four tiers and only TWO rows, because the first two share one and the last is
 * not in the bar at all:
 *
 *   groups   what sort of thing        — tabs
 *   subs     which part of that        — quieter chips beside them, when a tab has any
 *   items    that tab's entries        — scrolls sideways, 1–9 reach the first nine
 *   choice   a choice about the picked entry — a card floating over its tile
 *
 * There was a fifth, a CAPTION at the far end of the tab row, which named
 * whatever was under the pointer and fell back to whatever was armed. It was
 * built when a hover explanation in this game was a native `title` — grey, a
 * second late, and wherever the pointer happened to be, which on a 40px tile in
 * a row of eight is nowhere near the thing it is about. `tip.js` answers that
 * question properly now, at the tile, so the caption was the same answer given
 * twice in a worse place: a name that had to be cut short to fit a fixed slot,
 * appearing at the opposite end of the bar from the thing you were pointing at.
 * It is gone rather than restyled — see CLAUDE.md on removing UI.
 *
 * The strip is dragged rather than scrolled — see `wireStrip` — so a caller
 * hands over the strip's wrapper and its two arrows beside the four elements
 * that are drawn into. They are optional: a bar without them is the plain
 * scroller it was. `tabs` is the same arrangement one tier up: the wrapper the
 * two tab rows scroll inside, so a nav row wider than a phone can be dragged
 * rather than simply running off the side with the way out on the end of it.
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
 *   item    = { id, icon, art, name, note, badge, title, warn, poor, off, last, head }
 *   choice  = { options: [{ id, name, art }], picked, open, onPick } | null
 *
 * `head` is a run label — a word drawn in the gap *before* that entry, upright,
 * for a strip whose entries come in runs of a kind. It is a field on the first
 * entry of the run rather than an entry of its own on purpose: a separator in
 * `items` would take a number key, shift every `data-slot` past it, and have to
 * be skipped by everything that resolves the nth entry of a tab. This way the
 * list is exactly what it was and the label is decoration on one of its
 * members.
 *
 * `art` is a picture of the thing itself where one can be drawn (see
 * `client/thumb.js`) and `icon` the glyph to fall back on. Two fields rather
 * than one because they are not the same size or the same claim: a glyph is a
 * category and art is *that shelf*, so the button that has art gets more room
 * for it and one that doesn't must not be sized as though it did.
 */

import { ICONS } from './icons.js';
import { wireScroll } from './scroll.js';
import { setHtml } from './paint.js';
import { hudPx } from './ui-scale.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** How many entries wear a number. That is how many number keys there are. */
export const KEYED = 9;

/**
 * How long a press has to last to be asking for the other thing.
 *
 * Exported because a hire's avatar asks the same question — tap to repaint,
 * hold for the range — and a second copy of this number would be two gestures
 * that are nearly the same length, which is worse than either.
 */
export const HOLD_MS = 400;

/**
 * Entries a caller wants pinned to the end of every tab they appear on —
 * Demolish. A stable sort, so everything else keeps the order it was
 * given; without it a pinned entry lands wherever the source list happened to
 * put it, which on some tabs is slot one, under the 1 key.
 */
export const pinLast = (items) => [...items]
  .sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));

/**
 * Where the client's own entries sit against authored ones.
 *
 * The null entries — Bare Ground, Bare Wall — are minted in code rather than
 * authored, so they have no row to carry a `sort` on and need a number written
 * down somewhere. This is it, and it is above the 0 every unranked piece has so
 * that the eraser leads a tab nobody has ordered: it is the entry you reach for
 * when a press went wrong, which is the one press you should never have to
 * scroll for. Anything meant to lead it is authored ABOVE it — which is the
 * whole of what a designer has to know about this number.
 */
export const PALETTE_LEAD = 1;

/**
 * Entries in the order the catalogue asked for, highest `sort` first.
 *
 * Stable, and that is not a detail: 0 is the default on every row, so a
 * catalogue where nobody has ranked anything comes out in exactly the order it
 * came out in before this existed. Ranking is opt-in, one row at a time.
 */
export const byRank = (items) => [...items]
  .sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0));

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
  groups, at, atSub, picked, choice, onTab, onSubTab, onPick, onShapes,
}) {
  const open = groupAt(groups, at);
  const subs = open?.subs ?? null;
  const sub = subs ? groupAt(subs, atSub) : null;
  const all = (sub ?? open)?.items ?? [];
  // THE BULLDOZER IS FURNITURE, NOT A TILE.
  //
  // It is on every tab already (`group: [...]`), which is the palette saying
  // "this one is not a question about what sort of thing it is" — and then it
  // was drawn as the last tile of a row that scrolls, so where it is depends on
  // which tab you are on and how far along you have dragged. What that costs is
  // the one press you go looking for when something is in the wrong place: you
  // have to find it, every time, in a different spot.
  //
  // Pinned to the right end of the strip instead, outside the scroller, beside
  // the way out. Same entry, same `onPick`, same armed state — what changes is
  // only that it has an address.
  const razer = all.find((it) => it.demolish) ?? null;
  const items = razer ? all.filter((it) => it !== razer) : all;

  // `data-tip-wait`: a tab is five words you learn once and then read past all
  // session, and the pointer crosses this row on its way to everything below it.
  // Making the tip wait for a real dwell is what tells "what is this" apart from
  // "I am on my way past" — see `DWELL_MS` in `tip.js`.
  // `setHtml` and not a bare write, here and below: this strip is rebuilt from
  // the snapshot, and a rebuild that produces the same markup still replaces the
  // node under the pointer — which drops `:hover` until the mouse moves again.
  // On a bar whose tiles carry a live line ("looking for something to do") that
  // is a button flickering in time with the shop. See client/paint.js.
  // The tip is on the tabs you are NOT on. `.cat .nm` is hidden until a tab is
  // open (`.cat.on .nm`), so the tip is what names the other five — and the one
  // you are standing on already prints its own name an inch below the bubble.
  // A tooltip repeating a label you can read is a box that appears over the shop
  // for no reason, on the tab your pointer is most often resting on.
  setHtml(el.groups, groups.map((g) => {
    const on = g.id === open?.id;
    return `
    <button class="cat${on ? ' on' : ''}" data-cat="${esc(g.id)}"
      ${on ? '' : `data-tip-wait title="${esc(g.name)}"`}>
      <span class="ico">${g.icon}</span><span class="nm">${esc(g.name)}</span>
    </button>`;
  }).join(''));

  renderSubTabs(el.subs, subs, sub?.id);

  // `data-entry` is the tile's own id, beside the slot index the press is wired
  // off. It exists so something outside this file can NAME a tile — the tutorial
  // lights one and blacks out the rest, and an index cannot say which: a slot
  // number is a fact about the tab that happens to be open, so the shelf that
  // was slot 3 this morning is a chandelier once somebody authors a lamp.
  //
  // `poor` is drawn and not `disabled`: a disabled button takes no pointer
  // events in some browsers, and the tip explaining WHY it cannot be pressed is
  // a hover away — so the one state that most needs its explanation would be the
  // one state with no way to ask for it. The press is refused below instead.
  // `off` is the second of those and works the same way: what cannot go on the
  // storey you are pointing at (see `DECK_GROUPS` in client/sections.js). Two
  // flags rather than one, because they are two sentences and only one of them
  // is about the price — the tip says which.
  // `armed` is a state of its own rather than a flavour of `on`, and the reason
  // is what the two mean: `on` is a tool in your hand, which stays there until
  // you put it down, and `armed` is a question that expires. So it carries the
  // window it expires after — `--arm`, straight onto the element, because the
  // line that drains over it is drawn from that number and a duration typed into
  // the stylesheet is a second copy of a timer nothing would ever check.
  setHtml(el.items, items.map((it, i) => `
    ${it.head ? `<span class="run" aria-hidden="true"><i>${esc(it.head)}</i></span>` : ''}
    <button class="tool${it.id === picked ? ' on' : ''}${it.warn ? ' warn' : ''}${
  it.armed ? ' armed' : ''}${it.poor ? ' poor' : ''}${it.off ? ' off' : ''}"
      data-slot="${i}" data-entry="${esc(it.id)}" title="${esc(it.title ?? it.name)}"
      ${it.armed ? `style="--arm:${Number(it.armed)}ms"` : ''}
      ${it.poor || it.off ? 'aria-disabled="true"' : ''}>
      ${i < KEYED ? `<span class="key">${i + 1}</span>` : ''}
      ${it.badge ? `<span class="have">${esc(it.badge)}</span>` : ''}
      <span class="ico${it.art ? ' art' : ''}">${it.art ?? it.icon}</span>
      <span class="nm${it.name.length > 11 ? ' long' : ''}">${esc(it.name)}</span>
      ${it.note ? `<span class="cost">${esc(it.note)}</span>` : ''}
      ${it.shapes ? '<span class="more" data-more="1">▾</span>' : ''}
    </button>`).join(''));

  // ...and the pinned one, drawn from the same entry the strip would have drawn.
  // Hidden rather than emptied when a tab has no bulldozer in it, so the strip
  // does not keep a gap for a button that is not there.
  if (el.raze) {
    el.raze.hidden = !razer;
    if (razer) {
      el.raze.className = `tool raze${razer.id === picked ? ' on' : ''}`;
      el.raze.title = razer.title ?? razer.name;
      // The glyph alone. Every other tile is a picture of a thing you have never
      // seen before and needs its name under it; this is one verb that is always
      // in the same place, so the word was costing the width of a tile to say
      // something you learn once — and what that width bought was an overlap
      // with the last entry of the run. The name is still on the button, as its
      // `title` and its label, so it is a hover away and a screen reader reads
      // it: what went is the pixels, not the word.
      el.raze.setAttribute('aria-label', razer.name);
      setHtml(el.raze, `<span class="ico">${razer.icon}</span>`);
      el.raze.onclick = () => onPick(razer);
    }
  }

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
    const stop = () => { clearTimeout(timer); timer = null; b.classList.remove('holding'); };
    // What a HOLD on this tile means, or null for a tile where it means nothing.
    // One answer: the shape card, on anything that comes in several shapes.
    //
    // Hiring was briefly the second, and is a double tap again (`UI.armHire`) —
    // worth knowing before the next irreversible press reaches for this. A hold
    // is the right gesture for one MORE question about a tile; it is the wrong
    // one for a tile whose tap already means something, because the tap then has
    // to be taught to do nothing.
    const onLong = (it.shapes && onShapes) ? () => onShapes(it) : null;
    b.onpointerdown = (e) => {
      // A hold ARMS the tile on its way to the shape card (`onShapes`), so it is
      // the same press as a tap as far as affording it goes.
      if (!onLong || it.poor || it.off) return;
      held = false;
      from = { x: e.clientX, y: e.clientY };
      // The tile fills while you hold it. A hold with no progress on it is
      // indistinguishable from a press that missed until the moment it fires,
      // which is what `setHoldProgress` says about the world's own ring.
      b.classList.add('holding');
      timer = setTimeout(() => { held = true; b.classList.remove('holding'); onLong(); }, HOLD_MS);
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
      // Nothing, for something you cannot buy — the chevron included, since that
      // is the same door the hold goes through and it arms the tile to get there.
      // The tile says so (greyed, price in the accent colour) and the tip beside
      // the pointer has the arithmetic, which is the same deal a section row you
      // cannot afford already offers: dim, and dead.
      if (it.poor || it.off) return undefined;
      if (it.shapes && onShapes && e.target.closest('[data-more]')) return onShapes(it);
      return onPick(it);
    };
  });
  // Over the tile it belongs to, and only once it is drawn and has a width.
  placeChoice(el.choice, el.items.querySelector('.tool.on'));

  // A tab can hold more entries than fit, and the selected one is exactly the
  // one you must be able to see — after a tab change, after something is picked
  // from off the bar, and after the list shifts under you.
  el.items.querySelector('.tool.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // ...and the same claim one tier up. The nav row is content-width, so on a
  // narrow screen it is a scroller too — and the tab you are ON is the one entry
  // that must never be the one off the side, which is exactly what cycling with
  // Tab would otherwise do.
  if (el.tabs) {
    (el.subs?.querySelector('.subcat.on') ?? el.groups.querySelector('.cat.on'))
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    wireScroll(el.tabs, { axis: 'x' });
  }

  // Last, because both halves of it are questions about the strip as drawn: how
  // far it can scroll, and where it is scrolled to *after* the line above.
  wireStrip(el);

  return { group: open, sub };
}

/**
 * The strip, and an arrow at each end that has more past it.
 *
 * The drag and the "is there more" test are `wireScroll` — every panel list
 * wants both, and the traps in them are written up there. What is the bar's own
 * is the pair of arrows: the fade alone says there is more, and a 22px button
 * is a thing you can press, where a 5px scrollbar was neither.
 *
 * The marks land on the STRIP rather than on the scroller, because a scroll
 * container's own `::before` is part of its content and scrolls away with it —
 * which is a fade that slides off the end it was marking. The wrapper does not
 * move, and the arrows are its children rather than the row's, so they are
 * never redrawn by the `innerHTML` above.
 */
function wireStrip(el) {
  const strip = el.strip;
  const box = el.items;
  if (!strip) return;

  if (!strip.dataset.wired) {
    strip.dataset.wired = '1';
    if (el.back) el.back.innerHTML = ICONS.back;
    if (el.on) el.on.innerHTML = ICONS.on;
    // A press moves it by most of a screenful — enough to be worth pressing,
    // short of a jump that loses you which end you were at.
    const nudge = (dir) => box.scrollBy({ left: dir * box.clientWidth * 0.8, behavior: 'smooth' });
    if (el.back) el.back.onclick = () => nudge(-1);
    if (el.on) el.on.onclick = () => nudge(1);
  }

  wireScroll(box, {
    axis: 'x',
    ends: (back, on) => {
      strip.classList.toggle('more-back', back);
      strip.classList.toggle('more-on', on);
      if (el.back) el.back.hidden = !back;
      if (el.on) el.on.hidden = !on;
    },
  });
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
  if (!subs) { setHtml(el, ''); return; }
  // Not on the open one, for the reason above.
  setHtml(el, subs.map((s) => {
    const on = s.id === at;
    return `
    <button class="subcat${on ? ' on' : ''}" data-subcat="${esc(s.id)}"
      ${on ? '' : `data-tip-wait title="${esc(s.name)}"`}>
      <span class="ico">${s.icon}</span><span class="nm">${esc(s.name)}</span>
    </button>`;
  }).join(''));
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
  // Both rects are viewport pixels and `offsetWidth` is the HUD's own, which are
  // the same number only while the size dial is at 1 — see client/ui-scale.js.
  // Converted here rather than at the assignment because every term below has to
  // be in one space for the clamp to mean anything, and unconverted the card
  // drifts further off its tile the further along the bar you press.
  const mid = hudPx((a.left - b.left) + a.width / 2);
  const room = hudPx(b.width) - el.offsetWidth - pad;
  el.style.left = `${Math.max(pad, Math.min(mid - el.offsetWidth / 2, Math.max(pad, room)))}px`;
}

/** Round the tabs, for the key that cycles them. */
export function nextGroup(groups, at, dir = 1) {
  if (groups.length < 2) return at;
  const i = Math.max(0, groups.findIndex((g) => g.id === at));
  return groups[(i + dir + groups.length) % groups.length].id;
}
