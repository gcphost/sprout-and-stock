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
 * The box the art actually occupies, in model space — how far it reaches on
 * each side, and how high.
 *
 * `modelHeight` answers the same question about one axis, and for one caller
 * (aiming). This is the other three, and it exists for the same reason
 * `surfacesAt` does: standing something ON a fixture means knowing where its
 * front edge and its back edge are, and a machine is whatever shape somebody
 * drew. An appliance's intake bays measured off a constant would sit inside a
 * squat toaster and float beside a tall espresso machine.
 *
 * A model with no parts answers a point at the origin, which puts everything in
 * the middle of the tile — the same degrade "no surfaces, so stack it on the
 * roof" takes.
 */
export function modelBounds(parts) {
  const b = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 };
  for (const p of parts ?? []) {
    const [px, py, pz] = p.pos ?? [0, 0, 0];
    const [sx, sy, sz] = p.scale ?? [0, 0, 0];
    b.minX = Math.min(b.minX, px - sx / 2);
    b.maxX = Math.max(b.maxX, px + sx / 2);
    b.minZ = Math.min(b.minZ, pz - sz / 2);
    b.maxZ = Math.max(b.maxZ, pz + sz / 2);
    b.top = Math.max(b.top, py + sy / 2);
  }
  return b;
}

/**
 * ...and the same box over every stage a model has, rather than one of them.
 *
 * `modelBounds` answers about a set of parts, which is what a caller standing
 * something ON a fixture wants: it is asking about the shape in front of it
 * right now. This is the other question — **how much room does this thing need**
 * — and the answer has to hold for every look it will ever wear, because a van
 * that fits its lane empty and clips the shop full is a bug that only appears
 * on the days you are busy.
 *
 * An unstaged model is one stage of one, so both cases fall out of the same
 * loop and no caller has to ask `isStaged` first.
 */
export function modelExtent(model) {
  const stages = model?.stages?.length ? model.stages : [model];
  const out = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 };
  for (const s of stages) {
    const b = modelBounds(s?.parts);
    out.minX = Math.min(out.minX, b.minX);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.minZ = Math.min(out.minZ, b.minZ);
    out.maxZ = Math.max(out.maxZ, b.maxZ);
    out.top = Math.max(out.top, b.top);
  }
  return out;
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
 * How far the front row of goods stands proud of the middle of its board, as a
 * share of the board's depth.
 *
 * Here rather than in the renderer that draws them, because `drawableBoards`
 * below has to look up from exactly where `buildShelfGoods` puts things. Two
 * spellings of where the goods are is how a board gets called visible and then
 * filled somewhere you cannot see.
 */
export const FRONT_LIP = 0.14;

/**
 * How far the camera climbs for every step it travels back into a unit.
 * Mirrors `BASE_CAM_OFFSET` in client/render/scene.js — 24 up over a 20×20
 * diagonal, about 40°. Rounded up, so a board called visible really is one.
 */
const CAM_RISE = 0.85;

/** How much of a good must clear what is over it before a board is worth using. */
const MIN_SHOW = 0.04;

/** How many points along a board's run are sampled — see `shownOn`. */
const SAMPLES = 5;

/**
 * How much of a good standing at the front of `s` clears everything above it,
 * along the sightline the fixed camera actually has. Infinity means open sky.
 *
 *     shown = headroom − setback × CAM_RISE
 *
 * Measured at SEVERAL points along the board and answered with the BEST of
 * them, because goods spread along the whole run and a board only has to be
 * open somewhere to be worth stocking. It sampled the middle alone, which is
 * right for a straight unit — every point on it answers the same — and wrong
 * for the first shape where it isn't. A corner's two wings cross at the middle
 * of each other, so wing A's centre sits under wing B's lid however high either
 * of them is: both wings read as covered, the unit stocked nothing, and the
 * goods fell back onto the roof. The far end of each wing, which is most of it,
 * is out in the open.
 *
 * Glass does not count, because you can see through it — a chiller's own pane
 * hangs over its boards and has never hidden anything. Nor does `drift`, which
 * is vapour.
 */
export function shownOn(parts, s) {
  // Where the front row will stand, taken from the same constant the renderer
  // places it with. On a corner unit's second wing the goods run the other way,
  // and looking up from the wrong point answers about the wall.
  const alongZ = s.depth >= s.span;
  const lip = (alongZ ? s.span : s.depth) * FRONT_LIP;
  const face = alongZ ? 0 : 2;
  // Along the board's own length, end to end. The ends are included rather than
  // inset: a wing that is clear at its far end is a wing you can stock.
  const run = alongZ ? s.depth : s.span;
  const mid = alongZ ? s.z : s.x;

  let best = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const along = mid + (i / (SAMPLES - 1) - 0.5) * run;
    const gx = alongZ ? s.x + lip : along;
    const gz = alongZ ? along : s.z + lip;
    const at = alongZ ? gx : gz;

    let shown = Infinity;
    for (const p of parts ?? []) {
      if ((p.alpha ?? 1) < 1 || p.drift) continue;
      const under = (p.pos?.[1] ?? 0) - (p.scale?.[1] ?? 0) / 2;
      // Anything not wholly above this board is the board itself, or below it.
      if (under <= s.y + 1e-6) continue;
      const over = (j, v) => Math.abs(v - (p.pos?.[j] ?? 0)) <= (p.scale?.[j] ?? 0) / 2 + 1e-6;
      if (!over(0, gx) || !over(2, gz)) continue;
      // Every cover, not just the lowest: a tier-3 shelf hangs a sign strip below
      // its cap, and which of the two crops the view is not the same question as
      // which of them is lower.
      const setback = Math.max(0, (p.pos?.[face] ?? 0) + (p.scale?.[face] ?? 0) / 2 - at);
      shown = Math.min(shown, (under - s.y) - setback * CAM_RISE);
    }
    best = Math.max(best, shown);
  }
  return best;
}

/**
 * The boards of a unit you can actually see into, out of the ones its art
 * flagged as `surface`.
 *
 * **A board under a lid is not a board.** Goods fill from the TOP down, which
 * is right on an open unit and exactly wrong on one that grew a canopy: the
 * first thing you stock lands in the one place the camera can never see. A
 * tier-2 shelf did that — its top board sat 0.17 under a solid cap, the front
 * row stands 0.20 back from the cap's lip, and at this camera pitch that leaves
 * nothing showing. A shelf holding four loaves drew four loaves and looked
 * empty, which reads as stock that never arrived.
 *
 * Measured rather than authored, the same argument `surfacesAt` and `seamStep`
 * make: the art already says where the boards are and what hangs over them, and
 * a second field saying "…and this one is covered" is a thing that can quietly
 * disagree with the box you drew.
 *
 * In `shared/` for the reason everything else here is: the renderer resolves
 * this to decide where stock goes, and `scripts/document-fixtures.js` resolves
 * it to warn whoever is authoring a piece. Those two disagreeing is a lid the
 * docs call fine and the game draws nothing under.
 *
 * A unit with nothing left heaps its goods on the roof, which is the fallback a
 * unit with no boards at all already takes.
 */
export function drawableBoards(parts, surfaces) {
  return (surfaces ?? []).filter((s) => shownOn(parts, s) >= MIN_SHOW);
}

/**
 * Which boards a unit's Nth kind gets, top-first.
 *
 * A kind gets its SHARE of the boards rather than one board — a shelf spoken
 * for by one thing uses all of them, two things halve it — and the shares run
 * from the top down, because the top board is the one a 45° camera actually
 * shows and therefore the one the goods are drawn on first.
 *
 * It lives here rather than in the renderer that invented it because two things
 * now ask the question and they must not answer it differently: `scene.js`
 * asks in order to DRAW a pile, and the sim asks in order to price the board it
 * is standing on (`boardPull`). Two spellings of "which board is the bread on"
 * would be a shop where the sweets sell like an endcap and are drawn on the
 * bottom shelf — a disagreement with no error in it, visible only as a number
 * that will not reconcile with the picture.
 *
 * `rows` is bottom-first, the order `surfacesAt` returns and `drawableBoards`
 * preserves. `gi` is the kind's index among everything the unit is spoken for
 * by — reservations included, which is why a board held open by a tick nobody
 * has filled yet still counts against the share.
 */
export function boardsForShare(rows, shares, gi) {
  const n = rows?.length ?? 0;
  if (!n) return [];
  const ways = Math.max(1, shares);
  const topFirst = [...rows].reverse();
  const each = Math.floor(n / ways);
  // More kinds than boards. The sim will not open a stack past `shelfBoards`,
  // but a reservation can outnumber them, so this wraps rather than handing
  // back nothing — a kind with no board at all would be goods drawn nowhere.
  if (each === 0) return [topFirst[Math.max(0, gi) % n]];
  const spare = n % ways;
  const start = gi * each + Math.min(gi, spare);
  return topFirst.slice(start, start + each + (gi < spare ? 1 : 0));
}

/**
 * Which side of its own tile a `seam` part closes, as a step in model space —
 * or null if it isn't a seam, or doesn't sit against a side.
 *
 * Read from the art rather than authored, the same argument `surfacesAt` makes:
 * the end panel of a wall unit is already stood out at the edge it closes, so
 * the axis it is furthest out along IS the side. A second field saying "…and
 * it's the +z one" is a thing that can quietly disagree with the box you drew.
 */
export function seamStep(part) {
  if (!part?.seam) return null;
  const x = part.pos?.[0] ?? 0;
  const z = part.pos?.[2] ?? 0;
  if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) return null;
  return Math.abs(z) >= Math.abs(x)
    ? { dx: 0, dz: Math.sign(z) }
    : { dx: Math.sign(x), dz: 0 };
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
 * The model for what one shape of a kind looks like WHILE IT IS WORKING, or
 * null if nobody has drawn one.
 *
 * Falls back to the kind's own the way `variantModel` does, and that fallback
 * is doing more work here than it is there. Every appliance in the game is a
 * variant of one `station` piece, so one generic "steam and a light" authored
 * on the piece makes all seven machines show they are running — and a variant
 * that wants its own says so and takes over completely. A piece with no `work`
 * anywhere answers null, which is every fixture that existed before this and
 * is why none of them changed.
 */
export function variantWork(kind, variant) {
  if (!variant) return kind?.work ?? null;
  return (kind?.variants ?? []).find((v) => v.id === variant)?.work ?? kind?.work ?? null;
}

/**
 * The parts to draw for a body wearing a skin: every part it was authored with,
 * repainted where it named a slot, plus whatever the skin bolts on.
 *
 * The asymmetry with `variantModel` above is the whole design and is worth
 * stating. A variant ANSWERS WITH A MODEL — it replaces the art, which is right
 * for a corner shelf and wrong for a hire, because a skin that can replace the
 * art can redraw a bot into something that reads as a customer. This one takes
 * the art as given and can only ever repaint it and add to it. There is no
 * argument you can pass that removes a part, so no skin anybody authors can
 * cost the shop the one thing staff art is for: telling at a glance who works
 * for you.
 *
 * Parts naming no slot come through untouched, which is where the job payload
 * lives — the till a clerk carries stays the clerk's colour under every skin in
 * the game. A slot the skin didn't set is the same as no slot: the authored
 * colour stands, so a half-written skin degrades to a partly-repainted bot
 * rather than to a black one.
 */
export function skinnedParts(parts, skin) {
  if (!skin) return parts ?? NONE;
  const slots = skin.slots ?? {};
  const paint = (p) => {
    const c = p.tint ? slots[p.tint] : null;
    return c ? { ...p, color: c } : p;
  };
  return [...(parts ?? NONE).map(paint), ...(skin.extras ?? NONE).map(paint)];
}

/**
 * What a renderer caches a skinned body against. Just the id: a skin edited in
 * place is a content change, and content changes already drop every cached key
 * (`setCatalog`), which is what lets an MCP redraw reach the bots on shift
 * rather than only the next one you hire.
 */
export function skinKey(skin) {
  return skin?.id ?? '';
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
