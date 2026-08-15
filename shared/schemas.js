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
});

export const ModelSchema = z.object({
  parts: z.array(PART).min(1).max(8),
}).default({ parts: [{ shape: 'box', color: '#cccccc', pos: [0, 0, 0], scale: [0.3, 0.3, 0.3], rot: 0 }] });

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

export const SCHEMAS = {
  item: ItemSchema,
  crop: CropSchema,
  archetype: ArchetypeSchema,
  event: EventSchema,
  upgrade: UpgradeSchema,
  recipe: RecipeSchema,
};
