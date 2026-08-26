#!/usr/bin/env node
/**
 * VERIFY: THE EVENT THAT CHANGES WHO WALKS IN.
 *
 * A world event could move `demand_mult` and `price_mult` and nothing else, so
 * for the whole life of the game no event could change the *crowd*. A school
 * holiday and a goth night were both "everyone wants sweets", said at the same
 * twenty kinds of shopper in the same proportions — the town's appetite moved
 * and the town never did. `spawn_mult` is the third axis, and it is matched
 * against `ArchetypeSchema.tags` rather than against an archetype id, which is
 * the whole reason that column exists.
 *
 * Everything in here is invisible twice over, which is why it ships with the
 * feature rather than after it. A shopper who came in because of an event and
 * one who came in anyway are the same person in the same doorway with the same
 * basket, and a crowd is only a crowd in aggregate — no still frame of a shop
 * distinguishes a takeover from a quiet run of luck. And the shop afterwards is
 * the same shop either way: only the mix moved, and the mix is a thing you
 * would have to count over hundreds of arrivals to see.
 *
 * Its control is doubled, and it is the assertion that decides whether this is
 * a feature or a silent rebalance of every save in existence. **Every balance
 * figure in this repo is downstream of how many times `this.rng` has been
 * called** — so the claim is not merely "the same shopper comes out", it is
 * "the stream is in the same place afterwards". `rng.weighted` calls `next()`
 * exactly once whatever list it is handed, so folding the multiplier into the
 * WEIGHTS keeps one draw; rolling the crowd and then rolling the shopper would
 * be two, and two `simulate` runs either side of this file would diverge with
 * nothing in the output to say why. Doubled because a shop with no modifiers at
 * all and a shop under an ORDINARY event are different code paths through
 * `foldModifiers`, and the second is the one every existing save is actually
 * in.
 *
 * The rest:
 *
 * - **A tag and never an id.** An effect naming `emo` moves the Emo; an effect
 *   naming an archetype by id moves nobody at all. Asserted as a pair, or
 *   "nothing happened" passes for both.
 * - **A tag nothing carries is inert**, which is `demand`'s own behaviour said
 *   about people — and is what lets one events table hold two vocabularies.
 * - **It moves the share**, as a comparison rather than a value, or the
 *   assertion passes whatever the bands become.
 * - **Zero is a real answer.** "Nobody like that comes in today" is a story an
 *   event is allowed to tell, so `spawn_mult: 0` must empty that tag out — and
 *   zeroing EVERYBODY must still hand back a shopper rather than crashing the
 *   only door into `this.customers`.
 * - **The product over several tags**, so somebody who is two of the things an
 *   event is about is doubly likely, which is what those two tags being true of
 *   them means.
 * - **The fold survives duplicates.** `dedupeModifiers` takes one event's
 *   strongest pull rather than stacking its own copies, and a restart or a
 *   double `run_director` is exactly how a pile of identical rows happens.
 * - **The band holds**, or an authored 10 on a tag half the town carries is not
 *   an event, it is the other nineteen archetypes being deleted.
 *
 * It authors three archetypes and removes them on exit, the same way
 * `verify-walkout` authors its own shopper — and for the same reason: a
 * weighted draw over whatever the live content database happens to hold is a
 * measurement somebody else can move from another window.
 *
 *   node scripts/verify-spawn.js
 */

import { Game } from '../server/sim/index.js';
import { foldModifiers } from '../server/sim/economy.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { writeContent, content } from '../server/content.js';
import { remove } from '../server/db.js';
import { makeRng } from '../shared/rng.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// This sweep's own town.
//
// Three archetypes it controls completely: one carrying the tag an event will
// name, one carrying two tags, and one carrying none — which is every archetype
// authored before `tags` existed and is the row that proves an untagged shopper
// is simply never affected.
//
// Equal spawn weights, so a share is arithmetic rather than a reading. The live
// rows are still in the pool and cannot be removed, so every assertion below is
// a comparison of one of THESE against itself under two conditions, never a
// share of the whole town.
// ---------------------------------------------------------------------------
const ONE = 'zz-spawn-one';
const BOTH = 'zz-spawn-both';
const PLAIN = 'zz-spawn-plain';
const MINE = [ONE, BOTH, PLAIN];

const base = {
  affinities: { pantry: 1 },
  basket_min: 1,
  basket_max: 1,
  patience: 600,
  spawn_weight: 10,
};

process.on('exit', () => {
  for (const id of MINE) {
    try { remove('archetypes', id); } catch { /* the DB is already gone */ }
  }
});

for (const [id, name, tags] of [
  [ONE, 'Spawn Test One', ['zz-crowd']],
  [BOTH, 'Spawn Test Both', ['zz-crowd', 'zz-extra']],
  [PLAIN, 'Spawn Test Plain', []],
]) {
  const res = writeContent('archetype', { ...base, id, name, tags }, 'verify');
  check(res.ok, `the catalog accepts ${id}`, res.error ?? '');
  // The schema is half the feature here exactly as it is in `verify-walkout`:
  // an archetype authored with tags that parsed into one without them would
  // leave every assertion below testing the control twice and passing.
  eq((res.row ?? {}).tags?.length ?? 0, tags.length, `...and keeps ${id}'s tags through the parse`);
}

/** An ephemeral shop with nothing on it that could move a draw. */
function fresh() {
  const g = Game.create({ worldId: 'verify-spawn', seed: 'spawn', ephemeral: true });
  g.roster = [];
  g.ownedUpgrades = [];
  silenceMilestones(g);
  return g;
}

/**
 * A modifier row exactly as `stageEvent` writes one.
 *
 * Built here rather than driven through the director on purpose: which event
 * fires on a given day is a weighted draw over the live events table, so a
 * sweep that waited for one would be measuring somebody else's content.
 */
const mod = (tag, spawn_mult, label = 'Test event') => ({
  source: 'event:zz-spawn', label, tag, demand_mult: 1, price_mult: 1, spawn_mult,
});

/**
 * The pool `spawnCustomer` itself draws from — this file's three rows plus
 * whatever else the database holds. Every claim below is about how one of MINE
 * moves against itself under two conditions, never a share of the whole town,
 * so the live rows are scenery rather than a dependency.
 */
const archetypes = content().archetypes;
check(MINE.every((id) => archetypes.some((a) => a.id === id)),
  'all three test archetypes are in the draw pool');

/** How the crowd came out over `n` arrivals, as counts per archetype. */
function tally(g, folded, n = 6000, seed = 'draw') {
  g.folded = () => folded;
  g.rng = makeRng(seed);
  const out = {};
  for (let i = 0; i < n; i++) {
    const a = g.drawArchetype(archetypes);
    out[a.id] = (out[a.id] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. THE CONTROL, DOUBLED — the assertion that decides whether this is opt-in.
//
// Not "the same shopper" but "the stream is in the same place afterwards".
// `rng.weighted` closes over its own generator, so a wrapped `next` cannot see
// inside it; asking both streams for the next float once the run is over is the
// only honest way to count what each consumed.
// ---------------------------------------------------------------------------
{
  const g = fresh();

  for (const [label, folded] of [
    ['a shop with no modifiers at all', foldModifiers([])],
    // The path every existing save is actually on: an ordinary event, which
    // builds a non-empty fold that still says nothing about people.
    ['a shop under an ordinary demand/price event', foldModifiers([
      { ...mod('frozen', 1), demand_mult: 1.4, price_mult: 1.1 },
      { ...mod('produce', 1), demand_mult: 0.8, price_mult: 1 },
    ])],
  ]) {
    const before = makeRng('control');
    const after = makeRng('control');
    g.folded = () => folded;
    g.rng = after;

    let identical = 0;
    for (let i = 0; i < 4000; i++) {
      const was = before.weighted(archetypes, 'spawn_weight');
      if (was.id === g.drawArchetype(archetypes).id) identical++;
    }
    eq(identical, 4000, `${label} draws exactly the shopper it always drew`);
    eq(before.next(), after.next(), `...and leaves the RNG stream in the same place`);
  }

  // ...and the fold really is empty, which is what the short-circuit rests on.
  eq(Object.keys(foldModifiers([]).spawn).length, 0,
    'no modifier folds to an empty spawn table');
  eq(Object.keys(foldModifiers([{ ...mod('frozen', 1), demand_mult: 2 }]).spawn).length, 0,
    '...and so does a row that names people and changes nothing about them');
}

// ---------------------------------------------------------------------------
// 2. A TAG, NEVER AN ID — the pair. Either half alone is satisfied by nothing
//    happening at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plain = tally(g, foldModifiers([]));
  const byTag = tally(g, foldModifiers([mod('zz-crowd', 3)]));
  const byId = tally(g, foldModifiers([mod(ONE, 3)]));

  check(byTag[ONE] > plain[ONE] * 1.5,
    'an effect naming an archetype TAG brings that shopper in',
    `${plain[ONE]} -> ${byTag[ONE]}`);
  eq(byId[ONE], plain[ONE],
    '...and an effect naming an archetype by ID moves nobody');

  // A tag nothing carries, which is `demand`'s own answer said about people and
  // is what lets one table hold two vocabularies at once.
  const nobody = tally(g, foldModifiers([mod('zz-nobody-has-this', 3)]));
  eq(nobody[ONE], plain[ONE], 'a tag no archetype carries moves nobody');
  eq(nobody[PLAIN], plain[PLAIN], '...including the archetype with no tags');

  // An untagged archetype is every row authored before `tags` existed. It must
  // never be caught by an event, whatever the event says.
  check(byTag[PLAIN] < plain[PLAIN],
    'an untagged shopper is only ever diluted, never selected',
    `${plain[PLAIN]} -> ${byTag[PLAIN]}`);
}

// ---------------------------------------------------------------------------
// 3. THE PRODUCT — somebody who is two of the things an event is about.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plain = tally(g, foldModifiers([]));
  const one = tally(g, foldModifiers([mod('zz-crowd', 2)]));
  const two = tally(g, foldModifiers([mod('zz-crowd', 2), mod('zz-extra', 2, 'Other event')]));

  check(two[BOTH] > one[BOTH],
    'a shopper carrying both tags an event names is drawn harder than one carrying one',
    `${one[BOTH]} -> ${two[BOTH]}`);
  check(one[ONE] > plain[ONE] && Math.abs(two[ONE] - one[ONE]) < one[ONE] * 0.25,
    '...while the one carrying only the first tag is unmoved by the second effect',
    `${plain[ONE]} -> ${one[ONE]} -> ${two[ONE]}`);
}

// ---------------------------------------------------------------------------
// 4. ZERO IS A REAL ANSWER — and must not empty the town.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const gone = tally(g, foldModifiers([mod('zz-crowd', 0)]));
  eq(gone[ONE] ?? 0, 0, 'spawn_mult 0 keeps that kind of shopper at home');
  eq(gone[BOTH] ?? 0, 0, '...both of them');
  check((gone[PLAIN] ?? 0) > 0, '...and everybody else still comes in');

  // The one place this could have emptied the only door into `this.customers`.
  // Every archetype in the pool zeroed is a table whose weights sum to nothing,
  // and `rng.weighted` answers `items[0]` rather than `undefined` — so the shop
  // still gets a shopper instead of a crash.
  const tags = [...new Set(archetypes.flatMap((a) => a.tags ?? []))];
  const everyone = foldModifiers(tags.map((t) => mod(t, 0)));
  g.folded = () => everyone;
  g.rng = makeRng('empty');
  const someone = g.drawArchetype(archetypes.filter((a) => (a.tags ?? []).length > 0));
  check(!!someone && !!someone.id,
    'a table that zeroes every tag in the town still hands back a shopper');
}

// ---------------------------------------------------------------------------
// 5. THE FOLD — duplicates, and the band.
//
// A pile of identical rows is a bookkeeping artefact rather than five events —
// a restart or a double `run_director` is exactly how one happens — so one
// event's strongest pull on a tag wins instead of its copies stacking.
// ---------------------------------------------------------------------------
{
  const dupes = foldModifiers([mod('zz-crowd', 2), mod('zz-crowd', 2), mod('zz-crowd', 2)]);
  eq(dupes.spawn['zz-crowd'], 2,
    'three identical rows of one event are one pull, not 2x2x2');

  const strongest = foldModifiers([mod('zz-crowd', 1.5), mod('zz-crowd', 2.5)]);
  eq(strongest.spawn['zz-crowd'], 2.5,
    '...and it is the strongest of them rather than the first');

  // Different events genuinely compound, which is the same rule demand has.
  const two = foldModifiers([mod('zz-crowd', 2, 'A'), mod('zz-crowd', 1.4, 'B')]);
  check(two.spawn['zz-crowd'] > 2, 'two different events do compound',
    `${two.spawn['zz-crowd']}`);

  // ...up to the band, or an authored 10 on a tag half the town carries is not
  // an event, it is the other archetypes being deleted. Restated here rather
  // than imported, or this assertion passes whatever the constant becomes.
  const huge = foldModifiers([mod('zz-crowd', 9, 'A'), mod('zz-crowd', 9, 'B')]);
  eq(huge.spawn['zz-crowd'], 3, 'and the ceiling holds however many events pile on');
  const floor = foldModifiers([mod('zz-crowd', 0, 'A'), mod('zz-crowd', 0.5, 'B')]);
  eq(floor.spawn['zz-crowd'], 0, '...and the floor is a real zero rather than a trickle');

  // A row with no `spawn_mult` on it at all is every modifier ever written, and
  // the web store keeps its rows in a vault rather than behind a column with a
  // DEFAULT — so one really can arrive without the field.
  const bare = foldModifiers([
    { source: 'x', label: 'Old', tag: 'zz-crowd', demand_mult: 2, price_mult: 1 },
    { source: 'x', label: 'Old', tag: 'zz-crowd', demand_mult: 1.5, price_mult: 1 },
  ]);
  eq(Object.keys(bare.spawn).length, 0, 'a modifier written before this column reads as 1');
  eq(bare.demand['zz-crowd'], 2, '...and the fold still takes the strongest pull on demand');
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log(`\n${checks} assertions\n`);
if (failures.length) {
  console.log(`  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.log(`      ${f}`);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('  ✅  an event can move who walks in, and moves nobody when it does not.\n');
}
