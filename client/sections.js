import { ICONS, icon } from './icons.js';
import { variantsOf } from '../shared/model.js';
import { showWorker, doingNow, bodyOf, kindSummary } from './worker-menu.js';

/**
 * Every browsable list that renders into #panel.
 *
 * A section describes its rows; it never touches the DOM. `UI.showSection`
 * renders, filters and wires them, which is what lets search and the tag chips
 * work everywhere for free — including in sections that don't exist yet.
 *
 * Adding a menu is one entry in SECTIONS. The rail reads this same array, so a
 * new section gets its icon, its hotkey and its badge with no other change.
 */

/**
 * The build palette: only things you can put down.
 *
 * Lives here rather than in ui.js because both the panel and the bottom hotbar
 * render from it, and a palette that disagreed with itself between the two is
 * how you end up pressing 2 and getting a till.
 */
export const BUILD_TOOLS = [
  {
    id: 'shelf',
    icon: ICONS.shelf,
    name: 'Shelf',
    blurb: 'Anything that needs no freezing. Browsed from the side it faces.',
  },
  {
    id: 'freezer',
    icon: ICONS.freezer,
    name: 'Freezer',
    blurb: 'The only home for frozen goods. Four times the shelf life.',
  },
  {
    id: 'checkout',
    icon: ICONS.checkout,
    name: 'Till',
    blurb: 'Takes money. Needs a clear run alongside for the queue.',
  },
  {
    id: 'plot',
    icon: ICONS.plot,
    name: 'Plot',
    blurb: 'Earth, outside. Turn it over before it takes a seed.',
  },
];

/** Shelves at or under this fraction of a stack are worth restocking. */
const LOW_STOCK = 0.2;

const money = (n) => `$${n.toFixed(2)}`;

/**
 * Sections, in rail order.
 *
 * - `id` doubles as `openPanel`, which is what `setCatalog` and `update` test
 *   to know whether an open menu needs redrawing. It has to be unique.
 * - `rows(ui)` is read fresh on every render, so a row is never stale.
 * - `live(ui)` is a cheap signature of everything the rows read. When it
 *   changes, the open section redraws — and only then, rather than at 10Hz.
 * - `badge(ui)` is what the rail shows without being opened.
 */
/**
 * Sort a flat list into tabbed groups.
 *
 * Each bucket takes the rows the ones before it didn't, so the buckets read as
 * a priority order and every row lands in exactly one tab; a bucket with no
 * `test` catches the remainder and belongs last. Empty buckets are dropped
 * rather than shown, because a tab that opens onto nothing is worse than no tab.
 *
 * This is the piece that lets a list generated from the database be tabbed at
 * all: the groups are declared by what a row *is*, not by where it sits.
 */
function grouped(rows, buckets) {
  const bins = buckets.map(() => []);
  for (const r of rows) {
    const i = buckets.findIndex((b) => !b.test || b.test(r));
    if (i >= 0) bins[i].push(r);
  }
  return buckets.flatMap((b, i) => (
    bins[i].length ? [{ sep: b.label, icon: b.icon }, ...bins[i]] : []
  ));
}

export const SECTIONS = [
  {
    id: 'build',
    icon: ICONS.build,
    name: 'Build',
    key: 'm',
    title: 'Build',
    // Opening the catalogue is saying you want to build, so put the world in
    // build mode rather than making that a second thing to remember — and take
    // it back off again if the menu is shut without picking anything. A menu
    // that leaves the world in a mode you can't see you're in is how you end up
    // placing a shelf when you meant to walk.
    //
    // `_modeFromMenu` is what keeps that honest: if you were already building
    // when you opened this (you pressed G), closing it leaves you building.
    onOpen: (ui) => {
      ui._modeFromMenu = !ui.buildOn;
      if (!ui.buildOn) ui.toggleBuild(true);
    },
    badge: (ui) => (ui.holding ? '●' : null),
    live: (ui) => JSON.stringify([
      ui.fixtureCounts, ui.buildTool, ui.buildVariant, ui.buildCosts,
      (ui.catalog.fixtures ?? []).map((f) => f.variants?.length ?? 0),
    ]),
    rows: (ui) => {
      const tools = BUILD_TOOLS.map((t) => {
        const cost = ui.buildCosts[t.id];
        const have = ui.fixtureCounts?.[t.id];
        return {
          icon: t.icon,
          name: t.name,
          sub: have == null ? t.blurb : `${have} owned · ${t.blurb}`,
          right: cost == null ? '' : `$${cost.toFixed(0)}`,
          picked: t.id === ui.buildTool,
          // Picking one is committing to build, so the mode is yours to keep.
          run: () => { ui.commitBuildMode(); ui.selectBuildTool(t.id); ui.closePanel(); },
        };
      });

      // The shapes of whatever is selected. They stay on this menu rather than
      // becoming their own palette entries, because a corner shelf is not a
      // fifth thing to buy — it is a shelf, at a shelf's price, and the number
      // keys should keep meaning one fixture each.
      const shapes = variantsOf(ui.catalog.fixtures?.find((x) => x.id === ui.buildTool));
      if (shapes.length < 2) return tools;
      return [
        ...tools,
        { sep: 'Shape to build' },
        ...shapes.map((v) => ({
          icon: ICONS.fixtures,
          name: v.name,
          sub: 'same price, same capacity — just the shape',
          picked: v.id === (ui.buildVariant ?? ''),
          run: () => { ui.commitBuildMode(); ui.selectBuildVariant(v.id); ui.closePanel(); },
        })),
      ];
    },
    foot: () => 'Tap bare ground to place · <b>R</b> rotates · tap anything you own for its own menu.',
  },

  {
    id: 'stock',
    icon: ICONS.supplier,
    name: 'Supplier',
    key: 'b',
    title: 'Supplier',
    facet: 'tag',
    // A shelf sat empty is money not being made, and it is the one thing you
    // cannot see from across the shop.
    badge: (ui) => {
      const low = (ui.state?.shelves ?? []).filter((s) => {
        if (!s.item_id) return true;
        const stack = ui.itemById(s.item_id)?.stack ?? 0;
        return stack ? s.qty <= stack * LOW_STOCK : s.qty === 0;
      }).length;
      return low ? String(low) : null;
    },
    live: (ui) => String(Math.floor(ui._cash ?? 0)),
    // Grouped by where the thing has to live, not by what aisle it belongs in.
    // The tag chips already slice by category; what the tabs answer is the
    // question you cannot answer from the name — "do I even have somewhere to
    // put this", which is what decides whether buying it was a mistake.
    rows: (ui) => grouped(
      ui.catalog.items.map((it) => ({
        name: it.name,
        sub: it.tags.slice(0, 3).join(' · '),
        right: money(it.base_cost),
        facets: it.tags,
        tags: it.tags,
        dim: (ui._cash ?? 0) < it.base_cost * 6,
        button: { label: '×6', run: () => ui.net.send('buy-stock', { itemId: it.id, qty: 6 }) },
      })),
      [
        { label: 'Frozen', icon: ICONS.cold, test: (r) => r.tags.includes('needs-freezer') },
        { label: 'Fresh', icon: ICONS.fresh, test: (r) => r.tags.includes('perishable') },
        // Everything else keeps at room temperature, including anything an
        // author never tagged either way — a shelf is the safe default.
        { label: 'Keeps', icon: ICONS.ambient },
      ],
    ),
    foot: () => 'Lands at the bay as a pallet.',
  },

  {
    id: 'upgrades',
    icon: ICONS.upgrades,
    name: 'Upgrades',
    key: 'u',
    title: 'Upgrades',
    facet: 'kind',
    badge: (ui) => {
      const owned = ui.ownedUpgrades ?? [];
      const n = (ui.catalog.upgrades ?? [])
        .filter((u) => !owned.includes(u.id) && (ui._cash ?? 0) >= u.cost).length;
      return n ? String(n) : null;
    },
    live: (ui) => JSON.stringify([ui.ownedUpgrades?.length, Math.floor(ui._cash ?? 0)]),
    // There are nine upgrade kinds and only eighteen upgrades, so a tab per kind
    // would be mostly one-row tabs. These three are the question actually being
    // asked — am I buying people, buying better fixtures, or buying more room.
    rows: (ui) => {
      const owned = ui.ownedUpgrades ?? [];
      return grouped(
        (ui.catalog.upgrades ?? []).map((u) => {
          const have = owned.includes(u.id);
          return {
            name: u.name,
            sub: u.description,
            right: `$${u.cost.toFixed(0)}`,
            facets: u.kind ? [u.kind] : [],
            kind: u.kind,
            dim: have,
            button: have
              ? null
              : { label: 'buy', run: () => ui.net.send('buy-upgrade', { upgradeId: u.id }) },
            tail: have ? 'owned' : null,
          };
        }),
        [
          { label: 'Staff', icon: ICONS.staff, test: (r) => r.kind === 'staff' },
          {
            label: 'Fixtures',
            icon: ICONS.fixtures,
            test: (r) => ['shelf', 'freezer', 'plot', 'checkout', 'station'].includes(r.kind),
          },
          // capacity, speed, space — and any kind invented later, which lands
          // somewhere sensible rather than vanishing off the end of the list.
          { label: 'The shop', icon: ICONS.shop },
        ],
      );
    },
  },

  {
    id: 'staff',
    icon: ICONS.staff,
    name: 'Staff',
    key: 'h',
    title: 'Who works here',
    facet: 'tag',
    // The roster is the ledger of who works here; the NPC on the floor is only
    // its body. Reading the roster rather than counting bodies means someone
    // whose kind was deleted still shows up — as a problem, which is what they
    // are — instead of quietly vanishing off the payroll.
    badge: (ui) => {
      const n = (ui.state?.roster ?? []).length;
      return n ? String(n) : null;
    },
    live: (ui) => JSON.stringify([
      ui.state?.roster,
      (ui.state?.players ?? []).filter((p) => p.staff)
        .map((p) => [p.hire, p.job, p.carry?.qty, p.pastime]),
      Math.floor(ui._cash ?? 0), ui.catalog.version,
    ]),
    rows: (ui) => {
      const roster = ui.state?.roster ?? [];
      const kinds = ui.catalog.workers ?? [];
      const tagsOf = (kindId) => kinds.find((w) => w.id === kindId)?.tags ?? [];

      const rows = [];
      if (roster.length) {
        rows.push({ sep: 'On shift' });
        // The row is the way into that person's own menu, the same way tapping
        // a shelf is the way into the shelf's. Two clerks are two rows, and
        // which one you pressed is the only thing that tells them apart.
        rows.push(...roster.map((e) => ({
          icon: icon(e.kind, ICONS.staff),
          name: e.name,
          sub: doingNow(ui, e, bodyOf(ui, e)),
          facets: tagsOf(e.kind),
          run: () => showWorker(ui, e.id),
        })));
      }

      rows.push({ sep: roster.length ? 'Take someone on' : 'Nobody works here yet' });
      // Straight off the `workers` table, so a kind authored over MCP can be
      // hired with no client change — and hiring the same kind twice is a
      // second person, not a refusal.
      rows.push(...kinds.map((w) => ({
        icon: icon(w.id, ICONS.staff),
        name: w.name,
        sub: kindSummary(w),
        right: `$${w.cost.toFixed(0)}`,
        facets: w.tags ?? [],
        dim: (ui._cash ?? 0) < w.cost,
        button: { label: 'hire', run: () => ui.net.send('hire', { kind: w.id }) },
      })));
      return rows;
    },
    foot: () => `They obey the same rules you do — they walk, queue and carry.
      Tap anyone on shift to change what they do, promote them, or let them go.`,
  },

  {
    id: 'shop',
    icon: ICONS.report,
    name: 'Shop',
    key: 't',
    title: 'How the shop is doing',
    // Today's numbers only. The server keeps yesterday's in `_lastDayStats` but
    // does not send them, so this deliberately says "today" rather than inventing
    // a comparison it cannot make.
    badge: (ui) => {
      const s = ui.state?.stats;
      if (!s) return null;
      const profit = (s.revenue ?? 0) - (s.spent ?? 0);
      if (!s.revenue && !s.spent) return null;
      return profit >= 0 ? '▲' : '▼';
    },
    live: (ui) => JSON.stringify([ui.state?.stats, ui.state?.fixtures, ui.state?.modifiers?.length,
      (ui.state?.shelves ?? []).filter((s) => !s.qty).length]),
    rows: (ui) => {
      const s = ui.state;
      if (!s) return [];
      const st = s.stats ?? {};
      const shelves = s.shelves ?? [];
      const plots = s.plots ?? [];
      const stat = (name, right, sub) => ({ name, right, sub, plain: true });
      const best = Object.entries(st.byItem ?? {}).sort((a, b) => b[1] - a[1])[0];

      return [
        { sep: 'Today', icon: ICONS.today },
        stat('Taken', money(st.revenue ?? 0), `${st.sold ?? 0} sold`),
        stat('Spent', money(st.spent ?? 0), 'stock, seed and building'),
        stat('Profit', money((st.revenue ?? 0) - (st.spent ?? 0)), 'what is actually left'),
        best ? stat('Best seller', `${best[1]}`, ui.itemName(best[0])) : null,

        { sep: 'Going wrong', icon: ICONS.trouble },
        stat('Walked out', String(st.abandoned ?? 0), 'queued too long or could not find it'),
        stat('Found nothing', String(st.leftEmpty ?? 0), 'came in, shelf was bare'),
        stat('Spoiled', String(st.spoiled ?? 0), 'sat out past its shelf life'),

        { sep: 'The shop', icon: ICONS.shop },
        stat('Shelves', `${shelves.filter((x) => x.qty > 0).length} / ${shelves.length}`, 'holding something'),
        stat('Plots', `${plots.filter((p) => p.ready).length} ready`,
          `${plots.filter((p) => p.crop_id).length} planted of ${plots.length}`),
        stat('Queueing', String((s.queues ?? []).reduce((a, q) => a + q.queue, 0)),
          `across ${(s.queues ?? []).length} till${(s.queues ?? []).length === 1 ? '' : 's'}`),
        stat('Harvested', String(st.harvested ?? 0), 'picked today'),
      ].filter(Boolean);
    },
  },

  {
    id: 'help',
    icon: ICONS.help,
    name: 'Controls',
    key: '/',
    title: 'Controls',
    // Every line here is clamped to one line in a 214px panel, so the copy has
    // to be short enough to survive it — an ellipsis mid-word is worse than a
    // blunter phrase. The long version lives in `sub`, which is also the hover.
    rows: () => [
      { sep: 'Getting about', icon: ICONS.walk },
      { name: 'Walk', sub: 'or drag the world', right: 'WASD', plain: true },
      { name: 'Use a thing', sub: 'standing near only arms it', right: 'hold E', plain: true },
      { name: 'Open its menu', sub: 'tap looks, hold uses', right: 'tap', plain: true },
      { sep: 'Camera', icon: ICONS.camera },
      { name: 'Zoom', sub: 'or pinch', right: 'scroll', plain: true },
      { name: 'Turn the view', sub: 'a quarter turn each way', right: ', .', plain: true },
      { sep: 'Menus', icon: ICONS.menus },
      ...SECTION_KEYS(),
      { name: 'Back out', sub: 'menu, then hands, then build mode', right: 'Esc', plain: true },
      { sep: 'Building', icon: ICONS.build },
      { name: 'Build mode', sub: 'tap ground to place, tap a fixture to open', right: 'G', plain: true },
      { name: 'Turn a fixture', sub: 'a quarter turn', right: 'R', plain: true },
      { name: 'Bottom bar', sub: 'fixtures while building, seeds otherwise', right: '1–9', plain: true },
    ],
  },
];

/** The menu keys, listed from the same array that binds them. */
function SECTION_KEYS() {
  return SECTIONS.map((s) => ({
    name: s.name, sub: s.title, right: s.key.toUpperCase(), plain: true,
  }));
}

export const sectionById = (id) => SECTIONS.find((s) => s.id === id) ?? null;
