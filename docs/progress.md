# Milestones

Status: **steps 1–3 built.** Forty-five rungs, three kinds of reward, a card
that stops the world, and a panel you can watch fill.

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
| the rungs, what they measure, what they pay | `server/sim/goals.js` |
| the lifetime tallies they are measured against | `Game.totals`, folded in `rollTotals` |
| which have been earned | `Game.milestones.done`, on the save |
| which have ever been *swept against* | `Game.milestones.known`, on the save |
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
- A shop that already passed one gets it on the next tick. **A rung the save has
  never been swept against banks quietly** (`milestones.known`) — marked done,
  no card, no gift, one log line. A day-148 shop with thirteen staff and a
  perfect reputation is three rungs true at once, and opening it used to stop the
  world three times and hand over three deliveries before the player had moved.
  Congratulating somebody for a thing they did last month reads as the feature
  misfiring. They still count toward `milestoneReach`, because the town is
  derived from the done list and a second list of rungs-that-do-not-count would
  be a number kept beside the shop rather than read off it. A brand-new shop
  banks nothing — nothing on the ladder is true on day one — which is why this
  needs no special case for a new world.

  **Per rung, and it was per save for one step.** `milestones.opened` asked the
  question once — has this shop ever been swept? — which is the same question
  only while the ladder never changes. Step 2 added thirty-one rungs, and every
  established shop in the world is long past its opening sweep: a save on day 81
  met ten of them in one tick and would have been congratulated ten times in a
  row, each card stopping the world. That is precisely the moment `opened` was
  written to prevent, arriving on the *second* impression instead of the first.
  `known` cannot go wrong again however many rungs are added later.

  The migration is exact rather than approximate: `known` falls back to `done`,
  and a save written before the field either knows nothing (no ladder yet, so it
  banks everything true — unchanged behaviour) or has been swept against a
  ladder whose *earned* rungs are precisely `done`. What is lost is the rungs it
  had swept and not earned, and they cost nothing — they are not true, so they
  cannot bank, and being swept afresh awards them properly on the day they
  come due.

**A reward may not be a thing you unlock.** Cash, a free run of stock, and the
town growing. All three are numbers that already meant something before this
existed, which is what keeps the feature to one file plus wiring — a reward that
granted a *fixture* would need a second way to own one, and every rule in the
shop about what you own is written against `placements` and `ownedUpgrades`.

**The town is the one worth having.** `Game.catchment` is the only term
shopkeeping cannot move: you can restock, decorate, pave and promote your way to
a better shop, and how many people live near it is not a decision — it is
`BASE_CATCHMENT` plus what you bought. Sixteen rungs add to it, +1 each, against
a base of 16 — so **the ladder is worth a whole starting town**, and that number
is the deliberate one rather than the sum of what each rung felt like paying.

It used to be the exactly-doubled town, and `townGrowth` is what changed that:
the town now also grows on its own, saturating at +24 over about a year. The
ladder is measured against the base rather than against the base plus the years,
and deliberately — what a rung pays should not depend on when you got there.

It is also the only reward that still means anything at the far end.
`footfall` is *linear* in catchment, so +1 is worth about 6% more customers
whenever you get it; $2,000 is a decision on day nine and a rounding error on
day ninety, and a free van of stock is worth less the better stocked you are.
Which is why the ten town rungs added in step 2 are all at the hard end and the
easy new ones pay cash — the reward that scales goes where the difficulty is.

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

Three things, and all three are deliberate:

- Up to **+16 catchment** across the whole ladder, against a base of 16 — a
  doubled town, spread over the length of a shop's life and earned rather than
  bought. Ten of those sixteen are past `take-10000`, which used to be the top.
- Up to **1,386 units of free stock**, spread over forty-five awards, each
  capped by what the bay can hold — so a shop with a small yard collects less of
  it, which is the guard doing its job rather than a rung misfiring.
- **$76,600 in cash across all forty-five**, climbing 250 → 500 → 500 → … →
  1500 → … → 12,000. A shop opens on $250 — two crates and a seed tray — so the
  opening hour was a wait for one shelf to sell through rather than a decision,
  and the first rung pays the float over again. Every rung pays *something*: a
  ladder with a gap in it reads as a rung that is broken.

  **The opening is the steep part, and that is the shape rather than an
  accident.** `first-sale` 250, `take-100` 500, `first-plant` 500, `take-500`
  1000 — the first stretch is worth $2,250, against a middle where a shop taking
  $2,000 collects $400. Those two are the rungs that get spent on something: $500 is
  five raised beds' worth of the plot ladder's first step (4 × $90 takes every
  starting bed up one), and taking all four the whole way to Greenhouse is
  $1,400, which is a farm the farm can pay for rather than one a milestone hands
  over. Tier costs take no discount — `plot-2`/`plot-3` cut what a *new* bed
  costs to build, never what an existing one costs to improve.

The far half is priced against the shop that earns it rather than against the
rungs below it. `take-250000` pays $12,000, which is a fortnight's takings for
the shop that gets there and would be the whole game on day nine — the rungs
get further apart than the shop gets bigger (10k → 25k → 50k → 100k → 250k), so
each one is a longer wait than the last even while the shop is still growing. A
ladder whose rungs kept pace with the shop would be a progress bar.

One rung is the exception that proves the town is worth having: `flawless-day`
is the only one you can fail **by growing**, since every point of catchment the
rest of the ladder pays makes turning nobody away harder until you find the
floor space for them.

`simulate` earns them the same way you do — the ladder is not skipped on an
ephemeral game, because a balance bot that never sees a feature is the broken
instrument CLAUDE.md's auto-replant story is about. `startedWith.milestones`
reports the count and the resulting reach, because a shop that has earned six of
them is a different experiment from one that has earned none on the same seed.

The lifetime tallies are the one thing a save from before this cannot have:
`stats` is wiped nightly and `ledger` is capped at 30 days, so an established
shop starts the takings rungs from whatever it takes from today. Nothing pretends
otherwise, which is the other half of "a milestone is a measurement".

## The survival rungs taper, and nothing else on the ladder does

`g.day` is the one measure on the ladder that is not a measurement of how well
the shop is doing. Every other rung is a thing you did — takings, sales, a wall
you drew, a crop you picked — and the day is a thing you turned up for, which is
worth the whole opening on day seven and worth nothing on day ninety.

So that sub-ladder is front-loaded and tapers, backwards from every other run of
rungs here: **$500** at a week, **$350** at a fortnight, **$250** at three weeks,
and then a month is its own step up at **$600**. A shop opens on $250 — two
crates and a seed tray — and a week of trading on that leaves a range chosen one
crate at a time; the point of the first payment is that it is the first moment
the shop can buy a *decision* rather than a restock. What it is paying for is the
float being thin, and the float stops being thin, which is why by `hundred-days`
it is back to being a nod.

Two things it deliberately does not do. There is **no day-28 rung** — `month-one`
is eight in-game hours later, and two rungs that close together read as one rung
that fired twice. And **neither weekly pays `town`**: the sixteen rungs that do
are sized so finishing the ladder exactly doubles the catchment (see
`milestoneReach`), and a rung added to fix an opening has no business moving the
number the endgame is built on. An established save banks both quietly on its
next sweep, the way `known` promises — no card, no gift, one log line.

A week is about forty minutes of play (`DAY_SECONDS` is 360, and the night is
compressed), so this is the cadence the ladder had between `first-build` and
`sold-100` and then lost for a fortnight.

## Next, if it earns it

1. ~~**Rungs that are about the shop rather than the takings.**~~ Built as step
   2. Thirty-one rungs: the takings ladder extended so it stops topping out, and
   the half that is about the *shop* — six departments on the shelves at once, a
   wall you drew, a break area, a stockroom, a kitchen, a hot counter, a car
   park, ten charm, a promotion, a day without a hitch. Several of those exist to
   name a system a shop can play for eighty days and never walk into: a live save
   on day 81 had no appliance, no warmer and no parking, and nothing in the game
   had ever mentioned that any of the three were there.

   Two rules came out of writing them, both in the header of `goals.js`:
   **the first instant a measure is true is the award**, so a rung shaped as an
   *absence* awards itself at one minute past midnight unless it waits for the
   day to be over; and a measure returning 0/1 draws a bar that goes empty →
   full with nothing between, which is right — there is no being two thirds of
   the way to owning an oven.
2. ~~**A ladder that says something in the first fortnight.**~~ Built as step 3.
   Two weekly rungs (day 14, day 21) and a re-tuned survival run — see above.
3. ~~**The palette unfolds with the ladder.**~~ Built as step 4.
   `shared/reveal.js`. Twenty-six build kinds is a correct palette and a bad
   first minute — the only gate the shop has ever had is PRICE, so a new player
   meets conveyors, lifts, sorters, paddocks and a ceiling before they have sold
   anything. The complaint it draws is "too many buttons", and it is not a
   complaint about there being too much game: Factorio has far more and nobody
   says it, because you meet it over forty hours instead of in one screen.

   **It is a reveal and never an unlock, and that distinction is the only reason
   it can exist here at all.** Rule three above says a reward may not be a thing
   you unlock, because anything granting a fixture is a second way to *own*
   something and every rule in the shop about what you own is written against
   `placements` and `ownedUpgrades`. This grants nothing: it hides a button you
   could always afford, and on the day it turns up you are no richer and own
   nothing new. So `placeFixture` never asks, the server never asks, and MCP, a
   sweep, the balance bot and a co-op guest whose bar is further along all go on
   building whatever they like. `verify:reveal` §5 is that claim as an
   assertion, because the day it stops being true the reveal has quietly become
   a permission.

   Three things it rests on. **A gate may never be the thing it gates** — five
   rungs measure *having built the thing* (`first-kitchen` is "put an appliance
   on the floor", and `break-room`, `car-park`, `stockroom` and `first-warmer`
   are the same shape), so gating `station` behind `first-kitchen` is a button
   that arrives the moment it has stopped being needed, which reads as correctly
   authored and is off for ever. It is asserted empirically rather than against
   a banned list, so it cannot go stale when somebody writes a forty-sixth rung.
   **Unlisted is visible**, or a fixture authored tomorrow prices, places,
   renders and can never be found. And it is **per world, not per player**: a
   fresh shop can ease somebody in while a day-322 save keeps everything, which
   a browser setting could not say — the field defaults to `false` so no
   existing save loses a button, and `createWorld` writes `true`.

   The rung that matters is `sold-500` for the belt. Five hundred things over
   the counter is five hundred things somebody shelved by hand, which is
   Factorio's pickaxe said out loud: the answer turns up because you earned the
   feeling, not because a tech tree ticked over.
4. **A first-run ladder that teaches.** The first three rungs are the closest
   thing the game has to a tutorial and nothing says so. Naming them as one
   opening sequence — and opening the panel on a new shop — is a client change.
4. **Telling the other player.** The card is broadcast, so both people in a shop
   see it; nothing says *who* did the thing. `stats` has no per-player anything
   today, which is why it is a step rather than a line.
