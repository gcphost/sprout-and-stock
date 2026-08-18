# Deliveries — the van, the wait, and the car park

Status: **steps 1–7 built.** An order is a promise that joins a run and lands
hours later; the van is a content row somebody drew; it drives in along a lane
computed once per layout, unloads with `dropGoods` and leaves; the car park is a
pad you paint that shoppers actually drive to, take a bigger basket out of, and
walk in from; their cars now drive that lane too, in and out; and a road and a
pavement are brushes that decide which way in they take, on wheels and on foot.
`npm run verify` is green across all fifteen sweeps.

Steps 5 and 6 closed the asymmetry step 4 left behind — **the van had a lane and
the cars did not** — and the second half of that is why the road waited: one
lorry for six seconds a run could cross a lawn and nobody minded.

What is *not* built is at the bottom, and none of it is unfinished work — it is
the list of things nobody has needed yet: a bigger-van upgrade, a way to cancel
an order, a queue for a parking space, and a car that can turn round when the
shutters come down mid-drive.

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

**A run, not a timer.** `DELIVERY_RUNS` at the top of
[server/sim/index.js](../server/sim/index.js) is **every hour, round the clock**,
and an order joins whichever run is next. That is the difference between "wait
five minutes" and a supply chain: everything ordered before the cutoff comes
together, which is what makes a minimum worth setting and a maximum worth
thinking about. It also means one van animation per run rather than one per
button press.

The cadence is flat on purpose, and it has been all three ways. Two runs a day
(08:00 and 14:00) was a rule you got caught by — missing the morning by a minute
cost five trading hours and there was nothing you could have done differently.
Two-hourly while open and hourly once shut was the correction, on the argument
that a wait is a decision while the doors are open and dead time after; that
reads well and plays badly, because the half it slows down is the half you are
stood in the shop for, and a cadence that changes with the clock is one more
thing to hold in your head. An hour is now the whole rule: the longest anyone
waits is an hour, whenever they ask.

The comparison in `nextRun` is strict, so an order placed at exactly 09:00 is on
the 10:00 van rather than the one pulling away. That is the cutoff doing its job,
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

## Step 5 — a car drives in and out ✅

A shopper's car used to *be* wherever its driver parked it: put down on the cell
at spawn, deleted with them at despawn. It arrives now — eight tiles off the
map, down the lane, into its space, and back out again when its driver is done —
which closes the asymmetry step 4 left behind, that the van had a lane and the
cars did not.

`carLanes(L, cells)` in [server/layout.js](../server/layout.js) is the van's own
lane finder, generalised. `vanRoute` and it are two callers of one `laneFinder`:
a straight spur of `DRIVABLE` cells out to the border ring, then a clear leg
along the ring off the map, cheapest total wins. **The van stops one cell short
of the bay and a car stops in its space** — goods land on the pad and a lorry
parked on the crates it just put down is a picture of the wrong thing, while a
car beside its bay rather than in it is a car park that does not work.

### Where the lanes live

In `parkSpaces()`, on the cell, beside the A* that was already there. The doc
argued for `compose` — wrong, and the reason is timing rather than tidiness:
`compose` runs `layoutSoFar` as a size probe and throws it away, so a dozen lane
searches would be paid for on every probe and by every headless sweep that never
draws a car. `parkSpaces` is already memoised against layout identity, already
once-per-re-flow, and already reads the finished layout. The lanes ride in free.

### A customer who has not arrived

`DRIVE` and `DEPART`, and `inACar` is the predicate — the shape of the whole
step. Four loops walk `this.customers` and every one of them meant *people in my
shop*, which was true for as long as the only way into that object was to be
standing in one:

- `measureOccupancy` — the crush everyone inside is fed up with, and the crush an
  arrival balks at. A queue of cars is not a crowded shop.
- `moodAverage` — what the shop's mood reads.
- `snapshot().customers` — or you draw a shopper skating up the road with their
  arms out, inside the car that is also being drawn.
- **`stepMood` — the one that costs money.** `patience` is a budget the shop
  draws on and the road is not the shop. Ungarded, the further away somebody
  parked the crosser they arrive, and what you see is shoppers storming out of a
  shop that has done nothing to them.

The body rides along with the car (`cust.x/z` track `drive.x/z`) even though
nothing draws it, because a position that is a lie is a position something
eventually reads — here it is `regenerateLayout` asking who is off the tile grid.

### `parkedAt` split in two

It was one field on purpose while a car never moved: the claim on the cell, the
thing the renderer drew, and where they walk back to were one fact. A car
halfway down the lane is somewhere its space is not, so `drive` is the body —
`{x, z, facing, path, phase}`, the same shape `followPath` drives and the same
shape the van is — and `parkedAt` is now only the claim.

**The claim is held from the tick they set off to the tick they despawn**, which
is later than it looks: right through the drive out. Freeing it as the car pulled
away would put the next arrival down on top of one still reversing off.

### What the renderer needed

Nothing. `syncVehicles` already drew a list of `{id, vehicle, x, z, facing}` and
already eased vehicles per *frame* rather than per snapshot, because a body at
lorry speed judders at 10Hz. Cars that move went down the same path the van
already used, and `client/` has no idea anything changed.

### Where the design was wrong

**A re-flow must park a car, not restart it.** The doc took the van's answer —
go home and come back — and it is wrong here for a reason the van does not have.
A player who is building re-flows on every wall segment, so a car that started
its approach again each time never arrives at all: the shopper inside it is a
customer who never happens, in a shop being extended precisely because it is
busy. `parkNow` is the answer, and it is the same function arriving normally
calls. One going *out* keeps going, which is the van's rule unchanged.

**A car parked at the angle it was travelling is parked across the bay.** The
last leg of a lane runs along the road, so `followPath` leaves the nose pointing
down it. `parkNow` sets the car down on the exact cell at `parkedFacing` — the
facing worked out once when the space was claimed — rather than wherever the
waypoint left it. Invisible in the code and obvious in a screenshot, which is the
opposite of everything else in this step.

**Shutting the shop mid-drive deletes the car.** `lastOrders` despawns a `DRIVE`
customer exactly as it despawns an `ENTER` one, and that is a limit rather than a
decision: turning a car round needs a manoeuvre nothing else in the game has, and
the alternative — let it park and pop at the space — is the same flaw one second
later. It can only happen in the tick the shutters come down with a car on the
lane.

### Verify

[`npm run verify:park`](../scripts/verify-park.js) — **113 assertions**, and it
is the fifteenth sweep. Every claim in it is invisible in a still frame by
construction, because a car that arrived and a car that was placed are the same
picture: no car park is the old game exactly, one lane per space ending *on* the
cell, a lane-less space still being a space, the patience budget untouched by the
journey (with a control that shows the same seconds in the shop do cost it), the
space held end to end, and a re-flow parking rather than restarting.

---

## Step 6 — a `road` ground kind ✅

Offered at step 3, declined, and step 5 is what changed the answer: one lorry on
the ring for six seconds a run could drive over a lawn and nobody minded, and a
dozen shoppers' cars using the same stretch make it the busiest ground on the map.

`GROUND.road` → `T.ROAD` = **15**, a new enum number and never a reused gap,
because a save holds `tiles` as raw numbers. Walkable, in neither buildable set,
and no `pad: true` — it is a *look* the way `floor` is, which makes look-ground
and job-ground the whole taxonomy: two kinds carrying a surface and four carrying
a sentence about what happens on them. `PAD_KINDS`, `BUILD_KINDS`,
`groundKindOfTile`, `canPaintGround` and the palette picked it up derived, and
`npm run docs:fixtures` documents it with no branch.

**It is a preference and never a permission.** `DRIVABLE` has included `GRASS`
since the van first drove, so every outdoor cell in the game was already a road;
`ROAD_COST` 1 against `OFF_ROAD_COST` 2 is the entire mechanism, and it only ever
changes which legal lane is *chosen*. Pointed the other way — ground a vehicle
must have — it would be a brush that breaks every shop in the world on the
re-flow after it ships.

**A shop with no road comes out exactly where it did**, and that is arithmetic
rather than a promise: with every cell the same price each candidate is scaled by
one constant, and scaling both sides of `best.cost <= cost` compares the same two
lanes in the same order, ties included.

### Where the design was wrong

**The border ring cannot be painted, so the *ring leg* can never be tarmac.**
`canPaintGround` has refused row 0 and column 0 since the yard — "the seed may
only lay ground the player could lay" — and the leg along the border is exactly
that ring. The doc assumed a road would make the whole route cheaper; what it
actually prices is the **spur**, the straight run from your bay or your space out
to the border.

That turns out to be the better design and the doc should have said it: **the
ring is the public road and you cannot paint it because it is not yours. What
you paint is the driveway.** And the driveway is the decision — it chooses which
ring cell you come out on, and therefore which side of the map the van arrives
from. Measured in the sweep: a bay whose van came down the north ring re-routes
to the west the moment a drive is laid west out of it.

**Filing it in the palette took three goes, and the two wrong ones were wrong in
opposite directions.** Yard and Customers were the obvious first move and both
hide it behind half of what it is for — the lorry and the shoppers' cars drive
the same tarmac. So it went under **Floors**, on the grounds that road and floor
are both ground that is a *look* while the four pads carry a job. That is true
and it is not what anybody is looking for a road under: it files by how the
thing is implemented rather than by what somebody has in mind when they reach for
it. **Roads** is its own sub-tab now and holds the pavement too, which is the
filing the player would have made — *how everything gets here*. The lesson is
worth keeping, because the wrong answer was the principled one: a taxonomy the
code finds satisfying is not automatically a menu.

---

## Step 7 — the pavement, and the crossing ✅

The road's pedestrian twin, and the cheapest step in this document: **`T.PATH`
was already in the game.** The generator has laid a strip from the door out to
the fields since long before ground was paintable, so it was hardcoded scenery
in exactly the way the delivery bay and the drop-off were before step 13 of
[building.md](building.md) — a thing you could see, could not move and could not
have more of. `GROUND.path` is that promotion, and it costs one row: no new enum,
no new colour, no renderer change, and the generated strip becomes ground you
could have painted (which the yard's rule says it always should have been).

**Feet prefer it.** `findPath` charges a step now rather than counting one, and
the two numbers are the road's bargain said about people: paving is 1 and
everything else outdoors is 1.25. That direction is forced rather than chosen —
`h` is Manhattan distance and is only admissible while no step costs less than
1, so a *discount* on pavement would quietly turn A* into something that returns
a route rather than the shortest one.

**Indoors every step is still exactly 1.** Nothing in a shop is ever pavement, so
a uniform surcharge in there would change every score, leave every ordering
identical and cost real time — a weaker heuristic expands more nodes, and in-shop
pathing is the hot loop in this game. The sentence it comes to is also the true
one: *inside a shop, the floor is the path.*

**A crossing is a design, not a kind**, and that is the argument for pavement not
being a second road. `T.PATH` has been in `DRIVABLE` since the van first drove,
so a striped design painted across a lane is drivable *and* the thing feet
prefer — which is precisely what a pedestrian crossing is. It needed one new
`surface.pattern` (`stripes`, bands one cell wide along z) and nothing else. It
is the only pattern whose *direction* means anything: laid east–west it reads as
bars across your way, north–south as rails along it.

### Where the design was wrong

**It shares a sub-tab with the road, and that tab did not exist yet.** Pavement
went to Floors beside the road for one commit and came straight back out with
it — see step 6. Two brushes about *getting here* is a tab; one of them filed
under how it is drawn is a brush nobody finds.

**"A sidewalk needs a texture" — it had one, and that was the whole feature.**
The instinct is to author a new tile, a new colour and a new brush; the work was
to notice that the thing already existed with no row behind it. Look for the
hardcoded version before drawing the new one.

**1.25 is not a speed.** What a step costs the *search* and what it costs the
*walker* are different questions, and nobody moves faster on paving. Making it a
speed is the version to refuse: it turns a look into a balance change and would
need `simulate` re-run every time somebody paved a yard.

---

## Step 8 — the starting world has a front, and the cars are car-sized ✅

Two things at once, because neither reads right without the other.

**A car was smaller than the shopper who got out of it.** The `shopper-car` body
was 1.16 × 0.62 tiles against a person 0.68 across — a toy, and it made every
piece of ground under it look wrong rather than looking like a scale bug in the
art. The models are 1.75× on the floor plan now (x and z only; the height was
never the problem and a car as tall as it is long is a bus): **2.05 × 1.21** for
a car, **2.73 × 1.29** for the van. Content, not code.

**So the ground under them grew too.** A car 1.21 wide hangs off a one-cell lane
and parks across three cells of a one-cell pad:

- **A road stroke is `ROAD_THICK` cells thick**, whatever you dragged — one drag
  is one road. It lives in `groundStroke`, which is the one function the ghost
  and the server both run: the client sends the two ends of a drag and never the
  cells (the 4KB inbound cap), so a width rule the preview applied and the server
  did not is a green ghost promising a road the shop refuses. It widens towards
  the higher coordinate and away from it at the edge of the map — which is not a
  nicety, it is the seeded street: that sits in the bottom paintable rows, and a
  brush that only grew downward could never redraw the road the world starts with.
- **A parking bay is two cells**, paired greedily along the nearest-the-door sort
  `parkSpaces` already did. A lone cell is *not* a bay — an odd row parks one
  fewer car, which is the honest answer and one a player can see coming. The bay
  carries its own `mid` (where the car is drawn) and `facing` (along the bay, so
  it is not parked across its own markings); `parkedAt` stays the anchor cell,
  because that is the tile A* can route a driver out of and the car's midpoint is
  on the line between two of them. `PARK_HALF` halved from 6 to 3 with it: the
  geometry changed and the balance was not meant to.

**And the starting world has a front.** The farm flanked the path out of the door
for as long as there was nothing else for the front to be, which put the fields
between the shopper and the shop. Now: yard behind, fields down the east flank,
and a street across the bottom — `defaultStreet`, laid by the same one-time mark
`defaultPads` is, so **no existing save grows a road overnight**. No car park is
seeded, and that is not tidiness: `parkReach` feeds `catchment`, so a seeded pad
would change what a new shop earns on day one. The road is the invitation; where
the cars stop is the decision this whole feature is for.

```
 4  ........BBBB..SSSS........     B bay   S storage
 5  ........##########..p.p.p.     # shop  p plot
15  ........##########........
16  .............==...........     = pavement
20  .========================.
21  .RRRRRRRRRRRRRRRRRRRRRRRR.     R road, two cells thick
22  .RRRRRRRRRRRRRRRRRRRRRRRR.
```

### Where the design was wrong

**"Make one road tile look like two" is not a thing a tile grid can do.** The
first reading of the complaint was a rendering one — draw the lane wider than the
cell it is on. Everything downstream is honest about cells: a car drives to tile
centres, a bay claims a cell, the lane finder walks cells. The fix was to make
the *things* the right size and then give them the right amount of ground, which
is two real changes rather than one lie.

**A sweep can encode the world it was written in.** `verify:floor` looked for
open grass by scanning the rows below the building, because that was where the
open grass was. The street paved two of them and the farm moved to the flank, so
it found none and died on a null. Same shape as the `verify:yard` note further
down: the sweep was right about the game it was written for.

---

## What is not built, and why

- **No van upgrade.** Which van the shop drives is derived rather than owned —
  see step 2. `deliveryVan()` is the one function to change.
- **No second van, ever, on purpose.** One run is one lorry.
- **No cancel-an-order verb, deliberately.** An order you can cancel for free is a
  free option, and the wait stops costing anything — which is the whole mechanic.
  A refund-at-a-loss is the version worth having if it ever reads badly.
- **No queueing for a space.** Somebody who could not park drove past and walked
  in instead, which is the arrival this game has always had.
- **No traffic, on purpose.** A dozen spaces is a dozen cars that can be on the
  ring at once, probably on the same stretch of it, and they pass through one
  another. A van owns no tile either, for the same reason — the alternative is a
  traffic system, and it should be started deliberately rather than by accident.
- **No turning round.** Shut the shop in the one tick a car is on the lane and it
  is deleted, exactly as a walker on the approach is (`lastOrders`). Reversing a
  car needs a manoeuvre nothing in the game has, and letting it park first is the
  same pop one second later.
- **A road cannot be laid on the border ring**, so the leg *along* the border is
  never tarmac — see step 6. That is the design rather than a limit, but it is
  the first thing somebody will try.
- **`simulate` cannot report on any of steps 4–6.** `stats.drove` exists and rides
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
