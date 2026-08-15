# Sprout & Stock — working agreement

A farming + mini-mart game, built by two people at the same time, each with
their own agent, against one shared running world.

Read this before changing anything.

---

## The one rule that makes co-op work

**Content goes in the database. Behaviour goes in code files.**

| You want to… | Do it via | Why |
|---|---|---|
| Add an item, crop, customer type, event, upgrade | **MCP tool** (`create_item`, `create_crop`, …) | Lands in the live game in ~1s. No file write, so two people can never conflict. |
| Change how a mechanic works | **Edit a file** in `server/` or `client/` | Logic belongs in git where it can be reviewed and diffed. |

Never hand-edit `data/seed/*.json` to add content — use the MCP tools. Those
files are an *export* of the database (`npm run export`), not the source of
truth while you're playing. Editing them directly is the one way to
reintroduce merge conflicts.

---

## Tags are the whole design

Nothing in this game is hardcoded to a specific item. Customers don't want
"tomato" — they want things tagged `produce` + `cheap` + `organic`.

That means a brand-new item automatically gets:

- the right customers (tag affinities in `archetypes`)
- a sensible price (tag-based multipliers in `sim/economy.js`)
- correct spoilage and fixture rules (`shared/tags.js` → `BEHAVIOUR_TAGS`)
- seasonal swings and world-event effects, for free

**Before creating content, call `list_tags`.** An item with invented tags will
exist and never sell — that's the single most common mistake here, and
`simulate` will report it under `deadStock`.

If you ever find yourself writing `if (item.id === 'tomato')` in `server/`,
stop. Add a tag instead.

---

## Two habits that matter

**After changing anything that touches money — run `simulate`.**
Adding an item, repricing, editing an archetype, changing an upgrade cost.
Balance is invisible from reading code. `simulate` runs 100 in-game days in
about a second against a throwaway world and tells you if you just made the
game unplayable. Use the same `seed` before and after so the comparison means
something.

**After changing anything visual — call `screenshot`.**
The server has no renderer, so `screenshot` asks a real browser tab to render
its canvas and hands you the PNG. Look at it. `stock_shop` first if you want
the shelves full rather than an empty building.

**After touching `layout.js`, `shared/build.js` or an action — run `npm run verify`.**
Two sweeps, about two seconds:

- `verify:layout` generates ~100k layouts across seeds × counts and asserts the
  generator placed *exactly* what it was asked for, that every fixture has a
  reachable working spot, that queues stay indoors, and that hand-placed
  fixtures land on the tile they were given.
- `verify:build` drives a real `Game` through tilling, stowing, stripping,
  building, moving and selling back, and asserts nothing is created or
  destroyed on the way.

Both found real bugs the day they were written. Neither is visible in a
screenshot of one seed — which is exactly why they exist.

⚠️ **`simulate` reads the live modifier table.** Two runs of the same seed are
only comparable if the world events are the same in both. A stack of duplicate
modifiers was worth 1.9× profit on one measured seed, which will swamp whatever
you were actually trying to measure. `clear_modifiers` before a before/after.

---

## Who owns what

Keep to your side and you'll almost never touch the same file.

| Area | Path | Notes |
|---|---|---|
| Content (items, crops, customers, events, upgrades) | *the database* | Either person, any time, via MCP. No conflicts possible. |
| Look of things (colours, props, characters) | `client/render/palette.js`, `client/render/props.js` | Safe, self-contained, very visible. Good place for a kid to start. |
| UI and HUD | `client/ui.js`, `client/index.html` | |
| Rendering internals | `client/render/scene.js` | |
| Economy and balance | `server/sim/economy.js` | Re-run `simulate` after every change. |
| Customer behaviour, crops, actions | `server/sim/index.js` | The biggest file. Coordinate before restructuring. |
| Layout generation | `server/layout.js` | Re-run `npm run verify` after every change. |
| Build placement rules | `shared/build.js` | Imported by **both** client and server on purpose — see below. |
| Tile vocabulary | `shared/tiles.js` | The one place tile kinds are defined. |
| Tag vocabulary | `shared/tags.js` | Adding a tag is safe. Changing what one *means* affects everything. |
| Validation rules | `shared/schemas.js` | Loosen carefully — this is what stops bad content reaching the game. |
| AI director | `server/director.js` | |
| Control API / MCP surface | `server/api.js`, `mcp/server.js` | Change both together. |

---

## Commands

```bash
npm run dev       # game server + client with hot reload (localhost:5173)
npm run tunnel    # build + serve + public Cloudflare URL, for playing together
npm run mcp       # the MCP server (usually launched by Claude Code, not by hand)

npm run seed      # load data/seed/*.json into the database
npm run export    # dump the live database back to data/seed/*.json — do this before committing
npm run reset     # wipe the world and reseed (loses un-exported content)
```

**Commit ritual:** `npm run export && git add data/seed && git commit`.
Without the export, content you added live exists only in your local database
and the other person will never see it.

---

## Architecture

```
shared/     tags.js       the tag vocabulary + what tags DO
            schemas.js    zod validation — the only gate into the database
server/     db.js         SQLite, content tables, content_version trigger
            content.js    in-memory registry; reloads when content_version bumps
            layout.js     procedural store + farm, sized to what you own
            sim/          the simulation (economy, pathing, customers, crops)
            sim/simulate  headless balance runner used by the `simulate` tool
            director.js   AI world events (async, never blocks the sim)
            api.js        HTTP control API — everything MCP can do
            rooms/        Colyseus room; broadcasts plain JSON at 10Hz
client/     render/       three.js isometric renderer
mcp/        server.js     MCP tools, a thin wrapper over server/api.js
```

**State is plain JSON, not `@colyseus/schema`.** At this scale the bandwidth
difference is irrelevant and the readability win is large — you can
`console.log(__sns.state)` in the browser and see the entire world.

---

## Gotchas worth knowing (each cost real debugging time)

- **Colyseus caps *inbound* websocket messages at 4KB.** Server→client is
  unlimited, client→server is not. This is why screenshots are POSTed to
  `/api/screenshot/upload` instead of sent over the socket — a PNG is ~150KB
  and silently closes the connection.
- **`simulate` must stay on an ephemeral game.** `Game.create({ephemeral:true})`
  disables `persist()`. Without it, a balance run overwrites the live save.
- **The layout must place exactly what it's asked for.** An off-by-one in the
  shelf loop meant buying a shelf upgrade sometimes gave you nothing. If you
  touch `layout.js`, verify requested vs placed counts across a range.
- **The AI director must never be awaited by the tick loop.** It's
  fire-and-forget with a hand-written fallback. If the API is down the game
  keeps running; that's deliberate.
- **An empty shelf can be relabelled.** `stockShelf` only rejects a mismatched
  item when `qty > 0` — otherwise farm produce has nowhere to go once every
  shelf has been claimed by a delivery.
- **A pallet is the only "goods on the floor" object there is.** Deliveries,
  clearing your hands at the bay, a stripped shelf, an emptied hopper — all of
  it becomes a pallet. That's deliberate: one entity means one renderer, one
  pickup path, and the stocker tidying every case of it for free. Never invent
  a second container; call `dropGoods`.
- **Proximity arms an action; holding the button fires it.** Standing near
  something is not consent — that version harvested crops at you as you walked
  past. `actionFor` decides *what*, `p.holdInput` decides *when*, and the
  snapshot carries the armed action even at zero progress so the client can
  light the target up and say what holding would do. Anything driving a player
  headlessly (the balance bot) has to set `holdInput` or it silently stops
  acting.
- **Held actions still re-arm the instant they finish.** Fine for stocking and
  harvesting. Not fine for anything destructive or reversible-in-place: a Clear
  tool that stayed armed ate seven shelves in a row, and putting goods down next
  to a crate of the same thing picked them straight back up forever. Anything
  that can pair with its own opposite needs a latch (`stowLock`) or has to
  disarm itself.
- **Build mode is the exception: it arms nothing.** `actionFor` returns null the
  moment `p.build.on` is set. Proximity picked the nearest fixture *centre*, and
  with seventeen shelves on a three-tile pitch that is not a choice anybody can
  make — you got whichever was closest, never the one you meant. So every build
  verb names its target instead: the client aims with `Scene.pickFixture`, and
  `build-lift` / `build-empty` / `build-rotate` / `build-remove` all carry an id.
  Reach is not checked either — you aimed at it, and placing never required you
  to walk over there. Being in build mode is the consent.
- **Aiming at a fixture is not the same as picking a tile.** A shelf is a
  three-quarter-tile-tall box, so on a 45° camera its top face is drawn most of
  a tile up-screen of the ground it stands on. `pickTile` answers "which floor
  tile" (for placing); `pickFixture` intersects each fixture height's top plane,
  tallest first, and answers "which thing am I pointing at". Using the first for
  the second selects the fixture *behind* the one you clicked.
- **`el.className = 'show'` silently deletes the `hud` class**, and with it
  `position: fixed`. The element drops out of the overlay into document flow,
  where you simply never see it. The toast had this from the beginning, which
  is why no error message has ever appeared on screen. Use
  `` `hud show${…}` `` or `classList`.
- **How many fixtures you own is a stored ledger, not a recount.** `world.fixtures`.
  Recounting from `ownedUpgrades` can't express "the player tore one out", and
  the old recount also double-counted freezers on every server restart.
- **Fixture ids live in two namespaces.** The generator mints `shelf-p0`,
  `till-p0`…; anything the player positioned keeps an `fx-N` id. They must never
  collide, or a re-flow hands a shelf someone else's stock.
- **Props live in `actorRoot`; the layout lives in `staticRoot`.** `buildWorld`
  rebuilds the second and must explicitly tear down the first. Clearing the
  `shelfProps`/`plotProps` maps without removing the meshes orphans every stack
  in the scene at the *old* shelf positions — which reads in-game as stock
  scattered across the floor, and leaks another full set on every re-flow.
  Positions are also re-read every sync, not just at creation, so a fixture you
  move takes its stock with it.
- **The build ghost and the server share one validator.** `shared/build.js`.
  Reimplementing the rules client-side to keep the preview snappy is how a
  green ghost starts promising placements the server then refuses.
- **The director's "already ran today" guard has to survive a restart.** It's
  carried through `onCacheRoom`. Without it, every time you save a file in
  `server/` the same day fires another world event, and the modifiers stack
  multiplicatively — six copies of one event nearly doubled profit in a
  measured run, silently.
