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
| **Right rail** | one icon per menu, each with a live badge | yes — this is the menu |
| **Bottom hotbar** | the build palette, and only while building | yes — one tap or number key each |

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

## Keys

Bound from `SECTIONS` in `main.js`, so a new section is bound and labelled the
moment it exists.

| Key | Does |
|---|---|
| `M` `B` `U` `H` `T` `/` | toggle Build · Supplier · Upgrades · Staff · Shop · Controls |
| `G` | build mode on and off |
| `1`–`9` | hotbar slot — fixtures while building, seeds otherwise |
| `R` | turn what you're placing |
| hold `E` / `Space` | use what you're stood by |
| hold `Q` | seed wheel |
| `Esc` | clear the search box → close the menu → put down what you're carrying → leave build mode |

**`G` is not a menu key.** Build *mode* is a state of the world — a ghost on the
ground, taps that place instead of walk — and the Build *menu* is a list of
things to buy.

Opening the menu turns the mode on, and **shutting it without picking anything
turns the mode back off**. A menu that leaves the world in a mode you can't see
you're in is how you end up placing a shelf when you meant to walk. Three rules
make that work, and all three are needed:

- **Pick a row, or lift something → the mode stays.** You opened it to choose a
  shelf and then place six of them, and lifting leaves the thing in your hands.
  Both clear `_modeFromMenu` first: acting is committing.
- **Any panel closing with nothing left open → the mode goes**, but only if a
  menu is what switched it on.
- **`G` outranks the menus.** If you were already building when you opened one,
  shutting it leaves you building — the mode was never the menu's to take away.

`releaseMenuMode()` is called from `closePanel` and from `showSection` when
switching, and it is deliberately **not** scoped to the Build menu's own close.
Opening Build and then tapping a shelf swaps that menu for the *fixture's*, so
by the time you remove the shelf the Build menu is long gone — and it was that
gap that left you stood in an armed build mode with nothing on screen saying so,
where the next tap built a shelf you never asked for.

Two supporting details, both load-bearing:

- It skips while `ui.holding`, or dropping the mode would strand a carried
  fixture. The Move handler can't rely on that — `holding` isn't true until the
  next snapshot — so it clears the flag itself.
- `closePanel` releases the mode *after* clearing `openPanel`, because
  `toggleBuild(false)` closes an open fixture menu and would otherwise re-enter.

The rail's Build icon carries a `mode` outline whenever build mode is on and its
menu is shut, so the state is never invisible.

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

- **`client/ui.js` is 844 lines**, over the 600 cap. The fixture menu
  (`showFixture`, `fixtureDetail`, `fixtureUpgrades`, `wireFixtureMenu`,
  `contentsOf`, `removeBlockedReason`, `refundFor`) is ~250 self-contained lines
  and is the obvious extraction into `client/fixture-menu.js`.
- The `☰` on the hotbar's Menu button is still a character, not an icon.
- Nothing verifies the rail at narrow widths beyond a look — `#panel` is
  `calc(100vw - 88px)` under 720px specifically to clear it.
