/**
 * Seeded randomness.
 *
 * Everything procedural (store layout, farm plots, customer rolls) runs off a
 * seed so that `simulate()` in the MCP playground is reproducible — you can
 * run the same 100 days twice and get the same answer, which is the only way
 * balance testing is worth anything.
 */

/** Fast, tiny, good-enough PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a seed integer. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Convenience wrapper with the helpers the sim actually reaches for. */
export function makeRng(seed) {
  const r = typeof seed === 'string' ? mulberry32(hashSeed(seed)) : mulberry32(seed);
  return {
    next: r,
    float: (min, max) => min + r() * (max - min),
    int: (min, max) => Math.floor(min + r() * (max - min + 1)),
    bool: (chance = 0.5) => r() < chance,
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    shuffle: (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** Weighted pick. `items` is [{weight, ...}]. */
    weighted: (items, weightKey = 'weight') => {
      const total = items.reduce((s, it) => s + (it[weightKey] ?? 1), 0);
      if (total <= 0) return items[0];
      let roll = r() * total;
      for (const it of items) {
        roll -= it[weightKey] ?? 1;
        if (roll <= 0) return it;
      }
      return items[items.length - 1];
    },
  };
}
