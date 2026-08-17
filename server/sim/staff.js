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
import { isPadAt } from '../../shared/build.js';

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
const JOB_RUN = 4;          // consecutive repeats of one job before a re-draw
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
    // The first board nobody else is already walking a crate to, that will
    // actually take some of what is in it.
    //
    // `shelvesFor` ranks by what fits; `boardFor` is the real yes/no, and they
    // are not the same question — a unit can rank as legal and still be out of
    // free boards for this particular thing. Asking the game is what stops a
    // hire walking to a shelf that will refuse them and then doing it again.
    const taken = claimed(game, s);
    const shelf = shelvesFor(game, s.haul.item_id, c, spoken)
      .find((sh) => !taken.has(key('shelf', sh.id))
        && game.boardFor(sh, c.byId.items[s.haul.item_id]).ok);

    // Nothing will have the rest, so it goes back where crates live.
    //
    // Not down on the spot, which is what a shop full of abandoned boxes looks
    // like: a stray with nowhere to go is a stray nothing will lift, so it
    // stands there for the rest of the game. The pad terminates — goods leave
    // the yard when there is room and come back when there is not.
    if (!shelf) {
      const pad = game.dropPad();
      if (pad) {
        claim(s, 'pad', 'home');
        if (!goTo(game, s, pad)) return true;
      }
      game.dropCrate(s.id);
      s.cooldown = paceOf(s);
      return true;
    }

    // ...otherwise walk it over and POUR IT IN. The crate never touches the
    // floor: whatever will not fit stays on the shoulder for the next board,
    // and the same hire carries it there. One person, one crate, start to
    // finish — see `stockFromCrate` for what watching the other way round
    // actually looked like.
    claim(s, 'shelf', shelf.id);
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return true;
    const res = game.stockFromCrate(s.id, shelf.id);
    s.cooldown = res.ok ? paceOf(s) : 1;
    return true;
  }
  // Carrying already? Then this is a TOP-UP and not a new errand. A crate holds
  // an armful and hands hold an armful, so the two matched exactly for as long
  // as a hire's own `carry` was ignored — now a Stocker with big hands takes a
  // crate and a half in one trip instead of walking back for two units. Only
  // ever more of the same thing: mixed hands are what `stockShelf` refuses.
  const item = s.carry?.item_id ?? null;
  const held = s.carry?.qty ?? 0;
  if (item && held >= carryOf(s)) return false;

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

  // How much this trip actually moves: the shelves' room, this pair of hands,
  // and what is in the crate, whichever runs out first.
  const hands = carryOf(s);
  const fit = (d) => Math.min(roomFor(d.item_id).room, hands, d.qty + held) - held;

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
    if (item && d.item_id !== item) continue;
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
    if (moves >= MIN_TRIP * hands || bare(roomFor(d.item_id)) || stray) {
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
  const wholeCrate = !item
    && pallet.qty > hands
    && roomFor(pallet.item_id).room >= pallet.qty
    && onAPad(game, pallet);
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
  const { room } = roomAcross(game, from.item_id, c, spoken);
  for (const d of game.deliveries.slice()) {
    const held = s.carry?.qty ?? 0;
    if (held >= hands || held >= room) return;
    if (d.id === from.id || d.item_id !== from.item_id) continue;
    game.unload(s.id, d.id, Math.min(hands, room) - held);
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
  const shelf = shelfFor(game, s.carry.item_id, content(), inbound(game, s));
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
    const needing = stations.find((st) => wants(game, st).has(s.carry.item_id)
      && game.stationHopperRoom(st, s.carry.item_id) > 0);
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
        const crate = game.deliveries.find((d) => d.item_id === input.item_id && d.qty > 0
          && !busy.has(key('crate', d.id)));
        if (!crate) continue;
        if ((st.contents[input.item_id] ?? 0) >= game.stationHopperCap(st, input.item_id)) continue;
        claim(s, 'crate', crate.id);
        if (!goTo(game, s, crate, 1.4)) return true;
        const want = Math.min(game.stationHopperRoom(st, input.item_id), carryOf(s));
        const res = game.unload(s.id, crate.id, want);
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
  if (game.deliveries.some((d) => d.item_id === itemId && (d.qty ?? 0) > 0)) return false;
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
  const needsFreezer = item.tags.includes('needs-freezer') || item.tags.includes('frozen');
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
    if (needsFreezer && sh.kind !== 'freezer') return false;
    if (!needsFreezer && sh.kind === 'freezer') return false;
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
    if (d.item_id && d.qty > 0) stock.set(d.item_id, (stock.get(d.item_id) ?? 0) + d.qty);
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
