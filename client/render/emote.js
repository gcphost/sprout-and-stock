/**
 * WHAT A WAVE LOOKS LIKE.
 *
 * The shop is full of bodies that walk, carry and queue, and until now not one
 * of them could address another one. `shared/emotes.js` is the vocabulary and
 * this is the only place any of it is drawn: four poses over the two shoulder
 * pivots every body already has, an envelope that fades each of them in and
 * out, and nothing else.
 *
 * It is a sibling of `pastime.js` rather than a branch inside it, and the split
 * is the one that file already draws. A break is a STATE — it lasts twenty
 * seconds, it has a prop, it is a fact about a worker the shop keeps. An emote
 * is a stamp: it starts on a tick, it runs for a couple of seconds off its own
 * clock, and there is nothing to be in the middle of. Folding them together
 * would mean `slump` and a wave easing against one another over the same body,
 * which is two answers to "where are your arms".
 *
 *
 * THE THREE THINGS THAT MAKE IT CHEAP
 *
 * **It writes only what nothing else writes.** `animateActors` owns
 * `rotation.x` on the two arms — that is the walk's counter-swing, written
 * every frame for every body in the shop — and `syncActors` owns `rotation.y`
 * on the root. So a pose is expressed in `rotation.z` on the arms (which
 * nothing has ever touched) and BLENDED into the x it finds. A wave laid over a
 * walk is therefore an arm going up while the legs keep going, rather than a
 * body that stops to say hello.
 *
 * **The envelope is the whole safety.** `amount` runs 0 → 1 → 0 across the
 * emote, so the arm rises rather than snapping up and comes down rather than
 * being dropped. It is also what makes the pass safe to STOP: on the last frame
 * every value it writes is what the frame before an emote would have held, so
 * clearing the record leaves nothing behind. Anything added here that does not
 * scale by `amount` is a limb welded in place the moment somebody waves twice.
 *
 * **A body's clock is its own.** The shop stamps when the pose started
 * (`emoteAt`, against `elapsed`) and this keeps the local clock, so eight
 * shoppers waving back on a stagger each run their own two seconds. The stamp
 * is compared rather than counted from: two waves in a row are the same string,
 * and a client that only watched the KIND would see no change and never wave
 * the second time.
 *
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No head, no face, no prop. A batched shopper's rig is five empty groups (see
 * `crowdRig`) — four limbs and the root — so there is no head pivot to nod, and
 * the face is one instance colour `animateMoods` already owns. Reaching for
 * either would mean a second rig for shoppers, which is the cost the batch was
 * built to avoid. Four arm shapes read from further away than any of it anyway:
 * at play zoom a hand is about four pixels and a silhouette is not.
 */

import { EMOTES } from '../../shared/emotes.js';

/**
 * How long the pose takes to rise and to fall, as a fraction of the whole.
 *
 * Both ends, so it is symmetric — an arm that shot up and eased down would read
 * as a flinch. A quarter each leaves half the emote at full pose, which is what
 * the wave's wiggle and the dance's sway need to be legible at all: ramp for
 * longer and a two-second emote is all ramp and never says anything.
 */
const RAMP = 0.25;

/** How far a raised arm swings out from the body, in radians. */
const RAISE = 2.35;
/** ...and how far a lowered-but-active one does. The dance's off-beat arm. */
const HALF = 1.15;

/**
 * Every pose, as a function of (amount, seconds-since-it-started).
 *
 * Each returns what to add to the body, in one shape, and every number in it is
 * already scaled by `amount` — see the envelope note above. `lz`/`rz` are the
 * two arms' swing out sideways, `lx`/`rx` is added to the walk's own forward
 * swing, `bob` lifts the whole body and `sway` rolls it.
 *
 * The sign convention is the one the rig is built in, and it is the single
 * thing here worth getting right: an arm hangs down its own -y from a pivot at
 * the shoulder, so a turn about +z carries it toward +x. The RIGHT arm stands
 * at +x and therefore wants a POSITIVE z to go up and out; the left is the
 * mirror. Get it backwards and the arm swings through the chest, which draws as
 * a body with no arms rather than as a sign error.
 */
const POSE = {
  /**
   * One arm up, waving from the elbow it does not have.
   *
   * The wiggle is on `z` rather than on `x`, which is the difference between
   * waving and hailing a taxi: side to side about the raised axis is a wave,
   * back and forth is a semaphore. It rides ON the raise rather than replacing
   * it, so the hand traces an arc above the shoulder.
   */
  wave: (a, t) => ({
    rz: a * (RAISE + Math.sin(t * 9.5) * 0.3),
    rx: a * -0.2,
  }),

  /**
   * Both arms straight up, and a hop.
   *
   * `Math.abs` on the bob is what makes it a hop rather than a float: a raw
   * sine spends half its time below where the feet are, and a body sunk into
   * the floor at this camera reads as the shadow having come loose.
   */
  cheer: (a, t) => ({
    lz: a * -(RAISE + 0.25),
    rz: a * (RAISE + 0.25),
    bob: a * Math.abs(Math.sin(t * 5.5)) * 0.055,
  }),

  /**
   * Arms alternating, body rolling under them.
   *
   * The two arms are half a cycle apart and the roll is on the same beat, so
   * the body leans away from whichever arm is up. Slower than the wave on
   * purpose — a fast one is a scarecrow in a gale, and the sway is what carries
   * the read from across the shop rather than the arms.
   */
  dance: (a, t) => ({
    lz: a * -(HALF + Math.sin(t * 6) * 0.85),
    rz: a * (HALF + Math.sin(t * 6 + Math.PI) * 0.85),
    sway: a * Math.sin(t * 3) * 0.13,
    bob: a * Math.abs(Math.sin(t * 6)) * 0.022,
  }),

  /**
   * One arm straight out in front, held.
   *
   * The only pose with no oscillation in it, and that is the point: it means
   * "that one, over there", so anything that moved would be pointing at two
   * places. A touch of `z` keeps the arm clear of the chest, which it would
   * otherwise be drawn straight through at this camera.
   */
  point: (a) => ({
    rx: a * -1.75,
    rz: a * 0.28,
  }),
};

/**
 * ...and what a body with NO ARMS does instead.
 *
 * `buildActor` draws a hire from their kind's authored `model`, and an authored
 * model has no walk rig on it — `walker` is null for every robot anybody has
 * drawn. So the four poses above reach you, they reach every shopper, and they
 * reach exactly the hires nobody has authored art for. A crew that stood
 * perfectly still while the customers waved back would read as the staff being
 * broken, which is the failure the wave-back exists to prevent, arriving one
 * file along.
 *
 * It is deliberately ONE shape rather than four. A pose is a statement and this
 * is an acknowledgement — a machine dipping and bobbing on the beat says "yes,
 * you" and cannot say "I am dancing", and pretending otherwise would mean
 * authoring four body-only poses that all read the same at this camera. Paired
 * with the turn, which is the half that actually carries it: the whole body
 * squares up to you.
 */
const ARMLESS = (a, t) => ({
  bob: a * Math.abs(Math.sin(t * 5)) * 0.05,
  dip: a * 0.1,
});

/**
 * One body, one frame.
 *
 * `rec` is a `syncActors` record. `rec.emote` and `rec.emoteAt` are what the
 * shop last said; everything else in here is ours and is kept on the record
 * beside `slump` and `gait`, for the same reason those are.
 *
 * Returns nothing and costs a property read for anybody who is not emoting,
 * which is every body in the shop nearly all of the time.
 *
 * @param turnTo a heading to face while the pose is up, or null to stay put.
 *   Passed rather than read off the record because the answer differs by WHO:
 *   a shopper waving back turns to the camera (half the shop has its back to
 *   you at any moment, and what is behind one of these robots is a flat
 *   panel), while YOU keep the facing you steered — a body that spun to face
 *   the camera the moment you pressed a key is the walk fighting the emote.
 */
export function animateEmote(rec, now, turnTo = null) {
  const kind = rec.emote;
  if (!kind) return;
  const spec = EMOTES[kind];
  const pose = POSE[kind];
  // A kind this build has never heard of. The shop refuses those, so this is
  // only reachable across a version skew in co-op — and the honest answer is to
  // draw an ordinary body rather than to throw once a frame for two seconds.
  if (!spec || !pose) { clearEmote(rec); return; }

  // Restart on a new stamp rather than on a new kind. Two waves running are the
  // same string; the stamp is the only thing that differs, which is why the
  // shop sends it.
  if (rec.emoteSeen !== rec.emoteAt) {
    rec.emoteSeen = rec.emoteAt;
    rec.emoteStart = now / 1000;
    // How much of the pose was *already* up when this one landed. Waving again
    // mid-wave otherwise drops the arm to the floor and lifts it back, which
    // reads as the second press having interrupted the first.
    rec.emoteFrom = rec.emoteAmount ?? 0;
  }

  const t = now / 1000 - rec.emoteStart;
  // A stamp in the future is somebody who has not got round to answering yet
  // (`answerWave`), and the pose is simply not up yet — the arm stays where the
  // walk put it, and the beat lands where the shop put it.
  if (t < 0) return;
  if (t >= spec.seconds) { clearEmote(rec); return; }

  const amount = envelope(t / spec.seconds, rec.emoteFrom ?? 0);
  rec.emoteAmount = amount;
  apply(rec, (rec.walker ? pose : ARMLESS)(amount, t), amount, turnTo);
}

/**
 * 0 → 1 → 0 across the emote, starting from wherever the arms already were.
 *
 * `from` is what makes a second press smooth: the rise is blended off it rather
 * than off zero, so an emote that lands over one already up begins at the
 * height it found instead of dropping first.
 *
 * A cosine rather than a linear ramp, because the arm is a lever and the eye
 * reads the ACCELERATION at both ends — the same reason nothing else in this
 * renderer eases linearly.
 */
function envelope(p, from) {
  const ease = (x) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
  const up = from + (1 - from) * ease(p / RAMP);
  const down = ease((1 - p) / RAMP);
  return Math.min(up, down);
}

/**
 * Write one frame of a pose onto the body.
 *
 * The two arms' `rotation.x` is ADDED to rather than assigned, because
 * `animateActors` has already written the walk's counter-swing into it this
 * frame and a wave is meant to lay over a walk. `rotation.z` is assigned,
 * because nothing else in the renderer writes it — and assigning is what lets
 * the last frame of the envelope leave a clean zero behind.
 *
 * The BODY's own three fields are the ones with owners, and each is left alone
 * rather than shared:
 *
 * - `position.y` and `rotation.x` belong to `animateRest` while somebody is on
 *   a break — it sinks them onto their legs and dips them forward, and that
 *   pass runs before this one. So a charging bot who is waved at waves with
 *   their arms and does not stand back up; otherwise the two write the same
 *   field on alternate frames and the body vibrates. `owns` is the test, and it
 *   asks `slump` as well as `resting`, because standing back UP is a second of
 *   easing during which that pass is still writing.
 * - `rotation.z` belongs to `animateMoods`, which is a cross shopper's shake.
 *   Only a pose that actually rolls the body (the dance) touches it, so a wave
 *   leaves an angry shopper trembling exactly as it found them.
 * - `rotation.y` is the facing, rewritten by `syncActors` ten times a second —
 *   so the turn is BLENDED off `rec.yaw` rather than accumulated onto the mesh,
 *   or it would be yanked back every sync and never arrive. That is
 *   `animateRest`'s own trick, borrowed for the same reason.
 */
function apply(rec, p, amount, turnTo) {
  const w = rec.walker;
  if (w) {
    w.leftArm.rotation.z = p.lz ?? 0;
    w.rightArm.rotation.z = p.rz ?? 0;
    if (p.lx) w.leftArm.rotation.x += p.lx;
    if (p.rx) w.rightArm.rotation.x += p.rx;
  }
  if (!owns(rec)) return;
  rec.obj.position.y = p.bob ?? 0;
  // The armless dip, which is the one thing here that shares a field with the
  // break. `owns` has already said the break is not using it.
  if (p.dip !== undefined) {
    rec.obj.rotation.x = p.dip;
    rec.emoteDip = true;
  }
  if (p.sway !== undefined) {
    rec.obj.rotation.z = p.sway;
    rec.emoteSway = true;
  }
  if (turnTo != null && rec.yaw != null) {
    const TAU = Math.PI * 2;
    // The short way round, or a body two degrees the wrong side of south spins
    // most of a full turn to say hello.
    const d = ((turnTo - rec.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
    rec.obj.rotation.y = rec.yaw + d * amount;
  }
}

/** Whether the BODY's own transform is ours this frame, or a break's. */
const owns = (rec) => !rec.resting && !rec.slump;

/**
 * Put everything back and forget the emote.
 *
 * Called on the frame after the last one, when the envelope has already written
 * zeroes — so this is belt and braces for the two ways an emote can end without
 * running down: a version skew, and a snapshot that stops mentioning one
 * because the shop expired it early.
 */
function clearEmote(rec) {
  const w = rec.walker;
  if (w) {
    w.leftArm.rotation.z = 0;
    w.rightArm.rotation.z = 0;
  }
  if (owns(rec)) {
    rec.obj.position.y = 0;
    // Only if we ever wrote them. `animateMoods` owns `rotation.z` for a cross
    // shopper and `animateRest` owns `rotation.x` for a hire on a break, so
    // zeroing either unasked would stop somebody else's animation — a rendering
    // fault that only shows up in a busy shop.
    if (rec.emoteSway) rec.obj.rotation.z = 0;
    if (rec.emoteDip) rec.obj.rotation.x = 0;
  }
  rec.emoteSway = false;
  rec.emoteDip = false;
  rec.emote = null;
  rec.emoteAmount = 0;
}
