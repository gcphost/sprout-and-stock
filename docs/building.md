# Building — design

Status: **proposed, nothing built.** There is a working interactive mockup —
[turn the shop around here](https://claude.ai/code/artifact/1aac9d71-46fc-4e78-9f93-d54a6e6d2467).
Its enclosure maths is tested (ten assertions, both wall models, all four camera
quarters); everything else in this doc is a plan.

The goal: the shop stops being a rectangle the generator solves for and becomes
whatever you build. Walls, windows and doors are things you place. Lights and
decorations are authored content, so a new planter or a brass sconce is one MCP
call and no code change.

---

## What's wrong today

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
| `prop-floor` | tile | *per piece* | yes | — | planters, barrels, bins, rugs |
| `prop-wall` | edge | no | — | — | signs, posters, wall shelves, clocks |
| `prop-ceiling` | overhead | no | — | — | pendants, fans, hanging signs, bunting |

`prop-floor` is the one kind where `blocks` is authored rather than fixed,
because a barrel and a rug want opposite answers and are otherwise identical.
Everything else has one honest answer per kind.

A light is not its own kind — it's a piece of `prop-floor`, `prop-wall` or
`prop-ceiling` that carries an `emits` block. A floor lamp and a barrel obey the
same placement rules; one of them just glows.

### What a piece looks like

```js
export const PieceSchema = z.object({
  id:   slug,                    // 'terracotta-planter' — yours to choose
  kind: z.enum(BUILD_KINDS),     // from shared/build.js — the closed set above
  name: z.string().min(1).max(48),

  model:    ModelSchema,         // staged by tier, exactly as today
  variants: [...],               // looks only, exactly as today
  tiers:    [...],               // costs and multipliers, exactly as today

  /** prop-floor only: a barrel blocks, a rug does not. */
  blocks: z.boolean().default(true),

  /** What it costs to put one down. Today this is derived from upgrades. */
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

### Lights

`emits` is content; honouring it is code, in `client/render/scene.js`.

Two things that will bite:

- **You cannot have fifty point lights.** three.js will crawl. Cap it — pick the
  N nearest the camera and let the rest contribute to ambient only — and decide
  that cap before authoring a catalogue of lamps, not after.
- **A light that changes no number is decoration with extra steps.** That is
  fine and probably correct to start with. But if lighting is ever meant to
  *matter*, the honest hook is the tag system: a dark aisle tagged `dim`, an
  archetype that avoids it. Don't hardcode `if (piece.id === 'lamp')`.

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

Today `fixtureUnitCost` in [`server/sim/index.js`](../server/sim/index.js)
derives a price by scanning upgrade payloads, which works because every fixture
kind has an upgrade that sells it. A planter won't.

So `cost` moves onto the piece, and upgrades become **unlocks and discounts**
rather than the thing that grants you a countable fixture. `space` upgrades
become land. The `world.fixtures` ledger retires — you buy a piece when you
place it and get `FIXTURE_REFUND` of it back when you tear it out.

---

## Build order

Sliced so the game is playable at every step. Steps 1–3 are the spine;
everything after is additive.

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
4. **Stamp once.** Convert the live world, stop re-running the generator on
   every placement. `droppedPlacements` retires.
5. **Things become a list.** Fixtures stop stamping tiles. `BUILDABLE_INDOOR`
   becomes "no blocking thing on this cell". This is what makes step 7 possible.
6. **Wall, window and door as build tools.** Drag corner to corner. The action
   carries two lattice points and a kind — a rect, never a tile list, because of
   the 4KB inbound cap.
7. **Kinds and pieces split.** `fixtures.kind`, the closed `BUILD_KINDS` set,
   `prop-floor` / `prop-wall` / `prop-ceiling`. `create_fixture` grows a `kind`
   argument. Decorations become authorable.
8. **Lights.** `emits`, the renderer, and the cap.
9. **Economy swap.** Upgrades become unlocks and discounts, `space` becomes
   land, `cost` moves onto pieces, the ledger retires.
10. **Camera occlusion.** Genuinely can go last — until then you build with the
    camera turned.
11. **Fields.** Fences are already an edge kind by now, so they become
    player-drawn and the auto-bbox fence in `layout.js` retires.

---

## Gotchas found while prototyping

Each of these is a real finding from the mockup or from reading the code, not a
guess.

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
  it, or everyone crosses the map to use the front one. `addAwning` hardcodes
  the single south-wall door too. Small, but it sits in the sim's hot path.

- **Fixture ids already live in two namespaces** (`shelf-p0` from the generator,
  `fx-N` from the player) and must never collide. A things-list makes this
  easier, not harder — but step 4 is where the generated ids stop being minted
  fresh on every re-flow, so that is the moment to check it.

---

## Open questions

- **Does a wall cost per edge or per run?** Per edge is honest and makes long
  walls expensive; per run is kinder and harder to price.
- **Do rooms mean anything?** The enclosure fill can cheaply label *distinct*
  enclosed regions, not just enclosed-vs-not. That would give "the cold room",
  "the back office" as addressable things. Worth having, not worth building
  until something wants to read it.
- **Can you demolish a wall that would strand a fixture?** `whatThisBlocks`
  already answers this for placement. Removal needs the same check and doesn't
  have it.
- **Roofs.** Nothing here draws one, and the 45° camera means you probably never
  want to. But "enclosed" currently implies a roof that is never modelled, and
  someone will eventually ask why rain doesn't come in.
