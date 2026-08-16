/**
 * WHAT A PALETTE BUTTON SHOWS: the thing itself, drawn from the art the shop is
 * drawn from.
 *
 * Five floor designs wearing one grey glyph is the whole argument. A floor *is*
 * a look — that is the entire thing you are choosing between — and the palette
 * asked you to pick one by reading five names, which is a colour chart printed
 * in black and white. A catalogue anyone can add to has the same problem one
 * step further out: the day somebody authors a second shelf, two buttons say
 * "shelf" and show the same picture.
 *
 * So a button draws its own row. Ground pieces get a patch of their actual
 * cells run through `patternColor` — the function the ground itself uses, so a
 * restyled floor restyles its button and no second palette can drift from the
 * first. Anything with a model gets its boxes projected on the game's own
 * camera angle and lit by the game's own sun, both read off `scene.js` rather
 * than picked to look nice: a button drawn from another angle reads as a
 * different object, which is exactly the confusion it was meant to end.
 *
 * Wall, window, doorway, fence and gate own no row — the renderer builds them
 * from `EDGE_STYLE` — so their art is built from that same record. The shape is
 * this file's; every colour, height and thickness in it is not, which is the
 * half that could otherwise disagree with the shop.
 *
 * SVG rather than a canvas because the bar is assembled by innerHTML from
 * strings and an icon already *is* one: art costs the bar nothing but a longer
 * string, needs no lifecycle, and is sharp on any screen. Nothing here is ever
 * recomputed — the caches are keyed on the model and surface objects
 * themselves, so a catalogue reload hands over new objects and the old art
 * falls off the end with them, with no version to remember to bump.
 */

import { partsAt, variantModel } from '../shared/model.js';
import { FIXTURES } from '../shared/build.js';
import { PALETTE, TILE_STYLE, EDGE_STYLE, edgeBands, patternColor, shade } from './render/palette.js';

/**
 * The game's camera, as the two numbers a projection needs.
 *
 * `BASE_CAM_OFFSET` in scene.js is (20, 24, 20): a 45° yaw, and a pitch that
 * falls out of the same vector rather than being chosen. Kept as the offset and
 * reduced here so it stays recognisably the same three numbers.
 */
const CAM = [20, 24, 20];
const CAM_LEN = Math.hypot(...CAM);
const COS45 = Math.SQRT1_2;
const SIN_PITCH = CAM[1] / CAM_LEN;
const COS_PITCH = Math.hypot(CAM[0], CAM[2]) / CAM_LEN;
const TOWARD_CAM = CAM.map((v) => v / CAM_LEN);

/** The sun, from scene.js, for the same reason the camera is. */
const SUN = norm([26, 40, 14]);

/** World point to picture point. Y is down the screen, as SVG wants it. */
const project = (x, y, z) => [
  (x - z) * COS45,
  (x + z) * COS45 * SIN_PITCH - y * COS_PITCH,
];

/**
 * How a face of a given normal is shaded.
 *
 * One lambert term rather than a table of three, because a model may be turned
 * to any angle and a cylinder has ten sides. The range is chosen so the top of
 * an unturned box comes out at the authored colour and the side facing away
 * from the sun at about two thirds of it — enough for a 34px picture to read as
 * solid, short of the contrast that makes small art look like a logo.
 */
const lit = (color, n) => shade(color, -0.34 + 0.42 * Math.max(0, dot(n, SUN)));

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
}

/** Hex for a colour that may have arrived as a packed number (`patternColor`). */
const hex = (c) => (typeof c === 'number' ? `#${(c >>> 0).toString(16).padStart(6, '0')}` : c);

// ---- the projector ---------------------------------------------------------

/**
 * A part's cross-section in plan, counter-clockwise seen from above.
 *
 * A box and a cylinder differ only here, which is why there is one drawing path
 * and not two: props.js builds a cylinder from a ten-sided geometry, so ten
 * sides is what a cylinder is in this game rather than an approximation of one.
 */
function ring(part) {
  const [sx, , sz] = part.scale ?? [1, 1, 1];
  const hx = sx / 2;
  const hz = sz / 2;
  if (part.shape !== 'cylinder') return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  return Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    return [Math.cos(a) * hx, Math.sin(a) * hz];
  });
}

/**
 * Every visible face of one part, as picture-space polygons.
 *
 * Sides are kept only when they face the camera, which is what stops a
 * ten-sided cylinder drawing ten quads and hiding its own front behind its
 * back. The bottom is never kept: the camera is above everything.
 */
function facesOf(part) {
  const [px, py, pz] = part.pos ?? [0, 0, 0];
  const height = (part.scale ?? [1, 1, 1])[1];
  const rot = ((part.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // The same turn props.js gives the mesh (`rotation.y`), so a sign leant on a
  // 22° angle leans the same way on its button.
  const plan = ring(part).map(([x, z]) => [px + x * cos + z * sin, pz - x * sin + z * cos]);
  const y0 = py - height / 2;
  const y1 = py + height / 2;
  const color = part.color ?? '#c8c0b4';
  const alpha = part.alpha ?? 1;
  const out = [];

  for (let i = 0; i < plan.length; i++) {
    const [ax, az] = plan[i];
    const [bx, bz] = plan[(i + 1) % plan.length];
    // Outward normal of a counter-clockwise edge, in plan.
    const n = norm([bz - az, 0, -(bx - ax)]);
    if (dot(n, TOWARD_CAM) <= 0) continue;
    out.push({
      pts: [project(ax, y0, az), project(ax, y1, az), project(bx, y1, bz), project(bx, y0, bz)],
      fill: lit(color, n),
      alpha,
      // Depth is taken at the face rather than the part, so a tall unit's front
      // panel sorts in front of its own back panel.
      depth: dot([(ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2], TOWARD_CAM),
    });
  }

  out.push({
    pts: plan.map(([x, z]) => project(x, y1, z)),
    fill: lit(color, [0, 1, 0]),
    alpha,
    depth: dot([px, y1, pz], TOWARD_CAM),
  });
  return out;
}

/**
 * Parts to a finished picture.
 *
 * Painter's algorithm on face depth. It is not a z-buffer and it will get a
 * pathological model wrong; at 34 pixels that is a trade rather than a bug, and
 * the alternative is a WebGL context per button.
 *
 * The view box is fitted to what was actually drawn rather than to the tile,
 * because a palette wants every entry the same *size* — a rug that honoured its
 * real scale next to a shelf would be four pixels of nothing.
 */
function draw(parts, { shadow = true } = {}) {
  const faces = parts.flatMap(facesOf).sort((a, b) => a.depth - b.depth);
  if (!faces.length) return null;

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const f of faces) {
    for (const [x, y] of f.pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // What it stands on, and the cheapest 3D there is: without it a thumbnail
  // floats in the middle of the button like a sticker.
  let under = '';
  if (shadow) {
    const foot = footprint(parts);
    if (foot) {
      // At the model's own underside, not at y=0. A ceiling prop is authored
      // hanging *below* its anchor, so a shadow pinned to zero lands above the
      // lamp — which reads as a stain on the ceiling rather than as the ground.
      const [cx, cy] = project(foot.x, foot.y, foot.z);
      const rx = foot.r;
      under = `<ellipse cx="${r3(cx)}" cy="${r3(cy)}" rx="${r3(rx)}" ry="${r3(rx * SIN_PITCH)}"
        fill="#3a3128" opacity=".15"/>`;
      minX = Math.min(minX, cx - rx);
      maxX = Math.max(maxX, cx + rx);
      maxY = Math.max(maxY, cy + rx * SIN_PITCH);
    }
  }

  const pad = Math.max(maxX - minX, maxY - minY) * 0.06;
  const w = (maxX - minX) + pad * 2;
  const h = (maxY - minY) + pad * 2;
  const body = faces.map((f) => `<polygon points="${f.pts.map(([x, y]) => `${r3(x)},${r3(y)}`).join(' ')}"
    fill="${f.fill}"${f.alpha < 1 ? ` opacity="${r3(f.alpha)}"` : ''}/>`).join('');

  return `<svg viewBox="${r3(minX - pad)} ${r3(minY - pad)} ${r3(w)} ${r3(h)}"
    preserveAspectRatio="xMidYMid meet" aria-hidden="true">${under}${body}</svg>`;
}

/** Where a model sits, and how wide, for its shadow. */
function footprint(parts) {
  let minX = Infinity; let minZ = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxZ = -Infinity;
  for (const p of parts) {
    const [px, py, pz] = p.pos ?? [0, 0, 0];
    const [sx, sy, sz] = p.scale ?? [1, 1, 1];
    minX = Math.min(minX, px - sx / 2);
    maxX = Math.max(maxX, px + sx / 2);
    minZ = Math.min(minZ, pz - sz / 2);
    maxZ = Math.max(maxZ, pz + sz / 2);
    minY = Math.min(minY, py - sy / 2);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: (minX + maxX) / 2,
    y: Math.min(0, minY),
    z: (minZ + maxZ) / 2,
    r: Math.max(maxX - minX, maxZ - minZ) * 0.44,
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;

// ---- what each kind of palette entry is ------------------------------------

const modelArt = new WeakMap();
const pieceArt = new WeakMap();
const groundArt = new WeakMap();
const edgeArt = new Map();

/**
 * A model's art, at the tier you get for buying one.
 *
 * `partsAt(model, 0)` rather than 1: a staged model's last stage is what the
 * thing becomes after you have paid to upgrade it twice, and a button that
 * advertises the chrome freezer while selling the battered one is lying about
 * the price underneath it.
 */
export function artForModel(model) {
  if (!model) return null;
  if (modelArt.has(model)) return modelArt.get(model);
  const art = draw(partsAt(model, 0));
  modelArt.set(model, art);
  return art;
}

/**
 * A catalog row's art: its model, standing on the tile its kind lays.
 *
 * A plot is why this is not just `artForModel`. Its model is one edging board,
 * because the bed itself is a *tile* — `FIXTURES.plot.ground` — and `syncPlots`
 * lays the earth. Drawn as a model alone the button is a stick on a shadow, and
 * a stick is not a thing anybody would press to dig a bed. So a kind that lays
 * ground gets that ground under it, in the colour `TILE_STYLE` gives it, which
 * is the same square the shop draws.
 */
export function artForPiece(row, kind) {
  if (!row?.model) return null;
  if (pieceArt.has(row)) return pieceArt.get(row);
  const ground = FIXTURES[kind]?.ground;
  const base = ground == null ? [] : [{
    shape: 'box',
    color: TILE_STYLE[ground]?.color ?? PALETTE.soilRough,
    pos: [0, -0.04, 0],
    scale: [1, 0.08, 1],
  }];
  const art = draw([...base, ...partsAt(row.model, 0)]);
  pieceArt.set(row, art);
  return art;
}

/**
 * A ground design's art: a patch of the floor it lays, cell by cell.
 *
 * Three by three because that is the smallest patch that can show a pattern
 * *repeating* — one cell of a checker is a square, and planks step every third
 * row (`patternColor`), so a two-cell swatch of Pine Boards and one of Slate
 * Flags can come out identical.
 */
export function artForGround(surface) {
  if (!surface) return null;
  if (groundArt.has(surface)) return groundArt.get(surface);
  const poly = (pts, fill) => `<polygon points="${pts.map(([px, py]) => `${r3(px)},${r3(py)}`)
    .join(' ')}" fill="${fill}"/>`;

  // The two sides of the slab that face you. Ground with no thickness draws as a
  // lozenge — true to what a floor is and wrong about what it looks like, since
  // every floor in the shop is seen against something standing on it. An eighth
  // of a tile is enough to read as a cut sample of the stuff.
  const D = 0.34;
  const R = 1.5;
  const sides = [
    poly([project(R, 0, -R), project(R, 0, R), project(R, -D, R), project(R, -D, -R)],
      lit(surface.color, [1, 0, 0])),
    poly([project(-R, 0, R), project(R, 0, R), project(R, -D, R), project(-R, -D, R)],
      lit(surface.color, [0, 0, 1])),
  ];

  const cells = [];
  for (let z = 0; z < 3; z++) {
    for (let x = 0; x < 3; x++) {
      cells.push(poly(
        [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]].map(([cx, cz]) => project(cx - R, 0, cz - R)),
        hex(patternColor(surface, x, z)),
      ));
    }
  }

  const w = 3 * COS45;
  const top = 3 * COS45 * SIN_PITCH;
  const bot = top + D * COS_PITCH;
  const art = `<svg viewBox="${r3(-w - 0.06)} ${r3(-top - 0.06)} ${r3(w * 2 + 0.12)} ${r3(top + bot + 0.12)}"
    preserveAspectRatio="xMidYMid meet" aria-hidden="true">${cells.join('')}${sides.join('')}</svg>`;
  groundArt.set(surface, art);
  return art;
}

/**
 * Grass, for the brush that takes a floor back up.
 *
 * Its own entry rather than a glyph because it is the same *choice* as the five
 * beside it — what the ground will look like afterwards — and answering four
 * swatches with a dustbin makes taking a floor up look like a different kind of
 * verb than laying one.
 */
export function artForBareGround() {
  return artForGround(BARE);
}
const BARE = { color: PALETTE.grass, accent: PALETTE.grassAlt, pattern: 'checker' };

/**
 * A wall, window, doorway, fence or gate — the thing itself, in a bit of the
 * wall it goes in.
 *
 * Every box comes from `edgeBands`, the function the renderer builds the real
 * edge from, so this cannot draw a window the game does not build. It was a
 * hand-drawn lookalike for about ten minutes, and the lookalike was *wrong*: it
 * gave a window a blue pane and a fence a pair of rails, where the game glazes
 * with the wall's own colour at a third opacity and builds a fence as a low
 * solid slab. Nobody would ever have caught it, which is the point — you do not
 * hold a 38px button up against a wall across the room.
 *
 * What this adds is the context, and an opening needs it to be a picture at
 * all: a doorway on its own *is* a lintel floating over a threshold, and only
 * the wall either side makes that a way through rather than a bench. The
 * neighbours are this same style with its opening filled in — `{...style,
 * opening: false, glass: false}` is by construction the plain wall it would sit
 * in, so there is no table of which piece pairs with which.
 */
export function artForEdge(edge) {
  if (edge === undefined || edge === null) return null;
  if (edgeArt.has(edge)) return edgeArt.get(edge);
  const style = EDGE_STYLE[edge];
  const art = style ? draw(edgeParts(style), { shadow: false }) : null;
  edgeArt.set(edge, art);
  return art;
}

/** One cell of edge at `x`, `w` wide, as boxes. */
function edgeRun(style, x, w) {
  return edgeBands(style).map((b) => ({
    shape: 'box',
    color: style.color,
    alpha: b.alpha,
    pos: [x, (b.y0 + b.y1) / 2, 0],
    scale: [w, Math.max(0.02, b.y1 - b.y0), style.t],
  }));
}

function edgeParts(style) {
  // Stubs rather than whole cells either side: enough wall to say "in a wall",
  // not so much that fitting three tiles into a button shrinks the piece you
  // are actually buying to a third of it.
  const STUB = 0.55;
  const at = (1 + STUB) / 2;
  const plain = { ...style, opening: false, glass: false };
  const parts = [
    ...edgeRun(plain, -at, STUB),
    ...edgeRun(style, 0, 1),
    ...edgeRun(plain, at, STUB),
  ];
  // The coping the renderer lays along the top of every capped run, which is
  // most of what makes a wall read as built rather than as a coloured slab —
  // at 38px more than at full size.
  if (style.top) {
    parts.push({
      shape: 'box', color: style.top,
      pos: [0, style.h + 0.035, 0], scale: [1 + STUB * 2, 0.07, style.t + 0.06],
    });
  }
  return parts;
}

/**
 * The art for one palette entry, or null for an entry that is a verb.
 *
 * Demolish is the verb: it is not a thing you are putting down, so a picture of
 * one would be a lie about what tapping it does. Its glyph stays.
 */
export function artForTool(t, row) {
  if (t.demolish) return null;
  if (t.paint) return row?.surface ? artForGround(row.surface) : artForBareGround();
  return artForPiece(row, t.kind) ?? artForEdge(t.edge);
}

/** A shape chip's picture, for the row that picks between them. */
export function artForVariant(v) {
  return artForModel(v?.model);
}

/**
 * One appliance, which is a *variant* of the single `station` row.
 *
 * `Scene.fixtureModel` resolves a machine the same way — `variantModel(piece,
 * f.station)` — because an appliance is one kind with one tier ladder wearing
 * seven looks, which is the whole variant bargain. Reading it the same way here
 * is the difference between a palette of seven distinct machines and one that
 * shows the same grey box seven times, and the grey box would have looked like
 * a missing-art problem rather than a lookup that stopped one step short.
 */
export function artForStation(row, station) {
  if (!row) return null;
  return artForModel(variantModel(row, station));
}
