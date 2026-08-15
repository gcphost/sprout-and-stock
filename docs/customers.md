# Customers — mood, anger and crowding

Status: **proposed, nothing built.** Mood exists as a field and moves for
exactly one reason. Everything below is a plan.

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
| Fuming | `< 0.2` | Will storm out at the next decision point. |
| Gone | `≤ 0` | Storms out now. |

Storming out is its own exit, not a quiet `leaveShop`: the basket is abandoned,
they head for the door at **1.6× walking speed**, reputation takes `−0.03`
(worse than the current `−0.02` queue timeout, because now it can happen to
someone who never even reached the line), and it writes a log line naming what
did it — the queue, the crowd, or the bare shelves.

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

## Steps

1. Mood as a budget — the drain table, and `waited` growing across `TO_TILL`
   as well as `QUEUE`. No visual change; `simulate` should barely move.
2. Anger bands and storming out, with the reputation deltas and log lines.
3. The renderer: head flush, shake, 1.6× exit.
4. Capacity, crowding annoyance, and the door turn-away replacing `< 40`.
5. `steal_chance` on the archetype schema, and the theft roll and log.
6. The mood meter in the HUD — today's average, next to reputation's slow one.

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
