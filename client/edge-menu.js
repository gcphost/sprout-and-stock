/**
 * One menu per way through — who this door is for.
 *
 * The fourth menu, and the first one that opens on something that is not a
 * *thing*: a doorway has no tile, no id and no record anywhere. It is a number
 * on a lattice line, which is why this takes `{o, x, z}` — the same address
 * `build-edge` has always taken — and reads its kind back off the layout every
 * time it draws.
 *
 * The whole menu is one exclusive choice, and it is offered here rather than as
 * four more palette buttons for a reason worth keeping: you do not know a door
 * should be staff-only when you draw it. You find out after the room exists,
 * usually while watching somebody wander through it. A palette button asks the
 * question at the one moment you cannot answer it — and gets you a shell with two
 * kinds of opening in it that look identical and were chosen by whichever button
 * you happened to have up.
 *
 * Functions take `ui` first rather than living on it, like `fixture-menu.js`.
 *
 * See "A way through, and who it is for" in docs/building.md.
 */

import { WAY_RULES, wayBase, wayRule, wayKind, edgeW, edgeN, isIndoor } from '../shared/edges.js';
import { ICONS } from './icons.js';
import { actIcon } from './fixture-menu.js';
import { artForEdge } from './thumb.js';

/**
 * What each rule is called, and what picking it actually does.
 *
 * `sub` is the consequence rather than the mechanism, because the mechanism is
 * the same in all four cases (a shopper's A* refuses the crossing) and nobody
 * cares. What differs is who ends up walking where.
 */
const RULE_INFO = {
  all: {
    name: 'Anyone',
    short: 'Anyone',
    icon: ICONS.walk,
    sub: 'Shoppers and staff both, in and out. What a doorway has always been.',
  },
  staff: {
    name: 'Staff only',
    short: 'Staff',
    icon: ICONS.staff,
    sub: 'Shoppers treat it as a wall. You and everyone who works here walk through it.',
  },
  in: {
    name: 'Entrance only',
    short: 'In',
    icon: ICONS.tierup,
    sub: 'Shoppers may come in this way and never leave by it. They will find another way out.',
  },
  out: {
    name: 'Exit only',
    short: 'Out',
    icon: ICONS.tierdown,
    sub: 'Shoppers leave this way and never arrive by it.',
  },
};

/** The kind on one lattice line. `edgesV` is a west face, `edgesH` a north one. */
export const kindAt = (L, at) => (at.o === 'v' ? edgeW(L, at.x, at.z) : edgeN(L, at.x, at.z));

/** The two cells a line separates, west-then-east or north-then-south. */
const sidesOf = (at) => (at.o === 'v'
  ? [{ x: at.x - 1, z: at.z }, { x: at.x, z: at.z }]
  : [{ x: at.x, z: at.z - 1 }, { x: at.x, z: at.z }]);

/**
 * Which rules this particular opening can be given.
 *
 * A gate never gets one-way, and neither does a door between two rooms — see
 * `shopperCanCross` for why. "In" is read off the enclosure rather than stored,
 * so a boundary whose two sides agree about being indoors has no in and no out,
 * and offering the rule there would be a button that takes a press and changes
 * no number. Which is the same trap as a tier that sells a multiplier nothing
 * reads, and it is worse here: it would look like it had worked.
 */
export function rulesFor(L, at) {
  const base = wayBase(kindAt(L, at));
  if (!base) return [];
  const all = WAY_RULES[base] ?? [];
  if (!L?.indoor) return all.filter((r) => r === 'all' || r === 'staff');
  const [a, b] = sidesOf(at);
  const crosses = isIndoor(L, L.indoor, a.x, a.z) !== isIndoor(L, L.indoor, b.x, b.z);
  return crosses ? all : all.filter((r) => r === 'all' || r === 'staff');
}

/** Is there anything to open here at all? Asked by the press before it fires. */
export const isWay = (L, at) => !!(L && at && wayBase(kindAt(L, at)));

/**
 * Is the tool you are holding the same sort of way through as the one already on
 * this line?
 *
 * The test behind "tapping a doorway with the Doorway tool opens it rather than
 * rebuilding it". By FAMILY rather than by kind, or the tool would only open a
 * plain door and bounce off one you had already signed — and deliberately not by
 * "is it an opening at all", or the Wall tool would open doors instead of
 * bricking them up.
 */
export const sameWay = (L, at, kind) => isWay(L, at)
  && wayBase(kind) === wayBase(kindAt(L, at));

/**
 * Open the menu for one way through.
 *
 * Takes the address rather than the kind, for the same reason the worker menu
 * takes a roster id: the kind is what this menu *changes*, so holding the one it
 * opened with would leave every row lit against the door it used to be.
 */
export function showWay(ui, at) {
  const L = ui.scene?.storeLayout;
  if (!L || !isWay(L, at)) { ui.closePanel(); return false; }

  const kind = kindAt(L, at);
  const base = wayBase(kind);
  const rule = wayRule(kind);
  const rules = rulesFor(L, at);

  ui.openPanel = 'way';
  // Not a section, so nothing on the rail is lit — a fixture's menu and a hire's
  // both behave this way.
  ui.rail.setOpen(null);
  ui.wayRef = { o: at.o, x: at.x, z: at.z };
  ui.panelTick = tickWay;
  ui._wayKey = `${kind}:${rules.join(',')}`;

  const info = RULE_INFO[rule] ?? RULE_INFO.all;
  const what = base === 'gate' ? 'Gate' : 'Doorway';
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  // The one thing a square cannot say, and only where it is true: a one-way rule
  // is offered on a boundary that HAS an in and an out, so anywhere else the two
  // missing squares would read as a bug rather than as an answer.
  const why = rules.includes('in') ? null : (base === 'gate'
    ? 'A fence never makes a room, so there is no in or out here.'
    : 'One way needs an inside and an outside — this has the same on both sides.');

  // The head is a picture of the door and what its rule means. The picture comes
  // off `EDGE_STYLE` through `artForEdge` — the same record the renderer builds
  // the real thing from — so the marked threshold in the button is the marked
  // threshold in the shop, and this cannot draw a door the game does not build.
  const art = artForEdge(kind);
  const parts = [`<div class="pnl-head">
    <div class="row sec-row">
      ${art ? `<div class="lead"><span class="bico art">${art}</span></div>` : ''}
      <div class="name"><span class="t">${info.name}</span
        ><span class="meta"><span class="tags">${info.sub}</span></span></div>
    </div>
    ${why ? `<div class="fx-detail">${line('One way', `<i>${why}</i>`)}</div>` : ''}
  </div>`];

  // One row of exclusive choices rather than a list of switches: an opening has
  // exactly one answer to "who is this for", and two switches you could both
  // turn on would need a rule about which of them wins.
  const squares = rules.map((r) => {
    const i = RULE_INFO[r];
    return actIcon(`way:${r}`, i.icon, i.name, i.sub, i.short, { on: r === rule });
  });
  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${squares.join('')}</div></div>`);

  // Titled by the rule as well as by the thing, because "Doorway" is the one
  // word on this panel that is true whatever you press.
  ui.showPanel(`${info.icon} ${what}`, parts.join(''), `way:${at.o}:${at.x},${at.z}`);
  wireWayMenu(ui, at, base);
  return true;
}

function wireWayMenu(ui, at, base) {
  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    const rule = el.dataset.act.startsWith('way:') ? el.dataset.act.slice(4) : null;
    if (!rule) return;
    el.onclick = () => {
      const kind = wayKind(base, rule);
      if (kind === null) return;
      // A `build-edge` at that line with a different kind, and nothing else:
      // storage, persistence, `withEdge`, `deriveEdges` and the renderer all
      // learn no new concept. `withBuildMode` because the server gates every
      // edge verb on it and this menu opens with or without the mode, exactly
      // the way Empty and Rotate do on a fixture.
      //
      // No `to`, so the run is this one segment. Sending the far end of a drag
      // here would sign the whole wall.
      ui.withBuildMode(() => ui.net.send('build-edge', {
        o: at.o, x: at.x, z: at.z, kind,
      }));
    };
  });
}

/**
 * Keep the open menu honest from the layout.
 *
 * The kind under it is what this menu changes, and the other player can change
 * it too — or knock the doorway through entirely, which closes this rather than
 * leaving a menu open on a hole. It also has to notice the *rules* moving:
 * walling the far side of a stockroom makes an interior door a boundary again,
 * and the two one-way squares should appear when it does.
 */
function tickWay(ui) {
  if (ui.openPanel !== 'way' || !ui.wayRef) return;
  const L = ui.scene?.storeLayout;
  if (!L || !isWay(L, ui.wayRef)) { ui.closePanel(); return; }
  const key = `${kindAt(L, ui.wayRef)}:${rulesFor(L, ui.wayRef).join(',')}`;
  if (key !== ui._wayKey) showWay(ui, ui.wayRef);
}
