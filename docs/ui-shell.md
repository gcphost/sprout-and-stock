# The menu shell

Status: **built.** This describes what is there, and the reasoning behind the
bits that are easy to undo by accident.

---

## Why it exists

Before this, the UI had no top level. Three unrelated keys (`B`, `U`, `G`) each
opened something into the same `#panel`, nothing on screen said those menus
existed, and a line of prose in the bottom-left corner was doing the explaining.

That was fine for four fixtures. It stopped being fine because content is added
to the database *while you play* — a flat, unsearchable list is fine at 12 rows
and unusable at 60. Cities: Skylines 2 shipped a comprehensive catalogue and
players still needed a mod to search it by name, type and tag. Ours grows faster
than theirs, because a new item is one MCP call away.

## The shape

Three zones, three jobs, no overlap:

| Zone | Contains | Interactive? |
|---|---|---|
| **Top-left column** | cash, day, season, clock, reputation, then active modifiers | no — passive readout |
| **Bottom nav** | one icon per menu, each with a live badge — plus Build, which is a mode | yes — this is the menu |
| **Bottom bar** | the build palette, or the roster — one at a time, never both | yes — one tap or number key each |

**Everything you press is one column at the bottom centre**, bottom up: the nav,
the bar, then the panel rising out of whichever button you pressed. The nav ran
down the top-right corner until the palette moved to the bottom, and that left
the thing you press most and the way into every menu at diagonally opposite
corners — a session was a stream of corner-to-corner mouse journeys.

The offsets are arithmetic off two numbers rather than literals kept in step by
hand: `--nav-h`/`--nav-bot` give `--nav-top`, and `--build-h` is the bar's
measured height, **explicitly 0 when no bar is up** (`measureBar(true)`) — the
element is still in the document with a height of its own, and a stale value
floats the panel over empty screen. `#log`, `#carry` and `#prompt` share one
`calc()` off the same stack, which retired the `body.building` overrides.

`#mods` moved from top-right to under `#stats` on the left: it is a passive
readout and belongs with the other passive readouts, and the rail now owns the
right-hand edge. `#help` was deleted as a permanent line and became the `/`
section — it used to hide itself in build mode, which is exactly when a new
player most needs it.

## Files

| File | Holds |
|---|---|
| `client/sections.js` | `SECTIONS`, `BUILD_TOOLS`, `buildGroups`, `staffGroups`. Every menu and both bars, as data. |
| `client/bar.js` | The bottom bar itself — tiers, scrolling, the sub row. Knows nothing about what is in it. |
| `client/panel-drag.js` | Dragging `#panel` by its header, and remembering where each menu was left. |
| `client/upgrade-menu.js` | One upgrade's own menu — what it does off its payload, and the button that buys it. |
| `client/worker-menu.js` | Everything one hire can do. Opened by pressing them on the bar. |
| `client/rail.js` | The rail widget: icons, the lit state, badges. |
| `client/icons.js` | **Generated.** Inline SVG strings. `npm run icons`. |
| `client/fixture-menu.js` | Everything one fixture can do, including its seed list. |
| `client/ui.js` | `showSection`/`paintSection` — the one renderer — plus the HUD, the panel and the seed wheel. |
| `scripts/build-icons.js` | Bakes the icons we name into `client/icons.js`. |

## Adding a menu

One entry in `SECTIONS`. It gets its rail icon, its hotkey, its badge, its
search box and its chips with no other change anywhere.

```js
{
  id,        // doubles as `openPanel` — must be unique, see below
  icon,      // from ICONS
  name, key, // rail tooltip and hotkey
  title,     // panel header
  facet,     // 'tag' | 'season' | 'kind' — omit for no filtering at all
  onOpen,    // optional side effect (Build turns build mode on)
  rows(ui),  // the whole menu, as descriptors
  foot(ui),  // optional note under the rows
  badge(ui), // what the rail shows without being opened
  live(ui),  // signature of everything rows() reads
}
```

Row descriptors: `{ icon, name, sub, right, facets, picked, dim, run,
button: {label, run}, tail, plain }`, or `{ sep }` for a heading. The fixture
menu builds its seed rows in the same shape and renders them with the same
`ui.rowHtml`/`ui.wireRows`, so there is one row implementation, not two.

Two things that will bite:

- **`id` doubles as `openPanel`.** `setCatalog` and `update` both test it to
  decide whether an open menu needs redrawing. Reuse an id and two menus fight
  over one panel.
- **`live(ui)` must name everything `rows(ui)` reads.** It is the only thing
  that redraws an open menu. Leave a field out and that menu silently goes
  stale; put the whole snapshot in and it redraws ten times a second over a
  live canvas. Supplier's signature is one value — the cash you have — and that
  is the target.

## The bottom bar

Three things use it and never two at once: **Build**, the **roster** and
**Upgrades**. They are one strip of screen, so claiming it takes it off the
others (`UI.showBar`), and build mode wins ties — it is a state of the *world*,
and a bar you cannot see is a mode you cannot see you are in. `UI.barTab` keeps
each one's open tab separately: they share nothing but the strip, and a roster
tab is not an answer to a build question.

**Build arms; the other two browse.** A build entry stays lit and the next tap
on the ground places it. A person or an upgrade *opens* — `showWorker`,
`showUpgrade` — and leaves nothing armed, so `picked` follows whichever menu is
open rather than a selection the UI is holding (`renderBrowseBar`).

`client/bar.js` is the picker itself: tabs, the sideways scroll, the number
keys, scrolling the selection into view, the third tier. It draws from data and
calls back; it knows nothing about fixtures or people. A caller supplies

```js
group = { id, name, icon, blurb, items: [item] }
item  = { id, icon, name, note, badge, title, warn, last }
sub   = { label, options: [{ id, name }], picked, onPick } | null
```

and gets the behaviour for free. `pinLast` is how Demolish and Hire stay at the
end of every tab they appear on — a stable sort, because without it a pinned
entry lands wherever the source list put it, which on some tabs is slot one
under the `1` key.

**Build is not a section.** It was one — a 214px list in `#panel` — while the
bottom bar showed the first nine entries of the same list. Two palettes for one
palette, and the bar could only ever be a preview: nine is how many number keys
there are, so a tenth fixture had nowhere to go but the panel. The bar has tiers
now and it scrolls, so it *is* the catalogue and the panel copy is gone.

Four tiers, top to bottom, all in `#build-bar`. Two of them come and go:

| Tier | Element | Build | Roster |
|---|---|---|---|
| Category | `#build-groups` | `BUILD_GROUPS` — Shop, Farm, Appliances, Building, Decoration | Everyone, then one per kind actually hired |
| Part | `#build-subs` | a split group's `subs` — Building is Walls, Floors, Yard | unused |
| Entries | `#build-tools` | palette entries. `1`–`9` reach the first nine | one per hire, note = what they are doing now |
| Choice | `#build-shapes` | `variantsOf` the piece, when there are two or more | unused |

**A tab that opens onto nothing never renders.** For Build that means dropping
any group whose only entry is the pinned bulldozer — which is what Appliances
looks like before anybody authors a machine. The roster's Everyone tab is the
exception and always shows, because with nobody hired it is still where the
Hire button lives.

**A tab may split once, and Building had to.** It started as three edge tools
and collected the floor catalogue and both yard pads on top, so it was a dozen
entries and the only tab you had to scroll — which hides its far end behind a
gesture nobody makes on a strip that looks complete. `subs` on a `BUILD_GROUPS`
entry is the same tab shape one level down, drawn by the same code, resolved by
the same two rules: an empty sub-tab is dropped, and a group left with fewer
than two shows its flat list instead. So a world where nobody has authored a
floor sees Building exactly as it was. A tool names its sub-tab beside its group
(`sub: 'walls'`), one that names none falls to the first — the same "misfiled
beats invisible" default `group` already has — and a pinned entry is on all of
them, because "get rid of that" is not a question about which part of the
building it is. Depth stops there: two levels is as far as you can go and still
see where you are.

`UI.barSub` remembers the open sub-tab per group, the way `barTab` remembers the
open tab per bar, so coming back to Building puts you back on the job you were
doing. `Tab` cycles the **leaves** — a split group offers its sub-tabs and never
itself, since stopping on a Building that immediately redirects you to Walls is
a press that changes nothing you can see.

**The last tier belongs to the picked entry, so it leaves when that entry
does.** Browsing to another tab used to leave the shape row behind, labelling a
fixture no longer anywhere in front of you — a row of buttons that appear to do
nothing, because picking a shape for something you cannot see changes nothing
you can see. `renderBar` draws it only while `picked` is among the entries on
screen.

**Picking is not the same verb in both.** A build entry *arms* — it stays lit
and the next tap on the ground places it. A person *opens* — `showWorker` puts
their menu in `#panel`, and nothing stays armed, because pressing somebody is
opening a door rather than picking up a tool.

The split is by **what you are doing**, not by which code path places it — a
fence is drawn on an edge exactly the way a wall is, and it sits under Farm
because fencing a field is farming. A tool may name several groups (`group` is a
string or an array), and a group nobody has authored anything for never renders.

**The hint (`#build-hint`) sits above the bar and only when it has news** — what
is in your hands, what you are pointing at, or an amber warning. It used to
carry a standing "tap bare ground to build a shelf", which restated the button
already lit beside it, sat on the bottom edge of the screen, and held the rest
of the corner HUD up for a line nobody read twice.

### A button shows the thing

`client/thumb.js` draws every palette entry from its own row: an item may carry
`art` (a picture of *that* shelf) as well as `icon` (the glyph for its
category), and the button prefers the art.

Five floor designs wearing one grey glyph is the whole argument. A floor **is**
a look — that is the entire thing you are choosing between — and the palette was
asking you to pick one by reading five names, which is a colour chart printed in
black and white. A catalogue anyone can add to has the same problem one step
out: the day somebody authors a second shelf, two buttons say "shelf" and show
the same picture.

| Entry | Drawn from |
|---|---|
| a piece | `partsAt(model, 0)` — the tier you get for buying one, not the tier you could upgrade to |
| a plot | …plus the tile its kind lays (`FIXTURES[kind].ground` → `TILE_STYLE`), because a bed **is** the ground and its model is one edging board |
| ground | a 3×3 patch through `patternColor`, the function the floor itself uses |
| an appliance | `variantModel(stationRow, station)` — the same resolution `Scene.fixtureModel` makes |
| a wall, window, doorway, fence, gate | `edgeBands(style)`, in a stub of plain wall either side |
| Demolish | nothing. It is a verb, and a picture of a thing would lie about what tapping it does |

Boxes and cylinders, projected on `BASE_CAM_OFFSET`'s own angle and lit by
`scene.js`'s own sun, painter-sorted, in inline SVG — so art is just a longer
icon string, needs no lifecycle, and is sharp at any density. Nothing is
recomputed: the caches are keyed on the model and surface **objects**, so a
catalogue reload hands over new objects and the old art falls off the end with
them. There is no version to remember to bump.

**A lookalike is worse than a glyph, and you will never catch it.** The edge art
was hand-drawn for about ten minutes and it was wrong in two ways — a blue pane
for a window, posts and rails for a fence — where the game glazes with the
wall's own colour at `GLASS` opacity and builds a fence as a low solid slab.
Nobody holds a 38px button up against a wall across the room. So the shape moved
into `edgeBands` in `palette.js`, beside the style it reads, and `scene.js` and
the thumbnail both ask for it. What the thumbnail still owns is the *context*,
and an opening needs it to be a picture at all: a doorway alone is a lintel
floating over a threshold, and only the wall either side makes that a way
through rather than a bench. The neighbour is `{...style, opening: false, glass:
false}` — by construction the plain wall it would sit in, so there is no table
of which piece pairs with which.

`--build-h` is the bar's measured height, set in `renderHotbar` → `measureBar`,
and `#log`/`#carry`/`#prompt` clear the bar with `calc()` off it. It is measured
rather than written down because the bar grows and shrinks — the shapes tier
appears, the hint comes and goes — and a hard-coded offset is one that goes
wrong the day a tier is added.

## Upgrades

The list is the bar (`upgradeGroups`) and one row of it is its own menu
(`showUpgrade`), so there is no Upgrades *section* any more — `UPGRADE_BAR` is a
rail item beside `BUILD_MODE`, the second thing on the rail that is not a panel.

**One press is the wrong amount of ceremony for a permanent, unrefundable
$20,000**, which is why a bar entry opens a menu instead of buying. That menu
reads what it sells off `payload` rather than off the prose — a row edited over
MCP to 30% off says 30% without anybody remembering to rewrite its description —
and names what it needs first as rows you can tap to walk the ladder.

**Two kinds no longer list, and neither is deleted** (`RETIRED` in
`sections.js`):

- `staff` — hiring is the roster now, which can express two of somebody, letting
  one go, and promotions; an upgrade is a permanent boolean and expresses none
  of it. `buyUpgrade` has refused these since the move. The rows must **stay**:
  `rosterFromUpgrades` reads them once to migrate an old save's people onto the
  roster, and deleting them would take those hires with them.
- `space` — the shop used to grow by buying land and letting the generator
  re-flow it. You draw your own walls, so the building's shape is something you
  make rather than something you unlock, and this was the last upgrade that
  silently rearranged a shop you had just laid out.

Both are still live server-side, so `simulate`'s bot can still buy `space`. If
that matters for balance, the fix is deleting those two rows over MCP, not a
client change.

## Deleting things

One tool, on every tab, last in each: **Demolish**. Aim it at a fixture and a
tap tears that fixture out; drag it along a line and it knocks the wall or fence
through. Both halves already existed and neither was findable — walls had a
`knock` tool, everything else was Remove inside the fixture's own menu, and
nothing said so.

It stays armed after each removal, which is what a bulldozer does; clearing a
row otherwise means re-picking the tool between every press. Three things keep
that honest, and the history says all three are needed:

- **The ring goes red** (`setAimTarget(f, 'raze')`), and the hint says *Tear out
  the shelving* instead of *tap to open it*. A tap with the bulldozer up is a
  verb, not a look, and the copy has to say which.
- **The server refuses anything with contents in it**, or your last till. So a
  mis-tap can only reach an empty fixture, and it refunds `FIXTURE_REFUND`.
- **It names its target.** The Clear tool that ate seven shelves in a row fired
  on *proximity* and re-armed the instant it finished — standing still emptied
  the shop while you read the log. This one removes the one thing ringed under
  the pointer, one tap each.

## Keys

Bound from `SECTIONS` in `main.js`, so a new section is bound and labelled the
moment it exists.

| Key | Does |
|---|---|
| `B` `U` `T` `/` | toggle Supplier · Upgrades · Shop · Controls |
| `H` | the roster along the bottom — a bar, not a panel (`bar: 'staff'` on the section) |
| `G` | build mode on and off — the rail's Build button presses this |
| `1`–`9` | the open tab of whichever bar is up, seeds when neither is |
| `Tab` | next tab of the bar that is up, sub-tabs counting as their own stops (`shift` for back). Prevented hard, or focus lands in the search box |
| `R` | turn what you're placing |
| hold `E` / `Space` | use what you're stood by |
| hold `Q` | seed wheel |
| `Esc` | clear the search box → close the menu → close the roster bar → put down what you're carrying → leave build mode |
| right-click | the same ladder, on the world — but cancels a half-drawn wall run first |
| `,` `.` | turn the view a quarter each way |
| right-drag | the same turn, held — 90px of sideways travel per quarter |

Right-click runs `ui.escape()` rather than dropping straight out to shopkeeping,
and the difference is load-bearing exactly once: **with something in your hands,
"out" has to mean putting it back before it means leaving the mode**, or one
click strands the fixture you were carrying. Mid-drag it takes the run instead —
`endStick()` with no event drops the segments without sending them — because a
wall you have changed your mind about is not a mode you have changed your mind
about. The build bar swallows the browser's context menu without acting on it: a
right-click on a button is a miss, not a decision to leave.

**The right button splits the way the left one does: a drag turns, a click backs
out.** `spin` in `main.js` is the mirror of `drag` — press, accumulate sideways
travel, and every `SPIN_STEP` of it fires `scene.rotateView(∓1)`, exactly what
`,` and `.` send. It steps in whole quarters rather than orbiting freely because
`scene.quarter` is an integer several things read back: WASD is remapped through
it so "up" stays up, and so is the facing of what you place. A camera resting
between two corners has no answer for either.

Three details are not free:

- **Backing out had to move off `contextmenu`.** That event fires on *press* on
  macOS and Linux and on *release* on Windows, so on two platforms out of three
  it lands before the drag it is meant to be distinguished from. It now hangs
  off pointerup, where "did this press move?" is a question with an answer, and
  `contextmenu` is left doing only what it is reliable for — swallowing the
  browser menu.
- **Cancelling a wall run moved to pointerdown for the same reason.** Right-press
  during an `edgeDrag` drops it there and starts no spin; leaving it on
  `contextmenu` meant that on Windows the pointerup fired first and *built* the
  wall you were cancelling.
- **A mouse reuses one `pointerId` for every button.** So spin refuses to start
  while a left drag is live and the left drag refuses to start while a spin is,
  or the second press hands the first one's handler its own id and steals its
  moves. A cancelled pointer clears the spin without backing out — a
  `pointercancel` is not a click.

The world follows your hand: drag right and the shop turns right, which is `,`.
Easing lives in the renderer (`camAngle` chases `camQuarter * QUARTER`), so a
fast flick across three steps still arrives as one swing rather than three.

## Going places

**You name a destination; the server routes to it.** A click on the floor sends
`walk-to`, and `Game.walkTo` runs the same `findPath` customers and staff have
always used, on the same grid `canStand` reads. The player was the last mover in
the game steering by raw velocity, and stopped being a special case: routes go
round shelving and honour edge walls at *plan* time instead of bouncing off them
a frame at a time.

Clicking a *thing* sends its id rather than a tile, and `walkToFixture` resolves
the anchor (`browseAt ?? serveAt ?? useAt`). That is not tidiness. A shelf is
worked from one side, and A*'s own "goal is blocked, aim at a walkable
neighbour" fallback will happily park you behind it, in reach of nothing — which
reads as the click having been ignored. Resolved server-side for the reason the
build ghost shares one validator: an anchor worked out twice can disagree with
itself.

**This is what replaced the drag-joystick**, which was wrong in two ways no
amount of radius and deadzone fixes. It steered in *screen* space on a camera
you can turn, so every quarter turn re-taught your thumb which way was forward;
and it put your thumb on top of the thing you were watching, which on a phone is
most of the shop.

It also made one tap do a whole errand. Actions charge on proximity, so arriving
at a shelf's working spot *is* stocking it — tap, and the rest happens with no
second input. That only works because the anchor is right.

### One press, three meanings

| the press | on the floor | on a thing |
|---|---|---|
| moved | pan the camera | pan the camera |
| still, released | go there | open it |
| still, held | — | — |

The hold is wired and drawn — the aim ring winds in while you keep pressing —
but does nothing (`HOLD_OPENS` in `main.js`). Opening moved back onto the tap,
which leaves the hold with no job the tap does not already do sooner. It is a
flag rather than a deletion because what a *tap* should mean has now changed
three times, and the server still resolves a fixture's working spot
(`walkToFixture`, covered by `verify:walk`) even though nothing currently asks
it to.

Same three on a mouse and on a finger, which is a decision that was made
**twice** and is worth recording in both directions.

The middle version split them: a mouse clicked to open and a finger tapped to
run the errand, on the reasoning that a mouse should not have to wait 420ms for
a menu it used to get instantly. That cost is real and it is the honest argument
against what is here now.

What the split cost was worse. The best thing in the scheme — point at a shelf
and you cross the shop and stock it — became the one thing a mouse could not do,
on the device where pointing at a shelf precisely is *easiest*. Playing it, you
end up clicking the floor beside things, which is the fiddliness the whole
change was meant to remove.

So: one gesture, one meaning, and the wait is the price of the tap doing the
useful thing.

**People are the one exception, and it went the wrong way first.** You cannot
walk to somebody who walks off, so a tap on a hire has nothing to *go* to. The
first reading of that fact was that a tap should look straight past them to the
shelf behind — true about what the tap cannot do, and wrong about what it
should, because it left no way to open a worker at all except by holding. There
is exactly one useful answer to pointing at a person, so pointing at one now
gives it, on the tap, with no wait.

It is checked before the open-panel dismissal, so a worker is one press away
rather than two whenever anything else is up, and skipped entirely while the
bulldozer is armed — a clerk wandering in front of a shelf must not shield it.

Steering always outranks a route: `stepPlayers` drops `p.path` on the first
frame of key input rather than blending the two, because a key that only slowed
a route down reads as the game ignoring you.

### Picking things up is asked for

Everything else in `actionFor` is proximity offering you the most useful thing
within arm's reach. Taking is not, and it is the one place where the ring is not
enough on its own.

The reason is that proximity can only ever answer with the *nearest* one. At a
bay stacked three deep, or in an aisle on a three-tile pitch, that is not a
choice anybody made — it is the same argument build mode already won when every
build verb started naming its target. And the cost of getting it wrong is
asymmetric: a pickup you did not ask for fills your hands, and full hands
refuse every other action in the game until you walk to the drop-off.

So there are two ways to say which, and one verb behind both:

| you point at | you press | it sends |
|---|---|---|
| a crate in the yard | the crate itself | `take { palletId }` |
| one board of a shelf or freezer | its Take button, beside the count | `take { shelfId, itemId }` |

`Game.take` sets `p.errand` — a target and nothing else, no timer — and walks
you to it. `errandAction` arms the ordinary charge once you are in reach, so a
pickup looks and cancels exactly like harvesting does: the ring winds in, and
walking off before it closes throws it away. The errand is spent when it fires,
refused or not, so one tap is one armful and a refusal cannot retry itself
against the same full hands forever.

**The walk is part of it, not a convenience.** A menu button that filled your
arms from across the shop is the bug `buyStock` already fixed once, where
ordering delivered straight into your hands and the shop floor stopped
mattering. `unshelve` checks reach for the same reason `stockShelf` does.

The refusal is spoken: `errandAction` pushes the error into the log, because
this is the one action somebody asked for by name and a silent no reads as a
broken button.

**Taking still needs a latch, and this is where the first cut got it wrong.**
`stowLock` used to stop a crate you had just put down picking itself back up,
and it looked like naming the pickup retired it — the loop needs both halves to
arm on their own, and now one of them is a button. It doesn't. The pair just
changed partners: a pickup *leaves you holding something, stood at the thing it
came off*, which is precisely the state `stock` arms in. So taking a board off
a shelf put it straight back on the next tick, and taking a crate parked at the
drop-off stowed it into a crate on the same tile.

`p.tookFrom` is the latch, set in `errandAction` on a pickup that worked and
cleared in `stepPlayers` once you are out of reach of the source — *away* means
out of reach, for the same reason it did before, or a shuffle on the spot hands
it back. It holds off exactly two things: stocking **that unit** (a neighbour
still takes it, which is a real errand), and stowing at all while it is live.

The general rule is the one the old latch already stated, and it survives the
scheme that was supposed to remove the need for it: **two actions that undo each
other and both arm by themselves will ping-pong, and making one of them explicit
is not enough — what matters is the state the first one leaves you in.**

### Looking without going

`camPan` is an offset added to `camTarget`, not a second camera — `camTarget` is
overwritten from the player's position every sync, so a pan folded into it would
be erased ten times a second.

It is kept until you **go** somewhere rather than until you let go, and that is
the load-bearing choice. A pan that sprang back on release is useless on a
phone, where looking at the far end of the shop and *then* tapping something
there is the entire point — the shelf you were aiming at would be back off
screen in the instant between deciding and tapping. So `walkTo` recentres, and
so does the first frame of WASD.

`panBy` converts pixels to tiles through the ortho frustum over canvas height
(zoom lives on the camera, not on `FRUSTUM`), then stretches the screen-up axis
by `GROUND_STRETCH` = 1/sin(pitch). Without the second conversion a drag tracks
correctly across the screen and lags going up it, which reads as the ground
being slippery rather than as a projection error.

### `touch-action: none` is not optional

Without it on `#game`, the browser claims every touch gesture as a scroll or a
page zoom and takes it by firing `pointercancel` a couple of events in. Measured
before the fix: a two-finger twist arrived as 2 pointerdowns, 2 pointermoves and
**2 pointercancels**. Panning, pinch-zoom and the twist all did nothing on a
touchscreen while working perfectly under a mouse — which is the worst shape a
bug can have, because every desktop test passes.

The twist earns its place for a reason that is easy to miss: turning the view is
how you see behind a shelf, and it was `,` and `.` only. A phone has no comma,
so every back aisle was permanently hidden on the device this scheme is for.

**`G` is not a menu key**, and since the palette moved to the bar there is no
Build menu for it to be confused with. `BUILD_MODE` in `sections.js` is what
puts it on the rail: same shape as a section, plus `mode: true`, which is how
`Rail` knows a press toggles the world rather than opening a panel and how
`setOpen` knows never to light it as though a menu were open. Its `on` state is
driven by `ui.buildOn` in `Rail.update`.

`_modeFromMenu` outlived the Build section and is still load-bearing, because
**a fixture's own menu still borrows build mode**: the server takes the mode as
consent for every verb that names a fixture by id, so pressing Move or Remove in
a menu you opened without it switches it on for you (`withBuildMode`) and gives
it back when the menu closes (`releaseMenuMode`).

- **Act, and the mode is yours.** Picking a tool off the bar, lifting something,
  placing something — all call `commitBuildMode` first.
- **Any panel closing with nothing left open → a borrowed mode goes.**
- **`G` outranks it.** A mode you turned on yourself is never one a menu closing
  can take away.

Two supporting details, both load-bearing:

- It skips while `ui.holding`, or dropping the mode would strand a carried
  fixture. The Move handler can't rely on that — `holding` isn't true until the
  next snapshot — so it clears the flag itself.
- `closePanel` releases the mode *after* clearing `openPanel`, because
  `toggleBuild(false)` closes an open fixture menu and would otherwise re-enter.

**An edge tool is never sent to the server.** `setBuildTool` refuses anything
outside `FIXTURES`, so telling it "fence" only ever produced *no such build
tool* on screen — and drawing one names its own kind in `build-edge` anyway, so
there was nothing to tell it. `selectBuildTool` skips the message and
`syncBuildTool` ignores the server's answer while one is armed (`armedEdgeTool`),
or the next snapshot would put the shelf back in your hand a tick after you
chose the wall.

**Every `keydown` returns early on `INPUT`.** Without it, searching the supplier
for "carrot" walks you into a wall and buys a shelf.

## Search and chips

The CS2 lesson, and the part most likely to get quietly dropped.

- Both appear only when a section declares a `facet` **and** has 8+ rows. Search
  over four shelves is noise; a readout like the Shop report has nothing to
  search at all.
- Chips are built from the facets the rows actually carry, not from the whole
  vocabulary — chips that match nothing are worse than no chips.
- Items carry `tags`, upgrades carry `kind`, crops carry `seasons`. There is no
  single "tags" field across content types, which is why the section names its
  facet rather than the renderer assuming one.
- Filter state is per-section and cleared on open. Filtering is done over row
  data and re-rendered, never by hiding DOM nodes — the sections already
  re-render wholesale on catalog changes, and a second path would diverge.

## Badges

The display half of the rail — what a menu would tell you if you opened it.

| Section | Badge |
|---|---|
| Build | `●` while you're carrying a fixture |
| Supplier | shelves empty or under a fifth of a stack |
| Staff | how many are on shift |
| Upgrades | how many you can afford and don't own |
| Shop | `▲`/`▼` on today's profit |

`Rail.update()` runs every snapshot but only writes to the DOM when the text
changes. Ten DOM writes a second for a dot nobody is looking at is how a 60fps
canvas starts stuttering.

The Shop report is **today's** numbers, straight out of `state.stats`. The
server keeps yesterday's in `_lastDayStats` but does not send it, so nothing
here claims a comparison it cannot make. Sending it is a `snapshot()` change if
we ever want "vs yesterday".

## Staff

The roster is the **bottom bar** (`H`), not a panel: Everyone first, then a tab
per kind actually hired, each entry a person carrying what they are doing right
now. That makes "who is on the tills" a glance rather than a menu. Pressing one
opens their own menu in `#panel`, exactly the way pressing a shelf does — two
clerks are two entries and which one you pressed is the only thing that tells
them apart. The **Hire** entry is pinned last on every tab and opens the section
below, because hiring is *browsing* — wages, jobs, what each kind is for — and
the bar is for choosing between things you already have.

Hires are **upgrades** — `kind: 'staff'`, `payload.role` — and `syncStaff` adds
or removes an NPC to match what you own. They are entries in the same `players`
table you are in, so they obey the rules you obey and the roster is read
straight off the snapshot: what a row says a hire is doing is literally what it
is doing on the floor.

The section exists because hiring was reachable but invisible — four staff
upgrades sat among seventeen others with nothing grouping them.

**What it deliberately does not do**, because the sim has no support for it and
a button that lies is worse than no button:

- **No firing.** Ownership of an upgrade is permanent; there is no "sell
  upgrade" message. Undoing a hire means a server change.
- **No assignment.** You can't put a clerk on a particular till or a farmhand on
  a particular field. `stepStaff` picks targets itself.

The foot of the section says both out loud. If either becomes wanted, it starts
in `server/sim/staff.js` and needs a new room message, not a UI change.

## Density

The panel is **214px wide and capped at 62vh** — about 15% of a 1440px screen,
where it started at 380px and full height. It is a menu over a game, not a
document, and the shop floor behind it is the thing you are actually looking at.

Every row is **48px, always**, and that is deliberate: both lines are single
lines with `text-overflow: ellipsis`, so no row can grow taller no matter what
the copy says. It is the only way a menu fed from a live database can promise
not to run off the screen — a description added via MCP cannot break the layout,
because the layout does not read it.

The full text is on the row's `title`, so hovering still explains. Two more
things follow from the width:

- **A price goes under its icon, not out on the right.** A right-hand price
  column reserves the width of four characters on every row and pushes every
  name onto a second line. Plain readouts (the Shop report) keep their value on
  the right, because there is no icon to stack it under and the numbers want to
  line up with each other.
- **No hotkey numerals on rows.** `1`–`9` still pick, and the hotbar along the
  bottom shows the numbers where they are actually being pressed.

Blurbs are one short clause. Anything longer gets ellipsised anyway, so writing
it long only hides it.

## Icons

game-icons.net (CC BY 3.0) for anything that is a thing in the world, Remix Icon
(Apache 2.0) for interface chrome. Emoji rendered differently on every machine
and looked like placeholder art, which they were.

`scripts/build-icons.js` lifts only the icons named in its `WANTED` map out of
`@iconify-json/*` and writes `client/icons.js`. The full set is 4134 icons and
several megabytes — shipping that to a browser to use twenty of them would be
absurd, and a CDN breaks the moment the game is played over a tunnel.

To add one: put it in `WANTED`, run `npm run icons`, commit the generated file.
An unknown name fails the build rather than rendering a blank.

Icons are `width="1em"` and `fill="currentColor"`, so every existing `font-size`
rule still sizes them and every existing colour still colours them. They are
`display: block` because an inline SVG sits on the text baseline and drags a gap
under every button.

## Seeds are not a section

There was a Seeds menu on the rail. It's gone, and what to plant now lives in
the **plot's own menu**, above the move/remove actions, because at an empty bed
planting is the point and everything else is housekeeping.

The rule it illustrates is worth keeping: **a choice that only ever applies to
one kind of thing belongs on that thing, not on the rail.** The rail is for what
you reach for from anywhere — buying, building, checking how you're doing.

**Picking one sows that bed**, rather than setting a preference you then have to
walk over and act on. `Game.sow` does the whole job in one: turns rough soil
over, charges for the seed, and replaces whatever was growing — changing a crop
no longer means emptying the plot first and leaving it bare. It also sets
`selectedCrop`, so the next bed you walk up to agrees with the last one you
picked.

Two refusals, both to stop a mis-tap costing money:

- **A ripe plot offers no seeds at all.** Sowing over a harvest you could have
  picked is not a trade anyone means to make, and harvesting costs one hold.
- **The crop already growing there isn't clickable** — its row shows how far up
  it is instead. Otherwise a double-tap buys the same seed twice.

There is no proximity check, deliberately. Every other action a fixture's menu
offers — move it, empty it, sell it back — already reaches across the shop, and
a seed picker that only worked while stood on the bed would be the odd one out.
The hold-to-till, hold-to-plant loop is untouched for hands-on play.

Three routes set the crop, one value between them:

| Route | For |
|---|---|
| hold `Q` | pointer — a flick, no screen space at rest |
| tap a plot | sows that bed, with costs and seasons in front of you |
| `1`–`9` | keyboard |

The plot menu's rows are built with `ui.rowHtml`/`ui.wireRows` — the section
renderer's own row plumbing — so they match every other list without a second
implementation. `fixtureSignature` carries `selectedCrop` and the season, or the
list wouldn't follow the plot as it grows.

## Moving a panel

Grab the header and drag; double-click it to give the position back to the
stylesheet. Stored in localStorage **per `openPanel` id**, not per element:
there is one `#panel` and half a dozen menus rendering into it, so one shared
position would be a panel that jumped every time you opened a different menu
and read as having forgotten.

Two things it has to get right, both invisible until they are wrong:

- **A live drag outranks a repaint.** A fixture or a hire menu re-renders from
  the snapshot, which calls `showPanel` → `restorePos` — ten times a second,
  each one putting the panel back under the cursor. `restorePos` returns early
  while a drag is in flight.
- **A press that never moved is not a reposition.** Filing one would pin the
  panel at wherever it happened to be the first time you touched the header.

## One panel system

Anything that lists, describes, or offers actions renders into `#panel`.

**A tap opens a fixture's menu at any time, in or out of build mode.** The two
gestures were always distinct — a hold *uses* a thing, a tap *looks* at it — and
only the looking half was gated behind a mode for no reason. Build mode is now
needed for exactly one thing: putting something new on bare ground.

**A tap on bare ground dismisses whatever is open**, the way any menu floating
over a world is expected to behave. In build mode that tap still builds — and
building is committing, so it takes ownership of the mode first (`commitBuildMode`)
rather than closing a stale fixture menu out from under itself and dropping you
out of build mode mid-place.

The hover ring follows: outside build mode there's no ghost, but whatever is
under the pointer is still ringed, because a target you can click with nothing
marking it is a secret rather than a feature. Neither happens while you're
carrying something — then every tile is a home for what's in your hands.

| Building | Where it goes |
|---|---|
| A browsable list of content | a section in `SECTIONS` |
| Everything one fixture can do | `showFixture` — already there, already correct |
| A short confirmation or error | `toast()` |
| What holding the button would do | `updatePrompt()` |
| A radial quick-pick under the pointer | the wheel, and only the wheel |

**Do not add a floating div.** `showFixture` refreshes itself from the snapshot
via `fixtureSignature`, follows its fixture through a re-flow via
`refreshFixture`, and unwinds correctly under `escape()`. A parallel popover
gets none of that and will go stale, survive a re-flow it shouldn't, and eat the
Escape key. If something genuinely must be anchored in world space, it uses the
same row classes and a single shared element.

`showPanel` hides the filter bar every time it runs, and `paintSection` turns it
back on straight after. That is what stops a fixture menu inheriting the
supplier's search box.

## Still to do

- **`client/ui.js` is 1140 lines**, well over the 600 cap. The fixture menu
  already left for `client/fixture-menu.js`; the build bar (`renderHotbar`,
  `renderBuildBar`, `buildGroupList`, `openBuildGroup`, `selectBuildGroup`,
  `selectBuildSub`, `buildStops`, `cycleBuildGroup`, `hotbarTools`,
  `renderBuildHint`, `measureBar`) is the next ~200 self-contained lines and
  wants `client/build-bar.js`.
- **A method nobody calls twice is a method nobody notices is missing.**
  `selectBuildVariant` called `this.renderBuildShapes()`, which has never
  existed, so every press of a shape button threw before it reached the hint
  below it. It survived because the throw is *late*: the variant is set on the
  line above, so the next shelf you placed really was a corner unit and only the
  bar disagreed. Nothing here is covered by `npm run verify` (see below), and
  this is the shape that gap has.
- Nothing verifies the rail or the bar at narrow widths beyond a look — `#panel`
  is `calc(100vw - 72px)` under 720px to clear the rail, and `.cat .nm` is
  hidden there so five tabs still fit.
- **None of the bar has been seen by an agent.** `screenshot` is
  `renderer.domElement.toDataURL()` — the WebGL canvas only — so every DOM
  change in this file is verified by a human looking at it or not at all.
