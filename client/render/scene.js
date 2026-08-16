/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, FIXTURE_LOOK, EDGE_STYLE, CEILING_Y, GLASS, edgeBands, jitter, faceColor, patternColor } from './palette.js';
import {
  buildModel, buildCharacter, buildStack, buildShelfGoods, shelfSlots, buildBubble, buildCashDrop,
  buildHopperSlots,
  buildTextSprite, buildPallet, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, disposeGroup, material,
  buildGrowthBar, setGrowthBar,
  buildRipple,
  buildStamp,
} from './props.js';
import { T } from '../../shared/tiles.js';
import {
  FIXTURES, anchorTile, canPlace, turn, rot4, groundIndex, groundKindOfTile,
} from '../../shared/build.js';
import { pieceFor, surfaceOf } from '../../shared/pieces.js';
import { Lights, emittersIn } from './lights.js';
import {
  isStaged, stageIndexAt, tierProgress, partsAt, modelHeight, surfacesAt, variantModel,
} from '../../shared/model.js';
import { buildPastimeProp, animateRest } from './pastime.js';

/** How many world tiles fit vertically on screen at 1× zoom. Smaller = closer in. */
const FRUSTUM = 17;

/**
 * Zoom rides on `camera.zoom` rather than on FRUSTUM, so the frustum stays a
 * fixed statement about the world and only resize() ever recomputes it. Three's
 * `unproject` already folds zoom into the inverse projection, which is why
 * pickTile and pickFixture keep working at any zoom without knowing it exists.
 */
const ZOOM_MIN = 0.7;         // wider than the old fixed view, for finding things
const ZOOM_MAX = 2.4;         // close enough to read a single shelf
const ZOOM_DEFAULT = 1.45;    // ~12 tiles tall: the shop, not the whole county
/** Per notch. Multiplicative, so a notch is the same *proportion* in or out. */
const ZOOM_STEP = 1.12;

/**
 * How far the ground runs past the last tile.
 *
 * Sized against the *camera*, not the tile grid: the point is that zooming all
 * the way out can never bring the edge of the world on screen. At ZOOM_MIN the
 * frustum is FRUSTUM/ZOOM_MIN tall (~24 tiles), the camera's ~40° pitch stretches
 * that across the ground by 1/sin(pitch) (~19 tiles from the centre), an ultrawide
 * viewport stretches the other axis by `aspect` again (~36 at 3:1), and the camera
 * rides on the player, who can stand in the very corner of the grid. Corner to
 * corner that's about 41 tiles, so this is that plus honest headroom.
 *
 * It's one box either way — the only thing a bigger apron costs is a bigger
 * number in a geometry constructor. Note `pickTile` intersects a mathematical
 * plane rather than this mesh, so no amount of apron can affect aiming.
 */
const GROUND_MARGIN = 56;

// `MODEL_REPLACES_TILE` retired here. It answered "does this fixture's model
// stand instead of the coloured block its tile drew" — a question that only
// existed while a fixture WAS a tile. Nothing stamps one now, so every fixture
// stands on plain ground and draws its own model on top, and a plot's bed is
// the ground rather than something under a model. See FIXTURE_LOOK in
// palette.js for what an undrawn kind falls back to.

/** Usable width inside a plot's frame, and roughly how wide a crop draws. */
const BED_SPAN = 0.64;
const PLANT_FOOTPRINT = 0.4;
/** Past this a bed just reads as "full"; no authored crop comes close. */
const BED_MAX = 12;

/**
 * A plain coloured box, for a fixture kind nobody has drawn yet.
 *
 * Deliberately the same box its tile used to draw, so the day a kind becomes
 * buildable it looks like it did before fixtures stopped being tiles — rather
 * than being invisible, which is what "no model" would otherwise mean now.
 */
function plainBlock(look) {
  if (!look || look.h <= 0) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, look.h, 1), material(look.color));
  mesh.position.y = look.h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

/** Stable small number from an id, so a bed's scatter survives every rebuild. */
function hashId(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
  return Math.abs(h % 997);
}

/**
 * Where to stand `count` plants in one bed, and how big to draw each.
 *
 * A plot showing a single lettuce when it is about to hand you three is a bed
 * lying about its own worth — so the count comes from the yield the plot rolled
 * when it was sown, and the arrangement has to hold anything from one plant to
 * a full tray without either rattling around or growing through the frame.
 */
function plantSpots(count, seed = 0) {
  const n = Math.max(1, Math.min(BED_MAX, count || 1));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const pitch = BED_SPAN / Math.max(cols, rows);
  const scale = Math.min(1, pitch / PLANT_FOOTPRINT);

  const spots = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    // Centre each row on its own width, so a short final row sits in the
    // middle of the bed rather than hanging off one edge.
    const inRow = Math.min(cols, n - r * cols);
    const c = i - r * cols;
    // Deterministic wobble: a perfectly square grid reads as printed rather
    // than planted, and it must wobble the *same* way every rebuild or the
    // whole bed twitches each time the crop crosses into its next stage.
    const wob = (k) => ((Math.sin(seed * 0.7 + i * 12.9898 + k * 78.233) * 43758.5453) % 1) * pitch * 0.15;
    spots.push({
      x: (c - (inRow - 1) / 2) * pitch + wob(1),
      z: (r - (rows - 1) / 2) * pitch + wob(2),
      scale,
    });
  }
  return spots;
}

/**
 * Where the sun sits relative to whatever the camera is looking at.
 *
 * Deliberately *not* rotated with the view: the sun belongs to the world, so
 * spinning the camera walks you around static shadows instead of dragging them
 * with you. It's the one cue that the rotation is a camera move and not the
 * whole farm turning.
 */
const SUN_OFFSET = new THREE.Vector3(26, 40, 14);

/** The camera's home corner. Rotation swings this around Y in quarter turns. */
const BASE_CAM_OFFSET = new THREE.Vector3(20, 24, 20);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const QUARTER = Math.PI / 2;

/**
 * How much further a tile of ground runs than the screen it covers, going away
 * from you. The camera's pitch is fixed by BASE_CAM_OFFSET (~40°), so this is
 * 1/sin(pitch) — derived rather than typed, so retuning the offset keeps a pan
 * tracking your finger instead of quietly drifting behind it.
 */
const GROUND_STRETCH = BASE_CAM_OFFSET.length() / BASE_CAM_OFFSET.y;

/** How far the view may be shoved off the player it follows, in tiles. */
const PAN_LIMIT = 14;

/** Scratch for aiming readouts at the camera, so no frame allocates one. */
const YAW_Q = new THREE.Quaternion();

/**
 * The press ripple: how long it lives, and the radii it travels between.
 *
 * Short on purpose. This is a receipt for an input, not an effect — long
 * enough to catch out of the corner of your eye while you are already looking
 * somewhere else, short enough that pressing four times in a row does not
 * leave four of them stacked up arguing.
 */
const RIPPLE_MS = 420;
const RIPPLE_FROM = 0.09;
const RIPPLE_TO = 0.46;

/** What the press meant, said in colour. Amber matches the aim marker. */
const RIPPLE_COLORS = { go: '#ffd66b', no: '#e2564a', miss: '#f4efe2' };

/**
 * The stamp: what a fixture does on arriving somewhere.
 *
 * Fired where the thing *landed* rather than where you pressed, which is the
 * one way it differs from every other bit of feedback in here. A press ripple
 * has to beat the round trip because a walk order has nothing else to show for
 * itself; a build already answered the pointer with a green ghost before you
 * committed, so this one's job is the other end — saying the thing is really
 * there. Splitting it across the round trip would draw the mark, wait, and
 * then drop the fixture into it, which reads as two events rather than one
 * impact.
 *
 * The square starts a shop-aisle wide and slams shut on its own tile. Same
 * ease-out the ripple uses, run backwards by swapping the endpoints — fast
 * then settling is what makes a thing read as landing under its own weight.
 */
const STAMP_MS = 300;
const STAMP_FROM = 2.1;
const STAMP_COLOR = '#7cc46a';

/**
 * The drop that lands inside the stamp: fall, then squash, then settle.
 *
 * Two phases because one is not a plop. A model that only scales up arrives
 * without ever having come from anywhere, and one that only falls stops like a
 * lift reaching a floor. `LAND_SQUASH` is a damped bounce on the vertical
 * scale with the horizontal taking the opposite sign, so the thing keeps its
 * volume the way anything soft would.
 *
 * Every model is authored with its base at y=0 — see `buildModel` — so scaling
 * about the group origin squashes it into the floor rather than through it.
 */
const LAND_MS = 340;
const LAND_DROP = 1.2;
const LAND_FALL = 0.42;
const LAND_SQUASH = 0.24;

/**
 * Past this many fixtures moving in one re-flow it is the shop rearranging,
 * not you placing something.
 *
 * A `space` upgrade re-flows the whole building, and a shop where twenty
 * shelves bounce at once reads as the renderer having a fit rather than as
 * anything you did. The cap also covers the first layout of a session for
 * free, though `_fixtureSpots` starting null is what actually says "there was
 * no previous shop to have arrived from".
 */
const STAMP_MAX = 4;



/** Day-cycle endpoints, resolved once so syncState allocates nothing. */
const SKY_HIGH = new THREE.Color(PALETTE.sky);
const SKY_DUSK = new THREE.Color(PALETTE.skyDusk);
const SUN_HIGH = new THREE.Color(PALETTE.sunHigh);
const SUN_DUSK = new THREE.Color(PALETTE.sunDusk);
const FILL_HIGH = new THREE.Color(PALETTE.fillHigh);
const FILL_DUSK = new THREE.Color(PALETTE.fillDusk);

export class Scene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Required so the MCP screenshot tool can read the canvas back out.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.sky);

    this.camera = new THREE.OrthographicCamera();
    this.camOffset = BASE_CAM_OFFSET.clone();
    // Which corner we're viewing from, counted in quarter turns and never
    // wrapped: letting it run to 4, -1 and beyond means easing toward
    // `camQuarter * QUARTER` always spins the short way round on its own,
    // with no shortest-arc special case.
    this.camQuarter = 0;
    this.camAngle = 0;
    this.camTarget = new THREE.Vector3(22, 0, 17);
    this.camLook = this.camTarget.clone();
    // Whether anybody has claimed the view yet. The camera follows you, and
    // until the first snapshot says where you are it has to look at *something*
    // — which is the shop door, aimed in `buildWorld`. That aim is an opening
    // shot and nothing else: `buildWorld` runs on every re-flow, so without this
    // flag every rotate, move, paint and back-of-house toggle yanked the view a
    // few frames toward the door and let it drift back over the next second.
    // Cheap to miss, because the pull is bounded by how far the door is from
    // where you are standing — at the till it is a twitch, and out on the farm
    // it is half the screen.
    this.camFollowing = false;
    // Where the view has been dragged to, relative to whoever it follows. Kept
    // apart from camTarget because that is overwritten from the player's
    // position every sync — a pan folded into it would be erased 10 times a
    // second. `camAim` is the sum, and exists only so render() adds without
    // allocating a vector every frame.
    this.camPan = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    // What angle the readouts were last aimed at, and whether anything has
    // been built since. Both, because there are two ways to go stale: the
    // camera turns under the existing ones, or a new one is born while the
    // camera is already turned. Missing the second is subtler — the shop is
    // correct, and only the bar on the crop that started growing *after* you
    // turned is edge-on.
    this.readoutAngle = null;
    this.readoutsDirty = true;
    // Live ground marks — press ripples and build stamps, which are one kind of
    // throwaway outline with two sets of endpoints — plus whatever is currently
    // dropping into place, and how far through a held press we are. All pure
    // feedback: nothing in the world reads them, and dropping them all on the
    // floor would change nothing except how the game feels to press.
    this.ripples = [];
    this.landings = [];
    this.holdProgress = null;
    // Where every fixture stood last time the shop was built, so the next build
    // can tell what arrived. Null rather than empty, because "no previous shop"
    // and "a shop with nothing in it" want opposite answers — see `addFixtureProps`.
    this._fixtureSpots = null;
    // Two values, like camTarget/camLook: where the wheel says we're going, and
    // where we've eased to. Set before resize(), which bakes the projection.
    this.camZoom = ZOOM_DEFAULT;
    this.camera.zoom = ZOOM_DEFAULT;

    this.setupLights();

    this.staticRoot = new THREE.Group();
    this.actorRoot = new THREE.Group();
    this.scene.add(this.staticRoot, this.actorRoot);

    this.players = new Map();
    this.customers = new Map();
    this.stationProps = new Map();
    this.shelfProps = new Map();
    this.plotProps = new Map();
    this.cashProps = new Map();
    this.deliveryProps = new Map();
    this.actionRings = new Map();
    this.catalog = { items: {}, crops: {} };
    this.layoutVersion = -1;

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setupLights() {
    // Kept on `this` because the day cycle drives its intensity *and* colour —
    // a fixed white 0.9 fill was most of why the sun was invisible: it swamped
    // everything the sun did, so dusk only ever got very slightly greyer.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(this.ambient);

    const sun = new THREE.DirectionalLight(0xfff4dd, 1.15);
    sun.position.set(26, 40, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 30;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 110 });
    sun.shadow.bias = -0.0012;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    // A cool bounce light so shadowed faces aren't muddy.
    const bounce = new THREE.DirectionalLight(0xbcd8ff, 0.32);
    bounce.position.set(-18, 12, -14);
    this.scene.add(bounce);

    // Whatever the player has wired up. Everything above is the sky; this is the
    // only light in the scene that anybody had to buy.
    this.lights = new Lights(this.scene);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    const aspect = w / h;
    this.camera.left = (-FRUSTUM * aspect) / 2;
    this.camera.right = (FRUSTUM * aspect) / 2;
    this.camera.top = FRUSTUM / 2;
    this.camera.bottom = -FRUSTUM / 2;
    this.camera.near = -200;
    this.camera.far = 400;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /**
   * Zoom by a number of notches — positive pulls out, matching the direction a
   * page scrolls. Clamped, so the wheel can be spun without limit and the view
   * simply stops. Returns the new target so the caller can report it.
   */
  zoomBy(steps) {
    const z = this.camZoom * ZOOM_STEP ** -steps;
    this.camZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    return this.camZoom;
  }

  /**
   * Zoom by a straight ratio, for a pinch.
   *
   * A pinch already *is* a scale — the fingers say 1.3× — so converting that
   * into wheel notches only to raise ZOOM_STEP to a fractional power throws the
   * exactness away and stops the ground tracking the fingers holding it.
   */
  zoomByFactor(f) {
    if (!(f > 0)) return this.camZoom;
    this.camZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camZoom * f));
    return this.camZoom;
  }

  /**
   * Turn the camera a quarter of the way round the world, +1 or -1.
   *
   * Only four corners exist, so the 45° isometric pitch is exactly preserved at
   * every stop — a free-range angle would lose it, and would leave the movement
   * keys mapping onto a direction that no longer means anything.
   */
  rotateView(dir) {
    this.camQuarter += Math.sign(dir);
    return this.camQuarter;
  }

  /** Quarter turns from home, normalised to 0..3, for mapping input. */
  get quarter() {
    return ((this.camQuarter % 4) + 4) % 4;
  }

  /**
   * Shove the view sideways off the person it follows, by a drag in pixels.
   *
   * The camera rides on the player (`camTarget`, set every sync), so this is an
   * offset *added* to that rather than a second camera — the follow keeps
   * working underneath, and letting go of the pan is one line rather than a
   * handover.
   *
   * Two conversions, and both have to be there or the world slides at the wrong
   * speed and stops feeling attached to your finger:
   *
   * - **pixels to tiles** is the ortho frustum over the canvas height, divided
   *   by zoom, because zoom is on the camera rather than on FRUSTUM.
   * - **screen up to ground** stretches by 1/sin(pitch). The camera looks down
   *   at ~40°, so a tile of ground covers only ~0.65 of a tile of screen going
   *   away from you — dragging without this tracks correctly across the screen
   *   and lags going up it, which reads as the ground being slippery.
   *
   * Directions come off `camOffset`, which is already rotated by whatever the
   * view has been turned to, so a pan after a quarter turn follows the finger
   * rather than the world axes.
   */
  panBy(dxPx, dyPx) {
    const upp = (FRUSTUM / this.camZoom) / (this.renderer.domElement.clientHeight || 1);
    const hx = this.camOffset.x;
    const hz = this.camOffset.z;
    const hl = Math.hypot(hx, hz) || 1;
    // Screen-right and screen-up, both on the ground plane.
    const rx = hz / hl;
    const rz = -hx / hl;
    const fx = -hx / hl;
    const fz = -hz / hl;
    const across = -dxPx * upp;
    const away = dyPx * upp * GROUND_STRETCH;
    this.camPan.x += rx * across + fx * away;
    this.camPan.z += rz * across + fz * away;
    // Far enough to see over the shop, not so far the person you are playing is
    // a rumour. Clamped as a radius rather than per-axis so a diagonal pan
    // doesn't reach 1.4× further than a straight one.
    const len = Math.hypot(this.camPan.x, this.camPan.z);
    if (len > PAN_LIMIT) {
      this.camPan.x *= PAN_LIMIT / len;
      this.camPan.z *= PAN_LIMIT / len;
    }
    return this.camPan;
  }

  /**
   * Give the camera back to whoever it follows.
   *
   * Called when you go somewhere rather than when you let go of the drag: a
   * pan that sprang back on release would be useless on a phone, where looking
   * at the far end of the shop and *then* tapping something there is the whole
   * point. So the view stays where you put it, and going anywhere reclaims it.
   * The glide is free — `camLook` already eases toward its aim.
   */
  recentre() {
    this.camPan.set(0, 0, 0);
  }

  /** Has the view been shoved off the player? Lets the HUD offer a way back. */
  get panned() {
    return Math.hypot(this.camPan.x, this.camPan.z) > 0.01;
  }

  /**
   * Answer a press where it happened: a ring that spreads and fades.
   *
   * Fired from the tile you pressed rather than from the route the server
   * plans, because the whole job of this is to be instant. A confirmation that
   * waits for a round trip arrives after you have already pressed again, which
   * is the state it exists to prevent.
   *
   * `kind` picks what the press *meant*, so the colour is information rather
   * than decoration: amber for a walk, red for a refusal, white for a press
   * that landed on nothing.
   */
  ripple(x, z, kind = 'go') {
    const color = RIPPLE_COLORS[kind] ?? RIPPLE_COLORS.go;
    const g = buildRipple(color);
    g.position.set(x, 0.07, z);
    this.actorRoot.add(g);
    // Born at the moment of the press, not at the next frame: `render` reads
    // the age off this, and a ripple that starts its life a frame late starts
    // it visibly grown.
    this.ripples.push({ g, born: performance.now(), ms: RIPPLE_MS, from: RIPPLE_FROM, to: RIPPLE_TO });
    return g;
  }

  /**
   * Slam a square shut on a tile, and drop what is standing on it into place.
   *
   * The two halves are one effect and are fired together for that reason — a
   * mark on the ground with nothing landing in it is a scorch, and a fixture
   * bouncing on bare floor has nothing to have hit.
   */
  land(prop, x, z) {
    this.landings.push({ g: prop, y: prop.position.y, born: performance.now() });
    const g = buildStamp(STAMP_COLOR);
    g.position.set(x, 0.07, z);
    this.actorRoot.add(g);
    this.ripples.push({ g, born: performance.now(), ms: STAMP_MS, from: STAMP_FROM, to: 1 });
  }

  /**
   * How far through a held press we are, 0..1, or null when nothing is held.
   *
   * A hold that shows nothing is indistinguishable from a click that missed —
   * you let go at 300ms, having done nothing, with no way to know you were
   * 120ms short. So the ring that already marks what you are pointing at fills
   * up, using the same sweep the action charge uses: one vocabulary for "keep
   * doing that", whether the game is waiting on your finger or on your legs.
   */
  setHoldProgress(t) {
    this.holdProgress = t === null ? null : Math.max(0, Math.min(1, t));
  }

  /** Advance every live ground mark, and retire the ones that have finished. */
  animateRipples(now) {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      const k = (now - r.born) / r.ms;
      if (k >= 1) {
        this.actorRoot.remove(r.g);
        disposeGroup(r.g);
        this.ripples.splice(i, 1);
        continue;
      }
      // Out fast and then slower, which is what makes it read as a wave losing
      // energy rather than as a circle being animated. Fading on a square so
      // most of the life is spent visible and the tail is quick.
      //
      // A stamp is this same curve with `from` above `to`, so "fast then
      // settling" becomes weight arriving instead of energy leaving. One eased
      // interpolation, read backwards.
      const ease = 1 - (1 - k) ** 3;
      r.g.scale.setScalar(r.from + (r.to - r.from) * ease);
      r.g.userData.ring.material.opacity = 0.9 * (1 - k) ** 2;
    }
  }

  /** Fall, hit, wobble, settle. Retired back to exactly where it belongs. */
  animateLandings(now) {
    for (let i = this.landings.length - 1; i >= 0; i--) {
      const r = this.landings[i];
      const k = (now - r.born) / LAND_MS;
      if (k >= 1) {
        r.g.position.y = r.y;
        r.g.scale.set(1, 1, 1);
        this.landings.splice(i, 1);
        continue;
      }
      if (k < LAND_FALL) {
        // Squared, so it accelerates rather than descends at a constant rate.
        // A fixture arriving at walking pace reads as being lowered by somebody
        // rather than as being dropped.
        const t = k / LAND_FALL;
        r.g.position.y = r.y + LAND_DROP * (1 - t * t);
        r.g.scale.set(1, 1, 1);
      } else {
        const t = (k - LAND_FALL) / (1 - LAND_FALL);
        // A bounce that dies out: the cosine gives it a second, smaller
        // compression on the way to still, and the squared envelope means it is
        // genuinely finished at the end rather than cut off mid-wobble.
        const s = LAND_SQUASH * (1 - t) ** 2 * Math.cos(t * 8);
        r.g.position.y = r.y;
        r.g.scale.set(1 + s * 0.6, 1 - s, 1 + s * 0.6);
      }
    }
  }

  /**
   * Turn every readout to face the camera again.
   *
   * `Ry(camAngle) · base` rather than "set rotation.y": a rotation about world
   * Y applied *after* whatever base orientation the thing was built with is
   * exactly the transform that leaves its appearance unchanged as the camera
   * orbits by the same angle. Folding the yaw into a Euler's y term only works
   * for a base that is itself a pure yaw, which the growth bar is and the
   * progress ring is not.
   *
   * Found by traversal rather than by a registry on purpose. A registry of
   * live meshes is one more thing to unsubscribe from on disposal, and this
   * renderer already has a scar there — clearing the `shelfProps` maps without
   * removing the meshes orphaned a full set of stock in the scene on every
   * re-flow. Traversal cannot leak, and it runs only when the angle changes or
   * something new was built, which is a handful of frames per quarter turn
   * rather than every frame forever.
   */
  faceReadouts() {
    YAW_Q.setFromAxisAngle(AXIS_Y, this.camAngle);
    const aim = (o) => {
      const base = o.userData.faceCam;
      if (base) o.quaternion.copy(YAW_Q).multiply(base);
    };
    this.actorRoot.traverse(aim);
    this.staticRoot.traverse(aim);
  }

  setCatalog(catalog) {
    this.catalog = {
      items: Object.fromEntries(catalog.items.map((i) => [i.id, i])),
      crops: Object.fromEntries(catalog.crops.map((c) => [c.id, c])),
      fixtures: Object.fromEntries((catalog.fixtures ?? []).map((f) => [f.id, f])),
      // ...and the same rows as a list, because resolving which *piece* a
      // fixture is means asking "what does this kind default to", which is a
      // scan rather than a lookup. See shared/pieces.js.
      pieces: catalog.fixtures ?? [],
      // A hire is drawn from its kind, so the renderer reads the same rows the
      // Staff menu does.
      workers: Object.fromEntries((catalog.workers ?? []).map((w) => [w.id, w])),
      // ...and what they're holding while they're on a break comes off the
      // pastime, for the same reason: a break redrawn over MCP should reach the
      // person already sat on the step, not only the next one who stops.
      pastimes: Object.fromEntries((catalog.pastimes ?? []).map((p) => [p.id, p])),
      // Kept as a list, not keyed: what an appliance shows is chosen by looking
      // across every recipe its kind can make, not by looking one up.
      recipes: catalog.recipes ?? [],
    };
    // Content changed — force props to rebuild with any new models.
    for (const [, rec] of this.shelfProps) rec.key = null;
    for (const [, rec] of this.plotProps) rec.key = null;
    // ...including the people already on shift, so a worker kind redrawn over
    // MCP reaches the ones you have rather than only the next one you hire.
    for (const [, rec] of this.players) rec.key = null;
    for (const [, rec] of this.stationProps) rec.key = null;
    // Fixtures are built with the world, so redrawing one means redrawing that.
    // This also covers the ordinary boot order: the catalog usually lands after
    // the first layout, and without it the shop would be furnished with the
    // fallback blocks until something else happened to re-flow it.
    this.rebuildWorld();
  }

  // -------------------------------------------------------------------------
  // Static world
  // -------------------------------------------------------------------------

  /** Redraw the world we already have — for when the art changed, not the shop. */
  rebuildWorld() {
    if (!this._layout) return;
    this.layoutVersion = -1;
    this.buildWorld(this._layout);
  }

  buildWorld(layout) {
    if (layout.version === this.layoutVersion) return;
    this.layoutVersion = layout.version;
    this._layout = layout;
    const L = layout.layout ?? layout;

    // Every geometry under staticRoot was built for the previous layout, and
    // `clear()` alone drops the references without freeing the GPU buffers.
    // That barely mattered when the shop only re-flowed on an upgrade; build
    // mode re-flows on every placement.
    disposeGroup(this.staticRoot);
    this.staticRoot.clear();
    // Anything still dropping was a group under that root, and is now a freed
    // buffer the animator would go on scaling every frame.
    this.landings.length = 0;
    // Shelf and plot props live in `actorRoot`, not `staticRoot`, so emptying
    // the maps without taking the meshes out of the scene orphans every one of
    // them. They stayed exactly where the old shelves used to be, which is why
    // expanding the shop left stock apparently lying about on the floor. It
    // leaked a fresh set on every re-flow, and build mode re-flows constantly.
    this.clearFixtureProps();

    // Ground: one big plane rather than 1500 grass tiles. It runs well past the
    // last tile — see GROUND_MARGIN — so the world never visibly ends, and so
    // shoppers walking on from off the map have land to walk in over.
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(L.w + GROUND_MARGIN * 2, 0.4, L.h + GROUND_MARGIN * 2),
      material(PALETTE.grass),
    );
    ground.position.set(L.w / 2, -0.2, L.h / 2);
    ground.receiveShadow = true;
    this.staticRoot.add(ground);

    // Everything raised gets an instanced box per tile kind — and, for floor,
    // per DESIGN of floor. Which design a cell is painted lives in its own
    // sparse layer (`L.ground`) rather than in `tiles`, so the grouping key has
    // to carry both: `tiles` still decides what may stand there and this only
    // decides what it looks like. One mesh per kind would have collapsed four
    // floors into one colour; one mesh per cell would be five hundred draws.
    const painted = groundIndex(L);
    const byKind = new Map();
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        // Just the ground. A fixture standing here draws itself on top, and the
        // floor under it is floor — which it always was, and now says so.
        const kind = L.tiles[z * L.w + x];
        if (kind === 0) continue;
        // Any painted ground, not just floor: a delivery bay is a design on a
        // cell the same way parquet is, and one that only floor could carry
        // would draw every authored bay in the palette's default colour.
        const piece = groundKindOfTile(kind) ? (painted.get(`${x},${z}`) ?? null) : null;
        const key = piece ? `${kind}|${piece}` : String(kind);
        if (!byKind.has(key)) byKind.set(key, { kind, piece, cells: [] });
        byKind.get(key).cells.push([x, z]);
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();

    for (const [, { kind, piece, cells }] of byKind) {
      const style = TILE_STYLE[kind];
      if (!style) continue;
      const height = Math.max(style.h, 0.04);
      // What this floor is made of, if anybody chose. `surfaceOf` falls back to
      // the tile's own colour, so a design deleted out of the catalog leaves
      // plain shop floor rather than a black hole.
      const surface = piece ? surfaceOf(this.catalog.pieces ?? [], piece, style.color) : null;
      const base = surface?.color ?? style.color;

      const mesh = new THREE.InstancedMesh(box, material(base), cells.length);
      mesh.castShadow = height > 0.2;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);

      cells.forEach(([x, z], i) => {
        dummy.position.set(x, height / 2, z);
        // Fences are thin posts; everything else fills its tile.
        const w = kind === 9 ? 0.9 : 1;
        const d = kind === 9 ? 0.22 : 1;
        dummy.scale.set(w, height, d);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // The pattern is per-cell colour and nothing else — no extra geometry,
        // no second mesh, no texture. At 45° across a room that is all that
        // survives anyway, and it costs one lookup in a loop that already sets
        // a colour per instance to jitter it.
        const c = new THREE.Color(surface ? patternColor(surface, x, z) : jitter(style.color, 0.05, x * 31 + z * 17));
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.staticRoot.add(mesh);

      // A contrasting top slab, so a raised tile reads as built rather than as
      // an anonymous coloured block. Only the wall is left: the four furniture
      // entries went with the fixture tiles, and furniture draws its own art.
      const TOPS = { [T.WALL]: PALETTE.wallTop };
      if (TOPS[kind]) {
        const top = new THREE.InstancedMesh(box, material(TOPS[kind]), cells.length);
        top.castShadow = false;
        top.receiveShadow = true;
        cells.forEach(([x, z], i) => {
          dummy.position.set(x, height + 0.045, z);
          dummy.scale.set(1.04, 0.09, 1.04);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          top.setMatrixAt(i, dummy.matrix);
        });
        top.instanceMatrix.needsUpdate = true;
        this.staticRoot.add(top);
      }
    }

    this.addEdges(L);
    this.addFixtureProps(L);
    this.addAwning(L);
    // Only before there is anybody to follow — see `camFollowing`. A shop that
    // re-flows is still the shop you are standing in, and where you are looking
    // is not something a re-flow gets an opinion about.
    if (!this.camFollowing) this.camTarget.set(L.door.x, 0, L.door.z + 2);
    this.storeLayout = L;
    // The fixture the pointer was over belongs to the old layout — a re-flow can
    // renumber it or move it out from under the marker. Whoever is aiming will
    // set it again on the next pointer move or frame.
    this.setAimTarget(null);
  }

  /** Take every shelf stack and crop out of the scene and free its geometry. */
  clearFixtureProps() {
    for (const map of [this.shelfProps, this.plotProps]) {
      for (const [, rec] of map) {
        this.actorRoot.remove(rec.group);
        disposeGroup(rec.group);
        // The crop readouts are a second actorRoot child, so they need taking
        // out by name. Clearing the map alone would strand every bar and
        // bubble in the scene at the old plot positions, and leak another set
        // on every re-flow — the same way the stacks once did.
        if (rec.overlay) {
          this.actorRoot.remove(rec.overlay);
          disposeGroup(rec.overlay);
        }
      }
      map.clear();
    }
  }

  /**
   * The authored look of a fixture kind, or null if nobody has drawn one yet.
   * Content, so a shelf can be redesigned live; the rules for where it may go
   * stay in `shared/build.js`.
   *
   * Which *shape* of that kind comes off the fixture itself, because a corner
   * unit and a straight one are the same kind standing on the same tile.
   *
   * An appliance falls back to its own `station` kind as the variant, so a
   * blender and a toaster can look nothing like each other while staying one
   * fixture kind with one tier ladder. That's the whole variant bargain — a
   * look costs nothing and moves no number — and it means drawing a new
   * appliance is an MCP call rather than a change in here.
   */
  fixtureModel(f) {
    const piece = this.pieceOf(f);
    // `||`, not `??`: an unstyled fixture carries `variant: ''` rather than
    // nothing, and an empty string is a perfectly good value as far as `??` is
    // concerned — which quietly handed every appliance the generic model back.
    const variant = f.variant || (f.kind === 'station' ? f.station : null);
    return variantModel(piece, variant) ?? null;
  }

  /**
   * Which catalog row this fixture is drawn from.
   *
   * Was a lookup by kind, which is exactly what capped the catalog at one design
   * per kind. The same resolution the server uses, out of the same file, because
   * the two disagreeing about which shelf this is would be a shop that looks
   * different depending on who is standing in it.
   */
  pieceOf(f) {
    return pieceFor(this.catalog.pieces ?? [], f);
  }

  /** How many tiers this piece has, for turning a tier into 0..1 progress. */
  fixtureTiers(f) {
    return this.pieceOf(f)?.tiers?.length ?? 1;
  }

  /** Where this particular fixture sits on its kind's tier ladder, 0..1. */
  fixtureT(f) {
    return tierProgress(f.tier ?? 1, this.fixtureTiers(f));
  }

  /**
   * Stand every fixture's authored model in the world.
   *
   * These go in `staticRoot` with the rest of the building: a fixture only
   * moves when the layout re-flows, and that is exactly when this runs again.
   */
  addFixtureProps(L) {
    // Which unit stands on which tile, so a seam can ask what is next door.
    // Built here rather than read off `fixtureAt`, because `storeLayout` is
    // still the *previous* shop until the end of `buildWorld`.
    const byTile = new Map();
    const spots = new Map();
    for (const f of fixturesIn(L)) {
      byTile.set(`${f.x},${f.z}`, f);
      spots.set(f.id, `${f.x},${f.z}`);
    }

    // What arrived since the last build, and therefore what should land rather
    // than simply be standing there. Keyed by *where* each id was and not by
    // whether the id is new, so setting down something you picked up lands too
    // — a fixture you carried across the shop and put down is the clearest case
    // of plopping there is, and it keeps its id the whole way.
    //
    // Ids are only comparable at all because a stamped shop stops re-minting
    // them (`Game.freezeShell`); against the old generator every re-flow would
    // have looked like a shop full of arrivals.
    const was = this._fixtureSpots;
    this._fixtureSpots = spots;
    let landed = new Set();
    if (was) {
      for (const [id, at] of spots) if (was.get(id) !== at) landed.add(id);
      if (landed.size > STAMP_MAX) landed = new Set();
    }

    for (const f of fixturesIn(L)) {
      const model = this.fixtureModel(f);
      // A fixture nobody has drawn used to be a coloured tile block, because it
      // WAS a tile. Nothing stamps one now, so an unstyled kind would be an
      // invisible thing you can walk into — hence the fallback block, at the
      // colour and height its tile used to have.
      const prop = model
        ? buildModel(model, {
          t: this.fixtureT(f),
          abuts: (step) => this.carriesOn(byTile, f, step),
        })
        : plainBlock(FIXTURE_LOOK[f.kind]);
      if (!prop) continue;
      // Models are authored facing east, which is rot 0 — the same convention
      // the layout generator has always used for which side you work from.
      prop.rotation.y = -(f.rot ?? 0) * (Math.PI / 2);
      prop.position.set(f.x, this.fixtureBaseY(f), f.z);
      // One thing you can point at, whatever it is made of. `pickFixture`
      // raycasts these and walks back up to whichever group wears the flag.
      prop.userData.pick = true;
      this.staticRoot.add(prop);
      if (landed.has(f.id)) this.land(prop, f.x, f.z);
    }

    // Lamps. Rebuilt with the world because a light is a position, and the
    // positions just changed; the pool of actual THREE lights outlives this and
    // is only ever re-aimed. See lights.js for why that split is load-bearing.
    this.lights.setEmitters(emittersIn(fixturesIn(L), (f) => this.pieceOf(f), CEILING_Y));
  }

  /**
   * What height a fixture's model stands on.
   *
   * Two answers now rather than three, which is a fixture no longer being a
   * tile: everything stands on the ground it is standing on. A plot is the one
   * that reads oddly and is right — its `ground` IS a dug bed, so its model sits
   * on top of that tile rather than on the floor. And a hanging prop hangs,
   * which is the one thing an authored model cannot say about itself.
   */
  fixtureBaseY(f) {
    if (FIXTURES[f.kind]?.at === 'ceiling') return CEILING_Y;
    const ground = FIXTURES[f.kind]?.ground;
    return ground == null ? 0 : (TILE_STYLE[ground]?.h ?? 0);
  }

  /**
   * Does the shelving carry on past this side of `f`?
   *
   * What a `seam` part asks before it draws itself. The test is the same kind
   * of unit, stood the same way round, on the next tile along: an end panel is
   * there to close the run, and the run has not ended if what comes next is
   * more of it.
   *
   * Deliberately not the same *variant* or the same *tier*. A wall run flowing
   * into a corner unit is still one shelf, and a tier is a number rather than a
   * shape — gating on either would put a divider back in for a reason nobody
   * looking at the shop can see.
   */
  carriesOn(byTile, f, step) {
    const d = turn(step, f.rot ?? 0);
    const n = byTile.get(`${f.x + d.dx},${f.z + d.dz}`);
    return !!n && n.kind === f.kind && rot4(n.rot ?? 0) === rot4(f.rot ?? 0);
  }

  /** A striped awning over the shop door — pure decoration, sells the vibe. */
  /**
   * Walls, windows, doorways and fences — the things that live on the
   * boundaries between cells rather than on a cell of their own.
   *
   * One instanced mesh per edge kind per orientation, because a vertical run
   * and a horizontal one are the same box turned ninety degrees and batching
   * them separately is cheaper than carrying a rotation per instance.
   *
   * A doorway draws its header and threshold but no leaf, so the gap you walk
   * through is visibly a gap.
   */
  addEdges(L) {
    // Rebuilt on every quarter turn, so it owns a group of its own rather than
    // living loose in staticRoot — turning the camera must not rebuild the shop.
    if (this.edgeGroup) {
      this.staticRoot.remove(this.edgeGroup);
      disposeGroup(this.edgeGroup);
    }
    this.edgeGroup = new THREE.Group();
    this.staticRoot.add(this.edgeGroup);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();


    // [kind, orientation] -> the boxes to draw for it.
    const runs = new Map();
    const push = (kind, vertical, spec) => {
      const k = `${kind}:${vertical ? 'v' : 'h'}`;
      if (!runs.has(k)) runs.set(k, { kind, vertical, boxes: [] });
      runs.get(k).boxes.push(spec);
    };

    // What an edge is made of comes from `edgeBands`, beside the style it reads,
    // because the palette button offering to sell you one draws from it too —
    // see client/thumb.js.
    const emit = (kind, vertical, cx, cz) => {
      const style = EDGE_STYLE[kind];
      if (!style) return;
      for (const band of edgeBands(style)) push(kind, vertical, { cx, cz, ...band });
    };

    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        const kind = L.edgesV?.[z * (L.w + 1) + x] ?? 0;
        // Centre of a vertical edge: on the lattice line in x, mid-cell in z.
        if (kind) emit(kind, true, x - 0.5, z);
      }
    }
    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        const kind = L.edgesH?.[z * L.w + x] ?? 0;
        if (kind) emit(kind, false, x, z - 0.5);
      }
    }

    for (const { kind, vertical, boxes } of runs.values()) {
      const style = EDGE_STYLE[kind];
      const opaque = boxes.filter((b) => b.alpha === undefined);
      const clear = boxes.filter((b) => b.alpha !== undefined);
      for (const [set, alpha] of [[opaque, 1], [clear, GLASS]]) {
        if (!set.length) continue;
        const mesh = new THREE.InstancedMesh(box, material(style.color, alpha), set.length);
        mesh.castShadow = alpha === 1;
        mesh.receiveShadow = true;
        set.forEach((b, i) => {
          dummy.position.set(b.cx, (b.y0 + b.y1) / 2, b.cz);
          dummy.scale.set(
            vertical ? style.t : 1,
            Math.max(0.02, b.y1 - b.y0),
            vertical ? 1 : style.t,
          );
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.edgeGroup.add(mesh);
      }

      // A contrasting coping along the top, so a wall reads as built rather
      // than as a coloured slab.
      if (!style.top) continue;
      const capped = boxes.filter((b) => b.y1 >= style.h - 0.001 && b.alpha === undefined);
      if (!capped.length) continue;
      const cap = new THREE.InstancedMesh(box, material(style.top), capped.length);
      cap.receiveShadow = true;
      capped.forEach((b, i) => {
        dummy.position.set(b.cx, style.h + 0.03, b.cz);
        dummy.scale.set(vertical ? style.t + 0.06 : 1, 0.07, vertical ? 1 : style.t + 0.06);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        cap.setMatrixAt(i, dummy.matrix);
      });
      cap.instanceMatrix.needsUpdate = true;
      this.edgeGroup.add(cap);
    }
  }

  addAwning(L) {
    // `door` is the shop-floor cell behind the opening, so the wall line — and
    // therefore the front of the building — is half a tile further out. The
    // awning hangs off that, not off the cell.
    const wallLine = L.door.z + 0.5;
    const centre = L.door.x + 0.5;
    const width = 4;
    for (let i = 0; i < width; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.12, 1.4),
        material(i % 2 === 0 ? PALETTE.awningA : PALETTE.awningB),
      );
      stripe.position.set(centre - width / 2 + i + 0.5, 1.28, wallLine + 0.55);
      stripe.rotation.x = -0.28;
      stripe.castShadow = true;
      this.staticRoot.add(stripe);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic actors
  // -------------------------------------------------------------------------

  syncState(state, myId) {
    // Kept for `pickPerson`: the records hold the meshes, and the answer has to
    // be the person, not the group they are drawn as.
    this.playerState = state.players;
    this.syncActors(state.players, this.players, (p) => this.buildActor(p), (p) => actorKey(p));
    this.syncActors(state.customers, this.customers, (c) => buildCharacter(c.color));
    this.syncShelves(state.shelves);
    this.syncPlots(state.plots);
    this.syncCashDrops(state.cashDrops ?? []);
    this.syncDeliveries(state.deliveries ?? []);
    this.syncStations(state.stations ?? []);
    this.syncActionRings(state.players, myId);
    this.syncLifted(state.players.find((p) => p.id === myId));
    this.syncActionTarget(state.players.find((p) => p.id === myId));
    this.syncStockTargets(state.players.find((p) => p.id === myId));

    const me = state.players.find((p) => p.id === myId);
    if (me) {
      this.camTarget.set(me.x, 0, me.z);
      this.camFollowing = true;
    }

    // The day cycle. `daylight` is 0 at open and close, 1 at midday.
    //
    // Everything below moves together, which is the point: the old version only
    // nudged sun intensity between 0.55 and 1.30 while a flat 0.9 white ambient
    // held the floor, so noon and dusk differed by about a tenth of the total
    // light in the scene and nobody could see it. Now the fill drops away with
    // the sun and both go warm, so the total swings 2.5 -> 1.0 *and* changes hue.
    const t = state.time ?? 0.5;
    const daylight = Math.sin(Math.PI * Math.min(Math.max((t - 0.25) / 0.6, 0), 1));

    this.sun.intensity = 0.30 + daylight * 1.00;
    this.sun.color.copy(SUN_DUSK).lerp(SUN_HIGH, daylight);

    // `spill` is every lamp too far away to be given a real light, folded into
    // one number — so panning the camera sharpens the near end of the shop
    // rather than switching the far end off. See lights.js.
    this.lights.setDaylight(daylight);
    this.ambient.intensity = 0.38 + daylight * 0.52 + this.lights.spill;
    this.ambient.color.copy(FILL_DUSK).lerp(FILL_HIGH, daylight);

    // The sky is the largest single block of colour on screen, so it carries
    // most of the read. Mutated in place — `background` owns this Color.
    this.scene.background.copy(SKY_DUSK).lerp(SKY_HIGH, daylight);
  }

  syncActors(list, map, factory, keyOf = null) {
    const seen = new Set();
    for (const a of list) {
      seen.add(a.id);
      const key = keyOf ? keyOf(a) : null;
      let rec = map.get(a.id);

      // What this one is drawn as changed — a promotion restaged the model, or
      // its kind was redrawn over MCP. The bubble and whatever is in their
      // hands are children of the body, so both leave with it and are re-hung
      // by the two syncs at the bottom of the loop.
      if (rec && rec.key !== key) {
        this.actorRoot.remove(rec.obj);
        disposeGroup(rec.obj);
        map.delete(a.id);
        rec = null;
      }

      if (!rec) {
        const obj = factory(a);
        this.actorRoot.add(obj);
        rec = {
          obj, key, bubble: null, bubbleKey: null, carry: null, carryKey: null,
          // The break: the prop, which stage of it is built, whether they are
          // on one, and how far the body has eased into the slump. `phase` is
          // per-person and stable, so two hires sat on the same step don't
          // breathe in time with each other.
          pastime: null, pastimeKey: null, resting: false, slump: 0,
          phase: (hashId(a.id) % 628) / 100,
        };
        map.set(a.id, rec);
        obj.position.set(a.x, 0, a.z);
      }
      // Lerp toward the server position so 10Hz network looks smooth at 60fps.
      rec.obj.position.x += (a.x - rec.obj.position.x) * 0.35;
      rec.obj.position.z += (a.z - rec.obj.position.z) * 0.35;
      rec.obj.rotation.y = a.facing ?? 0;

      // Stashed rather than applied: how cross someone looks is animated at
      // 60fps in `animateMoods`, and a shake that only moved when state landed
      // would read as the renderer stuttering. Null for anyone who isn't a
      // shopper — staff and players have no patience to lose.
      rec.anger = a.anger ?? null;

      // A want is a thought; a carry is a thing in your hands. Showing both
      // through one bubble meant you could never tell which you were looking at.
      this.syncBubble(rec, a.want ?? null);
      this.syncCarry(rec, a.carry ?? null);
      this.syncPastime(rec, a);
    }
    for (const [id, rec] of map) {
      if (!seen.has(id)) {
        this.actorRoot.remove(rec.obj);
        map.delete(id);
      }
    }
  }

  /**
   * What one player-table entry is drawn as.
   *
   * A hire comes out of its kind's authored `model`, restaged by the rung they
   * have climbed to — the same `model` + `tiers` pair a shelf uses, resolved
   * through the same `tierProgress`. Workers were the last visible thing in the
   * game still hardcoded to a coloured capsule, and a promotion that changed a
   * number but not the person was half a ladder.
   *
   * Everyone else keeps the built-in character: a shopper is not authored
   * content, and the one in the white hat is you.
   */
  buildActor(p) {
    const kind = p.staff ? this.catalog.workers?.[p.staff] : null;
    if (!kind?.model) return buildCharacter(p.color, { hat: '#ffffff' });
    return buildModel(kind.model, { t: tierProgress(p.tier ?? 1, kind.tiers?.length ?? 1) });
  }

  /** Money sitting on a counter waiting to be picked up. */
  syncCashDrops(drops) {
    const seen = new Set();
    for (const d of drops) {
      seen.add(d.id);
      if (this.cashProps.has(d.id)) continue;
      const obj = buildCashDrop(d.amount);
      // Sit on top of the till rather than inside it.
      obj.position.set(d.x, 0.95, d.z);
      obj.userData.born = performance.now();
      this.actorRoot.add(obj);
      this.cashProps.set(d.id, obj);
    }
    for (const [id, obj] of this.cashProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(obj);
      disposeGroup(obj);
      this.cashProps.delete(id);
    }
  }

  /** Pallets at the delivery bay, rebuilt when the remaining count changes. */
  syncDeliveries(deliveries) {
    const seen = new Set();
    for (const d of deliveries) {
      seen.add(d.id);
      const key = `${d.item_id}:${d.qty}`;
      const existing = this.deliveryProps.get(d.id);
      if (existing && existing.userData.key === key) continue;
      if (existing) {
        this.actorRoot.remove(existing);
        disposeGroup(existing);
      }
      const obj = buildPallet(this.catalog.items[d.item_id]?.model ?? null, d.qty);
      obj.position.set(d.x, 0, d.z);
      obj.userData.key = key;
      this.actorRoot.add(obj);
      this.deliveryProps.set(d.id, obj);
    }
    for (const [id, obj] of this.deliveryProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(obj);
      disposeGroup(obj);
      this.deliveryProps.delete(id);
    }
  }

  /**
   * Which recipe an appliance is working toward.
   *
   * A blender knows two, so "the first one" would have a machine half-loaded
   * with tomatoes advertising the ingredients for a smoothie. The one it is
   * closest to being able to make is the one you are actually part-way through,
   * and it flips over to the other as soon as you put a different thing in.
   */
  stationRecipe(st) {
    const mine = (this.catalog.recipes ?? []).filter((r) => r.station === st.station);
    if (!mine.length) return null;
    if (st.making) return mine.find((r) => r.id === st.making) ?? mine[0];

    const shortfall = (r) => r.inputs
      .reduce((n, i) => n + Math.max(0, i.qty - (st.contents?.[i.item_id] ?? 0)), 0);
    return mine.slice().sort((a, b) => shortfall(a) - shortfall(b))[0];
  }

  /**
   * What each appliance is waiting for, floating above it.
   *
   * A coffee machine with no milk looks exactly like one about to run, and the
   * only way to tell them apart was to enter build mode and read a text panel
   * that lists recipe *names* and not their ingredients. So the ingredients
   * hang over the machine instead — see `buildHopperSlots`.
   *
   * Nothing is shown while it's mid-cycle or holding a finished batch: those
   * are their own states, and a row of ghosts over a working machine is noise.
   */
  syncStations(stations) {
    const seen = new Set();

    for (const st of stations) {
      seen.add(st.id);
      const busy = Boolean(st.making || st.output);
      const recipe = busy ? null : this.stationRecipe(st);
      const slots = (recipe?.inputs ?? []).map((i) => ({
        model: this.catalog.items[i.item_id]?.model ?? null,
        ready: (st.contents?.[i.item_id] ?? 0) >= i.qty,
      }));

      // Rebuilt only when what it says changes, but repositioned every sync —
      // an appliance you move in build mode has to take its readout with it.
      const key = recipe
        ? `${recipe.id}:${slots.map((s) => (s.ready ? 1 : 0)).join('')}`
        : 'idle';
      let rec = this.stationProps.get(st.id);

      if (!rec || rec.key !== key) {
        if (rec?.group) {
          this.actorRoot.remove(rec.group);
          disposeGroup(rec.group);
        }
        const group = slots.length ? buildHopperSlots(slots) : null;
        if (group) this.actorRoot.add(group);
        rec = { key, group };
        this.stationProps.set(st.id, rec);
      }

      if (rec.group) rec.group.position.set(st.x, this.stationSlotY(st), st.z);
    }

    for (const [id, rec] of this.stationProps) {
      if (seen.has(id)) continue;
      if (rec.group) {
        this.actorRoot.remove(rec.group);
        disposeGroup(rec.group);
      }
      this.stationProps.delete(id);
    }
  }

  /**
   * Just clear of *this* appliance, so the row never sits inside one — measured
   * per station now that a toaster and an espresso machine are different heights.
   *
   * `modelHeight` wants parts rather than a model; handing it the model iterates
   * an object and throws, which took out the whole sync loop after the first
   * station the first time round.
   */
  stationSlotY(st) {
    const model = this.fixtureModel({ kind: 'station', station: st?.station });
    return (model ? modelHeight(partsAt(model, 1)) : 1) + 0.42;
  }

  // -------------------------------------------------------------------------
  // Build mode
  // -------------------------------------------------------------------------

  /**
   * The pointer as a ray into the world, reused by everything that aims.
   *
   * One place that turns client coordinates into a ray, because the canvas is
   * not the window: it sits under a HUD and inside a `getBoundingClientRect`
   * that changes when the bar grows. Two copies of this arithmetic is two
   * chances for one of them to be off by the offset of the canvas.
   */
  pointerRay(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._ray ??= new THREE.Raycaster();
    this._ndc ??= new THREE.Vector2();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    return this._ray;
  }

  /**
   * Which tile is under the pointer, on the flat plane `y` units up.
   *
   * A plane rather than geometry, so pointing at the floor *behind* a shelf
   * still gives you the floor and not the shelf's roof. That is the right
   * answer for a question about *ground* — where a wall goes, where a floor is
   * painted, where a fixture you are carrying lands. It is the wrong answer to
   * "which thing am I pointing at", which is why `pickFixture` stopped being
   * built out of this and raycasts the art instead.
   */
  pickTile(clientX, clientY, y = 0) {
    if (!this.storeLayout) return null;
    const ray = this.pointerRay(clientX, clientY);
    this._plane ??= new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit ??= new THREE.Vector3();

    this._plane.constant = -y;
    if (!ray.ray.intersectPlane(this._plane, this._hit)) return null;

    const x = Math.round(this._hit.x);
    const z = Math.round(this._hit.z);
    if (x < 0 || z < 0 || x >= this.storeLayout.w || z >= this.storeLayout.h) return null;
    return { x, z };
  }

  /**
   * Which *line between cells* the pointer is nearest — for drawing walls.
   *
   * A third question alongside `pickTile` ("which floor square") and
   * `pickFixture` ("which thing"), and it needs its own answer because a wall
   * has no square of its own. The ground hit lands somewhere inside a cell; the
   * fractional part says which of its four boundaries is closest, and whichever
   * of the two axes is nearer its own edge wins.
   *
   * Aimed at half a tile up rather than at the floor, because you point at the
   * middle of a wall you can see, not at the ground it stands on — picking at
   * y=0 makes every wall feel like it is one cell further away than it looks.
   */
  pickEdge(clientX, clientY) {
    if (!this.storeLayout) return null;
    const hit = this.pickTile(clientX, clientY, 0.55);
    if (!hit) return null;
    // pickTile rounds; re-read the raw intersection it left behind.
    const fx = this._hit.x;
    const fz = this._hit.z;
    const L = this.storeLayout;

    // Distance from the cell centre, in each axis, as a 0..0.5 figure.
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const dx = fx - cx;
    const dz = fz - cz;

    let o;
    let x;
    let z;
    if (Math.abs(dx) > Math.abs(dz)) {
      // Nearer a west/east boundary: a vertical line.
      o = 'v';
      x = dx > 0 ? cx + 1 : cx;
      z = cz;
    } else {
      o = 'h';
      x = cx;
      z = dz > 0 ? cz + 1 : cz;
    }

    const maxX = o === 'v' ? L.w : L.w - 1;
    const maxZ = o === 'v' ? L.h - 1 : L.h;
    if (x < 0 || z < 0 || x > maxX || z > maxZ) return null;
    return { o, x, z };
  }

  /**
   * How tall this fixture is *drawn* — the plane its top face sits on.
   *
   * Read off the authored model when there is one, because the whole point of
   * aiming is that you click what you can see. A picker using a constant while
   * the art says otherwise is the neighbour-selecting bug all over again, just
   * arriving through content instead of code.
   */
  fixtureHeight(f) {
    const model = this.fixtureModel(f);
    // Its art on top of whatever it stands on, for everything — one rule where
    // there used to be a branch per kind. The base matters most for a hanging
    // prop: its art is drawn downward from the ceiling, so `modelHeight` alone
    // answers 0 and the picker would look for it on the floor, most of a tile
    // down-screen of where it is actually drawn. That is the neighbour-selecting
    // bug again with the camera pointing the other way.
    const own = model
      ? modelHeight(partsAt(model, this.fixtureT(f)))
      : (FIXTURE_LOOK[f.kind]?.h ?? 0);
    return this.fixtureBaseY(f) + own;
  }

  /**
   * Which fixture the pointer is actually over — the art, not a plane.
   *
   * Not the same question as `pickTile`, and it took two goes to answer. The
   * first was a ground-plane pick, which lands on the floor *behind* a shelf
   * because a 45° camera draws a three-quarter-tile box most of a tile
   * up-screen of the ground it stands on. The second aimed at the plane each
   * fixture's *top face* lives on, which fixes the neighbour bug and quietly
   * introduces a worse one: the region that answers is a full tile square
   * floating at roof height, so what you have to point at is not the thing —
   * it is a patch of air above and behind it, offset further the taller the
   * piece. Nothing on screen says where that patch is, so aiming becomes
   * hunting for a magic spot, and a lamp is nearly unhittable.
   *
   * So: raycast the meshes. The answer is then the same shape as the pixels,
   * whatever anybody authors — a corner unit's wing, a tall thin post, a
   * hanging sign — and it stays right the day a model changes, which neither
   * of the constants-and-planes versions could.
   *
   * Deliberately only the fixtures, not the whole scene. A shopper stood in
   * front of a shelf must not shield it (see docs/ui-shell.md), and the ground
   * would swallow every hit if it were in here.
   */
  pickFixture(clientX, clientY) {
    if (!this.storeLayout) return null;
    const hits = this.pointerRay(clientX, clientY).intersectObjects(this.pickTargets(), true);
    for (const hit of hits) {
      // Up to whichever group was tagged as one pickable thing — the hit
      // itself is one board of a shelf or one apple on it.
      let o = hit.object;
      while (o && !o.userData.pick) o = o.parent;
      if (!o) continue;
      // Every tagged group stands on its fixture's tile, so where it *is* says
      // which fixture it belongs to. Cheaper than an id to keep honest: ids are
      // re-minted on a re-flow and this is re-read from the layout every time.
      const f = this.fixtureAt(Math.round(o.position.x), Math.round(o.position.z));
      if (f) return f;
    }
    return null;
  }

  /**
   * The groups `pickFixture` is allowed to hit.
   *
   * The stock and the crops are in here alongside the fixtures themselves,
   * because they are what you can see: a full shelf is mostly goods from this
   * angle, and a ripe plot is entirely plant. Pointing at a tomato and being
   * told there is nothing there would be the same class of bug this method
   * exists to end.
   */
  pickTargets() {
    const out = [];
    for (const o of this.staticRoot.children) if (o.userData.pick) out.push(o);
    for (const rec of this.shelfProps.values()) out.push(rec.group);
    for (const rec of this.plotProps.values()) out.push(rec.group);
    return out;
  }

  /**
   * Every fixture in the layout as a uniform record — the same shape the server
   * works over in build mode, so the two agree about what a fixture is.
   */
  allFixtures() {
    return fixturesIn(this.storeLayout);
  }

  /**
   * What's on this tile, if anything.
   *
   * This is the whole answer to "which shelf did you mean". A tile holds one
   * fixture, and the pointer names a tile — so there is nothing to disambiguate
   * and nothing for the game to guess at.
   */
  fixtureAt(x, z) {
    return this.allFixtures().find((f) => f.x === x && f.z === z) ?? null;
  }

  /**
   * Ring the fixture the pointer is over in build mode.
   *
   * Kept separate from `syncActionTarget`'s marker on purpose: that one is
   * driven by the server's armed action and gets torn down every snapshot,
   * which would take this with it ten times a second.
   */
  setAimTarget(f, mode = 'aim') {
    // The mode is part of the key: pointing at the same shelf with the bulldozer
    // up is a different marker, and comparing ids alone would leave an amber
    // ring on the thing the next tap deletes.
    const key = f ? `${f.id}:${mode}` : null;
    if (this.aimKey === key) return;
    this.aimKey = key;
    if (this.aimMarker) {
      this.actorRoot.remove(this.aimMarker);
      disposeGroup(this.aimMarker);
      this.aimMarker = null;
    }
    if (!f) return;
    this.aimMarker = buildTargetMarker(mode);
    this.aimMarker.position.set(f.x, 0, f.z);
    this.actorRoot.add(this.aimMarker);
  }

  /**
   * Ring the fixture whose menu is open, and keep it ringed.
   *
   * A third marker rather than a mode on the aim ring, because the two answer
   * different questions and are both live at once: the aim ring is wherever
   * the pointer happens to be, and this stays on the thing the panel is
   * talking about even while you point somewhere else entirely. Folding them
   * together loses the answer exactly when you move the pointer off to read
   * the menu — which is the whole of the time the menu is open.
   *
   * Positioned by the record it is handed, so following a fixture through a
   * re-flow is `showFixture`'s existing tile lookup rather than a second one
   * in here.
   */
  setSelectedTarget(f) {
    const key = f ? `${f.x},${f.z}` : null;
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    if (this.selectedMarker) {
      this.actorRoot.remove(this.selectedMarker);
      disposeGroup(this.selectedMarker);
      this.selectedMarker = null;
    }
    if (!f) return;
    this.selectedMarker = buildTargetMarker('selected');
    this.selectedMarker.position.set(f.x, 0, f.z);
    this.actorRoot.add(this.selectedMarker);
  }

  /**
   * Show (or clear) the build preview.
   *
   * Validity comes from `shared/build.js` — the same function the server runs
   * when the click lands. Reimplementing the rules here to keep the ghost snappy
   * is exactly how a ghost starts lying to you.
   *
   * @param {?object} spec { kind, x, z, rot, moveId }
   * @returns {?{ok: boolean, reason?: string}}
   */
  setBuildGhost(spec) {
    if (!spec || !this.storeLayout) {
      this.clearBuildGhost();
      return null;
    }
    const verdict = canPlace(this.storeLayout, spec, { ignoreId: spec.moveId ?? null });
    // Three answers, so the cache key has to carry which one — an amber ghost
    // and a green one are the same `ok`.
    const state = verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no';
    const key = `${spec.kind}:${spec.x}:${spec.z}:${spec.rot}:${state}`;
    if (this.buildGhostKey === key) return verdict;
    this.buildGhostKey = key;
    this.clearBuildGhost(true);

    const def = FIXTURES[spec.kind];
    if (!def) return verdict;
    const a = anchorTile(0, 0, spec.rot ?? 0);
    // A prop has no tile, so there is no tile style to size its ghost from. It
    // gets a low pad instead — enough to read as "a thing lands here" without
    // pretending to be the shape of whatever piece you picked.
    const look = FIXTURE_LOOK[spec.kind] ?? { h: 0.5, color: TILE_STYLE[T.FLOOR]?.color };
    const g = buildFixtureGhost(
      // A plot's look is flat, and a ghost you cannot see is not a preview — so
      // the ghost keeps a minimum body whatever it is standing in for.
      Math.max(look.h, 0.12),
      look.color,
      state,
      def.anchor ? { dx: a.x, dz: a.z } : null,
    );
    // Hung things preview where they will hang. A ghost on the floor under a
    // pendant answers the wrong question — the floor is not what you are aiming
    // at, and every cell in the room looks equally available from down there.
    g.position.set(spec.x, def.at === 'ceiling' ? CEILING_Y : 0, spec.z);
    this.actorRoot.add(g);
    this.buildGhost = g;
    return verdict;
  }

  /**
   * Ring the fixture you've picked up but not yet set down. It deliberately
   * stays where it is until you choose a destination — so it needs a marker,
   * or "lifted" and "not lifted" look identical.
   */
  syncLifted(me) {
    const id = me?.holding?.id ?? null;
    if (this.liftedKey === id) return;
    this.liftedKey = id;
    if (this.liftedRing) {
      this.actorRoot.remove(this.liftedRing);
      disposeGroup(this.liftedRing);
      this.liftedRing = null;
    }
    if (!id || !this.storeLayout) return;

    const all = [
      ...(this.storeLayout.shelves ?? []), ...(this.storeLayout.checkouts ?? []),
      ...(this.storeLayout.stations ?? []), ...(this.storeLayout.plots ?? []),
      ...(this.storeLayout.props ?? []),
    ];
    const f = all.find((o) => o.id === id);
    if (!f) return;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.07, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xffd66b, transparent: true, opacity: 0.9, depthTest: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 12;
    ring.position.set(f.x, 1.5, f.z);
    this.actorRoot.add(ring);
    this.liftedRing = ring;
  }

  /**
   * A chevron over everything that would take what you are carrying.
   *
   * The list is the server's (`takers` on your own player) — see `stockTargets`
   * for why the shop answers this rather than the client working it out. All
   * this does is find each one and float a pip over it.
   *
   * Keyed by fixture id and rebuilt only when the *set* changes, because the
   * set is stable for a whole armful and this runs ten times a second. Heights
   * are re-read every sync all the same: a shelf that fills up as you stock it
   * drops out of the list, and one you moved has to take its pip with it — the
   * same reason `syncShelves` re-reads positions rather than trusting them.
   */
  syncStockTargets(me) {
    this.stockPips ??= new Map();
    const want = new Set(me?.takers ?? []);
    const key = [...want].sort().join(',');

    if (key !== this.stockPipKey) {
      this.stockPipKey = key;
      for (const [id, pip] of this.stockPips) {
        if (want.has(id)) continue;
        this.actorRoot.remove(pip);
        disposeGroup(pip);
        this.stockPips.delete(id);
      }
      for (const id of want) {
        if (this.stockPips.has(id)) continue;
        const pip = buildTargetMarker('stock');
        // Offset so a shop full of them doesn't bob in lockstep, which reads as
        // one flashing object rather than several separate signposts. The same
        // trick the thought bubbles use, off the same kind of stable number.
        pip.userData.phase = (id.length * 1.7 + id.charCodeAt(id.length - 1)) % 6.28;
        this.actorRoot.add(pip);
        this.stockPips.set(id, pip);
      }
    }

    // Position every sync, not only on the ones that rebuilt: what a pip sits
    // over can change height (a tier bought) or move (a unit carried across the
    // shop) without the set of ids changing at all.
    for (const [id, pip] of this.stockPips) {
      const f = this.allFixtures().find((o) => o.id === id);
      if (!f) { pip.visible = false; continue; }
      pip.visible = true;
      pip.position.set(f.x, this.fixtureHeight(f), f.z);
    }
  }

  /**
   * Preview a wall run on the lines between tiles.
   *
   * Its own ghost rather than a reuse of `setBuildGhost`, because a fixture
   * ghost sits on a tile and this sits on a boundary — and because a run is
   * many segments sharing *one* verdict. Colouring each segment separately
   * would be a lie: "this seals the shop" is true of the run, not of any one
   * piece of it.
   */
  setEdgeGhost(segs, state) {
    const key = segs?.length
      ? `${state}:${segs[0].o}:${segs[0].x},${segs[0].z}:${segs.length}`
      : null;
    if (key === this.edgeGhostKey) return;
    this.edgeGhostKey = key;

    if (this.edgeGhost) {
      this.actorRoot.remove(this.edgeGhost);
      disposeGroup(this.edgeGhost);
      this.edgeGhost = null;
    }
    if (!segs?.length || !this.storeLayout) return;

    const colour = state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const s of segs) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.5));
      // Same centring the real edge renderer uses: a vertical segment sits on
      // the lattice line in x and spans the cell in z, and the other way round.
      if (s.o === 'v') {
        mesh.position.set(s.x - 0.5, 0.6, s.z);
        mesh.scale.set(0.22, 1.2, 1);
      } else {
        mesh.position.set(s.x, 0.6, s.z - 0.5);
        mesh.scale.set(1, 1.2, 0.22);
      }
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.edgeGhost = group;
  }

  /**
   * The area a brush would paint.
   *
   * Flat slabs a hair above the ground rather than the waist-high blocks an
   * edge ghost uses, because a floor ghost has to be readable *through* the
   * shop standing on it: a rectangle of chest-high green across the aisles
   * would hide the shelves you are laying floor around.
   *
   * One verdict for the whole rectangle, exactly as `setEdgeGhost` does — "that
   * would leave bare ground indoors" is true of the stroke, not of any one cell
   * of it, and colouring cells separately would invite you to read the green
   * ones as the part that will happen.
   */
  setFloorGhost(cells, state) {
    const key = cells?.length
      ? `${state}:${cells[0].x},${cells[0].z}:${cells.length}`
      : null;
    if (key === this.floorGhostKey) return;
    this.floorGhostKey = key;

    if (this.floorGhost) {
      this.actorRoot.remove(this.floorGhost);
      disposeGroup(this.floorGhost);
      this.floorGhost = null;
    }
    if (!cells?.length || !this.storeLayout) return;

    const colour = state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const c of cells) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.42));
      // Above whatever ground is already there, so the ghost reads over floor
      // (0.06 tall) as well as over grass, and slightly inset so a rectangle
      // shows its own grid rather than reading as one undivided sheet.
      mesh.position.set(c.x, 0.1, c.z);
      mesh.scale.set(0.94, 0.05, 0.94);
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.floorGhost = group;
  }

  clearBuildGhost(keepKey = false) {
    this.setEdgeGhost(null, null);
    this.setFloorGhost(null, null);
    if (this.buildGhost) {
      this.actorRoot.remove(this.buildGhost);
      disposeGroup(this.buildGhost);
      this.buildGhost = null;
    }
    if (!keepKey) this.buildGhostKey = null;
  }

  /**
   * Which person the pointer is on, or null.
   *
   * Projected rather than raycast, unlike `pickFixture`. A body is a handful of
   * small boxes with gaps between them and it is *moving*: a ray that threads
   * between an arm and a torso misses somebody standing right under the cursor,
   * and a hit box big enough to stop that is a box bigger than the person. The
   * question being asked is "who am I pointing at", and a radius around where
   * they are drawn answers exactly that — including when two are stood on the
   * same tile, where the nearest to the cursor is the one you meant.
   *
   * The radius is in screen pixels, so it stays the same size to aim at however
   * far the camera is zoomed out, which is the way a click target should behave.
   */
  pickPerson(clientX, clientY, radius = 26) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = null;
    let bestD = radius;
    for (const p of this.playerState ?? []) {
      const rec = this.players.get(p.id);
      if (!rec) continue;
      // Chest height rather than the feet: it is the middle of what is drawn,
      // and aiming at the ground under somebody is how you miss them upwards.
      const at = this.worldToScreen(rec.obj.position.x, rec.obj.position.z, 0.75);
      if (!at) continue;
      const d = Math.hypot(at.x - px, at.y - py);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Project a world tile to a screen pixel, for pinning DOM to the world. */
  worldToScreen(x, z, y = 0.9) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.renderer.domElement.clientHeight,
    };
  }

  /**
   * Light up whatever is about to be acted on. The marker appears the tick
   * something comes into range, and pulls taut once the charge is actually
   * running — which is a frame later, but the two states are still distinct
   * for anything the sim refuses.
   */
  syncActionTarget(me) {
    const at = me?.action?.at ?? null;
    if (!at) {
      if (this.targetMarker) {
        this.actorRoot.remove(this.targetMarker);
        disposeGroup(this.targetMarker);
        this.targetMarker = null;
      }
      return;
    }
    if (!this.targetMarker) {
      this.targetMarker = buildTargetMarker();
      this.actorRoot.add(this.targetMarker);
    }
    this.targetMarker.position.set(at.x, 0, at.z);
    this.targetMarker.userData.held = (me.action.progress ?? 0) > 0;
  }

  /**
   * The charge-up ring — how long you have to walk away. It sits over the
   * player; the marker above says which thing it's aimed at.
   */
  syncActionRings(players, myId) {
    const seen = new Set();
    for (const p of players) {
      if (!p.action || !(p.action.progress > 0)) continue;
      seen.add(p.id);
      let rec = this.actionRings.get(p.id);
      if (!rec) {
        rec = buildProgressRing(p.id === myId ? '#ffd66b' : '#9ad285');
        this.readoutsDirty = true;
        this.actorRoot.add(rec);
        this.actionRings.set(p.id, rec);
      }
      rec.position.set(p.x, 2.05, p.z);
      setRingProgress(rec, p.action.progress ?? 0);
    }
    for (const [id, rec] of this.actionRings) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec);
      disposeGroup(rec);
      this.actionRings.delete(id);
    }
  }

  /** Bob the piles and spin their coins so money reads as money. */
  animateCash(now) {
    for (const obj of this.cashProps.values()) {
      const age = (now - (obj.userData.born ?? now)) / 1000;
      obj.position.y = 0.95 + Math.sin(age * 3) * 0.045;
      if (obj.userData.spin) obj.userData.spin.rotation.y = age * 2.2;
    }
  }

  /** Thought bubble showing the item someone wants or is carrying. */
  syncBubble(rec, itemId) {
    if (rec.bubbleKey === itemId) return;
    rec.bubbleKey = itemId;
    if (rec.bubble) {
      rec.obj.remove(rec.bubble);
      rec.bubble = null;
    }
    if (!itemId) return;
    const item = this.catalog.items[itemId];
    if (!item) return;

    const bubble = buildBubble();
    this.readoutsDirty = true;
    const icon = buildModel(item.model, { castShadow: false });
    // Sized to sit *inside* the shell rather than burst out of it.
    icon.scale.setScalar(0.42);
    icon.position.y = -0.14;
    bubble.add(icon);
    rec.obj.add(bubble);
    rec.bubble = bubble;
  }

  /**
   * What someone is actually holding, shown in their hands with a count.
   * You can carry a whole crate, but a single icon made every load look like
   * one item — so there was no way to see a stack.
   */
  syncCarry(rec, carry) {
    const key = carry ? `${carry.item_id}:${carry.qty}` : null;
    if (rec.carryKey === key) return;
    rec.carryKey = key;

    if (rec.carry) {
      rec.obj.remove(rec.carry);
      disposeGroup(rec.carry);
      rec.carry = null;
    }
    if (!carry) return;

    const item = this.catalog.items[carry.item_id];
    if (!item) return;

    const held = new THREE.Group();
    // A visible pile that grows with the load, capped so a full crate still
    // fits in frame.
    const shown = Math.min(carry.qty, 4);
    for (let i = 0; i < shown; i++) {
      const one = buildModel(item.model, { castShadow: false });
      one.scale.setScalar(0.5);
      one.position.set(((i % 2) - 0.5) * 0.16, i * 0.15, ((i % 2) - 0.5) * 0.1);
      held.add(one);
    }
    if (carry.qty > 1) {
      const label = buildTextSprite(`x${carry.qty}`, { fill: '#fff3cf', scale: 0.62 });
      label.position.set(0.3, 0.28 + shown * 0.15, 0);
      held.add(label);
    }
    // Out in front at chest height, so it reads as carried rather than worn.
    held.position.set(0, 0.62, 0.34);
    rec.obj.add(held);
    rec.carry = held;
  }

  /**
   * What someone on a break has got with them.
   *
   * A child of the body like the bubble and the carry, and for the same reason:
   * it follows them to the spot and leaves with them when their kind is
   * redrawn, rather than being a second thing to remember to move.
   *
   * Two numbers arrive and they are used very differently. `pastime` says which
   * prop, so it belongs in a key. `breakProgress` says which *stage* of it — and
   * keying on that raw 0..1 would tear down and rebuild this geometry on every
   * snapshot for a fraction of a mug. So the key carries the stage index, and
   * everything between two stages is `animateRest`'s problem, at 60fps.
   *
   * `resting` is set outside the key check on purpose: the slump is the half
   * that reads from across the shop, and it has to work for a pastime nobody has
   * drawn a prop for yet.
   */
  syncPastime(rec, p) {
    rec.resting = !!p.pastime;
    const model = p.pastime ? (this.catalog.pastimes?.[p.pastime]?.model ?? null) : null;
    const t = p.breakProgress ?? 0;
    const key = model ? `${p.pastime}:${stageIndexAt(model, t)}` : null;
    if (rec.pastimeKey === key) return;
    rec.pastimeKey = key;

    if (rec.pastime) {
      rec.obj.remove(rec.pastime);
      disposeGroup(rec.pastime);
      rec.pastime = null;
    }
    if (!key) return;

    rec.pastime = buildPastimeProp(model, t);
    rec.obj.add(rec.pastime);
  }

  syncShelves(shelves) {
    if (!this.storeLayout) return;
    for (const s of shelves) {
      const def = this.storeLayout.shelves.find((x) => x.id === s.id);
      if (!def) continue;
      let rec = this.shelfProps.get(s.id);

      if (!rec) {
        rec = { group: new THREE.Group(), key: null };
        // Goods are part of the shelf as far as aiming goes — see pickTargets.
        rec.group.userData.pick = true;
        this.actorRoot.add(rec.group);
        this.shelfProps.set(s.id, rec);
      }
      // Re-read the position every sync rather than only on creation. A shelf
      // you pick up and set down elsewhere keeps its id so its stock follows —
      // which only works if the stack follows the shelf too.
      //
      // Everything about where goods sit comes from what the shelf is actually
      // *drawn* as, not from a constant: once a shelf's look is authored
      // content, a redesign or a tier that changes its shape would otherwise
      // leave every stack in the shop hanging in mid-air above it.
      const fx = { ...def, kind: def.kind === 'freezer' ? 'freezer' : 'shelf' };
      const rows = surfacesAt(this.fixtureModel(fx), this.fixtureT(fx));
      // Rows have a front and a back, so the goods have to turn with the unit.
      // A flat top doesn't care, which is why this never mattered before.
      rec.group.rotation.y = -(def.rot ?? 0) * (Math.PI / 2);
      rec.group.position.set(def.x, rows.length ? 0 : this.fixtureHeight(fx), def.z);

      // A unit holds one kind per BOARD now, so this draws a list rather than a
      // single item — board n gets stack n, top down, which is the order
      // `buildShelfGoods` already fills in and the reason no positions had to be
      // invented for this. A unit with no boards piles everything on its roof,
      // which is what a chest freezer and a counter want, so there the stacks
      // are drawn one behind the other rather than side by side.
      const stacks = (s.stacks ?? []).filter((k) => k.qty > 0);
      // On a unit with rows every single unit is a prop, so the redraw has to
      // follow every single unit — `Math.ceil(qty / 4)` was fine when stock was
      // a three-step pile and would now hold four sales' worth of goods on a
      // shelf that no longer has them. Clamped one past what can be shown, so a
      // busy shelf holding forty stops rebuilding once it just reads as full.
      const perBoard = rows.length ? Math.max(1, Math.floor(shelfSlots(rows) / rows.length)) : 0;
      const key = stacks.map((k) => `${k.item_id}:${rows.length
        ? Math.min(k.qty, perBoard + 1)
        : Math.ceil(k.qty / 4)}`).join('|') + `:${rows.length}`;
      if (rec.key === key) continue;
      rec.key = key;
      rec.group.clear();
      if (!stacks.length) continue;

      stacks.forEach((k, n) => {
        const item = this.catalog.items[k.item_id];
        if (!item) return;
        if (!rows.length) {
          // No boards: everything heaps on the roof. Nudged apart so two kinds
          // read as two heaps rather than one interpenetrating mess.
          const heap = buildStack(item.model, k.qty, item.stack);
          heap.position.x += (n - (stacks.length - 1) / 2) * 0.34;
          rec.group.add(heap);
          return;
        }
        // One board each, from the top down. `buildShelfGoods` fills the boards
        // it is handed top-first, so handing it exactly one board puts this
        // kind on that board and nowhere else.
        const board = rows[rows.length - 1 - (n % rows.length)];
        rec.group.add(buildShelfGoods(item.model, k.qty, [board]));
      });
    }
  }

  syncPlots(plots) {
    if (!this.storeLayout) return;
    for (const p of plots) {
      const def = this.storeLayout.plots.find((x) => x.id === p.id);
      if (!def) continue;
      const grown = p.ready ? 1 : (p.growth ?? 0);
      const crop = p.crop_id ? this.catalog.crops[p.crop_id] : null;
      // A staged crop rebuilds when it crosses into the next stage; an unstaged
      // one only ever has the four sizes the ramp below gives it. Either way the
      // key stops us rebuilding geometry sixty times a second for 1% of growth.
      const stage = isStaged(crop?.model)
        ? stageIndexAt(crop.model, grown)
        : (p.ready ? 3 : Math.floor(grown * 3));
      const soil = p.soil ?? 'untilled';
      // How many plants are in the bed is part of what it looks like, so a
      // re-roll after replanting has to rebuild it.
      const count = Math.max(1, p.yield || 1);
      const key = `${soil}:${p.crop_id}:${stage}:${count}`;
      let rec = this.plotProps.get(p.id);

      if (!rec) {
        rec = {
          group: new THREE.Group(), overlay: new THREE.Group(),
          key: null, bar: null, bubble: null, bubbleKey: null,
        };
        // The plants, but not the readout floating over them: a growth bar is
        // something to read, not something to point at.
        rec.group.userData.pick = true;
        this.actorRoot.add(rec.group, rec.overlay);
        this.plotProps.set(p.id, rec);
      }
      rec.group.position.set(def.x, TILE_STYLE[T.PLOT].h, def.z);
      rec.overlay.position.copy(rec.group.position);
      // Before the cache check, not after: the readout has to move every sync
      // even on the ticks where the art is unchanged.
      this.syncPlotOverlay(rec, p, crop, grown);
      if (rec.key === key) continue;
      rec.key = key;
      disposeGroup(rec.group);
      rec.group.clear();

      // Turned earth vs rough turf. A planted bed is always broken soil, so a
      // crop never looks like it's growing straight out of the lawn.
      rec.group.add(buildSoil(p.crop_id ? 'tilled' : soil, PALETTE));

      if (!p.crop_id || !crop) continue;

      // One plant per unit the bed will yield, so what is growing there is what
      // picking it hands over.
      for (const spot of plantSpots(count, hashId(p.id))) {
        const plant = buildModel(crop.model, { t: grown });
        // A crop that draws its own stages has already said what growing looks
        // like — scaling it as well would shrink the sprout it deliberately drew.
        // Anything with a single model still swells from sprout to full size,
        // which is the only growth cue it has.
        if (!isStaged(crop.model)) plant.scale.setScalar(0.35 + grown * 0.65);
        // Then shrink to share the bed. Multiplied, not assigned, or a crowded
        // bed of unstaged crops would lose its growth ramp entirely.
        plant.scale.multiplyScalar(spot.scale);
        plant.position.set(spot.x, 0, spot.z);
        rec.group.add(plant);
      }

      if (p.ready) {
        const glow = new THREE.Mesh(
          new THREE.RingGeometry(0.35, 0.48, 16),
          new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.02;
        rec.group.add(glow);
      }
    }
  }

  /**
   * How far along a crop is, and what it will give you when it's done.
   *
   * Deliberately not part of the cached rebuild above. That only fires when a
   * crop crosses into its next art *stage*, so a bar living in there would
   * advance four times between seed and harvest and sit frozen in between.
   *
   * The two states never both show: a bar that has reached the end says the
   * same thing as the bubble, and saying it twice is how a readable plot turns
   * into a cluttered one.
   */
  syncPlotOverlay(rec, p, crop, grown) {
    const growing = !!crop && !p.ready;

    if (growing && !rec.bar) {
      rec.bar = buildGrowthBar();
      this.readoutsDirty = true;
      rec.bar.position.y = 0.95;
      rec.overlay.add(rec.bar);
    }
    if (rec.bar) {
      rec.bar.visible = growing;
      if (growing) setGrowthBar(rec.bar, grown);
    }

    // Ready: the produce itself, in the same thought-bubble a shopper uses to
    // say what they came in for. One vocabulary for "this is about <item>",
    // rather than teaching a second symbol that means the same thing.
    const item = p.ready && crop ? this.catalog.items[crop.item_id] : null;
    const key = item?.id ?? null;
    if (rec.bubbleKey === key) return;
    rec.bubbleKey = key;

    if (rec.bubble) {
      rec.overlay.remove(rec.bubble);
      disposeGroup(rec.bubble);
      rec.bubble = null;
    }
    if (!item) return;

    const bubble = buildBubble();
    this.readoutsDirty = true;
    const icon = buildModel(item.model, { castShadow: false });
    icon.scale.setScalar(0.42);
    icon.position.y = -0.14;
    bubble.add(icon);
    bubble.position.y = 1.02;
    // Offset the bob per plot so a field going ripe doesn't pulse in lockstep.
    bubble.userData.phase = (rec.overlay.position.x + rec.overlay.position.z) * 0.7;
    rec.overlay.add(bubble);
    rec.bubble = bubble;
  }

  /** Bob every ready-marker, so a ripe plot catches the eye from across the farm. */
  animatePlots(now) {
    for (const rec of this.plotProps.values()) {
      const b = rec.bubble;
      if (b) b.position.y = 1.02 + Math.sin(now / 1000 * 2.6 + (b.userData.phase ?? 0)) * 0.055;
    }
  }

  /**
   * Anger, drawn three ways off the one number the server sends.
   *
   * The flush and the shake both ramp from `anger`, and the shake reuses the
   * per-actor `phase` the breathing already hashes out of the id — without it
   * twenty cross shoppers vibrate in perfect unison, which reads as a screen
   * artefact rather than as a room full of people losing their tempers.
   *
   * Tilt rather than position, because `syncActors` lerps x and z toward the
   * server every frame and a jitter added to those would be pulled straight
   * back out. `rotation.y` is facing; `z` is free.
   */
  animateMoods(now) {
    const t = now / 1000;
    for (const rec of this.customers.values()) {
      const anger = rec.anger;
      if (anger == null) continue;
      const head = rec.obj.userData.head;
      if (head) head.material = material(faceColor(anger));
      rec.obj.rotation.z = anger > 0 ? Math.sin(t * 34 + rec.phase) * 0.1 * anger : 0;
    }
  }

  // -------------------------------------------------------------------------

  render() {
    const now = performance.now();
    this.animateCash(now);
    this.animatePlots(now);
    this.animateMoods(now);
    // Breaks. Nobody who is working costs more than a compare and a return, and
    // this has to be per-frame rather than per-sync for the same reason the
    // markers below are: a worker who only slumped ten times a second would
    // read as the renderer stuttering, not as somebody having a sit down.
    for (const rec of this.players.values()) animateRest(rec, now);
    if (this.liftedRing) {
      // Animated here rather than in syncLifted: state arrives at 10Hz and a
      // marker that only moves ten times a second reads as a rendering fault.
      this.liftedRing.position.y = 1.5 + Math.sin(now / 1000 * 3.4) * 0.12;
      this.liftedRing.rotation.z = now / 1000 * 1.2;
    }
    if (this.aimMarker) {
      // No spin any more, here or below. A ring is rotationally symmetric, so
      // the spin these markers were given was invisible — and the moment they
      // became squares that agree with the tile grid it stopped being
      // invisible and started being wrong.
      this.aimMarker.userData.arrow.position.y = 1.62 + Math.sin(now / 1000 * 4) * 0.11;
    }
    if (this.stockPips?.size) {
      // Per-frame rather than per-sync, like every other marker here: something
      // that only moved ten times a second reads as the renderer stuttering.
      const t = now / 1000;
      for (const pip of this.stockPips.values()) {
        pip.userData.arrow.position.y = 0.62 + Math.sin(t * 3 + (pip.userData.phase ?? 0)) * 0.09;
      }
    }
    if (this.selectedMarker) {
      // A slow breathe, half the rate of anything armed. It has to be alive —
      // a still outline on a shop floor reads as scenery, and this one can be
      // the only marker on screen while you work through the menu — but it must
      // not read as something waiting to be pressed, which is what the aim
      // marker's beat means.
      const s = 1 + Math.sin(now / 1000 * 2) * 0.035;
      this.selectedMarker.userData.ring.scale.setScalar(s);
    }
    this.animateRipples(now);
    this.animateLandings(now);
    if (this.targetMarker) {
      const t = now / 1000;
      const held = this.targetMarker.userData.held;
      // Bobbing while it's only in range, and pulled taut once the charge is
      // running — so the marker answers before the ring has visibly moved.
      this.targetMarker.userData.arrow.position.y = held ? 1.5 : 1.62 + Math.sin(t * 4) * 0.11;
      this.targetMarker.userData.ring.scale.setScalar(held ? 1.12 : 1 + Math.sin(t * 4) * 0.045);
    }
    // A held press winds the aim ring in and speeds it up, so the thing you are
    // pointing at is the thing that reacts. Drawn on `aimMarker` — what your
    // pointer is over — and not on `targetMarker`, which is what your *body* is
    // next to; on a press they are usually different objects, and animating the
    // wrong one tells you the game heard a press somewhere else.
    if (this.aimMarker) {
      const k = this.holdProgress;
      const ring = this.aimMarker.userData.ring;
      if (k === null) {
        ring.scale.setScalar(1);
        ring.material.opacity = 0.9;
      } else {
        // Tightening rather than filling: a ring that shrinks onto its target
        // says "this one, keep going" without needing a second ring in a
        // different style, and it reads at a glance at any zoom.
        //
        // Every term starts at exactly the idle value, so pressing and letting
        // go are both continuous. An earlier cut wound in from 1.22 — a nice
        // anticipation beat in principle, and in practice a ring that jumps a
        // fifth of its size in the single frame you press, which is
        // indistinguishable from a glitch.
        ring.scale.setScalar(1 - 0.26 * k);
        ring.material.opacity = 0.9 + 0.1 * k;
      }
    }
    // Eased like camLook, and for the same reason: a wheel notch that snapped
    // straight to its new scale read as the world flinching rather than as the
    // camera moving. Snapped once it's close, so we stop rebuilding the
    // projection matrix every frame forever.
    const dz = this.camZoom - this.camera.zoom;
    if (dz) {
      this.camera.zoom = Math.abs(dz) < 0.002 ? this.camZoom : this.camera.zoom + dz * 0.18;
      this.camera.updateProjectionMatrix();
    }
    // Swing round to the target corner, same easing idea as zoom and camLook.
    const da = this.camQuarter * QUARTER - this.camAngle;
    if (da) {
      this.camAngle += Math.abs(da) < 0.0005 ? da : da * 0.14;
      this.camOffset.copy(BASE_CAM_OFFSET).applyAxisAngle(AXIS_Y, this.camAngle);
    }
    // Readouts follow the eased angle, not the target one, so they turn *with*
    // the swing instead of snapping to the new corner while the shop is still
    // arriving there.
    if (this.readoutsDirty || this.camAngle !== this.readoutAngle) {
      this.readoutAngle = this.camAngle;
      this.readoutsDirty = false;
      this.faceReadouts();
    }
    this.camLook.lerp(this.camAim.copy(this.camTarget).add(this.camPan), 0.08);
    // Which lamps get a real light follows the camera, so it belongs here rather
    // than in the layout build. Cheap: it returns immediately until the view has
    // actually gone somewhere.
    this.lights.update(this.camLook);
    this.camera.position.copy(this.camLook).add(this.camOffset);
    this.camera.lookAt(this.camLook);
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).add(SUN_OFFSET);
    this.renderer.render(this.scene, this.camera);
  }

  /** Grab the current frame as a PNG data URL (used by the MCP screenshot tool). */
  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/**
 * Everything `buildActor` reads, so a body is rebuilt when — and only when —
 * what it should look like has changed.
 *
 * Null for anyone who is not a hire: a shopper and the player never restage, so
 * their bodies are built once and left alone.
 */
function actorKey(p) {
  return p.staff ? `${p.staff}:${p.tier ?? 1}` : null;
}

/**
 * Every fixture in a layout as one uniform list.
 *
 * The same shape the server works over in build mode. Both sides having their
 * own idea of what a fixture is, is how a menu ends up acting on something the
 * player never pointed at.
 */
function fixturesIn(L) {
  if (!L) return [];
  return [
    ...(L.shelves ?? []).map((s) => ({ ...s, kind: s.kind === 'freezer' ? 'freezer' : 'shelf' })),
    ...(L.checkouts ?? []).map((c) => ({ ...c, kind: 'checkout' })),
    ...(L.stations ?? []).map((s) => ({ ...s, kind: 'station' })),
    ...(L.plots ?? []).map((p) => ({ ...p, kind: 'plot' })),
    // Decorations carry their own kind, because there is more than one of them
    // and which list they came out of no longer says which.
    ...(L.props ?? []),
  ];
}
