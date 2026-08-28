# The tutorial

*A robot who shows you round a shop you have just made, and holds the rest of
the game still while it does.*

Status: **step 1 built**, plus the guest tour (1b). Steps 2–4 proposed; step 5
(the cinematic rework) is the one being built next.

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
Menu and one attribute in `bar.js`. **Thirteen beats:**

| | teaches |
|---|---|
| 1 Hello | who is talking, and that there is a way out |
| 2 Walk | left-click the floor; and that left-clicking a *thing* is a walk plus a job |
| 3 Shoulder the crate | that a tap on something across the shop is a walk that ends in a job |
| 4 Tip it into a shelf | hold-right pours, and the chevrons say which unit will take it |
| 5 Take one off | **stood at a thing, a tap is one unit** |
| 6 Put it back | right puts, and holding either button does the lot |
| 7 Hold for the menu | that a hold is how you reach what a thing can *do* |
| 8 Keep it for something | a reservation, and that the shop will then buy for it |
| 9 Meet your Shop Hand | the crew are leased machines; the strip; opening somebody up |
| 10 Their shift | that a hire's day is a ratio **and** a budget |
| 11 Build a chiller | the palette, the price, the green/amber ghost |
| 12 Buy stock | the supplier, and that goods arrive on a lorry rather than out of a menu |
| 13 Open up | the shutters, which is why the shop was quiet the whole time |

**The gestures come first, and that is what the free crate bought.** The old
order had to open an account before it could teach a pair of hands: stock was
ordered at beat 3 and collected at 7, with the three beats in between chosen for
one reason — they are the ones that do not need it. A tutorial shaped around a
delivery time teaches ordering first whether or not ordering is the first thing
worth knowing, and it makes the four gestures nothing else in the game explains
wait for a lorry. `starterOrder` puts a van on the road at minute zero, so the
hands go first and the supplier becomes a beat about *where more comes from*.

**And the order of the four gestures is the shop's, not the tutorial's.**
`errandAction` is explicit that "empty-handed at a crate is a LIFT", so a tap on
a box you are not stood at walks you over and shoulders it — which means the
whole-box lift is the one press a walk can produce, and a card asking for a
single unit first describes a state you can only reach by not doing what it
says. So the box is beat 3, and the pair about single units is taught at the
shelf, where a tap is a unit and a hold is the lot with no walk in between.

A new shop **comes with a Shop Hand** (`starterHire`, server/worlds.js), which
is why beat 4 opens somebody up rather than buying one. A bare building with
nobody in it is a still frame: nothing moved until the player made it move, and
the one thing a shop is *for* — a machine putting stock out while you decide
where the freezer goes — was four minutes and $200 away. A hand rather than a
clerk because a hand serves, unloads, shelves, farms and tidies, so one of them
is the shop ticking over where a clerk in an empty shop has nothing to do at all.

The beat that swap breaks is the interesting part. It used to end on
`roster.length > 0`, which is now true on the frame the card opens — so it
completed instantly and flashed past. Asking for a *second* hire is the obvious
repair and the wrong one: it spends $200 of a $250 float on a shop with nothing
on its shelves. The lesson was never the purchase. It is that the crew exist,
that they are leased, and that the strip is where they live — all of which is
still there to show, and now there is somebody standing in it to show it with.

The last beat also carries the one **offer** in the tour: whether the build
palette should unfold with the ladder (`shared/reveal.js`) or arrive whole. It
is deliberately a *sentence with a link in it* rather than a labelled button —
somebody four minutes into their first shop has never seen the palette hold
anything back, so a button reading "Show all build tools" is a press with no
question attached, which is a dare rather than a choice. What it leaves behind
names the Menu row that changes it back, because a setting you cannot find again
is one nobody should be touching on their first day.

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
in the shop lights the canvas whole and marks the target instead. The mark is
**in the shop** — `Scene.setTutorTarget`, drawn as `MARKER_LOOK.tutor`, a green
frame on the tile with a chevron over it — rather than a rectangle on the page,
and both halves of that are load-bearing.

Not a rectangle, because a shelf is a three-quarter-tile box drawn most of a
tile *up-screen* of the ground it stands on, so a box round where the pointer
ought to go is a box in the wrong place — the same trap `pickFixture` exists to
answer.

And not on the page at all, which is the correction. It was a pulsing circle
projected through `Scene.worldToScreen` every frame, and the projection was
never wrong: it sat exactly over its point, at every angle, on every frame. What
it could not do is *belong* to the point. A fixed-size coin does not turn as the
camera comes round and does not foreshorten as the ground does, so the one thing
it reads as is a sticker on the glass tracking something behind it — which is
precisely the complaint, and no amount of tuning a radius or a pulse addresses
it, because the fault is that it is drawn in the wrong space. A frame lying on
the tile grid is pinned by construction.

It takes a POINT rather than a fixture, and that is what lets one call answer
all three targets: a crate is not a fixture, so the renderer's own
`setAimTarget` (which wants an `f`) has nothing to hang on, and the bare tile
you are asked to walk to is not a thing at all. It is also why it cannot be the
*contour* every other marker uses for a unit — a contour is a stencil cut from
the object's own meshes, and there is no object for two of the three. The mask
would refuse it anyway: it carries three channels, R, G and B, and amber, teal
and red are all spoken for (`MARK`, `client/render/look.js`).

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

**The feet are navigable, and that is a reviewing tool that had to be safe to
ship.** The ticks are buttons and there is a chevron either side of them, so any
beat can be reached from any other. Three things keep it from undoing the design
the card count is about. They are the **quietest** controls on the card — the
same weight as the dots they flank, never a second green pill beside Next, which
is still the only thing that looks like the way forward. The hit area is a
pseudo-element (`inset` off the dot) rather than padding, because padding twelve
5px dots out to a pressable size overflows the feet, and the row then wraps onto
a second line the dots are too tall to sit on — which draws as a smear of bars
rather than as ticks. And the forward chevron **stops on the last card** instead
of finishing the tour: an arrow that quits is Skip wearing a different glyph.
Every jump goes through `go`, so a beat reached this way opens exactly as it
opens in play — its `start`, its `arm`, and its `skipWhen`.

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

## Step 5 — the tour stops being a UI element *(next)*

The robot in the corner of the card is a drawing, and it is a drawing because
when this was built there was nothing else it could have been: bodies could not
wave, could not point, and the camera had one job, which was following you
about. All three of those changed underneath it. `shared/emotes.js` gives every
body four things to say with its arms; `rec.tyaw` is the *drawn* heading, eased
at `ACTOR_TURN`, so which way somebody is looking is already the client's own
answer; and `viewState`/`applyView` will hand the camera a pitch, a yaw and a
centre and ease it there. So the tour can be *shot* rather than illustrated, and
the thing the card is pointing at can be a person standing in the room.

### It is YOU, and it was nearly a hire

The obvious character is a robot shop-fitter — the fiction is already right for
it (every hire is a machine, and one turning up on day one to fit the place out
is exactly the story the cards tell), and it solves the oddness of your own
avatar greeting you.

**It does not survive the running order.** Beats 1–3 come before the crew strip
has been opened, let alone paid: a guide you have to hire cannot be the one who
introduces the shop, and hiring him at beat 4 means beats 1–3 are shot on an
empty floor with a card floating over it, which is what we already have. Making
him free, or pre-hired, buys the shot back and empties beat 4 of its lesson.

So it is the player's own body, and the oddness is a framing problem rather than
a real one: **he is not greeting you, he is your shopkeeper standing in a shop
that has just been handed over**. The opening is a shot of him, not a
conversation with him — the card is the game talking, the same voice it has now.
The wave is a title shot rather than a hello. Everything downstream falls out of
that for free, because he is the one body in the shop the client already owns
end to end: he walks because you walk him, he turns because `tyaw` is ours, and
he is on screen at every beat by definition.

### The shot language

Three states, and the whole design is that a card is only ever in one of them:

- **LOOK** — camera drops to a low front-on angle on him, he does something (a
  wave, a point, a short walk), and the card opens beside where he projects.
  Nothing is being asked of you.
- **DO** — the camera goes back to the iso view it was on, the veil cuts its
  hole, and the beat is exactly what it is today: a predicate over the snapshot.
- **LOOK** again for the next card.

The rule that keeps it from being a cutscene you fight: **the tour may move the
camera and the body only while the card is not waiting on your press.** A step
with a `done` predicate is yours from the frame it opens. That is the same line
`big` already draws, and it is why the read-only cards are the ones that get the
shots.

### Walking him is the point, and it is also the sharp edge

The instinct is to leave the walking alone — `walk-to` moves the *real* body, so
a tour that walks you is a tour holding the controls. But a body that only ever
turns on the spot is a statue with an arm, and the reason to want this at all is
that the shop feels inhabited.

What makes it safe is *what the walk is for*: *the tour walks you into the region
the next lesson happens in, and never anywhere else.* The chiller beat is about
the ghost and the price, not about finding a clear bit of floor; the shelf beats
are about four presses, not about which of six units. Today every one of those
cards spends its first sentence on a journey — "click the crate, you walk over
and pick the whole box up" — and that sentence is scaffolding round the lesson
rather than the lesson.

Two orderings follow and both are load-bearing. **Beat 2 still teaches the
walk**, and nothing may walk you before it: a tour that moved you before showing
you how to move has taught you that the game plays itself. And **a walk is a
LOOK**, so it is over before the card starts asking for anything — which also
means a walk the server refuses, or one you interrupt with WASD, costs the tour
nothing at all. It never had to arrive.

### Pointing needs a direction, and an emote has none

`point` moves the shoulder pivots and knows nothing about the shelf. The
direction is `rec.tyaw` — set it at the target, let `ACTOR_TURN` ease him round,
then `sendEmote('point')`. Which is the same split `vehicleYaw` names: an emote
is a pose in the body's own space, and where the body is FACING is a separate
fact that nothing in `shared/emotes.js` has an opinion about.

### What it rests on, and what it must not cost

Everything above is a call the client already has, which is what keeps the
promise this file opens with: **nothing in `server/` knows the tour exists.**
`walk-to` and `emote` are messages the game already had, `tyaw` and the camera
are the renderer's own state, and none of it is on the save.

Four things to get right, each of which is invisible when wrong:

- **The view has to be given back.** `viewState()` before the first shot and
  `applyView` after the last, or a tour that is skipped mid-shot strands
  somebody at a cinematic pitch with no way to name what happened.
- **The camera has one owner at a time.** `camPan` is a leash off your body,
  build mode swaps it for `setFreeRoam`, and `clampPan` is the one place either
  bound is applied — a shot that writes the pan while build mode owns it is the
  same fight the free-roam note in CLAUDE.md describes, and it reads as the pan
  jamming for no reason.
- **A shot is not a stage.** It moves the camera and one body; the shop keeps
  running, shoppers keep walking, and the clock keeps going. Freezing the world
  for a card would make the tour the one place the game stops behaving like
  itself.
- **Co-op sees all of it.** An emote is broadcast, so your tutorial makes your
  avatar wave in somebody else's shop. That is charming rather than a bug, and
  it is worth knowing before it is reported as one.

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
- **A mark carries a HEIGHT, and it means something else now.** It was there
  because `worldToScreen` takes one, and on a 45° camera a metre of height is
  most of a tile of *screen*, up and to the right — so a crate marked at head
  height got a circle hanging in the air off its top corner, and a `y` too low
  put the mark on the floor beside the thing rather than on it. In the world
  none of that applies: the frame is on the ground, which is already under the
  thing. So the height is spent on the CHEVRON instead, and getting it wrong is
  the opposite mistake — a frame raised to `SHELF_Y` is a square hanging through
  the middle of the shelf. Each target still names its own (`CRATE_Y`,
  `SHELF_Y`), measured against the art.
- **A marker in the world beats at the pace of what it is for.** The aim and
  target frames swing at 4 because they are about a press you are half way
  through making. The tour's is a beacon you are meant to *find*, on a screen
  you have never seen before, so it is wider and slower (2.4) and breathes its
  opacity as well — a single thin outline over a shop floor is one green line
  among a hundred, which is what made the circle it replaced hard to find in the
  first place and would do the same to a frame drawn flat.
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
