#!/usr/bin/env node
/**
 * VERIFY: A VERB DONE TO SIX THINGS HAPPENS TO ALL SIX, ONCE.
 *
 * Every fixture verb in the game took a single id, because until now the only
 * way to *name* a fixture was to open its menu. Several can be picked at a time
 * now, and the naive answer — send the message once per fixture — is wrong in
 * ways that are invisible in a screenshot by construction: six shelves restyled
 * one at a time and six shelves restyled together are the same six shelves
 * afterwards. What differs is everything around them.
 *
 * So the claims here are about the *middle* of the press rather than the end of
 * it, and the centrepiece is a claim about a NUMBER THAT MUST NOT GROW.
 *
 * - **One re-flow, not six.** `styleFixture` goes through `repositionFixture`,
 *   which re-runs the generator, rebuilds the walk grid, throws away every
 *   shopper's path and bumps `layoutVersion` — which on the client disposes the
 *   whole static scene and builds it again. `setBackOfHouse` argues its way out
 *   of doing that once for one flag; a bulk verb that did it eight times is the
 *   same mistake multiplied. It is not visible and it is not even slow enough
 *   to notice on six — it is a shop that stutters for a second on thirty.
 * - **…and it must actually happen.** A held re-flow that nothing ever fires is
 *   a shop that quietly does not update, which is the exact failure the hold
 *   introduces. So the version is asserted to move by exactly one: not zero,
 *   not six.
 * - **A batch applies to ALL of them.** `repositionFixture` re-mints the id of
 *   the fixture it moves, which is why a client sending N messages with ids it
 *   captured before the first one is a bug waiting for a re-flow. Asserted by
 *   value on every member, and against a control that was never picked.
 * - **The feed says it once.** Six lines of "the shelf is no longer kept for
 *   bread" is one event told six times — `endPull`'s argument about a gesture
 *   and `logRun`'s about a job loop, said about a selection.
 * - **A refusal in the middle does not stop the rest**, and a batch where
 *   *nothing* worked is an error rather than a silent success — that is the one
 *   case where the player has nothing else on screen to read.
 * - **A selection of one is the old path exactly**: no fold, no summary line,
 *   no held re-flow. Every press in the game that is not a bulk one goes
 *   through here now, so this is the assertion that stops bulk being a tax on
 *   ordinary play.
 *
 * Writes nothing to the content database: everything it needs is a stamped shop
 * and two authored-free verbs, so it authors no rows and cleans nothing up.
 *
 *   node scripts/verify-pick.js
 */

import { Game } from '../server/sim/index.js';
import { fixturesOf } from '../shared/build.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { content } from '../server/content.js';
import { pieceFor } from '../shared/pieces.js';
import { variantsOf } from '../shared/model.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * A stamped shop with a builder in it.
 *
 * Stamped, because a bulk verb is a thing you do to a shop you have furnished —
 * and because an unstamped one re-mints every generated id on the re-flow this
 * sweep is counting, which would make "did the selection survive" unanswerable
 * for reasons that have nothing to do with the selection.
 *
 * `fresh()`'s usual list plus `shell`, for the reason CLAUDE.md gives: a sweep
 * that leaves a shell behind asks a 10×9 shop to hold a 10×11 shop's shelving.
 */
function fresh(want = SHOP) {
  const g = Game.create({ worldId: 'verify-pick', seed: 'pick', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.shell = null;
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want });
  g.cash = 20000;
  g.freezeShell();
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  // Nothing else may write to the feed while a fold is being counted. A
  // milestone landing mid-batch would be a line this sweep blames on the batch.
  silenceMilestones(g);
  g.log = [];
  return g;
}

const shelvesOf = (g) => g.layout.shelves.filter((s) => s.kind === 'shelf');

// ---------------------------------------------------------------------------
// 1. A shelf setting done to a whole selection lands on every one of them.
//
// `assign` is the cheap half — it re-flows nothing — so this is the claim about
// coverage alone, with a control that was never picked.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelves = shelvesOf(g);
  check(shelves.length >= 4, 'the test shop has shelving to pick', `${shelves.length}`);

  const picked = shelves.slice(0, 3).map((s) => s.id);
  const control = shelves[3].id;

  const res = g.bulkFixtures(picked, (id) => g.setRestockPriority(id, 1),
    (n) => `${n} units moved in the refill queue.`);
  check(res.ok, 'a bulk setting is accepted', res.error ?? '');
  eq(res.done, 3, 'and reports how many it landed on');

  for (const id of picked) {
    eq(g.layout.shelves.find((s) => s.id === id).priority, 1,
      `every picked unit took it (${id})`);
  }
  eq(g.layout.shelves.find((s) => s.id === control).priority ?? 0, 0,
    'and the one nobody picked did not');
}

// ---------------------------------------------------------------------------
// 2. The feed says it ONCE.
//
// `setShelfHands` writes a line per shelf, which is right for the one press it
// was written for and six spellings of one event here.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const picked = shelvesOf(g).slice(0, 4).map((s) => s.id);

  g.log = [];
  const res = g.bulkFixtures(picked, (id) => g.setShelfHands(id, false),
    (n) => `${n} units left for you to arrange.`);
  check(res.ok, 'a bulk switch is accepted', res.error ?? '');
  eq(g.log.length, 1, 'four units changed, one line in the feed');
  check(g.log[0].msg.includes('4'), 'and the line says how many', g.log[0]?.msg ?? '');
  for (const id of picked) {
    eq(g.layout.shelves.find((s) => s.id === id).managed, false,
      `every picked unit changed (${id})`);
  }

  // ...and one is one. The single case must not grow a summary line: it would
  // read as the shop announcing a count nobody asked about, and it is every
  // press in the game that is not a bulk one.
  g.log = [];
  const one = g.bulkFixtures([picked[0]], (id) => g.setShelfHands(id, true),
    (n) => `${n} units left for you to arrange.`);
  check(one.ok, 'a selection of one is accepted');
  eq(g.log.length, 1, 'and writes exactly the one line the verb writes');
  check(!g.log[0].msg.includes('1 unit'), 'which is the verb\'s own sentence, not a count',
    g.log[0]?.msg ?? '');
}

// ---------------------------------------------------------------------------
// 3. ONE re-flow, and exactly one.
//
// The centrepiece. `layoutVersion` is what the client watches to decide whether
// to dispose the whole scene, so it is the honest measure of "how many times
// did the shop re-flow" — and both directions of wrong are failures: six is the
// cost this exists to avoid, and zero is a shop that silently did not update.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelves = shelvesOf(g);
  const picked = shelves.slice(0, 4).map((s) => s.id);

  // Whatever second shape this shop's shelving actually comes in. Read off the
  // catalog rather than named, for the reason above — and skipped honestly if
  // nobody has drawn one, rather than passing on a verb that did nothing.
  const f0 = g.findFixture(picked[0]);
  const want = variantsOf(pieceFor(content().fixtures ?? [], f0))
    .map((v) => v.id)
    .find((v) => v && v !== (f0.variant ?? ''));

  const before = g.layoutVersion ?? 0;
  const res = g.bulkFixtures(picked,
    (id) => (want ? g.styleFixture('me', id, want) : g.setRestockPriority(id, -1)),
    (n) => `Restyled ${n} fixtures.`);
  check(res.ok, 'a bulk restyle is accepted', res.error ?? '');
  eq(res.done, 4, 'and lands on all four');

  if (want) {
    eq((g.layoutVersion ?? 0) - before, 1, 'four restyled, ONE re-flow');
    // By value on every member, because the ids are re-minted by the re-flow —
    // which is the whole reason a client cannot do this by sending four
    // messages with the ids it was holding when it started.
    const worn = fixturesOf(g.layout).filter((f) => (f.variant ?? '') === want).length;
    eq(worn, 4, 'and all four are wearing the new shape afterwards');
  } else {
    // No second shape authored in this database. Say so rather than passing
    // quietly: a sweep that measures nothing is a sweep that is very happy
    // about nothing.
    console.log('   (no second shelf shape authored — re-flow count checked on a settings verb)');
    eq((g.layoutVersion ?? 0) - before, 0, 'a settings verb re-flows nothing at all');
  }
}

// ---------------------------------------------------------------------------
// 4. A refusal in the middle does not stop the rest — and all-refused is an
//    error rather than a silent success.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const picked = shelvesOf(g).slice(0, 3).map((s) => s.id);
  // A fixture id nothing has ever heard of, in the middle of the list. Every
  // single-fixture verb answers "no such shelf" for it, which is exactly the
  // shape of the refusal a real batch meets: a unit somebody else removed
  // between the press and the message.
  const mixed = [picked[0], 'fx-nonesuch', picked[1], picked[2]];

  g.log = [];
  const res = g.bulkFixtures(mixed, (id) => g.setRestockPriority(id, -1),
    (n) => `${n} units moved in the refill queue.`);
  check(res.ok, 'a batch with one bad id still lands', res.error ?? '');
  eq(res.done, 3, 'on every good one');
  eq(res.of, 4, 'and says how many it was asked for');
  check(!!res.error, 'and carries the reason the fourth did not');
  check(g.log.some((l) => l.msg.includes('1 of them would not')),
    'which is said in the feed rather than swallowed',
    g.log.map((l) => l.msg).join(' | '));
  for (const id of picked) {
    eq(g.layout.shelves.find((s) => s.id === id).priority, -1,
      `the good ones all changed (${id})`);
  }

  const none = g.bulkFixtures(['fx-nope', 'fx-nada'], (id) => g.setRestockPriority(id, 1),
    (n) => `${n} units moved.`);
  check(!none.ok, 'a batch where nothing worked is an error');
  check(!!none.error, 'with a reason on it', JSON.stringify(none));

  eq(g.bulkFixtures([], () => ({ ok: true })).ok, false, 'and so is a batch of nothing');
}

// ---------------------------------------------------------------------------
// 5. A selection of one is the old path, to the letter.
//
// The one that keeps bulk from being a tax on ordinary play: every press in the
// game goes through `bulkFixtures` now, so a single press has to come back with
// the verb's own result — the ids, the flags, the fields a caller reads — and
// not with a batch report wearing them.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const id = shelvesOf(g)[0].id;
  const direct = g.setShelfHands(id, false);
  const viaBulk = g.bulkFixtures([id], (x) => g.setShelfHands(x, true));
  eq(JSON.stringify(Object.keys(viaBulk).sort()), JSON.stringify(Object.keys(direct).sort()),
    'a selection of one answers in the verb\'s own shape');
  eq(viaBulk.shelf, id, 'and names the unit rather than a count');
  eq(viaBulk.done, undefined, 'with no batch report on it');
}

// ---------------------------------------------------------------------------
// 6. A held re-flow is not a lost one.
//
// `holdReflow` is a `finally`, so this is the assertion that the fold cannot
// swallow the update when the thing inside it throws — which is a shop the
// server has changed and the client has never been told about.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = g.layoutVersion ?? 0;
  let threw = false;
  try {
    g.holdReflow(() => {
      g.regenerateLayout();
      throw new Error('boom');
    });
  } catch { threw = true; }
  check(threw, 'a hold does not swallow what was thrown inside it');
  eq((g.layoutVersion ?? 0) - before, 1, 'and the re-flow it was holding still happens');
  eq(g.reflowHold, null, 'and the hold is let go of');
}

// ---------------------------------------------------------------------------
// 7. A selection torn out, and the guard that reads the SHOP rather than the
//    unit.
//
// Removal is the one bulk verb that destroys something, and it is the one whose
// refusal is a fact about the whole building: "you need at least one till".
// Every other verb in here moves no tile, which is what makes `holdReflow` safe
// — each one looks its own fixture up against a layout that is still true. A
// removal makes it stale by construction: the tills this batch has already torn
// out are still standing in `layout.checkouts`, so three picked in a shop with
// three passes the guard three times and leaves a shop that cannot take money.
//
// Nothing about that is visible. The tills are gone, which is what you asked
// for; what you find out later is that shoppers queue at nothing. Its pair is
// that the batch does not simply refuse instead — two of the three must go, or
// the guard is a shop you can never rearrange the front of.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelves = shelvesOf(g).slice(0, 3).map((s) => s.id);
  const control = shelvesOf(g)[3].id;
  const cash = g.cash;
  const before = g.layoutVersion ?? 0;

  g.log = [];
  let back = 0;
  const res = g.bulkFixtures(shelves, (id) => {
    const r = g.removeFixture('me', id);
    if (r?.ok) back += r.refund ?? 0;
    return r;
  }, (n) => `Removed ${n} fixtures.`);
  check(res.ok, 'a bulk removal is accepted', res.error ?? '');
  eq(res.done, 3, 'and tears out every one of them');
  eq(fixturesOf(g.layout).filter((f) => shelves.includes(f.id)).length, 0,
    'none of the three is standing afterwards');
  check(!!g.findFixture(control), 'and the one nobody picked still is');
  eq((g.layoutVersion ?? 0) - before, 1, 'three removed, ONE re-flow');
  eq(g.log.length, 1, 'and one line in the feed');
  // The money is the half of a removal you cannot see afterwards, so it is the
  // half worth asserting: three refunds, arrived at from the cash rather than
  // from the sum that reported them.
  check(back > 0 && Math.abs((g.cash - cash) - back) < 0.005,
    'the refunds all landed', `${back} vs ${g.cash - cash}`);
}

{
  // Three tills, all picked. Two go, one is refused, and the refusal is the
  // batch's rather than the shop's: `bulkFixtures` reports a partial run as an
  // `ok` that says what it could not do.
  const g = fresh({ ...SHOP, checkout: 3 });
  const tills = g.layout.checkouts.map((c) => c.id);
  eq(tills.length, 3, 'the test shop has three tills');

  g.log = [];
  const res = g.bulkFixtures(tills, (id) => g.removeFixture('me', id),
    (n) => `Removed ${n} fixtures.`);
  check(res.ok, 'a batch that can only partly run still runs', res.error ?? '');
  eq(res.done, 2, 'two of the three tills go');
  eq(g.layout.checkouts.length, 1, 'and the shop is left with one to take money at');
  check(/till/.test(res.error ?? ''), 'and the reason the third stayed is on the result',
    res.error ?? '');

  // ...and the last one alone is the old refusal exactly, which is the control
  // that says this is a batch rule rather than a new one.
  const lone = g.removeFixture('me', g.layout.checkouts[0].id);
  check(!lone.ok, 'the last till on its own is still refused', JSON.stringify(lone));
  eq(g.layout.checkouts.length, 1, 'and is still standing');
}

// ---------------------------------------------------------------------------
// 8. The ladder, both ways, over a selection — and each unit on its OWN rung.
//
// A rung is priced per piece and per tier, so six units standing at three
// different tiers is six different prices. The failure this is written against
// is the one that looks right: a batch that charged the FIRST unit's price six
// times, or that stepped every one of them to the same tier, comes back with
// six upgraded fixtures and a shop that is quietly poorer or richer than it
// should be — and there is nothing on screen to compare it against.
//
// So the assertion is arithmetic on what each rung says it costs, gathered
// before the batch runs, and the control is the round trip: up and back down
// must always LOSE money, or a selection is a way to print it two keys at a
// time.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const picked = shelvesOf(g).slice(0, 3).map((s) => s.id);
  // Only the ones that have somewhere to climb — an authored ladder is content,
  // and a sweep that assumed one would pass or fail on the catalogue.
  const climbers = picked.filter((id) => g.nextTier(g.findFixture(id)));
  if (climbers.length < 2) {
    console.log('   (no shelf tier authored — the ladder batch is not measurable here)');
  } else {
    const owed = climbers.reduce((n, id) => n + (g.nextTier(g.findFixture(id)).cost ?? 0), 0);
    const cash = g.cash;
    const before = g.layoutVersion ?? 0;

    g.log = [];
    const res = g.bulkFixtures(climbers, (id) => g.upgradeFixture('me', id),
      (n) => `Upgraded ${n} fixtures.`);
    check(res.ok, 'a bulk upgrade is accepted', res.error ?? '');
    eq(res.done, climbers.length, 'and climbs every one of them');
    // Each at its own price. Summed from the rungs rather than from the result,
    // or the assertion is the batch agreeing with itself.
    check(Math.abs((cash - g.cash) - owed) < 0.005,
      'and charges each one its own rung', `${cash - g.cash} vs ${owed}`);
    eq((g.layoutVersion ?? 0) - before, 1, 'three upgraded, ONE re-flow');
    eq(g.log.length, 1, 'and one line in the feed');

    // ...and back down. The ids were re-minted by the re-flow, which is the
    // whole reason a client cannot do this by sending N messages — so they are
    // read off the layout again rather than reused.
    const up = fixturesOf(g.layout).filter((x) => x.kind === 'shelf' && g.prevTier(x));
    check(up.length >= climbers.length, 'the upgraded units are standing on a rung',
      `${up.length}`);
    const mid = g.cash;
    const down = g.bulkFixtures(up.slice(0, climbers.length).map((x) => x.id),
      (id) => g.downgradeFixture('me', id), (n) => `Stepped ${n} back.`);
    check(down.ok, 'a bulk downgrade is accepted', down.error ?? '');
    eq(down.done, climbers.length, 'and steps every one of them back');
    check(g.cash > mid, 'the refunds landed', `${mid} → ${g.cash}`);
    // The control, and the one claim here that is about money rather than about
    // rungs: a circuit up and back must never come out ahead.
    check(g.cash < cash, 'and a round trip up and back always loses money',
      `${cash} → ${g.cash}`);
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:pick — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a verb done to a selection happens to all of it, once, and says so once.\n');
