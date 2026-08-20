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
| **Top-left column** | the date over the balance, cashflow, clock, the three gauges, then the demand meter | almost — two switches ride on it (the clock pauses, the left edge is the shutters), and nothing else in it is pressable |
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

The demand meter (`#rci`, once `#mods`) moved from top-right to under `#stats` on
the left: it is a passive readout and belongs with the other passive readouts,
and the rail now owns the right-hand edge. `#help` was deleted as a permanent
line and became the `/` section — it used to hide itself in build mode, which is
exactly when a new player most needs it.

## Files

| File | Holds |
|---|---|
| `client/sections.js` | `SECTIONS`, `BUILD_TOOLS`, `buildGroups`, `staffGroups`. Every menu and both bars, as data. |
| `client/bar.js` | The bottom bar itself — tiers, scrolling, the sub row. Knows nothing about what is in it. |
| `client/panel-drag.js` | Dragging `#panel` by its header, and remembering where each menu was left. |
| `client/worker-menu.js` | Everything one hire can do. Opened by pressing them on the bar. |
| `client/rail.js` | The rail widget: icons, the lit state, badges, the delivery ring. |
| `client/tip.js` | The tooltip. One element, moved. Adopts any `title` in the game — see below. |
| `client/icons.js` | **Generated.** Inline SVG strings. `npm run icons`. |
| `client/fixture-menu.js` | Everything one fixture can do, including its seed list. |
| `client/ui.js` | `showSection`/`paintSection` — the one renderer — plus the HUD, the panel and the seed wheel. |
| `client/hud-meters.js` | The cashflow readout and the demand meter, as pure snapshot → HTML functions. Owns `DEADBAND`, the sparkline, and `zeroScale` — where a floating zero line goes, which the Shop report also draws. |
| `client/report.js` | The Shop panel, as a picture rather than a list. Same pure snapshot → HTML shape as `hud-meters.js`. |
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

There is a third kind, `{ html }`, and it is deliberately blunt: the string is
written into the panel body as-is, with no `.row` around it. **A list is the
right shape for anything you might press and the wrong shape for a report** —
every row is the same size, so a list says today's profit and "4 picked" are the
same size of fact. The Shop panel is the one menu that is a picture (see
`client/report.js`), and this is how it gets in. It carries no `name`, so
`applyFilter` drops it like a heading; no `run`, so `wireRows` never sees it.
Anything you put in it you escape yourself.

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
others (`UI.showBar`). `UI.barTab` keeps each one's open tab separately: they
share nothing but the strip, and a roster tab is not an answer to a build
question.

**Build mode is one press and the palette is the next** (`UI.pressBuild`). They
were one press, which meant the only way to be in build mode was with the
catalogue across the bottom of the screen — and most of what the mode is for is
rearranging what you already own: dragging a unit two tiles over, turning it,
opening a doorway, flying the view somewhere you cannot stand. None of that
needs the shelves, and the shelves are the biggest thing on screen. So the rail's
hammer cycles mode → palette → out, and Escape unwinds it the same way (the
palette is its own rung, above the mode and below an armed tool).

Three things hold it together, and each is a way the old shape said something
this one has to say elsewhere:

- **The bar was the honest test of "is the mode yours", and now `_modeFromMenu`
  is** (`UI.paletteArmed`). A fixture menu borrows build mode for one press of
  Empty or Rotate and must not make the ornaments clickable or WASD fly; the bar
  answered that only because a borrowed mode never raised one. A mode you chose
  with the bar down is now an ordinary state, so the question has to be asked of
  who asked for it.
- **Putting the palette away disarms** (`UI.showBar`). What the bar test was
  *also* protecting is a tap on bare ground buying a shelf, and that rung stays —
  it is `toolArmed`, and a tool left armed under a closed palette is the same
  invisible purchase with nothing on screen holding it.
- **The rail button is the whole of what says you are in the mode**, so it draws
  both states: lit for the mode, a pressed-in ring on top for the palette. A bar
  you cannot see is a mode you cannot see you are in — with no bar at all, the
  button is what is left to say it.

**Build arms; a person browses; an upgrade acts.** A build entry stays lit and
the next tap on the ground places it. A person *opens* — `showWorker` — and
leaves nothing armed, so `picked` follows whichever menu is open rather than a
selection the UI is holding (`renderBrowseBar`). An upgrade tile does the thing
it names, in whichever direction it is pointing.

`client/bar.js` is the picker itself: tabs, the sideways scroll, the number
keys, scrolling the selection into view, the third tier. It draws from data and
calls back; it knows nothing about fixtures or people. A caller supplies

```js
group   = { id, name, icon, blurb, items: [item], subs?: [group] }
item    = { id, icon, art, name, note, badge, title, warn, last }
choice  = { options: [{ id, name, art }], picked, open, onPick } | null
```

There was a fifth field, `caption` — a fixed slot at the far end of the tab row
naming whatever was under the pointer, falling back to whatever was armed. It
was written when a hover explanation in this game was a native `title`, and
`tip.js` retired the reason for it: the name now appears **at the tile**, which
is where the question was asked. A caption is the same answer given at the other
end of the bar, cut short to fit.

and gets the behaviour for free. `pinLast` is how Demolish and Hire stay at the
end of every tab they appear on — a stable sort, because without it a pinned
entry lands wherever the source list put it, which on some tabs is slot one
under the `1` key.

**Build is not a section.** It was one — a 214px list in `#panel` — while the
bottom bar showed the first nine entries of the same list. Two palettes for one
palette, and the bar could only ever be a preview: nine is how many number keys
there are, so a tenth fixture had nowhere to go but the panel. The bar has tiers
now and it scrolls, so it *is* the catalogue and the panel copy is gone.

Five tiers, all in `#build-bar` — but **three rows**, because the first three
share one (`#build-nav`). Two of the four come and go:

| Tier | Element | Build | Roster |
|---|---|---|---|
| Category | `#build-groups` | `BUILD_GROUPS` — Shop, Farm, Appliances, Building, Decoration | Everyone, then one per kind actually hired |
| Part | `#build-subs` | a split group's `subs` — Building is Walls, Floors, Roads, Yard, Staff, Customers; Decoration is Greenery, Lighting, Signs, Odds and ends | unused |
| Entries | `#build-tools` | palette entries. `1`–`9` reach the first nine | one per hire, note = what they are doing now |
| Choice | `#build-shapes` | `variantsOf` the piece — a card floating over the tile, not a row. Asked for | unused |

### The bar stopped being enormous

It was 150px of screen over a 56px nav, and the diagnosis was that none of it
was content. Four things, and each one is a rule worth keeping:

**Two rows of navigation became one.** Categories and parts were stacked, at two
different visual weights, and the second came and went — so *changing tab changed
the height of the bar*, and nothing on screen said which of the two rows `Tab`
was steering. They share `#build-nav` now: tabs, then a divider, then the parts
of the open tab, read left to right as one question. The divider is the sub row's
own left border, so it exists exactly when there is something to its left of.

**A tab is its icon; the open one wears its name.** `.cat` was `flex: 1`, so five
tabs stretched the full width of the bar — a wall of empty gradient, and a 190px
target for a 15px glyph. Five labels is also five things to read to find the one
that says where you are, and that label belongs on the tab that *is* where you
are. The blurb is the tooltip on all of them either way.

**The strip is tiles, and only the NAME came off them.** Every entry carried its
name and its price permanently: three lines, 78px tall, ~100px wide, eight on
screen, and it read as a wall of small text rather than as a row of things. The
art is already the label — `thumb.js` draws the actual piece, which is the whole
reason five floors stopped being five grey glyphs — and a name is long, ragged,
and only ever a question about *one* entry — which is a tooltip, and `tip.js`
puts it at the tile. At 48px about eighteen tiles fit where eight did, which is
the half of this that matters as the catalogue grows.

**The price did not come off them**, and that is the line between the two. It is
four characters of right-aligned arithmetic, and $40 against $110 across a row of
lamps is a *comparison* — one you cannot make by hovering items one at a time. It
costs 10px of tile height and it is the only thing on the button anybody was
reading.

**One width, whatever is in it.** The bar sized to its contents under a 960px
ceiling, and it is centred — so a four-entry tab was half the width of a
twelve-entry one, and switching between them slid the bar, every tab on it and
the tile under your pointer sideways. You cannot aim at something that moved
because you looked at something else. Fixed at `min(760px, 100vw - 28px)`: the
tabs are always in the same place, the tiles always start at the same edge, and a
short tab has room to its right — which is what a strip that scrolls looks like
when it doesn't need to.

Everything above the bar is `calc()` off `--build-h`, which is *measured*
(`measureBar`), so none of this needed a second number kept in step.

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
the same three rules: a tab that FITS is left alone, an empty sub-tab is
dropped, and a group left with fewer than two shows its flat list instead. So a
world where nobody has authored a floor sees Building exactly as it was. A
pinned entry is on all of them, because "get rid of that" is not a question
about which part of the building it is. Depth stops there: two levels is as far
as you can go and still see where you are.

**"Fits" is `KEYED`** — the same nine that decides how many entries wear a
number. At or under it nothing scrolls and every button is one press, so
splitting can only turn a row you can read into four rows of two you have to
choose between first. It is a rule about the catalogue rather than about the
tab, which is the point: the bar changes shape the day the shop outgrows it,
and never because somebody predicted it would.

**Which sub-tab an entry lands on is asked three ways, and the order is what
lets one mechanism carry both splits.** A tool that NAMES one wins
(`sub: 'walls'`) — that is Building, where the filing is a fact about the code,
since a wall, a floor and a bay are three different kinds. Failing that, a
sub-tab that asks for a TAG takes anything wearing it — that is Decoration,
where the filing is a fact about the *content*: `prop-floor` and `prop-ceiling`
say how a thing attaches, and a planter and a barrel attach identically, so the
only thing that knows a planter is greenery is its row in the database. Tag
`plant` and it is under Greenery about a second later, with no edit to the
client. Failing both, the first sub-tab that asks for no tags takes it. For
Building that is Walls, which is the "misfiled beats invisible" default `group`
already has; for Decoration it is Odds and ends, which is the half a tag-driven
split gets wrong if you leave it out — an untagged piece has to be *somewhere*,
or the first thing a new decoration does is disappear, and that reads as a
broken save rather than as a missing word.

The vocabulary is the decision, and it lives in two places on purpose: the tags
in `TAG_GROUPS.decor` (`shared/tags.js`, beside every other tag in the game) and
the tabs in `DECOR_SUBS` (`client/sections.js`, where what they are called and
what icon they wear is a UI question). A tab nobody has authored anything for
never renders, so declaring one costs nothing until it has something in it.

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

**And it is not a row.** It was one: drawn along the bottom of the bar whenever
the armed piece came in more than one shape. A tier that comes and goes changes
the bar's *height*, which moves every tab on it and the tile you were aiming at
— twice, once arriving and once leaving, while you were mid-decision. It hangs
off the top of `#build-bar` now (`position: absolute`, `left` from
`placeChoice`), over the world: no height, nothing moves. Three things follow
from that:

- **It is asked for** (`choice.open`), because a card that floats over the shop
  cannot also be free. **Hold a tile**, or press the **chevron** it wears —
  which is the same sentence build mode speaks on the canvas, where a hold on a
  fixture picks it up rather than opening it. The chevron is there because a
  hold nothing mentions is a gesture nobody finds, and a shape is cosmetic
  enough (`sim/index.js` — "to the build rules every appliance is the same")
  that never finding it would read as the game not having shapes.
- **A hold is cancelled by movement** past 8px. The strip scrolls sideways, and
  a drag is a press that has not let go yet — without it, pulling the far end of
  a tab into view opens the shapes of whatever tile you started the drag on.
- **Closing it does not repaint the bar.** `UI` hides the element directly:
  a repaint replaces every tile, and a button removed from the document between
  pointerdown and pointerup never fires its click — so with the card up, the
  press that was about to arm the freezer would land on a button that stopped
  existing halfway through, and the tile would just not respond.

**A shape is remembered per piece** (`UI.pieceVariant`, keyed by `variantKey`).
Arming a shelf arms the shelf you were building, not a Standard one — re-deriving
Standard on every trip to the bar makes a row of wall-run shelving the same
decision typed out nine times. Keyed by the *piece* rather than the kind, because
`variantsOf` reads a piece: two designs of shelf have two different sets of
shapes, and "corner" remembered against the kind hands a corner to a piece that
has no such row.

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

A panel section again (`upgradeRows`), tabbed by `UPGRADE_GROUPS`, and the row
itself is the button. It has worn three shapes and each one fixed the last one's
complaint while introducing its own, which is worth having written down:

| Shape | Fixed | Broke |
|---|---|---|
| rows → a card per upgrade | you could read what one did | two presses to buy, and the card said what the row said |
| bar tiles → the same card | the list stopped costing a panel | — |
| bar tiles, no card | one press buys, one press sells back | a 76px tile cannot hold a name, so titles clipped and *what it does* was hover-only |
| **rows again, the row buys** | the caption says what it does; comparing two is possible | — |

**The tooltip was the actual bug, not the tile.** A tooltip shows one thing at a
time by construction, so a catalogue explained by hovering is one you can only
read serially and never *compare* — and comparing is the entire activity here.
A 214px row has a caption line, which is all it needed.

**What it does is read off `payload`, never off the prose** (`upgradeWhat`). A
row edited over MCP to 30% off says 30% without anybody rewriting its
description. This is the one part of the deleted card that was doing work, which
is why it is the one part that survived it.

**The row buys, and sells back if it is already yours.** `run` sends
`buy-upgrade` or `sell-upgrade`; the price under the icon is what it costs, or
what pressing hands back. There *was* a confirmation card, on the argument that
one press is the wrong ceremony for a permanent, unrefundable $20,000. Both
halves went: `sellUpgrade` gives half back at `FIXTURE_REFUND`, so it is not
irreversible, and the way back is a better second chance than a dialog because
it survives you having already pressed the thing.

**A press that could only be refused is not offered.** No `run` at all when a
rung below is missing (`dim` — cannot), when you cannot afford it (`soft` — can,
but not yet), or when something you own stands on it. The caption says which.
`sellUpgrade` refuses the same cases server-side; the row saying so first is
what stops the list advertising presses the shop will turn down.

Three kinds never sell, and each is a different way of not being a flag: `space`
bought land the building has since grown onto, `staff` is the record an old
save's people were migrated from, and `station` is the *price* of a machine that
sells back where it stands.

**The panel holds the height of its tallest tab** (`steady` on the section,
`steadyHeight` in `ui.js`). Seven fixture upgrades against two for you is a
window that doubles on one press — and on a panel anchored at the bottom the
strip itself is what moves furthest, so the tab you wanted next is no longer
under the cursor. Opt-in per section, because the Menu is the counter-example: a
rule for every tabbed menu would hold its four sound switches at the height of
its thirty-row keyboard reference. The pitch is measured off two rendered rows
rather than written down — the CSS owns row height, and a copy of that number
here is a panel that is right until somebody restyles a row.

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

Bound from `RAIL_ITEMS` in `main.js`, so a new menu is bound and labelled the
moment it exists — including the ones that are a bar rather than a panel.

| Key | Does |
|---|---|
| `B` `U` `T` `M` `/` | toggle Supplier · Upgrades · Shop · Milestones · Menu |
| `H` | the roster along the bottom — a bar, not a panel (`STAFF_BAR`, which is not a section at all) |
| `G` | build mode on and off — the rail's Build button presses this |
| `1`–`9` | the open tab of whichever bar is up, seeds when neither is |
| `Tab` | next tab of the bar that is up, sub-tabs counting as their own stops (`shift` for back). Prevented hard, or focus lands in the search box |
| `R` | turn what you're placing |
| `O` | raise or drop the shutters — the same press as the panel's left edge |
| `P` | stop or start the clock — the same press as the clock itself |
| hold `E` / `Space` | use what you're stood by |
| hold `Q` | seed wheel |
| hold `Shift` | with the build bar up, the bulldozer: whatever is under the pointer goes red and a click gets rid of it, whatever tool is armed. With it down, the multi-select |
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

| the press | on the floor | on a thing | on a thing, building |
|---|---|---|---|
| moved | pan the camera | pan the camera | **move it, if it is selected** — else pan |
| still, released | go there | open it | open it, or close its menu |
| still, held | — | — | **pick it up** |

Outside build mode the hold is wired and drawn — the aim ring winds in while you
keep pressing — but does nothing (`HOLD_OPENS` in `main.js`). Opening moved back
onto the tap, which leaves the hold with no job the tap does not already do
sooner. It is a flag rather than a deletion because what a *tap* should mean has
now changed three times, and the server still resolves a fixture's working spot
(`walkToFixture`, covered by `verify:walk`) even though nothing currently asks
it to.

**With the palette up, a press that SETTLES on a thing and then pulls is a
move** — `drag.lift`, armed on the way down and spent at the slop line, where a
pan would otherwise have committed. Press the lamp, let the press settle, pull it
over, let go, and it lands where you let go of it. It is the same errand the
fixture menu's Move button starts — `startMove`, then `build-lift`, so build mode
is held open across the carry — reached by aiming instead of by reading. Moving
something used to cost three presses, two of them ceremony around a decision you
had already made by pointing at it.

**The dwell is what makes that a trade rather than a tax.** It shipped with no
gate at all, and a drag is also the gesture you make to look round the shop:
build mode is wall to wall with things you own, so a press that started anywhere
near a shelf pulled the shelf out instead of turning the view — which reads as
the camera being broken rather than as a move nobody asked for. The gate was the
*selection* for a while — tap it to name it, then drag it — and that is a second
press charged on every deliberate move to prevent an accidental one, which is the
wrong end of the trade. `MOVE_DWELL_MS` (210, half the hold) is the same
distinction drawn where it actually lies: a drag that means "look round" starts
moving immediately, and one that means "take this" starts with you stopping on
the thing. The accident is a sweep, and a sweep has no pause in it.

Two things fall out of that figure. It has to stay well under `LONG_PRESS_MS`,
or the dwell and the **hold** — which lifts the unit into your hands and leaves
it there — become one gesture with two outcomes a millisecond apart. And it needs
no marker of its own: the press is already drawing a ring (`setHoldProgress`,
against the hold), so the dwell is the first half of something you can watch
fill. The arming still does *not* ask — `drag.lift` is set on any fixture and the
slop line is where the question is put — and the hold is left alone there too,
since it cannot fire mid-turn. The pill names the whole gesture (`hold-drag`)
rather than its second half, or a row promising a drag over a unit that turns the
shop is the green-ghost bug wearing words.

The camera never sees a drag that *did* lift, and `drag.moving` has to hold the
verdict for the *rest* of it: `lift` is spent as it fires, so without the second
guard the first move pulls the lamp out and every move after it turns the shop
underneath — which is the bug the branch exists to fix, arriving one event later.

`drag.carried` is that same claim about the press that lifted by **holding**, and
it is the one that actually bit: the hold fires at 420ms with the button still
down and the fixture now in your hands, so the rest of that gesture went straight
to the camera — you tilted the shop while carrying a lamp, under a ghost that had
also stopped tracking (`camBusy` reads the same pair). It is deliberately not
`moving`, which means "pulled out by a drag, so letting go lands it": a held lift
leaves the thing in your hands for a separate tap, and that contract is the whole
difference between the two ways in.
**A left drag in build mode SLIDES the view rather than turning it**, whatever
the device — the keys already made that argument (`flying`) and only ever made it
to a keyboard. Building is reaching for somewhere you cannot stand, so getting
there is what the camera is for in the mode, and turning is the rarer of the two;
the right drag and `,`/`.` still turn, which is the escape hatch. **A left drag
that dwelt first therefore moves the thing and does not slide the
view**; the right drag and `,`/`.` still do, which is the escape hatch and the
reason this is a trade rather than a loss.

The hold does the same lift for a press that never moved (the gesture a finger
makes), and leaves the thing carried for a tap instead of dropping it: you have
not pointed anywhere else yet, so there is nowhere to put it but where it already
was. Either way the drop needs nothing from `ui.holding` — messages arrive in
order, so the server has processed the lift by the time the drop is read, and
`dropFixture` reads the kind, piece, tier and variant off what it knows you are
carrying. `dropCarried` sends **no `rot`** on that path: `buildRot` is still the
palette's angle until the snapshot replaces it with the fixture's own, so sending
it on a fast flick is "moving it reset its rotation" as a race condition.

**Whatever it lands on stays SELECTED** (`endMove`), and that is a different
claim from the menu: the lift re-mints the placement, so a selection cannot
simply survive — the id it held stops existing the moment the fixture does — and
what that reads as is the shop letting go of the thing the instant you finish
moving it. R turns nothing, the pill drops back to "Select it", and lining a lamp
up costs a re-select between every nudge.

A pointed move does **not** reopen the menu afterwards (`startMove`'s `reopen`).
An errand returns you where you started, and here you started by pointing —
rearranging four lamps in a row would otherwise leave a panel open on each in
turn, and the shop then always has something selected with nothing you pressed to
explain why.

The bulldozer keeps the pointer to itself throughout: with it up you are aiming
at things to destroy them, and a press that handed you the shelf instead would be
the one gesture in the mode that does the opposite of what the tool says.

### An empty hand is a state

`ui.toolOff`. Build mode used to mean "a shelf is in your hand", because
`buildTool` has a default and there was no way to put it down — so every tap on
bare ground bought something, and *looking* at your own shop with the bar up was
a mode you could not be in. That is what made rearranging things frightening: the
gesture for moving a lamp and the gesture for buying a shelf were the same press
a few pixels apart.

The mode opens with nothing armed, and there are three ways back to nothing:
press the lit button again, right-click, or Escape. On the ladder it is one rung
**below** everything that is on screen and **above** the mode itself — so the
first press empties your hand and the second shuts the bar, which is what makes
backing out of a mis-armed shelf cost one press rather than a mode you then have
to turn back on.

It is deliberately **not** the same question as `paletteArmed`, and that split is
the whole of why an empty hand works: `paletteArmed` stays true, so a decoration
is still pointable (`aimable`) and still draggable. One flag says "pointing at
the world builds", the other says "the mode is up" — they were one flag, which is
exactly why there was no such thing as putting the shelf down. Everything that
asks what a tap would do reads `toolId()`, which answers `null`, so the wall
tool, the brush, the bulldozer and the lit button on the bar all empty out
together; `ghostKindForTool` is the one reader that needs it spelled out, because
a ghost wants the kind and `toolId` is a piece.

The server is never told. It owns `build.tool` because it disarms Clear after a
removal and it has no concept of *nothing*, so `syncBuildTool` goes on adopting
whatever kind it names and this sits in front of the answer rather than fighting
it.

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

**Goods waiting on somebody outrank the menu, and they do it at both ends.** A
thing opens, except where the answer to pointing at it is plainly *go and get
that*. Holding an armful and pointing at a shelf was always the first half of
that; a bed with fruit on it and a machine with a full tray are the same case
with the goods at the other end, and they were not. What that split actually
produced was one gesture with two meanings picked by which side the stock
happened to be sitting on — and standing there looking at tomatoes, the question
is never the thing you want. `readyToTake` in `main.js` is the test: it reads
`ready` and `output` off the snapshot, the same two fields the renderer draws
the fruit and the thought bubble from, so the tap cannot disagree with the
picture it is aimed at.

Shelves stay out of it as *units*, and their goods do not. Stock is merchandise
rather than something waiting to be collected, and one board of one shelf is a
choice that has to be named — which for four steps meant that naming it was the
shelf menu's job and the tap on a shelf stayed a question. The pointer can name a
board now (see *Picking things up is asked for*), so the split runs through the
unit rather than around it: a tap on a **pile** goes and gets that pile, and a tap
on the **unit** — any pixel of it that is not stock — still opens it, which is
what keeps pricing, assignment and priority one press away instead of behind a
gesture that does nothing. The rule does cost a ripe bed its menu for as long as it is ripe, since
there is no second gesture to move it to: build mode is the way back in, and
`sow` refuses a ripe bed regardless, so what ends up behind the mode is move,
sell and restyle — the three things you do to a bed you are not farming.

**…and "build mode is the way back in" was a promise the branch did not keep**,
which only became visible once the mode's own tap started carrying the move. The
test read the snapshot and nothing else, so a machine with a full tray took the
tap *while you were building*: pointing at an appliance sent `station-one`, and
`notWhileBuilding` answers that **out loud** — "Exit build mode first", on the one
press you make to select the thing you were trying to move. There is no reading of
that except the shop refusing to let you build with your own machine, and the way
out was to leave the mode you had just turned on. `readyToTake` is asked with
`boardTakes()` now, which is the predicate the pile branch below it already makes
and the same sentence said one fixture up: **a tap that moves goods is not a
thing this mode has, and selecting a unit is most of what it is.** The stopped
clock rides along for the reason that predicate's own note gives — a walk in a
paused shop is a press with no second half — and its two clauses about your hands
are spent upstream, where an armed tool and a carried fixture skip the ladder
entirely.

Steering always outranks a route: `stepPlayers` drops `p.path` on the first
frame of key input rather than blending the two, because a key that only slowed
a route down reads as the game ignoring you.

### Stopping is the consent

An action charges only while you are **stopped** — `stepActions` drops the
charge outright for anyone `moving` (a route with legs left, or a direction
held), exactly as if you had walked out of reach, because from the action's
point of view you have.

`ACTION_TIME` was supposed to cover this on its own: a second of charge against
roughly three quarters of a second to cross a `REACH` at `PLAYER_SPEED`, so a
walk-past could never close. That arithmetic describes one straight line through
the middle of the circle at full tilt. Clip its edge, turn inside it, slow at a
corner, or walk the *length* of an aisle of shelves, and you are in range of
something for as long as you like — so goods went into the hands of people on
their way somewhere else, and full hands then refuse you everything until you
reach the drop-off.

It costs nothing anybody wanted, which is the test of a rule like this: every
route ends stopped at the working spot the tap was aiming at, so "tap it and it
happens" is untouched, and an errand still fires the moment you arrive. What
goes away is the only class of action in the game that happened *to* you.

`moving` is one function both movers read (`stepPlayers` asks it too), because a
second opinion about whether somebody is walking is a charge that fires on a
frame the legs disagree about. `verify:walk` holds the claim at 2% throttle —
crawling over a bed for four seconds, never leaving its reach and never stopping
— because the interesting case is not the one the arithmetic already covered.

It also put a state no player can be in inside the sweeps: `verify-build`
teleports to a working spot, and `take` plans a route, so `stand` now clears the
path and the keys as well as the position. Teleporting *is* arriving.

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

So there are three ways to say which, and one verb behind all of them:

| you point at | you press | it sends |
|---|---|---|
| a crate in the yard | the crate itself | `take { palletId }` |
| one pile of goods on a shelf or freezer | the pile itself | `take { shelfId, itemId }` |
| one board of a shelf or freezer | its Take button, beside the count | `take { shelfId, itemId }` |

**A crate on its own and a crate in a pile are two different things**, and only
one of them has contents you can reach. Alone: tap for one unit, hold for the
whole box, right-click to put one back. In a pile: whole boxes only
(`crateStacked`). *Which* box is still yours to choose — `pickPallet` picks them
apart by height and the ring marks the one the ray met, and `liftCrate` no longer
refuses a buried one, because the boxes above it just settle a step and the crate
you pointed at was the only crate you meant. What a pile takes away is the tin at
a time: a buried crate shows a band of about a dozen pixels, so a rummage up
there was always somebody else's tin.

This replaced a list. The pile used to open as a menu — a row per crate, "on top"
/ "under 2", pick one and walk — and it was answering, at length, a question the
pointer answers by itself; worse, the tap *underneath* the menu was still the
rummage, so pressing a tower of boxes you were standing at took one tin out of
it. Deleted rather than reworked: the aim was always the better instrument, it
only needed the rummage to get out of its way.

**The middle row came last, and it is the one that made the other two agree.**
A crate has been pointable since crates existed; a board was reachable only
through a list, so getting an armful off a shelf was four inputs — open the unit,
find the row, walk, press and hold — three of which were ceremony around a
decision already made by looking at the shelf. What was actually missing was not a
verb but an *address*: `pickFixtureHit` answered "which fixture", and a fixture id
cannot say which of three piles standing on it you meant.

It says both now. `syncShelves` already builds one welded group per kind — that is
how a unit draws three things on its own boards — so each group carries the item
id it is drawing, and the walk up to the pickable group notes it on the way past.
The pile is the target the ray actually hit, which is what makes the marker
honest: a cage measured off those same meshes (`boardBox`), not a frame on the
tile, because a frame under the unit is the same frame for every pile on it and
the question here is *which pile*.

Everything else about the gesture is the crate's, deliberately. The press names it
on the way **down**, which is what makes a board you are already standing at one
continuous gesture — press the bread, keep holding, the ring winds on the cage and
the armful lands. Named on release, the errand would arm the charge under a button
that had just come up, so the press would appear to do nothing until you pressed
again. The release then sends the same thing once more, which matters only for a
board across the shop and costs nothing to repeat.

**In reach only, on the press** — which a crate does not have to ask and a shelf
does. A crate is a small thing standing in a yard; a shelf is most of a wall, and
a mouse turns the view by dragging, so naming a board across the shop on the way
down means every camera drag that happened to start on shelving sends you walking
to it. Naming early buys nothing at that distance anyway: the ring cannot wind
until you arrive, and by then the button is long since up. The release still names
a board you have to walk to.

`boardTakes` in `main.js` is the list of states where pointing at a pile means
something else: the palette is up (a tap places, and a tap on a unit opens it),
the bulldozer is armed (you are aiming at things to destroy them), you are
carrying a fixture, or your hands are full of stock — where a shelf is somewhere
to PUT things, and the unit wins the whole gesture rather than a corner of it
deciding. Hover, press and tap all ask that one function, or the highlight would
advertise something the press then did differently.

The Take row stays, and not as a duplicate: the row is also the count, the price
and the order button, and it is the only way to reach a board with **nothing drawn
on it** — a unit reserved for carrots that is waiting on the van is a row with an
empty board behind it, and there is no pile there to point at. Taking is the one
thing on that row the pointer now does better, because a pile of goods is a
picture of the thing you meant.

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

### Putting them down is asked for too

The mirror of the table above, and for four steps it had one row fewer than it
should have. `stow` was the only way to let go of an armful and it insisted on
the drop-off, so picking anything up was a *commitment*: your hands stayed full
until you had walked them across the shop, and there was no such thing as
changing your mind halfway down an aisle.

| you are holding | you point at | it becomes |
|---|---|---|
| an armful | a shelf that will take it | `stock` |
| an armful | the drop-off | `stow` — crates fill the cells you painted |
| an armful | any bare tile | `dropCarry` — a crate on that tile |
| a crate | any bare tile | `dropCrate` — same crate, back on the floor |

...and the *pointing* is `placeAt` for the last two: hold a square in reach and it
lands there. Tapping that same square still walks you to it.

The last two are one errand (`{ at: 'ground', x, z }`) and differ only in which
pair of hands they empty and how long the ring takes. Nothing about six loaves
needed painted ground: `dropGoods` has always been able to stand a crate on any
tile — it is what a stripped shelf and an emptied hopper do — and a pallet is the
only "goods on the floor" object there is, so the thing you put down is
immediately something a stocker will come and tidy.

**The pad still wins when you name a tile on it**, which is the opposite priority
to a hauled crate and deliberate: `stow` hands `dropGoods` the pad as a *region*,
so crates spread across the cells you painted, where a tile drop knows only its
own tile. On the pad the tidier answer is available; everywhere else there was no
answer at all.

`dropCarry` is its own verb rather than a branch inside `dropCrate`, for the same
reason `haul` is its own field rather than a flag on `carry`: everything that
accounts for hands has to go on asking about hands, and one function reading the
wrong one of the two is a conservation hole — the goods on the floor *and* still
in your arms — rather than a bug anybody can see.

**A square is two sentences, and the gesture picks which.** "Over there" and
"down there" are both true of the tile beside you while your hands are full, and
this took two goes to get right. Routing first cost the aim: `walk-to` ends *on*
the tile you named, so the crate went down under your feet however carefully you
had pointed at the square next to you. Refusing to route inside `UNLOAD_REACH`
fixed the aim and cost you the step — with full hands, no nearby tile was
somewhere to stand any more, so you could not move a single square holding a box.

So they are split by gesture, which is the split the whole shop floor already runs
on: **a tap goes, a hold does**. `walkTo` is untouched and still walks you
anywhere. `placeAt` is the new verb — it names a square as somewhere to put things
*without going to it*, refuses out of reach rather than quietly widening, and turns
you to face the square. The press arms it, so the ring winds on the square you are
pointing at; the release, if it comes early, is an ordinary tap and you walk.

That choice is real and would be invisible, so it is drawn: `canDropAt` +
`setFloorGhost` paint the square under the pointer green, or red if it will not
take a crate. Both clauses are the server's own tests through the shared
functions — `isWalkableTile` (the grid `isWalkable` reads) and `edgeBetween` for
the wall on the line a tile test cannot see — because a green square the server
refuses is worse than no square. A square that already holds a crate stays green:
`dropGoods` tops up a box of the same thing and stacks anything else, and a pile
is a thing you can peel.

**Both ends of it are named on the press, in reach.** A hold with nothing armed
is a dead gesture: the ring has nothing to wind, so pressing the square you want
the box on would do nothing until you had tapped it once and pressed again.
So a press on a tile you can already reach sends the nought-step `walk-to` that
names it (`Game.walkTo` reads your hands and writes the errand), and the hold
that follows spends it — one continuous gesture, the same shape a crate has had
since the press started naming crates on the way down. Reach is the gate for
both, because a mouse turns the view by dragging and a drag that started on the
floor across the shop would be a walk nobody asked for.

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

## The corner readouts

Two things in the top-left that are not menus and never will be: how the money
is going, and what the town wants. Both are pure functions of the snapshot in
`client/hud-meters.js`, both diffed on a signature before they touch the DOM.

### Cashflow — a balance is not a rate

Cash on hand was the only money on screen, and it cannot answer "how am I
doing". You can watch it climb all week while every individual day loses money
against the wages, because the climb is a loan, a good Saturday or the till you
finally cashed up. Three parts, in the order the questions get asked:

| Part | Says | Read from |
|---|---|---|
| today's net, signed | am I making money right now | `state.stats` |
| an arrow | is that better than yesterday | last row of `state.ledger` |
| a 7-bar sparkline | what has the week looked like | all of `state.ledger` |

Three details are load-bearing:

- **The arrow only exists when there is a yesterday.** Day one has nothing to
  compare against, and defaulting to zero would make the first day of every shop
  a triumph. Same reason the Shop report's `vs yesterday` row is absent rather
  than zero.
- **The sparkline is finished days only.** Today is a part-day, and standing a
  half-written bar beside seven whole ones reads as a slump every single
  morning. Today is the *number*; the shape is the days that are done.
- **The arrow is coloured separately from the number.** They answer different
  questions and can disagree — a day that is better than yesterday can still be
  a loss, and one colour for both would say the day went well.

`world.ledger` is a **saved** field, capped at 30 days, and the snapshot sends
the last 7. It has to be saved because profit per day is not recoverable from
anything else once money has moved: a cash balance is a running total, and
`_lastDayStats` was one day deep and never on the wire. It is written in
`onNewDay` *before* `persist()`, after `payWages` — the last thing that touches
the day's money — because filing it the other side of the save loses the day you
just finished on a restart.

### The demand meter — an RCI, and why the old one wasn't

`#rci` is twelve departments, in `DEPARTMENTS` order, on screen whether or not
anything is happening. It replaced a panel that looked almost identical and was
a different thing entirely: `state.modifiers`, the active **world events** folded
per tag.

That is worth spelling out, because the two are easy to confuse and the old one
read as broken without ever being wrong:

- **Its rows moved.** They were whichever tags the director had written about, so
  they appeared and expired under you. You cannot learn to read a panel whose
  rows move — the only shape it ever had was "some things are happening".
- **It mixed dimensions.** `PANTRY` next to `CLASSIC` next to `DAIRY` next to
  `TRENDY` — departments and moods on one axis, and "how much trendy have you
  got" is not a question a shop floor can answer.
- **It vanished.** No active events meant no rows, and `#rci:empty` hides the
  panel. The readout was absent exactly when the shop was calm enough to plan.
- **Nothing in it was measured against your shop.** It said what the world
  wanted. It never said whether you were doing anything about it.

Now each row is one signed number and the sign is the instruction. Right: they
asked and you were short. Left: this space is not earning. `state.modifiers`
stays on the wire untouched — the supplier's heat pills and the to-do chips read
it, and it is still the right shape for "what is the world doing today".

**The two halves read two different tallies, and that is the whole correctness
story.** Both were asks in the first cut, which pinned any department nobody
names directly at full negative forever — `frozen` and `prepared` are in no
archetype's affinities, so a frozen pizza only ever leaves the shop by answering
a `cheap` or a `kids` line. A shop selling nine frozen lines a day was told to
tear its freezers out. The left half is sales now (`stats.moved`, tallied at the
till), because sales are observable for every department whether or not anyone
can name it.

**Boards, not units, and only boards with stock on them.** A full shelf of tins
is a shop doing its job; measuring stock in units read forty tins against six
sales and called a well-kept aisle an overstock. What can be wrong is the
*allocation*. And counting **empty labelled** boards inverted it outright — a
bare shelf keeps its label on purpose, so a department people ask for and you
have run out of reported as *overstocked*, which is the opposite instruction.
Bare shelves are the to-do chip's job.

**A department with nothing to say draws no bar.** Twelve rows are always up and
most are level most of the time; a 1px stub on every row makes the meter always
look like it is reporting something, and the eye has to measure twelve lengths
to discover eleven mean nothing. Bare axis means nothing to do here.

**The client owns the row set.** `rciHtml` maps over its own `DEPARTMENTS`
import rather than over what arrived, so a snapshot can only ever change the
*lengths* — there is no message the server can send that reorders the meter or
drops a row out of it. Given the complaint that retired the old panel was that
its rows moved, that is worth a line of code.

The smoothing is server-side (`Game.demandNow`, `rollDemand`): a running average
of finished days plus today so far, on both sides. It exists so the meter reads
correctly at 08:00 rather than being blank at opening and built on four shoppers
by 09:00 — the same shuffling, one layer down. The numbers are therefore an
index and not a count of shoppers, which is why only `net`, `fill`, `boards` and
`event` go on the wire and nothing hands the HUD a figure that looks like a
count and isn't.

### Putting one away

The meter and the radio could be *moved* long before they could be closed
(`client/panel-drag.js`), and moving was never the answer to not wanting one:
every place in this HUD you can drag something to is over something. Both carry
a ✕ now, and both come back from a row in the Menu — `client/corner.js`.

Four things it is worth knowing before wiring a third one:

**The way back may not be on the thing you closed.** The Menu's rows are
generated from `CORNERS`, so anything wired with `wireCorner` is listed the day
it exists. A widget that could be closed and was missing from that list would be
one nobody can bring back, and that is a bug a player finds before you do.

**The ✕ is built in JS, not authored in the markup.** `ui.update` rewrites the
demand meter from `innerHTML` ten times a second, so anything sharing that
element with the bars lives about a tenth of a second. The rows moved into
`#rci-rows` and the button is a child of the panel — which is also why
`#rci:empty` became `#rci:has(> #rci-rows:empty)`, or an unfurnished shop draws
an empty card with a ✕ on it.

**It is its own store, not a flag in `sns-panel-pos`.** Double-clicking a widget
deletes its entry there to hand the position back, and a shared map would make
that gesture also un-hide it — one press quietly doing two things, only one of
which you can see, since a widget you closed is not on screen to watch come
back.

**Closing says where it went.** A thing that vanishes with no explanation reads
as broken, and the ✕ is 17px on a hover. The toast names the Menu.

### The clock — a readout that became a control

The hour was only ever something to read, because opening was only ever
something that happened to you: `isOpen()` was `08:00 ≤ hour < 20:00` and
nothing else. A struck-through clock said what had happened and never that
anything could be done about it.

Both switches live on it now — or rather, on the panel it sits in — because
both are decisions you make while looking at the hour. **The clock is the
play/pause** and **the panel's left edge is the shutters**. What matters is
which value each half reads, and they are **not the same value**:

| Reads | Is | Because |
|---|---|---|
| the clock's strike-through | `state.isOpen` — the shutters **and** the hours | whether anybody is actually being served |
| the panel's left edge | `state.shutters` — your switch alone | at 22:00 with the shutters up there is nothing for you to do about the hour, so the edge stays lit while the clock is struck through. Reading one value for both would put the open sign out every night, on a shop you had not closed |
| the to-do chip | `state.shutters` | same reason, louder: read `isOpen` and it nags every single night about four in the morning |

**The Menu holds the pause while it is open**, which is the one thing that moves
the clock without anybody pressing it (`holdForMenu`, `client/ui.js`). It is the
only panel that does, and the line is what a panel is *about*: the Menu is the
one you open to do something to the **game** — leave it, switch the tour off,
look a key up — and all of those are things you do while not playing. The
supplier, the roster and a shelf menu are things you do while trading, and a shop
that froze whenever you ordered stock would be a different game.

Three things it rests on. It only hands the clock back **if it took it** — the
Menu opened over a stopped shop leaves it stopped, which is the same
`restore` bookkeeping the milestone card already keeps (`client/award.js`), and
for the same reason: a hold is a record of your own press, never a copy of the
state. It goes through the ordinary `pause` message with a `quiet` flag, so it
is the same stop the P key sends — struck-through clock, blinking edge, the
renderer told — with no line in the feed, because two of those per menu open is
a feed people stop reading. And `leaveToMenu` releases it *before* the reload:
that is the one way out of the Menu that never closes it, and a pause is a
persisted stamp, so the shop would still be stopped when you came back.

⚠️ Pause is **shop-wide**, so a guest in their Menu stops the host's shop. That
is a consequence of there being one clock rather than of the hold — a Menu with
a stop of its own would be a second kind of stopped world on the wire.

The switch can only ever take hours **away** — `isOpen()` is `open && trading()`
— so it shuts you early rather than trading late. A switch that extended the day
would make "never close" simply correct, and a button whose right answer is
always the same is not a decision.

**They were word buttons, then square icons, then round pips, and the whole
run was the wrong shape.** `Open up` and `Close up` are different lengths, so
the panel changed width every time the shop did and everything to the right of
it slid; two labels came to ~110px in a readout that is otherwise five numbers;
square icon buttons read as a settings toolbar, which is the wrong genre for a
HUD you play through; and the 18px pips that fixed all of that still cost ~45px
of a row whose whole job is five figures you glance at.

What made them removable is that **neither pip was ever carrying the state**. A
struck-through clock already said SHUT, an accent-coloured blink already said
HELD, and #hq puts up a hot chip naming the key the moment the shutters go down.
So the pair of *controls* went and the pair of *states* did not: each element
wears the state it was already wearing, and pressing the thing wearing it is the
way out of it. The verb — the one half a glyph never told anybody either — is in
`title`, exactly where it was.

Which flips the old rule. The pips showed what pressing them would **do**, the
way every play/pause control does, because the state was said beside them. These
show what is **true**, because a coloured stripe with no glyph on it cannot mean
"shut" and "shutting" at once — and it is only allowed to be this quiet because
being shut is already shouted twice.

The edge is `#shutter`, a button that is 13px of reach around 5px of paint, bled
into padding `#stats` was already spending: it costs the row no width worth the
name and is a *bigger* target than the pip it replaces, because it is as tall as
the panel. Lit (`--good`) while trading, dull ink at 17% while shut. Its left
margin stops 3px short of the card, or the stripe pokes out through the 11px
corner radius. An open sign belongs on the door rather than in a toolbar, which
is the whole of why it reads.

**…and then the stripe became a plaque, and the plaque became the edge itself.**
The intermediate step is the instructive one: a 15px coloured card with OPEN
painted up it, sitting in a 34px column, inset from the panel by the panel's own
padding. That is a box inside a box with 5px of cream between them, which reads
as a badge dropped onto the readout rather than as part of it — and the strip of
card either side of it belonged to nothing, so the button looked small *and* the
gap looked like a mistake. The sign is now the card's left edge: full bleed
through the padding on three sides, `overflow: hidden` on `#stats` clipping it to
the panel's own 11px radius, and the word painted straight onto it.

Three things it rests on. **The clip is the only honest way to round a child
against a parent's corner** — a matching radius on the child is the same number
written twice, and the day one moves the other is a sliver of panel showing
through. **The colour is the strip**, so the state (`--good` / `#a8442f`), the
hover and the ask all had to move off the word and onto the button: a
translucent wash over a coloured edge is a second colour mixed into the one thing
on the card whose colour *is* the state, which is why the press and the pulse are
`brightness()` rather than a tint. And **the card had to be given its height
back**. `#doorway` was a fixed 48px, so for years the tallest thing in the row
was a piece of lettering and the panel was 58px because of it; a strip sized *by*
the card sets nothing, so without a `min-height` on `#stats` the whole HUD would
have quietly shrunk by 16px as a side effect of restyling a button. The 640px bar
drops that floor, because a bar across the top of a phone genuinely should be as
tall as its readouts — which is the same argument that branch has always made,
finally said in the place that decides it.

The one thing the clip costs is the focus ring: an outline is drawn *outside* the
border box, so on a child meeting three clipped edges it loses three of its
sides. `outline-offset: -4px` draws it inside the strip instead.

**The date is a caption over the balance, not a column beside it.** Day and
season were their own two-line cell, wedged between the balance and the rate —
a stack of small type holding apart the two numbers you actually watch, for
about 60px of a row whose whole job is five figures at a glance. Over the money
it is the same two lines in the same panel height, one column fewer, and the
order a game HUD usually reads in: what day it is, then what you have. It goes
with the money rather than with the clock because a balance is a thing measured
over days and seasons — the date is its unit, where the clock is the hour, the
one readout up here that is not about the ledger. Splitting the pair (season by
the time, day by the cash) would break one date across two cells.

**…and the date says which day of the week it is, because a season is one.**
`Day 62` is a stopwatch: it tells you how long you have been at it and nothing
about where you are in the week — which is the unit everything else in the shop
is measured in, since the Shop report's week and the reputation drawn across it
both run seven days. The answer was already in the day number and nothing could
read it: `onNewDay` rolled the season on `floor((day - 1) / 7)` as an expression
of its own, so the fact that **a season IS a week** was asserted in one line and
knowable nowhere. `SEASON_DAYS`, `seasonFor` and `weekdayLabel` in
`shared/clock.js` are that expression given a name and one home, and the sim now
rolls its season through the same function the HUD prints its weekday from. Two
copies of the 7 would be a calendar whose Monday quietly stopped being the first
day of spring, with nothing anywhere to say so.

The weekday is **derived, never stored** — no field on the wire, none on the
save — which is what keeps day 1 a Monday and every season starting on one, so
the weekday and the day-of-season are the same number by construction rather
than by agreement. A year is four seasons, 28 days. The count stays beside it
(`Sat · Day 62`), because the ledger, the milestones and every line in the feed
speak in day numbers, and a HUD that stopped printing one would leave them
naming something no longer on screen.

**The play/pause glyph goes after the hour**, which is about the row rather than
the button: the hour is a figure in a column of figures, and a glyph in front of
it indents the time by its own width, so the number stops lining up with the
date above it and the takings below. Reading order agrees — the time, then what
is being done to it.

**`#flow`'s width floor and `SPARK_W` have to be the same number.** A floor of
70 over a 38px sparkline is 32px of empty, left-aligned column, so all of it
pooled on the right — and what that looks like is the clock adrift, half a panel
from the readout it is nearest. Neither value was wrong; they had simply never
been told about each other. Matched at 56, the widget *is* the floor and there
is no slack for a gap to be made of.

The whole of `#stats` came down about a fifth at the same time, and everything in
it scales together — type, gauge bars, `SPARK_W`/`SPARK_H` in `hud-meters.js`,
padding. A panel where only some of it shrank reads as a panel with a mistake in
it, and the sparkline is the one to watch: left alone it becomes the biggest
thing in the readout, which is the wrong way round for the least urgent number
in it.

Which exposed the older version of the same fault: **nothing in `#stats` may
move sideways**, and three cells in it were free to. Every one holds a number
that changes while you watch it, in one flex row, so a digit a pixel wider than
the last slides the clock, the buttons and the gauges with it. It needs both
halves — `font-variant-numeric: tabular-nums` for the per-tick jitter (a `4` is
not a `0`), and a `min-width` for the jolt when the *digit count* changes going
past $10,000 or Day 100. A floor that today's value already exceeds does
nothing, so they are sized to what a shop plausibly reaches.

Both messages send the state they want rather than `toggle`, and `ui.shopOpen` /
`ui.paused` are mirrors of the server's answer — this is a shop two people
share, so a toggle can be pressed from two places at once and land as nothing.

## Badges

The display half of the rail — what a menu would tell you if you opened it.

| Section | Badge |
|---|---|
| Build | `●` while you're carrying a fixture |
| Supplier | shelves empty or under a fifth of a stack |
| Staff | how many are on shift |
| Upgrades | how many you can afford and don't own |
| Shop | `▲`/`▼` on today's profit **against yesterday's** |

`Rail.update()` runs every snapshot but only writes to the DOM when the text
changes. Ten DOM writes a second for a dot nobody is looking at is how a 60fps
canvas starts stuttering.

The Shop report is today's numbers out of `state.stats`, and now the finished
days behind them out of `state.ledger`. It used to be today's only — the server
kept yesterday in `_lastDayStats` and never sent it — so every readout in the
game compared today against **zero**, which cannot answer "am I doing better or
worse". `world.ledger` is the fix and it is a saved field, not a derived one:
profit per day is not recoverable from a cash balance once anything has been
spent out of it.

### The delivery ring

The one badge that is not a number. An order is a promise rather than a
teleport, so the supplier button traces its own outline with an arc that fills
as the van covers its journey — amber on the road, green and pulsing once it is
pulling in — with the units on order in the opposite corner, in the ring's
colour. Two channels rather than two numbers in one slot: the red badge is a
problem you can act on, the ring is a wait you can only plan around, and they
are most interesting at exactly the same moment.

It needs **two** numbers from the server and has both since this shipped:
`in` (seconds left) and `wait` (the whole journey). `in` alone cannot draw it —
the runs are an hour apart round the clock but an order joins whichever one is
next, so "five minutes to go" is nearly there for somebody who ordered on the
hour and half way for somebody who ordered at ten to. `wait` is stored on the
order rather than derived, for the same reason
`runHour` is: `arrivesAt` is rewritten on every load, so the only surviving
record of how far you have come is the distance you set out to cover.

The arc is diffed on its *rounded* percent, not on `in` — which is the one field
the supplier's `live` signature deliberately leaves out because it moves every
tick. A percent moves a hundred times over the whole journey and the CSS
transition covers each step, so smooth motion costs about one DOM write a
minute rather than ten a second for six hours.

## Tooltips

`client/tip.js`. One fixed element on the body, moved to whatever is hovered —
not an `::after` per element, which the rail alone would have made eight of, the
build bar forty, every one of them a child of something with `overflow` on it.
Listeners are delegated on the document, because the rail and every menu rebuild
themselves out of `innerHTML` and a bound listener dies with the node.

**A repaint that changes nothing is not free** (`setHtml`, `client/paint.js`).
Every live surface here is rebuilt from `innerHTML` behind a signature, and the
signature is one guard too coarse: a fixture menu's carries stock, queues, hands
and cash, so a shopper paying two aisles away rebuilds forty rows that come out
byte for byte the same. The node under the pointer is replaced either way, and
`:hover` is not re-evaluated until the mouse next moves — so the button you are
pointing at drops out of its hover state and comes back, in time with the
snapshot, worst on the surfaces that update most. The panel body, the panel
title and both rows of the bottom bar compare against the last string they wrote
and skip the write. Against the last string **written**, not the element's
current `innerHTML`: `harvest` below moves a `title` onto `data-tip` and removes
the attribute, so the live markup of the one node you are hovering never matches
the string that produced it — which is precisely the node worth leaving alone.

**The card outlives the row it is about.** The delegated listeners were only half
of surviving a repaint. The other half is that the pointer *target* was the
card's identity — so when a panel rebuilt under a still hand, the browser fired
`pointerout` on the node being deleted, the card came down, and the identical row
that replaced it a millisecond later started again from the 110ms delay. A
tooltip blinking in time with the snapshot, on exactly the rows worth hovering,
which are the ones that move. Now a target that vanishes leaves the card
*orphaned* rather than hidden (`orphan`, `ORPHAN_MS`): it keeps its position and
its `show` class, and the rebuilt row claims it by matching **headline** — not
the whole card, because the second line is the live half and requiring it to
match would refuse re-adoption in precisely the case worth keeping a card up
for. Nothing claims it inside 260ms and it goes, so a row that genuinely left
takes its card with it.

Anything can ask for one: `data-tip` (headline), `data-tip-key` (a key cap),
`data-tip-note` (a second line), `data-tip-tone` (`good`/`warn`, which colours
it). **But a plain `title` gets one too** — `harvest` moves it onto those
attributes on first hover and removes the attribute, so the native one never
surfaces underneath. It splits on the house `${name} — ${blurb}` convention, so
most of the game got the two-line treatment without a single call site changing,
and a `title` written tomorrow is drawn in the shop's handwriting without anyone
knowing this module exists. A live `title` always beats what was harvested last
time, or the shop's open and pause buttons would freeze on whatever they said
the first time you pointed at them — which is exactly what the clock and the
shutter edge would do, since a `title` is now the only place either one says
what pressing it does.

Three things are less obvious than they look:

- **Taking `title` away takes an accessible name away.** `harvest` writes
  `aria-label` where there is nothing else naming the thing — and only there,
  since on a button with its own words an `aria-label` overrides rather than
  adds.
- **It flips below when there is no room above**, because the rail is at the
  bottom of the screen and the meters are at the top. Clamping to the viewport
  instead would cover the readout it was sent to explain.
- **The caret is positioned by script, not centred in CSS.** A tip pushed off
  the screen edge slides out from under a caret that stays over its target, and
  the box's `transform-origin` follows the caret — a tip that centres perfectly
  and points at nothing is worse than one sitting off to one side.

Touch is excluded (`pointerType !== 'mouse'`): `pointerover` fires on the tap
that also presses the button, so a finger would get a tooltip explaining the
thing it just did. That is why a label under an icon still beats a tooltip
anywhere it fits — see `.fx-verb .nm` and the build bar's `.tool .nm`.

## Staff

Staff is the **bottom bar** (`H`) and nothing else — there is no staff panel.
Everyone first, then a tab per kind actually hired, each entry a person carrying
what they are doing right now, and **Hire** as the last tab. That makes "who is
on the tills" a glance rather than a menu. Pressing a person opens their own
menu in `#panel`, exactly the way pressing a shelf does — two clerks are two
entries and which one you pressed is the only thing that tells them apart.
Pressing a kind on the Hire tab **hires**: the tile carries the name, the price
and how many you already have, so there is nothing left for a menu to say.

Two rules the entries follow, and both are about a strip you read at a glance:

- **A hire wears their own picture** (`artForWorker`), at their grade and in
  their skin, rather than the staff glyph — four people drawn as four copies of
  one silhouette is the same complaint five floors in one grey glyph were.
- **A browse-bar button is one fixed width.** Everywhere else a `.tool` ranges
  between a floor and a ceiling and sizes to its text; a roster entry's text is
  what that person is doing *right now*, so sizing to it means every button
  shifts sideways every few seconds. Both lines ellipsise and the tooltip
  carries the sentence.

For what a hire *is* — a roster row rather than an upgrade, and therefore two of
somebody, letting one go, promotions, skins and job weights — see
**docs/workers.md**. This section covers the shell only.

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

**Rows are chips with 3px between them, and the reason is a lit one.** Stacked
edge to edge a list reads as a table, which is survivable — right up until two
adjacent rows are `picked`. Each carries a 2px inset ring, so two of them
touching draw a 4px seam and the pair reads as one block with a rule through it.
The spacing is `.sec-row + .sec-row` rather than a gap on the container: a
heading brings its own margin and its own line, and the last row must not push
against the panel's padding.

**The lead column is centred; the words are not.** `.sec-row` is `flex-start`
because a caption that wraps should hang off the name — and that is the wrong
answer for a single glyph standing for the whole row, which then lines up with
the first line of it and looks like it slipped. `align-self` on the lead only,
because moving the row to `center` takes the price, the count and the steppers
with it.

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
- **A drill-down shares its list's position** (`UI.panelPosKey`). The item menu
  is the supplier one press deep, not a second menu, so it files under `stock`:
  press a row and the window stays exactly where it is while its contents
  change. Filed under its own id it opened wherever nothing had put it yet —
  the window you were reading jumping across the screen, which reads as a new
  window rather than as the same one going in a level. It is also why the answer
  to "why not two panels" is that there is one: a second would need its own
  drag, its own z-order and its own answer for a phone, where the second panel
  is the whole screen.

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
