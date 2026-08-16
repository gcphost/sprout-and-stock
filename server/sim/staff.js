/**
 * HIRED STAFF.
 *
 * The live game shipped with no NPC workers at all — the shopkeeper bot only
 * ever existed inside the headless balance runner, so an unattended shop just
 * filled up with shoppers holding baskets nobody would ever take money for.
 * These are the hires that make the shop run itself.
 *
 * Staff live in `game.players` on purpose. Every action method (`serve`,
 * `harvest`, `plant`, `buyStock`, `stockShelf`) already takes a player id and
 * enforces the same reach rules, and the client already draws everything in
 * `players` — so a hire obeys exactly the rules a human does, and shows up on
 * screen, without duplicating either system. They carry a `staff` role tag;
 * `stepPlayers` ignores them because they steer by path, not by input.
 *
 * A hire has no program of its own. What it is willing to do is a list of jobs
 * with weights, authored in the `workers` table, and one brain below draws from
 * that list. "Clerk" is not a branch in here any more — it is a row in the
 * database that happens to weight `serve` heavily.
 *
 * Every job guards itself. A job that only works when the worker's hands are
 * empty says so; a job that must not run while there is stock on the floor
 * checks the floor. Nothing may rely on being tried before something else,
 * because the draw is weighted and the order is not fixed.
 */

import { content } from '../content.js';
import { findPath, followPath } from './pathing.js';
import { suggestedPrice, wholesalePrice } from './economy.js';

/** Don't let a hire spend the shop down to nothing restocking. */
const CASH_FLOOR = 15;
const SPEND_FRACTION = 0.3;

/** How long a worker waits before looking for work again, having found none. */
const IDLE = 0.6;

/**
 * ENERGY.
 *
 * A hire loses a little with every job they finish, gets visibly slower as it
 * goes, and below `SPENT` stops and takes a break. That is the whole mechanic,
 * and the shape of it is the point: a break is a **threshold**, not a share of
 * the day. Putting `rest` in the weighted job list instead would send a worker
 * off for a coffee mid-queue one trip in seven at full energy, forever.
 *
 * Which is why it lives here rather than in `JOBS`, and pre-empts the draw.
 */
const DRAIN = 0.035;        // per job taken, so ~28 jobs on a full tank
const SPENT = 0.25;         // below this they down tools
/** How much slower a worker on an empty tank is than a fresh one. */
const TIRED_PACE = 1.8;
/**
 * What a break taken in a proper break area is worth, against the same break
 * taken leaning on a shelf.
 *
 * The one number the break area moves, and it has to move one. Walking round to
 * the room costs the shop time it would not otherwise have spent, so a room
 * that restored the same amount would be ground you pay for that only ever
 * makes things worse — the "tier that changes no number" trap in CLAUDE.md,
 * wearing a paintbrush. At 1.5 a hire comes back off a break that much closer to
 * full, which means fewer of them, which is what pays for the walk.
 */
const SEATED_RESTORE = 1.5;

/** 1 when fresh, TIRED_PACE when empty. Everything they do stretches by this. */
const tiredness = (s) => 1 + (TIRED_PACE - 1) * (1 - clamp01(s.energy ?? 1));
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/** The authored kind behind a hire. No row in the table, no worker. */
const kindOf = (s) => content().byId.workers[s.staff] ?? null;

/** The rung they are on. Tier 1 until promotion exists, and it multiplies by 1. */
function tierOf(s) {
  const w = kindOf(s);
  if (!w) return { speed_mult: 1, pace_mult: 1, carry_mult: 1 };
  return w.tiers[Math.min(s.tier ?? 1, w.tiers.length) - 1] ?? w.tiers[0];
}

const speedOf = (s) => ((kindOf(s)?.speed ?? 2.6) * tierOf(s).speed_mult) / tiredness(s);
/**
 * Seconds between actions, so they look like workers rather than a script — and
 * stretched by how worn out they are, so a tired worker is visibly dragging
 * before they stop altogether. A break that arrived with no warning would read
 * as the worker breaking.
 */
const paceOf = (s) => ((kindOf(s)?.pace ?? 0.7) / tierOf(s).pace_mult) * tiredness(s);
const carryOf = (s) => Math.max(1, Math.round((kindOf(s)?.carry ?? 6) * tierOf(s).carry_mult));

/**
 * Add or remove staff entities so they match the roster. Cheap enough to call
 * every tick, which keeps it correct across restarts and firings without
 * needing a hook on every path that changes who works here.
 */
export function syncStaff(game) {
  const roster = game.roster ?? [];
  const want = new Map(roster.map((e) => [`staff-${e.id}`, e]));

  for (const p of Object.values(game.players)) {
    if (p.staff && !want.has(p.id)) delete game.players[p.id];
  }

  for (const [id, entry] of want) {
    const w = content().byId.workers[entry.kind];
    // The kind was deleted out from under a hire. Nothing to draw and nothing
    // to do, so they don't turn up — rather than turning up as a broken one.
    if (!w) continue;

    const have = game.players[id];
    if (have) {
      // The roster is where a promotion lands, and the rung drives both the
      // stats read below and the model the client draws. Setting it only at
      // spawn would mean a promotion did nothing until the shop restarted.
      have.tier = entry.tier ?? 1;
      have.name = entry.name;
      have.color = w.color;
      continue;
    }

    const spawn = game.layout.spawn;
    // Fan new arrivals out across the spawn tile rather than dropping every one
    // of them on the same point. Two hires standing inside each other read as
    // one worker with a shadow, and until something gives them a job to walk to
    // that is exactly what you see.
    const nth = roster.indexOf(entry);
    game.players[id] = {
      id,
      name: entry.name,
      staff: entry.kind,
      hire: entry.id,
      tier: entry.tier ?? 1,
      x: spawn.x + ((nth % 5) - 2) * 0.3,
      z: spawn.z - 1,
      facing: 0,
      color: w.color,
      carry: null,
      input: null,   // steered by path, so stepPlayers skips them
      path: null,
      cooldown: 0,
      job: null,
      // Everyone starts their first shift fresh. Not persisted, so a server
      // restart is a good night's sleep — a dev-world quirk, not a design.
      energy: 1,
      breakFrom: 0,
      breakUntil: 0,
      pastime: null,
      /** Which cell of the break area is theirs, while they have one. */
      breakAt: null,
    };
  }
}

/**
 * What this particular hire will do — theirs, not their kind's.
 *
 * Two stockers can be told different things; that is the whole reason a hire is
 * a row rather than an owned upgrade. The kind's list is only the starting
 * point, copied on hire.
 */
function jobsOf(game, s) {
  const entry = (game.roster ?? []).find((e) => e.id === s.hire);
  return entry?.jobs ?? kindOf(s)?.jobs ?? [];
}

/**
 * Drive every hire one tick. Never throws — a stuck hire must not stall the sim.
 *
 * Picking is two steps. A weighted draw chooses which job to *try*, so a worker
 * given serve 7 / harvest 3 spends roughly seven trips in ten on the till. If
 * that job has nothing to do it falls through the rest by descending weight, so
 * an idle till still sends them to the crops instead of standing there.
 *
 * Which means one number says both things: priority when only one job has work,
 * and a share of the day when several do.
 */
export function stepStaff(game, dt) {
  syncStaff(game);

  for (const s of Object.values(game.players)) {
    if (!s.staff) continue;
    s.cooldown = Math.max(0, s.cooldown - dt);

    // Walking to a job takes priority over picking a new one.
    if (s.path && s.path.length) {
      followPath(s, speedOf(s), dt);
      continue;
    }

    if (s.cooldown > 0) continue;

    // A break outranks the whole job list, and is the one thing that does. It
    // is not drawn with the others because it is not a share of the day — see
    // the note on DRAIN.
    //
    // What it does not outrank is an errand already half done. Nothing stopped
    // a hire downing tools with a crate in their hands, so they carried it out
    // to the bay, vaped over it for twenty seconds and carried it back — which
    // reads as a worker who forgot what they were doing rather than one taking
    // five. So a full pair of hands defers the break, and the job list gets
    // asked first.
    if (tryBreak(game, s)) continue;

    const jobs = jobsOf(game, s);
    let took = false;
    for (const { job } of drawOrder(game, jobs)) {
      const run = JOBS[job];
      if (!run) continue;         // authored a job this build doesn't have
      try {
        if (run(game, s)) { s.job = job; took = true; spend(s); break; }
      } catch {
        // A broken job is not worth killing the tick loop over, and not worth
        // killing the *worker* over either — try the next one.
        s.job = null;
      }
    }
    if (took) continue;

    s.job = null;
    // ...and here is what stops "finish first" becoming "never rest". Their
    // hands are full and the whole job list just declined: no shelf will take
    // it, no station wants it, and nobody gave this hire `tidy`. There is
    // nothing left to finish, so they take the break holding it — which is
    // exactly what every break did before. The deferral can only ever last as
    // long as there is genuinely something to do with what they are carrying.
    if (tryBreak(game, s, true)) continue;
    idle(game, s);
  }
}

/**
 * `onBreak`, with the throw dealt with.
 *
 * A stuck break must not cost a hire their shift, and this is now called twice
 * a tick, so the recovery belongs in one place rather than in two catches that
 * can drift apart.
 */
function tryBreak(game, s, evenCarrying = false) {
  try {
    return onBreak(game, s, evenCarrying);
  } catch {
    s.breakFrom = 0;
    s.breakUntil = 0;
    s.pastime = null;
    // The seat goes back with everything else. A claim left on a worker who is
    // no longer on a break is a cell of the room nobody may ever sit in again.
    s.breakAt = null;
    s.energy = 1;   // rather than leaving them stuck at empty and useless
    return false;
  }
}

/**
 * The order to try jobs in this tick: one weighted draw for the head, then the
 * rest heaviest-first.
 *
 * Uses the game's seeded rng, never Math.random — two `simulate` runs of one
 * seed have to match, or every balance comparison in the project becomes noise.
 */
function drawOrder(game, jobs) {
  if (jobs.length <= 1) return jobs;
  const rest = [...jobs].sort((a, b) => b.weight - a.weight);
  const total = rest.reduce((n, j) => n + j.weight, 0);
  let r = game.rng.next() * total;
  let head = rest[0];
  for (const j of rest) {
    r -= j.weight;
    if (r <= 0) { head = j; break; }
  }
  return [head, ...rest.filter((j) => j !== head)];
}

/** One job's worth of wear. */
function spend(s) {
  s.energy = clamp01((s.energy ?? 1) - DRAIN);
}

// ---------------------------------------------------------------------------
// Breaks.
//
// The one thing that outranks the job list, because it is the one thing that is
// not a share of the day. Everything about *what* a break looks like is
// authored in `pastimes`; the only two numbers read here are `seconds` and
// `restores`, and together they decide what downtime costs the shop.
// ---------------------------------------------------------------------------

/**
 * Take, continue, or finish a break. Returns true if the worker is on one and
 * the job list should not be consulted this tick.
 *
 * `evenCarrying` is the second ask of the tick — see `stepStaff`. Without it a
 * hire whose hands cannot be emptied would defer their break forever and stay
 * pinned at `TIRED_PACE`, which is a worse bug than the one the deferral fixes.
 */
function onBreak(game, s, evenCarrying = false) {
  // Mid-break: sit it out, then come back with the tank topped up.
  if (s.pastime) {
    if (game.elapsed < s.breakUntil) { s.cooldown = 0.4; return true; }
    const done = content().byId.pastimes?.[s.pastime];
    // `breakAt` is set when and only when a seat in the break area was claimed,
    // so it is the whole test for "was this break taken in the room" — no
    // second flag, and nothing to keep in step with where they actually went.
    s.energy = clamp01((s.energy ?? 0) + (done?.restores ?? 0.5) * (s.breakAt ? SEATED_RESTORE : 1));
    s.pastime = null;
    s.breakAt = null;   // the seat is free again the moment they stand up
    s.job = null;
    return false;
  }

  if ((s.energy ?? 1) > SPENT) return false;
  // Finish what is in your hands first. Checked *before* the draw below, and
  // that ordering is load-bearing: a deferred break must consume no rng, or the
  // deferral shifts the whole stream and two `simulate` runs of one seed stop
  // matching for reasons that have nothing to do with breaks.
  if (s.carry && !evenCarrying) return false;

  const pick = choosePastime(game, s);
  // Nothing authored to do, so they soldier on rather than freezing at empty.
  // A shop with no pastimes in the database plays exactly as it did before.
  if (!pick) { s.breakAt = null; s.energy = 1; return false; }

  const spot = spotFor(game, s, pick);
  if (spot && !goTo(game, s, spot, 1.2)) { s.job = 'break'; return true; }

  // Buying is the *reason* for some breaks, not a condition of them: no stock,
  // no snack, but they still get their five minutes.
  buySnack(game, s, pick);

  s.pastime = pick.id;
  // Both ends, not just the far one. How far *through* a break somebody is is
  // the number a pastime's authored stages are flipped by, and you cannot get
  // it back from a deadline alone — see `breakProgress`.
  s.breakFrom = game.elapsed;
  s.breakUntil = game.elapsed + Math.max(1, pick.seconds ?? 20);
  s.job = 'break';
  s.cooldown = 0.4;
  return true;
}

/**
 * How far through their break they are, 0..1, or null when they are working.
 *
 * This is the first thing in the game to drive a staged model from *time*. A
 * crop feeds `partsAt` its growth and a fixture feeds it its tier; a pastime
 * feeds it this, and gets a flipbook — a mug emptying, a sandwich going down to
 * the crusts — out of the authoring shape that already existed.
 *
 * Read-only, and read by nobody in here: it exists for `snapshot()`. Working it
 * out on the client instead would mean the client guessing at a deadline it
 * cannot see the clock for.
 */
export function breakProgress(s, elapsed) {
  if (!s.pastime) return null;
  const span = (s.breakUntil ?? 0) - (s.breakFrom ?? 0);
  if (!(span > 0)) return 1;
  return clamp01((elapsed - (s.breakFrom ?? 0)) / span);
}

/**
 * Which pastime, drawn on the seeded rng so two `simulate` runs of one seed
 * still match. A pastime tagged for a kind of worker is only offered to one
 * carrying that tag; an untagged one is for anybody.
 */
function choosePastime(game, s) {
  const mine = new Set(kindOf(s)?.tags ?? []);
  const options = (content().pastimes ?? [])
    .filter((p) => (p.weight ?? 1) > 0)
    .filter((p) => !p.tags?.length || p.tags.some((t) => mine.has(t)));
  if (!options.length) return null;

  const total = options.reduce((n, p) => n + (p.weight ?? 1), 0);
  let r = game.rng.next() * total;
  for (const p of options) {
    r -= p.weight ?? 1;
    if (r <= 0) return p;
  }
  return options[options.length - 1];
}

/**
 * Where this break happens — and claims the seat, if there is one to claim.
 *
 * **A break area outranks whatever the pastime authored.** That is the whole of
 * the feature, and the reason it is a full override rather than one more entry
 * in `PASTIME_SPOTS`: `bay`, `outside` and `till` are a pastime saying where it
 * looks right, from a time when the shop had nowhere of its own to send anyone.
 * If half your hires used the room you paid for and half stood in the aisle,
 * the room would read as broken. So `spot` is now the fallback — where a break
 * happens in a shop that has nowhere for it — and a shop with no break area
 * plays exactly as it always did.
 *
 * Not a pure query, deliberately: choosing a seat and taking it are the same
 * act, or two hires pick the same cell and stand inside each other.
 */
function spotFor(game, s, p) {
  return seatIn(game, s) ?? authoredSpot(game, p);
}

/**
 * A cell of the break area for this worker, or null to take it where they are.
 *
 * One cell seats one person, which is what makes how big you paint it a
 * decision — the same claim the yard makes about crates, made about people. A
 * room with no free seat is not a queue: the fifth hire takes their break where
 * the pastime says, which is what all five did before there was a room.
 *
 * The reachability check is not paranoia. Since the room outranks the authored
 * spot, a break area somebody has walled off — or painted behind a shelf —
 * would otherwise be a shop whose staff walk at a seat they can never reach and
 * never rest again, at `TIRED_PACE`, forever. A seat with no route is not a
 * seat, and they fall back to what they did before.
 */
function seatIn(game, s) {
  const room = game.layout.break;
  // The common case, and it stays the cheap one: no room means no roster walk
  // and no pathfinding, so a shop that has not painted one does no work here at
  // all. The claim still has to be cleared rather than skipped — a stale seat is
  // a cell of a room somebody painted later that nobody may ever sit in.
  if (!room) { s.breakAt = null; return null; }

  const taken = new Set();
  for (const o of Object.values(game.players)) {
    if (o !== s && o.breakAt) taken.add(`${o.breakAt.x},${o.breakAt.z}`);
  }
  // Their own claim first, and without re-testing the route: a hire who changed
  // seats halfway to one is a worker who turns round for no reason anyone
  // watching could explain. It is looked up in the room rather than trusted, so
  // a seat painted over while they walked to it is one they give up.
  const held = s.breakAt
    ? room.cells.find((c) => c.x === s.breakAt.x && c.z === s.breakAt.z)
    : null;
  const seat = held
    ?? room.cells.find((c) => !taken.has(`${c.x},${c.z}`) && reaches(game, s, c))
    ?? null;
  s.breakAt = seat ? { x: seat.x, z: seat.z } : null;
  return s.breakAt;
}

/** Is there a route from where they are standing to there? */
const reaches = (game, s, c) => findPath(game.walk, game.layout, s, c) !== null;

/** Where the pastime itself says. `here` is wherever they finished, so it has none. */
function authoredSpot(game, p) {
  const L = game.layout;
  if (p.spot === 'bay') return L.bay;
  if (p.spot === 'outside') return { x: L.door.x, z: L.door.z + 2 };
  if (p.spot === 'till') {
    const till = L.checkouts[0];
    return till ? { x: till.x, z: till.z - 1 } : null;
  }
  return null;
}

/**
 * A worker on their break buys the snack off your own shelf.
 *
 * The same money a shopper would have paid, into the same day's takings — so
 * stocking what your own staff like is a small revenue line rather than a
 * rounding error, and the wage goes partly back over the counter. A hire is
 * already an entry in `players`; being briefly a customer is that same trick
 * one step along, and costs no new machinery.
 */
function buySnack(game, s, p) {
  if (!p.buys?.length) return;
  const items = content().byId.items;
  const shelf = game.layout.shelves.find((sh) => {
    if (!sh.item_id || sh.qty <= 0) return false;
    return (items[sh.item_id]?.tags ?? []).some((t) => p.buys.includes(t));
  });
  if (!shelf) return;

  const paid = round2(shelf.price ?? 0);
  shelf.qty -= 1;
  game.cash = round2(game.cash + paid);
  game.stats.revenue += paid;
  game.stats.sold += 1;
  game.stats.byItem[shelf.item_id] = (game.stats.byItem[shelf.item_id] ?? 0) + 1;
  game.pushLog(`${s.name} bought a ${items[shelf.item_id]?.name ?? shelf.item_id} on their break.`);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Nothing to do. A worker whose heaviest job is serving goes and stands behind
 * a counter, because that is where being early matters; everyone else stops
 * where they are rather than trekking somewhere to look idle.
 *
 * *A* counter, not `checkouts[0]`. Every idle server used to be sent to the
 * same till, so a shop with two clerks had both of them standing on one tile
 * with the second till unmanned — which looks like a rendering fault and is
 * really a queue nobody is serving.
 *
 * Posts are handed out by roster order rather than by who asks first: the draw
 * has to be reproducible or two `simulate` runs of one seed stop matching.
 * Anyone past the last till has nowhere to be, and stays where they finished.
 */
function idle(game, s) {
  s.cooldown = IDLE;
  if (s.carry || topJob(game, s) !== 'serve') return;

  const tills = game.layout.checkouts;
  const servers = (game.roster ?? [])
    .map((e) => game.players[`staff-${e.id}`])
    .filter((p) => p && !p.carry && topJob(game, p) === 'serve');

  const post = tills[servers.indexOf(s)];
  if (post) goTo(game, s, { x: post.x, z: post.z - 1 }, 0.6);
}

/** The job this hire gives most of their day to. */
function topJob(game, s) {
  return [...jobsOf(game, s)].sort((a, b) => b.weight - a.weight)[0]?.job ?? null;
}

/** Walk to `goal`; returns true once standing there. */
function goTo(game, s, goal, reach = 1.2) {
  if (Math.hypot(s.x - goal.x, s.z - goal.z) <= reach) return true;
  if (!game.pathTo(s, goal)) {
    s.cooldown = 1;   // unreachable — try something else shortly
    return false;
  }
  return false;
}

/**
 * Nowhere legal to put what they're holding: walk it round to the drop-off and
 * crate it. Staff used to just have the goods deleted out of their hands, which
 * meant an over-full shop quietly binned every harvest. Now the stock survives,
 * sits somewhere visible, and can be dealt with by a human.
 *
 * The drop-off rather than the delivery bay, for the same reason a person uses
 * it: a crate a worker parked because the shop is full is not an order that
 * arrived, and piling both on one pad makes the yard unreadable.
 */
function putDown(game, s) {
  // A shop can have no drop-off at all now that the pads are ground somebody
  // paints — see `Game.freezeYard`. Nothing to walk to, so they keep hold of it
  // and try again later rather than pathing to `undefined`.
  const pad = game.dropPad();
  if (!pad) { s.cooldown = 2; return; }
  if (!goTo(game, s, pad, 1.6)) return;
  const res = game.stow(s.id);
  if (!res.ok) { s.carry = null; s.cooldown = 2; return; }
  s.cooldown = paceOf(s);
}

// ---------------------------------------------------------------------------
// The jobs.
//
// One function each, `(game, worker) => tookTheTick`. Returning false means
// "nothing here for me", and the worker moves down its list; returning true
// means it acted, or is walking somewhere to act.
//
// Each one guards itself. Nothing may assume it runs before anything else.
// ---------------------------------------------------------------------------

/** Man a till: take the money off the counter, then ring the next shopper up. */
function serve(game, s) {
  if (s.carry) return false;
  const tills = game.layout.checkouts;
  if (!tills.length) return false;

  const waiting = (t) => (t.queue ?? []).some((id) => game.customers[id]?.state === 'QUEUE');
  const till = tills.find(waiting) ?? tills[0];
  const post = { x: till.x, z: till.z - 1 };
  const standing = Math.hypot(s.x - post.x, s.z - post.z) <= 0.6;

  // Cash left on the counter is worth collecting even with nobody in the line.
  if (!waiting(till) && !(standing && game.cashDrops.length)) return false;
  if (!goTo(game, s, post, 0.6)) return true;

  if (game.collectCash(s) > 0) { s.cooldown = paceOf(s); return true; }
  if (!waiting(till)) return false;
  const res = game.serve(s.id, till.id);
  s.cooldown = res.ok ? paceOf(s) : 0.5;
  return true;
}

/**
 * Order wholesale for whichever shelf wants it most.
 *
 * Refuses while there is a pallet at the bay it could be unloading instead —
 * ordering on top of stock already on the floor is how a shop ends up with the
 * whole delivery bay full and the shelves still bare.
 *
 * It walks the queue rather than taking the head on faith, for the reason the
 * balance bot's spend queue does: one shelf that cannot be ordered for — set
 * aside for something the shop can't afford this minute, or for an item content
 * has since deleted — would otherwise wedge restocking permanently, and nothing
 * about a shop that quietly stopped ordering says why.
 */
function restock(game, s) {
  if (s.carry) return false;
  const c = content();
  if (game.deliveries.some((d) => shelfFor(game, d.item_id, c))) return false;

  const budget = (game.cash - CASH_FLOOR) * SPEND_FRACTION;
  if (budget <= 0) return false;

  // The order the shop asks for. `restockQueue` is the sim's rule, not this
  // job's: it is what the player set in the shelf menu, and a second copy of it
  // here is the one that would drift from what the menu promised.
  for (const target of game.restockQueue()) {
    // What it is set aside for beats what happens to be on it, which beats
    // picking for yourself. An assignment is the whole point of assigning — a
    // shelf reserved for milk is never restocked with anything else, even when
    // something else would sell better.
    const item = c.byId.items[target.assigned ?? target.item_id]
      ?? (target.assigned ? null : pickItem(game, target, c));
    if (!item) continue;

    const unit = wholesalePrice(item, game.folded(), game.season);
    // Orders arrive as a pallet, so they aren't capped by what one pair of hands
    // can hold — the worker just makes more trips.
    const qty = Math.min(item.stack - target.qty, Math.floor(budget / Math.max(unit, 0.01)));
    if (qty <= 0) continue;

    if (!game.buyStock(s.id, item.id, qty).ok) continue;
    s.cooldown = paceOf(s);
    return true;
  }
  return false;
}

/** Pick up a pallet at the bay — but only one with somewhere legal to go. */
function unload(game, s) {
  if (s.carry) return false;
  const c = content();
  const pallet = game.deliveries.find((d) => shelfFor(game, d.item_id, c));
  if (!pallet) return false;
  if (!goTo(game, s, pallet, 1.4)) return true;
  const res = game.unload(s.id, pallet.id);
  s.cooldown = res.ok ? paceOf(s) : 1;
  return true;
}

/** Put what's in hand onto a shelf that will take it. */
function shelve(game, s) {
  if (!s.carry) return false;
  const shelf = shelfFor(game, s.carry.item_id, content());
  if (!shelf) return false;                        // `tidy` deals with that
  if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
  game.stockShelf(s.id, shelf.id);
  s.cooldown = paceOf(s);
  return true;
}

/** Crate up something with nowhere to go, out at the drop-off. */
function tidy(game, s) {
  if (!s.carry) return false;
  putDown(game, s);
  return true;
}

/**
 * Break new ground.
 *
 * Refuses while a turned bed is still waiting for seed: finishing one is a
 * single action from producing, and doing it the other way round tills the
 * whole field before a single seed goes in.
 */
function till(game, s) {
  if (s.carry) return false;
  if (game.layout.plots.some((p) => !p.crop_id && p.soil === 'tilled')) return false;
  const rough = game.layout.plots.find((p) => !p.crop_id && p.soil !== 'tilled');
  if (!rough) return false;
  // Don't break ground the shop can't afford to sow — an all-tilled, all-empty
  // field is worse than an untouched one.
  if (!pickCrop(game, content())) return false;
  if (!goTo(game, s, rough)) return true;
  game.till(s.id, rough.id);
  s.cooldown = paceOf(s);
  return true;
}

/** Put seed in a bed that's already been turned. */
function sow(game, s) {
  if (s.carry) return false;
  const bed = game.layout.plots.find((p) => !p.crop_id && p.soil === 'tilled');
  if (!bed) return false;
  const crop = pickCrop(game, content());
  if (!crop) return false;
  if (!goTo(game, s, bed)) return true;
  game.plant(s.id, bed.id, crop.id);
  s.cooldown = paceOf(s);
  return true;
}

/** Pick anything ripe. */
function harvest(game, s) {
  if (s.carry) return false;
  const ripe = game.layout.plots.find((p) => p.ready);
  if (!ripe) return false;
  if (!goTo(game, s, ripe)) return true;
  game.harvest(s.id, ripe.id);
  s.cooldown = paceOf(s);
  return true;
}

/**
 * Work the appliances: tip in what they're short of, take out what's finished,
 * and fetch ingredients off the shelves in between.
 */
function craft(game, s) {
  const stations = game.layout.stations ?? [];
  if (!stations.length) return false;

  // Holding an ingredient something wants? Tip it in. Holding anything else is
  // `shelve`'s problem, not this one's.
  if (s.carry) {
    const needing = stations.find((st) => wants(game, st).has(s.carry.item_id));
    if (!needing) return false;
    if (!goTo(game, s, needing.useAt)) return true;
    const res = game.loadStation(s.id, needing.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }

  // Something finished? Get it out.
  const done = stations.find((st) => st.output);
  if (done) {
    if (!goTo(game, s, done.useAt)) return true;
    game.collectStation(s.id, done.id);
    s.cooldown = paceOf(s);
    return true;
  }

  // Otherwise fetch what an idle appliance is short of. Least-loaded first, so
  // one machine doesn't hog the worker.
  const idleStations = stations
    .filter((st) => !st.making && !st.output)
    .sort((a, b) => total(a.contents) - total(b.contents));

  for (const st of idleStations) {
    const recipe = feasibleRecipe(game, st);
    if (!recipe) continue;
    for (const input of recipe.inputs) {
      const short = input.qty - (st.contents[input.item_id] ?? 0);
      if (short <= 0) continue;
      // Back of house first, shop floor second. Stripping a shelf customers
      // are still buying from is the behaviour the kitchen exists to stop —
      // and it stays as the FALLBACK rather than being forbidden, because a
      // shop with no kitchen yet must still be able to make things.
      const stocked = game.layout.shelves.filter(
        (sh) => sh.item_id === input.item_id && sh.qty > 0,
      );
      const shelf = stocked.find((sh) => sh.boh) ?? stocked[0];
      if (!shelf) continue;
      if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
      // Take only the shortfall — hoarding an ingredient strips a shelf
      // customers are still buying from.
      const take = Math.min(short, shelf.qty, carryOf(s));
      shelf.qty -= take;
      s.carry = { item_id: input.item_id, qty: take };
      s.cooldown = paceOf(s);
      return true;
    }
  }
  return false;
}

/** The vocabulary, and the only thing an authored job name is checked against. */
const JOBS = { serve, restock, unload, shelve, tidy, till, sow, harvest, craft };

const total = (contents) => Object.values(contents ?? {}).reduce((a, b) => a + b, 0);

/**
 * A shelf that will legally accept this item.
 *
 * `restock`, `unload` and `shelve` all rest on this, so losing it costs you
 * every job that touches a shelf at once — and `stepStaff` swallows a throw per
 * job, so it costs them silently. See the note on that catch.
 *
 * Exported for `verify-build`, which is the only caller outside this file. It
 * is a second implementation of "where may this go" alongside `shelfAccepts`,
 * and the two disagreeing is invisible from any screenshot: a shelf you set
 * aside would simply get filled with something else by somebody you employ.
 */
export function shelfFor(game, itemId, c) {
  const item = c.byId.items[itemId];
  if (!item) return null;
  const needsFreezer = item.tags.includes('needs-freezer') || item.tags.includes('frozen');
  const usable = game.layout.shelves.filter((sh) => {
    if (needsFreezer && sh.kind !== 'freezer') return false;
    if (!needsFreezer && sh.kind === 'freezer') return false;
    // Set aside for something else is a no even when it's bare — otherwise a
    // stocker with an armful fills the shelf you reserved and the reservation
    // only means anything until the next delivery lands.
    if (sh.assigned && sh.assigned !== itemId) return false;
    if (sh.qty > 0 && sh.item_id !== itemId) return false;
    // Ask the shelf how much it holds rather than assuming a stack fits it.
    // `item.stack` is what fits a *standard* unit; an upgraded one holds
    // stack x capacity_mult. Testing against the stack meant staff filled a
    // tier-2 shelf to 8 of 12, walked the rest out to the bay and crated it —
    // so the capacity you paid for was only ever reachable by hand.
    return sh.qty < game.shelfCapacity(sh, item);
  });
  // A shelf set aside for it first, then one already holding it, then whatever
  // the player marked to fill first. Topping up beats claiming a bare shelf,
  // and being asked for beats both.
  return usable.sort((a, b) => (b.assigned === itemId) - (a.assigned === itemId)
    || (b.item_id === itemId) - (a.item_id === itemId)
    || (b.priority ?? 0) - (a.priority ?? 0))[0] ?? null;
}

/** Best unstocked item for an empty shelf: margin weighted by who wants it. */
function pickItem(game, shelf, c) {
  const folded = game.folded();
  // Reservations count as "already stocked" even where the shelf is still bare.
  // Choosing for a free shelf is a choice about the *range*, and something
  // another shelf is being kept for is already in it.
  const already = new Set(game.layout.shelves
    .flatMap((sh) => [sh.item_id, sh.assigned]).filter(Boolean));

  const crafted = new Set(c.recipes.map((r) => r.output_id));

  const scored = c.items
    .filter((it) => {
      if (crafted.has(it.id)) return false;   // whoever has `craft` makes these
      const frozen = it.tags.includes('needs-freezer') || it.tags.includes('frozen');
      return frozen ? shelf.kind === 'freezer' : shelf.kind !== 'freezer';
    })
    .map((it) => {
      const margin = suggestedPrice(it, folded, game.season) - wholesalePrice(it, folded, game.season);
      const pull = c.archetypes.reduce((sum, a) => {
        let d = 0;
        for (const t of it.tags) d += a.affinities[t] ?? 0;
        return sum + Math.max(0, d) * a.spawn_weight;
      }, 0);
      return { it, score: margin * (0.5 + pull) };
    })
    .sort((a, b) => b.score - a.score);

  // Spread across the range rather than putting the same winner everywhere.
  return (scored.find((x) => !already.has(x.it.id)) ?? scored[0])?.it ?? null;
}

/** Ingredients this appliance could still use. */
function wants(game, st) {
  return new Set(game.recipesFor(st.station).flatMap((r) => r.inputs.map((i) => i.item_id)));
}

/**
 * The recipe this appliance can actually finish right now — every missing
 * ingredient has to be sitting on a shelf somewhere.
 *
 * Picking purely by "fewest items missing" deadlocks: the chef commits to the
 * nearly-complete recipe, discovers its last ingredient isn't stocked, and
 * never falls back to the one it could have made from what's on the shelves.
 */
function feasibleRecipe(game, st) {
  const stock = new Map();
  for (const sh of game.layout.shelves) {
    if (sh.item_id && sh.qty > 0) stock.set(sh.item_id, (stock.get(sh.item_id) ?? 0) + sh.qty);
  }

  const options = game.recipesFor(st.station)
    .map((r) => ({
      r,
      short: r.inputs.reduce((n, i) => n + Math.max(0, i.qty - (st.contents[i.item_id] ?? 0)), 0),
      possible: r.inputs.every((i) => {
        const need = i.qty - (st.contents[i.item_id] ?? 0);
        return need <= 0 || (stock.get(i.item_id) ?? 0) >= need;
      }),
    }))
    .filter((o) => o.possible)
    .sort((a, b) => a.short - b.short);

  return options[0]?.r ?? null;
}

/**
 * Choose a seed weighted by value per minute. Always planting the single best
 * crop is a monoculture — the slower ones then never reach a shelf at all.
 */
function pickCrop(game, c) {
  const folded = game.folded();
  const budget = (game.cash - CASH_FLOOR);
  if (budget <= 0) return null;

  const options = c.crops
    .filter((cr) => !cr.seasons.length || cr.seasons.includes(game.season))
    .filter((cr) => cr.seed_cost <= budget)
    .map((cr) => {
      const item = c.byId.items[cr.item_id];
      if (!item) return null;
      const avgYield = (cr.yield_min + cr.yield_max) / 2;
      const value = suggestedPrice(item, folded, game.season) * avgYield;
      return { cr, score: (value - cr.seed_cost) / Math.max(cr.grow_minutes, 0.01) };
    })
    .filter((o) => o && o.score > 0);

  if (!options.length) return null;

  const total = options.reduce((sum, o) => sum + o.score, 0);
  let r = game.rng.next() * total;
  for (const o of options) {
    r -= o.score;
    if (r <= 0) return o.cr;
  }
  return options[options.length - 1].cr;
}
