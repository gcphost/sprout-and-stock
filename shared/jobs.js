/**
 * WHAT A HIRE'S DAY ADDS UP TO.
 *
 * A weight has always been *relative*: `stepStaff` draws from the list in
 * proportion, so `serve 10, tidy 1` and `serve 100, tidy 10` are the same
 * worker, and the absolute size of the numbers meant nothing at all. Which is
 * exactly why nothing stopped you setting every directive to ten — it read as
 * "do everything, hard", and it cost the same as doing one thing. A roster of
 * generalists is a shop with no decision in it: two of somebody is only
 * interesting while they can be told *different* things, and specialising has
 * to cost you the thing you gave up.
 *
 * So the total is a budget now, and the ladder is what buys more of it. That is
 * the second thing a rung sells which is not a multiplier (`unattended` on a
 * till was the first), and it is the one you can see: a promotion is more of
 * their day, not just a faster walk.
 *
 * Imported by BOTH ends, the way `shared/build.js` is. The menu greys the `+`
 * and the server refuses the list — reimplement either half and you get the
 * green-ghost bug wearing a stepper: a button that offers a weight the shop
 * hands straight back.
 */

/** What a hire on the bottom rung has to spend across their directives. */
export const JOB_POINTS = 20;

/** ...and what every rung above it adds. */
export const JOB_POINTS_PER_RUNG = 8;

/** What a list of `{ job, weight }` comes to. */
export const jobsTotal = (jobs) => (jobs ?? [])
  .reduce((n, j) => n + (Number(j?.weight) || 0), 0);

/**
 * What this hire is allowed to spend, all in.
 *
 * The flat rule, or what their KIND was authored with, whichever is larger —
 * and the second half is not a nicety. Authored lists run from 11 (clerk) to 33
 * (farmhand) today, because until this file existed those numbers were ratios
 * and nobody was choosing a total. A flat cap below the biggest of them hands
 * you a farmhand who is over budget on the day you hire them, whose first
 * available move is to take something away — which reads as the hire being
 * broken rather than as a rule being applied. Read as a floor instead, every
 * authored kind arrives exactly as authored and the cap only ever hands a
 * generalist a spare point or two.
 *
 * It also leaves the lever where content already is: a kind authored heavy is a
 * kind that does more, at whatever wage it was authored with, and `simulate` is
 * the thing that says whether that was a good idea.
 */
export function jobBudget(kind, tier) {
  const rungs = kind?.tiers?.length ?? 1;
  const at = Math.min(Math.max(1, Math.trunc(Number(tier) || 1)), Math.max(1, rungs));
  const floor = Math.ceil(jobsTotal(kind?.jobs));
  return Math.max(floor, JOB_POINTS) + JOB_POINTS_PER_RUNG * (at - 1);
}

/**
 * May this list be given to somebody currently on `was`?
 *
 * Over budget is a state you can be IN and never a state you can move further
 * into. That is what makes rolling firmware back safe: `demote` drops the
 * allowance and deliberately does not touch the list, so somebody promoted and
 * then rolled back is carrying more than they are allowed until you trim them —
 * rather than having their shift silently rewritten by the server, which is the
 * one outcome nobody would connect to the button they pressed.
 */
export function jobsAffordable(kind, tier, jobs, was) {
  const total = jobsTotal(jobs);
  return total <= Math.max(jobBudget(kind, tier), jobsTotal(was));
}
