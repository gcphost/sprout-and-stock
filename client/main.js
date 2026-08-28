/**
 * CLIENT ENTRY POINT — input, render loop, and glue.
 */

import {
  canPlaceEdges, edgeRun, canPaintGround, canPaintFaces, faceRun, faceKey,
  groundStroke, strokeThick, GROUND_STROKE_MAX, fixtureRunCells, BELT_RUN_MAX, RUN_KINDS, CONVEYOR_KINDS, canPlace, FIXTURES, CEILING, goesOverhead,
  faceAlong, isProp, isWalkableTile, workSpotOf, REACH, conveyorAt, groundIndex, rot4,
  quadCells, footprint,
} from '../shared/build.js';
import { E, SOLID, edgeBetween } from '../shared/edges.js';
import { lotStacks, lotMain, lotRoom, lotTotal } from '../shared/lot.js';
import { Scene } from './render/scene.js';
import { Transport } from './transport.js';
import { UI } from './ui.js';
import { pillDrives } from './input.js';
import { RAIL_ITEMS } from './sections.js';
import { showFixture, refreshFixture } from './fixture-menu.js';
import { showWorker } from './worker-menu.js';
import { showEdgeMenu, hasEdgeMenu, kindAt } from './edge-menu.js';
import { Menu, preselectedWorld, setMenuApi, enableJoin } from './menu.js';
import { bootSay, bootDone, bootFail } from './boot.js';
import { Award } from './award.js';
import { track, shopOpen } from './analytics.js';
import { Tutor } from './tutor.js';
import { wireDrag, restorePos } from './panel-drag.js';
import { wireCorner } from './corner.js';
import { cinemaOn, setCinema, onCinema } from './cinema.js';
import { debugOn, onDebug } from './debug.js';
import { mix } from './audio/mix.js';
import { sfx } from './audio/sfx.js';
import { music } from './audio/music.js';
import { events } from './audio/events.js';

const canvas = document.getElementById('game');
const scene = new Scene(canvas);
// The one wire between the recording mode and the renderer, made once. Cinema
// is otherwise a class on `<body>`; what the scene wants out of it is the
// second set of easing gains — see `CINE_EASE`. Registered here rather than set
// at each press, because there are two presses (the key and the switch tile)
// and a mode half of them told the camera about is a capture that glides only
// when you started it the right way.
onCinema((on) => { scene.cinema = on; });
// Hand the GPU context back when the page actually goes away — see
// `Scene.destroy`. `persisted` is the bfcache case, where the page is being put
// aside and may come straight back: tearing the renderer down there would
// restore a shop with no context to draw into, which is `localnet.js`'s note
// about `pagehide` said about the renderer instead of the save.
addEventListener('pagehide', (e) => { if (!e.persisted) scene.destroy(); });
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
// see client/award.js. `dropGesture` is the other half of stopping: a card
// arrives on the shop's clock rather than on a press, so it is the one overlay
// that can land in the middle of a camera turn. Hoisted, so the forward
// reference from here is fine.
const award = new Award(ui, document.getElementById('award'), () => dropGesture('award card'));
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

/**
 * Does this device have a pointer that can rest on things?
 *
 * `:hover` is not a question a touchscreen can answer, and browsers answer it
 * anyway: a tap leaves the element hovered until you tap something else. So
 * every hover style in the game — a tab, a build tile, a menu row, the clock —
 * stays lit on the last thing you pressed, which reads as a button stuck in some
 * state you did not put it in.
 *
 * Every `:hover` rule in the stylesheet is written `html.can-hover X:hover`, and
 * this is the one line that turns them all on. A class rather than wrapping
 * fifty rules in `@media (hover: hover)`, because it is one place to look and one
 * place to change, and because `matchMedia` is live: a laptop with a
 * touchscreen, or a tablet with a keyboard attached, answers differently at
 * different moments and this follows it.
 */
const hoverQ = matchMedia('(hover: hover) and (pointer: fine)');
const markHover = () => document.documentElement.classList.toggle('can-hover', hoverQ.matches);
markHover();
hoverQ.addEventListener('change', markHover);

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
 * How many refusals the shop had told us about when we last looked.
 *
 * `null` until the first snapshot, and that is deliberate: a save reloaded with
 * a refusal already on it would otherwise toast a complaint about something you
 * did before lunch, on the first frame, with nothing on screen to explain it.
 * The first reading only establishes where the count is.
 */
let lastRefused = null;

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
  // ...and a selection that was MOVED lands on this layout rather than following
  // one: a batch move re-mints every id it touched, so what was picked is named
  // by the cells it was sent to. Before the two below, because both are about
  // re-pointing a selection and this one is what there is to re-point.
  ui.claimShifted(scene.allFixtures());
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
// ...and the audio, because what a fixture sounds like is a column on the same
// catalog row its model is on (`sfx` — see shared/schemas.js).
net.on('catalog', (m) => { scene.setCatalog(m); ui.setCatalog(m); events.setCatalog(m); });
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
  // ...and why the last thing you held a button for did not happen.
  //
  // `stepActions` has always said this, into the event feed — which is
  // `display: none` under 720px. So on a phone a refused action was completely
  // silent, and a shelf that will not take what you are holding is exactly the
  // case where trying again cannot possibly help. A toast is the channel every
  // other refusal in the game already uses (`action-result`), and it is the one
  // that is visible wherever you are playing.
  //
  // Watched as a COUNT, so pressing a second time says it a second time: the
  // words are the same and the event is not, and going quiet on the retry is
  // going quiet at the exact moment somebody is asking again.
  const mine = ui.me();
  if (mine?.refused && mine.refused.n !== lastRefused) {
    if (lastRefused !== null && mine.refused.why) {
      ui.toast(mine.refused.why, true);
      // ...and the sound, which this half of the pair never had. A refusal
      // reaches you two ways — `action-result` for a message the shop turned
      // down, and this for an armed action that fired and failed — and only the
      // first one made a noise. That is the wrong way round: a rejected message
      // is instant, so you are still looking at what you pressed, while this one
      // arrives a full ring later, by which time you are watching the animation
      // finish rather than the top of the screen. So the louder failure was the
      // quiet one, and what it read as was the toast not being about the thing
      // you had just done. Same sound, same reason as `net.on('action')`.
      sfx.play('error');
    }
    lastRefused = mine.refused.n;
  }
  const at = ui.me();
  const stirring = at && wasAt && (Math.abs(at.x - wasAt.x) > 0.001 || Math.abs(at.z - wasAt.z) > 0.001);
  wasAt = at ? { x: at.x, z: at.z } : null;
  // ...and the things a finger has no way to let go of, once you have walked off
  // and stopped somewhere else. See `dropOnLeaving`. Before the hints, so the
  // pill is not still offering rows about a unit that has just been dropped.
  if (pillDrives() && !stirring) dropOnLeaving();
  if (!ui.buildOn && !stirring) refreshGhost(true);
  // ...and the tour, which is nothing but a predicate over this snapshot. After
  // `ui.update` on purpose: every step asks a question about the UI as well as
  // about the shop ("is the supplier open"), so it has to be handed a HUD that
  // has already caught up with the frame it is being asked about.
  tutor.update(m);
  // Every sound in the game comes off this diff — see client/audio/events.js
  // for why it is a diff and not the log.
  // ...and the one sound that also moves the camera. The alert says something
  // happened; the cut says WHERE, which in a shop four screens wide is most of
  // the information. Handed in as a callback rather than watched for separately
  // here, so the two cannot disagree about which frame the theft landed on —
  // and so there is exactly one place that decides somebody is newly a thief.
  events.update(m, net.myId, (c) => {
    ui.toast(`${c.name ?? 'Someone'} is walking out without paying!`, true);
    scene.cutTo(c.id);
  });
  // A stopped world is a stopped soundtrack. The renderer already has to be
  // told the same thing (`scene.paused`) for the same reason: both run on the
  // page's clock rather than the shop's.
  music.setPaused(!!m.paused);
});
net.on('news', (m) => ui.toast(`📰 ${m.headline}`));
// The fanfare, unless the rung says otherwise. `first-storm` is the one that
// does, and it is why the field exists: the ladder is being borrowed to explain
// something that has gone WRONG, and a triumphant sting over "somebody walked
// out" reads as the shop congratulating you for it.
net.on('achieved', (m) => {
  award.push(m);
  sfx.play(m.sound ?? 'milestone');
  track('milestone', { milestone_id: m.id });
});
net.on('content-changed', () => ui.toast('New content added — it is live now'));
net.on('action', (res) => {
  clickLog('SERVER answered', { ok: res.ok, error: res.error ?? null });
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
  // ...and the same for a batch move: a refusal sends no layout, so a selection
  // waiting at cells nothing ever arrived on would land on the next re-flow
  // instead — picking out whatever happens to be standing there by then.
  ui.markShifted(null);
});
net.on('disconnected', () => ui.toast('Disconnected from the shop', true));
// A drop the transport is going to try to undo. Said out loud, because the shop
// is frozen while it tries and a shop that has stopped with nothing to say why
// is the illegible failure `host-gone` below is also about — and said WITHOUT
// the error flag, because this is not (yet) bad news.
net.on('dropped', () => ui.toast('Lost the shop — reconnecting…'));
net.on('rejoined', () => {
  ui.toast('Back in the shop');
  // The mode is per SOCKET on the server (`p.build.on`), and the rejoin is a
  // new one — so a client that came back still believing it was building would
  // have every build verb refused by a server that had never been told. It
  // looks exactly like the mode having broken: the bar is up, the ghost is
  // green, and nothing you press does anything.
  ui.resendMode();
});
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
let lastInput = { dx: 0, dz: 0, sprint: false, fpv: false };

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

  // The two build modifiers — see `setShift`. Neither is `preventDefault`ed and
  // neither is returned on: they are modifiers, and every other binding in here
  // reads them (Tab cycles the palette backwards with Shift, Ctrl+Z undoes)
  // rather than being replaced by them.
  if (k === 'shift') setShift(true);
  if (k === 'control' || k === 'meta') setRaze(true);
  /**
   * ...and Alt is the third, which is the only one that is not about a press.
   *
   * `preventDefault` because a bare Alt focuses the browser's menu bar on
   * Windows and Linux — which takes the keyboard away from the page, so the
   * *keyup* never arrives and the overlay stays up over a shop nobody can walk
   * in until you click back into the canvas.
   *
   * Not gated on build mode, unlike the other two: "where does the shop keep
   * this" is a shopkeeping question, and the moment you most want it is while
   * you are stocking rather than while you are building.
   */
  if (k === 'alt') { e.preventDefault(); peekOn = true; }

  /**
   * Taking a build press back, and putting it forward again.
   *
   * Read and returned on BEFORE the menu keys below, which is not tidiness:
   * those are matched on the bare letter, so a `z` or a `y` bound to a section
   * would open it under the modifier and Ctrl+Z would undo your wall *and* open
   * the supplier. Any key the rail grows later is safe by construction.
   *
   * Ctrl and Cmd both, because this is one build that runs on a laptop and in a
   * browser on a Mac; Ctrl+Y and Ctrl+Shift+Z both mean redo for the same
   * reason, which is that half the world learned each.
   *
   * Not gated on build mode — see the messages in `server/rooms/shop.js`. The
   * moment you most want this is the one just after you have left it.
   */
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    e.preventDefault();
    net.send(k === 'y' || e.shiftKey ? 'redo' : 'undo');
    return;
  }

  /**
   * ...and the clipboard, on the same two keys everybody already knows.
   *
   * Neither carries the thing being copied: the shop holds it (see
   * `Game.copyFixtures`), because a blueprint is four layers and the inbound
   * cap is 4KB. Copy sends the ids you had picked; paste sends the cell under
   * the pointer.
   *
   * The COPY names a selection and so needs one — the toast is not a nicety,
   * because a Ctrl+C over nothing is otherwise indistinguishable from a Ctrl+C
   * that worked, and you find out one paste later. The PASTE needs build mode
   * and a tile, and it needs the local clipboard too: that is what draws the
   * ghost, and a paste with no preview is a stamp you aim by faith.
   */
  if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'v')) {
    e.preventDefault();
    if (k === 'c') copySelection();
    else pasteAtPointer();
    return;
  }

  /**
   * V holds the emote strip open, and a number picks from it.
   *
   * Read and returned on BEFORE the menu keys and before the palette's number
   * row, which is the same precedence Ctrl+Z is given above and for the same
   * reason: `1`-`4` already mean "the fourth thing on the build bar", and a
   * press that fired an emote AND armed a shelf would be one key doing two
   * jobs. While the strip is up it is the strip's.
   *
   * The strip is HELD rather than toggled, which is what keeps it out of the
   * way of a game with a key on nearly every letter: there is no mode to be
   * stuck in, nothing to remember to close, and letting go is how you say no.
   * It also makes the click path work without a second thought — a key held
   * down does not take the mouse, so the row is pressable for exactly as long
   * as it is on screen.
   *
   * A number that names no row is swallowed rather than falling through. Five
   * emotes' worth of muscle memory against four rows would otherwise arm a
   * build tool from a strip that has no fifth button, which is a press landing
   * somewhere you cannot see.
   */
  if (k === 'v') ui.showEmotes(true);
  /**
   * ...and the number row IS the hotkey, with the strip up or down.
   *
   * One mapping rather than two: `2` is Cheer whether or not you are holding V,
   * so the strip teaches the shortcut instead of being a second way to do the
   * same thing with different keys. It is the badge on each button (`.kb`) that
   * makes that learnable — the row is the only place the numbers are written
   * down.
   *
   * With the bar up the numbers belong to the palette, which is the one
   * precedence question here and is settled the way every other one in this
   * handler is: the visible mode wins. `ui.emotesUp ||` is what lets you emote
   * while building, since holding V is you saying which of the two you meant.
   *
   * A bare number is the ONE case this file's own `paletteArmed` rule would
   * normally forbid — a press with no bar on screen to say what it does. It is
   * allowed here for the reason that rule exists: the trap is an invisible
   * press that silently changes something (the seed row, which replanted every
   * bed and said nothing), and an emote is the most visible thing in the game.
   * The press IS the feedback.
   *
   * A number that names no row is swallowed rather than falling through, or
   * five emotes' worth of muscle memory against four buttons arms a build tool
   * from a strip that has no fifth one.
   */
  if ((ui.emotesUp || !ui.bar) && k >= '1' && k <= '9') {
    e.preventDefault();
    ui.pickEmote(Number(k));
    return;
  }

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

  /**
   * The two view keys that are not about where the camera is pointing.
   *
   * `F` is the same step the last notch of the wheel takes — a key as well as a
   * gesture because the wheel one is only findable by somebody who kept
   * scrolling after the view stopped getting closer, which is nobody. It goes
   * through the scene's own toggle rather than setting the flag, so entering
   * from a key and entering from the wheel are one path.
   *
   * `C` is the way out of cinema, and is the reason the mode can exist at all:
   * it hides the panel its own switch lives on, so without a key the only way
   * back would be a reload. Bare, and safe to be bare — Ctrl+C is the clipboard
   * and is handled above with a `return`, so this is never reached holding it.
   */
  if (k === 'f') {
    const on = scene.setFirstPerson(!scene.fpv);
    ui.toast(on
      ? 'First person. Move the mouse to look, Escape frees it, F steps back.'
      : 'Back to the shop view.');
  }
  if (k === 'c') setCinema(!cinemaOn());

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
  // Q arms whatever the pointer is on. Gated on `buildOn` rather than on the
  // palette, unlike Ctrl: a mode a fixture menu borrowed is still a mode you
  // meant to be in, and copying a design out of it is exactly the press that
  // makes you want the bar — which this puts up for you (`commitBuildMode`).
  if (k === 'q') pipette();
  /**
   * ...and E goes up a storey, which is only ever about a conveyor.
   *
   * `paletteArmed` rather than `buildOn`, exactly as Ctrl is: a mode a fixture
   * menu borrowed puts nothing on screen saying you are in it, and a deck you
   * cannot see you are on is worse than a bulldozer you cannot see — every
   * press would land four metres above where you are looking.
   *
   * It is no longer the ONLY way up, and that is the point of `setDeck`: the
   * storey is a pair of chips in the bar's nav row now, and both ends go through
   * one call so the key and the buttons cannot come to mean different things.
   * The key stays gated on the mode rather than on a conveyor being armed —
   * `setDeck` answers a shelf with a sentence, which is what a key that would
   * otherwise silently do nothing owes you.
   */
  if (k === 'e' && ui.paletteArmed) {
    ui.setDeck(!ui.buildDeck);
    refreshGhost();
  }
  // ...and M picks the selected one up, which is the Move button's key. Its own
  // binding rather than a rung on R's, because it has nothing to fall through
  // to: with nothing selected there is nothing to move, and a key that quietly
  // lifts whatever the pointer happens to be over is the proximity bug again.
  if (k === 'm') {
    const f = ui.selectedFixture();
    // ...and a selection of several is the aimed move rather than a carry, which
    // is the Move BUTTON's own split said on the key — a shortcut that refused
    // where the button it duplicates works is two rules to learn.
    if (f && ui.manyPicked) ui.withBuildMode(() => ui.shiftSelection());
    else if (f) liftAimed(f, { reopen: false });
  }
  // ...and Delete tears the selection out, which is the Remove button's key and
  // the editor key everybody already has their hand on. Its own binding like M
  // and for the same reason — nothing selected is nothing to delete, and
  // pointing at a thing and razing it is what Ctrl already does.
  //
  // Backspace as well: on a laptop keyboard it is the key labelled delete.
  if (k === 'delete' || k === 'backspace') ui.removeSelected();
  // Escape backs out one layer at a time. UI owns the whole ladder — an open
  // menu, then whatever you're carrying, then build mode — because two
  // listeners racing over one key means Escape closes a panel and quits build
  // mode in the same press.
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  const up = e.key.toLowerCase();
  if (up === 'shift') setShift(false);
  if (up === 'control' || up === 'meta') setRaze(false);
  if (up === 'alt') { peekOn = false; ui.setPeek(null); }
  if (up === 'v') ui.showEmotes(false);
});

// ...and a key held while the window loses focus never comes up. `keys` has
// always had this hazard and lives with it — a stuck direction is fixed by
// tapping the key — but a stuck *preview* is a shop wearing seventeen frames
// with no key down to explain them, which reads as the marker being broken.
// A stuck demolish aim is the same picture with a red frame on it, which is
// worse: it says the next click tears something out.
// ...and Alt with them, which is the one that most needs it: Alt+Tab is how
// people leave a window, and it is also how the overlay gets stuck on.
// ...and the emote strip, which is the same hazard with a row of buttons on it:
// it is held open by a key, so a window that takes the keyboard away mid-press
// leaves it up over a shop nobody is emoting in.
addEventListener('blur', () => {
  setShift(false); setRaze(false); peekOn = false; ui.setPeek(null); ui.showEmotes(false);
});

/**
 * TWO MODIFIERS, ONE MEANING EACH.
 *
 * **Shift is the multi-select**, with the bar up or down: hold it and
 * everything of the same design lights up, shift-click adds to the selection or
 * drops it. **Ctrl (Cmd on a Mac) is the bulldozer**, whatever tool is armed:
 * hold it and the thing under the pointer goes red, click and it is gone
 * (`razeAim`).
 *
 * For a while Shift was BOTH, told apart by whether the palette was up, and it
 * is worth writing down why that came apart rather than being tuned. It made
 * the answer to "what does this key do" a fact about a strip of UI at the
 * bottom of the screen rather than about the key — so the one place you most
 * want to pick several shelves (the mode where you are rearranging the shop)
 * was the one place the key that picks them meant *delete*, and the tell was
 * that both gestures are made by holding the modifier and clicking repeatedly.
 * Two keys is also what every other editor does, which is worth more here than
 * saving a key: nobody has to be taught either one.
 *
 * Both are held as flags rather than read off each event, because the *hover*
 * needs them: the red frame and the design highlight have to appear when the key
 * goes down under a pointer that is not moving, and go away when it comes up.
 * Every way either key can change is a caller — the two key handlers, the blur
 * that catches one held through a tab switch, and `pointermove`, which is the
 * one that repairs a modifier pressed or released while this window was not the
 * one listening.
 *
 * Ctrl+click on a Mac is the SECONDARY click, so it arrives as `button === 2`
 * and never reaches the bulldozer branch. That is why Cmd is read as well —
 * it is the Mac idiom anyway, and the key that works there is the one people
 * already hold.
 */
/**
 * HOLD ALT AND EVERY UNIT SAYS WHAT IT IS FOR.
 *
 * `homeShelves` gives every item one home, and the whole point of that rule is
 * that you can learn where things live — and there is nowhere in the game that
 * shows you the answer except by walking the aisles and reading the goods, which
 * stops working the moment a unit is behind another one, is a chest freezer with
 * a lid, or is empty. The nearest thing is the Stock panel, which is a list, and
 * a list is exactly the wrong shape for *where*.
 *
 * Read-only, and that is what makes it cheap: nothing here is a verb, and every
 * field it draws has been on the wire since before it existed.
 *
 * A **hold** rather than a toggle, for the reason the design highlight is one: a
 * mode that stays on is a mode you forget you are in, and this one draws over
 * the shop. Not gated on build mode either, unlike Shift and Ctrl — "where does
 * the shop keep this" is a shopkeeping question, and the moment you most want it
 * is while you are stocking rather than while you are building.
 *
 * The cards themselves are `ui.setPeek`; this is the half that knows where the
 * shop is.
 *
 * ONE CARD PER UNIT, its boards laid across it as art and a count. It emitted a
 * full-size card per BOARD for a while, spread sideways so three of them
 * cleared each other — which is right about one shelf and unreadable about a
 * shop: a unit holding three things was three cards several times wider than
 * the unit itself, so on a three-tile aisle pitch every card overlapped its
 * neighbours' and a furnished building was a hundred cards in a heap. What you
 * could no longer do is the one thing the key is for, which is read the shop.
 * What is left of the spread is `declutterPeek`, which moves the cards that
 * still collide instead of spreading the ones that would not have.
 *
 * How many rows a unit can show is the SHELF's own number and never a constant
 * here: `boards` rides the snapshot (it comes off the model at this fixture's
 * tier, so the client would need the whole ladder to work it out) and that is
 * the same figure `boardsOf` answers for the sim. Three is what the widest unit
 * in the game happens to draw today, and writing that down here is a second
 * copy of it that a tier with a fourth board would silently make wrong.
 */
let peekOn = false;

function peekCards() {
  const st = ui.state;
  if (!st) return [];
  const out = [];
  /**
   * `id` and not the snapshot record, because the snapshot does not carry
   * WHERE. A shelf on the wire is stock and settings; the position lives on the
   * renderer's own fixture list, which is also the only thing that knows how
   * tall the art came out. `syncWants` resolves it the same way and for the same
   * reason — and it is what makes a unit that has just been carried across the
   * shop draw its card in the right place on the very next frame.
   */
  const push = (id, rows) => {
    const list = rows.filter((r) => r.itemId);
    if (!list.length) return;
    const f = scene.fixtureById(id);
    if (!f) return;
    const p = scene.worldToScreen(f.x, f.z, scene.fixtureHeight(f) + 0.3);
    // Off the back of the camera comes back null, and a card at NaN is a card
    // stuck in the corner of the screen naming a shelf you cannot see.
    if (!p) return;
    out.push({ key: id, rows: list, x: p.x, y: p.y });
  };

  for (const s of st.shelves ?? []) {
    const rows = [];
    // A board that is reserved and EMPTY first, which is `syncWants`' order and
    // is here for the same reason: you asked for that board, so it is the
    // strongest form of the sentence even with nothing on it — and it is the
    // single hardest thing in the shop to find out about any other way.
    for (const w of s.waiting ?? []) rows.push({ itemId: w.item_id, want: true });
    for (const k of s.stacks ?? []) {
      if (rows.some((r) => r.itemId === k.item_id)) continue;
      rows.push({ itemId: k.item_id, qty: k.qty ?? 0, cap: k.cap ?? 0 });
    }
    // Bounded by what the unit actually draws rather than by a number typed in
    // here — see the header. `waiting` and `stacks` cannot between them outrun
    // the boards today, so this is a guard rather than a truncation, and the
    // fallback is the list itself: a wire with no `boards` on it must show what
    // it has rather than nothing.
    push(s.id, rows.slice(0, Math.max(1, s.boards ?? rows.length)));
  }
  // A bed says what is growing in it, which is the one unit whose contents you
  // genuinely cannot read across a shop — a seedling is a seedling. One row,
  // because a bed grows one crop; the grouped card costs it nothing.
  for (const p of st.plots ?? []) {
    if (p.crop_id) push(p.id, [{ itemId: cropYield(p.crop_id), want: true }]);
  }
  // ...and a machine says what it is MAKING, which is `station-recipe` made
  // visible. Through `scene.stationLines`, where the twin-headed machine's slots
  // and the single-headed one's `recipe` are already made into one list — asking
  // the snapshot directly here would be the second reader that drifts. One row
  // for an ordinary machine; a twin head is the one appliance that has two
  // things to say, and the grouped card is exactly the shape that lets it.
  for (const st2 of st.stations ?? []) {
    push(st2.id, scene.stationLines(st2)
      .map((line) => line.recipe?.output_item)
      .filter(Boolean)
      .map((itemId) => ({ itemId, want: true })));
  }
  return out;
}

/**
 * What a bed of this crop turns into, so the card names goods rather than seed.
 *
 * `item_id` is the crop row's own field and there is no fallback to the crop id:
 * a bed whose crop row has been deleted out from under it draws no card, which
 * is `binOrphans`' problem rather than this one's — and a card naming a row that
 * does not exist would render as an empty plate with a slug on it.
 */
function cropYield(cropId) {
  return (ui.catalog?.crops ?? []).find((c) => c.id === cropId)?.item_id ?? null;
}

let shiftDown = false;
function setShift(on) {
  if (shiftDown === !!on) return;
  shiftDown = !!on;
  ui.setKinPreview(shiftDown);
  refreshGhost(true);
}

let razeDown = false;
function setRaze(on) {
  if (razeDown === !!on) return;
  razeDown = !!on;
  refreshGhost(true);
}

// Where the pointer is, so the build ghost knows what it is being aimed at.
// `onCanvas` matters as much as the coordinates: the HUD floats over the world
// and swallows the clicks it covers, so a ghost or a target ring under an open
// panel would be promising something that cannot happen.
const pointer = { x: innerWidth / 2, y: innerHeight / 2, onCanvas: true };

/**
 * WHO THE POINTER HAS SETTLED ON — which is not the same as who is under it.
 *
 * A hire outranks the fixture behind them, and the argument for that is that
 * pointing at one is deliberate: they are a third of a tile wide and they move,
 * so you do not land on one by accident. That is true of the pointer moving
 * onto a person. It is exactly false of a person WALKING UNDER a pointer that
 * has not moved — and the shop is full of them, criss-crossing in front of the
 * shelving you are working on. What it costs is the second press: you open a
 * shelf, reach back to press it again, and a stocker has arrived in the
 * meantime, so the press opens the stocker. Nothing on your side of the screen
 * moved, and the thing you were aiming at changed.
 *
 * So a person wins the aim only while they are the one the pointer *arrived*
 * on. Recorded on `pointermove` — the one event that is you rather than the
 * world — and read by everything that asks "am I pointing at somebody"
 * (`aimPerson`). Somebody who walks under a still pointer is not pointed at;
 * somebody you slide onto is, from that move onward; and a person you were
 * already on who steps away takes the aim with them rather than handing it to
 * whoever replaces them.
 */
let settledWho = null;

addEventListener('pointermove', (e) => {
  // A press whose release we never saw, ended by the first move after it — the
  // window's half, which is the one that fires while the pointer is over a
  // panel and the canvas is hearing nothing. See `healLostPress`. It does not
  // return: where the pointer is and what it has settled on are true whether or
  // not a gesture just ended.
  healLostPress(e);
  // WITH THE MOUSE LOCKED, `clientX` IS A GHOST. It is frozen at wherever the
  // cursor stood when the lock was taken and it keeps arriving on every move,
  // so this would quietly drag the aim back off the crosshair on the very next
  // event — `centreAim` sets it once and this would undo it forty times a
  // second. Everything that positions itself at the pointer (the board tip, the
  // peek card) reads these two, and `pointerRay` answers the same way for the
  // same reason. See `grabLook`.
  if (scene.crosshair) { centreAim(); } else {
    pointer.x = e.clientX;
    // The lift lives HERE and nowhere else, because this is the one place the
    // pointer is worked out — a second offset applied by the canvas handler would
    // be overwritten by this one a moment later (it fires on the way up to the
    // window), and the ghost would flicker between two tiles as you slid.
    pointer.y = e.clientY - (drag.aiming ? TOUCH_AIM_LIFT : 0);
    pointer.onCanvas = e.target === canvas;
  }
  // The key handlers own this, and this is the repair: a Shift pressed or let
  // go while another window had the keyboard never reaches them, so the first
  // move of the mouse is where the flag catches up. `setShift` no-ops when it
  // already agrees, so the ordinary move costs a compare.
  setShift(e.shiftKey);
  setRaze(e.ctrlKey || e.metaKey);
  // Who you have moved onto, at the moment you moved. See `settledWho`. Asked
  // here rather than in the frame loop on purpose: the loop runs with the
  // pointer standing still, which is the case this exists to answer.
  settledWho = pointer.onCanvas ? scene.pickPerson(pointer.x, pointer.y)?.hire ?? null : null;
  refreshGhost();
});

/**
 * The person a press or a hover at this point is genuinely aimed at.
 *
 * One function for the marker, the tap and the hold, for the reason
 * `boardTakes` is one: a ring is a promise about a press, and a hire ringed by
 * a rule the press does not share is the green-ghost bug wearing a person.
 *
 * A finger is exempt and has to be: there is no hover on a touchscreen, so the
 * press IS the arrival — there is no "before" to have settled in. `pillDrives`
 * covers the hover side (it never rings anybody there) and `drag.touch` the
 * press side, which is set on the way down by the press being answered.
 */
function aimPerson(cx, cy) {
  const who = scene.pickPerson(cx, cy);
  if (!who?.hire) return null;
  if (drag.touch || pillDrives()) return who;
  return who.hire === settledWho ? who : null;
}

/**
 * The thief a press here would fire the tazer at, or null.
 *
 * Narrowed at the PICK rather than after it, which is what keeps the wrong
 * person from being ringed in a crowd: the end of a chase is the busiest two
 * tiles in the shop — your staff, whoever was in the way, and the one you are
 * actually after — and only the last of those should be findable.
 *
 * `settledWho` is deliberately NOT consulted, unlike `aimPerson`. That rule
 * exists because a hire walking under a still pointer must not steal a press
 * meant for the shelf behind them, and it is exactly wrong here: the thing you
 * are aiming at is *running*, so "the pointer arrived on them" is a state that
 * lasts a frame. Insisting on it would make the tazer miss whenever it was
 * working, which is the one gesture in the game where the world moving under
 * the pointer is the point rather than the hazard.
 *
 * One function for the marker and the press, for `boardTakes`' reason: a ring
 * drawn by a rule the press does not share is the green-ghost bug wearing a
 * person.
 */
function aimThief(cx, cy) {
  if (!pointer.onCanvas) return null;
  return scene.pickShopper(cx, cy, { only: (c) => c.stole && (c.basket?.length ?? 0) > 0 });
}

// ---------------------------------------------------------------------------
// Build ghost
//
// Validity is decided by shared/build.js — the same code the server runs on the
// click — so the preview can never promise something the server then refuses.
// ---------------------------------------------------------------------------

let ghostKey = null;

/** Was the last frame a Shift aim? See `refreshGhost` for what it tidies up. */
let razeShown = false;

/**
 * What Shift is about to get rid of, in words.
 *
 * One sentence per kind, and every one of them names the press as well as the
 * target — the modifier is already down by the time this is on screen, so the
 * thing left to say is that a click finishes it. The bulldozer's own line
 * (`buildHintText`) is the same sentence about the same act, which is
 * deliberate: they are one gesture reached two ways.
 */
function razeSay(aim) {
  if (aim.kind === 'fixture') return `Tear out the ${ui.fixtureName(aim.f).toLowerCase()} — click it`;
  if (aim.kind === 'face') return 'Strip the paint off this wall — click it';
  if (aim.kind === 'edge') return 'Knock this wall through — click it';
  return 'Take this ground up — click it';
}

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
 * - `drag.moving`, a fixture dragged out of the shop by its own press, and
 *   `drag.carried`, one lifted by a hold with the button still down. The camera
 *   never gets either drag (see the `pointermove` handler), so there is nothing
 *   sliding and the preview has to track.
 */
const camBusy = () => !!pinch
  || !!spin?.turned
  || (drag.id !== null && drag.travel >= TAP_SLOP
    && !drag.aiming && !drag.moving && !drag.carried);

function refreshGhost(force = false) {
  // A wall tool previews the line under the pointer, not a tile. While a drag
  // is live the drag owns the ghost — it knows the whole run, this only ever
  // knows the one segment you are hovering. Same for a brush and its area.
  //
  // `beltDrag` was missing from this list for the whole life of the conveyor
  // drag, and it is the predicate-against-the-members-that-existed trap again:
  // the guard was written when there were three drags and the fourth arrived in
  // another file. What it looks like is a drag with NO PREVIEW AT ALL, which
  // reads as the preview never having been built — and it was, and it worked.
  // `showBeltDrag` set the floor ghost on every pointer move and this function
  // cleared it on the very next frame, twenty times a second, because a belt is
  // a fixture rather than a brush so it falls past the ground-brush branch to
  // the blanket `setFloorGhost(null, null)` below.
  if (edgeDrag || floorDrag || faceDrag || beltDrag) return;

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

  // THE PILE YOU PRESSED, before anything below decides what you are POINTING
  // at — and above every guard in this function, because it is the one marker
  // here that is not a question about the pointer.
  //
  // Everything past this line is a hover: it is suspended in build mode, put
  // away for a person, dropped where the pill drives, frozen while a ring winds.
  // None of those is a reason to stop showing which pile you are working out of
  // — you picked it, it is what the pill's rows are about, and it is what a
  // press on that unit takes from. Gated only on the pick still existing, which
  // `liveBoard` re-answers every frame off the shop rather than off a record.
  //
  // ...and it goes UP where the aim frame comes down on a touchscreen, which is
  // the same argument the aim frame makes about itself: the selection is what
  // the tap actually did, it survives the walk, and a finger has nothing else
  // that says so.
  const picked = pick.id ? liveBoard(pick) : null;
  // The pile sold out, or the unit went with a re-flow. Drop the decision as
  // well as the marker — `heldBoard` does the same, and a pick nothing can draw
  // is a subject the pill would go on offering verbs about.
  if (pick.id && !picked) pick = { id: null, board: null };
  // ...and a pile that is not what you are carrying STANDS DOWN rather than being
  // dropped — see `boardInHands`. The line above is for a pick that has ceased to
  // exist, which is a decision that cannot be honoured; this is a decision that
  // has nothing to say for as long as your hands are full of something else, and
  // it comes back the moment they are empty. Binning it here instead would mean
  // picking up an armful quietly forgot the board you were working out of, which
  // is a second thing the press did that nothing on screen mentioned.
  const showPick = picked && boardInHands(picked.board) ? picked : null;
  scene.setPickedBoard(showPick?.f ?? null, showPick?.board ?? null);

  // IS THE POINTER AN AIM, OR A FACT ABOUT A PRESS THAT IS OVER?
  //
  // Every preview below raycasts `pointer` and is re-run on every snapshot, which
  // is right for a mouse: the coordinate means "where I am looking", it is live,
  // and re-answering it as the shop changes is the whole point. On a phone the
  // same coordinate is where a finger last LANDED, so between presses these are
  // ten guesses a second about a question nobody is asking — a bulldozer ring
  // lit on whatever has since walked under an old tap, a wall preview parked in
  // the middle of the shop, a floor brush glowing on a cell you left.
  //
  // A finger IS a live aim while it is DOWN, and that is the one case that has to
  // keep working: the build ghost follows a held press (`drag.aiming` lifts it
  // off your thumb), so freezing during a drag would stop the thing you are
  // placing from following the hand placing it.
  const aiming = pointer.onCanvas && (!pillDrives() || drag.id !== null);

  // SHIFT OUTRANKS THE TOOL, because it is about what is already there.
  //
  // The whole promise of the modifier is that it means one thing whatever is
  // armed, so it has to be read before every branch below rather than inside
  // any of them — a wall tool's own preview drawn over a Shift the player is
  // holding would be the green-ghost bug pointed at a demolition.
  //
  // `razeShown` is the tidy-up half: each branch below clears the ghosts of the
  // ones ABOVE it and returns, so a face ghost this branch left behind would
  // outlive it under a wall tool, which clears only the edge. Letting go of
  // Shift puts all three away in one place instead.

  // Re-answered here rather than only at the keypress, because what the design
  // highlight is ABOUT can change with the key already held — a selection made,
  // a fixture torn out from under it. `setKinPreview` no-ops when it already
  // agrees.
  ui.setKinPreview(shiftDown);
  // Which storey the pointer works on, mirrored every frame rather than pushed
  // on the E press: the deck is also reset by leaving build mode, which happens
  // through half a dozen doors in `ui`, and a pick rule that was one press
  // stale would aim at the ceiling in a shop you had already come down from.
  // A stamp has no armed palette row — `copySelection` deliberately disarms it
  // so its footprint is the one promise under the pointer — but its target is
  // still on the storey its source came from. Without this a copied overhead
  // duct asks `pickTile` for the floor plane: from an angled camera that is a
  // different x,z, so a one-cell straight is stamped beside its intended
  // neighbour and reads as a corner the player never drew. A mixed stamp stays
  // grounded; it is the only unambiguous anchor it has until stamps can rotate.
  const stampDeck = clipboard?.length && clipboard.every((f) => f.deck === CEILING)
    ? CEILING : 0;
  scene.pickDeck = ui.paletteArmed ? ui.buildDeck : stampDeck;
  const raze = aiming ? razeAim(pointer.x, pointer.y) : null;
  ui.setRazeAim(raze ? razeSay(raze) : null);
  if (raze) {
    razeShown = true;
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    scene.setEdgeGhost(raze.kind === 'edge' ? [raze.seg] : null, 'no');
    scene.setFaceGhost(raze.kind === 'face' ? [raze.face] : null, 'no');
    scene.setFloorGhost(raze.kind === 'ground' ? [raze.cell] : null, 'no');
    scene.setAimTarget(raze.kind === 'fixture' ? raze.f : null, 'raze');
    scene.setPersonAim(null);
    canvas.style.cursor = '';
    ui.setAim(raze.kind === 'fixture' ? raze.f : null);
    ui.setBoardTip(null, null);
    ui.setPressHints([]);
    ui.setBuildVerdict(null);
    return;
  }
  if (razeShown) {
    razeShown = false;
    scene.setEdgeGhost(null, null);
    scene.setFaceGhost(null, null);
    scene.setFloorGhost(null, null);
    scene.setAimTarget(null);
    ui.setAim(null);
  }

  // The bulldozer aims at a thing first and a line second. A shelf standing
  // against a wall covers the line behind it on screen, and "the wall" is never
  // what you meant while a whole fixture is under the pointer.
  const razing = aiming && ui.demolishArmed()
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

  const edgeKind = aiming ? ui.edgeKindForTool() : null;
  if (edgeKind !== null) {
    const seg = scene.pickEdge(pointer.x, pointer.y);
    if (!seg) { scene.setEdgeGhost(null, null); ui.setBuildVerdict(null); return; }
    // A TOOL IN YOUR HAND BUILDS, WHATEVER IS ALREADY THERE.
    //
    // The Doorway tool over a doorway used to go amber and open that door's menu
    // instead of building, which is right about one press and wrong about the
    // gesture. What it could not see is the second design: a family is the set
    // of things that swap for a refit, so the moment there were four glazings
    // the rule read "you are holding a window and pointing at a window,
    // therefore you want to talk about the one that is there" — and a bay window
    // aimed at a plain one is the clearest possible statement that you do not.
    // There was no way whatever to change one window for another, because the
    // tool that does it was exactly what disqualified the press.
    //
    // So an edge with a tool up is an ordinary build target and gets the
    // ordinary verdict. Pointing at what is already there is the same no-op the
    // Wall tool over a wall has always been — plain wall is in no family, so
    // that press has never done anything either and nobody has ever wanted it
    // to. Editing what stands there is the press with NO tool up: `pickWay` in
    // `openAtPointer`, one tap, the menu — which is where "and who is it for"
    // and "and where is the glass" have always lived.
    const verdict = canPlaceEdges(scene.storeLayout, [seg], edgeKind);
    scene.setEdgeGhost([seg], verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no', edgeKind);
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
  const finish = aiming ? ui.faceForTool() : undefined;
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
  const brush = aiming ? ui.groundForTool() : undefined;
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

  /**
   * A COPIED STAMP IS SOMETHING IN YOUR HANDS, and it owns the ghost.
   *
   * Ctrl+C disarms the palette (`copySelection`) and what you are holding from
   * then on is the blueprint — which is the model every factory game uses, and
   * it is the one that makes the preview honest: there is no second ghost to
   * fight with, the footprint is under the pointer where you are about to press,
   * and a left click stamps it. Escape puts it down.
   *
   * Above `ghostKindForTool` rather than beside it, because the two are
   * mutually exclusive by construction — arming a tool clears the clipboard —
   * and a branch that tested both would be describing a state that cannot
   * happen.
   */
  if (aiming && clipboard) {
    if (ghostKey !== null) { ghostKey = null; scene.setBuildGhost(null); }
    const tile = scene.pickTile(pointer.x, pointer.y);
    const cells = pasteCells(tile);
    // The squares cover the ground the stamp carries as well as its units, or a
    // copied room previews as the four shelves in it and nothing else.
    const squares = stampFootprint(tile, cells);
    const fits = squares.filter((c) => c.state === 'ok').length;
    // Keyed on the anchor and nothing else: the clipboard cannot change while
    // one is held (copying again replaces it, which re-keys through `stampSeq`)
    // and every cell of it is derived from that one tile.
    scene.setFloorGhost(squares.length ? squares : null,
      fits === squares.length ? 'ok' : (fits ? 'warn' : 'no'));
    scene.setRunGhost(cells.length ? `stamp${stampSeq}:${tile.x},${tile.z}` : null, cells);
    ui.setBuildVerdict(squares.length
      ? { ok: !!fits, warn: fits < squares.length ? `${squares.length - fits} would not fit` : null,
        reason: 'none of that would go there' }
      : null);
    scene.setAimTarget(null);
    scene.setPersonAim(null);
    ui.setAim(null);
    ui.setBoardTip(null, null);
    ui.setPressHints([]);
    return;
  }

  const kind = aiming ? ui.ghostKindForTool() : null;
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
    // ...and not with your hands full, which is the same rule the tap below
    // keeps — see `handsFull`. A hire who walks through the pointer must not
    // take the ring off the shelf you are carrying six loaves towards.
    // ...and not with the bar up, which is that same sentence about the other
    // mode and the one where it costs most. The bulldozer has said it since it
    // was written — "then you are aiming at things, and a clerk wandering in
    // front of a shelf must not stop you tearing the shelf out" — and every word
    // of that is true of build mode at large: a hire is a third of a tile wide,
    // walking, through a shop you are selecting and dragging units in, and they
    // have no build verb of their own. So they took the ring off whatever you
    // were about to move, and the marker was a promise about a menu the mode has
    // nothing to do with. `paletteArmed` and not `buildOn`, the same test
    // `boardTakes`, `dropping`, `aimable` and `drag.lift` all make: a fixture
    // menu that borrowed the mode is not somebody building.
    // ...and not somebody who merely WALKED HERE. `aimPerson` rather than
    // `pickPerson`: the ring is a promise about a press, the press asks the same
    // function, and a hire who arrives under a pointer that has not moved was
    // never pointed at. See `settledWho`.
    const person = pointer.onCanvas && !ui.demolishArmed() && !ui.paletteArmed
      && !pillDrives() && !handsFull()
      ? aimPerson(pointer.x, pointer.y) : null;
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
    // WHAT THE PILL IS ABOUT IS WHAT YOU LAST TAPPED, and on a phone that is the
    // only thing it is ever about.
    //
    // Everything below this line was written for a pointer: a live coordinate
    // that means "the thing I am looking at right now", re-answered as the hand
    // moves. A touchscreen has no such coordinate. `pointer` there is the last
    // place a finger LANDED — a fact about a press that is already over — and
    // re-raycasting it ten times a second is the shop guessing, every tick,
    // about a question nobody is asking. Everything that has looked broken here
    // is that guess arriving at a different answer than the tap did: rows
    // flickering, buttons swapping, a black chip turning yellow, a marker
    // appearing on whatever has since walked under the spot.
    //
    // So on a phone the tap NAMES a thing (`noteTap`) and the pill is about that
    // thing until you tap another one. No clocks, no dwell, no second opinion.
    const aim = pillDrives()
      ? tappedAim()
      : (pointer.onCanvas && !ui.holding
        ? scene.pickAim(pointer.x, pointer.y, aimable, crateTakes()) : null);
    // One pile of goods, when that is what is under the pointer — a cage round
    // the bread rather than a frame under the shelf. It is the promise half of
    // board aiming: the tap on it takes THAT board, so it has to be visible
    // which board the pointer has, and on a stocked unit the piles are only a
    // few pixels apart. The frame comes back the moment you point at the unit's
    // own frame, which is still the whole unit and still opens its menu.
    // ...and it rests on the pile you PRESSED while the pointer is on nothing,
    // which is a decision rather than a clock — see `heldBoard`.
    // ...and which PILE, which on a phone is simply the one the tap landed on.
    // `heldBoard` weighs a pointer against a press, and neither is a thing a
    // finger has between taps.
    const held = boardTakes() && !pillDrives() ? heldBoard(aim) : null;
    const board = pillDrives()
      ? (boardTakes() ? aim?.board ?? null : null)
      : (held?.board ?? null);
    // The box under the pointer, when a full shoulder has turned it into the
    // square it stands on — see `haulSquare`. Worked out up here because two
    // markers read it: the ring round the crate has to stand down (it would be
    // advertising a press that names a cell, which is the green-ghost bug said
    // with a highlight), and the green square below has to be lit on the crate's
    // own cell rather than on whatever `pickTile` finds behind it.
    const onPile = aim?.crate ? haulSquare(aim.crate) : null;
    // `held.f` is the unit the settled pile stands on, which is the same unit
    // `aim.fixture` names — kept as the last rung because the cage has to be
    // measured against something, and it is the pile that decides there IS one.
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
    //
    // ...and it is the MARKER that is suppressed, never `board` itself, which is
    // the distinction that made this worth saying twice. The cage is a hover and
    // the row under the pill is what the tap named, so they are two different
    // questions about one variable: `pressHints` still gets the board, and only
    // the thing drawn in the shop is dropped. Turning the marker back on here
    // reads on a phone as a shelf lighting up on its own — nothing takes it
    // down, because the only thing that ever took it down was a pointer moving
    // off, so the last board you tapped keeps its cage through the walk away,
    // the crate you picked up and everything you did afterwards.
    //
    // ...and that is exactly the marker `setPickedBoard` IS, which is why it is
    // drawn on a phone and this one is not: a pick is taken down by a press, so
    // it has a way out a finger can reach, and it is about the tap rather than
    // about a pointer that has not existed since.
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
    // ...and it does NOT linger with the cage, which is the one place those two
    // markers part company. The card is drawn at the POINTER rather than on the
    // shelf, so a board that outlives the ray is a panel naming a unit across
    // the shop, sliding over bare floor with nothing anywhere to connect it to
    // what it is about — the cage at least sits on the thing it names. So the
    // cage may rest on `pick` and the card may not: `aim.fixture` only, which is
    // "you are pointing at this unit, here is the pile of it you are on".
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
    // ...and suppressed while the clock is stopped, which is the one exception to
    // the paragraph above. The argument for showing it with your hands full is
    // that you are about to do something with what it names; with the world held
    // there is nothing to be about to do, and the card is the louder half of the
    // pair — the cage is a thin box round the bread and this is a panel with the
    // item, the count and the capacity in it, sitting over a shop that cannot
    // move. `boardTakes` carries the same clause for the cage.
    // ...and build mode is the third, which is `boardTakes` again and was the
    // half this line was deliberately NOT gated on. Not being gated is right for
    // full hands — you are about to do something with what it names — and it is
    // exactly wrong for the bar being up, because there the pile is not a target
    // at all: the cage has been off in build mode for as long as `boardTakes`
    // has existed, so what was left was a panel naming a stack of bread with
    // nothing anywhere marking it and no press that could act on it. Sliding
    // along an aisle deciding where a shelf goes threw a card over the shop for
    // every unit you crossed.
    const tipOn = pillDrives() || ui.paused || ui.paletteArmed
      ? null : (aim?.fixture ?? null);
    ui.setBoardTip(shelfById(tipOn?.id), aim?.board ?? null, pointer.x, pointer.y);
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
    // ...and what blocks it is a thing the ray met FIRST rather than a thing it
    // met at all — see `wallInFront`. A crate is unconditional (a box is drawn
    // over the line it stands on and the door behind it is not what you aimed
    // at); a fixture only wins where its own art is in front of the wall.
    const way = pointer.onCanvas && !pillDrives()
      ? pickWay(pointer.x, pointer.y, !!aim?.crate || blockedByFixture(aim, pointer.x, pointer.y))
      : null;
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
      // ...and where the pill drives it needs a tap that MEANT the floor.
      // `myTile` is the answer to "which square", not to "is a square what you
      // are asking about" — hung on the absence of an aim it lit up whenever
      // nothing happened to be named, which includes the frame before a tap on a
      // shelf is recorded and the whole of the time before your first tap.
      ? (onPile ?? (pillDrives() ? (tapped.ground ? myTile() : null) : aimed)) : null;
    const show = drop && inReachOf(drop);
    if (dropping()) {
      scene.setFloorGhost(show ? [drop] : null, show ? (canDropAt(drop) ? 'ok' : 'no') : null);
    }
    // ...and what pressing would actually DO, in words, for every button that
    // means something here. Computed off the same four things the markers were
    // just drawn from, so the pill cannot describe a target the highlights
    // disagree about — see `pressHints`.
    // ...and WHICH THING they are about, which rides on the same list: see
    // `about` in `pressHints`, which owns both halves so they can never name two
    // different units.
    const hints = pressHints({ aim, board, onPile, drop: show ? drop : null });
    ui.setPressHints(hints);
    return;
  }
  /**
   * ...and the HUD is not a tile, which is the one way out of here that had no
   * `onCanvas` on it.
   *
   * A ray fired at a point under the palette still hits the floor behind it, so
   * with something armed the ghost went on tracking a shelf you could not see
   * and the hint line went on describing it — which is how a warning ends up
   * parked above the bar for as long as you are USING the bar. And it is the
   * worst of the three lines to leave up: "that cuts 10 fixtures off from the
   * door" is a sentence about a tap, sitting over a row of buttons, describing a
   * press nobody is about to make. The half a second it takes to read it is
   * spent working out which of the two things on screen it is about.
   *
   * Every other branch above already asks (`aiming`, and the two `pointer
   * .onCanvas` reads on the aim), so this is the odd one out rather than a new
   * rule. Deliberately not `aiming` itself: that one also freezes between
   * presses on a touchscreen, which is right for a hover nobody has and wrong
   * for the build ghost, which follows a held press.
   */
  const tile = pointer.onCanvas ? scene.pickTile(pointer.x, pointer.y) : null;
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
  const key = `${kind}:${tile.x}:${tile.z}:${ui.buildRot}:${ui.buildDeck}:${ui.holding?.id ?? ''}`
    + `:${drawn.piece ?? ''}/${drawn.variant}/${drawn.station ?? ''}/${drawn.tier}`;
  if (key === ghostKey && !force) return;
  ghostKey = key;
  const verdict = scene.setBuildGhost({
    kind, x: tile.x, z: tile.z, rot: ui.buildRot, deck: ui.buildDeck, moveId: ui.holding?.id ?? null, ...drawn,
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

/**
 * A browser turns a trackpad pinch into a pixel-mode Ctrl+wheel stream. Those
 * deltas already describe one continuous gesture; treating them as hundred-
 * pixel mouse notches makes the world move barely a tenth as far as the
 * fingers. Exponential scaling keeps equal finger travel an equal zoom ratio.
 */
const PINCH_ZOOM_GAIN = 0.01;

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
  if (e.ctrlKey && e.deltaMode === 0) {
    const factor = Math.exp(-e.deltaY * PINCH_ZOOM_GAIN);
    // A synthetic or accessibility gesture can deliver one unusually large
    // event. Keep that event useful without letting it cross the whole range.
    scene.zoomByFactor(Math.max(0.5, Math.min(2, factor)));
    return;
  }
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
 * ...and how long a press on a crate you are STOOD AT has before it stops being
 * a tap — which is `ACTION_TIMES.crate` and has to be.
 *
 * A lone crate grades by how long you hold it: a tap is one unit, a hold is the
 * whole box. Two different clocks were deciding that, 230ms apart, and the band
 * between them did nothing at all — the client ruled the press a hold at 420ms
 * and stopped sending the tap, while the server's ring does not fire the lift
 * until 650. So an ordinary unhurried click reached for a tin and got silence,
 * with the box still there and nothing on screen to say why.
 *
 * It was hidden for as long as naming a crate meant walking to it: the walk ate
 * the first quarter second of the ring and the press at least *moved* you, so a
 * press that did nothing else still looked like it had been heard. Standing
 * still, it is the whole gesture missing.
 *
 * So the tap lasts exactly as long as the ring takes to fire, and the two
 * outcomes meet with no gap: released before it, one unit; after it, the lift
 * has already happened and the release means nothing. Spelled here rather than
 * imported because `ACTION_TIMES` is the server's, and the note that matters is
 * the one on the other end — if that number moves, this one moves with it.
 */
const CRATE_HOLD_MS = 650;

/**
 * ...and after this long, a drag off a fixture in build mode MOVES it rather
 * than turning the view.
 *
 * The one thing that tells the two apart is where the pause is: a drag that
 * means "look round the shop" starts moving straight away, and one that means
 * "take this" starts with you stopping on the thing. Everything else about them
 * is identical, which is why a mode wall to wall with things you own kept
 * handing you a shelf when you reached for the camera.
 *
 * Half the hold, and it has to stay well under it: a fixture lifted by a HOLD
 * stays in your hands, and if the two figures met there would be one gesture
 * wearing two outcomes decided by a millisecond. It is also why this needs no
 * marker of its own — the press is already drawing a ring (`setHoldProgress`,
 * against `LONG_PRESS_MS`), so the dwell is the first half of a thing you can
 * watch fill.
 */
const MOVE_DWELL_MS = 210;

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
  carried: false,   // ...or a HOLD lifted it, and the button is still down
  took: false,      // this press armed goods — so its hold is a pull, not a look
  rummage: false,   // ...and those goods are a lone crate in reach, whose tap is
                    // one unit. See `CRATE_HOLD_MS`: this press keeps its tap
                    // until the ring fires rather than losing it at 420ms.
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

/**
 * ARE YOUR HANDS FULL? Then a hire is not a target.
 *
 * A person is the smallest thing in the shop you can point at, they are the only
 * thing that MOVES under a stationary pointer, and they outrank everything
 * behind them — which is exactly right when a hire is what you are looking for,
 * and exactly wrong the rest of the time. With an armful or a box on your
 * shoulder, every question you are asking the pointer is about where the goods
 * go: a shelf, a crate, a square of floor. A stocker crossing that line steals
 * the ring, the cursor and the tap, and what you get for the press you had
 * already committed to is their job list — over the shop you were aiming at.
 *
 * Nobody has ever wanted to read a rota with their arms full, and the way in is
 * not lost either: the Staff bar opens the same sheet, and putting the goods
 * down is one press.
 *
 * Deliberately NOT `dropping()`, which is the same fact plus three exclusions
 * about who owns the ground this frame. Those are the right question for a
 * floor ghost and the wrong one here — build mode already suspends people by
 * another route, and a rule about your hands should say so in one clause.
 */
const handsFull = () => !!(myCarry() || myHaul());

function canDropAt(tile) {
  const L = scene.storeLayout;
  if (!L || !tile || !inReachOf(tile)) return false;
  if (!isWalkableTile(L, tile.x, tile.z)) return false;
  const me = ui.me();
  if (!me) return false;
  if (SOLID.has(edgeBetween(L, Math.round(me.x), Math.round(me.z), tile.x, tile.z))) return false;

  // ...and the one square where "already has a crate on it" IS a refusal.
  //
  // A conveyor cell holds exactly one box — that is backpressure, and it is the
  // whole texture of a run — so `beltPut` says no where `dropGoods` would have
  // topped up or stacked. Ruled out here as well, or the ghost is green over a
  // press the server turns down, which is the one thing this function exists to
  // stop. `d.belt` rides in the snapshot as a bare boolean rather than the cell
  // id, so the test is where the box IS: a crate on a belt stands in the middle
  // of its own cell, and a part-way one is between two cells that are both busy.
  if (conveyorAt(L, tile.x, tile.z)) {
    return !(ui.state?.deliveries ?? []).some((d) => d.belt
      && Math.round(d.x) === tile.x && Math.round(d.z) === tile.z);
  }
  return true;
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
    // A TAP IS ONE UNIT AND A HOLD IS THE LOT, and a crate was the one target
    // left in the shop where the second half of that was missing.
    //
    // The left button has both here — a tap rummages, a hold takes an armful or
    // shoulders the box — and the right had only the tap, so an armful went into
    // a box one unit at a time however long you held the button. Nothing said
    // so, because a hold that arms nothing is indistinguishable from a hold you
    // did not do properly: you press, wait, let go, and one carrot moves.
    //
    // `haulSquare` argued the other way and its reasoning was about the SHOULDER
    // — a box up there had no gesture at all, where "an armful puts one in is a
    // gesture that works". True, and it is the tap; what it left out is that the
    // grade is the rule rather than the fallback.
    //
    // It is `place` at the crate's own CELL rather than a new verb, which is
    // CLAUDE.md's standing instruction about goods on the floor: `dropGoods`
    // tops a box up with more of what it holds, spends a free board in it if it
    // has one, and stacks a second box on the cell when it can do neither. All
    // three are the right answer here and none of them is a second container.
    //
    // Sent on the way DOWN, exactly as the shelf's is, because that is what arms
    // the ring — and `tapCrate` clears the errand on its way through, so the tap
    // that beats the ring cancels the pour rather than doing both. That line is
    // already there, and already says it: "a tap has to spend it".
    const cell = { x: Math.round(crate.x), z: Math.round(crate.z) };
    // A refusal leaves the tap alone rather than the whole press: somewhere a
    // crate may not be set down is still somewhere a crate is standing, and one
    // unit into it was never in question.
    if (!canDropAt(cell)) return { kind: 'crate', crate, ring: false };
    net.send('place', { x: cell.x, z: cell.z });
    return { kind: 'crate', crate, ring: true };
  }

  const hit = pickAimed(cx, cy);
  if (hit?.f) {
    // Out of reach is a walk, and the walk names the unit — so arriving leaves
    // the put armed. `ring: false` because there is nothing to wind here yet;
    // what the hold buys is the JOURNEY (see `spin.trek`), and the ring winds on
    // arrival off the errand the walk set, under the button you never let go of.
    //
    // `nearFixture` and NOT `atWorkSpotOf`, which is what it asked for four
    // steps and is the looser of the two: a working spot is a tile off the
    // anchor, so "within REACH of a spot" is up to two and a half tiles from the
    // unit — while every verb this press ends in measures `REACH` to the unit
    // itself. Both halves of that are wrong in the hand. Out at the far end of
    // it the ring wound a full second and the shop then said "too far from that
    // shelf", which reads as intermittent because the only thing that changed
    // was where your feet were; and a tile in, it *worked*, which reads as the
    // shop letting you stock a shelf across a gap you can see.
    //
    // So the tighter circle decides, and everything outside it is the walk this
    // branch already had. That is strictly the better answer to both complaints:
    // the press that used to be refused a second later now takes you there and
    // does it, and the press that used to reach across the gap now takes the one
    // step first. `nearFixture`'s own note says why it is the one to ask — it is
    // the distance `unshelve` measures, and a press has to ask the question the
    // verb will.
    if (!nearFixture(hit.f)) return { kind: 'walk', f: hit.f, ring: false };

    // A conveyor cell is a SQUARE, not a unit, and this is the third time a
    // kind has had to say so — the skip and the appliance each fell through to
    // `board` below and each read as a thing you simply could not put anything
    // into. A belt is worse than either, because the answer is not a different
    // fixture verb: `beltPut` takes a CELL, and the whole gesture the player
    // has already learnt is the green square. Left to fall through, the press
    // sent a shelf message at a belt, the server said no to a thing you were
    // not pointing at, and what you watched was a right-click that did nothing
    // at all.
    if (CONVEYOR_KINDS.includes(hit.f.kind)) {
      const on = { x: hit.f.x, z: hit.f.z };
      // One box per cell, so an occupied one is a real refusal — and refusing
      // here rather than after the send keeps the ghost and the press agreeing.
      if (!canDropAt(on)) return { kind: 'ground', ring: false };
      net.send('place', { x: on.x, z: on.z });
      return { kind: 'ground', ring: true };
    }
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

/**
 * The crate you are pointing at, or null while pointing means something else.
 *
 * The three exclusions are `boardTakes`' exactly, and for the same reason: the
 * palette places, a fixture in your hands is looking for a home, and the
 * bulldozer aims at what is already there. A box is goods, and moving goods is
 * shopkeeping — build mode is the mode where the pointer is about the BUILDING,
 * and the one job it deliberately keeps is the till.
 *
 * The gate lives here rather than at the call sites because there are five of
 * them and they had drifted: the press was already refusing while the palette
 * was up, and the tap and the pill were not — so a tap in build mode selected a
 * crate that the press one gesture earlier had ignored. One answer to "am I
 * pointing at a crate" is the only way those stay in step.
 *
 * `pickWay` is the deliberate exception and asks `Scene.pickPallet` raw, because
 * what it wants is OCCLUSION rather than a target: a wall you cannot see through
 * a stack of boxes is not a wall you were aiming at, whether or not those boxes
 * are something you could pick up right now.
 */
/**
 * Is a box on the floor something the pointer may name at all right now?
 *
 * `boardTakes`' three exclusions, and the one spelling of them: the hover has
 * to ask exactly what the press asks, or a ring lights on a crate that no
 * gesture can act on — which is the green-ghost bug wearing a box. It is its
 * own function because there are two readers in two files' worth of call path:
 * `aimCrate` here, and `Scene.pickAim`, which reaches `pickPallet` directly and
 * cannot see `ui` to ask for itself.
 */
const crateTakes = () => !ui.paletteArmed && !ui.holding && !ui.demolishArmed();

function aimCrate(cx, cy) {
  if (!crateTakes()) return null;
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
  drag.carried = false;
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
// The two are deliberately not the same speed. A quarter turn is 135px because
// yaw is unbounded and you spend it in whole corners, while the whole tilt is
// 46° end to end: at the same rate a flick would cross it twice, so it is four
// times slower and the full sweep is about 280px. Both were 1.5x faster and it
// was too twitchy to hold an angle; the RATIO between them is the part that is
// reasoned about, so slow them together or the tilt stops being the slow one.
// ---------------------------------------------------------------------------
const SPIN_STEP = 135;        // px of drag per quarter turn
const SPIN_RAD_PER_PX = (Math.PI / 2) / SPIN_STEP;
const TILT_STEP = 6;          // px of drag per degree of pitch
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
// Looking around with the mouse taken away — the Pointer Lock
//
// Out in the shop the view is something you GRAB: a drag turns it, and letting
// go is what ends the turn. Inside a head that is the wrong verb. A drag is how
// you move a thing that is over there, and your own head is not over there —
// so first person spent every look with a button held down, which is a button
// held down for the whole of the mode, and the one press you might want to make
// while looking is the press you cannot make.
//
// So the mouse stops being a pointer and becomes the head. Three things follow
// from that and each of them is a way for this to look broken rather than to be
// broken.
//
// THERE IS NO CURSOR, so there is no aim, so the aim is the CENTRE — one line
// in `Scene.pointerRay` and a dot on the glass to say where it is. The dot is
// not decoration: `clientX` goes on arriving, frozen, so without a crosshair the
// shop would be answering presses at a spot nobody can see.
//
// THE LOCK IS NOT OURS TO TAKE. A browser hands it over from inside a gesture
// and takes it back on Escape without asking, and it will refuse outright for
// about a second after one of those. So the mode does not depend on holding it:
// `scene.crosshair` is what everything reads, it follows the lock rather than
// the mode, and first person with the mouse handed back is exactly the game as
// it was — the drag still turns your head (`lookBy` is what both call), and a
// press takes the mouse again. A mode that broke when the lock lapsed would
// break on the one key every player presses to get out of trouble.
//
// AND IT IS A MOUSE'S GESTURE. There is nothing to lock on a touchscreen and
// nothing to hide, so a finger keeps the drag it has always had.
// ---------------------------------------------------------------------------

/** Whether there is a mouse here to take. A finger has nothing to lock. */
const finePointer = () => (globalThis.matchMedia?.('(pointer: fine)').matches ?? true);

/** Whether the mouse is currently the head rather than the pointer. */
const looking = () => document.pointerLockElement === canvas;

/**
 * Put the aim in the middle of the canvas, where the crosshair is drawn.
 *
 * The rect rather than `innerWidth / 2`, for `pointerRay`'s reason: the canvas
 * sits under a HUD and inside a rect that moves when the build bar grows, and a
 * dot drawn at the centre of the *window* over an aim taken at the centre of the
 * *canvas* is a press that lands a few pixels off what it is ringing.
 */
function centreAim() {
  const r = canvas.getBoundingClientRect();
  pointer.x = r.left + r.width / 2;
  pointer.y = r.top + r.height / 2;
  pointer.onCanvas = true;
}

/**
 * Ask for the mouse.
 *
 * Every refusal is swallowed on purpose. The browser turns this down for a
 * second or so after an Escape, when the document has not been engaged, and
 * whenever it feels like it — and none of those is an error the player can act
 * on, because the answer to all three is "press again", which is already the
 * gesture. What must not happen is an unhandled rejection on a key press.
 */
function grabLook() {
  if (!scene.fpv || looking() || !finePointer()) return;
  try {
    canvas.requestPointerLock()?.catch?.(lookRefused);
  } catch (err) { lookRefused(err); }
}

/**
 * How many asks in a row have come back no, and the whole of what it is for.
 *
 * A press in first person is swallowed to ask for the mouse (see the top of
 * `pointerdown`), and that is only safe while the asking eventually works. It
 * does not always: a page in an iframe with no `allow="pointer-lock"`, a
 * browser where the player has turned it off, an engine that has never
 * implemented it. Left alone, first person there would be a mode where every
 * single click is eaten and the shop reads as having frozen — which is worse
 * than the drag it replaced, and there would be nothing on screen saying why.
 *
 * So the second refusal stands the whole thing down: no crosshair was ever set,
 * so what is left is exactly the game as it was — the drag still turns your
 * head, the cursor is still yours, and the mode is still first person. One
 * refusal is forgiven because the commonest one is not a refusal at all: a
 * browser cools off for about a second after the player has pressed Escape, and
 * pressing again is the gesture that was always going to work.
 */
let lookDenied = 0;
function lookRefused() {
  lookDenied += 1;
  if (lookDenied === 2) ui.toast('This browser will not free the mouse — drag to look around.');
}

/** Hand it back. Safe to call when we never had it. */
function dropLook() {
  if (looking()) document.exitPointerLock();
}

/**
 * The one wire between the mode and the mouse, made once — `onCinema`'s shape
 * and its reason. First person is reached from the F key, from the last notch
 * of the wheel and from `setFreeRoam` stepping you back out of it, and a lock
 * grabbed at one of those three is a mode that looks around on some ways in and
 * not others.
 */
scene.onFpv = (on) => { if (on) grabLook(); else dropLook(); };

/**
 * The look. `mousemove` and not `pointermove`, which is the one compatibility
 * call in here worth writing down: a locked pointer's `movementX` is the
 * canonical mouse-event field, every engine delivers it there, and the pointer
 * event's copy is the one they have disagreed about. Listening to both would be
 * a view that turns at double speed in whichever browsers send both.
 *
 * Nothing is lost by being an event later than the canvas handler: the pose a
 * pick is answered against is the one `render` last drew through, so who the
 * pointer has settled on is a frame behind either way.
 */
document.addEventListener('mousemove', (e) => {
  if (!scene.crosshair) return;
  const dx = e.movementX ?? 0;
  const dy = e.movementY ?? 0;
  scene.lookBy(dx, dy);
  lookEndsPress(dx, dy);
});

document.addEventListener('pointerlockchange', () => {
  const on = looking();
  // The renderer is TOLD, rather than reading the lock itself: see
  // `Scene.crosshair`. This is the only line that sets it.
  scene.crosshair = on;
  document.body.classList.toggle('looking', on);
  // It worked, so the tally of refusals is about something that is no longer
  // true. Kept as a run rather than a total, or a long session in and out of
  // first person eventually stands the mode down over refusals it recovered
  // from an hour ago.
  if (on) lookDenied = 0;
  // The aim jumps to the middle the moment the cursor goes, and comes back to
  // wherever the cursor reappears on the way out — which the browser puts back
  // where it was taken from, so there is nothing to restore.
  if (on) centreAim();
  else if (scene.fpv) ui.toast('Mouse released. Click the shop to look around again.');
});
// A refusal is not a state, so there is nothing to undo — but an unhandled
// event on `document` is a console full of red in a mode that is working.
document.addEventListener('pointerlockerror', () => {});

/**
 * A look does to a half-made press what a turn does: it ends it.
 *
 * The rule is `stepTurn`'s and the reason is `stepTurn`'s — an errand is armed
 * on the way DOWN, at whatever was under the aim then, and the ring winds off
 * that target rather than off where you are now pointing. So a press left
 * armed through a look would empty your hands into whatever you happened to
 * have been facing when you pressed, which is the bug the drag path already
 * refuses to have. The crosshair does not change that: it moves WITH the head,
 * and the armed errand does not move with either.
 *
 * Distance rather than per axis, and sticky once it fires, both for the reasons
 * `stepTurn` gives. The slop is what keeps this from firing on the pixel of
 * movement that comes off a button going down — hold still and the ring still
 * lands.
 */
function lookEndsPress(dx, dy) {
  const d = Math.hypot(dx, dy);
  if (spin && !spin.turned) {
    spin.look = (spin.look ?? 0) + d;
    if (spin.look >= TAP_SLOP) { spin.turned = true; cancelTrek(spin); release(); }
  }
  if (drag.id !== null && !drag.looked && !ringHasPress()) {
    drag.look = (drag.look ?? 0) + d;
    if (drag.look >= TAP_SLOP) { drag.looked = true; clearLongPress(); release(); }
  }
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

/**
 * The segments a drag from its press to the pointer would lay, its far end, and
 * the run's own start — which is no longer the edge you pressed on.
 *
 * The axis is the pointer's, re-read every move, rather than the pressed edge's
 * settled at `pointerdown`. `edgeRun`'s own note argued the other way — "a run
 * follows the line it started on, turning a corner is a second drag" — and that
 * is still true of one RUN; what it got wrong is that the press is not the
 * decision. Half a cell decides which of two lines you snapped to, so a drag
 * that meant north off a wall you were tracing east laid nothing at all and
 * read as the tool ignoring you.
 *
 * Ties keep the incumbent, `faceAlong`'s rule: a press that has not travelled,
 * and one that has gone the same distance both ways, are the line you pressed
 * on — so a click is exactly the single segment it always was.
 *
 * The perpendicular run hangs off the CORNER rather than off the pressed edge,
 * because the pressed edge names one lattice coordinate and the other axis
 * needs the other one. Which side of that corner it begins on is the direction
 * of travel: a lattice line sits between two cells, and the run takes the one
 * you dragged towards.
 */
function edgeDragRun(cx, cy) {
  if (!edgeDrag) return { segs: [], to: null, spec: null };
  const { start, from, corner } = edgeDrag;
  const tile = scene.pickTile(cx, cy, 0.55);
  if (!tile) return { segs: edgeRun(start, null), to: null, spec: start };

  const dx = Math.abs(tile.x - from.x);
  const dz = Math.abs(tile.z - from.z);
  const o = dx === dz ? start.o : (dx > dz ? 'h' : 'v');

  if (o === start.o) {
    const to = o === 'v' ? tile.z : tile.x;
    return { segs: edgeRun(start, to), to, spec: start };
  }
  if (o === 'h') {
    const to = tile.x;
    const spec = { o, x: to >= start.x ? start.x : start.x - 1, z: corner.z };
    return { segs: edgeRun(spec, to), to, spec };
  }
  const to = tile.z;
  const spec = { o, x: corner.x, z: to >= start.z ? start.z : start.z - 1 };
  return { segs: edgeRun(spec, to), to, spec };
}

/**
 * The box you drag round part of the shop to pick everything in it.
 *
 * The gesture docs/building.md called "the obvious next one" and left out, and
 * the reason it was left out is the reason it is its own drag path: it is the
 * one press in build mode that names several things and moves none of them, so
 * it can share nothing with the wall, brush, lift and camera drags standing
 * beside it in `pointerdown`.
 *
 * Three decisions in it.
 *
 * It is a **screen** rectangle, not a tile one, and `fixturesInRect` says why —
 * at this camera a shelf is drawn most of a tile up-screen of the ground it
 * stands on, so a box tested against tiles catches the row behind the one you
 * dragged over.
 *
 * It **adds** rather than replaces, always. Shift already means "and this one
 * too" on a click, and a drag under the same key that quietly threw away the
 * five you had picked by hand would be the same key meaning the opposite thing
 * at two speeds. So the box is a way of shift-clicking a lot of things at once,
 * and `togglePicked` is what it calls — which also makes dragging over the same
 * aisle twice a way to take it back out again.
 *
 * And a drag under `MARQUEE_SLOP` **is a click**, because a hand is not steady:
 * a shift-click that jittered three pixels would otherwise become a box round
 * nothing and read as the click having missed.
 */
const MARQUEE_SLOP = 5;
let marquee = null;

/** Draw it, or take it away. One absolutely-positioned div, no canvas work. */
function showMarquee() {
  const el = ui.el.marquee;
  if (!el) return;
  if (!marquee) { el.classList.remove('show'); return; }
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.abs(marquee.x1 - marquee.x0)}px`;
  el.style.height = `${Math.abs(marquee.y1 - marquee.y0)}px`;
  el.classList.add('show');
}

/**
 * Let go of it: a click if it never really moved, a box if it did.
 *
 * The box adds every fixture in it that is not already picked and takes out
 * every one that is — `togglePicked`, once per unit, which is exactly what the
 * clicks it stands in for would have done. One ripple, on the first, because a
 * ripple per shelf over eleven shelves is a puddle.
 */
function endMarquee(e) {
  if (!marquee || (e && e.pointerId !== marquee.id)) return false;
  const m = marquee;
  marquee = null;
  showMarquee();
  const moved = Math.abs(m.x1 - m.x0) > MARQUEE_SLOP || Math.abs(m.y1 - m.y0) > MARQUEE_SLOP;
  if (!moved) {
    // The click it always was. A miss is deliberately nothing at all — it is not
    // "deselect", because the ordinary press already means that and this one is
    // meant to be safe to repeat.
    if (m.pick) {
      ui.togglePicked(m.pick);
      scene.ripple(m.pick.x, m.pick.z, 'miss');
    }
    return true;
  }
  const hits = scene.fixturesInRect(m.x0, m.y0, m.x1, m.y1);
  /**
   * ...and the GROUND the box covered, which is not a thing that can be picked.
   *
   * A selection is a list of fixtures and always has been — ground has no id, no
   * record and nothing to hang a ring on — so for two steps the only thing a
   * copy could reach was whatever the units you caught happened to span. A
   * room's pads live exactly where its units do not, and a break area has no
   * units in it at all, so the layer that makes a walled annex a room was the one
   * layer a blueprint of a room could not carry.
   *
   * The box itself is the answer: it is a *region* whichever way you read it, and
   * the four corners it landed on are eight numbers. It is kept beside the picks
   * rather than turned into them, because everything downstream of a selection —
   * the rings, the menu, Remove, the ladder — is about fixtures and none of it
   * has any use for a square of lino. `ui.setPickRegion` is cleared by the same
   * line that clears the picks, so the two can never be about different drags.
   *
   * Ordered after `pickMany`, and that ordering is load-bearing: the first pick
   * of a fresh selection goes through `selectFixture`, which clears the region.
   */
  // One call, not one per unit: eleven shelves in a drag would otherwise be
  // eleven redraws of a menu that is every item in the catalogue long. See
  // `pickMany`.
  ui.pickMany(hits);
  const region = scene.groundQuad(m.x0, m.y0, m.x1, m.y1);
  const painted = copyableGround(scene.storeLayout);
  const ground = quadCells(scene.storeLayout, region)
    .filter((c) => painted.has(`${c.x},${c.z}`));
  if (!hits.length && !ground.length) return true;
  // ...and the ground is DRAWN, which is the half that makes any of this
  // legible: a unit picked gets a ring and a pad gets nothing, so a box that
  // caught a room's floor looked exactly like a box that had missed it, and the
  // only way to find out was to stamp the thing somewhere and count.
  ui.setPickRegion(region, ground);
  // One ripple, on the first — a ripple per shelf over eleven shelves is a
  // puddle.
  if (hits.length) scene.ripple(hits[0].x, hits[0].z, 'miss');
  return true;
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
  const { segs, to, spec } = edgeDragRun(cx, cy);
  if (!segs.length) { scene.setEdgeGhost(null, null); return null; }
  const verdict = canPlaceEdges(scene.storeLayout, segs, edgeDrag.kind);
  const state = verdict.ok ? (verdict.warn ? 'warn' : 'ok') : 'no';
  scene.setEdgeGhost(segs, state, edgeDrag.kind);
  ui.setBuildVerdict(verdict);
  // `to` is where the POINTER is, not the tail of the run — the same
  // distinction `showFloorDrag` makes about its far corner, and the wall drag
  // spent longer getting it wrong. `edgeRun` emits lowest-index-first whichever
  // way you dragged, so the last segment is the far end only when you dragged
  // towards increasing x or z; the other way round it is the segment you
  // STARTED on, and sending it asks the server for a run of exactly one.
  return { segs, verdict, to, spec };
}

/**
 * How near a line the pointer has to be for Shift to read it as a wall.
 *
 * A wall tool needs no such band — with one armed the pointer means "a line" and
 * every point in the shop has a nearest one, which is what lets you draw along a
 * wall without tracing it. Shift has to tell a line apart from the square beside
 * it, and most cells in a shop have a wall on one side: with no band, painted
 * floor next to a wall could never be what you were pointing at, and hovering
 * the middle of an aisle would offer to knock the shop open. Under half a cell,
 * so the middle of a tile is unambiguously the tile.
 */
const RAZE_GRIP = 0.24;

/**
 * How much nearer the WALL has to be to beat the thing standing against it.
 *
 * A shelf pushed up against a wall puts two surfaces within a hair of each
 * other, and at that range which one the ray reaches first is a rounding: the
 * highlight would swap between the shelf and the wall behind it as the camera
 * drifted, over a pointer nobody had moved. So the tie goes to the fixture,
 * which is the answer the older rule gave for every case — this only ever takes
 * a press away from a unit when the wall is *visibly* in front of it.
 */
const WALL_BIAS = 0.05;

/**
 * IS THE WALL IN FRONT OF THE THING? — the one tie-break behind "I cannot pick
 * that wall".
 *
 * "Things beat gaps" is right about a doorway under an awning and wrong about a
 * wall with a unit either side of it: the fixture wins by being *hit at all*, so
 * a wall between an appliance and a shelf has no camera angle that reaches it,
 * and it is unstrippable, unknockable and unable to become a doorway for ever.
 * The honest question is which surface the pointer is actually on, which is the
 * same tie-break `pickAim` makes between a crate and a fixture.
 *
 * `wall` null is the lattice guess rather than a hit (see `pickFaceHit`), and it
 * loses on purpose — otherwise every point in the shop is half a wall and the
 * nearest line would start outranking the shelf you are pointing at.
 */
function wallInFront(wall, thing) {
  return wall != null && thing != null && wall < thing - WALL_BIAS;
}

/**
 * ...and the same question asked of an aim that has already been taken.
 *
 * `pickAim` carries the distance of whatever it answered with, so this costs one
 * more raycast against the wall meshes and nothing else. A fixture with no
 * distance on it (a phone's remembered tap, which is an id rather than a hit)
 * blocks as it always did — there is no ray to compare against.
 */
function blockedByFixture(aim, cx, cy) {
  if (!aim?.fixture) return false;
  return !wallInFront(scene.pickFaceHit(cx, cy)?.dist ?? null, aim.dist ?? null);
}

/**
 * WHAT SHIFT IS POINTING AT — the one aim behind the whole demolish gesture.
 *
 * Hold Ctrl (Cmd) with the bar up and the pointer stops asking what the armed tool
 * would build and starts asking what is already there: a fixture, a finish, a
 * wall, a cell of ground. The tool is not consulted at ANY rung of it, and that
 * is the whole of what makes the gesture learnable — "hold Ctrl and click to
 * get rid of that" is one sentence, where the two presses this replaces were a
 * different modifier on a different button for each of two tools, each doing
 * nothing at all under the other one.
 *
 * The order is most-specific-first, which is `pickWay`'s "things beat gaps" with
 * two more rungs on it. A fixture covers the line behind it on screen and is
 * never not what you meant. Paint comes before the wall it is on because it is
 * the smaller of the two answers, and because the bigger one is still one press
 * away: strip the finish, and the same Ctrl-click on the now-bare wall knocks
 * it through. Ground is last because every cell in the world is one, so it is
 * the rung that would otherwise swallow the other three — and it is also why
 * the two wall rungs need `RAZE_GRIP`, since without it every cell in the shop
 * is half a wall too.
 *
 * Both refusals are asked HERE rather than at the press, so nothing ever lights
 * up red that a click would not actually remove: an edge has to have something
 * on it, and a cell has to be painted (`unchanged` is how a lawn — which is a
 * ground row like any other — says nobody has laid anything here).
 *
 * Null is the ordinary build press, untouched. A Shift press that finds nothing
 * is consumed rather than passed on, which is decided at the press: see
 * `pointerdown`.
 */
function razeAim(cx, cy) {
  // The palette is the consent, the same way it is for every other verb that
  // names a target by pointing. Not while you are carrying a fixture: then the
  // pointer is looking for somewhere to put that down, and Ctrl has no second
  // meaning to offer.
  if (!razeDown || !ui.paletteArmed || ui.holding) return null;
  const aim = whatsThere(cx, cy);
  if (aim?.kind !== 'ground') return aim;
  // `canPaintGround` is the authority, exactly as `canPlaceEdges` is for a wall
  // — and it is asked HERE rather than inside `whatsThere` because it is a
  // question about scraping rather than about aiming. The pipette wants a bare
  // floor cell named; the bulldozer wants to know whether there is anything on
  // it worth taking up, which is not the same question and answers differently
  // on every unpainted tile in the shop.
  const verdict = canPaintGround(scene.storeLayout, [aim.cell], null, null);
  return (!verdict.ok || verdict.unchanged) ? null : aim;
}

/**
 * WHAT IS UNDER THE POINTER, most-specific-first: a fixture, a finish, a wall,
 * the ground.
 *
 * Split out of `razeAim` when the pipette arrived, because "what is that" and
 * "get rid of that" are one question and two verbs — and a second ladder would
 * be two answers to it. Q copying the wall while Ctrl demolishes the shelf in
 * front of it is not a bug anybody would find by reading either function.
 *
 * It takes no modifier and no mode: the callers own the consent.
 */
function whatsThere(cx, cy) {
  const hit = scene.pickFixtureHit(cx, cy);
  /**
   * Overhead, the ladder is ONE rung — and it has to stop there.
   *
   * The three rungs below this one are the finish on a wall, the wall, and the
   * painted ground, and none of the three exists on the ceiling. So a press
   * that missed the duct fell straight past them onto the floor tile under it:
   * the marker lit on the ground, and Ctrl scraped the aisle you were standing
   * over while you were aiming four metres up.
   *
   * That is worse than a press that does nothing, because the thing it hits is
   * the shop rather than the run — and nothing on screen says the pointer has
   * changed storey, so it reads as the bulldozer ignoring the mode.
   */
  if (scene.pickDeck === CEILING) return hit?.f ? { kind: 'fixture', f: hit.f } : null;
  // ONE question about the line, answered twice — which is what keeps the two
  // wall rungs from disagreeing about which wall they are on. `pickFaceHit` hits
  // the edge meshes first, so pointing at a wall is exact and picks its side;
  // the guess it falls back to is what `RAZE_GRIP` is for.
  const on = scene.pickFaceHit(cx, cy, RAZE_GRIP);
  const face = on?.face ?? null;
  let wall = null;
  if (face) {
    if ((scene.storeLayout?.paint ?? {})[faceKey(face)]) wall = { kind: 'face', face };
    else {
      const seg = { o: face.o, x: face.x, z: face.z };
      if (kindAt(scene.storeLayout, seg) !== E.NONE) wall = { kind: 'edge', seg };
    }
  }
  // ...and the fixture rung is the one above them, EXCEPT where the ray met the
  // wall first — see `wallInFront`. Without that exception a wall with a unit
  // either side of it can never be named: both of them are under the pointer
  // somewhere along the line, so the top rung takes every press and there is no
  // camera angle that helps, because the fixture wins by being hit at all rather
  // than by being in front. That is a wall you can neither strip, knock through
  // nor turn into a doorway, in the mode whose whole job is rearranging.
  if (hit?.f && !(wall && wallInFront(on.dist, hit.dist))) return { kind: 'fixture', f: hit.f };
  if (wall) return wall;
  // `pickTile` and never `pickFixture`, which is the ground brush's own rule:
  // the second would scrape the roof of a shelf. Nothing above this line can be
  // a fixture anyway — the first rung took those — so this is belt and braces
  // for the day something else grows a top face.
  const cell = scene.pickTile(cx, cy);
  return cell ? { kind: 'ground', cell } : null;
}

/**
 * THE CLIPBOARD, CLIENT SIDE — which is a GHOST and nothing else.
 *
 * The blueprint itself lives on the shop (`Game.copyFixtures`) and is never
 * sent either way. What is kept here is the same selection re-read off the
 * layout the client already has, and it exists for exactly one reason: to draw
 * the preview. A paste with no preview is a stamp you aim by faith, over a shop
 * you are about to spend money on.
 *
 * Two copies of one thing is normally the disagreement this codebase spends
 * most of its comments avoiding, and the shape here is the one that makes it
 * safe: the client's copy decides **nothing**. It draws a ghost; the server
 * decides what lands, refuses what cannot, and charges. The failure mode of a
 * drift is a ghost that promised a shelf the shop then refuses — which is the
 * green-ghost bug, and which the ghost's own per-cell `canPlace` catches,
 * because it runs the same function against the same layout.
 *
 * Fixtures only in the *models*, deliberately. Ground, walls and paint travel
 * with the stamp and none of them is visible from this camera as a `ghost` —
 * a flat slab under a shelf ghost is under the shelf. The footprint squares are
 * what say where it all lands, which is why they are the half that had to learn
 * about the region: a copied break area is painted ground and nothing standing
 * on it, so with the squares taken off the fixtures alone there is nothing under
 * the pointer at all and the stamp is aimed by faith.
 *
 * It is an ARRAY and may legitimately be an empty one — that is the case above —
 * so every test for "am I holding a blueprint" is `!== null` by way of an empty
 * array being truthy, and never a length.
 */
let clipboard = null;
/**
 * ...and the cells of the region that are not a fixture, as offsets off the same
 * anchor. Only cells that carry something (`copyableGround`) — a marquee drawn wide
 * of a room covers bare grass, and a footprint that promised to lay it would be
 * a green square over ground the stamp does nothing to.
 */
let stampCells = [];
/**
 * Bumped on every copy, and it is the ghost's cache key rather than a counter
 * anybody reads. The stamp preview is keyed on the anchor tile — because that
 * is the only thing that moves while one is held — so copying a *different*
 * selection without moving the pointer would otherwise leave the old blueprint
 * drawn under it, which reads as Ctrl+C not having taken.
 */
let stampSeq = 0;
/**
 * ...AND THE BLUEPRINT THAT IS A MOVE RATHER THAN A COPY.
 *
 * Null while what is held is an ordinary stamp; otherwise the ids the press
 * will shift and the corner they are standing at right now, which is what turns
 * the pointer into a delta.
 *
 * It rides the SAME held blueprint as Ctrl+C on purpose. Both are "something in
 * your hands that a press puts down", both draw one footprint under the pointer,
 * and two of them would be two promises about one click — the pair
 * `selectBuildTool` and `copySelection` already refuse to be. What differs is
 * one message at the end and one flag here.
 */
let shiftFrom = null;
// Registered on `ui` for the reason `dropBoardPick` is: the ladder that owns
// Escape is `ui.escape`, and one listener owning the key is the rule this file's
// keydown handler is written around.
ui.dropStamp = (dry = false) => dropStamp(dry);

function dropStamp(dry = false) {
  if (!clipboard) return false;
  // `dry` is `ui.escape`'s question rather than its press, exactly as
  // `dropBoardPick` takes it: asking whether the key is spoken for must not
  // drop the thing the asker was about to describe.
  if (dry) return true;
  clipboard = null;
  stampCells = [];
  // A MOVE that was aimed and never landed, which is the one of the two that
  // owns state outside this file: it borrowed build mode off a fixture menu, and
  // dropping the blueprint is where that mode goes back. Unconditional, because
  // `endShift` is a no-op for a stamp and a branch here would be one more place
  // the two can drift.
  shiftFrom = null;
  ui.endShift();
  scene.setRunGhost(null, null);
  scene.setFloorGhost(null, null);
  ui.setBuildVerdict(null);
  refreshGhost(true);
  return true;
}

/**
 * MOVE, WITH SEVERAL PICKED.
 *
 * A selection cannot be carried — `holding` is one fixture, because hands are —
 * so this is aimed instead: the shop keeps standing where it is, the preview
 * follows the pointer, and the press sends the one delta. Every member keeps its
 * own facing, its own tier and its own tile relative to the rest, because the
 * server moves them as a rigid group (`shiftFixtures`).
 *
 * The anchor is the top-left of the group's own footprint, which is `paste`'s
 * anchor exactly and is the reason it is that rather than the fixture whose menu
 * you were in: with six picked there is no "the one you clicked", and a gesture
 * the player has already learnt on Ctrl+V beats a second rule.
 *
 * `pickedFixtures` before anything closes the panel — `closePanel` clears the
 * selection, and this is called from a fixture menu that is about to shut.
 */
ui.shiftSelection = () => {
  const picks = ui.pickedFixtures();
  if (picks.length < 2) return false;
  // `footprint` and not the anchor tile, for `copySelection`'s reason: a pen's
  // record is its min corner and a 2x2 reaches a cell further both ways.
  const at = picks.flatMap((f) => footprint(f.kind, f.x, f.z));
  const x0 = Math.min(...at.map((c) => c.x));
  const z0 = Math.min(...at.map((c) => c.z));

  clipboard = picks.map((f) => ({
    dx: f.x - x0,
    dz: f.z - z0,
    kind: f.kind,
    piece: f.piece ?? null,
    variant: f.variant ?? '',
    rot: f.rot ?? 0,
    deck: f.deck ?? 0,
  }));
  // Ground stays where it is: this moves what is standing on the floor, not the
  // floor. A copied ROOM carries its pads because it is being built again
  // somewhere else; a move is the same units on different tiles.
  stampCells = [];
  shiftFrom = { ids: picks.map((f) => f.id), x: x0, z: z0 };
  stampSeq++;
  // Before the panel closes, or `releaseMenuMode` hands back the build mode this
  // errand is about to need — nothing goes into your hands here, so `holding`
  // never goes true and `_shift` is the only thing holding the mode open.
  ui.startShift();
  // Holding a blueprint means holding nothing else — `copySelection`'s pair.
  ui.disarmTool();
  // AND THE MENU GOES, which is the half that is not bookkeeping: the panel is
  // half the screen and what you are about to do is point at the floor behind
  // it. Owned here rather than by each caller, so the button, the M key and the
  // pill row cannot disagree about it.
  ui.closePanel();
  ui.toast(`Moving ${picks.length} — click where they should go · Escape leaves them`);
  return true;
};

/** The press at the end of it. One message, one delta, one undo step. */
function commitShift(tile) {
  const from = shiftFrom;
  net.send('build-shift', { ids: from.ids, dx: tile.x - from.x, dz: tile.z - from.z });
  // What was picked is still what is picked, which is `endMove`'s claim about
  // one fixture said about six — named by the cells it is being sent to, since
  // the ids it will come back wearing do not exist yet.
  ui.markShifted(clipboard.map((c) => ({
    kind: c.kind, x: tile.x + c.dx, z: tile.z + c.dz, deck: c.deck,
  })));
  // Unlike a stamp, which stays in your hands so an aisle can be laid four
  // times down a wall: these units are somewhere else now, and a blueprint of
  // where they used to be is a second move nobody asked for.
  dropStamp();
}

/**
 * Ctrl+C.
 *
 * The REGION is the second half of the message and the reason the pads come with
 * it: a selection is a list of fixtures, and a room's painted ground lives
 * exactly where its units do not. The four ground-plane corners of the box you
 * dragged (`ui.pickRegion`) are what say how far out the copy reaches, and
 * `quadCells` is what turns them into squares — the same function, against the
 * same layout, on both sides of the wire.
 *
 * Which means the ANCHOR has to be derived the same way in both places, and that
 * is the one thing in here that would fail silently. The server offsets every
 * layer off the top-left of the *region*, so a client that went on anchoring on
 * the top-left of the *fixtures* would draw a preview sitting up and left of
 * where the stamp lands, by however far the drag reached past the shelves. A
 * ghost that is honest about what will be built and wrong about where is worse
 * than no ghost.
 */
function copySelection() {
  const picks = ui.pickedFixtures();
  const L = scene.storeLayout;
  const dragged = quadCells(L, ui.pickRegion);
  if (!picks.length && !dragged.length) {
    ui.toast('Nothing picked — hold Shift and drag to select', true);
    return;
  }

  // Every cell the copy is about, fixtures included — the anchor is the corner
  // of THIS, not of the units. `footprint` and not the anchor tile, because a
  // pen's record is its min corner and a 2x2 reaches a cell further both ways.
  const keys = new Set(dragged.map((c) => `${c.x},${c.z}`));
  for (const f of picks) {
    for (const c of footprint(f.kind, f.x, f.z)) keys.add(`${c.x},${c.z}`);
  }
  const at = [...keys].map((k) => k.split(',').map(Number));
  const x0 = Math.min(...at.map(([x]) => x));
  const z0 = Math.min(...at.map(([, z]) => z));

  clipboard = picks.map((f) => ({
    dx: f.x - x0,
    dz: f.z - z0,
    kind: f.kind,
    piece: f.piece ?? null,
    variant: f.variant ?? '',
    rot: f.rot ?? 0,
    // The server's blueprint already carries this through `specOf`; the client
    // needs it too, because it owns the preview AND the plane the stamp aims on.
    deck: f.deck ?? 0,
  }));
  const painted = copyableGround(L);
  stampCells = dragged
    .filter((c) => painted.has(`${c.x},${c.z}`))
    .map((c) => ({ dx: c.x - x0, dz: c.z - z0 }));

  stampSeq++;
  // ...and a COPY is not a move, which is the one field that tells the two
  // halves of the held blueprint apart. Ctrl+C over an aimed move replaces it,
  // and `endShift` is what hands back the mode that move had on loan.
  shiftFrom = null;
  ui.endShift();
  // Holding the blueprint means holding nothing else. Arming a tool is what
  // puts it down (`ui.onArm`), and this is the other half of that pair — a
  // shelf ghost and a stamp footprint under one pointer would be two promises
  // about one press.
  ui.disarmTool();
  net.send('build-copy', { ids: ui.pickedIds(), region: ui.pickRegion });
  const n = picks.length + stampCells.length;
  ui.toast(`Copied ${n} ${n === 1 ? 'thing' : 'things'} — click to stamp, Escape to drop`);
}

/**
 * Which cells hold ground a copy would actually carry — `copyFixtures`' own
 * filter, said on this side so the footprint squares promise what will land.
 *
 * A row with no design is one of two things. The eraser writes plain ground,
 * which pastes as the same eraser stroke. `freezeYard` writes a PAD with no
 * piece, and there is no catalog row to name for one, so the server leaves it
 * behind — and a preview that did not know would paint a green square over the
 * delivery bay and then lay nothing on it.
 */
function copyableGround(L) {
  const out = new Set();
  for (const g of L?.ground ?? []) {
    if (g.p || !g.k || g.k === 'floor') out.add(`${g.x},${g.z}`);
  }
  return out;
}

/**
 * The squares the whole stamp covers — its fixtures and the ground with them.
 *
 * `setFloorGhost`'s cells, where `pasteCells` is `setRunGhost`'s: one says where
 * the press lands and the other draws the models. They were the same list while
 * a blueprint was a list of fixtures, and a region is what separates them.
 *
 * The ground cells are always `ok`. A floor may be laid over anything that is
 * already ground, so the only honest colours here are the fixtures' — and a
 * green square is about where the press lands, not a promise about a price.
 */
function stampFootprint(tile, fixtures) {
  if (!tile) return [];
  const seen = new Set(fixtures.map((c) => `${c.x},${c.z}`));
  const out = [...fixtures];
  for (const c of stampCells) {
    const key = `${tile.x + c.dx},${tile.z + c.dz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: tile.x + c.dx, z: tile.z + c.dz, state: 'ok' });
  }
  return out;
}

/** Where the stamp would land — the ghost's cells, and the paste's own anchor. */
function pasteCells(tile) {
  if (!clipboard || !tile) return [];
  /**
   * A MOVE FORGIVES ITSELF, and it has to forgive the whole GROUP.
   *
   * The units being shifted are still standing where they are — nothing is in
   * the air — so an aisle nudged one square along has every member but the
   * leading one previewing over the neighbour it is about to replace. Asked one
   * id at a time that reads as amber down the whole row, over a press the server
   * accepts: the green-ghost bug pointed the other way, which is the one that
   * makes a working feature look broken. `ignores` in shared/build.js is the
   * server's own answer to the same question, so both ends agree by asking it.
   */
  const ignoreId = shiftFrom ? new Set(shiftFrom.ids) : null;
  return clipboard.map((c) => ({
    x: tile.x + c.dx,
    z: tile.z + c.dz,
    rot: c.rot,
    kind: c.kind,
    piece: c.piece,
    variant: c.variant,
    deck: c.deck,
    state: canPlace(scene.storeLayout, {
      kind: c.kind, x: tile.x + c.dx, z: tile.z + c.dz, rot: c.rot, deck: c.deck,
    }, { ignoreId }).ok ? 'ok' : 'warn',
  }));
}

function pasteAtPointer(tile = scene.pickTile(pointer.x, pointer.y)) {
  if (!ui.buildOn) { ui.toast('Building only', true); return; }
  if (!clipboard) { ui.toast('Nothing copied', true); return; }
  if (!tile) { ui.toast('Point at somewhere to put it', true); return; }
  // Committing to the mode, exactly as buying a fixture does: a paste is a
  // purchase, so a menu still open on some other unit must not drop you out of
  // build mode halfway through one.
  ui.commitBuildMode();
  net.send('build-paste', { x: tile.x, z: tile.z });
}

/**
 * Q — ARM WHAT YOU ARE POINTING AT.
 *
 * The palette is a catalogue of *designs* and the thing you usually want to
 * build next is one you can already see, so "which of the eleven rows was that
 * shelf" is a question the shop is answering in the aisle while the bar is
 * where you have to go to re-ask it. This is that answer taken directly. It is
 * the pointer's own ladder (`whatsThere`), so it copies the four things Ctrl
 * gets rid of and in the same order — a finish before the wall under it, a wall
 * before the ground it stands on.
 *
 * Three things about it.
 *
 * It carries the **variant and the facing** as well as the piece, which is most
 * of the point: `selectBuildTool` deliberately resets the angle (a new tool has
 * made no placement decision) and restores whichever shape you last used for
 * that piece, and both of those are exactly wrong here — you are not picking a
 * design off a list, you are pointing at a finished decision somebody made. So
 * the facing is written after the select and **pinned** (`rotPinned`), or
 * `faceAlong` re-derives it on the very next frame and the key reads as copying
 * everything but the rotation.
 *
 * It does **not** open the bar** (`commitBuildMode`, quietly), because a key
 * that means "that one" must not cost you the sight of the thing you pointed
 * at — the palette is the biggest thing on screen and it comes up over the
 * aisle you are working in.
 *
 * And a **miss says so**. Every other way to arm a tool is a press on a button
 * that is visibly a button; this one is aimed, so a Q that quietly changed
 * nothing would be indistinguishable from a Q that is not bound.
 */
function pipette() {
  if (!ui.buildOn || ui.holding) return;
  const aim = whatsThere(pointer.x, pointer.y);
  const L = scene.storeLayout;
  let id = null;
  let variant = '';
  let rot = null;

  if (aim?.kind === 'fixture') {
    const f = aim.f;
    // A station is the one kind whose tool id is not its piece: one row sells
    // one machine, so the palette lists appliances by the machine.
    id = f.station ? `station:${f.station}` : (f.piece ?? f.kind);
    variant = f.variant ?? '';
    rot = f.rot ?? 0;
  } else if (aim?.kind === 'face') {
    id = (L?.paint ?? {})[faceKey(aim.face)] ?? null;
  } else if (aim?.kind === 'edge') {
    // By what the line IS rather than by a name: an edge tool carries its own
    // kind (`edge`), and the four signed doorways and the four glazings are
    // separate entries, so this picks the exact one that is standing there.
    const k = kindAt(L, aim.seg);
    id = ui.buildToolByEdge?.(k) ?? null;
  } else if (aim?.kind === 'ground') {
    // The overlay and not the tile, which is the distinction `groundKindOfTile`
    // costs you: the tile says what a cell became, and what a brush lays is a
    // ROW. A cell the shell stamped has no row and nothing to copy.
    id = groundIndex(L).get(`${aim.cell.x},${aim.cell.z}`) ?? null;
  }

  if (!id || !ui.hasBuildTool(id)) {
    ui.toast(aim ? 'Nothing on the palette matches that' : 'Nothing there to copy');
    return;
  }
  ui.commitBuildMode();
  ui.selectBuildTool(id);
  if (variant) ui.selectBuildVariant(variant);
  if (rot != null) { ui.buildRot = rot4(rot); ui.rotPinned = true; }
  ui.toast(`Armed ${ui.buildToolName(id)}`);
  refreshGhost(true);
}

/** Get rid of whatever `razeAim` named. One press, four kinds of target. */
function doRaze(aim) {
  if (aim.kind === 'fixture') {
    scene.ripple(aim.f.x, aim.f.z, 'no');
    ui.razeFixture(aim.f);
    return;
  }
  if (aim.kind === 'face') { stripFace(aim.face); return; }
  if (aim.kind === 'edge') { razeEdge(aim.seg); return; }
  scrapeGround(aim.cell);
}

/** Take the finish off one side of one wall — the paint brush's null entry. */
function stripFace(at) {
  scene.ripple(at.x, at.z, 'no');
  // Empty piece and no `to`, which is Bare Wall over a run of one — the same
  // two things the brush itself sends, so the server runs the same `faceRun`
  // and refunds the same half.
  net.send('paint-face', {
    o: at.o, x: at.x, z: at.z, s: at.s, piece: '', to: null,
  });
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
let beltDrag = null;

/**
 * The preview for laying a run of conveyor in one drag.
 *
 * Squares rather than ghost fixtures, deliberately: `setBuildGhost` answers
 * about ONE spec, and a sixty-cell run of real ghosts is sixty models built per
 * pointer move. The green square is the same language the floor brush already
 * speaks and it says the two things that matter — where it will go, and whether
 * it can.
 *
 * A cell that is already taken shows AMBER rather than red, because the run
 * skips it and lays the rest: a drag across a shop will clip a shelf, and
 * refusing the whole gesture for one square would make the tool useless in the
 * shop it exists for.
 */
function showBeltDrag(cx, cy) {
  if (!beltDrag) return null;
  // The last tile this drag actually REACHED, not wherever the event that ended
  // it happened to land.
  //
  // `pickTile` answers null off the end of the map, and a run committed with a
  // null far end is `runCells(start, start)` — one cell. So a drag that
  // previewed twelve cells the whole way lays exactly one, on release, with no
  // refusal and nothing in the log. It reads as the drag not being implemented.
  //
  // It is a phone bug in practice and not by nature: the viewport is small, the
  // shop fills it, and the natural end of a swipe is at the edge of the glass —
  // which is off the map more often than not. On a desktop the same gesture has
  // a few hundred pixels of grass to stop on, so it essentially never happens.
  //
  // Keeping the last good answer is also what `runCells`' own header asks
  // for: the far end is the POINTER's, and the pointer's far end is the last
  // place it was, not a coordinate read out of a `pointerup`.
  const to = scene.pickTile(cx, cy) ?? beltDrag.to ?? null;
  if (to) beltDrag.to = to;
  // Same four arguments the server re-runs this with, `rot` included, or the
  // ghost is a preview of a different run from the one the release lays.
  const cells = fixtureRunCells(beltDrag.kind, beltDrag.start, to, BELT_RUN_MAX, ui.buildRot);
  if (!cells.length) {
    scene.setFloorGhost(null, null);
    scene.setRunGhost(null, null, null);
    return null;
  }
  const L = scene.storeLayout;
  // Per cell rather than only counted, because the models are drawn per cell
  // and a run that clips one shelf should show that square amber under an amber
  // belt — the count alone would paint the whole run the colour of its worst
  // square, which is the opposite of what "it skips it and lays the rest" means.
  for (const c of cells) {
    // A sweep adds around what is already there; it never turns a loader or
    // sorter back into plain belt just because the pointer crossed its cell.
    // A one-cell press keeps the deliberate swap gesture it has always had.
    const here = cells.length > 1 ? conveyorAt(L, c.x, c.z, ui.buildDeck) : null;
    // ...but a cell of the ARMED kind is aimed rather than stepped round — see
    // `Game.buildRun`, which this has to agree with in both directions. Green,
    // and `canPlace` is not asked: it refuses a belt on a belt, which is right
    // about a purchase and is not what this square is about. The run ghost is
    // already drawing the piece at `c.rot`, so what is previewed IS the turn.
    //
    // A cell that already points that way is NOT one of these, or a drag along a
    // run in its own direction previews green and comes back as the refusal it
    // has always been. Same test as the server's, to the `rot4`.
    const aimed = here && here.kind === beltDrag.kind && RUN_KINDS.includes(beltDrag.kind)
      && rot4(here.rot ?? 0) !== c.rot;
    c.state = aimed || (!here
      && canPlace(L, { kind: beltDrag.kind, x: c.x, z: c.z, rot: c.rot, deck: ui.buildDeck }).ok)
      ? 'ok' : 'warn';
  }
  const ok = cells.filter((c) => c.state === 'ok');
  scene.setFloorGhost(cells, ok.length === cells.length ? 'ok' : (ok.length ? 'warn' : 'no'));
  /**
   * ...and the belts themselves, facing the way the drag turned them.
   *
   * The key is built HERE rather than in the renderer, off the four things the
   * run is derived from, because that is the cheap question: the pointer moves
   * sixty times a second inside one tile and `runCells` answers the same
   * thing every time, so keying on the cells would mean rebuilding the string
   * (and comparing 64 cells of it) for every one of those frames. Crossing a
   * tile is what changes any of these four.
   */
  scene.setRunGhost(
    `${beltDrag.kind}/${beltDrag.piece ?? ''}/${beltDrag.variant ?? ''}`
      + `:${beltDrag.start.x},${beltDrag.start.z}>${to?.x},${to?.z}:${ui.buildRot}:${ui.buildDeck}:${ok.length}`,
    cells,
    { kind: beltDrag.kind, piece: beltDrag.piece ?? null, variant: beltDrag.variant ?? '', tier: 1, deck: ui.buildDeck },
  );
  ui.setBuildVerdict(ok.length
    ? { ok: true, warn: ok.length < cells.length ? `${cells.length - ok.length} squares are taken` : null }
    : { ok: false, reason: 'nothing can go along there' });
  // The POINTER's far end, never the tail of the list — see `runCells`.
  return { cells, ok: ok.length, to };
}

let floorDrag = null;

/**
 * TEMPORARY — one line per press, for chasing the dead-click bug. Delete with
 * its callers once that is closed. `sns.clicks = true` in the console turns it
 * on without a reload, and `false` shuts it up again.
 *
 * OFF by default, which is the only part of this worth a sentence. It is not
 * about noise in somebody else's console — it is that a press is the one event
 * this game has sixty of a minute, and a `console.log` per press keeps every
 * argument it was handed alive for as long as devtools holds the line. Left on
 * for a player who never opens the console that is a slow leak nobody would
 * ever attribute to a debug switch. On for whoever is actually chasing the bug
 * is one line typed, in the console they already have open.
 */
window.sns ??= {};
window.sns.clicks ??= false;
function clickLog(what, extra) {
  if (!window.sns?.clicks) return;
  // Flattened into the MESSAGE rather than passed as an object: the console
  // collapses objects, and every field worth reading here was hidden behind a
  // disclosure triangle in the one place somebody is copying lines out of it.
  const bits = Object.entries({
    tool: ui.toolId?.(), holding: ui.holding?.kind ?? null, ...extra,
  }).map(([k, v]) => `${k}=${typeof v === 'object' && v ? JSON.stringify(v) : v}`);
  // eslint-disable-next-line no-console
  console.log(`[click] ${what} · ${bits.join(' ')}`);
}

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
  // Any press at all hands the theft cut back, whether or not it turns out to
  // be the tazer. Same rule as the first step of a walk: a cut is announcing
  // somebody to act on, so acting has to outrank watching. Cheap enough to sit
  // above every branch below — it no-ops when there is no cut running.
  scene.releaseCut();
  // First person with the mouse handed back — Escape, or a lock the browser
  // turned down on the way in. The press is how you ask for it again, and it is
  // ONLY that: acting on the shop as well would mean the one gesture that gets
  // you out of trouble also grabs whatever the cursor happened to be over.
  //
  // A refused ask costs this one press and no state, which is why it can be
  // swallowed at all — the browser's cooling-off after an Escape is about a
  // second, and the next press is the same gesture again. See `grabLook`.
  if (scene.fpv && !scene.crosshair && e.pointerType === 'mouse' && finePointer()
    && lookDenied < 2) {
    grabLook();
    return;
  }
  if (e.button === 2) {
    // Mid-run, the right button takes back the run rather than turning the
    // camera. You are four tiles into a wall you have changed your mind about,
    // and `endPress` with no event drops it without sending. This used to live
    // on `contextmenu`, which is too late on Windows — that event fires on
    // *release* there, by which point the pointerup below has already built it.
    if (edgeDrag || floorDrag || faceDrag) {
      clickLog('RIGHT BUTTON aborted the run', { buttons: e.buttons, ctrl: e.ctrlKey, meta: e.metaKey });
      endPress();
      return;
    }
    // A mouse reuses one pointerId for every button, so a right press during a
    // left drag would hand the spin that drag's own id and steal its moves.
    if (drag.id !== null) return;
    spin = {
      id: e.pointerId,
      ax: { x: e.clientX, y: e.clientY },
      turned: false,
      at: performance.now(),
      put: null,
      trek: null,
    };
    // The put half of the press, armed on the way DOWN for the same reason the
    // take is: the ring winds off an errand, so naming it on release means a
    // hold does nothing however long you hold it. Harmless if the press turns
    // out to be a camera turn — an errand is a target, not an action, and
    // `pointermove` lets go of the button the moment the view moves.
    spin.put = armPut(e.clientX, e.clientY);
    // Nothing else is armed here any more. The right button used to carry two
    // demolitions of its own — Shift + right knocked a wall through with a wall
    // tool up, and took a cell of ground back up with a brush up — and both have
    // moved onto Ctrl + LEFT, where they are the same press as tearing out a
    // shelf (`razeAim`) — Shift while that was being written, Ctrl since the
    // two modifiers were given one meaning each. What that leaves is a button that means one thing in
    // build mode: back out. It was five things, one of them the only destructive
    // press in the mode, and the tell was that the same reflex which closes a
    // picker also took a wall down.
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

  // The two modifiers take the press before ANY of the four drags below — Ctrl
  // (Cmd) to get rid of what is under the pointer, Shift to add it to the
  // selection. See `setShift`.
  //
  // First, because every one of those drags is a verb and neither of these is
  // that verb: a wall tool would have laid a segment, the brush a cell, the
  // palette a fixture, and the bare press turned the camera. Both gestures are
  // made by holding a key and clicking several times, and each of those clicks
  // has to be *only* the gesture — one that also built something would make it
  // unusable in exactly the mode you use it in.
  //
  // Ctrl is asked FIRST, so Ctrl+Shift together is a demolition rather than an
  // ambiguity. That ordering is also what keeps the pair from having to know
  // about each other anywhere else.
  //
  // Consumed whole (no capture, no `drag`, no hold timer) so the release is not
  // also a tap: `tapAtPointer` would walk you to the last shelf you picked.
  //
  // Each key is read off the EVENT and pushed into its flag, not the other way
  // round: a modifier pressed while another window had the keyboard never
  // reached the key handler, and a press that demolished something the hover had
  // not gone red on is the green-ghost bug with a bill attached.
  if ((e.ctrlKey || e.metaKey) && !ui.holding) {
    setRaze(true);
    const aim = razeAim(e.clientX, e.clientY);
    if (aim) { doRaze(aim); return; }
    // Nothing to get rid of, and the bar is up: the press is spent. Falling
    // through would be the one Ctrl-click in the mode that BUILDS something,
    // which is the outcome a near miss must never have.
    if (ui.paletteArmed) return;
  }
  // ...or the latch, which is the same branch reached without a keyboard — see
  // `togglePickLatch`. `setShift` is deliberately left alone for it: `shiftDown`
  // is also the sprint key and is overwritten by the next `pointermove` off the
  // event, so a latch written into it would be both a run and a flag that
  // cleared itself the moment your finger slid.
  if ((e.shiftKey || ui.pickLatch) && !ui.holding) {
    if (e.shiftKey) setShift(true);
    // The press opens a MARQUEE and the tap is its degenerate case, which is
    // the only shape that lets one key mean both. A click adds one unit and a
    // drag adds everything you drew round — and the two cannot be told apart on
    // the way down, so the box starts on every press and `endMarquee` decides
    // which it was by how far the pointer travelled. The old code answered on
    // `pointerdown` and therefore had nowhere to put a drag at all.
    //
    // Captured, so a drag that leaves the canvas still ends here. Consumed
    // whole — no `drag`, no hold timer — for the reason the toggle already was:
    // the release must not ALSO be a tap, or `tapAtPointer` walks you to the
    // last shelf you dragged over.
    //
    // `pick` is read now rather than on release, because the world moves: a
    // stocker crossing under a stationary pointer between the press and the
    // release would otherwise be what you had clicked — `settledWho`'s trap
    // said about a fixture.
    //
    // Started on a hit, or anywhere at all inside a mode that is yours. That
    // second clause is the old `if (ui.paletteArmed) return` in its new job: a
    // shift-click that missed everything was already spent while building, and
    // outside the mode it fell through to walking — which is Shift's other job
    // on that key (`sprint`), and shift-click-to-run-over-there is a gesture
    // people have. So the box may only begin on bare floor where the press was
    // never going to walk you anyway.
    const pick = pickTarget(e.clientX, e.clientY);
    if (pick || ui.paletteArmed) {
      marquee = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, pick,
      };
      canvas.setPointerCapture(e.pointerId);
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
    const corner = scene.pickCorner(e.clientX, e.clientY);
    const from = scene.pickTile(e.clientX, e.clientY, 0.55);
    clickLog('down: edge drag starting', {
      ek, start: start && `${start.o}${start.x},${start.z}`, corner, from,
    });
    if (start && corner && from) {
      edgeDrag = { start, corner, from, kind: ek, id: e.pointerId };
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
  /**
   * A FIXTURE LAYS AS A RUN. Ahead of the ground brush for no reason other than
   * that a fixture is not a brush and the test below would never have matched
   * one.
   *
   * This was conveyors only for the whole life of the drag, and there was never
   * anything about it that was about belts: an aisle is six shelves on one line
   * and it was six presses, a fence is the same sentence about `fence`. What a
   * corner MEANS differs by kind and that is `runFollows`, one flag, decided in
   * `shared/build.js` where both ends read it.
   *
   * The two conditions are not one condition, and the difference is what keeps
   * drag-to-move alive. A conveyor claims the press wherever it lands, because
   * starting a drag ON a run you already own is how you extend one — see the
   * tail-aiming in `Game.buildRun`. Everything else claims it only over bare
   * ground, because `drag.lift` is a press that landed on an existing fixture,
   * and a shelf tool that swallowed those would mean arming any tool at all
   * silently disables dragging things about — in the mode whose whole job is
   * rearranging.
   */
  const armed = ui.armedTool?.() ?? null;
  const runnable = armed && FIXTURES[armed.kind]
    && (RUN_KINDS.includes(armed.kind) || !pickTarget(e.clientX, e.clientY));
  if (runnable) {
    const start = scene.pickTile(e.clientX, e.clientY);
    if (start) {
      // `variant` rides along with the piece now that the preview draws the
      // real art: a corner belt and a straight one are the same row and the
      // same price, so a ghost that dropped the shape would preview a design
      // you did not arm — which is the green-ghost rule said about a look.
      beltDrag = {
        start, kind: armed.kind, piece: armed.piece ?? null,
        station: armed.station ?? null,
        variant: ui.buildVariant ?? '', id: e.pointerId,
      };
      canvas.setPointerCapture(e.pointerId);
      // The hover ghost has to go, and this is the only drag that has one to
      // get rid of: a belt is a FIXTURE tool, so `refreshGhost` has been
      // drawing a single caged ghost on the tile under the pointer right up
      // until this press — and the first thing that press does is return early
      // from `refreshGhost` for the rest of the drag, which leaves that ghost
      // standing in the scene with nothing left to update or remove it. It was
      // invisible while a run previewed as flat squares and is not now: what
      // you see is the first cell wearing two belts, one of them at whatever
      // facing the pointer happened to be resting at. The other three drags
      // (wall, brush, paint) are tools that never had a fixture ghost.
      scene.clearBuildGhost();
      showBeltDrag(e.clientX, e.clientY);
      return;
    }
  }

  const brush = ui.groundForTool();
  if (brush !== undefined) {
    const start = scene.pickTile(e.clientX, e.clientY);
    if (start) {
      floorDrag = { start, kind: brush.kind, piece: brush.piece, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      showFloorDrag(e.clientX, e.clientY);
      clickLog('down: floor drag started', { start });
      return;
    }
    clickLog('down: floor tool but pickTile MISSED — press falls to camera', {});
  }

  clickLog('down: no build drag claimed it — generic drag/tap path', {
    lifted: !!(ui.paletteArmed && !ui.holding && !ui.demolishArmed()
      && pickTarget(e.clientX, e.clientY)),
  });
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
  // The lift happens at the slop line, where a pan would have committed — and
  // the slop line asks one more thing the arming deliberately does not: whether
  // this is the unit you already SELECTED. Armed either way because the hold
  // does not care (it cannot fire mid-turn, so it never needed a subject naming
  // first).
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
  //
  // ...EXCEPT while building, where a left drag SLIDES whatever the device is.
  // The keys already made that argument and only ever made it to a keyboard:
  // building is reaching for somewhere you cannot stand, so getting there is the
  // camera's whole job in the mode, and turning is the rarer errand of the two.
  // What it costs is nothing — the right drag and `,`/`.` still turn, which is
  // the same escape hatch the move-drag leans on — and what it buys is that the
  // one gesture a mouse and a finger share does the same thing in the mode where
  // the pointer is doing the building. A view that spun a quarter when you
  // reached for the far corner is the reason WASD had to exist here at all.
  drag.turns = e.pointerType !== 'touch' && e.pointerType !== 'pen' && !building();
  // The same two pointer kinds, kept as their own field because the other half
  // of this asks a different question about them: `turns` is what the drag does
  // to the camera, and this is whether the press has a hover behind it — a
  // question about the DEVICE, so it cannot be `!drag.turns` any more.
  drag.touch = e.pointerType === 'touch' || e.pointerType === 'pen';
  drag.aiming = false;
  drag.spun = false;
  drag.travel = 0;
  // The look's own copy of `spun`, and cleared here with it. See `lookEndsPress`.
  drag.look = 0;
  drag.looked = false;
  drag.done = false;
  // Cleared before the arming block below, which is what sets them.
  drag.took = false;
  drag.rummage = false;
  drag.pressedAt = performance.now();
  // A finger has no hover, so the ring that says what you are pointing at has
  // never been asked for at the moment a touch lands — it only ever appeared
  // under a mouse that moved first. Aiming here is what gives the held press
  // something to animate on a phone at all.
  // ...and with the mouse locked there is no press position either: `clientX` is
  // the frozen ghost `pointermove` refuses above, and the aim is the crosshair.
  if (scene.crosshair) centreAim();
  else {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.onCanvas = true;
  }
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
    if (aimed) {
      net.send('take', { palletId: aimed.id });
      drag.took = true;
      // ...and whether the release still has a job. Only a lone crate you are
      // stood at has a finer answer than the lift (`crate-one`), and it is the
      // one press that must keep its tap past `LONG_PRESS_MS` — see
      // `CRATE_HOLD_MS`. Everything else keeps the old rule exactly: a pile
      // offers whole boxes only, and one across the shop is a walk.
      drag.rummage = !aimed.stacked && inReachOf(aimed);
    }
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
    // `done` is what swallows the release, and it may only be set where the
    // hold ACTUALLY DID SOMETHING — which is why it is written four times below
    // rather than once up here. A hold that quietly ate the press makes a slow
    // click do nothing at all, and that is not a subtle failure: it is
    // indistinguishable from a missed click, it fires at 420ms (which is an
    // ordinary click made while thinking), and there is nothing on screen to
    // say why. Laying a row of shelves, half of them simply never appear.
    //
    // It was unconditional here for 86 commits, and the reason it moved up is
    // real and is kept: winding a ring is a second thing a hold does, and the
    // release of one must not ALSO read as a tap — or finishing a pull sends
    // you walking to whatever was under your finger, or re-arms the errand you
    // just spent. `drag.took` is that case and it is the FIRST branch below,
    // which is the whole of what the move was buying.
    //
    // The rule for the next thing a hold learns to do: if it happens, say
    // `done`; if the timer falls through it, the release is still a tap.
    // ...with one exception, and it is the press that grades finest: a lone
    // crate you are stood at still owes its release a tap until the ring fires
    // (`CRATE_HOLD_MS`). Marking it spent here is what left an unhurried click
    // doing nothing whatever — see that constant. The tap branch measures the
    // same clock and stands down once the lift has happened, so the two
    // outcomes still cannot both fire.
    if (drag.took) { drag.done = !drag.rummage; return; }

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
      drag.done = true;
      // The press now OWNS the pointer, and saying so is the difference between
      // carrying a lamp and spinning the shop while holding one. The button is
      // still down and the thing is in your hands, so every move from here is
      // aiming it — without this the drag falls through to `stepTurn` below and
      // the view tilts under a ghost that has also stopped tracking (`camBusy`),
      // which reads as the move having grabbed the camera as well.
      //
      // Deliberately NOT `drag.moving`: that one means "pulled out by a drag,
      // so let go and it lands", and this gesture's whole contract is that it
      // leaves the thing in your hands for a separate tap.
      drag.carried = true;
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
      // ...and `endPress` places where the ghost is rather than treating this as
      // a tap under the finger. `aimed` is read there before `tapped`, so this
      // is belt and braces — but the rule above is "say it where it happens".
      drag.done = true;
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

    // Nothing left for a hold to do here, so the press is still whatever its
    // release makes it — which for a mouse in build mode is the tap that lays
    // the thing. Returning WITHOUT `done` is the fix; see the note above.
    // (The press that named goods is handled first, at the top: a menu over a
    // draining board would be one gesture doing two things.)
    if (!HOLD_OPENS) return;
    drag.done = true;

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
  // BEFORE THE TURN, NOT AFTER IT. See `healLostPress`: this is the frame a
  // stuck spin would have rotated the shop in, and it is asked here as well as
  // on the window because a canvas press is answered here FIRST — the window's
  // copy catches the pointer while it is over a panel, and by the time it runs
  // for a move over the shop the view has already moved.
  if (healLostPress(e)) return;
  // THE MOUSE IS THE HEAD, and the turn itself is taken on `mousemove` rather
  // than here — see `grabLook`. What is left for this one is to get out of the
  // way: everything below is a gesture that moves the pointer somewhere, and
  // under the lock the pointer does not go anywhere. `clientX` is frozen, so a
  // drag reads as a press that never moved, the slop is never crossed, and the
  // camera branch turns the view by nothing on every event for as long as a
  // button is held.
  if (scene.crosshair) return;
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
  // Before every build drag, the way it took the press before every build drag:
  // this one moves nothing, so nothing underneath it should be previewing.
  if (marquee && e.pointerId === marquee.id) {
    marquee.x1 = e.clientX;
    marquee.y1 = e.clientY;
    showMarquee();
    return;
  }
  if (faceDrag && e.pointerId === faceDrag.id) {
    showFaceDrag(e.clientX, e.clientY);
    return;
  }
  if (edgeDrag && e.pointerId === edgeDrag.id) {
    showEdgeDrag(e.clientX, e.clientY);
    return;
  }
  if (beltDrag && e.pointerId === beltDrag.id) {
    showBeltDrag(e.clientX, e.clientY);
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
  //
  // ...unless a ring is already winding on this press, in which case the press
  // is not up for reinterpretation at all — see `ringHasPress`. Everything below
  // is the pan verdict, `release()` included, and that release is the half that
  // hurt: it is what threw away a pull you were part way through.
  if (drag.travel >= TAP_SLOP && !ringHasPress()) {
    clearLongPress();
    // Moved, so this press is a pan and never an action. Same verdict the tap
    // gets, and it has to be sent rather than merely remembered — the server is
    // the thing counting the ring up.
    release();
    // Past the slop with a fixture under where you started: this is a move, and
    // the camera never gets this drag at all.
    //
    // ...and only if the press DWELT first. A drag is also the gesture you make
    // to look round the shop, and in build mode the shop is wall to wall with
    // things you own — so a press that started anywhere near a shelf pulled the
    // shelf out instead of turning the view, which reads as the camera being
    // broken rather than as a move you never asked for.
    //
    // The dwell is what separates the two, and it separates them by the thing
    // that is actually different about them: a drag that means "look round"
    // starts moving straight away, and one that means "take this" starts with
    // you stopping on the thing first. So the gate is a clock rather than a
    // selection. It was the selection for a while — tap it, then drag it — and
    // that is a *second press* charged on every deliberate move to prevent an
    // accidental one, which is the wrong end of the trade: the accident is a
    // sweep, and a sweep has no pause in it.
    //
    // `MOVE_DWELL_MS` is well under the hold, so this stays a distinct gesture
    // from the one that lifts a fixture into your hands and leaves it there —
    // and the ring the press is already drawing (`setHoldProgress`) is the
    // dwell made visible, since it starts filling on the way down.
    //
    // The HOLD is untouched either way (see the `drag.lift` branch in the long
    // press): it cannot fire mid-turn, so it never needed a gate at all.
    // Cleared whatever happens — the press is a pan now, and a lift left armed
    // would fire on the release of a drag that has already spun the shop.
    if (drag.lift) {
      const f = drag.lift;
      drag.lift = null;
      if (performance.now() - drag.pressedAt >= MOVE_DWELL_MS) {
        drag.moving = true;
        liftAimed(f, { reopen: false });
        return;
      }
    }
    // ...and it does not get any of the rest of it either. `lift` is spent the
    // instant it fires, so without this the first move pulls the lamp out and
    // every move after it spins the shop underneath — which is the bug this
    // whole branch exists to fix, arriving one event later.
    //
    // `carried` is the same claim about the press that lifted by HOLDING rather
    // than by pulling. It is the one that actually bit: a hold fires at 420ms
    // and the thing is then in your hands with the button still down, so the
    // rest of that drag went straight to the camera and you tilted the shop
    // while carrying a lamp.
    if (drag.moving || drag.carried) return;
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
      // left, which reads as the scroll being backwards. A mouse reaches this
      // too now (`drag.turns` is false while building), which is the point: in
      // the mode where the pointer is doing the building, the one gesture both
      // devices share should do the one thing the camera is there for.
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
  // First, and it returns: a marquee is the whole press. Everything below is a
  // build verb, and this one is the press that decided which things the next
  // build verb is about.
  if (marquee && (!e || e.pointerId === marquee.id)) {
    if (e) endMarquee(e);
    else { marquee = null; showMarquee(); }
    return;
  }
  if (edgeDrag && (!e || e.pointerId === edgeDrag.id)) {
    const drawn = e ? showEdgeDrag(e.clientX, e.clientY) : null;
    const kind = edgeDrag.kind;
    edgeDrag = null;
    scene.setEdgeGhost(null, null);
    ui.setBuildVerdict(null);
    clickLog('up: edge drag ending', {
      hadEvent: !!e, type: e?.type ?? null, segs: drawn?.segs.length ?? null,
      to: drawn?.to ?? null, verdict: drawn?.verdict ?? null,
    });
    if (drawn) {
      // ...and the press keeps what the ghost promised: a tool up builds, and
      // opening what is already there is the tap with no tool up. See the
      // paragraph on the ghost in `refreshGhost` for why the two moved together
      // — an amber bar that opened a menu was the honest half of a rule that
      // could not tell "the same window" from "a different window".
      if (!drawn.verdict.ok) { ui.toast(drawn.verdict.reason, true); return; }
      if (drawn.verdict.warn) ui.toast(drawn.verdict.warn);
      // Two ends and a kind, never the list — a long wall would blow past the
      // 4KB inbound cap, and one message is also one re-flow. The far end goes
      // over as the pointer's own index, unclamped: the server runs the same
      // `edgeRun` against the same maximum and trims it to the same segments,
      // so reading it back off the list could only ever disagree — and did, in
      // one direction, for every drag towards a lower x or z.
      //
      // The run's own start, never the edge the press snapped to: since the axis
      // is the pointer's, a drag that turned has a start on a line the press
      // never named.
      net.send('build-edge', {
        o: drawn.spec.o, x: drawn.spec.x, z: drawn.spec.z, kind, to: drawn.to,
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
  if (beltDrag && (!e || e.pointerId === beltDrag.id)) {
    const drawn = e ? showBeltDrag(e.clientX, e.clientY) : null;
    const { start, kind, piece, station, variant } = beltDrag;
    beltDrag = null;
    scene.setFloorGhost(null, null);
    scene.setRunGhost(null, null, null);
    ui.setBuildVerdict(null);
    if (drawn) {
      if (!drawn.ok) { ui.toast('nothing can go along there', true); return; }
      const to = drawn.to ? { x: drawn.to.x, z: drawn.to.z } : null;
      // The armed rotation goes with it — see `runCells`. A drag says which
      // way every cell but the last one faces; R says the rest, and for a press
      // that never travelled it says all of it.
      // `variant` goes too, and never did until the preview started drawing the
      // real art. `buildRun` has always taken one and nothing has ever sent it,
      // which was invisible while the ghost was a square: arm the corner belt,
      // watch a square, get the straight one. A preview that draws the shape has
      // to be a preview of the shape that gets built.
      net.send('build-run', {
        kind, piece, station, variant, x: start.x, z: start.z, to,
        rot: ui.buildRot, deck: ui.buildDeck,
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
    clickLog('up: floor drag ending', {
      hadEvent: !!e, cells: drawn?.cells.length ?? null, to: drawn?.to ?? null,
      verdict: drawn?.verdict ?? null,
    });
    if (drawn) {
      if (!drawn.verdict.ok) { ui.toast(drawn.verdict.reason, true); return; }
      if (drawn.verdict.warn) ui.toast(drawn.verdict.warn);
      // Two corners and a piece, never the list. Same cap, same reasoning as a
      // wall run — a full-size stroke is 256 cells — and one message is also
      // one re-flow rather than 256 of them. The far corner goes over unclamped:
      // the server runs the same `groundStroke` and trims it to the same
      // rectangle, so clamping twice could only ever disagree.
      const to = drawn.to ? { x: drawn.to.x, z: drawn.to.z } : null;
      clickLog('SEND build-ground', { from: `${start.x},${start.z}`, to: to && `${to.x},${to.z}`, piece });
      net.send('build-ground', { x: start.x, z: start.z, piece, to });
    }
    return;
  }
  if (drag.id === null || (e && e.pointerId !== drag.id)) return;
  // A press that never really moved is a tap, not a pan — and a long press has
  // already spent the gesture, so its release means nothing.
  const tapped = e && !drag.done && drag.travel < TAP_SLOP;
  const dropping = drag.moving && !!e;
  clickLog('up: generic press ending', {
    tapped, dropping, done: drag.done, travel: Math.round(drag.travel),
    heldMs: Math.round(performance.now() - drag.pressedAt),
  });
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
  const { turned, put, at } = spin;
  cancelTrek(spin);
  spin = null;
  // Always, whether or not this press armed anything: the button is up, and a
  // `pressing` bit left set is a ring that goes on winding with nothing down.
  release();
  return { turned, put, held: performance.now() - at >= LONG_PRESS_MS };
}
canvas.addEventListener('pointerup', (e) => {
  clickLog('canvas pointerup', { btn: e.button, buttons: e.buttons, ptr: e.pointerType });
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
/**
 * EVERY GESTURE IN FLIGHT, ABANDONED — for the two things that happen TO you.
 *
 * Every other way a press ends is the player ending it: a release, a cancel, a
 * second finger, a right-button abort. These two are not. The window losing
 * focus never sends the pointerup at all, and an award card takes the screen on
 * the shop's own clock — so in both, a gesture is left mid-air with no event
 * coming that would close it.
 *
 * Nothing here is chosen for the award; it is the blur teardown, which was
 * already exactly this list, given a name and a second caller. That is the
 * argument for sharing it rather than writing a shorter version at the card:
 * every one of these is a way for a press to get stuck, and a second list would
 * be the one that goes out of date the day a sixth gesture is added.
 *
 * `endPress` is called with **no event**, deliberately, which is what makes it
 * abandon a half-drawn wall rather than build it. That is the right answer for
 * both callers and it is sharper for the card: the pointer's next journey is
 * across the screen to a green button, and committing a run to wherever it
 * happened to end is a wall you did not draw.
 */
function dropGesture(why = 'unknown') {
  clickLog('ABANDON gesture', { why, live: !!(floorDrag || edgeDrag || faceDrag || beltDrag || marquee) });
  touches.clear();
  pinch = null;
  // `release` first and on its own, because it is the one that is not local:
  // without it the button stays DOWN as far as the server is concerned and the
  // ring keeps winding on whatever you were last pointing at. `endDrag` below
  // reaches it again on the ordinary paths; this covers the ones with no event.
  release();
  endSpin();
  endPress();
  endDrag();
}

addEventListener('blur', () => dropGesture('window blur'));

/**
 * IS A PRESS WITH THIS POINTER'S ID STILL IN FLIGHT?
 *
 * Every drag in here is keyed by the id of the press that started it, so the
 * question has an id in it rather than being "is anything happening": a second
 * finger coming off a HUD button is not the first one letting go of the shop,
 * and `dropGesture` abandons *everything* — asked without the id it would be
 * the tidy-up that throws away the drag it was called about.
 *
 * `pinch` and `touches` are deliberately not in the list. They are the one
 * gesture with no press behind it (two fingers, neither of which owns it), and
 * they have `pointercancel` — which fires reliably on a touchscreen and is
 * exactly the event the cases below are missing.
 */
function gestureId(id) {
  return spin?.id === id
    || drag.id === id
    || edgeDrag?.id === id
    || faceDrag?.id === id
    || beltDrag?.id === id
    || floorDrag?.id === id
    || marquee?.id === id;
}

/**
 * THE RELEASE THAT NEVER ARRIVED.
 *
 * `dropGesture` is the answer to the two ways a press ends without an event;
 * this is the answer to the third, which is worse because it has no cause you
 * can enumerate: the pointerup happened and *we never saw it*. Capture is what
 * normally guarantees we do — every gesture in `pointerdown` takes it — and
 * capture is released out from under you by things that are none of the game's
 * business: an element under the pointer going away, a native menu, the OS
 * taking the button, a browser deciding a gesture is its own.
 *
 * What that leaves is the worst failure this file has, because it is silent and
 * it is *permanent*. `spin` stays set, a mouse reuses one pointerId for its
 * whole life, and so the very next `pointermove` over the canvas turns the shop
 * with nothing held down — the view spinning as you reach for a menu, for the
 * rest of the session. There is no press left to end it and no error anywhere,
 * and what it reads as is the camera having broken.
 *
 * So it is repaired from the state instead of from a list of causes: **a mouse
 * with no buttons down has no press in flight**, whatever became of the up.
 * Asked on the move, which is both the first thing that happens afterwards and
 * the thing the symptom is made of, so the heal lands before a single pixel of
 * turn does.
 *
 * Touch is exempt and has to be: a finger reports `buttons` 1 only while it is
 * on the glass, which is the only time it sends moves at all, so there is
 * nothing here for it to answer — and the browser cancels touch gestures
 * properly. A pen hovers at `buttons` 0 all day and is covered by the id test
 * above, which is false for a hover.
 */
let limping = null;

function healLostPress(e) {
  if (e.buttons !== 0 || e.pointerType === 'touch') { limping = null; return false; }
  if (!gestureId(e.pointerId)) { limping = null; return false; }
  // ONE SUCH EVENT IS NOT A LOST PRESS — IT IS USUALLY A RELEASE IN FLIGHT.
  //
  // "No buttons down" was read as "the up never arrived", and that is true of
  // the state a second later and false of the instant it starts: letting go
  // dispatches a `pointermove` at buttons 0 *before* the `pointerup` on a good
  // third of drags, so the heal fired between the two and `dropGesture` threw
  // away a run that was one event from being built — with the pointerup then
  // arriving to find nothing left. What that looks like is a floor drag you
  // drew, watched go green and let go of, which simply never happened.
  //
  // So it takes TWO. A press whose up was genuinely lost goes on sending moves
  // at buttons 0 for as long as the hand keeps moving, and the second lands a
  // few milliseconds later — while a release in flight has been dispatched by
  // then and has cleared the gesture above. The symptom the heal exists for is
  // the shop turning as you move the mouse, so healing on the second move of
  // that turn rather than the first costs nothing anybody can see.
  //
  // Compared by IDENTITY and not by count: one physical move is handed to this
  // twice — the canvas's `pointermove` and the window's — so counting events
  // would make every first move its own second one.
  if (limping === null || limping === e) { limping = e; return false; }
  limping = null;
  dropGesture(`healLostPress on ${e.type} (buttons=0, type=${e.pointerType})`);
  return true;
}

/**
 * ...and the same repair off the events that DID arrive, somewhere else.
 *
 * On the window, so a release over a panel — the half of the screen the canvas
 * cannot see, and the one your hand crosses on the way to a menu — closes the
 * press it belongs to. Canvas presses bubble through here too and find their
 * gesture already ended, which is the guard doing its job rather than a race:
 * the target's own handler has run by the time this one does.
 *
 * `lostpointercapture` is the same claim made one step earlier: it is the moment
 * the canvas stops being told anything, and therefore the last moment a gesture
 * can be ended honestly.
 *
 * IT DOES NOT FIRE AFTER THE POINTERUP, WHICH IS WHAT THIS USED TO ASSUME.
 * Chrome dispatches it *before* the release on an ordinary click — measured, on
 * roughly a third of drags — so a run that was one event away from being built
 * was abandoned instead, and the pointerup then arrived to find nothing left to
 * commit. `endPress()` is called with no event by `dropGesture`, on purpose, so
 * what that looks like is a floor drag you drew, watched go green, let go of,
 * and which simply never happened. No refusal, no toast, nothing in the log.
 *
 * So the button state is the test, and it is `healLostPress`'s own rule read the
 * other way round: **no buttons down means the release has happened**, and a
 * release is the ordinary path's to answer — either the canvas's own pointerup
 * (which commits) or the window's, one line above (which does not, because the
 * press ended somewhere the canvas cannot see). Capture lost with the button
 * still DOWN is the case this is actually for — a native menu, the OS taking the
 * button, the browser claiming the gesture — and there no up is coming at all.
 *
 * Only for `lostpointercapture`: on a real `pointerup`/`pointercancel` the
 * buttons are always 0, and skipping those is skipping the whole listener.
 */
const letGoElsewhere = (e) => {
  if (!gestureId(e.pointerId)) return;
  if (e.type === 'lostpointercapture' && e.buttons === 0) return;
  dropGesture(`letGoElsewhere on ${e.type} over <${e.target?.tagName ?? '?'}> buttons=${e.buttons} ptr=${e.pointerType}`);
};
addEventListener('pointerup', letGoElsewhere);
addEventListener('pointercancel', letGoElsewhere);
canvas.addEventListener('lostpointercapture', letGoElsewhere);

// A tab going to the background is a blur on every browser that matters and
// this on all of them. Same teardown, second door: the one thing worse than a
// gesture stuck under an alt-tab is one stuck under an alt-tab that did not
// happen to fire the event we were relying on. The keys go with it for the same
// reason they go on the blur — a held W whose keyup landed in another tab is
// the same stuck press one input along, and it walks you across the shop.
addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  dropGesture('tab hidden');
  keys.clear();
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
/** Your own record out of the latest snapshot. One spelling, several readers. */
const myState = () => latestState?.players?.find((p) => p.id === net.myId) ?? null;

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
 * WOULD ONE MORE OF THIS FIT IN YOUR HANDS?
 *
 * `Game.tapCrate` and `Game.unload` both decide this with `lotRoom` against
 * `carryLot`, and both answer a press that has already been made — which is
 * what a greyed row exists to stop being the way you find out. So this is the
 * same call with the same numbers: the cap rides on the snapshot (`carryCap`,
 * because a rucksack moves it) and the KIND cap is `lotRoom`'s own default,
 * which is `LOT_KINDS` — the same constant `CARRY_KINDS` is. Nothing here is a
 * second opinion about the rule; only about when it is asked.
 *
 * A cap we have not been sent answers "yes", deliberately: that is an old
 * server or a frame that has not landed, and the failure direction has to be
 * the button we already had rather than a shop that greys out everything.
 */
function handRoom(itemId) {
  const cap = myState()?.carryCap;
  if (!(cap > 0) || !itemId) return Infinity;
  return lotRoom(myCarry(), itemId, { cap });
}

/**
 * ...and the two different noes, in the shop's own words.
 *
 * `tapCrate` says these, and they want opposite things from you: full hands are
 * "put something down", a full third KIND is "put something down *of the right
 * thing*". A single "hands full" over an armful with room in it reads as the
 * button being broken.
 */
function noRoomWhy(itemId) {
  const cap = myState()?.carryCap ?? 0;
  return lotTotal(myCarry()) >= cap
    ? 'Your hands are full — put something down first'
    : `No free hand for ${ui.itemName(itemId)} — put something down first`;
}

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
 * ...and the fifth drag that is not the camera's: the one WINDING A RING.
 *
 * `drag.aiming`, `drag.moving` and `drag.carried` are all the same sentence —
 * this press is doing something, so the shop must hold still underneath it —
 * and a held press on a crate or a board is the one that was left out. It is
 * also the one people make most: half a second is long enough for a hand to
 * wander seven pixels, so a pull that was already a third of the way in threw
 * its charge away and spun the view instead. Nothing says a word, the box you
 * were emptying is still there, and what it reads as is the hold not working —
 * intermittently, which is the worst way for it to read.
 *
 * Both halves, and neither alone is the test. `drag.took` is what makes it a
 * question about the POINTER: the press named a crate or a pile on the way down
 * (see the arming block in `pointerdown`), so this drag belongs to that press
 * rather than to the view. `charging()` is what keeps it from being a tax on
 * every other press — the server is the only thing that knows a ring has
 * actually started, so a press on a crate across the shop (which walks, and
 * charges nothing until you arrive) still gives its drag to the camera, and so
 * does a press that happened to be made while a shopper was at the till.
 *
 * The camera is skipped rather than the whole branch, so `lx`/`ly` still track:
 * the ring ends when the action fires, and a pan that resumed against an anchor
 * from half a second ago would leap the whole drag in one frame.
 */
const ringHasPress = () => drag.took && charging();

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

/** How many of that item are actually standing on that unit, right now. */
const boardQty = (f, board) => (f && board
  ? shelfById(f.id)?.stacks?.find((k) => k.item_id === board)?.qty ?? 0
  : 0);

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
  if (f.kind === 'pen') return (latestState?.pens?.find((p) => p.id === f.id)?.qty ?? 0) > 0;
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

/**
 * The thing the last tap named, which is the pill's whole subject on a phone.
 *
 * Ids and not records, because a re-flow re-mints every fixture and a crate can
 * be lifted out from under you — so this is re-resolved every time it is read
 * (`tappedAim`) and answers null the moment what it names stops existing. Same
 * rule `setFixtureRef` and `liveBoard` already keep.
 *
 * Set in ONE place, by the same two picks the tap itself uses, so the pill can
 * never be about something other than what the press landed on. That was the
 * whole bug: the pill was derived from the pointer on every snapshot, so a tap
 * and the tick after it were two different opinions about one press.
 */
let tapped = {
  crate: null, fixture: null, board: null,
  // ...and `ground` starts FALSE, which is not the same as "named nothing".
  // Before the first tap of a session nobody has pointed at anything, and a
  // green square lit on the floor under you then is the shop offering to put
  // your crate down because you have not yet said otherwise. It is also what
  // flashed on the first press at a shelf: the tap had not been recorded yet, so
  // for one frame the answer was "no fixture", which read as "the floor".
  ground: false,
};

function noteTap(cx, cy) {
  const crate = ui.demolishArmed() ? null : aimCrate(cx, cy);
  const hit = pickAimed(cx, cy);
  // Same precedence the tap itself reads them in — a crate at the bay can sit on
  // the same screen space as the shelving behind it, and the crate is in front.
  if (crate && (!hit || crate.dist <= hit.dist)) tapped = { crate: crate.id, fixture: null, board: null, ground: false };
  else if (hit?.f) tapped = { crate: null, fixture: hit.f.id, board: hit.board ?? null, ground: false };
  // Nothing there: the tap named the FLOOR, which is its own answer rather than
  // the absence of one. It is what arms the green square — see `drop`.
  else tapped = { crate: null, fixture: null, board: null, ground: true };
}

/** ...resolved against the shop as it is now, in `pickAim`'s own shape. */
function tappedAim() {
  if (tapped.crate) {
    const c = (ui.state?.deliveries ?? []).find((d) => d.id === tapped.crate);
    if (c) {
      const x = Math.round(c.x);
      const z = Math.round(c.z);
      const pile = (ui.state?.deliveries ?? []).filter((d) => Math.round(d.x) === x && Math.round(d.z) === z);
      return { crate: { ...c, stacked: pile.length > 1 }, fixture: null, board: null };
    }
    tapped = { crate: null, fixture: null, board: null, ground: false };
    return null;
  }
  const f = tapped.fixture ? scene.fixtureById(tapped.fixture) : null;
  if (!f) return null;
  // The pile only survives while it is still on that unit — a board that sells
  // out takes its own rows with it rather than offering a press that would miss.
  const board = tapped.board
    && shelfById(f.id)?.stacks?.some((k) => k.item_id === tapped.board) ? tapped.board : null;
  return { crate: null, fixture: f, board };
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
  // The raw pick, NOT `aimCrate` — see its header. This is the one caller asking
  // whether a box is in the LINE OF SIGHT rather than whether it is a target,
  // and `aimCrate` answers null throughout build mode, which is precisely when
  // this function runs. Asking it here would offer a doorway through a stack of
  // crates on every press.
  if (scene.pickPallet(cx, cy)) return null;
  // The wall's own surface where the ray met one, and the lattice guess where it
  // did not — `pickFaceHit`'s split, and it matters here for the reason it
  // matters to the paint brush: a wall pointed at in ELEVATION puts `pickEdge`'s
  // ground hit a line or more behind it, so a menu opened off the guess is the
  // menu for the wall next door. The side comes back with it and is dropped —
  // an opening has one menu, whichever face you were looking at.
  const face = scene.pickFaceHit(cx, cy)?.face ?? null;
  const seg = face ? { o: face.o, x: face.x, z: face.z } : null;
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
/**
 * ...and **a stopped clock is the fourth**, which is the only one of the four
 * that is not about what you are holding.
 *
 * A pile is a target because a press on it takes stock off it, and while the
 * world is held there is no such press: the pill has no rows (`pressHints`) and
 * the ring cannot wind. So what was left of board aiming in a paused shop was
 * the *pointing* — a cage round the bread and a card naming it, a highlight
 * whose whole meaning is "press here", over a shop that will not answer. That is
 * the green-ghost bug with the world stopped: the shop advertising a press it
 * has no way to make good on.
 *
 * The unit is untouched and that is the line: selecting a shelf, opening its
 * menu, reading what is on it and what it costs are all things a paused shop
 * does perfectly well, and they are most of what stopping the clock is for. What
 * goes is naming one pile *on* it, because naming a pile is the first half of
 * taking from it and there is no second half.
 */
const boardTakes = () => !ui.paletteArmed && !ui.holding && !ui.demolishArmed() && !ui.paused;

/**
 * ...and **what is in your hands closes the other piles**, which is the one
 * clause here that is about a particular board rather than about the gesture.
 *
 * Everything above is a mode: the bar is up, the bulldozer is armed, the clock is
 * stopped. This is the shelf itself. A stocked unit is three piles a few pixels
 * apart and every one of them was nameable whatever you were holding — which is
 * right for the empty-handed shopkeeper walking an aisle reading the shop, and
 * exactly wrong for the one carrying six tomatoes looking for somewhere to put
 * them. There the only question is *which unit*, and the answer was being drawn
 * over by somebody else's bread: the cage rests on the pile, the pill's rows are
 * about the pile, and the shelf you are actually aiming at is the thing behind
 * all of it. A pick made before you picked the goods up is worse again, because
 * it does not even move with the pointer — a teal box parked on the lettuce for
 * the whole walk across the shop.
 *
 * So while you are holding stock a pile is a target only if it is stock you are
 * holding, which is the *one* pile that has anything to say in that moment: it is
 * "top this one up", and it is the board the goods would land on. Every other
 * pile falls back to the unit, and the unit is what a full pair of hands means.
 *
 * **What it costs is plucking one of something else**, and that is worth being
 * honest about: `boardTakes` deliberately dropped full hands as an exclusion when
 * the direction moved onto the button, so that walking round taking one or two of
 * each would work. It still does with your hands empty, and one item deep with
 * your hands full — what is gone is a left-tap on the lettuce while carrying
 * tomatoes, which is the unit's own menu now. The trade is that the marker in the
 * shop is once again about the press you are actually making.
 *
 * Both hands and shoulder, the same union `takers` is built from: a crate of
 * tomatoes on your back is goods looking for a home as much as an armful is.
 */
const inMyHands = (itemId) => [myCarry(), myHaul()]
  .filter(Boolean)
  .some((lot) => lotStacks(lot).some((s) => s.item_id === itemId));

/** ...and empty-handed the rule is off, which is every press that reads a shop. */
const boardInHands = (itemId) => !handsFull() || inMyHands(itemId);

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
 * ...and it is ZERO where the pill drives, which is the whole of the touch fix.
 *
 * A dwell is a hover with a clock on it, and a touchscreen has neither half. The
 * pointer is the last place a finger LANDED, so the clock starts on a tap that
 * is already over: the board ripens a quarter of a second afterwards, with the
 * hand long gone. So a stocked unit's rows went "Open it", then "Take one /
 * Crate the lot / Open it", then back, about once a second, for as long as you
 * looked at it — buttons appearing and disappearing under a thumb that has not
 * moved. That is the cycling, and it is one number.
 *
 * Zero rather than switched off, and the difference is the bug I put in trying
 * the other way. `ripeBoard` is what a press asks, and it answers "picked
 * already, or ripe" — so a dwell that can never ripen means a tap can never pick,
 * and a tap that can never pick means nothing is ever picked. First tap named
 * nothing, and so did every tap after it: a stocked shelf with no way to take
 * anything off it. Ripening instantly closes that loop rather than cutting it —
 * the tap names the board, `pickBoard` writes it to `pick`, and `pick` has no
 * deadline, so nothing has a clock on it from that moment on.
 *
 * What the delay is FOR is a pointer sweeping across an aisle on its way
 * somewhere else, which is a thing that only happens when there is a pointer
 * between presses. There isn't one here.
 */
const dwellFor = () => (pillDrives() ? 0 : BOARD_DWELL_MS);

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
 * THERE IS NO EXIT DWELL, and the deleted one is worth a paragraph.
 *
 * Leaving used to be delayed the way arriving is — `BOARD_STICK_MS`, 700ms of
 * grace after the ray stopped meeting the pile — on the argument that the ray
 * misses for reasons that have nothing to do with what you meant: piles are a
 * few pixels apart at 45°, the gaps between them are real gaps, and the goods
 * re-weld on every sale so the group under the pointer stops existing for a
 * frame ten times a second.
 *
 * All of that is true and none of it survived the pile becoming something you
 * PRESS. A grace period is a guess about a hand that has moved on, and a guess
 * that outlives the pointer is exactly the failure it was meant to hide: what
 * it bought was a flicker fixed, and what it cost was a stock card naming a
 * shelf across the shop, following the pointer over bare floor, taken down by
 * nothing — because the only thing that ever took it down was the pointer
 * arriving somewhere else, and half the shop is nowhere in particular.
 *
 * `pick` is the answer the stick was standing in for. A press says which pile
 * as plainly as anything in the game, it has no deadline, and it is dropped by
 * things a player does on purpose. So the marker rests on what you pressed and
 * the cage follows what you are pointing at — one clock (the arriving dwell),
 * on the pointer, where the pointer is.
 */

/**
 * THE PILE YOU ACTUALLY PRESSED, which stays pressed until you say otherwise.
 *
 * The dwell is a guess about where your hand is going, and a guess has to
 * expire — which is why the exit half of it is gone. A press is not a guess:
 * pointing at the bread and taking a loaf says which pile you work out of as
 * plainly as
 * anything in the game, so from that moment the shop can simply *know* it and
 * stop asking. That is what makes the whole gesture cheap — the second loaf,
 * and the third, cost no dwell and no aim at all, because the pile is still the
 * one you named.
 *
 * Set by both buttons, because both are a sentence about that pile: a tap takes
 * one out, a right-tap puts one back, and neither is a question about which.
 *
 * Released by Escape (`ui.escape`, through `dropBoardPick`), by the pile ceasing
 * to exist, and by any press that is not about it (`dropStalePick`) — a
 * different pile, the unit's own frame, a crate, a hire, a doorway, bare floor.
 *
 * That last one used to read "a different pile, and nothing else", and the word
 * to keep is **press**: pointing somewhere else still does not take it away, and
 * that is the whole of what makes the second loaf and the third cost no aim —
 * the aim marker on the thing you ARE pointing at simply wins the frame, the
 * same way a picked fixture behaves. What "nothing else" cost is that the only
 * way to put a pile down was a key nothing on screen mentions, so a cage and a
 * stock card sat on a unit across the shop long after you had finished with it.
 */
let pick = { id: null, board: null };

/** A press landed on a pile: that is the one, until something says otherwise. */
function pickBoard(f, board) {
  if (f && board) pick = { id: f.id, board };
}

/**
 * ...and "something says otherwise" is any press that is not about that pile.
 *
 * This is the third of the three ways a desktop has to let go of a pick, and it
 * was DOCUMENTED rather than written: `dropOnLeaving` says overhead that the
 * desktop already has "Escape, a click on bare floor, or a press on something
 * else", and the floor branch of `tapAtPointer` only ever dropped the fixture
 * selection. So the list was really Escape and a different pile — and a pile is
 * a few pixels of a shelf, which is not a thing anybody presses on purpose to
 * cancel something. What that leaves is a cage and a stock card on a unit across
 * the shop, hours after you took a loaf off it, with the only way out a key
 * nothing on screen mentions.
 *
 * It is a press and never a MOVE, which is the distinction the whole gesture
 * rests on: pointing somewhere else does not drop a pick (that is what makes the
 * second loaf and the third cost no aim), and pressing somewhere else does. The
 * marker rules are untouched — what changes is only how long the decision lives.
 *
 * Asked with the pointer rather than off the branch that fired, because every
 * branch of `tapAtPointer` past the tool check is "clicking off it" and listing
 * them here would be a second copy of that precedence, drifting. `pickAimed` is
 * the same call the press itself makes a few lines later, so the two can never
 * disagree about what was under the pointer; the extra raycast only happens when
 * there is a pick to spend it on.
 */
function dropStalePick(cx, cy) {
  if (!pick.id) return;
  const still = pickAimed(cx, cy);
  // The unit AND the pile. Pressing the frame, the base or an end panel of the
  // very shelf whose bread is picked is a press about the unit — it opens the
  // menu — so the pile stops being the subject there as much as anywhere else.
  if (still?.f?.id === pick.id && still.board === pick.board) return;
  ui.dropBoardPick();
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
  been.fixture = step(ui.fixtureRef?.id ?? null, been.fixture, () => {
    ui.setFixtureRef(null);
    // ...and what the pill is about goes with it, or you walk away from a unit
    // and its rows follow you across the shop. One subject, dropped once.
    if (tapped.fixture) tapped = { crate: null, fixture: null, board: null, ground: false };
  });
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
      timer: key ? setTimeout(() => { dwell.timer = null; refreshGhost(true); }, dwellFor()) : null,
    };
  }
  return ripeBoard(f, board);
}

/**
 * The pile the pointer is on. Only ever that.
 *
 * This used to answer with the picked pile too, whenever the pointer was over
 * nothing at all, because the amber cage was the only marker a pick had — so
 * "which pile am I working out of" could only be shown by borrowing the marker
 * that means "what a press would land on". Over bare floor a press does not land
 * on a board at all, so the borrowed cage was the green-ghost bug wearing a
 * marker, and the pill listed rows about a shelf across the shop.
 *
 * `setPickedBoard` is what the borrowing was standing in for — a teal cage of
 * its own, on all the time, said about a decision instead of about a press. With
 * that up, the amber gets to be honest again and this collapses to the pointer.
 *
 * The picked pile is still cheaper to point at than any other, and that is
 * `ripeBoard`'s clause rather than this one: naming a pile is paid for once, so
 * going back to it costs no dwell.
 */
function heldBoard(aim) {
  const board = settledBoard(aim?.fixture ?? null, aim?.board ?? null);
  return board ? { f: aim.fixture, board } : null;
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
  // Above the pick, and that is the point of putting it here rather than in the
  // hover: a pile named before you picked the goods up is exactly the one that
  // sits there through the whole walk. `boardInHands` is off with empty hands, so
  // nothing below this line has changed for anybody reading a shop.
  if (!boardInHands(board)) return null;
  // A picked pile needs no dwell — naming one is paid for once, so the second
  // loaf and the third cost no holding still. It does NOT close the other piles
  // though, and that is deliberate: you walk an aisle with a board selected and
  // want to see what the next unit is holding, so every other pile goes on
  // ripening the ordinary way and a PRESS is what moves the selection. The pick
  // is where the marker rests, not a lock on the pointer.
  if (pick.id === f.id && pick.board === board) return board;
  // Where the pill drives, a named board is already a deliberate one.
  //
  // The dwell below is a filter on a POINTER: it exists so that sweeping across
  // an aisle does not name every pile on the way, and its whole premise is that
  // the aim moves without anybody deciding anything. On a phone the aim only
  // ever comes from `noteTap` — a press that landed on that pile — so there is
  // nothing to filter, and asking for a dwell on top means asking a finger to
  // hold still on a target it has already left.
  //
  // This is also the gate the board ROWS are behind, which is why leaving it out
  // read as "I can't pick individual items off a shelf any more": the tap named
  // the bread perfectly well and every reader after it refused to believe the
  // name, because no clock had ticked.
  if (pillDrives()) return board;
  if (dwell.key !== `${f.id}:${board}`) return null;
  return performance.now() - dwell.at >= dwellFor() ? board : null;
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
  // Carrying a fixture and the bulldozer are both a press with its subject
  // already decided — the hint line above the bar is what says so, because
  // neither is a question about what the pointer is on.
  if (ui.holding || ui.demolishArmed()) return [];
  // ...and a stopped clock is the fourth — except that it is not, and it was
  // one for as long as this pill has existed.
  //
  // Half of it is right and is the half `walkRow` and the `hold` line in `add`
  // now carry: a walk has legs and a hold is a ring, both are spent in
  // `stepActions`, and neither can happen while the world is held — so "Set the
  // crate down here" over a paused shop is a button that takes the press, lights
  // up, fills nothing and hands back a shop that has not moved, which is exactly
  // what a game that has crashed looks like.
  //
  // The other half was a rule the sim does not have, and `ShopRoom.frozen` says
  // so in its own words: *a tap that takes one unit off a board, a build, an
  // order, opening a menu — all of those are one immediate mutation and all of
  // them still work stopped, which is most of what looking round a paused shop
  // is for.* Every one of those has a row here, and the blanket veto took the
  // lot: pause to lay out an aisle — which is what a pause is FOR — and the one
  // surface naming what you are pointing at and what R and M would do to it goes
  // dark, in the mode built to be used with the clock held.
  //
  // So the veto is per ROW and it is the press's own fact rather than a list of
  // words: a walk says so at the site (there are eight, and each is the only
  // place that knows it is a walk), and a ring says so by being tagged `hold`.
  // Everything else — Select, Open, Move, Turn, and the single-unit taps that go
  // straight to `crate-one`/`shelf-one`/`station-one` — is legal stopped and now
  // says it is.
  //
  // What is left when a target has nothing but walks and rings is a card with a
  // NAME in it and no rows, which `setPressHints` draws only while the clock is
  // held. Gone rather than greyed, the way the three above are: a disabled row
  // is still a row you read, and the reason is not lost — press anything anyway
  // and the shop says so (`ShopRoom.frozen`), at the moment you wanted a
  // sentence rather than as a caption you have been scrolling past all along.
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
  //
  // A ROW THAT CANNOT FIRE IS STILL A ROW, which is the one thing this list did
  // not have a shape for. Its rule has always been "offer nothing you cannot
  // do", and that is right about a press whose target is somewhere else — a
  // shelf that will not take these goods is not a thing you got wrong, and the
  // shop says so by not lighting it. It is wrong about a press whose target is
  // exactly what you are pointing at and whose only problem is YOU: hands full
  // at a crate dropped Take one off the list, so the four buttons became two,
  // the grid reflowed under your thumb, and what is left on screen says nothing
  // about why. The refusal was one press away the whole time — you make it, and
  // the shop answers "hands full" in a toast.
  //
  // So `off` keeps the row, greys it, and hands that same sentence to whoever
  // presses it anyway. It is deliberately not the same thing as dropping a row:
  // use it where the button belongs to this target and the state is the veto,
  // and go on dropping rows that are about a press this target does not offer
  // at all. `pillDrives` is worth checking before adding one where there was no
  // row before — on a desktop this pill is a caption naming which mouse button
  // does what, and a caption for a press that does nothing is noise there.
  const add = (btn, tag, say, run = null, off = null) => {
    // A RING IS THE WORLD RUNNING, so a held row goes with the clock. Every
    // `hold` in this function ends in `place`, `take` or `walk-to` — the three
    // verbs `ShopRoom.frozen` guards — and it is the one kind of press whose
    // failure is invisible: the row takes the press, `pillPress` sends the
    // errand, and nothing winds it. `hold-drag` is deliberately not this: that
    // one is `build-lift`, which is a purchase and works stopped.
    if (ui.paused && tag === 'hold') return;
    const twin = out.find((h) => h.say === say && h.tag === tag
      && h.btn !== btn && (h.off ?? null) === off);
    if (twin) { twin.btn = 'lr'; return; }
    if (out.length < 4) out.push({ btn, tag, say, run, off });
  };
  /**
   * ...and the same for a row whose press is a JOURNEY.
   *
   * A walk cannot say so by its tag the way a ring can — `Go to it`, `Take it
   * there` and `Harvest it` are a plain left press, a plain right press and a
   * proximity job, and the only thing they have in common is `walk-to`. So it
   * is said at the site, which is this function's own rule for `run`: the site
   * is the one place that already knows which press this sentence is about, and
   * a lookup from the words back to a call would be the second opinion the whole
   * of `pressHints` is written not to be.
   */
  const walkRow = (btn, tag, say, run = null, off = null) => {
    if (ui.paused) return;
    add(btn, tag, say, run, off);
  };
  const carry = myCarry();
  const haul = myHaul();
  const crate = aim?.crate ?? null;
  // ...AND WHICH THING THE ROWS ARE ABOUT, which the pill has never said.
  //
  // Every row here is a verb with no subject — "Open it", "Turn it", "Take it
  // there" — and the only thing naming the *it* was the build bar's own hint
  // line, which is gated on the mode being on and on the pointer being over
  // something (`buildHintText`). So out of build mode nothing named it at all,
  // and in build mode it went the moment you looked away. What the shop draws
  // instead is a ring, and a ring tells you WHERE the thing is, not what it is:
  // three conveyor cells, a plot and a loader all ring identically.
  //
  // The pointer first and the selection second, which is the same order the
  // rows below are decided in — so the name and the rows can never be about two
  // different units. Only a fixture: a crate says what is in it on the box
  // itself and a square is not a thing with a name.
  //
  // In here rather than at the call site, and that is what the two `return []`s
  // above buy: a carried fixture and an armed bulldozer are a press whose
  // subject is already decided and said above the bar, so neither should grow a
  // second caption naming it — and they cannot, because they leave before this
  // line. Since a rowless card is drawn while the clock is held
  // (`setPressHints`), a name computed outside would have turned both of them
  // into one.
  const named = crate || onPile
    ? null
    : aim?.fixture ?? scene.fixtureById(ui.fixtureRef?.id) ?? null;
  if (named) out.about = ui.fixtureName(named);
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

  // BUILD MODE IS NOT A MODE WITH NO PRESSES IN IT, and for a long time this
  // pill said it was: `paletteArmed` was a blanket veto at the top of the
  // function, on the reasoning that the mode suspends every shopkeeping job. It
  // does — and it puts three of its own in their place. What a fixture answers
  // to while the bar is up is a tap, a drag and R, none of which is written
  // anywhere on screen: the line above the bar names the tap and the drag on the
  // unit you are POINTING at, and the moment you have picked one the two verbs
  // that act on a selection (R and M) have never been mentioned at all. On a
  // phone they cannot be — there are no keys — so every build verb bar the tap
  // was behind a menu you had to know was there.
  //
  // Kept to the fixture, which is the whole of what the mode adds. A crate, a
  // board and a square are shopkeeping and stay silent here exactly as they did
  // before, because `dropping` and `boardTakes` already refuse the mode and the
  // rows would be describing presses the bar has taken.
  if (ui.paletteArmed) {
    // A SELECTION IS STILL A TARGET AFTER THE POINTER HAS LEFT IT, and in build
    // mode that is the difference between a caption and a card that blinks.
    //
    // The rows here were derived from the hover alone, which is the right answer
    // out on the shop floor — a pointer is live, and what it is over is what a
    // press would land on. It is the wrong answer in this mode, because two of
    // the three verbs below are not about the pointer at all: R turns whatever
    // is SELECTED and the Move row runs `liftAimed` on it, and the selection is
    // ringed in the shop and stays ringed while you look elsewhere. So the shop
    // was drawing the marker and taking the words away — point at a unit and the
    // pill names it, slide one tile onto bare floor and the whole card goes,
    // with the teal frame still lit on the thing R would still turn. Reaching
    // for the toolbar does it too, which is the moment you most need to know
    // what you have got hold of.
    //
    // This is `pillDrives`'s own argument (see `f` above — "the thing you sent
    // yourself to is still the thing") arriving at the other end: there it is
    // the tap that survives the walk, here it is the selection that survives the
    // hover. The pointer still wins wherever it has something to say, so a
    // deliberate aim at another unit is never overruled — this is only what the
    // pill falls back to when it would otherwise have gone blank.
    //
    // The HOLD-DRAG tag stays honest by being about the RINGED unit rather than
    // about the square under the pointer: the row runs the lift itself, and the
    // gesture it names is the one that works on the thing the words are about.
    const sel = f ?? scene.fixtureById(ui.fixtureRef?.id) ?? null;
    if (!sel) return out;
    // Where the pill drives, the tap only ever picks (`openInTwo`) and the row
    // is the way in, so it says one thing. On a mouse the tap climbs the ladder
    // itself and the row names the rung it is standing on — the same split the
    // out-of-reach branch below already makes, for the same reason.
    if (pillDrives()) add('l', null, 'Open it', () => openInTwo(sel, { open: true }));
    else add('l', null, ui.isSelected(sel) ? 'Open it' : 'Select it', () => openInTwo(sel));
    // The drag, which is the gesture everybody tries first and the one this pill
    // is worst placed to describe — you cannot pull a fixture with a button. So
    // the row RUNS it (the same `liftAimed` M does) and the tag says how to make
    // it without one. `reopen: false`, because a row on the pill came from
    // pointing, not from a menu — see `liftAimed`.
    //
    // The tag names the gesture that actually works, which is the half that has
    // to be true — a pill saying "drag" over a unit that turns the shop instead
    // is the green-ghost bug wearing words. It says HOLD-DRAG rather than drag,
    // because a bare drag is still the camera: the press has to settle first
    // (`MOVE_DWELL_MS`), and naming only the second half of the gesture is how
    // you end up sweeping at a shelf and blaming the feature.
    //
    // ...and with SEVERAL picked it is the aimed move instead, with no gesture
    // named: a drag is a press on one unit, and the group is what the ring says
    // it is. This row is the only way into either on a phone, where there is no
    // M key and the whole point of the pill is that a build verb should not be
    // behind a menu you have to know about.
    if (ui.manyPicked && ui.isSelected(sel)) {
      add('l', null, `Move ${ui.pickedIds().length}`,
        () => ui.withBuildMode(() => ui.shiftSelection()));
    } else {
      add('l', 'hold-drag', 'Move it', () => liftAimed(sel, { reopen: false }));
    }
    // ...and the one press here that is not a press at all. Only on the unit
    // that is actually selected, because that is what R acts on — offering it
    // over a fixture you are merely hovering would turn the one behind you.
    // `rotateSelected` owns the several-at-once refusal itself, the way the
    // Rotate button it stands in for does.
    if (ui.isSelected(sel)) add('k', 'R', 'Turn it', () => ui.rotateSelected());
    return out;
  }

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
      if (pillDrives()) { walkRow('l', null, 'Go there', go); return out; }
      walkRow('l', null, 'Go to it', go);
      // Both buttons walk. The right one's own jobs all need you standing there
      // (`armPut` opens with `dropping()` and refuses a box out of reach), so
      // out here it falls down its ladder to the same tail the left button has
      // — see the end of the right-button `pointerup`. Said rather than left to
      // be discovered, because a button that works at four tiles and does
      // nothing at eight reads as the shop being unreliable. Both rows are still
      // written, because the fact is about two buttons; `add` is what folds them
      // into the one sentence with a mouse at each end.
      walkRow('r', null, 'Go to it', go);
      return out;
    }
    const lift = () => pillPress(() => net.send('take', { palletId: crate.id }), true);
    // A buried box is a box and nothing else: one unit out of a band of a dozen
    // pixels is never the tin anybody meant, so a pile offers the lift only.
    if (crate.stacked) { add('l', 'hold', 'Pick this box up', lift); return out; }
    if (haul) return out;
    // What is IN the box, which the pointer's own answer does not carry: a
    // desktop aim is `pickPallet`'s hit (an id and a position) and a phone's is
    // the record the tap named. One lookup here, so both ends ask the shop the
    // same question — and `null` when the box has gone out from under the aim,
    // which every test below then answers "live" to. A row greyed on a frame we
    // have not got is the failure that reads as the shop refusing you.
    const stock = (latestState?.deliveries ?? []).find((d) => d.id === crate.id) ?? null;
    // Which pile a rummage is about. The rows name no kind, and unnamed means
    // the biggest stack at both ends — see `tapCrate`, which picks the same one.
    const takeId = stock ? lotMain(stock)?.item_id ?? null : null;
    add('l', null, 'Take one',
      () => net.send('crate-one', { palletId: crate.id, put: false }),
      handRoom(takeId) > 0 ? null : noRoomWhy(takeId));
    // The hold is two jobs chosen by what is in your hands (`errandAction`), and
    // only one of them can be refused for room: empty hands can always shoulder
    // a box, while an armful is `unload`, which sweeps the crate and comes back
    // "hands full" when not one pile in there would fit.
    const sweeps = !stock || lotStacks(stock).some((s) => handRoom(s.item_id) > 0);
    add('l', 'hold', carry ? 'Take an armful' : 'Pick the crate up', lift,
      carry && !sweeps ? noRoomWhy(takeId) : null);
    // THE PUTS ARE A COLUMN WHERE THE PILL DRIVES, and a column that empties
    // itself the moment your hands do is half the card rearranging under your
    // thumb — with nothing left on screen to say the other direction exists.
    // So on a phone they stay and go grey. On a desktop the same pair is a
    // caption about a mouse button, and a caption for a press that does nothing
    // is noise, so there they are dropped exactly as they always were.
    const empty = carry ? null : 'Your hands are empty';
    if (carry || pillDrives()) {
      const giveId = lotMain(carry)?.item_id ?? null;
      const cap = latestState?.crateCap ?? Infinity;
      add('r', null, 'Put one back',
        () => net.send('crate-one', { palletId: crate.id, put: true }),
        // `tapCrate`'s pair of noes, in its own words: a full box is "come back
        // later" and a box with no board left for this is "that one is spoken
        // for", and they want opposite things from you.
        empty ?? (lotRoom(stock, giveId, { cap }) > 0 ? null
          : (lotTotal(stock) >= cap ? 'That crate is full'
            : `That crate has no room left for ${ui.itemName(giveId)}`)));
      // ...and the lot, which is the same grade the board below offers and the
      // one a crate did not have — see `armPut`. `place` at the box's own cell,
      // because `dropGoods` is what tops a crate up; a row that sent `crate-one`
      // in a loop would be the second opinion this whole function is written not
      // to be. Only where the shop would take it, or the row is advertising a
      // press that comes back red — which is a fact about the SQUARE rather than
      // about your hands, so it stays a dropped row rather than a grey one.
      //
      // A full box is not a refusal here the way it is above: `dropGoods` tops
      // one up, spends a free board in it, and stacks a new box on the cell when
      // it can do neither. Empty hands are the only veto.
      if (canDropAt({ x: Math.round(crate.x), z: Math.round(crate.z) })) {
        add('r', 'hold', 'Put them all in', () => pillPress(
          () => net.send('place', { x: Math.round(crate.x), z: Math.round(crate.z) }), true,
        ), empty);
      }
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
    // `nearFixture` alone, which is the circle every verb behind these rows
    // measures and the one `armPut` decides on. It used to also allow the
    // working-spot circle, which is a tile wider — so out in the band between
    // them the pill printed "Put one on" over a press that is a walk, and over a
    // `shelf-one` the shop refuses by half a tile. A hint that offers a press
    // the shop then turns down is the green-ghost bug with words on it.
    if (!nearFixture(f)) {
      // ONE ROW WHERE THERE IS ONE BUTTON. The three below are three different
      // presses on two mouse buttons — select, double-press to walk, right-press
      // to walk carrying — and with a single pointer they collapse into the only
      // thing you can mean about something you are not standing at: go to it.
      // Selecting is not lost, it is the tap itself (`tapAtPointer`), so a row
      // for it here would be the press you just made.
      if (pillDrives()) {
        walkRow('l', null, (carry || haul) ? 'Take it there' : 'Go there',
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
      // ...except in build mode, where that double press no longer goes — see
      // `openInTwo`. Dropped rather than greyed, which is the call this function
      // already makes about a held clock and a carried fixture: `off` is for a
      // press this target offers and your state vetoes, and the mode is not
      // vetoing anything here, it has taken the walk off the table. A caption
      // naming a gesture that does nothing is the green-ghost bug with words on
      // it, and the other two rows still say what the buttons do.
      if (!flying()) add('l', 'twice', 'Go to it', () => walkTo({ fixture: f.id }));
      walkRow('r', null, (carry || haul) ? 'Take it there' : 'Go to it',
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
      walkRow('r', null, 'Go to it', () => walkTo({ fixture: f.id }));
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
      // `out.length` and not `readyToTake` again: the harvest is a walk, so a
      // stopped clock drops it (`walkRow`) — and a ripe bed with its one row
      // gone must still fall back to the selection, or the two kinds in the shop
      // that offer nothing else are the two you cannot pick while building.
      if (readyToTake(f)) walkRow('l', null, 'Harvest it', () => walkTo({ fixture: f.id }));
      if (!out.length) select();
      stepOver();
      return out;
    }
    // A pen offers one job and nothing ever goes in, so there is no right press
    // and no direction to say — the bin's shape rather than the appliance's.
    if (f.kind === 'pen') {
      if (readyToTake(f)) walkRow('l', null, 'Collect it', () => walkTo({ fixture: f.id }));
      if (!out.length) select();
      stepOver();
      return out;
    }
    // A board the pointer has settled on. `boardTakes` is the same test the
    // press asks, so the cage round the pile, the tap and this line agree.
    // ...and there has to be something ON it. A board keeps its row at zero —
    // that is what a unit ticked for an item IS, an empty board with a name and a
    // price on it — so "is this pile named" and "is there anything in it" are two
    // questions, and only the first was being asked. Crate the lot, and the board
    // it emptied went on offering to be crated: the rows do not move, because the
    // stack is still there, holding nothing. On a desktop the pointer re-derives
    // and it self-corrects; where the tap is the aim it just sits there being
    // wrong.
    if (ripeBoard(f, board) && boardTakes() && boardQty(f, board) > 0) {
      // Greyed rather than dropped when your hands have no room — `unshelve`
      // refuses this on `lotRoom` exactly as `tapCrate` does, and a row that
      // left because of something about YOU takes the reason with it. See
      // `off` on `add`.
      add('l', null, 'Take one', () => {
        pickBoard(f, board);
        net.send('shelf-one', { shelfId: f.id, itemId: board });
      }, handRoom(board) > 0 ? null : noRoomWhy(board));
      // The lot goes on your SHOULDER, so this one is bounded by the box up
      // there rather than by your hands — `crateBoard`'s own test, and its own
      // words. An empty shoulder is a new box, which is always room.
      add('l', 'hold', 'Crate the lot', () => pillPress(() => {
        pickBoard(f, board);
        net.send('take', { shelfId: f.id, itemId: board });
      }, true), lotRoom(haul, board, { cap: latestState?.crateCap ?? Infinity }) > 0
        ? null : 'That crate is full');
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
    // ...FROM THE WORKING SPOT, which is a different distance to the one that got
    // us into this branch.
    //
    // `Game.aimAt` measures `atFixture` — the side you work the unit from — and
    // it refuses out of reach **silently** (`ok({ at: null })`), on the reasoning
    // that it used to be driven by a hovering pointer and a red toast for moving
    // the mouse is worse than nothing. That reasoning is dead now: the row is a
    // BUTTON, and a button whose whole answer is nothing at all is a button that
    // reads as broken. Near the unit but off its side, "Stock it" armed no
    // errand, the ring wound on the ground under your feet instead, and the crate
    // stayed on your shoulder.
    //
    // So the rows ask the same question the verb does. `atWorkSpotOf` is the
    // client's copy of `atFixture`, which is what makes this a promise the shop
    // can keep — the rule CLAUDE.md states about `nearFixture` versus
    // `inReachOf` versus `atWorkSpotOf` being three different questions.
    // ...AND ONLY WHERE THE GOODS WOULD ACTUALLY GO, which the chevrons have
    // known all along and this list did not ask.
    //
    // `takers` is the shop's own answer to "which units would have what you are
    // holding" — the same list `syncTakers` lights the green arrows from. A unit
    // with no arrow on it is a unit that will refuse you, and the pill was
    // offering "Put one on" and "Stock it" on it anyway: the marker and the
    // button, drawn from the same frame, disagreeing about the same press. That
    // is the green-ghost rule exactly, with the ghost being the absence of one.
    //
    // Read off the player rather than re-derived, or this becomes the second
    // opinion the whole of `pressHints` is written not to be — the arrows would
    // say one thing and the rows another, and which was right would depend on
    // which copy of the rule somebody last edited.
    const wanted = (myState()?.takers ?? []).includes(f.id);
    if ((carry || haul) && !wanted) {
      // No rows at all rather than a refusal: a unit that cannot take these
      // goods is not a thing you got wrong, it is a thing the shop is telling you
      // about by not lighting it. The menu is still one press away.
    } else if ((carry || haul) && !nearFixture(f)) {
      // Not a dead end: the walk carries the direction with it, so one press
      // still ends with the goods going on. Same row the out-of-reach branch
      // above offers, said one tile closer.
      walkRow('r', null, 'Take it there', () => walkTo({ fixture: f.id, put: true }));
    } else if (carry || haul) {
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
 * Only when `walk` is true — but that is the caller OFFERING it, and the mode
 * is what decides. Build mode never walks you: WASD there flies the view rather
 * than the player (`setFreeRoam`), so the shelf you just double-pressed is
 * routinely one you are looking at from somewhere you cannot stand — a room you
 * have this second sealed, the far side of the fence, the end of a grown farm.
 * Walking there is exactly what you did not ask for, and what it costs is the
 * two things the mode is actually for: your body leaves the view you had
 * arranged, and it arrives having dropped the errand a carried fixture is on.
 *
 * The test is `flying()`, which is the same one the camera asks, so the view and
 * the gesture cannot disagree about which mode this is — and it takes the paused
 * shop with it for free. A walk ordered against a stopped clock is a press with
 * no second half: the world does not step, so nothing moves until you unpause,
 * by which time the press is a minute old and you have forgotten making it.
 * That is `boardTakes`' own argument, and this is the last press in the mode
 * that was not making it.
 *
 * Inside rather than at the two call sites, because the rule is a fact about the
 * mode: a third caller that offers a walk should get it for free rather than
 * have to remember. The rest of the ladder is untouched — a double press in
 * there is select, then open, which is what the mode wants anyway.
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
  // ...and where the pill drives, a tap on the world ONLY EVER PICKS.
  //
  // The ladder exists because a mouse has one button and three things to say
  // with it: which unit, open it, go to it. The pill answers two of those with
  // chips of their own — "Open it" and "Go there" — so the second press is a
  // meaning nobody needs and nobody can see: tapping the same shelf twice threw
  // a panel over the shop, and tapping it a third time took it away again, which
  // from a finger is one gesture that does three different things depending on
  // history you cannot read off the screen.
  //
  // Selecting stays, because it is what the pill is ABOUT. This is the same
  // trade the out-of-reach branch of `pressHints` already made when it dropped
  // its "Select it" row: on a phone the tap is the selection, and every verb is
  // a button.
  if (pillDrives()) {
    if (!ui.isSelected(f)) ui.selectFixture(f);
    scene.ripple(f.x, f.z, 'miss');
    return;
  }
  const now = performance.now();
  const quick = lastFixtureTap.id === f.id && now - lastFixtureTap.at < DOUBLE_MS;
  lastFixtureTap = { id: f.id, at: now };

  // Amber, and it is the only press here that gets it: amber is "you are on
  // your way", pale is "I heard you". Selection survives the walk — you are
  // going to the thing you just named, so arriving with it deselected would be
  // the gesture forgetting its own subject.
  if (walk && quick && !flying()) {
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
 * ...and the same ladder said about a PERSON, which needed it more than a shelf
 * did.
 *
 * A tap on a hire *was* a tap on their whole rota — a panel over the shop, every
 * time, for the question you usually have about somebody walking past, which is
 * "who is that and what are they up to". The teal ring and the lit tile on the
 * staff bar answer that on their own, and both already exist (`setWorkerRef`);
 * there was simply no way to ask for them without the menu.
 *
 * Worse than the shelf version in one way that is specific to people: a hire is
 * the smallest thing in the shop you can point at and the only one that MOVES,
 * so the accidental press is not rare. You aim at a shelf, a stocker crosses it,
 * and the rota lands on top of the aisle you were working on. `aimPerson`
 * narrows *who* you can hit; this narrows what hitting them costs.
 *
 * No clock in it, unlike `openInTwo`: the third meaning there is a double press
 * that WALKS, and there is nowhere to walk to on a person — you cannot stand
 * where they are standing. So it is the plain two-press ladder, and the third
 * press shuts it (`closePanel` clears the ref, so that also drops the ring).
 *
 * The HOLD is untouched and still opens on one press (`openAtPointer`), which is
 * the same split the fixture ladder keeps: a tap is how you ask which one, a
 * hold is how you say you meant it.
 */
function openWorkerInTwo(who) {
  const hire = who?.hire;
  if (!hire) return;
  scene.ripple(who.x, who.z, 'miss');
  if (ui.workerRef !== hire) {
    // Read before the swap for `openInTwo`'s reason — `setWorkerRef` is what
    // repaints, and with a rota already up, pointing at somebody else means
    // "them instead" rather than costing a press to say what the panel is
    // already there to answer.
    const swapping = ui.openPanel === 'worker';
    ui.setWorkerRef(hire);
    if (swapping) showWorker(ui, hire);
    return;
  }
  if (ui.openPanel === 'worker') ui.closePanel();
  else showWorker(ui, hire);
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
  // The same thing the tap says, said about the other press — see
  // `dropStalePick`. Safe this far in because a hold that already named goods
  // never reaches here: `drag.took` sends the pull home first, which is the one
  // hold that IS about the picked pile.
  dropStalePick(cx, cy);
  // A person outranks the fixture behind them. They are smaller and they
  // move, so pointing at one is deliberate in a way that pointing at a shelf
  // is not — and their menu is the only way to reach what they do all day.
  // Not while the bulldozer is up: then you are aiming at things, and a clerk
  // wandering in front of a shelf must not stop you tearing the shelf out.
  // ...nor with the bar up, which is the same sentence about the whole mode —
  // see the ring in `refreshGhost`, which has to agree with this or the
  // highlight is advertising a press that does something else.
  // ...and the fourth thing that takes a hire out of the running is a hire who
  // walked under a pointer you were not moving — see `aimPerson`.
  const who = ui.demolishArmed() || ui.paletteArmed || handsFull()
    ? null : aimPerson(cx, cy);
  if (who?.hire) { showWorker(ui, who.hire); return true; }

  const hit = pickAimed(cx, cy);
  const over = hit?.f ?? null;
  // A WALL THE RAY MET IN FRONT OF THE UNIT BESIDE IT wins the press — see
  // `wallInFront`, and the hover draws its bar under exactly this rule. It only
  // stands the fixture down, and the way branch below is what opens it; and only
  // where the wall has a menu at all, which is the half that keeps this cheap. A
  // bare wall in front of a shelf leaves the shelf openable, so this can never do
  // more than hand a press to a wall you could see and could not otherwise reach.
  const frontWall = over
    && wallInFront(scene.pickFaceHit(cx, cy)?.dist ?? null, hit.dist ?? null)
    ? pickWay(cx, cy) : null;
  if (over && !frontWall && !ui.demolishArmed()) {
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
  // First, and unconditionally: a press names a thing, and everything the pill
  // says from here until the next press is about that thing. See `noteTap`.
  if (pillDrives()) noteTap(cx, cy);
  const kind = ui.ghostKindForTool();

  if (!kind && !ui.holding) {
    // Before the branches rather than inside one of them, because every press
    // from here down is a press on something, and all of them except one are
    // "clicking off that pile" — see `dropStalePick`. Above the bulldozer too:
    // tearing out the unit is about as plainly done with its bread as anything
    // could be.
    dropStalePick(cx, cy);
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
    // Hands full is the second thing that takes a hire out of the running, and
    // it is the one you meet every day — see `handsFull`. The bulldozer above is
    // about aiming at THINGS; this is about the press already having a subject.
    // Build mode is the first of those two said about the mode rather than about
    // one tool, and it is what keeps a tap on a shelf a tap on that shelf while
    // somebody restocks it.
    // ...and the fourth is somebody who walked into the press rather than being
    // aimed at: `aimPerson`, which is also what the ring above asks, so the
    // highlight and the tap cannot disagree about who you meant.
    const who = ui.demolishArmed() || ui.paletteArmed || handsFull()
      ? null : aimPerson(cx, cy);
    // Picked, then opened — see `openWorkerInTwo`. The hold is still one press.
    if (who?.hire) { openWorkerInTwo(who); return; }

    // ...and the fifth, which outranks all of them and is the only press in the
    // game aimed at somebody who does not work here: a thief you have caught up
    // with. Above the hire branch's `return` rather than below it because they
    // cannot collide — `aimThief` only ever answers somebody marked `stole` —
    // and *before* `setFollow(null)` below, because tazing is not "clicking off"
    // a menu and should not put one away.
    //
    // A tap rather than a hold, deliberately, and it is the one action in the
    // game shaped that way. Half a second stood still at the end of a sprint is
    // a thief two tiles further off, so a ring would lose every chase it was
    // used in — the cooldown on the far side is what stops it being spam. See
    // `Game.taze`.
    const thief = ui.paletteArmed ? null : aimThief(cx, cy);
    if (thief) {
      scene.ripple(thief.x, thief.z);
      net.send('taze', { id: thief.id });
      return;
    }

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
      // Held past the ring? Then the lift has already happened and this release
      // is the end of that gesture, not a second one — sending the rummage here
      // would be refused for the box now on your shoulder, which reads as the
      // tap being broken by the hold that worked. `drag.done` says this for
      // every other press; a crate press is the one that keeps its tap this
      // long, so it is the one that has to say when the tap is over.
      if (drag.rummage && performance.now() - drag.pressedAt >= CRATE_HOLD_MS) return;
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
    // ...and the wall in front of it, which HAS to be asked here as well as in
    // the hold: the amber bar the hover draws is a promise about this press, and
    // it is drawn under `wallInFront` now (see `blockedByFixture`), so a tap that
    // still gave the unit behind the wall the press would be the two of them
    // disagreeing about the same pixel.
    //
    // It STANDS THE FIXTURE DOWN rather than acting, and the way branch further
    // down does the rest — that branch owns the ripple and the shut-it-again
    // toggle, and a second copy of them here would be a doorway you could open
    // and not close. Only where the wall produced a menu, so a bare wall in front
    // of a shelf leaves the shelf tappable.
    const frontWall = over
      && wallInFront(scene.pickFaceHit(cx, cy)?.dist ?? null, hit.dist ?? null)
      ? pickWay(cx, cy) : null;
    if (over && !frontWall) {
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
      //
      // ...and `boardTakes` is the fourth thing it does read, which it had to
      // learn the moment the mode's own tap became load-bearing. A machine with
      // a full tray took the tap **in build mode**, so pointing at an appliance
      // sent `station-one` — and `notWhileBuilding` answers that with "Exit
      // build mode first", out loud, on the one press you make to select the
      // thing you are trying to move. There is no way to read that except as the
      // shop refusing to let you build with your own machine, and the only way
      // out was to leave the mode, which is what you had just turned on.
      //
      // The same predicate the board branch below makes, and it is the same
      // sentence: a tap that MOVES GOODS is not a thing this mode has, while
      // selecting a unit and opening its menu are most of what the mode is. It
      // carries the stopped clock with it for the reason its own docblock gives
      // — a walk in a paused shop is a press with no second half — and the two
      // clauses about your hands are already spent upstream, where an armed tool
      // and a carried fixture skip this whole ladder.
      if (readyToTake(over) && boardTakes()) {
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
        // ...and the UNIT it stands on, where the pill drives. A pile is not a
        // target the pill can be about on its own: `pressHints` asks the aim for
        // a fixture and falls back to the selection, and a board tap used to set
        // neither — it named the pile and nothing else, which was invisible while
        // a stale pointer kept the aim alive on a device that has no hover to
        // stale. With that gone the rows appeared on the tap and emptied on the
        // very next snapshot, because there was nothing left to be about.
        //
        // `selectFixture` and not `openInTwo`: this press has already said what
        // it meant by landing on the bread, so it must not also climb the
        // select-then-open ladder and put a panel over the shop.
        if (pillDrives() && !ui.isSelected(over)) ui.selectFixture(over);
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
    // The region goes with it, and needs saying separately for `ui.escape`'s
    // reason: a box that caught only ground holds no ref, so the line above
    // never fires and the teal stays lit under everything you do next.
    if (ui.fixtureRef) ui.setFixtureRef(null);
    else if (ui.pickRegion) ui.setPickRegion(null);

    const tile = scene.pickTile(cx, cy);
    if (!tile) return;
    /**
     * A copied stamp is something in your hands, so a press puts it down.
     *
     * Above the build-mode camera rung and not below it, because that rung is
     * the fallback for "nothing is armed" — and while a blueprint is held,
     * something is. Without this the press would fly the view to the very tile
     * you were aiming the stamp at, which reads as the paste being ignored.
     *
     * It does NOT return the clipboard: stamping the same aisle four times down
     * a wall is the gesture, and a paste that emptied your hands would make the
     * second one a trip back to the selection. Escape puts it down.
     */
    if (clipboard && ui.buildOn) {
      // ...and which of the two blueprints it is decides what the press SENDS,
      // and nothing else about it: same footprint, same aim, same Escape.
      if (shiftFrom) commitShift(tile);
      else pasteAtPointer(tile);
      scene.ripple(tile.x, tile.z);
      return;
    }
    // Building does no player stuff. A tap on the floor with nothing armed is
    // "go there" while you are shopkeeping and nothing at all in the mode — the
    // whole reason the view came off its leash is that you are working on parts
    // of the shop nobody can stand in, so a press that walks your body there is
    // answering a question you stopped asking when you opened the mode. It also
    // fights the camera it shares a button with: the drag flies the view, and
    // the tap at the end of a drag that fell short of the slop line would send
    // you across the shop, which reads as the view snapping back.
    //
    // What it does instead is take the VIEW there, which is the same sentence
    // the tap has always made — "that place, please" — pointed at the thing the
    // mode actually steers. So the drag is not the only way to cross a shop you
    // are building in: point at the far corner and go, exactly as you would
    // walk there when you are not.
    //
    // Amber and not pale, because it is a positive act rather than a swallowed
    // press.
    if (building()) {
      scene.focusOn(tile.x, tile.z);
      scene.ripple(tile.x, tile.z);
      return;
    }
    scene.ripple(tile.x, tile.z);
    walkTo({ x: tile.x, z: tile.z });
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
    // Only the three kinds the ceiling is made of have a storey — the server
    // refuses everything else, and sending it anyway would put a dead field on
    // every shelf ever placed. A lift and a tunnel are conveyors and are not
    // among them: see `goesOverhead`.
    ...(goesOverhead(kind) ? { deck: ui.buildDeck } : {}),
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
    // one: note where it lands, and `endMove` puts the selection back on it
    // there — reopening its menu too if that is where the errand began — and
    // hands back a build mode the fixture menu only lent you.
    ui.markMoveTarget(tile);
  } else {
    // Buying one and placing it is committing to the mode, so shutting the menu
    // still open on some other fixture can't drop you out of it mid-build.
    ui.commitBuildMode();
  }
  if (ui.openPanel === 'fixture') ui.closePanel();
  const placing = !ui.holding;
  // A lone conveyor is still a run of one. Sending it through `build-place`
  // skipped `buildRun`'s tail join, so the missing link between an arm and a
  // duct kept the palette's default facing and truthfully drew as an L. The
  // run path sees the one continuing ceiling belt, turns toward it, and leaves
  // ordinary fixture placement exactly as it was.
  const message = ui.holding ? 'build-drop' : (FIXTURES[kind]?.flow ? 'build-run' : 'build-place');
  net.send(message, message === 'build-run'
    ? { ...spec, to: null }
    : spec);

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
      lastInput = { dx: 0, dz: 0, sprint: false, fpv: scene.fpv };
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
    // ...including a theft cut, and this is the half that makes the cut safe to
    // have at all: it is announcing somebody you are meant to run after, so the
    // first step you take has to be worth more than the rest of the shot.
    scene.releaseCut();
    if (scene.panned) scene.recentre();
  }

  /**
   * Shift runs — see docs/security.md step 3.
   *
   * It shares the key with the kin preview and that is not a clash: the preview
   * no-ops unless a fixture is selected (`setKinPreview`), and the one gesture
   * this could collide with — shift-click to select kin — is a press rather
   * than a walk. Holding Shift while running a thief down shows a preview
   * nobody is looking at, which costs nothing.
   *
   * Sent as a field on `input` rather than as its own message, for the reason in
   * `Game.setInput`: the key going up has to arrive in the same breath as the
   * direction, or letting go of both leaves you sprinting on the last vector
   * until the next frame.
   */
  const sprint = shiftDown && !ui.paletteArmed;
  /**
   * ...and which camera you are behind, for `FPV_SPEED`.
   *
   * In the diff for the same reason sprint is: this runs every frame and sends
   * only on a change, so a flag left out of the comparison reaches the server
   * on the next *steer* and not before — which is a press of F while walking
   * that changes nothing until you let go of the key and take hold of it again.
   * It is read off the scene rather than mirrored into a variable of its own,
   * because the wheel enters first person as well as the key and a second copy
   * of that fact is a second copy to forget.
   */
  const fpv = !!scene.fpv;
  if (dx !== lastInput.dx || dz !== lastInput.dz
    || sprint !== lastInput.sprint || fpv !== lastInput.fpv) {
    lastInput = { dx, dz, sprint, fpv };
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
 * The frame clock, on screen, for `?perf` — or the Menu's own switch.
 *
 * Off unless asked for, because it is a developer's readout and not a feature:
 * it sits over the shop, it updates four times a second, and nobody playing has
 * a use for a number that only means something next to another number. It
 * exists because "it feels chunky" is a report nobody can act on and "38fps,
 * 21ms, 940 draws" is — and because the machine it is chunky on is never the
 * machine you are sitting at.
 *
 * `debugOn` is read every frame rather than once at boot, which is what lets it
 * be a switch at all: see client/debug.js for why the URL could not stay the
 * only way in. The element is built on the first frame it is wanted and taken
 * out again the moment it is not, so an off readout costs a map lookup.
 *
 * Frame time as well as fps, and the two are not the same claim: fps averages
 * away the hitch that is actually being complained about, so the WORST frame in
 * each window is printed beside the mean, with `jank` counting how many frames
 * missed. Draw calls and triangles come off `renderer.info`, which is the
 * difference between "this machine is slow" and "this shop is heavy".
 *
 * Four lines now, and each one exists to separate two diagnoses the line above
 * it folds together:
 *
 *   - **fps / cap** — a capped rate is a saving, not a stall. See `JANK_SLACK`.
 *   - **cpu / gpu against the budget** — which half of the machine is busy, and
 *     whether either of them is. The budget is the cap rather than a constant,
 *     and the verdict at the end of the line is the whole reason the numbers are
 *     worth printing at all: see `HEADROOM`.
 *   - **draws / tris / objs** — how heavy the shop is, and `objs` is the one
 *     that catches a batched crowd: two draw calls, eleven hundred objects for
 *     `projectObject` to walk twice a frame.
 *   - **geo / tex / prog** — the numbers that only mean anything over time. Flat
 *     is healthy; climbing on a shop standing still is a leak.
 *
 * `render.calls` used to be read straight off `info` after the frame, which was
 * a measurement of the ink pass's composite quad rather than of the shop — see
 * `info.autoReset` in scene.js for the whole of that.
 */
const perf = { at: 0, frames: 0, worst: 0, jank: 0, cpu: 0, draws: 0, tris: 0, el: null };

/**
 * ...AND HOW MUCH OF THAT TIME WAS OURS, WHICH THE FRAME INTERVAL CANNOT SAY.
 *
 * `render` returns when the last draw is *submitted*, not when it is done, so
 * the gap to the next frame is our JS plus the driver's queue plus the
 * compositor plus a vsync — and a readout that showed only the gap was equally
 * consistent with three unrelated diagnoses. CPU is measured here (the frame
 * body, top of `loop` to after `scene.render`) and GPU comes off `scene.gpuClock`.
 * Together they say which half to fix; apart, neither does.
 */
function endPerf(started) {
  if (perf.el) perf.cpu = Math.max(perf.cpu, performance.now() - started);
}

/**
 * ...AND THE FRAME RATE HAS A CEILING THAT IS OFTEN THE WHOLE ANSWER.
 *
 * The loop caps itself at `DRAW_HZ`, and drops to `PAUSED_HZ` on a stopped shop
 * nobody is touching — so a paused game reads *10 fps, 100.0ms, worst 100.1ms*,
 * which is three alarming numbers describing a saving working exactly as
 * designed. That is the readout at its worst: not wrong, but pointed at
 * something nobody asked about, and indistinguishable at a glance from a shop
 * that has fallen over. Printing the cap beside the rate is the fix, and `jank`
 * is counted against the cap rather than against a fixed 30fps for the same
 * reason — every frame of a deliberate 10Hz would otherwise be a dropped one.
 */
const JANK_SLACK = 1.6;

/**
 * WHAT THE NUMBERS ARE SUPPOSED TO BE, which is the question a profiler that
 * only prints measurements leaves you holding.
 *
 * There is no absolute good figure for either half, and looking one up is the
 * wrong instinct: the budget is not a property of the machine, it is `1000 / hz`
 * — the cap the loop set for itself. At `DRAW_HZ` that is 25ms, and while the
 * shop is stopped it is 100. So the same 40ms frame is a disaster in play and a
 * third of the budget on a paused shop, and no constant written down here could
 * tell those apart. It is derived per window instead.
 *
 * THE TWO HALVES DO NOT ADD UP, and that is the part worth knowing before
 * reading the line. CPU and GPU are pipelined — while the driver chews on frame
 * N the tab is already building N+1 — so the frame is bound by `max(cpu, gpu)`
 * and never by their sum. Adding them is the natural mistake and it reports a
 * comfortable frame as an overrun.
 *
 * `HEADROOM` is what separates "fits" from "fits today". A frame is not sized by
 * its mean: the shadow map is a second full draw of the shop on a cadence, a
 * re-flow rebuilds the world mid-frame, and a busy evening is a thousand more
 * objects than a quiet morning. Sitting at 95% of budget means every one of
 * those is a dropped frame, so the bar for "there is room here" is well under
 * the line rather than on it.
 *
 * ...and the fourth answer is the one nothing else in the readout can give:
 * NEITHER. If the frame is long and both halves are short, the time is going
 * somewhere that is not this page — a throttled background tab, the window
 * compositor, another process on the GPU — and every hour spent optimising our
 * two numbers would move nothing. That case used to be invisible, and it is the
 * one that wastes the most time, because the shop genuinely is slow and
 * everything you can see about it looks fine.
 */
const HEADROOM = 0.6;

function boundName(cpu, gpu, frame, budget) {
  const head = Math.max(cpu, gpu ?? 0);
  // Idling at the cap on purpose — the healthy state, and the one that looks
  // alarming because `frame` sits exactly on the budget by construction.
  if (head < budget * HEADROOM && frame <= budget * 1.25) return 'at cap, room to spare';
  // The frame is long and neither of ours accounts for it.
  if (frame > budget * 1.25 && head < frame * 0.6) return 'stalled elsewhere';
  // With no timer query there is only one number, so the honest answer names
  // what was measured rather than implying the other half was ruled out.
  if (gpu == null) return cpu > budget * HEADROOM ? 'cpu busy (gpu unknown)' : 'gpu unknown';
  return gpu > cpu ? 'gpu bound' : 'cpu bound';
}

function stepPerf(now, ms, hz) {
  if (!debugOn('perf')) return;
  if (!perf.el) {
    // The window starts here rather than at zero, or the first thing the
    // readout ever prints is a mean taken over however long the page has been
    // open — which is 0 fps on boot, and a wrong number on the frame somebody
    // switched it on to read a number.
    perf.at = now;
    perf.frames = 0;
    perf.worst = 0;
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
  if (ms > (1000 / hz) * JANK_SLACK) perf.jank += 1;
  // The MAX over the window rather than the last frame, and that is about the
  // shadow cadence rather than about caution: the shadow map is a second full
  // draw of the shop and it runs every `SHADOW_EVERY` frames, so consecutive
  // frames genuinely differ by hundreds of calls. Sampling one of them at 4Hz
  // would print whichever it happened to land on, and the figure would flicker
  // between two right answers — which reads as an unstable shop. The expensive
  // frame is the one worth knowing, and it pairs with `worst` above.
  const info = scene.renderer?.info;
  perf.draws = Math.max(perf.draws, info?.render?.calls ?? 0);
  perf.tris = Math.max(perf.tris, info?.render?.triangles ?? 0);
  if (now - perf.at < 250) return;
  const fps = Math.round((perf.frames * 1000) / (now - perf.at));
  const clock = scene.gpuClock;
  // `null` and never 0 when nothing can answer — see gpu-clock.js. A zero reads
  // as "the GPU is idle", which is the opposite of "nobody can tell you", and it
  // would send somebody optimising the half of the frame that was already fine.
  const gpuMs = clock?.available ? clock.ms : null;
  const frame = 1000 / Math.max(1, fps);
  // The budget is the loop's own cap rather than a constant — see `HEADROOM`.
  const budget = 1000 / hz;
  perf.el.textContent = `${fps} fps / ${hz} cap  frame ${frame.toFixed(1)}ms`
    + `  worst ${perf.worst.toFixed(1)}\n`
    + `cpu ${perf.cpu.toFixed(1)}  gpu ${gpuMs == null ? '-' : gpuMs.toFixed(1)}`
    + `  of ${budget.toFixed(1)}ms  ${boundName(perf.cpu, gpuMs, frame, budget)}`
    + `  jank ${perf.jank}/${perf.frames}\n`
    + `${perf.draws} draws  ${(perf.tris / 1000).toFixed(0)}k tris`
    + `  ${scene.objectCount?.() ?? 0} objs\n`
    // The three that only mean anything over TIME. Each is a resource three.js
    // frees on `dispose` and on nothing else, so a shop standing still with any
    // of them climbing is a leak — which is how the sprite labels were losing a
    // canvas, a texture and a material on every sale, invisible in every other
    // number here because the frame cost of a leak is nil until it is fatal.
    + `geo ${info?.memory?.geometries ?? 0}  tex ${info?.memory?.textures ?? 0}`
    + `  prog ${scene.renderer?.info?.programs?.length ?? 0}`
    + `  dpr ${scene.renderer?.getPixelRatio?.().toFixed(2) ?? '?'}\n`
    // The one cost on here that is NOT per frame — see `Scene.buildWorld`. A
    // re-flow stops the world between two frames, so it never shows up in
    // `cpu` or `worst`; this is the only place a build press that stutters can
    // be told from a shop that is simply heavy to draw.
    + `reflow ${(scene.reflowMs ?? 0).toFixed(1)}ms`
    + `  worst ${(scene.reflowWorst ?? 0).toFixed(1)}  x${scene.reflows ?? 0}`
    + `  kept ${scene.reflowKept ?? '-'}\n`
    // ...broken down, because "the rebuild is slow" is not an actionable
    // sentence: the phases answer to completely different things — how much you
    // have BUILT, how big the map is, how much you have PAINTED — and which one
    // it is decides whether the fix is a cache, a cap or a smaller sweep.
    + Object.entries(scene.reflowPhases ?? {})
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ');
  perf.at = now;
  perf.frames = 0;
  perf.worst = 0;
  perf.jank = 0;
  perf.cpu = 0;
  perf.draws = 0;
  perf.tris = 0;
}

// ---------------------------------------------------------------------------
// The debug grid, and the number under the pointer — `?tiles`, or the switch
//
// Two halves of one question, and each is useless without the other. The grid
// (`scene.setTileGrid`, drawn in client/render/tile-grid.js) answers "where is
// 11,23" — somebody else's coordinate, and you have to find it. The readout
// answers the same question backwards: "what is THIS" — the tile you are
// pointing at, which is what you need when you are the one about to say a
// coordinate to somebody. The grid alone leaves you counting to check; the
// readout alone leaves you sweeping the pointer over the shop hunting for a
// tile you were handed.
//
// It reads `pickTile` in the frame loop rather than on `pointermove`, which is
// cheaper AND more honest: the tile under a pointer that has not moved changes
// every time the camera does, and a number that went stale while you panned is
// worse than no number.
//
// Its own element with its own styles, for the reason `stepPerf` gives — the
// HUD is laid out in stacks that other things measure, and a debug readout that
// pushed the toolbar around would be moving the thing it was brought in to
// look at.
// ---------------------------------------------------------------------------

const tileRead = { el: null, said: '' };

/**
 * Both readouts, wired to the switch — and to the URL, which `onDebug` replays
 * the moment this registers.
 *
 * The grid half is said here long before there is a shop to draw it over: the
 * scene records the wish and cuts the sheet on the first `buildWorld`, so boot
 * order stays somebody else's problem. The two boxes are *removed* rather than
 * hidden, because each is a `position: fixed` element with nothing else holding
 * a handle to it — and a hidden one would keep `tileRead.said` alive, so
 * switching the readout back on would show the last tile you crossed before you
 * turned it off and stay on it until the pointer moved to a different one.
 */
onDebug((id, on) => {
  if (id === 'tiles') {
    scene.setTileGrid(on);
    if (!on) {
      tileRead.el?.remove();
      tileRead.el = null;
      tileRead.said = '';
    }
  }
  if (id === 'perf' && !on) {
    perf.el?.remove();
    perf.el = null;
  }
});

function stepTileRead() {
  if (!debugOn('tiles')) return;
  if (!tileRead.el) {
    tileRead.el = document.createElement('div');
    tileRead.el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;'
      + 'font:600 12px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.62);'
      + 'padding:4px 7px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.append(tileRead.el);
  }
  const at = pointer.onCanvas ? scene.pickTile(pointer.x, pointer.y) : null;
  // Off the map is a real answer and has to be said, or the readout freezes on
  // the last tile you crossed and reads as the pointer having stuck.
  const said = at ? `tile ${at.x},${at.z}` : 'tile —';
  if (said === tileRead.said) return;
  tileRead.said = said;
  tileRead.el.textContent = said;
}

// ---------------------------------------------------------------------------
// The view comes back the way you left it
//
// In `localStorage` rather than on the save, and it is the same argument
// `shutterUsed` and `whoAmI` make: how you like the camera and whether you were
// building are facts about the PERSON, not about the shop. Two people in one
// shop do not share a camera, and being handed a second world does not make you
// want to look at it from a different angle.
//
// Split across two keys for the one field where that argument does not hold.
// Pitch, yaw and the mode are yours everywhere; WHERE the view is sitting is a
// map coordinate, so it belongs to the world it is a coordinate in — restore
// one shop's centre into another and the view opens somewhere arbitrary, which
// is worse than not remembering at all.
//
// Saved off the frame loop on a half-second throttle rather than at every
// mutation site, and that is deliberate: the pose is moved by a drag, a key, a
// pinch, a fly, a re-centre and a follow, and a save hung on each of those is
// six places to forget the seventh. The value is stringified and compared, so a
// still camera writes nothing at all.
// ---------------------------------------------------------------------------

const VIEW_KEY = 'sns-view';
const viewAtKey = (id) => `sns-view-at:${id}`;

const readJson = (key) => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
};
const writeJson = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
};

let viewRestored = false;
let viewSavedAt = 0;
let viewSaved = '';

/**
 * Put it back, once, on the first frame there is a shop to put it back into.
 *
 * It waits for the layout because the centre is clamped against the map, and a
 * clamp run before the world arrives is a clamp against nothing — which reads
 * as the position being remembered and then thrown away.
 *
 * The mode is restored by pressing the BUTTON rather than by setting the flags:
 * build mode is three states on one press (mode, mode + palette, off), the
 * server has to be told, and the bar, the hotbar and the ghost all hang off it.
 * `pressBuild` is that sequence and it is already the thing that is right; a
 * second copy of it here would be a fourth state nobody designed.
 */
function restoreView() {
  if (viewRestored || !scene.storeLayout) return;
  viewRestored = true;
  const pref = readJson(VIEW_KEY) ?? {};
  if (pref.build === 'mode' || pref.build === 'bar') {
    ui.pressBuild();
    if (pref.build === 'bar') ui.pressBuild();
  }
  // Before the centre, never after: `freeRoam` decides which of the two bounds
  // `clampPan` applies, and a build-mode centre clamped to the 14-tile leash is
  // hauled back to your body on the frame it is restored.
  scene.setFreeRoam(flying());
  const centre = ui.worldId ? readJson(viewAtKey(ui.worldId)) : null;
  scene.applyView({ pitch: pref.pitch, yaw: pref.yaw, centre: centre ?? undefined });
}

function saveView(now) {
  if (!viewRestored || now - viewSavedAt < 500) return;
  viewSavedAt = now;
  const v = scene.viewState();
  const build = !ui.buildOn ? null : (ui.bar === 'build' ? 'bar' : 'mode');
  const line = JSON.stringify([v.pitch, v.yaw, build, v.centre.x, v.centre.z]);
  if (line === viewSaved) return;
  viewSaved = line;
  // Spread over whatever is already there rather than written flat. This
  // object is not only the camera's any more — `setLook` keeps the Cel + Ink
  // switch in it, on the same argument (a fact about the person, not the shop)
  // — and a save that named its own three fields would wipe it every half
  // second the view moved. Which reads as the look reverting on its own, days
  // later, with nothing to connect it to.
  writeJson(VIEW_KEY, { ...(readJson(VIEW_KEY) ?? {}), pitch: v.pitch, yaw: v.yaw, build });
  if (ui.worldId) writeJson(viewAtKey(ui.worldId), v.centre);
}

/**
 * How often the shop is DRAWN, which is a different question from how often the
 * browser offers to draw it.
 *
 * A frame costs three processes on a retina Mac and only one of them is this
 * page: measured on a half-screen window, the tab was 31% of a core, the GPU
 * process 29% and the window compositor 38%. Everything downstream of a draw
 * scales with how many there are, so this is the one dial that moves all three
 * at once — and it moves them together, which nothing else here does.
 *
 * 40 rather than 30, because the camera pans and eases and a shopper crossing an
 * aisle is a thing you watch. 30 is visibly steppy on a diagonal pan; 40 is not,
 * and it is a third off the whole bill. Nothing in the sim is tied to it — the
 * world steps at 20Hz on the server and everything here interpolates against a
 * real clock, so this only ever changes how often that interpolation is sampled.
 *
 * Deliberately a cap and not a `setTimeout` loop: `requestAnimationFrame` stays
 * the heartbeat, so a hidden tab still stops dead and a 120Hz panel does not get
 * a second, competing clock.
 */
const DRAW_HZ = 40;
/**
 * ...and while the shop is STOPPED, which is the only state in this game where
 * the picture genuinely does not change.
 *
 * Skipping the draw outright is the obvious version and it does not work here:
 * the grass wind is a shader clock that advances every unpaused frame, so
 * "nothing moved" is never true outdoors, and a dirty-flag scheme would have to
 * be told about every marker, ghost and hover in the game — one missed and the
 * screen silently stops updating, which is the worst failure this renderer has.
 *
 * `paused` sidesteps all of it, because it already stops the wind and
 * `animateStations` at the source. A low rate rather than none at all, so
 * nothing can look frozen for more than a frame or two.
 *
 * It applies to a stopped shop NOBODY IS TOUCHING, which is the half that was
 * missing — see `LIVELY_MS`.
 */
const PAUSED_HZ = 10;
/**
 * ...and how long an input buys the full rate back.
 *
 * The rate above was argued as "a camera drag over a stopped shop is still
 * smooth enough to use", and that is the one claim in here that does not
 * survive being tried: 10Hz is fine for a picture that is not changing and
 * awful for one you are dragging, because a pan is the single thing on this
 * screen whose whole quality IS the frame rate. Every other frame a stopped
 * shop draws is genuinely wasted, and every frame it draws while you are moving
 * the camera is the only thing you are looking at. A pause is also exactly when
 * you go and look around — the shop is stopped *so that* you can — so the state
 * that saves the most frames is the state in which the saving is most visible.
 *
 * A window rather than a flag, because there is no "stopped dragging" event
 * that fires reliably: a pointer leaving the window, a key released while
 * another has focus, a wheel that simply stops. A stamp bumped on any input
 * decays on its own, which cannot get stuck at either rate.
 *
 * Half a second, which is longer than the gap between two `pointermove`s of
 * even a slow drag and short enough that letting go settles back within a beat.
 * The listeners are capture-phase on `window` so nothing can swallow them
 * before this sees them, and passive so none of them can cost a scroll.
 */
const LIVELY_MS = 500;
let lastDraw = 0;
let livelyAt = 0;
for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup']) {
  addEventListener(ev, () => { livelyAt = performance.now(); }, { capture: true, passive: true });
}

function loop() {
  const now = performance.now();
  const hz = scene.paused && now - livelyAt > LIVELY_MS ? PAUSED_HZ : DRAW_HZ;
  // Slack, or a 60Hz panel lands 16.7ms either side of a 25ms target and every
  // other frame is skipped — which is 30fps wearing a 40fps constant.
  if (now - lastDraw < (1000 / hz) - 4) {
    requestAnimationFrame(loop);
    return;
  }
  lastDraw = now;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  // `hz` as well as the interval: the cap is most of the answer on a stopped
  // shop, where 10fps is the saving rather than a stall. See `JANK_SLACK`.
  stepPerf(now, now - lastFrame, hz);
  stepTileRead();
  lastFrame = now;
  restoreView();
  pollInput(dt);
  if (ui.buildOn) refreshGhost();
  // The transport network. Here rather than in `refreshGhost` because that
  // function opens with four early returns for the drags, and a belt drag is
  // exactly when you most want to see what the run you are laying joins onto.
  //
  // A SWITCH rather than the build mode it shipped gated on, which is the same
  // call `debugOn('tiles')` makes and for the same reason: the mode is not the
  // question. You want the map while you are laying a run and you want it again
  // while you are watching one jam, which is not build mode at all — and gated
  // on the mode it was also invisible to anyone who had not guessed it existed.
  //
  // Read every frame rather than latched off `onDebug`, exactly as `perf` is:
  // the overlay is keyed on the layout underneath, so the frame that has to
  // rebuild it is a frame somebody built something on, not the frame the switch
  // was pressed. It no-ops on that key when neither has moved.
  // ...and WHAT IT IS ABOUT, which is the ordinary selection rather than a mode
  // or a second gesture of its own: you pick a shelf to look at it, and the map
  // answers about that shelf.
  //
  // The WHOLE selection, because shift-picking six shelves is the one gesture
  // that means "these" — the map answers with a route to each, and a set of one
  // is the ordinary tap unchanged.
  //
  // The refs and not `pickedFixtures()`, which is the same list resolved the
  // safe way and resolves it by walking `fixturesIn` once per member — a fresh
  // copy of every fixture in the shop, forty times a second, for an answer that
  // only moves when somebody presses something. `flowFocus` matches by id and
  // falls back to tile and storey, so the one thing that lookup buys — an id
  // gone stale under a rotate — is bought here for nothing.
  scene.setFlowOverlay(debugOn('flow'), ui.fixtureRef ? [ui.fixtureRef, ...ui.picked] : null);
  // Every frame while the key is down, because the camera rides the player: a
  // card pinned once slides off the unit it names the moment anybody walks.
  if (peekOn) ui.setPeek(peekCards());
  // How far through a held press we are, recomputed per frame rather than
  // stepped by the timer that fires it: the timer knows when the press is over
  // and nothing else, and a progress bar driven by a single timeout can only
  // ever jump from empty to full.
  const holding = drag.id !== null && !drag.done && drag.travel < TAP_SLOP;
  scene.setHoldProgress(holding
    ? (performance.now() - drag.pressedAt) / LONG_PRESS_MS
    : null);
  scene.render();
  // After the draw and before `saveView`, which touches localStorage on its own
  // cadence: what is being measured is the frame, and a write that happens once
  // every few seconds would land on one window as a spike belonging to nothing.
  endPerf(now);
  saveView(now);
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
  shopOpen('own');
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
  shopOpen('guest');
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
