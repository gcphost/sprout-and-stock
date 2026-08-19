# Seating — somewhere to stop

Status: **all proposed.** Nothing here is built.

---

## The hole

A shopper does six things and then they are gone: `ENTER`, `BROWSE`, `WALK`,
`TAKE`, `TO_TILL`, `QUEUE` — and `leaveShop`
([server/sim/index.js:12781](server/sim/index.js#L12781)) sets `LEAVE` the
moment they have paid. There is no state in that list for *being in the shop
without shopping*, which means the shop has no way to make anybody stay and no
reason to want them to.

Three things fall out of that, and the third is the one that actually hurts.

**Lingering is only rewarded when the shop is bad at its job.** `impulsePull` is
the one mechanic in the game that pays for somebody hanging about, and it fires
exactly once, at the till, within `IMPULSE_RADIUS` of 2.6 tiles
([server/sim/index.js:569](server/sim/index.js#L569)) — scaled by `dwell`, which
is *how many people are ahead of you in the queue*
([server/sim/index.js:12489](server/sim/index.js#L12489)). So the display by the
checkout earns its keep in proportion to how long the line is. A shop that
serves people promptly has no impulse channel at all.

**Crowding is the one annoyance you cannot serve your way out of.**
`ANNOY_CROWD` is 1.2 per whole multiple of capacity over `CROWD_FROM`
([server/sim/index.js:413](server/sim/index.js#L413)), and above `TURN_AWAY_AT`
of 1.35 the spawner refuses the arrival at the door, books
`stats.turnedAway++` and takes reputation off you
([server/sim/index.js:11380](server/sim/index.js#L11380)). A second till does
nothing about it. `shopCapacity` counts units with something on them
([server/sim/index.js:11046](server/sim/index.js#L11046)), so the only answers
the game offers are a bigger building or more shelves — both of which invite
more people into the crush you were trying to relieve.

**And thirty-one decorations do exactly one thing.** Every piece in the
Decoration bar adds to `charm`, which saturates at `CHARM_MAX` 8
(`charmReach`, [server/sim/index.js:12744](server/sim/index.js#L12744)). A
chandelier and a park bench differ by price and by a number on one axis.
Nothing you can build is something a customer *does* anything with — and since
the furniture went in, that is a promise the game visibly does not keep. A
bench nobody sits on reads as a bug in a way a lamp post never did.

---

## The shape

**A seating area is the break area pointed at customers.** Painted ground, one
cell seats one person, and how big you paint it is how many it holds — the
yard's promise said about people, which is exactly what `GROUND.break`
([shared/build.js:212](shared/build.js#L212)) already is for staff.

One sentence carries the balance of it:

> A seat trades selling time for patience, and where you put it decides whether
> you get the time back.

Sitting is a **rest**, so it does what a rest does: it puts patience back. That
makes it the first answer the shop has ever had to crowding that is not "build a
bigger shop". The cost is real and is what stops the answer being "pave the
floor in benches" — somebody sitting is not browsing, not queueing and not
buying, so a shop that seats everybody sells less per customer-minute.

And the reward for placing it well is impulse. A seated shopper is the first
thing in the game that **dwells**, so a bench within `IMPULSE_RADIUS` of a
stocked board is a display and the same bench in a bare corner is a bench. That
is deliberately the same shape the break area turned out to have — measured at
+47 mean profit beside the door and +12 in the far corner, where you put it
being most of what it is worth, and that falling out of the walk rather than out
of a rule.

It is a sibling of docs/pickups.md rather than a rival: both answer the crush,
and they answer it in opposite directions. A collection point routes people
*around* the shop floor; seating makes the shop floor survivable. A shop can
sensibly own both, and a shop that owns neither is the game as it is today.

---

## What is already built that this rides on

Almost all of it, which is the argument for doing it at all.

| Piece | Where | What it gives free |
|---|---|---|
| A pad that holds people | `GROUND.break` ([shared/build.js:212](shared/build.js#L212)) | The whole "painted ground carrying a job" apparatus: `pad: true`, a `does` sentence, a `lastGone` warning, `PAD_KINDS` ([shared/build.js:379](shared/build.js#L379)). A second one is a row. |
| Seat claiming | `seatIn` ([server/sim/staff.js:976](server/sim/staff.js#L976)) | One cell one person, other claimants excluded, a held claim honoured without re-routing, and a seat painted over while somebody walked to it given up rather than stranded. Every one of those is a bug already found and already fixed. |
| Reachability | `reaches` ([server/sim/staff.js:1003](server/sim/staff.js#L1003)) | `findPath` on the seat search, which is what stops a walled-off room pinning people against it forever. |
| An activity with a clock | `PastimeSchema` ([shared/schemas.js:867](shared/schemas.js#L867)) | `seconds`, `restores`, `buys`, `weight`, `tags`, and a staged prop driven by how far through it they are. Authored content, already validated, already rendered. |
| Cells of a pad, counted | `padRoom` / `dropPad` ([server/sim/index.js:6656](server/sim/index.js#L6656)) | "How big you painted it is how much it holds", including the trap that a stale occupant makes the count lie. |
| Dwelling, priced | `IMPULSE_RADIUS`, `IMPULSE_BASE`, `impulsePull` ([server/sim/index.js:569](server/sim/index.js#L569)) | An impulse roll that already takes a dwell multiplier. Seating supplies the only honest one. |
| Something to hold | `kit` in the snapshot ([server/sim/index.js:2140](server/sim/index.js#L2140)) | Shoppers already have a wire slot for "what they are carrying it in", drawn instead of the armful. A cup is that slot. |
| Ground that refuses the border | `canPaintGround` ([shared/build.js:1419](shared/build.js#L1419)) | Row 0 and column 0 are not yours, which a seating pad wants for the same reason the car park does. |

What is genuinely new is **one customer state and one predicate decision**. That
is the whole of it.

---

## Step 1 — the seating area

A `GROUND` row (`seating`), a tile (`T.SEAT`), an overlay list (`L.seating`),
and a `REST` state in `stepCustomer`.

### It is a pad, not a kind

The bench is not the seat. The **cell** is the seat, and the furniture is what
you stand on it — exactly as the break area is the room and the mugs are the
mugs.

That is not laziness, it is the cheaper half of a decision already costed. A
seat kind with an `anchor` would mean a `BUILD_KINDS` entry, and `anchor` is
*"the tile you have to be able to stand on to use it"* — so the generator would
reserve a spot per bench, flood it for reachability, and `canPlace` would grow a
branch. Worse, `compose`'s budget map is one of the four places a new kind dies
quietly: its `else` is `makeShelf`, so a kind with no line is not refused, it is
silently **built as shelving**. And a bench you sit *on* has to own its cell or
people stand inside it — at which point it blocks, and a thing that blocks is
not a decoration
([shared/build.js:138](shared/build.js#L138)).

So a seating area with no furniture on it is a picnic on the floor, and that is
the player's business. Step 3 is what makes the bench worth buying.

### Who sits, and when

A shopper considers a seat when **all** of:

- they are `BROWSE` (not `TO_TILL`, not `QUEUE`, not `LEAVE` — the same
  already-committed test `lastOrders` makes at
  [server/sim/index.js:12155](server/sim/index.js#L12155)),
- their mood has dropped below a threshold but is above `MOOD_FUMING` — a
  shopper on the point of storming out does not sit down, they leave, and a
  seat that catches them would quietly delete the storm-out,
- there is a free cell in `L.seating` they can actually reach, by `seatIn`'s
  rules and `findPath`,
- and the draw comes up. Not everybody sits, or a busy shop empties its aisles
  into the café.

No queue for a seat. One cell, one person, no seat means you shop on — the
break area's rule, and it is there because the fifth hire queueing for a chair
is precisely the bug `verify:break` section 4 exists to catch.

### What sitting does

`REST` holds them for `seatSeconds`, and over that time patience comes back
pro-rata — the break's `restores`, which is already a fraction of a full tank
rather than a rate, and already pro-rata for a charge broken off early.

Two things it must **not** do:

- **It must not stop the clock.** `stepMood` still runs; it drains slower.
  Skipping mood entirely makes a bench infinite patience and turns the seating
  area into a place customers go to die — you would find shoppers who arrived
  on Tuesday still sat there on Friday, and nothing anywhere would say so.
- **It must not be a second till.** They get up, they carry on browsing, and
  they pay in the ordinary way. A seat is a pause in a visit, not a stage of
  one.

### The predicate that will bite, and why it is *not* `inACar`

`inACar` ([server/sim/index.js:156](server/sim/index.js#L156)) is one word
rather than a fourth list, and its own comment says why: *"The three readers
disagree about `ENTER` and `LEAVE` … and they agree about this."*

The readers do **not** agree about `REST`, and getting that wrong is the whole
risk of this step. Each of the four wants a different answer, and every one of
them is silently wrong the other way:

| Reader | Answer for `REST` | What the wrong answer looks like |
|---|---|---|
| `measureOccupancy` ([:11026](server/sim/index.js#L11026)) | **counts** | Skip them and seating raises the shop's real capacity for free — the crush relieves itself and the feature has no cost. |
| `moodAverage` | **counts** | Skip them and the one number the feature exists to move stops reading the people it moved. |
| `snapshot` ([:2120](server/sim/index.js#L2120)) | **draws** | Skip them and the shopper vanishes for twenty seconds and reappears — which reads as a despawn bug, and sitting is the one thing here you can actually see. |
| `stepMood` ([:12100](server/sim/index.js#L12104)) | **drains, slower** | Skip it and a seat is infinite patience. Drain at full rate and the feature does nothing at all, silently. |

So `REST` gets no shared predicate. It is a case in `stepMood` and nothing
else — and the general shape is worth writing down, because it is `inACar`'s
lesson pointed the other way: **a container whose membership stopped implying a
fact does not always want one word for it.** Sometimes the readers genuinely
disagree, and a predicate that hides the disagreement is four decisions made by
whoever wrote the first one.

### Closing time and the day roll

`lastOrders` takes three branches by what somebody has committed to. A seated
customer has committed to nothing, so they are turfed out with the browsers —
which is right and free, and needs one clause.

A seat claim, like `seatIn`'s, has to be **cleared rather than skipped** when
there is no room: a stale claim is a cell of a pad somebody painted later that
nobody may ever sit in.

---

## Step 2 — something to sit with

`buys` on a pastime is already the mechanism: a list of tags, the item picked
off your own shelf, paid at the shelf price, landing in the day's takings like
any other sale ([shared/schemas.js:892](shared/schemas.js#L892)). It was written
for a hire on a tea break. A shopper who buys a coffee to sit down is the same
row, and it is what makes the seating pay for the floor it stands on.

It is also what finally makes the café half of the kitchen visible. A latte
today is stock that leaves in a bag; the coffee machine is a margin multiplier
and nothing else. Somebody sat with one is what a coffee machine is *for*, and
the connection costs nothing — `buys` matches on tags, so `['beverage']` picks
up the latte, the hot chocolate and the smoothie without naming any of them.

The prop is the pastime's own: staged, driven by how far through the sit they
are, so a cup empties and a sandwich goes down to the crusts. No renderer has
to learn what a cup is — that machinery shipped with the break and is proven.

The one new decision is **where the prop hangs**. A hire's prop is hung on the
worker; a shopper already has `kit` in the snapshot, drawn instead of the
armful. A cup is a second thing in the other hand, or it replaces the kit for
the duration. Replacing is cheaper and probably wrong: somebody who has put
their basket down to drink a coffee has still got the basket.

---

## Step 3 — the bench is worth something

This is the step he asked for, and it is deliberately last, because it is the
only one here that **moves money** and therefore the only one that needs
`simulate` averaged over ten seeds before anybody believes it.

A `seats` number on the piece — a bench standing on a seating cell raises what
that cell restores, a bare cell restores the floor value.

That is a *piece* carrying a number the sim reads, and there is precedent for
exactly that: `yields` on the Money Tree pays into `dropCash`'s pile, and `open`
on the Produce Table widens its reach. Neither needed a kind. So this needs no
`BUILD_KINDS` entry, no anchor, no blocking, and no re-flow behaviour — the
lookup is "is there a `prop-floor` placement on this cell, and does its row say
`seats`".

Three things about it:

- **It is a multiplier on the cell, never a seat of its own.** The pad decides
  how many people sit; the furniture decides how well. Otherwise the bench is
  back to being a kind, with the anchor and the budget map and all of it.
- **A number, not a boolean.** A barrel is somewhere to perch, a bench is a
  bench, a bistro set is a reason to stay — and a boolean makes those three the
  same purchase, which is the "tier that changes no number" trap wearing
  upholstery.
- **`charm` and `seats` are different axes on purpose.** Charm is how far word
  of the shop travels and it saturates at 8; `seats` is what happens to somebody
  already in the building. A chandelier is charming and is not somewhere to sit.
  Authoring both on one row is fine and should be common — what must not happen
  is one field standing in for the other, because then the whole Decoration bar
  is one number again and this document has achieved nothing.

---

## What is deliberately absent

- **No catchment.** `parkReach` owns "how far away somebody would come from" and
  `charmReach` owns "a shop worth crossing town for", and both saturate for the
  reason `charmReach`'s comment gives about pot plants. A third term widening the
  town would be the ceiling argument made three times. What seating buys is
  **crush and dwell**, which nothing else buys.
- **No shared pad with the break area.** Two pads that both hold people, told
  apart by *who* — and merging them means a hire on a bench in the middle of the
  shop floor, which is the exact thing `spotFor`
  ([server/sim/staff.js:940](server/sim/staff.js#L940)) sends them away from.
  A seating area is not staff-accessible and a break area seats no customers.
- **No table service.** A clerk who carries a coffee to a seated shopper is a
  new job, a new claim on a worker, and a route that has to survive a re-flow on
  every wall segment. `buys` at the shelf is enough and is already written.
- **No blocking furniture, still.** A bench that stops people needs to own its
  cell, and a cell can only say one thing at a time — which is the whole reason
  step 5 of docs/building.md exists. Until a cell can hold a list, a prop is
  something you walk past.
- **No eating a storm-out.** A shopper below `MOOD_FUMING` leaves. A seat that
  caught them would delete the one consequence the shop has for being bad, and
  it would do it invisibly.

---

## What the instrument cannot see

This is one of the few features `simulate` can honestly measure, and it is worth
saying why, because most recent work has been the other way round.

Crowding, turnaway and impulse are all **counted** rather than modelled —
`stats.turnedAway`, `stats.impulse` and `occupancy` are real numbers a hundred-day
run produces. So step 1 has a genuine before/after: a shop at the crush should
turn fewer people away with seating than without, and that should show.

What it cannot see:

- **Step 3 measures zero.** The balance bot never places a decoration, so a
  bench's `seats` value is invisible to it for exactly the reason an appliance's
  tier is.
- **Step 2 is thin.** `autoServe` welds a clerk to every till, so queues are
  short, `ANNOY_LINE` is low and the shop rarely reaches the mood band where
  sitting fires. A flat result there is the instrument, not the change.
- **Placement is the whole feature and the bot does not place.** The +47/+12
  break-area result came from moving a pad by hand across twelve seeds; this
  wants the same treatment and cannot be got any other way.

Before any before/after: `clear_modifiers`, check `startedWith` matches, and
drive `simulate` in-process against a copied database via `SNS_DB` — a shared
world moves under you between runs, and appending a comment to a file has
measured ±5% on three seeds.

---

## `verify:seating`

Almost every claim below is invisible in a screenshot, which is the test for
whether a sweep ships *with* the feature or after it. A shopper sitting on a
bench and a shopper standing on a bench-shaped tile are the same still frame.

1. **A shop that never painted a pad is the old game to the cent** — and to the
   *random number*. Same seed, same profit, `rng` called exactly as many times.
   This is the `&&` short-circuit, and it is the only claim here a balance run
   can make on its own.
2. **One cell seats one.** Paint four, send five shoppers who all want to sit,
   and the fifth carries on shopping rather than queueing for a chair.
3. **A room nobody can reach is not a room.** Wall the seating off and nobody
   walks at it — otherwise this re-creates the `TIRED_PACE` pin `verify:break`
   section 5 exists to catch, on customers, where it presents as shoppers
   milling against a wall.
4. **The four readers answer differently, on purpose.** `measureOccupancy` and
   `moodAverage` count a seated shopper, `snapshot` draws them, `stepMood`
   drains them slower than zero and slower than full. Asserted as four separate
   values, because a single predicate is precisely the mistake this is guarding.
5. **A seat is not infinite patience.** Somebody sat past `seatSeconds` gets up,
   and their mood after a full sit is below what it was when they walked in.
   Timed, this passes on a shopper who simply left — so it has to assert the
   *transition*, the way `verify:break` 7 asserts a charge that ENDED rather
   than one that ran out.
6. **Placement moves impulse and nothing else.** Same seed twice: a seat within
   `IMPULSE_RADIUS` of a stocked board rolls impulse, the same seat in a bare
   corner does not, and every other figure in the run is identical.
7. **Money and goods are conserved across a sit.** A `buys` at a seat lands in
   the takings exactly once, comes off a real board, and a shopper turfed out
   mid-sit at closing does not pay twice or walk off with an unpaid cup.
8. **A re-flow does not un-seat anybody.** Building re-flows on every wall
   segment, so this is `parkNow`'s claim about a car said about a chair — a
   shopper who restarted their sit on every segment is a customer who never gets
   up.
9. **Painting over an occupied seat gives it up.** `seatIn`'s stale-claim rule,
   which is already right for staff and would be a stranded shopper here.
10. **The pad is walkable and never buildable**, and it survives a re-flow —
    `verify:yard`'s claim about the bay, made again because it is made per pad
    and not once.

It authors its own ground row, its own pastime and two item rows, and removes
them on exit — the way `verify:break` and `verify:catalog` do, because it writes
into whatever content database it is pointed at, usually the live shared one.

---

## Proposed after that

- **A milestone.** A rung is a *measurement* of state the shop already keeps, so
  "seat fifty customers" is one row in `server/sim/goals.js` and no migration.
  Six rungs add to `catchment` and three pay cash, so re-run `simulate` if you
  retune them and call `silenceMilestones` in any sweep that asserts money.
- **Outdoor seating.** `where: 'any'` is already how the bin and the furniture
  are placed, and the street, the pavement and the car park all exist. What is
  missing is a reason to sit outside rather than in — weather, or a shop that is
  full, which is the crush argument arriving from the other side.
- **A regular's table.** docs/customers.md steps 10–12 give a shopper a name and
  a memory. Somebody who sits in the same place every week is the cheapest
  possible use of that, and it is the difference between a mechanic and a shop.
