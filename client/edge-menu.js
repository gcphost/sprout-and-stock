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
  WAY_RULES, WAY_LOOKS, GLAZING_LOOKS, FENCE_LOOKS, wayBase, wayRule, wayLook, wayKind,
  glazingLook, glazingKind, fenceLook, fenceKind, edgeFamily, edgeW, edgeN, isIndoor,
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
    // Deliberately says nothing about doorways: one table serves three families
    // now, and "what a doorway has always been" is a sentence about a curtain
    // that is simply not true of one.
    sub: 'Shoppers and staff both, in and out. Nobody is turned back here.',
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
  // What a boundary is made of — see `FENCING`. Looks, like the glazings, so the
  // same sentence applies and is worth saying on each: swapping is free.
  panel: {
    name: 'Fence',
    short: 'Panel',
    icon: ICONS.plot,
    sub: 'Boarded panels. The plain one.',
  },
  hedge: {
    name: 'Hedge',
    short: 'Hedge',
    icon: ICONS.plot,
    sub: 'Planting, clipped square. Deeper than a panel, and nothing to paint.',
  },
  railing: {
    name: 'Railing',
    short: 'Rail',
    icon: ICONS.build,
    sub: 'Posts and a rail. Blocks the way and you see straight through it.',
  },
  low: {
    name: 'Low wall',
    short: 'Low',
    icon: ICONS.build,
    sub: 'Waist-high masonry. The one boundary that takes a finish.',
  },
  // ...and how a glazed doorway is glazed — see `WAY_LOOKS`. Looks again, so
  // swapping is free again, and both say so.
  transom: {
    name: 'Fanlight',
    short: 'Fanlight',
    icon: ICONS.ambient,
    sub: 'Glass in the band over the head. Lines up with a high window.',
  },
  shopfront: {
    name: 'Shopfront',
    short: 'Shop',
    icon: ICONS.ambient,
    sub: 'The same glass with no bar under it, in a slimmer frame. Lines up with a shopfront.',
  },
  // ...and what is hanging in a curtain's gap — see `WAY_LOOKS`. The same rule
  // either way, so swapping is free and the panel says so.
  strips: {
    name: 'Strips',
    short: 'Strips',
    icon: ICONS.build,
    sub: 'Plastic strips to the floor. Push through them, and goods go under.',
  },
  port: {
    name: 'Belt port',
    short: 'Port',
    icon: ICONS.build,
    sub: 'A small square hole down at belt height. Boxes go through, people do not.',
  },
};

/**
 * What each family is called, what its choice is called, and — where one way is
 * not on offer — why not.
 *
 * `noWay` used to be a ternary on `family === 'gate'` with the door's answer as
 * the else, which is the shape that breaks in whichever file adds the third
 * member: a curtain would have been told that it has the same on both sides,
 * about an edge with a shop one side of it and a stockroom the other. Two
 * families refuse one way and they refuse it for different reasons, so the
 * reason belongs beside the family.
 */
const FAMILY = {
  door: {
    what: 'Doorway',
    asks: 'Open to',
    noWay: 'One way needs an inside and an outside — this has the same on both sides.',
  },
  gate: {
    what: 'Gate',
    asks: 'Open to',
    noWay: 'A fence never makes a room, so there is no in or out here.',
  },
  // The second family with both axes, so it asks two questions — see the glazed
  // doorway below for what `looks` is. No `free` for the same reason that one
  // has none: the look is free, the family is not.
  curtain: {
    what: 'Strip curtain',
    asks: 'Open to',
    looks: 'Made of',
    noWay: 'Strips you push through both ways have no direction in them.',
  },
  // No `noWay`, and that is the same answer the doorway's is: a roller door
  // encloses, so anywhere it is a boundary it has an in and an out, and
  // `choicesFor` is what decides whether the two squares are on offer.
  shutter: {
    what: 'Roller door',
    asks: 'Open to',
    noWay: 'One way needs an inside and an outside — this has the same on both sides.',
  },
  // An arch offers two of the four for the reason a curtain does, and the wording
  // has to be its own: "strips have no direction in them" is nonsense said about
  // a hole, and the doorway's answer is wrong — an arch between the shop and the
  // street genuinely has an inside and an outside, and still cannot be one-way.
  arch: {
    what: 'Archway',
    asks: 'Open to',
    noWay: 'A hole with nothing in it has no way of showing which direction it lets you go.',
  },
  // The two families whose choice is a LOOK. `free` is what the panel says about
  // the price, and it is the surprising fact about both of them — a look must
  // never move a number, so there is nothing to pay. Said in the family's own
  // words, because "you keep the wall" is not true of a hedge.
  window: { what: 'Window', asks: 'Glazed', free: 'free — you keep the wall' },
  fence: { what: 'Boundary', asks: 'Made of', free: 'free — it is the same fence either way' },
  // The first family with BOTH axes, so it is the first with two questions —
  // `asks` is the rule, the way every opening's is, and `looks` names the other
  // row. `free` is deliberately absent: a look is free within this family and
  // the family itself is not free to get into, so the panel would be saying
  // "changing it costs nothing" over a square that swaps the rule.
  glazed: {
    what: 'Glazed doorway',
    asks: 'Open to',
    looks: 'Glazing',
    noWay: 'One way needs an inside and an outside — this has the same on both sides.',
  },
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
  // A boundary is the second family that is a look, and takes the window's
  // answer for the window's reason: there is nothing for a look to be
  // conditional on. A hedge is a hedge wherever it stands.
  if (fenceLook(kind)) return FENCE_LOOKS;
  const base = wayBase(kind);
  if (!base) return [];
  const all = WAY_RULES[base] ?? [];
  return isBoundary(L, at) ? all : all.filter((r) => r === 'all' || r === 'staff');
}

/**
 * The SECOND row, and it is empty for everything but a glazed doorway.
 *
 * A window and a boundary choose a look and nothing else; every other opening
 * chooses a rule and nothing else; and until `WAY_LOOKS` there was no edge in
 * the game that chose both, which is why this menu was one row for five
 * families. It takes no `L`, unlike `choicesFor` — a rule can be off the table
 * because of where the edge stands (one way needs an inside and an outside) and
 * a look never can. A fanlight is a fanlight wherever it is, which is the
 * sentence the glazings have always had.
 */
export function looksFor(kind) {
  const base = wayBase(kind);
  return (base && WAY_LOOKS[base]) || [];
}

/** What this edge's primary choice is right now — a rule, or a family's look. */
const choiceOf = (kind) => wayRule(kind) ?? glazingLook(kind) ?? fenceLook(kind) ?? null;

/**
 * ...and the kind that is this edge's family with that choice on it.
 *
 * Keyed off the family rather than off "is the choice a rule", because a rule
 * and a look cannot be told apart from the choice alone — and `wayKind` answers
 * `null` for anything it does not recognise, so getting this wrong is a menu
 * whose every square does nothing.
 *
 * It takes the KIND as well as the family now, and that is the whole of what a
 * second axis costs: pressing Shopfront has to keep the rule the door already
 * had, and pressing Staff has to keep the glazing. Read the other axis off the
 * edge in front of you or every square silently resets the one it does not
 * mention — a staff entrance restyled to a fanlight and quietly thrown open to
 * the town, which is a rule change wearing a look and nothing anywhere says so.
 */
const LOOK_KIND = { window: glazingKind, fence: fenceKind };
const kindFor = (kind, family, axis, choice) => {
  if (LOOK_KIND[family]) return LOOK_KIND[family](choice);
  const rule = axis === 'rule' ? choice : (wayRule(kind) ?? 'all');
  const look = axis === 'look' ? choice : wayLook(kind);
  return wayKind(family, rule, look);
};

/** Which axis this family's primary row sets. */
const primaryAxis = (family) => (LOOK_KIND[family] ? 'look' : 'rule');

/** Is there anything to open here at all? Asked by the hover and by the press. */
export const hasEdgeMenu = (L, at) => !!(L && at && edgeFamily(kindAt(L, at)));

/*
 * `sameFamily` lived here and is gone: it answered "is the tool you are holding
 * the same family as what is on this line", which was the test behind a tap with
 * the Doorway tool opening a doorway rather than rebuilding it. A family is the
 * set of things that swap for a refit, so with four glazings in the bar it read
 * a bay window aimed at a plain one as a question about the plain one — and a
 * tool aimed at a piece is the one moment you are certainly not asking. A tool
 * up builds now, and the menu is the press with no tool up.
 */

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
  const looks = looksFor(kind);
  const look = wayLook(kind);

  ui.openPanel = 'way';
  // ...and whoever's menu was open before this one is no longer the subject, so
  // their ring goes. A hire's marker means "this menu is about them" and nothing
  // else — unlike a fixture's, which doubles as the build selection R and M act
  // on and is meant to outlive the panel.
  ui.setWorkerRef(null);
  // Not a section, so nothing on the rail is lit — a fixture's menu and a hire's
  // both behave this way.
  ui.rail.setOpen(null);
  ui.wayRef = { o: at.o, x: at.x, z: at.z };
  ui.panelTick = tickEdge;
  ui._wayKey = `${kind}:${choices.join(',')}:${looks.join(',')}`;

  const info = CHOICE[choice] ?? CHOICE.all;
  const meta = FAMILY[family] ?? FAMILY.door;
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  // The one thing a square cannot say, and only where it is true: one way is
  // offered on a boundary that HAS an in and an out, so anywhere else the two
  // missing squares would read as a bug rather than as an answer.
  // Asked as "has this family got a rule at all" rather than as `!== 'window'`,
  // which is the predicate-against-the-only-member shape: with a second look
  // family in the table, the old test told a hedge that one way needs an inside
  // and an outside.
  const why = (meta.free || choices.includes('in')) ? null : meta.noWay;

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
      ${looks.length ? line(meta.looks, CHOICE[look]?.name ?? '—') : ''}
      ${meta.free ? line('Changing it', meta.free) : ''}
      ${why ? line('One way', `<i>${why}</i>`) : ''}
    </div>
  </div>`];

  // One row of exclusive choices rather than a list of switches: an edge has
  // exactly one answer to what it is, and two switches you could both turn on
  // would need a rule about which of them wins.
  //
  // ...and a second row where the family has two axes, which today is only the
  // glazed doorway. Two rows rather than one of everything, because the two are
  // *independent* — a staff fanlight and a staff shopfront door both exist —
  // and eight squares that are really 4x2 is a menu you have to read twice to
  // find out it is not offering eight things.
  const row = (axis, list, current) => {
    const squares = list.map((c) => {
      const i = CHOICE[c];
      return actIcon(`edge:${axis}:${c}`, i.icon, i.name, i.sub, i.short, { on: c === current });
    });
    return `<div class="fx-verbs">${squares.join('')}</div>`;
  };
  parts.push(`<div class="pnl-foot">${row(primaryAxis(family), choices, choice)}${
    looks.length ? row('look', looks, look) : ''}</div>`);

  // Titled by the family, which is the one word on this panel that stays true
  // whatever you press.
  ui.showPanel(`${info.icon} ${meta.what}`, parts.join(''), `way:${at.o}:${at.x},${at.z}`);
  wireEdgeMenu(ui, at, family, kind);
  return true;
}

function wireEdgeMenu(ui, at, family, was) {
  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    // `edge:<axis>:<choice>`. The axis is in the key rather than inferred from
    // the choice, because with two rows on one family the words no longer tell
    // them apart on their own — and a look read as a rule resolves to no kind
    // at all, which is a square that does nothing.
    const [tag, axis, choice] = el.dataset.act.split(':');
    if (tag !== 'edge' || !choice) return;
    el.onclick = () => {
      const kind = kindFor(was, family, axis, choice);
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
  const kind = kindAt(L, ui.wayRef);
  const key = `${kind}:${choicesFor(L, ui.wayRef).join(',')}:${looksFor(kind).join(',')}`;
  if (key !== ui._wayKey) showEdgeMenu(ui, ui.wayRef);
}
