// The robot on its own: it picks somewhere else in view, walks there as a trip does (slowly, with
// no path drawn), stands a moment, and picks again. So it goes from line to line and from one
// paragraph or Work entry to another, rather than pacing the piece of line it stands on. Pure.
import { MAX_HOP_DY, walkerReach, type Terrain } from '../robot/walker.ts'
import type { Start } from '../terrain/planner.ts'
import type { Rect } from '../terrain/terrain.ts'
import { planTrip, type Plan, type RouteChecks } from './trip.ts'

/** Body lengths a leg goes at least, as the crow flies. */
export const MIN_LEG = 3
/** Seconds it stands between legs, least and most. */
export const REST_S: readonly [number, number] = [0.4, 1.2]
/** The chance a leg goes anywhere in view, rather than strolling along the lines next to it. */
export const MOVE_ON = 0.25
const AHEAD = 3 // how much likelier a spot the way it faces is than one behind it
const TRIES = 6 // spots tried for a leg before giving up for now
const PAD = 8 // px the robot keeps inside the view's edges

/** Where on surface s (at height y) a leg may end: body-centre x from x0 to x1, page px. */
interface Span { s: number; y: number; x0: number; x1: number }

/** How long it stands before the next leg, given a random number in [0, 1). */
export function restFor(random: () => number): number {
  return REST_S[0] + random() * (REST_S[1] - REST_S[0])
}

/**
 * A leg from `from` to a spot in `view` (page px), as a trip there would go: a standable spot
 * where the robot shows whole, at least MIN_LEG away, on a route the trip checks allow. Mostly
 * a stroll to a line a step up or down, now and then anywhere in view (MOVE_ON, or always with
 * no line a step away). Spots on long lines are likelier than on short pieces, so it walks rather
 * than hops where it can, and spots the way it faces than behind it, so it keeps going. Null if
 * no spot tried works (try again later).
 */
export function pickLeg(t: Terrain, from: Start, view: Rect, checks: RouteChecks, random: () => number): Plan | null {
  const height = walkerReach().height * t.scale
  const fromY = t.surfaces[from.surface]!.y
  const min = MIN_LEG * t.scale
  const far = (surface: number, x: number) => Math.hypot(x - from.x, t.surfaces[surface]!.y - fromY) >= min - 0.5
  // where on each standable surface in view the robot's body centre may go, and is far enough
  const spans: Span[] = []
  for (const s of t.surfaces) {
    if (!s.standable || s.y - height < view.y0 + PAD || s.y > view.y1 - PAD) continue
    const x0 = Math.max(s.x0, view.x0 + checks.half + PAD)
    const x1 = Math.min(s.x1, view.x1 - checks.half - PAD)
    const dy = Math.abs(s.y - fromY)
    const near = dy < min ? Math.sqrt(min * min - dy * dy) : 0 // x within this of from.x is too close
    const parts = near > 0 ? [[x0, Math.min(x1, from.x - near)], [Math.max(x0, from.x + near), x1]] : [[x0, x1]]
    for (const [a, b] of parts) if (a! <= b!) spans.push({ s: s.id, y: s.y, x0: a!, x1: b! })
  }
  if (spans.length === 0) return null
  // mostly a stroll, to a line a step up or down; now and then (or with no such line) anywhere in view
  const step = MAX_HOP_DY * t.scale
  const stroll = spans.filter((c) => c.y !== fromY && Math.abs(c.y - fromY) <= step)
  const pools = random() < MOVE_ON || stroll.length === 0 ? [spans] : [stroll, spans]
  const ahead = (c: Span) => from.facing !== undefined && Math.sign((c.x0 + c.x1) / 2 - from.x) === from.facing
  for (const pool of pools) {
    const weight = (c: Span) => (c.x1 - c.x0 + t.scale) * (ahead(c) ? AHEAD : 1)
    const total = pool.reduce((a, c) => a + weight(c), 0)
    for (let i = 0; i < TRIES / pools.length; i++) {
      let r = random() * total
      const c = pool.find((c) => (r -= weight(c)) < 0) ?? pool.at(-1)!
      const plan = planTrip(t, from, c.x0 + random() * (c.x1 - c.x0), c.y, checks)
      // it goes to the reachable spot nearest the one picked: only if that is far enough and in view too
      if (!plan || plan.moves.length === 0 || !far(plan.to.surface, plan.to.x)) continue
      if (!spans.some((d) => d.s === plan.to.surface && plan.to.x >= d.x0 - 0.5 && plan.to.x <= d.x1 + 0.5)) continue
      return plan
    }
  }
  return null
}
