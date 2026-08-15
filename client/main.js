/**
 * CLIENT ENTRY POINT — input, render loop, and glue.
 */

import { Scene } from './render/scene.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { SECTIONS } from './sections.js';
import { showFixture, refreshFixture } from './fixture-menu.js';

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

  // The keyboard equivalent of holding the button, so both routes feel the
  // same rather than one of them firing instantly.
  if (k === 'e' || k === ' ') {
    e.preventDefault();
    sendHold(true);
  }
  // Every menu key is read off the same array the rail draws itself from, so a
  // new section is bound and labelled the moment it exists. Pressing the key of
  // the menu already open shuts it — the key that opened it has to close it.
  const sec = SECTIONS.find((s) => s.key === k);
  if (sec) {
    e.preventDefault();
    ui.toggleSection(sec.id);
  }

  // Build *mode* is a state of the world, not a menu, so it keeps its own key.
  if (k === 'g') ui.toggleBuild();

  // Spin the camera a quarter turn. Not E — that's hold-to-act, and a key that
  // does two jobs is how you harvest a crop while trying to look behind a shelf.
  if (k === ',') scene.rotateView(-1);
  if (k === '.') scene.rotateView(1);

  // In build mode the number row picks a fixture instead of a seed.
  if (k >= '1' && k <= '9') {
    if (ui.buildOn) ui.selectBuildToolByIndex(Number(k) - 1);
    else ui.selectCropByIndex(Number(k) - 1);
  }
  if (ui.buildOn && k === 'r') {
    ui.rotateBuild();
    refreshGhost();
  }
  // Escape backs out one layer at a time. UI owns the whole ladder — an open
  // menu, then whatever you're carrying, then build mode — because two
  // listeners racing over one key means Escape closes a panel and quits build
  // mode in the same press.
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (k === 'e' || k === ' ') sendHold(false);
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
  const kind = pointer.onCanvas ? ui.ghostKindForTool() : null;
  if (!kind) {
    if (ghostKey !== null || force) { ghostKey = null; scene.setBuildGhost(null); }
    ui.setBuildWarn(null);
    // No ghost outside build mode, but still ring whatever is under the
    // pointer: a tap opens that thing's menu now, and a target you can click
    // with nothing marking it is a secret rather than a feature.
    const over = pointer.onCanvas && !ui.holding ? scene.pickFixture(pointer.x, pointer.y) : null;
    scene.setAimTarget(over);
    ui.setAim(over);
    return;
  }
  const tile = scene.pickTile(pointer.x, pointer.y);
  if (!tile) {
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    ui.setBuildWarn(null);
    scene.setAimTarget(null);
    ui.setAim(null);
    return;
  }

  // Pointing at something you already own means *that thing*, and the answer is
  // its menu, not a red ghost telling you the tile is taken. This is the aiming
  // the Move tool never had: you name one fixture, and there is no guessing
  // which of the three shelves in reach you meant.
  const over = ui.holding ? null : scene.pickFixture(pointer.x, pointer.y);
  scene.setAimTarget(over);
  ui.setAim(over);
  if (over) {
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    ui.setBuildWarn(null);
    return;
  }
  // Validity involves a flood fill, so only ask when something actually moved —
  // the camera tracks the player, so the tile under a still pointer drifts and
  // this runs from the render loop too.
  const key = `${kind}:${tile.x}:${tile.z}:${ui.buildRot}:${ui.holding?.id ?? ''}`;
  if (key === ghostKey && !force) return;
  ghostKey = key;
  const verdict = scene.setBuildGhost({
    kind, x: tile.x, z: tile.z, rot: ui.buildRot, moveId: ui.holding?.id ?? null,
  });
  ui.setBuildWarn(verdict?.ok ? (verdict.warn ?? null) : null);
}

addEventListener('blur', () => keys.clear());

// ---- zoom -----------------------------------------------------------------
// Scroll the world to zoom. `deltaY` is not a unit anyone can rely on — a mouse
// notch is ~100 pixel-units, Firefox reports 3 *lines* for the same notch, and a
// trackpad streams small pixel deltas — so normalise by deltaMode first and cap
// the result, or one flick of a trackpad crosses the whole range.
const WHEEL_UNIT = { 0: 100, 1: 3, 2: 1 };   // pixels, lines, pages

canvas.addEventListener('wheel', (e) => {
  // Non-passive: without preventDefault the page scrolls (and on a Mac trackpad
  // a pinch, which arrives here as ctrl+wheel, zooms the whole browser instead).
  e.preventDefault();
  const steps = e.deltaY / (WHEEL_UNIT[e.deltaMode] ?? 100);
  scene.zoomBy(Math.max(-3, Math.min(3, steps)));
}, { passive: false });

// ---- drag joystick --------------------------------------------------------
// Press anywhere on the world and drag: you steer analog from wherever you
// pressed. Keys still work; whichever moved last wins.
//
// The stick draws nothing. It sits under your finger, which is exactly where
// you are trying to look, and a 144px disc parked over the tile you are walking
// towards costs more than the feedback is worth — the character moving *is* the
// feedback. Origin, radius and deadzone are all still here; only the art is gone.
const STICK_RADIUS = 72;      // px of drag for full speed
const STICK_DEADZONE = 8;

/** Under this much travel, a press was a tap — which in build mode means place. */
const TAP_SLOP = 7;
/** Past this, you're steering, so any action you were charging is abandoned. */
const HOLD_SLOP = 14;

const stick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, travel: 0 };

// ---------------------------------------------------------------------------
// Press and hold
//
// One button does three things, separated by how far and how long you move it:
// a drag steers, a tap places (in build mode), and holding still charges
// whatever standing here has armed. Only the transitions go to the server —
// it's a latch, not a stream.
// ---------------------------------------------------------------------------

let holdSent = false;

function sendHold(on) {
  if (on === holdSent) return;
  holdSent = on;
  net.send('hold', { on });
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  stick.active = true;
  stick.id = e.pointerId;
  stick.ox = e.clientX;
  stick.oy = e.clientY;
  stick.dx = 0;
  stick.dy = 0;
  stick.travel = 0;
  canvas.setPointerCapture(e.pointerId);
  sendHold(true);
});

canvas.addEventListener('pointermove', (e) => {
  if (!stick.active || e.pointerId !== stick.id) return;
  const dx = e.clientX - stick.ox;
  const dy = e.clientY - stick.oy;
  const len = Math.hypot(dx, dy);
  stick.travel = Math.max(stick.travel, len);
  const clamped = Math.min(len, STICK_RADIUS);
  const nx = len ? (dx / len) * clamped : 0;
  const ny = len ? (dy / len) * clamped : 0;
  stick.dx = len < STICK_DEADZONE ? 0 : nx / STICK_RADIUS;
  stick.dy = len < STICK_DEADZONE ? 0 : ny / STICK_RADIUS;
  // Once this is clearly a steer rather than a hold, drop the charge. A little
  // drift from a thumb resting still doesn't count.
  if (stick.travel > HOLD_SLOP) sendHold(false);
});

function endStick(e) {
  if (!stick.active || (e && e.pointerId !== stick.id)) return;
  // A press that never really moved is a tap, not a steer. That's what lets
  // build mode keep the drag-joystick: you still walk by dragging, and you
  // place by tapping, with no separate "pointer mode" to toggle.
  const tapped = e && stick.travel < TAP_SLOP;
  stick.active = false;
  stick.dx = 0;
  stick.dy = 0;
  sendHold(false);
  if (tapped) tapAtPointer(e.clientX, e.clientY);
}
canvas.addEventListener('pointerup', endStick);
canvas.addEventListener('pointercancel', endStick);
addEventListener('blur', () => { endStick(); sendHold(false); });
// A pointer released outside the canvas still has to let go of the action.
addEventListener('pointerup', () => sendHold(false));

/**
 * What a tap in build mode means, decided by what is on the tile you tapped.
 *
 * Bare ground builds. An existing fixture opens its own menu — move, turn,
 * empty, sell, and whatever else only that kind of thing can do. And while
 * you're carrying something, every tile is a destination for it, so nothing
 * opens until your hands are empty again.
 */
function tapAtPointer(cx, cy) {
  // A tap on something you own opens it, in or out of build mode. The two
  // gestures were already distinct — a hold uses a thing, a tap looks at it —
  // and there was no reason the looking half needed permission from a mode.
  // Not while your hands are full: then every tile is a home for what you carry.
  if (!ui.holding) {
    const over = scene.pickFixture(cx, cy);
    if (over) { showFixture(ui, over); return; }
  }

  // Building on bare ground is the only part that needs the mode. Without it, a
  // tap on empty ground is a tap away from whatever is open — the dismissal any
  // menu floating over a world is expected to have.
  const kind = ui.ghostKindForTool();
  if (!kind) { ui.closePanel(); return; }

  const tile = scene.pickTile(cx, cy);
  if (!tile) return;

  // The shape only means anything when buying a new one: what you are
  // carrying already knows what shape it is.
  // Which appliance, when the tool is one — the kind alone doesn't say whether
  // this is a blender or a toaster. What you're carrying already knows.
  const station = ui.holding?.station ?? (kind === 'station' ? ui.buildStation : null);
  const spec = {
    kind, station, x: tile.x, z: tile.z, rot: ui.buildRot, variant: ui.buildVariant ?? '',
  };
  const verdict = scene.setBuildGhost({ ...spec, moveId: ui.holding?.id ?? null });
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

function pollInput() {
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

  // The stick maps screen space onto the same rotated axes the keys use, and
  // keeps its magnitude so a small drag is a slow walk.
  if (stick.active && (stick.dx || stick.dy)) {
    dx = stick.dx + stick.dy;
    dz = stick.dy - stick.dx;
  }

  // Both routes above name a direction in *screen* space, which is only the
  // world's 45° diagonal while the camera sits in its home corner. Turn the
  // result by however many quarter turns the camera has taken and "up" keeps
  // meaning away-from-you — otherwise every rotation makes the controls lie.
  // One rotation per quarter, matching applyAxisAngle(Y): (x, z) -> (z, -x).
  for (let i = scene.quarter; i > 0; i--) {
    const t = dx;
    dx = dz;
    dz = -t;
  }

  if (dx !== lastInput.dx || dz !== lastInput.dz) {
    lastInput = { dx, dz };
    net.send('input', lastInput);
  }
}

// ---------------------------------------------------------------------------

function loop() {
  pollInput();
  if (ui.buildOn) refreshGhost();
  scene.render();
  requestAnimationFrame(loop);
}

const name = new URLSearchParams(location.search).get('name')
  ?? localStorage.getItem('sns-name')
  ?? '';

net.connect(name)
  .then(() => {
    document.getElementById('boot').remove();
    ui.toast('Drag to move · tap a plot to sow · walk up to things to use them');
    loop();
  })
  .catch((err) => {
    document.getElementById('boot').textContent = `Could not reach the shop: ${err.message}`;
  });
