/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, PAD_MARK, FIXTURE_LOOK, EDGE_STYLE, CEILING_Y, GLASS, CONVEYOR, CONVEYOR_LIT, bondOf, brickBond, edgeBands, jitter, faceColor, patternColor, shade, stripeBars, stripeDuty, tuftDensity, tuftBlade } from './palette.js';
import {
  buildModel, buildCharacter, buildStack, buildShelfGoods, shelfShow,
  buildBubble, buildCashDrop, buildVehicle,
  buildStationBays,
  buildTextSprite, setTextSprite, buildMoneyLabel, moneySaid,
  buildPallet, CRATE_STEP, BELT_DECK, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, buildEdgeArrow, buildCageMarker, buildWorkSpot, disposeGroup, material,
  buildGrowthBar, setGrowthBar,
  buildRipple,
  buildStamp,
  buildFootMark,
  buildPadGlyph,
  weld, paintLit,
} from './props.js';
import { Heat } from './heat.js';
import { T } from '../../shared/tiles.js';
import {
  FIXTURES, workSpots, flowSpots, conveyorNext, conveyorAt, conveyorsOf, conveyorBranches, tunnelExit, CONVEYOR_KINDS, derivedFlow, anchorTile, spotsOf, canPlace, turn, rot4, groundIndex, groundKindOfTile, isProp, shelfKind, GOODS_PADS, isPadAt, isWalkableTile,
  SPUR_UNIT_REACH, SPUR_OPEN_REACH,
  faceKey, covers, footprintMid, sizeOf, deckOf, CEILING, armReach,
} from '../../shared/build.js';
import { pieceFor, surfaceOf } from '../../shared/pieces.js';
import { hash01 } from '../../shared/hash.js';
// Only for the wall's own thickness, which the paint ghost has to stand proud
// of — see `setFaceGhost`. Everything else in here reads edge kinds as the raw
// numbers the layout carries, through `EDGE_STYLE`.
import { E, SOLID, edgeBetween } from '../../shared/edges.js';
import { Lights, emittersIn, BAKED_LAYER } from './lights.js';
import {
  isStaged, stageIndexAt, tierProgress, partsAt, modelHeight, modelBounds, surfacesAt, drawableBoards,
  boardsForShare,
  variantModel, variantWork, skinKey,
} from '../../shared/model.js';
import { SIGNAL_NAMES, signalValue } from '../../shared/signals.js';
import { buildTileGrid, disposeTileGrid } from './tile-grid.js';
import { buildPastimeProp, animateRest } from './pastime.js';
import { buildLoopingProp, animatePuffs, animateMotion } from './motion.js';

/** How many world tiles fit vertically on screen at 1× zoom. Smaller = closer in. */
const FRUSTUM = 17;

/**
 * Zoom rides on `camera.zoom` rather than on FRUSTUM, so the frustum stays a
 * fixed statement about the world and only resize() ever recomputes it. Three's
 * `unproject` already folds zoom into the inverse projection, which is why
 * pickTile and pickFixture keep working at any zoom without knowing it exists.
 */
const RING_Y = 1.2;           // charge ring height — just clear of a head at 0.96

/**
 * How high up whoever the camera is riding on it actually AIMS.
 *
 * The follow point used to be their feet — `y: 0`, the tile they are standing
 * on — which is the honest answer to "where are they" and the wrong one to
 * frame a picture on. Zoom is a scale about the look point, so at the far end
 * of the wheel the thing held perfectly still in the middle of the screen was
 * the floor, and the person grew up and off the top of it: the closer you went,
 * the less of them you could see, which reads as the zoom being aimed at the
 * wrong place because it is.
 *
 * Chest height rather than the crown (a head is about 0.96): the camera looks
 * down a fixed offset, so aiming at the very top of somebody puts their feet
 * out of frame the moment you zoom, and what you want centred is the body — the
 * thing you are driving — not the point it ends at.
 */
const EYE_Y = 0.8;
/**
 * How thick a coat of paint is drawn, in tiles.
 *
 * Small enough to read as a finish rather than as cladding — a wall is 0.17
 * across, so this is a twelfth of it — and large enough to survive the depth
 * buffer at the far end of a grown shop. Not zero, and it cannot be: a plane
 * exactly on the wall's own face z-fights with it, which shows up as the wall
 * strobing while the camera turns and not at all in a screenshot.
 */
const SKIN = 0.015;

/**
 * How far a wall's surface stands into the cell beside it — see `artSetback`.
 *
 * Half a wall's thickness (0.17 / 2), plus the finish that may be laid on it and
 * the course of brick that may stand proud of THAT, which is the worst case and
 * the right one to seat art against: a shelf that clears a bare wall and clips
 * the moment you paint it is a bug you would find while decorating, which is the
 * one time nobody is looking at the shelf.
 *
 * Derived from the same two numbers `addEdges` builds with rather than typed, so
 * a wall that gets thicker takes its clearance with it. `EDGE_STYLE[E.WALL].t`
 * and not the shutter's 0.2: a roller door is a way THROUGH, so nothing is ever
 * backed onto one.
 */
const WALL_FACE = (EDGE_STYLE[E.WALL].t + SKIN) / 2 + SKIN * 1.7;

/**
 * The ceiling on planted blades, across the whole world.
 *
 * `MAX_LIGHTS`' opposite number, decided for the same reason and at the same
 * time: before there is a catalogue of lawns to trip over it. A `tufts` design
 * is cells × `density`, ground is the biggest thing in the world by cell count,
 * and `buildWorld` runs on every wall segment of a drag — so this multiplies the
 * one buffer that gets rebuilt most often in the game. Finding the number
 * afterwards means finding it as "building got choppy after I painted the back
 * field", which reads as build mode being slow rather than as one design being
 * greedy.
 *
 * 9000 is roughly a 45×45 world planted at the default six, which is a bigger
 * lawn than anybody has. Past it `addTufts` plants every Nth cell rather than
 * refusing, so the failure mode is a thin meadow and never a bare one.
 *
 * It came down from 12000 when a blade stopped being one triangle and became a
 * curved strip of eight — the cap is about triangles as much as about buffer
 * writes, and the shape got three times heavier in the same breath it got
 * right. Roughly 216k triangles at the ceiling, in one draw call.
 */
const MAX_TUFTS = 9000;

/**
 * How fast the wind travels across the world, and how far a blade leans.
 *
 * The lean is in tiles at full height and eased to nothing at the root, so a
 * blade bends rather than slides — a tuft that translated whole would read as
 * the ground moving under it. Small: this is a breeze in a shop garden, not
 * weather, and anything you can actually *watch* becomes the thing your eye
 * goes to in a scene where the interesting motion is people.
 */
const WIND_SPEED = 0.9;
/**
 * In BLADE-HEIGHTS, like everything else about a tuft — so a meadow blade and a
 * lawn blade bend by the same proportion and the tall one visibly moves further.
 * It was in tiles while the geometry was, which made it a lean you could not
 * see on short grass and a thrash on long.
 */
const WIND_LEAN = 0.16;

/**
 * How close to a pile of goods counts as pointing at it (`nearestBoard`).
 *
 * Pixels, not tiles: the thing being fixed is how hard a small target is to hit
 * with a mouse, which is a distance on the screen, and a distance in the world
 * is a different number at every zoom.
 *
 * The ceiling on it is the OTHER answer, not fairness between the piles. A
 * board's stock stands on a shelf about a tile deep, and the frame, base and
 * end panels around it are what still open the unit's own menu — so a radius
 * wide enough to swallow those has taken the menu away on any stocked shelf.
 * Two numbers have failed at each end. 14 covers the whole top of a stocked
 * unit and leaves nowhere to press for the menu; no bound at all is worse
 * again, because "nearest pile on this fixture" across a three-tile shelf run
 * lights a cage at the far end of it. 4 was the first honest answer and is
 * tight; 7 is the same idea with a hand's tremor in it, and it is affordable
 * because a pile you have PRESSED stays picked (`pick`, client/main.js) — the
 * radius only does work on the first press of a board. Anything that raises
 * this has to check the same thing it always did: can you still open a FULL
 * shelf.
 */
const BOARD_SNAP_PX = 7;

/**
 * Which cage a marker mode draws when it is about one PILE rather than a unit.
 *
 * A board is marked by a box round the goods whatever the question is, so the
 * mode cannot simply pass through — but the question still differs, and this is
 * the one line where it is said: `aim` is where your hand is, `picked` is what
 * you pressed. Anything not in here is a unit-level mode that has landed on a
 * board by accident and gets the plain amber cage, which is the old behaviour.
 */
const BOARD_LOOK = { aim: 'board', picked: 'boardPicked' };

/** Where a pile of takings sits: on the counter, not inside it. Its label
 *  hangs a fixed distance over the same spot, so the two cannot drift apart. */
const CASH_Y = 0.95;
const ZOOM_MIN = 0.7;         // wider than the old fixed view, for finding things
const ZOOM_MAX = 12.0;        // ~1.4 tiles tall: a bot fills two thirds of it
const ZOOM_DEFAULT = 1.45;    // ~12 tiles tall: the shop, not the whole county
/** Per notch. Multiplicative, so a notch is the same *proportion* in or out. */
const ZOOM_STEP = 1.12;

/**
 * ...and one rung past the last one, the view goes INSIDE whoever it is riding.
 *
 * This is the one place in the game with a second camera, and the reason is
 * written three hundred lines up in `PITCH_MIN`: a view with no ground left in
 * it "is a first-person camera wearing an orthographic projection, and reads as
 * the tilt being broken". That was said as an argument for a floor on the tilt
 * and it is just as true said forward — an ortho camera at eye height has no
 * perspective in it at all, so an aisle does not converge, a shelf two tiles
 * away is drawn exactly the size of the one you are touching, and what you get
 * is not a person's view of a shop, it is a very tight crop of the same
 * picture. There is no number you can put in `FRUSTUM` that fixes that, because
 * the thing missing is the projection.
 *
 * So first person is a `PerspectiveCamera` and everything else is untouched.
 * That costs less than it sounds: `pickTile`, `pickFixture` and `pickPerson` go
 * through `Raycaster.setFromCamera`, and the readouts go through `project` —
 * both of which take either camera and neither of which knows which one it has.
 * The three places that genuinely read an orthographic frustum (`resize`,
 * `panBy`'s pixels-to-tiles, and the edge arrows' screen scale) name `this.ortho`
 * rather than `this.camera`, which is what keeps them honest when the active
 * camera is the other one.
 *
 * `FPV_Y` is EYE HEIGHT and not `EYE_Y`. The follow point is chest height on
 * purpose — it is what you want a picture *centred* on — and a camera put there
 * is a camera in somebody's ribcage. A head is about 0.96, so this is just
 * under the crown.
 *
 * The near plane has to be small or the shelf you are standing at is clipped
 * away — at the ortho default the whole aisle would be — and it cannot be
 * arbitrarily small either, because near/far is what the depth buffer's
 * precision is spent on. 0.06 of a tile is about an inch of shop.
 */
const FPV_FOV = 74;
const FPV_Y = 0.88;
const FPV_NEAR = 0.06;
const FPV_FAR = 400;
/**
 * How far up and down you may look, in radians.
 *
 * Short of straight up for `PITCH_MAX`'s reason exactly — at 90° `lookAt`'s up
 * vector is parallel to the view and the yaw stops being defined — and short by
 * a lot more than that guard needs, because a first-person camera looking at
 * its own feet or at the sky is a screenshot of nothing. 68° still puts the top
 * of a shelf and the floor at the end of an aisle in frame.
 */
const FPV_PITCH_MAX = 68 * (Math.PI / 180);

/**
 * Radians per pixel of drag, for looking around in there.
 *
 * A number of its own rather than the ortho drag's, because the two gestures
 * are not the same gesture. Out there a drag turns *the shop*, which is an
 * object at arm's length; in here it turns your head, and a head that swung a
 * shop's worth of degrees per pixel would be unusable. Roughly a quarter turn
 * across a 340px drag.
 */
const FPV_LOOK = 0.0046;

/**
 * HOW HARD THE VIEW CHASES WHAT IT IS AIMED AT, per frame, and the same four
 * numbers again for somebody with a capture running.
 *
 * These were four literals scattered down `render` and they are gathered here
 * because cinema needs a second set of them, and a second set written inline
 * beside the first is four `? :` in the hottest function in the client.
 *
 * The ORDINARY numbers are what the game has always used and they are tuned for
 * *playing*: a camera that keeps up. You are driving somebody around a shop, so
 * a view that lags behind them is a view you are fighting, and every one of
 * these is set as loose as it can be without the world feeling like it is on a
 * spring.
 *
 * The CINEMA numbers are tuned for the opposite thing, which is that nobody is
 * playing — somebody is recording. A capture is watched back at full speed by
 * people who did not make the inputs, so what reads as responsive to the hand
 * that made it reads as *twitchy* to everybody else: the follow snaps on every
 * step, the turn arrives in a fifth of a second, and a wheel notch is a jolt.
 * Roughly a third of the gain across the board, which is about a 12-frame
 * settle instead of a 4 — a glide you would have put on a dolly.
 *
 * `tilt` is the one that is not a slowdown but a switch. Outside cinema it is
 * 1, meaning the first-person pitch is not eased at all: a drag is direct
 * manipulation and the hand doing it is the easing, which is the argument
 * `spinView` already makes about the yaw. There is nothing to smooth for a
 * player, and everything to smooth for a recording.
 *
 * Each has a FLOOR beside it, and the floor is the half that makes this a pan
 * rather than a drift. A proportional ease is a spring: the step is a fraction
 * of what is left, so it is fastest at the start, asymptotic at the end and
 * NEVER ARRIVES while the thing it chases is still moving. Turn the gain down
 * far enough to look smooth and what you get is a camera permanently a fixed
 * distance behind a walking shopkeeper, sliding about under them — which is
 * exactly "floaty", and turning the gain down further makes it worse rather
 * than better. A dolly does the opposite: it moves at a rate, keeps pace, and
 * lands. So the step is the proportional term OR the floor, whichever is
 * bigger, clamped to what is left — which gives ease-out on a big correction
 * and a steady tracking rate on a small one.
 *
 * The floors are per FRAME, like the gains, because everything in this loop
 * already is. `look` is 0.055 of a tile, which is about 3.3 tiles a second at
 * 60Hz — comfortably above a walk, so the camera locks on rather than trailing.
 * `yaw` is 0.0075 radians, about 26° a second: a slow pan you would have set on
 * a tripod, and the gain above it is what takes over when you throw the drag.
 *
 * The gains went back UP when the floors went in. They were low because low was
 * the only smoothing knob there was; with a floor doing the tracking, the gain
 * is only shaping the ease-out, and a low one there is what read as syrup.
 *
 * Zoom gets no floor on purpose: it is the one of the four that is never
 * chasing a moving target — a wheel notch is a fixed distance, so the spring
 * arrives on its own and a floor would only put a snap on the last of it.
 */
const EASE = {
  look: 0.08, lookMin: 0, yaw: 0.14, yawMin: 0, zoom: 0.18, tilt: 1, tiltMin: 0,
};
const CINE_EASE = {
  look: 0.09, lookMin: 0.055, yaw: 0.10, yawMin: 0.0075, zoom: 0.09, tilt: 0.12, tiltMin: 0.006,
};

/**
 * Move a number toward another by `gain` of the gap, never slower than `floor`
 * and never past it. One spelling, because the yaw and the pitch are the same
 * move and a floor applied to one of them is a camera whose two axes disagree
 * about what kind of camera it is.
 */
function glide(from, to, gain, floor) {
  const d = to - from;
  const step = Math.min(Math.abs(d), Math.max(Math.abs(d) * gain, floor));
  return from + (d < 0 ? -step : step);
}

/**
 * How far the ground runs past the last tile.
 *
 * Sized against the *camera*, not the tile grid: the point is that zooming all
 * the way out can never bring the edge of the world on screen. At ZOOM_MIN the
 * frustum is FRUSTUM/ZOOM_MIN tall (~24 tiles), the pitch stretches that across
 * the ground by 1/sin(pitch), an ultrawide viewport stretches the other axis by
 * `aspect` again (~1.5× at 3:1), and the camera rides on the player, who can
 * stand in the very corner of the grid.
 *
 * The pitch in that sum is `PITCH_MIN` and not the home 40°, which is the half
 * that had to change when the view learned to tilt — and it is the half that
 * had to change AGAIN when the tilt cap came off. 1/sin is 1.56 at the home
 * pose, was 3.63 at the old 16° floor, and is 19.1 at 3°: the flattest view now
 * looks about 232 tiles up the ground from the middle of the screen where the
 * pose this number was first settled against managed 19. What running out looks
 * like is the world ending in mid-air along the top of the screen, at one angle,
 * on one monitor — which is precisely the angle somebody flattens the camera to
 * reach, so an apron left at 120 would have presented as the new tilt being
 * broken rather than as this constant being stale.
 *
 * It's one box either way — the only thing a bigger apron costs is a bigger
 * number in a geometry constructor. Note `pickTile` intersects a mathematical
 * plane rather than this mesh, so no amount of apron can affect aiming.
 */
const GROUND_MARGIN = 320;

// `MODEL_REPLACES_TILE` retired here. It answered "does this fixture's model
// stand instead of the coloured block its tile drew" — a question that only
// existed while a fixture WAS a tile. Nothing stamps one now, so every fixture
// stands on plain ground and draws its own model on top, and a plot's bed is
// the ground rather than something under a model. See FIXTURE_LOOK in
// palette.js for what an undrawn kind falls back to.

/** Usable width inside a plot's frame, and roughly how wide a crop draws. */
const BED_SPAN = 0.64;
const PLANT_FOOTPRINT = 0.4;
/** Past this a bed just reads as "full"; no authored crop comes close. */
const BED_MAX = 12;

/**
 * Units drawn in someone's arms before the pile stops growing and the count
 * carries the rest — the same concession `BED_MAX` makes. Low on purpose: this
 * sits at chest height on a person who is walking, and a stack taller than they
 * are stops reading as carried.
 */
const CARRY_SHOWN = 4;

/**
 * A plain coloured box, for a fixture kind nobody has drawn yet.
 *
 * Deliberately the same box its tile used to draw, so the day a kind becomes
 * buildable it looks like it did before fixtures stopped being tiles — rather
 * than being invisible, which is what "no model" would otherwise mean now.
 */
function plainBlock(look) {
  if (!look || look.h <= 0) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, look.h, 1), material(look.color));
  mesh.position.y = look.h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

/**
 * How tall and how wide a body is, in model units, for aiming at it.
 *
 * The fallbacks are a character's own dimensions and matter more than they
 * look: a model that welded to nothing, or one still loading, would otherwise
 * measure zero and hand `pickPerson` a zero-length spine and a zero grab —
 * somebody standing in plain sight who cannot be pointed at, which is worse
 * than the fixed circle this replaced.
 *
 * The width is the wider of the two ground axes, not the average, because a bot
 * is turned by `facing` and the pick is a screen-space circle around a line: it
 * has no idea which way round the body is, so the only safe answer is the one
 * that covers every angle.
 */
function bodyExtent(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return { footY: 0, headY: 1.5, halfW: 0.34 };
  return {
    footY: Math.min(box.min.y, 0),
    headY: Math.max(box.max.y, 0.4),
    halfW: Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 0.3) / 2,
  };
}

/** Pixels from a point to a line segment — the pointer to a projected spine. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  // Both ends projected to the same pixel — a body seen exactly end-on, or a
  // degenerate model. Fall back to the point, which is the old behaviour.
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Stable small number from an id, so a bed's scatter survives every rebuild. */
function hashId(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
  return Math.abs(h % 997);
}

/**
 * Where to stand `count` plants in one bed, and how big to draw each.
 *
 * A plot showing a single lettuce when it is about to hand you three is a bed
 * lying about its own worth — so the count comes from the yield the plot rolled
 * when it was sown, and the arrangement has to hold anything from one plant to
 * a full tray without either rattling around or growing through the frame.
 */
function plantSpots(count, seed = 0) {
  const n = Math.max(1, Math.min(BED_MAX, count || 1));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const pitch = BED_SPAN / Math.max(cols, rows);
  const scale = Math.min(1, pitch / PLANT_FOOTPRINT);

  const spots = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    // Centre each row on its own width, so a short final row sits in the
    // middle of the bed rather than hanging off one edge.
    const inRow = Math.min(cols, n - r * cols);
    const c = i - r * cols;
    // Deterministic wobble: a perfectly square grid reads as printed rather
    // than planted, and it must wobble the *same* way every rebuild or the
    // whole bed twitches each time the crop crosses into its next stage.
    const wob = (k) => ((Math.sin(seed * 0.7 + i * 12.9898 + k * 78.233) * 43758.5453) % 1) * pitch * 0.15;
    spots.push({
      x: (c - (inRow - 1) / 2) * pitch + wob(1),
      z: (r - (rows - 1) / 2) * pitch + wob(2),
      scale,
    });
  }
  return spots;
}

/**
 * Where the sun sits relative to whatever the camera is looking at.
 *
 * Deliberately *not* rotated with the view: the sun belongs to the world, so
 * spinning the camera walks you around static shadows instead of dragging them
 * with you. It's the one cue that the rotation is a camera move and not the
 * whole farm turning.
 */
/**
 * How many pixels this renderer is willing to draw in one frame, before the
 * device pixel ratio doubles them again.
 *
 * `min(devicePixelRatio, 2)` is the usual advice and it is a rule about the
 * SCREEN when the thing that costs money is the AREA. On a 1440p laptop at dpr 1
 * that is 3.7 megapixels; on a 27" 5K at dpr 2 the same rule asks for 14.7, four
 * times the work for a picture at the same apparent sharpness — and this scene
 * is fill-heavy in every direction at once: MSAA, a second full draw into a
 * 2048² soft shadow map, and up to eight forward lights, each of which is
 * another pass over every fragment. The shop looks identical and walks like
 * treacle, which is exactly the report: fine still, chunky moving.
 *
 * So the budget is on the product. Nothing else in here has to know: `resize`
 * folds it into `setPixelRatio`, so the canvas is still exactly
 * `innerWidth × innerHeight` CSS pixels and every unproject, pick and readout is
 * unchanged.
 *
 * 5.0MP was the first number and it was set by what the RENDERER could afford,
 * which turns out to be the smaller half of the bill. On a retina panel the
 * window compositor is a per-pixel cost too, and it is not in any profile the
 * page can take of itself: measured on a half-screen window, WindowServer was
 * 38% of a core and the GPU process 29%, against 31% for the tab doing the
 * actual drawing. Nothing `performance.now()` can wrap sees either of those —
 * `renderer.render` returns when the commands are SUBMITTED — so a pixel cost
 * reads as free from inside the page and is most of the machine from outside it.
 *
 * 2.5MP is a shade over 1820×1370. A half-screen window on a retina panel lands
 * near dpr 1.6 rather than 2, which is a third fewer pixels through every one of
 * the passes above. This is the dial for that whole family of cost: raise it for
 * sharpness, lower it if a machine is struggling.
 */
const PIXEL_BUDGET = 2.5e6;

/**
 * ...as a ratio, for a window this size.
 *
 * Never ABOVE what the device actually has (2 on a retina panel, 1 on a plain
 * one) — supersampling a display that cannot show it is spending four pixels to
 * draw one — and never below 1, which is the floor a picture stops being sharp
 * at. In between it is whatever the budget affords, so the cost of a frame is
 * roughly flat across monitors instead of scaling with the fourth power of how
 * much somebody paid for theirs.
 */
const pixelRatioFor = (w, h) => {
  const want = Math.min(devicePixelRatio || 1, 2);
  const area = Math.max(1, w * h);
  return Math.max(1, Math.min(want, Math.sqrt(PIXEL_BUDGET / area)));
};

const SUN_OFFSET = new THREE.Vector3(26, 40, 14);

/**
 * How far either side of what the camera is looking at the shadow map reaches,
 * and how many texels it spends doing it. Read by `setupLights`, which is the
 * only place they are applied, and by the two rules below, which is why they
 * are up here rather than inline down there: a span that disagreed with the
 * texel size would leave the snap below rounding to the wrong grid, and nothing
 * on screen would say so beyond the shimmer it was meant to remove.
 */
const SHADOW_SPAN = 30;
/**
 * 1024 rather than 2048, which is a quarter of the depth pass and a quarter of
 * the memory. What it costs is a texel twice as wide over the same 60-tile span,
 * so a shadow edge is a little harder — and this scene is a low sun over boxy
 * geometry at a fixed pitch, which is the case that hides it best.
 *
 * `SHADOW_TEXEL` and `SHADOW_SLIP` are derived from it rather than written down,
 * so the snap grid and the redraw threshold follow it on their own. That is not
 * tidiness: a snap rounding to a grid the map no longer has is the shimmer the
 * snap exists to remove, and it would be invisible in this file.
 */
const SHADOW_MAP = 1024;
const SHADOW_TEXEL = (SHADOW_SPAN * 2) / SHADOW_MAP;

/**
 * The light's own basis, which is constant because `SUN_OFFSET` is: the shadow
 * camera looks from `target + SUN_OFFSET` at `target` with world up, so its
 * right and up axes never depend on where the target has got to.
 *
 * Same construction three.js does in `lookAt`: z away from what is being looked
 * at, x across it, y the remainder.
 */
const SUN_Z = SUN_OFFSET.clone().normalize();
const SUN_X = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_Z).normalize();
const SUN_Y = new THREE.Vector3().crossVectors(SUN_Z, SUN_X);

/** Scratch for the snap in `render`, which runs once a frame. */
const SUN_AT = new THREE.Vector3();

/**
 * Put a point on the shadow map's own texel grid.
 *
 * The shadow camera is parked over whatever the view is looking at, so it slides
 * around the world every frame that you walk. A depth map sampled from a frustum
 * that has moved by a fraction of a texel is a *different* map of the same
 * building — every edge in it resamples — so shadows crawl and fizz along their
 * borders for as long as the camera is moving, which is precisely while somebody
 * is walking. Rounding the frustum's centre onto multiples of a texel, measured
 * along the light's own axes rather than the world's, means the grid stands
 * still in the world and the map moves a whole texel at a time or not at all.
 *
 * The component along the light is left alone: it is the distance from the sun,
 * and rounding it would push the near plane about for nothing.
 */
function snapToShadowTexel(p, out) {
  const a = Math.round(p.dot(SUN_X) / SHADOW_TEXEL) * SHADOW_TEXEL;
  const b = Math.round(p.dot(SUN_Y) / SHADOW_TEXEL) * SHADOW_TEXEL;
  return out
    .copy(SUN_X)
    .multiplyScalar(a)
    .addScaledVector(SUN_Y, b)
    .addScaledVector(SUN_Z, p.dot(SUN_Z));
}

/**
 * One shadow map per this many frames, when nothing has moved far enough to
 * need one sooner. See the constructor and `SHADOW_SLIP`.
 */
const SHADOW_EVERY = 3;

/**
 * ...and how far a body may drift from the shadow it is standing in before that
 * cadence is overruled and the map is drawn on the spot.
 *
 * The cadence was argued from the snapshot rate — 10Hz in, so anything above
 * 20Hz out is redrawing a body that has not moved — and that argument retired
 * the day `ACTOR_CHASE` started easing people every FRAME instead of on every
 * packet. What it leaves is a body sliding smoothly with a shadow that steps
 * along behind it two frames at a time, which is not a shadow anybody reads as
 * stale: it is one that reads as *jittering*, because the only thing on screen
 * to compare it against is the feet it is welded to.
 *
 * A quarter of a texel is the point below which redrawing could not change a
 * pixel of the map anyway. So a shop with somebody walking in it pays for a
 * shadow pass per frame — which is the shop that has a jitter to see — and a
 * still one goes on paying every third frame, which is where the lever was
 * bought and where it still is.
 */
const SHADOW_SLIP = SHADOW_TEXEL / 4;

/** Scratch for `pickPropBox`, which runs per prop per pointer move. */
const BOX_HIT = new THREE.Vector3();

/** Scratch for the follow glide — see `EASE`. Runs every frame. */
const GLIDE_V = new THREE.Vector3();

/** Scratch for the first-person pose, which is rebuilt every frame. */
const FPV_DIR = new THREE.Vector3();
const FPV_AT = new THREE.Vector3();

/** Scratch for `sealedPile`, which fires rays from a pile back at the viewer. */
const SEAL_RAY = new THREE.Raycaster();
// Same reason as `pointerRay`: a raycaster only sees layer 0 out of the box, and
// walls now sit on `BAKED_LAYER`. A ray that could not see a wall would call
// every pile in the shop visible.
SEAL_RAY.layers.enableAll();
const SEAL_DIR = new THREE.Vector3();
const SEAL_FROM = new THREE.Vector3();

/**
 * Where on a pile `sealedPile` looks from, as fractions of its own box.
 *
 * The top face and the two upper corners facing the camera, plus the middle.
 * The top is what matters: a unit with no lid is one whose stock clears its own
 * back panel, and that is the difference the test exists to find. The middle is
 * in so a pile short enough to hide behind its own board still answers.
 */
const SEAL_SAMPLES = [
  [0.5, 0.5, 0.5],
  [0.5, 0.98, 0.5], [0.08, 0.98, 0.08], [0.92, 0.98, 0.08],
  [0.08, 0.98, 0.92], [0.92, 0.98, 0.92],
  [0.92, 0.6, 0.5], [0.5, 0.6, 0.92],
];

/** The camera's home pose. Yaw swings it around Y; pitch raises and drops it. */
const BASE_CAM_OFFSET = new THREE.Vector3(20, 24, 20);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const QUARTER = Math.PI / 2;

/**
 * The home pose, taken apart into the two numbers the camera is actually steered
 * by: how far back it sits, and how far up.
 *
 * Distance is held CONSTANT as the pitch moves — the camera swings along an arc
 * rather than sliding up and down a wall — because an orthographic projection
 * does not care how far away it is and does care about the angle. Keeping it
 * fixed means the near clip, the shadow frustum and the light pool all stay
 * where they were tuned, and the only thing a tilt changes is the one thing it
 * is supposed to.
 */
const CAM_DIST = BASE_CAM_OFFSET.length();
const PITCH_HOME = Math.asin(BASE_CAM_OFFSET.y / CAM_DIST);   // ~40°
/**
 * ...and that pose as an orientation, inverted, which is what every readout in
 * the shop is measured against.
 *
 * `faceCam` records a base quaternion at the moment a thing is built, and what
 * that base means is "square to a camera standing HERE". So the aim for any
 * other camera is the rotation carrying this pose to that one, and this is the
 * half of it that never changes. Built from `BASE_CAM_OFFSET` rather than from
 * the two angles, so it cannot drift from the pose those bases were actually
 * drawn against — it is the same vector the camera starts at.
 */
const HOME_CAM_INV = new THREE.Quaternion()
  .setFromRotationMatrix(new THREE.Matrix4()
    .lookAt(BASE_CAM_OFFSET, new THREE.Vector3(), AXIS_Y))
  .invert();
/**
 * How far the view may be tilted, in radians.
 *
 * The floor used to be 16°, held there on the argument that a view with no
 * ground left in it is a first-person camera wearing an orthographic projection
 * and reads as the tilt being broken. That is a claim about how it *looks*, and
 * the only way to settle one of those is to go and look — so the cap is off in
 * all but name and 3° is the degeneracy guard rather than a taste decision: at
 * 0 the ground plane is edge-on to the camera, which is a plane `pickTile`'s ray
 * runs parallel to and therefore never meets.
 *
 * Two things are honestly worse down there and neither is a bug to fix. The
 * goods on a canopied board go out of sight some way above the floor — see
 * `CAM_RISE` in shared/model.js, which is written against the home pitch and is
 * the one thing here a tilt can make quietly wrong. And the shop occludes
 * itself: at 3° the front row is in front of everything behind it, which is what
 * looking along an aisle means and is the point of going down there at all.
 *
 * What it does cost, in code rather than in taste, is `GROUND_MARGIN` — the
 * apron is sized off 1/sin of this number, and that term went from 3.6 to 19.
 * See the note there.
 *
 * The ceiling used to be 62°, held there on the matching argument: at 90° a
 * fixture is its own footprint and the shop reads as a floor plan, and an ortho
 * camera gives you no perspective back to say which way anything is facing.
 * That is a claim about how it *looks* too, so it went the same way as the
 * floor's — a plan view of your own shop is a thing worth being able to ask
 * for — and 88° is a degeneracy guard rather than a taste decision. At 90° the
 * camera stands directly over what it is looking at, which makes `lookAt`'s up
 * vector parallel to the view and leaves the YAW undefined: three.js nudges its
 * way out of the singularity rather than failing, so what you would get is a
 * view that quietly stops answering the turn keys. Two tiles of horizontal
 * offset is enough that `panBy`'s `hypot(hx, hz)` never reaches its `|| 1`
 * fallback either, which is the same singularity read off the same vector.
 *
 * Honestly worse up there, and neither is a bug to fix: nothing is drawn at an
 * angle any more, so a shelf and a freezer are told apart by their tops alone;
 * and the facing of everything you have placed stops being visible, which is
 * exactly what a floor plan is.
 */
const PITCH_MIN = 3 * (Math.PI / 180);
const PITCH_MAX = 88 * (Math.PI / 180);

/** How far the view may be shoved off the player it follows, in tiles. */
const PAN_LIMIT = 14;

/**
 * How fast the keys fly the view in build mode, in tiles a second at zoom 1.
 *
 * Divided by zoom where it is used, so it is a *screen* speed: the view crosses
 * the frustum in about a second and a half however far out you are, which is
 * the same relationship a drag has and the one the eye is expecting.
 */
const FLY_SPEED = 14;

/** How far past the edge of the world the free camera may look, in tiles. */
const FLY_MARGIN = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Scratch for aiming readouts at the camera, so no frame allocates one. */
const YAW_Q = new THREE.Quaternion();
/** ...and the matrix the tilt half of that aim is read out of. See `faceReadouts`. */
const AIM_M = new THREE.Matrix4();
const ORIGIN = new THREE.Vector3();

/**
 * The press ripple: how long it lives, and the radii it travels between.
 *
 * Short on purpose. This is a receipt for an input, not an effect — long
 * enough to catch out of the corner of your eye while you are already looking
 * somewhere else, short enough that pressing four times in a row does not
 * leave four of them stacked up arguing.
 */
const RIPPLE_MS = 420;
const RIPPLE_FROM = 0.09;
const RIPPLE_TO = 0.46;

/** What the press meant, said in colour. Amber matches the aim marker. */
const RIPPLE_COLORS = { go: '#ffd66b', no: '#e2564a', miss: '#f4efe2' };

/**
 * The stamp: what a fixture does on arriving somewhere.
 *
 * Fired where the thing *landed* rather than where you pressed, which is the
 * one way it differs from every other bit of feedback in here. A press ripple
 * has to beat the round trip because a walk order has nothing else to show for
 * itself; a build already answered the pointer with a green ghost before you
 * committed, so this one's job is the other end — saying the thing is really
 * there. Splitting it across the round trip would draw the mark, wait, and
 * then drop the fixture into it, which reads as two events rather than one
 * impact.
 *
 * The square starts a shop-aisle wide and slams shut on its own tile. Same
 * ease-out the ripple uses, run backwards by swapping the endpoints — fast
 * then settling is what makes a thing read as landing under its own weight.
 */
const STAMP_MS = 300;
const STAMP_FROM = 2.1;
const STAMP_COLOR = '#7cc46a';

/**
 * The drop that lands inside the stamp: fall, then squash, then settle.
 *
 * Two phases because one is not a plop. A model that only scales up arrives
 * without ever having come from anywhere, and one that only falls stops like a
 * lift reaching a floor. `LAND_SQUASH` is a damped bounce on the vertical
 * scale with the horizontal taking the opposite sign, so the thing keeps its
 * volume the way anything soft would.
 *
 * Every model is authored with its base at y=0 — see `buildModel` — so scaling
 * about the group origin squashes it into the floor rather than through it.
 */
const LAND_MS = 340;
const LAND_DROP = 1.2;
const LAND_FALL = 0.42;
const LAND_SQUASH = 0.24;

/**
 * Past this many fixtures moving in one re-flow it is the shop rearranging,
 * not you placing something.
 *
 * A `space` upgrade re-flows the whole building, and a shop where twenty
 * shelves bounce at once reads as the renderer having a fit rather than as
 * anything you did. The cap also covers the first layout of a session for
 * free, though `_fixtureSpots` starting null is what actually says "there was
 * no previous shop to have arrived from".
 */
const STAMP_MAX = 4;

/**
 * The off-screen signposts: how far in from the frame they ride, how big they
 * are drawn, how many at once, and how close two may land before the second is
 * dropped. All four in screen pixels, which is the space the whole feature is
 * decided in — a margin in world units would sit further in the more you zoomed.
 *
 * `EDGE_APART` is the one that is not a taste: a shop is aisles, so half a dozen
 * units that would take your armful are very often in the same *direction* from
 * the camera, and they clamp to the same point on the frame. Drawn, that is one
 * arrow rendered six times; the near one wins and the rest are dropped, which is
 * also what keeps the cap meaning "six directions" rather than "six shelves".
 */
const EDGE_MARGIN = 54;
const EDGE_SIZE = 22;
const EDGE_CAP = 6;
const EDGE_APART = 34;

/** Scratch, so the per-frame pass allocates nothing. */
const EDGE_V = new THREE.Vector3();

/**
 * What the one lorry is filed under.
 *
 * `snapshot().van` is a field rather than a row in a list, because there is one
 * delivery run at a time — so it has no id of its own, and the map that holds
 * every drawn vehicle needs one. A literal that cannot collide with a customer
 * id, which is what every other key in that map is.
 */
const VAN_ID = '@van';

/**
 * How fast a drawn vehicle chases where the server says it is, and how fast it
 * comes round to which way it is pointing. Both per second.
 *
 * Vehicles are eased per FRAME rather than per snapshot, which is the one place
 * they differ from people, and the reason is speed. State lands at 10Hz and
 * `syncActors` lerps toward it there, so a shopper at 1.6 tiles/second advances
 * in sixth-of-a-tile hops six frames apart — small enough that nobody has ever
 * noticed. A lorry at 3.2 does twice that in the same hop, along a straight
 * open lane with nothing beside it, which is where a judder is most visible. So
 * this is the same argument the bobbing markers make in `render`: something
 * that only moves ten times a second reads as the renderer stuttering.
 *
 * The turn is deliberately slower than the chase. `vanRoute` is straight legs
 * with a right angle in the middle of them, so `facing` snaps a quarter turn
 * between two ticks; easing it is what makes that read as a lorry going round a
 * corner rather than as the mesh being swapped for a different one.
 */
const VEHICLE_CHASE = 9;
const VEHICLE_TURN = 5;

/**
 * ...and the same, for people — which the note above says nobody had ever
 * noticed, and which was true right up until the shop stopped being on the same
 * machine as the renderer.
 *
 * A lerp applied where the snapshot lands moves a body ten times a second and
 * not at all in between. Locally that is metronomic, and the hops are a sixth of
 * a tile: invisible. Over a data channel to somebody else's browser the frames
 * arrive at 10Hz *on average* — a few milliseconds early, a few late,
 * occasionally two together — and every one of those irregularities becomes a
 * body that stops and lurches, because the drawing is pinned to the arrival
 * rather than to the clock. What it reads as is a bad connection making the
 * game run badly, when the simulation on the other end is perfectly smooth.
 *
 * 4.3 per second is `1 - e^(-0.1 * 4.3) ≈ 0.35`, which is the constant this
 * replaces, at the rate it used to run. So a shop nobody is sharing looks
 * exactly as it did — the change is that the easing now happens on every frame
 * instead of on every packet.
 */
const ACTOR_CHASE = 4.3;

/**
 * How long a gap between two frames means you were NOT HERE, rather than that
 * one frame was slow.
 *
 * A chase is the right way to draw somebody walking and the wrong way to draw
 * somebody who has moved while nobody was looking. `requestAnimationFrame`
 * stops in a backgrounded tab and the shop does not — the room goes on being
 * watched, so state keeps landing and every `tx`/`tz` keeps moving, while the
 * bodies stay exactly where the last drawn frame left them. Come back and the
 * chase does what it is built to do: eases every shopper and every hire, from
 * where they were a minute ago to where they are now, over the same second it
 * would spend on a single step. What that reads as is the whole shop sliding
 * into place, and the tell is that it happens *only* on returning to the tab.
 *
 * So the clamp on `dt` is not enough on its own. It stops the far worse version
 * of this — a body crossing the world in one frame, a camera fed a minute of
 * pan — and by clamping it also throws away the one number that says which kind
 * of gap this was. Hence a threshold on the RAW gap, read before the clamp: past
 * it, the chase is skipped and everything is put where the shop says it is,
 * which is what a body that moved unobserved should look like.
 *
 * 400ms because it has to sit above the worst honest frame and below anything a
 * person would call being away. A re-flow of a big shop is tens of milliseconds;
 * a tab switch is at minimum the time it takes to switch back. Snapping after a
 * genuine 400ms stall is right anyway — a chase resumed from a half-second-stale
 * position is a glide too, just a shorter one.
 */
const AWAY_MS = 400;

/**
 * Which way to turn a vehicle so its nose points where it is going.
 *
 * Two conventions meet here and neither of them is wrong. A model is authored
 * FACING EAST — nose at +x, length along x — which is the convention every
 * fixture is drawn in and the one `buildFixtureGhost` turns by. A body's
 * `facing` is `Math.atan2(dx, dz)`, which is a +z-forward reading: setting
 * `rotation.y = facing` swings local +z onto the heading, and that is right for
 * a character because its nose is a nub on +z.
 *
 * A quarter turn is the whole difference between them. Worth its own function
 * with its own name because getting it wrong is not subtle in principle and is
 * very subtle in practice: a van is nearly symmetric front to back at this
 * scale and this zoom, so a lorry driving sideways up the border ring still
 * reads as a lorry — a slightly odd one, in a way you would blame on the art.
 */
const vehicleYaw = (facing) => (Number(facing) || 0) - Math.PI / 2;

/**
 * The shorter way round from one angle to another, in radians, −π..π.
 *
 * The double modulo is not superstition. JavaScript's `%` keeps the sign of the
 * *dividend*, so the one-line version of this returns a number below −π
 * whenever the gap happens to be negative enough — and it is only ever that
 * negative when a yaw has wandered a long way from its target, which is exactly
 * the case where an answer outside the range spins the lorry the wrong way. It
 * cannot happen with the angles this is handed today, and "cannot happen today"
 * is how a function ends up wrong the day something else grows a heading.
 */
function turnTo(from, to) {
  const TAU = Math.PI * 2;
  return (((to - from + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

/**
 * Is every board in `mine` matched by one of `theirs` — see `boardProfile`.
 *
 * A multiset rather than a subset, which costs one splice and buys the case an
 * `every(includes)` gets wrong: a unit with two boards at one height and one
 * beside it with a single board at that height are not the same shelving, and
 * a plain `includes` says they are.
 */
function contains(theirs, mine) {
  const left = [...theirs];
  for (const b of mine) {
    const at = left.indexOf(b);
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

/**
 * Does `theirs` carry shelving that `mine` does not — is it a corner?
 *
 * Asked only once `contains` has said the run is all there, so this is the
 * "…and something else besides" half, which is exactly what an L is: the run
 * carries straight on through it and a second wing comes off it.
 *
 * It used to be asked of the AXES the boards run along — an L is a unit with
 * boards running one way and boards running the other — which is true of a
 * freestanding corner and false of every wall-mounted one, because a wall
 * corner's return is a shallow ledge along the shared boundary drawn in the
 * same direction as the wing it returns from. Both wings therefore measured as
 * running the same way and the test answered no for every corner anybody has
 * actually built, while passing for the one variant it was written against.
 * Board for board there is nothing to read wrong.
 */
function carriesMore(theirs, mine) {
  return theirs.length > mine.length;
}

/**
 * One tuft: three blades in a fan, each a narrow strip that tapers and curves
 * over, standing in a unit cube.
 *
 * EVERY NUMBER IN HERE IS A FRACTION OF THE BLADE'S OWN HEIGHT, and that is the
 * one thing worth carrying away from it. The first version authored the tip
 * offset in tiles — `dx * 0.22` — while the instance stretched only y by
 * `blade`. So a blade 0.13 tall leaned 0.22 sideways: a 60° splay, in every
 * direction at once, which draws a yucca. It reads as bad art and it is a unit
 * mismatch, and the reason it is not obvious from the file is that both numbers
 * are small and look like they are in the same space. The instance scale is
 * UNIFORM now (`setScalar`), so object space is blade-heights on all three axes
 * and there is nowhere left for that mistake to hide — a lean is a fraction of a
 * height because it cannot be anything else.
 *
 * A blade is a strip of `SEG` quads rather than one triangle. The triangle was
 * cheaper and it is a *spike*: what makes grass read as grass at this camera is
 * that it bends, and one flat tri has nothing to bend with. The bend is
 * quadratic in t, so it leaves the root vertical and falls away at the tip,
 * which is what a blade under its own weight does — linear reads as a lean and
 * a lean reads as wind that is already blowing.
 *
 * Three per tuft, at 120° with different heights and different bends, because a
 * fan of identical blades is a rosette. Two would be a cross that vanishes
 * edge-on as the view spins — the same bug as spinning a cylinder in
 * `verify:motion`, correct art nobody can see.
 *
 * Built fresh per `buildWorld` rather than shared, because `disposeGroup` frees
 * any geometry that is not in `props.js`'s `GEO` set — a shared one would be
 * disposed out from under the next re-flow.
 */
function tuftGeometry() {
  const BLADES = 3;
  const SEG = 4;             // quads up a blade. 1 is the old spike, 4 curves cleanly
  const HALF = 0.055;        // half-width at the root, in blade-heights
  const BEND = 0.30;         // how far the tip falls away, in blade-heights
  const pos = [];
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + 0.5;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // No two blades in a tuft alike, or the fan is a rosette. Off the index
    // rather than off a hash: the geometry is shared by every instance in the
    // world, so this is the ONE tuft everybody is a copy of, and what varies
    // between them is their own rotation and scale.
    const tall = 0.72 + (b % 3) * 0.14;
    const bend = BEND * (0.6 + (b % 2) * 0.8);
    // Local frame: u runs along the way the blade falls, v across its width.
    const at = (u, y, v) => pos.push(ca * u - sa * v, y, sa * u + ca * v);
    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG;
      const t1 = (i + 1) / SEG;
      const y0 = t0 * tall;
      const y1 = t1 * tall;
      const u0 = bend * t0 * t0 * tall;
      const u1 = bend * t1 * t1 * tall;
      // Never quite to nothing. A true point is a degenerate triangle with no
      // normal, which flat shading renders as a black speck at the tip of every
      // blade in the shop.
      const w0 = HALF * tall * (1 - t0 * 0.88);
      const w1 = HALF * tall * (1 - t1 * 0.88);
      at(u0, y0, -w0); at(u0, y0, w0); at(u1, y1, w1);
      at(u0, y0, -w0); at(u1, y1, w1); at(u1, y1, -w1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * The material a blade is drawn in — and the ONE place in this renderer with a
 * vertex shader of its own.
 *
 * Deliberately not `material()`. That is a cache keyed by colour, shared by
 * every prop in the game, so an `onBeforeCompile` hung on it would set every
 * green thing in the shop swaying — a crate of limes, a hire's overalls, the
 * money tree. Its own cache, keyed the same way, so a lawn and a meadow in the
 * same colour still share one.
 *
 * The sway is in the shader rather than on the CPU because it is the only place
 * it is free. These are the most numerous instances in the world by an order of
 * magnitude, and moving them per frame in JS would mean rewriting the whole
 * instance buffer sixty times a second — for grass. `DoubleSide` because a blade
 * is one triangle with no back to it, and a lawn seen from the other side of the
 * shop would be half missing.
 */
const tuftMaterials = new Map();
function tuftMaterial(color) {
  const key = String(color);
  let m = tuftMaterials.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color),
      flatShading: true,
      side: THREE.DoubleSide,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = WIND_CLOCK;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uWind;`)
        // After `project_vertex` has the instance matrix folded in, `transformed`
        // is still object space — so the lean is applied here, in the space the
        // blade was authored in, and scaled by y so the root stays planted.
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 root = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
            float phase = uWind + root.x * 0.7 + root.z * 0.45;
            float gust = sin(phase) * 0.7 + sin(phase * 2.3 + 1.7) * 0.3;
            transformed.x += gust * ${WIND_LEAN.toFixed(4)} * transformed.y;
            transformed.z += gust * ${(WIND_LEAN * 0.6).toFixed(4)} * transformed.y;
          }`);
    };
    // Two materials that compile to the same program still get separate ones
    // unless three.js is told they are interchangeable, and a program per lawn
    // colour is a recompile stutter the first time each comes on screen.
    m.customProgramCacheKey = () => 'tuft';
    tuftMaterials.set(key, m);
  }
  return m;
}

/**
 * The wind's clock, shared by every tuft material there will ever be.
 *
 * One uniform object rather than one per material, so `animate` advances the
 * wind for the whole world with a single write and a lawn painted mid-session
 * arrives already in step with the one next to it. Seconds.
 */
const WIND_CLOCK = { value: 0 };

/** Day-cycle endpoints, resolved once so syncState allocates nothing. */
const SKY_HIGH = new THREE.Color(PALETTE.sky);
const SKY_DUSK = new THREE.Color(PALETTE.skyDusk);
const SUN_HIGH = new THREE.Color(PALETTE.sunHigh);
const SUN_DUSK = new THREE.Color(PALETTE.sunDusk);
const FILL_HIGH = new THREE.Color(PALETTE.fillHigh);
const FILL_DUSK = new THREE.Color(PALETTE.fillDusk);

/**
 * How much ambient the shop's ceiling is worth to the things that move in it,
 * at midnight. Zero at noon — see `roomFill` in `setupLights` for what it is
 * and `INDOOR_LIFT` in `lights.js` for the half of the same ceiling that is
 * baked into everything standing still.
 *
 * The number is a match to that one rather than a taste: the bake multiplies a
 * surface by `1 + 0.55` at full night, and on a floor under this sun that lands
 * near enough where an extra third of ambient lands. Change either and check
 * both, at dusk, with somebody standing on a shop floor — the failure is not
 * "too dark", it is a person cut out of the ground they are standing on.
 */
const ROOM_FILL = 0.34;

export class Scene {
  constructor(canvas) {
    /**
     * Which storey the pointer works on — see `pickFixtureHit`.
     *
     * Mirrored from `ui.buildDeck` rather than read from it, because the scene
     * has never known about the UI and the one thing it needs is a number. It
     * defaults to the floor, so every press in the game outside build mode is
     * exactly the press it always was.
     */
    this.pickDeck = 0;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Required so the MCP screenshot tool can read the canvas back out.
      preserveDrawingBuffer: true,
    });
    // Refined by `resize` once the canvas has been laid out. Through the budget
    // rather than the bare `min(dpr, 2)` it used to use: on a retina panel that
    // drew the first frames — and every frame before a resize ever fires, which
    // on a window nobody drags is all of them — at four times the pixels the
    // budget allows.
    this.renderer.setPixelRatio(pixelRatioFor(window.innerWidth, window.innerHeight));
    this.renderer.shadowMap.enabled = true;
    // PCF rather than PCFSoft, which is a per-FRAGMENT cost and therefore one of
    // the few things here that scales with the window rather than with the shop:
    // soft takes a wide tap pattern per lit pixel, plain takes a small one. The
    // difference is a slightly tighter penumbra on a scene whose shadows are
    // mostly hard-edged boxes anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    /**
     * The shadow pass is a SECOND full draw of the scene — every object walked,
     * culled and issued again into a 2048² depth map — and by default three.js
     * does it on every single frame. Nothing in this shop justifies that: the
     * building never moves, and the things that do are people ambling at
     * walking pace under a sun that is 40° up. A shadow one frame stale is not
     * a shadow anybody can see is stale.
     *
     * So the map is redrawn on a cadence instead (`SHADOW_EVERY`), which halves
     * the per-frame object work outright. It is the frame budget's single
     * biggest lever and the only one that costs nothing visible.
     */
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowTick = 0;
    // How far the furthest-moved body has travelled since the map was last
    // drawn. See `SHADOW_SLIP`: the cadence is a floor now rather than a rule,
    // because the things this shadow is most obviously *of* move every frame.
    this.shadowSlip = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.sky);

    /**
     * Two cameras, one active. See `FPV_FOV`.
     *
     * `this.camera` is whichever is being drawn through and is what everything
     * outside this file asks — it is handed to every raycast and every
     * `project`, and both take either kind. Anything that reads the ORTHO
     * FRUSTUM has to name `this.ortho` instead, or it is silently asking a
     * perspective camera for a `top` it does not have.
     *
     * The swap is made in `render` rather than in `setFirstPerson`, so there is
     * one line in the game that decides which camera is live and it is the line
     * that also poses it.
     */
    this.ortho = new THREE.OrthographicCamera();
    this.persp = new THREE.PerspectiveCamera(FPV_FOV, 1, FPV_NEAR, FPV_FAR);
    this.camera = this.ortho;
    /** Whether the view is inside somebody's head. See `setFirstPerson`. */
    this.fpv = false;
    /**
     * Where they are looking, in radians off the horizon, as a target/drawn
     * pair like the yaw's — see `EASE.tilt`, which collapses the two into one
     * outside cinema.
     */
    this.fpvAim = 0;
    this.fpvPitch = 0;
    /**
     * Whether a capture is running. Set from client/cinema.js at boot, and the
     * only thing the renderer knows about the mode: everything else it does is
     * a class on `<body>`.
     */
    this.cinema = false;
    /**
     * Whose body is not being drawn, and who it belongs to.
     *
     * The first is an id off the snapshot and the second is the record we
     * actually turned off, held separately: the person the camera rides can
     * change under us (a theft cut, a hire you stopped watching, a rejoin), and
     * a body hidden and then forgotten is somebody permanently invisible with
     * nothing on screen to say why.
     */
    this._eyeId = null;
    this._hidBody = null;
    this.camOffset = BASE_CAM_OFFSET.clone();
    // Where the view is headed, in radians and never wrapped: letting it run
    // past ±2π means easing toward it always spins the short way round on its
    // own, with no shortest-arc special case. It used to be a count of quarter
    // turns, which is what `quarter` now rounds it back into.
    this.camYaw = 0;
    this.camAngle = 0;
    // Pitch has no target/drawn pair, because nothing eases it: only a drag
    // moves it, and a drag is already the hand's own easing.
    this.camPitch = PITCH_HOME;
    this.camTarget = new THREE.Vector3(22, EYE_Y, 17);
    this.camLook = this.camTarget.clone();
    // Whether anybody has claimed the view yet. The camera follows you, and
    // until the first snapshot says where you are it has to look at *something*
    // — which is the shop door, aimed in `buildWorld`. That aim is an opening
    // shot and nothing else: `buildWorld` runs on every re-flow, so without this
    // flag every rotate, move, paint and back-of-house toggle yanked the view a
    // few frames toward the door and let it drift back over the next second.
    // Cheap to miss, because the pull is bounded by how far the door is from
    // where you are standing — at the till it is a twitch, and out on the farm
    // it is half the screen.
    this.camFollowing = false;
    // Whose shoulder it rides on. Null is you, which is every frame anybody has
    // ever played; a hire's roster id is the camera watching them work instead.
    // A roster id rather than a body, because a body is re-sent whole in every
    // snapshot and one held here would freeze the view where they were standing
    // when you pressed it.
    this.watching = null;
    // The theft cut — see `cutTo`. Null is the ordinary camera.
    this.cutOn = null;
    this.cutUntil = null;
    // Where the view has been dragged to, relative to whoever it follows. Kept
    // apart from camTarget because that is overwritten from the player's
    // position every sync — a pan folded into it would be erased 10 times a
    // second. `camAim` is the sum, and exists only so render() adds without
    // allocating a vector every frame.
    this.camPan = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    // Where a restored view wants to be centred, until there is a settled
    // `camTarget` to measure the offset from. See `takeCentre`.
    this._wantCentre = null;
    // Whether that pan is bounded by the world rather than by a radius around
    // the player — build mode, where the view has to reach places nobody can
    // stand. See `setFreeRoam`.
    this.freeRoam = false;
    // What angle the readouts were last aimed at, and whether anything has
    // been built since. Both, because there are two ways to go stale: the
    // camera turns under the existing ones, or a new one is born while the
    // camera is already turned. Missing the second is subtler — the shop is
    // correct, and only the bar on the crop that started growing *after* you
    // turned is edge-on.
    this.readoutAngle = null;
    this.readoutPitch = null;
    this.readoutsDirty = true;
    // Live ground marks — press ripples and build stamps, which are one kind of
    // throwaway outline with two sets of endpoints — plus whatever is currently
    // dropping into place, and how far through a held press we are. All pure
    // feedback: nothing in the world reads them, and dropping them all on the
    // floor would change nothing except how the game feels to press.
    this.ripples = [];
    this.landings = [];
    this.holdProgress = null;
    // Where every fixture stood last time the shop was built, so the next build
    // can tell what arrived. Null rather than empty, because "no previous shop"
    // and "a shop with nothing in it" want opposite answers — see `addFixtureProps`.
    this._fixtureSpots = null;
    // Two values, like camTarget/camLook: where the wheel says we're going, and
    // where we've eased to. Set before resize(), which bakes the projection.
    this.camZoom = ZOOM_DEFAULT;
    this.ortho.zoom = ZOOM_DEFAULT;

    this.setupLights();

    this.staticRoot = new THREE.Group();
    this.actorRoot = new THREE.Group();
    this.scene.add(this.staticRoot, this.actorRoot);

    // Where the shoppers have been. Its own root beside those two, and never
    // under `staticRoot`, which `buildWorld` disposes wholesale: a fortnight of
    // watching must not be thrown away because somebody laid a wall — and
    // build mode re-flows on every segment of a drag, so it would be thrown
    // away constantly and read as the overlay flickering off.
    this.heat = new Heat();
    this.scene.add(this.heat.group);

    // The `?tiles` debug grid, and for exactly the reason the heat sheet gives
    // above: it is added straight to the scene rather than to `staticRoot`, so
    // that a re-flow neither rebuilds it nor — the expensive half — leaks the
    // canvas texture it owns, which `disposeGroup` is deliberately not in the
    // business of freeing. See `buildTileGrid`. Off unless somebody asked.
    this.tileGrid = null;
    this.tileGridOn = false;
    // The dimensions the current sheet was drawn for. Nothing else in the
    // layout can invalidate it, so this is the whole test.
    this.tileGridFor = '';

    this.players = new Map();
    this.customers = new Map();
    // The livestock, and a third map for the third population — never merged
    // into either of the two above, for the reason `Game.animals` gives. Here it
    // costs one line, because `syncActors` has never known what it is drawing.
    this.animals = new Map();
    this.stationProps = new Map();
    // The parts of built fixtures that move under their own steam — a blade, a
    // lever, a fan. Kept as its own index rather than walked out of `staticRoot`
    // every frame, because that is the whole shop and almost none of it moves.
    // Filled by `addFixtureProps` and therefore emptied by it too: the meshes in
    // here belong to groups that a re-flow disposes.
    this.movingFixtures = new Map();
    // The props that watch the shop rather than themselves — a clock, an open
    // sign. Filled and emptied by `addFixtureProps` like the map above, and for
    // the same reason. Small on purpose: nothing walks the shop looking for one,
    // so a building with none of them costs an empty loop a snapshot.
    this.signalFixtures = new Map();
    // ...and what each signal was worth on the last snapshot, so a re-flow can
    // build a sign already showing the right face rather than correcting itself
    // on the next tick. See `syncSignals`.
    this.signals = {};
    // Where each decoration's art actually ended up, by fixture id. Filled and
    // cleared by `addFixtureProps` for the same reason as the map above: it
    // describes meshes a re-flow throws away.
    this.propBoxes = new Map();
    // Markers that come in SETS rather than one at a time — see `setMarkedSet`.
    // Keyed by what the set means ('picked', 'kin') so the two are independent:
    // they are live at once and answer different questions.
    this.markSets = new Map();
    this.shelfProps = new Map();
    // Board shapes by (piece, variant, tier) — see `boardProfile`. Cleared with
    // the scene it describes, so a piece redrawn live is re-read.
    this.profiles = new Map();
    this.plotProps = new Map();
    // A pen's bar, bubble and working prop. Its own map with its own sweep for
    // the reason `stationProps` has one — see `syncPens`.
    this.penProps = new Map();
    this.cashProps = new Map();
    // One label per TILE of money rather than one per pile — see
    // `syncCashLabels`. Keyed by tile for the same reason: the piles under it
    // are picked up one at a time, and a readout that belonged to one of them
    // would leave with it while the rest of the money was still sitting there.
    this.cashLabels = new Map();
    this.deliveryProps = new Map();
    // The lorry on its run and the cars in the car park, in one map, because
    // they are one thing — see `syncVehicles`. In `actorRoot` with the other
    // props, and NOT cleared by `buildWorld`: a vehicle is positioned from the
    // snapshot rather than from the layout, so a re-flow neither moves one nor
    // takes one away, which is what `refreshFixtureProps` exists to cope with
    // for the props that are hung off a fixture id.
    this.vehicleProps = new Map();
    this.actionRings = new Map();
    this.catalog = { items: {}, crops: {} };
    this.layoutVersion = -1;

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setupLights() {
    // Kept on `this` because the day cycle drives its intensity *and* colour —
    // a fixed white 0.9 fill was most of why the sun was invisible: it swamped
    // everything the sun did, so dusk only ever got very slightly greyer.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(this.ambient);

    const sun = new THREE.DirectionalLight(0xfff4dd, 1.15);
    sun.position.set(26, 40, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const s = SHADOW_SPAN;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 110 });
    sun.shadow.bias = -0.0012;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    // A cool bounce light so shadowed faces aren't muddy.
    const bounce = new THREE.DirectionalLight(0xbcd8ff, 0.32);
    bounce.position.set(-18, 12, -14);
    this.scene.add(bounce);

    /**
     * The shop's own ceiling, for everything a bake cannot reach.
     *
     * `INDOOR_LIFT` lights the room by folding a lift into the colours of the
     * things that never move — floor, fixtures, belts. That is most of what you
     * look at and none of what walks about in it: people, crates, and the goods
     * standing on every shelf are rebuilt every sync out of colours nothing
     * baked. Left out they would be silhouettes on a lit floor, which is worse
     * than the dark room this is fixing.
     *
     * Layer 0 is the whole of the aim, and it is a fact about this renderer
     * rather than a trick: everything static was moved onto `BAKED_LAYER` so the
     * lamp pool could not light it twice, so what is left on layer 0 is exactly
     * the movers — plus the walls, which want this anyway, and the apron, which
     * is why that got moved (see `buildWorld`).
     *
     * What it cannot do is tell inside from out. A shopper on the road at dusk
     * takes the same lift as one at the till, because an ambient light is one
     * number for everything it touches and the alternative is a layer flag
     * rewritten per body per frame. It is small, it is warm, and against a farm
     * that is genuinely dark it reads as somebody standing in the spill from the
     * shop windows. If that ever stops being true, the honest fix is per-body,
     * not a bigger number here.
     */
    this.roomFill = new THREE.AmbientLight(0xffeacd, 0);
    this.scene.add(this.roomFill);

    // The ground is lit by lamps that were added up on the CPU (`bakeInto`), so
    // it sits on a layer the point lights cannot see or it would be lit twice.
    // The sky is not a lamp and has to be let back in by hand — a layer is a
    // filter on EVERY light, so leaving these three out drops the floor to
    // black. The camera needs it too, or it simply stops drawing the shop.
    for (const l of [this.ambient, sun, bounce]) l.layers.enable(BAKED_LAYER);
    // BOTH cameras, and never `this.camera` — which is whichever one is live
    // and is the ortho every time this runs. A camera is born seeing layer 0
    // only, so a second one added without this line draws the shop with its
    // floor, its walls, its grass and every baked fixture missing: what is left
    // is the apron underneath and the actors on top, which is a green field
    // with people standing in it and shelving hanging in the air. Nothing
    // errors, and it reads as first person being unfinished rather than as one
    // bit not being set. See `FPV_FOV`.
    this.ortho.layers.enable(BAKED_LAYER);
    this.persp.layers.enable(BAKED_LAYER);

    // Whatever the player has wired up. Everything above is the sky; this is the
    // only light in the scene that anybody had to buy.
    this.lights = new Lights(this.scene);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    const aspect = w / h;
    this.ortho.left = (-FRUSTUM * aspect) / 2;
    this.ortho.right = (FRUSTUM * aspect) / 2;
    this.ortho.top = FRUSTUM / 2;
    this.ortho.bottom = -FRUSTUM / 2;
    this.ortho.near = -200;
    this.ortho.far = 400;
    this.ortho.updateProjectionMatrix();
    // Both, always, whichever is live: a camera whose aspect was last set for a
    // window two sizes ago is one that draws the shop stretched for the whole
    // frame you switch to it, which reads as the switch itself being broken.
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    // The ratio is decided HERE and not in the constructor, because it is a
    // question about the window rather than about the monitor — see
    // `PIXEL_BUDGET`. Recomputed on every resize for the same reason: dragging a
    // window from a laptop screen onto a 5K one changes the answer, and a ratio
    // baked at boot would leave that session drawing four times what it should
    // until the page was reloaded.
    this.renderer.setPixelRatio(pixelRatioFor(w, h));
    this.renderer.setSize(w, h, false);
  }

  /**
   * Zoom by a number of notches — positive pulls out, matching the direction a
   * page scrolls. Clamped, so the wheel can be spun without limit and the view
   * simply stops. Returns the new target so the caller can report it.
   */
  zoomBy(steps) {
    // The wheel is the whole gesture: one more notch in at the end of the
    // ladder steps inside, and one notch out steps back. Deliberately NOT a
    // rung on `camZoom` — first person is a different projection rather than a
    // closer one, so a number that ran on past ZOOM_MAX would be a scale nobody
    // is applying, and every reader of `camZoom` would have to know that.
    //
    // Entering has to be a SECOND notch at the top rather than a notch that
    // also reaches the top, or scrolling in from across the shop shoots past
    // the closest ordinary view and into somebody's head in one spin.
    if (this.fpv) {
      if (steps > 0) this.setFirstPerson(false);
      return this.camZoom;
    }
    if (steps < 0 && this.camZoom >= ZOOM_MAX) {
      this.setFirstPerson(true);
      return this.camZoom;
    }
    const z = this.camZoom * ZOOM_STEP ** -steps;
    this.camZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    return this.camZoom;
  }

  /**
   * Zoom by a straight ratio, for a pinch.
   *
   * A pinch already *is* a scale — the fingers say 1.3× — so converting that
   * into wheel notches only to raise ZOOM_STEP to a fractional power throws the
   * exactness away and stops the ground tracking the fingers holding it.
   */
  zoomByFactor(f) {
    if (!(f > 0)) return this.camZoom;
    // A pinch can leave first person and can never enter it, and that asymmetry
    // is the point. A spread is a continuous scale with no notches in it, so
    // there is no "one more" for it to be — the gesture would tip you inside
    // somebody's head at whatever moment your fingers crossed a threshold, with
    // no press anywhere to blame. Getting back out has to work from any input
    // that can move the zoom at all, or a phone with a stray spread on it is a
    // shop you cannot see.
    if (this.fpv) {
      if (f < 1) this.setFirstPerson(false);
      return this.camZoom;
    }
    this.camZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camZoom * f));
    return this.camZoom;
  }

  /**
   * Turn the camera to the next corner of the world, +1 or -1.
   *
   * It lands on the quarter *grid* rather than adding a quarter to wherever the
   * view happens to be, which is the whole difference now a drag can leave it
   * between two corners: a key is how you get the shop square on again, so
   * pressing it from 15° off has to end at 90° rather than at 105°. Rounding
   * first is also what stops a key press being swallowed — from 89° off-grid,
   * `+90` would be a one-degree turn nobody can see.
   */
  rotateView(dir) {
    const q = Math.round(this.camYaw / QUARTER) + Math.sign(dir);
    this.camYaw = q * QUARTER;
    return q;
  }

  /**
   * Turn the camera by an arbitrary angle, for a drag.
   *
   * Unlike `rotateView` this moves the *drawn* angle too, rather than setting a
   * target for the easing to chase. A drag is direct manipulation — the same
   * thing `panBy` is — so the world has to turn under the hand holding it, and
   * a 0.14-per-frame ease between the finger and the shop reads as the view
   * being dragged through treacle. A key press keeps the ease, because there is
   * no hand to keep up with there.
   */
  spinView(rad) {
    if (!rad) return this.camYaw;
    this.camYaw += rad;
    this.camAngle += rad;
    this.aimCamera();
    return this.camYaw;
  }

  /**
   * Raise or drop the camera, for the other axis of the same drag.
   *
   * Clamped rather than wrapped, and clamped *silently*: a drag that has run out
   * of tilt simply stops, the way the zoom does, because a view that bounced or
   * flipped over the top would be a gesture arguing with the hand making it.
   *
   * Positive raises the camera toward straight down. The caller pairs that with
   * dragging *down* the screen, which is the same "world follows your hand" the
   * yaw has: you pull the far side of the shop toward you, and the far side of
   * the shop coming toward you is the camera going up and over it.
   */
  tiltView(rad) {
    // In first person the same drag moves your head instead, and the sign flips
    // because the two are describing the same hand. Out there, dragging down
    // the screen pulls the far side of the shop toward you and the camera rises
    // *over* it — which is a view that ends up looking further DOWN. In here
    // looking further down is a negative pitch, so the drag that meant one
    // means the other, and a shared sign would have the view swing the opposite
    // way the instant you stepped inside.
    if (this.fpv) {
      this.fpvAim = clamp(this.fpvAim - rad, -FPV_PITCH_MAX, FPV_PITCH_MAX);
      return this.fpvAim;
    }
    const p = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.camPitch + rad));
    if (p === this.camPitch) return this.camPitch;
    this.camPitch = p;
    this.aimCamera();
    return this.camPitch;
  }

  /**
   * Rebuild where the camera sits from the two angles it is steered by.
   *
   * One place, because the yaw is moved by a drag and eased by a key press and
   * the pitch is moved on its own — three callers, and a pose rebuilt from
   * `BASE_CAM_OFFSET` in any of them is one that silently throws the *other*
   * angle away. That is the shape of it: tilting and then pressing `.` would
   * stand the camera back up, once, with nothing to say why.
   */
  aimCamera() {
    const flat = Math.cos(this.camPitch) * CAM_DIST;
    this.camOffset.set(flat * Math.SQRT1_2, Math.sin(this.camPitch) * CAM_DIST, flat * Math.SQRT1_2)
      .applyAxisAngle(AXIS_Y, this.camAngle);
  }

  /**
   * How the view is posed, in a shape that survives a reload.
   *
   * Angles are the person's taste and go back exactly. The POSITION is the one
   * that needs thought, and it is stored as where the view is CENTRED rather
   * than as `camPan` — because `camPan` is an offset off whoever it is chained
   * to, and on the next load that is a body which may have moved, or respawned
   * at the door, or been put back by `Game.away` a tile over. Restoring the
   * offset would put the view a consistent distance from a different place,
   * which is the same bug the bay-window trap has: a number that means "from
   * here" stored across the moment "here" changes.
   *
   * `centre` is only worth anything while the view is off its leash — the leash
   * hauls a shopkeeping camera back to your body within a frame — so it is
   * written whatever the mode and read only by a caller restoring `freeRoam`.
   */
  viewState() {
    return {
      pitch: this.camPitch,
      yaw: this.camYaw,
      centre: { x: this.camTarget.x + this.camPan.x, z: this.camTarget.z + this.camPan.z },
    };
  }

  /**
   * ...and back again. Every field optional, because a stored record written by
   * an older build is missing whichever ones did not exist yet, and a view that
   * refused to restore at all over one absent number is worse than a view that
   * restores the two it recognises.
   *
   * `clampPan` is left to do the bounding rather than trusting the stored
   * numbers: a shop can be SMALLER than it was when the record was written —
   * you can take land back — so a centre off the end of the map is an ordinary
   * thing to read back, not a corrupt one.
   */
  applyView({ pitch, yaw, centre } = {}) {
    if (Number.isFinite(pitch)) this.camPitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
    if (Number.isFinite(yaw)) {
      this.camYaw = yaw;
      // The DRAWN angle too, or the ease spends the first second of the session
      // swinging from wherever the camera was built to where you left it — which
      // reads as the shop spinning itself on load.
      this.camAngle = yaw;
    }
    if (centre && Number.isFinite(centre.x) && Number.isFinite(centre.z)) {
      // Held as a WISH rather than applied and forgotten. `camPan` is an offset
      // off `camTarget`, and `camTarget` is not settled when this runs: the
      // layout parks it on the door, and the first snapshot carrying you moves
      // it to your body. Converting to an offset against the door and letting
      // the target move afterwards keeps the offset and loses the centre — so
      // the view ends up `you - door` away from where it was left, and since
      // that new spot is what gets saved, every reload adds the gap again. It
      // reads as the camera walking away from the shop a bit further each time.
      this._wantCentre = { x: centre.x, z: centre.z };
      this.takeCentre();
    }
    this.aimCamera();
  }

  /**
   * Put the view on a tile, because somebody pointed at it.
   *
   * Build mode's answer to a tap on bare floor. There is no easing here and it
   * is not missing: `render` lerps `camLook` toward `camTarget + camPan`, so
   * moving the pan in one step IS the glide — and doing it as a step rather
   * than as an animation means nothing has to be ticked, cancelled when you
   * drag, or reconciled with the drag that is moving the same field.
   *
   * A pending restore is dropped on the way through. Somebody aiming the camera
   * by hand has said where they want to be looking more recently than a record
   * written last session, and letting the restore land afterwards would slide
   * the view off the thing they just pointed at.
   */
  focusOn(x, z) {
    this._wantCentre = null;
    this.camPan.x = x - this.camTarget.x;
    this.camPan.z = z - this.camTarget.z;
    return this.clampPan();
  }

  /** Re-seat the pan so the view sits on `_wantCentre`, against the target as it is NOW. */
  takeCentre() {
    const c = this._wantCentre;
    if (!c) return;
    this.camPan.x = c.x - this.camTarget.x;
    this.camPan.z = c.z - this.camTarget.z;
    this.clampPan();
  }

  /**
   * The nearest corner, normalised to 0..3, for mapping input.
   *
   * Everything that reads this wants an integer — WASD is remapped through it,
   * and so is which way a fixture faces — so a view resting between two corners
   * answers with whichever one it is closest to. That is a rounding rather than
   * a truncation on purpose: "up" should mean the direction that most looks
   * like up, and it flips at 45°, which is exactly halfway.
   */
  get quarter() {
    return ((Math.round(this.camYaw / QUARTER) % 4) + 4) % 4;
  }

  /**
   * Shove the view sideways off the person it follows, by a drag in pixels.
   *
   * The camera rides on the player (`camTarget`, set every sync), so this is an
   * offset *added* to that rather than a second camera — the follow keeps
   * working underneath, and letting go of the pan is one line rather than a
   * handover.
   *
   * Two conversions, and both have to be there or the world slides at the wrong
   * speed and stops feeling attached to your finger:
   *
   * - **pixels to tiles** is the ortho frustum over the canvas height, divided
   *   by zoom, because zoom is on the camera rather than on FRUSTUM.
   * - **screen up to ground** stretches by 1/sin(pitch). At the home 40° a tile
   *   of ground covers only ~0.65 of a tile of screen going away from you —
   *   dragging without this tracks correctly across the screen and lags going up
   *   it, which reads as the ground being slippery. Read off `camOffset` every
   *   call rather than worked out once, because the pitch moves now: a constant
   *   here is a pan that tracks the hand at one angle and slides at every other
   *   one, which presents as the tilt having broken the drag.
   *
   * Directions come off `camOffset`, which is already rotated by whatever the
   * view has been turned to, so a pan after a quarter turn follows the finger
   * rather than the world axes.
   */
  panBy(dxPx, dyPx) {
    // Inside a head there is nothing to pan: the view is chained to a body and
    // `camPan` is held at zero (see `setFirstPerson`), so a drag that moved it
    // would be a gesture with no effect on screen — which is worse than a
    // gesture that is refused, because you go on making it. It looks around
    // instead, which is the same drag doing the same job one projection over.
    //
    // Through `spinView`/`tiltView` rather than writing the angles, so the LOOK
    // and the two keys that turn the view stay one pose: `,` and `.` still work
    // in here, and they still turn you a quarter.
    if (this.fpv) {
      const rad = -dxPx * FPV_LOOK;
      // With a capture running the turn is a TARGET rather than the drawn
      // angle, which is the one place cinema changes a gesture instead of a
      // number: `spinView` writes both on purpose — a drag is the hand's own
      // easing — and that is right for the hand and wrong for whoever watches
      // it back, where every twitch of the mouse is in the recording. Setting
      // `camYaw` alone leaves the ease at the bottom of `render` to chase it,
      // and `EASE.yaw` is what decides how slowly.
      if (this.cinema) this.camYaw += rad;
      else this.spinView(rad);
      this.tiltView(dyPx * FPV_LOOK);
      return this.camPan;
    }
    const upp = (FRUSTUM / this.camZoom) / (this.renderer.domElement.clientHeight || 1);
    const hx = this.camOffset.x;
    const hz = this.camOffset.z;
    const hl = Math.hypot(hx, hz) || 1;
    // Screen-right and screen-up, both on the ground plane.
    const rx = hz / hl;
    const rz = -hx / hl;
    const fx = -hx / hl;
    const fz = -hz / hl;
    const across = -dxPx * upp;
    const away = dyPx * upp * (this.camOffset.length() / this.camOffset.y);
    this.camPan.x += rx * across + fx * away;
    this.camPan.z += rz * across + fz * away;
    return this.clampPan();
  }

  /**
   * Fly the view itself, from a direction the keys named, for `dt` seconds.
   *
   * The build camera. It moves `camPan` exactly as a drag does — same offset,
   * same follow underneath, same one line to let go of it — so the two can be
   * used in the same breath without either snatching the view off the other.
   *
   * `dx`/`dz` arrive already turned by whatever quarter the view is on, and are
   * normalised here so a diagonal is not 1.4× faster than a straight line.
   */
  flyBy(dx, dz, dt) {
    if (!dx && !dz) return this.camPan;
    const len = Math.hypot(dx, dz) || 1;
    const step = (FLY_SPEED / this.camZoom) * dt;
    this.camPan.x += (dx / len) * step;
    this.camPan.z += (dz / len) * step;
    return this.clampPan();
  }

  /**
   * Take the view off the leash, or put it back on.
   *
   * The leash is what makes the follow camera a follow camera, and build mode
   * is the one time it is wrong: the whole reason the view needs to move there
   * is to reach somewhere you cannot stand — a room you have just sealed, the
   * far side of the fence, the end of a grown farm — and a radius around your
   * body cannot express that. So while building, the world is the limit.
   *
   * Putting it back on re-clamps, which matters: leaving build mode from the
   * far end of the farm would otherwise leave you playing somebody who is off
   * screen. The glide back is free, because `camLook` eases toward its aim.
   */
  /**
   * Step into whoever the camera is riding, or back out.
   *
   * Four things are put back on the way in and each is a way for this to look
   * broken rather than to be broken.
   *
   * The ORTHO ZOOM is pinned at its top rung, because that is the view you came
   * from and the view one notch out has to be — a zoom left wherever it
   * happened to be would have stepping out land you somewhere across the shop.
   * The PITCH is zeroed to the horizon: what you were looking at a moment ago
   * was the shop from 40° up, and inheriting that would begin first person
   * staring at the floor. The PAN goes with it, because it is an offset off a
   * body and the whole of this mode is being *at* that body — a view dragged
   * six tiles out and then stepped into would put the camera in mid-air over
   * the car park. And the BODY is put back visible on the way out, which is the
   * one of the four that is unrecoverable if it is missed.
   *
   * It does not touch `camYaw`, and that is deliberate: which way you are
   * facing is the one thing about the old view that is still true of the new
   * one, so stepping in keeps looking the way you were already looking.
   */
  setFirstPerson(on) {
    const next = !!on;
    if (next === this.fpv) return this.fpv;
    this.fpv = next;
    if (next) {
      this.camZoom = ZOOM_MAX;
      this.ortho.zoom = ZOOM_MAX;
      this.fpvAim = 0;
      this.fpvPitch = 0;
      this.camPan.set(0, 0, 0);
      // Straight to the body rather than eased onto it. `camLook` lerps, so
      // without this the first half-second of first person is spent flying in
      // from wherever the ortho view had settled — which is a nice move and the
      // wrong one, because it happens *inside* the shop and reads as the camera
      // having been dropped through a wall.
      this.camLook.copy(this.camTarget);
    } else {
      this.showEye(true);
    }
    return this.fpv;
  }

  /**
   * Draw the body the camera is inside, or don't.
   *
   * You cannot stand in your own head: the model's crown is at about 0.96 and
   * the eye is at 0.88, so the camera sits *within* the mesh and what you get
   * looking down is the inside of a face filling the frame. Nothing about that
   * reads as "you are this person" — it reads as the renderer having broken.
   *
   * The record is looked up fresh every frame and the one we turned off is
   * remembered, because who the camera rides can change while it is off (a
   * theft cut, a hire you stopped watching) and a body hidden against an id
   * that has moved on is somebody invisible for the rest of the session.
   */
  showEye(on) {
    const rec = this._eyeId
      ? (this.players.get(this._eyeId) ?? this.customers.get(this._eyeId) ?? null)
      : null;
    if (this._hidBody && this._hidBody !== rec) {
      this._hidBody.obj.visible = true;
      this._hidBody = null;
    }
    if (!rec?.obj) return;
    rec.obj.visible = on;
    this._hidBody = on ? null : rec;
  }

  setFreeRoam(on) {
    if (this.freeRoam === !!on) return;
    this.freeRoam = !!on;
    // Building steps you back out, and it is the same argument `releaseCut`
    // makes below: the mode exists to reach places nobody can stand, and first
    // person is the one view that cannot go anywhere a body cannot. Left on,
    // the palette would come up over a camera that refuses to fly and the keys
    // would appear dead.
    if (this.freeRoam) this.setFirstPerson(false);
    // ...and a cut already running is handed back on the way in, or the two
    // seconds a theft borrowed span the moment you start building and drag the
    // view off the shelf you were reaching for. `cutTo` refuses while free, so
    // this is the other half of the same rule: the guard at the door and the
    // guard for whoever is already inside.
    if (this.freeRoam) this.releaseCut();
    this.clampPan();
  }

  /**
   * Hold the view inside whichever bound is in force. One place, because both
   * ways of moving it write the same field — a fly that clamped to the world
   * and a drag that clamped to the leash would fight over every frame.
   */
  clampPan() {
    const L = this.storeLayout;
    if (this.freeRoam && L) {
      // Per-axis and against the map, so the corners of a rectangular world are
      // all reachable. Aimed at where the view ENDS UP (`camTarget + camPan`),
      // because the bound is a fact about the world and the pan is measured
      // from a body that could be standing anywhere in it.
      const lo = -FLY_MARGIN;
      this.camPan.x = clamp(this.camPan.x, lo - this.camTarget.x, L.w + FLY_MARGIN - this.camTarget.x);
      this.camPan.z = clamp(this.camPan.z, lo - this.camTarget.z, L.h + FLY_MARGIN - this.camTarget.z);
      return this.camPan;
    }
    // Far enough to see over the shop, not so far the person you are playing is
    // a rumour. Clamped as a radius rather than per-axis so a diagonal pan
    // doesn't reach 1.4× further than a straight one.
    const len = Math.hypot(this.camPan.x, this.camPan.z);
    if (len > PAN_LIMIT) {
      this.camPan.x *= PAN_LIMIT / len;
      this.camPan.z *= PAN_LIMIT / len;
    }
    return this.camPan;
  }

  /**
   * Give the camera back to whoever it follows.
   *
   * Called when you go somewhere rather than when you let go of the drag: a
   * pan that sprang back on release would be useless on a phone, where looking
   * at the far end of the shop and *then* tapping something there is the whole
   * point. So the view stays where you put it, and going anywhere reclaims it.
   * The glide is free — `camLook` already eases toward its aim.
   */
  recentre() {
    this.camPan.set(0, 0, 0);
  }

  /**
   * Ride on a hire instead of on yourself. `null` gives the camera back.
   *
   * The pan goes with the switch, for the reason `walkTo` recentres: a drag is
   * an offset from whoever is being followed, so keeping it would hand you a
   * camera aimed fourteen tiles off the person you just asked to watch.
   */
  watch(hire) {
    this.watching = hire ?? null;
    this.recentre();
  }

  /**
   * Frame somebody for a moment, then hand the camera back.
   *
   * The cinematic half of the theft alert, and the whole of what makes it one:
   * a sound alone tells you something happened and not WHERE, in a shop that
   * may be four screens wide by the time anybody is stealing from it.
   *
   * Time-boxed and interruptible, because CLAUDE.md's rule for `camPan` is that
   * a view which can lose you is worse than one that cannot see the far shelf —
   * and a cut that held the camera while somebody was running is exactly that.
   * `release` is called by the first input of any kind, so the cut costs you
   * nothing the moment you decide to act on it. Which is also why it does NOT
   * touch `camPan`: the pan is yours, and a cut that stamped on it would hand
   * back a different view from the one it borrowed.
   */
  cutTo(id, seconds = 1.8) {
    if (!id) return;
    // Never while the view is off its leash, which is the same sentence
    // `toggleBuild` says when it drops the follow: building is you taking the
    // wheel, and a camera that yanks itself across the shop mid-drag is the
    // thing the wheel was taken to stop. The cut's own argument does not apply
    // here either — it exists to say WHERE something happened in a shop too big
    // to see at once, and somebody flying the view is already looking wherever
    // they chose to look.
    //
    // It is dropped rather than deferred: the thief is running, so a cut queued
    // until you stop building frames an empty aisle. The alert is still heard.
    if (this.freeRoam) return;
    this.cutOn = id;
    this.cutUntil = performance.now() + seconds * 1000;
  }

  /** Hand the camera back early — any input at all does this. */
  releaseCut() {
    if (!this.cutOn) return;
    this.cutOn = null;
    this.cutUntil = null;
  }

  /** Has the view been shoved off the player? Lets the HUD offer a way back. */
  get panned() {
    return Math.hypot(this.camPan.x, this.camPan.z) > 0.01;
  }

  /**
   * Answer a press where it happened: a ring that spreads and fades.
   *
   * Fired from the tile you pressed rather than from the route the server
   * plans, because the whole job of this is to be instant. A confirmation that
   * waits for a round trip arrives after you have already pressed again, which
   * is the state it exists to prevent.
   *
   * `kind` picks what the press *meant*, so the colour is information rather
   * than decoration: amber for a walk, red for a refusal, white for a press
   * that landed on nothing.
   */
  ripple(x, z, kind = 'go') {
    const color = RIPPLE_COLORS[kind] ?? RIPPLE_COLORS.go;
    const g = buildRipple(color);
    g.position.set(x, 0.07, z);
    this.actorRoot.add(g);
    // Born at the moment of the press, not at the next frame: `render` reads
    // the age off this, and a ripple that starts its life a frame late starts
    // it visibly grown.
    this.ripples.push({ g, born: performance.now(), ms: RIPPLE_MS, from: RIPPLE_FROM, to: RIPPLE_TO });
    return g;
  }

  /**
   * Slam a square shut on a tile, and drop what is standing on it into place.
   *
   * The two halves are one effect and are fired together for that reason — a
   * mark on the ground with nothing landing in it is a scorch, and a fixture
   * bouncing on bare floor has nothing to have hit.
   */
  land(prop, x, z) {
    this.landings.push({ g: prop, y: prop.position.y, born: performance.now() });
    const g = buildStamp(STAMP_COLOR);
    g.position.set(x, 0.07, z);
    this.actorRoot.add(g);
    this.ripples.push({ g, born: performance.now(), ms: STAMP_MS, from: STAMP_FROM, to: 1 });
  }

  /**
   * How far through a held press we are, 0..1, or null when nothing is held.
   *
   * A hold that shows nothing is indistinguishable from a click that missed —
   * you let go at 300ms, having done nothing, with no way to know you were
   * 120ms short. So the ring that already marks what you are pointing at fills
   * up, using the same sweep the action charge uses: one vocabulary for "keep
   * doing that", whether the game is waiting on your finger or on your legs.
   */
  setHoldProgress(t) {
    this.holdProgress = t === null ? null : Math.max(0, Math.min(1, t));
  }

  /** Advance every live ground mark, and retire the ones that have finished. */
  animateRipples(now) {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      const k = (now - r.born) / r.ms;
      if (k >= 1) {
        this.actorRoot.remove(r.g);
        disposeGroup(r.g);
        this.ripples.splice(i, 1);
        continue;
      }
      // Out fast and then slower, which is what makes it read as a wave losing
      // energy rather than as a circle being animated. Fading on a square so
      // most of the life is spent visible and the tail is quick.
      //
      // A stamp is this same curve with `from` above `to`, so "fast then
      // settling" becomes weight arriving instead of energy leaving. One eased
      // interpolation, read backwards.
      const ease = 1 - (1 - k) ** 3;
      r.g.scale.setScalar(r.from + (r.to - r.from) * ease);
      r.g.userData.ring.material.opacity = 0.9 * (1 - k) ** 2;
    }
  }

  /** Fall, hit, wobble, settle. Retired back to exactly where it belongs. */
  animateLandings(now) {
    for (let i = this.landings.length - 1; i >= 0; i--) {
      const r = this.landings[i];
      const k = (now - r.born) / LAND_MS;
      if (k >= 1) {
        r.g.position.y = r.y;
        r.g.scale.set(1, 1, 1);
        this.landings.splice(i, 1);
        continue;
      }
      if (k < LAND_FALL) {
        // Squared, so it accelerates rather than descends at a constant rate.
        // A fixture arriving at walking pace reads as being lowered by somebody
        // rather than as being dropped.
        const t = k / LAND_FALL;
        r.g.position.y = r.y + LAND_DROP * (1 - t * t);
        r.g.scale.set(1, 1, 1);
      } else {
        const t = (k - LAND_FALL) / (1 - LAND_FALL);
        // A bounce that dies out: the cosine gives it a second, smaller
        // compression on the way to still, and the squared envelope means it is
        // genuinely finished at the end rather than cut off mid-wobble.
        const s = LAND_SQUASH * (1 - t) ** 2 * Math.cos(t * 8);
        r.g.position.y = r.y;
        r.g.scale.set(1 + s * 0.6, 1 - s, 1 + s * 0.6);
      }
    }
  }

  /**
   * Turn every readout to face the camera again.
   *
   * `Ry(camAngle) · base` rather than "set rotation.y": a rotation about world
   * Y applied *after* whatever base orientation the thing was built with is
   * exactly the transform that leaves its appearance unchanged as the camera
   * orbits by the same angle. Folding the yaw into a Euler's y term only works
   * for a base that is itself a pure yaw, which the growth bar is and the
   * progress ring is not.
   *
   * Found by traversal rather than by a registry on purpose. A registry of
   * live meshes is one more thing to unsubscribe from on disposal, and this
   * renderer already has a scar there — clearing the `shelfProps` maps without
   * removing the meshes orphaned a full set of stock in the scene on every
   * re-flow. Traversal cannot leak, and it runs only when the angle changes or
   * something new was built, which is a handful of frames per quarter turn
   * rather than every frame forever.
   */
  faceReadouts() {
    // THE DELTA BETWEEN THE CAMERA THAT WAS AUTHORED FOR AND THE ONE BEING
    // LOOKED THROUGH — both angles, rather than the yaw this used to be.
    //
    // Every base was recorded against `PITCH_HOME`, so a yaw is a complete
    // answer for exactly one camera: the 40° one the game had when readouts
    // were built. Tilt away from it and a panel authored to face you is being
    // looked at from `camPitch - PITCH_HOME` off its own normal — a bar going
    // slim, then to a bright sliver, then edge-on to nothing — while the money
    // labels beside it stay perfectly square, because a `THREE.Sprite`
    // billboards on both axes. Two kinds of readout in one scene disagreeing
    // about where the camera is, is the tell.
    //
    // `q_now · q_home⁻¹` rather than arithmetic on the two angles, and the
    // reason is a trap worth keeping: the camera sits over the DIAGONAL, so its
    // right vector at `camAngle` 0 is (1,0,-1)/√2 and not world X. Composing
    // `Ry(yaw) · Rx(pitch delta)` therefore tilts every readout about an axis
    // 45° off the one it is meant to, which is right at the home pitch (the term
    // is zero), wrong everywhere else, and wrong in a way that looks like a
    // skew rather than like a bug. A delta between two orientations cannot get
    // that wrong: `q_home` is the pose the bases were drawn for, `q_now` is the
    // pose being drawn, and one carries the other's appearance to this one
    // whatever either is made of.
    //
    // Read off `camOffset` — which `aimCamera` has already rebuilt from the
    // eased angles this frame — rather than off `camera.quaternion`, which is
    // set at the END of the frame loop and would be one frame stale. The bars
    // would lag the shop through a swing, which is precisely what the eased
    // `camAngle` here exists to avoid.
    //
    // What it buys is a full billboard, which is a look as well as a fix: tilt
    // right down and the bars stand up like cards instead of lying into the
    // ground. That is what the sprites have always done, and the alternative —
    // following the pitch only part way — is a readout that is wrong at both
    // ends rather than at one.
    AIM_M.lookAt(this.camOffset, ORIGIN, AXIS_Y);
    YAW_Q.setFromRotationMatrix(AIM_M).multiply(HOME_CAM_INV);
    const aim = (o) => {
      const base = o.userData.faceCam;
      if (base) o.quaternion.copy(YAW_Q).multiply(base);
    };
    this.actorRoot.traverse(aim);
    this.staticRoot.traverse(aim);
  }

  setCatalog(catalog) {
    this.catalog = {
      items: Object.fromEntries(catalog.items.map((i) => [i.id, i])),
      crops: Object.fromEntries(catalog.crops.map((c) => [c.id, c])),
      fixtures: Object.fromEntries((catalog.fixtures ?? []).map((f) => [f.id, f])),
      // ...and the same rows as a list, because resolving which *piece* a
      // fixture is means asking "what does this kind default to", which is a
      // scan rather than a lookup. See shared/pieces.js.
      pieces: catalog.fixtures ?? [],
      // A hire is drawn from its kind, so the renderer reads the same rows the
      // Staff menu does.
      workers: Object.fromEntries((catalog.workers ?? []).map((w) => [w.id, w])),
      // ...and what they're holding while they're on a break comes off the
      // pastime, for the same reason: a break redrawn over MCP should reach the
      // person already sat on the step, not only the next one who stops.
      pastimes: Object.fromEntries((catalog.pastimes ?? []).map((p) => [p.id, p])),
      // What a hire is wearing, keyed the same way, and cleared by the same
      // sweep below — a skin recoloured over MCP repaints whoever has it on.
      skins: Object.fromEntries((catalog.skins ?? []).map((s) => [s.id, s])),
      // ...and what a shopper is carrying their shopping in, keyed the same way
      // and for the same reason. The snapshot sends the id and how full it is;
      // which bag that is stays a row somebody can redraw.
      kits: Object.fromEntries((catalog.kits ?? []).map((k) => [k.id, k])),
      // A van and a car are drawn from their own rows too, and looked up by the
      // id the snapshot sends rather than by `use` — which vehicle turns up is
      // the sim's decision (`vehicleFor`), and the renderer draws whichever one
      // it was told about. Asking `use` here would be a second, quieter answer
      // to that question, and the two would disagree the day somebody authors a
      // bigger lorry.
      vehicles: Object.fromEntries((catalog.vehicles ?? []).map((v) => [v.id, v])),
      // Kept as a list, not keyed: what an appliance shows is chosen by looking
      // across every recipe its kind can make, not by looking one up.
      recipes: catalog.recipes ?? [],
    };
    // Content changed — force props to rebuild with any new models.
    for (const [, rec] of this.shelfProps) rec.key = null;
    for (const [, rec] of this.plotProps) rec.key = null;
    // ...including the people already on shift, so a worker kind redrawn over
    // MCP reaches the ones you have rather than only the next one you hire.
    for (const [, rec] of this.players) rec.key = null;
    // Both props on an appliance: the ingredient row, and what it looks like
    // while it runs. A working look redrawn over MCP should reach the machine
    // that is running right now, not the next batch.
    for (const [, rec] of this.stationProps) { rec.keys = []; rec.workKeys = []; }
    // ...and the van that is on the road while you are drawing it. A vehicle is
    // on screen for about six seconds a run, so "it'll be right next time" is a
    // worse answer here than anywhere else in this sweep — the next time is six
    // in-game hours away, and by then nobody is watching the bay.
    for (const [, rec] of this.vehicleProps) rec.key = null;
    // Fixtures are built with the world, so redrawing one means redrawing that.
    // This also covers the ordinary boot order: the catalog usually lands after
    // the first layout, and without it the shop would be furnished with the
    // fallback blocks until something else happened to re-flow it.
    this.rebuildWorld();
  }

  // -------------------------------------------------------------------------
  // Static world
  // -------------------------------------------------------------------------

  /**
   * Lay the bars of a striped design over the cells that wear it.
   *
   * **Which way they run is read off the shape you painted**, not authored and
   * not fixed. A crossing is a patch two cells deep across a road and however
   * many long, and its bars run the SHORT way — across the traffic, along the
   * walk. So each cell measures its own contiguous run in x and in z within
   * this design's own cells, and the bars span whichever is shorter. A square
   * patch has no answer and takes z, which is the crossing on the road the
   * world seeds.
   *
   * Doing it per cell rather than per patch is what keeps it local: a crossing
   * that turns a corner gets bars that turn with it, and no part of this has to
   * know what a patch is.
   *
   * One extra instanced mesh for the whole design, laid a hair over the cell
   * tops. It is the only ground pattern that costs any geometry at all.
   */
  addStripes(cells, surface, height, box, dummy) {
    const has = new Set(cells.map(([x, z]) => `${x},${z}`));
    const run = (x, z, dx, dz) => {
      let n = 1;
      for (let i = 1; has.has(`${x + dx * i},${z + dz * i}`); i++) n++;
      for (let i = 1; has.has(`${x - dx * i},${z - dz * i}`); i++) n++;
      return n;
    };
    const bars = new THREE.InstancedMesh(
      box,
      material(surface.accent ?? shade(surface.color, -0.55)),
      cells.length * stripeBars(surface),
    );
    bars.castShadow = false;
    bars.receiveShadow = true;
    // Painted onto ground that is baked, so these are too — a crossing under a
    // lamp post with unlit stripes is a hole in the pool the shape of the paint.
    bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bars.count * 3), 3);
    const bare = new Float32Array(bars.count * 3).fill(1);
    const at = new Float32Array(bars.count * 3);
    const n0 = stripeBars(surface);
    const duty = stripeDuty(surface);
    let n = 0;
    for (const [x, z] of cells) {
      // Longer along x means the road runs east-west, so the bars run along z.
      const alongZ = run(x, z, 1, 0) >= run(x, z, 0, 1);
      for (let i = 0; i < n0; i++) {
        const off = (i - (n0 - 1) / 2) / n0;
        dummy.position.set(alongZ ? x + off : x, height + 0.012, alongZ ? z : z + off);
        dummy.scale.set(alongZ ? duty : 1, 0.02, alongZ ? 1 : duty);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        at[n * 3] = dummy.position.x;
        at[n * 3 + 1] = dummy.position.y;
        at[n * 3 + 2] = dummy.position.z;
        bars.setColorAt(n, this.lights.bakeInto(
          new THREE.Color(1, 1, 1), dummy.position.x, dummy.position.y, dummy.position.z,
        ));
        bars.setMatrixAt(n++, dummy.matrix);
      }
    }
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    bars.layers.set(BAKED_LAYER);
    this.bakedGround.push({ mesh: bars, bare, at });
    this.staticRoot.add(bars);
  }

  /**
   * Paint a job pad: a line round the outside of it, and one symbol in it.
   *
   * The edge is drawn CELL BY CELL, from each square's own neighbours, which is
   * the same trick `addStripes` uses to avoid ever knowing what a patch is: a
   * side with no pad beyond it is an edge, so an L-shaped bay gets an L-shaped
   * line and a pad painted up against another one has no line between them.
   *
   * The symbol is the half that does need a region, because there is one per pad
   * rather than one per square — a glyph on every cell is wallpaper, and what is
   * being imitated is a sign painted on the ground. So the cells are flooded into
   * connected groups and each gets one, sized to the smaller of its two spans so
   * a one-cell drop-off is not wearing a symbol three tiles wide.
   *
   * Both are baked into the ground light the way the crossing stripes are: a
   * marking that stayed bright while the shop went dark would read as a decal on
   * the camera rather than as paint on the floor.
   */
  addPadMarks(cells, mark, height, box, dummy) {
    const has = new Set(cells.map(([x, z]) => `${x},${z}`));
    const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const edges = [];
    for (const [x, z] of cells) {
      for (const [dx, dz] of SIDES) {
        if (!has.has(`${x + dx},${z + dz}`)) edges.push([x, z, dx, dz]);
      }
    }

    if (edges.length) {
      const LINE = 0.09;
      const lines = new THREE.InstancedMesh(box, material(mark.ink), edges.length);
      lines.castShadow = false;
      lines.receiveShadow = true;
      lines.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(edges.length * 3), 3);
      const bare = new Float32Array(edges.length * 3).fill(1);
      const at = new Float32Array(edges.length * 3);
      edges.forEach(([x, z, dx, dz], i) => {
        // Inset by half its own width, so the line sits ON the pad rather than
        // straddling the seam — half a line hanging over the grass beside it is
        // a pad that looks a hair too big, which is exactly the thing the edge
        // is being drawn to say precisely.
        const y = height + 0.012;
        dummy.position.set(x + dx * (0.5 - LINE / 2), y, z + dz * (0.5 - LINE / 2));
        dummy.scale.set(dx ? LINE : 1, 0.02, dz ? LINE : 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        lines.setMatrixAt(i, dummy.matrix);
        at[i * 3] = dummy.position.x;
        at[i * 3 + 1] = y;
        at[i * 3 + 2] = dummy.position.z;
        lines.setColorAt(i, this.lights.bakeInto(new THREE.Color(1, 1, 1), dummy.position.x, y, dummy.position.z));
      });
      lines.instanceMatrix.needsUpdate = true;
      if (lines.instanceColor) lines.instanceColor.needsUpdate = true;
      lines.layers.set(BAKED_LAYER);
      this.bakedGround.push({ mesh: lines, bare, at });
      this.staticRoot.add(lines);
    }

    // One symbol per connected pad. A plain flood, iterative rather than
    // recursive — a yard painted wall to wall is a thousand cells and a
    // recursion that deep is a blown stack while somebody is dragging a brush.
    const left = new Set(has);
    while (left.size) {
      const first = left.values().next().value;
      const group = [];
      const queue = [first];
      left.delete(first);
      while (queue.length) {
        const cur = queue.pop();
        const [cx, cz] = cur.split(',').map(Number);
        group.push([cx, cz]);
        for (const [dx, dz] of SIDES) {
          const k = `${cx + dx},${cz + dz}`;
          if (left.has(k)) { left.delete(k); queue.push(k); }
        }
      }
      const xs = group.map(([x]) => x);
      const zs = group.map(([, z]) => z);
      const w = Math.max(...xs) - Math.min(...xs) + 1;
      const d = Math.max(...zs) - Math.min(...zs) + 1;
      const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const mz = (Math.min(...zs) + Math.max(...zs)) / 2;
      /**
       * The middle of the pad — and only the NEAREST CELL to it when the middle
       * is not over the pad at all.
       *
       * A pad with an even span has its middle on a cell *boundary*, so snapping
       * to a cell centre is half a tile off by construction. That is a look
       * until the symbol is wide enough for half a tile to carry it over the
       * edge, and at two cells it is: 1.6 of glyph, offset 0.5, on a pad 2 wide
       * — 0.3 of a tile out on the grass. From three cells up the 2.2 ceiling
       * keeps the symbol small enough that the same offset still lands inside,
       * which is the whole of why this reads as "two looks wrong and three is
       * fine" rather than as an offset that was always there.
       *
       * The fallback stays for the case its own comment was about: a U-shaped
       * yard's middle is a square that is not part of the yard, and a symbol
       * floating in the gap belongs to nothing.
       *
       * "Over the pad" is every cell the point TOUCHES — up to four of them,
       * since an even span in both axes puts it on a shared corner — and all of
       * them have to be ours. Asking whether any one is a member would re-create
       * the same bug at an inside corner: the glyph would centre on a point with
       * pad under a quarter of it and grass under the rest.
       *
       * Asked of this group rather than of `has`, which holds every pad of this
       * kind in the shop: two regions can touch at a diagonal without being
       * connected, and borrowing a corner off the pad next door would put the
       * mark in the gap between them.
       */
      const mine = new Set(group.map(([x, z]) => `${x},${z}`));
      const touching = (v) => (Number.isInteger(v) ? [v] : [Math.floor(v), Math.ceil(v)]);
      const over = touching(mx).every((cx) => touching(mz).every((cz) => mine.has(`${cx},${cz}`)));
      const [gx, gz] = over ? [mx, mz] : group.reduce((best, c) => (
        (c[0] - mx) ** 2 + (c[1] - mz) ** 2 < (best[0] - mx) ** 2 + (best[1] - mz) ** 2 ? c : best
      ), group[0]);
      /**
       * ...and how big, which is the shorter span of the pad — EXCEPT where the
       * mark had to fall back, because there the span is a lie.
       *
       * A bounding box describes a concave pad about as well as it describes any
       * other, which is to say not at all: a U-shaped yard is 3×3 by that
       * measure, so the symbol is sized for three cells and then drawn on a
       * one-cell arm of the ring, hanging most of a tile out over the middle it
       * is not part of. So in the fallback the size comes from how far the pad
       * actually reaches from the cell the mark landed on, which is the same
       * question the box was standing in for and the right one to ask.
       *
       * Only in the fallback: the centred branch has already established that
       * the pad is solid under the middle, and its span is measured off cells it
       * is genuinely in the middle of.
       */
      const reach = (dx, dz) => {
        let n = 0;
        while (mine.has(`${gx + dx * (n + 1)},${gz + dz * (n + 1)}`)) n += 1;
        return n + 0.5;
      };
      const fit = over
        ? Math.min(w, d)
        : 2 * Math.min(reach(1, 0), reach(-1, 0), reach(0, 1), reach(0, -1));
      // 0.73 of that rather than 0.8, and it is arithmetic rather than taste:
      // the 2.2 ceiling is already 0.73 of a three-cell pad, and three cells is
      // the size that looks right. At 0.8 the ratio *walked* — 0.80 of a
      // two-cell pad, 0.73 of a three, 0.55 of a four — so a small pad wore a
      // proportionally bigger symbol than a big one, on top of being the one
      // that could not afford it. One number, one scale, every pad.
      const size = Math.min(2.2, Math.max(0.7, fit * 0.73));
      const glyph = buildPadGlyph(mark.glyph, mark.ink);
      glyph.scale.set(size, size, 1);
      glyph.position.set(gx, height + 0.014, gz);
      /**
       * Baked, like everything else painted on this pad.
       *
       * It used to be the one mark here that was not, and the argument was that
       * a symbol is small enough that a lamp passing over it changing nothing
       * reads as paint catching the light evenly. That was true of a thin
       * stroked line and stopped being true the moment these became shapes with
       * area: the pad around them is multiplied down into the ground light and
       * the symbol was not, so what you get is a mark that is *brighter than the
       * ground it is painted on* — which reads as a white decal stuck on the
       * camera rather than as paint, the exact failure the edge lines and the
       * crossing stripes are baked to avoid.
       *
       * A `MeshBasicMaterial`'s `color` multiplies its map, so the same
       * per-instance value the lines use goes on the material instead. One
       * sample at the middle of the symbol rather than per-cell, which is the
       * half of the old comment that still holds — a mark this size does not
       * want a gradient across it.
       */
      const lit = height + 0.014;
      glyph.material.color = this.lights.bakeInto(new THREE.Color(1, 1, 1), gx, lit, gz);
      this.staticRoot.add(glyph);
    }
  }

  /**
   * PLANTING — the second ground pattern that is geometry, and the first with
   * any height to it.
   *
   * `addStripes` is the precedent and the argument is the same one turned up:
   * what survives of a *flat* pattern at 45° is its colour, so every other
   * pattern is one colour per cell. The way you tell grass from lino is that
   * grass is not flat, and that costs geometry or it costs nothing at all.
   *
   * One instanced mesh for the whole design, however many cells it covers, so a
   * field of meadow is one draw call. Two things make that affordable:
   *
   * **The blade is authored, the scatter is not.** Where each tuft stands comes
   * off `hash01` of its cell and index, never off an rng — the same call
   * `client/render/props.js` makes for a hire's breathing phase, and for the
   * reason docs/kits.md gives about which bag a shopper carries. A drawn scatter
   * would reshuffle the entire lawn on every re-flow, and build mode re-flows on
   * every wall segment: grass that crawled as you dragged a wall reads as the
   * ground being unstable, not as art.
   *
   * **`MAX_TUFTS` thins rather than refuses.** Ground is the biggest thing in
   * the world by cell count, so a `density` of nine over a forty-tile field is
   * fourteen thousand instances whose matrices get rebuilt on every wall
   * segment. Past the cap it plants every Nth cell instead of dropping the
   * pattern, so a huge meadow comes out sparse rather than bare — the same call
   * `lights.js` makes about the ninth lamp, and made now rather than found later
   * as "the game got slow while I was building".
   */
  addTufts(cells, surface, height, dummy) {
    const density = tuftDensity(surface);
    // Every Nth cell, so the thinning is spatial rather than "the last field you
    // painted has no grass in it" — the cells arrive in scan order.
    const step = Math.max(1, Math.ceil((cells.length * density) / MAX_TUFTS));
    const planted = cells.filter((_, i) => i % step === 0);
    if (!planted.length) return;

    const blade = tuftBlade(surface);
    const geo = tuftGeometry();
    const tufts = new THREE.InstancedMesh(
      geo,
      tuftMaterial(surface.accent ?? shade(surface.color, -0.18)),
      planted.length * density,
    );
    // Never a shadow caster. A blade is a couple of triangles a tenth of a tile
    // tall, so what it costs the shadow map is a full extra pass over the
    // biggest instance count in the scene and what it buys is a smudge you
    // cannot see. It still RECEIVES, or a lawn under the building's shadow is a
    // bright green lawn with a dark box drawn beside it.
    tufts.castShadow = false;
    tufts.receiveShadow = true;
    tufts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(tufts.count * 3), 3);
    const bare = new Float32Array(tufts.count * 3).fill(1);
    const at = new Float32Array(tufts.count * 3);

    let n = 0;
    for (const [x, z] of planted) {
      for (let i = 0; i < density; i++) {
        // Three hashes off one cell: two for where in the cell it stands and one
        // for how tall and which way it faces. Inset from the edges so a tuft
        // never straddles the line into the tarmac next door.
        // Four hashes and not three. Facing used to share one with size, which
        // correlates them — every tall tuft in the world pointing the same way
        // is a pattern the eye finds instantly, and it reads as the scatter
        // being fake rather than as two numbers being the same number.
        const hx = hash01(`${x}:${z}:${i}:x`);
        const hz = hash01(`${x}:${z}:${i}:z`);
        const hr = hash01(`${x}:${z}:${i}:r`);
        const ha = hash01(`${x}:${z}:${i}:a`);
        const grow = 0.7 + hr * 0.6;
        dummy.position.set(x + (hx - 0.5) * 0.82, height, z + (hz - 0.5) * 0.82);
        dummy.rotation.set(0, ha * Math.PI * 2, 0);
        // UNIFORM, and it has to be. The geometry is authored in blade-heights
        // on all three axes (see `tuftGeometry`), so scaling y alone stretches a
        // blade's height without its width or its curve — which is exactly how
        // the first version came out as a splayed spike. One number here means
        // `blade` on the row is a size rather than a stretch, and a tall meadow
        // blade is proportioned like a short lawn one.
        dummy.scale.setScalar(blade * grow);
        dummy.updateMatrix();
        at[n * 3] = dummy.position.x;
        at[n * 3 + 1] = dummy.position.y;
        at[n * 3 + 2] = dummy.position.z;
        tufts.setColorAt(n, this.lights.bakeInto(
          new THREE.Color(1, 1, 1), dummy.position.x, dummy.position.y, dummy.position.z,
        ));
        tufts.setMatrixAt(n++, dummy.matrix);
      }
    }
    tufts.instanceMatrix.needsUpdate = true;
    if (tufts.instanceColor) tufts.instanceColor.needsUpdate = true;
    tufts.layers.set(BAKED_LAYER);
    this.bakedGround.push({ mesh: tufts, bare, at });
    this.staticRoot.add(tufts);
  }

  /**
   * Re-do the lamp bake over ground that has not moved.
   *
   * Called when the hour turns, and that is the whole of what a bake costs: the
   * sum is only right for one value of `lit`, so a floor baked at midnight stays
   * midnight-bright through the morning unless somebody redoes it. Once an hour
   * rather than every frame because that is the rate the sun visibly moves at,
   * and this is a pass over every cell in the shop times every lamp in it —
   * nothing at 900 × 20, silly at 60fps.
   *
   * Straight over the stored unlit colours, so it can run any number of times
   * without the light compounding. That is what `bare` is for.
   */
  /** One fixture's share of the bake, as a flat tint through its whole group. */
  paintProp(group, x, y, z) {
    const c = this.lights.bakeInto(new THREE.Color(1, 1, 1), x, y, z);
    paintLit(group, c.r, c.g, c.b);
  }

  /**
   * Point the lamp pool at this layout, with every watcher worth what the shop
   * currently says it is worth.
   *
   * Its own method because it has two callers that could not be further apart: a
   * re-flow, which is the shop changing shape, and a signal moving, which is the
   * shop changing its mind. Written twice, the second one would be the one that
   * quietly forgot to pass the signals.
   */
  aimLights(L) {
    if (!L) return;
    // Where the building is, which is what makes the bake able to tell a shop
    // floor at dusk from a field at dusk. Here rather than in `buildWorld`
    // because this is the method that already means "point the lighting at this
    // layout", and the mask moves for the same reason the lamps do — a wall
    // went up, so a cell that was outside is a room now.
    this.lights.setIndoor(L);
    const fixtures = fixturesIn(L);
    this.lights.setEmitters(emittersIn(fixtures, (f) => this.pieceOf(f), CEILING_Y, this.signals));
    // Which of them are lamps that watch something, so `syncSignals` can skip
    // the whole question in a shop that owns none — which is every shop until
    // somebody hangs a sign up.
    this._litWatchers = fixtures.filter((f) => {
      const piece = this.pieceOf(f);
      return piece?.signal && (piece.tiers?.[(f.tier ?? 1) - 1]?.emits ?? piece.emits);
    }).map((f) => this.pieceOf(f).signal);
    this._litAt = this.lightsWant();
  }

  /**
   * What the watched lamps are worth right now, quantised, as one comparable
   * value.
   *
   * Quantised because the bake is expensive and a continuous signal would ask
   * for one every tick; twelve steps is finer than the hourly rebake the sunset
   * already runs and coarser than anything an eye could catch a lamp stepping
   * through.
   */
  lightsWant() {
    return (this._litWatchers ?? []).map((s) => Math.round((this.signals[s] ?? 1) * 12)).join(',');
  }

  /**
   * A welded mesh that spans the shop, lit vertex by vertex.
   *
   * `paintProp` is one flat tint for a whole group, which is right for a fixture
   * — a tile across, so one number is the whole of what a lamp does to it — and
   * useless for a conveyor: a run is thirty tiles long and welded into one mesh,
   * so a single tint would light the far end by whatever is standing at the near
   * one. The ground has the same problem and solves it per instance; this is the
   * same answer per vertex, which is what a merge leaves you with.
   *
   * The hue comes off `userData.baseColor` — the clean colour `weld` put aside
   * for exactly this — so re-baking never compounds.
   */
  bakeMesh(mesh) {
    const geo = mesh.geometry;
    const bare = geo.userData?.baseColor;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    if (!bare || !pos || !col) return;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.setRGB(bare[i * 3], bare[i * 3 + 1], bare[i * 3 + 2]);
      this.lights.bakeInto(c, pos.getX(i), pos.getY(i), pos.getZ(i));
      col.array[i * 3] = c.r;
      col.array[i * 3 + 1] = c.g;
      col.array[i * 3 + 2] = c.b;
    }
    col.needsUpdate = true;
  }

  rebakeGround() {
    const c = new THREE.Color();
    for (const { group, x, y, z } of this.bakedProps ?? []) this.paintProp(group, x, y, z);
    for (const mesh of this.bakedMeshes ?? []) this.bakeMesh(mesh);
    for (const { mesh, bare, at, lit } of this.bakedGround ?? []) {
      if (!mesh.instanceColor) continue;
      for (let i = 0; i < mesh.count; i++) {
        c.setRGB(bare[i * 3], bare[i * 3 + 1], bare[i * 3 + 2]);
        this.lights.bakeInto(c, at[i * 3], at[i * 3 + 1], at[i * 3 + 2]);
        mesh.setColorAt(i, c);
        // ...and the slat batch keeps a copy, because its own frame loop
        // multiplies a chase into this rather than replacing it. See `lit`
        // where it is built.
        if (lit) { lit[i * 3] = c.r; lit[i * 3 + 1] = c.g; lit[i * 3 + 2] = c.b; }
      }
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Turn the `?tiles` debug grid on or off.
   *
   * Idempotent and safe before the first layout arrives — boot reads the URL
   * long before the shop is open, so this records the wish and `syncTileGrid`
   * honours it the moment there is a map to draw one over.
   */
  setTileGrid(on) {
    this.tileGridOn = !!on;
    if (this.tileGridOn) this.syncTileGrid(this.storeLayout);
    else this.dropTileGrid();
  }

  dropTileGrid() {
    if (!this.tileGrid) return;
    this.scene.remove(this.tileGrid);
    disposeTileGrid(this.tileGrid);
    this.tileGrid = null;
    this.tileGridFor = '';
  }

  /**
   * Re-cut the sheet if — and only if — the map changed size.
   *
   * Called from `buildWorld`, which runs on every wall segment of a drag, so
   * the early return is the point rather than a tidy-up: repainting a 2048²
   * canvas per segment is a build tool that stutters, and the picture would be
   * identical every time. Buying land is the one thing that can move it.
   */
  syncTileGrid(L) {
    if (!this.tileGridOn || !L) return;
    const key = `${L.w}x${L.h}`;
    if (key === this.tileGridFor && this.tileGrid) return;
    this.dropTileGrid();
    const aniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    this.tileGrid = buildTileGrid(L.w, L.h, aniso);
    if (!this.tileGrid) return;
    this.tileGridFor = key;
    this.scene.add(this.tileGrid);
  }

  /** Redraw the world we already have — for when the art changed, not the shop. */
  rebuildWorld() {
    if (!this._layout) return;
    this.layoutVersion = -1;
    this.buildWorld(this._layout);
  }

  buildWorld(layout) {
    if (layout.version === this.layoutVersion) return;
    this.layoutVersion = layout.version;
    this._layout = layout;
    const L = layout.layout ?? layout;

    // Every geometry under staticRoot was built for the previous layout, and
    // `clear()` alone drops the references without freeing the GPU buffers.
    // That barely mattered when the shop only re-flowed on an upgrade; build
    // mode re-flows on every placement.
    this.profiles.clear();
    disposeGroup(this.staticRoot);
    this.staticRoot.clear();
    // Anything still dropping was a group under that root, and is now a freed
    // buffer the animator would go on scaling every frame.
    this.landings.length = 0;
    // Shelf and plot props live in `actorRoot`, not `staticRoot`, so they
    // survive the clear above and have to be dealt with by name. Only the ones
    // whose fixture the re-flow removed — emptying the maps wholesale is what
    // made every shelf in the shop blink each time you laid a tile, and taking
    // the records out without taking the MESHES out orphans a full set of stock
    // at the old positions. See `refreshFixtureProps` for both.
    this.refreshFixtureProps(L);

    // Lamps first, because the floor is about to be BAKED with them — every
    // emitter in the shop folded into the per-cell colour the tile mesh was
    // going to carry anyway. It used to be the last line in this method, back
    // when nothing here needed to know where the light was.
    this.aimLights(L);
    this.bakedGround = [];
    this.bakedMeshes = [];

    // The footfall sheet is the size of the world, so it is re-cut here — the
    // one thing outside `staticRoot` that a re-flow legitimately touches, since
    // buying land is the only way the grid ever changes. `resize` keeps the
    // overlap, so growing the shop does not lose what has been watched.
    this.heat.resize(L.w, L.h);

    // Ground: one big plane rather than 1500 grass tiles. It runs well past the
    // last tile — see GROUND_MARGIN — so the world never visibly ends, and so
    // shoppers walking on from off the map have land to walk in over.
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(L.w + GROUND_MARGIN * 2, 0.4, L.h + GROUND_MARGIN * 2),
      material(PALETTE.grass),
    );
    ground.position.set(L.w / 2, -0.2, L.h / 2);
    ground.receiveShadow = true;
    // Onto the baked layer with every other bit of ground. It is not baked —
    // there is nothing per-cell about one box the size of the world — but it has
    // to be off layer 0, because layer 0 is now what `roomFill` lifts at night.
    // The apron is the outdoor field seen past the last tile, so lifting it
    // would put a bright band round a dark lawn: the ONE part of this the eye
    // reliably catches, since the seam is a straight line the length of the map.
    // What it costs is the lamp pool, which never reached out here anyway.
    ground.layers.set(BAKED_LAYER);
    this.staticRoot.add(ground);

    // Everything raised gets an instanced box per tile kind — and, for floor,
    // per DESIGN of floor. Which design a cell is painted lives in its own
    // sparse layer (`L.ground`) rather than in `tiles`, so the grouping key has
    // to carry both: `tiles` still decides what may stand there and this only
    // decides what it looks like. One mesh per kind would have collapsed four
    // floors into one colour; one mesh per cell would be five hundred draws.
    const painted = groundIndex(L);
    const byKind = new Map();
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        // Just the ground. A fixture standing here draws itself on top, and the
        // floor under it is floor — which it always was, and now says so.
        //
        // `T.GRASS` is 0 and used to be skipped right here, which is the whole
        // of why the lawn was flat: it never became a mesh, so what you were
        // looking at was the apron box below with no per-cell jitter and no
        // baked lamp light on it. It has a ground kind now (`GROUND.lawn`) and
        // goes through this loop like every other cell, which is one more
        // instanced mesh and no other change.
        const raw = L.tiles[z * L.w + x];
        // A BELT DRAWS AS THE GROUND IT IS LYING ON.
        //
        // `T.BELT` has never had a `TILE_STYLE` entry, so a belt cell drew no
        // ground mesh at all and the pale slab you saw was the fixture's own
        // authored deck — which is why a run laid across your parquet was a grey
        // strip through it. A conveyor is not a floor covering: what it is is a
        // track set INTO whatever is already there, so the deck came off the art
        // and the cell renders as the ground the belt is standing on.
        //
        // Resolved to a real tile kind rather than given a style of its own,
        // which is what makes it free: the painted design at this cell, the
        // height, the jitter, the bake and the batching key all go on being
        // decided by the code below, for a cell that is now honestly `T.FLOOR`.
        //
        // Read off `indoor` because a belt is `where: 'any'` — a run out to the
        // yard is ordinary, and a floor slab under it would be a strip of shop
        // laid across the grass. It is the same mask `computeIndoor` re-answers
        // every re-flow, so a belt inside a room you later knock down changes
        // its own ground with the room, which is the right answer and not one
        // anything has to remember.
        const kind = raw === T.BELT ? (L.indoor?.[z * L.w + x] ? T.FLOOR : T.GRASS) : raw;
        // Any painted ground, not just floor: a delivery bay is a design on a
        // cell the same way parquet is, and one that only floor could carry
        // would draw every authored bay in the palette's default colour.
        const piece = groundKindOfTile(kind) ? (painted.get(`${x},${z}`) ?? null) : null;
        const key = piece ? `${kind}|${piece}` : String(kind);
        if (!byKind.has(key)) byKind.set(key, { kind, piece, cells: [] });
        byKind.get(key).cells.push([x, z]);
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();

    for (const [, { kind, piece, cells }] of byKind) {
      const style = TILE_STYLE[kind];
      if (!style) continue;
      // A floor under this is a slab too thin to survive the depth buffer at the
      // far end of a grown shop, which shows up as the ground strobing as the
      // camera turns. It was 0.04 while the only tile it could ever have caught
      // was skipped — which quietly raised the road to 0.04 as well, against the
      // 0.02 `T.ROAD` is authored at and the comment there insisting a lane is
      // flush rather than a kerb. Now that the lawn is drawn the order matters:
      // grass 0.01, road 0.02, pads 0.07.
      const height = Math.max(style.h, 0.01);
      // What this floor is made of, if anybody chose. `surfaceOf` falls back to
      // the tile's own colour, so a design deleted out of the catalog leaves
      // plain shop floor rather than a black hole.
      const surface = piece ? surfaceOf(this.catalog.pieces ?? [], piece, style.color) : null;
      const base = surface?.color ?? style.color;

      const mesh = new THREE.InstancedMesh(box, material(base), cells.length);
      mesh.castShadow = height > 0.2;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
      // The unlit colour of every cell, and where that cell is. Kept so the hour
      // can be re-baked without re-deriving the pattern: `patternColor` and the
      // jitter hash are per cell, and the sun coming up does not move either.
      const bare = new Float32Array(cells.length * 3);
      const at = new Float32Array(cells.length * 3);

      cells.forEach(([x, z], i) => {
        dummy.position.set(x, height / 2, z);
        // Fences are thin posts; everything else fills its tile.
        const w = kind === 9 ? 0.9 : 1;
        const d = kind === 9 ? 0.22 : 1;
        dummy.scale.set(w, height, d);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // The pattern is per-cell colour and nothing else — no extra geometry,
        // no second mesh, no texture. At 45° across a room that is all that
        // survives anyway, and it costs one lookup in a loop that already sets
        // a colour per instance to jitter it.
        const c = new THREE.Color(surface ? patternColor(surface, x, z) : jitter(style.color, 0.05, x * 31 + z * 17));
        // ...and the lamps are the same kind of thing: a number per cell, worked
        // out once. This is what buys unlimited fittings — see `bakeInto`. The
        // unlit colour is kept beside it because the hour moves and the pattern
        // does not: re-deriving it would mean re-running `patternColor` and the
        // jitter hash for every cell in the shop at every rebake.
        bare[i * 3] = c.r;
        bare[i * 3 + 1] = c.g;
        bare[i * 3 + 2] = c.b;
        at[i * 3] = x;
        at[i * 3 + 1] = height;
        at[i * 3 + 2] = z;
        mesh.setColorAt(i, this.lights.bakeInto(c, x, height, z));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Off layer 0, where the point lights are. Baked ground lit a second time
      // by the pool would pool visibly harder under the eight fittings that got
      // a real light, which is the cap back on screen. See `BAKED_LAYER`.
      mesh.layers.set(BAKED_LAYER);
      this.bakedGround.push({ mesh, bare, at });
      this.staticRoot.add(mesh);

      // ...and the two patterns that are not a colour. See `STRIPE_BARS` and
      // `MAX_TUFTS`.
      if (surface?.pattern === 'stripes') this.addStripes(cells, surface, height, box, dummy);
      if (surface?.pattern === 'tufts') this.addTufts(cells, surface, height, dummy);

      // ...and the marks that say what a pad is FOR, which is the third thing on
      // this list that is not a colour and the only one that is not a pattern.
      // See `PAD_MARK`.
      if (PAD_MARK[kind]) this.addPadMarks(cells, PAD_MARK[kind], height, box, dummy);

      // A contrasting top slab, so a raised tile reads as built rather than as
      // an anonymous coloured block. Only the wall is left: the four furniture
      // entries went with the fixture tiles, and furniture draws its own art.
      const TOPS = { [T.WALL]: PALETTE.wallTop };
      if (TOPS[kind]) {
        const top = new THREE.InstancedMesh(box, material(TOPS[kind]), cells.length);
        top.castShadow = false;
        top.receiveShadow = true;
        // Baked with the slab it caps, or a wall under a lamp is a lit wall with
        // an unlit lid. Its instance colour is plain white before the lamps get
        // to it: the colour it is meant to be is already on the material.
        top.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
        const topBare = new Float32Array(cells.length * 3).fill(1);
        const topAt = new Float32Array(cells.length * 3);
        cells.forEach(([x, z], i) => {
          dummy.position.set(x, height + 0.045, z);
          dummy.scale.set(1.04, 0.09, 1.04);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          top.setMatrixAt(i, dummy.matrix);
          topAt[i * 3] = x;
          topAt[i * 3 + 1] = height + 0.045;
          topAt[i * 3 + 2] = z;
          top.setColorAt(i, this.lights.bakeInto(new THREE.Color(1, 1, 1), x, height + 0.045, z));
        });
        top.instanceMatrix.needsUpdate = true;
        if (top.instanceColor) top.instanceColor.needsUpdate = true;
        top.layers.set(BAKED_LAYER);
        this.bakedGround.push({ mesh: top, bare: topBare, at: topAt });
        this.staticRoot.add(top);
      }
    }

    this.addEdges(L);
    this.addFixtureProps(L);
    // After the fixtures, so the path is drawn over the decks rather than under
    // them. `staticRoot`, because it is a fact about the building and a re-flow
    // is what changes it — the same group the belts themselves live in, and
    // disposed wholesale with them.
    this.addConveyorPaths(L);
    // Only before there is anybody to follow — see `camFollowing`. A shop that
    // re-flows is still the shop you are standing in, and where you are looking
    // is not something a re-flow gets an opinion about.
    // The same height the follow uses, or the shot of the door you get before
    // anybody has spawned sits a body's height lower than every frame after it
    // — which is a lurch at exactly the moment the shop appears.
    if (!this.camFollowing) this.camTarget.set(L.door.x, EYE_Y, L.door.z + 2);
    this.storeLayout = L;
    // Only ever redraws when the map has changed SIZE — see `syncTileGrid`.
    this.syncTileGrid(L);
    // The fixture the pointer was over belongs to the old layout — a re-flow can
    // renumber it or move it out from under the marker. Whoever is aiming will
    // set it again on the next pointer move or frame.
    this.setAimTarget(null);
    // ...and the picked pile with it, for the same reason and one more: the
    // marker is measured off the goods meshes, which this teardown has just
    // disposed. `liveBoard` re-resolves the pick by id on the next frame, so a
    // pile that survived the re-flow gets its cage straight back.
    this.setPickedBoard(null);
  }

  /**
   * Take the stock and crops off fixtures the re-flow got rid of, and leave
   * everything else standing.
   *
   * This used to bin the lot, and that is what "painting a floor makes every
   * shelf redraw" was. The teardown is synchronous and the refill is not: goods
   * are drawn from the *snapshot*, which arrives ten times a second, so every
   * shelf in the shop and every bed on the farm went empty for up to 100ms and
   * then came back. One re-flow is a blink you could argue with — but build
   * mode re-flows on every placement, wall segment and floor stroke, so what it
   * actually reads as is the shop flickering the whole time you work in it.
   *
   * Nothing about a floor, a wall, or a shelf three aisles over changes what is
   * drawn on this board, which is why keeping the record is safe: `syncShelves`
   * re-reads position, rotation and boards every sync already — that is what
   * makes a fixture you MOVE take its stock with it — so a survivor is placed
   * against the new layout on the very next tick either way.
   *
   * Two halves, and both are load-bearing:
   *
   * - **A record whose fixture is gone must go**, meshes and all. Deleting from
   *   the map alone orphans them in the scene at the old positions, which is
   *   the scar `buildWorld` carries a paragraph about — stock apparently lying
   *   about on the floor, and another full set leaked on every re-flow. A
   *   plot's readouts are a second `actorRoot` child, so they go out by name.
   * - **A survivor's `key` is dropped**, so the next sync redraws its goods
   *   rather than trusting a cache built against the old shop. What is on
   *   screen stays up in the meantime, which is the whole point — but it is not
   *   *trusted*, because a tier that keeps its board count while moving the
   *   boards would otherwise leave every stack at the old heights.
   *
   * `stationProps` has worked this way since it was written — it sweeps its own
   * dead records at the end of `syncStations` — which is why an appliance's
   * readouts never flickered while every shelf in the building did.
   */
  refreshFixtureProps(L) {
    const alive = [
      new Set((L.shelves ?? []).map((s) => s.id)),
      new Set((L.plots ?? []).map((p) => p.id)),
    ];
    [this.shelfProps, this.plotProps].forEach((map, i) => {
      for (const [id, rec] of map) {
        if (alive[i].has(id)) { rec.key = null; continue; }
        this.actorRoot.remove(rec.group);
        disposeGroup(rec.group);
        if (rec.overlay) {
          this.actorRoot.remove(rec.overlay);
          disposeGroup(rec.overlay);
        }
        map.delete(id);
      }
    });
  }

  /**
   * The authored look of a fixture kind, or null if nobody has drawn one yet.
   * Content, so a shelf can be redesigned live; the rules for where it may go
   * stay in `shared/build.js`.
   *
   * Which *shape* of that kind comes off the fixture itself, because a corner
   * unit and a straight one are the same kind standing on the same tile.
   *
   * An appliance falls back to its own `station` kind as the variant, so a
   * blender and a toaster can look nothing like each other while staying one
   * fixture kind with one tier ladder. That's the whole variant bargain — a
   * look costs nothing and moves no number — and it means drawing a new
   * appliance is an MCP call rather than a change in here.
   */
  fixtureModel(f) {
    const piece = this.pieceOf(f);
    // `||`, not `??`: an unstyled fixture carries `variant: ''` rather than
    // nothing, and an empty string is a perfectly good value as far as `??` is
    // concerned — which quietly handed every appliance the generic model back.
    const variant = f.variant || (f.kind === 'station' ? f.station : null);
    return variantModel(piece, variant) ?? null;
  }

  /**
   * Which catalog row this fixture is drawn from.
   *
   * Was a lookup by kind, which is exactly what capped the catalog at one design
   * per kind. The same resolution the server uses, out of the same file, because
   * the two disagreeing about which shelf this is would be a shop that looks
   * different depending on who is standing in it.
   */
  pieceOf(f) {
    return pieceFor(this.catalog.pieces ?? [], f);
  }

  /** How many tiers this piece has, for turning a tier into 0..1 progress. */
  fixtureTiers(f) {
    return this.pieceOf(f)?.tiers?.length ?? 1;
  }

  /** Where this particular fixture sits on its kind's tier ladder, 0..1. */
  fixtureT(f) {
    return tierProgress(f.tier ?? 1, this.fixtureTiers(f));
  }

  /**
   * What the world is doing, and which face every prop that watches it wears.
   *
   * Two halves that arrive from different clocks and are deliberately not in the
   * same loop as each other. The VALUES are read here, off the snapshot, ten
   * times a second — a clock hand is a fact about the shop, so reading it any
   * faster is reading the same number again. The POSE a sweep takes from them is
   * per-frame, in `animateStations`, because that is the loop that already
   * knows how to hold still when the world is paused.
   *
   * The stage swap is here rather than there for the opposite reason: it is not
   * an animation. A shop that shut is shut whether or not the page is drawing,
   * and a pause must not leave a sign lying about it.
   *
   * A signal the snapshot cannot answer keeps its last value rather than
   * defaulting, which is what stops a dropped field reading as midnight.
   */
  syncSignals(state) {
    for (const name of SIGNAL_NAMES) {
      const v = signalValue(name, state);
      if (v != null) this.signals[name] = v;
    }
    // A watcher that is also a LAMP has to take its glow with it. Re-aiming the
    // pool is cheap; the bake behind it is a pass over every cell times every
    // lamp, so this is gated on the value having actually moved a step — the
    // same bargain `syncDayCycle` strikes when it rebakes on the hour rather
    // than continuously. `open` is a step already, so a shop shutting pays for
    // exactly one; a lamp somebody wires to `time` pays for a dozen a day, which
    // is the order the sunset itself costs.
    if (this._litWatchers?.length && this.lightsWant() !== this._litAt) {
      this.aimLights(this._layout?.layout ?? this._layout);
      this.rebakeGround();
    }
    for (const rec of this.signalFixtures.values()) {
      if (!rec.stages) continue;
      const v = this.signals[rec.signal];
      if (v == null) continue;
      const i = stageIndexAt(rec.model, v);
      if (i === rec.shown) continue;
      rec.shown = i;
      rec.stages.forEach((g, j) => { g.visible = j === i; });
    }
  }

  /**
   * A built model, down to one mesh per colour.
   *
   * A shelf is eight or ten primitives that will never move relative to each
   * other, and a furnished shop is a few hundred of them drawn twice a frame.
   * Anything flagged `motion` is held out by name: welded, the picture would be
   * right and the blade would never turn again, which reads as a broken machine
   * rather than as a broken renderer. Whatever it comes back as still wears the
   * group's `userData`, so picking, landing and the moving list all go on
   * pointing at the same things.
   */
  weldMoving(prop) {
    if (!prop || prop.userData.moving?.length === undefined) return prop;
    const spin = new Set(prop.userData.moving.map((m) => m.mesh));
    return weld(prop, spin.size ? (o) => spin.has(o) : null);
  }

  /**
   * A prop that watches the shop, built wearing EVERY look it has, with the one
   * the world currently calls for visible.
   *
   * Every other staged model in the game is rebuilt when its stage changes — a
   * crop that grew, a fixture you upgraded — and both of those happen at human
   * speed, on a thing whose art is about itself. A signal is not: it changes on
   * the shop's clock rather than on a purchase, so rebuilding would put geometry
   * churn on a timer nobody pressed, and it would have to re-run the whole tail
   * of `addFixtureProps` — the pick box, the bake, the layer, the land — or
   * quietly drop one of them. Building every stage instead costs a few meshes on
   * a prop with at most sixteen parts and makes the swap a boolean.
   *
   * It also keeps the two callers of `modelExtent` honest for free: that
   * function already answers "how much room does this need" across every stage,
   * so a pick box drawn round all of them is the box the rest of the game
   * already believes in.
   */
  buildWatcher(model, signal, opts) {
    const g = new THREE.Group();
    g.userData.moving = [];
    g.userData.stages = [];
    // Which look the shop is asking for, off the last snapshot. Not for the
    // first re-flow of a session — there has been no snapshot then, and stage 0
    // for one frame is nothing anybody sees. It is for every re-flow AFTER that:
    // build mode re-flows on every wall segment of a drag, so a sign that came
    // back reading CLOSED and corrected itself a tenth of a second later would
    // flicker its way across the shop as you built.
    g.userData.shown = stageIndexAt(model, this.signals?.[signal] ?? 0);
    for (const [i, stage] of model.stages.entries()) {
      const sub = this.weldMoving(buildModel({ parts: stage.parts }, opts));
      sub.visible = i === g.userData.shown;
      g.add(sub);
      g.userData.stages.push(sub);
      g.userData.moving.push(...(sub.userData.moving ?? []));
    }
    return g;
  }

  /**
   * How far to seat a fixture's art off a wall behind it, as a world offset.
   *
   * A wall is drawn ON the line between two cells and is `t` thick (0.17),
   * centred — so it eats about 0.085 of a tile into the cell on each side, and
   * a painted brick face adds a `SKIN` on top of a `SKIN`, standing proud. The
   * art meanwhile fills its cell: most units reach ±0.39 to ±0.44 and the
   * gondola reaches ±0.525 along its face, which is wider than the tile it
   * stands on. So the end of a run meeting a wall side-on clips by up to 0.14,
   * and a run of shelving ending at a wall is the common case rather than a
   * corner of one.
   *
   * **It is a look and never a rule** — the same line the floor brush draws.
   * Nothing here touches `tiles`, `blocked`, a working spot or a queue: the
   * fixture still occupies its cell, is still reached from the same side, and
   * still costs the same. The art is simply seated against the wall's FACE
   * rather than against the cell boundary, which is where a real shelf stands.
   *
   * Measured rather than constant, and that is the whole of why it needs the
   * model. Shifted by a flat 0.085 a shallow unit would come away from the wall
   * it is standing against and leave a gap — the same bug pointed the other
   * way, and harder to attribute because nothing is intersecting. So the shift
   * is the OVERLAP, `max(0, reach − free space)`, which is zero for anything
   * that already fits and moves nothing in a shop with no walls in it.
   *
   * **All four sides, and the first version did only the back, which was the
   * wrong axis and moved nothing at all.** A model is authored facing east, so
   * its back is `-x` — and that is the SHALLOW way round: shelving runs 0.60 to
   * 0.76 front-to-back and 0.78 to 1.05 along its own face. Every unit already
   * cleared the wall it was backed onto, and what actually pokes through is the
   * END of a run into a wall it meets side-on, which the back test cannot see.
   * The tell was a fix that built, ran and changed nothing — worth knowing
   * because "shelves back onto walls" is such a good story that it is easy to
   * check the geometry against the story instead of against the art.
   *
   * Opposite pairs are summed rather than fought over: a unit in a one-tile
   * alcove is squeezed from both ends and the two shifts cancel toward the
   * middle, which is where it should be. And only a kind with an `anchor` — a
   * belt, a plot and a decoration have no front, and a plot IS the ground.
   */
  artSetback(L, f) {
    const def = FIXTURES[f.kind];
    if (!def?.anchor) return null;
    const x = Math.round(f.x);
    const z = Math.round(f.z);
    const b = modelBounds(partsAt(this.fixtureModel(f), this.fixtureT(f)));
    const free = 0.5 - WALL_FACE;
    // How far the art reaches in each of its own four directions, paired with
    // the quarter turn off `rot` that points that way in the world. `+x` is the
    // front, so `+z` is a quarter turn past it — which is what the renderer's
    // own `rotation.y = -rot * (π/2)` works out to.
    const reach = [
      [0, b.maxX], [1, b.maxZ], [2, -b.minX], [3, -b.minZ],
    ];
    let dx = 0;
    let dz = 0;
    for (const [turnBy, out] of reach) {
      const over = out - free;
      if (!(over > 0.001)) continue;
      // The unit offset that way, borrowed off `anchorTile` at the origin rather
      // than re-listing the four facings here — one spelling of which way a
      // quarter turn points, in the file that owns it.
      const dir = anchorTile(0, 0, rot4((f.rot ?? 0) + turnBy));
      if (!SOLID.has(edgeBetween(L, x, z, x + dir.x, z + dir.z))) continue;
      // Away from the wall, which is the opposite of the way it was reaching.
      dx -= dir.x * over;
      dz -= dir.z * over;
    }
    return dx || dz ? { dx, dz } : null;
  }

  /**
   * Stand every fixture's authored model in the world.
   *
   * These go in `staticRoot` with the rest of the building: a fixture only
   * moves when the layout re-flows, and that is exactly when this runs again.
   */
  addFixtureProps(L) {
    // Which unit stands on which tile, so a seam can ask what is next door.
    // Built here rather than read off `fixtureAt`, because `storeLayout` is
    // still the *previous* shop until the end of `buildWorld`.
    const byTile = new Map();
    const spots = new Map();
    for (const f of fixturesIn(L)) {
      byTile.set(`${f.x},${f.z}`, f);
      spots.set(f.id, `${f.x},${f.z}`);
    }

    // What arrived since the last build, and therefore what should land rather
    // than simply be standing there. Keyed by *where* each id was and not by
    // whether the id is new, so setting down something you picked up lands too
    // — a fixture you carried across the shop and put down is the clearest case
    // of plopping there is, and it keeps its id the whole way.
    //
    // Ids are only comparable at all because a stamped shop stops re-minting
    // them (`Game.freezeShell`); against the old generator every re-flow would
    // have looked like a shop full of arrivals.
    const was = this._fixtureSpots;
    this._fixtureSpots = spots;
    let landed = new Set();
    if (was) {
      for (const [id, at] of spots) if (was.get(id) !== at) landed.add(id);
      if (landed.size > STAMP_MAX) landed = new Set();
    }

    // Every mesh in here was built against the shop we are about to replace.
    // Emptied before the loop rather than in `buildWorld` so that the one place
    // that fills it is the one place that clears it.
    this.movingFixtures.clear();
    this.signalFixtures.clear();
    this.propBoxes.clear();
    this.bakedProps = [];

    for (const f of fixturesIn(L)) {
      // A conveyor's slats come out here and are re-laid by `addConveyorSlats`,
      // because a slat has to follow the PATH through the cell and a part
      // authored in model space can only ever lie one way. They stay authored —
      // colour, count and thickness are read back off the model, so a tier that
      // wants eight thin ones still gets eight thin ones — they are simply
      // placed by the renderer rather than by the author.
      const model = this.conveyorBody(this.fixtureModel(f), f, L);
      const signal = this.pieceOf(f)?.signal ?? null;
      const opts = { abuts: (step) => this.carriesOn(byTile, f, step) };
      // A fixture nobody has drawn used to be a coloured tile block, because it
      // WAS a tile. Nothing stamps one now, so an unstyled kind would be an
      // invisible thing you can walk into — hence the fallback block, at the
      // colour and height its tile used to have.
      let prop;
      if (!model) prop = plainBlock(FIXTURE_LOOK[f.kind]);
      else if (signal && isStaged(model)) prop = this.buildWatcher(model, signal, opts);
      else prop = this.weldMoving(buildModel(model, { ...opts, t: this.fixtureT(f) }));
      if (!prop) continue;
      // Models are authored facing east, which is rot 0 — the same convention
      // the layout generator has always used for which side you work from.
      // A LOADER is turned by the FLOW, not by `rot`.
      //
      // `rot` on a loader means the side it unloads into — the shelf — which is
      // across the run, not along it. Turned by that, its deck lies at ninety
      // degrees to the belt it is part of: a run reads as alternating slabs with
      // grass showing between them, which is the opposite of the one thing a
      // conveyor has to look like. The sideways half is the shaft's job, and the
      // shaft is drawn separately.
      // ...and an EXIT is the entry's art turned round.
      //
      // Both mouths are laid facing the way the goods go, which is what makes
      // the pair derivable at all — but the art is not symmetrical: the hood is
      // the end goods dive INTO, so drawn at the same angle the far mouth is a
      // second entry, with its hood facing downstream and its open end at the
      // tunnel. Which looks exactly like one of the two was placed backwards.
      const flowRot = derivedFlow(f.kind) ? this.conveyorFacing(L, f)
        : (f.kind === 'under' && !tunnelExit(L, f)
          ? rot4((f.rot ?? 0) + 2) : (f.rot ?? 0));
      prop.rotation.y = -flowRot * (Math.PI / 2);
      // ...and the housing goes on a side nothing is attached to, which is a
      // question about the shop rather than about the model. See
      // `attachConveyorBack`.
      this.attachConveyorBack(L, f, prop, flowRot);
      // Seated off the wall behind it, if there is one and the art would go
      // through it. Null everywhere else, which is most of the shop — see
      // `artSetback`. Its stock is moved by the SAME call in `syncShelves`, or
      // the goods stay where the shelf used to be drawn.
      const off = this.artSetback(L, f);
      // The MIDDLE of what it covers, which is its own tile for everything one
      // cell wide and a half-tile diagonal for a pen. `f.x, f.z` is the min
      // corner of a block, so art stood on it would sit a whole tile up-screen
      // of the ground the thing is standing on.
      const mid = footprintMid(f.kind, f.x, f.z);
      prop.position.set(mid.x + (off?.dx ?? 0), this.fixtureBaseY(f), mid.z + (off?.dz ?? 0));
      // One thing you can point at, whatever it is made of. `pickFixture`
      // raycasts these and walks back up to whichever group wears the flag.
      prop.userData.pick = true;
      // ...and WHICH fixture this group is, which the tile it stands on can no
      // longer say. A decoration stamps no tile on purpose, so a lamp hangs
      // over a shelf and a plant stands at the end of a counter — two fixtures,
      // one tile, and `fixtureAt` can only ever answer the first of them.
      // Stamped here rather than looked up later because this is the one place
      // that knows: the group is built FROM `f`. Safe against the re-minting
      // `fixtureAt` was chosen to dodge, too — these groups are rebuilt from
      // the layout in the same call that re-mints, so the id on one is never
      // older than the mesh.
      prop.userData.fixture = f.id;
      this.staticRoot.add(prop);
      // How big it came out, in world space, for anything that has to treat the
      // thing as an object rather than as a cell. Two callers, and they have to
      // agree or the game lies: `pickFixtureHit` tests the pointer against this,
      // and the aim marker draws a cage of exactly it. Only for props — every
      // other kind owns its tile, and a tile is the better answer for those,
      // since you point at a shelf to walk to the side of it.
      //
      // Measured here because this is the only place the art exists as a whole:
      // `modelBounds` knows the model and not the tier it resolved to, the
      // variant it picked, or where it ended up standing.
      if (isProp(f.kind)) {
        prop.updateMatrixWorld(true);
        this.propBoxes.set(f.id, new THREE.Box3().setFromObject(prop));
      }
      // Baked, like the ground it stands on. A lamp is a point *under* a
      // canopy, so the lid of a display case faces away from every light in the
      // room and stays dark however bright the strip inside it is — which reads
      // as the upgrade not working. This has no direction to get wrong.
      //
      // Measured at half the unit's height, so a tall case is lit by what is
      // beside it rather than by what is on the floor at its feet.
      this.bakedProps.push({ group: prop, x: f.x, y: this.fixtureBaseY(f) + 0.5, z: f.z });
      this.paintProp(prop, f.x, this.fixtureBaseY(f) + 0.5, f.z);
      // ...and off layer 0 with the ground, or the eight real lights would light
      // it a second time and the units near you would flare as you walked.
      prop.traverse((o) => o.layers.set(BAKED_LAYER));
      if (landed.has(f.id)) this.land(prop, f.x, f.z);
      // Anything authored with `motion`. Two identical machines side by side
      // would otherwise beat in perfect unison, which reads as one animation
      // playing twice rather than as two machines — so each gets a fixed offset
      // out of where it stands, which survives a re-flow the way its id does.
      if (prop.userData.moving?.length) {
        this.movingFixtures.set(f.id, {
          moving: prop.userData.moving,
          phase: (f.x * 0.31 + f.z * 0.17) % 1,
          // What this one watches, if anything, so `animateStations` can hand a
          // sweep the number it turns to. On the record rather than looked up
          // there, for the reason the fixture id is stamped on the group above:
          // this is the call that knows, and a catalog re-read between now and
          // then would answer about a piece that has since been edited.
          signal,
          // Every conveyor cell knows what busy means — it is busy while there
          // is a box on it — so a run only animates where there is something to
          // move. An empty shop with sixty cells of belt in it was sixty meshes
          // being rewritten twenty times a second to say nothing, and a still
          // belt is also the honest picture: what moves is what is moving.
          conveyor: CONVEYOR_KINDS.includes(f.kind),
        });
      }
      // ...and anything that watches the shop. A prop with stages on a signal is
      // built wearing EVERY look it has, with one of them visible — see
      // `buildWatcher`. Registered even when it has no stages, because a clock is
      // one look with hands on it and `syncSignals` is where its number arrives.
      if (signal) {
        this.signalFixtures.set(f.id, {
          signal, model, stages: prop.userData.stages ?? null, shown: prop.userData.shown ?? 0,
        });
      }
    }

    // Lamps are set at the TOP of `buildWorld` now, not here, because the floor
    // is baked with them on the way past — this method runs after the tiles are
    // already coloured. It is the same call against the same layout either way.
  }

  /**
   * What height a fixture's model stands on.
   *
   * Two answers now rather than three, which is a fixture no longer being a
   * tile: everything stands on the ground it is standing on. A plot is the one
   * that reads oddly and is right — its `ground` IS a dug bed, so its model sits
   * on top of that tile rather than on the floor. And a hanging prop hangs,
   * which is the one thing an authored model cannot say about itself.
   */
  fixtureBaseY(f) {
    if (FIXTURES[f.kind]?.at === 'ceiling') return CEILING_Y;
    // ...and a conveyor cell hangs because of its PLACEMENT rather than its
    // kind, which is the whole of what a second storey is. A belt, a loader, a
    // sorter and a tunnel mouth are one kind each on either deck — four ceiling
    // kinds would be four duplicates to keep in step with the four originals.
    if (deckOf(f) === CEILING) return CEILING_Y;
    const ground = FIXTURES[f.kind]?.ground;
    return ground == null ? 0 : (TILE_STYLE[ground]?.h ?? 0);
  }

  /**
   * Does the shelving carry on past this side of `f`?
   *
   * What a `seam` part asks before it draws itself. The test is the same kind
   * of unit, stood the same way round, on the next tile along: an end panel is
   * there to close the run, and the run has not ended if what comes next is
   * more of it.
   *
   * Deliberately not the same *variant*: a wall run flowing into a corner unit
   * is still one shelf, and that is what `carriesMore` is for.
   *
   * It said the same about the TIER, on the grounds that a tier is a number
   * rather than a shape — and that is exactly as true as the model somebody
   * authored. Every staged piece in the game makes it false: the shipped shelf
   * goes Plain, Backed, Signed, and the gondola moves its boards and its depth
   * between rungs, so a run of two at different rungs dropped the panel between
   * two units whose shelves do not line up. What you get is not a longer aisle,
   * it is a hole with a board sticking out of it — visible in a screenshot and
   * in nothing else, since both units are correct on their own.
   *
   * So the test is the ART rather than the tier, which is `carriesMore`'s own
   * argument said one step along: two units carry on if their boards are at the
   * same heights and the same depth, whatever rung either is standing on. A
   * ladder whose rungs only move numbers still flows, a bakery case beside a
   * shelf does not, and the next piece anybody authors is judged by what they
   * drew rather than by a field they have to remember to set.
   *
   * The comparison is CONTAINMENT rather than equality, and the corner is the
   * whole reason: a corner unit IS the run plus a second wing, so it carries
   * boards the run does not and always will. Asked as an equality it can never
   * match the thing it is a corner of, which put a panel back on every row in
   * the shop where it met one — and it is invisible in the file, because both
   * pieces are drawn perfectly correctly on their own.
   */
  carriesOn(byTile, f, step) {
    const d = turn(step, f.rot ?? 0);
    const n = byTile.get(`${f.x + d.dx},${f.z + d.dz}`);
    if (!n || n.kind !== f.kind) return false;
    const mine = this.boardProfile(f);
    const theirs = this.boardProfile(n);
    if (!contains(theirs, mine)) return false;
    if (rot4(n.rot ?? 0) === rot4(f.rot ?? 0)) return true;
    // ...or the row TURNS here. A corner unit stands at a different rot to the
    // run butting into it — that is what makes it a corner — so a same-rot test
    // called every run beside one an end, and every row in the shop grew a panel
    // where it met the corner it was supposed to flow into.
    return carriesMore(theirs, mine);
  }

  /**
   * The shape of a unit's shelving, as a list two units can be compared by.
   *
   * Heights and depth, and neither is arbitrary: those are the two things that
   * have to agree for a dropped end panel to read as one run. A rung that only
   * multiplies capacity draws the same boxes and answers the same boards, so
   * `carriesOn` goes on flowing through it — which is the behaviour the old
   * "not the tier" rule was protecting and is now a consequence rather than an
   * assumption.
   *
   * The depth is the SHORTER horizontal axis rather than z, which is the one
   * number in here that looks like a detail and is the whole corner bug.
   * `surfacesAt` calls `scale[0]` the span and `scale[2]` the depth, which is
   * only true of a board running along x — and every wall-mounted piece in the
   * game runs along z, so for those `scale[2]` is the LENGTH OF THE RUN and not
   * a depth at all. A corner's wing is shortened to make room for its return
   * (0.82 of a tile against a full one), so read that way a corner is never the
   * same shelving as the run it continues, however carefully either was drawn.
   * The shorter axis is the depth on either orientation, which is the same
   * reading `buildShelfGoods` takes when it decides which way to file goods.
   *
   * Cached on what actually decides the art — the piece, the variant and the
   * tier — because this is asked per seam part per fixture on every re-flow,
   * and a shop is a few hundred of them. The cache is cleared with the scene it
   * describes (`buildWorld`), so a piece edited live is re-read.
   */
  boardProfile(f) {
    const key = `${f.piece ?? f.kind}|${f.variant ?? ''}|${f.tier ?? 1}`;
    const had = this.profiles.get(key);
    if (had !== undefined) return had;
    const out = surfacesAt(this.fixtureModel(f), this.fixtureT(f))
      .map((b) => `${b.y.toFixed(2)}:${Math.min(b.span, b.depth).toFixed(2)}`);
    this.profiles.set(key, out);
    return out;
  }

  /**
   * Walls, windows, doorways and fences — the things that live on the
   * boundaries between cells rather than on a cell of their own.
   *
   * One instanced mesh per edge kind per orientation, because a vertical run
   * and a horizontal one are the same box turned ninety degrees and batching
   * them separately is cheaper than carrying a rotation per instance.
   *
   * A doorway draws its header and threshold but no leaf, so the gap you walk
   * through is visibly a gap.
   */
  /**
   * A new coat of paint, without rebuilding the shop.
   *
   * The whole reason `paint-face` answers with an overlay instead of a layout.
   * `buildWorld` disposes every wall, floor, fixture and prop in the building
   * and makes them again, which is the right answer when something has actually
   * moved and an absurd one for a colour — and `addEdges` already stands alone,
   * because it is rebuilt on every quarter turn of the camera.
   *
   * The map is kept on `storeLayout` rather than beside it, so the next genuine
   * re-flow (which carries its own copy) and this path cannot disagree about
   * what is painted.
   */
  setPaint(map) {
    if (!this.storeLayout) return;
    this.storeLayout.paint = { ...(map ?? {}) };
    this.addEdges(this.storeLayout);
  }

  addEdges(L) {
    // Rebuilt on every quarter turn, so it owns a group of its own rather than
    // living loose in staticRoot — turning the camera must not rebuild the shop.
    if (this.edgeGroup) {
      this.staticRoot.remove(this.edgeGroup);
      disposeGroup(this.edgeGroup);
    }
    this.edgeGroup = new THREE.Group();
    this.staticRoot.add(this.edgeGroup);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();


    // [kind, orientation] -> the boxes to draw for it.
    const runs = new Map();
    // Keyed by colour as well as by kind and orientation, because a band may
    // carry its own — a signed way through is an ordinary opening with its
    // threshold painted (see `edgeBands`). One material per mesh, so a run has
    // to be uniform in it.
    // ...and by which SIDE it is a skin of, because a painted face is drawn at
    // its own thickness pushed out to the surface of the wall — see `paintSkin`.
    // A run is uniform in everything the loop below reads off `set[0]`, and that
    // now includes whether these boxes are wall or finish.
    const push = (kind, vertical, spec) => {
      const k = `${kind}:${vertical ? 'v' : 'h'}:${spec.color ?? ''}:${spec.skin ?? ''}`;
      if (!runs.has(k)) runs.set(k, { kind, vertical, boxes: [] });
      runs.get(k).boxes.push(spec);
    };

    // What each face is finished in, if anything. The overlay rides on the
    // layout (`Game.regenerateLayout` hangs it on the end) and is replaced on
    // its own by `setPaint` — a repaint rebuilds these walls and nothing else.
    const paint = L.paint ?? {};
    const paintOn = (o, x, z, side) => {
      const piece = paint[faceKey({ o, x, z, s: side })];
      return piece ? surfaceOf(this.catalog.pieces ?? [], piece, PALETTE.wall) : null;
    };

    // What an edge is made of comes from `edgeBands`, beside the style it reads,
    // because the palette button offering to sell you one draws from it too —
    // see client/thumb.js.
    // Which way is OUT, for the one band that projects. A bay window belongs on the
    // street side, and an edge does not know its own sides — so it is read off the
    // enclosure the same way `shopperCanCross` reads "in": the outdoor cell wins.
    // With nothing to go on (both sides indoors, both out, or a shop whose walls
    // have come down and has no inside at all) it falls to the positive axis,
    // which is a decision rather than a guess: it has to be the same answer every
    // re-flow, or a bay would flip sides when you built a shelf.
    const outward = (vertical, x, z) => {
      const m = L.indoor;
      if (!m) return 1;
      const at = (cx, cz) => (cx < 0 || cz < 0 || cx >= L.w || cz >= L.h
        ? 0 : m[cz * L.w + cx]);
      const a = vertical ? at(x - 1, z) : at(x, z - 1);
      const b = vertical ? at(x, z) : at(x, z);
      if (a === b) return 1;
      return a ? 1 : -1;
    };

    const emit = (kind, vertical, cx, cz, x, z) => {
      const style = EDGE_STYLE[kind];
      if (!style) return;
      const dir = style.out ? outward(vertical, x, z) : 1;
      const bands = edgeBands(style);
      for (const band of bands) push(kind, vertical, { cx, cz, dir, ...band });

      // ...and the finish on either side of it, as a skin over the bands that
      // are wall. Two things are deliberately left bare. GLASS, because paint on
      // a window is paint on the frame — a finish over the pane is a bricked-up
      // window, and the sill and header beside it take the colour anyway. And a
      // band that already carries a COLOUR of its own, which is the painted
      // threshold under a signed doorway: that stripe is the only thing on
      // screen saying who a door is for, and a finish that covered it would
      // delete the one visible half of a feature that is otherwise invisible.
      for (const side of [-1, 1]) {
        const surface = paintOn(vertical ? 'v' : 'h', x, z, side);
        if (!surface) continue;
        for (const band of bands) {
          if (band.alpha !== undefined || band.color) continue;
          // The pattern is read at the band's own height rather than per cell,
          // because a wall repeats UP as well as along: `patternColor` takes two
          // coordinates and the second one here is the course, not the row.
          push(kind, vertical, {
            cx, cz, dir, y0: band.y0, y1: band.y1, skin: side,
            color: patternColor(surface, vertical ? z : x, Math.round(band.y0 * 8)),
          });
          // ...and the bricks on top of it, which is the third pattern that is
          // geometry rather than a colour (`stripes` and `tufts` are the other
          // two, and the argument is identical): a cell is a metre and a half,
          // so brick painted as a colour is a brick the size of a door. The flat
          // skin above is the mortar — see `patternColor` — and these stand
          // proud of it, so what reads at 45° across a room is the joint's own
          // shadow rather than a red rectangle.
          const bond = bondOf(surface);
          if (!bond) continue;
          // `phase` is where this face starts along its own wall, so the courses
          // run THROUGH the cell boundary instead of stopping at it — see
          // `brickBond`, where the version that stopped is written up. A
          // vertical wall runs along z and a horizontal one along x.
          for (const b of brickBond(bond, 1, band.y0, band.y1,
            (vertical ? z : x) - 0.5)) {
            push(kind, vertical, {
              cx, cz, dir, y0: b.y0, y1: b.y1, skin: side, proud: true,
              off: b.off, len: b.len,
              color: jitter(surface.color, 0.035, b.seed),
            });
          }
        }
      }
    };

    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        const kind = L.edgesV?.[z * (L.w + 1) + x] ?? 0;
        // Centre of a vertical edge: on the lattice line in x, mid-cell in z.
        if (kind) emit(kind, true, x - 0.5, z, x, z);
      }
    }
    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        const kind = L.edgesH?.[z * L.w + x] ?? 0;
        if (kind) emit(kind, false, x, z - 0.5, x, z);
      }
    }

    for (const { kind, vertical, boxes } of runs.values()) {
      const style = EDGE_STYLE[kind];
      const opaque = boxes.filter((b) => b.alpha === undefined);
      const clear = boxes.filter((b) => b.alpha !== undefined);
      for (const [set, alpha] of [[opaque, 1], [clear, GLASS]]) {
        if (!set.length) continue;
        const mesh = new THREE.InstancedMesh(box,
          material(set[0].color ?? style.color, alpha), set.length);
        // Glass casts nothing, unless the band asks to. Which only a pane the size
        // of the wall does: the default is right for a bottle and a freezer door,
        // and wrong for a shopfront, because a building whose whole south face
        // stops laying a shadow reads as the wall having been demolished. Off
        // `set[0]`, and safely: a run is uniform in kind, orientation and colour,
        // so it is uniform in this too.
        mesh.castShadow = alpha === 1 || !!set[0].shadow;
        mesh.receiveShadow = true;
        set.forEach((b, i) => {
          // A band may project across the line — that is a bay window, and it is
          // the one thing here that is geometry rather than a stack of heights.
          // Thickness grows on ONE side and the centre shifts by half of it, or a
          // bay would bulge into the aisle as much as into the street.
          const out = b.out ?? 0;
          // ...and a FINISH is the other way round: no thickness of its own to
          // speak of, sat on the surface of the wall rather than spanning it. It
          // has to be a box rather than a plane for the same reason everything
          // else here is — one geometry, one instanced mesh, shadows for free —
          // and it has to stand a hair PROUD of the wall, or two coplanar faces
          // fight over the depth buffer and the wall flickers as the camera
          // turns. Which is a bug you only see in motion.
          const skin = b.skin ?? 0;
          // ...and a course of brick is a finish standing on a finish: thicker
          // than the skin it sits on and pushed out by half the difference, so
          // the joint between two of them has a real edge to cast into. Without
          // the extra thickness it is coplanar with the mortar and you are back
          // to a flat pattern, drawn twenty times more expensively.
          const proud = skin && b.proud;
          const t = skin ? (proud ? SKIN * 2.2 : SKIN) : style.t + out;
          const shift = skin
            ? skin * ((style.t + SKIN) / 2 - 0.001 + (proud ? SKIN * 0.6 : 0))
            : ((b.dir ?? 1) * out) / 2;
          // How far along the wall the box sits, and how much of it it covers.
          // One cell of both unless something has asked for less, which today is
          // only a brick — everything else here spans its cell exactly.
          const off = b.off ?? 0;
          const len = b.len ?? 1;
          dummy.position.set(
            b.cx + (vertical ? shift : off),
            (b.y0 + b.y1) / 2,
            b.cz + (vertical ? off : shift),
          );
          dummy.scale.set(
            vertical ? t : len,
            Math.max(0.02, b.y1 - b.y0),
            vertical ? len : t,
          );
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.edgeGroup.add(mesh);
      }

      // A contrasting coping along the top, so a wall reads as built rather
      // than as a coloured slab.
      if (!style.top) continue;
      // Skins excluded: a coping is the top of the WALL, and a second one laid
      // on each painted face would be two more slabs a hair either side of it —
      // three copings on a painted wall, which reads as the wall having grown.
      const capped = boxes.filter((b) => b.y1 >= style.h - 0.001
        && b.alpha === undefined && !b.skin);
      if (!capped.length) continue;
      const cap = new THREE.InstancedMesh(box, material(style.top), capped.length);
      cap.receiveShadow = true;
      capped.forEach((b, i) => {
        dummy.position.set(b.cx, style.h + 0.03, b.cz);
        dummy.scale.set(vertical ? style.t + 0.06 : 1, 0.07, vertical ? 1 : style.t + 0.06);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        cap.setMatrixAt(i, dummy.matrix);
      });
      cap.instanceMatrix.needsUpdate = true;
      this.edgeGroup.add(cap);
    }
  }

  // The awning used to be built here — four striped boxes hung off `L.door` on
  // every re-flow. It is content now: an `awning` piece in the build catalog,
  // stamped over the door as ordinary decorations the first time a save loads
  // (`freezeAwning`, server/sim/index.js). Which is what made it erasable: a
  // thing the renderer draws for you is a thing nobody can point at, price,
  // move or take down, and the palette had nothing that could replace it.

  // -------------------------------------------------------------------------
  // Dynamic actors
  // -------------------------------------------------------------------------

  syncState(state, myId) {
    /**
     * Whether the world is stopped, which the renderer has to be told rather
     * than able to work out.
     *
     * Everything else in here is a function of the snapshot, so a paused world
     * freezes for free — a body that does not move arrives at the same place ten
     * times a second. The exception is `animateStations`, which is the one loop
     * driven by the PAGE's clock instead of the shop's, precisely so a blade
     * turns at 60fps off a flag that arrives at 10Hz. Left alone it keeps
     * turning in stopped time, which reads as the pause having failed.
     */
    this.paused = !!state.paused;
    // Kept for `pickPerson`: the records hold the meshes, and the answer has to
    // be the person, not the group they are drawn as.
    this.playerState = state.players;
    // ...and the same for the shoppers, which nothing could point at until there
    // was a reason to: a tazer (docs/security.md step 3) is the first verb in
    // the game aimed at somebody who does not work here. Kept beside the line
    // above rather than derived at pick time, for its reason — `pickShoppers`
    // needs the wire record, and the record is what carries `stole`.
    this.customerState = state.customers;
    // Stashed on the scene rather than threaded through every sync that wants
    // it: how much a crate holds is a property of the shop, like the catalog,
    // and it is read by two renderers at different depths. Set BEFORE the actor
    // pass, which is the one that would otherwise key a carried crate against
    // `undefined` on the first frame and redraw it on the second.
    this.crateCap = state.crateCap ?? 6;
    // What the shop is doing, for anything drawn to say so. Before the actors,
    // because this is what a re-flow later in the same frame builds a sign
    // against.
    this.syncSignals(state);
    this.syncActors(state.players, this.players, (p) => this.buildActor(p), (p) => actorKey(p),
      // Only the people, and only once the body has been measured — see
      // `syncActors`' `onBuild` and `markUnder`.
      (rec, p) => this.markUnder(rec, p));
    this.syncActors(state.customers, this.customers, (c) => buildCharacter(c.color));
    // ...and the animals, keyed by which piece they came out of so that
    // redrawing a hen over MCP restages every hen in the shop — `syncActors`'
    // own `keyOf`, doing here exactly what it does for a promoted hire.
    this.syncActors(state.animals ?? [], this.animals,
      (a) => this.buildAnimal(a), (a) => a.piece ?? '');
    // The shop's own footfall map, when it is due — `trafficWire` sends it
    // every couple of seconds and leaves the field off in between, so this is
    // usually a compare against `undefined`. Adopted whether or not the overlay
    // is up, which is what makes turning it on show the fortnight already
    // played rather than an empty floor.
    this.heat.adopt(state.traffic);
    this.syncShelves(state.shelves);
    this.syncPlots(state.plots);
    this.syncPens(state.pens ?? []);
    this.syncCashDrops(state.cashDrops ?? []);
    // What each loader's last swing came to, which is what its lamp is coloured
    // by, and the transfer itself, which is what the crate travels. Maps rather
    // than a walk in `animateStations`, because that runs on the page's clock at
    // 60Hz against a snapshot that arrives at 10.
    //
    // BEFORE `syncDeliveries`, which is not tidiness: that function is where a
    // crate the shop has just forgotten is handed to `stepLeaving`, and it needs
    // to know which side the swing used to do it. Built afterwards, as it was,
    // it answered with the PREVIOUS snapshot's swing — right for as long as a
    // loader swung more slowly than the say-window, and quietly wrong the moment
    // one did not.
    this.armSaid = new Map((state.arms ?? [])
      .filter((a) => a.did).map((a) => [a.id, a.did]));
    this.armMove = new Map((state.arms ?? [])
      .filter((a) => a.move).map((a) => [a.id, a.move]));
    // ...and the junction's own, which is the same field and the same window —
    // see `sorterSent`. A sorter has no `did`: it takes nothing and refuses
    // nothing, it only chooses, so the way out IS the whole readout.
    this.sortMove = new Map((state.sorters ?? [])
      .filter((s) => s.move).map((s) => [s.id, s.move]));
    // WHEN a transfer started is stamped HERE, on arrival, rather than in
    // `animateStations`. Two readers need it — the frame loop, which runs the
    // crate down the spur at 60Hz, and `syncDeliveries` below, which has to know
    // not to put that same crate back on the machine — and a clock started by
    // one of them is a clock the other cannot see. `move.n` only goes up, so the
    // edge is unmissable however the snapshots land.
    const stamp = performance.now() / 1000;
    for (const [id, m] of this.armMove) {
      const body = this.movingFixtures.get(id);
      if (body && body.moveN !== m.n) { body.moveN = m.n; body.moveAt = stamp; }
    }
    this.syncDeliveries(state.deliveries ?? [], this.crateCap);
    this.syncVehicles(state.van ?? null, state.cars ?? []);
    this.syncStations(state.stations ?? []);
    this.syncActionRings(state.players, myId);
    this.syncLifted(state.players.find((p) => p.id === myId));
    this.syncActionTarget(state.players.find((p) => p.id === myId));
    this.syncStockTargets(state.players.find((p) => p.id === myId));
    // After the pips, because it stands down for them — see `syncWants`.
    this.syncWants(state.shelves);

    // Who the camera is riding on. Falling back to `me` when the hire being
    // watched has no body is not a nicety: they can be let go, or their kind
    // deleted over MCP, by the other player — and a camera left aimed at
    // somebody who is not there is a shop you cannot get back to.
    const me = state.players.find((p) => p.id === myId);
    /**
     * ...and the second thing that can borrow it, which is on a stopwatch.
     *
     * `cutTo` frames a thief for a couple of seconds (docs/security.md step 2).
     * It is checked BEFORE `watching` and falls back the same way, because the
     * rule that keeps this safe is the one above said twice: a camera aimed at
     * somebody who is not there is a shop you cannot get back to, and the person
     * this is aimed at is by definition running for the door.
     */
    if (this.cutUntil && performance.now() > this.cutUntil) this.cutOn = this.cutUntil = null;
    const cut = this.cutOn && (state.customers ?? []).find((c) => c.id === this.cutOn);
    const eye = cut
      || (this.watching && state.players.find((p) => p.hire === this.watching))
      || me;
    if (eye) {
      // Off the leash, the view stays where it was PUT — the body underneath it
      // stops being what it is aimed at.
      //
      // `camPan` is an offset off `camTarget` and `camTarget` is whoever the
      // camera rides, so a constant pan means the view is dragged along by
      // anything that moves them: a route still finishing when you opened the
      // mode, a shove, a rejoin. You are lining a shelf up against a wall four
      // rooms away and the whole shop slides. Absorbing the delta into the pan
      // holds the world centre still, which is what "free roam" was always
      // supposed to mean — and it costs nothing when the two are the same
      // number, which is every frame you are standing still.
      if (this.freeRoam) {
        this.camPan.x += this.camTarget.x - eye.x;
        this.camPan.z += this.camTarget.z - eye.z;
      }
      this.camTarget.set(eye.x, EYE_Y, eye.z);
      this.camFollowing = true;
      // Whose body first person is inside. Noted here rather than worked out in
      // `render`, because this is the one place that already knows which of the
      // three candidates won — and re-deriving it a second time is two answers
      // to one question, which is how the camera ends up in one person and the
      // hidden body ends up being somebody else's.
      this._eyeId = eye.id ?? null;
      if (this.freeRoam) this.clampPan();
      // ...and a restored view takes its offset from HERE, once. This is the
      // first moment the target is the thing it will be for the rest of the
      // session, and it is the same reference the pose was saved against — so
      // the round trip is exact rather than off by however far you had walked.
      if (this._wantCentre) { this.takeCentre(); this._wantCentre = null; }
    }

    // The day cycle. `daylight` is 0 at open and close, 1 at midday.
    //
    // Everything below moves together, which is the point: the old version only
    // nudged sun intensity between 0.55 and 1.30 while a flat 0.9 white ambient
    // held the floor, so noon and dusk differed by about a tenth of the total
    // light in the scene and nobody could see it. Now the fill drops away with
    // the sun and both go warm, so the total swings 2.5 -> 1.0 *and* changes hue.
    const t = state.time ?? 0.5;
    const daylight = Math.sin(Math.PI * Math.min(Math.max((t - 0.25) / 0.6, 0), 1));

    this.sun.intensity = 0.30 + daylight * 1.00;
    this.sun.color.copy(SUN_DUSK).lerp(SUN_HIGH, daylight);

    // `spill` is every lamp too far away to be given a real light, folded into
    // one number — so panning sharpens the near end of the shop rather than
    // switching the far end off. It only ever lifts the things the bake cannot
    // reach now; the floor already has every one of those lamps in it.
    this.lights.setDaylight(daylight);
    this.ambient.intensity = 0.38 + daylight * 0.52 + this.lights.spill;
    this.ambient.color.copy(FILL_DUSK).lerp(FILL_HIGH, daylight);

    // ...and the shop's own ceiling, on the movers. Same ramp as `INDOOR_LIFT`
    // and deliberately the same shape — the two are one ceiling approximated
    // twice, so they have to rise together or a shelf brightens while the loaf
    // on it does not. Continuously, where the bake steps on the hour: the pool
    // already glides against that same stepped floor and nobody has ever caught
    // it, because what an eye reads at dusk is the total rather than the seam.
    this.roomFill.intensity = ROOM_FILL * (1 - daylight);

    // The baked half of the same sunset, on the hour. Every lamp in the shop is
    // already in the floor's colours (`bakeInto`), and that sum is only right
    // for one value of `lit` — so the ground has to be told the sun moved, the
    // same way the sky just was. By hour rather than continuously because it is
    // a pass over every cell times every lamp, and because a floor that eased
    // from night to noon over twelve steps is a floor nobody can see stepping.
    const hour = Math.floor(t * 24);
    if (hour !== this.bakedHour) {
      this.bakedHour = hour;
      this.rebakeGround();
    }

    // The sky is the largest single block of colour on screen, so it carries
    // most of the read. Mutated in place — `background` owns this Color.
    this.scene.background.copy(SKY_DUSK).lerp(SKY_HIGH, daylight);
  }

  syncActors(list, map, factory, keyOf = null, onBuild = null) {
    const seen = new Set();
    for (const a of list) {
      seen.add(a.id);
      const key = keyOf ? keyOf(a) : null;
      let rec = map.get(a.id);

      // What this one is drawn as changed — a promotion restaged the model, or
      // its kind was redrawn over MCP. The bubble and whatever is in their
      // hands are children of the body, so both leave with it and are re-hung
      // by the two syncs at the bottom of the loop.
      if (rec && rec.key !== key) {
        this.actorRoot.remove(rec.obj);
        disposeGroup(rec.obj);
        // The mark is not a child of the body (see `markUnder`), so nothing
        // above frees it — and a restage is a promotion or an MCP redraw, both
        // of which happen while somebody is stood in the shop. Left behind it
        // is a ring on the floor with nobody in it, and another one every time.
        this.dropFoot(rec);
        map.delete(a.id);
        rec = null;
      }

      if (!rec) {
        const obj = factory(a);
        rec = {
          obj, key, bubble: null, bubbleKey: null, carry: null, carryKey: null,
          haul: null, haulKey: null, kit: null, kitKey: null,
          // How big the body actually is, which is what `pickPerson` aims at.
          //
          // Measured ONCE, here, and off the bare body: this is the only moment
          // it is the body and nothing else. A bubble goes over their head, an
          // armful goes out in front and a crate sits on a shoulder, and all
          // three are children of `obj` — so a box measured any later grows
          // whatever they happen to be holding, and pointing at a thought
          // bubble would select the person under it.
          //
          // It is also the only moment `obj` is at the origin with no parent,
          // so `setFromObject` reads model space. Re-measuring after it is in
          // the scene would need the world matrix unpicking for no gain, since
          // a body's own dimensions never change — a restaged model (a
          // promotion, a redraw over MCP) rebuilds the record, which comes
          // straight back through here.
          ...bodyExtent(obj),
          // The break: the prop, which stage of it is built, whether they are
          // on one, and how far the body has eased into the slump. `phase` is
          // per-person and stable, so two hires sat on the same step don't
          // breathe in time with each other.
          pastime: null, pastimeKey: null, resting: false, slump: 0,
          phase: (hashId(a.id) % 628) / 100,
        };
        this.actorRoot.add(obj);
        map.set(a.id, rec);
        obj.position.set(a.x, 0, a.z);
        rec.tx = a.x;
        rec.tz = a.z;
        // Anything hung on a body that is NOT part of the body goes here rather
        // than in the factory, and the line is `bodyExtent` above: that box is
        // measured off the bare model in the one moment it is bare, so a foot
        // mark added a line earlier would hand `pickPerson` a grab radius the
        // width of the ring — somebody you could point at from a tile away.
        onBuild?.(rec, a);
      }
      // Where the shop says they are. The easing toward it happens per FRAME in
      // `animateActors`, not here — see `ACTOR_CHASE`. Kept as a target rather
      // than applied, because a snapshot is news about where somebody is and
      // not an instruction about when to draw them.
      rec.tx = a.x;
      rec.tz = a.z;
      // Kept as well as applied, because `animateRest` turns a body on its break
      // and needs to know what it would otherwise be facing — reading the mesh
      // back would have it blending against its own previous answer between
      // snapshots and drifting away from the shop's.
      rec.yaw = a.facing ?? 0;
      rec.obj.rotation.y = rec.yaw;

      // Stashed rather than applied: how cross someone looks is animated at
      // 60fps in `animateMoods`, and a shake that only moved when state landed
      // would read as the renderer stuttering. Null for anyone who isn't a
      // shopper — staff and players have no patience to lose.
      rec.anger = a.anger ?? null;

      // ...and the same stashing, for the same reason, for whether their own
      // moving parts should be running. `job` arrives at 10Hz and a brush that
      // only turned when the snapshot did would read as a dropped frame — the
      // argument `animateStations` makes about a blade, said about a hire.
      //
      // A break is not work. `stepStaff` writes `job = 'break'` for a charge in
      // progress rather than clearing it (or the readout would flicker for the
      // whole charge), so the one thing this test has to spell out is that the
      // bot sat in the corner with a mug has stopped sweeping.
      //
      // ...unless the break IS the sweeping. A chore is a pastime by every
      // mechanism — it has a spot, a clock and a prop — and `job` therefore
      // says `break` for a hire doing a circuit of the floor exactly as it does
      // for one with a mug. `chore` is the sim's own answer to which, and it is
      // set from the tick the walk begins rather than the tick they arrive.
      rec.working = !!a.job && (a.job !== 'break' || !!a.chore);

      // A want is a thought; a carry is a thing in your hands. Showing both
      // through one bubble meant you could never tell which you were looking at.
      this.syncBubble(rec, a.want ?? null);
      // Two spellings of one fact, and they are now the SAME shape. A player or
      // a hire has `carry` and a shopper has a `basket`; both are a list of
      // piles somebody is holding, so both go through one sync as a list of
      // lines rather than growing a second renderer that would drift from this
      // one. `carry` used to be one pile and was wrapped in an array here to
      // fit — mixed hands simply deleted the wrapper, which is the tell that
      // the list was the right shape all along.
      // ...and a kit is the CONTAINER those goods are in, so it replaces them
      // rather than being hung on top: a shopper walking out with a bag is not
      // also walking out with five jars in mid-air. Nobody has to author one —
      // no kit is the loose armful, which is what every shopper had before.
      this.syncCarry(rec, a.kit ? null : (a.carry?.stacks ?? a.basket ?? null));
      this.syncKit(rec, a.kit ?? null);
      // ...and the box, which is the third spelling and deliberately not part
      // of that one. A crate is not "some goods held in a different pose" — it
      // is the container itself, drawn from the same `buildPallet` that draws
      // it standing in the yard, so setting one down is visibly the same object
      // arriving on the floor. Routed through `carry`'s list it would have come
      // out as twelve loose tomatoes at chest height.
      this.syncHaul(rec, a.haul ?? null, this.crateCap);
      this.syncPastime(rec, a);
    }
    for (const [id, rec] of map) {
      if (!seen.has(id)) {
        this.actorRoot.remove(rec.obj);
        this.dropFoot(rec);
        // The one sweep in this file that used to drop an actor without freeing
        // it. Mostly cheap — a body is shared `GEO` shapes — but not always:
        // whatever `syncHaul` hung on them is a `buildPallet`, and a pallet
        // carries a text label, which is a canvas and a texture nobody else
        // holds. A hire who logs out mid-trip leaked one every time.
        disposeGroup(rec.obj);
        map.delete(id);
      }
    }
  }

  /**
   * What one player-table entry is drawn as.
   *
   * A hire comes out of its kind's authored `model`, restaged by the rung they
   * have climbed to — the same `model` + `tiers` pair a shelf uses, resolved
   * through the same `tierProgress`. Workers were the last visible thing in the
   * game still hardcoded to a coloured capsule, and a promotion that changed a
   * number but not the person was half a ladder.
   *
   * Everyone else keeps the built-in character: a shopper is not authored
   * content, and the one in the white hat is you.
   */
  buildActor(p) {
    const kind = p.staff ? this.catalog.workers?.[p.staff] : null;
    if (!kind?.model) return buildCharacter(p.color, { hat: '#ffffff' });
    // A skin is worn, not owned: it is looked up per HIRE rather than per kind,
    // which is the whole reason two stockers can be told apart. An id naming a
    // skin that has since been deleted resolves to nothing and draws the bot as
    // authored — the same shrug `variantModel` gives a missing variant.
    const skin = p.skin ? this.catalog.skins?.[p.skin] : null;
    // ...over the top of which goes the charge, on the `glow` slot only. Built
    // as a skin rather than as a pass over the meshes afterwards because that is
    // what a slot IS — and because `weld` merges by material, so recolouring
    // after the fact would have to unpick a merge or repaint every other thing
    // in the shop that happens to share the colour.
    //
    // The id carries the band so anything keyed on the skin can still tell two
    // bodies apart. A bot with no `energy` — you — gets the skin untouched.
    const band = chargeBand(p.energy);
    const worn = band < 0 ? skin : {
      ...(skin ?? {}),
      id: `${skin?.id ?? ''}#${band}`,
      slots: { ...(skin?.slots ?? {}), glow: CHARGE_LOOK[band] },
    };
    return buildModel(kind.model, {
      t: tierProgress(p.tier ?? 1, kind.tiers?.length ?? 1), skin: worn,
    });
  }

  /**
   * One animal, off the `body` model of the pen it belongs to.
   *
   * No tier and no stage: `body` takes no 0..1 at all, because one pen draws as
   * many of these as the paddock is worth and each is somewhere different. That
   * is the whole reason it is a third model rather than more parts on the
   * shelter — see `body` in shared/schemas.js.
   *
   * A row that has been deleted out from under a body draws the built-in
   * character, which is the same shrug `buildActor` gives a hire whose kind has
   * gone: content is edited live, and the alternative to a shrug is a hole in
   * the field where something is standing.
   */
  buildAnimal(a) {
    const piece = (this.catalog.pieces ?? []).find((p) => p.id === a.piece);
    if (!piece?.body) return buildCharacter('#c9a227');
    // The two conventions `vehicleYaw` exists for, met a second time and settled
    // the same way. `body` lives on a `fixtures` row, so it is authored NOSE
    // EAST like every other piece of fixture art and like `docs/fixtures.md`
    // will draw it — while `syncActors` sets `rotation.y = facing`, which is a
    // +z-forward reading meant for a character whose nose is a nub on +z. A hen
    // authored east and turned by a body's facing walks sideways for ever, and
    // at this zoom a chicken is nearly symmetric: it reads as odd art rather
    // than as a quarter turn. Baked into a wrapper rather than applied on the
    // group, because `syncActors` owns `rotation.y` on whatever it is handed.
    const turned = new THREE.Group();
    turned.rotation.y = -Math.PI / 2;
    turned.add(buildModel(piece.body));
    const holder = new THREE.Group();
    holder.add(turned);
    return holder;
  }

  /**
   * Take the floor mark away with whoever was standing on it.
   *
   * The materials are freed by hand, which `disposeGroup` deliberately does not
   * do — it frees geometry and leaves materials alone because nearly every prop
   * in the game shares one out of the `material()` cache. A foot mark cannot use
   * that cache (it is transparent, double-sided and does not write depth, and
   * setting any of that on a cached material would set it on every prop wearing
   * the same colour), so it owns three of its own and nothing else is holding
   * them.
   */
  dropFoot(rec) {
    if (!rec?.foot) return;
    this.actorRoot.remove(rec.foot);
    rec.foot.traverse((o) => { if (o.isMesh) o.material?.dispose(); });
    disposeGroup(rec.foot);
    rec.foot = null;
  }

  /**
   * The ring on the floor under a person you are driving.
   *
   * People only, and that is the whole rule: `state.players` is you, anybody
   * you are sharing the shop with, and every hire — and a shop with a ring
   * under all fourteen of them is a shop with no rings in it. What this answers
   * is "which of these is me", which a bot is never the answer to.
   *
   * Its own object in `actorRoot` rather than a child of the body, which is the
   * one non-obvious bit. A body is turned by `facing`, bobbed as it walks and
   * TILTED as it slumps onto a break (`animateRest`) — so a ring parented to it
   * would lean off the floor and hang in the air beside somebody sitting down.
   * It is under their feet, which is a fact about the tile rather than about
   * the body, so it is carried at the eased position in `animateActors` and
   * never inherits anything else.
   */
  markUnder(rec, p) {
    if (p.staff) return;
    const g = buildFootMark(p.color);
    g.position.set(rec.obj.position.x, g.position.y, rec.obj.position.z);
    this.actorRoot.add(g);
    rec.foot = g;
  }

  /** Money sitting on a counter waiting to be picked up. */
  syncCashDrops(drops) {
    const seen = new Set();
    for (const d of drops) {
      seen.add(d.id);
      if (this.cashProps.has(d.id)) continue;
      const obj = buildCashDrop();
      // Sit on top of the till rather than inside it.
      obj.position.set(d.x, CASH_Y, d.z);
      obj.userData.born = performance.now();
      this.actorRoot.add(obj);
      this.cashProps.set(d.id, obj);
    }
    for (const [id, obj] of this.cashProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(obj);
      disposeGroup(obj);
      this.cashProps.delete(id);
    }
    this.syncCashLabels(drops);
  }

  /**
   * One number per tile, not one per sale.
   *
   * A pile carried its own `+$4.20`, which is right for the first sale and
   * wrong for the fourth: the server fans successive drops across a third of a
   * tile so they read as several piles rather than one, and from this camera
   * that turns four labels into a column of arithmetic standing over a till —
   * four numbers where the only question anybody has is *how much is on that
   * counter*. So the piles stay several and the readout becomes one, which is
   * the call `buildPallet` already made about a stack of crates.
   *
   * Keyed by tile rather than by the drop that happens to be nearest it,
   * because the drops under one label come and go: a sale lands, somebody walks
   * over half the pile, and a label that belonged to one of them would vanish
   * with money still sitting there. Rewritten in place through `setTextSprite`
   * rather than rebuilt, since the number moves on every sale and a sprite
   * costs a canvas, a texture and a material each time.
   */
  syncCashLabels(drops) {
    const totals = new Map();
    for (const d of drops) {
      const x = Math.round(d.x);
      const z = Math.round(d.z);
      const key = `${x}:${z}`;
      const at = totals.get(key) ?? { x, z, total: 0 };
      at.total += d.amount ?? 0;
      totals.set(key, at);
    }

    for (const [key, at] of totals) {
      let sprite = this.cashLabels.get(key);
      if (!sprite) {
        sprite = buildMoneyLabel(at.total);
        // Over the middle of the tile, not over any one pile: the fan is a look
        // and the tile is the thing being totalled.
        sprite.position.set(at.x, CASH_Y + 0.5, at.z);
        this.actorRoot.add(sprite);
        this.cashLabels.set(key, sprite);
      }
      // Handed the total every sync whether or not it moved — `setTextSprite`
      // returns early when the string is the one already painted, which is what
      // makes calling it unconditionally the cheap thing to do.
      setTextSprite(sprite, moneySaid(at.total));
    }

    for (const [key, sprite] of this.cashLabels) {
      if (totals.has(key)) continue;
      this.actorRoot.remove(sprite);
      disposeGroup(sprite);
      this.cashLabels.delete(key);
    }
  }

  /**
   * Pallets at the bay, the drop-off and anywhere goods were tipped out.
   *
   * **Crates on one tile stack.** A pallet holds one kind, so a shelf of three
   * things strips into three crates at one spot and the pad hands out its cells
   * before it starts doubling up — which drew every one of them at floor level,
   * inside each other, reading as one flattened crate rather than as three. A
   * tile is the unit of storage everywhere else in the shop; this is that said
   * in the one place it was only ever a coordinate.
   *
   * Stacking is a *look*, not a rule: nothing here caps a tile, because how much
   * a pad holds is how big you painted it and that stays the server's business.
   * So the pile grows as high as the goods dropped on it, and the height is what
   * tells you the yard is backing up.
   *
   * Order is by id, oldest at the bottom, which is both what a stack does and
   * the only ordering that stays put — the snapshot's array order changes as
   * crates are taken and the tower must not shuffle underneath your pointer.
   */
  syncDeliveries(deliveries, cap = 6) {
    const seen = new Set();
    const stacks = new Map();
    // Which conveyor cells are carrying something, which is what a loader's lamp
    // is wired to. `motion` runs while its fixture is WORKING and always runs on
    // a fixture with no idea what working means — a loader has one, and a lamp
    // blinking over an empty machine all night is the "photograph of a clock"
    // trap said about a light.
    this.beltBusy = new Set(deliveries.filter((d) => d.belt).map((d) => d.belt));
    // ...and which of those cannot hand on, which is a different question and
    // the one the ANIMATION should be asking. A belt runs while it has a box on
    // it, so a jammed run went on scrolling under a crate that was not going
    // anywhere — the shop knew, the picture did not, and a stopped line is the
    // only signal a jam has ever had.
    //
    // Derived here rather than sent: the client has the run and the boxes, and
    // "is the cell ahead taken" is the same test `stepBelts` makes. A junction
    // is stuck only when EVERY way out is, which is the whole reason a sorter
    // is worth building.
    const L = this.storeLayout;
    const onCell = new Map();
    for (const d of deliveries) if (d.belt) onCell.set(d.belt, d);
    // Kept, because `animateStations` needs to know WHICH crate is on a machine
    // in order to slide that one down its spur — see the swing below. It is the
    // same map the jam test is built from; the alternative is a second walk of
    // `deliveries` on the page's clock rather than on the snapshot's.
    this.beltOn = onCell;
    this.beltStuck = new Set();
    if (L) {
      for (const c of conveyorsOf(L)) {
        if (!onCell.has(c.id)) continue;
        const ways = [conveyorNext(L, c), ...conveyorBranches(L, c)].filter(Boolean);
        const open = ways.some((w) => {
          // ON THE STOREY THE WAY OUT NAMES. Asked without one this reads the
          // floor, which is `beltExit`'s own bug said about the jam readout: a
          // duct's hand-over resolves to whatever is underneath it, so an
          // overhead run backed up solid reports itself clear because the aisle
          // below it has room — and the amber tail that is the only signal a
          // player has for a jam never lights.
          const n = conveyorAt(L, w.x, w.z, deckOf(w));
          return !!n && !onCell.has(n.id);
        });
        if (!open) this.beltStuck.add(c.id);
      }
    }
    for (const d of deliveries) {
      // A crate riding a conveyor is not part of whatever pile happens to share
      // its square. It is never stacked on and never stacked under — one cell of
      // belt holds one crate — so filing it into a tower would draw it buried,
      // at floor level, under boxes it has nothing to do with, and take its
      // label away (`covered` hides the goods). The server's own `crateStacked`
      // makes the same exception for the same reason.
      if (d.belt) continue;
      const tile = `${Math.round(d.x)},${Math.round(d.z)}`;
      if (!stacks.has(tile)) stacks.set(tile, []);
      stacks.get(tile).push(d);
    }
    const level = new Map();
    const height = new Map();
    for (const pile of stacks.values()) {
      pile.sort((a, b) => (Number(a.id.slice(4)) || 0) - (Number(b.id.slice(4)) || 0));
      pile.forEach((d, i) => { level.set(d.id, i); height.set(d.id, pile.length); });
    }

    for (const d of deliveries) {
      // Underground. Not `seen`, so whatever mesh it had is disposed on the way
      // out and rebuilt at the far mouth — a box between two ends is nowhere at
      // all, and leaving it drawn parks it on the entry ramp for the length of
      // the span and then teleports it.
      // Underground, and ONLY underground.
      //
      // A loader and a sorter hid their crate for a while, on the reasoning that
      // a box inside a machine should not be drawn sitting on its roof. What
      // that cost is the one thing a conveyor is for: the box vanished at the
      // mouth and reappeared a cell later, so a run with machines in it stepped
      // instead of flowing — and a stutter on a line whose whole job is smooth
      // movement reads as the belt being broken. A tunnel gets away with it
      // because the span is genuinely somewhere else and takes real seconds; a
      // housing is one cell and about half of one.
      //
      // So the machine went up on legs instead: the hood clears a riding crate,
      // the track runs under it, and you watch the box go through. Covered by
      // what is over it rather than by not being drawn.
      if (d.hidden) continue;
      seen.add(d.id);
      const at = level.get(d.id) ?? 0;
      const covered = at < (height.get(d.id) ?? 1) - 1;
      // The level is part of the key: taking the top crate off has to redraw the
      // one under it, which is uncovered now and owes you a look at its goods.
      // `cap` is part of the key for the same reason `qty` is: buying a
      // rucksack moves what a crate holds, so every crate standing in the yard
      // is suddenly a different share of full and owes you a redraw.
      // Every pile is in the key, not just the first. A box whose second pile
      // changed while its first stayed put would otherwise keep the mesh it was
      // built with — so shelving the tomatoes out of a mixed crate would leave
      // the tomatoes drawn in it, which reads as stock that will not shift.
      const piles = (d.stacks ?? []).map((s) => ({
        ...s,
        model: this.catalog.items[s.item_id]?.model ?? null,
        name: this.catalog.items[s.item_id]?.name ?? '',
      }));
      // `waste` is in the key because it is in the picture: a crate the shop
      // gave up on is drawn in a different wood, and a box that changed hands
      // between the two without a redraw would keep whichever it was built as.
      const key = `${piles.map((s) => `${s.item_id}:${s.qty}`).join(',')}/${cap}:${at}:${covered ? 'c' : 'o'}${d.waste ? ':w' : ''}${d.belt ? ':b' : ''}`;
      const existing = this.deliveryProps.get(d.id);
      if (existing && existing.userData.key === key) {
        // A crate that is MOVING looks exactly the same as it moves, so its key
        // does not change and the cache above used to skip it entirely — and
        // the position was only ever written on the frame a mesh was built. So
        // a box rode the whole length of a belt invisibly and appeared at the
        // far end the moment something unrelated forced a rebuild, which reads
        // as a teleport rather than as a conveyor.
        //
        // Free for everything else: nothing but a belt has ever moved a crate,
        // so this writes the same three numbers it already held.
        existing.position.set(d.x, crateY(d, at), d.z);
        // Where it belongs with nothing happening to it. A swing offsets the
        // mesh between snapshots (see `animateStations`), so the position it
        // offsets FROM has to be the one the shop last said rather than wherever
        // the last frame left it — otherwise every swing walks the crate a
        // little further down the spur and it drifts off the end.
        existing.userData.homeX = d.x;
        existing.userData.homeZ = d.z;
        existing.userData.beltId = d.belt ?? null;
        continue;
      }
      if (existing) {
        this.actorRoot.remove(existing);
        disposeGroup(existing);
      }
      const obj = buildPallet(piles, {
        covered, cap, waste: d.waste === true, label: !d.belt,
      });
      // Sat on the deck of the belt rather than on the floor. `at` is 0 for
      // anything belted (it is in no pile), so this is the belt's own height and
      // never an offset into a tower.
      obj.position.set(d.x, crateY(d, at), d.z);
      obj.userData.homeX = d.x;
      obj.userData.homeZ = d.z;
      obj.userData.beltId = d.belt ?? null;
      // A BOX ON A CONVEYOR IS SMALLER THAN A BOX ON THE FLOOR.
      //
      // A pallet is drawn at the size of a thing somebody set down with both
      // hands, which is most of a tile — right in the yard, and too big the
      // moment it is riding a quarter-tile track past a machine 0.78 across. It
      // overhung the rails, and where a run went into a loader it went through
      // the housing on the way in: what you saw was a crate clipping a machine,
      // which reads as the machine being drawn in the wrong place.
      //
      // Scaled rather than modelled twice: it is the same crate with the same
      // goods on it and the same label rules, seen in transit. `BELT_DECK` is
      // measured to the carriers so the foot stays on the track — a scale about
      // the group's own origin lifts nothing, because that origin is the foot.
      if (d.belt) obj.scale.setScalar(BELT_CRATE);
      // A hand's turn per crate, so a tower reads as boxes somebody put there
      // rather than as one extruded box, and each one's edges stay findable to
      // point at. Alternating rather than random: a prop rebuilt on every
      // quantity change would otherwise jump each time you took one off it.
      obj.rotation.y = (at % 2 ? 1 : -1) * (at ? 0.07 : 0);
      obj.userData.key = key;
      // The id alone, and by id rather than by tile — the opposite of
      // `pickFixture`, and for the opposite reason. A fixture's id is re-minted
      // on every re-flow so its tile is the honest name; a pallet's id lasts as
      // long as the pallet does, while its tile is shared with whatever lands
      // there next. Nothing else off `d` is kept, because this group outlives
      // the snapshot that built it — the qty on it would be last minute's.
      obj.userData.delivery = d.id;
      this.actorRoot.add(obj);
      this.deliveryProps.set(d.id, obj);
    }
    for (const [id, obj] of this.deliveryProps) {
      if (seen.has(id)) continue;
      // NOTHING SPECIAL HAPPENS HERE ANY MORE, and that is the whole of the
      // fix.
      //
      // A pour used to delete the crate at the machine's centre on the tick it
      // happened, so this is where the mesh was caught and run down a spur by
      // hand — a second animator, on the page's clock, guessing at a journey the
      // shop had already finished. It fought `syncDeliveries` for the same three
      // numbers at two different rates, and every stutter and ghost came out of
      // that.
      //
      // The crate travels for real now (`stepSpur`, server side) and is deleted
      // when it ARRIVES, so by the time it disappears it is already at the unit
      // and there is nothing left to draw. A box that goes away for any other
      // reason — you lifted it, it merged, its item was deleted — goes away the
      // same way, instantly, which used to need a guard of its own.
      this.actorRoot.remove(obj);
      disposeGroup(obj);
      this.deliveryProps.delete(id);
    }
  }

  /**
   * Everything with wheels: the lorry on its delivery run, and the cars of
   * whoever drove here to shop.
   *
   * **One sync for both, because they are one thing** — a `vehicles` row
   * standing at a position, pointing somewhere. Every difference between them
   * is in the data rather than in the drawing: the van arrives as a single
   * field because there is one run at a time, the cars as a list because there
   * are as many as there are painted spaces, and the van carries a `load` where
   * a car does not. Neither this function nor `buildVehicle` can tell you which
   * one it is holding, and that is the test that the split is honest — the day
   * somebody authors a second `use`, it turns up here already drawn.
   *
   * Nothing about a van's *look* is decided here. The model comes off the row
   * the snapshot named, the stage comes off how full it is, and the fallback
   * for a row that has gone lives in `buildVehicle`. A renderer that knew what
   * a delivery van looks like would be the "a picture of a thing has to come
   * from the thing" mistake with a windscreen — and it would be the expensive
   * version of it, because the whole point of `vehicles` being content is that
   * a kid can draw a lorry.
   *
   * `phase` is deliberately not read. It says 'in' | 'unload' | 'out' so a
   * renderer could hold the thing still with its doors open rather than having
   * to notice it stopped moving — but the van already stops moving, and its
   * doors are three authored stages of `load`, which runs to zero over exactly
   * the pause `phase` describes. Two spellings of one fact is how the picture
   * and the state come apart; if something ever needs the phase it should need
   * it for a reason `load` cannot express.
   */
  syncVehicles(van, cars) {
    const seen = new Set();
    // The lorry first, under a key of its own — see `VAN_ID`. Concatenated
    // rather than looped over twice, because everything below is the same three
    // lines for either of them and a second copy is a second place to fix.
    const all = van ? [{ id: VAN_ID, ...van }] : [];
    for (const c of cars ?? []) all.push(c);

    for (const v of all) {
      seen.add(v.id);
      const model = this.catalog.vehicles?.[v.vehicle]?.model ?? null;
      // How loaded it is, which is the 0..1 a staged model wants. A car sends
      // no `load` at all and reads as full, which is the right answer for
      // anything unstaged and the honest one for a boot with the shopping in it.
      const t = Math.min(1, Math.max(0, v.load ?? 1));
      // Keyed on the STAGE rather than on the load. `load` runs down
      // continuously across the unload pause, so keying on it would rebuild a
      // group of meshes ten times a second for a picture that has not changed —
      // the same cache `syncStationWork` and the crops keep. The row id is in
      // there too so a van and a car never share a body by accident.
      const key = `${v.vehicle}:${model ? stageIndexAt(model, t) : 'none'}`;

      let rec = this.vehicleProps.get(v.id);

      if (!rec) {
        // The record is the DRAWN state — where the body has eased to and which
        // way it has come round to — kept apart from the group because the group
        // is thrown away and rebuilt every time the load crosses a stage.
        //
        // A new one starts exactly where the server says, never eased in from
        // wherever the last vehicle happened to be. A parked car does not
        // arrive: it is simply there, at a facing worked out once when its
        // driver claimed the space, so one that rolled into place and swung
        // round to face the door would be inventing a manoeuvre that never
        // happened. The van sets off eight tiles off the map (`lane.in[0]`), so
        // it is doing this out of sight either way.
        const yaw = vehicleYaw(v.facing);
        rec = { obj: null, key: null, x: v.x, z: v.z, yaw, tyaw: yaw };
        this.vehicleProps.set(v.id, rec);
      }

      if (rec.key !== key) {
        // Restaged, or drawn for the first time. **Rebuilt where it stands**,
        // not where the server says it is: a stage change is the load crossing
        // a threshold, which happens with the body still easing toward the
        // dock, and taking the target as the new position would be the lorry
        // jumping forward at the exact moment you are watching it unload.
        // `rec` carries the drawn state across the swap, which is most of why
        // it exists at all — the group is a thing this throws away.
        const at = rec.obj ? rec.obj.position.clone() : new THREE.Vector3(v.x, 0, v.z);
        if (rec.obj) {
          this.actorRoot.remove(rec.obj);
          disposeGroup(rec.obj);
        }
        rec.obj = buildVehicle(model, { t });
        rec.obj.position.copy(at);
        rec.obj.rotation.y = rec.yaw;
        this.actorRoot.add(rec.obj);
        rec.key = key;
      }

      // Where it is going, re-read every sync rather than only at creation.
      // Stashed as a target rather than applied, because the chase toward it
      // runs per frame — see `animateVehicles`.
      rec.x = v.x;
      rec.z = v.z;
      rec.tyaw = vehicleYaw(v.facing);
    }

    for (const [id, rec] of this.vehicleProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec.obj);
      disposeGroup(rec.obj);
      this.vehicleProps.delete(id);
    }
  }

  /**
   * Chase every vehicle toward where the server last put it.
   *
   * An exponential chase against `dt` rather than a fixed fraction per frame,
   * so a van crosses the yard at the same rate on a 144Hz screen as on a 30Hz
   * one — the fraction is whatever the frame length makes it. See
   * `VEHICLE_CHASE` for why this is per frame at all when people are not.
   *
   * The turn takes the short way round (`turnTo`), which is what stops a lorry
   * whose heading crosses π from unwinding the long way about — a full spin on
   * the spot at the one corner of the route, and only at that corner, which is
   * the kind of bug you see once and cannot reproduce because it depends on
   * which way the bay faces.
   */
  /**
   * Ease every body toward where the shop last said it was.
   *
   * One chase for players and shoppers alike: they are the same kind of thing
   * to the renderer, and a hire eased differently from a customer standing
   * beside them would read as one of them being laggy.
   *
   * A body with no target yet — added this frame, before any snapshot named it
   * — is left where it was put, which is already the right place.
   *
   * `snap` is the frame after a tab came back — see `AWAY_MS`. Everybody goes
   * straight to where the shop says they are, because there is no walk to draw:
   * they took it while nothing was on screen.
   */
  animateActors(dt, snap = false) {
    const move = snap ? 1 : 1 - Math.exp(-dt * ACTOR_CHASE);
    let slip = 0;
    for (const map of [this.players, this.customers, this.animals]) {
      for (const rec of map.values()) {
        if (rec?.tx === undefined) continue;
        const dx = (rec.tx - rec.obj.position.x) * move;
        const dz = (rec.tz - rec.obj.position.z) * move;
        rec.obj.position.x += dx;
        rec.obj.position.z += dz;
        // ...and whatever is standing on the floor under them comes along. Set
        // rather than eased again: it is already following an eased position,
        // and a second chase on top of it is a ring that lags its own feet.
        if (rec.foot) {
          rec.foot.position.x = rec.obj.position.x;
          rec.foot.position.z = rec.obj.position.z;
        }
        // The furthest anybody went, not the sum: a shadow map is one map, and
        // it is redrawn for the one body that outran it. Adding them up would
        // put a busy shop over the line with nobody having moved a pixel.
        slip = Math.max(slip, Math.abs(dx), Math.abs(dz));
      }
    }
    // Accumulated rather than compared, because the frames this is asked about
    // are the ones where the map was NOT redrawn — a body creeping a fifth of a
    // texel a frame is still a body a texel out of place five frames later.
    this.shadowSlip += slip;
  }

  animateVehicles(dt, snap = false) {
    if (!this.vehicleProps.size) return;
    const move = snap ? 1 : 1 - Math.exp(-dt * VEHICLE_CHASE);
    const turn = snap ? 1 : 1 - Math.exp(-dt * VEHICLE_TURN);
    let slip = 0;
    for (const rec of this.vehicleProps.values()) {
      const dx = (rec.x - rec.obj.position.x) * move;
      const dz = (rec.z - rec.obj.position.z) * move;
      rec.obj.position.x += dx;
      rec.obj.position.z += dz;
      rec.yaw += turnTo(rec.yaw, rec.tyaw) * turn;
      rec.obj.rotation.y = rec.yaw;
      slip = Math.max(slip, Math.abs(dx), Math.abs(dz));
    }
    // A lorry is the biggest shadow in the yard and moves twice as fast as
    // anybody on foot, so it wants the same rule for the same reason.
    this.shadowSlip += slip;
  }

  /**
   * What each head of an appliance is set to, with what that head is doing.
   *
   * Off the snapshot, which is the server's own answer — this used to guess,
   * because there was nothing to read: a machine ran whichever recipe its hopper
   * happened to satisfy, so the bays showed the one it was CLOSEST to making and
   * flipped to the other as you loaded it. A row of ingredients that changes
   * while you are fetching them is a machine arguing with you.
   *
   * The fallback to the first recipe on the FIRST head mirrors
   * `Game.stationRecipes` for the one tick a client can be ahead of the content
   * it is drawing — and, like there, a later head that is pointed at nothing is
   * idle rather than pointed at the first thing.
   */
  stationLines(st) {
    const mine = (this.catalog.recipes ?? []).filter((r) => r.station === st.station);
    const slots = st.lines ?? [{
      recipe: st.recipe ?? null, making: st.making ?? null, output: st.output ?? null, progress: st.progress ?? 0,
    }];
    return slots.map((slot, i) => ({
      ...slot,
      recipe: mine.find((r) => r.id === slot.recipe) ?? (i === 0 ? mine[0] : null) ?? null,
    }));
  }

  /**
   * What each appliance takes in and what it has put out, stood on the machine.
   *
   * A coffee machine with no milk looks exactly like one about to run, and the
   * only way to tell them apart was to enter build mode and read a text panel
   * that lists recipe *names* and not their ingredients. The first answer was a
   * row of sockets floating over the machine, and it was the wrong picture
   * twice: an ingredient and the thing being made were the same kind of icon in
   * the same place, and one icon meant one ingredient however many of it a
   * batch actually wanted. So the machine wears it instead, in the two places
   * that say which is which — in at the back, out at the front. See
   * `buildStationBays`.
   *
   * The three states are now three different pictures rather than one picture
   * and its absence. Idle: what it wants, ghosted where it is short. Running:
   * the ingredients are inside it, so the bays go and the *bar* comes up. Done:
   * the batch is standing on the outlet pad, which is a thing to walk over for
   * rather than a line in a panel nobody has open.
   */
  syncStations(stations) {
    const seen = new Set();

    for (const st of stations) {
      seen.add(st.id);
      const heads = this.stationLines(st);
      // The machine as a whole is running if ANY head is — which is what drives
      // its own moving parts and its hum, and is a different question from which
      // head is mid-batch.
      const making = Boolean(st.making);

      let rec = this.stationProps.get(st.id);
      // Kept and updated in place rather than replaced, because there are three
      // props on this record now and they change on different beats: the bays
      // when the hopper does, the working prop when the batch crosses a stage,
      // the bar ten times a second. Rebuilding the record for one drops the
      // other two.
      //
      // Each of the three is a LIST, one per head, for the reason the sim's
      // record is: a twin machine running two batches would otherwise tell you
      // about one of them, and which one would be whichever the loop wrote last.
      if (!rec) {
        rec = { keys: [], groups: [], work: [], workKeys: [], bars: [], making: false };
        this.stationProps.set(st.id, rec);
      }

      const bounds = this.stationBounds(st);
      const wells = this.stationWells(st);
      const baseY = this.fixtureBaseY({ kind: 'station' });
      const yaw = -(this.stationRot(st)) * (Math.PI / 2);

      heads.forEach((head, i) => {
        const busy = Boolean(head.making);
        // Nothing while that head runs: what it was short of went in when the
        // batch started, so a bay drawn now is a red pad on a machine doing its
        // job. The other head's bays stay up, because it is not running.
        const intakes = busy ? [] : (head.recipe?.inputs ?? []).map((x) => ({
          model: this.catalog.items[x.item_id]?.model ?? null,
          need: x.qty,
          held: st.contents?.[x.item_id] ?? 0,
        }));
        const outlet = head.output
          ? { model: this.catalog.items[head.output.item_id]?.model ?? null, qty: head.output.qty }
          : null;

        // Rebuilt only when what it says changes, but repositioned every sync —
        // an appliance you move in build mode has to take its readout with it.
        const key = [
          head.recipe?.id ?? 'idle',
          intakes.map((s) => `${Math.min(s.held, s.need)}/${s.need}`).join(','),
          outlet ? `${head.output.item_id}x${outlet.qty}` : '',
        ].join('|');

        if (rec.keys[i] !== key) {
          if (rec.groups[i]) {
            this.actorRoot.remove(rec.groups[i]);
            disposeGroup(rec.groups[i]);
          }
          rec.groups[i] = buildStationBays({
            intakes, outlet, bounds, wells, column: i, columns: heads.length,
          });
          this.actorRoot.add(rec.groups[i]);
          rec.keys[i] = key;
        }

        // Stood on the machine and turned with it, out of the layout rather than
        // the snapshot — which appliance is which is state, but which way round
        // it stands is the shop. Models are authored facing east, the same
        // convention `addFixtureProps` uses, or the outlet ends up round the back.
        rec.groups[i].position.set(st.x, baseY, st.z);
        rec.groups[i].rotation.y = yaw;

        // How far through the batch is, over the machine — the one reading a
        // still frame can take that the moving parts cannot give you, since
        // "spinning" says it is on and says nothing about how long is left. One
        // bar per RUNNING head, spread across the machine so two batches are two
        // readings rather than one bar drawn twice in the same place.
        if (busy && !rec.bars[i]) {
          rec.bars[i] = buildGrowthBar();
          this.actorRoot.add(rec.bars[i]);
        } else if (!busy && rec.bars[i]) {
          this.actorRoot.remove(rec.bars[i]);
          disposeGroup(rec.bars[i]);
          rec.bars[i] = null;
        }
        if (rec.bars[i]) {
          const lane = heads.length > 1 ? (i - (heads.length - 1) / 2) * 0.3 : 0;
          rec.bars[i].position.set(
            st.x + Math.sin(yaw) * lane,
            this.stationSlotY(st),
            st.z + Math.cos(yaw) * lane,
          );
          setGrowthBar(rec.bars[i], head.progress ?? 0);
        }

        this.syncStationWork(st, rec, head, i, heads.length);
      });

      // A machine that has stepped DOWN a rung has fewer heads than it had, and
      // the props for the ones it lost have to go with them — otherwise a bay
      // and a half-drawn bar hang over a machine that is not using them, which
      // reads as the demotion not having worked.
      this.dropStationHeads(rec, heads.length);

      // Read every sync and *animated* every frame — the machine's own moving
      // parts are driven off this, at 60fps, from a flag that arrives at 10.
      rec.making = making;
    }

    for (const [id, rec] of this.stationProps) {
      if (seen.has(id)) continue;
      this.dropStationHeads(rec, 0);
      this.stationProps.delete(id);
    }
  }

  /** Tear down every head's props from `keep` onward. */
  dropStationHeads(rec, keep) {
    for (const list of [rec.groups, rec.work, rec.bars]) {
      for (let i = keep; i < list.length; i++) {
        if (!list[i]) continue;
        this.actorRoot.remove(list[i]);
        disposeGroup(list[i]);
        list[i] = null;
      }
      list.length = Math.min(list.length, keep);
    }
    rec.keys.length = Math.min(rec.keys.length, keep);
    rec.workKeys.length = Math.min(rec.workKeys.length, keep);
  }

  /**
   * The placed record behind a station in the snapshot.
   *
   * Which appliance is which and what it is doing is state, and arrives every
   * tick. Which way round it stands and how far up its ladder it is belong to
   * the shop, and live in the layout — so anything about the machine rather
   * than about the batch comes from here.
   */
  placedStation(st) {
    return (this.storeLayout?.stations ?? []).find((s) => s.id === st.id) ?? null;
  }

  /** Which way round this appliance stands. Models are authored facing east. */
  stationRot(st) {
    return this.placedStation(st)?.rot ?? 0;
  }

  /**
   * What an appliance looks like while it is working, standing in its own model
   * space so a puff authored at the spout comes out of the spout.
   *
   * Only ever there while it is mid-batch. Rebuilt when the batch crosses a
   * stage and NOT before: `progress` moves every tick, and rebuilding a group of
   * meshes ten times a second would churn geometry for a picture that has not
   * changed — the same cache `syncCrops` keys off `stageIndexAt`.
   *
   * In `actorRoot` with the other readouts rather than parented to the machine,
   * for the reason the ingredient row is: the fixture belongs to `staticRoot`,
   * which a re-flow disposes wholesale, and build mode re-flows on every
   * placement. So it is positioned and turned every sync instead, which is also
   * what lets you pick a running machine up and carry it.
   *
   * **One per HEAD, each on its own head's clock.** One resolver takes one
   * number, and a twin machine has two: `model`'s 0..1 is spent on the tier and
   * `work`'s on how far through a batch it is, so two batches at different
   * progress do not get a third model — they get this one twice, each at its own
   * offset with its own `progress`.
   */
  syncStationWork(st, rec, head, i, columns) {
    const model = head.making ? this.stationWorkModel(st) : null;
    const t = model ? Math.min(1, Math.max(0, head.progress ?? 0)) : 0;
    const key = model ? `${st.station}:${stageIndexAt(model, t)}` : '';

    if (key !== rec.workKeys[i]) {
      if (rec.work[i]) {
        this.actorRoot.remove(rec.work[i]);
        disposeGroup(rec.work[i]);
        rec.work[i] = null;
      }
      if (model) {
        rec.work[i] = buildLoopingProp(partsAt(model, t), { castShadow: true });
        this.actorRoot.add(rec.work[i]);
      }
      rec.workKeys[i] = key;
    }

    if (!rec.work[i]) return;
    // Turned to face the way the machine faces — see `stationRot`, or the steam
    // comes out of the back — and stood in its own head's lane, so a twin does
    // not steam out of one spout twice.
    const yaw = -(this.stationRot(st)) * (Math.PI / 2);
    const lane = columns > 1 ? (i - (columns - 1) / 2) * 0.3 : 0;
    rec.work[i].position.set(
      st.x + Math.sin(yaw) * lane,
      this.fixtureBaseY({ kind: 'station' }),
      st.z + Math.cos(yaw) * lane,
    );
    rec.work[i].rotation.y = yaw;
  }

  /** The authored working look of this appliance, or null if nobody drew one. */
  stationWorkModel(st) {
    return variantWork(this.pieceOf({ kind: 'station' }), st?.station);
  }

  /**
   * Just clear of *this* appliance, so the bar never sits inside one — measured
   * per station now that a toaster and an espresso machine are different heights.
   *
   * `modelHeight` wants parts rather than a model; handing it the model iterates
   * an object and throws, which took out the whole sync loop after the first
   * station the first time round.
   */
  stationSlotY(st) {
    const model = this.fixtureModel({ kind: 'station', station: st?.station });
    return (model ? modelHeight(partsAt(model, 1)) : 1) + 0.42;
  }

  /**
   * The box *this* appliance occupies, for standing its bays on top of.
   *
   * At the tier it is actually built to, which is why it can't come off the
   * snapshot: `stations` carries what a machine is doing, and how far up its
   * ladder it is belongs to the shop. A Commercial machine is a taller box than
   * a Domestic one, and bays measured off the wrong one sink into the lid.
   */
  stationBounds(st) {
    return modelBounds(partsAt(this.fixtureModel(this.stationSpec(st)), this.fixtureT(this.stationSpec(st))));
  }

  /** This appliance, as the catalog knows it — which shape, and which rung. */
  stationSpec(st) {
    return { kind: 'station', station: st?.station, tier: this.placedStation(st)?.tier };
  }

  /**
   * The wells built into this appliance's art: every part it flagged `surface`.
   *
   * The same flag a shelf uses for a board, which is the point — "goods stand
   * here" is one idea and it should not grow a second spelling because the thing
   * underneath is a machine. An appliance that authors two of them has said
   * where its hopper is and where its tray is; one that authors none gets its
   * readout stood on its roof, the same fallback a boardless unit takes.
   */
  stationWells(st) {
    const spec = this.stationSpec(st);
    return surfacesAt(this.fixtureModel(spec), this.fixtureT(spec));
  }

  // -------------------------------------------------------------------------
  // Build mode
  // -------------------------------------------------------------------------

  /**
   * The pointer as a ray into the world, reused by everything that aims.
   *
   * One place that turns client coordinates into a ray, because the canvas is
   * not the window: it sits under a HUD and inside a `getBoundingClientRect`
   * that changes when the bar grows. Two copies of this arithmetic is two
   * chances for one of them to be off by the offset of the canvas.
   */
  pointerRay(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!this._ray) {
      this._ray = new THREE.Raycaster();
      // A raycaster ships enabled on layer 0 only, and the ground now sits on
      // `BAKED_LAYER` so the lamps cannot reach it twice. Pointing is not
      // lighting: everything drawn is something you can aim at.
      this._ray.layers.enableAll();
    }
    this._ndc ??= new THREE.Vector2();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    return this._ray;
  }

  /**
   * Which tile is under the pointer, on the flat plane `y` units up.
   *
   * A plane rather than geometry, so pointing at the floor *behind* a shelf
   * still gives you the floor and not the shelf's roof. That is the right
   * answer for a question about *ground* — where a wall goes, where a floor is
   * painted, where a fixture you are carrying lands. It is the wrong answer to
   * "which thing am I pointing at", which is why `pickFixture` stopped being
   * built out of this and raycasts the art instead.
   */
  pickTile(clientX, clientY, y = this.pickDeck === CEILING ? CEILING_Y : 0) {
    if (!this.storeLayout) return null;
    const ray = this.pointerRay(clientX, clientY);
    this._plane ??= new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit ??= new THREE.Vector3();

    this._plane.constant = -y;
    if (!ray.ray.intersectPlane(this._plane, this._hit)) return null;

    const x = Math.round(this._hit.x);
    const z = Math.round(this._hit.z);
    if (x < 0 || z < 0 || x >= this.storeLayout.w || z >= this.storeLayout.h) return null;
    return { x, z };
  }

  /**
   * Which *line between cells* the pointer is nearest — for drawing walls.
   *
   * A third question alongside `pickTile` ("which floor square") and
   * `pickFixture` ("which thing"), and it needs its own answer because a wall
   * has no square of its own. The ground hit lands somewhere inside a cell; the
   * fractional part says which of its four boundaries is closest, and whichever
   * of the two axes is nearer its own edge wins.
   *
   * Aimed at half a tile up rather than at the floor, because you point at the
   * middle of a wall you can see, not at the ground it stands on — picking at
   * y=0 makes every wall feel like it is one cell further away than it looks.
   *
   * `grip` is how near that line the pointer has to be, in tiles, and 0 is the
   * old behaviour: no limit, every point in the world is nearest to SOME line.
   * That is right for a wall tool — the pointer means "a line" for as long as
   * one is armed, and snapping is what lets you draw along a wall without
   * tracing it — and wrong for anything that has to tell a line apart from the
   * square it borders. Shift is the case that needs it (`razeAim`): most cells
   * in a shop have a wall on one side, so with no band a floor you had painted
   * beside one could never be the thing you were pointing at.
   */
  pickEdge(clientX, clientY, grip = 0) {
    if (!this.storeLayout) return null;
    const hit = this.pickTile(clientX, clientY, 0.55);
    if (!hit) return null;
    // pickTile rounds; re-read the raw intersection it left behind.
    const fx = this._hit.x;
    const fz = this._hit.z;
    const L = this.storeLayout;

    // Distance from the cell centre, in each axis, as a 0..0.5 figure.
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const dx = fx - cx;
    const dz = fz - cz;

    // How far the pointer is from the line it is about to be snapped to: the
    // nearer axis reaches 0.5 at the boundary, so the gap is what is left of it.
    if (grip > 0 && 0.5 - Math.max(Math.abs(dx), Math.abs(dz)) > grip) return null;

    let o;
    let x;
    let z;
    if (Math.abs(dx) > Math.abs(dz)) {
      // Nearer a west/east boundary: a vertical line.
      o = 'v';
      x = dx > 0 ? cx + 1 : cx;
      z = cz;
    } else {
      o = 'h';
      x = cx;
      z = dz > 0 ? cz + 1 : cz;
    }

    const maxX = o === 'v' ? L.w : L.w - 1;
    const maxZ = o === 'v' ? L.h - 1 : L.h;
    if (x < 0 || z < 0 || x > maxX || z > maxZ) return null;
    return { o, x, z };
  }

  /**
   * Which SIDE of a wall you are pointing at.
   *
   * `pickEdge` answers which line, which was the whole question while everything
   * you could do to a wall was done to the wall — build it, glaze it, sign it,
   * knock it through. Paint is the first thing that is done to one *face*, and
   * the answer is already sitting in the raw intersection `pickEdge` rounds off:
   * an edge at lattice x is drawn at world x-0.5, so which side of that the hit
   * landed on is a sign test and nothing more.
   *
   * It costs no extra pick. `pickEdge` leaves `_hit` where it found it, and the
   * plane it read is at wall height rather than on the floor, so pointing at the
   * top of a wall answers about that wall rather than about the ground behind it.
   */
  pickFace(clientX, clientY, grip = 0) {
    return this.pickFaceHit(clientX, clientY, grip)?.face ?? null;
  }

  /**
   * The same answer with how far away it was — and, crucially, with *null* for
   * the distance when the answer was a guess rather than a hit.
   *
   * `pickFixture`/`pickFixtureHit`'s split exactly, and it exists for the same
   * question: a wall squeezed between two units is only reachable if something
   * can weigh the wall against the thing beside it, and the honest weight is
   * which surface the ray met first (see `pickAim`, which already settles a
   * crate against a fixture this way).
   *
   * The fallback below has no distance and must not invent one. It is the
   * lattice guess — every point in the shop has a nearest line — so a distance
   * on it would let a wall you are not pointing at outrank a shelf you are.
   */
  pickFaceHit(clientX, clientY, grip = 0) {
    // The wall itself first, because a face is a thing you can SEE, and this is
    // the lesson `pickFixture` already learned about shelves: derive the answer
    // from a plane and you are answering about the ground somewhere behind what
    // you are pointing at. It is worse here than it was there. `pickEdge` reads
    // a plane at wall height and keeps whichever lattice line is nearest, which
    // is a fine answer to "where would a wall go" — every point in the shop has
    // a nearest line — and a poor one to "which wall is this", because the two
    // only agree within half a cell of the line. So painting meant aiming at the
    // middle of a wall in PLAN while looking at it in elevation, and the side it
    // picked flipped across a seam you could not see.
    //
    // Raycasting the edge meshes answers both halves exactly: the point is on
    // the surface you were looking at, so which line is a rounding and which
    // SIDE is the sign of a hair. No instance table — the geometry is
    // instanced, so `instanceId` would need one, and a point in space needs
    // nothing.
    const hit = this.edgeGroup
      ? this.pointerRay(clientX, clientY).intersectObject(this.edgeGroup, true)[0]
      : null;
    if (hit) {
      const p = hit.point;
      // Distance from the nearest line of each orientation. A wall is thin, so
      // the surface you hit is within a hair of its own line and miles from the
      // other one — which makes this a comparison rather than a threshold, and
      // therefore free of any number to tune.
      const vx = Math.round(p.x + 0.5);
      const hz = Math.round(p.z + 0.5);
      const dv = Math.abs(p.x - (vx - 0.5));
      const dh = Math.abs(p.z - (hz - 0.5));
      const face = dv <= dh
        ? { o: 'v', x: vx, z: Math.round(p.z), s: p.x < vx - 0.5 ? -1 : 1 }
        : { o: 'h', x: Math.round(p.x), z: hz, s: p.z < hz - 0.5 ? -1 : 1 };
      const L = this.storeLayout;
      const maxX = face.o === 'v' ? L.w : L.w - 1;
      const maxZ = face.o === 'v' ? L.h - 1 : L.h;
      if (face.x >= 0 && face.z >= 0 && face.x <= maxX && face.z <= maxZ) {
        return { face, dist: hit.distance };
      }
    }

    // Nothing under the pointer: fall back to the lattice. A gap in a wall is
    // still somewhere you can aim — the stroke drops the faces with no wall on
    // them (`faceRun`) — so a drag along a frontage with a doorway in it must
    // not stop dead at the doorway.
    //
    // `grip` rides through to the fallback and nowhere else, which is where the
    // whole of it belongs: the branch above hit an actual wall, so the pointer
    // is provably on one, and only the guess needs a band round it.
    const seg = this.pickEdge(clientX, clientY, grip);
    if (!seg) return null;
    const along = seg.o === 'v' ? this._hit.x : this._hit.z;
    const line = (seg.o === 'v' ? seg.x : seg.z) - 0.5;
    return { face: { ...seg, s: along < line ? -1 : 1 }, dist: null };
  }

  /**
   * The faces a paint stroke would cover.
   *
   * Its own ghost rather than a mode on `setEdgeGhost`, because it is answering
   * the question that ghost cannot: a bar down the middle of the line says WHICH
   * WALL, and the whole decision here is which of its two sides. So this is the
   * bar pushed out onto the face — thin, and standing where the finish will
   * stand, which makes the preview a picture of the result rather than a marker
   * beside it.
   */
  setFaceGhost(faces, state) {
    const key = faces?.length
      ? `${state}:${faces.map((f) => `${f.o}${f.x},${f.z},${f.s}`).join('|')}`
      : null;
    if (key === this.faceGhostKey) return;
    this.faceGhostKey = key;
    if (this.faceGhost) {
      this.actorRoot.remove(this.faceGhost);
      disposeGroup(this.faceGhost);
      this.faceGhost = null;
    }
    if (!faces?.length || !this.storeLayout) return;

    const colour = state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Off the wall's own thickness, so the ghost sits where the paint will —
    // proud of the same face, by the same hair. A constant here would drift the
    // day a wall changes thickness, and the drift is invisible: a ghost buried
    // inside the wall simply stops showing up.
    const t = EDGE_STYLE[E.WALL].t;
    for (const f of faces) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.55));
      const off = f.s * (t / 2 + 0.03);
      if (f.o === 'v') {
        mesh.position.set(f.x - 0.5 + off, 0.55, f.z);
        mesh.scale.set(0.05, 1.05, 0.96);
      } else {
        mesh.position.set(f.x, 0.55, f.z - 0.5 + off);
        mesh.scale.set(0.96, 1.05, 0.05);
      }
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.faceGhost = group;
  }

  /**
   * How tall this fixture is *drawn* — the plane its top face sits on.
   *
   * Read off the authored model when there is one, because the whole point of
   * aiming is that you click what you can see. A picker using a constant while
   * the art says otherwise is the neighbour-selecting bug all over again, just
   * arriving through content instead of code.
   */
  fixtureHeight(f) {
    const model = this.fixtureModel(f);
    // Its art on top of whatever it stands on, for everything — one rule where
    // there used to be a branch per kind. The base matters most for a hanging
    // prop: its art is drawn downward from the ceiling, so `modelHeight` alone
    // answers 0 and the picker would look for it on the floor, most of a tile
    // down-screen of where it is actually drawn. That is the neighbour-selecting
    // bug again with the camera pointing the other way.
    const own = model
      ? modelHeight(partsAt(model, this.fixtureT(f)))
      : (FIXTURE_LOOK[f.kind]?.h ?? 0);
    return this.fixtureBaseY(f) + own;
  }

  /**
   * Which fixture the pointer is actually over — the art, not a plane.
   *
   * Not the same question as `pickTile`, and it took two goes to answer. The
   * first was a ground-plane pick, which lands on the floor *behind* a shelf
   * because a 45° camera draws a three-quarter-tile box most of a tile
   * up-screen of the ground it stands on. The second aimed at the plane each
   * fixture's *top face* lives on, which fixes the neighbour bug and quietly
   * introduces a worse one: the region that answers is a full tile square
   * floating at roof height, so what you have to point at is not the thing —
   * it is a patch of air above and behind it, offset further the taller the
   * piece. Nothing on screen says where that patch is, so aiming becomes
   * hunting for a magic spot, and a lamp is nearly unhittable.
   *
   * So: raycast the meshes. The answer is then the same shape as the pixels,
   * whatever anybody authors — a corner unit's wing, a tall thin post, a
   * hanging sign — and it stays right the day a model changes, which neither
   * of the constants-and-planes versions could.
   *
   * Deliberately only the fixtures, not the whole scene. A shopper stood in
   * front of a shelf must not shield it (see docs/ui-shell.md), and the ground
   * would swallow every hit if it were in here.
   */
  pickFixture(clientX, clientY) {
    return this.pickFixtureHit(clientX, clientY)?.f ?? null;
  }

  /**
   * The same answer with how far away it was, for `pickAim` to weigh a fixture
   * against a crate. Every other caller wants the record and nothing else,
   * which is why `pickFixture` stays the plain one.
   *
   * `keep` is a caller's veto on which fixtures may answer — a decoration
   * outside build mode, today. It is applied *inside* the walk rather than to
   * the answer, and that is the whole reason it lives here: a hanging lamp is
   * the first thing the ray meets over the tile it hangs on, so vetoing the
   * result would make the shelf underneath it unpointable instead of making the
   * lamp transparent. Skipping the hit carries on down the ray, which is what
   * "you can see straight through it" has to mean.
   *
   * `board` comes back beside the fixture, and it is the *finer* half of the
   * same answer: which pile of goods on that unit the ray actually met. It is
   * there because a shelf holding three things is three piles at one address,
   * and until the pointer could say which, the only thing that could was the
   * unit's own menu. Null for every hit that is not stock — the frame of the
   * shelf itself, a crop, a machine — which is what leaves "the whole unit"
   * still pointable: aim at the thing, get the thing.
   */
  pickFixtureHit(clientX, clientY, keep = null) {
    if (!this.storeLayout) return null;
    const hits = this.pointerRay(clientX, clientY).intersectObjects(this.pickTargets(), true);
    // The first thing the ray met, held back rather than answered with, so a
    // pile of goods further down the same ray gets a chance at the question.
    // See the two branches below for when it wins and when this is given back.
    let front = null;
    for (const hit of hits) {
      // Up to whichever group was tagged as one pickable thing — the hit
      // itself is one board of a shelf or one apple on it.
      let o = hit.object;
      let board = null;
      while (o && !o.userData.pick) {
        // ...noting which pile it was on the way past, since the group that
        // says so sits between the mesh and the group that says "one thing".
        if (o.userData.item) board = o.userData.item;
        o = o.parent;
      }
      if (!o) continue;
      // The thing the ray HIT, whenever the group can say which it is — and it
      // has to be asked before the tile, because a tile stopped being one
      // fixture the day a decoration stopped stamping one. Point at a lamp
      // hanging over a shelf and the tile answers "shelf", which is how the
      // pointer ends up naming the thing *underneath* whatever you aimed at.
      //
      // The tile is still the fallback, and it is the right one: the groups
      // with no id on them are a shelf's stock and a bed's crop, which belong
      // to the fixture they stand on, and that fixture is the one thing a tile
      // does still answer for.
      const f = (o.userData.fixture ? this.fixtureById(o.userData.fixture) : null)
        ?? this.fixtureAt(Math.round(o.position.x), Math.round(o.position.z));
      if (!f || (keep && !keep(f))) continue;
      /**
       * ...and it has to be on the storey you are working on.
       *
       * A duct hangs over a shelf, so one ray meets both and the tie was going
       * to whichever the camera happened to put in front — which is a bulldozer
       * that eats the shelf while you are aiming at the run above it, and a run
       * you cannot delete at all. Neither reads as a picking rule: it reads as
       * Ctrl being broken.
       *
       * Asked HERE rather than in each caller, because the hover, the press,
       * the menu, the pipette and the bulldozer all come through this one
       * function — and a highlight that lit under a different rule than the
       * press is the green-ghost bug with a storey on it.
       *
       * Off the ceiling, an overhead cell is not pointable at all. That is the
       * same sentence pointed the other way: the shop floor is what you work on
       * out of build mode, and a duct that swallowed clicks meant for the shelf
       * underneath it would make an aisle unusable the day you roofed it.
       */
      if (deckOf(f) !== (this.pickDeck === CEILING ? CEILING : 0)) continue;
      const answer = { f, dist: hit.distance, board };
      // Nothing in front of it: the plain old answer, and the one every stocked
      // shelf in the game still gets. Only a pile that is BEHIND something has
      // anything to decide, so the first hit is held and the ray carries on.
      if (!front) {
        front = { ...answer, transparent: !!hit.object.material?.transparent };
        continue;
      }
      // A pile the unit's own art is standing in front of.
      //
      // The unit is still what you are pointing at everywhere its stock is not —
      // a tap on the frame, the base or an end panel has to go on opening the
      // menu, or pricing and assignment stop being one press away. So reaching
      // through is not a general rule about fixtures; it is ONE case:
      //
      // - **glass**, which is drawn so you can see through it (`material`,
      //   `depthWrite: false`) and would otherwise be the one part of a unit
      //   that shows you goods and refuses to name them.
      //
      // It used to be two, and the second was the opposite of this one: a pile
      // *sealed in* — a wall unit is a box with a lid, and on a fixed camera two
      // of its four rotations put the back of that box to you — was reached
      // through as well, on the argument that the cage draws with
      // `depthTest: false` so you could at least see what you had named.
      //
      // What that is, said plainly, is naming goods through an opaque box, and
      // it is the one thing the pointer is not allowed to do anywhere else in
      // the game. The rule now is the one you can state in a sentence: **you can
      // point at a pile you can see.** Glass you can see through; a lid you
      // cannot. A sealed unit answers as the whole unit, which opens its menu —
      // the older path, still one press, and the one that can show you a board
      // no camera angle reaches.
      //
      // `!front.board` because a pile in the open is already the answer: without
      // it, a unit holding one visible kind and one behind glass would hand you
      // the far one for every pixel of the pile you can actually see.
      // By id, never by identity: `allFixtures` rebuilds its records on every
      // call (`fixturesIn` spreads them), so the same fixture met twice down one
      // ray is two objects and `===` is false for every unit in the shop. It
      // fails silently as "the reach-through never fires", which is exactly the
      // bug it was written to fix.
      if (board && !front.board && front.f.id === f.id && front.transparent) {
        // At the FRONT's distance. That is where this fixture really starts, and
        // `pickAim` weighs the number against a crate standing in front of it.
        return { ...answer, dist: front.dist };
      }
      // Anything else — a different fixture, a second panel of this one — means
      // the ray has finished with whatever was in front, and that is the answer.
      if (front.f.id !== f.id) return front;
    }
    const got = front ?? this.pickPropBox(clientX, clientY, keep);
    // Near enough a pile IS on it.
    //
    // Everything above answers off the art, which is right and is also why
    // aiming at goods was fiddly: a board's worth of stock is a handful of
    // little boxes a dozen pixels tall, and between them and around them is
    // the unit's own shelf, which the ray hits instead. So you had to be
    // exactly on a loaf, and being one pixel off did not miss — it silently
    // answered "the whole unit", which is a different job.
    //
    // A RADIUS rather than a bigger hit volume, and the two things it is holding
    // apart are both real. The thing that has to keep working is the OTHER
    // answer: a tap on the frame, the base or an end panel is still the unit and
    // still opens its menu (see `boardTakes`), so padding the piles until they
    // touch leaves nowhere on a stocked shelf to press for it.
    //
    // Unbounded was tried and is worse than either. A shelf run is several tiles
    // long, so "the nearest pile on this fixture" with no ceiling answers with a
    // pile at the far end of the unit — you point at the empty bottom board and
    // a cage lights up three tiles away, which is not a forgiving hitbox, it is
    // the pointer naming something you cannot see yourself pointing at.
    //
    // Measured in pixels for the same reason it is measured at all: what is hard
    // here is a distance on the SCREEN, and a distance in the world is a
    // different number at every zoom.
    //
    // ...and the snap has to honour the see-it rule above, which is the half
    // that is easy to miss and does all the work. Dropping the sealed
    // reach-through on its own changes NOTHING on screen: a lidded unit stops
    // answering with a board up there, falls through to here with no board, and
    // this pads its way to exactly the same pile — screen-space distance knows
    // nothing about what is in front of what. Two routes to one wrong answer, so
    // both have to be shut or neither is.
    if (got?.f && !got.board) {
      const near = this.nearestBoard(got.f, clientX, clientY);
      // Asked of the WINNER rather than inside the loop: `sealedPile` fires
      // eight rays, and this is a hover path. One pile's worth is what the old
      // reach-through already cost every frame, so this is the same budget
      // pointed at the opposite question.
      if (near && !this.sealedPile(got.f, near)) return { ...got, board: near };
    }
    return got;
  }

  /**
   * Which pile on this unit the pointer is nearest, if it is near one at all.
   *
   * Distance to the pile's projected BOX rather than to its middle: a board of
   * twelve loaves is wide and a board of one is a dot, and measuring to centres
   * would make the wide one harder to hit the more of it there is — which is
   * exactly backwards.
   *
   * Boxes measured off the meshes, the same way `boardBox` measures the cage
   * that gets drawn round the answer. One function would be nicer and they want
   * different things: that one wants a world box to build a cage from, and this
   * wants every pile's screen rect at once.
   */
  nearestBoard(f, clientX, clientY, within = BOARD_SNAP_PX) {
    const rec = this.shelfProps.get(f.id);
    if (!rec?.group?.children?.length) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    rec.group.updateMatrixWorld(true);
    let best = null;
    let bestAt = within;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const pile of rec.group.children) {
      if (!pile.userData.item) continue;
      box.setFromObject(pile);
      if (box.isEmpty()) continue;
      // The eight corners, projected. A box in the world is not a box on the
      // screen at this camera — it is a hexagon — so its screen rect is the
      // bounds of the corners rather than of two of them.
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(this.camera);
        const sx = (v.x + 1) / 2 * rect.width;
        const sy = (1 - v.y) / 2 * rect.height;
        if (sx < x0) x0 = sx;
        if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy;
        if (sy > y1) y1 = sy;
      }
      const dx = Math.max(x0 - px, 0, px - x1);
      const dy = Math.max(y0 - py, 0, py - y1);
      const d = Math.hypot(dx, dy);
      if (d < bestAt) { bestAt = d; best = pile.userData.item; }
    }
    return best;
  }

  /**
   * Is this pile of goods walled in by the unit it is standing in?
   *
   * Rays from all over the pile, back along the way the camera looks. If the
   * unit's own art stops every one of them, nothing the pointer can do reaches
   * that pile the ordinary way, and `pickFixtureHit` may reach through the body.
   *
   * All over it rather than from the middle, and that is the whole difference
   * between this and a rule that quietly eats the fixture menu. A shelf's back
   * panel stands right behind its stock, so the centre of a pile on a
   * turned-away shelf is blocked exactly as a freezer's is — measured from the
   * middle alone, half the shelving in the shop read as sealed and a press on
   * the frame started handing back a board. What a shelf has and a freezer has
   * not is a way OUT: no lid, so the top of the pile clears the panel. One
   * escaping sample is enough, which is the same "best of several points" call
   * `shownOn` makes, and for the same reason.
   *
   * Measured off the meshes and off the camera rather than authored on the
   * piece, for the reason the caller gives: sealed-ness is about which way the
   * thing is turned. It also means a model nobody has drawn yet gets the right
   * answer on the day it is drawn — the same bet `boardBox` and `pickFixtureHit`
   * already make by raycasting the art instead of reasoning about it.
   *
   * Glass does not seal, exactly as it does not cover in `shownOn`. If it did,
   * every glazed unit would take the reach-through path and the pane branch
   * above would be dead code that looked alive.
   *
   * Cached per pile, because a hover asks this on every pointer move and the
   * answer only changes when the unit moves, turns or is restocked — which is
   * what `rec.key` and the placement already spell out between them.
   */
  sealedPile(f, itemId) {
    const rec = this.shelfProps.get(f.id);
    if (!rec) return false;
    const memo = (rec.sealed ??= new Map());
    const key = `${itemId}:${rec.key}:${f.rot ?? 0}:${f.x}:${f.z}`;
    if (memo.has(key)) return memo.get(key);
    if (memo.size > 16) memo.clear();

    let out = false;
    const box = this.boardBox(f, itemId);
    const body = this.staticRoot.children.find((o) => o.userData.fixture === f.id);
    if (box && body) {
      // Towards the viewer, which for this camera is one fixed direction — the
      // scene is orthographic, so every point of the pile looks the same way and
      // the samples differ only in where they start.
      const back = this.camera.getWorldDirection(SEAL_DIR).negate();
      // Pulled in off the faces, or a sample sitting exactly on the top of the
      // pile answers about the air beside it rather than about the goods.
      const lo = box.min, hi = box.max;
      const at = (t) => SEAL_FROM.set(
        lo.x + (hi.x - lo.x) * t[0],
        lo.y + (hi.y - lo.y) * t[1],
        lo.z + (hi.z - lo.z) * t[2],
      );
      // The unit's own art first, because it is one small group and it is what
      // stops nearly every sample. Only a sample that gets OUT costs the wider
      // question — which is the expensive one, and the one that has to be asked:
      // a run of freezers stands shoulder to shoulder, so the sample that clears
      // your own lid is the sample that walks straight into the unit next door.
      // Own-body-only left two units in a row of ten unreachable, on one escaping
      // corner each, which reads as the fix having half worked.
      const others = this.pickTargets().filter((g) => g !== rec.group);
      out = SEAL_SAMPLES.every((t) => {
        SEAL_RAY.set(at(t), back);
        const stopped = (hits) => hits.some((h) => !h.object.material?.transparent);
        return stopped(SEAL_RAY.intersectObject(body, true))
          || stopped(SEAL_RAY.intersectObjects(others, true));
      });
    }
    memo.set(key, out);
    return out;
  }

  /**
   * ...and a decoration answers to the box its art is drawn in, not to the art.
   *
   * Raycasting the meshes is the right answer for everything that is *shaped*
   * like a target. A string of lights is a wire: a couple of pixels of black
   * across the shop, and hitting it is hunting for a magic spot — which is the
   * bug the plane-picking version had, arriving from the other end. Miss by two
   * pixels and nothing is under the pointer, so the tap falls through to the
   * ground and BUYS ANOTHER ONE, which is a near-miss with a price on it.
   *
   * So a prop's target is its own bounds. Bigger than the wire, exactly as big
   * as what is drawn, and it can never steal from anything else: this runs only
   * after every mesh in the shop has already failed to answer, so an exact hit
   * on a shelf standing in the same airspace still wins.
   *
   * What it costs is that the ground *behind* a hanging prop takes a tap where
   * the box covers it on screen — the same tile the lamp is drawn over. That is
   * the same trade the art-exact version made and lost: those pixels are the
   * lamp, and there is no third answer for a pixel that is both.
   */
  pickPropBox(clientX, clientY, keep = null) {
    if (!this.propBoxes.size) return null;
    const ray = this.pointerRay(clientX, clientY).ray;
    let best = null;
    for (const [id, box] of this.propBoxes) {
      if (!ray.intersectBox(box, BOX_HIT)) continue;
      const dist = ray.origin.distanceTo(BOX_HIT);
      if (best && dist >= best.dist) continue;
      const f = this.fixtureById(id);
      if (f && (!keep || keep(f))) best = { f, dist };
    }
    return best;
  }

  /**
   * Which crate the pointer is over, if any.
   *
   * Its own method rather than a branch in `pickFixture`, because a pallet is
   * not a fixture and every caller of that one would have to learn it: the
   * build ghost, the bulldozer and "walk to the side you work it from" all
   * take a layout record, and none of them has an answer for a crate.
   *
   * It answers *which* crate of a stack, and that answer is the whole of how a
   * pile is worked now: a crate is `CRATE_STEP` tall, so at the default zoom a
   * buried one is a band of about a dozen pixels, and `y` is what lets the ring
   * say which of them the ray met. A pile once had a list on the tap to name its
   * crates for you; the aim plus the ring says it without reading anything out,
   * and what a pile takes away is not which box you may have but the tin-at-a-
   * time access — see `crateStacked`, server side.
   *
   * `dist` comes back for the same reason: a crate and a fixture are two
   * separate rays, so which of them wins can no longer be decided by which
   * method is called first. See `pickAim`.
   */
  pickPallet(clientX, clientY) {
    const crates = [...this.deliveryProps.values()];
    if (!crates.length) return null;
    const hits = this.pointerRay(clientX, clientY).intersectObjects(crates, true);
    for (const hit of hits) {
      // Labels are not the thing they name. A sprite ignores depth and is drawn
      // over whatever is in front of it, so letting one answer would hand you a
      // buried crate when you pointed at the one standing on it. The ray carries
      // on to the box behind the number, which is that crate anyway.
      if (hit.object.isSprite) continue;
      let o = hit.object;
      while (o && !o.userData.delivery) o = o.parent;
      if (o) {
        return {
          id: o.userData.delivery,
          x: Math.round(o.position.x),
          z: Math.round(o.position.z),
          y: o.position.y,
          dist: hit.distance,
        };
      }
    }
    return null;
  }

  /**
   * What the pointer is over on the shop floor — a crate or a fixture.
   *
   * Whichever is genuinely in FRONT, by ray distance, rather than whichever
   * picker is called first. Order was fine while the two could not overlap, and
   * a hanging lamp is exactly the case where they do: its art is drawn down from
   * the ceiling, most of a tile up-screen of the tile it belongs to, which is
   * the same patch of screen a crate stacked on that tile occupies. Ordered, one
   * of them silently owned the pointer for pixels the other was drawn on — so
   * the ring named the lamp while the tap took the crate, and a shop floor where
   * the highlight and the click disagree is worse than one with no highlight.
   *
   * At most one comes back set. Only the fixture goes to `ui.setAim`, because
   * that names what a BUILD verb would act on and there is no build verb that
   * takes a crate.
   */
  pickAim(clientX, clientY, keep = null, crates = true) {
    // `crates` is the caller's veto, and it is a veto rather than a filter on
    // the answer for `keep`'s reason turned round: a crate the pointer may not
    // name must not shadow the FIXTURE behind it either. A box standing on a
    // belt is exactly that case — in build mode the belt is the thing you are
    // pointing at, and a crate riding it is scenery.
    const crate = crates ? this.pickPallet(clientX, clientY) : null;
    const hit = this.pickFixtureHit(clientX, clientY, keep);
    if (crate && (!hit || crate.dist <= hit.dist)) {
      return { crate, fixture: null, board: null, dist: crate.dist };
    }
    // The board rides along with the fixture and never on its own: it is the
    // same target said more precisely, so anything that only knows about units
    // can go on reading `fixture` and ignore it.
    // `dist` rides along for the caller that has a THIRD thing to weigh, which
    // is the wall behind whatever this answered — see `wallInFront` in
    // client/main.js. Null when nothing was hit at all, so a caller comparing
    // against it is comparing against "there is nothing here".
    return {
      crate: null, fixture: hit?.f ?? null, board: hit?.board ?? null, dist: hit?.dist ?? null,
    };
  }

  /**
   * The groups `pickFixture` is allowed to hit.
   *
   * The stock and the crops are in here alongside the fixtures themselves,
   * because they are what you can see: a full shelf is mostly goods from this
   * angle, and a ripe plot is entirely plant. Pointing at a tomato and being
   * told there is nothing there would be the same class of bug this method
   * exists to end.
   */
  pickTargets() {
    const out = [];
    for (const o of this.staticRoot.children) if (o.userData.pick) out.push(o);
    for (const rec of this.shelfProps.values()) out.push(rec.group);
    for (const rec of this.plotProps.values()) out.push(rec.group);
    return out;
  }

  /**
   * Every fixture DRAWN inside a screen rectangle — the marquee's answer.
   *
   * A rectangle cannot be a ray, so this is the one pick in the game that is not
   * `pickFixtureHit`, and the difference is worth stating: a ray asks "what is
   * under this pixel" and answers with the nearest, while a box asks "what is
   * in here" and has to answer with all of them, including things standing
   * behind other things. That is right for a marquee — you drew a box round an
   * aisle, not round its front row.
   *
   * Against the ART and never the tile, which is the same distinction
   * `pickFixture` exists for: at this camera a shelf is drawn most of a tile
   * up-screen of the ground it stands on, so a box tested against tile centres
   * would take in the row behind the one you dragged over and miss the one you
   * did. The projected box is the eight corners rather than two, because a box
   * in the world is a hexagon on the screen — the same measurement
   * `nearestBoard` takes, for the same reason.
   *
   * INTERSECTS rather than contains. A box round part of an aisle is how anybody
   * drags, and demanding that a whole shelf fit inside it would mean the ones at
   * the edges of your drag silently did not come — which reads as the marquee
   * missing things rather than as a rule.
   *
   * `staticRoot` alone and deliberately NOT `pickTargets`, which also hands back
   * a shelf's stock and a bed's crop: those live in `actorRoot`, move with what
   * they stand on, and have no id of their own. Fine for a ray that has already
   * hit one; here it would let a loaf of bread on the front row drag its whole
   * unit in from outside the box.
   *
   * Resolved id-first and tile-second, which is `pickFixtureHit`'s own line and
   * carries its reason: only a PROP stamps `userData.fixture`, because a
   * decoration owns no tile and `fixtureAt` can only ever answer the thing
   * underneath it.
   */
  fixturesInRect(x0, y0, x1, y1) {
    if (!this.storeLayout) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    const lo = { x: Math.min(x0, x1) - rect.left, y: Math.min(y0, y1) - rect.top };
    const hi = { x: Math.max(x0, x1) - rect.left, y: Math.max(y0, y1) - rect.top };
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const seen = new Set();
    const out = [];
    for (const o of this.staticRoot.children) {
      if (!o.userData.pick) continue;
      o.updateMatrixWorld(true);
      box.setFromObject(o);
      if (box.isEmpty()) continue;
      let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
      for (let i = 0; i < 8; i += 1) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z);
        v.project(this.camera);
        const sx = (v.x + 1) / 2 * rect.width;
        const sy = (1 - v.y) / 2 * rect.height;
        if (sx < bx0) bx0 = sx;
        if (sx > bx1) bx1 = sx;
        if (sy < by0) by0 = sy;
        if (sy > by1) by1 = sy;
      }
      if (bx1 < lo.x || bx0 > hi.x || by1 < lo.y || by0 > hi.y) continue;
      const f = (o.userData.fixture ? this.fixtureById(o.userData.fixture) : null)
        ?? this.fixtureAt(Math.round(o.position.x), Math.round(o.position.z));
      // By id, never by identity: `allFixtures` rebuilds its records on every
      // call, so one fixture met twice is two objects and `===` is false for
      // every unit in the shop — the trap `pickFixtureHit`'s reach-through
      // already names.
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out;
  }

  /**
   * Every fixture in the layout as a uniform record — the same shape the server
   * works over in build mode, so the two agree about what a fixture is.
   */
  allFixtures() {
    return fixturesIn(this.storeLayout);
  }

  /**
   * What's on this tile, if anything.
   *
   * This used to be the whole answer to "which shelf did you mean", on the
   * grounds that a tile holds one fixture and the pointer names a tile. That
   * was true until a decoration stopped stamping a tile: a lamp shares the
   * cell it hangs over, so `props` come last in `fixturesIn` and `find` can
   * never reach one that is sharing. Still the right answer for a *tile* —
   * placing, walking, the ghost — and no longer the right answer for "what am
   * I pointing at", which is `pickFixtureHit`'s job and goes by id.
   */
  fixtureAt(x, z) {
    return this.allFixtures().find((f) => covers(f, x, z)) ?? null;
  }

  /** ...and by id, for a pointer that has already hit the thing itself. */
  fixtureById(id) {
    return this.allFixtures().find((f) => f.id === id) ?? null;
  }

  /**
   * Ring the fixture the pointer is over in build mode.
   *
   * Kept separate from `syncActionTarget`'s marker on purpose: that one is
   * driven by the server's armed action and gets torn down every snapshot,
   * which would take this with it ten times a second.
   */
  setAimTarget(f, mode = 'aim', board = null) {
    // The mode is part of the key: pointing at the same shelf with the bulldozer
    // up is a different marker, and comparing ids alone would leave an amber
    // ring on the thing the next tap deletes.
    //
    // So is the height, which is a crate's doing. A ring on the ground under a
    // tower says "one of these three" — the whole reason to ring a crate is to
    // say WHICH — and moving the pointer up the stack changes nothing else
    // about the target but where it is.
    //
    // ...and so is the board, plus the shelf's own art key. A cage is drawn to
    // the size of the pile it is round, so a sale that redraws that pile has to
    // redraw the cage with it — keyed on the item alone, the box would stay the
    // size the stack was when you first pointed at it, which is a highlight
    // that stops agreeing with what you can see while you watch it.
    const art = board ? this.shelfProps.get(f?.id)?.key ?? '' : '';
    const key = f ? `${f.id}:${mode}:${f.y ?? 0}:${board ?? ''}:${art}` : null;
    if (this.aimKey === key) return;
    this.aimKey = key;
    if (this.aimMarker) {
      this.actorRoot.remove(this.aimMarker);
      disposeGroup(this.aimMarker);
      this.aimMarker = null;
    }
    if (!f) return;
    this.aimMarker = this.markerFor(f, mode, board);
    this.actorRoot.add(this.aimMarker);
  }

  /**
   * THE PILE YOU PRESSED, marked for as long as it stays pressed.
   *
   * Its own channel rather than a mode on `setAimTarget`, and the argument is
   * `setSelectedTarget`'s word for word: the aim cage is wherever the pointer
   * happens to be, and this stays on the pile you are working out of even while
   * you point somewhere else entirely. Folding them together loses the answer
   * exactly when you move the pointer off — which, for a board, is most of the
   * time, since the thing you do with one picked is walk the aisle with it.
   *
   * That was the whole of what a pick was missing. It is a decision with no
   * deadline (`pick`, client/main.js), it survives the walk, it is what the
   * second loaf and the third come off, and it is what the pill's rows are
   * about — and until now the only moment it was visible was when the pointer
   * was over nothing at all, borrowing the aim's amber. So taking a loaf named
   * a pile and then showed you nothing, which reads as the press not having
   * stuck.
   *
   * Keyed like the aim, including the shelf's art, because the pile it is drawn
   * round shrinks every time you take from it — which is precisely what you are
   * doing while this is up.
   */
  setPickedBoard(f, board = null) {
    const art = board ? this.shelfProps.get(f?.id)?.key ?? '' : '';
    const key = f && board ? `${f.id}:${board}:${art}` : null;
    if (this.pickedKey === key) return;
    this.pickedKey = key;
    if (this.pickedMarker) {
      this.actorRoot.remove(this.pickedMarker);
      disposeGroup(this.pickedMarker);
      this.pickedMarker = null;
    }
    if (!key) return;
    this.pickedMarker = this.markerFor(f, 'picked', board);
    this.actorRoot.add(this.pickedMarker);
  }

  /**
   * A frame on the tile, or a cage round the thing.
   *
   * Which one is not a style choice, it is what the fixture *is*: everything
   * that owns a cell is marked as a cell, because that is what you point at one
   * for — you walk to the side of a shelf, and the frame is where you would be
   * standing. A decoration owns no cell, so a frame under one marks the floor
   * beside it and leaves the thing itself unchanged. Worse for a hanging prop,
   * which is drawn most of a tile up-screen of its own cell: the marker appears
   * somewhere you are demonstrably not pointing.
   *
   * Sized from `propBoxes`, which is the same volume the pointer is tested
   * against — so the highlight is a picture of the hitbox rather than a second
   * guess at it, and "it lit up but the tap missed" cannot happen.
   *
   * A board takes the cage for a third reason, and it is the one that makes
   * board-level aiming legible at all: a frame on the tile would be the same
   * frame for every pile on the unit, so pointing at the bread and pointing at
   * the milk beside it would look identical. The thing you have to be able to
   * tell apart is *which pile*, so the marker has to be round the pile.
   */
  markerFor(f, mode, board = null) {
    const box = board
      ? this.boardBox(f, board)
      : (isProp(f.kind) ? this.propBoxes.get(f.id) : null);
    if (!box) {
      const m = buildTargetMarker(mode);
      // `fixtureBaseY` and not 0, which is the same correction the art itself
      // got. A frame on the tile is right about everything that owns a cell —
      // you point at a shelf to walk to the side of it — and the storey is not
      // part of what that frame is saying, so an overhead cell drew its mark
      // on the floor four metres below the thing under the pointer. What that
      // reads as is the pointer having selected the aisle instead of the duct,
      // which is exactly what it looks like it did.
      m.position.set(f.x, f.y ?? this.fixtureBaseY(f), f.z);
      return m;
    }
    const size = box.getSize(new THREE.Vector3());
    // A board look rather than the mode it was asked with, and the only
    // difference is the chevron: a board is one of several on the same unit, and
    // an arrow floating a tile and a half over the shelf points at the shelf —
    // which is the one thing this marker exists NOT to say. The cage is the
    // whole answer. Which board look is the mode again, because a pile can be
    // the thing you are pointing at and the thing you picked, and those are two
    // different sentences — see `MARKER_LOOK.boardPicked`.
    const m = buildCageMarker(BOARD_LOOK[mode] ?? 'board', size);
    box.getCenter(m.position);
    return m;
  }

  /**
   * The box one pile of goods on a unit occupies, in world space.
   *
   * Measured off the meshes rather than worked out from the boards, for the same
   * reason `pickFixtureHit` raycasts the art: the pile is what you can see and
   * what the ray hit, and a second calculation of where it sits is a second
   * chance to disagree with the picture — which here would present as a
   * highlight that is next to the thing it is highlighting.
   *
   * On demand rather than cached beside the group, because the answer depends on
   * where the shelf is standing *now*: `syncShelves` re-reads that every sync so
   * a unit you pick up takes its stock with it, and a box stamped when the
   * geometry was built would be left behind at the old tile. Only ever asked
   * when the marker is (re)built, which is a pointer moving onto a new pile.
   */
  boardBox(f, itemId) {
    const rec = this.shelfProps.get(f.id);
    if (!rec) return null;
    const pile = rec.group.children.find((c) => c.userData.item === itemId);
    if (!pile) return null;
    rec.group.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(pile);
  }

  /**
   * Ring the PERSON the pointer is over.
   *
   * Its own marker rather than a mode on `setAimTarget`, for one reason that
   * decides the whole shape: everything that one rings stands still. A shelf is
   * placed at a tile and the marker is placed at the same tile once. A hire
   * walks, so this holds an id and is re-positioned every frame off the mesh's
   * own interpolated position — the marker would otherwise sit where they were
   * standing when you hovered them, which is worse than no marker, because it
   * says the tap will land somewhere it will not.
   *
   * Takes a roster id rather than a body for the reason `watch` does: bodies
   * are re-sent whole ten times a second.
   */
  setPersonAim(hire) {
    const id = hire ?? null;
    if (this.personAimId === id) return;
    this.personAimId = id;
    if (this.personMarker) {
      this.actorRoot.remove(this.personMarker);
      disposeGroup(this.personMarker);
      this.personMarker = null;
    }
    if (!id) return;
    this.personMarker = buildTargetMarker('person');
    this.actorRoot.add(this.personMarker);
  }

  /**
   * ...and ring the one whose MENU is open, which is a different question.
   *
   * The same split `setSelectedTarget` makes against the aim frame, said about
   * a person: the aim ring is wherever the pointer happens to be, and this
   * stays on whoever the panel is talking about while you point somewhere else
   * entirely — which is all of the time the menu is open, since reading it
   * means taking the pointer off them. And a hire is the case where that
   * matters most, because they walk away while you read.
   *
   * A second marker rather than a second mode on `setPersonAim` for the same
   * reason, and both can be live at once: pointing at the hire you already have
   * open puts the amber frame inside the teal one, which is two true sentences.
   */
  setPersonSelected(hire) {
    const id = hire ?? null;
    if (this.personSelId === id) return;
    this.personSelId = id;
    if (this.personSelMarker) {
      this.actorRoot.remove(this.personSelMarker);
      disposeGroup(this.personSelMarker);
      this.personSelMarker = null;
    }
    if (!id) return;
    this.personSelMarker = buildTargetMarker('personSelected');
    this.actorRoot.add(this.personSelMarker);
  }

  /** The body of a hire, by roster id — what the marker above rides on. */
  bodyOfHire(hire) {
    const p = (this.playerState ?? []).find((x) => x.hire === hire);
    return p ? this.players.get(p.id) ?? null : null;
  }

  /**
   * Ring the fixture whose menu is open, and keep it ringed.
   *
   * A third marker rather than a mode on the aim ring, because the two answer
   * different questions and are both live at once: the aim ring is wherever
   * the pointer happens to be, and this stays on the thing the panel is
   * talking about even while you point somewhere else entirely. Folding them
   * together loses the answer exactly when you move the pointer off to read
   * the menu — which is the whole of the time the menu is open.
   *
   * Positioned by the record it is handed, so following a fixture through a
   * re-flow is `showFixture`'s existing tile lookup rather than a second one
   * in here.
   */
  setSelectedTarget(f, spots = null) {
    // Handed in rather than worked out here, because *how many* sides a unit has
    // depends on its catalog row (`open`) and on the shop around it (an end
    // inside a wall is not an end) — and the renderer holds neither question.
    // `UI.spotsFor` is the one answer, so what lights up and what the sim will
    // accept you at cannot drift apart. Null is the old behaviour: the anchor,
    // and a till's other side.
    const at = spots ?? spotsOf(f);
    // `rot` is in the key, and it has to be: the menu is where the Rotate
    // button lives, so the one thing you do to a selected fixture is the one
    // thing that moves no tile. Keyed on position alone, turning a till redrew
    // nothing and its working spots stayed pointing the old way — a preview
    // that lies specifically while you are watching it.
    //
    // ...and so are the spots, for the same reason one step further out: a wall
    // drawn beside a shelf takes an end away without moving the shelf, and a key
    // blind to that would leave a marker on a tile nobody can stand in.
    const key = f ? `${f.x},${f.z},${f.rot ?? 0}|${at.map((s) => `${s.x},${s.z}`).join(';')}` : null;
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    if (this.selectedMarker) {
      this.actorRoot.remove(this.selectedMarker);
      disposeGroup(this.selectedMarker);
      this.selectedMarker = null;
    }
    if (!f) return;
    this.selectedMarker = this.markerFor(f, 'selected');
    // A cage is positioned on the art and not on the tile, so the working spots
    // below — which are offsets from the tile — would hang off the wrong origin.
    // Props have none, which is why this reads as a guard rather than a branch:
    // the two facts are the same fact, and the day a decoration reserves a spot
    // is the day it stops being a decoration.
    if (isProp(f.kind)) { this.actorRoot.add(this.selectedMarker); return; }
    // Where the people who use it stand, marked the same way the build ghost
    // marks them — the ghost is the only place they were ever shown, so the
    // moment a fixture was actually standing there they became invisible. For a
    // till that means the difference between the two sides was something you
    // could see while placing it and never again, including while rotating it.
    //
    // Read off the record rather than recomputed from `rot`: `serveAt` is what
    // the shop was actually laid with, and a facing the generator refused would
    // otherwise be drawn as though it had been honoured.
    for (const s of at) {
      this.selectedMarker.add(buildWorkSpot(
        s.role, { x: s.x - f.x, z: s.z - f.z }, this.selectedMarker.userData.color,
      ));
    }
    this.actorRoot.add(this.selectedMarker);
  }

  /**
   * ...and mark a whole SET of them at once.
   *
   * The three markers above each hold one thing, because until now every
   * question the world could be asked about a fixture had one answer: what the
   * pointer is over, whose menu is open, which hire that is. Picking is the
   * first question with several — the shelves you have shift-clicked, and the
   * ones a held Shift is offering — so this is a fourth marker rather than a
   * fourth mode on any of them, and both sets can be up together with the aim
   * frame and the selection ring inside them.
   *
   * One group per set, rebuilt whole rather than diffed. The key is every id,
   * tile and facing in the set, so a still selection over a still shop costs
   * nothing and any change at all — a pick, a re-flow that re-mints ids, a unit
   * turned — rebuilds it. Diffing would buy nothing: a set changes on a press,
   * and a press is not ten times a second.
   *
   * @param {string} name  which set ('picked', 'kin'), so the two are separate
   * @param {?Array<{f: object, mode: string, spots?: Array}>} list
   */
  setMarkedSet(name, list) {
    const items = (list ?? []).filter((m) => m?.f);
    const key = items.map((m) => `${m.f.id}@${m.f.x},${m.f.z},${m.f.rot ?? 0}:${m.mode}`
      + `|${(m.spots ?? []).map((s) => `${s.x},${s.z}`).join(';')}`).join('/');
    const held = this.markSets.get(name);
    if (held && held.key === key) return;
    if (held) {
      this.actorRoot.remove(held.group);
      disposeGroup(held.group);
      this.markSets.delete(name);
    }
    if (!items.length) return;
    const group = new THREE.Group();
    for (const m of items) {
      const marker = this.markerFor(m.f, m.mode);
      // The working spots go on for the same reason the selection ring's do —
      // and only on something that owns a cell, because a cage is positioned on
      // the art rather than on the tile and the spots are offsets from the tile.
      // The same guard `setSelectedTarget` makes, and the same two facts.
      if (!isProp(m.f.kind)) {
        for (const s of m.spots ?? []) {
          marker.add(buildWorkSpot(s.role, { x: s.x - m.f.x, z: s.z - m.f.z }, marker.userData.color));
        }
      }
      group.add(marker);
    }
    this.actorRoot.add(group);
    this.markSets.set(name, { key, group });
  }

  /**
   * Show (or clear) the build preview.
   *
   * Validity comes from `shared/build.js` — the same function the server runs
   * when the click lands. Reimplementing the rules here to keep the ghost snappy
   * is exactly how a ghost starts lying to you.
   *
   * @param {?object} spec { kind, x, z, rot, moveId, piece, variant, station, tier }
   *        The last four are what it will be DRAWN as. They take no part in
   *        `canPlace` — where a thing may go is a fact about its kind — but a
   *        preview that ignores them is a preview of a different object.
   * @returns {?{ok: boolean, reason?: string}}
   */
  /**
   * Which quarter turn a conveyor cell's DECK should lie along.
   *
   * For a belt that is simply its facing. For a loader it is the run it is part
   * of, worked out from `conveyorNext` — and it falls back to the cell that
   * FEEDS it, because the last loader on a line has nothing downstream and its
   * deck still has to lie along the belt rather than across it.
   */
  conveyorFacing(L, cell) {
    const to = conveyorNext(L, cell);
    if (to) {
      const r = [0, 1, 2, 3].find((q) => {
        const a = anchorTile(cell.x, cell.z, q);
        return a.x === to.x && a.z === to.z;
      });
      if (r !== undefined) return r;
    }
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cell.x, cell.z, r);
      if (conveyorAt(L, n.x, n.z, deckOf(cell))) return rot4(r + 2);
    }
    return cell.rot ?? 0;
  }

  /**
   * How a crate actually travels through this cell: in on one side, out on
   * another, and whether those two are the same axis.
   *
   * The one fact the authored model cannot hold. A part is authored in model
   * space, so it lies one way; a cell in a run has a PATH through it, and at a
   * bend that path is a quarter circle. Drawing straight slats on a corner is
   * what makes a bend read as two belts that happen to touch — the arrows say
   * one thing and every bar on the deck says another.
   *
   * The feeder is looked up rather than stored, because it is the same question
   * `conveyorFlow` already answers from the other end and a second copy of it
   * would be a picture of a run that works differently from the run.
   */
  conveyorPath(L, c) {
    const to = conveyorNext(L, c);
    // ...and a RISE is not a direction across the deck. Step 9 gave every cell
    // a fifth way out — the same square one storey up — and `Math.sign` of that
    // is `0,0`, which is not "no exit", it is a zero vector wearing one. Every
    // reader below spends it: the slats are laid along `out`, the housing's
    // open sides are keyed by it, the end pips are set back along it. Left in,
    // a cell whose only way on is upward has its track drawn along a leg
    // nothing uses. Null instead, which is the answer this already has for a
    // terminus and means the same thing here — nothing leaves ACROSS the deck —
    // so the cell travels the way it is fed and the rise is drawn by the riser.
    const out = to && conveyorAt(L, to.x, to.z, deckOf(to))
      && (to.x !== c.x || to.z !== c.z)
      ? { x: Math.sign(to.x - c.x), z: Math.sign(to.z - c.z) } : null;
    // Every cell that hands to this one, not the first found — a cell can be a
    // MERGE, and a merge is not a bend. Picking whichever feeder happened to be
    // listed first draws a quarter circle on a cell the run goes straight
    // through, which is what a whole column of belts looked like the moment
    // somebody joined a second line into it.
    const feeds = [];
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      const other = conveyorAt(L, n.x, n.z, deckOf(c));
      if (!other) continue;
      const hits = (p) => p && p.x === c.x && p.z === c.z && deckOf(p) === deckOf(c);
      const ways = [conveyorNext(L, other), ...conveyorBranches(L, other)];
      if (ways.some(hits)) feeds.push({ x: Math.sign(c.x - n.x), z: Math.sign(c.z - n.z) });
    }
    // A terminus travels the way it is fed; a head travels the way it leaves.
    // A lone cell has neither and falls back to its own facing, which is the
    // only answer left and the one it was drawn at.
    const face = anchorTile(c.x, c.z, c.rot ?? 0);
    const own = { x: Math.sign(face.x - c.x), z: Math.sign(face.z - c.z) };
    const dirOut = out ?? feeds[0] ?? own;
    // Straight wins. A cell fed from behind AND from the side is carrying on,
    // with something joining it — so the arc is only drawn when the only way in
    // is round a corner.
    const inLine = feeds.find((f) => f.x === dirOut.x && f.z === dirOut.z);
    const dirIn = inLine ?? feeds[0] ?? dirOut;
    // Every feeder, not just the one the path is drawn from. A cell can be a T,
    // and `in`/`out` is a single pair — so the second line in has no place in
    // the path at all and is invisible unless somebody asks for it by name.
    return {
      in: dirIn, out: dirOut, feeds, corner: dirIn.x !== dirOut.x || dirIn.z !== dirOut.z,
    };
  }

  /**
   * Every conveyor slat in the shop, laid along the path rather than the model.
   *
   * Straight cells get what they were authored: the same bars, the same
   * spacing, the same colours, at this cell's own tier — read back off the model
   * so a fast belt still has eight thin ones and a plain one has four. What
   * changes is that the renderer decides WHERE, which is the only way a bend can
   * have slats that follow it.
   *
   * A corner lays them on the quarter circle between the edge it is fed by and
   * the edge it leaves by, each one radial to that arc, and takes the outer
   * corner off the rail with a chamfer. Together those two are the difference
   * between a run that turns and a run that stops and starts again.
   *
   * They scroll like any other slat — the animator is given a world DIRECTION
   * for a straight one and the arc for a corner one, because these meshes live
   * in `staticRoot` at world coordinates rather than inside a model that has
   * been rotated for them.
   */
  /**
   * The quarter circle a cell's goods travel, entering by `from` and leaving by
   * `to` — centre, and the two ends of the sweep.
   *
   * Its own function because a T draws more than one of these: the through-line
   * curves in off `path.in` and every other feeder curves in off its own edge,
   * and the two must agree about radius and about which way round they go, or a
   * spur meets the run it is joining at a visible kink.
   */
  /* `conveyorJoined` lived here and went with the rails it existed for.
   *
   * It answered "do goods actually cross the line between these two cells" —
   * which the rail rule needed, because the cheap version of that question ("is
   * there a conveyor across this edge") is exact only while every neighbour is
   * a neighbour IN the run, and a tunnel breaks it both ways at once: the main
   * line a span ducks under is adjacent to both mouths and connected to
   * neither, so a mouth grew a kerb onto a belt it has nothing to do with and
   * the main line lost its own where the tunnel passed.
   *
   * Worth keeping written down rather than only deleted, because the trap comes
   * back with anything else drawn per EDGE: adjacency is not connection, and a
   * tunnel is the case that proves it.
   */

  /* `conveyorArc` lived here and went with the curves it drew.
   *
   * It answered "the quarter circle a cell's goods travel", and three things
   * were laid on it — the bent groove, the carriers on a corner, and the near
   * half of a spur at a T. All three are right angles now, for the reason
   * `addConveyorPaths` gives: the crate is handed cell-centre to cell-centre, so
   * a curve was a picture of a motion nothing performs.
   *
   * Worth a tombstone rather than a silent delete, because the thing it existed
   * to prevent is not obvious from the straight version: a spur and the bend it
   * joins have to agree about radius and about which way round they go, or two
   * lines meet at a visible kink. Anything that puts a curve back needs one
   * function answering that for both, not two.
   */

  addConveyorSlats(L, geo) {
    // Every slat in the shop, by colour, as ONE draw each.
    //
    // A slat is a bar a few triangles wide and a busy shop has a couple of
    // hundred of them; measured, they were 242 draw calls for 0.67ms — the
    // largest single block left once the static decoration was welded, and the
    // one thing on a belt that cannot be welded because it is the thing that
    // moves.
    //
    // The trick is that `motion.js` never learns about any of this. Each slat
    // keeps an `Object3D` of its own that is NOT in the scene — a transform and
    // nothing else — so the `scroll` branch goes on writing `mesh.position` and
    // `mesh.rotation.y` exactly as it did for a real mesh. `flushSlats` copies
    // those transforms into the instance buffer once a frame, which is 242
    // matrix composes against 242 draw calls.
    this.slatBatches = [];
    const byColour = new Map();
    for (const c of conveyorsOf(L)) {
      const parts = this.conveyorSlatParts(c);
      // A machine has spurs and no slats of its own — see `conveyorRunSlats`.
      // Bailing on `parts` alone skipped every loader in the shop before its
      // spur was ever reached, which is the whole track between a machine and
      // the unit it feeds simply not being drawn.
      const spurs = this.conveyorSpurs(L, c);
      if (!parts.length && !spurs.length) continue;
      const path = this.conveyorPath(L, c);
      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      rec.conveyor = true;

      // The gap between slats, which is what a scroll wraps on. Measured off the
      // authored spacing rather than assumed, or a tier that packs them closer
      // would scroll a slat straight through its neighbour.
      const xs = parts.map((p) => p.pos?.[0] ?? 0).sort((a, b) => a - b);
      const span = xs.length > 1 ? Math.abs(xs[1] - xs[0]) : 0.26;

      for (const p of parts) {
        const along = p.pos?.[0] ?? 0;
        const y = p.pos?.[1] ?? 0.115;
        const thin = p.scale?.[0] ?? 0.07;
        const high = p.scale?.[1] ?? 0.03;
        const long = p.scale?.[2] ?? 0.56;
        // A transform and nothing else — see the note at the top of this
        // function. It is never added to the scene; the instance buffer is.
        const mesh = new THREE.Object3D();
        const entry = {
          mesh,
          motion: { kind: 'chase', hz: p.motion?.hz ?? 1.1, amount: span },
          rot: 0,
          scale: mesh.scale,
          axis: null,
          arm: null,
          pivot: null,
          phase: rec.moving.length * 0.41,
        };

        // Straight, on a bend as much as anywhere — see the note in
        // `addConveyorPaths` about why the arc went. Carriers ride the outgoing
        // leg; the stub back toward the feeding side is deck and nothing else,
        // which is what a right-angled transfer looks like.
        // The outgoing half only, on a bend. The other half of the deck is not
        // drawn there — see `conveyorBody` — so a carrier authored behind the
        // centre would ride on bare floor. The incoming leg gets its own
        // carriers below, from the side the goods actually arrive on.
        if (path.corner && along < 0) continue;
        const dx = path.out.x;
        const dz = path.out.z;
        Scene.aimCarrier(mesh, { x: dx, z: dz }, {
          thin, high, long, span,
        });
        mesh.position.set(c.x + dx * along, deckLift(c) + y, c.z + dz * along);
        entry.dir = { x: dx, z: dz };
        Scene.lightSlat(mesh, entry);
        entry.pos = mesh.position.clone();
        entry.scale = mesh.scale.clone();
        if (!byColour.has(p.color)) byColour.set(p.color, []);
        byColour.get(p.color).push(mesh);
        rec.moving.push(entry);
      }

      // ...and a SPUR for every other line that feeds this cell.
      //
      // `in`/`out` is one pair, so a cell fed by two lines draws the path of
      // one of them and nothing at all for the other. On a bend that is the
      // worst it looks: what you get is a belt curving in from a single side,
      // with the run that actually joins here simply stopping at the tile edge
      // against a deck it is touching. The deck already reaches that edge and
      // the rail is already dropped there, so the join is drawn and only the
      // thing that says which way goods MOVE is missing — which reads as two
      // belts that happen to abut rather than as a T.
      //
      // It runs STRAIGHT IN and stops at the middle, which is the same right
      // angle the bend above is drawn as.
      //
      // It used to curve — the same quarter circle, off its own edge onto `out`,
      // on the argument that a spur laid straight points at the centre of the
      // tile and stops, reading as a line running into the side of another one
      // rather than as a line joining it. That is what a junction IS, and it is
      // what the goods do: a crate arrives at the middle of this cell and leaves
      // by whichever way the splitter picked, with no arc anywhere in it.
      //
      // Half the leg, still, and for the reason the curve stopped short: the far
      // half belongs to the through-line's own track, so a whole one gives every
      // T two sets of carriers along one path, beating against each other.
      // On a BEND the through-line is itself a spur — goods arrive across the
      // cell rather than along it — so `path.in` is included there and skipped
      // everywhere else. Skipped on a straight because the main loop above has
      // already laid that whole leg; included on a bend because that loop now
      // stops at the middle.
      for (const f of path.feeds) {
        if (!path.corner && f.x === path.in.x && f.z === path.in.z) continue;
        for (const p of parts) {
          const along = p.pos?.[0] ?? 0;
          if (along >= 0) continue;
          const y = p.pos?.[1] ?? 0.115;
          const thin = p.scale?.[0] ?? 0.07;
          const high = p.scale?.[1] ?? 0.03;
          const long = p.scale?.[2] ?? 0.56;
          const mesh = new THREE.Object3D();
          // In along the feeder's own axis. `f` is the direction goods TRAVEL —
          // neighbour to cell — and `along` is negative here, so `c + f * along`
          // starts at the feeding edge and walks to the middle, exactly as a
          // straight cell's own carriers walk from edge to edge. Subtracting
          // instead mirrors the half-leg onto the OPPOSITE side of the cell,
          // which lays track out into a square that has nothing on it and no
          // reason ever to get one.
          Scene.aimCarrier(mesh, f, {
            thin, high, long, span,
          });
          mesh.position.set(c.x + f.x * along, deckLift(c) + y, c.z + f.z * along);
          const entry = {
            mesh,
            motion: { kind: 'chase', hz: p.motion?.hz ?? 1.1, amount: span },
            rot: 0,
            scale: mesh.scale.clone(),
            axis: null,
            arm: null,
            pivot: null,
            phase: rec.moving.length * 0.41,
            dir: { x: f.x, z: f.z },
            pos: mesh.position.clone(),
          };
          Scene.lightSlat(mesh, entry);
          if (!byColour.has(p.color)) byColour.set(p.color, []);
          byColour.get(p.color).push(mesh);
          rec.moving.push(entry);
        }
      }

      // ...and a SPUR is one more leg of exactly this, which is the whole of
      // what it should ever have been.
      //
      // It was built somewhere else out of something else: `addConveyorPaths`
      // laid a flat bed and hand-made carriers, in its own colours, at its own
      // spacing, on its own `rec.spur` list, animated by a second
      // `animateMotion` call gated on a second clock. Three systems for belts,
      // loaders and sorters where there is one run — and every one of those
      // seams is a place the picture can disagree with itself. It did: the spur
      // scrolled off `armSaid` while the track two inches away scrolled off the
      // cell being busy, so a loader holding a jammed box had half its own
      // machine moving.
      //
      // Here it is the same `parts` at the same `span`, in the same instanced
      // batch, on the same `rec.moving` list, driven by the same working flag.
      // A second belt design costs it nothing, a tier that packs slats closer
      // packs these closer, and there is no second thing to remember to update.
      //
      // The direction is the SPUR's, not the run's: goods cross it outward on a
      // pour and inward on a lift, and carriers scrolling the wrong way are
      // worse than still ones, because a still one says nothing and this one
      // says the opposite of what the machine is doing.
      const spurParts = spurs.length ? this.conveyorRunSlats(L, c) : [];
      const spurSpan = (() => {
        if (spurParts.length < 2) return span;
        const along = spurParts.map((p) => p.pos?.[0] ?? 0).sort((a, b) => a - b);
        return Math.abs(along[1] - along[0]);
      })();
      for (const sp of spurParts.length ? spurs : []) {
        // FITTED, not stepped. Walking out at the run's own spacing is right on
        // a spur long enough to hold two or three bars and silent on the one
        // that matters most: a loader bolted to a shelf has about a fifth of a
        // tile of daylight between the two, and at a 0.33 pitch that is one slat
        // if you are lucky and none if you are not — a length of track drawn
        // with nothing on it. Three bars minimum, spread evenly, so a short spur
        // reads as track rather than as a gap, and a long one out onto a pad
        // still comes out at very nearly the belt's own pitch.
        // Up to the PAD, not to the end — the last stretch is where the goods
        // leave, and carriers drawn under it say the opposite. See the pad in
        // `addConveyorPaths`.
        const len = Math.max(spurSpan, (sp.onUnit ? sp.to : sp.to - SPUR_PAD) - sp.from);
        const n = Math.max(2, Math.round(len / spurSpan));
        const step = len / n;
        for (let i = 0; i < n; i++) {
          const along = sp.from + step * (i + 0.5);
          const p = spurParts[i % spurParts.length];
          const y = p.pos?.[1] ?? 0.115;
          const thin = p.scale?.[0] ?? 0.07;
          const high = p.scale?.[1] ?? 0.03;
          const long = p.scale?.[2] ?? 0.56;
          const mesh = new THREE.Object3D();
          // The SPUR's own flow, which is the direction goods cross it — outward
          // on a pour and inward on a lift. The same sign the chase runs on, and
          // it has to be the same one: an arrow is a louder version of the claim
          // the moving band makes, so a chevron pointing the other way is not a
          // quieter mistake, it is the machine saying two opposite things about
          // itself at once.
          const dir = { x: sp.dx * sp.flow, z: sp.dz * sp.flow };
          Scene.aimCarrier(mesh, dir, {
            thin, high, long, span: step,
          });
          mesh.position.set(c.x + sp.dx * along, deckLift(c) + y, c.z + sp.dz * along);
          const entry = {
            mesh,
            motion: { kind: 'chase', hz: p.motion?.hz ?? 1.1, amount: step },
            rot: 0,
            axis: null,
            arm: null,
            pivot: null,
            phase: rec.moving.length * 0.41,
            dir,
            pos: mesh.position.clone(),
            scale: mesh.scale.clone(),
          };
          Scene.lightSlat(mesh, entry);
          if (!byColour.has(p.color)) byColour.set(p.color, []);
          byColour.get(p.color).push(mesh);
          // FILED PER SPUR, and NOT on `rec.moving` — which is the one place a
          // spur is not simply another leg of the run.
          //
          // `rec.moving` has one working flag for the whole cell, and for the
          // track through a machine that is right: a crate sitting on a belt IS
          // the belt working. A spur is idle nearly all of that time. A loader
          // holds a box for as long as it takes to find somewhere for it, and it
          // serves ONE side per transfer — so run off the cell's flag, every
          // spur on the machine scrolls whenever it is holding anything, and
          // three lengths of track run flat out while goods cross one of them.
          // That is the lie `beltStuck` was added to stop the main line telling.
          //
          // Same slats, same batch, same `scroll`, same `flushSlats`. The only
          // thing that is per-spur is WHEN — see `animateStations`, which is
          // handed this list against the side the shop says the goods crossed.
          const key = `${sp.dx},${sp.dz}`;
          rec.spurRails ??= new Map();
          if (!rec.spurRails.has(key)) rec.spurRails.set(key, []);
          rec.spurRails.get(key).push(entry);
        }
      }

      // ...and no corner rail or chamfer either, for the reason the straight
      // ones went (see `addConveyorPaths`): both were the lip of a deck, and the
      // deck is gone. The chamfer in particular only ever existed to take the
      // right angle off the OUTSIDE of two rails meeting — with no rails there
      // is no angle, and the bend is already drawn as a bend by the groove
      // curving through it.

      if (rec.moving.length || rec.spurRails?.size) this.movingFixtures.set(c.id, rec);
    }

    // One instanced mesh per colour, straight onto `staticRoot` and NOT into
    // `beltRoot` — an `InstancedMesh` answers `isMesh`, so the weld at the foot
    // of `addConveyorPaths` would happily merge it into a single frozen bar.
    //
    // Its own geometry rather than the shared `PATH_GEO`, because this one IS
    // handed to `staticRoot` and `disposeGroup` frees geometry it does not
    // recognise — a shared one would be disposed out from under every other
    // conveyor mesh on the next re-flow.
    // ONE mesh for every slat in the shop, whatever colour it was authored in.
    //
    // The colour rides in `instanceColor` against a WHITE material — three
    // multiplies the two, so a coloured material here would square the hue —
    // which means a second belt design costs nothing: no extra batch, no extra
    // draw, and the same bake walks all of them.
    const holders = [...byColour.values()].flat();
    const hues = [...byColour.entries()].flatMap(([c, hs]) => hs.map(() => new THREE.Color(c)));
    if (holders.length) {
      const im = new THREE.InstancedMesh(
        Scene.carrierGeometry(), material('#ffffff', 1), holders.length,
      );
      im.raycast = NO_PICK;
      im.castShadow = false;
      im.receiveShadow = false;
      // Baked per INSTANCE, the way the ground is — a slat is one small thing at
      // one place, so `instanceColor` says everything a per-vertex bake would.
      // `bare` is its unlit colour and `at` where it stands, which is the pair
      // `rebakeGround` already knows how to walk.
      const bare = new Float32Array(holders.length * 3);
      const at = new Float32Array(holders.length * 3);
      holders.forEach((h, i) => {
        // Set once here so a paused shop and the very first frame both draw the
        // slats where they were laid rather than stacked at the origin.
        h.updateMatrix();
        im.setMatrixAt(i, h.matrix);
        const hue = hues[i];
        bare[i * 3] = hue.r; bare[i * 3 + 1] = hue.g; bare[i * 3 + 2] = hue.b;
        at[i * 3] = h.position.x; at[i * 3 + 1] = h.position.y; at[i * 3 + 2] = h.position.z;
        im.setColorAt(i, this.lights.bakeInto(hue.clone(), at[i * 3], at[i * 3 + 1], at[i * 3 + 2]));
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.layers.set(BAKED_LAYER);
      // A MIRROR OF THE BAKED COLOUR, because the chase is a multiplier on it.
      //
      // `flushSlats` writes `lit × k` every frame, so it needs the colour this
      // carrier would be standing still — its hue with the shop's light already
      // multiplied in. Re-deriving that per frame means a `bakeInto` per slat
      // per frame, which is the one thing the whole instanced batch exists to
      // avoid. Kept on the `bakedGround` entry as well as on the batch so that
      // `rebakeGround` refreshes it when the hour moves: without that the belts
      // would go on wearing noon's light after dark, which is the one lighting
      // bug that looks like the belts being emissive on purpose.
      const lit = new Float32Array(im.instanceColor.array);
      this.bakedGround.push({ mesh: im, bare, at, lit });
      this.staticRoot.add(im);
      this.slatBatches.push({ im, holders, lit });
    }
  }

  /**
   * Hang the two things a carrier needs to be LIT rather than moved onto the
   * holder that stands in for it.
   *
   * `flushSlats` walks holders and knows nothing about cells, entries or runs,
   * so the link back to the motion entry (which owns how far the run has
   * travelled, and how much of the ease is left) and the carrier's own place
   * ALONG the flow both have to ride on the object it does see.
   *
   * The place is a dot product rather than a distance: a run going east wants
   * `x` and one going north wants `-z`, and taking either on its own puts every
   * carrier on half the shop in step with the wrong wave. Two cells of the same
   * run share a direction, so the phase is continuous across the join with
   * nothing anywhere having to know where a run begins.
   */
  static lightSlat(mesh, entry) {
    mesh.userData.flow = entry;
    mesh.userData.wave = mesh.position.x * (entry.dir?.x ?? 1)
      + mesh.position.z * (entry.dir?.z ?? 0);
  }

  /**
   * THE CARRIER IS A CHEVRON, and which way it points is the whole of what it
   * says.
   *
   * It was a box — 0.1 along the flow by 0.13 across — which at this camera is a
   * SQUARE, and a square says a cell is a belt and nothing else. Which way that
   * belt runs was told in one place only: the band of brighter carriers walking
   * the flow, which is a beautiful thing to watch and only exists while a box is
   * actually on the cell. That is about four tenths of a second per crate, so
   * for nearly all of a shop's life every run in the building is a row of
   * identical dots — and the one question anybody has of a conveyor, standing
   * over it holding something, is which end the goods come out of. You had to
   * put a crate on it and watch.
   *
   * So the shape carries the direction and the light carries the SPEED, which is
   * the split each is good at: a still belt still points, and a running one
   * still flows. It costs nothing — same instance, same batch, same bake, one
   * quarter turn per carrier — because the geometry is authored pointing along
   * its own +x and every carrier already knows its `dir`.
   *
   * The turn is `vehicleYaw` rather than a second spelling of it: fixture art is
   * drawn nose-east and a heading is `atan2(dx, dz)`, and those two conventions
   * meeting is exactly what that function is for. A chevron laid a quarter turn
   * out is not a bug you can see — it points across the belt, which reads as a
   * slat, which is what it used to be.
   */
  static aimCarrier(mesh, dir, { thin, high, long, span }) {
    // BIGGER THAN THE SQUARE IT REPLACES, both ways, and neither is a taste
    // call. A chevron is mostly notch — the arms are under half of its footprint
    // — so laid at the bar's own size it reads as a smaller, fainter dot rather
    // than as an arrow. Across is what makes the V an angle you can see at all,
    // and it stays inside the deck (0.20 against 0.26 on the plain belt, 0.19
    // against 0.28 on the quick one) or the carriers hang over the edge of the
    // track they are supposed to be running on.
    const across = long * 1.55;
    // ...and along is capped by the GAP rather than chosen, because the pitch is
    // authored per tier: the quick belt packs its carriers at 0.2 where the
    // plain one has 0.33, so a length that is a nose-to-tail run of arrows on
    // one design is a solid stripe on the other — which is a belt with no
    // carriers on it, told twice as often.
    const along = Math.max(thin, Math.min(long * 1.15, (span || 0.25) * 0.62));
    mesh.scale.set(along, high, across);
    mesh.rotation.y = vehicleYaw(Math.atan2(dir.x, dir.z));
  }

  /**
   * The unit chevron every carrier is an instance of: a flat arrow pointing
   * along its own +x, filling a 1×1×1 box so that `aimCarrier`'s scale means
   * the same thing a box's did.
   *
   * `LEAD + ARM === 1` is the invariant and it is what makes that true — the
   * apex lands on +0.5 and the wingtips on −0.5, so the shape is exactly as long
   * as it is asked to be. Break it and every carrier in the shop sits slightly
   * off the spot it was laid at, which draws as a run whose arrows drift out of
   * step with their own spacing.
   *
   * Extruded rather than built from two rotated bars, which is the obvious way
   * and leaves a notch at the apex where the two boxes cross: one polygon has a
   * mitre because a mitre is what a polygon does at a corner.
   */
  static carrierGeometry() {
    const LEAD = 0.55; // how far the apex leads the wingtips
    const ARM = 0.45; // the arm's own thickness, measured along the flow
    const tail = 0.5 - LEAD;
    const shape = new THREE.Shape();
    shape.moveTo(tail, -0.5);
    shape.lineTo(0.5, 0);
    shape.lineTo(tail, 0.5);
    shape.lineTo(-0.5, 0.5);
    shape.lineTo(0.5 - ARM, 0);
    shape.lineTo(-0.5, -0.5);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    // Authored flat in the shape's own plane and stood up here: the extrusion
    // becomes HEIGHT and the shape's across-axis becomes z, so the finished
    // geometry is x-along-flow, y-up, z-across — the axes `aimCarrier` scales.
    geo.translate(0, 0, -0.5);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  /** Is this a part the renderer re-lays rather than the model drawing it? */
  static isSlat(p) { return p?.motion?.kind === 'scroll'; }

  /** ...and the housing, which the renderer puts on a side nothing is attached to. */
  static isBack(p) { return p?.back === true; }

  /**
   * The same model with its slats taken out — see `addConveyorSlats`.
   *
   * Stage by stage, because a belt's tiers are stages and a loader's model is a
   * bare `parts` list, and a helper that only understood one of those would
   * quietly leave every fast belt drawing two sets of slats on top of each
   * other.
   */
  conveyorBody(model, f, L = null) {
    if (!model || !CONVEYOR_KINDS.includes(f.kind)) return model;
    /**
     * A CORNER GETS HALF A DECK, and this is the leg that used to stick out.
     *
     * The deck is authored a full tile long because a belt is a cell repeated —
     * true of every straight, and false of a bend. The model is turned so its
     * `+x` is the way the cell hands ON, so the half BEHIND the centre is the
     * side goods arrive from — which on a straight is the feeding cell and on a
     * corner is nothing at all. What you get is a stub of track reaching from a
     * bend out into a square the run never touches, and no amount of correcting
     * the fillers touches it: it is the fixture's own model, drawn where it was
     * authored, and the only thing wrong is that half of it is not part of this
     * cell's path.
     *
     * Halved here rather than covered over or drawn separately, so it stays one
     * mesh from one authored part at whatever colour that tier is painted.
     *
     * ...AND A BEND IS NOT THE ONLY CELL WITH NOTHING BEHIND IT, which is what
     * this was actually about all along. The rule was written as `path.corner`
     * because a bend is where it was noticed, and a corner is only one of the
     * ways the back half ends up over a square the run never touches. The others
     * happen in any shop: the first cell of a run has nothing feeding it by
     * definition, and a belt whose `rot` names an empty square is a dead end that
     * still lays a full tile of groove across itself. Both draw exactly what a
     * bend used to — half a tile of track reaching into bare floor — and what it
     * reads as is a belt somebody started building and abandoned.
     *
     * So the question is asked of the EDGE rather than of the shape: does
     * anything hand goods to this cell across the side the back half lies on. A
     * corner answers no (goods arrive across the side), which is why the old rule
     * is a special case of this one rather than a clause beside it.
     *
     * `feeds` and not "is there a conveyor there" — the `ADJACENCY IS NOT
     * CONNECTION` note on the filler is the same trap, and it is what keeps two
     * runs laid side by side from growing stubs into each other.
     */
    const path = L && f.x != null ? this.conveyorPath(L, f) : null;
    // Which way the art is turned, so "behind" is the model's own −x rather than
    // a guess. The same expression `addFixtureProps` turns the prop by — a
    // second spelling of it would cut the wrong end of a tunnel mouth, which is
    // the one kind here whose art is deliberately laid against the flow.
    const flowRot = derivedFlow(f.kind) ? this.conveyorFacing(L, f)
      : (f.kind === 'under' && !tunnelExit(L, f)
        ? rot4((f.rot ?? 0) + 2) : (f.rot ?? 0));
    const back = path ? anchorTile(f.x, f.z, rot4(flowRot + 2)) : null;
    const fedFromBack = back
      ? path.feeds.some((v) => v.x === Math.sign(f.x - back.x)
        && v.z === Math.sign(f.z - back.z))
      : true;
    const half = (p) => {
      // The deck is the part that spans the tile — the same test `conveyorDeck`
      // uses to find it, rather than an index into a list somebody may reorder.
      if (!path || fedFromBack || (p.scale?.[0] ?? 0) < 0.99) return p;
      const pos = [...(p.pos ?? [0, 0, 0])];
      const scale = [...p.scale];
      // From the far side of the incoming leg to the outgoing edge — NOT from
      // the middle, which is the obvious answer and leaves a notch.
      //
      // The leg the cell is fed by is `cross` wide either side of the centre
      // line, and the filler that draws it starts at `cross` and runs out to the
      // tile edge. Halve the deck at 0 and the little square between −cross and
      // 0 belongs to neither of them: an L with a bite out of its outside
      // corner, which at this camera reads as the two legs not quite meeting.
      const cross = (p.scale[2] ?? 0) / 2;
      scale[0] = 0.5 + cross;
      pos[0] = (pos[0] ?? 0) + 0.25 - cross / 2;
      return { ...p, pos, scale };
    };
    const strip = (parts) => (parts ?? [])
      .filter((p) => !Scene.isSlat(p) && !Scene.isBack(p)).map(half);
    if (model.stages) {
      return { ...model, stages: model.stages.map((s) => ({ ...s, parts: strip(s.parts) })) };
    }
    return { ...model, parts: strip(model.parts) };
  }

  /**
   * Hang a conveyor's housing on a side that has nothing attached to it.
   *
   * A loader has four sides and on a working run three of them are spoken for:
   * the cell that feeds it, the cell it hands to, and the unit it pours into.
   * The fourth is the outside — a wall, or bare floor — and that is the only
   * place a solid two-foot back belongs.
   *
   * Authored, it cannot know any of that. It sits at the model's `-z`, and a
   * loader is turned by the FLOW rather than by `rot`, so on a bend it swings
   * round and parks against whichever side the run leaves by. What you get is a
   * curb across the boundary with the belt that feeds it — which reads as the
   * two cells not being connected, on a run that is working perfectly.
   *
   * A CHILD of the fixture group rather than a mesh of its own, so it stays
   * pickable, moves with the piece and is disposed with it. Its rotation is the
   * difference between the side we chose and the way the body is already
   * turned; the body's own `-z` is `FACING[rot + 3]`, which is what makes that
   * subtraction the whole of the placement.
   *
   * A wall beats bare floor, because that is the side the housing reads as
   * belonging to — and with every side attached it draws NOTHING, which is the
   * right answer for a cell in the middle of a junction and the one an authored
   * part can never give.
   */
  attachConveyorBack(L, f, prop, flowRot) {
    if (!CONVEYOR_KINDS.includes(f.kind)) return;
    const model = this.fixtureModel(f);
    const parts = (partsAt(model, this.fixtureT(f)) ?? []).filter(Scene.isBack);
    if (!parts.length) return;

    // Every side goods cross, in either direction. Pouring out was the obvious
    // half and taking in is the half that was missed: a loader told to only load
    // has no pours at all, so *every* side reads as free and the housing parks
    // on the yard it is lifting from. Which is the same wall in the same wrong
    // place, arrived at from the opposite direction.
    const used = [...this.conveyorPours(L, f), ...this.conveyorIntake(L, f)];
    const free = [];
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(f.x, f.z, r);
      if (conveyorAt(L, n.x, n.z, deckOf(f))) continue;
      if (used.some((p) => p.x === n.x && p.z === n.z)) continue;
      free.push({ r, walled: SOLID.has(edgeBetween(L, f.x, f.z, n.x, n.z)) });
    }
    if (!free.length) return;
    const pick = free.find((s) => s.walled) ?? free[0];

    // `-z` of a body turned by `flowRot` points at `FACING[flowRot + 3]`, so the
    // turn that lands it on `pick.r` is `pick.r + 1` — and the child carries
    // only the difference, because the parent is already turned by the flow.
    const want = rot4(pick.r + 1);
    const group = buildModel({ parts }, { t: this.fixtureT(f) });
    if (!group) return;
    group.rotation.y = -rot4(want - flowRot) * (Math.PI / 2);
    prop.add(group);
  }

  /** ...and only the slats, at this cell's own tier. */
  conveyorSlatParts(c) {
    const model = this.fixtureModel(c);
    if (!model) return [];
    return (partsAt(model, this.fixtureT(c)) ?? []).filter((p) => Scene.isSlat(p));
  }

  /**
   * The slats to lay along a machine's SPUR — the run's, because the machine has
   * none of its own.
   *
   * A loader is a housing. It is authored as a hood and a deck and nothing that
   * answers `isSlat`, which is correct — the bars you see crossing it belong to
   * the belt running underneath. So "draw the spur out of this cell's own slats"
   * is a rule with no rows in it: `conveyorSlatParts` answered `[]`, the caller
   * skipped the cell, and the whole spur silently did not exist. That is the
   * working-system-with-no-content-in-it trap, and it looks exactly like a
   * feature nobody wired up.
   *
   * So it borrows from a neighbour IN the run, which is the honest answer as
   * well as the working one: a spur is a length of that belt, so it should be
   * made of that belt's bars, at that belt's spacing, in that belt's colour. A
   * loader dropped into a run of fast belt gets fast belt's slats and always
   * will, with nobody having to remember to keep two designs in step.
   *
   * Falls back to any conveyor in the shop, then to nothing: a lone loader with
   * no run attached has no belt to be made of, and drawing a guess would be a
   * spur in a colour the shop does not own.
   */
  conveyorRunSlats(L, c) {
    const own = this.conveyorSlatParts(c);
    if (own.length) return own;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      const other = conveyorAt(L, n.x, n.z, deckOf(c));
      if (!other) continue;
      const parts = this.conveyorSlatParts(other);
      if (parts.length) return parts;
    }
    for (const other of conveyorsOf(L)) {
      const parts = this.conveyorSlatParts(other);
      if (parts.length) return parts;
    }
    return [];
  }

  /**
   * This conveyor cell's deck, as the numbers the filler above needs.
   *
   * Read off the authored model at this cell's own tier rather than from a
   * constant, because the deck is content: three belt tiers are three colours,
   * a loader is a fourth, and somebody can author a fifth this afternoon. A
   * filler in the wrong grey is a patch on a belt rather than a belt.
   *
   * The deck is the part that spans the whole tile ALONG the run, which is the
   * one structural thing every conveyor model has and the only handle that does
   * not need the piece to declare anything new. `long` is that span, `cross` is
   * its half-extent the other way — the half that leaves the gap.
   *
   * SINCE THE SLAB CAME OFF, that part is the TRACK — the recess the carriers
   * run in — and the test finds it without being changed, because it is still
   * the only thing on the model a tile wide. That is the right answer rather
   * than a lucky one: what this function is for is the piece that has to stay
   * unbroken across a join, and with the deck gone the groove is that piece.
   * The cell under it is ordinary ground now, so there is nothing else left to
   * be continuous.
   */
  conveyorDeck(L, c) {
    const model = this.fixtureModel(c);
    if (!model) return null;
    const parts = partsAt(model, this.fixtureT(c));
    const deck = (parts ?? []).find((p) => (p.scale?.[0] ?? 0) >= 0.99);
    if (!deck) return null;
    return {
      color: deck.color,
      long: deck.scale[0],
      cross: deck.scale[2] / 2,
      h: deck.scale[1],
      y: deck.pos?.[1] ?? deck.scale[1] / 2,
      rot: derivedFlow(c.kind) ? this.conveyorFacing(L, c) : (c.rot ?? 0),
    };
  }

  /**
   * What the side a loader or a sorter is AIMED at turns out to be.
   *
   * The four answers are the three meanings `rot` carries plus the one nobody
   * intends, and they are ordered the way `armSwing` asks: a unit first, then
   * the run, then somewhere to set a box down. A pad is `drop` rather than a
   * fourth answer because it is the same act — `armDrop` treats painted ground
   * as consent already given, which is a reason to prefer it and not a
   * different thing to do with the box.
   *
   * `dead` is the one worth drawing. A loader aimed at a wall, a queue tile or
   * the back of a freezer has no first unit, no output and no off-ramp — every
   * one of its four sides still works, so the shop looks fine, and the piece is
   * simply not doing the job you turned it to do.
   */
  /**
   * The sides a loader physically hands goods out through.
   *
   * Every side it can reach rather than the one `rot` names, because that is
   * what `armSwing` does — it pours into all four in one swing and `rot` only
   * decides who is asked first. A conveyor neighbour is the run rather than a
   * pour: it is either a way out already counted or not a way out at all.
   *
   * On the class rather than inside `addConveyorPaths` because the corner rails
   * live in `addConveyorSlats` and need the same answer. Bare floor is
   * deliberately not here — `armSwing` will lift off any tile and `armDrop`
   * will set down on the one it faces, so "floor" is true of nearly every
   * loader in every shop, and a mark that fires everywhere is one you stop
   * reading.
   */
  /**
   * The box a loader or a sorter is enclosed in — where its faces are.
   *
   * Measured off the authored model rather than written down here, exactly as
   * `conveyorDeck` is and for the same reason: the housing is content, somebody
   * can draw a taller one this afternoon, and a mouth cut at a remembered height
   * is a dark patch floating beside a machine.
   *
   * The tallest part is the housing. A lid sits on top of it and a turntable on
   * top of that, so it is the DEEPEST rather than the highest — the one part
   * that has a face for a hole to go in.
   */
  conveyorHousing(c) {
    const model = this.fixtureModel(c);
    if (!model) return null;
    const parts = partsAt(model, this.fixtureT(c)) ?? [];
    let best = null;
    for (const p of parts) {
      if ((p.scale?.[1] ?? 0) < 0.2) continue;
      if (!best || p.scale[1] > best.scale[1]) best = p;
    }
    if (!best) return null;
    return {
      y: best.pos?.[1] ?? best.scale[1] / 2,
      h: best.scale[1],
      long: best.scale[0] / 2,
      cross: best.scale[2] / 2,
    };
  }

  /**
   * A SHAFT'S TWO ENDS, as the bands the renderer has to wall in.
   *
   * A lift is a housing at each storey with a glass tube between them, and the
   * ends are enclosed for the reason the loader's and the sorter's sides are:
   * a machine open on all four is a table, and what you want to see is the one
   * side the goods actually cross. Left open the shaft was a cage — you could
   * see straight through the bottom of it into the aisle behind, and nothing
   * about it said which way a box was going in or coming out.
   *
   * Which sides those are cannot be authored, because a lift has no `rot`: it
   * carries whichever way its feeders point, and both of its ends face a
   * different run. So the panels are derived, like the chute and the blades,
   * and this measures the BOX to put them in off the authored art — exactly as
   * `conveyorDeck` and `conveyorHousing` do, and for the same reason. A band
   * sized to a remembered shaft is a panel with daylight over it the day
   * somebody draws a taller one.
   *
   * The glass tube is the middle: everything under it is the lower housing and
   * everything above it is the upper one, up to the underside of the head.
   */
  liftBands(c) {
    const model = this.fixtureModel(c);
    if (!model) return null;
    const parts = partsAt(model, this.fixtureT(c)) ?? [];
    const top = (p) => (p.pos?.[1] ?? p.scale[1] / 2) + p.scale[1] / 2;
    const bottom = (p) => (p.pos?.[1] ?? p.scale[1] / 2) - p.scale[1] / 2;
    // The tube. Its faces are where the housings stop, and its own footprint is
    // what they are as wide as.
    const glass = parts.filter((p) => (p.alpha ?? 1) < 1 && p.scale[1] > 0.2);
    if (!glass.length) return null;
    const lo = Math.min(...glass.map(bottom));
    const hi = Math.max(...glass.map(top));
    // The pan a box stands on at the bottom, which is the one part a tile wide
    // — the same handle `conveyorDeck` uses, taken at the lower of the two.
    const pans = parts.filter((p) => (p.scale?.[0] ?? 0) >= 0.99);
    if (!pans.length) return null;
    const floor = Math.min(...pans.map(top));
    // ...and the underside of the head, which is the tallest thing here.
    const post = parts.reduce((best, p) => (p.scale[1] > (best?.scale[1] ?? 0) ? p : best), null);
    const roof = top(post);
    return {
      face: Math.max(...glass.map((p) => Math.abs(p.pos?.[0] ?? 0) + Math.abs(p.pos?.[2] ?? 0))),
      span: Math.max(...glass.map((p) => Math.max(p.scale[0], p.scale[2]))),
      low: [floor, lo],
      high: [hi, roof],
    };
  }

  /**
   * ...and which side of a shaft is a PORTAL, per storey.
   *
   * A lift stands on both, so "which way does it face" has two answers and
   * neither is `rot`. Both directions count: the side a run hands IN on is as
   * much a hole as the side it leaves by, and a housing walled across its own
   * inlet is a box the goods arrive through the side of.
   */
  liftPorts(L, c) {
    const ports = { 0: new Set(), [CEILING]: new Set() };
    const to = conveyorNext(L, c);
    if (to) ports[deckOf(to)]?.add(`${Math.sign(to.x - c.x)},${Math.sign(to.z - c.z)}`);
    for (const d of [0, CEILING]) {
      for (const r of [0, 1, 2, 3]) {
        const n = anchorTile(c.x, c.z, r);
        const other = conveyorAt(L, n.x, n.z, d);
        if (!other || other.id === c.id) continue;
        const way = conveyorNext(L, other);
        if (!way || way.x !== c.x || way.z !== c.z) continue;
        ports[d].add(`${Math.sign(n.x - c.x)},${Math.sign(n.z - c.z)}`);
      }
    }
    return ports;
  }

  conveyorPours(L, c) {
    if (c.kind !== 'arm') return [];
    // A loader told to only put goods ON the line pours nowhere, so nothing
    // beside it is a hand-over — no chute, no join mark, no rail dropped for an
    // edge goods no longer cross. See `setArmMode`.
    if (c.mode === 'load') return [];
    const out = [];
    // Four beside it, or the one BENEATH it — `armReach`, the same answer the
    // swing pours by. Written out four-ways here, an overhead loader is drawn
    // reaching the shelves either side of the aisle it hangs over and pours
    // into none of them, which is the green-ghost bug on a ceiling.
    for (const s of armReach(c)) {
      if (conveyorAt(L, s.x, s.z, deckOf(c))) continue;
      const takes = (L.shelves ?? []).some((sh) => sh.x === s.x && sh.z === s.z)
        || (L.stations ?? []).some((st) => st.x === s.x && st.z === s.z)
        || (L.bins ?? []).some((bn) => bn.x === s.x && bn.z === s.z)
        || GOODS_PADS.some((k) => isPadAt(L, k, s.x, s.z));
      if (takes) out.push(s);
    }
    return out;
  }

  /**
   * A LINE along one edge of a cell, marking a side goods cross.
   *
   * It was an arrowhead, and what it was buying was direction — out at the
   * neighbour, or back into the loader. The direction is drawn now: the spur's
   * own carriers scroll the way the goods go, along the whole length of the
   * track, which is the same fact said by the thing that is actually moving. So
   * the dart was a second, smaller, static answer to a question the track had
   * already answered, and at this camera two of them on one machine read as
   * clutter rather than as a legend.
   *
   * A bar lying ALONG the edge, which is what is left once the pointing goes:
   * this side is open, goods cross here. Still inside the cell rather than on
   * the line, so it reads as belonging to the machine and not to the boundary —
   * the same split the end pips make against the joins.
   */
  addEdgeChevron(c, n, inward, shift = 0) {
    const dx = Math.sign(n.x - c.x);
    const dz = Math.sign(n.z - c.z);
    // Sideways along the edge, for the case where one edge does both.
    const sx = -dz * shift * 0.15;
    const sz = dx * shift * 0.15;
    const bar = new THREE.Mesh(PATH_GEO, chevronMaterial(inward));
    // Across the way the goods travel, so it lies along the edge it marks.
    bar.scale.set(dx ? 0.05 : 0.3, 0.02, dz ? 0.05 : 0.3);
    bar.position.set(c.x + dx * 0.34 + sx, deckLift(c) + 0.133, c.z + dz * 0.34 + sz);
    bar.renderOrder = 3;
    bar.raycast = NO_PICK;
    this.beltRoot.add(bar);
  }

  /**
   * The sides a loader takes goods OFF, as opposed to the sides it pours into.
   *
   * `armSwing` will lift a loose crate off any side that is not a conveyor and
   * is not the one it faces, so "where does it pick up" is nearly always three
   * sides and marking all of them would be noise — the same call the join marks
   * already make about bare floor. What is marked is a STANDING source: painted
   * ground, which means *goods live here*, and a stockroom shelf, which is the
   * one place a loader may pull stock back off a unit.
   *
   * Both are facts about what you built rather than about where a box happens to
   * be lying this second, which is the line the whole marking layer draws.
   */
  conveyorIntake(L, c) {
    if (c.kind !== 'arm') return [];
    if (c.mode === 'unload') return [];
    const faced = anchorTile(c.x, c.z, c.rot ?? 0);
    const out = [];
    for (const s of armReach(c)) {
      // The side it unloads onto is never a side it lifts from — three sides in,
      // one side out, which is what stops the off-ramp being a loop. A load-only
      // loader has no off-ramp, so there is no loop and the exclusion would just
      // cost it the pad it is pointing at. Mirrors `armSwing`, or the arrow says
      // one thing and the machine does another.
      if (c.mode !== 'load' && s.x === faced.x && s.z === faced.z) continue;
      if (conveyorAt(L, s.x, s.z, deckOf(c))) continue;
      const source = GOODS_PADS.some((k) => isPadAt(L, k, s.x, s.z))
        || (L.shelves ?? []).some((sh) => sh.x === s.x && sh.z === s.z && sh.boh === true);
      if (source) out.push(s);
    }
    return out;
  }

  /**
   * Every spur a loader has: which side, which way goods cross it, and how far
   * the track runs out onto the tile.
   *
   * ONE answer, asked by both halves that draw it — `addConveyorSlats` lays the
   * rails along it, `addConveyorPaths` records it for the crate to travel, and
   * `animateStations` runs the crate down the number this returns. They were two
   * copies of the same arithmetic sitting in different functions, and the
   * failure that makes possible is silent rather than wrong: a crate riding a
   * spur the rails are not quite under reads as the box floating beside the
   * track, which points at the crate and never at the two numbers that drifted.
   *
   * A side can be both a pour and an intake — a pad beside a `both` loader is
   * somewhere it drops overflow AND somewhere it lifts from — so the pour wins,
   * which decides nothing but which way the carriers scroll. WHICH WAY A GIVEN
   * BOX CROSSES comes off the wire (`move.out`), because that is a fact about
   * the swing and not about the shape of the machine.
   */
  conveyorSpurs(L, c) {
    const onUnit = (f) => (L.shelves ?? []).some((u) => u.x === f.x && u.z === f.z)
      || (L.stations ?? []).some((s) => s.x === f.x && s.z === f.z)
      || (L.bins ?? []).some((b) => b.x === f.x && b.z === f.z);
    const box = this.conveyorHousing(c);
    const seen = new Map();
    const add = (s, flow) => {
      const key = `${s.x},${s.z}`;
      if (seen.has(key)) return;
      const dx = Math.sign(s.x - c.x);
      const dz = Math.sign(s.z - c.z);
      // An overhead loader's one side is its OWN square, which is no side at
      // all: it serves the unit beneath it, so the goods go down a chute rather
      // than out along a track. Left in, the zero vector is a spur of length
      // nothing — every slat on it drawn at the cell's own centre, a carrier
      // scrolling in a direction of `0,0`, and an edge bar lying across the
      // middle of the machine. See the chute in `addConveyorPaths`.
      if (!dx && !dz) return;
      seen.set(key, {
        dx,
        dz,
        flow,
        // It starts just UNDER the hood rather than at its edge — a spur that
        // began where the housing ends is a second object butted against the
        // first, which is the join this exists to remove — and it is MEASURED
        // off the housing rather than written down.
        //
        // That is not tidiness. A loader's hood reaches `cross` across the run
        // and `long` along it, and a constant that clears one buries the other:
        // at a flat 0.16 against a hood of 0.31, every slat on a spur into a
        // neighbouring unit was under the machine or under the unit, and what
        // you saw between a loader and the shelf it stocks was bare floor. The
        // track was there and drawn correctly and none of it was anywhere you
        // could look at.
        from: box ? Math.max(0.1, (dx ? box.long : box.cross) - 0.05) : SPUR_FROM,
        // How far depends on what is there, and the split is the tile being
        // OCCUPIED. Onto a pad or bare floor it runs most of the way across, so
        // there is somewhere to stand a crate; into a unit it stops just inside,
        // because a shelf's own mesh fills that square and track drawn under it
        // is track nobody will ever see.
        to: onUnit(s) ? SPUR_UNIT : SPUR_OPEN,
        onUnit: onUnit(s),
      });
    };
    for (const s of this.conveyorPours(L, c)) add(s, 1);
    for (const s of this.conveyorIntake(L, c)) add(s, -1);
    // ...and a SORTER'S OFF-RAMP, which is a spur by every test that matters:
    // goods cross that edge, they take a spur-length of time to do it, and the
    // sim walks the crate along it exactly as it walks one out of a loader.
    //
    // It is the one side of a junction that leaves the network, so without track
    // under it the box rides out over bare floor — the same "crate floating
    // beside the rails" the shared `SPUR_*_REACH` exists to prevent, arriving
    // through the one machine nobody thought of as having a spur.
    if (c.kind === 'sorter' && Number.isInteger(c.reject)) {
      const s = anchorTile(c.x, c.z, c.reject);
      if (!conveyorAt(L, s.x, s.z, deckOf(c))
        && (GOODS_PADS.some((k) => isPadAt(L, k, s.x, s.z)) || isWalkableTile(L, s.x, s.z))) {
        add(s, 1);
      }
    }
    return [...seen.values()];
  }

  /**
   * The spur a transfer used, named by the SIDE the shop says it crossed.
   *
   * It used to be guessed from the lamp — "a machine that took a box was loading
   * onto the line, so the spur it used is an inbound one" — which was wrong in
   * both halves. `did` is `load` when a swing POURED (the box was emptied into
   * something), so the guess asked for an inbound spur on every outbound swing;
   * and a loader with two spurs of the same direction was a coin flip anyway,
   * which is every one of the load bank in a real shop. `move.d` is the offset
   * to the side the goods actually crossed, so there is nothing left to guess.
   */
  static slideFor(slides, move) {
    if (!move?.d) return null;
    return slides.find((sl) => sl.dx === move.d[0] && sl.dz === move.d[1]) ?? null;
  }

  /**
   * How long a crate takes to cross a spur — TRACK SPEED, not a constant.
   *
   * A spur is a length of the same run, so a box on it moves at the same rate a
   * box on any other cell does: `BELT_SECONDS` per tile. A fixed duration made
   * the short spur into a unit and the long one out onto a pad take the same
   * time, so the two read as different machines — and the long one crawled while
   * the belt feeding it did not.
   */
  static slideSeconds(sl) {
    return sl.to * BELT_SECONDS;
  }

  aimKind(L, c, f, isOut) {
    if ((L.shelves ?? []).some((u) => u.x === f.x && u.z === f.z)
      || (L.stations ?? []).some((s) => s.x === f.x && s.z === f.z)
      || (L.bins ?? []).some((b) => b.x === f.x && b.z === f.z)) return 'unit';

    // A conveyor is two completely different answers and the tell is whether it
    // is actually taking goods from this cell.
    //
    // Aimed at a real output there is a join on that very edge already, moving
    // with the aim, so a bar beside it is the same sentence twice — which is
    // what two marks on one edge read as: a join that has gone wrong.
    //
    // Aimed at anything else the rotation does NOTHING, and it has to say so.
    // `conveyorFlow`'s shortcut only fires into a PLAIN BELT that is not
    // pointing back — so a loader turned to face its own feeder, or the loader
    // next to it, has named a side that is not a unit to stock, not an output
    // (the shortcut is refused) and not ground to set a box down on (`armDrop`
    // refuses a conveyor). Every one of those is `dead`, and calling it a line
    // was drawing a connection over a cell where nothing crosses at all.
    if (conveyorAt(L, f.x, f.z, deckOf(c))) return isOut ? null : 'dead';

    // The same pair `armDrop` refuses on, in the same order — a mark drawn from
    // a second opinion about where a box may go is a mark that promises an
    // off-ramp the sim declines to use.
    if (GOODS_PADS.some((k) => isPadAt(L, k, f.x, f.z))
      || isWalkableTile(L, f.x, f.z)) return 'drop';
    return 'dead';
  }

  /**
   * The path goods actually take through every conveyor cell, drawn on the deck.
   *
   * The authored chevron says which way a BELT points, which is the same fact
   * for every cell of a straight run and says nothing at a junction — and on a
   * loader it is not even the flow, since a loader's facing is the shelf it
   * unloads into. So a line of conveyor drew identically whether it was carrying
   * straight through, bending, or dead-ending into a wall, and the one thing you
   * needed to see was the one thing the art could not say.
   *
   * A bar from the incoming edge to the outgoing edge, per cell. Straight
   * through reads as a straight line down the run; a bend reads as a bend; a
   * dead end has no bar at all, which is the loudest thing on the floor
   * precisely because every working cell has one.
   *
   * Derived through `conveyorNext` — the sim's own function, not a second
   * opinion — so a picture of a run that works differently from the run cannot
   * happen.
   */
  addConveyorPaths(L) {
    const cells = conveyorsOf(L);
    if (!cells.length) return;
    // Everything below goes into one group and comes out WELDED — see the weld
    // at the foot of this function for why. `beltRoot` rather than adding
    // straight to `staticRoot` because the merge has to happen after the last
    // piece is laid, and `addConveyorSlats` and `addEdgeChevron` lay some of
    // them; both are reached from here and nowhere else.
    this.beltRoot = new THREE.Group();
    // Its own geometry rather than props.js's `GEO`, which is module-private
    // there — and a shared one rather than one per cell, because a long run is
    // a hundred of these. `staticRoot` is disposed wholesale on every re-flow
    // and `disposeGroup` frees geometry it has not seen before, so this is
    // registered once at module level and never handed to it.
    const geo = PATH_GEO;

    /**
     * Every way OUT of a cell that actually moves goods.
     *
     * BOTH ways out of a sorter — a branch is a join like any other, and
     * leaving it off would make the one piece with a decision to make the one
     * piece whose second line looks unconnected.
     *
     * And a LOADER's consumers, which is the half that was missing and the
     * reason the red dead-end warning could be retired rather than merely
     * disliked. Two different mechanisms wear this one mark: `stepBelts` only
     * ever hands to another conveyor cell — a plain belt facing a shelf is a
     * *terminus*, and the crate sits on it for ever — while a loader is the one
     * kind that pours into what is beside it. So a loader's joins are its
     * shelving, its machines and its skip, and marking only the conveyor ones
     * left the piece whose entire job is handing goods over as the piece that
     * looked unconnected.
     *
     * All four sides rather than the one `rot` names, because that is what
     * `armSwing` does: it pours into every side it can reach in one swing and
     * `rot` only decides who is asked FIRST. Marking the faced side alone would
     * be a picture of a loader serving one shelf while it stocks three.
     *
     * A goods PAD counts too, and it is the one edge here that carries traffic
     * in both directions: `armDrop` sets an unwanted box down on it, and step 2
     * of the same swing LIFTS a loose crate off it — which is how stock gets
     * out of the bay and onto a run at all, with no second kind of machine.
     * That makes a loader against the bay the source of everything downstream
     * of it, and it was the one join in the whole system with nothing at all to
     * say so.
     *
     * What is deliberately NOT marked is bare floor. `armSwing` will lift a
     * crate off any adjacent tile and `armDrop` will set one down on the tile it
     * faces, so "floor" is true of very nearly every loader in every shop — a
     * mark that fires everywhere is one you stop reading, and it would drown the
     * joins that mean something. The line this draws is a STANDING hand-over:
     * one that is a fact about what you built, rather than about where a box
     * happens to be lying this second.
     */
    const poursOf = (c) => this.conveyorPours(L, c);
    // A pour edge and a conveyor join are the same claim — goods cross here —
    // and FOUR loops have to agree about which edges those are: the mark, the
    // deck that has to reach it, the rail that must not be across it, and — in
    // `addConveyorSlats` — the corner's own pair of rails, which is why this
    // moved onto the class. It was a local const, so the corner branch could
    // not ask it and did not: a loader on a bend built a wall across the very
    // side it unloads through.
    // ...and it is down to two readers now, the deck having stopped asking it
    // separately: `outsOf` already carries the pours, so the filler tests one
    // list rather than two half-questions. See the note there.
    const pourEdge = (c, n) => poursOf(c).some((p) => p.x === n.x && p.z === n.z);

    const outsOf = (c) => [
      ...[conveyorNext(L, c), ...conveyorBranches(L, c)]
        .filter((to) => to && conveyorAt(L, to.x, to.z, deckOf(to))),
      ...poursOf(c),
    ];

    /**
     * How high a mark between this cell and that one goes.
     *
     * `deckLift` is a fact about a cell and that is right for every kind but
     * one. A LIFT stands on both storeys — that is what it is for — so the
     * storey its marks belong on is the storey of whatever it is joining, and
     * `deckOf` on the shaft itself answers 0 whichever end you mean. Left as
     * the cell's own, every join a shaft makes with the duct above it was drawn
     * on the floor beside it: a flow pip on the ground pointing at nothing,
     * four metres under the hand-over it is about, which reads as the top of
     * the lift not being wired to the run it is plainly touching.
     */
    const joinY = (c, to) => (c.kind === 'lift' ? deckLift(to) : deckLift(c));

    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      for (const to of outsOf(c)) {
        // Per hand-over rather than per cell, which is the shaft — see `joinY`.
        const dY = joinY(c, to);
        const dx = Math.sign(to.x - c.x);
        const dz = Math.sign(to.z - c.z);

        /**
         * A RISE has no edge, so it gets a riser rather than a coupling.
         *
         * Every other mark in here lies on the line between two cells, because
         * every other hand-over crosses one. Step 9's does not: it is the same
         * square twice, four metres apart, which is the geometry the overhead
         * loader's chute already has. Drawn as a coupling it is `dx` and `dz`
         * both zero — a plate square in the middle of the cell, at the near
         * deck, saying nothing about the storey it is about and reading as one
         * more join on a run that has none there.
         *
         * A COLLAR AND A POST THAT SPANS, and the span is the part that had to
         * be learnt from a screenshot.
         *
         * It was a stub — 0.42 against a 1.9 gap — on the argument `DUCT_CHUTE`
         * makes about the chute: a full shaft stands in the aisle the ceiling
         * was bought to clear. That argument is right about a CHUTE, which is
         * wide enough to post a crate through, and wrong about this, because a
         * mark that stops four fifths short of the thing it connects to is not
         * a restrained version of the connection — it is a stub of pipe on the
         * roof of a machine, and what it says is that nothing joins. So the
         * post reaches deck to deck and pays for it by being thin: `RISER_POST`
         * is a fraction of the chute's width, so you can see the shelf behind
         * it, which is the half of the original argument worth keeping.
         *
         * It goes on `rec.flow` like any other join, so the rise turns amber
         * when the box on it cannot cross. That is the one readout on a
         * conveyor a player has for a jam, and a hand-over left off it is a
         * hand-over that never reports.
         */
        if (!dx && !dz) {
          const far = deckLift(to);
          const lo = Math.min(dY, far);
          const hi = Math.max(dY, far);
          const collar = new THREE.Mesh(geo, flowMaterial(CONVEYOR_LIT.idle));
          collar.scale.set(DUCT_CHUTE, 0.05, DUCT_CHUTE);
          collar.position.set(c.x, dY + (far > dY ? 0.13 : -0.05), c.z);
          collar.renderOrder = 3;
          collar.raycast = NO_PICK;
          this.beltRoot.add(collar);
          const post = new THREE.Mesh(geo, flowMaterial(CONVEYOR_LIT.idle));
          post.scale.set(RISER_POST, Math.max(0.1, hi - lo), RISER_POST);
          post.position.set(c.x, (lo + hi) / 2, c.z);
          post.renderOrder = 3;
          post.raycast = NO_PICK;
          this.beltRoot.add(post);
          const up = this.movingFixtures.get(c.id)
            ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
          up.conveyor = true;
          (up.flow ??= []).push(collar, post);
          this.movingFixtures.set(c.id, up);
          continue;
        }

        // One small square on the JOIN, and nothing down the middle of the cell.
        //
        // The line this replaces ran half a tile per cell and joined up into an
        // unbroken stripe down the whole run, which is a lot of paint for a fact
        // you only need at the joints — and on a straight run it says nothing at
        // all, because every cell of it looks the same. A mark that exists only
        // where two cells HAND OVER is the same information with the redundancy
        // taken out: a bend shows one, a junction shows one per branch, and a
        // dead end is the gap.
        //
        // THE WELL IS GONE, and it is worth saying what it was for. It was a
        // slightly larger, darker plate under the mark, so the eye read a recess
        // with something lit at the bottom of it — a claim about a DECK, and
        // there is no deck any more. Left on a run with none, it is a grey chip
        // lying on your floor at every join, one per cell, which is most of what
        // "there is still a lot of grey on them" was: the mark it framed is
        // three tenths the size and the frame was doing all the shouting.
        //
        // Nothing replaces it. A lit mark on the ground needs no socket to read
        // as lit, because it is the only thing on the cell that glows.

        // THE MARK IS THE READOUT NOW, and it did not cost a mesh to become one.
        //
        // A run of belt could be traced and never READ: a conveyor carrying a
        // box and a conveyor that has been jammed since Tuesday are the same
        // still frame, and the only thing that ever said otherwise was a crate
        // sitting on a cell — which tells you where a box is and nothing about
        // whether it is going anywhere. That matters more here than on any other
        // fixture, because backpressure is the whole texture of a belt: a run
        // that has stopped is *supposed* to stop, so the shop looks correct
        // while doing nothing, and the one signal the player has is invisible.
        //
        // What the colour says is per CELL and lands on the join because a jam
        // is exactly a hand-over that did not happen — the mark between two
        // cells goes amber when the box on the near one cannot cross it. So a
        // box in flight is a green dot travelling down a line of quiet ones, and
        // a jam at the head lights a growing amber tail back down the run,
        // pointing at where it started.
        //
        // THREE SHARED MATERIALS, SWAPPED — never one of its own recoloured,
        // which is what the lamps do and is wrong at this count. `disposeGroup`
        // deliberately frees no mesh materials (they are nearly all the shared
        // `material()` cache), so a material minted per mark is a material
        // leaked per mark on every re-flow — and build mode re-flows on every
        // wall segment of a drag. There are three states and hundreds of marks;
        // pointing each mark at one of three module-level materials costs no
        // allocation, leaks nothing, and makes a state change a pointer swap
        // rather than a `Color.set`. The chevrons below keep `linkMaterial()`:
        // a direction is not a state and never changes.
        // A COUPLING SUNK INTO THE TRACK, rather than a chip lying on top of it.
        //
        // It sat at 0.132 — a full 0.045 above the deck, which is higher than
        // the carriers themselves — so at this camera it read as a tile dropped
        // onto the belt and cast its own little shadow across the rollers. What
        // it is meant to be is the joint between two cells, and a joint is a
        // thing you see IN a machine.
        //
        // So it drops to a hair over the deck top, and it lies ALONG the seam
        // rather than being square: a plate spanning the gap reads as two
        // sections bolted together, where a square pip reads as something set
        // down there. It stays proud by a fraction rather than flush, because
        // flush with a dark deck at this angle is invisible — and this is the
        // one mark on a run that has to be readable, since it is also the flow
        // readout.
        const link = new THREE.Mesh(geo, flowMaterial(CONVEYOR_LIT.idle));
        link.scale.set(dx ? 0.09 : 0.2, 0.012, dz ? 0.09 : 0.2);
        link.position.set(c.x + dx * 0.5, dY + 0.092, c.z + dz * 0.5);
        link.renderOrder = 3;
        // Invisible to the pointer. These sit on top of the decks, so without
        // this every tap on a belt hits a decoration with no fixture id on it
        // and selection silently answers nothing.
        link.raycast = NO_PICK;
        this.beltRoot.add(link);
        // Filed under the cell that HANDS ON, not the one receiving: a cell with
        // three ways out of it owns three marks and they answer together, which
        // is what makes a sorter's branches all light as one box goes through.
        const rec = this.movingFixtures.get(c.id)
          ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
        rec.conveyor = true;
        (rec.flow ??= []).push(link);
        this.movingFixtures.set(c.id, rec);
      }
    }

    // ...and the two ENDS of every run. See `endMaterial` for why these are
    // drawn at all — the join marks say where two cells hand over, and are
    // therefore silent about the one thing that stops a branch working, which is
    // that nothing upstream ever hands into it.
    //
    // Derived from the same `conveyorNext`/`conveyorBranches` pair the joins are,
    // rather than from rotation: a loader's `rot` is the side it unloads into and
    // a sorter's is its branch, so a picture drawn off either would be a picture
    // of a run nobody is playing. Which is the whole reason this is here.
    const fed = new Set();
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      for (const to of [conveyorNext(L, c), ...conveyorBranches(L, c)]) {
        const on = to && conveyorAt(L, to.x, to.z, deckOf(to));
        if (on) fed.add(on.id);
      }
    }
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      // The same `outsOf` the joins are drawn from, which is the whole of what
      // keeps the two marks from contradicting each other: a loader stocking a
      // shelf would otherwise wear a green join AND a "nothing downstream" pip.
      const outs = outsOf(c);
      const box = this.conveyorDeck(L, c);
      // WHICH WAY THIS CELL'S RUN LIES, which is what the offset below is a
      // fraction OF — and it is `conveyorPath` rather than a second derivation,
      // because that function is what the SLATS are laid along. Any other answer
      // is a mark set back along an axis the track it is lying on does not use,
      // which is the sideways overhang below wearing a tidier spelling. It has
      // the two fallbacks this needs already: a tail travels the way it is fed,
      // and a lone cell that is neither falls back to its own facing, which is
      // the direction its groove was drawn at.
      const path = this.conveyorPath(L, c);
      for (const tail of [false, true]) {
        if (tail ? outs.length : fed.has(c.id)) continue;
        // A pip in the middle of the deck rather than on an edge: an end is a
        // fact about the CELL, where a join is a fact about the line between
        // two, and putting both on the edge would read as one more join.
        //
        // ...and set BACK along the run rather than west of centre. The nudge
        // is what keeps a lone cell's two pips from being drawn on top of one
        // another, and along the run it earns a second meaning for free: a head
        // sits before the first cell and a tail after the last one, so the mark
        // points at the gap it is about. Written down as x it did that on an
        // east-west run and pushed the pip SIDEWAYS on a north-south one —
        // `cross` is 0.13 on the shipped belt against a pip 0.16 across, so at
        // 0.11 off centre most of it hung off the track onto the floor.
        //
        // A tail is set back along the way it is FED and a head along the way it
        // hands ON, which are the same axis on a straight run and different ones
        // at a bend — where the leg each pip is about is the one that exists.
        const dir = tail ? path.in : path.out;
        const step = tail ? 0.11 : -0.11;
        const pip = new THREE.Mesh(geo, endMaterial(tail));
        pip.scale.set(0.16, PIP_H, 0.16);
        // SEATED ON THE DECK, and it is worth saying what it was. This was
        // 0.134 — a hair above 0.132, which is the exact height the join marks
        // were moved DOWN from six lines up, for the reason recorded there: at
        // this camera height reads as up-screen displacement, so a mark floating
        // 0.04 over the track is drawn beside the cell it belongs to rather than
        // on it. The joins were fixed and the ends were left behind, which is
        // why the two disagree on a run you can see both on.
        //
        // Measured off the deck rather than written down, because the deck is
        // content — `conveyorDeck` is the same reader the filler and the rails
        // use, so a tier authored at a different height cannot leave this one
        // number pointing at the old one.
        pip.position.set(
          c.x + dir.x * step,
          dY + (box ? box.y + box.h / 2 + PIP_H / 2 : PIP_Y),
          c.z + dir.z * step,
        );
        pip.renderOrder = 3;
        pip.raycast = NO_PICK;
        this.beltRoot.add(pip);
      }
    }

    // ...and WHICH WAY goods cross each working edge of a loader.
    //
    // The join marks say an edge carries goods and stop there, which was fine
    // while every loader did both halves of its job: a pad beside one was both a
    // place it lifted from and a place it set down, so there was no direction to
    // draw. There is now, and a pad edge that only feeds looks exactly like a pad
    // edge that only receives — which is the whole thing the mode switch exists
    // to let you choose between.
    //
    // A chevron rather than a second colour, because the fact is a DIRECTION and
    // colour cannot carry one. Same green as the join it sits inside, for the
    // same reason: this is the join saying more, not a second kind of mark.
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (c.kind !== 'arm') continue;
      const ins = this.conveyorIntake(L, c);
      const outs = this.conveyorPours(L, c);
      // An edge can be BOTH — a pad beside a loader doing both halves of its
      // job is a place it lifts from and a place it sets down. Drawn on the same
      // spot the two arrowheads cross into an X, which is a shape that means
      // neither, so they step aside and sit alongside each other.
      const key = (n) => `${n.x},${n.z}`;
      const shared = new Set(ins.map(key).filter((k) => outs.some((o) => key(o) === k)));
      // ...and never the cell's own square, which is an overhead loader's one
      // side: a bar marking an EDGE has no edge to lie along, so it lands
      // across the middle of the machine. `conveyorSpurs` skips it for the same
      // reason and the chute is what says it instead.
      const side = (n) => n.x !== c.x || n.z !== c.z;
      for (const n of ins.filter(side)) this.addEdgeChevron(c, n, true, shared.has(key(n)) ? -1 : 0);
      for (const n of outs.filter(side)) this.addEdgeChevron(c, n, false, shared.has(key(n)) ? 1 : 0);
    }

    // ...and which way the piece is AIMED, which is the one thing on it the
    // player said out loud and the one thing nothing drew.
    //
    // A loader serves every side it can reach, so the art has no direction in
    // it and the joins above are deliberately all four sides — both of which
    // are right, and together they mean pressing R changed nothing on screen.
    // That is not a missing flourish. `rot` has three separate meanings now
    // (`docs/belts.md`): the unit it stocks FIRST, or — aimed at a conveyor —
    // its output, or — aimed at bare ground — the off-ramp that is the only
    // exit a box nothing wants will ever get. A piece with three meanings and
    // no tell is a piece you rotate at random until the shop behaves.
    //
    // Only the kinds whose flow is DERIVED. A plain belt's `rot` *is* its flow,
    // so the join it hands over on has said this already, and a second mark on
    // the same edge is a second opinion about the same fact.
    //
    // A bar just inside the edge rather than a square on it: a join is a fact
    // about the line between two cells and this is a fact about one of them, so
    // it must not read as one more hand-over. What it is aimed at colours it,
    // because "aimed at nothing" and "aimed at the shelf" are the two answers
    // that look identical from a chair and differ by a whole afternoon.
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (!derivedFlow(c.kind)) continue;
      const f = anchorTile(c.x, c.z, c.rot ?? 0);
      const dx = Math.sign(f.x - c.x);
      const dz = Math.sign(f.z - c.z);

      // `null` is the edge the join already speaks for — see `aimKind`.
      const kind = this.aimKind(L, c, f, outsOf(c).some((o) => o.x === f.x && o.z === f.z));
      if (!kind) continue;

      // ...and no well under this one either — same reason as the join's.
      const bar = new THREE.Mesh(geo, aimMaterial(kind));
      bar.scale.set(dz ? 0.26 : 0.06, 0.02, dz ? 0.06 : 0.26);
      bar.position.set(c.x + dx * 0.33, dY + 0.132, c.z + dz * 0.33);
      bar.renderOrder = 3;
      bar.raycast = NO_PICK;
      this.beltRoot.add(bar);
    }

    // The GAP a narrow deck leaves at a join, filled per edge.
    //
    // A deck is deliberately narrower than its tile across the run — that is
    // what makes a belt look like a belt standing on the floor rather than like
    // painted ground — and it is exactly wrong at a corner or between two runs
    // laid side by side, where the two decks then have a strip of grass between
    // them. It reads as the cells not being joined, which is the one thing the
    // art has to say, and the flow mark on the join cannot argue you out of what
    // you can see.
    //
    // So a cell EXTENDS to the tile edge on any side it hands to or is fed from.
    // Its own colour, read off its own deck, because a run can be three tiers of
    // three colours and a filler in the wrong grey is a patch rather than a
    // belt. Along the run there is nothing to fill: the deck is already a full
    // tile that way.
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      // ...and never a SHAFT. A lift's pan is a full cross at both storeys —
      // the run reaches its edge from any side already — so there is nothing to
      // fill, and a filler here would be measured off the shaft's own `deckOf`,
      // which is 0 whichever end you mean: a stub of track on the floor
      // reaching toward a duct four metres above it.
      if (c.kind === 'lift') continue;
      const deck = this.conveyorDeck(L, c);
      if (!deck) continue;
      // A BEND IS A RIGHT ANGLE, and it went round three shapes before this one.
      //
      // First a full plate over the whole tile, because a deck is a straight
      // rectangle and the path through a corner is a quarter circle: nothing
      // narrower than most of the tile can hold an arc, so the corner got a
      // board and the chamfered rail took the outside back off. Then, once the
      // deck went and a run became a groove, that plate was a solid square of
      // track colour sitting on the floor. Then the groove itself, bent — nine
      // short segments round the same quarter circle the carriers rode.
      //
      // What every one of them was buying is the box travelling a smooth curve,
      // and the box does no such thing: `stepBelts` hands a crate from the
      // middle of one cell to the middle of the next, so it turns the corner in
      // one square step whatever is painted under it. The arc was a drawing of a
      // motion nothing performs, and at this camera what it actually reads as is
      // a wobble in a line of otherwise straight track.
      //
      // So there is no branch here at all now: a bend is the ordinary deck along
      // the way OUT, plus the filler below squaring it off toward the side it is
      // fed from. Two straight legs meeting at a right angle, which is both what
      // the goods do and what everything else in this shop is made of.
      const path = this.conveyorPath(L, c);
      const outs = outsOf(c);
      for (const r of [0, 1, 2, 3]) {
        const n = anchorTile(c.x, c.z, r);
        const dx = Math.sign(n.x - c.x);
        const dz = Math.sign(n.z - c.z);
        // ADJACENCY IS NOT CONNECTION, which is the whole of what these stubs
        // were getting wrong.
        //
        // The test was "is there a conveyor across this edge", and that is exact
        // only while every neighbour is a neighbour IN the run — the same cheap
        // question the rails got wrong before they were retired, and the reason
        // `conveyorJoined` existed at all. It is false four ways that all happen
        // in an ordinary shop: two runs laid side by side down an aisle, a line
        // passing the mouth of a tunnel that ducks under it, a spur that leaves
        // rather than joins, and a dead end standing beside a run it has nothing
        // to do with. Every one of those grew a nub of track poking out of the
        // side of the line toward something it never hands a box to — which
        // reads as an unfinished belt, because a stub of deck going nowhere is
        // exactly what half a belt looks like.
        //
        // So the edge has to be one goods actually CROSS: this cell hands to it,
        // or it hands to this cell. `outs` already carries the pours, which need
        // the filler every bit as much — the join mark sits on the tile edge at
        // 0.5 while the deck only reaches `cross`, so a loader stocking a shelf
        // showed a green square floating on bare floor with a strip of ground
        // between it and the belt it belongs to.
        // NEGATED, and it is the one thing in here that is easy to get backwards:
        // a feeder is stored as the direction goods TRAVEL — neighbour to cell —
        // while `dx`/`dz` is the side the neighbour is on, which is the opposite
        // vector. Compared as-is every filler lands on the far side of the cell
        // from the line feeding it, so a run grows a stub out of the side it has
        // nothing on and loses the one at the join it does. `conveyorHousing`
        // spells the same conversion `{ x: -path.in.x, z: -path.in.z }`.
        const handsTo = outs.some((o) => o.x === n.x && o.z === n.z);
        const fedBy = path.feeds.some((f) => f.x === -dx && f.z === -dz);
        if (!handsTo && !fedBy) continue;
        // Same axis as the deck runs on? Then it already reaches the edge.
        if (r % 2 === deck.rot % 2) continue;
        const grow = 0.5 - deck.cross;
        if (!(grow > 0.001)) continue;
        // AS WIDE AS THE TRACK, not as wide as the tile. This was `deck.long`,
        // which is the span ALONG the run — a full tile — and that was invisible
        // while the thing being extended was a board two thirds of a tile across
        // in its own pale grey: the filler squared the cell off and read as more
        // deck. Against a narrow groove it is a slab 0.37 × 1 of track colour at
        // every cross join, which is most of a tile, and what a run of them looks
        // like is a dark floor with a conveyor drawn on it. Which is exactly the
        // deck coming back — the third time, in the third place, and the only one
        // where the number was right for the shape it was written against.
        const wide = deck.cross * 2;
        const fill = new THREE.Mesh(geo, material(deck.color, 1));
        fill.scale.set(dx ? grow : wide, deck.h, dz ? grow : wide);
        const out = deck.cross + grow / 2;
        fill.position.set(c.x + dx * out, dY + deck.y, c.z + dz * out);
        fill.raycast = NO_PICK;
        this.beltRoot.add(fill);
      }
    }

    /**
     * ...and a SHAFT'S TWO ENDS, walled in but for the portal.
     *
     * The same inversion `COVERED_KINDS` makes about a loader, said about the
     * one piece that stands on both storeys: the sides a box never crosses get
     * panelled, and what is left is the hole it goes in and out through. Open
     * on all four the lift was a cage — you saw straight through the bottom of
     * it into the aisle behind, and nothing anywhere said which way a box was
     * travelling.
     *
     * It is TWO housings rather than one, and that is what makes it worth its
     * own loop: a shaft's ends face different runs on different storeys, so the
     * open side at the top has nothing to do with the open side at the bottom.
     * Neither is `rot`, because a lift has none — see `liftPorts`.
     */
    for (const c of cells) {
      if (c.kind !== 'lift') continue;
      const band = this.liftBands(c);
      if (!band) continue;
      const ports = this.liftPorts(L, c);
      for (const [deck, span] of [[0, band.low], [CEILING, band.high]]) {
        const high = span[1] - span[0];
        if (!(high > 0.02)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (ports[deck].has(`${dx},${dz}`)) continue;
          const wall = new THREE.Mesh(geo, material(CONVEYOR.frame, 1));
          wall.scale.set(dx ? 0.05 : band.span, high, dz ? 0.05 : band.span);
          wall.position.set(c.x + dx * band.face, span[0] + high / 2, c.z + dz * band.face);
          wall.raycast = NO_PICK;
          this.beltRoot.add(wall);
        }
      }
    }

    /**
     * ...and OVERHEAD, the casing — which is the whole of what makes a duct a
     * duct rather than a belt somebody drew in the air.
     *
     * Derived rather than authored, and that is the same argument the corner
     * rails, the loader's chute and the sorter's blades already make, arriving
     * at the one part of a run somebody had reached for a content row to draw.
     * `belt-duct` was a deep copy of the belt catalog row with two glass panes
     * appended, and it was wrong in three ways that a straight east-west run
     * cannot show you. The panes are authored in MODEL space, so they lie along
     * `rot` — and a cell's rotation is not the way the goods go through it, so
     * every bend in the shop was glazed across its own mouth and open along the
     * side nothing crosses. It was one PIECE, so it only ever existed for the
     * one kind somebody made a copy for: a loader, a junction or a tunnel mouth
     * hung overhead had no glass at all, which is what a T reads as when the
     * duct either side of it is enclosed and it is not. And it was OPT-IN, so a
     * plain belt laid on the ceiling — the obvious press, off the same tool —
     * came out bare.
     *
     * So the casing is a fact about the STOREY and the flow, not about which
     * row you picked: every overhead cell is glazed on every side goods do not
     * cross, off the same in/out/branch/pour set the loader's own panels are
     * cut from. A straight run gets two panes, a bend gets the two on its
     * outside, a T gets one, and the row you build with is back to being about
     * how fast the thing is.
     */
    for (const c of cells) {
      if (deckOf(c) !== CEILING) continue;
      const deck = this.conveyorDeck(L, c);
      if (!deck) continue;
      const dY = deckLift(c);
      const path = this.conveyorPath(L, c);
      const open = new Set();
      for (const o of outsOf(c)) open.add(`${Math.sign(o.x - c.x)},${Math.sign(o.z - c.z)}`);
      // NEGATED, the same conversion the filler above spells out: a feeder is
      // stored as the direction goods travel, and the side it is on is the
      // opposite vector. Read as-is, every duct is glazed shut at the end it is
      // fed from and open along a flank nothing uses.
      for (const f of path.feeds) open.add(`${-f.x},${-f.z}`);
      // From the deck top up, measured off the model rather than written down
      // — a run can be three tiers of three shapes, and a pane sized to a
      // remembered track is glass with daylight under it the day somebody
      // authors a thicker one.
      const base = deck.y + deck.h / 2;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (open.has(`${dx},${dz}`)) continue;
        const pane = new THREE.Mesh(geo, material(CONVEYOR.glass, GLASS));
        pane.scale.set(dx ? DUCT_PANE : 1, DUCT_WALL, dz ? DUCT_PANE : 1);
        pane.position.set(c.x + dx * DUCT_HALF, dY + base + DUCT_WALL / 2, c.z + dz * DUCT_HALF);
        // Invisible to the pointer, exactly as every other mark on a run is:
        // these stand between the camera and the cell, so a ray that stopped on
        // one would hit a mesh with no fixture id and the press would silently
        // select nothing.
        pane.raycast = NO_PICK;
        this.beltRoot.add(pane);
      }

      /**
       * ...and the CHUTE, which is the one thing a duct does that a floor run
       * cannot and the one thing nothing drew.
       *
       * An overhead loader reaches exactly one cell — the one underneath it
       * (`armReach`) — so the goods leave DOWNWARDS, and every mark this file
       * has for a hand-over is a mark on an EDGE. There is no edge: the loader
       * and the shelf it stocks are the same square, four metres apart. What
       * that leaves is a machine in a duct with no join mark, no chevron and no
       * track on any of its four sides, which is exactly what an overhead
       * loader that is not wired to anything looks like — and it is the piece
       * the whole storey exists for.
       *
       * A collar rather than a tube all the way to the floor. The drop is most
       * of a wall's height, so a full shaft is a column standing in the aisle
       * you just bought the ceiling to clear, and at this camera it would hide
       * the shelf it is pouring into. A stub hanging under the deck says which
       * way the goods go and leaves the aisle empty, the same call
       * `SPUR_UNIT_REACH` makes about a track that would otherwise be drawn
       * under a shelf nobody can see through.
       */
      if (c.kind === 'arm' && this.conveyorPours(L, c).length) {
        const collar = new THREE.Mesh(geo, material(CONVEYOR.frame, 1));
        collar.scale.set(DUCT_CHUTE, DUCT_DROP, DUCT_CHUTE);
        collar.position.set(c.x, dY + deck.y - DUCT_DROP / 2, c.z);
        collar.raycast = NO_PICK;
        this.beltRoot.add(collar);
      }
    }

    this.addConveyorSlats(L, geo);

    // NO RAILS. The kerb retired with the deck it was the lip of.
    //
    // There was a rail on every edge of a run that had no conveyor across it —
    // two unbroken sides down a straight, chamfered corners, a cap at the end —
    // and it was the whole of what made a line of cells read as one belt rather
    // than as a row of boxed slabs. That argument was about a DECK: a board
    // standing proud of the floor needs an edge, or it is a slab with nothing
    // holding the goods on.
    //
    // A track set into the ground has no edge to draw. What the rail became the
    // moment the slab came off is a grey kerb running round everything you
    // built, which is the deck's outline surviving the deck — the same thing
    // `fill` was and the same thing the corner plate was, in the third place it
    // was hiding. The groove IS the line now; it needs no frame to say where it
    // goes.

    // ...and the output shaft. A loader unloads SIDEWAYS, out of the run, and
    // until now nothing said where — you had a turntable spinning on a belt and
    // no way to tell which of its four neighbours it was actually feeding, or
    // whether it had found one at all.
    //
    // So it reaches. A shaft runs from the middle of the loader out over the
    // thing it stocks, which makes the connection a physical object rather than
    // a rule you have to hold in your head: point a loader at a shelf and you
    // can see it touching the shelf.
    //
    // Derived from what is actually beside it — the unit it FACES first, since
    // that is the one the player said out loud, then any other. That is the same
    // order `armSwing` pours in, deliberately: a shaft reaching somewhere the
    // goods do not go is worse than no shaft at all.
    // The sorters: a blade over the hub, lying across the mouth of the branch.
    //
    // Which sides those are come from `conveyorBranches` rather than the model,
    // for the reason the loader's chute does: the deck is turned by the FLOW, so
    // a blade authored in model space would point wherever the run happened to
    // be running. It is the one part of a sorter you can read from across the
    // shop, and without it the piece is a belt cell with a hub on it.
    // THE SIDES A BOX NEVER CROSSES GET WALLED IN, and that is the inversion.
    //
    // This cut a mouth on every carrying side, which was the same picture drawn
    // from the wrong end: openings painted onto a solid box, and a crate that
    // had to be hidden because it would have gone through the wall. The machine
    // stands on legs now, so the gap under the hood is already an opening on
    // all four sides — what it needs is the three-quarters of it that nothing
    // uses closed off, or it is a table.
    //
    // Derived rather than authored, for the reason the chute and the blades
    // already are: which sides carry goods is a fact about the RUN and about
    // what is standing next to it, and a panel placed in model space would wall
    // whichever side the piece happened to be drawn facing. Three sources, and
    // they are the three ways a box can leave a cell — the line in, the line out
    // and every branch, plus every unit a loader pours into.
    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (!COVERED_KINDS.has(c.kind)) continue;
      const box = this.conveyorHousing(c);
      if (!box) continue;
      const path = this.conveyorPath(L, c);
      const open = new Set();
      for (const s of [
        { x: -path.in.x, z: -path.in.z },
        path.out,
        ...conveyorBranches(L, c).map((b) => ({ x: Math.sign(b.x - c.x), z: Math.sign(b.z - c.z) })),
        // EVERY SPUR, which is both directions. This was `conveyorPours` alone,
        // and a pour is only half of what crosses a loader's sides: the side it
        // LIFTS from — a pad, a stockroom board — is a side goods cross every
        // bit as much, and it was being walled shut. So a load-only loader was a
        // sealed box with a green arrow painted on the panel, and the crate it
        // was pulling in came through the wall.
        ...this.conveyorSpurs(L, c).map((q) => ({ x: q.dx, z: q.dz })),
      ]) {
        if (s && (s.x || s.z)) open.add(`${s.x},${s.z}`);
      }
      // From the deck up to the underside of the hood, which is the whole of
      // what the legs left open. Measured off the housing rather than written
      // down, exactly as the housing itself is measured off the model — a wall
      // sized to a remembered hood is a panel with daylight over it the day
      // somebody draws a taller machine.
      const under = box.y - box.h / 2;
      const high = under - BELT_TOP;
      if (!(high > 0.02)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (open.has(`${dx},${dz}`)) continue;
        const face = dx ? box.long : box.cross;
        const wall = new THREE.Mesh(geo, material(CONVEYOR.frame, 1));
        wall.scale.set(dx ? 0.06 : box.cross * 2, high, dz ? 0.06 : box.long * 2);
        wall.position.set(c.x + dx * face, dY + BELT_TOP + high / 2, c.z + dz * face);
        wall.raycast = NO_PICK;
        this.beltRoot.add(wall);
      }

      // A MARK PER SIDE ON THE ROOF, rather than one lamp in the middle of it.
      //
      // There was a beacon here — one machine, one light — and before that a
      // lamp per chute. The beacon is the better answer to "is this thing
      // working" and it is the wrong answer to the question people actually ask
      // of these two pieces, which is *which way did my box go*. A single dot
      // has one bit to say it with: a loader that poured left and a loader that
      // poured right are the same green dot, and a junction — the one piece in
      // the shop whose whole job is choosing between ways out — reported its
      // choice by lighting up in the middle.
      //
      // So the roof carries a bar per side, and the one that lights is the side
      // the goods crossed. It reads at a glance across the shop and it is the
      // one readout on a conveyor whose meaning does not depend on remembering
      // which colour meant what.
      //
      // ONLY THE SIDES GOODS CAN CROSS get one, off the same `open` set the
      // walls above are cut from. A bar over a panelled side is a light for a
      // path that does not exist — the "tier that changes no number" trap said
      // about a readout — and worse, it makes the two machines look identical
      // from above when the whole point is telling their shapes apart.
      //
      // Its own material per bar, for `linkMaterial`'s reason: `material()` is a
      // cache keyed by colour, so recolouring through it would turn every cream
      // thing in the shop green. And each bar goes on `rec.moving`, which is
      // what `weld` is told to keep — welded, it would be drawn in exactly the
      // right place, merged into a batch by vertex colour, and never change
      // again, which reads as a machine that has stopped reporting.
      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      rec.conveyor = true;
      // Which way the run itself leaves, so a box that was merely PASSED ON has
      // a side to light too. Without it a loader that refused a box says nothing
      // at all, which is indistinguishable from a loader nothing reached.
      rec.outSide = path.out && (path.out.x || path.out.z)
        ? { dx: Math.sign(path.out.x), dz: Math.sign(path.out.z) } : null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!open.has(`${dx},${dz}`)) continue;
        const face = dx ? box.long : box.cross;
        const pip = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
          color: new THREE.Color(LAMP_IDLE), flatShading: true,
        }));
        // Along the edge it sits on, so a bar reads as belonging to that side
        // rather than as a stud dropped on the roof.
        pip.scale.set(dx ? 0.1 : box.long * 1.1, 0.04, dz ? 0.1 : box.cross * 1.1);
        pip.position.set(c.x + dx * face * 0.66, dY + box.y + box.h / 2 + 0.02, c.z + dz * face * 0.66);
        pip.raycast = NO_PICK;
        this.beltRoot.add(pip);
        (rec.pips ??= []).push({ dx, dz, mesh: pip });
        rec.moving.push({
          // Nothing to animate — a bar that pulsed would pulse on every open
          // side of a busy machine, which is the single dot's problem again in
          // four places. What it is on this list for is `weld`.
          mesh: pip,
          motion: { kind: 'none' },
          pos: pip.position.clone(),
          rot: 0,
          scale: pip.scale.clone(),
          axis: null,
          arm: null,
          pivot: null,
          phase: 0,
        });
      }
      this.movingFixtures.set(c.id, rec);
    }

    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (c.kind !== 'sorter') continue;
      // One blade per way out, because a junction where four lines meet uses all
      // four and a single blade would be a picture of a T standing in a cross.
      for (const br of conveyorBranches(L, c)) {
        const dx = Math.sign(br.x - c.x);
        const dz = Math.sign(br.z - c.z);
        // A blade is a slope a crate is pushed off SIDEWAYS by, so the one
        // branch it cannot describe is the one that goes straight up. Drawn
        // anyway it is a bar over the middle of the hub at `atan2(0, 0)` — a
        // diverter pointing east on a junction that diverts nothing east, which
        // is the marking layer's own green-ghost rule. The riser above is what
        // says this branch exists.
        if (!dx && !dz) continue;
        const blade = new THREE.Mesh(geo, material(CONVEYOR.rail, 1));
        blade.scale.set(0.5, 0.06, 0.09);
        blade.position.set(c.x + dx * 0.2, dY + 0.22, c.z + dz * 0.2);
        // Across the branch at forty-five degrees, which is what a diverter is:
        // the crate meets a slope and is pushed off the line rather than stopped.
        blade.rotation.y = -(Math.atan2(dz, dx) + Math.PI / 4);
        blade.raycast = NO_PICK;
        this.beltRoot.add(blade);
      }
    }

    for (const c of cells) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (c.kind !== 'arm') continue;
      /**
       * WHERE THE SPUR GOES, so the REAL crate can be moved along it.
       *
       * No mesh. There is nothing left to build here: a spur IS track, and
       * `addConveyorSlats` lays it out of the same authored slats as every other
       * leg of the run. What was here instead was a second conveyor — its own
       * bed, its own hand-made carriers, its own colours, spacing and clock —
       * standing an inch from the real one and free to disagree with it.
       *
       * Which leaves this loop holding a description rather than geometry: the
       * side, and how far along it the goods travel. `animateStations` runs the
       * crate down that, and `stepLeaving` runs down the one the shop has
       * already forgotten.
       *
       * The MACHINE's own square is the origin, not wherever the crate was. A
       * transfer is an L — down the run into the middle of the loader, then out
       * along the spur — and the first leg is `stepBelts`' hand-off, which has
       * already put the box on this cell's centre by the time a swing happens.
       * Offsetting from the crate's live position instead adds the two legs
       * together into a diagonal, because the box is still easing along the run
       * while the spur pulls it sideways.
       */
      const spurs = this.conveyorSpurs(L, c);
      if (!spurs.length) continue;

      // ...on a DECK of its own, in the run's own colour, ending in a PAD.
      //
      // The filler above squares a cell off to its own tile edge and stops
      // there, which is right for everything that is a cell. A spur crosses the
      // boundary, so past 0.5 its slats were bars lying on the shop floor —
      // which reads as track that has come apart rather than as track.
      //
      // And it does not carry on as track to the very end, because the end is
      // not more track: it is where the goods LEAVE. Run the carriers all the
      // way and a spur is a belt that stops for no reason in the middle of a
      // shelf — the one thing on it you cannot see is the thing it is for. The
      // last stretch is a plate instead, a shade lighter and standing slightly
      // proud, which is the same sentence a loading dock makes: track up to
      // here, and then off. A box drawn sitting on it reads as waiting to be
      // taken rather than as parked on a conveyor that has failed.
      const deck = this.conveyorDeck(L, c);
      if (deck) {
        for (const sp of spurs) {
          const near = deck.cross;
          const wide = deck.cross * 2;
          // Track stops where the landing square starts. Into a UNIT there is no
          // square — the goods go inside the thing, so the rails run to the end
          // and are swallowed by it, which is the picture that wants no marking.
          const railTo = sp.onUnit ? sp.to : Math.max(sp.from, sp.to - SPUR_PAD);
          const len = railTo - near;
          if (len > 0.01) {
            const mid = near + len / 2;
            const bed = new THREE.Mesh(geo, material(deck.color, 1));
            bed.scale.set(sp.dx ? len : wide, deck.h, sp.dz ? len : wide);
            bed.position.set(c.x + sp.dx * mid, dY + deck.y, c.z + sp.dz * mid);
            bed.raycast = NO_PICK;
            this.beltRoot.add(bed);
          }
          if (sp.onUnit) continue;

          // THE LANDING SQUARE, drawn as a BORDER and not a plate.
          //
          // Four bars round the tile centre with the shop's own floor inside
          // them, so what you see is a crate standing on the ground with the
          // square marked round it. A solid plate was the first go and it is the
          // thing to avoid: a slab under a box reads as one more length of belt
          // the box has stopped on, which says the opposite of what this is for.
          // It is the same argument `addPadMarks` makes about the yard — a pad
          // is paint on the floor, not furniture.
          const cx = c.x + sp.dx * sp.to;
          const cz = c.z + sp.dz * sp.to;
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const bar = new THREE.Mesh(geo, material(CONVEYOR.track, 1));
            bar.scale.set(
              ox ? SPUR_PAD_BAR : SPUR_PAD * 2 + SPUR_PAD_BAR,
              deck.h,
              oz ? SPUR_PAD_BAR : SPUR_PAD * 2 + SPUR_PAD_BAR,
            );
            bar.position.set(cx + ox * SPUR_PAD, dY + deck.y, cz + oz * SPUR_PAD);
            bar.raycast = NO_PICK;
            this.beltRoot.add(bar);
          }
        }
      }

      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      rec.conveyor = true;
      // The rails laid along each spur ride WITH its descriptor, so the one
      // thing that knows a transfer is happening drives both the crate and the
      // track it is on. Two lists looked up separately is how they came to
      // disagree in the first place.
      rec.slides = spurs.map((sp) => ({
        ...sp, cx: c.x, cz: c.z, rails: rec.spurRails?.get(`${sp.dx},${sp.dz}`) ?? [],
      }));
      this.movingFixtures.set(c.id, rec);

      // The COLLAR AND STRAPS went with the cabinet they clamped to, and the
      // light moved to the roof — see `beacon` above. One machine, one readout:
      // there was a lamp per chute here, so a loader serving three units wore
      // three of them and they all said the same thing.
    }

    // One draw per COLOUR instead of one per bar.
    //
    // Everything above is ground decoration a few triangles wide — a dart, a
    // join pip, a rail, a slat — and a shop with fifty conveyor cells was laying
    // six hundred of them as separate objects. That is the whole cost: measured
    // on a real save, `renderer.render` was 5.16ms of a 5.64ms frame, ~92% of
    // the tab's CPU, at roughly 3.8us per draw call. The triangles are nothing —
    // 682 meshes carrying 7,800 triangles between them — so this is not a
    // geometry problem and no amount of simplifying the art would have touched
    // it. They are on 15 materials, so welding is 682 draws down to 15.
    //
    // Affordable because it is paid on a re-flow rather than per frame, which is
    // the same argument `weld` is called on stock and crops for.
    //
    // The two things that MOVE are held out by name, which is the failure this
    // whole call has to get right: welded, a slat would be drawn in exactly the
    // right place and never scroll again, and a loader's lamp would never pulse.
    // Both read as a machine that has broken rather than as a renderer that has.
    // Taken off `movingFixtures` rather than from a list built here, because
    // `addConveyorSlats` registers the slats and the loop above registers the
    // lamps — two places, one truth, and a third one added later would be
    // silently welded solid.
    // A lamp on each tunnel mouth, lit while there is a box in it.
    //
    // The same readout a loader has and for the same reason: a mouth with a
    // crate underground and a mouth with nothing in it are the same still
    // frame — the box is not drawn, by design, so without this the one piece
    // whose contents you cannot see is also the one piece with nothing to say.
    // Drawn here rather than authored on the model because it has to be its own
    // material: `material()` is a cache keyed by colour, so recolouring through
    // it would light every cream thing in the shop.
    for (const c of conveyorsOf(L)) {
      // Overhead cells hang at `CEILING_Y`, so every mark drawn for one has to
      // rise with it. These y values are literals measured off the deck — the
      // deck moved, and a mark that did not is a chevron on the floor under a
      // duct, which reads as the run having been laid downstairs.
      const dY = deckLift(c);
      if (c.kind !== 'under') continue;
      const lamp = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        color: new THREE.Color(LAMP_IDLE), flatShading: true,
      }));
      lamp.scale.set(0.14, 0.05, 0.14);
      lamp.position.set(c.x, dY + 0.36, c.z);
      lamp.raycast = NO_PICK;
      this.beltRoot.add(lamp);
      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      rec.conveyor = true;
      // What decides the COLOUR, since a mouth has no `armSaid` to report: it
      // either has a box in it or it has not, and that is the whole readout.
      rec.mouth = true;
      (rec.lamps ??= []).push(lamp);
      rec.moving.push({
        mesh: lamp,
        motion: { kind: 'pulse', hz: 1.6, amount: 0.45 },
        pos: lamp.position.clone(),
        rot: 0,
        scale: lamp.scale.clone(),
        axis: null,
        arm: null,
        pivot: null,
        phase: 0,
      });
      this.movingFixtures.set(c.id, rec);
    }

    const moving = new Set();
    for (const rec of this.movingFixtures.values()) {
      if (!rec.conveyor) continue;
      // Three lists, and every one of them has to be named here. `weld` freezes
      // whatever is left, and a frozen thing is drawn in exactly the right place
      // and never moves again — which reads as the machine having broken rather
      // than as the weld having worked. `spur` and `slides` are the two that
      // were added after this loop was written; the trap is that leaving one out
      // fails silently and looks like a bug in the animation.
      for (const m of rec.moving ?? []) moving.add(m.mesh);
      // ONE list now. `spur` was a second one and is gone: a spur's carriers are
      // ordinary slats on `rec.moving`, in the instanced batch with every other
      // slat in the shop, which is what took this trap away rather than guarding
      // against it. `slides` is deliberately not here either — it holds no mesh
      // at all, only the direction and length of a spur. What travels one is the
      // real crate, which lives in `actorRoot` and was never a weld candidate.
    }
    // `weld` re-hangs what it keeps by decomposing the world matrix into the
    // group's own space, and `beltRoot` is an untransformed child of
    // `staticRoot` — so a kept mesh comes out at the position it went in at, and
    // the `pos`/`scale` clones the motion entries already took stay correct.
    const welded = weld(this.beltRoot, moving.size ? (o) => moving.has(o) : null);
    this.staticRoot.add(welded);
    this.beltRoot = null;

    // ...and into the BAKED system, which is the half a conveyor was never in.
    //
    // The shop has two lightings — eight real lamps for what moves, and a tint
    // baked into the vertices for everything that does not, on a layer the real
    // ones cannot reach so nothing is lit twice. Belts were in neither: they are
    // static, but nothing ever registered them, so they sat on layer 0 being lit
    // by the pool. What that looks like is a shop that goes dark at closing time
    // with the conveyors still bright in it, which reads as the belts glowing.
    //
    // Per vertex rather than per group, because a run is not a fixture — see
    // `bakeMesh`. The lamps are kept OUT of it: a loader's light is the one part
    // of a conveyor that is supposed to be brighter than the room.
    for (const m of welded.children) {
      if (!m.isMesh || moving.has(m)) continue;
      this.bakedMeshes.push(m);
      this.bakeMesh(m);
      m.layers.set(BAKED_LAYER);
    }
  }

  setBuildGhost(spec) {
    if (!spec || !this.storeLayout) {
      this.clearBuildGhost();
      return null;
    }
    const verdict = canPlace(this.storeLayout, spec, { ignoreId: spec.moveId ?? null });
    // Three answers, so the cache key has to carry which one — an amber ghost
    // and a green one are the same `ok`.
    const state = verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no';
    // Which piece is armed is in the key too, or arming a second shelf design
    // would leave the first one's ghost under your pointer until you moved to
    // another tile — the exact bug this whole change exists to remove.
    const drawnAs = `${spec.piece ?? ''}/${spec.variant ?? ''}/${spec.station ?? ''}/${spec.tier ?? 1}`;
    const key = `${spec.kind}:${spec.x}:${spec.z}:${spec.rot}:${state}:${drawnAs}`;
    if (this.buildGhostKey === key) return verdict;
    this.buildGhostKey = key;
    this.clearBuildGhost(true);

    const def = FIXTURES[spec.kind];
    if (!def) return verdict;
    // Every side somebody has to stand on, not just the one rotation points at.
    // Asked in fixture-local coordinates (0,0) because the ghost group is what
    // gets positioned — see below.
    // In the ghost group's own frame, which is centred on the block — so the
    // working spots, which `workSpots` gives in tiles off the min corner, have
    // to come back the other way by the same half-tile the group was moved.
    const span = sizeOf(spec.kind);
    const back = (span - 1) / 2;
    const spots = [
      ...workSpots(spec.kind, -back, -back, spec.rot ?? 0),
      // ...and, for the two kinds that move goods rather than serve people,
      // which way they move them. A belt previewed without this is a tile: the
      // one fact it exists to express is the one the preview could not say.
      ...flowSpots(spec.kind, -back, -back, spec.rot ?? 0),
    ].map((s) => ({ dx: s.x, dz: s.z, role: s.role }));
    // The actual model of the actual piece, resolved exactly the way the
    // standing fixture is (`fixtureModel`) — one resolver, so the ghost and the
    // thing it becomes cannot disagree about which shelf you picked.
    const model = this.fixtureModel(spec);
    const piece = this.pieceOf(spec);
    // A prop has no tile, so there is no tile style to size its ghost from. It
    // gets a low pad instead — enough to read as "a thing lands here" without
    // pretending to be the shape of whatever piece you picked.
    const look = FIXTURE_LOOK[spec.kind] ?? { h: 0.5, color: TILE_STYLE[T.FLOOR]?.color };
    // Where on its own 0..1 the ghost draws. A watcher's is the shop's number
    // rather than its tier — the same swap `addFixtureProps` makes, for the same
    // reason it makes it, and it has to be made here too or you would be shown a
    // dark sign and hang up a lit one. Its last-known value, not a live read:
    // the ghost follows the pointer at 60fps and the shop answers at 10.
    const t = piece?.signal
      ? (this.signals[piece.signal] ?? 1)
      : tierProgress(spec.tier ?? 1, piece?.tiers?.length ?? 1);
    const g = buildFixtureGhost({
      model,
      t,
      rot: rot4(spec.rot ?? 0),
      // The cage is sized to the model when there is one, so a low counter is
      // not caged like a full-height freezer. A plot's look is flat, and a ghost
      // you cannot see is not a preview — hence the floor either way.
      height: Math.max(model ? modelHeight(partsAt(model, t)) : look.h, 0.12),
      verdict: state,
      spots,
      // How many cells the cage has to cover. A 2x2 previewed as one tile is a
      // ghost that promises a square and takes four — and the three it does not
      // draw are exactly the ones a refusal would be about.
      span,
    });
    // Hung things preview where they will hang. A ghost on the floor under a
    // pendant answers the wrong question — the floor is not what you are aiming
    // at, and every cell in the room looks equally available from down there.
    const gm = footprintMid(spec.kind, spec.x, spec.z);
    g.position.set(gm.x, def.at === 'ceiling' ? CEILING_Y : 0, gm.z);
    this.actorRoot.add(g);
    this.buildGhost = g;
    return verdict;
  }

  /**
   * Ring the fixture you've picked up but not yet set down. It deliberately
   * stays where it is until you choose a destination — so it needs a marker,
   * or "lifted" and "not lifted" look identical.
   */
  syncLifted(me) {
    const id = me?.holding?.id ?? null;
    if (this.liftedKey === id) return;
    this.liftedKey = id;
    if (this.liftedRing) {
      this.actorRoot.remove(this.liftedRing);
      disposeGroup(this.liftedRing);
      this.liftedRing = null;
    }
    if (!id || !this.storeLayout) return;

    // `fixturesIn` rather than a list written out here, which is the fix for a
    // bug this had already: `bins` was missing, so lifting a skip drew no ring
    // and the one thing telling you the shop had picked it up was absent. Every
    // new kind would have arrived the same way, silently.
    const f = fixturesIn(this.storeLayout).find((o) => o.id === id);
    if (!f) return;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.07, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xffd66b, transparent: true, opacity: 0.9, depthTest: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 12;
    ring.position.set(f.x, 1.5, f.z);
    this.actorRoot.add(ring);
    this.liftedRing = ring;
  }

  /**
   * A chevron over everything that would take what you are carrying.
   *
   * The list is the server's (`takers` on your own player) — see `stockTargets`
   * for why the shop answers this rather than the client working it out. All
   * this does is find each one and float a pip over it.
   *
   * Keyed by fixture id and rebuilt only when the *set* changes, because the
   * set is stable for a whole armful and this runs ten times a second. Heights
   * are re-read every sync all the same: a shelf that fills up as you stock it
   * drops out of the list, and one you moved has to take its pip with it — the
   * same reason `syncShelves` re-reads positions rather than trusting them.
   */
  syncStockTargets(me) {
    this.stockPips ??= new Map();
    const want = new Set(me?.takers ?? []);
    const key = [...want].sort().join(',');

    if (key !== this.stockPipKey) {
      this.stockPipKey = key;
      for (const [id, pip] of this.stockPips) {
        if (want.has(id)) continue;
        this.actorRoot.remove(pip);
        disposeGroup(pip);
        this.stockPips.delete(id);
      }
      for (const id of want) {
        if (this.stockPips.has(id)) continue;
        const pip = buildTargetMarker('stock');
        // Offset so a shop full of them doesn't bob in lockstep, which reads as
        // one flashing object rather than several separate signposts. The same
        // trick the thought bubbles use, off the same kind of stable number.
        pip.userData.phase = (id.length * 1.7 + id.charCodeAt(id.length - 1)) % 6.28;
        this.actorRoot.add(pip);
        this.stockPips.set(id, pip);
      }
    }

    // Position every sync, not only on the ones that rebuilt: what a pip sits
    // over can change height (a tier bought) or move (a unit carried across the
    // shop) without the set of ids changing at all.
    for (const [id, pip] of this.stockPips) {
      const f = this.allFixtures().find((o) => o.id === id);
      if (!f) { pip.visible = false; continue; }
      pip.visible = true;
      pip.position.set(f.x, this.fixtureHeight(f), f.z);
    }
  }

  /**
   * ...and the same signposts for the ones that are off the edge of the screen.
   *
   * Per frame rather than per sync, and not because it looks better: the camera
   * is the input. A pip is placed when the *set* changes, but which of them are
   * visible changes when you pan, zoom, spin the view or simply walk — none of
   * which touches the snapshot, so a version of this that ran on state would
   * leave arrows pointing off a screen the shelf is now in the middle of.
   *
   * A pool that is hidden rather than a map that is built and torn down. There
   * is a hard cap on how many are ever drawn, they carry no identity — an arrow
   * is a *direction*, and which shelf is at the end of it is the one thing this
   * marker deliberately cannot say — and this runs sixty times a second, which
   * is the wrong rate to be minting and disposing meshes at.
   */
  syncEdgeArrows(now) {
    this.edgeArrows ??= [];
    let used = 0;

    const el = this.renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (this.stockPips?.size && w > 0 && h > 0) {
      // Everything below is worked out in PIXELS from the middle of the view,
      // and that is the one decision here worth keeping. The obvious space is
      // NDC — it is what `project` hands back — but NDC's two axes are different
      // numbers of pixels each on any window that is not square, so a margin, a
      // gap between two arrows and "back off by half an arrowhead" all come out
      // wider one way than the other. In pixels each of those is the one number
      // it was written as.
      const hx = Math.max(20, w / 2 - EDGE_MARGIN);
      const hy = Math.max(20, h / 2 - EDGE_MARGIN);
      // One world unit is this many pixels at the current zoom: an orthographic
      // camera shows `top - bottom` world units over `h` pixels, divided by the
      // zoom. This is what keeps an arrow the same size on screen however far
      // out the view is — the pips it stands in for do the opposite, because
      // they belong to something in the shop and this belongs to the frame.
      // `this.ortho` and not `this.camera`: a perspective camera has no `top`,
      // so in first person this would be NaN over NaN and every arrow in the
      // shop would be placed at the origin of the frame. The ortho zoom is
      // pinned at its top rung while you are in there (`setFirstPerson`), so
      // what this answers is a constant — which is the right answer anyway,
      // since an arrow riding the edge of the frame belongs to the frame.
      const world = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;

      const off = [];
      for (const pip of this.stockPips.values()) {
        if (!pip.visible) continue;
        // Aimed at the chevron rather than at the fixture's feet, or a shelf at
        // the very bottom of the view raises an arrow for a pip that is still
        // perfectly visible above it.
        const v = EDGE_V.set(pip.position.x, pip.position.y + 0.62, pip.position.z)
          .project(this.camera);
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
        const dx = v.x * (w / 2);
        const dy = -v.y * (h / 2);
        if (Math.abs(dx) <= hx && Math.abs(dy) <= hy) continue;
        // How far out, as a proportion of the frame. The nearest win the cap:
        // a shelf two screens away is not the one you were about to walk to.
        const d = Math.max(Math.abs(dx) / hx, Math.abs(dy) / hy);
        off.push({ dx, dy, d, phase: pip.userData.phase ?? 0 });
      }
      off.sort((a, b) => a.d - b.d);

      for (const t of off) {
        if (used >= EDGE_CAP) break;
        // Onto the frame: shrink the vector until it touches whichever side it
        // was going to leave through first.
        const k = Math.min(hx / Math.abs(t.dx || 1e-6), hy / Math.abs(t.dy || 1e-6));
        const ex = t.dx * k;
        const ey = t.dy * k;
        if (this.edgeArrows.some((a, i) => i < used
          && Math.hypot(a.userData.ex - ex, a.userData.ey - ey) < EDGE_APART)) continue;

        let arrow = this.edgeArrows[used];
        if (!arrow) {
          arrow = buildEdgeArrow();
          this.actorRoot.add(arrow);
          this.edgeArrows[used] = arrow;
        }
        used += 1;
        arrow.visible = true;
        arrow.userData.ex = ex;
        arrow.userData.ey = ey;

        // The same beat the pip bobs to, off the same per-target phase so a row
        // of them doesn't pulse in lockstep — and along the way it points rather
        // than upward, because at the frame "up" is a direction the arrow has an
        // opinion about, and one bobbing across its own heading reads as loose.
        const bob = Math.sin(now / 1000 * 3 + t.phase) * 3;
        const len = Math.hypot(ex, ey) || 1;
        // Set in by half its own length, so the arrowhead reaches the margin
        // rather than straddling it.
        const back = EDGE_SIZE * 0.5 - bob;
        const fx = ex - (ex / len) * back;
        const fy = ey - (ey / len) * back;

        EDGE_V.set(fx / (w / 2), -fy / (h / 2), 0).unproject(this.camera);
        arrow.position.copy(EDGE_V);
        arrow.scale.setScalar(EDGE_SIZE * world);
        // Flat to the camera, then turned about the view axis until its +Y — the
        // way it was modelled — runs the way the thing it stands for lies. The
        // screen's y counts downward and the rotation's does not, hence the sign.
        arrow.quaternion.copy(this.camera.quaternion);
        arrow.rotateZ(Math.atan2(-t.dy, t.dx) - Math.PI / 2);
      }
    }

    for (let i = used; i < this.edgeArrows.length; i += 1) this.edgeArrows[i].visible = false;
  }

  /**
   * What a unit is waiting for, in the bubble a shopper thinks in.
   *
   * A bare board is the one thing in the shop you cannot read off it. Goods are
   * drawn as themselves, so a full shelf tells you what it holds from across the
   * room — and an empty one tells you nothing at all, including whether it is
   * empty *of something*. A unit kept for eggs with no eggs on it and a unit
   * nobody has ever spoken for are the same picture: bare boards.
   *
   * The same bubble a customer wants in, deliberately. It is already the game's
   * word for "this is the thing on somebody's mind", it is already built, and it
   * is already billboarded — a second kind of readout saying the same sentence
   * is one more thing to keep in step with the item art.
   *
   * **An empty board, not a thin one**, and that is what keeps this free of the
   * shop's own rules. How thin is thin is `RESTOCK_FRACTION` and it lives on the
   * server for the reason `restockQueue` does; asking it again over here is the
   * copy that drifts from what the shelf menu promises. `qty <= 0` is a fact
   * rather than a judgement, it is already on the wire, and half-full shelves
   * wearing bubbles would be noise over a shop that is working fine.
   *
   * A reservation comes first because it is the strongest form of the sentence:
   * you asked for that board, and it has nothing on it.
   */
  syncWants(shelves) {
    this.wantBubbles ??= new Map();
    const wantOf = (s) => (s.waiting ?? [])[0]?.item_id
      ?? (s.stacks ?? []).find((k) => (k.qty ?? 0) <= 0)?.item_id
      ?? null;

    const want = new Map();
    for (const s of shelves ?? []) {
      // Not while a stock pip is already over it. That marker means "what you
      // are holding goes here", which is the same unit answering a better
      // question — and two readouts on one spike is a stack of arithmetic over
      // a shelf, which is the mistake the money labels made.
      if (this.stockPips?.has(s.id)) continue;
      const id = wantOf(s);
      if (id) want.set(s.id, id);
    }

    // Keyed by unit AND item: a board that gives up on eggs and is ticked for
    // cheese is a different sentence, not a moved one.
    for (const [id, rec] of this.wantBubbles) {
      if (want.get(id) === rec.itemId) continue;
      this.actorRoot.remove(rec.obj);
      disposeGroup(rec.obj);
      this.wantBubbles.delete(id);
    }
    for (const [id, itemId] of want) {
      if (this.wantBubbles.has(id)) continue;
      const item = this.catalog.items[itemId];
      if (!item) continue;
      const bubble = buildBubble(item.model);
      this.actorRoot.add(bubble);
      this.wantBubbles.set(id, { obj: bubble, itemId });
      this.readoutsDirty = true;
    }

    // Positioned every sync rather than at build, the same as the pips and for
    // the same two reasons: a unit can be carried across the shop, and a tier
    // bought under it changes how tall it is.
    for (const [id, rec] of this.wantBubbles) {
      const f = this.allFixtures().find((o) => o.id === id);
      if (!f) { rec.obj.visible = false; continue; }
      rec.obj.visible = true;
      rec.obj.position.set(f.x, this.fixtureHeight(f) + 0.44, f.z);
    }
  }

  /**
   * Preview a wall run on the lines between tiles.
   *
   * Its own ghost rather than a reuse of `setBuildGhost`, because a fixture
   * ghost sits on a tile and this sits on a boundary — and because a run is
   * many segments sharing *one* verdict. Colouring each segment separately
   * would be a lie: "this seals the shop" is true of the run, not of any one
   * piece of it.
   */
  setEdgeGhost(segs, state) {
    const key = segs?.length
      ? `${state}:${segs[0].o}:${segs[0].x},${segs[0].z}:${segs.length}`
      : null;
    if (key === this.edgeGhostKey) return;
    this.edgeGhostKey = key;

    if (this.edgeGhost) {
      this.actorRoot.remove(this.edgeGhost);
      disposeGroup(this.edgeGhost);
      this.edgeGhost = null;
    }
    if (!segs?.length || !this.storeLayout) return;

    // `aim` is not a verdict at all — it is the aim frame's own amber, said about
    // a line instead of a tile, for the one thing you can point at that has no
    // tile of its own: a way through. Everything openable in this game lights up
    // under the pointer, and a doorway was the exception, which reads as the menu
    // not existing rather than as the highlight missing.
    const colour = state === 'aim' ? '#ffd66b'
      : state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const s of segs) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.5));
      // Same centring the real edge renderer uses: a vertical segment sits on
      // the lattice line in x and spans the cell in z, and the other way round.
      if (s.o === 'v') {
        mesh.position.set(s.x - 0.5, 0.6, s.z);
        mesh.scale.set(0.22, 1.2, 1);
      } else {
        mesh.position.set(s.x, 0.6, s.z - 0.5);
        mesh.scale.set(1, 1.2, 0.22);
      }
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.edgeGhost = group;
  }

  /**
   * The area a brush would paint.
   *
   * Flat slabs a hair above the ground rather than the waist-high blocks an
   * edge ghost uses, because a floor ghost has to be readable *through* the
   * shop standing on it: a rectangle of chest-high green across the aisles
   * would hide the shelves you are laying floor around.
   *
   * One verdict for the whole rectangle, exactly as `setEdgeGhost` does — "that
   * would leave bare ground indoors" is true of the stroke, not of any one cell
   * of it, and colouring cells separately would invite you to read the green
   * ones as the part that will happen.
   */
  setFloorGhost(cells, state) {
    const key = cells?.length
      ? `${state}:${cells[0].x},${cells[0].z}:${cells.length}`
      : null;
    if (key === this.floorGhostKey) return;
    this.floorGhostKey = key;

    if (this.floorGhost) {
      this.actorRoot.remove(this.floorGhost);
      disposeGroup(this.floorGhost);
      this.floorGhost = null;
    }
    if (!cells?.length || !this.storeLayout) return;

    const colour = state === 'no' ? '#e2564a' : (state === 'warn' ? '#e8a33d' : '#7cc46a');
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const c of cells) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.42));
      // Above whatever ground is already there, so the ghost reads over floor
      // (0.06 tall) as well as over grass, and slightly inset so a rectangle
      // shows its own grid rather than reading as one undivided sheet.
      mesh.position.set(c.x, 0.1, c.z);
      mesh.scale.set(0.94, 0.05, 0.94);
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.floorGhost = group;
  }

  /**
   * Preview a run of conveyor as the conveyor it is.
   *
   * The floor ghost above says WHERE and WHETHER, in one colour per cell, and
   * for a wall or a stroke of lino that is the whole of what a preview owes
   * you. A conveyor is the one thing you drag out whose entire point is a
   * *direction*: which way the goods go is decided by the drag, corners fall
   * out of where you turned, and none of that is visible on a flat square. So a
   * run drawn as squares is a preview that cannot say the one thing it is for —
   * you lay it, look at the belts, and find out then.
   *
   * `setBuildGhost`'s note says squares are deliberate because "a sixty-cell run
   * of real ghosts is sixty models built per pointer move", and that is the
   * thing this must not do. It is keyed by the CALLER, on the arguments the run
   * is derived from rather than on the cells it came out as: a pointer inside
   * one tile re-runs `runCells` sixty times a second and gets the same
   * answer every time, so the models are built when you cross a tile boundary
   * and not otherwise. No cap and no thinning, unlike the lawn: `BELT_RUN_MAX`
   * is 64, a belt is a handful of boxes, and a run whose last few cells were
   * squares would be a preview that lies about exactly the end you are aiming.
   *
   * No cage per cell and no work spots — see `buildFixtureGhost`. The squares
   * underneath are still doing that half of the job.
   */
  setRunGhost(key, cells, spec = null) {
    if (key === this.runGhostKey) return;
    this.runGhostKey = key;

    if (this.runGhost) {
      this.actorRoot.remove(this.runGhost);
      disposeGroup(this.runGhost);
      this.runGhost = null;
    }
    if (!key || !cells?.length || !this.storeLayout) return;

    const group = new THREE.Group();
    for (const c of cells) {
      // Resolved per cell through the same `fixtureModel` a standing fixture
      // uses, and with the cell's OWN rot — which is the whole feature, since
      // `runCells` is where a corner decides which way it faces.
      //
      // The cell may also carry its own kind, piece and variant, and `spec` is
      // then only the default. A run is one design repeated and needs neither;
      // a pasted blueprint is a shelf, a freezer and a till in one preview, and
      // a single spec would draw all three as whichever came first.
      const at = { ...spec, ...c, x: c.x, z: c.z, rot: c.rot };
      const model = this.fixtureModel(at);
      if (!model) continue;
      const g = buildFixtureGhost({
        model,
        t: tierProgress(1, this.pieceOf(at)?.tiers?.length ?? 1),
        rot: rot4(c.rot ?? 0),
        height: Math.max(modelHeight(partsAt(model, 1)), 0.12),
        verdict: c.state ?? 'ok',
        cage: false,
      });
      // `fixtureBaseY` and not 0: `at` carries the deck off the spec, so a run
      // dragged overhead previews overhead. On the floor it is 0 exactly as it was.
      g.position.set(c.x, this.fixtureBaseY(at), c.z);
      group.add(g);
    }
    this.actorRoot.add(group);
    this.runGhost = group;
  }

  clearBuildGhost(keepKey = false) {
    this.setEdgeGhost(null, null);
    this.setFloorGhost(null, null);
    this.setRunGhost(null, null, null);
    if (this.buildGhost) {
      this.actorRoot.remove(this.buildGhost);
      disposeGroup(this.buildGhost);
      this.buildGhost = null;
    }
    if (!keepKey) this.buildGhostKey = null;
  }

  /**
   * Which person the pointer is on, or null.
   *
   * Projected rather than raycast, unlike `pickFixture`. A body is a handful of
   * small boxes with gaps between them and it is *moving*: a ray that threads
   * between an arm and a torso misses somebody standing right under the cursor,
   * and a hit box big enough to stop that is a box bigger than the person. The
   * question being asked is "who am I pointing at", and a radius around where
   * they are drawn answers exactly that — including when two are stood on the
   * same tile, where the nearest to the cursor is the one you meant.
   *
   * What it aims at is the body's own SPINE — the line from their feet to the
   * top of their head, projected — rather than one point at chest height. A
   * point plus a fixed radius is a circle, and nothing that walks around is
   * circular: a bot is roughly three times as tall as it is wide, so a circle
   * big enough to cover the head misses nothing sideways and a circle tight
   * enough not to grab the shelf behind them covers about the middle third of
   * the body. Pointing at somebody's legs, or at their head, was a miss, and
   * the working spot was a band across their waist that nothing on screen
   * marked — which reads as the pointer being unreliable rather than as the
   * target being small.
   *
   * `radius` is a FLOOR and no longer the whole answer. In pixels it is right
   * about a shop zoomed out — a bot four pixels tall still deserves a target
   * you can hit — and exactly wrong zoomed in, where the person fills a third
   * of the screen and the hit box stays the size of a thumbnail. So the grab is
   * the wider of the two: the pixel floor, or the body's own half-width scaled
   * to how big it is being drawn right now, read off the projected spine rather
   * than off the camera so it needs no assumption about zoom, pitch or lens.
   */
  pickPerson(clientX, clientY, radius = 26) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const p of this.playerState ?? []) {
      const rec = this.players.get(p.id);
      if (!rec) continue;
      const { x, z } = rec.obj.position;
      const foot = this.worldToScreen(x, z, rec.footY);
      const head = this.worldToScreen(x, z, rec.headY);
      if (!foot || !head) continue;
      // Pixels per world unit, at this body, this frame. The spine is a known
      // length in the model and a measured length on screen, so dividing one by
      // the other is the scale — no camera state involved, which is what keeps
      // this honest through a zoom, a quarter turn and any lens change later.
      const tall = Math.hypot(head.x - foot.x, head.y - foot.y);
      const perUnit = tall / Math.max(0.01, rec.headY - rec.footY);
      const grab = Math.max(radius, rec.halfW * perUnit);
      const d = distToSegment(px, py, foot.x, foot.y, head.x, head.y);
      // The cap is per-person now, so it cannot be the running best as well:
      // a tall hire and a short one have different reaches, and comparing raw
      // distances across them still answers "who is the pointer nearest to",
      // which is the tie-break two people on one tile need.
      if (d < grab && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * ...and the same question asked of the shoppers.
   *
   * Its own method rather than a flag on `pickPerson`, because the two are
   * asked in different breaths and must not compete: a hire outranks the
   * fixture behind them and the whole shop outranks a shopper, who is scenery
   * you have never been able to point at. Folding them into one picker would
   * put a customer wandering past a shelf into the running for every ordinary
   * tap in the game.
   *
   * `only` narrows it before the geometry runs, which is what keeps the tazer
   * from ringing the wrong person in a crowd: at the end of a chase the two
   * tiles in front of you hold your staff, whoever was in the way and the one
   * you are actually after, and the pointer should only ever be able to find
   * the last of those.
   */
  pickShopper(clientX, clientY, { only = null, radius = 26 } = {}) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const c of this.customerState ?? []) {
      if (only && !only(c)) continue;
      const rec = this.customers.get(c.id);
      if (!rec) continue;
      const { x, z } = rec.obj.position;
      const foot = this.worldToScreen(x, z, rec.footY ?? 0);
      const head = this.worldToScreen(x, z, rec.headY ?? 1.6);
      if (!foot || !head) continue;
      const tall = Math.hypot(head.x - foot.x, head.y - foot.y);
      const perUnit = tall / Math.max(0.01, (rec.headY ?? 1.6) - (rec.footY ?? 0));
      const grab = Math.max(radius, (rec.halfW ?? 0.34) * perUnit);
      const d = distToSegment(px, py, foot.x, foot.y, head.x, head.y);
      if (d < grab && d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Project a world tile to a screen pixel, for pinning DOM to the world. */
  worldToScreen(x, z, y = 0.9) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.renderer.domElement.clientHeight,
    };
  }

  /**
   * Light up whatever is about to be acted on. The marker appears the tick
   * something comes into range, and pulls taut once the charge is actually
   * running — which is a frame later, but the two states are still distinct
   * for anything the sim refuses.
   *
   * ...unless you are already stood on it, which is most of the time and is
   * where it was saying nothing. `at` is `spotNearest`, so the moment your feet
   * are on any working spot of that fixture it IS that spot — a square painted
   * under the character, over a shelf whose own hover marker is already lit. Two
   * markers for one sentence, and the second one reads as the player being
   * highlighted rather than as the floor.
   *
   * What it is actually for is the case where the spot is somewhere else: the
   * thing is in reach round a corner, or off the end of a display table, and
   * "this is what the hold will do it to" needs somewhere to point. So it draws
   * when the answer is not your own feet, and the charge ring over your head
   * goes on saying *when* either way.
   */
  syncActionTarget(me) {
    const at = me?.action?.at ?? null;
    // Hidden rather than torn down: standing at a spot is a thing you step in
    // and out of, and rebuilding the marker on each step is a mesh a frame.
    if (at && Math.round(me.x) === at.x && Math.round(me.z) === at.z) {
      if (this.targetMarker) this.targetMarker.visible = false;
      return;
    }
    if (!at) {
      if (this.targetMarker) {
        this.actorRoot.remove(this.targetMarker);
        disposeGroup(this.targetMarker);
        this.targetMarker = null;
      }
      return;
    }
    if (!this.targetMarker) {
      this.targetMarker = buildTargetMarker();
      this.actorRoot.add(this.targetMarker);
    }
    this.targetMarker.visible = true;
    this.targetMarker.position.set(at.x, 0, at.z);
    this.targetMarker.userData.held = (me.action.progress ?? 0) > 0;
  }

  /**
   * The charge-up ring — how long you have to walk away. It sits over the
   * player; the marker above says which thing it's aimed at.
   *
   * `RING_Y` is measured off the character rather than off the thought bubble,
   * which is what it used to clear. A head tops out at 0.96 (`buildCharacter`),
   * so 1.2 leaves the ring floating just above it. At 0.60 radius the old one
   * could sit at 2.05 — twice a person's height up — and still read as attached
   * because it was wide enough to enclose them; shrunk to a badge, the same
   * height reads as a speck in the air with nothing under it. Anything small
   * has to be placed against the head, not against the space above it.
   *
   * It draws over the bubble rather than clearing it, which the ring's
   * `depthTest: false` and renderOrder 9/10 already guarantee against the
   * bubble's 1.
   */
  syncActionRings(players, myId) {
    const seen = new Set();
    for (const p of players) {
      if (!p.action || !(p.action.progress > 0)) continue;
      seen.add(p.id);
      let rec = this.actionRings.get(p.id);
      if (!rec) {
        rec = buildProgressRing(p.id === myId ? '#ffd66b' : '#9ad285');
        this.readoutsDirty = true;
        this.actorRoot.add(rec);
        this.actionRings.set(p.id, rec);
      }
      rec.position.set(p.x, RING_Y, p.z);
      setRingProgress(rec, p.action.progress ?? 0);
    }
    for (const [id, rec] of this.actionRings) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec);
      disposeGroup(rec);
      this.actionRings.delete(id);
    }
  }

  /**
   * Bob the piles and spin their coins so money reads as money.
   *
   * The labels are deliberately left out of it. They used to be children of a
   * pile and bobbed with it, which is one moving thing per sale in a corner of
   * the screen you are trying to read a number in — the pile is what says
   * "notice me", and a total that holds still is what says how much.
   */
  animateCash(now) {
    for (const obj of this.cashProps.values()) {
      const age = (now - (obj.userData.born ?? now)) / 1000;
      obj.position.y = CASH_Y + Math.sin(age * 3) * 0.045;
      if (obj.userData.spin) obj.userData.spin.rotation.y = age * 2.2;
    }
  }

  /** Thought bubble showing the item someone wants or is carrying. */
  syncBubble(rec, itemId) {
    if (rec.bubbleKey === itemId) return;
    rec.bubbleKey = itemId;
    if (rec.bubble) {
      rec.obj.remove(rec.bubble);
      disposeGroup(rec.bubble);
      rec.bubble = null;
    }
    if (!itemId) return;
    const item = this.catalog.items[itemId];
    if (!item) return;

    // The icon is the bubble's own job now — it has to measure the model to fit
    // it, and two callers doing that measurement is two badges that disagree
    // about how big a tomato is.
    const bubble = buildBubble(item.model);
    this.readoutsDirty = true;
    rec.obj.add(bubble);
    rec.bubble = bubble;
  }

  /**
   * What someone is actually holding, shown in their hands with a count.
   * You can carry a whole crate, but a single icon made every load look like
   * one item — so there was no way to see a stack.
   *
   * A list of `{item_id, qty}` rather than one line, because a shopper's basket
   * is a mix and drawing only the first thing they took would make everything
   * after it invisible. The units are dealt out ROUND-ROBIN across the kinds,
   * not kind by kind: four tomatoes and a cheese would otherwise spend the
   * whole pile on tomatoes, and "they picked up a cheese" is exactly the fact
   * this is here to show. Past `CARRY_SHOWN` the count does the talking.
   */
  syncCarry(rec, lines) {
    const key = lines?.length
      ? lines.map((l) => `${l.item_id}:${l.qty}`).join('|')
      : null;
    if (rec.carryKey === key) return;
    rec.carryKey = key;

    if (rec.carry) {
      rec.obj.remove(rec.carry);
      disposeGroup(rec.carry);
      rec.carry = null;
    }
    if (!key) return;

    // Deal one of each kind, then go round again, until the pile is full or
    // there is nothing left to deal.
    const left = lines.map((l) => l.qty);
    const pile = [];
    for (let round = 0; pile.length < CARRY_SHOWN; round++) {
      let dealt = false;
      for (let i = 0; i < lines.length && pile.length < CARRY_SHOWN; i++) {
        if (left[i] <= 0) continue;
        left[i]--;
        pile.push(lines[i].item_id);
        dealt = true;
      }
      if (!dealt) break;
    }

    const held = new THREE.Group();
    let n = 0;
    for (const itemId of pile) {
      const item = this.catalog.items[itemId];
      if (!item) continue;
      const one = buildModel(item.model, { castShadow: false });
      one.scale.setScalar(0.5);
      one.position.set(((n % 2) - 0.5) * 0.16, n * 0.15, ((n % 2) - 0.5) * 0.1);
      held.add(one);
      n++;
    }
    // Nothing in the catalog answered to any of it — better to draw nothing
    // than an empty group floating at chest height.
    if (!n) return;

    const total = lines.reduce((s, l) => s + l.qty, 0);
    if (total > 1) {
      const label = buildTextSprite(`x${total}`, { fill: '#fff3cf', scale: 0.62 });
      label.position.set(0.3, 0.28 + n * 0.15, 0);
      held.add(label);
    }
    // Welded, like stock and crops: an armful is up to `CARRY_SHOWN` little
    // models nailed to one another, and everybody in the shop is carrying one.
    // The label rides along untouched — `weld` re-hangs a sprite rather than
    // trying to merge it.
    const armful = weld(held);
    // Out in front at chest height, so it reads as carried rather than worn.
    armful.position.set(0, 0.62, 0.34);
    rec.obj.add(armful);
    rec.carry = armful;
  }

  /**
   * The bag, basket or trolley a shopper has on them.
   *
   * A child of the body like the bubble, the armful and the break prop, so it
   * follows them out of the door and leaves with them, rather than being a
   * second thing to remember to move.
   *
   * Two things here are the pastime's lessons rather than new ones. **The
   * rebuild key is the stage index, never the raw fullness** — a basket filling
   * up moves that number on most snapshots, and a key that moved with it would
   * tear the geometry down and build it again for a fraction of a bag. And
   * **the model authors where it hangs**: this sets no position, because a bag
   * held at the side and a basket held in front are the same code and a
   * different drawing.
   *
   * No shadow, for the reason nothing on a person casts one: the body already
   * does, and a bag laying its own across the floor reads as litter.
   */
  syncKit(rec, kit) {
    const model = kit ? (this.catalog.kits?.[kit.id]?.model ?? null) : null;
    const fill = kit?.fill ?? 0;
    const key = model ? `${kit.id}:${stageIndexAt(model, fill)}` : null;
    if (rec.kitKey === key) return;
    rec.kitKey = key;

    if (rec.kit) {
      rec.obj.remove(rec.kit);
      disposeGroup(rec.kit);
      rec.kit = null;
    }
    if (!key) return;

    rec.kit = buildModel(model, { castShadow: false, t: fill });
    rec.obj.add(rec.kit);
  }

  /**
   * The crate somebody is carrying, drawn as the crate it is.
   *
   * `buildPallet` rather than a box of its own, for the reason `client/thumb.js`
   * derives a palette button instead of matching one: a second picture of a
   * thing the game already draws goes wrong the moment either changes, and
   * nobody holds a carried crate up against one in the yard to notice. It is
   * also the fact the player needs — set it down and *that* is what appears —
   * so the sample inside and the count on the front both carry over for free.
   *
   * Held high and forward, at the height a box is carried rather than the chest
   * height an armful is: the two have to be tellable apart across the shop,
   * because they are the difference between hands you can use and hands you
   * cannot. Scaled down slightly so a crate does not read as wider than the
   * person under it.
   */
  syncHaul(rec, haul, cap) {
    const piles = (haul?.stacks ?? []).map((s) => ({
      ...s,
      model: this.catalog.items[s.item_id]?.model ?? null,
      name: this.catalog.items[s.item_id]?.name ?? '',
    }));
    const key = piles.length
      ? `${piles.map((s) => `${s.item_id}:${s.qty}`).join(',')}/${cap}` : null;
    if (rec.haulKey === key) return;
    rec.haulKey = key;

    if (rec.haul) {
      rec.obj.remove(rec.haul);
      disposeGroup(rec.haul);
      rec.haul = null;
    }
    if (!key) return;

    // `covered: false` so you can see into it — what is in the box is the whole
    // question when somebody walks past you with one, and with a mixed crate it
    // is the only way to tell that the box is doing three jobs at once.
    const box = buildPallet(piles, { covered: false, cap });
    box.scale.setScalar(0.72);
    box.position.set(0, 0.52, 0.3);
    rec.obj.add(box);
    rec.haul = box;
  }

  /**
   * What someone on a break has got with them.
   *
   * A child of the body like the bubble and the carry, and for the same reason:
   * it follows them to the spot and leaves with them when their kind is
   * redrawn, rather than being a second thing to remember to move.
   *
   * Two numbers arrive and they are used very differently. `pastime` says which
   * prop, so it belongs in a key. `breakProgress` says which *stage* of it — and
   * keying on that raw 0..1 would tear down and rebuild this geometry on every
   * snapshot for a fraction of a mug. So the key carries the stage index, and
   * everything between two stages is `animateRest`'s problem, at 60fps.
   *
   * `resting` is set outside the key check on purpose: the slump is the half
   * that reads from across the shop, and it has to work for a pastime nobody has
   * drawn a prop for yet.
   *
   * ...and a CHORE is a pastime that must not slump. Everything else here holds
   * for one — it has a clock, a spot, a prop and a progress, which is why it is
   * a pastime at all — but the slump is the one part that says *resting* rather
   * than *doing*, and a bot sagging at the shoulders while it sweeps the floor
   * reads as broken twice: it is not resting, and it is moving while slumped,
   * which nothing else in the game does. So the prop still hangs and the stages
   * still turn; only the posture is held back.
   */
  syncPastime(rec, p) {
    rec.resting = !!p.pastime && !p.chore;
    const model = p.pastime ? (this.catalog.pastimes?.[p.pastime]?.model ?? null) : null;
    const t = p.breakProgress ?? 0;
    // The same worn/deleted rule the body uses (`buildStaffModel`): a skin is
    // looked up per hire rather than per kind, and one deleted out from under
    // somebody resolves to nothing and draws the prop in its authored colours.
    const skin = p.skin ? this.catalog.skins?.[p.skin] : null;
    // Which skin belongs in the key. A prop that reads `tint` is a different
    // picture on a repainted unit, so re-skinning somebody mid-break has to
    // rebuild it — the stage index alone would hold the old palette until the
    // break crossed a stage boundary, which on a short one is never.
    const key = model ? `${p.pastime}:${stageIndexAt(model, t)}:${skinKey({ id: p.skin })}` : null;
    if (rec.pastimeKey === key) return;
    rec.pastimeKey = key;

    if (rec.pastime) {
      rec.obj.remove(rec.pastime);
      disposeGroup(rec.pastime);
      rec.pastime = null;
    }
    if (!key) return;

    rec.pastime = buildPastimeProp(model, t, skin);
    rec.obj.add(rec.pastime);
  }

  syncShelves(shelves) {
    if (!this.storeLayout) return;
    for (const s of shelves) {
      const def = this.storeLayout.shelves.find((x) => x.id === s.id);
      if (!def) continue;
      let rec = this.shelfProps.get(s.id);

      if (!rec) {
        rec = { group: new THREE.Group(), key: null };
        // Goods are part of the shelf as far as aiming goes — see pickTargets.
        rec.group.userData.pick = true;
        this.actorRoot.add(rec.group);
        this.shelfProps.set(s.id, rec);
      }
      // Re-read the position every sync rather than only on creation. A shelf
      // you pick up and set down elsewhere keeps its id so its stock follows —
      // which only works if the stack follows the shelf too.
      //
      // Everything about where goods sit comes from what the shelf is actually
      // *drawn* as, not from a constant: once a shelf's look is authored
      // content, a redesign or a tier that changes its shape would otherwise
      // leave every stack in the shop hanging in mid-air above it.
      const fx = { ...def, kind: shelfKind(def.kind) };
      // The boards you can SEE INTO, not every board the model has. Those two
      // were the same thing until a fixture grew a canopy — and since goods
      // fill top-first, the covered board is the one they all land on. See
      // `drawableBoards`. Capacity is untouched: `shelfBoards` on the server
      // still counts every surface, so what a shelf HOLDS is not a rendering
      // decision — this only moves where the picture puts it.
      const model = this.fixtureModel(fx);
      const t = this.fixtureT(fx);
      const rows = drawableBoards(partsAt(model, t), surfacesAt(model, t));
      // Rows have a front and a back, so the goods have to turn with the unit.
      // A flat top doesn't care, which is why this never mattered before.
      rec.group.rotation.y = -(def.rot ?? 0) * (Math.PI / 2);
      // The same seat-off-the-wall the unit itself got in `addFixtureProps`.
      // Asked again rather than remembered, because these two groups live under
      // different roots and are rebuilt on different clocks — a stored offset
      // would be the one from the shop before last on the first sync after a
      // re-flow, which is goods hanging a tenth of a tile off their own shelf.
      const off = this.artSetback(this.storeLayout, fx);
      rec.group.position.set(
        def.x + (off?.dx ?? 0),
        rows.length ? 0 : this.fixtureHeight(fx),
        def.z + (off?.dz ?? 0),
      );

      // A unit holds one kind per BOARD now, so this draws a list rather than a
      // single item — board n gets stack n, top down, which is the order
      // `buildShelfGoods` already fills in and the reason no positions had to be
      // invented for this. A unit with no boards piles everything on its roof,
      // which is what a chest freezer and a counter want, so there the stacks
      // are drawn one behind the other rather than side by side — and a unit
      // whose every board is covered takes that same fallback, because a board
      // you cannot see into is a board it does not have.
      const stacks = (s.stacks ?? []).filter((k) => k.qty > 0);

      // A kind gets its SHARE of the boards, not one board. The unit's capacity
      // is divided by how many ways it is spoken for (`shelfShares`, server
      // side) and the art has to be divided the same way, or a shelf kept for
      // one thing draws sixteen carrots' worth of stock on the top board and
      // leaves two bare — which reads as two boards that never fill. Shares
      // rather than stacks, so a board held open by a reservation with no goods
      // behind it yet stays held open in the picture too.
      const kinds = [...new Set([
        ...(s.assigned ?? []), ...stacks.map((k) => k.item_id),
      ])];
      const shares = Math.max(1, kinds.length);
      // Top down: `rows` runs bottom-first, and the top board is the one a 45°
      // camera actually shows. In `shared/model.js` since the sim started
      // asking the same question to price a board — see `boardsForShare`.
      const boardsFor = (gi) => boardsForShare(rows, shares, gi);

      // What will actually be DRAWN, which is what the redraw has to follow.
      // Keying on qty alone rebuilt geometry on every sale of a forty-unit
      // shelf that already read as full; keying on a clamp of qty missed the
      // sale that takes a facing away.
      const plan = stacks.map((k) => {
        const gi = Math.max(0, kinds.indexOf(k.item_id));
        const boards = boardsFor(gi);
        return {
          k, gi, boards,
          show: rows.length ? shelfShow(k.qty, k.cap, boards) : Math.ceil(k.qty / 4),
        };
      });
      const key = plan.map((p) => `${p.k.item_id}:${p.gi}:${p.show}`).join('|')
        + `:${rows.length}:${shares}`;
      if (rec.key === key) continue;
      rec.key = key;
      // Freed, not just dropped. This was a bare `clear()` for as long as a
      // stack was a pile of meshes over the SHARED `GEO` primitives — nothing
      // to free, so nothing leaked. Welding gives every stack a merged geometry
      // of its own, and a shelf's stock is rebuilt on every sale, so a `clear()`
      // here would have turned the cheapest thing in the renderer into the
      // fastest leak in it. The same line syncPlots has always had.
      disposeGroup(rec.group);
      rec.group.clear();
      if (!stacks.length) continue;

      // One group per kind, and each one says which kind it is. That field is
      // what makes a board a thing you can point at: `pickFixtureHit` walks up
      // from whatever mesh the ray met, and a pile of bread answers "the bread
      // on this shelf" rather than just "this shelf". Set on the group the
      // builder hands back rather than inside it, because both builders weld —
      // the meshes underneath are a merge of everything that shared a material
      // and there is nothing per-item left down there to tag.
      plan.forEach((p, n) => {
        const item = this.catalog.items[p.k.item_id];
        if (!item) return;
        if (!rows.length) {
          // No boards: everything heaps on the roof. Nudged apart so two kinds
          // read as two heaps rather than one interpenetrating mess.
          const heap = buildStack(item.model, p.k.qty, item.stack);
          heap.position.x += (n - (plan.length - 1) / 2) * 0.34;
          heap.userData.item = p.k.item_id;
          rec.group.add(heap);
          return;
        }
        // `buildShelfGoods` fills the boards it is handed top-first, so they go
        // back bottom-first — this kind fills its own share of the unit from
        // the top of it down, and touches nobody else's boards.
        const goods = buildShelfGoods(item.model, p.k.qty, [...p.boards].reverse(), p.k.cap);
        goods.userData.item = p.k.item_id;
        rec.group.add(goods);
      });
    }
  }

  syncPlots(plots) {
    if (!this.storeLayout) return;
    for (const p of plots) {
      const def = this.storeLayout.plots.find((x) => x.id === p.id);
      if (!def) continue;
      const grown = p.ready ? 1 : (p.growth ?? 0);
      const crop = p.crop_id ? this.catalog.crops[p.crop_id] : null;
      // A staged crop rebuilds when it crosses into the next stage; an unstaged
      // one only ever has the four sizes the ramp below gives it. Either way the
      // key stops us rebuilding geometry sixty times a second for 1% of growth.
      const stage = isStaged(crop?.model)
        ? stageIndexAt(crop.model, grown)
        : (p.ready ? 3 : Math.floor(grown * 3));
      const soil = p.soil ?? 'untilled';
      // How many plants are in the bed is part of what it looks like, so a
      // re-roll after replanting has to rebuild it.
      const count = Math.max(1, p.yield || 1);
      const key = `${soil}:${p.crop_id}:${stage}:${count}`;
      let rec = this.plotProps.get(p.id);

      if (!rec) {
        rec = {
          group: new THREE.Group(), overlay: new THREE.Group(),
          key: null, bar: null, bubble: null, bubbleKey: null,
        };
        // The plants, but not the readout floating over them: a growth bar is
        // something to read, not something to point at.
        rec.group.userData.pick = true;
        this.actorRoot.add(rec.group, rec.overlay);
        this.plotProps.set(p.id, rec);
      }
      rec.group.position.set(def.x, TILE_STYLE[T.PLOT].h, def.z);
      rec.overlay.position.copy(rec.group.position);
      // Before the cache check, not after: the readout has to move every sync
      // even on the ticks where the art is unchanged.
      this.syncPlotOverlay(rec, p, crop, grown);
      if (rec.key === key) continue;
      rec.key = key;
      disposeGroup(rec.group);
      rec.group.clear();

      // Turned earth vs rough turf. A planted bed is always broken soil, so a
      // crop never looks like it's growing straight out of the lawn.
      rec.group.add(buildSoil(p.crop_id ? 'tilled' : soil, PALETTE));

      if (!p.crop_id || !crop) continue;

      // One plant per unit the bed will yield, so what is growing there is what
      // picking it hands over. Built into a bed of their own and welded, the way
      // stock is — a bed of twelve is twelve plants and one object, and nothing
      // growing in it moves independently of the rest.
      const bed = new THREE.Group();
      for (const spot of plantSpots(count, hashId(p.id))) {
        const plant = buildModel(crop.model, { t: grown });
        // A crop that draws its own stages has already said what growing looks
        // like — scaling it as well would shrink the sprout it deliberately drew.
        // Anything with a single model still swells from sprout to full size,
        // which is the only growth cue it has.
        if (!isStaged(crop.model)) plant.scale.setScalar(0.35 + grown * 0.65);
        // Then shrink to share the bed. Multiplied, not assigned, or a crowded
        // bed of unstaged crops would lose its growth ramp entirely.
        plant.scale.multiplyScalar(spot.scale);
        plant.position.set(spot.x, 0, spot.z);
        bed.add(plant);
      }
      rec.group.add(weld(bed));

      if (p.ready) {
        const glow = new THREE.Mesh(
          new THREE.RingGeometry(0.35, 0.48, 16),
          new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.02;
        rec.group.add(glow);
      }
    }
  }

  /**
   * How far along a crop is, and what it will give you when it's done.
   *
   * Deliberately not part of the cached rebuild above. That only fires when a
   * crop crosses into its next art *stage*, so a bar living in there would
   * advance four times between seed and harvest and sit frozen in between.
   *
   * The two states never both show: a bar that has reached the end says the
   * same thing as the bubble, and saying it twice is how a readable plot turns
   * into a cluttered one.
   */
  syncPlotOverlay(rec, p, crop, grown) {
    this.syncFillOverlay(rec, {
      filling: !!crop && !p.ready,
      fill: grown,
      itemId: p.ready && crop ? crop.item_id : null,
    });
  }

  /**
   * "How far off is it" and "here it is", for anything that fills up.
   *
   * Two shapes, one vocabulary: a bar while something is on its way and the
   * thing itself in a thought-bubble once it is there — the same bubble a
   * shopper uses to say what they came in for, rather than a second symbol
   * meaning the same thing.
   *
   * Shared by beds and pens because they are the same sentence, and writing it
   * twice is how a field of animals ends up reading differently from a field of
   * carrots standing next to it. A bed never shows both — a crop is ripe or it
   * is growing — and a pen routinely does, since it goes on filling while
   * yesterday's eggs are still in it. That falls out rather than being a case:
   * the two states are two arguments, not two branches.
   */
  syncFillOverlay(rec, { filling, fill, itemId, barY = 0.95, bubbleY = 1.02 }) {
    if (filling && !rec.bar) {
      rec.bar = buildGrowthBar();
      this.readoutsDirty = true;
      rec.bar.position.y = barY;
      rec.overlay.add(rec.bar);
    }
    if (rec.bar) {
      rec.bar.visible = filling;
      if (filling) setGrowthBar(rec.bar, fill);
    }

    const item = itemId ? this.catalog.items[itemId] : null;
    const key = item?.id ?? null;
    if (rec.bubbleKey === key) return;
    rec.bubbleKey = key;

    if (rec.bubble) {
      rec.overlay.remove(rec.bubble);
      disposeGroup(rec.bubble);
      rec.bubble = null;
    }
    if (!item) return;

    const bubble = buildBubble();
    this.readoutsDirty = true;
    const icon = buildModel(item.model, { castShadow: false });
    icon.scale.setScalar(0.42);
    icon.position.y = -0.14;
    bubble.add(icon);
    bubble.position.y = bubbleY;
    // Offset the bob per fixture so a field going ripe doesn't pulse in lockstep.
    bubble.userData.phase = (rec.overlay.position.x + rec.overlay.position.z) * 0.7;
    rec.overlay.add(bubble);
    rec.bubble = bubble;
  }

  /**
   * Every pen: how full it is, and what is standing in it.
   *
   * Three readouts and each answers a different question, which is why a pen
   * carries one more than a bed does. The BAR is the next batch, the BUBBLE is
   * what is there to collect, and the `work` MODEL is what that looks like from
   * across the field — eggs in the nest box, churns by the gate — because the
   * first two are readouts floating over the thing and the third is the thing.
   * A pen you can see is occupied is the whole reason `work` is authorable here.
   *
   * `work` rather than more stages on `model` for the reason an appliance has
   * two: one resolver takes ONE number, and a pen has two — which rung it is on
   * and how full it is. Spending the tier's number on fullness would mean a pen
   * that stops showing you which one you bought.
   *
   * Its own map with its own sweep, the way `stationProps` has one, rather than
   * a line in `refreshFixtureProps`: everything in here lives in `actorRoot`,
   * which a re-flow does not dispose, and a pen that has gone has to take its
   * bubble with it.
   */
  syncPens(pens) {
    if (!this.storeLayout) return;
    const seen = new Set();

    for (const pn of pens) {
      const def = (this.storeLayout.pens ?? []).find((x) => x.id === pn.id);
      if (!def) continue;
      seen.add(pn.id);

      let rec = this.penProps.get(pn.id);
      if (!rec) {
        rec = { overlay: new THREE.Group(), bar: null, bubble: null, bubbleKey: null, work: null, workKey: null };
        this.actorRoot.add(rec.overlay);
        this.penProps.set(pn.id, rec);
      }
      // Every sync rather than at creation, or a pen you pick up and carry
      // across the farm leaves its readouts standing in the old field.
      const mid = footprintMid('pen', def.x, def.z);
      rec.overlay.position.set(mid.x, 0, mid.z);

      const top = this.penTopY(def);
      this.syncFillOverlay(rec, {
        filling: (pn.qty ?? 0) < (pn.cap ?? 0),
        fill: pn.fill ?? 0,
        itemId: (pn.qty ?? 0) > 0 ? pn.item_id : null,
        barY: top + 0.2,
        bubbleY: top + 0.27,
      });
      this.syncPenWork(def, rec, pn);
    }

    for (const [id, rec] of this.penProps) {
      if (seen.has(id)) continue;
      this.actorRoot.remove(rec.overlay);
      disposeGroup(rec.overlay);
      if (rec.work) {
        this.actorRoot.remove(rec.work);
        disposeGroup(rec.work);
      }
      this.penProps.delete(id);
    }
  }

  /**
   * What is standing in the pen, drawn over it and staged by how full it is.
   *
   * Rebuilt only when it crosses into the next STAGE, which is `syncStationWork`'s
   * cache and matters more here: `fill` moves ten times a second and the picture
   * changes four times a batch.
   *
   * In `actorRoot` rather than parented to the pen, for the reason an appliance's
   * does: the fixture belongs to `staticRoot`, which a re-flow disposes wholesale,
   * and build mode re-flows on every wall segment.
   */
  syncPenWork(def, rec, pn) {
    const model = (pn.qty ?? 0) > 0 ? variantWork(this.pieceOf(def), def.variant) : null;
    const t = model && pn.cap > 0 ? Math.min(1, (pn.qty ?? 0) / pn.cap) : 0;
    const key = model ? `${def.piece}:${def.variant}:${stageIndexAt(model, t)}` : '';

    if (key !== rec.workKey) {
      if (rec.work) {
        this.actorRoot.remove(rec.work);
        disposeGroup(rec.work);
        rec.work = null;
      }
      if (model) {
        rec.work = buildLoopingProp(partsAt(model, t), { castShadow: true });
        this.actorRoot.add(rec.work);
      }
      rec.workKey = key;
    }
    if (!rec.work) return;
    // Turned with the pen, or the churn stands behind the gate — and stood at
    // the middle of the block, the same place `addFixtureProps` stands the pen.
    const mid = footprintMid('pen', def.x, def.z);
    rec.work.position.set(mid.x, this.fixtureBaseY(def), mid.z);
    rec.work.rotation.y = -(def.rot ?? 0) * (Math.PI / 2);
  }

  /** Just clear of this pen's own art, measured off it the way a station's is. */
  penTopY(def) {
    const model = this.fixtureModel(def);
    return model ? modelHeight(partsAt(model, this.fixtureT(def))) : 0.7;
  }

  /** Bob every ready-marker, so a ripe plot catches the eye from across the farm. */
  animatePlots(now) {
    for (const rec of this.plotProps.values()) {
      const b = rec.bubble;
      if (b) b.position.y = 1.02 + Math.sin(now / 1000 * 2.6 + (b.userData.phase ?? 0)) * 0.055;
    }
  }

  /**
   * Anger, drawn three ways off the one number the server sends.
   *
   * The flush and the shake both ramp from `anger`, and the shake reuses the
   * per-actor `phase` the breathing already hashes out of the id — without it
   * twenty cross shoppers vibrate in perfect unison, which reads as a screen
   * artefact rather than as a room full of people losing their tempers.
   *
   * Tilt rather than position, because `syncActors` lerps x and z toward the
   * server every frame and a jitter added to those would be pulled straight
   * back out. `rotation.y` is facing; `z` is free.
   */
  animateMoods(now) {
    const t = now / 1000;
    for (const rec of this.customers.values()) {
      const anger = rec.anger;
      if (anger == null) continue;
      const head = rec.obj.userData.head;
      if (head) head.material = material(faceColor(anger));
      rec.obj.rotation.z = anger > 0 ? Math.sin(t * 34 + rec.phase) * 0.1 * anger : 0;
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Everything that is running, one frame.
   *
   * Two halves, and they are two halves because a machine is drawn in two
   * places. Its own moving parts belong to the fixture standing in `staticRoot`
   * — a blade is part of the blender whether it is turning or not — and are
   * driven by whether it is busy. Whatever it puts on top while it works is a
   * prop of its own, and only exists while there is something to show.
   *
   * The rule for the first half is the one the schema states: a fixture that can
   * be busy moves while it *is* busy, and a fixture that has no idea what busy
   * means always moves. Without that second clause `motion` would be a field
   * that silently does nothing on everything except an appliance, and a ceiling
   * fan would be a fixture you can author and never see turn.
   */
  /**
   * The slats' transforms into their instance buffers, once a frame.
   *
   * `animateMotion` has just written every one of them as if it were an
   * ordinary mesh, which is the whole point of the holders — see
   * `addConveyorSlats`. Uploaded per BATCH rather than per slat, because
   * `needsUpdate` re-sends the whole buffer either way and setting it inside the
   * loop would re-send it once per bar.
   */
  /**
   * The carriers, once a frame — and what moves is the LIGHT on them.
   *
   * They used to slide: each one travelled a third of a tile along the run and
   * wrapped, which is what a real belt does and is not what it looks like here.
   * At this camera a carrier is about a dozen pixels, so a run of them shuffling
   * along reads as the parts of the machine drifting rather than as a surface
   * moving — and a shop with forty cells of belt in it is forty little things
   * jittering in the corner of your eye all day.
   *
   * So the transforms are written once at build and never again, and the flow is
   * a band of brighter carriers walking the way the goods go. `m.travel` is the
   * distance the run has covered — accumulated and eased by `animateMotion`, so
   * a belt that stops fades to still where it stopped rather than sliding back —
   * and the phase is the carrier's own place along the flow, so the band crosses
   * cell boundaries without anything knowing where a run starts.
   *
   * The matrices are still copied for anything with no chase on it, which is
   * what keeps this the same one loop rather than two.
   */
  flushSlats() {
    for (const b of this.slatBatches ?? []) {
      let movedMatrix = false;
      for (let i = 0; i < b.holders.length; i++) {
        const h = b.holders[i];
        const m = h.userData.flow;
        if (!m || !b.lit) {
          h.updateMatrix();
          b.im.setMatrixAt(i, h.matrix);
          movedMatrix = true;
          continue;
        }
        // Where this carrier sits in the wave. `travel` already wraps on `span`,
        // so the difference only has to be folded into the same window.
        const span = m.span || 0.25;
        let u = ((m.travel ?? 0) - (h.userData.wave ?? 0)) % span;
        if (u < 0) u += span;
        // A FLOOR PLUS A BAND, and the floor is what makes it visible at all.
        //
        // It was the band alone, cubed, and that is a beautiful curve nobody
        // ever saw: a cell is only `working` while a box is actually on it,
        // which is about four tenths of a second, and `amp` eases in over most
        // of that — so the one carrier at the crest of a cubed wave got bright
        // for a couple of frames on a cell you were probably not looking at.
        // What you want to read is "this cell is live", with the band as the
        // texture on top of it, so most of the lift is flat across the cell and
        // the wave rides the rest.
        const f = 1 - u / span;
        const k = 1 + SLAT_LIT * (0.45 + 0.55 * f * f) * (m.amp ?? 0);
        b.im.setColorAt(i, SLAT_RGB.setRGB(
          Math.min(1, b.lit[i * 3] * k),
          Math.min(1, b.lit[i * 3 + 1] * k),
          Math.min(1, b.lit[i * 3 + 2] * k),
        ));
      }
      if (movedMatrix) b.im.instanceMatrix.needsUpdate = true;
      if (b.lit && b.im.instanceColor) b.im.instanceColor.needsUpdate = true;
    }
  }

  animateStations(now) {
    // Stopped time stops the machines. A return rather than passing `false` for
    // "working": false eases them down to a halt over the next second, which is
    // a machine being switched off, and time stopping is not that.
    if (this.paused) return;
    const t = now / 1000;
    for (const [id, body] of this.movingFixtures) {
      const st = this.stationProps.get(id);
      // A loader is the second kind of fixture that knows what busy means: it is
      // busy while there is a box on it. Without this its lamp pulses all night
      // over an empty machine, which is a light that tells you nothing.
      const busy = this.beltBusy?.has(id) && !this.beltStuck?.has(id);
      // What it last DID, which is a different question from whether it is
      // holding something and is the one the colour answers. The shop says it —
      // `armSaid`, server side — because the client can see a crate on a cell
      // and can never see a pour that was refused.
      //
      // `busy` still drives the PULSE below: a machine with a box on it is
      // working whatever came of it, and a light that stopped moving the moment
      // a pour failed would read as the loader having died.
      const said = this.armSaid?.get(id) ?? null;
      // A mouth reports what it HOLDS rather than whether it is flowing: the
      // box inside a tunnel is not drawn, so "there is one in here" is the only
      // thing this light has to say, and a jam must not turn it off.
      const hue = body.mouth ? (this.beltBusy?.has(id) ? LAMP_ON : LAMP_IDLE)
        : said === 'load' ? LAMP_ON : said === 'pass' ? LAMP_PASS : LAMP_IDLE;
      // Set only when it changes, because a `Color.set` per lamp per frame is
      // the cost this whole gating exists to avoid — and `material` here is the
      // lamp's own, never the shared cache.
      if (body.lamps && body.lit !== hue) {
        body.lit = hue;
        for (const lamp of body.lamps) lamp.material.color.set(hue);
      }

      // ...and the ROOF BARS, which answer "which way did it go" where the lamp
      // above answers "what came of it". A loader and a junction each get one
      // per side goods can cross, and at most one of them is lit.
      //
      // Green is a TRANSFER — the side a box actually crossed, whether that was
      // poured into a unit, lifted off the floor, or picked by a junction as its
      // way out. Amber is a PASS: the loader looked at the box, nothing beside
      // it would take it, and it carried on down the run — so the bar that
      // lights is the run's own exit, which is where the box went.
      //
      // The two are read in that order because a transfer is the more specific
      // answer: `armSaid` says `pass` about the swing, and a swing that poured
      // is not one, so they never both apply to the same box. Keyed as a string
      // for the same reason the lamp keeps `body.lit` — a per-frame write per
      // bar is exactly the cost the gate above exists to avoid.
      if (body.pips) {
        const mv = this.armMove?.get(id) ?? this.sortMove?.get(id) ?? null;
        const lit = mv ? { dx: mv.d[0], dz: mv.d[1], hue: LAMP_ON }
          : (said === 'pass' && body.outSide)
            ? { ...body.outSide, hue: LAMP_PASS } : null;
        const key = lit ? `${lit.dx},${lit.dz},${lit.hue},${mv?.n ?? ''}` : '';
        if (body.pipLit !== key) {
          body.pipLit = key;
          for (const pip of body.pips) {
            const on = lit && pip.dx === lit.dx && pip.dz === lit.dz;
            pip.mesh.material.color.set(on ? lit.hue : LAMP_IDLE);
          }
        }
      }
      // ...and the join marks, which answer a different question from the lamp
      // above and have to be asked separately even on the cell that has both.
      // A loader's lamp reports what it last DID (`armSaid`) — it took a box, it
      // passed one on — and its join marks report whether goods are CROSSING,
      // which is the run's business rather than the machine's. Folding them
      // would put a loader's refusal on the line either side of it and read as
      // the belt having jammed.
      //
      // Jam beats carrying, and the order is the point: a jammed cell is holding
      // a box, so `beltBusy` is true of it too, and asking that first would
      // paint every jam green — which is the state this exists to make visible,
      // wearing the colour of the state it is not.
      const flow = this.beltStuck?.has(id) ? CONVEYOR_LIT.jam
        : this.beltBusy?.has(id) ? CONVEYOR_LIT.on : CONVEYOR_LIT.idle;
      if (body.flow && body.flowLit !== flow) {
        body.flowLit = flow;
        const mat = flowMaterial(flow);
        for (const mark of body.flow) mark.material = mat;
      }
      // ...and, for a `sweep`, the number it points at. Null for everything
      // else, which is every fixture in the game that is not a clock — a sweep
      // with nothing to read holds still rather than snapping to zero, so a prop
      // whose piece names no signal is simply a prop that never moves.
      animateMotion(
        body.moving, t + body.phase, st ? st.making : (body.conveyor ? !!busy : true),
        body.signal ? this.signals[body.signal] ?? null : null,
      );

      // ONE SPUR SCROLLS, and it is the one the crate is actually on.
      //
      // Read off the CRATE rather than off a clock of its own, which is the
      // whole lesson of the three attempts this replaces. The box travels on the
      // sim's own tick now, so where it is IS the answer to "is this spur
      // running" — no timer here, nothing to start on an edge, nothing to keep
      // in step with the server. A spur is live while there is a box somewhere
      // along it.
      //
      // Every spur is asked, not just the live one, because the answer for the
      // others is "stop": `animateMotion` eases a scroll down rather than
      // cutting it, so a length of track left out of this loop keeps whatever it
      // was last told and runs for ever.
      if (body.slides?.length) {
        const box = this.beltOn?.get(id) ?? null;
        for (const s of body.slides) {
          if (!s.rails.length) continue;
          // Off the machine's centre, along this spur's own axis. A box sitting
          // squarely on the cell is on no spur at all and scrolls nothing, which
          // is a loader holding a crate it has not decided about yet.
          const along = box ? (s.dx ? (box.x - s.cx) * s.dx : (box.z - s.cz) * s.dz) : 0;
          const off = box ? Math.abs(s.dx ? box.z - s.cz : box.x - s.cx) : 1;
          animateMotion(s.rails, t + body.phase, along > 0.01 && off < 0.01, null);
        }
      }
    }
    this.flushSlats();
    for (const rec of this.stationProps.values()) {
      for (const work of rec.work) {
        if (!work) continue;
        animatePuffs(work.userData.puffs, t);
        animateMotion(work.userData.moving, t, true);
      }
    }
  }

  render() {
    const now = performance.now();
    // How long the last frame took. Everything else animated in here is a sine
    // of `now` and could not care — an oscillation is at the same place at the
    // same moment however many frames got you there — but a *chase* toward a
    // moving target is not, and one written as a fixed fraction per frame runs
    // at whatever speed the machine happens to draw at. Clamped for the same
    // reason main.js clamps its own: a backgrounded tab comes back with a delta
    // of however long you were away, which would snap the thing being chased
    // straight to its target and lose the corner it was going round.
    // ...and the gap it was clamped from, which is the only thing that can tell
    // a slow frame from a tab that was not being drawn at all. Read before the
    // clamp throws it away — see `AWAY_MS`.
    const gap = now - (this.lastFrameAt ?? now);
    const away = gap >= AWAY_MS;
    const dt = Math.min(0.05, gap / 1000);
    this.lastFrameAt = now;
    this.animateCash(now);
    this.animatePlots(now);
    this.animateMoods(now);
    // The wind, for as long as time is running. Accumulated off `dt` rather than
    // read off `now`, which is the only way stopping it can mean anything: the
    // sine of a clock that kept counting resumes wherever it would have got to,
    // so a lawn paused for a minute snaps to a new lean the moment you unpause.
    // Exactly the argument `animateStations` makes about a blade, and here it is
    // about the other kind of blade.
    if (!this.paused) WIND_CLOCK.value += dt * WIND_SPEED;
    // Everybody on foot. Per frame for the reason vehicles are — see
    // `ACTOR_CHASE`, which is that reason arriving for people the day the shop
    // stopped being on the same machine as the screen.
    // Repaint the footfall sheet if it moved. It early-outs on both a clean map
    // and a hidden one, so a shop with the overlay off pays a compare a frame.
    this.heat.refresh();
    this.animateActors(dt, away);
    // The van and the parked cars. Faster, and for the same reason — see
    // `VEHICLE_CHASE`.
    this.animateVehicles(dt, away);
    // Appliances. Per-frame like everything else here: a batch is thirty
    // seconds and the flag that says one is running arrives at 10Hz, so a blade
    // that only turned when the snapshot did would read as a dropped frame.
    this.animateStations(now);
    // Breaks. Nobody who is working costs more than a compare and a return, and
    // this has to be per-frame rather than per-sync for the same reason the
    // markers below are: a worker who only slumped ten times a second would
    // read as the renderer stuttering, not as somebody having a sit down.
    // `camAngle` is the same yaw the billboards are aimed with (`faceReadouts`),
    // so a hire on a break ends up square to the view exactly as a thought bubble
    // does — one answer to "which way is the camera", not two that drift a
    // quarter-turn apart when the view is spun.
    for (const rec of this.players.values()) {
      animateRest(rec, now, this.camAngle);
      // ...and whatever they were authored to move. A hire is a `buildModel`
      // like any fixture, so the parts were already collected onto the group —
      // the only thing missing was somebody asking them to turn.
      //
      // Two things it borrows wholesale from `animateStations`. `rec.phase` is
      // the offset, so two janitors in one aisle do not sweep in perfect
      // unison, and it is the SAME per-person hash their breathing uses rather
      // than a second one — one answer to "which of you is this". And a body
      // with no moving parts costs a property read and an empty loop, which is
      // every shopper, every player and every hire nobody has drawn a brush on.
      //
      // Stopped time stops them, and it has to be a SKIP rather than a `false`
      // — the third thing borrowed from `animateStations`, and the one that is
      // not obvious. False eases the brush down over half a second, which is a
      // machine being switched off, and time stopping is not that. Nothing else
      // would say a word: a paused shop with a brush still turning in it is a
      // pause button that does not look like it worked.
      if (!this.paused) {
        animateMotion(rec.obj.userData.moving, now / 1000 + rec.phase, rec.working);
      }
    }
    if (this.liftedRing) {
      // Animated here rather than in syncLifted: state arrives at 10Hz and a
      // marker that only moves ten times a second reads as a rendering fault.
      this.liftedRing.position.y = 1.5 + Math.sin(now / 1000 * 3.4) * 0.12;
      this.liftedRing.rotation.z = now / 1000 * 1.2;
    }
    // ...if it has one. A board's cage deliberately has no chevron (see
    // `MARKER_LOOK.board`), so this is a guard rather than a formality: the one
    // marker in the game with nothing floating over it would otherwise throw
    // once a frame for as long as you pointed at a shelf full of bread.
    if (this.aimMarker?.userData.arrow) {
      // No spin any more, here or below. A ring is rotationally symmetric, so
      // the spin these markers were given was invisible — and the moment they
      // became squares that agree with the tile grid it stopped being
      // invisible and started being wrong.
      this.aimMarker.userData.arrow.position.y = 1.62 + Math.sin(now / 1000 * 4) * 0.11;
    }
    // The one marker that has to be re-placed every frame, because what it is
    // pointing at is walking. If their body has gone — let go, or their kind
    // deleted — the marker goes with it rather than hanging over the floor.
    if (this.personMarker) {
      const rec = this.bodyOfHire(this.personAimId);
      if (!rec) this.setPersonAim(null);
      else {
        this.personMarker.position.copy(rec.obj.position);
        // Lower than a fixture's: a shelf is chest high and a person is not, so
        // the same 1.62 floats a chevron in the air over their head.
        this.personMarker.userData.arrow.position.y = 1.34 + Math.sin(now / 1000 * 4) * 0.11;
      }
    }
    // ...and the same again for whoever's menu is open. It has no chevron to
    // bob, so this is only the walk — and a hire let go while you were reading
    // about them loses the marker here rather than leaving a ring on the floor
    // where they were standing.
    if (this.personSelMarker) {
      const rec = this.bodyOfHire(this.personSelId);
      if (!rec) this.setPersonSelected(null);
      else this.personSelMarker.position.copy(rec.obj.position);
    }
    if (this.stockPips?.size) {
      // Per-frame rather than per-sync, like every other marker here: something
      // that only moved ten times a second reads as the renderer stuttering.
      const t = now / 1000;
      for (const pip of this.stockPips.values()) {
        pip.userData.arrow.position.y = 0.62 + Math.sin(t * 3 + (pip.userData.phase ?? 0)) * 0.09;
      }
    }
    if (this.selectedMarker) {
      // A slow breathe, half the rate of anything armed. It has to be alive —
      // a still outline on a shop floor reads as scenery, and this one can be
      // the only marker on screen while you work through the menu — but it must
      // not read as something waiting to be pressed, which is what the aim
      // marker's beat means.
      const s = 1 + Math.sin(now / 1000 * 2) * 0.035;
      this.selectedMarker.userData.ring.scale.setScalar(s);
    }
    this.animateRipples(now);
    this.animateLandings(now);
    if (this.targetMarker) {
      const t = now / 1000;
      const held = this.targetMarker.userData.held;
      // Bobbing while it's only in range, and pulled taut once the charge is
      // running — so the marker answers before the ring has visibly moved.
      this.targetMarker.userData.arrow.position.y = held ? 1.5 : 1.62 + Math.sin(t * 4) * 0.11;
      this.targetMarker.userData.ring.scale.setScalar(held ? 1.12 : 1 + Math.sin(t * 4) * 0.045);
    }
    // A held press winds the aim ring in and speeds it up, so the thing you are
    // pointing at is the thing that reacts. Drawn on `aimMarker` — what your
    // pointer is over — and not on `targetMarker`, which is what your *body* is
    // next to; on a press they are usually different objects, and animating the
    // wrong one tells you the game heard a press somewhere else.
    if (this.aimMarker?.userData.ring) {
      const k = this.holdProgress;
      const ring = this.aimMarker.userData.ring;
      if (k === null) {
        ring.scale.setScalar(1);
        ring.material.opacity = 0.9;
      } else {
        // Tightening rather than filling: a ring that shrinks onto its target
        // says "this one, keep going" without needing a second ring in a
        // different style, and it reads at a glance at any zoom.
        //
        // Every term starts at exactly the idle value, so pressing and letting
        // go are both continuous. An earlier cut wound in from 1.22 — a nice
        // anticipation beat in principle, and in practice a ring that jumps a
        // fifth of its size in the single frame you press, which is
        // indistinguishable from a glitch.
        ring.scale.setScalar(1 - 0.26 * k);
        ring.material.opacity = 0.9 + 0.1 * k;
      }
    }
    // Eased like camLook, and for the same reason: a wheel notch that snapped
    // straight to its new scale read as the world flinching rather than as the
    // camera moving. Snapped once it's close, so we stop rebuilding the
    // projection matrix every frame forever.
    // Which set of gains the whole pose is chasing on. Read once, here, rather
    // than asked four times down the function: they are one decision, and four
    // separate reads is four chances for half the camera to be gliding while
    // the other half snaps.
    const ease = this.cinema ? CINE_EASE : EASE;
    const dz = this.camZoom - this.ortho.zoom;
    if (dz) {
      this.ortho.zoom = Math.abs(dz) < 0.002 ? this.camZoom : this.ortho.zoom + dz * ease.zoom;
      this.ortho.updateProjectionMatrix();
    }
    // The first-person pitch, which is the yaw's opposite number and eases the
    // same way. `tilt` is 1 outside cinema, so this is an assignment there and
    // the branch costs a multiply.
    if (this.fpvPitch !== this.fpvAim) {
      this.fpvPitch = glide(this.fpvPitch, this.fpvAim, ease.tilt, ease.tiltMin);
    }
    // Swing round to the target corner, same easing idea as zoom and camLook.
    // A drag has already moved both, so this is a no-op while one is happening.
    const da = this.camYaw - this.camAngle;
    if (da) {
      this.camAngle = Math.abs(da) < 0.0005
        ? this.camYaw
        : glide(this.camAngle, this.camYaw, ease.yaw, ease.yawMin);
      this.aimCamera();
    }
    // Readouts follow the eased angle, not the target one, so they turn *with*
    // the swing instead of snapping to the new corner while the shop is still
    // arriving there.
    // ...and the same test for the tilt, or the bars follow an orbit and ignore
    // a drag up the screen — which is the bug this pair exists to prevent, one
    // axis over. Both are compared rather than a flag set by `tiltView`, for the
    // reason the yaw is: what a readout has to match is the angle being DRAWN,
    // which the easing above is still moving.
    if (this.readoutsDirty
      || this.camAngle !== this.readoutAngle || this.camPitch !== this.readoutPitch) {
      this.readoutAngle = this.camAngle;
      this.readoutPitch = this.camPitch;
      this.readoutsDirty = false;
      this.faceReadouts();
    }
    // The follow, and the one that decides whether this reads as floaty: a
    // lerp alone leaves the camera a fixed distance behind anybody walking. See
    // `EASE` — with no floor this is exactly the lerp it has always been.
    this.camAim.copy(this.camTarget).add(this.camPan);
    if (ease.lookMin) {
      GLIDE_V.subVectors(this.camAim, this.camLook);
      const d = GLIDE_V.length();
      if (d > 1e-4) {
        const step = Math.min(d, Math.max(d * ease.look, ease.lookMin));
        this.camLook.addScaledVector(GLIDE_V, step / d);
      }
    } else {
      this.camLook.lerp(this.camAim, ease.look);
    }
    // Which lamps get a real light follows the camera, so it belongs here rather
    // than in the layout build. Cheap: it returns immediately until the view has
    // actually gone somewhere. What it lights is only ever the things that MOVE
    // — the ground is baked and sits on a layer these cannot reach, which is
    // what makes a pool that follows you acceptable again. See lights.js.
    this.lights.update(this.camLook);
    // The one line in the game that decides which camera is being drawn
    // through, and it is the line that poses it — see the constructor.
    //
    // The heading is `camAngle` and NOT `camOffset`, even though the two say the
    // same thing out there. `camOffset` is a position, so its horizontal part
    // shrinks to nothing as the pitch approaches straight down — read as a
    // direction it would be a heading that gets less certain the more you tilt,
    // and at `PITCH_MAX` it would be a heading of nothing at all. The angle is
    // the honest input, and it is also the field the two turn keys write.
    if (this.fpv) {
      this.camera = this.persp;
      const flat = Math.cos(this.fpvPitch);
      // The ortho camera stands at +x+z and looks back at the origin, so the
      // direction it is FACING at yaw 0 is the other way — which is what a head
      // stepping into that view has to inherit, or turning round is the first
      // thing you do every time.
      FPV_DIR.set(-Math.SQRT1_2 * flat, Math.sin(this.fpvPitch), -Math.SQRT1_2 * flat)
        .applyAxisAngle(AXIS_Y, this.camAngle);
      this.camera.position.set(this.camLook.x, FPV_Y, this.camLook.z);
      this.camera.lookAt(FPV_AT.copy(this.camera.position).add(FPV_DIR));
    } else {
      this.camera = this.ortho;
      this.camera.position.copy(this.camLook).add(this.camOffset);
      this.camera.lookAt(this.camLook);
    }
    // Every frame rather than on the switch, because the body being hidden is a
    // record that is rebuilt whenever the model is restaged — a promotion, a
    // redraw over MCP, a rejoin — and a visibility set once on a group that has
    // since been thrown away is a person who quietly comes back.
    this.showEye(!this.fpv);
    // Onto the texel grid rather than onto the look point — see
    // `snapToShadowTexel`. The light's DIRECTION is untouched by it (both ends
    // move together, and `SUN_OFFSET` is what separates them), so nothing in
    // the shading changes: this only decides where the depth map is sampled
    // from, which is the half that was crawling.
    snapToShadowTexel(this.camLook, SUN_AT);
    this.sun.target.position.copy(SUN_AT);
    this.sun.position.copy(SUN_AT).add(SUN_OFFSET);
    // Down here, after the view has finished moving, and that is not tidiness.
    // The off-screen signposts are the one thing in this loop whose *input* is
    // the camera — they project the world onto the frame and put something back
    // at the answer — so anywhere above this they would be reading the pose the
    // renderer used last frame, which on a pan is a whole frame of lag between
    // an arrow and the edge it is supposed to be riding. `updateMatrixWorld` is
    // what makes that true rather than nearly true: `project`/`unproject` read
    // `matrixWorldInverse`, and nothing has refreshed it since the last draw.
    // (It is exactly what `renderer.render` is about to do, so it costs one
    // matrix inversion and no correctness.)
    this.camera.updateMatrixWorld();
    // Unconditional, unlike the pip bob above: the arrows have to come DOWN when
    // there is nothing left to point at, and "nothing to point at" is precisely
    // the state with no pips to loop over.
    this.syncEdgeArrows(now);
    // See the constructor. Set the frame before it is wanted, not after: three
    // clears `needsUpdate` inside `render`, so this is a request for THIS draw.
    //
    // Two rules, and the cadence is the weaker of them now: whichever asks
    // first. A shop with nobody walking in it redraws every third frame, and
    // one with somebody in it redraws while they are moving — which is the
    // frame budget spent exactly where there is something to see. `SHADOW_SLIP`
    // has the argument.
    // The tick is stepped whatever happens, or the cadence would only ever
    // count the frames the drift rule had already declined.
    const stale = (this.shadowTick++ % SHADOW_EVERY) === 0;
    const draw = stale || this.shadowSlip > SHADOW_SLIP;
    if (draw) this.shadowSlip = 0;
    this.renderer.shadowMap.needsUpdate = draw;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Give the GPU everything back, for a page that is going away.
   *
   * Nothing did this, and a browser does not do it for you promptly: a WebGL
   * context, its buffers and its compiled programs outlive the document that
   * made them until the driver gets round to it. Reload the dev server twenty
   * times and that is twenty shops still resident — which is the report exactly,
   * memory climbing on every reload and only a tab close giving it back, because
   * closing the tab is what finally drops the contexts.
   *
   * `forceContextLoss` is the part that matters. `renderer.dispose()` frees what
   * three allocated and leaves the context itself alive; the extension is the
   * only way to say now rather than eventually.
   */
  destroy() {
    disposeGroup(this.staticRoot);
    disposeGroup(this.actorRoot);
    this.staticRoot.clear();
    this.actorRoot.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Grab the current frame as a PNG data URL (used by the MCP screenshot tool). */
  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/**
 * Everything `buildActor` reads, so a body is rebuilt when — and only when —
 * what it should look like has changed.
 *
 * Null for anyone who is not a hire: a shopper and the player never restage, so
 * their bodies are built once and left alone.
 */
function actorKey(p) {
  return p.staff
    ? `${p.staff}:${p.tier ?? 1}:${skinKey({ id: p.skin })}:${chargeBand(p.energy)}`
    : null;
}

/**
 * How charged a robot is, as a colour on the part that already glows.
 *
 * Energy has been on the wire since hires existed and had nowhere to be seen: a
 * bot on its last legs walks at `TIRED_PACE` and looks exactly like one that
 * has just come off a break, so "why is everything slow" was a question with no
 * answer on screen. The worker menu could tell you, one hire at a time, which
 * is the wrong shape for a thing you want to notice about a shop.
 *
 * It rides the `glow` tint slot, which every authored worker already has three
 * parts wearing — a skin is a palette, so lighting the charge is a palette with
 * one slot overridden and no new art, no new prop and nothing for the renderer
 * to learn. A bot with a skin keeps its chassis and trim: what changes is the
 * one part whose job was always to be the lit bit.
 *
 * BANDS rather than a gradient, and that is the whole of why it reads. A hue
 * eased continuously from green to red is a colour nobody can compare across
 * the shop — two bots four tiles apart are both "sort of orange" — and it would
 * rebuild the body on every tick of drain. Three states are three answers:
 * working, getting low, about to stop. The band is in `actorKey`, so crossing
 * one is a rebuild and staying inside one is free.
 */
/** The bar a conveyor's flow path is drawn with — see `addConveyorPaths`. */
const PATH_GEO = new THREE.BoxGeometry(1, 1, 1);

/**
 * A loader's lamp, off and on.
 *
 * Green while it is carrying something, dark while it is not — a colour rather
 * than only a pulse, because at this camera a small mesh growing and shrinking
 * is nearly invisible and a colour reads across the shop. It is the one thing on
 * a run that says which cell is working, which is what the spinning turntable
 * was trying and failing to say.
 */
const LAMP_IDLE = '#4a5160';
const LAMP_ON = '#63d489';
/**
 * ...and the third state, which is what turned the lamp from decoration into a
 * readout: the box went PAST.
 *
 * Green and dark could only ever say "there is a crate here", and a crate riding
 * past a loader that wants nothing from it is the single most useful thing a run
 * can tell you — it is what a loader aimed at the wrong shelf looks like, what a
 * freezer line with no freezer on it looks like, and what a full shelf looks
 * like. All three drew as a working machine.
 *
 * Amber rather than red, which is the same call `.fx-verb.on` makes about a
 * toggle: red in this game is a refusal or something you cannot take back, and
 * a crate carrying on down the line is neither. It is the ordinary way a run
 * works — a box passes four loaders to reach the fifth — so a shop full of red
 * lights would be a shop reporting a fault it does not have.
 */
const LAMP_PASS = '#d99b1f';

/**
 * The mark on a join, and its well.
 *
 * Unlit, and deliberately: a Lambert square lying flat on a deck takes whatever
 * the ceiling is giving it, so at the back of a dim shop the one thing that says
 * two cells are connected goes out. A basic material is the same colour wherever
 * it is standing, which is what "it lights up" means for a mesh this small — and
 * it is muted rather than bright, because there is one of these per join and a
 * long run should read as a line of quiet marks rather than a runway.
 *
 * The well is what makes it sit IN the deck instead of on it: a slightly larger,
 * darker plate under the mark, so the eye reads a recess with something lit at
 * the bottom of it.
 */
/**
 * The conveyor kinds that are a machine standing in the run rather than run.
 *
 * They wear a hood on legs: the track carries straight under it and the crate
 * stays drawn the whole way through, which is the second answer to a question
 * this got wrong once. The first was to hide the box on these cells the way a
 * tunnel does — and a tunnel can, because its span is genuinely elsewhere and
 * takes seconds, where a housing is one cell and half a second. What you got
 * was a run that stepped instead of flowing.
 *
 * So what the set decides now is which sides get WALLED. Everything a box
 * crosses stays open; everything else is closed in, which is what makes the
 * thing read as a machine with the line running through it.
 */
const COVERED_KINDS = new Set(['arm', 'sorter']);

/**
 * What is behind a machine's mouth.
 *
 * Darker than anything else on a conveyor, and deliberately not `CONVEYOR.track`
 * — a recess is the one place on the run that should read as having no light in
 * it, and at the track's grey the panel goes back to looking like a plate bolted
 * to the face. It is the only dark left in the family since the deck went pale.
 */
const MOUTH_DARK = '#1e232b';

/**
 * How much brighter a carrier gets as the flow passes over it.
 *
 * A multiplier on the baked colour rather than a colour of its own, so a belt
 * lights up in whatever it is painted and a tier authored in a different grey
 * needs nothing said about it. Clamped at 1 per channel by the caller, which is
 * what stops a pale rung blowing out to white while a dark one glows.
 *
 * Big enough to catch the eye across the shop and nowhere near a flash: this is
 * the same fact the old sliding carriers carried, and the reason they went is
 * that a busy shop should not have forty things twitching in it.
 */
const SLAT_LIT = 1.1;

/** Scratch for that, so a frame with hundreds of carriers allocates nothing. */
const SLAT_RGB = new THREE.Color();

/**
 * How big a crate is while it is riding, against the one that is standing still.
 *
 * ONE, and the history is the point. It was 0.72, because a pallet was sized as
 * a thing somebody put down with both hands — most of a tile — and a conveyor is
 * a quarter-tile track threading between machines 0.78 across: at full size it
 * overhung the rails and clipped the housings it passed into, which reads as the
 * machines being drawn in the wrong place rather than as the box being too big.
 *
 * That was a fix for a crate 0.52 across, and the crate is 0.442 now — so the
 * clearance it was buying is already paid for by the box itself, and what the
 * scale is left doing is the thing you can actually see: the same box shrinks as
 * it steps onto the belt and swells as a loader sets it down. A crate is one
 * object in this game, in one size, and "smaller while in transit" is a sentence
 * nothing else here says.
 *
 * Kept as a named 1 rather than deleted, because the pressure that made it 0.72
 * has not gone anywhere: the next machine drawn tighter than its track will want
 * this again, and the answer then is to widen the HOUSING. A box that changes
 * size to fit through a door is the door being wrong.
 */
const BELT_CRATE = 1;

/** Where the top of the track is — what a machine's side walls stand on. */
const BELT_TOP = 0.09;

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
const DUCT_HALF = 0.34;
const DUCT_PANE = 0.02;
const DUCT_WALL = 0.3;

/** ...and the collar an overhead loader drops its goods through. */
const DUCT_CHUTE = 0.34;
const DUCT_DROP = 0.34;

/**
 * How WIDE a rise's post is — step 9's join mark, which spans deck to deck.
 *
 * Thin is how it pays for reaching all the way. `DUCT_DROP`'s argument against
 * a full shaft is about the aisle the ceiling was bought to clear, and it holds
 * for a chute a crate has to fit down; a mark does not have to fit anything, so
 * it can join the two storeys honestly at a fifth of the width and still let
 * you see the shelf behind it. Stubbed instead — which is how it shipped — it
 * reads as a length of pipe on the roof of a machine, saying that nothing is
 * connected.
 */
const RISER_POST = 0.07;

/**
 * How long a crate takes to cross one TILE of track — the server's own
 * `Game.BELT_SECONDS`.
 *
 * A spur is a length of the same run, so what crosses it moves at the rate
 * everything else on the run moves at, and its duration is its length times
 * this (`Scene.slideSeconds`). It replaced a flat `SLIDE_SECONDS`, which made
 * the short hop into a shelf and the full tile out onto a pad take the same
 * time — two lengths of identical track running at visibly different speeds,
 * which reads as one of them being broken.
 *
 * Duplicated from the sim rather than sent, the way `BELT_DECK` and the rest of
 * this file's geometry is: it is a constant of the fixture, not a fact about the
 * shop, and a tier's `speed_mult` moves both ends together anyway. The bound
 * that matters is the server's `ARM_SAY_SECONDS` (1.2) — the longest spur here
 * is 1.34 tiles, so the longest slide is 0.80s, and a slide that outlasted the
 * window would still be running when the next swing arrived.
 */
const BELT_SECONDS = 0.6;

/**
 * How far out of the machine's own centre a spur's track runs.
 *
 * `FROM` is under the housing rather than at its edge, `UNIT` stops just inside
 * an occupied tile, and `OPEN` crosses most of a bare one. All three are read
 * through `conveyorSpurs` and nowhere else — see there.
 */
const SPUR_FROM = 0.16;
const SPUR_UNIT = SPUR_UNIT_REACH;
const SPUR_OPEN = SPUR_OPEN_REACH;

/**
 * Half the drop pad, which is a BORDER rather than a plate.
 *
 * A crate is 0.442 across, so this is drawn a hair wider than a box: four thin
 * bars marking out the square the goods land on, with the shop's own floor
 * inside them. It was a solid slab first and that is the thing to avoid — a
 * plate under a crate reads as one more piece of belt the box has stopped on,
 * where the whole sentence here is *the track ends and the goods are set down*.
 * With only a border, what you see is a crate sitting on the floor with the
 * landing square painted round it.
 */
const SPUR_PAD = 0.26;
const SPUR_PAD_BAR = 0.05;

const LINK_GLOW = '#5f9e78';
// Retired, along with the recess itself — see the note where `CONVEYOR.well`
// used to be. A join mark lies on the ground now and needs no socket.
let LINK_MAT = null;
const linkMaterial = () => {
  LINK_MAT ??= new THREE.MeshBasicMaterial({ color: new THREE.Color(LINK_GLOW) });
  return LINK_MAT;
};

/**
 * ...and the same mark once it started saying what the run is DOING.
 *
 * One material per state rather than one per mark, kept at module level and
 * never disposed. Two reasons, and the second is the one that bites:
 *
 * - A state change becomes `mesh.material = mat`, a pointer swap, instead of a
 *   `Color.set` on every mark of every cell.
 * - `disposeGroup` frees no mesh materials on purpose — almost every mesh in
 *   the game wears the shared `material()` cache — so anything that mints its
 *   own per mesh leaks one per re-flow, and build mode re-flows on every wall
 *   segment of a drag. A busy shop has hundreds of these marks.
 *
 * Basic rather than Lambert, like the mark it replaces: nothing shades it, so
 * it is the same colour at the dark end of the shop as at the lit end — which
 * is what "it lights up" means for a mesh this small, and the entire reason the
 * readout still works at night when the deck under it does not.
 */
const FLOW_MATS = new Map();
const flowMaterial = (hex) => {
  let m = FLOW_MATS.get(hex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex) });
    FLOW_MATS.set(hex, m);
  }
  return m;
};

/**
 * The two ENDS of a run, which the join marks cannot say.
 *
 * A join mark is drawn where two cells hand over, so a run that works is a line
 * of them and a run that does not is the same line with a gap somewhere — which
 * is a fact about the cell you are NOT looking at. The two ends are the ones
 * that cost you a shop: a cell nothing hands to only ever receives goods by
 * hand, and a cell that hands to nothing is where the line stops.
 *
 * Neither is an error. A head standing on your bay is the ordinary way goods get
 * onto a run, and a loader dead-ending against the shelf it fills is the whole
 * point of a loader. What they are is the two places a run can silently not be
 * connected to the rest of the shop, and until now the art said nothing at all
 * about either — a branch nothing feeds draws exactly like a branch that works.
 *
 * Amber for a head and red for a tail, on the same argument `CHARGE_LOOK` makes:
 * two states are two colours, and a reader who cannot tell them apart still sees
 * that this cell is one of the ends. Basic materials for `linkMaterial`'s reason
 * — these lie flat on a deck and must not go out at the back of a dim shop.
 */
const END_HEAD = '#e0a341';
const END_TAIL = '#e2564a';
/** How thick a pip is, which is also how far its centre clears the deck top. */
const PIP_H = 0.02;
/**
 * ...and where it sits on a cell whose art declares no deck at all.
 *
 * A fallback rather than the number, because every conveyor in the game has a
 * track and `conveyorDeck` finds it — this is for a piece somebody authors this
 * afternoon with nothing a tile wide on it. It matches the join marks' own
 * height on the shipped belt, so an unreadable model is drawn at the height the
 * rest of the run is rather than at the height this mark used to be.
 */
const PIP_Y = 0.097;
let END_MATS = null;
const endMaterial = (tail) => {
  END_MATS ??= [END_HEAD, END_TAIL]
    .map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c) }));
  return END_MATS[tail ? 1 : 0];
};

/**
 * Which way goods cross a loader's edge — ON to the line, or OFF it.
 *
 * Colour AND direction rather than direction alone. The arrowhead is the fact,
 * but a shop is read at a glance from across the room and at that size a
 * quarter-tile arrow is a smudge: what survives is the colour, which is the same
 * argument `stripes` makes about a pattern on the ground.
 *
 * Green comes on, amber goes off — the way in is the way the shop gains, and
 * amber is already what a run's HEAD wears, which is the same claim about the
 * same thing said one cell earlier.
 */
const CHEV_IN = '#5fbf8a';
const CHEV_OUT = '#e0a341';

/**
 * The arrowhead itself, as ONE flat dart rather than two crossed bars.
 *
 * Two boxes at forty-five degrees is what everything else on this deck is made
 * of and it is the wrong tool here: they overlap at the apex, so the point — the
 * one part of an arrow that carries the meaning — comes out as a thick lump,
 * and at this camera a lump with two tails reads as an X.
 *
 * Four points and two triangles: a tip, two barbs, and a notch between them. The
 * notch is what keeps it from reading as a play button, and it costs one vertex.
 * Authored pointing +x, the same convention every model in the game uses, so
 * `rotation.y` aims it and nothing else has to know.
 *
 * One geometry for every arrow in the shop — it is never scaled per instance, so
 * the size lives here rather than in four `scale.set` calls that could drift.
 */
const ARROW_GEO = (() => {
  const g = new THREE.BufferGeometry();
  const tip = 0.17;
  const back = -0.09;
  const notch = -0.02;
  const half = 0.13;
  // Wound so both faces point UP. Get this backwards and the arrows are built,
  // positioned and aimed perfectly, and every one of them is culled — the scene
  // says 23 darts and the floor says none, which is a shape you cannot tell from
  // "the code never ran".
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    tip, 0, 0, notch, 0, 0, back, 0, half,
    tip, 0, 0, back, 0, -half, notch, 0, 0,
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(
    Array.from({ length: 6 }, () => [0, 1, 0]).flat(), 3,
  ));
  return g;
})();
let CHEV_MATS = null;
const chevronMaterial = (inward) => {
  CHEV_MATS ??= [CHEV_OUT, CHEV_IN]
    .map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c) }));
  return CHEV_MATS[inward ? 1 : 0];
};

/**
 * The four things a loader or a sorter can be aimed at. See `aimKind`.
 *
 * Deliberately NOT the join green. A join says goods cross this edge and is
 * drawn on all four sides of a loader; this says which side you chose, and the
 * two sharing a colour would read as the aim being the only way out.
 *
 * `dead` is the loud one and is still not red — a loader aimed at a wall is a
 * piece doing three quarters of its job, where red on this deck already means a
 * run that stops. Grey against three lit colours is "this one says nothing",
 * which is exactly the claim.
 *
 * There is no colour for "aimed at the run". That edge carries a join already
 * and the join moves with the aim, so the bar is suppressed rather than drawn
 * beside it — two marks on one edge read as a join that has gone wrong.
 */
const AIM_LOOK = { unit: '#79b6d8', drop: '#c98b52', dead: '#565c66' };
const AIM_MATS = new Map();
const aimMaterial = (kind) => {
  if (!AIM_MATS.has(kind)) {
    AIM_MATS.set(kind, new THREE.MeshBasicMaterial({
      color: new THREE.Color(AIM_LOOK[kind] ?? AIM_LOOK.dead),
    }));
  }
  return AIM_MATS.get(kind);
};

/** A mesh that is drawn and never pointed at. */
const NO_PICK = () => {};

const CHARGE_LOOK = ['#8fe39a', '#ffcf6b', '#e2564a'];
const chargeBand = (e) => (e == null ? -1 : (e > 0.6 ? 0 : e > 0.3 ? 1 : 2));

/**
 * Every fixture in a layout as one uniform list.
 *
 * The same shape the server works over in build mode. Both sides having their
 * own idea of what a fixture is, is how a menu ends up acting on something the
 * player never pointed at.
 */
/**
 * How high a crate is drawn — the floor, a belt deck, or somewhere between.
 *
 * `d.deck` is a FRACTION rather than a storey (see `stepBelts`), so a box on a
 * lift is drawn part way up the shaft. Rounding it to a deck would make the one
 * part of an overhead run there is anything to watch happen in a single frame.
 */
/** How far a conveyor cell's world-space marks are lifted by its storey. */
const deckLift = (c) => (deckOf(c) === CEILING ? CEILING_Y : 0);

function crateY(d, at) {
  if (!d.belt) return at * CRATE_STEP;
  // `CEILING_Y` is where an overhead cell's model ORIGIN sits, so the box rides
  // `BELT_DECK` above that — the same gap it rides above a belt on the floor,
  // because it is the same distance above the same tray. Lerping between the
  // two decks instead put the crate 0.1 too low all the way up and left it
  // sitting under the pan of its own duct at the top.
  return (d.deck ?? 0) * CEILING_Y + BELT_DECK;
}

function fixturesIn(L) {
  if (!L) return [];
  return [
    ...(L.shelves ?? []).map((s) => ({ ...s, kind: shelfKind(s.kind) })),
    ...(L.checkouts ?? []).map((c) => ({ ...c, kind: 'checkout' })),
    ...(L.stations ?? []).map((s) => ({ ...s, kind: 'station' })),
    ...(L.plots ?? []).map((p) => ({ ...p, kind: 'plot' })),
    ...(L.pens ?? []).map((p) => ({ ...p, kind: 'pen' })),
    ...(L.bins ?? []).map((b) => ({ ...b, kind: 'bin' })),
    ...(L.belts ?? []).map((b) => ({ ...b, kind: 'belt' })),
    ...(L.arms ?? []).map((a) => ({ ...a, kind: 'arm' })),
    ...(L.sorters ?? []).map((s) => ({ ...s, kind: 'sorter' })),
    ...(L.unders ?? []).map((u) => ({ ...u, kind: 'under' })),
    ...(L.lifts ?? []).map((f) => ({ ...f, kind: 'lift' })),
    // Decorations carry their own kind, because there is more than one of them
    // and which list they came out of no longer says which.
    //
    // LAST, and that is a rule rather than tidiness: `fixtureAt` is a `find`,
    // a decoration is the one fixture that stamps no tile, and so the order of
    // this list IS the tie-break for a cell holding two things. A hanging lamp
    // must never win one — it owns nothing, it is merely drawn over the cell —
    // and that is exactly what `fixtureAt`'s own note says it relies on. It was
    // true when props were written and stopped being true the day a conveyor
    // was added underneath them, which is a one-line reorder and reads in the
    // game as a machine you cannot open under a light.
    ...(L.props ?? []),
  ];
}
