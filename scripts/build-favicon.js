/**
 * Bake the tab icon out of a robot the game already draws.
 *
 *   npm run favicon
 *
 * The generated file is `client/favicon.svg` and it is committed, exactly like
 * `client/icons.js`. Vite picks it up from the `<link rel="icon">` in
 * index.html, emits it with a content hash and rewrites the href — which is why
 * this works at all with `publicDir: false`, and why there is no static folder
 * to drop a `.ico` into.
 *
 * WHY A GENERATOR, for one file that changes about never. It is `client/thumb.js`'s
 * rule, which is the same rule the palette buttons follow: *a picture of a thing
 * has to come from the thing*. The first version of this file was a hand-drawn
 * cog, and a hand-drawn cog is a promise about a game nobody checks — the day
 * the bots are restyled, the tab still shows last year's. `artForWorker` is the
 * function the roster bar and the front door already draw a hire with, so what
 * ends up in the tab strip is the same six boxes, in the same projection, in the
 * same skin, as the thing standing at the till.
 *
 * THE CROP IS THE WHOLE DESIGN. A hire is drawn standing, so the art's own box
 * is about twice as tall as it is wide; fitted whole into a square it is a
 * four-pixel smear with a lot of cream either side. So this takes a SQUARE off
 * the top of that box — head and shoulders, the way every avatar ever has —
 * which at 16px is a head with a visor on it rather than a person-shaped mark.
 * The feet and the shadow ellipse are cropped away and are not missed.
 *
 * It reads the committed seed rather than the live database on purpose: this is
 * a build artifact that has to be reproducible from a fresh clone, and the live
 * content DB is a thing two people are editing while playing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { artForWorker } from '../client/thumb.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seed = (f) => JSON.parse(readFileSync(join(root, 'data', 'seed', f), 'utf8'));

/**
 * Who is on the icon, and what they are wearing.
 *
 * The clerk, because the clerk is the one the game puts at the front: it is
 * front-of-house, it is what a shopper walks up to, and of the six kinds it is
 * the one somebody who has never played would guess a shop sim is about.
 *
 * `cherry` rather than bare chassis grey, and this is the half that makes it a
 * favicon rather than a screenshot. An unskinned bot is four shades of blue-grey
 * — correct in a shop full of colour and, alone on a cream tile at 16px, a
 * smudge you could not pick out of a row of tabs. Cherry's chassis is #d94f5c
 * against the interface's own accent #e2564a, so the mark is the game's colour
 * without a second red being invented for it.
 *
 * Tier 1 and never the top rung: a promotion restages the model, and the tab
 * icon is not the place to show somebody a machine they have not earned.
 */
const WHO = 'clerk';
const SKIN = 'cherry';

/** How much of the art's own width the square crop is. Tuned by eye at 16px. */
const CROP = 1.05;
/** Cream showing round the bot, in units of the 32-wide tile. */
const PAD = 2.5;

const kind = seed('workers.json').find((w) => w.id === WHO);
const skin = seed('skins.json').find((s) => s.id === SKIN) ?? null;
if (!kind) throw new Error(`no worker row '${WHO}' in data/seed/workers.json`);
if (!skin) throw new Error(`no skin row '${SKIN}' in data/seed/skins.json`);

const art = artForWorker(kind, 1, skin);
if (!art) throw new Error(`'${WHO}' has no model to draw`);

// The art's own box, which `draw()` fits tight around the projected boxes — so
// these four numbers move whenever the model does, which is the point.
const [bx, by, bw] = art.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
const body = art.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// A square off the TOP. The nudge up is a hair of headroom: the tightest box
// puts the crown of the head exactly on the line, and a head touching the edge
// of a rounded tile reads as cropped rather than as framed.
const side = bw * CROP;
const crop = [bx + bw / 2 - side / 2, by - 0.015, side, side]
  .map((n) => Number(n.toFixed(4))).join(' ');

/**
 * A nested `<svg>` rather than a `<g transform>`.
 *
 * The inner one carries its own viewBox and `preserveAspectRatio`, so the
 * browser does the fitting — which means the crop above is the only arithmetic
 * in this file, and a change to the art cannot leave a scale factor stale.
 *
 * The tile is filled rather than transparent: a tab strip is dark in one theme
 * and light in the other, and this bot is dark-ish in both. An icon that brings
 * its own background is what every app icon does, for exactly this reason.
 *
 * No `--` anywhere in the comment below. A double hyphen is illegal inside an
 * XML comment and takes the whole file down to a parse error — which does not
 * look like a broken icon, it looks like no icon at all.
 */
const svg = `<!-- GENERATED by \`npm run favicon\` from the ${WHO} in the ${skin.name} skin.
     Do not edit: change the art, or scripts/build-favicon.js, and re-run. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#fffcf5"/>
  <svg x="${PAD}" y="${PAD}" width="${32 - PAD * 2}" height="${32 - PAD * 2}"
    viewBox="${crop}" preserveAspectRatio="xMidYMid meet">${body}</svg>
</svg>
`;

writeFileSync(join(root, 'client', 'favicon.svg'), svg);
console.log(`[favicon] wrote client/favicon.svg — ${WHO} in ${skin.name}`);
