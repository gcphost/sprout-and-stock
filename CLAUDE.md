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
Ten sweeps, about ten seconds:

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
- `verify:shell` stamps a shop, builds in it and sells out of it, and asserts
  that nothing else moved. That claim is a negative and invisible by eye — you
  would have to notice a shelf you weren't looking at is one tile over.
- `verify:floor` guards the claim the floor layer rests on: that a floor is a
  *look* and never a permission. Two floors of different colours and different
  prices must leave byte-identical `tiles`, `blocked` and `indoor`, or what a
  shop is made of has become a rendering decision. It also asserts the bug
  floors exist to fix, end to end — wall an annex, fail to put a shelf in it,
  floor it, succeed — and that paint survives three re-flows and a purchase,
  because an overlay that didn't would mean buying a shelf repaints the shop.
- `verify:yard` guards the delivery bay and the drop-off, which stopped being
  generated furniture and became ground you paint. Four claims, none of them
  visible in a screenshot because a seeded pad and a generated one look
  identical on day one: the yard is stamped ONCE (a boolean on the save, not
  "does this shop own any pads" — otherwise deleting your bay hands it back on
  the next load), a save that predates it gets a yard *and does not move*, how
  big you paint a pad is how many crates it holds, and a pad indoors is walkable
  but never buildable. It authors its own ground rows and removes them on exit.
- `verify:break` guards the break area — the third pad, and the first that holds
  people rather than goods. Its claims are invisible in a screenshot and mostly
  invisible in play, which is why they are here: that a shop with **no** break
  area still takes breaks at the spot the pastime authored (the fallback is the
  whole promise, and the override sits in the same function it falls back to),
  that one cell seats one person so the fifth hire rests elsewhere rather than
  queueing, that a room nobody can reach is not a room — otherwise walling one
  off pins every hire at `TIRED_PACE` forever — and that a break taken in it
  restores more than the same break taken leaning on a shelf, or the room is
  ground you pay for that only costs you the walk. It authors its own ground,
  pastime and worker rows and removes them on exit.
- `verify:economy` guards what a fixture costs and how many of them there are:
  that the price comes off the catalog row and not off an upgrade payload, that
  a build-and-sell round trip always loses money rather than printing it, that a
  discount moves its own kind and nothing else, and that the count is a recount
  of the shop rather than a number kept beside it. Every expected figure is
  arithmetic on a deliberately odd authored price, never on `fixtureUnitCost` —
  asserting a charge against the function that computes it passes whatever that
  function does. It authors rows into the live content database and removes them
  on exit, the same way `verify:catalog` does.

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
| What a palette button shows | `client/thumb.js` | Draws a fixture, a floor or a wall from its own art, as inline SVG. Reads `palette.js` — never its own colours. |
| Rendering internals | `client/render/scene.js` | |
| Economy and balance | `server/sim/economy.js` | Re-run `simulate` after every change. |
| Customer behaviour, crops, actions | `server/sim/index.js` | The biggest file. Coordinate before restructuring. |
| Layout generation | `server/layout.js` | Re-run `npm run verify` after every change. |
| Build placement rules | `shared/build.js` | Imported by **both** client and server on purpose — see below. Also owns `GROUND` — the brush that paints floor, the delivery bay and the storage pad, none of which is a fixture. |
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
| [docs/building.md](docs/building.md) | walls on tile edges, enclosure instead of a store rect, the kinds-vs-pieces catalog that makes lights and decorations authorable, prices that live on the catalog, and the ground brush that paints floor, the two yard pads and the break area alike | steps 1–9, 11, 13–14 built; 10 cancelled; 12 next |
| [docs/workers.md](docs/workers.md) | workers as authored content, the roster, tier ladders, breaks, the props that make them visible, and the break area they are taken in | steps 1–6, 8 and 9 built |
| [docs/customers.md](docs/customers.md) | patience as a budget every annoyance draws on, anger you can see, theft, and a shop that turns people away when it's full | steps 1–3 built |
| [docs/ui-shell.md](docs/ui-shell.md) | the HUD, the rail, panels | — |
| [docs/fixtures.md](docs/fixtures.md) | every piece in the build catalog — kind rules, price, tier ladder, how many boards of goods it really draws, and any tier that takes money and moves no number | **generated**, `npm run docs:fixtures` |

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
- **Proximity arms an action and the ring fires it.** Standing near something
  is not consent — the version before that harvested crops at you as you walked
  past — but a button in between turned out not to be the answer either.
  `actionFor` decides *what*, the charge decides *when*: an action takes a
  second, the target lights up, and leaving the range throws the charge away, so
  you say no by not standing there. The snapshot carries the armed action from
  the tick it arms, at zero progress, so the client can light the target up and
  name what is about to happen.
- **Picking things up is the exception, and it names its target.** Nothing is
  ever put in your hands for standing near it. A crate is tapped
  (`Scene.pickPallet`), a shelf board has a Take button in its own menu, and
  both send `take`, which sets `p.errand` and walks you there — `errandAction`
  arms the ordinary ring when you arrive. Proximity could only ever offer the
  *nearest* pallet, which at a bay stacked three deep is not a choice anybody
  made, and a pickup you did not choose is worse than a missed one because it
  fills your hands and then everything else refuses you.
- **Held actions still re-arm the instant they finish, and naming one does not
  save you.** Fine for stocking and harvesting. Not fine for anything
  destructive or reversible-in-place: a Clear tool that stayed armed ate seven
  shelves in a row, and putting goods down beside a crate of the same thing
  picked them straight back up forever. Making pickup explicit looked like it
  retired that latch (`stowLock`) — the ping-pong needs both halves arming on
  their own, and now one is a button. It didn't. **The pair just changed
  partners**: a pickup leaves you holding something *stood at the thing it came
  off*, which is exactly what `stock` arms on, so a board emptied by hand
  refilled itself on the next tick. `p.tookFrom` is the latch now — set on a
  pickup, cleared in `stepPlayers` once you are out of reach of the source, and
  it holds off stocking that one unit and stowing anywhere. What matters is not
  whether an action is explicit but **the state it leaves you in.**
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
- **A floor is a look, and it is what makes a walled room a shop.** Enclosure
  has meant "whatever the walls close in" since step 3 of docs/building.md — so
  you could always draw an annex and it counted as indoors, and it then refused
  every shelf, because the ground was grass and `BUILDABLE_INDOOR` is floor.
  Worse, the refusal read "something is already there", so the missing half
  presented as a bug in the wrong place. The Floor brush is that half: drag out
  an area, priced per cell the way a wall is priced per edge. Two rules keep it
  cheap. It is **not a tile kind** — `tiles` still only ever holds `GRASS` or
  `FLOOR`, and which design a cell wears rides in `layout.floors`, so nothing
  that reads the ground changed and no material can ever move a tile. And it is
  **not in `FIXTURES`** — a floor has no anchor, blocks nobody and is painted
  rather than placed, so `BUILD_KINDS` partitions in three now, which
  `verify:catalog` counts rather than trusting anyone to remember.
- **The yard is ground you paint, and the mark that it was seeded is a boolean
  rather than a count.** The delivery bay and the drop-off used to be stamped by
  `compose` against the corners of the back wall on every re-flow, which is
  exactly why they could never be moved: buying a shelf put them back. They are
  designs for the floor brush now — one overlay (`layout.ground`, formerly
  `floors`), where the KIND of the piece you painted decides the tile. Two traps
  came out of it. `freezeYard`'s mark has to be its own field, because "does
  this shop own any pads" hands your bay back on the next load the moment you
  paint over the last one — which makes the yard the one thing in the shop you
  may not get rid of. And **the seed may only lay ground the player could lay**:
  the old 2×2 sat half on row 0, the world's border ring, which every build tool
  refuses — a pad you can delete three quarters of is worse than one you cannot
  delete at all, because it looks like it worked.
- **The shop is centred east–west and was never centred north–south.** `storeZ`
  was hardcoded at 2, so there were two rows behind the building and the border
  ring ate one of them. It lives on the stored shell as `shell.z` now: a save
  without one reads 2 and does not move — every fixture in it is a placement at
  an absolute tile, so pushing the building south would drop the entire contents
  of the building outside it and refund them — and a new world starts at 5.
  Anything that changes where the building *sits* has to be opt-in per shop for
  the same reason.
- **A refusal has to come before the money moves, not after the decision.**
  `buyStock` deducted cash, then checked there was a bay to deliver onto — so an
  order with nowhere to land was refused *and* charged for. It read as correct
  in isolation, because the check itself was right and sat next to the code it
  guarded. `verify:yard` caught it on the assertion that nothing was charged, not
  on the one that the order was refused. Put a new guard with the other guards.
- **A fixture can earn now, and its clock must not be saved.** `yields` on a
  piece pays into `dropCash`'s pile — the till's entity, renderer and pickup
  path, never a second kind of money on the floor. The trap is the timer: stamps
  are against `elapsed`, which **restarts at zero on every load**, so a saved
  stamp puts the last payout in the future and the thing never pays again.
  `persist` already learned this about `plantedAt` and stores crops as how long
  they *have* grown. `yieldedAt` is in-memory with a `last > elapsed` guard.
- **A pad is a job, and the third one holds people.** The break area
  (`GROUND.break` → `T.BREAK` → `L.break`) is painted with the same brush the bay
  is, and *one cell seats one person* — the yard's "how big you paint it is how
  much it holds", said about staff. Three things about it are not obvious. It is
  the one pad **nothing seeds**, because a shop with no bay is broken and a shop
  with no break room is every shop that exists today. It **outranks the pastime's
  own `spot`** rather than joining `PASTIME_SPOTS`, because a room half your
  hires ignore reads as broken — so `spot` is now the fallback. And the fallback
  has to survive a room nobody can *reach*: the seat search asks `findPath`, or
  walling off your break room pins every hire at `TIRED_PACE` forever, which is
  strictly worse than never having painted one. Measured at +47 mean profit over
  12 seeds beside the door and +12 in the far corner — where you put it is most
  of what it is worth, and that falls out of the walk rather than out of a rule.
- **`charm` feeds catchment, and the ceiling is the point.** Reputation is what
  the people who already came in think of you and the shop can max it out;
  catchment is how much of the town is in reach at all, which is the term
  shopkeeping could never move. Charm is content-authored and unbounded, so the
  curve saturates at `CHARM_MAX` — otherwise the cheapest strategy in the game
  is a room full of pot plants. It is also the first thing that has ever read
  the `decor` upgrade kind, which sat in the schema dead since it was written.
- **A tile is ground. What is standing on it is `layout.blocked`.** They were
  one array until step 5 of docs/building.md, which is why there was nowhere to
  put a rug — a rug is not a floor material and not an occupant, and one value
  has no third answer. `FIXTURES` says `blocks` as a field now, and a plot says
  `ground: T.PLOT` because a bed doesn't stand on the floor, it *is* the floor.
  The enum numbers in `shared/tiles.js` have gaps where `SHELF`, `FREEZER`,
  `CHECKOUT` and `STATION` were, and closing them would turn every live shop's
  floor into grass — a save holds `tiles` as raw numbers.
- **A shop is stamped once and then stays put.** `Game.freezeShell` turns the
  generated shop into placements the first time a world opens, and the size of
  the building becomes `world.shell`. After that the generator only re-applies
  what is there, so buying a shelf can't shuffle your aisles and
  `droppedPlacements` can't fire on a purchase. The shell has to be *stored*:
  with every fixture a placement the budgets are zero, so a size search would
  find that a 9×9 holds everything asked of it and shrink the building back,
  stranding every placement outside. Which also means **`fresh()` in the verify
  scripts has to clear `g.shell`**, or the sweep asks a 10×9 shop to hold a
  10×11 shop's shelving and gets a layout with no shelves in it. It also has to
  say what to furnish *with*: `regenerateLayout(null, {}, { want })`, since the
  ledger it used to pin (`g.fixtures = {...SHOP}`) is gone.
- **The `fresh()` trap has a second form: state that isn't new, but newly
  matters.** Every sweep resets what `Game.create` reads off the save, and the
  list grew by `edits`, then `shell`. `ownedUpgrades` never needed resetting
  because owning one couldn't change what anything *cost* — since step 9 it can,
  so `verify:economy` clears it, and a run that didn't would measure a
  discounted shelf against an undiscounted literal and call it a pricing bug.
  Ask what a save could now leak into your assertions, not just what fields you
  added.
- **A decoration weighs nothing, on purpose.** `prop-floor` and `prop-ceiling`
  stamp no tile, take no generator budget and reserve no working spot, so people
  walk past them and no shop that was walkable stops being so. That is why there
  is no authored `blocks` flag: a barrel that stops nobody is a lie you can see,
  and one that stops people needs to own its cell — which a tile cannot say
  alongside "floor". Anything that must be walked around is a shelf today.
- **What the shop owns is the shop, not a number beside it.** `world.fixtures`
  was a stored count per kind, and it had to be while the generator furnished the
  place itself: "six shelves" was a number nothing in the world could be read
  back from. Step 4 made every fixture a placement and step 9 retired the ledger,
  so the count is `Game.fixtureCounts()` — a recount — and it cannot double-count
  a freezer on a restart or forget one you tore out, both of which the ledger
  managed. `countKey` in `shared/pieces.js` is the one spelling of the key, and
  the client imports it, or the palette would print 0 next to eleven shelves.
  Its predecessor `ledgerKey` had to spell a fixture by KIND and a prop by PIECE
  — the budget needed it — and that asymmetry retired with the budget.
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
- **…and the generator has to honour a warning it did not issue.** `compose`
  re-judged *player* placements with `canPlaceCleanly`, so anything you were
  warned about was accepted by `placeFixture`, charged for, and then dropped on
  the re-flow that same call triggers. The refund came back in full, which is
  why it never read as an error — what you lost was the fixture and its stock,
  and what you saw was a shelf vanishing as you turned it. Rotation was the
  worst of it: `rotateFixture` deliberately settles for a warned facing when all
  three are warned, so a unit in a corner had no angle that could survive. The
  rule is that `canPlaceCleanly` belongs to callers building *unattended* — the
  generator furnishing its own loops, the balance bot — and never to a fixture
  somebody positioned by hand after being told what it would cost.
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
- **A picture of a thing has to come from the thing.** The palette draws every
  entry from its own catalog row now (`client/thumb.js`) — which is the only way
  to tell five floors apart, since a floor *is* a look and the buttons were five
  names in one grey glyph. The trap is the half with no row: a wall is built by
  the renderer, so its button was hand-drawn to match, and the hand-drawn
  version was wrong twice over — a blue pane where the game glazes with the
  wall's own colour at a third opacity, posts and rails where the game builds a
  low solid slab. Neither would ever have been caught, because nobody holds a
  38px button up against a wall across the room. The shape lives in `edgeBands`
  in `palette.js` now and both callers ask for it. Anything that draws a second
  picture of something the game already draws has to derive it, not match it.
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
- **A fixture is priced by its catalog row, and only an appliance isn't.**
  `fixtureUnitCost` used to reverse-engineer a price by scanning upgrade payloads
  for whichever row sold that kind and dividing. That works only while every kind
  has such a row, which a planter never will. `cost` on the piece is the price
  now; `FALLBACK_FIXTURE_COST` is a *floor* for a kind nobody has drawn, not a
  second price list; and a prop authored at 0 is genuinely free, because a
  decoration is only ever its row. An appliance is still priced by its upgrade —
  that upgrade sells one machine, so it was never a division — and moving it onto
  the catalog is step 12 of docs/building.md.
- **A fixture upgrade grants nothing you can stand on.** `shelf-2`, `plot-3`,
  `checkout-2` and friends sell a *discount* on every one of that kind you build
  from then on. Best-of, never stacked, capped at `MAX_FIXTURE_DISCOUNT` — two
  multiplied discounts spiral toward free and the ladder is already ordered.
  `space` is the last upgrade that grants a thing, and the thing is land, which
  is why `buyUpgrade` re-flows the layout for `space` and nothing else.
- **Cheapest-first only works if you keep going when it fails.** The balance bot
  took the head of its spend queue on faith, and `buyUpgrade` refuses a whole
  class of row — so one refusal wedged it permanently: it bought a rucksack on
  day two and then nothing, ever, for the remaining fifty-eight days. Every
  balance number measured a shop that never hired and never grew, and nothing in
  the output said so. It walks the queue until something works now, and the
  numbers moved a lot when it did.
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
- **`world()` handed out DEFAULT_WORLD's own arrays.** The loader spread
  `{ ...DEFAULT_WORLD, ...saved }`, which is shallow — so a world with *no*
  save (an ephemeral balance run, a verify sweep, a slot nobody has opened)
  got the module-level `ownedUpgrades` array itself, and `buyUpgrade` pushes
  onto it. One `simulate` call left the default owning twelve upgrades for the
  rest of the process: the next run started rich, the next richer, and ten
  seeds "averaged" a shop that grew between every seed. Nothing in the output
  says so except `startedWith`, which is the only reason it was ever caught —
  check it, it is there for this. `structuredClone` now, and the same trap is
  waiting for any mutable field added to `DEFAULT_WORLD`.
- **Copying `data/game.db` with `cp` silently copies a stale shop.** SQLite is
  in WAL mode, so recent writes live in `game.db-wal` until a checkpoint. `cp`
  of the `.db` alone loses them, and the worlds you were about to measure may
  simply not be in the copy — at which point `world()` falls through to the
  starter shop and you spend an hour comparing two default worlds while
  believing you are measuring somebody's real one. `VACUUM INTO` a consistent
  copy instead.
- **A layout re-flow used to restart shoppers who had already paid.** Every
  customer was reset to `BROWSE`, including ones in `LEAVE` walking out with an
  emptied basket — so they turned round, found they wanted nothing, and were
  booked as having left empty-handed at −0.015 reputation each. A player who is
  *building* re-flows constantly, so reputation floored, `pull` floored with it,
  and the shop stopped getting customers as a direct consequence of having
  served some. `LEAVE` now survives a re-flow. Anything that resets customers
  wholesale needs to ask which of them were already finished.
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
