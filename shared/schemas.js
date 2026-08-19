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
    kind: z.enum(['spin', 'bob', 'shake', 'pulse']),
    /** Cycles a second — turns a second for `spin`. */
    hz: z.number().min(0.05).max(12).default(1.5),
    /** How big the movement is: tiles for `bob`/`shake`, a share of its own size for `pulse`. */
    amount: z.number().min(0).max(1).default(0.05),
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
 */
const MAX_PARTS = 16;

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
   */
  variants: z.array(z.object({
    id: slug,
    name: z.string().min(1).max(32),
    model: ModelSchema,
    work: ModelSchema.nullable().default(null),
  })).max(16).default([]),
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
    pattern: z.enum(['plain', 'checker', 'planks', 'stripes', 'tufts']).default('plain'),
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
