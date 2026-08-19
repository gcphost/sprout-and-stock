/**
 * Which grammar the shop is being played with.
 *
 * One question, asked by three things that have to agree about it: what a tap
 * DOES (`tapAtPointer` in main.js), what the pill OFFERS (`pressHints`), and
 * what the tour SAYS (client/tutor.js). Two of those could live together; the
 * third is why this is a file. ui.js imports sections.js, sections.js imports
 * tutor.js, so a test kept in ui.js and read by the tour closes a cycle — it
 * would work, because nothing calls it at module scope, and it would be a cycle
 * nobody meant that the next import turns into a real one.
 *
 * The test is the WIDTH and not `pointer: coarse`, and it is the same query the
 * pill's rows use for their `pointer-events` in index.html. Those are two halves
 * of one decision: a tap may only stop being a verb where the pill is pressable,
 * or the verbs have left the world and landed nowhere. And a phone in a desktop
 * browser's device emulation is where this actually gets tested — it does not
 * reliably report a coarse pointer.
 */
export const pillDrives = () => matchMedia('(max-width: 640px)').matches;
