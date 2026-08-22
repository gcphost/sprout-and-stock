/**
 * EVERY SOUND IN THE GAME, AND WHO MADE IT.
 *
 * One row per file, and the row carries the credit rather than a second list
 * somewhere doing it. Same rule `client/thumb.js` is built on — a picture of a
 * thing has to come from the thing — and it matters more here: a hand-typed
 * credits list is not merely wrong when it drifts, it is a licence condition
 * that has quietly stopped being met, and nobody re-reads a credits screen to
 * notice. The Credits tab renders whatever is in this file, so a sound added
 * without a `by`/`from`/`licence` shows up as a hole in it.
 *
 * Everything here is **CC0 or public domain**, which is a floor rather than how
 * it happened to land — see docs/audio.md. The credits tab exists so a CC-BY
 * track *could* be used, not because anything here requires one.
 */

import click from './sfx/click.ogg';
import confirm from './sfx/confirm.ogg';
import error from './sfx/error.ogg';
import milestone from './sfx/milestone.ogg';
import pickup from './sfx/pickup.ogg';
import putdown from './sfx/putdown.ogg';
import crate from './sfx/crate.ogg';
import coins from './sfx/coins.ogg';
import harvest from './sfx/harvest.ogg';
import sale from './sfx/sale.ogg';
import annoyed from './sfx/annoyed.ogg';
import angry from './sfx/angry.ogg';
import beep from './sfx/beep.ogg';
import upgrade from './sfx/upgrade.ogg';
import downgrade from './sfx/downgrade.ogg';
import place from './sfx/place.ogg';
import remove from './sfx/remove.ogg';
import robot from './sfx/robot.ogg';
import machine from './sfx/machine.ogg';
import pump from './sfx/pump.ogg';
import boil from './sfx/boil.ogg';
import motorFast from './sfx/motor-fast.ogg';
import motorHeavy from './sfx/motor-heavy.ogg';
import compressor from './sfx/compressor.ogg';
import element from './sfx/element.ogg';
import extractor from './sfx/extractor.ogg';
import sizzle from './sfx/sizzle.ogg';

import mall from './music/mall.ogg';
import chillin from './music/chillin.ogg';
import home from './music/home.ogg';
import suburb from './music/suburb.ogg';
import valley from './music/valley.ogg';
import beach from './music/beach.ogg';
import school from './music/school.ogg';
import mushrooms from './music/mushrooms.ogg';
import glouglou from './music/glouglou.ogg';
import bicycle from './music/bicycle.ogg';
import strawberry from './music/strawberry.ogg';
import horizon from './music/horizon.ogg';
import seashell from './music/seashell.ogg';
import care from './music/care.ogg';
import hop from './music/hop.ogg';

const KENNEY = { by: 'Kenney', from: 'kenney.nl', licence: 'CC0' };
const MDKIERAN = { by: 'mdkieran', from: 'OpenGameArt', licence: 'CC0' };
const RUBBERDUCK = { by: 'rubberduck', from: 'OpenGameArt', licence: 'CC0' };
const ANTUMDELUGE = { by: 'AntumDeluge', from: 'OpenGameArt', licence: 'CC0' };
const PDSOUNDS = { by: 'stephan', from: 'pdsounds.org / Wikimedia Commons', licence: 'Public domain' };
const MONPLAISIR = { by: 'Monplaisir', from: 'Wikimedia Commons / Free Music Archive', licence: 'CC0' };
const KOMIKU = { by: 'Komiku', from: 'Wikimedia Commons / Free Music Archive', licence: 'CC0' };

/**
 * The one-shots.
 *
 * `gain` is per sound and it is not a mixing convenience — these come from
 * three different packs recorded at three different levels, and normalising
 * them in the manifest is the only place that can be done once. A sound that
 * has to be turned down at every call site is a sound that will be loud at the
 * call site somebody forgets.
 */
export const SOUNDS = [
  { id: 'click', url: click, gain: 0.5, name: 'Interface clicks', ...KENNEY },
  { id: 'confirm', url: confirm, gain: 0.6, name: 'Confirmation', ...KENNEY },
  { id: 'error', url: error, gain: 0.5, name: 'Refusal', ...KENNEY },
  // The one sound in here that is allowed to be a flourish rather than a blip,
  // and the award card is why: it stops the world (see client/award.js), so
  // this is the only moment in the game where nothing else is competing for
  // your ear and there is no next event to be late for. The blip that was here
  // was 0.12s — the same length as a button click, for the rarest thing that
  // happens all game.
  //
  // 0.85 rather than the 0.7 it replaces, and that is not "make it louder": the
  // file is authored at a peak of about −5.7dBFS where the Kenney pack is
  // normalised near full scale, so most of the difference is buying back the
  // headroom the author left. The Menu's Sound rows play each of these on
  // press, which is where to check it by ear.
  { id: 'milestone', url: milestone, gain: 0.85, name: 'Milestone fanfare', ...MDKIERAN },
  { id: 'pickup', url: pickup, gain: 0.8, name: 'Goods picked up', ...KENNEY },
  { id: 'putdown', url: putdown, gain: 0.7, name: 'Goods set down', ...KENNEY },
  { id: 'crate', url: crate, gain: 0.8, name: 'Crate landing', ...KENNEY },
  { id: 'coins', url: coins, gain: 0.7, name: 'Coins', ...KENNEY },
  { id: 'harvest', url: harvest, gain: 0.9, name: 'Crop picked', ...KENNEY },
  // Quiet on purpose: this is the most frequent sound in the game by a long way
  // — every sale in the shop, not just yours — so it is a blip you stop hearing
  // rather than a ka-ching you start resenting.
  { id: 'sale', url: sale, gain: 0.35, name: 'Till blip', ...KENNEY },
  // The two halves of a shopper losing patience, and the one pair in here that
  // has to survive the MUSIC. Everything else reports a thing you did and lands
  // in the half-second you were already listening for it; this reports somebody
  // else, at a moment you are looking at a panel, over a lofi track. The first
  // version of these was a 90ms UI blip at 0.45 — perfectly audible in a silent
  // room, and completely inaudible in the actual game, which reads as the
  // feature never having been wired. Half a second and loud enough to cut
  // through, or they are not there at all.
  { id: 'annoyed', url: annoyed, gain: 0.85, name: 'Shopper losing patience', ...KENNEY },
  { id: 'angry', url: angry, gain: 0.95, name: 'Shopper storming out', ...KENNEY },
  { id: 'beep', url: beep, gain: 0.4, name: 'Reversing beeper', ...KENNEY },
  // A rung up and a rung down, and they are a matched pair on purpose — the
  // ladder goes both ways and a downgrade that sounded like a refusal would
  // read as the shop having rejected it rather than as money coming back.
  { id: 'upgrade', url: upgrade, gain: 0.6, name: 'Tier up', ...KENNEY },
  { id: 'downgrade', url: downgrade, gain: 0.55, name: 'Tier down', ...KENNEY },
  // Furniture landing. One sound for plopping a new unit and for setting a
  // moved one down, because from your side those are the same act — a thing you
  // were holding is now standing there. Wood rather than a UI blip: it is the
  // shop that changed, not a menu.
  { id: 'place', url: place, gain: 0.7, name: 'Fixture set down', ...KENNEY },
  { id: 'remove', url: remove, gain: 0.6, name: 'Fixture taken out', ...KENNEY },
  // The hires. They are machines — `server/sim/names.js` draws them from a
  // register of chassis and trim for exactly that reason — so they chirp rather
  // than grunt. Quiet, because there can be five of them.
  { id: 'robot', url: robot, gain: 0.2, name: 'Hire, picking up a job', ...KENNEY },
  // ---- the loop ----------------------------------------------------------
  // Nothing about this row is special-cased: it is an ordinary sound a piece
  // names off its catalog row, and `loops` is only what tells `sfx.setLoops` it
  // may hold one open rather than firing it once.
  //
  // IT IS MUCH QUIETER THAN ANYTHING ABOVE, and that is the difference between a
  // one-shot and a loop rather than taste. Every sound above is a report you
  // hear once, at a moment you were waiting for it; this one is on for as long
  // as you stand there, and a background you *notice* is a background you end
  // up muting the game to be rid of. The file is cut to a mean of −20dBFS,
  // which is what every number below is tuned against — start here and go DOWN.
  //
  // A LOOP HAS A MINIMUM LENGTH, and that is the one thing about this row that
  // is a rule rather than taste. The file this replaces was **0.63 seconds**: a
  // perfectly good recording of a motor, looped at 1.6Hz, which is squarely in
  // the band the ear reads as mechanical wobble rather than as a steady tone.
  // So it did not sound like an appliance running, it sounded like an appliance
  // with something wrong with it — and nothing about the row, the gain or the
  // wiring was at fault, only the length. Two things follow. Under about two
  // seconds a machine loop is a defect however good the source is, and this one
  // is 7.25s with a 0.75s equal-power crossfade folding its tail over its head,
  // so the wrap is two adjacent samples of the original tape. And `rate`
  // divides it: a variant at 0.78 stretches the period and one at 1.25 shortens
  // it, so the shortest loop in the set is the real floor, not the average.
  // `motor-fast` is still 0.62s and still has this — see the note below it.
  //
  // A FRIDGE HUM WAS THE OTHER HALF OF THIS AND IS GONE, which is worth knowing
  // before authoring the next always-on loop. It was the textbook case for the
  // "a thing that does not know what working means loops always" rule, it
  // worked, and it was still wrong: an appliance running is a thing that
  // STARTED, so the noise is news, where a freezer is on from the day you buy
  // it to the day you sell it — a sound that is never not true reports nothing,
  // and all it can do is sit under every other sound in the game. Which is the
  // ambient bed's verdict (see docs/audio.md) arriving from a completely
  // different direction. The file went with it: an asset nothing names is a
  // download every player pays for and nobody hears.
  // A real dishwasher, not a synthesised one — see docs/audio.md on why the
  // crowd bed failed as synthesis. Cut from the steadiest 8 seconds of a 4m36s
  // public-domain recording, chosen by measuring the tape rather than by
  // scrubbing it: the window whose level and brightness both vary least (5.6%
  // and 17% over 100ms frames) at a level representative of the whole take.
  { id: 'machine', url: machine, gain: 0.16, loops: true, name: 'Appliance running', ...PDSOUNDS },
  /**
   * ...and seven more of them, because one was eleven machines humming the same
   * note.
   *
   * Every appliance in the game is a VARIANT of one `station` row, so for as
   * long as a sound could only be named on the piece there was exactly one
   * kitchen noise however many machines you owned — and pitching one file apart
   * per variant (`sfxShape.rate`, which is still what separates the ones that
   * share a file below) makes eleven notes rather than eleven machines. A
   * blender is not a deep fryer played fast.
   *
   * They are named for the NOISE and never for the appliance — `pump`, not
   * `coffee-machine` — because a variant names one of these and two variants
   * can want the same noise. A row called `coffee-machine` would be a sound
   * nothing but the coffee machine could ever politely use, which is how a
   * shared library turns into eleven near-duplicates.
   *
   * All seven come out of one CC0 pack (rubberduck's *30 CC0 SFX loops*), which
   * is worth knowing for the reason the licence note at the top of this file
   * gives: one pack, one credit line, one thing to check. `machine` came out of
   * it too until its length disqualified it.
   *
   * THE GAINS ARE ALL 0.16 AND THAT IS A STARTING POINT RATHER THAN A MIX.
   * It is what `machine` was tuned to by ear, and these are its packmates at
   * roughly its normalisation — but a bath of boiling oil and a small motor are
   * not the same loudness in the file any more than they are in a kitchen. The
   * Menu's Sound rows play each of these on press, which is where to fix it,
   * and the note on `machine` above is the argument: with a loop, start here
   * and go DOWN.
   */
  { id: 'pump', url: pump, gain: 0.16, loops: true, name: 'Pump', ...RUBBERDUCK },
  { id: 'boil', url: boil, gain: 0.16, loops: true, name: 'Boiling', ...RUBBERDUCK },
  // 0.62s, and therefore the one row left carrying the fault `machine` was
  // replaced for — the blender names it at 1.25, which repeats it twice a
  // second. Left alone deliberately rather than overlooked: a fast little motor
  // is the one appliance where a rapid pulse is arguably the sound, and it is
  // the *slow* wobble on a deep drone that reads as broken. Judge it by ear off
  // the Menu's Sound rows before deciding.
  { id: 'motor-fast', url: motorFast, gain: 0.16, loops: true, name: 'Fast motor', ...RUBBERDUCK },
  { id: 'motor-heavy', url: motorHeavy, gain: 0.16, loops: true, name: 'Heavy motor', ...RUBBERDUCK },
  { id: 'compressor', url: compressor, gain: 0.16, loops: true, name: 'Compressor', ...RUBBERDUCK },
  { id: 'element', url: element, gain: 0.16, loops: true, name: 'Heating element', ...RUBBERDUCK },
  { id: 'extractor', url: extractor, gain: 0.16, loops: true, name: 'Extractor fan', ...RUBBERDUCK },
  // The one loop from outside that pack, and the only appliance noise that is
  // not a machine at all: an oven under the broiler is a fire, and a motor
  // pitched down is a motor pitched down. Crackle rather than roar because a
  // roar is what a shop full of them would become — this one has gaps in it.
  { id: 'sizzle', url: sizzle, gain: 0.16, loops: true, name: 'Broiling', ...ANTUMDELUGE },
];

/**
 * The playlist. Order is the order they play in — see `music.js`, which walks
 * it rather than shuffling, because a shuffle that can repeat a track reads as
 * the playlist being broken and one that cannot is a shuffle in name only.
 */
export const TRACKS = [
  { id: 'mall', url: mall, name: 'Mall', ...KOMIKU },
  { id: 'chillin', url: chillin, name: 'Chillin Poupi', ...KOMIKU },
  { id: 'home', url: home, name: 'Home', ...KOMIKU },
  { id: 'suburb', url: suburb, name: 'Suburb', ...KOMIKU },
  { id: 'valley', url: valley, name: 'Chocolate Valley', ...KOMIKU },
  { id: 'beach', url: beach, name: 'Beach', ...KOMIKU },
  { id: 'school', url: school, name: 'School', ...KOMIKU },
  { id: 'mushrooms', url: mushrooms, name: 'Mushrooms', ...KOMIKU },
  { id: 'glouglou', url: glouglou, name: 'Glouglou', ...KOMIKU },
  { id: 'bicycle', url: bicycle, name: 'Bicycle', ...KOMIKU },
  { id: 'strawberry', url: strawberry, name: 'The Strawberry', ...KOMIKU },
  { id: 'horizon', url: horizon, name: 'The Horizon', ...KOMIKU },
  { id: 'seashell', url: seashell, name: 'Night in a Seashell', ...KOMIKU },
  { id: 'care', url: care, name: 'CARE', ...MONPLAISIR },
  { id: 'hop', url: hop, name: 'Hop', ...MONPLAISIR },
];

export const soundById = (id) => SOUNDS.find((s) => s.id === id) ?? null;

/** Everything that needs crediting, sounds and music alike, for the tab. */
export const CREDITS = [...SOUNDS, ...TRACKS];
