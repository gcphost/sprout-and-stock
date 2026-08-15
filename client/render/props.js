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
import { partsAt } from '../../shared/model.js';

/** One shared geometry per primitive shape — never allocate these per prop. */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 7),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  capsule: new THREE.CapsuleGeometry(0.4, 0.6, 3, 10),
};

const materialCache = new Map();

/**
 * Flat-shaded material, cached by colour so a hundred tomatoes share one.
 *
 * `alpha` below 1 makes it glass. `depthWrite: false` is what stops a pane
 * writing depth over the goods behind it — the same trick the thought bubble
 * has always used, and without it a freezer door hides its own contents.
 */
export function material(color, alpha = 1) {
  const glass = alpha < 1;
  const key = glass ? `${color}@${alpha}` : String(color);
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color),
      flatShading: true,
      ...(glass ? { transparent: true, opacity: alpha, depthWrite: false } : {}),
    });
    materialCache.set(key, m);
  }
  return m;
}

/**
 * Build a prop from a validated `model` object: `{ parts: [{shape,color,pos,scale,rot}] }`,
 * or a staged one, in which case `t` (0..1) says how far along it is — growth
 * for a crop, tier for a fixture. See `shared/model.js`.
 *
 * Returns a Group positioned so its origin sits on the ground.
 */
export function buildModel(model, { castShadow = true, t = 1 } = {}) {
  const group = new THREE.Group();
  const parts = partsAt(model, t);
  if (!parts.length) return group;

  for (const part of parts) {
    const geo = GEO[part.shape] ?? GEO.box;
    const alpha = part.alpha ?? 1;
    const mesh = new THREE.Mesh(geo, material(part.color, alpha));
    const [sx, sy, sz] = part.scale ?? [0.3, 0.3, 0.3];
    const [px, py, pz] = part.pos ?? [0, 0, 0];
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    mesh.rotation.y = ((part.rot ?? 0) * Math.PI) / 180;
    // Glass casts no shadow. A door you can see through laying down a solid
    // black rectangle is the giveaway that it isn't really glass.
    mesh.castShadow = castShadow && alpha >= 1;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}

/**
 * A character: chunky capsule body, floating round head, no limbs.
 * Reads as friendly at this scale and costs three meshes.
 */
export function buildCharacter(color, { hat = null } = {}) {
  const g = new THREE.Group();

  const body = new THREE.Mesh(GEO.capsule, material(color));
  body.scale.set(0.34, 0.34, 0.34);
  body.position.y = 0.34;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(GEO.sphere, material('#f6efe2'));
  head.scale.set(0.3, 0.3, 0.3);
  head.position.y = 0.66;
  head.castShadow = true;
  g.add(head);

  if (hat) {
    const cap = new THREE.Mesh(GEO.cylinder, material(hat));
    cap.scale.set(0.32, 0.1, 0.32);
    cap.position.y = 0.78;
    cap.castShadow = true;
    g.add(cap);
  }

  // A nose-ish nub so you can tell which way someone is facing.
  const snout = new THREE.Mesh(GEO.box, material('#e8d9c4'));
  snout.scale.set(0.08, 0.08, 0.1);
  snout.position.set(0, 0.64, 0.16);
  g.add(snout);

  return g;
}

/**
 * The little floating bubble above a customer showing what they're after,
 * and above a player showing what they're carrying.
 */
export function buildBubble() {
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

  g.position.y = 1.32;
  return g;
}

let bubbleMat = null;
function bubbleMaterial() {
  if (!bubbleMat) {
    bubbleMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: 0.62,
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

/** Slots across one shelf row. Three reads as a row of goods, not a pair. */
const PER_ROW = 3;

/** Past this a shelf just reads as full — see `shelfSlots`. */
export const shelfSlots = (surfaces) => (surfaces?.length ?? 0) * PER_ROW;

/**
 * The same goods, but on a unit that has rows — the boards its model flagged as
 * `surface`, handed over by `surfacesAt`.
 *
 * **One prop per unit.** Four on the shelf draws four, which is the whole
 * reason a shelf is worth looking at from across the shop. It used to draw a
 * *fraction*: three facings on every row that `ceil(qty / capacity × rows)`
 * said was occupied, so one unit and three both came out as three, and four out
 * of twelve rounded up to a whole row of stock that wasn't there.
 *
 * Past `shelfSlots` it fills up and stops, the same concession a crowded plot
 * makes at `BED_MAX` — nine identical jars is already "lots".
 *
 * Two things here are the camera's doing rather than the shop's. Goods run
 * along the unit's WIDTH and stand at the front of the board, because a model
 * is authored facing east: its depth is x and its face is +x, and spreading
 * them along x files them nose-to-tail where the row above hides all but the
 * first. And they fill from the TOP row down — bottom-up is how a real shop
 * stocks and it is invisible here, because on a 45° camera each board covers
 * the one below it.
 */
export function buildShelfGoods(model, qty, surfaces) {
  const g = new THREE.Group();
  const show = Math.max(0, Math.min(Math.round(qty), shelfSlots(surfaces)));
  for (let n = 0; n < show; n++) {
    const s = surfaces[surfaces.length - 1 - Math.floor(n / PER_ROW)];
    // Goods run along whichever way the board is longer and stand at its
    // near edge on the other axis. Assuming width is always z held for as long
    // as every shelf was a straight one facing east — a corner unit's second
    // wing runs the other way, and would have filed its stock into the wall.
    const alongZ = s.depth >= s.span;
    const run = alongZ ? s.depth : s.span;
    const lip = (alongZ ? s.span : s.depth) * 0.14;
    const off = ((n % PER_ROW) - (PER_ROW - 1) / 2) * (run / (PER_ROW + 0.4));

    const one = buildModel(model);
    one.scale.setScalar(0.6);
    one.position.set(
      s.x + (alongZ ? lip : off),
      // A hair proud of the board, so a flat-bottomed item doesn't z-fight it.
      s.y + 0.005,
      s.z + (alongZ ? off : lip),
    );
    g.add(one);
  }
  return g;
}

/**
 * A pile of takings sitting on the counter, with the amount floating over it.
 * Money used to be a number that ticked up in the HUD — you never saw a sale
 * happen. Now it lands somewhere and somebody has to come and get it.
 */
export function buildCashDrop(amount) {
  const g = new THREE.Group();

  // A few banknotes, fanned so the pile reads at isometric distance.
  for (let i = 0; i < 3; i++) {
    const note = new THREE.Mesh(GEO.box, material(i === 1 ? '#7fbf6a' : '#9ad285'));
    note.scale.set(0.34, 0.045, 0.22);
    note.position.set((i - 1) * 0.07, 0.03 + i * 0.045, (i % 2) * 0.05);
    note.rotation.y = (i - 1) * 0.35;
    note.castShadow = true;
    g.add(note);
  }
  const coin = new THREE.Mesh(GEO.cylinder, material('#e8c455'));
  coin.scale.set(0.13, 0.04, 0.13);
  coin.position.set(0.12, 0.19, -0.08);
  coin.castShadow = true;
  g.add(coin);

  const label = buildMoneyLabel(amount);
  label.position.y = 0.62;
  g.add(label);

  g.userData.spin = coin;
  return g;
}

/**
 * A delivered pallet waiting at the bay: a crate, a sample of what's inside,
 * and how many are left to shift.
 */
export function buildPallet(model, qty) {
  const g = new THREE.Group();

  // Pallet boards.
  for (let i = 0; i < 3; i++) {
    const board = new THREE.Mesh(GEO.box, material('#8a6a44'));
    board.scale.set(0.86, 0.07, 0.2);
    board.position.set(0, 0.04, (i - 1) * 0.3);
    board.castShadow = true;
    g.add(board);
  }

  // Crate walls, open-topped so the goods read from above.
  const crateMat = material('#a8763f');
  const wall = (sx, sz, px, pz) => {
    const m = new THREE.Mesh(GEO.box, crateMat);
    m.scale.set(sx, 0.42, sz);
    m.position.set(px, 0.29, pz);
    m.castShadow = true;
    g.add(m);
  };
  wall(0.86, 0.08, 0, -0.39);
  wall(0.86, 0.08, 0, 0.39);
  wall(0.08, 0.86, -0.39, 0);
  wall(0.08, 0.86, 0.39, 0);

  if (model) {
    const rows = Math.min(3, Math.max(1, Math.ceil(qty / 6)));
    for (let i = 0; i < rows; i++) {
      const one = buildModel(model, { castShadow: false });
      one.scale.setScalar(0.6);
      one.position.set(((i % 2) - 0.5) * 0.24, 0.12 + i * 0.16, ((i % 3) - 1) * 0.16);
      g.add(one);
    }
  }

  const label = buildTextSprite(`x${qty}`, { fill: '#ffe9b8', scale: 0.7 });
  label.position.y = 1.0;
  g.add(label);

  return g;
}

/** `+$4.20` drawn to a canvas and hung in the air as a sprite. */
function buildMoneyLabel(amount) {
  return buildTextSprite(`+$${Number(amount).toFixed(2)}`, { fill: '#eafbe2' });
}

let ghostMat = null;
/**
 * A translucent preview of what you'd plant here. This is the actual UI for
 * choosing a seed — the plot shows the answer, so nothing has to pop up and
 * ask. Materials are swapped for one shared ghost material rather than tinting
 * the cached originals, which every other prop is still using.
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
 * What an appliance is short of, as a row of sockets to float above it.
 *
 * One socket per ingredient of the recipe it's working toward, each holding the
 * actual item: solid once the hopper has enough of it, and the same item as a
 * ghost of itself while it's still short. So a coffee machine showing a solid
 * bean and a ghost carton is one carton of milk away, and that reads from
 * across the shop without opening anything.
 *
 * Every socket keeps its pad whether it's filled or not — a missing ingredient
 * has to be an visibly *empty place*, not a faint smudge in mid-air, or the
 * thing you're looking for is the thing that's hardest to see.
 */
export function buildHopperSlots(slots, { ready = '#7cc46a', short = '#c8553d' } = {}) {
  const g = new THREE.Group();
  const PITCH = 0.44;

  slots.forEach((s, i) => {
    const socket = new THREE.Group();
    socket.position.x = (i - (slots.length - 1) / 2) * PITCH;

    const pad = new THREE.Mesh(GEO.cylinder, material(s.ready ? ready : short));
    pad.scale.set(0.36, 0.05, 0.36);
    socket.add(pad);

    if (s.model) {
      const icon = buildModel(s.model, { castShadow: false });
      // A missing ingredient fades but keeps its own colours. `buildGhost`'s one
      // white material is right for a seed preview, where you already know what
      // you picked — here the whole question is *which* thing is missing, and a
      // white blob answers "something". Tinting per part costs nothing: the
      // cache is keyed by colour and alpha, so the palette is reused too.
      if (!s.ready) {
        icon.traverse((o) => {
          if (o.isMesh) o.material = material(o.material.color.getHex(), 0.4);
        });
      }
      icon.scale.setScalar(0.42);
      icon.position.y = 0.1;
      socket.add(icon);
    }
    g.add(socket);
  });

  return g;
}

/**
 * What the soil in a plot looks like right now.
 *
 * Untilled ground has to read as *not ready* from across the farm, or the new
 * till step is just an invisible error message. So rough ground keeps its turf:
 * pale, scrubby, with weeds still standing on it. Turned earth is dark, damp,
 * and cut into furrows — the same shape a seed is about to go into.
 */
export function buildSoil(state, palette) {
  const g = new THREE.Group();
  const tilled = state === 'tilled';

  const bed = new THREE.Mesh(GEO.box, material(tilled ? palette.soilTilled : palette.soilRough));
  bed.scale.set(0.98, 0.06, 0.98);
  bed.position.y = 0.01;
  bed.receiveShadow = true;
  g.add(bed);

  if (tilled) {
    // Four furrows. Ridged earth is the universal shorthand for "sown-ready",
    // and it catches the low sun, so it separates from turf even in shadow.
    for (let i = 0; i < 4; i++) {
      const furrow = new THREE.Mesh(GEO.box, material(palette.soilFurrow));
      furrow.scale.set(0.84, 0.05, 0.1);
      furrow.position.set(0, 0.05, -0.3 + i * 0.2);
      g.add(furrow);
    }
  } else {
    // Tufts of grass that never got cleared, plus a stone or two.
    for (let i = 0; i < 5; i++) {
      const tuft = new THREE.Mesh(GEO.cone, material(palette.soilWeed));
      const a = (i / 5) * Math.PI * 2 + 0.7;
      tuft.scale.set(0.13, 0.2, 0.13);
      tuft.position.set(Math.cos(a) * 0.28, 0.12, Math.sin(a) * 0.28);
      tuft.castShadow = true;
      g.add(tuft);
    }
    const stone = new THREE.Mesh(GEO.sphere, material(palette.soilDark));
    stone.scale.set(0.14, 0.09, 0.12);
    stone.position.set(0.1, 0.06, -0.12);
    g.add(stone);
  }
  return g;
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

export function buildFixtureGhost(height, color, verdict, anchor) {
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
  const body = new THREE.Mesh(GEO.box, GHOST_MATS[key]);
  body.scale.set(0.94, h, 0.94);
  body.position.y = h / 2;
  g.add(body);

  // A wireframe cage so the ghost doesn't dissolve into a pale shelf behind it.
  const cage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, h, 0.98)),
    new THREE.LineBasicMaterial({ color: c.cage, depthTest: false }),
  );
  cage.position.y = h / 2;
  cage.renderOrder = 11;
  g.add(cage);

  if (anchor) {
    // The tile you'd work from — this is what rotation actually changes.
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.34, 18),
      new THREE.MeshBasicMaterial({
        color: c.pad, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthTest: false,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(anchor.dx, 0.1, anchor.dz);
    pad.renderOrder = 12;
    g.add(pad);
  }
  return g;
}

/**
 * The "you can do something to this" marker.
 *
 * Once actions need a deliberate hold, being in range stops being self-evident —
 * nothing happens, so without this the game just feels unresponsive. A ring on
 * the ground under the thing, plus a floating chevron, says *which* object your
 * hold would land on, which matters when a shelf, a till and a pallet are all
 * within arm's reach of each other.
 */
export function buildTargetMarker() {
  const g = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.66, 28),
    new THREE.MeshBasicMaterial({
      color: 0xffd66b, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.renderOrder = 9;
  g.add(ring);

  // A little downward chevron bobbing over the target.
  const arrow = new THREE.Mesh(GEO.cone, new THREE.MeshBasicMaterial({
    color: 0xffd66b, transparent: true, opacity: 0.95, depthTest: false,
  }));
  arrow.scale.set(0.26, 0.3, 0.26);
  arrow.rotation.x = Math.PI;
  arrow.renderOrder = 10;
  g.add(arrow);

  g.userData.ring = ring;
  g.userData.arrow = arrow;
  return g;
}

/**
 * A radial charge-up meter that floats over whoever is mid-action. Built from
 * a ring geometry whose sweep we rewrite each frame, so it reads as filling up
 * rather than just changing colour.
 */
export function buildProgressRing(color) {
  const g = new THREE.Group();

  const track = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.60, 32),
    new THREE.MeshBasicMaterial({
      color: 0x3a3128, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthTest: false,
    }),
  );
  const fill = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.60, 32, 1, Math.PI / 2, 0.001),
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
  return g;
}

/** Rewrite the ring's sweep. `t` is 0..1. */
export function setRingProgress(group, t) {
  const fill = group.userData.fill;
  if (!fill) return;
  const sweep = Math.max(0.001, Math.min(1, t) * Math.PI * 2);
  fill.geometry.dispose();
  // Sweep clockwise from the top, which is how every other progress ring reads.
  fill.geometry = new THREE.RingGeometry(0.42, 0.60, 32, 1, Math.PI / 2 - sweep, sweep);
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

/** Any short string, hung in the air so it stays readable over any background. */
export function buildTextSprite(text, { fill = '#ffffff', scale = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');

  ctx.font = 'bold 58px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Outline first so the number stays readable against grass or floorboards.
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(text, 128, 50);
  ctx.fillStyle = fill;
  ctx.fillText(text, 128, 50);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.scale.set(1.1 * scale, 0.41 * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Free the GPU memory a prop group holds. Materials are shared — don't dispose those. */
export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh && o.geometry && !Object.values(GEO).includes(o.geometry)) {
      o.geometry.dispose();
    }
  });
}
