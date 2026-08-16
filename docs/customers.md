# Customers — mood, anger and crowding

Status: **steps 1–3 and 7–9 built.** Patience is a budget, shoppers get cross
and walk out, you can see it on their faces, and they arrive with a list rather
than a number. Steps 4–6 — capacity and crowding, theft, and the HUD meter —
are still proposed.

⚠️ `simulate` **cannot see any of steps 1–3.** Its bot auto-serves the front of
the queue after 1.5s and keeps the shelves full, so no queue ever builds, no
shelf is ever bare on arrival, and `abandoned` came back 0 across ten seeds
both before and after. That is not the feature failing — it is the instrument
being blind to it. Ten seeds against one frozen world measured 435.44 → 427.20
profit/day, which is inside the noise floor CLAUDE.md documents for a no-op
change. Anything in steps 4–6 that touches footfall **will** show up there, so
re-measure then.

The goal: a shopper's patience is a budget they spend on everything that is
wrong with your shop, not just on the queue — and when it runs out they do
something you can *see*. A full shop should push back on its own instead of
quietly taking another fifty customers it cannot serve.

---

## What's wrong today

### Mood is one thing wearing the name of a much bigger thing

```js
// stepQueue, server/sim/index.js
cust.mood = clamp(1 - cust.waited / cust.patience, 0, 1);
```

That is the whole mechanic. `mood` starts at 1, and the *only* thing that
lowers it is standing in a checkout line. Then it is read once, at the sale:

```js
this.reputation = clamp(this.reputation + 0.004 * cust.mood, 0, 1);
```

and thrown away. A shopper who crossed an empty shop, found what they wanted
immediately and paid at once is worth `+0.004`. A shopper who trudged past
eleven bare shelves, gave up, and left with nothing is worth `-0.015`. Neither
number came from their mood, because their mood never moved.

Worse, mood does not tick while the line *shuffles*. `leaveShop` re-paths
everyone behind the person who just paid and puts them back into `TO_TILL`,
and `stepQueue` — the only place `waited` grows — runs on `QUEUE` alone. In a
busy line most of a shopper's wait is spent walking, and none of that walking
costs them anything.

### Nothing shows it

`mood` is in the snapshot:

```js
mood: r2(c.mood), want: c.wantHint ?? null,
```

and no client code reads it. Grep `client/` for `mood` and you get a comment in
`palette.js` about the mood of the *game*. Every shopper is the same coloured
capsule with the same cream-coloured head whether they are delighted or about
to walk out. The single most interesting number in the simulation is invisible.

### The shop has no idea how big it is

```js
if (Object.keys(this.customers).length < 40) this.spawnCustomer();
```

Forty. Not forty per till, or forty per shelf — forty, flat, whether you own
one checkout or six. Footfall is driven by reputation, the day-of-week rhythm
and demand modifiers, and by nothing about whether the shop can actually cope:

```js
return baseRate * shape * weekend * (0.5 + reputation) * clamp(pressure, 0.4, 3);
```

There *is* a feedback loop — a shop that fails people loses reputation, and
reputation is a footfall term — but it runs on the scale of days, and it never
turns anyone away at the door. On a weekend evening the spawner will keep
pushing shoppers through a single till at roughly one every three seconds and
nothing anywhere says "this shop is full".

Customers do not collide, either, so an overloaded shop does not even *look*
overloaded. Twenty people stand inside each other.

### Theft already happens — it just isn't called that

When a shopper gives up in the queue, their basket is dropped and the stock is
simply gone:

> `// Abandoned basket: stock is lost from the shelf, reputation takes a hit.`

Nothing is returned to the shelf. So the game already has shrinkage; it has no
name, no visual, and no way for the player to notice it happened. Naming it is
nearly free, which is the main argument for doing it.

---

## The shape

One number per shopper, spent against one budget, drawn on their face.

### Patience is a budget; annoyances are rates

`patience` is already an authored archetype column — 30 seconds for a Snack
Kid, 120 for a Foodie — and it already means "how long until mood hits zero".
Keep that meaning exactly and let more things draw on it:

```
drain/sec = (sum of active annoyances) / patience
```

Annoyances are dimensionless and additive, calibrated so that **queueing is
1.0**. That is the anchor: a shopper doing nothing but queueing burns their
whole budget in `patience` seconds, which is what happens today, so the
existing balance is preserved by construction.

| Annoyance | Value | Reasoning |
|---|---|---|
| Queueing | 1.0 | The anchor. Identical to today. |
| Waiting anywhere in the till *line*, walking or not | 1.0 | Fixes the shuffle hole — `TO_TILL` with a claimed slot counts. |
| Just being in the shop | 0.15 | A Foodie loses ~0.18 over a two-minute visit. Alone it barely matters, which is right. |
| Crowding | `0.6 × max(0, occupancy − 1)` | At 1.5× capacity that's 0.3 — half a queue's worth of irritation, for everyone, at once. |
| Walked to a shelf and found it empty | one-off `−0.12` | The race at `takeFromShelf`, where `shelf.qty <= 0` currently returns in silence. Four wasted trips ≈ one lost customer. |

`rankShelves` already skips empty shelves, so the last one only fires when
somebody else took the last unit while this shopper was walking over. That is
exactly the moment worth punishing — it is the shop being *thin*, not the
shopper being unlucky.

### Anger is a band, not a number

The number is continuous; what it *does* is not. Three bands, so the renderer
and the sim agree on what "cross" means:

| Band | Mood | What it means |
|---|---|---|
| Content | `≥ 0.5` | Normal. Nothing changes. |
| Annoyed | `0.2 – 0.5` | Visibly unhappy. Still shopping, still paying. |
| Fuming | `< 0.2` | Done shopping. Empty-handed, they walk out now; holding goods, they cut to the till. |
| Gone | `≤ 0` | Storms out, wherever they are. |

The fuming band splits on the basket, which the first draft of this doc did not
and should have. "Storm out at the next decision point" throws away a full
basket two seconds from the till, and the shopper who has already picked things
up is the one with a reason to stay — so they get to try to pay, and storm out
of the *line* if it comes to that. Empty-handed, there is nothing to lose by
leaving, and leaving is the honest signal.

Storming out is its own exit, not a quiet `leaveShop`: the basket is abandoned,
they head for the door at **1.6× walking speed**, reputation takes `−0.03`
(worse than the old `−0.02` queue timeout, because now it can happen to someone
who never even reached the line), and it writes a log line naming who left and
how much they dropped.

### Showing it

All three read the same `mood` the server already sends.

- **Colour.** The head lerps from `#f6efe2` toward an angry flush as mood falls
  through the annoyed band. The body keeps the archetype colour, because that
  is how you tell a Foodie from a Snack Kid and it must not be overloaded.
- **Shake.** Amplitude scales with how far into the band they are. `syncActors`
  already stores a stable per-actor `phase` — hashed from the id, added
  precisely so two hires don't breathe in sync — so shoppers shake out of step
  with each other for free.
- **Storming out.** The 1.6× speed is the read. No new art.

Nothing here is authored content, and that is deliberate: a shopper is not
authored (`buildCharacter` is built-in, unlike a worker's `model`), and anger
is behaviour.

### Theft

A `steal_chance` column on the archetype, defaulting to `0`. When a shopper
storms out holding goods, roll it; on a hit the stock leaves with them and the
log says so.

The balance impact is **nil** — the stock is already lost on an abandoned
basket today. What changes is that the player can see it, and that a new
archetype can be a shoplifter with one `create_archetype` call and no code.

### Crowding and capacity

Capacity is derived from what you own, so building your way out of it is the
answer:

```
capacity = tills × 6 + stockedShelves × 1.5
occupancy = shoppersInStore / capacity
```

A starter shop — one till, six stocked shelves — holds about 15. Peak arrival
is roughly 0.32 shoppers/sec against a ~40 second visit, so a steady state of
~13 sits just under it and a weekend evening tips over. That is the intended
shape: the default shop should *just* cope, and stop coping when it gets
popular.

Two consequences:

- **Over 1.0** — the crowding annoyance above bites everyone inside.
- **Over 1.35** — new arrivals are turned away at the door instead of spawning.
  Reputation takes `−0.005` and the log says someone looked in and walked on.

The turn-away replaces the flat `< 40` cap. It is the direct answer to
"we just keep pounding it with customers": the shop stops accepting them, the
player is told why, and the fix is a second till rather than a mystery.

---

## What must not happen

- **Mood must not become a second reputation.** Reputation stays the only thing
  driving footfall and purchase chance. Mood is the *input* that moves
  reputation. Wire mood into `footfall` as well and every effect is counted
  twice, with a feedback loop that will oscillate.
- **The queue count in the snapshot is not the line.** `queues[].queue` is
  `queue.length`, which includes everyone who has *claimed a slot* — in a live
  sample, 7 "in line" was one person standing there and three still walking in
  from the far wall. Any HUD reading of "how long is the line" has to count
  `state === 'QUEUE'`, or the meter will scream at a shop that is fine.
- **Crowding must not be measured in tiles.** Customers pass through each
  other, so there is no physical crowding to detect and no appetite for adding
  collision to the pathfinder. Occupancy is a ratio, not a jam.

---

# The list — what they came in for

Steps 1–6 are about how a shopper *feels*. This part is about what they
**want**, which until now was a single integer.

## What was wrong

```js
wantCount: this.rng.int(arch.basket_min, arch.basket_max),
```

A shopper wanted *five things*. Not five particular things — five. `chooseShelf`
then ranked every shelf in the building by `purchaseChance` and walked to the
best one, five times over. So a Budget Parent with a five-item basket bought the
five highest-scoring units in the shop, which in practice meant **the same shelf
class over and over**: whatever was cheapest and best-tagged won every round.

Three things fall out of that, and all three are wrong:

- **Nobody ever fails to find something,** because there was no *something*.
  A shop stocked entirely with candy served a Health Nut a full basket of candy
  at slightly lower probability. The only failure mode was "found nothing at
  all", which needs the whole shop to be unappealing.
- **The player cannot be told what they are missing.** `leftEmpty` counts people
  who left with nothing and cannot say why. There is no number anywhere in this
  game that answers "what did people want that I did not have?" — which is the
  single most useful thing a shopkeeping game can tell you.
- **A shelf is visited once**, so one-unit-per-shelf capped every basket at the
  shelf count. That was patched with `MAX_UNITS_PER_SHELF = 3` — a shopper takes
  a small run of one thing. It works, but it is a workaround for the missing
  list, not a mechanic: the run length is a constant rather than "how many milks
  did I come for".

## The shape

**A list line is a tag, not an item.** This is the part that could go wrong, and
it is the same rule as everywhere else: a shopper who wants `tomato` is the
`if (item.id === 'tomato')` failure, and it breaks the day either of us authors
a new item. A shopper wants `dairy`, and whatever `dairy` thing is on the shelf
answers it.

```js
list: [ { tag: 'dairy',  qty: 2, must: true,  got: 0 },
        { tag: 'snack',  qty: 1, must: false, got: 0 } ]
```

The list is rolled at spawn. `basket_min..basket_max` is unchanged and still
means *units* — it is now spread across lines rather than being a flat target,
so the aggregate size of a basket, and therefore the existing balance, is
preserved by construction.

Lines are drawn by weighted random from the archetype's **positive** affinities,
which are already authored. A repeat draw of the same tag becomes `qty`, not a
second line — so a high-affinity tag naturally produces "three of those" rather
than three separate errands, and the Bulk Shopper's 5–10 units land as a handful
of chunky lines instead of ten independent whims.

### Staples: the half that is worth building

A new archetype column, `staple_tags`, defaulting to `[]`:

> These are what they *came for*. Everything else on the list is opportunistic.

Staple lines are placed first and carry `must: true`. Miss one and three things
happen: a one-off mood hit, a `stats.unmet` tally against that tag, and — when
they stop shopping — a log line naming what you did not have.

The payoff is not the shopping. It is that `simulate` and the day log can now
say **"nine people came in for `frozen` today and you had none"**, which is a
sentence this game has never been able to produce.

**A missed staple does not empty the basket.** They buy the opportunistic
lines, take the mood hit, and leave annoyed. Walking out with nothing throws
away sales that were genuinely made, over-punishes a near miss, and muddies the
signal — the tally carries the message, not a tantrum. Only a shopper who finds
*nothing at all* still trips `leftEmpty`, exactly as before.

**Going elsewhere is not a competitor.** [`pull`](../server/sim/economy.js) is
already "what share of the town chooses your shop". A missed staple takes
reputation down, `pull` reads reputation, and the going-elsewhere happens over
the following days without a rival shop existing anywhere in the codebase.

### `MAX_UNITS_PER_SHELF` retires

With a list, "how many do I take from this shelf" is `qty - got` — the errand
says so. The constant was standing in for exactly that number and can go. This
is a deletion, and it is the tell that the list is the right shape.

### Endcaps are a position, not a fixture

An impulse buy needs somewhere to impulse-buy *from*, and the tempting answer —
author an `endcap` fixture kind — is wrong twice over. `BUILD_KINDS` is a closed
set on purpose (*kinds are code; pieces are content*), and an endcap is neither
a new behaviour nor a new piece. It is **a shelf you put next to a till**.

```
endcap = any stocked shelf within IMPULSE_RADIUS of the till they queued at
```

Derived at queue-join from `shelf.x/z` and `till.x/z`, which the layout already
has. Nothing is authored, nothing is stored, and the rule is discovered by
playing rather than read in a tooltip.

This is the first time **where you put something has an economic consequence**.
Since the shell got stamped and placement became the player's job
(docs/building.md), layout has been purely cosmetic. Now the aisle nearest the
till earns.

The roll happens **once, on joining the queue**, gated three ways:

| Gate | Why |
|---|---|
| Off-list | An impulse buy is by definition not what you came for. The list is ignored, and the basket may exceed `wantCount`. |
| Tag-weighted | `IMPULSE_TAGS` in `shared/tags.js` — `candy`, `snack`, `beverage`, `kids`, `cheap`. Same tag-keyed shape as `BEHAVIOUR_TAGS`. |
| Mood ≥ annoyed | Someone about to storm out does not browse the sweets. Wires straight into the anger bands from step 2. |

⚠️ **It must not scale with time spent queueing**, however tempting that is.
`simulate`'s bot auto-serves the front of the line after 1.5s, so no queue ever
builds in a balance run — anything measured against *wait* is invisible to the
instrument, which is exactly how steps 1–3 came back as noise (see the warning
at the top of this doc). Firing once on join, scaled by how many people are
already in the line, is both measurable and the more honest model.

## What must not happen here

- **A list line must never be an item id.** See above. This is the whole game.
- **An unsatisfiable list must not loop.** `chooseShelf` excludes shelves in
  `visited`, and every visit appends to it, so a line that nothing can serve
  runs out of candidate shelves and fails. Remove the `visited` filter and a
  shopper wanting a tag you do not stock walks between two shelves forever.
- **Impulse must not be free money.** It is revenue with no matching cost to the
  player, which is the one thing here that can quietly break the economy. It is
  the reason this step needs ten seeds and not a screenshot.
- **A storm-out does not also pay the missed-staple penalty.** `stormOut`
  already charges −0.03 and the tally was taken at the moment the line failed.
  Charging both makes an angry customer who also missed a staple worth double,
  which is a feedback loop nobody authored.

---

## Steps

1. Mood as a budget — the drain table, and `waited` growing across `TO_TILL`
   as well as `QUEUE`. No visual change; `simulate` should barely move.
2. Anger bands and storming out, with the reputation deltas and log lines.
3. The renderer: head flush, shake, 1.6× exit.
4. Capacity, crowding annoyance, and the door turn-away replacing `< 40`.
5. `steal_chance` on the archetype schema, and the theft roll and log.
6. The mood meter in the HUD — today's average, next to reputation's slow one.
7. The list: tag lines rolled at spawn, `chooseShelf` serving one line at a
   time, and `MAX_UNITS_PER_SHELF` deleted in favour of `qty - got`.
8. `staple_tags` on the archetype schema, the missed-staple mood and reputation
   hits, the `stats.unmet` tally, and `unmetDemand` in the `simulate` report.
9. Endcap impulse buys on queue-join, with `IMPULSE_TAGS` and the mood gate.

Steps 7 and 8 are one change in practice — a list with no staples on it cannot
miss one, so building 7 alone leaves the interesting half untested. 9 is
genuinely separable and could ship on its own.

---

## Verifying it

`simulate` covers steps 1, 2 and 4, and the warnings in `CLAUDE.md` all apply
with force here, because every one of these changes alters how many RNG draws
happen per shopper. Copy `data/game.db` and drive `simulate` in-process against
the copy via `SNS_DB`, average across at least ten seeds, and `clear_modifiers`
first. A single seed will not tell you anything.

The number to watch is not profit — it is `abandoned` against `leftEmpty`.
Today `abandoned` is 0 in a live shop failing a third of its customers, which
is the clearest evidence that the current mood model measures the wrong thing.

### Steps 7–9 specifically

Unlike 1–3, **`simulate` sees all of this**, and it will move. The list changes
how many RNG draws happen per shopper *and* what they buy, so the two runs
diverge for reasons beyond the feature — average ten seeds against a copied
frozen database or the number is worthless.

What to expect, and what would be a bug:

| Number | Expected | A bug if |
|---|---|---|
| `deadStock` | **shorter** | It grows. A tag-driven list should reach more of the catalogue than greedy top-ranking ever did. |
| `bestSellers` | flatter | One item still takes half of all sales — the list is not actually constraining choice. |
| `profitPerDay` | slightly down, then up with impulse | It jumps a lot. Impulse is uncosted revenue; a big rise means the roll is too generous or firing more than once. |
| `unmetDemand` | non-empty | It is empty with staples authored — the tally is not wired, or every staple is being met by luck. |

The honest risk is impulse. Measure steps 7–8 together first, land them, and
only then measure 9 against that new baseline — stacking both into one
before/after cannot tell you which half moved the money.
