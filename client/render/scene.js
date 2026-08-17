/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, FIXTURE_LOOK, EDGE_STYLE, CEILING_Y, GLASS, edgeBands, jitter, faceColor, patternColor, shade, stripeBars, stripeDuty } from './palette.js';
import {
  buildModel, buildCharacter, buildStack, buildShelfGoods, shelfShow,
  buildBubble, buildCashDrop, buildVehicle,
  buildStationBays,
  buildTextSprite, setTextSprite, buildMoneyLabel, moneySaid,
  buildPallet, CRATE_STEP, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, buildCageMarker, buildWorkSpot, disposeGroup, material,
  buildGrowthBar, setGrowthBar,
  buildRipple,
  buildStamp,
  weld, paintLit,
} from './props.js';
import { T } from '../../shared/tiles.js';
import {
  FIXTURES, workSpots, spotsOf, canPlace, turn, rot4, groundIndex, groundKindOfTile, isProp, shelfKind,
} from '../../shared/build.js';
import { pieceFor, surfaceOf } from '../../shared/pieces.js';
import { Lights, emittersIn, BAKED_LAYER } from './lights.js';
import {
  isStaged, stageIndexAt, tierProgress, partsAt, modelHeight, modelBounds, surfacesAt, drawableBoards,
  variantModel, variantWork, skinKey,
} from '../../shared/model.js';
import { buildPastimeProp, animateRest } from './pastime.js';
import { buildLoopingProp, animatePuffs, animateMotion } from './motion.js';

/** How many world tiles fit vertically on screen at 1× zoom. Smaller = closer in. */
const FRUSTUM = 17;

/**
 * Zoom rides on `camera.zoom` rather than on FRUSTUM, so the frustum stays a
 * fixed statement about the world and only resize() ever recomputes it. Three's
 * `unproject` already folds zoom into the inverse projection, which is why
 * pickTile and pickFixture keep working at any zoom without knowing it exists.
 */
const RING_Y = 1.2;           // charge ring height — just clear of a head at 0.96
/**
 * How close to a pile of goods counts as pointing at it (`nearestBoard`).
 *
 * Pixels, not tiles: the thing being fixed is how hard a small target is to hit
 * with a mouse, which is a distance on the screen, and a distance in the world
 * is a different number at every zoom.
 *
 * The ceiling on it is the OTHER answer, not fairness between the piles. A
 * board's stock stands on a shelf about a tile deep, and the frame, base and
 * end panels around it are what still open the unit's own menu — so a radius
 * wide enough to swallow those has taken the menu away on any stocked shelf.
 * 14 was tried and was too much: a stocked unit is three piles a few pixels
 * apart, so three 14px haloes cover the whole top of it and there is nowhere
 * left to press for the menu — the fix for one target being small ate the other
 * one whole. 4 is a forgiving edge on a pile rather than a claim on the
 * furniture around it — about a loaf's width of slack, settled by hand against
 * a stocked unit. Anything that raises this has to check the same thing: can
 * you still open a FULL shelf.
 */
const BOARD_SNAP_PX = 4;
/** Where a pile of takings sits: on the counter, not inside it. Its label
 *  hangs a fixed distance over the same spot, so the two cannot drift apart. */
const CASH_Y = 0.95;
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
 * Units drawn in someone's arms before the pile stops growing and the count
 * carries the rest — the same concession `BED_MAX` makes. Low on purpose: this
 * sits at chest height on a person who is walking, and a stack taller than they
 * are stops reading as carried.
 */
const CARRY_SHOWN = 4;

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

/**
 * One shadow map per this many frames. See the constructor.
 *
 * 3 is 20Hz at a 60fps draw, which is twice the rate the world itself arrives
 * at — the snapshot is 10Hz, so a shadow updated any faster than this is
 * interpolating a body position that has not moved on the server yet.
 */
const SHADOW_EVERY = 3;

/** Scratch for `pickPropBox`, which runs per prop per pointer move. */
const BOX_HIT = new THREE.Vector3();

/** Scratch for `sealedPile`, which fires rays from a pile back at the viewer. */
const SEAL_RAY = new THREE.Raycaster();
// Same reason as `pointerRay`: a raycaster only sees layer 0 out of the box, and
// walls now sit on `BAKED_LAYER`. A ray that could not see a wall would call
// every pile in the shop visible.
SEAL_RAY.layers.enableAll();
const SEAL_DIR = new THREE.Vector3();
const SEAL_FROM = new THREE.Vector3();

/**
 * Where on a pile `sealedPile` looks from, as fractions of its own box.
 *
 * The top face and the two upper corners facing the camera, plus the middle.
 * The top is what matters: a unit with no lid is one whose stock clears its own
 * back panel, and that is the difference the test exists to find. The middle is
 * in so a pile short enough to hide behind its own board still answers.
 */
const SEAL_SAMPLES = [
  [0.5, 0.5, 0.5],
  [0.5, 0.98, 0.5], [0.08, 0.98, 0.08], [0.92, 0.98, 0.08],
  [0.08, 0.98, 0.92], [0.92, 0.98, 0.92],
  [0.92, 0.6, 0.5], [0.5, 0.6, 0.92],
];

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

/**
 * How fast the keys fly the view in build mode, in tiles a second at zoom 1.
 *
 * Divided by zoom where it is used, so it is a *screen* speed: the view crosses
 * the frustum in about a second and a half however far out you are, which is
 * the same relationship a drag has and the one the eye is expecting.
 */
const FLY_SPEED = 14;

/** How far past the edge of the world the free camera may look, in tiles. */
const FLY_MARGIN = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

/**
 * What the one lorry is filed under.
 *
 * `snapshot().van` is a field rather than a row in a list, because there is one
 * delivery run at a time — so it has no id of its own, and the map that holds
 * every drawn vehicle needs one. A literal that cannot collide with a customer
 * id, which is what every other key in that map is.
 */
const VAN_ID = '@van';

/**
 * How fast a drawn vehicle chases where the server says it is, and how fast it
 * comes round to which way it is pointing. Both per second.
 *
 * Vehicles are eased per FRAME rather than per snapshot, which is the one place
 * they differ from people, and the reason is speed. State lands at 10Hz and
 * `syncActors` lerps toward it there, so a shopper at 1.6 tiles/second advances
 * in sixth-of-a-tile hops six frames apart — small enough that nobody has ever
 * noticed. A lorry at 3.2 does twice that in the same hop, along a straight
 * open lane with nothing beside it, which is where a judder is most visible. So
 * this is the same argument the bobbing markers make in `render`: something
 * that only moves ten times a second reads as the renderer stuttering.
 *
 * The turn is deliberately slower than the chase. `vanRoute` is straight legs
 * with a right angle in the middle of them, so `facing` snaps a quarter turn
 * between two ticks; easing it is what makes that read as a lorry going round a
 * corner rather than as the mesh being swapped for a different one.
 */
const VEHICLE_CHASE = 9;
const VEHICLE_TURN = 5;

/**
 * Which way to turn a vehicle so its nose points where it is going.
 *
 * Two conventions meet here and neither of them is wrong. A model is authored
 * FACING EAST — nose at +x, length along x — which is the convention every
 * fixture is drawn in and the one `buildFixtureGhost` turns by. A body's
 * `facing` is `Math.atan2(dx, dz)`, which is a +z-forward reading: setting
 * `rotation.y = facing` swings local +z onto the heading, and that is right for
 * a character because its nose is a nub on +z.
 *
 * A quarter turn is the whole difference between them. Worth its own function
 * with its own name because getting it wrong is not subtle in principle and is
 * very subtle in practice: a van is nearly symmetric front to back at this
 * scale and this zoom, so a lorry driving sideways up the border ring still
 * reads as a lorry — a slightly odd one, in a way you would blame on the art.
 */
const vehicleYaw = (facing) => (Number(facing) || 0) - Math.PI / 2;

/**
 * The shorter way round from one angle to another, in radians, −π..π.
 *
 * The double modulo is not superstition. JavaScript's `%` keeps the sign of the
 * *dividend*, so the one-line version of this returns a number below −π
 * whenever the gap happens to be negative enough — and it is only ever that
 * negative when a yaw has wandered a long way from its target, which is exactly
 * the case where an answer outside the range spins the lorry the wrong way. It
 * cannot happen with the angles this is handed today, and "cannot happen today"
 * is how a function ends up wrong the day something else grows a heading.
 */
function turnTo(from, to) {
  const TAU = Math.PI * 2;
  return (((to - from + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

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
    /**
     * The shadow pass is a SECOND full draw of the scene — every object walked,
     * culled and issued again into a 2048² depth map — and by default three.js
     * does it on every single frame. Nothing in this shop justifies that: the
     * building never moves, and the things that do are people ambling at
     * walking pace under a sun that is 40° up. A shadow one frame stale is not
     * a shadow anybody can see is stale.
     *
     * So the map is redrawn on a cadence instead (`SHADOW_EVERY`), which halves
     * the per-frame object work outright. It is the frame budget's single
     * biggest lever and the only one that costs nothing visible.
     */
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowTick = 0;

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
    // Whose shoulder it rides on. Null is you, which is every frame anybody has
    // ever played; a hire's roster id is the camera watching them work instead.
    // A roster id rather than a body, because a body is re-sent whole in every
    // snapshot and one held here would freeze the view where they were standing
    // when you pressed it.
    this.watching = null;
    // Where the view has been dragged to, relative to whoever it follows. Kept
    // apart from camTarget because that is overwritten from the player's
    // position every sync — a pan folded into it would be erased 10 times a
    // second. `camAim` is the sum, and exists only so render() adds without
    // allocating a vector every frame.
    this.camPan = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    // Whether that pan is bounded by the world rather than by a radius around
    // the player — build mode, where the view has to reach places nobody can
    // stand. See `setFreeRoam`.
    this.freeRoam = false;
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
    // The parts of built fixtures that move under their own steam — a blade, a
    // lever, a fan. Kept as its own index rather than walked out of `staticRoot`
    // every frame, because that is the whole shop and almost none of it moves.
    // Filled by `addFixtureProps` and therefore emptied by it too: the meshes in
    // here belong to groups that a re-flow disposes.
    this.movingFixtures = new Map();
    // Where each decoration's art actually ended up, by fixture id. Filled and
    // cleared by `addFixtureProps` for the same reason as the map above: it
    // describes meshes a re-flow throws away.
    this.propBoxes = new Map();
    this.shelfProps = new Map();
    this.plotProps = new Map();
    this.cashProps = new Map();
    // One label per TILE of money rather than one per pile — see
    // `syncCashLabels`. Keyed by tile for the same reason: the piles under it
    // are picked up one at a time, and a readout that belonged to one of them
    // would leave with it while the rest of the money was still sitting there.
    this.cashLabels = new Map();
    this.deliveryProps = new Map();
    // The lorry on its run and the cars in the car park, in one map, because
    // they are one thing — see `syncVehicles`. In `actorRoot` with the other
    // props, and NOT cleared by `buildWorld`: a vehicle is positioned from the
    // snapshot rather than from the layout, so a re-flow neither moves one nor
    // takes one away, which is what `refreshFixtureProps` exists to cope with
    // for the props that are hung off a fixture id.
    this.vehicleProps = new Map();
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

    // The ground is lit by lamps that were added up on the CPU (`bakeInto`), so
    // it sits on a layer the point lights cannot see or it would be lit twice.
    // The sky is not a lamp and has to be let back in by hand — a layer is a
    // filter on EVERY light, so leaving these three out drops the floor to
    // black. The camera needs it too, or it simply stops drawing the shop.
    for (const l of [this.ambient, sun, bounce]) l.layers.enable(BAKED_LAYER);
    this.camera.layers.enable(BAKED_LAYER);

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
    return this.clampPan();
  }

  /**
   * Fly the view itself, from a direction the keys named, for `dt` seconds.
   *
   * The build camera. It moves `camPan` exactly as a drag does — same offset,
   * same follow underneath, same one line to let go of it — so the two can be
   * used in the same breath without either snatching the view off the other.
   *
   * `dx`/`dz` arrive already turned by whatever quarter the view is on, and are
   * normalised here so a diagonal is not 1.4× faster than a straight line.
   */
  flyBy(dx, dz, dt) {
    if (!dx && !dz) return this.camPan;
    const len = Math.hypot(dx, dz) || 1;
    const step = (FLY_SPEED / this.camZoom) * dt;
    this.camPan.x += (dx / len) * step;
    this.camPan.z += (dz / len) * step;
    return this.clampPan();
  }

  /**
   * Take the view off the leash, or put it back on.
   *
   * The leash is what makes the follow camera a follow camera, and build mode
   * is the one time it is wrong: the whole reason the view needs to move there
   * is to reach somewhere you cannot stand — a room you have just sealed, the
   * far side of the fence, the end of a grown farm — and a radius around your
   * body cannot express that. So while building, the world is the limit.
   *
   * Putting it back on re-clamps, which matters: leaving build mode from the
   * far end of the farm would otherwise leave you playing somebody who is off
   * screen. The glide back is free, because `camLook` eases toward its aim.
   */
  setFreeRoam(on) {
    if (this.freeRoam === !!on) return;
    this.freeRoam = !!on;
    this.clampPan();
  }

  /**
   * Hold the view inside whichever bound is in force. One place, because both
   * ways of moving it write the same field — a fly that clamped to the world
   * and a drag that clamped to the leash would fight over every frame.
   */
  clampPan() {
    const L = this.storeLayout;
    if (this.freeRoam && L) {
      // Per-axis and against the map, so the corners of a rectangular world are
      // all reachable. Aimed at where the view ENDS UP (`camTarget + camPan`),
      // because the bound is a fact about the world and the pan is measured
      // from a body that could be standing anywhere in it.
      const lo = -FLY_MARGIN;
      this.camPan.x = clamp(this.camPan.x, lo - this.camTarget.x, L.w + FLY_MARGIN - this.camTarget.x);
      this.camPan.z = clamp(this.camPan.z, lo - this.camTarget.z, L.h + FLY_MARGIN - this.camTarget.z);
      return this.camPan;
    }
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

  /**
   * Ride on a hire instead of on yourself. `null` gives the camera back.
   *
   * The pan goes with the switch, for the reason `walkTo` recentres: a drag is
   * an offset from whoever is being followed, so keeping it would hand you a
   * camera aimed fourteen tiles off the person you just asked to watch.
   */
  watch(hire) {
    this.watching = hire ?? null;
    this.recentre();
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
      // What a hire is wearing, keyed the same way, and cleared by the same
      // sweep below — a skin recoloured over MCP repaints whoever has it on.
      skins: Object.fromEntries((catalog.skins ?? []).map((s) => [s.id, s])),
      // ...and what a shopper is carrying their shopping in, keyed the same way
      // and for the same reason. The snapshot sends the id and how full it is;
      // which bag that is stays a row somebody can redraw.
      kits: Object.fromEntries((catalog.kits ?? []).map((k) => [k.id, k])),
      // A van and a car are drawn from their own rows too, and looked up by the
      // id the snapshot sends rather than by `use` — which vehicle turns up is
      // the sim's decision (`vehicleFor`), and the renderer draws whichever one
      // it was told about. Asking `use` here would be a second, quieter answer
      // to that question, and the two would disagree the day somebody authors a
      // bigger lorry.
      vehicles: Object.fromEntries((catalog.vehicles ?? []).map((v) => [v.id, v])),
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
    // Both props on an appliance: the ingredient row, and what it looks like
    // while it runs. A working look redrawn over MCP should reach the machine
    // that is running right now, not the next batch.
    for (const [, rec] of this.stationProps) { rec.key = null; rec.workKey = null; }
    // ...and the van that is on the road while you are drawing it. A vehicle is
    // on screen for about six seconds a run, so "it'll be right next time" is a
    // worse answer here than anywhere else in this sweep — the next time is six
    // in-game hours away, and by then nobody is watching the bay.
    for (const [, rec] of this.vehicleProps) rec.key = null;
    // Fixtures are built with the world, so redrawing one means redrawing that.
    // This also covers the ordinary boot order: the catalog usually lands after
    // the first layout, and without it the shop would be furnished with the
    // fallback blocks until something else happened to re-flow it.
    this.rebuildWorld();
  }

  // -------------------------------------------------------------------------
  // Static world
  // -------------------------------------------------------------------------

  /**
   * Lay the bars of a striped design over the cells that wear it.
   *
   * **Which way they run is read off the shape you painted**, not authored and
   * not fixed. A crossing is a patch two cells deep across a road and however
   * many long, and its bars run the SHORT way — across the traffic, along the
   * walk. So each cell measures its own contiguous run in x and in z within
   * this design's own cells, and the bars span whichever is shorter. A square
   * patch has no answer and takes z, which is the crossing on the road the
   * world seeds.
   *
   * Doing it per cell rather than per patch is what keeps it local: a crossing
   * that turns a corner gets bars that turn with it, and no part of this has to
   * know what a patch is.
   *
   * One extra instanced mesh for the whole design, laid a hair over the cell
   * tops. It is the only ground pattern that costs any geometry at all.
   */
  addStripes(cells, surface, height, box, dummy) {
    const has = new Set(cells.map(([x, z]) => `${x},${z}`));
    const run = (x, z, dx, dz) => {
      let n = 1;
      for (let i = 1; has.has(`${x + dx * i},${z + dz * i}`); i++) n++;
      for (let i = 1; has.has(`${x - dx * i},${z - dz * i}`); i++) n++;
      return n;
    };
    const bars = new THREE.InstancedMesh(
      box,
      material(surface.accent ?? shade(surface.color, -0.55)),
      cells.length * stripeBars(surface),
    );
    bars.castShadow = false;
    bars.receiveShadow = true;
    // Painted onto ground that is baked, so these are too — a crossing under a
    // lamp post with unlit stripes is a hole in the pool the shape of the paint.
    bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bars.count * 3), 3);
    const bare = new Float32Array(bars.count * 3).fill(1);
    const at = new Float32Array(bars.count * 3);
    const n0 = stripeBars(surface);
    const duty = stripeDuty(surface);
    let n = 0;
    for (const [x, z] of cells) {
      // Longer along x means the road runs east-west, so the bars run along z.
      const alongZ = run(x, z, 1, 0) >= run(x, z, 0, 1);
      for (let i = 0; i < n0; i++) {
        const off = (i - (n0 - 1) / 2) / n0;
        dummy.position.set(alongZ ? x + off : x, height + 0.012, alongZ ? z : z + off);
        dummy.scale.set(alongZ ? duty : 1, 0.02, alongZ ? 1 : duty);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        at[n * 3] = dummy.position.x;
        at[n * 3 + 1] = dummy.position.y;
        at[n * 3 + 2] = dummy.position.z;
        bars.setColorAt(n, this.lights.bakeInto(
          new THREE.Color(1, 1, 1), dummy.position.x, dummy.position.y, dummy.position.z,
        ));
        bars.setMatrixAt(n++, dummy.matrix);
      }
    }
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    bars.layers.set(BAKED_LAYER);
    this.bakedGround.push({ mesh: bars, bare, at });
    this.staticRoot.add(bars);
  }

  /**
   * Re-do the lamp bake over ground that has not moved.
   *
   * Called when the hour turns, and that is the whole of what a bake costs: the
   * sum is only right for one value of `lit`, so a floor baked at midnight stays
   * midnight-bright through the morning unless somebody redoes it. Once an hour
   * rather than every frame because that is the rate the sun visibly moves at,
   * and this is a pass over every cell in the shop times every lamp in it —
   * nothing at 900 × 20, silly at 60fps.
   *
   * Straight over the stored unlit colours, so it can run any number of times
   * without the light compounding. That is what `bare` is for.
   */
  /** One fixture's share of the bake, as a flat tint through its whole group. */
  paintProp(group, x, y, z) {
    const c = this.lights.bakeInto(new THREE.Color(1, 1, 1), x, y, z);
    paintLit(group, c.r, c.g, c.b);
  }

  rebakeGround() {
    const c = new THREE.Color();
    for (const { group, x, y, z } of this.bakedProps ?? []) this.paintProp(group, x, y, z);
    for (const { mesh, bare, at } of this.bakedGround ?? []) {
      if (!mesh.instanceColor) continue;
      for (let i = 0; i < mesh.count; i++) {
        c.setRGB(bare[i * 3], bare[i * 3 + 1], bare[i * 3 + 2]);
        this.lights.bakeInto(c, at[i * 3], at[i * 3 + 1], at[i * 3 + 2]);
        mesh.setColorAt(i, c);
      }
      mesh.instanceColor.needsUpdate = true;
    }
  }

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
    // Shelf and plot props live in `actorRoot`, not `staticRoot`, so they
    // survive the clear above and have to be dealt with by name. Only the ones
    // whose fixture the re-flow removed — emptying the maps wholesale is what
    // made every shelf in the shop blink each time you laid a tile, and taking
    // the records out without taking the MESHES out orphans a full set of stock
    // at the old positions. See `refreshFixtureProps` for both.
    this.refreshFixtureProps(L);

    // Lamps first, because the floor is about to be BAKED with them — every
    // emitter in the shop folded into the per-cell colour the tile mesh was
    // going to carry anyway. It used to be the last line in this method, back
    // when nothing here needed to know where the light was.
    this.lights.setEmitters(emittersIn(fixturesIn(L), (f) => this.pieceOf(f), CEILING_Y));
    this.bakedGround = [];

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
      // The unlit colour of every cell, and where that cell is. Kept so the hour
      // can be re-baked without re-deriving the pattern: `patternColor` and the
      // jitter hash are per cell, and the sun coming up does not move either.
      const bare = new Float32Array(cells.length * 3);
      const at = new Float32Array(cells.length * 3);

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
        // ...and the lamps are the same kind of thing: a number per cell, worked
        // out once. This is what buys unlimited fittings — see `bakeInto`. The
        // unlit colour is kept beside it because the hour moves and the pattern
        // does not: re-deriving it would mean re-running `patternColor` and the
        // jitter hash for every cell in the shop at every rebake.
        bare[i * 3] = c.r;
        bare[i * 3 + 1] = c.g;
        bare[i * 3 + 2] = c.b;
        at[i * 3] = x;
        at[i * 3 + 1] = height;
        at[i * 3 + 2] = z;
        mesh.setColorAt(i, this.lights.bakeInto(c, x, height, z));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Off layer 0, where the point lights are. Baked ground lit a second time
      // by the pool would pool visibly harder under the eight fittings that got
      // a real light, which is the cap back on screen. See `BAKED_LAYER`.
      mesh.layers.set(BAKED_LAYER);
      this.bakedGround.push({ mesh, bare, at });
      this.staticRoot.add(mesh);

      // ...and the one pattern that is not a colour. See `STRIPE_BARS`.
      if (surface?.pattern === 'stripes') this.addStripes(cells, surface, height, box, dummy);

      // A contrasting top slab, so a raised tile reads as built rather than as
      // an anonymous coloured block. Only the wall is left: the four furniture
      // entries went with the fixture tiles, and furniture draws its own art.
      const TOPS = { [T.WALL]: PALETTE.wallTop };
      if (TOPS[kind]) {
        const top = new THREE.InstancedMesh(box, material(TOPS[kind]), cells.length);
        top.castShadow = false;
        top.receiveShadow = true;
        // Baked with the slab it caps, or a wall under a lamp is a lit wall with
        // an unlit lid. Its instance colour is plain white before the lamps get
        // to it: the colour it is meant to be is already on the material.
        top.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
        const topBare = new Float32Array(cells.length * 3).fill(1);
        const topAt = new Float32Array(cells.length * 3);
        cells.forEach(([x, z], i) => {
          dummy.position.set(x, height + 0.045, z);
          dummy.scale.set(1.04, 0.09, 1.04);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          top.setMatrixAt(i, dummy.matrix);
          topAt[i * 3] = x;
          topAt[i * 3 + 1] = height + 0.045;
          topAt[i * 3 + 2] = z;
          top.setColorAt(i, this.lights.bakeInto(new THREE.Color(1, 1, 1), x, height + 0.045, z));
        });
        top.instanceMatrix.needsUpdate = true;
        if (top.instanceColor) top.instanceColor.needsUpdate = true;
        top.layers.set(BAKED_LAYER);
        this.bakedGround.push({ mesh: top, bare: topBare, at: topAt });
        this.staticRoot.add(top);
      }
    }

    this.addEdges(L);
    this.addFixtureProps(L);
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

  /**
   * Take the stock and crops off fixtures the re-flow got rid of, and leave
   * everything else standing.
   *
   * This used to bin the lot, and that is what "painting a floor makes every
   * shelf redraw" was. The teardown is synchronous and the refill is not: goods
   * are drawn from the *snapshot*, which arrives ten times a second, so every
   * shelf in the shop and every bed on the farm went empty for up to 100ms and
   * then came back. One re-flow is a blink you could argue with — but build
   * mode re-flows on every placement, wall segment and floor stroke, so what it
   * actually reads as is the shop flickering the whole time you work in it.
   *
   * Nothing about a floor, a wall, or a shelf three aisles over changes what is
   * drawn on this board, which is why keeping the record is safe: `syncShelves`
   * re-reads position, rotation and boards every sync already — that is what
   * makes a fixture you MOVE take its stock with it — so a survivor is placed
   * against the new layout on the very next tick either way.
   *
   * Two halves, and both are load-bearing:
   *
   * - **A record whose fixture is gone must go**, meshes and all. Deleting from
   *   the map alone orphans them in the scene at the old positions, which is
   *   the scar `buildWorld` carries a paragraph about — stock apparently lying
   *   about on the floor, and another full set leaked on every re-flow. A
   *   plot's readouts are a second `actorRoot` child, so they go out by name.
   * - **A survivor's `key` is dropped**, so the next sync redraws its goods
   *   rather than trusting a cache built against the old shop. What is on
   *   screen stays up in the meantime, which is the whole point — but it is not
   *   *trusted*, because a tier that keeps its board count while moving the
   *   boards would otherwise leave every stack at the old heights.
   *
   * `stationProps` has worked this way since it was written — it sweeps its own
   * dead records at the end of `syncStations` — which is why an appliance's
   * readouts never flickered while every shelf in the building did.
   */
  refreshFixtureProps(L) {
    const alive = [
      new Set((L.shelves ?? []).map((s) => s.id)),
      new Set((L.plots ?? []).map((p) => p.id)),
    ];
    [this.shelfProps, this.plotProps].forEach((map, i) => {
      for (const [id, rec] of map) {
        if (alive[i].has(id)) { rec.key = null; continue; }
        this.actorRoot.remove(rec.group);
        disposeGroup(rec.group);
        if (rec.overlay) {
          this.actorRoot.remove(rec.overlay);
          disposeGroup(rec.overlay);
        }
        map.delete(id);
      }
    });
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

    // Every mesh in here was built against the shop we are about to replace.
    // Emptied before the loop rather than in `buildWorld` so that the one place
    // that fills it is the one place that clears it.
    this.movingFixtures.clear();
    this.propBoxes.clear();
    this.bakedProps = [];

    for (const f of fixturesIn(L)) {
      const model = this.fixtureModel(f);
      // A fixture nobody has drawn used to be a coloured tile block, because it
      // WAS a tile. Nothing stamps one now, so an unstyled kind would be an
      // invisible thing you can walk into — hence the fallback block, at the
      // colour and height its tile used to have.
      let prop = model
        ? buildModel(model, {
          t: this.fixtureT(f),
          abuts: (step) => this.carriesOn(byTile, f, step),
        })
        : plainBlock(FIXTURE_LOOK[f.kind]);
      if (!prop) continue;
      // Down to one mesh per colour, the same way stock is — a shelf is eight
      // or ten primitives that will never move relative to each other, and a
      // furnished shop is a few hundred of them drawn twice a frame. Anything
      // flagged `motion` is held out by name: the picture would be right and
      // the blade would never turn again, which reads as a broken machine.
      // Whatever it comes back as still wears the group's `userData`, so
      // picking, landing and the moving list all go on pointing at the same
      // things.
      if (prop.userData.moving?.length !== undefined) {
        const spin = new Set(prop.userData.moving.map((m) => m.mesh));
        prop = weld(prop, spin.size ? (o) => spin.has(o) : null);
      }
      // Models are authored facing east, which is rot 0 — the same convention
      // the layout generator has always used for which side you work from.
      prop.rotation.y = -(f.rot ?? 0) * (Math.PI / 2);
      prop.position.set(f.x, this.fixtureBaseY(f), f.z);
      // One thing you can point at, whatever it is made of. `pickFixture`
      // raycasts these and walks back up to whichever group wears the flag.
      prop.userData.pick = true;
      // ...and WHICH fixture this group is, which the tile it stands on can no
      // longer say. A decoration stamps no tile on purpose, so a lamp hangs
      // over a shelf and a plant stands at the end of a counter — two fixtures,
      // one tile, and `fixtureAt` can only ever answer the first of them.
      // Stamped here rather than looked up later because this is the one place
      // that knows: the group is built FROM `f`. Safe against the re-minting
      // `fixtureAt` was chosen to dodge, too — these groups are rebuilt from
      // the layout in the same call that re-mints, so the id on one is never
      // older than the mesh.
      prop.userData.fixture = f.id;
      this.staticRoot.add(prop);
      // How big it came out, in world space, for anything that has to treat the
      // thing as an object rather than as a cell. Two callers, and they have to
      // agree or the game lies: `pickFixtureHit` tests the pointer against this,
      // and the aim marker draws a cage of exactly it. Only for props — every
      // other kind owns its tile, and a tile is the better answer for those,
      // since you point at a shelf to walk to the side of it.
      //
      // Measured here because this is the only place the art exists as a whole:
      // `modelBounds` knows the model and not the tier it resolved to, the
      // variant it picked, or where it ended up standing.
      if (isProp(f.kind)) {
        prop.updateMatrixWorld(true);
        this.propBoxes.set(f.id, new THREE.Box3().setFromObject(prop));
      }
      // Baked, like the ground it stands on. A lamp is a point *under* a
      // canopy, so the lid of a display case faces away from every light in the
      // room and stays dark however bright the strip inside it is — which reads
      // as the upgrade not working. This has no direction to get wrong.
      //
      // Measured at half the unit's height, so a tall case is lit by what is
      // beside it rather than by what is on the floor at its feet.
      this.bakedProps.push({ group: prop, x: f.x, y: this.fixtureBaseY(f) + 0.5, z: f.z });
      this.paintProp(prop, f.x, this.fixtureBaseY(f) + 0.5, f.z);
      // ...and off layer 0 with the ground, or the eight real lights would light
      // it a second time and the units near you would flare as you walked.
      prop.traverse((o) => o.layers.set(BAKED_LAYER));
      if (landed.has(f.id)) this.land(prop, f.x, f.z);
      // Anything authored with `motion`. Two identical machines side by side
      // would otherwise beat in perfect unison, which reads as one animation
      // playing twice rather than as two machines — so each gets a fixed offset
      // out of where it stands, which survives a re-flow the way its id does.
      if (prop.userData.moving?.length) {
        this.movingFixtures.set(f.id, { moving: prop.userData.moving, phase: (f.x * 0.31 + f.z * 0.17) % 1 });
      }
    }

    // Lamps are set at the TOP of `buildWorld` now, not here, because the floor
    // is baked with them on the way past — this method runs after the tiles are
    // already coloured. It is the same call against the same layout either way.
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
    if (!n || n.kind !== f.kind) return false;
    if (rot4(n.rot ?? 0) === rot4(f.rot ?? 0)) return true;
    // ...or the row TURNS here. A corner unit stands at a different rot to the
    // run butting into it — that is what makes it a corner — so a same-rot test
    // called every run beside one an end, and every row in the shop grew a panel
    // where it met the corner it was supposed to flow into.
    return this.turnsCorner(n);
  }

  /**
   * Does this unit carry shelving on BOTH axes — is it a corner?
   *
   * Read off the art rather than off the variant's name, the same argument
   * `seamStep` and `drawableBoards` make: an L is a unit with boards running
   * one way and boards running the other, and that is visible in the boxes
   * somebody drew. A name test would answer "no" for the next corner design
   * anybody authors under a different id.
   */
  turnsCorner(f) {
    const boards = surfacesAt(this.fixtureModel(f), this.fixtureT(f));
    return boards.some((b) => b.depth >= b.span) && boards.some((b) => b.span > b.depth);
  }

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
    // Keyed by colour as well as by kind and orientation, because a band may
    // carry its own — a signed way through is an ordinary opening with its
    // threshold painted (see `edgeBands`). One material per mesh, so a run has
    // to be uniform in it.
    const push = (kind, vertical, spec) => {
      const k = `${kind}:${vertical ? 'v' : 'h'}:${spec.color ?? ''}`;
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
        const mesh = new THREE.InstancedMesh(box,
          material(set[0].color ?? style.color, alpha), set.length);
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

  // The awning used to be built here — four striped boxes hung off `L.door` on
  // every re-flow. It is content now: an `awning` piece in the build catalog,
  // stamped over the door as ordinary decorations the first time a save loads
  // (`freezeAwning`, server/sim/index.js). Which is what made it erasable: a
  // thing the renderer draws for you is a thing nobody can point at, price,
  // move or take down, and the palette had nothing that could replace it.

  // -------------------------------------------------------------------------
  // Dynamic actors
  // -------------------------------------------------------------------------

  syncState(state, myId) {
    /**
     * Whether the world is stopped, which the renderer has to be told rather
     * than able to work out.
     *
     * Everything else in here is a function of the snapshot, so a paused world
     * freezes for free — a body that does not move arrives at the same place ten
     * times a second. The exception is `animateStations`, which is the one loop
     * driven by the PAGE's clock instead of the shop's, precisely so a blade
     * turns at 60fps off a flag that arrives at 10Hz. Left alone it keeps
     * turning in stopped time, which reads as the pause having failed.
     */
    this.paused = !!state.paused;
    // Kept for `pickPerson`: the records hold the meshes, and the answer has to
    // be the person, not the group they are drawn as.
    this.playerState = state.players;
    // Stashed on the scene rather than threaded through every sync that wants
    // it: how much a crate holds is a property of the shop, like the catalog,
    // and it is read by two renderers at different depths. Set BEFORE the actor
    // pass, which is the one that would otherwise key a carried crate against
    // `undefined` on the first frame and redraw it on the second.
    this.crateCap = state.crateCap ?? 6;
    this.syncActors(state.players, this.players, (p) => this.buildActor(p), (p) => actorKey(p));
    this.syncActors(state.customers, this.customers, (c) => buildCharacter(c.color));
    this.syncShelves(state.shelves);
    this.syncPlots(state.plots);
    this.syncCashDrops(state.cashDrops ?? []);
    this.syncDeliveries(state.deliveries ?? [], this.crateCap);
    this.syncVehicles(state.van ?? null, state.cars ?? []);
    this.syncStations(state.stations ?? []);
    this.syncActionRings(state.players, myId);
    this.syncLifted(state.players.find((p) => p.id === myId));
    this.syncActionTarget(state.players.find((p) => p.id === myId));
    this.syncStockTargets(state.players.find((p) => p.id === myId));

    // Who the camera is riding on. Falling back to `me` when the hire being
    // watched has no body is not a nicety: they can be let go, or their kind
    // deleted over MCP, by the other player — and a camera left aimed at
    // somebody who is not there is a shop you cannot get back to.
    const me = state.players.find((p) => p.id === myId);
    const eye = (this.watching && state.players.find((p) => p.hire === this.watching)) || me;
    if (eye) {
      this.camTarget.set(eye.x, 0, eye.z);
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
    // one number — so panning sharpens the near end of the shop rather than
    // switching the far end off. It only ever lifts the things the bake cannot
    // reach now; the floor already has every one of those lamps in it.
    this.lights.setDaylight(daylight);
    this.ambient.intensity = 0.38 + daylight * 0.52 + this.lights.spill;
    this.ambient.color.copy(FILL_DUSK).lerp(FILL_HIGH, daylight);

    // The baked half of the same sunset, on the hour. Every lamp in the shop is
    // already in the floor's colours (`bakeInto`), and that sum is only right
    // for one value of `lit` — so the ground has to be told the sun moved, the
    // same way the sky just was. By hour rather than continuously because it is
    // a pass over every cell times every lamp, and because a floor that eased
    // from night to noon over twelve steps is a floor nobody can see stepping.
    const hour = Math.floor(t * 24);
    if (hour !== this.bakedHour) {
      this.bakedHour = hour;
      this.rebakeGround();
    }

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
          haul: null, haulKey: null, kit: null, kitKey: null,
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
      // Two spellings of one fact, and they are now the SAME shape. A player or
      // a hire has `carry` and a shopper has a `basket`; both are a list of
      // piles somebody is holding, so both go through one sync as a list of
      // lines rather than growing a second renderer that would drift from this
      // one. `carry` used to be one pile and was wrapped in an array here to
      // fit — mixed hands simply deleted the wrapper, which is the tell that
      // the list was the right shape all along.
      // ...and a kit is the CONTAINER those goods are in, so it replaces them
      // rather than being hung on top: a shopper walking out with a bag is not
      // also walking out with five jars in mid-air. Nobody has to author one —
      // no kit is the loose armful, which is what every shopper had before.
      this.syncCarry(rec, a.kit ? null : (a.carry?.stacks ?? a.basket ?? null));
      this.syncKit(rec, a.kit ?? null);
      // ...and the box, which is the third spelling and deliberately not part
      // of that one. A crate is not "some goods held in a different pose" — it
      // is the container itself, drawn from the same `buildPallet` that draws
      // it standing in the yard, so setting one down is visibly the same object
      // arriving on the floor. Routed through `carry`'s list it would have come
      // out as twelve loose tomatoes at chest height.
      this.syncHaul(rec, a.haul ?? null, this.crateCap);
      this.syncPastime(rec, a);
    }
    for (const [id, rec] of map) {
      if (!seen.has(id)) {
        this.actorRoot.remove(rec.obj);
        // The one sweep in this file that used to drop an actor without freeing
        // it. Mostly cheap — a body is shared `GEO` shapes — but not always:
        // whatever `syncHaul` hung on them is a `buildPallet`, and a pallet
        // carries a text label, which is a canvas and a texture nobody else
        // holds. A hire who logs out mid-trip leaked one every time.
        disposeGroup(rec.obj);
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
    // A skin is worn, not owned: it is looked up per HIRE rather than per kind,
    // which is the whole reason two stockers can be told apart. An id naming a
    // skin that has since been deleted resolves to nothing and draws the bot as
    // authored — the same shrug `variantModel` gives a missing variant.
    const skin = p.skin ? this.catalog.skins?.[p.skin] : null;
    return buildModel(kind.model, { t: tierProgress(p.tier ?? 1, kind.tiers?.length ?? 1), skin });
  }

  /** Money sitting on a counter waiting to be picked up. */
  syncCashDrops(drops) {
    const seen = new Set();
    for (const d of drops) {
      seen.add(d.id);
      if (this.cashProps.has(d.id)) continue;
      const obj = buildCashDrop();
      // Sit on top of the till rather than inside it.
      obj.position.set(d.x, CASH_Y, d.z);
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
    this.syncCashLabels(drops);
  }

  /**
   * One number per tile, not one per sale.
   *
   * A pile carried its own `+$4.20`, which is right for the first sale and
   * wrong for the fourth: the server fans successive drops across a third of a
   * tile so they read as several piles rather than one, and from this camera
   * that turns four labels into a column of arithmetic standing over a till —
   * four numbers where the only question anybody has is *how much is on that
   * counter*. So the piles stay several and the readout becomes one, which is
   * the call `buildPallet` already made about a stack of crates.
   *
   * Keyed by tile rather than by the drop that happens to be nearest it,
   * because the drops under one label come and go: a sale lands, somebody walks
   * over half the pile, and a label that belonged to one of them would vanish
   * with money still sitting there. Rewritten in place through `setTextSprite`
   * rather than rebuilt, since the number moves on every sale and a sprite
   * costs a canvas, a texture and a material each time.
   */
  syncCashLabels(drops) {
    const totals = new Map();
    for (const d of drops) {
      const x = Math.round(d.x);
      const z = Math.round(d.z);
      const key = `${x}:${z}`;
      const at = totals.get(key) ?? { x, z, total: 0 };
      at.total += d.amount ?? 0;
      totals.set(key, at);
    }

    for (const [key, at] of totals) {
      let sprite = this.cashLabels.get(key);
      if (!sprite) {
        sprite = buildMoneyLabel(at.total);
        // Over the middle of the tile, not over any one pile: the fan is a look
        // and the tile is the thing being totalled.
        sprite.position.set(at.x, CASH_Y + 0.5, at.z);
        this.actorRoot.add(sprite);
        this.cashLabels.set(key, sprite);
      }
      // Handed the total every sync whether or not it moved — `setTextSprite`
      // returns early when the string is the one already painted, which is what
      // makes calling it unconditionally the cheap thing to do.
      setTextSprite(sprite, moneySaid(at.total));
    }

    for (const [key, sprite] of this.cashLabels) {
      if (totals.has(key)) continue;
      this.actorRoot.remove(sprite);
      disposeGroup(sprite);
      this.cashLabels.delete(key);
    }
  }

  /**
   * Pallets at the bay, the drop-off and anywhere goods were tipped out.
   *
   * **Crates on one tile stack.** A pallet holds one kind, so a shelf of three
   * things strips into three crates at one spot and the pad hands out its cells
   * before it starts doubling up — which drew every one of them at floor level,
   * inside each other, reading as one flattened crate rather than as three. A
   * tile is the unit of storage everywhere else in the shop; this is that said
   * in the one place it was only ever a coordinate.
   *
   * Stacking is a *look*, not a rule: nothing here caps a tile, because how much
   * a pad holds is how big you painted it and that stays the server's business.
   * So the pile grows as high as the goods dropped on it, and the height is what
   * tells you the yard is backing up.
   *
   * Order is by id, oldest at the bottom, which is both what a stack does and
   * the only ordering that stays put — the snapshot's array order changes as
   * crates are taken and the tower must not shuffle underneath your pointer.
   */
  syncDeliveries(deliveries, cap = 6) {
    const seen = new Set();
    const stacks = new Map();
    for (const d of deliveries) {
      const tile = `${Math.round(d.x)},${Math.round(d.z)}`;
      if (!stacks.has(tile)) stacks.set(tile, []);
      stacks.get(tile).push(d);
    }
    const level = new Map();
    const height = new Map();
    for (const pile of stacks.values()) {
      pile.sort((a, b) => (Number(a.id.slice(4)) || 0) - (Number(b.id.slice(4)) || 0));
      pile.forEach((d, i) => { level.set(d.id, i); height.set(d.id, pile.length); });
    }

    for (const d of deliveries) {
      seen.add(d.id);
      const at = level.get(d.id) ?? 0;
      const covered = at < (height.get(d.id) ?? 1) - 1;
      // The level is part of the key: taking the top crate off has to redraw the
      // one under it, which is uncovered now and owes you a look at its goods.
      // `cap` is part of the key for the same reason `qty` is: buying a
      // rucksack moves what a crate holds, so every crate standing in the yard
      // is suddenly a different share of full and owes you a redraw.
      // Every pile is in the key, not just the first. A box whose second pile
      // changed while its first stayed put would otherwise keep the mesh it was
      // built with — so shelving the tomatoes out of a mixed crate would leave
      // the tomatoes drawn in it, which reads as stock that will not shift.
      const piles = (d.stacks ?? []).map((s) => ({
        ...s,
        model: this.catalog.items[s.item_id]?.model ?? null,
        name: this.catalog.items[s.item_id]?.name ?? '',
      }));
      const key = `${piles.map((s) => `${s.item_id}:${s.qty}`).join(',')}/${cap}:${at}:${covered ? 'c' : 'o'}`;
      const existing = this.deliveryProps.get(d.id);
      if (existing && existing.userData.key === key) continue;
      if (existing) {
        this.actorRoot.remove(existing);
        disposeGroup(existing);
      }
      const obj = buildPallet(piles, { covered, cap });
      obj.position.set(d.x, at * CRATE_STEP, d.z);
      // A hand's turn per crate, so a tower reads as boxes somebody put there
      // rather than as one extruded box, and each one's edges stay findable to
      // point at. Alternating rather than random: a prop rebuilt on every
      // quantity change would otherwise jump each time you took one off it.
      obj.rotation.y = (at % 2 ? 1 : -1) * (at ? 0.07 : 0);
      obj.userData.key = key;
      // The id alone, and by id rather than by tile — the opposite of
      // `pickFixture`, and for the opposite reason. A fixture's id is re-minted
      // on every re-flow so its tile is the honest name; a pallet's id lasts as
      // long as the pallet does, while its tile is shared with whatever lands
      // there next. Nothing else off `d` is kept, because this group outlives
      // the snapshot that built it — the qty on it would be last minute's.
      obj.userData.delivery = d.id;
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
   * Everything with wheels: the lorry on its delivery run, and the cars of
   * whoever drove here to shop.
   *
   * **One sync for both, because they are one thing** — a `vehicles` row
   * standing at a position, pointing somewhere. Every difference between them
   * is in the data rather than in the drawing: the van arrives as a single
   * field because there is one run at a time, the cars as a list because there
   * are as many as there are painted spaces, and the van carries a `load` where
   * a car does not. Neither this function nor `buildVehicle` can tell you which
   * one it is holding, and that is the test that the split is honest — the day
   * somebody authors a second `use`, it turns up here already drawn.
   *
   * Nothing about a van's *look* is decided here. The model comes off the row
   * the snapshot named, the stage comes off how full it is, and the fallback
   * for a row that has gone lives in `buildVehicle`. A renderer that knew what
   * a delivery van looks like would be the "a picture of a thing has to come
   * from the thing" mistake with a windscreen — and it would be the expensive
   * version of it, because the whole point of `vehicles` being content is that
   * a kid can draw a lorry.
   *
   * `phase` is deliberately not read. It says 'in' | 'unload' | 'out' so a
   * renderer could hold the thing still with its doors open rather than having
   * to notice it stopped moving — but the van already stops moving, and its
   * doors are three authored stages of `load`, which runs to zero over exactly
   * the pause `phase` describes. Two spellings of one fact is how the picture
   * and the state come apart; if something ever needs the phase it should need
   * it for a reason `load` cannot express.
   */
  syncVehicles(van, cars) {
    const seen = new Set();
    // The lorry first, under a key of its own — see `VAN_ID`. Concatenated
    // rather than looped over twice, because everything below is the same three
    // lines for either of them and a second copy is a second place to fix.
    const all = van ? [{ id: VAN_ID, ...van }] : [];
    for (const c of cars ?? []) all.push(c);

    for (const v of all) {
      seen.add(v.id);
      const model = this.catalog.vehicles?.[v.vehicle]?.model ?? null;
      // How loaded it is, which is the 0..1 a staged model wants. A car sends
      // no `load` at all and reads as full, which is the right answer for
      // anything unstaged and the honest one for a boot with the shopping in it.
      const t = Math.min(1, Math.max(0, v.load ?? 1));
      // Keyed on the STAGE rather than on the load. `load` runs down
      // continuously across the unload pause, so keying on it would rebuild a
      // group of meshes ten times a second for a picture that has not changed —
      // the same cache `syncStationWork` and the crops keep. The row id is in
      // there too so a van and a car never share a body by accident.
      const key = `${v.vehicle}:${model ? stageIndexAt(model, t) : 'none'}`;

      let rec = this.vehicleProps.get(v.id);

      if (!rec) {
        // The record is the DRAWN state — where the body has eased to and which
        // way it has come round to — kept apart from the group because the group
        // is thrown away and rebuilt every time the load crosses a stage.
        //
        // A new one starts exactly where the server says, never eased in from
        // wherever the last vehicle happened to be. A parked car does not
        // arrive: it is simply there, at a facing worked out once when its
        // driver claimed the space, so one that rolled into place and swung
        // round to face the door would be inventing a manoeuvre that never
        // happened. The van sets off eight tiles off the map (`lane.in[0]`), so
        // it is doing this out of sight either way.
        const yaw = vehicleYaw(v.facing);
        rec = { obj: null, key: null, x: v.x, z: v.z, yaw, tyaw: yaw };
        this.vehicleProps.set(v.id, rec);
      }

      if (rec.key !== key) {
        // Restaged, or drawn for the first time. **Rebuilt where it stands**,
        // not where the server says it is: a stage change is the load crossing
        // a threshold, which happens with the body still easing toward the
        // dock, and taking the target as the new position would be the lorry
        // jumping forward at the exact moment you are watching it unload.
        // `rec` carries the drawn state across the swap, which is most of why
        // it exists at all — the group is a thing this throws away.
        const at = rec.obj ? rec.obj.position.clone() : new THREE.Vector3(v.x, 0, v.z);
        if (rec.obj) {
          this.actorRoot.remove(rec.obj);
          disposeGroup(rec.obj);
        }
        rec.obj = buildVehicle(model, { t });
        rec.obj.position.copy(at);
        rec.obj.rotation.y = rec.yaw;
        this.actorRoot.add(rec.obj);
        rec.key = key;
      }

      // Where it is going, re-read every sync rather than only at creation.
      // Stashed as a target rather than applied, because the chase toward it
      // runs per frame — see `animateVehicles`.
      rec.x = v.x;
      rec.z = v.z;
      rec.tyaw = vehicleYaw(v.facing);
    }

    for (const [id, rec] of this.vehicleProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec.obj);
      disposeGroup(rec.obj);
      this.vehicleProps.delete(id);
    }
  }

  /**
   * Chase every vehicle toward where the server last put it.
   *
   * An exponential chase against `dt` rather than a fixed fraction per frame,
   * so a van crosses the yard at the same rate on a 144Hz screen as on a 30Hz
   * one — the fraction is whatever the frame length makes it. See
   * `VEHICLE_CHASE` for why this is per frame at all when people are not.
   *
   * The turn takes the short way round (`turnTo`), which is what stops a lorry
   * whose heading crosses π from unwinding the long way about — a full spin on
   * the spot at the one corner of the route, and only at that corner, which is
   * the kind of bug you see once and cannot reproduce because it depends on
   * which way the bay faces.
   */
  animateVehicles(dt) {
    if (!this.vehicleProps.size) return;
    const move = 1 - Math.exp(-dt * VEHICLE_CHASE);
    const turn = 1 - Math.exp(-dt * VEHICLE_TURN);
    for (const rec of this.vehicleProps.values()) {
      rec.obj.position.x += (rec.x - rec.obj.position.x) * move;
      rec.obj.position.z += (rec.z - rec.obj.position.z) * move;
      rec.yaw += turnTo(rec.yaw, rec.tyaw) * turn;
      rec.obj.rotation.y = rec.yaw;
    }
  }

  /**
   * Which recipe an appliance is set to.
   *
   * Off the snapshot, which is the server's own answer — this used to guess,
   * because there was nothing to read: a machine ran whichever recipe its hopper
   * happened to satisfy, so the bays showed the one it was CLOSEST to making and
   * flipped to the other as you loaded it. A row of ingredients that changes
   * while you are fetching them is a machine arguing with you.
   *
   * The fallback to the first recipe mirrors `Game.stationRecipe` for the one
   * tick a client can be ahead of the content it is drawing.
   */
  stationRecipe(st) {
    const mine = (this.catalog.recipes ?? []).filter((r) => r.station === st.station);
    return mine.find((r) => r.id === st.recipe) ?? mine[0] ?? null;
  }

  /**
   * What each appliance takes in and what it has put out, stood on the machine.
   *
   * A coffee machine with no milk looks exactly like one about to run, and the
   * only way to tell them apart was to enter build mode and read a text panel
   * that lists recipe *names* and not their ingredients. The first answer was a
   * row of sockets floating over the machine, and it was the wrong picture
   * twice: an ingredient and the thing being made were the same kind of icon in
   * the same place, and one icon meant one ingredient however many of it a
   * batch actually wanted. So the machine wears it instead, in the two places
   * that say which is which — in at the back, out at the front. See
   * `buildStationBays`.
   *
   * The three states are now three different pictures rather than one picture
   * and its absence. Idle: what it wants, ghosted where it is short. Running:
   * the ingredients are inside it, so the bays go and the *bar* comes up. Done:
   * the batch is standing on the outlet pad, which is a thing to walk over for
   * rather than a line in a panel nobody has open.
   */
  syncStations(stations) {
    const seen = new Set();

    for (const st of stations) {
      seen.add(st.id);
      const making = Boolean(st.making);
      const recipe = this.stationRecipe(st);
      // Nothing while it runs: what it was short of went in when the batch
      // started, so a bay drawn now is a red pad on a machine doing its job.
      const intakes = making ? [] : (recipe?.inputs ?? []).map((i) => ({
        model: this.catalog.items[i.item_id]?.model ?? null,
        need: i.qty,
        held: st.contents?.[i.item_id] ?? 0,
      }));
      const outlet = st.output
        ? { model: this.catalog.items[st.output.item_id]?.model ?? null, qty: st.output.qty }
        : null;

      // Rebuilt only when what it says changes, but repositioned every sync —
      // an appliance you move in build mode has to take its readout with it.
      const key = [
        recipe?.id ?? 'idle',
        intakes.map((s) => `${Math.min(s.held, s.need)}/${s.need}`).join(','),
        outlet ? `${st.output.item_id}x${outlet.qty}` : '',
      ].join('|');
      let rec = this.stationProps.get(st.id);
      // Kept and updated in place rather than replaced, because there are three
      // props on this record now and they change on different beats: the bays
      // when the hopper does, the working prop when the batch crosses a stage,
      // the bar ten times a second. Rebuilding the record for one drops the
      // other two.
      if (!rec) {
        rec = { key: null, group: null, work: null, workKey: null, bar: null, making: false };
        this.stationProps.set(st.id, rec);
      }

      if (rec.key !== key) {
        if (rec.group) {
          this.actorRoot.remove(rec.group);
          disposeGroup(rec.group);
        }
        rec.group = buildStationBays({
          intakes, outlet, bounds: this.stationBounds(st), wells: this.stationWells(st),
        });
        this.actorRoot.add(rec.group);
        rec.key = key;
      }

      // Stood on the machine and turned with it, out of the layout rather than
      // the snapshot — which appliance is which is state, but which way round it
      // stands is the shop. Models are authored facing east, the same convention
      // `addFixtureProps` uses, or the outlet ends up round the back.
      rec.group.position.set(st.x, this.fixtureBaseY({ kind: 'station' }), st.z);
      rec.group.rotation.y = -(this.stationRot(st)) * (Math.PI / 2);

      // How far through the batch is, over the machine — the one reading a
      // still frame can take that the moving parts cannot give you, since
      // "spinning" says it is on and says nothing about how long is left.
      if (making && !rec.bar) {
        rec.bar = buildGrowthBar();
        this.actorRoot.add(rec.bar);
      } else if (!making && rec.bar) {
        this.actorRoot.remove(rec.bar);
        disposeGroup(rec.bar);
        rec.bar = null;
      }
      if (rec.bar) {
        rec.bar.position.set(st.x, this.stationSlotY(st), st.z);
        setGrowthBar(rec.bar, st.progress ?? 0);
      }

      // Read every sync and *animated* every frame — the machine's own moving
      // parts are driven off this, at 60fps, from a flag that arrives at 10.
      rec.making = making;
      this.syncStationWork(st, rec);
    }

    for (const [id, rec] of this.stationProps) {
      if (seen.has(id)) continue;
      for (const g of [rec.group, rec.work, rec.bar]) {
        if (!g) continue;
        this.actorRoot.remove(g);
        disposeGroup(g);
      }
      this.stationProps.delete(id);
    }
  }

  /**
   * The placed record behind a station in the snapshot.
   *
   * Which appliance is which and what it is doing is state, and arrives every
   * tick. Which way round it stands and how far up its ladder it is belong to
   * the shop, and live in the layout — so anything about the machine rather
   * than about the batch comes from here.
   */
  placedStation(st) {
    return (this.storeLayout?.stations ?? []).find((s) => s.id === st.id) ?? null;
  }

  /** Which way round this appliance stands. Models are authored facing east. */
  stationRot(st) {
    return this.placedStation(st)?.rot ?? 0;
  }

  /**
   * What an appliance looks like while it is working, standing in its own model
   * space so a puff authored at the spout comes out of the spout.
   *
   * Only ever there while it is mid-batch. Rebuilt when the batch crosses a
   * stage and NOT before: `progress` moves every tick, and rebuilding a group of
   * meshes ten times a second would churn geometry for a picture that has not
   * changed — the same cache `syncCrops` keys off `stageIndexAt`.
   *
   * In `actorRoot` with the other readouts rather than parented to the machine,
   * for the reason the ingredient row is: the fixture belongs to `staticRoot`,
   * which a re-flow disposes wholesale, and build mode re-flows on every
   * placement. So it is positioned and turned every sync instead, which is also
   * what lets you pick a running machine up and carry it.
   */
  syncStationWork(st, rec) {
    const model = st.making ? this.stationWorkModel(st) : null;
    const t = model ? Math.min(1, Math.max(0, st.progress ?? 0)) : 0;
    const key = model ? `${st.station}:${stageIndexAt(model, t)}` : '';

    if (key !== rec.workKey) {
      if (rec.work) {
        this.actorRoot.remove(rec.work);
        disposeGroup(rec.work);
        rec.work = null;
      }
      if (model) {
        rec.work = buildLoopingProp(partsAt(model, t), { castShadow: true });
        this.actorRoot.add(rec.work);
      }
      rec.workKey = key;
    }

    if (!rec.work) return;
    rec.work.position.set(st.x, this.fixtureBaseY({ kind: 'station' }), st.z);
    // Turned to face the way the machine faces — see `stationRot`, or the steam
    // comes out of the back.
    rec.work.rotation.y = -(this.stationRot(st)) * (Math.PI / 2);
  }

  /** The authored working look of this appliance, or null if nobody drew one. */
  stationWorkModel(st) {
    return variantWork(this.pieceOf({ kind: 'station' }), st?.station);
  }

  /**
   * Just clear of *this* appliance, so the bar never sits inside one — measured
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

  /**
   * The box *this* appliance occupies, for standing its bays on top of.
   *
   * At the tier it is actually built to, which is why it can't come off the
   * snapshot: `stations` carries what a machine is doing, and how far up its
   * ladder it is belongs to the shop. A Commercial machine is a taller box than
   * a Domestic one, and bays measured off the wrong one sink into the lid.
   */
  stationBounds(st) {
    return modelBounds(partsAt(this.fixtureModel(this.stationSpec(st)), this.fixtureT(this.stationSpec(st))));
  }

  /** This appliance, as the catalog knows it — which shape, and which rung. */
  stationSpec(st) {
    return { kind: 'station', station: st?.station, tier: this.placedStation(st)?.tier };
  }

  /**
   * The wells built into this appliance's art: every part it flagged `surface`.
   *
   * The same flag a shelf uses for a board, which is the point — "goods stand
   * here" is one idea and it should not grow a second spelling because the thing
   * underneath is a machine. An appliance that authors two of them has said
   * where its hopper is and where its tray is; one that authors none gets its
   * readout stood on its roof, the same fallback a boardless unit takes.
   */
  stationWells(st) {
    const spec = this.stationSpec(st);
    return surfacesAt(this.fixtureModel(spec), this.fixtureT(spec));
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
    if (!this._ray) {
      this._ray = new THREE.Raycaster();
      // A raycaster ships enabled on layer 0 only, and the ground now sits on
      // `BAKED_LAYER` so the lamps cannot reach it twice. Pointing is not
      // lighting: everything drawn is something you can aim at.
      this._ray.layers.enableAll();
    }
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
    return this.pickFixtureHit(clientX, clientY)?.f ?? null;
  }

  /**
   * The same answer with how far away it was, for `pickAim` to weigh a fixture
   * against a crate. Every other caller wants the record and nothing else,
   * which is why `pickFixture` stays the plain one.
   *
   * `keep` is a caller's veto on which fixtures may answer — a decoration
   * outside build mode, today. It is applied *inside* the walk rather than to
   * the answer, and that is the whole reason it lives here: a hanging lamp is
   * the first thing the ray meets over the tile it hangs on, so vetoing the
   * result would make the shelf underneath it unpointable instead of making the
   * lamp transparent. Skipping the hit carries on down the ray, which is what
   * "you can see straight through it" has to mean.
   *
   * `board` comes back beside the fixture, and it is the *finer* half of the
   * same answer: which pile of goods on that unit the ray actually met. It is
   * there because a shelf holding three things is three piles at one address,
   * and until the pointer could say which, the only thing that could was the
   * unit's own menu. Null for every hit that is not stock — the frame of the
   * shelf itself, a crop, a machine — which is what leaves "the whole unit"
   * still pointable: aim at the thing, get the thing.
   */
  pickFixtureHit(clientX, clientY, keep = null) {
    if (!this.storeLayout) return null;
    const hits = this.pointerRay(clientX, clientY).intersectObjects(this.pickTargets(), true);
    // The first thing the ray met, held back rather than answered with, so a
    // pile of goods further down the same ray gets a chance at the question.
    // See the two branches below for when it wins and when this is given back.
    let front = null;
    for (const hit of hits) {
      // Up to whichever group was tagged as one pickable thing — the hit
      // itself is one board of a shelf or one apple on it.
      let o = hit.object;
      let board = null;
      while (o && !o.userData.pick) {
        // ...noting which pile it was on the way past, since the group that
        // says so sits between the mesh and the group that says "one thing".
        if (o.userData.item) board = o.userData.item;
        o = o.parent;
      }
      if (!o) continue;
      // The thing the ray HIT, whenever the group can say which it is — and it
      // has to be asked before the tile, because a tile stopped being one
      // fixture the day a decoration stopped stamping one. Point at a lamp
      // hanging over a shelf and the tile answers "shelf", which is how the
      // pointer ends up naming the thing *underneath* whatever you aimed at.
      //
      // The tile is still the fallback, and it is the right one: the groups
      // with no id on them are a shelf's stock and a bed's crop, which belong
      // to the fixture they stand on, and that fixture is the one thing a tile
      // does still answer for.
      const f = (o.userData.fixture ? this.fixtureById(o.userData.fixture) : null)
        ?? this.fixtureAt(Math.round(o.position.x), Math.round(o.position.z));
      if (!f || (keep && !keep(f))) continue;
      const answer = { f, dist: hit.distance, board };
      // Nothing in front of it: the plain old answer, and the one every stocked
      // shelf in the game still gets. Only a pile that is BEHIND something has
      // anything to decide, so the first hit is held and the ray carries on.
      if (!front) {
        front = { ...answer, transparent: !!hit.object.material?.transparent };
        continue;
      }
      // A pile the unit's own art is standing in front of.
      //
      // The unit is still what you are pointing at everywhere its stock is not —
      // a tap on the frame, the base or an end panel has to go on opening the
      // menu, or pricing and assignment stop being one press away. So reaching
      // through is not a general rule about fixtures; it is these two cases, and
      // both are "the pile is *there* and you cannot get at it":
      //
      // - **glass**, which is drawn so you can see through it (`material`,
      //   `depthWrite: false`) and would otherwise be the one part of a unit
      //   that shows you goods and refuses to name them.
      // - **a pile sealed in** (`sealedPile`) — a wall unit is a box with a lid,
      //   and on a fixed camera two of its four rotations put the back of that
      //   box to you. What the shelves get away with is having no top: you look
      //   down over the back panel onto the boards, which is why a shelf turned
      //   away still answers and a freezer turned away answers with nothing at
      //   all, at every pixel, for ever. The stock is *rendered*, it is simply
      //   somewhere no ray of this camera reaches.
      //
      // Asked of the pile rather than of the piece, because it is a fact about
      // where the unit is standing rather than about how it was drawn — the same
      // freezer answers differently at rot 1 and rot 3, and a rule written
      // against the model could only ever be wrong at two of them.
      //
      // The marker can say so, which is what makes this honest rather than a
      // pointer that names what you cannot see: `buildCageMarker` draws with
      // `depthTest: false`, so the cage round a pile inside a sealed box is
      // drawn *over* the box. You point at the freezer and see which pile you
      // would take.
      // `!front.board` because a pile in the open is already the answer: without
      // it, a unit holding one visible kind and one sealed one would hand you
      // the sealed one for every pixel of the pile you can actually see.
      // By id, never by identity: `allFixtures` rebuilds its records on every
      // call (`fixturesIn` spreads them), so the same fixture met twice down one
      // ray is two objects and `===` is false for every unit in the shop. It
      // fails silently as "the reach-through never fires", which is exactly the
      // bug it was written to fix.
      if (board && !front.board && front.f.id === f.id
        && (front.transparent || this.sealedPile(f, board))) {
        // At the FRONT's distance. That is where this fixture really starts, and
        // `pickAim` weighs the number against a crate standing in front of it.
        return { ...answer, dist: front.dist };
      }
      // Anything else — a different fixture, a second panel of this one — means
      // the ray has finished with whatever was in front, and that is the answer.
      if (front.f.id !== f.id) return front;
    }
    const got = front ?? this.pickPropBox(clientX, clientY, keep);
    // Near enough a pile IS on it.
    //
    // Everything above answers off the art, which is right and is also why
    // aiming at goods was fiddly: a board's worth of stock is a handful of
    // little boxes a dozen pixels tall, and between them and around them is
    // the unit's own shelf, which the ray hits instead. So you had to be
    // exactly on a loaf, and being one pixel off did not miss — it silently
    // answered "the whole unit", which is a different job.
    //
    // A radius rather than a bigger hit volume, because the thing that needs
    // to keep working is the OTHER answer: a tap on the frame, the base or an
    // end panel is still the unit and still opens its menu (see `boardTakes`).
    // Padding the piles out until they touch would eat the gaps between them
    // and there would be nowhere left on a full shelf to press for the menu.
    // Measured in pixels for the same reason: what is hard here is a distance
    // on the screen, and a distance in the world is a different number at
    // every zoom.
    if (got?.f && !got.board) {
      const near = this.nearestBoard(got.f, clientX, clientY);
      if (near) return { ...got, board: near };
    }
    return got;
  }

  /**
   * Which pile on this unit the pointer is nearest, if it is near one at all.
   *
   * Distance to the pile's projected BOX rather than to its middle: a board of
   * twelve loaves is wide and a board of one is a dot, and measuring to centres
   * would make the wide one harder to hit the more of it there is — which is
   * exactly backwards.
   *
   * Boxes measured off the meshes, the same way `boardBox` measures the cage
   * that gets drawn round the answer. One function would be nicer and they want
   * different things: that one wants a world box to build a cage from, and this
   * wants every pile's screen rect at once.
   */
  nearestBoard(f, clientX, clientY, within = BOARD_SNAP_PX) {
    const rec = this.shelfProps.get(f.id);
    if (!rec?.group?.children?.length) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    rec.group.updateMatrixWorld(true);
    let best = null;
    let bestAt = within;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const pile of rec.group.children) {
      if (!pile.userData.item) continue;
      box.setFromObject(pile);
      if (box.isEmpty()) continue;
      // The eight corners, projected. A box in the world is not a box on the
      // screen at this camera — it is a hexagon — so its screen rect is the
      // bounds of the corners rather than of two of them.
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(this.camera);
        const sx = (v.x + 1) / 2 * rect.width;
        const sy = (1 - v.y) / 2 * rect.height;
        if (sx < x0) x0 = sx;
        if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy;
        if (sy > y1) y1 = sy;
      }
      const dx = Math.max(x0 - px, 0, px - x1);
      const dy = Math.max(y0 - py, 0, py - y1);
      const d = Math.hypot(dx, dy);
      if (d < bestAt) { bestAt = d; best = pile.userData.item; }
    }
    return best;
  }

  /**
   * Is this pile of goods walled in by the unit it is standing in?
   *
   * Rays from all over the pile, back along the way the camera looks. If the
   * unit's own art stops every one of them, nothing the pointer can do reaches
   * that pile the ordinary way, and `pickFixtureHit` may reach through the body.
   *
   * All over it rather than from the middle, and that is the whole difference
   * between this and a rule that quietly eats the fixture menu. A shelf's back
   * panel stands right behind its stock, so the centre of a pile on a
   * turned-away shelf is blocked exactly as a freezer's is — measured from the
   * middle alone, half the shelving in the shop read as sealed and a press on
   * the frame started handing back a board. What a shelf has and a freezer has
   * not is a way OUT: no lid, so the top of the pile clears the panel. One
   * escaping sample is enough, which is the same "best of several points" call
   * `shownOn` makes, and for the same reason.
   *
   * Measured off the meshes and off the camera rather than authored on the
   * piece, for the reason the caller gives: sealed-ness is about which way the
   * thing is turned. It also means a model nobody has drawn yet gets the right
   * answer on the day it is drawn — the same bet `boardBox` and `pickFixtureHit`
   * already make by raycasting the art instead of reasoning about it.
   *
   * Glass does not seal, exactly as it does not cover in `shownOn`. If it did,
   * every glazed unit would take the reach-through path and the pane branch
   * above would be dead code that looked alive.
   *
   * Cached per pile, because a hover asks this on every pointer move and the
   * answer only changes when the unit moves, turns or is restocked — which is
   * what `rec.key` and the placement already spell out between them.
   */
  sealedPile(f, itemId) {
    const rec = this.shelfProps.get(f.id);
    if (!rec) return false;
    const memo = (rec.sealed ??= new Map());
    const key = `${itemId}:${rec.key}:${f.rot ?? 0}:${f.x}:${f.z}`;
    if (memo.has(key)) return memo.get(key);
    if (memo.size > 16) memo.clear();

    let out = false;
    const box = this.boardBox(f, itemId);
    const body = this.staticRoot.children.find((o) => o.userData.fixture === f.id);
    if (box && body) {
      // Towards the viewer, which for this camera is one fixed direction — the
      // scene is orthographic, so every point of the pile looks the same way and
      // the samples differ only in where they start.
      const back = this.camera.getWorldDirection(SEAL_DIR).negate();
      // Pulled in off the faces, or a sample sitting exactly on the top of the
      // pile answers about the air beside it rather than about the goods.
      const lo = box.min, hi = box.max;
      const at = (t) => SEAL_FROM.set(
        lo.x + (hi.x - lo.x) * t[0],
        lo.y + (hi.y - lo.y) * t[1],
        lo.z + (hi.z - lo.z) * t[2],
      );
      // The unit's own art first, because it is one small group and it is what
      // stops nearly every sample. Only a sample that gets OUT costs the wider
      // question — which is the expensive one, and the one that has to be asked:
      // a run of freezers stands shoulder to shoulder, so the sample that clears
      // your own lid is the sample that walks straight into the unit next door.
      // Own-body-only left two units in a row of ten unreachable, on one escaping
      // corner each, which reads as the fix having half worked.
      const others = this.pickTargets().filter((g) => g !== rec.group);
      out = SEAL_SAMPLES.every((t) => {
        SEAL_RAY.set(at(t), back);
        const stopped = (hits) => hits.some((h) => !h.object.material?.transparent);
        return stopped(SEAL_RAY.intersectObject(body, true))
          || stopped(SEAL_RAY.intersectObjects(others, true));
      });
    }
    memo.set(key, out);
    return out;
  }

  /**
   * ...and a decoration answers to the box its art is drawn in, not to the art.
   *
   * Raycasting the meshes is the right answer for everything that is *shaped*
   * like a target. A string of lights is a wire: a couple of pixels of black
   * across the shop, and hitting it is hunting for a magic spot — which is the
   * bug the plane-picking version had, arriving from the other end. Miss by two
   * pixels and nothing is under the pointer, so the tap falls through to the
   * ground and BUYS ANOTHER ONE, which is a near-miss with a price on it.
   *
   * So a prop's target is its own bounds. Bigger than the wire, exactly as big
   * as what is drawn, and it can never steal from anything else: this runs only
   * after every mesh in the shop has already failed to answer, so an exact hit
   * on a shelf standing in the same airspace still wins.
   *
   * What it costs is that the ground *behind* a hanging prop takes a tap where
   * the box covers it on screen — the same tile the lamp is drawn over. That is
   * the same trade the art-exact version made and lost: those pixels are the
   * lamp, and there is no third answer for a pixel that is both.
   */
  pickPropBox(clientX, clientY, keep = null) {
    if (!this.propBoxes.size) return null;
    const ray = this.pointerRay(clientX, clientY).ray;
    let best = null;
    for (const [id, box] of this.propBoxes) {
      if (!ray.intersectBox(box, BOX_HIT)) continue;
      const dist = ray.origin.distanceTo(BOX_HIT);
      if (best && dist >= best.dist) continue;
      const f = this.fixtureById(id);
      if (f && (!keep || keep(f))) best = { f, dist };
    }
    return best;
  }

  /**
   * Which crate the pointer is over, if any.
   *
   * Its own method rather than a branch in `pickFixture`, because a pallet is
   * not a fixture and every caller of that one would have to learn it: the
   * build ghost, the bulldozer and "walk to the side you work it from" all
   * take a layout record, and none of them has an answer for a crate.
   *
   * It answers *which* crate of a stack, and that answer is the whole of how a
   * pile is worked now: a crate is `CRATE_STEP` tall, so at the default zoom a
   * buried one is a band of about a dozen pixels, and `y` is what lets the ring
   * say which of them the ray met. A pile once had a list on the tap to name its
   * crates for you; the aim plus the ring says it without reading anything out,
   * and what a pile takes away is not which box you may have but the tin-at-a-
   * time access — see `crateStacked`, server side.
   *
   * `dist` comes back for the same reason: a crate and a fixture are two
   * separate rays, so which of them wins can no longer be decided by which
   * method is called first. See `pickAim`.
   */
  pickPallet(clientX, clientY) {
    const crates = [...this.deliveryProps.values()];
    if (!crates.length) return null;
    const hits = this.pointerRay(clientX, clientY).intersectObjects(crates, true);
    for (const hit of hits) {
      // Labels are not the thing they name. A sprite ignores depth and is drawn
      // over whatever is in front of it, so letting one answer would hand you a
      // buried crate when you pointed at the one standing on it. The ray carries
      // on to the box behind the number, which is that crate anyway.
      if (hit.object.isSprite) continue;
      let o = hit.object;
      while (o && !o.userData.delivery) o = o.parent;
      if (o) {
        return {
          id: o.userData.delivery,
          x: Math.round(o.position.x),
          z: Math.round(o.position.z),
          y: o.position.y,
          dist: hit.distance,
        };
      }
    }
    return null;
  }

  /**
   * What the pointer is over on the shop floor — a crate or a fixture.
   *
   * Whichever is genuinely in FRONT, by ray distance, rather than whichever
   * picker is called first. Order was fine while the two could not overlap, and
   * a hanging lamp is exactly the case where they do: its art is drawn down from
   * the ceiling, most of a tile up-screen of the tile it belongs to, which is
   * the same patch of screen a crate stacked on that tile occupies. Ordered, one
   * of them silently owned the pointer for pixels the other was drawn on — so
   * the ring named the lamp while the tap took the crate, and a shop floor where
   * the highlight and the click disagree is worse than one with no highlight.
   *
   * At most one comes back set. Only the fixture goes to `ui.setAim`, because
   * that names what a BUILD verb would act on and there is no build verb that
   * takes a crate.
   */
  pickAim(clientX, clientY, keep = null) {
    const crate = this.pickPallet(clientX, clientY);
    const hit = this.pickFixtureHit(clientX, clientY, keep);
    if (crate && (!hit || crate.dist <= hit.dist)) return { crate, fixture: null, board: null };
    // The board rides along with the fixture and never on its own: it is the
    // same target said more precisely, so anything that only knows about units
    // can go on reading `fixture` and ignore it.
    return { crate: null, fixture: hit?.f ?? null, board: hit?.board ?? null };
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
   * This used to be the whole answer to "which shelf did you mean", on the
   * grounds that a tile holds one fixture and the pointer names a tile. That
   * was true until a decoration stopped stamping a tile: a lamp shares the
   * cell it hangs over, so `props` come last in `fixturesIn` and `find` can
   * never reach one that is sharing. Still the right answer for a *tile* —
   * placing, walking, the ghost — and no longer the right answer for "what am
   * I pointing at", which is `pickFixtureHit`'s job and goes by id.
   */
  fixtureAt(x, z) {
    return this.allFixtures().find((f) => f.x === x && f.z === z) ?? null;
  }

  /** ...and by id, for a pointer that has already hit the thing itself. */
  fixtureById(id) {
    return this.allFixtures().find((f) => f.id === id) ?? null;
  }

  /**
   * Ring the fixture the pointer is over in build mode.
   *
   * Kept separate from `syncActionTarget`'s marker on purpose: that one is
   * driven by the server's armed action and gets torn down every snapshot,
   * which would take this with it ten times a second.
   */
  setAimTarget(f, mode = 'aim', board = null) {
    // The mode is part of the key: pointing at the same shelf with the bulldozer
    // up is a different marker, and comparing ids alone would leave an amber
    // ring on the thing the next tap deletes.
    //
    // So is the height, which is a crate's doing. A ring on the ground under a
    // tower says "one of these three" — the whole reason to ring a crate is to
    // say WHICH — and moving the pointer up the stack changes nothing else
    // about the target but where it is.
    //
    // ...and so is the board, plus the shelf's own art key. A cage is drawn to
    // the size of the pile it is round, so a sale that redraws that pile has to
    // redraw the cage with it — keyed on the item alone, the box would stay the
    // size the stack was when you first pointed at it, which is a highlight
    // that stops agreeing with what you can see while you watch it.
    const art = board ? this.shelfProps.get(f?.id)?.key ?? '' : '';
    const key = f ? `${f.id}:${mode}:${f.y ?? 0}:${board ?? ''}:${art}` : null;
    if (this.aimKey === key) return;
    this.aimKey = key;
    if (this.aimMarker) {
      this.actorRoot.remove(this.aimMarker);
      disposeGroup(this.aimMarker);
      this.aimMarker = null;
    }
    if (!f) return;
    this.aimMarker = this.markerFor(f, mode, board);
    this.actorRoot.add(this.aimMarker);
  }

  /**
   * A frame on the tile, or a cage round the thing.
   *
   * Which one is not a style choice, it is what the fixture *is*: everything
   * that owns a cell is marked as a cell, because that is what you point at one
   * for — you walk to the side of a shelf, and the frame is where you would be
   * standing. A decoration owns no cell, so a frame under one marks the floor
   * beside it and leaves the thing itself unchanged. Worse for a hanging prop,
   * which is drawn most of a tile up-screen of its own cell: the marker appears
   * somewhere you are demonstrably not pointing.
   *
   * Sized from `propBoxes`, which is the same volume the pointer is tested
   * against — so the highlight is a picture of the hitbox rather than a second
   * guess at it, and "it lit up but the tap missed" cannot happen.
   *
   * A board takes the cage for a third reason, and it is the one that makes
   * board-level aiming legible at all: a frame on the tile would be the same
   * frame for every pile on the unit, so pointing at the bread and pointing at
   * the milk beside it would look identical. The thing you have to be able to
   * tell apart is *which pile*, so the marker has to be round the pile.
   */
  markerFor(f, mode, board = null) {
    const box = board
      ? this.boardBox(f, board)
      : (isProp(f.kind) ? this.propBoxes.get(f.id) : null);
    if (!box) {
      const m = buildTargetMarker(mode);
      m.position.set(f.x, f.y ?? 0, f.z);
      return m;
    }
    const size = box.getSize(new THREE.Vector3());
    // `board` rather than the mode it was asked with, and the only difference is
    // the chevron: a board is one of several on the same unit, and an arrow
    // floating a tile and a half over the shelf points at the shelf — which is
    // the one thing this marker exists NOT to say. The cage is the whole answer.
    const m = buildCageMarker(board ? 'board' : mode, size);
    box.getCenter(m.position);
    return m;
  }

  /**
   * The box one pile of goods on a unit occupies, in world space.
   *
   * Measured off the meshes rather than worked out from the boards, for the same
   * reason `pickFixtureHit` raycasts the art: the pile is what you can see and
   * what the ray hit, and a second calculation of where it sits is a second
   * chance to disagree with the picture — which here would present as a
   * highlight that is next to the thing it is highlighting.
   *
   * On demand rather than cached beside the group, because the answer depends on
   * where the shelf is standing *now*: `syncShelves` re-reads that every sync so
   * a unit you pick up takes its stock with it, and a box stamped when the
   * geometry was built would be left behind at the old tile. Only ever asked
   * when the marker is (re)built, which is a pointer moving onto a new pile.
   */
  boardBox(f, itemId) {
    const rec = this.shelfProps.get(f.id);
    if (!rec) return null;
    const pile = rec.group.children.find((c) => c.userData.item === itemId);
    if (!pile) return null;
    rec.group.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(pile);
  }

  /**
   * Ring the PERSON the pointer is over.
   *
   * Its own marker rather than a mode on `setAimTarget`, for one reason that
   * decides the whole shape: everything that one rings stands still. A shelf is
   * placed at a tile and the marker is placed at the same tile once. A hire
   * walks, so this holds an id and is re-positioned every frame off the mesh's
   * own interpolated position — the marker would otherwise sit where they were
   * standing when you hovered them, which is worse than no marker, because it
   * says the tap will land somewhere it will not.
   *
   * Takes a roster id rather than a body for the reason `watch` does: bodies
   * are re-sent whole ten times a second.
   */
  setPersonAim(hire) {
    const id = hire ?? null;
    if (this.personAimId === id) return;
    this.personAimId = id;
    if (this.personMarker) {
      this.actorRoot.remove(this.personMarker);
      disposeGroup(this.personMarker);
      this.personMarker = null;
    }
    if (!id) return;
    this.personMarker = buildTargetMarker('person');
    this.actorRoot.add(this.personMarker);
  }

  /** The body of a hire, by roster id — what the marker above rides on. */
  bodyOfHire(hire) {
    const p = (this.playerState ?? []).find((x) => x.hire === hire);
    return p ? this.players.get(p.id) ?? null : null;
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
  setSelectedTarget(f, spots = null) {
    // Handed in rather than worked out here, because *how many* sides a unit has
    // depends on its catalog row (`open`) and on the shop around it (an end
    // inside a wall is not an end) — and the renderer holds neither question.
    // `UI.spotsFor` is the one answer, so what lights up and what the sim will
    // accept you at cannot drift apart. Null is the old behaviour: the anchor,
    // and a till's other side.
    const at = spots ?? spotsOf(f);
    // `rot` is in the key, and it has to be: the menu is where the Rotate
    // button lives, so the one thing you do to a selected fixture is the one
    // thing that moves no tile. Keyed on position alone, turning a till redrew
    // nothing and its working spots stayed pointing the old way — a preview
    // that lies specifically while you are watching it.
    //
    // ...and so are the spots, for the same reason one step further out: a wall
    // drawn beside a shelf takes an end away without moving the shelf, and a key
    // blind to that would leave a marker on a tile nobody can stand in.
    const key = f ? `${f.x},${f.z},${f.rot ?? 0}|${at.map((s) => `${s.x},${s.z}`).join(';')}` : null;
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    if (this.selectedMarker) {
      this.actorRoot.remove(this.selectedMarker);
      disposeGroup(this.selectedMarker);
      this.selectedMarker = null;
    }
    if (!f) return;
    this.selectedMarker = this.markerFor(f, 'selected');
    // A cage is positioned on the art and not on the tile, so the working spots
    // below — which are offsets from the tile — would hang off the wrong origin.
    // Props have none, which is why this reads as a guard rather than a branch:
    // the two facts are the same fact, and the day a decoration reserves a spot
    // is the day it stops being a decoration.
    if (isProp(f.kind)) { this.actorRoot.add(this.selectedMarker); return; }
    // Where the people who use it stand, marked the same way the build ghost
    // marks them — the ghost is the only place they were ever shown, so the
    // moment a fixture was actually standing there they became invisible. For a
    // till that means the difference between the two sides was something you
    // could see while placing it and never again, including while rotating it.
    //
    // Read off the record rather than recomputed from `rot`: `serveAt` is what
    // the shop was actually laid with, and a facing the generator refused would
    // otherwise be drawn as though it had been honoured.
    for (const s of at) {
      this.selectedMarker.add(buildWorkSpot(
        s.role, { x: s.x - f.x, z: s.z - f.z }, this.selectedMarker.userData.color,
      ));
    }
    this.actorRoot.add(this.selectedMarker);
  }

  /**
   * Show (or clear) the build preview.
   *
   * Validity comes from `shared/build.js` — the same function the server runs
   * when the click lands. Reimplementing the rules here to keep the ghost snappy
   * is exactly how a ghost starts lying to you.
   *
   * @param {?object} spec { kind, x, z, rot, moveId, piece, variant, station, tier }
   *        The last four are what it will be DRAWN as. They take no part in
   *        `canPlace` — where a thing may go is a fact about its kind — but a
   *        preview that ignores them is a preview of a different object.
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
    // Which piece is armed is in the key too, or arming a second shelf design
    // would leave the first one's ghost under your pointer until you moved to
    // another tile — the exact bug this whole change exists to remove.
    const drawnAs = `${spec.piece ?? ''}/${spec.variant ?? ''}/${spec.station ?? ''}/${spec.tier ?? 1}`;
    const key = `${spec.kind}:${spec.x}:${spec.z}:${spec.rot}:${state}:${drawnAs}`;
    if (this.buildGhostKey === key) return verdict;
    this.buildGhostKey = key;
    this.clearBuildGhost(true);

    const def = FIXTURES[spec.kind];
    if (!def) return verdict;
    // Every side somebody has to stand on, not just the one rotation points at.
    // Asked in fixture-local coordinates (0,0) because the ghost group is what
    // gets positioned — see below.
    const spots = workSpots(spec.kind, 0, 0, spec.rot ?? 0)
      .map((s) => ({ dx: s.x, dz: s.z, role: s.role }));
    // The actual model of the actual piece, resolved exactly the way the
    // standing fixture is (`fixtureModel`) — one resolver, so the ghost and the
    // thing it becomes cannot disagree about which shelf you picked.
    const model = this.fixtureModel(spec);
    const piece = this.pieceOf(spec);
    // A prop has no tile, so there is no tile style to size its ghost from. It
    // gets a low pad instead — enough to read as "a thing lands here" without
    // pretending to be the shape of whatever piece you picked.
    const look = FIXTURE_LOOK[spec.kind] ?? { h: 0.5, color: TILE_STYLE[T.FLOOR]?.color };
    const t = tierProgress(spec.tier ?? 1, piece?.tiers?.length ?? 1);
    const g = buildFixtureGhost({
      model,
      t,
      rot: rot4(spec.rot ?? 0),
      // The cage is sized to the model when there is one, so a low counter is
      // not caged like a full-height freezer. A plot's look is flat, and a ghost
      // you cannot see is not a preview — hence the floor either way.
      height: Math.max(model ? modelHeight(partsAt(model, t)) : look.h, 0.12),
      verdict: state,
      spots,
    });
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

    // `aim` is not a verdict at all — it is the aim frame's own amber, said about
    // a line instead of a tile, for the one thing you can point at that has no
    // tile of its own: a way through. Everything openable in this game lights up
    // under the pointer, and a doorway was the exception, which reads as the menu
    // not existing rather than as the highlight missing.
    const colour = state === 'aim' ? '#ffd66b'
      : state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
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
   *
   * `RING_Y` is measured off the character rather than off the thought bubble,
   * which is what it used to clear. A head tops out at 0.96 (`buildCharacter`),
   * so 1.2 leaves the ring floating just above it. At 0.60 radius the old one
   * could sit at 2.05 — twice a person's height up — and still read as attached
   * because it was wide enough to enclose them; shrunk to a badge, the same
   * height reads as a speck in the air with nothing under it. Anything small
   * has to be placed against the head, not against the space above it.
   *
   * It draws over the bubble rather than clearing it, which the ring's
   * `depthTest: false` and renderOrder 9/10 already guarantee against the
   * bubble's 1.
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
      rec.position.set(p.x, RING_Y, p.z);
      setRingProgress(rec, p.action.progress ?? 0);
    }
    for (const [id, rec] of this.actionRings) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec);
      disposeGroup(rec);
      this.actionRings.delete(id);
    }
  }

  /**
   * Bob the piles and spin their coins so money reads as money.
   *
   * The labels are deliberately left out of it. They used to be children of a
   * pile and bobbed with it, which is one moving thing per sale in a corner of
   * the screen you are trying to read a number in — the pile is what says
   * "notice me", and a total that holds still is what says how much.
   */
  animateCash(now) {
    for (const obj of this.cashProps.values()) {
      const age = (now - (obj.userData.born ?? now)) / 1000;
      obj.position.y = CASH_Y + Math.sin(age * 3) * 0.045;
      if (obj.userData.spin) obj.userData.spin.rotation.y = age * 2.2;
    }
  }

  /** Thought bubble showing the item someone wants or is carrying. */
  syncBubble(rec, itemId) {
    if (rec.bubbleKey === itemId) return;
    rec.bubbleKey = itemId;
    if (rec.bubble) {
      rec.obj.remove(rec.bubble);
      disposeGroup(rec.bubble);
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
   *
   * A list of `{item_id, qty}` rather than one line, because a shopper's basket
   * is a mix and drawing only the first thing they took would make everything
   * after it invisible. The units are dealt out ROUND-ROBIN across the kinds,
   * not kind by kind: four tomatoes and a cheese would otherwise spend the
   * whole pile on tomatoes, and "they picked up a cheese" is exactly the fact
   * this is here to show. Past `CARRY_SHOWN` the count does the talking.
   */
  syncCarry(rec, lines) {
    const key = lines?.length
      ? lines.map((l) => `${l.item_id}:${l.qty}`).join('|')
      : null;
    if (rec.carryKey === key) return;
    rec.carryKey = key;

    if (rec.carry) {
      rec.obj.remove(rec.carry);
      disposeGroup(rec.carry);
      rec.carry = null;
    }
    if (!key) return;

    // Deal one of each kind, then go round again, until the pile is full or
    // there is nothing left to deal.
    const left = lines.map((l) => l.qty);
    const pile = [];
    for (let round = 0; pile.length < CARRY_SHOWN; round++) {
      let dealt = false;
      for (let i = 0; i < lines.length && pile.length < CARRY_SHOWN; i++) {
        if (left[i] <= 0) continue;
        left[i]--;
        pile.push(lines[i].item_id);
        dealt = true;
      }
      if (!dealt) break;
    }

    const held = new THREE.Group();
    let n = 0;
    for (const itemId of pile) {
      const item = this.catalog.items[itemId];
      if (!item) continue;
      const one = buildModel(item.model, { castShadow: false });
      one.scale.setScalar(0.5);
      one.position.set(((n % 2) - 0.5) * 0.16, n * 0.15, ((n % 2) - 0.5) * 0.1);
      held.add(one);
      n++;
    }
    // Nothing in the catalog answered to any of it — better to draw nothing
    // than an empty group floating at chest height.
    if (!n) return;

    const total = lines.reduce((s, l) => s + l.qty, 0);
    if (total > 1) {
      const label = buildTextSprite(`x${total}`, { fill: '#fff3cf', scale: 0.62 });
      label.position.set(0.3, 0.28 + n * 0.15, 0);
      held.add(label);
    }
    // Welded, like stock and crops: an armful is up to `CARRY_SHOWN` little
    // models nailed to one another, and everybody in the shop is carrying one.
    // The label rides along untouched — `weld` re-hangs a sprite rather than
    // trying to merge it.
    const armful = weld(held);
    // Out in front at chest height, so it reads as carried rather than worn.
    armful.position.set(0, 0.62, 0.34);
    rec.obj.add(armful);
    rec.carry = armful;
  }

  /**
   * The bag, basket or trolley a shopper has on them.
   *
   * A child of the body like the bubble, the armful and the break prop, so it
   * follows them out of the door and leaves with them, rather than being a
   * second thing to remember to move.
   *
   * Two things here are the pastime's lessons rather than new ones. **The
   * rebuild key is the stage index, never the raw fullness** — a basket filling
   * up moves that number on most snapshots, and a key that moved with it would
   * tear the geometry down and build it again for a fraction of a bag. And
   * **the model authors where it hangs**: this sets no position, because a bag
   * held at the side and a basket held in front are the same code and a
   * different drawing.
   *
   * No shadow, for the reason nothing on a person casts one: the body already
   * does, and a bag laying its own across the floor reads as litter.
   */
  syncKit(rec, kit) {
    const model = kit ? (this.catalog.kits?.[kit.id]?.model ?? null) : null;
    const fill = kit?.fill ?? 0;
    const key = model ? `${kit.id}:${stageIndexAt(model, fill)}` : null;
    if (rec.kitKey === key) return;
    rec.kitKey = key;

    if (rec.kit) {
      rec.obj.remove(rec.kit);
      disposeGroup(rec.kit);
      rec.kit = null;
    }
    if (!key) return;

    rec.kit = buildModel(model, { castShadow: false, t: fill });
    rec.obj.add(rec.kit);
  }

  /**
   * The crate somebody is carrying, drawn as the crate it is.
   *
   * `buildPallet` rather than a box of its own, for the reason `client/thumb.js`
   * derives a palette button instead of matching one: a second picture of a
   * thing the game already draws goes wrong the moment either changes, and
   * nobody holds a carried crate up against one in the yard to notice. It is
   * also the fact the player needs — set it down and *that* is what appears —
   * so the sample inside and the count on the front both carry over for free.
   *
   * Held high and forward, at the height a box is carried rather than the chest
   * height an armful is: the two have to be tellable apart across the shop,
   * because they are the difference between hands you can use and hands you
   * cannot. Scaled down slightly so a crate does not read as wider than the
   * person under it.
   */
  syncHaul(rec, haul, cap) {
    const piles = (haul?.stacks ?? []).map((s) => ({
      ...s,
      model: this.catalog.items[s.item_id]?.model ?? null,
      name: this.catalog.items[s.item_id]?.name ?? '',
    }));
    const key = piles.length
      ? `${piles.map((s) => `${s.item_id}:${s.qty}`).join(',')}/${cap}` : null;
    if (rec.haulKey === key) return;
    rec.haulKey = key;

    if (rec.haul) {
      rec.obj.remove(rec.haul);
      disposeGroup(rec.haul);
      rec.haul = null;
    }
    if (!key) return;

    // `covered: false` so you can see into it — what is in the box is the whole
    // question when somebody walks past you with one, and with a mixed crate it
    // is the only way to tell that the box is doing three jobs at once.
    const box = buildPallet(piles, { covered: false, cap });
    box.scale.setScalar(0.72);
    box.position.set(0, 0.52, 0.3);
    rec.obj.add(box);
    rec.haul = box;
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
      const fx = { ...def, kind: shelfKind(def.kind) };
      // The boards you can SEE INTO, not every board the model has. Those two
      // were the same thing until a fixture grew a canopy — and since goods
      // fill top-first, the covered board is the one they all land on. See
      // `drawableBoards`. Capacity is untouched: `shelfBoards` on the server
      // still counts every surface, so what a shelf HOLDS is not a rendering
      // decision — this only moves where the picture puts it.
      const model = this.fixtureModel(fx);
      const t = this.fixtureT(fx);
      const rows = drawableBoards(partsAt(model, t), surfacesAt(model, t));
      // Rows have a front and a back, so the goods have to turn with the unit.
      // A flat top doesn't care, which is why this never mattered before.
      rec.group.rotation.y = -(def.rot ?? 0) * (Math.PI / 2);
      rec.group.position.set(def.x, rows.length ? 0 : this.fixtureHeight(fx), def.z);

      // A unit holds one kind per BOARD now, so this draws a list rather than a
      // single item — board n gets stack n, top down, which is the order
      // `buildShelfGoods` already fills in and the reason no positions had to be
      // invented for this. A unit with no boards piles everything on its roof,
      // which is what a chest freezer and a counter want, so there the stacks
      // are drawn one behind the other rather than side by side — and a unit
      // whose every board is covered takes that same fallback, because a board
      // you cannot see into is a board it does not have.
      const stacks = (s.stacks ?? []).filter((k) => k.qty > 0);

      // A kind gets its SHARE of the boards, not one board. The unit's capacity
      // is divided by how many ways it is spoken for (`shelfShares`, server
      // side) and the art has to be divided the same way, or a shelf kept for
      // one thing draws sixteen carrots' worth of stock on the top board and
      // leaves two bare — which reads as two boards that never fill. Shares
      // rather than stacks, so a board held open by a reservation with no goods
      // behind it yet stays held open in the picture too.
      const kinds = [...new Set([
        ...(s.assigned ?? []), ...stacks.map((k) => k.item_id),
      ])];
      const shares = Math.max(1, kinds.length);
      // Top down: `rows` runs bottom-first, and the top board is the one a 45°
      // camera actually shows.
      const topFirst = [...rows].reverse();
      const each = Math.floor(rows.length / shares);
      const spare = rows.length % shares;
      const boardsFor = (gi) => {
        if (!rows.length) return [];
        // More kinds than boards — the server won't open a stack past
        // `shelfBoards`, but a reservation can outnumber them. One each, wrapped.
        if (each === 0) return [topFirst[gi % rows.length]];
        const start = gi * each + Math.min(gi, spare);
        return topFirst.slice(start, start + each + (gi < spare ? 1 : 0));
      };

      // What will actually be DRAWN, which is what the redraw has to follow.
      // Keying on qty alone rebuilt geometry on every sale of a forty-unit
      // shelf that already read as full; keying on a clamp of qty missed the
      // sale that takes a facing away.
      const plan = stacks.map((k) => {
        const gi = Math.max(0, kinds.indexOf(k.item_id));
        const boards = boardsFor(gi);
        return {
          k, gi, boards,
          show: rows.length ? shelfShow(k.qty, k.cap, boards) : Math.ceil(k.qty / 4),
        };
      });
      const key = plan.map((p) => `${p.k.item_id}:${p.gi}:${p.show}`).join('|')
        + `:${rows.length}:${shares}`;
      if (rec.key === key) continue;
      rec.key = key;
      // Freed, not just dropped. This was a bare `clear()` for as long as a
      // stack was a pile of meshes over the SHARED `GEO` primitives — nothing
      // to free, so nothing leaked. Welding gives every stack a merged geometry
      // of its own, and a shelf's stock is rebuilt on every sale, so a `clear()`
      // here would have turned the cheapest thing in the renderer into the
      // fastest leak in it. The same line syncPlots has always had.
      disposeGroup(rec.group);
      rec.group.clear();
      if (!stacks.length) continue;

      // One group per kind, and each one says which kind it is. That field is
      // what makes a board a thing you can point at: `pickFixtureHit` walks up
      // from whatever mesh the ray met, and a pile of bread answers "the bread
      // on this shelf" rather than just "this shelf". Set on the group the
      // builder hands back rather than inside it, because both builders weld —
      // the meshes underneath are a merge of everything that shared a material
      // and there is nothing per-item left down there to tag.
      plan.forEach((p, n) => {
        const item = this.catalog.items[p.k.item_id];
        if (!item) return;
        if (!rows.length) {
          // No boards: everything heaps on the roof. Nudged apart so two kinds
          // read as two heaps rather than one interpenetrating mess.
          const heap = buildStack(item.model, p.k.qty, item.stack);
          heap.position.x += (n - (plan.length - 1) / 2) * 0.34;
          heap.userData.item = p.k.item_id;
          rec.group.add(heap);
          return;
        }
        // `buildShelfGoods` fills the boards it is handed top-first, so they go
        // back bottom-first — this kind fills its own share of the unit from
        // the top of it down, and touches nobody else's boards.
        const goods = buildShelfGoods(item.model, p.k.qty, [...p.boards].reverse(), p.k.cap);
        goods.userData.item = p.k.item_id;
        rec.group.add(goods);
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
      // picking it hands over. Built into a bed of their own and welded, the way
      // stock is — a bed of twelve is twelve plants and one object, and nothing
      // growing in it moves independently of the rest.
      const bed = new THREE.Group();
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
        bed.add(plant);
      }
      rec.group.add(weld(bed));

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

  /**
   * Everything that is running, one frame.
   *
   * Two halves, and they are two halves because a machine is drawn in two
   * places. Its own moving parts belong to the fixture standing in `staticRoot`
   * — a blade is part of the blender whether it is turning or not — and are
   * driven by whether it is busy. Whatever it puts on top while it works is a
   * prop of its own, and only exists while there is something to show.
   *
   * The rule for the first half is the one the schema states: a fixture that can
   * be busy moves while it *is* busy, and a fixture that has no idea what busy
   * means always moves. Without that second clause `motion` would be a field
   * that silently does nothing on everything except an appliance, and a ceiling
   * fan would be a fixture you can author and never see turn.
   */
  animateStations(now) {
    // Stopped time stops the machines. A return rather than passing `false` for
    // "working": false eases them down to a halt over the next second, which is
    // a machine being switched off, and time stopping is not that.
    if (this.paused) return;
    const t = now / 1000;
    for (const [id, body] of this.movingFixtures) {
      const st = this.stationProps.get(id);
      animateMotion(body.moving, t + body.phase, st ? st.making : true);
    }
    for (const rec of this.stationProps.values()) {
      if (!rec.work) continue;
      animatePuffs(rec.work.userData.puffs, t);
      animateMotion(rec.work.userData.moving, t, true);
    }
  }

  render() {
    const now = performance.now();
    // How long the last frame took. Everything else animated in here is a sine
    // of `now` and could not care — an oscillation is at the same place at the
    // same moment however many frames got you there — but a *chase* toward a
    // moving target is not, and one written as a fixed fraction per frame runs
    // at whatever speed the machine happens to draw at. Clamped for the same
    // reason main.js clamps its own: a backgrounded tab comes back with a delta
    // of however long you were away, which would snap the thing being chased
    // straight to its target and lose the corner it was going round.
    const dt = Math.min(0.05, (now - (this.lastFrameAt ?? now)) / 1000);
    this.lastFrameAt = now;
    this.animateCash(now);
    this.animatePlots(now);
    this.animateMoods(now);
    // The van and the parked cars. Per frame rather than per snapshot, unlike
    // every other body in the game — see `VEHICLE_CHASE`.
    this.animateVehicles(dt);
    // Appliances. Per-frame like everything else here: a batch is thirty
    // seconds and the flag that says one is running arrives at 10Hz, so a blade
    // that only turned when the snapshot did would read as a dropped frame.
    this.animateStations(now);
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
    // ...if it has one. A board's cage deliberately has no chevron (see
    // `MARKER_LOOK.board`), so this is a guard rather than a formality: the one
    // marker in the game with nothing floating over it would otherwise throw
    // once a frame for as long as you pointed at a shelf full of bread.
    if (this.aimMarker?.userData.arrow) {
      // No spin any more, here or below. A ring is rotationally symmetric, so
      // the spin these markers were given was invisible — and the moment they
      // became squares that agree with the tile grid it stopped being
      // invisible and started being wrong.
      this.aimMarker.userData.arrow.position.y = 1.62 + Math.sin(now / 1000 * 4) * 0.11;
    }
    // The one marker that has to be re-placed every frame, because what it is
    // pointing at is walking. If their body has gone — let go, or their kind
    // deleted — the marker goes with it rather than hanging over the floor.
    if (this.personMarker) {
      const rec = this.bodyOfHire(this.personAimId);
      if (!rec) this.setPersonAim(null);
      else {
        this.personMarker.position.copy(rec.obj.position);
        // Lower than a fixture's: a shelf is chest high and a person is not, so
        // the same 1.62 floats a chevron in the air over their head.
        this.personMarker.userData.arrow.position.y = 1.34 + Math.sin(now / 1000 * 4) * 0.11;
      }
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
    if (this.aimMarker?.userData.ring) {
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
    // actually gone somewhere. What it lights is only ever the things that MOVE
    // — the ground is baked and sits on a layer these cannot reach, which is
    // what makes a pool that follows you acceptable again. See lights.js.
    this.lights.update(this.camLook);
    this.camera.position.copy(this.camLook).add(this.camOffset);
    this.camera.lookAt(this.camLook);
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).add(SUN_OFFSET);
    // See the constructor. Set the frame before it is wanted, not after: three
    // clears `needsUpdate` inside `render`, so this is a request for THIS draw.
    this.renderer.shadowMap.needsUpdate = (this.shadowTick++ % SHADOW_EVERY) === 0;
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
  return p.staff ? `${p.staff}:${p.tier ?? 1}:${skinKey({ id: p.skin })}` : null;
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
    ...(L.shelves ?? []).map((s) => ({ ...s, kind: shelfKind(s.kind) })),
    ...(L.checkouts ?? []).map((c) => ({ ...c, kind: 'checkout' })),
    ...(L.stations ?? []).map((s) => ({ ...s, kind: 'station' })),
    ...(L.plots ?? []).map((p) => ({ ...p, kind: 'plot' })),
    // Decorations carry their own kind, because there is more than one of them
    // and which list they came out of no longer says which.
    ...(L.props ?? []),
  ];
}
