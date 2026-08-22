/**
 * THE OUTBOUND LINKS — every URL in this game that leaves it.
 *
 * One file for what is currently one link, and the reason is the reason every
 * other "one spelling of a thing" in here exists: the front door and the Menu
 * both offer it, they are rendered by two modules that share nothing else, and
 * a donate link that is right in one place and stale in the other is a page
 * somebody lands on with an apology on it. `countKey` and `FIXTURE_REFUND` are
 * the same argument about smaller things.
 *
 * Anything added here opens in a new tab and must never be reachable from a
 * press that could be mistaken for a game action — see `openLink`.
 */

/** Where the money goes, if anybody feels like it. */
export const SUPPORT_URL = 'https://buymeacoffee.com/sprocket.n.stock';

/**
 * THE WORDING, and what it is not.
 *
 * It is **not "buy me a coffee"**, which is what the donation platform calls
 * itself and is wrong here twice over. There is no "me": this shop was built by
 * two people, the game never speaks in the first person anywhere else, and a
 * button that suddenly does reads as somebody's side project asking for beer
 * money rather than as a way to back the thing you are playing. And the coffee
 * is the platform's metaphor, not ours — it says nothing about where the money
 * goes, and a drink is not a thing this shop even sells.
 *
 * It is also **not an imperative**. "Support the game" is a thing being asked of
 * you, on a screen you opened to press something else, and a button that tells
 * you to do something is one you have to decline. This is a condition instead:
 * it names the only case in which the rest of the sentence is any of your
 * business, and if it does not apply you have already finished reading. The
 * link is what completes it, which is why it does not need a verb of its own.
 *
 * "The game" rather than "the devs", as before — it is the shop somebody is
 * standing in that they might like, and who banked it is not the interesting
 * half.
 */
export const SUPPORT_LABEL = 'If you like the game';

/**
 * THERE IS NO STANDING CAPTION, and that is the decision rather than an
 * omission — anything added back here is a second sentence about money on a
 * screen somebody opened to do something else.
 *
 * There was one ("Free to play. The crew work for free. The next aisle
 * doesn't."), it was a joke about the game's own robots, and it was cut. What
 * is wrong with it is not the wording, it is that a pitch under a link is a
 * pitch: the label already says the whole thing, the press is one tap, and the
 * only work a caption underneath can do is *argue*. Nobody reading a menu row
 * wants to be argued with, and a line long enough to make the case is a
 * paragraph lying across a 214px panel — which is the complaint that moved this
 * off the front door in the first place.
 *
 * It also does NOT warm up as somebody plays, and that was tried before it was
 * cut. A line that changes on a screen you are looking at to press something
 * else moves for no reason you can see. The place a game is allowed to notice
 * how long you have stayed is the place it is ALREADY stopping to say so, which
 * is the award card — see `awardSupport` below, and note that it is three rungs
 * out of forty-five.
 */

/**
 * The ask on the award card, keyed to the rung that fired it.
 *
 * This is the tip jar's one moving part, and the argument for it is the one
 * docs/progress.md makes for the card existing at all: the world has already
 * stopped, you have already been congratulated, and it is the single moment in
 * the game where a line about having stuck with it is the subject rather than
 * an interruption. Every other placement is a donate ask arriving mid-shop.
 *
 * THREE RUNGS, and it is the emptiness of this table that makes it work:
 * `server/sim/goals.js` has forty-five rungs and six that measure the DAY, and
 * an ask on all six is a nag with a medal on it. Weeks one, two and three get
 * nothing — somebody a fortnight in is still deciding — so the first time this
 * is ever said is a month, and it is said three times in a year of play.
 *
 * Keyed by rung ID rather than by a day threshold on purpose. The day rungs
 * already ARE the intervals somebody chose, so a second set of numbers here
 * could silently disagree with them the first time one is retuned — the same
 * argument `countKey` and `foldJobs` make about one spelling of a thing. A rung
 * that is not in this table simply has no ask, which is the default and is why
 * adding a milestone can never accidentally add one.
 */
const AWARD_SUPPORT = {
  'month-one': 'A month of this, and it cost you nothing. Fancy funding the next bit?',
  'hundred-days': 'A hundred days. This game is free — chip in and it keeps growing.',
  'year-one': 'A year in the shop. Whatever this is worth to you, that is the price.',
};

/** The line for a milestone, or null for the forty-two that do not ask. */
export function awardSupport(goalId) {
  return AWARD_SUPPORT[goalId] ?? null;
}

/**
 * Open one, safely.
 *
 * `noopener` is not optional and is easy to leave off: without it the page we
 * open gets a live `window.opener` handle back into the game's own tab, which
 * is a tab holding an unsaved shop. `noreferrer` goes with it because the two
 * are one habit, and a menu row is not a referral.
 *
 * A popup blocker can refuse this and there is nothing useful to do about it —
 * it only ever fires from a real click, which is the case blockers allow.
 */
export function openLink(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
