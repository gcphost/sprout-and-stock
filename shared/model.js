/**
 * STAGED MODELS — one prop, drawn differently depending on how far along it is.
 *
 * A seedling and a full tomato plant are the same crop. A battered second-hand
 * freezer and a chrome one are the same fixture. Rather than teach each system
 * its own way to swap art, a *model* itself can carry stages, and whoever draws
 * it says how far along the thing is as a single 0..1 number:
 *
 *   crop     -> growth
 *   fixture  -> which tier you've upgraded it to
 *   anything later -> whatever that thing means by progress
 *
 * So there is one authoring shape, one resolver, and a new kind of prop gets
 * stages for free the day it exists. `parts` on its own still means "looks the
 * same always", which is what almost everything wants.
 *
 * Lives in `shared/` because the schema validates writes on the server and the
 * renderer resolves them on the client, and those two must agree about what
 * stage 2 of something is.
 */

/** Nothing to draw, rather than a crash, for content that predates a field. */
const NONE = [];

/**
 * The parts to draw for a model that is `t` of the way along (0..1).
 *
 * Stages are picked by their `at` threshold — the last stage whose `at` you've
 * reached wins — so authors describe "from here on it looks like this" rather
 * than having to divide 1 by however many stages they wrote.
 */
export function partsAt(model, t = 1) {
  if (!model) return NONE;
  if (model.parts?.length) return model.parts;
  const stage = stageAt(model, t);
  return stage?.parts ?? NONE;
}

/** The whole stage record (not just its parts) at `t`, or null when unstaged. */
export function stageAt(model, t = 1) {
  const stages = model?.stages;
  if (!stages?.length) return null;
  const i = stageIndexAt(model, t);
  return stages[i] ?? null;
}

/**
 * Which stage index `t` lands in. Renderers key their rebuild cache off this:
 * a crop that grew 1% is the same mesh, and rebuilding it every tick would
 * churn geometry sixty times a second for no visible difference.
 */
export function stageIndexAt(model, t = 1) {
  const stages = model?.stages;
  if (!stages?.length) return 0;
  const clamped = Math.min(1, Math.max(0, Number(t) || 0));
  let index = 0;
  for (let i = 0; i < stages.length; i++) {
    if ((stages[i].at ?? 0) <= clamped) index = i;
  }
  return index;
}

/** Does this model change as it goes along, or is it just the one look? */
export function isStaged(model) {
  return !!model?.stages?.length;
}

/**
 * How tall these parts reach.
 *
 * Aiming needs this: the pointer picks a fixture by intersecting the plane its
 * top face sits on, so the moment a fixture's height comes from authored art
 * rather than a constant, the picker has to read the art. A model that grew a
 * chimney and a picker still using the old number is a shop where clicking a
 * shelf gets you its neighbour.
 */
export function modelHeight(parts) {
  let top = 0;
  for (const p of parts ?? []) {
    top = Math.max(top, (p.pos?.[1] ?? 0) + (p.scale?.[1] ?? 0) / 2);
  }
  return top;
}

/**
 * The shelves *within* a model: every part flagged `surface`, as the plane its
 * top face sits on, lowest first.
 *
 * Same argument as `modelHeight`. Once a fixture's look is authored content, a
 * three-row shelving unit is three places goods can sit, and only the art knows
 * where they are — so it says. A model with no surfaces answers nothing, and
 * whoever asked falls back to standing things on the roof.
 */
export function surfacesAt(model, t = 1) {
  return (partsAt(model, t))
    .filter((p) => p.surface)
    .map((p) => ({
      x: p.pos?.[0] ?? 0,
      y: (p.pos?.[1] ?? 0) + (p.scale?.[1] ?? 0) / 2,
      z: p.pos?.[2] ?? 0,
      span: p.scale?.[0] ?? 1,
      depth: p.scale?.[2] ?? 1,
    }))
    .sort((a, b) => a.y - b.y);
}

/**
 * Every shape a kind of fixture comes in, the kind's own model first.
 *
 * The default is a real entry with an empty id rather than a special case, so
 * a menu can just list this and a placement can just store `variant`. Content
 * that predates variants answers with a list of one, which is the truth.
 */
export function variantsOf(kind) {
  return [
    { id: '', name: 'Standard', model: kind?.model ?? null },
    ...(kind?.variants ?? []).map((v) => ({ id: v.id, name: v.name, model: v.model })),
  ];
}

/** The model for one shape of a kind. Falls back to the kind's own. */
export function variantModel(kind, variant) {
  if (!variant) return kind?.model ?? null;
  return (kind?.variants ?? []).find((v) => v.id === variant)?.model ?? kind?.model ?? null;
}

/**
 * Where tier N of M sits on the 0..1 line, so a discrete ladder can drive the
 * same resolver a continuous quantity does. Tier 1 of 3 is 0, tier 3 is 1.
 */
export function tierProgress(tier, tiers) {
  const n = Math.max(1, Number(tiers) || 1);
  if (n === 1) return 0;
  return Math.min(1, Math.max(0, (Number(tier) || 1) - 1) / (n - 1));
}
