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
  with the day (`DAY_FLOOR`), so a lamp is worth most at dusk. That is one half
  of "indoors is not outdoors" below; the other half — the room keeping a light
  of its own once the sun is off it — is built now, so the sentence that used to
  live here ("the lamp dims and the room does not") no longer holds. If lighting
  is ever meant to *matter*, the hook is the tag system, not
  `if (piece.id === 'lamp')`.

One thing worth knowing that wasn't obvious: three's falloff makes `intensity` a
power rather than a brightness, so a lamp authored as "1 over 4 tiles" is nearly
invisible unless it is scaled by its own range squared. That scaling lives in
`Lights.update`, so an author writes the number they mean.

### Indoors is not outdoors

**Built, except the windows.** There is already a sun: `scene.js` lerps
`SUN_HIGH`→`SUN_DUSK` and `FILL_HIGH`→`FILL_DUSK` across the day, so the world
visibly opens and closes. That is a single global term applied to everything,
indoors and out alike — which is why a shop at dusk used to look like a field at
dusk, and why the building read as *switching off* at teatime rather than as
evening coming on. A room is not lit by the sky; it has a ceiling.

The `indoor` mask makes the split answerable for free:

- **Outdoors** is lit by the sun. It gets dark at night, and nothing you buy
  changes that. Farm work at dusk is meant to be gloomy.
- **Indoors** keeps a lift of its own that grows as the daylight goes —
  `INDOOR_LIFT` in `lights.js`, zero at noon, multiplicative on the surface's own
  colour, and folded into the bake `bakeInto` was already doing for lamps.
- **Windows earn their keep.** Still proposed. A `window` edge letting the sun
  into the cells behind it is the difference between a windowed frontage and a
  bunker, and it is what would make an aesthetic choice a functional one.

Two things the build settled that the sketch had the wrong way round.

**The floor is generous, not stingy.** The plan here was a *low* indoor floor, so
that buying lamps was what kept you trading in the evening. Played, that is a
shop you cannot see for two hours of every day, and what it reads as is a bug in
the renderer rather than as an unlit building — nobody looks at a dark room and
thinks "I should go shopping". So the lift is set where the room still reads on
its own and a lamp *sharpens its own corner* instead of rescuing the building.
`DAY_FLOOR` already gives a lamp its moment; it did not need this as well.

**It is TWO terms, because the renderer has two lightings.** Everything static
was moved onto `BAKED_LAYER` so the eight real lamps could not light it twice
(see `Lights`), which means the shop is lit in two halves and the ceiling has to
be added to both:

- the **bake** (`INDOOR_LIFT`) — floor, walls' faces, fixtures, belts: per cell,
  from the `indoor` mask, redone when the layout changes and on the hour, exactly
  as the sketch wanted. Not per frame, and not a shadow map.
- the **fill** (`ROOM_FILL` in `scene.js`) — one small warm ambient on layer 0,
  which is precisely what is left there: the movers. People, crates, and the
  goods on every shelf are rebuilt out of colours nothing baked, so left out of
  this they would be silhouettes standing on a lit floor — a worse-looking bug
  than the dark room, and one that only appears once the first half works.

The fill cannot tell inside from out, and that is the known cost: a shopper on
the road at dusk takes the same lift as one at the till. It is small enough to
read as spill from the shop windows. The apron — the big ground box that runs
past the last tile — had to be moved onto `BAKED_LAYER` to keep it out of the
fill, or the world gets a bright band around a dark lawn, which is the one part
of this an eye catches instantly because the seam is a straight line the length
of the map.

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
than tipping the excess into a crate is deliberately *not* the call
`removeFixture` makes, and the line between them is what the press leaves
behind. A removal takes the fixture away, so the goods have nowhere to be and a
crate beside it is the only lossless answer there is. A downgrade leaves the
unit standing, so tipping part of a shelf out is a verb that quietly rearranged
your stock and left the thing it rearranged sitting there looking untouched —
you would find the crates later and have nothing to connect them to.

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

  **And LAYING it, which was missing until step 31 and had to be reported from a
  screenshot.** The check sat in the eraser's branch alone. A pen stands on
  grass, so the "only ever over ground" refusal never fired — grass is exactly
  what you may paint over — and `blocked` was never consulted: one press of a
  paddock over your own hen house stamped the tile, the re-flow dropped the pen,
  and it was refunded. Nothing reads as stolen and undo cannot help, because what
  an undone ground step restores is the ground rather than the shed placement. The
  test is whether the **tile moves** rather than which way the brush is pointed,
  so an aisle can still be re-tiled under its own shelving.

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

> **Amended — see "A look goes under a job" below.** A cell holds two answers
> now, and the four objections above are the reason it is not the second layer
> this paragraph turned down: still one array, still one entry per cell, still
> one validator and one re-flow, and the precedence question is answered by the
> partition that was already in the table — `k` is the job and is still the only
> thing that decides the tile. What changed is that a *look* painted onto a job
> stopped being a rival to it. What forced it is in that section: a floor dragged
> across your own stockroom took the storage away, silently, because painting
> over a pad is also how you MOVE one.

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

A marquee — *until step 27b, which built it.* It was named here as the obvious
next gesture and as a separate one, and both were right: it needed its own drag
path in `pointerdown` beside the wall, brush, lift and camera drags, and a
screen-space test against the art rather than the tile. Everything else was
already in place — the set of rings, the narrowed menu, `ids` on the wire — so
it was a gesture rather than a feature. See below.

#### …and the three verbs that came back

*Built (step 27b).* Remove, Upgrade and Downgrade were all in that paragraph on
the grounds that they spend or refund real money once per fixture, and the
argument was wrong about all three in a way it is not wrong about the other two.
The line it should have drawn is this: **a verb stays single when six of it
would be six different things, and belongs to the selection when six of it is
one thing said once.** Move fills your hands with one fixture and Rotate turns
each into its own corner — those really are six decisions. "Get rid of that
aisle" and "make my freezers better" are one decision each, and refusing them
left the shift-click doing half a job.

The ladder is the sharper of the two, because a rung is priced per piece and per
tier: six units standing at three different tiers is six different prices, and
each climbs its **own** ladder rather than all of them landing on one number.
Whichever is already at the end of its ladder is simply not in the batch, the
way an unemptied shelf is not in a bulk Remove. Affordability stays inside
`upgradeFixture` against the running cash, so a batch that outspends the shop
upgrades what it can and reports the rest — the alternative is pricing it up
front and refusing the lot over the last unit. The button greys on the
**cheapest** rung for the same reason, or it is dead over a press that would
have worked.

`verify:pick` §8 pins the money, which is the half nothing on screen can show: a
batch that charged the first unit's price six times comes back with six upgraded
fixtures and a shop that is quietly poorer, with nothing to compare it against.
Its control is the round trip — up and back down must always lose money, or a
selection is a way to print it two keys at a time.

**And the second shift-click opens the menu**, which is the half that made all
of the above reachable. Every bulk verb lives in the fixture menu and there was
no press that got to it with a selection intact: shift-click is consumed whole
(`pointerdown` returns before the tap, or the release would walk you to the last
shelf you picked), and the ordinary two-press route runs through
`selectFixture`, which clears the selection on its way. So six shelves picked
was six shelves you could look at and not act on, and what that reads as is the
popover refusing to open.

At **two** rather than at one, and the line is the existing rule rather than a
preference: with one picked this is an ordinary selection and "the first press
picks, the second opens" still holds; with two, the menu stops being about a
shelf and becomes the only place the selection can be used, so waiting for a
press that cannot be made is waiting for nothing. On a phone it is the opposite
call for a reason that is about pixels rather than about gestures — the panel is
the whole screen there, so opening it on the second pick would cover the aisle
you are still picking from. The moment there is **letting the latch go**, which
is the same sentence said by the device that has one.

#### The box you drag round an aisle

*Built (step 27b).* Shift-click adds one; shift-**drag** adds everything you drew
round. It is one press with two outcomes and they cannot be told apart on the way
down, so the box starts on every shift press and the release decides which it
was by how far the pointer travelled — under `MARQUEE_SLOP` it is the click it
always was. The old code answered on `pointerdown` and therefore had nowhere to
put a drag at all.

Four decisions in it.

It is a **screen** rectangle and `Scene.fixturesInRect` tests against the ART,
which is the same distinction `pickFixture` exists for: at this camera a shelf is
drawn most of a tile up-screen of the ground it stands on, so a box tested
against tile centres takes in the row behind the one you dragged over and misses
the one you did. Each candidate's screen rect is its eight projected corners
rather than two, because a box in the world is a hexagon on the screen — the
measurement `nearestBoard` already takes.

It **intersects** rather than contains. Demanding that a whole shelf fit inside
the box would mean the units at the edges of your drag silently did not come,
which reads as the marquee missing things rather than as a rule.

It **adds**, always, and never replaces. Shift already means "and this one too"
on a click, and a drag under the same key that threw away the five you had picked
by hand would be one key meaning opposite things at two speeds. So it calls
`togglePicked`, which also makes dragging over the same aisle twice the way to
take it back out.

And it settles **once** (`pickMany`). Eleven shelves in one drag must not be
eleven redraws of a menu that is every item in the catalogue long, nor eleven
rebuilds of the marker set — `bulkFixtures`' argument, said on the client's side
of the wire.

The one thing it may not do is begin on bare floor outside build mode. That is
the old `if (ui.paletteArmed) return` in a new job: a shift-click that missed
everything was already spent while building, and outside the mode it fell through
to walking — which is Shift's other job on that key (sprint), and
shift-click-to-run-over-there is a gesture people have.

#### Remove, and the guard that reads the shop

*Built (step 27b).* Remove was in that paragraph too, on the same argument, and
the argument was wrong about it in a way the other four are not. Rotate turns
each fixture into its own corner and Move fills your hands with one thing, so
each of those genuinely means something different about six units than about
one. Remove means exactly the same thing six times — and it is the press a
selection is *for*: you shift-click an aisle because you want the aisle gone.
Refusing it left the gesture doing half a job, six opens and six presses, with
no way to say the thing you had just finished saying with the pointer.

So `build-remove` is the second bulk verb that re-flows, and the shape is
`build-style`'s exactly: `targets` for who, `bulkFixtures` for the loop, one
`undoStep` around the batch, one `sendLayout` at the end. The money is what the
fold's line reports rather than the count, because the money is the half of a
removal nobody can see afterwards — the fixtures are gone either way, and "six
back" says nothing about whether that was $30 or $900.

**The trap is a guard that reads the SHOP rather than the unit**, and there is
exactly one: you may not tear out your last till. What makes `holdReflow` safe
for every other bulk verb is that none of them moves a tile, so each looks its
own fixture up against a layout that is still true — and a removal makes that
layout stale by construction. Three tills picked in a shop with three each see
three still standing, all three pass, and you are left with a shop that cannot
take money. Nothing about it is visible: the tills are gone, which is what you
asked for, and what you find out later is that shoppers queue at nothing. So the
hold carries `gone` — what the deferred re-flow has not caught up with — and the
guard counts against it. Its pair is that the batch does not simply refuse
either: two of the three must go, or the guard is a shop front you can never
rearrange. `verify:pick` §7 pins both, plus the control that a lone last till is
refused exactly as it always was.

The menu square says the same thing the server will do rather than a nicer
version of it — the green-ghost rule, wearing a price. It counts the tills
against the *selection* the way the server does, greys only when every one of
them is blocked, and the figure on it adds up the ones that can actually go.
`Del` is on the button beside `M` and `R`, for the reason every key in this game
is on its button.

**And a phone has no Shift**, which is the half worth writing down. Undo at
least had a desktop spelling a thumb was merely missing; picking several was a
feature that did not exist on the device at all, and bulk Remove went with it —
so the whole of the above would have shipped unreachable on the one screen where
every build press is a fingertip. `#pickbtn` is the answer and it is a **latch**
rather than a modifier, because that is what a modifier becomes when there is no
second hand free to hold one: while it is down a tap adds or drops a fixture
instead of opening it, which is `pointerdown`'s Shift branch reading
`ui.pickLatch` beside `e.shiftKey`.

Three things fall out of it being a latch rather than a key. It is written
**beside** `shiftDown` and never into it — that flag is also the sprint key and
is overwritten by the next `pointermove` off the event, so a latch stored there
would be both a run and a flag that cleared itself the moment your finger slid.
It has to be **visible**, so it is the one button in that stack with an on look:
a latch you cannot see the state of is a mode, and a mode nothing announces is
the complaint `paletteArmed` settles for the palette. And it is **let go of by
leaving build mode**, or the shop next time you open the bar is one where
tapping a shelf mysteriously does not open it, with the button that explains why
off screen.

`#delbtn` sits under it, and what is two buttons above it is Undo — deliberately,
since tearing out six shelves is the most expensive press on that screen and the
way back from it belongs under the same thumb. It is dimmed rather than hidden
with nothing picked, which is undo/redo's call made for a sharper reason: it is
the button a selection is *for*, so one that appeared only once you had picked
something would be the thing that tells you the latch worked arriving after you
needed to know.

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

### The head line, and the two glazed doorways

**Built** — step 30, and it is one number and a family. The number is the
interesting half, because it is what the family stands on.

**A wall grew and took every opening with it.** Every way through in
`edgeBands` was written as `style.h - <a lintel's worth>`, which reads as "just
under the lintel" and is the same sentence a window's `head` is written in.
That sentence is right about a window — glass should run up to the top of a
taller wall, or raising it leaves a hand's width of brick over every pane — and
it is wrong about a doorway, because a doorway's height is a fact about the
person walking through it and no amount of masonry changes it. So raising
`WALL_H` from 1.75 to 2.1 raised every door, gate, arch and shutter in the game
by a third of a tile, and what that draws is not a taller building: it is the
same building with smaller people in it. It reads as the characters having
shrunk, which sends you to the wrong file.

`HEAD_ROOM` is the fix and it is `GROUND_LINE`'s mirror — the line an opening's
head stops at, absolute, so the **lintel** thickens as the wall grows and the
hole does not. 1.6 against a character who tops out at 1.32 is a doorway about a
fifth again as tall as the people using it. It is a **ceiling and not a
height**: `headOf` takes the lower of it and "as high as this boundary can span
one", so a gate cut in a fence half a tile tall is untouched.

Two things fell out of it that are worth more than the number. The first is that
`WINDOW_HIGH` had to be re-derived: both its numbers hung off the wall top, so
with a door head at 1.6 and a high sill at 1.42 the strip started *below* the
door beside it and the two overlapped — two openings in one wall disagreeing
about their own head line, which reads as one of them being misplaced and gives
you no way to tell which. Its sill is `HEAD_ROOM` now, and every glazed thing in
the shell caps at one `GLASS_HEAD`. Nearly-lining-up is the bad case: a
two-centimetre step in a header reads as bad bricklaying rather than as art that
is out.

The second is that once the head line is a constant, **a doorway and a high
window fit together** — which is the whole of the second half of this step.

**The glazed doorway is the first edge with a rule AND a look**, and it is
`WAY_LOOKS`. §21 above decided the roller door was a *base* rather than a look
on the doorway, and wrote down the test: a family is the set of things that swap
for a **refit**, so two things belong in one family exactly when swapping them
moves no number. A $34 doorway for a $46 shutter is a purchase, so no look axis.

This is the first thing to fail that test the other way. A fanlight over a door
and the same door glazed to the lintel in a slim frame are the same hole, the
same enclosure, the same rule and the same glass — $48 either way, which is a
doorway plus what glass costs over the wall it replaces ($26 − $12). By the
test's own terms that is **one family with two looks**, so the axis is what the
test asked for rather than a convenience. And the family is still separate from
`door`: glass over your doorway is a purchase, which is what stops the look axis
being a way to get glazing free.

The pairing with `GLAZING` is the point rather than a flourish. `transom` is
`WINDOW_HIGH` said about a doorway and `shopfront` is `WINDOW_FULL` said about
one, and all four measure off the one head line — so a run of frontage with a
door in the middle of it draws as a single band of glass. Authored apart they
would each be nearly right, which is the failure above with a door in it.

**The glass is never in the hole**, and that is §21's "there is no shut one"
arriving in a place where it bites harder. A pane drawn across a way through is
a kind the table calls passable and the picture calls solid — the disagreement
every green-ghost bug in this codebase is made of — and here it arrives as a
shopper strolling through plate glass while looking entirely deliberate. Glazed
cheeks down the two jambs were built and thrown away for the same reason: at
this camera a pane a twelfth of a tile wide either side of a doorway does not
read as a frame, it reads as glass across the opening.

So what separates the two looks is the **frame**, which is `TRANSOM_BAR` and a
thickness. A bar under the pane reads as a traditional light over a door; no bar,
in a wall 0.13 thick against the masonry's 0.17, reads as one sheet of glass.

**What it cost elsewhere was one menu.** `showEdgeMenu` was one row of exclusive
squares for five families, because no edge had ever chosen two things. Two rows
rather than eight squares, since the axes are independent — a staff fanlight and
a staff shopfront door both exist — and eight squares that are really 4×2 is a
menu you have to read twice to find out it is not offering eight things. The trap
underneath it is that `kindFor` now reads the axis it is *not* setting off the
edge in front of it: press Shopfront on a staff entrance and the rule has to
survive. It would not say if it did not — a glazed door thrown open to the town
looks exactly like a glazed door, and the failure arrives days later as shoppers
in the stockroom, pointing at the pathing. `verify:doors` §11 pins both
directions, because one function reads both axes and can drop either one.

### The arch, and the three ways to be a fence

Two additions in one step, and the reason they belong together is that they are
the same argument arriving from opposite ends of the wall.

The **archway** is a way through with nothing in it. Every fact the sim has about
it is a doorway's: it is in `ENCLOSING` (leave it out and an arch between the
shop and the stockroom takes the roof off both), a shopper crosses it exactly as
they cross a doorway, and it is signable. So what you are buying is *entirely*
the picture — which is a sharper version of the roller door's problem, because a
shutter at least has gear on it and an arch is absence with a particular shape.
Hence the corbelling: three steps a side under a thin header, closing in as they
rise, because an arch's opening is widest at the springing and narrowest at the
crown and drawing it the other way up gives you a funnel. It is *stepped* rather
than curved for the reason everything here is a stack of boxes — a half-tile
radius at this camera is fourteen pixels, where an arc and a chamfer are the same
three greys.

Two things about it are decisions rather than defaults. The springing courses
carry **no colour of their own**, unlike the shutter's coil and the curtain's
strips, so an arch in a painted wall is painted — which is the whole reason
anybody builds one. And `WAY_RULES.arch` is two rules rather than four: an arch
between the shop and the street genuinely has an inside and an outside, so the
doorway's reason for refusing one-way does not apply, but the curtain's does — a
hole with nothing in it has no way of *showing* which direction it lets you go,
and a rule with no picture is a rule nobody can find again.

`FENCING` is the other end. A fence was the one edge in the game with no family:
one look, nothing to choose. Everything a player wants instead of it — a hedge
round the farm, a rail along the forecourt, a low wall between the aisle and the
café — is the same edge with different stuff in it, so these are `GLAZING`'s
argument said about a boundary. Looks, not kinds. One price, so choosing a hedge
is never a balance change and `simulate` never runs over a picture; free to swap,
so changing your mind about the frontage costs nothing; and **none of them is in
`EDGE_CHARM`**, which is the one that took thinking about. A hedge is prettier
than a panel and worth exactly the same to the town, because charm on one look
and not another is a knob wearing a colour — and pricing the whole family for
charm would silently rebalance every fenced farm in existence.

The looks are on the bar in two different places, and that is deliberate: a hedge
and a railing sit with the fence under Farm, a low wall sits with the walls under
Building. Where a thing goes on the palette is a fact about what somebody has in
mind when they reach for it, not about which table it is in — the same call
`road` and `path` made when they left Floors. They are still one family, so
tapping any of the four offers all four.

One consequence falls out rather than being ruled, and it is the most useful
thing about the set: a **low wall takes paint** and a hedge and a railing do not.
`buildEdges` skips any band that already carries a colour of its own, so it is
enough that a hedge is green and a rail is grey. Nobody paints a hedge.

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

*Built — steps 24 to 27, except the one thing named as out of scope under 26.* Undo made the point that build mode is the part of
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

*Built.* Point at anything in the shop and press Q: the palette arms *that* piece, that
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

What it cost is not what the plan said. The ladder had to be **shared with the
bulldozer** — `whatsThere`, split out of `razeAim` — because "what is that" and
"get rid of that" are one question and two verbs, and two ladders would be two
answers to it: Q copying the wall while Ctrl demolishes the shelf in front of it
is not a bug anybody would find by reading either function. The one place they
differ is the ground rung, and the difference is real rather than an accident:
the pipette wants a bare floor cell named, and the bulldozer wants to know
whether there is anything on it worth taking up. So `canPaintGround` is asked by
`razeAim` and not by the shared ladder.

The other cost was the facing. `selectBuildTool` resets the angle and restores
whichever shape you last used for that piece — both correct for a design picked
off a list, and both exactly wrong for a decision you are pointing at — so the
facing is written after the select and **pinned**, or `faceAlong` re-derives it
on the next frame and Q reads as copying everything but the rotation.

#### 25. Any fixture drags out in a row

*Built.* The conveyor run drag is written (`beltRunCells`, `showBeltDrag`, `build-run`),
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
this is a widened guard rather than a second message. `beltRunCells` was not,
and is `runCells` now: the name was the last thing in the layer still claiming
this was about belts.

One thing was decided in the building that the plan did not name, and it is what
keeps drag-to-move alive. A conveyor claims the press **wherever it lands**,
because starting a drag on a run you already own is how you extend one (see the
tail-aiming in `Game.buildRun`). Everything else claims it **only over bare
ground**, because `drag.lift` is a press that landed on an existing fixture — so
a shelf tool that swallowed those would mean arming any tool at all silently
disables dragging things about, in the mode whose whole job is rearranging.

#### 26. Copy and paste a selection

*Built, without rotation.* The multi-select is built and holds a list of fixture ids; a placement is plain
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
reason. **And no rotation**, which was decision three above and is deliberately
left undone rather than half-done: turning a stamp means rotating the offsets
*and then* the facings, and an `h` wall becomes a `v` one, which is the part that
cannot be checked by eye at all. It is step 28.

Two things landed differently from the plan, and one of them is a bug the sweep
caught the day it was written.

The clipboard lives on the **shop** rather than on the client, and the reason is
the 4KB inbound cap: a blueprint is four layers, which for a stockroom is
comfortably past it. So `build-copy` sends the ids you had picked, `build-paste`
sends the cell you pointed at, and the thing itself is derived server-side from
state it already holds — `build-edge`'s rule (send the ends, re-run the
generator) said about a region. The client keeps a *second*, fixtures-only copy
for one purpose, the ghost, and that copy decides nothing: a paste with no
preview is a stamp you aim by faith.

**A selection could not say how far it reached, and that is what dropped the
pads.** The first two decisions above are in tension the moment you copy a
*room*: a blueprint is four layers, and the box it was gathered from was the
bounding box of the fixtures you had picked — because a selection is a list of
fixture ids and ground has nothing to be picked *by*. It has no id, no record and
nothing to hang a ring on. A room's ground is exactly what lies between and
beyond its units: a stockroom is shelving round the edges and Storage painted out
to the walls, and a break area has no units in it at all. So the layer that makes
a walled annex a room was the one layer a stamp of a room could not carry, while
the other three arrived perfectly — which reads as the pads simply not being
part of the feature.

The marquee is the answer, because it is a *region* whichever end you read it
from. It hands over the four ground-plane corners it covered, `quadCells`
(`shared/build.js`) turns those into squares on the server, and the copy is
gathered from that region **and** the fixtures' own box — the union, so
shift-clicking two units on either side of a room still copies what is between
them. Four things about it:

- It is a **quad and never a tile rectangle**. The camera is at 45°, so a square
  dragged on screen lands on the floor as a diamond, and the axis-aligned box
  round that diamond is very nearly twice the area — a region taken from it comes
  home with the aisle next door.
- The **anchor moves with it**, and that is the half that would fail silently.
  Every layer is stored relative to the top-left of the region, so a client still
  anchoring on the top-left of the *fixtures* draws a preview sitting up and left
  of where the stamp lands, by however far the drag reached past the shelves. A
  ghost honest about what will be built and wrong about where is worse than none.
- **No region is the old behaviour to the cell**, which is the control: a
  selection you clicked together rather than dragged sends no corners, and the
  copy is the fixtures' box exactly as it was.
- **The shell's own ground stays behind**, the way the shell's own walls already
  do. `freezeYard` writes a pad with no `piece`, because nobody bought it and
  there is no catalog row to name for one — and passed on as an empty piece that
  is the *bulldozer*, so a copied delivery bay would paste as a hole scraped in
  the destination's floor.

**And what a copy carries, a remove takes.** Copy-paste is half a gesture: the
one people make is *copy the room, stamp it down the other side, delete the
original*. Remove had always been a fixture verb, so the third press took the
shelves and left everything the copy had carried standing exactly where it was —
floor still painted, pads still pads, walls still up — and what that leaves is a
room-shaped stain you scrub by hand with the eraser. So `removeSelection` takes
the region too, through the same `selectionRegion` the copy reads, in the reverse
order a paste lays it: fixtures, then paint, then walls, then ground, because
each is a precondition of the next and `canPaintGround` refuses a cell with
something standing on it. The refunds go through the ordinary verbs and never a
rate of its own, so a copy-and-delete circuit always loses money.

`selectionRegion` is **one function for exactly this reason**: a remove that
reached a cell shorter than the copy leaves the same stain in a smaller shape,
and two spellings of "which cells" is how that happens. The sweep asserts it as a
comparison — what `copyFixtures` says it would carry, against what the remove
took — rather than as a count either could satisfy alone.

The region is also the opt-in, and it is doing real work: a selection clicked
together has no corners, so Remove is the fixture verb it always was, and only a
box you dragged means "and the ground under it" — which is what a box means in
every editor there has ever been.

And **`holdReflow` may not wrap the whole paste**, which is the opposite of what
every other multi-fixture verb in this file does. That hold is safe "because
nothing between the verbs reads the layout", and for a run of belts it is true —
each cell is the same question about a different square. A paste is the one
caller where it is flatly false: every layer is a precondition of the next, and
`canPlace`, `canPlaceEdges` and `canPaintFaces` all read a layout the hold leaves
as it was before the first cell went down. Held around the lot, a stamp of an
aisle onto bare grass refuses every shelf in it — the floor is still pending —
and reports "none of that would go there" over ground it laid a moment earlier.
So the **layer** is the boundary: four re-flows for a stamp of twenty things
rather than twenty, without the part that makes the ordering a lie.

#### 27. The overlay key

*Built.* Hold Alt and every unit says what it holds — the item's own art over the shelf,
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

**It was built twice, and the first one is the useful half of the story.** The
obvious readout is the item's own model in `buildBubble` — the thought bubble a
shopper already thinks in, already billboarded, already drawn from the same art
the heap on the shelf is. Right instinct, wrong readout: three loaves, three
bottles and three jars are three pale shapes half a tile across at this camera,
inside the same white sphere. You could see there was *something* over every unit
and not what, which is a readout that answers the question the key does not ask.

What it is instead is `setBoardTip` — the hover card, said about the whole shop
at once. That card already answers "what is this heap, how much of it, what does
it cost", which is exactly what the overlay asks of every unit, and it has the
one thing the bubble could not have: a **name**. The cards share `#boardtip`'s
own rules, so a change to the hover card cannot leave the two looking like
different kinds of thing.

Being DOM rather than world, it is pinned by `scene.worldToScreen` **every
frame**, because the camera rides the player and a card placed once slides off
the unit it names the moment anybody walks. That is the one cost, and it is paid
by a key: what changes per frame is two numbers of `transform`, so the content —
which includes an `innerHTML` of the item art — is written only when a card's own
signature moves. Thirty cards re-parsed sixty times a second is the version of
this that reads as the shop stuttering when you hold a key.

**The card is per UNIT, and it was per BOARD first — which is the second useful
half of the story.** The argument for a card per board is sound and is still the
reason the grouped card has rows at all: a shelf holding three things is the case
the whole overlay is for, and one card naming one item would answer "which of
them" with whichever the snapshot listed first — wrong two thirds of the time and
looking right. What that argument does not decide is the *size* of the answer.
Drawn as three full-size cards spread sideways to clear each other, one unit's
readout is several times wider than the unit, so on the three-tile aisle pitch a
generated shop uses they overlap their own neighbours and then the units either
side — and a card sitting over the shelf next door does not read as ambiguous, it
reads as that shelf's. A furnished building is a hundred cards in a heap, which
loses the one thing the key is for. So the unit gets one card and its boards are
cells in it.

**A board is the item's art and how much of it, and nothing else** — which is
where the reuse of `setBoardTip` stops. Its four fields are the right answer for
one heap under a pointer and three of them are noise thirty times over: the name
is what the art already says, and the price is a question you ask of one shelf
you have decided to look at rather than of a whole shop at a glance. There is no
unit name on the card either, for the same reason: the unit is directly
underneath it.

That is what lets the boards run **across** the card rather than down it. A pair
of cells is narrow, so three of them side by side are still narrower than one of
the cards this replaced, and a wide one-line card is the shape that fits over a
unit at this camera — a tall one stands up into the aisle behind it and reads as
belonging to whatever is up there, which is the overlap bug arriving by the other
axis. A hairline between boards is what stops three of them reading as one long
number. And **the art is the only thing naming the goods**, so it has to be
`artForModel`, the hover card's own call: a generic glyph would make every board
of every card identical, which is the thought-bubble failure above in miniature.

**Grouping is most of the answer to overlap and not all of it**, and the rest is
`declutterPeek`. A card is still wider than three tiles, so two units side on to
the camera collide however narrow the card gets — and what that costs is not
tidiness: a card half under another one reads as belonging to whichever unit is
nearest it, which is a readout that is confidently *wrong* about where the shop
keeps something, the one question the key exists to answer. So cards are settled
front-to-back, and a card that has to move moves **up**: it keeps its unit's own
screen x, so it stays in that unit's column and the association survives, where a
card slid sideways is the bug itself. It is bounded rather than solved — a stack
deep enough to need forty nudges is a shop that will not read anyway, and an
unbounded relaxation loop on the frame is a frozen tab.

The measuring is where that could have gone wrong. A card can only be nudged off
another if something knows how big it is, and `offsetWidth` is a forced layout
read — thirty of them a frame is precisely the stutter the content/position split
above exists to prevent. A card's size is a fact about its *content*, though, so
it is measured on the one frame that content is written and cached beside it, and
the per-frame work is arithmetic on numbers already in hand.

How many rows is the **shelf's own** number, off `boards` on the wire — the same
figure `boardsOf` answers for the sim, read at this fixture's tier. Three is what
the widest unit in the game draws today and writing that down in the client is a
second copy of it, which a tier that grew a fourth board would make silently
wrong. A bed and an ordinary appliance are one row; a twin-headed machine is the
one appliance with two things to say, and the grouped card is the shape that lets
it say them.

Two decisions on top of the plan. A board that is **reserved but empty** says
*kept for* in words rather than showing `0/8`, since that is the hardest thing in
the shop to find out about and a zero that is a plan reads as a zero that is a
problem. And the key `preventDefault`s: a bare Alt
focuses the browser's menu bar on Windows and Linux, which takes the keyboard
away from the page — so the *keyup* never arrives and the overlay sticks over a
shop nobody can walk in.

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

### A look goes under a job

**Built** — step 31, and it is one line of `GROUND`'s own taxonomy finally being
read by the brush that paints it.

That table has partitioned in two since step 14: `floor`, `road`, `path` and
`lawn` are a **look**, and `bay`, `drop`, `break`, `park` and `paddock` carry a
**job** (`pad: true`, and a `does` sentence saying what). One overlay held one
answer per cell, so those two were rivals — and the shape of the bug that
follows from that is worth stating exactly, because nothing in the code looked
wrong:

> Drag a floor across your stockroom and the storage is gone. Not refused, not
> warned about past the last cell — the warning fires and then the thing it warns
> about happens — because painting over a pad is *also* how you move one, and the
> stroke has no way to tell "put the bay over there" from "lay a nice floor
> through here". What you notice, days later, is that deliveries have stopped
> arriving.

The whole fix is that a look painted onto a job goes **underneath** it. The job
draws and behaves exactly as it did, what you laid is remembered (`u` on the
entry — a kind and a piece), and taking the job up hands the look back rather
than scraping the cell to nothing.

It is the same sentence `canPaintGround` has said one cell over since conveyors
became ground: **under a conveyor is still ground**, and a run laid across your
parquet does not owe you a repaint. Under a pad is still ground too. Five things
are worth knowing.

The conveyor half is the same partition, and it was aimed one notch too wide for
a while. It asked that what you laid leave the cell as it found it — the land
outdoors, floor indoors — which let exactly one look through on each side and
turned down every other one on both. Half of that is invisible, because indoors
the look anybody paints IS floor; the half you meet is the ordinary press, since
a run out to the yard crosses the wall and half of every conveyor in the game is
standing on grass. Laying the shop's own floor under that stretch came back
*"only ground goes under a conveyor"* over a stroke that moves no tile anywhere,
which reads as the brush being broken. The rule is `groundPaint`'s own line
instead: a **look** goes under a run wherever it is, and a **job** never does —
every reader of "deliveries land here" reads `tiles`, which is a belt on that
square and always will be, so a bay painted under a run would draw as a bay and
never take a crate. `verify:floor` §10 asserts both sides of the wall against
that control, and fingerprints `tiles` across the lot.

**`k` is still the top, and still the only thing that decides the tile.** So not
one reader of `tiles`, `blocked`, `indoor`, a pad region or the renderer changed,
and `verify:floor` asserts it as a byte comparison: paint the whole delivery bay
and the three arrays are identical afterwards. The inverse shape — the look on
top with the job beside it — is the layer the section above turned down, and it
turns "what is this cell made of" into a precedence question asked inside a pure
generator that has never seen the catalog.

**One function owns it** (`groundPaint`, `shared/build.js`), called by the
validator for the ghost and by `buildGround` for the press. Two copies of a
layering rule is the green-ghost bug with a paintbrush on it: a preview that
promises a floor over a room the press leaves as a stockroom. It also folded in
three no-op skips that had been written out separately at each end, one of which
disagreed — the press wrote a floor entry over a *bed's* own cell and reported a
tile taken up, which the next re-flow stamped straight back over.

**An underlay is only ever a look, and only ever one somebody bought.** Seeded
pads, the generated street and plain shell floor all arrive with no piece, and a
remembered look with no piece would hand back ground nobody paid for on every
scrape. So `u.p` is never null, which is what keeps the money to one question:
nothing is refunded for a look that went *under* — you still own it, and it comes
back — and the pad is refunded when the pad is what changes hands.

**A selection remove clears both** (`all`, the one argument that does not come off
the wire). The bulldozer aimed at one cell peels a layer, which is what "stop
being storage" means; a region being deleted is not that, and a reveal there
would leave a room-shaped stain of perfectly good flooring behind the stockroom
it just deleted — the stain `verify:stamp` exists to catch, arriving through the
one door allowed to peel.

**The one outcome that looks like nothing happening is in the feed.** A pad draws
on top either way, so a drag through your stockroom is a charge and an unchanged
picture; the line says *"— all of it under the delivery bay, which stays"*, and
it names the pad when the stroke crossed only one.

What it does **not** do is make the pad see-through. Storage still reads as
storage from across the shop, and the floor you laid is only visible once the pad
comes off. The alternative — the look drawn and the job reduced to a marker over
it — is a rendering decision rather than a rule, and it wants the marker designed
before it is worth having: `addPadMarks` already draws a glyph per pad kind, so
the honest version is that glyph over your own floor rather than over the pad's
flat colour.

### A room comes with its floor

**Built** — step 32, and it is the smallest step in this document: the two
presses step 13 put next to each other became one.

Step 13's own opening is *"how do I make my shop bigger?"*, and the answer it
gave was two gestures — draw the walls, then lay the floor — because enclosure
and ground are genuinely two layers and always will be. What that section did
not say is that the second gesture is not a **decision**. There is no shop in
which you wall an annex and want it left as grass: bare ground indoors is the
one thing `canPaintGround` warns about by name, a cell nothing can be built or
dug on. So the ordinary way to grow a shop was a press that puts the room in a
state the game itself calls a hole, followed by a chore to get out of it — and
the chore is not even one drag, since a room is whatever shape you drew.

`floorNewRooms` (`server/sim/index.js`) is that chore, done on the press that
creates it. Four things about it are load-bearing, and each of them is a way it
could have been a rule about the shop rather than a consequence of the gesture.

**Only the cells that CHANGED.** `buildEdge` snapshots the `indoor` mask before
its re-flow — the one moment the old answer still exists, since `edits` already
holds the new wall and `this.layout` does not — and lays floor only where the
mask went from out to in. Flooring every bare cell indoors instead would pave a
hole you deliberately left in the middle of your own aisle, on a wall you drew
somewhere else, and it would do it again every time you scraped the cell back.

**Grass only, and never over anything standing.** `T.FLOOR` is already right, a
bed is a job, a conveyor is a rail set into whatever is under it, and the road,
the pavement and the land are looks somebody chose. Every one of those is a cell
the Floor brush itself leaves alone or refuses, and this must not be a bulldozer
the brush is not — `blocked` is asked for the reason the section above gives:
the tile moves here, so a pen caught inside the same drag would be shed and
refunded by the re-flow rather than refused.

**It is a purchase**, at the brush's own price and the brush's own refund
arithmetic, in the design the shop is mostly already wearing (`roomFloorPiece`,
a count of what is down, falling back to `shop-floor`) so an annex matches the
aisle it opens off. Free flooring would make the cheapest shop in the game one
enormous drag, which is step 13's per-cell pricing argument said one press
along. Running out halfway lays what you could afford, exactly as a wall does.

**One press, one undo.** It records a `ground` part rather than opening a step
of its own, so the step the room opened around `build-edge` holds both and
Ctrl+Z takes the wall and its floor back together. Undoing the wall and leaving
the flooring is a room-shaped stain of perfectly good floor sitting outdoors,
which is the stain the section above already names — arriving through a door
nothing else opens. `verify:undo` §4b is the pair, redo included.

A shop that *un*-encloses gets nothing at all, and that falls out rather than
being written: enclosure is all-or-nothing, so a breached building reports zero
indoor cells and no cell has become indoors.

What it deliberately does not do is show up in the ghost. The wall preview says
what the wall costs; the floor is priced on the press and named in the feed
(*"Built 2 segments of wall for $24.00. Floored the 4 new tiles for $24.00."*).
Putting it in the preview means answering "would this close a room" on every
frame of a drag, which is `computeIndoor` per segment — and the honest version
of that is the overlay key rather than a number on the cursor.

### The wall drag turns, and stops looking like it has been built

*Built (step 33).* Two things about the same gesture, and the second is what
made the first read as broken.

`edgeRun`'s own note argued that a run follows the line it started on and that
turning a corner is a second drag — "simpler to reason about, and what a drawn
wall actually wants". The first half is still true and the second half was a
claim about *runs* smuggled in as a claim about *presses*. The axis was settled
at `pointerdown` by `pickEdge`, which snaps to whichever of two lattice lines is
nearer, and half a cell is the whole of that decision: press meaning to go north
off a wall you have been tracing east and you have pressed on the east line, so
dragging north moves the pointer along an axis the run does not have and lays
**nothing at all**. Not a refusal, not a warning — a ghost of one segment that
will not grow, which reads as the tool having stopped working.

So the axis is the pointer's, re-read every move (`edgeDragRun`), and three
things hold it together. **Ties keep the incumbent**, `faceAlong`'s rule: a
press that has not travelled is the line it snapped to, so a click is exactly
the single segment it has always been. The turned run hangs off the **corner**
(`Scene.pickCorner`) rather than off the pressed edge, because an edge names one
lattice coordinate and the other axis needs the other one — and which side of
that corner it starts on is the direction of travel, since a lattice line sits
between two cells and the run takes the one you dragged towards. And the press
sends **the run's own start**, not the edge under the pointer at `pointerdown`:
the wire format is still two ends and a kind, so the server re-runs the same
`edgeRun` and lands on the same segments, but the start it is handed is now a
line the press never named.

The ghost is an **outline** rather than a slab per segment. A half-opaque wall,
at wall height, on the line it would stand on, is not a preview of a wall — it
is a wall being built as you drag, which is the one thing this gesture must not
look like, because nothing is bought until the button comes up. One cage for the
whole run rather than one per segment, for `setEdgeGhost`'s existing reason:
"this seals the shop" is true of the run and colouring segments separately would
invite you to read part of it as the part that will happen. Twelve merged bars
rather than a `LineSegments`, which is `buildCageMarker`'s argument and not a new
one — `linewidth` is one pixel on every platform that ignores it, and at this
camera that reads as a smudge rather than as a box. The `grow` on the cage is
what the old `+0.05` fattening was for: in the `aim` state the ghost describes an
edge that is already standing there, and a preview at exactly its thickness is
two coplanar faces arguing over the depth buffer.

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
24. **Q is the pipette.** *Built.* Point at anything and arm that exact piece,
    variant and facing. Client-only. Its ladder is the bulldozer's
    (`whatsThere`), because "what is that" and "get rid of that" are one
    question. See above.
25. **Any fixture drags out in a row.** *Built.* The conveyor run drag widened to
    every kind — a guard rather than a second message — plus one flag
    (`runFollows`) saying whether a corner turns the thing or keeps the armed
    facing. `beltRunCells` is `runCells`. See above, and `verify:stamp`.
26. **Copy and paste a selection, without rotation.** *Built.* Ctrl+C over the
    multi-select, Ctrl+V (or a click) under the pointer, the whole stamp inside
    one `undoStep`. Fixtures, ground, walls and paint, in that order, with one
    re-flow per layer rather than one for the lot — see above for why that is
    the opposite of what every other multi-fixture verb here does. See above,
    and `verify:stamp`.
27. **The overlay key.** *Built.* Hold Alt and every unit says what it holds, as
    the hover card (`setBoardTip`) said about the whole shop at once. Read-only,
    no new state on the wire, and a hold rather than a toggle. Built once as
    thought bubbles in the world first — see above for why a bubble could not
    say the one thing the card can, which is the name.
27b. **Removing and re-tiering what is picked.** *Built.* Remove, Upgrade and
    Downgrade joined `build-style` as bulk verbs — one message each, one
    `undoStep`, one re-flow, one line saying what the money did. `Del` is
    Remove's key. All three were deliberately left out of step 16 and that call
    was wrong: the line is whether six of a verb is six different things or one
    thing said once. The traps are the last-till guard, which is the only
    fixture rule that reads the shop rather than the unit and therefore the only
    one a held re-flow can make stale, and the per-piece pricing of a rung. On a
    phone it is two more buttons in the left thumb stack, because Shift is not a
    key that exists there — the latch is the interesting one. See above, and
    `verify:pick` §7–8.
27c. **Moving what is picked.** *Built.* Move joins them, and it is the one of
    the four that could not simply be handed to `bulkFixtures`, for two reasons
    that are each worth a line.

    It is not a CARRY. `p.holding` is one fixture because hands are, so six
    picked up one at a time is six trips across the shop. A batch is a **rigid
    translation** instead: nothing is ever in the air, the units keep standing
    where they are, the whole group previews under the pointer and one press
    sends one delta (`build-shift` → `Game.shiftFixtures`). The client aims it
    with the blueprint machinery Ctrl+C already has — same held-in-your-hands
    footprint, same anchor (the group's own top-left corner, which is paste's
    anchor exactly and beats inventing a second rule), same Escape — and the one
    thing that differs is which message the click sends.

    And it MOVES A TILE, which is the one thing `holdReflow` was never safe for.
    Its own note says why it is safe for the other bulk verbs: each looks its
    own fixture up and checks `canPlace` "against the shop as it stood before
    the batch — which is the same shop, since none of them moves a tile". A
    shift makes that stale by construction, and the failure is a refusal rather
    than a wrong answer: a row nudged one square *along itself* has every member
    landing on the cell its neighbour has not vacated yet, so asked one id at a
    time the shop says no to all but the first — measured at 1 of 4, "something
    is already there", over six perfectly legal placements. So `ignoreId` takes
    a **set** (`ignores`, shared/build.js) and the batch forgives itself as one.
    What makes that safe rather than merely convenient is arithmetic: a rigid
    translation is a bijection with no fixed points, so no two members can ever
    land on the same cell, whatever order they are applied in.

    The same bug is waiting one level up, and it bit on the first run. Undo
    walks a step under the same hold and pre-checks every part with
    `couldGoTo` — so a batch move could be made and not taken back, and because
    half an undo is worse than none the *whole* step was refused: you press
    Ctrl+Z on a move you made a second ago and the shop says "something is
    already there" about the shop it is being asked to go back to. `movingIds`
    is the same answer, narrowed to the parts that actually change tile, since a
    part standing still (a restyle, a rung) is not leaving and forgiving it
    would let another part land on top of it.

    Three smaller things. The menu **closes itself** on the press, which is not
    tidiness — the panel is half the screen and what you are about to do is
    point at the floor behind it — and it is owned by `shiftSelection` so the
    button, the M key and the pill row cannot disagree. The preview has to ask
    the same forgiving question the server does, or the ghost is amber down the
    whole aisle over a press the shop accepts, which is the green-ghost bug
    pointed the other way. And the selection **follows it there** (`markShifted`
    / `claimShifted`), by cell rather than by id because the ids do not exist
    yet — `endMove`'s own argument said about six, since lining an aisle up is
    several nudges and a selection that emptied itself on the first would be six
    shift-clicks before the second. See `verify:pick` §9 and `verify:undo` §12.
29. **The arch, and the three ways to be a fence.** *Built.* One new opening
    (`arch`, two rules — see above for why not four) and one new look family
    (`FENCING`: panel, hedge, railing, low wall, all at a fence's price and free
    to swap). The only code that had to learn anything new is `edgeBands`, which
    grew a corbelled span and a posts-and-rail; everything else is a row in a
    table, because `SOLID`, `ENCLOSING`, `RULED` and `edgeFamily` are all derived
    from those tables rather than written out. Three column decorations were
    authored alongside, as content. See above.
28. **Turning a stamp.** Rotating a blueprint means rotating the offsets *and*
    the facings, and an `h` wall becomes a `v` one. Left out of 26 deliberately:
    doing only the second looks completely correct on a single shelf and shears
    every aisle, and the wall half cannot be checked by eye at all.

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
