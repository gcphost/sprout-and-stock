# Pens — the animal that is a building

Status: **built.** One `pen` build kind, seven authored pieces, a `verify:pens`
sweep, and the seven animal *crop* rows retired. It is also the first fixture in
the game that takes more than one tile, which is most of what this document is
about.

---

## The hole

**Animals were crops, and the sentence that made you say was wrong.**

[docs/production.md](production.md) needed milk, eggs, pork, beef, poultry,
turkey and honey to come from somewhere, and there was already a shape for
"wait, then collect": a crop. `chicken-coop` had been one since the first week,
so five more animals and a beehive were authored the same way and every number
worked.

What did not work is what you did with them. You put down a **raised bed**, you
opened its **seed picker**, and you **sowed a cow**. Then, every time you
collected the milk, you sowed the same cow again — because a bed exhausts and
auto-replant is a convenience that spends a seed. Nobody re-sows a cow.

The tell is that the whole rhythm a plot exists for is *wrong here*. Turning
soil, choosing a seed and paying for it, and the bed going back to rough is a
loop about **planting**, and an animal is not planted. It is bought once, and
after that it is looked after.

---

## The shape

> A pen is a **fixture** you put down in the field. It holds an animal, it fills
> up on its own clock, and you collect from its gate. There is no soil, no seed
> and no sowing, because what you bought was the pen.

### One kind, seven pieces

`pen` is a single row in `FIXTURES` ([shared/build.js](../shared/build.js)).
The seven animals are seven rows in the `fixtures` table:

| Piece | Makes | A batch | Every | Costs |
|---|---|---|---|---|
| Hen House | egg | 7 | 2.2 min | $120 |
| Dairy Shed | milk | 7 | 2.6 min | $160 |
| Poultry Run | poultry | 4 | 2.9 min | $140 |
| Beehive | honey | 4 | 3.2 min | $120 |
| Pig Pen | pork | 4 | 3.8 min | $200 |
| Turkey Pen | turkey | 2 | 4.8 min | $280 |
| Cattle Pen | beef | 3 | 5.1 min | $320 |

Kinds are code and pieces are content, so an eighth animal is a row somebody
authors and not a branch somebody adds. What differs between a beehive and a
cattle pen is its art, its price, what it makes and how fast — and not one of
those is a rule.

`produces` on the piece is `{item_id, qty, every}`, and `every` is in-game
minutes exactly as `yields.every` is. It is a **separate field from `yields`**
rather than a third key on it, and the split is the one `yields` already argues
for itself: cash goes onto the floor as a pile anybody walks over, goods go into
the pen and wait. Two destinations, two readers, two ways of running out — a pen
fills up and stops, a money tree never does.

### The ladder is a stockpile and a pace, and they are different things

`speed_mult` is **how often you have to come**. `capacity_mult` is **how long
you may leave it**. At tier 1 they are the same number, so a basic pen holds
exactly one batch and then stalls — which is the honest answer to "what does the
first rung do".

A rung that bought three times the room and also handed over three times the
goods would be one knob wearing two names, so `produces.qty` is the piece's and
the ladder never touches it. `verify:pens` asserts both halves.

### The centrepiece: a full pen STOPS

`stepPens` accrues nothing while `qty >= cap`, and pins `filledAt` to now every
tick it stands full. Two things fall out and both are the feature:

- **`capacity_mult` is worth paying for**, because the alternative to buying
  room is walking out there more often.
- **Leaving one full costs you the production.** A pen is not a hopper: an
  animal that stood full all night has been standing there, not banking batches.
  Collect at noon after a dawn fill and the next batch is a whole batch away.

Uncapped, none of that exists — a pen would be a machine that prints goods
overnight, the trip out would be worth nothing, and you would never have to
think about one again after you bought it.

### Collecting is `harvest`'s ending, not an appliance's

The shoulder, then the hands, then the ground. `handOver` is that rule, extracted
so `harvest` and `collectPen` cannot disagree about what a full pair of hands
means — a crate first (which is what halves the trip on a row of anything), then
what fits in the arms, then a box at your feet for the rest.

The alternative was `collectStation`'s hands-only loop, and the argument against
it is where the thing stands: a pen is out in the field beside the beds, worked
the way the beds are worked. An appliance's tray is indoors next to a belt and a
loader, where a crate on the shoulder is somebody else's job.

There is **no refusal for full hands**, for `harvest`'s reason: nothing this shop
produces is destroyed for want of somewhere to put it.

### The crew: it is a farm job, and it is the first one

`farm` folds to `collect || harvest || sow || till`, and collecting goes above
picking. The argument is the same one the fold already makes about harvest over
sow over till: **a full pen has stopped**, where a ripe bed merely sits there. So
collecting is the one farm job that puts something back into production, and a
shop with a big field would otherwise never reach the animals.

Gated by `hasSomewhere` rather than `hasHome`, for the measured reason
[docs/workers.md](workers.md) gives about `harvest`: the drop-off is the buffer
and the pen is the overflow behind it.

---

## Two tiles on a side

A pen is the **first fixture in the game to occupy more than one cell**, and it
had to be. At one tile a cattle pen was the same size as a jar of jam.

`size: 2` lives on the **kind** and not on the piece, and that is forced rather
than chosen: `canPlace` is in `shared/`, it is pure, and it has never seen the
catalog — a footprint that came off a `fixtures` row would mean the one function
that decides whether a thing fits having to resolve a placement to a content row
to find out. It is also the right shelf for it. How much floor a thing takes is
behaviour in exactly the sense `blocks` and `where` are, and a variant may never
move a number.

Three functions are the whole of it, and every caller goes through them rather
than adding 1 to something:

- `footprint(kind, x, z)` — the cells. `x, z` is the **min corner**, because
  everything that indexes a cell is an integer.
- `footprintMid(kind, x, z)` — where the art stands. Whole tiles for anything
  one cell wide, so nothing that was drawn at `f.x, f.z` moved on the day this
  landed.
- `covers(f, x, z)` — does this fixture stand on that cell.

### What that broke, and what each failure would have looked like

Each of these is a place where "a fixture is a tile" was load-bearing and
nothing about the code looks wrong afterwards:

- **`canPlace`** tested the ground, the occupancy and the bounds of the ORIGIN.
  A 2x2 whose far corner was off the map, on a belt or under a shelf would have
  been accepted on the strength of its corner being clear, and `occupy` would
  then stamp the cells anyway — a fixture built through another one.
- **`occupy`** stamped one cell, so three quarters of every pen would have been
  walkable. Shoppers strolling through a cattle shed, which is the same failure
  the loader had when `blocks` was flipped in one of the two places.
- **`blockedAt`'s `ignoreId`** forgave the origin only. A 2x2 shuffled one square
  along overlaps three of its own cells, so a pen would have been refused for
  standing where it already was — which reads as a pen that cannot be moved.
- **`whatThisBlocks`** lifted and set down one cell, so the stranding flood
  answered about a shop with a hole in it and the warning fired on the placement
  that was fine.
- **`anchorTile`** was origin-plus-one, which for anything bigger than a tile is
  a spot **inside the thing**. The gate would have been in the middle of the pen,
  the generator would have reserved a cell it had just occupied, and nobody could
  ever have collected. It takes a `size` now and reduces exactly to the old
  answer at 1.
- **`fixtureAt`** compared `f.x === x`, which answers "is this its corner" — right
  about one cell in four. A pen you can only point at from one end.
- **The renderer** stood the art at `f.x, f.z`, which for a block is a whole tile
  up-screen of the ground it covers, and **the ghost** drew a one-tile cage — a
  preview that promises a square and takes four, with the three it does not draw
  being exactly the ones a refusal would be about.

The models are authored in one tile and scaled to the footprint at author time
rather than in the numbers, because the numbers are what a body looks like
relative to the thing it stands in: a cow half the length of its own shed is
wrong at any scale. Wider than taller, because the footprint doubled and the
roofline did not.

### The next sized kind

`footprint` does **not** turn with `rot`, and for a square it need not. The day
something wants 1x3, that function is the one place that has to learn about
facing — which is the whole reason nothing else is allowed to compute cells.

---

## Two clocks, two models

One resolver takes ONE 0..1 number and a pen has two: which rung it is on, and
how full it is. That is exactly why an appliance has both `model` and `work`
(see [docs/kitchen.md](kitchen.md)), and a pen uses the same split rather than
inventing a third mechanism:

- **`model`** is staged by **tier** — the pen you bought, with its animal in it.
  The animal is in here and not in `work`, because a pig pen with no pig in it is
  not a pig pen.
- **`work`** is staged by **how full it is**, drawn over the pen and gone when it
  is empty — eggs in a tray, churns at the gate, jars of honey. It is what makes
  a pen read as *ready* from across the field, which the bar and the bubble
  floating over it cannot do at that distance.

Spending the tier's number on fullness was the tempting mistake and it would mean
a pen that stops showing you which one you bought.

There are three readouts and each answers a different question: the **bar** is
the next batch, the **bubble** is what there is to collect, and the **`work`
model** is that, seen from across the shop. A bed shows the first two and never
both at once, because a crop is ripe or it is growing; a pen routinely shows both,
since it goes on filling while yesterday's eggs are still standing in it. That
falls out of `syncFillOverlay` taking two arguments rather than branching.

---

## Retiring the crops

The seven animal crop rows are gone, and the order mattered. `plotGrowth` answers
0 with no row, so `stepCrops` never rings the bell, `harvest` refuses out loud,
and the farmhand's `hasSomewhere` reads `undefined` and walks past. That adds up
to a bed you own, cannot pick, cannot sow, and can only get back by noticing it
is dead and pressing Empty — with nothing anywhere saying so, and a frozen bed
and a slow one being the same picture of the same soil. Eleven live beds across
four worlds were sown with one at the moment of the delete.

So `binOrphans` clears them, and three things about where that sits:

- **The roll and not the delete**, for `binOrphans`' own reason: an unknown crop
  is forgiven everywhere else (a re-flow keeps the bed exactly as it keeps an
  unknown item's stock), and a day is the grace in which somebody can put the
  row back.
- **The standing crop is lost rather than crated**, and that is honest rather
  than lazy: what a ripe bed holds is `crop.item_id`, and the row that says so is
  precisely the row that has gone. There is nothing left to name.
- **The soil comes back turned**, which is `droppedPlacements`' argument about
  refunding at full price: you did not choose this, the catalogue did.

---

## `verify:pens`

Everything about a pen is invisible twice over — a pen that is filling and one
that stalled hours ago are the same still frame, and the shop is the same shop
afterwards either way. Only the clock moved. So the sweep is the only thing that
can see any of it.

Its **control is doubled**, because two things have to stay opt-in: a shop that
has never bought a pen (an empty list, no tick, no save row) and a piece with no
`produces`, which is what every fixture row ever authored looks like and which
must never fill.

Its **centrepiece** is that filling stops, paired with the claim that a full pen
is not secretly running. Then the four traps CLAUDE.md already names, aimed at
this feature: **R** (`repositionFixture` names every field it keeps, and a pen's
contents deliberately are not among them — they ride a re-flow through
`carryOver` the way a bed's crop does), **the re-flow** build mode fires on every
wall segment of a drag, **`elapsed` restarting at zero** so the clock is saved as
how long it *has* filled, and **out and back being two different pieces of code**
— the half that shipped missing for five steps when `paint` did it, asserted
through the store rather than by handing a `Game` an object.

Plus conservation, the roof holding the clock rather than resetting it, the
deleted-item case being *forgiven* while a pen with no `produces` is *refused*
(which is `harvest`'s split exactly), and a farmhand walking out to empty one.

One assertion in it is not about pens at all and earned its place on the first
run: `build()` asserts the pen it just placed resolved to the piece it asked
for. A content write that is refused leaves the row absent, `pieceFor` falls
through to `defaultPiece`, and every number in the file is then measured against
a **shipped** pen — which fails in twenty places, none of them saying why.

---

## What is not built

- **No pen is seeded.** Nothing procedural puts an animal in a shop, so every
  existing save opens with an empty list and plays exactly as it did.
- **No upgrade sells a discount on them.** `fixtureDiscount` reads the `upgrades`
  table by kind and `pen` is not in that enum; adding it is one row and one enum
  entry the day somebody wants it.
- **Nothing feeds them.** A pen produces out of nothing, which is the same
  bargain a crop strikes about soil. An animal that ate grain would be a second
  hopper and a second way for the farm to jam, and it is a much bigger decision
  than it looks — see the kitchen's argument about what a machine you have to
  stand and watch is worth.
- **`simulate` is blind to it.** The balance bot never places a pen, so a run
  measures nothing here and the figures in the table above are arithmetic against
  what the crops they replace were worth per minute, not a measured result.
