# The tutorial

*A robot who shows you round a shop you have just made, and holds the rest of
the game still while it does.*

Status: **step 1 built.** Steps 2–4 proposed.

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
Menu and one attribute in `bar.js`. Eighteen beats, in order:

| | | teaches |
|---|---|---|
| 1 | Hello | who is talking, and that there is a way out |
| 2 | Walk | a tap on the floor — and that a tap on a *thing* is a walk plus a job |
| 3 | Look | the right drag is the camera, and the view stays where you put it |
| 4–5 | Order stock | the supplier; that goods come on a van rather than out of a menu |
| 6–7 | Take on a Clerk | the crew are content; the strip; the two-press confirm |
| 8–9 | Their shift | that a hire's day is a ratio *and* a budget |
| 10–12 | Build a chiller | the mode, the palette, the tap that spends money |
| 13 | The van | crates land on the pad, and that is the only "goods on the floor" there is |
| 14 | Take one | **a tap is one unit** |
| 15 | Shelve it | the chevrons; stock has a home |
| 16 | Shoulder the crate | **a hold is the lot**, and a box beats a pair of hands |
| 17 | Tip it in | the same sentence at the other end |
| 18 | Open up | the shutters, which is why the shop was quiet the whole time |

The order is not arbitrary. The van is ordered at beat 5 and collected at 13,
and the four beats in between are the ones that do not need it — hiring,
the shift, and the chiller. A tutorial that ordered stock and then stood there
watching the clock would be teaching you that the game is slow.

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

---

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
- **Two frames before measuring anything.** A menu an `arm` has just opened is
  not laid out yet, so a rect read on the same frame is the rect of where it
  used to be — the same two frames the tooltip and the rail's note both take.
