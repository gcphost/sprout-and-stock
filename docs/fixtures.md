# The build catalog

**Generated — do not edit.** `npm run docs:fixtures` rewrites this from the
live content database. Fixtures arrive through `create_fixture` while the game
is running, so a hand-kept list would be wrong by the end of the evening, and a
reference you cannot trust is worse than no reference at all.

**Kinds are code; pieces are content.** A row here is a *piece*: its own id,
model, variants, tier ladder and price. It names a *kind* from the closed set in
`shared/build.js`, and that set is closed because where a thing may go, whether
it blocks and which side you work it from are behaviour. So there can be four
planters and two shelf designs, but not a new kind — see [building.md](building.md).

44 pieces across 14 kinds.

## Fixtures

Things you own, that stand in a cell, that the generator has a budget for.

### `shelf`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`browseAt`), rotates.

#### Shelving

`shelf` · kind `shelf` · $45 to build

8 parts · 3 stages, driven by tier · **3 boards of goods** (9 facings drawn)

Shapes: Standard, Corner, Endcap, Low, Wall run, Wall corner, Wall corner (other way) — looks only, same price and same ladder.

1. **Plain shelving** — free, as built
2. **Backed shelving** — $120, holds ×1.5
3. **Signed aisle** — $300, holds ×2

#### Bakery Case

`bakery-case` · kind `shelf` · $95 to build

8 parts · **2 boards of goods** (6 facings drawn) · has glass

1. **Bakery case** — free, as built
2. **Heated case** — $120, keeps ×1.6
3. **Patisserie case** — $300, holds ×1.35, keeps ×2

#### Produce Table

`produce-table` · kind `shelf` · $38 to build

8 parts · 3 stages, driven by tier · **3 boards of goods** (9 facings drawn)

1. **Trestle table** — free, as built
2. **Tiered display** — $90, holds ×1.4
3. **Covered stall** — $220, holds ×1.8, keeps ×1.3

### `freezer`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`browseAt`), rotates.

#### Freezer

`freezer` · kind `freezer` · $260 to build

8 parts · 3 stages, driven by tier · **3 boards of goods** (9 facings drawn) · has glass

Shapes: Standard, Chest, Wall run, Wall corner, Wall corner (other way), Endcap — looks only, same price and same ladder.

1. **Glass-door freezer** — free, as built
2. **Sealed freezer** — $260, keeps ×1.5
3. **Display freezer** — $620, holds ×1.5, keeps ×2

#### Deli Counter

`deli-counter` · kind `freezer` · $240 to build

6 parts · **1 board of goods** (3 facings drawn) · has glass

1. **Serve-over** — free, as built
2. **Chilled well** — $150, keeps ×1.8
3. **Butcher’s counter** — $380, holds ×1.3, keeps ×2.6

#### Open Chiller

`open-chiller` · kind `freezer` · $285 to build

8 parts · **3 boards of goods** (9 facings drawn)

Shapes: Standard, Wall run, Wall corner, Wall corner (other way), Endcap — looks only, same price and same ladder.

1. **Multideck** — free, as built
2. **Night-blind multideck** — $190, keeps ×1.7
3. **Glass-end multideck** — $420, holds ×1.4, keeps ×2.4

#### Cooler

`cooler` · kind `freezer` · $75 to build

7 parts · **2 boards of goods** (6 facings drawn) · has glass

Shapes: Standard, Wall run, Wall corner, Wall corner (other way), Endcap — looks only, same price and same ladder.

1. **Under-counter** — free, holds ×0.6
2. **Upright cooler** — $140, holds ×1.1, keeps ×1.2
3. **Glass-door cooler** — $300, holds ×1.6, keeps ×1.5

### `checkout`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`serveAt`), rotates.

#### Till

`checkout` · kind `checkout` · $300 to build

8 parts · 4 stages, driven by tier · no `surface` boards — goods pile on its roof

Shapes: Standard, Express Kiosk, Corner Counter — looks only, same price and same ladder.

1. **Manual Till** — free, as built
2. **Barcode Scanner** — $180, speed ×1.4
3. **Belted Checkout** — $420, speed ×1.9
4. **Self-Checkout** — $900, speed ×1.5, serves itself at ×0.5 speed

### `station`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`useAt`), rotates.

#### Appliance

`station` · kind `station` · priced by the upgrade that sells its kind

4 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

- ⚙️ **Standard** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Espresso Machine** while running — 3 stages across a batch · steams · 1 moving part · the machine itself shake + bobs
- ⚙️ **Blender** while running — 3 stages across a batch · 1 moving part · the machine itself pulses
- ⚙️ **Toaster** while running — 2 stages across a batch · 2 moving parts
- ⚙️ **Sandwich Press** while running — 3 stages across a batch · 1 moving part · the machine itself shakes
- ⚙️ **Juicer** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Soft-Serve Machine** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Deep Fryer** while running — 3 stages across a batch · steams · the machine itself shakes
- ⚙️ **Oven** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Grill** while running — 3 stages across a batch · 1 moving part · the machine itself shakes
- ⚙️ **Preserving Pot** while running — 3 stages across a batch · steams · the machine itself shakes

Shapes: Standard, Espresso Machine, Blender, Toaster, Sandwich Press, Juicer, Soft-Serve Machine, Deep Fryer, Oven, Grill, Preserving Pot — looks only, same price and same ladder.

1. **Domestic** — free, as built
2. **Commercial** — $340, speed ×2

### `plot`

Outdoors only, blocks nobody, nobody stands at it.

#### Plot

`plot` · kind `plot` · $30 to build

4 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

Shapes: Standard, Timber Trough, Cold Frame — looks only, same price and same ladder.

1. **Bare earth** — free, as built
2. **Raised bed** — $90, speed ×1.6
3. **Greenhouse** — $260, speed ×2.3

## Decorations

They weigh nothing, on purpose. No tile stamped, no generator budget, no working spot reserved — so people walk past them and no shop that was walkable stops being so. Anything that must be walked around is a shelf.

### `prop-floor`

Indoors or out, blocks nobody, nobody stands at it, rotates.

#### Terracotta Planter

`terracotta-planter` · kind `prop-floor` · $35 to build

5 parts

#### Basket Stack

`basket-stack` · kind `prop-floor` · $20 to build

6 parts

#### A-Frame Sign

`a-frame-sign` · kind `prop-floor` · $25 to build

6 parts

#### Money Tree

`money-tree` · kind `prop-floor` · $400 to build

8 parts

💰 **Earns $12 every 180 in-game minutes**, as a pile of cash on its own tile that somebody has to walk over and collect.

✨ Charm **4** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Floor Lamp

`floor-lamp` · kind `prop-floor` · $65 to build

4 parts

💡 Emits `#ffd7a1`, intensity 1.1, range 4.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Lamp Post

`lamp-post` · kind `prop-floor` · $90 to build

5 parts

💡 Emits `#ffd9a6`, intensity 1.6, range 7 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Bollard Light

`bollard-light` · kind `prop-floor` · $40 to build

4 parts

💡 Emits `#ffe0b0`, intensity 0.7, range 3.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Awning

`awning` · kind `prop-floor` · $28 to build

8 parts

### `prop-ceiling`

Indoors only, blocks nobody, nobody stands at it, rotates, hangs, so it needs a room to hang in.

#### Pendant Lamp

`pendant-lamp` · kind `prop-ceiling` · $60 to build

3 parts

💡 Emits `#ffd7a1`, intensity 1.3, range 5.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Aisle Sign

`aisle-sign` · kind `prop-ceiling` · $45 to build

5 parts

#### String Lights

`string-lights` · kind `prop-ceiling` · $55 to build

5 parts

💡 Emits `#ffe0b0`, intensity 0.8, range 4 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Tube Light

`tube-light` · kind `prop-ceiling` · $70 to build

4 parts

💡 Emits `#e8f0ff`, intensity 1.5, range 6 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Fan Light

`ceiling-fan` · kind `prop-ceiling` · $110 to build

6 parts · 2 parts move always

💡 Emits `#ffe1b3`, intensity 1, range 5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Panel Light

`panel-light` · kind `prop-ceiling` · $80 to build

2 parts

💡 Emits `#eef4ff`, intensity 1.3, range 5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Paper Lantern

`paper-lantern` · kind `prop-ceiling` · $45 to build

3 parts

💡 Emits `#ffdcae`, intensity 0.9, range 4.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Chandelier

`chandelier` · kind `prop-ceiling` · $160 to build

11 parts

💡 Emits `#ffd08a`, intensity 1.8, range 6.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

## Ground

Not placed — **painted**, over an area, priced per tile. These have no anchor and block nobody, because they are not standing in a cell, they *are* the cell.

### `floor`

Ground. Painted over an area, blocks nobody, and is purely a **look** — two designs of floor leave byte-identical tiles.

#### Pine Boards

`pine-boards` · kind `floor` · $9 per tile

Surface `#c09a63` / `#a8834f`, planks repeat. No model — ground *is* the cell.

#### Chequer Tile

`chequer-tile` · kind `floor` · $14 per tile

Surface `#e6e2d8` / `#4a4a52`, checker repeat. No model — ground *is* the cell.

#### Poured Concrete

`poured-concrete` · kind `floor` · $6 per tile

Surface `#9b9a94`, plain repeat. No model — ground *is* the cell.

#### Terracotta Tile

`terracotta-tile` · kind `floor` · $16 per tile

Surface `#c2724a` / `#a75f3d`, checker repeat. No model — ground *is* the cell.

#### Slate Flags

`slate-flags` · kind `floor` · $22 per tile

Surface `#5c626b` / `#4a4f57`, planks repeat. No model — ground *is* the cell.

#### Paving Slabs

`paving-slabs` · kind `floor` · $7 per tile

Surface `#c9c7c0` / `#b0aea6`, checker repeat. No model — ground *is* the cell.

#### Asphalt

`asphalt` · kind `floor` · $5 per tile

Surface `#4b4d51`, plain repeat. No model — ground *is* the cell.

#### Cobblestone

`cobblestone` · kind `floor` · $13 per tile

Surface `#8d8478` / `#786f64`, checker repeat. No model — ground *is* the cell.

#### Brick Paving

`brick-paving` · kind `floor` · $11 per tile

Surface `#a35e49` / `#8b4e3c`, planks repeat. No model — ground *is* the cell.

#### Shop Floor

`shop-floor` · kind `floor` · $6 per tile

Surface `#f0ddb8`, plain repeat. No model — ground *is* the cell.

### `bay`

Ground. Painted over an area, blocks nobody, and carries a **job**: wholesale orders land here, and how big you paint it is how many crates it holds.

#### Loading Bay

`loading-bay` · kind `bay` · $8 per tile

Surface `#9aa79b` / `#8c9a8d`, checker repeat. No model — ground *is* the cell.

### `drop`

Ground. Painted over an area, blocks nobody, and carries a **job**: hands are cleared here and stock waits, and how big you paint it is how much waits at once.

#### Storage

`stockroom-floor` · kind `drop` · $8 per tile

Surface `#c2a173` / `#a8865c`, planks repeat. No model — ground *is* the cell.

### `break`

Ground. Painted over an area, blocks nobody, and carries a **job**: staff take their breaks here, and how big you paint it is how many of them it seats at once.

#### Break Room

`break-room` · kind `break` · $12 per tile

Surface `#b59ab8` / `#9d84a1`, checker repeat. No model — ground *is* the cell.

### `park`

Ground. Painted over an area, blocks nobody, and carries a **job**: shoppers who drive here leave the car, and how big you paint it is how many of them can.

#### Car Park

`car-park` · kind `park` · $10 per tile

Surface `#79808c` / `#98a0ad`, planks repeat. No model — ground *is* the cell.

### `road`

Ground. Painted over an area, blocks nobody, and is purely a **look** — two designs of road leave byte-identical tiles.

#### Tarmac

`tarmac-road` · kind `road` · $4 per tile

Surface `#5f646d` / `#565b63`, plain repeat. No model — ground *is* the cell.

#### Gravel Track

`gravel-track` · kind `road` · $2 per tile

Surface `#9a9184` / `#867e72`, checker repeat. No model — ground *is* the cell.

### `path`

Ground. Painted over an area, blocks nobody, and is purely a **look** — two designs of pavement leave byte-identical tiles.

#### Pavement

`paving-path` · kind `path` · $3 per tile

Surface `#d9cbb0` / `#c6b79a`, checker repeat. No model — ground *is* the cell.

#### Crossing

`zebra-crossing` · kind `path` · $6 per tile

Surface `#f2efe6` / `#5f646d`, stripes repeat. No model — ground *is* the cell.

---

Authoring notes that cost real debugging time:

- **Eight parts per stage** is the cap. The shipped shelf is exactly 6/7/8 for
  that reason — build the silhouette from the budget, not from what looks nicest.
- **A model faces east.** `-x` is its back, `+x` its face. Goods run along
  whichever horizontal axis a `surface` board is *longer* on, so make boards
  deeper (z) than wide (x) or a corner unit files its stock into the wall.
- **Anything you put over a board has to clear it.** Goods fill top-down, so a
  canopy 0.17 above the top board is not a detail — it is where every unit of
  stock goes, and none of it can be seen. Leave a board the same headroom its
  neighbours have (the shelf pitch is 0.35) and raise the uprights and glass
  with it, or the lid floats. `drawableBoards` in `shared/model.js` is the
  judge, and this file flags whatever it fails.
- **A hanging piece must hang.** `prop-ceiling` parts sit at negative `y`;
  `verify:build` asserts it, because one at `y: 0` is a sign lying on the floor.
- **`rot` turns a part about Y and nothing else.** Nothing can lean.
- **A variant is a look; a tier is a number.** A new shape can never move the
  balance, which is why restyling something already built is free and keeps its
  stock, and why no shape anybody draws needs `simulate` re-run.
- **`yields` and `charm` are the exception to that.** They are the only fields
  here that move money, so a piece carrying either needs `simulate` averaged over
  ten seeds before you believe the number — one seed is not a measurement.

