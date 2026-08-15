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
    icon: '🗄',
    name: 'Shelf',
    blurb: 'Ordinary shelving. Holds anything that does not need freezing. Shoppers browse from the side it faces, so watch the ring when you rotate it.',
  },
  {
    id: 'freezer',
    icon: '🧊',
    name: 'Freezer',
    blurb: 'The only thing that will hold frozen goods, and it slows everything else down to a crawl too — four times the shelf life.',
  },
  {
    id: 'checkout',
    icon: '💳',
    name: 'Till',
    blurb: 'Somewhere to take money. The queue forms alongside, so a till needs a clear run beside it — the ghost goes red if there is nowhere to stand.',
  },
  {
    id: 'plot',
    icon: '🌱',
    name: 'Plot',
    blurb: 'A bed of earth, outside on the grass. Arrives rough — it needs turning over before it will take a seed.',
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
export const SECTIONS = [
  {
    id: 'build',
    icon: '🔨',
    name: 'Build',
    key: 'm',
    title: 'Build',
    // Opening the catalogue is saying you want to build, so put the world in
    // build mode rather than making that a second thing to remember.
    onOpen: (ui) => { if (!ui.buildOn) ui.toggleBuild(true); },
    badge: (ui) => (ui.holding ? '●' : null),
    live: (ui) => JSON.stringify([ui.fixtureCounts, ui.buildTool, ui.buildCosts]),
    rows: (ui) => BUILD_TOOLS.map((t, i) => {
      const cost = ui.buildCosts[t.id];
      const have = ui.fixtureCounts?.[t.id];
      return {
        hot: i + 1,
        icon: t.icon,
        name: t.name,
        own: have == null ? null : `you have ${have}`,
        sub: t.blurb,
        right: cost == null ? '' : `$${cost.toFixed(0)}`,
        picked: t.id === ui.buildTool,
        run: () => { ui.selectBuildTool(t.id); ui.closePanel(); },
      };
    }),
    foot: () => `Tap bare ground to place · <b>R</b> rotates · drag still walks you around.
      To move, turn, empty or sell something you already own, tap the thing itself —
      everything in the shop has its own menu. Appliances come from the Upgrades menu.`,
  },

  {
    id: 'seeds',
    icon: '🌱',
    name: 'Seeds',
    key: 'f',
    title: 'Seeds',
    // Crops carry seasons, not tags — the chips filter on what the content
    // actually has, or you get a row of chips that match nothing.
    facet: 'season',
    badge: (ui) => {
      const ready = (ui.state?.plots ?? []).filter((p) => p.soil === 'tilled' && !p.crop_id).length;
      return ready ? String(ready) : null;
    },
    live: (ui) => JSON.stringify([
      ui.selectedCrop, ui._season, Math.floor(ui._cash ?? 0),
      (ui.state?.plots ?? []).filter((p) => p.soil === 'tilled' && !p.crop_id).length,
    ]),
    rows: (ui) => ui.catalog.crops.map((c, i) => {
      const inSeason = !c.seasons?.length || c.seasons.includes(ui._season);
      const affordable = (ui._cash ?? 0) >= c.seed_cost;
      const why = !inSeason ? `out of season — grows in ${c.seasons.join(', ')}` : null;
      return {
        hot: i < 9 ? i + 1 : null,
        icon: '🌱',
        name: c.name,
        sub: why ?? `${Math.round(c.grow_minutes)} min to grow · ${c.seasons?.length ? c.seasons.join(', ') : 'any season'}`,
        right: money(c.seed_cost),
        facets: c.seasons?.length ? c.seasons : ['any'],
        picked: c.id === ui.selectedCrop,
        dim: !inSeason || !affordable,
        run: () => { ui.selectCrop(c.id); ui.closePanel(); },
      };
    }),
    foot: () => `Picked seed goes in the next plot you turn over. <b>1</b>–<b>9</b> picks
      without opening this, and holding <b>Q</b> gives you the same list as a wheel under the pointer.`,
  },

  {
    id: 'stock',
    icon: '🛒',
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
    rows: (ui) => ui.catalog.items.map((it) => ({
      name: it.name,
      sub: it.tags.join(' · '),
      right: money(it.base_cost),
      facets: it.tags,
      dim: (ui._cash ?? 0) < it.base_cost * 6,
      button: { label: '×6', run: () => ui.net.send('buy-stock', { itemId: it.id, qty: 6 }) },
    })),
    foot: () => 'Delivered to the bay as a pallet. Carry it to a shelf to put it out.',
  },

  {
    id: 'upgrades',
    icon: '⬆️',
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
    rows: (ui) => {
      const owned = ui.ownedUpgrades ?? [];
      return (ui.catalog.upgrades ?? []).map((u) => {
        const have = owned.includes(u.id);
        return {
          name: u.name,
          sub: u.description,
          right: `$${u.cost.toFixed(0)}`,
          facets: u.kind ? [u.kind] : [],
          dim: have,
          button: have
            ? null
            : { label: 'buy', run: () => ui.net.send('buy-upgrade', { upgradeId: u.id }) },
          tail: have ? 'owned' : null,
        };
      });
    },
  },

  {
    id: 'shop',
    icon: '📊',
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
        { sep: 'Today' },
        stat('Taken', money(st.revenue ?? 0), `${st.sold ?? 0} sold`),
        stat('Spent', money(st.spent ?? 0), 'stock, seed and building'),
        stat('Profit', money((st.revenue ?? 0) - (st.spent ?? 0)), 'what is actually left'),
        best ? stat('Best seller', `${best[1]}`, ui.itemName(best[0])) : null,

        { sep: 'Going wrong' },
        stat('Walked out', String(st.abandoned ?? 0), 'queued too long or could not find it'),
        stat('Found nothing', String(st.leftEmpty ?? 0), 'came in, shelf was bare'),
        stat('Spoiled', String(st.spoiled ?? 0), 'sat out past its shelf life'),

        { sep: 'The shop' },
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
    icon: '？',
    name: 'Controls',
    key: '/',
    title: 'Controls',
    rows: () => [
      { sep: 'Getting about' },
      { name: 'Walk', sub: 'or drag anywhere on the world', right: 'W A S D', plain: true },
      { name: 'Use what you are stood by', sub: 'proximity only arms it — holding is what does it', right: 'hold E', plain: true },
      { name: 'Seed wheel', sub: 'flick to a segment and let go', right: 'hold Q', plain: true },
      { sep: 'Menus' },
      ...SECTION_KEYS(),
      { name: 'Back out one layer', sub: 'menu, then what you are carrying, then build mode', right: 'Esc', plain: true },
      { sep: 'Building' },
      { name: 'Build mode on and off', sub: 'tap bare ground to place, tap a fixture to open it', right: 'G', plain: true },
      { name: 'Turn what you are placing', sub: 'a quarter turn', right: 'R', plain: true },
      { name: 'Pick from the bottom bar', sub: 'fixtures while building, seeds otherwise', right: '1 – 9', plain: true },
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
