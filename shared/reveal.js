import { FIXTURES, GROUND } from './build.js';

/**
 * WHEN A BUTTON TURNS UP — the palette's own ladder.
 *
 * Twenty-six build kinds is a correct palette and a bad first minute: the shop
 * has no gate but PRICE, so a new player opens the bar and meets conveyors,
 * lifts, sorters, paddocks and a ceiling before they have sold anything. The
 * complaint it draws is "too many buttons", and it is not a complaint about
 * having too much game — Factorio has far more and nobody says it, because you
 * meet it over forty hours instead of in one screen.
 *
 * So this is a REVEAL and never an unlock, and the distinction is the whole
 * reason it can exist at all. `server/sim/goals.js` opens with the rule that a
 * milestone reward "may not be a thing you unlock", because anything granting a
 * fixture would be a second way to OWN something, and every rule in the shop
 * about what you own is written against `placements` and `ownedUpgrades`. This
 * grants nothing. It hides a button you could always afford, and the day it
 * appears you are no richer and own nothing new — so `placeFixture`, the server,
 * the save and every sweep are untouched, and a shop that turns the whole thing
 * off is the game exactly as it shipped.
 *
 * Three rules hold it together.
 *
 * **Absent, never padlocked.** A greyed-out row of locks is a list of things you
 * cannot have, which is a worse first minute than the long bar — it says the
 * game is withholding rather than that it is unfolding. Nothing draws a gated
 * tool at all, and `award.js` says so on the way in.
 *
 * **A gate may never be the thing it gates.** Five rungs of the ladder measure
 * *having built the thing* — `first-kitchen` is "put an appliance on the floor",
 * `break-room` is "paint a break area", and `car-park`, `stockroom` and
 * `first-warmer` are the same shape. Gating `station` behind `first-kitchen`
 * is a button that appears the moment you no longer need it to appear, which is
 * a feature that is off for ever while reading as authored. Every gate below is
 * a rung about MONEY, SALES, DAYS or the ROSTER for that reason, and the sweep
 * asserts it rather than trusting the next person to notice.
 *
 * **Unlisted is visible.** A kind nobody wrote a row for here ships on the bar
 * from the first minute. That is the safe direction: a new piece authored
 * tomorrow turns up and can be built, where a default of "hidden" would be a
 * fixture that exists, prices, places, renders and can never be found — which
 * is CLAUDE.md's "a working system with no content in it is indistinguishable
 * from a broken one", arriving through the palette.
 */

/**
 * What reveals what, as `tool → milestone`.
 *
 * Keyed on the tool's KIND for anything with a `fixtures` row or a ground brush,
 * and on its ID for the shell tools, which have no kind — a wall is built by the
 * renderer off `EDGE_STYLE`, so `curtain` and `shutter` are ids and there is
 * nothing else to hang them on. `gateFor` asks both, kind first, which is why
 * the two can share one table without a second lookup.
 *
 * The ORDER of the ladder is taste and this table is where to change it. What is
 * not taste is which rungs may appear on the right-hand side — see the second
 * rule above, and `verify:reveal`.
 */
export const REVEAL = {
  // The farm, once the shop has taken its first hundred. A bed is the second
  // thing anybody builds and the first that is not a shop floor, so it is the
  // earliest reveal there is — late enough that minute one is four buttons,
  // early enough that it lands while the opening float still feels tight.
  plot: 'take-100',
  lawn: 'take-100',
  path: 'take-100',

  // The crew, and the thing that exists because of them. A break area is
  // meaningless with nobody to sit in it, and `verify:break` is a whole sweep
  // about a room that only matters once somebody is tired.
  //
  // `freezer` is deliberately NOT here — see `TUTORIAL_KINDS`.
  break: 'first-hire',

  // Livestock, once a bed has actually produced something. `first-harvest` and
  // never `first-plant`: a pen is a bed's rhythm borrowed by something that is
  // not planted (docs/pens.md), so it reads as a variation on a loop you have
  // been round once rather than as a second farm you never asked for.
  pen: 'first-harvest',
  paddock: 'first-harvest',

  // The third kind of shelving, and the way out. Both are answers to a shop
  // that has moved enough stock to have a spoilage problem — a hot counter is
  // nothing to a shop that has sold ninety things, and a skip is a fixture
  // whose whole job is what has already gone off.
  warmer: 'sold-100',
  bin: 'sold-100',
  shutter: 'sold-100',

  // Making rather than buying, and the ground that brings people to the door.
  // On takings rather than on sales because an appliance is the first fixture
  // that is an investment instead of a purchase — docs/production.md's whole
  // argument is that making is cheaper than buying, which is a sentence about
  // money.
  station: 'take-500',
  road: 'take-500',
  park: 'take-500',
  'prop-floor': 'take-500',
  'prop-ceiling': 'take-500',

  // THE ONE THAT MATTERS. Five hundred things over the counter is five hundred
  // things somebody put on a shelf by hand, and this is the rung the whole
  // ladder exists to reach: the belt arrives at the moment the tedium it fixes
  // has actually been felt. It is Factorio's pickaxe said out loud — you mine
  // by hand, you get sick of it, and the answer turns up because you earned the
  // feeling rather than because a tech tree ticked over.
  belt: 'sold-500',
  arm: 'sold-500',
  curtain: 'sold-500',

  // ...and the rest of the network once the first one is running. Sorters,
  // packers and a second storey are answers to problems a working belt causes —
  // a junction that backs up, a dock of part-crates, an aisle with no room left
  // — so meeting them before there is a belt is meeting them as trivia.
  sorter: 'sold-1000',
  packer: 'sold-1000',
  lift: 'sold-1000',
  under: 'sold-1000',
};

/**
 * The rungs a gate may be written against.
 *
 * A milestone that measures OWNING something cannot gate that something, and
 * the failure is silent and permanent in both directions — see the second rule
 * in the header. Rather than a list of the five banned rungs, this is the list
 * of the four SHAPES that are safe, because the ban is a property of what a rung
 * measures rather than of its id, and a forty-sixth milestone added next month
 * should have to opt in rather than be assumed harmless.
 *
 * Kept as prefixes because that is genuinely how the ladder is named — `take-`,
 * `sold-`, `harvest-`, `crew-`, `week-`, `month-` — and a rung that does not
 * start with one of them is a rung somebody should look at before gating on it.
 */
export const SAFE_GATES = ['take-', 'sold-', 'harvest-', 'crew-', 'week-', 'month-', 'first-sale', 'first-hire', 'first-plant', 'first-harvest', 'first-promotion', 'first-build', 'year-', 'hundred-days', 'best-day-'];

/**
 * THE KINDS THE TUTORIAL NAMES, WHICH MAY NEVER BE GATED.
 *
 * `client/tutor.js` walks somebody through a shop by pointing at palette
 * entries — `[data-entry="..."]` — and a step whose entry is not on the bar is a
 * card saying "Pick the chiller out of the Shop tab" over a Shop tab with no
 * chiller in it. The veil's third answer to "where is the hole" keeps that from
 * hard-wedging (docs/tutorial.md), so it does not crash and does not recover
 * either: it reads as the tutorial being broken, in the first five minutes of
 * somebody's first shop, which is the worst place in the game to spend that.
 *
 * `freezer` is the one that made this list, and the way it got here is worth
 * keeping because it is a NEAR miss rather than an obvious one. The tutorial's
 * `hire` step is `done` when `roster.length > 0`, `first-hire` measures
 * `g.roster.length` against a need of 1, and the freezer step comes two beats
 * later — so gating the chiller behind the hire is *almost* exactly right, and
 * would have worked nearly every time. What is left is a race: `checkMilestones`
 * sweeps once per second of world time, so a player who clears the step between
 * them meets the empty tab, and one who dawdles never knows. An intermittent
 * failure in the tutorial is worse than a reliable one, because the person who
 * hits it is the person least able to tell it is a bug.
 *
 * The rule this encodes is bigger than the one kind: **a gate is a fact about
 * the palette, and the tutorial is the one other system that has opinions about
 * what is on it.** Anything the tutorial ever learns to point at belongs here
 * the same day.
 */
export const TUTORIAL_KINDS = ['shelf', 'freezer'];

/** Which milestone, if any, a tool waits for. Kind first, then id. */
export function gateFor(tool) {
  if (!tool) return null;
  return REVEAL[tool.kind] ?? REVEAL[tool.id] ?? null;
}

/**
 * What a rung OPENS, as the words a player reads.
 *
 * The table read backwards, and it has to exist because a reveal nobody can see
 * coming is a reveal that reads as the game randomly growing buttons. The ladder
 * was already drawn — the Goals panel has listed every rung since it shipped —
 * and until this, not one of them said what it was worth beyond the cash: the
 * one reward that is not a number had no words anywhere.
 *
 * **Labels off `FIXTURES`/`GROUND` rather than out of a list here**, which is
 * the same argument `client/thumb.js` makes about drawing a palette button from
 * its own catalog row: a second set of names is a second thing to keep in step,
 * and the failure is a card promising a "Chiller" over a bar that says Freezer.
 * The shell tools (`curtain`, `shutter`) have no record to read, so they carry
 * their own word — those are the only two, and they are named here rather than
 * given a fake `FIXTURES` entry.
 *
 * Answers `[]` for a rung that opens nothing, which is thirty-nine of the
 * forty-six: the caller draws no line at all rather than an empty one.
 */
const SHELL_WORDS = { curtain: 'Strip Curtain', shutter: 'Roller Door', arch: 'Archway' };

export function opensAt(milestoneId) {
  const out = [];
  for (const [tool, gate] of Object.entries(REVEAL)) {
    if (gate !== milestoneId) continue;
    out.push(FIXTURES[tool]?.label ?? GROUND[tool]?.label ?? SHELL_WORDS[tool] ?? tool);
  }
  return out;
}

/**
 * Is this tool on the bar yet?
 *
 * `on` false is the whole of the opt-out and is deliberately the FIRST thing
 * asked: a shop with the ladder switched off must not pay for a set lookup per
 * tool per rebuild, and more to the point it must be provably the old game — one
 * `if` above everything else is a claim a reader can check, where a gate that
 * happened to pass every test is a claim they have to take on trust.
 */
export function toolRevealed(tool, done, on) {
  if (!on) return true;
  const gate = gateFor(tool);
  return !gate || done.has(gate);
}

/**
 * The done-list as a string, for a cache key.
 *
 * `buildTools` caches its whole output against the catalogue, so without this
 * the palette would not grow a button until somebody authored content — the
 * milestone would land, the award card would say so, and the bar would go on
 * showing what it showed before, which reads as the reward not having been paid.
 * Cheap next to the rebuild it guards: a few dozen short ids, once per call,
 * against re-deriving every tile's art.
 */
export function revealSig(done, on) {
  if (!on) return 'off';
  return [...done].sort().join(',');
}
