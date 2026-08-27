/**
 * THE RENDERER.
 *
 * Isometric orthographic camera over a flat-shaded, low-poly world. Static
 * geometry (the ground, walls, shelf units, fences) is built once per layout
 * change as instanced meshes; only the things that actually move — people,
 * crops, shelf stacks — are touched per frame.
 */

import * as THREE from 'three';
import { PALETTE, TILE_STYLE, PAD_MARK, FIXTURE_LOOK, EDGE_STYLE, CEILING_Y, GLASS, CONVEYOR, CONVEYOR_LIT, SURROUND_COLORS, conveyorAccent, bondOf, brickBond, edgeBands, frameTint, jitter, faceColor, patternColor, shade, stripeBars, stripeDuty, tuftDensity, tuftBlade } from './palette.js';
import { buildSurround, apronMaterial, surroundGround, HAZE } from './surround.js';
import { surroundOf, DEFAULT_SURROUND } from '../../shared/surrounds.js';
import {
  characterParts, crowdRig, crowdLocals, crowdExtent, crowdBatchAssets,
  buildModel, buildCharacter, buildStack, buildShelfGoods, shelfShow,
  buildBubble, buildCashDrop, buildVehicle,
  buildStationBays,
  buildTextSprite, setTextSprite, buildMoneyLabel, moneySaid,
  buildPallet, CRATE_STEP, BELT_DECK, buildProgressRing, setRingProgress, buildGhost,
  buildSoil, buildFixtureGhost, buildTargetMarker, buildEdgeArrow, buildCageMarker, buildContour, buildWorkSpot, disposeGroup, material,
  buildGrowthBar, setGrowthBar,
  buildRipple,
  buildStamp,
  buildFootMark,
  buildPadGlyph,
  weld, paintLit, characterMaterial, PERSON_H,
  collectEdges, buildEdgeLines, mergeEdges,
} from './props.js';
import { Heat } from './heat.js';
import { T } from '../../shared/tiles.js';
import {
  FIXTURES, workSpots, flowSpots, conveyorNext, conveyorAt, conveyorsOf, conveyorBranches, tunnelExit, CONVEYOR_KINDS, derivedFlow, anchorTile, spotsOf, canPlace, turn, rot4, groundIndex, groundKindOfTile, isProp, shelfKind, GOODS_PADS, isPadAt, isWalkableTile,
  SPUR_UNIT_REACH, SPUR_OPEN_REACH,
  faceKey, covers, footprintMid, sizeOf, deckOf, CEILING, armReach,
  conveyorLines, conveyorLoops, unitOn, conveyorMeets,
} from '../../shared/build.js';
import { pieceFor, surfaceOf } from '../../shared/pieces.js';
import { hash01 } from '../../shared/hash.js';
// Only for the wall's own thickness, which the paint ghost has to stand proud
// of — see `setFaceGhost`. Everything else in here reads edge kinds as the raw
// numbers the layout carries, through `EDGE_STYLE`.
import { E, SOLID, edgeBetween, wayBase } from '../../shared/edges.js';
import {
  Lights, emittersIn, windowsIn, BAKED_LAYER, SURROUND_LAYER,
} from './lights.js';
import { Ink } from './post.js';
import { GpuClock } from './gpu-clock.js';
import {
  lookOn, setLookOn, viewPref, rememberView,
  AMBIENT_NOON, SUN_NOON, BOUNCE_LOOK, SUN_DUSK_LEVEL, AMBIENT_DUSK_LEVEL,
  SKY_TOP, SKY_HORIZON,
  SHADOW_SPAN_MIN, SHADOW_SPAN_STEP, SHADOW_MARGIN,
  SHADOW_BIAS, SHADOW_NORMAL_BIAS_TEXELS, SHADOW_MAP_LOOK,
  INK,
} from './look.js';
import {
  isStaged, stageIndexAt, tierProgress, partsAt, modelHeight, modelBounds, surfacesAt, drawableBoards,
  boardsForShare,
  variantModel, variantWork, skinKey,
} from '../../shared/model.js';
import { SIGNAL_NAMES, signalValue } from '../../shared/signals.js';
import { buildTileGrid, disposeTileGrid } from './tile-grid.js';
import { buildPastimeProp, animateRest } from './pastime.js';
import { animateEmote } from './emote.js';
import { animateFace } from './face.js';
import { buildLoopingProp, animatePuffs, animateMotion } from './motion.js';

/** How many world tiles fit vertically on screen at 1× zoom. Smaller = closer in. */
const FRUSTUM = 17;

/**
 * Zoom rides on `camera.zoom` rather than on FRUSTUM, so the frustum stays a
 * fixed statement about the world and only resize() ever recomputes it. Three's
 * `unproject` already folds zoom into the inverse projection, which is why
 * pickTile and pickFixture keep working at any zoom without knowing it exists.
 */
// The charge ring, floated clear of a crown. Off `PERSON_H` rather than a
// number matched to a head once: it was 1.2 against a head that stood at 0.96,
// and the day everybody grew that same 1.2 would have been drawn through their
// faces. The clearance is what is authored here; how tall they are is not this
// file's fact.
const RING_Y = PERSON_H + 0.26;

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
 *
 * The FOV is the one number of the four that is SOMEBODY'S, which is why it is
 * a range and a stored preference rather than a constant. It shipped at 74°,
 * which is a vertical angle — about 106° across a 16:9 screen — and that is
 * wide enough that the near edges of the frame stretch: an aisle you are
 * standing in bows outward, and what that reads as is the shop being drawn
 * wrong rather than the lens being wide. It also makes a shelf you are walking
 * up to arrive very fast and then hang there, which is the half people feel and
 * do not have a word for. 65° is a little under 97° across, which is an
 * ordinary first-person lens, and the ends of the range are the two honest
 * extremes: 50 is a rifle scope and 85 is the fisheye back.
 *
 * A number and not a switch, because there is no right answer — it is a fact
 * about the person, the screen and how close they sit to it. So it is stored in
 * `sns-view` beside the look and the camera pose (see `viewPref`), and never on
 * the save: two people in one shop do not share a lens, and being handed a
 * second world does not change how wide you like it.
 *
 * `FPV_SPEED` in server/sim/index.js is the one thing downstream of it and is
 * deliberately NOT re-derived from it. Walking pace is a number the server
 * knows and this is a preference the client keeps, so tying them would put a
 * balance figure behind a menu row — and the sentence that made first person
 * slow (there is very little near the edge of the frame to sweep past you) is
 * about a wide lens, so a narrower one only ever makes that reading truer.
 */
const FPV_FOV = 65;
const FPV_FOV_MIN = 50;
const FPV_FOV_MAX = 85;
/** Per press of the stepper in the menu. Five degrees is about the smallest
 *  step you can see one of on your own screen. */
const FPV_FOV_STEP = 5;
const storedFov = () => clamp(
  Math.round(Number(viewPref('fov', FPV_FOV)) || FPV_FOV), FPV_FOV_MIN, FPV_FOV_MAX,
);
// Eye height, as a fraction of stature rather than a number — 0.94 is about
// where a real pair of eyes sits, and it has to be derived for `RING_Y`'s
// reason twice over: a fixed 0.88 was under the crown of a 0.944 body and would
// have left first person at chest height on a 1.28 one, which is the complaint
// that produced `PERSON_H` in the first place.
const FPV_Y = PERSON_H * 0.94;
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
 * The floors are quoted per FRAME OF 60Hz, and `gainFor` is what makes that a
 * unit rather than a coincidence — see below. `look` in cinema is 0.055 of a
 * tile, about 3.3 tiles a second, which is comfortably above a *shopper's* walk.
 * `yaw` is 0.0075 radians, about 26° a second: a slow pan you would have set on
 * a tripod, and the gain above it is what takes over when you throw the drag.
 *
 * The gains went back UP when the floors went in. They were low because low was
 * the only smoothing knob there was; with a floor doing the tracking, the gain
 * is only shaping the ease-out, and a low one there is what read as syrup.
 *
 * ...and the ordinary camera got a floor of its own in the end, which is the
 * argument three paragraphs up finally being applied to the person it was
 * written about. `lookMin: 0` left the playing camera as exactly the spring that
 * note describes — fastest at the start, asymptotic at the end, and never
 * arriving while the thing it chases is still moving — so walking anywhere slid
 * the whole shop under your feet and stopping glided it back. Cinema was given
 * the dolly and the player was left on the spring.
 *
 * It is nearly twice cinema's, and the number is arithmetic rather than taste:
 * a floor is only a floor while it out-paces what it is chasing, and what this
 * one chases is YOU. `PLAYER_SPEED` is 4.2 tiles a second and `SPRINT_SPEED`
 * multiplies it to 6.72, so anything under 0.112 a frame is a camera that keeps
 * pace with a walk and reverts to the old trailing spring the moment somebody
 * holds Shift — which would read as sprinting being the broken part.
 *
 * Zoom gets no floor on purpose: it is the one of the four that is never
 * chasing a moving target — a wheel notch is a fixed distance, so the spring
 * arrives on its own and a floor would only put a snap on the last of it.
 */
const EASE = {
  look: 0.08, lookMin: 0.12, yaw: 0.14, yawMin: 0, zoom: 0.18, tilt: 1, tiltMin: 0,
};
const CINE_EASE = {
  look: 0.09, lookMin: 0.055, yaw: 0.10, yawMin: 0.0075, zoom: 0.09, tilt: 0.12, tiltMin: 0.006,
};

/**
 * The frame the gains and floors above are quoted against.
 *
 * Every other easing in this file is against `dt` — `ACTOR_CHASE`,
 * `VEHICLE_CHASE`, `CROWD_EASE` — and each says why: a fixed fraction per frame
 * is a different camera on every machine. The camera pose was the one loop still
 * on a raw per-frame fraction, and it is the loop where that matters most,
 * because the camera moves the WHOLE SCREEN. At 30fps `look` was half as
 * responsive and the floor would have been half the speed, so the view trailed
 * twice as far behind a walk on exactly the machine already struggling to draw
 * it — which reads as the game getting sloppier as it gets slower, and is the
 * two of them compounding rather than one cause.
 */
const EASE_HZ = 60;

/**
 * A gain quoted per 60Hz frame, said for a frame that actually lasted `dt`.
 *
 * The compounding form rather than `gain * dt * 60`: a lerp is repeated
 * multiplication by `1 - gain`, so the honest way to ask for two frames' worth
 * is to square it. Linear scaling overshoots past a gain of 1 on a slow frame,
 * which is a camera that snaps on precisely the frames that hitched.
 */
const gainFor = (gain, dt) => (gain >= 1 ? 1 : 1 - Math.pow(1 - gain, dt * EASE_HZ));

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

/**
 * How thick the apron is, which was 0.4 and never mattered until something went
 * down through it.
 *
 * A tunnel's well is a hole cut in this slab, and a hole in a slab that is
 * shallower than the well is a shaft with its bottom hanging out of the underside
 * of the world — visible from any flattened camera as a box floating under the
 * shop. Kept comfortably past `UNDER_WELL_FLOOR` rather than derived from it: the
 * only thing depth costs is a number in a geometry constructor.
 */
const GROUND_DEEP = 1.2;

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
/*
 * How far off the centre line a kit has to be authored before it counts as
 * held in ONE hand rather than in both — see `syncKit`. A shoulder sits at
 * 0.255, so this is comfortably inside "out at the hip" and comfortably
 * outside "in front of me".
 */
const HAND_SIDE = 0.13;
/*
 * What the arms do while the hands are full, in radians forward off the
 * shoulder. A crate is held higher and tighter than a loose armful; a bag
 * hanging off one hand needs neither, because it swings WITH that arm.
 *
 * `ARM_HELD` is how much of the walking counter-swing survives. Not zero: arms
 * welded rigid to a body read as a mannequin being slid across the floor, and
 * the whole point of the gait is that it says somebody is walking.
 *
 * `ARM_ONE_HANDED` quietens BOTH arms rather than only the one with the bag on
 * it, which is not an approximation — somebody carrying a full bag walks
 * differently, and a free arm still swinging its whole stride beside a loaded
 * one reads as the loaded one being broken.
 */
const ARM_LIFT_CARRY = 1.0;
const ARM_LIFT_HAUL = 1.18;
const ARM_HELD = 0.16;
const ARM_ONE_HANDED = 0.45;

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
  // A batched body has no meshes to measure, so it carries the answer instead —
  // computed off the part list by the same corner-by-corner arithmetic this
  // does, which is why the two agree to the float. See `crowdExtent`.
  if (obj.userData.crowd) return obj.userData.crowd.extent;
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return { footY: 0, headY: 1.5, halfW: 0.34 };
  return {
    footY: Math.min(box.min.y, 0),
    headY: Math.max(box.max.y, 0.4),
    halfW: Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 0.3) / 2,
  };
}

/**
 * THE CROWD, as two draws instead of six hundred.
 *
 * A shopper is twenty boxes — torso, four limb segments, a head, a face, hair,
 * a beard — and `weld` already got that down to seven meshes by merging what
 * shares a colour. Seven is the floor for a welded body, because the four limbs
 * pivot independently and the head's colour is flushed per shopper, and seven
 * times eighty people is most of what this renderer spends its frame on: 645 of
 * the 1,392 meshes in `actorRoot` on a busy evening, each one walked, frustum
 * tested, and submitted as its own draw call, twice over once the shadow pass
 * has had its turn.
 *
 * Every one of those boxes is the SAME BOX. So they stop being meshes: one unit
 * geometry, one instance per part, a matrix and a colour each, and the whole
 * crowd is two draw calls — one for what casts a shadow and one for what does
 * not, which is the only axis `castShadow` cannot express per instance.
 *
 * The skeleton stays real (`crowdRig`), and that is what keeps the change
 * cheap: `animateActors` still writes four rotations, a basket still hangs off
 * a `hold` group, `animateRest` still tilts the root. Five empty groups per
 * person, nothing on them to draw.
 *
 * `frustumCulled` is OFF, deliberately. One instanced mesh spans the whole
 * shop, so its bounding sphere covers everything and culling it is a decision
 * about the entire crowd at once — always wrong in one direction or the other,
 * and it costs a sphere test to get there. Per-instance culling is what the
 * batch traded away, and it was worth it: only 11% of shoppers are off screen
 * at play zoom, measured, so the culling this replaces was rejecting almost
 * nothing for a test per mesh per pass.
 *
 * Slots are handed out one part at a time from a free list rather than in
 * contiguous runs per person. A shop is a churn — somebody leaves every few
 * seconds — and contiguous blocks fragment under that until a new shopper
 * cannot be placed in a batch that is mostly empty.
 */
class CrowdBatch {
  constructor(cap) {
    const { geometry, material: mat } = crowdBatchAssets();
    this.cap = cap;
    this.mesh = {
      cast: new THREE.InstancedMesh(geometry, mat, cap),
      flat: new THREE.InstancedMesh(geometry, mat, cap),
    };
    this.mesh.cast.castShadow = true;
    this.mesh.flat.castShadow = false;
    for (const which of ['cast', 'flat']) {
      const im = this.mesh[which];
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Nothing is drawn until somebody claims a slot. `count` tracks the high
      // water mark rather than the live population, because the instances below
      // it are a free list with holes in — a hole is parked at zero scale.
      im.count = 0;
    }
    this.free = { cast: [], flat: [] };
    this.top = { cast: 0, flat: 0 };
  }

  /** A slot per part, or null if the batch is full — see `Scene.crowdBody`. */
  claim(parts) {
    const out = new Array(parts.length);
    const taken = [];
    for (let i = 0; i < parts.length; i++) {
      const which = parts[i].shadow ? 'cast' : 'flat';
      let slot;
      if (this.free[which].length) slot = this.free[which].pop();
      else if (this.top[which] < this.cap) slot = this.top[which]++;
      else { this.giveBack(parts, out, i); return null; }
      out[i] = slot;
      taken.push(which);
      this.mesh[which].count = Math.max(this.mesh[which].count, slot + 1);
    }
    return out;
  }

  giveBack(parts, slots, upTo = slots.length) {
    for (let i = 0; i < upTo; i++) {
      if (slots[i] == null) continue;
      const which = parts[i].shadow ? 'cast' : 'flat';
      this.hide(which, slots[i]);
      this.free[which].push(slots[i]);
    }
  }

  setMatrix(which, slot, m) { this.mesh[which].setMatrixAt(slot, m); }

  setColour(which, slot, c) { this.mesh[which].setColorAt(slot, c); }

  /** A slot nobody is standing in, parked where it cannot be seen. */
  hide(which, slot) { this.mesh[which].setMatrixAt(slot, HIDDEN_M4); }

  flush() {
    for (const which of ['cast', 'flat']) {
      const im = this.mesh[which];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}

/** How many boxes the crowd may draw at once. ~20 a body, so 200-odd people. */
const CROWD_CAP = 4096;

/** Where an unused instance is parked: scaled to nothing, so it covers no pixel. */
const HIDDEN_M4 = new THREE.Matrix4().makeScale(0, 0, 0);

/** Scratch for the per-part compose, which runs thousands of times a frame. */
const CROWD_M4 = new THREE.Matrix4();
const CROWD_COL = new THREE.Color();

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
 *
 * ...and it came down again to 1.6MP, this time against a MEASUREMENT of the
 * thing the paragraph above could only reason about. `EXT_disjoint_timer_query`
 * gives the GPU's own elapsed time per frame, which is the number none of the
 * profiling in here could see — and on a half-screen retina window at 2.5MP a
 * frame was 8.0ms of GPU against a 25ms budget, a third of it, with the shop
 * standing still. The same frame at dpr 1.0 was 3.65ms. Every other dial tried
 * was smaller: 4x MSAA down to 2x is 8.0 -> 7.0, MSAA off altogether is 4.9,
 * and the half-float target down to a byte one is 4.9 -> 4.7, which is noise.
 *
 * So the cost is PIXELS and it always was — which is what the paragraph above
 * says, and the reason it is worth restating is that the two obvious-looking
 * knobs in this file (the sample count and the buffer format) are the two that
 * barely move.
 *
 * IT STAYS AT 2.5MP, and the attempt to lower it is written down because the
 * measurement says to and the screen says not to. 1.6MP was tried: dpr lands on
 * 1.28, GPU falls to 5.1ms, and the long diagonals this shop is made of — a
 * shelf edge, the lip of a counter — come back visibly stepped. 2.0MP was tried
 * next and could not be told from 2.5 at all: 8.44ms against 8.04, which is
 * inside the noise between two page loads, so it was paying real sharpness for
 * a saving that could not be demonstrated.
 *
 * The general shape, and it is why this is a comment rather than a smaller
 * number: GPU cost here is close to LINEAR in pixels and so is the sharpness,
 * so there is no efficient point on this dial to find — every millisecond taken
 * off comes straight out of the one part of the frame anybody looks at. Tune it
 * against a screenshot of an aisle, never against a millisecond, and go and
 * find the cost somewhere that is not the picture.
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
 * ...and the same pair when the map is FITTED to the view rather than fixed.
 *
 * Cel + Ink wants the hardest shadow in the game and gets it by spending more
 * texels on less ground rather than by dropping the filter — see
 * `SHADOW_SPAN_MIN` in look.js for why the span, the map size and the tap are
 * one decision. So the span becomes a fact about what is on screen, and
 * everything derived from it has to follow: `snapToShadowTexel` takes the texel
 * as an argument rather than
 * reading the constant, and the redraw threshold is computed beside it. A snap
 * rounding to a grid the map no longer has is exactly the shimmer the snap
 * exists to remove, and it would be invisible in this file.
 *
 * The span is quantised so it stands still while the zoom eases: a value that
 * slid continuously would move the grid under the snap on every frame of a
 * pinch, which is the same shimmer arriving by the other door.
 */
/** How many texels the map is, which the look pays to double. */
const shadowMapSize = () => (lookOn() ? SHADOW_MAP_LOOK : SHADOW_MAP);
const shadowTexelFor = (span) => (span * 2) / shadowMapSize();

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
function snapToShadowTexel(p, out, texel = SHADOW_TEXEL) {
  const a = Math.round(p.dot(SUN_X) / texel) * texel;
  const b = Math.round(p.dot(SUN_Y) / texel) * texel;
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

/** ...and the same quarter of whatever texel the fitted map is on that frame. */
const shadowSlipFor = (texel) => texel / 4;

/** Scratch for the ink pass's target sizing, which runs once a frame. */
const DRAW_SIZE = new THREE.Vector2();

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

/**
 * The batch an INTERNAL wall goes in — one with shop floor on both sides.
 *
 * It carries no direction, and that is only affordable because these FADE rather
 * than disappear. A partition is symmetric, so there is no near side to test:
 * the honest question is whether this one stands between the camera and what you
 * are looking at, which was built, and which is *finicky* — walls flicking in
 * and out as you walk past a doorway, each pop asking to be explained. Ghosting
 * them removes the reason to be clever. A partition that fades when it did not
 * need to costs you almost nothing, where one that vanishes costs you the room,
 * so the whole per-line test collapses into "all of them, softly".
 */
const FACE_IN = 'in';
const FACE_IN_VEC = { fx: 0, fz: 0, always: true };

/**
 * A face key -> the direction it points, as a plain pair on the ground.
 *
 * Two spellings reach this: an EDGE's, which is one axis and a sign ('x+'), and
 * a VERTEX's, which is the two summed and can be diagonal ('1,-1'). They are one
 * question — which way does this piece of masonry look — so they answer through
 * one function rather than two, and '' is a piece with no outside, which is the
 * only value `ghostNearWalls` treats as "never".
 *
 * Not a `Vector3`: this is read once per mesh per frame and a dot product of two
 * numbers is the whole of what anybody wants from it.
 */
function faceVector(key) {
  if (!key) return null;
  if (key === FACE_IN) return FACE_IN_VEC;
  if (key.includes(',')) {
    const [fx, fz] = key.split(',').map(Number);
    return fx || fz ? { fx, fz } : null;
  }
  const s = key.endsWith('+') ? 1 : -1;
  return key.startsWith('x') ? { fx: s, fz: 0 } : { fx: 0, fz: s };
}

/**
 * The distinct cells a batch of boxes stands on, flat as [x, z, x, z, …].
 *
 * What `ghostNearWalls` measures against, and it is DEDUPED because the count is
 * the whole reason it is precomputed: a painted wall is a body, a skin either
 * side and a course of brick on each of those, so one cell of it is a dozen
 * boxes at the same two coordinates. A shop's worth is a few dozen cells and
 * several thousand boxes.
 *
 * A pier names `x`/`z` and a band names `cx`/`cz` — same fact, two spellings,
 * and both arrive here rather than being unified at the call sites, because the
 * band's pair is the CELL while its own position carries a thickness offset and
 * an offset along the run. It is the cell that is wanted.
 */
function cellsOf(items) {
  const seen = new Set();
  const out = [];
  for (const b of items) {
    const x = b.cx ?? b.x;
    const z = b.cz ?? b.z;
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x, z);
  }
  return Float32Array.from(out);
}

/** Group things carrying a `face` by it, preserving order. One instanced mesh each. */
function byFace(items) {
  const out = new Map();
  for (const item of items) {
    const key = item.face ?? '';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

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
 * the frustum in about a second however far out you are, which is the same
 * relationship a drag has and the one the eye is expecting.
 */
const FLY_SPEED = 18;

/** How far past the edge of the world the free camera may look, in tiles. */
const FLY_MARGIN = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Scratch for aiming readouts at the camera, so no frame allocates one. */
const YAW_Q = new THREE.Quaternion();
/** ...and the matrix the tilt half of that aim is read out of. See `faceReadouts`. */
const AIM_M = new THREE.Matrix4();
const ORIGIN = new THREE.Vector3();

/**
 * The press ripple: how long it lives, and the widths it travels between.
 *
 * Short on purpose. This is a receipt for an input, not an effect — long
 * enough to catch out of the corner of your eye while you are already looking
 * somewhere else, short enough that pressing four times in a row does not
 * leave four of them stacked up arguing.
 *
 * These are *spans* and not radii, because the mark is a square frame built
 * unit-sized the way the stamp is: `RIPPLE_TO` is how many tiles across it
 * finishes. Which is also why the numbers do not look like the ones they
 * replaced — the old pair drove a radius, so 0.46 was 0.92 of a tile wide.
 */
const RIPPLE_MS = 420;
const RIPPLE_FROM = 0.12;
const RIPPLE_TO = 0.62;

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
 * ...and how fast a body comes round to which way it is pointing.
 *
 * The turn's own `VEHICLE_TURN`, arriving for people, and the argument is the
 * one written there: a heading that snaps a quarter turn between two ticks reads
 * as the mesh being swapped rather than as somebody going round a corner. A
 * lorry gets it because `vanRoute` is straight legs with a right angle in the
 * middle; a person gets it because *every* heading they are ever handed is one
 * of a handful. The keys send eight directions, so steering across a diagonal is
 * a 45° snap and reversing is 180°; `followPath` walks tile to tile, so a route
 * turns in quarters. There has never been a fraction of a turn anywhere in this.
 *
 * Well above the lorry's 5, which is the whole difference between the two: a van
 * turning slowly is a van, and you turning slowly is a control that does not
 * answer. At 13 a right angle is most of the way round in a tenth of a second —
 * fast enough that a press still feels like a press, slow enough that there is a
 * turn on screen rather than a jump cut. It is deliberately quicker than
 * `ACTOR_CHASE`, or a body would arrive somewhere still facing the way it set
 * off.
 */
const ACTOR_TURN = 13;

/**
 * How far a drawn body is shoved off the tile the shop put it on, so that two
 * people standing in one place read as two people.
 *
 * **This is a look and never a rule**, which is the whole of why it is here
 * rather than in `stepCustomers`. The sim already routes around a crowd —
 * `CROWD` in server/sim/pathing.js charges a step per body — and that is a
 * *planning* surcharge: a route is decided once and walked over many ticks, so
 * it breaks a tie at a corner and says nothing whatever about two bodies
 * occupying the same square on the way. Saying it in the sim instead would mean
 * pushing people off their own paths, which is `followPath` fighting a shove,
 * a body squeezed through a wall, a queue that jitters in its slots, and a
 * conservation question in every one of them. None of that buys a single pixel
 * over doing it where the pixels are. So the shop's answer to where anybody is
 * standing is untouched to the float — `pathTo`, `queueSlot`, `measureOccupancy`
 * and `crowdTiles` all go on reading exactly what they read before — and the
 * renderer draws them not inside one another.
 *
 * The nudge is computed off the CHASED positions rather than off the drawn ones,
 * which is the one decision in here that is not obvious and is what makes it
 * stable. Read back off what was drawn, the offset feeds itself: two bodies
 * pushed apart are further apart next frame, so the push relaxes, so they close
 * again — a shimmer at whatever frequency the ease happens to ring at, on a
 * shop floor full of people. Off the chase it is a pure function of where the
 * shop says everybody is, the pair splits one overlap evenly between them, and
 * there is nothing for it to oscillate against.
 *
 * `CROWD_NUDGE` is the cap, and it is small on purpose: a fifth of a tile is
 * about half a shopper's width, which is enough to tell two bodies apart from
 * this camera and far too little to put anybody inside a shelf. It is a cap
 * rather than the push itself — the push is however much of the overlap is
 * theirs to fix, and this only stops a pile of six from flinging its outer
 * members across the aisle.
 */
const CROWD_NUDGE = 0.2;
const CROWD_EASE = 8;

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
// A sky needs a little depth even when the rest of the view is deliberately
// flat. These are the pale band at the horizon, not a second light source.
const SKY_HORIZON_HIGH = new THREE.Color('#f4f7dc');
const SKY_HORIZON_DUSK = new THREE.Color('#ffe0bf');
// ...and the NOON pair Cel + Ink was tuned against. Only the top of the day
// moves: dusk is a sunset either way, and a look that replaced both ends would
// be a style that deleted the sunset rather than one that banded it. See
// `SKY_TOP` in look.js.
const SKY_HIGH_LOOK = new THREE.Color(SKY_TOP);
const SKY_HORIZON_HIGH_LOOK = new THREE.Color(SKY_HORIZON);
const SKY_MID = new THREE.Color();
/** Scratch for `skyLight`, which runs twice a snapshot and must allocate none. */
const SKY_MIX = new THREE.Color();
const SUN_HIGH = new THREE.Color(PALETTE.sunHigh);
const SUN_DUSK = new THREE.Color(PALETTE.sunDusk);
const FILL_HIGH = new THREE.Color(PALETTE.fillHigh);
const FILL_DUSK = new THREE.Color(PALETTE.fillDusk);

/**
 * THE SKY AS ONE COLOUR, and the two shares that make three lights into one.
 *
 * `Lights` needs to know what the world's light is worth now against what it is
 * worth at midday, because that ratio IS the day cycle since the roof — see THE
 * ROOF in `lights.js`, which is the argument for all of this. The sun and the
 * bounce are directional and this is a single number per channel, so each is
 * taken at a share: half, which is about the average Lambert term over the faces
 * a 45° camera can see, and the two shares only have to be *consistent* rather
 * than right, since every use of this is a ratio against itself at another hour.
 *
 * `spill` is deliberately not in it. That is the shop's own lamps folded into
 * the ambient, and folding a purchase into the sky would make the ratio — and
 * therefore how dark the FIELD is at night — a fact about how many lamps you
 * had bought.
 *
 * (This replaced `ROOM_FILL`, which was a flat ambient lift standing in for the
 * ceiling on everything the bake could not reach. With the sky held at midday
 * there is nothing left for it to lift: a loaf on a shelf at dusk is lit by the
 * same sun it was lit by at noon. Its one honest error — that an ambient cannot
 * tell inside from out — survives it, pointing the other way, and is written
 * down in THE ROOF.)
 */
const SUN_SHARE = 0.5;
const BOUNCE_SHARE = 0.5;
const BOUNCE_TINT = new THREE.Color(0xbcd8ff);

/**
 * A two-pixel-wide canvas is enough for the sky: the browser stretches its
 * vertical gradient across the clear colour pass, so there is no dome, no
 * camera-follow code, and no texture worth budgeting. It is painted only when
 * a game-state update advances the day cycle, not in the frame loop.
 */
function makeSkyGradient() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 96;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, context: canvas.getContext('2d'), texture };
}

/** Write the background in screen space, so it cannot ever be picked or cast. */
function paintSkyGradient(sky, top, horizon) {
  const { canvas, context, texture } = sky;
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `#${top.getHexString()}`);
  gradient.addColorStop(0.68, `#${SKY_MID.copy(top).lerp(horizon, 0.58).getHexString()}`);
  gradient.addColorStop(1, `#${horizon.getHexString()}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  texture.needsUpdate = true;
}

/** Windows at noon and at midnight — see `SURROUND_COLORS` and `syncState`. */
const GLOW_DAY = new THREE.Color(SURROUND_COLORS.city.glowDay);
const GLOW_NIGHT = new THREE.Color(SURROUND_COLORS.city.glowNight);
/**
 * The pitches between which the backdrop gets out of the camera's way.
 *
 * Untouched at and above 32° — the home pose is 40°, so ordinary play never
 * gives up a single tree, and the near band goes on framing the bottom of the
 * shot. Fully dissolved by 14°, which is where a hill stops being scenery
 * behind the shop and starts being a wall in front of it. See `aimSurround`.
 */
const HIDE_PITCH_OFF = 32 * (Math.PI / 180);
const HIDE_PITCH_FULL = 14 * (Math.PI / 180);
/** Above this, the far band cannot be on screen — see `aimSurround`. */
const FAR_SHOW_PITCH = 30 * (Math.PI / 180);

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
    //
    // Filtered either way, including under Cel + Ink, which wants the hardest
    // edge in the game and buys it by shrinking the TEXEL rather than by
    // dropping the tap — see `SHADOW_SPAN_MIN` in look.js for what that cost and
    // what turning the filter off cost instead.
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
    /**
     * ...AND THE DRAW COUNTERS HAD TO STOP RESETTING THEMSELVES, WHICH IS WHY
     * THE PERF READOUT SPENT ITS WHOLE LIFE REPORTING THE WRONG NUMBER.
     *
     * `info.render` is cleared at the top of every `renderer.render()` call, so
     * what it holds afterwards is the last call's totals rather than the frame's
     * — which was true and harmless for exactly as long as a frame was one call.
     * The ink pass made it three: the colour draw, the normals draw, and a
     * fullscreen composite quad. The quad is last, so `1 draws  0k tris` is what
     * the readout printed on every machine, in every shop, however heavy — a
     * perfectly accurate measurement of the blit.
     *
     * It is the worst shape a broken instrument can have, because it is not
     * obviously broken. It is a plausible small number, it moves (the quad is
     * genuinely there), and the whole point of those two figures is telling
     * "this machine is slow" from "this shop is heavy" — so the one readout that
     * could have answered that question always answered "the shop is empty".
     *
     * Turned off here and reset once per frame in `render`, so the numbers are
     * the frame's. Note what that folds in: the SHADOW pass counts too, and it
     * runs on a cadence (`SHADOW_EVERY`), so consecutive frames differ by a
     * whole second draw of the shop. The readout takes the max over its window
     * for that reason — see `stepPerf`.
     */
    this.renderer.info.autoReset = false;
    /**
     * The other half of the frame, and the one the CPU cannot see. Constructed
     * unconditionally and inert when the extension is missing — see gpu-clock.js
     * for why it must never report a zero.
     */
    this.gpuClock = new GpuClock(this.renderer);
    this.shadowTick = 0;
    // How far the furthest-moved body has travelled since the map was last
    // drawn. See `SHADOW_SLIP`: the cadence is a floor now rather than a rule,
    // because the things this shadow is most obviously *of* move every frame.
    this.shadowSlip = 0;
    /** What span the fitted map was last built for, so it is only rebuilt when
     *  the quantised answer actually moves. Null while the look is off, which
     *  is what keeps that path a straight `renderer.render` and nothing else. */
    this.shadowSpan = null;
    /** ...and whether that span has just moved, which is a redraw the cadence
     *  must not be allowed to decline. See `fitShadowSpan`. */
    this.shadowDirty = false;

    /**
     * The contour and the grade, or nothing at all.
     *
     * Held as null rather than as an object with a flag, so the look being OFF
     * is one `if` in `render` and not a pass that draws the frame through a
     * shader that happens to be the identity: off has to be byte-identical to
     * the game as it shipped, and cost nothing, because that is what every
     * screenshot in this repo is.
     */
    this.ink = lookOn() ? new Ink(this.renderer) : null;

    this.scene = new THREE.Scene();
    this.sky = makeSkyGradient();
    this.skyTop = new THREE.Color(PALETTE.sky);
    this.skyHorizon = SKY_HORIZON_HIGH.clone();
    paintSkyGradient(this.sky, this.skyTop, this.skyHorizon);
    this.scene.background = this.sky.texture;

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
    // Read once, here, rather than on every step into first person: the stored
    // value is only ever written by `setFpvFov` one line below, so a re-read
    // would be asking storage what this object already knows — and it would be
    // the wrong answer on a machine with no storage at all, where the write is
    // swallowed and the camera is the only thing holding the number.
    this.persp = new THREE.PerspectiveCamera(storedFov(), 1, FPV_NEAR, FPV_FAR);
    this.camera = this.ortho;
    /** Whether the view is inside somebody's head. See `setFirstPerson`. */
    this.fpv = false;
    /**
     * The roof, drawn only from under it. Held so the mode can show and hide it
     * without rebuilding: it lives under `staticRoot`, which `buildWorld`
     * disposes wholesale, and a rebuild of the shop behind a key you can press
     * twice a second is not a toggle. See `addCeiling`.
     */
    this.ceiling = null;
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
     * Whether the mouse has been taken away from the pointer and given to the
     * head — the Pointer Lock, set from client/main.js while first person has
     * it. See `pointerRay`, which is the whole of what it changes in here.
     *
     * It is a flag rather than a read of `document.pointerLockElement` for the
     * reason `cinema` is one: the renderer is handed the fact, so the one place
     * that owns the gesture owns when it becomes true, and a headless or lab
     * canvas cannot be locked by something it never asked about.
     */
    this.crosshair = false;
    /**
     * Called when the view steps into a head or back out of it, with the new
     * state. One hook, set by client/main.js, because the mouse belongs to the
     * input layer: `setFirstPerson` is reached from the key, the wheel and
     * `setFreeRoam`, and a lock grabbed at only one of those three is a mode
     * that looks around on some ways in and not others.
     */
    this.onFpv = null;
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
    // What the ink outlines but does not crease — see `render`. Held rather
    // than built per frame because it is handed to the hottest call in the
    // game, and it is safe to hold because these two roots are made once here
    // and never reassigned: `buildWorld` CLEARS them, it does not replace them.
    /**
     * The drawn creases, as one merged `LineSegments` — see `buildEdgeLines`.
     *
     * Its own root beside the other two rather than under `staticRoot`, and the
     * reason is `inkNoCrease` directly below: that list is handed to the hottest
     * call in the game and is held rather than rebuilt, which is only safe for a
     * group made once here. `buildWorld` disposes `staticRoot` wholesale, so a
     * root under it would be a stale reference on every re-flow. This one is
     * emptied and refilled by `addFixtureProps` instead, the way the maps beside
     * it are.
     *
     * It is in `inkNoCrease` because the normals pass draws whatever is in the
     * scene through `MeshNormalMaterial`, and a line has no normals to draw —
     * so left in, the screen-space crease detector would be reading garbage off
     * the very lines that exist to replace it.
     */
    this.edgeRoot = new THREE.Group();
    this.scene.add(this.edgeRoot);
    // On, which is how the shop is drawn. There is no UI for the way back and
    // there is not going to be one, for `setLook`'s reason: it is a renderer
    // dial, reachable from the console as `__sns.scene.setEdgeLines(false)`,
    // and the A/B it exists for is one two people ever want to make.
    // Through the setter rather than as a field, or the screen-space crease is
    // left on beside it until something happens to call that — and both
    // contours on one edge is the state where neither of them is visibly doing
    // anything. See `Ink.setCrease`.
    this.setEdgeLines(true);
    this.inkNoCrease = [this.actorRoot, this.edgeRoot];
    // The crowd's two draws, under `actorRoot` with the bodies they replace —
    // which is also what keeps them out of the ink's normals pass, since that
    // is the group `inkNoCrease` names.
    this.crowd = new CrowdBatch(CROWD_CAP);
    this.actorRoot.add(this.crowd.mesh.cast, this.crowd.mesh.flat);

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
    // ...and the art ITSELF, by fixture id, which is what a contour marker is
    // built out of. Every fixture is in here and not only the props, because
    // the highlight is now about the object for all of them — see `markerFor`.
    // Filled and cleared beside `propBoxes`, and for its reason: these are
    // groups in `staticRoot`, which a re-flow throws away wholesale.
    this.fixtureProps = new Map();
    /**
     * ...AND THE ART THAT DID NOT CHANGE, KEPT ACROSS THE RE-FLOW.
     *
     * A re-flow disposes the shop and builds it again, and it fires on every
     * build press and on every wall segment of a drag. That is right about the
     * ground, the walls and the ceiling — all three are facts about the whole
     * building — and it is wrong about a shelf twenty tiles from the one you
     * placed, which is byte-for-byte the shelf it was. On a shop with a hundred
     * conveyor cells that was ~60ms of a ~86ms stall, spent rebuilding art
     * nobody had touched: `?perf` reads it as `fx:model` and `fx:ink`.
     *
     * Keyed on everything the art is DERIVED from rather than on the fixture's
     * own record, which is the whole difficulty — a unit's panels are a fact
     * about its neighbours (`carriesOn`) and a conveyor's deck is a fact about
     * the flow, so a key that said only "this shelf has not moved" would leave
     * a run wearing the seams of the shop it used to be in. See `fixtureArtKey`
     * for what goes in and what is deliberately never reused.
     *
     * Emptied by `clearFixtureArt`, which `rebuildWorld` calls — that is the one
     * path a *look* or a catalog edit comes down, and neither is in the key.
     */
    this.fixtureArt = new Map();
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
    /**
     * Where the shop is, and the three things `setSurround` needs to exist.
     *
     * The id starts at the default rather than at null, so the first
     * `buildWorld` — which can and does land before the first snapshot — draws
     * the horizon every existing save already had rather than nothing at all.
     * `setSurround` then no-ops for every shop that never picked anything.
     */
    this.surroundId = DEFAULT_SURROUND;
    this.surroundGroup = null;
    this.surroundGlow = null;
    this.surroundFar = null;
    // The conveyor map — see `setFlowOverlay`, and the `flow` switch in
    // client/debug.js. Keyed on the layout, because a re-flow is what
    // invalidates it and build mode re-flows on every wall segment of a drag.
    this.flowOverlay = null;
    this.flowOverlayKey = null;

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
    sun.shadow.mapSize.set(shadowMapSize(), shadowMapSize());
    const s = SHADOW_SPAN;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 110 });
    // The NORMAL bias is deliberately not set here: it is a multiple of the
    // shadow texel, and the texel is a fact about a span that moves with the
    // zoom. `fitShadowSpan` is the one place the two are decided together — see
    // `SHADOW_NORMAL_BIAS_TEXELS`, which is the whole argument.
    sun.shadow.bias = lookOn() ? SHADOW_BIAS : -0.0012;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    // A cool bounce light so shadowed faces aren't muddy. Kept on `this` for
    // the same reason the ambient is: the look scales all three together, and a
    // light nothing holds a reference to is one nothing can scale.
    const bounce = new THREE.DirectionalLight(BOUNCE_TINT.getHex(), 0.32);
    bounce.position.set(-18, 12, -14);
    this.bounce = bounce;
    this.scene.add(bounce);

    /**
     * THERE IS NO `roomFill` HERE ANY MORE, and its absence is the feature.
     *
     * It was a small warm ambient on layer 0 — the movers, the walls — standing
     * in for the shop's ceiling on everything the bake could not reach: people,
     * crates, and the goods on every shelf, all of which are rebuilt every sync
     * out of colours nothing baked. Without it they were silhouettes on a lit
     * floor.
     *
     * The roof retired it by pointing the day cycle the other way round. The sky
     * is held at midday and everything OUTDOORS is darkened per cell instead
     * (see THE ROOF in `lights.js`), so a loaf on a shelf at eight in the evening
     * is lit by exactly the sun that lit it at noon and there is nothing left to
     * prop up. Its error survives it, inverted and written down there: a mover
     * outdoors is lit at midday after dark. Adding a lift back on top of that
     * would make the one remaining error worse in the one place it shows.
     */

    // The ground is lit by lamps that were added up on the CPU (`bakeInto`), so
    // it sits on a layer the point lights cannot see or it would be lit twice.
    // The sky is not a lamp and has to be let back in by hand — a layer is a
    // filter on EVERY light, so leaving these three out drops the floor to
    // black. The camera needs it too, or it simply stops drawing the shop.
    for (const l of [this.ambient, sun, bounce]) l.layers.enable(BAKED_LAYER);
    // ...and the far backdrop, which is off on a layer of its own purely so the
    // ink pass can skip it (see `SURROUND_LAYER`). It is ordinary lit geometry
    // in every other respect, so the sky has to be let back in by hand exactly
    // as it is for the baked ground one line up.
    for (const l of [this.ambient, sun, bounce]) l.layers.enable(SURROUND_LAYER);
    // BOTH cameras, and never `this.camera` — which is whichever one is live
    // and is the ortho every time this runs. A camera is born seeing layer 0
    // only, so a second one added without this line draws the shop with its
    // floor, its walls, its grass and every baked fixture missing: what is left
    // is the apron underneath and the actors on top, which is a green field
    // with people standing in it and shelving hanging in the air. Nothing
    // errors, and it reads as first person being unfinished rather than as one
    // bit not being set. See `FPV_FOV`.
    this.ortho.layers.enable(BAKED_LAYER);
    this.ortho.layers.enable(SURROUND_LAYER);
    this.persp.layers.enable(BAKED_LAYER);
    this.persp.layers.enable(SURROUND_LAYER);

    // Whatever the player has wired up. Everything above is the sky; this is the
    // only light in the scene that anybody had to buy.
    this.lights = new Lights(this.scene);
  }

  /**
   * What the world's light is worth at a given hour, as one colour.
   *
   * The day cycle's own three terms, summed — the constants are read here rather
   * than passed in because this is asked at TWO hours per snapshot (now, and
   * midday) and a caller that had to restate the ramp for each would be the
   * second opinion about the sun this exists to avoid. See `SUN_SHARE` for the
   * shares, and THE ROOF in `lights.js` for what the ratio between two of these
   * is spent on.
   *
   * The look moves the noon end of all three, so the reference has to be
   * recomputed rather than frozen — pressing the style switch changes what
   * midday IS.
   */
  skyLight(daylight, out) {
    const look = lookOn();
    const sunI = SUN_DUSK_LEVEL + daylight * ((look ? SUN_NOON : 1.30) - SUN_DUSK_LEVEL);
    const fillI = AMBIENT_DUSK_LEVEL + daylight * ((look ? AMBIENT_NOON : 0.90) - AMBIENT_DUSK_LEVEL);
    out.copy(FILL_DUSK).lerp(FILL_HIGH, daylight).multiplyScalar(fillI);
    SKY_MIX.copy(SUN_DUSK).lerp(SUN_HIGH, daylight).multiplyScalar(sunI * SUN_SHARE);
    out.add(SKY_MIX);
    SKY_MIX.copy(BOUNCE_TINT).multiplyScalar((look ? BOUNCE_LOOK : 0.32) * BOUNCE_SHARE);
    return out.add(SKY_MIX);
  }

  /** Keep the painted sky in step with the same day cycle as the sun. */
  updateSky(daylight) {
    const noon = lookOn();
    this.skyTop.copy(SKY_DUSK).lerp(noon ? SKY_HIGH_LOOK : SKY_HIGH, daylight);
    this.skyHorizon.copy(SKY_HORIZON_DUSK)
      .lerp(noon ? SKY_HORIZON_HIGH_LOOK : SKY_HORIZON_HIGH, daylight);
    paintSkyGradient(this.sky, this.skyTop, this.skyHorizon);
    /**
     * ...and the backdrop's haze, which is the sky — including the GROUND's.
     *
     * This was aimed at the lawn for a step, on the reasoning that nothing out
     * there was ever seen against sky. That was true, and it was a description
     * of the bug rather than a constraint: the apron filled the frame because
     * nothing ever faded it. Now that it does (see `apronMaterial`), the far end
     * of the ground, the skyline standing on it and the real background are all
     * the same colour by construction — which is what a horizon is.
     *
     * Written from here rather than from `syncState` so those three cannot
     * drift: a haze a shade off the sky is a visible band along the top of the
     * world, and separated they are two lerps against the same `daylight` that
     * somebody has to remember to keep in step.
     *
     * Pulled a little toward the top of the sky rather than taken raw, because
     * `skyHorizon` is the colour at the very BOTTOM of the gradient while the
     * horizon itself sits some way up the screen from there.
     */
    HAZE.color.value.copy(this.skyHorizon).lerp(this.skyTop, 0.30);
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
      this.lookBy(dxPx, dyPx);
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
   * Look around, by a mouse that has moved `dx`/`dy` pixels.
   *
   * The one turn first person has, and it takes pixels of MOUSE rather than
   * pixels of drag on purpose: the two are the same movement told apart only by
   * whether a button happened to be down, and the sign is already the sign a
   * mouse-look wants — move right and the head turns right — because a drag in
   * here was never the "world follows your hand" the ortho view's is. That is
   * what lets the Pointer Lock and the drag share this rather than each owning
   * an accumulator, which is `stepTurn`'s argument said one projection over: two
   * copies are two things that can disagree about which way a head turns, and
   * each of them feels right on its own.
   *
   * `FPV_LOOK` is therefore one sensitivity for both, and it has to stay that
   * way — a lock that turned at its own rate would be a view that changes speed
   * the moment you press Escape.
   */
  lookBy(dxPx, dyPx) {
    if (!this.fpv) return this.camYaw;
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
    return this.camYaw;
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
    // The roof goes up and comes down with the mode, and it is a flag rather
    // than a rebuild. `addCeiling` is born reading the same field, so a re-flow
    // while you are in there does not drop it.
    if (this.ceiling) this.ceiling.visible = next;
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
    // Last, and after the body is back: the hook takes the mouse away and gives
    // it back (see `onFpv`), and a lock grabbed while the view still had the old
    // pose would spend its first frames looking around a camera that is mid-step.
    this.onFpv?.(this.fpv);
    return this.fpv;
  }

  /** How wide the lens in there is, in degrees. See `FPV_FOV`. */
  fpvFov() {
    return Math.round(this.persp.fov);
  }

  /** The ends and the step, for whoever draws the control. Asked rather than
   *  restated in client/sections.js, or the menu's stepper would run past both
   *  ends of a range this file has since moved. */
  fpvFovRange() {
    return { min: FPV_FOV_MIN, max: FPV_FOV_MAX, step: FPV_FOV_STEP, def: FPV_FOV };
  }

  /**
   * Set it, and remember it. Answers the degrees it settled on.
   *
   * Clamped rather than refused, so a stepper at either end is a press that
   * does nothing rather than a press that throws — and `paintSection` redraws
   * off this answer, which is what greys the button out.
   *
   * `updateProjectionMatrix` is the whole of applying it, and it has to be said
   * here as well as in `resize`: the field is a plain number on the camera and
   * three.js reads the matrix, so a set with no rebuild is a menu row that
   * moves a number and no pixels — the "tier that changes no number" trap
   * wearing a lens. Nothing else needs telling. The ortho camera is untouched,
   * which is why this can be pressed out of first person at all: the change is
   * waiting the next time you step in, rather than being a mode you have to be
   * in to reach its own setting.
   */
  setFpvFov(deg) {
    const next = clamp(Math.round(Number(deg) || FPV_FOV), FPV_FOV_MIN, FPV_FOV_MAX);
    if (next === this.fpvFov()) return next;
    this.persp.fov = next;
    this.persp.updateProjectionMatrix();
    rememberView('fov', next);
    return next;
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
      // energy rather than as a shape being animated. Fading on a square so
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
    // ...and where the glass is, which is the other half of the same question.
    // A window is not a fixture and has no record — it is a number on a lattice
    // line — so this is read straight off the edges, here, in the one method
    // that already means "point the lighting at this layout". Same trigger as
    // the mask for the same reason: a wall went up, so a room that had no window
    // in it has one.
    this.lights.setWindows(windowsIn(L));
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

  /**
   * Turn Cel + Ink on or off, which is a fact about the PERSON and not the shop.
   *
   * There is no UI for it and there is not going to be one — it exists for a
   * machine that cannot afford a second scene draw, and it is reachable from
   * the console the way every other renderer dial in this game is
   * (`__sns.scene.setLook(false)`). `setLookOn` is what remembers it, in
   * `sns-view` beside the camera; nothing about it reaches the save, the
   * schema, the wire or the server.
   *
   * The rebuild is the whole of the work and it is not optional. `material()`
   * is a cache keyed by colour and the mode decides what CLASS a colour
   * resolves to, so every mesh in the shop is holding a material of the old
   * kind — including the bodies under `actorRoot`, which survive a re-flow by
   * design and would otherwise go on being Lambert in a banded shop until each
   * of them happened to restage.
   *
   * A STYLE IS A LOOK AND NEVER A RULE: this touches no tile, no `blocked` bit
   * and no fixture, and `pickFixture` has to answer the same thing afterwards —
   * `userData.fixture` is stamped where a mesh is BUILT, so a rebuild that lost
   * it would mean changing your look silently re-aims the pointer. That is
   * `verify:look`'s second claim, and it is invisible for days if it breaks.
   */
  setLook(want) {
    if (!setLookOn(want)) return lookOn();
    const on = lookOn();

    this.sun.shadow.mapSize.set(shadowMapSize(), shadowMapSize());
    // A map that changed size is a texture of the wrong size, and three only
    // reallocates when there is nothing there to reuse.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.bias = on ? SHADOW_BIAS : -0.0012;
    // Zeroed on the way out and never left where it was: `normalBias` applies
    // whatever the filter is, so a value sized for a fitted frustum and
    // forgotten would peter-pan every shadow in the shop off its own object,
    // with nothing anywhere to connect it to. On the way IN it is not set here
    // at all — `fitShadowSpan` owns it, because it is a multiple of a texel
    // that has not been decided yet.
    if (!on) this.sun.shadow.normalBias = 0;
    if (!on) {
      const s = SHADOW_SPAN;
      Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
      this.sun.shadow.camera.updateProjectionMatrix();
    }
    this.shadowSpan = null;
    this.shadowDirty = true;

    if (on) {
      this.ink ??= new Ink(this.renderer);
      // A fresh pass starts with the crease on, whatever the drawn-crease switch
      // says — so turning the look off and back on while it is set would put
      // both contours back on the same edges and read as the switch having
      // forgotten itself.
      this.ink.setCrease(!this.edgeLines);
    } else {
      this.ink?.dispose();
      this.ink = null;
    }

    // Everything static, then everybody standing in it. The bodies have to be
    // dropped by hand: `syncActors` only restages one whose `key` moved, and a
    // style is not one of the things that key is made of.
    for (const map of [this.players, this.customers, this.animals]) {
      for (const rec of map.values()) {
        this.actorRoot.remove(rec.obj);
        this.dropFoot(rec);
        disposeGroup(rec.obj);
      }
      map.clear();
    }
    this.rebuildWorld();
    return on;
  }

  /** Redraw the world we already have — for when the art changed, not the shop. */
  rebuildWorld() {
    if (!this._layout) return;
    // A style or a catalog edit redraws every fixture without moving one, and
    // neither is in `fixtureArtKey`. See `clearFixtureArt`.
    this.clearFixtureArt();
    this.layoutVersion = -1;
    this.buildWorld(this._layout);
  }

  /**
   * ...and how long that took, because nothing could say.
   *
   * A re-flow is the one piece of work in the client that is neither a frame
   * nor a message: it disposes the whole shop and builds it again, on the tick a
   * build press lands, and it fires on every wall segment of a drag. So it is
   * invisible to every number on the `?perf` readout — `frame`/`cpu` are a
   * running average over 250ms and `worst` is capped by the loop, while what a
   * player actually feels is one stall between two frames with the world
   * stopped inside it. "Placing something pauses the game" is a complaint that
   * has nowhere to land without this.
   *
   * Kept as a peak rather than a last value: a drag re-flows a dozen times and
   * the one that hurts is the worst of them, which a last-value readout would
   * overwrite a millisecond later.
   */
  buildWorld(layout) {
    if (layout.version === this.layoutVersion) return;
    const startedAt = performance.now();
    this.reflowPhases = {};
    this._phaseAt = startedAt;
    try {
      this.composeWorld(layout);
    } finally {
      this.reflowMs = performance.now() - startedAt;
      this.reflowWorst = Math.max(this.reflowWorst ?? 0, this.reflowMs);
      this.reflows = (this.reflows ?? 0) + 1;
    }
  }

  /**
   * Close off a span of `composeWorld` and file it under a name.
   *
   * Split by hand rather than derived, because the interesting boundaries are
   * not the method calls: the tile sweep and the instanced-kind sweep are two
   * loops in the middle of one function and they answer to completely different
   * things (the size of the map, and how much you have painted).
   */
  phase(name) {
    const now = performance.now();
    if (this.reflowPhases) this.reflowPhases[name] = now - this._phaseAt;
    this._phaseAt = now;
  }

  composeWorld(layout) {
    this.layoutVersion = layout.version;
    this._layout = layout;
    const L = layout.layout ?? layout;

    // Every geometry under staticRoot was built for the previous layout, and
    // `clear()` alone drops the references without freeing the GPU buffers.
    // That barely mattered when the shop only re-flowed on an upgrade; build
    // mode re-flows on every placement.
    this.profiles.clear();
    // Anything we mean to keep has to LEAVE first — `disposeGroup` walks
    // whatever is still under the root and frees its buffers, and a kept group
    // handed back next re-flow with freed buffers draws as a fixture that is
    // simply not there. `addFixtureProps` puts back the ones whose key still
    // matches and disposes the rest.
    for (const rec of this.fixtureArt.values()) this.staticRoot.remove(rec.group);
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
    this.phase('dispose');
    this.refreshFixtureProps(L);
    this.phase('props');

    // Lamps first, because the floor is about to be BAKED with them — every
    // emitter in the shop folded into the per-cell colour the tile mesh was
    // going to carry anyway. It used to be the last line in this method, back
    // when nothing here needed to know where the light was.
    this.aimLights(L);
    this.bakedGround = [];
    this.bakedMeshes = [];
    // Disposed with the root a few lines up, so the handle has to go with it —
    // a shop whose walls came down builds no ceiling at all, and a stale one
    // here is a freed buffer the mode would go on toggling.
    this.ceiling = null;

    // The footfall sheet is the size of the world, so it is re-cut here — the
    // one thing outside `staticRoot` that a re-flow legitimately touches, since
    // buying land is the only way the grid ever changes. `resize` keeps the
    // overlap, so growing the shop does not lose what has been watched.
    this.heat.resize(L.w, L.h);
    this.phase('lights');

    // Ground: one big plane rather than 1500 grass tiles. It runs well past the
    // last tile — see GROUND_MARGIN — so the world never visibly ends, and so
    // shoppers walking on from off the map have land to walk in over.
    //
    // ...WITH A HOLE IN IT PER TUNNEL MOUTH, which is the whole of why this is a
    // shape rather than a box.
    //
    // The ground under the shop is solid, and a mouth's carrier sinks the best
    // part of a tile. So the crate did not go underground: it went INTO this
    // slab and was clipped by it, which draws as a box dissolving at floor level
    // over a machine with a dark square on top — the shape of a rendering fault,
    // with the sim doing exactly what it says. Nothing else in the game has ever
    // wanted a hole in the world, and nothing else may make one: the list is
    // `L.unders` rather than a flag on a placement, or the day something else
    // stamps `T.BELT` is the day the floor develops pits.
    // FLOOR MOUTHS ONLY, which is every mouth `canPlace` will let you lay — but
    // `compose` writes `under.deck` all the same, and shared/build.js says in as
    // many words that the refusal at the press is not the only thing standing
    // between a tunnel and a storey. A hole dug under one that got up there is a
    // shaft in the floor of a shop with no machine over it.
    const wells = (L.unders ?? []).filter((u) => deckOf(u) === 0);
    const apron = new THREE.Shape();
    apron.moveTo(-GROUND_MARGIN, -GROUND_MARGIN);
    apron.lineTo(L.w + GROUND_MARGIN, -GROUND_MARGIN);
    apron.lineTo(L.w + GROUND_MARGIN, L.h + GROUND_MARGIN);
    apron.lineTo(-GROUND_MARGIN, L.h + GROUND_MARGIN);
    apron.closePath();
    for (const u of wells) {
      // Wound against the outline, which is what a hole is to `ExtrudeGeometry`.
      const hole = new THREE.Path();
      hole.moveTo(u.x - WELL_HALF, u.z - WELL_HALF);
      hole.lineTo(u.x - WELL_HALF, u.z + WELL_HALF);
      hole.lineTo(u.x + WELL_HALF, u.z + WELL_HALF);
      hole.lineTo(u.x + WELL_HALF, u.z - WELL_HALF);
      hole.closePath();
      apron.holes.push(hole);
    }
    // Extruded down rather than up: the shape's plane becomes the world's after
    // the quarter turn, so its face is the ground at y 0 and the depth hangs
    // below it exactly as the box it replaces did.
    const groundGeo = new THREE.ExtrudeGeometry(apron, { depth: GROUND_DEEP, bevelEnabled: false });
    groundGeo.rotateX(Math.PI / 2);
    /**
     * ...and it DISSOLVES INTO THE SKY at its far end, which is the only reason
     * this game has a horizon at all.
     *
     * The apron is 320 tiles across so the world can never visibly end (see
     * `GROUND_MARGIN`), and the price of that was that it never visibly ended:
     * green filled the frame at every pitch and `paintSkyGradient` was drawing a
     * background nobody had ever seen. Shrinking it is not the fix — a plane
     * stopping in mid-air at one angle on one monitor is the exact failure that
     * constant is sized to prevent.
     *
     * So it keeps its size and takes the same haze every backdrop object
     * carries, run all the way to sky: past `HAZE_OUT` the ground IS the sky
     * colour, the seam against the real background cannot be found, and what you
     * are looking at is a horizon.
     *
     * Its material is owned rather than shared — `material()` is a cache, and a
     * shader hung on the cached grass would put a horizon on every green thing
     * in the shop — so it is disposed at the top of the next `buildWorld`.
     */
    this.apronMat?.dispose();
    this.apronMat = apronMaterial(this.fieldColor());
    const ground = new THREE.Mesh(groundGeo, this.apronMat);
    ground.receiveShadow = true;
    // Onto the baked layer with every other bit of ground. It is not baked —
    // there is nothing per-cell about one box the size of the world — so the day
    // reaches it through its own shader instead (`HAZE.day`), which is the same
    // darkening every outdoor tile gets and is there for the same reason: the
    // apron is the field seen past the last tile, and a bright band round a dark
    // lawn is the ONE part of this an eye reliably catches, since the seam is a
    // straight line the length of the map.
    ground.layers.set(BAKED_LAYER);
    this.staticRoot.add(ground);

    // The playable lot is still surrounded by the cheap grass apron above; the
    // surround gives that empty space a destination. It is well outside every
    // walkable/buyable cell and stays vastly smaller than one tufted lawn.
    //
    // Its own group with its own builder, because it is the one thing in
    // `staticRoot` that can change without anything having MOVED — see
    // `setSurround`, which is `setPaint`'s argument said about the horizon.
    this.addSurround(L.w, L.h);
    this.phase('ground');

    // Everything raised gets an instanced box per tile kind — and, for floor,
    // per DESIGN of floor. Which design a cell is painted lives in its own
    // sparse layer (`L.ground`) rather than in `tiles`, so the grouping key has
    // to carry both: `tiles` still decides what may stand there and this only
    // decides what it looks like. One mesh per kind would have collapsed four
    // floors into one colour; one mesh per cell would be five hundred draws.
    const painted = groundIndex(L);
    const wellCells = new Set(wells.map((u) => `${u.x},${u.z}`));
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
        if (!byKind.has(key)) byKind.set(key, { kind, piece, cells: [], collars: [] });
        // A mouth's square has a shaft through it, so its slab is laid as four
        // pieces round the opening instead of one. They go in their own list
        // rather than in with the whole cells because three things downstream —
        // stripes, tufts and a pad's glyph — are per CELL: fed a collar they
        // would draw the cell's pattern four times, off centre, at four
        // different hashes.
        if (wellCells.has(`${x},${z}`)) {
          for (const [ox, oz, cw, cd] of WELL_COLLAR) {
            byKind.get(key).collars.push([x + ox, z + oz, cw, cd]);
          }
        } else byKind.get(key).cells.push([x, z]);
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();

    for (const [, { kind, piece, cells, collars }] of byKind) {
      const style = TILE_STYLE[kind];
      if (!style) continue;
      const slabs = collars.length ? [...cells, ...collars] : cells;
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
      // WHITE, BECAUSE `instanceColor` MULTIPLIES THE MATERIAL'S OWN COLOUR.
      //
      // Every cell below sets an ABSOLUTE colour — `patternColor` resolves the
      // base or the accent and jitters it, `bakeInto` adds the lamps — so a
      // material carrying `base` as well means the ground is drawn at roughly
      // colour SQUARED. It is invisible on everything this was tuned against:
      // marble and shop floor are near-white, and near-white squared is still
      // near-white. It is severe on anything saturated — `#b4906c` oak comes
      // out `#7f512e`, a dark red-brown — so the failure reads as the FLOOR
      // DESIGN being dark rather than as the renderer applying it twice, and
      // the darker you author to fix it the worse it gets.
      //
      // The tell is `addStripes` below: it has no `instanceColor`, so its bars
      // are single-applied and therefore lighter than the cell they lie on.
      const mesh = new THREE.InstancedMesh(box, material(0xffffff), slabs.length);
      mesh.castShadow = height > 0.2;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(slabs.length * 3), 3);
      // The unlit colour of every cell, and where that cell is. Kept so the hour
      // can be re-baked without re-deriving the pattern: `patternColor` and the
      // jitter hash are per cell, and the sun coming up does not move either.
      const bare = new Float32Array(slabs.length * 3);
      const at = new Float32Array(slabs.length * 3);

      slabs.forEach(([x, z, cw, cd], i) => {
        dummy.position.set(x, height / 2, z);
        // Fences are thin posts; everything else fills its tile — unless it is a
        // piece of collar round a shaft, which brings its own span.
        const w = cw ?? (kind === 9 ? 0.9 : 1);
        const d = cd ?? (kind === 9 ? 0.22 : 1);
        dummy.scale.set(w, height, d);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // The pattern is per-cell colour and nothing else — no extra geometry,
        // no second mesh, no texture. At 45° across a room that is all that
        // survives anyway, and it costs one lookup in a loop that already sets
        // a colour per instance to jitter it.
        // Off the CELL rather than off the piece: a collar is four fractional
        // positions inside one square, and both of these are per-cell hashes —
        // asked at the piece's own coordinates the ring round a shaft comes out
        // four slightly different colours, which reads as a patch of bad floor.
        // A whole cell is already an integer, so the rounding is a no-op for it.
        const cx = Math.round(x);
        const cz = Math.round(z);
        const c = new THREE.Color(surface ? patternColor(surface, cx, cz) : jitter(style.color, 0.05, cx * 31 + cz * 17));
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

    this.phase('tiles');
    this.addEdges(L);
    this.phase('walls');
    this.addCeiling(L);
    this.phase('ceiling');
    this.addFixtureProps(L);
    this.phase('fixtures');
    // After the fixtures, so the path is drawn over the decks rather than under
    // them. `staticRoot`, because it is a fact about the building and a re-flow
    // is what changes it — the same group the belts themselves live in, and
    // disposed wholesale with them.
    this.addConveyorPaths(L);
    this.phase('belts');
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
    // Every ring, cage and outline the pointer or a selection had up. The
    // fixture one of them was drawn round belongs to the old layout — a re-flow
    // can renumber it or move it out from under the marker — and the art all
    // four are BUILT OUT OF has just been disposed. See `dropMarkers`; `UI` puts
    // back whatever is still true on the next frame.
    this.dropMarkers();
  }

  /**
   * Every marker that is drawn OUT OF a fixture's own meshes, dropped.
   *
   * `buildContour` borrows the art rather than copying it — that is what makes
   * an outline follow a shape nobody authored an outline for — and a re-flow
   * frees those buffers. So a marker that survives one is drawing geometry that
   * has been disposed, at wherever the thing used to stand: the teal outline
   * left hanging in mid-air a few tiles from the shelf it belongs to.
   *
   * `this.reflows` is in all four keys, so each of them would rebuild the next
   * time it is ASKED — and "the next time it is asked" is a pointer move, which
   * may be never. Dropping them here closes that window rather than narrowing
   * it. Nothing is lost by it: what a marker is drawn from lives in `UI`
   * (`syncPickMarkers`, `refollowSelection`), and both run on a layout landing,
   * so the ring is back on the same frame. It is the DRAWING that goes, never
   * the selection — see CLAUDE.md on `keepPicked`, which is the opposite
   * mistake and a much worse one.
   */
  dropMarkers() {
    this.setAimTarget(null);
    this.setPickedBoard(null);
    // `[]` rather than the default, or the null fixture is handed to `spotsOf`.
    this.setSelectedTarget(null, []);
    for (const name of [...this.markSets.keys()]) this.setMarkedSet(name, null);
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
    this.fixtureProps.clear();
    this.bakedProps = [];
    // The geometry contour, gathered across every fixture and merged into ONE
    // object at the foot of this method. See `buildEdgeLines`: a line per
    // fixture is ~1,600 more draws in a furnished shop, which is the cost `weld`
    // exists to avoid one function along.
    this.clearEdgeLines();
    const edges = [];

    // Split by hand, for `Scene.phase`'s reason: this loop is four unrelated
    // costs wearing one name, and which of them owns a re-flow decides whether
    // the fix is the art, the ink or the lighting.
    const spans = { model: 0, place: 0, bake: 0, ink: 0, reuse: 0 };
    // Which ids answered from the cache or were re-filed into it this pass.
    // Anything left over belonged to a fixture the re-flow got rid of.
    const keep = new Set();
    // How much of the shop answered from the cache, for the readout. The one
    // number that says whether any of this is working: a shop that is redrawing
    // every fixture and a shop whose key never matches look identical.
    let reused = 0;
    let mark = performance.now();
    const span = (k) => { const n = performance.now(); spans[k] += n - mark; mark = n; };

    for (const f of fixturesIn(L)) {
      mark = performance.now();
      /**
       * ...unless this one is already built and nothing it is drawn from moved.
       *
       * The whole of the saving, and the whole of the risk: everything below
       * this branch is skipped, so anything `fixtureArtKey` fails to name is a
       * fixture wearing art from a shop that no longer exists. It reads as the
       * unit not having updated — which, standing in build mode having just
       * pressed something, reads as the press not having worked.
       */
      const artKey = this.fixtureArtKey(L, f, byTile);
      const kept = artKey ? this.fixtureArt.get(f.id) : null;
      if (kept && kept.key === artKey) {
        keep.add(f.id);
        this.staticRoot.add(kept.group);
        /**
         * ...settled, because a re-flow empties `landings`.
         *
         * A fixture you have just placed is dropped into its tile over
         * `LAND_MS`, and the animation lives in a list `composeWorld` clears.
         * Place a second thing before the first has finished falling and the
         * first is reused mid-drop with nothing left to finish it: it hangs
         * there, half a tile up and a little too big, for the rest of the
         * session. Two presses in quick succession is the *ordinary* way to
         * build, so this is not an edge case — and it is one assignment.
         */
        const settleOff = this.artSetback(L, f);
        const settleMid = footprintMid(f.kind, f.x, f.z);
        kept.group.position.set(
          settleMid.x + (settleOff?.dx ?? 0), this.fixtureBaseY(f), settleMid.z + (settleOff?.dz ?? 0),
        );
        kept.group.scale.set(1, 1, 1);
        /**
         * ...and the MATRIX with it, which is not a formality here.
         *
         * three.js refreshes `matrixWorld` during render, so a group whose
         * transform is set outside one is correct on screen a frame later and
         * wrong to anything that reads it in between. `buildContour` is exactly
         * that reader: a marker is built out of this group's meshes in world
         * space, and `UI` rebuilds every marker the moment a layout lands —
         * before anything has been drawn.
         *
         * A freshly built prop never notices, because `collectEdges` calls this
         * on its way past. A reused one is the case that does, and the two
         * lines above are what make it one: a fixture caught mid-landing was
         * last drawn half a tile in the air, so the outline is cut from THAT
         * matrix and hangs up and to the left of the shelf it belongs to —
         * which is a stranded contour with a perfectly ordinary cause.
         */
        kept.group.updateMatrixWorld(true);
        this.fixtureProps.set(f.id, kept.group);
        if (kept.box) this.propBoxes.set(f.id, kept.box);
        // Re-tinted rather than kept: a lamp may have moved even though this
        // has not, and a tint is one multiply against a group.
        this.bakedProps.push({ group: kept.group, x: f.x, y: this.fixtureBaseY(f) + 0.5, z: f.z });
        this.paintProp(kept.group, f.x, this.fixtureBaseY(f) + 0.5, f.z);
        if (kept.edges) edges.push(kept.edges);
        if (kept.group.userData.moving?.length) {
          this.movingFixtures.set(f.id, {
            moving: kept.group.userData.moving,
            phase: (f.x * 0.31 + f.z * 0.17) % 1,
            signal: kept.signal,
            conveyor: CONVEYOR_KINDS.includes(f.kind),
          });
        }
        if (kept.signal) {
          this.signalFixtures.set(f.id, {
            signal: kept.signal,
            model: kept.model,
            stages: kept.group.userData.stages ?? null,
            shown: kept.group.userData.shown ?? 0,
          });
        }
        reused += 1;
        span('reuse');
        continue;
      }
      // This unit's contour, kept beside its art so neither is rebuilt
      // without the other.
      let fxEdges = null;
      let fxBox = null;
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
      // ...and a tunnel mouth's housing opens toward its SURFACE rail.
      //
      // Both mouths are laid facing the way goods go, which is what makes the
      // pair derivable. Their art is not a length of that horizontal path,
      // though: it is a basket over a piston well. The entry therefore opens
      // behind its flow, where the incoming rail ends, while the exit opens
      // ahead, where the outgoing rail begins. Pointing both openings toward
      // the buried span draws two closed backs against the only rails anybody
      // can see — mechanically correct, visually impossible.
      const flowRot = derivedFlow(f.kind) ? this.conveyorFacing(L, f)
        : (f.kind === 'under'
          ? (tunnelExit(L, f) ? rot4((f.rot ?? 0) + 2) : (f.rot ?? 0))
          : (f.rot ?? 0));
      prop.rotation.y = -flowRot * (Math.PI / 2);
      // ...and the housing goes on a side nothing is attached to, which is a
      // question about the shop rather than about the model. See
      // `attachConveyorBack`.
      this.attachConveyorBack(L, f, prop, flowRot);
      // A tunnel mouth is the floor lift's inverse: a short rail hands onto a
      // carrier, then a piston lowers it out of sight. The authored housing is
      // the basket/well; this adds the moving hardware inside it and registers
      // it with the same per-frame conveyor animation record as its lamp.
      if (f.kind === 'under') this.attachTunnelPiston(L, f, prop);
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
      // The lift's visible baskets are connection-derived and live in the
      // conveyor geometry pass. Its authored tower is intentionally stripped,
      // which otherwise leaves this fixture group with no mesh for the pointer
      // to hit. Keep one invisible shaft-sized hit volume here so selection,
      // moving and deletion still work without resurrecting the old artwork.
      if (f.kind === 'lift') {
        const high = CEILING_Y + ELEVATOR_BASKET_H;
        const hit = new THREE.Mesh(PATH_GEO, FIXTURE_PICK_MAT);
        hit.scale.set(ELEVATOR_BASKET_SPAN, high, ELEVATOR_BASKET_SPAN);
        hit.position.set(0, high / 2, 0);
        hit.castShadow = false;
        hit.receiveShadow = false;
        prop.add(hit);
      }
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
      span('model');
      prop.userData.fixture = f.id;
      // ...and kept, so a marker can be built out of the art rather than out of
      // a guess at where the art is. Stamped here for `userData.fixture`'s own
      // reason: this is the one place that knows, because the group is built
      // FROM `f`.
      this.fixtureProps.set(f.id, prop);
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
        fxBox = new THREE.Box3().setFromObject(prop);
        this.propBoxes.set(f.id, fxBox);
      }
      // Baked, like the ground it stands on. A lamp is a point *under* a
      // canopy, so the lid of a display case faces away from every light in the
      // room and stays dark however bright the strip inside it is — which reads
      // as the upgrade not working. This has no direction to get wrong.
      //
      // Measured at half the unit's height, so a tall case is lit by what is
      // beside it rather than by what is on the floor at its feet.
      span('place');
      this.bakedProps.push({ group: prop, x: f.x, y: this.fixtureBaseY(f) + 0.5, z: f.z });
      this.paintProp(prop, f.x, this.fixtureBaseY(f) + 0.5, f.z);
      // ...and off layer 0 with the ground, or the eight real lights would light
      // it a second time and the units near you would flare as you walked.
      prop.traverse((o) => o.layers.set(BAKED_LAYER));
      // Its creases, in world space, while the prop is standing where it will
      // stand. BEFORE `land` below, deliberately: that animates a newly-placed
      // group down onto its tile, so edges cut afterwards would be frozen at
      // wherever the drop happened to start — a shelf you have just bought
      // wearing its lines a metre above itself, and only that one.
      // Anything with `motion` is skipped — a drawn line cannot follow a blade.
      {
        const moving = prop.userData.moving?.length
          ? new Set(prop.userData.moving.map((m) => m.mesh)) : null;
        span('bake');
        // Gathered into ONE geometry for this unit rather than pushed straight
        // onto the shop's pile — see `mergeEdges`. That is what makes a
        // contour keepable, and it is why `buildEdgeLines` is told it does not
        // own what it is handed.
        const mine = [];
        collectEdges(prop, mine, { skip: moving ? (o) => moving.has(o) : null });
        fxEdges = mergeEdges(mine);
        if (fxEdges) edges.push(fxEdges);
        span('ink');
      }
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
      // Filed for the next re-flow. An id already in here is one whose key just
      // failed, so what it was holding is freed rather than dropped — the group
      // is out of `staticRoot` by now (see `composeWorld`), so nothing else
      // would ever get round to it.
      if (artKey) {
        const stale = this.fixtureArt.get(f.id);
        if (stale) { disposeGroup(stale.group); stale.edges?.dispose(); }
        this.fixtureArt.set(f.id, {
          key: artKey, group: prop, edges: fxEdges, signal, model, box: fxBox,
        });
        keep.add(f.id);
      }
    }

    this.reflowKept = `${reused}/${keep.size}`;

    // Whatever the re-flow got rid of. Its group left `staticRoot` before the
    // teardown on the strength of being in here, so this is the only thing
    // standing between a deleted shelf and a leak.
    for (const [id, rec] of this.fixtureArt) {
      if (keep.has(id)) continue;
      disposeGroup(rec.group);
      rec.edges?.dispose();
      this.fixtureArt.delete(id);
    }

    // Every fixture's creases, as one object. Built whatever the switch says and
    // hidden if it is off, because the whole point of the switch is an A/B you
    // can make while standing still — a version that built on demand would need
    // a re-flow to answer, and a re-flow is the one thing that changes the
    // picture you were comparing.
    mark = performance.now();
    const lines = buildEdgeLines(edges, INK.COLOR, INK.AMOUNT, { own: false });
    span('ink');
    Object.assign(this.reflowPhases ?? {}, {
      'fx:model': spans.model, 'fx:place': spans.place, 'fx:bake': spans.bake, 'fx:ink': spans.ink,
      'fx:reuse': spans.reuse,
    });
    if (lines) {
      lines.layers.set(BAKED_LAYER);
      this.edgeRoot.add(lines);
    }
    this.edgeRoot.visible = this.edgeLines;

    // Lamps are set at the TOP of `buildWorld` now, not here, because the floor
    // is baked with them on the way past — this method runs after the tiles are
    // already coloured. It is the same call against the same layout either way.
  }

  /**
   * Drop the merged contour and its geometry.
   *
   * The geometry is a fresh merge per re-flow and nothing else holds it, so this
   * is the one place it can be freed — `disposeGroup` would not do it anyway,
   * since it looks for `isMesh` and a `LineSegments` is not one. The material is
   * per-build too (it carries an `onBeforeCompile`), so it goes with it.
   */
  /**
   * Throw the kept art away — for the two changes that are not in its key.
   *
   * A style and a catalog edit both redraw every fixture in the shop without
   * moving one of them, and both arrive through `rebuildWorld`. Putting them in
   * the key instead would mean a version number threaded through two files for
   * a thing that happens by hand, twice a session.
   */
  clearFixtureArt() {
    for (const rec of this.fixtureArt.values()) {
      this.staticRoot.remove(rec.group);
      disposeGroup(rec.group);
      rec.edges?.dispose();
    }
    this.fixtureArt.clear();
  }

  /**
   * Everything this fixture's art is derived from, as one string.
   *
   * The rule for adding to it: if `addFixtureProps` reads it while building the
   * group, it belongs here. Three of them are not facts about the fixture at
   * all, and those are the ones that make this hard —
   *
   * - **its NEIGHBOURS.** `carriesOn` drops the end panel where one unit runs
   *   into the next, and `boardProfile` compares their shelving, so a run's art
   *   changes when the thing beside it does. The eight surrounding tiles go in
   *   at the same fields `carriesOn` compares by. Miss this and building a
   *   shelf leaves the one next to it wearing an end panel through the middle
   *   of a row — invisible until you look at that shelf, and it will still be
   *   wrong tomorrow.
   * - **the FLOW.** A conveyor's deck is halved where nothing feeds it and its
   *   housing goes on a side nothing is attached to, and both are answers about
   *   the whole run — a belt laid at the far end of the shop re-cuts a corner
   *   thirty tiles away. So the path goes in whole.
   * - **the LIGHT**, which does not: `paintProp` is re-run on every reuse
   *   rather than keyed, because it is one tint on a group and re-tinting is
   *   far cheaper than deciding whether a lamp moved.
   *
   * `under` and `lift` opt out entirely, and that is a judgement rather than a
   * limitation: a tunnel mouth's art depends on which mouth it is PAIRED with
   * (`tunnelExit`), and a pairing is a matching down a whole chain rather than
   * anything a neighbourhood can see. There are a handful of each in a shop, so
   * the honest answer is to go on rebuilding them.
   */
  fixtureArtKey(L, f, byTile) {
    // eslint-disable-next-line no-use-before-define
    if (f.kind === 'under' || f.kind === 'lift') return null;
    // The setback is a fact about the WALL behind it, not about the fixture —
    // put a wall up behind a shelf and its art shifts forward. Nothing else in
    // here would say so, and what it draws as is one shelf buried in a wall you
    // have just built.
    const parts = [artFields(f), this.fixtureT(f), JSON.stringify(this.artSetback(L, f) ?? null)];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = byTile.get(`${f.x + dx},${f.z + dz}`);
        parts.push(n ? `${n.kind}/${n.piece ?? ''}/${n.tier ?? 1}/${n.variant ?? ''}/${n.rot ?? 0}` : '');
      }
    }
    if (CONVEYOR_KINDS.includes(f.kind)) {
      parts.push(JSON.stringify(this.conveyorPath(L, f) ?? null));
      parts.push(derivedFlow(f.kind) ? this.conveyorFacing(L, f) : (f.rot ?? 0));
    }
    return parts.join('|');
  }

  clearEdgeLines() {
    for (const o of [...this.edgeRoot.children]) {
      o.geometry?.dispose();
      o.material?.dispose();
      this.edgeRoot.remove(o);
    }
  }

  /**
   * The switch. See `DEBUGS` in client/debug.js.
   *
   * It shows the drawn creases AND stands the screen-space ones down, because
   * the two are answers to the same question rather than two layers — see
   * `Ink.setCrease`. With both on the comparison shows nothing at all, which is
   * exactly what it looked like before this line existed.
   */
  setEdgeLines(on) {
    this.edgeLines = !!on;
    this.edgeRoot.visible = this.edgeLines;
    this.ink?.setCrease(!this.edgeLines);
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
    // A piece may HANG OFF THE WALL HEAD, which is the one anchor an authored
    // model cannot express and the one that has to move when the building does.
    // An awning is the case: its art was drawn with its top flush under a wall
    // that stood at 1.4, so raising `WALL_H` left a canopy floating most of a
    // metre below the fascia it is supposed to be bolted to — which reads as the
    // awning being the wrong size, exactly as the ghost and the eye height did.
    //
    // It is the model's own TOP that lands on the line rather than its origin,
    // which is what makes it cost no content: the art is already drawn top-down
    // from wherever it used to hang, so nothing had to be re-authored and a
    // second design of one is drawn however its author likes and still bolts on
    // straight. `hangs` is a field on the PIECE and not on the kind — a
    // decoration standing on the floor and one hung off the wall are the same
    // build rules, the same price and the same everything else.
    if (this.pieceOf(f)?.hangs === 'head') {
      const top = modelBounds(partsAt(this.fixtureModel(f), this.fixtureT(f))).top;
      return EDGE_STYLE[E.WALL].h - top;
    }
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
   * What a `seam` part asks before it draws itself. The test is a compatible
   * kind of unit, stood the same way round, on the next tile along: an end
   * panel is there to close the run, and the run has not ended if what comes
   * next is more shelving with the same physical profile.
   *
   * A dry shelf ending at a freezer is the deliberate exception to "same
   * kind": the freezer's cabinet already closes the run, so keeping the
   * shelf's cap as well sandwiches a second full-height strip into the joint.
   * This is directional. The freezer keeps its cabinet side; only the redundant
   * open-rack cap disappears.
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
    const sameWay = n && rot4(n.rot ?? 0) === rot4(f.rot ?? 0);
    if (sameWay && f.kind === 'shelf' && n.kind === 'freezer') return true;
    const compatible = n && n.kind === f.kind;
    if (!compatible) return false;
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

  /**
   * Move the shop to a different sort of place, without rebuilding the shop.
   *
   * Exactly `setPaint`'s argument one ring further out: `buildWorld` disposes
   * every wall, floor, fixture and prop in the building and makes them again,
   * which is the right answer when something has moved and an absurd one for
   * the horizon. So the surround owns a group of its own, the way the edges do,
   * and this is the only thing that touches it.
   *
   * Idempotent, and that is not tidiness: `syncState` calls it on every
   * snapshot — ten times a second — so a version that rebuilt unconditionally
   * would be re-scattering five hundred instances and rebuilding a material at
   * 10Hz for as long as the game is open.
   */
  setSurround(id) {
    const want = surroundOf(id);
    if (want === this.surroundId) return;
    this.surroundId = want;
    if (!this.storeLayout) return;
    this.addSurround(this.storeLayout.w, this.storeLayout.h);
    this.recolourField();
  }

  /**
   * What colour the land past the lot is. See `ground` in `SURROUND_COLORS`.
   *
   * THE LOT'S OWN CELLS ARE NOT THIS, and that is the whole of the line. A bare
   * cell inside the lot is `PALETTE.grass` wherever the shop stands, because it
   * is YOUR ground — the difference between a shop in a city and a shop in the
   * country is what lies beyond the fence, not what you are standing on. Painted
   * the surround's colour, a countryside shop's grass came out the same stubble
   * as the field, which is a farm with no farm in it.
   *
   * What that costs is a seam at the edge of the lot, and it is the good kind:
   * a straight line where your green stops and the field starts is a boundary,
   * which is what it is.
   */
  fieldColor() {
    return surroundGround(this.surroundId ?? DEFAULT_SURROUND);
  }

  /**
   * Repaint the field for a surround that has just changed.
   *
   * A COLOUR AND NOT A REBUILD, which is the whole of why this exists. The apron
   * belongs to `buildWorld` — the one call that disposes every wall, floor,
   * fixture and prop in the building and makes them again. Running that off a
   * menu press to change one colour is the thing `setSurround` was split out to
   * avoid, and the shop would visibly blink.
   *
   * Nothing about the ground MOVED, so nothing has to be rebuilt: the apron is
   * one owned mesh with one colour on it (see `apronMaterial` for why it is
   * owned rather than shared), and moving to a place with different ground is a
   * write to that colour. Everything inside the lot is untouched by design —
   * see `fieldColor`.
   */
  recolourField() {
    this.apronMat?.color.set(this.fieldColor());
  }

  /**
   * Build (or rebuild) the land round the lot.
   *
   * THE MATERIAL IS DISPOSED BY HAND, and it is the one thing in here that
   * `disposeGroup` cannot do for us. That function frees geometry and instance
   * buffers and deliberately leaves materials alone, because every other
   * material in the renderer comes out of the shared `material()` cache and
   * disposing one would take it away from everything else drawn in that colour.
   * Every material in a surround is either a clone (so the haze shader can be
   * hung on it without putting itself on every object in the game that happens
   * to share a colour) or a one-off (the window glow, which has to be lerped).
   * So `surround.js` hands back a `dispose` for the lot, and this is the only
   * place that calls it. Miss it and a build drag leaks a handful of materials
   * per wall segment.
   */
  addSurround(w, h) {
    if (this.surroundGroup) {
      this.staticRoot.remove(this.surroundGroup);
      disposeGroup(this.surroundGroup);
      this.surroundFree?.();
    }
    const { group, glow, dispose } = buildSurround(this.surroundId ?? DEFAULT_SURROUND, w, h);
    this.surroundGroup = group;
    this.surroundGlow = glow;
    this.surroundFree = dispose;
    // Off layer 0 with every other bit of ground, and the day reaches it the way
    // it reaches the apron — through `HAZE.day` in its own shader rather than
    // through the sky, which is held at midday now. A horizon that never set,
    // over a lawn that did, would be the one seam in this scene an eye reliably
    // catches.
    group.traverse((o) => o.layers?.set(BAKED_LAYER));
    // ...except the far band, which needs its own so `Ink` can leave it out of
    // the normals draw. After the traverse, or the sweep above would put it
    // straight back on the baked layer with everything else.
    // Held rather than looked up: `aimSurround` switches it on and off every
    // frame, and `getObjectByName` recurses the whole subtree to answer.
    this.surroundFar = group.getObjectByName('surround-far') ?? null;
    this.surroundFar?.layers.set(SURROUND_LAYER);
    this.staticRoot.add(group);
    // The windows are built at their daytime colour, so a surround switched on
    // after dark would draw one frame of noon before the next snapshot. One
    // frame is a flash of a lit city going dark and back, which reads as a
    // rendering fault rather than as a load.
    this.lightSurround(this._daylight ?? 1);
  }

  /**
   * The windows, on the same clock as the sky.
   *
   * A ramp rather than a switch, and it runs OUT ahead of the sun (`daylight`
   * cubed): a city whose lights came up linearly with the light going down is
   * lit at four in the afternoon. Cubing keeps them out through the whole of a
   * bright day and brings them on over the last of the dusk, which is roughly
   * what a real one does and, more to the point, is when the shop's own lamps
   * come on — the two reading as one moment is the entire effect.
   */
  lightSurround(daylight) {
    if (!this.surroundGlow) return;
    this.surroundGlow.color.copy(GLOW_NIGHT).lerp(GLOW_DAY, daylight ** 3);
  }

  /**
   * Tell the backdrop where the camera is, so the quarter of the ring standing
   * in front of the shop can get out of the way.
   *
   * Per frame rather than on a camera event, because there is no such event: the
   * yaw eases through a quarter turn and the pitch is dragged continuously, so
   * anything hung on "the camera moved" would either miss frames or need a
   * second copy of the easing. It is three floats and a `sin`/`cos`.
   *
   * `HIDE_PITCH_*` is the whole of what keeps this from firing when nobody asked.
   * At the home pose the near band sits along the bottom of the frame and gives
   * the shot a foreground, so it is left completely alone; the strength only
   * comes up as the view is flattened toward the angle where a hill genuinely
   * covers the building. Between the two it eases, or dropping the camera would
   * make a hillside vanish on one frame.
   */
  aimSurround() {
    /**
     * Which way the camera lies, read off `camOffset` rather than rebuilt from
     * an angle — the same call `panBy` and the edge arrows make two hundred
     * lines up, and for a sharper reason than tidiness. `aimCamera` builds that
     * vector from `camAngle`, which is the EASED heading; `camYaw` is the one
     * the keys and the drag write, and the two differ for the whole of every
     * quarter turn. Deriving from the wrong one would slide the hole out of the
     * ring and back as the view swung, which reads as the far side flickering.
     */
    const hx = this.camOffset.x;
    const hz = this.camOffset.z;
    const flat = Math.hypot(hx, hz) || 1;
    HAZE.near.value.set(
      hx / flat,
      hz / flat,
      // 0 above HIDE_PITCH_OFF, 1 below HIDE_PITCH_FULL.
      1 - clamp((this.camPitch - HIDE_PITCH_FULL) / (HIDE_PITCH_OFF - HIDE_PITCH_FULL), 0, 1),
    );

    /**
     * ...and switch the far band off entirely at pitches that cannot see it.
     *
     * This is the one thing in the backdrop with a real cost, and the cost is
     * OVERDRAW rather than draw calls: it is a couple of hundred objects twenty
     * to forty tiles wide, stacked ten deep from a low camera, and instances
     * inside one `InstancedMesh` are not sorted against each other — so three's
     * usual front-to-back ordering buys nothing and every one of them shades
     * every pixel it covers. Roughly nothing else in this scene has that shape.
     *
     * At the home pitch the whole layer is well off screen (see the table in
     * `surround.js` — the camera reaches nine tiles at 40°, and this band starts
     * at eighteen), so ordinary play should not be paying for it at all. A flag
     * per frame is the entire fix.
     *
     * `FAR_SHOW_PITCH` is deliberately looser than `HIDE_PITCH_OFF`: the band
     * has to be up BEFORE it could be seen, or flattening the camera pops a
     * mountain range into existence.
     */
    if (this.surroundFar) this.surroundFar.visible = this.camPitch < FAR_SHOW_PITCH;
  }

  /**
   * The roof, which is the indoor mask given a mesh.
   *
   * The shop has believed it has one for a long time. `Lights.openness` answers
   * 0 indoors and dims that cell to `ROOF_LEVEL`, and `WAYS` authors `roofs` per
   * opening — a curtain roofs and a gate does not. What was never drawn is the
   * surface itself, which does not matter from 40° up and is the whole of the
   * room at eye level: first person put the camera at `FPV_Y` inside a building
   * open to the sky.
   *
   * Four things about it.
   *
   * It is PER CELL and never a lid shaped like the building, which is what
   * answers "and sometimes I want to see outside" with no toggle in it. The mask
   * has the doorway in it, so walking out ends the ceiling at the wall line
   * behind you; standing in the yard there is none; knocking the back wall out
   * opens the shop to the weather. All of that is the same question the light
   * has always asked, so none of it is a second rule that could disagree.
   *
   * It is drawn ONLY IN FIRST PERSON, and that is this game's answer to the rule
   * every game with this problem shares — the roof is hidden for the room the
   * camera is in. There are no rooms here to be in one of (enclosure is
   * shop-wide), so the axis that survives is the mode, and it says the same
   * thing: overhead, the camera is never in a room; at eye level it always is.
   * `ghostNearWalls` already draws exactly this line about walls.
   *
   * It casts NO SHADOW. three has no half-shadow — the map is a depth pass, so a
   * part casts fully or not at all — and a lit plane over the whole shop floor
   * would put the building in permanent darkness from the sun. Glass and a
   * ghosted wall opt out for the same reason.
   *
   * And it takes no RAY. `pickFixture` raycasts the art under `staticRoot`, and
   * a surface between the camera and everything else would answer every pick in
   * the shop. Being invisible outside first person is not the same claim as
   * being unhittable, so it says so itself rather than resting on the mode.
   *
   * A shop with no enclosure gets none of it, and that is correct here rather
   * than a bug to be patched: `computeIndoor` answers *zero* indoor cells rather
   * than fewer, which is the trap named all over CLAUDE.md — and this is the one
   * place where the all-or-nothing answer is the honest picture. A building with
   * a hole in it has no roof. Do not copy the keeping rule the ceiling-duct
   * branch of `canPlace` needed; that one existed because the failure DESTROYED
   * builds, and a drawing destroys nothing.
   */
  addCeiling(L) {
    const cells = [];
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) if (L.indoor?.[z * L.w + x]) cells.push([x, z]);
    }
    if (!cells.length) return;

    // The slab, the upstand and the glazing go up and come down together, so
    // they hang off one group and the mode toggles one flag. They are also the
    // only three things in the shop that share a fate: none of them exists
    // without the others, and a room with a roof and no walls up to it is worse
    // than no roof at all.
    const group = new THREE.Group();
    group.visible = this.fpv;

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, ROOF_SLAB, 1), material(0xffffff), cells.length,
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
    // The unlit colour and where it is, kept for `rebakeGround` the way every
    // other baked batch keeps them: the hour moves and the jitter does not.
    const bare = new Float32Array(cells.length * 3);
    const at = new Float32Array(cells.length * 3);
    const dummy = new THREE.Object3D();

    cells.forEach(([x, z], i) => {
      dummy.position.set(x, ROOF_Y + ROOF_SLAB / 2, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // White material, absolute instance colour — `instanceColor` MULTIPLIES,
      // so a material carrying the hue as well draws the ceiling at roughly
      // colour squared. The floor loop above documents what that looks like.
      const c = new THREE.Color(jitter(PALETTE.ceiling, 0.03, x * 31 + z * 17));
      bare[i * 3] = c.r;
      bare[i * 3 + 1] = c.g;
      bare[i * 3 + 2] = c.b;
      at[i * 3] = x;
      at[i * 3 + 1] = ROOF_Y;
      at[i * 3 + 2] = z;
      // Baked at the UNDERSIDE, which is the only side anybody is ever under.
      mesh.setColorAt(i, this.lights.bakeInto(c, x, ROOF_Y, z));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.raycast = () => {};
    // Off layer 0 with the rest of the baked geometry, or the eight real lamps
    // pool on it a second time. See `BAKED_LAYER`.
    mesh.layers.set(BAKED_LAYER);
    this.bakedGround.push({ mesh, bare, at });
    group.add(mesh);

    this.addClerestory(L, group);
    this.staticRoot.add(group);
    this.ceiling = group;
  }

  /**
   * What closes the gap between the wall top and the roof.
   *
   * The roof has to clear the overhead network, and the walls stop at 2.10, so
   * something has to happen in the 1.40 tiles between them or the room is open
   * to the sky — which from a chair reads as a wall that ran out rather than as
   * a building. What goes in there is a low upstand and a strip of glass, and
   * the split is the only interesting decision in this method: the solid part
   * stops at `CEILING_Y`, which is exactly where the overhead deck begins.
   *
   * That is what makes the two heights explain each other rather than being two
   * unrelated numbers. The wall stops where the ducts start; the glass is
   * precisely the clearance the lift baskets needed. Both bands are DERIVED — the
   * upstand is `LIFT` and the glazing is `ELEVATOR_BASKET_H + ROOF_CLEAR` — so a
   * taller shaft or a taller wall moves the band rather than breaking it.
   *
   * Three things about it.
   *
   * It follows the MASK's boundary rather than the walls, which is the same
   * source the slab itself comes off. Reading `edgesV`/`edgesH` instead would
   * mean deciding what an upstand does above a doorway, an arch and a curtain —
   * three answers to a question that has one, since every enclosing opening is
   * solid masonry well below 2.10 anyway. A cell being indoors and its neighbour
   * not is the whole of it.
   *
   * A PARTITION gets none. Both sides indoors is not a boundary, so a stockroom
   * divider stays at 2.10 and you can see over it — which is what an internal
   * wall does in a real shop, and is the same distinction `isPartition` draws
   * about the cutaway one method along.
   *
   * And NOTHING here casts a shadow, the slab included. `Lights` already dims an
   * indoor cell to `ROOF_LEVEL` because it has always believed in this roof; a
   * band that also cast one would be the building darkened twice, and three has
   * no half-shadow to soften it with.
   */
  addClerestory(L, group) {
    const wall = EDGE_STYLE[E.WALL];
    const inAt = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
      ? 0 : (L.indoor?.[z * L.w + x] ?? 0));

    const segs = [];
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        if (!inAt(x - 1, z) !== !inAt(x, z)) segs.push([x - 0.5, z, true]);
      }
    }
    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        if (!inAt(x, z - 1) !== !inAt(x, z)) segs.push([x, z - 0.5, false]);
      }
    }
    if (!segs.length) return;

    const box = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();
    // Run long by the wall's own thickness so the corners have no daylight seam
    // in them — the hair the door piers are widened by, said about a band thin
    // enough that a seam would be most of what you see of it.
    const len = 1 + wall.t;

    const band = (y0, y1, mat) => {
      const mesh = new THREE.InstancedMesh(box, mat, segs.length);
      segs.forEach(([x, z, vertical], i) => {
        dummy.position.set(x, (y0 + y1) / 2, z);
        dummy.scale.set(vertical ? wall.t : len, y1 - y0, vertical ? len : wall.t);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.raycast = () => {};
      group.add(mesh);
    };

    // The wall's own colour and the wall's own thickness, because this IS the
    // wall as far as anybody standing under it is concerned — a band a shade off
    // would read as a course of something else laid on top.
    band(wall.h, CEILING_Y, material(wall.color));
    // ...and the same colour again at `GLASS`, which is how every other pane in
    // the game is glazed. See the alpha band in `edgeBands`.
    band(CEILING_Y, ROOF_Y, material(wall.color, GLASS));
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
    // ...and by which way it faces OUT of the building, because that is the one
    // thing `ghostNearWalls` needs and an instanced mesh cannot say per
    // instance: a batch takes one material, so the two faces standing between
    // the camera and the shop have to be batches of their own. A wall with no
    // outside — any wall at all in a shop whose enclosure has come down — keys
    // as '' and is never faded.
    const push = (kind, vertical, spec) => {
      const k = `${kind}:${vertical ? 'v' : 'h'}:${spec.color ?? ''}:${spec.skin ?? ''}:${spec.face ?? ''}`;
      if (!runs.has(k)) runs.set(k, { kind, vertical, face: spec.face ?? '', boxes: [] });
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
    // ...and ZERO is now a real answer rather than a fallback, which is the half
    // `ghostNearWalls` rests on. "Both sides agree" is not a side, and the two
    // callers want opposite things from it: a bay has to project SOMEWHERE, so
    // it keeps the arbitrary +1 below, while a wall with no outside must never
    // be taken down — hiding an interior partition because it happens to lie
    // across the view is the shop losing rooms as you turn the camera.
    const sides = (vertical, x, z) => {
      const m = L.indoor;
      if (!m) return null;
      const at = (cx, cz) => (cx < 0 || cz < 0 || cx >= L.w || cz >= L.h
        ? 0 : m[cz * L.w + cx]);
      return [vertical ? at(x - 1, z) : at(x, z - 1), at(x, z)];
    };
    const outSign = (vertical, x, z) => {
      const s = sides(vertical, x, z);
      if (!s || s[0] === s[1]) return 0;
      return s[0] ? 1 : -1;
    };
    const outward = (vertical, x, z) => outSign(vertical, x, z) || 1;

    /**
     * A PARTITION: shop floor on both sides of it.
     *
     * The distinction the cutaway rests on, and the reason it is asked rather
     * than read off a zero sign. Zero means "the two sides agree", which is two
     * completely different walls — a stockroom divider, and every wall in the
     * building the moment somebody knocks a hole in one, since `computeIndoor`
     * answers zero indoor cells rather than fewer. Told apart by WHICH way they
     * agree: both indoors is a room boundary and comes down with the rest, both
     * outdoors is a shop that has lost its enclosure and must never be touched.
     */
    const isPartition = (vertical, x, z) => {
      const s = sides(vertical, x, z);
      return !!s && !!s[0] && !!s[1];
    };

    /**
     * Which batch a wall belongs to: one of the four outward faces, a partition's
     * own lattice line, or '' for a wall with nothing to say.
     *
     * A partition has no facing to test and does not need one — it is symmetric,
     * so whichever side you stand it is between the camera and half of a room.
     * That is why it is its own answer rather than a sign: the four outer faces
     * come down two at a time depending where you are looking from, and an
     * internal wall comes down whenever the cutaway is on at all.
     */
    const faceOf = (vertical, x, z) => {
      const s = outSign(vertical, x, z);
      if (s) return `${vertical ? 'x' : 'z'}${s > 0 ? '+' : '-'}`;
      return isPartition(vertical, x, z) ? FACE_IN : '';
    };

    // What is on a given boundary. Up here rather than beside the door pier pass
    // below, because `emit` asks them too — see the jamb test. Both clamp, which
    // the pier pass did at each call site instead: `edgesH` is one flat row per
    // z, so a bare `x - 1` at the west wall is not out of bounds, it is the far
    // END of the row above, and a neighbour test written that way answers about
    // a wall on the other side of the building.
    const verticalAt = (x, z) => (z < 0 || z >= L.h ? 0 : L.edgesV?.[z * (L.w + 1) + x] ?? 0);
    const horizontalAt = (x, z) => (x < 0 || x >= L.w ? 0 : L.edgesH?.[z * L.w + x] ?? 0);

    const emit = (kind, vertical, cx, cz, x, z) => {
      const style = EDGE_STYLE[kind];
      if (!style) return;
      const dir = style.out ? outward(vertical, x, z) : 1;
      const face = faceOf(vertical, x, z);
      const bands = edgeBands(style);
      // A run of doorway is ONE opening — which is what the door pier pass below
      // has always said about the masonry, and the frame owes the same answer.
      // So a jamb stands where the run ENDS: the band names which side of its
      // cell it is on (`jamb`, see `FRAME_JAMB` in palette.js) and the boundary
      // that way decides whether it is drawn at all. Lined cell by cell instead,
      // a wide entrance draws as a rank of posts standing in the way in.
      //
      // The test is "is that one framed too" rather than "is it the same kind",
      // so a shopfront door beside a plain one is one opening with one frame
      // round it — which is what it looks like from a chair.
      const framedOn = (s) => !!EDGE_STYLE[
        vertical ? verticalAt(x, z + s) : horizontalAt(x + s, z)]?.frame;
      for (const band of bands) {
        if (band.jamb && framedOn(band.jamb)) continue;
        push(kind, vertical, { cx, cz, dir, face, ...band });
      }

      // ...and the finish on either side of it, as a skin over the bands that
      // are wall. Two things are deliberately left bare. GLASS, because paint on
      // a window is paint on the frame — a finish over the pane is a bricked-up
      // window, and the sill and header beside it take the colour anyway. And a
      // band that already carries a COLOUR of its own, which is the painted
      // threshold under a signed doorway: that stripe is the only thing on
      // screen saying who a door is for, and a finish that covered it would
      // delete the one visible half of a feature that is otherwise invisible.
      //
      // The FRAME is the exception to that second rule, and it is the one thing
      // in here that carries a colour and still takes the brush — see
      // `frameTint`. A doorway's joinery is set in the wall rather than standing
      // beside it like a hedge, so a frontage where the header turned and the
      // frame stayed put reads as the paint not having reached rather than as a
      // decision. It goes on a step down from whatever the wall became, which is
      // what keeps it a frame afterwards.
      for (const side of [-1, 1]) {
        const surface = paintOn(vertical ? 'v' : 'h', x, z, side);
        if (!surface) continue;
        for (const band of bands) {
          if (band.alpha !== undefined) continue;
          if (band.color && !band.trim) continue;
          // A jamb the run swallowed has no skin either — otherwise the finish
          // draws the post back on in the middle of the opening, which is the
          // bug this pass was written to remove wearing the paint tool.
          if (band.jamb && framedOn(band.jamb)) continue;
          // The pattern is read at the band's own height rather than per cell,
          // because a wall repeats UP as well as along: `patternColor` takes two
          // coordinates and the second one here is the course, not the row.
          const tone = patternColor(surface, vertical ? z : x, Math.round(band.y0 * 8));
          push(kind, vertical, {
            cx, cz, dir, face, y0: band.y0, y1: band.y1, skin: side,
            // A frame member covers PART of its cell — a jamb is a short band
            // that happens to be tall — so its skin has to be told the same, or
            // painting the wall lays a slab of finish across the way through.
            off: band.off, len: band.len,
            color: band.trim ? frameTint(tone) : tone,
          });
          // Joinery takes the colour and never the COURSES: brick laid over a
          // jamb is a frame built out of masonry, which is an arch.
          if (band.trim) continue;
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
              cx, cz, dir, face, y0: b.y0, y1: b.y1, skin: side, proud: true,
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

    /**
     * A doorway has no jambs along its span — it is a hole in a wall — but two
     * doorways turning a corner still need the shared pier that carries their
     * lintels. Without it, both openings end at the same lattice point and the
     * corner is a column of air. That reads as the roof having failed, not as a
     * generous entrance.
     *
     * A pier belongs at a vertex only when a door reaches it from both axes.
     * Looking at both segments on each axis covers every direction a pair can
     * meet from, while making a four-way crossing one post rather than four.
     * Gates, shutters and curtains deliberately keep their own constructions:
     * this is the masonry support particular to two doorways.
     */
    const doorCorners = [];
    const isDoor = (kind) => wayBase(kind) === 'door';

    /**
     * The cap on each edge stops at its lattice point. At a right-angle join,
     * the two thin cap strips therefore leave the outer quarter of that point
     * notched away. One square of the same cap material completes the moulding
     * into a crisp corner without changing the thickness of either wall.
     */
    /**
     * Which way a lattice VERTEX faces out, for the pieces that stand on one
     * rather than on an edge — the corner cap, a door pier, an arch join.
     *
     * The sum of the outward signs of the walls actually meeting there, which
     * gives the three answers a corner has and nothing has to enumerate them.
     * Down a straight run both segments agree, so the vertex hides with its
     * wall. At the near corner of a building the two disagree in axis and the
     * diagonal points at the camera, so it goes too. At the far corner of a
     * hidden wall the sum comes out square to the view and the piece stays,
     * which is right: it is still capping the wall that is standing.
     *
     * Only walls that EXIST count. The mask alone would answer for a boundary
     * with no wall on it, and a cap at the end of nothing is a floating tile.
     */
    const vertexFace = (x, z) => {
      let fx = 0;
      let fz = 0;
      let inside = false;
      const seg = (vertical, sx, sz) => {
        if (vertical) fx += outSign(true, sx, sz);
        else fz += outSign(false, sx, sz);
        inside ||= isPartition(vertical, sx, sz);
      };
      if (z > 0 && verticalAt(x, z - 1)) seg(true, x, z - 1);
      if (z < L.h && verticalAt(x, z)) seg(true, x, z);
      if (x > 0 && horizontalAt(x - 1, z)) seg(false, x - 1, z);
      if (x < L.w && horizontalAt(x, z)) seg(false, x, z);
      if (fx || fz) return `${Math.sign(fx)},${Math.sign(fz)}`;
      // Nothing pointing anywhere and yet walls meeting here: a corner between
      // two partitions, which fades when they do.
      return inside ? FACE_IN : '';
    };

    const cornerCaps = new Map();
    const addCornerCap = (style, x, z, span) => {
      const face = vertexFace(x, z);
      const key = `${style.top}:${style.h}:${span}:${face}`;
      if (!cornerCaps.has(key)) cornerCaps.set(key, { style, span, face, points: [] });
      cornerCaps.get(key).points.push({ x: x - 0.5, z: z - 0.5 });
    };
    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        const vertical = [z > 0 && verticalAt(x, z - 1), z < L.h && verticalAt(x, z)]
          .map((kind) => EDGE_STYLE[kind])
          .find((style) => style?.top);
        const horizontal = [x > 0 && horizontalAt(x - 1, z), x < L.w && horizontalAt(x, z)]
          .map((kind) => EDGE_STYLE[kind])
          .find((style) => style?.top);
        if (!vertical || !horizontal || vertical.top !== horizontal.top || vertical.h !== horizontal.h) continue;
        addCornerCap(vertical, x, z, Math.max(vertical.t, horizontal.t) + 0.06);
      }
    }

    for (const { style, span, face, points } of cornerCaps.values()) {
      const caps = new THREE.InstancedMesh(box, material(style.top), points.length);
      caps.receiveShadow = true;
      caps.userData.outward = faceVector(face);
      caps.userData.hue = style.top;
      caps.userData.spots = cellsOf(points);
      points.forEach((point, i) => {
        dummy.position.set(point.x, style.h + 0.03, point.z);
        dummy.scale.set(span, 0.07, span);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        caps.setMatrixAt(i, dummy.matrix);
      });
      caps.instanceMatrix.needsUpdate = true;
      this.edgeGroup.add(caps);
    }

    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        const vertical = [z > 0 && verticalAt(x, z - 1), z < L.h && verticalAt(x, z)]
          .find(isDoor);
        const horizontal = [x > 0 && horizontalAt(x - 1, z), x < L.w && horizontalAt(x, z)]
          .find(isDoor);
        if (!vertical || !horizontal) continue;
        const style = EDGE_STYLE[vertical];
        doorCorners.push({
          x: x - 0.5, z: z - 0.5, h: style.h, t: style.t, color: style.color,
          face: vertexFace(x, z),
        });
      }
    }

    // Grouped by face for `ghostNearWalls`, the same as everything else on a
    // boundary: a pier left solid in a wall you are seeing
    // through is a column of masonry standing in mid-air.
    for (const [face, piers] of byFace(doorCorners)) {
      const posts = new THREE.InstancedMesh(box, material(piers[0].color), piers.length);
      posts.castShadow = true;
      posts.receiveShadow = true;
      posts.userData.outward = faceVector(face);
      posts.userData.hue = piers[0].color;
      posts.userData.spots = cellsOf(piers);
      piers.forEach((post, i) => {
        // A hair wider than the wall lets the pier meet both thin edge shells
        // cleanly at the point they share, instead of leaving a daylight seam.
        const span = post.t + 0.02;
        dummy.position.set(post.x, post.h / 2, post.z);
        dummy.scale.set(span, post.h, span);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        posts.setMatrixAt(i, dummy.matrix);
      });
      posts.instanceMatrix.needsUpdate = true;
      this.edgeGroup.add(posts);
    }

    /**
     * An arch's sides are corbelled into its own cell, so one arch remains an
     * open span. Two consecutive arches are different: the two inner corbels
     * meet at a lattice point and need one continuous centre pier below them.
     * Otherwise that joint is a hanging T of masonry, which is especially
     * obvious against a lit floor.
     */
    const archJoins = [];
    const isArch = (kind) => wayBase(kind) === 'arch';
    for (let z = 0; z <= L.h; z++) {
      for (let x = 0; x <= L.w; x++) {
        const vertical = z > 0 && z < L.h && isArch(verticalAt(x, z - 1)) && isArch(verticalAt(x, z));
        const horizontal = x > 0 && x < L.w && isArch(horizontalAt(x - 1, z)) && isArch(horizontalAt(x, z));
        if (!vertical && !horizontal) continue;
        const kind = vertical ? verticalAt(x, z - 1) : horizontalAt(x - 1, z);
        const style = EDGE_STYLE[kind];
        archJoins.push({
          x: x - 0.5, z: z - 0.5, h: style.h, t: style.t, color: style.color,
          face: vertexFace(x, z),
        });
      }
    }

    for (const [face, joins] of byFace(archJoins)) {
      const posts = new THREE.InstancedMesh(box, material(joins[0].color), joins.length);
      posts.castShadow = true;
      posts.receiveShadow = true;
      posts.userData.outward = faceVector(face);
      posts.userData.hue = joins[0].color;
      posts.userData.spots = cellsOf(joins);
      joins.forEach((post, i) => {
        const span = post.t + 0.02;
        dummy.position.set(post.x, post.h / 2, post.z);
        dummy.scale.set(span, post.h, span);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        posts.setMatrixAt(i, dummy.matrix);
      });
      posts.instanceMatrix.needsUpdate = true;
      this.edgeGroup.add(posts);
    }

    for (const { kind, vertical, face, boxes } of runs.values()) {
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
        mesh.userData.outward = faceVector(face);
        // What it takes to put this batch back — `ghostNearWalls` swaps the
        // material for a see-through one keyed to the same colour, and a batch
        // that could not name its own hue and alpha would have to come back as a
        // guess. Glass is in here too and keeps its own, or a shopfront fades to
        // the ghost's alpha and then cannot fade back.
        mesh.userData.hue = set[0].color ?? style.color;
        mesh.userData.alpha = alpha;
        mesh.userData.spots = cellsOf(set);
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
      cap.userData.outward = faceVector(face);
      cap.userData.hue = style.top;
      cap.userData.spots = cellsOf(capped);
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
    // Kept for the frame loop rather than only passed on, because one thing in
    // there has to know which body is YOURS: an emote turns a shopper to face
    // the camera and must not turn you (see `animateEmote`). It arrives ten
    // times a second and never changes, so this is a stash rather than state.
    this.myId = myId;
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
    this.syncActors(state.customers, this.customers,
      (c) => this.crowdBody(c.color, { variant: c.id, varied: true, look: c.look ?? null }));
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
    /**
     * ...and which side it REJECTS down, which is the only thing about a
     * conveyor that nothing in the world drew.
     *
     * Every other readout on these roofs is an EVENT — a box went that way, a
     * box was passed on — and this one is a SETTING, so it is the resting
     * colour of a bar rather than a flash. Which is exactly why it was missing
     * and hard to notice missing: a junction with a live reject line and one
     * without are the same dark roof, and the only other place the answer
     * existed was a menu row that says "the way it points" about a piece seen
     * from above on a camera that turns.
     *
     * Off the SNAPSHOT rather than off the layout record the bars were built
     * from, because `setSorterReject` does not re-flow — it has no reason to,
     * nothing in `conveyorFlow` reads the field — so a flag baked in at build
     * time would be right until the first time anybody changed it and then
     * stay wrong until the next thing they built.
     */
    this.sortReject = new Map((state.sorters ?? [])
      .filter((s) => Number.isInteger(s.reject)).map((s) => [s.id, s.reject]));
    /**
     * ...and which junctions have nothing to choose between — see `straight` on
     * the wire.
     *
     * A SETTING like `sortReject` rather than an event, and read the same way:
     * the resting colour of the lamp rather than a flash. It is the one state on
     * a conveyor that is invisible by construction — a sorter draws its blades
     * from `conveyorBranches`, so one with no branch has a smooth roof, and a
     * smooth roof reads as art that has not turned yet rather than as a machine
     * doing nothing. Every box that reaches it goes straight on and arrives
     * perfectly correctly, which is what makes it survive a whole save.
     */
    this.sortStraight = new Set((state.sorters ?? [])
      .filter((s) => s.straight).map((s) => s.id));
    // The server owns only the lift's gameplay state. The page owns the visual
    // stroke: when phase/owner changes it starts one local transition and then
    // ignores repeated 10Hz snapshots of that same state. Streaming a rounded
    // piston position made the animation jitter and allowed packet-time owner
    // changes to put a different crate on the platform.
    const shaftStamp = performance.now() / 1000;
    const adoptTransition = (records, previous) => new Map(records.map((record) => {
      const prior = previous?.get(record.id) ?? null;
      // `from` and `duration` describe where a late snapshot joins an already
      // running server phase. They may shrink on later snapshots, but that is
      // still the same stroke: phase/owner/target identify its discrete state
      // and prevent the 10Hz wire from restarting the local animation.
      const key = `${record.phase}:${record.owner ?? ''}:${record.to}`;
      if (prior?.key === key) return [record.id, prior];
      const next = {
        key,
        owner: record.owner ?? null,
        phase: record.phase ?? 'idle',
        from: record.from,
        to: record.to,
        duration: Math.max(0.01, record.duration ?? 0.01),
        at: shaftStamp,
      };
      return [record.id, next];
    }));
    const shaftRecords = [
      ...(state.arms ?? []), ...(state.sorters ?? []), ...(state.lifts ?? []),
    ].filter((fixture) => fixture.shaft)
      .map((fixture) => ({
        id: fixture.id,
        owner: fixture.shaftOwner ?? null,
        phase: fixture.shaftPhase ?? 'idle',
        from: fixture.shaftFrom ?? fixture.shaftAt ?? 0,
        to: fixture.shaftTo ?? fixture.shaftAt ?? 0,
        duration: fixture.shaftDuration ?? 0.01,
      }));
    this.shaftState = adoptTransition(shaftRecords, this.shaftState);
    /**
     * HOW FAR DOWN EACH TUNNEL MOUTH'S CARRIER IS — read off the box standing
     * on it, and off nothing else.
     *
     * A mouth used to be handed a stroke of its own: a phase, two endpoints and
     * a duration, per crate, on the wire, adopted into a client-side transition
     * beside the shaft's. Every one of those was a second spelling of the
     * crate's own `deck`, which the wire already carries for the lift — and two
     * spellings of "a box is between decks" is two clocks that drift, which is
     * the whole reason the tunnel stopped being its own ecosystem.
     *
     * Matched by POSITION rather than by `belt`, and that is not laziness: a
     * crate is filed against the cell it last left for the whole of a long hop,
     * so the far mouth's own rise would never appear under its id. Where the
     * box physically is answers for both ends of the tunnel with one rule.
     */
    this.mouthSink = new Map();
    for (const delivery of state.deliveries ?? []) {
      const deck = delivery.deck ?? 0;
      if (Math.abs(deck) < 1e-6) continue;
      const mouth = (this.storeLayout?.unders ?? []).find((u) => Math.abs(u.x - delivery.x) < 0.02
        && Math.abs(u.z - delivery.z) < 0.02);
      if (!mouth) continue;
      // BELOW IS ALWAYS THIS MOUTH'S. Above is only its own if it was told to
      // come up there — and that guard is the whole of what keeps a matching
      // rule honest, because the square a mouth stands on is also the square a
      // duct flies over. Without it any crate riding the run overhead is read
      // as this mouth's box, on the strength of standing at the same x and z
      // four metres up: the carrier chases it to the ceiling and the readout
      // lights, on a tunnel whose setting says it surfaces onto the floor.
      // Which is a tunnel that behaves as though a switch you can see is off
      // were on.
      if (deck > 0 && mouth.riser !== true) continue;
      this.mouthSink.set(mouth.id, deck);
    }
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
    // Kept so `addSurround` can light a freshly built horizon at the hour it is
    // actually being built at — see the note there on the one-frame flash.
    this._daylight = daylight;

    // Where the shop is, which rides in the save. Asked every snapshot rather
    // than pushed on its own message, because it is one string on a state
    // update that is already arriving — and `setSurround` returns immediately
    // when nothing has changed, which is every snapshot but the one after
    // somebody presses a row.
    this.setSurround(state.surround);

    // The look moves the NOON end of all three and leaves dusk where it was —
    // see `AMBIENT_NOON` in look.js, which is the same shape `SKY_TOP` uses one
    // function down. Scaled instead, the look would darken the evening far more
    // than it darkens midday, and three bands with a floor under them turn that
    // into a shop with no lit faces left in it at all.
    const look = lookOn();
    const sunTop = look ? SUN_NOON : 1.30;
    const fillTop = look ? AMBIENT_NOON : 0.90;

    /**
     * THE SKY IS HELD AT MIDDAY — the one line the roof is made of.
     *
     * The sun used to ramp its level and swing its hue between here and
     * `SUN_DUSK`, and the fill with it, which is a correct model of a field and
     * a wrong one of a building: a room is lit by its ceiling, so a shop at
     * eight in the evening should be the shop it was at noon and the evening
     * should be a thing you can see happening through the door.
     *
     * So all three are frozen at the top of the day and the whole cycle moves
     * into the bake, where it is a *darkening* of everything outdoors that knows
     * where the walls are. Outdoors comes out identical to the byte — the ratio
     * that darkens a tile is against the very light being held here, so the two
     * cancel — and indoors simply stops getting dark. See THE ROOF in
     * `lights.js` for why it has to be this way round rather than the obvious
     * one, which is `paintLit`'s clamp and is not a tuning problem.
     */
    this.sun.intensity = sunTop;
    this.sun.color.copy(SUN_HIGH);
    this.bounce.intensity = look ? BOUNCE_LOOK : 0.32;

    // `spill` is every lamp too far away to be given a real light, folded into
    // one number — so panning sharpens the near end of the shop rather than
    // switching the far end off. It only ever lifts the things the bake cannot
    // reach now; the floor already has every one of those lamps in it.
    this.lights.setDaylight(daylight);
    // ...and what the day is worth against its own best, which is what the bake
    // spends on everything outdoors. Both halves are computed from the same
    // function at two hours rather than one being a stored constant, because two
    // of the three terms move with the look — a reference frozen at boot would
    // be midday in the OTHER style the moment somebody pressed the switch.
    this.lights.setSky(
      this.skyLight(daylight, this._skyNow ??= new THREE.Color()),
      this.skyLight(1, this._skyRef ??= new THREE.Color()),
    );
    // The two outdoor surfaces the bake cannot reach — the apron and the
    // backdrop — take the same darkening through their own shader. See
    // `HAZE.day`, which is the whole of why they are not the two brightest
    // things in a night shot.
    HAZE.day.value.copy(this.lights.outdoor);
    // The SKY half is what the look turns down, and the spill is added after
    // it: `spill` is the shop's own lamps folded into one number, which is
    // authored content and the one thing in this sum the style has no business
    // dimming — a banded look that quietly darkened every lamp in the catalogue
    // would read as the night shift being broken.
    //
    // ...and under the look the SUM has a ceiling, which is the half that was
    // missing. `spill` is real light and reaches 0.29 in a mature shop, so
    // added raw onto a fill tuned to 0.62 it is a 57% overshoot: the fill ends
    // up level with the sun, every face lands in the same step, and the ramp
    // has nothing left to band. What that looks like is a flat, washed-out shop
    // — which reads as the toon shading not working rather than as the fill
    // being too high, because the bands are all there and all the same.
    //
    // A ceiling rather than a smaller spill, because what spill is FOR still
    // has to happen: a dark shop full of lamps is lifted toward a lit one, it
    // simply cannot be lifted past one. At noon there is nothing to lift.
    //
    // ...and the fill is held at midday with the other two now, so under the
    // look the ceiling is the base and `spill` has nowhere left to go. That is
    // deliberate and it is not a lamp being deleted: every one of those fittings
    // is still in the bake at full strength, and what `spill` was buying — a
    // dark room lifted toward a lit one — is what the roof does for nothing.
    // Off the look it still lifts, exactly as it did.
    this.ambient.intensity = look
      ? Math.min(fillTop + this.lights.spill, fillTop)
      : fillTop + this.lights.spill;
    this.ambient.color.copy(FILL_HIGH);

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
    // most of the read. The two-pixel gradient is re-painted at state cadence,
    // never in the draw loop.
    this.updateSky(daylight);
    // ...and the windows on the horizon, which come on with the shop's lamps.
    this.lightSurround(daylight);
  }

  /**
   * Every map `syncActors` fills — the three kinds of body in the shop.
   *
   * One spelling, because anything hung on a body by `syncActors` is hung on all
   * three of them and a sweep that names one of the maps is a sweep that works
   * on hires and silently skips the shoppers. `fadeBubbles` was exactly that.
   */
  actorMaps() {
    return [this.players, this.customers, this.animals];
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
        this.dropCrowd(rec);
        map.delete(a.id);
        rec = null;
      }

      if (!rec) {
        const obj = factory(a);
        rec = {
          obj, key, bubble: null, bubbleKey: null, carry: null, carryKey: null,
          // The `xN` welded into the armful, when there is one — see `syncCarry`.
          carryTag: null,
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
          // Present only on the shared shopper/player body. Authored robots and
          // animals stay untouched, so a walk animation is two pivot writes per
          // generic character rather than a traversal across every actor.
          walker: obj.userData.walker ?? null,
          gait: 0,
          gaitAmount: 0,
          // Where the arms are, and where the hands say they should be. Eased
          // between at frame rate — see the bottom of the loop below.
          armPose: 0,
          armLift: 0,
          armDamp: 1,
          kitHand: null,
          // What their arms are SAYING, which is the one thing about a body
          // that runs on a clock of its own — see render/emote.js. `emoteSeen`
          // is the stamp the pose currently up was started from, and it is the
          // whole of how a second wave is told from the first one still being
          // up: two waves running are the same string.
          emote: null,
          emoteAt: 0,
          emoteSeen: null,
          // How far this body is currently drawn from where the shop says it
          // is, so that a crowd reads as a crowd — see `CROWD_NUDGE`. Stripped
          // before the chase and added back after it, which is what keeps the
          // chase arithmetic reading the shop's answer rather than its own.
          ox: 0,
          oz: 0,
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
      /**
       * Which way the shop says they are pointing — a TARGET, the way the
       * position two lines up is, and for the same reason said about the other
       * half of a body.
       *
       * `facing` is `atan2` of a direction, and the directions a person is ever
       * handed are not continuous. A key sends one of eight, so steering W then
       * D snaps a body 90° between two frames; `followPath` walks tile to tile,
       * so every corner of every route is a quarter turn taken instantly. What
       * that reads as is a model being swapped for a different model rather than
       * a person turning round, and it is the half of "chunky" a smooth position
       * cannot hide — you are watching the thing you are steering.
       *
       * `rec.yaw` stays what it always was, which is what `animateRest` and
       * `animateEmote` need: both blend off it to say "what they would otherwise
       * be facing", and both are per-frame passes, so handing them a heading
       * that only moved when a packet landed was the same stutter one layer up.
       * It is the DRAWN answer now rather than the shop's, which is strictly
       * what those two were after.
       *
       * A body seen for the first time takes the target whole. There is no turn
       * to draw for somebody who was not on screen a frame ago, and easing from
       * a default of zero would spin every shopper as they walked in.
       */
      rec.tyaw = a.facing ?? 0;
      if (rec.yaw === undefined) {
        rec.yaw = rec.tyaw;
        rec.obj.rotation.y = rec.yaw;
      }

      // Stashed rather than applied: how cross someone looks is animated at
      // 60fps in `animateMoods`, and a shake that only moved when state landed
      // would read as the renderer stuttering. Null for anyone who isn't a
      // shopper — staff and players have no patience to lose.
      rec.anger = a.anger ?? null;
      // ...and the other end of the same scale, for the same reason. `anger` is
      // a function of `mood` that bottoms out at zero the moment somebody is
      // merely content, so it can say how cross a shopper is and cannot say
      // that one is delighted — which is the half `animateFace` needs and the
      // flush never did. Null for anybody with no patience to spend.
      rec.mood = a.mood ?? null;

      // ...and the same stashing again for an emote, with one difference that
      // is the whole of it: it is taken on a NEW STAMP rather than on every
      // frame the shop mentions one. The pose runs on the client's own clock
      // (`animateEmote`) and clears itself when it is spent, so re-taking it
      // from a snapshot that is still carrying the same wave would put the arm
      // straight back up. And the shop's expiry is not the client's — a frame
      // of network is enough to cut the tail off — so the field going away is
      // deliberately NOT what ends it.
      if (a.emote && a.emoteAt !== rec.emoteSeen) {
        rec.emote = a.emote;
        rec.emoteAt = a.emoteAt;
        // Who they are answering, if anybody. Null is an emote somebody made
        // themselves, which is aimed wherever they were already facing.
        rec.emoteTo = a.emoteTo ?? null;
      }

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

      // ...and what the ARMS are doing about all three, which is decided here
      // rather than in any of the syncs because it is a fact about the person
      // and each of those knows only its own third of them. A crate outranks an
      // armful (you cannot be holding both, but the record can be mid-swap on
      // one snapshot), and a bag on one hand asks for nothing but a quieter
      // swing on the arm it rides.
      //
      // Stashed, never applied: the pose is eased in `animateActors` at frame
      // rate. Written here it would snap on the tick somebody picked something
      // up, which is a limb teleporting.
      rec.armLift = rec.haul ? ARM_LIFT_HAUL : (rec.carry ? ARM_LIFT_CARRY : 0);
      rec.armDamp = rec.armLift ? ARM_HELD : (rec.kitHand ? ARM_ONE_HANDED : 1);
    }
    for (const [id, rec] of map) {
      if (!seen.has(id)) {
        this.actorRoot.remove(rec.obj);
        this.dropFoot(rec);
        this.dropCrowd(rec);
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
  /**
   * One of the built-in bodies, drawn out of the crowd batch.
   *
   * Every generic character in the shop comes through here — the shoppers, you,
   * and any hire whose kind has no authored model. An AUTHORED robot does not:
   * `buildModel` draws arbitrary art with its own skins and tier stages, which
   * is not a pile of unit boxes and cannot be instanced. There are a dozen of
   * those and eighty of these, so the split falls where the cost is.
   *
   * The fallback is the whole mesh body, unchanged. A batch that is full hands
   * back null and the eighty-first shopper is drawn the old way — a frame
   * slower, and correct, which is the right way round for a cap. It is also
   * what makes `CROWD_CAP` a tuning number rather than a limit on the game.
   */
  crowdBody(color, opts) {
    const desc = characterParts(color, opts);
    const slots = this.crowd.claim(desc.parts);
    if (!slots) return buildCharacter(color, opts);
    const g = crowdRig(desc);
    g.userData.crowd = {
      desc, slots, locals: crowdLocals(desc), extent: crowdExtent(desc),
    };
    // The colours are fixed for the life of the body and written once. The head
    // is the one exception — `animateMoods` flushes it as somebody gets cross —
    // and it is written through the same call, so there is no second path.
    desc.parts.forEach((p, i) => {
      this.crowd.setColour(p.shadow ? 'cast' : 'flat', slots[i], CROWD_COL.set(p.colour));
    });
    return g;
  }

  /** Give a batched body's slots back. Paired with `dropFoot` at both teardowns. */
  dropCrowd(rec) {
    const c = rec?.obj?.userData?.crowd;
    if (!c) return;
    this.crowd.giveBack(c.desc.parts, c.slots);
    rec.obj.userData.crowd = null;
  }

  buildActor(p) {
    const kind = p.staff ? this.catalog.workers?.[p.staff] : null;
    if (!kind?.model) return this.crowdBody(p.color, { hat: '#ffffff', variant: p.id });
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
    /**
     * A MOUTH'S CARRIER IS ON THE CELL CENTRE, which is what deletes the four
     * blends that used to live here.
     *
     * `UNDER_PISTON_X` was 0.2 — the well was drawn inset toward the incoming
     * rail — so the crate had to be inset to match, on arrival, on departure
     * and on both vertical strokes, each with its own remap of the last
     * segment. Every one of those was compensation for the same offset, and
     * the offset itself is a bug the moment a mouth becomes a lift: the run
     * overhead is on the cell centre, so a box rising out of a mouth inset by
     * 0.2 climbs into the duct a fifth of a tile off the line and slides back
     * onto it. Which reads as the crate drifting.
     *
     * The well is centred now, so the simulation's own position IS the
     * carrier's, on every leg, and there is nothing left to blend.
     */
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
      // ...and neither is the box a PACKER is building, for exactly the same
      // reason wearing a different flag: it is off the line but it is INSIDE a
      // machine, waist-high, with whatever is riding past drawn across it. Filed
      // into the tower on its square it would be drawn on the floor under the
      // conveyor, which reads as a box that fell out of the run.
      if (d.belt || d.packer) continue;
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
      // Buried. Not `seen`, so whatever mesh it had is disposed on the way
      // out and rebuilt at the far mouth — a box between two ends is nowhere at
      // all, and leaving it drawn parks it on the entry ramp for the length of
      // the span and then teleports it.
      // Buried, and ONLY buried.
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
      const key = `${piles.map((s) => `${s.item_id}:${s.qty}`).join(',')}/${cap}:${at}:${covered ? 'c' : 'o'}${d.waste ? ':w' : ''}${d.belt || d.packer ? ':b' : ''}`;
      const existing = this.deliveryProps.get(d.id);
      const drawn = d;
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
        existing.position.set(drawn.x, crateY(d, at), drawn.z);
        // Where it belongs with nothing happening to it. A swing offsets the
        // mesh between snapshots (see `animateStations`), so the position it
        // offsets FROM has to be the one the shop last said rather than wherever
        // the last frame left it — otherwise every swing walks the crate a
        // little further down the spur and it drifts off the end.
        existing.userData.homeX = drawn.x;
        existing.userData.homeZ = drawn.z;
        existing.userData.beltId = d.belt ?? null;
        continue;
      }
      if (existing) {
        this.actorRoot.remove(existing);
        disposeGroup(existing);
      }
      const obj = buildPallet(piles, {
        covered, cap, waste: d.waste === true, label: !d.belt && !d.packer,
      });
      // Sat on the deck of the belt rather than on the floor. `at` is 0 for
      // anything belted (it is in no pile), so this is the belt's own height and
      // never an offset into a tower.
      obj.position.set(drawn.x, crateY(d, at), drawn.z);
      obj.userData.homeX = drawn.x;
      obj.userData.homeZ = drawn.z;
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
      if (d.belt || d.packer) obj.scale.setScalar(BELT_CRATE);
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
  /**
   * Re-aim the camera at where the body it rides is actually DRAWN.
   *
   * `syncState` sets `camTarget` off the snapshot, which is the shop's answer
   * and arrives ten times a second. The body is not drawn there — `ACTOR_CHASE`
   * eases it every frame — so the camera was chasing a staircase while the thing
   * it is pointed at slid smoothly underneath it. A lerp toward a target that
   * steps 0.42 of a tile every hundred milliseconds does not smooth the step
   * away, it *rings*: the view lurches on the frame a packet lands and coasts
   * until the next one. And because this is the camera, that ripple is not on
   * one body — it is the entire screen, ten times a second, for as long as you
   * hold a key. Which is what "chunky" is: nothing in the shop is stuttering,
   * the window onto it is.
   *
   * So the target is taken from the mesh, once a frame, after `animateActors`
   * has moved it. Nothing about the shop's answer is discarded — the drawn
   * position is chasing exactly that — this is only the difference between
   * pointing the camera at the news and pointing it at the picture.
   *
   * `ox`/`oz` come off first, for the reason `animateActors` takes them off
   * before easing: the crowd nudge is a look, and a camera that inherited it
   * would pan the whole shop sideways because somebody walked up to you.
   *
   * The free-roam absorption is `syncState`'s, said again and for the same
   * reason: `camPan` is an offset off this target, so moving the target without
   * absorbing the delta drags a parked view along behind whoever it was chained
   * to.
   */
  trackEye() {
    if (!this._eyeId) return;
    const rec = this.players.get(this._eyeId) ?? this.customers.get(this._eyeId);
    if (!rec?.obj || rec.tx === undefined) return;
    const x = rec.obj.position.x - rec.ox;
    const z = rec.obj.position.z - rec.oz;
    if (this.freeRoam) {
      this.camPan.x += this.camTarget.x - x;
      this.camPan.z += this.camTarget.z - z;
    }
    this.camTarget.set(x, EYE_Y, z);
    if (this.freeRoam) this.clampPan();
  }

  animateActors(dt, snap = false) {
    const move = snap ? 1 : 1 - Math.exp(-dt * ACTOR_CHASE);
    // The same, for the heading — see `ACTOR_TURN`. `snap` takes it whole for
    // the reason the position does: a tab that was not being drawn owes nobody
    // the turn they took while it was away.
    const turn = snap ? 1 : 1 - Math.exp(-dt * ACTOR_TURN);
    let slip = 0;
    // Reused rather than rebuilt, the way `EDGE_V` is: this runs every frame
    // over every body in the shop, and the list is the input to both the
    // bucketing and the second pass below.
    const live = this.crowdList ??= [];
    live.length = 0;
    for (const map of [this.players, this.customers, this.animals]) {
      for (const rec of map.values()) {
        if (rec?.tx === undefined) continue;
        live.push(rec);
        // Last frame's nudge comes off first, so what the chase eases is the
        // position the SHOP put them at. Chasing the drawn position instead
        // would have the offset compound into the thing it is measured from.
        const ax = rec.obj.position.x - rec.ox;
        const az = rec.obj.position.z - rec.oz;
        const dx = (rec.tx - ax) * move;
        const dz = (rec.tz - az) * move;
        rec.obj.position.x = ax + dx;
        rec.obj.position.z = az + dz;
        // The short way round (`turnTo`), which is what stops somebody who
        // reversed from unwinding 180° the long way about — a full spin on the
        // spot, at one heading only, which is the kind of thing you see once and
        // cannot reproduce. Written to the mesh here and re-derived from
        // `rec.yaw` by `animateRest` and `animateEmote` below, so a body on a
        // break or mid-wave still blends off the drawn heading rather than
        // fighting this for the same field.
        if (rec.tyaw !== undefined && rec.yaw !== rec.tyaw) {
          rec.yaw += turnTo(rec.yaw, rec.tyaw) * turn;
          rec.obj.rotation.y = rec.yaw;
        }
        if (rec.walker) {
          // `dx`/`dz` are the body movement we actually drew this frame, not a
          // snapshot guess. That keeps the feet planted when the body has
          // reached its target and gives the same cadence at every frame rate.
          const speed = snap ? 0 : Math.hypot(dx, dz) / Math.max(dt, 1e-3);
          const target = Math.min(1, speed / 1.35);
          rec.gaitAmount += (target - rec.gaitAmount) * Math.min(1, dt * 14);
          rec.gait += dt * (3 + rec.gaitAmount * 8);
          const swing = Math.sin(rec.gait + rec.phase) * 0.48 * rec.gaitAmount;
          rec.walker.left.rotation.x = swing;
          rec.walker.right.rotation.x = -swing;
          // Arms counter-swing the legs. Kept on the same two-pivot rig so the
          // whole gait remains four scalar writes per generic character.
          //
          // ...damped and lifted by whatever is in the hands. Negative is
          // FORWARD: the pivot is at the shoulder and the arm hangs down its
          // own -y, so a positive turn about +x carries the hand backward.
          // Eased rather than set, so picking something up is a limb moving
          // rather than a limb somewhere else on the next frame.
          rec.armPose += ((rec.armLift ?? 0) - rec.armPose) * Math.min(1, dt * 9);
          const damp = rec.armDamp ?? 1;
          rec.walker.leftArm.rotation.x = -swing * 0.72 * damp - rec.armPose;
          rec.walker.rightArm.rotation.x = swing * 0.72 * damp - rec.armPose;
        }
        // The furthest anybody went, not the sum: a shadow map is one map, and
        // it is redrawn for the one body that outran it. Adding them up would
        // put a busy shop over the line with nobody having moved a pixel.
        slip = Math.max(slip, Math.abs(dx), Math.abs(dz));
      }
    }
    // The nudge goes on afterwards, off the positions the chase has just
    // settled on — which is also where `foot` gets set, since a ring drawn
    // under where somebody would have stood is a ring beside their feet.
    // Accumulated rather than compared, because the frames this is asked about
    // are the ones where the map was NOT redrawn — a body creeping a fifth of a
    // texel a frame is still a body a texel out of place five frames later.
    this.shadowSlip += Math.max(slip, this.separateActors(live, dt, snap));
  }

  /**
   * Hold drawn bodies out of one another, and put each one's floor mark under
   * its feet.
   *
   * The argument for doing this at all, and for doing it here rather than in the
   * sim, is `CROWD_NUDGE`. What is left is how it is made cheap and how it is
   * kept from drawing anybody somewhere they could not stand.
   *
   * Bucketed by tile, because the alternative is every body against every other
   * one and a busy evening is eighty of them — six thousand pairs a frame to
   * find the dozen that are actually touching. The buckets are kept between
   * frames and emptied rather than dropped, so a steady shop allocates nothing:
   * there are only ever as many of them as there are tiles with somebody on.
   *
   * Two bodies at *exactly* the same point have no direction to be pushed
   * apart along, and the tempting fix — a random axis — is the one thing that
   * cannot be used, because it is redrawn sixty times a second and what it reads
   * as is two people vibrating. `phase` is already on the record, already
   * hashed off the id, and already there for this class of problem (it is what
   * stops two hires breathing in time), so the pair separates along a heading
   * that is the same every frame and different per person.
   *
   * And the nudge may not put anybody through a wall. A shove that stays on the
   * body's own tile is always allowed — it cannot leave a square it is already
   * standing in — and one that crosses into a neighbouring tile has to land on
   * ground somebody could walk on, or it is dropped and they simply overlap for
   * as long as they are stood in a doorway. Overlapping for a moment is the
   * failure this whole pass exists to reduce; a shopper drawn inside a freezer
   * is a worse one, and at a fifth of a tile the two cases are told apart by one
   * lookup on the tiles the body is not already on.
   *
   * @returns {number} the furthest any body was moved by the nudge, for the
   *   shadow map — a slide sideways moves a shadow exactly as a walk does.
   */
  separateActors(live, dt, snap) {
    const cells = this.crowdCells ??= new Map();
    for (const bucket of cells.values()) bucket.length = 0;

    const L = this.storeLayout;
    const key = (x, z) => (Math.round(z) + 1) * 4096 + Math.round(x) + 1;
    for (const rec of live) {
      const k = key(rec.obj.position.x, rec.obj.position.z);
      const bucket = cells.get(k);
      if (bucket) bucket.push(rec);
      else cells.set(k, [rec]);
    }

    const ease = snap ? 1 : Math.min(1, dt * CROWD_EASE);
    let slip = 0;
    for (const rec of live) {
      const ax = rec.obj.position.x;
      const az = rec.obj.position.z;
      let px = 0;
      let pz = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = cells.get(key(ax + dx, az + dz));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === rec) continue;
            const want = rec.halfW + other.halfW;
            let ox = ax - other.obj.position.x;
            let oz = az - other.obj.position.z;
            let d = Math.hypot(ox, oz);
            if (d >= want) continue;
            if (d < 1e-4) {
              // Stood in exactly the same spot. See `phase` above.
              ox = Math.cos(rec.phase);
              oz = Math.sin(rec.phase);
              d = 1;
            }
            // Half of the overlap: the other body is in this same loop and
            // takes the other half, so a pair separates without either of them
            // having to know that.
            const push = (want - d) / 2;
            px += (ox / d) * push;
            pz += (oz / d) * push;
          }
        }
      }

      const mag = Math.hypot(px, pz);
      if (mag > CROWD_NUDGE) {
        px = (px / mag) * CROWD_NUDGE;
        pz = (pz / mag) * CROWD_NUDGE;
      }

      const wasX = rec.ox;
      const wasZ = rec.oz;
      let nx = rec.ox + (px - rec.ox) * ease;
      let nz = rec.oz + (pz - rec.oz) * ease;
      if (L) {
        const tx = Math.round(ax + nx);
        const tz = Math.round(az + nz);
        if ((tx !== Math.round(ax) || tz !== Math.round(az))
          && !isWalkableTile(L, tx, tz)) {
          nx = 0;
          nz = 0;
        }
      }
      rec.ox = nx;
      rec.oz = nz;
      rec.obj.position.x = ax + nx;
      rec.obj.position.z = az + nz;
      if (rec.foot) {
        rec.foot.position.x = rec.obj.position.x;
        rec.foot.position.z = rec.obj.position.z;
      }
      slip = Math.max(slip, Math.abs(nx - wasX), Math.abs(nz - wasZ));
    }
    return slip;
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
    // WITH THE MOUSE LOCKED THERE IS NO POINTER, SO EVERY AIM IS THE CENTRE.
    //
    // Pointer Lock keeps delivering `clientX`/`clientY` and they are FROZEN at
    // wherever the cursor stood when the lock was taken — so aiming would go on
    // working, silently, at a spot on the glass nobody can see and nobody
    // chose. What you would watch is a shop that hands you the wrong shelf and
    // never says why, with the highlight sitting obediently on it.
    //
    // It is answered here rather than at the forty-odd places a press names a
    // point, because this is the one function that turns a point into a ray:
    // the tap, the hold, the hover ring, the crate rummage and the way-through
    // marker all arrive through it, and a second copy of this decision is a
    // press that acts on one thing while the ring is drawn round another.
    if (this.crosshair) {
      clientX = rect.left + rect.width / 2;
      clientY = rect.top + rect.height / 2;
    }
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
   * The four ground-plane corners a screen rectangle covers — `fixturesInRect`'s
   * companion, for the half of a selection that is not a fixture.
   *
   * That one tests in SCREEN space, exactly, and is right to: a shelf is drawn
   * most of a tile up-screen of the ground it stands on, so a box tested against
   * tiles catches the row behind the one you dragged over. Ground has no such
   * freedom — a cell is where it is — so the honest question is which cells lie
   * under the box, and that is a question about the floor plane.
   *
   * Corners rather than cells, and unclamped: `quadCells` in `shared/build.js` is
   * what turns these into squares, on the server, which is the one place that
   * knows how big the world is. Eight numbers on the wire against a room's worth
   * of coordinates — `build-edge`'s rule said about an area.
   *
   * Always `y = 0`. The overhead deck has no ground on it to copy, and a region
   * read off the ceiling plane would be offset by four metres' worth of parallax
   * from the floor the boxes it names are actually on.
   */
  groundQuad(x0, y0, x1, y1) {
    if (!this.storeLayout) return null;
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
    // Round the box rather than across it, so the four points come back as a
    // ring: a quad handed its corners in Z order is a bow tie, and every
    // point-in-polygon test in the world says no to the middle of one.
    const corners = [[lo.x, lo.y], [hi.x, lo.y], [hi.x, hi.y], [lo.x, hi.y]];
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const out = [];
    for (const [cx, cy] of corners) {
      const ray = this.pointerRay(cx, cy);
      if (!ray?.ray.intersectPlane(plane, hit)) return null;
      out.push({ x: Math.round(hit.x * 100) / 100, z: Math.round(hit.z * 100) / 100 });
    }
    return out;
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
    // ...and HOW TALL it is comes off the boundary it is a face of, for exactly
    // the reason the thickness above already does — said in that comment and
    // then not done. It was 1.05, which matched no wall the game has ever built
    // and matched the one it was written against least of all once `WALL_H` grew:
    // a brush covering three fifths of what it paints reads as the tool only
    // reaching part way up, which is a bug report about the brush rather than
    // about a stale number. A face is the whole face.
    const L = this.storeLayout;
    const heightAt = (f) => {
      const kind = (f.o === 'v' ? L.edgesV?.[f.z * (L.w + 1) + f.x] : L.edgesH?.[f.z * L.w + f.x])
        ?? E.NONE;
      return (EDGE_STYLE[kind] ?? EDGE_STYLE[E.WALL]).h;
    };
    for (const f of faces) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.55));
      const off = f.s * (t / 2 + 0.03);
      const h = heightAt(f);
      if (f.o === 'v') {
        mesh.position.set(f.x - 0.5 + off, h / 2, f.z);
        mesh.scale.set(0.05, h, 0.96);
      } else {
        mesh.position.set(f.x, h / 2, f.z - 0.5 + off);
        mesh.scale.set(0.96, h, 0.05);
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
  fixtureAt(x, z, deck = null) {
    return this.allFixtures().find((f) => covers(f, x, z)
      // ...ON A STOREY, when the caller knows which one it means.
      //
      // A tile answered one fixture until a decoration stopped stamping one,
      // and it answered one PLACE until a duct could hang over a shelf. The
      // second is worse than the first, because both candidates are real
      // fixtures with real records and `find` simply takes whichever is listed
      // first. Null is "any", which is every caller that means a tile — the
      // ghost, a move's landing square — and is what those have always got.
      && (deck == null || deckOf(f) === deck)) ?? null;
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
    const key = f ? `${f.id}:${mode}:${f.y ?? 0}:${board ?? ''}:${art}:${this.reflows}` : null;
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
    const key = f && board ? `${f.id}:${board}:${art}:${this.reflows}` : null;
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
   * A unit takes the CONTOUR, and that used to be a frame on its tile. The
   * frame's problem was never the shelf, it was that the frame is a proxy: you
   * point at a shelf to walk to the side of it, so the tile is a true thing to
   * say and it is not the thing you asked. It survived on the strength of
   * looking like a mark — and the cel ink retired that, because every object in
   * the shop now carries a hard contour and the one flat unlit quad in the
   * frame reads as a UI layer that fell into the picture. See `buildContour`.
   *
   * That folds in the decoration, which needed its own answer before and does
   * not now. A prop owns no cell, so a frame under one marked the floor beside
   * it; a hanging one is drawn most of a tile up-screen of its own cell, so the
   * mark appeared somewhere you were demonstrably not pointing. Both are the
   * same complaint — the marker was not on the object — and one marker that IS
   * the object answers them together, which is why `propBoxes` is no longer
   * asked here. It is still what the pointer is tested against, and the two
   * cannot drift apart now for a better reason than agreeing: the highlight is
   * made of the meshes the ray hit.
   *
   * A board takes the cage for a third reason, and it is the one that makes
   * board-level aiming legible at all: a frame on the tile would be the same
   * frame for every pile on the unit, so pointing at the bread and pointing at
   * the milk beside it would look identical. The thing you have to be able to
   * tell apart is *which pile*, so the marker has to be round the pile.
   */
  /**
   * Is anything in the shop pointed at or open — the contour pass's own switch.
   *
   * Asked once a frame and answered off the four holders rather than by walking
   * the scene, which is the whole point: the mask pass is a full traversal of
   * the tree for a texture nothing wrote to unless there is something to write.
   * Most frames there is not, because nothing is marked until the pointer is
   * over something.
   *
   * `userData.mark` and not "is there a marker" — a frame marker is drawn in the
   * ordinary pass and has nothing to do with this, so a `kin` set of seventeen
   * frames must not switch the pass on. See `buildContour`.
   */
  marksOn() {
    if (this.aimMarker?.userData.mark
      || this.selectedMarker?.userData.mark
      || this.pickedMarker?.userData.mark) return true;
    for (const rec of this.markSets.values()) if (rec.group.userData.mark) return true;
    return false;
  }

  /**
   * Run `fn` with this group standing where it BELONGS rather than where it is
   * being drawn this frame.
   *
   * `land` drops a newly-placed fixture into its tile over `LAND_MS`, raised
   * and squashed on the way, and `buildContour` bakes whatever matrix it finds
   * into a fixed one. So an outline cut during those few hundred milliseconds
   * is cut round the pose mid-drop and then STAYS there — the shelf finishes
   * falling and the teal outline does not follow, because nothing in the
   * marker's key has changed. What you see is a contour hanging half a tile
   * above the thing it belongs to, for the rest of the session, on the one
   * fixture you just put down.
   *
   * Which is why this is here and not a `landings` check in `markerFor`: the
   * marker is not wrong to be built now, it is wrong to be built from a
   * *transient* pose. `land` already records where the thing belongs (`r.y`,
   * captured before the animation touches it), so there is a right answer to
   * hand over — and the frame after this the animator carries on from where it
   * was, none the wiser.
   */
  atRest(group, fn) {
    const land = group ? this.landings.find((r) => r.g === group) : null;
    if (!land) return fn();
    const y = group.position.y;
    const scale = group.scale.clone();
    group.position.y = land.y;
    group.scale.set(1, 1, 1);
    try {
      return fn();
    } finally {
      group.position.y = y;
      group.scale.copy(scale);
      group.updateMatrixWorld(true);
    }
  }

  markerFor(f, mode, board = null) {
    const box = board ? this.boardBox(f, board) : null;
    if (!box) {
      // The object's own outline, which is the answer for a shelf and a lamp
      // alike — see `buildContour`. It comes back null for a look with no
      // `hull` (`kin`, which appears seventeen at a time) and for a fixture
      // whose art has not been built yet, and both of those keep the frame.
      const at = new THREE.Vector3(f.x, f.y ?? this.fixtureBaseY(f), f.z);
      // A Set of the MESHES, which is `collectEdges`' own spelling one call
      // along: the record is `{mesh, ...}` and testing the record against an
      // object is a skip that never fires, so the hull would quietly include
      // every blade in the shop and only show it on a machine mid-batch.
      const spin = this.movingFixtures.get(f.id)?.moving;
      const skip = spin?.length ? new Set(spin.map((m) => m.mesh)) : null;
      // ...taken at REST, or a fixture you have just put down is outlined
      // where the drop animation had it. See `atRest`.
      const art = this.fixtureProps.get(f.id);
      const hull = this.atRest(art, () => buildContour(art, at, mode,
        skip ? (o) => skip.has(o) : null));
      if (hull) {
        hull.position.copy(at);
        return hull;
      }
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
    //
    // ...and so is `reflows`, which is the ART's own generation rather than
    // anything about the fixture. A contour is BUILT OUT OF the fixture's
    // meshes (see `buildContour`), and a re-flow disposes every one of them and
    // builds new ones — so a marker held across one is drawing buffers that
    // have been freed, at wherever the shelf used to stand. Every key in here
    // describes the layout RECORD, and the record is the one thing a re-flow
    // can leave identical: buy a shelf across the shop and the unit you have
    // open has not changed by a single field. What you see is the outline
    // stranded a few tiles away from the thing it belongs to.
    const key = f
      ? `${f.x},${f.z},${f.rot ?? 0}|${at.map((s) => `${s.x},${s.z}`).join(';')}|${this.reflows}`
      : null;
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
    // `reflows` for `setSelectedTarget`'s reason: a contour is made of the
    // fixture's own meshes, and a re-flow replaces every one of them while
    // leaving the records these keys are built from untouched.
    const key = `${this.reflows}/` + items.map((m) => `${m.f.id}@${m.f.x},${m.f.z},${m.f.rot ?? 0}:${m.mode}`
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
      // Carried up to the set, because `marksOn` asks the group rather than
      // walking into it — see `buildContour`.
      if (marker.userData.mark) group.userData.mark = true;
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
      // Match a plain belt's rendered deck to the end caps in `conveyorBody`.
      // Carriers are separate instanced geometry, so clipping the body alone
      // leaves the final chevron visibly running through a red/yellow marker.
      const beltCap = c.kind === 'belt' && !path.corner;
      const forward = conveyorNext(L, c);
      const handsOn = forward && conveyorAt(L, forward.x, forward.z, deckOf(forward));
      const fedFromBack = path.feeds.some((f) => f.x === path.out.x && f.z === path.out.z);
      const below = deckOf(c) === CEILING ? conveyorAt(L, c.x, c.z, 0) : null;
      const shaftMouth = this.machineElevatorAt(L, c) ?? (below?.kind === 'lift' ? below : null);
      const liftRoof = below?.kind === 'lift';
      // The BED reaches the marker's outer edge; carriers begin after a yellow
      // head and stop before a red tail. Both bounds come from the marker's own
      // size/offset below, so those three pieces cannot drift apart again.
      let slatLo = fedFromBack ? -0.5 : -END_PIP_INNER;
      let slatHi = handsOn ? 0.5 : END_PIP_INNER;
      // A loader/sorter below a terminal duct is the elevator mouth. The
      // carriers stop at its near edge instead of being painted across the
      // opening the box rises through.
      if (shaftMouth && handsOn) slatLo = DUCT_HALF;
      else if (shaftMouth && fedFromBack) slatHi = -DUCT_HALF;
      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      rec.conveyor = true;

      // The gap between slats, which is what a scroll wraps on. Measured off the
      // authored spacing rather than assumed, or a tier that packs them closer
      // would scroll a slat straight through its neighbour.
      const xs = parts.map((p) => p.pos?.[0] ?? 0).sort((a, b) => a - b);
      const span = xs.length > 1 ? Math.abs(xs[1] - xs[0]) : 0.26;

      for (const p of parts) {
        if (liftRoof) continue;
        const along = p.pos?.[0] ?? 0;
        const y = p.pos?.[1] ?? 0.115;
        const thin = p.scale?.[0] ?? 0.07;
        const high = p.scale?.[1] ?? 0.03;
        const long = p.scale?.[2] ?? 0.56;
        const alongSize = Math.max(thin, Math.min(long * 1.15, (span || 0.25) * 0.62));
        if (beltCap && (along - alongSize / 2 < slatLo || along + alongSize / 2 > slatHi)) continue;
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
    // second spelling of it would cut the wrong end of a tunnel mouth. An entry
    // opens against the flow to receive its rail; an exit opens with it.
    const flowRot = derivedFlow(f.kind) ? this.conveyorFacing(L, f)
      : (f.kind === 'under'
        ? (tunnelExit(L, f) ? rot4((f.rot ?? 0) + 2) : (f.rot ?? 0))
        : (f.rot ?? 0));
    const back = path ? anchorTile(f.x, f.z, rot4(flowRot + 2)) : null;
    const fedFromBack = back
      ? path.feeds.some((v) => v.x === Math.sign(f.x - back.x)
        && v.z === Math.sign(f.z - back.z))
      : true;
    // A terminal belt ends at the duct wall, not at the far edge of its tile.
    // The red/yellow end markers sit on that wall; leaving the authored deck at
    // a full tile drew one last chevron through the marker and out into the cap.
    const ahead = path ? anchorTile(f.x, f.z, flowRot) : null;
    const handsOn = ahead && conveyorAt(L, ahead.x, ahead.z, deckOf(f));
    /**
     * ...and whether a MOUTH has a surface rail at all, which is a fact about
     * what crosses that side rather than about it being a mouth.
     *
     * Model `+x` is the rail for both ends of a pair, and `trimDeck` kept a stub
     * of it unconditionally — right for every mouth that surfaces on the floor,
     * and wrong for a riser, whose only way out is straight up. What that draws
     * is a length of track running out of the machine toward a neighbour nothing
     * ever hands to, which reads as an outlet on a node that has not got one.
     *
     * `conveyorNext` and `feeds`, never `conveyorAt` — ADJACENCY IS NOT
     * CONNECTION, and on the save this was found on the square that stub pointed
     * at held a lift, so the adjacency test says yes and means nothing. Both
     * directions, because an entry's rail is the side it is FED across and an
     * exit's is the side it hands on to, and `flowRot` has already turned the
     * art so that either one is `+x`.
     */
    const railTo = path ? conveyorNext(L, f) : null;
    const railOut = !!(ahead && railTo && railTo.x === ahead.x && railTo.z === ahead.z
      && deckOf(railTo) === deckOf(f));
    const railIn = !!(ahead && path.feeds.some((v) => v.x === Math.sign(f.x - ahead.x)
      && v.z === Math.sign(f.z - ahead.z)));
    const below = deckOf(f) === CEILING ? conveyorAt(L, f.x, f.z, 0) : null;
    const shaftMouth = this.machineElevatorAt(L, f) ?? (below?.kind === 'lift' ? below : null);
    const liftRoof = below?.kind === 'lift';
    const machineShaft = L && deckOf(f) === 0 ? this.machineElevatorAbove(L, f) : null;
    const trimDeck = (p) => {
      // The deck is the part that spans the tile — the same test `conveyorDeck`
      // uses to find it, rather than an index into a list somebody may reorder.
      if (!path || (p.scale?.[0] ?? 0) < 0.99) return p;
      // Plain terminal belts stop at the OUTER edge of their red/yellow pip.
      // Do this before the bend/start-cell shortening below: chaining two
      // transforms made the first one shrink the part below the second one's
      // "full deck" test, so the terminal trim silently never ran.
      // A MOUTH IS A TERMINUS AND A HOLE, so its groove is a stub.
      //
      // The deck is authored a full tile because `conveyorDeck` finds it by
      // being one, and that measurement is taken off the model rather than off
      // this — so the marks the run derives are unaffected by trimming it here.
      // Untrimmed it is a rail laid straight through the shroud: out over the
      // far side of a cell the run does not continue past, and across the open
      // well, where it is a bar lying over the hole the crate drops down.
      //
      // Model `+x` is the rail side for both ends of a pair (`flowRot` turns
      // the exit through two), so one bound serves both: keep the piece from
      // the shroud's own outer face to the tile edge, and drop the rest.
      if (f.kind === 'under') {
        // No rail on that side, no rail. See `railOut`/`railIn`.
        if (!railOut && !railIn) return null;
        const pos = [...(p.pos ?? [0, 0, 0])];
        const scale = [...p.scale];
        scale[0] = 0.5 - UNDER_DECK_LIP;
        pos[0] = (pos[0] ?? 0) + (UNDER_DECK_LIP + 0.5) / 2;
        return { ...p, pos, scale };
      }
      if (f.kind === 'belt' && !path.corner) {
        let lo = fedFromBack ? -0.5 : -END_PIP_OUTER;
        let hi = handsOn ? 0.5 : END_PIP_OUTER;
        // A terminal ceiling belt over a loader/sorter ends at the elevator
        // opening, not across its centre. Which half survives follows the
        // horizontal leg: incoming track reaches the near lip; outgoing track
        // begins at the far lip.
        if (shaftMouth && handsOn) lo = DUCT_HALF;
        else if (shaftMouth && fedFromBack) hi = -DUCT_HALF;
        const pos = [...(p.pos ?? [0, 0, 0])];
        const scale = [...p.scale];
        scale[0] = hi - lo;
        pos[0] = (pos[0] ?? 0) + (lo + hi) / 2;
        return { ...p, pos, scale };
      }
      if (fedFromBack) return p;
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
    const strip = (parts) => {
      let body = (parts ?? []).filter((p) => !Scene.isSlat(p) && !Scene.isBack(p));
      // Lift art is wholly connection-derived below. Keeping even the authored
      // floor cross here draws a second rail through the pickup basket and
      // brings the old four-post tower back underneath the new assembly.
      if (f.kind === 'lift') body = [];
      if (machineShaft) {
        // An elevator-enabled loader/sorter needs a genuinely hollow upper
        // cabinet. Merely replacing its thin roof plate with a ring still left
        // the broad top face of the solid housing directly under the hole, so
        // the opening read as a black texture painted on the lid. Strip that
        // housing together with the cap and centred decoration; the elevator
        // pass rebuilds it as four walls around an open piston well.
        const roof = body.find((p) => (p.scale?.[0] ?? 0) >= 0.5
          && (p.scale?.[2] ?? 0) >= 0.5 && (p.scale?.[1] ?? 1) <= 0.08
          && (p.pos?.[1] ?? 0) > 0.25);
        if (roof) {
          const bottom = (roof.pos?.[1] ?? 0) - (roof.scale?.[1] ?? 0) / 2;
          const housing = body
            .filter((p) => Math.abs(p.pos?.[0] ?? 0) < 0.12
              && Math.abs(p.pos?.[2] ?? 0) < 0.12
              && (p.scale?.[0] ?? 0) >= 0.5 && (p.scale?.[2] ?? 0) >= 0.5
              && (p.scale?.[1] ?? 0) > 0.1)
            .sort((a, b) => Math.abs(((a.pos?.[1] ?? 0) + a.scale[1] / 2) - bottom)
              - Math.abs(((b.pos?.[1] ?? 0) + b.scale[1] / 2) - bottom))[0];
          body = body.filter((p) => {
            const centred = Math.abs(p.pos?.[0] ?? 0) < 0.12
              && Math.abs(p.pos?.[2] ?? 0) < 0.12;
            const partBottom = (p.pos?.[1] ?? 0) - (p.scale?.[1] ?? 0) / 2;
            return p !== housing && !(centred && partBottom >= bottom - 1e-4);
          });
        }
      }
      return body
      // A lift owns its roof cell. A belt placed at the same x/z is not a
      // second deck through the closed elevator head.
      .filter((p) => !(liftRoof && f.kind === 'belt' && (p.scale?.[0] ?? 0) >= 0.99))
      // The lift's authored top cross was a belt laid over the shaft opening:
      // crates rose visibly through it. The adjacent track already reaches the
      // opening edge, so the elevator itself needs no rail across its roof.
      .filter((p) => !(f.kind === 'lift' && (p.pos?.[1] ?? 0) > 1.8
        && (((p.scale?.[0] ?? 0) >= 0.99 && (p.scale?.[2] ?? 1) <= 0.3)
          || ((p.scale?.[2] ?? 0) >= 0.99 && (p.scale?.[0] ?? 1) <= 0.3))))
      // `trimDeck` answers null for a deck nothing crosses — see `railOut`.
      .map(trimDeck).filter(Boolean);
    };
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
   * The shaft under a tunnel mouth, and the carrier that rides it.
   *
   * The well is a real hole now — `buildWorld` cuts it out of the floor slab and
   * out of the apron underneath — so this lines it: four walls and a pan, which
   * is the whole of what turns a box sinking THROUGH the ground into a box going
   * down a shaft. Without them the crate was clipped by solid apron, which is a
   * picture of goods being destroyed rather than of goods going somewhere.
   *
   * The carrier itself is the lift's (`buildPiston`). A shaft and a mouth are
   * the same machine pointed opposite ways, and they were two pistons — a
   * sleeve-and-rod up the shaft, a single thin post down the well — which is the
   * two-spellings trap `mouthSink` already retired on the clock side, said about
   * the geometry.
   */
  attachTunnelPiston(L, mouth, prop) {
    const add = (mat, scale, position) => {
      const mesh = new THREE.Mesh(PATH_GEO, mat);
      mesh.scale.set(...scale);
      mesh.position.set(...position);
      mesh.raycast = NO_PICK;
      return mesh;
    };
    // The liner lines a HOLE, so it exists exactly where `buildWorld` cut one —
    // the same deck test, or a mouth that got to the ceiling wears a shaft with
    // no shaft in it. Its lip is the mouth's own ground, resolved exactly as the
    // tile loop resolves it: a run out to the yard is ordinary, and a well that
    // began at shop-floor height would stand a collar of nothing round a hole in
    // the grass.
    if (deckOf(mouth) === 0) {
      const indoor = L?.indoor?.[mouth.z * L.w + mouth.x];
      const lip = TILE_STYLE[indoor ? T.FLOOR : T.GRASS]?.h ?? 0;
      const bottom = UNDER_WELL_FLOOR - WELL_PAN_H;
      const wallH = lip - bottom;
      const wallY = (lip + bottom) / 2;
      const midWall = (WELL_SPAN + WELL_WALL) / 2;
      // Welded: the liner never moves, and five loose boxes per mouth is five
      // draw calls per mouth in a shop that builds tunnels by the dozen.
      const well = new THREE.Group();
      const wallMat = material(CONVEYOR.track, 1);
      for (const [dx, dz] of ELEVATOR_SIDES) {
        well.add(add(wallMat,
          [dx ? WELL_WALL : WELL_SPAN, wallH, dx ? WELL_HALF * 2 : WELL_WALL],
          [dx * midWall, wallY, dz * midWall]));
      }
      well.add(add(material(CONVEYOR.shadow, 1),
        [WELL_SPAN, WELL_PAN_H, WELL_SPAN],
        [0, UNDER_WELL_FLOOR - WELL_PAN_H / 2, 0]));
      prop.add(weld(well));
    }

    const piston = buildPiston((mat, scale, position) => {
      const mesh = add(mat, scale, position);
      prop.add(mesh);
      return mesh;
    }, material(CONVEYOR.frame, 1), material(CONVEYOR.rail, 1),
    UNDER_PISTON_X, 0, UNDER_WELL_FLOOR, UNDER_PISTON_HIGH);

    const rec = this.movingFixtures.get(mouth.id)
      ?? { moving: [], phase: (mouth.x * 0.31 + mouth.z * 0.17) % 1, signal: null };
    rec.conveyor = true;
    rec.tunnelPiston = { ...piston, at: null };
    this.movingFixtures.set(mouth.id, rec);
  }

  /** The floor machine that really hands into this ceiling cell, if any. */
  machineElevatorAt(L, ceiling) {
    if (deckOf(ceiling) !== CEILING) return null;
    const machine = conveyorAt(L, ceiling.x, ceiling.z, 0);
    if (!machine || !ELEVATOR_OWNERS.has(machine.kind)) return null;
    // Co-location is not a connection. The sim only chooses the vertical route
    // after the machine has exhausted its horizontal run, so this is also what
    // restricts elevators to the endcap loader/sorter instead of every machine
    // beneath a return duct.
    const ways = [conveyorNext(L, machine), ...conveyorBranches(L, machine)];
    return ways.some((n) => n && n.x === ceiling.x && n.z === ceiling.z
      && deckOf(n) === CEILING) ? machine : null;
  }

  /** The ceiling cell a floor machine really rises into, if any. */
  machineElevatorAbove(L, machine) {
    if (!machine || deckOf(machine) !== 0 || !ELEVATOR_OWNERS.has(machine.kind)) return null;
    const way = [conveyorNext(L, machine), ...conveyorBranches(L, machine)]
      .find((n) => n && n.x === machine.x && n.z === machine.z
        && deckOf(n) === CEILING);
    return way ? conveyorAt(L, way.x, way.z, CEILING) : null;
  }

  /** Authored dimensions/colours retained when a machine becomes a piston well. */
  machineElevatorRoof(machine) {
    const parts = partsAt(this.fixtureModel(machine), this.fixtureT(machine)) ?? [];
    const roof = parts.find((p) => (p.scale?.[0] ?? 0) >= 0.5
      && (p.scale?.[2] ?? 0) >= 0.5 && (p.scale?.[1] ?? 1) <= 0.08
      && (p.pos?.[1] ?? 0) > 0.25);
    if (!roof) return null;
    const roofBottom = (roof.pos?.[1] ?? 0) - (roof.scale?.[1] ?? 0) / 2;
    const housing = parts
      .filter((p) => Math.abs(p.pos?.[0] ?? 0) < 0.12
        && Math.abs(p.pos?.[2] ?? 0) < 0.12
        && (p.scale?.[0] ?? 0) >= 0.5 && (p.scale?.[2] ?? 0) >= 0.5
        && (p.scale?.[1] ?? 0) > 0.1)
      .sort((a, b) => Math.abs(((a.pos?.[1] ?? 0) + a.scale[1] / 2) - roofBottom)
        - Math.abs(((b.pos?.[1] ?? 0) + b.scale[1] / 2) - roofBottom))[0];
    const accents = parts.filter((p) => Math.abs(p.pos?.[0] ?? 0) < 0.12
      && Math.abs(p.pos?.[2] ?? 0) < 0.12
      && ((p.pos?.[1] ?? 0) - (p.scale?.[1] ?? 0) / 2) >= roofBottom - 1e-4
      && p !== roof);
    const accent = accents.sort((a, b) => (b.pos?.[1] ?? 0) - (a.pos?.[1] ?? 0))[0];
    return {
      y: roof.pos?.[1] ?? 0,
      h: roof.scale?.[1] ?? ELEVATOR_BOX_TOP_H,
      bodyY: housing?.pos?.[1] ?? 0,
      bodyH: housing?.scale?.[1] ?? ELEVATOR_BASKET_H,
      bodyX: housing?.scale?.[0] ?? ELEVATOR_BASKET_SPAN,
      bodyZ: housing?.scale?.[2] ?? ELEVATOR_BASKET_SPAN,
      bodyColor: housing?.color ?? CONVEYOR.frame,
      topColor: roof.color ?? CONVEYOR.rail,
      accentColor: accent?.color ?? roof.color ?? CONVEYOR.rail,
    };
  }

  /** The input/output faces of either a regular or machine-backed elevator. */
  elevatorConnections(L, ceiling, owner) {
    if (owner.kind === 'lift') return this.liftConnections(L, owner);
    const ports = { 0: new Set(), [CEILING]: new Set() };
    const inputs = [];
    const outputs = [];
    const collect = (cell) => {
      const deck = deckOf(cell);
      for (const way of [conveyorNext(L, cell), ...conveyorBranches(L, cell)]) {
        if (!way || deckOf(way) !== deck || (way.x === cell.x && way.z === cell.z)) continue;
        const dx = Math.sign(way.x - cell.x);
        const dz = Math.sign(way.z - cell.z);
        const side = `${dx},${dz}`;
        ports[deck].add(side);
        outputs.push({ cell: conveyorAt(L, way.x, way.z, deck), deck, dx, dz, side });
      }
      for (const feed of this.conveyorPath(L, cell).feeds) {
        const dx = -feed.x;
        const dz = -feed.z;
        const side = `${dx},${dz}`;
        ports[deck].add(side);
        inputs.push({ cell: conveyorAt(L, cell.x + dx, cell.z + dz, deck), deck, dx, dz, side });
      }
    };
    collect(owner);
    collect(ceiling);
    return { ports, inputs, outputs };
  }

  /**
   * Two glass baskets joined by one central hoist rail.
   *
   * This is intentionally procedural and shared by ordinary lifts and the
   * risers built into loaders/sorters. A basket is a fact about its live
   * connections; four permanent posts and a roof cannot express those.
   */
  addElevatorAssembly(L, ceiling, owner, geo, ductFloors, ductWalls) {
    const connections = this.elevatorConnections(L, ceiling, owner);
    const machineRoof = owner.kind === 'arm' || owner.kind === 'sorter'
      ? this.machineElevatorRoof(owner) : null;
    const id = owner.id;
    const tier = owner.tier ?? 1;
    const carrier = this.conveyorSlatParts({ kind: 'belt', tier })[0] ?? null;
    const railColor = carrier?.color ?? CONVEYOR.carrier;
    const glassMat = material(CONVEYOR.glass, GLASS);
    const frameMat = material(CONVEYOR.basket, 1);
    const railMat = material(railColor, 1);
    const machineBodyMat = machineRoof ? material(machineRoof.bodyColor, 1) : null;
    const machineTopMat = machineRoof ? material(machineRoof.topColor, 1) : null;
    const machineAccentMat = machineRoof ? material(machineRoof.accentColor, 1) : null;
    /**
     * The TRIM, which is not the carrier and was for as long as there were
     * lifts.
     *
     * A loader with a riser cut into it takes its accent off its own authored
     * hood (`machineAccentMat`), so it wears the family teal at its own rung —
     * and a plain lift, having no authored art that survives `strip`, fell
     * through to `railMat` and wore the belt's slate carrier instead. The two
     * stand next to each other in every run that has one, and what that reads
     * as is the lift's teal being a darker, duller version of the machine's.
     * It is not a darker teal; it is not a teal.
     *
     * The piston keeps `railMat`, and that is the line: a carrier colour is for
     * the thing that MOVES goods, which is what the platform is.
     *
     * ...and the BOTTOM RUNG keeps it too, which is the half that makes the
     * teal worth anything. An accent that is on from the day you build the
     * thing is decoration; one that arrives when you pay for the hoist is a
     * readout, and a shop with one upgraded lift in a row of standard ones can
     * be read from the door. So a stock lift is the pale carrier grey it always
     * was, and the family teal starts at rung 2 — where `conveyorAccent`'s own
     * second and third entries are, so it is still the same ladder the loader
     * beside it is climbing rather than a second one that happens to rhyme.
     */
    const accentMat = machineAccentMat
      ?? (tier > 1 ? material(conveyorAccent(tier), 1) : railMat);
    const connectionDeck = (connection) => (connection?.cell
      ? this.conveyorDeck(L, connection.cell) : null);
    const trackMat = (connection) => {
      const deck = connectionDeck(connection);
      return material(deck?.color ?? CONVEYOR.track, 1);
    };
    const addMesh = (mat, scale, position) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(...scale);
      mesh.position.set(...position);
      mesh.raycast = NO_PICK;
      this.beltRoot.add(mesh);
      return mesh;
    };

    const all = new Map([...connections.inputs, ...connections.outputs]
      .filter((c) => c.cell)
      .map((c) => [`${c.deck}:${c.side}`, c]));
    // Basket floors are part of the run, so measure their level from the real
    // connected track. `BELT_TOP` was a close visual constant, but the authored
    // belt centre is slightly lower and made every basket tongue sit proud.
    const levels = {};
    for (const deck of [0, CEILING]) {
      const connection = [...all.values()].find((c) => c.deck === deck);
      const actual = connectionDeck(connection);
      levels[deck] = {
        y: (deck === CEILING ? CEILING_Y : 0) + (actual?.y ?? BELT_TOP),
        h: actual?.h ?? ELEVATOR_TRACK_H,
      };
    }
    for (const deck of [0, CEILING]) {
      const base = levels[deck].y;
      const open = connections.ports[deck];
      /**
       * A MOUTH BRINGS ITS OWN HOUSING, the way it brings its own carrier.
       *
       * `under` is in `ELEVATOR_OWNERS`, so a riser mouth is handed this
       * assembly — and everything above the floor is exactly what a mouth is
       * already made of: posts, glazing and a capped square with a hole in it,
       * authored. Built here as well it is a second basket standing on the same
       * cell, at the same height, in a different colour, and the one you see is
       * whichever the depth buffer picked. What that reads as is the mouth
       * having been replaced by a plain dark box, with its own tier's accent
       * strips showing through the glass like rails inside a machine.
       *
       * An `arm` or a `sorter` is the case this loop is really for: their
       * housings are SOLID, so `machineRoof` opens one up. A mouth is open
       * already. So the floor half is skipped and the ceiling half — the duct
       * end, which a mouth genuinely has not got — is built as usual.
       */
      if (deck === 0 && owner.kind === 'under') continue;
      if (deck === 0 && machineRoof) {
        // Rebuild the authored solid upper body as a hollow cabinet. Its four
        // walls preserve the machine's silhouette and colour, while the absent
        // top face is what makes the lid's square a real view down the piston
        // well. Live floor connections get crate-sized doorways in those walls.
        const odd = this.conveyorFacing(L, owner) % 2;
        const spanX = odd ? machineRoof.bodyZ : machineRoof.bodyX;
        const spanZ = odd ? machineRoof.bodyX : machineRoof.bodyZ;
        const bodyBottom = machineRoof.bodyY - machineRoof.bodyH / 2;
        const wallH = machineRoof.bodyH;
        const wallY = bodyBottom + wallH / 2;
        const wallT = DUCT_PANE * 2;
        const headerH = Math.min(0.07, wallH * 0.24);
        for (const [dx, dz] of ELEVATOR_SIDES) {
          const side = `${dx},${dz}`;
          const tangent = dx ? spanZ : spanX;
          const face = dx ? spanX / 2 : spanZ / 2;
          const px = ceiling.x + dx * (face - wallT / 2);
          const pz = ceiling.z + dz * (face - wallT / 2);
          if (!open.has(side)) {
            addMesh(machineBodyMat,
              [dx ? wallT : tangent, wallH, dz ? wallT : tangent],
              [px, wallY, pz]);
            continue;
          }
          const jamb = Math.max(0.035, (tangent - ELEVATOR_OPENING) / 2);
          for (const sign of [-1, 1]) {
            addMesh(machineBodyMat,
              [dx ? wallT : jamb, wallH, dz ? wallT : jamb],
              [px + (dz ? sign * (ELEVATOR_OPENING + jamb) / 2 : 0), wallY,
                pz + (dx ? sign * (ELEVATOR_OPENING + jamb) / 2 : 0)]);
          }
          addMesh(machineBodyMat,
            [dx ? wallT : ELEVATOR_OPENING, headerH,
              dz ? wallT : ELEVATOR_OPENING],
            [px, machineRoof.y - machineRoof.h / 2 - headerH / 2, pz]);
        }
      }
      // The top has a glass RIM, not a plate. Its square centre is the hole the
      // carrier rises through; the four surrounding panes only bridge the gap
      // between that opening and the basket walls. The lower basket remains an
      // open pickup bay for the same reason.
      if (deck === CEILING) {
        // Match the ordinary duct floor exactly: same outside span and same
        // plane beneath the authored track. Using the basket wall centre-span
        // and the track centre here left a thin size/height seam that still
        // read as open air even though glass existed on both sides.
        const floorY = base - levels[deck].h / 2 - DUCT_PANE / 2;
        const floor = new THREE.Mesh(ELEVATOR_FLOOR_GEO, glassMat);
        floor.position.set(ceiling.x, floorY, ceiling.z);
        floor.raycast = NO_PICK;
        this.beltRoot.add(floor);
      }
      // A regular lift frames both pickup openings. A machine elevator already
      // has a floor conveyor inside its cabinet; its matching frame belongs on
      // the newly cut roof instead of being hidden underneath the machine.
      if (deck === CEILING || !machineRoof) {
        const border = new THREE.Mesh(ELEVATOR_OPENING_BORDER_GEO, accentMat);
        border.position.set(ceiling.x,
          base - levels[deck].h / 2 + ELEVATOR_OPENING_BORDER_H / 2,
          ceiling.z);
        border.raycast = NO_PICK;
        this.beltRoot.add(border);
      }
      if (deck === 0) {
        const lid = new THREE.Mesh(ELEVATOR_BOX_TOP_GEO, machineTopMat ?? frameMat);
        const lidY = machineRoof?.y
          ?? base + ELEVATOR_BASKET_H + ELEVATOR_BOX_TOP_H / 2;
        lid.position.set(ceiling.x, lidY, ceiling.z);
        lid.raycast = NO_PICK;
        this.beltRoot.add(lid);
        const bezel = new THREE.Mesh(ELEVATOR_LID_BEZEL_GEO, accentMat);
        bezel.position.set(ceiling.x,
          machineRoof
            ? machineRoof.y + machineRoof.h / 2 + ELEVATOR_LID_BEZEL_H / 2
            : base + ELEVATOR_BASKET_H + ELEVATOR_BOX_TOP_H
              + ELEVATOR_LID_BEZEL_H / 2,
          ceiling.z);
        bezel.raycast = NO_PICK;
        this.beltRoot.add(bezel);
      }
      for (const [dx, dz] of ELEVATOR_SIDES) {
        const side = `${dx},${dz}`;
        if (deck === 0) {
          // The authored loader/sorter cabinet is already the lower housing.
          // Only its cap was replaced above; adding the generic lift box here
          // would wrap a second cabinet around it.
          if (machineRoof) continue;
          // The floor end is a solid machine housing. Connected faces retain
          // their jambs and header around a real doorway instead of deleting
          // the whole wall; closed faces remain full panels.
          if (open.has(side)) {
            const panel = new THREE.Mesh(ELEVATOR_PORTAL_GEO, frameMat);
            panel.rotation.y = dx ? Math.PI / 2 : 0;
            panel.position.set(
              ceiling.x + dx * ELEVATOR_BASKET_HALF,
              base,
              ceiling.z + dz * ELEVATOR_BASKET_HALF,
            );
            panel.raycast = NO_PICK;
            this.beltRoot.add(panel);
            // A coloured lintel makes each live doorway readable at a glance,
            // in the same accent every machine in the family wears at this rung.
            addMesh(accentMat,
              [dx ? ELEVATOR_FACE_TRIM_D : ELEVATOR_OPENING,
                ELEVATOR_FACE_TRIM_H,
                dz ? ELEVATOR_FACE_TRIM_D : ELEVATOR_OPENING],
              [ceiling.x + dx * (ELEVATOR_BASKET_HALF + ELEVATOR_FACE_TRIM_D / 2),
                base + ELEVATOR_PORTAL_H + ELEVATOR_FACE_TRIM_H / 2,
                ceiling.z + dz * (ELEVATOR_BASKET_HALF + ELEVATOR_FACE_TRIM_D / 2)]);
          } else {
            /**
             * A closed face is a WINDOW: a pane with a sill, a header and two
             * jambs round it, rather than one slab of wall.
             *
             * It was a slab with a slightly darker rectangle standing 0.012
             * proud of it, which is a panel drawn ON a wall — at this camera the
             * step is a pixel, so what you saw was two dark greys on a black box
             * and no depth anywhere. Glass is the mouth's own answer to the same
             * face (its basket is glazed on three sides), and it earns its keep
             * twice: the two machines read as the same family, and the carrier
             * inside is visible standing at rail height, which is the only part
             * of a lift that ever moves.
             *
             * Four bands rather than a ring geometry because the face is not
             * square — the basket is wider than it is tall — so `squareRing`'s
             * one inner and one outer cannot describe it.
             */
            const jamb = (ELEVATOR_BASKET_SPAN - ELEVATOR_WINDOW_W) / 2;
            const rail = (ELEVATOR_BASKET_H - ELEVATOR_WINDOW_H) / 2;
            const wx = ceiling.x + dx * ELEVATOR_BASKET_HALF;
            const wz = ceiling.z + dz * ELEVATOR_BASKET_HALF;
            const mid = base + ELEVATOR_BASKET_H / 2;
            for (const s of [-1, 1]) {
              addMesh(frameMat,
                [dx ? DUCT_PANE : ELEVATOR_BASKET_SPAN, rail,
                  dz ? DUCT_PANE : ELEVATOR_BASKET_SPAN],
                [wx, mid + s * (ELEVATOR_WINDOW_H + rail) / 2, wz]);
              addMesh(frameMat,
                [dx ? DUCT_PANE : jamb, ELEVATOR_WINDOW_H, dz ? DUCT_PANE : jamb],
                [wx + (dz ? s * (ELEVATOR_WINDOW_W + jamb) / 2 : 0), mid,
                  wz + (dx ? s * (ELEVATOR_WINDOW_W + jamb) / 2 : 0)]);
            }
            addMesh(glassMat,
              [dx ? DUCT_PANE : ELEVATOR_WINDOW_W, ELEVATOR_WINDOW_H,
                dz ? DUCT_PANE : ELEVATOR_WINDOW_W],
              [wx, mid, wz]);
          }
          continue;
        }
        if (open.has(side)) continue;
        // Upper basket panes belong to the same union as ordinary duct walls.
        // Rendering them directly here and again in the generic shaft cell was
        // two identical transparent layers, which made machine elevators look
        // like they used a different (more opaque) glass material.
        const wallH = DUCT_WALL + levels[deck].h;
        const wallY = base + DUCT_WALL / 2;
        ductWalls.push(dx ? {
          axis: 'z', fixed: ceiling.x + dx * ELEVATOR_BASKET_HALF,
          lo: ceiling.z - ELEVATOR_BASKET_HALF,
          hi: ceiling.z + ELEVATOR_BASKET_HALF,
          y: wallY, h: wallH,
        } : {
          axis: 'x', fixed: ceiling.z + dz * ELEVATOR_BASKET_HALF,
          lo: ceiling.x - ELEVATOR_BASKET_HALF,
          hi: ceiling.x + ELEVATOR_BASKET_HALF,
          y: wallY, h: wallH,
        });
      }
      for (const connection of all.values()) {
        if (connection.deck !== deck) continue;
        const { dx, dz } = connection;
        // The neighbouring conveyor reaches the basket boundary, then this
        // tongue stops at the square opening's near edge. Running it to the
        // centre put the rail underneath/inside the crate as it arrived.
        const tongue = 0.5 - ELEVATOR_OPENING / 2;
        const tongueAt = (0.5 + ELEVATOR_OPENING / 2) / 2;
        addMesh(trackMat(connection),
          [dx ? tongue : ELEVATOR_TRACK_W, ELEVATOR_TRACK_H,
            dz ? tongue : ELEVATOR_TRACK_W],
          [ceiling.x + dx * tongueAt, base, ceiling.z + dz * tongueAt]);
        if (deck !== CEILING) continue;
        // Only the exposed bridge from basket to duct needs casing; the basket
        // itself already owns the glass around its centre.
        const armX = ceiling.x + dx * (ELEVATOR_BASKET_HALF + DUCT_ARM / 2);
        const armZ = ceiling.z + dz * (ELEVATOR_BASKET_HALF + DUCT_ARM / 2);
        // File this short bottom strip with the ordinary duct floors instead of
        // rendering a standalone transparent box. The floor-union pass below
        // then joins it to the neighbouring run, leaving one seam at the basket
        // rather than a floating middle pane with a seam at both ends.
        const bridgeW = dx ? DUCT_ARM : DUCT_FLOOR;
        const bridgeD = dz ? DUCT_ARM : DUCT_FLOOR;
        ductFloors.push({
          x0: armX - bridgeW / 2, x1: armX + bridgeW / 2,
          z0: armZ - bridgeD / 2, z1: armZ + bridgeD / 2,
          y: base - levels[deck].h / 2 - DUCT_PANE / 2,
        });
        // Same treatment for the two side panes: contribute intervals to the
        // ordinary wall union so they become the end of the duct wall, not two
        // extra transparent rectangles suspended between duct and basket.
        const bridgeWallY = base + DUCT_WALL / 2;
        const bridgeWallH = DUCT_WALL + levels[deck].h;
        for (const side of [-1, 1]) {
          ductWalls.push(dx ? {
            axis: 'x', fixed: ceiling.z + side * DUCT_HALF,
            lo: armX - DUCT_ARM / 2, hi: armX + DUCT_ARM / 2,
            y: bridgeWallY, h: bridgeWallH,
          } : {
            axis: 'z', fixed: ceiling.x + side * DUCT_HALF,
            lo: armZ - DUCT_ARM / 2, hi: armZ + DUCT_ARM / 2,
            y: bridgeWallY, h: bridgeWallH,
          });
        }
      }
    }

    const output = connections.outputs[0] ?? null;
    const direction = output ? (output.deck === CEILING ? 1 : -1)
      : (owner.kind === 'lift' && owner.way === 'down' ? -1 : 1);
    const rec = this.movingFixtures.get(id)
      ?? { moving: [], phase: (ceiling.x * 0.31 + ceiling.z * 0.17) % 1, signal: null };
    rec.conveyor = true;
    /**
     * A MOUTH BRINGS ITS OWN CARRIER, so it takes the glass and leaves the
     * piston.
     *
     * Everything above this line is architecture — baskets, portals, the hole
     * in the duct — and a tunnel that rises wants all of it. The hardware below
     * is driven by `shaftState`, which is the lift's gate, and a mouth has no
     * entry in it: built here it would stand inert at rail height for the whole
     * save, under the platform `attachTunnelPiston` already put on that square.
     * Two carriers on one cell, one of them never moving.
     *
     * So the mouth's own piston covers the whole journey instead — it already
     * reads the crate's `deck`, and that number does not stop at 0. See the
     * `tunnelPiston` branch in `animateStations`.
     */
    if (owner.kind === 'under') {
      this.movingFixtures.set(id, rec);
      return;
    }
    // A two-stage piston grows from the floor instead of a permanent rail
    // hanging through the shaft — see `buildPiston`, which a tunnel mouth rides
    // as well.
    const pistonBase = Math.max(0.025, levels[0].y - levels[0].h / 2);
    rec.elevatorPiston = {
      ...buildPiston(addMesh, frameMat, railMat, ceiling.x, ceiling.z,
        pistonBase, levels[0].y),
      lo: levels[0].y, hi: levels[CEILING].y,
      direction, at: null, machine: !!machineRoof,
      // A descending crate belongs to its feeder until it crosses into the
      // shaft. Watching only `id` requests the piston after the descent begins;
      // these directed top inputs are the advance call button.
      topFeeds: [...new Set(connections.inputs
        .filter((connection) => connection.deck === CEILING && connection.cell)
        .map((connection) => connection.cell.id))],
    };
    this.movingFixtures.set(id, rec);
  }

  /**
   * ...and which side of a shaft is a PORTAL, per storey.
   *
   * A lift stands on both, so "which way does it face" has two answers and
   * neither is `rot`. Both directions count: the side a run hands IN on is as
   * much a hole as the side it leaves by, and a housing walled across its own
   * inlet is a box the goods arrive through the side of.
   */
  liftConnections(L, c) {
    const ports = { 0: new Set(), [CEILING]: new Set() };
    const inputs = [];
    const outputs = [];
    const add = (list, cell, deck) => {
      const dx = Math.sign(cell.x - c.x);
      const dz = Math.sign(cell.z - c.z);
      // A cap only has four faces. Long hops and rises have no horizontal face
      // to open; ordinary lift connections are the adjacent cardinal cells.
      if (Math.abs(dx) + Math.abs(dz) !== 1) return;
      const side = `${dx},${dz}`;
      ports[deck]?.add(side);
      list.push({ cell, deck, dx, dz, side });
    };

    // OUT is exactly where the simulation sends a crate after the lift. There
    // is normally one, but using the full way list keeps this correct if lifts
    // ever gain branches.
    for (const way of [conveyorNext(L, c), ...conveyorBranches(L, c)]) {
      if (!way || (way.x === c.x && way.z === c.z)) continue;
      const deck = deckOf(way);
      const cell = conveyorAt(L, way.x, way.z, deck);
      if (cell && cell.id !== c.id) add(outputs, cell, deck);
    }

    // IN is every cell whose real way list names this lift on its own storey.
    // Scan the directed graph rather than guessing from adjacency: a belt that
    // merely touches a shaft is not an inlet, while a sorter branch is.
    for (const other of conveyorsOf(L)) {
      if (!other || other.id === c.id) continue;
      const deck = deckOf(other);
      const feeds = [conveyorNext(L, other), ...conveyorBranches(L, other)]
        .some((way) => way && way.x === c.x && way.z === c.z
          && deckOf(way) === deck && conveyorAt(L, way.x, way.z, deck)?.id === c.id);
      if (feeds) add(inputs, other, deck);
    }
    return { ports, inputs, outputs };
  }

  conveyorPours(L, c) {
    if (c.kind !== 'arm') return [];
    // A loader told to only put goods ON the line pours nowhere, so nothing
    // beside it is a hand-over — no chute, no join mark, no rail dropped for an
    // edge goods no longer cross. See `setArmMode`.
    if (c.mode === 'load') return [];
    const out = [];
    // The same four neighbours `armReach` hands to in the simulation. Overhead
    // those are floor fixtures on either side of the aisle; the spur and its
    // drop collar are drawn separately below.
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
      // A zero vector is not a spur. Kept defensive for an older snapshot or a
      // future vertical-only hand-over: otherwise every slat lands at the cell
      // centre and scrolls in a direction of `0,0`.
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

        // A vertical hand-off is now the piston itself. The old collar/post was
        // a second full-height shaft drawn through the machine roof beside the
        // moving piston, and it is exactly the centre mast this branch retired.
        if (!dx && !dz) {
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
        // So it drops to a hair over the deck top as one compact square in the
        // middle of the seam. A bar spanning most of the track width reads as a
        // separator plate; the small square reads as the flow-status pip this
        // actually is. It stays proud by a fraction rather than flush, because
        // flush with a dark deck at this angle is invisible.
        const link = new THREE.Mesh(geo, flowMaterial(CONVEYOR_LIT.idle));
        link.scale.set(JOIN_PIP_SIZE, 0.012, JOIN_PIP_SIZE);
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
      const below = deckOf(c) === CEILING ? conveyorAt(L, c.x, c.z, 0) : null;
      const shaftMouth = this.machineElevatorAt(L, c) ?? (below?.kind === 'lift' ? below : null);
      for (const tail of [false, true]) {
        // A loader/sorter underneath is the connection: the line ends at an
        // elevator mouth, not at an unconnected red/yellow terminal.
        if ((tail ? outs.length : fed.has(c.id)) || shaftMouth) continue;
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
        const step = tail ? END_PIP_OFFSET : -END_PIP_OFFSET;
        const pip = new THREE.Mesh(geo, endMaterial(tail));
        pip.scale.set(END_PIP_SIZE, PIP_H, END_PIP_SIZE);
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
      // Defensive against a future vertical-only hand-over: a bar marking an
      // EDGE has no edge to lie along for the cell's own square, so it would
      // land across the middle of the machine.
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
      // A lift's closed head owns the ceiling square above it. A separately
      // placed belt there is not allowed to paint a corner/filler through that
      // solid roof after its authored deck has been suppressed.
      const below = deckOf(c) === CEILING ? conveyorAt(L, c.x, c.z, 0) : null;
      if (below?.kind === 'lift') continue;
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
     * Neither is `rot`, because a lift has none — see `liftConnections`.
     */
    const ductFloors = [];
    const ductWalls = [];
    for (const c of cells) {
      if (c.kind !== 'lift') continue;
      this.addElevatorAssembly(L, c, c, geo, ductFloors, ductWalls);
    }

    /**
     * ...and the glass casing around an overhead duct.
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
     * So the casing is a fact about the FLOW, not about which row you picked.
     * A straight gets two panes, a bend gets its two outside halves, and a T
     * gets one — all standing on the transparent floor beneath the belt.
     */
    for (const c of cells) {
      if (deckOf(c) !== CEILING) continue;
      const deck = this.conveyorDeck(L, c);
      if (!deck) continue;
      const dY = deckLift(c);
      const path = this.conveyorPath(L, c);
      const below = conveyorAt(L, c.x, c.z, 0);
      // A regular lift owns its roof square. Its directed top connections are
      // rendered by `addElevatorAssembly`; letting a co-located ceiling belt
      // enter the generic duct pass gives that suppressed belt a second casing
      // whose end cap can stand across the lift's real inlet.
      if (below?.kind === 'lift') continue;
      const machineMouth = this.machineElevatorAt(L, c);
      const shaftMouth = machineMouth;
      const open = new Set();
      for (const o of outsOf(c)) open.add(`${Math.sign(o.x - c.x)},${Math.sign(o.z - c.z)}`);
      // NEGATED, the same conversion the filler above spells out: a feeder is
      // stored as the direction goods travel, and the side it is on is the
      // opposite vector. Read as-is, every duct is glazed shut at the end it is
      // fed from and open along a flank nothing uses.
      for (const f of path.feeds) open.add(`${-f.x},${-f.z}`);
      // An elevator is a MOUTH, never a through-cell. If horizontal
      // adjacency exists on both sides, prefer the side this belt hands on to:
      // that is the loader rising into the duct. With no horizontal output,
      // keep only the feeder side for a duct dropping into the machine.
      if (shaftMouth) {
        const next = conveyorNext(L, c);
        const on = next && deckOf(next) === CEILING
          && (next.x !== c.x || next.z !== c.z)
          && conveyorAt(L, next.x, next.z, CEILING);
        open.clear();
        if (on) open.add(`${Math.sign(next.x - c.x)},${Math.sign(next.z - c.z)}`);
        else if (path.feeds.length) open.add(`${-path.feeds[0].x},${-path.feeds[0].z}`);
      }
      // Measured off the model rather than written down — a run can be three
      // tiers of three shapes, and a pane sized to a remembered track leaves a
      // slit the day somebody authors a thicker one.
      // The transparent FLOOR under the belt. It is a centre square plus one
      // small extension per open side, which is the same union of rectangles
      // that the casing sits on: a straight is continuous, an L fills its
      // inside corner, and no glass can extend past an end cap.
      const floorY = dY + deck.y - deck.h / 2 - DUCT_PANE / 2;
      // Regular lifts were assembled in the lift loop above. Machine elevators
      // are discovered here, where their real vertical connection is known.
      if (machineMouth) {
        this.addElevatorAssembly(L, c, machineMouth, geo, ductFloors, ductWalls);
      }
      // An elevator needs an actual hole. Its connected arm strips remain, so
      // the glass floor and track reach the lip, but the centre square is not
      // laid across the shaft.
      if (!shaftMouth) {
        ductFloors.push({
          x0: c.x - DUCT_FLOOR / 2, x1: c.x + DUCT_FLOOR / 2,
          z0: c.z - DUCT_FLOOR / 2, z1: c.z + DUCT_FLOOR / 2, y: floorY,
        });
      }
      for (const side of open) {
        const [dx, dz] = side.split(',').map(Number);
        if (!dx && !dz) continue;
        const x = c.x + dx * (DUCT_FLOOR / 2 + DUCT_EDGE / 2);
        const z = c.z + dz * (DUCT_FLOOR / 2 + DUCT_EDGE / 2);
        const w = dx ? DUCT_EDGE : DUCT_FLOOR;
        const d = dz ? DUCT_EDGE : DUCT_FLOOR;
        ductFloors.push({ x0: x - w / 2, x1: x + w / 2,
          z0: z - d / 2, z1: z + d / 2, y: floorY });
      }
      // Vertical glass is the boundary of that same centre-square-plus-arms
      // shape. Closed centre sides are caps. Every open arm contributes its
      // two short, axis-aligned side walls. At an L those short walls are the
      // missing INSIDE corner; at a straight they extend the centre panes to
      // the neighbouring cell edge. No diagonal and no guessed long pane.
      // Keep the old wall TOP, but drop its bottom from the deck top to the
      // glass floor. The belt occupies the middle; the side pane still has to
      // cover that thickness or FPS sees a bright horizontal slit beneath it.
      const wallH = DUCT_WALL + deck.h;
      const wallY = dY + deck.y + DUCT_WALL / 2;
      const addWall = (dx, dz, x, z, span) => {
        ductWalls.push({ axis: dx ? 'z' : 'x', fixed: dx ? x : z,
          lo: (dx ? z : x) - span / 2, hi: (dx ? z : x) + span / 2,
          y: wallY, h: wallH });
      };
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (open.has(`${dx},${dz}`)) continue;
        addWall(dx, dz, c.x + dx * DUCT_HALF, c.z + dz * DUCT_HALF, DUCT_SPAN);
      }
      for (const side of open) {
        const [dx, dz] = side.split(',').map(Number);
        if (dx) {
          const x = c.x + dx * (DUCT_HALF + DUCT_ARM / 2);
          addWall(0, 1, x, c.z + DUCT_HALF, DUCT_ARM);
          addWall(0, -1, x, c.z - DUCT_HALF, DUCT_ARM);
        } else if (dz) {
          const z = c.z + dz * (DUCT_HALF + DUCT_ARM / 2);
          addWall(1, 0, c.x + DUCT_HALF, z, DUCT_ARM);
          addWall(-1, 0, c.x - DUCT_HALF, z, DUCT_ARM);
        }
      }

      /**
       * ...and the DROP COLLARS, which are the one thing a duct does that a
       * floor run cannot. An overhead loader reaches the neighbouring floor
       * fixtures on both sides, so every hand-over is an L: rail out from the
       * housing, then down. The horizontal half is the spur above; this is the
       * short vertical half at its far end.
       *
       * A collar rather than a tube all the way to the floor. The drop is most
       * of a wall's height, so a full shaft is a column standing in the aisle
       * you just bought the ceiling to clear, and at this camera it would hide
       * the shelf it is pouring into. A stub hanging under the deck says which
       * way the goods go and leaves the aisle empty, the same call
       * `SPUR_UNIT_REACH` makes about a track that would otherwise be drawn
       * under a shelf nobody can see through.
       */
      if (c.kind === 'arm' && deckOf(c) === CEILING) {
        for (const sp of this.conveyorSpurs(L, c)) {
          const collar = new THREE.Mesh(geo, material(CONVEYOR.frame, 1));
          collar.scale.set(DUCT_CHUTE, DUCT_DROP, DUCT_CHUTE);
          collar.position.set(
            c.x + sp.dx * sp.to,
            dY + deck.y - DUCT_DROP / 2,
            c.z + sp.dz * sp.to,
          );
          collar.raycast = NO_PICK;
          this.beltRoot.add(collar);
        }
      }
    }

    // The cell loop describes the SHAPE, but it must not dictate the panes.
    // Drawing every contribution separately made a continuous straight look
    // like a row of little windows: transparent overlaps darkened every join,
    // and even merely touching box faces left an anti-aliased seam. Union the
    // collinear intervals first, so a pane is split only by a real bend or end.
    const glassMat = material(CONVEYOR.glass, GLASS);
    const wallGroups = new Map();
    for (const w of ductWalls) {
      const key = `${w.axis}:${w.fixed.toFixed(4)}:${w.y.toFixed(4)}:${w.h.toFixed(4)}`;
      const group = wallGroups.get(key) ?? [];
      group.push(w);
      wallGroups.set(key, group);
    }
    for (const group of wallGroups.values()) {
      group.sort((a, b) => a.lo - b.lo);
      const merged = [];
      for (const w of group) {
        const last = merged[merged.length - 1];
        if (last && w.lo <= last.hi + 1e-4) last.hi = Math.max(last.hi, w.hi);
        else merged.push({ ...w });
      }
      for (const w of merged) {
        const pane = new THREE.Mesh(geo, glassMat);
        const span = w.hi - w.lo;
        pane.scale.set(w.axis === 'x' ? span : DUCT_PANE, w.h,
          w.axis === 'z' ? span : DUCT_PANE);
        pane.position.set(w.axis === 'x' ? (w.lo + w.hi) / 2 : w.fixed, w.y,
          w.axis === 'z' ? (w.lo + w.hi) / 2 : w.fixed);
        pane.raycast = NO_PICK;
        this.beltRoot.add(pane);
      }
    }

    // Floors use the same rule. Repeatedly merge rectangles that share a full
    // edge; this collapses a straight run to one sheet while preserving an L's
    // filled square corner without inventing a diagonal face.
    const same = (a, b) => Math.abs(a - b) < 1e-4;
    let floors = ductFloors.map((r) => ({ ...r }));
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < floors.length; i += 1) {
        for (let j = i + 1; j < floors.length; j += 1) {
          const a = floors[i]; const b = floors[j];
          if (!same(a.y, b.y)) continue;
          const xJoin = same(a.z0, b.z0) && same(a.z1, b.z1)
            && b.x0 <= a.x1 + 1e-4 && a.x0 <= b.x1 + 1e-4;
          const zJoin = same(a.x0, b.x0) && same(a.x1, b.x1)
            && b.z0 <= a.z1 + 1e-4 && a.z0 <= b.z1 + 1e-4;
          if (!xJoin && !zJoin) continue;
          floors[i] = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
            z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1), y: a.y };
          floors.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
    for (const f of floors) {
      const floor = new THREE.Mesh(geo, glassMat);
      floor.scale.set(f.x1 - f.x0, DUCT_PANE, f.z1 - f.z0);
      floor.position.set((f.x0 + f.x1) / 2, f.y, (f.z0 + f.z1) / 2);
      floor.raycast = NO_PICK;
      this.beltRoot.add(floor);
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
      const elevatorRoof = this.machineElevatorAbove(L, c)
        ? this.machineElevatorRoof(c) : null;
      const path = this.conveyorPath(L, c);
      const open = new Set();
      for (const s of [
        { x: -path.in.x, z: -path.in.z },
        // EVERY FEEDER, and `in` is only ever one of them. `conveyorPath` says
        // so where it builds the list — `in`/`out` is a single PAIR, so the
        // second line into a merge has no place in the path at all and is
        // invisible unless somebody asks for it by name. Every other reader here
        // already does (the joins come off `outsOf`, the blades off
        // `conveyorBranches`), and this loop was the one that did not: a
        // junction fed from behind AND from the side had a panel drawn across
        // the side, so the run arrived, the join lit on the ground, and the
        // crate went through the wall. It reads as the machine refusing that
        // line — which is exactly what it would look like if it were.
        //
        // Kept BESIDE `in` rather than replacing it: a head cell has no feeders
        // at all, and `in` falls back to the way it leaves, which is what opens
        // the back of a loader that starts a run.
        ...path.feeds.map((f) => ({ x: -f.x, z: -f.z })),
        path.out,
        ...conveyorBranches(L, c).map((b) => ({ x: Math.sign(b.x - c.x), z: Math.sign(b.z - c.z) })),
        // EVERY SPUR, which is both directions. This was `conveyorPours` alone,
        // and a pour is only half of what crosses a loader's sides: the side it
        // LIFTS from — a pad, a stockroom board — is a side goods cross every
        // bit as much, and it was being walled shut. So a load-only loader was a
        // sealed box with a green arrow painted on the panel, and the crate it
        // was pulling in came through the wall.
        ...this.conveyorSpurs(L, c).map((q) => ({ x: q.dx, z: q.dz })),
        // ...and a junction's REJECT side, which is a side goods cross and was
        // the one that could be walled shut. `setSorterReject` takes a line OR
        // walkable ground — an off-ramp, `sorterEject` — and only the first of
        // those is a branch, so a junction told to tip strays onto the floor
        // beside it had a panel drawn over the way they leave, and no bar to
        // light when they did.
        ...(c.kind === 'sorter' && Number.isInteger(c.reject)
          ? [anchorTile(0, 0, c.reject)] : []),
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
        const face = elevatorRoof
          ? ELEVATOR_OPENING / 2 + ELEVATOR_LID_BEZEL * 0.55
          : (dx ? box.long : box.cross);
        const pip = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
          color: new THREE.Color(LAMP_IDLE), flatShading: true,
        }));
        // Along the edge it sits on, so a bar reads as belonging to that side
        // rather than as a stud dropped on the roof. An elevator machine's
        // centre is now a hole, so its readouts hug that hole's four edges;
        // leaving them at the old cabinet centre would put the lights directly
        // over the carrier path.
        if (elevatorRoof) {
          pip.scale.set(dx ? 0.055 : 0.16, 0.025, dz ? 0.055 : 0.16);
          pip.position.set(c.x + dx * face,
            dY + elevatorRoof.y + elevatorRoof.h / 2
              + ELEVATOR_LID_BEZEL_H + 0.014,
            c.z + dz * face);
        } else {
          pip.scale.set(dx ? 0.1 : box.long * 1.1, 0.04, dz ? 0.1 : box.cross * 1.1);
          pip.position.set(c.x + dx * face * 0.66,
            dY + box.y + box.h / 2 + 0.02,
            c.z + dz * face * 0.66);
        }
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
      // The old branch blade crossed the centre of the authored sorter hub.
      // An elevator sorter has a real piston well there now, so the same bar
      // floats through the open cabinet and through the carrier. Its roof edge
      // lights already report which route was chosen; keep the well clear.
      if (this.machineElevatorAbove(L, c)) continue;
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
    // crate down the span and a mouth with nothing in it are the same still
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
      // ONE BAR PER SIDE OF THE CAP, which is a loader's readout said about a
      // shroud — and the reason it is four rather than the one it was is that
      // a single bar is a light you can stand on the wrong side of. Three
      // quarters of the yaws had the drive between the camera and the only lit
      // thing on the piece, so the answer to "is there a box in here" depended
      // on which way you had turned the view.
      //
      // Drawn here rather than authored for the reason the loader's are: a
      // readout has to be its own material. `material()` is a cache keyed by
      // colour, so recolouring an authored strip through it turns every teal
      // thing in the shop green.
      const artRot = tunnelExit(L, c)
        ? rot4((c.rot ?? 0) + 2) : rot4(c.rot ?? 0);
      const fwd = anchorTile(0, 0, artRot);
      const side = anchorTile(0, 0, rot4(artRot + 1));
      const rec = this.movingFixtures.get(c.id)
        ?? { moving: [], phase: (c.x * 0.31 + c.z * 0.17) % 1, signal: null };
      const lamps = [];
      for (const [mx, mz, sx, sz] of UNDER_LAMP_BARS) {
        const lamp = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
          color: new THREE.Color(LAMP_IDLE), flatShading: true,
        }));
        lamp.scale.set(sx, UNDER_LAMP_H, sz);
        // Turned as well as offset: the bars run along the cap they lie on, so
        // a scale left in world axes lays two of the four across their own bar.
        lamp.rotation.y = -artRot * (Math.PI / 2);
        lamp.position.set(c.x + fwd.x * mx + side.x * mz, dY + UNDER_LAMP_Y,
          c.z + fwd.z * mx + side.z * mz);
        lamp.raycast = NO_PICK;
        this.beltRoot.add(lamp);
        lamps.push(lamp);
        rec.moving.push({
          // Nothing to animate — a mouth says what it holds in COLOUR, and a
          // bar that moved as well would be the only thing on a run that does.
          // What it is on this list for is `weld`, exactly as a loader's pips
          // are: anything left off it is frozen into the merged mesh, drawn
          // once at `LAMP_IDLE` and never recoloured again. Which is a readout
          // that is permanently off, and reads as the tunnel not reporting
          // rather than as the light having been welded to the shop.
          mesh: lamp,
          motion: { kind: 'none' },
          pos: lamp.position.clone(),
          rot: 0,
          scale: lamp.scale.clone(),
          axis: null,
          arm: null,
          pivot: null,
          phase: 0,
        });
      }
      rec.conveyor = true;
      // What decides the COLOUR, since a mouth has no `armSaid` to report: it
      // either has a box in it or it has not, and that is the whole readout.
      rec.mouth = true;
      (rec.lamps ??= []).push(...lamps);
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
      if (rec.elevatorPiston) {
        moving.add(rec.elevatorPiston.outer);
        moving.add(rec.elevatorPiston.inner);
        moving.add(rec.elevatorPiston.platform);
        moving.add(rec.elevatorPiston.pad);
      }
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
    // `deck` is part of the thing being previewed just as much as its tile and
    // facing. Without it, pressing E over a still tile hits this cache and
    // leaves the old floor ghost in place.
    const key = `${spec.kind}:${spec.x}:${spec.z}:${spec.rot}:${deckOf(spec)}:${state}:${drawnAs}`;
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
    // Draw from the same base as the fixture it will become. This covers both
    // authored hanging props and conveyors whose placement moves them overhead;
    // a ghost on the floor answers the wrong question for either one.
    const gm = footprintMid(spec.kind, spec.x, spec.z);
    g.position.set(gm.x, this.fixtureBaseY(spec), gm.z);
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
  setEdgeGhost(segs, state, kind = null) {
    // What the ghost is ABOUT, which is not always what you are holding. A build
    // preview is the armed tool and says so; `aim` and the bulldozer are pointed
    // at something that is already there and have no tool to name, so the
    // boundary answers for itself. A wall's ghost and a fence's differ by more
    // than a colour, and lighting up a gate at wall height is the same lie as
    // previewing one.
    const at = (s) => {
      const L = this.storeLayout;
      if (!L) return E.NONE;
      return (s.o === 'v' ? L.edgesV?.[s.z * (L.w + 1) + s.x] : L.edgesH?.[s.z * L.w + s.x])
        ?? E.NONE;
    };
    const shown = segs?.length ? (kind ?? at(segs[0])) : null;
    const key = segs?.length
      ? `${state}:${shown}:${segs[0].o}:${segs[0].x},${segs[0].z}:${segs.length}`
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
    // HOW BIG THE GHOST IS COMES OFF THE KIND, and this is `client/thumb.js`'s
    // rule about the palette button said about the preview: a picture of a thing
    // has to come from the thing. It was 1.2 tall and 0.22 thick, hand-matched to
    // a wall the day it was written and never again — so raising `WALL_H` left
    // every wall preview in the game short by nearly half, which reads as the
    // ghost being a different feature from the wall rather than as a stale
    // number. And it was wrong in the other direction for the whole catalog
    // besides: a fence is 0.5 tall, so a boundary tool previewed a slab more than
    // twice the height of what it builds.
    const style = EDGE_STYLE[shown] ?? EDGE_STYLE[E.WALL];
    // A hair fatter than the real thing, which is the one number here that is
    // not the wall's own: the `aim` state lights up an edge that is ALREADY
    // there, and a ghost at exactly its thickness is two coplanar faces fighting
    // over the depth buffer — the highlight would flicker as the camera turned.
    const t = style.t + 0.05;
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const s of segs) {
      const mesh = new THREE.Mesh(geo, material(colour, 0.5));
      // Same centring the real edge renderer uses: a vertical segment sits on
      // the lattice line in x and spans the cell in z, and the other way round.
      if (s.o === 'v') {
        mesh.position.set(s.x - 0.5, style.h / 2, s.z);
        mesh.scale.set(t, style.h, 1);
      } else {
        mesh.position.set(s.x, style.h / 2, s.z - 0.5);
        mesh.scale.set(1, style.h, t);
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
   * THE GROUND A SELECTION HOLDS — the half of a pick that has no frame.
   *
   * A fixture picked gets a teal ring, and that is the whole of how anybody can
   * tell what a bulk verb is about. Ground cannot have one: there is no record to
   * ring, and a pad is dozens of cells rather than a thing. So a marquee that
   * caught a room's floor had *nothing* on screen to say it — the shelves lit up,
   * the pads sat there looking exactly as they did a moment before, and the only
   * way to find out whether they were part of the selection was to stamp it
   * somewhere and count.
   *
   * Flat and filled rather than framed, which is the same call `MARKER_LOOK.stock`
   * makes about the chevron: this appears in *numbers*, and thirty outlined
   * squares is a shop you cannot read. Teal, because it is `selected`'s sentence
   * — nothing is about to happen to it, it is what you have got hold of.
   *
   * Keyed on the cells, so the selection standing still costs nothing. It is
   * `setFloorGhost`'s neighbour and deliberately not its caller: a ghost is a
   * promise about the press you are about to make, and this is a fact about one
   * you already made.
   */
  setPickArea(cells) {
    const key = cells?.length
      ? `${cells.length}:${cells[0].x},${cells[0].z}:${cells[cells.length - 1].x},${cells[cells.length - 1].z}`
      : null;
    if (key === (this.pickAreaKey ?? null)) return;
    this.pickAreaKey = key;

    if (this.pickArea) {
      this.actorRoot.remove(this.pickArea);
      disposeGroup(this.pickArea);
      this.pickArea = null;
    }
    if (!key) return;

    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const c of cells) {
      const mesh = new THREE.Mesh(geo, material('#5fd6c4', 0.3));
      // Above whatever ground is there, and inset so a block of them shows its
      // own grid rather than reading as one undivided sheet — `setFloorGhost`'s
      // numbers, because the two are read at the same glance.
      mesh.position.set(c.x, 0.1, c.z);
      mesh.scale.set(0.9, 0.04, 0.9);
      group.add(mesh);
    }
    this.actorRoot.add(group);
    this.pickArea = group;
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

  /**
   * Which lines a box could be on and still have to do with the thing you
   * picked — the map asked about ONE fixture rather than about the shop.
   *
   * The overlay says the network is well formed, which is a different question
   * from the one anybody standing in a shop actually has: *how does bread get
   * to that shelf*. With eleven runs and four junctions on screen, following it
   * by eye is reading four correct arrows at every fork and remembering which
   * one you were on — and a box that took a line you did not expect leaves
   * nothing behind to explain itself (docs/belts.md, What is lacking §2).
   *
   * `conveyorLines` hands back the graph both ways — `feeds` is who hands to
   * this line, `ways` is who it hands to — so this is a walk over one of those
   * and no new walk of the shop.
   *
   * IT IS A ROUTE AND NOT A REACHABLE SET, which is the whole of what makes it
   * a readout. Lighting everything a box could get here from is the obvious
   * build and it is the one that does not work, because a shop that is worth
   * asking about is a shop whose runs all join up: measured on a real save —
   * 72 belt cells, 23 loaders, 4 junctions, 23 lines — the upstream set was
   * **15 lines of 23 whatever you picked**, so every shelf in the building
   * answered with the same picture. What that reads as is the map ignoring you,
   * which is precisely the report it came back with. The union of the SHORTEST
   * ways in is 5 or 6, and it is a different 5 or 6 per aisle.
   *
   * So: hop distance upstream from the thing you picked, then walk back down
   * the way you came from every line a box gets ON — one that nothing feeds.
   * A ring has none of those, so the far end of the walk stands in for one,
   * which draws the loop as the way in that it is.
   *
   * UPSTREAM ONLY, for every kind of subject. A unit is an end, so it has no
   * other direction; a belt does, and lighting where its boxes go on as well
   * doubled the picture on the same save (10-11 of 23) for a second claim in
   * the same ink as the first. The question people bring to this is where the
   * goods came FROM, and the one that arrives with it — where does this run go
   * — is the map it was already looking at.
   *
   * A selection the network has never heard of returns null rather than an
   * empty set, and that is the difference between "nothing feeds this" and "you
   * are not asking about the belts". Greying the whole map because somebody
   * opened a till is a readout that looks broken; the map goes back to being a
   * map, which is what it was a moment ago.
   *
   * It is the shortest way rather than a PREDICTION: what a junction does with
   * any given box is `sorterOut`'s answer and it depends on what is in the box.
   * Nothing here claims otherwise — the lit route is the way in, and where it
   * looks wrong is where you go and read the sorter.
   */
  flowFocus(cut, subjects) {
    if (!subjects?.length) return null;
    const { lines, feeds, ways } = cut;
    const out = new Set();
    /**
     * One subject's way in, added to whatever the others found.
     *
     * Per subject and NOT one walk seeded with all of them, which is the same
     * shape of mistake the flood was. Distances from a shared seed set are
     * distances to the NEAREST of them, so a trunk feeding two picked shelves
     * would light the route to the closer one and nothing at all for the other
     * — a selection of six units answering with one route, which is a readout
     * that quietly ignores five of the things you pointed at.
     */
    const trace = (focus) => {
      const wired = CONVEYOR_KINDS.includes(focus.kind);
      const seeds = lines.filter((line) => (wired
        // By id first and by tile second, for `selectedFixture`'s own reason —
        // and the storey has to be in it, or a duct over a belt traces whichever
        // of the pair happens to be listed first.
        ? line.cells.some((c) => c.id === focus.id
          || (c.x === focus.x && c.z === focus.z && deckOf(c) === deckOf(focus)))
        // `armReach` and `covers`, which is `conveyorMeets`' own pair: a loader
        // fills whatever is beside it rather than only the side it is aimed at,
        // and a pen is four cells with its record on the min corner.
        : line.cells.some((c) => c.kind === 'arm'
          && armReach(c).some((t) => covers(focus, t.x, t.z)))));
      if (!seeds.length) return;

      // How many hand-offs upstream each line is. BREADTH first — `shift` and
      // not `pop` — because these are distances and not a visited set: depth
      // first stamps whatever number the wander happened to arrive with, and
      // the walk home below then follows it into the long way round.
      const hops = new Map(seeds.map((l) => [l.id, 0]));
      const queue = [...seeds];
      while (queue.length) {
        const line = queue.shift();
        for (const f of feeds.get(line.id) ?? []) {
          if (hops.has(f.id)) continue;
          hops.set(f.id, hops.get(line.id) + 1);
          queue.push(f);
        }
      }

      // Where a box gets on: a line nothing hands to. A ring is fed by itself
      // and has none, so the far end of the walk stands in — which draws the
      // loop as the way in, which is what it is.
      let starts = lines.filter((l) => hops.has(l.id) && !(feeds.get(l.id) ?? []).length);
      if (!starts.length) {
        const far = Math.max(...hops.values());
        starts = lines.filter((l) => hops.get(l.id) === far);
      }

      for (const l of seeds) out.add(l.id);
      for (const start of starts) {
        let line = start;
        out.add(line.id);
        while (hops.get(line.id) > 0) {
          // Downhill, and the guard is what stops a cycle walking for ever: a
          // step that does not get closer is not a way home.
          const next = (ways.get(line.id) ?? []).filter((w) => hops.has(w.id))
            .sort((a, b) => hops.get(a.id) - hops.get(b.id))[0];
          if (!next || hops.get(next.id) >= hops.get(line.id)) break;
          line = next;
          out.add(line.id);
        }
      }
    };
    for (const focus of subjects) trace(focus);
    // Nothing picked is on the network ⇒ null, and not an empty set: the map
    // going back to being a map is a different answer from every run in the
    // shop going grey.
    return out.size ? out : null;
  }

  /**
   * The transport network drawn as what it is: LINES, with the joins marked.
   *
   * Everything else the renderer says about a conveyor is said one cell at a
   * time — the slats lie along the path, the chevrons point at `conveyorNext`,
   * the end pips cap a run that hands to nothing. Every one of those is correct
   * and legible, and between them they cannot say the thing that actually goes
   * wrong: a ring is four correct arrows. A shop had a sorter and the cell
   * above it handing to each other, with three crates of good stock going round
   * for the rest of the save, and from a chair the pair looked exactly like a
   * working corner — because each half of it was one.
   *
   * So the overlay is the one readout in the game about the SHAPE of the
   * network rather than about a square of it. `conveyorLines` already cuts the
   * shop into lines at junctions, merges and termini, which is the graph;
   * `conveyorLoops` says where it eats itself.
   *
   * Three decisions in it are worth keeping:
   *
   * A **tug is the only thing drawn red**, and cycles are not drawn as errors
   * at all. A loop with loaders down it is a thing people build on purpose, and
   * the boxes going round it are the buffer. Colouring every cycle would light
   * up most of a shop that is working — and a warning is only worth what its
   * silence is worth. Two cells handing to each other is the case that is
   * always a mistake, and it is the case nothing on screen could say.
   *
   * It floats **above** the run rather than lying on it. The whole point is to
   * be readable across a shop, over the machines and the crates standing on
   * them — laid on the deck it would be hidden by exactly the traffic that
   * makes you want it.
   *
   * And it is keyed on the layout rather than rebuilt per frame: it is a walk
   * of the whole network, it cannot change until somebody builds something, and
   * build mode re-flows on every wall segment of a drag.
   *
   * WHO TURNS IT ON is the one thing here that changed after it shipped, and it
   * is worth the line. It was gated on `paletteArmed`, on the argument that
   * wiring belts is what build mode is for — which is true and is only half of
   * when you want it. The other half is watching a run that has stopped, and
   * that is not build mode at all: you are stood in the aisle looking at a
   * crate. Worse, a readout with no switch is a readout only the person who
   * wrote it knows about, which is client/debug.js's whole argument about
   * `?perf` and `?tiles`. It is a row in `DEBUGS` now, so it has a tile in the
   * Menu, it is remembered, and `?flow` still works.
   *
   * @param {boolean} on
   * @param {object[]|null} focus what the map is being asked about — the
   *   selection, which is one fixture or a whole shift-picked set of them
   */
  setFlowOverlay(on, focus = null) {
    const L = this.storeLayout;
    // Each subject by TILE and kind rather than by id, which is `sameFixture`'s
    // rule said about a cache key: an id is re-minted by every rotate and every
    // re-flow, so keyed on one the map would rebuild itself on presses that
    // changed nothing about what is selected.
    const at = (focus ?? []).map((f) => `${f.kind}@${f.x},${f.z},${deckOf(f)}`).join('|');
    const key = on && L ? `${this.layoutVersion}:${at}` : null;
    if (key === this.flowOverlayKey) return;
    this.flowOverlayKey = key;

    if (this.flowOverlay) {
      this.actorRoot.remove(this.flowOverlay);
      disposeGroup(this.flowOverlay);
      this.flowOverlay = null;
    }
    if (!key) return;

    const cut = conveyorLines(L);
    const { lines, feeds, byCell } = cut;
    if (!lines.length) return;
    const lit = this.flowFocus(cut, focus);
    const { inCycle, tugs } = conveyorLoops(L);
    // Cells rather than lines: a tug is two squares, and both of them are
    // usually in the middle of something much longer.
    const tugged = new Set();
    for (const [a, b] of tugs) { tugged.add(a.id); tugged.add(b.id); }

    /**
     * Every leg that is a tunnel, asked of the piece rather than of the length.
     *
     * "Longer than a tile" was the test and it is true of most tunnels rather
     * than of tunnels: two mouths can be laid side by side, and that hop is one
     * tile like every belt in the shop, so the one span that must not read as
     * surface read as surface exactly when it was shortest. The pair is also a
     * CHAIN — a mouth is an entry and an exit at once where three are laid in a
     * row — so the answer has to come from `tunnelExit` per mouth, which is the
     * same function the sim hands the crate to.
     */
    const digs = new Set();
    for (const u of (L.unders ?? [])) {
      const far = tunnelExit(L, u);
      if (far) digs.add(`${u.x},${u.z}>${far.x},${far.z}`);
    }

    // Just clear of the belt deck, and no higher — see `FLOW_INK` for why the
    // obvious "float it above the traffic" is the one thing this must not do.
    const RIBBON = 0.22;
    // ...and how far under it a tunnel runs. Deep enough to read as a separate
    // layer at this camera and no deeper: the map is drawn with the depth test
    // off, so this is legibility rather than geometry, and a span dropped a
    // metre down would leave its two verticals crossing half the shop.
    const UNDER_Y = -0.55;
    const OK = 'ok';
    const BAD = 'bad';
    /**
     * ...and a line that reaches NOTHING, which is the one thing every other
     * mark in here is incapable of saying.
     *
     * Each rung of the routing is a local answer and a dead run gives correct
     * local answers all day: the chevrons point somewhere, `conveyorLines` cuts
     * a clean graph out of it, and `whatThisCosts` only ever warns per CELL
     * ("nothing in front of it", "nothing beside it to work"). Nobody asks the
     * question about the LINE — so a run with no shelf, machine, skip, pen or
     * bed anywhere down it drew in exactly the same colour as one stocking the
     * whole shop, and a box put on it rides to the end and stops. Audited on a
     * real save: 32 of 115 conveyor cells.
     *
     * The sorter is the one piece that already knows — `sorterWants` is this
     * same forward walk — and it keeps the answer to itself, which is why a
     * dead line reads as a junction that refuses to send anything down it.
     *
     * AMBER rather than red, and the distinction is the one `FLOW_INK.warn`
     * already draws: a tug is always a mistake, where a line still being built
     * is the ordinary state of a run you are half way through laying. Red for
     * "this is wrong", amber for "this goes nowhere yet". A tug on a dead line
     * still draws red, because the worse of the two is the one worth seeing.
     */
    const DEAD = 'dead';
    /**
     * ...and the rest of the shop, while the map is answering about one thing.
     *
     * It outranks amber and NOT red, which is the same line those two already
     * draw between them. A tug is always a mistake and is worth seeing wherever
     * it is; a dead end is the ordinary state of a run somebody is half way
     * through laying, and in a shop with eleven of them it is most of the
     * picture — grey it, or the trace has nothing quiet to be loud against.
     */
    const OFF = 'off';
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // An explicit `y` wins, which is how the buried run gets under the floor —
    // `deckOf` knows two storeys and a tunnel is on neither of them.
    const y = (p) => p.y ?? ((deckOf(p) === CEILING ? CEILING_Y : 0) + RIBBON);
    // Unlit AND depth-tested out of the scene. A diagram is not part of the
    // shop and must not be lit like one: a Lambert ribbon takes the room's own
    // light, so the half of it under a canopy or on the night side reads as a
    // run that stops there — which is precisely the claim this exists to make
    // and it would be making it at random.
    const ink = (c) => (c === BAD ? FLOW_INK.bad
      : (c === OFF ? FLOW_INK.mute : (c === DEAD ? FLOW_INK.warn : FLOW_INK.ok)));
    const paint = (mesh) => { mesh.renderOrder = 900; group.add(mesh); };

    /** One leg of a polyline, as a thin bar between two points. */
    const leg = (a, b, colour) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dy = y(b) - y(a);
      const len = Math.hypot(dx, dz, dy);
      if (len <= 0) return;
      const mesh = new THREE.Mesh(geo, ink(colour));
      mesh.position.set(a.x + dx / 2, y(a) + dy / 2, a.z + dz / 2);
      mesh.scale.set(0.1, 0.1, len);
      // Aimed rather than axis-aligned, because a riser is a vertical leg and a
      // lift's hop is the one place the polyline leaves the horizontal.
      mesh.lookAt(b.x, y(b), b.z);
      paint(mesh);
    };

    /**
     * A node. Three shapes are the three answers `conveyorLines` gives to
     * "where does a line end" — a junction chooses, a merge is where somebody
     * has to be told no, a terminus hands to nothing — and the fourth is a
     * tunnel MOUTH, which is the one node that is not a line boundary at all.
     */
    const node = (p, shape, colour) => {
      const mesh = new THREE.Mesh(geo, ink(colour));
      mesh.position.set(p.x, y(p), p.z);
      if (shape === 'junction') {
        mesh.scale.set(0.34, 0.34, 0.34);
        mesh.rotation.y = Math.PI / 4;
      } else if (shape === 'merge') {
        mesh.scale.set(0.4, 0.12, 0.4);
      } else if (shape === 'terminus') {
        // A bar ACROSS the run: the same picture a buffer stop is, and the one
        // node whose meaning is "and then nothing".
        mesh.scale.set(0.44, 0.2, 0.12);
      } else if (shape === 'mouth') {
        mesh.scale.set(0.3, 0.3, 0.3);
      } else {
        mesh.scale.set(0.2, 0.2, 0.2);
      }
      paint(mesh);
    };

    /**
     * The buried span, which GOES DOWN — a tunnel is a lift with the sign
     * flipped, and drawing it any other way is what made it unreadable.
     *
     * It was dashes at deck height, on the argument that a dashed line reads as
     * something you cannot see. It does not, because of where it lies: the span
     * crosses tiles that have their own runs on them, at exactly the height
     * those runs are drawn, so the one leg that is meant to say "this is not on
     * the surface" was laid on top of the surface among the things it is meant
     * to be under. Two mouths four tiles apart, with a duct and a shaft in the
     * corridor between them, and no way at all to tell which line was which.
     *
     * A lift already had the answer and it is the same answer: a change of
     * storey is drawn as a change of HEIGHT, so a duct reads as overhead
     * without anybody being told. Down is the same claim, and it costs one
     * constant.
     *
     * SOLID, and the dashes are the second thing this got wrong. They were kept
     * on the horizontal so the buried run would still read as something you
     * cannot see — but the depth already says that, and a dashed line drawn
     * with the depth test off has nothing behind it to be dashed against. What
     * it drew was three short bars hanging over the floor with air between
     * them, which is not "hidden", it is "unfinished": the eye joins a line
     * that dips and comes back, and refuses to join a row of stubs. One
     * unbroken polyline, exactly as a shaft's riser is one.
     */
    const buried = (a, b, colour) => {
      const down = { x: a.x, z: a.z, y: UNDER_Y };
      const up = { x: b.x, z: b.z, y: UNDER_Y };
      leg(a, down, colour);
      leg(down, up, colour);
      leg(up, b, colour);
    };

    /**
     * A hand-off between two lines, which is the one leg that can change
     * storey — and therefore the one leg that needs a RISER.
     *
     * `conveyorLines` already inserts one inside a line's own path, and its
     * note says why: a lift hands to a cell BESIDE it on the other deck, so the
     * leg changes x,z and height at once and a straight line between the two
     * ends flies the diagonal — up and over, out through the wall of its own
     * shaft. What that draws is an X across the aisle, and the only thing in
     * the shop that can carry a box between two storeys is the shaft.
     *
     * It had to be said again here because a LIFT IS A LINE BOUNDARY: every
     * shaft hop in the building is a hand-off rather than a step inside a path,
     * so the riser that function inserts is inserted in the one place this
     * never looks. Which of the pair is the shaft, and which deck the flat leg
     * runs along, are `cut`'s test exactly — written the same way round on
     * purpose, since the two disagreeing is a diagram that contradicts the
     * crate it is drawn over.
     */
    const hop = (a, b, colour, fromDeck = deckOf(a), toDeck = deckOf(b)) => {
      const flat = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
      // WHICH STOREY EITHER END IS ON is the line's answer rather than the
      // cell's, because a shaft stands on both and its placement says 0. A run
      // that passes straight THROUGH one — a duct handing to a lift told `up`,
      // which carries on along the ceiling — is a flat step, and read off
      // `deckOf` it drew a dive to the floor and back for a ride nobody takes.
      const at = { x: a.x, z: a.z, deck: fromDeck };
      const to = { x: b.x, z: b.z, deck: toDeck };
      // A tunnel can be a line boundary too — a mouth whose far end is a merge
      // or a junction — so the dive has to be asked here as well, or the same
      // span reads as buried or as surface depending on what happens to be
      // standing at the other end of it.
      if (digs.has(`${a.x},${a.z}>${b.x},${b.z}`)) { buried(at, to, colour); return; }
      if (fromDeck !== toDeck && flat) {
        const shaft = a.kind === 'lift' ? a : b;
        const mid = { x: shaft.x, z: shaft.z, deck: a.kind === 'lift' ? toDeck : fromDeck };
        leg(at, mid, colour);
        leg(mid, to, colour);
        return;
      }
      leg(at, to, colour);
    };

    /**
     * The stub from a loader to the thing it empties into.
     *
     * Half a tile and a pip on the end, deliberately not a full leg: it is not
     * part of the run — nothing travels ALONG it, a box leaves the network here
     * — and drawn tile-to-tile it would read as one more length of conveyor
     * heading into the shelf.
     */
    const spur = (c, to, colour) => {
      const dx = (to.x - c.x) * 0.42;
      const dz = (to.z - c.z) * 0.42;
      leg({ x: c.x, z: c.z, deck: deckOf(c) }, { x: c.x + dx, z: c.z + dz, deck: deckOf(c) }, colour);
      const pip = new THREE.Mesh(geo, ink(colour));
      pip.position.set(c.x + dx, y(c), c.z + dz);
      pip.scale.set(0.16, 0.16, 0.16);
      pip.rotation.y = Math.PI / 4;
      paint(pip);
    };

    /**
     * A junction's REJECT side — where a box nothing wants goes.
     *
     * The one setting on a conveyor that nothing anywhere draws. It is stored
     * as a quarter turn and `setSorterReject` takes any of the four, so it is
     * NOT the same thing as which way the piece is aimed — the fixture menu
     * only ever offers you the aimed side, which makes the two agree at the
     * moment you press it and not one press of R afterwards. From that point on
     * the menu lights neither of its rows, and there is no mark in the world at
     * all: a junction with a live reject line and one without are the same
     * picture of the same piece.
     *
     * Which turns into a silent nothing when the cell it names is torn out.
     * `sorterOut` asks `beltAt` before it will use the side, so a reject
     * pointed at bare floor is a setting that reads as ON and does nothing —
     * and what you watch is strays splitting into a line you meant to keep
     * clean, with the menu quietly showing you no answer.
     *
     * Amber, and its own arm rather than a colour on an existing one: it is a
     * PREFERENCE among the ways out rather than a way out of its own, so it has
     * to sit beside them and not replace one.
     */
    const rejectArm = (c, colour) => {
      if (!Number.isInteger(c.reject)) return;
      const t = anchorTile(c.x, c.z, c.reject);
      const dx = (t.x - c.x) * 0.34;
      const dz = (t.z - c.z) * 0.34;
      const bar = new THREE.Mesh(geo, ink(colour));
      bar.position.set(c.x + dx, y(c) + 0.14, c.z + dz);
      bar.scale.set(0.18, 0.18, 0.18);
      paint(bar);
    };

    /**
     * Does a box put on this line have anywhere to end up?
     *
     * Asked of the line's FIRST cell, which is both the honest question and the
     * cheap one: `conveyorMeets` is a forward walk, so everything reachable from
     * a later cell is reachable from the head too. Head reaches nothing ⇒ no
     * cell on the line reaches anything, and one call answers for the whole run.
     *
     * All five lists, because a loader COLLECTS from a pen and a bed — a line
     * laid out to the field is the one that would otherwise read as dead on
     * precisely the press that automates the walk, which is the shape
     * `whatThisCosts` already had to be corrected for.
     *
     * The walk is cached against the same array identities `conveyorFlow`
     * watches, and this whole overlay is rebuilt only when the layout version
     * moves — so it is one cached call per line on a build press.
     */
    const reaches = (line) => {
      const met = conveyorMeets(L, line.cells[0]);
      return met.shelves.length + met.stations.length + met.bins.length
        + (met.pens?.length ?? 0) + (met.plots?.length ?? 0) > 0;
    };

    for (const line of lines) {
      const bad = line.cells.some((c) => tugged.has(c.id));
      const off = lit && !lit.has(line.id);
      const colour = bad ? BAD : (off ? OFF : (reaches(line) ? OK : DEAD));
      for (let i = 1; i < line.pts.length; i++) {
        const a = line.pts[i - 1];
        const b = line.pts[i];
        if (digs.has(`${a.x},${a.z}>${b.x},${b.z}`)) buried(a, b, colour);
        else leg(a, b, colour);
      }

      // BOTH mouths, which is what a tunnel needed and could not have from the
      // line boundaries alone: an entry is usually the head of its line and so
      // picks up a node for free, and the exit is in the middle of one and so
      // picks up nothing. One mark on a pair reads as a run that goes into the
      // ground and does not come out.
      for (const c of line.cells) if (c.kind === 'under') node(c, 'mouth', colour);

      const head = line.pts[0];
      const tail = line.pts[line.pts.length - 1];
      const from = feeds.get(line.id) ?? [];
      node(head, line.junction ? 'junction' : (from.length > 1 ? 'merge' : 'source'), colour);
      // Only a line that hands to NOTHING gets a stop. A line in a cycle has no
      // terminus by definition — `conveyorLines` cut it at an arbitrary cell —
      // so capping it would draw a buffer stop in the middle of a working loop.
      if (!line.outs.length && !inCycle.has(line.id)) node(tail, 'terminus', colour);

      /**
       * ...and the HAND-OFF, which is the half that was missing.
       *
       * A line's `pts` stop at its own last cell, so drawing lines alone leaves
       * a tile of nothing at every join — and a join is exactly where the
       * interesting thing happens. What it read as was a diagram of runs that
       * are not connected to each other, which is the opposite of the claim.
       *
       * Drawn from the tail rather than as part of the next line's path, and
       * that is what makes a junction legible: a sorter's `outs` are three
       * different ways out, so three legs leave the same diamond and the split
       * is a picture rather than something you work out from the arrows.
       */
      // The tail CELL rather than the tail point, because `hop` has to ask
      // whether either end is the shaft and a point does not know what it is —
      // so the storey has to be handed over beside it, from the line each end
      // belongs to. Same x and z; the same deck everywhere but a shaft.
      const tailCell = line.cells[line.cells.length - 1];
      const tailDeck = line.decks?.[line.cells.length - 1] ?? deckOf(tailCell);
      for (const w of line.outs) {
        const at = byCell.get(w.id);
        hop(tailCell, w, colour, tailDeck, at?.line.decks?.[at.i] ?? deckOf(w));
      }
    }

    /**
     * ...and where goods LEAVE the network, which nothing above could say.
     *
     * Every line in the map ends at another line or at a buffer stop, so a shop
     * whose whole point is a loader bolted to a skip drew a run that stops
     * beside the skip and never mentions it. The one question you take to this
     * overlay — does this thing actually reach the bin — was the one it could
     * not answer.
     *
     * `armReach` and `unitOn` rather than `rot`: a loader pours into whatever is
     * beside it and `rot` is only the side it tries first, so drawing the aimed
     * side alone would promise a machine is fed by one board and quietly hide
     * the other three it is also filling.
     */
    // A spur takes its line's answer, which is what keeps the trace honest at
    // the one place goods leave: the stub into the shelf you picked is drawn in
    // the same ink as the run that fills it, and the four other units the same
    // loader also serves light with it — they are where those goods go too, and
    // greying them would draw a run that feeds one board and nothing else.
    const litCell = (id) => !lit || lit.has(byCell.get(id)?.line.id);
    for (const c of (L.arms ?? [])) {
      const bad = tugged.has(c.id);
      const colour = bad ? BAD : (litCell(c.id) ? OK : OFF);
      for (const t of armReach(c)) {
        if (unitOn(L, t.x, t.z)) spur(c, t, colour);
      }
    }
    for (const c of (L.sorters ?? [])) rejectArm(c, litCell(c.id) ? DEAD : OFF);

    this.actorRoot.add(group);
    this.flowOverlay = group;
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
    // Cleared with the armful it belongs to, and cleared whether or not the new
    // one has a count on it: an armful that drops from six units to one is a
    // label freed by `disposeGroup` above, and a reference kept past that is a
    // dead sprite being handed an opacity every frame for the rest of the save.
    rec.carryTag = null;
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
      // Two by two, not four in a column. `CARRY_SHOWN` at 0.15 apart is a
      // 0.45-tall tower, which on a body 0.78 high starts at the arms and ends
      // above the head — an armful drawn as a totem pole, and the reason
      // carried goods read as floating rather than as held. A block is what an
      // armful looks like.
      one.position.set(((n % 2) - 0.5) * 0.17, Math.floor(n / 2) * 0.13,
        ((Math.floor(n / 2) % 2) - 0.5) * 0.08);
      held.add(one);
      n++;
    }
    // Nothing in the catalog answered to any of it — better to draw nothing
    // than an empty group floating at chest height.
    if (!n) return;

    const total = lines.reduce((s, l) => s + l.qty, 0);
    if (total > 1) {
      const label = buildTextSprite(`x${total}`, { fill: '#fff3cf', scale: 0.62 });
      label.position.set(0.28, 0.16 + Math.floor((n - 1) / 2) * 0.13, 0);
      held.add(label);
      // Kept, because it is a CAPTION on a body and every other caption in the
      // game fades — see `fadeCrateLabels`. Stashed here rather than looked up
      // later: `weld` re-hangs the sprite somewhere inside the armful, so the
      // only moment it is a thing anybody holds a reference to is now.
      rec.carryTag = label;
    }
    // Welded, like stock and crops: an armful is up to `CARRY_SHOWN` little
    // models nailed to one another, and everybody in the shop is carrying one.
    // The label rides along untouched — `weld` re-hangs a sprite rather than
    // trying to merge it.
    const armful = weld(held);
    // In the HANDS, which is where `animateActors` puts them the moment there
    // is something to hold — see `armLift`. It used to sit at chest height and
    // a third of a tile out in front, on the reasoning that it should read as
    // carried rather than worn; what it actually read as was floating, because
    // the arms went on swinging behind it and nothing connected the two.
    armful.position.set(0, 0.50, 0.27);
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
   * ...and which of those two it is decides its PARENT, which is the third
   * thing and the one that was wrong. A bag is authored out at the hip, where
   * the hand is — so hung on the body it stood still while the arm carrying it
   * swung straight through it, four times a second, for the whole walk out of
   * the shop. `buildCharacter`'s `hold` groups are the fix and they cost this
   * nothing: their origin is the body's own, so the authored numbers are
   * unchanged and the bag simply rides the shoulder. A container held in FRONT
   * (a basket, a trolley — anything whose art sits near the centre line) stays
   * on the body, because it is held in both hands and swinging it off one
   * would be the same bug pointed the other way. `HAND_SIDE` is the line, and
   * it is measured off the built model rather than declared on the row: a kit
   * that moves to the other hip should not need a column filling in.
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
      // Its parent is whichever of the three it went on, so it is asked rather
      // than assumed — `rec.obj.remove` would silently leave a bag welded to a
      // hand for the rest of the visit.
      rec.kit.parent?.remove(rec.kit);
      disposeGroup(rec.kit);
      rec.kit = null;
      rec.kitHand = null;
    }
    if (!key) return;

    const bag = buildModel(model, { castShadow: false, t: fill });
    const mid = new THREE.Box3().setFromObject(bag).getCenter(new THREE.Vector3());
    const hold = rec.obj.userData.hold;
    const side = Math.abs(mid.x) >= HAND_SIDE ? (mid.x > 0 ? 'right' : 'left') : null;
    rec.kitHand = hold && side ? side : null;
    (rec.kitHand ? hold[rec.kitHand] : rec.obj).add(bag);
    rec.kit = bag;
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
   *
   * The flush goes on through `characterMaterial`, and that is a fix rather
   * than a tidy-up. It used to reach for `material()`, which is the FLAT-SHADED
   * cache the shop's props share — so the first frame this ran, every shopper's
   * head stopped being smooth and became a faceted ball, while the body beside
   * it stayed round. It fires for everybody with a patience number, `anger: 0`
   * included, so it was every shopper in the shop from the moment they walked
   * in, and what it read as is character art that had not been finished.
   *
   * `skin` rather than `head`, because the chin is part of the face: flushing
   * one of the two is a rash. `head` is kept for anything still asking.
   */
  /**
   * Every batched body's boxes into their instance buffers, once a frame.
   *
   * Last thing before the draw, and that ordering is the whole of it: the walk
   * rig is four rotations `animateActors` writes, the slump is a tilt
   * `animateRest` writes, and the position is eased by the chase — so a flush
   * taken any earlier is drawing where everybody was on the previous frame,
   * which reads as the crowd lagging a step behind its own feet.
   *
   * `updateMatrixWorld` is called per body rather than left to the renderer,
   * because the matrices are wanted HERE, before three has walked anything. It
   * is the same work either way — the rig is five empty groups.
   *
   * A body whose `visible` is false is parked rather than skipped. `showEye`
   * turns your own body off in first person, and an instance left where it was
   * would leave a headless shopper standing in the aisle you are looking out
   * of: there is no `visible` on an instance, so being invisible has to be
   * SAID, every frame, by writing a matrix that covers no pixel.
   */
  /**
   * Which way somebody answering a wave should be looking, or null.
   *
   * Off the DRAWN positions rather than off the snapshot, because both bodies
   * are eased toward the shop's answer every frame (`ACTOR_CHASE`) — a heading
   * computed from where the server last put them would lag the two of them by
   * up to a tick, which at walking pace is a shopper looking slightly past your
   * shoulder for the whole wave.
   *
   * `Math.atan2(dx, dz)` and not `(dz, dx)`: that is the sim's own spelling of
   * a facing (see `placeAt`), and it is what `syncActors` writes into
   * `rotation.y`. The other order is a quarter turn out, which draws as a
   * shopper waving at whoever is standing to your left.
   *
   * Null for anybody who is not answering anybody — an emote you made yourself
   * is aimed wherever you were already pointing — and null again if the person
   * they are answering has no body on screen, which is an ordinary state: they
   * can log out, or be the other player in a shop you have just joined.
   */
  facingToward(rec) {
    if (!rec.emote || !rec.emoteTo) return null;
    const at = this.players.get(rec.emoteTo);
    if (!at || at === rec) return null;
    const dx = at.obj.position.x - rec.obj.position.x;
    const dz = at.obj.position.z - rec.obj.position.z;
    // Standing on top of one another has no direction in it, and `atan2(0, 0)`
    // is 0 — which is a real heading, so it would snap them due north.
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return null;
    return Math.atan2(dx, dz);
  }

  flushCrowd() {
    let any = false;
    for (const map of [this.players, this.customers]) {
      for (const rec of map.values()) {
        const c = rec.obj?.userData?.crowd;
        if (!c) continue;
        any = true;
        const hidden = !rec.obj.visible;
        rec.obj.updateMatrixWorld(true);
        const pivots = rec.obj.userData.pivots;
        for (let i = 0; i < c.desc.parts.length; i++) {
          const p = c.desc.parts[i];
          const which = p.shadow ? 'cast' : 'flat';
          if (hidden) { this.crowd.hide(which, c.slots[i]); continue; }
          const parent = p.bone === 'body' ? rec.obj : pivots.get(p.bone).pivot;
          CROWD_M4.multiplyMatrices(parent.matrixWorld, c.locals[i]);
          this.crowd.setMatrix(which, c.slots[i], CROWD_M4);
        }
      }
    }
    if (any) this.crowd.flush();
  }

  animateMoods(now) {
    const t = now / 1000;
    for (const rec of this.customers.values()) {
      const anger = rec.anger;
      if (anger == null) continue;
      const c = rec.obj.userData.crowd;
      if (c) {
        // The same flush, said to an instance. A batched body has no head mesh
        // whose material could be swapped — `crowdRig` leaves `skin` empty for
        // exactly this reason — so the colour goes straight at the slot the
        // head was given. One write against the old path's material swap, and
        // it cannot tint anything else: an instance colour belongs to the
        // instance, where `characterMaterial` is a cache shared shop-wide.
        const head = c.desc.parts[c.desc.head];
        this.crowd.setColour(head.shadow ? 'cast' : 'flat', c.slots[c.desc.head],
          CROWD_COL.set(faceColor(anger)));
      } else {
        const skin = rec.obj.userData.skin ?? [rec.obj.userData.head].filter(Boolean);
        const mat = characterMaterial(faceColor(anger));
        for (const m of skin) m.material = mat;
      }
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
      // ...and `mouthSink` beside `beltBusy`, because HALF THE MOUTHS never lit
      // without it. A crate keeps the id of the cell it last left for the whole
      // of a long hop, so a box climbing out of the far end is still filed
      // against the near one and `beltBusy` has never heard of the exit. Which
      // reads as the light being broken rather than as one end of the pair
      // being unaddressable — the same reason `mouthSink` matches on where the
      // box physically is.
      const holding = this.beltBusy?.has(id) || this.mouthSink?.has(id);
      // A junction with one way out wears its own colour and keeps it, which is
      // the only lamp state here that is a SETTING rather than a report — see
      // `sortStraight`. It is asked FIRST and outranks everything below,
      // inverting the order the reject bar uses, and the difference is what the
      // two readouts are for: a reject side is a live junction's preference, so
      // a box that just went somewhere is the more specific answer, while this
      // says the machine cannot make a decision at all — and "what it last did"
      // about a machine that does nothing is exactly the reassuring green that
      // hid this for a whole save.
      const hue = this.sortStraight?.has(id) ? LAMP_DUD
        : body.mouth ? (holding ? LAMP_ON : LAMP_IDLE)
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
        // The reject side's own resting colour — see `sortReject`. It LOSES to
        // both of the above, which is the whole of how the two kinds of readout
        // sit together: a setting says where strays would go, an event says
        // where a box just went, and on the tick they are the same side the box
        // is the more specific answer.
        const rej = this.sortReject?.get(id);
        const side = Number.isInteger(rej) ? anchorTile(0, 0, rej) : null;
        // `rej` is in the key or a bar keeps whatever colour it was wearing
        // when the setting changed — and this is the one readout here that can
        // change with nothing else on the machine moving.
        const key = `${lit ? `${lit.dx},${lit.dz},${lit.hue},${mv?.n ?? ''}` : ''}|${rej ?? ''}`;
        if (body.pipLit !== key) {
          body.pipLit = key;
          for (const pip of body.pips) {
            const on = lit && pip.dx === lit.dx && pip.dz === lit.dz;
            const rejects = side && pip.dx === side.x && pip.dz === side.z;
            pip.mesh.material.color.set(on ? lit.hue : (rejects ? LAMP_REJECT : LAMP_IDLE));
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
      // Phase and ownership are authoritative; height is a local animation.
      // The piston and its one locked owner read the same locally interpolated
      // number for the full stroke.
      if (body.elevatorPiston) {
        const piston = body.elevatorPiston;
        const state = this.shaftState?.get(id) ?? null;
        const pos = state ? transitionPosition(state, t) : 0;
        strokePiston(piston, piston.lo + (piston.hi - piston.lo) * pos);
        if (state?.phase === 'carry' && state.owner) {
          const crate = this.deliveryProps.get(state.owner);
          if (crate) {
            crate.position.x = piston.platform.position.x;
            crate.position.z = piston.platform.position.z;
            crate.position.y = piston.y
              + ELEVATOR_PISTON_PLATFORM_H / 2 + ELEVATOR_PISTON_PAD_H;
          }
        }
      }
      // A tunnel mouth's carrier is wherever its box is.
      if (body.tunnelPiston) {
        const piston = body.tunnelPiston;
        const sunk = this.mouthSink?.get(id);
        // 0 is the bottom of the well, 1 is rail height, above 1 is a rise to
        // the duct measured in storeys. Unbounded upward on purpose: `crateY`
        // spends the same number on the same journey, and the two disagreeing
        // is the box floating off its own carrier.
        const want = sunk == null ? 1 : Math.max(0, 1 + sunk);
        // EASED ONLY WHEN NOTHING IS RIDING IT, which is what the paragraph
        // above always meant and what the code did not do. The empty return
        // has no crate whose number could carry it, so it is smoothed; a
        // LOADED stroke has one, and smoothing that is a second clock — the
        // exact thing this whole piece was rebuilt to stop having. What it
        // draws as is the platform trailing its own box, and the longer the
        // stroke the worse it looks, so a mouth that rises to the duct made a
        // lag that was survivable in a 0.27 well obvious over four metres.
        //
        // This is the lift's rule pointed the other way. There the shaft's
        // transition is authoritative and the crate is pinned to the platform;
        // here the crate's `deck` is authoritative and the platform is pinned
        // to it. Either way one number moves both.
        const riding = sunk != null;
        piston.at = piston.at == null || riding ? want
          : piston.at + (want - piston.at) * PISTON_SETTLE;
        const pos = Math.abs(want - piston.at) < 0.002 ? want : piston.at;
        piston.at = pos;
        // ...and ABOVE rail height the slope has to be `CEILING_Y`, because
        // that is the slope `crateY` climbs. Measuring the rise to the duct's
        // own track instead leaves the two a storey's worth of `deck.y` apart
        // by the top — parallel is the whole claim, and it is worth nothing if
        // only one of the two legs is.
        strokePiston(piston, pos <= 1
          ? UNDER_PISTON_LOW + (UNDER_PISTON_HIGH - UNDER_PISTON_LOW) * pos
          : UNDER_PISTON_HIGH + (pos - 1) * CEILING_Y);
        // The crate is NOT pinned to the platform here any more. It used to be,
        // because the box and the carrier were two clocks that had to be made
        // to agree; they read the same number now — `crateY` spends the same
        // fraction on the same stroke — so pinning it would be one of them
        // overwriting the other.
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

  /**
   * Only the things you are looking at say what is in them.
   *
   * Three kinds of caption, one band pair, because a caption is a caption: the
   * `x12` on a box in the yard, the same number on a box somebody has on their
   * shoulder, and the `x3` over an armful. The last two are the ones that had
   * nothing — `fadeCrateLabels` walked `deliveryProps`, which is boxes standing
   * on the ground, and a crate that got picked up therefore stopped fading in
   * the one place a shop has a dozen of them at once. What that reads as is the
   * fade working on the yard and giving up on the shop floor.
   *
   * See `LABEL_NEAR` for why. Three things about the shape of it.
   *
   * It is an OPACITY rather than a `visible` flag across the band, because a
   * caption that snapped on as you panned would read as the label popping into
   * existence — which is the one thing a readout must never do, since the
   * player's next question is what changed about the crate. Hidden outright
   * only at the far end, where there is nothing left to draw.
   *
   * The sprite's material is its OWN — `buildTextSprite` mints a canvas, a
   * texture and a material per label, which is why `disposeGroup` frees them —
   * so writing opacity here cannot reach any other label, and the `transparent`
   * flag it was built with is what makes the write mean anything.
   *
   * And it is asked of every crate every frame rather than only of the ones
   * that moved, because the thing that moves is the CAMERA: a box standing
   * still in the yard changes its answer the moment you pan away from it. It is
   * a distance and a compare per crate, on the same list `syncDeliveries`
   * already walks.
   */
  fadeCrateLabels() {
    // The zoom half is one number for the whole shop, so it is asked once and
    // multiplied in rather than recomputed per box. Either half at zero is
    // gone: they are two reasons not to draw a caption, not two votes.
    const zoom = this.legible(LABEL_VIEW_FULL, LABEL_VIEW_GONE);
    const fade = (tag, at) => {
      if (!tag) return;
      const lit = zoom && this.nearness(at.position.x, at.position.z, LABEL_NEAR, LABEL_FAR) * zoom;
      tag.visible = lit > 0.02;
      if (tag.visible) tag.material.opacity = lit;
    };
    // A box on a belt or inside a packer never had one — see `buildPallet`.
    for (const obj of this.deliveryProps.values()) fade(obj.userData.label, obj);
    // ...and the two a BODY wears, measured off the body rather than off the
    // sprite: both are children of the person, so their own `position` is an
    // offset from a shoulder and says nothing about where in the shop they are.
    for (const map of this.actorMaps()) {
      for (const rec of map.values()) {
        fade(rec.carryTag, rec.obj);
        fade(rec.haul?.userData.label, rec.obj);
      }
    }
  }

  /**
   * See THROUGH whatever is standing between the camera and the shop.
   *
   * The two faces of the building nearest the viewer hide the aisles behind
   * them, and the taller the walls the more they hide: at this pitch a wall
   * conceals about `h / tan(pitch)` of floor, so every centimetre added to the
   * silhouette is taken off the room. Which is why the walls could never grow —
   * not because a taller wall looks wrong, but because it eats the shop. Ghost
   * the near ones and the height is free.
   *
   * FADED RATHER THAN HIDDEN, and it was built the other way first, which is the
   * interesting part. Taking a wall away is the obvious implementation and it
   * makes every rule around it *finicky*: a wall that vanishes has to vanish for
   * a reason the player can feel, so the outer faces needed a facing test, the
   * partitions needed a per-line "is this actually between us" test, and each of
   * those pops as you turn or walk. The cost of being wrong is the whole wall.
   * At 15% the cost of being wrong is nothing — you can still see it is there,
   * you can see through it, and the room keeps its shape — so the rules
   * underneath get to be crude. That is the trade: a softer effect buys a
   * simpler rule, and the simpler rule is what stops it feeling fussy.
   *
   * The COPING fades with it, and it was held back at first — left solid so a
   * ghosted wall drew a hard line along its own top, on the reasoning that the
   * plan of the shop should stay readable. In a room you have leant right into
   * that line is not a plan, it is a solid bar hanging in the air across the
   * thing you zoomed in on, and it reads worse than the wall did: a wall you can
   * see through is obviously a wall, where a beam with nothing under it is
   * obviously nothing. What makes the outline idea work in a plan view is that
   * you can see the whole outline, and this only ever fires when you cannot.
   *
   * Read off the camera every frame rather than baked at build, because the view
   * turns: a set of walls chosen when the shop was laid out would come straight
   * back the moment somebody pressed Q, which is the shape of a bug rather than
   * of a decision. It is a dot product and a material compare per batch, and
   * there are a few dozen.
   *
   * ...and only while they are actually IN THE WAY, which is TWO tests and needs
   * both. `WALL_CUT_VIEW` is how closely you are leant in: pulled right out you
   * are looking at a building rather than into a room, the near walls are a
   * tenth of the screen and hide almost nothing. `WALL_GHOST_REACH` is WHERE you
   * are looking, and it is the one that was missing — leant in over the middle of
   * an empty shop floor, the far wall is still turned at you and still fades,
   * with nothing anywhere near it, which reads as the effect firing at random
   * because from where you are sitting it did. A wall has to be facing you, and
   * close to what you are looking at, and you have to be close enough for it to
   * matter. See `nearCamLook`.
   *
   * Three more things about which walls qualify.
   *
   * An INTERNAL wall goes too — cutting those is the ordinary answer in this
   * kind of game (the Sims calls it walls-down and has a button for it) — and it
   * goes wholesale, on the trade above. See `FACE_IN`.
   *
   * A wall with NOTHING TO SAY is never touched, and telling that apart from a
   * partition is the whole of `isPartition`. Both are a zero from `outSign`, and
   * one of them is every wall in a shop whose enclosure has come down, since
   * `computeIndoor` answers zero indoor cells rather than fewer (this file's own
   * third trap). Both-indoors fades; both-outdoors stays solid. Fold those two
   * together and knocking one hole in a wall turns the entire building to glass.
   *
   * The test is against `camOffset`, which is the direction from what is being
   * looked at TOWARD the camera — so a positive dot is a face turned at the
   * viewer. No epsilon: at a yaw where a wall is exactly edge-on the dot is zero
   * and it stays solid, which is right, since a wall seen end-on is a line.
   *
   * And FIRST PERSON keeps everything. The cutaway is a convention of the
   * overhead view — down at eye level the wall in front of you is the room.
   *
   * A ghosted wall casts no SHADOW while it is ghosted. Glass already works this
   * way for the same reason: three has no half-shadow (the map is a depth pass,
   * so a part casts fully or not at all whatever its opacity), and a wall you can
   * see straight through laying a hard black stripe across the aisle reads as a
   * wall that is still there and a renderer that has lost track of it.
   */
  ghostNearWalls() {
    if (!this.edgeGroup) return;
    const { x, z } = this.camOffset;
    const cut = !this.fpv && this.viewTiles() <= WALL_CUT_VIEW;
    for (const o of this.edgeGroup.children) {
      const f = o.userData.outward;
      if (!f || !o.userData.hue) continue;
      const ghost = cut
        && (f.always || f.fx * x + f.fz * z > 0)
        && this.nearCamLook(o.userData.spots, WALL_GHOST_REACH);
      // `material` is a cache keyed by colour and alpha, so both of these are
      // shared objects that already exist — this is an identity compare and an
      // assignment, never an allocation. Writing `.opacity` instead is the trap
      // named all over this file: that field belongs to every prop in the game
      // painted the same colour.
      const want = material(o.userData.hue, ghost ? WALL_GHOST : (o.userData.alpha ?? 1));
      if (o.material === want) continue;
      o.material = want;
      // Its OWN flag back, remembered the first time it is touched rather than
      // re-derived from the alpha. A coping never cast one, and a batch handed
      // "opaque, therefore casts" would start laying a shadow it has not laid
      // since the shop was built — a fade that leaves something DARKER behind it.
      o.userData.cast ??= o.castShadow;
      o.castShadow = !ghost && o.userData.cast;
    }
  }

  /**
   * How much of a readout is drawn at this distance from the middle of the
   * view: 1 inside `near`, 0 beyond `far`, straight line between.
   *
   * One function for both because it is one question — how near the thing you
   * are looking at is this — and two copies of it would drift the day either
   * band moved.
   */
  nearness(x, z, near, far) {
    const d = Math.hypot(x - this.camLook.x, z - this.camLook.z);
    return d <= near ? 1 : Math.max(0, (far - d) / (far - near));
  }

  /**
   * The other half of the same question, and the one that actually answers
   * zooming out: how legible a readout is at the zoom being drawn.
   *
   * `FRUSTUM / zoom` is how many tiles of shop are on screen top to bottom, and
   * `this.ortho.zoom` rather than `camZoom` because that is the eased value the
   * frame is being drawn through — read the wish instead and a readout snaps
   * away a third of a second before the view it belongs to has moved.
   */
  legible(full, gone) {
    const tall = this.viewTiles();
    return tall <= full ? 1 : Math.max(0, (gone - tall) / (gone - full));
  }

  /**
   * Is any of these cells within `reach` tiles of the middle of the view.
   *
   * The half of `ghostNearWalls` that is about WHERE you are looking rather than
   * how closely. Facing and zoom between them still fade a wall on the far side
   * of an empty shop floor — it is turned at you, and you are leant in, and it is
   * nowhere near anything you can see. Which reads as the effect firing at
   * random, because from where you are sitting it did.
   *
   * A whole batch fades if ONE of its cells qualifies, which is right rather than
   * approximate: a batch is one face of one building, so the cells in it are a
   * line, and half a wall fading is worse than all of it.
   *
   * Squared throughout and it breaks on the first hit, so the usual answer costs
   * a handful of multiplies. The list is deduped at build (`cellsOf`) because
   * the boxes are not: a painted wall is a dozen of them on every cell.
   */
  nearCamLook(spots, reach) {
    if (!spots) return true;
    const r2 = reach * reach;
    for (let i = 0; i < spots.length; i += 2) {
      const dx = spots[i] - this.camLook.x;
      const dz = spots[i + 1] - this.camLook.z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  /**
   * How many tiles of shop are on screen top to bottom.
   *
   * `this.ortho.zoom` rather than `camZoom` because that is the eased value the
   * frame is being drawn through — read the wish instead and everything keyed to
   * it jumps a third of a second before the view it belongs to has moved.
   */
  viewTiles() {
    return FRUSTUM / (this.ortho.zoom || 1);
  }

  /**
   * The thought bubbles, faded the same way — see `BUBBLE_NEAR` for why it is a
   * scale rather than an opacity, and why it may not touch `visible`.
   *
   * EVERY bubble in the game, which is six maps and one readout. A body's hangs
   * on the body, a bare board's stands in `actorRoot` at the unit's own tile,
   * and a ripe bed's and a full pen's ride an `overlay` group at theirs — so the
   * only thing that differs between them is where the distance is measured from.
   * Fading some and not others is worse than fading none: a room where the
   * shelves have gone quiet and the beds are still shouting reads as the fade
   * being broken rather than as a decision, and the six are the same sentence
   * about six subjects.
   *
   * The body maps are `ACTOR_MAPS` rather than `this.players`, and that is the
   * whole of what this got wrong for as long as it existed: `syncActors` hangs a
   * bubble on anything it draws, and the SHOPPER — the one body this feature is
   * actually about, the person stood in an aisle thinking about bread — is in
   * `this.customers`. So the fade worked perfectly on the hires, the shelves,
   * the beds and the pens, and the thing you zoomed out to get away from went on
   * shouting. Which reads as the fade not being implemented, because for the
   * only bubbles anybody was looking at it wasn't.
   *
   * `animatePlots` bobs a plot's bubble on the same frame, on `position` — the
   * two do not collide, and that is why this is a scale and not a hop.
   */
  fadeBubbles() {
    const zoom = this.legible(BUBBLE_VIEW_FULL, BUBBLE_VIEW_GONE);
    const scale = (obj, at) => {
      const p = at.position;
      const s = zoom && this.nearness(p.x, p.z, BUBBLE_NEAR, BUBBLE_FAR) * zoom;
      obj.scale.setScalar(s);
      return s;
    };
    /**
     * ...and where nothing else owns the flag, a bubble faded to NOTHING stops
     * being DRAWN rather than being drawn at nothing.
     *
     * A zero scale is invisible and costs exactly what a full-size one costs:
     * three walks the object, frustum-tests every mesh in it and submits the
     * draw, and the triangles are merely degenerate by the time the GPU sees
     * them. So the fade above was buying the look of a thought receding and
     * none of the saving — and it is invisible in the one way that matters,
     * because what you would be checking for is already not on screen. Measured
     * on a day-425 shop at 2pm with 80 shoppers in it: every actor bubble in
     * the building was at zero, 103 meshes, 7% of everything in `actorRoot`,
     * drawn every frame for nobody. `visible` is the one flag `projectObject`
     * short-circuits on, so this drops the walk along with the draw.
     *
     * `wantBubbles` is deliberately NOT in here and is the reason this is a
     * second helper rather than two more lines in the first: `syncWants` owns
     * that field, hides a bubble whose fixture has gone, and a frame loop
     * setting it back to true would draw a readout over a shelf that is not
     * there. See `BUBBLE_NEAR`, which says so. The threshold matches the shelf
     * tags' own (`lit > 0.02`) rather than testing zero, because `nearness`
     * eases and the last hundredth of a bubble is not a bubble.
     */
    const fade = (obj, at) => { obj.visible = scale(obj, at) > 0.02; };
    for (const rec of this.wantBubbles?.values() ?? []) scale(rec.obj, rec.obj);
    for (const map of this.actorMaps()) {
      for (const rec of map.values()) {
        if (rec.bubble) fade(rec.bubble, rec.obj);
      }
    }
    for (const rec of this.plotProps.values()) {
      if (rec.bubble) fade(rec.bubble, rec.overlay);
    }
    for (const rec of this.penProps.values()) {
      if (rec.bubble) fade(rec.bubble, rec.overlay);
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
    // Where the camera is, for the quarter of the backdrop that would otherwise
    // be standing in front of the shop. Here rather than on a camera event
    // because the yaw eases and the pitch is dragged — there is no one moment
    // the camera "moved" — and it is three floats.
    this.aimSurround();
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
    // ...and the camera follows the body that pass has just moved, rather than
    // the ten-times-a-second one the snapshot named. See `trackEye`. It has to
    // be here — after the chase and before the pose at the bottom of this
    // function — or the view is aimed at where the body was a frame ago.
    this.trackEye();
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
    /**
     * ...and what anybody's arms are saying, which is the one pass that runs
     * over the shoppers as well.
     *
     * AFTER `animateActors` and after the break loop above, and that ordering
     * is the whole of how it stays cheap: the walk has already written its
     * counter-swing into the arms and the slump has already settled the body,
     * so a pose is laid OVER both rather than fighting either. It is also
     * before `flushCrowd`, which is what puts a batched shopper's boxes where
     * their pivots now say they are.
     *
     * A body answering a wave turns to face THE PERSON who waved
     * (`emoteTo` → `facingToward`), and everybody else stays exactly as they
     * were. Squaring up to the camera was the first answer and it is subtly
     * wrong in a way that reads as broken: the view can be spun a quarter turn
     * at a time and it is nowhere near where you are standing, so a shopper
     * waving back would face out of the aisle rather than at you — and from
     * behind, what is behind one of these robots is a flat panel.
     *
     * You are the one body that never turns at all, because your facing is a
     * thing you steered and spinning it under a keypress would read as the
     * emote taking the controls off you.
     *
     * Stopped time skips it, exactly as the brushes above are skipped and for
     * the same reason: the shop expires an emote against `elapsed`, which a
     * paused world never advances, so a pose left running would be an arm that
     * goes up and stays up until somebody presses play.
     */
    /**
     * ...and the arms and the FACE, which are the two passes that run over the
     * shoppers as well.
     *
     * One loop for both, because they are the same list twice and the second
     * one is nearly free — `animateFace` quantises, so a body whose expression
     * has not moved costs an integer compare. Splitting them would be two
     * walks over every person in the shop, sixty times a second, to save
     * nothing.
     *
     * Stopped time skips both, exactly as the brushes above are skipped. A
     * paused shop with somebody blinking in it is a pause button that does not
     * look like it worked — and an emote is expired against `elapsed`, which a
     * paused world never advances, so a pose left running is an arm that goes
     * up and stays up until somebody presses play. The expression HOLDS rather
     * than resetting, which is what a paused face should do: nothing is
     * written, so what is on screen is the frame time stopped on.
     */
    if (!this.paused) {
      for (const [id, rec] of this.players) {
        animateEmote(rec, now, id === this.myId ? null : this.facingToward(rec));
        animateFace(rec, now);
      }
      for (const rec of this.customers.values()) {
        animateEmote(rec, now, this.facingToward(rec));
        animateFace(rec, now);
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
      const s = Math.sin(now / 1000 * 2);
      // A contour has no ring to scale — it is not an object in the scene, it
      // is a stencil the composite finds an edge in — so the beat is on the
      // WIDTH instead. `buildTargetMarker` already says an animator has to cope
      // with `userData.ring` being absent; this is the second thing it is
      // absent on, and the first that crashed rather than doing nothing.
      //
      // A fatter swing than the ring's, because the two are not the same
      // quantity: 3.5% of a frame drawn a metre across is a couple of pixels,
      // and 3.5% of an eleven-pixel band is a third of one.
      if (this.selectedMarker.userData.ring) {
        this.selectedMarker.userData.ring.scale.setScalar(1 + s * 0.035);
      } else if (this.selectedMarker.userData.mark) {
        this.ink.setMarkBeat(1 + s * 0.1);
      }
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
    // ...said for the frame that actually happened. See `gainFor`: the gains are
    // quoted per 60Hz frame, and the floors — which are a RATE — scale straight
    // with the length of the frame rather than compounding.
    const span = dt * EASE_HZ;
    const dz = this.camZoom - this.ortho.zoom;
    if (dz) {
      this.ortho.zoom = Math.abs(dz) < 0.002
        ? this.camZoom
        : this.ortho.zoom + dz * gainFor(ease.zoom, dt);
      this.ortho.updateProjectionMatrix();
    }
    // The first-person pitch, which is the yaw's opposite number and eases the
    // same way. `tilt` is 1 outside cinema, so this is an assignment there and
    // the branch costs a multiply.
    if (this.fpvPitch !== this.fpvAim) {
      this.fpvPitch = glide(this.fpvPitch, this.fpvAim, gainFor(ease.tilt, dt), ease.tiltMin * span);
    }
    // Swing round to the target corner, same easing idea as zoom and camLook.
    // A drag has already moved both, so this is a no-op while one is happening.
    const da = this.camYaw - this.camAngle;
    if (da) {
      this.camAngle = Math.abs(da) < 0.0005
        ? this.camYaw
        : glide(this.camAngle, this.camYaw, gainFor(ease.yaw, dt), ease.yawMin * span);
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
    // `EASE`, where the floor that fixes that is now on both cameras rather
    // than only on the recording one.
    this.camAim.copy(this.camTarget).add(this.camPan);
    if (ease.lookMin) {
      GLIDE_V.subVectors(this.camAim, this.camLook);
      const d = GLIDE_V.length();
      if (d > 1e-4) {
        const step = Math.min(d, Math.max(d * gainFor(ease.look, dt), ease.lookMin * span));
        this.camLook.addScaledVector(GLIDE_V, step / d);
      }
    } else {
      this.camLook.lerp(this.camAim, gainFor(ease.look, dt));
    }
    // Which lamps get a real light follows the camera, so it belongs here rather
    // than in the layout build. Cheap: it returns immediately until the view has
    // actually gone somewhere. What it lights is only ever the things that MOVE
    // — the ground is baked and sits on a layer these cannot reach, which is
    // what makes a pool that follows you acceptable again. See lights.js.
    this.lights.update(this.camLook);
    // Which boxes are near enough to say what is in them. Beside the lights for
    // the same reason and on the same input: it is a fact about where the view
    // is, so it belongs to the frame rather than to the 10Hz sync — a caption
    // that only faded ten times a second reads as flicker while you pan.
    this.fadeCrateLabels();
    this.fadeBubbles();
    // ...and the walls between you and the shop. Same input again — `camOffset`
    // is `camAngle` posed, and the ease above has just moved it.
    this.ghostNearWalls();
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
    // ...on whatever grid the map is on THIS frame, which is a constant until
    // the look is on and the span is fitted to the view. See `fitShadowSpan`.
    const texel = this.ink ? this.fitShadowSpan() : SHADOW_TEXEL;
    snapToShadowTexel(this.camLook, SUN_AT, texel);
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
    this.flushCrowd();

    const stale = (this.shadowTick++ % SHADOW_EVERY) === 0;
    const draw = stale || this.shadowDirty || this.shadowSlip > shadowSlipFor(texel);
    if (draw) { this.shadowSlip = 0; this.shadowDirty = false; }
    this.renderer.shadowMap.needsUpdate = draw;
    // The frame's draws start HERE — everything above is sync work that issues
    // nothing — so this is where the counters are cleared and the GPU's own
    // stopwatch is started. Both are wrapped round every path out of this
    // function, which is what `drawn` is for: there are two, and the early one
    // is the branch nobody has on (no ink), so a reset written after the `if`
    // would be right in testing and wrong in the game.
    this.renderer.info.reset();
    this.gpuClock.begin();
    if (!this.ink) {
      this.renderer.render(this.scene, this.camera);
      this.drawn();
      return;
    }
    // Everything the ink is drawn against is the same frame the game would have
    // drawn; what the pass adds is a second draw of it for the normals and one
    // fullscreen composite. Sized here rather than in `resize`, because the
    // drawing buffer is what the targets have to match and `setPixelRatio` is
    // free to disagree with `innerWidth` about what that is.
    this.renderer.getDrawingBufferSize(DRAW_SIZE);
    this.ink.setSize(DRAW_SIZE.x, DRAW_SIZE.y);
    // How far the eye is from what it is LOOKING AT, which is what the contour
    // fades against. Not `camera.position.length()`: that is a distance from
    // the world origin, so in a shop built at (22, 17) it would thin every line
    // in the game as you walked north.
    // `actorRoot` is everybody who walks — you, the crew, the shoppers, and
    // what they are carrying. It gets its outline and not its creases, which is
    // the one thing in the frame whose cost grows with how well the shop is
    // doing: a busy evening is ~1,100 more objects in the tree, walked and
    // drawn a second time for a normals buffer. See `Ink.render`.
    this.ink.render(
      this.scene, this.camera, this.camera.position.distanceTo(this.camLook), this.inkNoCrease,
      this.marksOn(),
    );
    this.drawn();
  }

  /**
   * The far end of the frame's drawing, and the only place the GPU timer may be
   * closed: a query left open is one the context carries until it dies, and it
   * refuses the next `beginQuery` outright — so an early return that skipped
   * this would not lose one sample, it would turn the clock off for the session.
   *
   * The poll comes after the close deliberately. See gpu-clock.js: asking for a
   * result the GPU has not reached stalls the CPU until it does, so the earliest
   * honest question is on a later frame, and putting the two calls in this order
   * makes that structural rather than something to remember.
   */
  drawn() {
    this.gpuClock.end();
    this.gpuClock.poll();
  }

  /**
   * How many objects are in the tree, which is the number `projectObject` walks
   * — every frame, and a second time for the normals pass.
   *
   * It is the honest measure of "this shop is heavy" in a way draw calls are
   * not: the crowd batch draws 54 shoppers in two calls and still puts ~1,100
   * objects in the graph for three.js to walk, cull and matrix-update, which is
   * exactly the cost `inkNoCrease` was introduced to dodge. A shop where draws
   * are flat and this number is climbing is a shop leaking groups.
   *
   * Walked rather than counted incrementally, because a counter maintained by
   * hand across every `add` and `remove` in a 13k-line file is a counter that is
   * wrong within a week — and being wrong is worse than being absent, since the
   * whole use of the figure is watching it not move. It is called four times a
   * second by the readout and nowhere else.
   */
  objectCount() {
    let n = 0;
    this.scene.traverse(() => { n += 1; });
    return n;
  }

  /**
   * Shrink the shadow frustum onto what is on screen, and say what texel that
   * leaves the map on.
   *
   * The map is a fixed number of texels however much ground it is asked to
   * cover, so the span IS the resolution: at ±30 for a view eleven tiles tall,
   * most of every texel is spent on ground nobody is looking at, and a PCF tap a
   * texel wide is then blurring six centimetres of wall. Fitted, it is the same
   * map over a third of the area — which is what makes a filtered shadow read as
   * HARD, and a banded look wants hard edges, so this is where they come from.
   *
   * The footprint is the ortho frustum laid on the ground: its height stretches
   * by the pitch, because a view tilted 40° off vertical sees further along the
   * ground than across it. First person gets the constant back — a perspective
   * frustum reaches the far wall, and there is nothing here to fit to.
   *
   * Quantised to `SHADOW_SPAN_STEP`, and that is the load-bearing half: the
   * snap grid in `snapToShadowTexel` is derived from the span, so a span that
   * slid continuously with the zoom would move the grid under the snap every
   * frame of a pinch. Which is precisely the shimmer the snap exists to remove,
   * arriving by the other door.
   */
  fitShadowSpan() {
    let span = SHADOW_SPAN;
    if (!this.fpv) {
      const half = FRUSTUM / 2 / Math.max(0.05, this.ortho.zoom);
      const across = half * Math.max(1, (this.renderer.domElement.clientWidth || 1)
        / (this.renderer.domElement.clientHeight || 1));
      const along = half / Math.max(0.2, Math.sin(this.camPitch));
      span = Math.hypot(across, along) + SHADOW_MARGIN;
      span = Math.min(SHADOW_SPAN, Math.max(SHADOW_SPAN_MIN,
        Math.ceil(span / SHADOW_SPAN_STEP) * SHADOW_SPAN_STEP));
    }
    if (span !== this.shadowSpan) {
      this.shadowSpan = span;
      const c = this.sun.shadow.camera;
      c.left = -span;
      c.right = span;
      c.top = span;
      c.bottom = -span;
      c.updateProjectionMatrix();
      // The map now covers different ground from the one already drawn, so the
      // one already drawn is of nowhere. A flag rather than `needsUpdate`,
      // because the cadence below writes that field last and would put this
      // straight back — which is a zoom whose shadows step two frames after the
      // shop, intermittently, depending on where the tick had got to.
      this.shadowDirty = true;
    }
    // ...and the self-shadowing bias with it, because it is a multiple of the
    // TEXEL and the texel just moved. This is the pair that must never come
    // apart: a constant here is a lattice of little triangles over every large
    // lit surface in the shop — most of a wall, at any zoom where the span has
    // grown past what the constant was picked for — and it reads as a texture
    // somebody applied rather than as a number nobody scaled.
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS_TEXELS * shadowTexelFor(span);
    return shadowTexelFor(span);
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
    this.sky?.texture.dispose();
    this.ink?.dispose();
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
 * ...and the fourth, which is the only one that is not an event.
 *
 * The three above are all things that just happened to a box. This one is a
 * SETTING — the side a junction has been told to send what nothing wants — so
 * it sits on its bar all the time rather than flashing, and it loses to both
 * lit states on the tick a box actually crosses that side.
 *
 * Violet because the three that mean something happened have the traffic-light
 * end of the wheel between them, and a fourth colour anywhere near amber would
 * be read as a dim pass. It is also deliberately quiet: every junction with a
 * reject line wears one permanently, so a bright one would be a shop full of
 * lights reporting nothing but its own configuration.
 */
const LAMP_REJECT = '#8f7ad6';

/**
 * ...and the fifth, which is the only one that reports a MISTAKE.
 *
 * A junction with fewer than two ways out has nothing to choose between: what
 * arrives carries straight on, and the piece is an expensive belt. It happens by
 * ordinary building — you lay the hub, mean to run the spur off it, and never do
 * — and there is nothing to see afterwards, because a sorter draws its blades
 * from `conveyorBranches` and one with none has a smooth roof. A live shop had
 * five of six like that, every box arriving correctly the whole time.
 *
 * RED, and it is the only red on a conveyor, which is exactly the argument
 * `LAMP_PASS` makes for not being one. A box carrying on down the line is the
 * ordinary way a run works and must not read as a fault; a junction that cannot
 * junction is a fault, it is the shop reporting something you got wrong, and it
 * is one press from fixed. The distinction those two colours draw is the whole
 * point of having both.
 *
 * It is also the one lamp state that is not a report of anything that happened,
 * so like `LAMP_REJECT` it sits there rather than flashing — but unlike it, it
 * OUTRANKS the live states instead of losing to them. "What it last did" about a
 * machine that does nothing is the reassuring green that hid this for a save.
 */
const LAMP_DUD = '#d4574a';

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
// ...and a packer, which wears the same housing for the same reason: it
// swallows a crate, so every side a box does NOT cross is walled in.
const COVERED_KINDS = new Set(['arm', 'sorter', 'packer']);

/**
 * WHAT MAY OWN A SHAFT UP THROUGH THE CEILING, besides a `lift`.
 *
 * A set rather than the pair of `kind !== 'arm' && kind !== 'sorter'` tests
 * this was written as, because those were a predicate against the only two
 * members a category had — and the third arrived as a tunnel mouth with its
 * `riser` on, which `conveyorNext` already answers with the cell overhead. It
 * got no basket, no hoist and no hole in the duct, so the toggle read as
 * having done nothing at all: the box rose out of a bare square into a pane of
 * glass it had no opening in.
 */
const ELEVATOR_OWNERS = new Set(['arm', 'sorter', 'under']);

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

/**
 * How near the middle of the view a crate has to be before it says what is in
 * it, in tiles: fully legible inside the first, gone by the second, faded
 * across the band between them.
 *
 * A crate NAMES its contents pile by pile, which is right about the box you
 * walked over to and wrong about the twenty behind it: every one of them is
 * shouting at the same volume, and the ones nearest the camera are drawn over
 * by the ones behind, so a full yard is a wall of overlapping captions with the
 * shop underneath it. Reading is the same thing `buildPallet` already refuses a
 * moving box for — a caption you cannot read is worse than no caption, because
 * it is also in the way.
 *
 * It is measured off `camLook` (the centre of the view) rather than off the
 * player, because what the label answers is "what is in that one", and the one
 * you mean is the one you are looking at — build mode flies the view away from
 * the body entirely.
 *
 * It is a WORLD radius, and on its own it does NOT answer zoom — which is what
 * the first cut of this got wrong, and the reason is arithmetic rather than
 * taste. A shop is about ten tiles across, so any radius wide enough to caption
 * the crate you walked up to already takes in the whole building: pull the view
 * right out and every box in the yard is still inside 7.5 tiles of the middle,
 * so nothing fades and the change reads as not having worked. What this radius
 * is good for is the case it was written for — a yard of thirty boxes seen from
 * close up — and that is all it is kept for. Zoom is `LABEL_VIEW_FULL`.
 */
const LABEL_NEAR = 4.5;
const LABEL_FAR = 7.5;

/**
 * ...and the half that DOES answer zoom, in tiles of view height — full while
 * the view is shorter than the first, gone once it is taller than the second.
 *
 * The honest criterion is not distance at all, it is how big the thing is on
 * screen. These are world objects under an ortho camera, so their screen size is
 * exactly proportional to `zoom` and nothing else — a caption two tiles from the
 * camera and one twenty tiles away are drawn the same size, which is why no
 * radius could ever have said this. `FRUSTUM / zoom` is that number said the way
 * a person would say it: how much shop is on screen top to bottom.
 *
 * The zoom the game opens at shows about 11.7 tiles, and the report this came
 * from is a screenshot at roughly that — so a caption has to be most of the way
 * gone there and back at a glance the moment you lean in. 8 and 12.
 *
 * A bubble had its own, WIDER pair on the argument that it is a picture rather
 * than a word, it survives being small, and finding the one bare shelf in a room
 * is a thing you do from across the room. It is tighter than a caption's now,
 * and the reason is that the argument was about ONE bubble: a shop has one or
 * two bare boards and a dozen shoppers, each thinking about something, so a band
 * generous enough to find a shelf from the door draws the whole crowd's shopping
 * list over the aisles at the zoom the game opens at. Below `BUBBLE_VIEW_GONE`
 * the opening zoom (~11.7 tiles) shows none of it and one notch in shows all of
 * it, which is the "lean in and ask" the fade is for.
 */
const LABEL_VIEW_FULL = 8;
const LABEL_VIEW_GONE = 12;
const BUBBLE_VIEW_FULL = 8;
const BUBBLE_VIEW_GONE = 11;

/**
 * How much shop has to be on screen before the near walls stop being scenery and
 * start being in the way — see `ghostNearWalls`, in tiles of view height.
 *
 * 5, which is a long way inside the zoom the game opens at (11.7) — about three
 * notches of the wheel past it. Anything looser and this fires while you are
 * still looking at a shop rather than at a shelf: the opening view is a whole
 * building with its walls round it and that is the picture you want, and a
 * cutaway that starts as soon as you touch the wheel reads as the building
 * falling apart rather than as the camera getting out of the way. At 5 tiles of
 * view height you are close enough that a wall genuinely is the thing in front
 * of what you came in to look at.
 *
 * It is the weaker of the two tests and always was: zoom says how closely you
 * are looking and says nothing at all about WHAT, so on its own it fades the
 * walls of a room you are nowhere near. `WALL_GHOST_REACH` is the other half.
 */
const WALL_CUT_VIEW = 5;

/**
 * How much of a wall is left when it is being seen through.
 *
 * Low, because a wall is not one layer: the body, a painted skin either side and
 * a course of brick on top of that are four boxes deep on the same line, and
 * transparency compounds — so 0.4 a band comes out very nearly solid on a wall
 * anybody has decorated. This is the number that keeps a plain wall a hint and a
 * painted one from being a pane of smoked glass.
 */
const WALL_GHOST = 0.15;

/**
 * How near the middle of the view a wall has to be before it counts as being in
 * the way, in tiles.
 *
 * A TILE COUNT and deliberately not a share of the screen, which is the opposite
 * call to the crate captions two constants up and is made for the opposite
 * reason. A caption is a thing you read, so what matters is how big it is drawn;
 * a wall is a thing that stands between you and somewhere, so what matters is how
 * far away it actually is. Scaled by zoom this would reach further the more you
 * pulled out, which is exactly backwards — the wide view is the one that wants
 * its building whole.
 *
 * 4, which is about an aisle and a half: near enough that a wall is genuinely
 * across what you are looking at, far enough that leaning into a corner fades
 * both walls of it rather than one.
 */
const WALL_GHOST_REACH = 4;

/**
 * The same band for the thought bubbles — what a shopper wants, and what an
 * empty board is waiting for — and it is WIDER than the labels' on purpose.
 *
 * They are the same complaint (the screenshot that prompted both is a room of
 * translucent balls with the shop behind them) and not quite the same question.
 * A crate's caption is text, so it is only worth drawing at the distance you
 * could read it; a bubble is a picture of an item, which survives being small,
 * and the thing it answers — *which* of these shelves is empty — is one you scan
 * a room for rather than walk up to. Fade it at the label's radius and the only
 * way to find a bare board is to stand in front of it, which is the state the
 * bubble exists to fix.
 *
 * Faded by SCALE rather than by opacity, which is the one thing here that is
 * forced rather than chosen: `bubbleMaterial` is a module-level singleton and
 * the icon inside comes out of `material()`'s shared cache, so an opacity
 * written on either reaches every bubble in the game and a good deal else
 * besides — see the note on `tufts` and `onBeforeCompile`. Shrinking is per
 * object, costs nothing, and reads as the thought receding.
 *
 * ...and it may never write `visible` FOR A SHELF'S BUBBLE, because `syncWants`
 * owns that field: it hides a bubble whose fixture has gone, ten times a
 * second, and a frame loop setting it back to true would draw a readout over a
 * shelf that is not there. Every other bubble — a shopper's, a bed's, a pen's —
 * has no second writer, so `fadeBubbles` does hide those once they have shrunk
 * to nothing, and the split between its two helpers is exactly this sentence.
 */
const BUBBLE_NEAR = 7;
const BUBBLE_FAR = 11;

/** Where the top of the track is — what a machine's side walls stand on. */
const BELT_TOP = 0.09;

/**
 * Where a packer stands the box it is building.
 *
 * The top of the authored tray — see `crateY`. It is a repeat of a number in the
 * `packer` fixture row, which is the one thing about this piece that is not
 * derived, and the reason is that a fixture's model is content and this is code:
 * the renderer cannot ask a row where its ledge is without inventing a `holds`
 * flag on a part, which is a whole authoring concept for one machine. The tell
 * if they drift is visible in one glance — the box floats over the lip, or sinks
 * through it.
 */
const PACKER_TRAY = 0.77;

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
/** The clear span from one side pane's centre-line to the other. */
const DUCT_SPAN = DUCT_HALF * 2;
const DUCT_PANE = 0.02;
/** The casing's outside width, including the thin side-pane itself. */
const DUCT_FLOOR = DUCT_SPAN + DUCT_PANE;
/** The small floor strip from that square to the edge of a conveyor cell. */
const DUCT_EDGE = (1 - DUCT_FLOOR) / 2;
/** A vertical arm wall runs from the centre casing to the cell boundary. */
const DUCT_ARM = 0.5 - DUCT_HALF;
const DUCT_WALL = 0.3;
/** Shared basket geometry for ordinary and machine-backed elevators. */
const ELEVATOR_BASKET_HALF = DUCT_HALF;
const ELEVATOR_BASKET_SPAN = ELEVATOR_BASKET_HALF * 2;
/** Clear square in the upper basket floor for the rising crate carrier. */
const ELEVATOR_OPENING = 0.42;
const ELEVATOR_BOX_TOP_H = 0.035;
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
const MACHINE_CAP_TOP = 0.63;
const ELEVATOR_BASKET_H = MACHINE_CAP_TOP - BELT_TOP - ELEVATOR_BOX_TOP_H;
/**
 * How much air the roof leaves over the tallest thing standing under it.
 *
 * Derived off the shaft rather than written down, for the reason `CEILING_Y` is
 * derived off the wall: a lift that grew would otherwise come up through the
 * roof, and the tell would be a machine poking into a surface only ever seen
 * from first person — where you are standing under it looking at the wrong side.
 */
const ROOF_CLEAR = 0.1;
/**
 * Where the ceiling hangs, measured to its UNDERSIDE.
 *
 * `CEILING_Y` has been called the ceiling since before there was one — it is
 * where a hung fitting hangs and where an overhead conveyor cell's model origin
 * sits — and it is emphatically not where a roof goes. A slab at 2.9 is a slab
 * UNDER the entire ceiling conveyor network: the ducts, the crates riding them
 * and the lift baskets all live above that line, so a ceiling hung there hides
 * every one of them, and hides them in the one view where the ceiling is drawn
 * at all. What that reads as is an overhead run you paid for and cannot find.
 *
 * So the roof clears the lot, and what falls out of that is the CLERESTORY: the
 * walls stop at 2.1 and this lands near 3.5, which leaves about 1.4 tiles of
 * open air between them — taller than a person. That band is the feature rather
 * than the offcut. It is what a warehouse, a supermarket and a station concourse
 * all actually look like, and it is what puts the ducts in silhouette against
 * daylight instead of flat against a lid. See docs/roof.md.
 */
const ROOF_Y = CEILING_Y + ELEVATOR_BASKET_H + ROOF_CLEAR;
/** How thick the slab is. Seen edge-on through the clerestory from outside, so
 *  it is a depth rather than a plane — a roof with no thickness is a sheet. */
const ROOF_SLAB = 0.12;
const ELEVATOR_OPENING_BORDER = 0.035;
const ELEVATOR_OPENING_BORDER_H = 0.018;
/**
 * ...and the doorway is the LID'S HOLE stood on its end.
 *
 * The same crate goes through both — in across the track, out up the shaft — so
 * one number is the whole of what either has to clear, and a door authored
 * separately is a second answer to a question with one.
 */
const ELEVATOR_PORTAL_H = ELEVATOR_OPENING;
const ELEVATOR_LID_BEZEL = 0.055;
const ELEVATOR_LID_BEZEL_H = 0.022;
const ELEVATOR_FACE_TRIM_D = 0.018;
const ELEVATOR_FACE_TRIM_H = 0.035;
/** The pane in a closed face, and its height is a FRACTION of the wall — a
 *  literal left behind by a taller housing is a porthole in a blank slab. */
const ELEVATOR_WINDOW_W = 0.56;
const ELEVATOR_WINDOW_H = ELEVATOR_BASKET_H * 0.7;
const ELEVATOR_TRACK_W = 0.26;
const ELEVATOR_TRACK_H = 0.03;
const ELEVATOR_PISTON_OUTER = 0.13;
const ELEVATOR_PISTON_INNER = 0.07;
const ELEVATOR_PISTON_OUTER_MAX = 0.72;
const ELEVATOR_PISTON_PLATFORM = ELEVATOR_OPENING - 0.07;
const ELEVATOR_PISTON_PLATFORM_H = 0.035;
const ELEVATOR_PISTON_PAD = 0.18;
const ELEVATOR_PISTON_PAD_H = 0.012;
const ELEVATOR_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/**
 * The two-stage carrier, built once for the two things that ride one.
 *
 * A shaft climbs to the ceiling and a tunnel mouth drops to its well, and they
 * are the same machine pointed opposite ways: a sleeve that extends first, a rod
 * that emerges out of it, and a platform with a pad on top. They were two, with
 * two sets of constants a hair apart (a 0.34 platform against a 0.35) and a
 * single thin post standing in for the sleeve down the well — which is the
 * trap `mouthSink` retired on the clock side, said about the geometry. `add` is
 * the caller's own: a shaft's hardware stands in `beltRoot` at world
 * coordinates, a mouth's hangs off the fixture group and turns with it.
 */
function buildPiston(add, frameMat, railMat, x, z, base, restY) {
  return {
    outer: add(frameMat, [ELEVATOR_PISTON_OUTER, 0.01, ELEVATOR_PISTON_OUTER],
      [x, base + 0.005, z]),
    inner: add(railMat, [ELEVATOR_PISTON_INNER, 0.01, ELEVATOR_PISTON_INNER],
      [x, base + 0.005, z]),
    platform: add(frameMat,
      [ELEVATOR_PISTON_PLATFORM, ELEVATOR_PISTON_PLATFORM_H, ELEVATOR_PISTON_PLATFORM],
      [x, restY, z]),
    pad: add(railMat, [ELEVATOR_PISTON_PAD, ELEVATOR_PISTON_PAD_H, ELEVATOR_PISTON_PAD],
      [x, restY + ELEVATOR_PISTON_PLATFORM_H / 2 + ELEVATOR_PISTON_PAD_H / 2, z]),
    base,
    y: restY,
  };
}

/** Where that carrier is, spent on the sleeve, the rod and the platform. */
function strokePiston(piston, y) {
  piston.y = y;
  const total = Math.max(0.01, y - ELEVATOR_PISTON_PLATFORM_H / 2 - piston.base);
  const outerH = Math.min(total, ELEVATOR_PISTON_OUTER_MAX);
  const innerH = Math.max(0, total - outerH);
  piston.outer.scale.y = outerH;
  piston.outer.position.y = piston.base + outerH / 2;
  piston.inner.visible = innerH > 0.002;
  piston.inner.scale.y = Math.max(0.002, innerH);
  piston.inner.position.y = piston.base + outerH + innerH / 2;
  piston.platform.position.y = y;
  piston.pad.position.y = y + ELEVATOR_PISTON_PLATFORM_H / 2 + ELEVATOR_PISTON_PAD_H / 2;
}

/** ON THE CELL CENTRE. Inset, a mouth that rises hands into the duct off the
 *  line — see `syncDeliveries`, where four blends used to pay for it. */
const UNDER_PISTON_X = 0;
/**
 * The shaft a mouth's carrier rides in, and the hole cut for it.
 *
 * `WELL_SPAN` is the clear opening, taken off the authored basket's own inner
 * faces (panes at ±0.26, 0.02 thick) — the art and the hole disagreeing is a
 * collar of floor standing over nothing or a shroud with daylight round it.
 * `WELL_HALF` is the outside of the liner, and therefore the size of the hole
 * `buildWorld` cuts in the floor slab and in the apron under it.
 */
const WELL_SPAN = 0.5;
const WELL_WALL = 0.05;
const WELL_HALF = WELL_SPAN / 2 + WELL_WALL;
const WELL_PAN_H = 0.03;
/**
 * The four pieces of floor slab left round a shaft, as `[dx, dz, w, d]`.
 *
 * Two full-width bands front and back and two short ones between them, which is
 * a square ring in four boxes rather than eight. A mouth's cell draws these
 * INSTEAD of its one tile — see `buildWorld`.
 */
const WELL_COLLAR = [
  [0, -(0.5 + WELL_HALF) / 2, 1, 0.5 - WELL_HALF],
  [0, (0.5 + WELL_HALF) / 2, 1, 0.5 - WELL_HALF],
  [-(0.5 + WELL_HALF) / 2, 0, 0.5 - WELL_HALF, WELL_HALF * 2],
  [(0.5 + WELL_HALF) / 2, 0, 0.5 - WELL_HALF, WELL_HALF * 2],
];
/**
 * The mouth's readout: ONE bar, on the back pillar, in MODEL space — `+x` is the
 * side facing the rail, the way the art is authored.
 *
 * `[x, z, along x, along z]`. It was four, one on each side of the cap, and four
 * lights saying the same thing is not four times the signal — it is a ring that
 * lights up whole, which reads as the colour of the piece rather than as a
 * readout. The pillar is the one side of the cap that is a machine rather than a
 * rail, so a lamp there is the thing you look at to see whether the tunnel is
 * running, and the other three sides go back to being the frame.
 */
const UNDER_LAMP_BARS = [
  [-0.30, 0, 0.09, 0.34],
];
/** Where a mouth's groove stops: the edge of the well, on the rail side.
 *  Anything further in is a rail drawn over its own open hole — which used to
 *  be a figure of speech and is a literal one now that the hole is cut. Not a
 *  second 0.30 beside `WELL_HALF`: the two drifting apart is a stub of rail
 *  hanging in mid-air over the shaft, or a lip of floor with no rail reaching
 *  it. */
const UNDER_DECK_LIP = WELL_HALF;
const UNDER_LAMP_H = 0.025;
const UNDER_LAMP_Y = MACHINE_CAP_TOP + 0.0105;
/**
 * Where a mouth's carrier RESTS, and it is the top of the rail beside it.
 *
 * It was 0.145, which stood the pad's face 0.09 proud of the track a box
 * arrives along — so a crate reaching the mouth climbed a step in the middle of
 * the machine, and then a second one back down on the way out. Flush, it slides
 * on, which is the whole of what a hand-over between a rail and a carrier is
 * supposed to look like.
 *
 * Said as the TOP and worked back through the pad and half the platform, since
 * `buildPiston` positions the platform by its centre — a literal here is two
 * thicknesses away from the number anybody is actually looking at, and it is
 * those two that quietly stop agreeing with it.
 */
const UNDER_PISTON_HIGH = BELT_TOP - ELEVATOR_PISTON_PAD_H
  - ELEVATOR_PISTON_PLATFORM_H / 2;
/**
 * How far a loaded carrier sinks, and it is measured off the CRATE.
 *
 * It was 0.265 — the depth of a well that was not drawn — and what a box does
 * over 0.265 is dip. Its goods stand about half a tile proud of it, so a crate
 * that had finished its descent still had the shopping in it above floor level
 * when `beltHidden` took the box away: a pile of groceries poking out of a
 * machine and then blinking out, which reads as the tunnel eating them. Deep
 * enough that the tallest thing a crate can hold is under the ground before the
 * span starts, and no deeper — every metre of this is a metre of hole.
 */
const UNDER_PISTON_DROP = 0.885;
const UNDER_PISTON_LOW = UNDER_PISTON_HIGH - UNDER_PISTON_DROP;
/** The pan the carrier retracts onto, clear of the crate that comes down on it. */
const UNDER_WELL_FLOOR = UNDER_PISTON_LOW - 0.1;
/**
 * How fast a mouth's empty carrier climbs back to rail height, per frame.
 *
 * Only the return is ever eased: a loaded stroke follows the box, which the
 * server is moving, so easing that would be the client second-guessing the
 * simulation. The return has nothing riding it and therefore no number of its
 * own — the same split `animateMotion` makes, and the same constant shape.
 */
const PISTON_SETTLE = 0.14;
/** One continuous square ring, with no four-bar transparency seams. */
function squareRingGeometry(outsideSpan, insideSpan, depth) {
  const outside = outsideSpan / 2;
  const inside = insideSpan / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-outside, -outside);
  shape.lineTo(outside, -outside);
  shape.lineTo(outside, outside);
  shape.lineTo(-outside, outside);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-inside, -inside);
  hole.lineTo(-inside, inside);
  hole.lineTo(inside, inside);
  hole.lineTo(inside, -inside);
  hole.closePath();
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
  });
  // Extrusion begins in XY and grows along +Z. Lay it flat in XZ and centre
  // its thickness on y=0 so callers position it like every other duct floor.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, depth / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/** One continuous glass floor ring; one mesh avoids transparent pane seams. */
const ELEVATOR_FLOOR_GEO = squareRingGeometry(
  DUCT_FLOOR, ELEVATOR_OPENING, DUCT_PANE,
);
/** Dark frame transferred from the basket perimeter to its carrier opening. */
const ELEVATOR_OPENING_BORDER_GEO = squareRingGeometry(
  ELEVATOR_OPENING + ELEVATOR_OPENING_BORDER * 2,
  ELEVATOR_OPENING,
  ELEVATOR_OPENING_BORDER_H,
);
/** Solid lid for the floor housing, open only around the rising carrier. */
const ELEVATOR_BOX_TOP_GEO = squareRingGeometry(
  DUCT_FLOOR,
  ELEVATOR_OPENING,
  ELEVATOR_BOX_TOP_H,
);
/** Raised tier-colour collar gives the otherwise flat lid a second step. */
const ELEVATOR_LID_BEZEL_GEO = squareRingGeometry(
  ELEVATOR_OPENING + ELEVATOR_LID_BEZEL * 2,
  ELEVATOR_OPENING,
  ELEVATOR_LID_BEZEL_H,
);
/** One-piece U-shaped doorway for each connected face of the floor housing. */
const ELEVATOR_PORTAL_GEO = (() => {
  const outside = ELEVATOR_BASKET_SPAN / 2;
  const inside = ELEVATOR_OPENING / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-outside, 0);
  shape.lineTo(-inside, 0);
  shape.lineTo(-inside, ELEVATOR_PORTAL_H);
  shape.lineTo(inside, ELEVATOR_PORTAL_H);
  shape.lineTo(inside, 0);
  shape.lineTo(outside, 0);
  shape.lineTo(outside, ELEVATOR_BASKET_H);
  shape.lineTo(-outside, ELEVATOR_BASKET_H);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: DUCT_PANE,
    bevelEnabled: false,
    steps: 1,
  });
  geometry.translate(0, 0, -DUCT_PANE / 2);
  geometry.computeVertexNormals();
  return geometry;
})();

/** ...and the collar an overhead loader drops its goods through. */
const DUCT_CHUTE = 0.34;
const DUCT_DROP = 0.34;

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
/** Compact square flow marker centred on each conveyor hand-over. */
const JOIN_PIP_SIZE = 0.04;
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
/** Size and centre offset of the two end markers on the run's axis. */
const END_PIP_SIZE = 0.16;
const END_PIP_OFFSET = 0.11;
/** Where the belt bed ends, and where carriers must stop before the marker. */
const END_PIP_OUTER = END_PIP_OFFSET + END_PIP_SIZE / 2;
const END_PIP_INNER = END_PIP_OFFSET - END_PIP_SIZE / 2;
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
/** Raycastable but completely absent from colour and depth output. */
const FIXTURE_PICK_MAT = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
  colorWrite: false,
});

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

/**
 * The conveyor map's two inks — see `Scene.setFlowOverlay`.
 *
 * Its own materials rather than `material()`'s cache, for one property that
 * cache cannot carry: `depthTest`. A map is a thing drawn ON the picture rather
 * than IN it, and the first version was in it — which cost the one thing the
 * map is for.
 *
 * It floated 0.75 up so the crates riding a run would not hide it, and at this
 * camera pitch 0.75 of height is most of a tile of SCREEN, up-screen, in a
 * direction that changes as you turn. So every node was drawn about a tile away
 * from the cell it was naming, and the whole overlay is a claim about which
 * cell. It is `pickFixture`'s note said about a diagram: a thing drawn above
 * the ground is not over the ground it is above.
 *
 * Sitting it down on the deck fixes the registration and hands back the
 * occlusion — a crate is taller than the ribbon. Turning the depth test off
 * gets both: it lies just above the belt, where the tiles say it is, and
 * nothing in the shop can stand in front of it.
 */
const FLOW_INK = {
  ok: new THREE.MeshBasicMaterial({
    color: new THREE.Color('#5fd0d8'), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  }),
  bad: new THREE.MeshBasicMaterial({
    color: new THREE.Color('#e2564a'), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  }),
  // A junction's reject side. Neither of the other two: it is not a fault and
  // it is not part of the run, it is a preference among the ways out.
  warn: new THREE.MeshBasicMaterial({
    color: new THREE.Color('#e8a33d'), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  }),
  /**
   * Everything the thing you picked has nothing to do with — see `flowFocus`.
   *
   * Drawn rather than hidden, and that is the whole of what makes a focus
   * readable: a map with the other runs taken out is a map of a shop you are
   * not in, so the lit route would have nothing to be shorter than and no
   * junction to visibly not take. Faint enough that the eye reads one figure
   * against a ground, dark enough that a grey run is still a run.
   */
  mute: new THREE.MeshBasicMaterial({
    color: new THREE.Color('#8a9aa0'), transparent: true, opacity: 0.2, depthTest: false, depthWrite: false,
  }),
};

function crateY(d, at) {
  /**
   * A packer's box stands on the TRAY, which is over the track rather than in
   * it.
   *
   * It rode at `BELT_DECK` first, on the reasoning that a machine holding a box
   * is holding it where a box on that machine would be — and that is exactly
   * wrong here for a reason no other piece has. A packer is a run cell, so the
   * crates it is NOT folding ride through the same square at the same height,
   * through the box it is building. Two crates in one space reads as the held
   * one being a ghost, or as the run being drawn wrong; either way the one thing
   * this piece is meant to show you — the box filling — is the thing you cannot
   * see.
   *
   * Matched to the authored tray, and it has to be: the number is in the
   * `packer` fixture row's model and here, and nothing checks they agree. A box
   * that floats over the lip or sinks through it is the tell.
   */
  if (d.packer) return PACKER_TRAY;
  if (!d.belt) return at * CRATE_STEP;
  // `CEILING_Y` is where an overhead cell's model ORIGIN sits, so the box rides
  // `BELT_DECK` above that — the same gap it rides above a belt on the floor,
  // because it is the same distance above the same tray. Lerping between the
  // two decks instead put the crate 0.1 too low all the way up and left it
  // sitting under the pan of its own duct at the top.
  const deck = d.deck ?? 0;
  // ...and BELOW the floor is a tunnel, where the storey is an address rather
  // than a distance. The span is one storey down to the simulation because that
  // is what makes it the lift's mechanism, and there is still nothing drawn
  // along it — so on screen the descent is the depth of the mouth's own well.
  // A box that really sank four metres would be four metres of hole nobody can
  // see into. What changed is that the well is now a real one: `buildWorld` cuts
  // it out of the floor and the apron, `attachTunnelPiston` lines it, and this
  // number is deep enough to put a loaded crate under the ground rather than
  // clipping it into solid earth.
  if (deck < 0) {
    return BELT_DECK - Math.min(1, -deck) * UNDER_PISTON_DROP;
  }
  return deck * CEILING_Y + BELT_DECK;
}

/** One client-side stroke, started once when the discrete state changes. */
function transitionPosition(state, now) {
  const u = Math.max(0, Math.min(1, (now - state.at) / state.duration));
  const eased = u * u * (3 - 2 * u);
  return state.from + (state.to - state.from) * eased;
}

/**
 * A fixture's record with the SIM STATE taken out of it.
 *
 * A layout record is not a description of a thing to draw — it is the shop's
 * own bookkeeping, and most of it moves every tick: a shelf carries its
 * `stacks` (prices, the day each pile last sold), an appliance carries the
 * batch it is running, a bed carries when it was sown and a pen carries how
 * full it is. None of that is drawn by the fixture's own group — stock, crops,
 * animals and ingredient rows are all props in `actorRoot`, put there by the
 * snapshot ten times a second — but every one of them is in the record, so a
 * key built out of the whole thing is a key that has never once matched.
 *
 * It is a DENY list rather than an allow list, and the direction is the whole
 * argument: a field left off an allow list is a fixture that stops redrawing —
 * silent, wrong, and permanent. A field left off this one is a cache that stops
 * hitting, which is slow and obvious. So when a new column turns up here, the
 * safe default is to leave it in the key and only take it out once you know
 * nothing in the fixture's own art reads it.
 */
const ART_IGNORES = new Set([
  'stacks', 'assigned', 'managed', 'dropped',   // a unit's goods, drawn in actorRoot
  'contents', 'lines',                          // an appliance's hopper and its batch
  'plantedAt', 'ready', 'yield',                // a bed's crop
  'qty', 'filledAt',                            // a pen's herd
]);

function artFields(f) {
  let out = '';
  for (const k of Object.keys(f).sort()) {
    if (ART_IGNORES.has(k)) continue;
    out += `${k}=${JSON.stringify(f[k])};`;
  }
  return out;
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
    ...(L.packers ?? []).map((k) => ({ ...k, kind: 'packer' })),
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
