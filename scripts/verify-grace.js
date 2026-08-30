#!/usr/bin/env node
/**
 * VERIFY: THE FIRST WEEK, AND WHAT IT IS ALLOWED TO COST.
 *
 * A shop's opening week is the player learning where the buttons are, and until
 * `GRACE_DAYS` it was charged at the same rate as a shop that had been trading
 * for a year. A real `normal` save lost **0.253 of reputation on day one** — a
 * quarter of the whole scale — and the reason that matters is not the number
 * itself but what a number down there does to the people who then walk in:
 * `moodBase()` scales the room by reputation, and the way back up is
 * `0.008 * (mood - MOOD_ANNOYED)`, which is proportional to the headroom the low
 * reputation just took away. Six seconds in a queue before a shopper looks
 * cross, and forty-seven clean sales to pay off one walk-out.
 *
 * Nothing in here can be looked at, which is why it ships with the feature the
 * way `verify:price` and `verify:motion` did. A shopper who stormed out of a
 * day-1 shop and one who stormed out of a day-10 shop are the same still frame —
 * same person, same door, same abandoned basket — and the shop afterwards is the
 * same shop. Only the slowest number in the game moved, and it moved by an
 * amount nobody can eyeball.
 *
 * Its control is the assertion that decides whether this is opt-in or a change
 * to every save in existence: **a shop past `GRACE_DAYS` is the old game to the
 * digit**, on every cause, in both directions. Every existing save is played at
 * day 60, day 129, day 365, so if that control is wrong this file has quietly
 * rebalanced all of them.
 *
 * The rest:
 *
 * - **Losses only.** A gain is banked at face value from the first minute. That
 *   asymmetry is the entire feature — scaling both would be "the town has no
 *   opinion yet", which sounds better and makes the opening week inert, and a
 *   shop that cannot climb on day 1 is a shop that cannot dig itself out.
 * - **`R.SETTLED` is untouched**, which is the same claim pointed at the one
 *   mover that is a spring rather than an event. A new shop's floor must not be
 *   throttled by the thing protecting it.
 * - **It is a RAMP, not a flag.** Day 1, 2 and 3 must answer differently, or
 *   `GRACE_DAYS` is a boolean wearing an integer and every value above 1 does
 *   the same thing — the `packs` trap, said about a divisor.
 * - **Every cause**, swept over `REP_CAUSES` rather than a list written out by
 *   hand. A hand-written list is how a new way to lose the town's regard becomes
 *   the one that still craters a beginner, and it would pass every other
 *   assertion in this file.
 * - **The tally banks what LANDED.** `netRep(repMoves)` is what the report draws
 *   and the panel's total is arithmetic on its own bars, so a discount applied
 *   to the number and not to the receipt is a breakdown that explains less than
 *   all of the movement — with the difference growing on exactly the days a
 *   beginner is reading it.
 * - **The clamp still wins.** A shop already on the floor reports nothing
 *   further lost, graced or not, which is `moveRep`'s existing promise and the
 *   one place two reductions are applied to one delta.
 * - **End to end**, through the same beating twice: an identical run of losses
 *   on day 1 and on day `GRACE_DAYS` must differ by exactly the ramp, which is
 *   the only assertion here that would survive somebody reimplementing this at
 *   the nine call sites instead of at the one writer.
 *
 * Runs on ephemeral Games and writes nothing at all — no content rows, no save,
 * no cleanup. Every function it calls is the real one.
 *
 *   node scripts/verify-grace.js
 */

import { Game } from '../server/sim/index.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { R, REP_CAUSES, netRep } from '../shared/reputation.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const close = (a, b, label, tol = 1e-9) => check(Math.abs(a - b) < tol, label, `expected ~${b}, got ${a}`);

/**
 * The ramp restated rather than imported, deliberately.
 *
 * `GRACE_DAYS` is not exported and this file does not want it to be: importing
 * the constant would make every assertion below pass whatever that constant
 * becomes, which is the same trap `verify:economy` avoids by doing arithmetic on
 * a deliberately odd authored price rather than calling `fixtureUnitCost`. If
 * the ramp is ever retuned, this file is *supposed* to fail and be read.
 */
const DAYS = 5;

/**
 * ...and the second ramp, which is the one cause that starts later.
 *
 * `R.EMPTY` is waived while a new shop has no range to be let down by — three
 * shelves and nothing on them is what `createWorld` hands you — and then eases
 * in over the same `DAYS`. Restated here for the reason above, and the pair is
 * what makes the file able to tell a waiver from "the opening week is free":
 * `R.MISSED` is charged on the ordinary ramp on every one of the same days.
 */
const EMPTY_FREE = 3;

/** The first day on which every cause is at face value. */
const OLD = DAYS + EMPTY_FREE;

const graceOn = (day, cause) => {
  const from = cause === R.EMPTY ? EMPTY_FREE : 0;
  return Math.min(Math.max((day - from) / DAYS, 0), 1);
};

/** A shop with a day on it and nothing else. `moveRep` needs no layout. */
function fresh(day, rep = 0.5) {
  const g = Game.create({ worldId: 'verify-grace', seed: 'grace', ephemeral: true });
  silenceMilestones(g);
  g.day = day;
  g.reputation = rep;
  g.stats.repMoves = {};
  return g;
}

// ---------------------------------------------------------------------------
// 1. The control: past the ramp, this file changed nothing.
// ---------------------------------------------------------------------------
{
  // Every cause, at face value, on a shop old enough to have stopped being new.
  // Swept over the table rather than a list here, for the reason in the header:
  // an eighth cause added tomorrow is covered by this loop the day it exists.
  for (const c of REP_CAUSES) {
    for (const day of [OLD, OLD + 1, 60, 365]) {
      const g = fresh(day);
      const moved = g.moveRep(-0.03, c.id);
      close(moved, -0.03, `day ${day}: \`${c.id}\` is charged in full`);
      close(g.reputation, 0.47, `day ${day}: ...and lands on the number`);
    }
  }
  // ...and the gain, which was never discounted anywhere.
  const g = fresh(60);
  close(g.moveRep(0.03, R.SERVED), 0.03, 'a gain past the ramp is unchanged');
}

// ---------------------------------------------------------------------------
// 2. A loss inside the ramp is charged at the ramp, on every cause.
// ---------------------------------------------------------------------------
for (const c of REP_CAUSES) {
  for (const day of [1, 2, 3, 4]) {
    const g = fresh(day);
    const moved = g.moveRep(-0.1, c.id);
    close(moved, -0.1 * graceOn(day, c.id),
      `day ${day}: \`${c.id}\` is charged at ${graceOn(day, c.id)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. It is a RAMP, not a flag. Three distinct days, three distinct answers.
// ---------------------------------------------------------------------------
{
  const cost = (day) => {
    const g = fresh(day);
    return Math.abs(g.moveRep(-0.1, R.STORMED));
  };
  const [d1, d2, d3] = [cost(1), cost(2), cost(3)];
  check(d1 < d2 && d2 < d3, 'each day inside the ramp costs strictly more than the last',
    `got ${d1}, ${d2}, ${d3}`);
  // The specific shape, or "strictly increasing" is satisfied by any curve at
  // all — including one that is 0.99 on day 1 and does nothing a player feels.
  close(d1, 0.02, 'day 1 is a fifth of face value');
  close(d3, 0.06, 'day 3 is three fifths');
  close(cost(DAYS), 0.1, 'and the last day of the ramp is face value');
}

// ---------------------------------------------------------------------------
// 4. Losses only — the asymmetry that lets a new shop climb out.
// ---------------------------------------------------------------------------
{
  const g = fresh(1);
  close(g.moveRep(0.05, R.SERVED), 0.05, 'day 1: a happy customer is worth full price');
  // The one mover that is a spring rather than an event. It only ever pulls up,
  // so it is never a loss to discount — but a grace applied to the magnitude
  // rather than to the sign would throttle exactly the thing holding a new shop
  // off the floor, and it would look identical from outside.
  const s = fresh(1, 0.05);
  close(s.moveRep(0.09, R.SETTLED), 0.09, 'day 1: the settle spring pulls at full strength');
  // Asserted as a pair, or "gains are full price" passes on an implementation
  // that scales nothing at all.
  const l = fresh(1);
  check(Math.abs(l.moveRep(-0.05, R.STORMED)) < 0.05,
    '...while a loss on the same day is not');
}

// ---------------------------------------------------------------------------
// 5. The receipt matches the number.
// ---------------------------------------------------------------------------
{
  const g = fresh(2);
  const before = g.reputation;
  g.moveRep(-0.05, R.STORMED);
  g.moveRep(-0.02, R.EMPTY);
  g.moveRep(0.03, R.SERVED);
  close(netRep(g.stats.repMoves), g.reputation - before,
    'the breakdown adds up to the movement it explains');
  // And it is the DISCOUNTED figure that is banked, not face value: the report
  // answers "what is costing me", and what a walk-out cost you on day 2 is what
  // it actually took off the number.
  close(g.stats.repMoves[R.STORMED], -0.05 * graceOn(2, R.STORMED), 'the tally banks what landed');
}

// ---------------------------------------------------------------------------
// 6. The clamp still wins, which is the one place two reductions meet.
// ---------------------------------------------------------------------------
{
  const g = fresh(1, 0);
  close(g.moveRep(-0.5, R.STORMED), 0, 'a shop on the floor reports nothing further lost');
  check(!(R.STORMED in g.stats.repMoves), '...and opens no bucket for it');
  const top = fresh(1, 1);
  close(top.moveRep(0.5, R.SERVED), 0, 'and a spotless shop banks no more than spotless');
}

// ---------------------------------------------------------------------------
// 7. End to end: the same beating, twice.
// ---------------------------------------------------------------------------
{
  // A day's worth of a beginner's shop, in the proportions a real save produced:
  // missed staples, people leaving with nothing, and walk-outs.
  const beating = [
    [-0.008 * 4, R.MISSED],
    [-0.015, R.EMPTY], [-0.015, R.EMPTY],
    [-0.03, R.STORMED], [-0.03, R.STORMED], [-0.03, R.STORMED],
    [-0.0015 * 12, R.CROWD],
  ];
  const take = (day) => {
    const g = fresh(day);
    for (const [d, c] of beating) g.moveRep(d, c);
    return g;
  };
  const young = take(1);
  const grown = take(OLD);
  const lostYoung = 0.5 - young.reputation;
  const lostGrown = 0.5 - grown.reputation;
  // Summed per cause rather than scaled as one number, because there are two
  // ramps now: a single factor would have been the whole claim while `R.EMPTY`
  // rode the same curve as everything else, and it would go on passing today
  // only if the waiver did nothing.
  const expectYoung = beating.reduce((n, [d, c]) => n - d * graceOn(1, c), 0);
  close(lostYoung, expectYoung,
    'an identical day costs a new shop exactly the ramps of what it costs an old one');
  check(lostGrown > 0.1, 'and the day being measured is a genuinely bad one',
    `only lost ${lostGrown}`);
  // The claim in shop terms, which is the one worth reading in a year: the day
  // that cost a real save a quarter of the scale costs a beginner a twentieth.
  check(lostYoung < 0.05, 'a beginner survives the day that sank the real save',
    `lost ${lostYoung}`);
}

// ---------------------------------------------------------------------------
// 8. THE WAIVER, which is the one cause a new shop cannot do anything about.
//
// A new world is three shelves with nothing on any of them against a $250
// float, so the range a shopper is being let down by does not exist yet — and
// `R.EMPTY` is a FLAT toll per body, charged once per visitor whatever they
// wanted. Measured on the shop the game actually hands you, doors open on day
// one: 27 people in, 27 out with nothing, 0.500 → 0.401 *after* the ramp had
// already taken four fifths off.
//
// Every claim in here is invisible twice over. A shopper who walked out of a
// day-1 shop and one who walked out of a day-8 shop are the same person in the
// same doorway with the same empty hands, and the shop afterwards is the same
// shop — only the slowest number in the game moved, and it moved by an amount
// nobody can eyeball.
// ---------------------------------------------------------------------------
{
  const cost = (day, cause) => Math.abs(fresh(day).moveRep(-0.1, cause));

  // The waiver, and its PAIR — worthless split in half. "Nobody is charged for
  // an empty-handed leave while the shop is new" is satisfied by an opening
  // week in which no loss is charged at all, which is a different feature and
  // one that would make the first three days inert. `R.MISSED` on the very same
  // days is what says only one cause was waived.
  for (const day of [1, 2, EMPTY_FREE]) {
    close(cost(day, R.EMPTY), 0, `day ${day}: an empty-handed leave costs nothing`);
    close(cost(day, R.MISSED), 0.1 * graceOn(day, R.MISSED),
      `day ${day}: ...while a staple you had none of is still charged`);
    check(cost(day, R.MISSED) > 0, `day ${day}: ...and that is a real charge`);
  }

  // A waived charge opens no bucket, or the report draws a row saying a cause
  // took nothing off — which is a breakdown explaining a movement that never
  // happened, on exactly the days a beginner is reading it.
  const g = fresh(1);
  g.moveRep(-0.015, R.EMPTY);
  check(!(R.EMPTY in g.stats.repMoves), 'day 1: ...and no row appears on the receipt');

  // It REJOINS the ramp rather than switching back on. A flat window would be a
  // cliff — full price on day four with nothing about the shop having changed —
  // which is the `packs` trap said about a grace period, and "it is free for
  // three days" passes on it.
  const after = [EMPTY_FREE + 1, EMPTY_FREE + 2, EMPTY_FREE + 3].map((d) => cost(d, R.EMPTY));
  check(after[0] > 0 && after[0] < after[1] && after[1] < after[2],
    'and then eases in, a day at a time', `got ${after.join(', ')}`);
  close(after[0], 0.1 / DAYS, 'the first day it costs anything, it costs a fifth');
  close(cost(OLD, R.EMPTY), 0.1, 'and it is face value by the end of its own ramp');

  // The opening morning, in the shape it was measured in. The 27 leavers are
  // the whole complaint; the missed staples beside them are what the player is
  // still being told to fix.
  const morning = fresh(1);
  for (let i = 0; i < 27; i++) morning.moveRep(-0.015, R.EMPTY);
  close(morning.reputation, 0.5, 'a first morning of nothing but empty hands costs a new shop nothing');
  const old = fresh(OLD);
  for (let i = 0; i < 27; i++) old.moveRep(-0.015, R.EMPTY);
  check(0.5 - old.reputation > 0.35, '...and would have cost an established one the shop',
    `lost ${(0.5 - old.reputation).toFixed(3)}`);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ verify:grace — ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ verify:grace — ${checks} checks passed`);
