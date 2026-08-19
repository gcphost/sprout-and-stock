# Difficulty — why a neglected shop doesn't rot

Status: **step 1 built.** 2–4 proposed.

---

## The hole

A shop you stop looking after does not go under. It does not even get worse. It
finds a level and sits there, and it will sit there for a hundred days.

That is not a bug anywhere — every piece of it is a decision somebody made for
a good reason, and the reasons are all still good. It is what those decisions
*add up to* that nobody has looked at, and there are three of them.

### 1. There is a spring pulling you back up

`REP_SETTLE = 0.35`, `REP_SETTLE_RATE = 0.45` (`server/sim/index.js`). Every
trading night a shop below 35% closes **45% of the gap** back up to it. Neglect
therefore does not bleed, it *converges*: a shop losing 0.1 a day settles at
about 0.13 and stops, which its own comment says out loud.

It exists for a real reason and the reason has not gone away. The per-visit
arithmetic is negative for a small range whatever the player does — a perfect
sale is worth at most +0.004, one staple you did not stock is −0.008 against it
— so a shopper who buys two of the three things they came for and leaves
delighted is a **net loss**, and the opening week of every shop bleeds by
construction. Two real saves floored inside nine days and could not have played
their way back in under a week of flawless trading.

So the spring is right. It is also the single load-bearing reason that doing
nothing has a floor under it.

### 2. There is a floor under demand

`pull` clamps at `0.08` (`server/sim/economy.js`). At zero reputation the shop
still gets 8% of the town walking in — "what walks past and comes in anyway",
which is a true sentence about a real shop and is also a guaranteed income.

### 3. Nothing costs anything

`payWages` is the **only** fixed daily cost in the game, and it is zero until you
hire somebody. There is no rent and no upkeep. Spoilage bins stock but
deliberately moves no cash — it prices what it threw away into
`stats.spoiledValue` as a readout, because you already paid for that milk when
the van came.

So: **doing nothing is free.** A shop with no crew has no outgoings at all.

### ...and the one number that keeps moving, moves up

This is the sharp end of it. `townGrowth` is measured on `day` and nothing else
— on purpose, and the comment is right about why:

> A shop that shuts for a week still ages, and that is right: the town did not
> stop growing because you did, and the shutters already cost you the trade.

That is correct about a shop that shut for a week. It is something else over a
season. `BASE_CATCHMENT` is 16 and `TOWN_GROWTH` adds +3.9 by the end of week
one, +11.5 by day 26 and +22 by day 100 — so on a shop that has floored, the
only term in `footfall` still in motion is the one making it **busier**.

Reputation converges to 0.35. Catchment climbs from 16 towards 38. A neglected
shop on day 100 is taking more money than it was on day 20, and the calendar did
it. Neglect is not merely survivable, it is on a slow reward curve.

### What it looks like from the chair

You come back to a shop you have not touched. Rep says 35%, the takings are
fine, the crew are working, and nothing anywhere is asking anything of you.
There is no failure state to avoid, so there is nothing to be good at avoiding.

---

## What difficulty is here, and what it is not

**It is not a multiplier on the takings.** Scaling revenue or footfall by 0.8 or
1.3 changes how long the same shop takes to reach the same place. It moves the
speedometer and nothing about the road.

**It is the shape of the failure, and whether there is one.** Three questions,
and a preset is an answer to all three:

| | |
|---|---|
| **Does standing still cost?** | upkeep |
| **How far down can neglect go?** | the settle floor, the pull floor |
| **How fast does the town arrive?** | the town's clock |

**It is a second axis, not a replacement for the first.** `START_TIERS` already
owns *how much shop* — money on day one and the building around it. That is a
question about where you begin. Difficulty is a question about what happens
next, and mixing them would mean the only way to play a hard game is to play a
small one.

---

## Where it lives

`shared/difficulty.js`, a sibling of `shared/start.js`, and for the same reason
that file gives: the server reads the numbers and is the authority on them, the
menu reads `name` and `blurb` to say what you are choosing between. Labels
hardcoded in the client beside numbers held on the server is the
second-picture-of-one-thing trap `client/thumb.js` exists to avoid, and here it
would present as a menu that promises a hard game and hands you an easy one.

An explicit table of real numbers rather than multipliers over the constants —
same shape as `START_TIERS`. `0.6 × REP_SETTLE` is a number nobody can read;
`repSettle: 0.2` is one you can argue with.

### The field, and the asymmetry that makes it safe

`world.difficulty` is a string id, written by `createWorld` into
`startingState`, exactly as `tier` is and for exactly the reason the comment
there gives — what a shop was started under has to be a **fact about that save**
rather than a function of which build was running the day somebody opened it.

The default is the whole trap, and it is the same one CLAUDE.md documents about
`open` and `time`:

- **A save that has never heard of the field reads as `relaxed`** — the preset
  whose numbers are today's constants to the digit. So no existing shop moves,
  and every headless game moves less than that: `simulate` and all fifteen
  `verify:*` sweeps read the save, so a default that shifted the constants would
  have every balance run measuring a different game with nothing in the output
  to say why. Same trap as defaulting `open` to `false` and reporting zero
  revenue.
- **A new shop is written `normal`**, which is harder than today.

That asymmetry is the point, and it is why the easy preset is not called
"normal" despite being what everyone has been playing. Today's game *is* the
gentle one — it just never had anything beside it to be gentle compared to.

---

## Step 1 — the preset, on the knobs that already exist — **built**

All of these levers were already constants with nothing but a `const` between
them and being configurable. This step is the table, the field, the menu row,
and reading them off it — no new mechanic anywhere, and a genuinely harder game
at the end of it.

| knob | today | `relaxed` | `normal` | `hard` |
|---|---|---|---|---|
| `repSettle` | 0.35 | 0.35 | 0.22 | 0.10 |
| `repSettleRate` | 0.45 | 0.45 | 0.30 | 0.18 |
| `pullFloor` | 0.08 | 0.08 | 0.05 | 0.02 |
| `moodBase` | 0.72 | 0.72 | 0.68 | 0.60 |
| `moodFloor` | 0.45 | 0.45 | 0.42 | 0.36 |

The mood pair is the one the player *feels* first, since it is the patience
budget somebody walks in with and everything in `stepMood` draws on it. A hard
shop has less slack for a queue before the first storm-out, which is the same
lever charm already pulls the other way.

**Both ends of the mood slide, not just the walk-in.** `MOOD_BASE` is what the
town expects of a shop that has just opened and `MOOD_FLOOR` is what it expects
of one that has been there a year, and taking only the first would make a
preset that expires: every shop converges on `MOOD_FLOOR` over `MOOD_TAU`
whatever it started at, so a hard game would quietly become the normal one by
about day 200. `MOOD_TAU` itself is deliberately *not* a knob — how fast a
town's standards rise is the same fact about towns everywhere, and a preset
that moved it too would be saying two things with one button.

### Measured

Three seeds, sixty days, one frozen copy of a real save (`shop-3-2`, day 60),
same world and same modifiers throughout — only the preset differs:

| preset | profit | mean | final rep |
|---|---|---|---|
| `relaxed` | 29,599 / 22,707 / 23,011 | **25,105** | 35 / 30 / 32 |
| `normal` | 20,766 / 11,599 / 16,437 | **16,267** | 41 / 34 / 29 |
| `hard` | 9,637 / 4,304 / −13 | **4,642** | 8 / 29 / 35 |

`relaxed` reproduces the old constants **to the dollar on all three seeds** —
verified against a run in which the preset was not reaching the sim at all and
every path was therefore taking the original fallback. That equality is the
claim every existing save rests on, and it is the one to re-check after any
retune of this table.

Two honest caveats. The balance bot never decorates, so `moodBase` and
`moodFloor` are measured with the charm term at zero — a decorated shop closes
most of that gap and these figures are the ungenerous end. And rep at day 60 is
noisy at three seeds; the profit column is the signal here, the rep column is
an illustration.

**`repSettle` stays one-sided.** It pulls up and never down, whatever the
preset — a two-sided drift toward a mean is a cap on the best shops in the game,
which is a balance change wearing a bug fix. Hard lowers where a bad week stops;
it does not touch a shop that is doing well.

**It stays gated on `traded`.** Ungated, a week of shutting early is the
cheapest way back to mediocre, and that gets cheaper the harsher the preset.

**The pull floor is the one to be careful with.** At `0.02` a floored shop is
getting a fortieth of the town, which is the "hole with no bottom" the settle
spring was built to fill — the two knobs are in tension by construction and
`hard` is deliberately the only preset that leans on both. One of the three hard
seeds finished the run at −$13, which is the first time a `simulate` run of an
established shop has come back negative without somebody over-hiring, and is
either the feature working or the preset overtuned. Play will say which.

### The trap it sprang

`Game.create` does **not** spread the saved world — it names every field it
passes to the constructor. So a field added to the save *and* to `saveState` is
still dropped on the way in unless it is named there too, and it fails in the
quietest way available: the world persists a difficulty, reloads without one,
and the constructor's fallback hands back the gentle preset. A shop set to hard
then reads as hard in the menu, plays as relaxed, and nothing anywhere
disagrees.

It was caught by the balance run above returning **byte-identical takings on all
three presets** — which is worth keeping in mind, because a three-preset sweep
that comes back suspiciously equal is the shape this bug makes, and every sweep
in `npm run verify` passed happily either side of it.

---

## Step 2 — upkeep, which is the one with teeth

The building costs money to have. Per fixture, per day, charged in `payWages`.

Everything above only changes where the equilibrium sits. This is the step that
decides whether there is one, because it is the only thing on the list that
makes **standing still** a losing position.

### It goes in `payWages` rather than beside it

That function already logs `Paid $X in lease and power` — the robot rebrand's
words for a wage bill. Power for a building with nobody rostered on is currently
free, which is the fiction hole the mechanic walks through: one charge, one log
line, one number in `stats.spent`, and no second midnight mechanic firing on a
number the player cannot see coming.

### Per fixture, not flat

A flat charge is a tax on playing. Per fixture is the lesson `BASE_CATCHMENT`
already claims to teach and currently cannot:

> Six shelves is already slightly too much shop for it, which is the intended
> first lesson.

Nothing in the game has ever charged for that. An empty shelf costs exactly what
a busy one does — nothing — so there has never been a reason not to build. Under
upkeep, a shop bigger than its town is a shop losing money every night, which is
a sentence the ledger can say.

Read off `Game.fixtureCounts()` — the recount, never a stored number, for the
reason CLAUDE.md gives about the retired ledger. A decoration weighs nothing
here as it weighs nothing everywhere else.

| | `relaxed` | `normal` | `hard` |
|---|---|---|---|
| per fixture per day | 0 | ~$1.50 | ~$4 |

`relaxed` at zero is what keeps every existing save byte-identical, and it is
also an honest preset: a game with no upkeep is the relaxing one, which is what
was asked for.

### Nothing repossesses anything

Cash already goes negative and `payWages` already says so in the log, and
`simulate` already reads negative cash as bankrupt. That is the whole failure
state and it does not need a second one. Fixtures being sold out from under a
shop in the night would be a mechanic firing on a number the player cannot see
coming — the same argument `payWages` makes about staff not walking out over a
missed wage.

**Numbers are a starting point, not a proposal.** Upkeep is the first fixed cost
the game has ever had, it compounds against every other number in it, and
`simulate` over ten seeds per preset is the only thing that can say what it is
worth. Run it against a copy (`SNS_DB`), not the shared world.

---

## Step 3 — the town's clock

`TOWN_TAU` per preset: how fast the town arrives around you.

This is the half that was actually asked for — *hard is just progressing way
fast*. Not more money: **more people than the shop can currently cope with**,
which the sim already knows how to punish. `R.CROWD` drains reputation for every
tick the shop is over its comfortable occupancy and `R.TURNED` charges for
everybody who looks in at a full door and walks on. Both of those are live and
both are nearly unreachable today, because the town arrives slowly enough that
you have always built the next till before you needed it.

| | `relaxed` | `normal` | `hard` |
|---|---|---|---|
| `townTau` | 40 | 40 | 22 |
| `townGrowth` | 24 | 24 | 30 |

Deliberately identical on `relaxed` and `normal`. The clock is the *last* thing
to touch, because unlike the other two steps it moves revenue as well as
pressure, and a preset that hands you more customers and more money is only
harder if the crowding actually bites. That claim needs measuring before it
needs tuning.

`townGrowth` stays saturating on every preset. A term that climbs for ever is
not a town, it is a printing press with a slow fuse.

---

## Step 4 — saying which game you are in

Open, and probably small:

- **A row in the Shop report.** The one panel that is a picture rather than a
  list, and the natural home for "this shop is playing hard, upkeep cost you
  $84 this week". Upkeep in particular needs a line somewhere or it is a
  mystery deduction — same problem `stats.repMoves` was built to fix for
  reputation.
- **The world menu.** A shop's difficulty belongs beside its seed and its day in
  `summarise`, because it is the same class of fact.
- **Whether it can change.** Leaning no. It is a fact about the save the way the
  seed is, and a shop that spent forty days on relaxed and switched to hard has
  a ledger that means nothing. If it does become changeable it wants a mark on
  the save, so a run can at least say it happened.

---

## `verify:difficulty` — what a sweep would have to claim

Every claim here is invisible in a screenshot by construction, so this ships
with the feature rather than after it, the way `verify:motion`, `verify:hand`,
`verify:park` and `verify:doors` did.

The centrepiece is a comparison rather than a value: **a game on `relaxed` is
today's game to the cent.** Same seed, same world, sixty days, identical
takings, identical reputation, identical ledger. That is the claim every
existing save and all fifteen sweeps rest on, and it is the one that quietly
stops being true the day somebody retunes a constant and forgets the table
beside it.

Then:

- **A save with no `difficulty` reads as `relaxed`**, and an *unknown* id does
  too rather than throwing — the argument `startTier` makes about the last gate
  before a shop exists.
- **The preset is on the save, not on the process.** Two worlds open at once
  under two presets tick differently, which is the co-op case and the one a
  module-level constant would silently get wrong.
- **Upkeep is a recount.** Build two shelves and sell one back; the charge
  follows the shop, not a ledger beside it.
- **Upkeep charges once per day**, at the roll, through `payWages` — not per
  tick, not per re-flow. A cost that fires on a re-flow is a shop that charges
  you for building in it, and build mode re-flows on every wall segment of a
  drag.
- **`relaxed` upkeep is zero and moves no money at all**, rather than charging
  $0.00 and writing a log line every morning.
- **The settle spring is still one-sided on every preset** — a shop at 0.9 on
  `hard` does not get dragged down to 0.10.
- **A day with the shutters down still earns no settle**, on every preset.

---

## What is deliberately not here

- **No difficulty on content.** Items, crops, archetypes and fixtures are one
  shared library across every save — that is the co-op premise. A preset that
  changed what a tomato costs would be a world reaching into the library, and
  two shops on two presets would disagree about the same row.
- **No cheaper stock or dearer stock.** Wholesale prices are the tag system's,
  and a blanket multiplier on them is the "moves the speedometer" version of
  difficulty this doc opens by rejecting.
- **No smarter or dumber crew.** A hire's directives are theirs, authored, and
  spending points is the decision. Difficulty tuning them would make the same
  worker two workers.
- **No harder customers per se.** `moodBase` is the one exception and it is a
  starting value rather than a behaviour — everything downstream of it in
  `stepMood` is untouched, so a queue costs what a queue costs.
