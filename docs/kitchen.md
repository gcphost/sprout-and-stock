# Kitchen — an appliance that makes more than one thing

Status: **step 1 built. 2–4 proposed.**

The mechanic is in and guarded (`verify:kitchen` §10), and the ladder now climbs
to it: **Domestic $0 → Commercial $340 (×2 speed) → Twin $420 (×2 speed, two
heads)**. A machine below the top rung is a one-headed machine and plays exactly
as it always did, which is the whole of what makes this opt-in.

---

## What is already there, and what is not

Multiple recipes per appliance have never gone away. `recipesFor(station)`
returns every recipe whose `station` column matches, and the soft-serve has had
two since it was seeded. What went away is the machine **choosing between them
on its own**: `nextBatch` used to take the first recipe the hopper happened to
satisfy, so a blender loaded for salsa with yesterday's jam still in it made
smoothies, and "how many tomatoes does this take" had no answer until you knew
what it was doing. `stationRecipe` (`server/sim/index.js`) settled that — a
machine knows several and **runs one**, and `null` on the record reads as the
first it knows rather than as idle.

So a coffee machine that also makes hot chocolate is **one recipe row today**,
no code at all. What you cannot do is have it making both.

What has landed since this file was first written, all of it load-bearing on
step 1:

- **A machine holds four of everything.** `STATION_BATCHES` is 4, and it is
  what a station's `capacity_mult` finally reads (`stationBatches`). The hopper
  takes four batches of each ingredient the set recipe calls for; the tray takes
  four batches of the output. An appliance used to hold exactly one of each and
  stop dead between them.
- **`verify:kitchen` exists** — nine sections, and it is the instrument step 1
  has to answer to. See below.
- **The snapshot carries `batches` and `progress`** per station, beside
  `contents`, `making`, `output` and a **resolved** `recipe`. The client draws
  `2 / 8` against a hopper off `batches` and its own copy of the recipe.
- **The bays are read off the art.** `stationWells` collects every `surface`
  part; `buildStationBays` sorts them by x, calls the front-most the tray and
  gives the rest to the hopper. Ingredients across the back, the finished thing
  at the front.
- **Both funnels grade.** `loadStation` and `collectStation` each take a `max`
  — a tap is one unit, a hold is the lot — and `loadStation` takes a `from`, so
  a machine can be fed off the shoulder as well as out of your hands.
- **A stockroom is a larder for the machines nearest it** (`larderRanges`), and
  the chef fills a hopper out of it rather than fetching one batch at a time.
- **Eleven variants**, not ten: `stock-pot` joined. The `variants` cap in
  `shared/schemas.js` is 16, and its comment is worth reading before adding a
  twelfth — since every appliance in the game is a variant of the one `station`
  row, that bound is how many *machines the shop may ever own*.

Three facts about the shape of the thing, because each one costs something
below:

- **Every appliance in the game is a variant of one `station` piece.** Eleven
  variants over one shared tier ladder (Domestic, Commercial). A rung added to
  that ladder is a rung on all eleven.
- **The record is singular in five places.** `recipe`, `making`, `startedAt`,
  `busyUntil`, `output` are one each. `contents` — the hopper — is a flat
  item→qty map sized by the recipe it is set to.
- **The readouts are singular too.** One bay group, one work overlay, one
  progress bar, one hum, all stood at the machine's origin.

---

## The hole

An appliance is a decision you take once and then live with. A shop with one
coffee machine sells one hot drink; wanting two means owning two machines,
which is two tiles, two hoppers to keep topped up and two walks. And the tier
ladder above it sells *speed* — the shipped Commercial rung is `speed_mult: 2`
and `capacity_mult: 1`, so it is the same one thing twice as fast, which is more
of a decision you have already taken rather than a new one.

The tell is the coffee machine. Nobody has authored hot chocolate for it,
because there would be no point: setting the machine to hot chocolate is
setting it away from coffee.

---

## Step 1 — a rung buys a slot

**Built.** What follows is what it does and why it is shaped that way; the
sections that were predictions when this was written are marked where the code
went somewhere else.

**One new number on the tier: `lines`.** How many recipes this machine may be
**set to at once**, default 1. Every appliance that exists today is 1 and does
not move.

Above 1 it is a twin machine: each slot holds its own recipe and runs its own
batch, in parallel, out of one shared hopper. That is the whole feature — the
rung does not change *which* recipes the machine knows, only **how many of them
you may pick**.

It passes the rule the ladder is held to. `capacity_mult`, `keeps_mult`,
`speed_mult` and `unattended` are the only knobs the sim reads, and *a tier that
changes no number is a button that takes money and does nothing* — `lines` is a
fifth, and it is read by `nextBatch`, by the hopper, and by the menu.

### The record grows a list

`st.lines` — an array of `{ recipe, making, startedAt, busyUntil, output }`,
one per slot, read through `stationSlots`/`stationRecipes`/`stationHeads`. A
record with no `lines` reads as **one slot built from the old flat fields**: a
read-time default rather than a migration, the same bargain `kindOf` and
`shell.z` strike, so an old record, an old save and a fresh seed all agree with
no ceremony.

One thing that was *not* obvious until it was written: the read-time default
**deletes the five old fields** as it folds them in. Leaving them beside the
head that now owns them is two spellings of one tray, and the stale one reads
perfectly correct right up to the moment somebody collects — the head empties,
the flat field still says six waiting, and whichever of the two a reader happens
to ask decides what the shop believes. Three sweeps were poking those fields
directly (`verify:kitchen`, `verify:orphans`, `verify:build`) and now go through
the accessor, which is the point: a sweep asserting against the *shape of the
record* passes until somebody moves a field and says nothing useful on the day
they do.

Slots are also **sliced to the tier on the way out**, so a machine that has
stepped down a rung stops running the head it can no longer afford. That slice
is only safe because `tierShortfall` refuses the step down while anything is set
to, cooking in or waiting on that head — take the guard away and this is where a
batch would silently disappear.

`persist` writes `hoppers` as `{ id, recipe }` per station, filtered to the ones
that have made a choice, for the reason the comment there gives — `dev:server`
runs under `node --watch`, so every edit to `server/` is a restart, and a
restart that handed every machine back to its first recipe would quietly repoint
the kitchen. That row carries a **list** of recipes now, and a row with the old
single field folds into slot 0. `restoreContents` writes it back raw and
unvalidated on purpose (a recipe may have been deleted while the shop was shut,
and `stationRecipe` already falls back for exactly that) — a list has to keep
that property per slot rather than refusing the whole row.

### The hopper stays one bin

Both heads draw from it. `stationHopperCap` is what the recipe it is set to
calls for times the batches it holds; with two slots it is the **sum over the
slots**, and everything downstream of it — what the machine will take from your
hands, what the shop buys for it, what the larder holds, what `tierShortfall`
refuses a downgrade over — goes on working.

Splitting the hopper per slot is the wrong answer and it is worth saying why,
because it is the first thing anybody would reach for. Two hot drinks that both
want milk is *the* case this feature exists for, and two bins would make you
load the same milk twice into the same machine. One bin is also what keeps the
number a player can act on: "3 tomatoes a batch, four batches, twelve" survives,
it just has two recipes adding into it.

`loadStation`'s `wanted` filter becomes the **union** of the slots' inputs, and
its refusal message has to name more than one recipe or it says "the blender is
making Fresh Salsa — no use for milk" at a machine that is also making
smoothies. The piles it has no use for still stay in your hands.

Two slots racing for the last tomato is settled by slot order, not by a draw.
`stepStations` walks the heads in order; the first slot that can start, starts.
Nothing random happens, so nothing moves the rng stream and no balance run
diverges over it.

One consequence worth stating, because it is what makes the second head worth
buying rather than decorative: **order is only ever a tie-break.** Head 0 wins a
contested ingredient every time, so the only thing that makes head 1 run is head
0 being unable to — no ingredients of its own, or its own tray full. That is
what the second tray is *for*, and it is why `stationTrayRoom` is per head: with
one shared tray, head 1 would be blocked by head 0's output and the rung would
sell a head that never ran.

### Two trays

`stationOutputRoom` keeps "one product at a time" true **per slot** rather than
per machine — the rule is what stops a batch being made and then thrown away,
and it is asked before starting, which costs nothing.

`collectStation` sweeps **both** trays. Hands already take mixed armfuls, and
one reach into a machine holding two finished things coming out with both is
the same call `unload` makes about a mixed crate. The wrinkle is the grade:
`max` is how a tap takes one unit, and with two trays "one unit" needs an order
to come off — slot order, said out loud, until step 2 lets the pointer name a
tray. It answers with `goods` (a list) beside the `item_id` every caller written
when there was one tray still reads.

The chef's collect (`craft` in `server/sim/staff.js`) sorted *stations* by
`st.output.qty` and took the fullest; it sorts over **trays** now, or a twin
machine is serviced half as often as it fills — which reads as a chef ignoring a
full tray that is plainly standing there. `feasibleRecipe` walks the heads and
stops at the first that could be finished *and* has somewhere to put the result,
so a blocked head is stepped over rather than committed to — the old
fewest-missing deadlock does not come back with the second candidate.

### The picker becomes a list of ticks

`recipeRows` in `client/fixture-menu.js` says today:

> A machine knows several recipes and runs ONE, so this is a picker rather than
> a list of checkboxes — the shape a seed picker takes, not the shape a shelf's
> reservations take.

With slots that inverts. It is the shelf-reservation shape now, with a ceiling:
tick up to `lines` of them, and the row that would be the `lines + 1`th is dead
with the ceiling said on it — rather than silently swapping something out, since
a tick list that quietly drops one to take another lies about what a press does.

**On a one-headed machine it is still a picker**, and that is the half that
matters: pressing another row *replaces*, exactly as it always did, and the row
it is already on is the dead one. The tick behaviour only appears on a machine
that has somewhere to put a second tick.

`station-recipe` carries the whole list (`recipeIds`), because the batch lesson
applies: a client sending N single messages to change two slots is N log lines
for one press. It is one of the last fixture messages in `server/rooms/shop.js`
that does **not** go through `bulkFixtures` — its neighbours (`assign`,
`restock-order`, `shelf-hands`) all take `targets(m)`. Those are two different
axes and both are real: *which machines* is `bulkFixtures`, *which slots on one*
is this. `recipeId` is still read, so the old single-machine call still works.

Server-side, `setStationRecipes` **matches the list against the heads already
running it** before filling the rest, so re-ordering the picker never shuffles a
batch from one head to another. Two heads on one recipe is refused by
de-duplication: that would be a rung buying throughput, which is not what this
sells.

The detail panel (`fx-detail`, same file) prints one block per head with its
ingredients counted against the hopper, and names every tray that has something
on it. The hopper line stays one, and the per-ingredient ceiling is **summed
over the heads** — two heads that both want milk want it once, and a per-head
ceiling would have the same pile reading as full against one block and half
empty against the other.

---

### The rung

`{ name: 'Twin', cost: 420, speed_mult: 2, lines: 2 }`, third on the `station`
ladder. Two things about the numbers.

It **keeps the rung below it** (`speed_mult: 2`). Tiers are absolute rather than
cumulative, so a Twin that dropped back to ×1 would be a step up you lose by
climbing — you would pay $420 to halve the machine you already own.

And $420 is priced against **buying a second machine**, which is the thing it
replaces: appliances cost $150–320, so a twin is dearer than any of them, and
what the premium buys is the tile, the walk and one hopper instead of two. It is
a play-tested number rather than a measured one, because `simulate` cannot see
it at all — the balance bot never runs an appliance, so a kitchen change measures
as no change over ten seeds. That is the instrument being blind, not the change
being free.

`verify:kitchen` authors its **own** Twin rung on its own test piece rather than
leaning on this one, so the sweep still passes if somebody reprices or removes
the shipped rung.

---

## The traps

Seven, and five of them are invisible in a screenshot.

**One resolver takes ONE number, and there are two clocks now.** This is the
thing CLAUDE.md already records about appliances: `model`'s 0..1 is spent on
the tier, `work`'s is spent on how far through the batch it is, and that is why
an appliance has two models. Two slots at different progress is a *third*
quantity and it does not get a third model — it gets the `work` model **drawn
once per slot**, each at its own slot's offset, each with its own `progress`.
`syncStationWork` keys its rebuild on `${st.station}:${stageIndexAt(model, t)}`
and keeps one `rec.work`; that record grows a list the same way the sim's does.
The progress bar is the same claim: one bar per running slot, or a twin machine
running two batches tells you about one of them.

**`making` is a boolean that three loops read as "this machine is on".**
`animateStations` hands `st.making` to `animateMotion` as the working flag, the
audio bed's `loops()` filters `state.stations` on it to decide which hums are
open, and `syncStations` uses it to put the bar up and take the bays down. With
slots it is *any slot making* — which is one derivation, in one accessor, and
three call sites that must not each answer it their own way. A machine running
one of its two heads should hum, and should not draw the idle bays for the head
that is running.

**The wells have to group into columns.** `buildStationBays` sorts every
`surface` part by x, calls the front-most one the tray and gives the rest to the
hopper. A twin machine authors two of those pairs, and they group by z — each
column's front-most well is that column's tray. Read off the art the way
`surfacesAt`, `seamStep` and `drawableBoards` are, never authored as an index,
because an index taken beside the parts is the `verify:motion` bug: drop a seam
past it and it spins the box next door.

It also needs a fallback, because no machine has been drawn with two pairs yet:
a machine whose art has only one gets both heads' bays stood in **lanes** across
it, offset along the machine's own z. A single head takes lane 0, so a shop that
never bought a rung draws exactly what it drew before, to the millimetre.

**Eight of the eleven appliances have no second-stage art**, and the nuance
matters. Every variant now authors a `work` model (most of them three stages),
so a machine that is *running* looks like it is running — that is done. What
only three of them author is `stages` on the `model` itself: the coffee machine,
the blender and the toaster. The other eight already draw a Domestic machine
when you pay for Commercial. A Twin rung with no stage 3 anywhere is a rung that
moves a real number and no picture, which is the opposite failure to the usual
one and reads exactly the same from inside the shop: you bought something and
nothing happened. **The art is the feature here** — a twin machine that looks
like a single machine is a slot you have to open a menu to discover.

**Everything that asks what a machine is making was singular, and there were
twelve of them.** In `server/sim/index.js`: `stationWants` (which is what puts
an appliance in `stockTargets`, so it decides whether a machine lights up under
a full pair of hands), `stationHopperCap`, `nextBatch`, `stationOutputRoom` (now
`stationTrayRoom`, taking a head), `loadStation`'s `wanted` filter,
`tierShortfall`'s station branch, and the snapshot's `recipe`. In
`server/sim/staff.js`: the `done` sweep and the `hungry` filter in `craft`,
`wants()`, `feasibleRecipe()`, and `larderOrder()`. Plus the client's own
`stationRecipe`, in both `fixture-menu.js` and `scene.js`. Each was right and
each was a place a second slot goes quietly missing — the shape `STOCK_KINDS`
and the hot counter record: **a rule written as one answer is silently wrong the
day there are two**, and the fix is one accessor rather than twelve call sites
remembering.

Four more turned up in the writing, all of them the same shape and none of them
in the list above: `binOrphans`' tray sweep, `dumpStation`'s Empty,
`fixtureContents` (which is what greys Remove out), and `interact`'s proximity
branch. Each reads one tray, each looks completely correct, and each would leave
goods behind on a machine with two.

`stationRecipe` survives as its own verb, answering for the **first** head only,
because most of the shop still has one honest question about a machine — and
because every appliance anybody owns has exactly one head. Anything that means
"everything this machine is making" wants `stationRecipes`, and the difference is
a whole head going quietly missing.

`applianceInputs` is the exception and is worth knowing about, because it looks
like it belongs on that list and does not: it is already the union of *every*
recipe the machine knows, deliberately, and `larderRanges` is built on it. A
stockroom stocks for what its nearest machine *could* take, not for what it is
set to. Slots change nothing there.

**The way down.** `tierShortfall` already had a station branch — it refuses a
downgrade *before any money moves* when the smaller hopper could not hold what
is in this one, or the smaller tray could not hold what is waiting. A twin
stepping back to a single is a third clause in that same branch: two recipes set
and one slot below, refused, with the recipe you would lose named. Refunding
half of the rung you step **off**, not the one you land on, as ever.

It has to go **first**, before the ingredient check, and that is not tidiness.
The hopper's ceiling is the sum over the heads that *survive*, so a machine about
to lose a head fails the ingredient test on the way past — and what you would
read is a refusal about tomatoes when what you are about to lose is a recipe.
Same ordering rule `buyStock` learned about charging before checking the bay.

**`npm run docs:fixtures` will call your new rung a dead one.** The generator
names the four knobs three times — once to blurb a tier, once in the `flat` test
that decides whether a rung moved anything, and once in the ⚠️ block that lists
rungs which take money and change no number. A `lines` rung that is not added
there is printed in the authoring reference as exactly the trap it is not. That
is the same disagreement `drawableBoards` exists to close, pointed at a warning
instead of at a lid.

**`simulate` is blind to all of it.** The balance bot never runs an appliance,
so a kitchen change measures as no change over ten seeds — the instrument being
blind, not the change being free. Judge this one in play, and in the sweep.

---

## What `verify:kitchen` pins

The sweep did not exist when this file was written, and it is what decides
whether step 1 is opt-in or a change to every save in existence. Nine sections
were already there, on an ephemeral `Game`, authoring recipes onto one throwaway
appliance (`zz-kit-urn`) and removing them on exit:

1. the hopper's ceiling is four batches and the overflow stays in your **hands**
2. loaded and left alone, it runs itself down — the regression the file is named
   for, one `continue` away at all times
3. the tray has a ceiling too, and a full one stops the machine
4. a machine that knows two recipes makes the **one** it is set to — and 4b,
   that the choice survives a re-flow and a save round trip
5. `capacity_mult` moves a hopper
6. one chef fills a hopper rather than fetching a batch at a time
7. a shop with no back of house still works, one batch at a time
8. a kitchen with nowhere to put the result **stops** rather than piling it up
9. a tap is one, a hold is the lot, in both directions

Note section 4: it is the *singular* claim, written when singular was the
feature. It stays true — a machine with one slot makes the one it is set to —
and step 1 kept it that way rather than editing it, which is precisely the
control. All nine sections still pass as written. What changed in them is only
*where they read a tray from*: `head(g, st).output` instead of `st.output`,
because asserting against the shape of the record passes until somebody moves a
field and says nothing useful on the day they do.

Section 10 is the new one, and its loudest claim is the first:

- **The control.** A rung with no `lines` is one head, its hopper is sized to
  its one recipe, and a second recipe is refused. This is what decides whether
  the feature is opt-in.
- **Two heads, one bin.** The cap is the sum, and one press of a mixed armful
  loads for both.
- **Both heads run and both trays fill**, with the hopper emptied — conservation
  across the new place goods move between.
- **Head order is the tie-break**, on two recipes that want the same ingredient:
  the first head takes the last batch's worth and the second waits rather than
  splitting it. Paired with the claim that keeps that from being a dead head —
  block the first head's tray and the second runs.
- **One reach takes both trays**, and a tap still takes exactly one.
- **The way down refuses before the money moves**, with the lost recipe named
  and no cash moved either way.
- **A re-flow and a save round trip keep both heads, in order.**

Two things in section 10 are worth knowing before extending it. The tie-break is
asserted on the **tray** rather than on `making`, which lasts one in-game minute
and is therefore a stopwatch race with the sweep's own step loop — the same trap
`verify:break` names about a charge that ran out. And the downgrade case turns
build mode **on** first: `urn()` leaves it off because that is the state a player
touches a machine in, and without it the refusal lands for "not in build mode",
which is a pass for the wrong reason that would keep passing however the head
rule was broken.

---

## What is deliberately absent

- **The tier does not gate WHICH recipes.** A `min_tier` on `recipes` would
  make a rung an unlock, which sounds like the same feature and is not: it
  would take a recipe *away* from a machine on a downgrade, and it would mean a
  recipe authored this afternoon can be invisible in a shop that owns the
  machine for it. What the rung sells is how many at once.
- **No per-slot hopper.** See above — it defeats the case the feature is for.
- **No third clock.** A slot is a recipe and a batch. It is not a queue, it does
  not have its own speed, and it takes no separate ingredients. Anything that
  wants those is a second machine, which the shop can already buy.
- **Slots are not named or routed.** Nothing decides which slot a hire loads or
  collects; the hopper is shared and the trays are swept together.
- **The larder is not split.** `larderRanges` already answers for every recipe a
  machine knows, so a second slot asks it nothing new.

---

## Proposed

**Step 2 — the pointer names a tray.** Step 1 sweeps both, and its tap picks a
slot by order to take its one unit. A twin machine with two things
waiting is the same question a shelf with three piles on it answers with
`pickAim`: each tray group carries its slot, the marker goes round the pile
rather than round the tile, and a tap takes one while a hold takes the lot. The
machinery is all there now — `pickFixtureHit` already hands back which board you
meant, and `boardBox` already cages a pile rather than a tile. Only worth it
once twin machines exist and people are standing at them.

**Step 3 — an appliance priced on its catalog row.** Not this feature, but it
is in the way of it, and it is now the *next* step in docs/building.md rather
than a distant one. An appliance is still the one fixture priced by the upgrade
that sells it — `fixtureUnitCost` branches on `kind === 'station'` and reads
`stationUpgrade(station).cost`, where every other kind reads `cost` off its own
row. A machine whose rungs sell slots wants its price and its ladder in the same
row as its art.

**Step 4 — a third slot, or an appliance-specific ladder.** The ladder is
shared across all eleven variants today, so "Twin" is twin for the fryer and the
preserving pot alike. If that turns out to be wrong — a twin oven is a
different idea from a twin coffee machine — the answer is a ladder per variant,
which is a bigger change to the catalog than it looks and should wait until
there is a case for it rather than a suspicion.
