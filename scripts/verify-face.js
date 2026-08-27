#!/usr/bin/env node
/**
 * VERIFY: THE FACE, WHICH IS SEVEN BOXES AND A LOT OF WAYS TO BE WRONG.
 *
 * A face is drawn at about eight pixels in an ordinary frame, which is exactly
 * what makes this worth a sweep rather than a screenshot: at that size every
 * failure below draws as *a face*. A shopper whose brows never move, one whose
 * brows move the wrong way, one who never blinks and one who blinks in perfect
 * time with the other nineteen all look, in a still frame, like a small
 * cream-coloured head.
 *
 * Four of its claims are about things that would look CORRECT:
 *
 * - **The angle flips sign.** The art is authored with the outer end of each
 *   brow slightly down, which is a faintly concerned resting face. Scowling
 *   reverses that and overshoots; beaming flattens it. Carry one signed term
 *   through zero instead — which is the obvious way to write it, and is how it
 *   was written first — and a delighted shopper gets the resting slope twice as
 *   steep, which is a *pleading* face worn by everybody having a nice time.
 *   Nothing anywhere would say a word.
 *
 * - **`write` is pure.** It recomposes each local matrix from the authored
 *   numbers rather than adjusting the matrix that is there. Adjusting compounds
 *   — a brow drifts up a thousandth a frame and walks off the top of the head
 *   over about a minute, which presents as art that is fine when you look at it
 *   and broken when you come back.
 *
 * - **The blink is not in unison.** A crowd blinking together is the one thing
 *   a crowd cannot do, and it is invisible in every still frame ever taken of
 *   it. So: two bodies, a minute, and the frames they are shut on must differ.
 *
 * - **It actually moves.** `animateFace` early-returns on an unchanged
 *   signature, which is what keeps eighty faces free — and a signature that
 *   never changes is a face that never moves and is indistinguishable from one
 *   that does until something happens in the shop.
 *
 * Its control is the pair that says who this is opt-in for: a body with no
 * batch (an authored hire — `trim` is WELDED in the mesh path, so there is
 * nothing in there to move an eyebrow of) must be untouched and must not throw,
 * and a body with no mood at all — you, and every hire — must sit at exactly
 * neutral, because patience is a shopper's resource and a shopkeeper's face
 * reporting one would be showing a number that does not exist.
 *
 * It writes nothing: no content rows, no save, no database, no renderer. Every
 * function it calls is pure and every body it needs it authors in memory, the
 * way `verify:motion` does.
 *
 *   node scripts/verify-face.js
 */

import * as THREE from 'three';
import { characterParts, crowdLocals } from '../client/render/props.js';
import { animateFace } from '../client/render/face.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * The three colours the face is authored in, restated rather than imported.
 *
 * This is what pins the INDICES to the right boxes, and it is the assertion
 * that catches the trap `characterParts` names: a part inserted above the face
 * block shifts every index below it by one, and what that draws is a shopper
 * blinking with their hair. Restated, because importing the constants would
 * make the claim "the parts the code says are brows are the parts the code says
 * are brows".
 */
const SCLERA = '#fdfaf4';
const PUPIL = '#2b323b';
const BROW = '#6d5a4a';
const MOUTH = '#95604f';

/** One body, ready to be animated. No scene, no batch, no slots — just the maths. */
function body(id, { mood = null, anger = null } = {}) {
  const desc = characterParts('#7aa3c8', { variant: id, varied: true });
  const rec = {
    obj: { userData: { crowd: { desc, locals: crowdLocals(desc) } } },
    // The same hash the renderer uses, restated the same way `scene.js` mints
    // it, so two bodies here differ exactly as two bodies in a shop do.
    phase: (hashId(id) % 628) / 100,
    mood,
    anger,
  };
  return rec;
}

/** `hashId` from render/scene.js, restated — it is not exported and need not be. */
function hashId(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
  return Math.abs(h % 997);
}

const F = (rec) => rec.obj.userData.crowd.desc.face;
const local = (rec, i) => rec.obj.userData.crowd.locals[i];

/** One part's position and scale, back out of its composed matrix. */
function decomposed(rec, i) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local(rec, i).decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q);
  return { p, s, rz: e.z };
}

/** Draw a body at one expression, from scratch, and hand back the face. */
function at(mood, anger = null, t = 0.5) {
  const rec = body('zz-face', { mood, anger });
  animateFace(rec, t * 1000);
  return rec;
}

// ---------------------------------------------------------------------------
// 1. THE INDICES NAME THE RIGHT BOXES.
//
//    Against the authored colours, so a part inserted above the face block
//    fails here rather than four sections down as "the mouth does not widen".
// ---------------------------------------------------------------------------
{
  const rec = body('zz-index');
  const { desc } = rec.obj.userData.crowd;
  const face = desc.face;
  eq(face.eyes.length, 2, 'there are two eyes');
  eq(face.pupils.length, 2, '...two pupils');
  eq(face.brows.length, 2, '...two brows');
  check(face.mouth >= 0, '...and a mouth');
  for (const i of face.eyes) eq(desc.parts[i].colour, SCLERA, 'an eye is the sclera colour');
  for (const i of face.pupils) eq(desc.parts[i].colour, PUPIL, 'a pupil is the pupil colour');
  for (const i of face.brows) eq(desc.parts[i].colour, BROW, 'a brow is the brow colour');
  eq(desc.parts[face.mouth].colour, MOUTH, 'and the mouth is the mouth colour');
  // One each side, or a "pair" is the same box twice and half the face never
  // moves — which reads as a shopper with a lazy eye rather than as a bug.
  const sides = face.brows.map((i) => Math.sign(desc.parts[i].position[0]));
  check(sides.includes(-1) && sides.includes(1), 'and there is one of each on each side');
  // The whole face is one weld batch in the mesh path. This is what makes the
  // mesh fallback cheap and is exactly why it cannot animate — asserted so that
  // "the face does not move in a thumbnail" stays a known consequence rather
  // than becoming a bug report.
  const ids = new Set([...face.eyes, ...face.pupils, ...face.brows, face.mouth]
    .map((i) => desc.parts[i].weldId));
  eq(ids.size, 1, 'and every part of it welds into one mesh outside the batch');
}

// ---------------------------------------------------------------------------
// 2. IT MOVES, AND IT MOVES MONOTONICALLY.
//
//    A signature that never changed is a face that never moves, which is what
//    the early-out could quietly become. Monotone rather than merely different,
//    because "scowl and grin differ" is satisfied by a face that jumps about.
// ---------------------------------------------------------------------------
{
  const moods = [0, 0.25, 0.5, 0.7, 0.85, 1];
  const widths = [];
  const brows = [];
  for (const m of moods) {
    // Below 0.5 the sim would be sending an `anger`, so the sweep sends one
    // too — `cheerOf` reads that branch, and a mood alone down there is a state
    // no shop ever produces.
    const anger = m < 0.5 ? (0.5 - m) / 0.3 : null;
    const rec = at(m, anger);
    widths.push(decomposed(rec, F(rec).mouth).s.x);
    brows.push(decomposed(rec, F(rec).brows[0]).p.y);
  }
  for (let i = 1; i < widths.length; i++) {
    check(widths[i] > widths[i - 1], `the mouth widens from mood ${moods[i - 1]} to ${moods[i]}`,
      `${widths[i - 1]} -> ${widths[i]}`);
    check(brows[i] > brows[i - 1], `...and the brows rise with it`,
      `${brows[i - 1]} -> ${brows[i]}`);
  }
  check(widths.at(-1) / widths[0] > 1.5, 'and a grin is a visibly wider mouth than a scowl',
    `only ${(widths.at(-1) / widths[0]).toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
// 3. THE ANGLE FLIPS SIGN — the bug that looks correct.
//
//    Rest is authored outer-end-down. A scowl has to cross to the other side of
//    that, and a grin has to FLATTEN toward zero rather than carry on past
//    rest, which is the pleading face nobody asked for.
// ---------------------------------------------------------------------------
{
  const rest = body('zz-rest').obj.userData.crowd.desc;
  for (const side of [0, 1]) {
    const idx = rest.face.brows[side];
    const s = Math.sign(rest.parts[idx].position[0]);
    const authored = rest.parts[idx].rot[2];
    const scowl = decomposed(at(0.2, 1), idx).rz;
    const grin = decomposed(at(1), idx).rz;
    const flat = decomposed(at(0.5), idx).rz;
    check(Math.sign(scowl) !== Math.sign(authored),
      `the ${s > 0 ? 'right' : 'left'} brow's angle reverses to scowl`,
      `rest ${authored}, scowl ${scowl}`);
    check(Math.abs(grin) < Math.abs(authored) + 1e-9,
      `...and FLATTENS to grin rather than steepening past rest`,
      `rest ${authored}, grin ${grin}`);
    check(Math.abs(grin) < 1e-9, `...all the way to flat at the top of the scale`, `${grin}`);
    check(Math.abs(flat - authored) < 1e-9,
      `...and neutral is the angle the art was drawn with`, `${flat} vs ${authored}`);
  }
  // Mirrored, or one eyebrow is doing the opposite of the other and the face
  // reads as a wink it never meant.
  const [l, r] = rest.face.brows;
  const scowlL = decomposed(at(0.2, 1), l).rz;
  const scowlR = decomposed(at(0.2, 1), r).rz;
  check(Math.abs(scowlL + scowlR) < 1e-9, 'and the two brows scowl as a mirrored pair',
    `${scowlL} / ${scowlR}`);
}

// ---------------------------------------------------------------------------
// 4. THE BLINK HAPPENS, IT CLOSES, AND IT IS RARE.
//
//    All three, because each of the others is satisfied by the wrong answer:
//    "it closes" passes on a face permanently shut, and "it is rare" passes on
//    one that never blinks at all.
// ---------------------------------------------------------------------------
{
  const rec = body('zz-blink');
  const eye = F(rec).eyes[0];
  const open = rec.obj.userData.crowd.desc.parts[eye].scale[1];
  let shut = 0;
  let tightest = open;
  const FRAMES = 60 * 60; // a minute at 60fps
  for (let f = 0; f < FRAMES; f++) {
    animateFace(rec, (f / 60) * 1000);
    const y = decomposed(rec, eye).s.y;
    if (y < open * 0.5) shut++;
    tightest = Math.min(tightest, y);
  }
  check(shut > 0, 'somebody blinks at least once a minute');
  check(tightest < open * 0.2, '...and the eye actually closes', `got down to ${tightest / open}`);
  check(shut / FRAMES < 0.05, '...and is open for nearly all of it',
    `shut for ${((shut / FRAMES) * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 5. AND NOT IN UNISON. The one thing a crowd cannot do.
// ---------------------------------------------------------------------------
{
  const a = body('zz-one');
  const b = body('zz-two');
  const eyeA = F(a).eyes[0];
  const eyeB = F(b).eyes[0];
  const openA = a.obj.userData.crowd.desc.parts[eyeA].scale[1];
  const openB = b.obj.userData.crowd.desc.parts[eyeB].scale[1];
  let together = 0;
  let apart = 0;
  for (let f = 0; f < 60 * 60; f++) {
    const now = (f / 60) * 1000;
    animateFace(a, now);
    animateFace(b, now);
    const sa = decomposed(a, eyeA).s.y < openA * 0.5;
    const sb = decomposed(b, eyeB).s.y < openB * 0.5;
    if (sa && sb) together++;
    if (sa !== sb) apart++;
  }
  check(apart > 0, 'two people do not blink on the same frames');
  check(together === 0, '...and never on the same frame at all over a minute',
    `${together} frames in unison`);
  check(a.phase !== b.phase, 'and it is their own phase that separates them');
}

// ---------------------------------------------------------------------------
// 6. IT IS PURE. Six hundred frames of one expression is one expression.
//
//    The named silent failure: a `write` that adjusted the matrix it found
//    would compound, and a brow drifting a thousandth a frame walks off the top
//    of the head over about a minute. It looks fine when you look at it.
// ---------------------------------------------------------------------------
{
  const once = at(0.9, null, 0);
  const many = body('zz-face', { mood: 0.9, anger: null });
  // A whole minute, at a moment that is never mid-blink for this body — the
  // claim is about the EXPRESSION not drifting, and a frame caught mid-blink
  // would be a different face for an honest reason.
  for (let f = 0; f < 600; f++) animateFace(many, f * 16.6);
  animateFace(many, 0);
  for (const i of [...F(many).brows, ...F(many).eyes, ...F(many).pupils, F(many).mouth]) {
    const x = decomposed(once, i);
    const y = decomposed(many, i);
    check(x.p.distanceTo(y.p) < 1e-9 && x.s.distanceTo(y.s) < 1e-9,
      `part ${i} is in the same place after six hundred frames`,
      `${x.p.toArray()} vs ${y.p.toArray()}`);
  }
}

// ---------------------------------------------------------------------------
// 7. NOTHING LEAVES THE HEAD, at any expression.
//
//    A brow that slid off the temple at full scowl, or a mouth wider than the
//    face at full grin, only ever shows up in a shop that is already having a
//    bad day — which is the one time nobody is looking at the art.
// ---------------------------------------------------------------------------
{
  for (const [mood, anger] of [[0.2, 1], [0.35, 0.5], [0.5, 0], [0.75, null], [1, null]]) {
    const rec = at(mood, anger);
    const { desc } = rec.obj.userData.crowd;
    const h = desc.parts[desc.head];
    const hx = h.scale[0] / 2;
    const hy = h.scale[1] / 2;
    for (const i of [...F(rec).brows, ...F(rec).eyes, ...F(rec).pupils, F(rec).mouth]) {
      const { p, s } = decomposed(rec, i);
      // The half-extent of a rotated box on an axis is the sum of its own
      // half-extents times the rotation's, which is what `Box3` would do the
      // long way round — and a brow is the one part that rotates.
      const { rz } = decomposed(rec, i);
      const cx = Math.abs(Math.cos(rz));
      const sn = Math.abs(Math.sin(rz));
      const ex = (s.x * cx + s.y * sn) / 2;
      const ey = (s.x * sn + s.y * cx) / 2;
      check(Math.abs(p.x - h.position[0]) + ex <= hx + 1e-9,
        `at mood ${mood}, part ${i} stays on the head sideways`,
        `${Math.abs(p.x - h.position[0]) + ex} > ${hx}`);
      check(Math.abs(p.y - h.position[1]) + ey <= hy + 1e-9,
        `...and vertically`, `${Math.abs(p.y - h.position[1]) + ey} > ${hy}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. THE CONTROL. Who this is opt-in for.
// ---------------------------------------------------------------------------
{
  // A body with no batch — every hire anybody has drawn art for. `trim` is
  // welded there, so there is nothing to move; it must not throw and must not
  // invent a crowd record.
  const bare = { obj: { userData: {} }, phase: 1, mood: 0.9, anger: null };
  animateFace(bare, 1000);
  check(!bare.obj.userData.crowd, 'a body with no batch is left completely alone');
  check(bare.faceSig === undefined, '...and is not even given a signature');

  // ...and you. No patience, therefore no expression — exactly neutral, and
  // exactly what a shopper sitting on the line wears.
  const you = at(null, null);
  const line = at(0.5, 0);
  for (const i of [...F(you).brows, F(you).mouth]) {
    const a = decomposed(you, i);
    const b = decomposed(line, i);
    check(a.p.distanceTo(b.p) < 1e-9 && a.s.distanceTo(b.s) < 1e-9
      && Math.abs(a.rz - b.rz) < 1e-9,
      `somebody with no mood wears the neutral face (part ${i})`);
  }
  // And neutral really is the art untouched, or "neutral" is a fifth expression
  // nobody authored and every face in the game has quietly changed.
  const { desc } = you.obj.userData.crowd;
  for (const i of [...F(you).brows, ...F(you).eyes, F(you).mouth]) {
    const { p, s } = decomposed(you, i);
    check(Math.abs(p.y - desc.parts[i].position[1]) < 1e-9
      && Math.abs(s.x - desc.parts[i].scale[0]) < 1e-9,
      `...which is the box exactly as it was authored (part ${i})`);
  }
}

// ---------------------------------------------------------------------------
// 9. AN UNCHANGED FACE COSTS NOTHING, which is what keeps eighty of them free.
//
//     Asserted by vandalising a matrix and watching it NOT be repaired: if the
//     early-out ever stops working this passes, and if the early-out is doing
//     its job the vandalism survives. It is the only honest way to observe a
//     function choosing not to run.
// ---------------------------------------------------------------------------
{
  const rec = body('zz-cheap', { mood: 0.9 });
  animateFace(rec, 0);
  const sig = rec.faceSig;
  local(rec, F(rec).mouth).makeScale(9, 9, 9);
  // A tenth of a second later: the same expression, and nowhere near a blink.
  animateFace(rec, 100);
  eq(rec.faceSig, sig, 'a face that has not changed keeps its signature');
  eq(decomposed(rec, F(rec).mouth).s.x, 9, '...and is not rewritten');
  // ...and the moment it DOES change, it is written again. Without this the
  // claim above is satisfied by a function that never runs twice.
  rec.mood = 0.5;
  animateFace(rec, 200);
  check(rec.faceSig !== sig, 'and a face that changes is written again');
  check(decomposed(rec, F(rec).mouth).s.x < 1, '...back onto the authored box');
}

// ---------------------------------------------------------------------------
// 10. THE FACE JOINS IN WITH THE ARMS.
//
//     Three claims, and the third is the one with an opinion in it. That a pose
//     grins at all; that `point` does NOT, because pointing is a thing you do
//     with a straight face and a shopkeeper beaming while they point at a shelf
//     reads as sarcasm; and that the grin is a BLEND rather than an override
//     that can be beaten — somebody halfway to storming out still grins while
//     they wave back, because they are waving back, and a scowl showing through
//     would read as the wave not having registered.
//
//     It rides `emoteAmount`, which `animateEmote` writes a few lines earlier in
//     the same loop. So the pair that keeps it honest is that a pose which has
//     not risen yet changes nothing: without it the face would be ahead of the
//     arm by the whole ramp, which is a grin arriving before the hand does.
// ---------------------------------------------------------------------------
{
  const wide = (rec) => decomposed(rec, F(rec).mouth).s.x;
  const plain = at(0.72);

  const mid = body('zz-face', { mood: 0.72 });
  Object.assign(mid, { emote: 'wave', emoteAmount: 1 });
  animateFace(mid, 500);
  check(wide(mid) > wide(plain), 'a wave widens the mouth beyond the mood alone',
    `${wide(plain)} -> ${wide(mid)}`);

  const pointing = body('zz-face', { mood: 0.72 });
  Object.assign(pointing, { emote: 'point', emoteAmount: 1 });
  animateFace(pointing, 500);
  check(Math.abs(wide(pointing) - wide(plain)) < 1e-9,
    '...and pointing at something does not', `${wide(plain)} vs ${wide(pointing)}`);

  // The cross shopper, which is the claim about precedence. Waving back has to
  // beat a scowl outright rather than averaging with it.
  const cross = at(0.25, 0.85);
  const crossWaving = body('zz-face', { mood: 0.25, anger: 0.85 });
  Object.assign(crossWaving, { emote: 'wave', emoteAmount: 1 });
  animateFace(crossWaving, 500);
  check(wide(crossWaving) > wide(cross) * 1.5,
    'and somebody cross still grins while they wave back',
    `${wide(cross)} -> ${wide(crossWaving)}`);

  // Not yet risen is not yet grinning, or the face is ahead of the arm.
  const rising = body('zz-face', { mood: 0.72 });
  Object.assign(rising, { emote: 'wave', emoteAmount: 0 });
  animateFace(rising, 500);
  check(Math.abs(wide(rising) - wide(plain)) < 1e-9,
    'and a pose that has not risen yet leaves the face where it was');
  // ...and half way up is half way there, or `emoteAmount` is a flag wearing a
  // float and the whole ramp does nothing.
  const half = body('zz-face', { mood: 0.72 });
  Object.assign(half, { emote: 'wave', emoteAmount: 0.5 });
  animateFace(half, 500);
  check(wide(half) > wide(plain) && wide(half) < wide(mid),
    'and half way through the pose is half way to the grin',
    `${wide(plain)} / ${wide(half)} / ${wide(mid)}`);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ verify:face — ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ verify:face — ${checks} checks passed`);
