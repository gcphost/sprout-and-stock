/**
 * THE SHAFT, AS NUMBERS — because it is the one piece in the catalog whose
 * `fixtures` row is never opened.
 *
 * A `lift` has a row with a model on it, a tier ladder, a price and a name, and
 * `conveyorBody` throws the model away (`if (f.kind === 'lift') body = []`): the
 * housing is assembled in code from the constants below, wearing `CONVEYOR.*`
 * out of `palette.js`. That is a decision rather than an oversight — the
 * assembly depends on which sides are connected and on which storeys the run
 * reaches, which is a fact about the shop that no authored part list can carry.
 *
 * What it cost is the PALETTE. `client/thumb.js` draws every button from its own
 * catalog row, which is the only honest way to tell two shelves apart — and for
 * the one piece whose row nothing reads, "its own row" is a picture of whatever
 * the art used to be. The lift's button went on showing the four-post tower the
 * glazed cabinet replaced, and no signal anywhere said so: the row validates,
 * the model resolves, the button renders, and the shop draws something else.
 *
 * So this file is the half `EDGE_STYLE` already is for walls. A wall owns no row
 * either, and `artForEdge` builds its button from the record the renderer builds
 * walls from — the SHAPE is the button's, every number in it is not. Same split
 * here: `liftParts` is thumb.js's own assembly, out of the constants scene.js
 * assembles from, so the two cannot disagree about a height, a span or a colour.
 * They can still disagree about the arrangement, which is why the button is
 * deliberately the STANDALONE case — a lift with nothing plumbed into it, all
 * four faces closed, which is exactly what you get for the money at the moment
 * you press the button.
 *
 * Nothing in here imports three.js, and that is load-bearing:
 * `scripts/build-favicon.js` runs thumb.js in node.
 */

import { CONVEYOR, GLASS, conveyorAccent } from './palette.js';

/** Where the top of the track is — what a machine's side walls stand on. */
export const BELT_TOP = 0.09;

/**
 * An overhead duct's glazing: how far out from the middle of the cell a pane
 * stands, how thick it is, and how high it goes.
 *
 * `DUCT_HALF` is the one worth a sentence. It clears the widest crate rather
 * than the widest track — a box wedged into its own casing is the "crate
 * floating beside the rails" complaint with the panes doing the floating — and
 * it stops short of the tile edge, so two runs laid side by side read as two
 * ducts rather than as one glass wall down the aisle.
 */
export const DUCT_HALF = 0.34;
/** The clear span from one side pane's centre-line to the other. */
export const DUCT_SPAN = DUCT_HALF * 2;
export const DUCT_PANE = 0.02;
/** The casing's outside width, including the thin side-pane itself. */
export const DUCT_FLOOR = DUCT_SPAN + DUCT_PANE;
/** The small floor strip from that square to the edge of a conveyor cell. */
export const DUCT_EDGE = (1 - DUCT_FLOOR) / 2;
/** A vertical arm wall runs from the centre casing to the cell boundary. */
export const DUCT_ARM = 0.5 - DUCT_HALF;
export const DUCT_WALL = 0.3;
/** Shared basket geometry for ordinary and machine-backed elevators. */
export const ELEVATOR_BASKET_HALF = DUCT_HALF;
export const ELEVATOR_BASKET_SPAN = ELEVATOR_BASKET_HALF * 2;
/** Clear square in the upper basket floor for the rising crate carrier. */
export const ELEVATOR_OPENING = 0.42;
export const ELEVATOR_BOX_TOP_H = 0.035;
/**
 * How tall a shaft stands, and the number is the TUNNEL MOUTH's.
 *
 * A lift and a mouth are the same machine pointed opposite ways — the note on
 * `buildPiston` says so about the hardware inside them — and they stand side by
 * side in the same aisle, so the two housings disagreeing about their own height
 * reads as one of them being the wrong piece rather than as two heights. The
 * mouth's is authored (`under`, whose cap ring and drive both top out here) and
 * the lift's is procedural, so this is where they are made to agree; the lamp
 * bars that lie on that cap are measured off it too. The lift's walls stand on
 * the track they are fed by rather than on the ground, so `BELT_TOP` is what
 * comes off it — the nominal rail height, which is what a shaft with no run
 * attached yet falls back to as well.
 *
 * It also buys the doorway. A crate is a box with the shopping standing proud of
 * it, and at 0.32 the housing was shorter than the goods going through it: what
 * you watched was a box clipping the lintel of the machine it was entering.
 */
export const MACHINE_CAP_TOP = 0.63;
export const ELEVATOR_BASKET_H = MACHINE_CAP_TOP - BELT_TOP - ELEVATOR_BOX_TOP_H;
export const ELEVATOR_OPENING_BORDER = 0.035;
export const ELEVATOR_OPENING_BORDER_H = 0.018;
/**
 * ...and the doorway is the LID'S HOLE stood on its end.
 *
 * The same crate goes through both — in across the track, out up the shaft — so
 * one number is the whole of what either has to clear, and a door authored
 * separately is a second answer to a question with one.
 */
export const ELEVATOR_PORTAL_H = ELEVATOR_OPENING;
export const ELEVATOR_LID_BEZEL = 0.055;
export const ELEVATOR_LID_BEZEL_H = 0.022;
export const ELEVATOR_FACE_TRIM_D = 0.018;
export const ELEVATOR_FACE_TRIM_H = 0.035;
/** The pane in a closed face, and its height is a FRACTION of the wall — a
 *  literal left behind by a taller housing is a porthole in a blank slab. */
export const ELEVATOR_WINDOW_W = 0.56;
export const ELEVATOR_WINDOW_H = ELEVATOR_BASKET_H * 0.7;
export const ELEVATOR_TRACK_W = 0.26;
export const ELEVATOR_TRACK_H = 0.03;
export const ELEVATOR_PISTON_OUTER = 0.13;
export const ELEVATOR_PISTON_INNER = 0.07;
export const ELEVATOR_PISTON_OUTER_MAX = 0.72;
export const ELEVATOR_PISTON_PLATFORM = ELEVATOR_OPENING - 0.07;
export const ELEVATOR_PISTON_PLATFORM_H = 0.035;
export const ELEVATOR_PISTON_PAD = 0.18;
export const ELEVATOR_PISTON_PAD_H = 0.012;
export const ELEVATOR_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * A square ring, as four boxes.
 *
 * The renderer extrudes one continuous shape (`squareRingGeometry`) and says
 * why — four transparent bands meeting at a mitre show their seams. Nothing in
 * a 34px button is transparent enough for that to be visible, and a picture
 * assembled out of boxes is what `draw` takes, so the ring is spelled the way
 * `WELL_COLLAR` spells the same shape: two full-width bands and two short ones
 * between them.
 */
function ring(color, outside, inside, height, y) {
  const t = (outside - inside) / 2;
  const off = (inside + t) / 2;
  return [
    { shape: 'box', color, pos: [0, y, -off], scale: [outside, height, t] },
    { shape: 'box', color, pos: [0, y, off], scale: [outside, height, t] },
    { shape: 'box', color, pos: [-off, y, 0], scale: [t, height, inside] },
    { shape: 'box', color, pos: [off, y, 0], scale: [t, height, inside] },
  ];
}

/**
 * What a lift looks like standing on its own, as model parts.
 *
 * The STANDALONE case on purpose — see the header. Every side is closed, so
 * every side is a window, which is `addElevatorAssembly`'s `else` branch: four
 * bands of frame around a pane, rather than one slab with a rectangle on it.
 * The piston is drawn at rest, which is `levels[0].y` there and `BELT_TOP` here
 * for the same reason (a shaft with no run attached falls back to the nominal
 * rail height), and it reads through the glass — which is the whole argument for
 * glazing the closed faces at all: the carrier is the only part of a lift that
 * ever moves.
 *
 * The accent follows `addElevatorAssembly`'s own ladder rather than a second
 * one: a stock lift wears the carrier grey and the family teal starts at rung 2,
 * so a button and the machine it buys agree about which rung you are looking at.
 */
export function liftParts(tier = 1) {
  const frame = CONVEYOR.basket;
  const rail = CONVEYOR.carrier;
  const accent = tier > 1 ? conveyorAccent(tier) : rail;
  const base = BELT_TOP;
  const parts = [];

  // Four closed faces. A pane with a sill, a header and two jambs round it.
  const jamb = (ELEVATOR_BASKET_SPAN - ELEVATOR_WINDOW_W) / 2;
  const sill = (ELEVATOR_BASKET_H - ELEVATOR_WINDOW_H) / 2;
  const mid = base + ELEVATOR_BASKET_H / 2;
  for (const [dx, dz] of ELEVATOR_SIDES) {
    const wx = dx * ELEVATOR_BASKET_HALF;
    const wz = dz * ELEVATOR_BASKET_HALF;
    for (const s of [-1, 1]) {
      parts.push({
        shape: 'box',
        color: frame,
        pos: [wx, mid + s * (ELEVATOR_WINDOW_H + sill) / 2, wz],
        scale: [dx ? DUCT_PANE : ELEVATOR_BASKET_SPAN, sill,
          dz ? DUCT_PANE : ELEVATOR_BASKET_SPAN],
      });
      parts.push({
        shape: 'box',
        color: frame,
        pos: [wx + (dz ? s * (ELEVATOR_WINDOW_W + jamb) / 2 : 0), mid,
          wz + (dx ? s * (ELEVATOR_WINDOW_W + jamb) / 2 : 0)],
        scale: [dx ? DUCT_PANE : jamb, ELEVATOR_WINDOW_H, dz ? DUCT_PANE : jamb],
      });
    }
    parts.push({
      shape: 'box',
      color: CONVEYOR.glass,
      alpha: GLASS,
      pos: [wx, mid, wz],
      scale: [dx ? DUCT_PANE : ELEVATOR_WINDOW_W, ELEVATOR_WINDOW_H,
        dz ? DUCT_PANE : ELEVATOR_WINDOW_W],
    });
  }

  // The carrier, at rest, level with the track it would be fed by. Its sleeve
  // has barely emerged — that IS the rest pose, and a button showing a shaft
  // half way up is a picture of a lift mid-journey.
  parts.push({
    shape: 'box',
    color: frame,
    pos: [0, base - ELEVATOR_PISTON_PLATFORM_H / 2, 0],
    scale: [ELEVATOR_PISTON_OUTER, 0.01, ELEVATOR_PISTON_OUTER],
  });
  parts.push({
    shape: 'box',
    color: rail,
    pos: [0, base, 0],
    scale: [ELEVATOR_PISTON_PLATFORM, ELEVATOR_PISTON_PLATFORM_H,
      ELEVATOR_PISTON_PLATFORM],
  });
  parts.push({
    shape: 'box',
    color: rail,
    pos: [0, base + ELEVATOR_PISTON_PLATFORM_H / 2 + ELEVATOR_PISTON_PAD_H / 2, 0],
    scale: [ELEVATOR_PISTON_PAD, ELEVATOR_PISTON_PAD_H, ELEVATOR_PISTON_PAD],
  });

  // The frame round the carrier's own square, the lid it rises through, and the
  // raised collar that gives that lid a second step.
  parts.push(...ring(accent,
    ELEVATOR_OPENING + ELEVATOR_OPENING_BORDER * 2, ELEVATOR_OPENING,
    ELEVATOR_OPENING_BORDER_H,
    base - ELEVATOR_TRACK_H / 2 + ELEVATOR_OPENING_BORDER_H / 2));
  parts.push(...ring(frame, DUCT_FLOOR, ELEVATOR_OPENING, ELEVATOR_BOX_TOP_H,
    base + ELEVATOR_BASKET_H + ELEVATOR_BOX_TOP_H / 2));
  parts.push(...ring(accent,
    ELEVATOR_OPENING + ELEVATOR_LID_BEZEL * 2, ELEVATOR_OPENING,
    ELEVATOR_LID_BEZEL_H,
    base + ELEVATOR_BASKET_H + ELEVATOR_BOX_TOP_H + ELEVATOR_LID_BEZEL_H / 2));

  return parts;
}
