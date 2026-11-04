// A trip to where the visitor clicked: planned over the hops the text can part around, checked
// move by move before it starts, then walked and hopped frame by frame. Pure.
import { initGait, poseFromGait, stepGait, turnGait, TURN_MARGIN, WANDER_SPEED } from '../robot/gait.ts'
import type { Vec2 } from '../robot/model.ts'
import { FAR_HOP_DX, flightSide, hopPath, makeHop, makeNoRiseHop, MAX_HOP_DY, walkerAt, type Hop, type Terrain, type Walker } from '../robot/walker.ts'
import { nearestReachable, type HopFilter, type Limits, type Move, type Start } from '../terrain/planner.ts'
import type { Rect, TerrainPoint } from '../terrain/terrain.ts'
import { pathLength, pathPolyline, type HopMove } from './path-overlay.ts'

/** Beyond this much path still to go (px) a trip speeds up, to twice wander speed at twice this. */
export const LONG_TRIP_PX = 600
/**
 * The longest jump up or down (px): a section gap (the bio to Work is about 250px, more on a
 * tall phone), as one ballistic leap. It is page layout, so px rather than body lengths. Jumps
 * join paragraphs or Work entries; a jump never passes a line it could stand on beneath its
 * path (see planTrip), so within a paragraph the robot steps line by line.
 */
export const MAX_JUMP_PX = 320
/** Body lengths a step or jump between overlapping lines moves along as it goes up or down, so it arcs. */
export const STRIDE = 0.4

/** What a route must pass before the robot sets off, and the text it must keep clear of. */
export interface RouteChecks {
  /** Whether the painted text parts cleanly around the robot all along a hop's path. */
  hop(h: Hop): boolean
  /** Whether the robot can walk along `surface` between ground x0 and x1 with the text parting cleanly. */
  walk(surface: number, x0: number, x1: number): boolean
  /** Glyph boxes of the text that does not part (headings, titles, role and date lines, links), page px. */
  fixed: Rect[]
  /** The robot's reach to either side of its body centre, px. */
  half: number
}

/**
 * The exchange rate between walking and passing behind text that does not part (headings,
 * titles, role and date lines, links; style.css keeps it in front of the robot): a trip walks at
 * most this many px out of its way, there and back, for each ms less it spends with its whole
 * width behind such text. So it takes a clear way or a gap only where one is near, and else
 * crosses from about where it is (a Work entry whose role line spans its column, or a phone,
 * where they all do).
 */
export const CROSSING_PX_PER_MS = 1
const FIXED_PAD = 0.5 // px the robot's silhouette keeps from fixed text (it stands 1.2px under a role line)
const SAMPLES = 48

/** How long a hop keeps the robot behind text that does not part, and what that costs the planner. */
export interface Behind {
  /** ms with any of its silhouette (within FIXED_PAD) over fixed text's glyph boxes. */
  ms: number
  /** Those ms each weighted by the share of the silhouette's width the glyph boxes cover, times CROSSING_PX_PER_MS: px of walking. */
  cost: number
}

/**
 * How long hop h keeps the robot behind the fixed text, swept over SAMPLES stretches of its
 * flight. The silhouette is the robot's own in flight (flightSide(), the way it flies; either
 * way if straight up or down) from its feet to its full height. The cost grows with how much of
 * its width the words cover, so of two crossings the one nearer a gap's middle costs less, and
 * a hop clear of them costs nothing.
 */
export function behindText(h: Hop, t: Terrain, checks: RouteChecks): Behind {
  const path = hopPath(h, t, SAMPLES)
  const { back, front } = flightSide()
  const either = Math.max(back, front)
  const dir = Math.sign(h.to.x - h.from.x) // the way it faces in flight
  const left = (dir > 0 ? back : dir < 0 ? front : either) * t.scale + FIXED_PAD // px it reaches left of its ground point
  const right = (dir > 0 ? front : dir < 0 ? back : either) * t.scale + FIXED_PAD
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const p of path) [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.top), Math.max(y1, p.bottom)]
  const near = checks.fixed.filter((r) => r.x1 > x0 - left && r.x0 < x1 + right && r.y1 > y0 - FIXED_PAD && r.y0 < y1 + FIXED_PAD)
  const out: Behind = { ms: 0, cost: 0 }
  if (near.length === 0) return out
  const dt = (h.dur * 1000) / SAMPLES
  const spans: [number, number][] = []
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!
    const q = path[i]!
    const b = { x0: Math.min(p.x, q.x) - left, x1: Math.max(p.x, q.x) + right, y0: Math.min(p.top, q.top) - FIXED_PAD, y1: Math.max(p.bottom, q.bottom) + FIXED_PAD }
    spans.length = 0
    for (const r of near) if (r.x1 > b.x0 && r.x0 < b.x1 && r.y1 > b.y0 && r.y0 < b.y1) spans.push([Math.max(r.x0, b.x0), Math.min(r.x1, b.x1)])
    if (spans.length === 0) continue
    out.ms += dt
    out.cost += (dt * covered(spans)) / (b.x1 - b.x0)
  }
  out.cost *= CROSSING_PX_PER_MS
  return out
}

/** Length of the union of the spans (sorts them). */
function covered(spans: [number, number][]): number {
  spans.sort((a, b) => a[0] - b[0])
  let n = 0
  let end = -Infinity
  for (const [a, b] of spans)
    if (b > end) {
      n += b - Math.max(a, end)
      end = b
    }
  return n
}

export const crossesFixed = (h: Hop, t: Terrain, checks: RouteChecks) => behindText(h, t, checks).ms > 0

/**
 * How the robot gets from a to b by a hop, and at what extra cost (px of walking, for the
 * planner): on its arc if the painted text parts around it and it keeps clear of the fixed text
 * (free); else by a flight that never rises above the higher line (a role line sits 1.2px over
 * a Work blurb's first line; free); else, the painted text still parting, by whichever of the
 * two costs less behind the fixed text (behindText). Null if the painted text can't part.
 */
export function shapeHop(t: Terrain, a: TerrainPoint, b: TerrainPoint, checks: RouteChecks): { hop: Hop; cost: number } | null {
  let best: { hop: Hop; cost: number } | null = null
  for (const h of [makeHop(t, a, b, STAND), makeNoRiseHop(t, a, b, STAND)]) {
    if (!checks.hop(h)) continue
    const { cost } = behindText(h, t, checks)
    if (cost === 0) return { hop: h, cost: 0 }
    if (!best || cost < best.cost) best = { hop: h, cost }
  }
  return best
}

/** Steps as the wander's hops (a line or a paragraph gap), leaps as its furthest, jumps across a section gap. */
export function tripLimits(scale: number): Limits {
  return { maxStep: MAX_HOP_DY * scale, maxLeap: FAR_HOP_DX * scale, maxJump: MAX_JUMP_PX, stride: STRIDE * scale }
}

const EPS = 0.5 // px a route's points may be off a surface's ends or each other by rounding
const STAND = poseFromGait(initGait(0, 1)) // any take-off pose: a hop's path doesn't depend on it

/**
 * Whether every move of `moves` from `from` is clear: each walk stays on the standable piece
 * it starts on (a piece is a run where the lines above part cleanly) and passes `checks.walk`,
 * and each hop starts where the robot is, lands on a standable piece and has a shape (shapeHop)
 * the painted text parts around all along. The planner's hops do not look at the text, so a
 * route is checked before the robot sets off.
 */
export function routeClear(t: Terrain, from: TerrainPoint, moves: Move[], checks: RouteChecks): boolean {
  const on = (p: TerrainPoint) => {
    const s = t.surfaces[p.surface]
    return !!s?.standable && p.x >= s.x0 - EPS && p.x <= s.x1 + EPS
  }
  if (!on(from)) return false
  let at = from
  for (const m of moves) {
    if (m.kind === 'walk') {
      const to = { surface: m.surface, x: m.toX }
      if (m.surface !== at.surface || !on(to) || !checks.walk(m.surface, Math.min(at.x, m.toX), Math.max(at.x, m.toX))) return false
      at = to
    } else {
      if (m.from.surface !== at.surface || Math.abs(m.from.x - at.x) > EPS || !on(m.to)) return false
      if (!shapeHop(t, m.from, m.to, checks)) return false
      at = m.to
    }
  }
  return true
}

const MAX_FALLBACKS = 8

/** A planned trip: its target, its moves, and for each hop move how it flies (null for a walk). */
export interface Plan { to: TerrainPoint; moves: Move[]; hops: (Hop | null)[] }

/**
 * The trip to the reachable point nearest page (x, y). The planner may only use hops shapeHop
 * finds a shape for, priced by their time behind fixed text (behindText: it walks out of its
 * way to avoid that at no more than CROSSING_PX_PER_MS), and a step or jump never passes a line
 * the robot could stand on there (no skipping lines; a leap joins neighbouring lines anyway; a
 * line that ends before the hop's spot is not passed). If the route still fails routeClear, the
 * next nearest reachable target is tried, a few times. Null: no route (the robot stands
 * nowhere, or nothing passes). `moves: []`: it is there already.
 */
export function planTrip(t: Terrain, from: Start, x: number, y: number, checks: RouteChecks): Plan | null {
  const standable = t.surfaces.filter((s) => s.standable)
  /** The hop from a to b, as the trip may make it, or null. */
  const shape = (kind: HopMove['kind'], a: TerrainPoint, b: TerrainPoint) => {
    const ya = t.surfaces[a.surface]!.y
    const yb = t.surfaces[b.surface]!.y
    const [lo, hi] = [Math.min(ya, yb) + EPS, Math.max(ya, yb) - EPS]
    const [x0, x1] = [Math.min(a.x, b.x) - checks.half, Math.max(a.x, b.x) + checks.half]
    if (kind !== 'leap' && standable.some((s) => s.y > lo && s.y < hi && s.x1 > x0 && s.x0 < x1)) return null
    return shapeHop(t, a, b, checks)
  }
  const allow: HopFilter = (kind, a, b) => shape(kind, a, b)?.cost ?? false
  let surfaces = t.surfaces
  for (let n = 0; n <= MAX_FALLBACKS; n++) {
    const r = nearestReachable(surfaces, from, x, y, tripLimits(t.scale), allow)
    if (!r) return null
    if (routeClear(t, from, r.moves, checks))
      return { ...r, hops: r.moves.map((m) => (m.kind === 'walk' ? null : shape(m.kind, m.from, m.to)!.hop)) }
    surfaces = surfaces.map((s) => (s.id === r.to.surface ? { ...s, standable: false } : s)) // the next nearest
  }
  return null
}

/** A planned trip and the next of its moves to make. */
export interface Trip extends Plan { i: number }

/** Where a trip from `w` starts, and the way it faces there: where it stands, or where it lands if it is in the air. */
export function tripStart(w: Walker, t: Terrain): Start {
  if (w.kind === 'walk') return { surface: w.surface, x: w.gait.bodyX * t.scale, facing: w.gait.facing }
  return { ...w.hop.to, facing: walkerAt({ ...w, hop: { ...w.hop, t: 1 } }, t).facing }
}

const smooth = (v: number) => v * v * (3 - 2 * v)

/** Sent somewhere, it walks a bit faster than it wanders (body lengths/s). */
export const TRIP_SPEED = 1.3 * WANDER_SPEED
const TOP_SPEED = 2 * WANDER_SPEED

/** Walking speed (body lengths/s) with `px` of path still to go: trip speed, up to twice wander speed on a long trip. */
export function tripSpeed(px: number): number {
  return TRIP_SPEED + (TOP_SPEED - TRIP_SPEED) * smooth(Math.min(1, Math.max(0, (px - LONG_TRIP_PX) / LONG_TRIP_PX)))
}

const ARC_SAMPLES = 16

/** Ground points of a hop's path between take-off and landing, those after progress `after`. */
export function hopArc(h: Hop, t: Terrain, after = 0): Vec2[] {
  const out: Vec2[] = []
  for (let k = 1; k < ARC_SAMPLES; k++) {
    if (k / ARC_SAMPLES <= after) continue
    const at = walkerAt({ kind: 'hop', hop: { ...h, t: k / ARC_SAMPLES }, facing: 1, vdir: 1 }, t)
    out.push([at.x, at.y])
  }
  return out
}

/** The path still to go (page px), from the robot's ground point: what the dotted overlay draws. */
export function tripPath(trip: Trip, w: Walker, t: Terrain): Vec2[] {
  const shaped = new Map(trip.moves.map((m, i) => [m, trip.hops[i]]))
  const arc = (m: HopMove) => hopArc(shaped.get(m) ?? makeHop(t, m.from, m.to, STAND), t)
  const rest = trip.moves.slice(trip.i)
  const at = walkerAt(w, t)
  if (w.kind === 'walk') return pathPolyline(rest, t.surfaces, { surface: w.surface, x: at.x }, arc)
  return [[at.x, at.y], ...hopArc(w.hop, t, w.hop.t), ...pathPolyline(rest, t.surfaces, w.hop.to, arc)]
}

type WalkWalker = Walker & { kind: 'walk' }
type HopWalker = Walker & { kind: 'hop' }

const SNAP_PX = 0.5 // closer than this to a walk's end, it just stands there (no turning round for nothing)
const SLACK = 0.02 // body lengths past a surface's ends the gait's span reaches, so arriving at an end never turns it

/** Walks w toward toX on its surface for up to dt; returns the time left over once there. */
function walkTo(w: WalkWalker, toX: number, t: Terrain, dt: number, speed: number): { w: WalkWalker; left: number; there: boolean } {
  const s = t.surfaces[w.surface]!
  const target = Math.min(s.x1, Math.max(s.x0, toX)) / t.scale
  let g = w.gait
  const d = target - g.bodyX
  if (Math.abs(d) * t.scale < SNAP_PX) return { w: { ...w, gait: { ...g, bodyX: target } }, left: dt, there: true }
  if (Math.sign(d) !== g.facing) g = turnGait(g)
  const span = { x0: s.x0 / t.scale - TURN_MARGIN - SLACK, x1: s.x1 / t.scale + TURN_MARGIN + SLACK }
  const need = Math.abs(d) / speed
  if (need > dt) return { w: { ...w, gait: stepGait(g, dt, speed, span) }, left: 0, there: false }
  g = stepGait(g, need, speed, span)
  return { w: { ...w, gait: { ...g, bodyX: target } }, left: dt - need, there: true }
}

/** Takes off for a hop move, as planned (`shaped`) or on its arc, facing the way it goes. */
function takeOff(w: WalkWalker, m: HopMove, shaped: Hop | null, t: Terrain): HopWalker {
  let g = w.gait
  const x = g.bodyX * t.scale
  if (Math.abs(m.to.x - x) >= SNAP_PX && Math.sign(m.to.x - x) !== g.facing) g = turnGait(g)
  const hop = shaped ? { ...shaped, t: 0, takeoff: poseFromGait(g) } : makeHop(t, { surface: w.surface, x }, m.to, poseFromGait(g))
  return { kind: 'hop', hop, facing: g.facing, vdir: w.vdir }
}

/** Flies w's hop for up to dt; lands exactly on its target, facing the way it flew. */
function fly(w: HopWalker, t: Terrain, dt: number): { w: Walker; left: number } {
  const need = (1 - w.hop.t) * w.hop.dur
  if (need > dt) return { w: { ...w, hop: { ...w.hop, t: w.hop.t + dt / w.hop.dur } }, left: 0 }
  const { from, to } = w.hop
  const facing = walkerAt({ ...w, hop: { ...w.hop, t: 1 } }, t).facing
  const landed: WalkWalker = { kind: 'walk', surface: to.surface, gait: initGait(to.x / t.scale, facing), vdir: w.vdir, turns: 0, came: from.surface }
  return { w: landed, left: dt - need }
}

/**
 * Advances a trip by dt seconds: a hop in the air lands first, then the moves run in order,
 * walking at tripSpeed and hopping each step, leap and jump on its arc. 'arrived': it stands on
 * the target. 'lost': the robot is not where the next move starts (it was moved), so the trip
 * can't go on. pace: walk at this speed (body lengths/s) instead, however long the trip.
 */
export function stepTrip(trip: Trip, w: Walker, t: Terrain, dt: number, pace?: number): { trip: Trip; walker: Walker; state: 'going' | 'arrived' | 'lost' } {
  const speed = pace ?? tripSpeed(pathLength(tripPath(trip, w, t)))
  let i = trip.i
  let left = dt
  for (let guard = 0; guard <= 2 * trip.moves.length + 2; guard++) {
    if (w.kind === 'hop') {
      const r = fly(w, t, left)
      w = r.w
      left = r.left
      if (w.kind === 'hop') break // still in the air
      continue
    }
    const m = trip.moves[i]
    if (!m) return { trip: { ...trip, i }, walker: w, state: 'arrived' }
    if ((m.kind === 'walk' ? m.surface : m.from.surface) !== w.surface) return { trip: { ...trip, i }, walker: w, state: 'lost' }
    if (m.kind === 'walk') {
      const r = walkTo(w, m.toX, t, left, speed)
      w = r.w
      left = r.left
      if (!r.there) break
    } else w = takeOff(w, m, trip.hops[i] ?? null, t)
    i++
  }
  return { trip: { ...trip, i }, walker: w, state: 'going' }
}
