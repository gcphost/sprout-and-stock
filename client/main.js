/**
 * CLIENT ENTRY POINT — input, render loop, and glue.
 */

import { Scene } from './render/scene.js';
import { Net } from './net.js';
import { UI } from './ui.js';

const canvas = document.getElementById('game');
const scene = new Scene(canvas);
const net = new Net();
const ui = new UI(net);
// The seed picker pins itself to a plot in world space, so it needs to project.
ui.scene = scene;

let latestState = null;
let ownedUpgrades = [];

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
  ui.refreshFixture(scene.allFixtures());
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
  if (!res.ok) ui.toast(res.error, true);
});
net.on('disconnected', () => ui.toast('Disconnected from the shop', true));

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
let lastInput = { dx: 0, dz: 0 };

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  keys.add(k);

  // The keyboard equivalent of holding the button, so both routes feel the
  // same rather than one of them firing instantly.
  if (k === 'e' || k === ' ') {
    e.preventDefault();
    sendHold(true);
  }
  // Hold Q for the seed wheel; release picks whatever you're aiming at.
  if (k === 'q' && !ui.wheelOpen) {
    e.preventDefault();
    ui.openWheel(pointer.x, pointer.y);
  }
  if (k === 'b') ui.showStock();
  if (k === 'u') ui.showUpgrades(ownedUpgrades);
  if (k === 'g') ui.toggleBuild();
  // The full build menu — opens build mode with it if you weren't in it.
  if (k === 'm') ui.showBuild();

  // In build mode the number row picks a fixture instead of a seed — the seed
  // wheel isn't reachable while you're building anyway, so no key does two jobs.
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
  if (k === 'q') ui.closeWheel(true);
  if (k === 'e' || k === ' ') sendHold(false);
});

// Where the pointer is, so the wheel can open under it and read the flick.
// `onCanvas` matters as much as the coordinates: the HUD floats over the world
// and swallows the clicks it covers, so a ghost or a target ring under an open
// panel would be promising something that cannot happen.
const pointer = { x: innerWidth / 2, y: innerHeight / 2, onCanvas: true };
addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.onCanvas = e.target === canvas;
  ui.aimWheel(e.clientX, e.clientY);
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
    scene.setAimTarget(null);
    ui.setAim(null);
    return;
  }
  const tile = scene.pickTile(pointer.x, pointer.y);
  if (!tile) {
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
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
    return;
  }
  // Validity involves a flood fill, so only ask when something actually moved —
  // the camera tracks the player, so the tile under a still pointer drifts and
  // this runs from the render loop too.
  const key = `${kind}:${tile.x}:${tile.z}:${ui.buildRot}:${ui.holding?.id ?? ''}`;
  if (key === ghostKey && !force) return;
  ghostKey = key;
  scene.setBuildGhost({
    kind, x: tile.x, z: tile.z, rot: ui.buildRot, moveId: ui.holding?.id ?? null,
  });
}

// Right-click-and-hold does the same thing, for mouse-only play.
addEventListener('contextmenu', (e) => { if (ui.wheelOpen) e.preventDefault(); });
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  e.preventDefault();
  ui.openWheel(e.clientX, e.clientY);
});
addEventListener('pointerup', (e) => {
  if (e.button === 2) ui.closeWheel(true);
});
addEventListener('blur', () => keys.clear());

// ---- drag joystick --------------------------------------------------------
// Press anywhere on the world and drag: a stick appears under your finger and
// you steer analog. Keys still work; whichever moved last wins.
const STICK_RADIUS = 72;      // px of drag for full speed
const STICK_DEADZONE = 8;

/** Under this much travel, a press was a tap — which in build mode means place. */
const TAP_SLOP = 7;
/** Past this, you're steering, so any action you were charging is abandoned. */
const HOLD_SLOP = 14;

const stick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, travel: 0 };
const stickEl = document.getElementById('stick');
const stickNub = document.getElementById('stick-nub');

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
  if (stickEl) {
    stickEl.style.left = `${e.clientX}px`;
    stickEl.style.top = `${e.clientY}px`;
    // The stick only appears once you actually steer. Showing it the instant
    // you touch down made every hold-to-act look like a mis-grab at a joystick.
    if (stickNub) stickNub.style.transform = 'translate(-50%, -50%)';
  }
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
  // Once this is clearly a steer rather than a hold, drop the charge and show
  // the stick. A little drift from a thumb resting still doesn't count.
  if (stick.travel > HOLD_SLOP) {
    sendHold(false);
    if (stickEl) stickEl.classList.add('on');
  }
  if (stickNub) stickNub.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
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
  if (stickEl) stickEl.classList.remove('on');
  if (tapped && ui.buildOn) tapAtPointer(e.clientX, e.clientY);
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
  const kind = ui.ghostKindForTool();
  if (!kind) return;

  if (!ui.holding) {
    const over = scene.pickFixture(cx, cy);
    if (over) { ui.showFixture(over); return; }
  }

  const tile = scene.pickTile(cx, cy);
  if (!tile) return;

  const spec = { kind, x: tile.x, z: tile.z, rot: ui.buildRot };
  const verdict = scene.setBuildGhost({ ...spec, moveId: ui.holding?.id ?? null });
  if (verdict && !verdict.ok) { ui.toast(verdict.reason, true); return; }

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

  if (dx !== lastInput.dx || dz !== lastInput.dz) {
    lastInput = { dx, dz };
    net.send('input', lastInput);
  }
}

// ---------------------------------------------------------------------------

function loop() {
  pollInput();
  if (latestState) ownedUpgrades = latestState.ownedUpgrades ?? ownedUpgrades;
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
    ui.toast('Drag to move · hold Q for seeds · walk up to things to use them');
    loop();
  })
  .catch((err) => {
    document.getElementById('boot').textContent = `Could not reach the shop: ${err.message}`;
  });
