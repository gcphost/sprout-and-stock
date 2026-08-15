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
Four sweeps, about three seconds:

- `verify:layout` generates ~100k layouts across seeds × counts and asserts the
  generator placed *exactly* what it was asked for, that every fixture has a
  reachable working spot, that queues stay indoors, and that hand-placed
  fixtures land on the tile they were given.
- `verify:build` drives a real `Game` through tilling, stowing, stripping,
  building, moving and selling back, and asserts nothing is created or
  destroyed on the way.
- `verify:edges` walks the real edge rules from the shopper spawn and insists on
  reaching the shop floor, across generated layouts and hand-built rule cases. A
  sealed building fails that and passes everything else.
- `verify:catalog` authors a second design of a kind, a decoration and a lamp,
  then asserts pieces resolve to themselves and that placing a decoration moves
  no tile, no walk grid and no shelf. It cleans up after itself on exit, because
  it writes into whatever content database it is pointed at — usually the live
  shared one.

Each found real bugs the day it was written. None is visible in a screenshot of
one seed — which is exactly why they exist.

⚠️ **`simulate` also inherits who works for you.** `Game.create` reads the saved
world, so the roster and `ownedUpgrades` come along into the throwaway run. Hire
someone between two runs and the second one is measuring a different shop. Every
result now reports `startedWith` — check it matches before believing a delta.

⚠️ **`simulate` reads the live modifier table.** Two runs of the same seed are
only comparable if the world events are the same in both. A stack of duplicate
modifiers was worth 1.9× profit on one measured seed, which will swamp whatever
you were actually trying to measure. `clear_modifiers` before a before/after.

---

## Who owns what

Keep to your side and you'll almost never touch the same file.

| Area | Path | Notes |
|---|---|---|
| Content (items, crops, customers, events, upgrades, recipes, **fixture art + tiers**) | *the database* | Either person, any time, via MCP. No conflicts possible. |
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
            build.js      BUILD_KINDS + where a thing may go (client and server)
            pieces.js     which catalog row a placed thing is, and its ledger name
server/     db.js         SQLite, content tables, content_version trigger
            content.js    in-memory registry; reloads when content_version bumps
            layout.js     procedural store + farm, sized to what you own
            sim/          the simulation (economy, pathing, customers, crops)
            sim/simulate  headless balance runner used by the `simulate` tool
            director.js   AI world events (async, never blocks the sim)
            api.js        HTTP control API — everything MCP can do
            rooms/        Colyseus room; broadcasts plain JSON at 10Hz
client/     render/       three.js isometric renderer
            render/lights.js  honours `emits`, and caps how many lamps are real
mcp/        server.js     MCP tools, a thin wrapper over server/api.js
```

**State is plain JSON, not `@colyseus/schema`.** At this scale the bandwidth
difference is irrelevant and the readability win is large — you can
`console.log(__sns.state)` in the browser and see the entire world.

**Design docs live in `docs/`.** Read the relevant one before restructuring
anything it covers — each records why the current shape is the way it is, and
what the next step was meant to be.

| Doc | Covers | Status |
|---|---|---|
| [docs/building.md](docs/building.md) | walls on tile edges, enclosure instead of a store rect, and the kinds-vs-pieces catalog that makes lights and decorations authorable | steps 1–3, 6–8 built |
| [docs/workers.md](docs/workers.md) | workers as authored content, the roster, tier ladders, breaks and the props that make them visible | steps 1–6 and 8 built |
| [docs/customers.md](docs/customers.md) | patience as a budget every annoyance draws on, anger you can see, theft, and a shop that turns people away when it's full | steps 1–3 built |
| [docs/ui-shell.md](docs/ui-shell.md) | the HUD, the rail, panels | — |

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
- **A model can carry stages, and anything can drive them.** `shared/model.js`.
  A model is either `parts` (always looks the same) or `stages[]`, and whoever
  draws it passes one 0..1 number: a crop passes its growth, a fixture passes
  its tier, a pastime passes how far through the break they are. One authoring
  shape and one resolver, so the next kind of prop gets stages the day it exists
  rather than growing its own art-swapping code. The pastime is the proof: a mug
  that empties and a sandwich eaten down to the crusts cost one nullable column
  and one field in `snapshot()`, and no code in the renderer knows what a mug is.
- **Kinds are code; pieces are content.** A `fixtures` row is a *piece* — its
  own id, its own model, variants, tier ladder and price — and it names a *kind*
  from the closed `BUILD_KINDS` set in `shared/build.js`. So there can be four
  planters and two shelf designs, but not a new kind: where a thing may go,
  whether it blocks and which side you use it from are behaviour, and a fixture
  nobody can place or reach is scenery. Same shape `JOBS` uses for workers.
  A row written before the split has no `kind` and is read as naming itself
  (`kindOf`, `shared/pieces.js`) — a read-time default rather than a migration,
  so an old database, an old export and a fresh seed all agree with no ceremony.
- **A piece that resolves to its kind looks correct until somebody authors a
  second one.** Every fixture came from a row whose id *is* its kind, so a
  lookup that falls back to the kind is invisible in a shop that owns the
  original five — and then presents as "my new shelf looks like the old one",
  which reads as bad modelling rather than bad wiring. `verify:catalog` gives its
  test shelf a deliberately *shorter* tier ladder so the wrong row is a number
  that differs rather than a picture that happens to match.
- **A decoration weighs nothing, on purpose.** `prop-floor` and `prop-ceiling`
  stamp no tile, take no generator budget and reserve no working spot, so people
  walk past them and no shop that was walkable stops being so. That is why there
  is no authored `blocks` flag: a barrel that stops nobody is a lie you can see,
  and one that stops people needs to own its cell — which a tile cannot say
  alongside "floor". Anything that must be walked around is a shelf today.
- **The ledger keys fixtures by kind and props by piece.** `world.fixtures` is
  the *generator's shopping list* — `regenerateLayout` asks for one placement per
  shelf owned — so a second shelf design that counted under its own name would
  have no budget and get dropped on the next re-flow, silently, one at a time.
  Props have no budget because nothing procedural places one, which is what frees
  them to count by piece. `ledgerKey` in `shared/pieces.js`; the client imports
  the same function, or the palette would print 0 next to eleven shelves.
- **Eight lights, and the cap is not a tuning knob.** three.js forward-renders
  every light against every fragment, so lights multiply the cost of the scene
  rather than adding to it. `client/render/lights.js` keeps a fixed pool, aims it
  at the nearest emitters, and folds the rest into ambient so panning sharpens
  the near end of the shop instead of switching the far end off. Also: three's
  falloff makes `intensity` a power, not a brightness — a lamp authored as "1
  over 4 tiles" is invisible until it is scaled by range squared.
- **A tier that changes no number is a button that takes money and does nothing.**
  `capacity_mult`, `keeps_mult` and `speed_mult` are the only knobs the sim
  reads. The till ladder is deliberately priced at 0 because nothing reads a
  till's speed yet — see the `speed` upgrade kind for what happens when you
  forget (it sells, and `speedMult()` still hardcodes `boots-1`).
- **`canPlace` gives two kinds of no, and only one of them is a no.**
  `ok: false` is physics — the tile is taken, it is off the map, a plot is
  being dug indoors. `ok: true` with a `warn` is a *consequence*: you may wall a
  shelf in, seal your own doorway, or stand a till where nobody can queue, and
  the game tells you what it will cost instead of refusing. That is deliberate —
  blocking your own shop is a move, and the sim already copes (a shopper who
  can't path to a shelf writes it off and picks another, one who can't reach the
  door leaves, staff cool down and find another job). The one caller that must
  still refuse a warning is the layout generator, which is why
  `canPlaceCleanly` exists: a procedurally furnished shop nobody can walk
  through is a bug, not a choice. `verify-build` uses it for the same reason.
- **A variant is a look; a tier is a number.** Both are content on the same
  `fixtures` row, and the split is structural rather than a convention anyone
  has to remember: a variant carries only a `model`, while `tiers` is one
  ladder shared by every shape. So a corner shelf costs and holds exactly what
  a straight one does, restyling something already built is free and keeps its
  stock, and no shape anybody draws can move the balance or need `simulate`
  re-run. If a new shape *should* change what a fixture does — an island unit
  browsed from both sides, say — that is an anchor, which is behaviour, and it
  belongs in `shared/build.js` rather than in a variant.
- **Where goods sit is authored, not assumed.** A model part flagged
  `surface: true` is a shelf row, and stock is drawn on those boards, top row
  first, running along whichever horizontal axis the board is longer on. The
  axis is read rather than fixed because a corner unit's second wing runs the
  other way — assuming width is always z filed its stock into the wall. A model
  with no surfaces piles goods on its roof, which is what a chest freezer and a
  counter want. A part can also carry `alpha` for glass, which casts no shadow,
  and `drift`, which makes it leave whoever is holding it — rising, spreading
  and fading on a loop, for vapour and steam. Each is a flag one renderer knows
  how to read, and the pattern is deliberate: a new kind of behaviour on a part
  beats a second kind of model every time.
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
- **The director's "already ran today" guard has to survive a *cold* restart,
  not just a hot one.** It lives on the save as `lastDirectorDay`, claimed
  synchronously at the top of `runDirector` — before the API-key check, because
  the no-key fallback still writes an event and a guard set after that check
  never fires for anyone without a key. It used to be a room field carried
  through `onCacheRoom`, which survives a devMode reload and nothing else: every
  cold start fired another world event onto the same day, and a day of active
  editing left six copies of one heat wave in the table. Cheap to miss, because
  the sim looks fine — `foldModifiers` collapses same-event rows to their
  strongest pull, so the *balance* never moved. All you see is a HUD wearing
  twenty-six chips, which reads as a mad world rather than as a bug.
- **One seed is not a measurement.** `clear_modifiers` is necessary and not
  sufficient. The bot picks crops by weighted random draw, so a change that
  calls that draw a different number of times shifts the whole RNG stream and
  the two runs diverge for reasons that have nothing to do with what you
  changed. Auto-replant measured −14% on one seed and **+7.8% averaged over
  ten** — 6/10 seeds went the other way, and one swung 900% because the
  baseline nearly went broke. Average across seeds before believing anything,
  and be suspicious of a single number either way.
- **…and in a shared world, `clear_modifiers` + one seed is not even a
  *control*.** `simulate` builds its throwaway game from the **saved** world, so
  every restart picks up whatever the other person has done since. Appending a
  comment to `staff.js` — a no-op restart, no behaviour change of any kind —
  measured 41,523 / 43,464 / 41,566 against 42,873 / 41,927 / 41,433 on three
  seeds: up on one, down on two, and `startedWith` identical on all six runs. A
  change you are actually testing will hide inside that. The fix is to take the
  world out of it: `DB_PATH` honours **`SNS_DB`**, so copy `data/game.db` once
  and drive `simulate` in-process against the copy. No server, no restart, no
  other player, and both halves run against one frozen world — which is how a
  rendering change can honestly claim "identical to the cent".
- **A convenience that spends money needs to spend it on what you asked for.**
  Harvest replants the bed with the seed you have *selected*, not the crop it
  just picked. Those look equivalent and aren't: replanting the old crop
  charges for a seed you were about to replace, so every switch buys two. It
  cost a third of all profit and no playthrough would ever show you why.
- **Whatever you change, check the balance bot still models a player doing it.**
  Auto-replant meant plots were never empty, and `simulate` skipped any planted
  plot — so every bed froze on its first crop and three crops reported as
  `deadStock` with perfect tags. The tool said the feature was −39%; the tool
  was wrong. A broken instrument reads as a broken feature.
