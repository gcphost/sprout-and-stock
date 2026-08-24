# Workers — design

Status: **steps 1–6 and 8–13 built.** A worker is authored content, hiring is a
roster, every hire has its own menu, tiers restage the model, everybody gets
paid, a worn-out hire downs tools and does something authored about it —
visibly — there is a room you paint for them to do it in, and a rung can be
authored to pack one full crate out of a bay of part ones, and another to
rearrange the shop around where customers actually walk. Step 7 (tags, zones,
experience) is proposed; step 10 (the shop hand) is built and opt-in.

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
| — | *the three above are one `farm` directive since step 11* | |
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
   so an idle till still sends them to the crops rather than standing there —
   but no further down than half the drawn job's weight (`FALLTHROUGH`).

That floor arrived late, and without it the fall-through quietly ate step 1.
Only the *head* of the order is drawn by weight; everything under it was reached
by simply having work, so a job that always has something to do — restock,
shelve, tidy — collected every draw the heavier jobs declined. A farmhand told
`till` 10 and `tidy` 1 spent the day tidying between beds, which reads as a hire
ignoring the one instruction you gave them. Being pulled *up* the list is
untouched: draw a 1, find it empty, and everything above is still open. So the
floor only ever costs a light job the work a heavy one turned down, which is
what a light weight was asking for. A flat list of tens is unchanged and is
still the strongest setting in the menu — everything drawn evenly, everything a
fallback, one hire doing four jobs and never standing still.

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

### ...and a hire moves while they are working

A `motion` part turns, bobs, judders or pulses while the thing it belongs to is
busy, and it had been collected onto a worker's group since the day workers
stopped being coloured capsules — `buildActor` is a `buildModel` like any other,
and `buildModel` fills `userData.moving` for anything it draws. Nothing ever
animated it. `animateStations` walks `movingFixtures` and the station work-props
and nothing else, so the flag was authorable, validated, saved, rendered *and
dead* on every hire in the game: the exact shape of a field that reads as content
and does nothing, which is the trap this doc's own tier ladder is written around.

So the loop that eases a body into its break animates its moving parts too, and
the whole change is one call. Three things it borrows from the fixture half, each
of them the reason not to write this from scratch a second time:

- **What counts as working is `job`,** which is already on the wire for the
  roster. Walking to the mess counts, because that is the job — `tidy` sets it
  and returns true for the whole errand. A break does not, and that is the one
  case the renderer has to spell out: `stepStaff` writes `job = 'break'` for a
  charge rather than clearing it (or the readout would flicker for the whole
  charge), so a bot sat in the corner with a mug would otherwise be sweeping.
- **The phase is the per-person hash their breathing already uses,** not a second
  one. Two janitors in an aisle must not sweep in unison, and there should be one
  answer to "which of you is this".
- **A pause is a SKIP, not a `false`.** False eases the brush down over half a
  second, which is a machine being switched off, and time stopping is not that.
  A paused shop with a brush still turning in it is a pause button that does not
  look like it worked.

The Janitor is what it was built for, and it is also where the documented trap
bit: a **spinning cylinder is invisible**, because it is rotationally symmetric.
The brush is two crossed bars for exactly the reason the blender turns a paddle.

### Chores — the charge's opposite number

A hire with nothing to do stood *perfectly still* wherever they finished, which
reads as the game having crashed rather than as the shop being quiet. The idle
charge fixed that for hires who were promoted, worn out, and had a room to walk
to — on a quiet afternoon, none of them.

A chore is a pastime with `spot: 'roam'`: they walk to a tile of the shop floor,
do it there for a few seconds, and go somewhere else. Every gate `tryCharge`
holds, `tryChore` drops — any rung, any tank, no seat, three seconds instead of
fifteen. What it keeps is empty hands, and `idleCharge`, which is the whole of
what makes it safe: the tick is handed back, the job draw runs underneath it, and
the first real job in the shop ends it.

Four things are worth knowing before touching it.

**Two clocks, not one.** `choreFrom` is separate from `idleFrom`, and that is not
tidiness — a chore that reset the boredom clock would mean nobody ever reaches
`BORED_SECONDS` again and the idle charge silently stops existing. Nothing would
say a word, because a bot pottering about all afternoon looks *more* alive than
one that charges.

**Hashed, never drawn.** Which chore and which tile both come off `hash01`
(`shared/hash.js`, moved out of `sim/index.js` for this). This is asked of every
spare hire on every quiet tick, so an `rng.next()` here would not shift the
measured stream, it would shred it — two `simulate` runs of one seed would stop
matching the moment a shop had somebody standing about. The key is `choreFrom`,
which is also what makes them *arrive*: `onBreak` asks for the spot again every
tick of the walk, so a key that moved with the clock would hand them a new
destination each tick and they would drift about getting nowhere.

**A chore is not sent to the break area.** `spotFor`'s override is about where a
*rest* happens; a bot sweeping the staff room is a bot not sweeping the shop.

**It must not slump.** `syncPastime` holds the posture back for a chore. The
prop still hangs and its stages still turn — only the sag is suppressed, because
a bot sagging at the shoulders while crossing the floor reads as broken twice.

Only the Janitor has one today (the pastime is tagged `cleaning`). Every other
kind gets `choosePastime` answering null and stands still exactly as before,
which is what makes this opt-in per kind: a clerk wiping the counter is one row
in the database, not a code change.

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
- `demote(id)` — the same number back down, for **half** of the rung they are
  stepping off (`FIXTURE_REFUND`, the one sell-back rate the shop has). Not the
  mirror of `fire` above, and the difference is what a grade *is*: `wage_mult`
  charges for it again every morning, so a promotion taken in a good season is
  an ongoing bet rather than a purchase, and until this existed the only way out
  of it was letting the person go. Half back, so promoting and demoting in a
  circle always costs money — what is being sold back is a rung, which the shop
  can still see, rather than a person, which it cannot.

The existing `staff-*` upgrades get migrated to `workers` rows on seed, and the
upgrades themselves retired — leaving them would mean two ways to hire.

## The UI — `client/worker-menu.js`

Staff is **a bar, not a panel** — `STAFF_BAR` in `client/sections.js`, the same
shape Upgrades is — and **the entry is the way in**: pressing a name opens that
person, exactly as tapping a shelf opens that shelf. Two stockers are two
entries, and which one you pressed is the only thing that can tell them apart —
which is the whole reason a hire is a roster row.

Its tabs are the roster (`staffGroups`), and the last of them is **Hire**:
`catalog.workers`, not the staff upgrades, so a kind authored over MCP is
hireable with no client change, and hiring the same kind twice is a second
person rather than a refusal. A kind wears its price as its note and how many of
them already work here as its badge, which is what the build palette does with a
shelf. **Pressing one hires**, with nothing in between — the tile carries the
name, the price and the count, and there is no third screen to say them again.

That was a panel, titled "Who works here" and listing everyone who does *not*
work here, opened by a Hire entry pinned to the end of every roster tab. With
nobody hired yet the whole strip was that one button, and the rail icon, the
button, the panel and the bar's own hint line were four things on screen saying
you could take somebody on. The bar holds the list; the panel is gone.

The first pass at this replaced the panel with a per-kind menu — cost, wage,
job list, a Hire button — reasoning from `showUpgrade` that an unrefundable
purchase deserves ceremony. It is written down because it was wrong twice over:
a hire is $220 against an upgrade's $20,000, and more to the point it was a
second popover in place of the popover being removed. The ceremony rule is about
the *size* of what a press commits you to, not about it being irreversible.

Two things fell out of retiring the section, both older than this change and
both invisible. The keys list in Help was generated from `SECTIONS`, so a menu
that is a bar has never appeared in it — Staff would simply have dropped off,
and Upgrades was already missing; it reads `RAIL_ITEMS` now, which is what
`main.js` actually binds. And **which tab a browse bar has open was two fields**:
`renderBrowseBar` drew `barTab[bar]` while Tab moved `ui.staffGroup`, so Tab read
as a dead key on the roster and the number keys picked out of whichever tab
happened to be first. `ui.browseGroups()` is the one answer now, and Upgrades —
which had no branch at all, and so cycled the *build* tabs from a bar with none
of them on it — goes through the same door.

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

### The head is a profile, and the avatar is the paint control

The menu opened with five label-and-value lines pinned above a job list you
scrolled: Doing, Charge, Model, Firmware, Lease. That is a spec sheet for a thing
you never actually see. A bot spends the entire game two tiles away with its back
to you, and this menu is the one place it can be stood up and turned round — so
the head is now **the machine on the left and the readings on the right**, and
the readings are in **two columns** rather than five rows.

`spinForWorker` (`client/thumb.js`) is the avatar. The projector was already a
pure function of an angle, so twenty-four calls to it at 15° apart is a whole
turntable with no canvas, no context and nothing to tick — the stills go in one
long strip and `.wk-turn` slides it with `steps(var(--n))`, which by
construction stops one frame short of `-100%` and lands back on frame zero.
Three things about it are not obvious:

- **One view box for every frame.** Fitted per still, the box is fitted to how
  wide the bot happens to be from *that* side, so a machine deeper than it is
  broad swells and shrinks as it turns and the ground slides about under it.
  Invisible in any one frame, which is why `spin()` exists and `draw()` is one
  call to it.
- **The shadow is taken at rest and never turned.** It is what the thing stands
  ON; a footprint that swung round with the body is the floor moving under a bot
  standing still.
- **The phase is a negative `animation-delay` off the page clock.** The panel
  redraws whenever anything in its signature moves — and the foot prices against
  cash, so on a busy afternoon that is several times a second. A fresh element
  starts its animation at frame zero, so without this the bot snaps back to
  facing you every time somebody pays, which reads as the shop being what
  stopped it.

**The Look tab is gone, and the avatar took its job.** A tap on it repaints them
(round the list, so the tap alone gets back out of a paint), and a hold opens the
rack — the palette tile's sentence, over the palette tile's `HOLD_MS`, which is
exported from `bar.js` now rather than spelled twice. The chevron is that door
with a handle on it, for the reason it grew on the bar: a look is cosmetic enough
that a gesture nobody finds would simply read as the game not having any.

Two things followed from moving it. The card's rows are `.shape` — the build
bar's shape card, because it is the same question with the same shape of answer —
and the picture on each row is **the bot in that paint** rather than the three
colour bars it used to be. Those bars were the honest picture while this was a
tab of names; hanging off an avatar of the machine, paint chips would be
answering in a different language from the question. And with no second list to
tab to, the menu has no tabs, which is where the **two-column directive grid**
got its room: nine short rows in one column was a scroll for no reason, and the
whole shift now sits on screen at once.

Both grids are `repeat(auto-fit, minmax(…, 1fr))` rather than a flat `1fr 1fr`.
The panel is `min(430px, 100vw - 24px)`, so on a phone the same markup is one
column instead of two squeezed to a stepper and an ellipsis.

### A day is a budget — `shared/jobs.js`

A weight has always been *relative*: `stepStaff` draws from the list in
proportion, so `serve 10, tidy 1` and `serve 100, tidy 10` are the same worker
and the absolute size of the numbers meant nothing. Which is exactly why nothing
stopped you setting every directive to ten — it read as "do everything, hard"
and it cost the same as doing one thing. A roster of generalists is a shop with
no decision in it: two of somebody is only interesting while they can be told
*different* things, and specialising has to cost you what you gave up.

So the total is capped, and **the ladder is what buys more of it** — the second
thing a rung sells that is not a multiplier (`unattended` on a till was the
first), and the one you can actually see: a promotion is more of their day.

```
budget = max(JOB_POINTS, what the KIND was authored with) + JOB_POINTS_PER_RUNG × (rung − 1)
       =        20                                        +        8
```

Three things about it are not obvious, and each is a way the naive version
breaks:

- **The authored total is a FLOOR, not the rule.** Authored lists run from 11
  (clerk) to 33 (farmhand), because until this file existed those numbers were
  ratios and nobody was choosing a total. Any flat cap below the biggest of them
  hands you a farmhand who is over budget on the day you hire them, whose first
  available move is to take something away — which reads as the hire being
  broken rather than as a rule being applied. As a floor, every authored kind
  arrives exactly as authored and the cap only ever hands a generalist a spare
  point or two. It also leaves the lever where content already is: a kind
  authored heavy is a kind that does more, at whatever wage it was authored
  with, and `simulate` is what says whether that was a good idea.
- **Over budget is a state you can be IN, never one you can move further into**
  (`jobsAffordable` takes what they are already carrying). That is what makes a
  rollback safe: `demote` drops the allowance and deliberately does not touch the
  list, so somebody promoted and rolled back is overloaded until you trim them,
  rather than having their shift silently rewritten by the server — the one
  outcome nobody would connect to the button they pressed. The counter turns
  `--accent` and every `+` in the list is dead until it clears.
- **It is `shared/`, for the `shared/build.js` reason.** The menu greys the `+`
  and `assignJobs` refuses the list; two implementations of one budget is the
  green-ghost bug wearing a stepper — a button offering a weight the shop hands
  straight back.

The counter lives in the list's heading rather than on any row, because there is
one pot and nine rows drawing on it. It is also what let the standing paragraph
under the list go: three lines explaining that a weight is a share of a day is a
thing you read once and scroll past for the rest of the game, and a number
running out under your thumb teaches the same rule where you are pressing.

### A promoted unit charges itself — `tryCharge`

A hire with nothing to do stood in an aisle waiting to be asked. That is not
wrong so much as *wasteful*: they will be tired later, the break area is right
there, and the shop is quiet now rather than in the middle of the lunch rush.
So anything above the bottom rung takes itself off to charge after
`BORED_SECONDS` (15) of nothing — the second thing a rung sells that is not a
multiplier, and unlike the first one you can watch it happen.

The gate is **"any rung above the first"**, not a hardcoded 2: a kind with one
rung never does it and a kind with five does it from its second. What is being
sold is judgement — a Casual waits to be told, a Trusted works out that now is
the moment — which is why it is a rung and not a stat.

Four conditions, each doing work:

| | why |
|---|---|
| a **seat**, via `seatIn` and never `spotFor` | a shop that never painted a break area plays exactly as it did. The authored spot is where a *tired* hire rests when there is nowhere to go; a bored one leaning on a shelf mid-floor is a picture of a robot loitering |
| **empty hands** | the same reason `onBreak` defers a break: a charge with a crate in your arms is a hire who forgot the errand |
| **not full** | a full tank gains nothing, so the walk buys dead time |
| **not already charging** | `stepStaff` reaches `tryCharge` on every declined tick *including* the ones inside a charge, so without it a bored hire restarts one every 0.4s |

**The one that matters is that it does NOT outrank the job list.** That
inversion is the whole difference between a charge and a break, and it is the
only reason this is safe to ship: a break holds the tick by design, so if a
charge did too, promoting your clerk would buy you a till nobody is on for
twenty seconds at a stretch — and the tell would be a shop that got *slower*
when you spent money on it. `onBreak` hands the tick back while `idleCharge` is
set (keeping its cooldown, so the draw runs at the same rate an idle hire's
does), `stepStaff` calls `endCharge` on whatever the draw takes, and the credit
is **pro-rata**: crediting nothing would make one delivery arriving strictly
worse than none, and crediting the lot would make being interrupted the best
thing that can happen to a hire.

Three smaller traps, all of them found by writing it:

- **The boredom clock is not cleared on the way in.** The room may be across the
  shop, so `tryCharge` returns true for every tick of the walk and is asked
  again on arrival. Cleared early, they turn up at the seat no longer bored,
  stand there, and charge fifteen seconds later — in the break room, which is
  the one place it would look like nothing was wrong. `onBreak` clears it when
  the charge actually starts.
- **`idleCharge` is set inside `onBreak`, not by the caller.** Set after the
  walk, it would be written on the tick they *sit down* — leaving the tick in
  between as a charge that outranks the job list.
- **`idle()` had to learn not to move them.** It walks an idle clerk to a till;
  reached on every declined tick of a charge, it walks them straight back out of
  the room and charges them standing at the counter — the feature undone one
  line below where it was done.

`simulate` is blind to all of it and that is not a shortcoming: the balance bot
never promotes anybody, so every hire in a balance run is on rung 1, `tryCharge`
returns false before it draws anything, and the rng stream is untouched. Two
runs of a seed either side of this are identical.

`verify:break` §7 is where the claims live, because every one of them is
invisible: a bot in the break room because it is worn out and one because there
is nothing on are the same still frame. Its centrepiece asserts the interruption
against the hire's **own deadline** rather than against a stopwatch — timed, it
passes on a charge that simply ran out, which is the exact bug being guarded.

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

### Following one, and being able to hit them

Two things about pointing at a person, both of which the shop floor had wrong.

**A hire can be selected, so hovering one has to say so.** Everything else you
can press lights up — a shelf, a crate, the ground — and a hire, who is a third
of a tile wide and *walking*, was the one target that gave you nothing back.
`setPersonAim` is its own marker rather than a mode on `setAimTarget` for one
reason: everything that one rings stands still, so it is placed once at a tile.
This holds a roster id and re-places itself every frame off the body's own
interpolated position — a marker left where they were standing when you hovered
is worse than none, because it points at a tap that will miss. It rings hires
only. A customer has no menu, and a marker is a promise that a press does
something.

**The camera can ride on one.** `ui.follow` is a roster id and `scene.watch` is
what reads it — the same split `setFixtureRef` uses, so the button and the view
cannot disagree. It is never sent and never saved: where somebody's camera
points is not part of the shop.

What ends it is the interesting half, and it is the same rule the pan already
obeys — *going somewhere reclaims the view* (`walkTo`, `recentre`). So it ends
on the button, on a walk order, on a movement key, on entering build mode (which
flies the view from what it is following, two hands on one camera), and on any
press on the world that is **not** a person. That last one is why the clear sits
directly under the `pickPerson` branch in the tap handler: tapping the hire you
are watching, to read what they are up to, is the one press that obviously meant
to keep watching.

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
- **Energy on the body.** `DRAIN` 0.015 per job taken, so about 50 jobs on a
  full tank; below `SPENT` 0.25 they down tools. The full tank is a one-off,
  though: a break restores what the *pastime* is worth rather than filling
  anybody up, so the steady state is `restores / DRAIN` jobs and `SPENT` only
  ever decides when the first one comes. At `DRAIN` 0.035 that made
  `lean-on-the-counter` (restores 0.35) a break every ten actions.
  `speedOf` and `paceOf` both
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
- ~~**A break spot as a fixture.**~~ Built as step 9 below, and as *ground*
  rather than as a fixture — see there for why a bench was the wrong shape.
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

## Step 9 — a break area you paint

**Built.** Step 8 left "a break spot as a fixture" on the list: a bench, a
vending machine, a back step, with rules in `shared/build.js` and looks in
`fixtures`. It is built, and it is not a fixture. It is a **kind of ground**,
laid with the brush that lays floor and the two yard pads —
`GROUND.break` → `T.BREAK`, `L.break`, one row in the catalog.

### Why ground, and not the bench the last step imagined

A bench is one worker and a facing. So a shop with four hires needs four
benches, something has to know which of them is free, and the answer to "where
do my staff rest" becomes an inventory. An **area** answers it in one gesture:
you drag out however much of the shop you are willing to give them, and
**one cell seats one person**. No anchor, no rotation, no facing, nothing
standing in the cell — and the size of it is a decision rather than a count of
furniture. That is the same claim the yard already makes about crates, so it
arrived with a brush, a validator, an overlay and a renderer already written.

It is the third `pad` — the first that holds people rather than goods, which is
what `does` on the GROUND row is for. `document-fixtures` used to describe a pad
with a ternary over two kinds, which reads as correct right up until a third one
is described as the second.

### The break area outranks what the pastime authored

`spot` — `bay`, `outside`, `till` — is a *pastime* saying where it looks right,
authored when the shop had nowhere of its own to send anybody. `spotFor` now
asks the shop first and the pastime second.

A full override, deliberately, and it was the one real design decision here. The
alternative was to override only the pastimes with no place of their own, so a
"sit on the step" still happened on the step — which is better flavour and a
worse *feature*: you pay for a room, half your hires use it, and the half
standing in the aisle read as broken. `PASTIME_SPOTS` is now what a break looks
like in a shop that has nowhere to put one, and that is exactly the shop
everybody has today.

**A shop with no break area is unchanged, to the cent.** `seatIn` returns null,
`spotFor` falls through, and no rng is drawn on the way past — measured below.

### Three traps, all of them found by writing the sweep

- **A seat has to be held, not recomputed.** `s.breakAt` is claimed when the
  break is taken and given back when they stand up. Recomputing "the first free
  cell" every tick means two hires pick the same one the moment a third stands
  up, and a worker who changes seats halfway is a worker who turns round for no
  reason anybody watching could explain.
- **A seat with no route is not a seat.** This is the one the override makes
  possible, and it is the worst failure available: wall the room off and every
  hire walks at a cell they can never reach, never rests, and drags at
  `TIRED_PACE` forever — strictly worse than having no break area at all. So the
  seat search asks `findPath` and falls back when there is no answer.
- **The room has to move a number.** Walking round to it costs the shop time it
  would not otherwise have spent, so a room that restored the same amount would
  be ground you pay for that only ever makes things worse — the "tier that
  changes no number" trap wearing a paintbrush. `SEATED_RESTORE` is 1.5.

### Measured

One frozen database (`VACUUM INTO`, driven in-process against `SNS_DB`), so both
halves are the same shop with the same four hires and the same content — the
control CLAUDE.md insists on, since `simulate` rebuilds from the saved world.

**With no break area painted, the two halves are byte-identical:** −198.50,
−170.76, −140.77, −150.15, −232.39 on five seeds, before and after, to the cent.
That is the fallback claim proved rather than asserted.

**With one, 12 seeds × 120 days**, laid on grass two tiles from the door:

| | mean profit | seeds better |
|---|---|---|
| no break area | −220.02 | — |
| beside the door | **−172.94** (+47.08) | 11/12 |
| far corner of the map | −208.12 (+11.90) | 6/12 |

(This world runs at a loss with four hires on wages whatever you do; the delta is
the measurement, not the level.) **Where you put it is most of what it is
worth** — which is the right shape for a thing you paint, and it falls out of the
walk rather than out of a rule anybody wrote. Laying it on shop *floor* measured
worse still, and that is honest too: a break tile indoors is a cell nothing can
ever be built on again.

The balance bot never paints ground, so `simulate` cannot reach the second half
on its own — the measurement paints a room into a throwaway copy of the save,
persists it, and runs the ordinary runner against that world.

### What 9 touched

| File | Why |
|---|---|
| `shared/tiles.js` | `T.BREAK`, and it is walkable |
| `shared/build.js` | `GROUND.break`, and `does` on all three pads |
| `server/layout.js` | `padRegion('break')` → `L.break`. Nothing seeds it |
| `server/sim/staff.js` | `spotFor` / `seatIn` / `authoredSpot`, `breakAt`, `SEATED_RESTORE` |
| `shared/schemas.js` | `PASTIME_SPOTS` says it is the fallback now |
| `client/render/palette.js` | the tile's own colour, for a pad nobody has styled |
| `client/sections.js` | the palette entry, and a Staff sub-tab under Building |
| `mcp/server.js` | `break` in `create_fixture` |
| `scripts/document-fixtures.js` | reads `does` instead of branching on the kind |
| `scripts/verify-break.js` | new — the whole sweep |
| the database | `break-room`, $12/tile |

### Watch out for

- **`break` is a reserved word.** Fine as a property (`L.break`, `GROUND.break`)
  and illegal as a variable, so the layout's local is `breakRoom`. Do not rename
  the field to match the local — the layout speaks the kind's own name, the way
  `bay` and `drop` do.
- **Nothing seeds a break area, and nothing should.** `freezeYard` stamps the bay
  and the drop-off because a shop with nowhere for a delivery to land is broken.
  A shop with nowhere to rest is the shop everybody already has.
- **The sweep cannot force which pastime is drawn.** An untagged pastime is
  offered to anybody, so there is no way to author your way to a fixed draw —
  every assertion reads the row the worker actually drew. The first draft
  asserted against its own row and passed for the wrong reason twice.

## Step 10 — the shop hand ✅

⚠️ **Balance-neutral by construction, not by measurement.** No worker kind in
the catalog has `merchandise` in its job list, so the job cannot fire until
somebody assigns it in the worker menu — and the two code paths that are always
on (the `soldDay` stamp, and the `droppedItem` guards) read an empty map and a
field nothing else touches. There is nothing to measure until a shop opts in,
and the note under *On measuring it* below is what to do when one does.

⚠️ **The label is "Merchandise", not "Shop hand"**, because `shop-hand` is
already the id of a worker *kind*. A job sharing a worker's name reads as the
one job that worker does.

### What's wrong

**Nothing in the game ever takes goods off a shelf.** Stock leaves a board three
ways and a worker is none of them: a shopper buys it (`takeFromShelf`), it
spoils (`spoilStock`), or you walk over and Take it by hand. `shelve` only ever
puts down what is in hand and `tidy` crates what has nowhere to go at all, so
every job in `JOBS` points one way. A board, once committed, stays committed
until the market or the clock empties it.

That is fine for anything that sells. It is exactly wrong for anything that
doesn't, and the failure has a shape:

- **A board that stops selling holds its board for ever.** `releaseBoards` is
  the only thing that ever hands one back, and it only looks at boards at
  *zero* — "empty two days with none coming". Three units of something nobody
  wants is not empty, so it never qualifies; a non-perishable has no
  `shelf_life_days`, so spoilage never takes it either. The board is gone for
  the rest of the save.
- **…and boards are the scarce thing, not shelf space.** `shelfCapacity`
  divides a unit by its `shelfShares`, so a board is what the shop spends to
  carry *range*. A dead board is not untidiness, it is one fewer kind the shop
  can ever sell — and `pickItem` cannot choose around it, because `already`
  counts a stocked board as part of the range.
- **The same item splits across units with no way back.** `shelvesFor` ranks
  "already holding it" above a bare board, which is right for one trip and
  accumulates over many: a crate bigger than the best shelf's room spills onto
  the second best, and the two half boards then sit there for ever. Two boards
  spent to hold one kind.

None of it reads as a bug in play. It reads as a stocker who has stopped caring
— the same tell the farm that would not stop picking had, and the same lesson: a
loop with no closing question.

### What the job is

`merchandise`. One job, two verbs, and **both of them strictly reduce the number
of occupied boards.**

| | Fires when | Does |
|---|---|---|
| **Clear** | a board has sold nothing for `STALE_BOARD_DAYS`, is not reserved, and nothing of it is on its way in | `unshelve` it, walk it to the drop-off, `dropGoods` |
| **Merge** | one item is on two units and the worse-ranked holding is under an armful | `unshelve` the worse, `stockShelf` it onto the better |

Clear outranks Merge, because a dead board costs the shop range and a split
board only costs it a board.

Both end somewhere the game already has. Clear is not a bin — it is the shop
putting something back in the stockroom. That is why it is `dropGoods` and not a
sell-back: what something is worth is the player's question, and a worker
answering it is a worker spending your money.

### …and the crate walks straight back, which the spec above missed

The paragraph this replaces read *"a crate on the pad is what `unload` picks up
the moment a shelf has room, so if demand comes back the goods walk back out on
their own"*, and called that a feature. It is the bug.

The crate a Clear makes is an ordinary pallet — there is only one kind. The
board it just freed is a board with room on it. So `unload` lifts the crate,
`shelve` fills the board it came off, and about a minute later the shop is
exactly as it was, four days from doing it again. **The whole job would have
been a loop that moves stock around a shop and changes nothing**, and the reason
that is worth writing down rather than quietly fixing is that it would have
*looked right*: a hire crossing the floor with an armful is what a working shop
looks like. Nothing in a screenshot, a log or a balance run says otherwise.

So Clear marks the **item**, not the board — `Game.giveUpBoard`, stored on
`orders.dropped` as `{ item_id: day }` — and `shelvesFor` and `pickItem` skip
it. Three things about the shape:

**The item and not the board**, because giving up on one board alone means the
next delivery lands the same thing on the unit next door.

**It does not expire.** A timer is worse than either answer: the crate is still
on the pad, so the day it lapsed a worker would carry the same goods back to the
same board and start the same four days again. Churn on a loop reads as a bug in
a way "we don't stock that any more" never does.

**Two things overrule it and both already existed.** Ticking a shelf for it
clears the mark outright in `assignShelf` — the log line promises exactly that,
so it has to be the thing that happens, and a mark left standing against a shelf
with the item's name on it is the version that would confuse. And your own hands
never read it at all: `stockShelf` is untouched. The shop giving up is the shop's
judgement about its own range, which is the line `orders.assign` already draws,
and it was never a rule about what you may do.

It lives on `orders` rather than on the world for the same reason: it is
ordering state, it persists and reaches the client with `ordersOut()` for free,
and the supplier panel is where it will eventually want a row.

### Why "spread" is not in it

The obvious third verb — one deep board becomes two boards on two units, so
shoppers walk less — is deliberately out, for two reasons.

**It is a decision about range, not about tidiness.** Whether an item deserves a
second unit is the same question `pickItem` answers for a bare unit, gated on
`orders.assign` because it is the shop choosing for you, and the same question
your own tick in the shelf menu answers. A worker who duplicates an item across
units is making that call a third way with no switch on it — which is the line
docs/ordering.md drew and is worth holding.

**And mechanically, it points the other way.** Clear and Merge only free boards;
spread only takes them. Put all three in one job and the hire oscillates —
merge two boards into one, notice a unit is now bare, spread back into it, at
tick rate, for ever. Every fix for that is a latch, and this file has already
retired two of them: `stowLock` and `tookFrom` both existed to hold off an
action nobody had asked for, and both are gone because the design stopped
generating them rather than because someone found a better latch. A job whose
verbs all point the same way cannot oscillate and needs no latch.

If "this should be on two shelves" turns out to be worth having, it is a
standing instruction the *shop* holds — an entry in `orders.items`, beside `min`
and `max` — and not a worker's opinion.

### What it needs from the sim

Three things, and only one of them is new state.

**`unshelve` already exists** and is exactly this verb: one board, an armful,
the label left behind. It was written for the shelf menu's Take, and it needs
nothing to serve a job as well — same reach check, same refusal on mixed hands,
same deliberate choice to leave the stack at zero rather than clear it.

**A board has to know when it last sold**, and there is no such field.
`stockedDay` answers a different question: a board refilled yesterday and
untouched since is fresh by that measure and dead by this one. One line in
`takeFromShelf`, beside the `stack.qty--`:

```js
stack.soldDay = this.day;
```

`this.day` and never `this.elapsed` — `elapsed` restarts at zero on load, which
is the trap `yieldedAt` and `plantedAt` both had to learn. It rides in the
`stock` row of `persist()` next to `stockedDay`, and a save written before it
reads `soldDay ?? stockedDay`, so a board that has *never* sold counts stale
from the day it was filled. That is the right default rather than the lenient
one — never having sold is the case this job is for.

**A hire mid-errand needs to remember it**, and cannot borrow the player's
machinery: `stepActions` opens with `if (p.staff) continue`, so `p.errand` and
the whole arming ring are for people, not hires. Clear is two legs — pull the
board, then walk to the pad — and between them the worker is simply someone
holding stock, which is what `shelve` fires on. So it would put the goods
straight back on the unit it just took them off, whose board is free again the
moment `clearStack` runs. One field on the worker (`s.clearing`) that `shelve`
declines while it is set, cleared when the hands are. That is a *job in flight*
rather than a latch — the same thing `p.errand` is for a player, which is why it
is one field and not a rule about what may not follow what.

**Board pressure is not needed, and the first draft was wrong to want it.**
Gating the job on "does the shop actually want a board" — a crate with nowhere
to go, a reservation unfilled — makes the behaviour depend on a global nothing
on screen shows, so the same shelf is tidied on Tuesday and ignored on Wednesday
for reasons the player cannot see. Freeing a dead board is right whether or not
something is queuing for it, and the cost of being early is a crate on the pad.

### What the player sees and sets

No new UI. Three surfaces that already exist carry the whole thing:

- **`merchandise` is a job**, so it appears in the weight dial in
  `client/worker-menu.js` for free, and a shop that does not want it gives it
  weight 0. That is the switch, and it is the same switch every other job has.
- **The unit's own switch**, in the fixture menu's *Settings* tab under *The
  shop hand*, beside *When it gets refilled*: **Let them rearrange it** /
  **Leave it alone**. This is the control, and the first pass shipped without it
  by mistake — see below.
- **A reservation is also a veto.** A ticked board is never cleared and never
  merged away from — the same protection `releaseBoards` gives, in the same
  words, for the same reason: a decision the shop quietly undoes is not one.
- **`pushLog`**, in the shape `releaseBoards` already uses — *"Cleared the
  tinned peaches — nothing sold in 4 days."* A board that vanishes without a
  line is a bug report waiting to be filed.

`STALE_BOARD_DAYS` wants to be meaningfully longer than `EMPTY_BOARD_DAYS`'s
two, because the two questions are different sizes: an empty board is asking to
be refilled, a full one is asking to be given up. Start at 4 and measure.

### A reservation is not the switch, which the first pass got wrong

The paragraph above originally read that a reservation *was* the veto and left
it there — one existing control doing two jobs, which is always worth a second
look and was wrong here.

A reservation answers **what a board is for**. It comes with hands-off attached,
which is right, and that covers exactly the units you already had plans for.
Every unit you have said nothing about was fair game, and there was no way to
say "leave that one alone" except to tick an item onto it that you did not
actually want there — a control used for its side effect, which is the shape of
a missing control.

So `shelf.managed` is its own switch, `setShelfHands` sets it, and it is read in
three places: `staleBoards`, and both ends of a merge. Both ends, because a
locked unit that quietly grew a board is a unit the hand rearranged.

Two things about the shape:

**It defaults to true**, so a save that has never heard of it plays exactly as
it did — the same argument `open` makes about the shutters. Which means
`persist`'s shelf filter had to learn about it: that filter keeps a shelf with
stock, a reservation or a priority, and a switch flipped on an *empty* unit is
still a decision.

**It is not gated on build mode**, like `restock-order` and unlike `build-boh`.
It is a shopkeeping instruction taken stood in front of a shelf, not a change to
what the shop is made of.

### On measuring it

This is a change to `staff.js`, so it moves every number `simulate` reports.
Decide which direction you expect *before* running it, because both are
defensible: freeing boards raises the shop's range, and a hire spending trips on
tidying is a hire not on the till.

Two things the run has to be honest about.

**Ten seeds against a frozen world** (`SNS_DB` against a copy), because
`server/sim/index.js` is being edited by the other person at the same time and a
before/after an hour apart measures them at least as much as it measures this.

**`simulate` can only see half of it.** The balance bot's shop is stocked by
`pickItem`, which scores on margin × pull — so the bot never stocks something
that doesn't sell, and the case this job exists for is a case the bot cannot
create. "No change" here is the instrument being blind, exactly as it is blind
to the kitchen, and the honest claim is *costs nothing*, not *gains nothing*.
The half that can be measured is the trips: shelves-found-empty and spoilage,
which are the two numbers step 1 of docs/ordering.md ended up believing instead
of the profit line.

### Watch out for

- **Claim both ends of a Merge before the first step.** `claim`/`claimed` is
  keyed `('shelf', id)` and already stops two stockers converging. A hire
  pulling stock off a board another hire is walking towards with an armful is
  two workers visibly undoing each other, and claiming only the source is how
  that happens.
- **`unshelve` refuses mixed hands, so the job checks first rather than
  catching after.** The weighted draw does not care what is in a worker's hands,
  so `merchandise` comes up mid-armful about as often as not — and a job that
  starts a walk it cannot finish is the twelve-round-trips bug in `unload`'s
  comment, wearing a different hat.
- **Re-test a merge target on arrival.** `shelvesFor` is read before the walk
  and the shop moves during it: the better shelf can fill, spoil or be sold back
  on the way over. Arriving with an armful and nowhere to put it is `tidy`'s job
  and that is fine — what is not fine is asserting it cannot happen.
- **`homeSupply` counts a cleared crate**, which is correct and worth saying out
  loud: the moment a board is cleared onto the pad the supplier stops ordering
  that item. That is the loop closing, not a side effect to work around.
- **Do not extend `releaseBoards` to do this.** It runs once in `onNewDay` and
  writes straight into the layout; this is a worker walking across a shop. A
  rule that teleports goods into a crate is the same shape docs/deliveries.md
  exists to argue against. The two stay neighbours and stay separate:
  `releaseBoards` hands back a *label*, `merchandise` moves *goods*.
- **A reservation is the merge TARGET, never the source, so the veto is
  invisible from the obvious angle.** `verify-hand`'s first draft asserted that a
  ticked board is never merged and failed — correctly, because `shelvesFor`
  ranks a reservation first, so the reserved unit is where everything ends up.
  What the veto actually decides is *which* board survives, and the assertion has
  to reserve the SMALL board to reach it. Both outcomes are one board; only one
  of them honours what you asked for, and nothing on screen tells them apart.
- **A merge frees its source board the instant it is lifted**, so a test that
  waits on "one board left" reads the shop with the worker still halfway across
  it, holding all of it. `verify-hand` waits on the board count *and* empty
  hands. Anything asserting on a state a worker walks through needs the same.

### …and the shop went on BUYING what it had given up on

Found on a live save at day 97, two steps after this shipped. The mark is read by
`shelvesFor`, which refuses a dropped item a shelf before it asks anything else —
and the buying half had never been told. `pickItem` checks it, so a *bare* board
was safe; the hole is the **top-up** path in `restock`, which orders more of the
emptiest pile already standing on a unit, and a given-up item is still standing
on every other board it was on.

So the vans kept coming and every case landed somewhere nothing could ever shelve
from. None of the symptoms are here: the yard fills, `bayRoom` collapses so the
shop stops ordering what it *does* sell, and `putDown` cannot stow onto a full
pad — its documented promise to hold goods rather than bin them — so the crew
stand about holding armfuls. Six items given up over days 94–95; the next
morning's log ordered 9x Dried Pasta, 25x Liquorice and a Breakfast Cereal
against all six, and the stranded pile went 33 units → 59 in a day.

`givenUp` (`server/sim/staff.js`) is the one spelling, asked by **both** spending
paths — `buy` and `larderOrder`, since an ingredient strands exactly as a product
does. A reservation overrules it, shop-wide via `keptFor`, or the shop refuses to
buy for a board it would happily shelve. It deliberately does not *clear* the
mark the way `shelvesFor` does: that one is placing goods that already exist,
this one is deciding whether to create any, and `orders.dropped` keeps one
writer. `verify:hand` 4bb2 guards it, with two controls — the line still stocked
is still bought, and the very same board is bought for when nobody gave up on it,
because a negative that was never orderable proves nothing.

### What 10 touched

| File | Why |
|---|---|
| `server/sim/index.js` | `STALE_BOARD_DAYS`, `soldDay` in `takeFromShelf` and `persist`/`restoreContents`, `staleBoards`, `giveUpBoard`, `droppedItem`, `orders.dropped`, the un-mark in `assignShelf`, `setShelfHands`/`handMayTouch` and `managed` through persist, restore and the snapshot |
| `server/sim/staff.js` | `merchandise` + `deliver`, `s.shifting`, the `shelve` guard, the errand reset in `stepStaff`, `droppedItem` in `shelvesFor` and `pickItem`, `handMayTouch` on both ends of a merge |
| `shared/schemas.js` | `merchandise` in `JOBS` |
| `mcp/server.js` | the same, in `create_worker`'s job enum |
| `client/worker-menu.js` | the `JOB_INFO` row — named "Merchandise", see above |
| `client/fixture-menu.js` | `HANDS` + `handRows`, and the group on a shelf's menu |
| `server/rooms/MartRoom.js` | the `shelf-hands` message |
| `scripts/verify-hand.js` | new — 48 assertions |
| `package.json` | `verify:hand`, and into `npm run verify` |

Thirteen sweeps green. Nothing was written to the content database: no worker
kind is authored with the job, so the shipped shop plays exactly as it did.

## Step 11 — one farm directive ✅

`till`, `sow` and `harvest` were never three decisions. They are three steps of
one loop over the same beds, and the loop only turns if you have all three: a
hire told to sow and not to till waits on a field nobody is turning over, and
one told to till and not to sow breaks ground for a crop that never goes in.
Nobody has ever wanted the middle one on its own.

Step 2 gave that away for free, because a weight was purely relative and the
absolute numbers meant nothing — three lines was three lines. `shared/jobs.js`
turned the total into a **budget**, and at that moment the triplication started
charging: three of the twenty points a new hire has, spent on a decision with
exactly one sane setting, before they can be told anything else. The menu said
it too — the farm was three of the ten rows on the one pane that scrolls.

So there is one `farm` job. The order inside it is not a preference and is not
tunable:

```js
function farm(game, s) {
  return harvest(game, s) || sow(game, s) || till(game, s);
}
```

Picking frees a bed to grow the next lot and puts goods where they can be sold;
sowing is one action from producing; breaking new ground is the only one of the
three that produces nothing at all. That is the same rule `till` has enforced
about itself since step 2 ("refuses while a turned bed is still waiting for
seed"), said about all three instead of two. Each step still guards itself and
each returns false **before** it claims anything, so falling from one to the
next costs nothing and cannot strand a hire holding a target they are not
walking to.

### The fold is a max, and that is the whole of what was hard

A list written before this exists in three places that never revalidate: the
`workers` rows in the live content database, the `roster` on every save, and
`data/seed/workers.json`. `stepStaff` *skips* a job this build does not have —
correctly, so a kind authored against a newer build does not kill the tick — so
doing nothing would present as a farmhand who quietly stopped farming, with
nothing logged and their menu still showing three directives nobody implements.

`foldJobs` is therefore read-time, the way `kindOf` reads a piece with no kind:
an old save, an old export and a fresh seed all agree with no migration and no
ceremony. It runs at three boundaries, and each is a different kind of thing:

| Where | Why that one |
|---|---|
| `content()`'s `load()` | rows come out of the DB raw — nothing validates on read — and every reader of an authored kind is downstream of it |
| `Game.create`'s roster | a hire's list is *theirs*, copied off the kind the day they were taken on and edited since, so the catalog fold never reaches it. Once, here, rather than in `jobsOf` at 20Hz |
| `WorkerSchema`'s `jobs` | a `z.preprocess`, so a row rewritten through the sanctioned path is **stored** folded — `npm run seed` migrates the data it loads rather than being refused by the enum |

And `assignJobs` folds what arrives on the wire, so a client still holding the
old vocabulary is answered rather than refused.

**The merge takes the highest of the three weights and never their sum**, which
is the one non-obvious decision here and it is not about the budget. `drawOrder`
lets a hire whose drawn job has nothing to do fall no further than *half* that
job's weight (`FALLTHROUGH`, and the paragraph above explaining why it exists).
The seeded farmhand is `harvest 10, sow 8, till 6, shelve 8, tidy 1`: summed,
`farm` becomes 24, its floor becomes 12, and `shelve 8` is out of reach — so
every draw that found the beds empty, which is most of them because crops grow
slowly, would leave them standing still. That is exactly the "four idle
specialists" failure the floor was added to prevent, arriving as a farmhand who
stopped working the day this shipped. A max keeps the list the shape it had:
`farm 10, shelve 8, tidy 1`.

One thing falls out of that worth knowing. `jobBudget`'s floor — *what the KIND
was authored with, or `JOB_POINTS`, whichever is larger* — exists because
authored lists ran from 11 to 33 and a flat 20 would have handed you a farmhand
over budget on the day you hired them. The farmhand was the 33. Folded, their
list totals 19, so the floor stops applying to them and they land on the
ordinary allowance like everybody else, one point spare. The floor is now doing
nothing for any shipped kind, and it should stay anyway: it is a rule about
authored content, and the next heavy kind somebody writes is what it is for.

### What 11 touched

| File | Why |
|---|---|
| `shared/jobs.js` | `FOLDED_JOBS`, `foldJobs` — the vocabulary shim, and why it is a max |
| `shared/schemas.js` | `farm` in `JOBS`; `z.preprocess(foldJobs, …)` on `WorkerSchema.jobs` |
| `server/sim/staff.js` | `farm`; `till`/`sow`/`harvest` demoted to its steps and out of the `JOBS` map |
| `server/content.js` | the fold in `load()` |
| `server/sim/index.js` | the fold on the saved roster and in `assignJobs` |
| `client/worker-menu.js` | three `JOB_INFO` rows become one — and every row splits into `blurb` (short enough not to wrap in a 184px column) and `detail` (the sentence, on the hover), because a useful line wrapped to three and a list of three-line rows is a list you scroll to reach the buttons under it |
| `mcp/server.js` | the `JOB_HELP` gloss |
| `scripts/verify-yard.js` | its test hand's list |

No content row was rewritten: the seeded farmhand and shop-hand still say
`harvest`, and read as `farm`. Nothing in `docs/fixtures.md` moves.

## Step 12 — a rung that packs a crate ✅

A hire has shouldered whole crates since mixing landed: `unload`'s `wholeCrate`
branch lifts the box rather than an armful out of it, `stockFromCrate` pours
every pile a unit has a board for, and whatever will not fit rides on to the
next board and then home. What it could never do is make a box that was not
already made.

That is the bay this step is about, and it is the ordinary one. A van drops
part-crates — four lettuce, four eggs, four bread, three boxes — and each is
judged on its own contents:

- `fit` scores each at four against a six-unit armful, so `MIN_TRIP` lets it
  through but `wholeCrate` refuses: four is not more than six, so the box is
  never lifted.
- The hire takes an armful of four, and `fillHands` — deliberately, so it can
  never spend a kind slot the walk was counting on — tops up **only the kind
  already in their arms**. There is no more lettuce, so they leave with four.
- Three walks of the shop for twelve units, and every one of them looks like a
  worker working.

`packs` on a tier is the way out: **how many kinds this rung will assemble into
one box before setting off.** Lift one, fill it from the boxes standing beside
it with whatever the shelves are short of, walk one full crate.

| | |
|---|---|
| Authored | `packs` on a worker tier — an integer, 0..`LOT_KINDS`, default **0** |
| Reads it | `packsOf` in `server/sim/staff.js` |
| Does it | `fillCrate` (staff.js) over `Game.packCrate` (sim/index.js) |
| Priced | Nothing new. It is a rung, and a rung already costs what it costs |

### Why it is a number and not a flag

A count of KINDS, because the units cap belongs to the crate — `Game.crateLot`
still bounds what actually goes in, so a rung cannot author its way past what a
box holds. It also gives the ladder something to climb: `packs: 2` leaves the
third kind standing on the pad, which is a visibly different shift from
`packs: 3`, off one integer.

The default is what makes it opt-in. `packs` reads 0 for every rung ever
authored, `packFill` returns 0, and both size tests in `wholeCrate` are the
arithmetic they already were — so a save, an export and a fresh seed all agree
with no migration, and no shop gets faster because somebody deployed.

### The bar is not the size of their hands

The one non-obvious line, and it was a live bug the moment this shipped rather
than a hypothetical. `wholeCrate` asked `lotTotal(pallet) > hands` — *at or
under an armful the trip is identical and the box is pure ceremony* — which is
right while an armful and a crate are the same journey made two ways.

It stops being right the moment `carry_mult` can take hands up to a whole crate,
and the shipped stocker's second rung already does: `carry_mult: 2` is twelve
units against a twelve-unit crate, so `12 > 12` is false, for ever. The one hire
in the game you would promote *to* pack crates was the one hire who could never
shoulder one — a rung that takes money and moves no number.

And it is worse than neutral. Big hands do not help with a bay of part-crates at
all, because `Game.unload` sweeps **one box** and `fillHands` is same-kind-only:
a twelve-unit stocker facing three boxes of four leaves with four, exactly as a
six-unit one does. So for a packer the bar is `best` — what the armful trip
would actually move off this pallet, which `fit` has already computed two lines
up — and the question becomes the honest one: *is the packed box worth more than
the armful this bay can assemble?* For everybody else the two numbers are equal
and it is the test that was always there.

### Three rules the new verb carries

`Game.packCrate` is its own verb rather than an option on `unload`, for the
reason `haul` is its own field: a shared function is one caller reading the
wrong one of two hands, and that is a conservation hole rather than a visible
bug. `unload` fills `p.carry` bounded by `carryLot`; this fills `p.haul` bounded
by `crateLot`, and the two never meet.

- **Out of the yard only.** `wholeCrate`'s termination argument said about the
  *second* box. A packer drawing from a stray in an aisle takes goods somebody
  already carried out there and carries them back, and two hires would pass one
  pile between two boxes for the rest of the save. Enforced in the verb *and*
  skipped in `fillCrate`, which is the pairing `fit` has with `Game.unload`'s
  cap: the job loop must not count what the verb would refuse.
- **Rubbish never packs, either direction.** `verify:bin`'s claim pointed at the
  new verb — rot poured into a box of bread is rot back in the supply.
- **The older stamp wins the merge.** Two dodges live in one line of `lotAdd`:
  it merges by item id keeping the *destination's* stamp, and pushes a bare
  `{item_id, qty}` for a kind the box has not got, which `spoilYard` reads as
  fresh for ever. Either one makes packing the way to beat spoilage — which is
  precisely what `stampPile` exists to stop — and neither is visible, because a
  crate of laundered flour looks like a crate of flour. The stamp is written
  through `p.haul.stacks` and never through `lotStacks`, which hands back
  copies: a stamp written onto what *that* returns is written onto a value
  nobody keeps, and reads as the clock silently not carrying.

### What 12 touched

| File | Why |
|---|---|
| `shared/schemas.js` | `packs` on a worker tier, capped by `LOT_KINDS` from `shared/lot.js` |
| `server/sim/index.js` | `Game.packCrate`; `Game.onAPad` (moved off `staff.js`, because the verb has to refuse on it) |
| `server/sim/staff.js` | `packsOf`, `packFill`, `fillCrate`, and `bar` in `wholeCrate` |
| `client/worker-menu.js` | the rung's blurb — said as the trip it buys, not the number it is |
| `scripts/verify-pack.js` | new — 76 assertions, none of them visible in a still frame |
| the database | `packs: 3` on the stocker's *Runs the back*, which is the rung whose name already said it |

`verify:pack` found four things on its first run: the stamp written onto a copy,
the seed's own stamps written the same way, a "stray" cell that was still the
bay, and the big-hands bar above. The last is the only one that was in shipped
code rather than in the sweep.

## Step 13 — a rung that rearranges the shop ✅

Placement was the one thing you spent money on that said nothing back. A shelf
by the door and a shelf in the dead corner sold identically; the top board and
the bottom board sold identically; and the one rule that made a spot worth money
— the endcap — was invisible to everything that decides where stock goes, so the
shop cheerfully auto-filled the best unit in the building with dried pasta.

Three pieces, and the order matters because each needs the one before it.

### The sim learns where people walk

`Game.traffic` — one number per tile, in **seconds of footfall**, faded 7% a
night so it is a rolling fortnight rather than a monument to the shop you had
while you were learning. Two rules make it a measurement of the PLACE:

- **Only walking shoppers.** Somebody standing at a board is standing there
  because of what is on it. Count them and a shelf scores well for holding good
  stock and is then given good stock on that evidence — a loop that freezes the
  layout on day one and calls it evidence.
- **Never staff.** A worker's route is a fact about where the shop told them to
  go, so a map with them in it is brightest along the path from the bay to the
  shelves: the shop's own plumbing showing through the thing you are reading.

`TRAFFIC_REACH` is **1.4** and the number is set by the shelf pitch, not by
feel. It was 2.2 first, on the reasoning that somebody crossing the end of an
aisle passes everything in it — and a generated shop stands its units one and
two tiles apart, so at 2.2 every unit is credited for every step anybody takes.
The map is then perfectly correct and says the same thing about all six shelves,
which reads as the feature not working. `verify:spots` could not tell two
shelves apart until this came down.

### `spotScore` — is this a good place?

Passing trade against the shop's own average (relative, because how many
seconds a busy tile collects is catchment and reputation, not a fact about this
unit), times the endcap. A shop nobody has walked in scores 1 everywhere, which
is the old game exactly.

Its sibling is `boardPull` — **eye level is buy level**, a peak at 0.8 tiles
falling away both ways, read off the art through the same `boardsForShare` the
renderer draws with. Kept apart from `spotScore` because they are measured
differently: height is fixed when the thing is built, footfall changes as the
shop does.

### `arranges` — the rung

`merchandise`'s third verb, after Clear and Merge and reached only when neither
has anything to do, which is what makes it occasional without a directive to
tune. It moves a whole board of something valuable to a better spot. Four
guards, each load-bearing: the rung (0 on every tier ever authored), hands-off
at BOTH ends, a reservation at either end, and a real gain.

**The gain is the termination argument, not a taste knob.** A move that need
only be *better* can be undone by one that is better again, and two shelves a
hair apart will pass a box between them for the rest of the save — a hire
visibly working, all day, changing nothing. Requiring a ratio means each move
increases a bounded quantity by a fixed factor, so there is a last move.

### Three things this cost, and one it did not

**`shelvesFor` may not read a spot.** Ranking the day-to-day stocking order by
`spotScore` is the obvious place to put it and cost **−72% mean profit over
three seeds** against one frozen world; one seed lost a quarter of its units
sold. That sort decides where an item's stock lands every delivery for ever;
footfall drifts, so the order drifts, and an item whose best-ranked unit changed
on Tuesday starts a second home — the "one item, two homes" spiral
`Game.homeShelves` exists to close, arriving by a new route. A spot may only be
read where the answer cannot churn.

**…and `rearrange` may not USE `shelvesFor`.** Same rule, opposite end: that
function answers with the item's one home, so the only unit it ever offers is
the one the stock is already on, and the verb read as doing nothing. It asks
`boardFor` directly. Bypassing the home rule is safe *here and nowhere else*
because this moves the whole board and clears the old one — the item has one
home before and one after. Anything that could move PART of a board would open
the spiral by the back door.

**The constructor's ordering.** `sizeTraffic` is what pours the saved map in, so
it has to run after the fields it reads — placed with `buildWalkGrid`, where it
looked like it belonged, it cut the grid correctly and came back empty. And it
has to be in the constructor at all, because `Game.create` generates its layout
inline: a shop that is merely *loaded* never re-flows, so a shop nobody happens
to build in would record no footfall ever.

**What it did not cost is balance.** `simulate` is byte-identical over three
seeds, because the balance bot never promotes — so `arranges` is 0 in every run
and nothing else reads a spot in a way that moves the sim. That is the
instrument being blind rather than the change being free: the eye-level and
endcap terms *do* move the sim and have no control, because getting one means
running the old code.

### What 13 touched

| File | Why |
|---|---|
| `server/sim/index.js` | `noteTraffic`, `sizeTraffic`, `fadeTraffic`, `trafficOut`, `trafficWire`, `spotScore`, `boardPull`, `atEye`; `traffic` on the save, out AND back |
| `server/sim/economy.js` | `IMPULSE_RADIUS` moved here (two readers, and `staff.js` cannot import `sim/index.js`); `boardPull` on `rankShelves` |
| `server/sim/staff.js` | `rearrange`, `arrangesOf`; the endcap term in `pickItem`; the note on why this sort has no spot term |
| `shared/model.js` | `boardsForShare` — lifted out of the renderer, because the sim now asks the same question |
| `shared/schemas.js` | `arranges` on a worker tier |
| `client/render/heat.js` | the overlay, and `adopt` — it draws the sim's map and keeps none of its own |
| `client/sections.js`, `client/footfall.js` | the switch, in the Settings menu |
| `scripts/verify-spots.js` | new — 75 assertions |
| the database | `arranges: 1` on the shop-hand's *Trusted* |

`verify:spots` found four things on its first runs, three of them in shipped
code: the stale mean, the constructor ordering, `shelvesFor` blocking the verb
entirely, and `TRAFFIC_REACH` being too coarse to tell two shelves apart.

## Step 14 — a rung that plans its round ✅

**Built.** Prompted by the plainest question anyone has asked of this file: what
would make the crew more efficient?

### What was wrong

Nothing a worker chose between had ever been chosen by how far away it was.

That is not a figure of speech. `harvest` and `sow` both took
`game.layout.plots.find(...)` — the first legal bed in array order — so a
farmhand standing at the end of a sixteen-bed field walked the length of it to
reach bed 1, because bed 1 is listed first. `serve` took `tills.find(waiting)`,
the first till with anybody in the queue. `unload` scored crates
`stray * 1e6 + moves`, which is a real preference about the *trip* and says
nothing at all about the walk — so a bay of identical part-crates was worked in
whatever order the boxes happened to be stored in.

Every one of those is a correct decision. The sum of them is a crew who wander,
and it reads as the staff being stupid rather than as four `find`s that were
never asked the question.

It is also invisible twice over: a hire walking to the near bed and a hire
walking to the far one are the same still frame, and the shop is the same shop
afterwards either way. Only the clock moved.

### What it is

`routes`, 0..1, on a worker tier. Zero is every rung that existed before it, so
a save, an export and a fresh seed all run the code that was there.

**It is offered only the candidates a job rates EQUALLY**, and that is the whole
of what makes it safe rather than a balance change wearing an upgrade's name:
every ripe bed, every turned bed, every till with somebody waiting, every crate
that ties `unload`'s own score exactly. It can never trade a better trip for a
shorter walk, because it is never shown a better trip. The bay is where that
distinction earns its keep — a nearer, smaller crate is three journeys instead
of one, and a rung that took it would look exactly like this one.

The number is the dial, the same shape `arranges` uses: it sets how many tiles
nearer the other target has to be before a hire diverts, interpolating
`ROUTE_SAVING_MAX` (4) down to `ROUTE_SAVING_MIN` (0.5). A lukewarm rung takes
an obvious short cut; a keen one always walks the shortest way. The floor is not
zero on purpose — two targets a hair apart are the same walk, and a pick that
changed its mind between them would jitter as the hire drifted.

### Three things it rests on

**The saving is measured against the incumbent, never against a running best.**
Take every improvement in turn and half a tile at a time adds up to a walk
across the shop, at which point the threshold guards nothing.

**The comparison is strict, so a tie keeps the incumbent.** That is what lets
the zero branch of `pickNearest` be `list.find(ok)` verbatim rather than a
re-derivation that happens to agree — and the verbatim branch is what keeps
`hasSomewhere`'s short-circuit, which walks the shelves once per ripe bed.

**Straight-line, and never `findPath`.** This is asked per candidate per worker
per tick and A\* is the hottest loop in the game, so a route-length version
would cost more than the walk it saves. It is only ever a *preference*: a hire
who picks a bed behind a wall stalls and re-draws, which is exactly what already
happened to an unreachable bed that was first in the list.

### Where it deliberately does not go

`shelvesFor`. CLAUDE.md records what a drifting score in that sort costs —
−72% mean profit over three seeds — because that sort decides an item's *home*,
and a home that moves is the one-item-two-homes spiral arriving by a route
`homeShelves` cannot see. Distance from a worker drifts faster than footfall
does. `craft` is left alone for a different reason: which machine to serve is a
real preference (`wants`, `feasibleRecipe`), not a tie. `idle`'s posts are left
alone because they are handed out in roster order *so that two clerks never
share a tile*, which is a rule rather than a walk.

### What 14 touched

| File | Why |
|---|---|
| `shared/schemas.js` | `routes` on a worker tier |
| `server/sim/staff.js` | `routesOf`, `nearestOf`, `pickNearest`, `ROUTE_SAVING_MIN`/`MAX`; the picks in `sow`, `harvest`, `serve`, `freeTill`; the tie lists in `unload` |
| `client/worker-menu.js` | one line in `tierBlurb`, said as the walk it saves |
| `scripts/verify-routes.js` | new — 38 checks |
| `package.json` | `verify:routes`, and into the `verify` chain |
| the database | a third rung on the clerk, farmhand, stocker and shop-hand |

The chef and the janitor get no such rung, and that is the honest answer rather
than an omission: `craft` picks by preference and `tidy` already takes the
nearest pad. A rung authored for them would take money and move no number.

### Still open

- **Unmeasured.** `simulate`'s bot never promotes, so every hire in a balance
  run is on rung 1 and `routes` reads 0 — the instrument is blind to this the
  same way it is blind to `packs`, `arranges` and the idle charge. What it is
  worth is a play-test, not a sweep.
- **Only 0 and 1 are authored.** The dial is real and `verify:routes` asserts
  it, but no shipped rung is lukewarm yet. A cheap middle rung on the farmhand
  is one MCP call if the jump turns out to be too big a step.

## Step 15 — the runner, and a room that is not only the kitchen's ✅

**Built.** Prompted by the question a big shop asks and a small one cannot:
every case of everything comes off ONE dock.

### What was wrong

In a small building that costs nothing. In a big one the trip from the bay to
the far aisle is paid once per **armful**, and what you watch is the whole crew
strung out across the floor in single file carrying six things each. It reads as
bad pathing. It is bad logistics.

The obvious answer — a reserve near the aisle — was not a thing the shop could
express, because a `boh` unit was *the kitchen's larder and nothing else*.
`backRoomTakes` said so, shoppers cannot see one, and the only thing in the game
that ever took stock back off one was the chef.

### What it became

A back room is now **also a reserve for the shelves near it**, and which shelves
those are is decided the way `larderRanges` decides a larder's: nearest wins
(`stockroomRanges`). That is deliberately the same trick rather than a cleverer
one — a rule you can see from across the shop ("stock ends up in the room next to
where it sells") beats an optimal assignment nobody can predict, and if you
disagree you move the room. `backRanges` is the union of the two, because one
room can be the fryer's larder AND the aisle's reserve without having to choose.

Its range is what the shelves it serves are **reserved for** as well as what they
hold, or a room could only ever back up a line that is already selling — which is
backwards, since the board wanting a reserve is the one that keeps running dry.
Ticking items onto the room itself overrules all of it, and that override needed
no new code: it lives at the two call sites that already spell it.

`ferry` is the directive. One row rather than two, for the reason `farm` is one:

- **Leg B** — a room with stock the floor is short of, moved to the floor.
- **Leg A** — a crate on the dock, shouldered whole, into the room that serves it.

The floor is asked **first**, which is the opposite of `farm`'s order and is the
whole of what stops leg A being a pile-builder: a bare board is money not being
taken, where a thin stockroom is only a walk somebody will make later.

### Three things it cost, and one that nearly shipped

**`ferryTo` had to be an errand.** `stepStaff` hands ANY shouldered crate to
`unload`, which scores a floor board perfectly legal — so without it a runner
walks to the dock, lifts the box, and carries it to the front of the shop. The
job reads as working and the rooms stay empty. Nothing is wrong on screen: the
crate got put away, and a tidy shop with empty stockrooms is what you would
expect a stockroom feature to look like before you had used it.

**`SHIFTERS` is why this took an hour.** The line that ends a half-done errand
was written `!jobs.some((j) => j.job === 'merchandise')` — which does not say
"can anybody finish this", it says "is this the one job that had errands when I
was written". So `ferry` set `s.shifting` and the very next tick wiped it, and
the runner stood holding six loaves for ever: *precisely* the bug that line
exists to prevent, caused by the line itself.

**The larder may not be raided.** An ingredient in the room that no floor board
wants stays put, or the runner walks the fryer's flour out to the shop and the
chef fetches it back, all afternoon, both of them correct.

**It cannot loop.** Leg B moves room → floor; nothing moves floor → room except
leg A, which sources crates and never shelves, and `merchandise` cannot cross the
line at all (it filters `boh === boh`). So there is no pair of verbs that can
pass a box back and forth — which is what let this ship without `rearrange`'s
hysteresis.

### What 15 touched

| File | Why |
|---|---|
| `server/sim/index.js` | `stockroomRanges`, `backRanges`; `backRoomTakes` reads the union |
| `server/sim/staff.js` | `ferry`, `SHIFTERS`, the `ferryTo` branch in `stepStaff`, `larders` → `backTakes` |
| `shared/schemas.js` | `ferry` in `JOBS` |
| `client/worker-menu.js` | the directive's row |
| `scripts/verify-ferry.js` | new — 40 checks |
| the database | the `runner` kind, three rungs |

### Still open

- **Room → room is not in it.** Two rooms can pass one crate back and forth for
  ever, which is `rearrange`'s oscillation with a longer walk, so it wants its
  own guard rather than a fourth leg bolted on.
- **Unmeasured.** `simulate`'s bot never marks a stockroom and never hires a
  runner, so a balance run is blind to all of it. It should *raise* held stock —
  that is what a reserve is — and whether that pays is a play-test.
- **Nothing routes anybody to a NAMED room on the way past.** A runner going to
  the bay walks empty-handed; carrying something outbound is a real gain and a
  genuinely harder job.

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
9. ✅ **A break area you paint** — a third kind of ground, one cell per person,
   and a shop without one plays exactly as it always did.
10. ✅ **The shop hand** — `merchandise`: clear a dead board, merge a split one.
    The first job that takes goods *off* a shelf, and the reason every other one
    could get away with pointing one way.
11. ✅ **One farm directive** — `till`, `sow` and `harvest` fold into `farm`, and
    an old list is read rather than migrated.
13. ✅ **A rung that rearranges the shop** — the sim learns where people walk,
    a spot is worth something, and a rung will move what sells to where they do.
12. ✅ **A rung that packs a crate** — `packs` on a tier, so a bay of
    part-crates is one trip instead of three. Opt-in by default, and the step
    that found `carry_mult` quietly switching hauling off.
14. ✅ **A rung that plans its round** — `routes` on a tier. The first time
    anything a worker chooses between has been chosen by how far away it is,
    and it is only ever offered candidates the job already rates equally.
15. ✅ **The runner** — `ferry`, and a back room that is a reserve for the
    shelves near it as well as the kitchen's larder. The dock stops being a
    walk every hire in a big shop has to make.

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
