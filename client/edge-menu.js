/**
 * One menu per edge — what this door is for, and what this window is like.
 *
 * The fourth menu, and the first one that opens on something that is not a
 * *thing*: an edge has no tile, no id and no record anywhere. It is a number on a
 * lattice line, which is why this takes `{o, x, z}` — the same address
 * `build-edge` has always taken — and reads its kind back off the layout every
 * time it draws.
 *
 * The menu is always one exclusive choice out of the edge's own FAMILY
 * (`edgeFamily`, shared/edges.js), and which question that choice answers depends
 * on the family: a doorway or a gate offers **who may cross**, a window offers
 * **where the glass is**. One menu for both because from the player's side they
 * are the same gesture on the same sort of thing — point at what you built, change
 * what it is — and because the way it is *paid for* is the same either way: within
 * a family, `buildEdge` charges a refit and refunds nothing, since you still have
 * the door and you still have the wall.
 *
 * Offering the choice here rather than only as more palette buttons is the whole
 * shape of step 15, and the argument is worth keeping: you do not know a door
 * should be staff-only when you draw it. You find out after the room exists,
 * usually while watching somebody wander through it. A palette button asks that
 * question at the one moment you cannot answer it — and gets you a shell with two
 * kinds of opening in it that look identical and were chosen by whichever button
 * you happened to have up. A glazing is the softer version of the same thing: the
 * bar has all four, because drawing a shopfront along the front of the shop is a
 * thing you decide up front, and this is how you change your mind about the one
 * that is already standing there.
 *
 * Functions take `ui` first rather than living on it, like `fixture-menu.js`.
 *
 * See "A way through, and who it is for" in docs/building.md.
 */

import {
  WAY_RULES, GLAZING_LOOKS, wayBase, wayRule, wayKind,
  glazingLook, glazingKind, edgeFamily, edgeW, edgeN, isIndoor,
} from '../shared/edges.js';
import { ICONS } from './icons.js';
import { actIcon } from './fixture-menu.js';
import { artForEdge } from './thumb.js';

/**
 * What each choice is called, and what picking it actually does.
 *
 * One table across both families, keyed by the option's own name — they cannot
 * collide, because a rule says who and a look says what. `sub` is the consequence
 * rather than the mechanism: for a rule the mechanism is identical in all four
 * cases (a shopper's A* refuses the crossing) and for a look there is no mechanism
 * at all, which is the point of a look.
 */
const CHOICE = {
  // Who may cross — see `WAYS`.
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
  // Where the glass is — see `GLAZING`. Every one of these says the price, because
  // the surprising thing about them is that there isn't one: a look must never
  // move a number, so swapping between them is free.
  standard: {
    name: 'Window',
    short: 'Window',
    icon: ICONS.ambient,
    sub: 'Glazed from waist to lintel. The plain one.',
  },
  full: {
    name: 'Shopfront',
    short: 'Full',
    icon: ICONS.shop,
    sub: 'Glass from the floor to the lintel, over a kick plate.',
  },
  bay: {
    name: 'Bay window',
    short: 'Bay',
    icon: ICONS.fixtures,
    sub: 'Steps out over a sill — into the street, never into the aisle.',
  },
  high: {
    name: 'High window',
    short: 'High',
    icon: ICONS.ambient,
    sub: 'A strip up under the lintel: light, and nothing to see through it.',
  },
};

/** What each family is called, and what its choice is called. */
const FAMILY = {
  door: { what: 'Doorway', asks: 'Open to' },
  gate: { what: 'Gate', asks: 'Open to' },
  window: { what: 'Window', asks: 'Glazed' },
};

/** The kind on one lattice line. `edgesV` is a west face, `edgesH` a north one. */
export const kindAt = (L, at) => (at.o === 'v' ? edgeW(L, at.x, at.z) : edgeN(L, at.x, at.z));

/** The two cells a line separates, west-then-east or north-then-south. */
const sidesOf = (at) => (at.o === 'v'
  ? [{ x: at.x - 1, z: at.z }, { x: at.x, z: at.z }]
  : [{ x: at.x, z: at.z - 1 }, { x: at.x, z: at.z }]);

/** Does this line have an inside on one side of it and an outside on the other? */
function isBoundary(L, at) {
  if (!L?.indoor) return false;
  const [a, b] = sidesOf(at);
  return isIndoor(L, L.indoor, a.x, a.z) !== isIndoor(L, L.indoor, b.x, b.z);
}

/**
 * Which choices this particular edge can be given, in menu order.
 *
 * A window gets all four glazings always — a look has nothing to be conditional
 * on. An opening is the interesting half: a gate never gets one-way, and neither
 * does a door between two rooms. "In" is read off the enclosure rather than
 * stored, so a boundary whose two sides agree about being indoors has no in and no
 * out, and offering the rule there would be a button that takes a press and
 * changes no number. Same trap as a tier that sells a multiplier nothing reads,
 * and worse here, because it would look like it had worked.
 */
export function choicesFor(L, at) {
  const kind = kindAt(L, at);
  if (glazingLook(kind)) return GLAZING_LOOKS;
  const base = wayBase(kind);
  if (!base) return [];
  const all = WAY_RULES[base] ?? [];
  return isBoundary(L, at) ? all : all.filter((r) => r === 'all' || r === 'staff');
}

/** What this edge's choice is right now. */
const choiceOf = (kind) => wayRule(kind) ?? glazingLook(kind) ?? null;

/** ...and the kind that is this edge's family with that choice on it. */
const kindFor = (family, choice) => (family === 'window'
  ? glazingKind(choice)
  : wayKind(family, choice));

/** Is there anything to open here at all? Asked by the hover and by the press. */
export const hasEdgeMenu = (L, at) => !!(L && at && edgeFamily(kindAt(L, at)));

/**
 * Is the tool you are holding the same FAMILY as what is already on this line?
 *
 * The test behind "tapping a doorway with the Doorway tool opens it rather than
 * rebuilding it", and it works for a window and the Shopfront tool too. By family
 * rather than by kind, or the tool would only open the plain one and bounce off
 * anything you had already changed — and deliberately not by "is it an edge at
 * all", or the Wall tool would open windows instead of bricking them up.
 */
export const sameFamily = (L, at, kind) => hasEdgeMenu(L, at)
  && !!edgeFamily(kind) && edgeFamily(kind) === edgeFamily(kindAt(L, at));

/**
 * Open the menu for one edge.
 *
 * Takes the address rather than the kind, for the same reason the worker menu
 * takes a roster id: the kind is what this menu *changes*, so holding the one it
 * opened with would leave every row lit against the door it used to be.
 */
export function showEdgeMenu(ui, at) {
  const L = ui.scene?.storeLayout;
  if (!L || !hasEdgeMenu(L, at)) { ui.closePanel(); return false; }

  const kind = kindAt(L, at);
  const family = edgeFamily(kind);
  const choice = choiceOf(kind);
  const choices = choicesFor(L, at);

  ui.openPanel = 'way';
  // Not a section, so nothing on the rail is lit — a fixture's menu and a hire's
  // both behave this way.
  ui.rail.setOpen(null);
  ui.wayRef = { o: at.o, x: at.x, z: at.z };
  ui.panelTick = tickEdge;
  ui._wayKey = `${kind}:${choices.join(',')}`;

  const info = CHOICE[choice] ?? CHOICE.all;
  const meta = FAMILY[family] ?? FAMILY.door;
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  // The one thing a square cannot say, and only where it is true: one way is
  // offered on a boundary that HAS an in and an out, so anywhere else the two
  // missing squares would read as a bug rather than as an answer.
  const why = (family === 'window' || choices.includes('in')) ? null : (family === 'gate'
    ? 'A fence never makes a room, so there is no in or out here.'
    : 'One way needs an inside and an outside — this has the same on both sides.');

  // The head is a picture of the edge and what its choice means. The picture comes
  // off `EDGE_STYLE` through `artForEdge` — the same record the renderer builds the
  // real thing from — so the marked threshold and the stepped-out bay in the button
  // are the ones in the shop, and this cannot draw an edge the game does not build.
  const art = artForEdge(kind);
  const parts = [`<div class="pnl-head">
    <div class="row sec-row">
      ${art ? `<div class="lead"><span class="bico art">${art}</span></div>` : ''}
      <div class="name"><span class="t">${info.name}</span
        ><span class="meta"><span class="tags">${info.sub}</span></span></div>
    </div>
    <div class="fx-detail">
      ${line(meta.asks, info.name)}
      ${family === 'window' ? line('Changing it', 'free — you keep the wall') : ''}
      ${why ? line('One way', `<i>${why}</i>`) : ''}
    </div>
  </div>`];

  // One row of exclusive choices rather than a list of switches: an edge has
  // exactly one answer to what it is, and two switches you could both turn on
  // would need a rule about which of them wins.
  const squares = choices.map((c) => {
    const i = CHOICE[c];
    return actIcon(`edge:${c}`, i.icon, i.name, i.sub, i.short, { on: c === choice });
  });
  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${squares.join('')}</div></div>`);

  // Titled by the family, which is the one word on this panel that stays true
  // whatever you press.
  ui.showPanel(`${info.icon} ${meta.what}`, parts.join(''), `way:${at.o}:${at.x},${at.z}`);
  wireEdgeMenu(ui, at, family);
  return true;
}

function wireEdgeMenu(ui, at, family) {
  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    const choice = el.dataset.act.startsWith('edge:') ? el.dataset.act.slice(5) : null;
    if (!choice) return;
    el.onclick = () => {
      const kind = kindFor(family, choice);
      if (kind === null) return;
      // A `build-edge` at that line with a different kind, and nothing else:
      // storage, persistence, `withEdge`, `deriveEdges` and the renderer all
      // learn no new concept. `withBuildMode` because the server gates every
      // edge verb on it and this menu opens with or without the mode, exactly
      // the way Empty and Rotate do on a fixture.
      //
      // No `to`, so the run is this one segment. Sending the far end of a drag
      // here would reglaze the whole wall.
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
 * leaving a menu open on a hole. It also has to notice the *choices* moving:
 * walling the far side of a stockroom makes an interior door a boundary again,
 * and the two one-way squares should appear when it does.
 */
function tickEdge(ui) {
  if (ui.openPanel !== 'way' || !ui.wayRef) return;
  const L = ui.scene?.storeLayout;
  if (!L || !hasEdgeMenu(L, ui.wayRef)) { ui.closePanel(); return; }
  const key = `${kindAt(L, ui.wayRef)}:${choicesFor(L, ui.wayRef).join(',')}`;
  if (key !== ui._wayKey) showEdgeMenu(ui, ui.wayRef);
}
