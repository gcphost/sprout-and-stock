# Workers — design

Status: **steps 1–6 and 8 built.** A worker is authored content, hiring is a
roster, every hire has its own menu, tiers restage the model, everybody gets
paid, and a worn-out hire downs tools and does something authored about it —
visibly. Step 7 (tags, zones, experience) is still proposed.

The goal: a worker is authored the same way a fixture is. Its look, its stats,
its upgrade ladder and what it is willing to do all come out of the database, so
a new kind of worker is one MCP call and no code change.

---

## What was wrong

Hiring was content; workers were not.

- The **hire** is an upgrade row (`staff-clerk`, `kind: 'staff'`,
  `payload.role: 'clerk'`). Name, cost and description are all authored.
- The **worker** is code. `stepStaff` dispatches on four literal strings, and
  `ROLE_NAME`/`ROLE_COLOR` are hardcoded maps of the same four.
- `hiredRoles` ends with `.filter((r) => r && ROLE_NAME[r])`, so a role the code
  doesn't know is dropped silently — you can author `staff-butcher`, buy it, pay
  for it, and no one turns up.

Three more things follow from the same root:

- **One of each, forever.** Hiring is upgrade ownership, so you cannot have two
  stockers, and you cannot let one go.
- **No look.** Every hire is a coloured capsule from `ROLE_COLOR`. Items, crops
  and fixtures all carry an authored `model`; workers are the only visible thing
  in the game that doesn't.
- **No ladder.** Fixtures have `tiers` — a shelf goes Plain → Tall → Signed, and
  the model restages as it climbs. A worker cannot get better at anything.

## The shape

Two halves, and keeping them apart is the whole design.

| | Where | Holds |
|---|---|---|
| **A kind of worker** | `workers` content table | look, base stats, tier ladder, cost, the jobs it starts with |
| **A hired worker** | `world` runtime state | which kind, which tier, its assigned jobs, its name |

The content half mirrors `fixtures` deliberately — same columns, same staged
model, same tier ladder — because that machinery already exists and already
works:

```sql
CREATE TABLE workers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  model      TEXT NOT NULL,                -- JSON, staged by tier, exactly like a fixture
  tiers      TEXT NOT NULL DEFAULT '[]',   -- JSON [{name, cost, speed/pace/carry/wage_mult}]
  jobs       TEXT NOT NULL DEFAULT '[]',   -- JSON [{job, weight}] — what this kind does out of the box
  cost       REAL NOT NULL DEFAULT 0,      -- one-off, to take them on
  wage       REAL NOT NULL DEFAULT 0,      -- every day they stay
  speed      REAL NOT NULL DEFAULT 2.6,    -- tiles per second
  pace       REAL NOT NULL DEFAULT 0.7,    -- seconds between jobs
  carry      REAL NOT NULL DEFAULT 6,
  color      TEXT NOT NULL DEFAULT '#7a9e4b',
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);
```

`ModelSchema` already supports stages, and `stageIndexAt`/`tierProgress` already
pick the right one — so "upgrade the worker and they look different" costs
nothing new. A worker with one tier simply never restages.

## Jobs are the vocabulary

This is the part that makes a worker generic. A role stops being a program and
becomes **a list of jobs with weights**. One stepper draws from that list and
takes the first job that has work available.

The vocabulary is not invented — it is what the four existing steppers already
do, named:

| Job | What it does | Lifted from |
|---|---|---|
| `serve` | stand at a till, take money, ring people up | `stepClerk` |
| `restock` | order wholesale to refill an empty shelf | `stepStocker` |
| `unload` | carry a pallet at the bay onto shelves | `stepStocker` |
| `shelve` | put whatever is in hand onto a legal shelf | all four |
| `till` | turn rough soil over | `stepFarmhand` |
| `sow` | plant the chosen crop in a bare bed | `stepFarmhand` |
| `harvest` | pick a ripe plot | `stepFarmhand` |
| `craft` | load a station, collect what it made | `stepChef` |
| `tidy` | crate what can't be put away, at the bay | `putDown` |

### Each job carries a weight

A bare ordered list can only say "do this, and that only when there is nothing
of the first left". That makes a clerk who also farms useless — one shopper in
the queue and they never leave the till again.

So a job list is `{ job, weight }`, and the weight is how much of that worker's
attention it gets:

```json
[{ "job": "serve", "weight": 7 }, { "job": "harvest", "weight": 3 }]
```

Picking is two steps, and both matter:

1. **Weighted draw** for which job to try — so with work available everywhere,
   that worker spends roughly 70% of their trips on the till and 30% in the
   field.
2. **Fall through by descending weight** if the drawn job has nothing to do —
   so an idle till still sends them to the crops rather than standing there.

Which means weight reads as priority when only one job has work, and as a time
share when several do. That covers both things you'd want to say.

Use `game.rng.weighted(jobs, 'weight')` — the same call that already picks
customer archetypes by `spawn_weight`. It must be the seeded rng and not
`Math.random`, or two `simulate` runs of one seed stop matching and the balance
comparison the whole workflow rests on quietly becomes noise.

Today's four roles are then just presets, and they must come out identical:

```
clerk    → serve 10, tidy 1
stocker  → unload 10, restock 8, shelve 8, tidy 1
farmhand → harvest 10, sow 8, till 6, shelve 8, tidy 1
chef     → craft 10, shelve 6, tidy 1
```

Those lopsided weights are the old strict priority, near enough: a low-weight
job that never has work costs one failed draw and falls straight through.

**Measured, 120 days, seed `workers-baseline`, modifiers cleared** — and read the
warning under the table before trusting the numbers:

| | before | after |
|---|---|---|
| profit | $41,551 | $43,195 (+4.0%) |
| sold | 26,868 | 28,633 |
| spoiled | 335 | 244 |
| left empty | 405 | 327 |
| abandoned | 0 | 0 |
| bankrupt | never | never |

> ⚠️ **These two runs are not strictly comparable, and neither are most figures
> taken across a working session.** `simulate` builds its throwaway game from
> the *saved* world, so the roster and owned upgrades ride along; a `npm run
> seed` in between re-upserts every content row from the seed files. Both
> happened here. Runs are perfectly deterministic — the same seed against the
> same content and the same roster gave identical profit three times — but the
> conditions have to be pinned by hand. That is why every result now reports
> `startedWith`.
>
> The one clean, reproducible finding from chasing this: **staff arriving on day
> 5–7 instead of day 10–14 is worth about 14% of profit over 120 days.** Early
> hires compound, which makes wages (step 6) a more interesting decision than it
> looks.

Not identical, and it was never going to be: the old code was a fixed if-chain,
so a worker whose first job had nothing to do simply idled. Now it falls
through, which is why fewer shelves sit bare and less stock spoils. A second
seed on a leaner start was healthy too. Treat the numbers as the *shape* of the
acceptance test — profitable, nothing abandoned, no new dead stock — rather than
as an equality.

Each job is one function with one signature, so adding a tenth is additive:

```js
// Returns true if it took the job this tick.
function serve(game, worker) { … }
```

Anything a job needs that a player action already does, it calls — `game.serve`,
`game.stockShelf`, `game.plant`. A job that reimplements a rule is a bug waiting
for the two copies to disagree.

**Every job guards itself, and nothing may assume it runs first.** The draw is
weighted, so the order is not fixed — which turned two pieces of old ordering
into real preconditions:

- `restock` refuses while there is a pallet at the bay it could unload instead.
  Ordering on top of stock already on the floor is how a shop ends up with a
  full delivery bay and bare shelves.
- `till` refuses while a turned bed is still waiting for seed, or a worker
  breaks ground across the whole field before a single seed goes in.

Both were comments inside the old steppers explaining the if-order. Turning them
into checks is what makes the order stop mattering.

Each hire's current job goes out in the snapshot as `job`, because staff never
set `action` — that is the armed-action field a human's held button drives, so
without it the roster could only ever say "idle" about someone halfway up a
field.

## Stats come off the tier

`STAFF_SPEED` and `ACT_COOLDOWN` used to be constants in code. They are now base
stats on the kind, multiplied by the rung the hire has climbed to:

| Stat | Means |
|---|---|
| `speed_mult` | how fast they walk |
| `pace_mult` | how quickly they take the next job (the cooldown) |
| `carry_mult` | how much they can hold in one trip |
| `wage_mult` | what keeping them costs — see wages below |

Same shape as a fixture's `capacity_mult`/`speed_mult`/`keeps_mult`, and read
the same way, so the tier UI is the one already in the fixture menu.

`promote(id)` charges the next rung's cost and bumps one number in the roster.
Everything else follows from that number being read fresh every tick:

- **`syncStaff` keeps the body in step with its roster row** — tier, name and
  colour, not just at spawn. Setting the tier only when the NPC is first created
  meant a promotion did nothing at all until the shop restarted, which is the
  kind of bug that reads as "the upgrade is cosmetic".
- **The snapshot carries `hire` and `tier`.** The roster says who works here and
  the player entry says what they are up to; without a key on the body the UI
  can only join them by rebuilding `staff-${id}`, which makes an id format into
  a protocol.

## Workers are drawn from their own model

Workers were the last visible thing in the game still hardcoded to a coloured
capsule. `Scene.buildActor` now builds a hire out of its kind's authored `model`
at `tierProgress(tier, tiers.length)` — the same `model` + `tiers` pair a shelf
uses, through the same resolver. Everyone else keeps `buildCharacter`: a shopper
is not authored content, and the one in the white hat is you.

`syncActors` grew an optional `keyOf`, so a body is rebuilt when what it should
look like changes and not otherwise — a promotion restaging the model, or a kind
redrawn over MCP (`setCatalog` clears the keys, so the redraw reaches the people
already on shift rather than only the next one you hire). The bubble and
whatever is in their hands are children of the body, so they leave with it and
are re-hung by the two syncs immediately below.

Verified by part count in a live page: a tier-1 stocker draws 3 parts, tier 2
draws 4, and the key moved `stocker:1` → `stocker:2` on promotion.

**A worker with no front detail has no visible facing.** `buildCharacter` adds a
nose nub; an authored model gets exactly what was authored, and `shop-hand`'s
first rung is a capsule and a sphere, so you cannot tell which way it is looking.
That is the right way round — looks are content — but it means a new kind wants
*something* on its front, and the fix is an MCP call rather than a code change.

## Runtime: hiring, firing, assigning

Hiring stops being upgrade ownership, because ownership can't express "two
stockers" or "let this one go".

- `game.roster` — an array of `{ id, kind, tier, name, jobs }`.
- `hire(kind)` — charge the kind's `cost`, push a record, `syncStaff` gives it a
  body. **Fires the "one of each" limit into the sea.**
- `fire(id)` — remove the record and the body. **No refund**: you cannot sell a
  person back, and a half-refund would make firing-and-rehiring a way to dodge a
  wage. What it costs instead is a confirmation — see the menu below.
- `assignJobs(id, jobs)` — set that hire's jobs and their weights. This is the
  screen the whole design exists for.
- `promote(id)` — charge the next tier's cost, bump `tier`. Nothing else: the
  stats and the model are both read off that number every tick.

The existing `staff-*` upgrades get migrated to `workers` rows on seed, and the
upgrades themselves retired — leaving them would mean two ways to hire.

## The UI — `client/worker-menu.js`

The Staff section lists who is on shift, and **the row is the way in**: tapping
a name opens that person, exactly as tapping a shelf opens that shelf. Two
stockers are two rows, and which one you pressed is the only thing that can tell
them apart — which is the whole reason a hire is a roster row.

"Take someone on" reads `catalog.workers`, not the staff upgrades, so a kind
authored over MCP is hireable with no client change, and hiring the same kind
twice is a second person rather than a refusal.

No new panel machinery, per `docs/ui-shell.md`. Three things made that true:

- **One tick hook, not a branch per menu.** `showFixture` used to be refreshed
  by an `if (openPanel === 'fixture')` block inside `UI.update`. A hire's menu
  needs the same treatment — what they are doing changes every few seconds, and
  the other player can let them go while it is open — so the branch became
  `this.panelTick?.(this)` and each menu registers its own. `ui.js` came out six
  lines shorter and the next per-entity menu costs it nothing.
- **`act()` is exported from `fixture-menu.js`.** A hire's menu offers verbs
  too; two copies of that row template would drift the first time one was
  styled.
- **The job vocabulary travels in the catalog.** `MartRoom.catalog()` sends
  `JOBS`, so the assignment screen offers exactly what `staff.js` implements. A
  tenth job appears in the menu the day it exists, under its own name if nobody
  has written a blurb for it — and a job the client invented could never be
  offered.

### Weight zero is off

There is no checkbox. Each job is a row with a −/value/+ dial, and nothing (`·`)
means never. A job at weight zero and a job missing from the list are the same
thing to the sim, and two controls standing for one number is how they end up
disagreeing. Pressing − on the last remaining job says *"everyone needs at least
one job"* rather than sending a list the server would reject.

The dial's ceiling is `max(10, whatever they are on)`, so a weight authored
above the cap can still be brought down instead of being stuck.

### Letting someone go asks twice

Removing a shelf hands half the money back and you can build another. Letting
someone go refunds nothing — you cannot sell a person back — so a mis-tap in a
scrolling list costs a whole hire. The first tap arms the row (it changes to
*"Tap again to let them go"*), the second does it, and the latch times out after
four seconds. The latch is part of the menu's redraw signature, or the row would
sit there offering a second tap long after one had stopped working.

This is the only confirm in the game, and deliberately so: everything else a
menu offers is either reversible or refunds half.

### Rows are their own template, not `ui.rowHtml`

`ui.rowHtml` carries at most one button and a stepper is three controls, so the
job rows are built locally — the same call `fixture-menu.js` makes with `act`.
They use the shared `.row`/`.name`/`.tags` classes and borrow `.fx-price` for
the dial, so they match every other list without a second implementation. The
three lines of new CSS only shrink it: a weight is one digit where a price is
five.

Measured in a real browser at 1280×800: rows come out 43–57px in a 214px panel
with no horizontal scroll, which is the same band every other section sits in.
Blurbs are one clause each for that reason — the two-line clamp means a longer
one is not wrong, just invisible.

## Proved end to end

A worker kind that exists **only** in the database, with a job mix nobody wrote
code for:

```
POST /api/content/worker   id: shop-hand
  jobs: serve 6, unload 4, shelve 4, harvest 2, tidy 1
```

Hired from the Staff menu, turned up on the floor under its authored name, drawn
from its own authored model, stood idle through an empty queue, and took
`harvest` the tick a plot ripened. No client change, no sim change, no restart.

That used to need a second row — a `staff-*` upgrade to sell the hire. It
doesn't any more: the Staff menu lists `workers` directly and `buyUpgrade`
refuses `kind: 'staff'`, because two ways to hire is one too many.

One bug it flushed out, worth keeping in mind: `ICONS[role] ?? fallback` cannot
work, because the strict lookup throws before `??` sees anything. Optional
lookups use `icon(name, fallback)`. An icon per authored kind is a contradiction
anyway, and the real answer landed in step 5 — the worker's own `model`. The
fallback icon survives only for the roster row and the menu title, where
something has to sit next to a name.

### The whole loop, driven in a real page

The server has no renderer and the panel is DOM over the canvas, so `screenshot`
cannot see a menu. Both were driven by scripting a headless Chrome over CDP and
reading `__sns.state` back after each click:

- **hire** — roster 2 → 3, the new row carries the kind's job list, copied.
- **assign** — `harvest` 0 → 4 and `unload` 10 → nothing, arriving at the server
  as `[restock 8, shelve 8, harvest 4, tidy 1]` in vocabulary order.
- **promote** — `tier` 1 → 2 on both the roster row and the body, cash −$240
  exactly, the Grade line reading `Runs the back`, the promote row gone at the
  top of the ladder, and the scene rebuilding the body from `stocker:1` (3 parts)
  to `stocker:2` (4 parts).
- **let go** — first tap arms and the roster is unchanged; second tap removes the
  row and closes the panel.

Console clean throughout, bar a three.js deprecation warning that predates this.

## Wages — `Game.payWages`

The one that fixed a real hole rather than adding a feature. A hire used to be a
one-off cost with unlimited upside, so taking on every worker the moment you
could afford one was strictly correct and there was no ongoing decision at all.

Charged at the day roll, right after the spoilage sweep, against the day that
has just ended — `this.stats` is not rolled over until the bottom of
`onNewDay`, so the wage lands on the day they worked. The wage is on the *kind*
and multiplied by the rung's `wage_mult`, so a promotion is a raise as well as
an upgrade; without that, promoting everybody is the same free lunch one level up.

**Cash is allowed to go negative, and nobody walks out.** Negative cash is
already exactly what `simulate` reads as bankruptcy, so the failure mode needed
no new machinery. Staff leaving in the night would be a second mechanic firing
on a number the player cannot see coming, and the ledger going red says the same
thing somewhere they can act on it.

### What it is priced at — and why `simulate` cannot answer that

**The wages are as authored: $6–$9 a day.** They were briefly halved on a
measurement that turned out to be worthless twice over. Both mistakes are worth
more than the number is.

**First: the workers were broken.** `shelfFor` and `pickItem` had been dropped
from `staff.js` during the step 1–3 port and existed nowhere in the tree.
`restock`, `unload` and `shelve` all call one of them, so all three threw a
`ReferenceError` — and `stepStaff` swallows a throw *per job* on purpose, so no
hire could put anything on a shelf and nothing said so. Three of nine jobs, dead
and silent. "Two hires are worth no more than none" was a report on that, not on
the wage.

**Second, and worse: the instrument is blind to staff by construction.** The
balance bot `teleport`s to whatever it wants to do and tills, sows, harvests,
orders wholesale, stocks and re-prices several times a second. It is an
omnipresent shopkeeper who already does every job perfectly. A hire cannot add
anything to that, so `simulate` will price staff at roughly zero however well
they work. Re-measured after the fix, 3 seeds, both wage levels:

| staff on the books | wage halved | wage as authored |
|---|---|---|
| nobody | 38,786 | 36,427 |
| two | 37,563 | 35,483 |
| five | 38,386 | 36,595 |
| eight | 38,493 | 35,188 |

Non-monotone in both columns, everything inside ±4%. That is not a shallow
curve, it is **no signal**. Fixing the workers did not change the answer, which
is how you can tell the problem is the instrument.

So the wages stay where they were authored, because nothing has earned the right
to move them. **To price staff at all, the bot has to stop doing everything** —
give `simulate` a mode where it only shopkeeps and the farm is staff-only, or
cap how often it acts. Until then this is a live-game judgement, not a
`simulate` one, and the honest thing is to leave the authored numbers alone.

What `simulate` *can* still measure is the wage as a pure cost, isolated by
setting every kind's `wage` to 0 and back — same content, same roster, same
minute, five seeds (taken before the `shelfFor` fix, so read it as the cost of
the outgoing, not as the value of the worker):

| seed | wage 0 | wage as authored | Δ |
|---|---|---|---|
| workers-step4 | 42,437.83 | 35,650.32 | −16.0% |
| wk-a | 41,004.01 | 38,084.56 | −7.1% |
| wk-b | 41,615.04 | 35,611.77 | −14.4% |
| wk-c | 42,332.73 | 34,895.76 | −17.6% |
| wk-d | 42,704.90 | 37,425.67 | −12.4% |
| **mean** | **42,018.90** | **36,333.62** | **−13.5%** |

All five moved the same way, none went bankrupt, no new dead stock, and
`startedWith` was `Clerk, Shop Hand` / 2 upgrades on all ten runs. The direct
cost is only $14/day × 120 = $1,680; the rest is compounding, because
`restock`'s budget is a fraction of cash and a smaller float buys smaller
orders. **A wage bites hardest when the shop is small**, which is the right way
round.

### Three things that came out of measuring, worth keeping

- **Toggle the mechanic, not the code.** Setting `wage` to 0 *is* the
  before-state, byte for byte, so both halves of the comparison run against the
  same content minutes apart. That matters more than it sounds: an earlier
  before/after pair taken twenty minutes apart drifted **1.5% on an unchanged
  seed** purely because the other agent was writing content between them. The
  sim is perfectly deterministic — the same seed against the same content and
  roster reproduced to the cent — but "the same content" is not something you
  get for free in a shared world.
- **`startedWith` reports names, not job lists.** Two runs can both say
  `Clerk, Shop Hand` and be measuring different shops, because a reassignment
  changes what those people do. That happened here — the clerk's list was edited
  from the other side mid-session and the numbers moved 12%. If `startedWith`
  ever grows a field, it should be a hash of the roster's jobs.
- **A wage sweep across multipliers is mostly noise.** 0 / 0.25 / 0.5 / 0.75 /
  1.0 on three seeds came out non-monotone — x0.75 measured *worse* than x1.0.
  The RNG-stream divergence CLAUDE.md warns about swamps a 5% effect at three
  seeds. The roster-size comparison above is trustworthy because the gaps are
  larger and every seed agrees; a fine-grained price sweep would need far more
  seeds than it is worth.

### Still open on wages

- **Whether they are priced right is unknown**, per the section above. The
  measurement needs a bot that doesn't do every job itself.
- **`wage_mult` is unmeasured too.** The bot never promotes anybody, so the 1.5×
  on every second rung is priced by argument — a rung that raises one stat by
  half should raise the wage by half — and not by `simulate`.
- **Nothing goes bankrupt.** Even eight workers never drove a run negative,
  because a shop short of cash simply stops restocking and shrinks. Wages built
  a ceiling, not a cliff. If a cliff is wanted it is a floor on restocking, not
  a bigger number.

## Step 8 — breaks, and being a person

**Built.** Prompted by a screenshot of two hires standing inside each other in a
corner, doing nothing, forever.

### What was actually broken, and is now fixed

`idle()` sent every worker whose heaviest job was `serve` to `checkouts[0]` —
*the* first till, not *a* till. Two clerks therefore walked to one tile and stood
on the same spot, while a second till went unmanned. Posts are now handed out by
roster order, one per till, and anyone past the last till stays where they
finished. New hires also fan out across the spawn tile instead of all landing on
one point.

Measured, 3 seeds, 120 days, modifiers cleared, roster pinned: 40,135 → 42,005,
41,592 → 40,947, 41,434 → 38,835. Mean −1.1%, one seed up and two down — noise,
which is the expected answer, because the second clerk standing at the till was
never doing anything. `abandoned` stayed 0 on every seed, which is the number
that would have moved if a till had been left unserved.

### The idea it exposed

An idle worker standing perfectly still is not a bug once they are spread out —
it is just *empty*. Real staff on a quiet shift do things, and none of those
things are work. That is a whole axis the game does not have: a worker is
currently a machine that costs money, and the only thing you decide about one is
which jobs it does.

### What it became

- **`pastimes`, a content table** — id, `name`, `doing`, `spot`, `seconds`,
  `restores`, `buys`, `weight`, `tags`. Validated by `PastimeSchema`, written
  through `POST /api/content/pastime` or the `create_pastime` MCP tool. Six are
  seeded: vape out back, sit on the step, snack break, make a brew, lean on the
  counter, stare at the field. A new one is one call and no code.
- **`rest` is not a job, and that is the load-bearing decision.** Every entry in
  `JOBS` is drawn by weight, which answers *how much of their day*. A break is a
  **threshold** — you go when you are spent, not 15% of the time. So it never
  went into the vocabulary at all: `onBreak` runs *before* `drawOrder` and
  short-circuits it. In the weighted list it would have sent a worker off for a
  coffee mid-queue at full energy, one trip in seven, forever.
- **Energy on the body.** `DRAIN` 0.035 per job taken, so about 28 jobs on a
  full tank; below `SPENT` 0.25 they down tools. `speedOf` and `paceOf` both
  divide/multiply by `tiredness()`, so an empty worker is 1.8× slower before
  they stop — the failure is visible well before it bites. Not persisted, so a
  server restart is a good night's sleep; a dev-world quirk, not a design.
- **`spot` names an anchor the layout already has** — `here`, `outside`, `bay`,
  `till`. Not a free position, because a break spot nobody can path to is a
  worker frozen mid-shift, which is the exact bug this section came out of.
- **A shop with no pastimes plays exactly as before.** `onBreak` finds nothing
  authored, refills the tank and returns false. The table being empty is not a
  worker standing still forever.

### The one genuinely new idea in it, and it works

**A worker on their break buys the snack off your own shelf.** `buys` is a list
of item tags; they take one matching item at the shelf price, and it lands in
`stats.revenue`/`sold`/`byItem` like any other sale. Live, first run:

```
Shop Hand bought a Coffee Beans on their break.
```

So part of the wage goes back over the counter, and stocking what your own staff
like is a small revenue line rather than a rounding error. It cost nothing new —
a hire is already an entry in `players`, and being briefly a customer is that
same trick one step along. Buying is the *reason* for a break, never a condition
of one: no stock, no snack, but they still get their five minutes.

### Measured

Live, watched through the running shop: energy drained 0.51 → 0.23 across five
jobs, the worker stopped at `job: break`, walked to the spot, sat, and came back
at 0.69. Two hires drew different pastimes (`brew`, `snack-break`), and the
roster line read `leaning on the counter` — the authored string, straight
through.

`npm run verify` green (285 assertions). `simulate`, 3 seeds × 120 days,
modifiers cleared: 41,041 / 40,256 / 40,498, nothing abandoned, no dead stock,
never bankrupt. That is a "did this break the economy" check and nothing more —
per the wage section, the bot does every job itself, so it cannot price staff
downtime either. **Whether breaks are costed right is still an open question
that needs a hobbled bot to answer.**

## Step 8b — what a break looks like

**Built.** A break used to be invisible: a hire walked to the spot and stood
there in the pose they work in, and the only thing in the game that said
otherwise was a line in their own menu. A worker who stops working for reasons
the player cannot see is the same bug step 8 started from, one level up.

### A pastime carries a model

`PastimeSchema` grew `model`, the `pastimes` table grew a `model` column, and
`create_pastime` grew the field. Same authoring shape as everything else, and
nullable on purpose — a pastime with no prop is still legible (see the slump
below), so a shop whose breaks nobody has drawn yet is not a shop of statues.

**The 0..1 that flips its stages is how far through the break they are.** That
is the whole point and it cost one line in `snapshot()`. A crop feeds `partsAt`
its growth and a fixture feeds it its tier; a pastime is the first thing in the
game to feed it *time*, and got a flipbook for it with no new authoring shape
and no code that knows what a mug is:

| Pastime | The arc, authored |
|---|---|
| `brew` | full mug, steaming → half gone, one wisp → drained, no steam |
| `snack-break` | whole sandwich → half → crusts |
| `vape-out-back` | first drag → a puff → three clouds → wisps |
| `sit-on-the-step` | folded paper → opened → back down to the crossword |
| `lean-on-the-counter` | dim screen → scrolling → still scrolling, brighter |
| `stare-at-the-field` | one thought over their head → two → three |

`breakProgress` is sent rather than worked out client-side, because the client
can see the break but not the clock the deadline was set against. `onBreak` now
records `breakFrom` as well as `breakUntil` — you cannot recover "how far
through" from a deadline alone.

### Authored where it can be, code where it can't

The split, and the reason there are exactly three moving parts:

- **Stages** are the arc, and they are content. They play once across the break.
- **`drift`** is a new flag on a model part, alongside `surface` and `alpha`:
  the part leaves them, rises off where it was drawn, spreads, fades and starts
  again. This is the one thing stages genuinely cannot say, because a stage arc
  plays once in twenty seconds and smoke has to keep going. Vapour, steam, the
  light off a phone screen. Only the pastime renderer reads it, exactly as only
  shelves read `surface`.
- **The slump** is code, needs no authoring, and is the half that actually reads
  from across the shop. At the default zoom a mug is a few pixels; a silhouette
  that has stopped standing to attention is obvious out of the corner of your
  eye. So the body settles, tips onto one hip and breathes, eased in and out
  over about a second so going on a break and coming back off one are both a
  movement rather than a jump cut.

### `client/render/pastime.js`

New file, and `scene.js` gains only two hooks: `syncPastime` next to
`syncBubble`/`syncCarry`, and one line in `render()`.

- **The prop is a child of the body**, like the bubble and the carry, so it
  follows them to the spot and leaves with them when their kind is redrawn.
- **The rebuild key is the stage index, never the raw progress.** `breakProgress`
  moves every snapshot; a key that moved with it would tear geometry down and
  build it again ten times a second for a fraction of a mug.
- **Everything continuous lives in `render()`**, for the reason the `liftedRing`
  comment already gives: state arrives at 10Hz and the page draws at 60, so
  motion driven by the snapshot reads as a rendering fault. A worker who is
  working costs one compare and a return.
- **Two bugs worth keeping.** A puff swells as it climbs, and scaling a group
  scales its children's offsets too — so a cloud authored out at the mouth sailed
  off sideways as it grew. Drifting parts are now built at the origin and
  *moved* to where they were authored. And a puff's opacity is rewritten every
  frame while `material()` hands out one shared material per colour, so tinting
  it would have faded every prop in the shop that happened to share it: the fade
  is quantised to ten steps and goes back through the same cache, which is the
  trick `setGrowthBar` already uses to swap between two.

### Measured — and the recipe in CLAUDE.md was not enough

This is a rendering change, so the only acceptable result was *no movement at
all*. Same seed, `clear_modifiers`, before and after gave a 1–6% spread across
three seeds, which would have meant something had leaked into the sim.

It hadn't. **A no-op restart moved it just as much.** Appending a comment to
`staff.js` and changing nothing else measured 41,523 / 43,464 / 41,566 against
42,873 / 41,927 / 41,433 — up on one seed, down on two, and `startedWith` was
identical (`Clerk, Shop Hand, Chef`, 6 upgrades) every time. `simulate` builds
its throwaway game from the *saved* world, and in a shop the other person is
playing, that world moves between restarts in ways the roster names cannot see.

The fix is to take the world out of the comparison. `DB_PATH` already honours
`SNS_DB`, so copy `data/game.db` once and drive `simulate` in-process against
the copy — no server, no restart, no other player. Both halves then run against
one frozen world and the only thing that can differ is the code:

| seed | change out | change in | Δ |
|---|---|---|---|
| pp-a | 41,522.60 | 41,522.60 | — |
| pp-b | 43,463.68 | 43,463.68 | — |
| pp-c | 41,566.36 | 41,566.36 | — |

Identical to the cent, and so were `sold`, `spoiled` and `leftEmpty` on all
three. Which is what the code says too: `simulate` never calls `snapshot()`, and
nothing in `server/` reads `breakFrom` except `breakProgress`, which only
`snapshot()` calls.

`npm run verify` green (64,202 layout assertions over 24 seeds, 285 build
assertions).

### Seen, not assumed

Driven through a real headless page against the live server, because the server
has no renderer and the MCP `screenshot` tool renders whatever the human's tab
is pointed at — which is their own player, not a hire round the back.

- **Live**: two hires on real breaks at the delivery bay, both leaning, one with
  a steaming mug and one with a vape pen and a cloud over their head.
- **All six side by side**, each at a different point through its break, drawn
  through the real `syncActors` → `syncPastime` → `buildPastimeProp` path with a
  substituted player list.
- **The arc**: `snack-break` and `brew` at 0.05 / 0.5 / 0.95, showing the
  sandwich eaten down to a nub and the steam giving out.
- **Resting against working**, alternating, at 2.6× — the tilt is unmistakable
  even before you look at what they are holding.

Still legible at the default zoom, which was the bar: every one of the six reads
as *somebody who has stopped*, and five of the six say what they stopped to do.

### A break waits until their hands are free

Drawing the props is what exposed the bug they were drawing. A hire would pick a
crate up at the bay, walk it out to the back step, eat a sandwich over it for
twenty seconds and then walk it back — which reads as a worker who forgot what
they were doing rather than one taking five. `onBreak` pre-empted the job draw
unconditionally, so nothing ever asked whether they were mid-errand.

**A full pair of hands now defers the break, and the job list is asked first.**
`shelve`, `craft` or `tidy` finishes the errand within a job or two, and the
break happens on the next tick with empty hands.

The interesting half is the guard, because *"finish first" must never become
"never rest"*. Energy only drains when a job is taken, so a hire who cannot put
something down would sit one tick under the threshold forever, pinned at
`TIRED_PACE` — a worse bug than the one being fixed, and exactly the frozen-hire
failure this whole step came out of. So the break is asked for **twice** a tick:
once before the draw, which defers on a full carry, and once after the whole
list has declined, which does not. Nothing left to finish, so they take it
holding the goods — precisely what every break did before.

That needs no timer and no new state, and it degrades to the old behaviour only
in the case where the old behaviour was the only option left.

Proved by driving a real ephemeral `Game`: a tired hire holding three loaves
shelves them and *then* rests (hands empty at 12.3s, break at 13.2s); a hire
given only `serve` and handed an item no shelf will take still gets their break.
With the rule removed the same test fails on the first case — pastime
`snack-break`, `job: break`, still holding `3× bread`, which is the reported bug
reproduced exactly.

**Measured**, 5 seeds × 120 days, one frozen world, both halves minutes apart:

| seed | break mid-errand | finish first | Δ |
|---|---|---|---|
| fin-a | 40,427.56 | 42,413.76 | +4.9% |
| fin-b | 42,124.71 | 42,093.04 | −0.1% |
| fin-c | 43,985.18 | 42,274.01 | −3.9% |
| fin-d | 43,786.98 | 42,561.21 | −2.8% |
| fin-e | 42,737.20 | 44,304.94 | +3.7% |
| **mean** | **42,612.33** | **42,729.39** | **+0.27%** |

Two seeds up, three down, mean within a third of a percent — noise, which is the
right answer. Reordering a break by a job or two should cost nothing, and the
spread is the RNG-stream divergence CLAUDE.md warns about rather than a signal.
Nothing went bankrupt, no new dead stock, `spoiled` and `leftEmpty` both inside
their usual band. `npm run verify` green.

### Left for later

- **Laziness as a tag.** `choosePastime` already filters by the worker kind's
  tags, so `outdoor` workers get `stare-at-the-field`. Draining *faster* by tag
  is step 7's machinery and one multiplier in `spend()`.
- **A break spot as a fixture.** A bench, a vending machine, a back step —
  rules in `shared/build.js`, looks in `fixtures`. That is what would turn the
  constraint into something you build in response to. `spot` is deliberately a
  small closed vocabulary so adding `fixture:bench` later is additive.
- **The prop does not sit down.** `sit-on-the-step` slumps like everything else
  rather than actually sitting, because the pose is one rotation applied to a
  whole authored body. A second pose — or a `posture` on the pastime, the same
  shape `spot` has — is the obvious next thing, and it is additive.
- **A snack they bought is not the snack they eat.** `buys` takes a real item
  off a real shelf and pays for it; the prop is whatever the pastime authored.
  Drawing the bought item instead is a nice touch and a genuinely different
  feature, because it means the prop is not always known at build time.

### Watch out for

- **This is the first mechanic that can make a worker *refuse* to work.** Every
  balance number in the project is measured through staff, so it moves all of
  them. Price energy against a staff-free shop the way the wage was, not against
  before-and-after.
- **The balance bot must model taking a break, or the instrument lies.** The
  auto-replant story in CLAUDE.md is exactly this failure: the tool said the
  feature was −39%, and the tool was wrong. If `simulate`'s bot never rests, it
  will report resting as pure cost.
- **A break has to be legible.** A worker who stops working for reasons the
  player cannot see reads as the same bug this section started with. Their menu
  says what they are doing; it needs to say *why* they are not.

## Once a worker is data-driven

These are cheap *because* of the split above, and expensive without it.

**Tags.** Workers carry `tags` the way items do — `fast`, `clumsy`, `green`. The
world-event machinery already moves multipliers by tag, so "flu season: staff
pace ×0.8" becomes an authored event and no code. This is the same trick that
makes a brand-new item sell itself: the behaviour hangs off the tag, never off
the id.

**Zones.** A hire can be pinned to part of the world — the field, one aisle, the
back — instead of the whole shop. It is the fix for a worker wandering past
three empty shelves to reach the one they picked. A zone is a rectangle in
runtime state and one filter in each job's target search.

**Experience.** Tiers climb by doing the work as well as by paying for it: a
worker who has served two hundred customers gets there on merit. The ladder
already exists from step 5, so this is a counter and a threshold, not a system.
Watch that it doesn't make firing a promoted worker unthinkable.

**`guard`.** There is no combat yet, so there is nothing for this job to do —
but it is the reason the vocabulary is a list and not four functions. When
fighting lands, a guard is one more entry in the table above and one more job
function, and every worker in the shop can already be given some of it. Nothing
about hiring, tiers, models, wages or zones needs to know it arrived.

## Order of work

Each step leaves the game playable.

1. ✅ **`workers` table + schema + `create_worker` MCP tool.**
2. ✅ **Generic stepper.** The four steppers replaced by one weighted job list.
3. ✅ **Runtime roster.** `game.roster`, hire/fire, migrated off the upgrades.
4. ✅ **Assignment UI** — the per-worker menu, `client/worker-menu.js`.
5. ✅ **Tiers and models** — promote, restage, stats off the ladder.
6. ✅ **Wages**, priced against a staff-free shop rather than against taste.
7. **Tags, zones, experience** — each independent of the others.
8. ✅ **Breaks and being a person** — energy, the `pastimes` table, staff as
   customers of their own shop, and (8b) a staged prop driven by how far
   through the break they are.

Steps 1 and 2 are the ones that matter; everything after is only worth doing
once a worker is genuinely data-driven. `guard` is deliberately not on this
list: it lands with combat, and the point is that it will not need a step.

### What 4–6 touched

| File | Why |
|---|---|
| `client/worker-menu.js` | new — the whole per-hire menu |
| `client/sections.js` | Staff reads the roster and `catalog.workers`, rows open a menu |
| `client/fixture-menu.js` | `act` exported; the refresh branch became a `panelTick` |
| `client/ui.js` | one `panelTick?.()` in place of the fixture branch (net −6 lines) |
| `client/index.html` | four lines of CSS for the weight dial |
| `client/render/scene.js` | `buildActor`, `actorKey`, `syncActors` rebuild key |
| `server/sim/index.js` | `promote`, `payWages`, `hire`/`tier` in the snapshot |
| `server/sim/staff.js` | `syncStaff` keeps an existing body in step with its row |
| `server/rooms/MartRoom.js` | `promote` message, `jobs` in the catalog |
| `shared/schemas.js` | `wage_mult` on a worker tier |
| the database | `wage_mult` 1.5 on every second rung |

### What 8 touched

| File | Why |
|---|---|
| `shared/schemas.js` | `PastimeSchema`, `PASTIME_SPOTS` |
| `server/db.js` | the `pastimes` table |
| `server/content.js`, `server/api.js` | registry + `/content/pastime` |
| `mcp/server.js` | `create_pastime`, and `pastime` in list/delete |
| `server/sim/staff.js` | energy, `onBreak`, `choosePastime`, `buySnack` |
| `server/sim/index.js` | `energy` and `pastime` in the snapshot |
| `server/rooms/MartRoom.js` | `pastimes` in the catalog |
| `client/worker-menu.js` | the energy bar, and the break line in `doingNow` |
| `client/index.html` | the energy bar's four lines of CSS |
| `scripts/seed.js`, `scripts/export-content.js` | `pastimes.json` |

### What 8b touched

| File | Why |
|---|---|
| `shared/schemas.js` | `model` on `PastimeSchema`, `drift` on a model part |
| `server/db.js` | the `pastimes.model` column, and a late-add so a live world gets it |
| `mcp/server.js` | `model` on `create_pastime`, and what stages mean for a break |
| `server/sim/staff.js` | `breakFrom`, `breakProgress()`, and the carry deferral + `tryBreak` |
| `server/sim/index.js` | `breakProgress` in the snapshot |
| `client/render/pastime.js` | new — the prop, the puffs and the slump |
| `client/render/scene.js` | `pastimes` in the catalog, `syncPastime`, one line in `render()` |
| the database | a staged model on all six seeded pastimes |

`npm run verify` is green (64,202 layout assertions over 24 seeds, 261 build
assertions). Hire, assign, promote and let-go were each driven through a real
browser page and checked against the snapshot, not just looked at.

## Watch out for

- **`simulate` drives the economy through staff.** Any change here moves the
  balance numbers. Same seed, `clear_modifiers`, before and after — the
  duplicate-modifier trap in CLAUDE.md will otherwise swamp the comparison.
- **Staff are entries in `players`.** That is deliberate — a hire obeys exactly
  the rules a human does, and gets rendering and pathing for free. Do not give
  workers their own entity type.
- **A stuck job must not stall the tick.** `stepStaff` swallows throws per
  worker on purpose. The generic stepper must keep doing that, per *job*, or one
  bad authored job list freezes every hire in the shop.
- **…and that catch will hide a missing function for as long as you let it.**
  This is the one that cost the most here. `shelfFor` and `pickItem` were lost
  in the step 1–3 port; `restock`, `unload` and `shelve` threw `ReferenceError`
  on every tick for days, the catch ate all of it, and the only symptom was
  hires standing about while the shelves stayed bare. It looked like a design
  problem — "staff don't restock" — and it was a deleted function.
  **`catch {}` is right for one bad authored job list and wrong for a bug in
  ours**; if that catch ever logs once per job per session, this class of fault
  becomes a one-line diagnosis instead of a week.
- **`simulate` cannot tell you what a worker is worth.** Its bot teleports and
  does every job several times a second, so hires add nothing to it and score
  ~0 no matter how well they work. Any question of the form "is this staff
  change good" needs the live game or a hobbled bot — see the wage section.
- **A job list with nothing available must idle cheaply.** Four workers each
  scanning every shelf every tick is the shape of a frame-rate problem; keep the
  cooldown on a failed scan.
- **Anything that defers a break needs a way for the deferral to end.** Energy
  only drains when a job is *taken*, so a hire who is blocked stops draining and
  sits one tick under the threshold indefinitely — resting never comes due, and
  they stay pinned at `TIRED_PACE`. "Finish what you are holding first" is right;
  "finish what you are holding first, forever" is a frozen worker. The carry
  deferral asks for the break a second time after the whole job list has
  declined, which is the case where there is nothing left to finish.
- **A roster entry is not a body.** `game.roster` is the ledger; the entry in
  `players` is only its shadow, and the two go out of step the moment something
  is set at spawn and never again. That is what made the first `promote` look
  like it did nothing. Anything a rung decides — stats, art, wage — has to be
  read off the row every tick, never copied at hire time.
- **The menu takes a roster *id*, not a roster record.** The whole roster is
  re-sent in every snapshot, so a menu holding the record it opened with shows a
  job list that stopped updating the moment the other player changed it.
- **Don't measure across a gap.** In a world a second agent is writing to, the
  content underneath a before/after pair can change without either run saying
  so. Toggle the mechanic itself (`wage` to 0 and back) so both halves run
  minutes apart against one snapshot — see the wage section for the 1.5% drift
  that made the point.
- **Fixing the wage is not the same as fixing the decision.** Wages priced so
  that two hires beat none, and eight hires lose to two, took a comparison
  against a *staff-free* shop. Comparing profit before and against after only
  ever tells you the wage costs money, which was never in doubt.
