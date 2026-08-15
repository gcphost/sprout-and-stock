# The menu shell — changeover spec

Status: **spec, not yet built.** Written while `client/ui.js` was being edited by
another agent, so everything below is described by *name and contract*, never by
line number.

Implement in the order under [Migration](#migration). Every step is shippable on
its own and leaves the game playable.

---

## Why we're changing it

Today the UI has no top level. Three unrelated keys (`B`, `U`, `G`) each open a
different thing into the same `#panel`, and the only visible menu — the build
bar — appears solely in build mode. Nothing on screen tells you those menus
exist. The help line at the bottom-left is doing that job in prose.

That was fine for four fixtures. It stops being fine for two reasons:

- **Content grows live.** Items, crops, upgrades and events are added to the
  database mid-session. A menu that is a flat unsearchable list is fine at 12
  rows and unusable at 60. Cities: Skylines 2 shipped a comprehensive catalog
  and players still needed a mod to search it by name, type and tag — the
  failure there wasn't the layout, it was findability. Ours will grow faster
  than theirs because content is one MCP call away.
- **New systems need somewhere to live.** Facilities, recipes, a ledger,
  and later a garrison all need a home. Adding a fourth top-level letter key
  per system doesn't scale, and neither does another bespoke floating div.

## What we're building

A persistent **vertical icon rail, top-right**, that expands **leftwards** into
the existing `#panel`.

```
┌────────────────────────────────────────────────┐
│ $412.50  Day 7  09:14                          │
│ [■■■□] rep                                     │
│ 🏷 organic ×1.4  🌧 root ×0.8                   │
│                                                │
│                        ┌────────────┐  ┌────┐  │
│                        │ BUILD    ✕ │  │ 🔨 │  │
│                        │ ⌕ search   │  │ 🌱 │  │
│                        │ ─────────  │  │ 🛒 │  │
│                        │ 🗄 Shelf $40│  │ ⬆️ ●│  │
│                        │ 🧊 Freezer  │  │ 📊 │  │
│                        │ 💳 Till     │  │ ？ │  │
│                        └────────────┘  └────┘  │
│                                                │
│        [ 1🗄  2🧊  3💳  4🌱 ]                     │
│         hold to use things                     │
└────────────────────────────────────────────────┘
```

Three zones, three jobs, no overlap:

| Zone | Contains | Interactive? |
|---|---|---|
| **Top-left column** | cash, day, season, clock, reputation, active modifiers | no — passive readout |
| **Right rail** | one icon per system, each with a live badge | yes — this is the menu |
| **Bottom hotbar** | the sub-icons for whichever system is active | yes — one tap/keypress each |

The rail is the *display* half and the *actions* half at once: each icon carries
a badge, so the rail is readable at a glance without opening anything (see
[Badges](#badges)).

### Why right-vertical and not bottom-centre

- The catalog grows downward forever; a rail has vertical room and a
  bottom-centre category row does not.
- The panel already docks bottom-right. Expanding leftwards from a right rail
  is a 40px change to `#panel`, not a new layer.
- On a phone the right edge is where the thumb already is, and the existing
  `max-width: 720px` rule that makes `#panel` full-width still applies.
- The bottom-centre strip stays free for the hotbar, which is the thing you
  press constantly. Menus you open once a minute shouldn't sit on top of the
  control you press every second.

---

## Ownership boundary — read this before adding a popover

There is **one panel system**. Anything that lists things, describes things, or
offers actions renders into `#panel` through `showPanel()`.

| You are building | Where it goes |
|---|---|
| A browsable list of content (items, crops, recipes, upgrades, facilities) | a **rail section** — one entry in the `RAIL` array |
| Everything one specific fixture can do | `showFixture()` — already exists, already correct |
| A short confirmation or error | `toast()` |
| What holding the button would do | `updatePrompt()` |
| A radial quick-pick under the pointer | the wheel — and only the wheel |

**Do not add a new floating div.** If a menu genuinely must be anchored in world
space next to its fixture rather than docked, it still uses `showPanel`'s markup
classes (`.row`, `.name`, `.tags`, `.price`, `.sep`, `.fx-detail`) and a single
shared `#popover` element — never a per-feature one. Two divs that look alike
and are styled twice is exactly the duplication this doc exists to prevent.

The reason is concrete: `showFixture` already refreshes itself from the snapshot
via `fixtureSignature`, follows its fixture through a re-flow via
`refreshFixture`, and unwinds correctly under `escape()`. A parallel popover
gets none of that for free and will go stale, survive a re-flow it shouldn't,
and eat the Escape key.

---

## The rail

Data-driven, so adding a system is one array entry and no new code paths.

```js
const RAIL = [
  { id: 'build',    icon: '🔨', name: 'Build',    key: 'g', open: (ui) => ui.showBuild() },
  { id: 'farm',     icon: '🌱', name: 'Seeds',    key: 'f', open: (ui) => ui.showFarm() },
  { id: 'supplier', icon: '🛒', name: 'Supplier', key: 'b', open: (ui) => ui.showStock() },
  { id: 'upgrades', icon: '⬆️', name: 'Upgrades', key: 'u', open: (ui) => ui.showUpgrades() },
  { id: 'ledger',   icon: '📊', name: 'Ledger',   key: 't', open: (ui) => ui.showLedger() },
  { id: 'help',     icon: '？', name: 'Controls', key: '?', open: (ui) => ui.showHelp() },
];
```

Rules:

- `id` **must** match the string `openPanel` is set to, because `setCatalog()`
  and `update()` already re-render the open panel by comparing against it. Get
  this wrong and a section silently stops updating live.
- Pressing a section's key when it is already open **closes** it. Toggle, not
  re-open — otherwise the key you used to open a menu can't dismiss it.
- The rail is always visible, in and out of build mode. It is the one thing on
  screen that says the game has menus.
- `showFarm` and `showLedger` do not exist yet. Ship the rail with the four that
  do and add the entries as the sections land — a rail entry with no section is
  a dead button.

### New DOM

Additive only. Do not restructure existing elements.

```html
<div id="rail" class="hud"></div>          <!-- rendered by renderRail() -->
```

```html
<!-- inside #panel header, before #panel-close -->
<input id="panel-search" placeholder="search…" />
<div id="panel-tags"></div>                <!-- tag filter chips -->
```

`#mods` moves from top-right (where the rail now is) into the top-left column
under `#stats`. It's a passive readout and belongs with the other passive
readouts. This is a CSS move plus one line of HTML — the element keeps its id
and `update()` doesn't change.

`#help` is retired as a permanent line and becomes the `？` rail section. It is
currently hidden in build mode anyway, which means the controls disappear
exactly when a new player most needs them.

### Badges

The rail's display duty. A badge is a small dot or number on the icon, computed
from the snapshot in `update()`:

| Section | Badge shows |
|---|---|
| Build | nothing at rest; `●` while carrying a fixture |
| Seeds | number of plots tilled and empty — "there is somewhere to plant" |
| Supplier | `●` when any shelf is empty or below a fifth of its stack |
| Upgrades | count of upgrades you can currently afford and don't own |
| Ledger | `▲`/`▼` against yesterday's profit |

Recompute only when the derived value changes, not every snapshot — the same
`_countsKey` guard `update()` already uses for `fixtureCounts`. Ten DOM writes a
second for a dot nobody is looking at is how a 60fps canvas starts stuttering.

---

## Search and tag filter

Every list section gets it. This is the CS2 lesson and it is the single most
important part of this spec.

- `#panel-search` filters rows on name substring, case-insensitive.
- `#panel-tags` renders a chip per tag present *in the current section's rows*
  — not the whole vocabulary, or you get chips that match nothing. Tags come
  from the content itself; the vocabulary lives in `shared/tags.js`.
- Chips are additive (OR within a section). Clicking a lit chip clears it.
- Filter state is **per section** and resets when the section closes. A filter
  you can't see the cause of is worse than no filter.
- Both controls hide themselves when the section has fewer than ~8 rows. Search
  over four shelves is noise.

Implementation note: filter in JS over the section's row data and re-render,
rather than toggling `display:none` on DOM nodes. Sections already re-render
wholesale on every catalog change, so a second render path would immediately
diverge from the first.

---

## Keyboard

The rail makes the game keyboard-driven, which is the point. Current bindings
that stay: `WASD`/arrows move, `E`/`Space` hold-to-act, `Q` seed wheel, `R`
rotate in build mode, `Esc` back out one layer.

| Key | Does |
|---|---|
| `G` `F` `B` `U` `T` `?` | toggle that rail section |
| `Tab` | toggle the last-opened section — the "open the menu" key |
| `1`–`9` | hotbar slot (see below) |
| `Esc` | close panel → drop carried fixture → leave build mode |

Two things to get right:

- **`Esc` stays a ladder owned by `escape()`.** One listener, one order. Adding
  a second `keydown` listener for the rail means Escape closes a panel *and*
  quits build mode in one press. The existing comment in `main.js` says this;
  it was learned the hard way.
- **Typing in `#panel-search` must not drive the player.** The movement keys are
  read from a `keys` Set on `document`. Guard the whole `keydown` handler with
  `if (e.target.tagName === 'INPUT') return;` before anything else, or searching
  for "carrot" walks you into a wall. `Esc` in the search box clears the box
  first, then closes on the second press.

### The 1–9 crash — fix this first

`main.js` calls `ui.selectCropByIndex(...)` when a number key is pressed outside
build mode. **That method does not exist on `UI`.** Pressing `1` while not
building throws a TypeError and kills the rest of that keydown handler.

This is why keyboard play feels broken today and it blocks everything else in
this doc. Fix before starting: implement `selectCropByIndex(i)` alongside the
existing `selectBuildToolByIndex(i)`, delegating to `selectCrop` the same way.

### Hotbar

The bottom bar (`#build-tools`) stops being build-only and becomes the sub-icon
row for whatever the rail has active:

- Build active → fixtures, as now.
- Seeds active → crops, so `1`–`9` plants without holding `Q`.
- Nothing active → hidden, as now.

The seed wheel stays exactly as it is. It's the pointer-driven quick-pick and
it's good; the hotbar is the keyboard equivalent. Both write through
`selectCrop()`, which already tells the server. Neither becomes the other's
implementation.

---

## Migration

Each step leaves the game playable and screenshot-able.

0. **Fix `selectCropByIndex`.** One method. Nothing else works until this does.
1. **Rail with existing sections.** Add `#rail`, `renderRail()`, `openSection()`,
   and wire the four sections that already exist (`showBuild`, `showStock`,
   `showUpgrades`, and `showFixture` stays reachable by tapping a fixture). Bind
   the letter keys through the rail rather than direct in `main.js`, so there is
   one place a section can be opened from. Toggle-to-close.
2. **Move `#mods` to the left column, retire `#help` into the `？` section.**
   CSS plus two lines of HTML.
3. **Search + tag chips in `#panel`.** Wire to Supplier first — it's the longest
   list and the easiest to judge.
4. **Badges.**
5. **Hotbar follows the active section**, and Seeds becomes a real section.

Steps 3–5 are independent of each other. 1 and 2 are not — do them in order or
the rail lands on top of `#mods`.

## Don't touch

The agents working alongside this are inside `showFixture`, `fixtureDetail`,
`fixtureUpgrades` and `wireFixtureMenu`. **This changeover does not modify any of
them.** The rail is new methods and new elements; `#panel`'s markup contract and
`showPanel(title, html)`'s signature are unchanged, which is what lets both
streams of work land without a merge fight.

If a step here appears to require editing a fixture-menu method, that's the
signal to stop and re-read this section rather than to widen the change.

## Verifying

- `screenshot` after steps 1, 2 and 5 — the server has no renderer, so this is
  the only way to see it. `stock_shop` first so the shelves aren't bare.
- Check at 1280px **and** under 720px, where `#panel` goes full-width and would
  otherwise land under the rail.
- Open every section, press its key twice, press `Esc` from each. The bug this
  catches is a section that opens but won't close.
- `npm run verify` is not needed — nothing here touches `layout.js`,
  `shared/build.js` or an action.

## Open questions

- **Does the ledger need server support?** Nothing in the snapshot carries
  yesterday's profit today. If the answer is a new field, that's `server/` work
  and a separate conversation before step 4's badge can be honest.
- **Controller/gamepad.** Not planned. If it ever is, the rail is the part that
  maps cleanly to a d-pad and the wheel is the part that doesn't.
