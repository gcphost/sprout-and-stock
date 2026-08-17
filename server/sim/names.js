/**
 * Who everybody is.
 *
 * Two registers, because this shop is staffed by machines and shopped in by
 * people — and, often enough to be worth it, the other way round. A hire is
 * drawn from `parts` in `workers` with a chassis, trim and a glow, so a clerk
 * called "Marla Finch" is a picture and a name disagreeing; a shopper is a
 * capsule with a nose and could be either, so shoppers are mostly people with
 * a share of bots among them. That share is the only thing in here that is a
 * decision rather than a word list.
 *
 * Names are **cosmetic**, and the one rule that keeps them cosmetic is that
 * they are drawn off their own stream. `Game.rng` is re-seeded `seed:day` and
 * every balance number in the game is downstream of how many times it has been
 * called — so naming a shopper out of it would shift every crop draw, every
 * basket and every spawn roll after it, and two `simulate` runs either side of
 * this file would diverge for reasons that have nothing to do with anything.
 * `makeNamer` owns a stream nothing else touches, seeded once and never
 * re-seeded (a namer re-seeded each morning hands out Monday's names again).
 *
 * The pools are code rather than a content table on purpose: there is no
 * behaviour here to author, and a `names` table would be the first content in
 * the game that no tag reads and no `simulate` can measure. Adding a word is a
 * one-line edit to one file nobody else has open.
 */

import { makeRng } from '../../shared/rng.js';

/** People. First × last, which is ~2,300 of them before anything repeats. */
const HUMAN_FIRST = [
  'Marla', 'Bex', 'Otto', 'Nina', 'Farrah', 'Casper', 'Ines', 'Rufus',
  'Hattie', 'Milo', 'Suki', 'Dev', 'Greta', 'Ambrose', 'Priya', 'Bo',
  'Winnie', 'Silas', 'Noor', 'Fitz', 'Delia', 'Ozzy', 'Juno', 'Kit',
  'Marisol', 'Ted', 'Agnes', 'Rami', 'Bonnie', 'Hugo', 'Esme', 'Wes',
  'Tallulah', 'Nate', 'Ida', 'Sol', 'Perry', 'Yusuf', 'Clemmie', 'Dot',
  'Hana', 'Jonah', 'Lupe', 'Nell', 'Ravi', 'Sena', 'Vic', 'Zora',
];

const HUMAN_LAST = [
  'Finch', 'Marlow', 'Bramwell', 'Quaye', 'Odell', 'Pike', 'Rossi', 'Vance',
  'Ashby', 'Kettle', 'Nwosu', 'Fenwick', 'Halloran', 'Dunn', 'Ilori', 'Beazley',
  'Crisp', 'Mott', 'Vargas', 'Okonkwo', 'Salter', 'Brindle', 'Fairweather', 'Lund',
  'Petrova', 'Wick', 'Hobbs', 'Sarkar', 'Delacroix', 'Tam', 'Merriwether', 'Groves',
  'Kaur', 'Buckle', 'Yun', 'Plum', 'Ellery', 'Nasser', 'Cobb', 'Redgrave',
  'Tilley', 'Vinter', 'Okoye', 'Bright', 'Snell', 'Ferris', 'Ashworth', 'Mbeki',
];

/**
 * Machines. One stem list, three ways of wearing it — a serial, a mark number
 * or a series prefix — because a shop of nothing but `Thing-07` reads as a
 * spreadsheet, and a shop of nothing but `Whisk Mk IV` reads as a joke told
 * twice. Stems are workshop and allotment nouns rather than sci-fi ones: these
 * are appliances that stack shelves, not starship crew.
 */
const BOT_STEM = [
  'Rivet', 'Bramble', 'Clover', 'Widget', 'Sprocket', 'Tally', 'Cog', 'Bolt',
  'Gasket', 'Nutmeg', 'Pip', 'Solder', 'Radish', 'Beacon', 'Pixel', 'Flint',
  'Turnip', 'Domino', 'Ratchet', 'Nimbus', 'Bobbin', 'Quill', 'Marigold', 'Tansy',
  'Pepper', 'Suds', 'Tinker', 'Trundle', 'Pumice', 'Bellows', 'Cinder', 'Grit',
  'Hopper', 'Lumen', 'Pebble', 'Quartz', 'Scuttle', 'Thimble', 'Wobble', 'Zinc',
  'Ember', 'Fuse', 'Gantry', 'Hinge', 'Ingot', 'Kelvin', 'Lathe', 'Mitten',
  'Nickel', 'Pylon', 'Rasp', 'Spindle', 'Torque', 'Whisk', 'Dandy', 'Waffle',
];

/** Two letters off a plate. Deliberately meaningless — a plate is not a word. */
const BOT_SERIES = ['TK', 'QP', 'MX', 'AR', 'ZM', 'HB', 'VC', 'NX', 'DL', 'KP', 'RS', 'JB'];

const MARKS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * How many shoppers are machines.
 *
 * Not a balance knob — nothing in the sim reads it and nothing about a shopper
 * changes with it. It is here so the two registers are both *visible* in a
 * day's trading: a world where only the staff are bots never shows you the half
 * of the name list you are paying attention to.
 */
export const BOT_SHOPPER_SHARE = 0.25;

/** How many draws before a namer gives up on finding an unused one. */
const TRIES = 24;

/**
 * A stream of names.
 *
 * `seed` is a string, so a namer is reproducible the way everything else
 * seeded in here is — the same world hands out the same names in the same
 * order. It survives a reload only in the sense that it starts again from the
 * top, which is fine because the only names anything remembers are the roster's
 * and `unique` is given those to avoid.
 */
export function makeNamer(seed) {
  const rng = makeRng(`${seed}:names`);

  const human = () => `${rng.pick(HUMAN_FIRST)} ${rng.pick(HUMAN_LAST)}`;

  const bot = () => {
    const stem = rng.pick(BOT_STEM);
    const roll = rng.next();
    if (roll < 0.5) return `${stem}-${rng.int(2, 99)}`;
    if (roll < 0.8) return `${rng.pick(BOT_SERIES)}-${stem}`;
    return `${stem} Mk ${rng.pick(MARKS)}`;
  };

  /** One name. `bot: true` for a machine, `false` for a person. */
  const one = ({ bot: isBot = false } = {}) => (isBot ? bot() : human());

  return {
    human,
    bot,
    one,

    /** Whether the next body drawn should be a machine. Its own draw, so a
     * caller that only ever wants people costs the stream nothing extra. */
    botShopper: () => rng.next() < BOT_SHOPPER_SHARE,

    /**
     * One name nobody in `taken` already has.
     *
     * The pools are big enough that this is a formality — but two Clover-40s
     * standing at the same till is exactly the kind of thing that reads as the
     * game having lost track of somebody, so it is worth the loop. After
     * `TRIES` unlucky draws it stops drawing and counts instead, which
     * terminates whatever is in `taken`.
     */
    unique: (taken, opts = {}) => {
      const seen = taken instanceof Set ? taken : new Set(taken ?? []);
      for (let i = 0; i < TRIES; i++) {
        const name = one(opts);
        if (!seen.has(name)) return name;
      }
      const base = one(opts);
      for (let n = 2; ; n++) {
        const name = `${base} ${n}`;
        if (!seen.has(name)) return name;
      }
    },
  };
}
