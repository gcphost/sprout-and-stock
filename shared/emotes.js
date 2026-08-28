/**
 * THE FOUR THINGS A BODY CAN SAY WITHOUT WORDS.
 *
 * An emote is a *pose*, and that is the whole of the design. It moves the two
 * shoulder pivots every body in the game already has (`characterParts` and
 * `crowdRig` in client/render/props.js), for a couple of seconds, and then it
 * is over. Nothing here reserves a spot, holds a tick, costs money or touches
 * a single number the sim reads — which is why `simulate` is not worth running
 * over it and why a shopper may do one mid-aisle without their errand caring.
 *
 * It lives in `shared/` for the reason `shared/build.js` does: three places
 * have to agree about the vocabulary or the thing breaks quietly. The server
 * refuses a kind it does not know, the strip draws one button per row, and the
 * renderer switches on the same ids. A client sending `waev` must get a
 * refusal rather than a body that stands there, and a fifth emote must reach
 * all three by being added here once.
 *
 * `seconds` is how long the pose lasts, and it is here rather than on the
 * client because the SERVER is what expires it: the snapshot stops carrying an
 * emote the moment it is spent, so a shop full of people is not sending a
 * field about a wave that finished a minute ago. The client's envelope is
 * driven off the same number, or the arm would still be up on the frame the
 * shop stopped mentioning it — which reads as the arm snapping down.
 *
 * Every one of them is drawn in the ARMS and never in the head or the face, and
 * that is a constraint rather than a shortage of ideas. A shopper is drawn out
 * of one instanced batch (`CrowdBatch`), so the five things a body has that are
 * real objects are the four limb pivots and the root — there is no head pivot
 * to nod, and a face is one instance colour that `animateMoods` already owns.
 * A silhouette is also all that survives this camera: at play zoom a hand is
 * about four pixels, so anything that has to be READ has to be read off where
 * the arms are. Add a fifth and it wants to be a different arm shape, not a
 * finer one.
 */

/**
 * Why a wave is answered and the other three are not.
 *
 * Waving at somebody is the one emote that is *addressed* — it is aimed at a
 * person, so a person is owed an answer, and a shop where nobody ever waves
 * back is a shop full of furniture. Cheering, dancing and pointing are things
 * you do near people rather than at them, so a crowd that mirrored them would
 * read as mockery on the second one and as a bug on the third.
 */
export const REPLIED = 'wave';

/** How far a wave carries, in tiles. About the width of an aisle and a bit. */
export const WAVE_REACH = 3.2;

/**
 * The longest anybody dithers before waving back, in seconds.
 *
 * Zero is the wrong answer and it is worth saying why: eight shoppers whose
 * arms all go up on the same tick is a chorus line, which reads as a scripted
 * cutscene rather than as people noticing you. The delay is spread per person
 * off a hash rather than drawn from the rng — see `Game.emote`, and see the
 * kit's own note in CLAUDE.md for why anything cosmetic and per-person costs
 * no draw at all.
 */
export const WAVE_BACK_MAX = 0.75;

/**
 * What being greeted is worth to a shopper's mood, once per visit.
 *
 * A wave is the only thing in the game that moves a customer's patience UP for
 * free, so all three words in that sentence are doing work:
 *
 * **Once**, and per person rather than on a cooldown. `patience` is what a sale
 * is priced against (`REP_VISIT * (mood - MOOD_ANNOYED)`) so an unbounded
 * greeting is a reputation printer you run by holding a key — and a cooldown is
 * still a printer, just a slower one you would be *right* to grind. A flag on
 * the shopper makes it a thing you do rather than a thing you farm, which is
 * also the only version of it that is any fun.
 *
 * **Free**, because the cost is the walk. A greeting is worth most to somebody
 * who is nearly out of patience, and being near them is the whole price:
 * standing in your own shop instead of the stockroom is exactly the behaviour
 * this is meant to reward.
 *
 * **Up**, and never past 1. `moodBase()` starts a shopper below 1 in an ugly
 * shop, so this genuinely tops them up there and does nothing at all in a
 * lovely one — which is the right way round, since charm is what you BUY to
 * avoid having to do this by hand.
 *
 * 0.08 is about six seconds of queueing back, and deliberately not enough to
 * rescue somebody already fuming: `MOOD_FUMING` is 0.2 and `MOOD_ANNOYED` is
 * 0.5, so a wave pulls somebody back from the brink and never turns a storm-out
 * into a sale on its own.
 *
 * ⚠️ `simulate` is BLIND to all of it — the balance bot never emotes, so a
 * before/after over this reports no change because nothing in the run waved,
 * not because waving is free. That is the instrument being blind, and it is why
 * the bound is argued for here rather than measured.
 */
export const WAVE_MOOD = 0.08;

/**
 * ...and how long the greeting HOLDS, which is the half the top-up could not do.
 *
 * `WAVE_MOOD` is a one-shot deposit into an account that is being drained every
 * tick, so what it buys is measured in seconds and there are not many of them: a
 * queueing Foodie gets about seven, a Snack Kid about two and a half. From the
 * outside that is a wave landing on somebody who is *still visibly cross a
 * moment later*, which reads as the gesture not having worked — and the reason
 * it reads that way is that it half hadn't. Anger is `(MOOD_ANNOYED - mood) /
 * (MOOD_ANNOYED - MOOD_FUMING)`, derived rather than stored, so the only way to
 * quell somebody is to move that number and the only way to KEEP them quelled is
 * to stop it moving back.
 *
 * So a greeting pauses `stepMood` outright for this long. Being said hello to
 * does not make the queue shorter, it makes it not count for a moment, which is
 * both the more honest sentence and the one you can see.
 *
 * Every bound `WAVE_MOOD` argues for is inherited rather than re-stated, and
 * that is deliberate: this is set in the same `!who.greeted` branch, so it is
 * the SAME once-per-visit flag and not a second budget beside it. There is no
 * way to hold a key and keep somebody calm, and no cooldown to grind.
 *
 * What it does NOT do is lift anybody. The top-up stays 0.08 and the ceiling
 * stays 1, so `WAVE_MOOD`'s claim above — that a wave never turns a storm-out
 * into a sale on its own — survives: somebody fuming is held at fuming rather
 * than rescued from it. It buys you the time to fix the actual problem, which is
 * the till.
 *
 * Six seconds because it has to be shorter than the shortest patience in the
 * game is long: an authored `patience` is seconds-to-storm-out since the `mood0`
 * scaling landed, and the meanest archetypes sit near 25. A pause worth a
 * quarter of somebody's entire visit is a queue you clear by waving at it.
 *
 * ⚠️ `simulate` is blind to this for `WAVE_MOOD`'s reason exactly — the balance
 * bot never emotes.
 */
export const WAVE_CALM = 6;

/**
 * id → what it is called and how long it lasts.
 *
 * `icon` is a name in `client/icons.js` rather than a glyph, because the strip
 * is drawn out of the same generated set every other button in the game is —
 * an emoji in a row of Phosphor marks is the mixed-weight bug the icon script's
 * own header spends a paragraph on.
 */
export const EMOTES = {
  wave: { label: 'Wave', icon: 'wave', seconds: 2.4 },
  cheer: { label: 'Cheer', icon: 'cheer', seconds: 2.2 },
  dance: { label: 'Dance', icon: 'dance', seconds: 3.6 },
  point: { label: 'Point', icon: 'point', seconds: 2.0 },
};

/**
 * The same thing as a list, in the order the strip lays them out.
 *
 * Which is also the order of the number keys, so the row and the keyboard
 * cannot come to disagree about which one `2` is.
 */
export const EMOTE_LIST = Object.entries(EMOTES).map(([id, e]) => ({ id, ...e }));

/** Whether the wire just named something that exists. */
export const isEmote = (kind) => Object.hasOwn(EMOTES, kind);

/** How long one lasts, and 0 for anything that is not one. */
export const emoteSeconds = (kind) => EMOTES[kind]?.seconds ?? 0;
