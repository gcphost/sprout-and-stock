# Kits — what a shopper is carrying it in

Status: **step 1 built.** A shopper who has paid walks out with a paper bag
instead of five jars floating in front of them, and which bag that is is a row
somebody can draw. Steps 2–4 proposed.

⚠️ Step 1 is **provably balance-neutral**, and provably rather than measurably:
nothing in it calls the sim's rng, reads a number the sim reads, or writes to
the save. See "the draw is a hash" below — that is the whole reason it can make
that claim without ten seeds behind it.

The goal: a thing somebody has on them should be authored, and the *act* of
getting one should be the mechanic.

---

## What this is about

There was one way for a person to be holding goods and it was the loose armful:
up to `CARRY_SHOWN` little models dealt round-robin at chest height, with a
count over them past that. It is exactly right while somebody is choosing —
"they picked up a cheese" is the fact it exists to show, and it was built to
show it — and it is exactly wrong once they have paid. The sale is done, the
goods are theirs, the number is settled, and what is left is a readout nobody
can act on, drawn over every shopper heading for the door at the busiest moment
of the day.

That is the whole complaint. What it needed was a container.

---

## Step 1 — a kit is a row ✅

### The line between this and a pastime

A kit looks like a pastime and is not one, and getting that wrong is the whole
cost of this feature done badly.

A **pastime** is an activity. It has a clock (`seconds`), somewhere to be
(`spot`), an amount of energy it puts back (`restores`) and something it might
buy off your own shelf (`buys`). The prop is a *detail* of it — a mug is what
having a brew looks like.

A **kit** is only the object. No duration, nowhere to be, nothing restored.
Authored into `pastimes` it would be a row with four dead columns, which is the
"tier that changes no number" trap wearing a bag: a shape that validates, seeds,
exports and does nothing.

So: `kits`, its own table, `KitSchema`, `POST /api/content/kit`, `create_kit`.

### Two columns are the whole assignment

```
use    the moment it is carried in   -- shopping | leaving
tags   who carries it                -- matched against the archetype's
```

**`use` is a closed set** (`KIT_USES` in [shared/schemas.js](../shared/schemas.js)),
for the reason `BUILD_KINDS` and `JOBS` are closed: each entry is a moment the
sim knows it is in and can hand a fullness to. A row naming a moment nothing
reaches is a prop that never appears. The list grows by one string when a
mechanic that needs it lands and never in advance — `stealing` belongs in it the
day theft does and not a step before.

It is spelled `use` and means *when* because `upsert` builds its column list
unquoted out of the object's own keys, and `when` is a SQLite keyword. Worth
knowing before naming a column on the next kind: it fails at the first write and
nowhere earlier. `vehicles` already calls the same idea `use`.

**`tags` is who**, and it is why `archetypes` grew a `tags` column. Until then an
archetype could say what it *wanted* (`affinities`) and what it came in for
(`staple_tags`), and had no way at all to say what *kind of shopper* it is — so
a row that wanted to aim at the tight-fisted ones had no choice but to name an
archetype id, which is `if (item.id === 'tomato')` with a different noun. Empty
tags on either side means anybody, which is every archetype written before this
and is why no shopper changed.

Two rows for the same `use` are drawn between by `weight`, so a shop can have a
mix of carrier bags.

### The 0..1 is how full it is

Same authoring shape as everything else with stages, and the fifth quantity to
drive one:

| Thing | What its 0..1 is |
|---|---|
| crop | how grown |
| fixture | which tier |
| pastime | how far through the break |
| vehicle | how loaded |
| **kit** | **how full it is** |

Measured against the shopper's own `basket_max` rather than a literal, because
that is the number the sim already uses to mean "a full shop for them" — so a
pensioner who buys three things carries a *full* bag and it reads as one.
Clamped, since a driver takes home more than they otherwise would.

The seeded `paper-bag` is three stages: folded, half full, and bulging with a
baguette and some greens over the rim. No code in the game knows what a baguette
is.

### The draw is a hash, not an rng

The one non-obvious decision in step 1, and the reason it can claim
balance-neutrality without measuring.

Every balance number in this project is downstream of how many times `this.rng`
has been called — that is why `Game.namer` is a stream of its own, and why
CLAUDE.md warns that naming a shopper out of the measured stream would move
every basket, crop and spawn roll after it. Drawing a shopper's *bag* out of it
would do exactly that, and two `simulate` runs either side of authoring a paper
bag would diverge with nothing in the output to say why.

Hashing the shopper's id and the moment costs no draw at all, which is better
than either stream:

- the same shopper always carries the same bag
- a reload gives them theirs back, with nothing saved
- the balance is untouched because nothing random happened

The client already does this for a hire's breathing phase. It is the right reach
for anything cosmetic and per-person.

### It replaces the armful

`syncCarry` is passed null when a kit is present. A shopper walking out with a
bag is not also walking out with five jars in mid-air.

Which makes the whole table **opt-in**: author no kits and the game is the game
as it was, loose armfuls and all. A shop that has never heard of this feature
cannot be changed by it.

### Asked per snapshot, not stored

`kitOf` runs the filter every tick rather than stamping a choice on the shopper
when they spawn. It is a filter over a handful of rows, and it buys the promise
skins already make: a bag drawn or edited over MCP reaches the people already
walking round the shop, not only the ones who arrive after it.

### What step 1 touched

- `shared/schemas.js` — `KIT_USES`, `KitSchema`, `ArchetypeSchema.tags`
- `server/db.js` — the `kits` table, its JSON columns, `archetypes.tags`
- `server/content.js`, `server/api.js`, `mcp/server.js` — the usual three
- `server/sim/index.js` — `hash01`, `pickKit`, `Game.kitOf`, one snapshot line
- `server/rooms/MartRoom.js` — kits ride the catalog
- `client/render/scene.js` — `syncKit`, and one null passed to `syncCarry`
- `scripts/seed.js`, `scripts/export-content.js` — `kits.json`

Nothing in `client/render/props.js`. That is the point: the first cut of this
was a `buildShoppingBag` function full of hardcoded boxes, and it was wrong for
exactly the reason the vehicles table exists — everything in this game you look
at is a row somebody can draw.

---

## Step 2 — the basket you fetch 🔲

Where a kit stops being a look and starts being a mechanic. `create_kit`'s own
description already draws this line: *if you want a trolley that makes people
buy more, that is a mechanic and it needs code.*

### The table does not move

A basket is a row with `use: 'shopping'`. What changes is that it is **chosen
rather than given**: `cust.kit` becomes state on the shopper, and `kitOf` reads
it first and falls back to the hash. That is a small change, and it is the whole
reason step 1 was built this way round.

### Three parts, and only one of them is hard

**The stack is a fixture**, so it is a new `BUILD_KINDS` entry — where it may
go, whether it blocks, which side you take one from. Behaviour, therefore code;
and then a wire stack, a chrome one and a trolley bay are pieces in the catalog
like every other design.

**The detour is the mechanic.** A shopper who wants a basket walks to the stack
*before* they start shopping, and `stepMood` drains everyone in the shop — so
that walk costs patience. Which means **where you put the stack is most of what
it is worth**, and it falls out of the walk rather than out of a rule. That is
the break area's lesson exactly (+47 mean profit beside the door, +12 in the far
corner). By the door it is nearly free; at the back you have charged every
customer three seconds of goodwill for the privilege of buying more.

**Capacity is the number**, and it is the first field on a kit the sim would
read — a shopper with a basket takes more than their `basket_max`. That is real
money, so it is ten seeds against a frozen `SNS_DB` copy, not one, and
`clear_modifiers` first. Check `startedWith`.

### What must not happen

- **A basket that is worth taking is not a decision.** If it is free and strictly
  better, every shopper fetches one and the fixture is a tax on shop floor rather
  than a choice. The walk has to be able to cost more than the basket is worth,
  for somebody buying two things.
- **A shop with no basket stack must play exactly as it does today.** Same claim
  the break area makes, and the same fallback: no stack, no detour, no change.
- **The stack must not be reachable-only-in-theory.** The break area's seat
  search asks `findPath` for a reason — a room nobody can reach pinned every hire
  at `TIRED_PACE` forever. A basket stack walled into an annex is the same bug
  wearing a customer.

### The basket does NOT come back on its own — decided

They put it down where they finished, and it stays there until somebody walks
over and collects it. That is step 4, and step 2 has to be built expecting it.

The other answer was to vanish it at the till: one line, no new failure mode,
and what a real shop looks like from outside. It was rejected for what it costs
rather than for what it does — a basket that deletes itself makes the stack an
ornament. It can never run out, so it never asks anything of you, and the
fixture becomes a thing you place once and stop thinking about.

Leaving it on the floor is what gives the stack a **number that moves**:

- A busy shop visibly runs itself out of baskets. The consequence of a good day
  is a mess, and the mess is the reason the next customer shops with their arms.
- That gives a hire something to walk the floor *for*, which is the shop hand's
  shape exactly: `merchandise` already moves goods nobody wanted back off a
  board, and this is the same job pointed at empty containers.
- It makes where you put the stack matter a second time — a collection round is
  a walk too, and a stack at the back is paid for twice.

Three things to get right, all of them already solved once elsewhere in this
game:

- **The job needs a veto, or it loops.** `merchandise` shipped as a round trip
  that moved stock and changed nothing until `giveUpBoard` existed. A hire who
  carries a basket to the stack and takes one straight back off it is the same
  bug, and it will look exactly like a worker doing their job.
- **An empty stack is a shortage, not an error.** A shopper who wants a basket
  and finds none shops without one. That is the whole tension; refusing them
  entry or freezing them at the fixture is a shop that punishes you for being
  busy.

### An abandoned basket IS a crate

The load-bearing decision in this whole branch, and it is the rule CLAUDE.md
already states rather than a new idea: *a pallet is the only "goods on the
floor" object there is — never invent a second container, call `dropGoods`.*

A basket somebody put down is a container standing on a tile that you can walk
up to, pick up, carry, stack and be annoyed by. That is a pallet, exactly, and
the moment it is one the following are already built:

- **the pickup path** — `pickPallet` picks a pile apart by height, the ring
  marks the one the ray met, `liftCrate` lifts a buried one and the boxes above
  settle a step
- **hauling** — `p.haul`, so a hire carries a stack of them back rather than one
- **the renderer** — one `buildPallet`, one label, one everything
- **the stocker tidying it** — the job that already clears cases of goods off
  the floor is the job that clears baskets, for free

Which means **step 4 mostly already exists**. The `collect` job stops being a
new loop and becomes one answer to a question the stocker already asks: where
does this go back to? A shelf, if it holds goods. The stack, if it is a basket.

Two things fall out of it, and the first is the better prize:

**A pile of basket-crates is what a basket stack LOOKS like.** Crates already
stack (`crateStacked`), and a stack of baskets by the door is a pile of
containers on a tile — the same picture. So the stack may not want to be a
`BUILD_KINDS` entry at all; it may want to be a *source* that keeps a pile
topped up, the way the yard is ground you paint rather than furniture the
generator stamps. Worth trying before adding a kind, on the rule that already
caught the crossing: check whether two kinds you have overlap on it first.

**...but a basket is not GOODS, and that is what it costs.** Checked rather than
assumed, because the first draft of this section assumed it and was wrong twice
over. `dropGoods` refuses `qty <= 0` at the door
([server/sim/index.js](../server/sim/index.js)), and every pickup path deletes a
pallet the moment it empties — so an empty pallet cannot exist in this game at
all, and "the basket is a pallet holding nothing" is not a thing that can be
built. Nor is it a pallet holding *baskets*: a pallet is keyed by `item_id`, and
a basket is not an item. Authoring one as an item to dodge that is worse than
the branch — it would turn up in the supplier, on a shelf, and in a shopper's
list.

So the pallet record gains a **`kit` payload** beside `item_id`, with branches
in drop, merge, pickup and the label. About forty lines, and worth naming as the
price of the whole loop rather than discovering it halfway through: without it
there is nothing on the floor, and with nothing on the floor the stack never
depletes and the fixture is an ornament.

### What a shopper does with it when they are finished

**They either put it back or they dump it at the register, and `mood` decides.**
Not a coin flip — a happy shopper returns it, a cross one leaves it where they
paid.

That is the best thing in this branch, because it costs nothing and gives the
mess a *cause the player already controls*. Patience is a budget every annoyance
draws on: a long queue, a crush, a shelf they could not reach, a walk to the
back of the shop for a basket in the first place. So a badly run shop is
visibly, physically untidier, and a well run one cleans up after itself. Nothing
new has to be tracked — `mood` is already on the customer and already drained by
everything that should count.

`tags` on the archetype biases it (a `tidy` shopper puts it back even when
cross), which is the same handle kits already use for who carries what.

### Tidying it is the stocker's existing job

There is no new loop. Clearing things off the floor is what the stocker already
does — the `collect` work is one more answer to the question that job already
asks, *where does this go back to*: a shelf if it is goods, the stack if it is a
basket. Which is also what makes the veto necessary rather than optional (see
above): the same hire, the same round trip, and `merchandise` has already been
this bug once.

The honest caveat: if the tidying never gets built, this decision is worse than
vanishing the basket — a shop that fills with baskets and cannot clear them is
strictly a downgrade. So step 2 ships with tidying or it ships with the one-line
vanish as a stopgap; what it must not do is ship with neither and hope.

---

## Step 3 — the trolley 🔲

The same mechanic with a bigger number, and it earns its place because of what
is already built rather than because it is bigger.

**A trolley bay belongs in the car park.** A driver takes a trolley and a walker
takes a basket, and `parkedAt` already knows which they are — so the car park
stops being a flat capacity bonus (`parkReach` feeding `catchment`) and starts
being a *reason* people buy more. That is the same move the road brush made: a
number that existed became a place you can point at.

Watch the double-count. A driver already takes a bigger basket; a trolley on top
of that is two multipliers on one shopper, and `simulate` will not tell you
which one you are looking at.

---

## Step 4 — baskets somebody has to put back 🔲

Not optional any more — step 2 decided the basket stays where it was dropped, so
this is the half that makes that a mechanic instead of litter.

Smaller than it reads, because an abandoned basket is a crate and tidying the
floor is a job that already exists: what is left is the `kit` payload on the
pallet (~40 lines), the veto so a hire cannot carry one to the stack and take it
straight back off, teaching the stocker that a basket's home is the stack rather
than a shelf, and the conservation claim that anything left in one went
somewhere.

Ships with step 2 or step 2 ships with the one-line vanish as a stopgap. Never
neither.

Nothing here is visible in a screenshot, which means it wants a sweep the day it
ships rather than the day it breaks — `verify:hand` is the model.

---

## Verifying it

Step 1 has no sweep, and that is a judgement rather than an omission: every
claim it makes is either enforced by a schema, or is a *look* you can see in one
frame, or is the balance-neutrality argument above, which is structural. The
first thing here that needs one is step 2's capacity — and what it would assert
is not the number but the fallbacks: that a shop with no stack is unchanged, and
that a stack nobody can reach does not strand anybody.
