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
import { GLAZING, WAYS } from '../../shared/edges.js';

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
 * This is one half of "indoors is not outdoors" — the lamp half. The other half
 * is THE ROOF below, and the third is `windowsIn`, which is where the day gets
 * in now.
 *
 * It survives the roof, and the reason is worth writing down: with the room
 * pinned, a lamp no longer *rescues* the building — it sharpens its own corner
 * at every hour, which is what a lamp does. What the ramp still buys is that a
 * shop full of fittings is visibly a shop full of fittings after dark and
 * merely well lit at noon, and that is a purchase having a moment.
 */
const DAY_FLOOR = 0.25;

/**
 * THE ROOF, and why it is a shadow on the FIELD rather than a lamp in the SHOP.
 *
 * What a room wants is to hold one level all day: the sun never reaches the
 * inside of a building, so a shop at dusk and a shop at noon are the same room
 * with the same lights on, and the day is a thing you can see happening through
 * the door. That was `INDOOR_LIFT` — a scalar, ramped by `1 - daylight`, folded
 * into the bake — and it was wrong twice.
 *
 * It was wrong about **hue**, which is the complaint that started this: the sun
 * and the fill both go warm at dusk (`SUN_DUSK`, `FILL_DUSK`), so a scalar
 * handed the room back some of its brightness and left it orange. What a player
 * reads there is not evening, it is the shop's own colours moving under them, at
 * exactly the hour the shop is busiest.
 *
 * And it was wrong about **which end to push**. Lifting a dark room means a bake
 * multiplier well above 1 — and a vertex colour cannot hold one. `paintLit`
 * clamps at 1 under the look, because the toon ramp is already at its top step
 * and anything past it clips to white rather than brightening. A pin built that
 * way does not light the shop, it *erases* it, and the tell would have been a
 * milky white aisle that reads as fog.
 *
 * So the sky is held at MIDDAY all day — sun, fill and bounce, colour and level
 * — and the whole of the day cycle moves into the bake as a darkening of
 * everything OUTDOORS: `outdoor` is `sky(now) / sky(noon)`, per channel, which
 * is at most 1 and therefore cannot clip. Three things fall out of that, and
 * they are the reason this shape is worth the rewrite:
 *
 * - **Outdoors is untouched, to the byte.** A surface used to be `albedo × sky`;
 *   it is now `albedo × (sky / skyNoon) × skyNoon`. Every hour, every cell. The
 *   sunset's colour rides in the ratio, so the field still goes orange and the
 *   grass still goes dark, and no number in the day cycle has moved.
 * - **The movers come free.** People, crates and the goods on every shelf are
 *   lit by the sky rather than by the bake, and the sky is now the same at every
 *   hour — so a loaf on a shelf at eight in the evening is the loaf that was
 *   there at noon, with no per-body work and no `roomFill` propping it up. That
 *   was the hard half of this and it fell out of pointing the correction the
 *   other way.
 * - The cost is the mirror of it: a mover OUTDOORS is lit at noon after dark,
 *   because an ambient light is one number for everything it touches and the
 *   bake is the only thing here that knows where the walls are. A shopper on the
 *   road at midnight is brighter than the road. That is the one honest error in
 *   this file, it is outdoors where almost nothing happens, and it is the same
 *   error `ROOM_FILL` used to make in the other direction — see the note there.
 *   If it ever stops being tolerable the fix is per-body, not a number here.
 */

/**
 * ...and how bright the room actually sits, as a fraction of the open field at
 * midday. This is the number to turn.
 *
 * Under 1 for two reasons, and the second is the one that would not have been
 * obvious. A roofed room genuinely IS dimmer than the field outside it at noon,
 * so this is what makes stepping through the door read as stepping indoors at
 * every hour rather than only after dark.
 *
 * And it is what leaves a lamp something to do. `lit` is unchanged, so a lamp's
 * baked pool still ramps from a quarter at midday to its full worth after dark —
 * but it lands on a surface whose brightness no longer moves, so what it is
 * WORTH is now decided here. Pinned at 1 the room would be as bright as a field
 * at noon all night, every fitting in the catalogue would be a rounding error
 * against it, and buying lights would have quietly stopped being a purchase.
 * Turn this down and lamps matter more; turn it up and the shop reads flatter
 * and more even. It is deliberately a plain scalar rather than a colour: the
 * whole complaint that started this was the room's own hue moving, so the roof
 * has to be the one term in here with no opinion about colour at all.
 */
const ROOF_LEVEL = 0.72;

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
 * ...and the layer the far backdrop stands on, which exists for ONE reason:
 * the ink pass must not draw it.
 *
 * `Ink.render` takes the normals by setting `scene.overrideMaterial`, which
 * replaces every material in the world — so the contour pass never sees the
 * haze `surround.js` fades that band out with, and it never sees the sink that
 * gets it out of the camera's way either. What that draws is a full-strength
 * black outline round a mountain that is ninety percent dissolved into the sky,
 * and an outline round hills that have been lowered out of the shot. Both read
 * as the drawing being wrong rather than as a pass being blind.
 *
 * A layer is the whole fix, because three tests `camera.layers` per object:
 * `Ink` turns this one off for the normals draw and back on afterwards, so the
 * far band is lit, drawn and hazed exactly as before and simply contributes no
 * lines. The NEAR ridge deliberately keeps its ink — it is solid, it is close,
 * and it is part of the scene rather than part of the distance.
 */
export const SURROUND_LAYER = 3;

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

/**
 * What share of a lamp reaches something ABOVE it.
 *
 * Every fitting in this shop is a downlight — a pendant, a strip in a freezer
 * cabinet, a shade on a stand — and the bake had no idea, because it is a
 * distance and nothing else. That was invisible for as long as the only things
 * it reached were the floor, the walls and the fixtures, every one of which is
 * under the lamps. The roof is the first surface over them, and it is over them
 * by about 0.7 of a tile against a 4-tile range: `fall` is still 0.68 up there,
 * so a pendant baked the underside of its own slab at nearly full brightness,
 * `BAKE_MAX` landed it at 1.47 over `ROOF_LEVEL`, and the largest flat surface
 * in the game clipped to white. What that reads as is the ceiling being a
 * lightbox — the brightest thing in a frame taken at eye level, in a shop lit
 * from above.
 *
 * A share rather than nothing at all, because a fitting DOES throw a little up
 * and the faint halo round one is most of what says it is a fitting rather than
 * a decal. It wants to be small: the soffit is the largest flat surface in the
 * game and the one thing it must never be is the brightest, so the number is set
 * by where the ceiling sits against the FLOOR under the same lamp — a lift of
 * about 0.04 over `ROOF_LEVEL` against the floor's 0.11, which is a shop lit
 * from above rather than a lightbox with a shop under it.
 */
const UPLIGHT = 0.05;

/**
 * How far above a lamp it takes to get there, in tiles.
 *
 * Because it is a fact about HEIGHT and never about angle, which is the one
 * mistake available here. Modelled as a cone — the share falling off with how
 * directly overhead the sample is — the ceiling comes out a DONUT: dimmest
 * straight above the fitting, where the cone is tightest, and brightest a tile
 * out where `fall` is still high and the angle has opened up. That is a halo
 * with a hole in it, which reads as worse art than the white pool it replaced.
 *
 * The band exists at all because one baked path is per-VERTEX
 * (`rebakeMesh` walks `position`), so an unsoftened step would draw a hard
 * horizontal line across anything tall enough to straddle a lamp — an overhead
 * duct beside a pendant is the case in the shop today. A quarter tile is under
 * the height of a crate and over the width of that seam.
 */
const UPLIGHT_BAND = 0.25;

/**
 * A WINDOW IS A HOLE IN THE ROOF, which is the only shape it could have here.
 *
 * Not a lamp — the room is not short of light, it is short of *sky*. So a pane
 * hands the cells in front of it a share of the OUTDOOR factor back, and the two
 * directions fall out of one line without either being written down:
 *
 * - At midday the field is 1 and the room is `ROOF_LEVEL`, so a window is a
 *   genuinely brighter patch of floor along the frontage. That is the sentence
 *   anybody means by "windows let the light in", and nothing here says it.
 * - After dark it runs the other way. The field is a fifth of noon, so the same
 *   pane makes the same strip DIMMER than the shop behind it — the middle of the
 *   room lit by its own ceiling and the frontage going orange and then blue with
 *   the sky, which is what a shop looks like from the street at closing time.
 *
 * `WINDOW_SHARE` is capped well under 1 because a pane is not a missing wall: at
 * 1 the cell against the glass would be lit like the field, which is a black hole
 * in the floor of a lit shop at midnight and reads as a rendering fault. Six
 * tiles of reach because that is about how far into a shop a frontage carries on
 * a 45° camera — shorter and it is a stripe nobody reads as daylight, longer and
 * one pane un-roofs the whole building.
 */
const WINDOW_RANGE = 6;
const WINDOW_SHARE = 0.55;

/**
 * Which edges let the day in.
 *
 * Every glazing, and the two glazed openings — a shopfront door is a pane you
 * can walk through and a fanlight is a window over a door, and both line up with
 * the glass either side of them by construction (see `WAY_LOOKS`). Derived from
 * the two tables rather than written out, because a fifth glazing authored into
 * `GLAZING` is a window in every other respect and a list here would be the one
 * place it silently was not.
 *
 * A plain doorway is deliberately NOT in it. A hole in a wall does let light
 * through, and a shop's front door is a hole in a wall that every shop has — so
 * including them would hand every building in every save a bright patch by the
 * entrance and make the glass you paid for the thing that changed nothing.
 * Daylight is what a window is FOR; a doorway is for walking through.
 */
const DAYLIT_EDGES = new Set([
  ...GLAZING.keys(),
  ...[...WAYS].filter(([, w]) => w.base === 'glazed').map(([k]) => k),
]);

export class Lights {
  constructor(scene) {
    this.scene = scene;
    this.emitters = [];
    this.chosen = [];
    this.daylight = 1;
    this.spill = 0;
    this.lit = DAY_FLOOR;
    /**
     * What the day does to a surface that is NOT under the roof, per channel —
     * `sky(now) / sky(noon)`, so 1 at midday and dark and orange at dusk. See
     * THE ROOF above: this is the whole day cycle for everything the bake
     * reaches, and it is at most 1 so it can never clip a banded shop to white.
     */
    this.outdoor = new THREE.Color(1, 1, 1);
    /**
     * Is the day doing anything at all — the cheap test `bakeInto` opens on. 1 at
     * midday, when the roof has nothing to say and the whole pass can be skipped.
     */
    this.roofed = false;
    /**
     * The sky as one colour, now and at its best, which is what `outdoor` is a
     * ratio between. Handed in by `setSky` because `scene.js` owns the day
     * cycle's constants and two of them move with the look; deriving it here
     * would be a second opinion about the sun.
     */
    this.skyNow = new THREE.Color(1, 1, 1);
    this.skyRef = new THREE.Color(1, 1, 1);
    /**
     * The glass in the walls. Its own list rather than joining `emitters`,
     * because a window must never take one of the eight: a shopfront is twenty
     * panes, and a pool aimed at the nearest emitters would spend every light in
     * the game on a wall — and there is nothing for a real light to do here
     * anyway, since a window subtracts roof rather than adding brightness.
     */
    this.windows = [];
    this.indoor = null;
    this.w = 0;
    this.h = 0;
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

  /**
   * Which cells are inside the building.
   *
   * The layout's own mask rather than the shell rectangle, because enclosure is
   * whatever the walls close in and has been since step 3 of docs/building.md —
   * so an annex you drew this morning is a room tonight, and a shop with its
   * front wall taken out has *no* indoor cells at all. That last one is the
   * silent third state CLAUDE.md warns about, and here it is simply right: a
   * building that is not a building does not get a ceiling.
   */
  setIndoor(L) {
    this.indoor = L?.indoor ?? null;
    this.w = L?.w ?? 0;
    this.h = L?.h ?? 0;
  }

  /**
   * Is this point standing in the shop?
   *
   * Rounded, because the mask is per cell and most of what asks is per cell
   * too. The one caller that is not is a wall, which sits on the LINE between
   * two cells and therefore rounds to whichever of them is on its `+` side —
   * so half the shop's walls take the lift and half do not. That is deliberate
   * rather than tolerated: a wall is lit by the room on one face and by the sky
   * on the other, and this is a per-vertex bake with no idea which face it is
   * looking at, so a wall that took the lift on both would be a shop glowing
   * through its own brickwork. Walls in fact take theirs from the SKY, which is
   * held at midday now (see THE ROOF) and therefore lights both faces of every
   * wall in the shop at the same hour whatever the clock says; this comment is
   * here for the next thing that hangs geometry on an edge and asks this.
   */
  inside(x, z) {
    if (!this.indoor) return false;
    const cx = Math.round(x);
    const cz = Math.round(z);
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return false;
    return !!this.indoor[cz * this.w + cx];
  }

  /**
   * The glass, as flat records — `setEmitters` for something nobody bought.
   *
   * Taken from the layout for the same reason the lamps are taken from the
   * fixtures: a window is a position and a range, and the list outlives every
   * re-flow that rebuilt the wall it is set in.
   */
  setWindows(list) {
    this.windows = list ?? [];
  }

  /**
   * What the sky is worth right now, and what it is worth at its best.
   *
   * Two colours rather than a number because the day cycle is a ratio here and
   * half of what the ratio carries is HUE — the sunset reaches an outdoor
   * surface through this and through nothing else, now that the sun's own colour
   * is held at midday. The reference is midday's, so the ratio is never above 1
   * and a banded shop can never be asked to hold a brightness it has no room
   * for (see THE ROOF, and `paintLit`).
   */
  setSky(now, ref) {
    if (this.skyNow.equals(now) && this.skyRef.equals(ref)) return;
    this.skyNow.copy(now);
    this.skyRef.copy(ref);
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
    // ...and what the day is doing to everything the roof does not cover. The
    // ratio is against midday and clamped there, so it only ever darkens — see
    // THE ROOF for why that direction is the whole of this file's shape.
    this.outdoor.setRGB(
      dayTerm(this.skyNow.r, this.skyRef.r),
      dayTerm(this.skyNow.g, this.skyRef.g),
      dayTerm(this.skyNow.b, this.skyRef.b),
    );
    // Is the open field doing anything but midday — the cheap test that lets a
    // point standing OUTSIDE skip the whole question. There is no matching test
    // for indoors, and there must not be: the roof is a fact about the building
    // rather than about the hour, so a cell under it is `ROOF_LEVEL` at noon as
    // much as at midnight.
    this.roofed = Math.min(this.outdoor.r, this.outdoor.g, this.outdoor.b) < 0.995;

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
    // How much sky this point is standing under — 0 beneath a roof, 1 out in the
    // field, and a share of the way back beside a window. This is the whole day
    // cycle for anything the bake reaches, and the reason it can no longer duck
    // out on a shop with no fittings in it: a building nobody has bought a lamp
    // for is exactly the one that most needs telling apart from the field
    // outside.
    const open = this.openness(x, z);
    if (open === 1 && !this.roofed && !this.emitters.length) return color;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const e of this.emitters) {
      const d2 = (e.x - x) ** 2 + (e.y - y) ** 2 + (e.z - z) ** 2;
      if (d2 >= e.range * e.range) continue;
      const fall = (1 - Math.sqrt(d2) / e.range) ** 2;
      // Which SIDE of the lamp this is, which a distance cannot say. See
      // `UPLIGHT` and `UPLIGHT_BAND`.
      const up = Math.min(1, Math.max(0, y - e.y) / UPLIGHT_BAND);
      const side = 1 - (1 - UPLIGHT) * up;
      const amount = fall * side * e.intensity * this.lit * BAKE_GAIN;
      const c = tint(e.color);
      r += amount * c.r;
      g += amount * c.g;
      b += amount * c.b;
    }
    // The sky is a MIX between the roof and the open field, and the lamps are
    // ADDED on top of whichever of the two this point got. That ordering is the
    // whole of what makes a lamp behave: it is worth a fifth of the ground it
    // stands on out in a dark yard and a fraction of a lit shop floor, off one
    // sum, because the base moved and the lamp did not. `BAKE_MAX` still stops a
    // stack of overlapping pools going white; the sky half never could, since
    // neither end of the mix is above 1.
    color.r *= mix(ROOF_LEVEL, this.outdoor.r, open) + Math.min(r, BAKE_MAX);
    color.g *= mix(ROOF_LEVEL, this.outdoor.g, open) + Math.min(g, BAKE_MAX);
    color.b *= mix(ROOF_LEVEL, this.outdoor.b, open) + Math.min(b, BAKE_MAX);
    return color;
  }

  /**
   * How much sky this point is standing under: 1 outdoors, 0 under the roof, and
   * a share of the way back to 1 for glass in the wall beside it.
   *
   * The window half is the only reason this is not just `inside`. It takes the
   * NEAREST pane rather than summing them, because the panes of a shopfront are
   * one window as far as anybody standing in front of it is concerned — summed,
   * a wall of glass would un-roof the shop in proportion to how finely it had
   * been divided, so re-glazing a frontage in the four-tile look would light the
   * aisle differently to the same frontage in eight two-tile ones.
   */
  openness(x, z) {
    if (!this.inside(x, z)) return 1;
    let best = 0;
    for (const w of this.windows) {
      const d2 = (w.x - x) ** 2 + (w.z - z) ** 2;
      if (d2 >= WINDOW_RANGE * WINDOW_RANGE) continue;
      const fall = (1 - Math.sqrt(d2) / WINDOW_RANGE) ** 2;
      if (fall > best) best = fall;
    }
    return best * WINDOW_SHARE;
  }
}

/**
 * One channel of the day, as a fraction of what that channel is worth at midday.
 *
 * Clamped to 1 at the top, which is the load-bearing half — see THE ROOF. A
 * ratio that could exceed 1 would ask a vertex colour to hold a brightness it
 * has no room for, and under the look `paintLit` would clip it to white rather
 * than draw it. Clamped at the bottom because a look could in principle author a
 * midday darker than a dusk, and a negative multiplier is a hole.
 */
function dayTerm(now, ref) {
  if (!(ref > 0)) return 1;
  return Math.max(0, Math.min(1, now / ref));
}

/** Roof to field, by how much sky a point is standing under. */
const mix = (roof, field, open) => roof + open * (field - roof);

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
      // height of a shade on a stand. A freezer is the other fixed fitting: its
      // light is mounted in the upper cabinet, not floating in the middle of
      // the stock. Keeping that source high makes the authored shelf strips
      // below read as a top-down wash rather than a bare bulb between two rows.
      // Read off the kind rather than the piece id so every freezer design gets
      // the same honest source position.
      y: f.kind === 'prop-ceiling' ? ceilingY - 0.1 : (f.kind === 'freezer' ? 1.18 : 0.85),
      z: f.z,
      color: emits.color ?? '#ffd9a0',
      intensity: (emits.intensity ?? 1) * worth,
      range: emits.range ?? 4,
    });
  }
  return out;
}

/**
 * Every pane of glass in a layout, as a position on the wall line.
 *
 * Read straight off `edgesV`/`edgesH` rather than off anything the sim keeps,
 * because glass is not a fixture and has no record: a window is a number on a
 * lattice line and this is the one place that number becomes light. Which
 * numbers count is `DAYLIT_EDGES`, derived from the two edge tables so a fifth
 * glazing is a window here the day it is authored.
 *
 * The position is the wall's own centre — the lattice line in one axis,
 * mid-cell in the other, which is `buildWorld`'s convention for the same edge
 * (see the emit loops there, and keep the two the same: a window drawn on one
 * line and lighting another is a bright patch beside the glass rather than
 * through it). No height, because `openness` is a question about a cell and a
 * pane runs the height of the wall anyway.
 *
 * Nothing is deduplicated and nothing is merged. A frontage of eight panes is
 * eight entries, and that costs nothing precisely because `openness` takes the
 * NEAREST rather than the sum — see the note there, which is the whole reason
 * this can stay a flat list.
 */
export function windowsIn(L) {
  const out = [];
  if (!L) return out;
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x <= L.w; x++) {
      if (DAYLIT_EDGES.has(L.edgesV?.[z * (L.w + 1) + x] ?? 0)) out.push({ x: x - 0.5, z });
    }
  }
  for (let z = 0; z <= L.h; z++) {
    for (let x = 0; x < L.w; x++) {
      if (DAYLIT_EDGES.has(L.edgesH?.[z * L.w + x] ?? 0)) out.push({ x, z: z - 0.5 });
    }
  }
  return out;
}
