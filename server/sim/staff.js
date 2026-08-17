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
 *
 * ...and every job also answers to a CLAIM — see `claimed`. A job function is a
 * query for the best target, and five workers asking the same pure question got
 * the same answer: three stockers converging on one crate, two chefs loading one
 * machine, both clerks stood on the same tile behind one till. Only one of them
 * can have it, so the rest walk the length of the shop to do nothing and go
 * round again. It reads as workers standing inside each other, which looks like
 * a rendering fault, and it costs exactly as much as it looks like it costs.
 */

import { content } from '../content.js';
import { findPath, followPath } from './pathing.js';
import { suggestedPrice, wholesalePrice } from './economy.js';
import { isPadAt, shelfKind } from '../../shared/build.js';
import { homeKind } from '../../shared/tags.js';
import { lotStacks, lotTotal, lotQty, lotHas, lotMain } from '../../shared/lot.js';

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
/**
 * How much this hire can hold: their kind's `carry`, times their rung.
 *
 * Exported because `Game.carryCapacity` is the one place the question is asked
 * of anybody — a second copy of this arithmetic over there is how a promotion
 * ends up meaning one thing to the pickup code and another to the hire panel.
 */
export const carryOf = (s) => Math.max(1, Math.round((kindOf(s)?.carry ?? 6) * tierOf(s).carry_mult));

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
      // Same argument as `tier` above, and the same bug if it is missed: the
      // roster is where a change of look lands, so a skin set on someone
      // already on shift has to reach their body here or it would not show
      // until the shop restarted.
      have.skin = entry.skin ?? null;
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
      /** Which look they have on. Null is "as the kind was drawn", not a gap. */
      skin: entry.skin ?? null,
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

    // Standing here with nothing on and nowhere to be, so whatever they had
    // claimed goes back on the board. This is the ONLY place a claim is
    // released, and its position is the whole design: the two `continue`s above
    // are "walking there" and "doing it", so a claim lasts exactly as long as
    // the errand does and cannot outlive the worker, the job, the shift or a
    // throw. Nothing to sweep up, and no second list to keep in step with who
    // actually works here.
    s.claim = null;

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

    // A crate on the shoulder is not a job you may be drawn off. `unload` is
    // the only job that knows how to put one down, so it is asked directly
    // rather than entered in the draw — everything else either refuses a full
    // pair of hands (and a haul is not `carry`, so it would NOT have refused,
    // which is the trap: `till` and `sow` both test `!s.carry` and would send
    // somebody to turn a bed over holding a box) or ignores hands entirely.
    //
    // Deliberately not a filter over `jobsOf`: a hire whose kind loses `unload`
    // between one tick and the next would then have no job left that could
    // relieve them, and the crate would be welded on for the rest of the shift.
    if (s.haul) {
      if (unload(game, s)) { s.job = 'unload'; spend(s); continue; }
      // Could not even set it down. Stand still rather than fall through to a
      // job that would ignore the box.
      s.job = null;
      idle(game, s);
      continue;
    }

    const jobs = jobsOf(game, s);
    // An errand `merchandise` began, ended. Here rather than only inside that
    // job, because it is the one place that runs whether or not the job does —
    // and `shifting` holds `shelve` off, so a hire left mid-errand by a job
    // taken off their list would stand there holding an armful for ever. Empty
    // hands or no job to finish it: either way there is no errand.
    if (s.shifting && (!s.carry || !jobs.some((j) => j.job === 'merchandise'))) s.shifting = null;
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
// Claims — one worker, one target.
//
// A claim is a string naming the thing a hire is on their way to: `crate del-3`,
// `shelf fx-12`, `till fx-27`, `plot fx-14`, `station fx-49`. It lives on the
// worker rather than in a ledger of its own, which is the same trick the break
// area plays with seats (`seatIn`) and it is worth being explicit about why:
// a claim held by nobody cannot exist, so firing somebody, a shift ending, a
// job throwing or a hire being deleted out from under the sim all release it
// for free. There is no list to garbage-collect and no way for the two to
// disagree about who works here.
//
// It is advisory, not a lock. Every job still guards itself, and a claimed
// target is *skipped* rather than waited for — so a hire always either finds
// second-best work or falls through to the next job on their list. Two workers
// briefly wanting one thing must never become two workers standing still.
// ---------------------------------------------------------------------------

/** Everything somebody else is already on their way to. */
function claimed(game, s) {
  const taken = new Set();
  for (const o of Object.values(game.players)) {
    if (o !== s && o.staff && o.claim) taken.add(o.claim);
  }
  return taken;
}

/**
 * ...and what is in the hands of the people walking to each shelf.
 *
 * A shelf is the one target that is not a single unit of work, and treating it
 * like one made the shop worse rather than better. A crate can only be lifted
 * once and a till can only be stood behind by one person, so skipping a claimed
 * one is pure gain — but a shelf with room for twelve will happily take two
 * armfuls of six, and a stocker sent elsewhere puts the second armful on a bare
 * board that something else needed. Measured over ten seeds that cost more in
 * lost range than the wasted walk was ever worth.
 *
 * So `shelve` asks the finer question — is this shelf already SPOKEN FOR, by
 * this much, of this — and `shelfFor` reads it as headroom rather than as a lock.
 */
function inbound(game, s) {
  const load = new Map();
  for (const o of Object.values(game.players)) {
    if (o === s || !o.staff || !o.claim) continue;
    // Hands OR shoulder. A hauled crate is goods walking towards the board its
    // carrier claimed, in exactly the sense this map exists to measure — and it
    // was invisible here, because every reader of a worker's load asked `carry`
    // and a crate is `haul`. It is a twelve-unit blind spot rather than a six,
    // so it is the biggest one this map has ever had.
    const lot = o.carry ?? o.haul;
    if (!lot) continue;
    // What they are MOSTLY carrying. The map's value is one item and one
    // number, because its readers ask "is somebody already bringing this board
    // some of this" — and a mixed armful heading for a shelf is still mostly
    // one thing. Widening it to a list would make every reader ask three
    // questions to answer one, for a distinction that only bites when a hire is
    // carrying two kinds to the same unit, which the unit then pours both onto.
    const main = lotMain(lot);
    const prev = load.get(o.claim);
    // Two people already heading there with the same thing add up; with
    // different things, the more restrictive answer is that the board is taken.
    if (!prev) load.set(o.claim, { item_id: main.item_id, qty: lotTotal(lot) });
    else if (prev.item_id === main.item_id) prev.qty += lotTotal(lot);
    else prev.item_id = null;
  }
  return load;
}

/** Say it once. The key spelling lives here and nowhere else. */
const key = (kind, id) => `${kind} ${id}`;

/**
 * Take it, and answer true so a job can claim and carry on in one breath.
 *
 * NOT called `take`: `craft` has a local `const take` for how many units it
 * lifts off a board, and a module function of that name is shadowed by it —
 * inside that block the call sites become a temporal-dead-zone throw, which
 * `stepStaff` catches and turns into a chef who quietly never cooks again.
 */
function claim(s, kind, id) {
  s.claim = key(kind, id);
  return true;
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
  // A crate counts, and for a stronger reason than an armful does: a hire who
  // downs tools mid-haul is stood in an aisle with a box, and the crate goes on
  // the floor wherever they happened to stop. `stepStaff`'s second ask still
  // gets them their break — see `evenCarrying` — and `unload` puts the crate
  // down before anything else on the way there.
  if ((s.carry || s.haul) && !evenCarrying) return false;

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

/**
 * The tile you stand on to work a till — its `tendAt`, the far side from the
 * queue.
 *
 * This was written out longhand as `{ x: till.x, z: till.z - 1 }` in the three
 * places below, which is the correct arithmetic for a till facing south and
 * wrong for the other three facings. A till turned to face east put its clerk
 * inside the wall to the north; one turned to face north put the clerk on the
 * head of its own queue. Neither was visible in a screenshot of a generated
 * shop, because the generator only ever lays tills at rot 1.
 *
 * The fallback is for a layout composed before the field existed — the layout
 * is regenerated from placements on every load, so in practice nothing reaches
 * it, and it is the old expression rather than a throw for the same reason
 * `kindOf` defaults instead of migrating.
 */
const tendSpot = (till) => (till ? (till.tendAt ?? { x: till.x, z: till.z - 1 }) : null);

/** Where the pastime itself says. `here` is wherever they finished, so it has none. */
function authoredSpot(game, p) {
  const L = game.layout;
  if (p.spot === 'bay') return L.bay;
  if (p.spot === 'outside') return { x: L.door.x, z: L.door.z + 2 };
  if (p.spot === 'till') return tendSpot(L.checkouts[0]);
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
  // A board, not a unit — somebody on their break browses the same way a
  // shopper does, and a shelf where only the middle board is something they
  // fancy is still a shelf they will buy off.
  let stack = null;
  for (const sh of game.layout.shelves) {
    stack = game.shelfStacks(sh).find((k) => k.qty > 0
      && (items[k.item_id]?.tags ?? []).some((t) => p.buys.includes(t))) ?? null;
    if (stack) break;
  }
  if (!stack) return;

  const paid = round2(stack.price ?? 0);
  stack.qty -= 1;
  game.cash = round2(game.cash + paid);
  game.stats.revenue += paid;
  game.stats.sold += 1;
  game.stats.byItem[stack.item_id] = (game.stats.byItem[stack.item_id] ?? 0) + 1;
  game.pushLog(`${s.name} bought a ${items[stack.item_id]?.name ?? stack.item_id} on their break.`);
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
  if (post) goTo(game, s, tendSpot(post), 0.6);
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
  // The nearest CELL of the pad, not the pad's middle. `stow` refuses anybody
  // not standing on the ground itself (`onPad`), and `pad.x/z` is only the cell
  // closest to the centre — on an L-shaped stockroom, or from the wrong side,
  // "within 1.6 of the middle" is a tile that is not on the pad at all. Which
  // was survivable right up until the line below stopped destroying the goods.
  const cell = (pad.cells ?? [pad]).reduce((best, c) => (
    Math.hypot(c.x - s.x, c.z - s.z) < Math.hypot(best.x - s.x, best.z - s.z) ? c : best
  ), pad.cells?.[0] ?? pad);
  if (!goTo(game, s, cell, 0.6)) return;
  const res = game.stow(s.id);
  // KEEP HOLDING IT. This branch used to read `s.carry = null`, which is the
  // exact bug the note above says was fixed — "staff used to just have the goods
  // deleted out of their hands" was made true again by the failure path, and it
  // fires precisely when the shop is over-full, which is when it was written to
  // matter. Nothing is lost by trying again: a pair of hands that cannot be
  // emptied defers the break rather than blocking it (see `stepStaff`), so a
  // worker holding something the shop has no room for is idle, visible, and
  // still holding it — all three of which are better than stock evaporating.
  if (!res.ok) { s.cooldown = 2; return; }
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
  // One clerk per till, and it has to be enforced here rather than left to
  // `idle`'s posts: `idle` spreads people who have nothing to do, and this is
  // the path taken by everybody who *does*. Both clerks used to answer the same
  // queue, which means both walk over, one rings the sale and the other stands
  // on the same tile watching — an unmanned second till at the same time.
  const busy = claimed(game, s);
  const tills = game.layout.checkouts.filter((t) => !busy.has(key('till', t.id)));
  if (!tills.length) return false;

  const waiting = (t) => (t.queue ?? []).some((id) => game.customers[id]?.state === 'QUEUE');
  const till = tills.find(waiting) ?? tills[0];
  const post = tendSpot(till);
  const standing = Math.hypot(s.x - post.x, s.z - post.z) <= 0.6;

  // Cash left on the counter is worth collecting even with nobody in the line.
  if (!waiting(till) && !(standing && game.cashDrops.length)) return false;
  claim(s, 'till', till.id);
  if (!goTo(game, s, post, 0.6)) return true;

  if (game.collectCash(s) > 0) { s.cooldown = paceOf(s); return true; }
  if (!waiting(till)) return false;
  const res = game.serve(s.id, till.id);
  // How long the sale held them up is the worker's own pace over the till's
  // speed — a hire on a scanner rings people through faster than the same hire
  // on a manual till, which is the whole argument for buying one. Collecting
  // the cash above is not: that is a walk and a pair of hands, and no register
  // has ever made it quicker.
  s.cooldown = res.ok ? game.serveSeconds(till, paceOf(s)) : 0.5;
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
 *
 * Three of the limits on it are the player's rather than this file's — see
 * `Game.orders`. Switching ordering off leaves every other job intact, which is
 * the point: a shop that has stopped buying still unloads, shelves and tidies.
 *
 * **Nothing here knows an order now takes hours to land**, and that is
 * deliberate rather than an oversight. The pallet guard below is a *scheduling*
 * question — is there something better to do this tick — and it was never a
 * supply check; what stops this ordering the same milk on every tick of the six
 * hours before the van comes is `homeSupply`, which counts the van along with
 * the crates, the hands and the beds. That is the whole reason the shop's supply
 * lives in one function on `Game`: the wait arrived through a new door and the
 * job needed no new check. The gotcha at the bottom of docs/ordering.md is
 * about exactly these two looking identical.
 */
function restock(game, s) {
  if (s.carry) return false;
  if (!game.orders.auto) return false;
  const c = content();
  // Which items are already sat at the bay with somewhere to go. Per ITEM, not
  // shop-wide — and that distinction is the difference between a scheduling
  // hint and a deadlock.
  //
  // This used to be `deliveries.some(...)`: one crate of anything with anywhere
  // to go stopped the shop ordering ANYTHING. A single crate of flowers with
  // room for one on a shelf refused soda, tomatoes and coffee for a shop with
  // $91,000 in the till and a board sat at 0 of 24. The guard was written when
  // "is there stock on the floor I could shelve instead" and "have I got enough
  // of this" were the same sentence, and they stopped being the same sentence
  // the day the bay could hold a fortnight of different things at once.

  // Every pile in every box, not one kind per box. Read the old way, a crate
  // whose second pile is milk does not put milk in this set, so the shop buys
  // milk that is already standing at the bay — which is the very deadlock the
  // per-item version of this guard was written to fix, arriving again through
  // the container growing a second kind.
  const atTheBay = new Set(game.deliveries
    .flatMap((d) => lotStacks(d))
    .filter((s) => shelfFor(game, s.item_id, c))
    .map((s) => s.item_id));

  // Two ceilings, and the lower one wins. `SPEND_FRACTION` of what sits above
  // the float is the shop keeping itself solvent tick by tick; the daily cap is
  // the player saying how much of the day's money the staff may commit at all.
  // Neither replaces the other — a cap of $500 must still not spend the last
  // $20 in the till, and a rich shop must still stop at the cap.
  const budget = Math.min(
    (game.cash - CASH_FLOOR) * SPEND_FRACTION,
    game.orderBudgetLeft(),
  );
  if (budget <= 0) return false;

  // The order the shop asks for. `restockQueue` is the sim's rule, not this
  // job's: it is what the player set in the shelf menu, and a second copy of it
  // here is the one that would drift from what the menu promised.
  const busy = claimed(game, s);
  for (const target of game.restockQueue()) {
    // Somebody else is already ordering for this board, or walking to it with an
    // armful. `homeSupply` counts the pending order the moment it is placed, so
    // two hires in one tick already saw each other's — but they both got as far
    // as *choosing* the same shelf first, and a shelf kept for three things is
    // chosen by which of them is emptiest. Skipping it outright is a tick's work
    // spent on the next shelf instead of on a recount of this one.
    if (busy.has(key('shelf', target.id))) continue;
    // What it is set aside for beats what happens to be on it, which beats
    // picking for yourself. An assignment is the whole point of assigning — a
    // shelf reserved for milk is never restocked with anything else, even when
    // something else would sell better.
    // Which BOARD of this unit needs a van, and it is asked in the same order
    // the old single answer was: what it is kept for beats what happens to be on
    // it, which beats picking for yourself. With a list, "kept for" is several
    // answers and the emptiest of them wins — otherwise a shelf kept for three
    // things would order the first one over and over and the other two boards
    // would stay bare for ever.
    const kept = Array.isArray(target.assigned)
      ? target.assigned : (target.assigned ? [target.assigned] : []);
    const need = (id) => {
      const it = c.byId.items[id];
      return it ? game.shelfCapacity(target, it) - (game.shelfStack(target, id)?.qty ?? 0) : 0;
    };
    // How many of this to actually put on a van, which is the board's room less
    // everything that would reduce it: the shop's own supply (`homeSupply` —
    // crates, hands and beds) and whatever headroom the item's own rule leaves.
    //
    // This has to drive the *choice* as well as the amount. Sorting on `need`
    // would put the emptier board first and buy the thing already on its way in
    // — or the thing you capped, which would then be ordered, refused as zero,
    // and the shelf skipped with the other reservation never looked at.
    const buy = (id) => {
      const rule = game.itemRule(id);
      if (rule.auto === false) return 0;
      // Already stood at the bay waiting to be shelved. Ordering more of THIS
      // while a crate of it is on the floor is the thing the old shop-wide
      // guard was reaching for, said about the item it is actually about.
      if (atTheBay.has(id)) return 0;
      const supply = game.homeSupply(id);
      const room = Math.max(0, need(id) - supply);
      // `max` is about the whole shop, so it is measured against every board
      // plus what is already on its way in — not against this one unit.
      if (!(rule.max > 0)) return room;
      return Math.max(0, Math.min(room, rule.max - game.itemHeld(id) - supply));
    };
    // `pickItem` is the only one of the three that is the shop deciding what
    // your range should be, so it is the only one `assign` gates. Topping up a
    // board that already holds something is not a decision anybody has to
    // approve — you put it there.
    const item = kept.length
      ? c.byId.items[[...kept].sort((a, b) => buy(b) - buy(a))[0]]
      : (c.byId.items[game.shelfStacks(target)
        .slice().sort((a, b) => a.qty - b.qty)[0]?.item_id]
        ?? (game.orders.assign ? pickItem(game, target, c) : null));
    if (!item) continue;

    const unit = wholesalePrice(item, game.folded(), game.season);
    // Orders arrive as a pallet, so they aren't capped by what one pair of hands
    // can hold — the worker just makes more trips. Against the BOARD's room less
    // what the shop can already fill it with, or a van turns up with three times
    // what the shelf can take and the rest goes straight back out to a crate.
    //
    // Charged per board rather than against the shop's whole holding of the
    // item, which under-orders slightly when one crate could serve two shelves.
    // That is the safe direction: the next pass re-reads it once the crate has
    // landed, and the other way round is the bug this replaced.
    const qty = Math.min(buy(item.id), Math.floor(budget / Math.max(unit, 0.01)));
    if (qty <= 0) continue;

    if (!game.buyStock(s.id, item.id, qty).ok) continue;
    claim(s, 'shelf', target.id);
    s.cooldown = paceOf(s);
    return true;
  }
  return false;
}

/**
 * Pick up a pallet at the bay — but only one with somewhere legal to go, and
 * only one nobody else is already walking out to get.
 *
 * A bay stacked three deep is the clearest case for claims there is: the crates
 * are inches apart, every free hand picks the same one, and the two that lose
 * the race have walked the length of the shop to watch it disappear.
 */
function unload(game, s) {
  const c = content();
  const spoken = inbound(game, s);

  // Carrying a CRATE? Then there is exactly one thing to do with it, and it
  // outranks everything below — including choosing a better crate, which is a
  // decision made irrelevant by the box already being on your shoulder.
  //
  // The destination is recomputed rather than remembered. A stored target is a
  // second piece of state to keep in step with a shop that changes while you
  // walk across it — the shelf could fill, be reassigned or be sold back — and
  // the recomputation is a `shelfFor` this job already does. Self-correcting
  // beats remembered here for the same reason `errandAction` reads `actionAt`
  // on arrival rather than at the tap.
  if (s.haul) {
    // The first board nobody else is walking a crate to that will actually take
    // some of what is in this one.
    //
    // Two tests, and they are different questions. `shelvesFor` RANKS by what
    // would fit; `boardFor` is the real yes/no — a unit can rank as legal and
    // still be out of free boards for this particular thing, and a hire who
    // walks to one of those walks back and does it again. And the claim skip is
    // what stops three hires converging: a bare unit that holds twenty still
    // has room after a crate of twelve, so `shelvesFor` hands every one of them
    // the same best answer. Same rule `restock` uses on the same collision.
    // Any board that will take ANY pile in the box. A mixed crate has three
    // answers to "where does this go" and needs only one of them to be worth
    // the walk — `stockFromCrate` pours every pile the unit will have and keeps
    // the rest on the shoulder, so the next tick asks again about a smaller
    // box. Ranked on the biggest pile, because that is the one the trip is
    // mostly about and the ranking has to pick a single order.
    const taken = claimed(game, s);
    const piles = lotStacks(s.haul).sort((a, b) => b.qty - a.qty);
    const shelf = piles.flatMap((pile) => shelvesFor(game, pile.item_id, c, spoken)
      .filter((sh) => !taken.has(key('shelf', sh.id))
        && game.boardFor(sh, c.byId.items[pile.item_id]).ok))[0];

    // Nothing will have the rest, so it goes home to the pad.
    //
    // Putting it down on the spot was the first shape of this and it is exactly
    // what a shop full of abandoned boxes looks like: a stray with nowhere to go
    // is a stray nothing will lift, so it stands there for the rest of the game.
    // The pad terminates — goods leave the yard when there is room and come
    // back when there is not.
    if (!shelf) {
      const pad = game.dropPad();
      if (pad) {
        // A pad, not a crate: `home` is not a crate id, and parking a literal
        // in the crate namespace is one authored id away from marking a real
        // crate busy for everybody.
        claim(s, 'pad', 'home');
        if (!goTo(game, s, pad)) return true;
      }
      game.dropCrate(s.id);
      s.cooldown = paceOf(s);
      return true;
    }

    // ...otherwise carry it over and POUR IT IN. The crate never touches the
    // shop floor.
    //
    // Setting it down at the board and then unloading it by armfuls was the
    // first shape, and it is a person carrying twelve across the shop, putting
    // them on the ground, and picking six of them back up. Worse, every step of
    // that dance is a fresh job draw somebody else can win — so what you watch
    // is one hire drop a crate and wander off, a second take four out of it, and
    // a third carry it back to the yard. Three people, one crate, no chain.
    //
    // Whatever will not fit stays on the shoulder, and `stepStaff` sends the
    // same hire straight back here next tick. That is the chain: one person
    // lifts it, fills every board that will have it, and walks the remainder
    // home.
    claim(s, 'shelf', shelf.id);
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
    const res = game.stockFromCrate(s.id, shelf.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }
  // Carrying already? Then this is a TOP-UP and not a new errand. A crate holds
  // twice an armful, so a Stocker with big hands takes a crate and a half in
  // one trip instead of walking back for two units.
  //
  // It used to be "only ever more of the same thing", because mixed hands were
  // what `stockShelf` refused. Both halves of that are gone: hands hold
  // `LOT_KINDS` kinds and a shelf pours every pile that has a board, so a
  // top-up can now pick up the lettuce as well — which is the whole reason a
  // bay of small part-crates stopped being a walk each.
  const held = lotTotal(s.carry);
  if (held >= carryOf(s)) return false;

  // How much of this the shop can actually put away — see `Game.unload`'s `cap`.
  // Asked BEFORE the walk, so a crate nobody has room for is never lifted, and
  // asked of every legal shelf rather than of the best one, because a stocker
  // makes as many trips as it takes.
  //
  // Memoised per ITEM for the length of this call, because a bay is a pile of
  // crates of the same few things: twenty-six pallets of eggs is one question,
  // asked once, not twenty-six walks of the shop floor.
  const room = new Map();
  const roomFor = (id) => {
    if (!room.has(id)) room.set(id, roomAcross(game, id, c, spoken));
    return room.get(id);
  };

  /**
   * How much this trip actually moves: the shelves' room, this pair of hands,
   * and what is in the crate, whichever runs out first.
   *
   * Summed over the PILES now, and bounded by both of the hands' caps rather
   * than one. The units cap was always here; the kinds cap is what a mixed
   * container added, and leaving it out is not a small error — a box of five
   * kinds would score as a full armful, the hire would walk the shop for it,
   * and `Game.unload` would hand them three. What you would watch is a stocker
   * making the right trip and arriving with the wrong amount, for ever.
   */
  const hands = carryOf(s);
  const { kinds } = game.carryLot(s);
  const fit = (d) => {
    let moves = 0;
    let slots = kinds - lotStacks(s.carry).length;
    for (const pile of lotStacks(d).sort((a, b) => b.qty - a.qty)) {
      if (held + moves >= hands) break;
      const mine = lotQty(s.carry, pile.item_id);
      if (!mine && slots <= 0) continue;
      // The shelves' room for this kind, less what is already in these hands
      // heading there — the same subtraction the single-kind version made, said
      // per pile.
      const take = Math.min(pile.qty, roomFor(pile.item_id).room - mine, hands - held - moves);
      if (take <= 0) continue;
      if (!mine) slots -= 1;
      moves += take;
    }
    return moves;
  };

  const busy = claimed(game, s);
  // The BIGGEST trip, not the first one that qualifies. `find` took whichever
  // crate was oldest on the pad, and a bay is stacked in the order things
  // arrived — so a shop with eggs at the bottom of the pile serviced eggs, over
  // and over, while a full crate of bread sat behind them all day.
  let pallet = null;
  // `best` ranks (it carries the stray bonus); `bestMoves` is the number the
  // unload is actually capped at. They were one variable, and folding a
  // priority into a quantity would hand `Game.unload` a cap of a million.
  let best = 0;
  let bestMoves = 0;
  let fallback = null;
  let fallbackBest = 0;
  let fallbackMoves = 0;
  for (const d of game.deliveries) {
    // No "same item only" filter any more, and it is not needed: `fit` already
    // scores a box your hands have no room for at zero, whether that is out of
    // units or out of kinds. The filter was the single-kind spelling of a
    // question `fit` now answers properly, and keeping it would hide every
    // mixed box behind whatever a hire happened to be holding.
    if (busy.has(key('crate', d.id))) continue;
    const moves = fit(d);
    if (moves < 1) continue;
    // Not worth the walk — *while there is something better to do*. A customer
    // buying two eggs off a full board opens room for exactly two, and sending
    // somebody to the bay for them is a trip across the shop for an armful you
    // can count. A board that is genuinely BARE is always worth it: a small load
    // into an empty freezer is the shop having milk again.
    //
    // But it is a PREFERENCE and never a veto, and that cost a live shop a day
    // to learn. As a veto it stranded a crate of flowers that only three shelves
    // had room for — under half an armful, so nobody would ever lift it — and a
    // crate nobody lifts sits on the pad for ever. Which would have been merely
    // untidy, except `restock` reads the bay: one unliftable crate stopped the
    // shop ordering anything at all, with the till full and boards sat empty.
    // A rule about what is WORTH doing must never be able to say "do nothing".
    // A crate that is NOT on a pad is work half done, and it wins over a bigger
    // trip in the yard.
    //
    // Without this the floor fills up, and the reason is not obvious: a hire
    // hauls a crate to a shelf, sets it down, and then the next tick re-asks
    // "which crate is the biggest trip" — which is usually one back at the bay,
    // because that is where full crates are. So they walk off and the aisle
    // crate is never chosen again until the bay runs dry. What you see is
    // somebody dropping boxes around the shop, which reads as a pathing bug.
    //
    // Scored rather than filtered, so a stray never stops a bay crate being
    // taken when there is genuinely nothing to do with the stray.
    const stray = onAPad(game, d) ? 0 : 1;
    const score = stray * 1e6 + moves;
    // `bare` of ANY pile in it. The escape hatch exists so a small trip is
    // never refused when a board is genuinely empty, and a mixed box holding
    // two of something plentiful beside four of something the shop has none of
    // is exactly that case — asking it of one kind would put the small trip
    // back behind the `MIN_TRIP` preference and leave the empty board bare.
    const anyBare = lotStacks(d).some((k) => bare(roomFor(k.item_id)));
    if (moves >= MIN_TRIP * hands || anyBare || stray) {
      if (score > best) { best = score; pallet = d; bestMoves = moves; }
    } else if (score > fallbackBest) { fallbackBest = score; fallback = d; fallbackMoves = moves; }
  }
  if (!pallet && fallback) { pallet = fallback; bestMoves = fallbackMoves; }

  // Nothing worth an armful anywhere — so take a stray home instead.
  //
  // This is the case the loop above cannot see, and it is the one that leaves a
  // shop looking abandoned. `fit` skips any crate with no room for even one
  // unit, so a stray full of something every board is now full of is not a
  // candidate for anything: not an armful, and not a haul to a shelf, because
  // there is no shelf. It simply stands in the aisle for the rest of the game.
  //
  // Cannot loop against the haul-to-shelf branch below, and that is structural
  // rather than lucky: that one needs room for the WHOLE crate, this one needs
  // room for none of it. A crate cannot satisfy both, so a box can never be
  // carried out and back.
  if (!pallet && !s.carry) {
    const home = game.deliveries.find((d) => !onAPad(game, d)
      && !busy.has(key('crate', d.id))
      && game.crateOnTop(d));
    if (home && game.dropPad()) {
      claim(s, 'crate', home.id);
      if (!goTo(game, s, home, 1.4)) return true;
      const got = game.liftCrate(s.id, home.id);
      s.cooldown = got.ok ? paceOf(s) : 1;
      return true;
    }
  }
  if (!pallet) return false;
  best = bestMoves;
  claim(s, 'crate', pallet.id);

  // Take the whole box instead of an armful out of it, when that is strictly
  // fewer journeys. Three conditions, and each one is load-bearing:
  //
  //   empty-handed  — you cannot shoulder a crate while holding stock, which is
  //                   `liftCrate`'s own rule and is why this sits after the
  //                   top-up branch rather than in front of it.
  //   on a pad      — a crate in an aisle is one somebody already hauled there,
  //                   and without this a worker would carry it back and forth
  //                   between two shelves for ever. Haulage runs one way, out
  //                   of the yard, and that is what makes it terminate.
  //   room for ALL  — the shop can absorb the entire crate. Hauling half a
  //                   crate to a shelf strands the remainder in the aisle, and
  //                   a part crate off a pad is exactly what `fillHands` and the
  //                   armful path are already good at.
  //
  // `pallet.qty > hands` is the whole point: at or under an armful the trip is
  // identical and the box is pure ceremony.
  const wholeCrate = !s.carry
    && lotTotal(pallet) > hands
    // The shop must want MORE than one armful of it. Under that, carrying the
    // box is strictly worse than carrying the goods: same journey, and you
    // arrive with your hands full of crate and a remainder to walk home. The
    // crate is only worth lifting when it saves a second trip.
    //
    // It replaced "room for the whole crate", which was too strict in the one
    // direction that matters — a shelf with room for eight of a twelve refused
    // the haul, so the hire made two armful trips for what one carry does — and
    // the remainder is no longer a problem worth guarding against, because
    // `stockFromCrate` keeps it on the shoulder and the same hire walks it to
    // the next board or home.
    //
    // Summed across the piles, because a mixed box is worth shouldering when
    // the shop wants more than an armful of it ALTOGETHER. Asked of one kind, a
    // box of four things the shop wants three of each of would never be lifted
    // — twelve units of wanted stock making twelve one-armful trips, which is
    // the shape mixing was meant to end.
    && lotStacks(pallet).reduce((n, k) => n + Math.min(k.qty, roomFor(k.item_id).room), 0) > hands
    && onAPad(game, pallet)
    // ...and it has to be the one on TOP. `liftCrate` refuses a buried crate,
    // and a refusal here is not a no-op: the hire keeps choosing the same crate
    // every tick, walks to it, is told no, and starts again. On a bay stacked
    // three deep that is the whole shift, and what you watch is staff wandering
    // the shop doing nothing at all — the most expensive shape a bug can take,
    // because every job LOOKS like it is being attempted.
    && game.crateOnTop(pallet);
  if (wholeCrate) {
    if (!goTo(game, s, pallet, 1.4)) return true;
    const res = game.liftCrate(s.id, pallet.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }

  if (!goTo(game, s, pallet, 1.4)) return true;
  const res = game.unload(s.id, pallet.id, best);
  if (res.ok) fillHands(game, s, pallet);
  s.cooldown = res.ok ? paceOf(s) : 1;
  return true;
}

/**
 * Is this crate standing in the yard, rather than somewhere somebody put it?
 *
 * Both pads, because both are places crates legitimately live and neither is
 * somewhere a worker would have carried one *to*. It is the termination
 * argument for hauling: goods move out of the yard and into the shop, so a
 * crate that has left the pad is never lifted again and no pair of shelves can
 * pass one back and forth.
 */
function onAPad(game, d) {
  const L = game.layout;
  return isPadAt(L, 'bay', Math.round(d.x), Math.round(d.z))
    || isPadAt(L, 'drop', Math.round(d.x), Math.round(d.z));
}

/**
 * Having lifted one crate, take from the ones you are already stood next to.
 *
 * A crate holds an armful and hands hold an armful, so a *part* crate — four
 * lettuce, four eggs, whatever a board had room for last time — sends a worker
 * off half full. They then walked it across the shop, put it away, and came
 * back for the other four: two trips, and the second one entirely avoidable
 * because the rest was sitting a tile away the whole time.
 *
 * It has to happen HERE rather than as a second go at the job, and that is the
 * point worth remembering. Coming round again means another weighted draw, and
 * `shelve` fires on a worker with anything in their hands — so whether they
 * topped up or walked off half full was decided by a dice roll. The file's rule
 * that no job may rely on running before another is what makes this the fix:
 * one *action* fills the hands, so no ordering is being relied on at all.
 *
 * Only what is in reach, and only the same item, which is what keeps it honest —
 * this is a worker turning round where they stand, not a second errand. Reach is
 * not re-tested here: `Game.unload` already refuses a pallet you are not stood
 * next to, and a second copy of that distance in this file is the one that would
 * quietly drift from the one the game actually enforces.
 */
function fillHands(game, s, from) {
  const c = content();
  const spoken = inbound(game, s);
  const hands = carryOf(s);
  // Room across the shop for each kind these hands are now holding — the same
  // question the single-kind version asked, asked per pile. Memoised, because a
  // bay is a pile of crates of the same few things.
  const room = new Map();
  const roomFor = (id) => {
    if (!room.has(id)) room.set(id, roomAcross(game, id, c, spoken).room);
    return room.get(id);
  };
  for (const d of game.deliveries.slice()) {
    if (d.id === from.id) continue;
    if (lotTotal(s.carry) >= hands) return;
    // Only more of what is ALREADY in these hands, which is what keeps this a
    // turn on the spot rather than a second errand. It also keeps it out of the
    // kinds cap entirely: topping up a pile you are holding can never need a
    // free hand, so a sweep here can never take a slot the walk was counting on.
    for (const pile of lotStacks(d)) {
      if (!lotHas(s.carry, pile.item_id)) continue;
      const want = Math.min(hands, roomFor(pile.item_id)) - lotQty(s.carry, pile.item_id);
      if (want <= 0) continue;
      game.unload(s.id, d.id, want, pile.item_id);
    }
  }
}

/**
 * How little of an armful is still worth walking to the bay for.
 *
 * Half. The number is a judgement rather than a measurement, and what it is
 * really defending is the *look* of the shop: a worker who crosses the floor for
 * two of something reads as a worker with nothing to do, whatever it does to the
 * takings. `bare` is the escape hatch, so the rule can never make a hire ignore
 * an empty shelf.
 */
const MIN_TRIP = 0.5;

/** Is this item's shelf space mostly EMPTY, rather than just missing a couple? */
const bare = ({ room, cap }) => cap > 0 && room / cap >= 0.5;


/**
 * Put what's in hand onto a shelf that will take it.
 *
 * Not the shelf somebody else is already filling. Two stockers who unloaded the
 * same delivery hold the same item, so they scored the same shelf best and both
 * walked to it — and `shelfFor` is a *ranking*, so the second one had a perfectly
 * good second choice it was never asked for. Skipping the claimed one fills two
 * boards in the time it used to take to fill one.
 */
function shelve(game, s) {
  if (!s.carry) return false;
  // Mid-errand for `merchandise`, which is two legs with a full pair of hands
  // in between — pull the board, then walk it somewhere. Without this the
  // worker puts it straight back on the unit they just took it off, whose board
  // is free again the moment they lift it. It is an errand in flight rather
  // than a latch: `p.errand` is the same idea for a player, and hires cannot
  // use that one because `stepActions` opens with `if (p.staff) continue`.
  if (s.shifting) return false;
  // The first unit that will take ANY pile in these hands. `stockShelf` pours
  // every pile that unit has a board for, so one walk can empty three kinds —
  // and asking about only one of them would send a hire to `tidy` while holding
  // something a shelf ten feet away was waiting for.
  const c = content();
  const spoken = inbound(game, s);
  const shelf = lotStacks(s.carry).sort((a, b) => b.qty - a.qty)
    .map((k) => shelfFor(game, k.item_id, c, spoken))
    .find(Boolean);
  if (!shelf) return false;                        // `tidy` deals with that
  claim(s, 'shelf', shelf.id);
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
 * The shop hand: take goods back OFF a shelf.
 *
 * Every other job in this file points one way — `shelve` puts down what is in
 * hand, `tidy` crates what has nowhere to go — so stock only ever left a board
 * by being bought, spoiling, or your own hands. Which is fine for anything that
 * sells and exactly wrong for anything that doesn't: a board that stops selling
 * held its board for the rest of the save, and boards are what the shop spends
 * to carry range (see `Game.staleBoards`).
 *
 * Two verbs, and **both of them strictly reduce the number of occupied
 * boards.** That is not tidiness about the code, it is what makes the job
 * safe:
 *
 *   Clear — a board dead for `STALE_BOARD_DAYS` goes back to the drop-off.
 *   Merge — one item split across two units is walked onto the better one.
 *
 * The obvious third verb — spread a deep board across two units so shoppers
 * walk less — is deliberately absent, and would be a bug rather than a feature.
 * Clear and Merge free boards; spread takes them. Put all three in one job and
 * the hire oscillates at tick rate: merge two boards into one, notice a unit is
 * now bare, spread back into it, for ever. Every fix for that is a latch, and
 * this file has retired two of those already (`stowLock`, `tookFrom`) by
 * changing the design rather than by finding a better latch. A job whose verbs
 * all point the same way cannot oscillate and needs none.
 *
 * ("Should this be on two shelves" is a real question and it is a *range*
 * decision, which the shop already answers in two places — `pickItem` behind
 * `orders.assign`, and your own tick in the shelf menu. A worker making it a
 * third way would be making it with no switch on it.)
 *
 * Clear outranks Merge because a dead board costs the shop a kind it can sell
 * and a split board only costs it a board.
 */
function merchandise(game, s) {
  // Leg two of an errand already begun. `s.shifting` is `{ to }` — a shelf id,
  // or null for the drop-off — and it is checked before the hands, because a
  // worker mid-errand is exactly a worker holding something.
  if (s.shifting) {
    if (!s.carry) { s.shifting = null; return false; }
    return deliver(game, s);
  }
  if (s.carry) return false;

  const c = content();
  const busy = claimed(game, s);

  // Clear. `staleBoards` is the shop's rule, not this job's — see the note on
  // `restockQueue` for why that split is worth keeping.
  for (const { shelf, stack, days } of game.staleBoards()) {
    if (busy.has(key('shelf', shelf.id))) continue;
    claim(s, 'shelf', shelf.id);
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
    const res = game.unshelve(s.id, shelf.id, stack.item_id);
    if (!res.ok) { s.cooldown = 1; return true; }
    // Marked on the FIRST armful rather than when the board finally empties: a
    // board of twenty against hands of six is four trips, and for the three in
    // between the item is on a shelf with room on it, which is all `shelve` and
    // `unload` ever ask.
    game.giveUpBoard(shelf, stack.item_id, days);
    if (res.left <= 0) game.clearStack(shelf, stack.item_id);
    s.shifting = { to: null };
    s.cooldown = paceOf(s);
    return true;
  }

  // Merge. Not `staleBoards`' shape, because this one is about who walks where
  // rather than about what the shop wants — the same reason `shelvesFor` lives
  // here and `restockQueue` doesn't.
  const hands = carryOf(s);
  for (const shelf of game.layout.shelves) {
    if (busy.has(key('shelf', shelf.id))) continue;
    // The unit's own switch. Asked of the SOURCE here and of the target below,
    // because "leave that shelf alone" has to mean both — a locked unit that
    // still had stock walked onto it is a unit the hand is rearranging.
    if (!game.handMayTouch(shelf)) continue;
    const kept = Array.isArray(shelf.assigned) ? shelf.assigned : (shelf.assigned ? [shelf.assigned] : []);
    for (const stack of game.shelfStacks(shelf)) {
      // Set aside for it is the veto, the same one `staleBoards` honours: a
      // decision the shop quietly undoes is not a decision.
      if (kept.includes(stack.item_id)) continue;
      // One trip or it isn't worth starting. A board bigger than a pair of
      // hands would be walked across the shop in instalments, and half a board
      // in each of two places is the state this exists to get rid of.
      if (!(stack.qty > 0) || stack.qty > hands) continue;
      // Where it would go if it weren't here. `shelvesFor` already ranks
      // reserved-for-it above already-holding-it above priority, so the head of
      // the list IS "the better unit" — asking any other way is a second
      // opinion that would drift from the one `shelve` works to.
      const better = shelvesFor(game, stack.item_id, c, inbound(game, s))
        .find((sh) => sh.id !== shelf.id && !!game.shelfStack(sh, stack.item_id)
          && !busy.has(key('shelf', sh.id)) && game.handMayTouch(sh));
      if (!better) continue;
      if (game.shelfCapacity(better, c.byId.items[stack.item_id]) === 0) continue;
      // Both ends claimed before the first step. Claiming only the source is how
      // two hires end up visibly undoing each other — one filling the board the
      // other is emptying.
      claim(s, 'shelf', shelf.id);
      if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
      const res = game.unshelve(s.id, shelf.id, stack.item_id);
      if (!res.ok) { s.cooldown = 1; return true; }
      if (res.left <= 0) game.clearStack(shelf, stack.item_id);
      s.shifting = { to: better.id };
      s.cooldown = paceOf(s);
      return true;
    }
  }
  return false;
}

/**
 * Walk what was just pulled off a board to wherever it was going.
 *
 * The target is re-tested on arrival rather than trusted, because the shop
 * moves during the walk: the better shelf can fill up, spoil or be sold back on
 * the way over. Failing that, the errand ends and the goods become an ordinary
 * pair of full hands — `shelve` will find them somewhere, `tidy` will crate
 * them, and either is a wasted trip rather than a stuck worker. What is not
 * acceptable is asserting it cannot happen.
 */
function deliver(game, s) {
  const to = s.shifting.to;
  if (to === null) {
    putDown(game, s);
    if (!s.carry) s.shifting = null;
    return true;
  }
  const shelf = game.layout.shelves.find((sh) => sh.id === to);
  if (!shelf) { s.shifting = null; return false; }
  claim(s, 'shelf', shelf.id);
  if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
  const res = game.stockShelf(s.id, shelf.id);
  // Full, sold back, reserved for something else while we walked. Hand it to
  // the rest of the job list rather than carrying it back.
  s.shifting = null;
  s.cooldown = res.ok ? paceOf(s) : 1;
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
  const busy = claimed(game, s);
  const rough = game.layout.plots.find((p) => !p.crop_id && p.soil !== 'tilled'
    && !busy.has(key('plot', p.id)));
  if (!rough) return false;
  // Don't break ground the shop can't afford to sow — an all-tilled, all-empty
  // field is worse than an untouched one.
  if (!pickCrop(game, content())) return false;
  claim(s, 'plot', rough.id);
  if (!goTo(game, s, rough)) return true;
  game.till(s.id, rough.id);
  s.cooldown = paceOf(s);
  return true;
}

/** Put seed in a bed that's already been turned. */
function sow(game, s) {
  if (s.carry) return false;
  const busy = claimed(game, s);
  const bed = game.layout.plots.find((p) => !p.crop_id && p.soil === 'tilled'
    && !busy.has(key('plot', p.id)));
  if (!bed) return false;
  const crop = pickCrop(game, content());
  if (!crop) return false;
  claim(s, 'plot', bed.id);
  if (!goTo(game, s, bed)) return true;
  game.plant(s.id, bed.id, crop.id);
  s.cooldown = paceOf(s);
  return true;
}

/**
 * Pick anything ripe the shop has somewhere to put.
 *
 * The farm's half of the endless-goods bug, and the more surprising half
 * because nothing here loops: a bed is picked once. What loops is auto-replant
 * — picking is what frees the bed to grow the next lot — so a field with every
 * board committed was harvested, crated at the drop-off by `tidy`, replanted
 * and harvested again, for ever. The pile is the farm's whole output with
 * nowhere else to be.
 *
 * `hasSomewhere` rather than `hasHome` on purpose, and the difference is worth
 * a measurement rather than an argument: gating this the way the kitchen is
 * gated cost 9.3% of mean profit over ten seeds. The pad is the buffer, and the
 * bed is the overflow behind it.
 *
 * A ripe crop keeps in the ground indefinitely — nothing decays a `ready` plot
 * — so waiting costs the shop nothing but the bed, which is the right price for
 * having nowhere to put what is in it. It reads in play as a farm waiting on
 * you rather than a farm burying you.
 */
function harvest(game, s) {
  if (s.carry) return false;
  const c = content();
  const spoken = inbound(game, s);
  const busy = claimed(game, s);
  const ripe = game.layout.plots.find((p) => p.ready && !busy.has(key('plot', p.id))
    && hasSomewhere(game, c.byId.crops[p.crop_id]?.item_id, c, spoken));
  if (!ripe) return false;
  claim(s, 'plot', ripe.id);
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
  // The claim is on the MACHINE in all three phases below, including the one
  // that walks to a shelf — the errand is "serve this appliance", and the shelf
  // is a stop on the way. Claiming the shelf instead would let a second chef
  // take the same station while the first was out fetching for it, which is the
  // duplicate this exists to stop; two chefs at one shelf for two different
  // ingredients is not.
  const busy = claimed(game, s);
  const stations = (game.layout.stations ?? []).filter((st) => !busy.has(key('station', st.id)));
  if (!stations.length) return false;

  // Holding an ingredient something wants? Tip it in. Holding anything else is
  // `shelve`'s problem, not this one's — and so is an armful nothing has ROOM
  // for, which is the same sentence now that a hopper can fill up. Asking only
  // "does anything want this" walked a chef to a full machine, loaded nothing,
  // and sent them back to do it again, forever.
  if (s.carry) {
    // Any pile in these hands that a machine wants and has room for.
    // `loadStation` tips in every ingredient the recipe uses, so a chef holding
    // tomatoes, stock and basil serves a soup in one walk — which is the whole
    // reason a hopper with three inputs stopped filling at a third speed.
    const needing = stations.find((st) => lotStacks(s.carry).some((k) => wants(game, st).has(k.item_id)
      && game.stationHopperRoom(st, k.item_id) > 0));
    if (!needing) return false;
    claim(s, 'station', needing.id);
    if (!goTo(game, s, needing.useAt)) return true;
    const res = game.loadStation(s.id, needing.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }

  // Something finished? Get it out — IF there is anywhere to put it.
  //
  // Collecting unconditionally is a round trip to the drop-off. Crafted goods
  // are never `assigned` to anything, so the moment every board in the shop is
  // committed `shelfFor` answers null, `shelve` declines, and `tidy` crates the
  // batch out at the pad to free the hands holding it — a chef walking a tray
  // of salsa to the yard and a stocker walking it back. The tray is a perfectly
  // good place for it to wait, and it is already next to the thing that made it.
  //
  // This used to make an exception for a tray so full it had stopped the
  // machine, on the argument that an idle kitchen is worse than a trip to the
  // yard. That argument is wrong, and it is the whole of the endless-goods bug:
  // emptying the tray onto the floor is what lets the machine start again, so a
  // shop with no room for salsa made salsa for ever, one crate at a time, and
  // the pile at the drop-off was the only thing that grew. Since `hungry` below
  // now declines to feed a machine with nowhere to send the result, a stopped
  // machine is the intended end state rather than a deadlock to break — and the
  // batch waits on the tray, where it is one action from a shelf the moment one
  // frees up, instead of in a crate somebody has to fetch back.
  const c = content();
  const spoken = inbound(game, s);
  const done = stations.filter((st) => st.output)
    .sort((a, b) => b.output.qty - a.output.qty)
    .find((st) => shelfFor(game, st.output.item_id, c, spoken));
  if (done) {
    claim(s, 'station', done.id);
    if (!goTo(game, s, done.useAt)) return true;
    game.collectStation(s.id, done.id);
    s.cooldown = paceOf(s);
    return true;
  }

  // Otherwise fetch what an appliance is short of. Least-loaded first, so one
  // machine doesn't hog the worker.
  //
  // Not "idle" any more: a machine that is MAKING something is exactly the one
  // worth topping up, because the walk and the batch then overlap instead of
  // taking turns. Only a machine with nowhere to put the result is skipped.
  const hungry = stations
    .filter((st) => {
      // Room for what it is SET to make. Asked of every recipe it knew, a
      // machine with a tray full of salsa still read as hungry because there
      // was room for a smoothie — so the chef kept fetching for a batch that
      // could never start.
      const r = game.stationRecipe(st);
      if (!r || game.stationOutputRoom(st, r) < r.output_qty) return false;
      // …and room in the SHOP for what comes out of it. Room on the tray only
      // says the machine can physically start; it says nothing about whether
      // anybody wants what it makes, and a tray is emptied by the job above.
      return hasHome(game, r.output_id, c, spoken);
    })
    .sort((a, b) => total(a.contents) - total(b.contents));

  for (const st of hungry) {
    const recipe = feasibleRecipe(game, st);
    if (!recipe) continue;
    for (const input of recipe.inputs) {
      // Back of house first, shop floor second. Stripping a shelf customers
      // are still buying from is the behaviour the kitchen exists to stop —
      // and it stays as the FALLBACK rather than being forbidden, because a
      // shop with no kitchen yet must still be able to make things.
      const stocked = game.layout.shelves
        .map((sh) => ({ sh, stack: game.shelfStack(sh, input.item_id) }))
        .filter(({ stack }) => (stack?.qty ?? 0) > 0);
      const from = stocked.find(({ sh }) => sh.boh) ?? stocked[0];
      // Nothing on any shelf? Then take it off the CRATE it arrived in.
      //
      // A chef only ever looked at shelving, and that is fine right up until an
      // ingredient has nowhere in the shop to live. Oven chips need a freezer;
      // a shop whose freezer boards are all spoken for can order them, pay for
      // them and watch them land at the bay, and no shelf will take them — so
      // `unload` leaves them, the chef never looks, and four crates sit on the
      // pad for ever while the fryer stands empty two tiles away. The tell is
      // exactly backwards: it reads as an ordering problem, and it is a
      // fetching one.
      //
      // Shelves still come first. A crate is where goods are before anybody has
      // put them away, and preferring it would have a chef intercepting the
      // delivery every stocker is trying to unload.
      if (!from) {
        const crate = game.deliveries.find((d) => lotQty(d, input.item_id) > 0
          && !busy.has(key('crate', d.id)));
        if (!crate) continue;
        if ((st.contents[input.item_id] ?? 0) >= game.stationHopperCap(st, input.item_id)) continue;
        claim(s, 'crate', crate.id);
        if (!goTo(game, s, crate, 1.4)) return true;
        const want = Math.min(game.stationHopperRoom(st, input.item_id), carryOf(s));
        // NAMED, and that is not optional now a crate can be mixed. Unnamed,
        // `unload` sweeps every pile in the box — so a chef sent for tomatoes
        // comes back with tomatoes, soap and cut flowers, fills the hopper with
        // the one the machine wants and then has to go and put the rest
        // somewhere. It looks like a chef doing two jobs badly.
        const res = game.unload(s.id, crate.id, want, input.item_id);
        s.cooldown = res.ok ? paceOf(s) : 1;
        return true;
      }
      const { sh: shelf, stack } = from;
      // Fill the hopper out of the stockroom; only borrow one batch off the
      // shop floor. Which shelf it came off decides how much, so where you put
      // your stockroom is what makes the kitchen run — and a shop with no back
      // of house still works, one batch at a time, exactly as it did before.
      const target = shelf.boh
        ? game.stationHopperCap(st, input.item_id)
        : input.qty;
      const short = target - (st.contents[input.item_id] ?? 0);
      if (short <= 0) continue;
      claim(s, 'station', st.id);
      if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
      // Off that BOARD, so fetching the cheese never quietly eats the milk
      // standing beside it.
      const take = Math.min(short, stack.qty, carryOf(s));
      stack.qty -= take;
      s.carry = { item_id: input.item_id, qty: take };
      s.cooldown = paceOf(s);
      return true;
    }
  }
  return false;
}

/** The vocabulary, and the only thing an authored job name is checked against. */
const JOBS = { serve, restock, unload, shelve, tidy, merchandise, till, sow, harvest, craft };

const total = (contents) => Object.values(contents ?? {}).reduce((a, b) => a + b, 0);

/**
 * A shelf that will legally accept this item.
 *
 * `restock`, `unload` and `shelve` all rest on this, so losing it costs you
 * every job that touches a shelf at once — and `stepStaff` swallows a throw per
 * job, so it costs them silently. See the note on that catch.
 *
 * `spoken` is what is already walking towards each shelf — see `inbound`. It is
 * read as HEADROOM rather than as a lock, which is the whole difference between
 * a shelf and every other target a hire can claim: a shelf with room for twelve
 * takes two armfuls of six, so the second stocker is only in the way once the
 * first one's armful actually fills it. Optional, and left off deliberately by
 * the two callers asking a different question — `unload` and `restock` want to
 * know whether the shop has anywhere to put this at all, which is about the
 * shelves rather than about who is walking where.
 *
 * Exported for `verify-build`, which is the only caller outside this file. It
 * is a second implementation of "where may this go" alongside `shelfAccepts`,
 * and the two disagreeing is invisible from any screenshot: a shelf you set
 * aside would simply get filled with something else by somebody you employ.
 */
export function shelfFor(game, itemId, c, spoken = null) {
  return shelvesFor(game, itemId, c, spoken)[0] ?? null;
}

/**
 * Is there anywhere in the shop for another lot of this to GO?
 *
 * The test the two jobs that *produce* goods ask before producing, and the one
 * neither of them had. `restock` has always asked it — it is `atTheBay` plus
 * `homeSupply`, the whole subject of docs/ordering.md — and the shop's own two
 * sources of stock were exempt, so "the shop stops buying what it already has"
 * sat next to a kitchen and a farm that did not.
 *
 * Two questions, in the order that makes them cheap:
 *
 * - **Is a crate of it already standing at the drop-off?** Then the answer is
 *   shelve that, not make another. This is `restock`'s `atTheBay` guard said
 *   about the things you produce rather than the things you buy, and it is what
 *   stops a chef and a stocker taking turns building a pile.
 * - **Will any board take it?** `shelfFor` is the whole of "has the shop got
 *   room", including the reservations — a crafted good is never `assigned` to
 *   anything, so a shop whose every board is spoken for genuinely has nowhere
 *   to sell it from and the honest answer is to stop.
 *
 * Deliberately NOT a `homeSupply` call, though it is the same family. That
 * counts a growing bed as supply, which is exactly right for deciding whether
 * to send a van and exactly wrong here: the farm counting its own beds against
 * itself is a field that refuses to be picked because it is planted.
 */
function hasHome(game, itemId, c, spoken = null) {
  if (!itemId) return false;
  if (game.deliveries.some((d) => lotQty(d, itemId) > 0)) return false;
  return !!shelfFor(game, itemId, c, spoken);
}

/**
 * The looser test, for the job that produces something it did not pay for.
 *
 * Buying and picking are not the same decision and gating them the same way
 * costs real money — measured at −9.3% mean profit over ten seeds, two of them
 * down a third. The asymmetry is where the goods came from. A crate of bought
 * stock with nowhere to go is money already spent on something the shop did not
 * need, so `hasHome` is right to stop it. A crate of your own eggs cost
 * nothing, and the crate is a *buffer*: a stocker shelves it the moment a board
 * frees and the bed is back in production behind it. Holding the farm off until
 * a shelf is free serialises the whole thing — one bed's worth in flight at a
 * time — and what you lose is the farm.
 *
 * So the farm fills the drop-off and stops when the drop-off is full, which is
 * `bayRoom`'s promise said about the pad instead of the bay. The bound is one
 * you painted and can repaint, rather than a number in here.
 */
function hasSomewhere(game, itemId, c, spoken = null) {
  if (!itemId) return false;
  return !!shelfFor(game, itemId, c, spoken) || game.padRoom() > 0;
}

/**
 * Every shelf that will take this item, best first — the list `shelfFor` takes
 * the head of, and the one `roomAcross` adds up.
 *
 * ONE pass. Its first shape asked `shelfFor` for a shelf, struck it off and
 * asked again, which reads fine and is quadratic — and it sat inside a `find`
 * over every pallet on the bay, for every worker, ten times a second. On a shop
 * with a full yard that is a few hundred thousand shelf tests a second and the
 * server simply stops answering. The lesson is not "be careful with loops": it
 * is that anything called from `stepStaff` runs at tick rate times the roster,
 * and a helper that walks the shop is only ever allowed to walk it once.
 */
function shelvesFor(game, itemId, c, spoken = null) {
  const item = c.byId.items[itemId];
  if (!item) return [];
  // Which kind of unit this belongs on — its own answer, not a guess made from
  // the department it is filed under. This read `needs-freezer || frozen`, and
  // the second half was doing nothing: every item tagged `frozen` in the game
  // also asks for a freezer, because the tag that MEANS something is the
  // behaviour one. Left in with a third kind in the world it would have been
  // worse than nothing — `frozen` is a category and there is no `hot` category
  // to pair it with, so hot goods would have had no such shortcut and the two
  // halves of one rule would have been written to different standards.
  const home = homeKind(item);
  const kept = (sh) => (Array.isArray(sh.assigned) ? sh.assigned : (sh.assigned ? [sh.assigned] : []));
  // The shop hand gave up on this one, so staff stop finding it shelves —
  // otherwise Clear is a loop that changes nothing: the crate it made is a
  // pallet like any other, `unload` sees a board with room and `shelve` puts
  // the same goods back where they came from, inside a minute. Your own hands
  // are unaffected (`stockShelf` never reads it) and a reservation lifts it
  // outright (`assignShelf`) — the shop giving up is a judgement about its own
  // range, which is the line `orders.assign` already draws.
  if (game.droppedItem(itemId)) return [];
  const usable = game.layout.shelves.filter((sh) => {
    if (shelfKind(sh.kind) !== home) return false;
    // Set aside for something else is a no even when it's bare — otherwise a
    // stocker with an armful fills the shelf you reserved and the reservation
    // only means anything until the next delivery lands. A LIST of reservations
    // binds exactly the same way: the things you ticked, and nothing else.
    const want = kept(sh);
    if (want.length && !want.includes(itemId)) return false;
    // A board of its own, or a board already holding this. Two questions now,
    // because a unit can be out of BOARDS while every board on it has room.
    if (!game.shelfHasRoomFor(sh, itemId)) return false;
    // Ask the shelf how much it holds rather than assuming a stack fits it.
    // `item.stack` is what fits a *standard* unit; an upgraded one holds
    // stack x capacity_mult, and a shared one holds its share of that. Testing
    // against the stack meant staff filled a tier-2 shelf to 8 of 12, walked the
    // rest out to the bay and crated it — so the capacity you paid for was only
    // ever reachable by hand.
    // Whatever somebody else is already carrying over lands before this does.
    // A different item claims the free board outright — there is nothing left to
    // share — and the same item is simply less room.
    const coming = spoken?.get(key('shelf', sh.id)) ?? null;
    if (coming && coming.item_id !== itemId) return false;
    const here = (game.shelfStack(sh, itemId)?.qty ?? 0) + (coming?.qty ?? 0);
    return here < game.shelfCapacity(sh, item);
  });
  // A shelf set aside for it first, then one already holding it, then whatever
  // the player marked to fill first. Topping up beats claiming a bare board,
  // and being asked for beats both.
  return usable.sort((a, b) => (kept(b).includes(itemId) - kept(a).includes(itemId))
    || (!!game.shelfStack(b, itemId) - !!game.shelfStack(a, itemId))
    || (b.priority ?? 0) - (a.priority ?? 0));
}

/**
 * Every legal board's worth of room for this item, added up.
 *
 * The bound on what is worth picking up. `shelfFor` answers "the best one shelf"
 * and that was the wrong question at the bay: a worker holding six needs six
 * slots *somewhere*, not six on the winner, and asking the winner meant lifting
 * a full crate against room for one.
 */
function roomAcross(game, itemId, c, spoken = null) {
  const item = c.byId.items[itemId];
  if (!item) return { room: 0, cap: 0 };
  let room = 0;
  let cap = 0;
  for (const sh of shelvesFor(game, itemId, c, spoken)) {
    // Minus whatever is already walking towards it, or two stockers each measure
    // the same empty board and both fill their arms for it.
    const coming = spoken?.get(key('shelf', sh.id))?.qty ?? 0;
    const holds = game.shelfCapacity(sh, item);
    cap += holds;
    room += Math.max(0, holds - (game.shelfStack(sh, itemId)?.qty ?? 0) - coming);
  }
  // `cap` rides along because the two are one walk of the shop, and the caller
  // needs both to tell "the freezer is empty" from "somebody bought two".
  return { room, cap };
}

/** Best unstocked item for an empty shelf: margin weighted by who wants it. */
function pickItem(game, shelf, c) {
  const folded = game.folded();
  // Reservations count as "already stocked" even where the shelf is still bare.
  // Choosing for a free shelf is a choice about the *range*, and something
  // another shelf is being kept for is already in it.
  const already = new Set(game.layout.shelves
    .flatMap((sh) => [
      ...game.shelfStacks(sh).map((k) => k.item_id),
      ...(Array.isArray(sh.assigned) ? sh.assigned : [sh.assigned]),
    ]).filter(Boolean));

  const crafted = new Set(c.recipes.map((r) => r.output_id));

  const scored = c.items
    .filter((it) => {
      if (crafted.has(it.id)) return false;   // whoever has `craft` makes these
      // "Never order this" has to bite here as well as on the quantity, or the
      // shop keeps choosing a banned item for every bare shelf, orders nothing,
      // and quietly never stocks that shelf with anything else either.
      if (game.itemRule(it.id).auto === false) return false;
      // …and the same is true of one the shop hand gave up on. Bounding the
      // quantity alone is not enough here either: the shop would keep choosing
      // it for every bare board, order nothing, and quietly never stock that
      // board with anything else — which reads as the shelf being broken.
      if (game.droppedItem(it.id)) return false;
      return homeKind(it) === shelfKind(shelf.kind);
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

/**
 * Ingredients this appliance could still use — the inputs of the recipe it is
 * set to, and nothing else. `loadStation` refuses the rest, so a chef holding
 * an armful for a recipe the machine is no longer set to would otherwise walk
 * it over, be refused, and go straight back to walk it over again.
 */
function wants(game, st) {
  return new Set((game.stationRecipe(st)?.inputs ?? []).map((i) => i.item_id));
}

/**
 * The recipe this appliance is set to, IF the chef could actually finish it —
 * every missing ingredient has to be sitting on a shelf somewhere.
 *
 * It used to choose between the machine's recipes, and the sort was there
 * because picking purely by "fewest items missing" deadlocks: the chef commits
 * to the nearly-complete recipe, discovers its last ingredient isn't stocked,
 * and never falls back to one it could have made. The choosing is the player's
 * now, so what is left is only the feasibility half — and answering null is
 * right rather than a deadlock: a chef with nothing to fetch for this machine
 * goes and does one of their other jobs.
 */
function feasibleRecipe(game, st) {
  // Every board in the shop, not one per unit. This is the line that decided
  // how many different ingredients a kitchen could have: a shelf answered with
  // one item, so "how many things can my chef cook with" was "how many shelves
  // do I own". Three boards on two shelves is six.
  const stock = new Map();
  for (const sh of game.layout.shelves) {
    for (const k of game.shelfStacks(sh)) {
      if (k.item_id && k.qty > 0) stock.set(k.item_id, (stock.get(k.item_id) ?? 0) + k.qty);
    }
  }

  // Crates count as stock. They are the same goods one step earlier — see the
  // fetch in `craft` — and leaving them out here is what made this gate say
  // "cannot be finished" about a fryer with two dozen chips on the pad.
  for (const d of game.deliveries) {
    for (const k of lotStacks(d)) stock.set(k.item_id, (stock.get(k.item_id) ?? 0) + k.qty);
  }

  const r = game.stationRecipe(st);
  if (!r) return null;
  const possible = r.inputs.every((i) => {
    const need = i.qty - (st.contents[i.item_id] ?? 0);
    return need <= 0 || (stock.get(i.item_id) ?? 0) >= need;
  });
  return possible ? r : null;
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
