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
  awningA: '#e2564a',
  awningB: '#f6f3ea',
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
 * Edge kind -> how it renders.
 *
 * `t` is thickness across the boundary, in tiles. A wall is thin because it
 * sits *on* the line between two cells rather than filling one — which is where
 * the two tiles of shop floor per side came back from.
 */
export const EDGE_STYLE = {
  [E.WALL]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17 },
  [E.WINDOW]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, glass: true },
  // A doorway is a gap you can walk through: a header spanning the opening and
  // a threshold underfoot, with nothing in between.
  [E.DOOR]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, opening: true },
  [E.GATE]: { color: PALETTE.fence, h: 0.5, t: 0.14, opening: true },
  [E.FENCE]: { color: PALETTE.fence, h: 0.5, t: 0.14 },
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
 * `opening` and `glass` stay the authored facts — "you can walk through this",
 * "you can see through this" — and this is the one place that turns either into
 * geometry.
 */
export function edgeBands(style) {
  // A way through: a header across the top, a threshold underfoot, nothing in
  // between.
  if (style.opening) {
    return [{ y0: style.h - 0.16, y1: style.h }, { y0: 0.02, y1: 0.05 }];
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
export function patternColor(surface, x, z) {
  const base = surface.color;
  const accent = surface.accent ?? shade(base, -0.16);
  const alt = surface.pattern === 'checker'
    ? (x + z) % 2 === 1
    // Planks run along x and step every third row, so the joins stagger rather
    // than lining up into one long stripe down the shop.
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
