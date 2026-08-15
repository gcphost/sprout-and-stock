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
 * lights, the nearest emitters get to use them, and everything further away
 * folds into a single ambient lift.
 *
 * Deciding the cap before there is a catalogue of lamps to trip over is the
 * point. Finding it afterwards means finding it as "the game got slow", which
 * reads as the renderer being bad rather than as one purchase being a mistake.
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
 * Small on purpose. The failure this avoids is the one where panning the camera
 * visibly *dims* the far end of the shop as its lamps fall out of the pool —
 * the spill keeps the total roughly steady so what you see is the near lamps
 * getting sharper, not the distant ones being switched off.
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

export class Lights {
  constructor(scene) {
    this.scene = scene;
    this.emitters = [];
    this.daylight = 1;
    this.spill = 0;
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
  }

  /** 0 at night, 1 at midday. Drives how much the lamps are worth. */
  setDaylight(d) {
    if (Math.abs(d - this.daylight) < 0.01) return;
    this.daylight = d;
    this._at.set(Infinity, 0, Infinity);
  }

  /**
   * Aim the pool at whatever is nearest.
   *
   * Cheap to call every frame and mostly does nothing: re-sorting only happens
   * once the camera has actually gone somewhere. Sorting the full list every
   * frame would be fine at ten lamps and silly at two hundred, and two hundred
   * is exactly what an authorable catalogue eventually produces.
   */
  update(camLook) {
    if (camLook.distanceToSquared(this._at) < RESORT_DISTANCE * RESORT_DISTANCE) return;
    this._at.copy(camLook);

    const lit = DAY_FLOOR + (1 - DAY_FLOOR) * (1 - this.daylight);
    const near = [...this.emitters].sort((a, b) => (
      (a.x - camLook.x) ** 2 + (a.z - camLook.z) ** 2
      - ((b.x - camLook.x) ** 2 + (b.z - camLook.z) ** 2)
    ));

    this.pool.forEach((light, i) => {
      const e = near[i];
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

    const dropped = Math.max(0, near.length - MAX_LIGHTS);
    this.spill = dropped * SPILL_PER_LIGHT * lit;
  }
}

/**
 * Every lamp standing in a layout, as flat records.
 *
 * A prop is a light because its *piece* says so, which is why this needs the
 * catalog and not just the layout. Nothing here knows what a lamp is called.
 */
export function emittersIn(fixtures, pieceOf, ceilingY) {
  const out = [];
  for (const f of fixtures) {
    const emits = pieceOf(f)?.emits;
    if (!emits) continue;
    out.push({
      x: f.x,
      // Hung things light from the ceiling; everything else from about the
      // height of a shade on a stand. Read off the kind rather than authored,
      // the same argument `seamStep` makes: the art already knows.
      y: f.kind === 'prop-ceiling' ? ceilingY - 0.1 : 0.85,
      z: f.z,
      color: emits.color ?? '#ffd9a0',
      intensity: emits.intensity ?? 1,
      range: emits.range ?? 4,
    });
  }
  return out;
}
