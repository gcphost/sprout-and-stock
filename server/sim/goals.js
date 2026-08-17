/**
 * MILESTONES — the shop's own ladder, and the only thing in the game that
 * congratulates you.
 *
 * A shop that is going well and a shop that is going nowhere look identical for
 * the first twenty minutes: the numbers in the corner move, and nothing ever
 * *says* anything. This is the half that says it — twelve rows, each one a
 * number the shop already keeps, with a reward on the far side of it.
 *
 * Three rules hold the whole thing together, and each of them is why this is a
 * code file rather than a content table:
 *
 * **A milestone is a measurement, not a quest.** Every row is one function of
 * game state that already exists — takings, units sold, crops picked, the day,
 * the roster, reputation. Nothing tracks a milestone *while* you play, nothing
 * has to be armed, and a shop that earned three of them before this shipped
 * gets all three on the next tick. That is also what makes them safe to add:
 * a new row is a new measure, and no save has to know about it.
 *
 * **A reward may not be a thing you unlock.** Cash, a free run of stock on the
 * next van, and the town growing are the three, and all three are numbers that
 * already have a meaning. Anything that granted a fixture or an upgrade would
 * be a second way to own something, and every rule in the shop about what you
 * own is written against `placements` and `ownedUpgrades`.
 *
 * **The town is the one that is worth having.** `Game.catchment` is the term
 * shopkeeping can never move — you can restock, decorate and pave your way to a
 * better shop, and the number of people who live near it is not a decision.
 * Growing it is the one reward that is not more of what you already had, and it
 * is why the modal says how many people are in reach now rather than just
 * naming the milestone.
 */

import { content } from '../content.js';
import { homeKind } from '../../shared/tags.js';
import { shelfKind } from '../../shared/build.js';

/**
 * A lifetime tally, as "the days that are done" plus "today so far".
 *
 * The same split `Game.demandNow` makes, and for the same reason: `stats` is
 * wiped every morning, so a milestone measured off it alone would count the
 * first hundred pounds of *every day*, and one measured off `totals` alone
 * would not move until the day rolled over — which on day one is the entire
 * session. `ledger` cannot answer it either: it is capped at 30 days, so
 * lifetime takings stop being recoverable from it the month after they matter.
 */
const lifetime = (g, key) => (g.totals?.[key] ?? 0) + (g.stats?.[key] ?? 0);

/**
 * The ladder. Roughly in the order a shop meets them, which is the order the
 * panel lists them in — nothing enforces it, and nothing has to: they are
 * measurements, so earning them out of order is simply a shop that did.
 *
 * `unit` is how the number reads rather than what it is, because "$100" and
 * "100 sold" are the same integer and only one of them makes sense with a
 * dollar sign in front of it.
 */
export const MILESTONES = [
  {
    id: 'first-sale',
    name: 'Open for business',
    blurb: 'Sell something to somebody who walked in off the street.',
    unit: 'count',
    need: 1,
    /**
     * Every rung pays cash, and this one pays the float over again.
     *
     * A shop opens on $250, which is about two crates and a seed tray — so the
     * first hour was spent waiting for one shelf to sell through before
     * anything could be done at all. Doubling the float the moment somebody
     * buys something turns the opening from a wait into a choice, and it is
     * paid out of the one event that proves the shop works rather than handed
     * over at creation, where it would just be a bigger starting number nobody
     * earned.
     *
     * The ladder climbs from here — 250, 100, 50, then up to 1500 — so the two
     * rungs that matter most are the two you meet in the first ten minutes and
     * the one you meet after a fortnight. The middle of it is deliberately flat:
     * a shop taking $2,000 does not need $400, and the reason that rung still
     * pays is that a ladder with a gap in it reads as a rung that is broken.
     */
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 250, supplies: 12 },
  },
  {
    id: 'take-100',
    name: 'First hundred',
    blurb: 'Take $100 over the counter.',
    unit: 'money',
    need: 100,
    measure: (g) => lifetime(g, 'revenue'),
    // Matched to what it asks for, the way the rung below it doubles the float:
    // the first two rungs are the opening, and the opening is where money is
    // the difference between a decision and a wait.
    reward: { cash: 100, town: 1, supplies: 12 },
  },
  {
    id: 'first-harvest',
    name: 'Something you grew',
    blurb: 'Pick a crop off one of your own beds.',
    unit: 'count',
    need: 1,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 50 },
  },
  {
    id: 'take-500',
    name: 'Five hundred taken',
    blurb: 'Keep the tills busy until the shop has taken $500.',
    unit: 'money',
    need: 500,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 150, supplies: 18 },
  },
  {
    id: 'first-hire',
    name: 'Someone else to do it',
    blurb: 'Take somebody on. They stock, they serve, they get paid every morning.',
    unit: 'count',
    need: 1,
    measure: (g) => g.roster.length,
    reward: { cash: 150, supplies: 18 },
  },
  {
    id: 'sold-100',
    name: 'A hundred sales',
    blurb: 'A hundred things over the counter, whatever they were.',
    unit: 'count',
    need: 100,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 200, supplies: 24 },
  },
  {
    id: 'week-one',
    name: 'A week in',
    blurb: 'Still open on day seven.',
    unit: 'day',
    need: 7,
    measure: (g) => g.day,
    reward: { cash: 200, town: 1, supplies: 18 },
  },
  {
    id: 'take-2000',
    name: 'Two thousand taken',
    blurb: 'Word is getting round.',
    unit: 'money',
    need: 2000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 400, town: 1, supplies: 24 },
  },
  {
    id: 'harvest-100',
    name: 'A hundred picked',
    blurb: 'A hundred crops off your own beds — stock nobody had to pay for.',
    unit: 'count',
    need: 100,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 300, town: 1 },
  },
  {
    id: 'well-liked',
    name: 'Well thought of',
    blurb: 'Get the shop’s reputation up to three quarters.',
    unit: 'percent',
    need: 0.75,
    measure: (g) => g.reputation,
    reward: { cash: 500, town: 1, supplies: 24 },
  },
  {
    id: 'sold-500',
    name: 'Five hundred sales',
    blurb: 'The shop is a habit for somebody now.',
    unit: 'count',
    need: 500,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 750, town: 1, supplies: 36 },
  },
  {
    id: 'take-10000',
    name: 'Ten thousand taken',
    blurb: 'The corner shop that everybody uses.',
    unit: 'money',
    need: 10000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 1500, supplies: 36 },
  },
];

const byId = Object.fromEntries(MILESTONES.map((m) => [m.id, m]));

/** Earned, as a set. `done` is a plain array on the save so it stays readable. */
const earned = (g) => new Set(g.milestones?.done ?? []);

/**
 * How much bigger the town is because of what you have done, in the units
 * `Game.catchment` adds up in.
 *
 * **Derived from the done list rather than stored beside it**, which is the
 * `fixtureCounts` argument said about a reward: a stored total can double-count
 * a milestone on a restart or keep one you have never earned, and there is
 * nothing to compare it against to find out. A row whose `town` is edited later
 * moves every shop that earned it, which is right — it is a balance number, and
 * balance numbers live in code.
 */
export function milestoneReach(g) {
  let n = 0;
  for (const id of earned(g)) n += byId[id]?.reward?.town ?? 0;
  return n;
}

/**
 * Take the ladder out of a game, for a sweep that is measuring something else.
 *
 * A milestone pays real money and lands real crates, so any script that drives
 * a shop through a sale and then asserts what the cash did is measuring the
 * ladder as well from the day this shipped — `verify:till` caught it on "the
 * shop has not banked the takings — expected 0, got 250". That is the
 * `fresh()` trap in CLAUDE.md in its second form: not a field that was added,
 * but one that newly *matters*.
 *
 * Marked done rather than switched off, because "off" would be a second state
 * the sim has to carry and every reader would have to remember. A sweep that is
 * deliberately testing the ladder simply does not call this.
 *
 * `simulate` deliberately does NOT call it: a balance bot that never sees a
 * feature is the broken instrument, not the honest control.
 */
export function silenceMilestones(g) {
  g.milestones = { done: MILESTONES.map((m) => m.id), opened: true };
}

/** What the shop has done and what is left, as the panel reads it. */
export function milestoneProgress(g) {
  const done = earned(g);
  return MILESTONES.map((m) => ({
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    unit: m.unit,
    need: m.need,
    // Clamped, because a bar that reads 340/100 on something you finished last
    // week is arithmetic where a tick should be.
    have: done.has(m.id) ? m.need : Math.min(m.need, round(m.measure(g))),
    done: done.has(m.id),
    reward: m.reward,
  }));
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/**
 * Award anything that has come due, and say so.
 *
 * Called from `step`, throttled by the caller — every measure here is a field
 * read or a `length`, so the cost is the loop rather than the work, and once a
 * second is well inside "the moment it happened" for a number that moves at the
 * speed of a shop.
 *
 * Everything it awards goes through the ordinary machinery: cash is cash, the
 * town is a term in `catchment`, and a gift of stock is an order on the next
 * van — nothing here invents a second way for goods or money to arrive.
 */
export function checkMilestones(g) {
  /**
   * The first sweep a save ever gets BANKS what is already true rather than
   * celebrating it.
   *
   * A rung is a measurement — it asks whether something is true now, never
   * whether anybody watched it happen — and that is what makes the ladder free
   * to add to. The cost lands entirely on the shop that existed before it: a
   * save on day 148 with thirteen staff and a perfect reputation is three rungs
   * true at once, so opening it fired three cards, stopped the world, and
   * handed over three deliveries before the player had moved. Congratulating
   * somebody for a thing they did last month reads as the feature misfiring,
   * which is the opposite of what a first impression is for.
   *
   * So they are marked done and nothing else: no card, no gift, one log line.
   * They still count toward `milestoneReach` — the town is derived from the
   * done list, deliberately, and a second list of rungs-that-do-not-count would
   * be a number kept beside the shop rather than read off it.
   *
   * A brand-new shop banks nothing, because on day one with no staff and no
   * sales nothing on the ladder is true yet — which is why this needs no
   * special case for a new world, only a flag saying the sweep has run.
   */
  const opening = !g.milestones.opened;
  g.milestones.opened = true;

  const done = earned(g);
  const banked = [];
  for (const m of MILESTONES) {
    if (done.has(m.id)) continue;
    if (!(m.measure(g) >= m.need)) continue;
    done.add(m.id);
    g.milestones.done.push(m.id);
    if (opening) banked.push(m.name);
    else award(g, m);
  }

  if (opening) {
    // Straight to the save, rather than waiting for the day to turn: a restart
    // in between would run the opening sweep again and say it twice. Harmless
    // either way — the set is the same — but a line about your shop's history
    // that appears on every boot is a line you learn to ignore.
    if (banked.length) {
      g.pushLog(`${banked.length} milestone${banked.length === 1 ? '' : 's'} already met: ${banked.join(', ')}.`);
    }
    g.persist();
  }
}

function award(g, m) {
  const got = [];

  if (m.reward.cash > 0) {
    g.cash = Math.round((g.cash + m.reward.cash) * 100) / 100;
    got.push(`$${m.reward.cash.toFixed(2)}`);
  }

  // The town, spelled out as the number it becomes rather than as the step —
  // "+1" says nothing about a shop whose catchment you have never been shown.
  // `catchment()` already counts this one, because the done list is what it
  // reads and the row went on it above.
  if (m.reward.town > 0) {
    got.push(`the town grew to ${round(g.catchment())} in reach`);
  }

  if (m.reward.supplies > 0) {
    const sent = giftSupplies(g, m.reward.supplies);
    if (sent) got.push(sent);
  }

  g.pushLog(`Milestone: ${m.name}${got.length ? ` — ${got.join(', ')}.` : '.'}`);

  /**
   * ...and the modal, which is the whole point of the feature and the one bit
   * the sim cannot do itself.
   *
   * A queue rather than a call, for the reason the director's headline is one:
   * `Game` has no room and no sockets, and a shop that awarded two milestones
   * in one tick has two things to say. `MartRoom.pushState` drains it.
   */
  g.milestoneNews.push({
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    reward: m.reward,
    got,
    // What the town is now, for every award rather than only the ones that grew
    // it: the modal is where anybody ever finds out this number exists.
    catchment: round(g.catchment()),
  });
}

/**
 * A free run of stock, on the next van.
 *
 * **An order rather than a crate**, which is the one decision in here worth
 * defending. `dropGoods` would put the pallets on the pad this instant and it
 * would be wrong twice over: a gift that teleports is the supplier-as-vending-
 * machine bug that step 1 of docs/deliveries.md removed, and a pile of crates
 * appearing behind you while a modal is up is a delivery nobody saw arrive.
 * Filed as ordinary pending orders at `cost: 0`, the lorry brings it, the
 * stocker puts it away, and the whole feature is four fields.
 *
 * Bounded by `bayRoom` with the rest of the guards, because a run that turns up
 * with more than the pad can hold has nowhere to land — and a shop with no bay
 * at all simply gets the rest of the reward and a line saying so.
 */
function giftSupplies(g, units) {
  const room = g.bayRoom();
  const take = Math.min(units, Math.max(0, room));
  if (take <= 0) return null;

  const picks = giftItems(g, take);
  if (!picks.length) return null;

  const c = content();
  const run = g.nextRun();
  for (const p of picks) {
    g.orders.pending.push({
      id: `ord-${g.nextOrderId++}`,
      item_id: p.id,
      qty: p.qty,
      cost: 0,
      placedDay: g.day,
      placedAt: Math.round(g.time * 24 * 100) / 100,
      runHour: run.hour,
      arrivesAt: g.elapsed + run.wait,
      wait: Math.round(run.wait * 100) / 100,
      // Nothing reads this yet. It is here because a $0 order is otherwise
      // indistinguishable from one somebody placed while the money was in the
      // supplier's hands, and the supplier's list is where it will show up.
      gift: true,
    });
  }
  const total = picks.reduce((n, p) => n + p.qty, 0);
  const what = picks.length === 1
    ? `${total}x ${c.byId.items[picks[0].id]?.name ?? picks[0].id}`
    : `${total} units of stock`;
  return `${what} on the way, free`;
}

/**
 * What to send, and how much of each.
 *
 * The shop's own answer first: whatever `restockQueue` says the shelves are
 * short of, which is the same order the stocker buys in. A gift of something
 * nothing in the shop has a board for is a crate that sits on the pad until it
 * rots, so a kind the shop does not own is never chosen — the `homeKind`/
 * `shelfKind` pair rather than a `frozen` boolean, because a warmer is not a
 * shelf and a boolean cannot say so.
 *
 * The fallback matters more than it looks: a brand-new shop's shelves are bare
 * and unreserved, so `restockQueue` names units without naming goods, and the
 * very first milestone in the ladder is earned in a shop in exactly that state.
 */
function giftItems(g, units) {
  const c = content();
  const owns = new Set(g.layout.shelves.map((s) => shelfKind(s.kind)));
  const crafted = new Set(c.recipes.map((r) => r.output_id));
  const seen = new Set();
  const wanted = [];
  const add = (id) => {
    if (!id || seen.has(id)) return;
    const it = c.byId.items[id];
    // Anything a recipe makes has to be made — `buyStock` refuses to order it,
    // and a gift is not the place to invent an exception to that.
    if (!it || crafted.has(id) || !owns.has(homeKind(it))) return;
    seen.add(id);
    wanted.push(it);
  };

  for (const s of g.restockQueue()) {
    const assigned = Array.isArray(s.assigned) ? s.assigned : [s.assigned];
    for (const id of assigned) add(id);
    for (const k of g.shelfStacks(s)) add(k.item_id);
  }

  if (!wanted.length) {
    for (const it of c.items) {
      if (crafted.has(it.id) || !owns.has(homeKind(it))) continue;
      wanted.push(it);
    }
    // Cheapest first, so a shop with nothing on its shelves is handed the
    // staples it can actually sell rather than one tin of something exotic.
    wanted.sort((a, b) => (a.base_cost ?? 0) - (b.base_cost ?? 0));
  }

  const picks = [];
  let left = units;
  for (const it of wanted.slice(0, 3)) {
    if (left <= 0) break;
    const qty = Math.min(left, it.stack ?? 12);
    if (qty <= 0) continue;
    picks.push({ id: it.id, qty });
    left -= qty;
  }
  return picks;
}
