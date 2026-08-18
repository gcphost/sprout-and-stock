import { ICONS, icon } from './icons.js';
import { compact, money } from './money.js';
import { pinLast, KEYED } from './bar.js';
// FIXTURE_REFUND is the shop's one sell-back rate — a constant with FIXTURE in
// its name, imported here for an upgrade, the same way the worker menu imports
// it for a grade. There is one rate and everything that goes down uses it.
import {
  FIXTURES, isProp, isGround, FLOOR_KIND, STOCK_KINDS, shelfKind, FIXTURE_REFUND,
} from '../shared/build.js';
import { homeKind } from '../shared/tags.js';
import { kindOf, countKey } from '../shared/pieces.js';
import { variantsOf } from '../shared/model.js';
import { artForTool, artForWorker } from './thumb.js';
import { doingNow, bodyOf, kindSummary } from './worker-menu.js';
// What is on a van. Shared with the shelf menu, which asks the same two
// questions of it — see client/orders.js.
import { comingByItem, comingWhy, nextVan } from './orders.js';
import { mix } from './audio/mix.js';
import { music } from './audio/music.js';
import { SOUNDS, TRACKS } from './audio/manifest.js';
import { sfx } from './audio/sfx.js';
import { reportHtml } from './report.js';
import { CORNERS, isOff, setOff } from './corner.js';
import { deptOf } from './aisles.js';

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
        name: 'Crew',
        icon: ICONS.staff,
        blurb: 'Ground for the machines that work here. Paint a charging bay and that is where they dock.',
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
    icon: ICONS.decor,
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
  warmer: {
    icon: ICONS.warmer,
    group: 'shop',
    blurb: 'The only home for hot food. Anything else in one cooks slowly.',
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
  bin: {
    icon: ICONS.close,
    // Shop rather than Building, and it is a judgement rather than a fact about
    // the code: a skip is a thing you stand somewhere, like a till, not part of
    // the shell. Filed under the tab you are on when you notice you need one.
    group: 'shop',
    blurb: 'Somewhere to throw things away. Rot goes out to it instead of vanishing.',
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
    blurb: 'Drag out an area. Your crew dock and charge here instead of topping up wherever they finished, and come back fuller. One cell holds one unit.',
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
    blurb: 'A wall you can see through. Still encloses. Tap one you have already built to reglaze it.',
  },
  // Three more glazings, and they are LOOKS rather than kinds — same price, same
  // enclosure, same wall, glass in a different part of it (`GLAZING`,
  // shared/edges.js). On the bar as well as in the window's own menu, because the
  // menu can only reglaze a window that already exists and the commonest thing
  // anybody wants is to draw a shopfront along the front of the shop.
  {
    id: 'window-full',
    edge: 10,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.ambient,
    name: 'Shopfront',
    blurb: 'Glass from the floor to the lintel. Costs what a window costs — it is the same wall.',
  },
  {
    id: 'window-bay',
    edge: 11,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.ambient,
    name: 'Bay window',
    blurb: 'Glazing that steps out over a sill. It projects into the street, never into the aisle.',
  },
  {
    id: 'window-high',
    edge: 12,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.ambient,
    name: 'High window',
    blurb: 'A strip up under the lintel: light, no view. What a stockroom wants.',
  },
  {
    id: 'door',
    edge: 3,
    group: 'shell',
    sub: 'walls',
    icon: ICONS.shop,
    name: 'Doorway',
    // The second sentence is the whole affordance for step 15. Nothing on screen
    // could otherwise say that a door has a setting: there is no palette button
    // for a staff doorway on purpose — you find out a door should be one after the
    // room exists — so the tool that builds them is where it has to be said.
    blurb: 'A way through. Still counts as part of the enclosure. Tap one you have already built to say who it is for.',
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
    blurb: 'A way through a fence. Tap one you have already built to keep shoppers out of the field.',
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

  // Everyone, in runs of a kind, each run wearing its name in the gap before it.
  //
  // The tabs beside it can only ever show ONE kind, which is the question
  // nobody has: "who is on the tills" is asked of the whole shop, and a strip
  // of six identical robots with names of their own — since step 6 they are
  // "AR-Bobbin" rather than "Stocker 3" — answers it only if you already know
  // who is what. Sorting is what makes the label cheap: one word per run rather
  // than a line on every tile, which is the third line a fixed-height roster
  // entry has no room for.
  //
  // Only with two kinds in the shop. One run is a label over the entire strip
  // saying what the tab already says, which is the same call `splitGroup` makes
  // about a lone sub-tab.
  const everyone = seen.flatMap((k) => {
    const run = roster.filter((e) => e.kind === k).map(person);
    return seen.length >= 2 ? [{ ...run[0], head: nameOfKind(k) }, ...run.slice(1)] : run;
  });

  return [
    // No roster means no tabs about the roster: "Everyone" over an empty strip
    // is a tab that opens onto nothing, and the fall-through in `groupAt` then
    // lands you on Hire, which is the only thing there is to do.
    ...(roster.length ? [
      { id: 'all', name: 'Everyone', icon: ICONS.staff, blurb: 'Everybody on shift.', items: everyone },
      ...seen.map((k) => ({
        id: `kind:${k}`,
        name: nameOfKind(k),
        icon: icon(k, ICONS.staff),
        blurb: `Every unit on the floor as a ${nameOfKind(k).toLowerCase()}.`,
        items: roster.filter((e) => e.kind === k).map(person),
      })),
    ] : []),
    {
      id: 'hire',
      name: 'Lease',
      icon: ICONS.hire,
      blurb: 'Put a new unit on the floor.',
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
  // `space` was retired here, and this is what it said: "the shop used to grow
  // by buying land and letting the generator re-flow it. You draw your own
  // walls, so the shape of the building is something you make rather than
  // something you unlock — and an upgrade that silently rearranged the place you
  // had just laid out was the last thing doing that."
  //
  // Every word of that was true of what it did and none of it is an argument
  // against LAND. It sells world tiles now — east and south, the building
  // untouched and pinned by `shell.x`/`shell.z` — so it rearranges nothing and
  // grants exactly the one thing drawing your own walls needs more of. Back on
  // the list.
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
 * What is left, as tabs.
 *
 * Grouped by who the money is spent on rather than by `kind`, which would be
 * seven tabs of one row each. A fixture discount, a bigger rucksack and a better
 * postcode are three genuinely different decisions and one of them is a list.
 */
export const UPGRADE_GROUPS = [
  {
    id: 'fixtures', name: 'Fixtures', icon: ICONS.shelf,
    blurb: 'A standing discount on everything of that kind you build from now on.',
    kinds: [...STOCK_KINDS, 'plot', 'checkout'],
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

/**
 * What one does, in a clause, off its own payload.
 *
 * Read from `payload` rather than from the authored description for the reason
 * the card that used to hold this made: the description is prose somebody
 * typed and the payload is what the sim obeys, so a row edited over MCP to 30%
 * off says 30% here without anybody remembering to rewrite its sentence.
 *
 * A kind nobody has a clause for falls through to the description, which is the
 * honest answer for one nobody has — and the same shape `sells` had, which is
 * what stops a new payload field silently printing nothing.
 */
function upgradeWhat(u) {
  const p = u.payload ?? {};
  if (p.discount != null) {
    const what = FIXTURES[u.kind]?.label?.toLowerCase() ?? 'one';
    return `${Math.round(p.discount * 100)}% off every ${what} you build`;
  }
  if (p.carry != null) return `carry ${p.carry} at once, up from six`;
  if (p.speedMult != null) return `walk ${p.speedMult}× faster`;
  if (p.reach != null) return `+${p.reach} people within reach of the shop`;
  return u.description;
}

/**
 * The catalogue as rows, tabbed by `UPGRADE_GROUPS`.
 *
 * Each row is a small card and the caption is the point of it: it says what the
 * thing DOES, so reading the list is reading, rather than pointing at fourteen
 * tiles in turn and waiting for a tooltip. Comparing two of them is possible for
 * the first time, which a tooltip cannot do at any size — it shows one.
 *
 * The other half is what a press means, and it is on the row rather than in a
 * confirmation: a price when it is not yours, and the sell-back when it is. An
 * upgrade you cannot act on has no `run` at all — the row says why in its own
 * caption, so a press that could only ever be refused is a press that is not
 * offered.
 */
function upgradeRows(ui) {
  const owned = ui.ownedUpgrades ?? [];
  const cash = ui._cash ?? 0;
  const all = buyableUpgrades(ui);
  const rowsFor = (list) => list.map((u) => {
    const have = owned.includes(u.id);
    const locked = (u.requires ?? [])
      .filter((r) => !owned.includes(r))
      .map((r) => all.find((o) => o.id === r)?.name ?? r);
    // Half back, the rate everything in this shop sells at.
    const back = Math.round(u.cost * FIXTURE_REFUND * 100) / 100;
    // What is standing on this rung. `sellUpgrade` refuses for the same reason;
    // this is the row saying so first, in the line it already has.
    const held = all
      .filter((o) => owned.includes(o.id) && (o.requires ?? []).includes(u.id))
      .map((o) => o.name);
    const poor = !have && !locked.length && cash < u.cost;
    const stuck = have && held.length > 0;
    return {
      icon: ICONS.upgrades,
      name: u.name,
      sub: have
        ? (stuck ? `${upgradeWhat(u)} · ${held.join(', ')} needs it`
          : `${upgradeWhat(u)} · press to sell back`)
        : (locked.length ? `${upgradeWhat(u)} · needs ${locked.join(', ')} first`
          : upgradeWhat(u)),
      // The price, under the icon, where every price in this panel goes. Owned,
      // it is what pressing hands back — the one number that is not on the row
      // otherwise, and the reason the caption can say "press to sell back"
      // without also saying a figure.
      right: have ? (stuck ? '✓' : money(back)) : money(u.cost),
      // Yours. `picked` rather than `dim`, because it is a thing you have rather
      // than a thing you have lost — and it is still pressable, in the other
      // direction.
      picked: have,
      // Two weights of no, which is the split `rowHtml` already draws: `dim` is
      // CANNOT — the rung below is not yours — and `soft` is CAN, BUT, which is
      // a price you have not reached yet and will.
      dim: !have && locked.length > 0,
      soft: poor,
      run: (locked.length || poor || stuck)
        ? null
        : () => ui.net.send(have ? 'sell-upgrade' : 'buy-upgrade', { upgradeId: u.id }),
    };
  });

  const other = (u) => !UPGRADE_GROUPS.some((g) => g.kinds?.includes(u.kind));
  return UPGRADE_GROUPS.flatMap((g) => {
    const mine = all.filter((u) => (g.kinds ? g.kinds.includes(u.kind) : other(u)));
    if (!mine.length) return [];
    // An icon on the `sep` is what makes it a tab — `tabGroups`' opt-in, so the
    // strip is the same three alternatives the bar had.
    return [{ sep: g.name, icon: g.icon }, ...rowsFor(mine)];
  });
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
 * What to call the unit an item has to live on, per `STOCK_KINDS`.
 *
 * A player has never seen the word "warmer" — they bought a Hot Counter — and
 * the message this feeds is the one telling somebody what to go and buy, so it
 * has to name the thing on the palette. A missing key reads as "unit", which is
 * the right shape of wrong for a fourth kind nobody has written a word for yet.
 */
const UNIT_NAME = { shelf: 'shelf', freezer: 'freezer', warmer: 'hot counter' };

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
  // Which kinds of unit the shop actually owns, so `homeless` below can ask
  // about any of them. It was a `hasFreezer` boolean, which is the same shape
  // every stocking rule in the game was written in and wrong for the same
  // reason: a shop with no hot counter would have listed a roast chicken as
  // perfectly buyable.
  const owns = new Set(shelves.map((s) => shelfKind(s.kind)));
  // ...and owning one is not the same as there being a BOARD free on it, which
  // is the half that made the panel lie. Every rule the shop acts on is asked
  // per unit — `shelvesFor` for a stocker with an armful, `buy` for the order
  // itself, both of which answer nothing at all for an item with no home — so a
  // list that asked only "do I own a freezer" would go on printing "below your
  // minimum of 6" beside a minimum that could never be acted on, for ever.
  // Measured on a real save: three freezers, eight boards, every one reserved,
  // and six frozen items the shop could not order and would not say why.
  //
  // The three tests are the three the sim makes, in the same order (see
  // `Game.shelfAccepts` and `shelvesFor`): the right kind of unit, not set aside
  // for something else, and a board of its own or room on the board it is
  // already on. Deliberately no more than that — `homeShelves` narrows it
  // further and `droppedItem` can veto outright, both of which only ever make
  // the shop stricter, and a caption that cried wolf about a board the shop
  // would in fact have used is worse than one that stays quiet.
  const boardFor = (it) => {
    const home = homeKind(it);
    return shelves.some((s) => {
      if (shelfKind(s.kind) !== home) return false;
      const kept = s.assigned ?? [];
      if (kept.length && !kept.includes(it.id)) return false;
      const stacks = s.stacks ?? [];
      const on = stacks.find((k) => k.item_id === it.id);
      // On it already: room is room on that board. Otherwise it needs a board
      // nothing is standing on — a unit can be out of boards while every board
      // on it has space, which is exactly the state that strands an item.
      return on ? on.qty < (on.cap ?? 0) : stacks.length < (s.boards ?? 0);
    });
  };
  const cash = ui._cash ?? 0;
  // Anything a recipe outputs cannot be ordered at all — `buyStock` refuses it,
  // and it has refused it since appliances existed. The supplier listed them
  // anyway, with a buy button and two steppers that could do nothing, which is
  // three lies per row. The client already had the recipes; it had never asked.
  const madeBy = new Map();
  for (const r of ui.catalog.recipes ?? []) if (!madeBy.has(r.output_id)) madeBy.set(r.output_id, r.station);
  const applianceName = (id) => (ui.catalog.fixtures ?? []).find((f) => f.id === id)?.name ?? id;
  const coming = comingByItem(ui);
  // What the shop has stopped stocking by itself, which until now was a state
  // with no surface anywhere in the game: the mark lived on the save, rode in
  // the snapshot, and nothing in `client/` had ever read it. All you got was one
  // log line at the moment it happened, and seven of them in five days on a real
  // shop scrolled away before anybody looked — leaving the crew standing still
  // beside crates nothing would lift, with no screen in the game that could say
  // why. The server hands the list ready-lapsed (`Game.droppedItems`), so the
  // panel cannot disagree with the sim about which items it is talking about.
  const off = new Map((ui.state?.orders?.notStocking ?? []).map((d) => [d.itemId, d]));

  const rows = ui.catalog.items.map((it) => {
    const rule = ui.state?.orders?.items?.[it.id] ?? {};
    const held = ui.heldOf(it.id);
    const due = coming.get(it.id) ?? null;
    const inbound = due?.qty ?? 0;
    const stack = it.stack ?? 12;
    const heat = ui.heatFor(it);
    // Nowhere to put it is a stronger fact than anything about demand: buying
    // it is a mistake whatever the town thinks, and the old tabs said so only
    // by which of three headings you happened to be under.
    // Two ways to have nowhere to put it, and they are different problems with
    // different answers: buy the unit, or free up a board on one you own. The
    // row says which, because "no freezer to put it in" in front of three
    // freezers reads as the panel being broken.
    const noUnit = !owns.has(homeKind(it));
    const homeless = noUnit || !boardFor(it);
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
    // The shop's own judgement, and it outranks every reason below including
    // "nowhere to put it" — those are all things the shop would act on if it
    // could, and this one is the shop having decided not to. Told as what the
    // crew will do and when, because the complaint it answers is not that the
    // shop stopped stocking something, it is being unable to find out that it
    // had.
    const dropped = off.get(it.id) ?? null;

    /**
     * The three states that are a glyph rather than a sentence.
     *
     * What they have in common is that they are the SAME words on every row
     * that has them and none of them is a number you scan the list for: the
     * crew stopped stocking this, it is on a shelf already, it is made in an
     * appliance. Spelled out they took the caption and then ellipsised anyway —
     * a 214px panel clamped `your crew stopped stocking this — bac…`, which
     * stops one word before the part with the information in it.
     *
     * Everything left in `why` below is the opposite: a number, a clock or a
     * thing to go and do, different on every row, and worth the two lines.
     *
     * The countdown is in the tip rather than on the glyph because a badge with
     * a number on it reads as a count of something — this panel already has one
     * of those, in the next column.
     */
    const mark = dropped
      ? {
        icon: ICONS.close,
        warn: true,
        title: `Your crew stopped stocking ${it.name} — nothing was selling. `
          + `Back on the list in ${dropped.left} day${dropped.left === 1 ? '' : 's'}, `
          + 'or press Stock to put it back now.',
      }
      : crafted
        ? { icon: ICONS.station, title: `Made in the ${applianceName(madeBy.get(it.id))}, not ordered.` }
        : (!homeless && !inbound && !short && !hot && held > 0)
          ? { icon: ICONS.crate, title: `On ${on} shelf${on === 1 ? '' : 'ves'}.` }
          : null;

    // Nowhere to put it still wins, because that is a refusal rather than news.
    // Everything under it gives way to the van: what is already on its way is
    // the newest true thing about the row and the one you cannot see from the
    // shop floor — a shelf you can walk over and look at, an order you cannot.
    //
    // The three that became marks are gone from here rather than said twice.
    // A row whose whole caption was one of them falls through to its tags,
    // which is a line spent on something the glyph does not already say.
    const why = noUnit ? `no ${UNIT_NAME[homeKind(it)] ?? 'unit'} to put it in`
      // The one that used to hide behind "below your minimum of 6": the shop
      // has the right kind of unit and not one board left it may use.
      : homeless ? `no free ${UNIT_NAME[homeKind(it)] ?? 'unit'} board`
        : inbound ? comingWhy(due)
          : rule.auto === false ? "you've told staff not to order this"
            : short ? (rule.min > 0 ? `below your minimum of ${rule.min}` : 'running low')
              : hot ? 'in demand right now' : '';

    return {
      // Its own id on the row, which nothing needed until the list stopped
      // re-sorting: a frozen order is a map from something stable to a place,
      // and a name is neither stable nor unique.
      id: it.id,
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
      //
      // A row whose reason became a `mark` falls through to its tags, which is
      // the point of moving it: the glyph says the state, and the line under
      // the name goes back to saying something else.
      sub: why || it.tags.slice(0, 3).join(' · '),
      subWarn: homeless,
      mark,
      right: money(it.base_cost),
      // Search still reaches the tags even though the row has stopped printing
      // them — "organic" was always a search, never a heading.
      facets: it.tags,
      tags: it.tags,
      // Which aisle, for the strip under the tabs — the same one the shelf menu
      // draws, off the same function. See client/aisles.js for why the question
      // "show me produce" is the one this list could not answer.
      dept: deptOf(it),
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
      dropped: !!dropped,
      // Soonest back first inside the tab, so the list is a queue that empties
      // rather than an alphabet. Everything else in the panel gets the same
      // finite stand-in `dueIn` uses and falls straight through to the keys it
      // always sorted on.
      backIn: dropped ? dropped.left : 1e9,
      dim: homeless || (!crafted && cash < it.base_cost * 6),
      // No rule and no buy button on something you make. A stepper that sets a
      // minimum nothing will ever act on is worse than an absent one — it reads
      // as a shop ignoring an instruction you gave it.
      ...(crafted ? {} : ruleFor(ui, it)),
      /**
       * The one button slot.
       *
       * Ordering and un-ordering share it, because they are one decision seen
       * from either side and a row with both would be two buttons of which one
       * is always wrong. What is already loaded is not offered — `cancelOrder`
       * refuses it, and a control the shop will refuse is the green-ghost bug
       * wearing a price.
       *
       * **`Stock` is not one of the buying controls, and it sits outside the
       * `crafted` guard for that reason.** It went inside first, which produced
       * the one row in the panel that could not be true: a made-here item that
       * the crew had stopped putting out, wearing the ✕ that says so, in the tab
       * built to list exactly that — and no way whatever to undo it, because the
       * guard above it is about *ordering* and this press is not an order. The
       * whole complaint this feature answers is a shop decision you cannot see;
       * showing it and then withholding the switch is a worse version of the
       * same thing. Nothing about a sourdough recipe stops the shop giving up on
       * the loaf, so nothing about it should stop you saying carry on.
       *
       * And it takes the slot outright while the mark is up, for the reason the
       * paragraph above gives: buying six of something your crew will carry
       * straight back out to the yard is the one press on this row that cannot
       * work.
       */
      button: dropped
        ? { label: 'Stock', run: () => ui.net.send('stock-again', { itemId: it.id }) }
        : crafted
          ? null
          : (inbound > 0 && !(due?.legs ?? []).every((l) => l.onVan))
            ? {
              label: 'Cancel',
              danger: true,
              run: () => ui.net.send('cancel-order', { itemId: it.id }),
            }
            : { label: '×6', run: () => ui.net.send('buy-stock', { itemId: it.id, qty: 6 }) },
    };
  }).sort((a, b) => a.backIn - b.backIn || a.dueIn - b.dueIn || b.hot - a.hot
    || a.held - b.held || a.name.localeCompare(b.name));

  // ...and then held still. Every key in that sort is a live number — what is
  // due, what is hot, what you hold — so the list re-sorted itself under the
  // pointer on every repaint: the row you were reaching for slid two places
  // because a shopper bought a loaf. That is right for a *readout* and wrong for
  // the thing this panel actually is, which is a list you work down.
  //
  // The freeze is over POSITION only (see `UI.freezeOrder`). Counts, prices,
  // the `+6` and which tab a row belongs to all stay live — what is pinned is
  // where a row sits, so the numbers can move without the list moving.
  return ui.freezeOrder('stock', rows, (r) => r.id);
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
        title="${auto ? `Your crew may order ${it.name}.` : `Your crew never order ${it.name}.`}"
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
        ? 'Your crew refill shelves from the supplier on their own.'
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
  // First, and it earns the place the same way Short does: it is the most
  // urgent true thing about a row, and it is the only one nothing else in the
  // game will ever tell you. The shop hand writes a line off after four days of
  // nothing selling, shop-wide, and for as long as the feature existed the only
  // trace was a log entry that scrolls. What that reads as, days later, is a
  // shop that has quietly stopped restocking half its range and a crew standing
  // still beside crates nothing will lift — with no screen that can say why.
  //
  // An empty bucket is dropped (see `grouped`), so on a shop where this has
  // never happened the panel is exactly what it was and opens on Short.
  //
  // `crafted` is deliberately NOT excluded, unlike every buying tab below. You
  // cannot order a toastie and the row says so, but the shop can absolutely
  // stop putting one out — and a made-here line that has quietly gone off the
  // shelves with the appliance still running is the least visible version of
  // this there is.
  {
    label: 'Not stocking',
    icon: ICONS.close,
    test: (r) => r.dropped,
  },
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
/**
 * What is on the road, in the panel's own title bar.
 *
 * It was a `lead` row — above the tabs, drawn on every one of them — which is
 * the right *place* for it and the wrong shape: a full-width row with a name and
 * a right-hand column, spending a whole line of a 214px panel on six words, and
 * pushing the list it is about further down the screen every time a van is out.
 * The header is the one strip that is already on screen on every tab and already
 * has nothing on its right-hand side.
 *
 * It stops being pressable, which it was (a jump to the van tab). That is paid
 * for rather than lost: every bucket draws its tab now, counted, so the van tab
 * is on screen whether or not anything is in it — and the header is the panel's
 * drag handle, where a button is something you hit while trying to move the
 * window.
 *
 * The clock is sanitised rather than escaped because it is a clock: `at` is a
 * server-formatted time and anything in it that is not a digit or a colon is not
 * a time, so stripping is both the escape and the format.
 */
export function vanNote(ui) {
  const pending = ui.state?.orders?.pending ?? [];
  // The one control in here, and it is always drawn: a button that came and
  // went with the van would be a button you cannot find when you want it, and
  // re-sorting is worth asking for on a quiet morning too.
  // "Take the list again", which is now two things — the order and the tabs —
  // and the title says the consequence rather than the mechanism, because what
  // you press it for is a row that has stopped being where it ought to be.
  const sort = '<button class="pnl-btn" data-resort title="Take a fresh list">'
    + `${ICONS.report}</button>`;
  if (!pending.length) return `<span class="pnl-note">${sort}</span>`;
  const units = pending.reduce((n, p) => n + (p.qty ?? 0), 0);
  const next = pending.reduce((a, b) => ((b.in ?? 0) < (a.in ?? 0) ? b : a));
  return `<span class="pnl-note"><span class="n">${units} on the way</span>`
    + `<span class="clock${next.onVan ? ' now' : ''}">${
      next.onVan ? 'arriving' : String(next.at ?? '').replace(/[^0-9:]/g, '')}</span>${sort}</span>`;
}

/**
 * The supplier's list, in the order and the tabs it was taken in.
 *
 * Both freezes are the same list-you-work-down argument and neither is worth
 * much without the other: pinning where a row *sits* while letting it change
 * which tab it sits in means the row still disappears out from under the press
 * that moved it, just tidily. The refresh button in the title bar
 * (`vanNote`'s `data-resort`) takes a fresh list of both.
 */
function stockRows(ui) {
  const pin = (r, live) => ui.freezeBin('stock:tab', r.id, live);
  return [...grouped(itemRows(ui), STOCK_TABS, pin), ...orderRows(ui)];
}

/**
 * The supplier has no caption, and the last one to go was the yard's.
 *
 * It read "An order lands at the bay as a pallet. Room for 82 more." under every
 * tab — a rule of the world stated permanently, in a panel whose whole job is
 * the list above it. The van timetable went first (a caption that enumerates a
 * set gets worse as the game gets richer), then what was on the way (the header
 * says it), and this is the same trade: three lines of a 214px panel spent on a
 * number that only matters at the moment it refuses you, which is where it is
 * said — `fixture-menu.js` prints "No room at the bay" on the order button, and
 * the shop logs the refusal. `bayRoom` is still on the snapshot for those.
 */
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
function grouped(rows, buckets, pin) {
  const bins = buckets.map(() => []);
  for (const r of rows) {
    // Where the row belongs *now*. `pin` is what a section hands in to say
    // "and where did it belong when the list was taken" — see `UI.freezeBin`.
    // It is asked with the live answer rather than instead of it, because a row
    // nobody has filed yet has to be filed somewhere.
    const live = buckets.findIndex((b) => !b.test || b.test(r));
    const i = pin ? pin(r, live) : live;
    if (i >= 0) bins[i].push(r);
  }
  // `passive` rides along on the heading, because a bucket is what knows
  // whether there is anything to DO in it and `tabGroups` is what has to not
  // open onto one. See the van tab, and `UI.tabIndex`.
  //
  // EVERY bucket, empty ones included, and the count on the heading. Dropping
  // an empty one made the tab strip change shape as the shop did: Short appears
  // when something runs low, the van tab comes and goes with the lorry, and the
  // tab you were about to press moved under your finger. A row of tabs is
  // something you learn the position of, and it can only be learned if it is the
  // same row every time — so what an empty bucket costs you now is a zero rather
  // than a tab, which is also the answer to "is anything short" without having
  // to press anything. `tabIndex` is what stops a menu OPENING on an empty one.
  return buckets.flatMap((b, i) => [
    { sep: b.label, icon: b.icon, passive: b.passive, count: bins[i].length },
    ...bins[i],
  ]);
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
 * How many are worth buying right now — the badge, shared by both shapes this
 * list has worn.
 */
function affordableUpgrades(ui) {
  const owned = ui.ownedUpgrades ?? [];
  return buyableUpgrades(ui)
    .filter((u) => !owned.includes(u.id) && (ui._cash ?? 0) >= u.cost
      && (u.requires ?? []).every((r) => owned.includes(r))).length;
}

/**
 * The rail's Staff press, and the third thing that is not a section.
 *
 * It was a section — a panel titled "Who works here" that listed the kinds you
 * could hire, i.e. everybody who does *not* work here — and the bar underneath
 * it held one button that opened it. Both halves are the bar now (`staffGroups`):
 * the roster is its tabs, hiring is the last tab, and a tap on a kind hires.
 * Nothing is left for a panel of rows to do. Upgrades made the same move and
 * then made it back — see the section above for what a tile could not say.
 */
export const STAFF_BAR = {
  id: 'staff',
  icon: ICONS.staff,
  name: 'Crew',
  key: 'h',
  bar: 'staff',
  blurb: 'What works here, and what you could put on lease',
  // The roster is the ledger of who works here; the NPC on the floor is only
  // its body. Reading the roster rather than counting bodies means someone
  // whose kind was deleted still shows up — as a problem, which is what they
  // are — instead of quietly vanishing off the payroll.
  badge: (ui) => {
    const n = (ui.state?.roster ?? []).length;
    return n ? String(n) : null;
  },
};

/**
 * A milestone's number, in the units it is actually about.
 *
 * `$100` and `100 sold` are the same integer and only one of them takes a
 * dollar sign, so the row is told which by the server (`unit`) rather than
 * guessing from the id. Reputation is the odd one out and has to be: it is a
 * 0..1 the HUD already draws as a bar, and "0.75 / 0.75" is a number nobody
 * reading a shop has ever thought in.
 *
 * Money is `compact` rather than `money`, and this row is the only place in the
 * game that is true of. A milestone's value is stacked under its icon in a
 * column sized for a price (see `rowHtml`), and it is printed twice with a
 * slash between — so the far end of the ladder is the one readout in the client
 * asking that column to hold eighteen characters. It wrapped, and then it
 * overflowed the panel. Nothing under $10,000 is abbreviated, so every rung a
 * shop is actually working on still reads exactly.
 */
function amount(n, unit) {
  if (unit === 'money') return compact(n);
  if (unit === 'percent') return `${Math.round(n * 100)}%`;
  if (unit === 'day') return `day ${Math.round(n)}`;
  return String(Math.round(n));
}

/** What a rung pays, short enough to sit in a caption under the name. */
function rewardWords(reward = {}) {
  const bits = [];
  if (reward.cash > 0) bits.push(money(reward.cash));
  if (reward.supplies > 0) bits.push(`${reward.supplies} free units`);
  if (reward.town > 0) bits.push(`+${reward.town} town`);
  return bits.length ? `→ ${bits.join(' · ')}` : '';
}

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
    /** Drawn on the right of the panel's own title — see `vanNote`. */
    note: vanNote,
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
      // What is on the units, and — since `boardFor` — what they are set aside
      // for and how many boards they have. Ticking a board free is the one
      // action that answers "no free freezer board", so a signature that did
      // not watch it would leave the row saying no until something else moved.
      const shelved = (ui.state?.shelves ?? [])
        .flatMap((s) => [
          `${s.kind}${s.boards}:${(s.assigned ?? []).join('+')}`,
          ...(s.stacks ?? []).map((k) => `${k.item_id}${k.qty}`),
        ]);
      // ...and what the shop has stopped stocking, which is the one thing in
      // here a PRESS changes on its own. Everything else in this signature also
      // moves for reasons of the shop's — a sale, a delivery, a stocker filling
      // a board — so leaving one out is survivable in a way that reads as
      // sluggish rather than as broken: the panel catches up on the next thing
      // that happens. This one has nothing behind it. Press Stock in a shut shop
      // with the crew idle and NOTHING else in the signature moves, so the row
      // sat there with its Stock button and its ✕ for as long as it took the
      // shop to do something unrelated — a press that lands, makes a sound, and
      // visibly does nothing, which is the worst answer a button can give.
      //
      // The day is in it because the countdown is in days: a row saying "back in
      // 4 days" has to become 3 at the roll, and `left` is the only field here
      // that changes without anybody touching anything.
      const off = (o.notStocking ?? []).map((d) => `${d.itemId}:${d.left}`);
      return [
        // `spent` to the cent, unlike the till: it only moves when an order is
        // placed, so it cannot be the thing that never settles, and the cap row
        // prints it to the cent.
        Math.floor(ui._cash ?? 0), o.auto, o.assign, o.budget, o.spent,
        JSON.stringify(o.items ?? null), van.join(','), shelved.join(','),
        off.join(','),
      ].join('|');
    },
    rows: stockRows,
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
    // Everything the picture draws, which is a wider net than the list needed:
    // the old rows read `stats` and a shelf count, and the meters and the week
    // also move on beds, tills and a day rolling over. A signature that misses
    // one is a panel that is right until you look away.
    // `reputation` is in it for the block that draws it: `stats.repMoves` says
    // what moved today, which is not the same fact as where the number now
    // stands — a shop that opens on 62% and is left alone all morning moves
    // neither, and one restored from a save moves the level without any of
    // today's causes. It arrives rounded to the cent-equivalent (two decimals),
    // so it is not a field that never settles.
    live: (ui) => JSON.stringify([ui.state?.stats, ui.state?.reputation,
      ui.state?.fixtures, ui.state?.modifiers?.length,
      ui.state?.ledger?.length, ui.state?.ledger?.at(-1)?.day,
      (ui.state?.shelves ?? []).filter((s) => !(s.stacks ?? []).some((k) => k.qty > 0)).length,
      (ui.state?.plots ?? []).filter((p) => p.crop_id).length,
      (ui.state?.plots ?? []).filter((p) => p.ready).length,
      (ui.state?.queues ?? []).reduce((a, q) => a + q.queue, 0)]),
    /**
     * ONE drawn block instead of fourteen rows across three tabs.
     *
     * Every number that was in the list is still in it — see `client/report.js`,
     * which is where the shape and the reasons live. What this section keeps is
     * everything the panel machinery needs and the picture does not care about:
     * the key, the title, the badge and the signature above.
     */
    rows: (ui) => [{ html: reportHtml(ui) }],
  },

  {
    /**
     * WHAT THERE IS TO BUY ONCE — a list again, and this time it says what each
     * one does without being asked.
     *
     * Three shapes in three steps, which is worth recording because each fixed
     * the last one's complaint and introduced its own. It was a panel of rows
     * that opened a card; then the rows became bar tiles and the card stayed;
     * then the card went and the tile did the buying. What was left was the
     * worst of it: a 76px tile holding a name that did not fit, a price, and a
     * description reachable only by hovering — so reading the catalogue meant
     * pointing at each thing in turn and waiting, and *comparing* two of them
     * was impossible, because a tooltip is one at a time by construction.
     *
     * A row is 214px wide and has a caption line, which is the whole fix: the
     * name fits, and what the thing does is printed under it. `upgradeWhat`
     * reads that off `payload` rather than off the authored prose — the same
     * call the card made, and it survives the card because it was the only part
     * of it doing any work.
     *
     * The tabs are `UPGRADE_GROUPS`, unchanged, as `sep` rows with icons —
     * which is `tabGroups`' own opt-in, so the strip is the same three
     * alternatives it was on the bar.
     */
    id: 'upgrades',
    icon: ICONS.upgrades,
    name: 'Upgrades',
    key: 'u',
    title: 'What there is to buy, once',
    // Seven rows on one tab and two on another, so the window would double in
    // height as you pressed along the strip — and this is a list you press
    // along precisely to compare. See `steadyHeight`.
    steady: true,
    badge: (ui) => {
      const n = affordableUpgrades(ui);
      return n ? String(n) : null;
    },
    // What you own, and what you can afford. `affordStep` rather than the cash
    // itself for the reason the bar used it: prices are fixed, so a count of the
    // ones within reach steps at each price instead of moving on every sale —
    // a signature off `cash` would redraw this list at the till.
    live: (ui) => JSON.stringify([ui.ownedUpgrades ?? [], ui.affordStep(ui._cash ?? 0),
      ui.catalog?.version ?? 0]),
    rows: (ui) => upgradeRows(ui),
  },

  {
    id: 'goals',
    icon: ICONS.milestone,
    name: 'Milestones',
    key: 'm',
    title: 'Milestones',
    /**
     * How many are nearly there, rather than how many are left.
     *
     * "12 to go" is a permanent number that never means anything twice, which
     * is the badge equivalent of the demand meter's 1px stub — every other
     * badge on this rail counts something you could act on today. Something
     * four fifths of the way to a reward is exactly that: it is why you keep
     * the doors open for another ten minutes.
     */
    badge: (ui) => {
      const close = (ui.state?.milestones ?? [])
        .filter((m) => !m.done && m.need > 0 && m.have / m.need >= 0.8).length;
      return close ? String(close) : null;
    },
    // The bars, and nothing else. `have` is rounded to the penny by the server
    // and only moves when a sale, a harvest or a day does — so this settles
    // between events rather than never, which is what a signature has to do.
    live: (ui) => (ui.state?.milestones ?? [])
      .map((m) => `${m.id}${m.have}${m.done ? '!' : ''}`).join(','),
    rows: (ui) => {
      const all = ui.state?.milestones ?? [];
      if (!all.length) return [];
      const todo = all.filter((m) => !m.done);
      const done = all.filter((m) => m.done);
      return [
        ...(todo.length ? [{ sep: 'To go', icon: ICONS.milestone }] : []),
        ...todo.map((m) => ({
          icon: ICONS.milestone,
          name: m.name,
          sub: `${m.blurb} ${rewardWords(m.reward)}`,
          right: `${amount(m.have, m.unit)} / ${amount(m.need, m.unit)}`,
          bar: m.need > 0 ? m.have / m.need : 0,
          plain: false,
        })),
        ...(done.length ? [{ sep: 'Done', icon: ICONS.medal }] : []),
        ...done.map((m) => ({
          icon: ICONS.medal,
          name: m.name,
          sub: rewardWords(m.reward),
          right: '✓',
          // Dimmed the way an owned upgrade is: still listed, because the
          // ladder is the point and a list that deleted its top half would get
          // shorter the better you did.
          dim: true,
        })),
      ];
    },
    /**
     * The town, which is the whole reason this panel is worth having open.
     *
     * `catchment` has been on the wire since the shop had customers and has
     * never once been drawn — so the one term shopkeeping cannot move was also
     * the one number nobody could see. It belongs here rather than in the
     * corner HUD because this is the only place anything changes it.
     */
    foot: (ui) => {
      const n = ui.state?.catchment;
      if (n == null) return 'Milestones grow the town.';
      return `<b>${Math.round(n)}</b> people within reach of the shop. Milestones grow the town — so do parking, charm and a better address.`;
    },
  },

  {
    // `help` is the id a save, a key binding and `docs/audio.md` all spell, so
    // it stays; what the player reads is the Menu, behind a hamburger. The
    // question mark was always a lie about what is in here — the keys are one
    // of four things it holds, beside the shop you are in, the sound and the
    // credits — and three bars is the one glyph every player already reads as
    // "everything else".
    id: 'help',
    icon: ICONS.menus,
    name: 'Menu',
    key: '/',
    title: 'Menu',
    /**
     * The Sound rows, and nothing else in this menu.
     *
     * Every other row here is a fixed sentence about a key, so this section
     * never had a `live` and never needed one. A switch does: one that did not
     * redraw would read as a press that didn't land, and the honest test of a
     * switch is that it moved. `orderRows` made the same call about the
     * supplier's three. The track name is in it too, so the Music row keeps up
     * with the playlist while you have the tab open.
     */
    live: () => `${mix.signature()}|${music.nowPlaying()?.id ?? '-'}`
      + `|${CORNERS.map((c) => (isOff(c.id) ? '-' : '+')).join('')}`,
    // Every line here is clamped to one line in a 214px panel, so the copy has
    // to be short enough to survive it — an ellipsis mid-word is worse than a
    // blunter phrase. The long version lives in `sub`, which is also the hover.
    //
    // THREE tabs, and the split is by what a row IS rather than by what it is
    // about: something you do (the save, the volume), something you look up
    // (every key in the game), something you are owed (the credits). It was
    // seven, split by topic — Camera and Building are perfectly good headings
    // and hopeless tabs, because "which quarter of the keyboard is this key in"
    // is a question you have to answer before you can look a key up. A tab
    // strip is a promise that the tabs are alternatives, and four flavours of
    // one reference list are not alternatives. `tabGroups` reads an icon on a
    // `sep` as the opt-in, so demoting a heading to a plain divider is the
    // whole change — the four are still there, in order, one scroll apart.
    rows: (ui) => [
      // Which game you are in, the way out of it, and how loud it is: the only
      // rows in the menu that DO something. Leaving is here rather than on the
      // rail because it is the rarest thing you do, and the rail is for what
      // you reach for from anywhere (see docs/ui-shell.md).
      { sep: 'Game', icon: ICONS.settings },
      { name: ui.net?.world?.name ?? 'This shop', sub: 'the save you are playing', plain: true },
      {
        icon: ICONS.close,
        name: 'Leave to menu',
        sub: 'saves, and back to the shop list',
        run: () => ui.leaveToMenu(),
      },
      ...soundRows(ui),
      ...cornerRows(ui),

      { sep: 'Controls', icon: ICONS.walk },
      { sep: 'Getting about' },
      { name: 'Go there', sub: 'point at a thing and you walk over and do it', right: 'click', plain: true },
      { name: 'Walk yourself', sub: 'takes the wheel back off a route', right: 'WASD', plain: true },
      { name: 'Use a thing', sub: 'stand by it — walk off to stop', right: 'wait', plain: true },
      { name: 'Open its menu', sub: 'the same press, held still', right: 'hold', plain: true },
      { sep: 'Camera' },
      { name: 'Look around', sub: 'stays put until you go somewhere', right: 'drag', plain: true },
      { name: 'Zoom', sub: 'or pinch', right: 'scroll', plain: true },
      { name: 'Turn the view', sub: 'a quarter turn each way', right: ', .', plain: true },
      { name: 'or swing to turn', sub: 'right button, or twist two fingers', right: 'R-drag', plain: true },
      { sep: 'Menus' },
      ...SECTION_KEYS(),
      { name: 'Back out', sub: 'menu, then hands, then build mode', right: 'Esc', plain: true },
      { name: 'Back out on the world', sub: 'a click, not a drag — drops a half-drawn wall first', right: 'R-click', plain: true },
      { sep: 'Building' },
      { name: 'Build mode', sub: 'rearrange what is already there — nothing armed', right: 'G', plain: true },
      // The second press, listed as its own row because it is its own press. A
      // key that does something different the second time you press it is not a
      // thing anybody finds by pressing it once.
      { name: 'and the palette', sub: 'press again for the catalogue, again to leave', right: 'G', plain: true },
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

      ...creditRows(),
    ],
  },
];

/**
 * One volume, as a stepper.
 *
 * There is no slider in this game and there does not need to be one. A drag
 * inside a panel fights the panel's own drag (`panel-drag.js`) and wants a
 * pointer, and ten steps is finer than anybody has ever adjusted a game volume.
 * `stp` is the widget the supplier's min/max nudgers are built from, so this is
 * markup that already exists, is already styled and is already wired — see
 * `wireRows`, which knows nothing about which menu a `data-act` landed in.
 */
function volRow(ui, bus, icon, name, sub) {
  const now = mix.volume(bus);
  const pct = Math.round(now * 100);
  const step = (d) => () => {
    mix.setVolume(bus, Math.round((now + d) * 10) / 10);
    // Repainted at once rather than on the next snapshot: a tenth of a second
    // is long enough for a press on a stepper to read as having missed.
    ui.paintSection();
  };
  return {
    icon,
    name,
    sub,
    rule: `<span class="rule"><span class="stp">
      <button class="rbtn" data-act="down" aria-label="quieter ${name}">−</button>
      <b class="${pct ? '' : 'none'}">${pct}%</b>
      <button class="rbtn" data-act="up" aria-label="louder ${name}">+</button>
    </span></span>`,
    acts: { down: step(-0.1), up: step(0.1) },
  };
}

/**
 * The volumes, under the Game tab.
 *
 * They live in this menu rather than in one of their own because this is the
 * only menu in the game about the *game*: everything else on the rail is about
 * the shop — what it owns, what it sells, how it is doing — which is also why
 * the way out to the shop list is above them. `orderRows` already made this
 * call once: they are settings, and settings are somewhere you go.
 *
 * A plain `sep` rather than an icon'd one, which is what demotes them from a
 * tab of their own to a heading inside the Game tab. Four volume rows is not
 * enough to be worth a click, and a menu that opened on the save and hid the
 * sound one tab away is a settings menu you have to go looking for the settings
 * in.
 *
 * Only a bus that exists gets a row. A knob that turns nothing is the same trap
 * as a tier that changes no number — it looks finished, it takes an input, and
 * nothing happens.
 */
function soundRows(ui) {
  const off = mix.muted;
  const track = music.nowPlaying();
  return [
    { sep: 'Sound' },
    {
      icon: off ? ICONS.muted : ICONS.speaker,
      name: 'Sound',
      sub: off ? 'Silent. Everything else keeps running.' : 'On.',
      picked: !off,
      tail: off ? 'Off' : 'On',
      run: () => { mix.setMuted(!off); ui.paintSection(); },
    },
    volRow(ui, 'master', ICONS.speaker, 'Overall', 'everything, together'),
    volRow(ui, 'sfx', ICONS.shop, 'The shop', 'tills, crates, your own hands'),
    volRow(ui, 'music', ICONS.music, 'Music', track ? `now: ${track.name}` : 'between tracks'),
  ];
}

/**
 * What is showing in the corner, under the Game tab.
 *
 * The rows exist because the ✕ does: a widget you closed is off screen, so the
 * only way back has to be somewhere you can find without it. Under Game rather
 * than a tab of their own for the reason `soundRows` gives — two switches is
 * not a click's worth of menu, and this is already the one menu about the game
 * rather than about the shop.
 *
 * Drawn from `CORNERS` rather than written out, so anything wired with
 * `wireCorner` is listed here the day it exists. A widget that could be closed
 * and was not on this list would be one nobody could bring back, which is the
 * one way to get this wrong that a player finds before you do.
 */
function cornerRows(ui) {
  return [
    { sep: 'In the corner' },
    ...CORNERS.map((c) => {
      const off = isOff(c.id);
      return {
        icon: icon(c.icon, ICONS.settings),
        name: c.name,
        sub: off ? 'Put away.' : c.sub,
        picked: !off,
        tail: off ? 'Off' : 'On',
        // Repainted at once, the same call the Sound switch makes: the honest
        // test of a switch is that it moved, and the thing this one moves is
        // in the other corner of the screen.
        run: () => { setOff(c.id, !off); ui.paintSection(); },
      };
    }),
  ];
}

/**
 * Who made it, generated from the manifest.
 *
 * `passive` — it reports rather than offers work, so it is drawn and reachable
 * like any other tab and simply never the one `/` opens on. A licence list is
 * the last thing anybody wants when they pressed the menu key to find out how
 * to turn a shelf round.
 *
 * Nothing here is typed. Every row is a manifest entry, which is what makes a
 * credit a property of the sound rather than a list somebody has to remember to
 * update — see `client/audio/manifest.js`.
 */
function creditRows() {
  return [
    { sep: 'Credits', icon: ICONS.music, passive: true },
    // Every row plays. A credits list is the one screen in the game that names
    // all of it in one place, so it is also the only place you can *audition* a
    // sound — and a sound you cannot trigger on demand is one you can only tune
    // by waiting for a shopper to lose their temper. Tapping a sound plays it;
    // tapping a track puts the radio on it.
    ...SOUNDS.map((c) => ({
      icon: ICONS.speaker,
      name: c.name,
      sub: `${c.by} · ${c.from}`,
      right: c.licence,
      // The robot is the one sound that is not a whole file — it is a slice, at
      // a pitch, so previewing the raw five seconds would audition something
      // the game never plays. See `CHIRP` in client/audio/events.js.
      run: () => (c.id === 'robot'
        ? sfx.play('robot', null, { rate: 0.65, dur: 0.3, every: 0 })
        : sfx.play(c.id, null, { every: 0 })),
    })),
    ...TRACKS.map((c) => ({
      icon: ICONS.music,
      name: c.name,
      sub: `${c.by} · ${c.from}`,
      right: c.licence,
      picked: music.nowPlaying()?.id === c.id,
      run: () => music.playById(c.id),
    })),
    {
      icon: ICONS.help,
      name: 'Icons',
      sub: 'game-icons.net (CC BY 3.0) and Remix Icon (Apache 2.0)',
      right: 'CC BY',
    },
  ];
}

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
 * The rail, top to bottom. Build leads it, because it is the mode you are in
 * most, and the roster follows it — the two you reach for while the shop is
 * running. Neither is a section.
 *
 * Upgrades used to sit second, with them, on the argument that the three which
 * own the bottom bar belong together. It reads better beside Milestones: both
 * are the shop's long game rather than this afternoon, and the ladder you are
 * saving for is the reason to open either — and it is a section again, so it
 * sits in `SECTIONS` in that order rather than being spliced in here.
 */
export const RAIL_ITEMS = [BUILD_MODE, STAFF_BAR, ...SECTIONS];

export const railItemById = (id) => RAIL_ITEMS.find((s) => s.id === id) ?? null;
