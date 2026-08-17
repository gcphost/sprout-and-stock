/**
 * THE BOTTOM BAR — one tiered picker, two things picking with it.
 *
 * Build wanted tabs because its palette is a database anyone can add to; the
 * roster wanted the same thing about ten minutes later, for the same reason —
 * five hires is a list and twenty is a problem, and both were already solved
 * once. So the shape moved here and the two callers describe their contents
 * rather than drawing them.
 *
 * Four tiers, and two of them are optional:
 *
 *   groups   what sort of thing        — tabs, one row
 *   subs     which part of that        — a second, quieter row, when a tab has any
 *   items    that tab's entries        — scrolls sideways, 1–9 reach the first nine
 *   choice   a choice about the picked entry, when there is one to make
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
 *   group  = { id, name, icon, blurb, items: [item], subs?: [group] }
 *   item   = { id, icon, art, name, note, badge, title, warn, last }
 *   choice = { label, options: [{ id, name, art }], picked, onPick } | null
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
export function renderBar(el, { groups, at, atSub, picked, choice, onTab, onSubTab, onPick }) {
  const open = groupAt(groups, at);
  const subs = open?.subs ?? null;
  const sub = subs ? groupAt(subs, atSub) : null;
  const items = (sub ?? open)?.items ?? [];

  el.groups.innerHTML = groups.map((g) => `
    <button class="cat${g.id === open?.id ? ' on' : ''}" data-cat="${esc(g.id)}"
      title="${esc(g.blurb ?? g.name)}">
      <span class="ico">${g.icon}</span><span class="nm">${esc(g.name)}</span>
    </button>`).join('');

  renderSubTabs(el.subs, subs, sub?.id);

  el.items.innerHTML = items.map((it, i) => `
    <button class="tool${it.id === picked ? ' on' : ''}${it.warn ? ' warn' : ''}"
      data-slot="${i}" title="${esc(it.title ?? it.name)}">
      ${i < KEYED ? `<span class="key">${i + 1}</span>` : ''}
      ${it.badge ? `<span class="have">${esc(it.badge)}</span>` : ''}
      <span class="ico${it.art ? ' art' : ''}">${it.art ?? it.icon}</span>
      <span class="nm">${esc(it.name)}</span>
      ${it.note ? `<span class="cost">${esc(it.note)}</span>` : ''}
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
    b.onclick = () => onPick(items[Number(b.dataset.slot)]);
  });

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
      title="${esc(s.blurb ?? s.name)}">
      <span class="ico">${s.icon}</span><span class="nm">${esc(s.name)}</span>
    </button>`).join('');
}

/** The last tier, and only when there is a choice worth showing. */
function renderChoice(el, choice) {
  if (!el) return;
  const show = (choice?.options?.length ?? 0) >= 2;
  el.hidden = !show;
  if (!show) { el.innerHTML = ''; return; }

  el.innerHTML = `<span class="lbl">${esc(choice.label)}</span>`
    + choice.options.map((o) => `<button class="shape${o.id === choice.picked ? ' on' : ''}"
        data-opt="${esc(o.id)}">${o.art ? `<span class="ico art">${o.art}</span>` : ''}${esc(o.name)}</button>`).join('');
  el.querySelectorAll('[data-opt]').forEach((b) => {
    b.onclick = () => choice.onPick(b.dataset.opt);
  });
}

/** Round the tabs, for the key that cycles them. */
export function nextGroup(groups, at, dir = 1) {
  if (groups.length < 2) return at;
  const i = Math.max(0, groups.findIndex((g) => g.id === at));
  return groups[(i + dir + groups.length) % groups.length].id;
}
