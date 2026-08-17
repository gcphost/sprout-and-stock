/**
 * THE LOOK.
 *
 * Soft, saturated, flat-shaded pastels — the "tiny isometric shop" aesthetic.
 * Every colour in the game comes from here or from an item's own `model` JSON,
 * so changing the mood of the whole game is a one-file edit.
 */

import { T } from '../../shared/tiles.js';
import { E } from '../../shared/edges.js';

export const PALETTE = {
  grass: '#8ec96b',
  grassAlt: '#82bd60',
  soil: '#a8763f',
  soilDark: '#8d6234',
  /** Broken, workable soil — darker and damper than the rough ground. */
  soilTilled: '#7d5530',
  soilFurrow: '#6b4626',
  /** A plot nobody has turned over yet: scrubby, pale, still half turf. */
  soilRough: '#a89268',
  soilWeed: '#93b96a',
  /** The delivery pad: cool grey hardstanding, where the lorry drops an order. */
  bay: '#9aa79b',
  bayPlank: '#a8865c',
  /** The drop-off pad: warm timber decking, where you park an armful. The two
   *  sit in the same yard holding the same crates, so telling them apart at a
   *  glance is the entire reason there are two of them. */
  drop: '#c2a173',
  /** The break area: a soft indoor mat, warmer and quieter than either pad, so
   *  the one patch of ground that is for the staff rather than for the stock
   *  does not read as more yard. */
  break: '#b59ab8',
  /** The car park: cold tarmac, and the darkest ground in the game on purpose.
   *  It is the one piece of hardstanding a customer sees before the shop, so it
   *  should read as the front of the building rather than as more of the back
   *  of it — the two yard pads are deliberately warm and light. */
  park: '#79808c',
  /** The road: darker than the car park it leads to, because the lane is the
   *  thing you drive on and the pad is the thing you stand on. Near-neutral on
   *  purpose — it is the longest run of one colour anybody will paint, so a
   *  road with any character in it would read as a stripe across the map. */
  road: '#5f646d',
  /** Last-resort bodywork — see `VEHICLE_LOOK`. Nothing on the road normally
   *  wears it: a vehicle row carries its own `color`, and its `model` carries
   *  the colours that actually get drawn. */
  vehicle: '#c9d1d9',
  floor: '#f0ddb8',
  floorAlt: '#e8d2a8',
  wall: '#fbf8f0',
  wallTop: '#eae5d6',
  shelf: '#b8875a',
  shelfTop: '#a2764c',
  freezer: '#cfe6ea',
  counter: '#7fd4c8',
  station: '#9aa4b0',
  stationTop: '#cfd8e3',
  counterTop: '#66c2b5',
  path: '#d9cbb0',
  fence: '#c99a63',
  door: '#f6f3ea',
  // A rule painted across a threshold. What a signed way through gets instead of
  // its own geometry: a staff door and a doorway are the same hole in the same
  // wall, so the only honest difference is a marking on the floor of it — which
  // is what a real shop does about exactly this, and which reads from across the
  // room at this camera pitch where a plate on the lintel does not.
  markStaff: '#8d95a6',
  markIn: '#6fbf73',
  markOut: '#e8a44b',
  // The awning's two stripes used to live here, because the renderer drew the
  // shop front itself. They are on the `awning` catalog row now — a piece
  // carries its own colours, which is what lets there be a second design of one.
  sky: '#cfe9f5',

  // Open and close. The sun sits low and throws long warm light, so the sky
  // goes with it — brightness alone reads as "the monitor dimmed", where a
  // colour shift reads as evening.
  skyDusk: '#f7c9a2',
  /** Sun colour at noon and at the edges of the day. */
  sunHigh: '#fff4dd',
  sunDusk: '#ff9e5e',
  /** Ambient fill: warm and open at noon, cool and blue once the sun is down. */
  fillHigh: '#ffffff',
  fillDusk: '#8fa6c8',
};

/** Player colours, cycled by join order. */
export const PLAYER_COLORS = ['#5b8ff9', '#f2a03d', '#7cc46a', '#c98ad9'];

/**
 * Tile kind -> how it renders.
 * `h` is height in world units; 0 means "flat, draw on the ground".
 * The kind numbers themselves come from `shared/tiles.js`, which is the one
 * place the server, the build validator and this file all agree.
 */
export const TILE_STYLE = {
  [T.GRASS]: { color: PALETTE.grass, h: 0 },
  [T.FLOOR]: { color: PALETTE.floor, h: 0.06 },
  [T.WALL]: { color: PALETTE.wall, h: 1.1 },
  // The plot tile is only the bed. Whether it reads as rough turf or turned
  // earth is per-plot state, so the renderer lays that on top in syncPlots.
  [T.PLOT]: { color: PALETTE.soilRough, h: 0.08 },
  [T.DOOR]: { color: PALETTE.door, h: 0.06 },
  [T.PATH]: { color: PALETTE.path, h: 0.05 },
  [T.FENCE]: { color: PALETTE.fence, h: 0.45 },
  [T.BAY]: { color: PALETTE.bay, h: 0.07 },
  [T.DROP]: { color: PALETTE.drop, h: 0.07 },
  [T.BREAK]: { color: PALETTE.break, h: 0.07 },
  [T.PARK]: { color: PALETTE.park, h: 0.07 },
  // Flush with the grass rather than raised the 0.07 the pads are. A pad is a
  // platform you put things on and a road is ground you drive over, and a lip
  // along a lane that runs the width of the map would read as a kerb the van
  // climbs.
  [T.ROAD]: { color: PALETTE.road, h: 0.02 },
};

/**
 * What a fixture looks like when nobody has drawn one.
 *
 * These are the four tile styles that left `TILE_STYLE` when fixtures stopped
 * being tiles, kept to the colour and height they always were — so an unauthored
 * kind renders exactly as it used to rather than as nothing at all. Every kind
 * in the shipped catalog has a model, so in practice this is what a brand new
 * kind looks like on the day it becomes buildable and before anybody styles it.
 *
 * It is also what the build ghost is sized from, which is the more important
 * job: the ghost is a box saying "something lands here", and it should be the
 * size of the something.
 */
export const FIXTURE_LOOK = {
  shelf: { color: PALETTE.shelf, h: 0.75 },
  freezer: { color: PALETTE.freezer, h: 0.65 },
  checkout: { color: PALETTE.counter, h: 0.55 },
  station: { color: PALETTE.station, h: 0.7 },
  // A plot is the ground, so its own tile is the whole look and a block on top
  // would bury the soil. Zero height, and `syncPlots` draws the bed.
  plot: { color: PALETTE.soilRough, h: 0 },
  'prop-floor': { color: PALETTE.floor, h: 0.3 },
  'prop-ceiling': { color: PALETTE.floor, h: 0.3 },
};

/**
 * What a vehicle looks like when there is no art to draw.
 *
 * The same fallback `FIXTURE_LOOK` is, for the same reason — an invisible thing
 * is worse than a generic one — but it answers a different question, and the
 * difference is worth writing down. A fixture kind can genuinely have no model:
 * it becomes buildable before anyone styles it, and this is what it looks like
 * that day. A vehicle cannot, because `VehicleSchema` requires one. So this is
 * only ever reached two ways: the row was deleted out from under a van already
 * on the road, or somebody authored a stage with nothing in it. Both are the
 * case where a paid-for delivery arrives as *nothing at all*, which is
 * indistinguishable from a delivery that never came — and telling those apart
 * is the entire reason the van exists.
 *
 * Longer than it is wide, because that is the one thing true of a vehicle
 * before you know which one it is. A cube on the tarmac reads as a crate, and a
 * crate at the bay is a thing the game already draws and means something else by.
 *
 * The colour is the last resort of the last resort. A row that still exists
 * carries its own `color`, which is what "bodywork, where the model doesn't say
 * otherwise" means on the schema; this is for when even the row has gone.
 */
export const VEHICLE_LOOK = { color: PALETTE.vehicle, l: 1.4, w: 0.7, h: 0.6 };

/**
 * Edge kind -> how it renders.
 *
 * `t` is thickness across the boundary, in tiles. A wall is thin because it
 * sits *on* the line between two cells rather than filling one — which is where
 * the two tiles of shop floor per side came back from.
 */
/**
 * The two ways through, once each.
 *
 * Written down here rather than four times below because a signed doorway is the
 * same doorway — see `WAYS` in shared/edges.js. The only thing the signed ones
 * add is `mark`, and having them spread the base by hand is how you end up with
 * a staff door that stayed white when somebody restyled the wall.
 */
const EDGE_BASE = {
  // A doorway is a gap you can walk through: a header spanning the opening and
  // a threshold underfoot, with nothing in between.
  door: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, opening: true },
  gate: { color: PALETTE.fence, h: 0.5, t: 0.14, opening: true },
};

export const EDGE_STYLE = {
  [E.WALL]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17 },
  [E.WINDOW]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, glass: true },
  [E.DOOR]: EDGE_BASE.door,
  [E.GATE]: EDGE_BASE.gate,
  [E.FENCE]: { color: PALETTE.fence, h: 0.5, t: 0.14 },
  // The same hole in the same wall, with the threshold painted. `mark` is the
  // whole difference, and it is a difference you can SEE — the feature is
  // otherwise invisible in a screenshot, which is a fine thing to say about a
  // rule the sim obeys and a poor thing to say about a switch you flipped and
  // want to check. Derived off the base rather than written out, so restyling a
  // wall takes every signed door with it.
  [E.DOOR_STAFF]: { ...EDGE_BASE.door, mark: PALETTE.markStaff },
  [E.DOOR_IN]: { ...EDGE_BASE.door, mark: PALETTE.markIn },
  [E.DOOR_OUT]: { ...EDGE_BASE.door, mark: PALETTE.markOut },
  [E.GATE_STAFF]: { ...EDGE_BASE.gate, mark: PALETTE.markStaff },
};

/** How see-through a pane of glass is. Read by the geometry and the material. */
export const GLASS = 0.35;

/**
 * The stack of boxes one edge is built from, bottom to top.
 *
 * Lives here, beside the style it reads, because two things draw an edge now:
 * the shop, and the palette button offering to sell you one. A button that drew
 * its own idea of a window is a picture of a thing the game does not build —
 * and it would be a *convincing* picture, since nobody compares a 38px button
 * against a wall across the room. So the shape is derived once from the style
 * and both callers ask for it.
 *
 * `opening`, `glass` and `mark` stay the authored facts — "you can walk through
 * this", "you can see through this", "not everybody may" — and this is the one
 * place that turns any of them into geometry.
 */
export function edgeBands(style) {
  // A way through: a header across the top, a threshold underfoot, nothing in
  // between. A rule about who may use it rides on the threshold as a colour —
  // the band is the same band, so a signed door is the same geometry as a plain
  // one and nothing downstream had to learn a second shape.
  if (style.opening) {
    return [
      { y0: style.h - 0.16, y1: style.h },
      { y0: 0.02, y1: style.mark ? 0.07 : 0.05, color: style.mark },
    ];
  }
  // Glazed: sill, header, and a see-through band filling the gap.
  if (style.glass) {
    return [
      { y0: 0, y1: 0.34 },
      { y0: 0.9, y1: style.h },
      { y0: 0.34, y1: 0.9, alpha: GLASS },
    ];
  }
  return [{ y0: 0, y1: style.h }];
}

/**
 * Where a hanging prop hangs.
 *
 * Read off the wall rather than written down again, because a pendant an inch
 * above the wall top pokes through the roof of a building that has no roof —
 * which on a 45° camera reads as a lamp floating outside the shop. Derived, so
 * restyling a wall taller takes the ceiling with it.
 */
export const CEILING_Y = EDGE_STYLE[E.WALL].h;

/** Slightly vary a colour per tile so big flat areas don't look dead. */
export function jitter(hex, amount, seed) {
  const n = ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const d = (n - 0.5) * amount;
  const c = parseInt(hex.slice(1), 16);
  const r = clamp8(((c >> 16) & 255) + d * 255);
  const g = clamp8(((c >> 8) & 255) + d * 255);
  const b = clamp8((c & 255) + d * 255);
  return (r << 16) | (g << 8) | b;
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * What colour one cell of a laid floor is.
 *
 * A pattern here is per-cell colour and nothing else — no geometry, no second
 * mesh, no texture. That is not a shortcut: the ground is seen edge-on at 45°
 * with a shop standing on it, so a repeat finer than one tile is invisible from
 * anywhere you actually play, while a colour that alternates tile by tile reads
 * from across the room. It also costs nothing, because the ground loop already
 * writes a per-instance colour to jitter it.
 *
 * Every pattern still jitters, at a lower amount than bare ground: a floor
 * somebody laid should read as laid rather than as grown, but a perfectly flat
 * sheet of one value looks like a hole in the render.
 *
 * `accent` defaults to a darkened `color`, so a one-colour floor is one field
 * and a chequerboard nobody gave a second colour to is still a chequerboard.
 */
/**
 * How many bars a striped cell is painted with, and how wide each one is.
 *
 * Three at a sixth of a tile is 50% duty, which is what a zebra crossing is.
 * The number matters less than the fact that it is sub-tile at all: every other
 * ground pattern in this game is one colour per cell (`patternColor`), because
 * at 45° across a room nothing finer survives — and that is true of a chequer
 * and false of a crossing. A bar the width of a whole tile is half a car long.
 */
export const STRIPE_BARS = 3;

/**
 * ...off the row where one says so, and the gap is always the bar.
 *
 * `STRIPE_BARS` is a fallback for a design that did not choose, the way
 * `FALLBACK_FIXTURE_COST` is a floor for a kind nobody priced — not a second
 * opinion. Duty is derived rather than authored: half-and-half is what makes a
 * zebra a zebra, so one number says everything about the marking.
 */
export const stripeBars = (surface) => Math.max(1, Math.round(surface?.bars || STRIPE_BARS));
export const stripeDuty = (surface) => 1 / (stripeBars(surface) * 2);

export function patternColor(surface, x, z) {
  const base = surface.color;
  const accent = surface.accent ?? shade(base, -0.16);
  const alt = surface.pattern === 'checker'
    ? (x + z) % 2 === 1
    // Planks run along x and step every third row, so the joins stagger rather
    // than lining up into one long stripe down the shop.
    // `stripes` is deliberately absent, and that is the one pattern that is not
    // a per-cell colour. A zebra bar is a fraction of a tile wide — one bar per
    // CELL is a bar half a car long, which is a chequerboard with ambitions —
    // so the cell stays its base colour here and the bars are drawn on top of
    // it as their own geometry — see `STRIPE_BARS` above, and `addStripes` in
    // `client/render/scene.js`, which lays them.
    : (surface.pattern === 'planks' ? Math.floor(z + (x % 3 === 0 ? 1 : 0)) % 3 === 0 : false);
  return jitter(alt ? accent : base, 0.03, x * 31 + z * 17);
}

/** A hex colour lightened (positive) or darkened (negative) by a fraction. */
export function shade(hex, by) {
  const c = parseInt(hex.slice(1), 16);
  const mix = (v) => clamp8(by >= 0 ? v + (255 - v) * by : v * (1 + by));
  return `#${(((mix((c >> 16) & 255) << 16) | (mix((c >> 8) & 255) << 8) | mix(c & 255)) >>> 0)
    .toString(16).padStart(6, '0')}`;
}

/** A shopper's face: calm cream, going hot and blotchy as their patience runs out. */
export const FACE_CALM = '#f6efe2';
export const FACE_ANGRY = '#d0503c';

/**
 * The flush, 0 (content) to 1 (about to walk out).
 *
 * Quantised, and that is the whole reason this is a lookup rather than a lerp:
 * `material()` caches by colour, so a continuous ramp would mint a fresh
 * material per shopper per frame and never reuse one. Eight shades are built
 * once and shared by everyone equally cross.
 */
const FACE_RAMP = Array.from({ length: 9 }, (_, i) => {
  const a = parseInt(FACE_CALM.slice(1), 16);
  const b = parseInt(FACE_ANGRY.slice(1), 16);
  const t = i / 8;
  const ch = (sh) => clamp8((((a >> sh) & 255) * (1 - t)) + (((b >> sh) & 255) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
});

export const faceColor = (anger) => FACE_RAMP[Math.round(Math.max(0, Math.min(1, anger)) * 8)];
