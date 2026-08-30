# The tutorial

*A robot who shows you round a shop you have just made, and holds the rest of
the game still while it does.*

Status: **steps 1, 1b and 2 built** — the tour, the guest tour, and the
mini-lessons that arrive with the kit. Steps 3–4 proposed; step 5 (the
cinematic rework) is the one being built next.

---

## Read this first — everything you need to start (§0)

**This section exists so nobody has to spend ten minutes reading four files
before they can write a card.** Everything below was gathered the slow way
once. The rest of this document is *why* the shape is the way it is; read it
when you are changing the shape, not when you are adding a page.

### Where the work is

| | |
|---|---|
| All of it | `client/tutor.js` — one file, three arrays, one class |
| Its CSS | `client/index.html`, the `.tt-*` block (search `.tt-card`), plus a phone override further down |
| Nothing else | Nothing in `server/` knows the tutor exists. No save field, no message the game did not already have |

Three arrays and one parked object:

- `STEPS` — the host tour, run for a shop this browser **made**. May demand an
  action.
- `GUEST_STEPS` — swapped in whole for somebody who **joined**. No money, no
  shutters; just the hands.
- `LESSONS` — briefings that arrive later. Two families. The **tab** ones are
  `shop`, `logistics`, `farm`: an `owns` count, a `group`, and the `?` on the
  build bar reopens them. The **situation** ones are `charge`, `queue`, `wave`
  and the three gauges (`gauge-room`, `gauge-mood`, `gauge-rep`): a `when`, no
  `group`, and nothing reopens them, because the `?` answers "what is in this
  tab" and there is no tab whose contents are the Rep bar. `rubbish` and `pads`
  are two more of those — rot standing on the floor of a shop with no skip, and
  a yard that has stopped draining.
  **A lesson tells and asks nothing** — no target, no veil, no predicate,
  nothing armed — *unless its trigger is itself the missing thing*, which is
  what the whole situation family is: being stuck is what fired it, so it gets
  to point at a press.
- The three **gauges** are the corner bars, and they are the one case where the
  trigger is harder than the copy. They fire off `gauge` in
  `client/hud-meters.js` — the bar's own amber, imported rather than restated,
  or the card explains a bar that is still green — held for `GAUGE_DIP_MS` by
  `sagging`, because every one of those bars dips for a second whenever a queue
  forms. Room reads `capacityBy` off the wire to know whether the fix is a till
  or a wall; Mood reads `moodBlame` to name which of the three drains is
  actually happening, and does not fire at all when none of them is.
- `WAVE_STEP` — written, parked, not in any array. Its moment is the first
  shopper walking past after the shutters go up.

### The field list, so you do not have to reverse it out of the examples

A **tour step** — every one of these is optional except `id`:

| field | |
|---|---|
| `id` | the mark. Renaming one re-teaches it to everybody |
| `kicker` | the gold title band |
| `say` / `hint` | the sentence and the small print. Either may be a function of the tour, re-asked **every frame**, which is what lets one card's spotlight walk |
| `art` | the picture well. A function, or a string of SVG. **Called as `s.art(this)`** — see the traps |
| `legend` | icon+sentence rows *under* the words, for marks that only exist in the 3D scene. Does **not** replace the well |
| `at` | where the mark goes, asked every frame. See the shapes below |
| `done` | the predicate over the snapshot. **Never a press.** A step with no `done` gets a Next button; one with a `done` must not have one |
| `start` | once, on open. Where a delta records what was true |
| `arm` | once, on open. For putting a menu in front of somebody |
| `nudge` | every snapshot. Keeps a strip open; holds a two-phase latch |
| `skipWhen` | asked **before** `arm`. Nothing here to teach in this shop |
| `waiting` | true when the world is what you are waiting on. The card breathes and the stranded timer is held off |
| `shot` | a camera pose. Only on cards that ask for nothing |
| `big` | the read-only layout |
| `offer` | `{ ask, label, took, when, run }` — a question about the shop as a sentence with a link in it |

A **lesson**: `{ id, group, owns | when, toast, steps }`. A **lesson page**:
`{ id, kicker, kind, piece, art, say, hint }` — and `skipWhen` works here too,
because `go` asks it for every array.

- `group` is a build-tab id, and is what the `?` on the build bar opens. Leave
  it off for a lesson about a *situation* rather than a tab (see `charge`).
- `owns` = a count over the layout; fires when the number goes **up** while
  somebody is watching. This is "you have just built one".
- `when` = a predicate; fires on a **stuck state you can see**. Never on a
  level — "there is a conveyor" is true of a shop on day 200 with forty of them.
- `kind` on a page derives the picture *and* the `· soon` badge. Prefer it to
  `art`.

`at` comes in four shapes:

```js
{ el: '#sel', pad, up, mock, pulse }   // something on the HUD
{ world: pt, y, fixture }              // a thing in the shop; lights the canvas whole
{ mock: '.sel' }                       // a picture and no mark at all — legal, see holeFor
null                                   // no mark; the first and last cards
```

`mock` clones a live control into the picture well. `pulse` is a second, smaller
mark on the one press inside a lit panel. `up` climbs from the thing you can
*name* to the thing that should be *lit*.

### What a predicate may read

`t` is the `Tutor`. Everything hangs off four things: `t.state` (the snapshot),
`t.ui`, `t.net`, `t.scene`.

- **`layoutOf(t)`** → `t.scene.storeLayout`: `shelves` `checkouts` `bins`
  `belts` `arms` `sorters` `packers` `unders` `lifts` `plots` `pens` `props`
  `break` `bay` `drop` `ground` `paint` `door` `store` `w` `h`. The three pads
  are `{x, z, cells}` or **null**, and `cells` is what makes "how full is the
  yard" answerable without a wire field — one cell holds one crate (`padLoad`).
  This is where an `owns`
  count comes from.
- **`t.state`** (the snapshot): `undos` / `redos` (the build stack, **not on the
  save**, so it means "presses made since you sat down"), `shutters`, `roster`,
  `players` (each with `staff` `energy` `carry` `haul` `takers` `emote`),
  `deliveries`, `shelves`, `orders.pending`, `milestones`, `cash`, `day`.
- **`t.ui`**: `bar` (`'build'` `'staff'` `'stock'` …), `barTab`, `openPanel`,
  `toolId()`, `catalog`, `paletteArmed`, `holding`, `award.open`,
  `state.reveal`.

### Helpers already in the file — check here before writing one

`perInput(mouse, finger)` · `keyed` (`[[X]]` → a key cap, `\n\n` → a paragraph
break) · `esc` · `meOf` · `lotSize` · `shelvesOf` · `anyShelf` · `nearestCrate`
· `atIt` · `atUnit` · `spotToWalk` · `artOf(t, kind, piece)` · `artOfUnit` ·
`cheapestOf` · `mockOf` · `comingSoon` · `arrowRow`.

### Facts about the game the cards need, and where they live

**Do not grep for these again.**

- **Every keybinding** is one `keydown` handler in `client/main.js` (search
  `addEventListener('keydown'`). Ctrl/Cmd+`Z`/`Y` undo/redo · Ctrl/Cmd+`C`/`V`
  blueprint · `V`+`1`–`4` emotes · `F` first person · `C` cinema · `O`
  shutters · `P`/space pause · `1`–`9` bar slots · `Tab` next tab · `R` rotate
  · `Q` pipette · `E` storey · `Alt` peek · `Del` remove what is picked.
  The two build **modifiers** are in `pointerdown`, not the key handler:
  Ctrl/Cmd-click is the bulldozer (`razeAim` / `doRaze`) and Shift-click is
  multi-pick, whose drag is a marquee.
- **What a phone has instead**: `#undobtn` `#redobtn` `#pickbtn` `#delbtn`
  `#rotbtn` and the camera pair — `ui.syncSteps` / `syncRotate` decide when.
  `pillDrives()` is the fork (max-width 640px), and it is the same test
  `perInput` asks.
- **What the player can already look up**: Menu › Controls
  (`client/sections.js`, the `id: 'help'` section). **Check that list before
  writing a card** — if a key is not in it, nothing on screen says it, and if
  it is, the card is a second telling rather than the only one.
- **The mark colours**, if you are drawing one on a card: `MARKER_LOOK` in
  `client/render/props.js`. aim `#ffd66b` · picked/selected `#5fd6c4` · raze
  `#e2564a` · stock `#7cc46a` · the tutor's own `#6fcf68`.
- **What is on the bar yet**: `shared/reveal.js` — `toolRevealed`,
  `pieceOffered`, `TUTORIAL_KINDS`. Never name a tool the ladder has not handed
  over.
- **Pictures of pieces**: `client/thumb.js` — `artForPiece`, `artForGround`,
  `artForCrate`.

### The rules, in one place

1. **Copy is for a seven-year-old with no attention span.** This is the rule
   that gets broken every single time, so it is a *budget* rather than a
   feeling:

   | | budget | |
   |---|---|---|
   | `say` | **≤ 12 words**, one sentence | the whole point of the card |
   | `hint` | **≤ 2 short sentences per paragraph, ≤ 2 paragraphs** | the detail |
   | `kicker` | **≤ 3 words** | |
   | `toast` | **≤ 7 words**, no key caps (it never goes through `keyed`) | |

   Over budget is not "a bit long", it is a card nobody reads — and a card
   nobody reads is worse than no card, because it also taught them to skip the
   next one. If a page needs more, it is two pages.

   Write the press as a **glyph, not a description**: `[[Ctrl]] [[Z]]`, not
   "hold control and press zed". `keyed` draws every `[[X]]` as a key cap, and
   `legend:` draws a mark beside its one sentence.

   Simple is not vague — every sentence still has to be literally true of the
   sim, and every time the plain version came out wrong it was because the
   jargon had been hiding that it was wrong. Banned words: `run`, `cell`,
   `unit`, `board`, `backpressure`, `terminus`, `stray`. Say box, shelf, line,
   hands, robot.
2. **A CARD ANSWERS "WHAT DO I PRESS RIGHT NOW", NOT "WHAT IS THIS THING".**
   The single most expensive mistake in here, made three times in one sitting.
   A lesson fires because something is happening — a line at the till, a robot
   running flat — and the player's question is short and urgent. Anything that
   is not the answer to it is noise, however true.

   > A queue formed. First draft: *"People queue at the till. Leave clear
   > squares beside it to wait in. Cash piles up on the counter — walk over it.
   > A better till is faster."* Every word true. Not one word is what to press.
   > The card should say: **"Go and stand at the till."**

   Two tells that you are writing the wrong card: the sentence explains where
   to BUILD something (advice for a mode the player is not in), or it describes
   a mechanic instead of naming a press. "Where things go" belongs in the tab
   briefing behind the `?`, which is where somebody goes to *read* about a till.

3. **NAME THE THING, DON'T DESCRIBE THE MECHANIC.** *"Pick a robot and add
   points to Serve"* is three presses deep in a panel, explaining that a shift
   is a ratio. There is a robot in the catalogue called a **Clerk** whose whole
   job is standing at a till. Say **"Hire a Clerk."** Pull the name off the
   catalogue rather than hardcoding it (`clerkKind`) — an id in a sentence is
   `if (item.id === 'tomato')` wearing a card.

4. **EVERY INSTRUCTION NEEDS A REAL ADDRESS.** "Press this button" points at
   nothing. An address is the thing's **name on screen** plus its **key**, and
   both, because a picture cannot say either: *"Press `H` for your Crew"*. Names
   and keys live on the section rows in `client/sections.js` (`name`, `key`) —
   look it up, do not invent it.

5. **A PATH IS A LIST, NOT A SENTENCE OF COMMAS.** More than one press means
   `legend:` with one `iconRow` per step. A paragraph hides how many steps there
   are and which one you are on. And the list has to reach the **end** of the
   flow: hiring arms on the first press and spends on the second, so a card that
   stopped at "click the Clerk" reads as a broken button.

   ```
   🤖  Press [[H]] for your Crew
   ＋  Open the Lease tab
   👤  Click the Clerk, then click again to hire
   ```

   **And the icon on a row that names a tab is that tab's own icon.** They are
   set in `BUILD_GROUPS` / `staffGroups` (`client/sections.js`) and cannot be
   imported here — that file imports `tutor.js` — so it is a look rather than a
   lookup, and it has drifted twice: a Logistics row wearing a porter's trolley
   while the tab wears a crate, and a "+ tab" that is called Lease. The one row
   whose whole job is saying which of six buttons to press is the worst place
   in the game to point at the wrong one.

6. **Say which button, and never a key that isn't there.** "Tap" is the wrong
   word on a mouse and `[[R]]` is a lie on a phone — `perInput` forks every one.
   The touch build has its own controls for the desktop keys (`#rotbtn`,
   `#undobtn`, `#pickbtn`, `#delbtn`, the Crew rail button); name those instead.
   "Press and hold" is the one gesture that is the same sentence in both.

7. **EVERY CARD HAS A PICTURE. This is not a nice-to-have.** The picture well
   is a fixed 168px block at the top of the card — leave it empty and the card
   is three lines of type over a hole, which reads as broken. This is a
   **visual** learning path: the picture is the card, the words are the
   caption. Four ways to fill it, in order of preference:

   | | how |
   |---|---|
   | the piece itself | `kind: 'checkout'` on the page — derived from the catalog, so it restyles itself |
   | a HUD control | `at: () => ({ mock: '[data-rail="staff"]' })` — clones the real button |
   | a ground brush | `kind` on a brush row; `artOf` forks on `surface` |
   | a gesture | a drawn `art` diagram — see `dragArt` |

   **A mark in the shop does not replace the picture.** Both: the frame says
   *which one*, the picture says *what you are looking for*. The tour's `pour`
   card does exactly this.

   Under the words, `legend:` draws **icon + one sentence** rows — `ICONS` in
   `client/icons.js` has a glyph for nearly everything (`walk` `staff`
   `checkout` `crate` `shelf` `freezer` `tierup` `wave` `open` `shut` …).
   Reach for it whenever the copy is listing options or steps; a row of glyphs
   is read, a paragraph of alternatives is not.

   And say a press as a glyph, never a description: `[[Ctrl]] [[Z]]`.

   On a phone the well becomes a 108px square **beside** the words rather than a
   block above them (the media query at the foot of index.html). A `float` there
   is a silent no-op — the card is a flex column — so it is a grid.
8. **A card per decision, never a card per press.** Two presses with one
   outcome between them are one card whose spotlight walks.
9. **A step is a predicate, never a press it intercepted.**
10. **A lesson never sends `crew-idle`** and never fights for the mouse or the
    camera. Nothing else may be switched off for the length of one either —
    tooltips were, for a while, which silently took away the only explanation
    half the HUD has.
11. **Comment every non-obvious call** with what the wrong version was and how
    it failed. That is the house style and it is why this file is readable.

### The check, before you say a card is done

Read your own card back and answer these. Any "no" is a rewrite, not a tweak.

- [ ] Does the `say` name **a press I can make in the next two seconds**?
- [ ] Is every address a **name + key** that exists on screen, never "this"?
- [ ] Is the well **full**?
- [ ] Is any multi-step path a **`legend` list with icons**, and does it run to
      the end of the flow?
- [ ] Is every key behind `perInput`, with a real touch control named?
- [ ] Inside budget — `say` ≤ 12 words, `hint` ≤ 2 short sentences?
- [ ] Have I cut every true-but-irrelevant sentence?

### Running it without playing to it

```
npm run dev                      # :5173
__sns.ui.tutor.start()           # the host tour from the top
__sns.ui.tutor.go(i)             # any beat
__sns.ui.tutor.teach('<id>')     # one lesson, here and now
__sns.ui.tutor.forget()          # un-learn the lot
__sns.ui.tutor.quit()            # out
```

Playwright MCP drives it; `screenshot` gets you the card. **`simulate` is blind
to all of this** — do not run it for a tutorial change.

localStorage: `sns-tutor-off` (the person) · `sns-tutor-done` (worlds toured) ·
`sns-tutor-new` (worlds made) · `sns-tutor-guest` (the person) ·
`sns-tutor-learned` (lesson ids).

### Traps that have cost real time in here

- **`mockOf` cannot clone a control styled against its own id** — `#sign`,
  `#undobtn` and friends come out as unstyled boxes, because the clone has its
  id stripped (and leaving it on would put a second `#sign` in the document for
  `holeFor` to find). Draw those instead; `mockOf`'s `'sign'` branch is the
  worked example.
- **`art` is called as `s.art(this)`.** `art: artForCrate` hands the tour to
  that function's first parameter — which is `waste`, so the card draws a crate
  of rubbish. Wrap it: `art: () => artForCrate()`.
- **Anything `STEPS` or `GUEST_STEPS` names must be defined above them or be a
  `function` declaration.** Both are module-level array literals, so a `const`
  arrow written below is read before it is initialised. `viewHint` and
  `arrowArt` are declarations for exactly this reason.
- **`LESSONS.find` is first-match-wins**, so array order decides which briefing
  gets a settle. A new lesson usually belongs at the end.
- **`owns` baselines are taken on every `maybeLesson` pass**, not lazily — a
  lazily-recorded baseline is measured from whenever it happened to be asked.
- **Two frames before measuring anything** a step's `arm` just opened.

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

### What the card looks like, which was not a free choice

It is **portrait and a fixed size** — 300 × 533, bounded by the viewport — with a
gold title band across the top, the robot in the band, and the feet pinned to the
bottom. Picked off a comparison board of four shapes and four bots.

Three things about that are decisions rather than taste.

**Fixed, because the feet move otherwise.** 340 wide by whatever the sentence
needed was a shape decided by the copy, so no two beats were the same card: Next
— the one press on a read-only card — was never twice in the same place across
thirteen of them. A card that is always the same size is one you learn the shape
of once. `.tt-said` is the only part that gives when the window is short, so the
feet cannot be pushed off the bottom.

**Portrait, because what it competes with is the SHOP.** A column down one edge
leaves the middle of the building clear; a wide slab lands across it. The phone
override is untouched and is the opposite answer for the opposite reason — under
720px the card is a full-width banner across the *top*, because a portrait screen
has no free side — and it has to reset the height as well as the width, or the
shape above lands as most of a phone display over the thing every beat is
pointing at.

**And the band is the panel's own.** Every other card in this HUD names itself in
a gold band (`#panel header`, the same gold the lit tab and the armed build slot
wear); this one printed its kicker as a caption floating on the paper. The one
card the game puts in front of somebody who has never played was also the one
that did not look like the game.

The card was also **the last thing in the HUD wearing a 34px blurred cast and no
contour**, which is exactly the pair the Crate pass took out everywhere else. It
has `--k1`/`--d1` now, as an `::after` overlay rather than an inset shadow on the
box — the band and the feet have their own backgrounds, and a shadow on the box
is painted under them.

### ...and the robot

Every colour in `FACE` is lifted out of `data/seed/workers.json` — `#d7dfe8`
chassis, `#83909f` trim, `#3b424e` visor, `#5fe0d0` glow — with one crisp
`--ink-line` round it, and it is made of boxes, because a hire is made of boxes.

What it replaced is worth keeping, because each thing wrong with it was a
decision the game had already made the other way: a cream capsule with a 13px
corner radius, a soft brown outline, `#8fe3ff` eyes and a smile. Nothing in the
shop is round — `--r` is 0, and the note beside it says the player's head and a
wheel are the only two curves in the entire game. Nothing in the shop is cream
except the paper the card is printed on, so the robot was the same colour as the
thing it was standing on. `#8fe3ff` is not any hire's glow. And no hire has a
mouth. It read as somebody else's app mascot sat on top of the game, which is
word for word the complaint the whole chrome pass was about.

The lamp on top is the one thing not off a worker row: it is `--good`, the same
green as the mark the card is pointing with, because a tutor who is *talking*
wants a tell.

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

One of the beats is not the same sentence with a different verb in it, and it is
the one worth reading before adding a beat:

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

## Step 2 — the lessons *(built)*

The tour stops at "you can run a shop". It says nothing about the farm, the
kitchen, the yard, walls, floors, conveyors or the ordering rules, and it should
not: a tutorial that keeps going is a tutorial people skip. But the shop goes on
growing for another four hundred sales, and every one of those things is a
gesture nothing explains — which is the same complaint this file opens with,
arriving four hours later.

`LESSONS` is a third array beside `STEPS` and `GUEST_STEPS`, run by the same
`Tutor`. **One briefing per build tab**, next-through, a page per piece with that
piece's own picture on it. Three are authored: **Shop** (shelf, chiller, hot
counter, till, skip), **Logistics** (conveyor, loader, sorter, packer, tunnel,
lift) and **Farm** (grow rack, vat, culture floor, and what the farm is for).

Two doors in. A **`?` on the build bar**, beside the ✕ and outside the scroller
so it has a fixed address, opens the briefing for whichever tab you are on — and
is `hidden` on the five tabs that have none, or it is a button that does nothing
most of the time. And the first time you build anything from that tab, it opens
itself.

### One per TAB, not one per piece

It was seven lessons — a page each for the sorter, the packer, the tunnel and
the lift, each waiting until you owned one. That is wrong twice.

It makes the *shape* of the thing depend on what you happen to own, so there is
no "the conveyor help" to go and read; there is a briefing that already fired and
four that have not, and no way to ask for any of them. A `?` on the bar has to
open **the same thing every time** or it is not a help button.

And it hides the pieces you have not got, which are exactly the ones worth
knowing about. A tab is a coherent subject — the whole back of house, the whole
farm — and a briefing that covers it end to end tells you where you are going.
So a page about a piece the ladder has not handed over **stays**, and says so:
`· soon` on its title, a line saying it turns up as the shop grows, and its
picture stepped back but never greyed out — the pieces are told apart by colour
as much as by shape, so a grey sorter and a grey packer are one drawing.

`comingSoon` asks `toolRevealed` with the palette's own arguments, or the card
and the bar disagree about what you can build, which is the green-ghost bug
wearing a tutorial. A shop with the ladder switched off answers "everything is
available", which is the right answer: nothing is coming, because it is all
already here.

### It is a BRIEFING, and that is the whole design

*You dropped a conveyor; here is what this part of the game is.* Four pages, a
picture of the piece on each, Next through them, done. **No target, no veil, no
predicate, nothing armed, no build mode touched.** It tells you what a thing is
and asks for nothing; what you do with it afterwards is the game.

That is a correction, and both halves of it cost a screenshot to see. The first
cut was the tour's shape pointed at a machine — a lit target in the shop and a
predicate over the snapshot — and it failed twice in a row for two different
reasons that turn out to be the same reason.

**A lesson's trigger is a press that has already happened, so its first beat may
never be that press.** The opening beat was "drag along the floor to lay a whole
run in one press", said to somebody who had just dragged along the floor and laid
a run. That is not teaching, it is describing. The `skipWhen` it needed is the
tell: a step that has to check whether it is redundant is a step whose *trigger*
already knows the answer.

**And a lesson runs in a shop it knows nothing about.** The next beat asked for a
loader beside a shelf. The shop it fired in *had no shelves in it* — so the card
sat there naming a thing that did not exist, on a predicate that could never come
true, in a state its own third phase was written to explain and could not. The
tour is allowed to demand a press because it runs on day one in a shop the game
itself furnished, and the fixtures it names are the two it knows are standing
there. **Nothing else in the game may**, and no amount of care in a predicate
fixes it: the fault is the demand.

Dropping the demand takes three problems with it. There is nothing to wedge on.
There is nothing to strand, so the six-second *Carry on* button never has to
appear in a lesson. And a briefing names nothing to press, so it can never land
in `TUTORIAL_KINDS`' failure — a card naming a tool that is not on the bar —
which the guided version was one `when` away from at all times.

### One prop a page, and written for a seven-year-old

A page is about **one thing you can point at in the shop**, and it shows that
thing's own picture: the conveyor, then the loader, then the sorter. Not "the
conveyor system". Somebody who reads one page and stops has learnt one whole
object rather than a quarter of a concept.

The words are for a child, because the person these are actually for is one.
Short sentences, real nouns — box, shelf, line, hands — and **none of the words
this codebase uses for the same things**: `run`, `cell`, `unit`, `backpressure`,
`terminus`, `stray`. The first cut said "a belt cell with a pair of hands" and
"R sets where the run carries on rather than which unit it fills". Both are
exact, both are shorter, and neither can be read by anybody who does not already
know the answer.

Simple is not vague, and that is the part to hold on to. Every sentence is
literally true of the sim: "it reaches all four of its sides" is `armReach`,
"they queue up rather than falling off" is backpressure, "sends the box to a
line that can actually put it somewhere" is the splitter choosing by where the
goods *can go* rather than by a filter. Writing it simply meant writing it
**accurately** — every place the plain sentence came out wrong was a place the
jargon had been hiding that it was wrong.

### The picture is what the empty half of the card is for

Each page carries `art`: the piece's own palette thumbnail, straight out of
`artForPiece` (`client/thumb.js`). Same model, same camera, same sun, same
colours — so **the thing on the card is literally the thing on the bar**, and a
piece somebody restyles tomorrow restyles its lesson with no second picture to
keep in step. A lesson that drew its own diagram of a conveyor would be a drawing
of a conveyor the shop has never once drawn.

It is painted in `paint` rather than `words`, and the reason is not cost. A
card's *sentence* moves as its own spotlight walks — that is what makes thirteen
beats out of eighteen presses — but a card's *picture* is what the card is about,
and one that swapped under a sentence you were reading would be a second thing to
re-find.

It also answers the fixed height. A briefing lights nothing in the shop, so
without art the portrait card is a column of blank paper under three lines of
type — and a lesson about a machine you have never seen wants a picture of it
more than it wants any of the words.

### `when` is what being STUCK looks like, never what owning one looks like

The reveal ladder (`shared/reveal.js`) is the obvious trigger and it is the wrong
one twice over. A button turning up on the bar is not a lesson anybody needs —
you have not got the thing yet, so there is nothing to be confused by — and it is
silent for the shop that turned the ladder off, which is every shop that took the
offer on the last card of the tour. `when` is a question about what is standing
in the shop, which is true of both.

And it has to be a delta in spirit even though it reads as a level. "There is a
conveyor" is the trap step 1b is written around: a shop on day 200 with forty
belts would open a briefing about conveyors at somebody who has thirty loaders.
So the belt lesson asks for **a run with nothing lifting off it** — `belts > 0 &&
arms === 0` — true of somebody who has just laid track, false of everybody past
it. Both halves are needed: belts alone is the level trap, and no loader alone is
true of every shop that never heard of conveyors, which is most of them.

### ...or `owns`, when there is no stuck state to ask about

The Farm has no visible failure — a vat that is not doing what you wanted looks
exactly like one that is — so there is no predicate to write, and a plain "there
is a rack" would open a briefing on an established shop's next load about a farm
it has run for a hundred days. So it carries `owns`, a count over every piece on
the tab, and `maybeLesson` **records what every count was the first time it
looked**: the briefing fires when the number goes up while somebody is watching,
which is the definition of having just built one. A shop that already owns them
is the old game, silently. The `?` is the way back in either case.

The baselines are taken for **every** counting lesson on every pass, not lazily
when one becomes eligible. Recorded lazily, a shop that builds a rack and then a
belt hands the belt lesson a baseline of whatever it had by then — so the second
never fires, and the failure is invisible in exactly the shop that is building
the most.

Logistics keeps a `when` because it is the one with a stuck state you can see
from across the room: a run with nothing lifting off it. That is worth catching
however long ago the track was laid, and it is not the same question as "you have
just built a conveyor".

### A lesson may not down tools

`start` sends `crew-idle` for the length of the tour, which is free in a shut,
empty shop on day one and is a shop that stops trading on day forty. `start` and
`quit` both test for it.

### The settle, which is the one thing that is not a predicate

The trigger is a purchase, and a purchase is very often the middle of something:
a run is one drag, but a loader, a second run and a junction are three more
presses, and a card that arrives between two of them is an interruption. So the
condition has to hold for **two seconds** before the card opens — the shop
standing in that state for two seconds is somebody who has stopped to look at it.
`Date.now()` and not the shop's clock, for the reason `strand` gives: what is
being measured is real seconds spent looking at a thing, and the shop's clock is
the one that might have stopped — which, while an award card is up, it has. That
card is the other guard: `maybeLesson` will not open behind it.

### Where the marks live, and the third key

`sns-tutor-learned` is a list of **lesson ids**, not of worlds. That is the whole
difference from `sns-tutor-done`: a lesson is about a machine, and the machine is
the same machine in every shop, so being told about loaders again at your second
shop is nagging. Same argument as `sns-tutor-guest` exactly, one axis along.

Skipping marks it learned, which is what Skip means everywhere in here — so
Menu › Tutorial › **Replay** calls `forgetLessons()` beside `replayTutor()`. It
does not start one: each still waits for its own `when`.

### Reading the pages without playing to it

`__sns.ui.tutor.teach('belts')` runs one here and now, and
`__sns.ui.tutor.forget()` un-learns the lot. Same argument `__sns.award.push`
makes about `year-one`, one step further out: a lesson's `when` is a shop four
hundred sales in with a run standing in it and no loader on it, so reading its
copy costs a playthrough — and copy that expensive to look at is copy that gets
fixed after it has shipped.

### Two traps the farm pages found, both in `cheapestOf`

A lesson picks the cheapest piece of a kind to draw, for the reason
`cheapestFreezer` gives — it is the one you have almost certainly got. Both of
its failures are silent and both read as bad art rather than as bad wiring.

**Retired rows are still in the catalogue.** `RETIRED_PIECES` is a filter on the
*palette*, and every retired row stays in the content database on purpose, since
live shops have hen houses standing in them. So the cheapest `pen` is a Beehive
at 120 — and the card explaining what a vat is would have shown a picture of a
beehive nobody can buy. `pieceOffered` is asked here too.

**Ground and furniture are the same table.** A brush row carries a `surface` and
no model, so `artForPiece` answers `null` for the culture floor — a card with a
hole where the floor should be, and nothing anywhere saying why. `artOf` forks on
that field, which is `artForTool`'s own fork one file along.

### The Shop tab, and the beat the tour builds

The tour covers a shelf on day one and covers the one thing a shelf is for.
What it cannot reach is that a unit of shelving is **three** things — ordinary,
cold and hot — that the wrong one of the three is *no better than none*, and
that the till ladder ends in a decision rather than an upgrade. Every one of
those is invisible: a chicken going off in a chiller is the same picture as a
chicken keeping in one, and a till nobody can queue at is the same picture as a
till. Five pages, `owns` over `shelves` + `checkouts` + `bins` (one array holds
all three kinds of shelving), and two of them — the hot counter and the skip —
are `· soon` in a young shop, which is the case that argues for keeping the
pages you cannot build yet.

Its trigger found the one place `maybeLesson`'s baselines were wrong. They are
recorded the first time it looks, and it does not look while a tour is up — but
a snapshot can land before `maybeStart`, so they can be taken *before* beat 11
stands a chiller on the floor. A chiller is a unit of shelving, so the shop
would read as having been built in, and the briefing would open two seconds
after the card that says good luck. `start` clears them, and only for a tour:
two lessons can want opening in the same settle, and clearing there would take
the second one's delta away with the first one's card.

### What is not done

Shop, Logistics and Farm have briefings. Four tabs do not: Appliances, Building,
Decor, Outdoors — the `?` is hidden on all of them. Building is the one worth
writing next: walls, floors and paint, the signed doorways (staff only, way in,
way out), and the fact a floor is a *look* and never a permission.

A new one is a `group`, a trigger and a list of pages. `owns` is the default and
the safe one. Reach for a `when` only where the tab has a *visible stuck state*
worth catching long after the thing was built.

Co-op fires it for both people, since a belt is a fact about the shop and the
mark is a fact about a person. That is right rather than a bug: a guest can
build, and the briefing is about a machine standing in front of them.


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
