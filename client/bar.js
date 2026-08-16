/**
 * THE BOTTOM BAR — one tiered picker, two things picking with it.
 *
 * Build wanted tabs because its palette is a database anyone can add to; the
 * roster wanted the same thing about ten minutes later, for the same reason —
 * five hires is a list and twenty is a problem, and both were already solved
 * once. So the shape moved here and the two callers describe their contents
 * rather than drawing them.
 *
 * Three tiers, and the third is optional:
 *
 *   groups   what sort of thing        — tabs, one row
 *   items    that tab's entries        — scrolls sideways, 1–9 reach the first nine
 *   sub      a choice about the picked entry, when there is one to make
 *
 * A caller supplies data and callbacks and never touches the DOM, which is what
 * lets the number keys, the tab cycling, the scroll-the-selection-into-view and
 * the height measurement be written once instead of twice.
 *
 * Shapes:
 *   group = { id, name, icon, blurb, items: [item] }
 *   item  = { id, icon, name, note, badge, title, warn, last }
 *   sub   = { label, options: [{ id, name }], picked, onPick } | null
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** How many entries wear a number. That is how many number keys there are. */
export const KEYED = 9;

/**
 * Entries a caller wants pinned to the end of every tab they appear on —
 * Demolish, Hire. A stable sort, so everything else keeps the order it was
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
 * Returns the group actually drawn, so the caller can write back a tab that
 * resolved to something other than what it asked for.
 */
export function renderBar(el, { groups, at, picked, sub, onTab, onPick }) {
  const open = groupAt(groups, at);

  el.groups.innerHTML = groups.map((g) => `
    <button class="cat${g.id === open?.id ? ' on' : ''}" data-cat="${esc(g.id)}"
      title="${esc(g.blurb ?? g.name)}">
      <span class="ico">${g.icon}</span><span class="nm">${esc(g.name)}</span>
    </button>`).join('');

  el.items.innerHTML = (open?.items ?? []).map((it, i) => `
    <button class="tool${it.id === picked ? ' on' : ''}${it.warn ? ' warn' : ''}"
      data-slot="${i}" title="${esc(it.title ?? it.name)}">
      ${i < KEYED ? `<span class="key">${i + 1}</span>` : ''}
      ${it.badge ? `<span class="have">${esc(it.badge)}</span>` : ''}
      <span class="ico">${it.icon}</span>
      <span class="nm">${esc(it.name)}</span>
      ${it.note ? `<span class="cost">${esc(it.note)}</span>` : ''}
    </button>`).join('');

  renderSub(el.sub, sub);

  el.groups.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => onTab(b.dataset.cat);
  });
  el.items.querySelectorAll('[data-slot]').forEach((b) => {
    b.onclick = () => onPick(open.items[Number(b.dataset.slot)]);
  });

  // A tab can hold more entries than fit, and the selected one is exactly the
  // one you must be able to see — after a tab change, after something is picked
  // from off the bar, and after the list shifts under you.
  el.items.querySelector('.tool.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  return open;
}

/** The third tier, and only when there is a choice worth showing. */
function renderSub(el, sub) {
  if (!el) return;
  const show = (sub?.options?.length ?? 0) >= 2;
  el.hidden = !show;
  if (!show) { el.innerHTML = ''; return; }

  el.innerHTML = `<span class="lbl">${esc(sub.label)}</span>`
    + sub.options.map((o) => `<button class="shape${o.id === sub.picked ? ' on' : ''}"
        data-sub="${esc(o.id)}">${esc(o.name)}</button>`).join('');
  el.querySelectorAll('[data-sub]').forEach((b) => {
    b.onclick = () => sub.onPick(b.dataset.sub);
  });
}

/** Round the tabs, for the key that cycles them. */
export function nextGroup(groups, at, dir = 1) {
  if (groups.length < 2) return at;
  const i = Math.max(0, groups.findIndex((g) => g.id === at));
  return groups[(i + dir + groups.length) % groups.length].id;
}
