/**
 * PUTTING A CORNER READOUT AWAY, AND GETTING IT BACK.
 *
 * The demand meter and the shop radio are the two things in the HUD that are
 * always on screen and never urgent — you consult them, the way you consult the
 * Shop report, and the corner they sit in is over the farm. Moving them was
 * already possible (`client/panel-drag.js`); the missing half is not wanting
 * them at all, and there is nowhere else on screen a widget can be dragged to
 * that is not over something.
 *
 * So: a ✕ on the widget, and a row in the Menu that puts it back. The way back
 * has to be somewhere other than the thing you just closed, which is the whole
 * reason this knows about `CORNERS` — the Menu draws its rows off that list, so
 * a third widget wired here cannot become one nobody can bring back.
 *
 * The ✕ is built here rather than authored in index.html for two reasons. Both
 * widgets get an identical one from one place, and the demand meter's insides
 * are rewritten from `innerHTML` at 10Hz by `ui.update` — anything authored
 * inside it lives about a tenth of a second. This appends to the widget itself
 * and the rows go in a child, so the button outlives every repaint.
 *
 * It is its OWN store rather than a flag in `sns-panel-pos`, even though the
 * same two elements are in both. Double-clicking a widget deletes its entry
 * there to give the position back, and a shared map would make that also
 * un-hide it — one gesture quietly doing two things, only one of which you can
 * see, because a widget you closed is not on screen to watch come back.
 */

import { ICONS } from './icons.js';

const STORE = 'sns-hud-off';

/**
 * Everything that can be put away, in the order the Menu lists it.
 *
 * The names are what the Menu prints, so they are the shop's words for these
 * things rather than their element ids — nobody has ever called it `rci`.
 */
export const CORNERS = [
  { id: 'rci', icon: 'report', name: 'Demand meter', sub: 'twelve departments, over or under' },
  { id: 'radio', icon: 'music', name: 'Shop radio', sub: 'what is on, and the buttons for it' },
];

/** localStorage is a hostile environment: private mode, quota, a stale value. */
function saved() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
function store(map) {
  try { localStorage.setItem(STORE, JSON.stringify(map)); } catch { /* not worth a toast */ }
}

/** Is this one put away? Absent means on, so a save that predates this is on. */
export const isOff = (id) => saved()[id] === true;

/** Nothing stored for a widget that is showing — the default is the absence. */
export function setOff(id, off) {
  const map = saved();
  if (off) map[id] = true;
  else delete map[id];
  store(map);
  apply(id);
}

function apply(id) {
  document.getElementById(id)?.classList.toggle('corner-off', isOff(id));
}

/**
 * Give `el` its ✕, and put it away if that is where you left it.
 *
 * `say` is the caller's toast. A thing that vanishes with no explanation is a
 * thing you assume is broken — the ✕ is small, it is on hover, and the widget
 * it closes is the only evidence it existed — so closing one says where it went
 * rather than leaving you to find the Menu row by chance.
 */
export function wireCorner(el, id, say = null) {
  const what = CORNERS.find((c) => c.id === id)?.name ?? id;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'corner-x';
  btn.title = 'Put away — bring it back from the Menu';
  btn.setAttribute('aria-label', `hide the ${what.toLowerCase()}`);
  btn.innerHTML = ICONS.close;
  btn.addEventListener('click', () => {
    setOff(id, true);
    say?.(`${what} put away — the Menu brings it back`);
  });
  el.append(btn);
  apply(id);
}
