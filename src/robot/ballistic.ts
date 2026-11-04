// A hop that never rises above the higher of its two lines, as a ballistic flight: going down,
// it steps off level and falls; going up, it leaps so that the top of its arc is the landing,
// arriving with no vertical speed. For where a role line sits just above the line it leaves or
// lands on (a Work blurb's first line), which the usual hop's arc would rise into.
// Page px and seconds, y down; lift in body lengths (for the pose). Pure.

/** Gravity, body lengths/s²: about a third of a real robot's at this size, for the site's calm pace. */
export const BALLISTIC_G = 6
/** Body lengths/s: the fastest such a flight goes sideways. */
export const NO_RISE_VX = 4
/** s: the shortest such a flight takes, however little it drops (a hop, never a flash). */
export const NO_RISE_MIN_S = 0.2
const TUCK = 0.1 // body lengths the feet draw up in flight
const GATHER = 0.12 // s over which they draw up after take-off and stretch down again to land

export interface MotionPoint {
  x: number
  y: number
  facing: 1 | -1
  /** Body lengths the feet are drawn up. */
  lift: number
}

export interface Motion {
  dur: number
  at(time: number): MotionPoint
}

const smooth = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v))

/**
 * The flight from (x0, y0) to (x1, y1), page px, for a robot `scale` px long facing `facing`
 * (kept if it goes straight up or down). It takes as long as its drop under BALLISTIC_G, but no
 * less than NO_RISE_MIN_S and no faster sideways than NO_RISE_VX; where that makes it longer,
 * it keeps its shape (level at the higher line) under a gentler gravity, so it is still one
 * parabola and never rises above the higher line.
 */
export function noRiseMotion(x0: number, y0: number, x1: number, y1: number, scale: number, facing: 1 | -1): Motion {
  const dy = y1 - y0
  const dur = Math.max(Math.sqrt((2 * Math.abs(dy)) / (BALLISTIC_G * scale)), Math.abs(x1 - x0) / (NO_RISE_VX * scale), NO_RISE_MIN_S)
  const g = (2 * Math.abs(dy)) / (dur * dur) // BALLISTIC_G * scale, or gentler for a longer flight
  const f = (Math.sign(x1 - x0) || facing) as 1 | -1
  return {
    dur,
    at(time) {
      const s = Math.min(Math.max(time, 0), dur)
      const x = x0 + ((x1 - x0) * s) / dur
      // down: level at take-off, then falling; up: launched at g·dur, so its top is the landing
      const y = dy >= 0 ? y0 + 0.5 * g * s * s : y0 - g * dur * s + 0.5 * g * s * s
      return { x, y, facing: f, lift: TUCK * smooth(s / GATHER) * smooth((dur - s) / GATHER) }
    },
  }
}
