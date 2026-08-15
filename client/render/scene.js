/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, EDGE_STYLE, CEILING_Y, jitter, faceColor } from './palette.js';
import {
  buildModel, buildCharacter, buildStack, buildShelfGoods, shelfSlots, buildBubble, buildCashDrop,
  buildHopperSlots,
  buildTextSprite, buildPallet, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, disposeGroup, material,
  buildGrowthBar, setGrowthBar,
} from './props.js';
import { T } from '../../shared/tiles.js';
import { FIXTURES, anchorTile, canPlace, baseTile, turn, rot4 } from '../../shared/build.js';
import { pieceFor } from '../../shared/pieces.js';
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

/**
 * Fixture kinds whose authored model stands *instead of* their tile block.
 *
 * A shelf is a box, so a shelf model replaces that box. A plot is a hole in the
 * ground: its tile is the bed itself and the soil is drawn on top of it, so a
 * plot model (a raised frame, say) has to be added to that rather than swapped
 * for it. Purely a rendering distinction, which is why it lives here and not in
 * the build rules.
 */
const MODEL_REPLACES_TILE = new Set(['shelf', 'freezer', 'checkout', 'station']);

/** How tall a decoration's ghost pad is. It has no tile to take a height from. */
const PROP_GHOST_H = 0.3;

/** Usable width inside a plot's frame, and roughly how wide a crop draws. */
const BED_SPAN = 0.64;
const PLANT_FOOTPRINT = 0.4;
/** Past this a bed just reads as "full"; no authored crop comes close. */
const BED_MAX = 12;

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
    this._pickPlanes = null;

    // Tiles a fixture's own model is about to stand on. Drawing both would put
    // a shelf inside a shelf-coloured block.
    const modelled = new Set();
    for (const f of fixturesIn(L)) {
      if (this.fixtureModel(f) && MODEL_REPLACES_TILE.has(f.kind)) modelled.add(`${f.x},${f.z}`);
    }

    // Every geometry under staticRoot was built for the previous layout, and
    // `clear()` alone drops the references without freeing the GPU buffers.
    // That barely mattered when the shop only re-flowed on an upgrade; build
    // mode re-flows on every placement.
    disposeGroup(this.staticRoot);
    this.staticRoot.clear();
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

    // Everything raised gets an instanced box per tile kind.
    const byKind = new Map();
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        // A fixture drawn from its own model still needs the ground it stands
        // on. Skipping the tile outright left a hole, and once fixtures stopped
        // filling their tile edge to edge you could see straight through it to
        // the grass under the shop — as a green outline around every unit.
        const kind = modelled.has(`${x},${z}`) ? baseTile(L, x, z) : L.tiles[z * L.w + x];
        if (kind === 0) continue;
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push([x, z]);
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();

    for (const [kind, cells] of byKind) {
      const style = TILE_STYLE[kind];
      if (!style) continue;
      const height = Math.max(style.h, 0.04);

      const mesh = new THREE.InstancedMesh(box, material(style.color), cells.length);
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

        const c = new THREE.Color(jitter(style.color, 0.05, x * 31 + z * 17));
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.staticRoot.add(mesh);

      // Furniture gets a contrasting top slab so it reads as a shelf or a
      // counter rather than an anonymous coloured block.
      const TOPS = { 2: PALETTE.wallTop, 3: PALETTE.shelfTop, 4: '#eaf6f8', 5: PALETTE.counterTop, 10: PALETTE.stationTop };
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
    this.camTarget.set(L.door.x, 0, L.door.z + 2);
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
    for (const f of fixturesIn(L)) byTile.set(`${f.x},${f.z}`, f);

    for (const f of fixturesIn(L)) {
      const model = this.fixtureModel(f);
      if (!model) continue;
      const prop = buildModel(model, {
        t: this.fixtureT(f),
        abuts: (step) => this.carriesOn(byTile, f, step),
      });
      // Models are authored facing east, which is rot 0 — the same convention
      // the layout generator has always used for which side you work from.
      prop.rotation.y = -(f.rot ?? 0) * (Math.PI / 2);
      prop.position.set(f.x, this.fixtureBaseY(f), f.z);
      this.staticRoot.add(prop);
    }

    // Lamps. Rebuilt with the world because a light is a position, and the
    // positions just changed; the pool of actual THREE lights outlives this and
    // is only ever re-aimed. See lights.js for why that split is load-bearing.
    this.lights.setEmitters(emittersIn(fixturesIn(L), (f) => this.pieceOf(f), CEILING_Y));
  }

  /**
   * What height a fixture's model stands on.
   *
   * Three answers, and each one is a different thing the model means. A shelf
   * replaces its tile block, so it sits on the floor. A plot's model is a frame
   * added *to* the bed, so it sits on top of the tile. And a hanging prop hangs:
   * it has no tile at all and is drawn from the ceiling down, which is the one
   * thing an authored model cannot say about itself.
   */
  fixtureBaseY(f) {
    if (FIXTURES[f.kind]?.at === 'ceiling') return CEILING_Y;
    if (MODEL_REPLACES_TILE.has(f.kind)) return 0;
    return TILE_STYLE[FIXTURES[f.kind]?.tile]?.h ?? 0;
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

    const emit = (kind, vertical, cx, cz) => {
      const style = EDGE_STYLE[kind];
      if (!style) return;
      if (style.opening) {
        // Header across the top, threshold underfoot, nothing between.
        push(kind, vertical, { cx, cz, y0: style.h - 0.16, y1: style.h });
        push(kind, vertical, { cx, cz, y0: 0.02, y1: 0.05 });
        return;
      }
      if (style.glass) {
        push(kind, vertical, { cx, cz, y0: 0, y1: 0.34 });
        push(kind, vertical, { cx, cz, y0: 0.9, y1: style.h });
        push(kind, vertical, { cx, cz, y0: 0.34, y1: 0.9, alpha: 0.35 });
        return;
      }
      push(kind, vertical, { cx, cz, y0: 0, y1: style.h });
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
      for (const [set, alpha] of [[opaque, 1], [clear, 0.35]]) {
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
    this.syncActors(state.players, this.players, (p) => this.buildActor(p), (p) => actorKey(p));
    this.syncActors(state.customers, this.customers, (c) => buildCharacter(c.color));
    this.syncShelves(state.shelves);
    this.syncPlots(state.plots);
    this.syncCashDrops(state.cashDrops ?? []);
    this.syncDeliveries(state.deliveries ?? []);
    this.syncStations(state.stations ?? []);
    this.syncActionRings(state.players, myId);
    this.syncGhost(state, myId);
    this.syncLifted(state.players.find((p) => p.id === myId));
    this.syncActionTarget(state.players.find((p) => p.id === myId));

    const me = state.players.find((p) => p.id === myId);
    if (me) this.camTarget.set(me.x, 0, me.z);

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

  /**
   * Show the held seed as a ghost on the plot you're standing at. Replaces the
   * popup entirely: you're always holding something, and the plot tells you
   * what would go in it.
   */
  syncGhost(state, myId) {
    const me = state.players.find((p) => p.id === myId);
    const plotId = me?.atBarePlot ?? null;
    const cropId = me?.selectedCrop ?? null;
    const key = plotId && cropId ? `${plotId}:${cropId}` : null;

    if (this.ghostKey === key) {
      if (this.ghost) {
        // Gentle breathing so it reads as a preview, not a planted crop.
        const t = performance.now() / 1000;
        this.ghost.position.y = 0.18 + Math.sin(t * 2.6) * 0.04;
        this.ghost.rotation.y = t * 0.7;
      }
      return;
    }
    this.ghostKey = key;

    if (this.ghost) {
      this.actorRoot.remove(this.ghost);
      disposeGroup(this.ghost);
      this.ghost = null;
    }
    if (!key) return;

    const crop = this.catalog.crops[cropId];
    const plot = this.storeLayout?.plots?.find((p) => p.id === plotId);
    if (!crop?.model || !plot) return;

    const g = buildGhost(crop.model);
    g.position.set(plot.x, 0.18, plot.z);
    g.scale.setScalar(0.9);
    this.actorRoot.add(g);
    this.ghost = g;
  }

  // -------------------------------------------------------------------------
  // Build mode
  // -------------------------------------------------------------------------

  /**
   * Which tile is under the pointer, on the flat plane `y` units up.
   *
   * Raycast against a plane rather than against geometry, so pointing at the
   * floor *behind* a shelf still gives you the floor and not the shelf's roof.
   * `y` is what lets `pickFixture` ask the other question — which box is the
   * pointer actually on top of.
   */
  pickTile(clientX, clientY, y = 0) {
    if (!this.storeLayout) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._ray ??= new THREE.Raycaster();
    this._plane ??= new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit ??= new THREE.Vector3();

    this._plane.constant = -y;
    this._ray.setFromCamera(ndc, this.camera);
    if (!this._ray.ray.intersectPlane(this._plane, this._hit)) return null;

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
    if (model && MODEL_REPLACES_TILE.has(f.kind)) {
      return modelHeight(partsAt(model, this.fixtureT(f)));
    }
    // A prop's height is its art on top of wherever it hangs or stands, because
    // it has no tile block to take a height from. That base matters more than it
    // sounds for a hanging one: its art is drawn downward from the ceiling, so
    // `modelHeight` alone answers 0 and the picker would look for it on the
    // floor — most of a tile down-screen of where it is actually drawn, which is
    // the neighbour-selecting bug again with the camera pointing the other way.
    if (FIXTURES[f.kind]?.tile == null) {
      return this.fixtureBaseY(f) + (model ? modelHeight(partsAt(model, this.fixtureT(f))) : 0);
    }
    return TILE_STYLE[FIXTURES[f.kind]?.tile]?.h ?? 0;
  }

  /**
   * Which fixture the pointer is actually over.
   *
   * Not the same question as `pickTile`. A shelf is a three-quarter-tile-tall
   * box, and on a 45° camera its top face is drawn a good tile up-screen of the
   * ground it stands on — so a ground-plane pick aimed at the middle of a shelf
   * lands on the floor *behind* it. That is the difference between clicking a
   * shelf and getting its neighbour.
   *
   * So: intersect the plane each fixture height's top face lives on, tallest
   * first, and take the first one that has a fixture of that exact height on
   * it. Tallest first because a taller box in front occludes a shorter one
   * behind, which is precisely the pixel you clicked.
   */
  pickFixture(clientX, clientY) {
    if (!this.storeLayout) return null;
    // Taken from what is actually standing in this shop, so a tier-3 shelf that
    // is taller than a tier-1 one gets its own plane. Rebuilt with the world.
    this._pickPlanes ??= [...new Set(this.allFixtures().map((f) => this.fixtureHeight(f)))]
      .sort((a, b) => b - a);

    for (const h of this._pickPlanes) {
      const t = this.pickTile(clientX, clientY, h);
      if (!t) continue;
      const f = this.fixtureAt(t.x, t.z);
      if (f && Math.abs(this.fixtureHeight(f) - h) < 1e-6) return f;
    }
    return null;
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
  setAimTarget(f) {
    const key = f ? f.id : null;
    if (this.aimKey === key) return;
    this.aimKey = key;
    if (this.aimMarker) {
      this.actorRoot.remove(this.aimMarker);
      disposeGroup(this.aimMarker);
      this.aimMarker = null;
    }
    if (!f) return;
    this.aimMarker = buildTargetMarker();
    this.aimMarker.position.set(f.x, 0, f.z);
    this.actorRoot.add(this.aimMarker);
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
    const g = buildFixtureGhost(
      def.tile == null ? PROP_GHOST_H : (TILE_STYLE[def.tile]?.h ?? 0.5),
      def.tile == null ? TILE_STYLE[T.FLOOR]?.color : TILE_STYLE[def.tile]?.color,
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

  clearBuildGhost(keepKey = false) {
    this.setEdgeGhost(null, null);
    if (this.buildGhost) {
      this.actorRoot.remove(this.buildGhost);
      disposeGroup(this.buildGhost);
      this.buildGhost = null;
    }
    if (!keepKey) this.buildGhostKey = null;
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
   * Light up whatever your hold would act on. Armed is not the same as running:
   * the marker appears the moment something is in range, and the progress ring
   * only shows once you actually commit.
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
    this.targetMarker.userData.held = !!me.action.holding;
  }

  /**
   * The charge-up ring, shown only once you're actually holding. It sits over
   * the player; the marker above says which thing it's aimed at.
   */
  syncActionRings(players, myId) {
    const seen = new Set();
    for (const p of players) {
      if (!p.action || !(p.action.progress > 0)) continue;
      seen.add(p.id);
      let rec = this.actionRings.get(p.id);
      if (!rec) {
        rec = buildProgressRing(p.id === myId ? '#ffd66b' : '#9ad285');
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

      // On a unit with rows every single unit is a prop, so the redraw has to
      // follow every single unit — `Math.ceil(qty / 4)` was fine when stock was
      // a three-step pile and would now hold four sales' worth of goods on a
      // shelf that no longer has them. Clamped one past what can be shown, so a
      // busy shelf holding forty stops rebuilding once it just reads as full.
      const shown = rows.length
        ? Math.min(s.qty, shelfSlots(rows) + 1)
        : Math.ceil(s.qty / 4);
      const key = `${s.item_id}:${shown}:${rows.length}`;
      if (rec.key === key) continue;
      rec.key = key;
      rec.group.clear();

      if (!s.item_id || s.qty <= 0) continue;
      const item = this.catalog.items[s.item_id];
      if (!item) continue;
      rec.group.add(rows.length
        ? buildShelfGoods(item.model, s.qty, rows)
        : buildStack(item.model, s.qty, item.stack));
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
      const t = now / 1000;
      this.aimMarker.userData.arrow.position.y = 1.62 + Math.sin(t * 4) * 0.11;
      this.aimMarker.userData.ring.rotation.z = t * 0.5;
    }
    if (this.targetMarker) {
      const t = now / 1000;
      const held = this.targetMarker.userData.held;
      // Bobbing while it's waiting for you, and pulled taut once you commit —
      // so pressing the button has an immediate answer even before the ring
      // has visibly moved.
      this.targetMarker.userData.arrow.position.y = held ? 1.5 : 1.62 + Math.sin(t * 4) * 0.11;
      this.targetMarker.userData.ring.scale.setScalar(held ? 1.12 : 1 + Math.sin(t * 4) * 0.045);
      this.targetMarker.userData.ring.rotation.z = t * (held ? 1.8 : 0.5);
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
    this.camLook.lerp(this.camTarget, 0.08);
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
