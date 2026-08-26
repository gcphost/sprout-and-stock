#!/usr/bin/env node
/**
 * VERIFY: A STYLE IS A LOOK AND NEVER A RULE.
 *
 * Cel + Ink is the first thing in this game that changes what every mesh in the
 * shop is MADE of, and it is also the first feature whose whole job is to be
 * visible — which makes it the one nobody would think to write a sweep for. The
 * cautionary tale is in CLAUDE.md and it is `verify:ceiling`: a feature that
 * shipped without its sweep on the argument that a smoke test had proved it,
 * and had four live bugs in it by the time anybody played it. So this ships with
 * the look.
 *
 * No `verify:*` sweep has ever touched the renderer — they all drive `Game`
 * directly — which is exactly why the claims here are the shape they are. Every
 * one of them is about something a screenshot cannot show you, and most are
 * about the look being OFF, because off is what every existing player and every
 * screenshot in this repo is.
 *
 * The claims:
 *
 * - **The control, and it is the assertion the whole feature rests on.** With
 *   the look off, `material()` is exactly what it always was: a flat-shaded
 *   Lambert, one object per colour, glass still glass. One object per colour is
 *   not tidiness — it is the ceiling on `weld`, so a cache that started handing
 *   out a fresh material per call would quietly turn a hundred-colour shop back
 *   into a hundred draws with nothing on screen to say why.
 *
 * - **A light source is never shaded**, either way round. `glow` is what the
 *   art declares on a lamp lens, a sign face, a neon tube, and banding one is
 *   what makes a lit sign go grey the moment the sun goes down — which reads as
 *   the lamp having been switched off rather than as a material class.
 *
 * - **The derivatives follow their source.** `litMaterial` and `batchMaterial`
 *   are two caches that CLONE, and between them they own most of the static
 *   shop — every welded fixture and every baked surface. `batchMaterial` keys
 *   on a string built by hand, so a key that forgot the type would hand a
 *   banded shop its Lambert batch: the shelves stay flat-lit while the loaves on
 *   them band, in a shop where nothing errors and nothing logs.
 *
 * - **No `flatShading` on the toon one.** three has no such property on it and
 *   says so, once per material — and at ~190 materials that is a console you
 *   cannot read, which is not a cosmetic complaint: it is every other warning
 *   in the game buried, on the day you most need one.
 *
 * - **The ramp's bottom step is not black**, and the texture is unpacked a byte
 *   at a time. `unpackAlignment` defaults to four, so a band count that is not a
 *   multiple of four is read off the wrong stride and the steps come out uneven
 *   — which reads as a badly chosen ramp rather than as a texture upload, and
 *   is invisible at the shipped 3 only because three happens to look wrong in a
 *   way you would blame on the number.
 *
 * - **The shadow span and the snap grid move TOGETHER.** This is the one that
 *   would cost real time. The map is fitted to the view now, so the texel it is
 *   on changes as you zoom, and `snapToShadowTexel` rounds the frustum's centre
 *   onto that grid. Round to a grid the map no longer has and you get exactly
 *   the shimmer the snap exists to remove — every shadow edge in the shop
 *   fizzing while the camera moves, which reads as the hard filter being wrong.
 *   Asserted as a RATIO rather than a value: two spans must leave two texels in
 *   the same proportion, which is a claim that the number is derived rather
 *   than a claim about what the map size happens to be.
 *
 * - **It is a look and never a rule**, which is the title. Nothing in `server/`
 *   or `shared/` may import it, and no save, schema or wire field may mention
 *   it — get that right and the whole feature touches no sweep, no balance
 *   number and no migration. Asserted over the source tree, because that is
 *   where "client-only" is a fact rather than an intention.
 *
 * WHAT THIS CANNOT REACH, and it is listed here rather than left implied, the
 * way docs/browser.md lists SDP and ICE. Everything downstream of a real WebGL
 * context — the composite compiling, the depth buffer resolving through MSAA,
 * `pickFixture` answering the same fixture after a rebuild, and no mesh being
 * left holding the old material class — is a browser claim, and node has no
 * canvas to make it against. The last two were checked by hand against a live
 * shop when this shipped (81 static meshes, all of one class before the flip
 * and all of the other after it, with the shop unchanged either side).
 *
 * It writes nothing at all: no content rows, no save, no cleanup.
 *
 *   node scripts/verify-look.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';

import {
  lookOn, setLookOn, gradientMap,
  BANDS, SHADOW_FLOOR, INK, GRADE, SHADOW_SPAN_MIN, SHADOW_MARGIN,
  SHADOW_NORMAL_BIAS_TEXELS, SHADOW_MAP_LOOK,
  SUN_NOON, AMBIENT_NOON, SUN_DUSK_LEVEL, AMBIENT_DUSK_LEVEL, BOUNCE_LOOK,
} from '../client/render/look.js';
import {
  material, characterMaterial, litMaterial, batchMaterial, paintLit,
} from '../client/render/props.js';
import { Scene } from '../client/render/scene.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * The shipped span, restated rather than imported.
 *
 * Same rule `verify:grace` follows about `GRACE_DAYS` and `verify:spawn` about
 * its band: an assertion that imports the constant it is asserting about passes
 * whatever that constant becomes, which is a sweep that guards the spelling of
 * a number and not the number.
 */
const SHIPPED_SPAN = 30;
const SHIPPED_MAP = 1024;

// ---------------------------------------------------------------------------
// 1. THE CONTROL — off is the game exactly as it shipped.
// ---------------------------------------------------------------------------

{
  // Node has no localStorage, so a fresh process is the default — which is ON.
  // That is the assertion, not the setup: a verify sweep, a private window and
  // a headless build all have to land on the shipped look rather than on
  // whichever branch happens to be reached when storage is missing.
  check(lookOn() === true, 'with no storage at all, the look is on');

  setLookOn(false);
  check(lookOn() === false, 'and it can be turned off');

  const off = material('#c04a2a');
  eq(off.type, 'MeshLambertMaterial', 'off, a surface is the Lambert the game shipped with');
  check(off.flatShading === true, 'off, a surface is flat-shaded');
  check(off.color.getHexString() === new THREE.Color('#c04a2a').getHexString(),
    'off, a surface keeps the colour it was asked for');

  // One material per colour, which is what `weld` rests on: two meshes can only
  // merge if they carry the same material, so a cache that stopped sharing
  // would turn a hundred-colour shop back into a hundred draws.
  check(material('#c04a2a') === off, 'off, one colour is one material');

  const glass = material('#88ccff', 0.35);
  check(glass.transparent === true && glass.opacity === 0.35 && glass.depthWrite === false,
    'off, glass is still glass', `${glass.transparent}/${glass.opacity}/${glass.depthWrite}`);

  eq(characterMaterial('#334455').type, 'MeshLambertMaterial',
    'off, a person is the smooth Lambert people have always been');
}

// ---------------------------------------------------------------------------
// 2. ...and on, it is a different thing, which is not the same claim.
// ---------------------------------------------------------------------------

{
  const wasOff = material('#c04a2a');

  check(setLookOn(true) === true, 'turning it on reports that something moved');
  check(setLookOn(true) === false,
    'setting it to what it already is reports that nothing did');

  const on = material('#c04a2a');
  eq(on.type, 'MeshToonMaterial', 'on, a surface is banded');
  check(on !== wasOff, 'the cache is keyed by the mode, not only by the colour');
  check(!!on.gradientMap, 'on, a surface carries a ramp');
  eq(characterMaterial('#334455').type, 'MeshToonMaterial', 'on, a person is banded too');

  // three has no `flatShading` on a toon material and warns once per material
  // if you set one anyway. It costs nothing to omit — every primitive in `GEO`
  // is a box or a cylinder with split normals, so the facets are in the
  // geometry rather than in the shader.
  check(on.flatShading !== true, 'on, a surface does not ask for flat shading');

  const glass = material('#88ccff', 0.35);
  check(glass.transparent === true && glass.opacity === 0.35 && glass.depthWrite === false,
    'on, glass is still glass');

  // A LIGHT SOURCE IS NEVER SHADED, either way round.
  eq(material('#ffeebb', 1, true).type, 'MeshBasicMaterial', 'on, a lamp lens is unshaded');
  setLookOn(false);
  eq(material('#ffeebb', 1, true).type, 'MeshBasicMaterial', 'off, a lamp lens is unshaded');
  setLookOn(true);

  // ...and back is back. A flip either way has to be a round trip, or the
  // switch is one-way and turning the look off leaves a half-banded shop.
  setLookOn(false);
  eq(material('#c04a2a').type, 'MeshLambertMaterial', 'and off again is Lambert again');
  // The SAME object, which is the difference between a cache and a leak: keyed
  // by a bump-per-change rather than by the mode, two presses of the switch
  // mint a second full set of materials for a shop that is byte-identical to
  // the one it was, and the GPU programs behind the first set are never handed
  // back. Nothing on screen would ever say so.
  check(material('#c04a2a') === wasOff, 'off again is the SAME material it was before');
  setLookOn(true);
  check(material('#c04a2a') === on, '...and on again is the same one too');
}

// ---------------------------------------------------------------------------
// 3. THE DERIVATIVES — most of the static shop is a clone of something above.
// ---------------------------------------------------------------------------

{
  const src = material('#3a7a4a');
  const lit = litMaterial(src);
  eq(lit.type, src.type, 'a baked surface shades the way its source does');
  check(!!lit.gradientMap, 'a baked surface keeps the ramp');
  check(lit.vertexColors === true, 'a baked surface still reads its vertex colour');

  const batch = batchMaterial(src);
  eq(batch.type, src.type, 'a welded surface shades the way its source does');
  check(!!batch.gradientMap, 'a welded surface keeps the ramp');
  check(batch.color.getHex() === 0xffffff, 'a welded surface is white, with the hue in the geometry');

  // The key `batchMaterial` builds by hand has to separate the two classes, or
  // a banded shop is handed the Lambert batch it made this morning: the shelves
  // stay flat-lit while the goods on them band, and nothing errors.
  setLookOn(false);
  const flat = batchMaterial(material('#3a7a4a'));
  check(flat !== batch, 'a welded Lambert and a welded toon are two materials');
  eq(flat.type, 'MeshLambertMaterial', '...and the flat one is the flat one');
  setLookOn(true);
}

// ---------------------------------------------------------------------------
// 4. THE RAMP.
// ---------------------------------------------------------------------------

{
  const t = gradientMap(BANDS, SHADOW_FLOOR);
  eq(t.image.width, BANDS, 'the ramp has as many steps as it was asked for');
  eq(t.unpackAlignment, 1, 'the ramp is unpacked one byte at a time');
  check(t.minFilter === THREE.NearestFilter && t.magFilter === THREE.NearestFilter,
    'the ramp is sampled hard, so the steps stay steps');
  check(t === gradientMap(BANDS, SHADOW_FLOOR),
    'one ramp, shared by every material in the shop');

  const data = t.image.data;
  eq(data[data.length - 1], 255, 'the top step is full light');
  eq(data[0], Math.round(SHADOW_FLOOR * 255), 'the bottom step is the floor it was given');
  // A shaded face is a FILLED BLOCK, not the object's own colour turned down.
  // At zero the dark band is black whatever the thing is made of, which is a
  // hole in the shop rather than a shadow on it.
  check(SHADOW_FLOOR > 0.05 && SHADOW_FLOOR < 0.5,
    'the bottom step is a shade rather than a hole', String(SHADOW_FLOOR));

  // Every step is distinct and they climb. A ramp that repeated a value is a
  // band nobody can see, which is a `bands` dial that stops moving at some
  // number and looks like the ramp being right.
  let climbs = true;
  for (let i = 1; i < data.length; i++) if (data[i] <= data[i - 1]) climbs = false;
  check(climbs, 'the steps climb, every one of them distinct', Array.from(data).join(','));

  // Uneven steps are the `unpackAlignment` failure said as a number, so this is
  // the same claim from the other side and holds for a count that is not a
  // multiple of four.
  const five = gradientMap(5, 0.2);
  const gaps = [];
  for (let i = 1; i < five.image.data.length; i++) gaps.push(five.image.data[i] - five.image.data[i - 1]);
  check(Math.max(...gaps) - Math.min(...gaps) <= 1, 'five steps are five EVEN steps', gaps.join(','));
}

// ---------------------------------------------------------------------------
// 5. THE INK, as authored.
// ---------------------------------------------------------------------------

{
  // Not a tuning check — these came out of the lab by eye and are settled. What
  // this guards is the SHAPE of the decision, which is the thing somebody
  // tidying up would flatten: two weights, one thick and one hair-fine, held
  // hard, and the whole lot pulled back. Merge them into one number and the
  // result is a render with a border round it rather than a drawing.
  check(INK.SIL_WIDTH > INK.CREASE_WIDTH * 4,
    'the outer line is far thicker than the interior seams',
    `${INK.SIL_WIDTH} vs ${INK.CREASE_WIDTH}`);
  check(INK.CREASE_INK < 1, 'and the interior seams are lighter', String(INK.CREASE_INK));
  check(INK.AMOUNT > 0 && INK.AMOUNT < 1,
    'the contour is drawn at part strength — full is an outline filter', String(INK.AMOUNT));
  check(INK.FADE < 0.5,
    'lines barely thin with distance, so the far aisle keeps its lines', String(INK.FADE));

  // Colour may never be taken away. Every look that muted or re-palettised the
  // shop was rejected, and for a playability reason rather than a taste one: a
  // board of apples is told from a board of carrots across the room by being a
  // different colour. So the grade only ever goes UP.
  check(GRADE.SATURATION >= 1, 'the grade never desaturates the shop', String(GRADE.SATURATION));
  check(GRADE.EXPOSURE > 0, 'and never turns the lights off', String(GRADE.EXPOSURE));
}

// ---------------------------------------------------------------------------
// 5b. THE LIGHT MOVES AT NOON AND NOWHERE ELSE.
// ---------------------------------------------------------------------------

{
  // The bug this is written to: the lab's light applied as a RATIO on the day
  // cycle. At midday it lands on the lab exactly, and every other hour of the
  // day it is somewhere the lab has never been — worst at dusk, where 0.69 of a
  // fill of 0.38 is 0.26 in blue-grey, and three bands with a floor under them
  // put the whole shop into the dark step. What it reads as is a brown, muddy
  // evening that looks nothing like the reference, on a look that matches the
  // reference perfectly at noon, which is not a complaint anybody can locate.
  //
  // Restated as arithmetic rather than driven through `syncState`, which wants
  // a whole `Scene`, a canvas and a snapshot. The two ends are the claim; what
  // runs between them is a lerp either way.
  const shipped = (daylight) => ({
    sun: 0.30 + daylight * (1.30 - 0.30),
    fill: 0.38 + daylight * (0.90 - 0.38),
  });
  const styled = (daylight) => ({
    sun: SUN_DUSK_LEVEL + daylight * (SUN_NOON - SUN_DUSK_LEVEL),
    fill: AMBIENT_DUSK_LEVEL + daylight * (AMBIENT_NOON - AMBIENT_DUSK_LEVEL),
  });

  // THE CONTROL, and it is the assertion that decides whether the day cycle
  // survived this feature: at the dark end the look changes NOTHING. Dusk is
  // dusk, and a style that redecorated it would have quietly rebalanced the one
  // thing in this renderer nobody can screenshot — the difference between
  // half past seven and half past eight.
  check(Math.abs(styled(0).sun - shipped(0).sun) < 1e-9,
    'at dusk the sun is exactly the one the game shipped with');
  check(Math.abs(styled(0).fill - shipped(0).fill) < 1e-9,
    'at dusk the fill is exactly the one the game shipped with');

  // ...and at the top of the day it is the lab, to the digit. These came out of
  // `PRESETS.cel.patch` by eye and are the whole reason the look looks like it.
  check(Math.abs(styled(1).sun - 1.45) < 1e-9, 'at noon the sun is the lab\'s', String(styled(1).sun));
  check(Math.abs(styled(1).fill - 0.62) < 1e-9, 'at noon the fill is the lab\'s', String(styled(1).fill));

  // The direction, which is what makes it a cel look rather than a dimmer: a
  // HARDER sun over a LOWER fill. Flatten that and the ramp has nothing to
  // band — every face lands in the same step and the shop reads as unlit paper
  // with lines on it.
  check(styled(1).sun > shipped(1).sun && styled(1).fill < shipped(1).fill,
    'the look trades fill for sun, which is what gives the ramp anything to band',
    `sun ${styled(1).sun} vs ${shipped(1).sun}, fill ${styled(1).fill} vs ${shipped(1).fill}`);

  // ...and it is a REDISTRIBUTION rather than a dimmer, which is the pair to
  // the claim above and worthless without it. Trading fill for sun does lower
  // the total a little — the lab's own pair adds up to 2.07 against the game's
  // 2.20 — and that is the look; what it must not become is a style that pays
  // for its bands by turning the lights down, because "the shop got dark" is a
  // complaint about the shop and this is a decision about a picture. A tenth is
  // the bar, checked across the whole day rather than at the two ends, since
  // the two ends are exactly where a bad curve agrees with a good one.
  let worst = 1;
  for (let i = 0; i <= 20; i++) {
    const d = i / 20;
    worst = Math.min(worst, (styled(d).sun + styled(d).fill) / (shipped(d).sun + shipped(d).fill));
  }
  check(worst > 0.9, 'no hour of the day loses more than a tenth of its light',
    `worst ${worst.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 5c. THE SHOP'S OWN LIGHT, which the lab has never had any of.
// ---------------------------------------------------------------------------

{
  // Two things sit between the tuned numbers above and what actually reaches a
  // surface, and neither exists in the lab: `spill` — every lamp too far away
  // for a real light, folded into the ambient — and the BAKE, a per-vertex
  // brightness the shop works out on the CPU. Both are additions on top of a
  // fill that was tuned as a total, and both fail the same way: not as
  // something wrong, but as the bands all landing in the same step. A flat,
  // washed-out shop with every line still drawn on it, which reads as the toon
  // shading not working.

  // The fill has a CEILING. `spill` reaches 0.29 in a mature shop, so raw on
  // top of 0.62 it is a 57% overshoot that puts the fill level with the sun.
  const cap = (sky, spill) => Math.min(sky + spill, AMBIENT_NOON);
  check(cap(0.62, 0.29) <= AMBIENT_NOON, 'lamps cannot lift the fill past midday');
  // ...and it is a ceiling rather than a smaller spill, or what spill is FOR
  // stops happening: a dark shop full of lamps still has to come up.
  check(cap(0.38, 0.20) > 0.38, 'but a dark shop full of lamps still comes up',
    String(cap(0.38, 0.20)));
  check(cap(0.62, 0) === AMBIENT_NOON, 'and a shop with no lamps is untouched');

  // The bake is a MULTIPLIER and runs past 1 where lamps overlap — a quarter of
  // every vertex colour in a real shop, peaking above 2. A toon ramp's shaded
  // term is already at the top step, so anything above 1 clips the channel to
  // white: the colour is gone rather than brighter, and what it looks like is a
  // milky haze over the shelves.
  const lump = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material('#c04a2a')));
    return g;
  };
  const brightest = (group) => {
    let hi = 0;
    group.traverse((o) => {
      const a = o.geometry?.attributes?.color;
      if (a) for (let i = 0; i < a.array.length; i++) hi = Math.max(hi, a.array[i]);
    });
    return hi;
  };

  setLookOn(true);
  const banded = lump();
  paintLit(banded, 2.07, 2.07, 2.07);
  check(brightest(banded) <= 1.0001, 'a banded shop is never handed a brightness it cannot hold',
    String(brightest(banded)));

  // THE CONTROL, and it is the one that decides whether this is a fix or a
  // silent change to every shop in existence: with the look off the bake is the
  // bake it always was, pools and all.
  setLookOn(false);
  const flatLit = lump();
  paintLit(flatLit, 2.07, 2.07, 2.07);
  check(Math.abs(brightest(flatLit) - 2.07) < 1e-4, 'off, the bake keeps its pools',
    String(brightest(flatLit)));
  setLookOn(true);

  // ...and the dim end is untouched either way, or clamping has become a
  // rescale and every lamp pool in the shop has quietly changed shape.
  const dim = lump();
  paintLit(dim, 0.4, 0.4, 0.4);
  check(Math.abs(brightest(dim) - 0.4) < 1e-4, 'the dim end of the bake is left alone',
    String(brightest(dim)));
}

// ---------------------------------------------------------------------------
// 6. THE SHADOW RIG — the span and the snap grid are one decision.
// ---------------------------------------------------------------------------

{
  const stub = (zoom, fpv = false) => ({
    fpv,
    ortho: { zoom },
    camPitch: 0.698,                                   // the shipped ~40°
    renderer: { domElement: { clientWidth: 1600, clientHeight: 900 } },
    sun: { shadow: { camera: { updateProjectionMatrix() {} } } },
    shadowSpan: null,
    shadowDirty: false,
  });
  const fit = (s) => Scene.prototype.fitShadowSpan.call(s);

  const wide = stub(0.7);                              // ZOOM_MIN
  const tWide = fit(wide);
  const near = stub(6);                                // well in
  const tNear = fit(near);

  check(wide.sun.shadow.camera.right <= SHIPPED_SPAN,
    'the fitted map never covers more than the fixed one used to',
    String(wide.sun.shadow.camera.right));
  check(near.sun.shadow.camera.right >= SHADOW_SPAN_MIN,
    'and never less than the floor', String(near.sun.shadow.camera.right));
  check(near.sun.shadow.camera.right < wide.sun.shadow.camera.right,
    'zoomed in covers less ground than zoomed out',
    `${near.sun.shadow.camera.right} vs ${wide.sun.shadow.camera.right}`);
  check(wide.sun.shadow.camera.left === -wide.sun.shadow.camera.right
    && wide.sun.shadow.camera.top === wide.sun.shadow.camera.right
    && wide.sun.shadow.camera.bottom === -wide.sun.shadow.camera.right,
    'the frustum is square about the point it is looking at');

  // THE CENTREPIECE, and it is a comparison rather than a value: the texel
  // handed to the snap has to be derived from the frustum that was just set. A
  // constant there — or one left over from the fixed span — rounds the map's
  // centre onto a grid the map does not have, which is every shadow edge in the
  // shop fizzing while the camera moves.
  const ratio = tWide / tNear;
  const spans = wide.sun.shadow.camera.right / near.sun.shadow.camera.right;
  check(Math.abs(ratio - spans) < 1e-9,
    'the snap grid is derived from the span it was just given',
    `texels ${ratio.toFixed(6)} vs spans ${spans.toFixed(6)}`);

  // Quantised, or the grid slides under the snap on every frame of a pinch —
  // which is the same shimmer arriving by the other door.
  const a = stub(1.45);
  const b = stub(1.4501);
  eq(fit(a), fit(b), 'two zooms a hair apart leave the map on the same grid');

  // ...and it says so only when it actually moved. A refit that marked itself
  // dirty every frame would draw the shadow map every frame, which is the frame
  // budget's single biggest lever handed back for nothing.
  const held = stub(1.45);
  fit(held);
  check(held.shadowDirty === true, 'the first fit asks for a redraw');
  held.shadowDirty = false;
  fit(held);
  check(held.shadowDirty === false, 'and a fit that changed nothing does not');

  // First person has nothing to fit to — a perspective frustum reaches the far
  // wall — so it gets the constant back rather than a number computed from an
  // ortho zoom nobody is looking through.
  const eye = stub(1.45, true);
  fit(eye);
  eq(eye.sun.shadow.camera.right, SHIPPED_SPAN, 'first person falls back to the fixed span');

  check(SHADOW_MARGIN > 0,
    'the fit reaches past the frame, or panning drags a wall of light over the floor');

  // HARDNESS IS THE TEXEL, and this is the claim the whole rig rests on now.
  //
  // A banded look wants the hardest shadow in the game, and the cheap way to get
  // one is to stop filtering the map. That shipped, and what it cost is the
  // report this section exists for: PCF's tap is also the only thing standing
  // between this scene and its own self-shadowing, so unfiltered, every bit of
  // acne on a face lying near-parallel to the sun — the shop's `+z` wall, at 74°
  // — becomes a hard binary lattice across the whole face of it. What that READS
  // as is a texture somebody applied, which is why it cost an afternoon.
  //
  // So the tap stays and the TEXEL shrinks instead, which is what the fit above
  // and the doubled map are for. Asserted against the shipped rig rather than
  // against a value: the look may never hand back so much span, or so many
  // texels, that a filtered edge goes soft again. Both halves, or the claim is
  // satisfied by a fit that covers one tile.
  const shippedTexel = (SHIPPED_SPAN * 2) / SHIPPED_MAP;
  check(SHADOW_MAP_LOOK >= SHIPPED_MAP,
    'the look never spends fewer texels on the shadow than the game did',
    `${SHADOW_MAP_LOOK} vs ${SHIPPED_MAP}`);
  check(tWide <= shippedTexel / 2 + 1e-9,
    'and at its widest the texel is at most half the shipped one, which is where'
    + ' a hard edge comes from now',
    `${tWide.toFixed(6)} vs ${shippedTexel.toFixed(6)}`);

  // THE BIAS IS A MULTIPLE OF THE TEXEL, and this is the pair to the ratio
  // above rather than a separate claim. A shadow map texel covers a patch of
  // world, and across that patch a sloped surface's depth changes; if the
  // change outruns the bias, half the patch shadows itself. It shipped as a
  // constant lifted from the lab, whose map is four times finer, so it was short
  // by exactly that factor and only on the shops big enough to need a wide span.
  //
  // Asserted as a ratio for the same reason the texel is: naming a value would
  // guard the number the lab happened to pick rather than the relationship
  // that makes it right at every zoom.
  const biasOf = (s2) => { fit(s2); return s2.sun.shadow.normalBias; };
  const bWide = biasOf(stub(0.7));
  const bNear = biasOf(stub(6));
  check(bWide > 0 && bNear > 0, 'a shadow is pushed off its own surface');
  check(Math.abs((bWide / bNear) - (tWide / tNear)) < 1e-9,
    'and pushed by a multiple of the texel, so it means the same at every zoom',
    `bias ${(bWide / bNear).toFixed(6)} vs texel ${(tWide / tNear).toFixed(6)}`);
  check(Math.abs(bWide - SHADOW_NORMAL_BIAS_TEXELS * tWide) < 1e-9,
    'by that multiple exactly', `${bWide} vs ${SHADOW_NORMAL_BIAS_TEXELS * tWide}`);
}

// ---------------------------------------------------------------------------
// 7. IT IS A LOOK AND NEVER A RULE.
// ---------------------------------------------------------------------------

{
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir, out = []) => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
      else if (name.endsWith('.js')) out.push(rel);
    }
    return out;
  };

  // The sim, the store, the wire and the validator. None of them may have heard
  // of this: the moment one does, a style is a thing a save can disagree with
  // another save about, and every sweep in here is measuring a shop with a
  // rendering decision in it.
  const engine = [...walk('server'), ...walk('shared'), ...walk('mcp'), ...walk('scripts')]
    .filter((f) => f !== 'scripts/verify-look.js');
  const leaked = engine.filter((f) => readFileSync(join(root, f), 'utf8').includes('render/look.js'));
  check(leaked.length === 0, 'nothing outside the client has heard of the look', leaked.join(', '));

  // ...and it cannot grow one by accident either, because the module has
  // nothing to reach the shop THROUGH: three and no more. A style file that
  // imported a schema is one import away from being a field on a save, and the
  // day it is, `simulate` is measuring a shop with a rendering decision in it.
  const src = readFileSync(join(root, 'client/render/look.js'), 'utf8');
  const imports = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
  check(imports.length === 1 && imports[0] === 'three',
    'the look imports three and nothing else', imports.join(', '));

  // The press itself tells nobody. `setLook` is a fact about the person the
  // way the camera is, and a switch that reached the wire would be one player
  // restyling another player's shop — which reads as the shop having changed
  // rather than as a setting having leaked. Read off the function rather than
  // asserted about a mock, since what is being claimed is that the code has no
  // such line in it at all.
  const press = String(Scene.prototype.setLook);
  const wired = ['send(', 'net.', 'persist(', 'post('].filter((w) => press.includes(w));
  check(wired.length === 0, 'turning the look on tells nobody', wired.join(', '));
}

// ---------------------------------------------------------------------------
// 8. ...AND IT IS REMEMBERED, which is the half a fresh process cannot see.
// ---------------------------------------------------------------------------

{
  // A hand-rolled localStorage, then a cache-busted import so the module reads
  // it at load the way a browser tab does. `out and back are two different
  // pieces of code` is this file's own trap said about a preference: a switch
  // that writes and never reads is one that resets on every reload, and the
  // shop looks completely correct in between.
  const store = new Map([['sns-view', JSON.stringify({ pitch: 0.87, yaw: -123, look: 'off' })]]);
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  const fresh = await import('../client/render/look.js?remembered');
  check(fresh.lookOn() === false, 'a tab that turned it off gets it back off');

  fresh.setLookOn(true);
  const back = JSON.parse(store.get('sns-view'));
  check(back.look === 'cel', 'and turning it back on is written down', JSON.stringify(back));
  // The camera's own fields have to survive it, or the two halves of `sns-view`
  // take turns wiping each other every half second the view moves — which reads
  // as the setting reverting on its own, days later, with nothing to connect it
  // to. `saveView` in client/main.js is the other half of this and spreads for
  // the same reason.
  check(back.pitch === 0.87 && back.yaw === -123,
    'and the camera it shares the key with is left alone', JSON.stringify(back));

  // A world that never wrote one is the shipped look, not a broken one.
  store.set('sns-view', JSON.stringify({ pitch: 1, yaw: 2 }));
  const virgin = await import('../client/render/look.js?virgin');
  check(virgin.lookOn() === true, 'a tab that has never said anything gets the shipped look');

  delete globalThis.localStorage;
}

// ---------------------------------------------------------------------------

console.log(`\nverify:look — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a style is a look: off is the game as it shipped, and nothing else moved.\n');
