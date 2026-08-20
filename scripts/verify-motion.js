#!/usr/bin/env node
/**
 * VERIFY: A MACHINE THAT IS RUNNING LOOKS LIKE IT.
 *
 * An appliance mid-batch and one nobody has loaded since Tuesday drew the same
 * picture until `work` and `motion` existed. Everything this sweep guards about
 * them is invisible — not "invisible in a screenshot of one seed", but
 * invisible in a screenshot *full stop*, because a still frame of a machine
 * cannot show you whether the thing was moving.
 *
 * Five claims, each of which fails as something other than itself:
 *
 * - **A part flagged `motion` becomes a moving part, and the right one.**
 *   `buildModel` drops `seam` parts on the way past, so the meshes are not the
 *   parts — matching them up by index afterwards spins the box next to the one
 *   you flagged, which reads as bad art rather than as bad wiring. So the
 *   collection has to happen where the meshes are made, and this asserts it
 *   survives a dropped seam.
 * - **A spin accumulates.** Read off the clock and eased to zero, a stopping
 *   blade drags itself back to where it was drawn — a machine that rewinds as it
 *   slows. Nobody would think to look for that, and it is one line either way.
 * - **An idle machine sits exactly where it was drawn.** Not approximately: a
 *   pose that settles a hair off is a fixture that quietly moved house, and it
 *   would take a diff of two screenshots to ever notice.
 * - **`work` is staged by the BATCH, not by the tier.** They are two 0..1s and
 *   one resolver, and the whole reason `work` is a second model is that the
 *   first one's is already spent. A `work` that answered to the tier would look
 *   perfect on a tier-1 machine and freeze on stage 1 forever after.
 * - **A variant's own working look beats the piece's, and the piece's is the
 *   fallback.** Every appliance is a variant of one `station` row, so a
 *   fallback that pointed the wrong way is six machines steaming out of the
 *   same corner — which reads as bad authoring on five of them.
 *
 * ...and since props could be told what the shop is doing, three more, which are
 * the same argument pointed at a thing that moves because of the WORLD rather
 * than because of itself. A clock is the one prop in the game whose art can be
 * wrong in a way you could in principle see — you could hold it up against the
 * HUD — and every way it actually breaks is not that:
 *
 * - **A sweep is a pose, not a loop.** Everything above accumulates and eases,
 *   which is right for a blade and ruinous for a hand: eased, a clock is wrong
 *   for the first half-second of every session, and accumulated it drifts off
 *   the time it is supposed to be telling. So the same number has to give the
 *   same angle for ever, whatever the part did before.
 * - **A hand hinges at the PIVOT.** Turned about its own middle — which is what
 *   every other kind of motion does and therefore what this would inherit — a
 *   hand is a compass needle: a bar sticking out of both sides of the boss,
 *   pointing at two times at once. The tail end has to stay still.
 * - **Turning is clockwise, and a signed `turns` is the other side of the
 *   case.** A double-sided sign is one hand drawn twice, and the far copy is
 *   watched from the far side — so two faces that turn the same way are one face
 *   running backwards, which is a thing you would look at for a while.
 *
 * Plus what the signal itself is worth, which is where the quiet one lives:
 * `open` is the shop SERVING, not the shutters. A sign wired to the shutters
 * reads OPEN all night, every night, and looks completely correct doing it.
 *
 * Unlike `verify:catalog` this writes NOTHING: every piece it needs is built
 * here and every function it calls is pure, so it can be run against the live
 * database with no cleanup and nothing to leak.
 *
 *   node scripts/verify-motion.js
 */

import { FixtureSchema } from '../shared/schemas.js';
import { partsAt, variantWork, variantModel, tierProgress, stageIndexAt } from '../shared/model.js';
import { SIGNAL_NAMES, signalValue } from '../shared/signals.js';
import { buildModel } from '../client/render/props.js';
import { buildLoopingProp, animateMotion, animatePuffs } from '../client/render/motion.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const box = (color, extra = {}) => ({
  shape: 'box', color, pos: [0, 0.5, 0], scale: [0.3, 0.1, 0.1], ...extra,
});

/**
 * A machine authored for this sweep, and deliberately not the shipped one.
 *
 * The same argument `verify:catalog` makes about giving its test shelf a
 * shorter ladder: asserting against the content that happens to be in the game
 * is asserting that nobody has edited it, and content is edited live, by two
 * people, every evening.
 */
const PIECE = {
  id: 'verify-machine',
  kind: 'station',
  name: 'Test Machine',
  model: {
    stages: [
      { name: 'Domestic', at: 0, parts: [box('#111111')] },
      { name: 'Commercial', at: 1, parts: [box('#222222'), box('#333333')] },
    ],
  },
  work: { parts: [box('#f0f0f0')] },
  variants: [
    {
      id: 'own',
      name: 'Has its own',
      model: { parts: [box('#aaaaaa'), box('#bbbbbb', { motion: { kind: 'shake', hz: 8, amount: 0.02 } })] },
      work: {
        stages: [
          { name: 'Early', at: 0, parts: [box('#c0ffee')] },
          { name: 'Late', at: 0.6, parts: [box('#c0ffee'), box('#facade')] },
        ],
      },
    },
    {
      id: 'borrows',
      name: 'Borrows the piece one',
      model: { parts: [box('#dddddd')] },
    },
  ],
  tiers: [
    { name: 'Domestic', cost: 0 },
    { name: 'Commercial', cost: 100, speed_mult: 2 },
  ],
};

// ---------------------------------------------------------------------------
// 1. The gate takes it, and takes it as authored.
//
// A field the schema silently drops is a field that works right up until it is
// read back out of the database, which is a different session and a different
// person.
// ---------------------------------------------------------------------------
const parsed = FixtureSchema.safeParse(PIECE);
check(parsed.success, 'the schema accepts a piece with a working look',
  parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

const piece = parsed.success ? parsed.data : PIECE;
check(!!piece.work, '`work` survives validation on the piece');
check(!!piece.variants.find((v) => v.id === 'own').work, '...and on a variant that has one');
eq(piece.variants.find((v) => v.id === 'borrows').work, null, '...and is null on one that does not');
eq(piece.variants[0].model.parts[1].motion.kind, 'shake', '`motion` survives on a part');
eq(piece.variants[0].model.parts[0].motion, null, '...and a part without one says so rather than going missing');

{
  const bad = FixtureSchema.safeParse({
    ...PIECE, variants: [{ ...PIECE.variants[0], model: { parts: [box('#aaaaaa', { motion: { kind: 'wobble' } })] } }],
  });
  check(!bad.success, 'a motion nobody implemented is refused at the gate');
}

// ---------------------------------------------------------------------------
// 2. Which working look a machine gets.
// ---------------------------------------------------------------------------
eq(variantWork(piece, 'own').stages.length, 2, 'a variant with its own work uses it');
eq(variantWork(piece, 'borrows'), piece.work, 'and one without falls back to the piece');
eq(variantWork(piece, ''), piece.work, 'as does the standard shape');
eq(variantWork(piece, 'nobody-authored-this'), piece.work,
  'and so does a shape that no longer exists, rather than nothing');
eq(variantWork({ ...piece, work: null }, 'borrows'), null,
  'a piece with no working look anywhere answers null, which is every fixture that predates this');

// ---------------------------------------------------------------------------
// 3. `work` answers to the batch, `model` answers to the tier.
//
// The whole reason there are two models. If this ever collapses into one, a
// machine's working look freezes at whatever stage its tier lands on.
// ---------------------------------------------------------------------------
{
  const work = variantWork(piece, 'own');
  // The STANDARD shape, because that is the one whose model is staged by tier —
  // which is the half of this claim that needs a ladder to be about anything.
  const model = variantModel(piece, '');

  eq(stageIndexAt(work, 0), 0, 'a batch that has just started draws its first stage');
  eq(stageIndexAt(work, 0.99), 1, 'and one about to finish draws its last');
  eq(partsAt(work, 0).length, 1, 'which is a different picture');
  eq(partsAt(work, 1).length, 2, '...from the other end of the batch');

  const tier1 = tierProgress(1, piece.tiers.length);
  const tier2 = tierProgress(2, piece.tiers.length);
  eq(partsAt(model, tier1).length, 1, 'the machine itself is what its tier says');
  eq(partsAt(model, tier2).length, 2, '...and steps up when the tier does');

  // The two numbers are not interchangeable, which is the whole reason `work`
  // is a second model rather than more parts on the first. Fed the tier, this
  // machine's working look would sit on stage 1 for the entire life of a
  // Commercial one — a batch that is always finished, and never seen starting.
  check(stageIndexAt(work, tier2) !== stageIndexAt(work, 0.1),
    'a tier and a batch pick different stages, so nothing may pass one where the other is meant');
}

// ---------------------------------------------------------------------------
// 4. A flagged part becomes a moving part — and survives a dropped seam.
//
// The trap this exists for: `buildModel` skips `seam` parts against a
// neighbour, so a moving part collected by index afterwards is the wrong mesh.
// ---------------------------------------------------------------------------
{
  const model = {
    parts: [
      box('#e00000', { seam: true, pos: [0, 0.5, 0.45] }),
      box('#00e000'),
      box('#0000e0', { motion: { kind: 'spin', hz: 4 } }),
    ],
  };
  const open = buildModel(model, {});
  eq(open.userData.moving.length, 1, 'one flagged part, one moving part');
  eq(open.userData.moving[0].mesh.material.color.getHexString(), '0000e0',
    'and it is the part that was flagged');

  const closed = buildModel(model, { abuts: () => true });
  eq(closed.children.length, 2, 'a seam against a neighbour is dropped, as it always was');
  eq(closed.userData.moving.length, 1, 'and the moving part is still one');
  eq(closed.userData.moving[0].mesh.material.color.getHexString(), '0000e0',
    'and is still the part that was flagged, not the one that took its index');

  eq(buildModel({ parts: [box('#123456')] }, {}).userData.moving.length, 0,
    'a model with nothing flagged has no moving parts and says so with a list');
}

// ---------------------------------------------------------------------------
// 5. What running and stopping actually do.
// ---------------------------------------------------------------------------
{
  const g = buildLoopingProp([
    box('#0000e0', { motion: { kind: 'spin', hz: 4 } }),
    { shape: 'sphere', color: '#eef4f6', pos: [0, 1, 0], scale: [0.2, 0.2, 0.2], alpha: 0.5, drift: true },
  ]);
  eq(g.userData.moving.length, 1, 'a looping prop collects its moving parts');
  eq(g.userData.puffs.length, 1, 'and its drifting ones separately');
  eq(g.userData.held.children.length, 1, 'the solid half is everything that is not drifting');

  const m = g.userData.moving[0];
  const drawn = m.mesh.rotation.y;

  // Idle. Not "close to" where it was drawn — exactly, or a machine nobody has
  // touched has quietly moved.
  for (let i = 0; i < 120; i++) animateMotion(g.userData.moving, i / 60, false);
  eq(m.mesh.rotation.y, drawn, 'an idle machine sits exactly where it was drawn');

  for (let i = 120; i < 180; i++) animateMotion(g.userData.moving, i / 60, true);
  check(m.mesh.rotation.y > drawn + 1, 'a second of running turns it', `${m.mesh.rotation.y.toFixed(2)} rad`);

  // Winding down. The claim is the direction: a blade that slows must not walk
  // backwards toward the pose it was authored in.
  let last = m.mesh.rotation.y;
  let backwards = 0;
  for (let i = 180; i < 600; i++) {
    animateMotion(g.userData.moving, i / 60, false);
    if (m.mesh.rotation.y < last - 1e-9) backwards++;
    last = m.mesh.rotation.y;
  }
  eq(backwards, 0, 'and stopping never turns it back the way it came');

  const stopped = m.mesh.rotation.y;
  for (let i = 600; i < 900; i++) animateMotion(g.userData.moving, i / 60, false);
  eq(m.mesh.rotation.y, stopped, 'a stopped blade stays stopped');

  // ...and the three that go back to a pose really do go back to it.
  for (const kind of ['bob', 'shake', 'pulse']) {
    const p = buildLoopingProp([box('#0000e0', { motion: { kind, hz: 5, amount: 0.05 } })]);
    const rec = p.userData.moving[0];
    const rest = { y: rec.mesh.position.y, x: rec.mesh.position.x, s: rec.mesh.scale.x };
    for (let i = 0; i < 90; i++) animateMotion(p.userData.moving, i / 60, true);
    const moved = rec.mesh.position.y !== rest.y || rec.mesh.position.x !== rest.x
      || rec.mesh.scale.x !== rest.s;
    check(moved, `\`${kind}\` moves while it runs`);
    for (let i = 90; i < 600; i++) animateMotion(p.userData.moving, i / 60, false);
    check(rec.mesh.position.y === rest.y && rec.mesh.position.x === rest.x
      && rec.mesh.scale.x === rest.s, `\`${kind}\` settles back to exactly the pose it was drawn in`,
    `${rec.mesh.position.y} / ${rec.mesh.position.x} / ${rec.mesh.scale.x}`);
  }

  // Steam climbs and thins, on a loop — it must never settle anywhere.
  const puff = g.userData.puffs[0];
  animatePuffs(g.userData.puffs, 0);
  const low = puff.obj.position.y;
  animatePuffs(g.userData.puffs, 1.2);
  check(puff.obj.position.y > low, 'a puff rises');
  animatePuffs(g.userData.puffs, 2.4);
  check(Math.abs(puff.obj.position.y - low) < 1e-6, 'and starts again rather than sailing off');
}

// ---------------------------------------------------------------------------
// 6. A prop that watches the shop.
// ---------------------------------------------------------------------------
{
  // A clock's hand: up at midnight, hinged at the middle of a face it does not
  // sit in the middle of. Thin on z, so the face it swings in is x/y.
  const HAND = {
    shape: 'box',
    color: '#3b3630',
    pos: [0, 0.575, 0.075],
    scale: [0.03, 0.15, 0.02],
    motion: { kind: 'sweep', turns: 24, pivot: [0, 0.5, 0.075] },
  };
  const at = (v, part = HAND) => {
    const g = buildModel({ parts: [part] }, {});
    animateMotion(g.userData.moving, 0, true, v);
    return g.userData.moving[0].mesh;
  };

  // -- the gate ------------------------------------------------------------
  {
    const good = FixtureSchema.safeParse({
      ...PIECE, kind: 'prop-ceiling', signal: 'time', model: { parts: [HAND] },
    });
    check(good.success, 'the schema accepts a piece that watches the shop',
      good.success ? '' : good.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    eq(good.success ? good.data.signal : null, 'time', '...and keeps which signal it watches');
    eq(good.success ? good.data.model.parts[0].motion.turns : null, 24, '...and how far a sweep turns');
    eq(good.success ? good.data.model.parts[0].motion.pivot?.[1] : null, 0.5, '...and where it hinges');

    const bad = FixtureSchema.safeParse({ ...PIECE, signal: 'vibes' });
    check(!bad.success, 'a signal nobody implemented is refused at the gate');
    eq(FixtureSchema.parse(PIECE).signal, null,
      'and a piece that watches nothing says so with a null, which is every piece that predates this');
  }

  // -- what a signal is worth ----------------------------------------------
  {
    eq(signalValue('time', { time: 0.25 }), 0.25, '`time` is how far through the day it is');
    eq(signalValue('time', {}), null, '...and a snapshot that does not say answers null rather than midnight');
    // The one that is invisible: a sign wired to the shutters reads OPEN all
    // night. `isOpen` is the shutters AND the trading day, and only that.
    eq(signalValue('open', { isOpen: true, shutters: true, trading: true }), 1,
      '`open` is 1 while the shop is serving');
    eq(signalValue('open', { isOpen: false, shutters: true, trading: false }), 0,
      '...and 0 at midnight with the shutters still up, which is the whole point of it');
    for (const name of SIGNAL_NAMES) {
      const v = signalValue(name, { time: 0.5, isOpen: true });
      check(v == null || (v >= 0 && v <= 1), `\`${name}\` answers inside 0..1`, `${v}`);
    }
    eq(signalValue('time', null), null, 'and nothing at all answers null rather than throwing');
  }

  // -- the stage swap ------------------------------------------------------
  {
    const sign = {
      stages: [
        { name: 'Closed', at: 0, parts: [box('#1d2024')] },
        { name: 'Open', at: 0.5, parts: [box('#ff6b5a'), box('#5fd3a0')] },
      ],
    };
    eq(stageIndexAt(sign, signalValue('open', { isOpen: false })), 0, 'a shut shop shows the shut face');
    eq(stageIndexAt(sign, signalValue('open', { isOpen: true })), 1, '...and an open one the open face');
    eq(partsAt(sign, 0).length, 1, 'which is a different picture');
    eq(partsAt(sign, 1).length, 2, '...from the other one');
    // The swap the tier ladder would otherwise have made. A watcher's stages are
    // the shop's answer, so a piece that resolved them by tier would hang a sign
    // that reads CLOSED until somebody upgraded it — and there is nothing to
    // upgrade, because a prop has one rung.
    eq(tierProgress(1, 1), 0, 'a one-rung ladder is 0 for ever, which is every prop');
    check(stageIndexAt(sign, tierProgress(1, 1)) !== stageIndexAt(sign, 1),
      'so a signal and a tier pick different stages, and nothing may pass one where the other is meant');
  }

  // -- a sweep is a pose ---------------------------------------------------
  {
    const g = buildModel({ parts: [HAND] }, {});
    const m = g.userData.moving[0];
    const drawn = m.mesh.position.clone();

    // No easing: one frame at a number is the whole answer. Everything else in
    // this file takes about a second to get where it is going.
    // A quarter past midnight, deliberately not a round part of a day: at 24
    // turns a day the minute hand is back where it started at six o'clock, so
    // half the obvious test values assert nothing at all.
    animateMotion(g.userData.moving, 0, true, 1 / 96);
    const first = m.mesh.position.clone();
    check(first.distanceTo(drawn) > 0.05, 'one frame puts a hand where the world says', `${first.x}`);

    // ...and it does not accumulate. A hundred frames of quarter past is quarter past.
    for (let i = 0; i < 100; i++) animateMotion(g.userData.moving, i / 60, true, 1 / 96);
    check(m.mesh.position.distanceTo(first) < 1e-9,
      'and holding it there for a hundred frames does not walk it round the face');

    // Midnight and midnight are the same pose, which is what "a pose" means.
    animateMotion(g.userData.moving, 5, true, 0);
    check(m.mesh.position.distanceTo(drawn) < 1e-9, 'and the same number is always the same angle');

    // A sweep with nothing to read holds still rather than snapping to zero:
    // the first layout of a session can arrive before any snapshot does.
    animateMotion(g.userData.moving, 6, true, 1 / 96);
    const held = m.mesh.position.clone();
    animateMotion(g.userData.moving, 7, true, null);
    check(m.mesh.position.distanceTo(held) < 1e-9, 'a sweep with no signal yet holds where it is');
    // And it is deliberately deaf to the thing every other kind listens to.
    animateMotion(g.userData.moving, 8, false, 1 / 96);
    check(m.mesh.position.distanceTo(held) < 1e-9,
      '...and does not wind down when the thing it is on stops working');
  }

  // -- the hinge, and which way round ---------------------------------------
  {
    const pivot = { x: 0, y: 0.5, z: 0.075 };
    const noon = at(0);
    check(Math.abs(noon.position.x - 0) < 1e-9 && noon.position.y > pivot.y,
      'at midnight a hand points straight up');

    // A quarter of one turn of the minute hand: 24 turns a day, so 1/96 of a day
    // is a quarter past. It must be at 3 o'clock and not at 9.
    const quarter = at(1 / 96);
    check(quarter.position.x > 0.05, 'a quarter of a turn later it is at three o\'clock, not nine',
      `x=${quarter.position.x.toFixed(3)}`);
    check(Math.abs(quarter.position.y - pivot.y) < 1e-6, '...level with the boss it hangs off');

    // The hinge. Turned about its own middle the hand's centre would not move at
    // all, which is the compass-needle bug: a bar poking out both sides.
    const armWas = Math.hypot(noon.position.x - pivot.x, noon.position.y - pivot.y);
    const armNow = Math.hypot(quarter.position.x - pivot.x, quarter.position.y - pivot.y);
    check(Math.abs(armWas - armNow) < 1e-6, 'a hand keeps its distance from the hinge as it goes round',
      `${armWas.toFixed(4)} then ${armNow.toFixed(4)}`);
    check(armWas > 0.05, '...and that distance is the offset it was drawn at, not nothing');
    check(Math.abs(quarter.position.z - pivot.z) < 1e-9, 'and never leaves the face it was drawn in');

    // A part with no pivot turns about its own middle, which is what a fan wants
    // and is the default every other kind of motion already has.
    const middle = at(1 / 96, { ...HAND, motion: { kind: 'sweep', turns: 24 } });
    check(Math.abs(middle.position.x - HAND.pos[0]) < 1e-9
      && Math.abs(middle.position.y - HAND.pos[1]) < 1e-9,
    'a sweep with no pivot named turns on the spot');

    // The far side of a double-sided face. Same hand, negative turns, so both
    // read clockwise from wherever you happen to be standing.
    const back = at(1 / 96, {
      ...HAND, pos: [0, 0.575, -0.075], motion: { kind: 'sweep', turns: -24, pivot: [0, 0.5, -0.075] },
    });
    check(back.position.x < -0.05, 'the far face of a double-sided prop turns the other way',
      `x=${back.position.x.toFixed(3)}`);

    // The axis is read off the box. A hand is thinnest on z and swings in x/y; a
    // blade is thinnest on y and sweeps the floor. Authoring one and getting the
    // other is a hand that swings edge-on into the wall it is hung on.
    const blade = at(1 / 4, {
      shape: 'box', color: '#8a6a4a', pos: [0.3, 0.5, 0], scale: [0.6, 0.02, 0.15],
      motion: { kind: 'sweep', turns: 1, pivot: [0, 0.5, 0] },
    });
    check(Math.abs(blade.position.y - 0.5) < 1e-9 && Math.abs(blade.position.z) > 0.05,
      'a part that lies flat sweeps the floor rather than the wall',
      `y=${blade.position.y} z=${blade.position.z.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:motion — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a running machine looks like one, and a stopped one stays where it was drawn.\n');
