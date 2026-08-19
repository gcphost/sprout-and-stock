# Kitchen — an appliance that makes more than one thing

Status: **all proposed.**

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

Three facts about the shape of the thing, because each one costs something
below:

- **Every appliance in the game is a variant of one `station` piece.** Ten
  variants — coffee machine, blender, toaster, sandwich press, juicer, soft
  serve, deep fryer, oven, grill, preserving pot — over one shared tier ladder
  (Domestic, Commercial). A rung added to that ladder is a rung on all ten.
- **The record is singular in five places.** `recipe`, `making`, `startedAt`,
  `busyUntil`, `output` are one each. `contents` — the hopper — is a flat
  item→qty map sized by the recipe it is set to.
- **The readouts are singular too.** One bay group, one work overlay, one
  progress bar, all stood at the machine's origin.

---

## The hole

An appliance is a decision you take once and then live with. A shop with one
coffee machine sells one hot drink; wanting two means owning two machines,
which is two tiles, two hoppers to keep topped up and two walks. And the tier
ladder above it sells *speed* — a Commercial machine makes the same one thing
twice as fast, which is more of a decision you have already taken rather than a
new one.

The tell is the coffee machine. Nobody has authored hot chocolate for it,
because there would be no point: setting the machine to hot chocolate is
setting it away from coffee.

---

## Step 1 — a rung buys a slot

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
one per slot. A save with no `lines` reads as **one slot built from the old
flat fields**: a read-time default rather than a migration, the same bargain
`kindOf` and `shell.z` strike, so an old save, an old export and a fresh seed
all agree with no ceremony.

`persist` writes `hoppers` as `{ id, recipe }` per station, for the reason the
comment there gives — `dev:server` runs under `node --watch`, so every edit to
`server/` is a restart, and a restart that handed every machine back to its
first recipe would quietly repoint the kitchen. That row carries a **list** of
recipes now, and a row with the old single field folds into slot 0.

### The hopper stays one bin

Both heads draw from it. `stationHopperCap` is what the recipe it is set to
calls for times the batches it holds; with two slots it is the **sum over the
slots**, and everything downstream of it — what the machine will take from your
hands, what the shop buys for it, what the bays draw — goes on working.

Splitting the hopper per slot is the wrong answer and it is worth saying why,
because it is the first thing anybody would reach for. Two hot drinks that both
want milk is *the* case this feature exists for, and two bins would make you
load the same milk twice into the same machine. One bin is also what keeps the
number a player can act on: "3 tomatoes a batch, four batches, twelve" survives,
it just has two recipes adding into it.

Two slots racing for the last tomato is settled by slot order, not by a draw.
`stepStations` already walks in order; the first slot that can start, starts.
Nothing random happens, so nothing moves the rng stream and no balance run
diverges over it.

### Two trays

`stationOutputRoom` keeps "one product at a time" true **per slot** rather than
per machine — the rule is what stops a batch being made and then thrown away,
and it is asked before starting, which costs nothing.

`collectStation` sweeps **both** trays. Hands already take mixed armfuls, and
one reach into a machine holding two finished things coming out with both is
the same call `unload` makes about a mixed crate. Naming *which* tray with the
pointer is step 2, and deliberately not step 1.

### The picker becomes a list of ticks

`recipeRows` in `client/fixture-menu.js` says today:

> A machine knows several recipes and runs ONE, so this is a picker rather than
> a list of checkboxes — the shape a seed picker takes, not the shape a shelf's
> reservations take.

With slots that inverts. It becomes exactly the shelf-reservation shape, with a
ceiling: tick up to `lines` of them, and the row that would be the
`lines + 1`th is dead with the ceiling said on it. `station-recipe` grows a
slot index — or, better, becomes a *set* message that carries the whole list,
because the batch lesson applies: a client sending N single messages to change
two slots is N re-flows and N log lines for one press.

---

## The traps

Six, and four of them are invisible in a screenshot.

**One resolver takes ONE number, and there are two clocks now.** This is the
thing CLAUDE.md already records about appliances: `model`'s 0..1 is spent on
the tier, `work`'s is spent on how far through the batch it is, and that is why
an appliance has two models. Two slots at different progress is a *third*
quantity and it does not get a third model — it gets the `work` model **drawn
once per slot**, each at its own slot's offset, each with its own `progress`.
The progress bar is the same claim: one bar per running slot, or a twin machine
running two batches tells you about one of them.

**The wells have to group into columns.** `buildStationBays` sorts every
`surface` part by x, calls the front-most one the tray and gives the rest to
the hopper. A twin machine authors two of those pairs, and they group by z —
each column's front-most well is that column's tray. Read off the art the way
`surfacesAt`, `seamStep` and `drawableBoards` are, never authored as an index,
because an index taken beside the parts is the `verify:motion` bug: drop a seam
past it and it spins the box next door.

**Eight of the ten appliances have no second-stage art.** Only the coffee
machine and the blender author `stages` on their model; the other eight already
draw a Domestic machine when you pay for Commercial. A Twin rung with no stage
3 anywhere is a rung that moves a real number and no picture, which is the
opposite failure to the usual one and reads exactly the same from inside the
shop: you bought something and nothing happened. **The art is the feature
here** — a twin machine that looks like a single machine is a slot you have to
open a menu to discover.

**Everything that asks what a machine is making is singular.** `stationWants`
(which is what puts an appliance in the list of homes for an item),
`applianceInputs`, `stationHopperCap`, `nextBatch`, `stationOutputRoom`, the
kitchen's `hasHome` gate, and the client's own `stationRecipe`. Each is right
today and each is a place a second slot goes quietly missing — the shape
`STOCK_KINDS` and the hot counter record: **a rule written as one answer is
silently wrong the day there are two**, and the fix is one accessor rather than
eleven call sites remembering.

**The way down.** `tierShortfall` refuses a downgrade *before any money moves*
when a smaller unit could not hold what is on this one — fewer boards, fewer
kinds. A twin stepping back to a single is the same claim about slots: two
recipes set and one slot below, refused, with the recipe you would lose named.
Refunding half of the rung you step **off**, not the one you land on, as ever.

**`simulate` is blind to all of it.** The balance bot never runs an appliance,
so a kitchen change measures as no change over ten seeds — the instrument
being blind, not the change being free. Judge this one in play.

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

---

## Proposed

**Step 2 — the pointer names a tray.** Step 1 sweeps both. A twin machine with
two things waiting is the same question a shelf with three piles on it answers
with `pickAim`: each tray group carries its slot, the marker goes round the
pile rather than round the tile, and a tap takes one while a hold takes the
lot. Only worth it once twin machines exist and people are standing at them.

**Step 3 — an appliance priced on its catalog row.** Not this feature, but it
is in the way of it: an appliance is still the one fixture priced by the
upgrade that sells it (`fixtureUnitCost`), which is docs/building.md step 12.
A machine whose rungs sell slots wants its price and its ladder in the same
row as its art.

**Step 4 — a third slot, or an appliance-specific ladder.** The ladder is
shared across all ten variants today, so "Twin" is twin for the fryer and the
preserving pot alike. If that turns out to be wrong — a twin oven is a
different idea from a twin coffee machine — the answer is a ladder per variant,
which is a bigger change to the catalog than it looks and should wait until
there is a case for it rather than a suspicion.
