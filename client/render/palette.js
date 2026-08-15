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
  bay: '#c2a173',
  bayPlank: '#a8865c',
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
  [T.SHELF]: { color: PALETTE.shelf, h: 0.75 },
  [T.FREEZER]: { color: PALETTE.freezer, h: 0.65 },
  [T.CHECKOUT]: { color: PALETTE.counter, h: 0.55 },
  // The plot tile is only the bed. Whether it reads as rough turf or turned
  // earth is per-plot state, so the renderer lays that on top in syncPlots.
  [T.PLOT]: { color: PALETTE.soilRough, h: 0.08 },
  [T.DOOR]: { color: PALETTE.door, h: 0.06 },
  [T.PATH]: { color: PALETTE.path, h: 0.05 },
  [T.FENCE]: { color: PALETTE.fence, h: 0.45 },
  [T.STATION]: { color: PALETTE.station, h: 0.7 },
  [T.BAY]: { color: PALETTE.bay, h: 0.07 },
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
