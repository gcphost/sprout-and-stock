# Browser — the whole game on a URL, and the shop next door over a wire

Status: steps **1–7 built**; 8 open, and open on purpose — see the bottom of the
step list. It is live at <https://sprocket.willbowman.dev>.

The decision: the primary way somebody plays this is **a link they click**. No
download, no installer, no Steam page. The server moves into the tab.

This document comes *before* [docs/shipping.md](shipping.md) and
[docs/steam.md](steam.md) rather than replacing them, and the reasoning is about
audience rather than architecture. A standalone binary is a real project — code
signing, notarisation, an updater, a store page, two platforms of native module
rebuilds — and it is all spent getting somebody to *install* a shop-and-farm sim
they have not played yet. A URL is one afternoon of porting and the same person
is standing in the shop in four seconds. The binary is still the better answer
for the people who love it; it is the wrong answer for the people who have never
heard of it, and there are far more of the second kind.

Where this document and those two disagree, this one wins for the **web** build
and neither of them wins for the desktop build. That is the shape of the whole
port: two targets, one codebase, and the seam is drawn deliberately in two
places so that neither target is the other one's compromise.

---

## What is already true, and it is nearly everything

Worth stating first, because the list of blockers below is three items long and
that is genuinely all of it.

- **The sim does not know it is on a server.** `server/sim/` and `shared/` between
  them contain no `process`, no `require`, no `__dirname`, no `node:` import.
  13,657 lines of `server/sim/index.js` are already browser code that happens to
  be running in Node. Nothing has to be *extracted*.
- **The room is already host-authoritative.**
  [`ShopRoom`](../server/rooms/shop.js) owns the `Game`, steps it at 20Hz
  (`TICK_MS`), and broadcasts a **full plain-JSON
  snapshot** at 10Hz (`BROADCAST_MS`, `pushState`). There is no delta encoding, no
  schema, no client prediction, no reconciliation. That is the single luckiest
  fact in this document — see *P2P* below.
- **State is plain JSON on purpose.** The decision recorded in CLAUDE.md ("at this
  scale the bandwidth difference is irrelevant and the readability win is large")
  was made for debuggability and pays off here: a snapshot goes down a
  `RTCDataChannel` as-is.
- **The client already speaks a tiny protocol.** [`client/net.js`](../client/net.js)
  is an event emitter with ten inbound message types and one `send()`. It is not
  coupled to Colyseus beyond `new Client()` and `joinOrCreate`.
- **Identity already outlives the socket.** `who` in local storage, `Game.away` in
  the save — [docs/shipping.md](shipping.md) step 3, built. A peer connection
  dropping is a case that has already been designed for.
- **Nothing in `client/` imported anything from `server/`.** The boundary was
  real, which is what made it safe to cross deliberately in exactly one file:
  [`client/worker.js`](../client/worker.js) is the whole of the crossing, and
  every other rule about that boundary still stands.

---

## The three things in the way

### 1. `better-sqlite3` is native

A C++ addon. There is no browser story for it at all.

The obvious fix — SQLite compiled to WASM, OPFS for persistence — is the wrong
one, and noticing why is most of the design. It is about a megabyte of wasm plus
an OPFS worker to hold **content that cannot change at runtime in this build**,
because the thing that changes it is MCP and MCP is not coming (see below). A
shipped web build's content is a fixed catalogue; a query engine to read a fixed
catalogue is a query engine answering questions nobody is allowed to ask.

So the web build has no database. See *The store seam*.

### 2. Colyseus's server half is Node-only

`colyseus` is an http server plus `ws`. The room base class, the transport and
the matchmaker all assume a listening socket, which a tab does not have.

But almost nothing of value is in the base class. What is worth keeping is the
room itself — 793 lines, 50 `onMessage` handlers, the tick, the broadcast, the
idle check — and the whole of it rests on
**ten** things off `Room`: `broadcast`, `onMessage`, `clients` (with
`sessionId` and `send` on a client), `clock.setInterval`,
`setSimulationInterval`, `disconnect`, `roomId`, and the three matchmaking knobs
`maxClients` / `autoDispose` / `setMetadata`. See *The transport seam*.

### 3. ~~The director wants a key and an environment~~ — **gone entirely**

It read `process.env.ANTHROPIC_API_KEY` and news up the SDK, and neither of those
exists in a tab. The fix turned out not to be a guard or a stub: **the model call
came out of the game altogether.**

That is docs/steam.md §4's decision arriving early, and this build is only what
forced it. What the model was buying was *phrasing*, on top of a world-event
system that was already there — a driver tag drawn from the season and filtered
to what the shop actually stocks, allies and a rival, multipliers in bands, a
no-repeat guard, and authored `events` rows a quarter of the time. `inventEvent`
*is* the director now, `applyFallback` is renamed `stageEvent` because the naming
was the whole trap, and `@anthropic-ai/sdk` has left the dependency list.

Three things fall out, and only the first is about the browser. Nothing a player
reads is generated at runtime, so a shipped build answers "no" to every
AI-disclosure question a store asks. There is no key to leak, so the question of
a bring-your-own-key box — which would have been a page that can spend somebody's
money — never comes up. And agents still author events over MCP, which is where
a model belongs in this project: at the keyboard, not in the build.

The one thing that had to be checked, because it is invisible either way:
`inventEvent` draws from `game.rng`, so removing a branch that a keyless build
never took must not change how many times that stream is called on the path that
IS taken. It does not — `runDirector` now calls `stageEvent` exactly where it
used to call it for a missing key.

---

## The shape

### The transport seam — **built**

Three files now. [`shop.js`](../server/rooms/shop.js) is the shop — every
handler, the tick, the broadcast, the idle check — written against the ten-call
contract documented above it and against nothing else.
[`MartRoom.js`](../server/rooms/MartRoom.js) is `ShopRoom(Room)`, four lines, the
entire Colyseus binding. [`host.js`](../server/rooms/host.js) is the other Base.

They are separate **files** rather than separate exports of one, and that turned
out to be load-bearing rather than tidy: a single `import { Room } from 'colyseus'`
at the top of the shop is enough to drag a Node websocket server into a browser
bundle. A seam only means anything if the thing on the far side of it can
actually be left out.

A mixin rather than composition, and the reasoning is about the *diff* rather
than about the shape. A `Shop` object holding an injected `host` reads better and
would have meant rewriting fifty handlers to reach through it; this seam has to
be provably a no-op, and the only change that proves itself is one where the body
is untouched. Every `this.broadcast` in there resolves exactly where it did, and
`instanceof Room` still holds through the chain, which is what `define()` and
devMode's prototype lookups want.

Two implementations:

| | desktop / dev | web |
|---|---|---|
| Base | `MartRoom = ShopRoom(Room)` | `ShopRoom(ChannelHost)` |
| `broadcast` | Colyseus's | one frame posted down every client's channel |
| `onMessage` | Colyseus's | a dispatch table over parsed frames |
| `clock` | Colyseus's | `setInterval`, cleared when the room stops |

[`ChannelHost`](../server/rooms/host.js) is the second Base, and the thing that
makes it one object rather than two is that it never learns what it is on: a
channel is `{post, onFrame, close}`, and the difference between a worker boundary
and a peer connection lives entirely inside those three. `portChannel(port)`
wraps a `Worker`, a `MessagePort` or `self`; `linkedChannels()` is two channels
wired to each other in one thread, which is the no-`Worker` fallback and the only
configuration where a breakpoint in the sim and one in the renderer are the same
debugger.

It carries no matchmaker, because in a tab there is one room, and by step 6 the
peer connection has decided which shop it reached before any frame arrives.

**The shim must not be a place behaviour lives.** If it ever grows a branch on
which build it is, the two targets have started to diverge and every `verify:*`
sweep — all of which run against the Node side — has stopped being evidence about
the web side. It translates ten calls and holds no state.

One asymmetry is deliberate and worth knowing before writing the second Base:
`onCacheRoom` / `onRestoreRoom` are **not** in the contract. They are Colyseus
devMode alone, and a host that has no such thing simply never calls them. That is
safe only because the guard they carry (`lastDirectorDay`) is on the save as
well — which was already true, for the unrelated reason that it had to survive a
cold start.

### Which transport the client has — **built**

[`client/transport.js`](../client/transport.js) is one line, `export { Net as
Transport } from './net.js'`, aliased to `transport.web.js` in the web build.
`main.js` never asks which it has: it wires the menu on a *capability*
(`if (net.api)`) rather than on a build flag, because `api` is exactly the thing
being asked about.

**A ternary over two dynamic imports was tried first, and it is the trap worth
recording, because it looks correct.** `import.meta.env.VITE_SNS_LOCAL` folds at
build time, so the dead branch really does vanish from the output — but Rollup
resolves both edges of the module graph long before it decides that, so the
**server** build followed `localnet.js` into the worker, into `server/worlds.js`,
and into a Node websocket server. What that reads as is fifty lines of "Module
'http' has been externalized for browser compatibility" in the build that was not
being changed. An alias is resolved *instead of*, which is the difference.

The same lesson cost a second alias. `server/worlds.js` needs `matchMaker` in
exactly one function, so the import was made dynamic — and a dynamic import is
still an edge, so the bundler followed it and died resolving `@pm2/io`, a
process-metrics package, from a file about save slots.
[`no-matchmaker.js`](../server/rooms/no-matchmaker.js) is the answer, and it
**throws** rather than no-oping: a silent stub would let a call that cannot work
look like a call that did nothing.

### The store seam — **built**

SQLite stays exactly as it is: dev, `npm run seed`, `npm run export`, the
twenty-three verify sweeps, `simulate`, and any future desktop build. What moved is
where it *sits*. [`server/db.js`](../server/db.js) is now the contract and a
re-export; [`server/store/sqlite.js`](../server/store/sqlite.js) is the
implementation, unchanged; [`server/store/keys.js`](../server/store/keys.js)
holds the two things that are format rather than storage, so that a second store
cannot quietly disagree about where a save lives.

All twenty-six importers of `db.js` are untouched — same argument as the mixin,
and it paid for itself immediately, because several of those files were being
edited at the time.

The swap in step 3 is a **bundler alias** (`store/sqlite.js` → `store/web.js`)
rather than a runtime branch or an installed backend. No boot order to get wrong,
no entry point to remember, and Node never even parses the web store.

The web build implements the *same functions*, which is a short list because
everything already goes through it:

- content reads — `all`, `get` (and `upsert` / `remove`, which the web build
  refuses)
- the registry's version — `contentVersion`
- the save — `getWorld`, `setWorld`, `worldStateKey`
- world rows — `listWorldRows`, `worldRow`, `insertWorldRow`, `touchWorldRow`,
  `renameWorldRow`, `deleteWorldRow`
- modifiers — `activeModifiers`, `addModifier`, `pruneModifiers`, `clearModifiers`

Backed by the bundled `data/seed/*.json` for content (import it, it is already
the export format), an in-memory array for modifiers, and IndexedDB for the save
blob and the world rows. `content.js`, `worlds.js`, `sim/index.js` and
`director.js` never learn which one they are on.

Three traps in that list, all now written down where the second implementer will
actually be standing — the contract comment at the top of
[`server/db.js`](../server/db.js).

`contentVersion` must return a **constant** rather than a counter, or the room's
250ms `refresh()` poll rebuilds the registry for ever off a number that keeps
moving for no reason. `upsert` and `remove` must **throw** rather than succeed
into memory, because a content write that appears to work and is gone on reload
destroys an authoring session and logs nothing. And the whole contract is
**synchronous** — `better-sqlite3` is, so `content()`, `Game.persist` and
`world()` all are. A store whose reads are promises is a different contract
wearing this one's names, and the work of adopting it would be in the sim rather
than in the store. IndexedDB is async, so the web store reads itself into memory
once at boot and writes behind the scenes; never the other way round.

`db()`, `DATA_DIR` and `SEED_DIR` are deliberately **not** on the interface —
they are facts about a file on a disk, and the four Node-only callers that need
them (`server/index.js`, seed, export, reset) import them from the SQLite store
directly.

### P2P, and the honest hole in it — **built**

A guest connects to the host over a `RTCDataChannel`. The host's tab is the
server: it runs the sim, owns the save, and broadcasts. The guest runs the
identical client with `Net` pointed at a channel instead of a websocket.

This works as well as it does because of the snapshot. There is no prediction to
reconcile and no authority to negotiate — the guest is a terminal onto somebody
else's simulation, exactly as it is today, and the only thing that changed is
which wire the JSON went down. A latency problem here shows up as *the guest's
world is 80ms old*, which is what it already is over a LAN.

Two things come back for free: the **4KB inbound cap disappears** (Colyseus's, not
WebRTC's), which retires the reason screenshots are POSTed to
`/api/screenshot/upload` instead of sent over the socket; and there is no port to
forward, no tunnel to spawn, and no `cloudflared` to bundle — which deletes
[docs/shipping.md](shipping.md) step 6 rather than implementing it.

**WebRTC is not zero-infrastructure, and pretending otherwise is how this ships
broken.** Two peers cannot find each other without exchanging an offer and an
answer, and some of them cannot talk once they have:

- **Signalling** has a free answer: encode the host's offer into a short code the
  host pastes into a chat, and the guest's answer into one that comes back. This
  is [docs/shipping.md](shipping.md) steps 5–6 arriving from a different
  direction — that document already wanted a pasteable invite code, and this is
  that code with an SDP in it instead of a URL and a token. It is two paste
  operations rather than one, which is the whole cost of owning no servers.
  A ~50-line broker (a Worker with a Durable Object; a public PeerJS broker) makes
  it one paste, holds no game state, and can be added later without changing
  anything below it.
- **TURN cannot be conjured.** STUN is free and gets most pairs connected;
  symmetric NAT on both ends needs a relay, and a relay is a server somebody pays
  for. Realistically that is a low-teens percentage of pairs who will click Join
  and watch it fail. **The failure must be legible** — "your networks won't talk
  to each other directly" — and not a spinner. There is no way to make this
  number zero without running infrastructure, and this document does not pretend
  there is.

**One thing the plan had no way to predict, and it is the trap worth recording:
SCTP caps a single message and does not tell you where.** Over the cap, `send()`
throws nothing useful — the message is dropped, or the channel closes. The
`catalog` frame carries every fixture in the game and `data/seed/fixtures.json`
alone is 454KB, so the first guest to join got the layout, got the snapshot, and
never got the models: a working shop in which every shelf, till and freezer is an
untextured box. What that reads as is a rendering bug on a machine that has never
loaded the art, which is a long way from "one message was too big".
[`client/peer.js`](../client/peer.js) slices anything over 48KB into `@part`
frames and reassembles them — and note that this is the one part of the transport
`verify:host` can never have been evidence about, because a `postMessage` takes a
megabyte without blinking.

**And a channel needed a fourth method, which the Worker boundary hid for the
same reason.** The contract is `{post, onFrame, close}` because a worker port
never goes away on its own: the thread dies with the page, and the page taking
the shop with it is a case this document already handles. A peer *does* go away
on its own — a tab closed, a laptop shut, a train tunnel — and nothing in the
shape of a channel said so. See **What a dropped connection costs**, below.

### What a dropped connection costs

Three ways a co-op session ends, and for a while **none of them ended anything**.
Nothing in the game detected a peer going away, because the shape of a channel
had no way to say it and the Worker boundary — the only implementation there had
ever been — never needed one.

What that bought, in the order it hurts:

- **A guest who closes their tab is still in the shop.** `onLeave` is what runs
  `removePlayer`, and `removePlayer` is what decides what happens to an armful:
  it is the one place a person's hands are either written into `Game.away` or
  set down as a crate. Nothing called it, so a guest who dropped mid-carry left
  their avatar standing in the aisle holding stock nothing could ever get back —
  and the room went on broadcasting at a wire with nobody on the end of it, with
  `emptySince` never starting, because as far as the shop was concerned it was
  never empty.
- **A guest whose host closes their tab is looking at a photograph.** The
  snapshot stops arriving and the shop stops moving, and there is nothing on
  screen to say why. That is the spinner this document keeps refusing, arriving
  by a route the document did not think of: not a connection that never came up,
  but one that came up and then went.
- **And the host's own button lied about it.** "⇄ Friend connected" was written
  at the moment somebody joined and never unwritten.

The fix is one method on the channel — `onClose(fn)` — and then the ordinary
paths do the work. `client/peer.js` fires it on the data channel closing *and* on
the connection reaching `failed`, which are two different deaths: the first is a
tab closing or a Leave being pressed, the second is a laptop shutting or a
network vanishing, where nothing is sent and it is ICE giving up tens of seconds
later. `disconnected` is deliberately not one of them — it is transient by
definition, and treating it as death throws people out of a shop over a lift.
`LocalNet.dropPeer` turns the host's half into the `@peer-left` the worker
already understood, and `becomeGuest` turns the guest's half into a veil with
words on it. `ChannelHost.leave` closes the channel on the way out, which is
Colyseus's own behaviour and is what makes the third case — the shop closing
*under* a guest — a thing they are told rather than a thing they infer.

**And the guest is somebody the shop can now recognise**, which is the half that
turns a dropped connection from survivable into invisible. `Game.away` — the
record that puts you back where you were standing with what you were holding,
[docs/shipping.md](shipping.md) step 3 — is keyed by `who`, and a guest used to
arrive with none: their armful became a crate on the floor and they came back a
stranger at the door. It is two short strings on the **answer blob** now, beside
3KB of SDP, and it has to be there rather than in a frame because `room.join`
happens the moment the channel opens — `addPlayer` reads `who` at that instant,
so a guest who says who they are one tick later has already been spawned as
somebody else. The stranger's path is untouched and still right for a stranger:
a browser in private mode, or an older build, sends nothing and gets the crate.

**The claims are pinned in `verify:host`**, which is where they can be: the
sweep drives a real room over `linkedChannels`, so a guest dropping mid-carry is
`room.leave` and a shop closing under one is `room.stop`, and neither needs a
network. Two guests, one of them dropped, their armful on the floor, the other
still in a shop that is running, each end of the wire told exactly once — and
the same drop by a guest carrying a `who`, where nothing reaches the floor, the
record is held under their own id, and rejoining hands back the armful and the
spot. What it cannot reach is `RTCPeerConnection` itself — see *Verifying it*.

### The host is a tab, which is a worse host than a process

Two consequences, and the first one is not obvious.

**A backgrounded tab is throttled to roughly 1Hz.** The host alt-tabs to Discord
and a 20Hz simulation becomes a 1Hz one — for both players, since the guest is
watching the host's clock. The fix is to run the room and the sim in a **Web
Worker**, which browsers throttle far less, and which is worth doing on its own
account: it takes the sim off the thread that draws the frame. The sim is already
worker-clean (see the first section), so this costs a message boundary and no
rewrite. The direct-reference single-player case above becomes a `postMessage`
pair, which is why the transport seam is drawn where it is.

**The page going away is the shop going away**, which no build has had to think
about before. `Game.persist` is called from some thirty places, so buying,
building and the day roll all reach the vault a microtask later — but *you* do
not: where you are standing and what is in your hands ride in `saveState`, and
the only thing that called it on your behalf was leaving. In the server build
`onLeave` fires when the socket drops and the server writes it. Here, closing the
tab mid-aisle put you back at the door empty-handed, which is exactly the bug
docs/shipping.md step 3 fixed, reintroduced by a new transport. `LocalNet`
listens for `visibilitychange` and `pagehide` and saves — and **closes nothing**,
because a hidden tab is not a closed one and `pagehide` can be a page going into
bfcache and coming straight back.

**Whoever hosts owns the save.** The host closes the tab and the world stops; the
guest's shop lives on somebody else's machine and they cannot open it alone. The
Node process was a neutral third party and there is no longer one. This is a
genuine downgrade from the desktop build and the right response is to say so in
the UI at Host/Join time, not to engineer around it — a guest who is told "this is
Will's shop, it's open while he is" understands it immediately, and one who finds
out by having it vanish does not.

### MCP does not come

This is the price, and it is a big one. Content-in-the-database authored live by
two agents is the premise the whole codebase is organised around — CLAUDE.md's one
rule, `content_version`, the schemas, the export ritual. All of it runs over
[`server/api.js`](../server/api.js), twenty-eight express routes, and a tab cannot
listen on a socket.

So the web build ships a **fixed catalogue**: whatever `npm run export` last wrote
into `data/seed/*.json`. Players get the game; they do not get to author it.

That is the correct trade for a link somebody clicks, and it is the *reason the
desktop build should still exist* rather than an argument against the port. The
seams above are drawn so that the Node build keeps every one of these
capabilities untouched — which means the modding story from
[docs/shipping.md](shipping.md) is still available to whoever wants it, and the
web build is the demo that makes them want it.

There is a third way and it should not be taken yet: an MCP server that joins the
signalling broker as another peer and speaks the same frames the guest does. It
is possible, it is not large, and it is a distraction from getting the thing
online.

---

## What must not happen

- **The transport shim must not fork behaviour.** One branch on which build it is
  and every verify sweep stops being evidence about the web target. Four methods,
  no state, no conditionals.
- **The two stores must not drift.** They implement one interface and the Node one
  is the definition. Anything the web store cannot do must *refuse* loudly
  (`upsert`, `remove`) rather than silently succeed into memory — a content write
  that appears to work and vanishes on reload is the worst failure in here.
- **`data/seed/*.json` must not become the source of truth.** It is an export.
  The web build reads it; the DB still writes it, via `npm run export`, exactly as
  today. The moment somebody hand-edits it to fix the web build, the one rule that
  makes co-op work is gone.
- **No SQLite in the browser.** See above. If content ever needs to be writable in
  a web build, that is a decision to re-open MCP, not a decision to add a query
  engine.
- **The sim must not learn it is in a worker.** The boundary is the room's, not
  the game's. `Game` takes no messages and posts none.
- **The connection failure must not be silent.** A Join that cannot traverse NAT
  says so in words. A spinner is a bug report we cannot action.
- **Per-player money must not creep in.** Inherited from
  [docs/shipping.md](shipping.md) and unchanged: one shop, two pairs of hands. The
  moment `world.cash` is a map, `simulate` stops modelling the game.

---

## Steps

1. ~~**The transport shim, single player, still in Node.**~~ **Built.**
   `ShopRoom(Base)` is the shop; `MartRoom = ShopRoom(Room)` is the Colyseus
   binding. Nothing user-visible, no behaviour moved, every sweep green. This is
   the whole port's load-bearing step and it was refactoring rather than porting.
2. ~~**The store shim, still on SQLite.**~~ **Built.** `db.js` is the contract,
   `store/sqlite.js` the implementation, `store/keys.js` the format both share.
   Nineteen functions, no importer changed, again nothing moved.
3. ~~**The web store.**~~ **Built.** [`server/store/web.js`](../server/store/web.js):
   the seed export for content, an in-memory save behind an injected vault,
   IndexedDB behind that, and the swap is a Vite alias. `npm run verify:store` is
   403 assertions that it and SQLite are the same shop. What remains before the
   sim actually runs in a tab is the second transport Base and a client entry —
   that is step 5's work, not the store's.
4. ~~**The worker.**~~ **Built.** [`ChannelHost`](../server/rooms/host.js) is
   the Base, guarded by `npm run verify:host` — 44 assertions driving a real
   shop at 20Hz with no socket anywhere. [`client/worker.js`](../client/worker.js)
   is the packaging, and [`client/localnet.js`](../client/localnet.js) is `Net`
   with a `postMessage` pair where the websocket was.
5. ~~**Ship it single-player.**~~ **Built.** `npm run build:web` writes a static
   `dist-web/` that needs no server, no database and no socket. This is the point
   of the whole document and it went online here, before any of the multiplayer
   work — a link that works alone is already the thing that was wanted.
6. ~~**P2P, copy-paste signalling.**~~ **Built.** Host and Join, two codes,
   legible failure. [`client/peer.js`](../client/peer.js) is the wire,
   [`client/coop.js`](../client/coop.js) is the front of it, and
   `LocalNet.host()` / `becomeGuest()` are the two ends inside the transport —
   one object whose *wire* can change rather than a second `Net`, because
   `main.js` wires forty handlers by reference at boot and swapping the object
   afterwards would leave every one of them pointing at the old one.
7. **A broker.** ~~If the two-paste flow annoys anyone.~~ It did, immediately —
   an SDP is about 2KB of base64 and nobody pastes that into a chat twice.
   [`broker/`](../broker/src/index.js) is a Cloudflare Worker plus one Durable
   Object: it holds an offer and an answer under a six-character code for five
   minutes, then deletes itself. **Built and deployed** — `npm run deploy:broker`,
   and the client is built with `VITE_SNS_BROKER=<url>`. It bought a second thing
   nobody asked for and which turned out to matter more than the code: `?join=`
   in the URL, read by `main.js` before the menu is drawn, so an invite is a link
   somebody clicks rather than a form they fill in.

   Three things about it are design rather than implementation. It is
   **optional**: with the variable unset `haveBroker()` is false and the game is
   step 6 exactly, which is what keeps a fork — or a build off a USB stick —
   able to do co-op with no infrastructure at all. Every failure inside it
   **falls through** to that path rather than reporting, because a broker that
   is down or blocked is a longer code and not a broken feature. And it is a
   **Durable Object rather than KV**, which is a race rather than a preference:
   KV is eventually consistent, so a guest reading a code the host wrote a
   second ago can legitimately get nothing back — and what that looks like is a
   room code that works on the second try.

   The alphabet drops every ambiguous pair (no O/0, I/L/1, S/5, B/8), because
   somebody is going to read it out over a voice call.
8. **TURN,** if the failure rate is worse than it looks on paper. Costs money;
   decide with numbers rather than in advance — **and there are no numbers yet**,
   which is the honest status of this step rather than a reason to skip it. Two
   people have connected; nobody has failed to. Until somebody clicks Join and
   watches it not work, the low-teens figure in *P2P* above is a number off the
   internet and not a number about this game.

Steps 1 and 2 are worth doing whatever happens to the rest — they are seams the
desktop build wants anyway, and they are the two that are pure refactor.

**Co-op is last because it is downstream, not because it is hard.** Worth saying
plainly, because "multiplayer, deferred" usually means "multiplayer, dreaded" and
this is not that. Steps 1–4 are unconditional prerequisites for it: a room still
extending `colyseus.Room`, still reading SQLite, still on the page's main thread
cannot be one end of a peer connection whatever you do to the wire. So there is no
version of this project where co-op comes earlier, and nothing in 6–8 has to be
designed for while doing 1–4 beyond the seam that is being built anyway.

Step 5 is therefore a **marker rather than a gate**: it says do not let co-op hold
up going live. If 6 happens to be working when 4 lands, ship both — there is
nothing to wait for.

And the cost of step 6 is not the transport. `RTCDataChannel` is a send and an
onmessage, and the snapshot protocol it carries is the one already running. The
work is Host/Join in the UI, an invite code somebody can actually paste, a
connection failure that says what went wrong in words, and the part no sweep can
help with — two machines on two real networks, one of which fails. Budget it as
interface and testing, and do not be surprised when the WebRTC itself is an
afternoon.

---

## Where it lives

Two Cloudflare things, and the split between them is the same one the document
argues everywhere else: one of them serves files and the other one holds two
connection blobs for five minutes. **Neither of them has ever seen a shop.**

```bash
npm run build:web      # a static dist-web/ — no server, no database, no socket
npm run deploy         # → Pages, project `sprocket-and-stock`
npm run deploy:broker  # → the Worker in broker/
npm run deploy:all     # the broker first, then the pages
```

The order in `deploy:all` is deliberate and is the only thing about deploying
worth writing down: the client is built with the broker's URL baked in
(`VITE_SNS_BROKER`), so a page deployed against a broker that is not there yet
does not fail — it *falls through to the two-paste flow*, which is a feature
working correctly and looking exactly like the feature being missing. Broker
first, and the fall-through stays what it is for: somebody else's fork, and a
build off a USB stick.

`wrangler login` once, and both are `npx wrangler` from the repo — there is no
CI, on purpose. A deploy is a build and an upload of a folder, and the thing that
decides whether it is safe is `npm run verify`, which runs against the Node
build and would not know a Pages project if it met one.

---

## Verifying it

Almost none of this is balance, so `simulate` has nothing to say and the ten-seed
ritual does not apply. What makes it unusual is that **the whole port is a claim
that nothing changed**, which is the kind of claim this codebase already knows how
to make.

**The twenty-three `verify:*` sweeps are the control, and they only stay one if
the Node build keeps running them.** Steps 1 and 2 are proven by every existing sweep
passing unchanged — that is precisely what a seam with no behaviour in it means.
If a sweep needs editing to accommodate the shim, the shim is wrong.

**Step 3 has its sweep** — `verify:store`, 403 assertions, every one of them a
comparison run against both stores in one breath rather than a value. It seeds a
throwaway SQLite file from the same `data/seed/*.json` the web store imports and
diffs the two field by field, then runs one script of world-row, save and
modifier operations through both and diffs every answer.

It found its bug before the feature it guards had ever run, and the bug is worth
knowing because nothing about it is visible: `npm run seed` does not copy JSON
into a database, it calls `writeContent`, and **a zod parse fills in defaults**.
So the committed export is a mixture — rows re-saved since a field was added
carry it, rows untouched since do not — and reading it raw handed out
`alpha: undefined` for some items and `1` for others, split by which rows
somebody last edited. Ninety rows differing in `model`, `tiers` or `surface`,
none of which would have crashed anything. The web store parses through the same
schemas now, so the two agree by construction rather than by luck.

Its other half is **durability**, which is the only claim in there about
something that has not happened yet: every other assertion passes against a store
that never writes to its vault at all. So it throws the whole store away and
reads it back — including that a *deleted* world stays deleted, which is the
failure that would look like the game resurrecting a save.

**Step 4 is invisible and needs a stopwatch.** A worker that is silently throttled
and a worker that is fine are the same still frame — the tell is in-game hours per
real minute with the tab hidden, which has to be measured deliberately because
nobody watches a tab they have backgrounded.

**Step 6 needs a real network, twice**, and should be written down as a manual
test rather than pretended into automation: two machines on different networks,
and one pair behind a NAT that fails, to confirm the failure is the legible one.
The nearest thing to a unit test here is the snapshot size — nobody currently
knows what 10Hz of full-world JSON costs, and it is one `console.log` away.

**But most of step 6 is not the network, and that half IS automatable** — which
is worth saying because the whole feature reads as untestable and only the wire
is. A channel is `{post, onFrame, onClose, close}`, and `linkedChannels` is a
channel: everything downstream of "the wire said something" or "the wire died" is
a room, a client and a `Game`, none of which has ever known what it was on.
`verify:host` therefore covers a second guest arriving, two guests being told
apart, one of them dropping mid-carry, their goods landing on the floor, the
other one carrying on, and a shop closing under whoever is still in it. What it
cannot cover is what `linkedChannels` is not: SDP, ICE, and the 48KB message cap
that only SCTP has. That line — **the peer connection is manual, everything
behind it is a sweep** — is the one to hold when adding to this.

The manual list, then, is short and specific:

| | what to watch |
|---|---|
| Two machines, two networks | that they connect at all, and that the catalog arrives — a shop full of untextured boxes is the chunking bug coming back |
| A pair behind symmetric NAT | that the failure is the sentence in `waitOpen`, within 20s, and not a spinner |
| Guest closes their tab mid-carry | on the HOST's screen: the guest goes and the pill stops claiming a friend is connected. **No crate** — reopen the invite link and they walk back in still holding it |
| Host closes their tab | on the GUEST's screen: "The shop has closed", not a shop that quietly stopped |
| Host's laptop sleeps | the same message, but tens of seconds later — that is ICE giving up, and there is no faster honest signal |
| A second guest, while the first is in | one shop, three people, and an invite that can be minted while somebody is already in |
