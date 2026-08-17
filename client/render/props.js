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
import { partsAt, seamStep, skinnedParts, FRONT_LIP } from '../../shared/model.js';
import { FACE_CALM, VEHICLE_LOOK } from './palette.js';
import { signed } from '../money.js';

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

  for (const part of parts) {
    // A seam exists to close the end of a unit, and there is no end to close
    // where the next one along carries straight on. Dropping the panel is the
    // whole difference between a row of wall units and one long shelf.
    const seam = abuts && seamStep(part);
    if (seam && abuts(seam)) continue;

    const geo = GEO[part.shape] ?? GEO.box;
    const alpha = (part.alpha ?? 1) * ghost;
    const mesh = new THREE.Mesh(geo, material(part.color, alpha));
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
    group.add(mesh);
    if (part.motion) {
      group.userData.moving.push({
        mesh,
        motion: part.motion,
        // Where it was drawn, so the animator has somewhere to put it back and
        // a machine that stops stops in the pose it was authored in.
        pos: mesh.position.clone(),
        rot: mesh.rotation.y,
        scale: mesh.scale.clone(),
        // Spread, so the three moving parts of one machine don't beat in
        // lockstep — the same trick the puffs and the angry shoppers use.
        phase: group.userData.moving.length * 0.41,
      });
    }
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

  const head = new THREE.Mesh(GEO.sphere, material(FACE_CALM));
  head.scale.set(0.3, 0.3, 0.3);
  head.position.y = 0.66;
  head.castShadow = true;
  g.add(head);
  // Named rather than found by index: whether there's a hat moves every child
  // after the body, so `children[1]` is only the head by luck.
  g.userData.head = head;

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

/** Slots across one shelf board. Three reads as a row of goods, not a pair. */
const PER_ROW = 3;

/**
 * And rows back into it. A board is most of a tile deep and was using a
 * fourteenth of that, because one row is all a unit holding one thing ever
 * needed. Depth is what lets the picture keep the promise below: a shelf
 * kept for one kind gets three boards, and `3 × 3 × 2` is eighteen, which is
 * more than any shipped item's stack. So sixteen carrots draw sixteen carrots
 * rather than a ceiling, and the number in the menu is a thing you can count.
 */
const PER_DEEP = 2;

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
    one.scale.setScalar(0.6);
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
 */
const CRATE = 0.6;
const CRATE_H = 0.26;
const CRATE_WALL = 0.055;

/** Top of the pallet boards — the floor the goods stand on. */
const CRATE_DECK = 0.05;

/**
 * How tall one crate stands, and therefore how far up the next one sits.
 *
 * Boards plus walls, so a stacked crate's own boards land exactly on the rim of
 * the one below with no gap and no overlap. Derived rather than typed, like
 * everything else off `CRATE`: a taller crate has to keep stacking.
 */
export const CRATE_STEP = CRATE_DECK + CRATE_H;

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
export function buildPallet(piles, { covered = false, cap = 6 } = {}) {
  const g = new THREE.Group();
  const qty = piles.reduce((n, p) => n + p.qty, 0);

  // Pallet boards.
  for (let i = 0; i < 3; i++) {
    const board = new THREE.Mesh(GEO.box, material('#8a6a44'));
    board.scale.set(CRATE, CRATE_DECK, CRATE * 0.26);
    board.position.set(0, CRATE_DECK / 2, (i - 1) * CRATE * 0.34);
    board.castShadow = true;
    g.add(board);
  }

  // Crate walls, open-topped so the goods read from above.
  const crateMat = material('#a8763f');
  const rim = (CRATE - CRATE_WALL) / 2;
  const wall = (sx, sz, px, pz) => {
    const m = new THREE.Mesh(GEO.box, crateMat);
    m.scale.set(sx, CRATE_H, sz);
    m.position.set(px, CRATE_DECK + CRATE_H / 2, pz);
    m.castShadow = true;
    g.add(m);
  };
  wall(CRATE, CRATE_WALL, 0, -rim);
  wall(CRATE, CRATE_WALL, 0, rim);
  wall(CRATE_WALL, CRATE, -rim, 0);
  wall(CRATE_WALL, CRATE, rim, 0);

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
  // A covered crate has to NAME what is in it, because the box on top is a lid
  // in every sense but the word and the sample below is invisible. With more
  // than one pile there is no single name, so it says how many kinds instead —
  // which is the fact the samples would have carried.
  const said = piles.length > 1
    ? `${qty}x, ${piles.length} kinds`
    : (piles[0]?.name ? `${qty}x ${piles[0].name}` : `x${qty}`);
  const label = covered
    ? buildTextSprite(said, { fill: '#ffe9b8', scale: 0.62 })
    : buildTextSprite(`x${qty}`, { fill: '#ffe9b8', scale: 0.7 });
  label.position.y = covered ? CRATE_DECK + CRATE_H / 2 : 0.78;
  g.add(label);

  return g;
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

/** One pad — an ingredient bay or the outlet — with its pile stood on it. */
function buildBay(model, { solid, ghost, colour }) {
  const g = new THREE.Group();

  const pad = new THREE.Mesh(GEO.cylinder, material(colour));
  pad.scale.set(0.3, 0.04, 0.3);
  g.add(pad);

  if (!model) return g;
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
    one.scale.setScalar(BAY_ITEM);
    // Piled UP rather than spread out, because the bays sit a third of a tile
    // apart on the machine's own top and a row would run into its neighbour.
    // Height is also the reading you can take across the shop: two of three is
    // a short stack with a gap over it.
    one.position.set(0, 0.06 + i * BAY_STEP, 0);
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
export function buildStationBays({ intakes = [], outlet = null, bounds, wells = [] }) {
  const g = new THREE.Group();
  const b = bounds ?? { minX: -0.35, maxX: 0.35, minZ: -0.35, maxZ: 0.35, top: 0.8 };
  // Far enough in that a pad overhangs nothing, and the two rows stay apart on
  // a machine barely two thirds of a tile deep.
  const INSET = 0.17;

  // Authored wells, front-most last — so the outlet is the one at the front and
  // everything behind it takes ingredients.
  const sorted = [...wells].sort((a, c) => a.x - c.x);
  const tray = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  const hopper = sorted.length > 1 ? sorted.slice(0, -1) : sorted;

  intakes.forEach((s, i) => {
    const bay = buildBay(s.model, {
      solid: Math.max(0, Math.min(s.held ?? 0, s.need ?? 1)),
      ghost: Math.max(0, (s.need ?? 1) - (s.held ?? 0)),
      colour: (s.held ?? 0) >= (s.need ?? 1) ? BAY_LOOK.ready : BAY_LOOK.short,
    });
    // One well each where the art drew enough of them; otherwise they share the
    // one well (or the roof), spread along whichever way it is longer.
    const w = hopper.length ? hopper[Math.min(i, hopper.length - 1)] : null;
    const share = hopper.length ? intakes.length - hopper.length + 1 : intakes.length;
    const n = hopper.length ? Math.max(0, i - hopper.length + 1) : i;
    const run = w ? Math.max(w.span, w.depth) : (b.maxZ - b.minZ);
    const pitch = Math.min(0.34, run / Math.max(1, share));
    const off = (n - (share - 1) / 2) * pitch;
    bay.position.set(
      w ? w.x : b.minX + INSET,
      (w ? w.y : b.top) + 0.02,
      (w ? w.z : 0) + off,
    );
    g.add(bay);
  });

  const out = buildBay(outlet?.model ?? null, {
    solid: Math.max(0, Math.round(outlet?.qty ?? 0)),
    ghost: 0,
    colour: BAY_LOOK.outlet,
  });
  out.position.set(tray ? tray.x : b.maxX - INSET, (tray ? tray.y : b.top) + 0.02, tray ? tray.z : 0);
  g.add(out);

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
 * red. So: an open ring is somewhere a customer stands, and a ring with a post
 * standing in it is somewhere one of YOURS stands. The post is upright rather
 * than flat for the same reason: on a 45° camera a mark on the floor is read at
 * a glance and a thing standing up is read as a person.
 */
export function buildWorkSpot(role, at, colour = 0xffd66b) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthTest: false,
  });

  const pad = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.34, 18), mat);
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
export function buildFixtureGhost({ model, t = 1, rot = 0, height, verdict, spots }) {
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
    body.scale.set(0.94, h, 0.94);
    body.position.y = h / 2;
    g.add(body);
  }

  // A wireframe cage so the ghost doesn't dissolve into a pale shelf behind it.
  const cage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, h, 0.98)),
    new THREE.LineBasicMaterial({ color: c.cage, depthTest: false }),
  );
  cage.position.y = h / 2;
  cage.renderOrder = 11;
  g.add(cage);

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
export function buildCageMarker(mode = 'aim', size = { x: 1, y: 1, z: 1 }) {
  const g = new THREE.Group();
  const look = MARKER_LOOK[mode] ?? MARKER_LOOK.aim;
  g.userData.color = look.color;

  const t = 0.045;
  // A floor between the bar thickness and the box: a garland is a few
  // centimetres thick, and a cage thinner than its own bars is a solid lump.
  const hx = Math.max(size.x, t * 4) / 2;
  const hy = Math.max(size.y, t * 4) / 2;
  const hz = Math.max(size.z, t * 4) / 2;

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
  aim: { color: 0xffd66b, half: 0.45, band: 0.08, chevron: true },
  raze: { color: 0xe2564a, half: 0.45, band: 0.08, chevron: true },
  // The one whose menu is open. Cool, because it is not a verb — nothing is
  // about to happen to it, it is simply the thing you are reading about — and
  // pushed out to the tile edge, so the aim frame sits inside it.
  selected: { color: 0x5fd6c4, half: 0.5, band: 0.07, arm: 0.24, chevron: false },
  // "This would take what you are holding." The only one with no outline on
  // the ground, because it is the only one that appears in *numbers* — eight
  // of these at once, and eight squares painted on the floor is a shop you
  // cannot read. A chevron floats over the thing and stacks visually the way a
  // row of signposts does.
  stock: { color: 0x7cc46a, chevron: true, outline: false },
  // Somebody the pointer is over. Amber, because it is the same sentence the
  // aim frame says — "this is what you are pointing at" — and tighter, because
  // a person occupies about a third of a tile and a tile-sized frame under one
  // in an aisle rings the shelf behind them as well.
  person: { color: 0xffd66b, half: 0.34, band: 0.07, chevron: true },
  // One pile of goods on a unit that holds several. The same amber as the aim
  // frame, because it is the same sentence — and with no chevron, which is the
  // only thing separating the two: the arrow is drawn well clear of the box it
  // belongs to, and on a shelf that is over the *unit*, which is precisely the
  // answer a board marker is not giving. Nothing else about a cage cares.
  board: { color: 0xffd66b, chevron: false },
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
        color: look.color, transparent: true, opacity: 0.9,
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
      color: look.color, transparent: true, opacity: 0.95, depthTest: false,
    }));
    arrow.scale.set(0.26, 0.3, 0.26);
    arrow.rotation.x = Math.PI;
    arrow.renderOrder = 10;
    g.add(arrow);
    g.userData.arrow = arrow;
  }
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
  // Thin-walled, so scaling it up reads as a wave spreading rather than as a
  // disc growing. The geometry is unit-sized and the scale does the work —
  // which also means the wall thickness is a *proportion*, so shrinking the
  // ripple thins the line by the same factor. This is 0.28 of the radius
  // rather than 0.14 because the ripple was halved after it was first drawn,
  // and halving it again in weight turned "smaller" into "fainter".
  return groundFlash(new THREE.RingGeometry(0.72, 1, 40), color);
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

/** The drawing itself, so building one and rewriting one cannot drift apart. */
function paintText(ctx, canvas, text, fill) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Shrunk to fit rather than clipped. The canvas is a fixed size and the
  // sprite is a fixed shape, so a string longer than "x12" — a crate naming
  // what is in it — used to run off both ends and lose its first and last
  // letters. A smaller word is readable; half a word is not.
  const MAX_W = canvas.width - 20;
  let px = 58;
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  const wide = ctx.measureText(text).width;
  if (wide > MAX_W) {
    px = Math.max(18, Math.floor(px * (MAX_W / wide)));
    ctx.font = `bold ${px}px system-ui, sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Outline first so the number stays readable against grass or floorboards.
  ctx.lineWidth = Math.max(4, px / 5.8);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(text, 128, 50);
  ctx.fillStyle = fill;
  ctx.fillText(text, 128, 50);
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
      const rec = byMaterial.get(o.material);
      const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      // Shadow flags come off the source rather than being assumed. Everything
      // grouped here shares a material, and a material is a colour and an
      // alpha — so glass, which casts no shadow, is always in a group of its
      // own and can never be welded into something that does.
      // The one seam in that, since `shadow` made casting a per-part choice: two
      // parts of the SAME colour and alpha that disagree about it weld together
      // and take the first one's answer. Give one of them its own shade if that
      // ever matters — a material is the only thing a merge can tell apart.
      if (rec) rec.parts.push(g);
      else byMaterial.set(o.material, { parts: [g], cast: o.castShadow, receive: o.receiveShadow });
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
  for (const [mat, { parts, cast, receive }] of byMaterial) {
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
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    out.add(mesh);
  }
  for (const s of loose) out.add(s);
  return out;
}

/** Free the GPU memory a prop group holds. Materials are shared — don't dispose those. */
export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh && o.geometry && !Object.values(GEO).includes(o.geometry)) {
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
