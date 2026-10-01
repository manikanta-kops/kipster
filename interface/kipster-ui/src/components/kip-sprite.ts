/*
 * Kip's pixels, the one source for every drawing of Kip in the app.
 * W body, S wing and tail, R comb and wattle, Y beak and feet, K the eye (unlit).
 */

/** Kip in profile from comb to belly; poses add their own legs. */
export const kipTorso = [
  '.........RR..',
  '........RRRR.',
  '.SS.....WWWW.',
  '.SWS...WWWKWY',
  '.SWWS..WWWWR.',
  '..SWWWWWWWWR.',
  '..WWWWSSSWW..',
  '...WWWSSWWW..',
  '....WWWWWW...',
]

/** Kip standing: the app icon and the full-body mark. */
export const kipStanding = [...kipTorso, '......Y.Y....', '.....YY.YY...']

/** Kip's head, cropped from the standing pose, for small marks. */
export const kipHead = kipStanding.slice(0, 7).map((row) => row.slice(6))
