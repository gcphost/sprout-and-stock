#!/usr/bin/env node
/**
 * VERIFY: A REWARD THE YARD CANNOT TAKE TODAY IS KEPT, NOT DROPPED.
 *
 * Two of the three things a milestone pays are numbers — cash lands in the till
 * and the town is a term in `catchment`, and neither can fail to arrive. The
 * third is goods, and goods need somewhere to go: `giftSupplies` bounds the free
 * run by `bayRoom` for the reason `buyStock` does, because a lorry that turns up
 * with more than the pad can hold has nowhere to set it down.
 *
 * That bound used to be the end of it. What the yard could not take on the tick
 * the rung landed was dropped, and nothing anywhere remembered it — which is
 * exactly wrong for a LADDER, because **milestones pile**. The opening ten
 * minutes of a shop meet six of them, every gift lands on the same small pad,
 * and each rung after the first was trimmed to whatever the stocker happened to
 * have cleared in the meantime. Measured on a real day-2 save: `break-room`
 * promises 18 units and paid **2**; `take-100` promises 12 and paid 10.
 *
 * Nothing in it can be looked at, twice over. A gift that was trimmed and a gift
 * that never came are the same empty pad, and the shop is the same shop
 * afterwards either way — only the crates that never arrived moved. Nothing logs
 * a shortfall either: the line reads "2x Sugar Beet on the way, free", which is
 * true, and says nothing about the sixteen that are not. So it arrives as the
 * reward being a lie, on precisely the rungs a new shop is leaning on.
 *
 * The claims:
 *
 * - **The control.** A shop with room takes the whole reward on the spot and
 *   owes nothing, and `owed` stays 0 — which is every save in existence, and the
 *   assertion that decides whether this is a fix or a change to all of them.
 * - **The centrepiece, and it is a PAIR worthless split in half.** A full yard
 *   sends nothing AND the reward is still owed to the unit. Either half alone is
 *   satisfied by the bug: "sends nothing" was true before this existed, and
 *   "owed" means nothing if the crates never come.
 * - **…and it comes.** Clear the pad, sweep again, and the whole promise lands.
 * - **The pile**, which is the report this file was written for: several rungs
 *   in one sweep must deliver the sum of what they promised, however small the
 *   pad is. Asserted as the TOTAL over the whole run rather than per rung,
 *   because which rung gets trimmed is a detail of the order they are swept in.
 * - **It is a rate and not a ceiling**, which is `verify:order`'s own sentence
 *   about the same yard: a reward bigger than the pad fills over successive
 *   runs, and it TERMINATES — an owed pile that never drains is a shop with a
 *   van arriving for the rest of the save.
 * - **No printer.** Nothing is delivered twice, no gift moves money in either
 *   direction, and every order it files is a $0 one marked as a gift.
 * - **The pending half.** Two rungs in one tick read the same empty pad, so
 *   without counting what is already on its way each would promise the whole of
 *   it — the same bug with the sign flipped, and it costs the shop its ordering
 *   rather than its reward.
 * - **Out and back**, which is CLAUDE.md's named-field trap: `owed` has to
 *   survive `saveState` and the create payload, or a shop that was short forgets
 *   it on the next restart and the reward is dropped after all, one door along.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It writes one
 * throwaway save row — the round trip in §6 is the only way to ask the
 * constructor's own named-field list a question — and empties it on exit, the
 * way `verify:catalog` removes the pieces it authors.
 *
 *   node scripts/verify-gift.js
 */

import { Game } from '../server/sim/index.js';
import { content, saveWorld } from '../server/content.js';
import { checkMilestones, MILESTONES } from '../server/sim/goals.js';

/**
 * The one thing in here that touches a database: a throwaway save, for the
 * round trip in §6. Emptied on exit the way `verify:catalog` removes its rows.
 */
const BACK = 'verify-gift-back';
process.on('exit', () => {
  try { saveWorld(BACK, {}); } catch { /* best effort */ }
});

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };
const ALL = MILESTONES.map((m) => m.id);
const rung = (id) => MILESTONES.find((m) => m.id === id);

/**
 * The rungs this file arms, and why they are the money ones.
 *
 * `lifetime(g, 'revenue')` is one field, so setting it high makes several rungs
 * true in ONE sweep with no shop to build — which is the pile, exactly as a
 * player meets it. Their `supplies` are read off the table rather than written
 * down here, or every total below passes whatever the ladder is retuned to.
 */
const MONEY = ['take-100', 'take-500', 'take-2000'];
const PROMISED = MONEY.reduce((n, id) => n + (rung(id).reward.supplies ?? 0), 0);
check(PROMISED > 0, 'the money rungs pay stock at all', `${PROMISED}`);

/** The same reset every other sweep makes — see `verify-order` on each field. */
function fresh() {
  const g = Game.create({ worldId: 'verify-gift', seed: 'gift', ephemeral: true });
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
  // Every rung both DONE and KNOWN, so nothing fires until this file arms it —
  // and `known` matters as much as `done`, or an armed rung is banked as
  // already-met and pays nothing at all, which is the bug wearing the fix.
  g.milestones = { done: [...ALL], known: [...ALL], owed: 0 };
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.totals = { revenue: 0, sold: 0, harvested: 0, shelved: 0 };
  g.cash = 1000;
  g.open = false;
  g.orders.auto = false;
  return g;
}

/** Make these rungs due again. */
const arm = (g, ids) => { g.milestones.done = g.milestones.done.filter((id) => !ids.includes(id)); };

/** Fill the delivery bay to within `spare` units of full. */
function fillBay(g, spare = 0) {
  const cell = g.layout.bay.cells[0];
  const room = Math.max(0, g.bayRoom() - spare);
  if (room <= 0) return;
  g.deliveries.push({
    id: `del-fill-${g.deliveries.length}`,
    x: cell.x, z: cell.z,
    stacks: [{ item_id: FILLER, qty: room, day: g.day }],
  });
}

/** Whatever is on the vans, in units. */
const coming = (g) => g.orders.pending.reduce((n, o) => n + o.qty, 0);

const c = content();
const FILLER = c.items[0].id;

// ---------------------------------------------------------------------------
// 1. THE CONTROL — a yard with room is the old game exactly.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cash = g.cash;
  arm(g, ['take-100']);
  g.totals.revenue = 100;
  checkMilestones(g);

  eq(coming(g), rung('take-100').reward.supplies, 'a yard with room takes the whole reward at once');
  eq(g.milestones.owed, 0, '...and owes nothing');
  eq(g.cash, cash + rung('take-100').reward.cash, '...and the cash is the cash');
  check(g.orders.pending.every((o) => o.cost === 0 && o.gift === true),
    'every order it files is a free one, marked as a gift');

  // ...and a shop that was never short ships nothing on later sweeps. The half
  // that keeps `payOwed` from being a van a second.
  const before = coming(g);
  for (let i = 0; i < 20; i++) checkMilestones(g);
  eq(coming(g), before, 'a shop that owes nothing sends nothing on later sweeps');
}

// ---------------------------------------------------------------------------
// 2. THE CENTREPIECE — a full yard sends nothing AND still owes it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  fillBay(g);
  eq(g.bayRoom(), 0, 'the yard under test really is full');

  arm(g, ['take-100']);
  g.totals.revenue = 100;
  checkMilestones(g);

  // Both halves, in one breath. Either alone is satisfied by the bug.
  eq(coming(g), 0, 'a full yard is sent nothing');
  eq(g.milestones.owed, rung('take-100').reward.supplies, '...and the whole reward is owed');

  // ...and it comes. The pad clears, the next sweep ships it.
  g.deliveries = [];
  checkMilestones(g);
  eq(coming(g), rung('take-100').reward.supplies, 'and it arrives once there is room');
  eq(g.milestones.owed, 0, '...with nothing left owed');
}

// ---------------------------------------------------------------------------
// 3. THE PILE — several rungs in one sweep, against a pad too small for them.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cash = g.cash;
  // Room for a fraction of what the three of them promise, which is a day-2
  // shop to the unit: the first gift lands and every one after it used to be
  // trimmed to whatever was left.
  fillBay(g, 6);

  arm(g, MONEY);
  g.totals.revenue = 2000;
  checkMilestones(g);

  const owedNow = g.milestones.owed;
  check(owedNow > 0, 'a small pad cannot take three rewards at once', `owed ${owedNow}`);
  eq(coming(g) + owedNow, PROMISED, 'nothing is lost between what was promised and what is owed');

  // Now play it out: each round is a van arriving and the crew clearing it.
  let sent = 0;
  let rounds = 0;
  while (rounds++ < 200) {
    sent += coming(g);
    g.orders.pending = [];
    g.deliveries = [];
    if (!g.milestones.owed) break;
    checkMilestones(g);
  }
  eq(sent, PROMISED, 'every unit the three rungs promised is delivered in the end');
  eq(g.milestones.owed, 0, '...and the shop stops owing');
  check(rounds < 200, 'the owed pile drains rather than running for ever', `${rounds} rounds`);
  eq(g.cash, cash + MONEY.reduce((n, id) => n + rung(id).reward.cash, 0),
    'and none of it moved money in either direction');
}

// ---------------------------------------------------------------------------
// 4. A RATE, NOT A CEILING — one reward bigger than the whole yard.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const big = MILESTONES.filter((m) => (m.reward.supplies ?? 0) > 0)
    .sort((a, b) => b.reward.supplies - a.reward.supplies)[0];
  const cap = g.bayRoom();
  check(cap > 0, 'the shop has a yard at all', `${cap}`);

  arm(g, [big.id]);
  // Straight onto `done` rather than through a measure, because the biggest
  // reward on the ladder is not a rung this file can honestly earn.
  g.milestones.done = g.milestones.done.filter((id) => id !== big.id);
  g.milestones.done.push(big.id);
  g.milestones.owed = big.reward.supplies + cap * 2;

  const want = g.milestones.owed;
  let sent = 0;
  let rounds = 0;
  while (rounds++ < 400) {
    checkMilestones(g);
    sent += coming(g);
    g.orders.pending = [];
    g.deliveries = [];
    if (!g.milestones.owed) break;
  }
  eq(sent, want, 'a debt larger than the yard is paid off over successive runs');
  check(rounds < 400, '...and it terminates', `${rounds} rounds`);
  check(sent > cap, '...having sent more than one pad could ever hold', `${sent} vs ${cap}`);
}

// ---------------------------------------------------------------------------
// 5. THE PENDING HALF — two rungs must not each promise the whole pad.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  arm(g, MONEY);
  g.totals.revenue = 2000;
  const cap = g.bayRoom();
  checkMilestones(g);
  check(coming(g) <= cap, 'what is on the vans fits the pad it is coming to',
    `${coming(g)} against ${cap}`);
}

// ---------------------------------------------------------------------------
// 6. OUT AND BACK — the named-field trap, which is where a fix like this dies.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  fillBay(g);
  arm(g, ['take-100']);
  g.totals.revenue = 100;
  checkMilestones(g);
  const owed = g.milestones.owed;
  check(owed > 0, 'the shop owes something to carry', `${owed}`);

  const saved = g.saveState();
  check(saved.milestones?.owed === owed, 'the save carries it out', `${saved.milestones?.owed}`);

  // ...and back in through the door it comes in by, which is the half that
  // matters: `Game.create` NAMES every field it keeps, so a payload that hands
  // `milestones` over wholesale is worth nothing if the constructor rebuilds it
  // as `{done, known}`. That is one write into whatever content database this
  // is pointed at, cleared below.
  saveWorld(BACK, saved);
  const back = Game.create({ worldId: BACK, seed: 'gift', ephemeral: true });
  eq(back.milestones.owed, owed, '...and the shop that reads it back still owes it');
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ verify-gift: ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify-gift: ${checks} checks passed`);
