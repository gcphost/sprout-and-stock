import { ICONS, icon } from './icons.js';
import { money, signed } from './money.js';
import { pinLast, KEYED } from './bar.js';
import { FIXTURES, isProp, isGround, FLOOR_KIND } from '../shared/build.js';
import { kindOf, countKey } from '../shared/pieces.js';
import { variantsOf } from '../shared/model.js';
import { artForTool, artForWorker } from './thumb.js';
import { doingNow, bodyOf, kindSummary } from './worker-menu.js';
// What is on a van. Shared with the shelf menu, which asks the same two
// questions of it — see client/orders.js.
import { comingByItem, comingWhy, nextVan } from './orders.js';

/**
 * Every browsable list that renders into #panel.
 *
 * A section describes its rows; it never touches the DOM. `UI.showSection`
 * renders, filters and wires them, which is what lets search and the tag chips
 * work everywhere for free — including in sections that don't exist yet.
 *
 * Adding a menu is one entry in SECTIONS. The rail reads this same array, so a
 * new section gets its icon, its hotkey and its badge with no other change.
 */

/**
 * The top tier of the build bar: what sort of thing you are putting down.
 *
 * A flat palette was fine at nine entries and stops being fine the moment the
 * catalog is a database anyone can write to — the bar was already spilling past
 * the number keys with five pieces authored, and a tenth button with no key on
 * it reads as broken. So the bar asks the coarse question first and the fine one
 * second, the way a city builder's toolbar does.
 *
 * The split is by *what you are doing*, not by which code path places it: a
 * fence is drawn on an edge exactly the way a wall is, and it sits under Farm
 * because fencing a field is farming and walling a room is building. That is
 * also why one tool may name more than one group — knocking a hole through is
 * how you take a fence out as well as a wall, and making you change tab to undo
 * the thing you just drew is the kind of tidiness nobody asked for.
 *
 * Groups with nothing in them never render, the same way an empty tab bucket
 * doesn't (`grouped`). A world where nobody has authored an appliance has four
 * tabs, not five with one that opens onto nothing.
 *
 * A group may split again, and Building is the one that had to. It began as
 * three edge tools and collected the floor catalogue and both yard pads, so it
 * was a dozen entries and the only tab you had to scroll — which hides its far
 * end behind a gesture nobody makes on a strip that looks complete. `subs` is
 * the same tab shape one level down and is drawn by the same code; the split is
 * still by what you are doing, so laying a floor and painting a bay are two
 * jobs even though they are one brush. Subs are resolved exactly like groups
 * below: empty ones are dropped, and a tab left with fewer than two of them
 * shows none at all.
 */
/**
 * Decoration's sub-tabs, and the one split filed by TAG rather than by kind.
 *
 * Building splits by what you are doing and every entry names its sub-tab in
 * code, which works because a wall, a floor and a bay are three kinds. A
 * decoration is one kind wearing any number of hats: `prop-floor` and
 * `prop-ceiling` say how a thing attaches, and a planter and a barrel attach
 * identically. So the code that could file these does not know what they are,
 * and the row that knows is in the database — which is the same shape of
 * problem as "what do customers want", and gets the same answer.
 *
 * `tags` on a sub is therefore the whole mechanism: a piece tagged `plant`
 * lands under Greenery about a second after somebody authors it, with no edit
 * here. What IS a decision here is the vocabulary — one tab per tag, named and
 * iconed — and a tab nobody has authored anything for never renders, so
 * declaring one costs nothing until it has something in it.
 *
 * The last has no tags and takes the rest. That is deliberate and it is the
 * half a tag-driven split gets wrong: a decoration authored with no tag, or
 * with a tag nobody has made a tab for, has to be SOMEWHERE — otherwise the
 * first thing an untagged piece does is disappear, which reads as a bad save
 * rather than as a missing word.
 */
export const DECOR_SUBS = [
  {
    id: 'plants',
    name: 'Greenery',
    icon: ICONS.seeds,
    tags: ['plant'],
    blurb: 'Things that grow, or look like they do. Nothing to water.',
  },
  {
    id: 'lighting',
    name: 'Lighting',
    icon: ICONS.ambient,
    tags: ['lamp'],
    blurb: 'What the shop looks like once the light comes off something you chose.',
  },
  {
    id: 'signs',
    name: 'Signs',
    icon: ICONS.label,
    tags: ['sign'],
    blurb: 'Words on the shop floor. Nobody reads them but you.',
  },
  {
    id: 'bits',
    name: 'Odds and ends',
    icon: ICONS.fixtures,
    blurb: 'Everything else you can stand about the place.',
  },
];

export const BUILD_GROUPS = [
  { id: 'shop', name: 'Shop', icon: ICONS.shelf, blurb: 'Where goods sit and money changes hands.' },
  { id: 'farm', name: 'Farm', icon: ICONS.plot, blurb: 'Beds to grow in, and what fences them off.' },
  { id: 'appliance', name: 'Appliances', icon: ICONS.station, blurb: 'Machines that turn stock into something worth more.' },
  {
    id: 'shell',
    name: 'Building',
    icon: ICONS.build,
    blurb: 'The building itself — what makes a room a room.',
    // In the order you do them: walls make the room, floor makes it usable, and
    // the yard is what you lay once the shop it serves exists. The last two are
    // the same brush laying ground for *people* rather than for the building —
    // yours, and then everybody else's.
    subs: [
      {
        id: 'walls',
        name: 'Walls',
        icon: ICONS.build,
        blurb: 'Drawn along the lines between tiles. Anything they close in is indoors.',
      },
      {
        id: 'floors',
        name: 'Floors',
        icon: ICONS.floor,
        blurb: 'What a shelf needs under it. Walls alone only make a room.',
      },
      // The ways in, and the one sub-tab that is not about the building at all.
      //
      // Road and pavement started on Floors, filed by a fact about the code —
      // both are ground that is a *look*, the way a floor is, and neither
      // carries a job the way the four pads do. That is true and it is not what
      // anybody is looking for a road under. What these two have in common with
      // each other is the thing a player has in mind when they reach for one:
      // how anything gets here. What they have in common with Pine Boards is
      // how they are implemented.
      //
      // Both of them, together, for the reason neither Yard nor Customers could
      // hold either: a van and a shopper's car drive the same tarmac, and the
      // pavement beside it is walked by staff, shoppers and you.
      {
        id: 'roads',
        name: 'Roads',
        icon: ICONS.move,
        blurb: 'How everybody gets here. Vehicles take the cheapest lane and feet take the paved way, so what you lay is the way in.',
      },
      {
        id: 'yard',
        name: 'Yard',
        icon: ICONS.crate,
        blurb: 'Where deliveries land, and where stock waits to be shelved.',
      },
      // Its own tab rather than a third swatch under Yard, and the distinction
      // is the player's rather than the code's: the yard is where the goods go
      // and this is where the people go. A break area is as often a corner of
      // the shop floor as it is out the back, so filing it under Yard would put
      // it behind the one word that says it is not indoors.
      {
        id: 'staff',
        name: 'Staff',
        icon: ICONS.staff,
        blurb: 'Ground for the people who work here. Paint a break area and that is where they rest.',
      },
      // And the same argument once more, one step further out. Staff is ground
      // for the people on your payroll; this is ground for everybody else. A
      // car park is not the yard — the yard is where the goods arrive and this
      // is where the people do — and it is not Staff either, because a customer
      // does not work here. Its own tab is the only place that is true of it.
      {
        id: 'customers',
        name: 'Customers',
        icon: ICONS.walk,
        blurb: 'Ground for the people who come to buy. Paint a car park and that is where they leave the car.',
      },
    ],
  },
  {
    id: 'decor',
    name: 'Decoration',
    icon: ICONS.fixtures,
    blurb: 'Looks. Weighs nothing and stops nobody.',
    subs: DECOR_SUBS,
  },
];

/** Whether a palette entry belongs to a group. A tool may name several. */
const inGroup = (t, id) => (Array.isArray(t.group) ? t.group.includes(id) : t.group === id);

/** The same question one level down. A tool may name several sub-tabs too. */
const inSub = (t, id) => (Array.isArray(t.sub) ? t.sub.includes(id) : t.sub === id);

/**
 * Which sub-tab of a split group an entry sits on.
 *
 * Three answers in order, and the order is what lets one mechanism carry both
 * splits. A tool that NAMES its sub-tab wins — that is Building, where the
 * filing is a fact about the code (`sub: 'walls'`) and could not be anything
 * else. Failing that, a sub-tab that asks for a TAG takes anything wearing it —
 * that is Decoration, where the filing is a fact about the content, because a
 * planter and a barrel are the same kind and only their row knows the
 * difference.
 *
 * Then the catch-all, which is the first sub-tab that asks for no tags. For
 * Building that is Walls, so it is exactly the fallback that was here before:
 * an entry on no sub-tab is one no tab shows, which is the same as not
 * existing, and misfiled beats invisible. For Decoration it is the drawer at
 * the end, which is the honest home for a piece nobody has tagged yet.
 */
const subIdFor = (g, t) => g.subs.find((s) => inSub(t, s.id))?.id
  ?? g.subs.find((s) => s.tags?.some((tag) => t.tags?.includes(tag)))?.id
  ?? g.subs.find((s) => !s.tags)?.id
  ?? g.subs[0]?.id ?? null;

/** Which sub-tab a palette entry is found on, for a selection made elsewhere. */
export function subOfTool(t, groupId) {
  const g = BUILD_GROUPS.find((x) => x.id === groupId);
  return g?.subs && t ? subIdFor(g, t) : null;
}

/**
 * What each buildable KIND is, for a palette entry that names one.
 *
 * The icon, the group and the blurb are per kind rather than per piece, because
 * they describe the rules — where it goes, what it is for — and every design of
 * a shelf is a shelf. What a piece brings is its own name, its own art and its
 * own price; if a planter and a barrel need different words, they are different
 * kinds or they are the same thing with two looks.
 *
 * Kinds in palette order, within their group. A kind missing from here still
 * builds — it just gets the generic icon, which is the honest answer for one
 * nobody has described.
 */
export const KIND_TOOLS = {
  shelf: {
    icon: ICONS.shelf,
    group: 'shop',
    blurb: 'Anything that needs no freezing. Browsed from the side it faces.',
  },
  freezer: {
    icon: ICONS.freezer,
    group: 'shop',
    blurb: 'The only home for frozen goods. Four times the shelf life.',
  },
  checkout: {
    icon: ICONS.checkout,
    group: 'shop',
    blurb: 'Takes money. Needs a clear run alongside for the queue.',
  },
  plot: {
    icon: ICONS.plot,
    group: 'farm',
    blurb: 'Earth, outside. Turn it over before it takes a seed.',
  },
  'prop-floor': {
    icon: ICONS.fixtures,
    group: 'decor',
    blurb: 'Stands on the floor and stops nobody. Indoors or out.',
  },
  'prop-ceiling': {
    icon: ICONS.ambient,
    group: 'decor',
    blurb: 'Hangs from the ceiling, so it needs a room to hang in.',
  },
  floor: {
    icon: ICONS.floor,
    // Under Building rather than Decoration, which it visibly is not: laying
    // floor is how a walled annex stops being a walled field. Walls make the
    // room, floor makes it usable, and finding those on two different tabs
    // would hide the second half of a job from anyone doing the first.
    group: 'shell',
    sub: 'floors',
    blurb: 'Drag out an area. Floor is what a shelf needs under it — walls alone only make a room.',
  },
  // The yard, which is the same brush laying ground that carries a job rather
  // than a look. Under Building, because it is drawn the way floor is — but on
  // its own sub-tab, because what it is *for* has nothing to do with how the
  // shop looks: you pick a floor by taste and a bay by how big a delivery you
  // want to take.
  bay: {
    icon: ICONS.crate,
    group: 'shell',
    sub: 'yard',
    blurb: 'Drag out an area. Wholesale orders land here as pallets — make it bigger to take bigger deliveries.',
  },
  drop: {
    icon: ICONS.crate,
    group: 'shell',
    sub: 'yard',
    blurb: 'Drag out an area. Where hands get cleared and stock waits to be shelved. Indoors it is a stockroom.',
  },
  // The same brush again, laying ground that carries a job for the staff rather
  // than for the stock.
  break: {
    icon: ICONS.staff,
    group: 'shell',
    sub: 'staff',
    blurb: 'Drag out an area. Staff take their breaks here instead of wherever they finished, and come back fresher. One cell seats one.',
  },
  // The fourth pad, on the one sub-tab where it is not filed under somebody
  // else's job.
  park: {
    icon: ICONS.walk,
    group: 'shell',
    sub: 'customers',
    blurb: 'Drag out an area. Hardstanding out front for shoppers who drive here — one cell parks one, and they walk in from where they left it.',
  },
  // The two ways in, on their own tab. See the `roads` sub-tab for why they are
  // not filed with the floors they are built like.
  road: {
    icon: ICONS.move,
    group: 'shell',
    sub: 'roads',
    blurb: 'Drag out an area. Vans and shoppers’ cars come in on whichever way is cheapest, and they would rather drive on this than on your grass.',
  },
  path: {
    icon: ICONS.walk,
    group: 'shell',
    sub: 'roads',
    blurb: 'Drag out an area. Anybody walking outdoors would rather go round on this than cut across the grass. A striped one laid over a road is a crossing.',
  },
};

export const BUILD_TOOLS = [
  // The shell. These go on the lines *between* tiles rather than on a tile, so
  // they aim differently — `Scene.pickEdge` rather than `pickTile` — but they
  // sit in the same palette because from the player's side it is all building.
  {
    id: 'wall',
    edge: 1,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.build,
    name: 'Wall',
    blurb: 'Encloses. Anything the walls close in counts as indoors.',
  },
  {
    id: 'window',
    edge: 2,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.ambient,
    name: 'Window',
    blurb: 'A wall you can see through. Still encloses.',
  },
  {
    id: 'door',
    edge: 3,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.shop,
    name: 'Doorway',
    blurb: 'A way through. Still counts as part of the enclosure.',
  },
  // Fences. Same tool, same drag, same lattice — and deliberately not the same
  // *meaning*: a fence never encloses (`ENCLOSING`, shared/edges.js), so fencing
  // a field can't accidentally roof it and turn every bed in it indoors. That is
  // why the farm can be fenced at all, and it is the whole of step 11: the shop
  // used to draw one for you, hugging the bounding box of wherever your plots
  // happened to be, which meant it moved every time you dug a bed.
  {
    id: 'fence',
    edge: 5,
    group: 'farm',
    icon: ICONS.plot,
    name: 'Fence',
    blurb: 'Marks out the farm. Blocks the way, but never makes a room.',
  },
  {
    id: 'gate',
    edge: 4,
    group: 'farm',
    icon: ICONS.build,
    name: 'Gate',
    blurb: 'A way through a fence.',
  },
  // The bulldozer, and it is on every tab because "get rid of that" is not a
  // question about what sort of thing it is.
  //
  // It was `knock`, which took walls and fences out and nothing else, while
  // every fixture was removed from its own menu instead — two gestures for one
  // idea, and the reason nobody could find either. Aiming at a thing tears that
  // thing out; dragging along a line knocks the wall through. `edge: 0` is that
  // second half, so a drag still reaches the same `build-edge` message.
  //
  // A Clear tool did exist once and was retired for eating seven shelves in a
  // row. That version fired on *proximity* and re-armed the moment it finished,
  // so standing still emptied the shop while you read the log. This one names
  // its target the way every build verb does now: it removes what is ringed
  // under the pointer, one tap each, and the server refuses anything with
  // contents or your last till.
  {
    id: 'demolish',
    edge: 0,
    demolish: true,
    last: true,
    group: ['shop', 'farm', 'appliance', 'shell', 'decor'],
    icon: ICONS.remove,
    name: 'Demolish',
    blurb: 'Tap a thing to tear it out, or drag along a wall to knock it through. Half back either way.',
  },
];

/**
 * The palette: one entry per thing you can put down.
 *
 * Lives here rather than in ui.js because both the panel and the bottom hotbar
 * render from it, and a palette that disagreed with itself between the two is
 * how you end up pressing 2 and getting a till.
 *
 * Generated from the catalog rather than listed here, which is the whole of the
 * kinds/pieces split seen from the player's side. A second shelf design, a
 * terracotta planter and a hanging bulb are rows in a table, so they arrive on
 * this bar about a second after somebody authors them and no code changed.
 *
 * Three sources, in the order they read: pieces, then the shell, then
 * appliances. An appliance is still an upgrade rather than a piece — moving it
 * across is the economy step, and doing half of it here would leave the ledger
 * counting one thing and the palette selling another.
 *
 * A kind with no piece authored still appears, because a fixture kind is
 * buildable whether or not anybody has drawn it — an undrawn shelf renders as a
 * plain block and always has. Props are the exception on purpose: a prop *is*
 * its art, so an undrawn one is nothing and is not offered. `Game.pieceId` makes
 * exactly the same call on the server, which is what stops the palette offering
 * something the server would then refuse.
 */
export function buildTools(ui) {
  const rows = ui?.catalog?.fixtures ?? [];
  const pieces = [];
  for (const kind of Object.keys(KIND_TOOLS)) {
    const mine = rows.filter((p) => kindOf(p) === kind);
    // A kind that *is* its art gets no entry until somebody draws one. Props
    // were the original case — an undrawn planter is nothing — and a floor is
    // the same claim from the other end: an undrawn floor has no colour, so
    // offering one would be a button that paints the ground the shade the
    // renderer happens to default to.
    const artOnly = isProp(kind) || isGround(kind);
    const entries = mine.length ? mine : (artOnly ? [] : [{ id: kind, name: FIXTURES[kind]?.label ?? kind }]);
    for (const p of entries) {
      const paint = isGround(kind);
      pieces.push({
        id: p.id,
        kind,
        piece: p.id,
        // A picture of the thing, off its own row, IN THE SHAPE YOU LAST CHOSE
        // for it. `icon` stays as the fallback for a kind nobody has drawn —
        // those are the entries with no `p.model` to draw, and a generic box
        // would claim they look like something.
        //
        // The shape belongs here rather than only on the ghost because the tile
        // is a promise about what the next tap builds: pick the wall-run shelf,
        // and a tile still drawing the standard one is the palette disagreeing
        // with the preview, the popover's own tick and the shelf you get.
        art: artForTool({ paint, kind }, p, ui?.pieceVariant?.[p.id] ?? ''),
        // What the gesture is. A fixture is tapped onto a tile, a wall is
        // dragged along a line, and this one is dragged over an area — the bar
        // needs to know which without asking the kind, because `edge` already
        // works exactly this way for walls.
        ...(paint ? { paint: true } : {}),
        icon: KIND_TOOLS[kind]?.icon ?? ICONS.fixtures,
        // A kind nobody grouped lands in the shop rather than nowhere: an entry
        // in no group is one no tab shows, which is the same as not existing.
        group: KIND_TOOLS[kind]?.group ?? 'shop',
        sub: KIND_TOOLS[kind]?.sub,
        // What the row says it IS, which is the only thing that can file two
        // pieces of one kind apart — see `DECOR_SUBS` and `subIdFor`. Off the
        // piece rather than the kind, deliberately: a kind's tags would be the
        // same word on every entry in the tab, which sorts nothing.
        tags: p.tags ?? [],
        name: p.name,
        blurb: KIND_TOOLS[kind]?.blurb ?? '',
      });
    }
  }

  // Taking floor back up, offered only once there is any floor to take up.
  //
  // Not the bulldozer, and that is worth defending because "two gestures for one
  // idea" is exactly the mistake Demolish was built to fix. The bulldozer's drag
  // is already spoken for: it runs along a lattice LINE to knock a wall through,
  // and there is no way to tell that drag apart from one over an area. So this
  // is the floor palette's own null entry — the same shape as Doorway sitting in
  // the wall palette as the wall that isn't one — rather than a second
  // everything-remover.
  if (pieces.some((p) => p.paint)) {
    pieces.push({
      id: 'floor:none',
      kind: FLOOR_KIND,
      piece: '',
      paint: true,
      group: 'shell',
      sub: 'floors',
      icon: ICONS.remove,
      // Grass, not a dustbin. It is the same question as the five swatches
      // beside it — what the ground looks like when you have finished — and
      // answering four pictures with a verb makes taking a floor up read as a
      // different kind of act from laying one.
      art: artForTool({ paint: true }, null),
      name: 'Bare Ground',
      blurb: 'Takes the floor back up. Indoors that leaves a cell nothing can use — outdoors it is grass again.',
    });
  }

  // An appliance is still an upgrade rather than a piece, so it has no row of
  // its own — but it is not artless: each machine is a *variant* of the one
  // `station` row, which is how the renderer draws them too.
  const machine = rows.find((p) => kindOf(p) === 'station');
  const stations = (ui?.catalog?.upgrades ?? [])
    .filter((u) => u.kind === 'station' && u.payload?.station)
    .map((u) => ({
      id: `station:${u.payload.station}`,
      kind: 'station',
      station: u.payload.station,
      group: 'appliance',
      icon: ICONS.station,
      // An appliance IS a variant, so it draws the way every other shape does.
      art: artForTool({ kind: 'station' }, machine, u.payload.station),
      name: u.name,
      blurb: u.description || 'An appliance. Turns what goes in into something worth more.',
    }));

  // A wall has no row to draw — the renderer builds one from `EDGE_STYLE` — so
  // its art is built from that same record. See `client/thumb.js`.
  const shell = BUILD_TOOLS.map((t) => ({ ...t, art: artForTool(t, null) }));

  return [...pieces, ...shell, ...stations];
}

/**
 * The palette as the bar draws it: groups, each carrying its own entries.
 *
 * Derived from the flat list rather than replacing it, because everything that
 * resolves a tool by id — the ghost, the hint, the server's disarm — wants one
 * list with unique ids and no notion of which tab is showing.
 */
export function buildGroups(ui) {
  const cash = ui?.state?.cash ?? 0;
  const tools = buildTools(ui).map((t) => {
    const cost = ui?.buildCosts?.[t.id];
    // How many of these are standing in the shop. It was a line of the old
    // panel's row copy, and it is the half worth keeping — "six owned" is what
    // decides whether a seventh is the buy.
    const have = ownedCount(ui, t);
    // What you cannot afford, said on the button rather than after the tap. The
    // server has always refused it (`placeFixture` checks the cash last, after
    // every rule about the tile), so the only thing this changes is WHERE you
    // find out: a lit tile, a ghost, a tap and a refusal, against a tile that
    // was never offering.
    //
    // Per unit for the brushes, which is the honest test a price per tile can
    // support — affording a cell of tarmac is not affording the drive, and the
    // drag prices itself as you pull it out.
    const poor = cost != null && cost > cash;
    return {
      ...t,
      note: cost == null ? '' : money(cost),
      poor,
      badge: have ? String(have) : '',
      // The shortfall goes in the tip, because the tile has room for the price
      // and not for the arithmetic — and greyed-out with no reason given is the
      // one state where somebody would otherwise think the button was broken.
      title: `${t.name} — ${t.blurb}${poor ? ` · ${money(cost)} and you have ${money(cash)}` : ''}`,
      // Whether this one comes in shapes, which is what earns the tile its
      // chevron and makes a hold on it mean something. Asked of the PIECE, since
      // that is what `variantsOf` reads and what the popover will offer — a tool
      // with no piece (a wall, a brush, the bulldozer) answers Standard-only and
      // gets no chevron, which is the honest answer for a thing with one shape.
      shapes: variantsOf((ui?.catalog?.fixtures ?? []).find((x) => x.id === t.piece)).length >= 2,
    };
  });
  return BUILD_GROUPS
    .map((g) => {
      const items = pinLast(tools.filter((t) => inGroup(t, g.id)));
      return { ...g, items, subs: splitGroup(g, items) };
    })
    // A tab holding nothing but the bulldozer opens onto nothing you can build,
    // which is worse than no tab — and it is what an Appliances tab looks like
    // in a world where nobody has authored a machine yet. Pinned entries do not
    // count towards a tab earning its place.
    .filter((g) => g.items.some((t) => !t.last));
}

/**
 * A group's sub-tabs, or null for a group that doesn't earn any.
 *
 * Three rules, and the first is about the tab rather than the split: a tab that
 * FITS is left alone. `KEYED` is how many entries wear a number key, so at or
 * under it nothing scrolls, every button is one press, and splitting can only
 * turn one row you can read into four rows of two you have to choose between
 * first. Decoration is why: seven planters and signs is a palette, and the
 * moment it is fifteen it is a drawer you rummage in. The bar should change
 * when the catalogue does, not when somebody predicted it would.
 *
 * Then the two the tabs above them already follow, one level down: an empty
 * sub-tab never renders, and a group left with fewer than two of them shows the
 * flat list instead — one sub-tab is a row of chrome asking a question with a
 * single answer. That is what a world with no floors authored gets, and it means
 * the split can never make a tab *harder* to read than it was flat.
 *
 * Pinned entries are on every sub-tab, the way Demolish is on every tab: "get
 * rid of that" is not a question about which part of the building it is. They
 * count towards the length, because they are buttons on the row and they take
 * number keys off the end of it.
 */
function splitGroup(g, items) {
  if (!g.subs || items.length <= KEYED) return null;
  const subs = g.subs
    .map((s) => ({ ...s, items: items.filter((t) => t.last || subIdFor(g, t) === s.id) }))
    .filter((s) => s.items.some((t) => !t.last));
  return subs.length >= 2 ? subs : null;
}

/** Which tab a palette entry is found under, for a selection made elsewhere. */
export function groupOfTool(t) {
  return BUILD_GROUPS.find((g) => t && inGroup(t, g.id))?.id ?? null;
}

/**
 * The roster, as tabs for the same bar the palette uses.
 *
 * "All" first whenever anybody works here, because with four hires that is the
 * only tab anybody wants; the per-kind tabs earn their place at twenty. Those
 * are generated from who actually works here rather than from the `workers`
 * table — a tab for a kind you have never hired is a tab that opens onto
 * nothing, and the one for the kind you just took on should appear without
 * anybody listing it here. Hiring is the last tab, reads the table instead, and
 * in a shop with nobody in it is the only tab there is.
 *
 * The entry for a person carries what they are doing right now as its note, so
 * the bar is a standing answer to "who is on the tills" without opening
 * anything. `warn` is for somebody the sim cannot place — their kind was
 * deleted out from under them — which is a problem rather than a job.
 */
export function staffGroups(ui) {
  const roster = ui.state?.roster ?? [];
  const kinds = ui.catalog.workers ?? [];
  const nameOfKind = (id) => kinds.find((w) => w.id === id)?.name ?? id;

  const skins = ui.catalog.skins ?? [];
  const kindRow = (id) => kinds.find((w) => w.id === id) ?? null;

  const person = (e) => {
    const body = bodyOf(ui, e);
    return {
      id: `hire:${e.id}`,
      hire: e.id,
      // Them, at their grade and in their skin — not the staff glyph, which
      // drew four different people as four copies of one silhouette. `icon` is
      // still here as the fallback, for a hire whose kind was deleted out from
      // under them: there is no art to draw, and that is exactly the entry that
      // must not disappear.
      art: artForWorker(kindRow(e.kind), e.tier, skins.find((s) => s.id === e.skin) ?? null),
      icon: icon(e.kind, ICONS.staff),
      name: e.name,
      note: doingNow(ui, e, body),
      // What they were taken on as, said once, in the one place there is room
      // for it. A hire's name used to BE their kind — "Stocker 3" — so the
      // roster answered "what do they do" for free and stopped the day people
      // got names of their own. The art still shows it and the menu still
      // prints it, but neither is readable at a glance across six tiles.
      title: `${e.name} — ${nameOfKind(e.kind)}, ${doingNow(ui, e, body)}`,
      warn: !body,
    };
  };

  // Taking somebody on is a TAB, not an entry pinned to the end of every other
  // one. It was that entry, and the entry was a door to a panel that then said
  // the same thing over the top of the bar it had been pressed on: with nobody
  // hired yet the whole strip was one button whose only job was to open a list
  // — plus a rail icon, plus a hint line, all four saying "you can hire
  // someone".
  //
  // The bar can hold the list. A kind wears its price as its note exactly as a
  // fixture in the palette does, and how many of them already work here as its
  // badge, which is the count the palette prints too. Pressing one HIRES —
  // there is no menu behind it, because the tile already says the name, the
  // price and how many you have, and a second screen repeating that is the
  // thing this replaced.
  // Pressing one of these HIRES, with no menu in between, so it is the one bar
  // where a tile you cannot afford spends a press and gets an error. Same test
  // `hire` makes on the server, in the same words the palette uses.
  const cash = ui.state?.cash ?? 0;
  const forHire = kinds.map((w) => ({
    id: `kind:${w.id}`,
    kind: w.id,
    poor: w.cost > cash,
    // How they turn up: the bottom rung, in the colours they were drawn in —
    // the same call `artForModel` makes about selling the battered freezer
    // rather than the chrome one.
    art: artForWorker(w, 1, null),
    icon: icon(w.id, ICONS.staff),
    name: w.name,
    note: money(w.cost),
    badge: roster.filter((e) => e.kind === w.id).length || null,
    title: `${w.name} — ${kindSummary(w)}${
      w.cost > cash ? ` · ${money(w.cost)} and you have ${money(cash)}` : ''}`,
  }));

  const seen = [...new Set(roster.map((e) => e.kind))];
  return [
    // No roster means no tabs about the roster: "Everyone" over an empty strip
    // is a tab that opens onto nothing, and the fall-through in `groupAt` then
    // lands you on Hire, which is the only thing there is to do.
    ...(roster.length ? [
      { id: 'all', name: 'Everyone', icon: ICONS.staff, blurb: 'Everybody on shift.', items: roster.map(person) },
      ...seen.map((k) => ({
        id: `kind:${k}`,
        name: nameOfKind(k),
        icon: icon(k, ICONS.staff),
        blurb: `Everyone taken on as a ${nameOfKind(k).toLowerCase()}.`,
        items: roster.filter((e) => e.kind === k).map(person),
      })),
    ] : []),
    {
      id: 'hire',
      name: 'Hire',
      icon: ICONS.upgrades,
      blurb: 'Take somebody new on.',
      items: forHire,
    },
  ];
}

/** How many of this palette entry are standing in the shop. */
export function ownedCount(ui, t) {
  if (t.edge !== undefined) return null;
  return ui.fixtureCounts?.[countKey(t.kind, { station: t.station, piece: t.piece })] ?? null;
}

/**
 * Kinds that are no longer things you buy, and why each one stopped being one.
 *
 * None of them are deleted. A `staff` row is what an old save's people were
 * *made of* — `rosterFromUpgrades` reads it once to migrate them onto the roster
 * — so the row has to keep existing even though `buyUpgrade` has refused it
 * since hiring moved. Deleting them would take those hires with them.
 */
const RETIRED = {
  // Hiring is the roster now: two of somebody, letting one go, promotions.
  // An upgrade is a permanent boolean and can express none of that.
  staff: true,
  // The shop used to grow by buying land and letting the generator re-flow it.
  // You draw your own walls, so the shape of the building is something you make
  // rather than something you unlock — and an upgrade that silently rearranged
  // the place you had just laid out was the last thing doing that.
  space: true,
  // An appliance is not something you own — it is the price of that machine,
  // and you buy machines in build mode, one at a time, on a tile you chose.
  station: true,
};

/**
 * The upgrades still worth listing: the ones nothing else already sells you.
 *
 * A shelf, a freezer, a till and a plot used to be here as packs — buy "Extra
 * Shelving" from a menu and let the generator decide where three shelves went,
 * which is the blinder half of a purchase build mode replaced. Those rows are
 * back on this list and they sell something else now: a standing rate on every
 * one of that kind you ever put down. See `fixtureDiscount` on the server.
 */
export function buyableUpgrades(ui) {
  return (ui?.catalog?.upgrades ?? []).filter((u) => !RETIRED[u.kind]);
}

/**
 * What is left, as tabs for the bar.
 *
 * Grouped by who the money is spent on rather than by `kind`, which would be
 * seven tabs of one row each. A fixture discount, a bigger rucksack and a better
 * postcode are three genuinely different decisions and one of them is a list.
 */
export const UPGRADE_GROUPS = [
  {
    id: 'fixtures', name: 'Fixtures', icon: ICONS.shelf,
    blurb: 'A standing discount on everything of that kind you build from now on.',
    kinds: ['shelf', 'freezer', 'plot', 'checkout'],
  },
  {
    id: 'you', name: 'You', icon: ICONS.staff,
    blurb: 'What you can carry and how fast you get there.',
    kinds: ['capacity', 'speed'],
  },
  {
    id: 'shop', name: 'The shop', icon: ICONS.shop,
    blurb: 'Who walks past, and what they think of the place.',
    kinds: null,
  },
];

export function upgradeGroups(ui) {
  const owned = ui?.ownedUpgrades ?? [];
  const cash = ui?._cash ?? 0;
  const rows = buyableUpgrades(ui).map((u) => {
    const have = owned.includes(u.id);
    const locked = (u.requires ?? []).filter((r) => !owned.includes(r));
    return {
      id: u.id,
      upgrade: u.id,
      kind: u.kind,
      icon: ICONS.upgrades,
      name: u.name,
      note: have ? 'owned' : money(u.cost),
      badge: have ? '✓' : '',
      // Dim is not a thing the bar draws, so an entry you cannot act on says so
      // in the one line it has. A locked row still shows: what it needs first is
      // the reason to go and buy that, and hiding it hides the ladder.
      warn: !have && (locked.length > 0 || cash < u.cost),
      title: `${u.name} — ${u.description}`,
    };
  });
  return UPGRADE_GROUPS
    .map((g) => ({
      ...g,
      items: rows.filter((r) => (g.kinds ? g.kinds.includes(r.kind) : !UPGRADE_GROUPS
        .some((o) => o.kinds?.includes(r.kind)))),
    }))
    .filter((g) => g.items.length);
}

/** Shelves at or under this fraction of a stack are worth restocking. */
const LOW_STOCK = 0.2;

/**
 * Profit for each finished day the snapshot carries, oldest first.
 *
 * The Shop report and its own rail badge both need it and would otherwise
 * subtract the same two fields in two places — which is how one of them ends up
 * quietly measuring revenue while the other measures profit.
 */
const dayProfits = (state) => (state?.ledger ?? []).map((d) => (d.revenue ?? 0) - (d.spent ?? 0));

/**
 * What a daily cap may be set to, in the order pressing the row walks them.
 *
 * A ring of presets rather than a number field, because the supplier is a
 * 214px list of rows you press and one text input in the middle of it is a
 * different kind of control that needs a keyboard, a commit and an undo. The
 * ring wraps back to "no cap", so every value including off is reachable
 * without ever leaving the row — and nothing can be typed that the server
 * would then have to argue with.
 */
const ORDER_CAPS = [null, 25, 50, 100, 250, 500, 1000];
const capLabel = (n) => (n > 0 ? money(n) : 'No cap');

/**
 * Every item, as a row that says what to do about it.
 *
 * The three things a shopkeeper is actually asking of this list — how many have
 * I got, does anybody want it, and have I anywhere to put it — were none of
 * them on it. It showed a price and three tags, which is a catalogue entry, and
 * a catalogue cannot answer "should I buy eggs".
 *
 * `short` and `hot` are computed here rather than in the buckets below, because
 * the row wants to *say* which one it is: a tab that sorts you into a pile and
 * then doesn't tell you why is the same scrolling problem one level up.
 */
function itemRows(ui) {
  const shelves = ui.state?.shelves ?? [];
  const hasFreezer = shelves.some((s) => s.kind === 'freezer');
  const cash = ui._cash ?? 0;
  // Anything a recipe outputs cannot be ordered at all — `buyStock` refuses it,
  // and it has refused it since appliances existed. The supplier listed them
  // anyway, with a buy button and two steppers that could do nothing, which is
  // three lies per row. The client already had the recipes; it had never asked.
  const madeBy = new Map();
  for (const r of ui.catalog.recipes ?? []) if (!madeBy.has(r.output_id)) madeBy.set(r.output_id, r.station);
  const applianceName = (id) => (ui.catalog.fixtures ?? []).find((f) => f.id === id)?.name ?? id;
  const coming = comingByItem(ui);

  return ui.catalog.items.map((it) => {
    const rule = ui.state?.orders?.items?.[it.id] ?? {};
    const held = ui.heldOf(it.id);
    const due = coming.get(it.id) ?? null;
    const inbound = due?.qty ?? 0;
    const stack = it.stack ?? 12;
    const heat = ui.heatFor(it);
    const needsCold = it.tags.includes('needs-freezer') || it.tags.includes('frozen');
    // Nowhere to put it is a stronger fact than anything about demand: buying
    // it is a mistake whatever the town thinks, and the old tabs said so only
    // by which of three headings you happened to be under.
    const homeless = needsCold && !hasFreezer;
    // Below a floor you set beats below the shop's own default, because one of
    // them is a thing you asked for. Both are "short".
    // `<=` rather than `<`, to match `restockQueue` — the sim calls a board thin
    // at the line, not below it, and a list that disagreed with the shop by one
    // unit would show you a green row the staff were already ordering for.
    const floor = rule.min > 0 ? rule.min : Math.max(1, Math.floor(stack * 0.25));
    // Thin *now* and worth doing something about are two different facts since
    // deliveries stopped being instant, and the row says both. `thin` is what
    // the shelf looks like this second and paints the count red; `short` is the
    // tab, and something already on a van does not belong in a list of things
    // to go and buy — you bought it. What is left to do about it is wait.
    const thin = !homeless && rule.auto !== false && held <= floor && (held > 0 || rule.min > 0);
    const short = thin && !inbound;
    const hot = !homeless && heat >= 1.25;
    const on = shelves.filter((s) => (s.stacks ?? [])
      .some((k) => k.item_id === it.id && k.qty > 0)).length;

    const crafted = madeBy.has(it.id);
    // Nowhere to put it still wins, because that is a refusal rather than news.
    // Everything under it gives way to the van: what is already on its way is
    // the newest true thing about the row and the one you cannot see from the
    // shop floor — a shelf you can walk over and look at, an order you cannot.
    const why = crafted ? `made in the ${applianceName(madeBy.get(it.id))}`
      : homeless ? 'no freezer to put it in'
        : inbound ? comingWhy(due)
          : rule.auto === false ? "you've told staff not to order this"
            : short ? (rule.min > 0 ? `below your minimum of ${rule.min}` : 'running low')
              : hot ? 'in demand right now'
                : held > 0 ? `on ${on} shelf${on === 1 ? '' : 'ves'}` : '';

    return {
      name: it.name,
      heat: ui.heatPill(it),
      // How many you have, in its own column, so scanning the list is reading
      // one line of numbers rather than forty rows of prose.
      //
      // What is on a van hangs off that number as `+6` rather than taking a
      // second column: a column is 30px of every row in the panel to say
      // nothing on almost all of them, and the two numbers are not comparable
      // anyway — one is stock you can sell this second and the other is a
      // promise. Read together they are the sentence you want: **4** on the
      // shelf in red, **+6** coming, and the caption says when.
      count: `${held || '<i class="none">–</i>'}${inbound ? `<i class="coming">+${inbound}</i>` : ''}`,
      // Red is still "this shelf is thin right now", van or no van — the relief
      // is the `+6` beside it, not a reason to stop showing the problem.
      countClass: thin && held ? 'short' : '',
      // Why this row is here, instead of three tags that said the same word on
      // every row in a department. Plain text — it also becomes the hover title.
      sub: why || it.tags.slice(0, 3).join(' · '),
      subWarn: homeless,
      right: money(it.base_cost),
      // Search still reaches the tags even though the row has stopped printing
      // them — "organic" was always a search, never a heading.
      facets: it.tags,
      tags: it.tags,
      held,
      inbound,
      // Soonest first, and a finite stand-in for "no van" rather than Infinity,
      // because `Infinity - Infinity` is NaN and a NaN in a comparator silently
      // stops sorting the list at all. Only ever reorders the On-the-way tab:
      // everything else in the panel has the same stand-in and falls straight
      // through to the keys it always used.
      dueIn: due ? due.legs[0].in : 1e9,
      short,
      hot,
      homeless,
      crafted,
      dim: homeless || (!crafted && cash < it.base_cost * 6),
      // No rule and no buy button on something you make. A stepper that sets a
      // minimum nothing will ever act on is worse than an absent one — it reads
      // as a shop ignoring an instruction you gave it.
      ...(crafted ? {} : {
        ...ruleFor(ui, it),
        button: { label: '×6', run: () => ui.net.send('buy-stock', { itemId: it.id, qty: 6 }) },
      }),
    };
  }).sort((a, b) => a.dueIn - b.dueIn || b.hot - a.hot || a.held - b.held
    || a.name.localeCompare(b.name));
}

/**
 * One item's standing order, drawn on the item's own row.
 *
 * The same three decisions the strip makes for the whole shop, made for one
 * thing — and the two numbers are about **the shop**, not about a board, which
 * is what makes them worth having: "keep 5 eggs, never more than 20" is a
 * sentence no shelf can say, because a shop with three egg shelves would mean
 * it three times over. The shelf still decides where a case goes and how much
 * of that unit it may take; this decides how many you want to own.
 *
 * Unset is a dash rather than a zero, and pressing `+` on an unset number jumps
 * to a useful one rather than to 1 — a quarter of a stack for a minimum, which
 * is the line the shop already uses for everything nobody has said anything
 * about, and a full stack for a maximum. Twenty presses to reach a sensible
 * number is a control nobody uses twice.
 */
function ruleFor(ui, it) {
  const rule = ui.state?.orders?.items?.[it.id] ?? {};
  const auto = rule.auto !== false;
  const stack = it.stack ?? 12;
  const less = (now) => (now > 1 ? now - 1 : null);   // down off 1 clears it
  const more = (now, first) => (now ? now + 1 : first);
  const num = (key, now) => `<span class="stp"><i>${key}</i>
    <button class="rbtn" data-act="${key}-" aria-label="less ${key}">−</button>
    <b class="${now ? '' : 'none'}">${now ?? '–'}</b>
    <button class="rbtn" data-act="${key}+" aria-label="more ${key}">+</button></span>`;

  const send = (patch) => () => ui.net.send('item-rule', { itemId: it.id, ...patch });
  // Stacked, because the row is two lines tall whatever this does — side by side
  // the pair ran the full width of the panel and squeezed the name into an
  // ellipsis, to buy back height that was never going to be spent.
  return {
    rule: `<span class="rule">
      <button class="rbtn tog ${auto ? 'on' : 'off'}" data-act="auto"
        title="${auto ? `Staff may order ${it.name}.` : `Staff never order ${it.name}.`}"
        aria-label="auto-order ${it.name}">${auto ? ICONS.supplier : ICONS.close}</button>
      <span class="stack">${num('min', rule.min ?? null)}${num('max', rule.max ?? null)}</span>
    </span>`,
    acts: {
      auto: send({ auto: auto ? false : null }),
      'min-': send({ min: less(rule.min ?? null) }),
      'min+': send({ min: more(rule.min ?? null, Math.max(1, Math.ceil(stack * 0.25))) }),
      'max-': send({ max: less(rule.max ?? null) }),
      'max+': send({ max: more(rule.max ?? null, stack) }),
    },
  };
}

/**
 * The three things the shop does without asking — its own tab, at the end.
 *
 * They started as three rows at the top of the list, which is where you put a
 * thing you are worried nobody will find, and it cost a third of the panel on
 * every scroll past forty items you were actually there to look at. Then they
 * were one strip of icons, which fixed the height and lost the sentences — and
 * these three genuinely need a sentence each, because "Claim" cannot say *which*
 * shelves or that reserved boards keep refilling anyway.
 *
 * A tab is the answer to both: full rows with the copy intact, and none of it in
 * the way of ordering. They are settings, and settings are somewhere you go.
 *
 * Each row sends only the field it changes. Sending all three back would race
 * the snapshot exactly the way a re-read `assign` does — two quick presses and
 * the second restores what the first replaced.
 */
function orderRows(ui) {
  const o = ui.state?.orders ?? {};
  const auto = o.auto !== false;
  const assign = o.assign !== false;
  const cap = o.budget ?? null;
  const at = ORDER_CAPS.findIndex((n) => (n ?? null) === cap);
  const next = ORDER_CAPS[(at < 0 ? 0 : at + 1) % ORDER_CAPS.length];
  const set = (patch) => () => ui.net.send('shop-orders', patch);
  return [
    { sep: 'Settings', icon: ICONS.menus },
    {
      icon: ICONS.supplier,
      name: 'Order stock',
      sub: auto
        ? 'Staff refill shelves from the supplier on their own.'
        : 'Nobody orders. They still unload, shelve and tidy.',
      picked: auto,
      tail: auto ? 'On' : 'Off',
      run: set({ auto: !auto }),
    },
    {
      icon: ICONS.label,
      name: 'Fill shelves you have not claimed',
      sub: assign
        ? 'A bare shelf with nothing reserved gets whatever sells best.'
        : 'A bare shelf is left for you. Reserved boards still refill.',
      picked: assign,
      tail: assign ? 'On' : 'Off',
      run: set({ assign: !assign }),
    },
    {
      icon: ICONS.today,
      name: 'Daily spend cap',
      sub: cap
        ? `${money(o.spent ?? 0)} of ${capLabel(cap)} spent today by staff. Press for ${capLabel(next)}.`
        : `Staff spend whatever the till allows. Press for ${capLabel(next)}.`,
      picked: !!cap,
      // What is LEFT once a cap is set, because mid-day that is the number worth
      // a glance — the sentence above already says what you chose.
      tail: cap ? `${money(o.left ?? 0)} left` : 'No cap',
      run: set({ budget: next }),
    },
  ];
}

/** The van tab's label, named once because two things have to agree on it. */
const VAN_TAB = 'On the way';

/**
 * The supplier's tabs: what you should DO about a thing, not where it has to
 * live.
 *
 * Frozen / Fresh / Keeps answered "do I have somewhere to put this", which is a
 * real question and the wrong one to organise a shop around: it splits the
 * catalogue three ways and leaves every tab a flat alphabet you scroll hunting
 * for the thing you meant. It also said the same word on every row in a
 * department, so the list carried no information at the point you were reading
 * it.
 *
 * These are a queue of work instead. `grouped` puts a row in the FIRST bucket
 * that takes it, so an item appears exactly once, in the most urgent thing that
 * is true of it — deal with Short, see what is coming, then Wanted, then glance
 * at what you hold, and Rest is the catalogue you were browsing before. Where it
 * lives has not gone away; it moved onto the row, where it can be a warning
 * about THIS item rather than a heading over forty.
 */
const STOCK_TABS = [
  // Every buying tab has to say `!crafted`, rather than the made-here bucket
  // simply sitting first and swallowing them. `grouped` takes the first
  // bucket that fits, so first place is also the tab the panel OPENS on —
  // and the first thing the supplier shows you should be something you can
  // do something about, not the appliance list.
  {
    label: 'Short',
    icon: ICONS.trouble,
    test: (r) => !r.crafted && r.short,
  },
  // The whole inbound list, and the reason it is a tab here rather than a menu
  // on the bay: you ordered it in this panel, so this is where you come back to
  // ask what happened to it. Ground has never been tappable either, which makes
  // a pad with a menu a genuinely new kind of object bought for one list.
  //
  // It sits above Wanted because what is already coming answers "what should I
  // buy" before demand does — and it is `passive`, which is the half that
  // position could never say. An empty bucket is dropped, so "second" is only
  // second on a morning something is already short: on a quiet one this bucket
  // IS the first, and the panel opened onto a list of things there is nothing
  // to do about — one press of ×6 and the catalogue you were reading was
  // replaced by the single loaf you had just bought, which reads as the
  // supplier having broken rather than as a tab you did not choose.
  {
    label: VAN_TAB,
    icon: ICONS.supplier,
    passive: true,
    test: (r) => !r.crafted && r.inbound > 0,
  },
  {
    label: 'Wanted',
    icon: ICONS.report,
    // Hot and you have none of it. Hot and well stocked is not a job.
    test: (r) => !r.crafted && r.hot && r.held <= 0,
  },
  { label: 'Stocked', icon: ICONS.crate, test: (r) => !r.crafted && r.held > 0 },
  { label: 'Rest', icon: ICONS.shop, test: (r) => !r.crafted },
  // What is left is exactly the crafted goods, and they are here to be
  // counted rather than bought — how many smoothies you have is worth
  // knowing, which is why they are not simply dropped from the list.
  { label: 'Made here', icon: ICONS.station },
];

/**
 * One line saying a van is out, above the tabs on every one of them.
 *
 * A tab you have to be on is not somewhere you can *see* something: the whole
 * argument for making an order visible is that you plan against it while you
 * are doing something else, and "something else" in this panel is any of the
 * other five tabs. Anything before the first tab heading lands in `lead`, which
 * `paintSection` draws whichever tab you are on — so this is one row, drawn only
 * while something is actually out, and gone the moment the van lands.
 *
 * Pressing it goes to the list. Which tab that is cannot be a constant: an
 * empty bucket is never drawn, so the van tab is second on a bad morning and
 * first on a good one. Counting the headings that were actually produced is the
 * only honest answer, and it is why this is handed the built list rather than
 * building its own.
 */
function vanLead(ui, list) {
  const pending = ui.state?.orders?.pending ?? [];
  if (!pending.length) return [];
  const units = pending.reduce((n, p) => n + (p.qty ?? 0), 0);
  const next = pending.reduce((a, b) => ((b.in ?? 0) < (a.in ?? 0) ? b : a));
  const at = list.filter((r) => r.sep && r.icon).map((r) => r.sep).indexOf(VAN_TAB);
  return [{
    // No sub-line, deliberately. It would be a second line on every tab in the
    // panel to say something the tab it sends you to says per item, and this
    // list has already been too tall twice.
    plain: true,
    name: `${units} on the way`,
    right: next.onVan ? 'arriving' : next.at,
    ...(at >= 0 ? { run: (u) => { u.tab = at; u.paintSection(); } } : {}),
  }];
}

function stockRows(ui) {
  const list = grouped(itemRows(ui), STOCK_TABS);
  return [...vanLead(ui, list), ...list, ...orderRows(ui)];
}

/**
 * The line under the list: when the vans come, and what the yard will take.
 *
 * Both are rules of the world rather than settings, which is why they are a
 * caption and not rows — nothing here can be pressed. They are also the two
 * facts that explain every refusal and every wait above them: a shop that has
 * been told "only room for 4 more at the bay" once, at the moment it was
 * refused, has been told it in the least useful place there is.
 *
 * The soonest arrival is picked on `in` rather than on the label, because
 * `at` is a clock face — "08:00" is the next van at ten past two in the
 * afternoon and yesterday's at nine in the morning, and sorting text would say
 * the wrong one every afternoon.
 */
function stockFoot(ui) {
  const o = ui.state?.orders ?? {};
  const pending = o.pending ?? [];
  const runs = (o.runs ?? []).join(' and ');
  const bay = o.bayRoom == null ? ''
    : o.bayRoom > 0 ? ` Room for ${o.bayRoom} more at the bay.`
      : ' No room at the bay for another order.';
  if (!pending.length) {
    return `${runs ? `Vans come at ${runs}. ` : ''}An order lands at the bay as a pallet.${bay}`;
  }
  const units = pending.reduce((n, p) => n + (p.qty ?? 0), 0);
  const next = pending.reduce((a, b) => ((b.in ?? 0) < (a.in ?? 0) ? b : a));
  const when = next.onVan ? 'the van is pulling in' : `next at ${next.at}`;
  return `${units} unit${units === 1 ? '' : 's'} on the way, ${when}.${bay}`;
}

/**
 * Sections, in rail order.
 *
 * - `id` doubles as `openPanel`, which is what `setCatalog` and `update` test
 *   to know whether an open menu needs redrawing. It has to be unique.
 * - `rows(ui)` is read fresh on every render, so a row is never stale.
 * - `live(ui)` is a cheap signature of everything the rows read. When it
 *   changes, the open section redraws — and only then, rather than at 10Hz.
 * - `badge(ui)` is what the rail shows without being opened.
 */
/**
 * Sort a flat list into tabbed groups.
 *
 * Each bucket takes the rows the ones before it didn't, so the buckets read as
 * a priority order and every row lands in exactly one tab; a bucket with no
 * `test` catches the remainder and belongs last. Empty buckets are dropped
 * rather than shown, because a tab that opens onto nothing is worse than no tab.
 *
 * This is the piece that lets a list generated from the database be tabbed at
 * all: the groups are declared by what a row *is*, not by where it sits.
 */
function grouped(rows, buckets) {
  const bins = buckets.map(() => []);
  for (const r of rows) {
    const i = buckets.findIndex((b) => !b.test || b.test(r));
    if (i >= 0) bins[i].push(r);
  }
  // `passive` rides along on the heading, because a bucket is what knows
  // whether there is anything to DO in it and `tabGroups` is what has to not
  // open onto one. See the van tab, and `UI.tabIndex`.
  return buckets.flatMap((b, i) => (
    bins[i].length ? [{ sep: b.label, icon: b.icon, passive: b.passive }, ...bins[i]] : []
  ));
}

/**
 * The rail's first button, and the one thing on it that is not a menu.
 *
 * Build used to be a section: a 214px list of everything you could put down,
 * opening top-right, while the bottom bar showed the first nine of the same
 * list. Two palettes for one palette, and the bar could only ever be a preview
 * of the real one. The bar is the palette now — it has tabs and it scrolls — so
 * the panel had nothing left to add, and this is what is left of that entry:
 * the affordance that says build mode exists at all.
 *
 * It carries `mode` so the rail knows a press toggles the world rather than
 * opening a panel, and so `setOpen` never lights it as though a menu were open.
 */
export const BUILD_MODE = {
  id: 'build',
  icon: ICONS.build,
  name: 'Build',
  key: 'g',
  mode: true,
  badge: (ui) => (ui.holding ? '●' : null),
};

/**
 * The rail's Upgrades press, and the second thing that is not a section.
 *
 * Its list is the bottom bar (`upgradeGroups`) and one row of that list is its
 * own menu (`showUpgrade`), so there is nothing left for a panel of rows to do.
 * Same shape as `BUILD_MODE`, but it claims the bar rather than a world mode.
 */
export const UPGRADE_BAR = {
  id: 'upgrades',
  icon: ICONS.upgrades,
  name: 'Upgrades',
  key: 'u',
  bar: 'upgrades',
  // What the keys list in Help prints under the name. A section says this with
  // `title`, which is its panel's header; a bar has no panel and no header.
  blurb: 'What there is to buy, once',
  badge: (ui) => {
    const owned = ui.ownedUpgrades ?? [];
    const n = buyableUpgrades(ui)
      .filter((u) => !owned.includes(u.id) && (ui._cash ?? 0) >= u.cost
        && (u.requires ?? []).every((r) => owned.includes(r))).length;
    return n ? String(n) : null;
  },
};

/**
 * The rail's Staff press, and the third thing that is not a section.
 *
 * It was a section — a panel titled "Who works here" that listed the kinds you
 * could hire, i.e. everybody who does *not* work here — and the bar underneath
 * it held one button that opened it. Both halves are the bar now (`staffGroups`):
 * the roster is its tabs, hiring is the last tab, and a tap on a kind hires.
 * Nothing is left for a panel of rows to do, exactly as with `UPGRADE_BAR`.
 */
export const STAFF_BAR = {
  id: 'staff',
  icon: ICONS.staff,
  name: 'Staff',
  key: 'h',
  bar: 'staff',
  blurb: 'Who works here, and who you could take on',
  // The roster is the ledger of who works here; the NPC on the floor is only
  // its body. Reading the roster rather than counting bodies means someone
  // whose kind was deleted still shows up — as a problem, which is what they
  // are — instead of quietly vanishing off the payroll.
  badge: (ui) => {
    const n = (ui.state?.roster ?? []).length;
    return n ? String(n) : null;
  },
};

export const SECTIONS = [
  {
    id: 'stock',
    icon: ICONS.supplier,
    name: 'Supplier',
    key: 'b',
    title: 'Supplier',
    facet: 'tag',
    // A shelf sat empty is money not being made, and it is the one thing you
    // cannot see from across the shop.
    badge: (ui) => {
      // A unit is "low" if any board on it is, and a bare one always is. Per
      // board rather than per unit, or a shelf with a full top row would hide
      // two empty ones underneath it.
      const low = (ui.state?.shelves ?? []).filter((s) => {
        const stacks = s.stacks ?? [];
        if (!stacks.length) return true;
        return stacks.some((k) => {
          const stack = ui.itemById(k.item_id)?.stack ?? 0;
          return stack ? k.qty <= stack * LOW_STOCK : k.qty === 0;
        });
      }).length;
      return low ? String(low) : null;
    },
    /**
     * ...and the other thing you cannot see from across the shop: that the
     * money you spent is still on the road.
     *
     * The badge counts a problem you could act on; this counts down a wait you
     * can only plan around, so it is a second channel rather than a second
     * number — a badge that flipped between "3 shelves low" and "12 coming"
     * would be one slot arguing with itself, and the two are most interesting
     * at exactly the same moment. See `nextVan` for why it takes two numbers.
     */
    ring: (ui) => nextVan(ui),
    /**
     * Everything the rows read, and nothing that merely ticks.
     *
     * The settings rows read the snapshot, so they belong here — a toggle that
     * did not redraw would read as a press that didn't land, and the honest
     * test of a switch is that it moved. So does what is on the shelves, which
     * only ever redrew by accident before: the count column moves when a
     * stocker fills a board, and it was `Math.floor(cash)` changing at the till
     * that happened to repaint it.
     *
     * The pending list is spelled out field by field rather than stringified
     * whole, and the field it deliberately leaves out is `in` — seconds still
     * to wait, which moves every tick. `JSON.stringify(orders)` picks it up,
     * and a signature that never settles repaints forty rows ten times a second
     * for the entire six hours an order is in flight. Nothing on screen prints
     * seconds; what the rows say is the hour, so the hour is what is watched.
     */
    live: (ui) => {
      const o = ui.state?.orders ?? {};
      const van = (o.pending ?? []).map((p) => `${p.item_id}${p.qty}@${p.at}${p.onVan ? '!' : ''}`);
      const shelved = (ui.state?.shelves ?? [])
        .flatMap((s) => (s.stacks ?? []).map((k) => `${k.item_id}${k.qty}`));
      return [
        // `spent` to the cent, unlike the till: it only moves when an order is
        // placed, so it cannot be the thing that never settles, and the cap row
        // prints it to the cent.
        Math.floor(ui._cash ?? 0), o.auto, o.assign, o.budget, o.spent,
        o.bayRoom, JSON.stringify(o.items ?? null), van.join(','), shelved.join(','),
      ].join('|');
    },
    rows: stockRows,
    foot: stockFoot,
  },

  {
    id: 'shop',
    icon: ICONS.report,
    name: 'Shop',
    key: 't',
    title: 'How the shop is doing',
    // Today's numbers, and now the finished days behind them: `state.ledger` is
    // the last week, oldest first. Before it the server kept yesterday in
    // `_lastDayStats` and never sent it, so every readout here compared today
    // against zero and could not answer "is this going up or down" at all.
    //
    // The badge is against **yesterday** rather than against zero, because zero
    // is not the question — a shop taking $400 a day is not doing well because
    // $400 is positive. On day one there is no yesterday and it falls back,
    // rather than calling the first day of every shop a triumph.
    badge: (ui) => {
      const s = ui.state?.stats;
      if (!s) return null;
      if (!s.revenue && !s.spent) return null;
      const profit = (s.revenue ?? 0) - (s.spent ?? 0);
      const y = dayProfits(ui.state).at(-1);
      if (y === undefined) return profit >= 0 ? '▲' : '▼';
      return profit >= y ? '▲' : '▼';
    },
    live: (ui) => JSON.stringify([ui.state?.stats, ui.state?.fixtures, ui.state?.modifiers?.length,
      ui.state?.ledger?.length, ui.state?.ledger?.at(-1)?.day,
      (ui.state?.shelves ?? []).filter((s) => !(s.stacks ?? []).some((k) => k.qty > 0)).length]),
    rows: (ui) => {
      const s = ui.state;
      if (!s) return [];
      const st = s.stats ?? {};
      const shelves = s.shelves ?? [];
      const plots = s.plots ?? [];
      const stat = (name, right, sub) => ({ name, right, sub, plain: true });
      const best = Object.entries(st.byItem ?? {}).sort((a, b) => b[1] - a[1])[0];
      const profit = (st.revenue ?? 0) - (st.spent ?? 0);
      const past = dayProfits(s);
      const yesterday = past.at(-1);
      const mean = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;

      return [
        { sep: 'Today', icon: ICONS.today },
        stat('Taken', money(st.revenue ?? 0), `${st.sold ?? 0} sold`),
        stat('Spent', money(st.spent ?? 0), 'stock, seed and building'),
        stat('Profit', money(profit), 'what is actually left'),
        // Signed, because a delta is the one number here where the direction is
        // the whole of the reading — `money()` marks a loss and says nothing at
        // all about a gain, so "$40" would leave you to work out which of the
        // two days it belonged to.
        yesterday === undefined
          ? null
          : stat('vs yesterday', signed(profit - yesterday), `yesterday made ${money(yesterday)}`),
        mean === null
          ? null
          : stat('Daily average', money(mean),
            `across the last ${past.length} day${past.length === 1 ? '' : 's'}`),
        best ? stat('Best seller', `${best[1]}`, ui.itemName(best[0])) : null,

        { sep: 'Going wrong', icon: ICONS.trouble },
        stat('Walked out', String(st.abandoned ?? 0), 'queued too long or could not find it'),
        stat('Found nothing', String(st.leftEmpty ?? 0), 'came in, shelf was bare'),
        // The VALUE is the headline and the count is the caption, which is the
        // other way round from how this read for as long as it has existed. A
        // shop binning 47 units has no idea whether that mattered; a shop
        // binning $61.40 knows immediately, because it is the same unit as
        // every other number on this panel. Nothing is deducted for it — that
        // money left when the stock was bought — so this is where it gets said.
        stat('Binned', money(st.spoiledValue ?? 0),
          `${st.spoiled ?? 0} unit${(st.spoiled ?? 0) === 1 ? '' : 's'} past their shelf life`),

        { sep: 'The shop', icon: ICONS.shop },
        stat('Shelves', `${shelves.filter((x) => (x.stacks ?? []).some((k) => k.qty > 0)).length} / ${shelves.length}`, 'holding something'),
        stat('Plots', `${plots.filter((p) => p.ready).length} ready`,
          `${plots.filter((p) => p.crop_id).length} planted of ${plots.length}`),
        stat('Queueing', String((s.queues ?? []).reduce((a, q) => a + q.queue, 0)),
          `across ${(s.queues ?? []).length} till${(s.queues ?? []).length === 1 ? '' : 's'}`),
        stat('Harvested', String(st.harvested ?? 0), 'picked today'),
      ].filter(Boolean);
    },
  },

  {
    id: 'help',
    icon: ICONS.help,
    name: 'Controls',
    key: '/',
    title: 'Controls',
    // Every line here is clamped to one line in a 214px panel, so the copy has
    // to be short enough to survive it — an ellipsis mid-word is worse than a
    // blunter phrase. The long version lives in `sub`, which is also the hover.
    rows: (ui) => [
      // Which shop you are in, and the way out of it. Top of the Controls menu
      // rather than a new rail icon: leaving is the rarest thing you do, and the
      // rail is for what you reach for from anywhere (see docs/ui-shell.md).
      { sep: 'This shop', icon: ICONS.shop },
      { name: ui.net?.world?.name ?? 'This shop', sub: 'the save you are playing', plain: true },
      {
        icon: ICONS.close,
        name: 'Leave to menu',
        sub: 'saves, and back to the shop list',
        run: () => ui.leaveToMenu(),
      },
      { sep: 'Getting about', icon: ICONS.walk },
      { name: 'Go there', sub: 'point at a thing and you walk over and do it', right: 'click', plain: true },
      { name: 'Walk yourself', sub: 'takes the wheel back off a route', right: 'WASD', plain: true },
      { name: 'Use a thing', sub: 'stand by it — walk off to stop', right: 'wait', plain: true },
      { name: 'Open its menu', sub: 'the same press, held still', right: 'hold', plain: true },
      { sep: 'Camera', icon: ICONS.camera },
      { name: 'Look around', sub: 'stays put until you go somewhere', right: 'drag', plain: true },
      { name: 'Zoom', sub: 'or pinch', right: 'scroll', plain: true },
      { name: 'Turn the view', sub: 'a quarter turn each way', right: ', .', plain: true },
      { name: 'or swing to turn', sub: 'right button, or twist two fingers', right: 'R-drag', plain: true },
      { sep: 'Menus', icon: ICONS.menus },
      ...SECTION_KEYS(),
      { name: 'Back out', sub: 'menu, then hands, then build mode', right: 'Esc', plain: true },
      { name: 'Back out on the world', sub: 'a click, not a drag — drops a half-drawn wall first', right: 'R-click', plain: true },
      { sep: 'Building', icon: ICONS.build },
      { name: 'Build mode', sub: 'opens with nothing armed — pick something to place', right: 'G', plain: true },
      // The same press as "open its menu" up under Getting about, doing the
      // other thing a press can do to a thing you own. Listed here rather than
      // there because it is the mode that gives the press this second meaning.
      { name: 'Move a fixture', sub: 'drag it where it should sit', right: 'drag', plain: true },
      { name: 'or pick it up', sub: 'hold it, then tap where it goes', right: 'hold', plain: true },
      { name: 'Put down what is armed', sub: 'the lit button again, or back out once', right: 'R-click', plain: true },
      { name: 'Turn the view instead', sub: 'a left drag moves things in here', right: 'R-drag', plain: true },
      { name: 'Turn a fixture', sub: 'a quarter turn', right: 'R', plain: true },
      { name: 'Bottom bar', sub: 'the open tab — nothing with the bar down', right: '1–9', plain: true },
      { name: 'Next tab', sub: 'every tab in turn, and every part of a split one', right: 'Tab', plain: true },
    ],
  },
];

/**
 * The menu keys, listed from the same array that binds them.
 *
 * `RAIL_ITEMS` rather than `SECTIONS`, because two of the menus a key opens are
 * a bar rather than a panel — and a keys list that only knows about panels is a
 * key nobody can find. Staff joined them the day it stopped being a panel, and
 * would otherwise have dropped silently off this list. Build is the one
 * exception: it is a mode, and it has its own line under Building below.
 */
function SECTION_KEYS() {
  return RAIL_ITEMS.filter((s) => !s.mode).map((s) => ({
    name: s.name, sub: s.title ?? s.blurb, right: s.key.toUpperCase(), plain: true,
  }));
}

export const sectionById = (id) => SECTIONS.find((s) => s.id === id) ?? null;

/**
 * The rail, top to bottom. The three that own the bottom bar lead it — Build
 * because it is the mode you are in most, then the two that are a bar rather
 * than a panel — and the panels follow. None of the first three is a section.
 */
export const RAIL_ITEMS = [BUILD_MODE, UPGRADE_BAR, STAFF_BAR, ...SECTIONS];

export const railItemById = (id) => RAIL_ITEMS.find((s) => s.id === id) ?? null;
