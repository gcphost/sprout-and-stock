/**
 * VALIDATION — the safety rail for live editing.
 *
 * Every write into the content DB goes through one of these, whether it came
 * from a human, an MCP tool call, or the world director. If it doesn't
 * validate, it's rejected with a readable error and the running game is
 * completely unaffected.
 *
 * This is why the kid's agent can't break the server: the worst it can do is
 * get told "no".
 */

import { z } from 'zod';
import { ALL_TAGS } from './tags.js';
// One spelling of the kind that is ground. `shared/build.js` reaches only
// tiles.js and edges.js, so there is no cycle to pay for taking it from source.
import { isSurface } from './build.js';
// A worker list written before three farm directives became one. Run on the way
// in so a row rewritten through this gate is stored in today's vocabulary — the
// seed loader, the MCP tools and the director all come through here.
import { foldJobs } from './jobs.js';
// The closed set of world quantities a piece may watch. Named here so a signal
// that does not exist is refused at the gate rather than resolving to nothing in
// the renderer, which would draw as a clock with no hands.
import { SIGNAL_NAMES } from './signals.js';
// How many kinds one box holds, so a rung that packs one can never be authored
// to pack more than a crate can carry — the cap has to come from the container
// rather than from a literal beside it.
import { LOT_KINDS } from './lot.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase kebab/snake case');
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour');

/**
 * A procedural low-poly model, built from primitives.
 *
 * There are no art assets in this game — every prop is described as a little
 * pile of flat-shaded boxes/spheres/cones. That means the AI can invent an
 * item AND what it looks like in the same JSON blob, and it renders instantly.
 */
const PART = z.object({
  shape: z.enum(['box', 'sphere', 'cone', 'cylinder', 'capsule']).default('box'),
  color: hexColor,
  /** [x, y, z] offset from the prop's origin, in world units (1 = one tile). */
  pos: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** [x, y, z] size in world units. */
  scale: z.tuple([z.number(), z.number(), z.number()]).default([0.3, 0.3, 0.3]),
  /** Y-axis rotation in degrees. */
  rot: z.number().default(0),
  /**
   * "Goods stand on top of this part."
   *
   * A shelving unit is rows, and stock belongs *on the rows* — but only the art
   * knows where they are. Flagging the boards means a redrawn shelf moves its
   * stock with it, the same way a redrawn fixture already moves its own height.
   * Nothing else reads it: a model with no surfaces piles goods on its roof,
   * which is what a chest freezer wants anyway.
   *
   * Flagging a board does not make it *usable* — whatever you draw above it has
   * to leave room to see into it. Goods fill top-down, so a lid close over the
   * top board is where all of the stock goes and none of it shows. That is
   * geometry rather than a second flag (`drawableBoards`, shared/model.js), and
   * `npm run docs:fixtures` names any board that fails it.
   */
  surface: z.boolean().default(false),
  /**
   * "This part is only here to close the end of the unit."
   *
   * The side panel of a wall run caps the shelving — but a cap is only wanted
   * where the run actually ends. Stand four of them in a row and every panel
   * meets another back to back, drawing a divider through what the eye reads as
   * one long shelf. Flagged, the renderer drops it against a matching
   * neighbour and keeps it at the two ends, so a run of four is a run.
   *
   * Which side it closes is read from where the part sits — `seamStep` in
   * `shared/model.js`. A part at the middle of a model closes nothing, and a
   * model nobody stands next to keeps every part it was drawn with.
   */
  seam: z.boolean().default(false),
  /**
   * How solid this part is, 0.05..1. Below 1 it's glass: a freezer door you can
   * see the stock through, a window, a bottle.
   *
   * Cheap to allow and hard to author around the lack of — the alternative is
   * leaving the front off entirely, and a display freezer with no door is a
   * shelf. Glass casts no shadow either, for the same reason it isn't opaque.
   */
  alpha: z.number().min(0.05).max(1).default(1),
  /**
   * "Cast a shadow anyway." Only means anything on glass, because everything
   * solid already does.
   *
   * Glass casting no shadow is right for the thing glass usually is — a door
   * you look through, a bottle — and wrong for the thing a *pane* usually is,
   * which is a big flat panel hanging over the shop floor. Fade one down far
   * enough to see the aisle through it and the shadow it was laying on that
   * aisle goes with it, so the fitting stops sitting in the room at all: it
   * reads as a decal on the camera rather than a thing at ceiling height.
   *
   * three.js has no half-shadow — the shadow map is a depth pass, so a part
   * either casts fully or not at all, whatever its opacity. This is therefore
   * a choice between two wrong answers, and which is less wrong depends on how
   * big the part is: leave it off for a door and turn it on for a ceiling.
   */
  shadow: z.boolean().default(false),
  /**
   * "This part leaves whoever is holding it." It rises from where it was
   * authored, spreads, fades out and starts again — vapour, steam, the glow off
   * a phone screen.
   *
   * Same shape of idea as `surface`: a flag on a part that one renderer knows
   * how to read, rather than a second kind of model. It exists because a puff
   * is the one thing stages cannot say — a stage arc plays once across a whole
   * break, and smoke has to keep going. So the arc stays authored and the loop
   * stays in code, which is the split everywhere else in here.
   *
   * Only the pastime prop reads it today, exactly as only shelves read
   * `surface`. On anything else it is simply ignored.
   */
  drift: z.boolean().default(false),
  /**
   * "This part is the BACK of the piece — put it where nothing is attached."
   *
   * Only conveyors read it, and it is the same lesson the rails already
   * learned. A rail authored on a belt model puts a wall between every pair of
   * cells, so a straight run comes out as a row of boxed slabs; the fix was to
   * stop authoring rails and let the renderer lay them per EDGE, from what is
   * actually across each one.
   *
   * A loader's housing is that bug in the one place it survived. It is authored
   * at the model's `-z`, and a loader is turned by the FLOW rather than by
   * `rot`, so on a bend it swings round and comes to rest against whichever
   * side the run happens to leave by — a two-foot curb across the boundary with
   * the belt that feeds it. It is not a rendering slip you can argue about: the
   * piece has four sides, three of them attached to something, and the housing
   * is standing on one of the three.
   *
   * So the part stays authored — colour, size and height are the author's — and
   * the renderer chooses the SIDE, preferring one with a wall across it and
   * drawing nothing at all when every side is spoken for.
   */
  back: z.boolean().default(false),
  /**
   * "This part MOVES while the thing it belongs to is working."
   *
   * A machine mid-batch and a machine that has been sat there since Tuesday
   * are the same picture, which is the whole reason this exists: an appliance
   * says what it is doing by moving, not by a number in a menu you have to
   * open. So a blade turns, a lever judders, a light throbs.
   *
   * The same split every other look in here makes. The AUTHORED half is these
   * three numbers; the LOOP is code, because a loop is exactly what stages
   * cannot say — a stage arc plays once across a batch and a blade has to keep
   * going. Same argument, same shape, as `drift`.
   *
   *   spin    turns about its own Y axis. `hz` is turns per second, and this is
   *           the one kind `amount` says nothing about — a turn is a turn.
   *   bob     rises and falls by `amount` tiles, `hz` times a second.
   *   shake   judders by `amount` tiles in the ground plane. A press, a fryer.
   *   pulse   swells and shrinks by `amount` of its own size. A lamp, a heater.
   *   sweep   turns TO the piece's `signal` rather than looping — see below.
   *
   * WHAT COUNTS AS WORKING is the renderer's question, and it has one rule:
   * a thing that can be busy moves while it *is* busy, and a thing that has no
   * idea what busy means — a fan, a sign, a mobile — always moves. Without that
   * second half this would be a field that silently does nothing on everything
   * except a station, which is the "tier that changes no number" trap wearing a
   * different hat.
   *
   * Two kinds of thing can be busy, and they answer it from different places. A
   * fixture is busy mid-batch, which only an appliance can be. A WORKER is busy
   * when they have a job — `job` on the wire, which the roster already reads —
   * and deliberately not while they are on a break: `stepStaff` writes
   * `job = 'break'` for a charge rather than clearing it, so a bot sat with a
   * mug is the one case the renderer has to spell out. Walking to the mess
   * counts, because it is the job; standing about with nothing to do does not.
   *
   * A hire is a `buildModel` like anything else, so this was collected onto
   * their group from the day workers stopped being coloured capsules and simply
   * never animated — which is the shape of a flag that reads as authored and is
   * dead. If you add a third kind of thing that can be busy, the rule above is
   * what it owes an answer to.
   */
  motion: z.object({
    /**
     * `scroll` is a belt's answer, and it is here rather than being faked with
     * `shake` for the reason `verify:motion` already records about the blender:
     * spinning a roller is invisible, because a cylinder is rotationally
     * symmetric and a perfectly correct animation nobody can see is the same
     * picture as no animation. What reads as a running conveyor is the SLATS
     * travelling along it and wrapping — which is a translation, and none of
     * the four kinds above is one.
     */
    kind: z.enum(['spin', 'bob', 'shake', 'pulse', 'sweep', 'scroll']),
    /** Cycles a second — turns a second for `spin`. Ignored by `sweep`, which has no clock. */
    hz: z.number().min(0.05).max(12).default(1.5),
    /**
     * How big the movement is: tiles for `bob`/`shake`, a share of its own size
     * for `pulse`, and for `scroll` the distance travelled before it wraps —
     * which for a belt slat is the gap to the next one.
     */
    amount: z.number().min(0).max(1).default(0.05),
    /**
     * `sweep` only: how many whole turns the part makes over one run of the
     * signal, 0 to 1. An hour hand is 2 and a minute hand is 24, which is the
     * whole of what makes a clock a clock.
     *
     * SIGNED, and that is not a tidiness knob: a double-sided sign is the same
     * hand drawn twice, and the far face is watched from the far side, so the
     * two have to turn opposite ways to both read clockwise. Deriving that from
     * which side of the case a part sits on was the alternative, and it would be
     * a rule that silently spins the wrong way on the first prop that is not a
     * clock.
     */
    turns: z.number().min(-60).max(60).default(1),
    /**
     * The point it turns about, in model space. Left out, a part turns about its
     * own middle, which is what every kind above does and what a fan blade
     * wants.
     *
     * A hand does not: it is hinged at the centre of a face it does not sit in
     * the middle of, and a hand pivoting about its own waist is a compass
     * needle. There is no reading of the art that answers this — a bar offset
     * from a case could be hinged at either end or at neither — so it is the one
     * thing here that has to be said rather than measured.
     */
    pivot: z.tuple([z.number(), z.number(), z.number()]).nullable().default(null),
  }).nullable().default(null),
  /**
   * "Whoever is wearing this decides what colour this part is."
   *
   * A skin is a palette, not a body — see `SkinSchema`. A part naming a slot
   * takes its colour from the worn skin; a part that names none keeps the
   * colour it was authored with, forever. That split is the whole design: the
   * chassis is tinted and the JOB PAYLOAD is not, so a skin can repaint a bot
   * head to toe and never touch the thing that says which bot it is.
   *
   * The authored `color` stays required and is what an unskinned bot draws, so
   * a model is always a complete picture on its own — a slot is an override,
   * not a hole. Same shape of idea as `surface` and `drift`: a flag on a part
   * one renderer knows how to read, rather than a second kind of model.
   */
  tint: z.enum(['chassis', 'trim', 'glow']).nullable().default(null),
});

/**
 * How many boxes one look may be made of.
 *
 * Eight for as long as everything in the game was a single run of shelving, a
 * machine or a pot plant. A CORNER unit is the thing that broke it: an L is two
 * runs meeting, so it wants two backs, two lids, two plinths and two boards per
 * level — twice a straight unit, and no amount of care gets that under eight.
 * Every attempt to fit it instead came out as a worse corner: no lid, two board
 * levels instead of three, wings too shallow to line up with the units either
 * side.
 *
 * It is a ceiling on how much geometry one prop is worth drawing, not a design
 * rule, and the cost of raising it is meshes per fixture. Sixteen is still well
 * inside what this renderer does happily, and it is the first number here that
 * was ever load-bearing on what could be MODELLED rather than on what performs.
 *
 * A WORD is what broke it the second time, and it is a different kind of demand
 * from the corner unit's. An L wanted twice a straight unit because it is two
 * units; letters want a part per STROKE, and there is no care or cleverness that
 * gets O, P, E and N under four strokes each — the shapes are the shapes.
 *
 * And then twice again, for the reason that is obvious only once you have looked
 * at the thing: **writing has a front**. A tube thick enough to stand proud of
 * both faces of a panel is one word seen from one side and its mirror from the
 * other, which is what a real shop window does and what a game reads as a bug —
 * the far side of the sign says N3PO. So a double-sided sign is the word twice,
 * laid the opposite way round, and there is no sharing between the two halves.
 * Sixteen strokes a face, two faces, a board and a hanger: thirty-four.
 *
 * The cost is smaller than the number looks: `weld` merges by material, so a
 * two-colour sign of thirty-four parts is two meshes, exactly as a two-colour
 * shelf of eight is. What this really caps is authoring effort and the size of a
 * row — and the day something wants a longer word than OPEN, this is a number
 * and not a rule.
 */
const MAX_PARTS = 36;

/**
 * One look, for something that changes as it goes along. `at` is where on the
 * 0..1 run this stage takes over — see `shared/model.js` for who feeds what
 * into that number.
 */
const STAGE = z.object({
  name: z.string().max(32).default(''),
  at: z.number().min(0).max(1).default(0),
  parts: z.array(PART).min(1).max(MAX_PARTS),
});

export const ModelSchema = z.object({
  /** The whole thing, always. What almost everything wants. */
  parts: z.array(PART).min(1).max(MAX_PARTS).optional(),
  /** ...or a progression: a sprout, a bush, a laden plant. */
  stages: z.array(STAGE).min(2).max(6).optional(),
})
  .refine((v) => !!v.parts !== !!v.stages, {
    message: 'give a model either `parts` or `stages`, not both and not neither',
  })
  .refine((v) => !v.stages || v.stages.some((s) => (s.at ?? 0) === 0), {
    message: 'the first stage must start at 0, or a brand new one has nothing to draw',
    path: ['stages'],
  })
  .refine((v) => !v.stages || v.stages.every((s, i, all) => i === 0 || s.at >= all[i - 1].at), {
    message: 'stages must be ordered by `at`, lowest first',
    path: ['stages'],
  })
  .default({ parts: [{ shape: 'box', color: '#cccccc', pos: [0, 0, 0], scale: [0.3, 0.3, 0.3], rot: 0 }] });

/** Tags are free-form, but we warn on unknown ones so typos surface. */
const TagList = z.array(z.string().min(1)).min(1).max(12);

export const ItemSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  tags: TagList,
  /** What you pay your supplier per unit. */
  base_cost: z.number().min(0).max(10000),
  /** Suggested sticker price. Players can undercut or gouge. */
  base_price: z.number().min(0).max(10000),
  /** Days on the shelf before it starts going bad. Ignored if shelf-stable. */
  shelf_life_days: z.number().min(0).max(365).default(5),
  /** How many units fit in one shelf stack. */
  stack: z.number().int().min(1).max(99).default(12),
  model: ModelSchema,
}).refine((v) => v.base_price >= v.base_cost, {
  message: 'base_price must be >= base_cost (otherwise the item loses money by design)',
  path: ['base_price'],
});

export const CropSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /** Which item this crop produces when harvested. Must already exist. */
  item_id: slug,
  /** Real-world minutes to go from seed to harvestable. */
  grow_minutes: z.number().min(0.1).max(600),
  yield_min: z.number().int().min(1).max(99).default(1),
  yield_max: z.number().int().min(1).max(99).default(3),
  seed_cost: z.number().min(0).max(10000),
  /** Empty array = grows in every season. */
  seasons: z.array(z.enum(['spring', 'summer', 'autumn', 'winter'])).default([]),
  model: ModelSchema,
}).refine((v) => v.yield_max >= v.yield_min, {
  message: 'yield_max must be >= yield_min',
  path: ['yield_max'],
});

export const ArchetypeSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /** tag -> how much this shopper likes it, roughly -1..1. */
  affinities: z.record(z.string(), z.number().min(-2).max(2)),
  /**
   * Tags this shopper actually came in for. Everything else on their list is
   * opportunistic; miss one of these and they leave annoyed and it is counted
   * against you. Empty means "just browsing", which is what everyone did
   * before this column existed.
   */
  staple_tags: z.array(z.string()).max(8).default([]),
  /**
   * What KIND of shopper this is — not what they want, which is `affinities`,
   * and not what they came in for, which is `staple_tags`. This is the handle
   * anything authored can match them on, and until it existed there was none:
   * a row that wanted to say "this is for the tight-fisted ones" had no choice
   * but to name an archetype id, which is the one thing `if (item.id ===
   * 'tomato')` exists to keep out of the database.
   *
   * Read by `KitSchema` today. Empty is every archetype written before it, and
   * a kit with no tags of its own will still go to them.
   */
  tags: z.array(slug).max(12).default([]),
  /** 0 = doesn't look at price tags. 1 = extremely price-driven. */
  price_sensitivity: z.number().min(0).max(1).default(0.5),
  /** Seconds they'll wait in a queue before abandoning their basket. */
  patience: z.number().min(5).max(600).default(60),
  /**
   * The chance this shopper walks out with their basket instead of paying for
   * it. See docs/security.md.
   *
   * 0 — the default, and every archetype ever authored — is a town where
   * nobody steals, which is the game as it has always been: the roll is not
   * taken at all, so no existing save's RNG stream moves and no balance figure
   * in this repo is invalidated by this column existing.
   *
   * It is a property of the KIND of person rather than of the shop, which is
   * the whole reason it lives here: a shoplifter is content, so a new one is
   * one `create_archetype` call and no code, exactly as a new customer type has
   * always been. What the SHOP can do about it belongs on the guard (step 4),
   * not here.
   */
  steal_chance: z.number().min(0).max(1).default(0),
  budget_min: z.number().min(0).default(10),
  budget_max: z.number().min(0).default(50),
  basket_min: z.number().int().min(1).max(30).default(1),
  basket_max: z.number().int().min(1).max(30).default(4),
  /** Relative likelihood of spawning vs other archetypes. */
  spawn_weight: z.number().min(0).max(100).default(1),
  color: hexColor.default('#d98cb3'),
}).refine((v) => v.budget_max >= v.budget_min, {
  message: 'budget_max must be >= budget_min', path: ['budget_max'],
}).refine((v) => v.basket_max >= v.basket_min, {
  message: 'basket_max must be >= basket_min', path: ['basket_max'],
});

/**
 * A world event — the world director's main lever.
 *
 * Effects are deliberately expressed against TAGS, not item ids, so an event
 * written today still works on an item invented next week.
 */
export const EventSchema = z.object({
  id: slug,
  name: z.string().min(1).max(64),
  description: z.string().max(280).default(''),
  /** Multiply demand for anything carrying these tags. */
  effects: z.array(z.object({
    tag: z.string().min(1),
    demand_mult: z.number().min(0).max(10).default(1),
    price_mult: z.number().min(0).max(10).default(1),
  })).min(1).max(8),
  duration_days: z.number().int().min(1).max(30).default(2),
  weight: z.number().min(0).max(100).default(1),
  /** Only fire at/after this day. Lets you gate late-game chaos. */
  min_day: z.number().int().min(0).default(0),
});

export const UpgradeSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  description: z.string().max(280).default(''),
  cost: z.number().min(0),
  // `floor` is here so a flooring deal can be authored as a discount the way
  // every other fixture deal is (`fixtureDiscount`). Nothing ships one — it
  // costs a word to allow and a migration to add later.
  // `hours` moves the trading window — `{ open, close }` in whole hours, read
  // by `Game.tradingHours`. A licence rather than a switch, and authored rather
  // than hardcoded, so "open till ten" and "open all night" are two rows of
  // content and not two features.
  kind: z.enum(['shelf', 'freezer', 'warmer', 'plot', 'checkout', 'floor', 'capacity', 'speed', 'decor', 'staff', 'station', 'space', 'catchment', 'hours']),
  /** Free-form knobs, interpreted by the sim for that `kind`. */
  payload: z.record(z.string(), z.any()).default({}),
  /** Must own these upgrades first. */
  requires: z.array(slug).default([]),
});

/** Warn (don't reject) when tags aren't in the known vocabulary. */
export function unknownTags(tags) {
  return tags.filter((t) => !ALL_TAGS.includes(t));
}

/**
 * Turn ingredients into a finished product. Like everything else here it's
 * declarative content: the station is named, not hardcoded, so a recipe
 * authored today runs on an appliance invented later.
 */
export const RecipeSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  station: slug,
  inputs: z.array(z.object({
    item_id: slug,
    qty: z.number().int().min(1).max(20).default(1),
  })).min(1).max(4),
  output_id: slug,
  output_qty: z.number().int().min(1).max(20).default(1),
  minutes: z.number().min(0.1).max(120).default(1),
});

/**
 * What a thing gives off, wherever it is authored.
 *
 * Named because it is now written in two places on one row: on the PIECE, which
 * is a thing that glows for as long as it exists (a lamp), and on a TIER, which
 * is a thing that glows once you have paid for the rung that lights it (the
 * strip inside a display fridge). Same shape both times, so the renderer asks
 * one question and content decides which of the two answers it.
 */
const emitsShape = z.object({
  color: hexColor.default('#ffd9a0'),
  /** How bright. Above ~2 a single lamp washes the aisle out. */
  intensity: z.number().min(0).max(4).default(1),
  /** How far the glow carries, in tiles. */
  range: z.number().min(0.5).max(12).default(4),
});

/**
 * What a thing SOUNDS like — `emits` for the other sense, and deliberately the
 * same shape of idea: content says what noise a piece makes, and how many may
 * play at once, how far away is too far and what steals what stay in code
 * (`client/audio/sfx.js`). The same line `BUILD_KINDS` draws.
 *
 * Every field is the id of a row in `client/audio/manifest.js` — which is code,
 * because it is a file that has to be in the bundle, and that asymmetry is the
 * point: authoring picks from the sounds the game ships, exactly as `model`
 * picks from the shapes the renderer knows how to draw. An id that names
 * nothing is silence, and silence is indistinguishable from a piece meant to be
 * quiet, which is why docs/audio.md step 6 wants a sweep over precisely this.
 *
 * `loop` is the one that needs care, and it takes its cue from `work`: **a
 * thing that knows what working means loops WHILE it works, and a thing that
 * does not loops always.** A fridge hums for as long as it exists; a blender
 * only while there is a batch in it. Without that second clause the field would
 * silently do nothing on every kind except `station`, which is the "tier that
 * changes no number" trap wearing headphones.
 */
const sfxShape = z.object({
  /** While it runs, or forever for a thing with no idea what running is. */
  loop: slug.nullable().default(null),
  /** When somebody works it. */
  use: slug.nullable().default(null),
  /** When a batch finishes. */
  done: slug.nullable().default(null),
  /**
   * How fast to play it, which is how LOW or HIGH it sounds.
   *
   * The one field here that is not an id, and it is here because of the
   * asymmetry above: a sound has to be in the bundle, so authoring picks from
   * what ships — and the game ships one machine loop against eleven appliances,
   * every one of them a variant of a single row. Eleven machines humming the
   * identical note is not eleven machines, it is one machine you can hear from
   * anywhere, which is the same failure `startLoop`'s start-offset hash exists
   * to prevent said about pitch instead of phase.
   *
   * A blender is not a deep fryer at 0.8×, and nobody should pretend it is —
   * this buys a shop that sounds like it has different machines in it, not a
   * sound library. The bounds are where a loop still reads as machinery: under
   * about 0.6 it is a generator, over about 1.6 it is a dentist.
   */
  rate: z.number().min(0.6).max(1.6).default(1),
});

/**
 * A piece: one thing you can put down, and how far you can upgrade one.
 *
 * The *rules* stay in code — where it may go, whether it blocks, which side you
 * use it from (`shared/build.js`, `BUILD_KINDS`). What it looks like, what it
 * costs and what a better one is worth are content, so a second shelf design, a
 * terracotta planter or a hanging lamp is an MCP call rather than a deploy.
 *
 * `id` used to *be* the kind, which capped the catalog at one entry per kind
 * forever. It is now yours to choose, and `kind` names which closed set of rules
 * it plays by. A row written before that split has no `kind` and is read as
 * naming itself — see `kindOf` in `shared/pieces.js`. That is deliberately a
 * read-time default rather than a migration: an old database, an old export and
 * a fresh seed then all agree, and nobody has to remember to run anything.
 */
export const FixtureSchema = z.object({
  id: slug,
  /**
   * Which build rules this plays by. Optional here and checked against
   * `BUILD_KINDS` in `writeContent`, which is the same gate — that keeps the
   * "a row with no kind names itself" default in one place, next to the error
   * message that lists what the kinds actually are.
   */
  kind: slug.optional(),
  name: z.string().min(1).max(48),
  /**
   * Staged by tier: stage 1 is what you buy, the last stage is fully upgraded.
   * An unstaged model just means every tier looks the same.
   *
   * Nullable for exactly one kind, and the refine at the bottom is what holds
   * that line. A floor has no model because it is not a thing standing in a
   * cell — it *is* the cell, and a slab drawn one tile wide is the tile. Giving
   * it a model would mean authoring a box whose geometry is then ignored, which
   * is a lie the next person has to discover. It carries `surface` instead.
   */
  model: ModelSchema.nullable().default(null),
  /**
   * What it looks like WHILE IT IS WORKING — drawn over the piece for as long
   * as it is mid-batch, and staged by how far through that batch it is.
   *
   * A second model rather than more parts on the first one, for a reason that
   * is structural rather than tidiness. `model` already spends its 0..1 on the
   * TIER — a Commercial machine is stage 2 of its own art — and a batch is a
   * second quantity that runs from 0 to 1 on its own clock. One resolver takes
   * one number, so two quantities need two models. That split also says the
   * right thing about each half: the machine is what you bought, the work is
   * what it is doing, and dough going into a loaf has nothing to do with which
   * rung of the ladder you are on.
   *
   * It is drawn in the machine's own model space, so a puff authored at the
   * spout comes out of the spout. `drift` on a part gives it steam, `motion`
   * gives it movement, and a piece with no `work` at all simply carries on
   * looking exactly as it does today.
   *
   * Nothing in the sim reads it — it moves no number and needs no `simulate`.
   * A variant may carry its own; one that doesn't falls back to this, so a
   * generic "steam and a light" authored here covers every appliance nobody has
   * drawn a specific one for.
   */
  work: ModelSchema.nullable().default(null),
  /**
   * The ANIMAL — a body that walks around, rather than a part of the building
   * it came out of.
   *
   * A third model, and the split is the same one `work` makes and for a reason
   * just as structural: `model` is the shelter, which is staged by TIER and
   * stands still on its cells, and this is a thing with legs whose position is a
   * fact about the world rather than about the placement. There is no 0..1 to
   * spend on it at all — one pen draws `heads` copies of this, each somewhere
   * different, so it is not a stage of anything.
   *
   * Authored in ONE TILE, standing at the origin, nose east — `buildModel`'s
   * own convention, and the same one a worker's `model` and a vehicle's obey. It
   * is scaled by nothing: an animal is the size it is drawn, which is what lets
   * a hen and a cow be authored to the same scale as the people and read
   * correctly next to them.
   *
   * Null is a pen with nobody in it, which is a perfectly good pen — a beehive
   * has no body to speak of, and the hive being the whole of what you see is
   * right. Nothing in the sim reads it: heads are counted off the paddock, so a
   * piece nobody has drawn an animal for produces exactly as fast as one
   * somebody has. It moves no number and needs no `simulate`.
   */
  body: ModelSchema.nullable().default(null),
  /**
   * "This one watches the shop" — which world quantity drives its art, out of
   * `WORLD_SIGNALS`.
   *
   * A third driver for the same one 0..1 `model` already takes, and the reason
   * it is a piece-level field rather than a second model is that it REPLACES the
   * number rather than adding one. A tier is a fact about the unit and a signal
   * is a fact about the shop, and there is no prop that wants both: naming a
   * signal is how a piece says its ladder is not what its art is about.
   *
   * Which is why this belongs on props and nothing else, and why nothing here
   * enforces that. A shelf with a signal would author perfectly and quietly stop
   * showing you which shelf you bought — the same shape of trap as a tier that
   * changes no number, so it is written down instead: **a piece with a real tier
   * ladder must not name a signal.**
   *
   * Both readers take it from here — `stages` swap on it, and a part flagged
   * `sweep` turns to it — so one field covers a sign that changes look and a
   * clock hand that changes angle. Null is every piece that ever existed, which
   * is why nothing in a live shop moved on the day this landed.
   */
  signal: z.enum(SIGNAL_NAMES).nullable().default(null),
  /**
   * Other shapes of the same thing: a corner unit, an endcap, a low one.
   *
   * A variant is a LOOK and nothing else, and that is enforced by where it
   * sits rather than by asking authors nicely — it carries a model, while the
   * numbers live on `tiers` below, one ladder shared by every shape. So a
   * corner shelf holds exactly what a straight one holds, restyling something
   * you already own is free, and no variant can ever move the balance or need
   * `simulate` re-run. Tiers cost money and change numbers; variants are taste.
   *
   * The empty id is the kind's own `model` — "Standard" — so every fixture
   * that never heard of variants still has one.
   *
   * `work` is here for the same reason `model` is, and stays a look for the
   * same reason: a toaster and a blender are two variants of one appliance, so
   * what they do while they run has to be authorable per shape or six of the
   * seven machines in the shop steam out of the same corner.
   */
  /*
   * The ceiling is 16 rather than 8 because of what the station row turned
   * out to be: every appliance in the game is a VARIANT of that one row, so
   * this bound is not "how many shapes may a shelf come in" — it is how many
   * machines the shop may ever own. Eight was reached by the oven, and the
   * ninth failed validation with a message about array length, which reads as
   * a typo rather than as a design ceiling. Raising it is safe in the way the
   * comment above says: a variant carries a model and no numbers, so nothing
   * added here can move the balance.
   *
   * 16 → 24 for docs/production.md: the eleven appliances that exist are all
   * FINISHING machines, and the six that graph needs are the primary processing
   * verbs nothing in the shop has ever had — a mill, a mixer, a churn, a
   * butcher's block, a blast freezer and a candy kettle. Eleven plus six is
   * seventeen, so the ceiling was the first thing in the way.
   */
  variants: z.array(z.object({
    id: slug,
    name: z.string().min(1).max(32),
    model: ModelSchema,
    work: ModelSchema.nullable().default(null),
    /**
     * ...and what it sounds like while it does, which is here for exactly the
     * argument `work` is: what a machine looks like running is a look, and so
     * is what it sounds like. Every appliance in the game is a variant of one
     * row, so a sound authored only on the piece is one noise for the whole
     * kitchen — the ear's version of six machines steaming out of the same
     * corner. Falls back to the piece's, so a shape that says nothing sounds
     * the way it always did.
     */
    sfx: sfxShape.nullable().default(null),
  })).max(24).default([]),
  /**
   * Tier 1 is what a new one is, so it costs nothing and is listed first.
   * Every later tier is something you pay to step up to, in order.
   */
  tiers: z.array(z.object({
    name: z.string().min(1).max(32),
    cost: z.number().min(0).default(0),
    /** Units one holds, x this. Shelves and freezers. */
    capacity_mult: z.number().min(0.1).max(10).default(1),
    /** How long goods last on it, x this. Freezers mostly. */
    keeps_mult: z.number().min(0.1).max(20).default(1),
    /** How fast it works, x this. Appliances, crops in a plot, and a till. */
    speed_mult: z.number().min(0.1).max(10).default(1),
    /**
     * What share of that speed it manages with NOBODY behind it. Checkouts.
     *
     * 0 — the default, and every till there has ever been — means the line
     * stands there until a person walks up to it. Above 0 it is a self-service
     * machine: the shopper rings themselves up at `speed_mult * unattended`,
     * so 0.5 is a till that serves itself at half the speed somebody working
     * it would manage.
     *
     * A number rather than a flag, because "does it serve itself" and "how
     * well" are one question and a boolean can only answer the half nobody
     * has to balance. It also keeps the ladder honest: a rung that moves this
     * has moved a number the sim reads, which is the only thing that makes a
     * rung worth its price.
     */
    unattended: z.number().min(0).max(1).default(0),
    /**
     * How many recipes this machine may be SET TO at once. Appliances.
     *
     * 1 — the default, and every rung there has ever been — is a machine that
     * knows several recipes and runs one. Above 1 it is a twin: each head holds
     * its own recipe and runs its own batch, in parallel, out of the one shared
     * hopper. What the rung sells is how many at once, never *which* — a
     * `min_tier` on a recipe would take a recipe away from a machine on the way
     * back down and hide one authored this afternoon from a shop that already
     * owns the machine for it.
     *
     * An integer because it is a count of heads. It is the fifth knob the sim
     * reads, and `scripts/document-fixtures.js` has to know that or the
     * generated reference lists a Twin rung under "tiers that change no number"
     * — the warning that exists to catch exactly the opposite mistake.
     */
    lines: z.number().int().min(1).max(4).default(1),
    /**
     * How many shoppers this rung bills WITHOUT a queue at all. Checkouts.
     *
     * 0 — the default, and every rung there has ever been — is a till: goods go
     * past a counter somebody or something is stood at, and the line is the
     * whole texture. Above 0 it is a walk-out sensor, and it is the end of the
     * ladder rather than another step up it: `unattended` sells not needing a
     * clerk and this sells not needing the QUEUE, which is the thing the ladder
     * was a ladder of. A shop that owns one stops laying lines.
     *
     * The number is how many it tracks *cleanly* at once, and it is a count
     * rather than a flag because the price of the rung is paid in shrinkage:
     * `walkoutMiss` is the shop's load over the covers it owns, so one unit in a
     * quiet shop is near enough perfect and the same unit in a packed one
     * bleeds. Which is what makes owning several a decision instead of a
     * formality — the answer to "do I need more than one" is "only once you are
     * busy", and the shop tells you by losing things.
     *
     * A flag could not say any of that: it would be one purchase, one permanent
     * tax, and nothing to do about it ever again. It is also the sixth knob the
     * sim reads, so `scripts/document-fixtures.js` has to know about it or the
     * generated reference files a walk-out rung under "tiers that change no
     * number" — the warning that exists to catch the opposite mistake.
     */
    covers: z.number().int().min(0).max(64).default(0),
    /**
     * PENS ONLY — the most animals this rung will keep, however much grazing you
     * paint around it.
     *
     * The paddock is the SUPPLY and this is the CEILING, and the pair is what
     * makes both worth having. A field alone is one brush stroke buying an
     * unbounded divisor on the clock, which is a printer; a rung alone is a
     * number you buy with no land behind it, and the fence and the acre stop
     * meaning anything. You need enough grazing *and* a shelter big enough, and
     * whichever you are short of is the one to spend on next.
     *
     * It is the third thing this ladder sells and the three are deliberately
     * different questions: `speed_mult` is how OFTEN you must come,
     * `capacity_mult` is how LONG you may leave it, and this is how MANY. Fold
     * any two together and one of the decisions disappears.
     *
     * **One rather than zero**, for `lines`' reason exactly: this is a count of
     * bodies and every pen ever built has at least the one it has always had. A
     * pen row authored with no `heads` on its rungs is step 1's pen — one
     * animal, today's numbers to the digit, and a paddock painted round it that
     * does nothing. Which is the honest answer, and is why the seven shipped
     * pieces all set it.
     */
    heads: z.number().int().min(1).max(24).default(1),
    /**
     * A light this rung switches on. Null on every rung is a fitting that never
     * glows, which is every fixture in the game except the lamps.
     *
     * The first thing a tier can sell that is not a multiplier, and it is worth
     * knowing why that is allowed here when "a tier that changes no number is a
     * button that takes money and does nothing" is the rule everywhere else. A
     * glow is not a number the sim reads and never will be — but it is not
     * decoration either, because the shop's lighting is now baked out of
     * exactly these records (`bakeInto`), so a lit rung genuinely changes what
     * the room looks like from across it. A rung that sells ONLY this is a rung
     * that sells a look, and should be priced like one.
     *
     * Falls back to the piece's own `emits`, so a lamp with tiers goes on
     * glowing at every rung without authoring it six times.
     */
    emits: emitsShape.nullable().default(null),
    /**
     * Whether THIS rung can be worked from the back — see `open` on the piece
     * below for what the flag means and why it may not be a variant.
     *
     * Nullable and falling back to the piece's own, exactly as `emits` does, and
     * for a sharper reason than saving anyone typing: a boolean that DEFAULTED
     * would answer false on every rung ever authored, so the piece-level flag
     * would stop being read the day this field existed and three open pieces
     * would quietly close. Null is "this rung has no opinion".
     *
     * It is the second thing a tier can sell that is not a multiplier, and it
     * clears the bar `emits` had to clear: how many sides a unit can be worked
     * from is flow, and flow is money. That is also why it is a TIER and not a
     * variant — a shape may never move a number, and this one moves plenty.
     *
     * A rung that opens a unit and a later rung that says nothing are not a
     * contradiction: read the ladder down, not up. `openOf` takes the highest
     * rung at or below this one that has an opinion, so authoring it once at
     * tier 2 opens tier 3 as well — and a *downgrade* honestly closes the back
     * again, the same way stepping down a rung can take a board away.
     */
    open: z.boolean().nullable().default(null),
  })).min(1).max(6).default([{ name: 'Standard', cost: 0 }]),
  /**
   * What one costs to put down, or 0 to be priced by the upgrade that sells the
   * kind — which is how every fixture in the game is still priced.
   *
   * Both, rather than one, because a decoration has no upgrade behind it and a
   * shelf has nothing else. Leaving it at 0 is what keeps this change worth no
   * money either way: every existing piece prices exactly as it did, so nothing
   * here needs `simulate` re-run. Moving the whole economy onto this field is a
   * later step, and a deliberate one.
   */
  cost: z.number().min(0).max(100000).default(0),
  /**
   * A light. Content says what it gives off; honouring it is the renderer's job,
   * and nothing in the sim reads it.
   *
   * That is worth being honest about rather than quietly true: a lamp is
   * decoration with a glow until something chooses to care, and if lighting is
   * ever meant to *matter* the hook is the tag system — a dim aisle tagged, an
   * archetype that avoids it — not a check against a piece id.
   */
  emits: emitsShape.nullable().default(null),
  /**
   * A noise. Content says what it sounds like; playing it is the client's job,
   * and nothing in the sim reads it — the same split `emits` makes, and it has
   * to be that way round for the same reason: a sound is a report about the
   * shop, so nothing about the shop may depend on having heard one.
   *
   * Null is "this one is quiet", which is every row written before sound
   * existed and is why nothing in a live shop changed on the day this landed.
   */
  sfx: sfxShape.nullable().default(null),
  /**
   * A thing that produces money on its own — the first thing a piece can do
   * that is neither a look nor a place to put stock.
   *
   * It pays into the pile of cash on the floor rather than into the bank, and
   * that is the whole design. Money you have to walk to is money the shop can
   * be too busy to collect, which makes it a decision rather than a trickle;
   * it reuses the one entity, one renderer and one pickup path a till already
   * has (`dropCash`); and the stocker sweeping it up is a job that already
   * exists. Never invent a second kind of money on the floor.
   *
   * `every` is in-game MINUTES. Authored on the piece, so any fixture can earn
   * — a money tree, a vending machine, a busker's hat — and nothing in the sim
   * knows what a money tree is.
   */
  yields: z.object({
    cash: z.number().min(0).max(500),
    every: z.number().min(1).max(1440).default(60),
  }).nullable().default(null),
  /**
   * ...and the same sentence about GOODS, which is what a pen is.
   *
   * Its own field rather than a third key on `yields`, and the split is the one
   * `yields` already argues for itself: cash goes straight onto the floor as a
   * pile anybody walks over, and goods go into the pen and wait to be collected
   * from its gate. Two destinations, two readers, two ways of running out — a
   * pen fills up and stops, a money tree never does. One field answering both
   * would be a nullable pair of branches inside every caller.
   *
   * `qty` is one batch and `every` is in-game MINUTES, exactly as `yields.every`
   * is. Neither is the whole story on a placed pen: the tier ladder multiplies
   * them (`speed_mult` shortens the wait, `capacity_mult` is how many batches it
   * will stockpile before it stalls), which is what keeps a rung from being a
   * button that takes money and moves no number.
   *
   * Nothing but `pen` reads it, and nothing enforces that — the same bargain
   * `signal` strikes. A shelf with a `produces` would author perfectly and do
   * nothing at all.
   */
  produces: z.object({
    item_id: slug,
    qty: z.number().int().min(1).max(64).default(1),
    every: z.number().min(1).max(1440).default(60),
  }).nullable().default(null),
  /**
   * How much nicer this makes the shop look, which is how far word of it
   * travels — see `Game.charm`.
   *
   * It feeds CATCHMENT rather than reputation or pull, and the difference
   * matters. Reputation is what the people who came in think of you, and it is
   * already a closed loop the shop can max out. Catchment is how much of the
   * town is within reach at all — the one term shopkeeping could not move — so
   * "my shop is worth crossing town for" is exactly the sentence a decoration
   * should be able to say. It saturates hard (`CHARM_MAX`), because a hundred
   * planters is a warehouse, not a destination.
   *
   * Unitless and small: 1 is a nice pot plant, 5 is a centrepiece.
   */
  charm: z.number().min(0).max(20).default(0),
  /**
   * Can you walk all the way round it and work it from the back?
   *
   * A display table can be reached from four sides and a shelving unit from
   * three — front and both ends, never through the back panel — and those are
   * the SAME KIND wearing two shapes, so the difference cannot live in
   * `FIXTURES`. `ends` there says every shelf-like unit is workable from its
   * ends; this says this particular design has no back to speak of.
   *
   * Deliberately not a variant, and this is the one field on a piece that has
   * to justify that. A variant carries a model and only a model, precisely so
   * that no shape anybody draws can move a number or need `simulate` re-running
   * — and a unit you can stand on any side of is a unit two people can work at
   * once and a shopper can reach past a queue, which is flow, which is money.
   * A thing that changes how the shop *runs* is not a look.
   *
   * It changes reach and what the markers draw, and deliberately nothing else:
   * where the generator reserves a spot, where a tap walks you and what
   * `canPlace` demands all still go by the one stored anchor. See `spotsOf`.
   *
   * This is the design's answer at every rung. A rung may override it — see
   * `open` on a tier above — and `openOf` is the one place the two are resolved.
   */
  open: z.boolean().default(false),
  /**
   * What a floor is made of. The `model` of a piece that hasn't got one.
   *
   * Two colours and a pattern, which is the whole vocabulary on purpose. A
   * floor is seen edge-on at 45° under everything else in the shop, so what
   * reads from across the room is its colour and whether it repeats — geometry
   * would cost a tile of draw call each and be invisible. The renderer already
   * jitters every ground cell slightly, so `plain` is not flat.
   *
   * `accent` is the second colour of the pattern and is ignored by `plain`.
   * Left out it derives from `color`, so a one-colour floor is one field.
   */
  surface: z.object({
    color: hexColor.default('#b9a888'),
    accent: hexColor.nullable().default(null),
    /**
     * How the two colours repeat. `plain` uses only the first.
     *
     * `stripes` is bands one cell wide running along z, which is what makes a
     * pedestrian crossing authorable rather than a kind — see `GROUND.path`. It
     * is the one pattern whose *direction* means something, so a crossing drawn
     * north–south and one drawn east–west are the same design laid two ways.
     *
     * `tufts` is the second one that is not a colour at all: blades stood up off
     * the cell in `accent` over a base of `color`. It is what makes a lawn worth
     * having a row — the ground is seen edge-on at 45°, so a colour is all that
     * survives of a *flat* pattern, and the way you tell grass from lino is that
     * grass has height. Authorable on any ground kind on purpose: weeds through
     * a cracked yard is a design somebody may want, and refusing it would mean
     * this enum knowing which kinds are outdoors, which is not something a look
     * should know.
     */
    /*
     * `brick` is the third of those and the first that is about a WALL. It is
     * here rather than as a per-cell colour for the reason the other two are:
     * one cell is about a metre and a half, so "brick" drawn as a colour is a
     * brick the size of a door, which is what a chequer of red and cream
     * actually looks like on a shopfront. Courses stood proud of the face in
     * `color` over mortar in `accent`, half-bonded, and stylised rather than
     * true to scale — a 65mm course is a third of a pixel at this camera, so
     * the honest choice is between blocky brick and no brick.
     */
    pattern: z.enum(['plain', 'checker', 'planks', 'stripes', 'tufts', 'brick', 'tiles']).default('plain'),
    /**
     * How many bars a `stripes` cell is painted with. Null takes the default.
     *
     * The pattern LIST is code — how a pattern is drawn is renderer geometry,
     * and the closed set is the same bargain `BUILD_KINDS` strikes — but how
     * *coarse* one is is a look, and a look belongs on the row. Two bars is a
     * wide continental crossing, five is a hatched box junction, and both are
     * somebody authoring a design rather than somebody editing the renderer.
     *
     * The gaps are always the same width as the bars, so this is one number and
     * not two: a zebra that is not half-and-half is a different marking.
     */
    bars: z.number().int().min(1).max(8).nullable().default(null),
    /**
     * How thickly a `tufts` cell is planted, and how tall. Null takes the
     * defaults.
     *
     * `bars`' opposite number, on the same argument: how coarse a pattern is is
     * a look and belongs on the row, while what a tuft IS stays renderer
     * geometry. Two of them at half height is a mown lawn, nine at full height
     * is a meadow, and both are somebody authoring a design.
     *
     * `density` is per cell rather than per tile-area because the cell is the
     * unit everything else about ground is counted in — how big you paint it is
     * how much of it you have, said about planting.
     *
     * It is capped low deliberately. Ground is the biggest thing in the world by
     * cell count and build mode re-flows the whole scene on every wall segment,
     * so this number multiplies the one buffer that gets rebuilt most often —
     * see `MAX_TUFTS` in `client/render/scene.js`, which is the real ceiling and
     * thins rather than refuses.
     */
    density: z.number().int().min(1).max(12).nullable().default(null),
    /** How tall a `tufts` blade stands, in tiles. Null takes the default. */
    blade: z.number().min(0.04).max(0.5).nullable().default(null),
  }).nullable().default(null),
  /**
   * Feeds the tag system, if a decoration should ever do more than look nice.
   * Nothing reads it yet — deliberately. Call `list_tags` before inventing any.
   */
  tags: z.array(slug).max(12).default([]),
  /**
   * Where this one sits in the build palette. Higher floats to the front.
   *
   * The palette had no ordering at all until this: entries came out in whatever
   * order `SELECT * FROM fixtures` handed them back, which is the order somebody
   * happened to author them in. That is fine for a tab of four and wrong the
   * moment a tab scrolls — the plainest floor, the one nine presses in ten want,
   * ends up past the fold behind six materials nobody has bought yet, and the
   * number keys are spent on whatever was seeded first.
   *
   * It is a number on the ROW rather than a list in the client for the reason
   * everything else about a piece is: a second floor design is a row somebody
   * adds over MCP, and a palette order kept in code would be a second place to
   * remember to edit — which nobody would, so the new design would land at the
   * back for ever.
   *
   * 0 is the default and means "wherever you were", because the sort is stable:
   * a catalogue where nobody has set this is exactly the catalogue it is today.
   * The eraser entries the client mints for itself (Bare Ground, Bare Wall) sit
   * at `PALETTE_LEAD`, so anything meant to lead them is authored above it.
   */
  sort: z.number().min(-99).max(99).default(0),
}).refine((v) => (v.tiers?.[0]?.cost ?? 0) === 0, {
  message: 'tier 1 is what a new one already is, so it must cost 0',
  path: ['tiers'],
}).refine((v) => (isSurface(v.kind) ? v.surface != null : v.model != null), {
  // Split rather than one required field each way round, because the two halves
  // fail for opposite reasons and a shared message would explain neither:
  // ground with a model is asking for geometry nothing draws, and a shelf with
  // no model is a shelf nobody can see. Every ground kind is on the same side
  // of this — a delivery bay is seen edge-on at 45° with a shop standing on it,
  // exactly like a floor, so what content authors for one is a colour too.
  //
  // ...and so is paint, which is the same question stood up: a wall at this
  // camera is a strip of flat colour with a repeat on it, so a finish is a
  // `surface` and `isSurface` is the one test both kinds answer.
  message: 'ground is authored as a `surface` (colour + pattern) and everything else as a `model`',
  path: ['model'],
});

/**
 * Every job a worker can be given.
 *
 * This is the whole vocabulary, and it is deliberately closed: a job is a
 * function in `server/sim/staff.js`, so a job name nobody implemented is a
 * worker who stands still. Rejecting it here is the difference between that and
 * an error you can read.
 *
 * Adding one is two edits — a name here and a function there — and every
 * existing worker can then be given some of it with no further change.
 */
export const JOBS = [
  'serve',    // man a till, take money
  'restock',  // order wholesale to refill an empty shelf
  'unload',   // carry a pallet at the bay onto shelves
  'shelve',   // put what's in hand onto a legal shelf
  // Turn a rough bed over, sow the turned one, pick the ripe one. ONE
  // directive, because it was never three decisions — see `FOLDED_JOBS` in
  // shared/jobs.js for why, and for how a list written when it was three is
  // read now.
  'farm',
  'craft',    // load a station, collect what it made
  'tidy',     // crate what can't be put away
  'merchandise', // take goods back OFF a shelf: clear a dead board, merge a split one
  // Run the back: fill the stockrooms off the dock, and the shelves off the
  // stockrooms. ONE directive because it is one loop — a hire told only to fill
  // rooms builds a pile in a room. See `ferry` in server/sim/staff.js.
  'ferry',
  // Stand where people can see you, and go after anybody who runs. Most of what
  // this is worth needs no tick at all — see `Game.guardDeterrence` — which is
  // why it is the one job whose weight matters more off the clock than on it.
  'guard',
];

/**
 * A kind of worker you can hire.
 *
 * Same shape as a fixture — staged model, tier ladder — because a worker is a
 * thing in the world that can be upgraded, and that is exactly what a fixture
 * is. What makes it a *worker* is `jobs`.
 */
export const WorkerSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  tags: z.array(slug).max(12).default([]),
  /** Staged by tier, so a promotion can change how they look. */
  model: ModelSchema,
  /**
   * What this kind does, and how much of its attention each job gets. A worker
   * draws from this list weighted, then falls through to the rest — so a weight
   * reads as priority when only one job has work, and as a share of the day
   * when several do.
   */
  jobs: z.preprocess(foldJobs, z.array(z.object({
    job: z.enum(JOBS),
    weight: z.number().min(0.1).max(100).default(1),
  })).min(1).max(JOBS.length)),
  /** Tier 1 is what you hire, so it costs nothing and is listed first. */
  tiers: z.array(z.object({
    name: z.string().min(1).max(32),
    cost: z.number().min(0).default(0),
    /** How fast they walk, x this. */
    speed_mult: z.number().min(0.1).max(10).default(1),
    /** How quickly they take the next job, x this. Higher is faster. */
    pace_mult: z.number().min(0.1).max(10).default(1),
    /** How much they carry in one trip, x this. */
    carry_mult: z.number().min(0.1).max(10).default(1),
    /**
     * How many kinds this rung will PACK into one box before setting off.
     *
     * A number rather than a flag, and it is a count of KINDS rather than of
     * units because the units cap belongs to the crate. 0 is what every hire
     * has always done — shoulder the box as they found it — so a save, an
     * export and a fresh seed all agree with no migration and no shop gets
     * faster by accident.
     *
     * What it buys is the trip a bay of part-crates could never be: four
     * lettuce, four eggs and four bread standing in three boxes is three
     * armfuls today, because no one of them is worth shouldering and
     * `fillHands` only ever tops up a kind you are already holding. A packer
     * lifts one, fills it from the others with whatever the shelves are short
     * of, and walks one full crate.
     *
     * Capped at `LOT_KINDS` because that is what a crate holds — a bigger
     * number here would be a rung that takes money and moves nothing, which is
     * the trap `unattended` and `speed_mult` are both listed under.
     */
    packs: z.number().int().min(0).max(LOT_KINDS).default(0),
    /**
     * How keen this rung is to re-merchandise the shop — move what sells to
     * where people walk. 0 is off, and is every rung ever authored.
     *
     * A number rather than a flag because there is a real dial behind it: it
     * sets how much better a spot has to be before a hire will carry stock
     * over (`ARRANGE_GAIN_MIN`..`MAX` in `server/sim/staff.js`), so a lukewarm
     * rung only acts on an obvious improvement and a keen one tidies the tail
     * of the range as well. It is the hysteresis that stops the job
     * oscillating, so it can never be turned all the way off by authoring.
     *
     * It has no weight of its own on purpose. Rearranging is the LAST thing
     * `merchandise` tries, after clearing a dead board and merging a split one,
     * so a hire only ever reaches it when the shop has nothing that actually
     * needs doing — which is what makes it occasional without a directive to
     * tune.
     */
    arranges: z.number().min(0).max(1).default(0),
    /**
     * How keen this rung is to plan its round — take the NEAREST of the targets
     * the job rates equally, rather than the first one on the list. 0 is off,
     * and is every rung ever authored.
     *
     * What it buys is the one thing no rung has ever sold: nothing a hire
     * chooses between has ever been chosen by how far away it is. `harvest` and
     * `sow` take `plots.find(...)` — the first legal bed in array order — so a
     * farmhand standing at the end of a field walks the length of it to reach
     * bed 1 because bed 1 is listed first. `serve` takes the first till with
     * anybody in the queue. A bay of identical part-crates is serviced in
     * whatever order the boxes are stored in. Every one of those is a correct
     * decision and a walk nobody chose, and in play it reads as a crew who
     * wander.
     *
     * **It never overrules the job's own preference**, which is the whole of
     * what makes it safe: it is offered the candidates a job rates *equally* —
     * every ripe bed, every till with somebody waiting, every crate that ties
     * on `unload`'s own score — so the worst it can do is take one of two
     * identical trips. A rung
     * that could trade a better trip for a shorter walk would be a balance
     * change wearing an efficiency upgrade.
     *
     * A number rather than a flag for the same reason `arranges` is one, and
     * the dial is the same shape: it sets how many tiles nearer the other
     * target has to be before a hire will divert to it (`ROUTE_SAVING_MIN`..
     * `MAX` in `server/sim/staff.js`), so a lukewarm rung only takes an obvious
     * short cut and a keen one always walks the shortest way. The saving is
     * measured against the target they WOULD have taken, never against a
     * running best, or a chain of half-tile improvements walks them across the
     * shop one candidate at a time.
     */
    routes: z.number().min(0).max(1).default(0),
    /**
     * What keeping them costs, x this. A promotion that raised what they were
     * worth but not what they cost would be the same free lunch a wage-less
     * hire was, one rung up: always right the moment you can afford it.
     */
    wage_mult: z.number().min(0).max(10).default(1),
  })).min(1).max(6).default([{ name: 'Standard', cost: 0 }]),
  /** One-off, to take them on. */
  cost: z.number().min(0).default(100),
  /** Charged every day they stay. Zero is free labour — deliberate, not lazy. */
  wage: z.number().min(0).default(0),
  speed: z.number().min(0.1).max(20).default(2.6),
  pace: z.number().min(0.05).max(10).default(0.7),
  carry: z.number().int().min(1).max(200).default(6),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7a9e4b'),
}).refine((v) => (v.tiers?.[0]?.cost ?? 0) === 0, {
  message: 'tier 1 is what you already hired, so it must cost 0',
  path: ['tiers'],
});

/**
 * A SKIN — what one hire looks like, worn over whatever kind they are.
 *
 * Deliberately **not** a variant. A fixture variant carries a whole model, and
 * that works there because a corner shelf really is a different shape. Applied
 * to staff it fails twice: a skin would belong to one worker kind, so "Rust
 * Bucket" would have to be drawn once per kind and again for every kind anyone
 * adds later — and nothing would stop a skin from redrawing a bot into
 * something that reads as a shopper, which is the exact problem staff art was
 * changed to fix.
 *
 * So a skin is a PALETTE and some trim, and it owns no silhouette at all:
 *
 *   slots   colours, keyed by the `tint` slot a part names. A part with no
 *           `tint` is untouchable — that is where the job payload lives.
 *   extras  parts ADDED to the body. A hat, an antenna, a scarf. They cannot
 *           replace or remove anything, so the base shape always survives.
 *
 * The consequences are the point. One row works on every worker kind that
 * exists and every kind that ever will, a skin can never move a number or need
 * `simulate` re-run (it has nowhere to put one), and "that one works for me" is
 * a guarantee of the format rather than a thing authors have to keep in mind.
 *
 * Slots are a closed set for the same reason `BUILD_KINDS` is: an open one
 * means a skin painting `torso` and a bot tinting `chassis` both validate, both
 * look authored, and quietly never meet.
 */
export const SkinSchema = z.object({
  id: slug,
  name: z.string().min(1).max(32),
  /**
   * Every slot is optional. A skin that only sets `glow` is a legitimate skin —
   * it changes the visor and leaves the bot otherwise as drawn, which is the
   * cheapest possible way to tell two of the same kind apart.
   */
  slots: z.object({
    chassis: hexColor.optional(),
    trim: hexColor.optional(),
    glow: hexColor.optional(),
  }).default({}),
  /**
   * Bolted on, never swapped in. Capped low because these are cosmetics on top
   * of a model that is already capped at 8 parts, and a hat is one box.
   *
   * An extra may name a `tint` slot itself, so a skin can hang a hat and have
   * it come out in its own trim colour without authoring the hex twice.
   */
  extras: z.array(PART).max(4).default([]),
  tags: z.array(slug).max(12).default([]),
});

/**
 * Where a pastime has to be done. Anything that needs a *place* names one the
 * layout already has, because a break spot nobody can path to is a worker who
 * stands still forever and looks broken.
 *
 * These are the FALLBACK now. A shop that has painted itself a break area
 * (`GROUND.break`) sends every hire there instead, whatever they are doing —
 * see `spotFor` in server/sim/staff.js for why that is a full override rather
 * than a fifth entry in this list. What a spot answers is where a break happens
 * in a shop with nowhere of its own to put one.
 */
export const PASTIME_SPOTS = [
  'here',     // wherever they finished — leaning on the nearest thing
  'outside',  // out the front, on the path
  'bay',      // round the back, out of sight of the customers
  'till',     // propped against a counter, pretending to look busy
  /**
   * ...and the one that is not a place at all: somewhere else on the shop
   * floor, a fresh tile every time, so what you watch is a circuit rather than
   * a bot stood still.
   *
   * It is a CHORE rather than a rest, and that word is doing all of the work
   * here — every other rule in this list bends for it. A chore is not sent to
   * the break area (a robot sweeping in the staff room is not sweeping), needs
   * no seat, no rung and no empty tank, and puts nothing back. See `tryChore`.
   *
   * The reason it is a spot rather than a column of its own: `spot` already
   * answers "where does this happen", and "not anywhere in particular" is an
   * answer to that question. A second flag would let somebody author a chore
   * that happens `here`, which is a bot doing the sweeping animation stood
   * perfectly still — the thing this exists to stop.
   */
  'roam',
];

/**
 * Something a worker does when they are not working.
 *
 * Authored, because "what does a tired shop assistant do on their break" is
 * flavour and flavour belongs in the database — but the *shape* is load-bearing.
 * `restores` and `minutes` together set how much of the day a break costs, and
 * those are the only two numbers the sim reads.
 *
 * Deliberately **not** a job. Every job in `JOBS` is drawn by weight, which
 * answers "how much of their day"; a break is a threshold — you go when you are
 * spent, not 15% of the time. A `rest` entry in the weighted list would send a
 * worker off for a coffee mid-queue at full energy, one trip in seven, forever.
 */
export const PastimeSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /** What the roster says they are doing. One clause — the panel is 214px. */
  doing: z.string().min(1).max(48),
  /** Where they have to be. See PASTIME_SPOTS. */
  spot: z.enum(PASTIME_SPOTS).default('here'),
  /** How long it takes, in seconds of game time. */
  seconds: z.number().min(1).max(600).default(20),
  /**
   * How much of a full tank it puts back, 0..1.
   *
   * Zero is legal and is what a `roam` chore is authored at. The floor used to
   * be 0.05 to stop somebody authoring a break that does nothing — which is
   * right about a *rest* and exactly wrong about a chore: a bot that recharged
   * by sweeping would make the break area, the room you paid for and painted,
   * the slower way to do the same thing.
   */
  restores: z.number().min(0).max(1).default(0.5),
  /**
   * They buy something off your own shelf to do it — a snack, a drink. Picked
   * by these tags, paid for at the shelf price, and it lands in the day's
   * takings like any other sale. A worker is already an entry in `players`;
   * being briefly a customer costs nothing new.
   */
  buys: z.array(z.string().min(1)).max(6).default([]),
  /** Relative likelihood of picking this one when a break is due. */
  weight: z.number().min(0).max(100).default(1),
  /** Workers carrying any of these prefer it. Empty = anyone will do it. */
  tags: z.array(slug).max(12).default([]),
  /**
   * The prop: a mug, a phone, a vape and its cloud, a sandwich. Hung on the
   * worker while they are on this break and gone the moment they go back to
   * work, so a break is legible from across the shop rather than only in their
   * menu — which was the whole complaint about step 8 as built.
   *
   * Staged, and **the 0..1 that picks the stage is how far through the break
   * they are**. A crop feeds that number from growth and a fixture from its
   * tier; a break feeds it from time, which is the first thing in the game to
   * do so and cost nothing to add. So a mug empties, a sandwich goes down to
   * the crusts and a cloud builds and thins, all authored, with no new
   * machinery and no code that knows what a mug is.
   *
   * Null is honest and supported: a pastime with no prop still slumps, so a
   * shop whose breaks nobody has drawn yet is not a shop of statues.
   */
  model: ModelSchema.nullable().default(null),
});

/**
 * What a vehicle is FOR.
 *
 * Closed, and closed for the same reason `JOBS` is: each entry is a routine
 * somebody has to write — a delivery run that ends at the bay, a shopper who
 * parks and walks in — so a `use` nobody implemented is a van that never drives
 * anywhere, which reads as a broken van rather than as content pointed at a
 * feature that does not exist.
 *
 * A tag would have been the other option and is the wrong one here. Tags are how
 * content connects to content — an event aims at `frozen`, a shopper likes
 * `organic` — and they are deliberately open, so a typo is a warning rather than
 * a refusal. What a vehicle is for is not a connection, it is which piece of
 * code owns it, and that is the same shape of question `kind` asks on a fixture.
 */
export const VEHICLE_USES = [
  'delivery', // brings wholesale orders in and unloads them at the bay
  'customer', // a shopper drove; it waits in the car park while they shop
];

/**
 * A VEHICLE — a van, a car, whatever else turns up on the ground outside.
 *
 * Authored content in the same shape as a worker, and for the same reason: it is
 * a thing you look at, and everything in this game you look at is a row somebody
 * can draw without touching `server/`. See docs/deliveries.md.
 *
 * CAPACITY IS THE ONLY FIELD THE SIM READS AS A NUMBER, so it is the only one
 * that can move the balance and the only reason authoring a second vehicle would
 * need `simulate` re-run. `speed` is how fast it appears to cross the ground on
 * a fixed route and `model` is what it looks like doing it — neither can make
 * the shop richer or poorer, exactly the way a fixture variant cannot. That
 * split is worth keeping: it means a kid can draw a lorry and the worst that
 * happens is a lorry.
 *
 * Deliberately no tier ladder. A fixture has one because a shelf you already own
 * can be improved in place; a bigger van is a different vehicle, and the doc says
 * as much ("a bigger one is an upgrade later, and it is a better upgrade than
 * most because you can see what you bought"). A ladder would also put capacity in
 * two places — the row and the rung — which is the one field that must have
 * exactly one spelling.
 */
export const VehicleSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /** Which code owns it. See VEHICLE_USES. */
  use: z.enum(VEHICLE_USES),
  tags: z.array(slug).max(12).default([]),
  /**
   * What it looks like. Staged, and **the 0..1 that picks the stage is how
   * loaded it is** — a crop feeds that number from growth, a fixture from its
   * tier, a pastime from how far through the break they are, and a van from how
   * much of its capacity is on board. So an empty bed, a couple of crates and a
   * full load is authored art with no code that knows what a crate looks like.
   *
   * Required, unlike a pastime's: a break with no prop is still a worker
   * slumping against a shelf, but a vehicle with no model is nothing at all.
   */
  model: ModelSchema,
  /**
   * Tiles per second along its route. Cosmetic today and probably forever: the
   * van drives a fixed path to the bay, and *when* an order lands is decided by
   * the run it joined rather than by how quickly the art got there. If that ever
   * stops being true this comment is the thing that has to change first.
   */
  speed: z.number().min(0.1).max(20).default(3.2),
  /**
   * How much it carries, in crates. The one number with consequences: a delivery
   * run cannot bring more than this, and a shopper who drove takes home this
   * much more than one who walked.
   *
   * Required rather than defaulted, unlike every other number on here. A default
   * capacity is a balance number nobody chose, sitting on the one field that can
   * change what the shop earns — and it would arrive silently, on a row somebody
   * wrote to try out a paint job.
   */
  capacity: z.number().int().min(1).max(40),
  /** Bodywork, where the model doesn't say otherwise. */
  color: hexColor.default('#c9d1d9'),
});

/**
 * WHEN somebody has a kit on them.
 *
 * A closed set in code, for the reason `BUILD_KINDS` and `JOBS` are closed:
 * each entry is a moment the sim actually knows it is in and can hand a
 * fullness to. A row naming a moment nothing reaches is a prop that never
 * appears, which is the "tier that changes no number" trap wearing a bag.
 *
 * So this list grows by one string when a mechanic that needs it lands, and
 * never in advance — `stealing` belongs here the day theft does, and not a
 * step before.
 *
 * Spelled `use` on the row rather than `when`, which is what it means and what
 * this constant is named for: `when` is a SQLite keyword, and `upsert` builds
 * its column list unquoted out of the object's own keys. `vehicles` already
 * calls the same idea `use`.
 */
export const KIT_USES = [
  'shopping',  // in the shop, filling a basket
  'leaving',   // paid, on the way out with what they bought
];

/**
 * Something somebody has on them: a shopping bag, a basket, a trolley.
 *
 * The third authored thing that hangs off a person, and deliberately not the
 * second one wearing a hat. A **pastime** is an activity — it has a clock, a
 * spot to be at and an amount of energy it puts back, and the prop is a detail
 * of it. A kit is only the object: no duration, nowhere to be, nothing
 * restored. Pointed at `pastimes` it would be a row whose `seconds`, `spot`,
 * `restores` and `buys` are all dead, and a dead column is a button that takes
 * money and does nothing.
 *
 * What it replaces is the loose armful. Before this, a shopper carried their
 * shopping as individual models at chest height all the way out of the shop —
 * right while they are choosing, because "they picked up a cheese" is the fact
 * worth showing, and wrong the moment they have paid: the sale is done, the
 * goods are theirs, and five jars still floating in front of them is a readout
 * nobody can act on, drawn on every shopper heading for the door at the busiest
 * moment of the day. A kit is the container that answer needed.
 *
 * Who gets one is `tags` against the archetype's, exactly how `choosePastime`
 * filters by a worker kind's — so a swag bag is a row tagged `thief` and no
 * code in the game knows what a swag bag is.
 */
export const KitSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /** The moment it is carried in. See KIT_USES. */
  use: z.enum(KIT_USES),
  /** Shoppers carrying any of these get it. Empty = anyone. */
  tags: z.array(slug).max(12).default([]),
  /** Relative likelihood against the other kits for the same moment. */
  weight: z.number().min(0).max(100).default(1),
  /**
   * What it looks like. Staged, and **the 0..1 that picks the stage is how full
   * it is** — a crop feeds that number from growth, a fixture from its tier, a
   * pastime from how far through the break they are, a van from its load, and
   * this from how much is in it. So a bag that fills as somebody shops, or a
   * sack that bulges, is authored art and no new machinery.
   *
   * Required, for the reason a vehicle's is and a pastime's is not: a break
   * with no prop is still a worker slumping against a shelf, and a kit with no
   * model is a container nobody can see holding goods nobody can see either.
   */
  model: ModelSchema,
});

export const SCHEMAS = {
  item: ItemSchema,
  crop: CropSchema,
  archetype: ArchetypeSchema,
  event: EventSchema,
  upgrade: UpgradeSchema,
  recipe: RecipeSchema,
  fixture: FixtureSchema,
  worker: WorkerSchema,
  pastime: PastimeSchema,
  skin: SkinSchema,
  vehicle: VehicleSchema,
  kit: KitSchema,
};
