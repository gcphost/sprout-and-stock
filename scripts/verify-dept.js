#!/usr/bin/env node
/**
 * VERIFY: A BAKERY IS FOR BREAD, AND EVERY OTHER UNIT IN THE SHOP IS UNCHANGED.
 *
 * The Bakery, the Deli and the Produce table were art. `bakery-case` is
 * `kind: shelf` and `deli-counter` is `kind: freezer`, so the only thing a Deli
 * ever refused was anything that did not need chilling — and the one function
 * whose job is choosing a range (`pickItem`) scored every unit identically and
 * cheerfully filled the bakery case with liquorice. Nothing logged it, nothing
 * drew it wrong, and the case looked exactly like a bakery case the whole time.
 * What that reads as is the themed pieces being decorative, which is a fair
 * description of what they were.
 *
 * `inDepartment` is the rule, and it is `holds` one axis over: that one is a
 * fact about the KIND (cold, a closed set in `BUILD_KINDS`) and this is a fact
 * about the PIECE (content, twelve words in `DEPARTMENTS`). Which is the whole
 * reason it can exist at all — `kind` had no room for a fourth answer and
 * `tags` has room for twelve.
 *
 * Everything here is invisible twice over, with one exception that proves the
 * rest. You CAN see salsa in a bakery case, if you happen to read the label on
 * the board rather than the shape of the unit — and that is the only claim in
 * this file a screenshot could settle. The others cannot: a shop that never
 * tagged a piece and a shop where the rule is quietly doing nothing are the
 * same shop; a unit the buyer skipped and a unit the buyer had nothing for are
 * the same empty shelf; and a home that can never be refilled looks exactly
 * like a shelf that has sold out.
 *
 * The claims:
 *
 * - **The control, and it is what decides whether any of this is opt-in.** A
 *   piece with no departments takes everything it took the day before, in all
 *   five places. Every `fixtures` row in every save carries `tags: []` today,
 *   so a control that is wrong has silently relocked every shelf in existence
 *   — and it would present as the crew having stopped stocking, four presses
 *   downstream of nothing at all. Doubled, because a piece tagged with a
 *   NON-category word (`lamp`, which the palette reads to file a planter under
 *   Greenery) has to be inert as well: a rule that took any tag would make a
 *   piece's `tags` a switch whose other settings are booby traps.
 *
 * - **The centrepiece is a PAIR that is worthless split in half.** The locked
 *   unit refuses the wrong item AND still takes the right one, asserted in the
 *   same shop in the same breath. Either half alone is satisfied by a unit that
 *   takes nothing whatsoever, which is the commonest way to get this wrong and
 *   the one that reads as the shelf being broken rather than as a rule.
 *
 * - **Five doors, and the fifth is the one the feature is FOR.** Four of them
 *   stop goods being put somewhere: the highlight (`shelfAccepts`), the press
 *   (`boardFor`), the pour (`stockFromCrate`) and the tick (`assignShelf`). The
 *   fifth is `pickItem`, the shop choosing a range for a bare unit, and it is
 *   the only one anybody would ever notice was missing — the other four are
 *   about a press you would not make.
 *
 * - **The tick has to be REFUSED, or it is the door left open.** A reservation
 *   outranks nearly every judgement the shop makes about its own range —
 *   `droppedItem`, `backRoomTakes` and `homedAt` all bow to it, and `shelvesFor`
 *   spells that out. So a tick that was allowed would be the one gesture that
 *   unlocks a Bakery, and it would not read as a way round anything: you would
 *   tick fish onto it, watch nothing ever arrive, and blame the crew.
 *
 * - **It binds YOUR hands too, which was the decision.** It could have been the
 *   shop's judgement alone — `giveUpBoard` and `orders.assign` draw that line
 *   and it is right for both — but those are the shop deciding what to BUY,
 *   where this is a fact about the unit, like its cold. The crate settles it:
 *   `pourInto` empties a mixed box pile by pile, so a loose rule puts the salsa
 *   on a board and leaves the bread in the box. One press, no refusal, and the
 *   shop has done the one thing you cannot have meant. It is `holds`' own
 *   argument, and this sweep asserts it the same way `verify:hot` does.
 *
 * - **A rule made today against shelves stocked yesterday.** Content is edited
 *   live, so tagging a piece is a press made over a shop that is already full.
 *   Two claims fall out and they pull opposite ways: what is already standing
 *   on the unit STAYS and sells down (the shed is not asked — that is
 *   `assignShelf`'s own call about goods you did not tick), and the unit must
 *   stop being that item's HOME. Without the second, the Bakery is still
 *   holding the most salsa in the shop, wins `homeShelves`, and every other
 *   shelf is then refused for not being the home — one item with no legal home
 *   anywhere, its crates stranded on the pad, every refusal correct.
 *
 * - **SEVERAL is an or.** A Deli tagged `meat` and `dairy` takes both, or the
 *   second tag is a way of emptying the unit and nothing anybody authored means
 *   what it looks like.
 *
 * - **Nothing is stored.** The departments are read off the piece, so no save
 *   field, no migration, and a re-flow and an R press both keep them — which is
 *   `repositionFixture`'s named-field trap, arriving for a setting that
 *   deliberately has no field to be forgotten.
 *
 * It authors four pieces and one worker and removes all five on exit. It tags
 * no items: the ones it needs are real rows already carrying real departments,
 * chosen by search rather than by id, so a catalogue somebody edits tomorrow
 * moves the sweep with it instead of breaking it.
 *
 *   node scripts/verify-dept.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { shelfKind } from '../shared/build.js';
import {
  DEPARTMENTS, TAG_GROUPS, departmentsOf, inDepartment, homeKind,
} from '../shared/tags.js';
import { WALKABLE } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

// ---------------------------------------------------------------------------
// The pieces. Four designs of one kind, differing only in `tags` — which is the
// shape of the whole feature, and is why they are all `shelf`: a claim that
// needed a freezer to make would be a claim about `holds`, which has its own
// sweep. Removed on exit, crash or not, the way `verify-catalog` does it.
// ---------------------------------------------------------------------------
// TWO boards, which is not decoration: `boardsOf` reads the art, so a bare box
// is a one-board unit and §8's second reservation would be refused for want of
// a board — an assertion about `and` failing for a reason that has nothing to
// do with `and`, which is the shape of a sweep that lies.
const box = (color) => ({
  parts: [
    { shape: 'box', color, pos: [0, 0.45, 0], scale: [0.8, 0.9, 0.8] },
    { shape: 'box', color: '#c8b08a', pos: [0, 0.30, 0], scale: [0.76, 0.04, 0.72], surface: true },
    { shape: 'box', color: '#c8b08a', pos: [0, 0.70, 0], scale: [0.76, 0.04, 0.72], surface: true },
  ],
});
const PIECES = [
  { id: 'zz-dept-open', name: 'Test Open Shelf', tags: [] },
  { id: 'zz-dept-lamp', name: 'Test Tagged Shelf', tags: ['lamp'] },
  { id: 'zz-dept-one', name: 'Test Bakery', tags: [] },     // filled in below
  { id: 'zz-dept-two', name: 'Test Deli', tags: [] },       // filled in below
].map((p) => ({ ...p, kind: 'shelf', model: box('#d8a05a'), cost: 100, tiers: [{ name: 'Only', cost: 0 }] }));
const [OPEN, LAMP, ONE, TWO] = PIECES;

/** One hire whose whole day is ordering — `verify-order`'s buyer exactly. */
const BUYER = {
  id: 'zz-dept-buyer', name: 'Test Buyer', color: '#4b7a9e',
  jobs: [{ job: 'restock', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};

process.on('exit', () => {
  for (const p of PIECES) { try { remove('fixtures', p.id); } catch { /* DB gone */ } }
  try { remove('workers', BUYER.id); } catch { /* DB gone */ }
});

// ---------------------------------------------------------------------------
// The items, chosen by SEARCH rather than by id.
//
// Naming `bread` and `liquorice` would be a sweep that breaks the day somebody
// retags one, and — worse — a sweep that passes for the wrong reason the day
// somebody deletes one, because `pickItem` skips an item it cannot look up and
// every assertion below would then be measuring an empty candidate list.
//
// Ambient only (`homeKind === 'shelf'`), so nothing here is refused by `holds`
// and every refusal this file sees is the department's. Not a recipe output,
// because `restock` leaves those to the kitchen (`isCrafted`) — a crafted item
// would be skipped in the same loop for a reason that has nothing to do with
// departments, and the buyer section would read as the rule having failed.
// ---------------------------------------------------------------------------
const c = content();
const ambient = (it) => homeKind(it) === 'shelf'
  && !c.recipes.some((r) => r.output_id === it.id);
const inDept = (d) => c.items.filter((it) => ambient(it) && it.tags.includes(d));

/**
 * Two departments with stock in them, and a third the pair does not touch.
 *
 * Derived rather than written down: the assertions below are all comparisons
 * between "an item of the department this unit names" and "an item of one it
 * does not", and picking those by hand is how a sweep ends up asserting that
 * bread is not liquorice.
 */
const usable = DEPARTMENTS.filter((d) => inDept(d).length > 0);
check(usable.length >= 3, 'the catalogue has three ambient departments to test with', `${usable.length}`);
const [D1, D2, D3] = usable;
ONE.tags = [D1];
TWO.tags = [D1, D2];

/** An item of D1, of D2, and one carrying neither. */
const MINE = inDept(D1)[0];
const ALSO = inDept(D2)[0];
const OTHER = c.items.find((it) => ambient(it) && !it.tags.includes(D1) && !it.tags.includes(D2));
check(MINE && ALSO && OTHER, 'three items: one in each department and one in neither');

for (const p of PIECES) {
  const res = writeContent('fixture', p, 'verify');
  check(res.ok, `the catalog accepts ${p.id}`, res.error ?? '');
}
{
  const res = writeContent('worker', BUYER, 'verify');
  check(res.ok, 'the catalog accepts the buyer', res.error ?? '');
}

// ---------------------------------------------------------------------------

/** The same reset every other sweep makes — see `verify-pack` on each field. */
function fresh({ buyer = false } = {}) {
  const g = Game.create({ worldId: 'verify-dept', seed: 'dept', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 500000;
  g.open = false;                    // nobody buying stock out from under us
  g.orders.auto = false;             // see `verify-order`: on, it front-runs the setup
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  if (buyer) {
    const res = g.hire(BUYER.id);
    check(res.ok, 'the buyer joins', res.error ?? '');
    g.step(0.1);                     // `hire` writes the roster; `syncStaff` puts the body in
    g.orders.pending = [];
  }
  return g;
}

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };

/** A free indoor floor tile with nothing on it — `verify-hot`'s, unchanged. */
function freeFloor(g, taken = new Set()) {
  const L = g.layout;
  for (let z = L.store.z; z < L.store.z + L.store.h; z++) {
    for (let x = L.store.x; x < L.store.x + L.store.w; x++) {
      if (taken.has(`${x},${z}`)) continue;
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      if (g.fixtureAt(x, z)) continue;
      if ((L.props ?? []).some((p) => p.x === x && p.z === z)) continue;
      return { x, z };
    }
  }
  return null;
}

/**
 * The live record for a unit, by id.
 *
 * Never hold one across a press. `placeFixture` re-flows, and `compose` rebuilds
 * every shelf record from its placement — so a record captured before the
 * second unit goes up is a detached object, and writing stock onto it writes it
 * nowhere. The id survives; the object does not. This is CLAUDE.md's "ids
 * captured before the first message go stale" said about the record instead,
 * and it cost this file three assertions on its first run.
 */
const live = (g, id) => g.layout.shelves.find((s) => s.id === id) ?? null;

/** Stand a unit of one design up and hand back its id. */
function build(g, piece, taken = new Set()) {
  const spot = freeFloor(g, taken);
  check(spot != null, `there is room for a ${piece.id}`);
  if (!spot) return null;
  taken.add(`${spot.x},${spot.z}`);
  const res = g.placeFixture('me', { kind: 'shelf', piece: piece.id, x: spot.x, z: spot.z, rot: 0 });
  check(res.ok, `a ${piece.id} goes up`, res.error ?? '');
  return res.ok ? res.placed : null;
}

/** Every other unit stripped, so nothing else can answer a question. */
function onlyUnit(g, keepId) {
  for (const sh of g.layout.shelves) {
    if (sh.id === keepId) continue;
    sh.stacks = [];
    sh.assigned = [];
  }
}

/** Put goods on a board directly, the way a delivery would have. */
const stand = (g, shelf, item, qty) => {
  g.openStack(shelf, item);
  const k = g.shelfStack(shelf, item.id);
  if (k) k.qty = qty;
};

const qtyOf = (g, shelf, itemId) => (g.layout.shelves.find((s) => s.id === shelf.id)?.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);
const lotOf = (lot, itemId) => (lot?.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);

// ---------------------------------------------------------------------------
// 1. The vocabulary, and the one rule reading the table cannot check.
// ---------------------------------------------------------------------------
{
  eq(DEPARTMENTS, TAG_GROUPS.category, 'a department IS the category group');
  check(DEPARTMENTS.length >= 6, 'there are departments to name', `${DEPARTMENTS.length}`);

  // Empty is anything, at the bottom of the stack where it cannot be argued
  // with. Asserted of the pure function as well as through a Game, because
  // every opt-in claim in this file rests on this one line.
  eq(departmentsOf(null).length, 0, 'a piece that does not exist names no department');
  eq(departmentsOf({}).length, 0, 'nor does one with no tags at all');
  eq(departmentsOf({ tags: [] }).length, 0, 'nor an empty list');
  check(inDepartment(null, MINE), 'and no piece takes anything');
  check(inDepartment({ tags: [] }, MINE), 'and neither does an untagged one');

  // The non-category half of the control. A piece's tags are read by the
  // palette to file a decoration, so a rule that took ANY tag would make a
  // planter tagged `plant` a unit holding only items tagged `plant`, which is
  // nothing at all — and it would look exactly like this feature working.
  for (const t of [...TAG_GROUPS.decor, ...TAG_GROUPS.quality, ...TAG_GROUPS.diet]) {
    eq(departmentsOf({ tags: [t] }).length, 0, `${t} is not a department`);
    check(inDepartment({ tags: [t] }, MINE), `a piece tagged ${t} still takes anything`);
  }

  // Order is the table's, not the piece's, so two pieces authored the same two
  // words in different orders say the same sentence in the menu.
  const back = [...DEPARTMENTS].reverse();
  eq(departmentsOf({ tags: back }).join(), DEPARTMENTS.join(),
    'departments come back in the table\'s order however they were authored');
}

// ---------------------------------------------------------------------------
// 2. THE CONTROL. A piece nobody tagged is the shop as it shipped.
//
// Doubled: no tags at all, and a tag from outside the category group. This is
// the assertion that decides whether the feature is opt-in, and every fixture
// row in every save in existence is one of these two.
// ---------------------------------------------------------------------------
for (const piece of [OPEN, LAMP]) {
  const g = fresh();
  const id = build(g, piece);
  if (!id) continue;
  const unit = live(g, id);

  eq(g.shelfDepartments(unit).length, 0, `a ${piece.name} names no department`);

  // Every ambient item in the catalogue, and not a sample of them: the failure
  // this guards is a rule that fires on the wrong axis, which would show up on
  // whichever item happened to be tested rather than on all of them.
  const ambientItems = c.items.filter(ambient);
  check(ambientItems.length > 0, 'there are ambient items to sweep');
  const refused = ambientItems.filter((it) => !g.departmentTakes(unit, it));
  eq(refused.length, 0, `an untagged ${piece.name} refuses nothing`,
    refused.slice(0, 3).map((it) => it.id).join(', '));

  // …and through the three verbs, not only the predicate. The predicate being
  // right and a call site having been missed is the same shop from a chair.
  check(g.shelfAccepts(unit, OTHER.id), 'the highlight lights it up');
  const tick = g.assignShelf('me', unit.id, OTHER.id, true);
  check(tick.ok, 'and the tick is allowed', tick.error ?? '');
  const board = g.boardFor(unit, OTHER);
  check(board.ok, 'and the press would land', board.error ?? '');
}

// ---------------------------------------------------------------------------
// 3. THE CENTREPIECE. Refuses the wrong thing AND takes the right one.
//
// One shop, one breath, both halves — because either alone is satisfied by a
// unit that takes nothing whatsoever, which is what every plausible way of
// getting this wrong produces and what reads as the shelf being broken.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const id = build(g, ONE);
  const unit = id && live(g, id);
  if (unit) {
    eq(g.shelfDepartments(unit).join(), D1, `a Test Bakery is for ${D1}`);

    check(g.departmentTakes(unit, MINE), `it takes ${MINE.id}, which is ${D1}`);
    check(!g.departmentTakes(unit, OTHER), `and refuses ${OTHER.id}, which is not`);

    // Door 1 — the highlight. Both ways, or the chevrons are a tighter rule
    // than the press and a unit takes a press it never advertised.
    check(g.shelfAccepts(unit, MINE.id), 'the chevron lights for the right goods');
    check(!g.shelfAccepts(unit, OTHER.id), 'and stays dark for the wrong ones');

    // Door 2 — the press. The refusal has to SAY the department, or it is a
    // shelf turning you down for a reason with nothing on screen anywhere.
    const yes = g.boardFor(unit, MINE);
    check(yes.ok, 'the press lands for the right goods', yes.error ?? '');
    const no = g.boardFor(unit, OTHER);
    check(!no.ok, 'and is refused for the wrong ones');
    check(/only for/.test(no.error ?? ''), 'and says what the unit is for', no.error ?? '');
    check(!/undefined/.test(no.error ?? ''), 'in words rather than in a gap', no.error ?? '');
  }
}

// ---------------------------------------------------------------------------
// 4. Door 3 — YOUR HANDS, through a mixed crate.
//
// This is `holds`' argument arriving one axis over, and it is the reason the
// rule binds you at all. `pourInto` empties a box pile by pile, so a loose rule
// puts the wrong goods on a board and leaves the right ones in the box: one
// press, no refusal, and the shop has done the one thing you cannot have meant.
//
// Both halves again, and the second is the one that makes the refusal honest —
// what it turns down has to have somewhere else to be, or a tighter rule has
// broken the game rather than fixed it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const taken = new Set();
  const unitId = build(g, ONE, taken);
  const spareId = build(g, OPEN, taken);
  const unit = unitId && live(g, unitId);
  const spare = spareId && live(g, spareId);
  if (unit && spare) {
    const p = g.players.me;
    p.haul = { id: 'zz-box', x: unit.x, z: unit.z, stacks: [
      { item_id: MINE.id, qty: 6, day: 0 },
      { item_id: OTHER.id, qty: 6, day: 0 },
    ] };
    Object.assign(p, { x: unit.browseAt.x, z: unit.browseAt.z });

    const poured = g.stockFromCrate('me', unit.id);
    check(poured.ok, 'the crate pours into the Bakery', poured.error ?? '');
    eq(qtyOf(g, unit, MINE.id), 6, 'and the goods it is for go on');
    eq(qtyOf(g, unit, OTHER.id), 0, 'and the ones it is not do not');
    eq(lotOf(p.haul, OTHER.id), 6, 'they are still in the box, not eaten');

    // ...and they have somewhere to go, which is the half that keeps this from
    // being a rule that strands stock.
    Object.assign(p, { x: spare.browseAt.x, z: spare.browseAt.z });
    const rest = g.stockFromCrate('me', spare.id);
    check(rest.ok, 'and the shelf next door takes them', rest.error ?? '');
    eq(qtyOf(g, spare, OTHER.id), 6, 'all of them');
  }
}

// ---------------------------------------------------------------------------
// 5. Door 4 — THE TICK, which is the door that would have been left open.
//
// A reservation outranks nearly every judgement the shop makes about its own
// range (`droppedItem`, `backRoomTakes`, `homedAt`), and `shelvesFor` spells
// that out. So a tick that was allowed is not one rule bent, it is the rule
// switched off for that unit for ever — and it would read as the crew being
// broken, since the board sits there with a name on it and nothing ever comes.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const id = build(g, ONE);
  const unit = id && live(g, id);
  if (unit) {
    const bad = g.assignShelf('me', unit.id, OTHER.id, true);
    check(!bad.ok, 'you cannot keep a Bakery for the wrong goods');
    check(/only for/.test(bad.error ?? ''), 'and it says why', bad.error ?? '');
    eq((g.layout.shelves.find((s) => s.id === unit.id)?.assigned ?? []).length, 0,
      'and nothing was written before the refusal');

    const good = g.assignShelf('me', unit.id, MINE.id, true);
    check(good.ok, 'and you can keep it for the right ones', good.error ?? '');
    eq((g.layout.shelves.find((s) => s.id === unit.id)?.assigned ?? []).join(), MINE.id,
      'which is what it is kept for');
  }
}

// ---------------------------------------------------------------------------
// 6. Door 5 — THE BUYER, which is what the feature is FOR.
//
// The other four stop a press. This one is the shop choosing a range for a bare
// unit, and it is the only one anybody would ever have noticed was missing:
// nobody presses bread into a bakery case, they build one and wait, and what
// used to arrive was whatever scored best in the whole catalogue.
//
// Driven through a real hire on a real tick, because `pickItem` is not exported
// and is drawn rather than called — `verify-order`'s argument for its buyer,
// and the same worker.
// ---------------------------------------------------------------------------
/**
 * ...and it is run TWICE, against the locked piece and the open one, because
 * "the buyer chose nothing wrong" is satisfied perfectly by a buyer that chose
 * nothing at all — which is the likelier outcome by far, since a bare unit in a
 * shop with no money, no van due or no ordering switched on buys nothing for
 * reasons that have nothing to do with departments. The open piece is the
 * control that says the harness works: it must come back with something, and
 * with something the locked one would have refused.
 */
{
  const bought = (piece) => {
    const g = fresh({ buyer: true });
    const id = build(g, piece);
    if (!id) return null;
    // ONE unit in the whole shop, and it has to be a removal rather than a
    // strip: an order records `{item_id, qty}` and never which board asked for
    // it, so four other bare shelves in the layout are four other ranges being
    // chosen into the same list, and the sweep would read them as this unit's.
    // Measured before it was: two perfectly correct orders for the shelves next
    // door, reported as a Bakery buying the wrong thing. `verify-order` slices
    // its shop for the same reason and says so.
    g.layout.shelves = g.layout.shelves.filter((s) => s.id === id);
    const unit = live(g, id);
    unit.stacks = [];
    unit.assigned = [];
    g.orders.auto = true;
    g.orders.assign = true;            // the shop may choose the range
    run(g, 200);
    // THREE places, because an order does not stay where it was placed and this
    // cost the file a round. `orders.pending` is emptied the moment the van
    // lands, the goods become crates on the pad, and this buyer has no `unload`
    // to put them on a board — so a sweep reading `pending` alone finds nothing
    // and reports "the shop chose nothing", which is indistinguishable from the
    // buyer having been refused. The clock decides which of the three it is in:
    // a new shop opens at 06:00 and everything outside trading hours runs at
    // `NIGHT_SPEED`, so how far a run gets is not obvious from the tick count.
    // An order names ONE item (`{id, item_id, qty, …}`) where a board and a
    // crate hold `stacks` — three shapes, and reading the wrong one is silent:
    // `(o.stacks ?? []).flatMap` on an order answers an empty list, so the sweep
    // reports "the shop chose nothing" whatever the shop chose, which is exactly
    // what a refused buyer looks like. It cost this file its second round.
    const said = (k) => k.item_id;
    const asked = [
      ...(live(g, id)?.stacks ?? []).map(said),
      ...(g.orders.pending ?? []).map(said),
      ...(g.deliveries ?? []).flatMap((d) => (d.stacks ?? []).map(said)),
    ].filter(Boolean);
    return { g, id, asked: [...new Set(asked)] };
  };

  const open = bought(OPEN);
  if (open) {
    check(open.asked.length > 0, 'the buyer stocks a bare unit at all', `${open.asked.length}`);
    // ...and it reaches outside one department, or the control agrees with the
    // rule by accident and proves nothing about it.
    check(open.asked.some((x) => !c.byId.items[x]?.tags.includes(D1)),
      `and an open unit is not quietly ${D1} anyway`, open.asked.join(', '));
  }

  const locked = bought(ONE);
  if (locked) {
    check(locked.asked.length > 0, 'the shop chose something for a bare Bakery', `${locked.asked.length}`);
    const wrong = locked.asked.filter((x) => !locked.g.departmentTakes(live(locked.g, locked.id), x));
    eq(wrong.length, 0, `and everything it chose is ${D1}`, wrong.join(', '));
  }
}

// ---------------------------------------------------------------------------
// 7. A rule made TODAY against shelves stocked YESTERDAY.
//
// Content is edited live, so tagging a piece is a press over a shop that is
// already full. Two claims, pulling opposite ways, and both are needed.
//
// The stock STAYS. That is `assignShelf`'s own call about goods you did not
// tick — they sell down and are not refilled — and the alternative is worse
// than the bug: adding a word to a catalogue row would tip every bakery case in
// every world onto the floor.
//
// And the unit stops being that item's HOME. Without it the Bakery is still
// holding the most salsa in the shop, so it wins `homeShelves`, and every other
// shelf in the building is then refused for not being the home. One item, no
// legal home anywhere, its crates stranded on the pad — every refusal correct,
// the sum of them a shop that has quietly stopped restocking one line.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const taken = new Set();
  const unitId = build(g, ONE, taken);
  const spareId = build(g, OPEN, taken);
  if (unitId && spareId) {
    onlyUnit(g, unitId);
    // Standing on it before anybody asked — which is what a save written before
    // the row was tagged looks like.
    stand(g, live(g, unitId), OTHER, 9);
    eq(qtyOf(g, { id: unitId }, OTHER.id), 9, 'goods stood on the unit before it was locked');

    // A re-flow is the press that would shed them, and it must not.
    g.regenerateLayout();
    eq(qtyOf(g, { id: unitId }, OTHER.id), 9, 'a re-flow leaves them where they are');
    eq(g.shelfDepartments(live(g, unitId)).join(), D1, 'and the unit is still locked');

    // ...but it is not their home, or nothing else in the shop may take them.
    const homes = g.homeShelves(OTHER.id);
    check(!homes.floor?.has(unitId), 'a unit that could never refill it is not its home');
    check(g.homedAt(live(g, spareId), OTHER.id, homes), 'and the shelf next door may take it');
  }
}

// ---------------------------------------------------------------------------
// 8. SEVERAL is an or.
//
// Both, or the second tag is a way of emptying the unit — a Deli that wanted an
// item to be meat AND dairy would take almost nothing and would look exactly
// like a Deli whose rule was working.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const id = build(g, TWO);
  const unit = id && live(g, id);
  if (unit) {
    eq(g.shelfDepartments(unit).length, 2, 'a Test Deli names two departments');
    check(g.departmentTakes(unit, MINE), `it takes ${D1}`);
    check(g.departmentTakes(unit, ALSO), `and ${D2}`);
    check(!g.departmentTakes(unit, OTHER), 'and still refuses what is neither');

    // Both through the tick as well, since that is the door with its own copy
    // of the rule and the one an `and` would have shut.
    check(g.assignShelf('me', unit.id, MINE.id, true).ok, `it can be kept for ${D1}`);
    check(g.assignShelf('me', unit.id, ALSO.id, true).ok, `and for ${D2}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Nothing is stored, so nothing can be forgotten.
//
// The departments come off the PIECE, which is what makes this free — no save
// field, no migration, and a row retagged over MCP re-answers for every unit of
// it in every world. The two presses that could lose a setting are a re-flow
// and R, and R is the one that matters: `repositionFixture` NAMES every field
// it keeps, so a setting with a field would be reset by the turn that is meant
// to aim it. This has no field to forget, and that is the claim.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const unit = build(g, ONE);
  if (unit) {
    // Looked up by PIECE each time rather than held, for `live`'s reason: R and
    // a re-flow both rebuild the record, and this section is entirely about
    // presses that do.
    const said = () => {
      const live = g.layout.shelves.find((s) => s.piece === ONE.id);
      return live ? g.shelfDepartments(live).join() : '(gone)';
    };
    eq(said(), D1, 'a Test Bakery is for its department');

    g.regenerateLayout();
    eq(said(), D1, 'and still is after a re-flow');

    const turned = g.rotateFixture('me', g.layout.shelves.find((s) => s.piece === ONE.id).id);
    check(turned.ok, 'R turns it', turned.error ?? '');
    eq(said(), D1, 'and it is still a Bakery afterwards');

    // Nothing about it reached the save, which is the other half of "free".
    const saved = JSON.stringify(g.saveState?.() ?? {});
    check(!/departments/.test(saved), 'and no department was written to the save');
  }
}

// ---------------------------------------------------------------------------
// 10. The live catalogue actually says something.
//
// The rule working and nobody having authored a department are the same shop,
// which is the `charm` trap exactly: a mechanic reading a content column that
// no row has ever set is indistinguishable from a mechanic that is broken. So
// this asserts the shipped pieces were tagged — and that each one has stock it
// could hold, since a piece locked to a department with no items in it is a
// unit that can never be filled and looks like the crew ignoring it.
// ---------------------------------------------------------------------------
{
  const named = (c.fixtures ?? []).filter((p) => departmentsOf(p).length);
  check(named.length > 0, 'somebody has authored a department onto a piece', `${named.length}`);
  for (const p of named) {
    const kind = shelfKind(p.kind || p.id);
    const fits = c.items.filter((it) => homeKind(it) === kind && inDepartment(p, it));
    check(fits.length > 0,
      `${p.id} (${departmentsOf(p).join(' + ')}) has goods that can go on it`, `${fits.length}`);
  }
  // ...and the generic pieces are still generic, or locking the themed ones has
  // quietly locked the shelving every shop is built out of.
  for (const id of ['shelf', 'freezer', 'hot-counter']) {
    const p = (c.fixtures ?? []).find((x) => x.id === id);
    if (!p) continue;
    eq(departmentsOf(p).length, 0, `${id} is still for anything`);
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nverify:dept — ${checks} assertions, ${failures.length} FAILED\n`);
  for (const f of failures) console.error(`  ❌  ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`\nverify:dept — ${checks} assertions\n`);
console.log('  ✅  a Bakery is for bread, and an untagged unit is for anything.\n');
