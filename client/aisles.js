/**
 * THE AISLE STRIP — a row of departments under a list of items.
 *
 * Two menus in this game are "every item in the catalogue, in one list": what a
 * shelf is kept for, and what the supplier sells. Both get one row longer every
 * time anybody authors a tomato, and both had exactly one way to narrow them —
 * a search box, which only helps once you already know the NAME of the thing
 * you want.
 *
 * That is the wrong assumption about how anybody arrives. What sends you to
 * either list is the demand meter saying *produce is short*, so the question in
 * your head is "show me produce", and there was no way to ask it.
 *
 * Its own module because the alternative is a copy in each: `fixture-menu.js`
 * and `ui.js` cannot import from one another (`ui` builds the fixture menu), so
 * one of them would have owned it and the other would have had a second
 * spelling of which twelve words these are and what a chosen one looks like.
 */

import { DEPARTMENTS } from '../shared/tags.js';
import { wireScroll } from './scroll.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * Which aisle an item is in, or null.
 *
 * The first category tag it has. An item with none has no aisle and appears
 * under All alone, which is the honest answer — the demand meter has no bar for
 * it either, so there is no aisle it could be filed under.
 */
export const deptOf = (item) => (item?.tags ?? []).find((t) => DEPARTMENTS.includes(t)) ?? null;

/**
 * Which aisles this particular list actually has rows in.
 *
 * In `DEPARTMENTS` order rather than in the list's own, because that is the
 * order the demand meter draws (`client/hud-meters.js`) and the meter is what
 * you were reading when you decided to open the list. Two readouts of the same
 * twelve buckets in two orders is two things to learn.
 *
 * Only the ones present, so a freezer's strip is the three aisles a freezer can
 * hold rather than twelve chips with nine of them empty. The icon tabs above
 * deliberately draw empty tabs — they are a fixed shape you learn — and this
 * must not, because these are a property of the list rather than of the menu.
 */
export const deptsIn = (rows) => DEPARTMENTS.filter((d) => rows.some((r) => r.dept === d));

/**
 * The strip, as badges.
 *
 * Text rather than icons, which is the one place in these menus that is true
 * of: there is no picture of "condiment", and inventing twelve would be twelve
 * glyphs to learn for words that are already written down the side of the
 * meter. The icon tabs above are a handful of fixed things you press every day;
 * this is a list you read.
 *
 * All is a button rather than an absence, because "nothing chosen" and "showing
 * everything" are the same list and only one of them is a thing you can press
 * your way back to.
 */
/**
 * ...in a wrapper, because the fade at each end is a MASK.
 *
 * A mask applies to everything the element paints, its own background included —
 * so a strip that was both the scroller and the bar painted 20px of *itself*
 * transparent at whichever end had more, and what showed through that window was
 * the list scrolling underneath it. On screen it is a green Buy button sliding
 * across the aisle chips, which reads as the panel having come apart rather than
 * as a fade doing exactly what it was told.
 *
 * So the two jobs are two elements: `.dwrap` is the bar — sticky, opaque, its
 * hairline — and `.dtabs` inside it is the scroller that fades. Nothing else
 * moves: `wireDepts` still wires `.dtabs`, because what scrolls is still what
 * scrolls.
 */
export const deptStrip = (depts, at) => `<div class="dwrap"><div class="dtabs">
  <button class="dtab${at ? '' : ' on'}" data-dept="">All</button>
  ${depts.map((d) => `<button class="dtab${d === at ? ' on' : ''}"
    data-dept="${esc(d)}">${esc(d)}</button>`).join('')}
</div></div>`;

/**
 * ...and it is ONE ROW that scrolls, which is a thing to wire rather than only
 * to style.
 *
 * The strip is the same sideways scroller the bottom bar's tools are
 * (`client/scroll.js`): a drag, a wheel, a flick, and a class at whichever end
 * has more past it, which the stylesheet turns into a fade. Here rather than in
 * either menu because both of them draw this strip and neither may own it — the
 * one thing worse than a strip that hides the aisle you came for is a strip that
 * hides it in the supplier and not in a shelf.
 *
 * The scroll-into-view is not a nicety, it is the whole of what makes a row you
 * cannot see all of acceptable. Every press in here repaints the menu whole, so
 * without it choosing CONDIMENT scrolls the strip back to All under you and the
 * chip you just pressed — the one thing on screen saying what you are looking at
 * — is off the end of it. `block: 'nearest'` because this is a sticky bar inside
 * a list that scrolls the other way, and a vertical nudge here would jump the
 * rows.
 *
 * Wired AFTER that scroll, the way the bar does it: both of `wireScroll`'s marks
 * are questions about the strip as drawn, and where it is scrolled to is one of
 * them.
 */
export function wireDepts(root) {
  const box = root?.querySelector?.('.dtabs');
  if (!box) return;
  box.querySelector('.dtab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  wireScroll(box, { axis: 'x' });
}

/**
 * The list, narrowed to one aisle.
 *
 * A heading survives the narrowing — it is furniture rather than an item, and a
 * list whose `sep` rows vanished would lose the shape it was organised by. An
 * item with no aisle does not, which is the same rule `deptOf` states: it is not
 * in this department, and All is where it lives.
 */
export const inDept = (rows, dept) => (dept
  ? rows.filter((r) => r.sep || r.dept === dept)
  : rows);
