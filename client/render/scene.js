/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, jitter } from './palette.js';
import {
  buildModel, buildCharacter, buildStack, buildBubble, buildCashDrop,
  buildTextSprite, buildPallet, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, disposeGroup, material,
} from './props.js';
import { T } from '../../shared/tiles.js';
import { FIXTURES, anchorTile, canPlace } from '../../shared/build.js';

/** How many world tiles fit vertically on screen. Smaller = closer in. */
const FRUSTUM = 17;

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
    this.camOffset = new THREE.Vector3(20, 24, 20);
    this.camTarget = new THREE.Vector3(22, 0, 17);
    this.camLook = this.camTarget.clone();

    this.setupLights();

    this.staticRoot = new THREE.Group();
    this.actorRoot = new THREE.Group();
    this.scene.add(this.staticRoot, this.actorRoot);

    this.players = new Map();
    this.customers = new Map();
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
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

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

  setCatalog(catalog) {
    this.catalog = {
      items: Object.fromEntries(catalog.items.map((i) => [i.id, i])),
      crops: Object.fromEntries(catalog.crops.map((c) => [c.id, c])),
    };
    // Content changed — force props to rebuild with any new models.
    for (const [, rec] of this.shelfProps) rec.key = null;
    for (const [, rec] of this.plotProps) rec.key = null;
  }

  // -------------------------------------------------------------------------
  // Static world
  // -------------------------------------------------------------------------

  buildWorld(layout) {
    if (layout.version === this.layoutVersion) return;
    this.layoutVersion = layout.version;
    const L = layout.layout ?? layout;

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

    // Ground: one big plane rather than 1500 grass tiles.
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(L.w + 3, 0.4, L.h + 3),
      material(PALETTE.grass),
    );
    ground.position.set(L.w / 2, -0.2, L.h / 2);
    ground.receiveShadow = true;
    this.staticRoot.add(ground);

    // Everything raised gets an instanced box per tile kind.
    const byKind = new Map();
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        const kind = L.tiles[z * L.w + x];
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
      }
      map.clear();
    }
  }

  /** A striped awning over the shop door — pure decoration, sells the vibe. */
  addAwning(L) {
    const width = 6;
    for (let i = 0; i < width; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.12, 1.4),
        material(i % 2 === 0 ? PALETTE.awningA : PALETTE.awningB),
      );
      stripe.position.set(L.door.x - width / 2 + i + 0.5, 1.35, L.door.z + 0.5);
      stripe.rotation.x = -0.28;
      stripe.castShadow = true;
      this.staticRoot.add(stripe);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic actors
  // -------------------------------------------------------------------------

  syncState(state, myId) {
    this.syncActors(state.players, this.players, (p) => buildCharacter(p.color, { hat: '#ffffff' }));
    this.syncActors(state.customers, this.customers, (c) => buildCharacter(c.color));
    this.syncShelves(state.shelves);
    this.syncPlots(state.plots);
    this.syncCashDrops(state.cashDrops ?? []);
    this.syncDeliveries(state.deliveries ?? []);
    this.syncActionRings(state.players, myId);
    this.syncGhost(state, myId);
    this.syncLifted(state.players.find((p) => p.id === myId));
    this.syncActionTarget(state.players.find((p) => p.id === myId));

    const me = state.players.find((p) => p.id === myId);
    if (me) this.camTarget.set(me.x, 0, me.z);

    // Warm daylight through the day, cooler at open/close.
    const t = state.time ?? 0.5;
    const daylight = Math.sin(Math.PI * Math.min(Math.max((t - 0.25) / 0.6, 0), 1));
    this.sun.intensity = 0.55 + daylight * 0.75;
  }

  syncActors(list, map, factory) {
    const seen = new Set();
    for (const a of list) {
      seen.add(a.id);
      let rec = map.get(a.id);
      if (!rec) {
        const obj = factory(a);
        this.actorRoot.add(obj);
        rec = { obj, bubble: null, bubbleKey: null, carry: null, carryKey: null };
        map.set(a.id, rec);
        obj.position.set(a.x, 0, a.z);
      }
      // Lerp toward the server position so 10Hz network looks smooth at 60fps.
      rec.obj.position.x += (a.x - rec.obj.position.x) * 0.35;
      rec.obj.position.z += (a.z - rec.obj.position.z) * 0.35;
      rec.obj.rotation.y = a.facing ?? 0;

      // A want is a thought; a carry is a thing in your hands. Showing both
      // through one bubble meant you could never tell which you were looking at.
      this.syncBubble(rec, a.want ?? null);
      this.syncCarry(rec, a.carry ?? null);
    }
    for (const [id, rec] of map) {
      if (!seen.has(id)) {
        this.actorRoot.remove(rec.obj);
        map.delete(id);
      }
    }
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

  /** How tall this kind of fixture is drawn — the plane its top face sits on. */
  fixtureHeight(f) {
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
    this._pickPlanes ??= [...new Set(Object.values(FIXTURES)
      .map((d) => TILE_STYLE[d.tile]?.h ?? 0))].sort((a, b) => b - a);

    for (const h of this._pickPlanes) {
      const t = this.pickTile(clientX, clientY, h);
      if (!t) continue;
      const f = this.fixtureAt(t.x, t.z);
      if (f && this.fixtureHeight(f) === h) return f;
    }
    return null;
  }

  /**
   * Every fixture in the layout as a uniform record — the same shape the server
   * works over in build mode, so the two agree about what a fixture is.
   */
  allFixtures() {
    const L = this.storeLayout;
    if (!L) return [];
    return [
      ...(L.shelves ?? []).map((s) => ({ ...s, kind: s.kind === 'freezer' ? 'freezer' : 'shelf' })),
      ...(L.checkouts ?? []).map((c) => ({ ...c, kind: 'checkout' })),
      ...(L.stations ?? []).map((s) => ({ ...s, kind: 'station' })),
      ...(L.plots ?? []).map((p) => ({ ...p, kind: 'plot' })),
    ];
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
    const key = `${spec.kind}:${spec.x}:${spec.z}:${spec.rot}:${verdict.ok}`;
    if (this.buildGhostKey === key) return verdict;
    this.buildGhostKey = key;
    this.clearBuildGhost(true);

    const def = FIXTURES[spec.kind];
    if (!def) return verdict;
    const a = anchorTile(0, 0, spec.rot ?? 0);
    const g = buildFixtureGhost(
      TILE_STYLE[def.tile]?.h ?? 0.5,
      TILE_STYLE[def.tile]?.color,
      verdict.ok,
      def.anchor ? { dx: a.x, dz: a.z } : null,
    );
    g.position.set(spec.x, 0, spec.z);
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

  clearBuildGhost(keepKey = false) {
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

  syncShelves(shelves) {
    if (!this.storeLayout) return;
    for (const s of shelves) {
      const def = this.storeLayout.shelves.find((x) => x.id === s.id);
      if (!def) continue;
      const key = `${s.item_id}:${Math.ceil(s.qty / 4)}`;
      let rec = this.shelfProps.get(s.id);

      if (!rec) {
        rec = { group: new THREE.Group(), key: null };
        this.actorRoot.add(rec.group);
        this.shelfProps.set(s.id, rec);
      }
      // Re-read the position every sync rather than only on creation. A shelf
      // you pick up and set down elsewhere keeps its id so its stock follows —
      // which only works if the stack follows the shelf too.
      rec.group.position.set(def.x, TILE_STYLE[T.SHELF].h, def.z);
      if (rec.key === key) continue;
      rec.key = key;
      rec.group.clear();

      if (!s.item_id || s.qty <= 0) continue;
      const item = this.catalog.items[s.item_id];
      if (!item) continue;
      rec.group.add(buildStack(item.model, s.qty, item.stack));
    }
  }

  syncPlots(plots) {
    if (!this.storeLayout) return;
    for (const p of plots) {
      const def = this.storeLayout.plots.find((x) => x.id === p.id);
      if (!def) continue;
      const stage = p.ready ? 3 : Math.floor((p.growth ?? 0) * 3);
      const soil = p.soil ?? 'untilled';
      const key = `${soil}:${p.crop_id}:${stage}`;
      let rec = this.plotProps.get(p.id);

      if (!rec) {
        rec = { group: new THREE.Group(), key: null };
        this.actorRoot.add(rec.group);
        this.plotProps.set(p.id, rec);
      }
      rec.group.position.set(def.x, TILE_STYLE[T.PLOT].h, def.z);
      if (rec.key === key) continue;
      rec.key = key;
      disposeGroup(rec.group);
      rec.group.clear();

      // Turned earth vs rough turf. A planted bed is always broken soil, so a
      // crop never looks like it's growing straight out of the lawn.
      rec.group.add(buildSoil(p.crop_id ? 'tilled' : soil, PALETTE));

      if (!p.crop_id) continue;
      const crop = this.catalog.crops[p.crop_id];
      if (!crop) continue;

      const plant = buildModel(crop.model);
      // Grow visibly from a sprout to full size.
      const scale = 0.35 + (p.ready ? 1 : (p.growth ?? 0)) * 0.65;
      plant.scale.setScalar(scale);
      rec.group.add(plant);

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

  // -------------------------------------------------------------------------

  render() {
    const now = performance.now();
    this.animateCash(now);
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
    this.camLook.lerp(this.camTarget, 0.08);
    this.camera.position.copy(this.camLook).add(this.camOffset);
    this.camera.lookAt(this.camLook);
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).add(new THREE.Vector3(26, 40, 14));
    this.renderer.render(this.scene, this.camera);
  }

  /** Grab the current frame as a PNG data URL (used by the MCP screenshot tool). */
  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}
