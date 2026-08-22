# Pens — the animal that is a building

Status: **steps 1 and 2 built.** One `pen` build kind, seven authored pieces, a
`verify:pens` sweep, and the seven animal *crop* rows retired. It is also the
first fixture in the game that takes more than one tile, which is most of what
step 1 is about. Step 2 took the animal out of the art and put it on the grass —
see [the paddock](#step-2--the-paddock-and-the-animals-that-roam) at the bottom.

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

## Step 2 — the paddock, and the animals that roam

Step 1 shipped a pen whose animal was a **decal on a shed**. `hen-house` had a
hen in its model, the hen was at rot 0 where the modeller left it, and it stood
there for the life of the save. A farm made of those is a photograph of a farm.

The three things that were wrong are separable, and all three are now done:

1. **An animal is a body**, not a part of the building it came out of.
2. **The pen stopped carrying its own fence.** Five of the seven had rails
   painted on them, which is scenery pretending to be a rule.
3. **How many animals is a number you can raise** — by painting a field.

### A head is a DIVISOR on the one clock

This is the whole mechanism and everything else is a consequence of it.

```
penFill = (minutes elapsed × speed_mult × HEADS) / produces.every
```

Nothing else moves. One clock, one stockpile, one stall, one Collect at one
gate — every mechanism step 1 built survives verbatim, and `verify:pens` still
passes nearly whole.

The obvious fork is *each animal produces* against *the field produces and the
animals are the picture of it*, and both are wrong in their pure form. Four hens
each with their own clock is four clocks, four trays, four stalls and four
collect verbs for a thing the player experiences as one gate. And animals that
are only a headcount readout are the "tier that changes no number" trap wearing
feathers — a visible thing that means nothing.

**Heads is a third knob and not a rename of either**, which is the split the
section above already argues: `speed_mult` is how often you must come,
`capacity_mult` is how long you may leave it, and `heads` is **how many**.
`penCap` is untouched by the paddock, so a bigger field fills the *same*
stockpile faster rather than a bigger one at the same rate — fold the two
together and a big field needs emptying at the same interval a small one does,
which is the decision gone.

**One head is step 1's numbers to the digit**, which is the control the whole
step rests on. No shop that has never painted a paddock moves by a cent.

### The paddock supplies them; the RUNG is the ceiling

```
heads = clamp(paddock cells / 4 / shelters sharing it,  1,  tier.heads)
```

Both, and neither alone.

- **Grazing alone** is one brush stroke buying an unbounded divisor on the
  clock, which is a printer.
- **A rung alone** is a number you buy with no land behind it, and the fence and
  the acre stop meaning anything.

So you need enough grazing *and* a shelter big enough, and whichever you are
short of is the one to spend on next. That is a decision; either half on its own
is a formality. The pen's menu names which, because "out of grazing" and "out of
shelter" are the same count on the same line and opposite things to do about it.

Small animals crowd in and big ones do not, which is the one thing about a pen a
player knows before the game tells them:

| Piece | Keeps | Upgraded |
|---|---|---|
| Hen House | 3 | 6 |
| Poultry Run | 3 | 6 |
| Beehive | 3 | 6 |
| Dairy Shed | 2 | 4 |
| Pig Pen | 2 | 4 |
| Turkey Pen | 2 | 4 |
| Cattle Pen | 2 | 3 |

**Every tier-1 keeps at least two, deliberately.** A rung whose ceiling is 1 is a
pen a paddock can never help, and what that reads as is the brush being broken.

`heads` **defaults to 1**, for `lines`' reason: it is a count of bodies and every
pen ever built keeps the one it always did. So a pen row authored before any of
this existed is step 1's pen — one animal, whatever you paint round it — and
that is the honest answer rather than a convenience. It is also why all seven
shipped pieces set the field: *a working system with no content in it is
indistinguishable from a broken one*, which is what happened to `charm`.

### The paddock is PAINTED, and that is the load-bearing decision

`GROUND.paddock` → `T.PADDOCK`, the fifth pad, laid with the same brush the
delivery bay is. **`PEN_CELLS_PER_HEAD` is 4** — a 2×2 of grazing per animal,
the same square the shelter itself takes, so a field painted eight by four reads
as eight animals without anybody counting.

The alternative was a *fenced flood*: you already have wall edges, gates and
signed ways through, so "a paddock is whatever your fence encloses" is the
sentence the feature was asked for in. It is the wrong shape here, and the first
reason is fatal on its own.

- **Enclosure in this game is shop-wide and all-or-nothing.** `computeIndoor`
  answers *zero* indoor cells for a breached shell, so a paddock would need a
  second flood of its own, re-run on every re-flow — and build mode re-flows on
  every wall segment of every drag.
- **A gate left open** is a paddock that is silently the whole map, or silently
  nothing, with no reading on screen either way.
- **A fence drawn for the look of it would start deciding the balance**, which
  breaks the rule a variant lives under: a shape may never move a number.

So the rails are scenery and the paint is the rule. Draw a fence round it
because a farm has fences, not because the game is counting them.

Two things fall out rather than being decided. A pad is **never buildable**
(`BUILDABLE_OUTDOOR` is bare grass), so the shelter stands on grass and its
paddock is the region it *touches* — which is right anyway, since you do not
build on the delivery bay either. And `paddockOf` is a flood over **tiles**, so
a fence drawn *across* a paddock does not divide it: if you want two fields,
leave a cell of grass between them.

### It is the region it TOUCHES, and it is DIVIDED

`paddockOf` floods four-connected from the cells around the block, and never
reads every paddock cell on the map. That is `dropGoods`' bug said about
grazing — a pad is one named region in as many pieces as you painted it — and it
would be worse here than a wrong shelf: a field at the top of the farm would
fatten a coop at the bottom of it, so the paint and the animals would be two
unrelated facts that happen to be on one save.

And the heads are split between the shelters standing in the same field. The
land supports what it supports: without the division, one big paddock with six
hen houses in it is six pens each dividing by the whole acreage — a money
printer built from one brush stroke and a repeated purchase, and one that reads
as working perfectly the entire time.

### The bodies: a third population, in memory, on the Game

`Game.animals` is a `Map`, and each of the three words in that sentence is a
decision.

**A third population, and not a third kind of person.** `this.players` means
"somebody with hands" and `this.customers` means "somebody who might buy
something". Putting a pig in either is the `inACar` trap at a size that would be
very hard to unpick: `stepMood` drains patience over the shoppers,
`measureOccupancy` counts the crush, `moodAverage` averages them, `payWages`
pays the roster. Every one of those is right today and silently wrong the moment
a cow is in the list — and none of them would look wrong afterwards. What the
third list costs is the snapshot, the renderer and `animateActors`, which came
to four lines because `syncActors` has never known what it is drawing.

**In memory, and not saved.** An animal is not a thing you own — the shelter and
the paddock are, and both are already on the save. The count is re-derived from
the paint every tick, so the only thing a reload loses is where a hen happened to
be standing. That also means there is no `elapsed` stamp in here to get wrong and
no new field for `Game.create`'s named-field payload to forget.

**On the Game rather than on the layout record**, which is the one placement that
had to be argued. A pen's *contents* ride a re-flow through `carryOver`, but a
re-flow **rebuilds** the record — so bodies filed there would snap back to the
shelter on every wall segment of every drag. That is `parkNow`'s bug exactly: a
car that began its approach again on each re-flow is a customer who never
arrives, and a herd that teleports home whenever you build a fence is a herd you
can only watch by putting the tools down.

**No draw comes out of `this.rng`.** Every balance number in the game is
downstream of how many times that stream has been called, so wandering livestock
would move every basket, crop and spawn roll after it — and two `simulate` runs
either side of *authoring a hen* would diverge with nothing to say why. `hash01`
costs no draw, gives the same animal the same amble on every machine, and makes
the balance provably untouched because nothing random happened.

### One cell at a time, which is the only thing keeping them in

`stepAnimal` steps to the **next cell along** and never to a cell picked out of
the field at large. There is no pathing, no edge test and no enclosure question
anywhere in this — the set of legal cells *is* the answer — but that is only true
while a leg cannot leave the set, and a leg is a straight line. A paddock painted
round an L-shaped fence, or in two lobes joined by a neck, has cells the straight
line goes through that are not in the field.

**This was a real bug and the sweep caught it on the first run**: 122 strays over
four hundred seconds. What it looks like is a pig strolling across the shop floor
between two bits of its own pen, which is the one failure in this feature a
screenshot can catch and the one that would be blamed on the pathing. Four-
connected rather than eight, because a diagonal clips the corner of the two cells
it passes between and either of those may be the car park.

### `body` is a third model

`model` is the shelter, staged by **tier**. `work` is what a thing looks like
while it is running, staged by **how far through a batch** it is. `body` takes no
0..1 at all — one pen draws as many copies as the paddock is worth, each
somewhere different, so it is not a stage of anything. That is why it is a third
model rather than more parts on the first one, and it is the same argument
[docs/kitchen.md](kitchen.md) makes about `work`.

Authored in one tile, standing at the origin, **nose east** like every other
piece of fixture art — and turned a quarter in `Scene.buildAnimal`, because
`syncActors` sets `rotation.y = facing`, which is the +z-forward reading meant
for a character whose nose is a nub on +z. `vehicleYaw` exists for exactly this
collision and this is its second meeting. A hen authored east and turned by a
body's facing walks sideways for ever, and at this zoom a chicken is nearly
symmetric: it reads as odd art rather than as a quarter turn.

`body` is null on **beehive**, deliberately and for ever. A bee wandering about
on the ground is not a picture of anything, and a hive being the whole of what
you see is right. Heads are counted off the paint either way — a piece nobody has
drawn an animal for runs exactly as many head as one somebody has, and draws none
of them — which is what keeps `body` a look.

### What the art pass cost

All seven pieces lost their animals; five lost a fence. **`cattle-pen` was
entirely fence, cows and troughs**, so stripping it left a field with two troughs
in it and nothing to collect from — it gets the open-fronted field shelter the
other six already had in some form.

The one number a player cannot see is now on the pen's own menu (**Grazing**),
and the one-head line names the paddock rather than reporting a 1: every pen in
every shop that has never painted one says this, and "1 animal" reads as working
when what it means is that there is a whole brush you have not found.

---

## What is not built

- **No pen is seeded.** Nothing procedural puts an animal in a shop, so every
  existing save opens with an empty list and plays exactly as it did. The same
  is true of the paddock: nothing paints one, so every save is one head.
- **A loader collects one**, since step 4b of [docs/belts.md](belts.md) — a
  conveyor beside a pen empties its gate onto the run, the way it lifts a
  finished tray off a machine. A belt still cannot be laid *on* a paddock (a pad
  is never buildable), so a run goes around the field and reaches in.
- **Nothing feeds them**, still. See the step 1 note above; roaming makes it
  tempting and none of the argument against it has changed.
- **Animals are not obstacles.** They block nobody and nothing routes around
  them, which is why there is no pathing in any of this. A shopper walking
  through a cow is possible and has not been seen to matter.
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
