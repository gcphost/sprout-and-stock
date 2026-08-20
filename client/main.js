/**
 * CLIENT ENTRY POINT — input, render loop, and glue.
 */

import {
  canPlaceEdges, edgeRun, canPaintGround, canPaintFaces, faceRun,
  groundStroke, strokeThick, GROUND_STROKE_MAX,
  faceAlong, isProp, isWalkableTile, workSpotOf, REACH,
} from '../shared/build.js';
import { E, SOLID, edgeBetween } from '../shared/edges.js';
import { Scene } from './render/scene.js';
import { Transport } from './transport.js';
import { UI } from './ui.js';
import { pillDrives } from './input.js';
import { RAIL_ITEMS } from './sections.js';
import { showFixture, refreshFixture, ONE_AT_A_TIME } from './fixture-menu.js';
import { showWorker } from './worker-menu.js';
import { showEdgeMenu, hasEdgeMenu, sameFamily, kindAt } from './edge-menu.js';
import { Menu, preselectedWorld, setMenuApi, enableJoin } from './menu.js';
import { bootSay, bootDone, bootFail } from './boot.js';
import { Award } from './award.js';
import { Tutor } from './tutor.js';
import { wireDrag, restorePos } from './panel-drag.js';
import { wireCorner } from './corner.js';
import { mix } from './audio/mix.js';
import { sfx } from './audio/sfx.js';
import { music } from './audio/music.js';
import { events } from './audio/events.js';

const canvas = document.getElementById('game');
const scene = new Scene(canvas);
const net = new Transport();
/**
 * The front door lists and creates shops. In the server build that is HTTP; in
 * the web build the Worker owns the store and answers the same four calls.
 *
 * Asked as a *capability* rather than off a build flag, because `api` is
 * precisely the capability in question — and because it leaves `main.js` with
 * no idea which build it is in, which is the thing the transport seam is for.
 */
if (net.api) setMenuApi((method, path, body) => net.api(method, path, body));
// ...and whether the front door offers to join somebody else's shop. Only a
// transport that can HOST one can be a guest in one — in the server build both
// people open the same URL and there is nothing to join. `host` is the
// capability, asked directly rather than off a build flag.
if (net.host) enableJoin(true);
const ui = new UI(net);
// The seed picker pins itself to a plot in world space, so it needs to project.
ui.scene = scene;
// The award card. It owns its own element and stops the world while it is up —
// see client/award.js.
const award = new Award(ui, document.getElementById('award'));
/**
 * The fitter who shows you round a shop you have just made — client/tutor.js.
 *
 * Built here beside the award for the same reason: both take the screen, both
 * own their own element, and neither is a panel. `ui.tutor` is the back
 * reference the Menu's two rows press — the switch and Replay — which is the one
 * place in `sections.js` that needs to reach it.
 */
const tutor = new Tutor(ui, net, scene, document.getElementById('tutor'));
ui.tutor = tutor;
// The one thing a panel needs from the shop floor's own input: a press it can
// keep down across a walk. Hung on `ui` the way `tutor` is, because the press
// bit and its one-exit release live here and a second sender of `press` would
// be a second opinion about whether the button is down. See `errandHold`.
ui.errandHold = (fire) => errandHold(fire);

let latestState = null;

/**
 * Where you stood on the previous snapshot, so the next one can ask whether you
 * have moved since.
 *
 * Kept here rather than read off `scene`, because what is wanted is the SHOP's
 * answer at 10Hz and not the interpolated body the renderer is easing between
 * two of them — which is never twice in the same place and would read as
 * walking for ever.
 */
let wasAt = null;

/**
 * Wake the audio up on the first real input, whatever it was.
 *
 * A browser will not run an `AudioContext` until the user has gestured, so this
 * cannot happen at import time. Capture phase and all three events on purpose:
 * the keydown handler below returns early for anything typed into an `INPUT`,
 * and somebody whose first act is to search the supplier has still clicked.
 *
 * It stays attached rather than removing itself on the first event — a listener
 * that unhooked on an event the browser did not count as a gesture would leave
 * the audio asleep for ever. `mix.arm()` is a no-op after the first call.
 */
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(ev, () => {
    if (!mix.armed) {
      mix.arm();
      sfx.load();
      music.start();
      return;
    }
    // Armed already, which since the speculative start below is the ordinary
    // case: the graph exists but the browser may have left the context
    // SUSPENDED because nobody had gestured yet. `armed` is a fact about our
    // own graph and says nothing about whether the browser is letting it
    // through, so returning on it alone would leave a game that is silent
    // forever — the one bug a speculative start can introduce.
    mix.ctx?.resume?.();
  }, { capture: true, passive: true });
}

/**
 * ...and try to start it before anybody has clicked anything.
 *
 * A browser will not run an `AudioContext` until the user has gestured, which
 * is why the listeners above exist — but "has gestured" is a fact about the
 * ORIGIN and not about this page load, so somebody coming back to a shop they
 * play often is usually allowed to start straight away. That is the whole of
 * what this buys: music over the loading screen and the shop list, instead of
 * silence until the first thing you happen to press.
 *
 * It cannot fail into silence, because the listeners above resume a suspended
 * context rather than checking `armed` and giving up.
 */
mix.arm();
sfx.load();
music.start();

/**
 * A click for anything you press in the HUD.
 *
 * One listener rather than a `sfx.play` at every call site, for the reason
 * `wireRows` gives about `data-act`: the menus already share one press path, so
 * a sound bolted onto each of them is the same line written twenty times and
 * missing from the twenty-first. Anything that is a button, or lives inside a
 * row that behaves like one, makes the noise — which is a rule about the markup
 * rather than a list of menus, so a panel added next week is covered already.
 *
 * The canvas is deliberately excluded. A tap on the world is a walk, a
 * placement, a pickup or the start of a drag, and every one of those already
 * makes a noise of its own when it lands — clicking here as well would report
 * the input and then report the outcome, which is the one-thing-two-sounds rule
 * this whole file is meant to hold.
 */
/**
 * The shop radio: three buttons and a screen that says what is on.
 *
 * Wired here rather than in `ui.js` because none of it is about the shop —
 * `ui.update` is handed a snapshot and this answers to the playlist, which the
 * server has never heard of. The screen is repainted from `music.nowPlaying()`
 * on a slow interval rather than every frame: a track changes about twice in
 * five minutes, and there is nothing else on it to keep up with.
 */
const radio = document.getElementById('radio');
if (radio) {
  radio.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-m]');
    if (!btn) return;
    if (btn.dataset.m === 'play') music.togglePlay();
    else if (btn.dataset.m === 'rep') music.toggleRepeat();
    else music.go(btn.dataset.m === 'next' ? 1 : -1);
    paintRadio();
  });
  wireDrag(radio, radio, () => 'radio');
  restorePos(radio, 'radio');
  // ...and it can be closed, which is the one thing a player who does not want
  // music on screen could not do. The Menu is the way back — client/corner.js.
  wireCorner(radio, 'radio', (msg) => ui.toast(msg));
  setInterval(paintRadio, 1000);
  paintRadio();
}

function paintRadio() {
  const track = music.nowPlaying();
  const playing = music.live;
  // Two copies, because the marquee scrolls by half the track's width — see
  // the #lcdtrack rules. Both have to say the same thing or the loop stutters.
  const said = track ? `${track.name} · ${track.by}` : 'Shop radio';
  for (const span of radio.querySelectorAll('#lcdtrack span')) span.textContent = said;
  radio.classList.toggle('off', !playing);
  radio.querySelector('[data-m="play"]').textContent = playing ? '❚❚' : '▶';
  radio.querySelector('[data-m="rep"]').classList.toggle('on', music.repeat);
}

addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el || el.closest('#game')) return;
  if (el.closest('button, [data-act], [data-row], [data-btn], .row, .tab, .rbtn')) {
    sfx.play('click');
  }
}, { capture: true, passive: true });

// The MCP `screenshot` tool ends up here: the server asks this tab to render
// its canvas to a PNG so an agent can see the change it just made.
net.onScreenshot(() => scene.screenshot());

// Handy in the browser console (and when an agent is poking at the page):
//   __sns.state          -> the last snapshot the server sent
//   __sns.scene          -> the renderer
//   __sns.net.send(...)  -> send a raw message
//   __sns.award.push({…}) -> put a milestone card up without earning it
//
// That last one is the only way to LOOK at the top of the ladder: `year-one` is
// 365 in-game days away, and a card nobody can see until then is a card whose
// wording gets fixed after it has shipped. It takes the same object the wire
// carries (`achieved` — see `milestoneNews` in server/sim/goals.js), so it is
// the real card rather than a mock of one:
//   __sns.award.push({ id: 'year-one', name: 'A year', blurb: 'Still here.', catchment: 420 })
window.__sns = { net, scene, ui, award, get state() { return latestState; } };

net.on('layout', (m) => {
  scene.buildWorld(m);
  // A tier moved. Not on the snapshot — see `events.layout`.
  events.layout(m);
  // The shop just re-flowed under the ghost, so whatever it was showing is
  // now judged against a different building.
  refreshGhost(true);
  // An open fixture menu has to follow its fixture through the re-flow — a
  // fixture that was turned comes back with a new id on the same tile.
  refreshFixture(ui, scene.allFixtures());
  // ...and so does a thing that is merely SELECTED, which is the case the menu's
  // own refresh cannot see. R turns the fixture you picked without opening it,
  // and the working spots are the only part of the marker a turn moves.
  ui.refollowSelection(scene.allFixtures());
  // ...and so does everything picked BESIDE it, whose rings are their own set of
  // markers and whose records the re-flow has just re-minted. This is also the
  // frame after a bulk verb landed, which is a re-flow by construction — so a
  // selection that did not follow the shop here would visibly empty itself the
  // moment you used it.
  ui.syncPickMarkers();
});
// A wall was painted — by you, or by whoever else is in the shop. Only the
// walls are rebuilt; nothing else in the building has moved.
net.on('paint', (m) => scene.setPaint(m));
net.on('catalog', (m) => { scene.setCatalog(m); ui.setCatalog(m); });
net.on('state', (m) => {
  latestState = m;
  scene.syncState(m, net.myId);
  ui.update(m);
  // ...and what pressing would DO, which is a question about the shop as much as
  // about the pointer and was only ever re-answered when the pointer moved.
  // Outside build mode `refreshGhost` runs on `pointermove` and nothing else, so
  // every hint went stale the moment the world changed under a still hand: walk
  // to a shelf and the pill still offers the walk, pick a crate up and it still
  // offers the lift, empty your hands and the put rows stay. With a finger it
  // never updates at all, because a tap is not a move — which is exactly the
  // input the rows became buttons for.
  //
  // On the snapshot rather than per frame: what you can do changes when the shop
  // does, at 10Hz, and this raycasts. Build mode already runs it every frame for
  // the ghost and is excluded so it is not run twice.
  //
  // ...but NOT while you are walking, which is the same claim `refreshGhost`
  // already makes about a camera drag and a trek, arriving by the one door that
  // was left open. The camera rides your body, so every step slides the whole
  // shop under a hand that has not moved — and this fires ten times a second, so
  // a walk across the floor lights up every shelf it drags past, opens and shuts
  // board cages, and rewrites the pill, all of it about targets nobody aimed at.
  // With a finger it is worse than untidy: there IS no hover, so the pointer is
  // wherever you last touched, and the only thing re-answering can do is be
  // wrong about it more often.
  //
  // Freezing rather than blanking, for the reason the trek gives: the aim you
  // are walking to is the one you chose, and it should stay lit until you get
  // there. The tick you stop is the tick it re-answers.
  //
  // Deliberately HERE and not inside `refreshGhost`: a `pointermove` during a
  // walk is somebody aiming, and that still has to work. What is being refused
  // is the clock, not the hand.
  // ...and the one press that is still down from a menu row several seconds ago.
  // Before `refreshGhost`, because letting go is a fact about what you can do
  // next and the hints are drawn from it.
  stepErrandHold(m);
  const at = ui.me();
  const stirring = at && wasAt && (Math.abs(at.x - wasAt.x) > 0.001 || Math.abs(at.z - wasAt.z) > 0.001);
  wasAt = at ? { x: at.x, z: at.z } : null;
  // ...and the things a finger has no way to let go of, once you have walked off
  // and stopped somewhere else. See `dropOnLeaving`. Before the hints, so the
  // pill is not still offering rows about a unit that has just been dropped.
  if (pillDrives() && !stirring) dropOnLeaving();
  // A HOVER IS A THING A TOUCHSCREEN DOES NOT HAVE, and this pass is where it
  // was being invented. `pointer` is the last place a finger touched, which is a
  // fact about a tap several seconds ago — and re-raycasting it ten times a
  // second turns the world moving underneath into aim: a hire wanders across the
  // spot you last tapped and lights up, a crate is set down there and rings, a
  // board cage opens on a shelf nobody is pointing at. It reads as the shop
  // highlighting things at random, because from the player's side that is
  // exactly what it is doing.
  //
  // So the pointer's claim on the canvas is spent by the tap that made it. The
  // rows still re-answer every snapshot — that is what this call is for — but
  // they answer about what the tap NAMED (`ui.fixtureRef`, see `pressHints`),
  // which is the one target the player chose and can see ringed. Every real
  // pointer event sets the flag again, so a tap works exactly as it did.
  if (pillDrives()) pointer.onCanvas = false;
  if (!ui.buildOn && !stirring) refreshGhost(true);
  // ...and the tour, which is nothing but a predicate over this snapshot. After
  // `ui.update` on purpose: every step asks a question about the UI as well as
  // about the shop ("is the supplier open"), so it has to be handed a HUD that
  // has already caught up with the frame it is being asked about.
  tutor.update(m);
  // Every sound in the game comes off this diff — see client/audio/events.js
  // for why it is a diff and not the log.
  events.update(m, net.myId);
  // A stopped world is a stopped soundtrack. The renderer already has to be
  // told the same thing (`scene.paused`) for the same reason: both run on the
  // page's clock rather than the shop's.
  music.setPaused(!!m.paused);
});
net.on('news', (m) => ui.toast(`📰 ${m.headline}`));
net.on('achieved', (m) => { award.push(m); sfx.play('milestone'); });
net.on('content-changed', () => ui.toast('New content added — it is live now'));
net.on('action', (res) => {
  if (res.ok) return;
  ui.toast(res.error, true);
  // A refusal is the one thing you cannot see: the shop simply does not do what
  // you asked, and the toast is at the top of the screen while you are looking
  // at your feet.
  sfx.play('error');
  // A refusal arriving in the gap between pressing Move and the snapshot that
  // says you're carrying it means the lift didn't happen, and the mode the menu
  // was holding open for the carry has nothing left to hold it open for.
  ui.abortMove();
});
net.on('disconnected', () => ui.toast('Disconnected from the shop', true));
/**
 * The shop you were a guest in has gone.
 *
 * Not a toast, which is what `disconnected` gets: a toast fades, and this is the
 * one disconnection with nothing on the other side of it — the world was on
 * somebody else's machine and this browser has no copy. A message that
 * disappears in front of a shop that has quietly stopped ticking is precisely
 * the illegible failure docs/browser.md says must not happen, so it is a veil
 * with a way out of it instead.
 */
net.on('host-gone', () => { import('./coop.js').then((m) => m.showHostGone()); });

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

  /**
   * The award card owns every key while it is up, and takes none of them with
   * it.
   *
   * It is the one thing in the game that stops the world, so a key that walked
   * you or opened a menu underneath it would be a press you cannot see the
   * effect of. `keys` is deliberately not added to first: a held direction is
   * released to a handler that has already returned, and the shop would be
   * walking at a key you let go of during the pause — the same trap flying the
   * camera in build mode had to be written around.
   */
  if (award.open) {
    e.preventDefault();
    if (k === 'escape' || k === 'enter' || k === ' ') award.dismiss();
    return;
  }

  keys.add(k);

  // Shift lights up everything that is the same design as the thing you have
  // picked — see `setKinPreview`. It selects nothing on its own: the key is what
  // makes shift-click discoverable, because until something on screen answers
  // the key there is no way to find out the click exists. Not `preventDefault`ed
  // and not returned on: Shift is a modifier, and every other binding in here
  // reads it (Tab cycles the palette backwards with it) rather than being
  // replaced by it.
  if (k === 'shift') ui.setKinPreview(true);

  // Every menu key is read off the same array the rail draws itself from, so a
  // new section is bound and labelled the moment it exists. Pressing the key of
  // the menu already open shuts it — the key that opened it has to close it.
  // Read off the same array the rail draws itself from, so a new menu is bound
  // and labelled the moment it exists — including the ones that are a bar rather
  // than a panel, which is why this walks RAIL_ITEMS and not just SECTIONS.
  const item = RAIL_ITEMS.find((s) => s.key === k);
  if (item) {
    e.preventDefault();
    if (item.mode) ui.pressBuild();
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
  // Space is the pause key, which is what every game this one sits next to has
  // trained. `p` is kept because it is what the button said for as long as it
  // has had a key on it — a shortcut that stops working is worse than a second
  // one that does, and neither can get ahead of the shop.
  //
  // Space is `preventDefault`ed, and that is not tidiness: the browser's own
  // meaning for it is "scroll the page", and where focus happens to sit on a
  // button it is "press that button" — so without this, a space with the clock
  // last clicked would toggle the pause twice and land back where it started,
  // which reads as the key not working at all.
  if (k === 'p' || k === ' ') {
    if (k === ' ') e.preventDefault();
    ui.setPaused(!ui.paused);
  }

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
    // ...and it is one at a time for the reason R is (`rotateSelected`), said
    // louder: your hands hold one fixture, so a Move over a selection of six
    // could only ever have been a Move of one of them.
    if (f && ui.manyPicked) ui.toast(ONE_AT_A_TIME);
    else if (f) liftAimed(f, { reopen: false });
  }
  // Escape backs out one layer at a time. UI owns the whole ladder — an open
  // menu, then whatever you're carrying, then build mode — because two
  // listeners racing over one key means Escape closes a panel and quits build
  // mode in the same press.
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'shift') ui.setKinPreview(false);
});

// ...and a key held while the window loses focus never comes up. `keys` has
// always had this hazard and lives with it — a stuck direction is fixed by
// tapping the key — but a stuck *preview* is a shop wearing seventeen frames
// with no key down to explain them, which reads as the marker being broken.
addEventListener('blur', () => ui.setKinPreview(false));

// Where the pointer is, so the build ghost knows what it is being aimed at.
// `onCanvas` matters as much as the coordinates: the HUD floats over the world
// and swallows the clicks it covers, so a ghost or a target ring under an open
// panel would be promising something that cannot happen.
const pointer = { x: innerWidth / 2, y: innerHeight / 2, onCanvas: true };
addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  // The lift lives HERE and nowhere else, because this is the one place the
  // pointer is worked out — a second offset applied by the canvas handler would
  // be overwritten by this one a moment later (it fires on the way up to the
  // window), and the ghost would flicker between two tiles as you slid.
  pointer.y = e.clientY - (drag.aiming ? TOUCH_AIM_LIFT : 0);
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

/**
 * Is a press driving the CAMERA rather than aiming at anything?
 *
 * A turn, a tilt, a one-finger pan, a two-finger pinch: in every one of them the
 * hand is holding a *view* and the shop is sliding past underneath, so the
 * pointer is over a different thing every frame without anybody having aimed at
 * one. What that looks like is rings and cages flickering across the shop as you
 * look around, which reads as the highlight being broken.
 *
 * Two drags are deliberately left out, and both are the opposite case — the
 * pointer is the aim and the world is holding still:
 *
 * - `drag.aiming`, the touch hold that lifts the ghost off your thumb. Freezing
 *   it would stop the thing following the finger placing it, which is the whole
 *   gesture.
 * - `drag.moving`, a fixture dragged out of the shop by its own press. The
 *   camera never gets that drag at all (see the `pointermove` handler), so there
 *   is nothing sliding and the preview has to track.
 */
const camBusy = () => !!pinch
  || !!spin?.turned
  || (drag.id !== null && drag.travel >= TAP_SLOP && !drag.aiming && !drag.moving);

function refreshGhost(force = false) {
  // A wall tool previews the line under the pointer, not a tile. While a drag
  // is live the drag owns the ghost — it knows the whole run, this only ever
  // knows the one segment you are hovering. Same for a brush and its area.
  if (edgeDrag || floorDrag || faceDrag) return;

  // ...and while a held press is WALKING you to what it named, for the same
  // reason said the other way round: the pointer is holding still and the SHOP
  // is moving, because the camera rides your body. So every frame of the journey
  // re-answers "what are you pointing at" with whatever has drifted under a hand
  // that has not moved — rings light on shelves you never aimed at, board cages
  // open and close, and the pill rewrites itself, all of it about targets nobody
  // chose. The press has already made its choice (`spin.trek`), so the last aim
  // is the right one for the whole trip: freezing keeps the thing you are
  // walking to lit, rather than blanking the screen and then lighting whatever
  // you happen to arrive next to. Cleared by `cancelTrek`, which every way out
  // of the press goes through.
  //
  // ...and the same claim about every other way the shop moves under a still
  // hand: a turn, a tilt, a pan, a pinch. Same symptom, same answer — the
  // pointer only means something while the thing under it is holding still, and
  // during a camera drag nobody is aiming at anything. See `camBusy` for the two
  // drags that are deliberately NOT in it.
  if (spin?.trekking || camBusy()) return;

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
    ui.setPressHints([]);
    ui.setBuildVerdict(null);
    return;
  }

  const edgeKind = pointer.onCanvas ? ui.edgeKindForTool() : null;
  if (edgeKind !== null) {
    const seg = scene.pickEdge(pointer.x, pointer.y);
    if (!seg) { scene.setEdgeGhost(null, null); ui.setBuildVerdict(null); return; }
    // The Doorway tool over a doorway that is already there does not build one —
    // it opens it (see `endPress`). So the bar goes amber, which is the colour
    // everything openable wears under the pointer, and no verdict is printed:
    // green would be promising a purchase that is not going to happen.
    if (sameFamily(scene.storeLayout, seg, edgeKind)) {
      scene.setEdgeGhost([seg], 'aim');
      ui.setBuildVerdict(null);
      scene.setAimTarget(null);
      ui.setBoardTip(null, null);
      scene.setPersonAim(null);
      canvas.style.cursor = 'pointer';
      ui.setAim(null);
      ui.setPressHints([]);
      return;
    }
    const verdict = canPlaceEdges(scene.storeLayout, [seg], edgeKind);
    scene.setEdgeGhost([seg], verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no');
    ui.setBuildVerdict(verdict);
    scene.setAimTarget(null);
    ui.setBoardTip(null, null);
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(null);
    ui.setPressHints([]);
    return;
  }
  scene.setEdgeGhost(null, null);

  // A finish previews the one FACE under the pointer, which is the half of this
  // tool nobody could guess: the wall you are pointing at has two sides and the
  // gesture picks one, so the preview has to stand on the side it picked. Before
  // the ground brush and after the wall tools, which is where it sits in the
  // pointer's own order of questions: a line first, then which side of it, then
  // the square.
  const finish = pointer.onCanvas ? ui.faceForTool() : undefined;
  if (finish !== undefined) {
    const face = scene.pickFace(pointer.x, pointer.y);
    const faces = face ? [face] : [];
    const verdict = faces.length
      ? canPaintFaces(scene.storeLayout, faces) : { ok: false, reason: 'nothing there to paint' };
    scene.setFaceGhost(verdict.ok ? faces : [], 'ok');
    // Nothing said when there is no wall under the pointer. A refusal printed on
    // every frame you spend crossing the shop floor is a tool that reads as
    // broken while you carry it to the wall you meant.
    ui.setBuildVerdict(verdict.ok ? verdict : null);
    scene.setAimTarget(null);
    ui.setBoardTip(null, null);
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(null);
    ui.setPressHints([]);
    return;
  }
  scene.setFaceGhost(null, null);

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
    ui.setPressHints([]);
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
    // EVERY MARKER BELOW HOLDS STILL WHILE A RING IS WINDING — see `charging`.
    // A return rather than a set of guards, and that is the point: what is
    // wanted is not a different answer, it is the *last* answer, and leaving
    // every marker exactly as the press found it is the only way to be sure
    // nothing under here re-derives one. The floor ghost above is skipped for
    // `dropping()` already, so a square you are setting a crate down on is
    // untouched too.
    if (charging()) {
      // ...except the ring round a PERSON, which is the one marker that has to
      // be put away rather than frozen. Everything else here marks something
      // that stands still, so holding the last answer holds it in place; a hire
      // walks, so their marker is re-positioned off the mesh every frame and a
      // frozen one goes for a walk with them. Nothing you can charge is a
      // person — a charge is a fixture, a crate or a tile — so there is never a
      // reason for one to be lit while a ring is winding.
      scene.setPersonAim(null);
      canvas.style.cursor = '';
      return;
    }
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
    // ...and not where the pill drives, for the reason the aim frame is not:
    // this ring and the cursor beside it are both "you could press this", which
    // is a sentence with no place to stand on a touchscreen — the press and the
    // pointing are one event, so it can only ever ring somebody a tenth of a
    // second before opening them, or ring whoever has since walked under the
    // last place a finger touched. A tap on a hire opens them either way.
    const person = pointer.onCanvas && !ui.demolishArmed() && !pillDrives()
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
      ui.setPressHints([]);
      // A person is not a square, and this branch owns the ghost now (see the
      // guard above) — so pointing at a hire with your hands full has to put it
      // away rather than leave the last square lit.
      if (dropping()) scene.setFloorGhost(null, null);
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
    // ...and it stays named for a moment after the pointer leaves it, which is
    // what makes the dwell worth paying for — see `heldBoard`.
    const held = boardTakes() ? heldBoard(aim) : null;
    const board = held?.board ?? null;
    // The box under the pointer, when a full shoulder has turned it into the
    // square it stands on — see `haulSquare`. Worked out up here because two
    // markers read it: the ring round the crate has to stand down (it would be
    // advertising a press that names a cell, which is the green-ghost bug said
    // with a highlight), and the green square below has to be lit on the crate's
    // own cell rather than on whatever `pickTile` finds behind it.
    const onPile = aim?.crate ? haulSquare(aim.crate) : null;
    // `held.f` last, and only reachable when the pointer is on nothing: the
    // stick is what draws the cage while your hand wanders off the shelf, and
    // the marker has to be on the unit that pile stands on or there is nothing
    // to measure the cage against.
    // ...and NOT where the pill drives, because this whole marker is a hover.
    //
    // The aim frame answers "what would a press land on", which is a question
    // worth asking *before* you press — and a finger has no before. The press
    // and the aim are one event, so what it draws is a frame that appears under
    // your thumb on the tap and is replaced by the selection ring a moment
    // later: two marks for one press, the first of which was only ever there to
    // tell you the second one was coming. It reads as the shop flickering.
    //
    // The selection is the touch answer and it is strictly better here: it is
    // what the tap actually did, it survives the walk, and it is the thing the
    // pill's rows are about. Same call `setBoardTip` makes just below, for the
    // same reason — see `tipOn`.
    scene.setAimTarget(
      pillDrives() ? null : ((onPile ? null : aim?.crate) ?? aim?.fixture ?? held?.f ?? null),
      'aim',
      pillDrives() ? null : board,
    );
    // ...and what that pile IS, which the cage cannot say. Off `aim.board`
    // rather than off `board`, so it is not gated on `boardTakes`: the cage is
    // a promise about a press and this is a label, and the moment you most want
    // to know what a board holds and how full it is, is with an armful in your
    // hands looking for somewhere to put it.
    // ...and it lingers with the cage. The card follows the pointer as it always
    // has, which is what you want here: the thing you were reading stays beside
    // your hand while it moves rather than sitting back on the shelf you left.
    // ...and it is a HOVER, which is a thing a touchscreen does not have. There
    // it becomes a card pinned to wherever you last tapped, naming a board that
    // outlives the tap, over a shop that keeps moving underneath it: walk away
    // and the name of a shelf you are nowhere near sits in the middle of the
    // floor with nothing to say what it is about. Nothing takes it down, because
    // the only thing that ever did was the pointer going somewhere else — and
    // since the hints are re-answered on every snapshot now, "the pointer" is a
    // position from several seconds ago that no longer means anything.
    //
    // So it is suppressed where the pill drives (`pillDrives`), which is also
    // where it stopped being needed: the same tap puts that pile's verbs on
    // screen, and what it is and what it costs are one press further in, in the
    // unit's own menu.
    const tipOn = pillDrives() ? null : (aim?.fixture ?? held?.f ?? null);
    ui.setBoardTip(
      shelfById(tipOn?.id),
      (tipOn === held?.f ? held.board : aim?.board) ?? null,
      pointer.x, pointer.y,
    );
    // The other half of "you can press this", the way it is for a hire: the cage
    // says which pile, the cursor says there is one to take at all. A crate gets
    // no cursor because a crate is a whole object you can see you are on; a board
    // is a region of a thing that was one target until now.
    if (board) canvas.style.cursor = 'pointer';
    // Only the fixture: this names what a build verb would act on, and there is
    // no build verb that takes a crate.
    ui.setAim(aim?.fixture ?? null);

    // ...and a way through, which is the one openable thing in the game with no
    // tile of its own and so the one thing no marker could ever be drawn on. A
    // bar of the aim frame's own amber along the line, and the cursor to say
    // there is something there at all — same pair a hire gets, and for the same
    // reason: the menu is unreachable if you cannot tell you are pointing at it.
    // Asked through `pickWay` so the highlight and the hold cannot disagree.
    // Same again for the amber bar along a doorway. It is already build-mode
    // only, which on a phone is the mode where the finger is placing things —
    // so a bar lighting along the wall under the last tap is a highlight for a
    // press nobody is about to make. The hold that would open it is switched off
    // anyway (`HOLD_OPENS`), so nothing is lost by not advertising it.
    const way = pointer.onCanvas && !pillDrives()
      ? pickWay(pointer.x, pointer.y, !!(aim?.fixture || aim?.crate)) : null;
    scene.setEdgeGhost(way ? [way] : null, way ? 'aim' : null);
    if (way) canvas.style.cursor = 'pointer';

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
    //
    // A crate yields it too, but only for a shoulder that is already full
    // (`onPile`, above): the box's OWN cell and never `pickTile`'s answer, since
    // a crate is drawn most of a tile up-screen of the ground it stands on, so
    // the tile under the pointer is the one BEHIND it — the same reason
    // `pickFixture` exists. Through the same function the press uses, or the
    // ghost lights one square and the hold fills another.
    //
    // ...and where the pill drives, the pointer is not asked: it is a stale tap
    // that has already walked you somewhere, so it names a square you are no
    // longer beside. `myTile` is the answer there — see it for why a finger
    // cannot make this choice at all. `pointer.onCanvas` goes with it, because a
    // press made FROM the pill is a pointer that is not on the canvas, which is
    // every setdown on a phone.
    const aimed = pointer.onCanvas ? scene.pickTile(pointer.x, pointer.y) : null;
    const drop = dropping() && !aim?.fixture && (!aim?.crate || onPile)
      ? (onPile ?? (pillDrives() ? myTile() : aimed)) : null;
    const show = drop && inReachOf(drop);
    if (dropping()) {
      scene.setFloorGhost(show ? [drop] : null, show ? (canDropAt(drop) ? 'ok' : 'no') : null);
    }
    // ...and what pressing would actually DO, in words, for every button that
    // means something here. Computed off the same four things the markers were
    // just drawn from, so the pill cannot describe a target the highlights
    // disagree about — see `pressHints`.
    ui.setPressHints(pressHints({ aim, board, onPile, drop: show ? drop : null }));
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
    ui.setPressHints([]);
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
  ui.setPressHints([]);
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
// as routing to it. Tap a shelf with an armful, and you walk to the side you can
// work from and stock it, with no second input at all.
//
// Empty-handed it takes two, and the split is `openInTwo`: a press selects, a
// second opens the menu, and a DOUBLE press is the walk. Carrying something is
// what makes the walk the obvious reading of a tap — there is nothing to ask a
// shelf while your arms are full — and with empty hands most of what you point
// at a unit for (its price, its board, turning it, moving it) is a question you
// ask from where you are standing.
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
 * How far above a finger the build ghost sits once you are aiming it.
 *
 * A hover is what makes building on a mouse honest: the ghost is green or red
 * under the pointer for as long as you like before anything is spent. A finger
 * has no hover — the press IS the aim — so on a phone the verdict arrives under
 * the one thing on the screen guaranteed to be covering it, and a tap places on
 * release having shown you nothing. That reads as the shop refusing placements
 * at random, because the red frame was there and your thumb was on it.
 *
 * So a held press lifts the ghost clear (`drag.aiming`) and sliding nudges it
 * rather than panning the shop. In CSS pixels and deliberately about a
 * fingertip's worth: less and the thumb still covers the tile, more and the
 * thing you are placing stops reading as being on the end of your finger.
 */
const TOUCH_AIM_LIFT = 72;

/**
 * Does a long press open what you are pointing at?
 *
 * Yes — as the third way in, beside the two `openInTwo` gives you. A tap
 * selects and a second tap opens, which is right for a unit across the shop
 * (the first press spends itself on the walk, and on naming the thing R and M
 * act on) and is two presses for the one case where you already know what you
 * want, which is the menu. Holding says that directly, and it is the same
 * gesture on a finger as on a mouse.
 *
 * It was off for four steps and the reason it went off is worth keeping: with
 * `take` on the tap, a hold that opened things fought the two gestures that
 * were *already* holds — pulling a board into a crate, and lifting a crate off
 * a pile. That is what `drag.took` settles. Both of those arm on the way DOWN,
 * so by the time this timer fires the press has already committed to being a
 * pull, and this stands aside rather than putting a menu over it.
 *
 * In build mode the hold has a job of its own regardless (`liftAimed`), and it
 * is the job the gesture was always shaped for: the ring winds in on the thing
 * you are pointing at, and at the end of it that thing is in your hands.
 */
const HOLD_OPENS = true;

const drag = {
  id: null,
  ox: 0, oy: 0,     // where it started, for the tap/drag verdict
  lx: 0, ly: 0,     // where it was last frame, for the pan delta
  ax: null,         // ...and the point the turn and tilt are counted off, when it turns
  turns: false,     // does this drag turn the view, or slide it? See below.
  spun: false,      // ...and it has: past the slop, every pixel turns the view
  travel: 0,
  timer: null,
  pressedAt: 0,     // when it started, for the wind-in the frame loop draws
  done: false,      // a long press already fired; the release means nothing
  lift: null,       // the fixture this press would pull, once it moves
  moving: false,    // ...and it did: this drag is carrying something
  took: false,      // this press armed goods — so its hold is a pull, not a look
  touch: false,     // a finger or a pen, which has no hover to build with
  aiming: false,    // ...so this held press owns the ghost. See `TOUCH_AIM_LIFT`
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
 * The square you are standing on — which is what "put it down" means on a phone.
 *
 * A setdown names a cell, and on a desktop the pointer names it: eight squares
 * are in reach, they are a tile apart on screen, and `placeAt` is the whole
 * gesture for choosing between them without walking onto the one you chose.
 *
 * A finger has no version of that. Pointing IS tapping, and a tap on a nearby
 * tile is a walk (`walkTo`) — so the only way to name the square next to you was
 * to go and stand on it, by which point it is not the square next to you any
 * more. Every attempt lands somewhere else, and it looks like the drop being
 * inaccurate rather than like the aim being impossible.
 *
 * So there the pointer is not asked at all and the answer is your own feet: one
 * cell, always in reach, always the one you can see yourself on. What is lost is
 * the choice between the eight, which is a choice a phone never had.
 */
function myTile() {
  const me = ui.me();
  return me ? { x: Math.round(me.x), z: Math.round(me.z) } : null;
}

/**
 * The put-aim used to live on the POINTER, and this is where it was.
 *
 * `syncStockAim` armed a unit as somewhere your armful should go the moment you
 * hovered it, because with one button the hold had to be able to mean either
 * direction and your hands were the only thing that could say which. That is
 * exactly the guess the two buttons delete: a board is a take and a press of the
 * right button is a put, so nothing has to be inferred from what you are
 * holding and no errand is set by a pointer that only drifted past. `armPut`
 * sends the same `place` message, off a press, on purpose.
 */
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

/**
 * ...and STANDING on one, which is a different question and reads like the same.
 *
 * `atWorkSpotOf` is "within reach of a spot", which is what a press needs to
 * know — you can work a shelf from a tile away, and that is the whole point of
 * it. Whether the walk would MOVE you is the tile itself: from the cell
 * diagonally off the corner you are in reach of two spots and standing on
 * neither, so a walk really does take you somewhere, and the pill was hiding the
 * one row that says so — over the whole of the in-reach branch, since being near
 * a fixture at all is nearly always being near one of its spots.
 *
 * Rounded rather than a radius, which is `Math.round(p.x) === plot.x` again: the
 * server routes to a spot and stops on it, so "will this move me" is exactly
 * "am I on that tile".
 */
function onWorkSpotOf(f) {
  const me = ui.me();
  if (!me || !f) return false;
  const spots = ui.spotsFor(f);
  const at = spots.length ? spots : [workSpotOf(f)];
  return at.some((s) => Math.round(me.x) === s.x && Math.round(me.z) === s.z);
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

/**
 * What the RIGHT button means here — the put half of every goods gesture.
 *
 * One function for all three addresses a put has, because they are one sentence
 * ("this is where what I am holding goes") with three kinds of target, and split
 * across three call sites they drift: the press would arm one of them and the
 * release would tap a different one.
 *
 * It arms on the way DOWN and answers what a *tap* would mean, which is the
 * grade the whole scheme rests on: **a tap is one unit, a hold is the lot.** The
 * hold needs an errand standing before the ring can wind, and the tap needs to
 * know what it was pointing at before the pointer moved.
 *
 * `ring: false` is a target with nothing to hold for — a lone crate takes one
 * unit on a tap and has no "pour the armful in" verb, and a unit across the shop
 * can only be walked to. Arming a ring that cannot complete is the green-ghost
 * bug wearing a countdown.
 *
 * Null hands the press back to the button's own ladder: a turn if you drag, then
 * `ui.escape()`, then — with nothing left to back out of — a walk, exactly as the
 * left button ends. Nothing about backing out changed except that it now loses to
 * a positive act at both ends, which is the same precedence the left button and
 * the tap already use.
 */
function armPut(cx, cy) {
  if (!dropping()) return null;

  // A crate first, for the reason the tap does it first: a box is drawn most of
  // a tile up-screen of the ground it stands on, so the floor under the pointer
  // is nearly always the wrong answer while one is there.
  const crate = aimCrate(cx, cy);
  if (crate) {
    // ...unless there is already one on your shoulder, in which case the box is
    // the square it stands on — see `haulSquare`. Ahead of the two tests below
    // because both are about naming a container, and this is naming a cell: a
    // pile is a perfectly good place to put another box, and reach is the
    // square's own test rather than the crate's.
    const at = haulSquare(crate);
    if (at) {
      if (!canDropAt(at)) return null;
      net.send('place', { x: at.x, z: at.z });
      return { kind: 'ground', ring: true };
    }
    // Lone crates only, the same line the left button draws: one unit INTO the
    // box under two others is the same unanswerable "which one" as one out.
    if (crate.stacked || !inReachOf(crate)) return null;
    return { kind: 'crate', crate, ring: false };
  }

  const hit = pickAimed(cx, cy);
  if (hit?.f) {
    // Out of reach is a walk, and the walk names the unit — so arriving leaves
    // the put armed. `ring: false` because there is nothing to wind here yet;
    // what the hold buys is the JOURNEY (see `spin.trek`), and the ring winds on
    // arrival off the errand the walk set, under the button you never let go of.
    if (!atWorkSpotOf(hit.f)) return { kind: 'walk', f: hit.f, ring: false };
    net.send('place', { fixture: hit.f.id });
    // A skip has no boards, so there is no "this pile" to name and no one-unit
    // meaning for a tap: you are either getting rid of what you are carrying or
    // you are not. `ring: true` and no tap at all — the hold IS the gesture,
    // and the ring is the consent, which is the one thing this action needs
    // more than any other in the game because nothing undoes it.
    //
    // Without its own kind it fell through to `board` below and a right-tap
    // sent `shelf-one` at a fixture that is not a shelf. The server said no,
    // silently, the way it says no to every stray message — so the skip read as
    // a thing you simply could not put anything in.
    if (hit.f.kind === 'bin') return { kind: 'bin', f: hit.f, ring: true };
    // ...and an appliance, which fell through to `board` the same way the skip
    // did and with the same result: a right-tap sent `shelf-one` at a machine,
    // and the shop answered "no such shelf" — an error about a thing you were
    // not pointing at. The hold worked throughout, so it read as a hopper you
    // could only fill by the armful. `ring: true` keeps that hold exactly as it
    // was; what the tap buys is one ingredient, which is what a recipe wants.
    // No board rides along, unlike the shelf below: a hopper's piles are inside
    // the machine and nothing draws them as themselves, so there is no pile the
    // pointer could be naming.
    if (hit.f.kind === 'station') return { kind: 'station', f: hit.f, ring: true };
    // The board under the pointer rides along as the pile to put down, and it is
    // only a hint: `tapBoard` reads it off your HANDS, so pointing at the bread
    // with milk in them puts the milk on the unit. Naming the board is what makes
    // "top this one up" the obvious gesture it looks like.
    // The right button names a pile the same way the left one does, so it picks
    // it too — one board, one selection, whichever direction the goods went.
    const itemId = ripeBoard(hit.f, hit.board);
    pickBoard(hit.f, itemId);
    return { kind: 'board', f: hit.f, itemId, ring: true };
  }

  // A square beside you. Named without walking you onto it (`placeAt`), so the
  // box lands where you were pointing rather than under your feet — and only
  // over ground the drop can use, which is the same test the green square is
  // drawn from, so the press and the picture cannot disagree.
  const tile = scene.pickTile(cx, cy);
  if (tile && canDropAt(tile)) {
    net.send('place', { x: tile.x, z: tile.z });
    // No tap meaning. A right click that put a single unit on the floor would be
    // a gesture nobody asked for standing where "back out" lives, so a quick
    // click on the floor still backs out and only the hold sets anything down.
    return { kind: 'ground', ring: true };
  }
  return null;
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

/**
 * A box on the floor, while you are carrying one, is a SQUARE.
 *
 * The one target on the shop floor that had no answer for a full shoulder.
 * Pointing at a crate names the crate everywhere — which is right with your
 * hands, where the gestures a box offers are all about single units (`tapCrate`
 * puts one in, a tap takes one out) — and with a crate already up there none of
 * them can happen: `tapCrate` opens with "put the crate down first", and the
 * hold arms nothing at all (`ring: false`). So the cell your box wanted to go on
 * was the one cell in reach you could not name, and the only way to put two
 * boxes together was to find bare ground and carry the other one over.
 *
 * The shop has always been willing: `dropGoods` tops up a crate of the same
 * thing standing on the named cell, spends a free board in it if there is one,
 * and stacks a new box on the same cell when there is not — which is a pile, and
 * a pile is a thing you can peel. Only the aim was missing.
 *
 * A pile is fine here, unlike everywhere else a crate is pointed at: `stacked`
 * exists to stop "which of these did you mean", and setting a box DOWN is not a
 * question about any of the ones already there. Hands are deliberately left
 * alone — an armful pointed at a lone crate still puts one unit in, which is a
 * gesture that works and one the shoulder has no version of.
 */
function haulSquare(crate) {
  if (!crate || !myHaul()) return null;
  return { x: Math.round(crate.x), z: Math.round(crate.z) };
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
  drag.aiming = false;
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
 * How long a held press lasts when it was made by TAPPING a hint.
 *
 * The pill's rows are buttons on a touchscreen (`pressHints`), and half of them
 * describe a press you have to keep down: the ring winds only while `press` is
 * true (`Game.stepActions`), and a pull empties a board across the second it
 * takes rather than at the end of it. A finger tapping a row in a list is not
 * holding anything, so the press has to be held on its behalf and let go again.
 *
 * This is the BACKSTOP and not the mechanism — `pillLetGo` is what normally ends
 * one, on the pointerup. It is here for a press whose release never arrives: a
 * hidden tab, a pointer captured out from under the row, a browser that swallows
 * the event. A stuck `press` is a shop that goes on doing things nobody asked
 * for, which is the state `release`'s one-exit rule exists to prevent. Longer
 * than `ACTION_TIME` (0.5s) and `PULL_SECONDS` (1s) with room for a round trip,
 * so it can never cut short a hold somebody is genuinely making.
 */
const PILL_HOLD_MS = 1800;
let pillTimer = 0;

/**
 * Make a hint's press, from the pill rather than from the shop floor.
 *
 * `fire` is the same call the pointer handler makes — never a second opinion
 * about what that press means, which is the rule the whole of `pressHints` is
 * written under. What this adds is the half a list cannot express: a press has a
 * beginning and an end, and a row in a list has neither.
 *
 * Any previous pill press is let go first. Two rings cannot wind at once and the
 * shop only has one `press` bit, so a second row tapped while the first is still
 * held would otherwise be one press the release clock closes twice.
 */
function pillPress(fire, holdIt = false) {
  endPillPress();
  fire();
  if (!holdIt) return;
  pillAt = performance.now();
  hold();
  pillTimer = setTimeout(endPillPress, PILL_HOLD_MS);
}

/** Let go of whatever the pill was holding. Idempotent, like `release`. */
function endPillPress() {
  if (pillTimer) { clearTimeout(pillTimer); pillTimer = 0; }
  pillAt = 0;
  release();
}

/** When the finger went down on a pill row, or 0 for no held pill press. */
let pillAt = 0;

/**
 * A button that says "go there and do it", holding the press for the journey.
 *
 * Nothing in this game fires with the button up (`Game.stepActions` charges on
 * `p.pressing`), and a walk-to errand does not change that — it names the target
 * and the ring still has to wind on arrival. On the shop floor that is free and
 * invisible, because the gesture that named the thing IS a finger holding a
 * button: press on the board, walk, arrive with it still down, ring, take. Same
 * trick `spin.trek` is built on, said about the left button.
 *
 * A MENU ROW has no version of it. A click is down and up in the same
 * millisecond, so the shelf's own Take button sent you across the shop and left
 * you standing at the board with the action armed at zero and nothing pressing
 * it — a button whose tooltip promises an armful and delivers a walk. It is not
 * even wrong-looking: you go where you were sent, and then nothing.
 *
 * So the press is held on your behalf, exactly as `pillPress` does for the pill,
 * and let go when the thing you asked for HAPPENS rather than on a clock — the
 * whole difference is that this one has a walk in the middle of it and the pill's
 * rows are about what is already in front of you. `acted` is the count the sim
 * keeps of things you have actually done (see `stepActions`), so watching it
 * cannot mistake a long walk for a failure.
 *
 * The cap is a backstop and nothing else, for the errand that never lands: the
 * shelf was sold, somebody emptied the board, the route never completed. A stuck
 * press is a shop that goes on doing things nobody asked for, which is the state
 * `release`'s one-exit rule exists to prevent.
 */
const ERRAND_HOLD_MS = 20000;
let errandAt = 0;
let errandActs = 0;

function errandHold(fire) {
  endPillPress();
  endErrandHold();
  errandActs = ui.me()?.acted?.n ?? 0;
  fire();
  errandAt = performance.now();
  hold();
}

/** Let go of whatever an errand was holding. Idempotent, like `release`. */
function endErrandHold() {
  if (!errandAt) return;
  errandAt = 0;
  release();
}

/**
 * Watch the one held press that outlives its own gesture.
 *
 * On the snapshot rather than on a timer, because what ends it is a fact about
 * the shop — you did the thing — and the shop says so ten times a second.
 */
function stepErrandHold(m) {
  if (!errandAt) return;
  const me = (m?.players ?? []).find((p) => p.id === net.myId) ?? null;
  const acts = me?.acted?.n ?? 0;
  if (acts !== errandActs || performance.now() - errandAt > ERRAND_HOLD_MS) endErrandHold();
}

/**
 * The finger came off a pill row, which is letting go and nothing else.
 *
 * A ROW THAT SAYS HOLD MUST BE HELD, and a quick tap on one has to do nothing at
 * all. Completing it on the clock was tried and is wrong for the reason the hold
 * exists: the ring IS the consent, and it is worth most on the one row that can
 * never be undone — a tap that emptied your arms into the skip is exactly the
 * stray press `armPut` refuses to give the bin a tap for. So the release is
 * unconditional, the ring gets as long as you actually held it, and a tap ends
 * before anything fires — which is the same nothing a quick right-click does in
 * the shop.
 *
 * That leaves `pillPress`'s clock as a BACKSTOP rather than the mechanism: a
 * pointerup that never arrives (the tab hidden, a pointer captured elsewhere)
 * would otherwise leave the press stuck down, and a stuck press is a shop that
 * goes on doing things nobody asked for.
 *
 * On the window rather than on the row, because the row is rewritten several
 * times a second and because a finger that slid off it before lifting has still
 * let go — the same reason the canvas captures its own pointer.
 */
function pillLetGo() {
  if (!pillAt) return;
  endPillPress();
}
addEventListener('pointerup', pillLetGo);
addEventListener('pointercancel', pillLetGo);

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
// It orbits freely — any angle, tracking the hand — while `,`/`.` still step
// between the four corners. That split is the point rather than an
// inconsistency: `scene.quarter` is an integer everything else reads (WASD is
// remapped through it, and so is which way a fixture faces), so it rounds an
// off-corner view to the nearest one, and the keys are how you square the shop
// back up when the rounding has stopped agreeing with what you can see.
//
// The world follows your hand, on both axes: drag right and the shop turns
// right, which is `,`; drag down and the far side of the shop tips toward you,
// which raises the camera. No easing on either path — see `spinView` — because
// the shop is being held rather than sent somewhere.
//
// The two are deliberately not the same speed. A quarter turn is 90px because
// yaw is unbounded and you spend it in whole corners, while the whole tilt is
// 46° end to end: at the same rate a flick would cross it twice, so it is four
// times slower and the full sweep is about 180px.
// ---------------------------------------------------------------------------
const SPIN_STEP = 90;         // px of drag per quarter turn
const SPIN_RAD_PER_PX = (Math.PI / 2) / SPIN_STEP;
const TILT_STEP = 4;          // px of drag per degree of pitch
const TILT_RAD_PER_PX = (Math.PI / 180) / TILT_STEP;

let spin = null;

/**
 * Turn a drag into two angles, and hand back the anchor to carry on from.
 *
 * The anchor walks along with the pointer rather than the whole distance being
 * re-read, so these are frame deltas for the same reason `panBy` is fed one:
 * turning by the total again on every event accelerates away from the hand.
 *
 * `started` is the caller's own sticky "this drag has turned" flag, and it is
 * what makes the slop a threshold rather than a gate. Below it a press is still
 * a click — a mouse wobbles a pixel or two under a finger coming off a button,
 * and a shop that visibly rotates on every right-click is worse than one that
 * needs a deliberate drag. Above it the anchor is the pointer and every pixel
 * counts, or a slow drag stutters in 7px jumps.
 *
 * The slop is measured as a *distance* rather than per axis, or a drag straight
 * down would sit under the threshold on x for ever and the tilt would never
 * start — and once either angle is live both are, because a hand that is turning
 * the view is holding the view.
 *
 * Shared by both buttons on purpose. The left drag turns the view as well, and
 * two copies of an accumulator are two things that can disagree about which way
 * a shop spins — the sort of difference nobody would think to look for, because
 * each button feels right on its own.
 */
function stepTurn(anchor, x, y, started) {
  const dx = x - anchor.x;
  const dy = y - anchor.y;
  if (!started && Math.hypot(dx, dy) < TAP_SLOP) return { anchor, turned: false };
  scene.spinView(-dx * SPIN_RAD_PER_PX);
  scene.tiltView(dy * TILT_RAD_PER_PX);
  return { anchor: { x, y }, turned: true };
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

let faceDrag = null;

/**
 * The faces a paint drag covers, and how far along the pointer has got.
 *
 * `edgeDragRun` said about a side. The far end is read off the tile for the same
 * reason it is there — `pickFace` answers which LINE, which is the wrong
 * question once the line is chosen — and the side is never re-read at all.
 */
function faceDragRun(cx, cy) {
  if (!faceDrag) return { faces: [], to: null };
  const tile = scene.pickTile(cx, cy, 0.55);
  const to = tile ? (faceDrag.start.o === 'v' ? tile.z : tile.x) : null;
  return { faces: faceRun(scene.storeLayout, faceDrag.start, to), to };
}

function showFaceDrag(cx, cy) {
  const { faces, to } = faceDragRun(cx, cy);
  if (!faces.length) { scene.setFaceGhost(null, null); return null; }
  const verdict = canPaintFaces(scene.storeLayout, faces);
  scene.setFaceGhost(faces, verdict.ok ? 'ok' : 'no');
  ui.setBuildVerdict(verdict);
  // The pointer's own far end, never the tail of the list — the wall drag's
  // hard-won lesson, and it applies here for exactly the same reason: `edgeRun`
  // emits lowest-index-first whichever way you dragged.
  return { faces, verdict, to };
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

/**
 * What the RIGHT button means with a wall tool up: knock THIS one through.
 *
 * Taking a wall out was the bulldozer's job and nothing else's, so changing
 * your mind about one segment is a trip to the far end of the bar and back —
 * arm Demolish, drag the one line, arm Wall again — three inputs around a
 * decision you made while looking at the wall. Drawing walls is exactly where
 * that happens most, because a run is laid in one gesture and regretted a
 * segment at a time.
 *
 * Armed on the way DOWN like every other press, and it is a *tap*: a wall tool
 * takes the left drag (see `edgeDrag`), so the right one is the only way left to
 * turn the view while you are building, and a press that turned is a turn and
 * nothing else — `endSpin` drops this the same way it drops a put.
 *
 * Null hands the press back to the button's ladder — a turn if you drag, then
 * `ui.escape()`, then a walk. It stays null unless something really is on that
 * line, or backing out would quietly stop working wherever you happened to
 * point — which is worse than not having the gesture at all. Being in build mode
 * is itself a rung, so the walk is never what a razing press falls through to.
 */
function armEdgeRaze(cx, cy) {
  if (ui.edgeKindForTool() === null) return null;
  // Things beat gaps, which is `pickWay`'s own precedence and is here for the
  // same reason: a shelf standing against a wall covers that line on screen, and
  // the wall behind it is never what you were pointing at.
  if (scene.pickFixture(cx, cy)) return null;
  const seg = scene.pickEdge(cx, cy);
  if (!seg || kindAt(scene.storeLayout, seg) === E.NONE) return null;
  return seg;
}

/**
 * ...and the same press with a BRUSH up: take this cell back to bare ground.
 *
 * `armEdgeRaze` said about an area instead of a line, and it is the same
 * complaint — you lay ground in one gesture and regret it a cell at a time, and
 * undoing one square meant finding Bare Ground on another tab, painting it, and
 * arming the brush you were using again. Three inputs around a decision you made
 * while looking at the tile.
 *
 * Two things it deliberately does NOT do. It aims with `pickTile` and never
 * `pickFixture`, which is the left drag's own rule (`pickFixture` here would
 * scrape the roof of a shelf), and it is a single CELL rather than a drag, which
 * is what makes it the wall gesture rather than a second brush: the right button
 * is also the only way to turn the view while a brush has the left one, so
 * anything it does has to survive being abandoned mid-press.
 *
 * Null hands the press back to the button's ladder — turn, then `ui.escape()`,
 * then a walk — so pointing at grass that is already bare backs out the way it
 * always did rather than doing nothing at all.
 */
function armGroundScrape(cx, cy) {
  const brush = ui.groundForTool();
  if (brush === undefined) return null;
  // Bare Ground itself is exempt. With the null entry armed the LEFT button
  // already scrapes, over an area, so a right press on it would be one act with
  // two gestures — which is the thing the eraser's own comment argues against.
  if (!brush.piece) return null;
  const cell = scene.pickTile(cx, cy);
  if (!cell) return null;
  // `canPaintGround` is the authority, exactly as `canPlaceEdges` is for a wall,
  // and `unchanged` is the half a wall does not have: every cell in the world is
  // a ground kind now that the lawn has a row, so "is there anything here" can
  // only be answered by asking what taking it up would change.
  const verdict = canPaintGround(scene.storeLayout, [cell], null, null);
  if (!verdict.ok || verdict.unchanged) return null;
  return cell;
}

/** Take one cell back to bare ground, judged and reported the way a run is. */
function scrapeGround(at) {
  const verdict = canPaintGround(scene.storeLayout, [at], null, null);
  if (!verdict.ok) { ui.toast(verdict.reason, true); return; }
  if (verdict.warn) ui.toast(verdict.warn);
  scene.ripple(at.x, at.z, 'no');
  // No `to`, for `razeEdge`'s reason: a null far end is what `groundStroke`
  // reads as a stroke of one on the server as well as here, so the cell charged
  // for is the cell the verdict was taken over.
  net.send('build-ground', { x: at.x, z: at.z, piece: '', to: null });
}

/** Knock one segment through, judged and reported the way a drag's run is. */
function razeEdge(at) {
  const verdict = canPlaceEdges(scene.storeLayout, [at], E.NONE);
  if (!verdict.ok) { ui.toast(verdict.reason, true); return; }
  if (verdict.warn) ui.toast(verdict.warn);
  // No `to` at all: a null far end is what `edgeRun` reads as a run of one, on
  // the server as well as here, so the segment charged for is the segment the
  // verdict was taken over. Sending its own index would say the same thing in a
  // way that could drift, which is the bug the drag's `to` already carries.
  net.send('build-edge', { o: at.o, x: at.x, z: at.z, kind: E.NONE });
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
    if (edgeDrag || floorDrag || faceDrag) { endPress(); return; }
    // A mouse reuses one pointerId for every button, so a right press during a
    // left drag would hand the spin that drag's own id and steal its moves.
    if (drag.id !== null) return;
    spin = {
      id: e.pointerId,
      ax: { x: e.clientX, y: e.clientY },
      turned: false,
      at: performance.now(),
      put: null,
      raze: null,
      scrape: null,
      trek: null,
      // Held at the PRESS, not read at the release. The key can come up while
      // the button is still down — and a modifier that decides whether a wall
      // survives has to be the one you were holding when you aimed at it, the
      // same way `armPut` names its target on the way down.
      shift: e.shiftKey,
    };
    // The put half of the press, armed on the way DOWN for the same reason the
    // take is: the ring winds off an errand, so naming it on release means a
    // hold does nothing however long you hold it. Harmless if the press turns
    // out to be a camera turn — an errand is a target, not an action, and
    // `pointermove` lets go of the button the moment the view moves.
    spin.put = armPut(e.clientX, e.clientY);
    // ...and the same press with a wall tool up. The two can never both answer:
    // a put needs full hands and no palette, a raze needs an armed edge tool,
    // which is the palette. Named here rather than on release for the ordinary
    // reason — the pointer is on the wall now, and by the time the button comes
    // up the view may have turned under it.
    spin.raze = armEdgeRaze(e.clientX, e.clientY);
    // ...and the brush's version of the same press. None of the three can ever
    // both answer: a put needs full hands and no palette, a raze needs an armed
    // EDGE tool and this needs an armed GROUND one, and `edgeKindForTool` and
    // `groundForTool` are two different flags on one entry.
    spin.scrape = armGroundScrape(e.clientX, e.clientY);
    if (spin.put) hold();
    // A unit across the shop: hold, and you WALK there and do it.
    //
    // The press already named it (`armPut`'s `walk`), and the tap already walked
    // — what a hold did was nothing at all, because the release of a hold is not
    // a tap (that rule is what stops a pour ending with one more unit) so the
    // walk was swallowed and the press came back dead. Which reads as the shop
    // refusing you: same button, same box, same shelf, and the only difference is
    // that you were four tiles further away.
    //
    // Three things decide the shape of it. It fires on a TIMER at the same mark
    // the left button rules a press a hold, and not on the way down like every
    // other arming in here, because the right button is also the camera: a walk
    // sent on `pointerdown` would send you across the shop every time you grabbed
    // the view. Its target is the fixture rather than a tile, so the route ends
    // at a side you can actually work it from. And the button stays DOWN for the
    // whole journey — that is the entire trick, since `stepActions` winds a ring
    // only while something is pressed, so arriving with your finger still on it
    // is arriving armed. Let go on the way and you have simply walked over,
    // which is the honest outcome and the one the tap already gave you.
    if (spin.put?.kind === 'walk') {
      const s = spin;
      s.trek = setTimeout(() => {
        s.trek = null;
        // The pointer is about to stop being the question. See `refreshGhost`.
        s.trekking = true;
        walkTo({ fixture: s.put.f.id, put: true });
      }, LONG_PRESS_MS);
    }
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

  // Shift takes the press before ANY of the four drags below, and hands it to
  // the selection.
  //
  // First, because every one of them is a verb and shift-click is not: a wall
  // tool would have laid a segment, the brush a cell, the palette a fixture, and
  // the bare press turned the camera. Picking six shelves means holding a key
  // and clicking six times, and each of those clicks has to be *only* a pick —
  // one that also built something would make the gesture unusable in exactly
  // the mode you use it in.
  //
  // Consumed whole (no capture, no `drag`, no hold timer) so the release is not
  // also a tap: `tapAtPointer` would walk you to the last shelf you picked.
  // Missing the fixtures entirely is a shift-click on the floor, which does
  // nothing at all — it is not "deselect", because the ordinary press already
  // means that and this one is meant to be safe to repeat.
  if (e.shiftKey && !ui.holding) {
    const pick = pickTarget(e.clientX, e.clientY);
    if (pick) {
      ui.togglePicked(pick);
      scene.ripple(pick.x, pick.z, 'miss');
      return;
    }
  }

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

  // ...and a finish takes it along a wall, on the side you pressed. The side is
  // read ONCE, here, and carried through the whole run — see `faceRun`: a drag
  // that re-decided per segment would paint the inside of whichever two your
  // cursor drifted across on the way.
  const finish = ui.faceForTool();
  if (finish !== undefined) {
    const start = scene.pickFace(e.clientX, e.clientY);
    if (start) {
      faceDrag = { start, piece: finish.piece, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      showFaceDrag(e.clientX, e.clientY);
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
  drag.ox = drag.lx = e.clientX;
  drag.oy = drag.ly = e.clientY;
  drag.ax = { x: e.clientX, y: e.clientY };
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
  // The same two pointer kinds, kept as their own field because the other half
  // of this asks a different question about them: `turns` is what the drag does
  // to the camera, and this is whether the press has a hover behind it.
  drag.touch = !drag.turns;
  drag.aiming = false;
  drag.spun = false;
  drag.travel = 0;
  drag.done = false;
  // Cleared before the arming block below, which is what sets it.
  drag.took = false;
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
  // `paletteArmed` for the same reason `boardTakes` carries it one line down,
  // and this is the half that was missing: a crate was named on the way down
  // whatever mode you were in, so pressing on a box while building lifted it —
  // the one goods gesture build mode never suspended. The shop refuses it now
  // (`notWhileBuilding`) and it is refused OUT LOUD, which is exactly why this
  // arming has to stop happening here rather than being left to be told off: it
  // is speculative — the press may still turn out to be a pan — and this branch
  // is under a press whose release *places a fixture*, so leaving it in would
  // mean one press that both puts a shelf down and says you may not build.
  if (e.button === 0 && !ui.demolishArmed() && !ui.paletteArmed) {
    // `aimCrate`, which is `pickPallet` plus "is it in a pile" — the crate named
    // is the one the ray met, buried or not, so the ring winds on the box you
    // are pointing at and that is the box that comes away.
    const aimed = aimCrate(e.clientX, e.clientY);
    const hit = aimed ? null : pickAimed(e.clientX, e.clientY);
    if (aimed) { net.send('take', { palletId: aimed.id }); drag.took = true; }
    // ...but only for a unit you are STOOD at, which a crate does not have to
    // ask because a crate is a small thing in a yard and a shelf is most of a
    // wall. A mouse turns the view by dragging, and a drag that started on a
    // shelf across the shop would have sent you walking to it before the first
    // frame of the turn — an errand nobody asked for, out of the gesture people
    // use most. Naming it early only buys anything in reach anyway: that is
    // exactly the case where the ring can wind under the same press, and the
    // release below still names a board you have to walk to.
    else if (ripeBoard(hit?.f, hit?.board) && boardTakes() && inReachOf(hit.f)) {
      // ...and that pile is now the one you are working out of, until Escape.
      pickBoard(hit.f, hit.board);
      net.send('take', { shelfId: hit.f.id, itemId: hit.board });
      drag.took = true;
    }
    // Putting things DOWN is not here at all any more — a unit, a square, a
    // crate, all three are the right button (see `armPut`). This one is takes
    // only, which is what makes a board a target with an armful already in your
    // hands: one button per direction, and neither has to read your hands to
    // work out which way the goods are meant to go.
  }
  // Armed on a timer rather than measured on release, so whatever the hold does
  // happens under a pointer that is still down — which is what makes it feel
  // like a press and not like a slow click.
  //
  // What it does, in the order it decides: lift a fixture in build mode, stand
  // aside for a press that already named goods (`drag.took`), else open what is
  // under the pointer. The button is down, so the ring may start winding. Everything a press can
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

    // ...and a held press on bare ground with something to place is the FINGER'S
    // hover — see `TOUCH_AIM_LIFT`. It comes after the lift for the same reason
    // that one comes first: a press that started on a fixture is about that
    // fixture, and only a press with nothing under it is asking where to put
    // something. A quick tap is untouched, which is the half that keeps this
    // free: it places under your finger exactly as it always has, and this is
    // only ever what happens when you keep holding instead.
    //
    // Touch and pen only. A mouse already has the hover this is standing in for,
    // and taking its hold away would cost it `openAtPointer` for nothing.
    if (drag.touch && (ui.paletteArmed || ui.holding) && !ui.demolishArmed()) {
      drag.aiming = true;
      // The hop IS the signal that sliding now moves the ghost rather than the
      // shop. Nothing else says so — there is no cursor to change and no room on
      // the pill for a mode — and a ghost that quietly started following the
      // finger it was already under would look like nothing had happened.
      pointer.y = drag.oy - TOUCH_AIM_LIFT;
      pointer.x = drag.ox;
      pointer.onCanvas = true;
      refreshGhost(true);
      return;
    }

    if (!HOLD_OPENS) return;
    // ...and the other thing a hold already means. This press named goods on
    // the way down, so the ring you are watching is a board draining into a
    // crate or a box coming off a pile — putting a menu over that would be one
    // gesture doing two things, and the one nobody asked for is on top.
    if (drag.took) return;

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
    // ONCE THE WALK HAS STARTED, THE MOUSE IS NOT AN INSTRUCTION.
    //
    // The camera and the errand share this button, and the rule below settles
    // which one a moving hand meant — everywhere except here, where the press
    // has already committed: `spin.trek` fired, you are walking to a fixture you
    // named, and the whole journey happens with the button still down. So the
    // hand resting on a mouse for a second and a half is not a request to turn
    // the shop, and treating it as one takes the put with it (`release`) — which
    // lands as a walk that arrives and does nothing, from a press that was
    // working a moment ago. Nothing is lost by ignoring it: letting go is still
    // the way out, and it still leaves you standing there having simply walked
    // over.
    if (spin.trekking) return;
    const t = stepTurn(spin.ax, e.clientX, e.clientY, spin.turned);
    spin.ax = t.anchor;
    // Sticky: one turn anywhere in the press means the release was a drag, and
    // a drag must not also back out of the mode you were looking around inside.
    // ...nor finish a put. The player does not move while the view turns, so
    // `moving` — the server's own answer to a walk-past — never fires here, and
    // a ring left winding through a camera turn would empty your hands onto
    // whatever you happened to have been pointing at when you grabbed the view.
    // ...and it must not set off walking either, which is the same claim about
    // the same press one gesture along: a turn is the camera, and the pending
    // trek would otherwise fire mid-spin and send you across the shop to whatever
    // you happened to have been pointing at when you grabbed the view.
    if (t.turned && !spin.turned) { spin.turned = true; cancelTrek(spin); release(); }
    return;
  }
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { stepPinch(); return; }
  if (faceDrag && e.pointerId === faceDrag.id) {
    showFaceDrag(e.clientX, e.clientY);
    return;
  }
  if (edgeDrag && e.pointerId === edgeDrag.id) {
    showEdgeDrag(e.clientX, e.clientY);
    return;
  }
  if (floorDrag && e.pointerId === floorDrag.id) {
    showFloorDrag(e.clientX, e.clientY);
    return;
  }
  if (drag.id !== e.pointerId) return;
  // Aiming owns the drag outright: the ghost has already moved (the window's own
  // `pointermove` applies the lift and re-runs `refreshGhost`), so all that is
  // left here is to keep the shop still underneath it. Swallowed before `travel`
  // is counted as well, or the slop line would rule this a pan and `release()`
  // would throw away a press that is still very much down.
  if (drag.aiming) return;
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
      const t = stepTurn(drag.ax, e.clientX, e.clientY, drag.spun);
      drag.ax = t.anchor;
      drag.spun = t.turned || drag.spun;
    } else {
      // Fed the *frame* delta, not the distance from the origin — panning by the
      // total would move the camera by the whole drag again on every event, which
      // accelerates away from your finger the longer you hold it.
      //
      // ...and in build mode the drag FLIES the view instead of dragging the
      // shop, which is the same inversion the keys already make (`flying`) and
      // it is the mode rather than the device that decides it. Shopkeeping is a
      // map: the world follows your hand, you pull the far aisle toward you.
      // Building is the opposite errand — you are reaching for somewhere you
      // cannot stand, so the drag is "go there", and a finger that swept toward
      // the top right to put something in the top right corner got the bottom
      // left, which reads as the scroll being backwards. Only ever reached by a
      // finger, since a mouse drag in this game turns the view (`drag.turns`),
      // so no desktop gesture changes.
      // `building()` and not `flying()`: a pause flies the KEYS and leaves the
      // drag alone, or pressing pause quietly reverses which way the shop slides
      // under your finger. See `flying`.
      const fly = building() ? -1 : 1;
      scene.panBy(fly * (e.clientX - drag.lx), fly * (e.clientY - drag.ly));
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
      // A tap with a Doorway tool on a doorway that is already there used to be
      // a message the server answered `unchanged` — the one press in build mode
      // that did nothing at all. It opens that door's menu instead, which is
      // where "and who is it for" lives, and it is the precise way in: this line
      // was named by `pickEdge` when the press went down, so there is no aiming
      // left to get wrong. A single segment only — a drag along a wall is a run,
      // not a question about one door — and only within a family, so the Wall
      // tool still bricks a doorway up and the bulldozer still knocks it through.
      if (drawn.segs.length === 1 && sameFamily(scene.storeLayout, start, kind)) {
        showEdgeMenu(ui, start);
        return;
      }
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
  if (faceDrag && (!e || e.pointerId === faceDrag.id)) {
    const drawn = e ? showFaceDrag(e.clientX, e.clientY) : null;
    const { start, piece } = faceDrag;
    faceDrag = null;
    scene.setFaceGhost(null, null);
    ui.setBuildVerdict(null);
    if (drawn) {
      if (!drawn.verdict.ok) { ui.toast(drawn.verdict.reason, true); return; }
      // Two ends, a side and a piece — never the list, for the cap's sake, and
      // the server re-runs the same `faceRun` against the same maximum.
      net.send('paint-face', {
        o: start.o, x: start.x, z: start.z, s: start.s, piece, to: drawn.to,
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
  // A press that spent itself aiming places where the GHOST is, not where the
  // finger is — they are `TOUCH_AIM_LIFT` apart, and the ghost is the one you
  // have been looking at. `pointer` is where it stands, so this is the same
  // "what you see is what lands" the mouse has always had. No event at all (a
  // cancelled pointer, a lost window) places nothing, the way a lost drag leaves
  // a fixture in your hands rather than dropping it somewhere nobody chose.
  const aimed = drag.aiming && !!e ? { x: pointer.x, y: pointer.y } : null;
  endDrag();
  if (aimed) { tapAtPointer(aimed.x, aimed.y); return; }
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
/**
 * Drop a pending walk-to-it, wherever the press ended.
 *
 * Idempotent and safe to call after it has fired, the same way `release` is —
 * every way a press can end goes through one of its two callers, and a timer
 * left running is a walk that starts after the button is up.
 */
function cancelTrek(s) {
  if (!s) return;
  // The freeze goes with it, and it has to go even when there is no timer left
  // to clear: by then the walk is usually already running, and what this call
  // means is that the press has stopped buying anything (the view turned, the
  // button came up). A pointer that stayed frozen after that would be a shop
  // that quietly stopped responding to the mouse.
  s.trekking = false;
  if (!s.trek) return;
  clearTimeout(s.trek);
  s.trek = null;
}

function endSpin(e) {
  if (!spin || (e && e.pointerId !== spin.id)) return null;
  const { turned, put, raze, scrape, shift, at } = spin;
  cancelTrek(spin);
  spin = null;
  // Always, whether or not this press armed anything: the button is up, and a
  // `pressing` bit left set is a ring that goes on winding with nothing down.
  release();
  return { turned, put, raze, scrape, shift, held: performance.now() - at >= LONG_PRESS_MS };
}
canvas.addEventListener('pointerup', (e) => {
  const wasPinching = !!pinch;
  dropTouch(e.pointerId);
  const spun = endSpin(e);
  if (spun) {
    if (spun.turned) return;
    // A press that lasted is a HOLD, and its release is not also a tap — the
    // same rule the left button has had since the ring existed. The ring has
    // already done whatever it was going to do (or been refused out loud), so
    // sending the tap on top would put a second unit down after pouring the lot,
    // and on a square it would back out of the mode you were just working in.
    //
    // ...only when the press ARMED something, though. With nothing in your hands
    // the right button has no hold at all, so a long one is still an ordinary
    // click — and swallowing it meant that pausing for half a second on the way
    // to backing out of a menu did nothing, which is the least explicable kind
    // of dead input: it works, then it doesn't, and the difference is how fast
    // you let go.
    if (spun.held && spun.put) return;

    // A right click that turned nothing is "back out" everywhere in the game —
    // except where you are pointing at somewhere goods can GO, which is now the
    // whole of what the button means with your hands full. It sits in FRONT of
    // `escape` because backing out is the fallback: pointing at a thing is a
    // positive act, which is the same argument the left button and the tap both
    // already make. `armPut` decided all of this on the way down, when the
    // pointer was still on the thing.
    const put = spun.put;
    if (put?.kind === 'crate') {
      scene.ripple(put.crate.x, put.crate.z);
      net.send('crate-one', { palletId: put.crate.id, put: true });
      return;
    }
    if (put?.kind === 'board') {
      scene.ripple(put.f.x, put.f.z);
      net.send('shelf-one', { shelfId: put.f.id, itemId: put.itemId, put: true });
      return;
    }
    // One ingredient into the hopper. Mixed hands drain a pile at a time, in
    // the order they are held — see `Game.loadStation` for why that is not a
    // thing the pointer gets to say here.
    if (put?.kind === 'station') {
      scene.ripple(put.f.x, put.f.z);
      net.send('station-one', { stationId: put.f.id, put: true });
      return;
    }
    // A skip, tapped rather than held. Deliberately nothing: the press already
    // named it on the way down, so the ring is armed and standing there — and
    // throwing away is the one action in the game a stray click must not be
    // able to complete. Swallowed here rather than left to fall through, or the
    // tap would land on `escape()` and back you out of the thing you were
    // aiming at.
    if (put?.kind === 'bin') { scene.ripple(put.f.x, put.f.z); return; }
    // The same journey the hold sets off on (`spin.trek`), off a tap — you get
    // there and the put is armed, and pressing again does it. `put: true` for
    // the same reason the hold sends it: this is the right button, and dropping
    // the direction at the kerb would leave a machine offering its tray to
    // somebody who walked over holding a crate.
    if (put?.kind === 'walk') {
      scene.ripple(put.f.x, put.f.z);
      walkTo({ fixture: put.f.id, put: true });
      return;
    }
    // ...and the same precedence for a wall: pointing at one is a positive act,
    // and backing out is what the button falls back to. `armEdgeRaze` decided
    // this on the way down, when the pointer was still on the line — with the
    // palette up there is nothing in your hands for it to compete with.
    //
    // SHIFT is what makes it a demolition, and the plain press is what tells you
    // so. A bare right-click already means four things in this mode (turn the
    // view, back out of a tool, put a thing down, walk) and the two razes were a
    // fifth that happens to be the only destructive one — so the same reflex
    // that closes a picker took a wall out, and the tell was that neither of us
    // could say which of the five a given press had been until after it landed.
    // The modifier is free here: shift-LEFT is the fixture pick, and shift-right
    // has never meant anything. Consumed rather than fallen through on purpose —
    // a press that quietly backed out of a tool instead is the same ambiguity
    // wearing the other outcome, where the toast is a press that taught you the
    // gesture. `esc` is the same key `verify` never sees; this is the one thing
    // in the mode that cannot be undone by pressing again.
    if (spun.raze) {
      if (!spun.shift) { ui.toast('Shift + right-click to take a wall down'); return; }
      razeEdge(spun.raze);
      return;
    }
    // ...and a cell of ground, on the same precedence and for the same reason:
    // pointing at something you laid is a positive act, and backing out is what
    // the button falls back to when you were not.
    if (spun.scrape) {
      if (!spun.shift) { ui.toast('Shift + right-click to take the ground up'); return; }
      scrapeGround(spun.scrape);
      return;
    }
    // Backing out still comes first, and it is still every rung of the ladder —
    // a search box, a menu, a selection, a browse bar, an armed tool, the mode.
    // What is new is that the ladder now says when it did nothing, which the
    // bottom rung has always quietly done: nothing open, not building, nothing
    // to shed, and the press was spent on a no-op. That is the press the world
    // gets.
    if (ui.escape()) return;

    // ...and then the right button goes there, which is the left button's tail
    // exactly. Same two addresses in the same order and for the reason
    // `pickFixture` exists at all: a shelf is drawn most of a tile up-screen of
    // the ground it stands on, so asking the floor first walks you past the
    // thing you pointed at. Naming the unit is also what gets you to a side you
    // can work it from rather than to whichever tile the ray happened to meet.
    const goTo = pickTarget(e.clientX, e.clientY);
    if (goTo) { scene.ripple(goTo.x, goTo.z); walkTo({ fixture: goTo.id }); return; }
    const spot = scene.pickTile(e.clientX, e.clientY);
    if (spot) { scene.ripple(spot.x, spot.z); walkTo({ x: spot.x, z: spot.z }); }
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

/**
 * The browser's own idea of what a held press is.
 *
 * `user-select: none` stops the *highlight*, and these two are the half it does
 * not stop: the browser still opens a selection from the canvas and still
 * offers to drag off it, which is where the I-beam cursor, the caret and the
 * ghost image of the page come from. Every gesture in this game is a press held
 * still and then moved, so that is not an edge case — it is the shape of a pan,
 * a camera turn, a wall drag and every long press in the game.
 *
 * On the CANVAS and not on the document, which is the whole safety of it: the
 * Menu names a shop and a player in text fields, and a blanket refusal would be
 * a box you cannot select the contents of to correct. Same line `#panel-body`
 * draws in the stylesheet.
 */
canvas.addEventListener('selectstart', (e) => e.preventDefault());
canvas.addEventListener('dragstart', (e) => e.preventDefault());

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
 * hands. They CAN both be set now — an armful and a box on your shoulder are two
 * places goods can be and neither refuses the other any more — so anything that
 * means "am I holding goods at all" has to ask for both.
 */
const myHaul = () => latestState?.players
  ?.find((p) => p.id === net.myId)?.haul ?? null;

/**
 * IS A PRESS PART-WAY THROUGH? Then the pointer stops choosing.
 *
 * Everything in the hover pass is a question about where the pointer is *right
 * now*, which is exactly right until a press has already answered it. From the
 * tick a ring starts winding, what the pointer is over is not a decision any
 * more — the decision was made, it is on screen, and it is being confirmed.
 *
 * What it costs to leave that live is a shop full of things that move. A hire
 * walking between you and the crate you are setting down takes the whole branch
 * (`pickPerson` returns early and clears the floor ghost), so the green square
 * you are aiming at blinks out and comes back as they pass — and the same walk
 * past a shelf swaps the cage onto whatever is behind them. Nothing has gone
 * wrong and nothing you did caused it, which is the worst kind of funny: the
 * markers argue with the press you are in the middle of making.
 *
 * `progress` rather than "is a button down", because a button being down is
 * also a drag, a pan and a camera turn — all three of which the pointer very
 * much does still own. A ring that has started is the one state where it does
 * not, and the server is the only thing that knows it has (`stepActions`), which
 * is also what makes this agree with the ring you can see.
 */
const charging = () => ((latestState?.players
  ?.find((p) => p.id === net.myId)?.action?.progress ?? 0) > 0);

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
 * The way through a press here would OPEN, or null.
 *
 * Written once and asked by BOTH the hover and the hold, for the reason
 * `boardTakes` is: a highlight is a promise, and a doorway that lit up while the
 * press opened the shelf behind it would be the green-ghost bug said about a
 * marker. Every entry in the veto list is a state where something else is already
 * the answer:
 *
 * - **a fixture is under the pointer** (`blocked`, worked out by the caller,
 *   which has already raycast for one) — things beat gaps, and this is what keeps
 *   the shop front usable: the awning stands on the tile the front door opens
 *   onto, so pointing at the canopy must reach the canopy.
 * - **a crate is under the pointer** — a pallet is a target too, and the door
 *   behind a stack of boxes is not what you were aiming at.
 * - **you are carrying a fixture, or an armful** — then every square is somewhere
 *   to put it down, and nothing is something to look at.
 * - **the bulldozer is armed** — you are aiming at things to tear out, and a
 *   doorway is torn out by dragging along it.
 * - **you are not building** — everything on this menu is a build verb, and the
 *   wall it sits on is not something you interact with while shopkeeping. A
 *   doorway is also *everywhere*: the front of the shop is a line of them, so a
 *   bar that lit up along the shop front whenever the pointer crossed it was
 *   advertising a menu at the exact moment nobody wants one. `paletteArmed`
 *   rather than `buildOn`, the same test `aimable` uses and for the same reason
 *   — the mode a fixture menu borrows for one press of Empty puts no bar on
 *   screen, so it must not quietly make the walls clickable.
 */
/** Two lattice addresses, compared — so a second tap on the same door shuts it. */
const sameSpot = (a, b) => !!a && !!b && a.o === b.o && a.x === b.x && a.z === b.z;

function pickWay(cx, cy, blocked = false) {
  if (!ui.paletteArmed) return null;
  if (blocked || ui.holding || ui.demolishArmed() || dropping()) return null;
  if (aimCrate(cx, cy)) return null;
  const seg = scene.pickEdge(cx, cy);
  return seg && hasEdgeMenu(scene.storeLayout, seg) ? seg : null;
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
 *
 * **A crate on your shoulder is no longer one of them either.** It was, and it
 * was the client half of a refusal the server has now dropped (`unshelve`,
 * `crateBoard`): hands and a shoulder are two places goods can be, and the rule
 * that they may not both be full predates the direction being on the button.
 * What it cost is the thing a box is FOR — walking the aisles filling it — since
 * the moment one was up, every board in the shop stopped being pointable.
 *
 * **An armful of stock is no longer one of them**, and that is the whole of what
 * the two buttons bought. It used to be: full hands meant a shelf was somewhere
 * to PUT things, so the unit won the gesture and a corner of it could not decide
 * otherwise. With the direction on the button instead — left takes, right puts —
 * a board is a take whatever you are holding, which is what "walk round and
 * pluck one or two of each" actually is. `unshelve` has always accepted a top-up
 * onto a hand already holding some.
 *
 * Written once and asked by all three of hover, press and tap, or the highlight
 * would offer something the press then did differently.
 */
const boardTakes = () => !ui.paletteArmed && !ui.holding && !ui.demolishArmed();

/**
 * A TAP IS A QUESTION HERE, NOT A VERB.
 *
 * On a desktop a tap can be a verb because there is a second button to be the
 * other half of the sentence: left takes, right puts, and pointing at a crate
 * you are stood at can safely mean "take one" because putting one back is a
 * press away. With one button that whole grammar is gone — every direction and
 * every length of press has to come off the pill instead, which is why its rows
 * became buttons at all.
 *
 * So the tap gives the pill its target and stops there. Tapping a crate no
 * longer takes a tin out of it: you get the list, and the list has "Take one" on
 * it, one press further and reversible. It is the same trade the fixture menu
 * made when a tap stopped BEING the menu — a press that does something to your
 * goods, made by the one gesture people use to look at things, is a press
 * nobody meant.
 *
 * Only what you can already reach: out of reach, the tap is still the walk,
 * because a tap on a shelf across the shop is how you get to it and the pill has
 * nothing to offer somewhere you are not standing.
 *
 * The test is the WIDTH and not `pointer: coarse`, and it is the same one the
 * rows' `pointer-events` uses in index.html — deliberately, since these are two
 * halves of one decision: the tap may only stop being a verb where the pill is
 * pressable, or the actions have left the world and landed nowhere. A phone in
 * a desktop browser's device emulation is also the place this gets tested, and
 * it does not reliably report a coarse pointer.
 *
 * It lives in ui.js so that the TUTORIAL can ask it too. That is the same
 * argument one level up: the tour teaches the game in words, and words that name
 * a right button on a device with one are worse than no tour at all — so which
 * grammar is live has to be one answer, not two that can drift.
 */

/**
 * How long the pointer has to SETTLE on a pile before that pile is the target.
 *
 * A unit is one thing you point at and its boards are three, a few pixels
 * apart, so crossing a stocked shelf on the way to anywhere sweeps through all
 * of them — the cage flicked between piles, and worse, the answer a press got
 * was whichever board the pointer happened to be over at the instant it went
 * down. That is a decision made by a hand that was still moving. The dwell is
 * the intent: rest on the bread and the bread is what you get, brush past and
 * the unit stays the target it always was.
 *
 * Comfortably under the hold (`LONG_PRESS_MS`, 420) and deliberately not much
 * under: it has to be short enough to be invisible when you meant it and long
 * enough that crossing an aisle never lands on a pile. It must stay BELOW the
 * hold, or a press-and-hold on a board would rule itself a hold before the
 * board it is aimed at had ripened, and the pull would take from nothing.
 */
const BOARD_DWELL_MS = 240;

/**
 * The board the pointer has settled on, or null while it is still moving.
 *
 * One piece of state and one reader, because the highlight and the press have
 * to agree about it — a cage that lit up on a pile the press then ignored is
 * the green-ghost bug wearing a marker, and it is the exact bug `boardTakes`
 * already exists to keep out of this pair.
 *
 * It is armed by the HOVER and read by both, rather than each side timing its
 * own: the press has no history of where the pointer has been, and the two
 * clocks would disagree on the frame that matters.
 */
let dwell = { key: null, at: 0, timer: null };

/**
 * How long a settled board STAYS settled once the pointer has left it.
 *
 * The dwell alone is only half a gesture. It costs you 240ms to name a pile and
 * then hands it back the instant the ray misses — and the ray misses constantly
 * for reasons that have nothing to do with what you meant: a pile of bread is a
 * few pixels of a shelf drawn at 45°, the gaps between two piles are real gaps,
 * and the goods re-weld on every sale so the group under the pointer stops
 * existing for a frame ten times a second. What that feels like is a cage that
 * flickers while your hand is still, and a decision you have to make again every
 * time you look away.
 *
 * So leaving is delayed the way arriving is. Long enough to cover a wander and
 * a re-weld, short enough that it is gone before you have started aiming at
 * something else.
 */
const BOARD_STICK_MS = 700;

/**
 * ...and the pile it stays on. Held by ID rather than as the record `pickAim`
 * handed over, because a re-flow re-mints every fixture — a record kept across
 * one would draw a cage on a shelf that no longer exists, which is the same
 * staleness `setFixtureRef` documents about a selection.
 */
let stick = { id: null, board: null, at: 0 };

/**
 * THE PILE YOU ACTUALLY PRESSED, which stays pressed until you say otherwise.
 *
 * The dwell and the stick are both guesses about where your hand is going, and
 * a guess has to expire. A press is not a guess: pointing at the bread and
 * taking a loaf says which pile you are working out of about as plainly as
 * anything in the game, so from that moment the shop can simply *know* it and
 * stop asking. That is what makes the whole gesture cheap — the second loaf,
 * and the third, cost no dwell and no aim at all, because the pile is still the
 * one you named.
 *
 * Set by both buttons, because both are a sentence about that pile: a tap takes
 * one out, a right-tap puts one back, and neither is a question about which.
 *
 * Released by Escape (`ui.escape`, through `dropBoardPick`), by pressing a
 * different pile, and by the pile ceasing to exist. Nothing else: it is a
 * selection rather than an aim, so pointing somewhere else does not take it
 * away — what happens there is that the aim marker on the thing you ARE pointing
 * at wins the frame, which is the same way a picked fixture behaves.
 */
let pick = { id: null, board: null };

/** A press landed on a pile: that is the one, until something says otherwise. */
function pickBoard(f, board) {
  if (f && board) pick = { id: f.id, board };
}

/**
 * Walking away is how you let go of things, where nothing else can be.
 *
 * A selection and a picked pile are both deliberately *sticky* — pointing
 * somewhere else does not drop them, because they are a decision rather than an
 * aim, and re-making that decision every time your hand wanders is the thing
 * they exist to stop. What lets go of them on a desktop is Escape, a click on
 * bare floor, or a press on something else, and the first two are the ones that
 * do it without naming a replacement.
 *
 * A phone has neither. There is no Escape key, the floor under the pill is where
 * the verbs are rather than somewhere to tap, and `pick` is documented as being
 * released by "Escape, a different pile, or the pile ceasing to exist" — a list
 * with nothing on it a finger can do. So a shelf you stocked stays ringed and
 * the pill goes on being about it while you stand at the other end of the shop,
 * which reads as the shop having got stuck on a thing you finished with.
 *
 * Distance is the one thing left that says "done with that" without needing a
 * gesture, and it is what the player already means: you selected a unit, worked
 * it, and left. **Only once you have STOPPED**, or a walk that passes out of
 * reach on the way to the far side of the same unit would drop the very thing it
 * is walking to — and only where the pill drives, because a desktop has three
 * ways to say this already and none of them is "stand somewhere else".
 */
/**
 * ...and LEAVING is not the same as being elsewhere, which is the whole of what
 * makes this safe.
 *
 * The first cut asked "are you at it", and the answer is no for every selection
 * anybody makes by pointing across the shop — which is most of them, since a tap
 * on a unit you are not standing at is how you ask what it is. So a till three
 * tiles away lit up and went out again on the very next snapshot: the pill drew
 * its rows, the ring appeared, and both vanished a tenth of a second later with
 * nothing having been pressed. What that reads as is the shop refusing the tap.
 *
 * `been` is the missing half. You have to have BEEN there for walking off to
 * mean anything — a thing you never stood at is a thing you are still only
 * looking at, and looking at it from further away is not a decision.
 */
/**
 * ...and it is per THING, which a boolean could not say.
 *
 * Kept as a flag, it was a fact about the last thing you stood at rather than
 * about the thing selected now — so picking a unit you had worked and then
 * pointing at one across the shop dropped the new one on the next snapshot,
 * still wearing the old one's answer. From the player's side: select a shelf,
 * tap a second, and the second refuses to stay picked.
 *
 * The id is the whole fix. A selection that changes has not "been" anywhere.
 */
const been = { fixture: null, pick: null };

function dropOnLeaving() {
  const at = (id) => {
    const f = id ? scene.fixtureById(id) : null;
    return !!f && (nearFixture(f) || atWorkSpotOf(f));
  };
  const step = (id, was, drop) => {
    if (!id) return null;
    // Whatever it remembered was about something else. Start again from "only
    // looking at it", which is what a fresh pick always is.
    if (was !== id) return at(id) ? id : null;
    if (at(id)) return id;
    // It was under your hands and now it is not — either you walked off, or the
    // thing itself has gone (sold back, or re-minted out from under a re-flow).
    drop();
    return null;
  };
  been.fixture = step(ui.fixtureRef?.id ?? null, been.fixture, () => ui.setFixtureRef(null));
  been.pick = step(pick.id, been.pick, () => ui.dropBoardPick());
}

/**
 * ...and Escape lets it go. Registered on `ui` rather than reached for, because
 * the ladder that owns Escape is `ui.escape` and one listener owning the key is
 * the rule the keydown handler is written around — two would mean one press
 * dropping a pile AND closing a panel.
 */
ui.dropBoardPick = (dry = false) => {
  if (!pick.id) return false;
  // `dry` is `escape`'s question rather than its press — see there. It has to be
  // honoured here as well as in every rung above, or asking whether the button
  // is spoken for would drop the pile the asker was about to describe.
  if (dry) return true;
  pick = { id: null, board: null };
  refreshGhost(true);
  return true;
};

/**
 * Note which pile is under the pointer, and answer the one it has settled on.
 *
 * The timer is not a nicety. Nothing fires while a pointer is still, so a dwell
 * measured only on `pointermove` would never ripen for somebody who stopped —
 * which is precisely the gesture this is for. It re-runs the hover pass once,
 * at the mark, so the cage appears under a hand that has not moved.
 */
function settledBoard(f, board) {
  // A DWELL IS A HOVER WITH A CLOCK ON IT, and both halves are missing here.
  //
  // Everything below measures how long the pointer has rested on one pile, and
  // where the pill drives there is no resting: the pointer is the last place a
  // finger touched, so the clock starts on the tap, ripens 240ms later with the
  // hand long gone, and then never expires because nothing ever moves off. What
  // it draws is a cage that appears by itself a moment after an unrelated press,
  // on whichever pile happened to be under that spot.
  //
  // Nothing is lost by refusing: what a dwell buys is naming a board WITHOUT
  // pressing it, and a tap already names one outright (`pickBoard`, off
  // `pickAim`). The pointer was always the better instrument than the menu here
  // — see `tapAtPointer` — and on a phone the tap is the whole of it.
  if (pillDrives()) return null;
  const key = f && board ? `${f.id}:${board}` : null;
  // A null aim does NOT restart the clock, and that is the whole of what keeps
  // this usable after you have actually taken something.
  //
  // Goods are drawn as themselves, so a board whose count changed rebuilds its
  // welded group — and for the frame in between, the ray meets nothing and the
  // aim comes back with no board on it. Restarting the dwell there means that
  // on a shelf you are actively taking from, the 240ms never elapses: the pile
  // re-syncs every snapshot, the clock resets ten times a second, and the cage
  // simply never appears again. Which reads exactly as he described it — one
  // unit comes off, and from then on the shop will only let you point at the
  // whole unit, whose errand with full hands is a PUT.
  //
  // Keeping the old key is safe because `ripeBoard` matches it against the
  // board being asked about right now: a stale key can only ever ripen for the
  // same pile you had settled on, and pointing at a different one replaces it
  // on the first frame that names one.
  if (key !== null && key !== dwell.key) {
    if (dwell.timer) clearTimeout(dwell.timer);
    dwell = {
      key,
      at: performance.now(),
      timer: key ? setTimeout(() => { dwell.timer = null; refreshGhost(true); }, BOARD_DWELL_MS) : null,
    };
  }
  const ripe = ripeBoard(f, board);
  // Stamped on every frame it is still under the pointer, so the grace below
  // runs from when you LEFT rather than from when you arrived — otherwise
  // resting on a pile for a second would use the whole stick up standing still.
  if (ripe) stick = { id: f.id, board: ripe, at: performance.now() };
  return ripe;
}

/**
 * The pile the pointer settled on, still lit a moment after it left.
 *
 * `settledBoard` first, so a live aim always wins and nothing here can hold a
 * board the pointer has moved off onto another one. The grace only applies when
 * the pointer is over **nothing at all** — no fixture, no crate — which is the
 * one state where holding it promises nothing about a press that is not already
 * true. Point at another pile, at the unit's own frame, at a crate or at a hire
 * and it is gone on that frame: those are all targets with presses of their own,
 * and a cage lit over one of them would be the green-ghost bug with a marker on
 * it, which is the whole thing `boardTakes` and the dwell exist to keep out.
 *
 * Re-resolved by id every frame rather than kept as a record, and dropped the
 * moment either the unit or the pile has gone — a cage is measured off the
 * meshes, so one held over goods that have sold falls back to a frame on the
 * tile, which says the wrong thing about a shelf you are not even pointing at.
 */
function heldBoard(aim) {
  // WHAT THE POINTER IS ON WINS, always. A pick is where the marker RESTS —
  // the pile you go back to when you are pointing at nothing — rather than a
  // lock on the pointer, because the thing you do with a board selected is walk
  // the aisle with it, and an aisle you cannot see the boards of is an aisle you
  // have to stop in. Pressing another pile is what moves the selection; hovering
  // one only ever shows it to you.
  const board = settledBoard(aim?.fixture ?? null, aim?.board ?? null);
  if (board) { unstickLater(0); return { f: aim.fixture, board }; }
  if (aim?.fixture || aim?.crate) { unstickLater(0); return null; }
  // The pick has no deadline; the stick is the 700ms grace under an unpicked
  // pile. Both go through the same liveness test, so a board that sells out
  // takes whichever was resting on it with it.
  const on = pick.id ? pick : stick;
  const left = pick.id ? Infinity : BOARD_STICK_MS - (performance.now() - stick.at);
  if (!on.id || left <= 0) { unstickLater(0); return null; }
  const held = liveBoard(on);
  if (!held) {
    if (pick.id === on.id) pick = { id: null, board: null };
    else stick = { id: null, board: null, at: 0 };
    unstickLater(0);
    return null;
  }
  // The same reason the dwell has a timer: nothing fires while the pointer is
  // still, so a hand that stops on bare floor beside the shelf would hold the
  // cage for ever — the grace would only ever expire on the next thing you did.
  unstickLater(left);
  return held;
}

/**
 * Is this remembered pile still there? A cage is measured off the meshes, so one
 * held over goods that have sold falls back to a plain frame on the tile — which
 * says the wrong thing about a unit you may not even be pointing at. By id and
 * re-resolved every frame, because a re-flow re-mints every fixture.
 */
function liveBoard(at) {
  const f = scene.fixtureById(at.id);
  if (!f) return null;
  if (!shelfById(at.id)?.stacks?.some((k) => k.item_id === at.board)) return null;
  return { f, board: at.board };
}

let stickTimer = null;

/**
 * Re-run the hover pass when the grace runs out. `0` just cancels, and so does
 * `Infinity` — a pick has no deadline, so there is nothing to wake up for.
 */
function unstickLater(ms) {
  if (stickTimer) clearTimeout(stickTimer);
  stickTimer = ms > 0 && ms !== Infinity
    ? setTimeout(() => { stickTimer = null; refreshGhost(true); }, ms + 16)
    : null;
}

/**
 * ...and the same answer without arming anything, for the press.
 *
 * Pure on purpose: a press must not be able to start a dwell of its own, or the
 * first press after crossing a shelf would ripen the board it landed on and the
 * gesture would be back to naming whatever the pointer swept over. The hover is
 * the only thing that ever sets the clock; this only ever reads it.
 */
function ripeBoard(f, board) {
  if (!f || !board) return null;
  // A picked pile needs no dwell — naming one is paid for once, so the second
  // loaf and the third cost no holding still. It does NOT close the other piles
  // though, and that is deliberate: you walk an aisle with a board selected and
  // want to see what the next unit is holding, so every other pile goes on
  // ripening the ordinary way and a PRESS is what moves the selection. The pick
  // is where the marker rests, not a lock on the pointer.
  if (pick.id === f.id && pick.board === board) return board;
  if (dwell.key !== `${f.id}:${board}`) return null;
  return performance.now() - dwell.at >= BOARD_DWELL_MS ? board : null;
}

/**
 * Every press that would do something at whatever the pointer is on.
 *
 * The pill under the HUD has always been driven by `p.action` — the job the shop
 * has ARMED — which is a different question from the one a player standing in
 * their own shop is asking. An armed action exists only after you have named a
 * target and walked to it, so the pill could name one job, in one direction,
 * after you had already worked out how to start it. Everything before that
 * moment said nothing at all: point at a crate and there is no word about
 * picking it up, stand with a box on your shoulder looking for somewhere to put
 * it and nothing anywhere says which button sets it down. The one gesture in the
 * game that is genuinely undiscoverable — **a tap is one unit, a hold is the
 * lot** — was never written down on screen either, because a hold and a tap are
 * one armed action and the pill only ever had room for its name.
 *
 * So this answers the pointer instead, and it answers with a LIST: every button
 * and every length of press that means something here, in the order the presses
 * themselves are decided (left before right, tap before hold).
 *
 * It is deliberately a mirror of the press code rather than a second opinion
 * about the rules — every test in here is the same call the press makes
 * (`inReachOf`, `canDropAt`, `haulSquare`, `boardTakes`), because a hint that
 * offers a press the shop then refuses is the green-ghost bug with words on it.
 * Which MESSAGE a press is, is decided on this side (see `tapAtPointer` and
 * `armPut`), so this is the only side that can list them; what it must never do
 * is invent a rule of its own.
 *
 * Order matters and follows the pointer's own precedence: a person, then a
 * crate, then a fixture, then bare ground. Same order `tapAtPointer` reads them
 * in, or the pill would describe a press that lands on something else.
 */
function pressHints({ aim, board, onPile, drop }) {
  // Build mode arms nothing but the till, so every sentence in here would be
  // about a press the mode has suspended — the same three exclusions `dropping`
  // and `boardTakes` already make, and for the same reason: with a bar up, the
  // pointer belongs to the bar.
  if (ui.paletteArmed || ui.holding || ui.demolishArmed()) return [];
  const out = [];
  // `tag` is what makes the press something other than a click — the length of
  // it (`hold`) or the number of them (`twice`). It is a word rather than a
  // boolean because a shelf needed a third: select, open, and a double press
  // that goes, which is three meanings on one button and no room for a flag.
  // `run` is what makes the row a BUTTON on a touchscreen — the same press,
  // made from the pill. It is written at each site rather than derived from
  // `say`, because the site is the only place that already knows which press
  // this sentence is about; a lookup from the words back to a call would be the
  // second opinion this whole function is written not to be. Held presses say so
  // by passing `true` to `pillPress`, which is the one thing a list cannot
  // express on its own — see there.
  //
  // ONE SENTENCE PER OUTCOME, NOT PER BUTTON. Where both buttons do the same
  // thing by the same press — a crate out of reach is the walk either way — the
  // list used to carry the row twice, so the pill read "Go to it | Go to it"
  // with a mouse on each end: two chips, one divider, and one fact. The words
  // are the promise here, so a twin is folded onto `btn: 'lr'` and the renderer
  // puts a mouse on both sides of the one sentence. The tag has to match as well
  // as the words, or a shelf's "Go to it" TWICE and its plain right-button walk
  // — three presses that are genuinely different gestures — would collapse into
  // a row that lies about how to make it.
  const add = (btn, tag, say, run = null) => {
    const twin = out.find((h) => h.say === say && h.tag === tag && h.btn !== btn);
    if (twin) { twin.btn = 'lr'; return; }
    if (out.length < 4) out.push({ btn, tag, say, run });
  };
  const carry = myCarry();
  const haul = myHaul();
  const crate = aim?.crate ?? null;
  // THE THING YOU SENT YOURSELF TO IS STILL THE THING, and that is what makes
  // "Go there" finish its own sentence. The list is re-derived from the POINTER
  // every snapshot, and a walk moves the camera under a pointer that is not
  // going to move again on a touchscreen — so pressing Go there took you to the
  // shelf and then answered about whatever had drifted under your last tap,
  // which is a press that works and then loses the thing it worked on.
  //
  // The selection is the answer because the tap already made it (`tapAtPointer`
  // → `openInTwo` → `selectFixture`), so this is not a second kind of aim: it is
  // the one the player can see, ringed, and it survives the journey. The pointer
  // still wins where it has something to say, which keeps a deliberate aim at
  // something else from being ignored — this is the fallback, not an override.
  const f = aim?.fixture
    ?? (pillDrives() && !crate ? scene.fixtureById(ui.fixtureRef?.id) ?? null : null);

  if (crate && !f) {
    // A box on the floor with one already on your shoulder is the SQUARE it
    // stands on — see `haulSquare`, and the ring round the crate stands down for
    // the same reason. So the only thing on offer is putting yours down there.
    if (onPile) {
      if (canDropAt(onPile)) {
        add('r', 'hold', 'Set the crate down here',
          () => pillPress(() => net.send('place', { x: onPile.x, z: onPile.z }), true));
      }
      return out;
    }
    if (!inReachOf(crate)) {
      const go = () => net.send('take', { palletId: crate.id });
      // Both buttons are the same journey, so with one pointer it is one row.
      if (pillDrives()) { add('l', null, 'Go there', go); return out; }
      add('l', null, 'Go to it', go);
      // Both buttons walk. The right one's own jobs all need you standing there
      // (`armPut` opens with `dropping()` and refuses a box out of reach), so
      // out here it falls down its ladder to the same tail the left button has
      // — see the end of the right-button `pointerup`. Said rather than left to
      // be discovered, because a button that works at four tiles and does
      // nothing at eight reads as the shop being unreliable. Both rows are still
      // written, because the fact is about two buttons; `add` is what folds them
      // into the one sentence with a mouse at each end.
      add('r', null, 'Go to it', go);
      return out;
    }
    const lift = () => pillPress(() => net.send('take', { palletId: crate.id }), true);
    // A buried box is a box and nothing else: one unit out of a band of a dozen
    // pixels is never the tin anybody meant, so a pile offers the lift only.
    if (crate.stacked) { add('l', 'hold', 'Pick this box up', lift); return out; }
    if (haul) return out;
    add('l', null, 'Take one',
      () => net.send('crate-one', { palletId: crate.id, put: false }));
    add('l', 'hold', carry ? 'Take an armful' : 'Pick the crate up', lift);
    if (carry) {
      add('r', null, 'Put one back',
        () => net.send('crate-one', { palletId: crate.id, put: true }));
    }
    return out;
  }

  if (f) {
    // Out of reach the two buttons are not the same press at all, and that is
    // the half this pill got wrong first time out. The LEFT one is
    // `openInTwo` wherever the unit is standing — one press picks it out, two
    // opens it, and only a *double* press walks — so a flat "Go to it" was
    // naming the one gesture of the three nobody makes by accident. The RIGHT
    // one really does go on a single press, either down `armPut`'s `walk` (which
    // carries the direction, so you arrive with the put armed) or, empty-handed,
    // down its own ladder to the plain walk at the tail of `pointerup`.
    if (!nearFixture(f) && !atWorkSpotOf(f)) {
      // ONE ROW WHERE THERE IS ONE BUTTON. The three below are three different
      // presses on two mouse buttons — select, double-press to walk, right-press
      // to walk carrying — and with a single pointer they collapse into the only
      // thing you can mean about something you are not standing at: go to it.
      // Selecting is not lost, it is the tap itself (`tapAtPointer`), so a row
      // for it here would be the press you just made.
      if (pillDrives()) {
        add('l', null, (carry || haul) ? 'Take it there' : 'Go there',
          () => walkTo({ fixture: f.id, put: !!(carry || haul) }));
        // ...and the menu, which is the other thing you can mean about a unit
        // across the shop and the one this branch used to swallow. Pricing a
        // board, reading what is on it, ticking it for an item: none of those
        // wants you to walk anywhere, and with the walk as the only row the way
        // to ask was to go and stand there first.
        //
        // Second, because going is what a tap on something distant usually
        // means. Unconditional and unconditionally worded: see `openInTwo`'s
        // `open` for why a row must never be labelled off the selection.
        add('l', null, 'Open it', () => openInTwo(f, { open: true }));
        return out;
      }
      add('l', null, ui.isSelected(f) ? 'Open it' : 'Select it', () => openInTwo(f));
      add('l', 'twice', 'Go to it', () => walkTo({ fixture: f.id }));
      add('r', null, (carry || haul) ? 'Take it there' : 'Go to it',
        () => walkTo({ fixture: f.id, put: !!(carry || haul) }));
      return out;
    }
    // SELECTING IS WHAT THE LEFT BUTTON DOES WHEN NOTHING ELSE IS ON OFFER, and
    // for three kinds it was the one press this pill never mentioned. A station,
    // a skip and a plot each answer here and return, so a machine you are
    // standing at with an empty tray and empty hands produced NO rows at all —
    // and a pill with nothing in it is not on screen. What that reads as is
    // "some of my appliances have the helper and some don't", because the ones
    // across the room do: the out-of-reach branch above offers it to everything.
    //
    // Worked out first and added last so it stays where it belongs in the order
    // — the left button's own jobs come before backing off to a selection, which
    // is the precedence `tapAtPointer` reads them in.
    const selects = out.length;
    // ...and where the pill drives, only ever the OPEN half of it.
    //
    // "Select it" is the press you have just made — the out-of-reach branch above
    // says so and drops the row for exactly this reason; standing at the thing it
    // was still being offered. What that produces is a row that changes under
    // your own finger: tap a unit and the pill flashes "Select it" and then
    // rewrites itself to "Open it" a frame later, which reads as the shop
    // arguing with the tap.
    //
    // The open half stays and is the whole point on a phone: with no hover and
    // no R or M, a selection's only remaining job is to be a thing the pill can
    // be about, and the menu is one press further in. So the grammar is honest —
    // the tap picks, the pill opens — instead of a two-press ladder whose first
    // rung is invisible.
    const select = () => {
      if (pillDrives()) { add('l', null, 'Open it', () => openInTwo(f, { open: true })); return; }
      add('l', null, ui.isSelected(f) ? 'Open it' : 'Select it',
        () => openInTwo(f, { walk: true }));
    };
    // ...AND THE RIGHT BUTTON STILL WALKS, which every branch below forgot to
    // say. With empty hands the right press falls all the way down its ladder to
    // a plain `walkTo` on whatever the pointer named (see the tail of the
    // right-button `pointerup`), so an empty shelf you are standing *near* — not
    // at its working side — answered with one row saying "Select it" while the
    // other button quietly did the useful thing. Out of reach the pill has said
    // this from the start; near it, it went silent, which reads as the button
    // being live at eight tiles and dead at three.
    //
    // Three tests, and each is the press's own:
    //   - hands, because a put outranks the walk and is already listed.
    //   - `onWorkSpotOf` — STANDING on a working tile, not merely in reach of
    //     one, which is the distinction that had this row hidden everywhere. In
    //     reach is where you can work it from; on the spot is where the walk
    //     would not move you, and a row that changes nothing is worse than none.
    //   - `ui.escape(true)`, which is the ladder ABOVE the walk asked without
    //     being made to act. A menu open, a pile picked, a selection standing —
    //     any of those eat the press, and the commonest one is the selection this
    //     same pill just told you to make.
    const stepOver = () => {
      if (carry || haul || onWorkSpotOf(f) || ui.escape(true)) return;
      add('r', null, 'Go to it', () => walkTo({ fixture: f.id }));
    };
    // `readyToTake` and never a field on `f`: the pointer hands back the LAYOUT
    // record, and whether there is a tray to empty or fruit on the bed is on the
    // snapshot. Same call the tap makes, so the two cannot disagree.
    if (f.kind === 'station') {
      if (readyToTake(f)) {
        add('l', null, 'Take one out', () => net.send('station-one', { stationId: f.id }));
        // The errand and not a message of its own: a hold is `p.action` winding
        // off whatever the errand named, and naming a fixture you are already
        // standing at is a walk with no steps in it. Same four kinds of address
        // every other target uses.
        add('l', 'hold', 'Empty the tray',
          () => pillPress(() => walkTo({ fixture: f.id }), true));
      }
      if (carry || haul) {
        add('r', null, 'Put one in',
          () => net.send('station-one', { stationId: f.id, put: true }));
        add('r', 'hold', 'Load it up',
          () => pillPress(() => net.send('place', { fixture: f.id }), true));
      }
      // Only when the left button has nothing else to do with it: with a tray to
      // empty, the tap is "Take one out" and offering the menu beside it would
      // name two different things for one press.
      if (out.length === selects) select();
      stepOver();
      return out;
    }
    // The one fixture whose whole meaning is that nothing comes back, so it is
    // the hold and never the tap — `armPut` gives it no tap at all.
    if (f.kind === 'bin') {
      if (carry || haul) {
        add('r', 'hold', 'Throw it away',
          () => pillPress(() => net.send('place', { fixture: f.id }), true));
      }
      // The skip's left button has no job at all — everything it does is the
      // hold on the right — so this is the only row it ever offers empty-handed.
      select();
      stepOver();
      return out;
    }
    if (f.kind === 'plot') {
      // The one action that charges with no button down (`auto`), so naming the
      // bed is the whole of it — there is nothing for the pill to hold.
      if (readyToTake(f)) add('l', null, 'Harvest it', () => walkTo({ fixture: f.id }));
      else select();
      stepOver();
      return out;
    }
    // A board the pointer has settled on. `boardTakes` is the same test the
    // press asks, so the cage round the pile, the tap and this line agree.
    if (ripeBoard(f, board) && boardTakes()) {
      add('l', null, 'Take one', () => {
        pickBoard(f, board);
        net.send('shelf-one', { shelfId: f.id, itemId: board });
      });
      add('l', 'hold', 'Crate the lot', () => pillPress(() => {
        pickBoard(f, board);
        net.send('take', { shelfId: f.id, itemId: board });
      }, true));
    } else {
      // **The left button does not walk you to a unit, and saying it did was
      // this pill's own version of the green ghost.** `openInTwo` grades one
      // button three ways by the clock — press one picks it out, press two opens
      // it, and a DOUBLE press is the walk — so "Go to it" was describing the
      // gesture nobody makes by accident while the press you were about to make
      // did something else entirely. Which of the three is offered depends on
      // what is already selected, read through `ui.isSelected` because that is
      // the same question `openInTwo` asks a frame later.
      // Same rule as `select` above: on a phone there is one row, it says one
      // thing, and it does that thing.
      if (pillDrives()) add('l', null, 'Open it', () => openInTwo(f, { open: true }));
      else add('l', null, ui.isSelected(f) ? 'Open it' : 'Select it', () => openInTwo(f));
    }
    if (carry || haul) {
      add('r', null, 'Put one on', () => {
        const itemId = ripeBoard(f, board);
        pickBoard(f, itemId);
        net.send('shelf-one', { shelfId: f.id, itemId, put: true });
      });
      // `place` and NOT a walk, which is the difference between pouring a crate
      // out and putting one unit down. `armPut` sends exactly this when the
      // right button goes down at a unit you are standing at, and the errand a
      // `walk-to` sets is the other one — measured: a 1.7s hold moved a single
      // carrot, which reads as the button being broken rather than as the wrong
      // errand having been armed. Same message for every right-hand hold below.
      add('r', 'hold', 'Stock it',
        () => pillPress(() => net.send('place', { fixture: f.id }), true));
    }
    stepOver();
    return out;
  }

  // Bare ground, which only has anything to say while your hands are full — a
  // hint on every empty square you cross is a pill that never goes away.
  if (drop && canDropAt(drop)) {
    add('r', 'hold', haul ? 'Set the crate down here' : 'Put it down here',
      () => pillPress(() => net.send('place', { x: drop.x, z: drop.z }), true));
  }
  return out;
}

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
/**
 * Three presses on one thing, and which you made is decided by the CLOCK.
 *
 * Select, then open, and a double press goes. The walk used to ride on the
 * first press — "you pointed at that shelf because you are going to it" — and
 * that is true often enough to have shipped and wrong often enough to be worth
 * a gesture: pricing a unit, reading a board, picking one out to turn or move
 * are all questions asked from where you stand, and every one of them sent you
 * across the shop first. Aiming at something is not agreeing to walk to it.
 *
 * There is no deferral in here and there must not be. The second press is both
 * "open it" and the back half of a double press, so the choice is made at the
 * moment that press lands, off how long ago the last one was — waiting out
 * `DOUBLE_MS` to see whether a third is coming would put a visible pause on the
 * single commonest press in the game.
 *
 * Only when `walk` is true, which is the caller's decision. Build mode never
 * walks you: it flies the view somewhere you cannot stand (`setFreeRoam`), so
 * going there is exactly what you did not ask for.
 */
const DOUBLE_MS = 400;
let lastFixtureTap = { id: null, at: 0 };

function openInTwo(f, { walk = false, open = false } = {}) {
  // ...and `open` is the door out of the ladder, for a caller that is not a
  // press on the world at all.
  //
  // The ladder grades one press by what is already selected, which is right for
  // a pointer aimed at a shelf and wrong for a BUTTON that says "Open it": the
  // button has named the unit and named the verb, so there is nothing left for a
  // ladder to decide. Without this the pill's own row had to be gated on
  // `ui.isSelected` to know what to call itself — and that is a value which
  // changes one frame after the tap, so the row drew itself, then redrew itself
  // saying something else. Which is the flashing.
  if (open) {
    if (!ui.isSelected(f)) ui.selectFixture(f);
    scene.ripple(f.x, f.z, 'miss');
    showFixture(ui, f);
    return;
  }
  const now = performance.now();
  const quick = lastFixtureTap.id === f.id && now - lastFixtureTap.at < DOUBLE_MS;
  lastFixtureTap = { id: f.id, at: now };

  // Amber, and it is the only press here that gets it: amber is "you are on
  // your way", pale is "I heard you". Selection survives the walk — you are
  // going to the thing you just named, so arriving with it deselected would be
  // the gesture forgetting its own subject.
  if (walk && quick) {
    scene.ripple(f.x, f.z);
    walkTo({ fixture: f.id });
    return;
  }

  if (!ui.isSelected(f)) {
    // Read BEFORE selecting, because `selectFixture` closes an open fixture
    // panel on its way to picking the new thing — so asking afterwards always
    // answers "nothing was open" and the swap silently becomes a close. That is
    // the whole of why this looked like the panel dismissing itself.
    const swapping = ui.openPanel === 'fixture';
    ui.selectFixture(f);
    scene.ripple(f.x, f.z, 'miss');
    // With a menu already up, pointing at another unit SWAPS it rather than
    // costing a second press. "Pressing a different thing starts again at one"
    // is right while nothing is open — the first press is how you ask which one
    // that is — and wrong once a panel is answering that question: you are
    // comparing two shelves, and every unit after the first cost a press that
    // told you nothing you could not already see.
    if (swapping) showFixture(ui, f);
    return;
  }
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
  if (over && !ui.demolishArmed()) {
    // Selected as well as opened, or the hold is a *worse* way in than the two
    // taps it exists to replace: R and M act on the selection, so a menu opened
    // without one would leave the keys pointing at whatever you last tapped.
    ui.selectFixture(over);
    showFixture(ui, over);
    return true;
  }

  // ...and last, a way through, which is the only thing you can look at that is
  // not a thing at all: a doorway has no tile, no id and no record — it is a
  // number on a lattice line. `pickWay` owns the precedence, because the hover
  // asks it the same question and the amber bar it draws has to be a promise
  // about this press.
  const way = pickWay(cx, cy);
  if (way) { showEdgeMenu(ui, way); return true; }
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
        // ...unless the pill is where the verbs live. See `pillDrives`: the
        // press already named the crate on the way down, so stopping here is
        // exactly "you have the list now", and Take one is on it.
        if (pillDrives()) return;
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
      // What it costs is that a bed with fruit on it, or a machine with a full
      // tray, has no menu on the TAP while it is ready. The hold is the way in
      // (`HOLD_OPENS`) and build mode is the other — and the bed stops being
      // ripe the moment you get there, which is the whole point of the branch.
      // Full hands used to be in this test beside `readyToTake`, and they are the
      // half the right button took over. "Pointing at a shelf with an armful is
      // an errand and not a question" was true while one button had to mean both
      // directions; it is the guess itself now, and it cost the other gesture —
      // a board you wanted one loaf off was unreachable with anything in your
      // hands, because the unit won the whole tap. Right-tap walks you to a unit
      // to PUT, this one is takes and questions, and neither reads your hands.
      if (readyToTake(over)) {
        // Amber, not pale: this one really is "you are on your way".
        scene.ripple(over.x, over.z);
        // ...except standing at it, where there is nowhere to go and the walk is
        // a no-op. That is the same press-that-does-nothing the board branch
        // below spells out, and on a machine it was the whole of what "ready to
        // collect" bought you: a full tray, a tap that visibly did nothing, and
        // the goods only moving once you found the hold. A tap is one portion
        // and the hold is still the tray — the grade a crate and a board draw.
        //
        // Both reach tests, because `Game.tapStation` accepts either: a machine
        // is worked from its `useAt`, and standing against the thing itself is
        // equally close enough for the verb.
        if (over.kind === 'station' && (nearFixture(over) || atWorkSpotOf(over))) {
          // The pill's job where it has one — see `pillDrives`. `openInTwo`
          // rather than a bare return, because a machine has a menu worth
          // reaching and the tap is the only way to it now.
          if (pillDrives()) { openInTwo(over, { walk: true }); return; }
          net.send('station-one', { stationId: over.id });
          return;
        }
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
      if (ripeBoard(hit?.f, hit?.board) && boardTakes()) {
        pickBoard(over, hit.board);
        scene.ripple(over.x, over.z);
        // Standing at it, the tap NAMES the pile and stops — `pickBoard` above
        // is the whole of what it does, and that selection is what keeps the
        // pill about this board rather than about whatever the aim wanders onto.
        // See `pillDrives`. The walk is untouched: out of reach, a tap is still
        // how you get there.
        if (nearFixture(over)) {
          if (!pillDrives()) net.send('shelf-one', { shelfId: over.id, itemId: hit.board });
        } else net.send('take', { shelfId: over.id, itemId: hit.board });
        return;
      }

      openInTwo(over, { walk: true });
      return;
    }

    // A way through, which is the one thing you can point at that has no tile
    // and no id — a doorway is a number on a lattice line. So it opens on ONE
    // press rather than the two a fixture takes: the second press exists so the
    // first can spend itself on the walk and on selecting for R and M, and a
    // doorway has no working spot to walk to and no build verb bound to a key.
    // The amber bar under the pointer is the promise, and `pickWay` is the same
    // question the hover asked, so the two cannot disagree.
    //
    // Above the dismissal below for the reason a fixture is: pointing at a thing
    // is a positive act, so with a menu up it means "that one instead".
    const way = pickWay(cx, cy);
    if (way) {
      const spot = scene.pickTile(cx, cy);
      // Pale, like every other press that opens a panel rather than going.
      if (spot) scene.ripple(spot.x, spot.z, 'miss');
      if (ui.openPanel === 'way' && sameSpot(ui.wayRef, way)) ui.closePanel();
      else showEdgeMenu(ui, way);
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
  const placing = !ui.holding;
  net.send(ui.holding ? 'build-drop' : 'build-place', spec);

  // ...and on a phone, ONE tap buys one thing. The tool stays armed on a desktop
  // because that is what makes a row of shelving a row of clicks, and a mouse
  // pays nothing for it: the ghost sits under the pointer where you can see it,
  // and the next click is aimed. A finger has neither half — there is no hover,
  // so the only way to find out the tool is still live is to tap the floor and
  // buy a second shelf, and the ghost is under your thumb where you cannot see
  // it. What that reads as is the shop buying things you did not ask for.
  //
  // The BAR stays up, deliberately: what is spent is the tool, not the mode, so
  // the next unit is one tap on the strip rather than a trip back into build.
  // And only a placement — a fixture you were carrying is a move that finishes
  // itself (`markMoveTarget` hands the borrowed mode back), and a wall or a
  // floor is a drag, which arms nothing here.
  if (placing && pillDrives()) ui.disarmTool();
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
const building = () => ui.paletteArmed || !!ui.holding;

/**
 * ...and stopped time is the other one, for a different reason that lands in the
 * same place.
 *
 * Build mode flies because you are reaching for somewhere you cannot stand. A
 * paused shop flies because you cannot stand ANYWHERE: the world does not step
 * while it is held, so the input the keys send is read by nobody and holding W
 * against a stopped shop is the one gesture in the game that visibly does
 * nothing at all. The camera is chained to a body that will not move, so a pause
 * is also the one state where the 14-tile leash has nothing to protect — losing
 * you is impossible when you are not going anywhere.
 *
 * Only the KEYS, deliberately. The drag stays `building()`, because the
 * inversion there is an argument about which errand you are on — a map you pull
 * toward you against a place you are reaching for — and pausing to look at your
 * own shop is squarely the first of those. A finger whose drag reversed
 * direction on the press of the pause button would read as the pause breaking
 * the camera.
 */
const flying = () => building() || ui.paused;

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

/**
 * The frame clock, on screen, for `?perf`.
 *
 * Off unless the URL asks, because it is a developer's readout and not a
 * feature: it sits over the shop, it updates four times a second, and nobody
 * playing has a use for a number that only means something next to another
 * number. It exists because "it feels chunky" is a report nobody can act on and
 * "38fps, 21ms, 940 draws" is — and because the machine it is chunky on is
 * never the machine you are sitting at.
 *
 * Frame time as well as fps, and the two are not the same claim: fps averages
 * away the hitch that is actually being complained about, so the WORST frame in
 * each window is printed beside the mean. Draw calls and triangles come off
 * `renderer.info`, which is the difference between "this machine is slow" and
 * "this shop is heavy" — and `render.calls` is per frame, reset by three on
 * every draw, so it is read rather than accumulated.
 */
const perfOn = new URLSearchParams(location.search).has('perf');
const perf = { at: 0, frames: 0, worst: 0, el: null };

function stepPerf(now, ms) {
  if (!perfOn) return;
  if (!perf.el) {
    perf.el = document.createElement('div');
    // Its own element with its own styles rather than a HUD class: the HUD is
    // laid out in stacks that other things measure (`--build-h` and friends),
    // and a debug readout that pushed the toolbar around would be changing the
    // thing it was brought in to measure.
    perf.el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;'
      + 'font:600 11px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.62);'
      + 'padding:4px 7px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.append(perf.el);
  }
  perf.frames += 1;
  perf.worst = Math.max(perf.worst, ms);
  if (now - perf.at < 250) return;
  const fps = Math.round((perf.frames * 1000) / (now - perf.at));
  const info = scene.renderer?.info;
  perf.el.textContent = `${fps} fps  ${(1000 / Math.max(1, fps)).toFixed(1)}ms`
    + `  worst ${perf.worst.toFixed(1)}ms\n`
    + `${info?.render?.calls ?? 0} draws  ${((info?.render?.triangles ?? 0) / 1000).toFixed(0)}k tris`
    + `  dpr ${scene.renderer?.getPixelRatio?.().toFixed(2) ?? '?'}`;
  perf.at = now;
  perf.frames = 0;
  perf.worst = 0;
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  stepPerf(now, now - lastFrame);
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
  bootSay('Opening the shop…');
  ui.worldId = worldId;
  await net.connect(name, worldId);
  rememberInUrl(worldId);
  bootDone();
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
  //
  // ...and a shop you have just MADE gets the tour, which is the other half of
  // that argument: nothing above is discoverable by pressing things, and the
  // answer to that is a thing that shows you rather than a line you read past.
  // It asks its own three questions and usually decides not to — see
  // `maybeStart`.
  tutor.maybeStart(worldId);
  // Only the web build can host a friend — see client/coop.js. Asked as a
  // capability, like everything else about which transport this is.
  // No button to mount any more — the invite is a row in the Menu, and this is
  // only the peer count it reads. Still lazy for the same reason it always was:
  // a build that cannot host never loads the module at all.
  if (net.host) import('./coop.js').then((m) => m.watchCoop(net));
  loop();
}

async function start() {
  const stored = localStorage.getItem('sns-name') ?? '';
  const name = params.get('name') ?? stored;

  /**
   * Arrived on somebody's invite link.
   *
   * Before the menu and before any world is opened, because this browser's own
   * shops are not what the link is about — and a front door that flashed up a
   * list of saves on the way to a friend's shop would be asking a question
   * nobody asked. Falls through to the menu if it does not work out, which is
   * the honest answer to an expired code.
   */
  const invited = params.get('join');
  if (invited && net.host) {
    const { showJoin } = await import('./coop.js');
    const channel = await showJoin({ name, code: invited });
    // Drop the code out of the address bar either way: it is spent, and a
    // reload would try to use it again.
    const clean = new URL(location.href);
    clean.searchParams.delete('join');
    history.replaceState(null, '', clean);
    if (channel) return openAsGuest(channel, name || 'Guest');
  }

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
      bootSay('Loading the shops…');
      pendingError = `That shop is gone — ${err.message}`;
    }
  }

  // Stays up until the front door has something on it — `Menu.render` is what
  // stands this down, because the two screens draw the same sky and the wait
  // between opening the menu and its first paint is a fetch.
  bootSay('Loading the shops…');
  const menu = new Menu(document.getElementById('menu'), pendingError);
  const picked = await menu.choose();
  // Joining is not picking a shop: `guest` is a live connection to somebody
  // else's, already open, with no world of ours behind it. Everything after
  // this point is identical — which is the point.
  if (picked.guest) return openAsGuest(picked.guest, picked.name || name || 'Guest');
  await openWorld(picked.worldId, picked.name || name);
}

/**
 * Somebody else's shop, over a data channel.
 *
 * `net` is swapped for the guest's connection and the rest of the client never
 * finds out: the handlers below were wired to `net` by reference at boot, so
 * they have to be re-pointed at the new one, which `rewire` does. No world id
 * goes in the address bar — the shop is not ours and the link would open a
 * save this browser does not have.
 */
async function openAsGuest(channel, name) {
  bootSay('Joining the shop…');
  net.becomeGuest(channel, name);
  bootDone();
  // ...and a guest gets shown round too, which for the whole of co-op they were
  // not: `maybeStart` is gated on a world this browser MADE, and a guest has no
  // world at all — so the one person in the game who has never seen it before
  // was the one person the tour never ran for. A different list, for a shop that
  // is furnished, trading and somebody else's. See `guestStart`.
  tutor.guestStart();
  // No `?world=` in the address bar: the shop is not ours, and the link would
  // open a save this browser does not have. The invite code is the only way in.
  loop();
}

start().catch((err) => {
  document.getElementById('menu').hidden = true;
  bootFail(`Could not reach the shop: ${err.message}`);
});
