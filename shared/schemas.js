/**
 * VALIDATION — the safety rail for live editing.
 *
 * Every write into the content DB goes through one of these, whether it came
 * from a human, an MCP tool call, or the AI world director. If it doesn't
 * validate, it's rejected with a readable error and the running game is
 * completely unaffected.
 *
 * This is why the kid's agent can't break the server: the worst it can do is
 * get told "no".
 */

import { z } from 'zod';
import { ALL_TAGS } from './tags.js';

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
});

/**
 * One look, for something that changes as it goes along. `at` is where on the
 * 0..1 run this stage takes over — see `shared/model.js` for who feeds what
 * into that number.
 */
const STAGE = z.object({
  name: z.string().max(32).default(''),
  at: z.number().min(0).max(1).default(0),
  parts: z.array(PART).min(1).max(8),
});

export const ModelSchema = z.object({
  /** The whole thing, always. What almost everything wants. */
  parts: z.array(PART).min(1).max(8).optional(),
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
  /** 0 = doesn't look at price tags. 1 = extremely price-driven. */
  price_sensitivity: z.number().min(0).max(1).default(0.5),
  /** Seconds they'll wait in a queue before abandoning their basket. */
  patience: z.number().min(5).max(600).default(60),
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
 * A world event — the AI director's main lever.
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
  kind: z.enum(['shelf', 'freezer', 'plot', 'checkout', 'capacity', 'speed', 'decor', 'staff', 'station', 'space']),
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
 * What a kind of fixture looks like, and how far you can upgrade one.
 *
 * The *rules* for a fixture stay in code — where it may go, which side you use
 * it from, whether it rotates (`shared/build.js`). What it looks like and what
 * a better one is worth are content, so a shelf can be redesigned or given a
 * third tier without a deploy.
 *
 * `id` must be a kind the build rules already know. This is deliberately not a
 * way to invent new fixture kinds: a kind nobody can place, reach or stand at
 * is scenery, and that part is behaviour.
 */
export const FixtureSchema = z.object({
  id: slug,
  name: z.string().min(1).max(48),
  /**
   * Staged by tier: stage 1 is what you buy, the last stage is fully upgraded.
   * An unstaged model just means every tier looks the same.
   */
  model: ModelSchema,
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
   */
  variants: z.array(z.object({
    id: slug,
    name: z.string().min(1).max(32),
    model: ModelSchema,
  })).max(8).default([]),
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
    /** How fast it works, x this. Appliances, and crops in a plot. */
    speed_mult: z.number().min(0.1).max(10).default(1),
  })).min(1).max(6).default([{ name: 'Standard', cost: 0 }]),
}).refine((v) => (v.tiers?.[0]?.cost ?? 0) === 0, {
  message: 'tier 1 is what a new one already is, so it must cost 0',
  path: ['tiers'],
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
  'till',     // turn rough soil over
  'sow',      // plant the chosen crop in a bare bed
  'harvest',  // pick a ripe plot
  'craft',    // load a station, collect what it made
  'tidy',     // crate what can't be put away
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
  jobs: z.array(z.object({
    job: z.enum(JOBS),
    weight: z.number().min(0.1).max(100).default(1),
  })).min(1).max(JOBS.length),
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
 * Where a pastime has to be done. Anything that needs a *place* names one the
 * layout already has, because a break spot nobody can path to is a worker who
 * stands still forever and looks broken.
 */
export const PASTIME_SPOTS = [
  'here',     // wherever they finished — leaning on the nearest thing
  'outside',  // out the front, on the path
  'bay',      // round the back, out of sight of the customers
  'till',     // propped against a counter, pretending to look busy
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
  /** How much of a full tank it puts back, 0..1. */
  restores: z.number().min(0.05).max(1).default(0.5),
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
};
