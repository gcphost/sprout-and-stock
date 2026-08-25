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
import { suggestedPrice, wholesalePrice, IMPULSE_RADIUS } from './economy.js';
import { shelfKind, isWalkableTile, REACH } from '../../shared/build.js';
import { homeKind, impulsePull } from '../../shared/tags.js';
import { hash01 } from '../../shared/hash.js';
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
 *
 * **The full tank is a one-off, and `restores` is the real rhythm.** A hire
 * spawns at 1 and works `(1 - SPENT) / DRAIN` jobs before their first break —
 * and never sees that number again, because a break puts back what the pastime
 * it drew is worth rather than filling them up. So the steady state is
 * `restores / DRAIN` jobs, which for `lean-on-the-counter` (0.35) was **ten**:
 * ten actions, then fourteen seconds against a till, forever. That is what "the
 * workers take too many breaks" is, and it is why `DRAIN` is the only knob that
 * touches it — `SPENT` sets when the *first* break comes and then drops out of
 * the arithmetic entirely, and `restores` is content anybody may retune.
 */
const DRAIN = 0.015;        // per job taken, so ~50 jobs on a full tank
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
/**
 * ...and how long that break takes, against the same break taken standing up.
 *
 * The other half of the same sentence, and the half a player asks for first: a
 * proper room with somewhere to sit gets you back on the floor sooner, not only
 * fuller. They are genuinely different currencies — restoring more means FEWER
 * breaks, finishing sooner means SHORTER ones — and a room is worth painting
 * for either reason, so it does both rather than trading one off against the
 * other.
 *
 * It is a multiplier on the pastime's own `seconds` rather than a number of its
 * own, for the reason `SEATED_RESTORE` multiplies `restores`: what a break IS
 * stays authored, and the room is a modifier on it. A flat "breaks in here take
 * 8 seconds" would quietly delete the difference between a brew and a sandwich.
 *
 * `breakProgress` needs nothing: it divides by the span it is given, so a
 * shorter break plays the same flipbook faster, which is what a stage arc means.
 */
const SEATED_SPEED = 0.7;

/**
 * How long a hire stands about with nothing on before taking themselves off to
 * charge.
 *
 * Long enough that it is a *quiet shop* rather than a gap: the job list is asked
 * every `IDLE` (0.6s), so fifteen seconds is twenty-five consecutive draws in
 * which nothing anywhere wanted doing. A busy shop never reaches it, which is
 * the whole guard — there is no other test for "is there work", because "the
 * whole list declined, repeatedly" already is one.
 */
const BORED_SECONDS = 15;

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
 * How many kinds this hire will assemble into one box before setting off.
 *
 * Zero is every rung that has not been authored to do it, which is every rung
 * that exists today — so this reads as "no" for a save, an export and a fresh
 * seed alike, and the packing branches below all collapse to the code that was
 * there. The number is a count of KINDS because the units cap belongs to the
 * crate; `Game.crateLot` still bounds what actually goes in.
 */
const packsOf = (s) => Math.max(0, Math.trunc(tierOf(s).packs ?? 0));

/**
 * HOW FAR NEARER THE OTHER ONE HAS TO BE.
 *
 * The dial behind `routes`, and the same shape `ARRANGE_GAIN_MIN`..`MAX` is: a
 * keen rung always walks the shortest way, a lukewarm one only takes a short
 * cut it could not miss. In tiles, because that is what the saving is measured
 * in and a threshold in any other unit is a number nobody can picture.
 *
 * The floor is not zero on purpose. Two targets a hair apart are the same walk,
 * and diverting between them is a decision with nothing on either side of it —
 * which is also what would make the pick jitter as a hire drifts between two
 * beds, the same way `arranges` would oscillate without its own floor.
 */
const ROUTE_SAVING_MIN = 0.5;
const ROUTE_SAVING_MAX = 4;

/** How keen this hire is to plan their round, 0..1. Zero is every rung today. */
const routesOf = (s) => Math.min(1, Math.max(0, Number(tierOf(s).routes ?? 0)));

/**
 * The nearest of several targets the job rates EQUALLY — or the one it would
 * have taken anyway.
 *
 * Two things about it are load-bearing. The saving is measured against
 * `list[0]`, the incumbent, rather than against a running best: taking every
 * improvement in turn is how half a tile at a time adds up to a walk across the
 * shop, and the threshold then guards nothing. And the comparison is strict, so
 * a tie keeps the incumbent — which is what lets the zero case below be the old
 * code rather than a re-derivation of it that happens to agree.
 *
 * Straight-line and never `findPath`, which is a deliberate approximation. This
 * is asked per candidate per worker per tick and A* is the hottest loop in the
 * game, so a route-length version would cost more than the walk it saves. It is
 * also only ever a *preference*: a hire who picks a bed behind a wall stalls and
 * re-draws (see `stall`), which is exactly what already happens to an
 * unreachable bed that happens to be first in the list.
 */
function nearestOf(s, list, keen) {
  const first = list[0];
  if (list.length < 2) return first;
  const saving = ROUTE_SAVING_MAX - (ROUTE_SAVING_MAX - ROUTE_SAVING_MIN) * keen;
  const away = (t) => Math.hypot(s.x - t.x, s.z - t.z);
  const home = away(first);
  let best = first;
  let bestAway = home;
  for (let i = 1; i < list.length; i++) {
    const d = away(list[i]);
    if (d < bestAway) { best = list[i]; bestAway = d; }
  }
  return home - bestAway >= saving ? best : first;
}

/**
 * The target this hire takes out of `list` — first legal, or nearest legal.
 *
 * The zero branch is `list.find(ok)` verbatim, and that is the point rather
 * than an optimisation: every rung in the game reads 0, so a save, an export
 * and a fresh seed all run the code that was here, and no shop gets faster by
 * accident. It also keeps `ok`'s short-circuit for the callers whose predicate
 * is expensive — `harvest` asks `hasSomewhere` per bed, which walks the shelves.
 */
function pickNearest(s, list, ok) {
  const keen = routesOf(s);
  if (!(keen > 0)) return list.find(ok) ?? null;
  const all = list.filter(ok);
  return all.length ? nearestOf(s, all, keen) : null;
}

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
      /** Since when they have had nothing to do — see `tryCharge`. */
      idleFrom: null,
      /** ...and whether the charge they are on is one they took for that reason. */
      idleCharge: false,
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
 * that job has nothing to do it falls through the rest by descending weight —
 * but only as far as `FALLTHROUGH`, so an idle till sends them to the crops and
 * never to the job they were told to spend a tenth of their day on.
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
      // ...unless the box is rubbish, which `unload` would carry to a SHELF.
      // Asked first and by the same argument the branch itself makes: a crate
      // on the shoulder is not a job you may be drawn off, so the one job that
      // knows how to put THIS box down is the one that has to be offered.
      if (s.haul.waste) {
        if (worked(game, s, tidy)) { s.job = 'tidy'; spend(s); s.idleFrom = null; continue; }
        s.job = null;
        if (tryBreak(game, s, true)) continue;
        idle(game, s);
        continue;
      }
      // ...and a box lifted FOR a stockroom goes to that stockroom, not to
      // whichever shelf `unload` scores highest — which is usually a floor
      // board, so without this a runner does the long walk and then undoes it.
      // Gated on the hire still carrying the directive, and `ferry` itself
      // falls through when the room has gone, so the relief guarantee this
      // branch exists to give is unchanged: something always takes the box.
      if (s.ferryTo && jobsOf(game, s).some((j) => j.job === 'ferry')
        && worked(game, s, ferry)) { s.job = 'ferry'; spend(s); s.idleFrom = null; continue; }
      s.ferryTo = null;
      if (worked(game, s, unload)) { s.job = 'unload'; spend(s); s.idleFrom = null; continue; }
      // Could not even set it down. Stand still rather than fall through to a
      // job that would ignore the box — but take the break first, which is the
      // half this branch was missing.
      //
      // `onBreak`'s own note says a hire whose hands cannot be emptied must not
      // defer their break for ever, and the job list below has always had that
      // fallback (`tryBreak(game, s, true)`, at the bottom). A haul never
      // reaches it: it is answered up here, so `continue` skipped the one line
      // that protects them. What that cost is not a slower worker — energy sits
      // at zero and `tiredness` pins them at `TIRED_PACE` permanently, holding a
      // crate nobody else will lift.
      //
      // It goes after `unload` rather than before it for the same reason the job
      // list's does: an errand with somewhere to go outranks a rest, and a break
      // taken on the way to the pad would be a hire who never delivers.
      s.job = null;
      if (tryBreak(game, s, true)) continue;
      idle(game, s);
      continue;
    }

    const jobs = jobsOf(game, s);
    // An errand a two-leg job began, ended. Here rather than only inside that
    // job, because it is the one place that runs whether or not the job does —
    // and `shifting` holds `shelve` off, so a hire left mid-errand by a job
    // taken off their list would stand there holding an armful for ever. Empty
    // hands or no job to finish it: either way there is no errand.
    //
    // `SHIFTERS` and not a literal, which is not tidiness — it is the whole of
    // what this line does. Written as `=== 'merchandise'` it does not say "can
    // anybody finish this", it says "is this the one job that had errands when I
    // was written", so a SECOND two-leg job has its errand wiped on the very
    // tick it sets it. What that looks like is a hire who pulls a board and then
    // stands there holding it for ever, which is precisely the bug this line
    // exists to prevent, caused by the line itself. `ferry` cost an hour to it.
    if (s.shifting && (!s.carry || !jobs.some((j) => SHIFTERS.has(j.job)))) s.shifting = null;
    let took = false;
    for (const { job } of drawOrder(game, jobs)) {
      const run = JOBS[job];
      if (!run) continue;         // authored a job this build doesn't have
      try {
        // `tending` is a tick held rather than a job done, so it costs no wear —
        // see `tend`.
        if (worked(game, s, run)) { s.job = job; took = true; if (!s.tending) spend(s); break; }
      } catch {
        // A broken job is not worth killing the tick loop over, and not worth
        // killing the *worker* over either — try the next one.
        s.job = null;
      }
    }
    if (took) {
      // A charge taken out of boredom is over the moment there is anything to
      // do — that is the whole difference between it and a break, and this is
      // the line that makes it true. See `onBreak`, which hands the tick back
      // instead of holding it precisely so the draw above could run.
      if (s.pastime) endCharge(game, s);
      s.idleFrom = null;
      continue;
    }

    /**
     * ANYBODY CAN EMPTY THEIR OWN HANDS, whatever is on their list.
     *
     * Called directly rather than through the draw, and the argument is the one
     * `s.haul` makes twenty lines above, word for word: a hire who cannot put
     * down what they are holding has no job left that could relieve them, so
     * the crate — or here the armful — is welded on for the rest of the shift.
     * `putDown` lived only inside `tidy`, which is a job you have to have been
     * *given*, and four of the eight hires in a real shop had not been.
     *
     * What welds them is not the hands, it is the ARMFUL being one the shop has
     * given up on. `shelve` rightly refuses an item on `orders.dropped` — that
     * is `giveUpBoard` doing its job — and `unload` goes on lifting the crates
     * anyway, so the loop is: pick it up, nothing will take it, stand there.
     * Found in a live shop with five bots holding jam, peas and coffee and
     * eleven crates of the same on the floor, which reads as the staff being
     * stupid rather than as a job list with a hole in it.
     *
     * It is LAST, after the whole draw has declined, and it waits out
     * `STUCK_SECONDS` first — which is not caution, it is the difference
     * between the two kinds of full hands. **An armful in transit is not an
     * armful with nowhere to go.** A chef crossing the shop with beans for a
     * machine declines the draw on any tick they are between things, and
     * without the dwell this fired on that tick and walked their ingredients
     * out to the yard — so the kitchen made nothing at all, while looking like
     * a chef busily carrying something somewhere. `verify:kitchen` caught it on
     * "still makes things — made 0"; nothing about the code looked wrong.
     *
     * `idleFrom` is the right clock and needs no new one, because the `took`
     * branch above clears it on every tick anybody does anything: a working
     * hire can never accumulate, and only one the whole shop has no use for
     * does. It is above the break for the same reason the deferral below
     * exists — finish what is in your hands first.
     */
    if (s.carry && stuckFor(game, s, STUCK_SECONDS) && putDown(game, s)) {
      s.job = 'tidy'; spend(s); s.idleFrom = null; continue;
    }

    // A charge in progress is still what they are doing, even on a tick where
    // the job list was asked and declined. Written as `null` flat, this cleared
    // the readout every 0.4s for the whole charge, so a bot sat in the room with
    // a mug would report "looking for something to do" half the time.
    s.job = s.pastime ? 'break' : null;
    // ...and here is what stops "finish first" becoming "never rest". Their
    // hands are full and the whole job list just declined: no shelf will take
    // it, no station wants it, and nobody gave this hire `tidy`. There is
    // nothing left to finish, so they take the break holding it — which is
    // exactly what every break did before. The deferral can only ever last as
    // long as there is genuinely something to do with what they are carrying.
    if (tryBreak(game, s, true)) continue;
    if (tryCharge(game, s)) continue;
    // ...and if there is no case for a rest, there is still no case for standing
    // still. Last of the three, which is the whole of the ordering: a tired hire
    // rests, a bored promoted one charges, and anybody else gets on with
    // something. Above `idle` rather than inside it because `idle` is also the
    // no-op tick for a clerk walking back to their till, and a chore is not one.
    if (tryChore(game, s)) continue;
    idle(game, s);
  }
}

/**
 * Run one job, and answer whether it actually took the tick.
 *
 * The two are the same question for every job that can reach its target, which
 * is why this was `run(game, s)` for as long as everything in a shop could be
 * walked to. A job answers true for "doing it" AND for "on my way", and a walk
 * that cannot happen goes out under the second of those — so the draw is spent,
 * `idleFrom` is cleared, and the hire is busy for ever with a walk that will
 * never take a step. See `stall`, which is the other half.
 *
 * Declining lets the draw carry on to the next job, and past the bottom of it to
 * the three things that exist for precisely this state: `putDown` after
 * `STUCK_SECONDS`, then the break, then a chore. Which is the point — the hire
 * gets rid of what they are holding, rests, and the goods end up on the pad
 * where somebody can see them, instead of in the arms of a robot that has
 * stopped moving.
 *
 * The flag is cleared before the call rather than after it, so a stall left by
 * an earlier job this tick can never be read as this one's.
 */
function worked(game, s, run) {
  s.stalled = false;
  // ...and the other half of the same idea — see `tend`. Cleared here so it can
  // only ever describe the run that just happened, and read once, beside
  // `spend`, in `stepStaff`.
  s.tending = false;
  const did = run(game, s);
  const stalled = s.stalled;
  s.stalled = false;
  return did && !stalled;
}

/**
 * `onBreak`, with the throw dealt with.
 *
 * A stuck break must not cost a hire their shift, and this is now called three
 * times a tick, so the recovery belongs in one place rather than in catches that
 * can drift apart.
 */
function tryBreak(game, s, evenCarrying = false, bored = false, chore = false) {
  try {
    return onBreak(game, s, evenCarrying, bored, chore);
  } catch {
    s.breakFrom = 0;
    s.breakUntil = 0;
    s.pastime = null;
    s.idleCharge = false;
    s.chore = false;
    // The seat goes back with everything else. A claim left on a worker who is
    // no longer on a break is a cell of the room nobody may ever sit in again.
    s.breakAt = null;
    s.energy = 1;   // rather than leaving them stuck at empty and useless
    return false;
  }
}

/**
 * A hire with nothing to do takes themselves off to the break area — the second
 * thing a rung on the ladder sells that is not a multiplier.
 *
 * The idea is the shop's own: a unit stood in an aisle doing nothing is a unit
 * that will be tired later for no reason, and the room is *right there*. What
 * makes it a promotion rather than a rule is that it is judgement — a Casual
 * waits to be told, a Trusted works out that now is the moment. Which is why the
 * gate is "any rung above the first" rather than a hardcoded 2: a kind with one
 * rung never does it, and a kind with five does it from its second.
 *
 * Four things it needs, and each of them is doing work:
 *
 * - **A seat, and only a seat.** `seatIn` rather than `spotFor`, so a shop that
 *   never painted a break area plays exactly as it always did. The authored
 *   fallback is where a *tired* hire rests when there is nowhere to go; a bored
 *   one has no business leaning on a shelf in the middle of the shop floor,
 *   which is a picture of a robot loitering rather than one charging.
 * - **Empty hands.** `onBreak` defers a break for the same reason and says why:
 *   a charge with a crate in your arms is a hire who forgot the errand.
 * - **Somewhere for the energy to go.** A hire at a full tank gains nothing from
 *   a charge, so they would walk to the room, sit through it and come back
 *   identical — dead time bought with a walk. Anything short of full qualifies,
 *   which is deliberately nothing like `SPENT`: this is topping up, not downing
 *   tools, and a bot that waited until it was worn out would be using the room
 *   for the thing it already had a reason to use it for.
 * - **Not already charging.** `stepStaff` reaches here on every declined tick
 *   *including* the ones in the middle of a charge, since `onBreak` hands those
 *   back — so without this a bored hire starts a fresh charge every 0.4s.
 */
const FULL = 1;

function tryCharge(game, s) {
  if (s.pastime || s.carry || s.haul) return false;
  if ((s.energy ?? 1) >= FULL) return false;
  if ((s.tier ?? 1) <= 1) return false;
  // `elapsed` restarts at zero on every load (see CLAUDE.md), so a stamp from
  // the future is a stamp from the last run of the process and reads as "not
  // bored yet" rather than as "bored for ever".
  const since = s.idleFrom;
  if (since == null || game.elapsed < since || game.elapsed - since < BORED_SECONDS) return false;
  if (!seatIn(game, s)) return false;

  // Everything below is `onBreak`'s own opening, and it is called rather than
  // copied: which pastime, the walk, the snack and both ends of the clock are
  // one flow with two ways in, or a charge is a second implementation of a break
  // that quietly stops matching it.
  //
  // The clock is NOT cleared here, and that is the non-obvious half: the room
  // may be right across the shop, so this returns true for every tick of the
  // walk and is asked again on the tick they arrive. Cleared on the way in, they
  // would turn up at the seat no longer bored, stand there, and take the charge
  // fifteen seconds later — in the room, which is the one place it would look
  // like nothing was wrong. `onBreak` clears it when the charge actually starts.
  return tryBreak(game, s, false, true);
}

/** How long with nothing on before a hire finds something to be getting on with. */
const CHORE_SECONDS = 3;

/** ...and how long holding something the whole shop declined before they put it down. */
const STUCK_SECONDS = 5;

/**
 * Has this hire had nothing to do for `secs`?
 *
 * The `elapsed < since` half is the guard `tryCharge` and `tryChore` both make
 * and is worth having in one place: `elapsed` restarts at zero on every load, so
 * a stamp left by the last run of the process is in the future, and it has to
 * read as "not yet" rather than as "for ever".
 */
function stuckFor(game, s, secs) {
  const since = s.idleFrom;
  return since != null && game.elapsed >= since && game.elapsed - since >= secs;
}

/**
 * A hire with nothing to do gets on with something, on the shop floor.
 *
 * This is the answer to a question `tryCharge` only half answered: a bot with
 * nothing on used to stand *perfectly still* wherever it finished, which reads
 * as broken rather than as quiet — the shop looks like it has crashed. The
 * charge fixed that for exactly the hires who were promoted, worn out and had a
 * room to go to, which on any given quiet afternoon is none of them.
 *
 * So a chore is the charge's opposite number, and every gate the charge holds is
 * one this deliberately drops:
 *
 * - **Any rung.** Judgement is what the charge sells; sweeping up is not a
 *   perk, it is what you do rather than stand there.
 * - **Any tank.** A chore puts nothing back, so there is nothing to be full of.
 * - **No seat, and no room.** It happens on the floor by definition — see
 *   `spotFor`, which is where a chore stops being sent to the break area.
 * - **Three seconds, not fifteen.** The charge is a decision about the shop's
 *   afternoon; this is somebody looking round for something to do.
 *
 * What it keeps is the two that are not about rest at all. Empty hands, because
 * a hire who wanders off mid-errand is a hire who forgot the errand. And
 * `idleCharge`, which is what makes the whole thing safe: a chore hands the tick
 * back, the job draw runs underneath it every tick, and the first real job in
 * the shop ends it (`endCharge`). A chore can never make the shop slower — the
 * worst it can do is have somebody two aisles further away, which is exactly
 * what standing still risked anyway.
 */
function tryChore(game, s) {
  if (s.pastime || s.carry || s.haul) return false;
  // The same stamp-from-the-future guard `tryCharge` makes, and for the same
  // reason: `elapsed` restarts at zero on every load, so a stamp left by the
  // last run of the process has to read as "not yet" rather than as "for ever".
  const since = s.choreFrom;
  if (since == null || game.elapsed < since || game.elapsed - since < CHORE_SECONDS) return false;
  return tryBreak(game, s, false, true, true);
}

/**
 * Stand up early, with credit for as much of the charge as was taken.
 *
 * Pro-rata rather than nothing, and rather than the lot: a hire pulled off after
 * two seconds who banked a whole `restores` would make interrupting the charge
 * the best thing that can happen to them, and one who banked nothing would make
 * a quiet shop that gets one customer strictly worse than a quiet shop that gets
 * none. `breakProgress` is the same 0..1 the renderer flips the mug with, so
 * what they got is exactly what you watched them get.
 */
function endCharge(game, s) {
  const done = content().byId.pastimes?.[s.pastime];
  const share = breakProgress(s, game.elapsed) ?? 0;
  s.energy = clamp01((s.energy ?? 0)
    + (done?.restores ?? 0.5) * share * (s.breakAt ? SEATED_RESTORE : 1));
  s.pastime = null;
  s.breakAt = null;
  s.idleCharge = false;
  // Broken off because there is work, so both clocks start again — this is the
  // one exit where that is unambiguously right for each of them. A chore ended
  // by a customer walking in is a hire who is no longer idle at all, so leaving
  // the boredom clock running would have them wander off to charge in the middle
  // of the first job they have had all afternoon.
  s.idleFrom = null;
  s.choreFrom = null;
  s.chore = false;
}

/**
 * How far *down* the list a hire may be pulled when the job they drew has
 * nothing to do: half the weight of the job they drew, and no further.
 *
 * Without a floor the fall-through quietly ate the weights. A weight is a share
 * of the day, but only the head of the order is drawn by it — everything below
 * was reached by simply having work, so a job that ALWAYS has something to do
 * (restock, shelve, tidy) collected every draw that the heavier jobs declined.
 * A farmhand told `till` 10 and `tidy` 1 spent their day tidying between beds,
 * and the way that reads is a hire ignoring the one instruction you gave them.
 * Turned up to a flat list of tens it goes the other way and is the strongest
 * setting in the menu: everything is drawn evenly AND everything is a fallback,
 * so one hire does the work of four and never stands still.
 *
 * Being pulled *up* is untouched, and it is what stops this being a rota: draw a
 * job at 1, find it empty, and the whole list is still open above you, heaviest
 * first. So the floor only ever costs the light jobs the work the heavy ones
 * turned down — which is what a light weight was asking for.
 *
 * A ratio rather than a rung, because weights are ratios: 10-and-1 and 100-and-10
 * are the same instruction, and a fixed gap would read them differently. Half is
 * loose enough that an authored list of near-equals (a farmhand's 10/8/8/6) is
 * one working hire rather than four idle specialists.
 */
const FALLTHROUGH = 0.5;

/**
 * The order to try jobs in this tick: one weighted draw for the head, then
 * whatever is at least half as important, heaviest-first.
 *
 * Uses the game's seeded rng, never Math.random — two `simulate` runs of one
 * seed have to match, or every balance comparison in the project becomes noise.
 *
 * ...except that `serve` stops being a share of the day while the shutters are
 * down, and that is the one exception in here. A weight says two things at once
 * (see `FALLTHROUGH`) and only one of them survives a shut shop: it is still a
 * priority, and there is no longer a day to take a share of. So the heavier you
 * made somebody's clerking — which is the honest way to author a clerk — the
 * more of the night they spent frozen. `serve` guards itself and declines with
 * no queue, but a declining HEAD sets a floor of half its own weight, and a
 * clerk's other jobs are light by construction: `serve 10, shelve 3, tidy 2` is
 * two thirds of every quiet tick spent drawing the one job that cannot run and
 * refusing to try the two that can. What that reads as is a bot standing at a
 * dark till while there is stock on the floor, and it is worst overnight, which
 * is precisely when the shop had the time.
 *
 * It moves to the END of the list rather than off it, which is the whole care
 * needed here. A shopper who was already inside when you shut still finishes
 * their trip and still queues, and cash left on a counter is still worth
 * collecting — a clerk who could not do either would be a shop that cannot
 * close. Last means "after everything that can actually be done", not "never".
 *
 * And a hire whose ONLY job is serving is untouched: there is nothing to demote
 * them to, so they post up at their till exactly as they always did.
 */
function drawOrder(game, jobs) {
  if (jobs.length <= 1) return jobs;
  {
    const rest = jobs.filter((j) => j.job !== 'serve');
    // `rest.length < jobs.length` is "they actually have a serve weight" — both
    // branches are a no-op otherwise, and skipping them keeps a shop drawing
    // exactly the numbers it always did for everybody without a till on their
    // list.
    if (rest.length && rest.length < jobs.length) {
      if (!game.isOpen()) {
        return [...drawOrder(game, rest), ...jobs.filter((j) => j.job === 'serve')];
      }
      /**
       * ...and the same exception pointed the other way, which is the half that
       * actually costs money.
       *
       * A weight says two things at once, and the shut-shop branch above is
       * about the share half. This is about the PRIORITY half, and the draw is
       * where it was being lost: the head is drawn in proportion, so a clerk
       * authored `serve 9` with six odd jobs at 1 draws a weight-1 job as head
       * **two ticks in five** — and a head is tried FIRST, before serve, with
       * the fallthrough floor at half of 1 letting everything else in behind it.
       * So a ripe bed, a crate on the dock or a shelf that wants filling all
       * outrank a shopper standing at the counter, and once a hire sets off
       * `stepStaff` walks before it re-decides anything, so they are gone for
       * the whole round trip.
       *
       * Measured on the shipped clerk's list plus six directives at 1: over 20
       * in-game minutes the hire was away from the till for **85%** of the ticks
       * somebody was in the line, against 23% for a hire whose only job is
       * serving — and the line lasted 5.6x longer for it. What that reads as is
       * a bot who cannot see the queue, which is exactly what it was reported
       * as. It is not that they do not know; it is that nothing let serving
       * interrupt.
       *
       * Moving it to the FRONT rather than pre-empting the list outright is the
       * whole care needed. `serve` still guards itself — no line, no tick — so a
       * farmhand authored `serve 1` still spends their day in the field and
       * still steps in when somebody is at the counter, which is what a light
       * weight was asking for. And the head is still drawn from the rest, so the
       * floor, the ratios and the rng stream underneath are untouched.
       */
      if (anyLining(game)) return [...jobs.filter((j) => j.job === 'serve'), ...drawOrder(game, rest)];
    }
  }
  const rest = [...jobs].sort((a, b) => b.weight - a.weight);
  const total = rest.reduce((n, j) => n + j.weight, 0);
  let r = game.rng.next() * total;
  let head = rest[0];
  for (const j of rest) {
    r -= j.weight;
    if (r <= 0) { head = j; break; }
  }
  const floor = head.weight * FALLTHROUGH;
  // An empty tail is a hire who waits `IDLE` and draws again, which is the
  // point: standing by the beds for half a second beats being three aisles away
  // with an armful when one comes ripe.
  return [head, ...rest.filter((j) => j !== head && j.weight >= floor)];
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
 * The jobs that walk goods from one place to another in TWO legs, and can
 * therefore be mid-errand (`s.shifting`) when a tick begins.
 *
 * A set rather than a comparison, because the one line that reads it is asking
 * "is there anybody left who could finish this" — and answering that with the
 * name of one job is how a second two-leg job ships broken. See `stepStaff`.
 */
const SHIFTERS = new Set(['merchandise', 'ferry']);

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
function onBreak(game, s, evenCarrying = false, bored = false, chore = false) {
  // Mid-break: sit it out, then come back with the tank topped up.
  if (s.pastime) {
    if (game.elapsed < s.breakUntil) {
      s.job = 'break';
      s.cooldown = 0.4;
      // A charge somebody took because there was nothing on does NOT outrank the
      // job list — that inversion is the whole of what tells the two apart. So
      // the tick is handed back rather than held, the draw in `stepStaff` runs
      // as it would on any idle tick, and whatever it takes calls `endCharge`.
      // The cooldown above is still set, so a bot in the room is asked at the
      // same rate an idle one is rather than ten times a second.
      return !s.idleCharge;
    }
    const done = content().byId.pastimes?.[s.pastime];
    // `breakAt` is set when and only when a seat in the break area was claimed,
    // so it is the whole test for "was this break taken in the room" — no
    // second flag, and nothing to keep in step with where they actually went.
    s.energy = clamp01((s.energy ?? 0) + (done?.restores ?? 0.5) * (s.breakAt ? SEATED_RESTORE : 1));
    s.pastime = null;
    s.breakAt = null;   // the seat is free again the moment they stand up
    s.idleCharge = false;
    // Whichever clock this one ran off starts again from here. A charge that
    // did not reset the boredom clock would top the same bot up on a loop with
    // no gap at all; a chore that DID reset it would be the bug the other way
    // round — a sweeper is not resting, so the fifteen seconds that earn a
    // charge have to keep running underneath the sweeping.
    if (s.chore) s.choreFrom = null; else s.idleFrom = null;
    s.chore = false;
    s.job = null;
    return false;
  }

  // Being bored is the other way in, and it stands in for exactly this test and
  // nothing else — `tryCharge` has already made its own case, and a harder one.
  if (!bored && (s.energy ?? 1) > SPENT) return false;
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

  const pick = choosePastime(game, s, chore);
  // Nothing authored to do, so they soldier on rather than freezing at empty.
  // A shop with no pastimes in the database plays exactly as it did before.
  //
  // The tank is only topped up on the REST side of that. A shop with no chores
  // authored has to be a shop where nothing happens — handing a full tank to
  // somebody who merely had no floor to sweep would make the chore table a
  // source of free energy by being empty, which is the funniest possible way to
  // break the break area.
  if (!pick) { if (!chore) { s.breakAt = null; s.energy = 1; } return false; }

  // Set BEFORE the walk, not with the flags at the bottom, and this is the one
  // line in here that is purely about what you can see. `spotFor` can send them
  // the length of the shop, and everything below it only runs on the tick they
  // arrive — so a flag written down there leaves the sweeper crossing the floor
  // with its brush stopped, which is precisely the frozen-robot frame the whole
  // chore exists to get rid of. `endCharge` and the completion branch both clear
  // it, and so does the `catch` in `tryBreak`, so there is no path that leaves
  // somebody permanently sweeping.
  s.chore = chore;

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
  // `s.breakAt` is already answered by `spotFor` above — it is set when and only
  // when a seat in the break area was claimed — so the same one test decides
  // both halves of what the room is worth, and there is no second flag to keep
  // in step with where they actually went.
  s.breakUntil = game.elapsed
    + Math.max(1, (pick.seconds ?? 20) * (s.breakAt ? SEATED_SPEED : 1));
  // Which of the two this is, and the one thing a charge keeps that a break does
  // not. It has to be set here rather than by the caller: `spotFor` above can
  // send them on a walk first, and a flag written after the walk would be
  // written on the tick they SIT DOWN — so the tick in between is a charge that
  // outranks the job list, which is the bug this flag exists to prevent.
  s.idleCharge = bored;
  // ...and whether this is work or a rest, which the renderer needs and the
  // roster reads. Set here for exactly the reason `idleCharge` is: `spotFor`
  // above can send them on a walk first, and a flag written after the walk is
  // written on the tick they ARRIVE — so the whole way across the shop the
  // sweeper would be drawn standing still with its brush stopped, which is the
  // one frame this feature exists to get rid of.
  // Each clock is cleared by the thing that runs off it, and only by that. A
  // chore clearing `idleFrom` would be a hire who never gets bored enough to
  // charge; a charge clearing `choreFrom` is harmless and is done for tidiness
  // on the way out below.
  if (bored) { if (chore) s.choreFrom = null; else s.idleFrom = null; }
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
function choosePastime(game, s, chore = false) {
  const mine = new Set(kindOf(s)?.tags ?? []);
  const options = (content().pastimes ?? [])
    .filter((p) => (p.weight ?? 1) > 0)
    .filter((p) => isChore(p) === chore)
    .filter((p) => !p.tags?.length || p.tags.some((t) => mine.has(t)));
  if (!options.length) return null;

  // Which side of the draw this is decides where the number comes from, and it
  // is not a style choice. A rest happens a handful of times a day and belongs
  // in the measured stream. A chore is asked of every spare hire on every quiet
  // tick — put that in `this.rng` and the stream is not shifted, it is shredded,
  // so two `simulate` runs of one seed diverge the moment a shop has somebody
  // standing about. Hashed on the hire and the stretch of quiet, so it is stable
  // across the walk and different next time round. See `shared/hash.js`.
  const total = options.reduce((n, p) => n + (p.weight ?? 1), 0);
  let r = (chore ? hash01(`${s.id}:chore:${s.idleFrom ?? 0}`) : game.rng.next()) * total;
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
  // ...and the one exception, which is not a hole in that rule but the other
  // side of it. The room outranks where a REST happens, because half your hires
  // resting in the aisle would make the room read as broken. A chore is not a
  // rest — a bot sweeping the staff room is a bot not sweeping the shop — so it
  // keeps the spot it authored, which is the floor. Said as `isChore` rather
  // than `spot === 'roam'` so that a second kind of chore inherits it.
  if (isChore(p)) { s.breakAt = null; return authoredSpot(game, p, s); }
  return seatIn(game, s) ?? authoredSpot(game, p, s);
}

/**
 * Is this pastime a job of work rather than a sit down?
 *
 * One test, asked in five places, because the alternative is five spellings of
 * `spot === 'roam'` that have to be found together the day there is a second
 * kind of chore — and four of the five are rules a chore *breaks*, so missing
 * one is a sweeper who gets sent to the break room, or a chore that quietly
 * recharges somebody.
 */
const isChore = (p) => p?.spot === 'roam';

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
function authoredSpot(game, p, s = null) {
  const L = game.layout;
  if (p.spot === 'bay') return L.bay;
  if (p.spot === 'outside') return { x: L.door.x, z: L.door.z + 2 };
  // A till NOBODY IS AT, and `null` — take it where you stand — rather than the
  // first one if every counter is manned. `checkouts[0]` was the whole answer,
  // which is the same bug idle clerks had before posts were handed out by
  // roster order: it put the bot propping up the counter on the exact tile the
  // clerk serving that counter stands on, and two bodies inside one another
  // reads as a rendering fault rather than as two hires who both had a reason
  // to be there. The fallback matters more than the search does — a break spot
  // that cannot be free has to degrade to `here`, or somebody walks the length
  // of the shop to stand inside a colleague anyway.
  if (p.spot === 'till') return freeTill(game, s);
  if (p.spot === 'roam') return roamSpot(game, s);
  return null;
}

/** A counter's tending tile with nobody standing on it, or null if there is none. */
function freeTill(game, s) {
  const taken = new Set(Object.values(game.players)
    .filter((o) => o !== s)
    .map((o) => `${Math.round(o.x)},${Math.round(o.z)}`));
  // Which till to LEAN ON — this is a pastime's spot, not a post to work. Every
  // unoccupied one is the same break, so which was never a decision: it was
  // list order, and a hire at the far end of the counter walked to till 1 to
  // take five. Exactly the equal-candidates case `routes` is for.
  const free = [];
  for (const till of game.layout.checkouts ?? []) {
    const spot = tendSpot(till);
    if (spot && !taken.has(`${Math.round(spot.x)},${Math.round(spot.z)}`)) free.push(spot);
  }
  if (!free.length) return null;
  const keen = routesOf(s);
  return keen > 0 ? nearestOf(s, free, keen) : free[0];
}

/**
 * Somewhere else on the shop floor — the destination of one leg of a chore.
 *
 * **Hashed, never drawn.** This is asked for every idle worker on every quiet
 * tick, so it is the single hungriest caller of anything random in the game: an
 * `rng.next()` here would not nudge the measured stream, it would shred it, and
 * two `simulate` runs of one seed would stop matching the moment a shop had a
 * spare hire. `hash01` costs no draw at all. See `shared/hash.js`.
 *
 * **Keyed on `idleFrom`, which is what makes them arrive.** `onBreak` asks for
 * the spot again on every tick of the walk — the pastime is not taken until they
 * are standing on it — so a key that moved with the clock would hand them a new
 * destination every tick and they would drift about never getting anywhere. The
 * stamp is written once when the quiet stretch began and is not touched again
 * until the chore actually starts, so it is stable for exactly the walk and
 * different for the next leg.
 *
 * The tile is picked out of the shop's own walkable floor rather than off a
 * radius, because a circuit that can pick a tile nobody can stand on is a hire
 * who walks at a wall until something else comes up. An empty list — a shop
 * whose floor is entirely under fixtures — answers null, and `onBreak` treats
 * that as a pastime with no spot: they do it where they stand, which is what
 * every break did before there was anywhere to go.
 */
function roamSpot(game, s) {
  const floor = roamTiles(game.layout);
  if (!s || !floor.length) return null;
  return floor[Math.floor(hash01(`${s.id}:roam:${s.idleFrom ?? 0}`) * floor.length)] ?? null;
}

/**
 * Every indoor cell a hire could stand on, worked out once per layout.
 *
 * Cached ON the layout rather than on the game, which is the whole of why this
 * needs no invalidation: a re-flow builds a fresh layout object, so the list
 * goes with the shop it described. A cache on `game` would survive the wall you
 * just knocked through and send somebody to sweep inside it.
 *
 * Indoors only, and that is a choice rather than an oversight — a shop floor is
 * what a chore is for, and a sweeper who wandered off down the farm would be
 * three-quarters of a field away the moment a customer walked in. It also means
 * a shop whose walls have been taken out (`computeIndoor` answers *zero* cells,
 * not fewer — see CLAUDE.md) hands back an empty list, and an empty list is a
 * chore taken where they stand. That is the right failure: no walls, no circuit,
 * and nothing pins anybody at a tile they can never reach.
 */
function roamTiles(L) {
  if (L._roam) return L._roam;
  const out = [];
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x < L.w; x++) {
      if (L.indoor?.[z * L.w + x] && isWalkableTile(L, x, z)) out.push({ x, z });
    }
  }
  L._roam = out;
  return out;
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
  game.pushLog(`${s.name} bought a ${items[stack.item_id]?.name ?? stack.item_id} while charging.`);
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
  // Since when. Only stamped if it is not already running, or every declined
  // draw would push it forward and nobody would ever reach `BORED_SECONDS` —
  // the clock has to measure the whole quiet stretch, not the last gap in it.
  s.idleFrom ??= game.elapsed;
  /**
   * ...and a second clock, for the same instant, that is deliberately NOT the
   * same clock.
   *
   * A chore runs every few seconds and a charge is a decision about the
   * afternoon, so they cannot share a stamp: reset `idleFrom` each time
   * somebody swept up and it never reaches `BORED_SECONDS` again, and the
   * charge — the thing a promotion actually sells, with a whole sweep written
   * about it — silently stops happening for ever. Nothing would say a word,
   * because a bot doing chores all afternoon looks *more* alive than one that
   * charges, not less.
   *
   * So the boredom clock measures the whole quiet stretch and the chore clock
   * measures the gap since the last one, and a hire who has been pottering
   * about for fifteen seconds still takes themselves off to the room.
   */
  s.choreFrom ??= game.elapsed;
  // A charge in progress is not somewhere to be moved from. `stepStaff` reaches
  // here on every declined tick of one (see `onBreak`), so without this a clerk
  // sat in the break room is walked back to their till and charges standing at
  // the counter — the whole feature, undone one line below where it was done.
  // Nobody stands inside anybody else. Before the post below, because that one
  // is only about clerks and this is about all thirteen of them.
  if (stepAside(game, s)) return;

  if (s.carry || s.pastime || topJob(game, s) !== 'serve') return;

  const tills = game.layout.checkouts;
  const servers = (game.roster ?? [])
    .map((e) => game.players[`staff-${e.id}`])
    .filter((p) => p && !p.carry && topJob(game, p) === 'serve');

  const post = tills[servers.indexOf(s)];
  if (post) goTo(game, s, tendSpot(post), 0.6);
}

/**
 * Two hires on one tile: one of them takes a step.
 *
 * A seat in the break area is claimed for exactly as long as the break lasts
 * (`seatIn`), which is right — a room seats as many as you painted it — and it
 * says nothing at all about afterwards. `idle` only ever walked a *clerk*
 * anywhere, so everybody else stops where they finished, and where a lot of
 * them finish is the break room: the charge ends, the seat is handed back, and
 * the bot stands on that cell until something happens. Two of them end up
 * inside one another and it reads as a rendering fault, which is exactly what
 * the same bug at the tills read as before posts were handed out by roster
 * order — see the note above.
 *
 * Three things keep it from being worse than the overlap.
 *
 * **Exactly one of the pair moves.** Decided by id, not by who asked first: two
 * bots that both stepped aside would swap tiles forever, and a tie broken on
 * turn order is a tie broken differently in `simulate` than in the live game.
 *
 * **It costs no rng.** Which way they step is hashed off the pair, so the shop
 * that budges is the same shop in two runs of one seed — the reason
 * `shared/hash.js` exists. A draw here would be one per idle worker per quiet
 * tick.
 *
 * **It is a step, not a walk.** One tile, orthogonally, onto floor nobody else
 * is on. If all four are taken or blocked they stay put and overlap, which is
 * the old behaviour and the honest answer for a hire boxed into a corner —
 * better than pathing across the shop to stand somewhere else doing nothing.
 */
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function stepAside(game, s) {
  const at = (p) => `${Math.round(p.x)},${Math.round(p.z)}`;
  const mine = at(s);
  // The whole shop's bodies, once. Staff and the player both, because standing
  // inside the shopkeeper is the same picture as standing inside a colleague.
  const here = [];
  const busy = new Set();
  for (const o of Object.values(game.players)) {
    const cell = at(o);
    busy.add(cell);
    if (o !== s && cell === mine) here.push(o);
  }
  if (!here.length) return false;
  // Whoever sorts lowest holds the tile. Nothing about that is fair and it does
  // not need to be — what it buys is that the decision is the same on every
  // machine and in every replay.
  if (here.every((o) => String(s.id) < String(o.id))) return false;

  const spin = Math.floor(hash01(`${s.id}:aside:${mine}`) * STEPS.length);
  for (let i = 0; i < STEPS.length; i++) {
    const [dx, dz] = STEPS[(spin + i) % STEPS.length];
    const x = Math.round(s.x) + dx;
    const z = Math.round(s.z) + dz;
    if (busy.has(`${x},${z}`)) continue;
    if (!isWalkableTile(game.layout, x, z)) continue;
    goTo(game, s, { x, z }, 0.4);
    return true;
  }
  return false;
}

/** The job this hire gives most of their day to. */
function topJob(game, s) {
  return [...jobsOf(game, s)].sort((a, b) => b.weight - a.weight)[0]?.job ?? null;
}

/**
 * COULD NOT GET THERE, which is not the same answer as "on my way".
 *
 * Both walks below return false twice over — once for a route in progress, once
 * for no route at all — and every caller in the file spells the second one
 * `return true`, meaning "I have this tick". That reading is right for the walk
 * and wrong for the stall, and the difference is invisible for exactly as long
 * as every target is reachable: a hire walking is a hire working, and a hire who
 * can never arrive is a hire holding the tick for the rest of the save.
 *
 * **`pathTo` refusing is the RARE way in, and it was the only one guarded.**
 * `findPath` does not fail on a goal it cannot stand on — a goal is usually a
 * fixture tile, so it retargets to the first walkable NEIGHBOUR of it and
 * happily returns a route. That is what makes a walk to a `browseAt` somebody
 * has built on succeed and land you two tiles from the anchor, outside `REACH`:
 * a real path, honestly reported, ending somewhere the shop verbs refuse. Ask
 * again from there and the search starts on its own target, hands back an empty
 * route, and answers true — so the hire has *arrived* at somewhere that is not
 * near enough, for ever, and nothing anywhere says no.
 *
 * So a route with no steps left in it that has not arrived is the second stall,
 * and it is the one that actually bites.
 *
 * What it costs is not a slower worker. `stepStaff` clears `idleFrom` on every
 * tick a job is taken, so a job that claims the tick forever means `stuckFor`
 * never fills, `putDown` is never reached, and neither is the break under it —
 * energy sits at zero and `tiredness` pins them at `TIRED_PACE` permanently.
 * That is `s.haul`'s bug two hundred lines up, said about an ARMFUL: found on a
 * live shop with a chef stood outside the east wall holding six toasties for a
 * hot counter whose only working side another hot counter had been built on.
 *
 * A flag rather than a third return value, because the claim has to be
 * *unwound* by the caller that offered the draw and there are five walks and
 * nine jobs between here and there — a tri-state would be nine call sites that
 * each have to spell the distinction again, and the one that forgot would look
 * exactly like this bug does. Set here, read once, in `stepStaff`.
 */
function stall(s) {
  s.stalled = true;
  s.cooldown = 1;   // unreachable — try something else shortly
  return false;
}

/** Walk to `goal`; returns true once standing there. */
function goTo(game, s, goal, reach = 1.2) {
  if (Math.hypot(s.x - goal.x, s.z - goal.z) <= reach) return true;
  if (!game.pathTo(s, goal)) return stall(s);
  // Not there, and no step left to take. See `stall`.
  if (!s.path?.length) return stall(s);
  return false;
}

/**
 * ...and the same for a SHELF, where "am I there yet" is not the walk's question
 * to answer.
 *
 * A route aims at `browseAt` — the tile you stand on to work the unit — but
 * every shelf verb in `Game` gates on `near(p, shelf)`, which measures `REACH`
 * from the unit's own ANCHOR. Two circles with different centres and different
 * radii, and the gap between them is somewhere a hire can actually stand:
 * `browseAt` is a tile off the anchor, so 1.2 from `browseAt` on the far side is
 * 2.2 from the shelf. `goTo` says arrived, `stockFromCrate` says "too far from
 * that shelf", and the job asks again next tick with the same answer.
 *
 * Nobody has to walk into that band for it to bite, which is why it survived:
 * `goTo` returns true WITHOUT MOVING for anyone already inside it, so a hire
 * parked there by some earlier errand never takes the step that would fix it.
 *
 * With empty hands it is a stutter — the next draw sends them elsewhere. With a
 * CRATE it is permanent, because `stepStaff` sends a haul straight to `unload`
 * and will not offer a break to somebody it believes is busy with their box: the
 * hire is pinned at `TIRED_PACE` holding it for the rest of the save. Found in a
 * live shop on a shop-hand stood two tiles from a lettuce shelf, 37 refusals
 * deep and not moving.
 *
 * So arrival is asked of the anchor at the radius the shop will use, and only
 * the WALK aims at `browseAt`. Anything that approaches a shelf in order to call
 * one of those verbs belongs here rather than on `goTo` — and the test for that
 * is whether the next line is gated on `near`, not whether it touches a shelf.
 */
function goToShelf(game, s, shelf) {
  if (Math.hypot(s.x - shelf.x, s.z - shelf.z) <= REACH) return true;
  if (!game.pathTo(s, shelf.browseAt ?? shelf)) return stall(s);
  // Standing on the far side of a working spot somebody has built on, with the
  // route already spent and the anchor still out of `REACH`. See `stall` — this
  // is the shape the live shop actually hit, and the walk above reports it as a
  // perfectly good path.
  if (!s.path?.length) return stall(s);
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
  // WHICH pad, asked of what is actually in their hands. Everything the shop is
  // still trying to sell goes to the drop-off, which is what this always did;
  // a line the shop has stopped stocking goes to the bay instead, because the
  // drop-off is the production buffer and `padRoom` is what the farm and the
  // kitchen are gated on — see `Game.dropAt`. Asked of the biggest pile, since
  // a pair of hands can hold three kinds and the pad is one place.
  //
  // A shop can have no drop-off at all now that the pads are ground somebody
  // paints — see `Game.freezeYard`. Nothing to walk to, so they keep hold of it
  // and try again later rather than pathing to `undefined`.
  const main = lotMain(s.carry);
  const pad = main ? game.dropAt(main.item_id) : game.dropPad();
  if (!pad) { s.cooldown = 2; return false; }
  // Which one they ended up at, so `stow` is asked about the pad they are
  // standing on rather than about the pad it would have picked. Compared by
  // identity: `dropAt` hands back one of the two objects on the layout, so
  // there is nothing to keep in step.
  const want = pad === game.layout.bay ? 'bay' : null;
  // The nearest CELL of the pad, not the pad's middle. `stow` refuses anybody
  // not standing on the ground itself (`onPad`), and `pad.x/z` is only the cell
  // closest to the centre — on an L-shaped stockroom, or from the wrong side,
  // "within 1.6 of the middle" is a tile that is not on the pad at all. Which
  // was survivable right up until the line below stopped destroying the goods.
  const cell = (pad.cells ?? [pad]).reduce((best, c) => (
    Math.hypot(c.x - s.x, c.z - s.z) < Math.hypot(best.x - s.x, best.z - s.z) ? c : best
  ), pad.cells?.[0] ?? pad);
  if (!goTo(game, s, cell, 0.6)) return true;
  const res = game.stow(s.id, want);
  // KEEP HOLDING IT. This branch used to read `s.carry = null`, which is the
  // exact bug the note above says was fixed — "staff used to just have the goods
  // deleted out of their hands" was made true again by the failure path, and it
  // fires precisely when the shop is over-full, which is when it was written to
  // matter. Nothing is lost by trying again: a pair of hands that cannot be
  // emptied defers the break rather than blocking it (see `stepStaff`), so a
  // worker holding something the shop has no room for is idle, visible, and
  // still holding it — all three of which are better than stock evaporating.
  if (!res.ok) { s.cooldown = 2; return false; }
  s.cooldown = paceOf(s);
  return true;
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

/**
 * ANYBODY IN THIS LINE, standing in it or still walking up to their place.
 *
 * The dispatch question — which till, whether to go, whether to stay — and it
 * is deliberately NOT the ring-up question below. `leaveShop` re-paths the
 * *whole* queue into `TO_TILL` after every sale, and says why: "a walker is
 * only a stander who has not arrived". So a predicate that counts only the
 * people standing still answers "nobody waiting" for the length of every
 * shuffle, and a hire released on that answer is one the draw may take
 * somewhere else — between two customers, at the busiest till in the shop.
 *
 * `Game.serve` and `stepQueue` both already draw this distinction (see the note
 * on `queue[0]` stalling the line). The staff job was the one place the two
 * questions shared an answer.
 */
const lining = (game, t) => (t.queue ?? []).some((id) => {
  const st = game.customers[id]?.state;
  return st === 'QUEUE' || st === 'TO_TILL';
});

/** ...and somebody actually in their slot, which is the only one you can ring up. */
const ready = (game, t) => (t.queue ?? []).some((id) => game.customers[id]?.state === 'QUEUE');

/**
 * How close a person has to be to the working side of a till to count as being
 * on it. `goTo`'s own default, which is the distance a hire settles for when
 * they walk to that exact spot — so a clerk who has arrived at a post and a
 * player standing on it are being measured the same way.
 *
 * Deliberately the TEND side and not `serveCandidate`'s 2.2 from the counter
 * itself. That reach is the right one for "could you ring somebody up", and it
 * is the wrong one for this, because it is a circle round the till that takes in
 * the customer side, the queue and — in a shop this size — the unit next door.
 * Standing down a clerk because the shopkeeper is filling the freezer two tiles
 * away is the bug this whole section is about, arriving through a new door.
 */
const TEND_REACH = 1.2;

/**
 * IS THE SHOPKEEPER ON THIS ONE?
 *
 * You are the only human who works here, and working a till is the one job you
 * do side by side with the crew rather than instead of them. Nothing said so:
 * `claimed` walks `game.players` and skips everybody who is not `staff`, so a
 * player stood behind the counter ringing people up was invisible to the hire
 * whose whole job that is — and with serving now winning the draw the moment a
 * line forms (see `drawOrder`), the two of you would crowd one counter while the
 * shop went unstocked.
 *
 * The answer has to be a *place* rather than an action. There is no "serving"
 * state to read — a sale is a ring that arms, fires and is gone inside a second,
 * so a clerk asking "are they serving right now" would stand down and come back
 * between every customer, which is worse than not asking. Standing at the post
 * is the honest signal, and it is re-asked every tick: step away and the hire
 * takes the counter back on the next one.
 */
function minded(game, till) {
  /**
   * ...and never in a balance run, which is the one thing here that had to be
   * measured rather than reasoned about.
   *
   * `simulate`'s bot is a cursor rather than a person: it TELEPORTS to whatever
   * it is stocking and stays there until the next second, and a shelf beside the
   * counter puts it on the till's working side. Measured over three 60-day runs
   * of a real save, it sat there for **14.2%** of all ticks — so unguarded this
   * would stand the shop's clerks down for a seventh of every balance run, and
   * every figure in the repo would shift for a reason that has nothing to do
   * with anybody serving anybody.
   *
   * `autoServe` is the honest test and not a bot-shaped special case: it means
   * the tills ring themselves up because there is no human in this run at all,
   * which is precisely the condition under which "is the shopkeeper on this one"
   * is not a question. See `stepQueue`.
   */
  if (game.autoServe) return false;
  const post = tendSpot(till);
  if (!post) return false;
  for (const o of Object.values(game.players)) {
    if (o.staff) continue;
    if (Math.hypot(o.x - post.x, o.z - post.z) <= TEND_REACH) return true;
  }
  return false;
}

/**
 * Is anybody anywhere waiting to pay that the crew still have to deal with?
 * Read by the draw — see `drawOrder`.
 *
 * A till you are stood at does not count, which is the half that makes this
 * usable: without it the queue you are personally working would go on
 * out-ranking every other job on every hire's list for as long as it lasted.
 */
const anyLining = (game) => (game.layout?.checkouts ?? [])
  .some((t) => lining(game, t) && !minded(game, t));

/**
 * MINDING THE COUNTER, which is not the same answer as working.
 *
 * The mirror of `stall`, and it exists for the same reason that one does: the
 * two things a job can mean by `return true` are "I did something" and "I have
 * this tick", and every other job in the file means both at once. Standing at a
 * till while the line shuffles forward is the one place they come apart — the
 * hire must hold the tick, or the draw takes them away mid-queue, and must not
 * be *charged* for it, because `spend` is one job's worth of wear and waiting is
 * not a job. At `DRAIN` a tick this would flatten a full tank in ten seconds of
 * standing still, and what that reads as is a clerk who takes a break every time
 * the shop gets busy.
 *
 * A flag read once in `stepStaff`, the same shape and for the same reason as
 * `stalled`: a third return value would be nine call sites that each have to
 * spell the distinction again.
 */
function tend(s) {
  s.tending = true;
  s.cooldown = IDLE;
  return true;
}

/**
 * Man a till: take the money off the counter, then ring the next shopper up.
 *
 * NOTHING ABOUT THIS NEEDS A FREE PAIR OF HANDS, and it used to open by
 * demanding one. `serve` is the only goods verb in the game that moves no
 * goods — `Game.serve` finds the front of the line and calls `completeSale`,
 * which never touches the server's arms — so `if (s.carry) return false` was a
 * refusal with nothing behind it, and it was the refusal that quietly undid the
 * rest of this section: a hire who had picked up an armful was out of action as
 * a clerk however far up their list serving sat, and on a shop-hand's directives
 * that is most of the day. Measured on the reported clerk, hands were full for
 * **1,790** of the ticks they spent away from a line, second only to being
 * mid-errand.
 *
 * The tell that it was an accident rather than a decision is that YOU were
 * already exempt: `serveCandidate` has never asked about `p.carry`, so the
 * shopkeeper could always ring somebody up holding six loaves and the crew could
 * not. Same shape as the chevrons and `shelfAccepts` — the shop's rule and your
 * hands' rule have to be one rule, and this was the last place they were two.
 *
 * A crate on the SHOULDER is untouched and deliberately so: `stepStaff` answers
 * `s.haul` above the draw entirely, and that branch is the relief guarantee that
 * stops anybody being welded to a box. Serving is a job you may do with your
 * arms full; it is not a job you may be *drawn onto* carrying a crate nothing
 * else will lift.
 */
function serve(game, s) {
  // One clerk per till, and it has to be enforced here rather than left to
  // `idle`'s posts: `idle` spreads people who have nothing to do, and this is
  // the path taken by everybody who *does*. Both clerks used to answer the same
  // queue, which means both walk over, one rings the sale and the other stands
  // on the same tile watching — an unmanned second till at the same time.
  //
  // ...and one SHOPKEEPER per till on the same argument, which is `minded`. A
  // counter you are stood behind is a counter that is being worked, so it is
  // filtered out here beside the claims rather than checked further down: with
  // two tills the hire should take the other one, and the `?? tills[0]` fallback
  // below would otherwise walk them onto your toes to collect the cash you are
  // standing on.
  const busy = claimed(game, s);
  const tills = game.layout.checkouts
    .filter((t) => !busy.has(key('till', t.id)) && !minded(game, t));
  if (!tills.length) return false;

  // A queue is a queue: nothing here rates one waiting shopper above another,
  // so among the tills that HAVE somebody, which one is a question about the
  // walk. `pickNearest` is `tills.find(lining)` for every rung that has not
  // paid for it, which is the fallback below reached by the same route it
  // always was — and `?? tills[0]` stays, because a till with nobody at it is
  // only ever somewhere to collect cash from and there is no choice in that.
  const till = pickNearest(s, tills, (t) => lining(game, t)) ?? tills[0];
  const post = tendSpot(till);
  const standing = Math.hypot(s.x - post.x, s.z - post.z) <= 0.6;

  // Cash left on the counter is worth collecting even with nobody in the line.
  if (!lining(game, till) && !(standing && game.cashDrops.length)) return false;
  claim(s, 'till', till.id);
  if (!goTo(game, s, post, 0.6)) return true;

  if (game.collectCash(s) > 0) { s.cooldown = paceOf(s); return true; }
  // Standing at the post with a line that has nobody in its front slot yet:
  // mind the counter rather than handing the tick back. See `tend` and
  // `lining` — the shopper being rung up next is, at this instant, walking.
  if (!ready(game, till)) return lining(game, till) ? tend(s) : false;
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
 * Stand about looking official, and go after anybody who runs — docs/security.md
 * step 4.
 *
 * The job is deliberately the SECOND half of what a guard is worth. Presence is
 * the first (`Game.guardDeterrence`, read at the fork in `goToTill`), and that
 * half needs no job to run at all — which is right, because a security guard is
 * mostly somebody standing there, and a shop where the deterrent only worked
 * while the chase code was executing would be a shop where hiring one did
 * nothing until somebody already stole from you.
 *
 * **They cannot win a foot race, and that is the design.** A hire walks at
 * `speedOf` — around 2.6 — against a thief's 4.62, so a guard who spots
 * somebody already running has essentially no chance of closing. What they can
 * do is be in the way. Which turns "where do I put my guard" into the whole
 * decision, and it is a decision the shop answers honestly: post them by the
 * door and they intercept; post them at the back and they are decoration.
 *
 * A guard who caught everybody would retire the tazer you were given in step 3,
 * and a shop that plays itself is the failure mode every job in this file is
 * written against.
 */
function guard(game, s) {
  if (s.carry || s.haul) return false;

  // Only somebody who still has the goods. A thief already emptied — by you, or
  // by another guard — is an ordinary shopper walking out, and chasing them is
  // a hire crossing the shop for nothing while looking exactly like a hire
  // doing their job.
  const thieves = Object.values(game.customers)
    .filter((c) => c.stole && !c.caught && (c.bought?.length ?? 0) > 0);

  if (thieves.length) {
    const near = (c) => Math.hypot(c.x - s.x, c.z - s.z);
    const mark = thieves.reduce((a, b) => (near(b) < near(a) ? b : a));
    // Close enough to grab. `game.taze` is not reused: it is the PLAYER's verb,
    // it charges a cooldown against a player record and it refuses out of a
    // player's range — three things a hire has no version of. What is shared is
    // the outcome, which is `catchThief`.
    if (near(mark) <= GUARD_REACH) {
      game.catchThief(mark, s);
      s.cooldown = paceOf(s);
      return true;
    }
    // Otherwise walk at them. Routed every tick rather than once, because the
    // target is running: a route planned to where somebody WAS is a guard
    // jogging to an empty tile, which reads as broken pathing.
    goTo(game, s, { x: mark.x, z: mark.z }, GUARD_REACH);
    return true;
  }

  /**
   * Nothing to chase, so go and be visible — at a way OUT.
   *
   * Every exit rather than `layout.door`, because that field is only the hole
   * the generator cut and a player can knock as many more as they like: a guard
   * stood at the front of a shop with a side entrance is watching the wrong one,
   * and it reads as the hire not working because they are standing exactly where
   * you would expect a guard to stand. `shopExits` derives them from the walls
   * with the same test the thief's own route is planned with.
   *
   * One guard per exit, claimed the way `serve` claims a till — which is what
   * makes hiring a second one mean something in a shop with two ways out, and
   * is the same shape the rest of this file already uses for "don't both do the
   * one job". Nearest unclaimed, so a guard already stood at the back door stays
   * there: a post chosen by anything that drifts would have them wander between
   * doors all day, which is `spotScore`'s churn rule said about people.
   *
   * Returning false once posted is deliberate: a guard who held the tick while
   * standing still would starve every other directive on their list, and one
   * given `guard` plus `shelve` is supposed to shelve between incidents.
   */
  const busy = claimed(game, s);
  const free = game.shopExits().filter((e) => !busy.has(key('exit', e.id)));
  const posts = free.length ? free : game.shopExits();
  if (!posts.length) return false;

  const post = posts.reduce((a, b) => (
    Math.hypot(b.x - s.x, b.z - s.z) < Math.hypot(a.x - s.x, a.z - s.z) ? b : a));
  claim(s, 'exit', post.id);
  if (Math.hypot(s.x - post.x, s.z - post.z) <= GUARD_POST) return false;
  return goTo(game, s, post, GUARD_POST) ? false : true;
}

/** How near a way out counts as standing at it. */
const GUARD_POST = 1.4;

/**
 * How close a guard has to be to lay hands on somebody.
 *
 * Wider than the player's `TAZE_RANGE` on purpose, and it is the only advantage
 * they get: they are half the speed of what they are chasing, so a reach as
 * tight as yours would make the job unwinnable rather than hard.
 */
const GUARD_REACH = 1.5;

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
/**
 * THE SHOP GAVE UP ON THIS, SO IT MUST NOT BUY IT EITHER.
 *
 * `giveUpBoard` marks an *item* on `orders.dropped`, and for two steps only half
 * the shop was told. `shelvesFor` opens by refusing a dropped item outright — no
 * shelves, larder or floor — which is the mark doing its job. The buying half
 * never heard: `pickItem` checks it, so a BARE board is safe, but the top-up
 * path in `restock` picks "the emptiest pile already on this unit" straight off
 * `shelfStacks`, and a given-up item is still standing on every other board it
 * was on. So the van kept coming.
 *
 * What that costs is not a slow shop, it is a **one-way pile**: goods arrive,
 * nothing can ever shelve them, and they sit in the yard until the mark lapses.
 * Found on a live save on day 97 — six items given up over days 94–95, the
 * morning's log showing 9x Dried Pasta, 25x Liquorice and 1x Breakfast Cereal
 * ordered against all six of them, and the stranded pile going from 33 units to
 * 59 in one day. Every symptom of it is somewhere else: `bayRoom` collapses, so
 * the shop quietly stops ordering the things it DOES sell, and `putDown` cannot
 * stow onto a full pad — which is the documented behaviour of holding goods
 * rather than binning them, so the crew stand about with full arms. What you
 * watch is a shop whose staff have stopped working, and the cause is a purchase
 * order four days old.
 *
 * **A reservation overrules it**, which is not a nicety — it is the same
 * exemption `shelvesFor` makes two lines into itself, and the two must agree or
 * the shop refuses to buy for a board it will happily shelve. `keptFor` is
 * shop-wide for that reason: ticking any unit for it is you saying the shop's
 * judgement was wrong, and that answer cannot depend on which shelf is being
 * asked about.
 *
 * It does NOT clear the mark the way `shelvesFor` does. That function is
 * placing goods that already exist and has to decide where they go; this one is
 * deciding whether to create any. One writer of `orders.dropped`, or the mark
 * means something different depending on who asked.
 */
export const givenUp = (game, id) => game.droppedItem(id) && !game.keptFor(id);

function restock(game, s) {
  if (s.carry) return false;
  if (!game.orders.auto) return false;
  const c = content();
  /**
   * THE BAY GUARD IS GONE, AND `homeSupply` IS WHAT IT WAS REACHING FOR.
   *
   * It was a set of items with a crate standing somewhere, and any board wanting
   * one of them ordered nothing. That has been narrowed twice already and each
   * time in the same direction — shop-wide ("one crate of flowers refused soda,
   * tomatoes and coffee") to per-item, then per-item to per-PILE — and this is
   * the last step of the same walk: per-item to per-UNIT. Because it was still a
   * boolean, and the honest question is a number.
   *
   * `homeSupply` is that number and is asked four lines below: it counts every
   * pile in every crate, both hands, every shoulder, every planted bed and every
   * order already placed, and `buy` spends it as `need - supply`. So "don't buy
   * what is already coming" was covered, by quantity, the whole time — and the
   * set on top of it turned a shortfall of 39 into an order of nothing.
   *
   * What it cost is exactly what it cannot see: a board holds `stack *
   * capacity_mult * boards` now, so ONE unit of pork riding a conveyor on the
   * far side of the shop vetoed a 140-unit board that was empty. On a real save
   * that was **11 of the 20 units** in the queue, and the shop had 49 belt cells
   * — a long enough pipeline that something of nearly everything is always in
   * transit, so the veto was close to permanently on. Nothing logs it and every
   * hire is visibly working; what you watch is a shop the size of a warehouse
   * that reads as understocked no matter what you do.
   *
   * The scheduling half of it — "there is stock on the floor you could shelve
   * instead" — was never this function's to make. `unload` outscores `restock`
   * for a hire standing next to a crate, and a crate with somewhere to go is
   * picked up because that job is drawn, not because this one stood down.
   */
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

  // ...and the third ceiling, which is not money at all: how much the yard will
  // physically take. `buyStock` refuses an order bigger than `bayRoom` or
  // `looseRoom` by name, and both of the callers below read a refusal as
  // "skip this one" — so an order that is too big is not a smaller order, it is
  // a board that is never bought for again. See the note at the `qty` below for
  // what that inverts.
  //
  // Walked once for the whole pass rather than per board: both of them sweep
  // every crate in the shop, and neither can move before the one order this job
  // places. `looseRoom` answers Infinity in a shop with no pads, where
  // `buyStock`'s own bay guard is the one that should speak.
  const yard = Math.min(game.bayRoom(), game.looseRoom());
  if (yard <= 0) return false;

  // ...and a machine that cannot run at all, before any of the shelves.
  //
  // Nothing in the game has ever ordered an INGREDIENT. `restockQueue` is built
  // out of boards, so an item nobody sells is invisible to the supplier however
  // badly the kitchen wants it — set an appliance to a recipe whose input is not
  // also a product you shelve, and it silently never runs. There is no refusal
  // and nothing in the log: a press with no bread and a press nobody set are the
  // same still frame, and what it reads as is the chef having no job.
  //
  // It goes FIRST, and it is allowed to because it can only fire on a machine
  // that is genuinely stopped — see `larderOrder`. A pass gated on "the kitchen
  // is short" behind the shelf loop would never run in a shop with twenty boards
  // on it, which is exactly the shop that owns an appliance.
  if (larderOrder(game, s, c, budget, yard)) return true;

  // The order the shop asks for. `restockQueue` is the sim's rule, not this
  // job's: it is what the player set in the shelf menu, and a second copy of it
  // here is the one that would drift from what the menu promised.
  const busy = claimed(game, s);
  // Where the shop keeps each thing, worked out once for the whole queue. A
  // board that is not the item's home is a board no stocker will ever walk to
  // (`shelvesFor`), so ordering a van for it buys goods that go from the lorry
  // to the pad and stay there — which is the *spread* bug arriving one step
  // earlier, through the door that spends the money.
  const homes = new Map();
  const homesFor = (id) => {
    if (!homes.has(id)) homes.set(id, game.homeShelves(id));
    return homes.get(id);
  };
  const homedAt = (shelf, id) => {
    return game.homedAt(shelf, id, homesFor(id));
  };
  // ...and which machines each stockroom unit is the larder for, once for the
  // whole queue and for the same reason. Null in every shop with no appliance
  // or no back room, which is the cheap path and most shops.
  const backTakes = game.backRanges();
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
      // The shop's own judgement about its range, beside the player's switch
      // above it — see `givenUp`. Here rather than in the item pick below,
      // because that pick has two branches (a reservation, then the emptiest
      // pile already standing) and a veto written into one of them is exactly
      // the half-told rule this is fixing.
      if (givenUp(game, id)) return 0;
      // Not where the shop keeps this. Nothing will shelve it here, so a van of
      // it lands on the pad and stays.
      // The shop floor stays consolidated. A stockroom is deliberately the
      // opposite: once its current home is full, the next compatible empty unit
      // is real reserve capacity and the buyer may fill it.
      if (!homedAt(target, id)
          && !(target.boh === true && game.homeFull(id, true, homesFor(id)))) return 0;
      // ...and the same for a back room whose machines have no use for it, with
      // the same reservation override. Asked here as well as in `shelvesFor`
      // because this is the half that spends money: a board in the stockroom
      // that already holds something no machine can use would otherwise go on
      // being topped up for ever, which is the complaint said about the van
      // rather than about the shelf.
      if (!kept.includes(id) && !game.backRoomTakes(target, id, backTakes)) return 0;
      // What the shop already has of this, counted wherever it is standing —
      // every crate, both hands, every shoulder, every bed and every order
      // already on a van. It is subtracted rather than used as a veto, which is
      // the whole of what the retired `atTheBay` set got wrong: see the note at
      // the top of this function.
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
    //
    // The top-up half skips a board that is not this item's home, rather than
    // letting it win the "emptiest board" sort and answer zero: a unit with a
    // draining spare board beside a live one would otherwise pick the spare,
    // order nothing, and the live board would never get its van. The bare-unit
    // fallback still asks whether the unit is bare *at all*, or `pickItem` would
    // be choosing a range for a unit that already has boards in use.
    const item = kept.length
      ? c.byId.items[[...kept].sort((a, b) => buy(b) - buy(a))[0]]
      : (c.byId.items[game.shelfStacks(target).filter((k) => homedAt(target, k.item_id))
        .slice().sort((a, b) => a.qty - b.qty)[0]?.item_id]
        ?? (!game.shelfStacks(target).length && game.orders.assign
          ? pickItem(game, target, c) : null));
    if (!item) continue;
    // Whoever has `craft` makes these, and the crew never spends your money on
    // one. `pickItem` has always said so for a BARE board; this is the top-up
    // half, which never had to say it — `buyStock` refused a recipe output
    // outright, so the two paths agreed by accident. They stopped agreeing the
    // day the van started selling everything again (see `Game.buyStock`), and
    // what the gap looked like was a stocker ordering cheese at wholesale onto
    // the board the preserving pot behind them was already filling: every step
    // a worker restocking a thin shelf, and the appliance quietly never worth
    // what it cost. Your own press is untouched — that is the whole point of
    // the change this guards.
    if (game.makesHere(item.id)) continue;

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
    //
    // ...AND BY WHAT THE YARD WILL TAKE, WHICH IS THE HALF THAT WAS MISSING.
    //
    // `buyStock` refuses an order bigger than `bayRoom` or `looseRoom` **by
    // name** rather than shrinking it, and that is right — it is a press you
    // made, and a number silently becoming a smaller number is the complaint
    // said the other way round. It is exactly wrong for the crew, because this
    // job CHOOSES the number: a refusal here is `continue`, so the board is
    // skipped, and it will be skipped again on the next tick and every tick
    // after, because nothing about it has changed.
    //
    // What that means is an inversion nobody could ever see: the emptiest board
    // asks for the most, so **the bigger a unit is, the more certain it is to be
    // refused**. A live shop had a 216-unit stockroom board at zero and a bay
    // with 60 free, so the buyer computed 216, was turned down, and moved on —
    // for ever. Every small old shelf in that shop had stock on it and every big
    // new one was bare, which reads as the ordering having stopped working on
    // the good shelves. Buying more shelving made it worse; painting a bigger
    // stockroom made it worse; the only thing that would have helped is a bigger
    // delivery bay, and nothing anywhere said so.
    //
    // Clamping is not a cap on depth, because `homeSupply` counts a pending
    // order: a 216 board takes a van of 60 today, asks for 156 tomorrow, and
    // fills over successive runs. The yard is the rate, not the ceiling.
    const qty = Math.min(buy(item.id), Math.floor(budget / Math.max(unit, 0.01)), yard);
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

    /**
     * A conveyor first, and this is the line that makes belts worth owning.
     *
     * The whole pitch of docs/belts.md is that the WALK is the product, so a box
     * a run will deliver is a box nobody should be carrying to a shelf — and
     * without this the crew go on doing exactly what they did before, because a
     * shelf at the far end of the shop is a perfectly good answer and they have
     * no idea the belt is there. What you would watch is a working conveyor
     * standing idle beside a stocker walking past it with a crate, which reads
     * as the belt being broken.
     *
     * It goes ahead of the shelf search rather than beside it: a hire who
     * weighed the two would take whichever was nearer, and the point is not that
     * the belt is a shorter walk, it is that the rest of the journey costs
     * nothing at all.
     *
     * `beltFor` insists the run actually SERVES some of what is in the box, so
     * a line that goes nowhere is not an answer and the hire falls straight
     * through to the shelf below. That fall-through is the same guarantee
     * `ferry`'s haul branch gives: a run torn out, jammed, or re-aimed while
     * somebody walked must never leave a crate welded to a shoulder.
     */
    const belt = game.beltFor(s.haul, { from: s });
    if (belt && !taken.has(key('belt', belt.id))) {
      claim(s, 'belt', belt.id);
      if (!goTo(game, s, belt, 1.4)) return true;
      const put = game.beltPut(s.haul, belt);
      if (put.ok) s.haul = null;
      s.cooldown = put.ok ? paceOf(s) : 1;
      // A refusal is not work — see the note at the bottom of this branch. The
      // cell filling between the decision and the arrival is the ordinary case
      // on a busy run, and saying it was work is a hire who never rests again.
      return put.ok;
    }

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
      const res = game.dropCrate(s.id);
      s.cooldown = res.ok ? paceOf(s) : 1;
      // A refusal is not work — see the note below. `dropCrate` has its own two
      // ways to say no (the tile is not walkable, or it is out of reach), and
      // both of them repeat for as long as the hire stands where they are.
      return res.ok;
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
    if (!goToShelf(game, s, shelf)) return true;
    const res = game.stockFromCrate(s.id, shelf.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    // A REFUSAL IS NOT WORK, and saying it was is what welded a crate to a
    // shop-hand. `stepStaff` reads this `true` as "busy with their box" and
    // therefore declines to offer them a break — so a refusal that repeats is a
    // hire that never rests again, at `TIRED_PACE`, holding the same two lettuce
    // for the rest of the save. `goToShelf` closes the refusal this actually hit;
    // this closes the SHAPE of it, for whichever way `stockFromCrate` learns to
    // say no next. Walking there is still true — that is work in progress and
    // ends by itself.
    return res.ok;
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

  /**
   * How much MORE this box would hold once they had packed it from the ones
   * standing beside it — and 0 for every hire whose rung does not pack, which
   * is what keeps this branch invisible until somebody authors one.
   *
   * It has to be asked here, at the decision, rather than only when the packing
   * happens. `wholeCrate` refuses a box that is not worth more than one armful,
   * and the bay this feature is for is exactly the bay where no single box ever
   * is: three part-crates of four are three armfuls, for ever, because each one
   * is judged on its own contents. Judged on what it could BECOME, one of them
   * is a full crate and the other two are its contents.
   *
   * Bounded the same three ways `fit` is bounded and one more: the crate's
   * units, the shelves' room less what is already in this box heading there,
   * and `packTo` kinds — the rung's number, counted over the whole box, so a
   * lifted crate that already holds three kinds packs top-ups only.
   */
  const packTo = packsOf(s);
  const packFill = (d) => {
    const crate = game.crateLot();
    const room = crate.cap - lotTotal(d);
    if (room <= 0) return 0;
    let slots = packTo - lotStacks(d).length;
    let added = 0;
    const mine = new Map(lotStacks(d).map((k) => [k.item_id, k.qty]));
    for (const other of game.stockCrates()) {
      if (other.id === d.id) continue;
      if (busy.has(key('crate', other.id))) continue;
      // Only out of the yard, which is `wholeCrate`'s own termination argument
      // said about the second box: a packer drawing from a stray in the aisle
      // would take goods somebody already carried out there and carry them
      // back, and two hires could pass one pile between two boxes for ever.
      if (!onAPad(game, other)) continue;
      for (const pile of lotStacks(other).sort((a, b) => b.qty - a.qty)) {
        if (added >= room) break;
        const have = mine.get(pile.item_id) ?? 0;
        if (!have && slots <= 0) continue;
        const take = Math.min(pile.qty, roomFor(pile.item_id).room - have, room - added);
        if (take <= 0) continue;
        if (!have) slots -= 1;
        mine.set(pile.item_id, have + take);
        added += take;
      }
    }
    return added;
  };

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
  // Every box that matched the winner exactly, in bay order — the equal
  // candidates `routes` is allowed to choose between, and the ONLY thing it may
  // be offered here. A bay of same-size part-crates ties constantly (`score` is
  // `stray * 1e6 + moves`, so a tie is the same stray and the same units), and
  // which of those is serviced first was never a decision — it was the order
  // the boxes happened to be stored in. Anything that scores lower is a WORSE
  // TRIP, and a rung that could take one of those to save a walk would be a
  // balance change rather than an efficiency upgrade.
  let ties = [];
  let fallbackTies = [];
  for (const d of game.floorCrates()) {
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
      if (score > best) { best = score; pallet = d; bestMoves = moves; ties = [d]; }
      else if (score === best) ties.push(d);
    } else if (score > fallbackBest) {
      fallbackBest = score; fallback = d; fallbackMoves = moves; fallbackTies = [d];
    } else if (score === fallbackBest) fallbackTies.push(d);
  }
  if (!pallet && fallback) { pallet = fallback; bestMoves = fallbackMoves; ties = fallbackTies; }

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
    const home = game.floorCrates().find((d) => !onAPad(game, d)
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
  // Two identical trips, so take the near one. `bestMoves` survives untouched
  // and has to: a tie is the same `moves`, which is what `Game.unload` is capped
  // at, so swapping between tied boxes cannot change how much comes off one.
  const keen = routesOf(s);
  if (keen > 0 && ties.length > 1) pallet = nearestOf(s, ties, keen);
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
  //
  // Both of the size tests below count what a packer would ADD to the box, and
  // `fill` is 0 for everybody else — so a shop with no packing rung authored
  // takes exactly the branch it took before, arithmetic included.
  const fill = packTo > 0 ? packFill(pallet) : 0;

  /**
   * What the box has to beat, and for a packer it is not the size of their
   * hands.
   *
   * `hands` is the right bar while an armful and a crate are the same trip made
   * two ways — that is what "at or under an armful the box is pure ceremony"
   * means. It stops being the right bar the moment a rung's `carry_mult` can
   * take hands up to a whole crate, which the shipped stocker's second rung
   * already does: twelve-unit hands against a twelve-unit crate is `12 > 12`,
   * false, for ever. So the one hire in the game you would promote *to* pack
   * crates is the one hire who can never shoulder one — a rung that takes money
   * and moves no number, which is the trap this repo has a name for.
   *
   * And it is not merely neutral. Big hands do not help with a bay of
   * part-crates at all: `Game.unload` sweeps ONE box, and `fillHands` tops up
   * only kinds already held — so a twelve-unit stocker facing three boxes of
   * four leaves with four, exactly as a six-unit one does.
   *
   * `best` is what the armful trip would actually move off this pallet
   * (`fit`, assigned two lines up), so comparing against it asks the honest
   * question: is the packed box worth more than the armful this bay can
   * assemble? For everybody else the two are the same number and this is the
   * test that was already here.
   */
  const bar = packTo > 0 ? best : hands;

  /**
   * ...unless a conveyor will take it, in which case the size tests are asking
   * the wrong question entirely.
   *
   * Every one of them is a comparison between two JOURNEYS — is the box worth
   * more than the armful this bay can assemble — and a box put on a belt makes
   * no journey at all past the first cell. A four-unit crate against six-unit
   * hands is "pure ceremony" when both ends of it are a walk across the shop;
   * with a run in between it is the difference between one short trip to the
   * belt and three long ones to the shelf.
   *
   * Without this the branch below is unreachable for exactly the shop that laid
   * a belt to fix it — a bay of part-crates, which is the case `packs` exists
   * for — so the crew would go on making armful trips down an aisle with a
   * conveyor running along it.
   *
   * `onAPad` and `crateOnTop` still apply, and the first is what keeps it
   * terminating: haulage runs one way, out of the yard.
   */
  const beltTakes = !s.carry && !!game.beltFor(pallet, { from: s });
  const wholeCrate = !s.carry
    && (beltTakes || lotTotal(pallet) + fill > bar)
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
    && (beltTakes
      || lotStacks(pallet).reduce((n, k) => n + Math.min(k.qty, roomFor(k.item_id).room), 0) + fill > bar)
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
    // Pack it where they stand, in the same action, for `fillHands`' reason
    // exactly: coming round again is another weighted draw, and a hire who
    // wandered off to serve a customer between lifting the box and filling it
    // is a box that never gets filled. One action, no ordering relied on.
    if (res.ok && packTo > 0) fillCrate(game, s, pallet, packTo);
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
  // The arithmetic moved onto the Game the day `packCrate` had to refuse on it.
  // Kept as a local name because a dozen call sites in this file read `onAPad(game, d)`,
  // and a wrapper is cheaper than a rename that touches every one of them —
  // what matters is that there is one answer rather than two.
  return game.onAPad(d);
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
  for (const d of game.floorCrates()) {
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
 * Having shouldered one crate, make it a FULL one out of the boxes beside it.
 *
 * `fillHands` said about the other container, and the difference between them
 * is the whole feature. That one only ever tops up a kind already in the arms,
 * deliberately, so it can never take a kind slot the walk was counting on. This
 * one is allowed to add kinds — that is what "make a full crate" means — and
 * what bounds it instead is the rung: `packTo` kinds in the box, counted over
 * the box rather than over what was added, so a crate lifted with three kinds
 * already in it packs top-ups only however high the number goes.
 *
 * The trip it exists for is the one a bay of part-crates could never make. Four
 * lettuce, four eggs and four bread in three boxes is three walks of the shop:
 * no single box is worth shouldering, `fit` scores each at four, and the hire
 * takes an armful and comes back twice. One box packed from the other two is
 * one walk, and the two empties are gone off the pad with it.
 *
 * Reach is not re-tested here, for `fillHands`' reason: `Game.packCrate`
 * refuses a pallet you are not stood next to, and a second copy of that
 * distance in this file is the one that would quietly drift from the one the
 * game enforces.
 */
function fillCrate(game, s, from, packTo) {
  const c = content();
  const spoken = inbound(game, s);
  const { cap } = game.crateLot();
  const busy = claimed(game, s);
  const room = new Map();
  const roomFor = (id) => {
    if (!room.has(id)) room.set(id, roomAcross(game, id, c, spoken).room);
    return room.get(id);
  };
  for (const d of game.floorCrates()) {
    if (d.id === from.id) continue;
    if (busy.has(key('crate', d.id))) continue;
    // Out of the yard only — see `packFill`. Without it, packing is a way for
    // goods to travel back to the bay they already left.
    if (!onAPad(game, d)) continue;
    if (lotTotal(s.haul) >= cap) return;
    // Biggest pile first, which is `lotSweep`'s ordering and matters here for a
    // reason of its own: the kind slots are the scarce thing, so spending one
    // on the four eggs before the one lettuce is the box a glance would have
    // packed.
    for (const pile of lotStacks(d).sort((a, b) => b.qty - a.qty)) {
      const have = lotQty(s.haul, pile.item_id);
      if (!have && lotStacks(s.haul).length >= packTo) continue;
      // The shelves' room for this kind, less what is already in this box
      // heading there — the same subtraction `fit` and `fillHands` both make.
      // A packer who filled the box with what the shop has no room for would
      // walk a full crate to one board and the rest of it home again.
      const want = Math.min(roomFor(pile.item_id) - have, cap - lotTotal(s.haul));
      if (want <= 0) continue;
      game.packCrate(s.id, d.id, want, pile.item_id);
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
  if (!goToShelf(game, s, shelf)) return true;
  game.stockShelf(s.id, shelf.id);
  s.cooldown = paceOf(s);
  return true;
}

/**
 * Clean up: crate what has nowhere to go, and take the rubbish out.
 *
 * **One job, because it is one chore.** Carrying rot to the skip was its own
 * entry in `JOBS` for exactly as long as the skip existed, and that was a record
 * to say a thing the shop already had a word for: tidying up. What it cost is
 * the shape of the mistake — a job nobody had, on five authored worker kinds
 * that all carry `tidy`, so a live shop stood 305 units of rot beside a skip it
 * had paid for with seven hires who were all, in their own terms, tidying.
 *
 * A new *routine* does not need a new job. It needs a new branch in the job
 * whose sentence already covers it, or every kind in the game has to be
 * re-authored for a chore that was always part of clearing up.
 *
 * The rubbish half keeps its own guard, and the guard is the whole of it:
 * **`waste` crates and nothing else.** docs/workers.md draws that line about the
 * shop hand — *"what something is worth is the player's question, and a worker
 * answering it is a worker spending your money"* — and it is why Clear walks a
 * dead board to the drop-off rather than to a skip. A hire may carry out what
 * has already rotted, because that is worth nothing and no judgement was made; a
 * hire may never decide six loaves are not worth keeping.
 *
 * Ordering is what makes it one function rather than two called in a row. Hands
 * come first: an armful with nowhere to go is what `tidy` has always been, and a
 * hire holding stock must not walk off to the bins with it. Then the shoulder,
 * because a crate you are already carrying outranks choosing a better one — the
 * same sentence `unload`'s haul branch opens with. Then the search.
 *
 * The crate is hauled rather than emptied by hand. It is one trip either way and
 * a box of rot going up on a shoulder is the picture the whole feature is for:
 * spoilage used to be a line in the log at midnight, and what you watch now is
 * somebody carrying it across the shop.
 *
 * WHICH bin is `binFor`, and it used to be `bins[0]` — see the note there.
 */
/**
 * WHICH skip, and it was `bins[0]` for the whole life of the feature.
 *
 * The note that stood here said nothing scores which bin, because "the shop has
 * one skip in practice". That is true of a shop with one skip and quietly false
 * the moment somebody builds a second — which is a thing you build precisely
 * because your first one is on the wrong side of a shop that got big. A real
 * save had two, fifteen tiles apart, and every hire in the building walked past
 * the near one to queue at `bins[0]`: 24 steps each way from the far corner
 * against 4 from the other end.
 *
 * **What that reads as is the crew not clearing up**, which is the only reason
 * it is worth a search at all. The rot does go, eventually, so nothing is stuck
 * and nothing logs anything — you simply watch piles sit in the aisles while
 * hires walk past them, and the skip you bought to fix it does nothing you can
 * see. The second one is not a decoration; it is somebody spending money on
 * exactly this problem and being told the money did nothing.
 *
 * Decided ONCE, at the lift, and remembered on the haul. Recomputed per tick it
 * would be a path search per hire per tick on the hottest loop in the game, and
 * it would also be free to change its mind halfway across the shop — walking
 * toward one skip does keep that skip nearest, but a shop is not a straight
 * line and a route round an aisle can cross the tipping point.
 *
 * By PATH and never by line of sight, which is the whole of what makes it safe:
 * the near skip may be behind a wall, and `bins[0]` at least had `stall` to fall
 * back on. A bin nothing can reach is not offered, and if none can be reached
 * the old answer stands so the behaviour is never worse than it was.
 */
function binFor(game, s) {
  const bins = game.layout.bins ?? [];
  if (bins.length < 2) return bins[0] ?? null;
  const kept = s.haul?.binId && bins.find((b) => b.id === s.haul.binId);
  if (kept) return kept;
  let best = null;
  let bestSteps = Infinity;
  for (const b of bins) {
    const at = b.useAt ?? b;
    const path = findPath(game.walk, game.layout, { x: Math.round(s.x), z: Math.round(s.z) }, at);
    if (!path || path.length >= bestSteps) continue;
    bestSteps = path.length;
    best = b;
  }
  return best ?? bins[0];
}

function tidy(game, s) {
  // An armful with nowhere to go — the original whole of this job.
  //
  // **It has to report the refusal**, and that is the one line in here that is
  // not obvious. `putDown` deliberately keeps hold of goods the shop has no room
  // for (see its note), so on a full yard this branch walks somebody to the pad,
  // fails to stow, and comes back — and answering `true` to that told the draw
  // the job had been done. The draw is then spent, every tick, on a hire who
  // moved nothing.
  //
  // Which would be merely wasteful if tidying were still one routine. With the
  // rubbish folded in it is a deadlock with a shape: the pad is full *of rot*, so
  // the thing that would free it is the branch below, and this branch was
  // swallowing every draw that could have reached it. A live shop sat at 548
  // units of rubbish with six of seven hires holding stock they could not put
  // down — every one of them tidying, none of them able to finish.
  //
  // False falls the draw through to `shelve`, `craft`, anything: a hire whose
  // hands the shop cannot take is better spent on a job that does not need them
  // emptied first.
  if (s.carry && !s.haul?.waste) return putDown(game, s);

  if (!game.anyBin()) return false;

  // Carrying it already? Then there is one thing to do with it.
  if (s.haul?.waste) {
    const bin = binFor(game, s);
    if (!bin) return false;
    // Remembered, so the walk cannot change its mind halfway. See `binFor`.
    s.haul.binId = bin.id;
    if (!goTo(game, s, bin.useAt ?? bin)) return true;
    // Straight off the shoulder. Not through `binGoods`, which is the player's
    // verb and would take an armful of good stock with it — a hire arriving at
    // the skip holding rubbish in one hand and cheese in the other must lose
    // only the rubbish, and only this branch knows which is which.
    s.haul = null;
    s.cooldown = paceOf(s);
    return true;
  }
  if (s.carry || s.haul) return false;

  const busy = claimed(game, s);
  const rubbish = game.deliveries.find((d) => d.waste && !busy.has(key('crate', d.id)));
  if (!rubbish) return false;
  claim(s, 'crate', rubbish.id);
  if (!goTo(game, s, rubbish)) return true;
  // Straight onto the shoulder as a crate that knows it is rubbish. A `haul` is
  // ordinarily a lot, and `stepStaff` sends anybody holding one to `unload`
  // before the draw — which would walk this to a SHELF. The flag is what makes
  // the branch above win instead, and it is on the hands rather than looked up,
  // because the crate is gone from `deliveries` the moment it is lifted.
  game.deliveries = game.deliveries.filter((d) => d.id !== rubbish.id);
  s.haul = { stacks: lotStacks(rubbish), waste: true, crateId: rubbish.id };
  s.cooldown = paceOf(s);
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
    if (!goToShelf(game, s, shelf)) return true;
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
      if (!goToShelf(game, s, shelf)) return true;
      const res = game.unshelve(s.id, shelf.id, stack.item_id);
      if (!res.ok) { s.cooldown = 1; return true; }
      if (res.left <= 0) game.clearStack(shelf, stack.item_id);
      s.shifting = { to: better.id };
      s.cooldown = paceOf(s);
      return true;
    }
  }

  // Rearrange — the good stuff to the good spots. Last of the three, which is
  // the whole of what makes it occasional: a hire drawn to `merchandise` clears
  // a dead board if there is one and merges a split one if there is one, and
  // only reaches this when the shop has nothing that actually needs doing.
  // There is no separate weight to tune because there is no separate directive
  // — it is the same job, at the bottom of its own list.
  return rearrange(game, s, c, busy, hands);
}

/**
 * How much better a spot has to be before it is worth carrying stock over.
 *
 * The hysteresis, and it is the termination argument rather than a taste knob.
 * A move that needs only to be *better* can be undone by a move that is better
 * again, and two shelves a hair apart will pass a box between them for the rest
 * of the save — a hire visibly working, all day, changing nothing. Requiring a
 * strict ratio means each move increases a bounded quantity (value × spot,
 * summed over the shop) by a fixed factor, so there is a last move.
 *
 * The range is what the rung buys: a keen rung acts on a modest improvement, a
 * lukewarm one only on an obvious one.
 */
const ARRANGE_GAIN_MIN = 0.15;
const ARRANGE_GAIN_MAX = 0.45;

/** How keen this hire is to re-merchandise, 0..1. Zero is every rung today. */
const arrangesOf = (s) => Math.min(1, Math.max(0, Number(tierOf(s).arranges ?? 0)));

/**
 * MOVE WHAT SELLS TO WHERE PEOPLE WALK.
 *
 * The third `merchandise` verb, and the first thing a worker has ever done that
 * is a judgement about the SHOP rather than about a board. docs/workers.md's
 * line — *what something is worth is the player's question, and a worker
 * answering it is a worker spending your money* — is why the other two verbs are
 * shaped the way they are, and this one is deliberately on the other side of it:
 * it moves stock between shelves and never decides what stock is worth keeping,
 * so nothing here can cost you anything. The most it can do is put the wrong
 * thing at eye level, which the next pass undoes.
 *
 * Four guards, and each one is load-bearing:
 *
 *   the rung        — `arranges` is 0 on every tier ever authored, so a shop
 *                     that has not paid for this is the old game exactly.
 *   `handMayTouch`  — BOTH ends. The unit switch is how you keep a display you
 *                     arranged yourself, and a locked shelf that still had
 *                     stock walked onto it is a locked shelf being rearranged.
 *   a reservation   — either end. A ticked board is an instruction, and a hire
 *                     quietly moving stock off one is the shop overruling you.
 *   a real gain     — see the note above. Without it this oscillates.
 *
 * What it does NOT do is displace. The target needs a board free (or to already
 * hold this), so a shop whose good spots are full stays as it is until
 * something sells down — at which point `shelvesFor` prefers the good spot
 * anyway and the refill lands there on its own. A swap is the obvious next
 * step and is a genuinely harder job: three legs, two pairs of hands' worth of
 * stock in flight, and a half-done swap has goods in limbo.
 */
function rearrange(game, s, c, busy, hands) {
  const keen = arrangesOf(s);
  if (!(keen > 0)) return false;
  const need = 1 + ARRANGE_GAIN_MAX - (ARRANGE_GAIN_MAX - ARRANGE_GAIN_MIN) * keen;

  const folded = game.folded();
  const kept = (sh) => (Array.isArray(sh.assigned) ? sh.assigned : (sh.assigned ? [sh.assigned] : []));
  /**
   * What this item is worth having in a good spot — the same margin × who-wants-it
   * `pickItem` chooses the range with, deliberately, so the shop cannot rank
   * items one way when it is filling a bare shelf and another way when it is
   * tidying. Two spellings of "the good stuff" is a crew that undoes the
   * ordering every few days for reasons nothing anywhere records.
   */
  const worth = (item) => {
    const margin = suggestedPrice(item, folded, game.season) - wholesalePrice(item, folded, game.season);
    const pull = c.archetypes.reduce((sum, a) => {
      let d = 0;
      for (const t of item.tags) d += a.affinities[t] ?? 0;
      return sum + Math.max(0, d) * a.spawn_weight;
    }, 0);
    return Math.max(0, margin) * (0.5 + pull);
  };

  // The single best move in the shop, not the first one that qualifies. A
  // `find` would walk the shelves in layout order and spend the trip on
  // whichever poor spot happened to be listed first, which over a day is a
  // crew shuffling the tail of the range around while the best seller sits in
  // the corner. One pass, one decision.
  let best = null;
  for (const shelf of game.layout.shelves) {
    if (busy.has(key('shelf', shelf.id))) continue;
    if (!game.handMayTouch(shelf)) continue;
    const from = game.spotScore(shelf);
    for (const stack of game.shelfStacks(shelf)) {
      if (kept(shelf).includes(stack.item_id)) continue;
      if (!(stack.qty > 0) || stack.qty > hands) continue;   // one trip, as Merge insists
      const item = c.byId.items[stack.item_id];
      if (!item) continue;
      const value = worth(item);
      if (!(value > 0)) continue;
      /**
       * Every unit that would legally take it — and NOT `shelvesFor`, which is
       * the one non-obvious line in this function.
       *
       * `shelvesFor` answers "where does the shop keep this", and since
       * `Game.homeShelves` it answers with the item's ONE home. That is right
       * for every other caller — it is what stopped an item quietly acquiring a
       * second board and the shop buying for both — and it makes a rearrange
       * impossible by construction: the only unit it ever offers is the one the
       * stock is already on. The whole verb read as doing nothing.
       *
       * So the legality question is asked directly. `boardFor` is the same test
       * `stockShelf` and `stockFromCrate` use, which is what keeps the walk
       * honest: a hire never sets off for a unit the press would refuse.
       *
       * Bypassing the home rule is safe HERE and nowhere else, and the reason
       * is the `stack.qty > hands` guard above: this moves the WHOLE board and
       * `clearStack` takes the old one away, so the item has exactly one home
       * before and exactly one after. It moved. Anything that could move PART
       * of a board would be opening the second-home spiral by the back door.
       */
      const sorted = game.layout.shelves
        .filter((sh) => sh.id !== shelf.id && !busy.has(key('shelf', sh.id)))
        // Front stays front. A shopper cannot see a back-of-house unit, so
        // "move it somewhere better" across that line is moving it out of the
        // shop — and `spotScore` would happily rate a quiet stockroom against
        // the floor, because nobody walks in there either.
        .filter((sh) => (sh.boh === true) === (shelf.boh === true))
        .filter((sh) => game.handMayTouch(sh) && !kept(sh).length)
        .filter((sh) => game.boardFor(sh, item).ok && game.shelfCapacity(sh, item) >= stack.qty)
        .sort((a, b) => game.spotScore(b) - game.spotScore(a));
      for (const sh of sorted) {
        const to = game.spotScore(sh);
        if (to < from * need) break;              // sorted, so the rest are worse
        // Ranked on what the move is WORTH, which is the gain in spot times how
        // much the shop cares about the item. A tin of beans moving from a dead
        // corner to a good one and the best seller in the shop doing the same
        // are not the same trip, and a crew with one pair of hands has to pick.
        const gain = value * (to - from);
        if (!best || gain > best.gain) best = { shelf, stack, to: sh, gain };
        break;                                   // sorted by spot; the head is the best this pile can do
      }
    }
  }
  if (!best) return false;

  claim(s, 'shelf', best.shelf.id);
  if (!goToShelf(game, s, best.shelf)) return true;
  const res = game.unshelve(s.id, best.shelf.id, best.stack.item_id);
  if (!res.ok) { s.cooldown = 1; return true; }
  if (res.left <= 0) game.clearStack(best.shelf, best.stack.item_id);
  // The same second leg Clear and Merge use. `deliver` re-tests the target on
  // arrival, which matters more here than anywhere: this is the one verb whose
  // target was chosen for a reason that can change while you walk.
  s.shifting = { to: best.to.id };
  s.cooldown = paceOf(s);
  return true;
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
  if (!goToShelf(game, s, shelf)) return true;
  const res = game.stockShelf(s.id, shelf.id);
  // Full, sold back, reserved for something else while we walked. Hand it to
  // the rest of the job list rather than carrying it back.
  s.shifting = null;
  s.cooldown = res.ok ? paceOf(s) : 1;
  return true;
}

/**
 * Work the beds: pick what is ripe, sow what is turned, turn what is rough.
 *
 * The one farm directive, and the order in it is the whole of what used to be
 * expressed by giving three jobs three weights. It is not a preference: picking
 * frees a bed to grow the next lot and puts goods on a shelf, sowing is one
 * action away from producing, and breaking new ground is the only one of the
 * three that produces nothing at all — which is why `till` already refused to
 * run while a turned bed sat waiting for seed, three steps before this existed.
 * That guard is the same rule said about two of the three; this says it about
 * all three.
 *
 * Each step still guards itself and each returns false *before* claiming
 * anything, so falling from one to the next costs nothing and cannot leave a
 * hire holding a target they are not walking to.
 */
function farm(game, s) {
  return collect(game, s) || harvest(game, s) || sow(game, s) || till(game, s);
}

/**
 * Empty the pens.
 *
 * First in the fold, above picking, and the order is the same argument the fold
 * itself makes about `harvest` over `sow` over `till`: a full pen has STOPPED —
 * `stepPens` accrues nothing while it is at capacity — where a ripe bed simply
 * sits there. So collecting is the one farm job that puts something back into
 * production, and doing it after the picking means a shop with a big field never
 * gets to the animals at all.
 *
 * `hasSomewhere` and not `hasHome`, for `harvest`'s reason exactly: this is a
 * job that produces goods the shop did not pay for, so the drop-off is the
 * buffer and the pen is the overflow behind it. A pen left full costs the shop
 * nothing but the pen.
 */
function collect(game, s) {
  if (s.carry) return false;
  const c = content();
  const spoken = inbound(game, s);
  const busy = claimed(game, s);
  const full = pickNearest(s, game.layout.pens ?? [], (pn) => (pn.qty ?? 0) > 0
    && !busy.has(key('pen', pn.id))
    && hasSomewhere(game, game.penMakes(pn)?.item_id, c, spoken));
  if (!full) return false;
  claim(s, 'pen', full.id);
  if (!goTo(game, s, full.useAt ?? full)) return true;
  game.collectPen(s.id, full.id);
  s.cooldown = paceOf(s);
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
  // Every turned bed is the same job, so which one is a question about the walk
  // and nothing else — see `pickNearest`. Without a rung that says so this is
  // `plots.find(...)`, which takes bed 1 from the far end of the field.
  const bed = pickNearest(s, game.layout.plots, (p) => !p.crop_id && p.soil === 'tilled'
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
  // Ripe is ripe: nothing here rates one bed above another, so the only thing
  // left to choose on is the walk. `pickNearest` keeps the short-circuit for a
  // rung that has not paid for this, which matters more here than in `sow` —
  // `hasSomewhere` walks the shelves, and this would otherwise ask it of every
  // ripe bed in the field on every draw.
  const ripe = pickNearest(s, game.layout.plots, (p) => p.ready && !busy.has(key('plot', p.id))
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
  //
  // Over every TRAY rather than every machine: a twin's two heads are two
  // trays, and a sweep that read one of them would service a twin machine half
  // as often as it fills — which reads as a chef ignoring a full tray that is
  // plainly standing there.
  const trays = stations.flatMap((st) => game.stationSlots(st)
    .filter((slot) => slot.output)
    .map((slot) => ({ st, out: slot.output })));
  const done = trays
    .sort((a, b) => b.out.qty - a.out.qty)
    .find(({ out }) => shelfFor(game, out.item_id, c, spoken));
  if (done) {
    claim(s, 'station', done.st.id);
    if (!goTo(game, s, done.st.useAt)) return true;
    game.collectStation(s.id, done.st.id);
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
      // Room for what a head is SET to make, on that head's own tray. Asked of
      // every recipe a machine knew, one with a tray full of salsa still read as
      // hungry because there was room for a smoothie — so the chef kept fetching
      // for a batch that could never start. Any head that could run is enough:
      // a twin with one blocked tray is still a machine worth walking to.
      //
      // …and room in the SHOP for what comes out of it. Room on the tray only
      // says the machine can physically start; it says nothing about whether
      // anybody wants what it makes, and a tray is emptied by the job above.
      return game.stationHeads(st).some((head) => head.recipe
        && game.stationTrayRoom(st, head) >= head.recipe.output_qty
        && hasHome(game, head.recipe.output_id, c, spoken));
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
        const crate = game.floorCrates().find((d) => lotQty(d, input.item_id) > 0
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
      // `goTo` and not `goToShelf`, which is the one shelf approach in the file
      // that stays. The line below takes the goods by hand rather than through a
      // `Game` verb, so there is no `near` to disagree with and nothing here can
      // stall — the test for `goToShelf` is whether the next line is gated on
      // reach, not whether a shelf is involved. Move this and you widen a fetch
      // by half a tile to fix a deadlock it does not have.
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
/**
 * RUN THE BACK: fill the stockrooms off the dock, and the shelves off the
 * stockrooms.
 *
 * One directive rather than two, for the reason `farm` is one: these are two
 * steps of a single loop and nobody has ever wanted the first without the
 * second. A hire told only to fill rooms is a hire building a pile in a room —
 * which is the "a job that puts something down is not finished until nothing
 * picks it back up" trap, arriving as a stockroom that silently becomes a
 * second, worse yard.
 *
 * What it is FOR is the walk. Every case in the shop comes off one dock, so in
 * a big building the trip from the bay to the far aisle is paid once per
 * armful, and what you watch is the whole crew strung out in single file
 * carrying six things each. A runner pays that trip once per CRATE — on the
 * shoulder, which is what `p.haul` is for and why the long leg is the one that
 * wants it — and the shelves are then refilled from a room a few tiles away.
 *
 * The order inside it is not tunable, and it is the opposite of `farm`'s. The
 * FLOOR comes first: a bare board is money not being taken, where a thin
 * stockroom is only a walk somebody will make later. So leg B is asked first
 * and leg A is what a runner does when the front of the shop is fed.
 *
 * Three things keep it from being a loop:
 *
 *   leg B only ever moves stock the way a shopper does — room to floor — and
 *   nothing in the game moves stock the other way except leg A, which sources
 *   crates and never shelves. `merchandise` cannot cross the line either
 *   (it filters `boh === boh`). So there is no pair of verbs that can pass a
 *   box back and forth.
 *
 *   leg B refuses the LARDER's own range unless the floor also wants it, or a
 *   runner walks the fryer's flour out to the shop and the chef fetches it
 *   back — two hires, both correct, undoing each other all afternoon.
 *
 *   and both legs need somewhere for the goods to actually GO before anybody
 *   sets off, which is `boardFor` in both cases rather than a second opinion.
 */
function ferry(game, s) {
  // Leg two of an errand already begun, exactly as `merchandise` opens — and
  // for the same reason, which is that a hire mid-errand IS a hire holding
  // something. `deliver` is shared rather than copied: it re-tests the target on
  // arrival, and a second version of that would be the copy that forgets to.
  if (s.shifting) {
    if (!s.carry) { s.shifting = null; return false; }
    return deliver(game, s);
  }
  if (s.carry) return false;
  const rooms = game.layout.shelves.filter((sh) => sh.boh === true && game.handMayTouch(sh));
  if (!rooms.length) { s.ferryTo = null; return false; }
  const c = content();
  const busy = claimed(game, s);
  const kept = (sh) => (Array.isArray(sh.assigned) ? sh.assigned : (sh.assigned ? [sh.assigned] : []));

  /**
   * Already carrying the box: finish the trip it was lifted for.
   *
   * This is why leg A cannot simply hand the crate back to the job list.
   * `stepStaff` sends ANY haul straight to `unload`, which finds it a shelf by
   * `shelvesFor` — and a floor board is a perfectly legal answer, so the box a
   * runner lifted to stock the back room gets carried to the front of the shop
   * instead. The job would look like it worked, and the rooms would stay empty.
   *
   * `ferryTo` is the errand, and it is a FIELD rather than a flag on the haul
   * for the reason `s.haul` is not a flag on `s.carry`: every existing reader of
   * a shouldered crate goes on asking what it asks and never has to learn that
   * one of them is spoken for.
   *
   * It falls through to `unload` rather than insisting, and that is the same
   * guarantee `stepStaff`'s haul branch exists to give: a room torn out, marked
   * back to shop floor, or filled while somebody walked must never leave a crate
   * welded to a shoulder for the rest of the shift.
   */
  if (s.haul) {
    const room = s.ferryTo ? rooms.find((sh) => sh.id === s.ferryTo) : null;
    if (!room) { s.ferryTo = null; return false; }
    claim(s, 'shelf', room.id);
    if (!goToShelf(game, s, room)) return true;
    const res = game.stockFromCrate(s.id, room.id);
    // Spent either way: what would not fit is an ordinary crate on a shoulder
    // now, and `unload` knows what to do with one of those.
    s.ferryTo = null;
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }

  // ---- Leg B: a room with stock the floor is short of. Asked first, see above.
  if (!s.haul) {
    const larder = game.larderRanges();
    let best = null;
    for (const room of rooms) {
      if (busy.has(key('shelf', room.id))) continue;
      for (const stack of game.shelfStacks(room)) {
        if (!(stack.qty > 0)) continue;
        // The kitchen's, and the floor does not want it. Leaving this out is
        // two hires undoing each other — see above.
        const forKitchen = larder?.get(room.id)?.has(stack.item_id) === true;
        const item = c.byId.items[stack.item_id];
        if (!item) continue;                       // deleted out from under us
        const to = game.layout.shelves.find((sh) => sh.boh !== true
          && !busy.has(key('shelf', sh.id))
          && game.handMayTouch(sh)
          && game.homedAt(sh, stack.item_id)
          && game.boardFor(sh, item).ok
          && game.shelfCapacity(sh, item) > 0);
        if (!to) continue;
        if (forKitchen && !kept(to).includes(stack.item_id)
          && !game.shelfStack(to, stack.item_id)) continue;
        // The board the FLOOR is shortest of, so a runner with one pair of
        // hands spends them on the emptiest thing rather than on whichever
        // room happened to be listed first.
        const short = game.shelfCapacity(to, item) - (game.shelfStack(to, stack.item_id)?.qty ?? 0);
        if (!best || short > best.short) best = { room, stack, to, short };
      }
    }
    if (best) {
      claim(s, 'shelf', best.room.id);
      if (!goToShelf(game, s, best.room)) return true;
      const res = game.unshelve(s.id, best.room.id, best.stack.item_id, { max: carryOf(s) });
      if (!res.ok) { s.cooldown = 1; return true; }
      if (res.left <= 0) game.clearStack(best.room, best.stack.item_id);
      // The same second leg `merchandise` uses, and for the same reason: the
      // target is re-tested on arrival, because the shop moves while you walk.
      s.shifting = { to: best.to.id };
      s.cooldown = paceOf(s);
      return true;
    }
  }

  // ---- Leg A: a crate off the dock into the room that serves it.
  //
  // Whole-crate on the shoulder and never an armful: the whole point of the job
  // is that the long walk is paid once per BOX, and `unload` already covers the
  // armful case for anybody whose directive says to do it.
  const reserve = game.stockroomRanges();
  const takes = (sh, k) => {
    const item = c.byId.items[k.item_id];
    if (!item || !(k.qty > 0)) return false;
    // Ticked onto the room, or in the range the room serves — the same override
    // `shelvesFor` and `restock` apply, said here because this is the third
    // place that decides what a back room is for.
    if (!kept(sh).includes(k.item_id) && reserve?.get(sh.id)?.has(k.item_id) !== true) return false;
    return game.boardFor(sh, item).ok && game.shelfCapacity(sh, item) > 0;
  };
  const roomFor = (d) => rooms.find((sh) => !busy.has(key('shelf', sh.id))
    && lotStacks(d).some((k) => takes(sh, k)));
  // Any box a room will take is the same trip, so which one is a question about
  // the walk and nothing else — `pickNearest`, which is `find` exactly for a
  // rung with no `routes`. It matters more here than anywhere it is already
  // used: a runner's whole job is the length of the walk to the dock.
  const crate = pickNearest(s, game.stockCrates(), (d) => !d.waste
    && !busy.has(key('crate', d.id))
    && onAPad(game, d) && game.crateOnTop(d) && !!roomFor(d));
  if (!crate) return false;
  const room = roomFor(crate);
  if (!room) return false;
  claim(s, 'crate', crate.id);
  if (!goTo(game, s, crate, 1.4)) return true;
  const got = game.liftCrate(s.id, crate.id);
  // Named on the way up, or the tick after this one is `stepStaff` handing the
  // box to `unload` — see the haul branch at the top.
  if (got.ok) s.ferryTo = room.id;
  s.cooldown = got.ok ? paceOf(s) : 1;
  return true;
}

const JOBS = {
  serve, restock, unload, shelve, tidy, merchandise, farm, craft, ferry, guard,
};

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
 * neither of them had. `restock` has always asked its own version — `homeSupply`
 * against a board's room, the whole subject of docs/ordering.md — and the shop's
 * own two sources of stock were exempt, so "the shop stops buying what it
 * already has" sat next to a kitchen and a farm that did not.
 *
 * Two questions, in the order that makes them cheap:
 *
 * - **Is a crate of it already standing at the drop-off?** Then the answer is
 *   shelve that, not make another. A boolean is right HERE and was wrong in
 *   `restock` (see the retired `atTheBay` set), and the difference is that
 *   producing is a decision about one batch you are about to start rather than
 *   about a quantity to send a van for. It is what stops a chef and a stocker
 *   taking turns building a pile.
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
/**
 * Buy what a stopped appliance is short of, through the ordinary supplier.
 *
 * The whole design is in the trigger rather than in the buying: this may only
 * fire for an input the shop has **none of anywhere** — not on a board, not in
 * a crate, not in the hopper, not in somebody's hands and not on the van. That
 * is what makes it safe to ask before the shelves, and it is self-silencing:
 * `homeSupply` counts a pending order from the tick it is placed, so the first
 * van settles it and this goes quiet until the machine runs dry again. A rule
 * of "top the larder up" instead would compete with every board in the shop for
 * the same budget, on the shop that has the most boards.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not choose a recipe**, so `orders.assign` does not gate it. That
 *   switch is the shop choosing your *range*, and the range here is a thing you
 *   set on the machine yourself — buying flour for an oven you pointed at bread
 *   is topping up a board you filled, not picking your stock for you.
 * - **It does not order for a machine with nowhere to send the result.**
 *   `hasHome` is the same gate `craft` uses to decide whether to feed one at
 *   all, and without it a kitchen whose output has no board buys ingredients
 *   for ever — the endless-goods bug with a receipt attached.
 * - **It buys one batch, not a hopper full.** `stationHopperRoom` is the cap,
 *   but a run of them is what `homeSupply` cannot see coming: the point is to
 *   unstick the machine, and the second batch is an ordinary restock decision
 *   made once there is a board of the stuff.
 */
function larderOrder(game, s, c, budget, yard = Infinity) {
  const spoken = inbound(game, s);
  // Every head of every machine. A second head is a second thing the shop has
  // been told to make, and a loop that stopped at the first would buy for the
  // coffee and never for the hot chocolate — which reads as the shop having
  // ignored half of a decision you took in one press.
  for (const st of game.layout.stations ?? []) {
    for (const r of game.stationRecipes(st)) {
      if (!r) continue;
      if (!hasHome(game, r.output_id, c, spoken)) continue;
      for (const input of r.inputs) {
        const id = input.item_id;
        const item = c.byId.items[id];
        if (!item) continue;
        const rule = game.itemRule(id);
        if (rule.auto === false) continue;
        // An ingredient the shop can make is one the shop makes. The same guard
        // `restock` grew for the same reason, and it bites harder here: a chain
        // is exactly the case where one machine's output is the next one's
        // input, so an unguarded larder would answer every deep recipe by
        // buying the intermediate — the mixer fed dough off the van, the mill
        // idle beside it, and the chain that docs/production.md exists to make
        // worth building paid for and never used.
        if (game.makesHere(id)) continue;
        // ...and the same veto, because this path spends money too. An
        // ingredient the shop has given up on strands exactly as a product
        // does: `shelvesFor` refuses a dropped item BEFORE it asks about
        // larders, so nothing carries it to the machine and the crate stands in
        // the yard. Half a rule is what caused this, so it is not left
        // half-applied.
        if (givenUp(game, id)) continue;
        // Everywhere the goods could already be. `itemHeld` is the boards,
        // `homeSupply` is the crates, the hands, the beds and the van, and the
        // hopper is the one place neither of them looks — a machine part-loaded
        // with bread is not a machine short of bread.
        // `contents` is a plain {itemId: qty} hopper rather than a lot — read it
        // as one, or a part-loaded machine reads as empty and orders again.
        const have = game.itemHeld(id) + game.homeSupply(id) + (st.contents?.[id] ?? 0);
        if (have >= input.qty) continue;
        const room = game.stationHopperRoom(st, id);
        let qty = Math.min(Math.max(input.qty, 0) * 2, room);
        if (rule.max > 0) qty = Math.min(qty, rule.max - game.itemHeld(id) - game.homeSupply(id));
        const unit = wholesalePrice(item, game.folded(), game.season);
        // ...and what the yard will take, for `restock`'s reason. It bites far
        // less often here — a hopper's room is small, so these orders are small
        // — but the failure is identical and silent: a refusal is `continue`,
        // so a full yard would stop the kitchen being fed rather than feeding
        // it late, and a machine that never runs is what that reads as.
        qty = Math.min(qty, Math.floor(budget / Math.max(unit, 0.01)), yard);
        if (qty <= 0) continue;
        if (!game.buyStock(s.id, id, qty).ok) continue;
        s.cooldown = paceOf(s);
        return true;
      }
    }
  }
  return false;
}

/**
 * Somewhere for a batch to GO, which is the only brake the kitchen has.
 *
 * Exported for `Game.armTake`, the way `givenUp` is exported for the shop's own
 * buying — a predicate about the shop that two callers have to answer
 * identically or one of them is a rule the other quietly ignores.
 *
 * That is exactly what happened. `nextBatch` starts a batch on ingredients and
 * tray room alone; the *stall* is what stops a machine, and only a chef clearing
 * the tray un-stalls it — so this was the gate on production, applied by the
 * person doing the clearing. Bolt a loader to the same machine and it empties
 * the tray on its own, `nextBatch` fires again, and the brake is gone: a
 * live shop reached **200 units of toast** in the yard against 16 on a shelf,
 * with every conveyor working perfectly and every hire visibly busy.
 */
export function hasHome(game, itemId, c, spoken = null) {
  if (!itemId) return false;
  if (game.stockCrates().some((d) => lotQty(d, itemId) > 0)) return false;
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
  // are unaffected (`stockShelf` never reads it) — the shop giving up is a
  // judgement about its own range, which is the line `orders.assign` draws.
  //
  // **A RESERVATION OUTRANKS IT, and that has to be asked HERE.** `assignShelf`
  // clears the mark when you tick a board, which reads like the whole answer
  // and is only the answer for that ordering: mark first, tick second. Every
  // other way round leaves a shop refusing to fill a board with the item's own
  // name on it — and there is no shortage of ways round, because the mark can
  // be re-set by a hand-clear elsewhere, ride in on a save, or be set while the
  // reservation already existed. What that presents as is the one thing a
  // player cannot argue with: "I have a shelf for coffee and the shop will not
  // put the coffee on it", with nothing on screen connecting it to a judgement
  // the shop made about a different board four days ago. Found on a live save
  // holding 58 units of jam, peas and coffee on the floor, boards ticked for
  // two of them, and a crew stood around with nothing to do.
  //
  // Clearing it rather than merely ignoring it is deliberate, and it is
  // `assignShelf`'s own argument: a shop carrying "we don't stock that" against
  // something it is actively shelving is a state nothing else in here would
  // ever say out loud, and it would go on showing in the supplier's `Not
  // stocking` tab while the board filled up behind it.
  if (game.droppedItem(itemId)) {
    if (!game.keptFor(itemId)) return [];
    game.stockAgain(itemId);
  }
  // One place, and the shop decides where — `Game.homeShelves`, which lives
  // there rather than here for the reason `restockQueue` does: which unit an
  // item is kept on is a fact about the shop and about what the player ticked.
  //
  // This used to be only a preference — the sort below still ranks the unit
  // already holding it first — and a preference is not a rule the moment that
  // unit fills up. The next armful claimed a bare board next door, and the shop
  // had two homes for one thing for good: each is its own line in
  // `restockQueue`, so it then bought for both.
  //
  // The sentence that used to end this paragraph — "goods with nowhere to go
  // are not stranded by this, they go back to the pad" — was true of an ARMFUL
  // and false of everything already on the pad, which is where the goods this
  // refuses actually are. Nothing lifts a crate no shelf will take (`unload`
  // asks `roomAcross` before it bends down), so a full home meant that item's
  // crates stood in the yard until something sold. Five items at once on a real
  // save, a dozen legal shelves standing empty behind them, and a crew with
  // nothing to do parked alongside — every refusal correct, the sum of them a
  // shop that had stopped working.
  const homes = game.homeShelves(itemId);
  // So the rule binds while it CAN. A home with no room left has nothing to
  // keep together, and goods the shop has already paid for may overflow onto
  // any other legal unit — see `Game.homeFull` for why this does not hand the
  // spread bug back. Per SIDE and hoisted out of the filter: it walks the
  // shelves, and this function is asked per pile per worker per tick.
  const spill = {
    floor: game.homeFull(itemId, false, homes),
    back: game.homeFull(itemId, true, homes),
  };
  // ...and the same sentence about the back room, walked ONCE rather than per
  // shelf: every larder's range is one pass over the machines, and this function
  // is asked per pile per worker per tick. A stockroom is the kitchen's larder,
  // so nothing the machines beside it cannot use is walked in there — see
  // `Game.larderRanges`.
  const backTakes = game.backRanges();
  const usable = game.layout.shelves.filter((sh) => {
    if (shelfKind(sh.kind) !== home) return false;
    // ...unless you TICKED that unit for it, which is the override every other
    // judgement the shop makes about its own range already bows to — the same
    // one `droppedItem` and `homedAt` honour. A stockroom kept for what the
    // kitchen makes is a real thing to want, and `verify:kitchen` authors
    // exactly it: the tray has to come out onto a board somebody reserved.
    if (!kept(sh).includes(itemId) && !game.backRoomTakes(sh, itemId, backTakes)) return false;
    // Not the unit the shop keeps this on. Your own hands are unaffected
    // (`boardFor` never reads it) and ticking a second shelf for it makes that
    // one a home too, which is the whole override. Waived once the home is out
    // of room, which is the only state in which this rule was refusing goods
    // rather than gathering them.
    // On the SHOP FLOOR a spill tops up and never opens a board. Otherwise a
    // farm behind it turns every bare sales unit into carrots and consumes the
    // range. In the BACK, opening the next board is precisely what the fixture
    // was marked for: reserve capacity. That distinction is also what keeps a
    // belt from ejecting a paid-for crate beside an empty stockroom unit while
    // preserving one visible home for the item out front.
    const side = sh.boh === true ? 'back' : 'floor';
    if (!game.homedAt(sh, itemId, homes)
        && !(spill[side] && (side === 'back' || game.shelfStack(sh, itemId)))) return false;
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
  // NO SPOT TERM IN THIS SORT, and that is a measurement rather than an
  // oversight. Ranking the day-to-day stocking order by `spotScore` reads as
  // the obvious place to put it and cost **-72% mean profit over three seeds**
  // against one frozen world — one seed lost a quarter of its units sold.
  //
  // The reason is that this sort decides where an item's stock LANDS, every
  // delivery, for ever. Footfall drifts, so the order drifts with it, and an
  // item whose best-ranked unit changed on Tuesday starts a second home on a
  // shelf it has never been on — which is the "one item, two homes" spiral
  // `Game.homeShelves` exists to close, arriving by a new route. Every step is
  // a worker correctly shelving goods on a unit with room.
  //
  // Where a spot may be read is anywhere the answer cannot churn: at the point
  // of SALE (`boardPull`, `spotScore` — the shelf is already stocked, so the
  // reading changes nothing about where goods go), when choosing what to put
  // on a BARE board (`pickItem`'s endcap term — it fires once and the board is
  // then stocked), and in `rearrange`, which has hysteresis precisely so it
  // cannot chase a drifting number.
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
  //
  // Counted per SIDE, which is the same split `homeShelves` makes and for the
  // same reason: a stockroom board backing up what is out front is the one
  // second home that is the point rather than the bug. Counted shop-wide, the
  // back room could only ever take an ingredient nobody sells — and tomatoes on
  // the shop floor is exactly what a salsa maker's larder wants more of, so the
  // rule above would have found nothing left to choose and the stockroom would
  // have stayed bare. That reads as the same bug wearing the opposite face.
  const already = new Set(game.layout.shelves
    .filter((sh) => (sh.boh === true) === (shelf.boh === true))
    .flatMap((sh) => [
      ...game.shelfStacks(sh).map((k) => k.item_id),
      ...(Array.isArray(sh.assigned) ? sh.assigned : [sh.assigned]),
    ]).filter(Boolean));

  /**
   * A unit by the till gets stocked with what a unit by the till is FOR.
   *
   * `impulseBuy` has made a board within `IMPULSE_RADIUS` of a checkout worth
   * more than an ordinary one since endcaps existed — a shopper in the queue
   * takes one off-list look at whatever is stacked beside them, weighted by
   * `impulsePull`. Nothing told the shop, so the one function whose job is
   * choosing the range scored every shelf identically and cheerfully filled the
   * best spot in the building with dried pasta.
   *
   * That is not a bug anything reports. The shelf fills, the goods sell at
   * their ordinary rate, and the endcap simply never pays — so the mechanic
   * that exists to make *placement* worth money only ever worked for a player
   * who had found it by hand and ticked the sweets on themselves.
   *
   * It is the SAME `impulsePull` the sale reads, so the shop cannot stock a
   * board on one opinion and then price it on another. Away from a till the
   * multiplier is 1 and this function is exactly what it was — which is most
   * shelves in most shops, and is what keeps the endcap a *spot* rather than a
   * new rule about the range.
   *
   * **It can only ever promote**, which is why the clamp is there and not a
   * tidy-up to remove later. `impulsePull` runs below 1 for the things nobody
   * grabs on the way past — a sack, a truffle — and multiplying by 0.3 would
   * push those off the endcap. But an impulse is a sale ON TOP of the ordinary
   * one: a sack of flour by the till still sells exactly as well as a sack of
   * flour anywhere else, it simply gains nothing extra. Demoting it would be
   * the shop refusing a spot for a cost that does not exist.
   *
   * Deliberately not scaled by how many tills are nearby: two checkouts either
   * side of one unit is one queue's worth of eyes on it, near enough, and
   * counting them would make a bank of six self-checkouts the only place the
   * shop would ever stock anything.
   */
  const nearTill = (game.layout.checkouts ?? []).some((t) => Math.hypot(shelf.x - t.x, shelf.z - t.z) <= IMPULSE_RADIUS);
  const endcap = (it) => (nearTill ? Math.max(1, impulsePull(it)) : 1);

  // What a stockroom is FOR, and the reason this function needed telling at all.
  // It scores by margin × who wants it, which is the shop floor's question — so
  // a unit you marked as the back room was filled with whatever sells well out
  // front, where no shopper could ever see it and no machine could use it.
  // Walked once for the whole scoring pass; null on an ordinary shelf, and in
  // any shop with no appliance, which `backRoomTakes` reads as "no rule yet".
  const backTakes = shelf.boh === true ? game.backRanges() : null;

  const scored = c.items
    .filter((it) => {
      // A recipe in the catalogue is not production in this shop. If there is
      // no chef working a matching appliance, the supplier treats the item as
      // ordinary stock and may fill both its sales board and its reserve.
      if (game.makesHere(it.id)) return false;
      if (!game.backRoomTakes(shelf, it.id, backTakes)) return false;
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
      return { it, score: margin * (0.5 + pull) * endcap(it) };
    })
    .sort((a, b) => b.score - a.score);

  // Spread across the RANGE rather than putting the same winner everywhere —
  // and answer nothing at all when the range is already on the shelves.
  //
  // The fallback used to be `?? scored[0]`, which is the best-selling item in
  // the shop, and it fired precisely when every item that fits this unit was
  // already stocked somewhere. That was a second board for the winner, chosen
  // deliberately, by the one function whose whole job is deciding the range —
  // so the shop bought a second shelf of the thing it already sold most of.
  // Since `shelvesFor` now sends that item home instead, the goods would land
  // on the pad and stay there. A bare unit with nothing new to put on it is a
  // bare unit; that is a shop with room to grow, not a shelf of duplicates.
  const fresh = scored.find((x) => !already.has(x.it.id))?.it;
  // A second copy on the shop floor is accidental range spread. A second copy
  // in the stockroom is the feature: once one reserve unit is full, another
  // compatible empty one is additional depth for the same line.
  return fresh ?? (shelf.boh === true ? scored[0]?.it ?? null : null);
}

/**
 * Ingredients this appliance could still use — the inputs of the recipes it is
 * set to, and nothing else. `loadStation` refuses the rest, so a chef holding
 * an armful for a recipe the machine is no longer set to would otherwise walk
 * it over, be refused, and go straight back to walk it over again.
 *
 * The union over its heads, which is the same set `loadStation` accepts. Half
 * of it would be a chef who never fetches for the second head.
 */
function wants(game, st) {
  return new Set(game.stationRecipes(st)
    .flatMap((r) => (r?.inputs ?? []).map((i) => i.item_id)));
}

/**
 * A recipe this appliance is set to, IF the chef could actually finish it —
 * every missing ingredient has to be sitting on a shelf somewhere.
 *
 * It used to choose between the machine's recipes, and the sort was there
 * because picking purely by "fewest items missing" deadlocks: the chef commits
 * to the nearly-complete recipe, discovers its last ingredient isn't stocked,
 * and never falls back to one it could have made. The choosing is the player's
 * now, so what is left is only the feasibility half — and answering null is
 * right rather than a deadlock: a chef with nothing to fetch for this machine
 * goes and does one of their other jobs.
 *
 * A machine with two heads is two candidates, and the old deadlock does not
 * come back with them: the walk down the heads stops at the first one that
 * could be finished *and* has somewhere to put the result, so a blocked head is
 * stepped over rather than committed to.
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
  for (const d of game.stockCrates()) {
    for (const k of lotStacks(d)) stock.set(k.item_id, (stock.get(k.item_id) ?? 0) + k.qty);
  }

  for (const head of game.stationHeads(st)) {
    const r = head.recipe;
    if (!r) continue;
    if (game.stationTrayRoom(st, head) < r.output_qty) continue;
    const possible = r.inputs.every((i) => {
      const need = i.qty - (st.contents[i.item_id] ?? 0);
      return need <= 0 || (stock.get(i.item_id) ?? 0) >= need;
    });
    if (possible) return r;
  }
  return null;
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
