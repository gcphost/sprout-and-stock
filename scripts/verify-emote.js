#!/usr/bin/env node
/**
 * VERIFY: THE FIRST THING ONE BODY EVER SAID TO ANOTHER.
 *
 * An emote is, on the face of it, the most visible feature in the game — an arm
 * goes up, and a screenshot settles it. That is exactly why this file exists,
 * because the arm is the half nobody has to check. Everything a wave must NOT
 * do is invisible, and each of those is a whole-save failure that draws
 * perfectly:
 *
 * - **The control.** A shop where nobody has waved must send the frame it
 *   always sent, on every player and every shopper. A field that is present as
 *   `null` rather than absent is bytes about nothing, ten times a second,
 *   forever, in a shop of eighty people — and it looks identical from a chair.
 *
 * - **The stream.** Every balance number in this repo is downstream of how many
 *   times `this.rng` has been called. Eight shoppers waving back is eight
 *   chances to draw a dither out of the measured stream, and if any of them
 *   did, two `simulate` runs either side of *adding a wave* would diverge with
 *   nothing in the output to say why. The stagger is `hash01` for that reason
 *   and this is the assertion that says so — it is the kit's own argument, and
 *   it is the one claim here that could quietly cost money.
 *
 * - **It stops.** The pose is expired by the SERVER against `elapsed`, so a
 *   wave that never ran out would be a field on the wire for the rest of the
 *   save and an arm up for the rest of the save — and a robot standing with its
 *   arm up is not obviously a bug, it is a robot.
 *
 * - **Nothing is saved.** `elapsed` restarts at zero on every load, which this
 *   repo has been bitten by four times (`plantedAt`, `yieldedAt`, `bornAt`,
 *   `arrivesAt`). A stamp that reached the save would put the pose in the
 *   future on the next load and the arm would never come down — and it would
 *   only show up on somebody else's machine, days later.
 *
 * Its sharp half is the wave-back, and the sharpness is that **each of its
 * rules is satisfied by the feature not working at all.** "Nobody far away
 * waves" passes in a shop where nobody waves; so does "a dancer is not
 * answered"; so does "somebody mid-wave is not restarted". So every refusal in
 * here is PAIRED with the thing it is refusing actually happening, in the same
 * shop, in the same breath. A sweep that only counted the noes would pass on a
 * `waveBack` whose body was deleted.
 *
 * It writes nothing at all: no content rows, no save, no cleanup. Every claim
 * is about a field on a person, and the one thing it needs a real shop for is
 * the snapshot.
 *
 *   node scripts/verify-emote.js
 */

import { Game } from '../server/sim/index.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { makeRng } from '../shared/rng.js';
import { hash01 } from '../shared/hash.js';
import { EMOTES, EMOTE_LIST, isEmote, WAVE_MOOD } from '../shared/emotes.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const close = (a, b, label, tol = 1e-9) => check(Math.abs(a - b) < tol, label, `expected ~${b}, got ${a}`);

/**
 * The two numbers the wave-back rests on, restated rather than imported.
 *
 * `verify:grace`'s rule about `GRACE_DAYS`, said about a radius: importing
 * `WAVE_REACH` would make "somebody four tiles away is not answered" pass
 * whatever that constant becomes, which is an assertion about nothing. If the
 * reach is ever retuned, this file is *supposed* to fail and be read.
 */
const REACH = 3.2;
const STAGGER = 0.75;

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/** A furnished shop with you standing in it and the shutters up. */
// Not the word this file is about, deliberately: §11 asserts that "emote"
// appears nowhere in a save, and a seed carrying it is a sweep failing on its
// own name.
function fresh(seed = 'gesture') {
  const g = Game.create({ worldId: 'verify-emote', seed, ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  silenceMilestones(g);
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.cash = 100000;
  g.addPlayer('me', 'Tester');
  g.open = true;
  g.time = 12 / 24;
  return g;
}

/**
 * A shopper standing exactly `d` tiles east of you, and nothing else about them.
 *
 * Hand-built rather than spawned, and that is deliberate for the geometry
 * claims: `spawnCustomer` puts somebody at the door and walks them, so a sweep
 * that used it would be asserting about a distance the pathing chose. Every
 * field `waveBack` reads is here and no other field is, which is also what
 * makes it obvious when that list grows.
 */
function shopperAt(g, id, d, mood = 0.7) {
  const p = g.players.me;
  const cu = { id, x: p.x + d, z: p.z, state: 'BROWSE', emote: null, mood };
  g.customers[id] = cu;
  return cu;
}

/** Whether somebody's pose is up right now, by the shop's own answer. */
const waving = (g, who) => !!g.emoteWire(who);

// ---------------------------------------------------------------------------
// 1. THE CONTROL. A shop nobody has waved in is the shop that always was.
//
//    Both lists, because they are two spreads in two places and a field added
//    to one is exactly the kind of thing that gets added to one. And the test
//    is `'emote' in p` rather than `p.emote == null`: the failure being guarded
//    is a key that is always present and usually null, which every truthiness
//    test in the world passes and every byte on the wire pays for.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spawned = g.spawnCustomer();
  const s = g.snapshot();
  check(s.players.length > 0, 'the control shop has somebody in it');
  for (const p of s.players) {
    check(!('emote' in p), 'a player who has not emoted carries no `emote` field');
    check(!('emoteAt' in p), '...and no stamp with it');
    check(!('emoteTo' in p), '...and nobody to be facing');
  }
  check(!!spawned, 'and a shopper walked in to be asked about');
  for (const c of s.customers) {
    check(!('emote' in c), 'a shopper who has not emoted carries no `emote` field');
    check(!('emoteAt' in c), '...and no stamp with it');
    check(!('emoteTo' in c), '...and nobody to be facing');
  }
}

// ---------------------------------------------------------------------------
// 1b. AN ANSWER IS AIMED AT SOMEBODY; AN EMOTE YOU MADE YOURSELF IS NOT.
//
//     The client turns a waver to face the person they are answering, and it
//     has to be told who — two people share this shop, so a client that assumed
//     "the local player" would turn the whole crowd to look at YOU when
//     somebody else waved at them. Which is a shop full of people facing the
//     wrong way, and it looks exactly like the turn being broken rather than
//     aimed at the wrong person.
//
//     The pair is the half that matters: your own wave must carry NO target, or
//     your body is handed its own id and spins to look at itself.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cu = shopperAt(g, 'zz-aimed', 1);
  g.emote('me', 'wave');
  eq(cu.emote.to, 'me', 'a shopper waving back knows who they are answering');
  eq(g.emoteWire(cu).emoteTo, 'me', '...and it is on the wire');
  eq('emoteTo' in g.emoteWire(g.players.me), false,
    'and your own wave is aimed at nobody');
  // ...which is also true of the other three, since nothing answers them.
  for (const kind of ['cheer', 'dance', 'point']) {
    const g2 = fresh();
    g2.emote('me', kind);
    eq('emoteTo' in g2.emoteWire(g2.players.me), false, `nor is a \`${kind}\``);
  }
}

// ---------------------------------------------------------------------------
// 2. THE STREAM. Waving at a crowded shop draws nothing from the rng.
//
//    The one claim in here that could cost money. `rng.weighted` closes over
//    its own generator, so counting calls from outside is not possible — asking
//    both streams for the next float once the wave is over is the only honest
//    way to tell what each consumed. This is `verify:spawn` §1's method, said
//    about a gesture instead of about a crowd.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = makeRng('control');
  const after = makeRng('control');
  g.rng = after;
  // A shop with plenty for a careless implementation to draw for: twelve
  // shoppers in reach and four out of it.
  for (let i = 0; i < 12; i++) shopperAt(g, `zz-near-${i}`, 1 + (i % 3) * 0.5);
  for (let i = 0; i < 4; i++) shopperAt(g, `zz-far-${i}`, REACH + 5);
  g.emote('me', 'wave');
  eq(before.next(), after.next(), 'waving at a full shop leaves the RNG stream exactly where it was');
  // ...and the wave really did happen, or the line above is a claim about a
  // function that returned early. This is the pairing the header is about.
  check(waving(g, g.customers['zz-near-0']), '...and somebody actually waved back');
}

// ---------------------------------------------------------------------------
// 3. IT IS A VOCABULARY. Anything not in the table is refused, by name.
//
//    `setSurround`'s split: a press has somebody in front of it who can be
//    told, and silently narrowing a typo to a wave is a client that appears to
//    work and only ever waves.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  for (const bad of ['', 'waev', 'WAVE', 'nod', null, undefined]) {
    const res = g.emote('me', String(bad));
    eq(res.ok, false, `\`${bad}\` is refused`);
    eq(g.players.me.emote ?? null, null, `...and leaves the arms alone`);
  }
  eq(g.emote('nobody', 'wave').ok, false, 'and so is a player who is not here');
  // The pair. Every id in the shared table is accepted, swept rather than
  // written out — a fifth emote is covered by this loop the day it exists.
  for (const e of EMOTE_LIST) {
    const g2 = fresh();
    eq(g2.emote('me', e.id).ok, true, `\`${e.id}\` is accepted`);
    eq(g2.players.me.emote.kind, e.id, `...and is what was asked for`);
    check(isEmote(e.id), `...and the table agrees with itself about \`${e.id}\``);
  }
}

// ---------------------------------------------------------------------------
// 4. IT STOPS — and it is on the shop's clock rather than on a stopwatch.
//
//    Two claims, and the second is the one that matters: the pose has to be
//    over because the WORLD moved on, not because wall time passed. A paused
//    shop never advances `elapsed`, and an emote expired against `Date.now()`
//    would come down while the world it belongs to is frozen.
// ---------------------------------------------------------------------------
{
  for (const e of EMOTE_LIST) {
    const g = fresh();
    g.emote('me', e.id);
    check(waving(g, g.players.me), `\`${e.id}\` is up the moment it is asked for`);
    g.elapsed += e.seconds * 0.5;
    check(waving(g, g.players.me), `...still up half way through`);
    g.elapsed += e.seconds * 0.5 + 0.001;
    check(!waving(g, g.players.me), `...and over when its own seconds are up`);
    eq(g.snapshot().players.find((p) => p.id === 'me').emote, undefined,
      `...and off the wire with it`);
  }
  // The stamp rides along while it IS up, and it is what lets a client tell a
  // second wave from the first one still running. Without it two waves in a row
  // are the same string and the arm goes up once.
  const g = fresh();
  g.emote('me', 'wave');
  const first = g.snapshot().players.find((p) => p.id === 'me');
  eq(first.emote, 'wave', 'a live emote is on the wire');
  check(typeof first.emoteAt === 'number', '...with the stamp it started at');
  g.elapsed += 0.5;
  g.emote('me', 'wave');
  const second = g.snapshot().players.find((p) => p.id === 'me');
  check(second.emoteAt !== first.emoteAt, 'and waving again is a NEW stamp, not the same one');
}

// ---------------------------------------------------------------------------
// 5. THE WAVE IS ANSWERED AND THE OTHER THREE ARE NOT.
//
//    Paired, because "a dance is ignored" is satisfied by a shop where nothing
//    is ever answered. Same shop, same shopper, same tile — only the verb
//    differs.
// ---------------------------------------------------------------------------
{
  for (const e of EMOTE_LIST) {
    const g = fresh();
    const cu = shopperAt(g, 'zz-watch', 1);
    g.emote('me', e.id);
    eq(waving(g, cu), e.id === 'wave',
      `a \`${e.id}\` is ${e.id === 'wave' ? 'answered' : 'not answered'}`);
  }
  // ...and what comes back is a wave rather than whatever was sent.
  const g = fresh();
  const cu = shopperAt(g, 'zz-watch', 1);
  g.emote('me', 'wave');
  eq(cu.emote.kind, 'wave', 'and the answer to a wave is a wave');
}

// ---------------------------------------------------------------------------
// 6. IT HAS A RANGE, and both sides of it are asserted in one shop.
//
//    A radius claim written as "the far one does not answer" alone is the
//    feature switched off. So: one either side of the line, at once.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const near = shopperAt(g, 'zz-near', REACH - 0.4);
  const far = shopperAt(g, 'zz-far', REACH + 0.4);
  g.emote('me', 'wave');
  check(waving(g, near), 'a shopper inside the reach waves back');
  check(!waving(g, far), '...and one outside it does not');
  // Diagonally, or the reach is a box rather than a circle — which nothing in
  // play would ever tell you, and which makes the corner of an aisle a place
  // people can hear you from and the middle of one not.
  const g2 = fresh();
  const p = g2.players.me;
  const corner = { id: 'zz-corner', x: p.x + REACH * 0.8, z: p.z + REACH * 0.8, state: 'BROWSE', emote: null };
  g2.customers['zz-corner'] = corner;
  g2.emote('me', 'wave');
  check(!waving(g2, corner), 'and the reach is a circle rather than a square');
}

// ---------------------------------------------------------------------------
// 7. NOBODY IN A CAR. `this.customers` holds people who have not arrived.
//
//    The `inACar` rule, which this repo has had to apply four times already —
//    the crush, the mood, the snapshot and the patience budget. Here it is an
//    arm out of a moving windscreen, which is the funniest way it could
//    present and the least likely to be reported.
// ---------------------------------------------------------------------------
{
  for (const state of ['DRIVE', 'DEPART']) {
    const g = fresh();
    const cu = shopperAt(g, 'zz-driver', 1);
    cu.state = state;
    g.emote('me', 'wave');
    check(!waving(g, cu), `somebody in ${state} is not in the shop and does not wave back`);
  }
  // The pair, in the same breath: the identical body on the identical tile,
  // shopping, does.
  const g = fresh();
  const cu = shopperAt(g, 'zz-shopper', 1);
  g.emote('me', 'wave');
  check(waving(g, cu), '...and the same body on the same tile, on foot, does');
}

// ---------------------------------------------------------------------------
// 8. THE CREW WAVE BACK TOO, and you never answer yourself.
//
//    A shop where the shoppers wave and the staff stand there reads as the crew
//    being broken rather than as a decision — and a player who answered their
//    own wave would restart their own pose on the tick they made it, which is
//    an arm that never rises.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const p = g.players.me;
  g.addPlayer('staff-zz', 'Bot');
  const hire = g.players['staff-zz'];
  hire.staff = true;
  hire.x = p.x + 1;
  hire.z = p.z;
  g.emote('me', 'wave');
  check(waving(g, hire), 'a hire standing next to you waves back');
  eq(p.emote.kind, 'wave', 'and your own pose is the one you asked for');
  check(p.emote.at <= g.elapsed, '...started now rather than on somebody else\'s stagger');
}

// ---------------------------------------------------------------------------
// 9. THE STAGGER, which is the difference between people noticing you and a
//    chorus line.
//
//    Three claims. It is inside the window, or somebody waves back next week.
//    It is DIFFERENT per person, or the whole shop's arms go up on one tick. And
//    it is the SAME for the same person twice, which is what says it came out of
//    a hash rather than out of anything random — the claim §2 is really about,
//    said from the other end.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const ids = [];
  for (let i = 0; i < 8; i++) { shopperAt(g, `zz-crowd-${i}`, 1); ids.push(`zz-crowd-${i}`); }
  g.emote('me', 'wave');
  const beats = ids.map((id) => g.customers[id].emote.at - g.elapsed);
  check(beats.every((b) => b >= 0 && b < STAGGER), 'every answer lands inside the window',
    `got ${JSON.stringify(beats.map((b) => Math.round(b * 100) / 100))}`);
  check(new Set(beats.map((b) => Math.round(b * 1000))).size > 1,
    'and they do not all land on the same tick');
  // Same person, a second shop, same beat. Which also pins the spelling of the
  // hash key: `id:wave` and not `id`, so a second answered emote could never
  // land a person on the identical dither.
  const g2 = fresh();
  shopperAt(g2, 'zz-crowd-0', 1);
  g2.emote('me', 'wave');
  eq(g2.customers['zz-crowd-0'].emote.at - g2.elapsed,
    g.customers['zz-crowd-0'].emote.at - g.elapsed,
    'and the same shopper always gets the same beat');
  eq(Math.round((g.customers['zz-crowd-0'].emote.at - g.elapsed) * 1e6),
    Math.round(hash01('zz-crowd-0:wave') * STAGGER * 1e6),
    '...which is the hash of who they are and nothing else');
  // A stamp in the future is still on the wire. The client's envelope holds the
  // arm down until it starts, and a shop that withheld it would have to send
  // the news later — on a tick nothing is looking for one.
  const held = ids.find((id) => g.customers[id].emote.at > g.elapsed);
  check(!!held && waving(g, g.customers[held]),
    'somebody who has not got round to it yet is still on the wire');
}

// ---------------------------------------------------------------------------
// 10. SOMEBODY ALREADY MID-EMOTE IS LEFT ALONE.
//
//     Two waves a second apart would otherwise restart every arm in the shop
//     from the bottom — an arm that jerks back to the start rather than a person
//     waving — and it is also what stops a held key turning a shop into a
//     stadium. Paired, as ever, with the case where they SHOULD be answered
//     again, or the guard is "nobody ever waves twice".
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cu = shopperAt(g, 'zz-again', 1);
  g.emote('me', 'wave');
  const first = cu.emote.at;
  g.elapsed += 0.2;
  g.emote('me', 'wave');
  eq(cu.emote.at, first, 'somebody already waving is not restarted');
  // ...and once their own pose has run out, they answer the next one. The
  // stagger is added on because their clock started AFTER yours did — waiting
  // exactly one wave is the length of your pose, not of theirs, and a sweep
  // that used it would pass or fail on this shopper's hash.
  g.elapsed += EMOTES.wave.seconds + STAGGER;
  g.emote('me', 'wave');
  check(cu.emote.at > first, 'and once it is over they answer the next wave');
}

// ---------------------------------------------------------------------------
// 10b. BEING GREETED IS WORTH SOMETHING, ONCE.
//
//      The only thing in the game that moves a shopper's patience UPWARD for
//      free, which makes every claim here a bound rather than a value. `mood`
//      is what a visit's reputation is priced against, so an unbounded greeting
//      is a reputation printer you run by holding a key — and none of it is
//      visible: a shopper who was waved at and one who simply had a good day
//      are the same person leaving the same shop.
//
//      ⚠️ `simulate` cannot see any of this. The balance bot never emotes, so a
//      before/after over it reports no change because nothing waved — the
//      instrument being blind, not the change being free. These assertions are
//      the whole of the guard.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cu = shopperAt(g, 'zz-greeted', 1, 0.6);
  g.emote('me', 'wave');
  close(cu.mood, 0.6 + WAVE_MOOD, 'being waved at cheers a shopper up');

  // ...ONCE. The claim that stops a held key being a printer, and it is asserted
  // across their whole visit rather than across one tick — the flag has to
  // outlast the pose, or waving again the moment their arm comes down pays
  // again and the bound is a rate limit wearing a rule.
  g.elapsed += EMOTES.wave.seconds * 4;
  g.emote('me', 'wave');
  close(cu.mood, 0.6 + WAVE_MOOD, '...and only ever once, however often you wave');
  check(cu.greeted === true, '...which is a flag on the shopper rather than a stopwatch');

  // Nobody who did not actually wave back is paid. Each of these is a body the
  // greeting never reached, and each would be a way to pay for waving at an
  // empty aisle.
  for (const [label, place] of [
    ['out of reach', (gg) => shopperAt(gg, 'zz-far', REACH + 1, 0.6)],
    ['in a car', (gg) => Object.assign(shopperAt(gg, 'zz-drive', 1, 0.6), { state: 'DRIVE' })],
  ]) {
    const g2 = fresh();
    const who = place(g2);
    g2.emote('me', 'wave');
    close(who.mood, 0.6, `a shopper ${label} is not cheered up`);
    check(!who.greeted, `...and is not marked as greeted either`);
  }
  // The other three poses pay nothing, or "a wave is the one that is answered"
  // is true of the arms and false of the money.
  for (const kind of ['cheer', 'dance', 'point']) {
    const g2 = fresh();
    const who = shopperAt(g2, 'zz-other', 1, 0.6);
    g2.emote('me', kind);
    close(who.mood, 0.6, `a \`${kind}\` cheers nobody up`);
  }

  // The ceiling. `moodBase` starts a shopper below 1 in an ugly shop and AT 1
  // in a lovely one, so the top of the scale is an ordinary state rather than
  // an edge case — and a mood above 1 would price a sale above its own maximum.
  const g3 = fresh();
  const top = shopperAt(g3, 'zz-top', 1, 0.98);
  g3.emote('me', 'wave');
  close(top.mood, 1, 'and nobody goes past the top of the scale');

  // A HIRE has no mood — they have `energy`, on a different clock — so this
  // must not mint one. `moodAverage` and `stepMood` would both find it and
  // believe it, which is a worker quietly counted as a customer.
  const g4 = fresh();
  g4.addPlayer('staff-zz', 'Bot');
  const hire = g4.players['staff-zz'];
  hire.staff = true;
  hire.x = g4.players.me.x + 1;
  hire.z = g4.players.me.z;
  g4.emote('me', 'wave');
  check(waving(g4, hire), 'a hire still waves back');
  eq('mood' in hire, false, '...and is not given a mood by being greeted');

  // And the shop's own numbers do not move. Mood is an input to reputation over
  // time, never a payment — a wave that moved the bar directly would be the
  // printer this whole section is about, one layer down.
  const g5 = fresh();
  shopperAt(g5, 'zz-books', 1, 0.6);
  const rep = g5.reputation;
  const cash = g5.cash;
  g5.emote('me', 'wave');
  eq(g5.reputation, rep, 'greeting somebody moves no reputation of its own');
  eq(g5.cash, cash, '...and no money');
}

// ---------------------------------------------------------------------------
// 11. NOTHING IS SAVED, and nothing costs anything.
//
//     The stamp is against `elapsed`, which restarts at zero on every load —
//     the trap this repo has hit on `plantedAt`, `yieldedAt`, `bornAt` and
//     `arrivesAt`. A saved one would put the pose in the future and the arm
//     would never come down, on somebody else's machine, days later.
//
//     And the money, because a gesture that moved a number would be the one
//     thing in here `simulate` could see and nobody would think to look.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  shopperAt(g, 'zz-paid', 1);
  const cash = g.cash;
  const rep = g.reputation;
  const save = JSON.stringify(g.saveState());
  g.emote('me', 'wave');
  eq(g.cash, cash, 'a wave costs nothing');
  eq(g.reputation, rep, '...and moves no reputation');
  eq(JSON.stringify(g.saveState()), save, '...and reaches the save not at all');
  check(!save.includes('emote'), 'and the word does not appear in a save anywhere',
    'the pose is in memory only, by construction');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ verify:emote — ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ verify:emote — ${checks} checks passed`);
