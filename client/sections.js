import { ICONS, icon } from './icons.js';
import { pinLast } from './bar.js';
import { FIXTURES, isProp, isGround, FLOOR_KIND } from '../shared/build.js';
import { kindOf, countKey } from '../shared/pieces.js';
import { artForTool, artForStation } from './thumb.js';
import { showWorker, doingNow, bodyOf, kindSummary } from './worker-menu.js';

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
    // the yard is what you lay once the shop it serves exists.
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
    ],
  },
  { id: 'decor', name: 'Decoration', icon: ICONS.fixtures, blurb: 'Looks. Weighs nothing and stops nobody.' },
];

/** Whether a palette entry belongs to a group. A tool may name several. */
const inGroup = (t, id) => (Array.isArray(t.group) ? t.group.includes(id) : t.group === id);

/** The same question one level down. A tool may name several sub-tabs too. */
const inSub = (t, id) => (Array.isArray(t.sub) ? t.sub.includes(id) : t.sub === id);

/**
 * Which sub-tab of a split group an entry sits on.
 *
 * Falling through to the first rather than to nothing, for the same reason a
 * kind nobody grouped lands in the shop: an entry on no sub-tab is one no tab
 * shows, which is the same as not existing. So authoring a new kind under
 * Building misfiles it at worst, rather than making it unbuildable.
 */
const subIdFor = (g, t) => g.subs.find((s) => inSub(t, s.id))?.id ?? g.subs[0]?.id ?? null;

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
        // A picture of the thing, off its own row. `icon` stays as the fallback
        // for a kind nobody has drawn — those are the entries with no `p.model`
        // to draw, and a generic box would claim they look like something.
        art: artForTool({ paint, kind }, p),
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
      art: artForStation(machine, u.payload.station),
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
  const tools = buildTools(ui).map((t) => {
    const cost = ui?.buildCosts?.[t.id];
    // How many of these are standing in the shop. It was a line of the old
    // panel's row copy, and it is the half worth keeping — "six owned" is what
    // decides whether a seventh is the buy.
    const have = ownedCount(ui, t);
    return {
      ...t,
      note: cost == null ? '' : `$${cost.toFixed(0)}`,
      badge: have ? String(have) : '',
      title: `${t.name} — ${t.blurb}`,
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
 * The same two rules the tabs above them follow, one level down: an empty
 * sub-tab never renders, and a group left with fewer than two of them shows the
 * flat list instead — one sub-tab is a row of chrome asking a question with a
 * single answer. That is what a world with no floors authored gets, and it means
 * the split can never make Building *harder* to read than it was flat.
 *
 * Pinned entries are on every sub-tab, the way Demolish is on every tab: "get
 * rid of that" is not a question about which part of the building it is.
 */
function splitGroup(g, items) {
  if (!g.subs) return null;
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
 * "All" first and always, because with four hires that is the only tab anybody
 * wants; the per-kind tabs earn their place at twenty. They are generated from
 * who actually works here rather than from the `workers` table — a tab for a
 * kind you have never hired is a tab that opens onto nothing, and the one for
 * the kind you just took on should appear without anybody listing it here.
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

  const person = (e) => {
    const body = bodyOf(ui, e);
    return {
      id: `hire:${e.id}`,
      hire: e.id,
      icon: icon(e.kind, ICONS.staff),
      name: e.name,
      note: doingNow(ui, e, body),
      title: `${e.name} — ${doingNow(ui, e, body)}`,
      warn: !body,
    };
  };

  // The way to take somebody on, pinned to the end of every tab. It opens the
  // hire catalogue as a panel rather than listing kinds along here: hiring is
  // browsing — wages, jobs, what each one is for — and the bar is for choosing
  // between things you already have.
  const hire = {
    id: 'hire-new',
    hire: null,
    last: true,
    icon: ICONS.upgrades,
    name: 'Hire',
    note: `${kinds.length} to pick from`,
    title: 'Take somebody else on',
  };

  const seen = [...new Set(roster.map((e) => e.kind))];
  return [
    { id: 'all', name: 'Everyone', icon: ICONS.staff, blurb: 'Everybody on shift.', items: [...roster.map(person), hire] },
    ...seen.map((k) => ({
      id: `kind:${k}`,
      name: nameOfKind(k),
      icon: icon(k, ICONS.staff),
      blurb: `Everyone taken on as a ${nameOfKind(k).toLowerCase()}.`,
      items: [...roster.filter((e) => e.kind === k).map(person), hire],
    })),
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
      note: have ? 'owned' : `$${u.cost.toFixed(0)}`,
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

const money = (n) => `$${n.toFixed(2)}`;

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
  return buckets.flatMap((b, i) => (
    bins[i].length ? [{ sep: b.label, icon: b.icon }, ...bins[i]] : []
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
  badge: (ui) => {
    const owned = ui.ownedUpgrades ?? [];
    const n = buyableUpgrades(ui)
      .filter((u) => !owned.includes(u.id) && (ui._cash ?? 0) >= u.cost
        && (u.requires ?? []).every((r) => owned.includes(r))).length;
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
    live: (ui) => String(Math.floor(ui._cash ?? 0)),
    // Grouped by where the thing has to live, not by what aisle it belongs in.
    // The tag chips already slice by category; what the tabs answer is the
    // question you cannot answer from the name — "do I even have somewhere to
    // put this", which is what decides whether buying it was a mistake.
    rows: (ui) => grouped(
      ui.catalog.items.map((it) => ({
        name: it.name,
        // What the world thinks of this one today. The tag chips tell you what
        // it *is*; this tells you whether buying it right now is clever.
        heat: ui.heatPill(it),
        sub: it.tags.slice(0, 3).join(' · '),
        right: money(it.base_cost),
        facets: it.tags,
        tags: it.tags,
        dim: (ui._cash ?? 0) < it.base_cost * 6,
        button: { label: '×6', run: () => ui.net.send('buy-stock', { itemId: it.id, qty: 6 }) },
      })),
      [
        { label: 'Frozen', icon: ICONS.cold, test: (r) => r.tags.includes('needs-freezer') },
        { label: 'Fresh', icon: ICONS.fresh, test: (r) => r.tags.includes('perishable') },
        // Everything else keeps at room temperature, including anything an
        // author never tagged either way — a shelf is the safe default.
        { label: 'Keeps', icon: ICONS.ambient },
      ],
    ),
    foot: () => 'Lands at the bay as a pallet.',
  },

  {
    id: 'staff',
    icon: ICONS.staff,
    name: 'Staff',
    key: 'h',
    title: 'Who works here',
    // The rail's Staff press claims the bottom bar rather than opening this
    // panel — the roster is a list of people you pick between, which is what
    // the bar is for. The panel is still here and still a section; it is what
    // the bar's Hire entry opens, and what `showSection('staff')` reaches.
    bar: 'staff',
    facet: 'tag',
    // The roster is the ledger of who works here; the NPC on the floor is only
    // its body. Reading the roster rather than counting bodies means someone
    // whose kind was deleted still shows up — as a problem, which is what they
    // are — instead of quietly vanishing off the payroll.
    badge: (ui) => {
      const n = (ui.state?.roster ?? []).length;
      return n ? String(n) : null;
    },
    live: (ui) => JSON.stringify([
      ui.state?.roster,
      (ui.state?.players ?? []).filter((p) => p.staff)
        .map((p) => [p.hire, p.job, p.carry?.qty, p.pastime]),
      Math.floor(ui._cash ?? 0), ui.catalog.version,
    ]),
    // Only the hiring half. The roster itself moved to the bottom bar — see
    // `staffGroups` — because a list of people is exactly the thing the bar was
    // built for, and a person is reached by pressing them the way a fixture is.
    // What is left here is a shop for hires, which is a browsable catalogue and
    // therefore a panel, the same as the supplier.
    rows: (ui) => {
      const kinds = ui.catalog.workers ?? [];
      const roster = ui.state?.roster ?? [];
      const rows = [{ sep: roster.length ? 'Take someone else on' : 'Nobody works here yet' }];
      // Straight off the `workers` table, so a kind authored over MCP can be
      // hired with no client change — and hiring the same kind twice is a
      // second person, not a refusal.
      rows.push(...kinds.map((w) => ({
        icon: icon(w.id, ICONS.staff),
        name: w.name,
        sub: kindSummary(w),
        right: `$${w.cost.toFixed(0)}`,
        facets: w.tags ?? [],
        dim: (ui._cash ?? 0) < w.cost,
        button: { label: 'hire', run: () => ui.net.send('hire', { kind: w.id }) },
      })));
      return rows;
    },
    foot: () => `They obey the same rules you do — they walk, queue and carry.
      Whoever is on shift is along the bottom; tap one to change what they do.`,
  },

  {
    id: 'shop',
    icon: ICONS.report,
    name: 'Shop',
    key: 't',
    title: 'How the shop is doing',
    // Today's numbers only. The server keeps yesterday's in `_lastDayStats` but
    // does not send them, so this deliberately says "today" rather than inventing
    // a comparison it cannot make.
    badge: (ui) => {
      const s = ui.state?.stats;
      if (!s) return null;
      const profit = (s.revenue ?? 0) - (s.spent ?? 0);
      if (!s.revenue && !s.spent) return null;
      return profit >= 0 ? '▲' : '▼';
    },
    live: (ui) => JSON.stringify([ui.state?.stats, ui.state?.fixtures, ui.state?.modifiers?.length,
      (ui.state?.shelves ?? []).filter((s) => !(s.stacks ?? []).some((k) => k.qty > 0)).length]),
    rows: (ui) => {
      const s = ui.state;
      if (!s) return [];
      const st = s.stats ?? {};
      const shelves = s.shelves ?? [];
      const plots = s.plots ?? [];
      const stat = (name, right, sub) => ({ name, right, sub, plain: true });
      const best = Object.entries(st.byItem ?? {}).sort((a, b) => b[1] - a[1])[0];

      return [
        { sep: 'Today', icon: ICONS.today },
        stat('Taken', money(st.revenue ?? 0), `${st.sold ?? 0} sold`),
        stat('Spent', money(st.spent ?? 0), 'stock, seed and building'),
        stat('Profit', money((st.revenue ?? 0) - (st.spent ?? 0)), 'what is actually left'),
        best ? stat('Best seller', `${best[1]}`, ui.itemName(best[0])) : null,

        { sep: 'Going wrong', icon: ICONS.trouble },
        stat('Walked out', String(st.abandoned ?? 0), 'queued too long or could not find it'),
        stat('Found nothing', String(st.leftEmpty ?? 0), 'came in, shelf was bare'),
        stat('Spoiled', String(st.spoiled ?? 0), 'sat out past its shelf life'),

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
      { name: 'Build mode', sub: 'tap ground to place, tap a fixture to open', right: 'G', plain: true },
      { name: 'Turn a fixture', sub: 'a quarter turn', right: 'R', plain: true },
      { name: 'Bottom bar', sub: 'the open tab while building, seeds otherwise', right: '1–9', plain: true },
      { name: 'Next tab', sub: 'every tab in turn, and every part of a split one', right: 'Tab', plain: true },
    ],
  },
];

/** The menu keys, listed from the same array that binds them. */
function SECTION_KEYS() {
  return SECTIONS.map((s) => ({
    name: s.name, sub: s.title, right: s.key.toUpperCase(), plain: true,
  }));
}

export const sectionById = (id) => SECTIONS.find((s) => s.id === id) ?? null;

/**
 * The rail, top to bottom. Build leads it because it is the mode you are in
 * most, and it is not a section — see `BUILD_MODE`.
 */
export const RAIL_ITEMS = [BUILD_MODE, UPGRADE_BAR, ...SECTIONS];

export const railItemById = (id) => RAIL_ITEMS.find((s) => s.id === id) ?? null;
