# Belts — the trip nobody walks

Status: **steps 1, 2, 2b and 3 built.** Steps 4–6 proposed.

Steps 1–3 are the build. Steps 4–6 are written down so the shape is argued now
rather than discovered later, and should not be started.

What shipped: the `belt`, `arm` and `sorter` kinds, the tile they stamp, the
downstream-first tick with backpressure, the catalog rows, a `scroll` motion kind
for the slats, and `verify:belts` — 325 assertions. One thing is NOT in it and is
called out where it belongs below: the belt is placed a cell at a time rather
than dragged as a run (step 1's "laying a run").

---

## The hole

**Every case of stock in this shop is moved by a robot with legs, and the legs
are the whole cost.**

That is not a complaint about the crew — it is what the last five steps of
docs/workers.md have each been about, one at a time:

- `ferry` ([server/sim/staff.js:1850](server/sim/staff.js#L1850) is its
  neighbour, `unload`) exists because every case comes off one dock, so in a big
  building the walk to the far aisle is paid **once per armful** — eight hires in
  single file, which reads as bad pathing and is bad logistics.
- The `packs` rung exists because a bay of part-crates makes a hire leave with
  four units and walk the shop three times, looking busy the whole way.
- The `routes` rung exists because `plots.find(...)` is list order, so a farmhand
  stood on a ripe bed walks the length of the field to bed 1.
- `carry_mult` exists to make the trip carry more.
- `arranges` exists to make the trip shorter at the far end.

Five features, one sentence: *the walk is the product, and the shop has been
buying ways to make it cheaper.* What it has never been able to buy is **not
taking it**.

And the shop already knows the walk is the bottleneck, in the one place that says
so out loud. `bayRoom` collapsing is what stops the shop ordering; a full
drop-off is what leaves the crew stood about with full arms; `hasSomewhere`
gates the farm on there being anywhere for the harvest to go. All three are the
same jam, and all three clear at exactly the rate somebody can walk.

So there is a game about automating a grocery shop in which the only automation
is *hiring more people to walk*.

---

## The shape

> A belt is the walk. An arm is the hands. You buy them separately, and between
> them they are a stocker who never gets tired, never takes a charge, and costs
> money once instead of every morning in `payWages`.

That decomposition is the whole design, and it is what makes belts a *decision*
rather than a strict upgrade:

| | A hire | A belt + an arm |
|---|---|---|
| Costs | a wage, every morning | cash once, and floor space for ever |
| Goes | anywhere, including where you have not thought of yet | exactly where you laid it |
| Copes with | a shop you rearranged this afternoon | nothing you did not draw |
| Scales by | hiring, which is linear | laying more, which is also linear but paid up front |

A shop that lays belts is betting that its floor plan has stopped changing. That
is a real bet, it is the bet Factorio is made of, and this game already has the
thing that makes losing it hurt: a re-flow fires on **every wall segment of a
drag**, so a player who is still building is a player whose belts are in the
wrong place.

---

## The decision that makes this affordable: a belt carries CRATES

This is the load-bearing decision in the document, and it is the one that decides
whether this is three steps or thirty.

[docs/lanes.md](docs/lanes.md) §5 already costed belts, correctly, on the
assumption that a belt is somewhere goods live:

> A belt is a **seventh place goods can live.** `verify:orphans` enumerates the
> six that exist: a board, a crate, your hands, a shoulder, a hopper, a tray, and
> a van […] Its stated failure mode is not "the bin is wrong" but "the bin has
> never heard of shoulders".

Every word of that is right, and it is the reason belts have been deferred. The
bill it names is conservation (`removePlayer`, firing, `saveState` /
`restoreStaff`, `homeSupply`, `binOrphans`), spoilage, ordering, and the merge
rules — four subsystems, each of which fails *silently* rather than visibly.

**A belt that carries crates does not send that bill.**

A crate is already one of the six. It is an entry in `this.deliveries`
([server/sim/index.js:1341](server/sim/index.js#L1341)), it already has a
position, it already spoils, `stockCrates()`
([server/sim/index.js:10928](server/sim/index.js#L10928)) already keeps the whole
list for three readers, `homeSupply`
([server/sim/index.js:4926](server/sim/index.js#L4926)) already counts it as
supply, and `binOrphans` ([server/sim/index.js:3768](server/sim/index.js#L3768))
already sweeps it. A crate riding a belt is a crate **whose position is written
by the belt instead of by whoever put it down**.

So the seventh place is not created. There is one new field on an object that
already exists, and every loop in the sim that walks `deliveries` goes on being
right without being told anything.

It is also the better game. Crates are the unit of logistics in this shop —
`CRATE_UNITS`, `packCrate` ([server/sim/index.js:9511](server/sim/index.js#L9511)),
`wholeCrate`, `crateBoard` ([server/sim/index.js:9694](server/sim/index.js#L9694))
— so a line of boxes trundling from the dock to the back of the shelving is what
the shop's own vocabulary already says. Loose units on a belt would be a second
granularity nothing else in the building uses.

**What it costs, and it is worth saying out loud:** belt density stops being the
texture. Factorio is partly a game about items-per-second on a belt, and a crate
is a chunky, slow, countable thing. That is a genuine loss and it is bought back
by the arm and the sorter, which are where the per-second thinking goes.

---

## What is already built that this rides on

| Piece | Where | What it gives free |
|---|---|---|
| A non-blocking fixture kind | `plot`, `prop-floor` ([shared/build.js:108](shared/build.js#L108)) | The precedent for a fixture people walk over. A belt must never be `blocks: true` or a belt run is a wall through your own shop. |
| Rotation, and aim assist for it | `rotates: true`, `faceAlong` ([shared/build.js:605](shared/build.js#L605)) | Which way a belt points, the R key, and the ghost — with `rotPinned` already the off switch. |
| **Corners, for nothing** | the same field | A belt hands to whatever it faces, so an east belt feeding a north belt *is* a corner. No corner piece, no turn logic, no second kind. Bends, tees and loops all fall out. |
| A crate that already exists everywhere | `this.deliveries`, `stockCrates()`, `lotStacks` ([shared/lot.js:80](shared/lot.js#L80)) | The whole argument above. |
| One answer for goods hitting the floor | `dropGoods` ([server/sim/index.js:8180](server/sim/index.js#L8180)) | The end of a belt, and CLAUDE.md's flat instruction never to invent a second container. |
| The stocking rule, asked once | `boardFor` ([server/sim/index.js:9737](server/sim/index.js#L9737)), `pourInto` ([server/sim/index.js:9842](server/sim/index.js#L9842)), `shelfAccepts` ([server/sim/index.js:4758](server/sim/index.js#L4758)) | The arm's entire job. `homeKind === shelfKind` is already one rule in three places, and the arm is the fourth asker rather than a new rule. |
| Clutter as a cost rather than a wall | `CLUTTER` = 8 ([server/sim/pathing.js:75](server/sim/pathing.js#L75)), `clutterTiles` ([server/sim/index.js:12672](server/sim/index.js#L12672)) | What a crate standing on a belt already does to pathing — **and it is `shopper ? clutter : null` ([server/sim/pathing.js:104](server/sim/pathing.js#L104)), so a belt run annoys customers and is free to your crew.** That asymmetry is the correct one and nobody has to write it. |
| A drag that sends two ends | `groundStroke` ([shared/build.js:1313](shared/build.js#L1313)), `GROUND_STROKE_MAX` ([shared/build.js:1276](shared/build.js#L1276)), `edgeRun` | The gesture for laying a run, the 4KB cap, and the far-end rule CLAUDE.md has a scar from. |
| A verb done to many fixtures at once | `bulkFixtures` ([server/sim/index.js:10651](server/sim/index.js#L10651)), `holdReflow`, `logFold` | Re-styling, rotating or removing a whole belt run as one press, one re-flow, one line in the feed. |
| A tier ladder that is already a speed | `speed_mult`, `FIXTURE_REFUND`, `downgradeFixture` | Faster belts, faster arms, and the way back down, with no new economy. |
| A part that moves while its fixture works | `motion` in `shared/model.js`, `movingFixtures` in `addFixtureProps` | The belt surface running and the arm swinging. `motion: sweep` is *already* a pose on an authored `pivot` — it is a clock hand, and an inserter arm is the same geometry. |
| The catalog split | kinds are code, pieces are content ([shared/pieces.js](shared/pieces.js)) | Four belt designs, two arm shapes, all as content rows via `create_fixture`, with one ladder and no code. |

Genuinely new: **one field on a crate, one tick pass, and one job loop that does
not walk.**

---

## Step 1 — the belt

A `belt` row in `FIXTURES` ([shared/build.js:81](shared/build.js#L81)):

```
belt: { label: 'Belt', blocks: false, where: 'indoor', rotates: true, anchor: null }
```

`blocks: false` is not a detail. Every other fixture that carries goods stamps a
tile, and a belt run is thirty tiles — a blocking belt is a wall across your shop
that you drew without meaning to, and `canPlace`'s stranding warning would fire
on every cell of the drag.

### It is a fixture and not a `GROUND` design

The tempting version is the one docs/lanes.md sequences toward: a belt is a
painted cell with a flow direction, riding the lane overlay. It is wrong on four
counts, and the fourth is the one that decides it.

**Ground is one-to-one with `tiles`** (`groundTile` / `groundKindOfTile`,
[shared/build.js:449](shared/build.js#L449)), so a belt cell could not also be
lino — and it walks into the trap CLAUDE.md names about that function, where a
`?? null` meaning "nobody painted here" gains a new answer the day you add a row.

**Ground has no model, no tiers and no variants.** A belt wants all three: it is
a thing you buy, at a price, with a speed ladder, in whatever shape somebody
authors. That is a `fixtures` row and nothing else in this codebase is.

**Ground has no props.** The one thing a belt must do is *visibly run*, and the
moving-part pipeline hangs off `addFixtureProps` and `movingFixtures`. A painted
cell has nowhere to put a moving mesh.

**And ground holds nothing.** `layout.ground` is a sparse list of `{x, z, w, d, k}`.
There is no room in it for a crate, and giving it room is inventing the second
container CLAUDE.md forbids.

A belt is furniture that happens to be flat.

### The tick

One pass, in fixture order, **downstream first** — the last belt in a run moves
before the one feeding it, or a crate skates the whole length of the belt in a
single tick and the belt is a teleporter with an animation on it.

Each belt cell holds at most one crate. Each tick, a belt with a crate on it
offers it to whatever its facing names:

- **another belt** with no crate on it — hand it over
- **an arm's input side** — the arm takes it on the arm's own clock
- **anything else, or a belt that is full** — keep it

That last clause is the whole texture, and it is free: **backpressure.** A belt
that cannot hand on stops, the belt behind it stops, and the arm loading the run
stops because the first cell is occupied. A jammed line is a visible, diagnosable
picture — a row of boxes not moving — which is the single most Factorio thing in
this document and it costs one `if`.

**Nothing falls off the end.** A belt pointed at a wall backs up. The alternative
— spilling to `dropGoods` — is a shop that quietly buries its own floor in boxes
while looking like it is working, and it removes the one feedback signal the
player needs.

### Crates on a belt do not merge and do not stack

`dropGoods` merges a crate of the same thing within a couple of tiles and stacks
a new box on a cell when it cannot. Both are exactly wrong here: a run of belt is
a queue, and a queue whose members merge is a queue that silently destroys the
count. One crate per cell, no merge, no `crateStacked`, and the crate keeps its
own spoilage stamp untouched by the ride.

### Speed is a tier, and it must move a number

`speed_mult` on the rungs, read as ticks-per-cell. CLAUDE.md's flattest warning
applies with force: *a tier that changes no number is a button that takes money
and does nothing*, and `verify:till` exists because three constructors shipped
without a `kind` on their record, so `pieceFor` matched nothing and
`fixtureStats` answered 1/1/1. **A belt's record must carry `kind`** and the
sweep must assert the tier is read.

### The four places a new kind dies quietly

`verify:bin` already wrote these down and every one of them applies:

- `compose`'s `else` is `makeShelf` ([server/layout.js:1100](server/layout.js#L1100)),
  so a belt with no branch is not refused — it is **silently built as shelving**.
- `compose`'s budget map is literal keys against `if (!(budget[p.kind] > 0)) shed(p)`,
  so a kind with no line is dropped and refunded by the re-flow the purchase
  itself triggers. Money back, nothing stolen, and what you see is the shop
  refusing something it had just accepted.
- `FIXTURE_KINDS` ([shared/build.js:428](shared/build.js#L428)) and `budgetOf`
  must stay derived rather than listed.
- `fixtureUnitCost` ([server/sim/index.js:11082](server/sim/index.js#L11082)) —
  price off the catalog row, never a fallback.

### Laying a run

A drag, the way a wall is drawn, capped like `GROUND_STROKE_MAX`, sending **the
pointer's far end** and never the tail of the computed list. CLAUDE.md's scar:
`edgeRun` emits lowest-index-first whichever way you dragged, so reading the far
end back off `segs[segs.length - 1]` builds a run of exactly one for every drag
towards a lower x or z — eight cells of green ghost and one belt, with no refusal
and nothing in the log, and *the screen direction that fails changes as you turn
the camera*, so it reads as flaky rather than as directional.

The drag also sets the facing: the direction of the drag **is** the direction of
the belt, which is the one gesture in the game where that is unambiguous, and it
is why belts want a drag rather than `faceAlong`.

At the end of step 1 you can lay a loop of belt and watch a crate go round it.
Nothing loads it and nothing takes off it. That is deliberately playable on its
own — it is the step where you find out whether crates-on-belts feels right
before anything depends on it.

---

## Step 2 — the arm

```
arm: { label: 'Arm', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt' }
```

Blocking, because it is a machine and it should cost you the cell. `useAt` so
you can still reach it to empty it by hand when it jams.

**A loader is a belt cell that also talks to what is beside it.** It stands *in*
the run, not next to it.

That is the third shape and the first right one, and the two it replaced are
worth recording because both were arrived at honestly:

1. **Aimed** — takes from behind, gives in front. Lasted an hour of play. A belt
   is a dark rectangle and a machine is a box, so one turned a quarter wrong is
   indistinguishable from one that is working, and the shop just does nothing.
2. **Beside the belt, any side** — works out its own source and sink from the
   belt's direction. Correct, and it cost twice the floor: stocking one row of
   shelving needed a lane of belt *and* a parallel lane of machines, with a
   geometry puzzle at every unit.

Inline, a run is **one row**. Crates flow along it and each loader drops off
whatever the shelf beside it will take; what that unit will not take stays in the
box and rides on to the next one. An aisle is a belt with loaders in it.

So a loader is structurally a belt — non-blocking, stamps `T.BELT`, has a facing,
hands on to whatever it faces, and `beltAt` answers for both — and does two extra
things per swing:

| | |
|---|---|
| **Unload sideways** | pour into any adjacent unit of shelving, through `pourInto` |
| **Pick up** | if empty, lift a crate off the floor beside it |

That second one is what gets goods out of the yard without a second kind of
machine, and it is why there is no separate "loader" and "unloader".

Its own facing decides only where a crate goes **next**. It unloads to all four
neighbours regardless, which is why the art has no direction in it — see the
turntable, and the three attempts before it.

### It must not become the 14th spelling of the kind rule

`holds(kind, item)` exists at [shared/tags.js:306](shared/tags.js#L306), is
documented as everybody's rule, and is currently called by **one test and nothing
else** — every one of the thirteen production sites writes
`homeKind(x) === shelfKind(y)` out by hand. That is the exact failure `verify:hot`
was written for, already halfway back. The arm calls `pourInto`, which asks
`boardFor`, which asks the rule once. It adds no spelling of its own.

### Probe pure, commit through the funnel

`boardFor` is **not a predicate** — it calls `openStack`, which pushes a real,
priced, zero-qty board onto `shelf.stacks`. Four job sites already use it as a
yes/no and throw the answer away, and each of those probes consumes a board slot
and divides `shelfCapacity` for everything else on the unit until the next day
roll. An arm ticking many times a minute would do that continuously.

So: **probe with `shelfAccepts`
([server/sim/index.js:4758](server/sim/index.js#L4758)), commit with `pourInto`.**
That pair is the whole of the arm's stocking code, and it is the same rule a hire
obeys at the moment of the press, by construction rather than by agreement.

### It has a clock, and the clock is the throughput

Ticks per swing, off `speed_mult`. This is where the items-per-second thinking
that crates took away comes back: a belt delivers boxes and an arm empties them
at a rate, so a shelf fed by one slow arm is a bottleneck you can see, standing
next to a belt that has backed up behind it. Buy a faster arm or buy a second
one — which is a ratio, arrived at by looking.

### What it does when it cannot

The same thing the belt does: nothing, and visibly. A crate whose contents no
board will take sits on the belt in front of a stationary arm. **It must never
divert, never spill, and never pick a different shelf** — an arm that quietly
finds somewhere else to put things is the spread bug with no hire to blame, and
CLAUDE.md's `homeFull` note is the record of how that one goes.

At the end of step 2 a belt run from the bay to an arm at the end of an aisle
stocks a shelf with nobody walking. That is the feature. Steps 1 and 3 are
scaffolding around this one.

### Step 2b — who is allowed to put something ON one

Steps 1 and 2 built a conveyor that nothing could load except a loader with a
crate lying next to it. Three things were missing, and all three are the same
sentence: **a belt is only worth laying if the things that move goods know it is
there.**

**You.** A conveyor cell is a square, and a square is somewhere goods go down —
so `dropCarry` and `dropCrate` both post onto one, at the same reach, with the
same green square and the same ring. `beltPut` is the verb rather than
`dropGoods`, for `dropGoods`' own `!d.belt` reason turned around: it merges with
a box within a couple of tiles and stacks a second one on the cell when it
cannot, and a run of belt is a QUEUE. One crate per cell. What that costs is the
one place in the game where a square that already has a crate on it is a
**refusal** — so `canDropAt` has to rule it out too, or the ghost is green over a
press the server turns down.

**The crew, positively.** `unload`'s haul branch asks `beltFor` before it asks
`shelvesFor`, and it is deliberately not a comparison of the two walks: the point
is not that the belt is nearer, it is that the rest of the journey costs nothing.
`wholeCrate` gains the same clause, because every one of its size tests weighs
two JOURNEYS against each other — "at or under an armful the box is pure
ceremony" is true of two walks and false the moment one of them is a belt. Leave
it out and the branch is unreachable for exactly the shop that laid a conveyor to
fix it: a bay of part-crates, with the crew making armful trips down an aisle
that has a belt running along it.

**The crew, negatively — and this is the one that would have broken it.**
`stockCrates` keeps the whole list on purpose (`homeSupply` counts a riding box
as supply, `binOrphans` sweeps it, spoilage ages it) and a hire is the one reader
for which that is wrong: a box off a pad scores as a **stray**, which is a 1e6
bonus in `unload`'s own ranking. Unfiltered, every stocker in the shop abandons
the bay and beelines for whatever is going past — the conveyor works perfectly
and is emptied by the crew it exists to replace. `floorCrates()` is the one
spelling, and the five job sites that LIFT ask it.

And one thing that was simply wrong: a loader poured into the first side that
took something and stopped. `rot` is the side it asks *first*, so the shape it
was drawing was "one shelf fills, its neighbour stays bare with a loader touching
it" — which reads as the loader being aimed wrong. A swing now serves every side
it can, and the art draws a shaft per side rather than per loader.

### …and loops, which is what people actually build

Two bugs came out of the first real ring somebody laid, and both draw identically
to a working belt.

**Flow had to stop being a per-cell question.** A loader's `rot` is the shelf, so
its output is derived — and it cannot be derived one cell at a time, because its
neighbours may be loaders whose answers are also derived. Refusing to ask them
(steps 1–2) is right for a loader with a belt on either side and wrong for a run
made of loaders, which is what an aisle becomes: nobody has a feeder, nobody
carries straight on, and the run bends wherever rotation order points. Asking
recursively is worse — "unknown" reads as "open", so a straight run resolves
backwards from the far end and the two halves meet in the middle. `conveyorFlow`
resolves the whole layout at once by walking FORWARD from the plain belts, which
are the cells that know their own direction. The rule that falls out and is worth
saying to a player: **belts on the corners, loaders down the straights.**

**A jammed box must drop its charge rather than hold it.** Holding it at the brim
means the box moves again the tick the way clears — and since the *travel* is
drawn on the cell you land on, a crate blocked every time it lands never plays
one. Three crates on a loop, one smooth. A cleared jam costs one cell-time per
box now, which is what a conveyor draining looks like.

### What `rot` means on a loader now: three answers, decided by what is there

Flow is derived, so for two steps `rot` was only "the shelf it tries first" and a
loader had no aimable output at all. It has three meanings now, and which one
applies is read off the tile it faces rather than chosen:

| It faces | It does |
|---|---|
| shelving | stocks that unit first, and every other side after it; flow stays derived |
| **a conveyor** | that IS its output — it feeds that line rather than joining its flow |
| bare ground | sets down there whatever no unit took (below) |

The middle row is the one that was missing. A loader taking goods off a shelf and
injecting into a loop running past it is an ordinary thing to build and no
rotation would do it. It is never allowed onto its own feeder — a belt already
resolved as pointing at the loader is skipped — because that pair is a two-cell
tug of war, which is a run that dead-ends in the middle of itself and draws
exactly like a working one.

### The off-ramp, which is the one thing `rot` decides on its own

A belt had exactly one exit: a board that will take the goods. So a crate holding
anything no unit on the run wants rides for ever — round a loop, or parked at a
dead end where nothing can reach it, since the crew are told to leave a riding
box alone. Three frozen pizzas on a run with no freezer on it is a permanent
passenger, and the shop looks like it is working the whole time.

A loader that **faces bare ground sets the rest of the box down on it**, through
`dropGoods` like every other setdown in the game. Aim it at shelving and it
stocks; aim it at a floor tile, a pad or a stockroom and it unloads there. That
is also the answer to "I do not get to control the loader" — every other side of
it is derived, and this is the one that is yours.

Three things keep it from being a shop that buries its own floor. It is reached
**only after every unit beside it has had its share**, so a loader bolted to a
shelf never prefers the ground. The mat **stacks to `ARM_DROP_STACK`** (3) and
then stops, which is the same backpressure the run has — uncapped it is a tower
for the rest of the save, and a mat of one is a stockroom that holds a single
box. And the pickup side **skips the faced tile**: three sides in, one side out,
or the off-ramp is a loop that sets a box down and lifts it straight back up.

### …and a pad is consent, which is why the box must not TELEPORT

A pad outranks the faced tile — painted ground that means *goods go here* is
permission already given, so aiming a loader at your own yard is asking for it
twice. What that inherited from `stow` is the pad as a **region**, and there the
two callers part company. You walked to the pad, so the pad is where you are; a
machine is at one cell. A pad has never had to be one shape — the brush paints
cells — so a lone storage square painted at the end of an aisle is the same named
region as the yard by the back door, and `dropGoods` fills a region *by list
order*. A live shop had a loader set a box down beside its fridges and the box
appear thirty tiles away at the bay, merged into an unrelated crate.

That is not a slow delivery or a wrong shelf. It is a crate crossing the shop
instantly, and **it reads as goods having been destroyed**, because the place you
were watching is empty afterwards and nothing anywhere says otherwise. The
report it arrives as is "the crate disappeared".

`padIsland` is the fix: the cells reachable from the touched one by ordinary
four-way adjacency. Two things about it. It is **four-way and not eight**,
because two cells touching at a corner are two places to everything else in this
game that walks. And the same island bounds the **`byArm` mark** — the guard that
stops a loader lifting back what it just set down. Marked over the whole region
that guard is switched-off for the loader that needs it most: a bay is where the
crates already are, so a loader bolted to one would refuse every delivery the
shop ever takes. It marks the boxes the drop **landed in**, which is the only
thing it was ever about.

Not done, and it is the obvious next thing: **the shop does not yet buy or pack
FOR a line.** `restock` and `pickItem` know nothing about conveyors, so the
ordering fills a belt-served shelf exactly as it fills any other, and `packCrate`
builds boxes by what is on the pad rather than by what is down the run. That is
where step 3's pure-crate rule earns its keep, and it should be built with the
sorter rather than before it.

---

## Step 3 — the sorter, and it sorts by DESTINATION

**Built, and not the way this section proposed.** The argument below is kept
because the trap it names is still live; what changed is the filter.

A belt with two outputs: straight on, derived from the run exactly as a loader's
is, and a BRANCH, which is its `rot` — the same inversion `arm` made and for the
same reason. A sorter's straight-on is the boring half; the side you want it to
divert down is the half you have an opinion about, so that is the one R sets.

### There is no filter, and that is the change

The proposal was a tag on the fixture: `frozen` down one branch, `produce` down
the other. Authorable, predictable — and a thing you have to *maintain*. Every
item you add is a filter you have to remember to widen, and a filter that has
fallen behind your catalogue is a line that has quietly stopped carrying half
your stock, which looks exactly like a line that is working.

The run already knows what is down it (`conveyorServes`, which walks both ways
out of every junction it meets) and the shop already has one rule for whether a
unit will take something (`shelfAccepts`). A sorter asks those two. It is right
about an item authored this afternoon, there is nothing to keep up to date, and
it adds no fourteenth spelling of the kind rule.

### …and with no answer it SPLITS, which is the other piece people wanted

Both sides would take it, neither would, or the box is mixed — then it alternates.
That is a splitter, it balances two lines, and it is the same piece. `auto: false`
pins it there: a junction you have switched the thinking off on is still a
junction, and "does nothing" would be the wrong thing for it to become.

…and the split is between the lines that **want** it, not across the junction at
large. That distinction does not exist at a two-way sorter, which is why it took
a real shop to find: with three ways out, one of them is an exit that serves
nothing — a spur to the yard, a line still being built, a column with no loader
on it yet — and such a line is never keen, so it can never win the single-keen
test and used to draw its full share of the alternation regardless. Measured at
**4 boxes in 12** down a dead line in a junction with two good ones. Every box
that arrived was correct, so what it reads as is a sorter that works
intermittently, which cannot be told from one that is guessing — and it gets
worse the more of the shop you automate, because each line you add is another
slot for goods that had somewhere to be. Nothing keen still splits across
everything: a box no line wants has no better claim on one exit than another.

### Which half of its job a loader does

One machine that both lifts and pours is why there is no separate loader and
unloader in this game, and it is what makes a run work with nothing configured.
What it cannot do is stand between a pad and a line. `armDrop` prefers painted
ground over everything — consent already given, said once, about that square — so
a loader with a yard on one side and no shelving beside it lifts a box off that
yard and puts it straight back on it. The run it was bought to feed never gets
anything, and every frame of it is a machine doing its job.

`mode` is `both` on every loader ever built. `load` is a belt cell that also
lifts — it never pours, never off-ramps and never bins, so the only way off it is
the run. `unload` is the mirror, and it is what stops a stockroom or a pad beside
a line swallowing everything going past.

The pair is deliberately not one boolean. "Does it lift" and "does it put down"
are two questions, and a shop wants each of them answered alone: the loader on
the yard is `load`, the loader at the end of an aisle is `unload`, and the one in
the middle of a run beside two chillers is `both`.

### …and the line for what nothing wants

Splitting a stray across every way out scatters it, and each share then rides to
the end of a line that was never going to take it. Almost every real junction has
a way out that is not a destination — the spur back to the yard, the loop past
the skip, the column that has not grown a loader yet — and the sentence the
player wants is *if nobody wants it, send it that way.* There was nowhere to say
it.

`reject` is a quarter turn on the sorter, `null` on every one ever built. Four
things about it. It is a **turn and not a cell**, for `rot`'s own reason: the run
next door is rebuilt and re-minted on every re-flow, so a stored neighbour goes
stale the first time you extend the line. It fires **only when nothing is keen** —
a reject line that could outrank a line which *will* take the goods is not a
reject line, it is a leak, and it is `homeFull`'s spread bug with a switch on it.
The reject side is **excluded from wanting things**, or a spur that happens to
pass a shelf quietly becomes an ordinary destination and takes its share of the
sorting. And it is skipped when **jammed**, or one stuck box downstream stops the
junction dead.

It is a **separate field from `rot`** because they are opposite questions: `rot`
is the branch you aimed at, a preference among the lines that do want things, and
the line you want strays down is very often the one you did not aim at. The menu
says "the way it points" rather than naming a compass side, because the junction
is aimed and you are looking at it.

### …and a reject side is a PLACE, not only a line

A reject line was a line, and for a while that was the whole of what it could be.
Both the branch test and the reject test ask `beltAt`, so a junction aimed at a
pad or at bare floor had a side the piece **could not see at all** — not refused
and not warned, invisible. The press was accepted, the field was stored, and the
box went down the trunk anyway. Nothing anywhere disagreed with the player.

That is the shape this file keeps recording, and it is worse here than most,
because the sentence somebody is trying to say is one the junction **has already
worked out**: `keenAny` is exactly *does anything down any of these lines want
this box*. It computed the right answer twenty times a second and then had
nowhere to put the box. A real shop's junction sits next to the yard far more
often than it sits next to a spare spur.

So `sorterEject` is the other half of `reject`: a conveyor on that side hands on
as it always did, and a **pad or walkable floor** takes the box off the run
through `armDrop` — the loader's own off-ramp, already island-aware, already
capped at `ARM_DROP_STACK`, already marking `byArm`. Four things about it.

**A loader cannot stand in for this, and that is the whole argument for putting
it on the sorter.** A loader offers the box to whatever is beside *it* and
off-ramps the remainder, so it has no way to ask what is further down the run.
One stood on a junction with no shelving next to it dumps *every* box that
passes and the line dies. Only the piece that chooses between lines can know that
nobody wanted it.

**The keen test is `sorterOut`'s own**, extracted to `sorterWants` rather than
copied. A junction that chose a line by one rule and ejected by another would
eject boxes it had just decided somebody wanted — the same drift CLAUDE.md
records between the shop's rule and the hand's.

**It asks every way out, not the clear ones**, which is the one place this parts
company with the reject *line* above. A jam is a reason to wait and `stepBelts`
already waits; a drop is a hire's walk to undo. Ejecting stock because an aisle
was briefly busy hands the automation quietly back to the crew.

**A full pad carries on down the line** rather than jamming the junction, which
is the same call the reject line makes about a spur that has backed up. And the
ejection is **charged a cell-time**, or the box vanishes the tick it lands while
every other box on the run glides — the jam-at-the-brim bug wearing an off-ramp.

The alternation is a counter rather than a draw, because every balance number in
this game is downstream of how many times `this.rng` has been called. And the
decision is made **once, when the box arrives**, and remembered until it leaves:
`sorterOut` is asked every tick — the backpressure test needs to know which cell
to look at — so an answer recomputed each time would flip twenty times a second
and the box would leave by whichever side the tick it was ready happened to land
on, which is a coin toss wearing a rule.

### The pure-crate rule survives intact

It only ever diverts a crate **every pile of which** wants the branch.

The problem a crate brings, and it has to be answered rather than avoided: **a
crate holds several piles.** A box of carrots and eggs has no correct
direction.

Three answers, and only one of them survives:

- **Sort on `lotMain`** — the biggest pile. This is precisely the mistake
  CLAUDE.md records about the chevrons: `takers` took `lotMain` and hands holding
  bread and ice cream lit the shelves for the bread and no freezer at all. A rule
  that answers for one pile and acts on all of them is the green-ghost bug wearing
  a filter.
- **Split the crate** — take the matching piles out into a new box. Expensive,
  creates crates on a hot path, and doubles the number of boxes on your belts,
  which is a jam rather than a feature.
- **Divert only a crate whose every pile matches.** Predictable, splits nothing,
  and answerable by looking at the box.

The third, and the sentence to put on the fixture: **a sorter only diverts a pure
crate; a mixed one goes straight on.**

That is not a limitation dressed up. It makes the `packs` rung — which builds
single-kind crates out of a bay of part ones — into the thing you buy *so that
your sorters work*, which is a dependency between two features that were designed
years apart and a genuinely Factorio-shaped one: you need a purity step upstream
before sorting means anything.

### `verify:belts`

Everything in steps 1–3 is invisible in a still frame by construction — a crate
that rode a belt and a crate a hire carried are the same box on the same shelf,
and the shop is the same shop afterwards either way. Only the wage bill moved. So
this ships **with** the feature, the way `verify:doors`, `verify:park`,
`verify:price` and `verify:routes` did.

- **A shop with no belts is the old game to the cent.** The control that decides
  whether any of this is opt-in. Paths, takings and stock bit-identical across
  generated layouts.
- **Conservation, at all three hops.** Nothing created or destroyed belt-to-belt,
  through an arm, or across a sorter. Every new place goods can move between in
  this game has been a hole.
- **A spoilage stamp survives every hop.** `verify:pack`'s centrepiece pointed at
  a belt: a merge keeps the *destination's* stamp, and a kind arriving as a bare
  `{item_id, qty}` with no stamp is read as fresh for ever
  ([shared/lot.js:155](shared/lot.js#L155)). Either one makes a belt the way to
  beat rot, and a crate of laundered flour looks exactly like a crate of flour.
  Read through `lotStacks`, write through `.stacks`.
- **Backpressure.** A run pointed at a wall backs up and *stops*; it does not
  spill, duplicate, or drop the last crate. The downstream-first ordering is
  asserted directly, or a crate crosses the shop in one tick.
- **A belt is clutter, not a wall.** A hire can still reach the break area across
  a belt run, however badly it is drawn. This is `verify:break`'s `TIRED_PACE`
  pin arriving through a new door, which is the third time that has happened.
- **An arm obeys the shop's rule, not its own.** The nine-way `STOCK_KINDS`
  matrix walked at an arm rather than at a hire — the fourth asker giving the same
  answers as the other three.
- **An arm never feeds a given-up board**, asserted against a control board the
  shop has not given up on. This is the one judgement rule it takes and the
  assertion is what stops it being `merchandise`'s round trip with no hire in it.
- **…and it is exempt from the other three**, which is the other half of the same
  claim and is otherwise unprovable: an arm bolted to a unit that is not the
  item's `homeShelves` home, and to one with `managed: false`, must still fill
  both. Written as a value each way, because "obeys everything" passes every
  assertion above it.
- **A thousand idle ticks open no boards.** `boardFor` mutates — it calls
  `openStack`, which pushes a real priced board — so an arm that probed with it
  would consume a board slot per tick and quietly divide `shelfCapacity` for
  everything else on the unit. Tick an arm against a shelf it can never fill and
  assert `shelf.stacks` is byte-identical afterwards.
- **A sorter diverts a pure crate and passes a mixed one**, asserted against a
  mixed control, because nearly every way of getting a filter wrong moves too
  much rather than too little.
- **A load-only loader never puts a box back on the pad it lifted from**, with
  `both` as the control doing exactly that round trip — the switch has to change
  something or it is a change to every save instead. Paired with the mirror: an
  unload-only one lifts nothing. Plus survival across a re-flow AND across a
  ROTATION, which is the press that actually happens: `repositionFixture` builds
  a fresh placement naming each field it keeps, so a setting left out is not
  un-copied but RESET, by the re-flow that same call triggers. Aiming a loader
  at the line you want handed the machine its pickup back at the exact moment
  you were setting it up. Asserted of a sorter's `auto` too, which had the hole
  from the day it shipped. And that the version MOVES on a mode change: the
  chevrons and chutes it decides live in `staticRoot`, which the client rebuilds
  only when that number changes, so without a bump the switch works in the sim
  while the picture keeps showing the old one — a switch that looks like it did
  nothing, which is worse than one that does nothing.
- **A reject line takes only what nothing wants**, against the control that
  every sorter is built without one. Paired with the claim that costs a shop: a
  box a line WOULD have shelved is never rejected — "sends strays away" passes
  on a sorter that sends everything away. Plus that it survives a re-flow, since
  build mode re-flows on every wall segment of a drag.
- **…and a reject side that is GROUND takes the box off the run**, which is the
  half that was invisible rather than wrong: aimed at a pad or bare floor, the
  press was accepted and nothing happened. Its control is the same one — a
  sorter with no reject never ejects anything, however unwanted — and its leak
  case is the same too, because an ejector that fires whenever it is asked
  passes "strays come off" while quietly emptying the run onto the floor. Plus
  that a conveyor on that side still HANDS ON rather than setting down (two
  crates on one cell otherwise), conservation across the ejection, and survival
  of a re-flow. What it cannot assert is the thing that makes it belong on the
  sorter at all: a loader in the same square dumps everything, because it can
  only ask what is beside it.
- **A split goes to the lines that want it**, asserted at a junction with THREE
  ways out — the claim does not exist below three, which is why two-way coverage
  never caught it. Paired with "both good lines are still shared", or narrowing
  the pool to one winner passes the first half while turning the splitter off.
- **An off-ramped box lands on the pad cell the loader is TOUCHING.** Written as
  a pair and worthless split in half: it has to arrive on the near island *and*
  nothing may turn up on the far one, because a sweep that only counted
  crates-on-the-pad is satisfied by the teleport. The one assertion in this file
  written to a bug reported from a screenshot — "see that crate? it disappeared."
- **A re-flow does not restart a belt.** `verify:park`'s claim about the car:
  building re-flows on every wall segment, so a crate that began its ride again
  each time never arrives. A crate mid-belt is *parked*, not reset.
- **`homeSupply` counts a crate on a belt.** Or the shop buys a second van-load
  of what is already thirty seconds from the shelf — which presents as the
  ordering being broken, days downstream of laying a belt.
- **Ids do not collide.** `fx-N` against the generator's namespace, or a re-flow
  hands a belt somebody else's crate.

---

## Steps 4–6 — written down, not built

**Step 4 — machine feeds machine.** Recipes already exist; an arm on each end of
a belt closes the loop between a tray and the next hopper. What falls out for
free is **ratios**: two mixers per oven, because the batch times say so, with no
new mechanic at all. This is the highest value-per-line item in the document and
it is step 4 rather than step 1 because it is entirely a consequence of steps 1–3.

**Step 5 — a throughput overlay.** Factorio players live in the production
graphs. [client/report.js](client/report.js) is already "the one menu that is a
picture rather than a list", and `spotScore`'s footfall map is already a
per-tile measurement drawn over the shop. Crates-per-minute per run, with the
jammed cell lit — cheap, and it is where the satisfaction of a working line
actually lands.

**Step 6 — power.** A shop-wide meter, a generator you buy, and a brownout when
you overbuild. It is the most Factorio thing on this list and it is last because
it **re-prices every appliance in the game**: every balance figure in the repo is
a `relaxed` figure already, and this would invalidate the rest. A real `simulate`
project, not an afternoon.

---

## What was deliberately not done

- **Loose units on a belt.** The whole argument above. It buys belt density —
  genuinely the texture of the genre — and it costs the seventh place goods can
  live, which is four subsystems that each fail silently. Revisit only if
  crates-on-belts is played and feels wrong.
- **A belt as painted ground.** docs/lanes.md's sequencing. Rejected on four
  counts in step 1, of which "ground holds nothing" is decisive.
- **A corner piece.** There isn't one and there must not be. A belt hands to what
  it faces; a corner is two belts. Authoring a corner kind would mean the sim has
  two ideas of which way a belt points, and one of them would be wrong at every
  bend.
- **Logistics drones.** Factorio's answer, and it is taken: **the staff are the
  robots.** That is the identity of the whole game, and a drone network is the
  thing that makes the cast pointless rather than the thing that makes them
  redundant.
- **Trains.** The van already drives a lane, backs onto the dock and has authored
  content behind it (docs/deliveries.md). A bigger rig is a `vehicles` row, not a
  mechanic.
- **A belt that moves people.** Factorio belts carry you along. Charming, and it
  puts a second writer on the player's position, which is the one field in the
  game that three systems already argue over.

---

## Open questions

- **Does an arm show up in `simulate`?** Probably not, and that matters. The
  balance bot never runs an appliance, so "no change" from the kitchen half of
  anything is *the instrument being blind*, not the change being free. If the bot
  never lays a belt then belts are unmeasurable by sweep and the honest answer is
  to play them — which memory says is the preference here anyway.
- **What does a belt do to the wage bill in practice?** The pitch is that it
  replaces a hire. If it does not, it is an expensive decoration; if it replaces
  two, the crew stop mattering. This is the one number that decides whether the
  feature is good, and nothing but playing it will say.
- **Can a belt go outdoors?** The farm is the obvious second customer — beds to
  the shop is a long walk that never changes shape, which is the ideal belt. But
  it makes a belt weatherless furniture standing on grass, and it wants a rule
  about the border ring. Probably yes, probably not in step 1.
- **Should a crate on a belt be pickable?** `pickPallet` picks a pile apart by
  height and `liftCrate` no longer refuses a buried one. A box going past on a
  belt is a moving target, which is the one thing the pointer has never had to
  hit. Leaning: yes, and the belt cell stops while you have it aimed.
- **Does the tutorial need a rung?** docs/tutorial.md is a predicate over the
  snapshot. "You laid a belt" is a trivially cheap one and this is the most
  confusing thing in the game to meet cold.

---

## Build order

1. **The belt.** The kind, the drag, the downstream-first tick, backpressure, the
   four quiet-death branches, and the crate's one new field. At the end of this
   you can lay a loop and watch a box go round it. **Play this before step 2** —
   it is the step where crates-on-belts is either right or is not.
2. **The arm.** The take-from-behind/give-in-front rule, `pourInto` at the far
   end, and — the actual work — the four hire rules it must borrow rather than
   reimplement. At the end of this the shop stocks a shelf with nobody walking.
3. **The sorter**, the pure-crate rule, and the drag. `verify:belts` already
   covers steps 1–2 and grows two sections rather than being written fresh.

Steps 4–6 are not started.

Done as of step 2: `docs/belts.md` has its row in CLAUDE.md's doc table and
`verify:belts` has its paragraph in the sweep list — the sweep is the only thing
that will ever say whether any of this is still true.

### What laying one is like today, and why that is step 3's problem

A belt is placed **one cell at a time**, off the palette, like a shelf. A run
across a shop is therefore twenty presses, and every one of them re-flows. That
is not a design decision, it is step 3 not being done yet: `groundStroke` and
`edgeRun` already carry the drag, the cap and the two-ends-on-the-wire rule, and
the direction of the drag is the direction of the belt, which is the one gesture
in the game where a facing is unambiguous.

It is worth knowing before playing it, because twenty presses is exactly the
thing that will make somebody conclude belts are tedious rather than unfinished.

---

## Its relationship to docs/lanes.md

They overlap and neither blocks the other, which is worth stating because
lanes.md §5 currently reads as though belts are downstream of it.

lanes.md sequences belts **after** its direction-for-feet layer, on the argument
that a belt should arrive as *"a cell whose flow moves goods as well as people"*
rather than as a subsystem with its own idea of which way is east. That argument
is good and it is answered rather than ignored: a belt here is a **fixture**, and
a fixture's facing is `rot4` — the same one spelling of a quarter turn that
lanes.md wants everything to share. There is no second convention either way.

What lanes.md is right about, and this document takes as a debt: its costing of
belts is correct for the design it assumes, and the only reason it does not apply
is the crate decision. If crates-on-belts is played and rejected, **lanes.md's
sequencing is the correct one** and this document should be re-opened rather than
patched.

The two features want each other and neither needs the other first. A service
corridor with a belt down it is the shop this game has been describing since
`ferry` shipped — and lanes.md step 3, *stock from the rear*, is where an arm
most obviously wants to stand.
