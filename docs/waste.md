# Waste — the shop's way out

Status: **step 1 built.** 2–3 proposed.

---

## The hole

Stock had exactly two exits: somebody bought it, or it rotted at midnight. Both
happen *to* you. There was no way to be rid of anything **on purpose**, and that
bites hardest at the two moments the shop is already going wrong — a line nobody
wants, and a harvest of the crop you had just stopped growing.

`dropGoods` was the only answer the game had, and a crate in the yard is not
getting rid of something, it is moving it. Worse, it is moving it somewhere that
costs: `padRoom` is what the farm and the kitchen are gated on, so goods you
cannot shift eventually stop the shop producing.

And rot was invisible. `spoilStock` deleted the stack at the day roll and wrote
a line in the log, which is honest about the money and says nothing about the
shop — a tenth of everything the place handles evaporating overnight while the
crew stand about.

---

## Step 1 — the skip

A new `BUILD_KINDS` entry (`bin`) and one authored piece. Blocking, `useAt`,
`where: 'any'` — rubbish goes out the back, and the back of the shop is
outdoors.

It does two jobs that look like one, and the line between them is the whole
design:

| | Who | What |
|---|---|---|
| **Throw away** | you | `binGoods` — both hands at once, free, irreversible |
| **Take the rubbish out** | your crew | part of the `tidy` job — **`waste` crates only** |

### The line, and where it comes from

docs/workers.md already drew it, about the shop hand:

> Clear is not a bin — it is the shop putting something back in the stockroom.
> That is why it is `dropGoods` and not a sell-back: what something is worth is
> the player's question, and a worker answering it is a worker spending your
> money.

So a hire may carry out what has **already rotted**, because that is worth
nothing and no judgement was made. A hire may never decide six loaves are not
worth keeping. `tidy` refuses anything without the flag, and that refusal is
the claim `verify:bin` section 4 exists for — a crate of good bread walked to
the tip and a crate of rot walked to the tip are the same picture.

### ...and it is not a job of its own

It shipped as one — `binning`, its own entry in `JOBS` — and that was a record
to say a thing the shop already had a word for. **Taking the rubbish out is
tidying up.** The cost of the extra name was not tidiness, it was that every
one of the five authored worker kinds carries `tidy` and none of them carried
`binning`: a live shop stood **305 units of rot beside a skip it had paid
for**, with seven hires who were all, in their own terms, cleaning up. And the
mechanic was complete — implemented, swept, passing — which is why nothing
anywhere said a word.

The general shape is worth keeping, because the next routine will look like
this too: **a new routine is a new branch, not a new job.** A job is a sentence
the player assigns; a routine is one of the things that sentence covers. Adding
to `JOBS` means re-authoring every kind in the game — and if you forget, the
feature is not broken, it is unreachable, which looks identical from inside the
shop. Ask whether an existing job's sentence already covers it before spending
a name on it.

### A box on the floor is in the way

Crates were ghosts until this: shoppers walked through them, they took no floor
room, and a shop under thirty boxes of rot cost exactly nothing. The one state in
the game where what you can plainly *see* is wrong was free.

Two halves, and each is a different question about the same box.

- **In the way.** A shopper pays `CLUTTER` (8 steps) to cross a tile with a crate
  on it, so in any shop with a way round they walk the length of an aisle instead.
  Deliberately a **price and not a wall**: crates land wherever goods are let go
  of and go through no placement validator, so a hard block is a room that can be
  sealed by accident by a hire doing their job correctly — the `TIRED_PACE` pin
  said about customers. Boxed in, a shopper climbs over, unhappily.
- **A tip.** `measureMess` is the share of walkable indoor floor under boxes, and
  it draws on patience the way the crush does. Counted **by tile**, because a
  hundred loaves in one box is one thing to look at. **Rubbish counts double** —
  that is the only thing that makes a skip worth something to a shopper rather
  than to your conscience. **Indoors only**, the opposite of the routing half: a
  yard full of crates is a yard doing its job.

Staff are exempt from the routing cost, and that is not a nicety — a rule that
kept them out would make the mess permanent at the moment it started to matter.

### Rot becomes a thing on the floor

If — and only if — the shop owns a skip, `spoilStock` stops deleting and calls
`dropWaste`: a crate marked `waste`, standing where the shelf is, for somebody
to carry out.

Two rules keep it from being a mechanic nobody asked for:

- **Opt-in.** A shop with no bin is the old game to the unit. That is every shop
  that exists today, and it is what stops a shop that has never thought about
  rubbish filling up with it.
- **The money is unchanged either way.** `spoiledValue` is counted when it rots,
  not when somebody gets round to carrying it out. What is in that crate is
  worth nothing and is already in the P&L.

It goes down **at the shelf**, never on a pad — rot happens where the food was,
and rubbish that landed on the drop-off would stop your beds being picked days
later with nothing to connect the two.

### `waste` is on the CRATE

Not on the stack. A flag per pile would mean `lotAdd` merging good goods into a
rotten pile, and the mixing rules would have to learn about a third thing on
every path.

The trap this feature is really about is the one CLAUDE.md records for
`inACar`: **a container whose membership used to imply a fact stops implying it
the moment something can be in it that is not that fact.** Ten loops walk
`deliveries` meaning "stock", and each is a different kind of wrong about
rubbish — `homeSupply` would stop the shop reordering what just went off,
`unload` would shelve it, `craft` would cook with it, `bayRoom` would report a
bay full of rubbish not standing on it.

So there is **one spelling**: `Game.stockCrates()`. Three readers keep the whole
list — the renderer (rubbish is a thing you can see), your own hands (you may
pick it up and carry it out), and the bin job.

Both directions of the merge are refused: `dropWaste` never joins a crate of
goods, and `dropGoods` never joins a crate of rubbish. The second is the one
that would actually happen — a stocker tidying an armful down beside yesterday's
spoilage.

---

## What is deliberately absent

- **The skip does not fill up.** A capacity would need emptying, which is a
  second job, a second readout and a second way for the shop to jam — modelling
  a chore nobody is asking for. What goes in is gone; what limits it is the walk.
- **No fee and no refund.** Charging is the trap `stow` already documents: it
  punishes exactly the moment somebody is experimenting, and what people learn
  is to stand there holding it. Refunding would make the skip a second, worse
  till.
- **No auto-disposal of written-off lines.** The shop stopping stocking
  something is a judgement (see the `orders.dropped` work); *destroying* it is
  not the same call, and it is yours.

---

## Proposed

**Step 2 — rubbish is worth something to somebody.** A collection that pays a
pittance per unit, or charges for the lift. Would give the skip an operating
cost and make "how much do I throw away" a number rather than a habit. Needs
`simulate` before and after; step 1 deliberately moves no money at all.

**Step 3 — the bin as a target for the shop hand.** Today Clear walks a dead
board to the drop-off and marks the item. With a skip in the shop there is an
argument for offering *you* a one-press "and bin it" on that log line. It stays
the player's press — that is step 1's whole line — but it saves the walk.
