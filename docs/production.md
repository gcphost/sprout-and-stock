# Production — everything on the shelf came from something

Status: **built.** 29 items, 15 crops, 6 appliances and 68 recipes are live and
exported; the variants cap is the only code that changed. What is NOT decided is
the one thing this turned out to rest on — see **The van problem** below, which
is a balance fork rather than a bug and is waiting on a call.

This is the content half of [docs/belts.md](docs/belts.md) step 4 and
[docs/kitchen.md](docs/kitchen.md). Both of those are about machinery, both are
finished, and neither has anything to carry. This is the graph.

---

## The hole

**Intersect every recipe's outputs with every recipe's inputs and the answer is
the empty set.**

24 recipes, and not one of them eats another's output. Every single one is raw
goods in, finished product out, one hop, done. `wheat → sourdough`. There is no
`wheat → flour → dough → loaf`.

Which means the shop has:

- a conveyor that carries crates between machines (`armFeed`, `armTake`)
- a sorter that routes by what is down the line
- twin machines that run two recipes out of one hopper
- stockrooms, loaders, spurs, backpressure

…and **no reason to use any of it**, because nothing needs to be anywhere twice.
A belt between two machines has never been worth laying, and it never will be
until something downstream wants what the machine upstream made.

The second half is worse. Of the 24 distinct recipe inputs, **18 are van-only**:
milk, cheese, bread, jam, coffee, mince, bacon, sausages, pasta, mustard, mayo.
Only six come from the farm. So "make my own goods" is not a long-term goal you
have not reached yet — it is **unreachable by construction**. There is no amount
of building that gets you there.

The recipe book was authored in the first week, against a game with one
appliance and no belts. It is not wrong; it is from a different game.

---

## The shape

> **You buy raws. You make goods.** The van sells you what the land cannot grow
> and what a grocer would never make; everything edible on your shelves has a
> path back to a bed, a pen or a crate off that van.

Three tiers, and the rule for which one a thing is in:

| Tier | What it is | Where it comes from | Sold? |
|---|---|---|---|
| **Raw** | Nothing makes it | A crop, an animal, or the van | Some (a carrot is a carrot) |
| **Intermediate** | Made from raw, made *into* something | An appliance | Sometimes — see below |
| **Finished** | Made, and the point of making it | An appliance | Always |

### The line: food is craftable, household and tropics are not

This is the load-bearing decision and it is the one that keeps two finished
subsystems alive.

`docs/ordering.md` and `docs/deliveries.md` are a supplier, a standing order, a
van, a lane, a dock and a cutoff — a lot of built game whose entire premise is
that you need somebody to bring you something. Make everything craftable and all
of it becomes a convenience for people who cannot be bothered, which is a strange
thing to have spent seven steps on.

So the van keeps a monopoly on two things:

- **Household.** Soap, batteries, bin bags, kitchen roll, washing-up liquid,
  wrapping paper. A grocer does not make soap. Nobody has ever wanted them to.
- **Tropics and the sea.** Coffee, cocoa, rice, salt, oil, vinegar, sea fish.
  These are the ore. Factorio does not let you craft iron ore either, and the
  reason is the same: a graph with no leaves is a graph with no shape.

Everything else — every loaf, every wheel of cheese, every sausage, every jar —
comes from a bed or a pen, through a machine, onto a board.

### An ingredient is an item nobody wants, and that needs no code

Some intermediates should not be sellable. Dough, curd, pastry and batter are
things a shop *has*, not things a shop *sells*, and a board of them is a board
wasted.

There is already a way to say that, and it costs nothing:

```js
const desire = desireFor(item, archetype.affinities);
if (desire <= 0) return 0;                    // server/sim/economy.js:219
```

**⚠️ This was written as "property tags score zero desire" and that is FALSE.**
It is left here with its correction because the mistake is the more useful half,
and it is the exact trap CLAUDE.md keeps naming.

`desireFor` ([shared/tags.js:230](shared/tags.js#L230)) sums the affinity of
**every** tag on the item. Nothing in it distinguishes a property tag from a
category tag — so the claim only holds if no archetype has an opinion about
handling, and one does: **`bulk-shopper` wants `shelf-stable` at 0.9 and `bulky`
at 0.8**, because "big, cheap, keeps for ever" is a real shopper and those were
the honest tags to say it with. It was true of every item in the catalogue until
this document authored items that carry *nothing else*.

The audit found `groundnuts` and `mustard-seed` scoring **1.9** — better than
most of the shop — while this file called them ingredients nobody buys. Both are
now tagged as the retail products they actually are, along with `stock`.

What survives, and it is weaker than advertised: an item tagged **only**
`perishable` picks up 0.1 from `morning-regular` and nothing else, so `dough`,
`pastry`, `batter` and `curd` have a residual ~4% browse chance rather than
zero. That is quiet enough to live with and it is **not** the zero the design
asked for. A real "not a retail product" needs `desireFor` to return 0 for it
outright, which is one clause in `shared/tags.js` and is **not built** — the tag
list is `.min(1)`, so there is no way to say it in content today.

The general shape, for the third time in this repo: **a rule that holds because
of what is absent from a table stops holding when you add rows to it.** Same as
`groundKindOfTile`'s `?? null`, same as the `chilled` boolean meeting a third
kind of shelving.

The corollary is that making something sellable is also free: give flour
`pantry` and `cheap` and it is a product. Which is the nice accident this genre
has and Factorio does not — **most intermediates in a grocery chain are things
somebody would buy.** Nobody wants a green circuit. Everybody wants butter.

### The crafting margin, or depth is a tax

A chain that costs more than it earns is a chain nobody builds. Every recipe has
to clear:

```
output_qty × output.base_price  ≥  1.4 × Σ(input_qty × input.base_price)
```

40% over the sum of the parts, before the tag multipliers and the season swing
`suggestedPrice` applies on top. That number is a starting point rather than a
law, and the reason it has to be *stated* is that it is invisible: a recipe that
loses money looks exactly like a recipe that makes money, both of them produce
goods, and the shop cheerfully runs it all day. The only tell is the takings, and
the takings have thirty other things in them.

Two consequences worth knowing before authoring:

- **A raw sold raw must be worth less than the same raw cooked.** Wheat is $1.60
  and sourdough is $4.60, so milling and baking is worth doing. If it were not,
  the farm would be the whole game and the kitchen a hobby.
- **Depth has to pay per hop, not just end to end.** `wheat → flour → dough →
  bread` is three machines and three walks. If flour is where all the margin is,
  nobody builds the last two. Spread it.

### Depth is capped at three

Raw → intermediate → finished. Occasionally four where it is the joke (`milk →
curd → cheese`, aged in the preserving pot). Never more.

Factorio earns its twelve-deep graph with a hundred hours and a research tree.
This is a shop game that a nine-year-old plays with his dad, and the point at
which a chain stops being legible is the point at which it stops being fun. If a
chain cannot be drawn on a napkin, it is too long.

---

## The appliances

Eleven exist: Barista, Blender, Toaster, Press, Juicer, Soft-Serve, Fryer, Oven,
Grill, Preserver, Stockpot.

Every one of them is a **finishing** machine — it takes things that are already
food and makes them into a meal. There is not one **primary processing** machine
in the game: nothing turns a grain into a flour, a milk into a curd, a carcass
into a cut. That is exactly why the graph is one hop deep. You cannot build a
second stage when there is no first one.

Six new, and they are the missing verbs rather than more of the same:

| Machine | Verb | Turns |
|---|---|---|
| **Mill** | grind | wheat → flour, sugar beet → sugar, groundnuts → peanut butter |
| **Mixer** | combine | flour + egg → dough, pastry, batter, pasta, mayo |
| **Churn** | separate | milk → cream, butter, curd |
| **Butcher's Block** | cut | beef → mince, pork → sausages and bacon, birds → portions |
| **Blast Freezer** | freeze | anything → the frozen version of itself |
| **Candy Kettle** | boil sugar | sugar + flavour → gummies, liquorice, chocolate |

### The cap is 16 and eleven plus six is seventeen

Every appliance in the game is a **variant of the one `station` row**, so
[shared/schemas.js:661](shared/schemas.js#L661)'s `.max(16)` is not "how many
shapes may a shelf come in" — it is *how many machines the shop may ever own*.
The comment there already says so, and already says raising it is safe: a variant
carries a model and no numbers, so nothing added can move the balance.

**16 → 24.** Six now and room for the ones nobody has thought of.

### The Blast Freezer is the one that is not obvious

The other five are shapes anybody would guess. This one exists because `frozen`
is a **category with six items in it** (peas, berries, chips, pizza, lollies,
fish fingers) and not one of them had any way to come into being — freezing is
the only verb in a grocer's building that the Soft-Serve was standing in for, and
it was standing in badly, because a soft-serve makes ice cream and a blast
freezer makes *everything else cold*.

It is also the one that makes a genuinely deep chain: `dough + cheese + tomato →
oven → pizza → blast freezer → frozen pizza`. Two machines, two crates, one belt
between them, and the belt is finally the short way round.

---

## The raws

### Grown — a crop row, and an animal is a crop

`chicken-coop` already establishes it: a pen is a crop whose `item_id` is what it
yields and whose model stages are the animal. There is no animal system to build.

Existing six: carrot, lettuce, tomato, wheat, kale, egg.

New:

| Row | Yields | Note |
|---|---|---|
| Potato Patch | potato | crisps, oven chips, hot chips |
| Berry Canes | berries | jam, frozen berries, smoothies, gummies |
| Sugar Beet Row | sugar-beet | the input to half the graph |
| Pea Row | peas | frozen peas |
| Apple Trees | apple | juice, soda, cider, chutney |
| Chilli Row | chilli | hot sauce |
| Mustard Row | mustard-seed | mustard |
| Groundnut Row | groundnuts | salted peanuts, protein bars |
| **Dairy Shed** | milk | milk is *bought* today, which is the single oddest thing in the catalogue |
| **Pig Pen** | pork | bacon, sausages |
| **Cattle Pen** | beef | mince |
| **Poultry Run** | chicken | portions, roast |
| **Turkey Pen** | turkey | `seasons: ['winter']`, so the Christmas bird is seasonal production |
| Beehive | honey | cereal, protein bars |
| Flower Bed | flowers | already an item, already sold, never makeable |

### Bought — the leaves of the graph

Never craftable, ever, and that is the point:

- **Pantry imports:** coffee, cocoa-powder, rice, salt, cooking-oil, vinegar
- **Sea:** salmon-fillet, white-fish
- **Household:** soap, batteries, bin bags, kitchen roll, washing-up liquid,
  wrapping paper

Salt, oil and vinegar are new items and they are worth the three rows: they are
what make a preserving pot a preserving pot, and they put a permanent small line
on the van that no amount of farm can remove.

---

## The intermediates

| Item | From | Machine | Sellable? |
|---|---|---|---|
| flour | wheat | Mill | **yes** — `pantry`, `cheap` |
| sugar | sugar-beet | Mill | **yes** — `pantry`, `cheap` |
| cream | milk | Churn | **yes** — `dairy`, `premium` |
| butter | cream | Churn | **yes** — `dairy`, `classic` |
| chocolate | cocoa + sugar + milk | Candy Kettle | **yes** — `candy` |
| curd | milk + vinegar | Churn | no — property tags only |
| dough | flour + egg + butter | Mixer | no |
| pastry | flour + butter | Mixer | no |
| batter | flour + egg + milk | Mixer | no |
| stock | bones/veg + salt | Stockpot | no |

Five sellable, five not, and the split is the test of whether the tag rule above
actually works. A shop that mills wheat and sells the flour is a shop making
money one hop in, which is what stops the first stage feeling like homework.

---

## What the graph looks like

Three chains drawn out, because a table of sixty recipes is unreadable and these
are the three that carry the design.

**Bread — the chain that proves depth**

```
Wheat Field ─→ wheat ─[Mill]→ flour ─┐
Chicken Coop ─→ egg ────────────────→├─[Mixer]→ dough ─[Oven]→ bread
Dairy Shed ─→ milk ─[Churn]→ cream ─[Churn]→ butter ─┘
```

Four machines, three intermediates, two of them sellable on the way past. This is
the one to build first and the one to look at when deciding whether any of it is
fun.

**Frozen pizza — the chain that needs a belt**

```
dough + cheese + tomato ─[Oven]→ pizza ─[Blast Freezer]→ frozen-pizza
```

Short, and the only chain in the game where the *second* machine is the whole
point. Two appliances that must be adjacent or connected, which is the first time
this game has ever asked that question.

**Cheese — the chain that is a joke about time**

```
Dairy Shed ─→ milk ─[Churn + vinegar]→ curd ─[Preserver]→ cheese
```

The preserving pot is already the slowest machine in the game. Ageing a cheese in
it is the one place a long `minutes` is the feature rather than a cost, and the
$8.50 wheel at the end is the best margin on the board.

---

## The van problem — the consequence nobody costed

**`buyStock` refuses to sell you anything a recipe produces.**

```js
if (this.isCrafted(itemId)) {
  return err(`${item.name} has to be made in an appliance, not ordered`);
}
```

[server/sim/index.js:8172](server/sim/index.js#L8172), and its stated reason is
good: *without this the supplier sells the finished product too and the
appliances are pointless.* It has been there since appliances existed and it
cost nothing, because 24 recipes meant 24 items you could not order out of 78.

Authoring this graph made it cost a great deal. **68 of 103 items are now
craftable, so 68 of 103 are no longer orderable.** What the van will still sell
you is exactly the raws and the household aisle — 35 rows:

> carrot, coffee, egg, lettuce, milk, tomato, wheat, salmon, kale, cocoa,
> potato, berries, sugar beet, peas, apple, chilli, mustard seed, groundnuts,
> pork, beef, poultry, turkey, honey, salt, oil, vinegar, rice, white fish,
> and the six household lines.

That is *precisely* the sentence at the top of this document — you buy raws, you
make goods — arriving as a much bigger change than the sentence sounds. **A new
shop can no longer order a loaf of bread.** It can order wheat, and then it needs
a mill, a mixer and an oven before it has anything to put on a bakery shelf.

Three honest readings, and this is a decision rather than a defect:

1. **Leave it.** This is the game the document describes and it is the most
   Factorio-shaped answer: the shop starts as a farm with a counter and every
   department you open is a production line you built. It is also a hard reset of
   the first hour, and every balance figure in the repo predates it.
2. **Grandfather the shipped catalogue.** A `buyable` flag on the item row, set
   on the ~40 finished goods that existed before today, so the van keeps selling
   bread and cheese at full retail while your own bakery makes them at a quarter
   of the price. Vertical integration becomes a *margin* play rather than an
   unlock, which is what "the end goal is margin" argued for. Costs one column
   and one clause in `buyStock`.
3. **Gate it on the milestone ladder.** The van stops stocking a department once
   you can make it. Ties into `server/sim/goals.js`, which is already a ladder of
   measurements, and is the most work.

**Nothing here picks one.** Option 2 is the smallest change that keeps the
opening hour intact and is the one to reach for if the first playtest of a new
world feels empty; option 1 needs no code at all and is what is live right now.

### What it broke in the sweeps, which is the same lesson twice

Three assertions failed on the first full run, in two files, and neither was
about production:

- `verify:yard`'s `orderable()` helper was `items.filter((i) => i.stack > 0)` —
  a name that claimed one thing and a test that checked another. It only ever
  agreed with `buyStock` because almost nothing had a recipe. It now asks
  `isCrafted`, the same question `buyStock` asks.
- `verify:hand` picked its working item as `AMBIENT[0]` and its perishable as
  the shortest `shelf_life_days`. The first landed on `bread`, which is crafted,
  so the shop could never order for the board and **every restock assertion
  failed with "restocking never fired at all"** — which reads as the ordering
  being broken. The second landed on `stock`, which is `shelf-stable`, so it
  never rots: that pick was *already* wrong, because `spoilRate` ignores the span
  on a shelf-stable row, and it had simply never been handed one set to 0.

The shared lesson, and it is CLAUDE.md's own shape: **a sweep that picks a live
content row by a loose filter is asserting about whatever the catalogue happens
to hand it**, and it fails in the file that grew the catalogue rather than in the
file that is wrong. Both helpers now ask the real question — `isCrafted` for
orderable, `shelf-stable` for rots, and the affinity table for "somebody will
actually buy this" — so they track the content rather than a catalogue that was
dependable once.

---

## The traps

**`simulate` cannot see any of this.** The balance bot never runs an appliance,
so a graph of sixty recipes measures as **no change over ten seeds**. That is the
instrument being blind, not the change being free — and it means the entire
economic weight of this document is unmeasurable by sweep and has to be
play-tested. Every number in here is a judgement, and it should be written down
as one rather than dressed up with a sweep that was never looking.

**Reworking an existing recipe changes a shop that is running.** The 24 recipes
are live in `shop-3` right now, on machines somebody has set. `stationRecipe`
falls back when a recipe is deleted out from under a machine
([docs/kitchen.md](docs/kitchen.md)), so nothing crashes — but a machine set to
Fresh Salsa whose recipe now wants vinegar it has never been given simply stops,
and what that reads as is the kitchen breaking. **Rework by editing inputs, never
by delete-and-recreate**, or every machine in the shop is repointed at whatever
its first recipe happens to be now.

**An item deleted with stock on the shelf is `binOrphans`' problem, and it is a
day of grace.** If any of the 78 items are retired rather than rewired, expect
crates to sit for a day and vanish at the roll. Prefer rewiring.

**A new raw with the wrong tags is dead stock and it is invisible.** CLAUDE.md's
flattest content rule. `list_tags` before every row, and note that for the
*ingredients* in this document the usual advice is inverted — matching nothing is
the objective, and the way to get it wrong is to accidentally include a category
tag and have shoppers start buying your dough.

**Six new machines is six new `work` models.** [docs/kitchen.md](docs/kitchen.md)
records that eight of the eleven existing appliances have no second-stage
`model` art, so they draw a Domestic machine when you have paid for Commercial.
Do not add six more to that pile: a machine that cannot be seen working is a
machine you cannot tell is on, and that is the bug the `work` model exists to
fix.

**The recipe book gets bigger than the item list.** Sixty-odd recipes against
~105 items. `recipesFor(station)` is a filter over all of them on every ask —
fine at this size, worth knowing at three times it.

---

## What is deliberately not done

- **No research tree.** Milestones (`server/sim/goals.js`) are already a ladder
  of measurements and already pay out three ways. A tech tree gating recipes
  would be a second progression system disagreeing with the first, and it would
  make a recipe authored this afternoon invisible in a shop that has not
  "unlocked" it — the same objection [docs/kitchen.md](docs/kitchen.md) makes
  about `min_tier` on recipes.
- **No fluids.** Milk and oil are crates like everything else. A second
  granularity is the "loose units on a belt" argument again and it costs the
  seventh place goods can live.
- **No byproducts.** One output per recipe. A recipe that produces whey as well
  as curd is a second thing to route, and routing is the sorter's job at a
  junction rather than a machine's job at a tray.
- **No spoilage of intermediates into anything.** Rot goes in the skip
  ([docs/waste.md](docs/waste.md)). Compost that feeds the farm is a lovely idea
  and it is a loop, and a loop is the one shape this graph does not have.
- **No power.** [docs/belts.md](docs/belts.md) step 6, and it stays last for the
  reason given there: it re-prices every appliance in the game.

---

## Build order

1. **The cap.** `.max(16)` → `.max(24)` in [shared/schemas.js](shared/schemas.js).
   One character, and nothing else can be authored without it.
2. **The raws.** ~15 crop rows and ~6 new bought items. No recipe depends on a
   machine, so this is playable on its own the day it lands: a farm with pigs in
   it.
3. **The six machines.** Variants on the `station` row, each with a `model` and a
   `work` model. This is the slow part, because it is art.
4. **The intermediates.** Ten items, five of them deliberately unsellable.
5. **The recipes.** ~55 new, ~15 existing ones rewired to eat made goods rather
   than bought ones. The rewiring is riskier than the authoring — see the traps.
6. **Play it.** There is no sweep that can tell you whether this is fun, and
   `simulate` will report that nothing happened.

Steps 2–5 are content and land through `POST /api/content/:kind`, so two people
can author at once and no file is touched. Step 1 is the only code in the whole
document.

**All six are done.** What the graph came out as, measured rather than intended:

| | |
|---|---|
| Items | 78 → **103** (29 new) |
| Crops | 6 → **21** (15 new) |
| Appliances | 11 → **17** |
| Recipes | 24 → **68** |
| Outputs something else eats | 0 → **25** |
| Deepest chain | 1 → **4** (`wheat → flour → dough → bread → toast`) |
| Recipes clearing the 1.4× margin | **68 / 68** |
| Food with no path from raw | **0** |
| Ingredients nobody will ever buy | **10** |

Five of those 68 were **already losing money** before today — `latte`, `toast`,
`toastie`, `hot-dog` and `bacon-roll` each returned less than the sum of their
inputs, and had done since they were authored. Nothing anywhere reported it; the
shop ran them all day. They were corrected by raising output quantity rather than
item price, which would have rippled into everything that eats them. That is the
margin rule earning its place on the first run, which is the same thing the
`verify:*` sweeps keep doing.
