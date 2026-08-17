/**
 * CLIENT ENTRY POINT — input, render loop, and glue.
 */

import {
  canPlaceEdges, edgeRun, canPaintGround, groundStroke, strokeThick, GROUND_STROKE_MAX,
  faceAlong, isProp, isWalkableTile, workSpotOf, REACH,
} from '../shared/build.js';
import { SOLID, edgeBetween } from '../shared/edges.js';
import { Scene } from './render/scene.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { RAIL_ITEMS } from './sections.js';
import { showFixture, refreshFixture } from './fixture-menu.js';
import { showWorker } from './worker-menu.js';
import { Menu, preselectedWorld } from './menu.js';

const canvas = document.getElementById('game');
const scene = new Scene(canvas);
const net = new Net();
const ui = new UI(net);
// The seed picker pins itself to a plot in world space, so it needs to project.
ui.scene = scene;

let latestState = null;

// The MCP `screenshot` tool ends up here: the server asks this tab to render
// its canvas to a PNG so an agent can see the change it just made.
net.onScreenshot(() => scene.screenshot());

// Handy in the browser console (and when an agent is poking at the page):
//   __sns.state          -> the last snapshot the server sent
//   __sns.scene          -> the renderer
//   __sns.net.send(...)  -> send a raw message
window.__sns = { net, scene, ui, get state() { return latestState; } };

net.on('layout', (m) => {
  scene.buildWorld(m);
  // The shop just re-flowed under the ghost, so whatever it was showing is
  // now judged against a different building.
  refreshGhost(true);
  // An open fixture menu has to follow its fixture through the re-flow — a
  // fixture that was turned comes back with a new id on the same tile.
  refreshFixture(ui, scene.allFixtures());
});
net.on('catalog', (m) => { scene.setCatalog(m); ui.setCatalog(m); });
net.on('state', (m) => {
  latestState = m;
  scene.syncState(m, net.myId);
  ui.update(m);
});
net.on('news', (m) => ui.toast(`📰 ${m.headline}`));
net.on('content-changed', () => ui.toast('New content added — it is live now'));
net.on('action', (res) => {
  if (res.ok) return;
  ui.toast(res.error, true);
  // A refusal arriving in the gap between pressing Move and the snapshot that
  // says you're carrying it means the lift didn't happen, and the mode the menu
  // was holding open for the carry has nothing left to hold it open for.
  ui.abortMove();
});
net.on('disconnected', () => ui.toast('Disconnected from the shop', true));

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
let lastInput = { dx: 0, dz: 0 };

addEventListener('keydown', (e) => {
  // Typing in the panel's search box is not walking. Without this, searching
  // the supplier for "carrot" walks you into a wall and buys a shelf.
  if (e.target.tagName === 'INPUT') return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  keys.add(k);

  // Every menu key is read off the same array the rail draws itself from, so a
  // new section is bound and labelled the moment it exists. Pressing the key of
  // the menu already open shuts it — the key that opened it has to close it.
  // Read off the same array the rail draws itself from, so a new menu is bound
  // and labelled the moment it exists — including the ones that are a bar rather
  // than a panel, which is why this walks RAIL_ITEMS and not just SECTIONS.
  const item = RAIL_ITEMS.find((s) => s.key === k);
  if (item) {
    e.preventDefault();
    if (item.mode) ui.toggleBuild();
    else if (item.bar) ui.toggleBar(item.bar);
    else ui.toggleSection(item.id);
  }

  // `G` used to be handled separately here, because Build was not on the array
  // this reads. It is (`BUILD_MODE`), and leaving both in toggled build mode
  // twice per press — on, then straight back off.

  // Spin the camera a quarter turn.
  if (k === ',') scene.rotateView(-1);
  if (k === '.') scene.rotateView(1);

  // The shutters and the clock. Not on RAIL_ITEMS with the menus, because
  // neither opens anything — they are the same press as the button in the HUD,
  // which is where the state they toggle is shown. Both ask for the opposite of
  // what the SERVER last said (`ui.shopOpen` / `ui.paused` are mirrors), so
  // holding the key cannot get ahead of the shop.
  if (k === 'o') ui.setOpen(!ui.shopOpen);
  if (k === 'p') ui.setPaused(!ui.paused);

  // The number row reaches the open tab of the bar, which is what keeps a
  // number meaning the button wearing it however much anybody adds to the
  // catalogue.
  //
  // With no bar up it used to pick a SEED, and that is the same trap build mode
  // documents as `paletteArmed`: a bar you cannot see is a mode you cannot see
  // you are in. There is no seed bar — sowing names its crop in the bed's own
  // menu — so `1` was an invisible press that silently changed what every bed
  // gets replanted with, to whichever crop happens to be first in the
  // catalogue, with no feedback of any kind. Nothing on screen moved, so it
  // presented as beds replanting themselves at random days later.
  if (k >= '1' && k <= '9' && ui.bar) ui.selectBuildToolByIndex(Number(k) - 1);
  // And Tab moves between tabs. Prevented hard: the default would walk focus
  // onto the search box, where the very next keypress types instead of playing.
  if (k === 'tab' && ui.bar) {
    e.preventDefault();
    ui.cycleBuildGroup(e.shiftKey ? -1 : 1);
  }
  // A selected fixture outranks the ghost, and is not gated on the mode: a
  // fixture menu opens without build mode, and `rotateSelected` borrows it the
  // way the Rotate button it stands in for does. With nothing selected the key
  // goes back to turning what you are about to place.
  if (k === 'r' && !ui.rotateSelected() && ui.buildOn) {
    ui.rotateBuild();
    refreshGhost();
  }
  // ...and M picks the selected one up, which is the Move button's key. Its own
  // binding rather than a rung on R's, because it has nothing to fall through
  // to: with nothing selected there is nothing to move, and a key that quietly
  // lifts whatever the pointer happens to be over is the proximity bug again.
  if (k === 'm') {
    const f = ui.selectedFixture();
    if (f) liftAimed(f, { reopen: false });
  }
  // Escape backs out one layer at a time. UI owns the whole ladder — an open
  // menu, then whatever you're carrying, then build mode — because two
  // listeners racing over one key means Escape closes a panel and quits build
  // mode in the same press.
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
});

// Where the pointer is, so the build ghost knows what it is being aimed at.
// `onCanvas` matters as much as the coordinates: the HUD floats over the world
// and swallows the clicks it covers, so a ghost or a target ring under an open
// panel would be promising something that cannot happen.
const pointer = { x: innerWidth / 2, y: innerHeight / 2, onCanvas: true };
addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.onCanvas = e.target === canvas;
  refreshGhost();
});

// ---------------------------------------------------------------------------
// Build ghost
//
// Validity is decided by shared/build.js — the same code the server runs on the
// click — so the preview can never promise something the server then refuses.
// ---------------------------------------------------------------------------

let ghostKey = null;

function refreshGhost(force = false) {
  // A wall tool previews the line under the pointer, not a tile. While a drag
  // is live the drag owns the ghost — it knows the whole run, this only ever
  // knows the one segment you are hovering. Same for a brush and its area.
  if (edgeDrag || floorDrag) return;

  // The bulldozer aims at a thing first and a line second. A shelf standing
  // against a wall covers the line behind it on screen, and "the wall" is never
  // what you meant while a whole fixture is under the pointer.
  const razing = pointer.onCanvas && ui.demolishArmed()
    ? scene.pickFixture(pointer.x, pointer.y) : null;
  if (razing) {
    scene.setEdgeGhost(null, null);
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    scene.setAimTarget(razing, 'raze');
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(razing);
    ui.setBuildVerdict(null);
    return;
  }

  const edgeKind = pointer.onCanvas ? ui.edgeKindForTool() : null;
  if (edgeKind !== null) {
    const seg = scene.pickEdge(pointer.x, pointer.y);
    if (!seg) { scene.setEdgeGhost(null, null); ui.setBuildVerdict(null); return; }
    const verdict = canPlaceEdges(scene.storeLayout, [seg], edgeKind);
    scene.setEdgeGhost([seg], verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no');
    ui.setBuildVerdict(verdict);
    scene.setAimTarget(null);
    ui.setBoardTip(null, null);
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(null);
    return;
  }
  scene.setEdgeGhost(null, null);

  // A brush previews the one cell under the pointer, so hovering already tells
  // you whether the ground will take it — the drag then previews the rectangle.
  // `undefined` is "this tool is not a brush"; the empty string is Bare Ground,
  // which is very much a tool.
  const brush = pointer.onCanvas ? ui.groundForTool() : undefined;
  if (brush !== undefined) {
    const cell = scene.pickTile(pointer.x, pointer.y);
    if (!cell) { scene.setFloorGhost(null, null); ui.setBuildVerdict(null); return; }
    const verdict = canPaintGround(scene.storeLayout, [cell], brush.kind, brush.piece || null);
    scene.setFloorGhost([cell], verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no');
    ui.setBuildVerdict(verdict);
    scene.setAimTarget(null);
    ui.setBoardTip(null, null);
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(null);
    return;
  }
  // Nothing is painting a cell — unless a pair of full hands is about to, in
  // which case the shopkeeping branch below owns this ghost and sets or clears it
  // itself. Skipped rather than clear-then-reset, because that pair is a dispose
  // and a rebuild of the mesh EVERY FRAME while you hover with an armful, and the
  // key cache exists precisely so a still pointer costs nothing.
  //
  // `dropping()` is false in every branch above this line by construction — the
  // brush and the wall tools need the palette, the bulldozer is its own veto — so
  // the guard cannot strand a ghost in a build tool's hands.
  if (!dropping()) scene.setFloorGhost(null, null);

  const kind = pointer.onCanvas ? ui.ghostKindForTool() : null;
  if (!kind) {
    if (ghostKey !== null || force) { ghostKey = null; scene.setBuildGhost(null); }
    ui.setBuildVerdict(null);
    // No ghost outside build mode, but still ring whatever is under the
    // pointer: a tap opens that thing's menu now, and a target you can click
    // with nothing marking it is a secret rather than a feature.
    //
    // Crates are in that "whatever" now, and they were the one thing you could
    // point at that nothing marked — which mattered least while a crate stood
    // alone on a pad and matters most now they stack: the ring at its own
    // height is how you know which one of a pile the tap would take. `pickAim`
    // weighs the two by distance rather than order, so a pendant lamp hanging
    // over the same tile no longer quietly owns the pointer.
    //
    // ...and outside build mode that lamp is not in the running at all — see
    // `aimable`. This is the branch that drew the ring on it, and a ring is a
    // promise: the tap it was advertising opened a menu of build verbs on a
    // thing you were not building.
    // A person outranks everything behind them, exactly as they do on the tap
    // (see the `pickPerson` branch there) — and until now the two disagreed in
    // the way that matters least on paper and most in the hand: the tap picked
    // them and nothing on screen ever said so. A hire is a third of a tile
    // wide, walking, on a shop floor full of things that DO light up, so the
    // one thing you have to point at to reach their menu was the only thing
    // that gave you nothing back for pointing at it.
    //
    // Only a hire. A customer is not selectable, and a marker is a promise that
    // a tap does something.
    const person = pointer.onCanvas && !ui.demolishArmed()
      ? scene.pickPerson(pointer.x, pointer.y) : null;
    scene.setPersonAim(person?.hire ?? null);
    // The other half of "you can press this", and the half that works before
    // you have looked down at their feet. The ring says which one; the cursor
    // says there is one at all.
    canvas.style.cursor = person?.hire ? 'pointer' : '';
    if (person?.hire) {
      scene.setAimTarget(null);
      ui.setBoardTip(null, null);
      ui.setAim(null);
      // A person is not a square, and this branch owns the ghost now (see the
      // guard above) — so pointing at a hire with your hands full has to put it
      // away rather than leave the last square lit.
      if (dropping()) scene.setFloorGhost(null, null);
      // ...and a person is not a shelf either. This branch returns before the
      // aim below is ever worked out, so without this the errand survives on
      // whatever the pointer left — the one path that could strand it.
      syncStockAim(null);
      return;
    }
    const aim = pointer.onCanvas && !ui.holding
      ? scene.pickAim(pointer.x, pointer.y, aimable) : null;
    // One pile of goods, when that is what is under the pointer — a cage round
    // the bread rather than a frame under the shelf. It is the promise half of
    // board aiming: the tap on it takes THAT board, so it has to be visible
    // which board the pointer has, and on a stocked unit the piles are only a
    // few pixels apart. The frame comes back the moment you point at the unit's
    // own frame, which is still the whole unit and still opens its menu.
    const board = aim?.board && boardTakes() ? aim.board : null;
    scene.setAimTarget(aim?.crate ?? aim?.fixture ?? null, 'aim', board);
    // ...and what that pile IS, which the cage cannot say. Off `aim.board`
    // rather than off `board`, so it is not gated on `boardTakes`: the cage is
    // a promise about a press and this is a label, and the moment you most want
    // to know what a board holds and how full it is, is with an armful in your
    // hands looking for somewhere to put it.
    ui.setBoardTip(shelfById(aim?.fixture?.id), aim?.board ?? null, pointer.x, pointer.y);
    // The other half of "you can press this", the way it is for a hire: the cage
    // says which pile, the cursor says there is one to take at all. A crate gets
    // no cursor because a crate is a whole object you can see you are on; a board
    // is a region of a thing that was one target until now.
    if (board) canvas.style.cursor = 'pointer';
    // Only the fixture: this names what a build verb would act on, and there is
    // no build verb that takes a crate.
    ui.setAim(aim?.fixture ?? null);

    // With goods in your hands, the square under the pointer is where they would
    // GO — so it is drawn, the same green cell the ground brush uses. Eight
    // squares are in reach and they are one tile apart on screen: the choice is
    // real (`Game.walkTo` places where you aimed rather than walking you onto it)
    // and without this it is invisible, which is the same as not having it. Red
    // says that square will not take a crate — a wall on the line, a shelf
    // standing on it, off the map.
    //
    // Beside the aim marker rather than instead of it, and it yields to it:
    // pointing at a shelf still rings the shelf, because that is a stock errand
    // and a different sentence. The ghost only ever claims bare ground.
    //
    // Set *or* cleared on every pass, because the guard further up stopped
    // clearing it for us — see there for why.
    const drop = dropping() && pointer.onCanvas && !aim?.fixture && !aim?.crate
      ? scene.pickTile(pointer.x, pointer.y) : null;
    const show = drop && inReachOf(drop);
    if (dropping()) {
      scene.setFloorGhost(show ? [drop] : null, show ? (canDropAt(drop) ? 'ok' : 'no') : null);
    }
    // ...and the unit under the pointer is the other half of the same sentence.
    // Sent from here rather than from the press, because the prompt is the thing
    // being fixed: a shelf you are standing beside said "Stock…" whether or not
    // you were pointing at it, and a prompt is a promise the hold will keep.
    syncStockAim(aim?.fixture ?? null);
    return;
  }
  const tile = scene.pickTile(pointer.x, pointer.y);
  if (!tile) {
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    ui.setBuildVerdict(null);
    scene.setAimTarget(null);
    ui.setBoardTip(null, null);
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(null);
    return;
  }

  // Past here something is armed to go DOWN — a piece off the palette or a
  // fixture in your hands — and while there is, nothing already standing is a
  // target. Pointing used to mean *that thing*, on the reasoning that a tile you
  // own is a menu rather than a red ghost telling you it is taken. True of the
  // tile and false of the SCREEN, and the gap between those two is the whole
  // bug: a hanging prop is drawn a good two tiles up-screen of the cell it
  // belongs to, so an existing panel light blankets the very floor you are
  // aiming the next one at. The ring lit the old one, the ghost went out, and
  // the tap opened a menu instead of placing — and aiming *round* what you have
  // already built is not a thing anybody can do.
  //
  // So the ghost owns the pointer for as long as there is one, and a tile that
  // really is taken says so in the ghost — red, with the reason — which answers
  // the same question without costing you the placement beside it.
  //
  // Cleared rather than skipped, or the last thing rung before you picked the
  // tool up keeps its ring for as long as the tool is up. A press-and-drag still
  // lifts a fixture (`drag.lift`): a drag is not a tap, it cannot fire by
  // accident, and it is the gesture everybody tries first for moving something.
  // The bulldozer is untouched too — it arms no ghost, so it never reaches here.
  scene.setAimTarget(null);
  ui.setBoardTip(null, null);
  scene.setPersonAim(null);
  canvas.style.cursor = '';
  ui.setAim(null);
  // Validity involves a flood fill, so only ask when something actually moved —
  // the camera tracks the player, so the tile under a still pointer drifts and
  // this runs from the render loop too.
  //
  // Which design is armed is part of "something moved": picking a second shelf
  // shape without moving the pointer changes what the preview should be, and a
  // key blind to it would hold the old model under your pointer.
  // Turn it to suit the tile it is over, unless you have turned it yourself.
  // Above the key rather than beside the spec, so the facing is part of what
  // "something moved" means — the ghost has to re-draw when the wall under it
  // changes its mind, and the tile alone would not say so.
  //
  // Its own answer is fed back in as the starting point, which is what makes it
  // sticky: ties go to the facing it already has, so out on the open floor it
  // returns what you gave it and sliding along a wall never spins.
  if (!ui.rotPinned) {
    ui.buildRot = faceAlong(
      scene.storeLayout,
      { kind, x: tile.x, z: tile.z, rot: ui.buildRot },
      {
        ignoreId: ui.holding?.id ?? null,
        // Carrying one is carrying a facing somebody already chose. Assist is
        // for a unit that has never stood anywhere; a moved one only turns when
        // its own angle would leave nowhere to browse it from. See `faceAlong`.
        keep: !!ui.holding,
      },
    );
  }
  const drawn = ui.ghostPiece();
  const key = `${kind}:${tile.x}:${tile.z}:${ui.buildRot}:${ui.holding?.id ?? ''}`
    + `:${drawn.piece ?? ''}/${drawn.variant}/${drawn.station ?? ''}/${drawn.tier}`;
  if (key === ghostKey && !force) return;
  ghostKey = key;
  const verdict = scene.setBuildGhost({
    kind, x: tile.x, z: tile.z, rot: ui.buildRot, moveId: ui.holding?.id ?? null, ...drawn,
  });
  ui.setBuildVerdict(verdict);
}

addEventListener('blur', () => keys.clear());

// ---- zoom -----------------------------------------------------------------
// Scroll the world to zoom. `deltaY` is not a unit anyone can rely on — a mouse
// notch is ~100 pixel-units, Firefox reports 3 *lines* for the same notch, and a
// trackpad streams small pixel deltas — so normalise by deltaMode first and cap
// the result, or one flick of a trackpad crosses the whole range.
const WHEEL_UNIT = { 0: 100, 1: 3, 2: 1 };   // pixels, lines, pages

// Leftover notch while the wheel is turning something rather than zooming. A
// rotation is a *quarter*, so unlike zoom it cannot take a fractional step: a
// trackpad streams a dozen small deltas per flick, and spending each one on a
// quarter turn spins the shelf three times before your fingers have stopped.
// Whole steps only, and the remainder is kept for the next event.
let rotWheel = 0;

canvas.addEventListener('wheel', (e) => {
  // Non-passive: without preventDefault the page scrolls (and on a Mac trackpad
  // a pinch, which arrives here as ctrl+wheel, zooms the whole browser instead).
  e.preventDefault();
  const steps = e.deltaY / (WHEEL_UNIT[e.deltaMode] ?? 100);
  // With something in your hands the wheel turns it. Deliberately gated on
  // `holding` rather than on build mode: the palette is a mode you sit in for
  // minutes and the view still has to move while you are in it, whereas an
  // armful is a sentence you are in the middle of — you are about to set this
  // thing down, and which way round it goes is the only question left. It also
  // puts the turn on the hand already aiming the ghost, which R never could.
  if (ui.holding) {
    rotWheel += steps;
    while (Math.abs(rotWheel) >= 1) {
      const dir = Math.sign(rotWheel);
      rotWheel -= dir;
      ui.rotateBuild(dir);
    }
    refreshGhost();
    return;
  }
  // Nothing held: the wheel is the zoom again, and a part-turn banked against a
  // fixture you have already put down must not be waiting for the next one.
  rotWheel = 0;
  scene.zoomBy(Math.max(-3, Math.min(3, steps)));
}, { passive: false });

// ---------------------------------------------------------------------------
// Tap to go, drag to look
//
// This used to be a drag-joystick: press anywhere, drag, steer analog. It was
// replaced rather than tuned, because two things were wrong with it that no
// amount of radius and deadzone fixes.
//
// It steered in *screen* space on a camera you can turn, so every quarter turn
// re-taught your thumb which way was forward — and the fix for that (rotating
// the vector by `scene.quarter`, still below for the keys) makes the controls
// correct without making them feel any less strange. And it put your thumb on
// top of the one thing you were trying to watch, which on a phone is most of
// the shop.
//
// So the player walks the way everybody else in the shop already walks: you
// name a destination and the server routes there (`walkTo`, A* on the same
// grid the customers use). That is not just a different input — it is what
// makes one tap do a whole errand, because pointing at a thing names it as well
// as routing to it. Tap a shelf, and you walk to the side you can work from and
// stock it, with no second input at all.
//
// ...and *only* that shelf. The naming is the load-bearing half: with an armful
// in your hands, walking down an aisle used to stock whichever unit your feet
// ended up nearest. See the Actions block in `server/sim/index.js`.
//
// Which leaves the drag free for the camera, and that is the other half of
// being playable on a phone: you can look somewhere before you go there. On a
// finger that is still a slide; under a mouse the same drag now turns the shop
// instead — see `drag.turns`.
// ---------------------------------------------------------------------------

/** Under this much travel, a press was a tap — a look, not a drag. */
const TAP_SLOP = 7;

/** ...and after this long without moving, it is a long press. */
const LONG_PRESS_MS = 420;

/**
 * Does a long press open what you are pointing at?
 *
 * No, currently: a tap opens a fixture again, so the hold has nothing left to
 * do that the tap does not already do sooner. Kept as a flag rather than
 * deleted because the gesture is still wired end to end — the aim ring still
 * winds in while you hold — and the reason it is off is a decision about what
 * a *tap* should mean, which has now changed three times.
 *
 * In build mode the hold has a job of its own regardless (`liftAimed`), and it
 * is the job the gesture was always shaped for: the ring winds in on the thing
 * you are pointing at, and at the end of it that thing is in your hands.
 */
const HOLD_OPENS = false;

const drag = {
  id: null,
  ox: 0, oy: 0,     // where it started, for the tap/drag verdict
  lx: 0, ly: 0,     // where it was last frame, for the pan delta
  ax: 0,            // ...and the anchor the turns are counted off, when it turns
  turns: false,     // does this drag turn the view, or slide it? See below.
  travel: 0,
  timer: null,
  pressedAt: 0,     // when it started, for the wind-in the frame loop draws
  done: false,      // a long press already fired; the release means nothing
  lift: null,       // the fixture this press would pull, once it moves
  moving: false,    // ...and it did: this drag is carrying something
};

/**
 * Are we stood close enough to work this thing without walking?
 *
 * `UNLOAD_REACH` from the server, spelled once. It is the one distance the
 * client has to know, and it is here for the same reason the build ghost shares
 * `shared/build.js` with the server: a reach worked out twice can disagree with
 * itself, and this one decides which of two messages a press sends.
 */
const UNLOAD_REACH = 1.8;
function inReachOf(at) {
  const me = ui.me();
  if (!me || !at) return false;
  return Math.hypot(me.x - at.x, me.z - at.z) <= UNLOAD_REACH;
}

/**
 * The last aim we asked for, and when — a damper, not a record of the truth.
 *
 * The truth is read back off the snapshot (see below). This only stops the same
 * sentence going out on every frame between the send and the snapshot that
 * reflects it, which at 60fps against a 10Hz world is six copies of it.
 */
let stockAsked = null;

/**
 * While your hands are full, the pointer owns which unit the goods are for.
 *
 * The ring winds off `p.errand` and `p.pressing` is one bit — a button is down,
 * and nothing about where. So an errand set by a tap stayed armed for as long as
 * you stood near the thing, and the shop went on saying "Stock…" over a shelf
 * you were not pointing at, on a prompt that a hold would have kept. Naming it
 * on the press fixed which shelf got the goods and left the *advertisement*
 * wrong, which is worse than it sounds: the prompt is the only thing that says
 * what the hold is about to do.
 *
 * So this is hover rather than press. Two things make that safe.
 *
 * It only ever *clears* a fixture you are **in reach of** — the test is on the
 * server (`Game.clearAim`), because only the server knows what the errand says.
 * That is what keeps the main stocking gesture alive: tapping a shelf across the
 * shop walks you there and names it, and your pointer is nowhere near it for the
 * whole of that walk. Out of reach is not a decision you are making.
 *
 * And it never touches a square, the pad, or a crate. Those are named by a
 * gesture you finished — `placeAt` off a press, a tap on the pad, `take` on a
 * box — and hover must not undo a decision somebody made on purpose.
 */
function syncStockAim(f) {
  if (!dropping()) { stockAsked = null; return; }

  // Only somewhere the goods would actually LAND. `takers` is the shop's own
  // answer — the same list the green pips are drawn from — and it is four facts
  // the client does not have: a freezer's cold, a shelf set aside for something
  // else, a label with stock still under it, how much room is left at this tier.
  //
  // It has to be asked here and NOT in `aimAt`, and the difference is the
  // gesture. A tap on a freezer is a decision, and a decision deserves to be
  // armed and then refused out loud — "bread needs a freezer" is the answer you
  // are owed for pointing at it. Hover is not a decision. A prompt that lights
  // up under a drifting pointer and then refuses is the green-ghost bug: the
  // shop offering something it has no intention of doing.
  const takers = ui.me()?.takers ?? null;
  const want = f && takers?.includes(f.id) && atWorkSpotOf(f) ? f.id : null;

  // What the shop is currently OFFERING, read back off the snapshot rather than
  // remembered here. That is the load-bearing bit: the errand can be set by
  // things this function never saw — a tap that walked you to a shelf, most of
  // all — so a local latch would sit at null, see no change, and never know
  // there was anything to clear. Reading it back means this self-corrects from
  // whatever state the shop is actually in.
  //
  // ...and only while it is in REACH, which is the same clause `clearAim`
  // applies on the other end and the reason the walk still works: crossing the
  // shop towards a shelf you named, the offer is not live yet, so there is
  // nothing here to disagree with and not one message goes out. It becomes live
  // as you arrive — which is exactly when where you are pointing starts to mean
  // something.
  const act = ui.me()?.action ?? null;
  const on = act ? scene.fixtureById(act.target) : null;
  const armed = on && atWorkSpotOf(on) ? act.target : null;
  if (want === armed) { stockAsked = null; return; }

  const now = performance.now();
  if (stockAsked && stockAsked.want === want && now - stockAsked.at < 300) return;
  stockAsked = { want, at: now };
  net.send('place', want ? { fixture: want } : { clear: true });
}

/**
 * ...and the same question about a fixture, which is a different distance to a
 * different point.
 *
 * `inReachOf` measures to a crate or a square, which are things you stand *at*.
 * A unit is worked from its side, so the sim measures `REACH` to `workSpotOf` —
 * and this press is refused by that test on the other end (`Game.aimAt`). Asking
 * a looser question here is the green-ghost bug said with a toast: a press that
 * looked legal, sent, and came back red. Both halves import the same two names.
 */
/**
 * ...and the third distance, which is the one `unshelve` actually measures:
 * `near(p, shelf)`, to the unit itself, at `REACH`.
 *
 * Neither of the two above is it. `inReachOf` is `UNLOAD_REACH` (1.8) and would
 * fire a tap the shop refuses by two tenths of a tile — a red toast for pressing
 * a loaf — and `atWorkSpotOf` measures to the side you work it from, which is a
 * different point again. It decides which MESSAGE a tap is, the way the crate's
 * reach test does, so it has to be the same question the verb asks.
 */
function nearFixture(f) {
  const me = ui.me();
  if (!me || !f) return false;
  return Math.hypot(me.x - f.x, me.z - f.z) <= REACH;
}

function atWorkSpotOf(f) {
  const me = ui.me();
  if (!me || !f) return false;
  // The same fallback `Game.reachSpots` makes, and for the same reason: a bed
  // and a decoration have no working spot, so the thing itself is the answer.
  const spots = ui.spotsFor(f);
  const at = spots.length ? spots : [workSpotOf(f)];
  return at.some((s) => Math.hypot(me.x - s.x, me.z - s.z) <= REACH);
}

/**
 * The crate under the pointer, plus whether it is in a pile.
 *
 * The crate is `Scene.pickPallet`'s own answer and deliberately nothing else:
 * **the box you pointed at is the box you get**, buried or not. A pile is four
 * separate things you can see, the ring already says which one the ray met at
 * its own height, and resolving the aim "up to the top of the stack" — which one
 * cut of this did — takes away the only way there is to say which crate you
 * meant. `liftCrate` lifts whichever one you named; the boxes above settle.
 *
 * What the pile decides is not *which* crate but *what a crate is*: on its own
 * it is a container you can reach into, and in a pile it is a box and nothing
 * else, because one unit out of a band of a dozen pixels is never the tin
 * anybody meant. So `stacked` rides along for the gesture to read. Worked out
 * here rather than sent, since it is a fact about `deliveries` the client
 * already has ten times a second.
 */
/**
 * Would the goods in your hands land on this square?
 *
 * The preview half of the rule `Game.walkTo` now applies: a square within reach
 * is somewhere to put things, so the ghost is what says *which* square before you
 * commit — eight of them are in reach and they are a tile apart on screen.
 *
 * Every clause is the server's own test, spelled with the shared functions rather
 * than re-derived — `isWalkableTile` is what `isWalkable`'s grid is built from
 * (ground takes a person AND nothing is standing on it) and `edgeBetween` is the
 * wall on the line that a tile test cannot see. A green square the server then
 * refuses is worse than no square at all, which is why a square that already has
 * a crate on it is **not** ruled out: `dropGoods` tops up a box of the same thing
 * and stacks anything else, and a pile is a thing you can peel now.
 */
/**
 * Are we holding goods, with nothing else claiming the pointer?
 *
 * The one test behind the drop ghost and behind who owns the floor ghost this
 * frame. Full hands are the whole of it — the three exclusions are the states
 * where pointing at the ground already means something else: the palette places,
 * the bulldozer aims, and a fixture in your hands is looking for a home of its
 * own.
 */
const dropping = () => (myCarry() || myHaul())
  && !ui.paletteArmed && !ui.holding && !ui.demolishArmed();

function canDropAt(tile) {
  const L = scene.storeLayout;
  if (!L || !tile || !inReachOf(tile)) return false;
  if (!isWalkableTile(L, tile.x, tile.z)) return false;
  const me = ui.me();
  if (!me) return false;
  return !SOLID.has(edgeBetween(L, Math.round(me.x), Math.round(me.z), tile.x, tile.z));
}

function aimCrate(cx, cy) {
  const hit = scene.pickPallet(cx, cy);
  if (!hit) return null;
  const x = Math.round(hit.x);
  const z = Math.round(hit.z);
  const pile = (ui.state?.deliveries ?? [])
    .filter((d) => Math.round(d.x) === x && Math.round(d.z) === z);
  return { ...hit, stacked: pile.length > 1 };
}

function clearLongPress() {
  if (drag.timer) clearTimeout(drag.timer);
  drag.timer = null;
}

function endDrag() {
  clearLongPress();
  drag.id = null;
  drag.lift = null;
  drag.moving = false;
  release();
}

/**
 * Let go of the button, as far as the shop is concerned.
 *
 * Nothing in the game fires without this being down — see `Game.stepActions`.
 * It is sent from exactly two places, `hold()` and here, and `endDrag` is
 * reached by every way a press can end (release, cancel, pinch, blur, a
 * right-button abort mid-run). One exit is the whole design: a stuck `true` is
 * a shop that goes back to doing things you did not ask for, which is the
 * behaviour this replaced, and it would be intermittent.
 *
 * Idempotent, so the paths that overlap can all call it without counting.
 */
function release() {
  if (!held) return;
  held = false;
  net.send('press', { down: false });
}

/**
 * ...and press it. Guarded the same way for the same reason.
 */
function hold() {
  if (held) return;
  held = true;
  net.send('press', { down: true });
}

/** Mirrors what the server thinks, so neither edge is sent twice. */
let held = false;

/**
 * Two fingers: pinch to zoom, twist to turn.
 *
 * The twist is not a nicety. Turning the view is how you see behind a shelf,
 * and until now it was `,` and `.` — which a phone does not have — so every
 * back aisle was permanently hidden on the device this whole scheme is for.
 *
 * It steps in quarters like every other way of turning, so `scene.quarter`
 * stays the integer that WASD and fixture facing are read through.
 */
const touches = new Map();
let pinch = null;

/** Radians of twist per quarter turn. Deliberately more than a wrist wobble. */
const TWIST_STEP = 0.6;

function twoTouches() {
  const [a, b] = [...touches.values()];
  return a && b ? [a, b] : null;
}

function beginPinch() {
  const t = twoTouches();
  if (!t) return;
  const [a, b] = t;
  pinch = {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

function stepPinch() {
  const t = twoTouches();
  if (!t) return;
  const [a, b] = t;
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);

  // Spreading scales the zoom by the same ratio the fingers moved, so the
  // ground keeps pace with them instead of being fed notches meant for a wheel.
  if (pinch.dist > 8 && dist > 8) scene.zoomByFactor(dist / pinch.dist);

  // Wrapped into (-π, π] before it is believed: without this, a twist across
  // the -π/π seam reads as a full turn the other way and the shop spins.
  let d = angle - pinch.angle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) >= TWIST_STEP) {
    // Same sign as the right-drag: the world follows your hands.
    scene.rotateView(-Math.sign(d));
    pinch.angle = angle;
  }
  pinch.dist = dist;
}

function dropTouch(id) {
  touches.delete(id);
  // One finger left is not half a pinch — it is a finger resting on the glass.
  // Ending the gesture here rather than promoting it to a drag is what stops
  // lifting one finger from a zoom flinging the camera across the shop.
  if (pinch && touches.size < 2) pinch = null;
}

// ---------------------------------------------------------------------------
// Turning the view by dragging
//
// Either button, on a mouse: a drag turns the view and a click means what a
// click on that button always meant — the left one taps the world, the right
// one backs out. Which is why the two buttons still differ at all, and why the
// spin can never be folded into the drag: what a press *ends* in is the whole
// difference between them, and only the moves in the middle are shared.
//
// It fires `rotateView` in whole quarters rather than orbiting freely,
// because `scene.quarter` is an integer everything else reads — WASD is
// remapped through it, and so is which way a fixture faces. A camera resting
// between two corners would leave "up" pointing at nothing in particular.
//
// The world follows your hand: drag right and the shop turns right, which is
// `,`. Easing is already in the renderer, so a fast flick across three steps
// still arrives as one smooth swing.
// ---------------------------------------------------------------------------
const SPIN_STEP = 90;         // px of drag per quarter turn

let spin = null;

/**
 * Turn a horizontal drag into whole quarter turns, and hand back the anchor to
 * carry on from.
 *
 * The anchor walks along with the turns rather than the whole distance being
 * re-read, so a drag out and back turns the same number of times each way, and
 * one flick past three steps fires three of them.
 *
 * Shared by both buttons on purpose. The left drag turns the view as well now,
 * and two copies of an accumulator are two things that can disagree about which
 * way a shop spins — which is the sort of difference nobody would ever think to
 * look for, because each button feels right on its own.
 */
function stepTurn(anchor, x) {
  let turned = false;
  for (let dx = x - anchor; Math.abs(dx) >= SPIN_STEP; dx = x - anchor) {
    const dir = Math.sign(dx);
    scene.rotateView(-dir);
    anchor += dir * SPIN_STEP;
    turned = true;
  }
  return { anchor, turned };
}

// ---------------------------------------------------------------------------
// Drawing a wall
//
// With a wall tool up, a drag draws instead of steering. That is a real mode
// change and it is deliberate: everywhere else drag-to-walk is sacred, but a
// wall is a *run*, and clicking twelve times to fence off a back room is not a
// thing anybody would do twice. The tool you picked is the consent.
// ---------------------------------------------------------------------------
let edgeDrag = null;

/** The segments a drag from its start to the pointer would lay, and its far end. */
function edgeDragRun(cx, cy) {
  if (!edgeDrag) return { segs: [], to: null };
  // How far along the run's own axis the pointer has got. Read off the tile
  // rather than off `pickEdge`, which answers "which line" — the wrong question
  // once the line is already chosen.
  const tile = scene.pickTile(cx, cy, 0.55);
  const to = tile ? (edgeDrag.start.o === 'v' ? tile.z : tile.x) : null;
  return { segs: edgeRun(edgeDrag.start, to), to };
}

function showEdgeDrag(cx, cy) {
  const { segs, to } = edgeDragRun(cx, cy);
  if (!segs.length) { scene.setEdgeGhost(null, null); return null; }
  const verdict = canPlaceEdges(scene.storeLayout, segs, edgeDrag.kind);
  const state = verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no';
  scene.setEdgeGhost(segs, state);
  ui.setBuildVerdict(verdict);
  // `to` is where the POINTER is, not the tail of the run — the same
  // distinction `showFloorDrag` makes about its far corner, and the wall drag
  // spent longer getting it wrong. `edgeRun` emits lowest-index-first whichever
  // way you dragged, so the last segment is the far end only when you dragged
  // towards increasing x or z; the other way round it is the segment you
  // STARTED on, and sending it asks the server for a run of exactly one.
  return { segs, verdict, to };
}

// ---------------------------------------------------------------------------
// Painting a floor
//
// The third drag. A wall is a run along a line and a floor is a rectangle over
// an area, which is a different shape but the same argument: laying a back room
// one square at a time is not a thing anybody does twice, and the tool you
// picked is the consent for the drag to stop steering the camera.
//
// Deliberately its own state rather than a mode on `edgeDrag`. They aim at
// different things — a lattice line versus a floor square — and the one place
// they would have to differ is the one place a shared implementation would keep
// getting it wrong.
// ---------------------------------------------------------------------------
let floorDrag = null;

function showFloorDrag(cx, cy) {
  if (!floorDrag) return null;
  const to = scene.pickTile(cx, cy);
  // The same call the server makes, with the same width rule — a road is two
  // cells thick whatever you dragged, and a ghost that showed one would be a
  // preview of a road nobody is going to get.
  const cells = groundStroke(floorDrag.start, to, GROUND_STROKE_MAX,
    strokeThick(floorDrag.kind), scene.storeLayout);
  if (!cells.length) { scene.setFloorGhost(null, null); return null; }
  // The empty string is Bare Ground, which is a real choice; null is what
  // `canPaintGround` reads as "take it up".
  const verdict = canPaintGround(scene.storeLayout, cells, floorDrag.kind, floorDrag.piece || null);
  const state = verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no';
  scene.setFloorGhost(cells, state);
  ui.setBuildVerdict(verdict);
  // `to` is where the pointer is, not the last cell of the rectangle. Those are
  // the same corner only when you drag down and right — the other way round the
  // list still comes out lowest-first, so sending its tail would send the corner
  // you started on and paint one square.
  return { cells, verdict, to };
}

// ---------------------------------------------------------------------------
// One press, three meanings, told apart by distance and time
//
//   moved       -> a pan. The camera comes off the player and stays there.
//   still, brief-> a tap. Walk there, or place there in build mode.
//   still, held -> a long press. Open what you are pointing at.
//
// The long press is free: actions charge on proximity, so nothing on the world
// wanted a held finger any more. It is also the gesture a phone already uses
// for "tell me about this", which is exactly what the fixture menu is.
// ---------------------------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) {
    // Mid-run, the right button takes back the run rather than turning the
    // camera. You are four tiles into a wall you have changed your mind about,
    // and `endPress` with no event drops it without sending. This used to live
    // on `contextmenu`, which is too late on Windows — that event fires on
    // *release* there, by which point the pointerup below has already built it.
    if (edgeDrag || floorDrag) { endPress(); return; }
    // A mouse reuses one pointerId for every button, so a right press during a
    // left drag would hand the spin that drag's own id and steal its moves.
    if (drag.id !== null) return;
    spin = { id: e.pointerId, ax: e.clientX, turned: false };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0 || spin) return;

  // A second finger is a pinch, never a walk. Hand the gesture over whole:
  // whatever the first finger had started is abandoned rather than finished,
  // or spreading two fingers to zoom also sends you walking to wherever the
  // first one happened to land.
  if (touches.size >= 1 && e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    endDrag();
    beginPinch();
    return;
  }
  if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // A wall tool takes the drag before the camera sees it — unless the
  // bulldozer is up and there is something standing where you pressed, which is
  // a tap on that thing rather than the start of a run along the wall behind it.
  const ek = ui.demolishArmed() && scene.pickFixture(e.clientX, e.clientY)
    ? null : ui.edgeKindForTool();
  if (ek !== null) {
    const start = scene.pickEdge(e.clientX, e.clientY);
    if (start) {
      edgeDrag = { start, kind: ek, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      showEdgeDrag(e.clientX, e.clientY);
      return;
    }
  }

  // ...and a brush takes it the same way, over an area rather than a line. It
  // aims with `pickTile` because it is painting the ground itself — using
  // `pickFixture` here would let you tile the roof of a shelf.
  const brush = ui.groundForTool();
  if (brush !== undefined) {
    const start = scene.pickTile(e.clientX, e.clientY);
    if (start) {
      floorDrag = { start, kind: brush.kind, piece: brush.piece, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      showFloorDrag(e.clientX, e.clientY);
      return;
    }
  }

  drag.id = e.pointerId;
  drag.ox = drag.lx = drag.ax = e.clientX;
  drag.oy = drag.ly = e.clientY;
  // ...and the fourth drag: a fixture, pulled to where it should be instead.
  //
  // This is what a press on a thing you own means once the mode says you are
  // building, and it is the gesture everybody tries first — press the lamp, pull
  // it over there, let go. Without it the press was a camera turn, so the shop
  // spun under the thing you were trying to pick up, which reads as the move
  // feature fighting the view.
  //
  // Only *armed*, not lifted. The press has not chosen yet: release without
  // moving and it is still a tap, which opens the menu the way it always did.
  // The lift happens at the slop line, where a pan would have committed.
  drag.lift = ui.paletteArmed && !ui.holding && !ui.demolishArmed()
    ? pickTarget(e.clientX, e.clientY)
    : null;
  // A mouse drag turns the view, the same quarters the right button turns it in
  // — one gesture for "let me see round the back", whichever button is under
  // your finger. A finger keeps the slide, and that asymmetry is the point
  // rather than an oversight: each device has to be able to do both, and each
  // one already has the other half. Touch turns with the two-finger twist, which
  // a mouse cannot make; a mouse slides the view with WASD in build mode, which
  // is where sliding is actually load-bearing (you go to look at somewhere you
  // cannot stand) and which a phone has no keys for.
  // A stylus counts as a finger here, not as a mouse: it is held over a screen
  // that has the twist, and it has no second button to back out with either.
  drag.turns = e.pointerType !== 'touch' && e.pointerType !== 'pen';
  drag.travel = 0;
  drag.done = false;
  drag.pressedAt = performance.now();
  // A finger has no hover, so the ring that says what you are pointing at has
  // never been asked for at the moment a touch lands — it only ever appeared
  // under a mouse that moved first. Aiming here is what gives the held press
  // something to animate on a phone at all.
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.onCanvas = true;
  refreshGhost(true);
  // Name the crate on the way DOWN, not on release.
  //
  // The ring only ever arms off an errand, and `take` is what sets one — so
  // sending it on release meant a press on a crate you were already stood at
  // armed nothing at all, and holding did nothing however long you held it.
  // Naming it here is what lets the same press become either gesture: keep
  // holding and the ring winds to a lift, let go quickly and the release below
  // sends the rummage instead.
  //
  // Harmless when the press turns out to be a pan — an errand is a target, not
  // an action, and nothing fires without the button still being down.
  // ...and one pile of goods on a shelf, for the same reason and with the same
  // timing. This is what makes a board you are ALREADY STANDING AT a single
  // gesture: press the bread, keep holding, the ring winds on the cage and the
  // armful lands. Named on release instead, the errand would arm the charge on a
  // button that had just come up, and the whole thing would read as a press that
  // did nothing until you pressed again — which is the four-step version of this
  // that board aiming exists to delete.
  if (e.button === 0 && !ui.demolishArmed()) {
    // `aimCrate`, which is `pickPallet` plus "is it in a pile" — the crate named
    // is the one the ray met, buried or not, so the ring winds on the box you
    // are pointing at and that is the box that comes away.
    const aimed = aimCrate(e.clientX, e.clientY);
    const hit = aimed ? null : pickAimed(e.clientX, e.clientY);
    if (aimed) net.send('take', { palletId: aimed.id });
    // ...but only for a unit you are STOOD at, which a crate does not have to
    // ask because a crate is a small thing in a yard and a shelf is most of a
    // wall. A mouse turns the view by dragging, and a drag that started on a
    // shelf across the shop would have sent you walking to it before the first
    // frame of the turn — an errand nobody asked for, out of the gesture people
    // use most. Naming it early only buys anything in reach anyway: that is
    // exactly the case where the ring can wind under the same press, and the
    // release below still names a board you have to walk to.
    else if (hit?.board && boardTakes() && inReachOf(hit.f)) {
      net.send('take', { shelfId: hit.f.id, itemId: hit.board });
    }
    // The UNIT with your hands full is deliberately NOT here — it is
    // `syncStockAim`, off the pointer, so there is one writer of that errand
    // rather than two opinions about it. The pointer has already answered by the
    // time any button goes down, including on a touch: `refreshGhost(true)` a few
    // lines up runs at the moment the finger lands, which is the only "hover" a
    // phone ever gets.
    //
    // The other end of the same idea: a square beside you, with your hands full.
    // `place` names it as somewhere to put goods *down* without walking you onto
    // it, so the hold has a target and the box lands where you were pointing —
    // and the tap keeps its own meaning, which is how you still take a single
    // step while holding a crate. A tap goes, a hold does; the press has to arm
    // the hold, or the ring has nothing to wind and the gesture reads as dead.
    //
    // In reach only, and only over ground the drop can use — `canDropAt` is the
    // same test the green square is drawn from, so the press and the picture
    // cannot disagree. A shelf under the pointer means stock it and a crate means
    // take from it, which is why this sits under both.
    else if (!hit && dropping()) {
      const tile = scene.pickTile(e.clientX, e.clientY);
      if (tile && canDropAt(tile)) net.send('place', { x: tile.x, z: tile.z });
    }
  }
  // Armed on a timer rather than measured on release, so whatever the hold does
  // happens under a pointer that is still down — which is what makes it feel
  // like a press and not like a slow click.
  //
  // Right now it does nothing (`HOLD_OPENS`), because opening moved back onto
  // the tap. Everything is left wired: the wind-in still draws, so a held press
  // still reads as a distinct gesture rather than a dead one, and giving the
  // hold a job again is one flag rather than an archaeology exercise.
  // The button is down, so the ring may start winding. Everything a press can
  // become — a tap, a pan, a turn — cancels it below; the ring only ever
  // completes for a press that stayed put on the thing you pressed.
  hold();
  clearLongPress();
  drag.timer = setTimeout(() => {
    drag.timer = null;
    if (drag.id === null || drag.travel >= TAP_SLOP) return;
    // Past here the press is a HOLD, whatever it goes on to do, so its release
    // must not also read as a tap — otherwise finishing a ring sends you
    // walking to whatever was under your finger, or re-arms the errand you
    // just spent. Set outside the `HOLD_OPENS` guard on purpose: the flag is
    // about whether a hold OPENS things, and winding a ring is now a second
    // thing a hold does. Fires at 420ms against a ring that needs a full
    // second, so the release is always swallowed before the action lands.
    drag.done = true;

    // Build mode's own answer to a held press, and it comes before `HOLD_OPENS`
    // because it is not the same question: that flag is about whether holding
    // *looks* at things, and this is holding *taking* one. The bulldozer keeps
    // the pointer to itself — with it up you are aiming at things to destroy
    // them, and a hold that quietly handed you the shelf instead would be the
    // one gesture in the mode that does the opposite of what the tool says.
    //
    // The same lift the drag does, for a press that never moved — which is the
    // one a finger makes, and the one you make when the thing is already where
    // it should be and you only want it in your hands. It leaves the fixture
    // carried rather than dropping it on release: you have not pointed anywhere
    // else yet, so there is nowhere to put it down but where it already was.
    //
    // `drag.lift` is spent here too, or dragging on after the hold has fired
    // would ask the server for a second lift of the thing already in your hands.
    if (drag.lift) {
      const f = drag.lift;
      drag.lift = null;
      liftAimed(f, { reopen: false });
      return;
    }

    if (!HOLD_OPENS) return;
    // The wind-in has to land on something. Without a ripple at the end the
    // ring just stops being wound and the menu appears, which reads as the
    // animation having been interrupted rather than completed.
    const spot = scene.pickTile(drag.ox, drag.oy);
    if (spot) scene.ripple(spot.x, spot.z, 'miss');
    openAtPointer(drag.ox, drag.oy);
  }, LONG_PRESS_MS);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (spin && e.pointerId === spin.id) {
    const t = stepTurn(spin.ax, e.clientX);
    spin.ax = t.anchor;
    // Sticky: one turn anywhere in the press means the release was a drag, and
    // a drag must not also back out of the mode you were looking around inside.
    if (t.turned) spin.turned = true;
    return;
  }
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { stepPinch(); return; }
  if (edgeDrag && e.pointerId === edgeDrag.id) {
    showEdgeDrag(e.clientX, e.clientY);
    return;
  }
  if (floorDrag && e.pointerId === floorDrag.id) {
    showFloorDrag(e.clientX, e.clientY);
    return;
  }
  if (drag.id !== e.pointerId) return;
  drag.travel = Math.max(drag.travel, Math.hypot(e.clientX - drag.ox, e.clientY - drag.oy));
  // Past the slop it is a pan and never becomes a tap again, so the long press
  // is disarmed for good rather than re-tested each move.
  if (drag.travel >= TAP_SLOP) {
    clearLongPress();
    // Moved, so this press is a pan and never an action. Same verdict the tap
    // gets, and it has to be sent rather than merely remembered — the server is
    // the thing counting the ring up.
    release();
    // Past the slop with a fixture under where you started: this is a move, and
    // the camera never gets this drag at all.
    if (drag.lift) {
      const f = drag.lift;
      drag.lift = null;
      drag.moving = true;
      liftAimed(f, { reopen: false });
      return;
    }
    // ...and it does not get any of the rest of it either. `lift` is spent the
    // instant it fires, so without this the first move pulls the lamp out and
    // every move after it spins the shop underneath — which is the bug this
    // whole branch exists to fix, arriving one event later.
    if (drag.moving) return;
    if (drag.turns) {
      const t = stepTurn(drag.ax, e.clientX);
      drag.ax = t.anchor;
    } else {
      // Fed the *frame* delta, not the distance from the origin — panning by the
      // total would move the camera by the whole drag again on every event, which
      // accelerates away from your finger the longer you hold it.
      scene.panBy(e.clientX - drag.lx, e.clientY - drag.ly);
    }
  }
  drag.lx = e.clientX;
  drag.ly = e.clientY;
});

function endPress(e) {
  if (edgeDrag && (!e || e.pointerId === edgeDrag.id)) {
    const drawn = e ? showEdgeDrag(e.clientX, e.clientY) : null;
    const start = edgeDrag.start;
    const kind = edgeDrag.kind;
    edgeDrag = null;
    scene.setEdgeGhost(null, null);
    ui.setBuildVerdict(null);
    if (drawn) {
      if (!drawn.verdict.ok) { ui.toast(drawn.verdict.reason, true); return; }
      if (drawn.verdict.warn) ui.toast(drawn.verdict.warn);
      // Two ends and a kind, never the list — a long wall would blow past the
      // 4KB inbound cap, and one message is also one re-flow. The far end goes
      // over as the pointer's own index, unclamped: the server runs the same
      // `edgeRun` against the same maximum and trims it to the same segments,
      // so reading it back off the list could only ever disagree — and did, in
      // one direction, for every drag towards a lower x or z.
      net.send('build-edge', {
        o: start.o, x: start.x, z: start.z, kind, to: drawn.to,
      });
    }
    return;
  }
  if (floorDrag && (!e || e.pointerId === floorDrag.id)) {
    const drawn = e ? showFloorDrag(e.clientX, e.clientY) : null;
    const { start, piece } = floorDrag;
    floorDrag = null;
    scene.setFloorGhost(null, null);
    ui.setBuildVerdict(null);
    if (drawn) {
      if (!drawn.verdict.ok) { ui.toast(drawn.verdict.reason, true); return; }
      if (drawn.verdict.warn) ui.toast(drawn.verdict.warn);
      // Two corners and a piece, never the list. Same cap, same reasoning as a
      // wall run — a full-size stroke is 256 cells — and one message is also
      // one re-flow rather than 256 of them. The far corner goes over unclamped:
      // the server runs the same `groundStroke` and trims it to the same
      // rectangle, so clamping twice could only ever disagree.
      const to = drawn.to ? { x: drawn.to.x, z: drawn.to.z } : null;
      net.send('build-ground', { x: start.x, z: start.z, piece, to });
    }
    return;
  }
  if (drag.id === null || (e && e.pointerId !== drag.id)) return;
  // A press that never really moved is a tap, not a pan — and a long press has
  // already spent the gesture, so its release means nothing.
  const tapped = e && !drag.done && drag.travel < TAP_SLOP;
  const dropping = drag.moving && !!e;
  endDrag();
  // Pulled something out and let go: it lands where you let go of it. A drag
  // that ends with no event at all — a cancelled pointer, a lost window — leaves
  // it in your hands instead, which is the recoverable half: Esc puts it back
  // and a tap sets it down. Dropping it wherever the pointer was last seen is
  // how a fixture ends up in a corner nobody chose.
  if (dropping) { dropCarried(e.clientX, e.clientY); return; }
  if (tapped) tapAtPointer(e.clientX, e.clientY);
}

/**
 * Let go of a fixture you dragged out.
 *
 * `tapAtPointer` is the placement path and does everything right — the spec off
 * what is in your hands, the verdict checked before the send, the target marked
 * so the errand can find the fixture afterwards — so this is a `tapAtPointer`
 * with one case in front of it.
 *
 * That case is the round trip. The lift went out a few frames ago and the
 * snapshot that fills our hands may not be back yet, so `ui.holding` can still
 * be null on a quick flick. It does not matter to the *server*: messages arrive
 * in the order they were sent, so `build-lift` has already been processed and
 * `p.holding` is set by the time this one is read. What is missing is only the
 * client's copy — and a drop needs nothing from it but a tile, because
 * `dropFixture` reads the kind, piece, tier and variant off what the server
 * knows we are carrying.
 */
function dropCarried(cx, cy) {
  const tile = scene.pickTile(cx, cy);
  // Released off the edge of the world. Still in hand, nothing sent.
  if (!tile) return;
  if (ui.holding) { tapAtPointer(cx, cy); return; }
  ui.markMoveTarget(tile);
  // No `rot`, deliberately. `buildRot` is the *palette's* angle until the
  // snapshot lands and replaces it with the one the fixture already had — so
  // sending it on a fast flick would turn the thing you were only moving, which
  // is precisely the "moving it reset its rotation" bug wearing a race
  // condition. `dropFixture` falls back to what it is carrying, which is right.
  net.send('build-drop', { x: tile.x, z: tile.z });
}
/**
 * The right button backs out, the way it does in every builder — unless the
 * press turned the camera, in which case it was a drag and backing out of the
 * mode you are looking around inside is the last thing you meant.
 *
 * Backing out runs the same ladder Escape does rather than dropping straight to
 * shopkeeping, and that matters in one place: with a fixture in your hands,
 * "out" has to mean putting it back before it means leaving the mode, or a
 * click would strand the thing you were carrying. So carrying → put it back,
 * then → leave build mode. Same rungs, same order, one implementation.
 *
 * It hangs off pointerup and not `contextmenu` because that event fires on
 * *press* on macOS and Linux — a spin would exit build mode before it turned a
 * degree — and on *release* on Windows. Neither is a place to ask "did this
 * press move?", so `contextmenu` is left doing the one thing it is reliable
 * for: swallowing the browser menu.
 */
function endSpin(e) {
  if (!spin || (e && e.pointerId !== spin.id)) return null;
  const turned = spin.turned;
  spin = null;
  return { turned };
}
canvas.addEventListener('pointerup', (e) => {
  const wasPinching = !!pinch;
  dropTouch(e.pointerId);
  const spun = endSpin(e);
  if (spun) {
    if (spun.turned) return;
    // A right click that turned nothing is "back out" everywhere in the game —
    // except on a crate you are stood at, where it is the other half of the
    // rummage: left takes one out, right puts one back.
    //
    // It sits in FRONT of `escape` rather than beside it because backing out is
    // the fallback: pointing at a thing is a positive act, which is the same
    // argument the tap already makes one branch up. Nothing is dismissed while
    // you are aiming at a crate.
    // ...and only on a crate standing on its own, which is the same line the
    // left button draws: putting one unit INTO the box under two others is the
    // same unanswerable "which one" as taking one out of it. On a pile the right
    // button goes back to meaning "back out".
    const crate = aimCrate(e.clientX, e.clientY);
    if (crate && !crate.stacked && inReachOf(crate)) {
      scene.ripple(crate.x, crate.z);
      net.send('crate-one', { palletId: crate.id, put: true });
      return;
    }
    ui.escape();
    return;
  }
  // A finger coming off a pinch is not a tap, however still it was. Both
  // fingers land within the slop of where they started when you only zoomed.
  if (wasPinching) { endDrag(); return; }
  endPress(e);
});
// A cancelled pointer is not a click, so it drops the spin without backing out.
canvas.addEventListener('pointercancel', (e) => {
  dropTouch(e.pointerId);
  if (!endSpin(e)) { endDrag(); endPress(e); }
});
addEventListener('blur', () => {
  touches.clear();
  pinch = null;
  // A window that loses focus never sends the pointerup, so without this the
  // button stays down for the server and the ring keeps winding while you are
  // in another tab. `endDrag` below covers the ordinary paths; this covers the
  // one that has no event at all.
  release();
  endSpin();
  endPress();
  endDrag();
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// The bar is a game toolbar, not a document — a browser menu over it is never
// what anybody meant by right-clicking there. No `escape()` though: pressing it
// on a button is a miss, not a decision to leave.
document.getElementById('build')?.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * Order a walk, and give the camera back to the person taking it.
 *
 * Recentring here rather than on letting go of the pan is the rule that makes
 * looking around usable on a phone: the view stays where you dragged it for as
 * long as you are only looking, and going somewhere is what reclaims it. A pan
 * that sprang back on release would put the shelf you were aiming at back off
 * screen in the instant between deciding and tapping.
 */
function walkTo(spec) {
  net.send('walk-to', spec);
  // Going somewhere is what reclaims the view, and following somebody is the
  // strongest form of the view being elsewhere — so it comes off here rather
  // than only on the button. Tapping the floor while watching a stocker is
  // unambiguous: you meant to go there, and you cannot watch your own walk from
  // over their shoulder.
  ui.setFollow(null);
  scene.recentre();
}

/**
 * What we are carrying, if anything. Straight off the snapshot, which is the
 * only place it lives — the HUD reads the same field to print "carrying 6x
 * bread", and a second copy kept on this side is one that goes stale the tick
 * somebody takes it off you.
 */
const myCarry = () => latestState?.players
  ?.find((p) => p.id === net.myId)?.carry ?? null;

/**
 * ...and the crate on our shoulder, which is the other place stock can be.
 *
 * Asked separately rather than folded into the one above, exactly as the server
 * keeps `haul` out of `carry`: every reader that means *hands* goes on meaning
 * hands. The two are never both set — you cannot shoulder a box while holding
 * tomatoes — so the only thing anybody asks both for is "am I holding goods at
 * all", which is one `||` at the single call site that wants it.
 */
const myHaul = () => latestState?.players
  ?.find((p) => p.id === net.myId)?.haul ?? null;

/**
 * A shelf's live record, boards and all.
 *
 * `scene.fixtureById` answers off the LAYOUT, which is where a shelf's position
 * and tier live and is rebroadcast only when the shop re-flows. What is
 * standing on its boards is snapshot state, ten times a second — so anything
 * that wants a count reads it here or it is quoting whatever was on the unit
 * the last time somebody bought a shelf.
 */
const shelfById = (id) => (id
  ? latestState?.shelves?.find((s) => s.id === id) ?? null
  : null);

/**
 * Is this thing holding something that standing at it would hand you?
 *
 * A ripe bed and a machine with a finished tray are the two, and they are the
 * same case an armful of stock is from the other end: the answer to pointing at
 * them is not "tell me about this", it is "go and get it". Pointing at a thing
 * *names* it (`walkToFixture`), and a named job fires when you arrive — so the
 * walk is the entire errand, which is what the tap already did with your hands
 * full and did not do with them empty.
 *
 * This is only about which gesture the tap spends, not about what is allowed:
 * standing at a ripe bed does nothing at all now unless you pointed at it. What
 * this decides is whether pointing means "go and get it" or "tell me about it",
 * and a bed with fruit on it has an obvious answer to that.
 *
 * Read off the snapshot, not worked out here. `ready` and `output` are the same
 * fields the renderer draws the fruit and the thought bubble from, so the tap
 * agrees with the picture by construction; deciding it a second time on this
 * side is how a tap starts sending you across the shop for a bed that came on
 * two ticks ago in somebody else's game.
 *
 * Not shelves, and that is still the right answer for a shelf — but no longer
 * for its goods. Their stock is merchandise rather than something waiting to be
 * taken, and one board of one shelf is a choice that has to be named, which for
 * four steps meant the shelf's own menu. The pointer can name it now (see
 * `boardTakes`), so the choice is made by aiming and the tap on a *pile* goes.
 * What this test still keeps is the tap on the UNIT: a tap on the frame of a
 * stocked shelf opens it, so pricing, assignment and priority are one press away
 * rather than behind a gesture that does nothing.
 */
function readyToTake(f) {
  if (f.kind === 'plot') return !!latestState?.plots?.find((p) => p.id === f.id)?.ready;
  if (f.kind === 'station') return !!latestState?.stations?.find((s) => s.id === f.id)?.output;
  return false;
}

/**
 * What you are pointing at, for a gesture that is not building.
 *
 * A decoration answers only in build mode, and outside it the pointer looks
 * straight through to the floor. That is the aiming half of what a prop already
 * is everywhere else: it stamps no tile, takes no budget, reserves no working
 * spot and people walk through it — so it is the one class of thing in the shop
 * that has nothing whatever to say to a tap. It still ringed itself, still ate
 * the press, and still opened a menu whose every entry is a build verb; a
 * planter you have to walk *around with the pointer* to reach the floor behind
 * it is scenery charging rent.
 *
 * `paletteArmed` rather than `buildOn`, because this decides what pointing at
 * the world DOES — and the mode a fixture menu borrows for one press of Empty
 * puts no bar on screen, so it must not silently make the shop's ornaments
 * clickable again. See the note in CLAUDE.md.
 *
 * Not used by the bulldozer or by the build branch below, which do their own
 * picking: getting rid of a thing is exactly the case where a decoration has to
 * be the thing you named.
 */
const aimable = (f) => ui.paletteArmed || !isProp(f.kind);

function pickAimed(cx, cy) {
  return scene.pickFixtureHit(cx, cy, aimable);
}

function pickTarget(cx, cy) {
  return pickAimed(cx, cy)?.f ?? null;
}

/**
 * Is pointing at one pile of goods a Take right now?
 *
 * The pointer can name a board (`pickFixtureHit`'s `board`), and this is the
 * list of ways it means something else instead. Every entry is a state where the
 * shelf is already the answer to a different question:
 *
 * - **the palette is up** — a tap places, and a unit's own menu is what a tap on
 *   it opens. Build mode is the one place where pointing at something is already
 *   a verb, and taking stock is not one of its verbs.
 * - **the bulldozer is armed** — you are aiming at things to get rid of them,
 *   and a tool that quietly handed you an armful instead would be the one that
 *   does the opposite of what it says.
 * - **you are carrying a fixture** — every tile is somewhere to put it down.
 * - **your hands are full of stock** — a shelf is somewhere to PUT things, which
 *   is the errand the tap has always been while carrying. `unshelve` would
 *   accept a top-up off the same board, but a board is a smaller target than the
 *   unit and stocking is the far commoner thing to want with full arms, so the
 *   unit wins the whole gesture rather than a corner of it deciding.
 * - **a crate is on your shoulder** — the same thing said about the box, and the
 *   server refuses it outright (`unshelve`): your hands are full of crate.
 *
 * Written once and asked by all three of hover, press and tap, or the highlight
 * would offer something the press then did differently.
 */
const boardTakes = () => !ui.paletteArmed && !ui.holding && !ui.demolishArmed()
  && !myCarry() && !myHaul();

/**
 * Pick a thing, then open it — the two presses a fixture's menu now costs.
 *
 * A tap on a shelf used to *be* a tap on its settings, which is a whole panel
 * over the shop for a question you very often did not have: which one is that,
 * where do people stand to use it, is that the freezer I meant. Selection was
 * the answer to all three and there was no way to ask for it on its own, so
 * every glance cost a menu and every menu cost a dismissal.
 *
 * So: press one picks it (the teal ring and its working spots, already built —
 * see `setSelectedTarget` — and R and M now have something to act on without a
 * panel), press two opens it, press three puts it away and lets go. Pressing a
 * DIFFERENT thing always starts again at one, which is the half that keeps this
 * cheap: switching between units is one press each, the same as before, and it
 * is only the unit you have settled on that asks for a second.
 *
 * Called from both tap branches rather than written twice. They were already
 * the same four lines with different comments, and the two of them drifting is
 * how "a tap in build mode does something else" starts.
 */
function openInTwo(f, { walk = false } = {}) {
  if (!ui.isSelected(f)) {
    ui.selectFixture(f);
    // ...and shopkeeping spends the same press on the walk. Picking a thing out
    // and then crossing the floor to it are not two decisions — you pointed at
    // that shelf because you are going to it — so the press that says WHICH
    // also says GO, and the menu is what the second press is for. It costs
    // nothing that was not already spent: a tap on bare floor beside the unit
    // walked you there and named nothing, so this is that gesture with an
    // answer attached.
    //
    // Deliberately not in build mode, which is the caller's decision and why
    // this is a flag rather than the default. Building flies the view somewhere
    // you cannot stand (`setFreeRoam`) — a room you have just sealed, the far
    // side of the fence — so a select that walked would be sending you off
    // across the shop every time you looked at what you had built.
    if (walk) { scene.ripple(f.x, f.z); walkTo({ fixture: f.id }); }
    else scene.ripple(f.x, f.z, 'miss');
    return;
  }
  // Pale from here on, and the two colours are carrying the whole difference
  // between the presses: amber is "you are on your way", pale is "I heard you".
  // A press that opens a panel must not flash the going colour.
  scene.ripple(f.x, f.z, 'miss');
  if (ui.openPanel === 'fixture') ui.closePanel();
  else showFixture(ui, f);
}

/**
 * Hold a thing in build mode and you pick it up.
 *
 * The same errand the fixture menu's Move button starts, on the gesture that
 * was already winding a ring on the thing you were pointing at and then doing
 * nothing with it. Moving something used to cost three presses — point at it,
 * wait for the panel, find Move — and two of those are ceremony around a
 * decision you had already made by aiming.
 *
 * It is the *hold* rather than the tap for the reason it is everywhere else in
 * the game: a tap is what you do to ask a question, and lifting a lamp off the
 * ceiling by accident because you wanted to know what it cost is the kind of
 * mistake a gesture should be shaped to prevent. Holding is a sentence you have
 * to finish, and the ring says how long you have to change your mind.
 *
 * `startMove` before the send, and both before the snapshot that says your
 * hands are full: it is what holds build mode open across the carry, and the
 * gap between the two is exactly what `_lifting` exists to cover.
 */
function liftAimed(f, opts = {}) {
  scene.ripple(f.x, f.z);
  // `reopen: false`, and it is the difference between an errand and a habit. The
  // menu's own Move button came FROM the menu, so putting the thing down goes
  // back to it. Pointing at something and pulling it did not: rearranging four
  // lamps in a row would leave a panel open on each in turn, and the shop then
  // always has something selected with nothing you pressed to explain why.
  //
  // An errand returns you where you started, and here you started by pointing.
  // `withBuildMode`, the way the Move button it stands in for does: every fixture
  // verb is gated on the mode server-side, and M is reachable from a menu opened
  // without it. It wraps `startMove` as well as the send, or `borrowed` is
  // computed before the mode it is about to borrow exists.
  ui.withBuildMode(() => {
    ui.startMove(f, { reopen: opts.reopen !== false });
    net.send('build-lift', { id: f.id });
  });
  // The panel would be a menu for a thing that is no longer standing where the
  // menu says it is.
  ui.closePanel();
  // One wording for both ways in: a drag puts it down when you let go, a hold
  // leaves it in your hands for a tap, and "put it down where it should sit" is
  // true of each without naming a gesture the player did not use.
  ui.toast(`Carrying the ${ui.fixtureName(f).toLowerCase()} — put it down where it should sit · R turns it`);
}

/**
 * Look at what you are pointing at. The long press, and nothing else.
 *
 * This was what a *tap* did, back when tapping only ever looked. Tapping now
 * goes — the one gesture every device has, spent on the thing a shop needs
 * most — so looking moved to the same press held still. Nothing about which
 * menu opens changed in the move, and this is also where a person is reachable
 * at all: `tapAtPointer` looks past them on purpose, and here they outrank the
 * fixture they are standing in front of.
 */
function openAtPointer(cx, cy) {
  // Not while your hands are full: then every tile is a home for what you carry
  // and there is nothing to look at.
  if (ui.holding) return false;
  // A person outranks the fixture behind them. They are smaller and they
  // move, so pointing at one is deliberate in a way that pointing at a shelf
  // is not — and their menu is the only way to reach what they do all day.
  // Not while the bulldozer is up: then you are aiming at things, and a clerk
  // wandering in front of a shelf must not stop you tearing the shelf out.
  const who = ui.demolishArmed() ? null : scene.pickPerson(cx, cy);
  if (who?.hire) { showWorker(ui, who.hire); return true; }

  const over = pickTarget(cx, cy);
  if (over && !ui.demolishArmed()) { showFixture(ui, over); return true; }
  return false;
}

/**
 * What a tap means, decided by what you tapped and whether you're building.
 *
 * **Press and let go, and you go there.** Bare ground walks you to it, and a
 * *thing* walks you to the side of it you work from and names it — which is the
 * whole errand in one gesture: point at a shelf, and you cross the shop and
 * stock it with no second input. Looking at a thing is the same press, held:
 * see `openAtPointer`.
 *
 * The naming is not a shortcut, it is the permission. Nothing goes into or out
 * of your hands for standing near it, so the tap is the only way an armful ever
 * leaves them — and the drop-off is a tap on the ground, because it is ground.
 *
 * One rule for a mouse and a finger, which is a decision that was made twice.
 * The middle version gave the mouse click-to-open and left the errand to
 * touch, on the reasoning that a mouse should not have to wait — and waiting
 * is genuinely the cost. What it buys is that pointing at a shelf sends you to
 * the shelf, on the device where you can point at a shelf precisely; splitting
 * it meant the neatest thing in the scheme was the one thing a mouse could not
 * do, and you were back to clicking the floor beside things.
 *
 * In build mode a tap places, and still opens a fixture's own menu — move,
 * turn, empty, sell. Build mode is the one place where pointing at something
 * is already a verb, so walking there would take the tap away from the job you
 * turned the mode on to do.
 */
function tapAtPointer(cx, cy) {
  const kind = ui.ghostKindForTool();

  if (!kind && !ui.holding) {
    // The bulldozer keeps the tap as its verb. One tap per thing, on the one
    // thing that is ringed — the tool stays armed after, the way a bulldozer
    // does, because clearing a row otherwise means picking the tool up again
    // between every single press.
    if (ui.demolishArmed()) {
      const over = scene.pickFixture(cx, cy);
      if (over) { scene.ripple(over.x, over.z, 'no'); ui.razeFixture(over); return; }
    }

    // A person opens on the tap itself, with no wait.
    //
    // The rule everywhere else is "tap goes, hold looks", and a person is the
    // one case where that leaves the tap with nothing to do: you cannot walk to
    // somebody who walks off, so "go to where that clerk was standing" is not a
    // thing anybody means. An earlier cut concluded from that same fact that a
    // tap should look straight *past* them — which is true of what the tap
    // cannot do and wrong about what it should. There is exactly one useful
    // answer to pointing at a hire, so pointing at one gives it.
    //
    // Before the open-panel dismissal below, so a worker is always one press
    // away rather than two whenever anything else happens to be up.
    //
    // Not while the bulldozer is armed: then you are aiming at things, and a
    // clerk wandering in front of a shelf must not stop you tearing it out.
    const who = ui.demolishArmed() ? null : scene.pickPerson(cx, cy);
    if (who?.hire) { showWorker(ui, who.hire); return; }

    // Past the people, so this press is on something that is not one: the
    // floor, a shelf, a crate, or a menu being dismissed. All of them are
    // "clicking off them", and following ends here rather than only on the
    // button — the button lives in a menu, and a tap on the world is the first
    // thing that puts a menu away. Pointing at a hire is what does NOT end it,
    // which is why this sits under that branch: watching a stocker and tapping
    // them to read what they are up to obviously meant to keep watching.
    ui.setFollow(null);

    // A crate is a verb, and the only one on the shop floor that a tap fires
    // directly. Everything else you point at either opens (a fixture, a hire)
    // or is somewhere to stand — a pallet is neither. It has nothing to read
    // and one thing to do, and until now that one thing happened to you for
    // standing too close to it.
    //
    // Above the fixture check because a crate at the bay can sit on the same
    // screen space as the shelving behind it, and the crate is the thing in
    // front. Not gated on empty hands: topping up an armful from the same
    // pallet is the common case, and a mismatch is the server's refusal to
    // give, not a reason for the tap to do nothing.
    // ...and a PILE of them is one verb rather than several: whole boxes only.
    // Which box is still yours to choose — the ray picks them apart by height
    // and the ring says which — but a tin at a time is not on offer up there,
    // because a buried crate shows a band of roughly a dozen pixels and one unit
    // out of it is never the tin anybody meant. That is what the pile list was
    // for, and a list is a poor substitute for pointing: it read out four rows to
    // answer a question the pointer had already answered, and the tap underneath
    // it rummaged, so standing at a tower of boxes and pressing took ONE TIN.
    // Aim and lift now — see `crateStacked` for the rule and `aimCrate` for the
    // aim.
    const crate = ui.demolishArmed() ? null : aimCrate(cx, cy);
    if (crate) {
      scene.ripple(crate.x, crate.z);
      // Already stood at a crate on its own? Then a quick tap is a RUMMAGE —
      // one unit out — and not another walk to where you are. Two gestures on a
      // lone crate, graded by how much they move: tap a unit, hold the box.
      //
      // Reach is asked here rather than sent as an intent because the answer
      // decides which MESSAGE this is, and a `take` that quietly turned into a
      // rummage server-side would mean tapping a crate across the shop did
      // different things depending on where you happened to be standing.
      //
      // `!crate.stacked`, or the gesture that means "one tin" fires on the pile
      // where the only thing you can have is the box — and the server refuses
      // it there anyway, so this is the half that makes the tap do the right
      // thing rather than the half that stops the wrong one.
      if (!crate.stacked && inReachOf(crate)) {
        net.send('crate-one', { palletId: crate.id, put: false });
        return;
      }
      // Out of reach — or a pile, where the only job is the lift. The press has
      // usually already sent this; the same target twice costs nothing.
      net.send('take', { palletId: crate.id });
      return;
    }

    // Aim at the thing, not the floor under it — `pickFixture` is the one that
    // answers "what am I pointing at" for a box drawn most of a tile up-screen
    // of the ground it stands on. The walk names the fixture rather than a
    // tile, because where you stand to work a shelf is the layout's business
    // and worked out twice it can disagree with itself.
    // A prop opens; the floor takes you somewhere. Pointing at a thing means
    // "tell me about this" and pointing at the ground means "go there", which
    // is the same division a person already gets one branch up.
    //
    // Above the dismissal below, and for the same reason a person is: pointing
    // at a thing is a positive act, so with a menu already up it means "that
    // one instead" and not "put this away and ask me again". Underneath, every
    // second prop you looked at cost two presses — dismiss, then point — and
    // the marker made that plain, since the ring you were aiming at and the
    // brackets you were leaving were both on screen saying the tap had a
    // target. `showFixture` re-points the open panel rather than opening a
    // second one, so switching is one call and nothing has to close first.
    //
    // Pale rather than amber, and this is the only thing distinguishing the two
    // presses at a glance: amber is "you are on your way", pale is "I heard
    // you". A press that opens a panel must not flash the going colour.
    const hit = pickAimed(cx, cy);
    const over = hit?.f ?? null;
    if (over) {
      // With an armful of stock, pointing at a shelf is an errand and not a
      // question — so it goes, the same as pointing at the floor does. This is
      // the one branch where "a prop opens, the floor takes you somewhere"
      // gives the wrong answer: reading a shelf's menu is not what anybody
      // wants while holding six loaves, and pointing at a shelf both routes you
      // there and says it is the one you meant, so this IS the whole job. The
      // chevrons say which shelves are worth walking to; this is how you take
      // one up on it — and now the only way to, since walking past a shelf with
      // your hands full leaves them full.
      //
      // A bed with fruit on it and a machine with a full tray are the same
      // thing pointing the other way: goods and a person, one of them standing
      // still, and the only thing between them is the walk. It read as
      // inconsistent because it was — the identical gesture went somewhere or
      // asked a question depending on which end the stock was at, and the
      // question is never the one you have when you can see tomatoes.
      // `readyToTake` is the test, and it is deliberately only those two.
      //
      // By fixture rather than by tile, so the server routes you to the side
      // you work from — the same call the hint means by "tap to go".
      //
      // What it costs is that a bed with fruit on it has no menu while it is
      // ripe, and with `HOLD_OPENS` off there is no second gesture to put it
      // behind. Build mode is the way back in — a tap there opens anything you
      // own — and the bed stops being ripe the moment you get there, which is
      // the whole point of the branch. Sowing is the only thing the menu is
      // really for and `sow` refuses a ripe bed anyway ("harvest it first"), so
      // what is behind the mode is move, sell and restyle: the three things you
      // do to a bed you are not currently farming.
      // `myHaul` beside `myCarry`, or the chevrons over what a crate can fill
      // would be pointing at units the tap then read a menu about. A box is
      // goods with a home to find, same as an armful — it pours straight onto
      // the board (`stockFromCrate`) rather than being set down first.
      if (myCarry() || myHaul() || readyToTake(over)) {
        // Amber, not pale: this one really is "you are on your way".
        scene.ripple(over.x, over.z);
        walkTo({ fixture: over.id });
        return;
      }

      // One pile of goods, pointed at directly: go and get THAT one.
      //
      // This is the same errand the shelf menu's Take row sends, minus the menu
      // — and the menu was three presses of ceremony around a decision you had
      // already made by pointing at the bread. `take` has always been able to
      // name a board; what was missing was a way to say which board that was not
      // a list, and the goods are drawn as themselves on boards a few pixels
      // apart, so the pointer is a better instrument for it than a menu row is.
      //
      // Amber, like every other "you are on your way". Nothing else about the
      // gesture is special: the press already named it on the way down, so this
      // send is the one that matters only for a board across the shop — and it
      // costs nothing to repeat, exactly as the crate branch above says.
      //
      // The unit itself is still one press away, at any pixel of it that is not
      // its stock: an end panel, the frame, the base, the gap between boards. A
      // full unit is mostly goods from this camera but never all goods — and
      // build mode opens anything you own regardless.
      //
      // ...and standing at it, the tap is ONE UNIT rather than another walk to
      // where you already are. That is the grade a lone crate has had since it
      // became rummageable, said about a shelf: **a tap is one, a hold is the
      // board.** Sending the errand here instead is a press that does nothing
      // you can see — the walk is a no-op and the goods only move under a hold.
      //
      // Which message it is, is decided here rather than sent as an intent, for
      // the same reason the crate decides it here: a `take` that quietly became
      // a rummage server-side would mean tapping a shelf across the shop did
      // different things depending on where you were standing.
      if (hit?.board && boardTakes()) {
        scene.ripple(over.x, over.z);
        if (nearFixture(over)) net.send('shelf-one', { shelfId: over.id, itemId: hit.board });
        else net.send('take', { shelfId: over.id, itemId: hit.board });
        return;
      }

      openInTwo(over, { walk: true });
      return;
    }

    // An open panel eats a press that landed on nothing. Pressing the world
    // with a menu up has always meant "put that away", and taking a walk order
    // out of the same press would send you across the shop every time you
    // dismissed something. Rippling pale rather than amber is the difference
    // between "I heard you" and "you are on your way" — press again and you go.
    if (ui.openPanel) {
      const spot = scene.pickTile(cx, cy);
      if (spot) scene.ripple(spot.x, spot.z, 'miss');
      ui.closePanel();
      return;
    }

    // A press on the floor lets go of whatever was picked — but does NOT eat the
    // press the way an open panel does. A selection is a ring and nothing else:
    // there is no panel over the shop to dismiss, so there is nothing here worth
    // costing you the walk you just asked for.
    if (ui.fixtureRef) ui.setFixtureRef(null);

    const tile = scene.pickTile(cx, cy);
    if (tile) { scene.ripple(tile.x, tile.z); walkTo({ x: tile.x, z: tile.z }); }
    return;
  }

  // Past here something is armed to go down — a tool or an armful, since the
  // branch above owns every tap that has neither. So a tap PLACES, and nothing
  // already in the shop can take it away: not a shelf, not a lamp, and not a
  // clerk who wandered under the ghost. This used to open whatever was under
  // the pointer — you could still pick things up with something already in hand
  // to put down — and the hover half now says otherwise, since the build branch
  // of `refreshGhost` rings nothing and aims no person. A press that does what
  // no marker on screen advertised is the worse half of the two.
  //
  // Which leaves the menus one gesture away rather than none: Escape or the lit
  // button puts the tool down (`disarmTool`), and then everything points at
  // things again. The bulldozer never comes through here — it arms no ghost, so
  // it is served by the branch above with its aiming intact.

  // Building on bare ground is the only part that needs the mode.
  if (!kind) { ui.closePanel(); return; }

  const tile = scene.pickTile(cx, cy);
  if (!tile) return;

  // The shape only means anything when buying a new one: what you are
  // carrying already knows what shape it is.
  // Which appliance, when the tool is one — the kind alone doesn't say whether
  // this is a blender or a toaster. What you're carrying already knows.
  const station = ui.holding?.station ?? (kind === 'station' ? ui.buildStation : null);
  // ...and which design, for the same reason. A carried fixture keeps its own —
  // picking a shelf up and putting it down must not restyle it.
  const piece = ui.holding?.piece ?? ui.buildPiece ?? null;
  const spec = {
    kind, piece, station, x: tile.x, z: tile.z, rot: ui.buildRot, variant: ui.buildVariant ?? '',
  };
  // `tier` rides along for the drawing only — the server decides what a new one
  // is built at. Without it this call would redraw the ghost at tier 1 on the
  // very click that places a maxed-out freezer you are carrying.
  const verdict = scene.setBuildGhost({
    ...spec, moveId: ui.holding?.id ?? null, tier: ui.holding?.tier ?? 1,
  });
  if (verdict && !verdict.ok) { ui.toast(verdict.reason, true); return; }
  // A warning is not a refusal. Blocking your own shop is a legal move, so say
  // what it will cost and let it land — the amber ghost already asked once.
  if (verdict?.warn) ui.toast(verdict.warn);

  if (ui.holding) {
    // Setting down what you picked up *finishes* something rather than starting
    // one: note where it lands, and `endMove` reopens its menu there and hands
    // back a build mode the fixture menu only lent you.
    ui.markMoveTarget(tile);
  } else {
    // Buying one and placing it is committing to the mode, so shutting the menu
    // still open on some other fixture can't drop you out of it mid-build.
    ui.commitBuildMode();
  }
  if (ui.openPanel === 'fixture') ui.closePanel();
  net.send(ui.holding ? 'build-drop' : 'build-place', spec);
}

// ---------------------------------------------------------------------------
// The build camera
//
// In build mode the keys drive the *view* and not your feet. Everywhere else
// you tap where you want to go and the walk brings the view along with it —
// but in build mode a tap places, so the only thing that could move the camera
// was walking your body there, and the body is exactly what cannot go where
// you want to build: inside a room you have just sealed, over the fence, out
// at the end of a grown farm. The view was chained to somewhere you can stand.
//
// So it comes off the chain while you are building, and goes back on when you
// stop. No new gesture: it is the keys that already mean "move", under the
// hand that is not on the mouse, and nothing about it can fire by accident.
// The cost is that you cannot walk about with the palette up — press G first —
// which is the same trade the tap already makes.
// ---------------------------------------------------------------------------

/**
 * Do the keys move the view rather than the player?
 *
 * The same test the ghost uses, deliberately: if a tap would place something,
 * the keys fly. A mode a fixture menu borrowed for one press of Empty is not
 * one you are building in, and having WASD mean something different while you
 * read a menu is how a control scheme stops being learnable. Carrying counts —
 * that is the errand that most needs to reach a tile you cannot see.
 */
const flying = () => ui.paletteArmed || !!ui.holding;

function pollInput(dt) {
  // Camera is rotated 45°, so screen-up should move you diagonally in world
  // space — otherwise "up" feels wrong on an isometric view.
  let x = 0;
  let z = 0;
  if (keys.has('w') || keys.has('arrowup')) { x -= 1; z -= 1; }
  if (keys.has('s') || keys.has('arrowdown')) { x += 1; z += 1; }
  if (keys.has('a') || keys.has('arrowleft')) { x -= 1; z += 1; }
  if (keys.has('d') || keys.has('arrowright')) { x += 1; z -= 1; }

  let dx = Math.sign(x);
  let dz = Math.sign(z);

  // The keys name a direction in *screen* space, which is only the
  // world's 45° diagonal while the camera sits in its home corner. Turn the
  // result by however many quarter turns the camera has taken and "up" keeps
  // meaning away-from-you — otherwise every rotation makes the controls lie.
  // One rotation per quarter, matching applyAxisAngle(Y): (x, z) -> (z, -x).
  //
  // Above the split, because it is true of both: flying the view has the same
  // relationship to a turned camera that walking does, and reading the keys
  // twice is how the two ends up disagreeing.
  for (let i = scene.quarter; i > 0; i--) {
    const t = dx;
    dx = dz;
    dz = -t;
  }

  scene.setFreeRoam(flying());
  if (flying()) {
    // Stop the feet before taking the wheel. A key held across the moment build
    // mode came up would otherwise leave you walking at the server for as long
    // as it stayed down — the release is what sends a zero, and the release now
    // goes to the camera.
    if (lastInput.dx || lastInput.dz) {
      lastInput = { dx: 0, dz: 0 };
      net.send('input', lastInput);
    }
    scene.flyBy(dx, dz, dt);
    return;
  }

  // Taking the wheel takes the camera back too. The server drops the route on
  // the first frame of steering, so leaving the view parked where a pan left it
  // would walk you off the side of your own screen — and a view riding on
  // somebody else is that with the parking spot walking away as well.
  if (dx || dz) {
    ui.setFollow(null);
    if (scene.panned) scene.recentre();
  }

  if (dx !== lastInput.dx || dz !== lastInput.dz) {
    lastInput = { dx, dz };
    net.send('input', lastInput);
  }
}

// ---------------------------------------------------------------------------

/**
 * When the last frame ran, so anything that moves per *second* can.
 *
 * Clamped where it is read: a backgrounded tab comes back with a delta of
 * however long you were away, and a camera fed that crosses the whole world in
 * one frame.
 */
let lastFrame = performance.now();

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  pollInput(dt);
  if (ui.buildOn) refreshGhost();
  // How far through a held press we are, recomputed per frame rather than
  // stepped by the timer that fires it: the timer knows when the press is over
  // and nothing else, and a progress bar driven by a single timeout can only
  // ever jump from empty to full.
  const holding = drag.id !== null && !drag.done && drag.travel < TAP_SLOP;
  scene.setHoldProgress(holding
    ? (performance.now() - drag.pressedAt) / LONG_PRESS_MS
    : null);
  scene.render();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Boot: pick a shop, then open it
//
// `?world=<id>` skips the menu — that's the shareable link into somebody's shop,
// and how an agent parks a tab in a particular world for `screenshot`. Anything
// else asks, because with save slots there is no longer an obvious answer.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const boot = document.getElementById('boot');

/**
 * Put the shop you're in in the address bar.
 *
 * The URL is where you are: reload, bookmark it, or send it to whoever you're
 * playing with, and you all end up in the same shop. It is the same `?world=`
 * the menu is skipped by, so there is one way in and not two.
 *
 * `replaceState`, not `push`: pushing would make Back walk to the same page
 * without the param, which changes the address bar and nothing else — the game
 * is already running and there is no popstate handler to tear it down. Leaving
 * is the Controls menu's job, and it drops this param on the way out.
 */
function rememberInUrl(worldId) {
  const url = new URL(location.href);
  url.searchParams.set('world', worldId);
  history.replaceState(null, '', url);
}

async function openWorld(worldId, name) {
  boot.textContent = 'Opening the shop…';
  ui.worldId = worldId;
  await net.connect(name, worldId);
  rememberInUrl(worldId);
  boot.remove();
  // No welcome toast. There was one — "Drag to move · tap a plot to sow · walk up
  // to things to use them" — and every clause of it had stopped being true: a
  // drag pans the camera rather than moving you, walking up to something stopped
  // being how you use it the day the errand ring landed (proximity is down to a
  // till with somebody at it and a rough bed), and what there is to sow is
  // already a line in the to-do list. It is deleted rather than rewritten,
  // because the shape was the problem too: three instructions across the top of
  // the screen for two and a half seconds, at the moment you have least idea what
  // any of them are about, and gone before you could want them. Everything it was
  // trying to say is said where it applies now — the ring names what a press is
  // about to do at the thing you pressed, and the line above the build bar says
  // what is in your hands and what a tap would cost.
  loop();
}

async function start() {
  const stored = localStorage.getItem('sns-name') ?? '';
  const name = params.get('name') ?? stored;
  const asked = preselectedWorld();
  let pendingError = null;

  if (asked) {
    try {
      await openWorld(asked, name);
      return;
    } catch (err) {
      // A link, a bookmark or a reload can name a shop that has since been
      // deleted or swept, and the server refuses rather than quietly inventing
      // it. Falling back to the menu is the whole reason it refuses: the old
      // behaviour was a world nobody could see in the list and nobody meant to
      // make. Anything else — the server being down — fails through as normal.
      if (!/no world|unknown world/i.test(err.message)) throw err;
      const url = new URL(location.href);
      url.searchParams.delete('world');
      history.replaceState(null, '', url);
      boot.textContent = 'Loading…';
      pendingError = `That shop is gone — ${err.message}`;
    }
  }

  boot.textContent = 'Loading…';
  const menu = new Menu(document.getElementById('menu'), pendingError);
  const picked = await menu.choose();
  await openWorld(picked.worldId, picked.name || name);
}

start().catch((err) => {
  document.getElementById('menu').hidden = true;
  boot.textContent = `Could not reach the shop: ${err.message}`;
});
