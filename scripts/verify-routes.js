#!/usr/bin/env node
/**
 * VERIFY: A HIRE WHO PLANS THEIR ROUND.
 *
 * Nothing a worker chose between had ever been chosen by how far away it was.
 * `harvest` and `sow` take `plots.find(...)` — the first legal bed in array
 * order — so a farmhand standing at the end of a field walks the length of it
 * to reach bed 1 because bed 1 is listed first. `serve` takes the first till
 * with anybody in the queue. A bay of identical part-crates is worked in the
 * order the boxes happened to be stored in. Every one of those is a correct
 * decision and a walk nobody chose, and every one of them is invisible: a hire
 * walking to the near bed and a hire walking to the far one are the same still
 * frame, and the shop is the same shop either way afterwards.
 *
 * So `routes` on a rung, and this file. What it guards:
 *
 * - **The control: a rung with no `routes` is the old game exactly.** Zero is
 *   every tier ever authored, so this is the assertion that decides whether any
 *   of it is opt-in — a farmhand on the bottom rung must still walk the length
 *   of the field to bed 1 while standing on a ripe one.
 * - **A router takes the nearest** of the beds the job rates equally.
 * - **…and the DIAL is real.** `routes` is a 0..1 and the trap `packs` is
 *   listed under in CLAUDE.md is a field that is a boolean wearing a number —
 *   every value above zero doing the same thing. So the same short cut is
 *   offered to a keen rung and a lukewarm one from one standing spot, and they
 *   must answer differently.
 * - **A tie keeps the incumbent**, which is what makes the zero case provable
 *   rather than merely equal-looking, and what stops the pick jittering as a
 *   hire drifts between two beds a hair apart.
 * - **It never overrules the job's own preference**, which is the centrepiece
 *   and the only claim here that is about something NOT happening. A rung that
 *   could take a nearer, WORSE crate to save a walk would be a balance change
 *   wearing an efficiency upgrade — and it would look exactly like this one.
 * - **…and it does break a tie at the bay**, or the guard above is satisfied by
 *   a stat that does nothing at all.
 * - **Nothing is created or destroyed on the way**, because every claim here is
 *   about a *choice* between two journeys and it would be perfectly possible to
 *   make the right one and lose the goods.
 *
 * Runs on ephemeral Games. It writes three worker rows into the content
 * database — usually the live shared one — and removes them on exit.
 *
 *   node scripts/verify-routes.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';
import { lotQty } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * The thresholds `nearestOf` interpolates between, restated here on purpose.
 *
 * Importing them would make this file agree with `staff.js` by construction,
 * which is the one thing a sweep must not do: the dial section below asserts
 * that a saving of `sep` tiles is taken by one rung and refused by another, and
 * against an imported constant that assertion passes whatever the constants
 * become. Said out loud, a change to either number fails here and has to be
 * meant.
 */
const SAVING_MIN = 0.5;
const SAVING_MAX = 4;
const needed = (keen) => SAVING_MAX - (SAVING_MAX - SAVING_MIN) * keen;

/**
 * Enough beds to have a near one and a far one, and two tills for the queue.
 *
 * Sixteen rather than a handful, and the number is load-bearing: the generator
 * lays beds in a block, so six of them span 2.24 tiles — inside every threshold
 * on the dial at once, which would leave section 2 with no standing spot where
 * two rungs can disagree, and section 1 asserting a "long walk" that is two
 * paces. Sixteen spans 4.24, which straddles the whole range.
 */
const SHOP = { shelf: 4, freezer: 0, checkout: 2, plot: 16 };

/**
 * Three hands, identical but for the rung — so every claim below is a
 * comparison rather than a value.
 *
 * Fast and impatient on purpose (`speed`, `pace`): this file asserts which
 * target was CLAIMED, one tick after the draw, and a slow hire spends that tick
 * on a cooldown instead.
 */
const FARM = {
  id: 'zz-route-farm', name: 'Test Farmhand', color: '#7a9e4b',
  jobs: [{ job: 'farm', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 6,
  /**
   * Rung 2 is deliberately LUKEWARM rather than half-way. `needed(0.1)` is 3.65
   * tiles, which is most of the range — so the dial section can find one
   * standing spot where a keen rung diverts and this one does not, on whatever
   * geometry the generator hands it.
   */
  tiers: [
    { name: 'Standard', cost: 0 },
    { name: 'Takes a short cut', cost: 0, routes: 0.1 },
    { name: 'Plans their round', cost: 0, routes: 1 },
  ],
};
const BAY = { ...FARM, id: 'zz-route-bay', name: 'Test Stocker', jobs: [{ job: 'unload', weight: 1 }] };
const TILL = { ...FARM, id: 'zz-route-till', name: 'Test Clerk', jobs: [{ job: 'serve', weight: 1 }] };
const KINDS = [FARM, BAY, TILL];

process.on('exit', () => {
  for (const w of KINDS) {
    try { remove('workers', w.id); } catch { /* best effort */ }
  }
});
for (const w of KINDS) {
  const res = writeContent('worker', w, 'verify');
  check(res.ok, `the catalog accepts ${w.name}`, res.error ?? '');
}

const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 1, 'the catalog has an ambient item', `${AMBIENT.length}`);
const [ITEM_A] = AMBIENT;
const CROP = c.crops.find((cr) => cr.item_id);
check(!!CROP, 'the catalog has a crop to ripen');

/** The same reset every other sweep makes — see `verify-hand` on each field. */
function fresh({ kind = FARM.id, tier = 1 } = {}) {
  const g = Game.create({ worldId: 'verify-routes', seed: 'routes', ephemeral: true });
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
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  // Ordering off, or `restock` buys against the boards this file leaves thin
  // and a van lands in the middle of a run.
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;                    // nobody buying stock out from under us
  g.addPlayer('me', 'Tester');
  const res = g.hire(kind);
  check(res.ok, 'the hire joins', res.error ?? '');
  g.roster[g.roster.length - 1].tier = tier;
  g.step(0.1);                       // `hire` writes the roster; `syncStaff` puts the body in
  return g;
}

const hire = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
const away = (s, t) => Math.hypot(s.x - t.x, s.z - t.z);

/**
 * Put the hire on a tile and take one draw.
 *
 * The position is written rather than walked to, which puts the sweep in a
 * state no player reaches — so the path and the cooldown go with it, the way
 * `verify-build`'s `stand` clears both. A hire with a route left is skipped by
 * `stepStaff` before any job is asked, and the assertion would read the claim
 * from the tick before.
 */
function drawFrom(g, at) {
  const s = hire(g);
  s.x = at.x; s.z = at.z;
  s.path = [];
  s.cooldown = 0;
  s.claim = null;
  s.energy = 1;                      // a break outranks the job list, and this file is not about breaks
  g.step(0.1);
  return s.claim;
}

/** Every bed ripe, so nothing here rates one above another. */
function ripen(g) {
  for (const p of g.layout.plots) {
    p.crop_id = CROP.id;
    p.soil = 'tilled';
    p.ready = true;
    p.plantedAt = 0;
  }
}

/** Room on every board, so no bed is refused for having nowhere to go. */
const roomForAll = (g) => { for (const sh of g.layout.shelves) sh.stacks = []; };

/** Every unit of an item anywhere in the shop: boards, crates, hands, shoulder. */
function everywhere(g, itemId) {
  let n = 0;
  for (const sh of g.layout.shelves) n += g.shelfStack(sh, itemId)?.qty ?? 0;
  for (const d of g.deliveries) n += lotQty(d, itemId);
  for (const p of Object.values(g.players)) n += lotQty(p.carry, itemId) + lotQty(p.haul, itemId);
  return n;
}

// ---------------------------------------------------------------------------
// 1. The control, and the nearest.
//
// One standing spot — a ripe bed at the far end of the field — asked of two
// rungs. The hire is stood ON a bed, so the nearest legal target is under their
// feet and the incumbent is the length of the field away. If a rung with no
// `routes` diverted here, every save in existence would have changed.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  ripen(g);
  roomForAll(g);
  const plots = g.layout.plots;
  check(plots.length >= 2, 'the shop has a field to walk across', `${plots.length}`);

  // The bed furthest from the one `find` would take, so the saving is the whole
  // separation and both rungs are being asked the same easy question.
  const head = plots[0];
  const far = plots.slice(1).reduce((b, p) => (away(p, head) > away(b, head) ? p : b), plots[1]);
  const sep = away(far, head);
  check(sep >= SAVING_MAX, 'the two beds are further apart than the widest threshold', `${sep.toFixed(2)}`);

  eq(drawFrom(g, far), `plot ${head.id}`,
    'a rung with no `routes` walks the length of the field to the first bed on the list');

  const g3 = fresh({ tier: 3 });
  ripen(g3);
  roomForAll(g3);
  const p3 = g3.layout.plots;
  eq(drawFrom(g3, p3.find((p) => p.id === far.id)), `plot ${far.id}`,
    '…and a rung that plans its round works the bed under its feet');

  // The same pair of claims for `sow`, which is the other half of one loop over
  // the same beds and a separate `find` in the file. A bed that is turned over
  // and bare is the sow case; nothing rates one above another there either.
  const g4 = fresh({ tier: 3 });
  roomForAll(g4);
  for (const p of g4.layout.plots) { p.crop_id = null; p.soil = 'tilled'; p.ready = false; }
  const bare = g4.layout.plots;
  const bareFar = bare.slice(1).reduce((b, p) => (away(p, bare[0]) > away(b, bare[0]) ? p : b), bare[1]);
  eq(drawFrom(g4, bareFar), `plot ${bareFar.id}`, 'sowing takes the nearest turned bed too');

  const g5 = fresh();
  roomForAll(g5);
  for (const p of g5.layout.plots) { p.crop_id = null; p.soil = 'tilled'; p.ready = false; }
  eq(drawFrom(g5, g5.layout.plots.find((p) => p.id === bareFar.id)), `plot ${bare[0].id}`,
    '…and without the rung it is the first turned bed on the list');
}

// ---------------------------------------------------------------------------
// 2. The dial is real.
//
// The trap CLAUDE.md lists `packs` under, pointed at a float: a field that is a
// boolean wearing a number, where every rung above zero does the same thing.
// One standing spot, one saving, two rungs, opposite answers.
// ---------------------------------------------------------------------------
{
  const g = fresh({ tier: 3 });
  ripen(g);
  roomForAll(g);
  const plots = g.layout.plots;
  const head = plots[0];

  // A bed near enough to `head` that a keen rung diverts and a lukewarm one
  // does not — the saving has to fall between the two thresholds, which is the
  // entire point of the section. Chosen off real geometry rather than assumed,
  // and failed loudly if this layout has no such pair, because a section that
  // quietly found nothing to test would pass for ever.
  const mid = plots.slice(1)
    .filter((p) => away(p, head) > needed(1) && away(p, head) < needed(0.1))
    .sort((a, b) => away(a, head) - away(b, head))[0];
  check(!!mid, 'the field has two beds a middling distance apart',
    plots.map((p) => away(p, head).toFixed(1)).join(' '));
  if (mid) {
    const sep = away(mid, head);
    check(sep > needed(1), 'and that saving is worth a keen rung diverting for', `${sep.toFixed(2)}`);
    check(sep < needed(0.1), '…and is not worth a lukewarm one', `${sep.toFixed(2)}`);

    eq(drawFrom(g, mid), `plot ${mid.id}`, 'a keen rung takes the short cut');

    const g2 = fresh({ tier: 2 });
    ripen(g2);
    roomForAll(g2);
    eq(drawFrom(g2, g2.layout.plots.find((p) => p.id === mid.id)), `plot ${head.id}`,
      '…and a lukewarm one walks past it, because it was not an obvious one');
  }
}

// ---------------------------------------------------------------------------
// 3. A tie keeps the incumbent.
//
// Stood ON the first bed on the list, nothing can be nearer — so the saving is
// zero and the strict comparison in `nearestOf` has to hold. It is the same
// rule that makes the zero case above provable rather than coincidental: a
// pick that changed its mind on a tie would drift between two beds a hair apart
// as the hire moved, which is a worker visibly doing nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh({ tier: 3 });
  ripen(g);
  roomForAll(g);
  const head = g.layout.plots[0];
  eq(drawFrom(g, head), `plot ${head.id}`, 'nothing beats the bed they are standing on');
}

// ---------------------------------------------------------------------------
// 4. The centrepiece: it never overrules the job's own preference.
//
// A near crate worth two units and a far one worth six. `unload` rates those
// differently — `score` is `stray * 1e6 + moves` — and a rung that took the near
// one to save the walk would be turning three trips into one, which is a
// balance change with an efficiency upgrade's name on it. Both boxes sit on the
// pad, so the stray bonus is out of it and the only thing left is the size.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: BAY.id, tier: 3 });
  roomForAll(g);
  const cells = g.layout.bay?.cells ?? [];
  check(cells.length >= 2, 'the bay has two cells', `${cells.length}`);

  // `exact`, or `dropGoods` merges them into one box a couple of tiles apart —
  // and one box is a sweep that passes without the feature existing.
  const small = g.dropGoods(ITEM_A.id, 2, { x: cells[0].x, z: cells[0].z }, { exact: true });
  const big = g.dropGoods(ITEM_A.id, 6, { x: cells[1].x, z: cells[1].z }, { exact: true });
  check(!!small && !!big, 'both boxes are standing');
  check(small.id !== big.id, 'and they are two boxes rather than one', `${small?.id} ${big?.id}`);

  const before = everywhere(g, ITEM_A.id);
  // Stood on the small one, so the wrong answer is also the near one — which is
  // what makes the assertion mean anything.
  const took = drawFrom(g, small);
  check(away(hire(g), big) - 0 >= SAVING_MIN,
    'the worse box is far enough away to be worth diverting from',
    `${away(hire(g), big).toFixed(2)}`);
  eq(took, `crate ${big.id}`, 'a router still takes the bigger trip, however much nearer the small one is');
  eq(everywhere(g, ITEM_A.id), before, 'and nothing was created or destroyed choosing');
}

// ---------------------------------------------------------------------------
// 5. …and it DOES break a tie at the bay.
//
// Without this, section 4 is satisfied by a stat that does nothing at all.
// Two boxes of the same thing in the same quantity are the same trip twice, so
// `score` ties exactly and the walk is the only thing left to decide on.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: BAY.id, tier: 3 });
  roomForAll(g);
  const cells = g.layout.bay?.cells ?? [];
  const first = g.dropGoods(ITEM_A.id, 4, { x: cells[0].x, z: cells[0].z }, { exact: true });
  const second = g.dropGoods(ITEM_A.id, 4, { x: cells[1].x, z: cells[1].z }, { exact: true });
  check(first.id !== second.id, 'two identical boxes on two cells', `${first?.id} ${second?.id}`);

  const before = everywhere(g, ITEM_A.id);
  const sep = away(second, first);
  check(sep >= SAVING_MIN, 'the cells are far enough apart to choose between', `${sep.toFixed(2)}`);
  eq(drawFrom(g, second), `crate ${second.id}`, 'a router works the tied box it is standing at');
  eq(everywhere(g, ITEM_A.id), before, 'and nothing moved but the decision');

  const g0 = fresh({ kind: BAY.id });
  roomForAll(g0);
  const a0 = g0.dropGoods(ITEM_A.id, 4, { x: cells[0].x, z: cells[0].z }, { exact: true });
  const b0 = g0.dropGoods(ITEM_A.id, 4, { x: cells[1].x, z: cells[1].z }, { exact: true });
  eq(drawFrom(g0, b0), `crate ${a0.id}`,
    '…while a rung with no `routes` works them in the order the boxes are stored in');
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log(`verify:routes — ${checks} checks`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all good ✓');
