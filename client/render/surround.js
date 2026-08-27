/**
 * THE LAND PAST THE LAST TILE.
 *
 * `buildVistaForest` was 48 unlit cones in a ring and this replaces it. What it
 * is for has not changed — the playable lot sits on an apron of plain grass that
 * runs `GROUND_MARGIN` tiles past the last cell, and without something standing
 * on it the world reads as a table rather than as a place. What has changed is
 * that WHICH place is a fact about the shop (`shared/surrounds.js`), and that
 * the scatter is the LAST of three layers rather than the only one.
 *
 * ─── THE NUMBER THAT SETS EVERY OTHER NUMBER IN HERE ───────────────────────
 *
 * How much ground is on screen past the camera's own target is
 * `(FRUSTUM / zoom / 2) / sin(pitch)`, and **the pitch is the term that
 * matters**, because it moves by a factor of thirteen:
 *
 *       pitch     40°    25°    15°    10°     5°     3°
 *       default    9     14     23     34     67    112   tiles
 *       zoomed    19     29     47     70    139    232   tiles
 *
 * So there is no single distance a backdrop can live at. Looking down, anything
 * past ~20 tiles is off screen and wasted; flattened out — which is precisely
 * the pose somebody adopts to LOOK at the horizon — everything inside 40 tiles
 * is under the shop and the rest of the frame is bare lawn. That is why there
 * are three bands and not one, and the far one is not optional: it is the only
 * layer that exists in the view a player tilts down to admire.
 *
 * (An earlier pass here reasoned from the home pitch alone, concluded that no
 * horizon was ever visible, and put everything inside 26 tiles. It is right
 * about 40° and wrong about every other angle the camera has.)
 *
 * AND THE SKY IS MADE BY THE GROUND. The apron runs 320 tiles precisely so the
 * world never visibly ends (see `GROUND_MARGIN`), which used to mean green
 * filled the frame at every pitch and `paintSkyGradient` drew a background
 * nobody had ever seen. The apron takes the same haze everything here does
 * (`apronMaterial`), run all the way to sky, so its far end IS the sky colour
 * and the seam cannot be found. That is the horizon, and it is also why a
 * skyline painted into the sky gradient would still be pointless: what you are
 * looking at up there is ground.
 *
 * THE OLD RING WAS MOSTLY OFF SCREEN TOO. It scattered at 16–44 tiles, which is
 * past the near band at a working pitch and far short of the far one, so it
 * managed to be in the way looking down and invisible looking out.
 *
 * ─── AND A SURROUND IS ONE PLACE, IN ALL THREE OF THEM ────────────────────
 *
 * Which is the rule the three bands cost, and it was broken for a build. The
 * ridge and the far band were one builder each, shared by all three surrounds
 * and told apart by a colour and a boolean — so a surround only really differed
 * in the layer its own function drew, and a city had a meadow ring sitting
 * between its blocks and its towers. Worse, the blocks were the NEAR band: 2.6
 * to 12.5 units of tower standing four tiles from the fence, which is skyline in
 * the one place a skyline cannot be.
 *
 * So each of the three cuts its own hills (`RIDGE_SHAPE`), stands its own things
 * on them (`ridge`'s `onHill`) and closes its own horizon (`FAR_SHAPE`). The
 * test for a fourth: pick any band on its own, and it should be impossible to
 * mistake which of the surrounds it belongs to.
 *
 * That is a rule about the SHAPES and never about the budget. Every height in
 * here is still measured against the shop's wall — see the note on `distant`,
 * which is the one number in the file that has been got wrong twice.
 *
 * ─── AND WHY THE HAZE IS NOT `THREE.Fog` ──────────────────────────────────
 *
 * Camera fog is wrong for this projection rather than merely awkward. `Fog`
 * measures depth from the camera, and this camera PANS — on a 14-tile leash
 * ordinarily and anywhere at all in build mode (`setFreeRoam`) — so any range
 * near enough to fade a ridge ten tiles out will also haze half the shop the
 * moment you pan toward the back of it, and free roam can haze all of it. The
 * quantity that actually wants fading is distance from the LOT, which no
 * camera-relative fog can express.
 *
 * So the haze is a shader injection on the backdrop's own materials, keyed off
 * world position — the same shape `tuftMaterial` in scene.js uses for the wind,
 * and for the same reason. It cannot touch the shop, it does not move when you
 * pan, and it fades along the VIEW AXIS rather than radially — ground receding
 * from you dissolves into the sky, ground coming toward you never does, which
 * is the difference between a horizon and a fog bank in the foreground.
 *
 * ─── AND THE FOUR RULES THE OLD RING BROKE ────────────────────────────────
 *
 *   IT IS LIT. `MeshBasicMaterial` is unlit, so the old trees stayed flat green
 *   while the shop went to sunset colours and the lamps came on, every night.
 *   In this renderer Basic is what you use for something that GLOWS. Everything
 *   here except the windows derives from `material()`, so it takes the day cycle
 *   and swaps to toon under Cel + Ink like the rest of the art.
 *
 *   IT FILLS THE CORNERS. The ring placed items on four independent edges at a
 *   perpendicular offset, which leaves the diagonals empty — and the camera is a
 *   45° isometric, so the emptiest part was permanently mid-horizon. `ringSpot`
 *   lays a picture FRAME whose four strips tile exactly.
 *
 *   IT IS SCATTERED BY HASH, NEVER BY RNG. Build mode re-flows on every wall
 *   segment of a drag and `buildWorld` rebuilds this with it, so a drawn scatter
 *   would reshuffle the horizon while you dragged a wall.
 *
 *   IT COSTS A HANDFUL OF DRAWS. Every kind of thing is one `InstancedMesh`
 *   carrying per-instance colour, so "four house colours" is a buffer.
 *
 * Nothing here is ever picked, lit by a lamp, or cast into.
 */

import * as THREE from 'three';
import { hash01 } from '../../shared/hash.js';
import { S, surroundOf } from '../../shared/surrounds.js';
import { SURROUND_COLORS } from './palette.js';
import { material } from './props.js';

/**
 * The near two bands, in tiles past the edge of the lot.
 *
 * These are the ones a working pitch can see — the props at every angle, the
 * ridge from about 30° down. `FAR_IN`/`FAR_OUT` below are the third.
 *
 * Props stop roughly where the ridge starts: a tree standing in front of a hill
 * reads as a tree, and one standing on the same ground as the hill reads as a
 * mistake in the scatter.
 */
const PROP_IN = 4;
const PROP_OUT = 12;
const HILL_IN = 10;
const HILL_OUT = 24;
/**
 * ...and the FAR band, which exists because the header's arithmetic was only
 * ever true of the HOME pitch.
 *
 * The camera tilts, from 40° down to 3°, and how much ground is on screen is
 * `half / sin(pitch)` — so it runs 9 tiles at the home pose and **232** at the
 * flattest. A backdrop that stops at 26 is therefore correct looking down and
 * completely empty the moment anybody flattens the view, which is exactly when
 * a backdrop is the thing you are looking at.
 *
 * 130 rather than 232: past about that, an object has to be enormous to read at
 * all, and the haze has taken it to within a few percent of the ground colour
 * anyway. What is out there past 130 is meant to be nothing.
 */
const FAR_IN = 18;
const FAR_OUT = 46;

/**
 * ★ WHERE THE HORIZON IS, in tiles past the lot. The knob to turn.
 *
 * This ramp is applied to the far band AND to the apron itself (see
 * `apronMaterial`), so `HAZE_OUT` is the distance at which the ground finishes
 * becoming sky — which is to say it is the horizon, and how much sky is on
 * screen is decided here and nowhere else. Smaller brings the horizon closer
 * and shows more sky; larger pushes it back toward the old all-green frame.
 *
 * IT STARTS PAST THE RIDGE, NOT ON IT. At 11–26 it covered the ridge exactly,
 * so the hills were 60–80% haze and came out as a pale smear against a dark
 * lawn — which is not "a hill fading into the distance", it is a hill with the
 * colour taken off it, and it reads as a bug because it is one. The ridge is
 * the nearest backdrop layer and it has to keep its own colour.
 *
 * The far band is deliberately inside the ramp rather than beyond it: a skyline
 * standing past `HAZE_OUT` is a skyline painted in sky, which is nothing.
 */
const HAZE_IN = 26;
const HAZE_OUT = 52;

/**
 * How much of the haze colour a fully hazed surface is allowed to take.
 *
 * ONE, and it has to be one. Anything less leaves the far end of the apron a
 * few percent green against a sky that is not, which draws as a hard band right
 * across the top of the world — the seam being invisible is the whole of what
 * makes the ground and the background read as one horizon.
 */
const HAZE_MAX = 1.0;

/**
 * THE ONE THING EVERY BACKDROP MATERIAL SHARES.
 *
 * A single uniform bundle rather than one per material, so `Scene` moves the
 * whole horizon with one write per snapshot and a surround built mid-session
 * arrives already in step with the sky. Seconds are `WIND_CLOCK`'s argument;
 * this is the same one about a colour.
 *
 *   `color` — what a fully hazed surface becomes. Driven by `Scene.updateSky`,
 *             so dusk moves the whole backdrop without this file knowing the
 *             day exists.
 *
 *             IT IS THE LAWN AND NOT THE SKY, which is the single thing this
 *             layer got most wrong. Haze should fade a thing into whatever is
 *             BEHIND it — and there is no sky behind anything here. The apron
 *             runs 320 tiles precisely so the world never visibly ends, so the
 *             ground fills the frame at every pitch and a distant hill is seen
 *             against grass. Fading it to sky-blue put a pale grey smear across
 *             a dark green field: correct atmospheric perspective, aimed at a
 *             horizon that is not on screen.
 *   `span`  — (centreX, centreZ, halfW, halfH): the lot, as a rectangle.
 *
 * THE DISTANCE IS TO THE LOT RECTANGLE AND NOT TO ITS CENTRE, which is the one
 * thing in here that is easy to get wrong and impossible to see is wrong. The
 * ring is laid out in Chebyshev distance from the lot EDGE (`ringSpot`'s `out`),
 * so a radial haze would disagree with it worst exactly at the corners — a hill
 * on the north edge and a hill on the north-east corner are the same distance
 * out and would be hazed 68% and 100%. What that draws is a ridge that fades
 * unevenly as it goes round, which reads as bad art rather than as bad
 * arithmetic. Same `max(abs(p) - half, 0)` the scatter uses, one shader along.
 */
export const HAZE = {
  color: { value: new THREE.Color('#cfe9f5') },
  span: { value: new THREE.Vector4(0, 0, 1, 1) },
  /**
   * WHICH WAY THE CAMERA IS, AND HOW MUCH IT MINDS — `(dirX, dirZ, strength)`.
   *
   * A ring surrounds the lot, so a quarter of it is always on the camera's side
   * of the shop. Looking down that is harmless and even useful: it sits at the
   * bottom of the frame and gives the shot a foreground. Flatten the view and
   * the same quarter is standing directly between you and the building — a hill
   * eating two thirds of the screen, which is the one thing a backdrop must
   * never do.
   *
   * This is `hideNearWalls`' problem exactly, and it gets a different answer for
   * a different reason. Walls are batched by which face they are on, so their
   * near two can be whole meshes and faded as units. A backdrop is one instanced
   * mesh per KIND with the ring scattered through it, so there is nothing to
   * split — and re-sorting the instance buffers on every camera move would be a
   * rebuild per frame. The shader already knows its own world position, so the
   * test costs a dot product.
   *
   * `strength` is what keeps this from being a rule that fires when nobody asked:
   * it is 0 at the home pitch and 1 once the view is flat, so the near band is
   * only given up at the angles where it is actually in the way. See
   * `Scene.aimSurround`.
   */
  near: { value: new THREE.Vector3(0, 0, 0) },
};

/**
 * How near the camera's own bearing a thing has to be before it is given up.
 *
 * Cosines against the direction from the lot to the camera, so they are
 * independent of how big the lot is and of which band the object is in. 0.986
 * is about ten degrees either side of dead ahead and 0.62 is about fifty — so
 * the hole cut in the ring is a narrow one directly between you and the shop,
 * dissolving over forty degrees rather than cutting.
 */
const HIDE_FROM = 0.62;
const HIDE_TO = 0.986;

/**
 * A backdrop material: the shop's own material for this colour, plus the haze.
 *
 * CLONED rather than built from scratch, which is what keeps the backdrop
 * honest under Cel + Ink: `material()` answers a Lambert or a Toon depending on
 * the look, and a hand-rolled Lambert here would be the one thing in the scene
 * that did not band. Cloning takes whichever class the look is on, and the
 * injection below is class-agnostic — it runs on the finished fragment colour,
 * after the shading and after the tone map.
 *
 * The clone is also what makes it safe to touch: `material()` is a cache shared
 * by the entire renderer, and hanging an `onBeforeCompile` on a cached material
 * would put this shader on every object in the game that happens to be that
 * colour. The cost of owning it is that nothing collects it — `disposeGroup`
 * deliberately frees geometry and leaves materials alone — so every one made
 * here goes on the list the builder hands back.
 */
/**
 * `String.replace` with a miss is a silent no-op, which is the worst possible
 * failure for a shader injection: three compiles the stock shader, the backdrop
 * draws perfectly, and the haze simply never happens. Nothing logs, and the only
 * symptom is a hard-edged ridge — which looks like a value that wants tuning.
 *
 * The chunk names are three's and not ours, so they can be renamed by a version
 * bump. Both are present in `meshlambert` and `meshtoon` as of three 0.185.
 */
function inject(src, mark, next) {
  if (!src.includes(mark)) {
    throw new Error(`surround haze: three no longer emits ${mark} — see hazed()`);
  }
  return src.replace(mark, next);
}

/**
 * ★ HOW FAR THE NEAR QUARTER OF THE RING DROPS, IN WORLD UNITS.
 *
 * It was nine of the instance's OWN heights, on the reasoning that everything
 * here is about as tall as it is scaled, so a proportional sink buries the lot
 * and they all clear at about the same moment. That is true of a hill, a tree
 * and a tower, and it is false of the one shape nobody had built yet: a THIN
 * PART HIGH UP. A city block's parapet is 0.14 thick sitting five units off the
 * ground, so nine of its own heights is 1.26 — the block goes and the lid stays,
 * and what you get is flat slabs hanging in mid-air over an empty field. Which
 * reads as the hiding being broken rather than as arithmetic, and it is the
 * shape of every detail anybody would add next: a cap, a sign, a canopy.
 *
 * So it is a distance in the WORLD, converted into object space by the
 * instance's own y scale. Two things fall out of that and both are the point.
 * Every instance sharing a material sinks by the same amount, so a landform
 * made of four steps and a block wearing a lid go down RIGID rather than coming
 * apart on the way — which is what a proportional sink was quietly buying and
 * would have to be given back. And it becomes a number per band, because there
 * is no single one: a 1.2-unit bollard and an 11-unit tower want the same
 * *fraction* of the ramp, and the tower is in a different mesh anyway.
 *
 * `NEAR` buries anything on the props band or the ridge (tallest ~5) by about
 * two fifths of the way through the hide ramp; `FAR` does the same for the
 * skyline. Both are deliberately several times what they have to clear — see
 * `HIDE_FROM`, the ramp they are a fraction of.
 */
const SINK_NEAR = 12.0;
const SINK_FAR = 30.0;

/**
 * The half of the vertex shader that gets a thing out of the way.
 *
 * `world` names a `vec3` the caller has already filled with this vertex's world
 * position, because both callers need one and only one of them keeps it.
 */
function sinkGLSL(world, sink) {
  if (!sink) return '';
  return `{
         float sy = 1.0;
         #ifdef USE_INSTANCING
           sy = max(length(instanceMatrix[1].xyz), 1e-4);
         #endif
         vec2 rel = ${world}.xz - uSpan.xy;
         float cosCam = dot(normalize(rel + vec2(1e-4)), uNear.xy);
         float hide = smoothstep(${HIDE_FROM.toFixed(3)}, ${HIDE_TO.toFixed(3)}, cosCam) * uNear.z;
         transformed.y -= hide * ${sink.toFixed(1)} / sy;
       }`;
}

/**
 * ★ HOW MUCH ONE CELL OF THE APRON DIFFERS FROM THE NEXT.
 *
 * The lot's ground is drawn cell by cell with a per-cell colour (`jitter` in
 * palette.js, 0.05 there), and the apron is ONE PLANE 320 tiles across with a
 * single colour on it. Side by side that is not a subtle difference: the shop's
 * land has grain and the world outside it is a painted backdrop, so the join
 * reads as a hard ring round the property — which looks like the apron being
 * unfinished rather than like two different meshes, and it is the last thing in
 * frame that still says "backdrop".
 *
 * It has to be procedural rather than per-instance because the apron is a
 * single quad: there are no cells to colour. `floor(world.xz)` recovers the
 * same tile grid the shop is drawn on, so the two grains line up across the
 * boundary instead of being two different noises meeting.
 *
 * MULTIPLICATIVE IN LINEAR, where the lot's is additive in sRGB, and they are
 * not the same arithmetic — this is matched by eye at play zoom rather than
 * copied, because the injection point has to sit before the sRGB encode (see
 * the haze note below for why that is forced).
 */
const APRON_GRAIN = 0.09;

function hazed(color, own, sink = SINK_NEAR, grain = false) {
  const m = material(color).clone();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHaze = HAZE.color;
    shader.uniforms.uSpan = HAZE.span;
    shader.uniforms.uNear = HAZE.near;
    shader.vertexShader = inject(
      `varying vec3 vSurWorld;
       uniform vec4 uSpan;
       uniform vec3 uNear;
       ${shader.vertexShader}`,
      '#include <begin_vertex>',
      /**
       * GET OUT OF THE WAY -- see the note on HAZE.near, and on SINK_NEAR for
       * how far.
       *
       * IT SINKS RATHER THAN DISSOLVES, and the first version did dissolve: a
       * per-pixel dither against a discard, which is the standard trick and is
       * wrong for this art. Everything in this game is flat colour over large
       * areas, so a stochastic threshold has nothing to hide in -- what it drew
       * was a hillside of black speckle, which reads as the renderer being
       * broken rather than as anything fading.
       *
       * Sinking costs nothing, stays completely opaque (so no sorting, which an
       * instanced mesh cannot do within itself anyway), and is the one
       * disappearance that suits the subject: the apron runs 320 tiles in every
       * direction, so a hill going down goes behind ground that is already
       * there and simply becomes the field again.
       */
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         vSurWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
       #else
         vSurWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
       #endif
       ${sinkGLSL('vSurWorld', sink)}`,
    );
    /**
     * The HAZE half. Injected AFTER the shading and tone map but BEFORE the
     * sRGB encode, and the position is arithmetic rather than taste.
     *
     * Haze happens between the surface and the eye rather than on the surface,
     * so it must land after the lighting — mix it in earlier and the sun
     * brightens the mist. But it must land before `<colorspace_fragment>`,
     * because a `THREE.Color` uniform arrives in the renderer's LINEAR working
     * space while `gl_FragColor` past that chunk is sRGB-encoded. Mixing the two
     * is a silent mismatch: no error, nothing to see in the shader, and a haze
     * that comes out markedly darker than the sky it is supposed to be
     * dissolving into — which reads as a grey band round the world.
     */
    shader.fragmentShader = inject(`varying vec3 vSurWorld;
      uniform vec3 uHaze;
      uniform vec4 uSpan;
      uniform vec3 uNear;
      ${shader.fragmentShader}`,
      '#include <colorspace_fragment>',
      `{
         ${grain ? `{
           /**
            * THE GRAIN, and it goes in BEFORE the haze on purpose: it is a fact
            * about the ground rather than about the air, so it has to be the
            * thing the distance dissolves rather than something laid on top of
            * the dissolve. Applied after, the far field keeps its speckle while
            * turning into sky, which is a horizon with grit in it.
            *
            * FADED BY THE DERIVATIVE, which is the half that is not decoration.
            * This is a 320-tile plane seen at a shallow angle, so out near the
            * horizon one pixel covers many cells and a per-cell hash sampled
            * there is white noise -- it shimmers as the camera moves, which is
            * far worse than the flatness being fixed. fwidth says how much
            * world the pixel spans; once that reaches a cell the grain is gone.
            */
           vec2 cell = floor(vSurWorld.xz);
           float g = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
           float aa = clamp(1.0 - max(fwidth(vSurWorld.x), fwidth(vSurWorld.z)), 0.0, 1.0);
           gl_FragColor.rgb *= 1.0 + (g - 0.5) * ${APRON_GRAIN.toFixed(3)} * aa;
         }` : ''}
         /**
          * HOW FAR AWAY FROM THE VIEWER, not how far from the lot.
          *
          * This was Chebyshev distance from the lot rectangle, which is right
          * for placing the bands and wrong for hazing them -- a radial ramp
          * does not know which side of the shop you are standing on, so it
          * faded the lawn BETWEEN you and the building exactly as hard as the
          * lawn behind it. What that draws is a wash of sky colour across the
          * near grass, which is not a horizon, it is a fog bank in the
          * foreground.
          *
          * A horizon is a fact about the view direction: ground recedes away
          * from you and fades, and ground coming toward you never does. So it
          * is the component of the offset pointing AWAY from the camera, with
          * the lot's own radius taken off so the shop's ground is never touched
          * whichever way you are looking.
          *
          * Negative in the foreground, which smoothstep clamps to zero -- that
          * is the whole of the fix.
          *
          * Only the away axis is needed. An orthographic view does not widen
          * with distance, so at ZOOM_MIN the visible ground is a strip about
          * forty tiles across however far it runs: sideways never gets far
          * enough from the lot to want fading.
          */
         float d = dot(vSurWorld.xz - uSpan.xy, -uNear.xy) - max(uSpan.z, uSpan.w);
         float f = smoothstep(${HAZE_IN.toFixed(1)}, ${HAZE_OUT.toFixed(1)}, d)
                 * ${HAZE_MAX.toFixed(3)};
         gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, f);
       }
       #include <colorspace_fragment>`,
    );
  };
  // Two materials that compile to the same program still get separate ones
  // unless three is told they are interchangeable — `tuftMaterial` writes the
  // same line for the same reason. Colour is a uniform, so one program serves
  // every backdrop material there will ever be.
  // The distance is baked into the source, so it has to be part of the key —
  // one program per band rather than one for the file.
  m.customProgramCacheKey = () => `surround-haze-${sink}-${grain ? 'g' : 'p'}`;
  own.push(m);
  return m;
}

/* ---------------------------------------------------------------- scatter -- */

/**
 * A point in a band round the lot, and how far out of it that landed.
 *
 * THE FOUR STRIPS TILE — they do not overlap and they leave no gap, which is
 * the whole of what this function is for. North and south run the full width
 * and therefore own all four corners; east and west are inset on z so they
 * start exactly where north and south stop. Draw it before changing any of the
 * four: overlapping strips double the density along two diagonals, and the
 * diagonals are what the camera looks down.
 *
 * The side is picked BY AREA and not by `n % 4`, or a long thin world stands as
 * many trees down its two short sides as its two long ones.
 */
function ringSpot(key, w, h, inR, outR) {
  const depth = outR - inR;
  const wide = w + 2 * outR;
  const tall = h + 2 * inR;
  const ns = wide * depth;
  const we = tall * depth;

  const along = hash01(`${key}:along`);
  const deep = hash01(`${key}:deep`);
  let pick = hash01(`${key}:side`) * (2 * ns + 2 * we);

  let x;
  let z;
  if (pick < ns) {
    x = -outR + along * wide;
    z = -outR + deep * depth;
  } else if ((pick -= ns) < ns) {
    x = -outR + along * wide;
    z = h + inR + deep * depth;
  } else if ((pick -= ns) < we) {
    x = -outR + deep * depth;
    z = -inR + along * tall;
  } else {
    x = w + inR + deep * depth;
    z = -inR + along * tall;
  }

  // Chebyshev distance from the lot, which is what "how far out" means on a
  // rectangular ring. The city reads it to make the far blocks taller.
  const out = Math.max(Math.max(0, -x, x - w), Math.max(0, -z, z - h));
  return { x, z, out };
}

/**
 * How many things to stand in a band.
 *
 * DENSITY RATHER THAN A COUNT, which is the bug the old `count = 48` was: 48 is
 * a thicket on a starting lot and a scattering on a grown one, so buying land
 * was the one thing guaranteed to thin the backdrop out. `per` is square tiles
 * per item, and the numbers it is called with are deliberately large — see the
 * note on `PROP_PER` below.
 */
function population(w, h, inR, outR, per) {
  const area = (w + 2 * outR) * (h + 2 * outR) - (w + 2 * inR) * (h + 2 * inR);
  return Math.min(Math.max(Math.round(area / per), 4), 400);
}

/**
 * ★ THE DENSITY KNOB. Square tiles per prop, per surround. Bigger is sparser.
 *
 * On a starting 26x22 lot these give roughly 15 / 10 / 8 objects. They were 9,
 * 26 and 46 for one build, which put about five hundred in the ring — and
 * because only the inner few tiles of a ring are ever on screen, what it drew
 * was a wall of trees a stride from the fence.
 *
 * The ridge is the backdrop now and the scatter is a GARNISH on it, which is
 * the whole reason these can be this large. If it still reads as too busy or
 * too bare, this line is the only thing to change — every other number in the
 * file is about where the band is, not how full it is.
 *
 * The city is DENSEST, which is the opposite of what it was and is the same
 * argument. Its near band used to be tower blocks — the largest objects in the
 * file, so eight of them read as a district and eighty as a bar chart. They are
 * street furniture now (see `city`), which is the smallest: a lamp post every
 * forty square tiles is a street, and eight bollards scattered over a ring the
 * size of the lot is litter.
 */
const PROP_PER = { [S.COUNTRY]: 85, [S.SUBURB]: 128, [S.CITY]: 46 };

/** 0..1, which every band wants and none of them wants spelled out twice. */
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

/* ---------------------------------------------------------------- helpers -- */

const TINT = new THREE.Color();
const DUMMY = new THREE.Object3D();

/**
 * An instanced backdrop mesh: hazed material, per-instance colour, unpickable.
 *
 * WHITE, BECAUSE `instanceColor` MULTIPLIES THE MATERIAL'S OWN COLOUR. Same
 * three.js trap the shop's floor cells hit (see `addFloor` in scene.js) and the
 * same arithmetic: every instance below is written by `put`, which sets an
 * ABSOLUTE colour off `SURROUND_COLORS` — a hill tone, a roof, a parapet — so a
 * material carrying one of those as well draws the whole backdrop at roughly
 * colour SQUARED.
 *
 * It is severe here in a way it is not on near-white shop floor, because these
 * are mid tones: `#8f96a3`, the city block, comes out `#4e5666`, and then three
 * bands with `SHADOW_FLOOR` at 0.22 put every face that is not facing the sun
 * on the dark step of THAT. What the skyline draws as is near-black cut-outs at
 * noon — so the failure reads as the backdrop art being unfinished rather than
 * as the renderer applying the palette twice.
 *
 * The tell is in `SURROUND_COLORS` itself: the ridge is authored LIGHTER than
 * the ground it stands on, deliberately and with the reason written next to it,
 * and the apron is the one surface in here that is NOT instanced — so it takes
 * its colour once. Squared, every hill in the game was darker than the field in
 * front of it, which is the exact thing that note says not to do.
 *
 * `color` is kept in the signature because it is what says which band a batch
 * is; the colour that reaches the screen is the per-instance one.
 */
function batch(geo, color, count, own, sink = SINK_NEAR) {
  const mesh = new THREE.InstancedMesh(geo, hazed(0xffffff, own, sink), count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Never pointable: it stands outside every buyable cell, so a ray that could
  // reach it would be answering "which fixture" with a hill.
  mesh.raycast = () => {};
  return mesh;
}

/** Write one instance: place it, size it, turn it, colour it. */
function put(mesh, i, x, y, z, sx, sy, sz, turn, color) {
  DUMMY.position.set(x, y, z);
  DUMMY.scale.set(sx, sy, sz);
  DUMMY.rotation.set(0, turn, 0);
  DUMMY.updateMatrix();
  mesh.setMatrixAt(i, DUMMY.matrix);
  mesh.setColorAt(i, TINT.set(color));
}

/**
 * ...and the same for an instance whose colour is a BRIGHTNESS rather than a
 * colour — every window, which multiplies its material rather than replacing it.
 *
 * `setScalar` and deliberately not `set()`: a CSS string goes through three's
 * colour management and comes back gamma-converted, which is right for a colour
 * somebody chose and wrong for a multiplier. Passing the number to `set()` would
 * be worse still, since three reads a bare number as a packed hex.
 */
function putLit(mesh, i, x, y, z, sx, sy, sz, lit) {
  DUMMY.position.set(x, y, z);
  DUMMY.scale.set(sx, sy, sz);
  DUMMY.rotation.set(0, 0, 0);
  DUMMY.updateMatrix();
  mesh.setMatrixAt(i, DUMMY.matrix);
  mesh.setColorAt(i, TINT.setScalar(lit));
}

/**
 * Every instanced mesh needs both buffers flushed, and forgetting the colour one
 * is silent: three uploads the matrices, the mesh draws in the right places, and
 * every instance comes out black.
 */
function flush(...meshes) {
  for (const m of meshes) {
    if (!m) continue;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ ridge -- */

/**
 * THE RIDGE — the layer that actually answers "it looks alone".
 *
 * A band of low, wide, overlapping humps at 10–24 tiles. Overlapping is the
 * whole trick: individually they are lumps, and a run of them sharing edges
 * reads as one continuous landform, which is what stops the eye at the edge of
 * the lawn. So the density here is set to guarantee overlap rather than to
 * scatter — this is the one thing in the file that must NOT look scattered.
 *
 * SUNK BY A THIRD, which is what makes a squashed sphere a hill instead of a
 * boulder: what you want is the cap, and the bottom third is the part that
 * would otherwise show you it is a ball sitting on the grass.
 *
 * Nine by five segments, and low-poly on purpose — the facets are the art, and
 * `material()` sets `flatShading`, so a smooth sphere here would be the one
 * round thing in a game made of planes.
 */
/**
 * A LANDFORM, BUILT THE WAY THE BUILDING IS — out of boxes, in steps.
 *
 * This was a squashed sphere for a build, and the sphere is what was wrong with
 * it. Nothing else in this game is round: the shop is boxes, the fixtures are
 * boxes, the people are boxes, and the only curved thing anywhere is a tree.
 * A smooth dome in the middle of that reads as belonging to a different game —
 * and it fights Cel + Ink twice over, because a sphere under a banded ramp is a
 * set of curved bands and the ink pass has nothing straight to draw round.
 *
 * Terraces fix both at once. Every edge is a right angle in the same vocabulary
 * as the walls, every face is flat so the toon ramp lands one tone per face,
 * and the contour the steps make IS the shading — a shape that reads at
 * distance with no gradient in it at all.
 *
 * TWO THINGS KEEP IT A HILL RATHER THAN A ZIGGURAT. Each step is nudged off
 * centre, because a perfectly concentric stack is architecture; and the tone
 * alternates per level, so the steps read as contour bands rather than as
 * storeys. Both are hashed off the landform's own key, so they are stable
 * across the re-flow a build drag causes.
 */
/**
 * How far in the stack draws over its height, and how far each step is nudged.
 *
 * Named because `summitSpread` derives from both: what can stand on a hilltop is
 * arithmetic on how the hilltop was cut, and the two written out separately is
 * two places to change a shape and one bug — a house hanging off a ledge that
 * moved under it.
 */
const STEP_IN = 0.58;
const STEP_JITTER = 0.20;

function terrace(mesh, at, key, x, z, wide, deep, tall, levels, tints) {
  let y = 0;
  for (let i = 0; i < levels; i++) {
    const t = i / levels;
    const step = tall / levels;
    // Drawing in by more than half over the stack: less and it is a tower, more
    // and the top step is a pebble on a plateau.
    const w = wide * (1 - t * STEP_IN);
    const d = deep * (1 - t * STEP_IN);
    const ox = (hash01(`${key}:ox${i}`) - 0.5) * wide * STEP_JITTER;
    const oz = (hash01(`${key}:oz${i}`) - 0.5) * deep * STEP_JITTER;
    // Axis-aligned, never turned. A box at 30° to the tile grid is the one
    // thing that would put a diagonal edge back into the silhouette, which is
    // exactly what this shape was chosen to avoid.
    put(mesh, at + i, x + ox, y + step / 2, z + oz, w, step, d, 0, tints[i % tints.length]);
    y += step;
  }
}

/** How many steps a near hill and a far mountain are cut into. */
const RIDGE_STEPS = 3;
const PEAK_STEPS = 4;

/**
 * HOW FAR OFF A SUMMIT'S CENTRE A THING MAY STAND AND STILL BE ON IT.
 *
 * Arithmetic on `terrace` rather than a number somebody eyeballed, because the
 * failure is invisible in the one view you would check it in: a block overhanging
 * the top step floats over the ledge below by a third of the hill's height, and
 * from above — the pose you build in — the overhang is behind it and cannot be
 * seen at all. It only shows once the camera is flattened, which is the pose
 * that is looking at the ridge.
 *
 * The top step is drawn in by `STEP_IN` over the stack and nudged by up to half
 * of `STEP_JITTER`, and both of those come off the same edge, so what is left is
 * the half-width that survives whatever the hashes did. Half the thing standing
 * on it comes off as well, and a summit too small for what it was asked to hold
 * answers zero rather than a negative — dead centre, which is the one place that
 * is always on the hill.
 */
const TOP_HALF = (1 - ((RIDGE_STEPS - 1) / RIDGE_STEPS) * STEP_IN) / 2 - STEP_JITTER / 2;
const summitSpread = (span, half) => Math.max(0, span * TOP_HALF - half);

/**
 * ★ WHAT EACH SURROUND'S OWN LANDFORM IS CUT LIKE.
 *
 * The ridge was one function for all three, and that is what left a meadow ring
 * sitting inside the city: the band a player looks at over the fence said
 * countryside whatever the far band said, so a surround only ever really
 * differed in one layer out of three. A surround is a PLACE, and a place is
 * continuous from the fence to the horizon.
 *
 * `gap` is tiles of perimeter per hill — bigger is fewer, and fewer is broader,
 * which is why the city's is the largest of the three: its hills are a plateau
 * rather than a skyline, and the silhouette is spent on what stands on them.
 *
 * `tall` is `[base, gained across the band, roughness]`, and all three sit
 * inside the 0.5–1.9x wall budget the header sets (0.875–3.325 units). The
 * middle term is what makes the ridge climb away rather than run level: a flat
 * band reads as a wall, and the rise is the only depth cue an orthographic view
 * has, since distance changes nothing about size.
 *
 * WHAT STANDS ON A HILL IS THE SURROUND'S OWN BUSINESS — see `onHill`, which is
 * what makes a suburb's ridge a town on a hill and a city's the city itself
 * without either of them needing a second copy of the landform.
 */
const RIDGE_SHAPE = {
  [S.COUNTRY]: { gap: 3.1, wide: [5.5, 7.5], deep: [5.0, 6.5], tall: [0.9, 1.4, 1.0] },
  // A shade lower and gentler than the countryside's, because it has houses on
  // it: a house on a steep hummock reads as falling off it.
  [S.SUBURB]: { gap: 3.1, wide: [5.5, 7.0], deep: [5.0, 6.0], tall: [0.8, 1.2, 0.8] },
  // Broad and low, and CLOSER TOGETHER than the other two. The blocks are the
  // silhouette here (see `city`), so the ground under them only has to be ground
  // that is higher than the shop's — and one block stands per hill, so how built
  // up the ridge reads is decided by how many hills there are.
  [S.CITY]: { gap: 3.0, wide: [7.5, 8.0], deep: [7.0, 7.0], tall: [0.9, 0.9, 0.5] },
};

/**
 * The ridge, cut to a surround's own shape.
 *
 * `onHill(key, x, z, top, wide, deep, far)` is called once per landform with its
 * summit — the y of the top step, and the footprint it was cut from — so a
 * surround can stand its own things up there. It is handed the hill rather than
 * given a mesh to write into because what goes on a hilltop is a HOUSE or a
 * BLOCK: things the surround already has an instanced mesh for, and things that
 * belong in it rather than in a second one. Keeping the callback to "here is a
 * summit" is what holds the whole backdrop to a handful of draws.
 *
 * What may stand on a summit and how far off its centre is `summitSpread`, which
 * is arithmetic on how `terrace` cut the thing rather than a margin anybody
 * eyeballed — see the note there for why guessing it fails invisibly.
 */
function ridge(w, h, C, own, shape, onHill) {
  // By perimeter rather than by area: a ridge is a LINE, and what it has to do
  // is close, so the count follows how far there is to go round.
  const n = Math.min(Math.max(Math.round((w + h + 4 * HILL_OUT) / shape.gap), 24), 260);
  const hills = batch(new THREE.BoxGeometry(1, 1, 1), C.hill, n * RIDGE_STEPS, own);
  const tints = [C.hill, C.hillAlt];

  for (let i = 0; i < n; i++) {
    const key = `ridge:${i}`;
    const { x, z, out } = ringSpot(key, w, h, HILL_IN, HILL_OUT);
    // 0 at the near edge of the band, 1 at the far one.
    const far = clamp01((out - HILL_IN) / (HILL_OUT - HILL_IN));
    const wide = shape.wide[0] + hash01(`${key}:w`) * shape.wide[1];
    const deep = shape.deep[0] + hash01(`${key}:d`) * shape.deep[1];
    const tall = shape.tall[0] + far * shape.tall[1] + hash01(`${key}:h`) * shape.tall[2];
    // Which tone the bottom step takes, so neighbouring hills do not band in
    // lockstep and turn the whole ridge into a contour map.
    const flip = hash01(`${key}:tint`) < 0.5 ? 0 : 1;
    terrace(hills, i * RIDGE_STEPS, key, x, z, wide, deep, tall, RIDGE_STEPS,
      flip ? [tints[1], tints[0]] : tints);
    onHill?.(key, x, z, tall, wide, deep, far);
  }

  flush(hills);
  return hills;
}

/**
 * THE FAR BAND — the skyline, and the layer that only exists once you tilt.
 *
 * ★ EVERY HEIGHT IN HERE IS MEASURED AGAINST THE SHOP'S WALLS, WHICH ARE 1.75.
 *
 * An orthographic camera draws a thing the same size wherever it stands, so
 * there is no distance at which something is "far away and therefore small":
 * world height IS screen height, and the view is only about twelve tiles tall
 * at the default zoom. A mountain authored at twenty units — which is what this
 * shipped as, and sounds modest for a mountain — is eleven times the height of
 * the building and close to two screens tall. It does not read as a distant
 * peak, it reads as a wall you cannot see past.
 *
 * So: hills roughly half to twice the wall, far peaks one to four times, towers
 * up to six. Big enough to be a skyline, small enough to be behind the shop.
 * The haze and the colour are what say "distant"; the height never can.
 *
 * `towers` splits the two shapes a skyline comes in: humps for a landscape,
 * boxes for a city. It is a flag rather than three builders because the scatter,
 * the band and the haze are identical in all three surrounds — only the
 * silhouette differs, which is exactly what a flag is for.
 *
 * `roofs` is the suburb's, and it is the whole of what makes that far band the
 * suburb's own: up to that many distant rooftops round the SKIRT of each peak,
 * so the town does not stop at the ridge. It is a count rather than a second
 * mesh because there may be exactly ONE mesh named `surround-far` — three things
 * key off that name (the layer, the pitch cut-off in `Scene.aimSurround`, and
 * `Ink` leaving the layer out of the normals pass), and a rooftop is a box in a
 * mesh already made of boxes.
 */
const FAR_SHAPE = {
  [S.COUNTRY]: { gap: 16, towers: false, roofs: 0 },
  [S.SUBURB]: { gap: 16, towers: false, roofs: 2 },
  [S.CITY]: { gap: 8, towers: true, roofs: 0 },
};

function distant(w, h, C, own, shape) {
  // By perimeter, like the ridge, and dense enough that the silhouette closes.
  // A gappy far band is worse than none: gaps read as the world ending.
  const span = 2 * (w + 2 * FAR_OUT) + 2 * (h + 2 * FAR_OUT);
  const n = Math.min(Math.max(Math.round(span / shape.gap), 24), 200);
  // One geometry for all of it, because a mountain is built the same way a tower
  // is — see `terrace`. A tower is one box and a peak is four, which is the
  // whole of the difference between a city and a landscape here.
  const per = shape.towers ? 1 : PEAK_STEPS;
  // `SINK_FAR`, because a tower is 11 units tall against a bollard's 1.2 and the
  // two want the same fraction of the hide ramp — see the note there.
  const mesh = batch(new THREE.BoxGeometry(1, 1, 1), C.far, n * (per + shape.roofs), own, SINK_FAR);
  // Named so `Scene.aimSurround` can switch the whole layer off at pitches that
  // cannot see it — see the note there. This layer is by far the most expensive
  // thing in the file and it is invisible for most of normal play.
  mesh.name = 'surround-far';

  // A running cursor rather than `i * per`, because the rooftops are hashed and
  // an instance nobody writes is not nothing: it is an identity matrix, which is
  // a unit box sitting at the origin — in the middle of the shop.
  let at = 0;
  for (let i = 0; i < n; i++) {
    const key = `far:${i}`;
    const { x, z, out } = ringSpot(key, w, h, FAR_IN, FAR_OUT);
    const far = clamp01((out - FAR_IN) / (FAR_OUT - FAR_IN));
    const tint = hash01(`${key}:tint`) < 0.5 ? C.far : C.farAlt;
    if (shape.towers) {
      const bw = 2.2 + hash01(`${key}:w`) * 3.4;
      const bd = 2.2 + hash01(`${key}:d`) * 3.4;
      // Climbing away from the shop, so the district reads as having a centre
      // somewhere out there rather than as a wall of equal boxes.
      const bh = 2.5 + far * 5.0 + hash01(`${key}:h`) * 3.5;
      put(mesh, at++, x, bh / 2, z, bw, bh, bd, 0, tint);
      continue;
    }
    // BROAD AND LOW, which is what keeps a stepped mountain from reading as
    // another building — the one risk this shape carries. A tower is 3 to 8
    // wide against 6 to 32 tall; these are 17 to 39 wide against 5 to 20, so
    // the proportion alone says landscape before any colour does.
    const wide = 10 + hash01(`${key}:w`) * 12;
    const deep = 9 + hash01(`${key}:d`) * 11;
    const tall = 2.2 + far * 3.0 + hash01(`${key}:h`) * 2.2;
    const flip = hash01(`${key}:band`) < 0.5 ? 0 : 1;
    terrace(mesh, at, key, x, z, wide, deep, tall, PEAK_STEPS,
      flip ? [C.farAlt, C.far] : [C.far, C.farAlt]);
    at += PEAK_STEPS;

    for (let r = 0; r < shape.roofs; r++) {
      const k = `${key}:roof${r}`;
      // Thin, and thin on purpose: this is the town thinning out, not a second
      // town. Roughly one per peak, so a quarter of them have two and a third
      // have none at all, which is what stops the scatter reading as a rule.
      if (hash01(`${k}:on`) < 0.45) continue;
      // On the SKIRT of the peak and never inside its footprint. `0.55 *` the
      // widest axis clears the base step (whose half-width is exactly half of
      // it) whatever the hash does, so a rooftop can never be buried inside the
      // mountain it belongs to — which would read as it having failed to draw.
      const ang = hash01(`${k}:a`) * Math.PI * 2;
      const rr = Math.max(wide, deep) * 0.55 + 0.6 + hash01(`${k}:r`) * 2.6;
      const rx = x + Math.cos(ang) * rr;
      const rz = z + Math.sin(ang) * rr;
      // ...and never INSIDE the band, however far the skirt reached. A peak at
      // the near edge is eleven tiles across, so a rooftop hung off its inner
      // side lands among the ridge's own hills — where it is either buried in
      // one or standing in front of it, and both read as a stray. The far band
      // is also the one layer `Scene.aimSurround` switches off by pitch, so a
      // piece of it that strayed inward would pop as the camera came up.
      if (Math.max(Math.max(0, -rx, rx - w), Math.max(0, -rz, rz - h)) < FAR_IN) continue;
      const rw = 1.4 + hash01(`${k}:w`) * 1.0;
      const rh = 0.7 + hash01(`${k}:h`) * 0.6;
      const rd = 1.0 + hash01(`${k}:d`) * 0.6;
      put(mesh, at++, rx, rh / 2, rz,
        rw, rh, rd, Math.floor(hash01(`${k}:turn`) * 4) * (Math.PI / 2), C.farRoof);
    }
  }

  // What was actually written. See the note on `at` — the tail of the buffer is
  // allocated for the rooftops nobody rolled and must never be drawn.
  mesh.count = at;
  flush(mesh);
  return mesh;
}

/* ---------------------------------------------------------------- windows -- */

/**
 * THE ONE MATERIAL IN HERE THAT IS NOT HAZED.
 *
 * Windows are the only thing in a backdrop that has to CHANGE — dark glass at
 * noon, lit at dusk — so `Scene.lightSurround` lerps this one, and it is built
 * here rather than taken from the shared `material()` cache for the reason
 * `hazed` gives. It is unlit (`MeshBasicMaterial`) because that is what a lit
 * window IS: a surface the sun has no say in.
 *
 * Per-instance colour is a BRIGHTNESS rather than a hue: three multiplies
 * `instanceColor` into the material's, so a pane at 0.25 is a flat nobody is
 * home in and one at 1 is a lit room, and both go dark together at noon.
 */
/**
 * ...and the sink, on the one material that cannot have the haze one.
 *
 * A DELIBERATE SECOND COPY of six lines of `hazed()`, and both halves of that
 * are the point. The haze may not go on this material at all — it is
 * `MeshBasicMaterial` because a lit window is a surface the sun has no say in,
 * and a light that dissolves into the horizon is a light that has gone out. But
 * the SINK is not about distance: everything in the ring standing between the
 * camera and the shop drops out of the way once the view is flattened, and a
 * window that stayed behind is a row of amber dots hanging over a hillside that
 * is no longer there. That reads as a rendering fault, which is exactly what
 * `hazed`'s own note says about the dither it replaced.
 *
 * It takes `SINK_NEAR` like everything else on those two bands, which is what
 * makes a lit pane leave WITH the block it is set into rather than a moment
 * before or after it.
 */
function sunken(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSpan = HAZE.span;
    shader.uniforms.uNear = HAZE.near;
    shader.vertexShader = inject(
      `uniform vec4 uSpan;
       uniform vec3 uNear;
       ${shader.vertexShader}`,
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vec3 sWorld;
       #ifdef USE_INSTANCING
         sWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
       #else
         sWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
       #endif
       ${sinkGLSL('sWorld', SINK_NEAR)}`,
    );
  };
  mat.customProgramCacheKey = () => 'surround-glow-sink';
  return mat;
}

function windowBatch(count, own) {
  const mat = sunken(new THREE.MeshBasicMaterial({
    color: new THREE.Color(SURROUND_COLORS.city.glowDay),
  }));
  own.push(mat);
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

/**
 * Scatter lit panes over the four sides of an axis-aligned box.
 *
 * Four sides rather than the two facing the camera, because the camera turns — a
 * tower lit on the side you happened to be standing on goes dark the moment you
 * press Q. They stand a hair proud of the face (`0.02`) rather than flush:
 * coplanar faces z-fight, and a fighting pane flickers across the whole block as
 * the camera moves.
 */
function paneOn(mesh, i, key, cx, cy, cz, bw, bh, bd, wide, tall) {
  const face = Math.floor(hash01(`${key}:face`) * 4) % 4;
  const u = (hash01(`${key}:u`) - 0.5) * 0.7;
  const v = 0.1 + hash01(`${key}:v`) * 0.78;
  const y = cy - bh / 2 + v * bh;
  // Squared, so most windows are out and the lit ones stand alone — a uniform
  // grid of amber reads as a lightbox rather than as a block of flats.
  const lit = 0.25 + hash01(`${key}:lit`) ** 2 * 0.75;

  if (face === 0) putLit(mesh, i, cx + u * bw, y, cz + bd / 2 + 0.02, wide, tall, 0.04, lit);
  else if (face === 1) putLit(mesh, i, cx + u * bw, y, cz - bd / 2 - 0.02, wide, tall, 0.04, lit);
  else if (face === 2) putLit(mesh, i, cx + bw / 2 + 0.02, y, cz + u * bd, 0.04, tall, wide, lit);
  else putLit(mesh, i, cx - bw / 2 - 0.02, y, cz + u * bd, 0.04, tall, wide, lit);
}

/* ---------------------------------------------------------------- the three */

/** Woodland and hedgerow, standing in front of a green ridge. */
function country(w, h, own) {
  const C = SURROUND_COLORS.country;
  const n = population(w, h, PROP_IN, PROP_OUT, PROP_PER[S.COUNTRY]);
  const trees = Math.round(n * 0.72);
  const hedges = Math.max(n - trees, 1);

  const trunks = batch(new THREE.CylinderGeometry(0.10, 0.15, 0.72, 5), C.trunk, trees, own);
  const crowns = batch(new THREE.ConeGeometry(0.60, 2.15, 5), C.crown, trees, own);
  const hedge = batch(new THREE.BoxGeometry(1, 1, 1), C.hedge, hedges, own);

  for (let i = 0; i < trees; i++) {
    const key = `country:t:${i}`;
    const { x, z } = ringSpot(key, w, h, PROP_IN, PROP_OUT);
    const s = 0.70 + hash01(`${key}:size`) * 0.65;
    const turn = hash01(`${key}:turn`) * Math.PI * 2;
    // Two crown colours: 48 copies of one green was most of why the old ring
    // read as placeholder, and the eye catches a repeated colour a good deal
    // faster than it catches a repeated silhouette.
    const leaf = hash01(`${key}:leaf`) < 0.5 ? C.crown : C.crownAlt;
    put(trunks, i, x, 0.36 * s, z, s, s, s, turn, C.trunk);
    put(crowns, i, x, (0.72 + 1.075) * s, z, s, s, s, turn, leaf);
  }

  for (let i = 0; i < hedges; i++) {
    const key = `country:h:${i}`;
    const { x, z } = ringSpot(key, w, h, PROP_IN, PROP_OUT);
    // Long, low and thin — a hedge is a LINE, and one scaled evenly is a shrub.
    // Free-angled, unlike a house: a field boundary follows the field.
    const len = 2.6 + hash01(`${key}:len`) * 5.0;
    const tall = 0.55 + hash01(`${key}:tall`) * 0.35;
    put(hedge, i, x, tall / 2, z, len, tall, 0.7, hash01(`${key}:turn`) * Math.PI * 2, C.hedge);
  }

  const group = new THREE.Group();
  // Far band first, then the ridge, then the scatter — three depths, and the
  // far one is the whole of what you see once the camera tilts down.
  //
  // THIS IS THE ONE OF THE THREE THAT NEVER HAD TO CHANGE, and it is the
  // reference for what the other two were measured against: green hills behind
  // green woodland behind green peaks, with nothing on any of the three bands
  // that belongs to either of the others.
  group.add(distant(w, h, C, own, FAR_SHAPE[S.COUNTRY]),
    ridge(w, h, C, own, RIDGE_SHAPE[S.COUNTRY]), trunks, crowns, hedge);
  flush(trunks, crowns, hedge);
  return { group, glow: null };
}

/**
 * ONE HOUSE — body, pitched roof, and a lit window or two.
 *
 * Shared by the props band and the ridge, because a town climbing a hill is the
 * same houses standing higher up: two builders would be two silhouettes, and the
 * one thing that must not happen on a ridge is that the buildings on it read as
 * a different kind of building from the ones at the bottom.
 *
 * `cool` is the whole of the difference between the two bands — see `ridgeWall`
 * in the palette. `s` scales the lot: a house on the hill is smaller, which is
 * the only thing an orthographic camera will accept as "further away".
 */
/**
 * ...and how big the biggest one on a hill can be, which is the number
 * `summitSpread` has to be handed.
 *
 * Written out of the same literals the body uses rather than measured after the
 * fact, because it is asked BEFORE the house exists: the ridge has to know how
 * much room a house needs while it is deciding whether two of them fit, and the
 * house itself is not built until the mesh has been allocated. The roof is the
 * widest part (`1.02` of the longer side), so it is the roof that is measured.
 */
const RIDGE_HOUSE = 0.78;
const RIDGE_HOUSE_HALF = (1.7 + 0.9) * 1.02 * RIDGE_HOUSE / 2;

function putHouse(walls, roofs, glow, wi, gi, panes, key, x, y, z, s, C, cool) {
  const WALLS = cool
    ? [C.ridgeWall, C.ridgeWallAlt]
    : [C.wall, C.wallAlt, C.wallWarm, C.wallCool];
  const ROOFS = cool ? [C.ridgeRoof] : [C.roof, C.roofAlt];
  const bw = (1.7 + hash01(`${key}:w`) * 0.9) * s;
  const bd = (1.3 + hash01(`${key}:d`) * 0.7) * s;
  const bh = (1.0 + hash01(`${key}:h`) * 0.5) * s;
  const turn = Math.floor(hash01(`${key}:turn`) * 4) * (Math.PI / 2);
  const wall = WALLS[Math.floor(hash01(`${key}:paint`) * WALLS.length) % WALLS.length];
  const roof = ROOFS[Math.floor(hash01(`${key}:tile`) * ROOFS.length) % ROOFS.length];

  put(walls, wi, x, y + bh / 2, z, bw, bh, bd, turn, wall);
  // Sized off the body it sits on, so a wide house gets a wide roof — scaled
  // by a constant it overhangs the narrow ones and stops short on the wide.
  put(roofs, wi, x, y + bh + 0.31 * s, z,
    Math.max(bw, bd) * 1.02, s, Math.max(bw, bd) * 1.02, turn, roof);

  // Placed against the UNTURNED box: the quarter turn is a symmetry of a
  // scatter that is already uniform over four faces, so applying it would cost
  // a sin/cos per pane and change nothing.
  for (let p = 0; p < panes; p++) {
    paneOn(glow, gi + p, `${key}:p${p}`, x, y + bh / 2, z, bw, bh, bd, 0.34 * s, 0.30 * s);
  }
}

/**
 * A town that climbs — houses along the fence, houses up the hill, and rooftops
 * thinning out among the peaks.
 *
 * HOUSES FACE THE COMPASS. A quarter turn and never a free angle: houses stand
 * in rows because streets do, and a scatter of them at arbitrary angles reads as
 * a scrapyard even when every other number is right. Trees keep their free
 * angle, for the same reason pointed the other way.
 *
 * THE RIDGE IS BUILT FIRST AND WRITES NOTHING. It hands back the summits it cut
 * (see `ridge`'s `onHill`) and the houses are laid afterwards, because an
 * `InstancedMesh` has to be allocated before it is filled and how many houses
 * are up there is a fact the landform decides. Two passes, one mesh — the
 * alternative is a second wall mesh and a second roof mesh for the sake of the
 * same two boxes.
 */
function suburb(w, h, own) {
  const C = SURROUND_COLORS.suburb;
  const n = population(w, h, PROP_IN, PROP_OUT, PROP_PER[S.SUBURB]);
  const houses = Math.max(Math.round(n * 0.62), 1);
  const trees = Math.max(n - houses, 1);

  /**
   * Where the town gets to on the hills. Roughly one house per other hill, so
   * the ridge reads as settled rather than as a housing estate on a mountain —
   * and the ones that get two are what stops the spacing reading as a rule.
   *
   * A PAIR IS OFFERED AND NOT ASSUMED. Two houses on a summit only fit if the
   * summit is wide enough to stand them apart, and a hill's width is hashed —
   * so on the narrow ones a second house would be the first house drawn twice
   * in the same place, which at this distance reads as one slightly wrong
   * house rather than as anything being wrong.
   */
  const uphill = [];
  const hills = ridge(w, h, C, own, RIDGE_SHAPE[S.SUBURB],
    (key, x, z, top, wide, deep) => {
      const many = hash01(`${key}:town`);
      if (many < 0.44) return;
      const sx = summitSpread(wide, RIDGE_HOUSE_HALF);
      const sz = summitSpread(deep, RIDGE_HOUSE_HALF);
      const apart = RIDGE_HOUSE_HALF * 1.15;
      const count = many < 0.8 || sx < apart ? 1 : 2;
      for (let j = 0; j < count; j++) {
        const k = `${key}:h${j}`;
        // One house wanders anywhere on the top; a pair is placed, or they are
        // two hashes that might land on each other.
        const off = count === 2 ? (j - 0.5) * 2 * apart : (hash01(`${k}:x`) - 0.5) * 2 * sx;
        uphill.push({
          key: k,
          x: x + off,
          z: z + (hash01(`${k}:z`) - 0.5) * 2 * sz,
          y: top,
        });
      }
    });

  const all = houses + uphill.length;
  const walls = batch(new THREE.BoxGeometry(1, 1, 1), C.wall, all, own);
  // Four sides and an eighth turn: `ConeGeometry` puts a vertex at angle 0, so
  // an unturned four-sided cone is a diamond in plan and hangs off the corners
  // of the box under it. The pitch is the entire silhouette of a suburb — a box
  // with a flat top at this size is a shed, and a row of them is a trading
  // estate.
  const roofGeo = new THREE.ConeGeometry(0.78, 0.62, 4);
  roofGeo.rotateY(Math.PI / 4);
  const roofs = batch(roofGeo, C.roof, all, own);
  const trunks = batch(new THREE.CylinderGeometry(0.09, 0.13, 0.62, 5), C.trunk, trees, own);
  const crowns = batch(new THREE.ConeGeometry(0.52, 1.75, 5), C.crown, trees, own);
  // Two panes for a house you stand next to and one for a house on the hill: at
  // that size a second pane is the same pane twice.
  const glow = windowBatch(houses * 2 + uphill.length, own);

  for (let i = 0; i < houses; i++) {
    const key = `suburb:${i}`;
    const { x, z } = ringSpot(key, w, h, PROP_IN, PROP_OUT);
    putHouse(walls, roofs, glow, i, i * 2, 2, key, x, 0, z, 1, C, false);
  }

  for (let i = 0; i < uphill.length; i++) {
    const u = uphill[i];
    // Smaller than the ones by the fence. With no perspective to shrink it, a
    // hilltop house drawn at the size of a doorstep one puts the hill at the
    // bottom of the garden.
    putHouse(walls, roofs, glow, houses + i, houses * 2 + i, 1,
      u.key, u.x, u.y, u.z, RIDGE_HOUSE, C, true);
  }

  for (let i = 0; i < trees; i++) {
    const key = `suburb:t:${i}`;
    const { x, z } = ringSpot(key, w, h, PROP_IN, PROP_OUT);
    const s = 0.60 + hash01(`${key}:size`) * 0.5;
    const turn = hash01(`${key}:turn`) * Math.PI * 2;
    put(trunks, i, x, 0.31 * s, z, s, s, s, turn, C.trunk);
    put(crowns, i, x, (0.62 + 0.875) * s, z, s, s, s, turn, C.crown);
  }

  const group = new THREE.Group();
  group.add(distant(w, h, C, own, FAR_SHAPE[S.SUBURB]),
    hills, walls, roofs, trunks, crowns, glow);
  flush(walls, roofs, trunks, crowns, glow);
  return { group, glow: glow.material };
}

/**
 * A city — the pavement at your feet, the built-up area rising behind it, and
 * towers you never get to.
 *
 * ★ THE BLOCKS MOVED OUT A BAND, and that is the whole of what was wrong here.
 * They were the PROPS: 2.6-to-12.5-unit tower blocks standing four to twelve
 * tiles from the shop, which is seven times the height of the wall at a distance
 * you could throw something. That is not street-level detail, it is more skyline
 * in the wrong place — and it left the ridge between the two bands as the same
 * green hills the countryside gets, so a city had a meadow ring sitting inside
 * it. Blocks belong on the ridge, where a built-up area actually is; the band
 * you stand next to gets the things you stand next to.
 *
 * TALLER FURTHER OUT, on both of the bands that have height. An orthographic
 * projection gives distance nothing to do — a block ten tiles away and one
 * twenty tiles away are drawn exactly the same size — so a skyline that climbs
 * is the only thing that can say which is which, alongside the haze. `far` does
 * the work and the hash only roughens it, or the back of the city is a perfectly
 * smooth ramp and reads as a wall.
 *
 * AXIS-ALIGNED, deliberately. Cities are grids, a box turned 20° at this size is
 * a box with a bad silhouette, and keeping them square is what lets `paneOn`
 * place windows with no rotation to carry.
 */
function city(w, h, own) {
  const C = SURROUND_COLORS.city;
  const n = population(w, h, PROP_IN, PROP_OUT, PROP_PER[S.CITY]);
  const GREYS = [C.block, C.blockAlt];
  // Two rather than the nine a near tower carried. A block on the ridge is a
  // silhouette with a light in it, and nine panes on something that size is a
  // lit grid — which reads as a lightbox rather than as a building.
  const PANES = 2;

  /**
   * THE RIDGE IS THE CITY. Built first, and it writes nothing itself — see the
   * same two-pass shape in `suburb`.
   *
   * The heights are the one thing in here worth checking against the header's
   * budget, because they STACK: a block stands on the hill's own summit, so what
   * the eye sees is the sum. The city's ridge is cut low on purpose (0.9–2.3)
   * and a block adds 0.7–2.6, which tops out around 4.9 — under three times the
   * wall, comfortably inside the far towers' own 2.5–11, and therefore still
   * reading as the middle of three distances rather than as the front of them.
   *
   * ONE PER HILL, and the footprint is CLAMPED to the summit it stands on
   * (`summitSpread`) rather than hashed freely. A block wider than its hilltop
   * hangs over the ledge below by a third of the hill's height — invisible from
   * the pose you build in, because the overhang is behind it, and plainly wrong
   * from the flattened one that is looking at the ridge. Density comes from the
   * hills being close together instead: `RIDGE_SHAPE` cuts more of them for the
   * city than for either of the others.
   */
  const built = [];
  const hills = ridge(w, h, C, own, RIDGE_SHAPE[S.CITY], (key, x, z, top, wide, deep, far) => {
    if (hash01(`${key}:built`) < 0.22) return;
    const k = `${key}:b`;
    // The parapet is the widest part, so it is the parapet that has to fit.
    const bw = Math.min(1.5 + hash01(`${k}:w`) * 1.5, 2 * summitSpread(wide, 0) / 1.07);
    const bd = Math.min(1.5 + hash01(`${k}:d`) * 1.5, 2 * summitSpread(deep, 0) / 1.07);
    built.push({
      key: k,
      far,
      bw,
      bd,
      y: top,
      x: x + (hash01(`${k}:x`) - 0.5) * 2 * summitSpread(wide, bw * 1.07 / 2),
      z: z + (hash01(`${k}:z`) - 0.5) * 2 * summitSpread(deep, bd * 1.07 / 2),
    });
  });

  // Block and parapet in one mesh: both are boxes and the colour is per
  // instance, so the lip along the top costs an instance rather than a draw.
  const blocks = batch(new THREE.BoxGeometry(1, 1, 1), C.block, built.length * 2, own);
  // The street: one cylinder mesh (posts, bollards, bins) and one box mesh
  // (benches, walls, cars) between them cover every piece of furniture in the
  // band, because a lamp post and a bin differ in scale and colour and in
  // nothing else. `n * 3` is the worst case, a row of three bollards.
  const posts = batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 6), C.post, n * 3, own);
  const kit = batch(new THREE.BoxGeometry(1, 1, 1), C.kerb, n * 2, own);
  // Windows on the hill, and the lamp heads down here — one material, so the
  // street lights and the city come on together at dusk, which is the whole of
  // what makes them read as one place after dark.
  const glow = windowBatch(built.length * PANES + n, own);

  for (let i = 0; i < built.length; i++) {
    const b = built[i];
    const { bw, bd } = b;
    const bh = 0.7 + b.far * 1.2 + hash01(`${b.key}:h`) * 0.7;
    // The pale grey is for the back of the skyline, so it is picked by depth
    // rather than at random: the far end drifts toward the sky and the near end
    // stays solid, which is the same trick the ridge plays with `hillAlt`.
    const grey = b.far > 0.62 && hash01(`${b.key}:haze`) < 0.7
      ? C.blockFar
      : GREYS[Math.floor(hash01(`${b.key}:grey`) * 2) % 2];

    put(blocks, i * 2, b.x, b.y + bh / 2, b.z, bw, bh, bd, 0, grey);
    // The lip along the top. The only detail that survives at this size, and
    // without it every roofline is the same hard edge and the blocks read as one
    // extruded mass.
    put(blocks, i * 2 + 1, b.x, b.y + bh + 0.07, b.z, bw * 1.07, 0.14, bd * 1.07, 0, C.parapet);

    for (let p = 0; p < PANES; p++) {
      paneOn(glow, i * PANES + p, `${b.key}:p${p}`,
        b.x, b.y + bh / 2, b.z, bw, bh, bd, 0.22, 0.30);
    }
  }

  /**
   * THE BAND YOU STAND NEXT TO. Nothing in here is over about 1.2 — a shade
   * under the shop's own wall — because this is the one layer of the three that
   * is read at arm's length rather than across a field, and an orthographic
   * camera gives four tiles away and forty exactly the same size.
   */
  let ci = 0;
  let bi = 0;
  let gi = built.length * PANES;
  for (let i = 0; i < n; i++) {
    const key = `city:${i}`;
    const { x, z } = ringSpot(key, w, h, PROP_IN, PROP_OUT);
    // Quarter turns, like the suburb's houses and for the same reason: street
    // furniture stands square to a street, and one at 20° reads as knocked over.
    const turn = Math.floor(hash01(`${key}:turn`) * 4) * (Math.PI / 2);
    // The turned box's own two axes in world space, so a part can be offset
    // ALONG the thing it belongs to — `put` turns about the instance origin, so
    // an offset written in world x would swing round with it.
    const lx = Math.cos(turn);
    const lz = -Math.sin(turn);
    const dx = Math.sin(turn);
    const dz = Math.cos(turn);
    const kind = hash01(`${key}:kind`);

    if (kind < 0.20) {
      // A lamp post: a pole and a lit head, and no metal on the head at all —
      // the glow IS the lantern, so it costs one instance rather than two and
      // goes out with the rest of the city at noon.
      const tall = 0.92 + hash01(`${key}:tall`) * 0.14;
      put(posts, ci++, x, tall / 2, z, 0.09, tall, 0.09, 0, C.post);
      putLit(glow, gi++, x, tall + 0.06, z, 0.22, 0.11, 0.22,
        0.55 + hash01(`${key}:lit`) * 0.45);
    } else if (kind < 0.38) {
      // Bollards come in a ROW. One on its own is a post nobody can read; three
      // in a line along the kerb is the only thing in the band that says which
      // way the street runs.
      const many = 2 + Math.floor(hash01(`${key}:many`) * 2);
      for (let b = 0; b < many; b++) {
        const off = (b - (many - 1) / 2) * 0.62;
        put(posts, ci++, x + lx * off, 0.27, z + lz * off, 0.17, 0.54, 0.17, 0, C.post);
      }
    } else if (kind < 0.54) {
      const tall = 0.56 + hash01(`${key}:tall`) * 0.12;
      put(posts, ci++, x, tall / 2, z, 0.34, tall, 0.34, 0, C.bin);
    } else if (kind < 0.72) {
      // A bench: seat and back. Two boxes is the whole of it at this size, and
      // legs would be four more instances of something a tile away is not
      // looking at.
      put(kit, bi++, x, 0.36, z, 1.10, 0.09, 0.36, turn, C.bench);
      put(kit, bi++, x + dx * 0.15, 0.53, z + dz * 0.15, 1.10, 0.32, 0.09, turn, C.bench);
    } else if (kind < 0.88) {
      // A low wall, which is the one piece of furniture that is a LINE — the
      // hedge's job in the countryside, done in concrete.
      const len = 2.0 + hash01(`${key}:len`) * 1.8;
      put(kit, bi++, x, 0.26, z, len, 0.52, 0.32, turn, C.kerb);
    } else {
      // A parked car. Body and cabin, the cabin set back down its own length so
      // it reads as a bonnet rather than as a box on a box, and the roof at 0.73
      // — the tallest thing in the band after the lamps.
      const paint = hash01(`${key}:paint`) < 0.5 ? C.car : C.carAlt;
      put(kit, bi++, x, 0.23, z, 1.55, 0.42, 0.72, turn, paint);
      put(kit, bi++, x - lx * 0.12, 0.58, z - lz * 0.12, 0.82, 0.30, 0.62, turn, C.post);
    }
  }

  // Only what was written — an instance nobody set is a unit box at the origin,
  // which here would be a bollard standing in the middle of the shop.
  posts.count = ci;
  kit.count = bi;
  glow.count = gi;

  const group = new THREE.Group();
  // Towers out there rather than humps: a city's far band IS the skyline, and
  // the tallest and palest of the three layers.
  group.add(distant(w, h, C, own, FAR_SHAPE[S.CITY]), hills, blocks, posts, kit, glow);
  flush(blocks, posts, kit, glow);
  return { group, glow: glow.material };
}

const BUILDERS = {
  [S.COUNTRY]: country,
  [S.SUBURB]: suburb,
  [S.CITY]: city,
};

/**
 * Build the land round a lot `w` x `h`.
 *
 * Hands back the group to hang in the scene, the ONE material `Scene` lerps
 * between day and night, and a `dispose` for everything this file owns.
 *
 * THE DISPOSE IS THE CONTRACT AND IT IS NOT OPTIONAL. `disposeGroup` frees
 * geometry and instance buffers and deliberately leaves materials alone, because
 * every other material in the renderer comes out of the shared `material()`
 * cache and freeing one would take it from everything else drawn in that colour.
 * Every material in here is a clone or a one-off, so every one of them is this
 * function's to give back — and a surround is rebuilt on every re-flow, which is
 * every wall segment of a build drag.
 *
 * `glow` is null for countryside, and every caller has to cope with that rather
 * than being handed a dummy: a material that is lerped and drawn by nothing is
 * the same dead knob as a tier that moves no number.
 *
 * An id it does not know falls back to countryside rather than throwing —
 * `surroundOf` has already narrowed it, and a renderer is the wrong place to
 * discover that a save is wrong.
 */
export function buildSurround(id, w, h) {
  const own = [];
  const { group, glow } = (BUILDERS[id] ?? country)(w, h, own);
  // The lot, as a rectangle. Written per build rather than once because the lot
  // GROWS when you buy land, and a re-flow is what keeps the haze round it.
  HAZE.span.value.set(w / 2, h / 2, w / 2, h / 2);
  return {
    group,
    glow,
    dispose: () => { for (const m of own) m.dispose(); },
  };
}

/**
 * WHAT COLOUR THE GROUND IS HERE.
 *
 * The one thing in a surround that is NOT drawn by this file — the apron and the
 * lot's own unpainted cells belong to `buildWorld`, and they are between them
 * most of the screen. So the answer lives here with the rest of the place and
 * `Scene` asks for it, rather than this file reaching into the ground.
 *
 * Total, like `surroundOf`, for the same reason: a read has to answer something,
 * and a renderer is the wrong place to find out that a save is wrong.
 */
export function surroundGround(id) {
  return (SURROUND_COLORS[surroundOf(id)] ?? SURROUND_COLORS[S.COUNTRY]).ground;
}

/**
 * THE APRON'S OWN MATERIAL — the one that actually makes a sky.
 *
 * The ground runs `GROUND_MARGIN` (320) tiles past the last cell so the world
 * never visibly ends, and the cost of that is that it never visibly ends: green
 * fills the frame at every angle and the sky gradient behind it is a texture
 * nobody has ever seen. Shrinking the apron is not the answer — a plane that
 * stops in mid-air at one pitch on one monitor is the failure `GROUND_MARGIN`
 * is sized to prevent.
 *
 * So the apron keeps its size and DISSOLVES instead: the same haze every other
 * backdrop material carries, run to `HAZE_MAX` of 1, so past `HAZE_OUT` the
 * ground is exactly the sky colour and the seam between it and the real
 * background cannot be found. That is a horizon, and everything else in this
 * file fading into the same colour is what makes it read as distance rather
 * than as a green field with a gradient on it.
 *
 * A sink of ZERO is the one thing here that is not optional. The apron is the
 * ground — sinking the quarter of it nearest the camera would drop the floor
 * out of the world.
 */
export function apronMaterial(color) {
  return hazed(color, [], 0, true);
}
