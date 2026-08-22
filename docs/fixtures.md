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

125 pieces across 24 kinds.

> ⚠️ **Boards you cannot see into.** Goods fill a unit from the TOP board
> down, because on a 45° camera each board covers the one below it. So a
> piece with a canopy over its top board puts the first thing you stock in
> the one place the camera never reaches: the unit holds a full load and
> draws as empty, which reads as stock that never arrived rather than as art.
> Raise the lid — and whatever carries it — until the board has the same
> headroom the others have:
>
> - `station` · Butcher's Block tier 3 — 1 of 2 boards (**1 under a lid**)
> - `station` · Candy Kettle tier 3 — 1 of 2 boards (**1 under a lid**)

## Fixtures

Things you own, that stand in a cell, that the generator has a budget for.

### `shelf`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`browseAt`), and reachable from either end, rotates.

#### Shelving

`shelf` · kind `shelf` · $45 to build

9 parts · 4 stages, driven by tier · **4 boards of goods** (12 facings drawn)

Shapes: Standard, Corner, Endcap, Low, Wall run, Wall corner, Wall corner (other way) — looks only, same price and same ladder.

1. **Plain shelving** — free, as built
2. **Backed shelving** — $120, holds ×1.5
3. **Signed aisle** — $300, holds ×2
4. **Tall aisle** — $620, holds ×2.6

#### Bakery

`bakery-case` · kind `shelf` · $95 to build

8 parts · **2 boards of goods** (6 facings drawn) · has glass

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

1. **Bakery case** — free, as built
2. **Heated case** — $120, keeps ×1.6
3. **Patisserie case** — $300, holds ×1.35, keeps ×2

#### Produce

`produce-table` · kind `shelf` · $38 to build

8 parts · 3 stages, driven by tier · **3 boards of goods** (9 facings drawn)

🔄 **Open all round** — no back panel, so it is worked from all four sides rather than three. Reach and the working-spot markers only: where it may be built and where a tap walks you go by the one anchor either way.

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

1. **Trestle table** — free, as built
2. **Tiered display** — $90, holds ×1.4
3. **Covered stall** — $220, holds ×1.8, keeps ×1.3

#### Gondola

`gondola` · kind `shelf` · $110 to build

11 parts · 3 stages, driven by tier · **6 boards of goods** (18 facings drawn) · seams against a neighbour

🔄 **Open all round** — no back panel, so it is worked from all four sides rather than three. Reach and the working-spot markers only: where it may be built and where a tap walks you go by the one anchor either way.

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

1. **Open gondola** — free, as built
2. **Full gondola** — $150, holds ×1.4
3. **Signed gondola** — $340, holds ×1.8

#### Pallet Rack

`pallet-rack` · kind `shelf` · $220 to build

30 parts · 3 stages, driven by tier · **6 boards of goods** (18 facings drawn)

🔄 **Open all round** — no back panel, so it is worked from all four sides rather than three. Reach and the working-spot markers only: where it may be built and where a tap walks you go by the one anchor either way.

1. **Pallet rack** — free, holds ×1.8, open all round
2. **Tall rack** — $420, holds ×2.4
3. **Powered rack** — $900, holds ×3

### `freezer`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`browseAt`), and reachable from either end, rotates.

#### Freezer

`freezer` · kind `freezer` · $260 to build

9 parts · 4 stages, driven by tier · **4 boards of goods** (12 facings drawn) · has glass

Shapes: Standard, Chest, Wall run, Wall corner, Wall corner (other way), Endcap — looks only, same price and same ladder.

1. **Glass-door freezer** — free, as built
2. **Sealed freezer** — $260, keeps ×1.5
3. **Display freezer** — $620, holds ×1.5, keeps ×2
4. **Tall display freezer** — $1180, holds ×2, keeps ×2.4

#### Deli

`deli-counter` · kind `freezer` · $240 to build

6 parts · **1 board of goods** (3 facings drawn) · has glass

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

1. **Serve-over** — free, as built
2. **Chilled well** — $150, keeps ×1.8
3. **Butcher’s counter** — $380, holds ×1.3, keeps ×2.6

#### Chiller

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

#### Cold Rack

`cold-rack` · kind `freezer` · $480 to build

23 parts · 3 stages, driven by tier · **5 boards of goods** (15 facings drawn) · has glass

🔄 **Open all round** — no back panel, so it is worked from all four sides rather than three. Reach and the working-spot markers only: where it may be built and where a tap walks you go by the one anchor either way.

1. **Cold rack** — free, holds ×1.8, keeps ×1.4, open all round
2. **Chilled rack** — $560, holds ×2.2, keeps ×1.8
3. **Cold store** — $1100, holds ×2.8, keeps ×2.4

### `warmer`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`browseAt`), and reachable from either end, rotates.

#### Hot Counter

`hot-counter` · kind `warmer` · $260 to build

12 parts · 3 stages, driven by tier · **2 boards of goods** (6 facings drawn) · has glass

💡 Emits `#ffab4f`, intensity 0.55, range 2.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

1. **Heat lamp** — free, as built
2. **Hot cabinet** — $170, keeps ×1.8, open all round
3. **Carvery counter** — $400, holds ×1.3, keeps ×2.6

### `checkout`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`serveAt`), rotates.

#### Till

`checkout` · kind `checkout` · $300 to build

8 parts · 4 stages, driven by tier · no `surface` boards — goods pile on its roof

Shapes: Standard, Express kiosk, Corner counter — looks only, same price and same ladder.

1. **Manual till** — free, as built
2. **Barcode scanner** — $180, speed ×1.4
3. **Belted checkout** — $420, speed ×1.9
4. **Self-checkout** — $900, speed ×1.5, serves itself at ×0.5 speed
5. **Walk-out sensors** — $2400, bills 8 at once, no queue

### `station`

Indoors only, owns its cell (people walk around it), worked from the side it faces (`useAt`), and reachable from either end, rotates.

#### Appliance

`station` · kind `station` · priced by the upgrade that sells its kind

4 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

- ⚙️ **Standard** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Barista** while running — 3 stages across a batch · steams · 1 moving part · the machine itself shake + bobs
- ⚙️ **Blender** while running — 3 stages across a batch · 1 moving part · the machine itself pulses
- ⚙️ **Toaster** while running — 2 stages across a batch · 2 moving parts
- ⚙️ **Press** while running — 3 stages across a batch · 1 moving part · the machine itself shakes
- ⚙️ **Juicer** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Soft-Serve** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Fryer** while running — 3 stages across a batch · steams · the machine itself shakes
- ⚙️ **Oven** while running — 3 stages across a batch · 1 moving part
- ⚙️ **Grill** while running — 3 stages across a batch · 1 moving part · the machine itself shakes
- ⚙️ **Preserver** while running — 3 stages across a batch · steams · the machine itself shakes
- ⚙️ **Stockpot** while running — 3 stages across a batch · 1 moving part · the machine itself shakes
- ⚙️ **Mill** while running — one look throughout · steams · 1 moving part · the machine itself spins
- ⚙️ **Mixer** while running — one look throughout · 1 moving part · the machine itself spins
- ⚙️ **Churn** while running — one look throughout · 1 moving part · the machine itself spins
- ⚙️ **Butcher's Block** while running — one look throughout · 1 moving part · the machine itself shakes
- ⚙️ **Blast Freezer** while running — one look throughout · steams · the machine itself spins
- ⚙️ **Candy Kettle** while running — one look throughout · steams · 1 moving part · the machine itself pulses

⚠️ Covered — Butcher's Block tier 3: 1 of 2 boards (**1 under a lid**). Goods there cannot be seen, so the renderer stocks the boards you can.

⚠️ Covered — Candy Kettle tier 3: 1 of 2 boards (**1 under a lid**). Goods there cannot be seen, so the renderer stocks the boards you can.

Shapes: Standard, Barista, Blender, Toaster, Press, Juicer, Soft-Serve, Fryer, Oven, Grill, Preserver, Stockpot, Mill, Mixer, Churn, Butcher's Block, Blast Freezer, Candy Kettle — looks only, same price and same ladder.

1. **Domestic** — free, as built
2. **Commercial** — $340, speed ×2
3. **Twin** — $420, speed ×2, makes 2 at a time

### `plot`

Outdoors only, blocks nobody, nobody stands at it.

#### Plot

`plot` · kind `plot` · $30 to build

4 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

Shapes: Standard, Timber trough, Cold frame — looks only, same price and same ladder.

1. **Bare earth** — free, as built
2. **Raised bed** — $90, speed ×1.6
3. **Greenhouse** — $260, speed ×2.3

### `pen`

Outdoors only, **2x2 tiles**, owns its cells (people walk around it), worked from the side it faces (`useAt`), rotates.

#### Hen House

`hen-house` · kind `pen` · $120 to build

15 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Hen house** — free, keeps 3 animals
2. **Deep-litter house** — $190, holds ×2.5, speed ×1.5, keeps 6 animals

#### Dairy Shed

`dairy-shed` · kind `pen` · $160 to build

12 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Dairy shed** — free, keeps 2 animals
2. **Milking parlour** — $250, holds ×2.5, speed ×1.5, keeps 4 animals

#### Poultry Run

`poultry-run` · kind `pen` · $140 to build

10 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof · has glass

1. **Poultry ark** — free, keeps 3 animals
2. **Covered run** — $220, holds ×2.5, speed ×1.5, keeps 6 animals

#### Pig Pen

`pig-pen` · kind `pen` · $200 to build

8 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Pig pen** — free, keeps 2 animals
2. **Sty and hardstanding** — $320, holds ×2.5, speed ×1.5, keeps 4 animals

#### Turkey Pen

`turkey-pen` · kind `pen` · $280 to build

7 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Turkey pen** — free, keeps 2 animals
2. **Barn and yard** — $420, holds ×2.5, speed ×1.5, keeps 4 animals

#### Cattle Pen

`cattle-pen` · kind `pen` · $320 to build

10 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Cattle pen** — free, keeps 2 animals
2. **Yard and crush** — $480, holds ×2.5, speed ×1.5, keeps 3 animals

#### Beehive

`beehive` · kind `pen` · $120 to build

23 parts · 2 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Beehive** — free, keeps 3 animals
2. **Apiary** — $190, holds ×2.5, speed ×1.5, keeps 6 animals

### `bin`

Indoors or out, owns its cell (people walk around it), worked from the side it faces (`useAt`), rotates.

#### Skip

`bin` · kind `bin` · $90 to build

6 parts · no `surface` boards — goods pile on its roof

### `belt`

Indoors or out, blocks nobody, nobody stands at it, rotates.

#### Conveyor

`belt` · kind `belt` · $25 to build

5 parts · 3 stages, driven by tier · no `surface` boards — goods pile on its roof · 4 parts move always

1. **Track** — free, as built
2. **Quick track** — $40, speed ×1.8
3. **Maglev track** — $110, speed ×3

### `arm`

Indoors or out, owns its cell (people walk around it), nobody stands at it, rotates.

#### Loader

`arm` · kind `arm` · $90 to build

16 parts · 3 stages, driven by tier · no `surface` boards — goods pile on its roof · 2 parts move always

1. **Loader** — free, as built
2. **Quick loader** — $90, speed ×1.9
3. **Twin loader** — $210, speed ×3.2

### `sorter`

Indoors or out, owns its cell (people walk around it), nobody stands at it, rotates.

#### Sorter

`sorter` · kind `sorter` · $140 to build

13 parts · 3 stages, driven by tier · no `surface` boards — goods pile on its roof · 3 parts move always

1. **Sorter** — free, as built
2. **Quick sorter** — $140, speed ×1.9
3. **Maglev sorter** — $330, speed ×3.2

### `under`

Indoors or out, blocks nobody, nobody stands at it, rotates.

#### Underground

`under` · kind `under` · $60 to build

10 parts · 3 stages, driven by tier · no `surface` boards — goods pile on its roof

1. **Underground** — free, as built
2. **Quick underground** — $95, speed ×1.8
3. **Maglev underground** — $265, speed ×3

## Decorations

They weigh nothing, on purpose. No tile stamped, no generator budget, no working spot reserved — so people walk past them and no shop that was walkable stops being so. Anything that must be walked around is a shelf.

### `prop-floor`

Indoors or out, blocks nobody, nobody stands at it, rotates.

#### Planter

`terracotta-planter` · kind `prop-floor` · $35 to build

5 parts

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Baskets

`basket-stack` · kind `prop-floor` · $20 to build

6 parts

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### A-Frame Sign

`a-frame-sign` · kind `prop-floor` · $25 to build

6 parts

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Money Tree

`money-tree` · kind `prop-floor` · $400 to build

8 parts

💰 **Earns $12 every 180 in-game minutes**, as a pile of cash on its own tile that somebody has to walk over and collect.

✨ Charm **4** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Floor Lamp

`floor-lamp` · kind `prop-floor` · $65 to build

4 parts

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffd7a1`, intensity 1.1, range 4.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Lamppost

`lamp-post` · kind `prop-floor` · $90 to build

5 parts

✨ Charm **2** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffd9a6`, intensity 1.6, range 7 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Bollard Light

`bollard-light` · kind `prop-floor` · $40 to build

4 parts

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffe0b0`, intensity 0.7, range 3.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Awning

`awning` · kind `prop-floor` · $28 to build

8 parts

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Fern

`potted-fern` · kind `prop-floor` · $22 to build

6 parts

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Bay Tree

`bay-tree` · kind `prop-floor` · $70 to build

5 parts

✨ Charm **2.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Window Box

`window-box` · kind `prop-floor` · $30 to build

8 parts

✨ Charm **1.25** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Christmas Tree

`christmas-tree` · kind `prop-floor` · $80 to build

8 parts

✨ Charm **2.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffd08a`, intensity 0.6, range 3.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Bench

`park-bench` · kind `prop-floor` · $75 to build

7 parts

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Bistro Set

`bistro-set` · kind `prop-floor` · $95 to build

9 parts

✨ Charm **2** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Parasol

`parasol` · kind `prop-floor` · $60 to build

4 parts

✨ Charm **1.25** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Bike Rack

`bike-rack` · kind `prop-floor` · $45 to build

7 parts

✨ Charm **0.75** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Barrel

`barrel` · kind `prop-floor` · $26 to build

4 parts

✨ Charm **0.75** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Doormat

`entrance-mat` · kind `prop-floor` · $12 to build

2 parts

✨ Charm **0.25** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Rug Runner

`rug-runner` · kind `prop-floor` · $28 to build

3 parts

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Column

`column-plain` · kind `prop-floor` · $32 to build

6 parts

✨ Charm **1.4** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Square Pier

`column-pier` · kind `prop-floor` · $28 to build

4 parts

✨ Charm **1.2** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Timber Post

`column-post` · kind `prop-floor` · $22 to build

5 parts

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

### `prop-ceiling`

Indoors only, blocks nobody, nobody stands at it, rotates, hangs, so it needs a room to hang in.

#### Pendant Lamp

`pendant-lamp` · kind `prop-ceiling` · $60 to build

3 parts

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffd7a1`, intensity 1.3, range 5.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Aisle Sign

`aisle-sign` · kind `prop-ceiling` · $45 to build

5 parts

✨ Charm **0.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Fairy Lights

`string-lights` · kind `prop-ceiling` · $55 to build

5 parts

✨ Charm **2** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffe0b0`, intensity 0.8, range 4 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Tube Light

`tube-light` · kind `prop-ceiling` · $70 to build

4 parts

✨ Charm **0.25** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#e8f0ff`, intensity 1.5, range 6 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Ceiling Fan

`ceiling-fan` · kind `prop-ceiling` · $110 to build

6 parts · 2 parts move always

✨ Charm **2** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffe1b3`, intensity 1, range 5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Panel Light

`panel-light` · kind `prop-ceiling` · $80 to build

2 parts · has glass

✨ Charm **0.25** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#eef4ff`, intensity 1.3, range 5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Lantern

`paper-lantern` · kind `prop-ceiling` · $45 to build

3 parts

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffdcae`, intensity 0.9, range 4.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Chandelier

`chandelier` · kind `prop-ceiling` · $160 to build

11 parts

✨ Charm **3.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#ffd08a`, intensity 1.8, range 6.5 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Hanging Basket

`hanging-basket` · kind `prop-ceiling` · $50 to build

7 parts

✨ Charm **1.75** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Clock

`hanging-clock` · kind `prop-ceiling` · $55 to build

8 parts · 4 parts move always

✨ Charm **1** — raises how far word of the shop travels (catchment), saturating across the whole shop.

#### Open Sign

`open-sign` · kind `prop-ceiling` · $45 to build

34 parts · 2 stages, driven by tier

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

💡 Emits `#6bffa8`, intensity 0.8, range 3 tiles. (Eight lights are real at once — see `render/lights.js`.)

#### Bunting

`bunting` · kind `prop-ceiling` · $30 to build

5 parts · 4 parts move always

✨ Charm **1.5** — raises how far word of the shop travels (catchment), saturating across the whole shop.

## Paint

Not placed and not a cell either — **a finish for one side of a wall**, painted along a run and priced per face. A face is half an edge, which is why this is its own bucket: the two sides of one wall are two decisions.

### `paint`

A finish for one **side** of a wall. Painted along a run, priced per face, and read by nothing but the renderer — the two sides of a wall are two decisions, and neither can move a tile.

#### Cream

`paint-cream` · kind `paint` · $3 per face

Surface `#e8ded0`, plain repeat. No model — a finish is the wall's own skin.

#### Sage

`paint-sage` · kind `paint` · $4 per face

Surface `#8fa383`, plain repeat. No model — a finish is the wall's own skin.

#### Teal

`paint-teal` · kind `paint` · $5 per face

Surface `#2f6f6a`, plain repeat. No model — a finish is the wall's own skin.

#### Brick

`paint-brick` · kind `paint` · $7 per face

Surface `#9d5240` / `#e0d6c6`, brick repeat. No model — a finish is the wall's own skin.

#### White

`paint-tile` · kind `paint` · $9 per face

Surface `#eef0ee` / `#c8ccc9`, tiles repeat. No model — a finish is the wall's own skin.

#### Brilliant White

`paint-white` · kind `paint` · $3 per face

Surface `#f6f5f1`, plain repeat. No model — a finish is the wall's own skin.

#### Charcoal

`paint-charcoal` · kind `paint` · $4 per face

Surface `#3b3e44`, plain repeat. No model — a finish is the wall's own skin.

#### Deep Navy

`paint-navy` · kind `paint` · $5 per face

Surface `#2c3b56`, plain repeat. No model — a finish is the wall's own skin.

#### Buttermilk

`paint-buttermilk` · kind `paint` · $4 per face

Surface `#f2dda2`, plain repeat. No model — a finish is the wall's own skin.

#### Dusty Rose

`paint-rose` · kind `paint` · $4 per face

Surface `#dcb2ab`, plain repeat. No model — a finish is the wall's own skin.

#### Ochre

`paint-ochre` · kind `paint` · $4 per face

Surface `#c98b3f`, plain repeat. No model — a finish is the wall's own skin.

#### Whitewashed Brick

`paint-brick-white` · kind `paint` · $7 per face

Surface `#e8e1d6` / `#c3baab`, brick repeat. No model — a finish is the wall's own skin.

#### Engineering Brick

`paint-brick-blue` · kind `paint` · $7 per face

Surface `#4d5a68` / `#cdd1d4`, brick repeat. No model — a finish is the wall's own skin.

#### London Stock

`paint-brick-stock` · kind `paint` · $7 per face

Surface `#cfae76` / `#e8e0cd`, brick repeat. No model — a finish is the wall's own skin.

#### Subway Tile

`paint-subway` · kind `paint` · $10 per face

Surface `#f4f3ef` / `#b6b9ba`, brick repeat. No model — a finish is the wall's own skin.

#### Bottle Green Tile

`paint-tile-green` · kind `paint` · $9 per face

Surface `#2f6b52` / `#ded9cc`, tiles repeat. No model — a finish is the wall's own skin.

#### Cobalt Tile

`paint-tile-cobalt` · kind `paint` · $9 per face

Surface `#2a5aa0` / `#e0dcd0`, tiles repeat. No model — a finish is the wall's own skin.

## Ground

Not placed — **painted**, over an area, priced per tile. These have no anchor and block nobody, because they are not standing in a cell, they *are* the cell.

### `floor`

Ground. Painted over an area, blocks nobody, and is purely a **look** — two designs of floor leave byte-identical tiles.

#### Pine

`pine-boards` · kind `floor` · $9 per tile

Surface `#c09a63` / `#a8834f`, planks repeat. No model — ground *is* the cell.

#### Chequer

`chequer-tile` · kind `floor` · $14 per tile

Surface `#e6e2d8` / `#4a4a52`, checker repeat. No model — ground *is* the cell.

#### Concrete

`poured-concrete` · kind `floor` · $6 per tile

Surface `#9b9a94`, plain repeat. No model — ground *is* the cell.

#### Terracotta

`terracotta-tile` · kind `floor` · $16 per tile

Surface `#c2724a` / `#a75f3d`, checker repeat. No model — ground *is* the cell.

#### Slate

`slate-flags` · kind `floor` · $22 per tile

Surface `#5c626b` / `#4a4f57`, planks repeat. No model — ground *is* the cell.

#### Paving

`paving-slabs` · kind `floor` · $7 per tile

Surface `#c9c7c0` / `#b0aea6`, checker repeat. No model — ground *is* the cell.

#### Asphalt

`asphalt` · kind `floor` · $5 per tile

Surface `#4b4d51`, plain repeat. No model — ground *is* the cell.

#### Cobblestone

`cobblestone` · kind `floor` · $13 per tile

Surface `#8d8478` / `#786f64`, checker repeat. No model — ground *is* the cell.

#### Brickwork

`brick-paving` · kind `floor` · $11 per tile

Surface `#a35e49` / `#8b4e3c`, planks repeat. No model — ground *is* the cell.

#### Shop Floor

`shop-floor` · kind `floor` · $6 per tile

Surface `#f0ddb8`, plain repeat. No model — ground *is* the cell.

#### Dark Oak Boards

`dark-oak-boards` · kind `floor` · $12 per tile

Surface `#7a5334` / `#63422a`, planks repeat. No model — ground *is* the cell.

#### Parquet Blocks

`oak-parquet` · kind `floor` · $18 per tile

Surface `#b98b4e` / `#96692f`, checker repeat. No model — ground *is* the cell.

#### Clay Paviors

`clay-paviors` · kind `floor` · $13 per tile

Surface `#ab5238` / `#cabfae`, brick repeat. No model — ground *is* the cell.

#### Mosaic Tiling

`mosaic-tile` · kind `floor` · $17 per tile

Surface `#38707f` / `#ded9cc`, tiles repeat. No model — ground *is* the cell.

#### Marble Tiling

`marble-tile` · kind `floor` · $20 per tile

Surface `#f0eee7` / `#cfccc2`, tiles repeat. No model — ground *is* the cell.

#### Sage Lino

`sage-lino` · kind `floor` · $5 per tile

Surface `#7d9878`, plain repeat. No model — ground *is* the cell.

#### Oxblood Lino

`oxblood-lino` · kind `floor` · $5 per tile

Surface `#8c3f3a`, plain repeat. No model — ground *is* the cell.

#### Steel Deck

`steel-deck` · kind `floor` · $9 per tile

Surface `#8f959c` / `#7b828a`, checker repeat. No model — ground *is* the cell.

### `bay`

Ground. Painted over an area, blocks nobody, and carries a **job**: wholesale orders land here, and how big you paint it is how many crates it holds.

#### Loading Bay

`loading-bay` · kind `bay` · $8 per tile

Surface `#ddd3bd` / `#d3c8b0`, checker repeat. No model — ground *is* the cell.

### `drop`

Ground. Painted over an area, blocks nobody, and carries a **job**: hands are cleared here and stock waits, and how big you paint it is how much waits at once.

#### Storage

`stockroom-floor` · kind `drop` · $8 per tile

Surface `#e6d6b4` / `#dbcaa6`, planks repeat. No model — ground *is* the cell.

### `break`

Ground. Painted over an area, blocks nobody, and carries a **job**: staff take their breaks here, and how big you paint it is how many of them it seats at once.

#### Break Room

`break-room` · kind `break` · $12 per tile

Surface `#eadcc4` / `#e0d1b5`, checker repeat. No model — ground *is* the cell.

### `park`

Ground. Painted over an area, blocks nobody, and carries a **job**: shoppers who drive here leave the car, and how big you paint it is how many of them can.

#### Car Park

`car-park` · kind `park` · $10 per tile

Surface `#79808c` / `#98a0ad`, planks repeat. No model — ground *is* the cell.

### `paddock`

Ground. Painted over an area, blocks nobody, and carries a **job**: animals graze here, and how big you paint it is how many head a pen you stand in it holds.

#### Grazing

`paddock-grazing` · kind `paddock` · $1.40 per tile

Surface `#9ab069` / `#accb78`, tufts repeat. No model — ground *is* the cell.

#### Muddy Yard

`paddock-yard` · kind `paddock` · $1.10 per tile

Surface `#7d6a4e` / `#8d7a5c`, tufts repeat. No model — ground *is* the cell.

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

### `lawn`

Ground. Painted over an area, blocks nobody, and is purely a **look** — two designs of land leave byte-identical tiles.

#### Turf

`lawn-turf` · kind `lawn` · $0.40 per tile

Surface `#8ec96b` / `#a5d982`, tufts repeat. No model — ground *is* the cell.

#### Meadow

`lawn-meadow` · kind `lawn` · $0.60 per tile

Surface `#86c164` / `#9fd47c`, tufts repeat. No model — ground *is* the cell.

#### Mown Lawn

`lawn-mown` · kind `lawn` · $1.10 per tile

Surface `#93cf70` / `#88c465`, checker repeat. No model — ground *is* the cell.

#### Dry Scrub

`lawn-scrub` · kind `lawn` · $0.30 per tile

Surface `#b3b072` / `#c7c286`, tufts repeat. No model — ground *is* the cell.

#### Bare Earth

`dirt-bare` · kind `lawn` · $0.20 per tile

Surface `#a8763f` / `#96693a`, plain repeat. No model — ground *is* the cell.

#### Packed Dirt

`dirt-packed` · kind `lawn` · $0.25 per tile

Surface `#9c7040` / `#8d6234`, checker repeat. No model — ground *is* the cell.

#### Mud

`dirt-mud` · kind `lawn` · $0.25 per tile

Surface `#7d5530` / `#6b4626`, checker repeat. No model — ground *is* the cell.

#### Dust

`dirt-dust` · kind `lawn` · $0.20 per tile

Surface `#c4a878` / `#b39a6c`, checker repeat. No model — ground *is* the cell.

#### Rutted Track

`dirt-rut` · kind `lawn` · $0.30 per tile

Surface `#9c7040` / `#7d5530`, planks repeat. No model — ground *is* the cell.

#### Burnt Grass

`grass-burnt` · kind `lawn` · $0.20 per tile

Surface `#6b6255` / `#544b40`, tufts repeat. No model — ground *is* the cell.

#### Dead Grass

`grass-dead` · kind `lawn` · $0.25 per tile

Surface `#b9a86a` / `#cdbc7e`, tufts repeat. No model — ground *is* the cell.

#### Patchy Grass

`grass-patchy` · kind `lawn` · $0.30 per tile

Surface `#9aab63` / `#8fc45e`, tufts repeat. No model — ground *is* the cell.

#### Moss

`grass-moss` · kind `lawn` · $0.80 per tile

Surface `#6fae5c` / `#83c46f`, tufts repeat. No model — ground *is* the cell.

#### Clover

`grass-clover` · kind `lawn` · $0.70 per tile

Surface `#7cc46a` / `#93d47f`, tufts repeat. No model — ground *is* the cell.

#### Wildflower

`grass-wildflower` · kind `lawn` · $1.20 per tile

Surface `#86c164` / `#e8c05a`, tufts repeat. No model — ground *is* the cell.

#### Long Grass

`grass-long` · kind `lawn` · $0.50 per tile

Surface `#7fb85c` / `#94cc70`, tufts repeat. No model — ground *is* the cell.

#### Gravel

`land-gravel` · kind `lawn` · $0.35 per tile

Surface `#a8a49c` / `#948f86`, checker repeat. No model — ground *is* the cell.

#### Sand

`land-sand` · kind `lawn` · $0.30 per tile

Surface `#dfc99a` / `#d0b988`, checker repeat. No model — ground *is* the cell.

#### Bark Chip

`land-bark` · kind `lawn` · $0.50 per tile

Surface `#9a6b45` / `#85593a`, planks repeat. No model — ground *is* the cell.

#### Weeds

`land-weeds` · kind `lawn` · $0.15 per tile

Surface `#9c8f5e` / `#a8bd5e`, tufts repeat. No model — ground *is* the cell.

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

