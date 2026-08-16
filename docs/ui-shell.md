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
| **Right rail** | one icon per menu, each with a live badge — plus Build, which is a mode | yes — this is the menu |
| **Bottom bar** | the whole build palette, and only while building | yes — one tap or number key each |

The panel opens **leftwards** out of the rail, top-aligned, which is why it
moved from `inset: auto 14px 14px auto` to `inset: 14px 58px auto auto`. That
also freed the bottom of the screen for the hotbar, so the two no longer stack
and `body.building #panel` could go.

`#mods` moved from top-right to under `#stats` on the left: it is a passive
readout and belongs with the other passive readouts, and the rail now owns the
right-hand edge. `#help` was deleted as a permanent line and became the `/`
section — it used to hide itself in build mode, which is exactly when a new
player most needs it.

## Files

| File | Holds |
|---|---|
| `client/sections.js` | `SECTIONS` and `BUILD_TOOLS`. Every menu, as data. |
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

## The build bar

**Build is not a section.** It was one — a 214px list in `#panel` — while the
bottom bar showed the first nine entries of the same list. Two palettes for one
palette, and the bar could only ever be a preview: nine is how many number keys
there are, so a tenth fixture had nowhere to go but the panel. The bar has tiers
now and it scrolls, so it *is* the catalogue and the panel copy is gone.

Three tiers, top to bottom, all in `#build-bar`:

| Tier | Element | Is |
|---|---|---|
| Category | `#build-groups` | `BUILD_GROUPS` — Shop, Farm, Appliances, Building, Decoration |
| Entries | `#build-tools` | that tab's palette entries, scrolling sideways. `1`–`9` reach the first nine |
| Shape | `#build-shapes` | `variantsOf` the selected piece, and only when there are two or more |

The split is by **what you are doing**, not by which code path places it — a
fence is drawn on an edge exactly the way a wall is, and it sits under Farm
because fencing a field is farming. A tool may name several groups (`group` is a
string or an array), and a group nobody has authored anything for never renders.

**The hint (`#build-hint`) sits above the bar and only when it has news** — what
is in your hands, what you are pointing at, or an amber warning. It used to
carry a standing "tap bare ground to build a shelf", which restated the button
already lit beside it, sat on the bottom edge of the screen, and held the rest
of the corner HUD up for a line nobody read twice.

`--build-h` is the bar's measured height, set in `renderHotbar` → `measureBar`,
and `#log`/`#carry`/`#prompt` clear the bar with `calc()` off it. It is measured
rather than written down because the bar grows and shrinks — the shapes tier
appears, the hint comes and goes — and a hard-coded offset is one that goes
wrong the day a tier is added.

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
| `B` `U` `H` `T` `/` | toggle Supplier · Upgrades · Staff · Shop · Controls |
| `G` | build mode on and off — the rail's Build button presses this |
| `1`–`9` | bottom bar — the open tab while building, seeds otherwise |
| `Tab` | next build tab (`shift` for back). Prevented hard, or focus lands in the search box |
| `R` | turn what you're placing |
| hold `E` / `Space` | use what you're stood by |
| hold `Q` | seed wheel |
| `Esc` | clear the search box → close the menu → put down what you're carrying → leave build mode |
| right-click | the same ladder, on the world — but cancels a half-drawn wall run first |

Right-click runs `ui.escape()` rather than dropping straight out to shopkeeping,
and the difference is load-bearing exactly once: **with something in your hands,
"out" has to mean putting it back before it means leaving the mode**, or one
click strands the fixture you were carrying. Mid-drag it takes the run instead —
`endStick()` with no event drops the segments without sending them — because a
wall you have changed your mind about is not a mode you have changed your mind
about. The build bar swallows the browser's context menu without acting on it: a
right-click on a button is a miss, not a decision to leave.

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
  `renderBuildShapes`, `buildGroupList`, `openBuildGroup`, `selectBuildGroup`,
  `cycleBuildGroup`, `hotbarTools`, `renderBuildHint`, `measureBar`) is the next
  ~200 self-contained lines and wants `client/build-bar.js`.
- Nothing verifies the rail or the bar at narrow widths beyond a look — `#panel`
  is `calc(100vw - 72px)` under 720px to clear the rail, and `.cat .nm` is
  hidden there so five tabs still fit.
- **None of the bar has been seen by an agent.** `screenshot` is
  `renderer.domElement.toDataURL()` — the WebGL canvas only — so every DOM
  change in this file is verified by a human looking at it or not at all.
