# Pickups — the customer who never comes in

Status: **all proposed.** Nothing here is built.

⚠️ `simulate` **will lie about this, in the direction that costs money.**
`autoServe` welds a bot to the front of every till, and the balance bot never
walks a picking round — so a collection channel would book the revenue and never
pay the wages that produced it. Any number this feature reports out of a balance
run is the ceiling, not the measurement. See *What the instrument cannot see*.

---

## The hole

Every shopper in the game does the same three things: they walk in, they pick
their own shopping off the shelves, and they queue. The first costs you floor
space, the second is free labour you get for nothing, and the third is the only
throughput the shop has.

Which means the shop has exactly one bottleneck and no way to route round it.
When `occupancy` passes `TURN_AWAY_AT` the spawner stops the arrival at the
door, books `stats.turnedAway++` and takes `-0.005` reputation off you
([server/sim/index.js:10932](server/sim/index.js#L10932)) — a customer who
wanted to spend money, was refused, and made you *worse* for it. The only
answers the game offers are a bigger building or another till, both of which
make the crush the thing you keep paying to fix.

And the aisles are doing two jobs that have nothing to do with each other. They
are where the shop *displays* things — which is where impulse comes from, and
impulse is real margin — and they are also the picking floor. A shopper who
knows what they want is standing in the way of a shopper who does not.

---

## The shape

**A collection point is a till whose queue is fed by the road instead of by the
aisles.** Somebody orders ahead, your crew pick it, they arrive, they collect,
they leave — and they were never in your shop.

One sentence carries the whole balance of it:

> A mobile order is a customer who stops being your unpaid picker.

You trade **wages and impulse margin** for **floor space and the turnaway you
would otherwise have lost**. That is a real decision in both directions, and it
is the reason this is a feature rather than an upgrade.

---

## What is already built that this rides on

Most of it. This is the argument for doing it at all.

| Piece | Where | What it gives free |
|---|---|---|
| Two working spots | `checkout` in [shared/build.js:101](shared/build.js#L101) | `anchor: 'serveAt'` + `behind: 'tendAt'` — one spot for the person being served, one for the person serving. A counter is the only kind that already has this. |
| A queue that knows where it is | `startLane` in [shared/build.js:789](shared/build.js#L789) | `indoorOnly: insideStore(L, from.x, from.z)`. A lane started **outdoors queues outdoors**. Putting the counter outside costs nothing and needs no rule. |
| `where: 'any'` | `bin` in [shared/build.js:128](shared/build.js#L128) | The placement half of "ploop it inside or out" is one field, already precedented. |
| The queue itself | `growLane`, `queueSlot`, `laneOf`, `queueMax` | Lines, spacing, one tile per place, walls respected, ruled doorways refused. |
| A speed ladder | `serveSeconds` / `unattended` | A tier that means something on day one, and a top rung that is a locker. |
| Goods drawn on a fixture | `surface` parts, `drawableBoards` | Totes standing on the counter draw themselves, with no renderer that knows what a tote is. |
| A share gated on owning the ground | `DRIVE_SHARE`, [server/sim/index.js:10984](server/sim/index.js#L10984) | The exact shape the ordering share should copy — including the `&&` short-circuit. |

---

## Step 1 — the collection point

The minimum that works. Anything less than this list does not function, so it
is one step rather than four.

### The kind

A new `BUILD_KINDS` entry:

```js
collect: {
  label: 'Collection Point', blocks: true, where: 'any', rotates: true,
  anchor: 'collectAt', behind: 'tendAt',
},
```

**A kind and not a `checkout` piece with a flag**, for the reason `warmer` and
`bin` each spell out at length: what may be *done* at it is read off
`fixture.kind` all over the sim and in `actionAt`, and a column on the catalog
row would mean every one of those sites resolving a placement back to its row to
ask something the placement already knew. A till takes money off somebody
holding a basket they filled themselves; a collection point hands over a tote
the shop filled. `stepQueue` and `completeSale` branch on that.

`where: 'any'` is what you asked for and it is nearly free — see the lane rule
above. A counter outdoors needs staff to be able to *reach* it, which is
`verify:doors`'s territory: a collection point behind a wall with no staff way
through is the `TIRED_PACE` pin wearing a counter.

### The order is a promise

docs/deliveries.md makes this argument about the van and it is the same
argument: an order should be a promise rather than a teleport. `this.pickups` on
the save, each one:

```
{ id, lines: [{ item_id, qty }], counter, placedAt, dueIn, state }
```

`state` runs `waiting` → `staged` → `collected`.

Three things about the record.

**It is `pickups`, never `orders`.** `this.orders` is the shop's *wholesale
purchasing* — `orders.pending`, `orders.budget`, `orders.assign`,
`orders.dropped`. Two things called orders in one sim is the `deliveries`
mistake `verify:bin` exists to stop, and it is worse here because both of them
are lists of goods with quantities and both are read at the day roll. One
spelling, decided before the first line is written.

**`dueIn` is a duration, not a stamp.** `elapsed` restarts at zero on every
load, which CLAUDE.md records against `plantedAt`, `yieldedAt` and `arrivesAt`
in turn. A saved `dueAt` puts every outstanding order in the future for ever and
nobody ever arrives to collect one — a shop that quietly stops having a
collection business, with a counter that still looks fine.

**The lines are composed from what the shop HAS**, at the moment the order is
placed. That is not a simplification, it is what makes the promise honest: the
shop is not being asked to conjure something it never stocked, and the only way
an order can fail is that the goods sold out in the window — which is the
interesting failure and the one worth modelling.

### Who orders ahead

The share is a **consequence, not a constant**, and it copies `DRIVE_SHARE`'s
shape exactly, including the bit that looks like a style choice and is not:

```js
const counter = this.freeCounter();
if (counter && this.rng.next() < PICKUP_SHARE) { … }
```

`&&` short-circuits, so a shop with no collection point — which is every shop
that exists today — **never reaches `rng.next()`**, draws exactly the random
numbers it always drew, and comes out of a balance run byte-identical to the
same seed before this existed. Roll first and ask second and the whole RNG
stream shifts for shops that cannot use the answer, and two `simulate` runs
diverge for reasons that have nothing to do with what changed.

*Who* orders ahead is tags, because tags are the whole design. `archetypes`
already grew a `tags` column for kits, and the kit's `use`/`tags` pair is the
pattern: a planner phones ahead, a Snack Kid never does. No new vocabulary — run
`list_tags` and use what is there.

### The picking is `serve`

This is the part that differs from the pitch, and docs/waste.md is why:

> **A new routine is a new branch, not a new job.** A job is a sentence the
> player assigns; a routine is one of the things that sentence covers. Adding to
> `JOBS` means re-authoring every kind in the game — and if you forget, the
> feature is not broken, it is *unreachable*, which looks identical from inside
> the shop.

That cost a live shop 305 units of rot standing beside a skip it had paid for,
with seven hires who were all, in their own terms, tidying up. A `picking` entry
in `JOBS` ([shared/schemas.js:667](shared/schemas.js#L667)) would land in exactly
the same hole: five authored worker kinds, none of them carrying it, a
collection point that takes orders and never fills one.

So picking belongs to **`serve`** — "look after the customer at the counter",
which is what it is. Every kind that already carries `serve` can work a
collection point the day you build one.

And it makes the cost *sharp* rather than notional: your `serve` budget now
splits between the till and the picking round, so buying the collection channel
spends checkout attention. A clerk who wanders off to pick a nine-line order
leaves the till dead while they do it. That is not a bug to fix, it is the
decision — and the player's answer is another hire, which is the answer the
shop is supposed to have.

**When it would earn its own name:** if playtesting shows you genuinely want to
say "this bot does collections and nothing else" — a dedicated picker, kept off
the tills. That is a real sentence and a real name. If it comes to that, the
`JOBS` entry and the re-authoring of **every** worker kind go in the same
commit, or the feature ships unreachable.

### A picked order sits on the counter

`counter.totes[]`, capacity from the tier. **Not a crate on the floor**, and the
reasoning is the third appearance of one trap:

> A container whose membership used to imply a fact stops implying it the moment
> something can be in it that is not that fact.

`inACar` was the first (people in `this.customers` who had not arrived), `waste`
was the second (rubbish in `deliveries`). A customer's shopping in an ordinary
pallet is the third and the worst of them: `homeSupply` would stop the shop
reordering what it had already sold, `unload` would shelve somebody's paid-for
groceries back onto the shelf they came off, `craft` would cook with them, and
`bayRoom` would report a bay full of goods that are not the shop's.

Totes on the fixture avoid the whole thing by construction. `layout.collects` is
a list no stock loop walks, exactly as a checkout's takings are not stock, and
the tier ladder gets a job that is not a multiplier: **how many orders the
counter can hold staged.** Which is `bayRoom`'s promise said about a counter —
how much you bought is how many orders you can have waiting.

Two loops do have to learn about it, and both are the same sentence: goods sat
in a tote **spoil** (`spoilStock` walks it), and a tote whose item row was
deleted out from under it is `binOrphans`' seventh place. `verify:orphans`
already exists to catch the second and its whole design is that it is a sweep
about *places*.

The visual is free: a counter model with `surface` parts draws its totes the way
a shelf draws its boards, through `drawableBoards`. Mind that doc's own trap —
flagging a board does not make it one you can see into.

### The handover

`serve` at the counter, `completeSale`, money on the counter. All of it exists.

The differences from a till, and they are the balance:

- **No impulse.** `impulsePull` needs somebody dwelling past shelves. A
  collection basket is the list and nothing else. `stats.impulse` is already the
  handle that will show it.
- **A partial is possible.** An item that sold out in the window means they pay
  for what is there. Reputation takes a hit — an **eighth** `R.` constant in
  [shared/reputation.js](shared/reputation.js), never a string literal, or you
  open a silent bucket every readout prints as a raw key.
- **An unpicked order is worse than a queue.** They are standing at a counter
  waiting for a shop to go and find their shopping. Its own annoyance rate above
  `ANNOY_LINE`, because a promise broken is not the same as a wait.

### The predicate that will bite

`stepMood` skips `ENTER`, `LEAVE` and `inACar` ([server/sim/index.js:154](server/sim/index.js#L154)) —
somebody who is not in the shop is not the shop's fault. Somebody queueing at an
**outdoor** collection point is also not in the shop, and today they would pay
`ANNOY_CROWD` for a crush they are nowhere near and `ANNOY_MESS` for a floor
they cannot see, because `this.occupancy` and `this.mess` are shop-wide facts.

`inACar` grows a sibling, or better, the four readers CLAUDE.md lists get one
predicate: `measureOccupancy`, `moodAverage`, `snapshot` and `stepMood`. The
last is the one that costs money, and it is also the one that makes the feature
work at all — a collection customer must not add to the crush, or the whole
point (fewer people inside) is cancelled by the sim counting them as inside.

### Closing time

`lastOrders` has three rules by what somebody has committed to. A collection
customer is `TO_TILL`/`QUEUE` with money already out, so they are left alone —
which is right and free. An order **staged but never collected** is the new case:
it is the shop's stock, paid for by nobody, standing on a counter. It goes back
on the shelves at the day roll, or it rots there. Either is defensible; neither
is the default that happens if nobody decides.

---

## Step 2 — the locker

`unattended` on the top rung of the collection ladder, which is the self-checkout
argument pointed at collections: a bank of lockers hands orders over with nobody
behind it.

It is a number on a tier and not a kind of its own, for the reason
`selfServeSeconds` gives — every counter answers "what share of your speed do you
manage with nobody there", and one that needs a person answers `Infinity`.

The rung must be **worse at something** or the ladder ends in a strict upgrade
and there is no decision on it. A locker cannot hand over a partial and cannot
be told anything, so a locker order that went wrong is a customer stood at a
metal box. That is the cost, and it is a good one — it makes the locker the
right answer for a shop that is reliably stocked and the wrong one for a shop
that is not.

---

## Step 3 — your own hands

You can stage a tote yourself. It is the shopkeeping verb, it needs no job
weights and no hire, and it is how a shop with one clerk uses this at all.

It is `stockShelf`'s shape: hands → tote, named by pointing, armed by the ring.
`errandAction` and the four kinds of address already cover a fixture by id, so
this is a branch in `actionAt` rather than a mechanism.

---

## What is deliberately absent

- **No catchment.** Parking already owns "how far people will come"
  (`parkReach`), and it saturates for a reason. A collection point that also
  widened the town would be two purchases buying the same term, and the ceiling
  argument would have to be made twice. What this buys is **floor space and
  turnaway**, which nothing else buys.
- **No delivery.** A van that takes the shopping *to* them is a different
  feature with a different cost structure, and it deletes the counter, the queue
  and the arrival — which is to say all the parts of this that already exist.
- **No scheduled slots.** A window you can oversubscribe is a second scheduling
  system beside `DELIVERY_RUNS`, and it is a chore before it is a decision.
  `dueIn` per order is enough to make picking a race.
- **No ordering UI for the player.** The orders come from the town. A screen
  where *you* place them is a shop buying its own shopping.

---

## What the instrument cannot see

Beyond the `autoServe` problem at the top:

- The balance bot **never promotes**, so `serve` budgets in a run are whatever
  the kind was authored with. The picking-versus-till tension is the whole cost
  of this feature and `simulate` cannot feel it.
- It **keeps the shelves full**, so an order that could not be filled never
  happens — the partial and its reputation cost measure zero.
- It **never runs a locker**, for the same reason it never runs an appliance.

So step 1 has to be measured the way docs/customers.md measured steps 1–3: ship
it, play it, and treat a flat `simulate` result as the instrument being blind
rather than the change being free. What *will* show up honestly is the wage
line and `stats.impulse`, because both are counted rather than simulated.

Before any before/after: `clear_modifiers`, check `startedWith` matches, and
drive `simulate` in-process against a copied database via `SNS_DB` — a shared
world moves under you between runs.

---

## `verify:pickup`

Every claim in step 1 is invisible in a screenshot, which is the test CLAUDE.md
applies to whether a sweep ships with the feature or after it. A counter with
three totes on it and a counter with three totes on it that nobody will ever
collect are the same picture.

The claims worth pinning:

1. **A shop with no collection point is the old game to the cent** — and to the
   *random number*. Same seed, same profit, and `rng` called exactly as many
   times. This is the `&&` short-circuit, and it is the only claim here that a
   balance run can actually make.
2. **An outdoor counter queues outdoors** and an indoor one queues indoors, from
   the same authored piece — the `indoorOnly` rule, asserted rather than assumed.
3. **A staged tote is not stock.** `homeSupply`, `unload`, `bayRoom` and
   `restockQueue` all answer identically with three orders staged and with none.
   This is the claim the whole totes-on-the-fixture decision exists for, and it
   is a comparison rather than a value.
4. **Goods are conserved across a picking round.** Shelf → hands → tote →
   customer, nothing created, nothing destroyed, including an order abandoned
   half-picked because the clerk was drawn to a till.
5. **A collection customer does not add to the crush.** `occupancy` with ten
   people queueing outside equals `occupancy` with none — otherwise the feature
   cancels its own point, silently.
6. **An order outlives a reload.** `dueIn` as a duration: save with an order
   90 seconds out, reload, and it is still 90 seconds out rather than in the
   past or in the future for ever.
7. **A hire will not pick into a full counter**, the way the kitchen will not
   cook into a full pad — and the farm's exception is the contrast worth
   remembering, because a picked order with nowhere to stand is not a buffer.
8. **A re-flow does not lose an order.** Building re-flows on every wall
   segment, so this is the `parkNow` claim about a car said about a tote.

It authors its own piece, its own items and one worker row, and removes them on
exit — the way `verify:catalog` and `verify:bin` do, because it writes into
whatever content database it is pointed at, usually the live shared one.

---

## Proposed after that

- **A milestone.** A rung is a *measurement* of state the shop already keeps, so
  "fill fifty collection orders" is one row in `server/sim/goals.js` and no
  migration. Six rungs add to `catchment` and three pay cash — re-run `simulate`
  if you retune, and `silenceMilestones` in any sweep that asserts money.
- **A drive-through.** A collection point on a road cell, collected from the
  car without parking. The road brush, the lane and `parkedFacing` already
  exist; what is missing is a shopper who never gets out, which is one state.
- **Standing orders.** A regular (docs/customers.md steps 10–12) who collects
  the same list every week. The regulars work is what makes this more than a
  throughput valve — it is the difference between a channel and a relationship.
