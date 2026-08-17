# Deliveries — the van, the wait, and the car park

Status: **steps 1–4 built. Steps 5–6 proposed, nothing built.** An order is a
promise that joins a run and lands hours later; the van is a content row
somebody drew; it drives in along a lane computed once per layout, unloads with
`dropGoods` and leaves; and the car park is a pad you paint that shoppers
actually drive to, take a bigger basket out of, and walk in from. `npm run
verify` is green across all thirteen sweeps.

Steps 5 and 6 are the asymmetry step 4 left behind: **the van has a lane and the
cars do not.** A shopper's car blinks into existence on its space and vanishes
with its driver, which is the one thing in the yard that does not read as a
thing that happened. Step 5 gives a car the same treatment the van already has;
step 6 is the `road` brush, which is only worth pricing once there is something
on it more often than six seconds a run.

What is *not* built is at the bottom, and the rest of it is not unfinished work
— it is the list of things nobody has needed yet: a bigger-van upgrade, a way to
cancel an order, and a `verify:park` sweep to replace the throwaway proof that
stood in for one.

⚠️ **Balance: not recorded here yet.** A separate measurement pass is running
and this doc does not have its result, so there is deliberately no number in it
— including no number for step 1, which is the step that moves the balance most.
Do not fill this in from a figure quoted in a chat transcript: every reading
taken while this was being built was taken against a repo two other agents were
editing, which is exactly the case CLAUDE.md says is not a control. When it is
measured, the controls that make each half honest are already known:

- **Step 1** (the wait) has no in-repo control — reverting it means reverting
  `buyStock`, so it is a bisect against HEAD's three sim files on a frozen `SNS_DB`
  copy, ten seeds, `clear_modifiers`, `startedWith` checked on every run.
- **Step 3** (the van) has one for free: `Game.prototype.deliveryVan = () => null`
  is byte-for-byte the path a database with no vehicles takes, i.e. step 1
  without step 3.
- **Step 4** (the car park) has the best control of the three: a shop that has
  not painted a pad never reaches the arrival roll at all, so it is provably the
  game as it was. The comparison is a shop with tarmac against a shop without.

Expect step 1 to cost, and expect it to be real — a wait is a nerf to restocking
and it was always going to be. What buys it back is that every setting in
[ordering.md](ordering.md) starts mattering: with instant delivery a minimum is
a number you set and never think about again.

The goal, unchanged: ordering should be a decision you make ahead of time and
then watch arrive, instead of a button that teleports goods onto concrete.

---

## What was wrong

> **This section is history.** Everything below has since been fixed. It is kept
> because the argument is why the shape above is the shape it is, and a design
> doc whose problem statement has been deleted reads as a list of arbitrary
> preferences.

`buyStock` used to end like this:

```js
this.dropGoods(itemId, take, this.layout.bay);
this.pushLog(`${take}x ${item.name} delivered — unload it at the bay.`);
```

Press the button, the crate exists. There was no van, no wait, and no vehicle of
any kind anywhere in the codebase — `grep truck` or `vehicle` and you got
nothing. Three things followed from that, and only the first was obvious:

**There was nothing to look at.** The bay is the one piece of ground whose whole
job is to be a place things arrive, and nothing had ever arrived at it — crates
appeared on it. It was the least animated square in the game and it should have
been the most.

**Nothing you set about ordering could matter much.** A minimum, a maximum, a
daily cap, a restock priority — all of them are answers to "what should happen
while I'm not looking", and nothing happened while you weren't looking. The
staff ordered the instant a board dipped, so the shop was never actually short
and the settings never actually bound. Step 1 here is what makes step 3 of
[ordering.md](ordering.md) worth having, and step 3 of that doc has landed since.

**Running out had no consequence you could plan around.** A shop that can refill
any shelf in one second has no reason to hold stock, so there was no such thing
as a bad buying decision — only a slow one.

---

## Step 1 — an order is a promise, not a delivery ✅

An order is a row on the save with an arrival time, and the goods appear when it
lands rather than when you press the button.

```
orders.pending: [{ id, item_id, qty, cost, placedDay, placedAt, runHour, arrivesAt }]
```

Paid at order time, not on arrival — the refusal rules in `buyStock` already ran
before the money moved and that is the half worth keeping. What moved to arrival
is `dropGoods`, which now lives in `landRun` and is the only thing in the feature
that touches goods.

**A run, not a timer.** `DELIVERY_RUNS = [8, 14]` at the top of
[server/sim/index.js](../server/sim/index.js), and an order joins whichever run
is next. That is the difference between "wait five minutes" and a supply chain:
everything ordered before the cutoff comes together, which is what makes a
minimum worth setting and a maximum worth thinking about. It also means one van
animation per run rather than one per button press.

The comparison in `nextRun` is strict, so an order placed at exactly 08:00 is on
the 14:00 van rather than the one pulling away. That is the cutoff doing its job,
and it has a second effect worth naming: an arrival is **always** in the future,
which is what makes "an order is not a delivery" a rule rather than usually true.

**It is visible before it lands, in the supplier.** See the settled question at
the bottom for why there is no menu on the bay:

- an item with an order out carries a green `+6` off its held count and a
  sub-line saying when it lands ("10 arriving — 4 on the van, 6 at 14:00")
- it drops **out of `Short`** while something is on its way, and into a new
  "On the way" tab which is the whole inbound list, soonest first
- one pinned line above every tab says "22 on the way / 14:00" and presses
  through to that list; the foot says when the vans run and how much room the
  yard has left
- `homeSupply` counts pending orders, which is what stops the staff ordering the
  same board again every tick until it lands. This was called in advance as *the
  bug this step will have*, and it was — the fix is one more source in the
  function step 1 of ordering.md already wrote for crates. `staff.js` needed no
  new check at all; a comment says so, because "no change" is the finding.

**The bay refuses, at order time, with the other guards.** `bayRoom()` is
`cells × crateCapacity` minus the crates standing on the pad minus everything in
flight, and `buyStock` refuses above it *before* the charge. It has to count the
orders as well as the crates: counting only what is standing there would let six
orders placed in one tick all pass a check against an empty pad and land together
on a bay that holds four.

Crates anywhere else are deliberately not counted. The drop-off is where you park
an armful and a stripped shelf leaves its stock where it stood; neither is the
wholesaler's problem, and counting them would mean tidying your own goods into
the yard stopped you being able to order.

**`simulate`'s bot was taught to wait**, and this was the largest single decision
in the step even though the design doc never mentions it. The bot had an
`autoServe` fast path that put ordered goods straight into its hands. Left in
place, the balance bot would have been the one shop in the world where ordering
is still instant, and step 1 would have measured as free. It now unloads crates
at the bay with the same `unload` verb a player uses, gated on `shelfFor` so a
crate with nowhere to go is never lifted and binned, and it subtracts
`homeSupply` when sizing an order.

### Where the design was wrong

**The row shape contradicted itself.** The doc listed `arrivesAt` as a field and
then warned three sections later that it must be stored as time remaining. Both
are true of different copies: the save holds `arrivesIn` (written by `ordersOut`,
used by *both* `persist()` and `serialize()` so a raw stamp cannot leak either
way), and the constructor rebuilds `arrivesAt` from whatever `elapsed` it is
handed. The in-memory field is the one the sim compares against; the stored field
is a duration. Anything that writes one and reads the other is the bug.

**The bot was not mentioned and should have been the first paragraph.** See
above. The doc's ⚠️ said the bot "will need to cope with a wait" — it needed
rather more than coping: the pass that sized orders judged a unit by its thinnest
board alone, so a board with a van in flight blocked the whole unit from ever
being reordered.

---

## Step 2 — the van is authored content ✅

A `vehicles` table, the same shape `workers` and `pastimes` use: an id, a name, a
`model` (staged, so a van visibly fills and empties), a speed, and a capacity in
crates. It has the content_version trigger like every other content table, a
`VehicleSchema` in `shared/schemas.js`, a `create_vehicle` MCP tool over the
generic `/content/:kind` route, and it rides the catalog broadcast so a van
redrawn over MCP reaches a client without a file being touched.

Why content rather than code: a van is a thing you *look* at, and everything in
this game you look at is a row somebody can draw — that is what lets a kid make
one without touching `server/`. Capacity is the only field that is a number the
sim reads, so it is the only one that needs `simulate` re-run when somebody
authors a second van.

Two rows ship: `delivery-van` (capacity 6, speed 3.2, three load stages) and
`shopper-car` (capacity 2, speed 3.8, unstaged — a car does not fill up).

**Deliberately no tier ladder.** A fixture has one because a shelf you already
own can be improved in place; a bigger van is a different vehicle. A ladder would
also put capacity in two places — the row and the rung — and capacity is the one
field that must have exactly one spelling.

### Where the design was wrong

**The field list did not say what a vehicle is *for*, and step 4 depends on that
distinction existing.** A closed `use` enum (`delivery` | `customer`) was added,
for the same reason `JOBS` is closed: each value is a routine somebody has to
write. Without it, step 3 would have had to pick the delivery vehicle *by id*,
which is the exact thing CLAUDE.md forbids, and step 4 could have handed a
shopper a lorry. It is not a number, so "capacity is the only field the sim reads
as a number" still holds exactly.

**"Capacity in crates" has to mean "how much it carries", full stop.** Step 4's
bigger-basket mechanic reads the same field on a car, so it is authored with that
single meaning — a car's `capacity: 2` is the boot, and it is the number of extra
units its driver takes home.

**"The shop owns one van by default" is not recorded anywhere and should not be.**
Nothing on the save says which van the shop drives; `deliveryVan()` derives it as
the `use: 'delivery'` row with the smallest capacity, tie-broken by id so which
one turns up is a fact about the catalogue rather than about the order rows came
back in. That is what stops somebody authoring a bigger lorry and silently
upgrading every shop in the world. The day the upgrade is wired up,
`deliveryVan()` is the one function that changes.

---

## Step 3 — the van drives in ✅

It arrives eight tiles off the map, drives to the bay, stands with its load
running down for `UNLOAD_SECONDS`, and drives back out. `snapshot().van` carries
`{ vehicle, x, z, facing, phase, load }` and the renderer draws it from the row's
own model, staged by `load`, so nothing in `client/` knows what a crate is.

**A vehicle is not a person, and there is no pathfinding in any of it.**
`vanRoute(L, bay)` in [server/layout.js](../server/layout.js) tries every bay
cell × every direction for a straight spur of drivable cells out to the border
ring, then a clear leg along that ring to the nearer end and off the map;
shortest total drive wins. It returns `{ dock, in[], out[] }` or null, and it is
computed once at the *end* of `compose` because it is the only thing there that
reads `blocked` as it finally is — and never inside `layoutSoFar`, so a
thrown-away size probe does not pay for it. `DRIVABLE` is deliberately not
`WALKABLE`: no plots, no doors.

`followPath` — the same function a shopper walks with — drives it.

**Unloading is `dropGoods` and nothing else.** A van that stacked crates by some
second mechanism would be the "never invent a second container" mistake in
CLAUDE.md wearing a windscreen. `landRun` is also the one place an order leaves
`orders.pending`, in the same breath, so at every instant the goods are in
exactly one place.

**The van owns no tile.** No `blocked`, no walk grid, nothing pathfinds round it.
It parks on the one strip of ground a stocker is most likely to be standing on,
so a van that owned its cells could trap somebody at the bay for the length of a
delivery, and one that arrived while they stood there would have to decide what
to do about a person under a lorry.

**One van at a time, and that is not a limit so much as what a run *is*.**
Everything ordered before the cutoff comes together, so a second lorry on the
road at the same time would be the run having happened twice. Anything that does
not fit — more crates than it holds, or ordered while it was out — stays pending
and the next tick after it pulls away sends it back.

**It restarts, it does not resolve.** The van is in memory only and appears in
neither `serialize()` nor `persist()`. The order is the record; the van is only
the picture of it. A reload therefore costs one drive-in: the row is already due,
so `loadVan` sends a fresh van from the map edge on the next tick. Saving it
would mean saving a position and a half-eaten waypoint list against a lane
`regenerateLayout` recomputes — a van restored onto a road that moved, holding
goods that are also still on the save, which is two records of one delivery.

### Where the design was wrong

**"Along the outdoor border ring to the tile nearest the bay" is half a route.**
Stopping on the ring nearest the bay leaves the van up to five tiles from the
pad, with crates appearing beside it out of nowhere. It needs a second straight
leg off the ring *into* the yard — and once you have that leg, the ring cell is
chosen **by** the spur rather than by nearness, which inverts the order the doc
describes.

**The doc never said what happens when there is no lane** — a walled-in yard, a
bay painted somewhere no straight run reaches. Settled: `landRun` fires anyway,
with no animation, and the same is true when no `delivery` vehicle row exists at
all. An animation that can fail must never be the thing that decides whether a
paid-for delivery happens.

**A `road` ground kind was offered as the next step up and has not been needed.**
The ring reads fine. A road is a new brush, a new tile and a new thing to price,
and it should wait until somebody looks at the ring and dislikes it.

---

## Step 4 — the car park ✅

Built in two halves, and they are worth naming separately because the first is
ground and the second is behaviour: **4a** is the pad you can paint, **4b** is the
shopper who drives to it.

### 4a — the pad

`GROUND.park` in `shared/build.js`, `pad: true`, alongside `bay`, `drop` and
`break`. `T.PARK` is a **new** enum number (14) — no gap reused, no renumbering,
because a save holds `tiles` as raw numbers. It is walkable and in neither
buildable set, which is what makes it unbuildable without a word being written,
the same way the bay is. It has its own palette entry under Building on a new
**Customers** sub-tab: the yard is where the goods arrive, this is where the
people do, and Staff is ground for the payroll.

`PAD_KINDS`, `BUILD_KINDS`, `groundKindOfTile`, the last-pad-gone warning, the
cut-off-the-pad warning and `padCells` all picked it up derived, with no other
edit. The seed lays none of it, because a shop without a car park is every shop
that exists today.

### 4b — the arrivals

- **A space is a cell you can leave.** `parkSpaces()` reads
  `padCells(layout, 'park')`, sorts nearest-door-first, and keeps only cells
  `findPath` can get out of. One cell, one car — exactly the claim `verify:break`
  makes about seats. It is cached against layout identity, because it is an A*
  per cell and it is asked on every spawn and every snapshot.
- **`stepSpawning` looks for a free space *before* it rolls.** A driver is put
  down on their space, skips the arrival jitter, and walks in from the tile they
  are standing on rather than from `layout.spawn`.
- **A driver's basket is bigger by their car's `capacity`**, with the
  archetype's own money-per-item carried along so the budget scales in the same
  proportion. That is the whole mechanic and it is the right one: a reason to
  spend money on ground that is not a shelf, and it reads instantly — a full car
  park is a good day.
- **`parkReach()` feeds `catchment()`** and saturates against `PARK_MAX` the way
  `charmReach` does against `CHARM_MAX`. Parking is how far people will come,
  which is precisely what catchment means and precisely what reputation cannot
  move — and it must saturate, or the cheapest strategy in the game is a field
  of tarmac.
- On the way out, a driver walks back to the car and despawns there. The space is
  held right up to despawn.

The three constants, with what each is measured in:

| Constant | Value | What it is |
|---|---|---|
| `DRIVE_SHARE` | 0.35 | The share of arrivals that would drive *given a free space*. Well under half on purpose: at 1.0 the car park stops being a car park and becomes the front door, and everybody who could not find a space reads as the shop being shut to them. It is an upper bound and rarely the real figure — a small pad that stays full means far fewer drove, which makes the pad SIZE the decision rather than this number. |
| `PARK_MAX` | 4 | The catchment ceiling, against `BASE_CATCHMENT` 16 and `CHARM_MAX` 8. A quarter of the base town, half of what a beautiful shop is worth — less than charm because it is one decision on ground rather than everything you ever placed. |
| `PARK_HALF` | 6 | The e-folding size in spaces: six spaces is ~63% of the ceiling, twelve ~86%. |

### Where the design was wrong

**"A driver's basket cap is a number in `sim/`" — it is not, and it must not be.**
The boot is `capacity` on the `use: 'customer'` vehicle row, which is the only
part of this a person can author. A constant in `sim/` would be a second spelling
of a field that already exists.

**The doc never said what happens to a pad nobody can reach.** Settled the way
`verify:break` settled a walled-off break room: an unreachable cell is not a
space, so it holds no cars **and** buys no catchment. Without that, painting a
pad behind the building would spawn shoppers into a box where they browse nothing
and are booked as having left empty-handed — a car park that makes the shop worse
than no car park.

**The doc never said what a driver does on the way out.** Settled: they walk back
to the car and despawn there, and the space is held until they do. Freeing it
when they join the queue would make the pad hold more shopping *trips* than it
holds cars.

**The doc says nothing about the RNG, and the ordering is load-bearing.** Looking
for a space *before* rolling for one means a shop with no pad never touches the
random stream and comes out byte-identical to the game before this existed. That
is what makes the control for any measurement a shop that has not painted a pad.
Rolling first and then checking would have shifted every existing shop's stream
and made the whole feature unmeasurable.

**"Everything about how a pad behaves already exists" is true of the rules and
not true of the plumbing.** A new pad needs four more things, none of them
mentioned: a tile kind in `shared/tiles.js`; a `TILE_STYLE` row in
`palette.js` or `buildWorld`'s `if (!style) continue` renders it as a hole in the
ground; a `KIND_TOOLS` entry or it is unreachable from the palette; and an
authored piece row, because `buildTools` treats ground as `artOnly` and drops any
ground kind nobody has drawn — so "you can paint a car park" is false until a row
exists. One `car-park` piece is authored live at $10/tile.

**The pads are not symmetrical in `compose`, and `park` is the odd one out.**
`bay`, `drop` and `break` each get a named region out of `padRegion(kind)` —
`L.bay`, `L.drop`, `L.break`. There is no `L.park`; 4b reads `padCells(layout,
'park')` straight off `tiles`, which works. Anything that later wants the pad's
centre point the way the van wants the bay's will want the region adding.

---

## Step 5 — a car drives in and out 🔲

The van arrives eight tiles off the map, drives a lane, does its job and leaves.
A shopper's car is put down on its space by `stepSpawning` and deleted by
`despawn`. Both are vehicles, both belong to somebody who came here on purpose,
and only one of them ever moves — which is why the bay reads as a place things
happen and the car park reads as a texture with props on it.

### What is already here

Most of it, and this is the argument for doing it at all:

- **The renderer needs nothing.** `vehicleProps` in
  [client/render/scene.js](../client/render/scene.js) already draws a vehicle
  from its catalog row, eases it per *frame* rather than per snapshot
  (`VEHICLE_CHASE` / `VEHICLE_TURN`) precisely because a body at lorry speed
  judders at 10Hz, and turns the nose with the model's east-facing convention.
  A car that moves is the same three fields the van already sends.
- **`followPath` drives it.** The same function a shopper walks with and the van
  drives with.
- **A car is already authored content.** `use: 'customer'` rows exist,
  `customerCar()` picks one, and `speed` is read off the row for the van
  (`driveVan`) so a car answers it the same way.
- **`vanRoute` is the template**, including the fallback that makes it safe: no
  lane means no animation and the thing still happens.

### What it actually takes

1. **`carRoute(L, space)` in [server/layout.js](../server/layout.js)** — the
   same shape as `vanRoute`: a straight spur of `DRIVABLE` cells out to the
   border ring, then a clear leg along the ring off the map, shortest wins. The
   difference is arity. `vanRoute` is computed **once** for one bay; a car park
   is up to a dozen cells and each needs its own lane. So it is a map keyed by
   cell, computed in the same breath at the *end* of `compose` — the only point
   where `blocked` is final — and never inside `layoutSoFar`, or a thrown-away
   size probe pays for a dozen lane searches.
2. **A parked car is one fact and a driving car is three.** `parkedAt` is
   deliberately a single field today: it is the claim on the cell, the thing
   `parkedCars()` draws, and where `leaveShop` sends them. A car that drives has
   a position that is not its space, a waypoint list, and a phase — so
   `parkedCars()` stops being a derivation and becomes state that has to be
   stepped. **This is where the cost is**, and it is worth being honest that it
   undoes the nicest property step 4 has.
3. **A customer who is still driving is not yet a customer.** `stepSpawning`
   puts the driver on the space and walks them in from there. A drive-in means
   there is a person in `this.customers` who has not arrived, and every loop that
   walks that object — patience, `turnedAway`, the shop-full test, the HUD count
   — now counts them. **Patience ticking down while somebody is still on the
   approach road is the invisible bug this step has**, and it presents as
   customers who storm out faster the further away they parked.
4. **The way out is the easy half.** `leaveShop` already ends at
   `pathTo(cust, cust.parkedAt)` with a comment naming `carRoute` as the one line
   that changes. The space is held to `despawn`, which is already correct and
   stays correct — a car that freed its cell when its owner joined the queue is a
   pad that holds more shopping trips than it holds cars.
5. **A space with no lane is still a space.** `parkSpaces()` already filters on
   `findPath` to the door; filtering it *again* on having a drivable lane would
   remove spaces, and `parkReach()` feeds `catchment()` — so an animation would
   quietly move the balance. Take the van's rule instead: no lane, no drive, the
   car appears on its space the way it does today. Step 4's numbers do not move.

### Traps

- **One van is free; twelve cars are traffic.** The van gets "one at a time" for
  nothing, because one run *is* one lorry. A dozen spaces means a dozen cars that
  can be on the ring at once, and probably on the same stretch of it. The honest
  answer is that they pass through one another — a van owns no tile either, for
  the same reason. Anything better than that is a traffic system, which is a
  different project and should be named as one before it is started by accident.
- **Raw `dt`, not world time.** `driveVan` takes raw `dt` and `loadVan` takes the
  world clock, and mixing them is invisible until night. A car is a body: raw
  `dt`, or the car park empties six times faster after dark.
- **The car must not be saved.** The van is in memory only, in neither
  `serialize()` nor `persist()`, because a restored position and a half-eaten
  waypoint list sit against a lane `regenerateLayout` recomputes. A car has the
  same problem *and* an owner who is saved, so a reload has to put a driving car
  back on its space, not back on its lane.
- **`parkCache` is keyed on layout identity.** The lanes belong in it, and it is
  already cleared the right way.

### Verify

This is the step that makes the owed `verify:park` sweep necessary rather than
merely owed: a car that got there and a car that was placed there are the same
still frame. The claims worth holding are a lane per reachable space, a
lane-less space still parking, the space held to despawn, no car surviving a
reload, and — the one this step introduces — **nothing about a shopper starting
until the car has stopped.**

---

## Step 6 — a `road` ground kind 🔲

Offered at step 3 and declined; the reason still holds and the reason step 5
changes it is worth writing down rather than rediscovering.

**Today every outdoor cell is a road.** `DRIVABLE` is grass, path, floor and the
three pads, so the van drives across your lawn and the lane is invisible — there
is nothing to see, which is why "the ring reads fine" was the right call with one
lorry on it for six seconds a run. With a dozen cars using it, the ring stops
being a technicality and becomes the busiest ground in the shop.

**Mechanically it is nothing new**, which is the whole argument for it being
cheap: `GROUND.road` → `T.ROAD` = **15**, a new enum number and never a reused
gap, because a save holds `tiles` as raw numbers. Walkable, in neither buildable
set, no `pad: true` — it is a *look* the way `floor` is, not a job the way the
four pads are. `PAD_KINDS`, `BUILD_KINDS`, `groundKindOfTile` and the palette
pick it up derived, exactly as `park` did.

**It must be a preference, not a requirement.** One line in the cost function
that `vanRoute` and `carRoute` share: a road cell scores cheaper than grass, so
a lane you painted is the lane that gets chosen. The moment a road is *required*,
every shop that has not painted one loses its deliveries on the next re-flow —
a new brush that breaks existing saves, which is the worst trade in this
document.

**Do not build it before step 5.** A road with nothing on it is a stripe of
tarmac you paid for; cars driving over somebody's grass is the thing you notice.

---

## What is not built, and why

- **No van upgrade.** Which van the shop drives is derived rather than owned —
  see step 2. `deliveryVan()` is the one function to change.
- **No second van, ever, on purpose.** One run is one lorry.
- **No cancel-an-order verb, deliberately.** An order you can cancel for free is a
  free option, and the wait stops costing anything — which is the whole mechanic.
  A refund-at-a-loss is the version worth having if it ever reads badly.
- **No drive-in or drive-out for a car.** It appears on its space, and it goes
  when its driver reaches it and despawns. `vanRoute` is one lane to the bay and
  there is no lane per parking space. `carRoute` is the line that would change —
  **see step 5**, which is what it takes.
- **No queueing for a space.** Somebody who could not park drove past and walked
  in instead, which is the arrival this game has always had.
- **No `road` ground kind.** See step 3 for why it was declined and **step 6**
  for what would change that — which is step 5 landing first.
- **No `verify:park` sweep.** A 59-assertion proof exists and passed — it authors
  its own `park` row and removes it on exit, the way `verify:break` does — but it
  lives in a scratchpad rather than in `scripts/`. Every claim in it is the kind
  the sweeps exist for: invisible in a screenshot and invisible in play. It
  should be lifted in verbatim.
- **`simulate` cannot report on any of step 4.** `stats.drove` exists and rides
  the snapshot, but `simulate`'s `totals` is a hand-written key list and
  `accumulate` walks nine scalars — so a balance run gives you a profit delta
  with nothing saying how many people it was a delta for. One word in two places.
  While you are there: **`turnedAway` has always reported 0** for exactly the
  same reason, and anybody who has read a balance report for the effect of a full
  shop has been reading a zero.

---

## Questions, settled

- **Does ground get a menu? No — the inbound list lives in the supplier.** That
  is where you ordered it, so it is where you come back to ask what happened to
  it; ground has never been tappable, which makes a pad with a menu a genuinely
  new kind of object bought for one list. The doc argued both sides (the bay
  "shows what is inbound and when, in its own menu" in step 1, the opposite in
  this question) — the second is what was built, and the argument is written into
  the tab's comment in `client/sections.js` so nobody has to come back here.

- **Is a missed cutoff a refusal or a longer wait? A longer wait.** Order at
  14:01 and it arrives at 08:00 tomorrow: eighteen hours, six of them trading.
  Nothing is refused for being late — the only refusal in `buyStock` is the bay
  having nowhere to put it, and that one is checked before the money moves.

- **What happens to an order in flight when the shop reloads? It waits exactly as
  long as it had left.** `ordersOut()` writes `arrivesIn`, both `persist()` and
  `serialize()` go through it so a raw stamp cannot leak by either route, and the
  constructor rebuilds `arrivesAt` from whatever `elapsed` it is handed. What
  does *not* survive is the van itself, which is a separate decision with its own
  paragraph in step 3: the order is the record, the van is the picture, and a
  reload costs one drive-in.

---

## Gotchas this cost

- **`Game.create` never read `orders` back off the save, and had not since step 2
  of ordering.md.** The constructor's defaults won every load, so switching
  auto-ordering off, capping the staff budget or setting a per-item min/max
  survived until the next server restart and no further. Nobody found it while
  the settings were the only thing on that object, because nothing in the game
  contradicts you loudly about a switch. It had to be fixed here rather than
  filed, because a paid-for order that a reload eats is money you never get back
  — and it means a shop whose owner had switched something off starts behaving
  differently than it did yesterday. `simulate`'s `startedWith.orders` was also
  quietly reporting the defaults to itself.

- **A model's stages can be authored outside the range the game can reach, and it
  looks like art rather than wiring.** The van shipped at Empty@0 / Part
  loaded@0.34 / Loaded@0.7. Against a default shop — `crateCapacity` 6, a seeded
  2×2 bay, so `bayRoom` caps in-flight at 4 crates, against a van holding 6 — a
  one-order run is a load of 0.17–0.33 and drew **Empty**: the van arrived
  looking exactly as it left. **Loaded@0.7 needs five crates and is unreachable in
  any shop that has not painted a bigger bay.** That is CLAUDE.md's "a tier that
  changes no number is a button that takes money and does nothing", in art form,
  and the only way to catch it is to compute what the number can actually be.
  Moved to 0 / 0.01 / 0.5.

- **…and that fix is in the database, so the seed file is a second opinion.**
  `data/seed/vehicles.json` still holds the old thresholds. **Someone must run
  `npm run export` before committing**, or a fresh `npm run seed` reintroduces a
  van that always looks empty — and it will read as the renderer being broken,
  because the live shop it was tested in looks right.

- **Anything on the snapshot that counts down cannot be in a repaint key.** The
  supplier's `live()` was `JSON.stringify(ui.state.orders)`, and `pending[].in`
  is seconds-remaining recomputed every tick — so from the moment step 1 landed,
  an open supplier with an order out rebuilt forty rows of innerHTML ten times a
  second for the entire six hours. `live()` is nine named fields now, and it
  gained shelf holdings while it was being written: the count column has read
  `heldOf` since the panel was rebuilt and only ever redrew because
  `Math.floor(cash)` happened to move at the till, so a stocker filling a board
  in a closed shop did not repaint the list.

- **A sweep can encode the very claim you are retiring.** `verify:yard` asserted
  on `g.deliveries` in the same tick as `g.buyStock(...)` — which is precisely
  what step 1 makes false — so three of its assertions failed and the code was
  right. The fix is a `vanArrives(g)` helper that steps the clock until
  `orders.pending` empties, and it is also the right shape for step 3, because
  the van's whole drive happens inside that loop.

- **The two halves of a delivery run take different clocks, and mixing them is
  invisible until night.** `loadVan` is a decision about the *world* — is there a
  run due — and rides the world clock, which the night speeds up. `driveVan` is a
  body moving and gets raw `dt`, or a lorry goes six times faster after dark. The
  same split is why `nextRun` measures its wait in seconds of `elapsed` rather
  than real seconds: a wait measured in real time would have the morning van
  arrive six hours late every night.

- **A guard can be correct, tested and unable to fire.** `bayRoom` caps in-flight
  at `cells × crateCapacity` — 24 units on a seeded yard — and the shipped van
  holds 6 crates, so the van's own capacity can never bind and the two-trip path
  is unreachable until somebody paints a bigger bay. It is tested with a van
  stubbed to hold one crate and it works. The bay cap itself was re-run across
  ten seeds with the guard bypassed and gave byte-identical numbers.
  `startedWith` now reports `bay: { cells, holds }`, so a run against a shop with
  a painted stockroom is visibly a different experiment.

- **Restarting the van on every re-flow means a van that never arrives.** A
  player who is *building* re-flows constantly, so `regenerateLayout` drops an
  inbound van only when the dock actually moved. Same family as the re-flow bug
  that used to restart shoppers who had already paid.

- **`%` keeps the sign of the dividend in JavaScript**, so the usual one-line
  shortest-arc idiom returns an angle below −π whenever the gap is negative
  enough. It could not have fired with the headings the van is handed today,
  which is exactly why it would have survived to bite something later.

- **`Infinity - Infinity` is `NaN`, and a `NaN` comparator does not throw — it
  silently stops sorting.** The inbound rows sort on time-to-arrival and the
  no-order sentinel has to be a large finite number.

- **A pad needs four things beyond `GROUND`, and two of them fail silently.** No
  `TILE_STYLE` row renders the tile as a hole in the ground; no authored piece
  row and the palette drops the tool entirely, so the feature is simply absent
  with no error anywhere. And `create_fixture`'s `kind` in `mcp/server.js` is a
  hand-written `z.enum` — a second spelling of `BUILD_KINDS` that has to be
  updated by hand, and which refused `park` until it was. The honest route while
  it was stale was POSTing to `/api/content/fixture`, which is the same
  `writeContent` gate MCP wraps, minus the enum.

- **Dimming a whole column also dims the half that is news.** `.row .held.zero`
  faded the count when you held none of something — which is right until a green
  `+6` appears next to it, at which point the one thing the row is trying to say
  is greyed out. The dash is dimmed on its own now.

- **The MCP tool list can be stale in a session while the game server is
  current.** `create_vehicle` did not resolve and `list_content`'s enum had no
  `vehicle`, hours after both were live over HTTP. That reads as "the feature
  isn't built"; it means restart the MCP server.
