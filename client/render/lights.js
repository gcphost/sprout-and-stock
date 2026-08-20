/**
 * LAMPS.
 *
 * A piece can carry an `emits` block — a colour, a brightness, a range — and
 * this is the whole of what honours it. Content says a thing glows; code
 * decides how many glowing things a browser will actually put up with.
 *
 * That cap is the entire reason this file exists rather than a few lines in
 * `buildWorld`. three.js forward-renders every light against every fragment of
 * every material, so lights are not "a bit more expensive each" — they are a
 * multiplier on the whole scene, and a shop with fifty sconces in it does not
 * look fifty times better, it just stops. So there is a fixed pool of real
 * lights, some of the emitters get to use them, and the rest fold into a single
 * ambient lift.
 *
 * Deciding the cap before there is a catalogue of lamps to trip over is the
 * point. Finding it afterwards means finding it as "the game got slow", which
 * reads as the renderer being bad rather than as one purchase being a mistake.
 *
 * THE ROOM IS BAKED; THE POOL IS A SHARPENER. That split is the whole of this
 * file now, and it is what makes the cap survivable.
 *
 * `bakeInto` folds EVERY lamp in the shop into the ground's own per-cell colour
 * once, on the CPU — so the lit shape of the building is fixed, costs nothing
 * per frame, and does not care how many fittings you own. Stacking lamps works.
 * The floor was the whole complaint about the pool following the camera: a shop
 * that re-lights itself as you walk through it has nothing in the world to
 * explain why, so it reads as broken.
 *
 * What the baked floor cannot light is anything that MOVES — people, crates,
 * fixtures — because their colours are not in it. So the eight real lights are
 * still aimed at the nearest emitters and still re-aimed as the view moves,
 * which is the right rule for them: nearest is where the movers are, and a
 * shelf sharpening as you walk up to it reads as light rather than as a fault,
 * because the room around it stays put.
 */

import * as THREE from 'three';

/**
 * How many emitters get a real light.
 *
 * Eight because that is comfortably inside what a forward renderer handles
 * without the shader recompiling into something a laptop notices, and because a
 * shop you can see at once is about that many fittings anyway. Raising it is one
 * number — but measure before you do, and measure on the worst machine anyone
 * plays this on rather than on the one it was written on.
 */
const MAX_LIGHTS = 8;

/**
 * What a dropped emitter is worth as flat ambient instead.
 *
 * Small on purpose, and it no longer has anything to hide: a lamp outside the
 * pool is outside it for as long as the shop stands, so this is the difference
 * between a fitting that lights its own corner and one that lifts the room a
 * little. It used to be the thing that stopped panning from visibly switching
 * the far end of the shop off, which is a job it no longer has, because nothing
 * about the pool moves any more.
 */
const SPILL_PER_LIGHT = 0.05;

/** Beyond this much camera movement, work out which lamps are nearest again. */
const RESORT_DISTANCE = 1.5;

/**
 * How much of a lamp's brightness survives full daylight.
 *
 * Not zero: a lamp that vanishes at noon reads as broken, and an aisle away
 * from the windows is dim at every hour. Not one either, or buying lights would
 * be a purchase that never has a moment of being the thing that saved you.
 *
 * This is the cheap half of "indoors is not outdoors". The honest version gives
 * the inside of the building its own ambient term and lets window edges let the
 * sun in — see docs/building.md. Until then the lamp dims and the room doesn't,
 * which is visible, defensible, and about a hundred lines less code.
 */
const DAY_FLOOR = 0.25;

/**
 * The layer the real lamps cannot reach.
 *
 * Ground is *baked* — every lamp in the shop, however many, folded into the
 * per-cell colour the tile mesh was going to carry anyway (`bakeInto`). The pool
 * of eight would otherwise light that same floor a second time, so the eight
 * lucky fittings would pool visibly harder than the rest and the cap would be
 * back on screen wearing a different hat.
 *
 * three.js tests `light.layers` against `object.layers`, so moving the tiles off
 * layer 0 takes them out of every point light's reach in one line. The sky has
 * to be let back in by hand — see `setupLights` — because sun, fill and bounce
 * are ordinary lights and would drop the floor too.
 */
export const BAKED_LAYER = 2;

/**
 * How bright a baked lamp pool is at its centre, before falloff.
 *
 * The baked half and the real half are two different approximations of one
 * thing and will never agree exactly — this is the knob that gets them close
 * enough that a lit fixture standing on lit ground looks like one lamp.
 */
const BAKE_GAIN = 0.9;

/** Ceiling. Vertex colour multiplies, so nothing stops it going to white. */
const BAKE_MAX = 0.75;

export class Lights {
  constructor(scene) {
    this.scene = scene;
    this.emitters = [];
    this.chosen = [];
    this.daylight = 1;
    this.spill = 0;
    this.lit = DAY_FLOOR;
    this._at = new THREE.Vector3(Infinity, 0, Infinity);

    // Built once and re-aimed, never created per frame. A THREE.PointLight added
    // to a scene forces a shader recompile on the materials it touches; doing
    // that as the camera pans is a stutter you can feel.
    this.pool = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1);
      light.visible = false;
      // No shadow maps. Eight shadow-casting point lights is six render passes
      // per light per frame, which is exactly the crawl this file exists to stop.
      light.castShadow = false;
      scene.add(light);
      this.pool.push(light);
    }
  }

  /**
   * The lamps in the world, as plain numbers.
   *
   * Taken as data rather than as scene objects so the caller can rebuild the
   * shop without this having to know that happened — a lamp is a position and
   * three values, and the pool it feeds outlives every layout.
   */
  setEmitters(list) {
    this.emitters = list ?? [];
    this._at.set(Infinity, 0, Infinity);   // force a re-sort on the next frame
    this.apply();
  }

  /** 0 at night, 1 at midday. Drives how much the lamps are worth. */
  setDaylight(d) {
    if (Math.abs(d - this.daylight) < 0.01) return;
    this.daylight = d;
    this.apply();
  }

  /**
   * Aim the pool at whatever is nearest.
   *
   * Cheap to call every frame and mostly does nothing: re-sorting only happens
   * once the camera has actually gone somewhere. Sorting the full list every
   * frame would be fine at ten lamps and silly at two hundred, and two hundred
   * is exactly what an authorable catalogue eventually produces.
   *
   * Nearest is the right rule again *because the floor no longer moves with it*
   * — see the note at the top. What this pool is for now is the things the bake
   * cannot reach, and those are the things walking about in front of you.
   */
  update(camLook) {
    if (camLook.distanceToSquared(this._at) < RESORT_DISTANCE * RESORT_DISTANCE) return;
    this._at.copy(camLook);
    this.chosen = [...this.emitters].sort((a, b) => (
      (a.x - camLook.x) ** 2 + (a.z - camLook.z) ** 2
      - ((b.x - camLook.x) ** 2 + (b.z - camLook.z) ** 2)
    )).slice(0, MAX_LIGHTS);
    this.apply();
  }

  /** Point the pool at the chosen lamps and work out the ambient lift. */
  apply() {
    // What a lamp is worth at this hour. Kept, because the bake has to use the
    // same number — two curves for one sunset is a floor that brightens while
    // the fitting over it dims.
    const lit = DAY_FLOOR + (1 - DAY_FLOOR) * (1 - this.daylight);
    this.lit = lit;

    this.pool.forEach((light, i) => {
      const e = this.chosen[i];
      if (!e) { light.visible = false; light.intensity = 0; return; }
      light.visible = true;
      light.color.set(e.color);
      light.position.set(e.x, e.y, e.z);
      light.distance = e.range;
      // Three's physically-correct falloff makes intensity a power, so a lamp
      // authored as "1" over a 4-tile range is nearly invisible without scaling
      // by how far it has to throw. Squared, because that is how the falloff
      // takes it back out again.
      light.intensity = e.intensity * lit * e.range * e.range * 0.12;
    });

    const dropped = Math.max(0, this.emitters.length - this.chosen.length);
    this.spill = dropped * SPILL_PER_LIGHT * lit;
  }

  /**
   * Brighten one colour by every lamp in the shop, wherever it is standing.
   *
   * This is the bake, and it is the answer to the cap rather than a way round
   * it: a lamp costs the GPU nothing here, because the sum happens once on the
   * CPU and lands in a colour the mesh was going to carry anyway. Fifty
   * fittings and eight cost the same to draw.
   *
   * Additive on top of the tile's own colour, and clamped: this multiplies at
   * draw time, so an unclamped stack of overlapping pools is a white square.
   *
   * Falloff is linear-squared rather than three's inverse square, and that is
   * deliberate. What matters is that a pool ENDS — an inverse square never
   * quite does, so a shop with twenty lamps in it bakes a uniform lift over
   * every tile in the building and reads as somebody having turned the ambient
   * up rather than as lamps.
   */
  bakeInto(color, x, y, z) {
    if (!this.emitters.length) return color;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const e of this.emitters) {
      const d2 = (e.x - x) ** 2 + (e.y - y) ** 2 + (e.z - z) ** 2;
      if (d2 >= e.range * e.range) continue;
      const fall = (1 - Math.sqrt(d2) / e.range) ** 2;
      const amount = fall * e.intensity * this.lit * BAKE_GAIN;
      const c = tint(e.color);
      r += amount * c.r;
      g += amount * c.g;
      b += amount * c.b;
    }
    color.r *= 1 + Math.min(r, BAKE_MAX);
    color.g *= 1 + Math.min(g, BAKE_MAX);
    color.b *= 1 + Math.min(b, BAKE_MAX);
    return color;
  }
}

/**
 * A lamp's colour, cached.
 *
 * `new THREE.Color(hex)` parses a string, and the bake asks per cell per lamp —
 * a shop of thirty lamps on a 40×40 floor is 48,000 of them per rebake.
 */
const tints = new Map();
function tint(hex) {
  let c = tints.get(hex);
  if (!c) { c = new THREE.Color(hex); tints.set(hex, c); }
  return c;
}

/**
 * Every lamp standing in a layout, as flat records.
 *
 * A prop is a light because its *piece* says so, which is why this needs the
 * catalog and not just the layout. Nothing here knows what a lamp is called.
 *
 * ...and a fridge is a light because the RUNG it is on says so. The tier wins
 * where it has an opinion, so lighting can be something you buy for a unit you
 * already own — a display case with a strip in it — while a lamp says it once on
 * the piece and glows at every rung. Which is also why this reads `f.tier`: the
 * same fixture is two different lights before and after an upgrade.
 *
 * ...and a piece that WATCHES the shop is worth what the shop says it is worth.
 * `signals` is the last-known value of each, and a watcher's light is scaled by
 * its own — so an OPEN sign whose art went dark at closing time takes its glow
 * with it. Without this the geometry would say shut and the pool of light on the
 * floor under it would go on saying open, which is worse than never having
 * dimmed it: a sign that is off and still lit reads as a rendering fault.
 *
 * A watcher at zero is DROPPED rather than dimmed to nothing, because the pool
 * is eight lights aimed at the nearest emitters — a dark sign that stayed on the
 * list would go on holding one of the eight against the shop it is standing in.
 */
export function emittersIn(fixtures, pieceOf, ceilingY, signals = null) {
  const out = [];
  for (const f of fixtures) {
    const piece = pieceOf(f);
    const emits = piece?.tiers?.[(f.tier ?? 1) - 1]?.emits ?? piece?.emits;
    if (!emits) continue;
    // 1 for everything that watches nothing, and for a watcher whose signal has
    // not arrived — an unlit first frame is a shop that flashes on, and there is
    // no reading of "we do not know yet" that should turn a lamp off.
    const worth = piece?.signal ? (signals?.[piece.signal] ?? 1) : 1;
    if (worth <= 0.001) continue;
    out.push({
      x: f.x,
      // Hung things light from the ceiling; everything else from about the
      // height of a shade on a stand. Read off the kind rather than authored,
      // the same argument `seamStep` makes: the art already knows.
      y: f.kind === 'prop-ceiling' ? ceilingY - 0.1 : 0.85,
      z: f.z,
      color: emits.color ?? '#ffd9a0',
      intensity: (emits.intensity ?? 1) * worth,
      range: emits.range ?? 4,
    });
  }
  return out;
}
