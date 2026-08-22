# Building — design

Status: **steps 1–9, 11, 13–19 built. 10 is cancelled. 12 is what step 9
left.**
There is also a working interactive mockup —
[turn the shop around here](https://claude.ai/code/artifact/1aac9d71-46fc-4e78-9f93-d54a6e6d2467).

What that means in practice: walls, windows, doorways and fences live on the
edges between cells and everything reads them; "indoors" means whatever the
walls enclose; you draw a run with a wall tool and paint a floor with a brush,
which together are how the shop gets bigger; the catalog is split into
kinds-in-code and pieces-in-content, so a second shelf design, a planter, a
hanging lamp or a floor is an MCP call; a tile means ground and nothing else;
and a shop is stamped once and then stays where you put it.

Each section below says what landed and where it stopped. Read the build order
at the bottom for the running tally.

The goal: the shop stops being a rectangle the generator solves for and becomes
whatever you build. Walls, windows and doors are things you place. Lights and
decorations are authored content, so a new planter or a brass sconce is one MCP
call and no code change.

---

## What's wrong today

> **This section is history.** Every complaint below has since been fixed, and
> it is kept because it is the argument for why the shape above is the shape it
> is — a design doc whose problem statement has been deleted reads as a list of
> arbitrary preferences. Where a fix landed, the build order at the bottom says
> so. The one that has *not* landed is the last paragraph of "there is nowhere
> to put a light": a wall sconce still has nowhere to mount.

### The building is an output of your shopping list

`generateLayout` in [`server/layout.js`](../server/layout.js) takes counts —
`shelves`, `freezers`, `checkouts`, `plots`, `stations` — and searches for the
smallest rectangle that holds them. `space` upgrades don't let you build
anything; they add to `grow.w/h`, which makes that rectangle bigger.

```js
store = { x, z, w, h }                      // one rect, wall ring round the edge
door  = centre + seed jitter + doorShift    // 2 tiles, always the south wall
bay, spawn, path, fence                     // all derived from door / plot bbox
```

Build mode sits on top as an *overlay*: what you position lands in
`world.placements`, and the generator re-runs from scratch on every placement,
flowing procedural fixtures around yours. It works, but the shop can re-flow
under you, and `droppedPlacements` exists to apologise when it does.

The good news is how shallow the rectangle goes. Outside layout.js and the
verify scripts, `store` is read in exactly one place that matters:

```js
// insideStore, in shared/build.js
export function insideStore(L, x, z) {
  const s = L.store;
  return x > s.x && x < s.x + s.w - 1 && z > s.z && z < s.z + s.h - 1;
}
```

That one function decides indoor-vs-outdoor buildability, whether a queue run is
valid, and whether your standing spot is inside. Everything else — pathing,
customers, staff, stock — reads `tiles`, `door` and `bay` and never the rect.

### One array does two jobs

`tiles` is a `Uint8Array` of tile kinds, and it means both *what the floor is
made of* (`GRASS`, `FLOOR`, `PATH`, `BAY`) and *what is standing on it*
(`SHELF`, `FREEZER`, `CHECKOUT`, `STATION`, `WALL`). One cell, one value, so two
things can never share a tile.

That is the whole reason there is nowhere to put a rug: a rug is not a floor
*material* and it is not an *occupant*, and the array has no third answer.

The stamp is already half-vestigial, incidentally. Fixtures also live in
`layout.shelves` / `.checkouts` / `.stations` / `.plots` as records, and the
renderer keeps `MODEL_REPLACES_TILE` precisely so a fixture with an authored
model doesn't draw its tile block underneath itself.

*(Fixed in step 5. `MODEL_REPLACES_TILE` was the tell, and it retired with the
stamp — along with `removedTiles`, `baseTile` and `withTile`, all of which
existed only to answer "what would this tile be if the thing on it weren't".)*

### `blocks` is already a real axis, just not one you can say

`WALKABLE` in [`shared/tiles.js`](../shared/tiles.js) includes `T.PLOT`. So a
farm plot is a fixture you can walk over, while a shelf is not — the game
already has two behaviours here. It just expresses them by which set a tile enum
member happens to be in, which is not something content can reach.

### There is nowhere to put a light

A wall sconce mounts on a wall *surface*. Wall is a tile, and a tile has no
sides you can name. A pendant hangs from a ceiling that doesn't exist as data.

---

## The shape

Three layers instead of one. Keeping them apart is the whole design.

| Layer | Where it lives | Holds | How many per slot |
|---|---|---|---|
| **Ground** | `tiles` — `Uint8Array(w*h)` | what the floor is made of: grass, floor, path, bay | exactly one per cell |
| **Edges** | `edgesV`, `edgesH` | walls, windows, doors, gates, fences | at most one per edge |
| **Things** | `things[]` — a list | everything that stands, hangs or mounts | any number per cell, one *blocking* |

`T.WALL`, `T.DOOR` and `T.FENCE` leave the tile enum; tiles go back to meaning
ground only. `T.SHELF`, `T.FREEZER`, `T.CHECKOUT`, `T.STATION` leave too — a
fixture is a thing in the list, not a stamp. That is a net **simplification** of
[`shared/tiles.js`](../shared/tiles.js), not just a move.

```js
tiles:  Uint8Array(w * h)          // GRASS FLOOR PATH BAY PLOT
edgesV: Uint8Array((w + 1) * h)    // z*(w+1) + x  → west face of cell (x,z)
edgesH: Uint8Array(w * (h + 1))    // z*w + x      → north face of cell (x,z)

// NONE · WALL · WINDOW · DOOR · GATE · FENCE
```

Walls sit **on the edges between cells**, not filling a cell. A 3×3 walled room
keeps all nine floor tiles, and `MIN_STORE 11×11` becomes 11×11 of *usable*
floor rather than 9×9 with a ring around it.

### Enclosure replaces the store rect

After tiles and edges are final, flood-fill inward from the map border, stopped
by solid edges. Whatever the fill can't reach is enclosed.

```js
insideStore(L, x, z)   →   L.indoor[z * L.w + x] === 1
```

L-shaped shops, annexes, barns and free-standing greenhouses all fall out of
that one change, none of them special-cased. "Indoor" stops meaning *the
building* and starts meaning *anything the walls close in*.

Two rules that are not obvious and are both load-bearing:

- **A doorway counts as boundary.** `WALL`, `WINDOW` and `DOOR` all stop the
  fill. Leave `DOOR` out and the fill walks straight in through the front door
  and the whole shop reads as outdoors. (This is a bug the mockup actually had.)
- **A fence does not.** Fences never enclose, so a fenced field stays outdoors
  and you can't accidentally roof your farm by tidying it.

The nice consequence: floor with no walls round it is a patio, and a shelf needs
an enclosed cell. Roofing your shop becomes a real decision that enforces
itself, with no new rule to write.

### Warn, don't refuse

`canPlace` now answers `{ ok: true, warn }` for the soft cases — it faces out of
the shop, no room for a queue, this cuts something off — and only hard-refuses
what is genuinely impossible. `canPlaceCleanly` is the strict variant, for the
one caller that can't accept a warning on your behalf: the generator, furnishing
a shop nobody has looked at yet.

That split is load-bearing for everything below. A builder whose job is to let
you make a strange shop cannot also be the thing that refuses strange shops —
you should be told a back room has no way in, not prevented from drawing it.
Every rule this doc adds should pick a side deliberately: **impossible refuses,
inadvisable warns.** For the record, walls and enclosure are almost all *warn*.
The only hard refusals worth keeping are off-the-map and something-already-here.

---

## The catalog

**Built**, with two deliberate omissions recorded at the end of this section.

This is the part that lets you add lights and decorations without a deploy, and
the pattern is one this repo has already used once.

[`docs/workers.md`](./workers.md) had the same problem: hiring was content but
the worker was code, so `staff-butcher` could be authored, bought, paid for, and
nobody turned up. It was fixed by making **`JOBS` a closed vocabulary in code**
and letting **unlimited worker content name into it**.

Do exactly that for fixtures.

### Kinds are code. Pieces are content.

Today `fixtures.id` *is* the kind — it must be one of `shelf`, `freezer`,
`checkout`, `station`, `plot`, because [`shared/build.js`](../shared/build.js)
has to know where a thing may go. That is correct and should stay correct. It
also means you get five catalog entries, forever.

Split them:

- A **kind** is a behaviour class — where it hosts, whether it blocks, whether
  it rotates, which side you use it from. Closed set, in `shared/build.js`,
  about a dozen entries.
- A **piece** is a catalog entry — "Terracotta Planter", "Brass Sconce",
  "Hanging Bulb". Free-form id, names its kind, carries its own model, variants
  and tier ladder. Unlimited, in the database, via MCP.

The five existing rows migrate by setting `kind = id`.

### The kinds

| Kind | Hosts on | Blocks | Rotates | You use it from | For |
|---|---|---|---|---|---|
| `wall` | edge | yes | — | — | encloses |
| `window` | edge | yes | — | — | encloses, see-through |
| `door` | edge | no | — | — | encloses, passable |
| `gate` | edge | no | — | — | fence opening |
| `fence` | edge | yes | — | — | boundary that never encloses |
| `shelf` | tile | yes | yes | `browseAt` | stock |
| `freezer` | tile | yes | yes | `browseAt` | cold stock |
| `checkout` | tile | yes | yes | `serveAt` | money |
| `station` | tile | yes | yes | `useAt` | crafting |
| `plot` | tile | no | no | — | crops |
| `prop-floor` | tile | no | yes | — | planters, barrels, bins, rugs |
| `prop-wall` | edge | no | — | — | signs, posters, wall shelves, clocks |
| `prop-ceiling` | overhead | no | — | — | pendants, fans, hanging signs, bunting |

A light is not its own kind — it's a piece of `prop-floor`, `prop-wall` or
`prop-ceiling` that carries an `emits` block. A floor lamp and a barrel obey the
same placement rules; one of them just glows.

### Two things this table promised and the build did not

Both are omissions rather than oversights, and both are cheap to add once the
step they depend on lands.

**`blocks` is not authored, and props never block.** This table originally had
`prop-floor` deciding for itself, because a barrel and a rug want opposite
answers. But a thing that blocks has to *own* its cell, and a cell can only say
one thing at a time — which is exactly the problem step 5 exists to fix. Shipping
the flag before then would mean a barrel people walk straight through, which is a
lie you can see from across the shop and worse than not having barrels. So
`BUILD_KINDS` says props are weightless, `verify-catalog` asserts the walk grid
is untouched when one is placed, and this becomes an authored field the day a
cell can hold a list. Anything that must be walked around is a shelf today.

**`prop-wall` does not exist yet.** The other two hang off a cell, which means
they aim with `pickTile`, store as an ordinary placement and rotate like anything
else — one code path, already tested. A wall prop hangs off an *edge*, so it
needs a placement carrying an orientation, its own aiming (`pickEdge` gives the
line, but the wall tools drag a run and a sconce does not), a rule that the edge
it mounts on is solid, and an answer for what happens to it when that wall is
knocked through. That is a genuinely different set of questions and it belongs in
its own change. `BUILD_KINDS` deliberately omits it rather than listing a kind
nothing can place — which is the scenery failure this whole split exists to
prevent, arriving through the vocabulary instead of through content.

### What a piece looks like

```js
export const PieceSchema = z.object({
  id:   slug,                    // 'terracotta-planter' — yours to choose
  kind: z.enum(BUILD_KINDS),     // from shared/build.js — the closed set above
  name: z.string().min(1).max(48),

  model:    ModelSchema,         // staged by tier, exactly as today
  variants: [...],               // looks only, exactly as today
  tiers:    [...],               // costs and multipliers, exactly as today

  /**
   * What it costs to put one down. 0 means "priced by the upgrade that sells
   * this kind", which is how every fixture is still priced — so the split cost
   * nothing and moved no balance. A prop has no upgrade behind it, so a prop
   * left at 0 is free.
   */
  cost: z.number().min(0).default(0),

  /** A light. Renderer-only unless something chooses to read it. */
  emits: z.object({
    color:     hexColor.default('#ffd9a0'),
    intensity: z.number().min(0).max(4).default(1),
    range:     z.number().min(0.5).max(12).default(4),
  }).optional(),

  /** Feeds the tag system, if a decoration should do more than look nice. */
  tags: z.array(slug).max(12).default([]),
});
```

`model`, `variants` and `tiers` are unchanged from
[`shared/schemas.js`](../shared/schemas.js). The tier/variant contract holds as
written: **tiers cost money and change numbers, variants are taste.** A brass
sconce and an iron one are variants of one piece; a brighter sconce is a tier.

### A piece that is doing something

**Built**, and the smallest change in here that fixes a real complaint: an
appliance mid-batch and one nobody has loaded since Tuesday drew the same
picture. The only thing that said otherwise was the row of ingredient ghosts
above it *going away* — an absence, in a shop full of things.

Two fields, and the interesting part is why it is two.

```js
  /** What it looks like while it is WORKING. Stages driven by the batch, not the tier. */
  work: ModelSchema.nullable().default(null),   // ...and the same on each variant

  // ...on a PART, inside either model:
  motion: z.object({
    kind:   z.enum(['spin', 'bob', 'shake', 'pulse']),
    hz:     z.number().min(0.05).max(12).default(1.5),
    amount: z.number().min(0).max(1).default(0.05),
  }).nullable().default(null),
```

`work` is a **second model** because one resolver takes one number and there are
two quantities. `model`'s 0..1 is the tier ladder — a Commercial machine is
stage 2 of its own art — and how far through a batch it is runs 0..1 on a clock
of its own. So dough → risen → browned is three stages of `work`, and it has
nothing to do with which rung you are on. It rides in the machine's own model
space, so a puff authored at the spout comes out of the spout; a part in there
flagged `drift` is steam, which is the loop the pastime prop already had.

It sits on the variant as well as the piece for the reason `model` does: every
appliance in the game is a variant of one `station` piece, so without it six of
the seven machines steam out of the same corner. The fallback is the piece's
own, which is what lets one generic "a light and some steam" cover whatever
nobody has drawn yet.

`motion` is a **flag on a part**, the same shape as `surface`, `drift` and
`alpha` — one renderer knows how to read it, and there is no second kind of
model. It runs while the thing it belongs to is *working*, and a thing that has
no idea what working means always runs. That second half is deliberate: only a
`station` can be busy today, so without it the field would silently do nothing
on every other kind, which is the "tier that changes no number" trap wearing a
different hat. It is also what makes a ceiling fan an authoring job rather than
a code one.

None of it moves a number, nothing in the sim reads either field, and a piece
with neither draws exactly as it did — which is why no balance run was needed
for any of it.

### Lights

**Built.** `emits` is content; honouring it is code, in `client/render/lights.js`
— its own file rather than a few lines in `buildWorld`, because the cap is the
whole substance of it.

Both of the things this section warned about were real:

- **You cannot have fifty point lights.** three.js forward-renders every light
  against every fragment, so lights multiply the cost of the whole scene rather
  than adding to it. The cap is `MAX_LIGHTS`, and it is eight. Emitters are
  rebuilt with the layout, the pool of actual `THREE.PointLight` objects is built
  once and re-aimed, and re-sorting only happens once the camera has genuinely
  moved — `RESORT_DISTANCE`. Everything past the cap folds into one ambient lift
  (`SPILL_PER_LIGHT`) so panning sharpens the near end of the shop instead of
  visibly switching the far end off.
- **A light that changes no number is decoration with extra steps.** Still true,
  and still deliberate: nothing in the sim reads `emits`. What it does do is dim
  with the day (`DAY_FLOOR`), so a lamp is worth most at dusk. That is the cheap
  half of "indoors is not outdoors" below — the lamp dims and the room does not.
  If lighting is ever meant to *matter*, the hook is the tag system, not
  `if (piece.id === 'lamp')`.

One thing worth knowing that wasn't obvious: three's falloff makes `intensity` a
power rather than a brightness, so a lamp authored as "1 over 4 tiles" is nearly
invisible unless it is scaled by its own range squared. That scaling lives in
`Lights.update`, so an author writes the number they mean.

### Indoors is not outdoors

There is already a sun. `scene.js` lerps `SUN_HIGH`→`SUN_DUSK` and
`FILL_HIGH`→`FILL_DUSK` across the day, so the world visibly opens and closes.
That is a single global term applied to everything, indoors and out alike —
which is why a shop at dusk currently looks like a field at dusk.

The `indoor` mask makes the split answerable for free, and this is the payoff
that turns lamps into a purchase:

- **Outdoors** is lit by the sun. It gets dark at night, and nothing you buy
  changes that. Farm work at dusk is meant to be gloomy.
- **Indoors** gets only a fraction of the sun, plus whatever your own lights
  add. An unlit shop goes dark at dusk — so buying lights is what keeps you
  trading in the evening, rather than a thing you do because it looks nice.
- **Windows earn their keep.** A `window` edge lets the sun into the cells
  behind it. That is the difference between a windowed frontage and a bunker,
  and it makes an aesthetic choice a functional one.

Do the cheap version. Two ambient terms rather than real light transport: an
outdoor ambient that tracks the sun, and an indoor ambient that is a low floor
value plus a falloff from each nearby `emits` piece and each window edge.
Per-cell, computed when the layout changes and when the hour changes — not per
frame, and not a shadow map.

The gameplay knob that follows: **closing time is a consequence, not a rule.**
Today the shop shuts at a fixed hour. It could instead shut when nobody can see
the shelves, which is a thing you fix by wiring the place properly.

### Decorations

The reason to give props `tags` rather than leaving them purely cosmetic is that
the whole game is already built that way — customers don't want tomatoes, they
want `produce` + `cheap` + `organic`. A shop dressed `cosy` or `premium` could
read to an archetype the same way an item does.

Worth designing deliberately and **not** in the first pass. Call `list_tags`
before inventing any; per CLAUDE.md, invented tags are the most common mistake
here and `simulate` reports the damage under `deadStock`.

### Where costs come from

**Built.** `fixtureUnitCost` used to derive a price by scanning upgrade payloads
— find whichever row sells this kind, divide its cost by how many it granted,
take the cheapest — which worked only because every fixture kind had exactly
such a row. A planter never will, and neither will the fourth shelf design
somebody authors this afternoon, so a catalog that couldn't name its own prices
was a catalog with five entries in it.

`cost` is on the piece now and the scan is gone. Four things came with it.

**The move itself was worth nothing, on purpose.** The five shipped rows were
filled in at exactly the numbers the scan was already deriving — 45, 260, 300,
30 — and `cost > 0` had short-circuited to the row since step 7, so the content
change landed first and the code change found nothing left to do. The build-mode
price table is byte-identical across both. That is the whole reason to build an
on-ramp a step early: the day you delete the old thing, you already know it
agrees.

**The five old fixture upgrades became discounts.** They had been dead rows for
two steps — `buyUpgrade` refused them because build mode replaced buying a lump
of shelving the generator sites for you, and they survived purely as the price
list the scan read. With the price on the piece they did nothing at all, so they
sell a *rate*: own "Trade Account" and every shelf you ever put down is 30% off.
Best-of rather than stacked, capped at `MAX_FIXTURE_DISCOUNT` — same shape
`foldModifiers` uses for two copies of one world event, and for the same reason.

**Not unlocks, and this is the deliberate half.** The plan said "unlocks and
discounts". An unlock is a *refusal* — you may not build a freezer until you buy
a licence — and this codebase already decided that argument: **impossible
refuses, inadvisable warns**, and "you have not bought the paperwork" is not
physics. It would also have been a new gate on something you can do today, so it
makes the game smaller in exchange for making a row meaningful, when a discount
makes the row meaningful for nothing. The one genuine unlock in the game already
exists and always did: an appliance, which cannot be placed unless an upgrade
names that machine. It stays the exemplar rather than the pattern.

**`space` is the last upgrade that grants anything**, and what it grants is
land. It was already the only one that made the building bigger rather than
fuller; it is now the only structural upgrade at all, which is why `buyUpgrade`
re-flows for `space` and for nothing else.

**And a ladder goes both ways.** `upgradeFixture` read one direction for as long
as it existed: a rung bought by mistake was undone by selling the whole unit and
building it again, which loses the stock, the reservations and the tile — three
things that have nothing to do with the tier. `downgradeFixture` is the same one
call the other way, through the same `repositionFixture` a move and a rotate go
through, so what changes is one number.

Two things about it are not obvious. The refund is half of the rung you step
**off**, never the one you land on: a ladder whose rungs get dearer as it climbs
would otherwise be a press — buy the $260 rung, step down, collect half of $90,
repeat — and half of the rung you leave means every circuit costs money whichever
way it is walked. And a tier is not only a multiplier: `boardsOf` reads the art
*at the tier*, so a shipped freezer draws 2, 2, 3 boards, and stepping down can
take away how many KINDS a unit holds as well as how much of one. Nothing in the
game had ever made a fixture smaller, so nothing had ever checked — `tierShortfall`
refuses, before the money moves, and says how much to take off. Refusing rather
than tipping the excess into a crate is the call `removeFixture` already makes
with "empty it first": a verb that quietly rearranges your stock is one you
cannot undo by pressing it again.

The `world.fixtures` ledger retired. You pay when you place and get
`FIXTURE_REFUND` back when you tear out — both of which were already true — and
the count is now a recount over `placements` (`Game.fixtureCounts`). It could
not have been one before step 4: while the generator furnished the shop itself,
"six shelves" was a number nothing in the world could be read back from. A
stamped shop *is* its placements, so a stored count was a second opinion about a
fact, and a second opinion is a thing that drifts — it double-counted a freezer
on every server restart once.

### Floors, and the half of enclosure that was missing

**Built** — step 13, and it is the answer to a question nobody had asked in this
doc: *how do I make my shop bigger?*

Enclosure has meant "whatever the walls close in" since step 3, so an annex you
drew genuinely counted as indoors from that day. And then it refused every shelf
you tried to stand in it, because the ground under it was grass and
`BUILDABLE_INDOOR` is floor. Walls could say "this is a room" and nothing could
say "this is a floor". The refusal even came out as *"something is already
there"*, which sends you looking for the thing — so the missing feature
presented as a bug in the wrong place entirely.

The shape it landed in is worth recording because two of the three decisions
were the ones that kept it small.

**A floor is not a tile kind.** The obvious move is `T.FLOOR_WOOD`,
`T.FLOOR_TILE`, and it is wrong twice over: every new material would have to be
added to `WALKABLE` and `BUILDABLE_INDOOR` and the renderer's `TILE_STYLE`, so
flooring stops being content; and a save holds `tiles` as raw numbers, which is
the same reason the enum has gaps in it. So `tiles` still only ever holds
`GRASS` or `FLOOR` here, and *which design* rides in its own sparse layer,
`layout.floors`. Nothing that reads `tiles` changed at all — which is the
claim, and `verify:floor` asserts it directly: two floors of different colours
and different prices produce byte-identical `tiles`, `blocked` and `indoor`.

**A floor is not in `FIXTURES`.** Every row in that table answers "where may
this stand, and who reaches it", and a floor answers neither — it *is* the cell.
It is still a `BUILD_KIND`, because it is still a thing content designs. So the
vocabulary partitions in three now rather than two, and `verify:catalog` counts
the buckets rather than trusting anyone to remember.

**A floor is the one piece with no `model`.** It carries `surface` instead — a
colour, an optional second colour and a repeat. That is not laziness about art:
the ground is seen edge-on at 45° with a whole shop standing on it, so nothing
finer than one tile survives, while a colour that alternates tile by tile reads
from across the room. It costs one lookup in a loop that already writes a
per-instance colour to jitter it, and no extra geometry, mesh or texture.

Two consequences worth knowing:

- **`space` upgrades stopped being the only way to grow and became the honest
  one.** You can wall and floor an extension for the price of the materials, so
  the two extension rows would be dead — except that `canPlaceEdges` refuses to
  build off the map and the world grid is sized off `shell`. So what `space`
  sells is *land*, which is what its name always said. Its descriptions were
  reworded to stop promising floor area.
- **Taking floor up from under a fixture refuses, and that is a deliberate
  exception to warn-don't-refuse.** It reads like a consequence you should be
  allowed to cause. It isn't: the generator would not leave the shelf standing
  on grass, it would drop the placement on the next re-flow and refund it. A
  brush that quietly sells your shelving and its stock back is a bulldozer
  wearing a paintbrush, and the bulldozer is right there.

### The yard stops being furniture

**Built** — step 14, and it is the floor brush's argument applied to the last two
cells in the game that were neither content nor code.

The delivery bay and the drop-off were *generated*. `compose` stamped two 2×2
patches against the corners of the back wall, on every single re-flow. That last
clause is the whole bug: they could not be moved, resized or removed, because
buying a shelf put them back. They were the only thing left in the shop that
step 4 had not made yours.

They are ground, in exactly the sense floor is — a cell is *made of* bay, nothing
stands on it — so they became two more designs for the brush that already
existed rather than a second mechanism. Four decisions, and the first is the one
that kept it small.

**One overlay, not two.** `layout.floors` became `layout.ground`, and a cell
holds one painted piece whose KIND decides the tile: `floor` → `T.FLOOR`, `bay` →
`T.BAY`, `drop` → `T.DROP`. A separate pad layer would have needed its own
validator, its own re-flow, its own precedence against flooring, and an answer
for "what happens when a cell is both". One array has no such question — a cell
has one ground, and `GROUND` in `shared/build.js` is the whole vocabulary. The
kind rides beside the piece on each entry rather than being looked up from it,
for the same reason a placement stores both: `generateLayout` is pure and has
never seen the catalog.

**A pad is a region, not a point.** `L.bay` was `{x, z}` and is now
`{x, z, cells}`, read back off `tiles` rather than remembered — the argument
`fixtureCounts` makes against the ledger it replaced. That is what makes the
size you paint mean something: `dropGoods` fills the pad's own cells, so the
2×2 you start with holds four crates and a floored back room holds as many as it
has tiles. It is also why `near(p, pad, BAY_REACH)` had to go. A radius from the
middle of a 2×2 is a fair description of a 2×2; measured from the middle of a
stockroom it tells you that you are too far from the storage you are standing in
the back of. `onPad` is five tile reads instead.

**Deleting has to stick, which is why the mark is a boolean.** `freezeYard`
stamps the default pads once, the way `freezeShell` stamps the shelving — and
the tempting mark is "does this shop own any pads". It is wrong: paint over your
last bay and the next load hands it back, which makes the yard the one thing in
the shop you are not allowed to get rid of. That is the complaint this answers,
so `world.yardStamped` is its own field and gone stays gone. `canPaintGround`
*warns* before the last cell of a pad goes, and `buyStock` *refuses* when there
is no bay — a consequence you are told about, and physics, in that order.

**The seed may only lay ground the player could lay.** The pads used to be 2×2
at `store.z - 2`, which put half of each on row 0 — the world's border ring,
which every build tool refuses. A pad you can delete three quarters of is worse
than one you cannot delete at all, because it looks like it worked. So the seed
runs four along the wall on the first paintable row.

And that exposed the real constraint: `storeZ` was hardcoded at **2**, so the
building stood two rows off the north edge and the yard was *one usable row*.
The shop is centred east–west and was never centred north–south. Fixing it meant
moving the building south, which this document had already ruled out in step 4 —
every fixture in a live save is a placement at an absolute tile, so the whole
contents of the building would land outside it and be refunded. So the position
joined `w` and `h` on the stored shell: a shop with `shell.z` uses it, one
without reads 2 and does not move, and new worlds start at 5 with four rows of
yard. A read-time default rather than a migration, the same bargain `kindOf`
strikes.

`verify:yard` guards the four claims that are invisible in a screenshot, because
a seeded pad and a generated one look identical on the day it lands: stamped
once means once, an old save gets a yard *and does not move*, area is capacity,
and a pad indoors is walkable but never buildable.

### The third pad holds people

**Built** — the break area, `GROUND.break` → `T.BREAK` → `L.break`, and the first
test of whether "a pad is a job" was a real idea or a description of the two
things that happened to exist.

It was. The whole feature is one entry in `GROUND`, one line in `TILE_STYLE`, one
palette entry and one row in the catalog; everything that makes it *work* —
painting it, pricing it per tile, warning before the last cell goes, refusing to
strand a fixture on it, drawing it in its own colour, reading its region back off
`tiles` — was already written for the bay. What is genuinely new lives in
`server/sim/staff.js`, where the shop stopped taking the pastime's word for
where a break happens. See **step 9 of docs/workers.md**.

Two things it changed here, both small and both worth keeping:

- **`does` is a field on the GROUND row.** `document-fixtures` described a pad by
  branching on its kind, which is fine for two and wrong for three — a third pad
  gets described as the second. What a pad is FOR now lives on the row that
  defines it.
- **Nothing seeds it, and that is the difference between a pad and a *yard*.**
  `freezeYard` stamps a bay because a shop with nowhere for a delivery to land is
  broken. A shop with nowhere to rest is the shop everybody already has, so the
  break area starts at zero cells and `L.break` is null until somebody drags one
  out. A pad that seeds itself is answering "this shop cannot work without one";
  a pad that doesn't is answering "this is worth building".

### A way through, and who it is for

**Built** — step 15, and the first time an edge means something different
depending on who is standing at it.

It grew one thing in the building that this section did not plan: **one way**.
Staff-only answers "not for customers"; entrance-only and exit-only answer
"customers, but not both ways", which is the other half of the same idea and the
one that shows up in every real shop. Four things about it are worth reading
before touching either, and they are in the sub-sections below where they belong:
which way is "in" is *read* rather than stored, there is deliberately no one-way
gate, the queue refuses every ruled opening rather than asking about direction,
and nothing had to learn where the doors are — A* finds the way in, so signing
your front door is a longer walk rather than a closed shop.

The break area is a room for the staff that any shopper may walk into. So is a
stockroom, and so will a kitchen be. Enclosure gave us rooms, floors made them
usable, and there is still no way to say **this one is not for customers** —
which is most of what a back-of-house *is*.

#### Staff-only is a property of a way through, not a new kind of wall

The obvious build is two more palette buttons: Staff Doorway, Staff Gate. It is
the wrong shape, for the reason the tier ladder is not five separate shelves.
You do not know a door should be staff-only when you draw it — you find out
after the room exists, usually while watching somebody wander through it. A
palette button asks the question at the one moment you cannot answer it, and
gets you a shell with two kinds of opening in it that look identical and were
chosen by whichever button you happened to have up.

So it is a **toggle on the opening you already built**: aim at a doorway or a
gate, open its menu, pick who it is for. The same gesture on both, because
"customers do not come through here" is one idea and a fence is as good a place
to say it as a wall. That also settles a question this doc did not think to ask
— the farm. A gate is how you get into a fenced field, and a staff gate is how
you keep the shop floor out of it.

**A tap opens it, and the highlight is what makes that findable.** A doorway is
the one thing you can point at with no tile and no id, so it was also the one
openable thing in the game that nothing marked: the menu existed and was
unreachable, which reads as the feature not being there. `pickWay` is the aim, and
it is asked by BOTH the hover and the tap — `boardTakes`'s rule, for the same
reason, since a bar that lit up while the press opened the shelf behind it is the
green-ghost bug wearing a marker. It draws the aim frame's own amber along the
line (`setEdgeGhost`'s `aim` state, which is not a verdict) plus a pointer cursor,
the same pair a hire gets.

**And only while you are building.** Everything on that menu is a build verb, and
a wall is not a thing you interact with while shopkeeping — but the deciding half
is that a doorway is *everywhere*: the shop front is a line of them, so a bar that
lit up along it whenever the pointer crossed the front of the building was
advertising a menu at the one moment nobody wants one, over the awning, the till
and the queue. The veto is on `pickWay`, so the highlight, the hold and the tap go
on agreeing, and it is `paletteArmed` rather than `buildOn` — the same test
`aimable` uses to keep decorations unpointable outside the mode, and for the same
reason: the mode a fixture menu borrows for one press of Empty puts no bar on
screen, so it must not quietly make the walls clickable. `toggleBuild` shuts an
open way menu on the way out, beside the fixture menu it already shut.

Precedence is: a person, then a fixture, then a crate, then the way. That ordering
is what keeps the shop front usable — the awning stands on the very tile the front
door opens onto (`defaultAwning`), so pointing at the canopy reaches the canopy,
while pointing at the threshold from inside the shop reaches the door. It opens on
**one** press rather than the two a fixture takes: the first of those two exists
so it can spend itself on the walk and on selecting for R and M, and a doorway has
no working spot to walk to and no build verb bound to a key.

In build mode with the Doorway tool up, a **tap on a doorway that is already
there** opens it too, and that press used to be the one gesture in the mode that
did nothing at all — the server answered `unchanged`. It is the precise way in,
because `pickEdge` named the line when the press went down; the ghost goes amber
there rather than green, because green would be promising a purchase that is not
going to happen. Only a single segment (a drag along a wall is a run, not a
question about one door) and only within a family, so the Wall tool still bricks a
doorway up and the bulldozer still knocks it through.

The last of the affordance is the tool's own blurb, and it has to be: there is no
palette button for a staff doorway, so nothing else on screen could say that a
door has a setting at all.

#### The same machinery reglazes a window, and that is the family line

Windows came next and cost almost nothing, because the shape was already here.
`GLAZING` is `WAYS`'s sibling — four kinds of one `base`, differing in **where the
glass starts and stops**: the plain one (waist to lintel), a **shopfront** (floor
to lintel over a kick plate), a **bay** (standard glazing stepped out over a sill)
and a **high** strip up under the lintel, which is light with nothing to see
through it.

The distinction between the two tables is the thing to keep. An opening's kinds
differ in *who may cross*, which is behaviour the sim reads and the reason step 15
was a step at all. A glazing's differ in nothing the sim reads at all — so they are
**variants**, and the codebase's own rule about variants applies: a look must never
move a number. Hence one price for all four, hence swapping between them is free,
hence no `simulate` run over a picture. If a window ever *does* something —
daylight a lamp does not have to pay for, charm, a shoplifter who can see the till
— that is a number, and it stops being a variant on the day it arrives.

What they share is `edgeFamily`, which is now what the refit is charged against
and what the menu lists: within a family you keep the door, or you keep the wall.
So the window menu is the door menu with a different table behind it, and the four
looks are on the bar as well — a shopfront along the front of the shop is a thing
you decide while drawing it, and the menu is how you change your mind about the one
already standing there.

Three things in the geometry are worth knowing before adding a fifth look:

- **A look should be two numbers in `EDGE_BASE.glass`**, `sill` and `head`, and
  nothing else. The defaults ARE the window that has always been here, which is
  what makes the existing one provably unmoved.
- **A bay projects toward the OUTDOOR side**, read off the `indoor` mask the same
  way `shopperCanCross` reads "in" — a bay that bulged into the aisle would be a
  look that eats shop floor. With nothing to go on it falls to the positive axis,
  which has to be a decision rather than a guess: it must be the same answer every
  re-flow, or building a shelf flips your bay to the other side of the wall.
- **A wall-sized pane asks for its shadow back.** `castShadow` is off for glass,
  which is right for a bottle and a freezer door and wrong for a shopfront: a
  building whose whole south face stops laying a shadow on its own forecourt reads
  as the wall having been demolished. `shadow: true` on the band is the ask, and it
  is the same flag, in the same words, that a model part already has.

**The hold does nothing here, and that is `HOLD_OPENS`.** The ladder in
`openAtPointer` ends in this menu too and is wired end to end, but the flag is off
— opening moved back onto the tap. Worth knowing before you add the next thing you
can point at: putting it only in `openAtPointer` ships it dead, and the way to
find out is that the highlight works and the press does nothing.

The honest qualification: **nothing in the sim walks the farm today.** A shopper
paths to a `browseAt`, to a till, and to the door, and that is the whole list.
A staff gate therefore changes no behaviour on the day it ships. It is worth
building anyway, because the alternative is that the day something *does* send a
shopper outdoors, the answer is a new mechanic rather than a switch that was
already there — and because the player reading the palette has no way to know
which of the two it is.

#### It is authored as a toggle and stored as a kind

`edgesV` and `edgesH` are `Uint8Array` of kind — one number per lattice line,
and no room in it for a second bit. So the toggle writes `E.DOOR_STAFF`,
`E.DOOR_IN`, `E.DOOR_OUT` or `E.GATE_STAFF`, four more entries in the closed
vocabulary, and the menu is a `build-edge` at that line with a different kind.
Nothing about storage, persistence, `withEdge`, `deriveEdges` or the renderer
learns a new concept.

The four are one table (`WAYS`, `shared/edges.js`): a `base` — what it is built
out of, which decides enclosure, price and how it draws — and a `rule`, which is
who may cross. `SOLID`, `ENCLOSING` and `RULED` are all *derived* from it, which
is the half that would otherwise rot in silence: a row added with the wrong base
is a doorway that stops being a room or a gate that starts being one, and nothing
in the game would say a word about it. `verify:doors` asserts each membership
against the table rather than listing kinds.

**There is deliberately no one-way gate.** Which way is "in" is read off the
enclosure (below), a fence never encloses, so a one-way gate would be a rung that
changes no number — the trap this codebase keeps naming about tiers that sell a
multiplier nothing reads. Staff-only needs no direction, so a gate gets that one
and stops there. For the same reason the menu offers one way only on a boundary
that *has* an inside and an outside, and says so where it doesn't: an interior
door between two rooms would otherwise be a button that looks like it worked.

That split is the point rather than an implementation detail. The player is
offered a *property*, because that is what it is to them; the representation
stays one array lookup, because `SOLID.has(edgeBetween(...))` is in the inner
loop of A\* and runs a few thousand times per path. The rejected alternative — a
parallel `private` mask beside the two edge arrays — would have to be threaded
through the layout, the save, the snapshot, every "what if" probe and both
migration paths, to avoid spending two enum values.

An existing save needs nothing: an edit is `{o, x, z, k}` and `k` is a number.

#### The one genuinely new idea: `SOLID` stops being the only answer

Everything else here is filling in tables. This is not. A wall used to be a wall
to everybody, and only four places ever ask:

| Where | Who is walking | Reads |
|---|---|---|
| `findPath` (`server/sim/pathing.js`) | everyone | per-caller: `{ shopper }` |
| `canWalk` (`server/sim/index.js`) | the player only | stays `SOLID` |
| `growLane` (`shared/build.js`) | queueing shoppers | refuses every `RULED` opening |
| `whatThisBlocks` (`shared/build.js`) | the flood from the door | stays `SOLID` — see below |

`findPath` is shared by customers, staff and the player, and nothing on an
entity says which it is. Cheapest honest answer, and the one that was built: a
`shopper` option on `findPath`, chosen in `Game.pathTo`, keyed off the one field
only a shopper has (`archetype_id`). Six of its eight call sites are customers.
The one direct caller outside `pathTo` that had to be told is `parkSpaces`,
because the walk from a bay to the door is the driver's own — a car park whose
only way in is a staff door is parking nobody can use.

**Which way is "in" is read, not stored.** `shopperCanCross` asks the `indoor`
mask, so an entrance is a boundary a shopper may cross *into the enclosure* and an
exit is one they may cross out of. That is what keeps a one-way door to one enum
value instead of a stored side per edge, and it is the honest answer besides:
nothing in this game has ever meant anything else by "in". Two consequences fall
out of it and both are deliberate. On a boundary whose two sides agree — an
interior door, a gate in a fence, or *any* opening once somebody takes enough wall
out that `computeIndoor` returns zero cells — a one-way rule has nothing to say and
lets everybody through; refusing there would seal every signed door in the world
the day a wall came down, which is the all-or-nothing state `growLane` was already
caught by. And the probe in `canPlaceEdges` has to be handed a *fresh* mask, because
`withEdge` carries the old one across: ask a shopper question of a stale enclosure
and the answer is about the shop you had before the wall.

**A pathing predicate is a function of the STEP now, not of the edge.** There is no
set of kinds that can answer "may this be crossed" for a one-way door, because the
answer is yes one way and no the other. `reachable` therefore takes an optional
`cross`, and the queue does *not* use it: a lane is grown outward from the till and
walked toward it, so asking about direction would give whichever answer the loop
happened to ask for. It refuses every `RULED` opening outright, which is also what
you want — a queue that files in through the entrance and cannot leave is not a
queue.

Enclosure is the other half, and the two are independent on purpose — `SOLID`
and `ENCLOSING` have always been separate sets. A staff **doorway** goes in
`ENCLOSING`: leave it out and your stockroom is a patio, every shelf in it is
refused, and the refusal reads "something is already there", which sends you
looking in the wrong place. A staff **gate** stays out of it, for the reason
every fence stays out of it: fencing a field must never roof it.

#### Two traps, both in the warnings

**"That seals the shop" has to become a shopper question.** `canPlaceEdges`
floods from the spawn to the door with `SOLID`. Unchanged, you can turn your
front door staff-only and the game says nothing at all while no customer can
ever enter again — a shop that looks completely normal and takes no money.

**The fixture-stranding flood underneath it must *not* change.** If that also
went shopper-solid, every shelf you ever stand in a stockroom would warn "that
cuts a shelf off from the door" on every wall you drew afterwards, for ever,
about something you did deliberately. Same argument `whatThisUnroofs` already
makes: report what the action *changes*, not what was already true.

Beyond those two, the sim needs no defending. A shelf a shopper cannot reach
simply never sells — they write it off and pick another — which is the
`canPlace` bargain (warn, don't refuse) collecting on a promise it made in step
3.

#### The toggle is not free, and that is a decision, not a bug

`buildEdge` charged `EDGE_COST[new] − EDGE_COST[old] × FIXTURE_REFUND`. Price a
staff doorway identically to a doorway and flipping the toggle still costs half
a door — and flipping it back costs half a door again. A switch that quietly
bills you $17 for changing your mind is not a switch.

Two ways out, and the **refit** is the one that was built: swapping within a
family (door ↔ staff door ↔ entrance) charges the difference and refunds nothing,
because you still have the door. With the four priced at their base that makes the
switch free in both directions. The refit is the smaller lie: per-edge pricing
exists so a window over a wall charges the gap, and this is the same claim about
the same line. Outside a family nothing changed — bricking a doorway up is still a
swap, and knocking one through still pays you back.

#### What a sweep has to hold

Almost none of this is visible in a screenshot — a staff door and a door are the
same hole in the same wall, and the whole feature is about somebody who *didn't*
walk somewhere. `verify:doors` (not `verify:staff`, which would read as the worker
sweep) pins: every membership derived from `WAYS`; a staff doorway encloses exactly
as a doorway does and a staff gate exactly as a gate does; one edge, crossed by a
hire and refused to a shopper, and still walked by *you*; an entrance crossed
inward and not outward; a one-way rule between two rooms letting everybody
through; a room behind a staff door still reachable by staff (or you have
re-created the `TIRED_PACE` pin `verify:break` exists to catch); signing the last
way in warning rather than refusing, in both directions; the stranding flood
answering identically either side of the sign; no place in a queue beyond a ruled
opening; and the refit costing nothing either way.

The one thing that IS visible, and the reason it was built: a signed way through
paints its **threshold**. Grey for staff, green for an entrance, amber for an exit
— `mark` on the style, one band in `edgeBands`, and the palette's picture of it
comes off the same record (`artForEdge`), so the button cannot show a door the game
does not build. "Invisible in a screenshot" is a fine thing to say about a rule the
sim obeys and a poor thing to say about a switch you just flipped and want to
check.

#### What it is not

Passability, not privacy. The room is still indoors, a shelf in it is still a
legal shelf, and a shopper can still see in. If "customers cannot see the
stockroom" ever matters, that is a rendering question and a different feature.

### Picking several, and what a menu can then say

*Built (step 16).* A fixture menu could only ever be about one fixture, because
opening it was the only way to *name* one. Which meant that restyling a row of
shelving — the thing you most obviously want to do to shelving, since a shape is
free and keeps its stock — was open, press, close, walk, open, press, close, once
per unit. The decision was made in one look at the shop and paid for seventeen
times.

Three parts, and the order matters because each is useless without the one before
it.

**Hold Shift and the shop says what is like this.** Every fixture of the same
*design* as the one you have picked wears a thin, faded version of the selection
ring (`kin` in `MARKER_LOOK`). The key selects nothing — it is a preview, and it
is the half that makes the rest discoverable at all: shift-click is invisible
until something on screen reacts to the shift. Design means the **piece**
(`UI.designOf`), which is the set that shares one list of shapes, so every basic
shelf lights up whether it is currently straight, a corner or a wall unit. That is
exactly the set "make them all wall units" is asked of. It goes through `pieceFor`
rather than reading `f.piece`, because a fixture placed before the catalog split
carries no piece at all and resolves to the very row the ones beside it name — off
the raw field, a shop's own shelving sorts into two designs that draw identically.

**Shift-click adds or drops one.** It takes the press before any of the four
drags in `pointerdown`, and that is not an ordering nicety: each of those is a
verb — a wall tool would have laid a segment, the brush a cell, the palette a
fixture, the bare press turned the camera — and picking six shelves is six clicks
that have to be *only* picks. It is consumed whole, so the release is not also a
tap. The first pick is still an ordinary one (`fixtureRef`), and the extras are
`ui.picked`; picking something new without shift clears them, which is the rule
that keeps an ordinary tap safe.

Step 19 took this key away with the palette up — the bulldozer had it — and
step 23 gave it back. Shift is the selection with the bar up or down now, and
Ctrl (Cmd) is the bulldozer. See "Ctrl is the bulldozer" below for the argument
both ways round.

**The menu narrows to what they share.** Not a second menu: a second list of rows
about the same fixtures is two pictures of one thing, and this file's own gotcha
about `thumb.js` says what happens to those. The same `showFixture` runs, and each
group is asked whether the *whole* selection can do it — one stock kind for the
item list (a freezer and a warmer share no item that could go on both), one design
for the shapes, every unit holding goods for the refill order. What is left is the
four standing decisions: the shape, what it is kept for, when it gets refilled,
who may rearrange it, and whether it is back-of-house. A tick is lit only when
they *all* agree, and the press then says which way it means (`on: !allSay(...)`)
rather than flipping each — six flips is six different answers.

Move, Rotate, Upgrade, Downgrade, Empty and Remove stay one at a time and **say
so** rather than disappearing. A hole cannot answer "where is the Remove button",
and that row is the most familiar thing on the menu. R and M refuse with the same
sentence (`ONE_AT_A_TIME`), because a key that refused differently from the button
it stands in for is two rules to learn.

#### One message, one re-flow

The server side is the part nobody sees and the part that had to change. Every
fixture verb takes one id, so the obvious client answer is to send the message
once per fixture — and that is wrong three ways, none of them visible in a shop of
six. `styleFixture` goes through `repositionFixture`, which re-runs the generator,
rebuilds the walk grid, throws away every shopper's path and bumps
`layoutVersion` — the same cost `setBackOfHouse` argues its way out of paying for
one flag. It also re-mints the id of what it moves, so a client sending N messages
with the ids it was holding is a bug waiting for its own re-flow. And the feed
would carry one event told six times, which is `endPull`'s argument about a
gesture said about a selection.

So the message carries `ids`, `targets` in `MartRoom` is the one spelling of "who
is this about", and `Game.bulkFixtures` runs the single-fixture verb per id inside
`holdReflow` — which defers every re-flow and does the one at the end. What makes
that safe rather than merely cheaper is that nothing *between* the verbs reads the
layout: each looks its own fixture up and checks `canPlace` against a shop none of
them has moved a tile of. Only the plain form defers; a re-flow that is
compensating differently or asking for a different set of fixtures is not the one
the batch is going to run.

A batch that lands on some and not others is an `ok` that logs what it could not
do — six refusal toasts stacked over each other for one press is worse than the
information is worth — and only a batch that changed *nothing* comes back as an
error. **A selection of one is the old path exactly**: no fold, no summary line,
no held re-flow, and the verb's own result rather than a batch report wearing it.
Every press in the game that is not a bulk one goes through there now, so that is
the assertion that stops this being a tax on ordinary play. `verify:pick` pins all
of it, and its centrepiece is a number that must not grow — and must not stay at
zero either, because a held re-flow nothing fires is a shop that silently does not
update.

#### What it is not

A marquee. Dragging a box round part of the shop to pick everything in it is the
obvious next gesture and it is a separate one: it needs its own drag path in
`pointerdown` beside the wall, brush, lift and camera drags, and a screen-space
test against the art rather than the tile. Everything above it is already in
place — the set of rings, the narrowed menu, `ids` on the wire — so it is a
gesture rather than a feature.

Nor is it bulk Upgrade or bulk Remove. Both spend or refund real money once per
fixture, and the row that would do it is one press from a selection you picked for
a different reason. They are the two verbs worth being asked about twice.

### Painting the walls, one side at a time

*Built (step 17).* A floor has been content since step 13 — a `surface` row, a
colour and a repeat, painted over an area. The walls were the half that was
still the renderer's opinion: every wall in every shop was `PALETTE.wall`, and
the only way to change one was to edit a file.

**A finish goes on a FACE**, which is the thing that makes this its own kind
rather than a fifth glazing or a floor with a different tile. `GLAZING` and
`WAYS` are looks of the wall itself, one per edge; a face is *half* an edge. The
two sides of the wall between the shop floor and the stockroom are two different
answers, and the whole feature is that you can give them.

So `BUILD_KINDS` partitions in **four** now — a fixture, a decoration, ground, a
finish — and `verify:catalog` counts that rather than trusting anyone to
remember. It counted three when this landed, which is exactly how the fourth
bucket announced itself: paint arrived as a kind in no bucket, and that line is
what said so.

Three decisions kept it small.

**It is authored as a `surface`, the same one ground uses.** A wall at this
camera is a strip of flat colour with a repeat on it, which is what a floor is
too — so `create_fixture` needed no new shape, `artForGround` already drew the
swatch, and `isSurface` is the one test the schema, the palette and the
thumbnail drawer all ask. A new shade of blue is one MCP call.

**The side is a number, not "inside".** `faceKey` is `o:x:z:±1` along the edge's
own normal. Which side is indoors is a fact about the *shop* — `computeIndoor`
re-answers it every re-flow, and a room you wall off changes it for edges nobody
touched — so paint stored as "the inside face" would silently swap sides the day
you extended the building. That is the bay-window trap (`outward` in the
renderer) with a colour on it. The geometry never moves, so the geometry is what
it is keyed to.

**The pointer says which side.** `pickEdge` already computes the raw
intersection before rounding it to a line, so which side of that line you are on
is a sign test and nothing more (`pickFace`). Hovering lights the face itself —
not a bar down the middle of the wall, which would be answering the one question
the gesture is asking — and a drag paints along the run at the side it
*started* on. Re-reading the side per segment would paint the inside of whichever
two segments your cursor drifted across on the way.

#### It never re-flows, and that is the point

`paint-face` answers with the overlay rather than with a layout, and this is the
same argument `setBackOfHouse` makes one field over. A re-flow re-runs the
generator, rebuilds the walk grid, throws away every shopper's path and disposes
the client's entire static scene. Paint stamps no tile, blocks nobody and
encloses nothing, so there is nothing for any of that to redo — the shop it
would rebuild is the shop already on screen. The room broadcasts the map, and
`Scene.setPaint` rebuilds the one group that draws walls, which already stands
alone because it is rebuilt on every quarter turn of the camera.

The same reasoning decides where the overlay is attached: `regenerateLayout`
hangs it on the **finished** layout instead of handing it to the generator.
`ground` has to go in, because a painted cell becomes a different tile and the
generator's own output depends on it. Paint cannot be given that power, because
a generator that never hears about it cannot have been changed by it. The day
that line moves up into the call above is the day a colour can move a wall.
`verify:paint` pins the claim from the outside — every wall in a furnished shop
painted, and `tiles`, `blocked`, `indoor`, `edgesV` and `edgesH` byte-identical
afterwards — but attaching it after the fact is what makes the claim structural
rather than merely tested.

#### What it is not

Not a *material*. Every solid band of a wall takes the colour and two things
deliberately do not: glass, because paint on a window is a bricked-up window and
the sill and header beside it take it anyway; and a band that already carries a
colour of its own, which is the painted threshold under a signed doorway. That
stripe is the only thing on screen saying who a door is for, and a finish that
covered it would delete the one visible half of an otherwise invisible feature.

Not weather, wear or charm. A finish reads to nothing but the renderer, so it
can never need `simulate` — the same bargain a fixture variant strikes. The day
a finish *does* something (a scrubbable surface a health inspector likes, a
frontage that draws people in) it has stopped being a look, and that is a number
on a kind rather than another row.

### The ground outside, which was never drawn at all

Every kind of ground in the game became content across steps 13 and 14 — floor,
the two yard pads, the break area, then the road and the pavement. Grass did
not, and the reason it was easy to miss is that grass is the *default*: it is
what a cell is before anybody does anything, so there was never a moment where
somebody wanted a second one and found they could not have it.

What was actually wrong is worse than "not authorable". `buildWorld` opened its
tile loop with `if (kind === 0) continue`, and `T.GRASS` is 0 — so a grass cell
never became a mesh. What you were looking at was the big apron box underneath,
one flat colour, with none of the per-cell jitter and none of the baked lamp
light every other kind of ground gets. That is why it reads as plastic next to a
floor you laid: the floor has three hundred slightly different greens in it and
the lawn has one. "The grass is flat" was not a complaint about art.

`GROUND.lawn` is the whole fix, and it is the same promotion `GROUND.path` got:
one row, no new tile value, no enum, no migration. It costs nothing on a live
save because an unpainted cell has no entry in `layout.ground` at all —
`surfaceOf` falls back to the tile's own palette colour, so a shop that has
never heard of a lawn design renders exactly as it always did, only jittered.

**It is a look and never a permission**, which is the claim `floor` and `road`
both make and which matters more here than for either. `BUILDABLE_OUTDOOR` is
`T.GRASS` and every lawn design lays `T.GRASS`, so a bed is dug into whatever
you painted and a meadow is still farmland. A design that changed that would not
be a design; it would be a kind.

#### A pattern that has height

`stripes` was already the exception to "a pattern is one colour per cell" — a
zebra bar is a fraction of a tile wide, so it is drawn as its own geometry over
the cell. `tufts` is the second, and the argument for it is the first one turned
up: what survives of a *flat* pattern at 45° is its colour, and the way you tell
grass from lino is that grass is not flat.

One instanced mesh per design however many cells it covers, so a field is one
draw call. Three things make that affordable and each is a decision rather than
an optimisation:

- **The scatter is a hash, never a draw.** `hash01` of the cell and the blade
  index, for docs/kits.md's reason about which bag a shopper carries, plus one
  that is specific to here: build mode re-flows on every wall segment of a drag,
  so a drawn scatter would reshuffle the entire lawn as you dragged. Grass that
  crawls reads as the ground being unstable, not as art.
- **`MAX_TUFTS` thins rather than refuses.** Ground is the biggest thing in the
  world by cell count and this multiplies the one buffer that gets rebuilt most
  often. Past the cap it plants every Nth cell, so a huge meadow comes out
  sparse and never bare — the call `lights.js` makes about the ninth lamp, made
  before there was a catalogue of lawns to trip over it rather than found later
  as "building got choppy".
- **The wind is a vertex shader on a material of its own.** Not `material()`,
  which is a cache keyed by colour shared by every prop in the game — an
  `onBeforeCompile` hung on it would set every green thing in the shop swaying.

#### The one number that matters: a blade is measured in its own height

This cost a round of play-testing and it is the thing to carry away.

The first version authored the blade tip's sideways offset in **tiles**
(`dx * 0.22`) while the instance stretched only the y axis, by `blade` (0.13).
So a blade 0.13 tall leaned 0.22 sideways — a 60° splay, in three directions at
once. It draws a yucca. It presents as bad modelling, and it is a unit mismatch:
two small numbers, two lines apart, that look like they are in the same space
and are not.

The fix is not a better constant. The instance scale is **uniform**
(`setScalar`), so object space is blade-heights on all three axes and a lean can
only be expressed as a fraction of a height, because there is nothing else for
it to be a fraction of. `blade` on the row became a *size* rather than a
stretch, which is also what makes a tall Meadow blade proportioned like a short
Turf one instead of a stretched version of it. `WIND_LEAN` moved into the same
space for the same reason — in tiles it was invisible on short grass and a
thrash on long.

The general shape, and it is not about grass: **a scale that is not uniform
splits object space into two units and nothing in the file says which one a
number is in.**

#### Where it goes in the palette

Building had eight sub-tabs after the paint step, and eight is the tell rather
than the problem — the row stops being a set of choices and becomes a list you
read. Five of them were the same brush laying ground around the shop, filed
apart from each other by *whose* ground it is, which is a distinction that only
matters once you have already decided you are out here.

So `outdoors` is that decision, and Land, Roads, Yard, Crew and Customers are
behind it. Land goes first because it is the ground the other four are painted
**on**: a palette that offered a delivery bay at the same level as the turf
under it was answering the second question before the first.

The name is dominant-case rather than exact, deliberately. A `drop` pad indoors
is a stockroom and a break area is as often a corner of the shop floor as it is
out the back — both blurbs say so — and naming a group for its exceptions means
naming it something nobody would look under.

#### And the right button scrapes

> **This is history — see "Ctrl is the bulldozer" below.** Both presses moved
> onto the modifier + left click, and the right button went back to meaning one
> thing.
> Kept because it is the argument for the gesture existing at all, which the
> move did not change.

`armEdgeRaze` gave the right button a meaning with a wall tool up: knock *this*
segment through, because you lay a run in one gesture and regret it a segment at
a time. Ground has the same shape of regret and had none of the answer — undoing
one cell meant finding Bare Ground on another tab, painting it, and re-arming
the brush you were using.

`armGroundScrape` is the mirror, down to the lifecycle: armed on the way down
(the pointer is on the tile *now*), dropped if the press turned, and falling
through to `ui.escape()` when there is nothing to take up, so pointing at bare
grass still backs out the way it always did. Two things it deliberately is not.
It is **one cell rather than a drag**, because the right button is also the only
way to turn the view while a brush owns the left one, so anything it does has to
survive being abandoned mid-press. And it is **exempt on Bare Ground itself**,
where the left button already scrapes over an area — one act with two gestures
is exactly what that entry's own comment argues against.

### Ctrl is the bulldozer

*Built (step 19; the key moved in step 23).* Getting rid of something was four
gestures wearing one idea.
The Demolish tool took fixtures out and knocked walls through, but only while it
was the armed tool — so removing a shelf in the middle of laying a floor was a
trip to the far end of the bar and back. Shift + right-click took a wall down,
but only with a wall tool up. The same press took a cell of ground up, but only
with a ground brush up. And paint had no eraser at all beyond finding Bare Wall
on the bar. Four rules, each true of one tool, none of them true of the pointer.

**Hold Ctrl — Cmd on a Mac — and the pointer stops asking what you would
build.** It asks what is already there instead: whatever is under it goes red,
and a left click gets
rid of it. The armed tool is not consulted at any rung — that is the whole of
what makes it learnable, because "hold Ctrl and click to get rid of that" is one
sentence where the four rules above are four.

`razeAim` is the aim and it answers in one of four kinds, most-specific-first:

| It finds | It means | The message |
|---|---|---|
| a fixture | tear it out | `build-remove` |
| a painted face | strip the finish off that side | `paint-face`, empty piece |
| a wall, fence, doorway or window | knock it through | `build-edge`, `E.NONE` |
| a painted cell of ground | take it back up | `build-ground`, empty piece |

The order is `pickWay`'s "things beat gaps" with two more rungs on it. A fixture
covers the line behind it on screen and is never *not* what you meant. Paint
comes before the wall it is on because it is the smaller of the two answers and
the bigger one is still one press away — strip the finish, and the same click on
the now-bare wall knocks it through. Ground is last because every cell in the
world is one, so any earlier and it swallows the other three.

Both refusals are asked in the *aim* rather than at the press, so nothing ever
lights up red that a click would not actually remove: an edge has to have
something on it, and a cell has to be painted — which is `canPaintGround`'s
`unchanged`, since the lawn is a ground row like any other and "is anything here"
can only be answered by asking what taking it up would change.

**And the pointer needed a band round the wall, which no tool had ever needed.**
`pickEdge` snaps to the *nearest* lattice line and always has — every point in
the shop has one — which is exactly right while a wall tool is armed, because
then the pointer means "a line" and snapping is what lets you draw along a wall
without tracing it. It is useless to an aim that has to tell a line apart from
the square beside it: most cells in a shop have a wall on one side, so with no
band, floor you had painted next to a wall could never be the thing you were
pointing at, and hovering the middle of an aisle offers to knock the shop open.
`RAZE_GRIP` (0.24 tiles, under half a cell) is the band, and it rides through
`pickFace` to the **fallback only** — the branch above it raycasts the edge
meshes, so a pointer that hit a wall is provably on one and only the guess needs
a threshold. Both wall rungs go through that one call rather than asking
separately, or the finish and the wall under it could answer about two different
walls.

Three things fell out of it.

**It shipped on Shift, and that is the part worth writing down.** For four
steps Shift meant two things told apart by whether the palette was up — this
with the bar up, the multi-select of step 16 without it — on `paletteArmed`
rather than `buildOn`, so a mode a fixture menu borrowed could not turn the key
into a bulldozer. The cost was named at the time and chosen: you could not
shift-pick a row of shelves while the bar was up.

It was the wrong trade, and step 23 undid it. What the split really did was make
the answer to "what does this key do" a fact about a strip of UI at the bottom
of the screen rather than about the key — so the one place you most want to pick
several shelves is *build mode*, which was the one place the key that picks them
meant delete. The tell was in the sentence above: both gestures are made by
holding the modifier and clicking repeatedly, which is a description of one
gesture with two outcomes. Ctrl (Cmd) is the bulldozer now and Shift is the
selection, everywhere. Two keys is also what every other editor does, which is
worth more than saving a key: neither has to be taught.

Ctrl+click on a Mac is the *secondary* click, so it arrives as `button === 2`
and never reaches the bulldozer branch — which is why Cmd is read as well. It is
the Mac idiom anyway, so the key that works there is the one people already hold.

**Each key is held as a flag** (`shiftDown`, `razeDown`), because the *hover*
needs them — the red frame and the design highlight have to appear when a key
goes down under a pointer that is not moving. Every way either can change writes
it, including `pointermove`, which is the repair for a modifier pressed or
released while another window had the keyboard. The press reads `e.ctrlKey` /
`e.shiftKey` and pushes it in rather than trusting the flag: a press that
demolished something the hover had not gone red on is the green-ghost bug with a
bill attached. Ctrl is asked first, so Ctrl+Shift is a demolition rather than an
ambiguity.

**A modifier press that finds nothing is consumed.** Falling through would make
it the one Ctrl-click — or the one shift-click — in the mode that *builds*
something, which is the outcome a near miss must never have.

And what is left on the right button is one meaning: back out. It was five —
turn the view, back out of a tool, put a thing down, walk, and the two razes —
one of which was the only destructive press in the mode, so the same reflex that
closes a picker took a wall down.

### The curtain, which is a way through you do not open

**Built** — step 20, and it is step 15 pointed at a room whose partition wants to
let goods past while it stops people.

Everything the shell could put between two indoor cells was a decision about
*whether* there is a hole. A wall is no hole; a doorway is a hole; a staff
doorway is a hole with a sign on it. None of the three is the thing a warehouse
actually hangs between the shop floor and the back: strips of PVC that end a hand
above the deck, so a crate on a conveyor rides straight under and a person pushes
through with their shoulder. That is not a fourth kind of wall. It is the second
answer to the question `WAYS` already asks, and the reason it needed no new
machinery at all is that "who may cross" was already a property of an opening
rather than of a wall.

So it is two rows in `WAYS` and one style, and the interesting parts are the
three places where a curtain is the first member of its category.

**`roofs` is a column now, and it used to be the word "door".** `ENCLOSING` was
built as `WAYS` filtered by `base === 'door'`, which is the exact shape CLAUDE.md
names twice: a predicate written against the only member of a category, which
silently excludes the second one in whichever file adds it. A curtain roofs and a
gate does not, and neither of those is derivable from either name. Getting it
wrong here is not a smaller shop, because enclosure is all-or-nothing — a curtain
that did not roof would take the roof off the *whole building* the moment you hung
one across an aisle, every shelf in the shop would be refused, and the refusal
reads "something is already there". `verify:doors` asserts the enclosure
byte-for-byte against the wall the curtain replaced, in an interior line and in
the front one.

**Its palette button lays the SIGNED kind**, which is the one place `WAY_RULES` is
an order rather than a set (`wayDefault`). Step 15 argued that staff-only is a
property you *find* rather than a button, because you do not know a door should be
staff-only when you draw it. That argument is about a doorway and it inverts here:
the entire reason to buy a curtain is that shoppers cannot use it, so one that
arrived open would be a tool doing the opposite of the thing on its own label
until you went back and tapped every segment of the run you had just dragged. The
menu is still there for the other way round, and it is the same menu — a curtain
is a family like the other two, so tapping one offers who it is for and charges a
refit rather than a purchase.

**There is no one-way curtain**, and unlike the gate's absence this one is not
about enclosure. A gate has no in and out because a fence never makes a room; a
curtain has none because strips you push through both ways have no direction in
them, so the rule would be real and there would be no picture of it. Two families
now refuse one way for two different reasons, which is why the menu's explanation
moved onto the family row (`FAMILY.noWay`) — as a ternary on `family === 'gate'`
with the doorway's answer as the else, a curtain would have been told it has the
same on both sides, about an edge with a shop one side and a stockroom the other.

**The height is not a feel number.** `CURTAIN_DROP` is the tallest thing that has
to pass under one: a crate riding a conveyor sits on `BELT_DECK` and stands
`CRATE_STEP`, so 0.43 is the clearance and the strips stop a hand's width over it.
Every centimetre above that is a window into the stockroom. And the strips are
*geometry* — six per cell with a gap between them, using the `off`/`len` a brick
course already had — for the reason `stripes` and `tufts` are: what survives of a
flat pattern at 45° across a room is its colour, and the thing that makes strips
read as strips is the gap.

The pairing with belts is the point of the piece, and `verify:belts` guards it as
a pair rather than as two claims: that the crate crosses is only interesting
because a shopper on those same two cells cannot, and that the shopper is refused
is only interesting because the run goes on working. Note what that sweep passes
*for* today — nothing in `stepBelts` consults an edge at all, so the crate crosses
because nobody asked. That is worth pinning precisely because making a run respect
the walls it passes through is a reasonable thing to want later, and the curtain
has to be the exception when somebody does.

### The roller door, which is a way through that has to LOOK like one

**Built** — step 21, and it is the smallest step in this document: four rows in
`WAYS`, one style, one palette button. Everything it needed already existed,
which is the interesting part rather than a boast — a fourth family cost nothing
because the third one paid for the machinery.

It is a **base and not a look**, and that is the one decision in here. A shutter
that is up is passable, encloses, signs, queues and paths exactly as a doorway
does — so the temptation is to call it a doorway with a different picture, which
would mean a `look` axis on `WAYS` the way `GLAZING` has one. The line between
those two tables is what settles it: a family is *the set of things that swap for
a refit*, because within one you keep the door and you keep the wall. A glazing
swap is free precisely because a look must never move a number. A roller door
costs $46 against a doorway's $34 — it is a bigger hole with gear over it —
so swapping one for the other is a purchase, not a change of mind about one,
and putting them in one family would either make the shutter free or make
reglazing cost money.

**There is no shut one, deliberately.** A shutter that is down is not a way
through at all; it is a wall with slats on it. Authored into `WAYS` it would be
a kind the table calls passable and the picture calls solid, which is the
disagreement every green-ghost bug in this codebase is made of, arriving here as
a shopper walking through a closed garage door. If a shut one is ever wanted it
is a *wall* look — `GLAZING`'s side of the fence, not this one.

**Its button lays the open kind**, where the curtain's lays the signed one, and
the two arguments do not conflict: a curtain is bought *because* shoppers cannot
use it, and a roller door is bought because it is a big hole — it is the front of
a workshop as often as it is the back of a stockroom. So which side of it the
town is on is something you find out after it is up, which is step 15's argument
about a doorway, unchanged.

**The picture is the whole feature, which is not true of anything else in
`WAYS`.** An open roller door and a doorway are the same hole in the same wall to
every rule in the game; the difference is the coil and the tracks, and if those
do not read at a glance then what you have bought is a doorway at a mark-up.
Hence three numbers rather than one grey slab under the lintel: `SHUTTER_COIL` is
headroom (a roll hanging past halfway reads as a shutter *stuck* halfway, which
is the one state this piece is not in), `SHUTTER_RIBS` is the banding that makes
a coil a coil — the fourth time in this codebase that a flat pattern has had to
become geometry, after `stripes`, `tufts` and the curtain's own strips — and
`SHUTTER_TRACK` is a guide down each jamb, drawn inside the cell so a two-cell
bay reads as a pair of doors. That last one is honest rather than a compromise:
each cell really is separately a way through, and each is separately something
you can sign.

The tracks are also the first band in `edgeBands` that runs **up** a cell rather
than across it, and they needed no new machinery — `off`/`len` place a band
along the wall, so a vertical member is a short band that happens to be tall, the
same way the curtain's strips ride a brick course's.

### Taking it back

Build mode is the one place in this game where a single press costs real money
and is hard to reverse by hand. A wall drag across the wrong aisle is eight
segments to knock back out at half the money each; a shelf dropped one tile over
has to be found, lifted and re-aimed; a floor stroke you did not want is a
bulldozer drag along the same line, priced again. Everything else the player does
is either free (walking, pointing, opening a menu) or a decision the shop lives
with (buying stock, hiring). So undo is scoped to construction and to nothing
else, and that scope is the feature rather than a first cut of it.

**It is a stack of diffs, not a stack of shops.** The tempting shape is a
snapshot: the building *is* `placements`, `edits`, `ground` and `paint`, all four
are plain data, and restoring them is one assignment each. It is wrong for
exactly one reason, and the reason is goods. A fixture's stock does not live on
its placement — it lives on the layout record, under an id `repositionFixture`
re-mints every time anything moves. Restore the array and the shelf comes back at
its old id with six loaves filed under the new one: goods destroyed, nothing
logged, and a shop that is quietly poorer four presses later with nothing to
connect it to. So a step records what *changed*, and undoing it walks each change
back through the same paths a press uses — `repositionFixture` for a fixture that
is still standing, which carries contents across by alias because that is what
the alias is for, and a direct overlay write for edges, ground and paint, which
hold no goods and therefore cannot lose any.

**The money is reversed exactly, and that is a decision rather than a shortcut.**
The honest-looking alternative is to let the inverse verbs charge normally, so
undoing a purchase sells the shelf back at `FIXTURE_REFUND` and you are out half
its price. That reads as a fine for mis-clicking, and an undo you cannot afford
to use is not an undo. So a step banks the cash it moved and the undo moves
exactly the negative of it — as a **delta** and never as a restored balance, or
undoing this morning's wall would also hand back the day's takings. There is no
arbitrage in that, because the stack is strict: every undo is followed either by
a redo that costs precisely what the undo paid back, or by a new action that
clears the redo stack. You can only ever return to a (building, cash) pair you
have already stood in.

**Only a press is a step.** `recordUndo` writes nothing unless a step is open,
and the only thing that opens one is a build message from a real client
(`server/rooms/shop.js`). The generator's own placements, the balance bot's sixty
days of shopping, the MCP surface and every `verify:*` sweep therefore record
nothing at all — which is both the memory answer and the right answer, since none
of those is somebody pressing a button they wish they hadn't. `Game.undoStep` is
`holdReflow`'s sibling in shape and in argument: a drag is one gesture however
many verbs it runs, so nested calls join the open step and `buildRun` and
`bulkFixtures` need to know nothing about any of it.

**A refusal comes before anything moves.** A step can hold twelve fixtures — a
conveyor run is one press — and half an undo leaves a shop that is neither what
you had nor what you asked for, with no entry left to try again with. So every
part is asked whether its inverse is legal before the first one is applied, and
the whole step is refused with that reason if any says no. The cases are real
ones: somebody stocked the shelf in the meantime, a wall went up across the tile,
the other player tore the thing out.

**One stack, not one per player.** There is one shop, two people can be building
in it, and the thing you most want back when co-op goes wrong is the wall your
mate just drew across the door — which a per-player stack would refuse. Nothing
is persisted: an undo stack that outlived a restart would be offering to reverse
a shop you last saw a week ago, and every fixture id in it has been re-minted by
the reload anyway.

Two details that are not about undo and would be easy to get wrong. The overlay
verbs record the **overlay entry** rather than the edge kind or the ground kind,
because a segment the shell drew has no entry at all — recording its kind would
restore it as something the *player* drew, which is identical until the shop
grows and the generator wants its own wall back. And a removal comes back as
**itself** rather than through `placeFixture`: that verb is a purchase, it mints
tier 1 and no variant, so an undo routed through it hands you a plain shelf where
a Commercial one stood, which is a demotion nothing logs wearing an undo.

Ctrl+Z and Ctrl+Y on a desktop (Cmd on a Mac, Ctrl+Shift+Z for redo as well,
because half the world learned each). On a phone there is no Ctrl at all, so the
device where every build press is made with a fingertip would have shipped the
feature unreachable — `#undobtn`/`#redobtn` are the thumb version, stacked under
the X on the same edge because they are a pair you press repeatedly and splitting
them across the screen makes stepping back three presses a two-handed exercise.
An empty stack dims the button rather than hiding it, for the same reason
`#rotbtn` is pinned to nothing that can change size: a control that disappears
from under a thumb already on its way to it is worse than one that says no.

See `verify:undo`.

### Four things a factory game already taught everybody

*Proposed — steps 24 to 27.* Undo made the point that build mode is the part of
this game most like an editor, and that everything an editor is expected to do is
worth checking against what is already here rather than designed from scratch.
These four are that list, in the order of what they cost. Each is written as its
own step because each is independently useful; none of them depends on another.

Two things they have in common, and both are why they are cheap. The catalog is
**data** — a placement is `{kind, piece, station, x, z, rot, tier, variant}` and
nothing else, which is why undo could be a stack of them — and the pointer
already answers **which thing** (`pickFixture`, `pickAim`, `pickWay`) rather than
guessing from proximity. Most of what follows is a new sentence made out of verbs
that exist.

#### 24. Q is the pipette

Point at anything in the shop and press Q: the palette arms *that* piece, that
variant, that rotation. Nothing new on the wire and nothing new on the server —
`Scene.pickFixture` already names the fixture, `pieceFor` already resolves its
row, and `selectBuildTool` / `ui.buildVariant` / `ui.buildRot` are the three
fields the ghost reads. It is the smallest of the four by a wide margin.

What makes it worth doing is not the saving. The palette is a catalogue of
*designs*, and the thing you usually want to build next is one you can see — so
"which of the eleven rows was that shelf" is a question the shop is already
answering, in the aisle, and the bar is where you go to re-ask it. The same key
should pick up a *ground* design under the pointer and a wall *finish*, because
those are the two places the catalogue is longest and the tile smallest.

The one decision: it must arm the tool without opening the bar over the shop, or
a key for "that one" costs you the view of the thing you pointed at. That is
`commitBuildMode`'s quiet mode, which exists.

#### 25. Any fixture drags out in a row

The conveyor run drag is written (`beltRunCells`, `showBeltDrag`, `build-run`),
and there is nothing about it that is about belts. An aisle is six shelves on one
line and it is six presses; a fence is the same sentence about `fence`. The rule
that stops it being a free-for-all is already stated in `beltRunCells`: a run
follows the line it started on, and turning a corner is a second drag.

Two things this has to decide, and neither is hard. **What a corner means for
something with a facing** — a belt turns to follow the run because a belt's
rotation *is* its direction, and a shelf's is which side you browse it from, so a
dragged shelf should keep the armed rotation for every cell rather than turning.
That is one flag on the kind, not a branch at the call site. And **running out of
money halfway** builds what you could afford, which is what a wall drag and a
floor stroke both already do and for the reason they both give.

`build-run` is deliberately named for the gesture rather than for conveyors, so
this is a widened guard rather than a second message.

#### 26. Copy and paste a selection

The multi-select is built and holds a list of fixture ids; a placement is plain
data; `placeFixture` takes one and mints it. So Ctrl+C over a selection is a list
of placements made *relative* to one anchor cell, and Ctrl+V is that list
re-anchored under the pointer and laid through the existing verb, inside one
`undoStep` so the whole stamp is one Ctrl+Z. That last clause is the reason this
step comes after undo rather than before it: a paste you cannot take back in one
press is a paste nobody dares use.

Three decisions, and the third is the one that will be got wrong:

- **A blueprint is fixtures, ground, walls and paint, or it is a disappointment.**
  A copied aisle whose floor and finishes do not come with it pastes as shelving
  on grass. All four are already the four arrays undo diffs, so the shape of the
  clipboard is the shape of an undo step — which is a strong hint they should be
  the same structure.
- **It stamps what it can and says what it could not**, rather than refusing the
  lot. This is `canPlace`'s warn-don't-refuse rule and the wall drag's
  ran-out-of-money rule, said about a region.
- **Rotating a stamp is not rotating each fixture.** A block turned 90° has to
  rotate the *offsets* and then the facings, and doing only the second is the
  bug: it looks completely correct on a single shelf and shears every aisle.

Where it stops: no library, no saved blueprints, no sharing. One clipboard, in
memory, per session — the same call `undo` makes about persistence, for the same
reason.

#### 27. The overlay key

Hold Alt and every unit says what it holds — the item's own icon over the shelf,
the recipe over an appliance, the crop over a bed. Factorio's version of this is
the single most-used key in the game and it is *read-only*, which is what makes
it cheap: nothing here is a verb.

The argument for it is a shop that has got big. `homeShelves` gives every item
one home, and the whole point of that rule is that you can learn where things
live — but there is nowhere in the game that shows you the answer except by
walking the aisles and reading the goods, which stops working the moment a unit
is behind another one or is a freezer with a lid. The nearest thing today is the
Stock panel, which is a list, and a list is exactly the wrong shape for "where".

Two things it needs and one it does not. It needs to be a **hold**, not a toggle,
for the reason the design highlight is one: a mode that stays on is a mode you
forget you are in, and this one draws over the shop. It needs to answer for
`boh` units too, since a stockroom is the place you are most likely to be asking.
And it does **not** need new state on the wire: `stacks`, `recipe` and `crop_id`
are all in the snapshot already.

### Appliances are the one thing left, and that is step 12

An appliance is still priced by its own upgrade row, and it is not the scan:
`station-blender` sells one machine, so its cost is already a unit price and
nothing is being divided. What it means is that the palette builds its appliance
entries out of the *upgrade* table while everything else comes from the catalog,
which is one table too many.

Moving them across needs a piece per machine — `blender`, `coffee-machine`,
`toaster`, each naming kind `station` — and then `placeFixture` can read the
machine off the piece instead of off the placement, `buildTools` loses its
special case, and the upgrade rows become unlocks or go away. That is a content
migration with models in it, and doing it inside the ledger's retirement would
have made two risky things one commit.

---

## Build order

Sliced so the game is playable at every step. Steps 1–3 are the spine;
everything after is additive.

Built so far: **1 through 8.** They did not land in order — 6, 7 and 8 went in
before 4 and 5, which is worth recording because this list said they couldn't.
Step 7 was written here as depending on step 5 and did not need it: a prop that
never blocks needs no cell of its own. Check the dependency rather than trusting
the number.

1. **Edges exist alongside tiles, and are provably the same shape.** Add
   `shared/edges.js`: the edge kinds, the two arrays, `deriveEdges` (read a
   wall ring, write the equivalent loop of edges) and `computeIndoor`. Change
   no behaviour and remove nothing. A sweep asserts that across many seeds and
   fixture counts, the cells `computeIndoor` calls enclosed are *exactly* the
   cells `insideStore` calls inside. That is the whole point of this step: the
   new representation earns trust before anything depends on it.
2. **Flip to edges: generator, pathing, collision, renderer — together.** The
   wall ring goes, `compose()` stamps edges, `canStep` and the two `canStand`
   lines read them, `whatThisBlocks` floods through them, the renderer draws
   thin boxes. These do **not** slice apart: thin walls without edge-aware
   collision is a shop you can walk out of, and cell collision with edge walls
   is a dead tile of border inside every room. One commit, and the payoff is
   the two tiles of floor each way that the wall ring used to eat.
3. **The `indoor` mask replaces `insideStore`.** One function in
   `shared/build.js`, one derived array. L-shapes become possible here.
4. **Stamp once.** *Built.* `Game.freezeShell` turns every generated fixture
   into a placement the first time a world opens, and the size of the building
   becomes stored state (`world.shell`) instead of something re-derived. The
   generator then only ever re-applies what is already there.

   The part that is not obvious until you try it: the shell has to be stored, or
   nothing else works. With every fixture a placement the budgets are all zero,
   so the size search finds that a 9×9 holds everything it was asked for —
   nothing — and shrinks the building back to the minimum, stranding every
   placement outside it. The size of your shop is a fact about your shop, not a
   function of your shopping list. `space` upgrades therefore extend the stored
   shell east and south rather than re-centring a new one, because a stored
   shop's fixtures are absolute and nudging the west wall out moves the building
   out from under every shelf in it.

   `droppedPlacements` is retired *as something that happens*: it can no longer
   fire on a purchase. The mechanism stays as a backstop, because a wall you
   draw can still make a cell illegal.
5. **Things become a list.** *Built.* `T.SHELF`, `T.FREEZER`, `T.CHECKOUT` and
   `T.STATION` have left the tile vocabulary; a tile means ground and nothing
   else. Whether a cell is occupied is `layout.blocked`, a mask the generator
   derives from the fixture lists, and `FIXTURES` says `blocks` as a field you
   can read rather than as a set a tile enum happens to be in.

   The enum numbers are deliberately **not** renumbered. A live save holds
   `tiles` as raw numbers, and closing the gaps would turn every existing shop's
   floor into grass. Gaps cost nothing; a migration nobody writes costs a shop.

   A genuine deletion, which is what it was for: `removedTiles`, `baseTile`,
   `withTile` and `MODEL_REPLACES_TILE` all retired, because "what is this tile"
   and "what would this tile be with nothing on it" stopped being two questions.

   This was written as the thing that makes step 7 possible; it wasn't. What it
   actually unlocks is a prop that *blocks* — see the omissions above — and rugs,
   which need two things on one cell.
6. **Wall, window and door as build tools.** Drag corner to corner. The action
   carries two lattice points and a kind — a rect, never a tile list, because of
   the 4KB inbound cap.
7. **Kinds and pieces split.** `fixtures.kind`, the closed `BUILD_KINDS` set,
   `prop-floor` / `prop-wall` / `prop-ceiling`. `create_fixture` grows a `kind`
   argument. Decorations become authorable.
8. **Lights.** `emits`, the renderer, and the cap.
9. **Economy swap.** *Built.* `cost` is on the piece, the upgrade-payload scan
   is gone, the five fixture upgrades sell discounts instead of packs, `space`
   is the last upgrade that grants anything, and `world.fixtures` retired in
   favour of a recount over `placements`. See "Where costs come from" above for
   what was deliberately *not* done (unlocks) and why.

   Two things this step needed that were not in the plan. The **balance bot had
   to learn to build**, because the shop used to grow by buying packs from a
   menu and now grows by putting things down — a bot that never built would have
   measured a shop frozen at its opening-day shelving while buying discounts on
   fixtures it never used. And **`/regenerate?clearPlacements` needed a verb of
   its own** (`Game.reflow`): it used to get "put the shop back procedurally"
   for free, because the ledger knew how many shelves you owned independently of
   where they were, and with the shop *being* its placements, emptying the list
   and regenerating hands back an empty building.
10. **~~Camera occlusion.~~ Cancelled.** Built once, narrowed to proximity, then
    deleted as overkill — turning the camera is enough, and the fade cost more
    in draw-order complexity (see the translucency notes below) than it bought.
    Do not re-add it. The notes are kept as history, not as a plan.
11. **Fields.** *Built.* Fence and Gate are build tools, and the auto-bbox fence
    in `layout.js` is gone. Smaller than it looks and it took a set with it:
    `editedEdges` existed only so the generated fence wouldn't re-draw itself
    over fencing you had built on the same line, which is the shape of an
    argument you are losing. Nothing else read the fence — a fence never
    encloses, so removing it moves no `indoor` mask and no tile.
12. **Appliances become pieces.** The last thing priced off an upgrade, and the
    last place the palette reads a table that isn't the catalog. See above.
13. **Floors.** *Built.* A brush that paints an area, a `floor` kind that is
    ground rather than a thing, `surface` on the piece where a model would be,
    and `world.floors` as an overlay for exactly the reason `edits` is one. Not
    in this plan originally, and it should have been: step 3 shipped the half of
    "build your own shop" that decides what counts as inside, and this is the
    half that decides what you can put there. See above for the three decisions
    that kept it small.
14. **The yard stops being furniture.** *Built.* The bay and the drop-off become
    designs for the floor brush, `layout.floors` becomes `layout.ground`, and
    `freezeYard` marks a shop as seeded with a boolean rather than a count. The
    break area is the same step's third pad. See above, and step 9 of
    docs/workers.md.
15. **Staff-only ways through.** *Built.* A toggle on a doorway or a gate, stored
    as four more edge kinds, which makes `SOLID` the first rule in the game whose
    answer depends on who is asking. Additive and independent of 12 — nothing here
    touches the catalog. It grew **one way** in the building, which is the same
    idea pointed at direction rather than at who: see above for the pricing
    decision, the two warnings it fixes, and why "in" is read off the enclosure
    rather than stored.
16. **Picking several at once.** *Built.* Hold Shift to see everything of the
    same design, shift-click to add or drop one, and the fixture menu narrows to
    the standing decisions the whole selection shares — the shape, what it is
    kept for, the refill order, the shop hand, back-of-house. On the wire it is
    one message carrying `ids` and one re-flow (`Game.bulkFixtures`,
    `holdReflow`), which is the half of it nothing on screen can show. Additive
    and independent of everything above: no new kind, no new column, no
    migration. See above, and `verify:pick`.
17. **Painting the walls.** *Built.* A finish is a `surface` row like a floor,
    painted onto one SIDE of a wall — which makes it the fourth partition of
    `BUILD_KINDS`, since a face is half an edge and belongs to neither the
    fixtures nor the ground. The pointer picks the side (`pickFace`), a drag
    paints the run, and it is priced per face with half of what was there back.
    It never re-flows and is hung on the finished layout rather than handed to
    the generator, which is what makes "a colour cannot move a wall" structural
    instead of merely tested. See above, and `verify:paint`.
18. **The ground outside becomes content.** *Built.* `GROUND.lawn` — one row, no
    new tile value and no migration — plus `pattern: 'tufts'`, which is the
    second ground pattern that is geometry rather than a per-cell colour. It is
    the tail of steps 13 and 14 rather than a new idea: every other kind of
    ground became authorable there and grass was missed because it is the
    *default*, so nobody ever wanted a second one and found they could not have
    it. What made it urgent is that grass was not merely unauthorable, it was
    never drawn — `buildWorld` skipped tile kind 0, so the lawn had none of the
    jitter or baked light every other cell has. Carries the palette regroup
    (`outdoors`, because eight sub-tabs is a list rather than a choice) and the
    right-button scrape, which is `armEdgeRaze` said about an area — retired by
    step 19. See above for the unit rule a blade is measured in, which is the
    part that cost a round of play-testing.
19. **A modifier is the bulldozer.** *Built.* One modifier that means "get rid of
    what is under the pointer" whatever tool is armed — a fixture, a finish, a
    wall or a cell of ground — replacing the Demolish tool's monopoly on the
    first two and the two right-button razes on the last two. The right button
    goes back to meaning one thing in build mode: back out. Client-only: no new
    message, no server change, four existing ones sent from one aim
    (`razeAim`). It shipped on Shift, which took the multi-select off that key
    while the bar was up; step 23 moved it to Ctrl/Cmd and handed Shift back.
    See above.
20. **The curtain, which is a way through you do not open.** *Built.* See above.
21. **The roller door.** *Built.* See above.
22. **Taking it back.** *Built.* Ctrl+Z and Ctrl+Y over every build verb there
    is, plus a pair of thumb buttons for the device that has no Ctrl. A stack of
    diffs rather than of snapshots, because a fixture's stock is filed under an
    id a move re-mints and restoring the placement array would destroy it
    silently; the money reversed exactly and as a delta, because an undo you are
    fined for using is not an undo; and only a *press* opening a step, which is
    what keeps the generator, the balance bot, MCP and every sweep out of it.
    Additive: no new column, no new tile, nothing on the save. See above, and
    `verify:undo`.
23. **One meaning each for the two modifiers.** *Built.* Ctrl (Cmd) is the
    bulldozer and Shift is back to the multi-select with the bar up as well as
    down, undoing the one thing step 19 charged for. Client-only: no message, no
    server change, one flag split into two. See above for why the split by
    palette state was the wrong trade, and for the Mac secondary-click trap.
24. **Q is the pipette.** Point at anything and arm that exact piece, variant and
    facing. The smallest of the four below by a wide margin — nothing on the wire
    and nothing on the server. See above.
25. **Any fixture drags out in a row.** The conveyor run drag widened to every
    kind, which is a guard rather than a second message. Needs one flag saying
    whether a corner turns the thing or keeps the armed facing. See above.
26. **Copy and paste a selection.** Ctrl+C over the multi-select, Ctrl+V under
    the pointer, the whole stamp inside one `undoStep`. Depends on 22 in
    practice rather than in code: a paste you cannot take back in one press is a
    paste nobody uses. Fixtures, ground, walls *and* paint, or it stamps
    shelving onto grass. See above.
27. **The overlay key.** Hold Alt and every unit says what it holds. Read-only,
    no new state on the wire, and a hold rather than a toggle. See above.

---

## Gotchas found while prototyping

Each of these is a real finding from the mockup or from reading the code, not a
guess.

- **A piece that resolves to its kind passes every test you would think to
  run.** Every fixture in the game came from a row whose id *is* its kind, so a
  lookup that silently falls back to the kind is indistinguishable from a correct
  one until somebody authors a second design — and then it presents as "my new
  shelf looks like the old one", which reads as a modelling mistake rather than a
  wiring one. `verify-catalog` authors a second shelf with a deliberately
  *shorter* tier ladder for exactly this reason: reading the wrong row is then a
  number that differs, not a picture that happens to match. It caught the layout
  generator dropping `piece` on the way through, which nothing else would have.

- **The ledger keyed fixtures by kind and props by piece, and that asymmetry was
  load-bearing right up until it wasn't.** `world.fixtures` was the generator's
  shopping list — `regenerateLayout` passed `shelves: fixtures.shelf` and
  expected one placement per unit owned — so a second shelf design counted under
  its own name would have had no budget asked for it, and `compose` would drop
  the placement on the next re-flow, one shelf at a time, silently. Props had no
  budget because nothing procedural places one, which is exactly what freed them
  to count by piece.

  Step 9 retired the ledger and the asymmetry went with it: nothing is asked of
  the generator any more, so `countKey` counts everything by piece and the
  palette can finally say how many of *this* design you own. The claim the old
  key was protecting is still the claim — a second design has to survive a
  re-flow — and `verify:catalog` now asserts it directly, three re-flows deep,
  rather than by asserting the mechanism that used to guarantee it. Which is the
  better test anyway: it would have caught the original bug too.

- **Pathing is strictly 4-way.** `NEIGHBOURS = [[1,0],[-1,0],[0,1],[0,-1]]` in
  `server/sim/pathing.js`. This is the single luckiest fact in the migration:
  edge walls only get nasty with diagonals, where you have to stop actors
  cutting the corner where two walls meet. With 4-way there is no corner case —
  a step is legal iff the destination cell is standable *and* the one edge
  between them is passable.

- **Player collision is already axis-separated**, which is exactly what edges
  want:
  ```js
  // stepPlayers, in server/sim/index.js
  if (this.canStand(nx, p.z)) p.x = nx;
  if (this.canStand(p.x, nz)) p.z = nz;
  ```
  Those become edge-crossing tests. It's a *better* test than the one there now:
  a boundary crossing rather than a cell lookup, and the player stops being able
  to stand half-inside a wall, which today they can.

- **The camera rotates, in four quarters.** `rotateView` / `camQuarter`. The two
  wall runs between camera and interior hide the shop, so they fade to ~25%
  opacity — full height, not cut down, so the building keeps a complete outline
  and you can still see where its windows and door are. Recompute on turn, never
  per frame.

- **Translucent walls need back-to-front draw order.** In three.js that means
  `transparent: true` plus depth sorting, which means faded walls **cannot stay
  in the same `InstancedMesh` as opaque ones**. Practically: two instanced
  meshes per wall kind, re-partitioned on each quarter turn. Cheap, but it is a
  real change to `buildWorld`, not a material flag.

- **A body mesh plus a cap slab double-blends when translucent.** The renderer
  builds furniture as a box plus an inflated contrasting top (the `TOPS` map in
  `buildWorld`, [`client/render/scene.js`](../client/render/scene.js)). Opaque
  that is invisible overdraw; at alpha the two blend over each other and the
  tops go muddy. The body has to stop drawing its own top face wherever a cap
  covers it.

- **A doorway is part of the enclosure.** See above — this one actually bit in
  the mockup and read as "the entire shop is outdoors".

- **`simulate` comparability.** Once layouts are stored rather than generated,
  balance runs stop being seed-reproducible the way CLAUDE.md leans on.
  `simulate` must keep generating a fresh starter shop from seed and never read
  the stored one — otherwise every number after this measures your architecture
  instead of your economy.

- **One door becomes several, and it is now two things not one.** Since
  `c632de0` a layout also carries `approaches` — map-edge tiles paired with a
  point off the grid — and `spawnCustomer` walks a shopper from an approach to
  `layout.door.x, layout.door.z - 1`. So entry is a *route*: approach → door.
  `approachList()` filters map-edge spots by walkability and knows nothing about
  which door it is feeding. With several doors, each wants the approach nearest
  it, or everyone crosses the map to use the front one. Small, but it sits in
  the sim's hot path. (`addAwning` used to hardcode the single south-wall door
  alongside it. It is gone: the awning is an ordinary `prop-floor` piece the
  save stamps once over the door — see `freezeAwning` — so a second entrance
  gets its own shop front by somebody placing one, which is the whole point.)

- **Fixture ids already live in two namespaces** (`shelf-p0` from the generator,
  `fx-N` from the player) and must never collide. A things-list makes this
  easier, not harder — but step 4 is where the generated ids stop being minted
  fresh on every re-flow, so that is the moment to check it.

---

## Open questions

- ~~**Does a wall cost per edge or per run?**~~ **Answered: per edge.** It
  already was — `buildEdge` charges inside the segment loop — and this is the
  decision to keep it, because the alternative is worse in a way that isn't
  obvious. Per run makes a long wall cheaper per metre than a short one, so the
  cheapest way to build a shop becomes one enormous drag, and the pricing quietly
  argues against the L-shapes and annexes that enclosure exists to allow. Per
  edge also makes the swap arithmetic fall out for free: a window over a wall
  charges the difference, knocking through refunds `FIXTURE_REFUND` of whatever
  was there, and none of that needs to know what a "run" was.

  What the run *is* for is the gesture. A drag is one action, it is validated as
  a whole (no single segment of a wall across the aisle seals anything), and if
  you run out of money halfway it builds what you could afford rather than
  refusing the lot — losing a whole drag to the last segment being a dollar
  short is the kind of thing you cannot see coming. `verify:economy` pins the
  pricing: a five-segment run costs five segments.
- **Do rooms mean anything?** The enclosure fill can cheaply label *distinct*
  enclosed regions, not just enclosed-vs-not. That would give "the cold room",
  "the back office" as addressable things. Worth having, not worth building
  until something wants to read it.
- ~~**Can you demolish a wall that would strand a fixture?**~~ **Answered: yes,
  and it now says so — but not in the way the question assumed.** Removal
  genuinely cannot strand a fixture the way placement can. A hole only ever
  opens the way through, so every reachability check `whatThisBlocks` runs is
  vacuous for a demolition, and that is why the early return saying "taking
  something away can't strand anybody" was correct as far as it went.

  What it misses is *enclosure*. Since step 3, "indoors" means whatever the walls
  close in — so knocking one segment out of the shell breaks the loop, the fill
  walks straight in, and every shelf in the building is outdoors without one of
  them moving. That is the same class of answer as walling a shelf in: a
  consequence you are told about and allowed to cause, not a refusal.

  So `canPlaceEdges` now runs `whatThisUnroofs` on both directions, and it is
  symmetric — placing walls can *roof* a plot, which strands it just as surely,
  because nothing grows indoors. Two details that matter: it reports only what
  the action **changes**, or a shop that already had a shelf on the patio would
  warn about it on every wall you ever drew; and it stays `ok: true`, because
  putting your shelving out in the weather is a move the sim copes with.
- **Roofs.** Nothing here draws one, and the 45° camera means you probably never
  want to. But "enclosed" currently implies a roof that is never modelled, and
  someone will eventually ask why rain doesn't come in.
