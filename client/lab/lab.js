/**
 * THE STYLE LAB.
 *
 * A second page on the dev server that draws the shop's REAL art — the models
 * out of `data/seed/*.json`, built by `client/render/props.js` — through a
 * pipeline of its own, so a whole art direction can be argued about without a
 * line of the renderer changing.
 *
 * Two rules hold it apart from the game, and both are the point rather than
 * tidiness:
 *
 *   NOTHING IS IMPORTED FROM HERE BY THE GAME. `client/lab.html` is not the
 *   build entry (Vite builds `client/index.html` and nothing else), so this
 *   whole directory ships in dev and never leaves it. Deleting it is a
 *   one-line change to nothing.
 *
 *   NOTHING HERE MUTATES WHAT IT IMPORTS. `material()` in props.js is a cache
 *   shared by the entire renderer, so restyling by writing into those materials
 *   would be a lab that quietly repaints the game the moment both pages are
 *   open in one tab. Every styled material is a lab-owned DERIVATIVE, keyed by
 *   the source material the way `litMaterial` keys by its own — the original is
 *   parked on `mesh.userData.srcMat` and is what every restyle reads from, so
 *   the twentieth style change is applied to the art rather than to the
 *   nineteenth style change.
 */

import * as THREE from 'three';
import {
  buildModel, buildCharacter, buildShelfGoods, disposeGroup,
} from '../render/props.js';
import { setLookOn } from '../render/look.js';
import { surfacesAt, partsAt, modelHeight } from '../../shared/model.js';
import { PALETTE, CEILING_Y } from '../render/palette.js';
import { DEFAULTS, PRESETS, SETS, CONTROLS } from './presets.js';
import { Pipeline } from './pipeline.js';
import { buildRail } from './ui.js';

const DEG = Math.PI / 180;

/**
 * PIN THE BASE ART TO THE LAMBERT, BEFORE ANYTHING IS BUILT.
 *
 * `material()` in props.js resolves to a toon material or a Lambert one
 * depending on whether the player has Cel + Ink on, and this page builds every
 * mesh through it. Left alone, the lab would inherit whatever the GAME was last
 * set to — so `stock`, the preset whose whole job is to be the control, would
 * be the shipped look on one machine and the old one on another, and every
 * preset tuned against it would stop being comparable to the ones tuned before.
 *
 * Second argument false: this changes what the lab draws and never what the
 * player has chosen. `restyle` derives its own material per mesh anyway, so the
 * only thing the base class ever decided here was `flatShading`, which is
 * exactly the kind of one-property difference nobody would find.
 */
setLookOn(false, false);

const canvas = document.getElementById('view');

/* ------------------------------------------------------------------ state -- */

const S = { ...DEFAULTS };
let setName = 'aisle';
let preset = 'stock';

/**
 * The state as a diff against the shipped look.
 *
 * Everything that leaves this page — the hash, the clipboard, the readout — is
 * a diff rather than a dump, for the same reason a preset is a patch: what a
 * style COSTS is exactly the list of numbers that had to move, and a hundred
 * unchanged defaults in the middle of it hides that.
 */
function diff() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (S[k] !== DEFAULTS[k]) out[k] = S[k];
  return out;
}

/* ------------------------------------------------------------- the canvas -- */

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,          // the composite is the last pass; MSAA on the
  // scene target would be resolved and then edge-detected anyway.
  preserveDrawingBuffer: true, // so the Shot button can read the canvas back.
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
camera.near = 10;
camera.far = 140;

const pipeline = new Pipeline(renderer);

/* ------------------------------------------------------------------ light -- */

const ambient = new THREE.AmbientLight(0xffffff, 0.9);
const sun = new THREE.DirectionalLight(0xfff4dd, 1.15);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 200 });
/**
 * `normalBias` rather than `bias`, which is what a TIGHT shadow frustum wants.
 *
 * A constant depth bias is measured in the shadow map's own depth units, so the
 * value that stops acne over a 48-unit frustum lifts the shadow clean off its
 * object once the frustum is 32 — the classic peter-panning, where a shelf
 * floats a few centimetres above its own shadow. `normalBias` offsets along the
 * surface normal instead, in WORLD units, so it means the same thing whatever
 * the map is covering.
 */
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.018;
const bounce = new THREE.DirectionalLight(0xbcd8ff, 0.32);
bounce.position.set(-18, 12, -14);
scene.add(ambient, sun, sun.target, bounce);

/* ------------------------------------------------------------------- sky --- */

const skyCanvas = document.createElement('canvas');
skyCanvas.width = 4;
skyCanvas.height = 128;
const skyTex = new THREE.CanvasTexture(skyCanvas);
skyTex.colorSpace = THREE.SRGBColorSpace;
scene.background = skyTex;

function paintSky() {
  const ctx = skyCanvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, skyCanvas.height);
  g.addColorStop(0, S.skyTop);
  g.addColorStop(1, S.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, skyCanvas.width, skyCanvas.height);
  skyTex.needsUpdate = true;
}

/* ----------------------------------------------------------------- content - */

const byId = { fixtures: new Map(), items: new Map(), crops: new Map() };

/** The seed files are an export of the live database — see CLAUDE.md. Either
 *  shape (a bare array, or one key holding it) is accepted, because that has
 *  drifted before and a lab that dies on the shape is a lab nobody opens. */
function rowsOf(mod) {
  const raw = mod?.default ?? mod;
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {}).find(Array.isArray);
  return list ?? [];
}

async function loadContent() {
  const [f, i, c] = await Promise.all([
    import('../../data/seed/fixtures.json'),
    import('../../data/seed/items.json'),
    import('../../data/seed/crops.json'),
  ]);
  for (const r of rowsOf(f)) byId.fixtures.set(r.id, r);
  for (const r of rowsOf(i)) byId.items.set(r.id, r);
  for (const r of rowsOf(c)) byId.crops.set(r.id, r);
}

/* --------------------------------------------------------------- the world - */

/** Everything a set built. Rebuilt wholesale on a set change, never patched. */
let world = new THREE.Group();
scene.add(world);

/** A per-tile checker, as a 2×2 texture repeated. One draw for any size floor. */
function checkerTexture(a, b) {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = a; ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = b; ctx.fillRect(0, 0, 1, 1); ctx.fillRect(1, 1, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const GROUNDS = {
  floor: () => checkerTexture(PALETTE.floor, PALETTE.floorAlt),
  grass: () => checkerTexture(PALETTE.grass, PALETTE.grassAlt),
  road: () => checkerTexture(PALETTE.path, PALETTE.bay),
};

function addGround(kind) {
  const span = 48;
  const tex = (GROUNDS[kind] ?? GROUNDS.floor)();
  // Half the span, because the texture is a 2×2 checker: one repeat is two
  // squares, so repeating it once per tile draws the floor at half scale and
  // the whole shop reads as being built on something smaller than it is.
  tex.repeat.set(span / 2, span / 2);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.userData.ground = true;
  world.add(mesh);
}

function slab(w, h, d, x, y, z, color, outward = null) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color), flatShading: true }),
  );
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  // Which way this wall faces OUT of the room. `hideNearWalls` reads it — see
  // there for why a lab that keeps all four walls up is a lab you cannot see
  // the shop in.
  if (outward) m.userData.outward = new THREE.Vector3(...outward);
  return m;
}

/**
 * Take down whatever is between the camera and the shop.
 *
 * The game gets away without this because you are INSIDE the building looking
 * at the far wall; a lab looking at a whole room from outside it is looking at
 * the back of the near one. Read off the camera every frame rather than built
 * per set, because the view turns — a set that dropped its near walls at build
 * time would put them back the moment you dragged the pointer, which is the
 * shape of a bug rather than a decision.
 */
function hideNearWalls() {
  for (const o of world.children) {
    const out = o.userData?.outward;
    if (out) o.visible = out.dot(camera.position) < 1;
  }
}

function addWalls(spec) {
  if (!spec) return;
  const H = CEILING_Y;
  const T = 0.16;
  if (spec.kind === 'facade') {
    const z = spec.z ?? 1;
    const half = spec.w / 2;
    const gap = (spec.door ?? 2.4) / 2;
    // Two panes and a lintel rather than a wall with a hole, because a doorway
    // in this game is a gap in a run of edges rather than a shape cut out of a
    // wall — and the ink pass reads the two the same way only if the geometry
    // agrees. See `EDGE_STYLE` for what the real thing is made of.
    world.add(slab(half - gap, H, T, -(gap + (half - gap) / 2), H / 2, z, PALETTE.wall));
    world.add(slab(half - gap, H, T, gap + (half - gap) / 2, H / 2, z, PALETTE.wall));
    world.add(slab(gap * 2, H - 2.1, T, 0, H - (H - 2.1) / 2, z, PALETTE.wall));
    world.add(slab(spec.w, 0.18, T * 2.4, 0, H, z, PALETTE.wallTop));
    // The building behind it, so the facade is a face rather than a fence.
    world.add(slab(spec.w, H, 8, 0, H / 2, z - 4 - T / 2, PALETTE.wall));
    return;
  }
  const { w, d } = spec;
  world.add(slab(w, H, T, 0, H / 2, -d / 2, PALETTE.wall, [0, 0, -1]));
  world.add(slab(w, 0.16, T * 2.2, 0, H, -d / 2, PALETTE.wallTop, [0, 0, -1]));
  world.add(slab(w, H, T, 0, H / 2, d / 2, PALETTE.wall, [0, 0, 1]));
  world.add(slab(w, 0.16, T * 2.2, 0, H, d / 2, PALETTE.wallTop, [0, 0, 1]));
  world.add(slab(T, H, d, -w / 2, H / 2, 0, PALETTE.wall, [-1, 0, 0]));
  world.add(slab(0.16, 0.16, d, -w / 2, H, 0, PALETTE.wallTop, [-1, 0, 0]));
  world.add(slab(T, H, d, w / 2, H / 2, 0, PALETTE.wall, [1, 0, 0]));
  world.add(slab(0.16, 0.16, d, w / 2, H, 0, PALETTE.wallTop, [1, 0, 0]));
}

/**
 * The lamps the shop actually owns.
 *
 * Straight off the piece's own `emits` block, at `lights.js`'s own conversion —
 * three's falloff makes `intensity` a POWER rather than a brightness, so a lamp
 * authored as "1 over 4 tiles" is invisible until it is scaled by the range
 * squared, and a lab that skipped that would show every night look as black and
 * blame the style. Capped at the same EIGHT the game caps at, because a lab that
 * lights a scene more generously than the renderer can is a lab that sells a
 * look the shop cannot draw.
 */
const LAMP_CAP = 8;
let lamps = [];

function addLamp(row, x, y, z, ceiling) {
  if (lamps.length >= LAMP_CAP || !row.emits) return;
  const e = row.emits;
  const light = new THREE.PointLight(new THREE.Color(e.color ?? '#ffd7a1'), 0, e.range ?? 4);
  light.position.set(x, ceiling ? y - 0.35 : y + Math.max(0.4, modelHeight(partsAt(row.model, 1)) * 0.72), z);
  light.userData.emits = e;
  world.add(light);
  lamps.push(light);
}

function addFixture(f) {
  const row = byId.fixtures.get(f.id);
  if (!row?.model) return;
  const t = f.t ?? 1;
  const g = buildModel(row.model, { t });
  g.position.set(f.x, f.y ?? 0, f.z);
  g.rotation.y = -(f.rot ?? 0) * DEG;
  if (row.emits) addLamp(row, f.x, f.y ?? 0, f.z, (f.y ?? 0) > 1.5);

  if (f.goods) {
    const item = byId.items.get(f.goods);
    const surfaces = surfacesAt(row.model, t);
    if (item?.model && surfaces?.length) {
      g.add(markKeep(buildShelfGoods(item.model, f.qty ?? 8, surfaces, Math.round((f.qty ?? 8) * 1.15))));
    }
  }
  if (f.crop) {
    const crop = byId.crops.get(f.crop);
    // A crop's model is STAGES, so `t` is how grown it is — which is the same
    // 0..1 a tier is, resolved by the same function. See `shared/model.js`.
    if (crop?.model) {
      const c = buildModel(crop.model, { t: f.grow ?? 1 });
      c.position.y = 0.06;
      g.add(markKeep(c));
    }
  }
  world.add(g);
}

/**
 * THINGS THAT MAY NOT BE STYLISED — the goods, the crops and the people.
 *
 * Colour is not decoration on a shelf, it is the READOUT: apples, carrots and
 * frozen pizza are told apart across the room by being different colours, and
 * a style that snaps the shop to five inks turns every board into the same
 * terracotta lump. That is not an ugly shop, it is an unplayable one — so the
 * wash and the ink lock stop at the goods, and what the building gets is a
 * treatment the stock then pops off.
 *
 * Marked per MESH rather than per group, because `restyle` walks meshes and
 * asking each one about its ancestors every rebuild is the same answer worked
 * out again for every box on every shelf.
 */
function markKeep(group) {
  group.traverse((o) => { if (o.isMesh) o.userData.keepColour = true; });
  return group;
}

function addPerson(p) {
  const g = markKeep(buildCharacter(p.color, { look: p.look ?? null, variant: `${p.x}:${p.z}` }));
  g.position.set(p.x, 0, p.z);
  g.rotation.y = (p.face ?? 200) * DEG;
  world.add(g);
}

function buildSet(name) {
  // `disposeGroup` frees geometry and never a mesh material — which is right,
  // because those are `props.js`'s shared cache — but it has never heard of a
  // texture on one, and the ground carries a canvas of its own per build.
  world.traverse((o) => { if (o.userData.ground) o.material?.map?.dispose(); });
  disposeGroup(world);
  scene.remove(world);
  world = new THREE.Group();
  lamps = [];
  scene.add(world);

  const set = SETS[name] ?? SETS.aisle;
  if (S.ground) addGround(set.ground);
  addWalls(set.walls);

  if (set.grid) {
    const per = 8;
    const gap = 2.4;
    set.grid.forEach((id, n) => {
      const col = n % per;
      const rowN = Math.floor(n / per);
      addFixture({
        id,
        x: (col - (per - 1) / 2) * gap,
        z: (rowN - (Math.ceil(set.grid.length / per) - 1) / 2) * gap,
        rot: 0,
        t: 1,
      });
    });
  }
  for (const f of set.fixtures ?? []) addFixture(f);
  for (const c of set.ceiling ?? []) {
    addFixture({ ...c, y: c.y ?? CEILING_Y, rot: 0, t: 1 });
  }
  for (const p of set.people ?? []) addPerson(p);

  restyle();
  fitShadow();
}

/**
 * Shrink the shadow frustum onto what is actually in the set.
 *
 * The map is a fixed number of texels however much ground it is asked to cover,
 * so the span IS the resolution: at ±24 for a shop 12 across, three quarters of
 * every texel is spent on empty grass and the edges stair-step. Fitted to the
 * casters it is the same map over a third of the area, which is what makes a
 * hard-edged shadow read as CRISP rather than as pixelated — and a cel look
 * wants hard edges, so softening it would have been fixing the wrong thing.
 *
 * The ground is excluded deliberately: it is 48 units across, casts nothing,
 * and including it would put the span straight back where it started.
 */
const shadowAt = new THREE.Vector3();
function fitShadow() {
  world.updateMatrixWorld(true);
  let r = 4;
  world.traverse((o) => {
    if (!o.isMesh || o.userData.ground || !o.castShadow) return;
    o.getWorldPosition(shadowAt);
    r = Math.max(r, Math.hypot(shadowAt.x, shadowAt.z) + 1.5);
  });
  r = Math.min(r, 30);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r });
  sun.shadow.camera.updateProjectionMatrix();
}

/* ------------------------------------------------------------- the restyle - */

const gradients = new Map();
/**
 * A toon ramp: N hard steps, sampled with no filtering so they stay hard.
 *
 * `floor` is how dark the bottom step is, and it is the difference between a
 * shaded object and a SHADOW BLOCK. A ramp running to zero gives a shadow that
 * is the object's own colour turned down — brown shelving in dark brown — which
 * is shading. A manga panel does not shade, it fills: the dark step wants to be
 * near-black regardless of what colour the thing is, so the block reads as ink
 * rather than as the same object in worse light.
 */
function gradientMap(bands, floor = 0) {
  const n = Math.max(2, Math.round(bands));
  const key = `${n}@${floor.toFixed(2)}`;
  let t = gradients.get(key);
  if (t) return t;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Math.round((floor + (1 - floor) * (i / (n - 1))) * 255);
  }
  t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  // One byte per texel against a default alignment of four: without this a ramp
  // whose band count is not a multiple of four is read off the wrong stride and
  // the bands come out uneven, which reads as a badly chosen ramp.
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  gradients.set(key, t);
  return t;
}

const derived = new Map();

/**
 * One lab material per (source material × style), never a write into a source.
 *
 * A source that is already `MeshBasicMaterial` is something the art declared
 * `glow` — a lamp lens, a sign face, a neon tube — and it is the ONE thing that
 * must not be re-shaded by any of this: shading a light source is what makes a
 * lit sign go grey the moment you turn the sun down. It keeps its own colour
 * and takes the neon boost instead, which is what pushes it past white so the
 * bright-pass has something to find.
 */
/**
 * The alpha a PROTECTED surface writes, so the composite can find it again.
 *
 * The ink lock is screen space — it reads a pixel and knows nothing about what
 * drew it — so the goods have to leave a mark in the frame itself. Alpha is
 * free: an opaque material writes `opacity` straight into the buffer with
 * blending off, so a sentinel there costs no extra pass, no second target and
 * not one line of shader. Glass is the only thing that muddies it (it blends,
 * so its alpha lands somewhere between), and a window is not stock.
 */
const PROTECT_ALPHA = 0.25;

function styleMaterial(src, key, keep) {
  const id = `${src.uuid}|${key}|${keep ? 'k' : ''}`;
  let m = derived.get(id);
  if (m) return m;

  const common = {
    vertexColors: src.vertexColors,
    transparent: src.transparent,
    opacity: keep && !src.transparent ? PROTECT_ALPHA : src.opacity,
    depthWrite: src.depthWrite,
    side: src.side,
    map: src.map ?? null,
    fog: true,
  };
  const glow = src.type === 'MeshBasicMaterial';

  /**
   * THE PAPER. A matte white base with the colour washed out of it, which is
   * the half of the reference that is not the lines at all: the car is painted
   * flat white so that the drawn black is the only thing on it. Washed here
   * rather than in the grade, because a grade lifts the SHADOWS toward white
   * with everything else — and the shadow blocks are the drawing too.
   */
  const base = src.color.clone();
  if (!glow && !keep && S.wash > 0.001) base.lerp(new THREE.Color(S.washColor), S.wash);

  if (glow) {
    m = new THREE.MeshBasicMaterial({
      ...common,
      color: src.color.clone().multiplyScalar(S.glowBoost),
      fog: false,
    });
  } else if (S.shading === 'unlit') {
    m = new THREE.MeshBasicMaterial({ ...common, color: base });
  } else if (S.shading === 'toon') {
    // No `flatShading` on the toon one — three has no such property on it and
    // says so, once per material, which is two hundred lines of console for a
    // setting that was never read. It costs nothing anyway: every primitive in
    // `GEO` is a box or a cylinder with split normals, so the facets are in the
    // geometry rather than in the shader.
    m = new THREE.MeshToonMaterial({
      ...common,
      color: base,
      gradientMap: gradientMap(S.bands, S.shadowFloor),
    });
  } else {
    m = new THREE.MeshLambertMaterial({
      ...common,
      color: base,
      flatShading: src.flatShading,
    });
  }
  derived.set(id, m);
  return m;
}

function restyle() {
  const key = `${S.shading}|${S.bands}|${S.glowBoost}|${S.wash}|${S.washColor}|${S.shadowFloor}`;
  world.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.srcMat) o.userData.srcMat = o.material;
    o.material = styleMaterial(o.userData.srcMat, key, S.protectGoods && o.userData.keepColour === true);
    if (o.userData.ground) {
      o.receiveShadow = S.shadows;
      o.castShadow = false;
    } else {
      o.receiveShadow = S.shadows && S.receive;
      // Glass still casts nothing, which is `buildModel`'s rule and not this
      // file's — read off the material rather than re-derived, or the lab
      // disagrees with the game about the one thing it is meant to show.
      o.castShadow = S.shadows && !(o.userData.srcMat.transparent && o.userData.srcMat.opacity < 1);
    }
  });
}

/* ------------------------------------------------------------------ frame -- */

function poseCamera(w, h) {
  const aspect = w / h;
  const viewH = 16 / Math.max(0.05, S.zoom);
  camera.left = (-viewH * aspect) / 2;
  camera.right = (viewH * aspect) / 2;
  camera.top = viewH / 2;
  camera.bottom = -viewH / 2;
  const p = S.pitch * DEG;
  const y = S.yaw * DEG;
  const dist = 70;
  camera.position.set(
    Math.cos(p) * Math.sin(y) * dist,
    Math.sin(p) * dist,
    Math.cos(p) * Math.cos(y) * dist,
  );
  camera.lookAt(0, 0.9, 0);
  camera.updateProjectionMatrix();
}

let lastShadow = null;
function applyStyle() {
  ambient.intensity = S.ambient;
  ambient.color.set(S.ambientColor);
  sun.intensity = S.sun;
  sun.color.set(S.sunColor);
  sun.visible = S.sun > 0.001;
  sun.castShadow = S.shadows;
  bounce.intensity = S.bounce;
  bounce.color.set(S.bounceColor);

  const a = S.sunAngle * DEG;
  const hh = S.sunHeight * DEG;
  sun.position.set(Math.cos(hh) * Math.sin(a) * 60, Math.sin(hh) * 60, Math.cos(hh) * Math.cos(a) * 60);

  /**
   * ...and what colour they are.
   *
   * Every `emits` block in the catalog is warm — amber, candle, cool white —
   * because they were authored for a shop at dusk, and no amount of bloom turns
   * thirteen warm lamps into a neon street. Two tints ALTERNATING is the whole
   * trick: cyberpunk is a magenta and a cyan arguing, and one tint over every
   * lamp is a shop with a gel on it. Authored colours are untouched at 0, so
   * this is a look rather than an edit.
   */
  const tintA = new THREE.Color(S.lampA);
  const tintB = new THREE.Color(S.lampB);
  lamps.forEach((l, i) => {
    const e = l.userData.emits;
    l.intensity = S.lamps * e.intensity * e.range * e.range * 0.12;
    l.visible = S.lamps > 0.001;
    l.color.set(e.color ?? '#ffd7a1').lerp(i % 2 ? tintB : tintA, S.lampTint);
  });

  // Changing the shadow filter recompiles every program that samples it, and
  // three only notices if the materials are told. Guarded, or every frame is a
  // full shader rebuild — which reads as the lab being slow rather than as this
  // line being in the wrong place.
  const want = S.shadowHard ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  if (want !== lastShadow) {
    lastShadow = want;
    renderer.shadowMap.type = want;
    for (const m of derived.values()) m.needsUpdate = true;
  }

  scene.fog = S.fog > 0.001
    ? new THREE.Fog(new THREE.Color(S.fogColor), 30, 140 - S.fog * 100)
    : null;
}

let tick = 0;
function frame() {
  requestAnimationFrame(frame);
  tick++;
  if (S.spin) {
    S.yaw = (S.yaw + 0.18) % 360;
    // Not every frame: `sync` writes into every control in the rail, and doing
    // that sixty times a second to show a number nobody is reading is the one
    // thing in here that could make the lab feel slower than the game.
    if (tick % 20 === 0) railSync();
  }
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio())) renderer.setSize(w, h, false);
  poseCamera(w, h);
  applyStyle();
  hideNearWalls();
  pipeline.setSize(
    Math.floor(w * renderer.getPixelRatio()),
    Math.floor(h * renderer.getPixelRatio()),
    S.chunky,
  );
  pipeline.render(scene, camera, S);
}

/* --------------------------------------------------------------------- ui -- */

const railHost = document.getElementById('rail-body');
let railSync = () => {};

function usePreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  preset = name;
  // The whole state, not a patch onto whatever was there. A preset that only
  // wrote its own keys would carry the last one's ink threshold into this one
  // and the two would stop being comparable — which is the only thing a set of
  // presets is for.
  const ground = S.ground;
  Object.assign(S, DEFAULTS, p.patch, SETS[setName]?.camera ?? {}, { ground });
  document.getElementById('note').textContent = p.note;
  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.k === name);
  paintSky();
  restyle();
  railSync();
  writeHash();
}

function useSet(name) {
  setName = name;
  const cam = SETS[name]?.camera;
  if (cam) Object.assign(S, cam);
  for (const b of document.querySelectorAll('.set')) b.classList.toggle('on', b.dataset.k === name);
  buildSet(name);
  railSync();
  writeHash();
}

/**
 * The whole look in the URL.
 *
 * Which makes a style something you can send somebody rather than something you
 * have to describe — and makes a reload keep what you were in the middle of,
 * which matters because tuning ink thresholds is twenty small moves and losing
 * them to a hot reload is how a lab stops being used.
 */
function writeHash() {
  const d = diff();
  const payload = { p: preset, s: setName, ...(Object.keys(d).length ? { d } : {}) };
  history.replaceState(null, '', `#${encodeURIComponent(JSON.stringify(payload))}`);
  document.getElementById('diff').textContent = Object.keys(d).length
    ? `${Object.keys(d).length} knobs off stock`
    : 'stock';
}

function readHash() {
  if (location.hash.length <= 1) return false;
  try {
    const raw = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (raw.s && SETS[raw.s]) setName = raw.s;
    if (raw.p && PRESETS[raw.p]) {
      preset = raw.p;
      Object.assign(S, DEFAULTS, PRESETS[raw.p].patch);
    }
    // The set's own framing goes on FIRST and the saved diff on top, so a link
    // that carries a camera keeps it and one that carries none — a hand-typed
    // `#{"p":"neon"}`, which is the useful shape — arrives framed rather than
    // at whatever the default happened to be.
    Object.assign(S, SETS[setName]?.camera ?? {});
    if (raw.d) Object.assign(S, raw.d);
    return true;
  } catch {
    return false;
  }
}

function mountChips() {
  const ph = document.getElementById('presets');
  for (const [k, v] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.k = k;
    b.textContent = v.label;
    b.onclick = () => usePreset(k);
    ph.append(b);
  }
  const sh = document.getElementById('sets');
  for (const [k, v] of Object.entries(SETS)) {
    const b = document.createElement('button');
    b.className = 'set';
    b.dataset.k = k;
    b.textContent = v.label;
    b.onclick = () => useSet(k);
    sh.append(b);
  }
}

function mountActions() {
  document.getElementById('shot').onclick = () => {
    const a = document.createElement('a');
    a.download = `sns-${preset}-${setName}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  document.getElementById('copy').onclick = async () => {
    const text = JSON.stringify({ preset, set: setName, patch: diff() }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById('copy').textContent = 'Copied';
      setTimeout(() => { document.getElementById('copy').textContent = 'Copy settings'; }, 1200);
    } catch {
      // A clipboard write needs a secure context, which a LAN dev URL is not.
      // Printing it is the fallback that always works.
      console.log(text);
      document.getElementById('copy').textContent = 'In console';
      setTimeout(() => { document.getElementById('copy').textContent = 'Copy settings'; }, 1600);
    }
  };
  document.getElementById('rail-toggle').onclick = () => {
    document.body.classList.toggle('rail-shut');
  };
}

/** Drag to turn, wheel to zoom. The two the sliders are worst at. */
function mountPointer() {
  let dragging = false;
  let px = 0;
  let py = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; px = e.clientX; py = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    S.yaw = (S.yaw - (e.clientX - px) * 0.35 + 360) % 360;
    S.pitch = Math.min(88, Math.max(8, S.pitch + (e.clientY - py) * 0.25));
    px = e.clientX; py = e.clientY;
    railSync();
  });
  const stop = () => { if (dragging) { dragging = false; writeHash(); } };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    S.zoom = Math.min(4, Math.max(0.35, S.zoom * (e.deltaY > 0 ? 0.92 : 1.087)));
    railSync();
  }, { passive: false });
}

/* ------------------------------------------------------------------- boot -- */

async function boot() {
  await loadContent();
  mountChips();
  mountActions();
  mountPointer();

  railSync = buildRail(railHost, CONTROLS, S, (key, value) => {
    S[key] = value;
    // A shading knob rebuilds the material map; everything else is a uniform,
    // and a uniform costs the frame it is read on.
    if (key === 'shading' || key === 'bands' || key === 'glowBoost'
      || key === 'shadows' || key === 'receive') restyle();
    if (key === 'ground') buildSet(setName);
    if (key === 'skyTop' || key === 'skyLow') paintSky();
    railSync();
    writeHash();
  });

  const restored = readHash();
  if (!restored) {
    Object.assign(S, DEFAULTS, PRESETS.stock.patch, SETS[setName].camera ?? {});
  }
  document.getElementById('note').textContent = PRESETS[preset]?.note ?? '';
  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.k === preset);
  for (const b of document.querySelectorAll('.set')) b.classList.toggle('on', b.dataset.k === setName);

  paintSky();
  buildSet(setName);
  railSync();
  writeHash();
  requestAnimationFrame(frame);

  // The same handle the game hangs `__sns` for, and for the same reason: the
  // fastest way to find out why a lab looks wrong is to read what it thinks it
  // was told, from the console, without adding a readout for it first.
  window.__lab = { S, scene, camera, renderer, pipeline, get world() { return world; }, lamps: () => lamps };
}

boot().catch((err) => {
  console.error(err);
  const n = document.getElementById('note');
  if (n) n.textContent = `Failed to start: ${err.message}`;
});
