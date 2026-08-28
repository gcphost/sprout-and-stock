/**
 * PROCEDURAL PROPS.
 *
 * There are no art assets in this game. Every item, crop and character is a
 * small pile of flat-shaded primitives described by JSON.
 *
 * That's not a shortcut — it's what makes the co-op playground work. When an
 * agent invents "Artisanal Hot Sauce", it writes the item's *appearance* in
 * the same JSON blob as its tags and price, and the thing shows up on a shelf
 * seconds later with no asset pipeline, no import step, and nothing to commit.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { partsAt, seamStep, skinnedParts, modelBounds, FRONT_LIP } from '../../shared/model.js';
import { FACE_CALM, VEHICLE_LOOK, CRATE_LOOK, WASTE_LOOK, shade } from './palette.js';
import { BUILDS, STOCK_HAIR, STOCK_HAIR_COLOR } from '../../shared/looks.js';
import { signed } from '../money.js';
import { lookOn, lookKey, gradientMap, MARK } from './look.js';

/** One shared geometry per primitive shape — never allocate these per prop. */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 7),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  capsule: new THREE.CapsuleGeometry(0.4, 0.6, 3, 10),
};

/*
 * Characters deliberately get their own, smooth geometry.  The shop's props
 * are graphic and faceted; a person is read at a glance from farther away, so
 * a few clean curves make them feel designed rather than like another stack of
 * scenery primitives.  Keeping these separate means a low-poly tomato or a
 * crate does not silently become expensive just because the people did.
 */
/*
 * ONE box, and every person in the game is made of it.
 *
 * This used to be six geometries — two sphere resolutions for the masses, two
 * more for limbs and beads, a sphere cap for headwear and a torus for a smile —
 * because a character was smooth and round while the shop around it was
 * flat-shaded and hard-edged. That mismatch is the thing people actually
 * noticed: the crowd was the one set of objects on screen that did not look
 * like it belonged to this game.
 *
 * A box has no segment count to tune, no pole to squash, and no silhouette that
 * changes with the camera, so the whole "spend resolution where it is seen"
 * argument the old table was built around simply stops applying. It is also
 * separate from `GEO.box` on purpose: `SHARED_GEO` protects both from disposal,
 * and a person's geometry having its own name is what keeps a future change to
 * character detail from quietly re-costing every crate in the shop.
 */
const CHARACTER_GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
};

/**
 * Every module-level geometry, by identity — the primitives above and the
 * character shapes with them.
 *
 * Two callers, and the second is the one that was wrong. `paintLit` clones
 * before writing a hue into a shared shape, or one fixture tints every box in
 * the game. `disposeGroup` frees whatever it is handed and has to skip these,
 * and it was checking `GEO` alone: a character's meshes point straight at
 * `CHARACTER_GEO`, so every shopper who left the shop disposed the head, body
 * and limbs of everybody still in it. Nothing breaks — three re-uploads a
 * disposed geometry the next time it is drawn — so what it costs is a buffer
 * upload per character per departure, on the one thing that happens all day.
 */
const SHARED_GEO = new Set([...Object.values(GEO), ...Object.values(CHARACTER_GEO)]);

/**
 * The chevron's own outline, for the hollow one — see `stockOpen`.
 *
 * Module-level and shared, because a marker is built and torn down every time
 * the set of them changes, which is every armful. Not in `GEO` because it is
 * not a primitive — it is a *derivation* of one, and a table of shapes anybody
 * may draw with is the wrong place for a shape that only makes sense wrapped
 * round `GEO.cone`. In `SHARED_GEO` all the same: `disposeGroup` only frees
 * what answers `isMesh` and a `LineSegments` does not, so today nothing would
 * touch it — which is a fact about that function rather than a promise, and
 * this outliving one marker is the point either way.
 *
 * The base fan is coplanar, so `EdgesGeometry` keeps the base ring and the ten
 * slant edges and drops the spokes across the bottom — a faceted cone rather
 * than the mess `wireframe: true` would give.
 */
const CONE_EDGES = new THREE.EdgesGeometry(GEO.cone);
SHARED_GEO.add(CONE_EDGES);

const materialCache = new Map();
const characterMaterialCache = new Map();

/**
 * Flat-shaded material, cached by colour so a hundred tomatoes share one.
 *
 * `alpha` below 1 makes it glass. `depthWrite: false` is what stops a pane
 * writing depth over the goods behind it — the same trick the thought bubble
 * has always used, and without it a freezer door hides its own contents.
 */
/**
 * ...and what a shaded surface IS, which is the one thing the look changes here.
 *
 * `MeshToonMaterial` with a ramp of hard steps, or the Lambert the game shipped
 * with. It is one branch in two functions because every mesh in the game comes
 * through them — a shelf, a loaf, a hire, a wall — so nothing else in the
 * renderer has to know the mode exists.
 *
 * A `glow` material is exempt and has to be: that flag is what the art declares
 * on a lamp lens, a sign face, a neon tube, and shading a light source is what
 * makes a lit sign go grey the moment the sun goes down.
 *
 * NO `flatShading` ON THE TOON ONE. three has no such property on it and says
 * so, once per material, which at ~190 materials is a console you cannot read.
 * It costs nothing anyway: every primitive in `GEO` is a box or a cylinder with
 * split normals already, so the facets are in the geometry rather than in the
 * shader.
 */
function shaded(color, extra) {
  if (!lookOn()) {
    return new THREE.MeshLambertMaterial({ color: new THREE.Color(color), ...extra });
  }
  const { flatShading, ...rest } = extra;
  return new THREE.MeshToonMaterial({
    color: new THREE.Color(color),
    gradientMap: gradientMap(),
    ...rest,
  });
}

export function material(color, alpha = 1, glow = false) {
  const glass = alpha < 1;
  // The mode is in the KEY rather than cleared out of the map, because this
  // cache is keyed by colour and the mode decides what class a colour resolves
  // to — so without it, turning the look on hands every colour back its Lambert
  // and the rebuild comes out as exactly what it was. Keyed rather than cleared
  // so a mesh still holding the old material goes on drawing until whatever
  // owns it is rebuilt; see `Scene.setLook`.
  const key = `${lookKey()}|${glow ? 'glow:' : ''}${glass ? `${color}@${alpha}` : String(color)}`;
  let m = materialCache.get(key);
  if (!m) {
    const glassBits = glass ? { transparent: true, opacity: alpha, depthWrite: false } : {};
    // No `flatShading` on the glow one either, and that is not a behaviour
    // change: three has never had the property on `MeshBasicMaterial`, so it
    // was being warned about and dropped. An unlit fill has no normals to
    // flatten. What it buys is the console back — one line per material, and
    // there are about a hundred and ninety of them.
    m = glow
      ? new THREE.MeshBasicMaterial({ color: new THREE.Color(color), ...glassBits })
      : shaded(color, { flatShading: true, ...glassBits });
    materialCache.set(key, m);
  }
  return m;
}

/** A small smooth-material palette reserved for people. */
export function characterMaterial(color) {
  const key = `${lookKey()}|${color}`;
  let m = characterMaterialCache.get(key);
  if (!m) {
    m = shaded(color, {});
    characterMaterialCache.set(key, m);
  }
  return m;
}

/**
 * The same material, reading a per-vertex tint.
 *
 * How a static thing gets BAKED light. A lamp reaches a fixture's underside and
 * never its lid — the pool is a point below the canopy, so the biggest face on
 * screen faces away from every light in the room and a lit display case reads
 * as one that isn't. Baked light has no direction to be wrong about: it is a
 * number the shop worked out on the CPU and multiplied into the colour.
 *
 * Cached by the SOURCE material, so this adds one clone per colour and alpha
 * rather than one per fixture — the sharing that makes `weld` worth doing is
 * still intact, because the brightness rides in the geometry, not in here.
 */
const litVariants = new Map();
export function litMaterial(mat) {
  let m = litVariants.get(mat);
  if (!m) {
    m = mat.clone();
    m.vertexColors = true;
    litVariants.set(mat, m);
  }
  return m;
}

/**
 * One material for every colour that shades the same way.
 *
 * `material()` is a cache keyed by COLOUR, which is what a hundred tomatoes
 * sharing one is about — and it is also the ceiling on `weld`, because two
 * meshes can only merge if they carry the same material. A shop is about a
 * hundred colours, so a group of twenty parts came out as eight or nine draws
 * however static it was, and `actorRoot` alone was 954 meshes on 166 materials.
 *
 * So the hue moves into the geometry. A vertex colour multiplies the material's
 * own, so a white material plus a baked hue is the same picture, and everything
 * that shades identically — same transparency, same side, same flat shading —
 * can then merge into ONE mesh whatever colour it was authored in.
 *
 * Keyed on everything that is not the colour. A textured material is refused
 * (there is one map per material and a merge has one), and so is anything whose
 * geometry carries a different set of attributes, which `weld` folds in: merging
 * a uv'd geometry with one that has none fails, and the failure is silent.
 */
const batchMaterials = new Map();
export function batchMaterial(src) {
  if (src.map || Array.isArray(src)) return null;
  const key = `${src.type}|${src.transparent ? 1 : 0}|${src.opacity}|${src.side}`
    + `|${src.depthWrite ? 1 : 0}|${src.flatShading ? 1 : 0}`;
  let m = batchMaterials.get(key);
  if (!m) {
    m = src.clone();
    // White, because the hue is now the vertex colour and three multiplies the
    // two. Any other base would tint the whole shop.
    m.color = new THREE.Color(1, 1, 1);
    m.vertexColors = true;
    batchMaterials.set(key, m);
  }
  return m;
}

/**
 * One colour into a geometry's `color` attribute, making it if it is missing.
 *
 * Written straight from `Color.r/g/b`, which are already in the renderer's
 * working space — three converts a material's colour on the way in and does NOT
 * convert vertex colours, so anything else here would come out a different
 * shade to the material it is replacing.
 */
function fillColor(geo, colour) {
  const n = geo.attributes.position?.count ?? 0;
  if (!n) return;
  let attr = geo.attributes.color;
  if (!attr || attr.count !== n) {
    attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute('color', attr);
  }
  for (let i = 0; i < n; i++) {
    attr.array[i * 3] = colour.r;
    attr.array[i * 3 + 1] = colour.g;
    attr.array[i * 3 + 2] = colour.b;
  }
  attr.needsUpdate = true;
}

/**
 * Paint one flat brightness through a whole group, as vertex colour.
 *
 * One value for the unit rather than per vertex: a fixture is about a tile
 * across, which is the resolution the baked floor works at anyway, and a
 * gradient across a shelf would need the model subdivided to show it.
 *
 * Re-callable — the attribute is filled in place when it already exists, which
 * is what makes re-baking on the hour cost nothing but the fill.
 */
export function paintLit(group, r, g, b) {
  /**
   * A BANDED SHOP CANNOT HOLD A BRIGHTNESS ABOVE ONE, so it must not be given
   * one.
   *
   * The bake is a multiplier, and it runs well past 1 where lamps overlap — a
   * quarter of every vertex colour in a mature shop, peaking above 2. Under
   * Lambert that is a pool of light on the floor and reads as exactly that.
   * Under a toon ramp the shaded term is already at the top step, so ×2 clips
   * the channel to white: the colour is gone, not brightened, and what it looks
   * like is a milky haze over the shelves — which reads as fog, or as the ink
   * washing out, rather than as a number nobody clamped.
   *
   * Clamped rather than rescaled, and only under the look: the pool keeps its
   * shape (the dim end of the bake is untouched), it just stops trying to
   * express a brightness the material has no room for. Off, this line does
   * nothing and the bake is the bake it always was.
   */
  if (lookOn()) {
    r = Math.min(1, r);
    g = Math.min(1, g);
    b = Math.min(1, b);
  }
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const n = o.geometry.attributes.position?.count ?? 0;
    if (!n) return;
    // A part that dodged the weld — a blade, a lever — is still holding one of
    // the SHARED primitives out of `GEO`, and writing a colour into that would
    // tint every box in the game to whatever the last fixture painted. Clone
    // first; `disposeGroup` frees a clone and skips the shared original, so the
    // copy is collected with the shop it was made for.
    if (SHARED_GEO.has(o.geometry)) o.geometry = o.geometry.clone();
    let attr = o.geometry.attributes.color;
    if (!attr || attr.count !== n) {
      attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      o.geometry.setAttribute('color', attr);
    }
    // A welded mesh is drawn in a WHITE material with its hue in this same
    // attribute, so the brightness has to be multiplied through that hue rather
    // than written over it — writing over it would repaint the whole shop grey.
    // Everything else still holds its colour in its material, and for those the
    // attribute is the brightness on its own, exactly as it always was.
    const base = o.geometry.userData?.baseColor;
    if (base && base.length === n * 3) {
      for (let i = 0; i < n * 3; i += 3) {
        attr.array[i] = base[i] * r;
        attr.array[i + 1] = base[i + 1] * g;
        attr.array[i + 2] = base[i + 2] * b;
      }
    } else {
      for (let i = 0; i < n; i++) {
        attr.array[i * 3] = r;
        attr.array[i * 3 + 1] = g;
        attr.array[i * 3 + 2] = b;
      }
    }
    attr.needsUpdate = true;
    if (!o.material.vertexColors) o.material = litMaterial(o.material);
  });
}

/**
 * Build a prop from a validated `model` object: `{ parts: [{shape,color,pos,scale,rot}] }`,
 * or a staged one, in which case `t` (0..1) says how far along it is — growth
 * for a crop, tier for a fixture. See `shared/model.js`.
 *
 * `abuts` is asked, for each part flagged `seam`, whether something stands
 * against that side of the model — see `seamStep`. Only a placed fixture knows
 * the answer, so everything else leaves it off and keeps every part it was
 * drawn with; a crop in your hand has no neighbours.
 *
 * Returns a Group positioned so its origin sits on the ground.
 *
 * Any part flagged `motion` is also collected onto `group.userData.moving`,
 * with the rest pose it was built at. Collected HERE rather than found later by
 * whoever wants to animate it, because a `seam` can drop a part on the way past
 * — so the meshes are not the parts, and matching them up by index afterwards
 * quietly spins the wrong box. See `animateMotion` in render/motion.js.
 */
/**
 * @param {number} [opts.alpha]  Multiplies every part's own opacity, for
 *        drawing a model as a ghost. A multiplier rather than an override
 *        because a part that authored itself as glass has to stay *more*
 *        see-through than the box beside it — flattening every part to one
 *        opacity turns a freezer's door into another wall of the freezer.
 *        It goes through the same `material()` cache, so a shop previewing a
 *        shelf shares materials with the shelves already standing in it.
 */
/**
 * Which axis a turning part turns about, read off the box somebody drew.
 *
 * `spin` is always Y and says so in the schema — a blade lies flat, and every
 * spin in the catalog was authored against that. `sweep` cannot be: a clock hand
 * lives in a vertical face, so its axis is Z, and a hand on a face turned a
 * quarter is X. There is exactly one axis a flat bar can turn about without
 * leaving the plane it was drawn in, and it is the one the bar is THINNEST on —
 * so the art already says it, the same way `seamStep` reads which side a panel
 * closes rather than being told.
 *
 * Ties go to Y, which is the answer for a part that is not flat at all and the
 * one every other kind of motion assumes.
 */
function turnAxis(part) {
  if (part.motion?.kind !== 'sweep') return 'y';
  const [sx, sy, sz] = part.scale ?? [1, 1, 1];
  if (sz <= sx && sz <= sy) return 'z';
  if (sx < sy && sx < sz) return 'x';
  return 'y';
}

/** The four pivots a walk is made of. Closed, because the renderer holds each by name. */
const MODEL_BONES = ['leftArm', 'rightArm', 'left', 'right'];

/**
 * Where a limb is hinged, read off the limb.
 *
 * An arm hangs down its own -y from a shoulder and a leg hangs down from a hip,
 * so the joint is the TOP of whatever is on the bone, centred on the rest of it.
 * Authoring the point instead was the alternative and it is the worse one: a
 * pivot is a number nobody looks at again, so a limb redrawn longer keeps
 * swinging about where the old one used to meet the body — which reads as the
 * arm being detached rather than as a stale constant.
 */
function jointOf(parts) {
  let x0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  let z0 = Infinity; let z1 = -Infinity;
  for (const p of parts) {
    const [sx, sy, sz] = p.scale ?? [0.3, 0.3, 0.3];
    const [px, py, pz] = p.pos ?? [0, 0, 0];
    x0 = Math.min(x0, px - sx / 2); x1 = Math.max(x1, px + sx / 2);
    y1 = Math.max(y1, py + sy / 2);
    z0 = Math.min(z0, pz - sz / 2); z1 = Math.max(z1, pz + sz / 2);
  }
  return [(x0 + x1) / 2, y1, (z0 + z1) / 2];
}

/**
 * The skeleton an authored model gets if — and only if — it asks for one.
 *
 * Same four pivots and the same two `userData` fields `crowdRig` writes, because
 * everything downstream reads them by name: `animateActors` runs the gait off
 * `walker`, `animateEmote` waves with it, and `syncKit` hangs a bag on `hold`.
 * All three are already guarded on it being absent, so a model that names no
 * bone is the group `buildModel` has always returned.
 *
 * All four pivots are built whenever any one of them is asked for, and the
 * unclaimed ones sit at the origin with nothing on them. `walker` is read as a
 * complete set — a bot with a skirt instead of legs would otherwise take the
 * gait's first write to `left.rotation` and take the room down.
 */
function buildRig(group, parts) {
  if (!parts.some((p) => p.bone)) return null;
  const pivots = new Map();
  for (const name of MODEL_BONES) {
    const own = parts.filter((p) => p.bone === name);
    const pivot = new THREE.Group();
    if (own.length) pivot.position.set(...jointOf(own));
    group.add(pivot);
    // Exactly minus the pivot, so anything parented here is positioned in
    // ordinary body coordinates and still swings from the shoulder. The same
    // trick `characterParts` calls `hold`, and the whole fix for a basket
    // hanging in mid-air beside the hand carrying it.
    const hold = new THREE.Group();
    hold.position.copy(pivot.position).negate();
    pivot.add(hold);
    pivots.set(name, { pivot, hold });
  }
  group.userData.walker = {
    left: pivots.get('left').pivot,
    right: pivots.get('right').pivot,
    leftArm: pivots.get('leftArm').pivot,
    rightArm: pivots.get('rightArm').pivot,
  };
  group.userData.hold = {
    left: pivots.get('leftArm').hold, right: pivots.get('rightArm').hold,
  };
  return { parentFor: (bone) => (bone ? pivots.get(bone).pivot : group) };
}

export function buildModel(model, {
  castShadow = true, t = 1, abuts = null, skin = null, alpha: ghost = 1,
} = {}) {
  const group = new THREE.Group();
  // Repainted and bolted-on before anything else looks at the list, so every
  // reader below — the seam test, the shadow rule, the mesh loop — sees the
  // parts as worn. A skin that only got applied at colour-setting time would
  // work until the first extra needed a shadow.
  const parts = skinnedParts(partsAt(model, t), skin);
  group.userData.moving = [];
  if (!parts.length) return group;

  const rig = buildRig(group, parts);

  for (const part of parts) {
    // A seam exists to close the end of a unit, and there is no end to close
    // where the next one along carries straight on. Dropping the panel is the
    // whole difference between a row of wall units and one long shelf.
    const seam = abuts && seamStep(part);
    if (seam && abuts(seam)) continue;

    const geo = GEO[part.shape] ?? GEO.box;
    const alpha = (part.alpha ?? 1) * ghost;
    const mesh = new THREE.Mesh(geo, material(part.color, alpha, part.glow));
    const [sx, sy, sz] = part.scale ?? [0.3, 0.3, 0.3];
    const [px, py, pz] = part.pos ?? [0, 0, 0];
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    mesh.rotation.y = ((part.rot ?? 0) * Math.PI) / 180;
    // Glass casts no shadow. A door you can see through laying down a solid
    // black rectangle is the giveaway that it isn't really glass.
    //
    // ...unless it asks to. `shadow` is the opt-in, and it exists because a
    // ceiling panel faded down to see the floor through takes its shadow with
    // it and stops being in the room. The shadow is full strength either way —
    // a depth pass has no opacity — so this is a choice between two wrong
    // answers rather than a dimmer. See the note in `shared/schemas.js`.
    mesh.castShadow = castShadow && (alpha >= 1 || part.shadow === true);
    mesh.receiveShadow = false;
    // A limb's boxes are authored in body coordinates like everything else, so
    // the joint's own offset comes back off them on the way into the pivot.
    // Written before `moving` records `pos`, or a motion part on an arm eases
    // back to a place measured in the wrong space.
    const home = rig ? rig.parentFor(part.bone) : group;
    if (home !== group) mesh.position.sub(home.position);
    home.add(mesh);
    if (part.motion) {
      group.userData.moving.push({
        mesh,
        motion: part.motion,
        // Where it was drawn, so the animator has somewhere to put it back and
        // a machine that stops stops in the pose it was authored in.
        pos: mesh.position.clone(),
        rot: mesh.rotation.y,
        scale: mesh.scale.clone(),
        // Which way a `sweep` turns, and about what. Both are measured here
        // rather than in the animator because this is the one place the part
        // still exists as authored numbers — a welded mesh has lost its scale.
        axis: turnAxis(part),
        // Where the hinge is, as an offset from the part's own middle, so the
        // animator can swing the mesh round it without a nested group per hand.
        // Null is "its own middle", which is every other kind of motion.
        arm: part.motion.pivot
          ? new THREE.Vector3(px, py, pz).sub(new THREE.Vector3(...part.motion.pivot))
          : null,
        pivot: part.motion.pivot ? new THREE.Vector3(...part.motion.pivot) : null,
        // Spread, so the three moving parts of one machine don't beat in
        // lockstep — the same trick the puffs and the angry shoppers use.
        phase: group.userData.moving.length * 0.41,
      });
    }
  }
  return group;
}

/** A stable number for cosmetic character variation; never touches game RNG. */
function characterVariant(seed) {
  let n = 2166136261;
  for (const ch of String(seed)) {
    n ^= ch.charCodeAt(0);
    n = Math.imul(n, 16777619);
  }
  return n >>> 0;
}


/**
 * A chunky, faceted person, shared by shoppers and the fallback player.
 *
 * Boxes, and that is the point rather than a simplification. Characters used to
 * be spheres in a smooth material while every prop in the shop is a flat-shaded
 * primitive with hard edges — so the people were the one thing on screen that
 * did not belong to their own game, and what that produces as a note is "the
 * art style doesn't fit", not "the shoppers are too round". A cube head over
 * square shoulders shares a vocabulary with the shelving, and it still holds a
 * silhouette at the eight pixels a shopper across the shop actually gets.
 *
 * Two axes of variation, and they do not compound. `look` is the AUTHORED one
 * (`ArchetypeSchema.look`) — a build and a hairstyle, so a Karen is a Karen in
 * every shop. `variant` is the hashed one, and it is what a row with no `look`
 * falls back to, so a database written before any of this existed still has a
 * varied crowd rather than a hundred identical people. Never the game RNG:
 * a cosmetic draw taken from `this.rng` would move every balance number
 * downstream of it (see `Game.namer` for the same argument about names).
 *
 * The head is deliberately left OUT of every weld. `animateMoods` swaps its
 * material to flush it, and a head merged into the torso would take the body
 * red with it.
 */
export function buildCharacter(color, opts = {}) {
  return assembleCharacter(characterParts(color, opts));
}

/**
 * The same person, as a LIST OF BOXES rather than as a scene graph.
 *
 * Every part of a character is a box — torso, limbs, head, eyes, hair, beard,
 * glasses — which is what makes a crowd batchable at all: one geometry, one
 * draw, a matrix and a colour per box. `Scene.Crowd` writes that; this says
 * what to write.
 *
 * It is the SAME function that builds the mesh version, and that is the whole
 * point of the shape rather than a tidiness. Ten hair styles, four beards and a
 * face are 280 lines of authored numbers, and a second copy of them for the
 * batch would be a crowd that slowly stops matching the fallback — a bug with
 * no error in it, found by somebody noticing that the person in first person
 * has different eyebrows. So `part()` is the one funnel every box already went
 * through, and all it does now is push a description instead of a mesh. Not a
 * line of the authoring below moved.
 *
 * A `sink` is what a Group was: somewhere to put boxes. It carries the BONE it
 * rides (the body, or one of the four limb pivots) and whether the boxes in it
 * may be welded together in the mesh path — the head may not, because
 * `animateMoods` flushes it by swapping its material, and a head merged into
 * its own eyebrows would take them red with it.
 */
/**
 * HOW TALL A PERSON IS, crown to floor, in tiles. Everybody: you, the crew and
 * the crowd.
 *
 * The one number, because everything else about a body's size is a ratio hung
 * off it — a build, the jitter, the ring over a head, first person's eye. It was
 * not a number at all until the walls grew: the scale line below read `1.18` and
 * the top of a head landed wherever the authored boxes happened to put it
 * (0.944), which is fine while nothing it stands next to moves and is exactly
 * the trap `setEdgeGhost` fell into on the same day. `WALL_H` went to 2.1 and
 * `HEAD_ROOM` stayed at 1.6, so a shopper walked through a doorway more than
 * half again their own height — and what that reads as is a shop built for
 * giants, or, in first person, being a child in one.
 *
 * 1.18 is 74% of the way through an opening (`HEAD_ROOM`, 1.6), against about
 * 86% for a real person and a real door — so this is most of the way back
 * rather than all of it, and WHAT SETS THE CEILING IS HAIR. A body is not the
 * tallest thing about a person: the `tall` build wearing a mohawk stands 1.45x
 * a regular one bare, so the figure that has to clear a lintel is that one and
 * not this. At 1.28 — which is where the honest 80% landed, and which is within
 * a hair of the 1.32 `HEAD_ROOM`'s own note has claimed a character stands at
 * since before either was a constant — a mohawk came through the header at 1.71
 * and the shop read as having been built wrong. Raise this and check the same
 * pair, or the bug is one shopper in seventy, only in a doorway.
 *
 * Short of the door is right anyway: the crowd is read at a glance from across
 * the room, and a head that nearly touches every lintel it passes under reads as
 * *cramped* rather than as correct. This is a shop, and headroom you can see is
 * part of what makes it one.
 *
 * `PERSON_ART_H` is the envelope every box below is authored inside and is a
 * MEASUREMENT rather than a choice — the head's top face sits exactly there. Move
 * a hat above it and this is the line that has to know.
 *
 * `PERSON_STRETCH` is the look: a shade taller than the boxes are drawn, kept
 * separate so growing everybody preserves the proportion rather than squashing
 * it. Both axes scale together — a person is bigger, not stretched — which is
 * also what keeps a crate on a shoulder the right size for the shoulder.
 */
export const PERSON_H = 1.18;
const PERSON_ART_H = 0.8;
const PERSON_STRETCH = 1.18;
const PERSON_SIZE = PERSON_H / (PERSON_ART_H * PERSON_STRETCH);

export function characterParts(color, { hat = null, variant = '', varied = false, look = null } = {}) {
  const variation = characterVariant(variant || color);
  const parts = [];
  const bones = [];
  // Somewhere to put boxes, which is all a Group ever was here. `weld` is the
  // batch it merges into in the mesh path, and `null` means "on its own".
  const sink = (bone, weldId) => ({ bone, weldId });
  const bone = (name, pivot, hold = null) => {
    bones.push({ name, pivot, hold });
    return sink(name, `limb:${name}`);
  };
  const body = sink('body', null);

  const build = BUILDS[look?.build] ?? BUILDS.regular;
  /*
   * A hair's-breadth of size jitter on top of the build, so a queue of four
   * Budget Parents is not four traced copies. It is small on purpose: the
   * build is what the player is meant to read, and a big jitter would blur
   * `slight` into `stout` until neither means anything.
   *
   * Multiplied INTO the build rather than added beside it, and the build
   * REPLACES the old hashed height/weight rather than scaling it — stacked,
   * a tall row and a tall hash came out at 1.53 and the ring the client floats
   * over a head (`RING_Y`) is placed against a fixed envelope.
   */
  const jitter = varied ? 0.96 + (variation % 5) * 0.02 : 1;
  const size = jitter * PERSON_SIZE;
  const scale = [build.w * size, PERSON_STRETCH * build.h * size, build.w * size];

  // One box. Same four arguments it has always taken, and `into` is a sink
  // where it used to be a Group — which is why nothing below this line changed.
  const part = (into, colour, boxScale, position, { shadow = true, rot = null } = {}) => {
    const i = parts.length;
    parts.push({
      bone: into.bone, weldId: into.weldId,
      colour, scale: boxScale, position, rot: rot ?? null, shadow,
    });
    return i;
  };

  /*
   * An OUTFIT, derived rather than authored.
   *
   * Every limb used to be bare `FACE_CALM` from shoulder to shoe, so a shopper
   * was a coloured mass with four cream noodles hanging off it: the outfit was
   * the torso and nothing else, and skin — the one colour every single person
   * in the shop shares — was the largest thing about them after their body.
   * Sleeves and trousers put the archetype's colour around the whole mass and
   * leave skin at the hand and the face, and the three-band read (shirt,
   * trousers, shoes) is most of what makes a stack of boxes look dressed.
   *
   * `shade` of the body colour rather than columns on the row, so a customer
   * type invented tomorrow is dressed the moment it exists. The day somebody
   * wants trousers that DISAGREE with the shirt, that is a field on the
   * archetype next to `color`, not a second argument here.
   *
   * Skin is deliberately NOT authorable. `animateMoods` overwrites it from
   * `FACE_RAMP` — which starts at `FACE_CALM` — on every shopper with a
   * patience number, so an authored tone would be stomped on the first frame
   * and read as the field doing nothing.
   */
  const trouser = shade(color, -0.34);
  const shoe = shade(color, -0.62);

  /*
   * The mass, as two boxes with a step between them.
   *
   * A single box is a fridge — every silhouette it can make is the same
   * silhouette at a different scale. A chest sat proud of a narrower waist
   * gives the shoulders a hard corner to be read at, which is the one place a
   * build's numbers actually show from across the shop.
   *
   * Welded: `weld` bakes the hue into the vertices, so a multi-colour group is
   * still one mesh and none of the banding below costs a draw.
   */
  const torso = sink('body', 'torso');
  part(torso, trouser, [0.33 * build.belly, 0.15, 0.23], [0, 0.325, 0]);
  part(torso, color, [0.38 * build.shoulder, 0.17, 0.25], [0, 0.465, 0.005]);

  /*
   * An arm is a pivot at the shoulder with two boxes hanging off it, and a
   * THIRD child that has no geometry at all.
   *
   * `hold` is a group whose offset is exactly minus the pivot's, so its own
   * origin lands back on the body's. Anything parented to it is positioned in
   * ordinary body coordinates — the numbers a kit is authored in — and yet
   * rotates about the SHOULDER when the arm swings. That is the whole fix for
   * a bag hanging in mid-air while the hand carrying it walks through it: the
   * two are now one rigid thing. Nothing else has to know it exists, and a
   * container held in front with both hands (a basket, a trolley) simply
   * stays on the body — see `syncKit`.
   *
   * The shoulder rides OUT with the build, or a buff character's arms hang
   * through his own chest.
   */
  const armX = 0.19 * build.shoulder + 0.03;
  const arm = (x, name) => {
    const limb = bone(name, [x, 0.50, 0.01], [-x, -0.50, -0.01]);
    // Sleeve, then hand. The arm wants to be a stub against that much body,
    // not a limb that reaches anything.
    part(limb, color, [0.095, 0.155, 0.11], [0, -0.07, 0]);
    part(limb, FACE_CALM, [0.09, 0.075, 0.10], [0, -0.183, 0.004]);
  };
  arm(-armX, 'leftArm');
  arm(armX, 'rightArm');
  // Two tiny hip pivots are the rest of the walk rig. They are built once with
  // the body, then the renderer only writes four rotations while somebody
  // moves — no skinned mesh, cloning or scene traversal per frame.
  const leg = (x, name) => {
    const limb = bone(name, [x, 0.28, 0.01]);
    // Trouser, then shoe. A bare thigh was the other half of the noodle read,
    // and it is the worse half: legs are what a crowd is seen THROUGH at this
    // camera, so forty shoppers meant eighty cream posts on the shop floor.
    part(limb, trouser, [0.125, 0.21, 0.135], [0, -0.105, 0]);
    part(limb, shoe, [0.145, 0.065, 0.185],
      [x < 0 ? 0.008 : -0.008, -0.238, 0.022]);
  };
  leg(-0.10, 'left');
  leg(0.10, 'right');

  /*
   * A cube head sat straight on the shoulders. No neck, and no jowl either —
   * the roll under the chin existed to stop two spheres reading as a head on a
   * stick, and a box with a flat bottom on a box with a flat top has nothing
   * to hide.
   *
   * Its own mesh, never welded: `animateMoods` flushes the head by swapping
   * this material. `skin` stays a LIST because that is what the caller reads
   * and a future face part may want to flush with it.
   */
  const head = part(body, FACE_CALM, [0.26, 0.21, 0.24], [0, 0.655, 0.01]);

  /*
   * Everything that decorates the head, welded into ONE non-casting mesh.
   *
   * Face, hair, beard and whatever is worn on the face all land in `trim` and
   * merge together. They can, because `weld` bakes the hue into the vertices —
   * so a group of nine boxes in six colours is still one draw, and the only
   * thing that would split it is a material that shades differently (glass, a
   * different flat-shading flag) or a mesh that casts a shadow when its
   * neighbours do not. None of these do: nothing on a person casts, because the
   * body already does and a floating shadow of a moustache is litter.
   *
   * Four groups is what this was, and at forty shoppers that is a hundred and
   * twenty draws for no picture at all. The head itself stays OUT, and that one
   * is not an oversight: `animateMoods` flushes it by swapping its material, and
   * a head merged into its own eyebrows would take them red with it.
   *
   * Every number is placed against the head's own box — half-extents
   * 0.13 / 0.105 / 0.12 about (0, 0.655, 0.01), so its front face is at
   * z = 0.13 — rather than guessed. A box makes this the easy half: unlike the
   * sphere this replaced, the surface is flat, so a feature is proud of it by
   * whatever you add to 0.13 and nothing sinks at the edges.
   *
   * The whites are the point. Two dark dots is a button-eyed toy; a panel of
   * sclera with a pupil sitting proud of it is a face. Brows are what make it
   * capable of an expression at all, and `face` below is what finally asks
   * them to — see render/face.js.
   *
   * The seven indices are handed back for the reason `head` is: in the batch
   * there is no mesh to give anybody, so a caller that wants to move an eyebrow
   * gets the SLOT it lives in. They are collected as they are authored rather
   * than counted afterwards, because a part inserted above this block would
   * silently shift every hardcoded index by one and what that draws is a
   * shopper blinking with their hair.
   *
   * Order within the group is not what puts a fringe over an eye or a nose over
   * a face — these are opaque boxes and the depth buffer settles it, so what
   * decides is the z each one is authored at. Worth saying because the parts
   * below READ as though they were layered.
   */
  const trim = sink('body', 'trim');
  const face = { eyes: [], pupils: [], brows: [], mouth: -1 };
  for (const s of [-1, 1]) {
    face.eyes.push(
      part(trim, '#fdfaf4', [0.058, 0.062, 0.02], [s * 0.058, 0.672, 0.132], { shadow: false }));
    face.pupils.push(
      part(trim, '#2b323b', [0.032, 0.038, 0.02], [s * 0.060, 0.670, 0.142], { shadow: false }));
    face.brows.push(
      part(trim, '#6d5a4a', [0.062, 0.015, 0.02],
        [s * 0.060, 0.716, 0.136], { shadow: false, rot: [0, 0, s * -0.16] }));
  }
  face.mouth = part(trim, '#95604f', [0.062, 0.018, 0.02], [0, 0.606, 0.134], { shadow: false });

  /*
   * Hair, which is the whole silhouette.
   *
   * At the eight pixels a shopper across the shop gets, a build says big or
   * small and the hair says WHO — so this is the half a Karen, an emo and a
   * buff guy are actually told apart by, and it is why the vocabulary is closed
   * rather than a model: the renderer has to know how to sit a shape on a head
   * that changes width with the build, and a parts blob could not be asked.
   *
   * The player keeps the cap their caller asked for. A shopper with no `look`
   * takes a hashed one, so a database with nothing authored still has a crowd.
   */
  const hairColor = hat ?? look?.hair_color ?? STOCK_HAIR_COLOR[variation % 5];
  const style = hat ? 'cap' : (look?.hair ?? STOCK_HAIR[variation % STOCK_HAIR.length]);
  // Everything below sits on a head whose top is 0.76 and whose front is 0.13.
  // A slab across the crown is the common half of every style bar `none`.
  const crown = (h = 0.055, y = 0.7725) =>
    part(trim, hairColor, [0.275, h, 0.255], [0, y, 0.01], { shadow: false });
  /**
   * The back of the head, which every long style needs and none of them had.
   *
   * The crown is a slab across the TOP and the side panels hang past the ears,
   * so between them — below the crown, between the two sides, at z = -0.11 —
   * the head box was simply bare. From in front that is invisible, which is why
   * it shipped; the moment a shopper turns round they have a bald patch from
   * the crown down to the nape, in skin rather than in hair, and what it reads
   * as is the head poking THROUGH the hair.
   *
   * It is only ever the long styles. A crop, a bun and spikes are short, so a
   * head visible below the crown is what a short haircut looks like — filling
   * those in would be putting long hair on everybody.
   *
   * `y` and `h` are handed in rather than derived, because each style's sides
   * hang to their own depth and a nape that stopped short of them is the same
   * gap moved down half a centimetre.
   */
  const nape = (h, y) =>
    part(trim, hairColor, [0.275, h, 0.05], [0, y, -0.108], { shadow: false });
  if (style === 'crop') {
    crown();
  } else if (style === 'bob') {
    crown();
    // Down past the ears on both sides, square-cut. The side panels are what
    // read at distance; the crown alone is a swimming cap.
    for (const s of [-1, 1]) {
      part(trim, hairColor, [0.045, 0.20, 0.255], [s * 0.135, 0.685, 0.01], { shadow: false });
    }
    nape(0.20, 0.685);
  } else if (style === 'swept') {
    // The Karen. Asymmetric on purpose — one side clipped short, the other
    // swept out and forward over the brow. Symmetry is what makes every other
    // style read as "a haircut"; this one reads as an OPINION, and that is the
    // whole brief.
    crown(0.075, 0.7825);
    part(trim, hairColor, [0.05, 0.13, 0.255], [-0.135, 0.735, 0.01], { shadow: false });
    part(trim, hairColor, [0.075, 0.235, 0.265], [0.145, 0.675, 0.01],
      { shadow: false, rot: [0, 0, 0.22] });
    part(trim, hairColor, [0.13, 0.075, 0.075], [0.07, 0.782, 0.115],
      { shadow: false, rot: [0, 0, 0.30] });
    // To the shorter of the two sides, or the nape is longer than the clipped
    // side and the asymmetry — the whole point of this one — reads as a mistake
    // from behind.
    nape(0.13, 0.735);
  } else if (style === 'fringe') {
    // The emo. A long slab hanging off the crown and across one eye — the
    // asymmetry again, and the reason the eyes are drawn before this is that
    // the fringe is meant to COVER one of them.
    crown(0.07, 0.78);
    part(trim, hairColor, [0.175, 0.155, 0.055], [-0.045, 0.712, 0.145],
      { shadow: false, rot: [0, 0, -0.20] });
    for (const s of [-1, 1]) {
      part(trim, hairColor, [0.045, 0.165, 0.255], [s * 0.135, 0.70, 0.01], { shadow: false });
    }
    nape(0.165, 0.70);
  } else if (style === 'spikes') {
    crown(0.045, 0.7675);
    for (let i = 0; i < 4; i += 1) {
      const x = -0.09 + i * 0.06;
      part(trim, hairColor, [0.05, 0.085, 0.05], [x, 0.822, 0.01 + (i % 2) * 0.05],
        { shadow: false, rot: [0, 0, (i % 2 ? 1 : -1) * 0.26] });
    }
  } else if (style === 'bun') {
    crown();
    part(trim, hairColor, [0.115, 0.10, 0.115], [0, 0.845, -0.02], { shadow: false });
  } else if (style === 'cap') {
    crown(0.075, 0.7825);
    // A peak, which is the one piece of headwear that reads from behind as
    // well as in front, because it breaks the box's outline.
    part(trim, hairColor, [0.20, 0.028, 0.10], [0, 0.762, 0.175], { shadow: false });
  } else if (style === 'beanie') {
    // Pulled down over the ears, and stopping ABOVE the brows: a rim across
    // somebody's eyebrows is a hat that has been yanked over their face.
    part(trim, hairColor, [0.285, 0.135, 0.265], [0, 0.752, 0.01], { shadow: false });
    part(trim, shade(hairColor, -0.18), [0.29, 0.035, 0.27], [0, 0.695, 0.01], { shadow: false });
  } else if (style === 'puffs') {
    // The clown. Bald on top with a puff over each ear, which is the one
    // silhouette in the list that is mostly EMPTY — and that is why it reads
    // from across the shop, because nothing else here has a gap in it.
    for (const s of [-1, 1]) {
      part(trim, hairColor, [0.115, 0.145, 0.19], [s * 0.165, 0.715, 0.01], { shadow: false });
      part(trim, hairColor, [0.075, 0.09, 0.13], [s * 0.20, 0.775, 0.01], { shadow: false });
    }
  } else if (style === 'mohawk') {
    // A single fin, front to back. Deliberately taller than it is wide: at this
    // camera a low ridge reads as a badly-fitted cap.
    part(trim, hairColor, [0.05, 0.155, 0.265], [0, 0.825, 0.01], { shadow: false });
    part(trim, shade(hairColor, -0.25), [0.245, 0.035, 0.25], [0, 0.762, 0.01], { shadow: false });
  } else if (style === 'hardhat') {
    // Headwear rather than hair, and it shares the slot on purpose — see
    // `CHARACTER_HAIRS`, which is really "what is on top of the head". The brim
    // runs the whole way round, which is what stops it reading as a cap.
    part(trim, hairColor, [0.245, 0.115, 0.225], [0, 0.79, 0.01], { shadow: false });
    part(trim, hairColor, [0.315, 0.03, 0.295], [0, 0.742, 0.01], { shadow: false });
    part(trim, shade(hairColor, -0.22), [0.045, 0.13, 0.23], [0, 0.80, 0.01], { shadow: false });
  }

  /*
   * A beard, in the hair's own colour.
   *
   * Its own group rather than more entries in the style list above, because it
   * is a different part of the head — see `CHARACTER_BEARDS`. Every shape here
   * hangs off the bottom front of the head box (its underside is 0.55, its
   * front 0.13) and stops short of the mouth at 0.606 where it should, or the
   * character is eating it.
   */
  const chin = look?.beard ?? 'none';
  if (chin === 'stubble') {
    part(trim, shade(hairColor, 0.10), [0.20, 0.055, 0.02], [0, 0.578, 0.133], { shadow: false });
  } else if (chin === 'moustache') {
    part(trim, hairColor, [0.105, 0.028, 0.025], [0, 0.632, 0.135], { shadow: false });
  } else if (chin === 'goatee') {
    part(trim, hairColor, [0.105, 0.028, 0.025], [0, 0.632, 0.135], { shadow: false });
    part(trim, hairColor, [0.062, 0.075, 0.028], [0, 0.575, 0.133], { shadow: false });
  } else if (chin === 'full') {
    // The lumberjack. It hangs BELOW the head, which is the whole read: a beard
    // contained inside the face box is a brown patch, and a beard that breaks
    // the chin line is a beard.
    part(trim, hairColor, [0.225, 0.105, 0.055], [0, 0.572, 0.118], { shadow: false });
    part(trim, hairColor, [0.165, 0.075, 0.05], [0, 0.512, 0.112], { shadow: false });
    part(trim, hairColor, [0.105, 0.028, 0.025], [0, 0.636, 0.136], { shadow: false });
  }

  /*
   * One thing on the face — and it is drawn AFTER the eyes on purpose, because
   * every entry is something that sits over them.
   */
  const worn = look?.face ?? 'none';
  if (worn === 'glasses' || worn === 'shades') {
    const lens = worn === 'shades' ? '#22242c' : '#cfe6ee';
    const rim = worn === 'shades' ? '#22242c' : '#6b6257';
    for (const s of [-1, 1]) {
      part(trim, lens, [0.078, 0.062, 0.012], [s * 0.058, 0.672, 0.142], { shadow: false });
    }
    // A bridge and two arms. The arms are what make a pair of glasses read as
    // worn rather than painted on, because they carry round the side of a head
    // the camera can see two faces of.
    part(trim, rim, [0.04, 0.012, 0.012], [0, 0.672, 0.142], { shadow: false });
    for (const s of [-1, 1]) {
      part(trim, rim, [0.012, 0.012, 0.10], [s * 0.128, 0.674, 0.088], { shadow: false });
    }
  } else if (worn === 'nose') {
    part(trim, '#d8392f', [0.055, 0.055, 0.045], [0, 0.641, 0.146], { shadow: false });
  }
  // `head` is an INDEX rather than a mesh, because in the batch there is no
  // mesh to hand back — `animateMoods` recolours one instance. The mesh path
  // turns it back into an object below. `face` is six more of the same, and
  // only the batch can use them: the mesh path WELDS `trim` into a single
  // object, so there is nothing left in there to move an eyebrow of.
  return { scale, parts, bones, head, face };
}

/**
 * The description, as the scene graph it has always been.
 *
 * This is the fallback and it is not dead code: it draws you in first person,
 * anybody whose kind has no authored model, and every character the palette
 * and the roster tiles draw at thumbnail size. It is also what the batch is
 * checked against — the two must agree, which is why they share the authoring
 * above rather than the output.
 *
 * The welds are the same welds, and so is what is left out of them: parts sharing
 * a `weldId` merge, `null` stands alone. Which is the head, for the reason
 * `characterParts` gives.
 */
function assembleCharacter({ scale, parts, bones, head }) {
  const g = new THREE.Group();
  g.scale.set(...scale);

  const pivots = new Map();
  for (const b of bones) {
    const pivot = new THREE.Group();
    pivot.position.set(...b.pivot);
    g.add(pivot);
    const rec = { pivot, hold: null };
    if (b.hold) {
      const hold = new THREE.Group();
      hold.position.set(...b.hold);
      pivot.add(hold);
      rec.hold = hold;
    }
    pivots.set(b.name, rec);
  }

  const groups = new Map();
  const parentOf = (bone) => (bone === 'body' ? g : pivots.get(bone).pivot);
  let headMesh = null;
  parts.forEach((p, i) => {
    const mesh = new THREE.Mesh(CHARACTER_GEO.box, characterMaterial(p.colour));
    mesh.scale.set(...p.scale);
    mesh.position.set(...p.position);
    if (p.rot) mesh.rotation.set(...p.rot);
    mesh.castShadow = p.shadow;
    if (i === head) headMesh = mesh;
    if (p.weldId == null) { parentOf(p.bone).add(mesh); return; }
    let grp = groups.get(p.weldId);
    if (!grp) { grp = { bone: p.bone, g: new THREE.Group() }; groups.set(p.weldId, grp); }
    grp.g.add(mesh);
  });
  for (const { bone, g: grp } of groups.values()) parentOf(bone).add(weld(grp));

  g.userData.walker = {
    left: pivots.get('left').pivot,
    right: pivots.get('right').pivot,
    leftArm: pivots.get('leftArm').pivot,
    rightArm: pivots.get('rightArm').pivot,
  };
  g.userData.hold = { left: pivots.get('leftArm').hold, right: pivots.get('rightArm').hold };
  g.userData.head = headMesh;
  g.userData.skin = [headMesh];
  return g;
}

/**
 * The same rig with NO MESHES IN IT — the half of a body that has to be objects.
 *
 * A crowd is drawn out of one instanced batch (`CrowdBatch` in scene.js), so a
 * shopper's twenty boxes stop being twenty meshes in the scene graph. What
 * cannot stop being objects is the skeleton, and the reason is that the rest of
 * the renderer holds references INTO it: `animateActors` writes four pivot
 * rotations to run the walk, `syncKit` and `syncCarry` parent a basket or an
 * armful onto a `hold` group so it swings with the shoulder, and `animateRest`
 * tilts the root. Those are five objects a person, against twenty meshes plus
 * their groups — and the five cost nothing to draw, because there is nothing on
 * them to draw.
 *
 * `head` and `skin` are deliberately EMPTY rather than absent. `animateMoods`
 * flushes a face by swapping the head mesh's material, and there is no head
 * mesh here — the batch owns that colour and is written directly. An empty list
 * is what makes the old loop a no-op instead of a crash, and the mood is
 * applied by the caller that knows about the batch.
 */
export function crowdRig({ scale, bones }) {
  const g = new THREE.Group();
  g.scale.set(...scale);
  const pivots = new Map();
  for (const b of bones) {
    const pivot = new THREE.Group();
    pivot.position.set(...b.pivot);
    g.add(pivot);
    let hold = null;
    if (b.hold) {
      hold = new THREE.Group();
      hold.position.set(...b.hold);
      pivot.add(hold);
    }
    pivots.set(b.name, { pivot, hold });
  }
  g.userData.walker = {
    left: pivots.get('left').pivot,
    right: pivots.get('right').pivot,
    leftArm: pivots.get('leftArm').pivot,
    rightArm: pivots.get('rightArm').pivot,
  };
  g.userData.hold = { left: pivots.get('leftArm').hold, right: pivots.get('rightArm').hold };
  g.userData.head = null;
  g.userData.skin = [];
  g.userData.pivots = pivots;
  return g;
}

/**
 * Where each box sits relative to the body, once, so the batch never rebuilds it.
 *
 * A part's place is fixed for the life of the character — only the BONE it
 * hangs off moves — so the matrix from the bone's space to the box is computed
 * here and multiplied by the bone's world matrix every frame. That is one
 * multiply per box per frame against composing position, rotation and scale
 * from scratch three thousand times a second.
 */
export function crowdLocals({ parts }) {
  return parts.map((p) => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (p.rot) q.setFromEuler(new THREE.Euler(...p.rot));
    m.compose(
      new THREE.Vector3(...p.position), q, new THREE.Vector3(...p.scale),
    );
    return m;
  });
}

/**
 * How big the body is, measured off the DESCRIPTION rather than off meshes.
 *
 * `bodyExtent` in scene.js does this with `Box3.setFromObject`, which needs
 * something to be in the scene graph — and a batched body deliberately has
 * nothing. It is the same box by construction: every corner of every part
 * through that part's own matrix, which is what `setFromObject` does, so a
 * rotated fringe or a tilted hair spike widens it exactly as it did.
 *
 * It matters more than it looks. `pickPerson` aims at this: `halfW` is the grab
 * radius and `footY`/`headY` are the spine it measures the pointer against, so
 * a body that reported the fallback box would be a shopper who is harder to
 * click on the fatter they are.
 */
export function crowdExtent({ scale, parts, bones }) {
  const pivotOf = (name) => (name === 'body'
    ? [0, 0, 0]
    : (bones.find((b) => b.name === name)?.pivot ?? [0, 0, 0]));
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (const p of parts) {
    const o = pivotOf(p.bone);
    if (p.rot) q.setFromEuler(new THREE.Euler(...p.rot)); else q.identity();
    m.compose(
      new THREE.Vector3(o[0] + p.position[0], o[1] + p.position[1], o[2] + p.position[2]),
      q, new THREE.Vector3(...p.scale),
    );
    for (let i = 0; i < 8; i++) {
      v.set((i & 1 ? 0.5 : -0.5), (i & 2 ? 0.5 : -0.5), (i & 4 ? 0.5 : -0.5))
        .applyMatrix4(m)
        .multiply(new THREE.Vector3(...scale));
      box.expandByPoint(v);
    }
  }
  return {
    footY: Math.min(box.min.y, 0),
    headY: Math.max(box.max.y, 0.4),
    halfW: Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 0.3) / 2,
  };
}

/**
 * The one geometry and the one material every batched body is drawn with.
 *
 * A unit box, because every part of a character already is one — that is what
 * makes this batchable at all rather than a rewrite of the art.
 *
 * The white `color` attribute is the non-obvious half and it is a three.js
 * trap: an instance colour is folded into `vColor` in the vertex shader only
 * when `USE_INSTANCING_COLOR` is defined, but `color_fragment` multiplies
 * `diffuseColor` by `vColor` only under `USE_COLOR` — which comes from
 * `vertexColors`. So an InstancedMesh with `setColorAt` and no vertex colours
 * draws every instance BLACK, and one with `vertexColors` and no `color`
 * attribute reads a missing attribute as zero and draws black as well. White
 * vertices plus `vertexColors` is what makes `vColor` land on 1.0 and the
 * instance colour be the whole of it.
 *
 * `batchMaterial` is reused rather than cloned by hand so a batched body shades
 * identically to a welded prop — it is the same cache, keyed on the same
 * shading properties.
 */
let crowdAssets = null;
export function crowdBatchAssets() {
  if (!crowdAssets) {
    const geometry = CHARACTER_GEO.box.clone();
    fillColor(geometry, new THREE.Color(1, 1, 1));
    crowdAssets = { geometry, material: batchMaterial(characterMaterial('#ffffff')) };
  }
  return crowdAssets;
}

/**
 * Anything with wheels — the delivery lorry, a shopper's car — drawn from its
 * own `vehicles` row.
 *
 * There is deliberately almost nothing in here. A vehicle is authored content
 * in the same shape a worker and a fixture are, so what one looks like comes
 * out of `buildModel` and `shared/model.js` like everything else, and this
 * function adds exactly two things a caller would otherwise have to remember.
 *
 * The first is `t`, which is **how loaded it is** — the one 0..1 number a
 * staged model wants, the same number a crop passes as growth and a break
 * passes as progress. So a van that drives in with a full bed and pulls away
 * with an empty one is three authored stages and no code in here that knows
 * what a crate is. An unstaged model (every car so far) ignores it.
 *
 * The second is the fallback: no art means a plain block rather than an empty
 * group. See `VEHICLE_LOOK` for why that matters more for a van than it does
 * for a fixture.
 *
 * No headlamps, and that is a rule rather than an omission. If a vehicle wants
 * them they are parts on the row, the way `shopper-car` already has a pale nub
 * on its nose — and they are painted, never lit. `client/render/lights.js`
 * keeps a fixed pool of eight real lights and aims it at emitters standing in
 * the *layout*; a vehicle is not in the layout and `VehicleSchema` has no
 * `emits`, so there is no way to author one that costs the scene a light. Worth
 * saying out loud because headlights are the obvious thing to reach for, and
 * three.js forward-renders every light against every fragment: two of them per
 * lorry is a multiplier on the whole shop for a thing that is on screen for
 * six seconds.
 */
export function buildVehicle(model, { t = 1 } = {}) {
  const g = buildModel(model, { t });
  if (g.children.length) return g;

  const body = new THREE.Mesh(GEO.box, material(VEHICLE_LOOK.color));
  body.scale.set(VEHICLE_LOOK.l, VEHICLE_LOOK.h, VEHICLE_LOOK.w);
  // Standing on the ground, like every authored model — see `buildModel`, which
  // every vehicle is drawn by when there is art. A block that floated would be
  // a fallback that also has to be positioned differently by whoever draws it.
  body.position.y = VEHICLE_LOOK.h / 2;
  body.castShadow = true;
  // Length along x, because a model is authored nose-east and whoever turns
  // this is turning it by the same rule. A fallback pointing the other way
  // would drive sideways, which is a bug in the fallback that reads as a bug
  // in the route.
  g.add(body);
  return g;
}

/**
 * The little floating bubble above a customer showing what they're after,
 * above a player showing what they're carrying, and over a bare board showing
 * what it is waiting for.
 *
 * The look is the original one, restored. It was rebuilt once — icon in front
 * of the shell, unlit dark badge, `modelExtent` fitting each item to fill it —
 * on the argument that a translucent shell painted over its own subject and
 * that one fixed scale suits no item. Every word of that is true and it came
 * out worse in the hand: a solid badge is a hard-edged sticker floating over a
 * soft-shaded shop, and an icon sized to fill it is a lump rather than a
 * glance. What reads is a small thing in a soft bubble.
 *
 * Left here because the reasoning is worth not repeating: if this is picked up
 * again, the thing to change is the ART — a flat sprite of the same 2D item
 * drawing the HUD uses — not the size of a model in a ball.
 *
 * Pass the model and it builds the icon; pass nothing for a bubble with a
 * thought and no subject. That much of the rebuild stays, because two callers
 * measuring an item two ways is two badges that disagree about how big a
 * tomato is.
 */
export function buildBubble(model = null) {
  const g = new THREE.Group();
  // Translucent, and big enough to hold the icon. It used to be an opaque
  // sphere smaller than the thing inside it, so every shopper walked around
  // with an item clipping through a solid white ball.
  const shell = new THREE.Mesh(GEO.sphere, bubbleMaterial());
  shell.scale.set(0.52, 0.44, 0.52);
  shell.renderOrder = 1;
  g.add(shell);

  // Two little trailing dots, so it reads as a thought rather than a balloon.
  for (let i = 0; i < 2; i++) {
    const dot = new THREE.Mesh(GEO.sphere, bubbleMaterial());
    const s = 0.12 - i * 0.04;
    dot.scale.setScalar(s);
    dot.position.set(-0.16 - i * 0.1, -0.3 - i * 0.12, 0.16 + i * 0.1);
    g.add(dot);
  }

  if (model) {
    const icon = buildModel(model, { castShadow: false });
    // Sized to sit *inside* the shell rather than burst out of it.
    icon.scale.setScalar(0.52);
    icon.position.y = -0.17;
    g.add(icon);
  }

  g.position.y = 1.32;
  // The shell is a sphere and could not care less, but the two trailing dots
  // are placed off one shoulder to read as a thought coming *from* whoever is
  // under it. Left alone they trail off the front of a shopper's face as soon
  // as you turn the view.
  faceCam(g);
  return g;
}

let bubbleMat = null;
function bubbleMaterial() {
  if (!bubbleMat) {
    bubbleMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5,
      depthWrite: false, flatShading: true,
    });
  }
  return bubbleMat;
}

/** A stack of item props on a flat top — more units means a taller pile. */
export function buildStack(model, qty, max) {
  const g = new THREE.Group();
  const rows = Math.min(3, Math.max(1, Math.ceil((qty / Math.max(max, 1)) * 3)));
  for (let i = 0; i < rows; i++) {
    const one = buildModel(model);
    one.position.set((i % 2) * 0.22 - 0.11, i * 0.2, ((i % 3) - 1) * 0.14);
    one.scale.setScalar(0.7);
    g.add(one);
  }
  return g;
}

/**
 * Slots across one shelf board. Three read as a row of goods, not a pair.
 *
 * ...and four read as a shop. Three was sized against goods drawn at 0.6, and
 * the pair moved together when the crate got scaled down — see `GOODS_SCALE`.
 * What it buys is not tidiness: `shelfShow` scales a quantity into the slots it
 * has, so slots are the ceiling on how much of a shelf's stock the picture is
 * able to admit to, and under it a well-stocked unit draws a *fraction* of
 * itself and reads as one nobody has filled.
 */
const PER_ROW = 4;

/**
 * And rows back into it. A board is most of a tile deep and was using a
 * fourteenth of that, because one row is all a unit holding one thing ever
 * needed. Depth is what lets the picture keep the promise below: a shelf
 * kept for one kind gets three boards, and `3 × 4 × 2` is twenty-four, which is
 * more than any shipped item's stack. So sixteen carrots draw sixteen carrots
 * rather than a ceiling, and the number in the menu is a thing you can count.
 *
 * Left at two while the row went to four, and that is the camera rather than a
 * lack of nerve: the rows behind the front one are spread over a fixed 0.56 of
 * the board's depth however many there are, so a third row does not go further
 * back — it goes in BETWEEN, at two thirds of the step, into goods that already
 * overlap on purpose. Depth here is read as "there is more behind", and three
 * rows of it is the same reading with the back two mashed together.
 */
const PER_DEEP = 2;

/**
 * How big a unit of stock is drawn on a board.
 *
 * Down 15% from 0.6, alongside the crate and for the same reason — see `CRATE`.
 * It is a named number rather than a literal at the one call site because it
 * only means anything against `PER_ROW`: the pitch across a board is a share of
 * the board, so shrinking the goods without widening the row draws the same
 * shelf with gaps in it, and widening the row without shrinking the goods draws
 * four things where three fitted. Either half alone is worse than neither.
 */
const GOODS_SCALE = 0.51;

/** Slots on one board — see `PER_DEEP`. */
const PER_BOARD = PER_ROW * PER_DEEP;

/** Past this a shelf just reads as full — see `shelfSlots`. */
export const shelfSlots = (surfaces) => (surfaces?.length ?? 0) * PER_BOARD;

/**
 * How many facings a quantity is worth on the boards it has been given.
 *
 * **A facing is one unit, not a bundle.** `stack` on an item is how many of
 * the thing a unit holds — three cheese wheels, sixteen carrots — and a
 * shopper takes one off, so a count you can do by eye is the whole point of
 * drawing them at all. Every shipped item's stack fits in the slots its share
 * of a shelf has, so this is one-to-one in practice.
 *
 * It scales rather than clamps where it can't be: a tier that multiplies
 * capacity can put more units on a board than there is room to draw, and eight
 * of thirty-two has to look like a quarter rather than like full. That is a
 * concession to the art, the same one a crowded plot makes at `BED_MAX`, and
 * it is bounded by the item's own stack rather than by a number in here.
 *
 * Anything on it at all draws at least one facing, because an empty board and
 * a board with one carrot on it are different sentences.
 */
export function shelfShow(qty, cap, surfaces) {
  const slots = shelfSlots(surfaces);
  const n = Math.max(0, Math.round(qty ?? 0));
  if (n <= 0 || slots <= 0) return 0;
  const room = Math.max(1, Math.round(cap ?? n));
  return Math.max(1, Math.min(n, slots, Math.round((n * slots) / room)));
}

/**
 * The same goods, but on a unit that has rows — the boards its model flagged as
 * `surface`, handed over by `surfacesAt`.
 *
 * **One prop per unit.** Sixteen on the shelf draws sixteen, which is the
 * whole reason a shelf is worth looking at from across the shop, and it is why
 * a board is `PER_ROW × PER_DEEP` rather than a single row. It used to draw a
 * *fraction*: three facings on every row that `ceil(qty / capacity × rows)`
 * said was occupied, so one unit and three both came out as three.
 *
 * Three things here are the camera's doing rather than the shop's. Goods run
 * along the unit's WIDTH, because a model is authored facing east: its depth
 * is x and its face is +x, and spreading them along x files them nose-to-tail
 * where the row above hides all but the first. They fill from the TOP board
 * down — bottom-up is how a real shop stocks and it is invisible here, because
 * on a 45° camera each board covers the one below it. And within a board they
 * fill FRONT row first for the same reason: the back row is drawn up-screen
 * and reads as depth behind the front one, so filling it first would put the
 * first carrot somewhere that looks like the back of the shelf.
 */
export function buildShelfGoods(model, qty, surfaces, cap) {
  const g = new THREE.Group();
  const show = shelfShow(qty, cap, surfaces);
  for (let n = 0; n < show; n++) {
    const s = surfaces[surfaces.length - 1 - Math.floor(n / PER_BOARD)];
    // Goods run along whichever way the board is longer, back in whichever way
    // it is shallower. Assuming width is always z held for as long as every
    // shelf was a straight one facing east — a corner unit's second wing runs
    // the other way, and would have filed its stock into the wall.
    const alongZ = s.depth >= s.span;
    const run = alongZ ? s.depth : s.span;
    const back = alongZ ? s.span : s.depth;
    const slot = n % PER_BOARD;
    // Front row proud of centre, as it always sat; each row behind it steps
    // back by a share of the board rather than by a constant, so a deep
    // freezer board spreads and a shallow counter one doesn't collide.
    const lip = back * (FRONT_LIP - Math.floor(slot / PER_ROW) * (0.56 / PER_DEEP));
    const off = ((slot % PER_ROW) - (PER_ROW - 1) / 2) * (run / (PER_ROW + 0.4));

    const one = buildModel(model);
    one.scale.setScalar(GOODS_SCALE);
    one.position.set(
      s.x + (alongZ ? lip : off),
      // A hair proud of the board, so a flat-bottomed item doesn't z-fight it.
      s.y + 0.005,
      s.z + (alongZ ? off : lip),
    );
    g.add(one);
  }
  // Sixteen carrots go on being sixteen carrots and stop being sixteen objects
  // — see `weld`. This is the single biggest object count in the game, and
  // nothing on a shelf moves on its own.
  return weld(g);
}

/**
 * How wide a banknote is drawn, in tiles. Everything else about the pile is
 * derived from it, the way the crate derives from `CRATE`.
 *
 * A note used to be 0.34 across — more than half a tile, for the smallest
 * object in the game. One sale looked like a sack of money and a busy till
 * looked like a bank robbery, which is the wrong read twice: the pile is meant
 * to say *somebody should come and get this*, not to be the loudest thing in
 * the shop.
 */
const NOTE = 0.24;

/**
 * A pile of takings sitting on the counter.
 *
 * Money used to be a number that ticked up in the HUD — you never saw a sale
 * happen. Now it lands somewhere and somebody has to come and get it.
 *
 * **No number on it.** It carried its own `+$4.20` until piles started landing
 * next to each other: five sales at one till drew five labels in a column, each
 * of which is a sum nobody is adding up, and the tallest thing on screen became
 * the arithmetic rather than the money. The amount is drawn once per tile now,
 * as a total — `Scene.syncCashLabels`. Same argument the crate stack makes: one
 * spot, one readout, and the height of the pile is the other half of the story.
 */
export function buildCashDrop() {
  const g = new THREE.Group();

  // A few banknotes, fanned so the pile reads at isometric distance.
  for (let i = 0; i < 3; i++) {
    const note = new THREE.Mesh(GEO.box, material(i === 1 ? '#7fbf6a' : '#9ad285'));
    note.scale.set(NOTE, NOTE * 0.13, NOTE * 0.65);
    note.position.set((i - 1) * NOTE * 0.2, NOTE * (0.09 + i * 0.13), (i % 2) * NOTE * 0.15);
    note.rotation.y = (i - 1) * 0.35;
    note.castShadow = true;
    g.add(note);
  }
  const coin = new THREE.Mesh(GEO.cylinder, material('#e8c455'));
  coin.scale.set(NOTE * 0.38, NOTE * 0.12, NOTE * 0.38);
  coin.position.set(NOTE * 0.35, NOTE * 0.56, NOTE * -0.24);
  coin.castShadow = true;
  g.add(coin);

  g.userData.spin = coin;
  return g;
}

/**
 * A crate's footprint, wall height and wall thickness, in tiles.
 *
 * It was 0.86 across and 0.42 deep, which is very nearly the whole tile: two
 * crates on neighbouring tiles touched, one beside a wall read as leaning
 * through it, and a single item sat at the bottom of an acre of empty box with
 * the rim hiding most of it. Everything below is derived from these three
 * numbers rather than typed out again, so the goods cannot quietly stop fitting
 * the crate the next time it changes size.
 *
 * ...and 0.6 was still most of a tile. A box that fills its square reads as
 * furniture rather than as something somebody carries, and a pile of three of
 * them stood as tall as the shelving beside it. Shrunk by an eighth on every
 * axis at once, which is the only way to do it: the proportions are what make
 * it read as a crate, and the goods, the stacking step and the label all come
 * off these numbers, so they follow on their own.
 *
 * ...and again by 15% when it stopped being timber. That is not a third go at
 * the same judgement: a moulded tote is a smaller object than a wooden crate in
 * life, and it now stands on a belt a tile wide, where a box within a whisker
 * of the deck edges reads as jammed rather than as riding. The one number that
 * did NOT simply scale is the wall, which came down by a further third on top
 * of it — plank thickness is a fact about planks, and carrying it over is what
 * made the tote look like a crate somebody had painted grey.
 *
 * ...and once more by the 0.72 a riding crate used to be scaled by, which is
 * the same judgement arriving from the other end. A box on a conveyor has been
 * drawn at 0.72 of the pallet size since there were belts, and that is the size
 * that has been looked at for hours — threading between machines, going into a
 * loader, coming off onto a pad — while the floor crate is the one nobody had a
 * reference for. So the belt was right and the pallet was wrong: this is the
 * belt's number becoming the crate's, and `BELT_CRATE` drops to 1 so a box is
 * the same object standing still or moving. Nothing on a conveyor changes size
 * at all — it was already exactly this.
 */
const CRATE = 0.318;
const CRATE_H = 0.138;
const CRATE_WALL = 0.019;

/** Top of the base panel — the floor the goods stand on. */
const CRATE_DECK = 0.027;

/**
 * How tall one crate stands, and therefore how far up the next one sits.
 *
 * Boards plus walls, so a stacked crate's own boards land exactly on the rim of
 * the one below with no gap and no overlap. Derived rather than typed, like
 * everything else off `CRATE`: a taller crate has to keep stacking.
 */
export const CRATE_STEP = CRATE_DECK + CRATE_H;

/**
 * How high a crate rides when it is on a conveyor.
 *
 * Matches `FIXTURE_LOOK.belt.h`, and it is a constant rather than that lookup
 * because a belt with authored art is drawn from its own model and this is the
 * height goods sit at either way — the deck a belt has, not the height a
 * particular belt happens to be.
 *
 * It was 0.12, which was the top of the carriers back when a carrier was a
 * half-tenth-tall block the box literally sat on. They are flat markings now —
 * a light rather than a roller — so the surface a crate rests on is the deck
 * itself plus the sliver of paint on it, and a box left at the old height would
 * hover a fiftieth of a tile over its own belt. Small, and exactly the size of
 * gap the eye reads as a thing not touching what it is standing on.
 */
export const BELT_DECK = 0.1;

/**
 * A delivered pallet waiting at the bay: a crate, a sample of what's inside,
 * and how many are left to shift.
 *
 * `covered` says another crate is standing on this one, which changes what it
 * can usefully draw. A crate is open-topped and its goods stand proud of the
 * rim, so a stack drawn the ordinary way would push a sample of tomatoes up
 * through the boards of the box above it — and the sample is *hidden* anyway,
 * because the thing above is a lid in every sense except the name. So a covered
 * crate says what is in it in words instead: the one place in the game a crate
 * has ever needed to name itself is when you cannot see into it.
 */
export function buildPallet(piles, {
  covered = false, cap = 6, waste = false, label = true,
} = {}) {
  const g = new THREE.Group();
  const qty = piles.reduce((n, p) => n + p.qty, 0);

  // Rubbish is the same tote in a drab colourway, and that is the whole of the
  // difference on purpose: what tells you it is rubbish is WHERE it is and the
  // fact that somebody is carrying it to the skip. A second silhouette would be
  // a new object to learn for a crate that behaves like every other crate —
  // you can pick it up, it stacks, it holds the same goods.
  const look = waste ? WASTE_LOOK : CRATE_LOOK;

  // The bottom, and the foot under it. Two pieces sharing the deck's height
  // between them, so `CRATE_STEP` is unchanged and a pile still has no gaps.
  //
  // The BASE is the full footprint and it is not optional: an inset skid alone
  // is a bottom only for as long as the walls are thick enough to meet it, and
  // thinning them opened a slot all the way round that you look straight down
  // through from this camera — a box with no floor, holding goods that stand on
  // nothing. Full width, in the body colour, because it is the inside of the
  // tote and the one face you see most of when the box is empty.
  const footH = CRATE_DECK * 0.5;
  const foot = new THREE.Mesh(GEO.box, material(look.skid));
  foot.scale.set(CRATE * 0.8, footH, CRATE * 0.8);
  foot.position.set(0, footH / 2, 0);
  foot.castShadow = true;
  g.add(foot);

  // Inset on purpose: full-width it is a solid block sitting flush on the
  // floor, where pulled in it reads as standing on a foot — and a stacked
  // crate's foot then drops inside the rim of the one below rather than
  // balancing on top of it.
  const base = new THREE.Mesh(GEO.box, material(look.body));
  base.scale.set(CRATE, CRATE_DECK - footH, CRATE);
  base.position.set(0, (CRATE_DECK + footH) / 2, 0);
  base.castShadow = true;
  g.add(base);

  // The walls stop short of the top, and the band they leave is the lip.
  //
  // That split is the whole silhouette: four flat walls read as sheet material
  // whatever they are painted, where a rim standing proud of them reads as
  // something moulded in one piece. It comes out of `CRATE_H` rather than being
  // added to it, so the box is exactly as tall as it was and still stacks.
  const LIP = CRATE_H * 0.17;
  const wallH = CRATE_H - LIP;
  const rim = (CRATE - CRATE_WALL) / 2;

  // Open-topped so the goods read from above.
  const wallMat = material(look.body);
  const wall = (sx, sz, px, pz) => {
    const m = new THREE.Mesh(GEO.box, wallMat);
    m.scale.set(sx, wallH, sz);
    m.position.set(px, CRATE_DECK + wallH / 2, pz);
    m.castShadow = true;
    g.add(m);
  };
  wall(CRATE, CRATE_WALL, 0, -rim);
  wall(CRATE, CRATE_WALL, 0, rim);
  wall(CRATE_WALL, CRATE, -rim, 0);
  wall(CRATE_WALL, CRATE, rim, 0);

  // Corner posts, standing a hair outside the walls and running from the ground
  // to the underside of the lip. What a stack of these interlocks by — and, at
  // this camera, the vertical that keeps a box from reading as a plain cube.
  const postMat = material(look.post);
  const post = CRATE_WALL * 2.4;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(GEO.box, postMat);
      m.scale.set(post, CRATE_DECK + wallH, post);
      m.position.set(sx * rim, (CRATE_DECK + wallH) / 2, sz * rim);
      m.castShadow = true;
      g.add(m);
    }
  }

  // ...and the rim itself, proud of both faces and the brightest thing on the
  // box. From a 40° camera this band is most of what you see of an empty crate,
  // and it is the one part of it that catches a lamp after dark — which is what
  // stops a cool grey tote going the way the black conveyor did at night.
  const lipMat = material(look.lip);
  // Wider than the posts are, or the rim is no longer the outermost thing on
  // the box and the corners cut through the one line that reads as moulded.
  const lipT = CRATE_WALL * 2.6;
  const lipY = CRATE_DECK + wallH + LIP / 2;
  const lip = (sx, sz, px, pz) => {
    const m = new THREE.Mesh(GEO.box, lipMat);
    m.scale.set(sx, LIP, sz);
    m.position.set(px, lipY, pz);
    m.castShadow = true;
    g.add(m);
  };
  // Run the long way to the outside of the corners, or the rim has four notches
  // in it where the sides meet.
  const lipSpan = CRATE + lipT - CRATE_WALL;
  lip(lipSpan, lipT, 0, -rim);
  lip(lipSpan, lipT, 0, rim);
  lip(lipT, lipSpan, -rim, 0);
  lip(lipT, lipSpan, rim, 0);

  if (!covered) {
    /**
     * How full it LOOKS is how full it IS — a share of the crate's own
     * capacity, not a count against a literal.
     *
     * This was `ceil(qty / 6)`, capped at three rows, and the 6 was a number
     * nothing else in the game used: a crate holds `crateCapacity()`, so it
     * needed thirteen to draw three rows and every crate that could exist drew
     * exactly one. A full crate looked a quarter full, which reads as a stocker
     * who cannot pack rather than as art measured against the wrong number.
     *
     * With more than one pile in the box the rows are SHARED OUT between them,
     * biggest first, and every pile gets at least one — a box you cannot tell
     * holds three things is a box that has not said the thing worth saying.
     * Three rows against three kinds is why `LOT_KINDS` is what it is: a fourth
     * pile would have nowhere to stand that anyone could see from this camera.
     */
    const shown = piles.filter((p) => p.model).slice(0, 3);
    const full = Math.round((qty / Math.max(1, cap)) * 3);
    // At least one row per pile, so what is in the box is legible, and never
    // more than three, so it stays inside the walls. The floor at `shown.length`
    // is why a nearly-empty mixed box looks fuller than a nearly-empty plain
    // one: how many KINDS is the fact worth reading at a glance, and how much
    // there is is on the label right above it.
    const rows = Math.max(shown.length, Math.min(3, full));
    const each = shown.map((_, i) => Math.floor(rows / shown.length)
      + (i < rows % shown.length ? 1 : 0));

    // Sized and spread off the crate's *inside*, not off literals: an item is
    // at most 0.36 across and the shortest wall stands the goods off centre, so
    // one that fits the box at this size still fits it at another.
    const inner = CRATE - CRATE_WALL * 2;
    const scale = Math.min(0.55, inner / 0.9);
    let i = 0;
    shown.forEach((pile, k) => {
      for (let n = 0; n < each[k]; n++, i++) {
        const one = buildModel(pile.model, { castShadow: false });
        one.scale.setScalar(scale);
        one.position.set(
          ((i % 2) - 0.5) * inner * 0.4,
          // Standing on the deck rather than floating above it, and stacked in
          // steps short enough that the second row clears the rim — the point
          // of an open-topped crate is that you can see what is in it.
          CRATE_DECK + i * CRATE_H * 0.55,
          ((i % 3) - 1) * inner * 0.26,
        );
        g.add(one);
      }
    });
  }

  // A lone crate hangs its count in the air above itself, where there is
  // nothing to collide with. A covered one wears it on its own front instead,
  // at rim height: in a stack the floating version would be drawn inside the
  // crate above, which reads as that crate's number rather than as this one's.
  // Sprites already ignore depth, so a buried crate's label stays legible
  // through everything standing on it — which is the whole point of it.
  // Every crate NAMES what is in it, pile by pile, a row each.
  //
  // Only a covered one used to, on the argument that an open box shows you its
  // goods — and it does, at about eight pixels a unit from this camera, which
  // is enough to tell a box of something from an empty box and not enough to
  // find the coffee. So an open crate said `x12` and a mixed one said "2
  // kinds", and looking for a particular thing in a yard meant walking up to
  // every box in turn. The count was never the hard question.
  //
  // A row per pile rather than a list, because `LOT_KINDS` is 3 and three names
  // run together shrink to an unreadable width — see `paintText`, which now
  // takes the height out of the size instead.
  //
  // ...and a box that is MOVING wears none of it. A name is a thing you read,
  // and reading is the one thing you cannot do to a label sliding across the
  // shop — so a run of belt was a row of captions gliding past, each of them
  // legible for about a second, all of them layered over the aisle behind. It
  // is the readout-per-tile call said about a box that will not hold still:
  // what a crate on a conveyor is FOR is where it is going, and where it is
  // going is drawn by the belt under it. Standing still it says its name again,
  // because `d.belt` is in the delivery prop's cache key.
  /**
   * ...and the whole box goes down to a mesh per colour — see `weld`.
   *
   * A crate is fourteen little boxes before anything is in it (a foot, a base,
   * four walls, four posts, four lip sections) and up to six more for the
   * goods, and NOTHING in it moves on its own. That is the same sentence
   * `buildShelfGoods` and the armful already make about themselves, and the
   * crate was the one that never got it — which stopped being an oversight and
   * started being the biggest object count in the game the day belts arrived,
   * because a conveyor puts a crate on every cell of every run. Measured on a
   * day-390 shop: 675 of 1,451 meshes in the scene were crates, out of 1,726
   * draw calls a frame. Nothing about that is visible — a box is a box — which
   * is exactly why it went unnoticed while the shop grew around it.
   *
   * The label rides along untouched: `weld` re-hangs a sprite rather than
   * trying to merge it, which is what `syncCashLabels` and the armful rely on
   * too. And `pickPallet` is unaffected, because it walks UP from whatever the
   * ray met to `userData.delivery` — that field is on the group, and welding
   * replaces a group's children rather than the group.
   */
  if (!label) return weld(g);
  const said = piles.some((p) => p.name)
    ? piles.map((p) => `${p.qty}x ${p.name || '?'}`).join('\n')
    : `x${qty}`;
  const tag = buildTextSprite(said, {
    fill: '#ffe9b8',
    // A buried crate's label sits on its own front between two boxes, so it has
    // less room than one hanging in clear air above the pile.
    scale: covered ? 0.62 : 0.7,
  });
  // Clear air over the rim, measured off the rim rather than typed as a height:
  // a shorter crate would otherwise leave its count floating further above the
  // box than a taller one did, which reads as the label belonging to nothing.
  tag.position.y = covered ? CRATE_DECK + CRATE_H / 2 : CRATE_STEP + 0.47;
  g.add(tag);
  // Handed out on the group so the renderer can fade it by how near the middle
  // of the view this box is — see `fadeCrateLabels`. It survives the weld
  // because `weld` carries `userData` across to the group it returns, and the
  // sprite itself is re-hung rather than merged.
  g.userData.label = tag;

  return weld(g);
}

/**
 * `+$4.20` drawn to a canvas and hung in the air as a sprite.
 *
 * Smaller than a crate's count on purpose, where it used to be half again
 * bigger than one. A crate's number is a thing you *read* — how many are left
 * to shift — and this one is a thing you *notice*: the pile under it is already
 * saying money is there, so the figure only has to be legible enough to be
 * worth walking over for.
 */
export function buildMoneyLabel(amount) {
  return buildTextSprite(moneySaid(amount), { fill: '#eafbe2', scale: 0.55 });
}

/** What a pile says. Its own name so the sprite and its rewrite agree. */
export const moneySaid = signed;

let ghostMat = null;
/**
 * A translucent preview of a thing where it would go. Materials are swapped for
 * one shared ghost material rather than tinting the cached originals, which
 * every other prop is still using.
 */
export function buildGhost(model) {
  if (!ghostMat) {
    ghostMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false,
    });
  }
  const g = buildModel(model, { castShadow: false });
  g.traverse((o) => { if (o.isMesh) o.material = ghostMat; });
  return g;
}

/**
 * How big an ingredient or a finished batch is drawn standing on a machine.
 *
 * Deliberately smaller than a shelf's goods. These are a READOUT stood on a
 * worktop, not stock on display — at shelf scale two ingredients and a batch
 * are bigger than the machine making them, which is what made a row of
 * appliances read as a jumble rather than as a counter.
 */
const BAY_ITEM = 0.24;

/** Up the pile, per unit. Small enough that three of them clear the lid above. */
const BAY_STEP = 0.11;

/** Past this a bay reads as "several" — a recipe wanting twelve is still a pile. */
const BAY_MAX = 4;

/** Colours of the pads. Green has it, red is short, gold is yours to collect. */
const BAY_LOOK = { ready: '#7cc46a', short: '#c8553d', outlet: '#ffd66b' };

/**
 * The pad for a bay with no well under it — the roof fallback, and the round
 * disc every bay in the game used to be.
 */
const BAY_PAD = { span: 0.3, depth: 0.3, shape: 'cylinder' };

/** What the pad leaves clear of its well, so two of them never touch. */
const BAY_INSET = 0.05;

/**
 * ...and how big one may get however big the well is. A pad is a readout, and
 * past about half a tile it stops reading as a place on the machine and starts
 * reading as the machine having been painted.
 */
const BAY_PAD_MAX = 0.46;

/**
 * One pad — an ingredient bay or the outlet — with its pile stood on it.
 *
 * The pad is the WELL, drawn: its size and its shape both, so a box well gets a
 * rectangular pad and a cylinder well gets a round one. It was a fixed 0.3 disc
 * for every well on every machine, which is why they clipped — a griddle 0.42
 * across got the same coaster as a jug, the pile stood on it overhung both
 * edges, and two bays sharing a long well ran into each other and into whatever
 * the art had drawn beside them.
 *
 * Shape comes off the art rather than being authored beside it, for
 * `seamStep`'s reason: a pad shape kept in a second place is a pad shape
 * somebody has to remember to move.
 */
function buildBay(model, { solid, ghost, colour, well = BAY_PAD }) {
  const g = new THREE.Group();

  const span = Math.min(BAY_PAD_MAX, Math.max(0.1, (well.span ?? 0.3) - BAY_INSET));
  const depth = Math.min(BAY_PAD_MAX, Math.max(0.1, (well.depth ?? 0.3) - BAY_INSET));

  const pad = new THREE.Mesh(well.shape === 'cylinder' ? GEO.cylinder : GEO.box, material(colour));
  pad.scale.set(span, 0.04, depth);
  g.add(pad);

  if (!model) return g;

  /**
   * How big the pile stands, clamped to the pad rather than taken as a
   * constant. `BAY_ITEM` is the ceiling — a readout is never bigger than that,
   * however roomy the well — and a wide model on a narrow one comes down to
   * fit instead of hanging over the side.
   */
  const b = modelBounds(partsAt(model, 1));
  const wide = Math.max(1e-3, b.maxX - b.minX);
  const deep = Math.max(1e-3, b.maxZ - b.minZ);
  const fit = Math.min(BAY_ITEM, (span * 0.88) / wide, (depth * 0.88) / deep);
  // The stack closes up with it, or a shrunk pile floats apart into three
  // things rather than reading as one short stack with a gap over it.
  const step = BAY_STEP * (fit / BAY_ITEM);

  for (let i = 0; i < Math.min(BAY_MAX, solid + ghost); i++) {
    const one = buildModel(model, { castShadow: false });
    // A missing unit fades but keeps its own colours. `buildGhost`'s one white
    // material is right for a seed preview, where you already know what you
    // picked — here the whole question is *which* thing is missing, and a white
    // blob answers "something". Tinting per part costs nothing: the cache is
    // keyed by colour and alpha, so the palette is reused too.
    if (i >= solid) {
      one.traverse((o) => {
        if (o.isMesh) o.material = material(o.material.color.getHex(), 0.35);
      });
    }
    one.scale.setScalar(fit);
    // Piled UP rather than spread out, because the bays sit a third of a tile
    // apart on the machine's own top and a row would run into its neighbour.
    // Height is also the reading you can take across the shop: two of three is
    // a short stack with a gap over it.
    one.position.set(0, 0.06 + i * step, 0);
    g.add(one);
  }
  return g;
}

/**
 * What an appliance takes in and what it puts out, stood on the machine itself.
 *
 * A row of sockets floating over it said neither of those things: every icon
 * looked the same whether it was an ingredient or the thing being made, one
 * icon meant one ingredient however many of it a batch wanted, and nothing at
 * all was drawn for what was waiting to be collected. So an appliance says the
 * whole sentence now, laid out the way it reads — **ingredients across the
 * back, the finished thing at the front**, which is the direction a machine
 * works in and the direction it faces.
 *
 * A bay holds as many units as a batch calls for: solid up to what's in the
 * hopper, ghosted after. Three tomatoes with one solid is *one of three*, which
 * is the number that decides whether you go and fetch more.
 *
 * Every bay keeps its pad whether it's filled or not — a missing ingredient has
 * to be a visibly *empty place*, not a faint smudge, or the thing you're
 * looking for is the thing that's hardest to see. That goes double for the
 * outlet: an empty gold pad is the machine telling you where it will put the
 * batch, and it is the same pad that later has the batch on it.
 *
 * WHERE they sit is authored when the machine says so, and measured when it
 * doesn't. A `surface` part on an appliance is a well built into the art — the
 * hopper on top of the machine, the tray at the front — exactly the way a
 * `surface` on a shelf is a board. Whichever well is furthest FORWARD is the
 * outlet; the rest are what goes in, and several ingredients spread along the
 * well they share. A machine nobody has drawn wells into falls back to standing
 * them on its roof, which is the same degrade a unit with no boards takes.
 *
 * Laid out in MODEL space — whoever adds this to the scene turns it to face the
 * way the machine faces, or the outlet ends up round the back.
 */
export function buildStationBays({
  intakes = [], outlet = null, bounds, wells = [], column = 0, columns = 1,
}) {
  const g = new THREE.Group();
  const b = bounds ?? { minX: -0.35, maxX: 0.35, minZ: -0.35, maxZ: 0.35, top: 0.8 };
  // Far enough in that a pad overhangs nothing, and the two rows stay apart on
  // a machine barely two thirds of a tile deep.
  const INSET = 0.17;

  /**
   * A machine with two heads is two of these, and which wells belong to which
   * is read off the ART rather than authored as an index — the same rule
   * `surfacesAt`, `seamStep` and `drawableBoards` are held to, and for
   * `verify:motion`'s reason: an index taken beside the parts spins the box next
   * door the day somebody drops a seam past it.
   *
   * Ingredients run back-to-front along x, so heads run side by side along z:
   * the wells sort into `columns` bands by z, and each band is one head's own
   * hopper-and-tray pair. A machine that authored only one pair — which is every
   * machine anybody has drawn — hands the same wells to both heads, and they
   * stand their bays at the same place with the SPREAD below keeping them apart.
   */
  const byZ = [...wells].sort((a, c) => a.z - c.z);
  const band = columns > 1 && byZ.length >= columns * 2
    ? byZ.slice(
      Math.round((column * byZ.length) / columns),
      Math.round(((column + 1) * byZ.length) / columns),
    )
    : byZ;
  // ...and within a head, front-most last — so the outlet is the one at the
  // front and everything behind it takes ingredients.
  const sorted = [...band].sort((a, c) => a.x - c.x);
  const tray = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  const hopper = sorted.length > 1 ? sorted.slice(0, -1) : sorted;

  /**
   * Where this head sits across the machine when the art has not said.
   *
   * Zero for a single head, which is every machine that exists — so a shop that
   * never bought a rung draws exactly what it drew before, to the millimetre.
   */
  const lane = columns > 1 && band === byZ
    ? (column - (columns - 1) / 2) * Math.min(0.3, (b.maxZ - b.minZ) / columns)
    : 0;

  intakes.forEach((s, i) => {
    // One well each where the art drew enough of them; otherwise they share the
    // one well (or the roof), spread along whichever way it is longer.
    const w = hopper.length ? hopper[Math.min(i, hopper.length - 1)] : null;
    const share = hopper.length ? intakes.length - hopper.length + 1 : intakes.length;
    const n = hopper.length ? Math.max(0, i - hopper.length + 1) : i;
    const run = w ? Math.max(w.span, w.depth) : (b.maxZ - b.minZ);
    const pitch = Math.min(0.34, run / Math.max(1, share));
    const off = (n - (share - 1) / 2) * pitch;
    const bay = buildBay(s.model, {
      solid: Math.max(0, Math.min(s.held ?? 0, s.need ?? 1)),
      ghost: Math.max(0, (s.need ?? 1) - (s.held ?? 0)),
      colour: (s.held ?? 0) >= (s.need ?? 1) ? BAY_LOOK.ready : BAY_LOOK.short,
      // Sharing a well means sharing its depth: the spread above is along z, so
      // a pad drawn at the well's full depth would sit under its neighbour.
      well: w ? { ...w, depth: share > 1 ? Math.min(w.depth, pitch) : w.depth } : undefined,
    });
    bay.position.set(
      w ? w.x : b.minX + INSET,
      (w ? w.y : b.top) + 0.02,
      (w ? w.z : 0) + off + lane,
    );
    g.add(bay);
  });

  const out = buildBay(outlet?.model ?? null, {
    solid: Math.max(0, Math.round(outlet?.qty ?? 0)),
    ghost: 0,
    colour: BAY_LOOK.outlet,
    well: tray ?? undefined,
  });
  out.position.set(
    tray ? tray.x : b.maxX - INSET,
    (tray ? tray.y : b.top) + 0.02,
    (tray ? tray.z : 0) + lane,
  );
  g.add(out);

  return g;
}

/** Top of the earth inside a bed's frame, and the top of a ridge standing on it. */
export const SOIL_TOP = 0.06;
export const RIDGE_H = 0.07;
export const RIDGE_TOP = SOIL_TOP + RIDGE_H;
/** Inside the frame the model draws round it — see the plot row's planks. */
const BED_INNER = 0.86;

/**
 * What is in the tray right now.
 *
 * A bed that has not been turned over has to read as *not ready* from across
 * the room, or the till step is an invisible error message. That claim survives
 * the farm coming indoors and everything it was drawn with does not: this was
 * turf, five weed cones and a stone, which is a picture of a neglected corner of
 * a field. Under a lit rack it reads as somebody having tipped a lawn into the
 * hydroponics — and it is the exact shape docs/vats.md warns about, a
 * convention that was right because of where it lived.
 *
 * So both states are the same tray with different things in it. An unprepared
 * tray is a DRY MAT, flat and bare — nothing standing up, because the one thing
 * a clean tray must not have is scruff growing out of it. A prepared one is cut
 * into CHANNELS.
 *
 * The channels are RIDGES rather than stripes, and that is the whole of what was
 * wrong with the outdoor version and is why it survives the reskin unchanged.
 * Bars painted on a slab are a texture, and this renderer does not draw textures
 * — it draws a contour, and it finds one at a depth step. Standing the channel
 * PROUD and pale puts the dark in the groove between two of them, which is the
 * one place this art spends it.
 *
 * `rows` is where the plants are actually going, so the channels line up with
 * what is growing in them — four plants is two fat channels and twelve is four.
 * Nothing is planted in an unprepared tray, so a bare prepared one gets four.
 * Since the rack grew decks, `rows` is the BOTTOM deck's plants only: the tray
 * drawn here is the one at the base of the rack, and cutting it a lane per plant
 * on three levels at once is three trays' worth of channels in one.
 */
export function buildSoil(state, palette, rows = null) {
  const g = new THREE.Group();
  const tilled = state === 'tilled';

  const bed = new THREE.Mesh(GEO.box, material(tilled ? palette.soilFurrow : palette.soilRough));
  bed.scale.set(BED_INNER, SOIL_TOP, BED_INNER);
  bed.position.y = SOIL_TOP / 2;
  bed.receiveShadow = true;
  g.add(bed);

  if (tilled) {
    const lanes = ridgeLanes(rows);
    for (const lane of lanes) {
      const ridge = new THREE.Mesh(GEO.box, material(palette.soilTilled));
      ridge.scale.set(BED_INNER - 0.06, RIDGE_H, lane.depth);
      ridge.position.set(0, SOIL_TOP + RIDGE_H / 2, lane.z);
      ridge.castShadow = true;
      ridge.receiveShadow = true;
      g.add(ridge);
    }
  }
  // ...and nothing at all in an unprepared one. The weeds and the stone are
  // GONE rather than restyled, which is worth saying so nobody puts a tidier
  // version of them back: what they were for was telling a rough bed from a
  // turned one at a distance, and the mat does that on its own now — bare and
  // flat against four raised channels is a bigger silhouette difference than
  // five cones ever were, and it is the difference the contour can actually
  // draw.
  return g;
}

/**
 * The ridges to build, from where the plants are going.
 *
 * Rows arrive as one z per plant, so they repeat — a bed of twelve is twelve
 * spots on four rows, and a ridge per spot is four ridges built three times in
 * the same place, which is z-fighting rather than farming. They are also
 * *wobbled* (`plantSpots`), so "the same row" is a handful of values a few
 * thousandths apart: they cluster rather than match.
 */
function ridgeLanes(rows) {
  const zs = [...new Set((rows ?? []).map((z) => Math.round(z * 40) / 40))].sort((a, b) => a - b);
  if (!zs.length) return [-0.30, -0.10, 0.10, 0.30].map((z) => ({ z, depth: 0.14 }));
  // Fill the bed rather than leaving a margin whose size is an accident of how
  // many plants this crop happens to yield: the gap between ridges is what reads
  // as a furrow, so it is the gap that stays fixed and the ridge that gives.
  const pitch = zs.length > 1 ? (zs[zs.length - 1] - zs[0]) / (zs.length - 1) : BED_INNER / 2;
  return zs.map((z) => ({ z, depth: Math.max(0.10, Math.min(0.26, pitch - 0.06)) }));
}

const GHOST_MATS = {};

/**
 * The translucent fixture that follows your pointer in build mode. Three
 * answers, not two: green lands, amber lands *and costs you something* — a
 * shelf nothing can reach, a doorway you just sealed — and red cannot land at
 * all. The middle one is the interesting one, because blocking your own shop is
 * a legal move here; the ghost's job is to make sure you meant it.
 *
 * Deliberately the full tile footprint plus a marker on the side you'd stand:
 * rotation is meaningless otherwise, and "which way does this face" is the
 * thing you actually need to see.
 */
const GHOST_COLOURS = {
  ok:   { body: 0x7cc46a, cage: 0x2f6b28, pad: 0xffd66b },
  warn: { body: 0xe0a53c, cage: 0x8a5c14, pad: 0xffd66b },
  no:   { body: 0xe2564a, cage: 0x8c2a22, pad: 0xe2564a },
};

/**
 * A working spot, drawn on the ground.
 *
 * `role` is the whole reason this is its own function. One ring meant one spot,
 * and a till has two of them that are not interchangeable in the slightest: the
 * queue forms on one and your clerk stands on the other, so a player who cannot
 * tell them apart has a fifty-fifty chance of standing their counter with the
 * line trailing into the stockroom. Two identical rings would be worse than one,
 * because it would look like information.
 *
 * Told apart by SHAPE rather than by colour, because the colour is already
 * spoken for — it carries the verdict, and a red ghost has to stay legible as
 * red. So: an empty square is somewhere a customer stands, and a square with a
 * post standing in it is somewhere one of YOURS stands. The post is upright
 * rather than flat for the same reason: on a 45° camera a mark on the floor is
 * read at a glance and a thing standing up is read as a person.
 */
export function buildWorkSpot(role, at, colour = 0xffd66b) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthTest: false,
  });

  // SQUARE, and the same argument `buildFootMark`, `buildStamp` and the press
  // ripple all make: this floor is a grid, everything on it that means anything
  // is tile-shaped, and a disc is the one outline down here that lines up with
  // nothing around it. It was a ring while it was the only mark of its kind on
  // the ground; beside a contour drawn round the unit it is standing at, a
  // circle reads as belonging to a different game.
  //
  // Smaller than the ring it replaced — 0.27 against 0.34 — and that is the
  // shape change being paid for rather than a second opinion about size. A
  // square holds its size on the DIAGONAL, which is the trade `buildFootMark`
  // names: at the ring's own radius the corners reach 0.48 of a tile, so four
  // spots round a unit very nearly met each other and read as a patch of floor
  // rather than as four places to stand. At 0.27 the corners land where the
  // ring's edge used to, so a spot claims the floor it always did.
  // ...and a THIN band on it, which the ring never needed to be. A ring's
  // weight was the only thing making a small circle visible on a cream floor;
  // a square is read by its corners, so it stays legible far lighter — and
  // heavy, four of them round one unit are the loudest thing in the aisle.
  const pad = new THREE.Mesh(new THREE.ShapeGeometry(frameShape(0.27, 0.06)), mat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.1;
  pad.renderOrder = 12;
  g.add(pad);

  if (role === 'tend') {
    const post = new THREE.Mesh(GEO.capsule, mat);
    post.scale.set(0.2, 0.34, 0.2);
    post.position.y = 0.34;
    post.renderOrder = 12;
    g.add(post);
  }

  // Goods, rather than people. An arrow, because the question a conveyor asks
  // is not "may somebody stand here" but "which way does this go" — and a ring
  // cannot say that however it is shaped. Same colour as everything else here,
  // for `buildWorkSpot`'s stated reason: the colour is spoken for by the
  // verdict, so the meaning has to be carried by the shape.
  //
  // The direction comes out of the offset itself rather than being passed in:
  // the spot already sits one cell away along the flow, so `out` points away
  // from the fixture and `in` points back at it. Nothing to keep in step.
  if (role === 'out' || role === 'in') {
    const away = Math.atan2(at.x, at.z);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.3, 4), mat);
    head.rotation.x = Math.PI / 2;
    head.position.y = 0.22;
    head.renderOrder = 13;
    const spin = new THREE.Group();
    spin.add(head);
    // `in` is the same arrow turned round: an arrow pointing at the machine is
    // "this is where it takes from", which is the half a player has to get right
    // to feed one at all.
    spin.rotation.y = role === 'out' ? away : away + Math.PI;
    g.add(spin);
  }

  g.position.set(at.x, 0, at.z);
  return g;
}

/** How see-through a previewed model is. Enough to read as not-yet-real. */
const GHOST_ALPHA = 0.45;

/**
 * @param {object}  o
 * @param {?object} o.model   The piece's authored model, drawn translucent. The
 *        preview IS the thing when there is one — see the note below.
 * @param {number}  o.t       Where on its tier ladder, 0..1, so a ghost of a
 *        tier-3 shelf is the tier-3 shelf.
 * @param {number}  o.rot     Which way it will face. Applied to the model only:
 *        the cage is a tile and a tile does not turn, and the spots are already
 *        computed in world axes by `workSpots`.
 * @param {number}  o.height  Fallback body height, for a kind with no model.
 * @param {string}  o.verdict 'ok' | 'warn' | 'no'.
 * @param {?Array<{dx: number, dz: number, role: 'use'|'tend'}>} o.spots
 *        Every tile somebody has to be able to stand on, in fixture-local
 *        coordinates. An array rather than the single `anchor` it used to take,
 *        because a till has two and the second one had no way to be drawn.
 *
 * The body used to be a coloured box the size of the kind, for every piece of
 * that kind — so a Bakery Case, a Produce Table and a plain Shelf all previewed
 * as one identical grey slab, and the only way to find out which one you had
 * armed was to buy it. The palette buttons solved this for themselves in
 * `client/thumb.js` (a picture of a thing has to come from the thing) and the
 * ghost was the other half nobody had done: the preview of a purchase is a
 * worse place to be generic than the button that arms it, because by then you
 * have already chosen and are deciding *where*.
 *
 * The cage stays, and now it is the only thing carrying the verdict — a real
 * model in real colours cannot be tinted red without becoming unreadable as the
 * model. That split is deliberate: the body says WHAT, the cage says WHETHER.
 */
/**
 * `cage` is off for a RUN, and that is a legibility call rather than a saving.
 *
 * The wireframe box exists so one ghost does not dissolve into a pale shelf
 * behind it. Twenty of them down an aisle is the opposite problem: the boxes
 * are the only thing you can see, and what a run preview is *for* is the shape
 * the belts make and which way each one faces. The coloured slab under every
 * cell (`setFloorGhost`) is already saying "here, and this is whether it can",
 * so the model is left to say the one thing only it can.
 */
export function buildFixtureGhost({ model, t = 1, rot = 0, height, verdict, spots, cage = true, span = 1 }) {
  // `true`/`false` still mean what they always did, so nothing that only knows
  // about two answers has to be found and changed.
  const key = verdict === true ? 'ok' : (verdict === false ? 'no' : (verdict ?? 'ok'));
  const c = GHOST_COLOURS[key] ?? GHOST_COLOURS.ok;
  if (!GHOST_MATS[key]) {
    GHOST_MATS[key] = new THREE.MeshBasicMaterial({
      color: c.body, transparent: true, opacity: 0.5, depthWrite: false,
    });
  }

  const g = new THREE.Group();
  const h = Math.max(height, 0.12);

  const drawn = model ? buildModel(model, { castShadow: false, t, alpha: GHOST_ALPHA }) : null;
  if (drawn?.children.length) {
    // Models are authored facing east — rot 0 — the same convention
    // `addFixtureProps` turns the real one by.
    drawn.rotation.y = -rot * (Math.PI / 2);
    g.add(drawn);
  } else {
    // No model, or a model whose stage draws nothing at this tier. The old
    // coloured slab, which is still the right answer for a kind nobody has
    // drawn: an invisible ghost is worse than a generic one.
    const body = new THREE.Mesh(GEO.box, GHOST_MATS[key]);
    body.scale.set(span - 0.06, h, span - 0.06);
    body.position.y = h / 2;
    g.add(body);
  }

  // A wireframe cage so the ghost doesn't dissolve into a pale shelf behind it.
  if (cage) {
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(span - 0.02, h, span - 0.02)),
      new THREE.LineBasicMaterial({ color: c.cage, depthTest: false }),
    );
    box.position.y = h / 2;
    box.renderOrder = 11;
    g.add(box);
  }

  // The tiles you'd work it from — this is what rotation actually changes.
  for (const s of spots ?? []) g.add(buildWorkSpot(s.role, { x: s.dx, z: s.dz }, c.pad));
  return g;
}

/**
 * The same marker for something that does not stand on a tile.
 *
 * A frame on the floor says "this square", which is the right sentence for a
 * shelf and the wrong one for a lamp. A decoration owns no cell on purpose, and
 * a hanging one is drawn most of a tile up-screen of the cell it belongs to — so
 * the frame lights up ground the thing is not on, the thing itself does not
 * change at all, and what you are pointing at becomes a guess. This is the same
 * sentence said about the object: a cage round its own art, at its own height.
 *
 * The box comes from the caller because only the renderer knows how big the art
 * came out — the same bounds the pointer is tested against, so what lights up
 * and what you can hit are the same volume by construction.
 *
 * `userData.ring` so the held-press wind-in animates this exactly as it animates
 * the flat frame: one mesh with a material of its own, which is also why the
 * cage is twelve merged bars rather than a `LineSegments` — a line's width is
 * one pixel on every platform that has ever ignored `linewidth`, and at this
 * camera that reads as a smudge rather than as a box.
 */
export function buildCageMarker(mode = 'aim', size = { x: 1, y: 1, z: 1 }, override = null) {
  const g = new THREE.Group();
  // `override` is for a cage that is not one of the marker vocabulary's — the
  // wall ghost, whose colour is a verdict rather than a mode. Merged over a
  // real look rather than replacing it, or every caller of it has to restate
  // the bar thickness and the draw order.
  const look = { ...(MARKER_LOOK[mode] ?? MARKER_LOOK.aim), ...override };
  g.userData.color = look.color;

  const t = 0.045;
  // A floor between the bar thickness and the box: a garland is a few
  // centimetres thick, and a cage thinner than its own bars is a solid lump.
  //
  // `grow` is the cage's version of `selected` being pushed out to the tile
  // edge, and it is load-bearing for exactly one pair: the pile you are pointing
  // at can also be the pile you picked, and two cages measured off the same
  // meshes are the same twelve bars in two colours, both with `depthTest: false`
  // — so they z-fight, and which one you see is decided by draw order rather
  // than by anything either of them means. Held apart, the amber sits inside the
  // teal and both are readable, which is the same picture a selected unit under
  // the pointer already gives you.
  const pad = look.grow ?? 0;
  const hx = Math.max(size.x, t * 4) / 2 + pad;
  const hy = Math.max(size.y, t * 4) / 2 + pad;
  const hz = Math.max(size.z, t * 4) / 2 + pad;

  const parts = [];
  const bar = (sx, sy, sz, x, y, z) => parts.push(
    new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z),
  );
  for (const y of [-hy, hy]) for (const z of [-hz, hz]) bar(hx * 2, t, t, 0, y, z);
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) bar(t, hy * 2, t, x, 0, z);
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) bar(t, t, hz * 2, x, y, 0);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (merged) {
    const cage = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color: look.color, transparent: true, opacity: 0.9, depthTest: false,
    }));
    cage.renderOrder = 9;
    g.add(cage);
    g.userData.ring = cage;
  }

  // Above the cage rather than at the group's origin, which for a hanging thing
  // is up in the air already — a chevron inside the box it is pointing at.
  if (look.chevron) {
    const arrow = new THREE.Mesh(GEO.cone, new THREE.MeshBasicMaterial({
      color: look.color, transparent: true, opacity: 0.95, depthTest: false,
    }));
    arrow.scale.set(0.26, 0.3, 0.26);
    arrow.rotation.x = Math.PI;
    arrow.position.y = hy + 0.3;
    arrow.renderOrder = 10;
    g.add(arrow);
    g.userData.arrow = arrow;
  }
  return g;
}

/**
 * One flat flag per channel. Never disposed, like `material()`'s cache.
 *
 * Not a colour — a CHANNEL. What goes in the mask is which marker covered the
 * pixel, and the shade it comes out is a uniform in the composite, so the two
 * markers can be told apart there and drawn at two different widths. See
 * `MARK` in look.js.
 *
 * `AdditiveBlending` is what lets them overlap: a shelf that is both pointed at
 * and open writes 1 into R and 1 into G at the same pixel, and with ordinary
 * blending the second one to draw would simply replace the first. Depth is off
 * for the same reason — the mask is a silhouette, so a board hidden behind
 * another board still belongs to it.
 */
const CONTOUR_MATS = [];

const contourMat = (ch) => (CONTOUR_MATS[ch] ??= new THREE.MeshBasicMaterial({
  color: new THREE.Color(ch === 0 ? 1 : 0, ch === 1 ? 1 : 0, ch === 2 ? 1 : 0),
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
  // Or the renderer's tone curve bends a flag on its way into the buffer, and
  // what the composite tests is a number nobody wrote.
  toneMapped: false,
  fog: false,
}));

/**
 * The thing you are pointing at, drawn as ITSELF.
 *
 * A frame on the tile answers "which square" and was always standing in for the
 * question anybody actually asks, which is "which of these". It got away with it
 * while the shop was soft-shaded and a flat mark read as a mark. The cel ink
 * ended that: every object in the building now carries a hard contour and reads
 * as solid, so the one flat unlit quad in the frame reads as a UI layer that
 * fell into the picture — and a shelf is drawn most of a tile up-screen of the
 * ground it stands on, so the mark was not even under the thing it named.
 *
 * So the marker is the object's own silhouette, in the marker's colour, sitting
 * just outside the black ink. Nothing is invented and nothing can drift: it is
 * the same meshes, so a highlight can never be next to what it is highlighting.
 *
 * WHAT THIS BUILDS IS NOT THE LINE. It is a stencil of the thing, drawn into a
 * mask the composite dilates — see `MARK` in look.js for why the line cannot be
 * geometry on this art, and what was built and thrown away first. So these
 * meshes are flat flags on a layer of their own, and nothing in the main pass
 * ever sees them.
 *
 * The geometry is BORROWED and never cloned. A hover is a thing that happens
 * every time the pointer crosses a shelf, and cloning a welded unit's buffers
 * at that rate is a stall you would feel as the pointer moving; sharing them is
 * free, and `disposeGroup` is told so it cannot free the shelf on the way out.
 *
 * @param {THREE.Object3D|Array} source  the fixture's own group, in `staticRoot`
 *        — or SEVERAL groups, for the one fixture whose art is not all in one
 *        place. A plot's frame is its catalog model and a plot's *bed* is built
 *        by `syncPlots` into `actorRoot`, so asking the fixture art alone rings
 *        one edging plank and calls it a bed.
 * @param {THREE.Vector3}  origin  where the returned group will stand, so the
 *        clones can carry their offsets relative to it. The TILE rather than the
 *        art, and unrotated, because work spots are added to this group as
 *        children and they are already computed in world axes.
 * @param {string} mode  a `MARKER_LOOK` key. A look with no `mark` channel gets
 *        no contour and the caller keeps its frame — which is how `kin` stays a
 *        frame without a second decision anywhere: seventeen contours at once
 *        is a shop painted in teal, and that marker already gave up weight
 *        rather than legibility for exactly this reason.
 * @param {?function} skip  parts not to include. Moving ones, because the mask
 *        is built once and a blade turns under it — the same rule
 *        `collectEdges` keeps for the ink itself.
 */
export function buildContour(source, origin, mode = 'aim', skip = null) {
  const look = MARKER_LOOK[mode] ?? MARKER_LOOK.aim;
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (look.mark == null || !sources.length) return null;

  for (const s of sources) s.updateMatrixWorld(true);
  const g = new THREE.Group();
  g.userData.color = look.color;
  // What `setMarkedSet` and the Ink pass both ask, rather than re-deriving it
  // from what is inside: an empty mask pass is a full traversal of the scene
  // graph for a texture nothing wrote to.
  g.userData.mark = true;
  const rel = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);

  const take = (o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    // An invisible hit volume is not art. The lift keeps one shaft-sized box so
    // the pointer has something to catch, and stencilled it would ring a
    // four-metre column round a machine you can see straight through.
    if (o.material?.visible === false || o.material?.opacity === 0) return;
    if (skip?.(o)) return;
    const c = new THREE.Mesh(o.geometry, contourMat(look.mark));
    c.matrixAutoUpdate = false;
    c.matrix.copy(rel).multiply(o.matrixWorld);
    c.castShadow = false;
    c.receiveShadow = false;
    // `clone` brings the FIXTURE's layer with it — every fixture is off layer 0
    // so the eight real lights cannot reach it twice — and this has to be on
    // the one layer the mask pass draws and the main pass does not.
    c.layers.set(MARK.LAYER);
    c.userData.borrowed = true;
    g.add(c);
  };
  for (const s of sources) s.traverse(take);
  return g.children.length ? g : null;
}

/**
 * A square outline lying in the XY plane, drawn as one shape with a hole.
 *
 * A square rather than a circle because the thing being marked stands on a
 * *tile*, and the outline that answers "which one" is the one that agrees with
 * the grid the shop is built on. A circle inside a tile is a smaller shape than
 * its tile, so it reads as a spot on the floor rather than as the square being
 * claimed — and one big enough to contain the tile spills over its neighbours.
 *
 * `half` is the half-width, so 0.5 is exactly a tile. `band` is how thick the
 * line is, drawn inwards.
 */
function frameShape(half, band) {
  const s = new THREE.Shape();
  s.moveTo(-half, -half);
  s.lineTo(half, -half);
  s.lineTo(half, half);
  s.lineTo(-half, half);
  s.closePath();
  const inner = half - band;
  const hole = new THREE.Path();
  hole.moveTo(-inner, -inner);
  hole.lineTo(-inner, inner);
  hole.lineTo(inner, inner);
  hole.lineTo(inner, -inner);
  hole.closePath();
  s.holes.push(hole);
  return s;
}

/**
 * The same square with its sides taken out — four corner brackets.
 *
 * This is the marker that has to coexist with the other one, and shape is what
 * separates them at a glance: brackets and a continuous frame stay legible
 * stacked on one tile in a way that two frames, or two colours of the same
 * frame, do not. `arm` is how far each leg runs from its corner.
 */
function cornerShapes(half, band, arm) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const s = new THREE.Shape();
    const x = sx * half;
    const y = sy * half;
    s.moveTo(x, y);
    s.lineTo(x - sx * arm, y);
    s.lineTo(x - sx * arm, y - sy * band);
    s.lineTo(x - sx * band, y - sy * band);
    s.lineTo(x - sx * band, y - sy * arm);
    s.lineTo(x, y - sy * arm);
    s.closePath();
    return s;
  });
}

/**
 * What each marker looks like.
 *
 * The geometry is the load-bearing part, not the colours. Two of these can be
 * marking the *same* tile — the thing under your pointer is very often the
 * thing whose menu is open — so one is a frame and the other is brackets, and
 * only the pointer's carries the chevron. Two rings of the same size meant the
 * selection vanished the moment you pointed at it, which is exactly the case
 * you most want it in.
 *
 * Both now claim the whole tile rather than a coin in the middle of it. The
 * original ring was 1.3 tiles across, which on a three-tile aisle overlapped
 * the shelves either side of the one it was answering about.
 */
const MARKER_LOOK = {
  // Amber is "this is what you are pointing at". Red is the same sentence with
  // a bulldozer in your hands, and the outline is the only warning that arrives
  // before the tap rather than after it.
  // `mark` is which channel of the contour mask this writes, and having one at
  // all is what opts a look into being drawn round the object rather than on
  // the floor. See `MARK` in look.js — the two the composite draws narrow.
  aim: { color: 0xffd66b, half: 0.45, band: 0.08, chevron: true, mark: 0 },
  raze: { color: 0xe2564a, half: 0.45, band: 0.08, chevron: true, mark: 2 },
  // The one whose menu is open. Cool, because it is not a verb — nothing is
  // about to happen to it, it is simply the thing you are reading about — and
  // pushed out to the tile edge, so the aim frame sits inside it.
  // ...and the WIDE one, so the aim band sits inside it exactly as the aim
  // frame sat inside the selection brackets.
  selected: { color: 0x5fd6c4, half: 0.5, band: 0.07, arm: 0.24, chevron: false, mark: 1 },
  // "This would take what you are holding." The only one with no outline on
  // the ground, because it is the only one that appears in *numbers* — eight
  // of these at once, and eight squares painted on the floor is a shop you
  // cannot read. A chevron floats over the thing and stacks visually the way a
  // row of signposts does.
  //
  // SOLID is a top-up: the unit already holds this, or is ticked for it, and
  // the press lands on a board that is already standing. See `stockOpen` for
  // the other half — the two were one marker for as long as this existed, and
  // what that cost is in `stockRefills`.
  stock: { color: 0x7cc46a, chevron: true, outline: false },
  // ...and the same signpost for a unit where the press would OPEN a board.
  //
  // Hollow rather than a second colour, and that is this table's own rule: the
  // geometry is the load-bearing part. A new green would be a third vocabulary
  // to learn, and these two are not two answers — they are one answer with a
  // consequence attached, so they have to read as the same marker at different
  // weights. It is `kin`'s trade exactly: keep the silhouette, give up the
  // fill.
  //
  // Both halves, deliberately. The outline alone is one pixel wide and WebGL
  // ignores `lineWidth`, so at the far end of a shop it is a marker that has
  // gone out; the ghosted fill alone is a solid chevron somebody turned down,
  // which reads as distance rather than as a different sentence. Together the
  // edge holds it legible when it is small and the missing fill is what you
  // actually read when it is near.
  stockOpen: { color: 0x7cc46a, chevron: true, outline: false, fade: 0.3, edges: true },
  // Somebody the pointer is over. Amber, because it is the same sentence the
  // aim frame says — "this is what you are pointing at" — and tighter, because
  // a person occupies about a third of a tile and a tile-sized frame under one
  // in an aisle rings the shelf behind them as well.
  person: { color: 0xffd66b, half: 0.34, band: 0.07, chevron: true },
  // The one whose menu is open, said about somebody rather than about a shelf.
  // It is `selected` and `person` crossed, and both halves are load-bearing:
  // the teal because it is not a verb — nothing is about to happen to them,
  // they are the thing you are reading about — and the tighter frame because a
  // person occupies about a third of a tile. Corner arms rather than a closed
  // frame for the same reason `selected` has them: the amber aim frame has to
  // be able to sit inside it when you point at the hire you already opened.
  personSelected: { color: 0x5fd6c4, half: 0.38, band: 0.07, arm: 0.2, chevron: false },
  // One pile of goods on a unit that holds several. The same amber as the aim
  // frame, because it is the same sentence — and with no chevron, which is the
  // only thing separating the two: the arrow is drawn well clear of the box it
  // belongs to, and on a shelf that is over the *unit*, which is precisely the
  // answer a board marker is not giving. Nothing else about a cage cares.
  board: { color: 0xffd66b, chevron: false },
  // ...and the pile you PRESSED, which is a different sentence about the same
  // box. Teal for the reason `selected` is teal — nothing is about to happen to
  // it, it is the thing you are working out of — and it is the only way the
  // decision is visible at all: a pick has no deadline and outlives the pointer,
  // so lent the amber cage it would be a promise about a press, drawn on a shelf
  // nobody is pointing at. Two cages can be up at once and they answer two
  // questions: amber is where your hand is, teal is what you picked. On the same
  // pile the amber sits inside the teal, exactly as the aim frame sits inside
  // the selection ring on a unit.
  boardPicked: { color: 0x5fd6c4, chevron: false, grow: 0.05 },
  // Every other one LIKE the one you have picked, while Shift is held. The
  // `selected` teal, because teal is what pressing one would make it — a second
  // colour here would be a third vocabulary for the player to learn about a
  // marker that is only ever on screen while a key is down.
  //
  // Thin and faded, and that is the whole of what separates it: this is the one
  // marker that appears in *numbers* on the ground, seventeen at a time in a
  // shop full of shelving, and `stock` solved the same problem by dropping its
  // outline entirely. A chevron cannot do it here — the question is "which
  // squares", so the answer has to be on the squares — so it stays a frame and
  // gives up weight instead. Full-strength it reads as a grid painted over the
  // shop rather than as some shelves being marked.
  kin: { color: 0x5fd6c4, half: 0.5, band: 0.04, chevron: false, fade: 0.34 },
  // What the tour is pointing at. Green because it is nobody's verb — the
  // amber, teal and red are all sentences about a press you are making, and
  // this one is the game talking — and it is the one marker with no `mark`
  // channel it could have had: the mask carries three, RGB, and they are spoken
  // for. So it stays a frame on the tile, which is also the only answer that
  // covers all three things the tour points at, since a bare square of floor
  // has no art to draw a contour round.
  tutor: { color: 0x6fcf68, half: 0.5, band: 0.09, chevron: true },
};

/**
 * The "you can do something to this" marker.
 *
 * Once actions need a deliberate hold, being in range stops being self-evident —
 * nothing happens, so without this the game just feels unresponsive. An outline
 * on the ground under the thing, plus a floating chevron, says *which* object
 * your hold would land on, which matters when a shelf, a till and a pallet are
 * all within arm's reach of each other.
 */
export function buildTargetMarker(mode = 'aim') {
  const g = new THREE.Group();
  const look = MARKER_LOOK[mode] ?? MARKER_LOOK.aim;
  // Published so whoever hangs something else off this marker can match it
  // rather than re-declare it — see `setSelectedTarget` and its working spots.
  g.userData.color = look.color;

  // `outline: false` is a marker that only floats. Whoever animates one has to
  // cope with `userData.ring` being absent, the same way it does the chevron.
  if (look.outline !== false) {
    const ring = new THREE.Mesh(
      new THREE.ShapeGeometry(look.arm
        ? cornerShapes(look.half, look.band, look.arm)
        : frameShape(look.half, look.band)),
      new THREE.MeshBasicMaterial({
        // `fade` is for the one look that is drawn in numbers — see `kin`.
        color: look.color, transparent: true, opacity: look.fade ?? 0.9,
        side: THREE.DoubleSide, depthTest: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.renderOrder = 9;
    g.add(ring);
    g.userData.ring = ring;
  }

  // A little downward chevron bobbing over the target. Whoever animates this
  // has to cope with it being absent — a marker that says "this is open"
  // rather than "this is armed" points at nothing.
  if (look.chevron) {
    const arrow = new THREE.Mesh(GEO.cone, new THREE.MeshBasicMaterial({
      // `fade` is a marker drawn at reduced weight — the ring above reads it
      // for the same reason. On a look with no ring it is the chevron's.
      color: look.color, transparent: true, opacity: look.fade ?? 0.95, depthTest: false,
    }));
    arrow.scale.set(0.26, 0.3, 0.26);
    arrow.rotation.x = Math.PI;
    arrow.renderOrder = 10;
    // A CHILD of the arrow rather than of the group, which is the whole reason
    // this is not two objects: `animate` bobs `userData.arrow.position.y` and
    // nothing else, so an outline hung beside it would sit still while the
    // chevron it belongs to floated out from under it.
    if (look.edges) {
      const wire = new THREE.LineSegments(CONE_EDGES, new THREE.LineBasicMaterial({
        color: look.color, transparent: true, opacity: 0.95, depthTest: false,
      }));
      wire.renderOrder = 11;
      arrow.add(wire);
    }
    g.add(arrow);
    g.userData.arrow = arrow;
  }
  return g;
}

/**
 * The same signpost, for a target that is off the edge of the screen.
 *
 * A chevron over a shelf answers "which one" and says nothing at all about a
 * shelf you cannot see — and the shop is bigger than the view at any zoom worth
 * playing at, so an armful of bread routinely lights up units that are simply
 * not on screen. What you are left looking at is a shop with nowhere to put
 * anything, which is the same picture as a shop with nowhere to put anything.
 *
 * So the marker gets pushed to the frame and turned to point at what it belongs
 * to — the off-screen indicator every game with a map bigger than its camera
 * has. It is the same cone and the same green on purpose: it is not a second
 * kind of readout, it is the *same* readout, seen from too far away.
 *
 * Built pointing along +Y in its own space, so whoever places it turns it with
 * one rotation about the view axis. Flattened on z because it is only ever seen
 * face on — a solid cone at the screen edge picks up its own shading and reads
 * as a lump rather than as an arrowhead.
 */
export function buildEdgeArrow(color = 0x7cc46a) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95, depthTest: false,
  });
  const head = new THREE.Mesh(GEO.cone, mat);
  head.scale.set(0.8, 1, 0.2);
  head.renderOrder = 14;
  g.add(head);
  // A stub of a tail. The head alone is a triangle, and a triangle at the edge
  // of the screen is as much a warning sign as a pointer; the tail is what makes
  // it read as travelling that way.
  const tail = new THREE.Mesh(GEO.box, mat);
  tail.scale.set(0.26, 0.42, 0.2);
  tail.position.y = -0.62;
  tail.renderOrder = 14;
  g.add(tail);
  return g;
}

/**
 * The ring that spreads out from where you pressed.
 *
 * Ordering a walk is the one input in the game with nothing to look at: the
 * character sets off, but a route across the shop starts with a step that
 * looks like any other, and pressing somewhere off screen looks like pressing
 * nothing at all. So the press answers on the spot, before the server has been
 * asked anything — this is drawn from the tile you pressed, not from the route
 * that comes back, because feedback that waits for a round trip is feedback
 * that arrives after you have already pressed again.
 *
 * Flat on the ground and unlit, like every other readout here. Sized by the
 * caller each frame; this only builds the shape.
 */
export function buildRipple(color = '#ffd66b') {
  // A square rather than a disc, for the reason `buildStamp` gives: what you
  // pressed is a TILE, and the ground it spreads over is a grid of them, so a
  // circle is the one shape on this floor that agrees with nothing under it.
  //
  // Thin-walled, so scaling it up reads as a wave spreading rather than as a
  // block growing. The geometry is unit-sized — one span is one tile, the same
  // convention the stamp uses, which is what makes `RIPPLE_TO` readable as a
  // width. The wall thickness is therefore a *proportion*, so shrinking the
  // ripple thins the line by the same factor: 0.16 of the half-span rather than
  // the stamp's 0.1, because this one ends up well under a tile across and
  // shrinking it again in weight turns "smaller" into "fainter".
  return groundFlash(new THREE.ShapeGeometry(frameShape(0.5, 0.16)), color);
}

/**
 * The square that closes on a tile something was just built on.
 *
 * The same throwaway ground mark as the press ripple, which is why it shares
 * one shape and one animator — and the opposite motion, which is the whole
 * point. A ripple spreads *out* because a walk order is something leaving your
 * finger; a build is something arriving, so this comes in and stops dead on
 * the tile. It is a square rather than a circle for the same reason the aim
 * marker is: what landed is a tile-shaped object, and a circle closing on a
 * square unit misses its corners at the moment it is meant to agree with it.
 *
 * Unit-sized like the ripple, so `to: 1` is exactly one tile.
 */
export function buildStamp(color = '#7cc46a') {
  return groundFlash(new THREE.ShapeGeometry(frameShape(0.5, 0.1)), color);
}

/**
 * The mark on the floor that says which of these is a person you are driving.
 *
 * A body at this camera pitch is about forty pixels of colour standing on a
 * floor that is also colour, in a shop full of other bodies the same size — so
 * "where am I" is a question you answer by moving and watching what moves. The
 * ring answers it standing still, and in a co-op shop it answers "which one is
 * mine" as well, which is why it takes the player's own colour rather than one
 * highlight colour for everybody.
 *
 * Two frames rather than one, and the pale outer one is the half that does the
 * work: the shop floor is cream and every player colour is a mid tone, so a
 * single frame vanishes against pale ground exactly where a shop is brightest.
 * The white sits under the colour like a sticker's border, so there is always
 * an edge whatever it is standing on.
 *
 * Square, for the reason the stamp and the press ripple are: this floor is a
 * grid, every mark on it that means anything is tile-shaped, and a disc is the
 * one outline down here that lines up with nothing around it. It is also what
 * lets it be SMALLER without going faint — a square set inside a tile still
 * reaches the corners a circle of the same footprint gives away.
 *
 * `depthTest` stays ON, unlike the ripple's — this one is permanent, and a
 * permanent mark that ignores depth is a mark drawn on top of every shelf you
 * walk behind. `depthWrite` is off so the two frames do not z-fight each other.
 *
 * ...and THAT is what decides the height, which is the whole of why the first
 * version of this was invisible. Ground is not a plane: every tile kind is a
 * slab of its own depth (`TILE_STYLE`), drawn from 0 up — shop floor 0.06, the
 * pads 0.07, a bed 0.08 — so a mark laid at 0.035 is not lying on the floor, it
 * is INSIDE it, and a depth test does exactly what it is meant to. The ripple
 * gets away with 0.07 because it ignores depth entirely. This has to clear the
 * tallest ground anybody can stand on and nothing more: high enough to be on
 * top of a bed, low enough to still read as under the feet of the person
 * standing on it.
 */
export function buildFootMark(color = '#5b8ff9') {
  const g = new THREE.Group();
  const ring = (geo, c, opacity, order) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(c),
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = order;
    g.add(m);
    return m;
  };
  // The outer edge is the body's own footprint plus a little — big enough to
  // read as a frame around them rather than as a box they are wearing, small
  // enough that two people stood at one counter do not overlap. Thin, because
  // this is a thing you notice rather than a thing you look at: it is answering
  // "which of these is me" for somebody who is reading the SHOP, so a heavy
  // mark wins that question by becoming the loudest object on the floor.
  //
  // 0.68 across, where the ring it replaced was 0.88: the corners still reach
  // about as far as that ring's edge did, so the mark holds its size on the
  // diagonal while giving back the width that made it the biggest thing on the
  // tile. The colour frame nests strictly inside the white one, leaving a pale
  // edge on both sides of it.
  ring(new THREE.ShapeGeometry(frameShape(0.34, 0.045)), '#ffffff', 0.22, 3);
  ring(new THREE.ShapeGeometry(frameShape(0.33, 0.025)), color, 0.5, 4);
  // ...and a wash inside it, which is what makes the person read as lit from
  // below rather than as standing in a drawn square. Very faint on purpose: any
  // stronger and it fights the shadow that is also under them.
  ring(new THREE.PlaneGeometry(0.59, 0.59), color, 0.07, 2);
  g.position.y = 0.095;
  return g;
}

/**
 * A flat unlit outline on the ground, scaled and faded by whoever owns it.
 *
 * Both ground marks are the same object with a different outline and a
 * different pair of endpoints, so the difference between them is a geometry
 * argument rather than a second copy of the render settings — `depthTest:
 * false` and a `renderOrder` above the markers are what stop either of them
 * being swallowed by the floor they are lying on, and getting that wrong in
 * only one of two copies is a bug you see once and never reproduce.
 */
function groundFlash(geo, color) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 11;
  g.add(ring);
  g.position.y = 0.07;
  g.userData.ring = ring;
  return g;
}

/**
 * Mark a readout as something that must keep facing the camera.
 *
 * A readout is aimed at the *player*, not at the world, so its orientation is
 * a fact about where you are sitting rather than about where it is standing.
 * These were all built with a corner baked in — `rotation.y = π/4` and
 * friends — which is correct for exactly one of the four views the camera has,
 * and turns a growth bar edge-on into an unreadable green splinter in the
 * other three. Easy to miss, because the shop itself looks perfect from every
 * corner: the bug is only on the things that are not part of the shop.
 *
 * Recording the base *quaternion* rather than a Euler angle is what lets the
 * ring come along. Its base is a tilt about X as well, and yaw folded into the
 * middle of an XYZ Euler is not the same rotation as yaw applied after one —
 * the bar would look right and the ring would tumble. `Scene.faceReadouts`
 * composes `Ry(camAngle) · base`, which preserves any base you like.
 */
export function faceCam(obj) {
  obj.userData.faceCam = obj.quaternion.clone();
  return obj;
}

/**
 * How big the charge ring is, in tiles — inner and outer radius.
 *
 * A quarter of what it was. At 0.42–0.60 it was 1.2 tiles across: wider than
 * the person wearing it and wider than the shelf they were working, so the one
 * thing you wanted to watch while an action ran was the thing the timer sat on
 * top of. A charge meter is a glance, not a subject.
 *
 * An eighth was the first cut and read as a speck — the sweep is the whole
 * point of a ring, and past a certain smallness you cannot tell a quarter full
 * from a half. Proportions are kept either way; roughly 19px across at the
 * default zoom.
 */
const RING_INNER = 0.105;
const RING_OUTER = 0.15;

/**
 * A radial charge-up meter that floats over whoever is mid-action. Built from
 * a ring geometry whose sweep we rewrite each frame, so it reads as filling up
 * rather than just changing colour.
 */
export function buildProgressRing(color) {
  const g = new THREE.Group();

  const track = new THREE.Mesh(
    new THREE.RingGeometry(RING_INNER, RING_OUTER, 32),
    new THREE.MeshBasicMaterial({
      color: 0x3a3128, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthTest: false,
    }),
  );
  const fill = new THREE.Mesh(
    new THREE.RingGeometry(RING_INNER, RING_OUTER, 32, 1, Math.PI / 2, 0.001),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true,
      side: THREE.DoubleSide, depthTest: false,
    }),
  );
  track.renderOrder = 9;
  fill.renderOrder = 10;
  g.add(track, fill);
  g.userData.fill = fill;
  // Sprites always face the camera; a ring doesn't, so tilt it to match the
  // isometric view instead of having it edge-on and invisible.
  g.rotation.set(-Math.PI / 4, Math.PI / 4, 0);
  faceCam(g);
  return g;
}

/** Rewrite the ring's sweep. `t` is 0..1. */
export function setRingProgress(group, t) {
  const fill = group.userData.fill;
  if (!fill) return;
  const sweep = Math.max(0.001, Math.min(1, t) * Math.PI * 2);
  fill.geometry.dispose();
  // Sweep clockwise from the top, which is how every other progress ring reads.
  fill.geometry = new THREE.RingGeometry(RING_INNER, RING_OUTER, 32, 1, Math.PI / 2 - sweep, sweep);
}

const BAR_W = 0.62;
const BAR_H = 0.1;

let barMats = null;
/**
 * Unlit and depth-tested off, like the progress ring: these are readouts, not
 * scenery, and a crop bar that a leaf can hide is a crop bar you check by
 * walking over — which is the errand it exists to remove.
 */
function barMaterial(kind) {
  if (!barMats) {
    const flat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity, depthTest: false,
    });
    barMats = { track: flat('#2f2a22', 0.55), fill: flat('#7cc46a'), ripe: flat('#ffd66b') };
  }
  return barMats[kind];
}

/**
 * A slim bar that fills as something grows, to hang over a crop.
 *
 * Rotated 45° about Y so it faces the isometric camera square-on. The progress
 * ring tilts about X as well, but a bar must not: its *width* is the reading,
 * and tipping it back foreshortens exactly the axis you are trying to judge.
 */
export function buildGrowthBar() {
  const g = new THREE.Group();

  const track = new THREE.Mesh(GEO.box, barMaterial('track'));
  track.scale.set(BAR_W + 0.06, BAR_H + 0.05, 0.02);
  track.renderOrder = 9;

  const fill = new THREE.Mesh(GEO.box, barMaterial('fill'));
  fill.renderOrder = 10;

  g.add(track, fill);
  g.userData.fill = fill;
  g.rotation.y = Math.PI / 4;
  faceCam(g);
  setGrowthBar(g, 0);
  return g;
}

/** Rewrite how full the bar is. `t` is 0..1. */
export function setGrowthBar(group, t) {
  const fill = group.userData.fill;
  if (!fill) return;
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  const w = Math.max(0.004, BAR_W * k);
  fill.scale.set(w, BAR_H, 0.04);
  // Grow from the left edge, not out from the middle.
  fill.position.x = -BAR_W / 2 + w / 2;
  // A last-stretch colour change, so "nearly" is visible without reading length.
  fill.material = barMaterial(k >= 0.85 ? 'ripe' : 'fill');
}

/**
 * The symbol painted in the middle of a job pad, laid FLAT on the ground.
 *
 * A sprite is the wrong object here and it is worth saying why, because there is
 * one right underneath this comment doing nearly the same thing. A sprite always
 * faces the camera, which is what a crate's count wants — you read it, and a
 * thing you read should never be at an angle. This is paint. It lies on the
 * floor, it turns with the shop when the view turns, and it foreshortens like
 * the tarmac it is on. A billboarded wheelchair standing up out of a parking
 * space would read as a sign somebody had left lying about.
 *
 * Canvas rather than geometry, which is the opposite of the call `addStripes`
 * makes about a crossing — and the difference is what the mark has to SAY. A
 * stripe is a shape you could build out of two boxes; a symbol is a drawing, and
 * a drawing assembled out of flat-shaded cuboids is a puzzle rather than a sign.
 * There is exactly one of these per painted region, so the texture it costs is
 * per pad and not per cell.
 */
/** How much of the pad shows through its own marking. See the material below. */
const PAD_MARK_ALPHA = 0.5;

export function buildPadGlyph(glyph, ink) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  paintGlyph(ctx, canvas, glyph, ink);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    // Paint that has been walked on, rather than a sticker.
    //
    // Baking the mark into the ground light (see `addPadMarks`) puts it under
    // the same lamp as the pad and does not touch how it sits ON it: full alpha
    // is a fresh, opaque marking, and against a pad that is a soft mid-tone
    // that still reads as a bright panel laid over the floor rather than as
    // something painted into it. Letting the pad through is what makes it a
    // marking — the same call `PAINT` makes about a wall finish and `stripes`
    // about a crossing.
    //
    // One number, here, on purpose: it is the only thing anybody will ever want
    // to turn, and every glyph in `paintGlyph` is authored at full ink so that
    // none of them has its own opinion about how loud it is.
    opacity: PAD_MARK_ALPHA,
    // Paint on ground that is already drawn: writing depth would let the mark
    // hide the goods standing on the pad, and the pad is the one piece of ground
    // in the shop with things stacked all over it.
    depthWrite: false,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * The four symbols, drawn with a pen rather than authored.
 *
 * Deliberately crude and deliberately not letters. What a pad does is a thing
 * you should know at a glance from across the shop at a 40° camera, and at that
 * size a word is a grey smudge — which is the same argument `paintText` makes
 * about three names on one crate, arriving from the other end.
 */
function paintGlyph(ctx, canvas, glyph, ink) {
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = S * 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  /**
   * A crate on a lid line, and a down arrow through it, is what these two were
   * — and between them they drew an E and a small window. Both were built out of
   * thin strokes, which is the half that decided it: this is paint lying flat
   * under a 40° camera, so a 0.09 line is the first thing foreshortening eats,
   * and what survives of an outline at that angle is its silhouette. So both are
   * FILLED now, and both say the thing itself rather than an abstraction of it —
   * a bay is where the lorry goes, a drop-off is where the boxes pile up.
   *
   * Neither can be a letter, and neither can be a subtle drawing: the mark turns
   * with the shop, so it is read at four different yaws, and the only thing that
   * survives all four is a chunky shape with a distinctive outline.
   */
  if (glyph === 'load') {
    /**
     * A lorry, side on, as ONE closed path — wheels included, as bumps along the
     * underside rather than as circles sitting under it.
     *
     * That is the whole lesson from the version before this one, which drew the
     * same lorry as four separate fills: a trailer, a cab and two wheels. Read
     * flat, at a 40° camera, on a plane that is already foreshortened to a
     * diamond, four disjoint shapes do not assemble into a vehicle in anybody's
     * eye — they read as four blobs, and the gaps between them are as big a
     * visual feature as the parts. A silhouette holds together because the
     * OUTLINE is the information, and an outline cannot be broken into pieces.
     *
     * So: nothing here lifts the pen. Anything that would have been a detail
     * inside the shape is left out instead of drawn small.
     */
    ctx.beginPath();
    ctx.moveTo(S * 0.08, S * 0.28);
    ctx.lineTo(S * 0.60, S * 0.28);
    ctx.lineTo(S * 0.60, S * 0.40);
    ctx.lineTo(S * 0.79, S * 0.40);
    ctx.lineTo(S * 0.92, S * 0.53);
    ctx.lineTo(S * 0.92, S * 0.66);
    ctx.lineTo(S * 0.84, S * 0.66);
    ctx.arc(S * 0.74, S * 0.66, S * 0.10, 0, Math.PI);
    ctx.lineTo(S * 0.36, S * 0.66);
    ctx.arc(S * 0.26, S * 0.66, S * 0.10, 0, Math.PI);
    ctx.lineTo(S * 0.08, S * 0.66);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (glyph === 'stock') {
    /**
     * Three crates stacked, two down and one across the join — and OUTLINED
     * rather than filled, which is the opposite call to the lorry above and is
     * made for the same reason.
     *
     * A lorry is a thing you know by its outline, so a solid one reads. A crate
     * is a thing you know by being a box, and three solid boxes are three
     * rectangles — which is what the last attempt drew, along with a cleared
     * strip across each one to suggest a lid, so what actually landed was six
     * pale bars in a grid. Stroked, the shape says box because you can see into
     * it, and the shared edges between the three say stack.
     *
     * They TOUCH rather than sitting a hair apart. A gap is the thing that broke
     * the lorry, and at this size it would separate the pile into three objects
     * that happen to be near each other.
     */
    ctx.lineWidth = S * 0.075;
    ctx.strokeRect(S * 0.16, S * 0.50, S * 0.34, S * 0.34);
    ctx.strokeRect(S * 0.50, S * 0.50, S * 0.34, S * 0.34);
    ctx.strokeRect(S * 0.33, S * 0.16, S * 0.34, S * 0.34);
    return;
  }
  if (glyph === 'charge') {
    // A bolt. The crew are machines, so a break is a charge — the one pad that
    // holds people rather than goods, and the one symbol here that is about
    // them rather than about stock.
    ctx.beginPath();
    ctx.moveTo(S * 0.58, S * 0.12);
    ctx.lineTo(S * 0.3, S * 0.55);
    ctx.lineTo(S * 0.5, S * 0.55);
    ctx.lineTo(S * 0.42, S * 0.88);
    ctx.lineTo(S * 0.72, S * 0.44);
    ctx.lineTo(S * 0.52, S * 0.44);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (glyph === 'culture') {
    /**
     * A flask, as ONE closed filled path — the lorry's rule rather than the
     * crate's, and for the lorry's reason: what survives a 0.09 stroke lying
     * flat under a 40° camera is a silhouette, and this shape has a waist,
     * which is the most distinctive outline in the set.
     *
     * It is the one mark here with an UP, which was the argument against it and
     * is worth recording as a decision rather than an oversight. The paint turns
     * with the shop, so at the far quarter this reads as a funnel — and a funnel
     * over a deck that feeds vats is not a wrong sentence, where a lorry read
     * backwards or a P upside down would be. The three yaw-proof alternatives
     * were a ring, which the set can only spend once and which sinters to a dot
     * at distance, and a hex cluster, which is a beehive — a pen this feature
     * retired.
     */
    ctx.beginPath();
    ctx.moveTo(S * 0.38, S * 0.10);
    ctx.lineTo(S * 0.62, S * 0.10);
    ctx.lineTo(S * 0.62, S * 0.37);
    ctx.lineTo(S * 0.89, S * 0.85);
    ctx.lineTo(S * 0.11, S * 0.85);
    ctx.lineTo(S * 0.38, S * 0.37);
    ctx.closePath();
    ctx.fill();
    return;
  }
  // Parking. The one place a letter IS the symbol, because it is the letter
  // every car park on earth already uses.
  ctx.font = `bold ${Math.round(S * 0.78)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', S * 0.5, S * 0.54);
}

/** Any short string, hung in the air so it stays readable over any background. */
export function buildTextSprite(text, { fill = '#ffffff', scale = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  paintText(ctx, canvas, text, fill);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.scale.set(1.1 * scale, 0.41 * scale, 1);
  sprite.renderOrder = 10;
  // What it says and what it needs to say it again, so a label whose number
  // changes can be rewritten rather than rebuilt — see `setTextSprite`.
  sprite.userData.text = { canvas, ctx, tex, fill, said: text };
  return sprite;
}

/**
 * Rewrite what a sprite says, in place.
 *
 * A sprite owns a canvas, a texture and a material, and `disposeGroup` frees
 * meshes rather than sprites — so a label rebuilt every time its number moved
 * would leak all three on every sale. A till taking money is exactly the label
 * that changes most, which is why this exists at all.
 *
 * Returns early when nothing changed, so callers can hand it the current value
 * every frame without repainting a canvas sixty times a second.
 */
export function setTextSprite(sprite, text) {
  const t = sprite?.userData?.text;
  if (!t || t.said === text) return sprite;
  t.said = text;
  paintText(t.ctx, t.canvas, text, t.fill);
  t.tex.needsUpdate = true;
  return sprite;
}

/**
 * The drawing itself, so building one and rewriting one cannot drift apart.
 *
 * `\n` is a real line break. A mixed crate names each pile on its own row, and
 * run together on one line those shrink-to-fit down to about 18px — legible
 * words turned into a grey smear, which is the same failure as clipping wearing
 * a smaller font. Height is a bound as well as width for that reason: the canvas
 * is fixed and the sprite's shape is fixed, so three rows have to be paid for
 * out of the size of each.
 */
function paintText(ctx, canvas, text, fill) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const lines = String(text).split('\n');
  const MAX_W = canvas.width - 20;
  const MAX_H = canvas.height - 12;
  const LEADING = 1.15;

  // Shrunk to fit rather than clipped, on whichever of the two runs out first.
  let px = 58;
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  const wide = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const fit = Math.min(
    wide > MAX_W ? MAX_W / wide : 1,
    MAX_H / (px * LEADING * lines.length),
    1,
  );
  if (fit < 1) {
    px = Math.max(16, Math.floor(px * fit));
    ctx.font = `bold ${px}px system-ui, sans-serif`;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Outline first so the number stays readable against grass or floorboards.
  ctx.lineWidth = Math.max(4, px / 5.8);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.fillStyle = fill;

  const step = px * LEADING;
  // Centred on the same point one line used to sit on, so a crate that gains a
  // second pile grows in both directions rather than sliding up the box.
  const top = 50 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => {
    ctx.strokeText(line, 128, top + i * step);
    ctx.fillText(line, 128, top + i * step);
  });
}

/**
 * Bake a pile of little meshes down into one mesh per colour.
 *
 * The renderer's cost is per OBJECT, not per triangle: three.js walks the
 * graph, updates a matrix, frustum-culls and sets up a draw call for every mesh
 * in it, every frame — and with shadows on it does the whole lot again for the
 * shadow pass. Nothing here is short of triangles. It is short of *objects*.
 *
 * Stock is where that bites, because the promise is one prop per unit: sixteen
 * on the shelf draws sixteen, which is the entire reason a shelf is worth
 * looking at from across the room, and it means a full unit is ~18 items × the
 * handful of primitives each item is drawn from. A stocked shop is a few
 * thousand meshes that never move relative to one another.
 *
 * So they stop being separate objects and stay exactly the same picture: every
 * geometry is cloned, transformed into the group's own space and merged per
 * material — materials are cached by colour (`material`), so "per material" is
 * "per colour", and a shelf of carrots ends up as two or three draws instead of
 * seventy. The look is identical by construction: same primitives, same
 * positions, same colours.
 *
 * ONLY for things that do not move independently. A part that spins, drifts,
 * or is coloured per-actor has to stay its own object, which is why this is
 * called on stock and crops and on nothing else — welding a machine would weld
 * its blade to its housing.
 *
 * Falls back to the group it was given if the merge cannot be done (mixed
 * indexed and non-indexed geometry, say). A shelf that draws the slow way is a
 * frame-rate question; one that draws nothing is a bug.
 */
export function weld(group, keep = null) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMaterial = new Map();
  const loose = [];

  group.traverse((o) => {
    // A part the caller still needs to move on its own — a blade, a lever —
    // comes through untouched and is re-hung below. Welding one is the whole
    // failure mode this guards: it would be *drawn* correctly and then never
    // turn again, which reads as a machine that has broken rather than as a
    // renderer that has.
    if (keep && o !== group && keep(o)) { loose.push(o); return; }
    if (o.isMesh && o.geometry) {
      const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      // The hue goes INTO the geometry so that colour stops splitting the merge
      // — see `batchMaterial`. The key is everything that is not the colour:
      // how it shades, whether it casts, and which attributes it carries, since
      // merging a geometry that has uvs with one that does not fails silently.
      //
      // Shadow flags come off the source rather than being assumed, and they are
      // part of the key rather than the first one winning — which is what the
      // old material-identity grouping could not say, because two parts of the
      // same colour that disagreed about casting merged and took whichever came
      // first.
      const batch = batchMaterial(o.material);
      const attrs = Object.keys(g.attributes).sort().join(',');
      const key = batch
        ? `b|${batch.uuid}|${o.castShadow ? 1 : 0}|${o.receiveShadow ? 1 : 0}|${attrs}`
        : o.material;
      let rec = byMaterial.get(key);
      if (!rec) {
        rec = {
          parts: [], cast: o.castShadow, receive: o.receiveShadow, mat: batch ?? o.material, hues: batch ? [] : null,
        };
        byMaterial.set(key, rec);
      }
      rec.parts.push(g);
      if (rec.hues) rec.hues.push(o.material.color);
    } else if (o.isSprite) {
      // A label is not geometry and has nothing to merge with. Rehung as-is.
      loose.push(o);
    }
  });
  // Their transforms were relative to a group that is about to be replaced, so
  // they carry the whole chain with them rather than only their own offset.
  for (const o of loose) {
    o.matrix.copy(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    o.matrix.decompose(o.position, o.quaternion, o.scale);
  }
  if (byMaterial.size === 0) return group;

  const out = new THREE.Group();
  out.userData = group.userData;
  for (const [, { parts, cast, receive, mat, hues }] of byMaterial) {
    // The hue, per vertex, before anything is merged — the material this is
    // about to be drawn with is white, so without this every welded prop comes
    // out the colour of paper.
    if (hues) parts.forEach((g, i) => fillColor(g, hues[i]));
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!merged) {
      // Give back the original rather than half a shelf. Everything cloned on
      // the way here is dropped: the group still owns the geometry it was
      // built with, and these were copies. Whatever was already welded into
      // `out` goes too, or the fallback leaks what it just built.
      for (const r of byMaterial.values()) r.parts.forEach((g) => g.dispose());
      disposeGroup(out);
      return group;
    }
    if (merged !== parts[0]) parts.forEach((g) => g.dispose());
    // What the hue WAS, kept beside the attribute that now holds it.
    //
    // `paintLit` multiplies a brightness through this same attribute, and it is
    // re-callable — the shop re-bakes as the light moves. Multiplying in place
    // would compound: dusk over dusk over dusk, until the shop is black. So the
    // baked hue is remembered and every re-bake is hue × brightness from clean.
    //
    // A NEW object rather than a field on the one that is there, because
    // `BufferGeometry.copy` assigns `userData` by reference — so a clone shares
    // it with the geometry it was cloned from, and the primitives here are
    // shared by the whole shop (`GEO`, and `PATH_GEO` over in the renderer).
    // Written in place, one belt would hand its hue to every mesh in the game
    // cut from the same box: the last weld wins, and `paintLit` then paints
    // somebody else's colour wherever the vertex counts happen to agree and
    // falls through to bare brightness — white — wherever they do not.
    if (hues) merged.userData = { ...merged.userData, baseColor: Float32Array.from(merged.attributes.color.array) };
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    out.add(mesh);
  }
  for (const s of loose) out.add(s);
  return out;
}

/* ------------------------------------------------------- the other ink pass */

/**
 * THE CONTOUR AS GEOMETRY, WHICH IS THE THING THE SCREEN-SPACE ONE CAN NEVER BE.
 *
 * `client/render/post.js` finds lines by reading the finished picture, which is
 * why every fixture in the game gets them for nothing and why they can never be
 * sharp: both of its detectors answer one of two numbers per pixel, so the mask
 * is binary and a diagonal comes out as a staircase. See `INK.SHARP` in look.js
 * for the two dead ends — a softer threshold and a supersampled detector — and
 * why FXAA is a treatment rather than a fix.
 *
 * A line that is GEOMETRY has none of that problem, because it is drawn with the
 * shop and resolved by the same `SCENE_SAMPLES` every other edge is. What it
 * costs instead is everything the post pass gets free:
 *
 *   - **One weight, for ever.** WebGL ignores `lineWidth` — every line is one
 *     device pixel whatever the material says — so `INK.FADE` has nothing to act
 *     on and a shelf at the back of the shop is drawn as heavily as the one you
 *     are standing at. That is the opposite of what look.js tuned.
 *   - **Creases only.** An edge exists where two of an object's own faces meet,
 *     so this cannot draw a silhouette against the sky, and it says nothing
 *     about one object standing in front of another.
 *   - **Static only.** A blade that spins takes its lines with it and these do
 *     not move, so anything in `userData.moving` is skipped — a machine with a
 *     drawn line lying where its blade used to be is worse than one with none.
 *
 * So it is not a replacement and is not offered as one. What it is is the half
 * of the drawing that a still frame shows worst: the panel lips of a big flat
 * machine, which are exactly the creases the half-res normals buffer quantises.
 *
 * ONE MERGED `LineSegments` FOR THE WHOLE SHOP, which is the only reason this is
 * affordable at all. `weld` makes the same argument two functions up: the cost
 * is per OBJECT rather than per triangle, and a line per fixture in a furnished
 * shop is ~1,600 more draws. Collected in WORLD space during the fixture loop
 * and merged once at the end, so a stocked shop pays one.
 *
 * `EdgesGeometry` is cached against the geometry it was cut from. Every box in
 * the game is the same shared `GEO.box` behind a scale, so a shop of two
 * thousand parts asks for the edges of a cube once.
 */
const EDGE_CACHE = new Map();

/**
 * Collect one group's edges into `out`, already in world space.
 *
 * `angle` is the crease threshold in degrees — below it two faces are treated as
 * one surface and no line is drawn between them. 24 is chosen against the art
 * rather than by eye: nothing in this game is smooth-shaded, so the only edges
 * under that are the facets of a cylinder, and a barrel wearing every one of its
 * own facets as a hard line reads as a cog.
 */
export function collectEdges(group, out, { angle = 24, skip = null } = {}) {
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // A part that moves on its own would leave its lines behind. See above.
    if (skip && skip(o)) return;
    // Glass, and the same call `buildModel` makes about its shadow: a door you
    // can see through has no business laying down a solid black rectangle. The
    // FRAME round it is opaque and keeps its lines.
    if (o.material?.transparent && (o.material.opacity ?? 1) < 0.9) return;
    let edges = EDGE_CACHE.get(o.geometry.uuid);
    if (!edges) {
      edges = new THREE.EdgesGeometry(o.geometry, angle);
      EDGE_CACHE.set(o.geometry.uuid, edges);
    }
    out.push(edges.clone().applyMatrix4(o.matrixWorld));
  });
}

/**
 * One fixture's contour as ONE geometry, so it can be kept.
 *
 * `collectEdges` answers a geometry per mesh, which is the right unit for the
 * shop-wide merge and the wrong one for a cache: a loader is 31 meshes, and
 * holding 31 buffers per unit to save rebuilding them is bookkeeping nobody
 * wants. Folded here, the cache holds one object per fixture and the shop-wide
 * merge folds ~150 instead of ~2,100.
 */
export function mergeEdges(geometries) {
  if (!geometries.length) return null;
  if (geometries.length === 1) return geometries[0];
  const merged = mergeGeometries(geometries, false);
  if (!merged) return null;
  geometries.forEach((g) => g.dispose());
  return merged;
}

/**
 * Fold everything `collectEdges` gathered into the one object that draws it.
 *
 * `depthWrite` is off and the depth TEST is on, which is the pair that makes
 * this read as a line on a solid thing rather than as a wireframe: the far
 * edges of a box are behind its own front faces and fail the test, so a shelf
 * does not show you its own back corners.
 *
 * ...and the nudge is what stops that pair stippling. An edge sits exactly on
 * the boundary of the faces it belongs to, so at the silhouette the line and
 * the surface are at the SAME depth and which one wins is down to whatever the
 * rasteriser rounds to — which is a line that is drawn for eleven pixels, gone
 * for three, and back for nine. It reads as a dashed line somebody authored.
 * A constant fraction of `w` in clip space is the standard answer and is the
 * one that survives an ortho camera, where a fixed epsilon in view space would
 * be worth a different number of depth units at each end of the shop.
 * `polygonOffset` is the usual tool and is no use here: WebGL only implements
 * `POLYGON_OFFSET_FILL`, so three sets the flag and nothing happens to a line.
 */
export function buildEdgeLines(geometries, color, opacity, { own = true } = {}) {
  if (!geometries.length) return null;
  // `own: false` says the caller is KEEPING what it handed over — the fixture
  // art cache holds one merged contour per unit and re-offers it on every
  // re-flow, so freeing them here would hand back a freed buffer next time.
  // The single-geometry case has to clone for the same reason: the merge is
  // skipped, so the line would otherwise be drawn straight out of the cache's
  // own object and `clearEdgeLines` would dispose it.
  const merged = geometries.length === 1
    ? (own ? geometries[0] : geometries[0].clone())
    : mergeGeometries(geometries, false);
  if (own && merged !== geometries[0]) geometries.forEach((g) => g.dispose());
  if (!merged) return null;
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: opacity < 1,
    opacity,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  gl_Position.z -= 0.0006 * gl_Position.w;',
    );
  };
  return new THREE.LineSegments(merged, mat);
}

/** Free the GPU memory a prop group holds. Materials are shared — don't dispose those. */
export function disposeGroup(group) {
  group.traverse((o) => {
    // `borrowed` is geometry this group does not own: a contour is the FIXTURE's
    // own meshes worn a second time (see `buildContour`), so freeing it here
    // would free the shelf the marker is drawn around — and the shelf is still
    // standing there, now with nothing in its buffers. `SHARED_GEO` protects the
    // primitives for the same reason; this protects a borrowing.
    if (o.isMesh && o.geometry && !o.userData.borrowed && !SHARED_GEO.has(o.geometry)) {
      o.geometry.dispose();
    }
    // A sprite's are NOT shared: `buildTextSprite` draws its own canvas and
    // wraps it in its own texture and material, so nothing else is holding
    // them and dropping the object alone leaks a 256×96 texture. Every crate
    // label in the game has been doing that quietly since crates could stack.
    if (o.isSprite) {
      o.material?.map?.dispose();
      o.material?.dispose();
    }
    // An InstancedMesh keeps its per-instance matrices and colours in buffers
    // of its OWN, beside the geometry rather than in it — so `geometry.dispose`
    // frees the one-tile box and leaves 600 tiles' worth of transforms on the
    // GPU, along with the VAO binding states three.js cached against the
    // object. Nothing collects them: `WebGLObjects.onInstancedMeshDispose` is
    // the only path that calls `attributes.remove`, and it fires on this and
    // nothing else — not on GC, not on removal from the scene.
    //
    // Which made it the most expensive leak in the game, because it is on the
    // one thing that runs constantly: `buildWorld` builds an instanced mesh per
    // tile kind, per floor design and per edge kind, and build mode rebuilds
    // the world on every placement, every wall segment and every floor stroke.
    // An evening of building leaks a few hundred kilobytes a gesture and never
    // gives any of it back, which is the shape of a session that starts at half
    // a gig and ends over one.
    if (o.isInstancedMesh) o.dispose();
  });
}
