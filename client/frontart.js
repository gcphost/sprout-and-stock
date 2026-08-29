/**
 * THE TWO PICTURES ON THE FRONT DOOR, drawn from the game's own colours.
 *
 * The menu is a `#panel` now (see client/menu.js) and a panel is paper: cream,
 * one contour, creases inside it, nothing floating. What that leaves it with is
 * two pictures, and both are here for the same reason `client/thumb.js` exists
 * — a second picture of a thing that is kept matching by hand is a picture that
 * goes stale, and nobody ever holds a 64px square up against the shop it is
 * supposed to be of.
 *
 * So every colour below comes off `palette.js` or off `look.js`'s ink. The
 * SHAPES are this file's, and that is the honest split: there is no isometric
 * shop to photograph before a world is open, so the front of the building and
 * the plan of it are both drawings. What they may never do is invent a green or
 * a brown — change the mood of the game in `palette.js` and the door onto it
 * follows, which is the same bargain `.outdoors` struck when it stopped being a
 * blue gradient somebody picked.
 *
 * SVG strings rather than canvases, for `thumb.js`'s reason: the menu is built
 * by `innerHTML` from strings, so art costs it a longer string and nothing
 * else — no element to keep, no lifecycle, no size to measure, and sharp on any
 * screen.
 */

import { PALETTE, SURROUND_COLORS } from './render/palette.js';
import { INK } from './render/look.js';
import { surroundOf } from '../shared/surrounds.js';
import { startTier } from '../shared/start.js';

/**
 * The three colours that are chrome rather than shop.
 *
 * `INK.COLOR` is the real thing — the line the post pass lays over the shop,
 * which is also what `--ink-line` is a copy of, so the drawing and the card
 * round it are outlined in one colour by construction. The other two are the
 * token block's `--panel-solid` and `--accent`; they are spelled here because
 * an SVG presentation attribute is not a place a custom property can be relied
 * on to resolve, and they are the only two in the file that are not read from
 * somewhere.
 */
const LINE = INK.COLOR;
const PAPER = '#fffcf5';
const ACCENT = '#e2564a';

// ---------------------------------------------------------------------------
// The band across the top of the card
// ---------------------------------------------------------------------------

/**
 * How wide the building is drawn, per size.
 *
 * Not a footprint and deliberately not derived from one: `START_TIERS` has no
 * `w`/`h` in it on purpose (the generator grows a shop until its contents fit),
 * so there is no true number to read. What the band has to say is "this one is
 * bigger than that one", which is three widths and a comment saying they are
 * only that.
 */
const FRONT_W = { corner: 172, mini: 236, super: 308 };
/** ...and how many panes of glass fit either side of the door at that width. */
const FRONT_PANES = { corner: 1, mini: 2, super: 3 };

const BAND_W = 392;
const BAND_H = 128;
/** Where the ground stops. The one contour in the picture the shop would draw. */
const HORIZON = 106;

/** The land past the lot, per surround, off the same table the shop builds it from. */
function backdrop(id) {
  const c = SURROUND_COLORS[id] ?? SURROUND_COLORS.country;
  if (id === 'suburb') {
    return `
      <g stroke="${LINE}" stroke-width="2">
        <rect x="4" y="76" width="48" height="30" fill="${c.wall}"/>
        <path d="M0 76 L28 58 L56 76 Z" fill="${c.roof}"/>
        <rect x="16" y="84" width="11" height="11" fill="${PALETTE.freezer}"/>
        <rect x="340" y="72" width="52" height="34" fill="${c.wallAlt}"/>
        <path d="M336 72 L366 52 L396 72 Z" fill="${c.roofAlt}"/>
        <rect x="352" y="82" width="12" height="12" fill="${PALETTE.freezer}"/>
        <rect x="371" y="82" width="12" height="12" fill="${PALETTE.freezer}"/>
      </g>
      <rect x="0" y="99" width="392" height="7" fill="${c.hill}" stroke="${LINE}" stroke-width="2"/>`;
  }
  if (id === 'city') {
    let win = '';
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const lit = (i + j) % 3 ? PALETTE.freezer : c.glowNight;
        win += `<rect x="${10 + i * 10}" y="${34 + j * 13}" width="6" height="8" fill="${lit}"/>`;
      }
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const lit = (i * j) % 3 ? PALETTE.freezer : c.glowNight;
        win += `<rect x="${344 + i * 12}" y="${56 + j * 14}" width="7" height="9" fill="${lit}"/>`;
      }
    }
    return `
      <g stroke="${LINE}" stroke-width="2">
        <rect x="4" y="24" width="54" height="82" fill="${c.block}"/>
        <rect x="338" y="46" width="54" height="60" fill="${c.blockAlt}"/>
      </g>
      <g>${win}</g>
      <rect x="0" y="101" width="392" height="5" fill="${c.kerb}" stroke="${LINE}" stroke-width="2"/>`;
  }
  return `
    <path d="M0 84 q58 -20 116 -3 q68 18 126 -5 q76 -26 150 2 V${HORIZON} H0 Z"
      fill="${c.hill}" stroke="${LINE}" stroke-width="2"/>
    <rect x="0" y="96" width="392" height="10" fill="${c.hedge}" stroke="${LINE}" stroke-width="2"/>
    <g stroke="${LINE}" stroke-width="2">
      <rect x="8" y="78" width="6" height="20" fill="${c.trunk}"/>
      <circle cx="11" cy="74" r="11" fill="${c.crown}"/>
      <rect x="372" y="80" width="6" height="18" fill="${c.trunk}"/>
      <circle cx="375" cy="76" r="10" fill="${c.crownAlt}"/>
    </g>`;
}

/** The shop itself: fascia, awning, glass either side of the door. */
function frontage(tierId) {
  const bw = FRONT_W[tierId] ?? FRONT_W.mini;
  const bx = Math.round((BAND_W - bw) / 2);
  const top = 16;
  const fascia = 30;
  const awnY = top + fascia;
  const awnH = 15;

  // The awning, in the shop's own two stripes. An odd number of bays is what
  // keeps it from reading as a chequerboard, so the count comes off the width.
  const bays = Math.max(4, Math.round(bw / 32));
  const step = (bw + 8) / bays;
  let awning = '';
  for (let i = 0; i < bays; i++) {
    awning += `<rect x="${(bx - 4 + i * step).toFixed(1)}" y="${awnY}" `
      + `width="${step.toFixed(1)}" height="${awnH}" fill="${i % 2 ? PAPER : ACCENT}"/>`;
  }

  const gy = awnY + awnH + 9;
  const gh = HORIZON - gy;
  const dw = 40;
  const dx = bx + (bw - dw) / 2;
  const side = (bw - dw) / 2 - 18;
  const panes = FRONT_PANES[tierId] ?? FRONT_PANES.mini;
  let glass = '';
  for (let s = 0; s < 2; s++) {
    const x0 = s === 0 ? bx + 9 : dx + dw + 9;
    const gap = 5;
    const pw = (side - gap * (panes - 1)) / panes;
    for (let i = 0; i < panes; i++) {
      glass += `<rect x="${(x0 + i * (pw + gap)).toFixed(1)}" y="${gy}" `
        + `width="${pw.toFixed(1)}" height="${gh}" fill="${PALETTE.freezer}" `
        + `stroke="${LINE}" stroke-width="2.2"/>`;
    }
  }

  // The lettering shrinks with the building rather than the building growing to
  // fit it: a corner shop with a supermarket's sign on it is a corner shop with
  // no glass left.
  const fs = bw > 280 ? 21 : bw > 210 ? 18 : 14;

  return `
    <rect x="${bx}" y="${top}" width="${bw}" height="${HORIZON - top}"
      fill="${PALETTE.wall}" stroke="${LINE}" stroke-width="2.2"/>
    <rect x="${bx}" y="${top}" width="${bw}" height="${fascia}"
      fill="${PAPER}" stroke="${LINE}" stroke-width="2.2"/>
    <text x="196" y="${top + fascia / 2 + fs * 0.36}" text-anchor="middle" fill="${LINE}"
      style="font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 800;
             font-size: ${fs}px; letter-spacing: -.03em;"
      >SPROCKET <tspan fill="${ACCENT}">&amp;</tspan> STOCK</text>
    <g stroke="${LINE}" stroke-width="2.2">${awning}</g>
    ${glass}
    <rect x="${dx}" y="${gy - 5}" width="${dw}" height="${HORIZON - gy + 5}"
      fill="${PALETTE.floor}" stroke="${LINE}" stroke-width="2.2"/>
    <rect x="${dx + 6}" y="${gy}" width="${dw - 12}" height="18"
      fill="${PALETTE.freezer}" stroke="${LINE}" stroke-width="1.8"/>`;
}

/** Somebody is already here — which is the same promise `starterHire` makes. */
function crew(tierId) {
  let out = '';
  for (let i = 0; i < (tierId === 'super' ? 2 : 1); i++) {
    const x = 84 + i * 216;
    out += `<g stroke="${LINE}" stroke-width="2.2">
      <rect x="${x}" y="86" width="13" height="16" fill="${PALETTE.vehicle}"/>
      <rect x="${x - 2}" y="74" width="17" height="13" fill="${PALETTE.stationTop}"/>
      <circle cx="${x + 2}" cy="80" r="1.6" fill="${LINE}" stroke="none"/>
      <circle cx="${x + 9}" cy="80" r="1.6" fill="${LINE}" stroke="none"/>
      <path d="M${x + 6} 74 v-5" stroke-linecap="round"/>
      <circle cx="${x + 6}" cy="67" r="2.3" fill="${PALETTE.sunHigh}"/>
    </g>`;
  }
  return out;
}

/**
 * The band across the top of the front door: a shop, from the pavement.
 *
 * It is the one thing on this screen that no in-game panel has, and it is the
 * only place the menu says what the game IS rather than which save you want.
 * It answers to the two picks that are about the *picture* — how big the shop
 * is and what is behind it — so opening the new-shop form and changing either
 * redraws it, which is the whole of what makes those two dropdowns feel like
 * choices rather than fields.
 *
 * A drawing and not a render, deliberately: there is no scene, no camera and no
 * world until somebody has pressed something, and standing a live canvas here
 * would mean booting a shop to look at a menu.
 */
export function shopfrontArt({ tier, surround } = {}) {
  const t = startTier(tier).id;
  const s = surroundOf(surround);
  return `<svg class="menu-art" viewBox="0 0 ${BAND_W} ${BAND_H}" role="img"
    aria-label="A shop front under a striped awning, with a robot outside it.">
    <rect x="0" y="0" width="${BAND_W}" height="${HORIZON}" fill="${PALETTE.sky}"/>
    ${backdrop(s)}
    <rect x="0" y="${HORIZON}" width="${BAND_W}" height="${BAND_H - HORIZON}" fill="${PALETTE.grass}"/>
    <rect x="0" y="${HORIZON - 1}" width="${BAND_W}" height="2.2" fill="${LINE}"/>
    ${frontage(t)}${crew(t)}
    <g stroke="${LINE}" stroke-width="2.2">
      <rect x="348" y="90" width="17" height="15" fill="${PALETTE.station}"/>
      <rect x="346" y="87" width="21" height="4" fill="${PALETTE.stationTop}"/>
    </g>
  </svg>`;
}

// ---------------------------------------------------------------------------
// The square on a save row
// ---------------------------------------------------------------------------

/** The picture is 64 units square whatever the shop is, so the line stays one weight. */
const PLAN = 64;
/** Air round the building, in tiles, so the plan is a map of a place rather than a crop of a wall. */
const PLAN_MARGIN = 1.5;

/**
 * What `planOf` (server/worlds.js) codes each cell as, and what it is drawn in.
 *
 * The colours are the shop's own, which is the whole reason the grid comes over
 * as characters: the server says what is on a cell and this says what that
 * looks like, so the day the floor changes colour the plan does too and nobody
 * has to remember there is a second picture of it.
 */
const PLAN_FILL = {
  f: PALETTE.floor,      // shop floor
  y: PALETTE.bay,        // the pads: yard, storage, break area, car park, deck
  s: PALETTE.shelf,      // shelving
  t: '#ffd66b',          // the till — the one gold thing in the shop
  b: PALETTE.soilWeed,   // a growing rack
  m: PALETTE.station,    // machines
};
/** Which cells are INSIDE, for the outline. An edge is where one meets an outside cell. */
const PLAN_IN = new Set(['f', 'y', 's', 't', 'b', 'm']);

/**
 * A save's own floor plan, top down.
 *
 * Top down is the one view where the SHAPE of a shop is the picture: from the
 * front, two shops of the same size are the same drawing. Everything in here
 * comes off the save (see `planOf`), which is the whole argument for the field
 * — a square derived from the size somebody picked would be a picture of a
 * *type* of shop, and every save in the list is called `Shop N`.
 *
 * It is cropped to the shop and its farm the way any map is cropped to the
 * place it is of. Drawn to scale against the world it stands in, a shop is a
 * small box in a big field: true, and at 64px what you get is a green square
 * with something in one corner of it.
 *
 * A shop nobody has opened yet has nothing built in it, and the honest square
 * for that is an empty lot. It is not a placeholder for a picture that failed
 * to arrive — it is what that shop is until somebody walks in.
 */
export function planArt(plan) {
  if (!plan?.g) {
    const m = PLAN * 0.24;
    return `<svg viewBox="0 0 ${PLAN} ${PLAN}" aria-hidden="true">
      <rect width="${PLAN}" height="${PLAN}" fill="${PALETTE.grass}"/>
      <rect x="${m}" y="${m}" width="${PLAN - m * 2}" height="${PLAN - m * 2}"
        fill="${PALETTE.floor}" stroke="${LINE}" stroke-width="2.2"
        stroke-dasharray="4 3" opacity=".7"/>
    </svg>`;
  }

  const { w, h, g } = plan;
  const at = (x, z) => (x < 0 || z < 0 || x >= w || z >= h ? '.' : g[z * w + x]);

  // SQUARE, AND CENTRED ON WHAT IT IS CROPPING. A picture fitted to the shop's
  // own proportions would stretch a long thin farm into a fat one, which is the
  // trap `spin` in thumb.js names about a model drawn from two sides. The
  // margin is what makes this a map of a place rather than a crop of a wall.
  const span = Math.max(w, h) + PLAN_MARGIN * 2;
  const s = PLAN / span;
  const ox = (PLAN - w * s) / 2;
  const oz = (PLAN - h * s) / 2;
  const px = (x) => (ox + x * s).toFixed(2);
  const pz = (z) => (oz + z * s).toFixed(2);
  const size = (n) => (n * s).toFixed(2);

  /**
   * The cells, and then the OUTLINE round them.
   *
   * The line is where the shop stops, which is the same sentence `--ink-line`
   * is everywhere else — so it is drawn per exposed side rather than as a rect,
   * because a shop with an annex on it is not a rectangle and the whole reason
   * this is a grid is that it stopped being one.
   *
   * Its weight does not shrink with the shop: a forty-tile plan and a fifteen
   * tile one are the same 64px square, so a stroke measured in tiles would be a
   * hairline on one and a fence on the other.
   */
  let fills = '';
  let edges = '';
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const ch = at(x, z);
      if (ch === '.') continue;
      // Every inside cell is floor first and what is standing on it second, or
      // a shelf against the wall would be a shelf-shaped hole in the building.
      fills += `<rect x="${px(x)}" y="${pz(z)}" width="${size(1.02)}" `
        + `height="${size(1.02)}" fill="${PLAN_FILL[ch === 'y' ? 'y' : 'f']}"/>`;
      if (ch !== 'f' && ch !== 'y') {
        fills += `<rect x="${px(x + 0.1)}" y="${pz(z + 0.1)}" width="${size(0.8)}" `
          + `height="${size(0.8)}" fill="${PLAN_FILL[ch]}"/>`;
      }
      if (!PLAN_IN.has(at(x, z - 1))) edges += `M${px(x)} ${pz(z)}h${size(1)}`;
      if (!PLAN_IN.has(at(x, z + 1))) edges += `M${px(x)} ${pz(z + 1)}h${size(1)}`;
      if (!PLAN_IN.has(at(x - 1, z))) edges += `M${px(x)} ${pz(z)}v${size(1)}`;
      if (!PLAN_IN.has(at(x + 1, z))) edges += `M${px(x + 1)} ${pz(z)}v${size(1)}`;
    }
  }

  return `<svg viewBox="0 0 ${PLAN} ${PLAN}" aria-hidden="true">
    <rect width="${PLAN}" height="${PLAN}" fill="${PALETTE.grass}"/>
    ${fills}
    <path d="${edges}" stroke="${LINE}" stroke-width="1.8" fill="none"/>
  </svg>`;
}
