#!/usr/bin/env node
/**
 * VERIFY: THE SHOP DOES NOT KNOW WHAT IS CARRYING IT.
 *
 * `ShopRoom` was split out of Colyseus on the claim that it rests on ten calls
 * and nothing else. That claim is worth exactly nothing until something other
 * than Colyseus answers those ten, because a seam with one implementation is a
 * seam that compiles — every `verify:*` sweep in the repo drives `Game`
 * directly, so not one of them has ever touched a room, a client or a frame.
 *
 * So this drives the whole room over `ChannelHost`: a real shop, a real 20Hz
 * tick, real clients on real channels, and no socket anywhere. What it is
 * guarding is not that the shop works — twenty-two other sweeps say that — but
 * that **the shop is reachable through the other Base at all**, which is the one
 * thing they cannot say.
 *
 * Its centrepiece is a claim about something that must STOP. `stop()` clearing
 * its timers is invisible twice over: a room that leaked its tick goes on
 * simulating a shop nobody is in, so the picture is an empty shop either way,
 * and the tell is a save being written by a room that was disposed — which
 * arrives, eventually, as a world that quietly rolled forward a day while
 * nobody was playing it. In a tab it is also the battery.
 *
 * The other one worth naming is the pair of **swallows**. An unknown message
 * type and a handler that throws are both survivable on the Colyseus side,
 * because the framework catches them and the room keeps ticking. If either one
 * took the room down here, the same bug would be a glitch on the desktop build
 * and a dead tab on the web one — which is precisely the divergence the seam
 * exists to prevent, arriving as "it works on your machine".
 *
 * Authors one world row into whatever database it is pointed at — usually the
 * live shared one — and removes it, its save and its modifiers on exit, the way
 * verify:catalog and verify:economy do with content.
 *
 *   node scripts/verify-host.js
 */

// Straight from `shop.js`, not through `MartRoom.js`: the point of this sweep
// is the shop with no Colyseus anywhere near it, and importing the binding would
// quietly put one in the room.
import { ShopRoom, rooms } from '../server/rooms/shop.js';
import { ChannelHost, linkedChannels } from '../server/rooms/host.js';
import { insertWorldRow, worldRow, deleteWorldRow } from '../server/db.js';
import { lotQty } from '../shared/lot.js';

const WORLD = 'zz-verify-host';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const Room = ShopRoom(ChannelHost);

/** The other end of a channel: keeps every frame, indexed by type. */
function viewer(channel) {
  const seen = [];
  const byType = new Map();
  channel.onFrame(([type, payload]) => {
    seen.push(type);
    byType.set(type, [...(byType.get(type) ?? []), payload]);
  });
  return {
    seen,
    count: (t) => (byType.get(t) ?? []).length,
    last: (t) => (byType.get(t) ?? []).at(-1),
    send: (type, payload) => channel.post([type, payload]),
    clear: () => { seen.length = 0; byType.clear(); },
  };
}

/** Open a shop with one person in it. */
function shop() {
  const room = new Room();
  room.start({ worldId: WORLD });
  const [mine, theirs] = linkedChannels();
  const me = viewer(mine);
  const client = room.join(theirs, { name: 'Tester' });
  return { room, me, client };
}

/**
 * Somebody else arrives, and — the part that matters — keeps hold of the end of
 * the wire that is theirs, so the sweep can ask whether it was ever told
 * anything.
 */
function guest(room, name, who = null) {
  const [mine, theirs] = linkedChannels();
  const me = viewer(mine);
  let told = 0;
  mine.onClose(() => { told++; });
  const client = room.join(theirs, { name, who });
  return { me, client, wire: mine, name, get told() { return told; } };
}

/** How many units of one item are in crates on the floor. */
const onFloor = (game, itemId) => game.deliveries.reduce((n, d) => n + lotQty(d, itemId), 0);

// ---------------------------------------------------------------------------

if (!worldRow(WORLD)) insertWorldRow({ id: WORLD, name: 'verify:host', seed: 'host-1' });

// ---- 1. the contract is actually answered ---------------------------------
//
// Named one at a time rather than by walking the prototype, because the failure
// this is for is a call `ShopRoom` makes that the Base forgot — and a loop over
// what the Base HAS can never notice something missing.

const bare = new ChannelHost();
for (const call of ['broadcast', 'onMessage', 'setSimulationInterval', 'disconnect', 'setMetadata']) {
  check(typeof bare[call] === 'function', `ChannelHost answers ${call}()`);
}
check(typeof bare.clock?.setInterval === 'function', 'ChannelHost answers clock.setInterval()');
check(Array.isArray(bare.clients), 'ChannelHost has a clients array');
check(typeof bare.roomId === 'string' && bare.roomId.length > 0, 'ChannelHost has a roomId');
eq(typeof bare.maxClients, 'number', 'ChannelHost takes maxClients');
eq(typeof bare.autoDispose, 'boolean', 'ChannelHost takes autoDispose');
bare.stop();

// ---- 2. arriving ----------------------------------------------------------

const a = shop();
await wait(30);

check(a.me.count('layout') >= 1, 'a client is sent the layout on arrival');
check(a.me.count('catalog') >= 1, '...and the catalog');
check(a.me.count('you') >= 1, '...and who they are');
eq(a.me.last('you')?.id, a.client.sessionId, 'and "you" is the session that joined');
eq(a.me.last('you')?.world?.id, WORLD, 'and it names the world they are in');
check((a.me.last('layout')?.layout?.tiles?.length ?? 0) > 0, 'the layout has a shop in it');
check((a.me.last('catalog')?.items?.length ?? 0) > 0, 'the catalog has items in it');
// Kept now rather than read later: `viewer.clear()` is called between sections,
// so anything sent once — the catalog is sent once, on arrival — is gone by the
// time somebody down the file wants it.
const anItem = a.me.last('catalog')?.items?.[0]?.id;
check(a.room.game.players[a.client.sessionId] != null, 'the shop has a player for them');

// ---- 3. the tick, and the broadcast on top of it --------------------------
//
// Two different clocks: `setSimulationInterval` at 20Hz and a `clock.setInterval`
// at 10Hz. Asserting only that state arrived would pass with the sim frozen, so
// the shop's own clock is read either side.

const elapsedBefore = a.room.game.elapsed;
const timeBefore = a.room.game.time;
a.me.clear();
await wait(350);
const frames = a.me.count('state');
check(frames >= 2, 'state is broadcast while the room runs', `got ${frames} in 350ms`);
check(a.room.game.elapsed > elapsedBefore, 'and the sim is actually stepping',
  `elapsed ${elapsedBefore} -> ${a.room.game.elapsed}`);
check(a.room.game.time !== timeBefore, '...with the shop clock moving with it');
check((a.me.last('state')?.players?.length ?? 0) >= 1, 'a snapshot has the player in it');

// ---- 4. a message reaches its handler -------------------------------------

a.me.send('rename', { name: 'Renamed' });
await wait(150);
eq(a.room.game.players[a.client.sessionId]?.name, 'Renamed', 'an inbound message reaches its handler');
check(a.me.last('state')?.players?.some((p) => p.name === 'Renamed'), '...and comes back on the wire');

// ---- 5. two clients: broadcast is everybody, send is one ------------------

a.me.clear();
const [mine2, theirs2] = linkedChannels();
const other = viewer(mine2);
const client2 = a.room.join(theirs2, { name: 'Second' });
await wait(30);
eq(a.room.clients.length, 2, 'both clients are on the room');
eq(other.count('you'), 1, 'the second client got their own "you"');
// Arrival is addressed, not announced: `onJoin` uses `client.send` for all three
// opening frames, so somebody already in the shop must hear none of them.
eq(a.me.count('you'), 0, '...and the first was not sent one again');
eq(a.me.count('catalog'), 0, '...nor the catalog');

a.me.clear(); other.clear();
await wait(150);
check(a.me.count('state') >= 1 && other.count('state') >= 1, 'a broadcast reaches both');

a.me.clear(); other.clear();
// `interact` answers every caller, and answers THEM — `client.send`, not a
// broadcast. Whether the action succeeds is not the point; who hears about it is.
a.me.send('interact', {});
await wait(80);
check(a.me.count('action-result') >= 1, 'a reply reaches the client who asked');
eq(other.count('action-result'), 0, '...and nobody else');

// ---- 6. leaving -----------------------------------------------------------

a.room.leave(client2);
eq(a.room.clients.length, 1, 'leaving takes them off the room');
check(a.room.game.players[client2.sessionId] == null, '...and out of the shop');

// ---- 6b. two guests, and one of them drops -------------------------------
//
// The shop over a peer connection can hold more than one person and lose one of
// them without noticing, and every claim in here is invisible in a screenshot by
// construction: a guest who left and a guest whose laptop shut are the same
// empty aisle, and a guest who is STILL STANDING THERE because nothing told the
// room they had gone is a person in the shop — which looks like a person in the
// shop.
//
// That was the bug. Nothing in the game detected a wire going away, so the room
// went on broadcasting at somebody who was not there, their avatar stood in the
// aisle holding stock nothing could ever get back, and `emptySince` never
// started because the shop was never empty. The transport now reports it, which
// is what makes `onLeave` run at all — and `onLeave` is where a dropped armful
// becomes a crate rather than nothing.

const one = guest(a.room, 'Guest one');
const two = guest(a.room, 'Guest two');
await wait(40);

eq(a.room.clients.length, 3, 'the shop takes a second guest');
check(one.client.sessionId !== two.client.sessionId, '...who is a different person');
eq(Object.values(a.room.game.players).filter((p) => !p.staff).length, 3,
  '...and three pairs of hands are in one shop');
eq(one.me.count('you'), 1, 'each guest is told who they are, once');
eq(two.me.count('you'), 1, '...and so is the other');

// Attribution, which is the thing a relay keyed by id can quietly get wrong:
// two guests arrive over two wires and the room must not confuse them.
two.me.send('rename', { name: 'Named two' });
await wait(140);
eq(a.room.game.players[two.client.sessionId]?.name, 'Named two',
  'a message from the second guest lands on the second guest');
eq(a.room.game.players[one.client.sessionId]?.name, 'Guest one',
  '...and not on the first');

// Mid-carry, which is the case worth having: the goods are the only part of
// this that cannot be undone by rejoining.
const itemId = anItem;
check(!!itemId, 'the catalog named something to put in their hands');
const floorBefore = onFloor(a.room.game, itemId);
a.room.game.players[two.client.sessionId].carry = { item_id: itemId, qty: 4 };

// A dropped connection IS this call — `LocalNet.dropPeer` posts `@peer-left`
// and the worker turns it into exactly this. What is being asserted is what
// happens once somebody makes it, since for a while nobody ever did.
a.room.leave(two.client);

eq(a.room.clients.length, 2, 'a guest who goes is off the room');
check(a.room.game.players[two.client.sessionId] == null, '...and out of the shop');
eq(onFloor(a.room.game, itemId) - floorBefore, 4,
  '...and what they were carrying is on the floor rather than gone');
eq(two.told, 1, 'their end of the wire is told, not merely forgotten');
eq(one.told, 0, 'and nobody else is told anything');

one.me.clear();
await wait(150);
check(one.me.count('state') >= 1, 'the other guest is still in a shop that is running');
check(a.room.emptySince == null, '...so the empty-room clock has not started');

// ---- 6c. ...and a guest the shop has met before --------------------------
//
// The crate above is what happens to somebody with no stable id, and it is the
// right answer for a stranger: nothing is destroyed, and it is the behaviour a
// browser in private mode has always had. It is the wrong answer for a person.
// `Game.away` is keyed by `who`, so a guest who carries theirs across gets their
// hands, their shoulder and their spot back after a blink of wifi, exactly as
// the host does across a reload — and `who` has to be in the ANSWER blob rather
// than in a frame, because `room.join` happens the moment the channel opens and
// a tick later has already spawned a stranger.
//
// Every claim here is about somebody who is not there: a guest who dropped and
// a guest who dropped holding something are the same empty aisle.

const WHO = 'zz-who-guest';
const known = guest(a.room, 'Knows themselves', WHO);
await wait(30);
const floorBeforeKnown = onFloor(a.room.game, itemId);
const knownAt = { x: a.room.game.players[known.client.sessionId].x, z: a.room.game.players[known.client.sessionId].z };
a.room.game.players[known.client.sessionId].carry = { item_id: itemId, qty: 4 };

a.room.leave(known.client);

eq(onFloor(a.room.game, itemId) - floorBeforeKnown, 0,
  'a guest the shop knows does not have their armful tipped onto the floor');
eq(lotQty(a.room.game.away[WHO]?.carry, itemId), 4, '...it is held for them');
check(a.room.game.away[WHO] != null, '...under their own id, not their session');

// ...and coming back is the whole point of having kept it.
const back = guest(a.room, 'Knows themselves', WHO);
await wait(30);
eq(lotQty(a.room.game.players[back.client.sessionId]?.carry, itemId), 4,
  'and they get it back when they rejoin');
// The spot as well as the hands, which are two facts and only one of them a
// wall can invalidate — a shop rebuilt while you were away is why the spot is
// offered rather than trusted, and why these are asserted apart.
check(Math.abs((a.room.game.players[back.client.sessionId]?.x ?? -9) - knownAt.x) < 0.011
  && Math.abs((a.room.game.players[back.client.sessionId]?.z ?? -9) - knownAt.z) < 0.011,
'...and stand where they were standing');
check(a.room.game.away[WHO] == null,
  '...spending the record, so a second tab is not handed the same armful again');
a.room.leave(back.client);

// ---- 7. the two swallows --------------------------------------------------

a.me.clear();
a.me.send('no-such-message-type', { anything: true });
a.me.send('rename', { name: 'Still here' });
await wait(120);
eq(a.room.game.players[a.client.sessionId]?.name, 'Still here',
  'an unknown message type does not stop the next one working');
check(a.me.count('state') >= 1, '...and the room is still broadcasting');

// A handler that throws, tested on a bare host — the room's own handlers are
// not supposed to throw, so forcing one to would be testing a fiction.
const thrower = new ChannelHost();
let reached = 0;
thrower.onMessage('boom', () => { throw new Error('deliberate'); });
thrower.onMessage('after', () => { reached++; });
const [c1, c2] = linkedChannels();
const t = thrower.join(c2, {});
void t;
const quiet = console.error;
console.error = () => {};
c1.post(['boom', {}]);
c1.post(['after', {}]);
await wait(20);
console.error = quiet;
eq(reached, 1, 'a handler that throws does not stop the next message');
thrower.stop();

// ---- 8. stopping, which is the one that is invisible ----------------------

const ticksBefore = a.room.game.elapsed;
a.me.clear();
a.room.stop();
eq(a.room.clients.length, 0, 'stopping takes everybody off');
check(!rooms.has(a.room), 'and out of the registry the control API reads');
// The host shutting the shop is the third way a guest's world ends, and the one
// with nothing wrong anywhere: the room was told to stop and did. A guest whose
// wire stayed open through it would be left looking at the last snapshot that
// ever arrived, which is a shop that has stopped and no reason given.
eq(one.told, 1, 'a shop that closes tells the guests standing in it');

await wait(300);
eq(a.me.count('state'), 0, 'a stopped room broadcasts nothing');
eq(a.room.game.elapsed, ticksBefore, 'a stopped room does not go on simulating');
eq(a.room.timers.size, 0, 'and it is not holding any timers');

// Idempotent: `disconnect()` is `stop()` and `checkIdle` can call it while
// something else already has.
a.room.stop();
a.room.disconnect();
checks++;

// ---- 9. a channel never delivers inside its caller's stack ----------------
//
// Neither a worker boundary nor a peer connection can deliver synchronously, so
// a linked pair that did would be the one configuration where a handler can
// re-enter the code that called it — a bug you could only reproduce with the
// fallback transport, which is the worst place to have one.

const [x, y] = linkedChannels();
let order = '';
y.onFrame(() => { order += 'received'; });
x.post(['ping', {}]);
order += 'returned';
await wait(10);
eq(order, 'returnedreceived', 'post() returns before the other end hears it');

// ---------------------------------------------------------------------------

deleteWorldRow(WORLD);
check(worldRow(WORLD) == null, 'the sweep cleaned up after itself');

console.log(`\nverify:host — ${checks} assertions`);
if (failures.length) {
  console.log(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.log(`      ${f}`);
  console.log('');
  process.exit(1);
}
console.log('\n  ✅  the shop runs with no socket under it, and stops when it is told.\n');
process.exit(0);
