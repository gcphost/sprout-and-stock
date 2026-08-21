# The tutorial

*A robot who shows you round a shop you have just made, and holds the rest of
the game still while it does.*

Status: **step 1 built**, plus the guest tour (1b). Steps 2–4 proposed.

---

## Why

Every verb in this game is a **gesture**, and not one of them is discoverable by
pressing things.

A tap is one unit and a hold is the lot. The right button is the same pair
pointed the other way. A hold at a shelf across the room buys the *walk*, and
the button staying down for the journey is the whole trick. A drag along a wall
builds a run, a drag over the ground paints a floor, and the one that decides
which is a flag on the palette entry rather than anything you can see. None of
that is written down anywhere a new player will read it, and all of it is
load-bearing.

Meanwhile a brand new shop opens **shut, empty and silent**: a building with two
shelves and a till in it, no stock, nobody working there, and a rail of eight
icons up the right-hand side with no reason to press any of them. The one thing
the game used to say was a welcome toast — three instructions across the top of
the screen at the moment you have least idea what any of them are about, gone
before you could want them — and it was deleted rather than rewritten, because
the shape was the problem as much as the words (see `openWorld`).

So this is the one screen in the game that tells you what to do next. It earns
that by being **narrow**: one instruction, one lit target, everything else
blacked out and unpressable.

---

## Step 1 — the tour *(built)*

`client/tutor.js`, plus a `#tutor` element and its styles, plus two rows in the
Menu and one attribute in `bar.js`. **Ten beats:**

| | teaches |
|---|---|
| 1 Hello | who is talking, and that there is a way out |
| 2 Walk | left-click the floor; and that left-clicking a *thing* is a walk plus a job |
| 3 Buy stock | the supplier, and that goods arrive on a lorry rather than out of a menu |
| 4 Take on a Clerk | the crew are leased machines; the strip; the two-click confirm |
| 5 Their shift | that a hire's day is a ratio **and** a budget |
| 6 Build a chiller | the palette, the price, the green/amber ghost |
| 7 Take one out | **left takes one, hold-left takes the lot, right puts one back, hold-right pours** |
| 8 Shelve it | the chevrons — the shop tells you which unit will have it |
| 9 Shoulder the crate, tip it in | the same four presses at scale, and why a box beats your arms |
| 10 Open up | the shutters, which is why the shop was quiet the whole time |

It was eighteen — one card per press — and eighteen cards is a lecture: you stop
reading around the fifth and start hunting for Skip. The saving is not in
teaching less. It is that **a step moves its own spotlight**: `at` and `say` are
asked every frame, so "open the crew strip, then click the Clerk on it" is one
card whose hole walks from the rail button to the tile the moment the strip is
up. That is the rule for adding a beat — **a card per decision, never a card per
press.** Two presses with one outcome between them are one card.

The order is not arbitrary either. Stock is ordered at beat 3 and collected at
7, and the three beats in between are the ones that do not need it. A tour that
ordered a delivery and then watched the clock would be teaching you the game is
slow.

### What is load-bearing

**It is entirely client-side.** Nothing in `server/` knows it exists, nothing is
on the save, and it sends no message the game did not already have. That is
deliberate rather than lazy: a tutorial is a fact about a **person**, not about
a shop — the second world you make should not explain the walk key again — so
it lives in localStorage beside `sns-me` and `sns-name`. It also means a shop
played by two people does not put a veil over the other one's screen, and it
means this whole feature can be deleted by deleting one file.

**A step is a PREDICATE, never a press it intercepted.** Every `done` is a
question about the snapshot — `state.roster` grew, `p.haul` is set, the shutters
went up, this hire's shift is not the shift it was. So the only way past a step
is to *actually do the thing*, with any gesture, from any menu, including one
the step never mentioned. Watching for a click on the button we lit would give a
tutorial that wedges the moment somebody uses the keyboard shortcut, and one
that can be satisfied by a press the server refused.

**The veil is four boxes, not a hole punched in one.** A veil with
`pointer-events: none` blacks out without *muting*, and muting is the half that
matters — the whole promise is that the wrong button cannot be pressed. Four
blockers arranged round a rectangle means the hole is a genuine absence, and the
press that goes through it is the ordinary press the game already handles: no
forwarding, no synthetic events, no second opinion about what a click on a shelf
does.

**It refuses to block the world.** Every step whose target is a thing standing
in the shop lights the canvas whole and drops a pulsing ring on the target,
pinned through `Scene.worldToScreen` every frame. Two reasons it is not a
rectangle. A shelf is a three-quarter-tile box drawn most of a tile *up-screen*
of the ground it stands on, so a box round where the pointer ought to go is a
box in the wrong place — the same trap `pickFixture` exists to answer. And a
crate is not a fixture, so `setMarkedSet` (which wants an `f`) has nothing to
hang on; one ring in screen space answers for a crate, a shelf, and the bare
tile you are asked to walk to, which is none of the above.

**A hole is a place to work, and it cannot name a press.** The buying beat lights
the whole supplier, deliberately — *which* case you buy is the half of that step
that is yours — but a lit panel of forty rows wearing forty identical `×6`
buttons says nothing about what ends the card, and the one press being asked for
is 200px below the sentence asking for it. `pulse` on an `at` is a second
selector, measured every frame the way the hole is and drawn with the same mark
at button size. It **cuts nothing** (the veil is `at.el`'s business, so every
other row stays pressable) and it **never sets `lost`** — a frame where the
button is not in the document is a frame with no pulse, where `lost` would be a
blackout offering to give up on the step. Two things it needs that are not
obvious: the target has to be *clipped to its scroller*, because
`getBoundingClientRect` answers for a row scrolled out of a panel exactly as it
answers for one you can see (an unclipped mark pulses over the search box —
`holeFor`'s `scrollIntoView` note is the same trap from the other side); and the
button has to be **nameable**, which is `data-btn-tag` beside `data-btn` for the
reason `data-entry` sits beside `data-slot` — an index into a list that re-sorts
is not a name. Only the ordering press carries the tag: Cancel and Stock are the
same slot saying something else.

**Three answers to "where is the hole", and the third is what makes it safe.**
A step with no target at all wants the veil *whole* — that is the first and last
card, which are read rather than acted on, and which carry a button. A step that
named a target and cannot find it wants **no veil at all**: a crate somebody
else unloaded, a tile of the bar in a tab you browsed away from, a panel
mid-render. It does not know what to light, and a blackout with no hole in it is
a game nobody can play. `lost` is that third answer, and after six seconds of it
the card grows a *Carry on* button — the smaller press, which gives up on the
step rather than on the tour.

**It may never trap you.** Skip is on every card. Esc skips, on capture, so the
game's own Esc cannot close the menu the veil is pointing at and leave the card
asking for it. The whole thing switches off from the Menu — and switches back
on from the same two rows, because skipping marks the world done, so without a
Replay the press that says "not now" is a press that says "never", on the one
screen where somebody has least idea what they are turning down.

### The one attribute this cost elsewhere

`bar.js` tool buttons carry `data-entry` (the entry's own id) beside the
`data-slot` index the press is wired off. Something outside that file has to be
able to *name* a tile, and an index cannot: a slot number is a fact about
whichever tab happens to be open, so the shelf that is slot 3 this morning is a
chandelier once somebody authors a lamp.

### Where the marks live

Three keys, and the split is the whole of when the tour runs:

- `sns-tutor-off` — the switch. About the **person**, so it spans every shop.
- `sns-tutor-done` — worlds this browser has finished *or skipped*.
- `sns-tutor-new` — worlds this browser **made**.

`markWorldNew` is called by the new-shop form and never inferred from `day === 1`,
because that is also true of a shop somebody made yesterday, closed on the first
morning and came back to — and being handed the tour again on a shop you have
already furnished is the thing that makes people switch tutorials off for good.

### It has to be told which grammar is live

Every verb in this game used to be a mouse button, and half of what the tour
teaches is *which* button. On a phone there is one: the verbs live on the pill
along the bottom, and a tap on something you are stood at **names** it rather
than doing anything to it. So "right-click a shelf" is not clumsy phrasing
there, it is an instruction that cannot be followed — and a card that says it
puts the player through exactly the sequence that reads as a broken game, which
is worse than no tour at all.

`perInput(mouse, finger)` is the fork, over `pillDrives()` from `client/input.js`
— the same test `tapAtPointer` and `pressHints` ask, so what the tour SAYS and
what a press DOES cannot drift apart. It is a file of its own because ui.js
imports sections.js imports tutor.js, so keeping the test in ui.js would close
an import cycle nobody meant. It is asked at paint time, never at module load:
`say` and `hint` are re-read every frame and a window can cross the line
mid-tour.

Two of the twelve beats are not the same sentence with a different verb in it,
and those are the ones worth reading before adding a beat:

- **take-one** — "click it again to take one out" has no finger version, because
  the second press is on the bar, not on the crate.
- **freezer** — placing turns with `R` or the wheel, and a phone has neither.
  That gap is why `#rotbtn` exists (`syncRotate` in ui.js): a round button beside
  the bar, shown only where the pill drives and only over a *fixture* ghost — a
  wall, a floor and a brush have no facing, and a button that turns nothing is
  the "tier that changes no number" trap wearing a fingertip. The two standing
  build hints name it in the finger grammar for the same reason the tour does.

A world step's hole is the whole `#game` rect, so the pill sits inside the lit
area and stays pressable — which is what makes a bar-driven beat finishable at
all under the veil.

---

## Step 1b — the guest tour *(built)*

`maybeStart` asks three questions about a **world**, and a guest has no world:
`openAsGuest` deliberately puts nothing in the address bar, because the shop is
not theirs. So for the whole of co-op the one person in the game who had never
seen it before was the one person the tour never ran for.

`GUEST_STEPS` is a second array, swapped in whole by `guestStart()` rather than
filtered out of the first. **A guest is a second shopkeeper, not a lesser one** —
`shop.js` gates nothing, so hiring, upgrades, building and the shutters are all
theirs to press, out of the same drawer — and the cards say so. What the tour
drops is not what they *cannot* do but what is not theirs to decide in the first
minute: spending their friend's takings before they can walk. What is left is
the half about a pair of hands — take one, put one on, hold for the menu — which
is also the half nothing else in the game explains.

Two things are load-bearing:

- **Every predicate is a delta, never a level.** "There is stock on a shelf" is
  a real question in a shop you just made and a tautology in one that has been
  trading a hundred days — the whole tour would complete in the first frame and
  end on a toast about something nobody saw. Each beat records what was true
  when it opened (`start`) and asks what has changed; the two about your hands
  latch what they have seen, since empty hands are both the before and the after.
- **The mark is a person, not a world.** `sns-tutor-guest` is one flag, where
  `sns-tutor-done` is a list of worlds. The host's tour is about a shop, so a
  second shop earns a second telling; the guest tour is about gestures, so being
  walked through it again at the next friend's place is nagging.

Not wired: the Menu's Replay row reads `ui.worldId`, which a guest does not
have, so a guest cannot replay their tour. Clearing the flag is the fix if
anybody wants it.

## Step 2 — the second lesson *(proposed)*

The tour stops at "you can run a shop". It says nothing about the farm, the
kitchen, the yard, walls, floors or the ordering rules, and it should not: a
tutorial that keeps going is a tutorial people skip.

What those want instead is a **second** tour, offered when the shop is ready for
it rather than on day one — the first time a bed is ripe, the first time a
machine is built, the first delivery that is refused for want of bay room. Same
`STEPS` shape, same veil, a different array and a trigger that is a predicate
over the snapshot rather than a mark in localStorage.

The thing to be careful of is that a coach mark which arrives *while you are
doing something* is an interruption, where one that arrives when you open a
shop is an offer. So the trigger should hand you a small nudge — the rail's own
`note` pill is already the right shape — and the veil should only come down if
you press it.

## Step 3 — the milestone ladder as the real tutorial *(proposed)*

Twelve rungs already exist, they are already *measurements* rather than quests,
and the award card already stops the world to explain one. That is a teaching
surface with nothing taught on it: a rung knows what it wants and could say what
press gets you there. `docs/progress.md` step 2 is the natural home.

## Step 4 — a hand for the gestures *(proposed)*

The two beats this tour is really for are "a tap is one unit" and "a hold is the
lot", and both are currently *sentences*. What would say it in one frame is the
gesture drawn: a hand over the ring, the ring winding, the crate filling. The
renderer already draws the ring; a HUD sprite of the press over the lit target
is a small thing and is worth more than the paragraph under it.

---

## Traps found writing this one

- **A hole in a veil is not the same as a gap in a mask.** A `clip-path` hole
  still takes the pointer in some browsers, and there is no way to tell from
  looking at it — the highlight is correct, the button is lit, and the press
  goes nowhere.
- **A card pinned beside a target has to be measured, never placed by rule.**
  The rail is up the right-hand side, the bar is across the bottom, and the
  panel is in the middle: no single side of the screen is free for every step,
  and a card that covers the thing it is explaining is the one arrangement that
  cannot work.
- **A step's `arm` has to open the TAB as well as the strip.** `staffGroups`
  files who works here under one tab per kind and who you could take on under
  `hire`, so lighting a hire tile without switching to it lights an element that
  is not in the document — which reads as the tutorial having no idea what it is
  pointing at, because it hasn't.
- **A stepper's `+` goes disabled the moment the budget is full.** A hole cut
  round it is a hole round a dead button, with the `−` that would make room for
  it out in the blackout. The step lights the whole row and accepts *any* change
  to the shift.
- **A mark is projected at a HEIGHT, and getting it wrong does not look like a
  wrong number.** `worldToScreen` takes a `y`, and on a 45° camera a metre of
  height is most of a tile of *screen*, up and to the right. A crate marked at
  head height gets a ring hanging in the air off its top corner — which reads as
  the marker being broken rather than as one argument being wrong. Each target
  names its own height (`CRATE_Y`, `SHELF_Y`), measured against the art.
- **A card set beside a ring has to clear the ring's RADIUS.** The world mark is
  ~46px across and *centred* on the point, so an 18px gap puts the card over the
  bottom of its own highlight and half of what it is highlighting.
- **A single expanding ring is nearly invisible over a shop floor.** It is a
  thin green line among a hundred thin lines and it spends most of its cycle
  transparent. The mark is three layers: a solid disc that never moves, so
  something is *always* there to find, and two pulses off it saying which way to
  look.
- **"Tap" is the wrong word and it was in eleven places.** This is a mouse game
  whose whole vocabulary is left, right, and held — the one sentence the tour
  exists to deliver is *left takes one, hold-left takes the lot, right puts one
  back, hold-right pours* — and a tutorial that says "tap" has not said any of
  it. Copy in here names the button, always.
- **A button in a step can be at its ceiling already.** The shift step used to
  light Serve's `+` and ask for a press; a fresh clerk arrives with Serve at its
  cap, so the tour cut a hole round a dead button and put the `−` that would
  make room for it out in the blackout. The lesson was never "press +", it is
  "these numbers come out of one another" — so it lights the whole list and
  accepts *any* change to the shift.
- **A rail button that does two different things on two presses cannot be asked
  for once.** Build's first press is the mode and its second is the palette, and
  the second one's effect is a bar at the bottom of the screen behind the card —
  so a step that asked for a press got one, changed nothing visible, and sat
  there asking again. The tour presses it twice itself, through `pressBuild` so
  the mode is entered exactly as a player enters it, and the two-press rule moves
  into the hint where a thing you need once belongs.
- **Two frames before measuring anything.** A menu an `arm` has just opened is
  not laid out yet, so a rect read on the same frame is the rect of where it
  used to be — the same two frames the tooltip and the rail's note both take.
