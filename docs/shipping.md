# Shipping — a standalone game you can invite someone into

Status: **nothing built.** All eight steps are proposed.

The decision: Sprocket & Stock ships as a **downloadable binary**, single-player
by default, with a Host button that lets one friend in. Not a hosted service.

The reasoning is in the shape of the code rather than in a business plan. Every
live world is a 10Hz simulation in a Colyseus room, so a hosted version pays CPU
per *active player* rather than per request. [`server/director.js`](../server/director.js)
calls an LLM for world events, so a hosted version pays for everyone's heat
waves. And nothing in [`server/sim/index.js`](../server/sim/index.js) gets better
because a stranger is online — there is no PvP, no player-to-player trade, no
shared economy. What exists is couch co-op over a wire: two people in one shop.
That is Stardew-shaped, not MMO-shaped, and the port is nearly free because the
sim already runs headless for `simulate` and SQLite is already a local file.

**MCP ships with it.** That is the second decision and the more interesting one
— see *The mod surface* below.

---

## What's wrong today

Everything here works fine in dev and fails the moment there is no terminal, no
localhost and no second agent.

### Nobody can invite anyone without a terminal

[`scripts/tunnel.js`](../scripts/tunnel.js) spawns `cloudflared`, watches its
**stderr** for a URL, and prints it to a console:

```js
const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
if (url) console.log(`\n  🌍 Shop is live at: ${url[0]}`);
```

In a packaged app there is no console anyone reads and no `npm` to run. The
entire sharing story is a dev script.

### A disconnect deletes what the guest was carrying

Player identity is `client.sessionId` — per *connection*, minted fresh by
Colyseus on every join. And [`removePlayer`](../server/sim/index.js#L1785) is
one line:

```js
removePlayer(id) {
  delete this.players[id];
}
```

`p.carry` goes with it. A guest holding a crate who loses wifi for four seconds
has destroyed those goods, and comes back as a brand-new "Player 2" standing at
spawn with a different colour. Nothing logs it, and the stock is simply gone
from the world.

This is invisible in development for the obvious reason: nobody's localhost
drops. It is the single most likely first bug report from a real co-op session,
and it is a **conservation** failure — the same class of bug
`scripts/verify-build.js` was written to catch everywhere else.

### The invite link is an admin console

`SNS_TOKEN` is opt-in ([`server/api.js`](../server/api.js#L60)). Unset, every
route except the three in `OPEN_ROUTES` is wide open to whoever has the URL:
`add_cash`, `delete_world`, `delete_content`, rewrite the entire item catalogue.

The safeguard is a `console.log` in the tunnel script advising you to set a
token. That warning has exactly the same problem as the URL it sits next to — in
a binary, nobody sees it. Between two consenting adults with agents this is
fine and deliberate. Shipped, it is a default that cannot stand.

### The save is inside the app bundle

```js
export const DATA_DIR = path.join(__dirname, '..', 'data');
```

[`server/db.js:26`](../server/db.js#L26) — relative to the source file, which
after packaging is inside `Sprocket & Stock.app/Contents/` or Program Files. Both
are read-only. The first write fails, or worse, succeeds into a location the
next update wipes.

### ~~The sweeper deletes saves after a fortnight~~ — gone

`sweepWorlds` binned any world untouched for a fortnight, skipping worlds you
had pressed Keep on, occupied ones and the last standing. Right for a shared dev
box filling up with throwaway test shops, wrong for anybody who plays every other
weekend: it deleted their shop, and "the last world standing survives" meant they
kept *a* save, just not the one they cared about. Removed rather than defaulted
off — the Keep button on the menu only existed to say "not this one", so a save
that never expires retires both halves and one fewer thing on the card is the
point. A save goes when somebody deletes it.

### There is no pause

Grep the sim and the room for it; there isn't one. The shop trades while you
answer the door. Acceptable in a two-player dev session where the world is
always somebody's problem, not acceptable in a single-player game.

### The director's fallback quietly becomes the whole game

No API key means built-in events, which already works and is deliberate (the
director is fire-and-forget with a hand-written fallback precisely so a dead API
never blocks the tick). But in a shipped game **approximately nobody will set a
key**, so the hand-written events stop being a safety net and become the world
every player actually experiences.

---

## The shape

### The invite code *is* the token

One decision closes both the sharing hole and the admin hole, and it works
because they are the same string.

On Host: mint a random session token, start the tunnel, and encode
`{url, token}` into one short code the host can paste into a chat. On Join: the
guest pastes it, the client stores the token and sends it on every `/api` call
and in the room's join options.

What that buys:

- **There is no unauthenticated public surface, ever.** `SNS_TOKEN` stops being
  opt-in; the packaged build always has one, because the code that hands out the
  URL is the code that mints it.
- **`OPEN_ROUTES` can shrink.** It exists because gating all of `/api` meant
  nobody could fetch the world list to pick a shop. When the token arrives
  *with* the address, there is no window where a client knows where the game is
  but not who it is — so world listing can be gated too, and only
  `/screenshot/upload` needs to stay open (it is answering a request the server
  itself made).
- **The guest's agent gets MCP for free**, with the same token, which is the
  behaviour the tunnel already has and the reason the control API was put on the
  same port in the first place.

The dev default does not change. `npm run dev` on localhost with no token stays
exactly as it is; it is the *packaged* build that makes the token mandatory.

### A disconnect drops your crate on the floor

```js
removePlayer(id) {
  const p = this.players[id];
  if (p?.carry) this.dropGoods(p.carry.item_id, p.carry.qty, { x: p.x, z: p.z });
  delete this.players[id];
}
```

That is the whole fix, and it is a fix the codebase has already made four times:
*a pallet is the only "goods on the floor" object there is*. Deliveries, clearing
your hands at the bay, a stripped shelf and an emptied hopper all become one.
A disconnect is now the fifth caller of the same function, so it needs no new
entity, no new renderer, and the stocker tidies it away for free.

[`dropGoods`](../server/sim/index.js#L2279) already merges into a crate of the
same thing standing on that tile, so a guest whose connection flaps four times
leaves one crate rather than a forest of one-unit pallets.

### Identity is per install, not per connection — **built**

A random `who` minted once and kept in the client's local storage (`whoAmI`,
[client/net.js](../client/net.js)), sent as a join option. The shop keys what it
remembers about a person on that instead of on `sessionId`, so a reload is the
same person coming back rather than a stranger arriving — which is what it
always was everywhere except inside `this.players`.

Built **without** `allowReconnection`, and the difference is worth writing down
because it turned out to be the smaller feature. A reconnection window is about
a socket: it holds the live object open for thirty seconds and then gives up.
What was actually wanted is about a *save* — reload, restart the server, come
back tomorrow, and be where you were. So there is no window at all. A leaver is
written to `Game.away` keyed by `who`, `away` goes into the save beside
`staffAt`, and `addPlayer` restores from it however long it has been.

Three things hold it together, and each is a hole if it goes:

- **The record is consumed on the way in.** Two tabs of one browser are one
  `who`, so a row still sitting there after somebody has claimed it is a second
  armful of the same six loaves. First one in gets the goods.
- **...and the reverse: writing a row that already exists drops what the old one
  held.** Same two tabs, both leaving. That is the one case the crate-on-the-
  floor behaviour is still exactly right for.
- **A remembered spot is offered, never trusted.** The shop is rebuilt while you
  are away, so `canStand` asks the walk grid before putting you back — coming
  back inside a shelf is worse than coming back at the door, because there is no
  way to walk out of it. Hands come back regardless: where you stood and what
  you held are two facts and only one of them a wall can invalidate.

`saveState` writes rows for people who are still CONNECTED as well, which is not
belt and braces — `node --watch` restarting under a player who never left is how
this shop actually goes down, and `removePlayer` is never called on that path.

Note the ordering trap that was predicted here and is real: `addPlayer` counts
humans to assign name and colour (`colors[humans % colors.length]`). The restore
happens inside that function rather than around it, so the count is untouched.

### The guest owns nothing, and that is the design

No cabins, no per-player wallets, no second save slot. The guest joins the
host's shop and keeps nothing when they leave.

This is worth writing down because the alternative is seductive and expensive.
Split money means every number in [`server/sim/economy.js`](../server/sim/economy.js)
grows an owner, `world.cash` becomes a map, and every upgrade, wage, purchase
and till transaction has to answer "whose?". The game is about **one shop**.
A second human is a second pair of hands in it — closer to a hire who happens
to be a person than to a second player with a parallel campaign.

### The mod surface

MCP ships in the binary. The pitch: when the game goes stale, someone can add
twelve crops, a new customer archetype and a shelf design without a compiler,
and hand the file to a friend. Everything that makes that work is already
built — content lives in the database, `content_version` reloads the registry
live, and [`shared/schemas.js`](../shared/schemas.js) is the only gate in.

Four things follow from shipping it:

- **It has to be discoverable.** A Modding panel that prints the stdio command
  to paste into an agent's config, plus the session token, plus the tag
  vocabulary — because *an item with invented tags will exist and never sell*
  is the first mistake every author makes, and a shipped game cannot rely on
  anyone having read `CLAUDE.md`.
- **`npm run mcp:http` points at a file that does not exist.** `mcp/http.js` was
  deleted or never written; `mcp/` contains only `server.js`. Either build it —
  an HTTP transport is the natural thing for a guest's agent reaching a host
  over the tunnel — or delete the script before someone tries it.
- **An update must not overwrite what a modder authored.** `npm run seed` loads
  `data/seed/*.json` into the database. In a shipped game an update ships new
  seed files, and if seeding overwrites by id, the player's edited tomato
  reverts every patch. Seeding on update has to merge — insert what is missing,
  leave what exists alone — which is a different operation from the reset-and-
  reseed that `npm run reset` does today.
- **It is the permanent admin backdoor**, which is the other half of why the
  token above is not optional. A mod surface and a cheat surface are the same
  surface; the answer is that it is *authorised*, not that it is *limited*.

### Data lives where the OS says it does

Per-user application data (`~/Library/Application Support`, `%APPDATA%`,
`$XDG_DATA_HOME`), passed to the server as `SNS_DB` — which
[`db.js`](../server/db.js#L28) already honours, because `simulate` needed it for
frozen-world measurements. The mechanism exists; only the caller is new.

First run copies the bundled `data/seed/*.json` in and mints the first world,
which `ensureAWorld` already does. Nothing to turn off beyond that — saves no
longer expire.

### Pause

The room stops stepping the sim. In co-op it pauses for both, and says whose
doing — a guest whose shop silently freezes will assume it crashed.

---

## What must not happen

- **The token must not be optional in a packaged build.** Not "defaults to on" —
  absent entirely as a choice. A setting that can be turned off is a setting
  someone will turn off to fix a connection problem, and then the shop is a
  public API.
- **A mod must not be able to brick a save.** `shared/schemas.js` is the gate,
  and a bad row has to be *refused* there rather than crashing the room on the
  next tick. Today a malformed row mostly cannot get in; a shipped modding
  surface is the first time that claim gets adversarial traffic from someone who
  is not being careful.
- **An update must not overwrite authored content.** See above. This is the one
  failure that loses somebody a week of work and cannot be undone.
- **Per-player money must not creep in.** The moment `world.cash` is a map, so
  is everything downstream, and `simulate` no longer models the game.
- **The reconnect window must not be generous.** A guest held open for ten
  minutes is a person standing in the shop who is not there — blocking a break
  seat, holding stock, counted as a human by `addPlayer`'s colour assignment.
  Thirty seconds or so; after that they have left and their crate is on the
  floor.
- **Pausing must not be per-client.** One paused world, both people told about
  it. A host who pauses while the guest keeps playing is two divergent
  simulations, which is not a bug this architecture can survive.

---

## Steps

1. **Data dir.** Per-user path via `SNS_DB`, first-run seed copy. Nothing
   user-visible; everything else needs it.
2. **Drop on disconnect.** `dropGoods` in `removePlayer`. Three lines, and the
   only step that fixes a bug that exists *today*.
3. ~~**Stable player id + `allowReconnection`.**~~ **Built**, and without the
   reconnection window — what was wanted was a save, not a socket. See above.
4. **Pause**, broadcast to both clients.
5. **Session token.** Minted on host, mandatory when packaged, `OPEN_ROUTES`
   shrunk to the screenshot upload.
6. **Host / Join UI.** `cloudflared` bundled and driven in-process, URL + token
   encoded as one pasteable code.
7. **Modding panel.** The MCP command, the token, the tag list. Merge-on-update
   seeding. Fix or delete `mcp:http`.
8. **Package.** Tauri or Electron, first-run, updater, icons.

1–4 are worth doing regardless of whether anything ever ships, because 2 and 3
are live bugs and 4 is a missing feature. 5–8 are the port.

---

## Verifying it

Almost none of this is balance, so `simulate` has nothing to say about it and
the ten-seed ritual does not apply. Two things are worth a sweep:

**Step 2 is a conservation claim**, which is exactly what
`scripts/verify-build.js` already asserts about tilling, stowing, stripping and
selling back: *nothing is created or destroyed*. Carry goods, call
`removePlayer`, and assert the world holds the same total as before with the
difference standing on the floor. Same harness, one more case.

**Step 3 needs a real network**, which no sweep can give it. Pull the guest's
cable mid-carry, twice: once inside the window (same player, still holding it)
and once outside (crate on the floor, one crate not four). That is a manual
test and should be written down as one rather than pretended into automation.

Step 5 is the one to be paranoid about, because a failure is silent in the
direction that matters — a token that is checked everywhere still leaves the
game working, so nothing tells you when a route is accidentally open. Assert
the negative: enumerate the routes `createApi` mounts and check every one that
is not `/screenshot/upload` returns 401 without a token. A test that lists
routes from the router rather than from a hand-kept list, or the next route
somebody adds is the one that isn't covered.
