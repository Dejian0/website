// Reduced motion (prefers-reduced-motion: reduce): the robot never moves on screen. Up to the
// scroll transition's midpoint it shows in the hero as at p = 0, past it standing in the text as
// at p = 1, and a trip puts it at its target at once (main.ts and session.ts). Each change of
// place is a dip: it fades out where it is and back in where it now is, so it is never seen
// between the two, nor in both. Pure.

/** The transition's p from which, with reduced motion, the robot stands in the text rather than the hero. */
export const MIDPOINT = 0.5

/** ms each half of a dip takes, out and then in: 160ms in all (the spec allows 200ms, 400ms for a trip). */
export const DIP_MS = 80

/**
 * One frame of a dip, dt ms on. With somewhere new to show the robot (`pending`) it fades out;
 * `swap` says it is out of sight now, to be moved before it is drawn, and the time left over
 * goes into fading in. With nothing pending it fades (back) in, so a move called off half-way
 * fades back in where it is.
 */
export function dip(opacity: number, pending: boolean, dt: number): { opacity: number; swap: boolean } {
  const d = dt / DIP_MS
  if (!pending) return { opacity: fadeIn(opacity + d), swap: false }
  const left = opacity - d
  return left > EPS ? { opacity: left, swap: false } : { opacity: fadeIn(Math.max(0, -left)), swap: true }
}

const EPS = 1e-9 // frames' steps add up to whole fades despite rounding
const fadeIn = (o: number) => (o >= 1 - EPS ? 1 : o)
