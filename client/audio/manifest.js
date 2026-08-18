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
  { id: 'milestone', url: milestone, gain: 0.7, name: 'Milestone chime', ...KENNEY },
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
