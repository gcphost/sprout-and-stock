# Milestones

Status: **step 1 built.** Twelve rungs, three kinds of reward, a card that
stops the world, and a panel you can watch fill.

---

## Why it exists

A shop that is going well and a shop that is going nowhere look identical for
the first twenty minutes. The numbers in the corner move — that is all they do —
and nothing in the game has ever *said* anything about them. There was no first
hour: you opened the shutters, sold some carrots, and the only feedback was the
same four digits changing.

That is what this is: a ladder of things the shop has already measured, each one
with something on the far side of it, and one moment where the world stops and
says well done.

It is deliberately **not** an unlock tree. Nothing here gates a fixture, a tag,
a crop or an upgrade. Everything you can build you could always build; what a
milestone hands over is money, stock, or town.

## The shape

| Piece | Lives in |
|---|---|
| the twelve rungs, what they measure, what they pay | `server/sim/goals.js` |
| the lifetime tallies they are measured against | `Game.totals`, folded in `rollTotals` |
| which have been earned | `Game.milestones.done`, on the save |
| the sweep | `Game.stepMilestones`, once a second of world time |
| the announcement | `Game.milestoneNews` → `MartRoom.pushState` → `achieved` |
| the card | `client/award.js` + `#award` in `index.html` |
| the ladder as a list | the `goals` section in `client/sections.js` (`M`) |

## The three rules

**A milestone is a measurement, not a quest.** Every rung is one function of
state the shop already keeps — takings, units sold, crops picked, the day, the
roster, reputation. Nothing is tracked *while* you play, nothing is armed, and
nothing can be half-done in a way a save has to remember. Two things follow, and
both are features rather than compromises:

- A new rung is a new row. No migration, no save version, no content table.
- A shop that already passed one gets it on the next tick. **The first sweep a
  save ever gets banks those quietly** (`milestones.opened`) — marked done, no
  card, no gift, one log line. A day-148 shop with thirteen staff and a perfect
  reputation is three rungs true at once, and opening it used to stop the world
  three times and hand over three deliveries before the player had moved.
  Congratulating somebody for a thing they did last month reads as the feature
  misfiring. They still count toward `milestoneReach`, because the town is
  derived from the done list and a second list of rungs-that-do-not-count would
  be a number kept beside the shop rather than read off it. A brand-new shop
  banks nothing — nothing on the ladder is true on day one — which is why this
  needs no special case for a new world, only a flag saying the sweep has run.

**A reward may not be a thing you unlock.** Cash, a free run of stock, and the
town growing. All three are numbers that already meant something before this
existed, which is what keeps the feature to one file plus wiring — a reward that
granted a *fixture* would need a second way to own one, and every rule in the
shop about what you own is written against `placements` and `ownedUpgrades`.

**The town is the one worth having.** `Game.catchment` is the only term
shopkeeping cannot move: you can restock, decorate, pave and promote your way to
a better shop, and how many people live near it is not a decision — it is
`BASE_CATCHMENT` plus what you bought. Six of the twelve rungs add to it, +1
each, so a shop that finishes the ladder has grown its town by about a third.

That is also why the card prints the number rather than the step. `catchment`
has been on the wire since the shop had customers and has **never been drawn**,
so the one thing the reward moves was also the one number nobody could see.
The card says it, and the Milestones panel's foot says it, and those are the only
two places in the game that do.

## The gift is an order, not a crate

`dropGoods` would put the pallets on the pad this instant, and it would be wrong
twice. A gift that teleports is the supplier-as-vending-machine bug that step 1
of [deliveries.md](deliveries.md) removed — and a pile of crates appearing behind
you while a modal is up is a delivery nobody saw arrive.

So it is filed as ordinary rows in `orders.pending` at `cost: 0`. The lorry
brings it, the stocker puts it away, the supplier's list shows it coming, and the
whole reward is four fields. It is bounded by `bayRoom()` with every other guard,
and a shop with no bay simply gets the rest of the reward and a line saying why —
a refusal comes before the money in this game, and here there is no money to
come before.

*What* it sends is the shop's own answer: `restockQueue` first, so the gift is
whatever the shelves are short of, filtered to kinds the shop actually owns
(`homeKind`/`shelfKind` — a warmer is not a shelf and a boolean cannot say so).
The fallback matters more than it looks: a brand-new shop's shelves are bare and
unreserved, so the queue names units without naming goods — and the very first
rung on the ladder is earned in a shop in exactly that state.

## The card stops the world

`pause` is world-wide (`Game.setPaused`), so the shop holds still while you read
and nobody walks out of a queue over an award. Three details are load-bearing:

- **It puts the clock back as it found it.** `restore` is `state.paused` read at
  the moment the first card went up, not `false` — a card that unpaused on its
  way out would restart a shop you had deliberately stopped.
- **It queues.** The sim can award two rungs in one sweep, and two cards on top
  of each other is one card you never see.
- **It owns every key while it is up, and takes none with it.** `keys` is not
  added to before the early return, or a direction held across the pause is
  released to a handler that has already returned and the shop walks at a key you
  let go of. Same trap flying the camera in build mode had to be written around.

Visually it is the one thing in the HUD allowed to look like a game: a gold band,
a medal hanging off the top edge over a turning sunburst, and a pop on the way
in. Everything else up there is a quiet cream panel *on purpose* — it sits over
the thing you are actually looking at — and an award drawn to those rules would
read as another menu having opened.

## What it does to the balance

Two things, and both are deliberate:

- Up to **+6 catchment** across the whole ladder, against a base of 16. That is
  most of a `catchment` upgrade, earned rather than bought.
- Up to **~250 units of free stock**, spread over twelve awards, each capped by
  what the bay can hold.
- **$4,550 in cash across all twelve**, climbing 250 → 100 → 50 → … → 1500. A
  shop opens on $250 — two crates and a seed tray — so the opening hour was a
  wait for one shelf to sell through rather than a decision, and the first rung
  pays the float over again. Every rung pays *something*: a ladder with a gap in
  it reads as a rung that is broken.

`simulate` earns them the same way you do — the ladder is not skipped on an
ephemeral game, because a balance bot that never sees a feature is the broken
instrument CLAUDE.md's auto-replant story is about. `startedWith.milestones`
reports the count and the resulting reach, because a shop that has earned six of
them is a different experiment from one that has earned none on the same seed.

The lifetime tallies are the one thing a save from before this cannot have:
`stats` is wiped nightly and `ledger` is capped at 30 days, so an established
shop starts the takings rungs from whatever it takes from today. Nothing pretends
otherwise, which is the other half of "a milestone is a measurement".

## Next, if it earns it

1. **Rungs that are about the shop rather than the takings** — a shelf of every
   department, a hundred crops of one kind, a day with nobody turned away. All of
   them are one `measure` each; none needs anything new.
2. **A first-run ladder that teaches.** The first three rungs are the closest
   thing the game has to a tutorial and nothing says so. Naming them as one
   opening sequence — and opening the panel on a new shop — is a client change.
3. **Telling the other player.** The card is broadcast, so both people in a shop
   see it; nothing says *who* did the thing. `stats` has no per-player anything
   today, which is why it is a step rather than a line.
