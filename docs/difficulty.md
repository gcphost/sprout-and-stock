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

## Step 1b — the first week, which the table above never measured — **built**

The measurement in step 1 was taken against `shop-3-2` at **day 60**, and that
is the whole of what went wrong with it. A day-60 shop has a name, a range and
some charm on the walls; the preset lands on it as a slower climb. A day-1 shop
has none of those, and the same preset lands on it as a shop the town already
dislikes before the player has found the ordering menu.

A real `normal` save (`shop-6`, seed `vc8sxh`) on the second morning:

| | measured | on `relaxed`, same day |
|---|---|---|
| reputation | **0.150** — started at 0.500 | 0.500 |
| walk-in mood | **0.58** | 0.67 |
| headroom over `MOOD_ANNOYED` | **0.08** | 0.17 |
| seconds queueing before visible anger | **~6s** | ~12s |
| clean sales to pay off one storm-out | **~47** | ~22 |

Day one cost it `repMove: -0.253`. A quarter of the entire scale, in the day
somebody is still learning which button stocks a shelf.

**Three rows of that table multiply, and the table draws them as separate
knobs.** `normal` lowers `moodBase` by 0.04, which reads as 6%. It also lowers
`repSettle` from 0.35 to 0.22, so the spring catches a bad week much further
down. And `moodBase()` scales the room *by reputation* — so the 0.68 in the
table is what a shop at a perfect name gets, and a shop sitting at its own
settle level gets 80% of it. Then the way back out is
`0.008 * (mood - MOOD_ANNOYED)`, proportional to the same headroom the low
reputation just took away, which is the feedback loop `MOOD_REP`'s own comment
names and says charm is the escape from. On day 2 nobody can afford to
decorate.

`MOOD_BASE`'s comment states the rule this broke, and states it as deliberate:

> Above `MOOD_ANNOYED` by a clear margin on purpose. Start it near that line and
> a new shop's customers arrive already looking cross, which reads as the town
> hating you rather than as a room nobody has decorated.

### The shape of the fix

`GRACE_DAYS = 5`. A **loss** is charged at `day / GRACE_DAYS` of face value, in
`Game.moveRep`. That day-1 beating costs `-0.05` instead of `-0.253`.

**Losses only, and that asymmetry is the feature.** A gain is banked at full
price from the first minute, so a new shop climbs at the ordinary rate and falls
at a fifth of it — which is what digs one *out*, rather than merely slowing the
descent. Scaling both directions is the more elegant sentence ("the town has no
opinion yet") and it makes the opening week inert: nothing done on day 1 would
mean anything either way.

**In `moveRep` rather than at the nine call sites.** That function is already
the one writer, for the receipt — so an eighth cause added tomorrow inherits the
grace instead of being the one that still craters a beginner.

**Not a preset knob**, and this is the one place that is worth arguing. Every
other number in this doc is on the table; this one must not be, because the
harsher presets are exactly the ones that need it. A `hard` game with less grace
would compound the bug — and `hard` is already the worse case, since at
`moodBase: 0.60` a single bad day puts the walk-in *below* `MOOD_ANNOYED`, which
is the "decade of neglect" state arriving in week one. Same argument as
`MOOD_TAU`: how long a town waits before making its mind up about a new shop is
the same fact about towns everywhere.

**It reads `this.day`**, which is already on the save — no clock to persist and
no `elapsed` trap. Deliberately the shop's own age rather than time since the
save was opened, or picking a world back up after a month away hands it another
free week.

### ...and the two numbers underneath it, which were the actual complaint

Grace fixed the first week and the shop still played wrong on day 6, trading
well, because two constants had been tuned against assumptions a later feature
retired. Both are the same shape and neither is visible in anything but play.

**A visit could not out-earn a miss.** `REP_VISIT` (was 0.008) is the only way
reputation is ever *earned*, and it is scaled to a mood of 1 that nobody can
reach — `ANNOY_IN_SHOP` draws from the door, so a good trip lands near 0.65. It
paid a fifth of its own ceiling. Beside a flat −0.008 per missed line and −0.015
for an empty-handed leave, one miss was worth 6.7 happy customers and the best
possible visit was worth half a miss. Six boards cannot cover twelve lists, so
it was a charge for being early at twelve times what serving somebody perfectly
paid. Now 0.02, scaled by fill, and the miss is charged on the **share** of the
list rather than per line — so three of four things and left happy books
positive, barely, which is the intent.

**`patience` had stopped meaning seconds.** See the ⚠️ under "no harder
customers" below.

**And a brand new shop's first customer was already cross**, which is the one
that needed no play at all to hit. `MOOD_REP` ran over 0..1, so the multiplier
was `0.75 + 0.25 * rep` and only a *spotless* shop got the room it had built. A
new shop starts at `DEFAULT_WORLD.reputation` — 0.5, not because it is half bad
but because nobody has an opinion yet — so it paid half the penalty on its first
morning: `moodBase` 0.68 arrived as **0.595** against a `MOOD_ANNOYED` of 0.5.
Nine and a half points of margin where the table promises eighteen, before the
player has done anything. It pivots on the starting reputation now
(`REP_NEUTRAL`), which restores the day-one margin exactly *and* finally pays
the upper half of the term: a shop the town loves walks people in at 0.85, where
before it could only ever fail to be penalised.

| rep | walk-in, before | after |
|---|---|---|
| 1.00 | 0.680 | **0.850** |
| 0.50 (new shop) | 0.595 | **0.680** |
| 0.13 | 0.532 | 0.554 |
| 0.00 | 0.510 | 0.510 |

Measured, 60 days, three seeds, on `shop-3` (day 365, `normal`, 14 staff):
profit 5.1k–6.6k, rep **0.66 / 0.72 / 0.73**, 3–9 storm-outs. That save had sat
at **0.148 after 365 real days** of play. Read it as a sanity check rather than
a balance measurement — all three changes move the rng stream, so these are not
comparable seed-for-seed with anything above. What it does say is that the loop
does not run away: mood feeds the visit gain and the gain feeds reputation and
reputation feeds mood, and no seed pinned at 1.0. The failure mode this replaced
was a bar that never moved; the one to watch for next is a bar that only goes up.

### What it does not fix

The step-1 measurement is still the only one there is, and it is still a day-60
one. This makes the first five days survivable; it says nothing about whether
`normal` is correctly tuned from day 6 onward, and the `hard` preset's
below-the-line walk-in is untouched — grace delays it rather than removing it.
Both want a balance run taken from a **new** world rather than an established
save, which is the run nobody has done.

`verify:grace` — 124 checks. Its control is the assertion that decides whether
this is opt-in at all: a shop past the ramp is the old game to the digit, on
every cause in `REP_CAUSES`, in both directions. Every save in existence is
played well past day 5, so if that control is wrong this step has quietly
rebalanced all of them. It restates the ramp rather than importing `GRACE_DAYS`,
so a retune is supposed to fail it and be read.

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

  ⚠️ **That last clause was wrong, and step 1b fixes it.** It is true in
  budget-per-second and false in seconds, which is the only unit anybody can
  see. `stepMood` drained an absolute amount against a budget that now *starts*
  at 0.6–0.7 instead of 1, so a queue cost the same per second out of two thirds
  of the money — an authored `patience: 70` was buying about 45 seconds, and
  `ANNOY_LINE`'s "runs out in exactly `patience` seconds" anchor quietly stopped
  holding for every archetype at once. Worse for the half you can watch, since
  `MOOD_ANNOYED` is absolute too: time from the door to somebody *looking* cross
  in a line fell **3.35x**, a Snack Kid from 13 seconds to 3.9. The drain is
  scaled by the walk-in now, which restores the storm-out anchor exactly and
  leaves the shortened fuse to anger — that part IS the feature, and charm is
  what buys it back. The general shape is worth keeping: **a starting value and
  a behaviour are the same thing when the thresholds below are absolute.**
