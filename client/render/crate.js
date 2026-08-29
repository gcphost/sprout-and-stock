/**
 * THE CRATE, AS PARTS — because it is the other piece in the game whose art is
 * code rather than a `fixtures` row.
 *
 * `elevator.js` is the precedent and the argument is the same one, one step
 * further on. A lift's row is never opened by the renderer, so its button drew
 * whatever the art used to be; `liftParts` fixed that by assembling the button's
 * picture out of the constants the shaft is built from. A crate has no row at
 * all — it is built in `buildPallet` — so anything that wants to *show* one has
 * exactly two options, and only one of them is allowed: draw a second crate by
 * hand, or read this.
 *
 * It goes one better than the lift, and that is the whole reason this file
 * exists rather than another `*Parts` beside a pile of mesh code. Here the
 * parts list is not the picture's own assembly out of shared numbers — it is
 * THE crate. `buildPallet` builds its box by handing this to `buildModel`, and
 * `artForCrate` draws the same list. There is one description of what a crate
 * looks like, so the icon and the box on the floor cannot disagree about a
 * height, a colour, a joint or a foot, whatever anybody changes next.
 *
 * Nothing in here imports three.js, and that is load-bearing for the same
 * reason it is in `elevator.js`: `thumb.js` is a caller and it runs in node
 * (`scripts/build-favicon.js`).
 */

import { CRATE_LOOK, WASTE_LOOK } from './palette.js';

/**
 * A crate's footprint, wall height and wall thickness, in tiles.
 *
 * It was 0.86 across and 0.42 deep, which is very nearly the whole tile: two
 * crates on neighbouring tiles touched, one beside a wall read as leaning
 * through it, and a single item sat at the bottom of an acre of empty box with
 * the rim hiding most of it. Everything below is derived from these three
 * numbers rather than typed out again, so the goods cannot quietly stop fitting
 * the crate the next time it changes size.
 *
 * ...and 0.6 was still most of a tile. A box that fills its square reads as
 * furniture rather than as something somebody carries, and a pile of three of
 * them stood as tall as the shelving beside it. Shrunk by an eighth on every
 * axis at once, which is the only way to do it: the proportions are what make
 * it read as a crate, and the goods, the stacking step and the label all come
 * off these numbers, so they follow on their own.
 *
 * ...and again by 15% when it stopped being timber. That is not a third go at
 * the same judgement: a moulded tote is a smaller object than a wooden crate in
 * life, and it now stands on a belt a tile wide, where a box within a whisker
 * of the deck edges reads as jammed rather than as riding. The one number that
 * did NOT simply scale is the wall, which came down by a further third on top
 * of it — plank thickness is a fact about planks, and carrying it over is what
 * made the tote look like a crate somebody had painted grey.
 *
 * ...and once more by the 0.72 a riding crate used to be scaled by, which is
 * the same judgement arriving from the other end. A box on a conveyor has been
 * drawn at 0.72 of the pallet size since there were belts, and that is the size
 * that has been looked at for hours — threading between machines, going into a
 * loader, coming off onto a pad — while the floor crate is the one nobody had a
 * reference for. So the belt was right and the pallet was wrong: this is the
 * belt's number becoming the crate's, and `BELT_CRATE` drops to 1 so a box is
 * the same object standing still or moving. Nothing on a conveyor changes size
 * at all — it was already exactly this.
 */
export const CRATE = 0.318;
export const CRATE_H = 0.138;
export const CRATE_WALL = 0.019;

/** Top of the base panel — the floor the goods stand on. */
export const CRATE_DECK = 0.027;

/**
 * How tall one crate stands, and therefore how far up the next one sits.
 *
 * Boards plus walls, so a stacked crate's own boards land exactly on the rim of
 * the one below with no gap and no overlap. Derived rather than typed, like
 * everything else off `CRATE`: a taller crate has to keep stacking.
 */
export const CRATE_STEP = CRATE_DECK + CRATE_H;

/** The band of rim standing proud of the walls, and the walls under it. */
const LIP = CRATE_H * 0.17;
const WALL_H = CRATE_H - LIP;
/** Where a wall's centre-line sits: half a wall in from the outside face. */
const RIM = (CRATE - CRATE_WALL) / 2;
/** The foot, which shares the deck's height with the base panel above it. */
const FOOT_H = CRATE_DECK * 0.5;
/** Corner posts, standing a hair outside the walls. */
const POST = CRATE_WALL * 2.4;
/** ...and the rim, wider than the posts are — see below. */
const LIP_T = CRATE_WALL * 2.6;
const LIP_Y = CRATE_DECK + WALL_H + LIP / 2;
/** Long enough to reach the outside of the corners. */
const LIP_SPAN = CRATE + LIP_T - CRATE_WALL;

const box = (color, scale, pos) => ({ shape: 'box', color, scale, pos });

/**
 * Every box a crate is made of, in model space, standing on y = 0.
 *
 * `waste` is the same tote in a drab colourway, and that is the whole of the
 * difference on purpose: what tells you it is rubbish is WHERE it is and the
 * fact that somebody is carrying it to the skip. A second silhouette would be a
 * new object to learn for a crate that behaves like every other crate — you can
 * pick it up, it stacks, it holds the same goods.
 */
export function crateParts(waste = false) {
  const look = waste ? WASTE_LOOK : CRATE_LOOK;
  const parts = [
    // The bottom, and the foot under it. Two pieces sharing the deck's height
    // between them, so `CRATE_STEP` is unchanged and a pile still has no gaps.
    //
    // The BASE is the full footprint and it is not optional: an inset skid alone
    // is a bottom only for as long as the walls are thick enough to meet it, and
    // thinning them opened a slot all the way round that you look straight down
    // through from this camera — a box with no floor, holding goods that stand
    // on nothing. Full width, in the body colour, because it is the inside of
    // the tote and the one face you see most of when the box is empty.
    //
    // The foot is inset on purpose: full-width it is a solid block sitting flush
    // on the floor, where pulled in it reads as standing on a foot — and a
    // stacked crate's foot then drops inside the rim of the one below rather
    // than balancing on top of it.
    box(look.skid, [CRATE * 0.8, FOOT_H, CRATE * 0.8], [0, FOOT_H / 2, 0]),
    box(look.body, [CRATE, CRATE_DECK - FOOT_H, CRATE], [0, (CRATE_DECK + FOOT_H) / 2, 0]),
  ];

  // The walls stop short of the top, and the band they leave is the lip.
  //
  // That split is the whole silhouette: four flat walls read as sheet material
  // whatever they are painted, where a rim standing proud of them reads as
  // something moulded in one piece. It comes out of `CRATE_H` rather than being
  // added to it, so the box is exactly as tall as it was and still stacks.
  //
  // Open-topped so the goods read from above.
  const wall = (sx, sz, px, pz) => parts
    .push(box(look.body, [sx, WALL_H, sz], [px, CRATE_DECK + WALL_H / 2, pz]));
  wall(CRATE, CRATE_WALL, 0, -RIM);
  wall(CRATE, CRATE_WALL, 0, RIM);
  wall(CRATE_WALL, CRATE, -RIM, 0);
  wall(CRATE_WALL, CRATE, RIM, 0);

  // Corner posts, running from the ground to the underside of the lip. What a
  // stack of these interlocks by — and, at this camera, the vertical that keeps
  // a box from reading as a plain cube.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(look.post, [POST, CRATE_DECK + WALL_H, POST],
        [sx * RIM, (CRATE_DECK + WALL_H) / 2, sz * RIM]));
    }
  }

  // ...and the rim itself, proud of both faces and the brightest thing on the
  // box. From a 40° camera this band is most of what you see of an empty crate,
  // and it is the one part of it that catches a lamp after dark — which is what
  // stops a cool grey tote going the way the black conveyor did at night.
  //
  // Wider than the posts are, or the rim is no longer the outermost thing on the
  // box and the corners cut through the one line that reads as moulded. Two bars
  // run the long way to the outside of the corners and two BUTT between them,
  // where the mesh had all four overlapping: the flat drawing sorts faces by
  // depth, so two bars crossing at a corner are painted in whichever order their
  // centres happen to fall and the joint showed as a step. Butted, the rim is
  // the same closed band from every angle either way.
  const lip = (sx, sz, px, pz) => parts.push(box(look.lip, [sx, LIP, sz], [px, LIP_Y, pz]));
  lip(LIP_SPAN, LIP_T, 0, -RIM);
  lip(LIP_SPAN, LIP_T, 0, RIM);
  lip(LIP_T, LIP_SPAN - LIP_T * 2, -RIM, 0);
  lip(LIP_T, LIP_SPAN - LIP_T * 2, RIM, 0);

  return parts;
}
