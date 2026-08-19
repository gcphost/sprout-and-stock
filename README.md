# ⚙️ Sprocket & Stock

A cozy shop-and-farm sim where you are the only human on the payroll — and a
game you and someone else build **while playing it**.

You buy the robots, you set what each one cares about, and they grow the crops
out back, fill the shelves out front and work the queue. Get the dials wrong and
they'll spend the day politely doing the wrong job. Meanwhile the world decides
what the town is doing today — a heat wave, a viral snack, a supply shortage —
and the shop has to react.

Everyone who works here is a machine. Everyone who shops here, mostly, isn't.

**Play it in a browser:** <https://sprocket.willbowman.dev> — no download, no
account, and a friend can join your shop over a link.

It's free. If you want more of it: **[support the game](https://buymeacoffee.com/sprocket.n.stock)**.

---

## Two builds, one codebase

The seams are drawn in exactly two places — the transport and the store — so
neither target is the other one's compromise. See
[docs/browser.md](docs/browser.md).

| | **Web** | **Desktop / dev** |
|---|---|---|
| How you play | a URL | `npm run dev`, localhost:5173 |
| Where the shop runs | a Worker in your own tab | a Node process |
| The save | IndexedDB, in your browser | `data/game.db` (SQLite) |
| Content | a fixed catalogue, baked in at build time | live SQLite you can edit while playing |
| Agents / MCP | no | yes — the whole control API |
| Co-op | P2P over a data channel, one paste | websocket over `npm run tunnel` |

The web build is how somebody who has never heard of this ends up standing in
the shop four seconds later. The desktop build is where the thing gets made.

---

## Playing

`WASD` or drag to move · `G` build · `H` crew · `B` supplier · `T` shop ·
`U` upgrades · `M` milestones · `/` menu · `Esc` backs out one layer

**Click a thing and you walk over and do it.** A tap names a target and sends
you there; a ring fills when you arrive, and walking off throws it away.
Nothing ever happens just because you stood near something — the two exceptions
are a till with somebody waiting and a ripe bed under your own feet.

- **A tap is one, a hold is the lot.** Left button takes, right button puts. Tap
  a shelf board for a single loaf; hold it and the whole board goes into a crate
  on your shoulder.
- **To farm:** walk to a bed and hold to turn the soil, pick the crop in the
  bed's own menu to sow, then harvest once it's grown. Whatever doesn't fit in
  your hands lands in a crate at your feet.
- **`G` opens build mode.** Press it again for the catalogue. Buy and place
  shelves, freezers, hot counters, tills, beds and appliances; drag walls along
  tile edges to draw rooms; paint floors, paint walls a side at a time, and paint
  the yard, the break room, the car park, the road and the pavement.
- **Doors know who's asking.** Staff-only, entrance-only, exit-only.
- Everything sells back at half. Every tier ladder goes down as well as up.

The full key list is in the in-game Menu (`/`).

---

## Playing together

**Web:** the host opens their shop and shares the invite; the guest clicks it.
The host's tab *is* the server — it runs the sim and broadcasts snapshots down a
`RTCDataChannel`. A ~50-line Cloudflare Worker (`broker/`) does the introductions
and holds no game state, ever. Some network pairs can't be introduced directly
and the game says so plainly instead of spinning.

**Desktop:** one machine hosts.

```bash
npm run tunnel
```

It prints a public URL. The other person opens it — no install on their side.
The same URL also serves the control API, so **their agent can drive the game
too**. To keep that surface private, set a shared secret first:

```bash
# macOS / Linux
SNS_TOKEN=some-shared-secret npm run tunnel

# Windows PowerShell
$env:SNS_TOKEN="some-shared-secret"; npm run tunnel
```

---

## Working on it

Needs [Node.js 20+](https://nodejs.org). Works the same on macOS and Windows.

```bash
git clone <your repo url> sprout-and-stock
cd sprout-and-stock
npm install
npm run seed     # load the starter items, crops and customers
npm run dev      # → http://localhost:5173
```

`npm run dev:web` runs the browser build instead: no server at all, the shop in
a Worker, the same client.

### Building it together (the actual point)

Add this to `.mcp.json` in the project (already included) or to your Claude
Code MCP config. On the **host** machine it works as-is. On the **guest**
machine, set `SNS_API` to the tunnel URL:

```json
{
  "mcpServers": {
    "sprout-and-stock": {
      "command": "node",
      "args": ["mcp/server.js"],
      "env": {
        "SNS_API": "https://your-tunnel-url.trycloudflare.com/api",
        "SNS_TOKEN": "some-shared-secret"
      }
    }
  }
}
```

Now your agent can:

| Tool | What it does |
|---|---|
| `get_state` | Read the live shop — cash, shelves, customers, everything |
| `screenshot` | **See** the game (asks a real browser tab to render a PNG) |
| `simulate` | Fast-forward 100 in-game days headless and report whether the economy works |
| `create_item` / `create_crop` / `create_archetype` | Add content that appears in the running game in ~1 second |
| `create_fixture` / `create_worker` / `create_recipe` | Author what you can build, who you can hire, what machines make |
| `stock_shop` | Fill shelves + plant fields so you can look at something |
| `spawn_customer` | Drop shoppers in now instead of waiting |
| `add_modifier` | Force a demand spike to test a tag |
| `regenerate_layout` | Rebuild the shop from a new seed |
| `list_tags` | The tag vocabulary — read this before creating anything |

Try asking your agent:

> *"Add three snacks a teenager would want, then simulate 30 days and tell me if
> they actually sell."*

> *"Screenshot the shop, then make the shelves look less like brown boxes."*

> *"Invent a customer type nothing on my shelves currently satisfies."*

**MCP is the desktop build only.** A tab cannot listen on a socket, so the web
build ships whatever `npm run export` last wrote into `data/seed/*.json`.
Players get the game; they do not get to author it. That trade is the reason
the desktop build should keep existing, rather than an argument against the web
one.

### Why it doesn't conflict

Content — items, crops, customers, fixtures, events, upgrades — lives in a
**SQLite database**, not in source files. Adding an item is an `INSERT`,
validated on the way in, live on the next tick. Two people adding content at the
same time simply cannot collide, and bad content is rejected with an explanation
instead of breaking anyone's game.

Code still lives in git, where it belongs.

`npm run export` dumps the live database back to `data/seed/*.json` so your
session's content becomes a reviewable commit:

```bash
npm run export && git add data/seed && git commit -m "new snacks"
```

### Verifying

```bash
npm run verify
```

Twenty-three sweeps, about half a minute. They exist for the claims a screenshot
can never make: that a floor is a *look* and never a permission, that painting a
wall doesn't change the shape of the shop, that a warmer is still a warmer after
you buy a shelf, that a build-and-sell round trip always loses money. Most of
them found a real bug the day they were written. What each one guards is written
down in [CLAUDE.md](./CLAUDE.md).

---

## World events

Once per in-game day the world decides what it's doing, and expresses it as
multipliers on **tags** rather than on specific items — so an event written
today still works on an item invented next month.

**There is no model in the game.** `server/director.js` *is* the director: a
driver tag drawn from the season and filtered to tags something in the shop
actually carries, allies that ride along, a rival that takes the other side of
it, multipliers rolled in bands, a duration, a headline from a template, and a
no-repeat guard so the same story isn't dealt three days running. Beside it, the
authored `events` rows in `data/seed/events.json` are drawn a quarter of the
time, for a set piece somebody wrote on purpose.

No API key, no network call, no `@anthropic-ai/sdk` in the dependency list, and
nothing a player reads is generated at runtime. Agents still author events — via
`create_event` and `add_modifier` over MCP — which is where a model belongs in
this project: at the keyboard, not in the build. The argument in full is
[docs/steam.md](docs/steam.md) §4.

---

## Deploying

The web build is static and needs no server:

```bash
npm run deploy:all      # the broker first, then the pages
```

Broker first matters: the client bakes in the broker URL, and a page pointed at
a broker that isn't there falls back to the long-code invite flow silently.

The Node build serves its own client, so it's a single process:

```bash
npm run build
NODE_ENV=production npm start
```

That runs everything on one port (`2567` by default, or `PORT`). Any host that
runs Node with a persistent disk works. The only stateful thing is
`data/game.db`; mount a volume for it and the shop survives restarts.

---

## Commands

| | |
|---|---|
| `npm run dev` | Server + client with hot reload |
| `npm run dev:web` | The browser build — no server, shop in a Worker |
| `npm run tunnel` | Public URL for playing together |
| `npm run verify` | The twenty-three sweeps |
| `npm run seed` | Load `data/seed/*.json` into the database |
| `npm run export` | Dump the database back to `data/seed/*.json` |
| `npm run reset` | Wipe the world and reseed |
| `npm run build` | Build the client for the Node server |
| `npm run build:web` | Build the standalone `dist-web/` |
| `npm run deploy:all` | Broker, then the web game |

Design notes and the working agreement between the two of you live in
[CLAUDE.md](./CLAUDE.md). Per-feature design docs are in [docs/](docs/).

---

## Support the game

Free to play, and staying that way. If you want to see more of it built:
**[buymeacoffee.com/sprocket.n.stock](https://buymeacoffee.com/sprocket.n.stock)**
— that's just where the button lives; it funds the game, not anybody's coffee.
