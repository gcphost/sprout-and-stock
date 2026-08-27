/**
 * HOW MANY PEOPLE ARE PLAYING, AND FOR HOW LONG.
 *
 * Google Analytics 4, and nothing else — see docs/analytics.md for why this one
 * and what it cannot tell you.
 *
 * IT IS OPTIONAL, the same way the broker is: `VITE_SNS_GA` unset means no
 * script is fetched, no cookie is written and `track` is a function that
 * returns. So `npm run dev` measures nothing, a fork measures nothing, and the
 * only build that reports anything is one whose `.env` names a property. That
 * is a decision rather than caution — a dev server and a tunnel handed to one
 * person are the two things that would otherwise pollute the numbers most,
 * because they are the sessions where somebody plays for an hour on purpose.
 */

const ID = import.meta.env.VITE_SNS_GA ?? '';

/** Whether there is anything to switch on — see `switchRows` in sections.js. */
export const haveStats = () => !!ID;

const CHOICE = 'sns-stats';

const read = (k, fallback = null) => {
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/**
 * WHERE SAYING NOTHING HAS TO MEAN NO.
 *
 * Read off the browser's own timezone rather than an IP lookup, which is the
 * only way to answer this without a server and without telling a third party
 * about somebody in order to decide whether they may be told about. It is
 * approximate on purpose and the inaccuracy is deliberately one-sided:
 * `Europe/` also catches Moscow, Istanbul and Kyiv, none of which are the EEA,
 * and over-including costs those players a switch they can turn on while
 * under-including would be the one mistake that matters.
 *
 * The strays are the EEA members a `Europe/` prefix misses — Iceland, the
 * Atlantic islands that are Spain and Portugal, and both halves of Cyprus.
 */
const STRAYS = new Set([
  'Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores',
  'Asia/Nicosia', 'Asia/Famagusta',
]);

function mustAsk() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    return zone.startsWith('Europe/') || STRAYS.has(zone);
  } catch {
    // No timezone to read is not a reason to assume the permissive answer.
    return true;
  }
}

let choice = read(CHOICE);

/**
 * Whether full analytics are on for this browser right now.
 *
 * Three states rather than two, and the third is the whole of the consent
 * design: an untouched browser is granted outside the EEA and denied inside it,
 * and once somebody has actually said, what they said wins in both directions —
 * so turning it off in Ohio sticks, and turning it on in Berlin sticks.
 */
export const statsOn = () => (choice ? choice === 'yes' : !mustAsk());

/**
 * How often to say "still here", in ms.
 *
 * GA4 measures engagement time on its own, and for an ordinary page that is
 * enough. A game is not an ordinary page: a session ends after 30 minutes with
 * no events on it, and somebody watching their shop trade sends no events at
 * all — so a long quiet session would be cut into pieces, and the one number
 * being asked for here is exactly the one that would be wrong. A minute is far
 * inside that window and costs 60 events an hour.
 */
const TICK_MS = 60_000;

/**
 * Only while the tab is in front.
 *
 * A game left open in a background tab is not somebody playing, and counting it
 * turns "how long do people play" into "how long do people leave the tab open",
 * which are different questions with wildly different answers. Browsers throttle
 * a background interval to about this period anyway, so the check is what makes
 * the measurement honest rather than what makes it cheap.
 */
const watching = () => document.visibilityState === 'visible';

let send = () => {};
let minutes = 0;
let ticking = null;

if (ID) {
  window.dataLayer ??= [];
  // The arguments object, verbatim and not an array — gtag.js reads `arguments`
  // off each queued call, so a rest parameter spread into a real array arrives
  // as one argument that is a list and nothing is recorded.
  send = function gtag() { window.dataLayer.push(arguments); };

  /**
   * CONSENT MODE, AND IT HAS TO BE THE FIRST THING SAID.
   *
   * Before `js` and before `config`, or the tag has already decided what it may
   * store by the time it is told — which is the one way to get this wrong that
   * still reports numbers, so nothing looks broken and the cookie is written
   * anyway.
   *
   * Denied means gtag sends *cookieless* pings: no identifier is stored, and
   * what comes back is modelled counts rather than people. That is the whole
   * reason the script loads for somebody who has not consented — the
   * alternative is loading nothing, which is stricter and hands back no EEA
   * data at all. See the consent section of docs/analytics.md, which records
   * that this was a choice and what it costs.
   *
   * The three ad fields are hardcoded denied and are not wired to the switch.
   * This game runs no ads and has nothing to remarket to anybody, so they are
   * not a decision the player should be asked to make — but Consent Mode v2
   * requires them to be *declared*, and an omitted field is not a denied one.
   */
  send('consent', 'default', {
    analytics_storage: statsOn() ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });

  send('js', new Date());
  send('config', ID);

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ID)}`;
  document.head.append(tag);
}

/**
 * The switch, for the Menu tile that draws it.
 *
 * It takes effect on the press rather than on the next load: an update is a
 * message to a tag that is already running, so somebody who turns this off is
 * not tracked from that moment, and somebody who turns it on does not have to
 * be told to reload. A switch whose effect waited for a restart is the same
 * dead press as a tier that changes no number.
 */
export function setStats(on) {
  choice = on ? 'yes' : 'no';
  write(CHOICE, choice);
  send('consent', 'update', { analytics_storage: on ? 'granted' : 'denied' });
}

/** One thing that happened. A no-op when nothing is configured. */
export function track(name, params) {
  send('event', name, params);
}

/**
 * The shop is up — start counting.
 *
 * `mode` is which of the two ways in this was: your own save, or somebody
 * else's over a data channel. It is the only way to tell whether co-op is used
 * at all, since a guest never touches a world of their own and so is invisible
 * to everything else the game records.
 */
export function shopOpen(mode) {
  if (!ID) return;
  track('shop_open', { mode });
  ticking ??= setInterval(() => {
    if (!watching()) return;
    minutes += 1;
    track('play_tick', { minutes });
  }, TICK_MS);
}
