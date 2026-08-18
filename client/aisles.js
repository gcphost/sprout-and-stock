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
export const deptStrip = (depts, at) => `<div class="dtabs">
  <button class="dtab${at ? '' : ' on'}" data-dept="">All</button>
  ${depts.map((d) => `<button class="dtab${d === at ? ' on' : ''}"
    data-dept="${esc(d)}">${esc(d)}</button>`).join('')}
</div>`;

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
