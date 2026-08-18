/**
 * WHAT A BREAK LOOKS LIKE.
 *
 * Step 8 gave workers breaks and left them standing at the spot in exactly the
 * pose they work in — so a hire who had downed tools was indistinguishable from
 * one who was busy, and the only place that said otherwise was their menu. This
 * is the other half: a prop, and some motion.
 *
 * Everybody who works here is a machine, which changes what the CODE half is
 * allowed to do and not what the authored half is. See `SINK` below: the
 * original said "off duty" by leaning the body onto one hip and breathing, and
 * both of those are a body rather than a machine. A break is a *charge* now, so
 * the body powers down — straight down, head dipped, idling on a slow pulse.
 *
 * The split is the same one the rest of the game uses.
 *
 *   AUTHORED — the prop itself, in the pastime's `model`, staged by how far
 *   through the break they are. `partsAt(model, breakProgress)` and a mug
 *   empties, a sandwich goes down to the crusts, a cloud builds and thins. No
 *   code in here knows what a mug is.
 *
 *   CODE — everything continuous. State arrives at 10Hz and the page draws at
 *   60, so anything that only moved when the snapshot did would read as a
 *   rendering fault (the same argument the `liftedRing` comment makes). The
 *   slump, the breathing, the bob of whatever is in their hands and the rise
 *   and fade of a puff all happen per frame, driven by the clock.
 *
 * The one thing stages genuinely cannot say is a loop: a stage arc plays once
 * across a twenty-second break, and smoke has to keep going. That is what a
 * part flagged `drift` is for, and it is the whole reason the flag exists.
 *
 * That half now lives in render/motion.js, because an appliance mid-batch wants
 * exactly the same thing and two copies of a puff is two things that drift
 * apart. What is left in here is what is actually about a person: the slump,
 * the breathing, and the tip of whatever is in their hands.
 */

import { buildLoopingProp, animatePuffs, animateMotion } from './motion.js';
import { partsAt } from '../../shared/model.js';

/**
 * How far the body sinks on its legs while docked, in tiles.
 *
 * This used to be `LEAN` — 0.2 radians onto one hip — and a hip is the whole
 * problem. Everybody who works here is a machine, and the two things this
 * function did to say "off duty" were the two most human things in the game: it
 * tipped the body sideways the way somebody shifts their weight, and it BREATHED
 * — a sine on height, roll and pitch at 1.7Hz, which is a resting chest and
 * nothing else. Neither is authorable around, because both are applied to every
 * pastime that will ever exist, over the top of whatever prop it drew.
 *
 * So a unit at rest powers down instead: it settles straight down on its legs,
 * dips its head, and idles on a slow pulse. Straight down rather than sideways
 * is the whole distinction — a machine parks, it does not lounge.
 */
const SINK = 0.055;
/** Radians the head tips forward when it powers down. */
const DIP = 0.13;
/** Cycles a second of the idle pulse. Deliberately well under a resting pulse. */
const IDLE_HZ = 0.55;
/** How far the idle pulse moves the body, in tiles. A tell, not a movement. */
const IDLE_RISE = 0.008;
/** How fast the power-down eases in and out, per frame. */
const SETTLE = 0.07;
/** Close enough to the target to stop easing and sit still. */
const SETTLED = 0.004;

/**
 * The prop for one pastime, at one point through the break.
 *
 * Nothing on a person casts a shadow — the body already does, and a mug laying
 * its own shadow across the floor from chest height reads as litter.
 *
 * `skin` is the palette of the unit holding it. A prop part with a `tint` slot
 * takes its colour from that, exactly as the body's parts do — so a cable or a
 * status lamp belongs to the machine on the end of it. Without it the flag was
 * accepted by the schema, authorable, and silently did nothing.
 */
export function buildPastimeProp(model, t = 0, skin = null) {
  return buildLoopingProp(partsAt(model, t), { castShadow: false, skin });
}

/**
 * One actor, one frame.
 *
 * Everything here is driven by `now` rather than by the snapshot, and everything
 * eases rather than switching, so going on a break and coming back off one are
 * both a movement instead of a jump cut.
 *
 * `rec` is a `syncActors` record: `obj` is the body, `resting` says whether they
 * are on a break, `pastime` is the prop if the pastime has one authored, and
 * `slump` is our own eased 0..1 that we keep on it.
 */
export function animateRest(rec, now, camYaw = null) {
  const want = rec.resting ? 1 : 0;
  const at = rec.slump ?? 0;
  const slump = Math.abs(want - at) < SETTLED ? want : at + (want - at) * SETTLE;
  rec.slump = slump;
  // Upright, empty-handed and not on the way anywhere — which is every shopper
  // in the shop and every worker who is working, so it wants to be the cheap case.
  if (!slump && !rec.pastime) return;

  // Turn to the camera while they are sat down.
  //
  // A break is the one time a body is doing something worth LOOKING at — the
  // slump, the mug going down, whatever the pastime authored — and where they
  // face when they stop is wherever the last leg of their walk happened to
  // point. Half of them sat with their backs to you, and what is behind a robot
  // is a flat panel.
  //
  // Blended by `slump` off a stored base rather than eased toward the camera
  // frame by frame, and that is the load-bearing bit: `rotation.y` is rewritten
  // from the server on every sync, so a turn that accumulated would be yanked
  // back ten times a second and never arrive. `rec.yaw` is what the shop says
  // they face, this is the whole offset, and standing up unwinds it for free.
  if (camYaw != null && rec.yaw != null) {
    const TAU = Math.PI * 2;
    // Shortest way round, or a bot two degrees the wrong side of south spins
    // most of a full turn to face you.
    const d = ((camYaw - rec.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
    rec.obj.rotation.y = rec.yaw + d * slump;
  }

  const t = now / 1000;
  const phase = rec.phase ?? 0;
  const idle = Math.sin(t * IDLE_HZ * Math.PI * 2 + phase);

  // The body. This is the half that reads from across the shop: at this camera
  // a status lamp is a few pixels, but a silhouette that has stopped standing to
  // attention is obvious even out of focus. `rotation.y` is the facing and is
  // rewritten every sync — these two axes are ours alone.
  //
  // Down and forward, never sideways. The sink is a constant and the pulse only
  // rides on top of it, so a docked unit sits at a fixed height and *ticks*
  // rather than rising and falling: the pulse is small enough to be a sign of
  // life rather than a movement, which is the difference between an idling
  // machine and a sleeping one.
  rec.obj.position.y = (idle * IDLE_RISE - SINK) * slump;
  rec.obj.rotation.x = DIP * slump;

  const g = rec.pastime;
  if (!g) return;

  // Whatever is in their hands, given a life of its own so a mug tips toward
  // them rather than being welded to their chest.
  g.userData.held.rotation.x = Math.sin(t * 1.1 + phase) * 0.16;
  g.userData.held.position.y = Math.sin(t * 2.3 + phase) * 0.012;

  animatePuffs(g.userData.puffs, t);
  // A pastime is never idle — somebody is either on a break or they are not,
  // and the prop only exists for as long as they are. So a `motion` part of one
  // simply runs: a phone screen that pulses, a fan somebody is holding.
  animateMotion(g.userData.moving, t, true);
}
