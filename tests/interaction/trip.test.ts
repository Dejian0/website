import { describe, expect, it } from 'vitest'
import {
  behindText,
  crossesFixed,
  CROSSING_PX_PER_MS,
  LONG_TRIP_PX,
  planTrip,
  routeClear,
  shapeHop,
  stepTrip,
  STRIDE,
  tripLimits,
  tripPath,
  tripSpeed,
  tripStart,
  TRIP_SPEED,
  type RouteChecks,
  type Trip,
} from '../../src/interaction/trip.ts'
import { pathLength } from '../../src/interaction/path-overlay.ts'
import { WANDER_SPEED } from '../../src/robot/gait.ts'
import { MODEL, robotFaces } from '../../src/robot/model.ts'
import { bounds, mirrorX, project, SIDE_CAMERA } from '../../src/robot/render.ts'
import { makeHop, makeNoRiseHop, placeWalker, walkerAt, walkerPose, walkerReach, wander, type Hop, type Terrain, type Walker } from '../../src/robot/walker.ts'
import type { Move, Start } from '../../src/terrain/planner.ts'
import type { Rect, Surface } from '../../src/terrain/terrain.ts'

const SCALE = 48
const surf = (id: number, flow: string, line: number, y: number, x0 = 100, x1 = 700, standable = true): Surface => ({
  id,
  flow,
  line,
  x0,
  x1,
  y,
  standable,
})
// three bio paragraphs of one line each (46px apart, so steps), a short line, then a Work line
// far below (a jump) and one the robot can't stand on
const surfaces: Surface[] = [
  surf(0, 'bio-0', 0, 11),
  surf(1, 'bio-1', 0, 57),
  surf(2, 'bio-2', 0, 103),
  surf(3, 'bio-2', 1, 149, 100, 250),
  surf(4, 'work-0', 0, 360),
  surf(5, 'work-0', 1, 384, 100, 700, false),
]
const t: Terrain = { surfaces, scale: SCALE }
const clear: RouteChecks = { hop: () => true, walk: () => true, fixed: [], half: 0.63 * SCALE }
const hopsOf = (m: Move[]) => m.filter((x) => x.kind !== 'walk') as Extract<Move, { from: unknown }>[]

/** The robot's silhouette as drawn (its side view's box, the way it flies), page px, at the hop's progress. */
function silhouetteAt(h: Hop, t: Terrain): Rect {
  const w: Walker = { kind: 'hop', hop: h, facing: (Math.sign(h.to.x - h.from.x) || 1) as 1 | -1, vdir: 1 }
  const at = walkerAt(w, t)
  const side = project(robotFaces(walkerPose(w)), { ...SIDE_CAMERA, scale: t.scale })
  const b = bounds(at.facing === 1 ? side : mirrorX(side))
  return { x0: at.x + b.minX, y0: at.y + b.minY, x1: at.x + b.maxX, y1: at.y + b.maxY }
}

/**
 * Ground truth, independent of the planner's model: the ms a hop's drawn silhouette, frame by
 * frame, overlaps `fixed` by more than 0.5px (as the e2e measures it), and that time weighted by
 * the share of its width they cover.
 */
function behindTruth(h: Hop, t: Terrain, fixed: Rect[], steps = 400): { ms: number; weighted: number } {
  let ms = 0
  let weighted = 0
  const dt = (h.dur * 1000) / steps
  for (let i = 0; i < steps; i++) {
    const s = silhouetteAt({ ...h, t: (i + 0.5) / steps }, t)
    const hits = fixed.filter((r) => r.x1 > s.x0 + 0.5 && r.x0 < s.x1 - 0.5 && r.y1 > s.y0 + 0.5 && r.y0 < s.y1 - 0.5)
    if (!hits.length) continue
    ms += dt
    const spans = hits.map((r) => [Math.max(r.x0, s.x0), Math.min(r.x1, s.x1)] as const).sort((a, b) => a[0] - b[0])
    let covered = 0
    let end = -Infinity
    for (const [a, b] of spans)
      if (b > end) {
        covered += b - Math.max(a, end)
        end = b
      }
    weighted += (dt * covered) / (s.x1 - s.x0)
  }
  return { ms, weighted }
}

/** Runs a trip to its end in 1/60 s frames, checking the walk is continuous. */
function drive(trip: Trip, w: Walker, frames = 60 * 120, dt = 1 / 60) {
  let prev = walkerAt(w, t)
  for (let i = 0; i < frames; i++) {
    const r = stepTrip(trip, w, t, dt)
    trip = r.trip
    w = r.walker
    const at = walkerAt(w, t)
    expect(Math.hypot(at.x - prev.x, at.y - prev.y), `frame ${i}`).toBeLessThan(SCALE * 0.5) // never teleports
    if (w.kind === 'walk') expect(at.y).toBe(surfaces[w.surface]!.y)
    prev = at
    if (r.state !== 'going') return { ...r, frames: i + 1 }
  }
  throw new Error('the trip never ended')
}

describe('trip', () => {
  describe('route filter', () => {
    const from = { surface: 0, x: 200 }
    const route: Move[] = [
      { kind: 'walk', surface: 0, toX: 300 },
      { kind: 'step', from: { surface: 0, x: 300 }, to: { surface: 1, x: 300 } },
      { kind: 'walk', surface: 1, toX: 500 },
    ]

    it('passes a clean route', () => {
      expect(routeClear(t, from, route, clear)).toBe(true)
      expect(routeClear(t, from, [], clear)).toBe(true)
    })

    it('fails a route with a hop the text can not part around', () => {
      const seen: Hop[] = []
      const hop = (h: Hop) => (seen.push(h), false)
      expect(routeClear(t, from, route, { ...clear, hop })).toBe(false)
      expect(seen[0]).toMatchObject({ from: { surface: 0, x: 300 }, to: { surface: 1, x: 300 } })
      expect(seen[0]!.arc).toBeGreaterThan(0) // the arc it will fly, not a straight line
    })

    it('fails a walk outside the clear run it stands on, or one the check rejects', () => {
      expect(routeClear(t, from, [{ kind: 'walk', surface: 0, toX: 720 }], clear)).toBe(false)
      expect(routeClear(t, { surface: 3, x: 200 }, [{ kind: 'walk', surface: 3, toX: 300 }], clear)).toBe(false)
      const walk = (s: number, x0: number, x1: number) => !(s === 1 && x1 > 400)
      expect(routeClear(t, from, route, { ...clear, walk })).toBe(false)
      expect(routeClear(t, from, route.slice(0, 2), { ...clear, walk })).toBe(true)
    })

    it('fails a route that does not start where the robot is, or does not join up', () => {
      expect(routeClear(t, { surface: 1, x: 200 }, route, clear)).toBe(false)
      const gap: Move[] = [route[0]!, { kind: 'step', from: { surface: 0, x: 320 }, to: { surface: 1, x: 320 } }]
      expect(routeClear(t, from, gap, clear)).toBe(false)
      const off: Move[] = [{ kind: 'step', from: { surface: 5, x: 200 }, to: { surface: 4, x: 200 } }]
      expect(routeClear(t, { surface: 5, x: 200 }, off, clear)).toBe(false) // it can't stand on 5 to start with
      const onto: Move[] = [{ kind: 'step', from: { surface: 4, x: 200 }, to: { surface: 5, x: 200 } }]
      expect(routeClear(t, { surface: 4, x: 200 }, onto, clear)).toBe(false)
    })
  })

  describe('planning', () => {
    it('goes to the nearest reachable point by a route that passes the filter', () => {
      const r = planTrip(t, { surface: 0, x: 200 }, 380, 400, clear)!
      expect(r.to).toEqual({ surface: 4, x: 380 })
      expect(routeClear(t, { surface: 0, x: 200 }, r.moves, clear)).toBe(true)
      // down line by line; the jump to Work goes from the short line, or from beyond its end, never over it
      const hops = hopsOf(r.moves)
      expect(hops.slice(0, 2).map((m) => `${m.kind} ${m.from.surface}>${m.to.surface}`)).toEqual(['step 0>1', 'step 1>2'])
      const jump = hops.at(-1)!
      expect(`${jump.kind} >${jump.to.surface}`).toBe('jump >4')
      if (jump.from.surface === 2) expect(Math.min(jump.from.x, jump.to.x) - clear.half).toBeGreaterThan(surfaces[3]!.x1)
      else expect(jump.from.surface).toBe(3)
    })

    it('never hops past a line it could stand on', () => {
      const r = planTrip(t, { surface: 0, x: 400 }, 400, 103, clear)!
      for (const m of hopsOf(r.moves)) expect(Math.abs(surfaces[m.to.surface]!.y - surfaces[m.from.surface]!.y)).toBeLessThanOrEqual(46)
      expect(r.to.surface).toBe(2)
    })

    it('takes each hop from a spot the text can part around', () => {
      const hop = (h: Hop) => h.from.x >= 450
      const r = planTrip(t, { surface: 0, x: 200 }, 200, 103, { ...clear, hop })!
      expect(r.to).toEqual({ surface: 2, x: 200 })
      for (const m of hopsOf(r.moves)) expect(m.from.x).toBeGreaterThanOrEqual(450)
      expect(routeClear(t, { surface: 0, x: 200 }, r.moves, { ...clear, hop })).toBe(true)
    })

    it('falls back to the next nearest reachable target when a route fails', () => {
      // the nearest target is on line 1, but walking there is not clear
      const walk = (s: number) => s !== 1
      const r = planTrip(t, { surface: 0, x: 200 }, 300, 60, { ...clear, walk })!
      expect(r).not.toBeNull()
      expect(r.to.surface).not.toBe(1)
      expect(routeClear(t, { surface: 0, x: 200 }, r.moves, { ...clear, walk })).toBe(true)
    })

    it('reports no route when nothing passes or the robot stands nowhere', () => {
      expect(planTrip(t, { surface: 0, x: 200 }, 300, 60, { ...clear, walk: () => false })).toBeNull()
      expect(planTrip(t, { surface: 5, x: 200 }, 300, 60, clear)).toBeNull()
      expect(planTrip(t, { surface: 99, x: 200 }, 300, 60, clear)).toBeNull()
    })

    it('a click on its own spot is a trip with nothing to do', () => {
      expect(planTrip(t, { surface: 2, x: 300 }, 300, 90, clear)).toEqual({ to: { surface: 2, x: 300 }, moves: [], hops: [] })
    })

    it('limits a step to a line or a paragraph gap, and a jump to a section gap', () => {
      expect(tripLimits(48)).toEqual({ maxStep: 1.6 * 48, maxLeap: 3 * 48, maxJump: 320, stride: 0.4 * 48 })
    })
  })

  describe('walking it', () => {
    it('follows the moves to the target, turning to face each', () => {
      const w = placeWalker(t, { surface: 1, x: 600 }, 1)
      const from = tripStart(w, t)
      const plan = planTrip(t, from, 150, 360, clear)!
      expect(plan.to.surface).toBe(4)
      const facings = new Set<number>([walkerAt(w, t).facing])
      let trip: Trip = { ...plan, i: 0 }
      let walker = w
      // one hop per take-off pose (it is kept through the flight); a hop may land and the next
      // take off within one frame
      const hops = new Set<object>()
      for (let i = 0; i < 60 * 60; i++) {
        const r = stepTrip(trip, walker, t, 1 / 60)
        if (r.walker.kind === 'hop') hops.add(r.walker.hop.takeoff)
        trip = r.trip
        walker = r.walker
        facings.add(walkerAt(walker, t).facing)
        if (r.state === 'arrived') break
      }
      expect(walker.kind).toBe('walk')
      expect(walkerAt(walker, t)).toMatchObject({ surface: 4, x: plan.to.x })
      expect(hops.size).toBe(hopsOf(plan.moves).length)
      expect(facings).toEqual(new Set([1, -1])) // it turned round to walk back left
    })

    it('never teleports and arrives', () => {
      const w = placeWalker(t, { surface: 0, x: 200 }, 1)
      const plan = planTrip(t, tripStart(w, t), 600, 360, clear)!
      const r = drive({ ...plan, i: 0 }, w)
      expect(r.state).toBe('arrived')
      expect(walkerAt(r.walker, t)).toMatchObject({ surface: 4, x: 600 })
    })

    it('walks at trip speed on a short trip', () => {
      const w = placeWalker(t, { surface: 0, x: 200 }, 1)
      const plan = planTrip(t, tripStart(w, t), 500, 11, clear)!
      const r = drive({ ...plan, i: 0 }, w)
      expect(walkerAt(w, t).x).toBe(200)
      expect(Math.abs((r.frames / 60) * TRIP_SPEED * SCALE - 300)).toBeLessThan(1)
    })

    it('walks at the pace it is given, however long the trip', () => {
      const long: Terrain = { surfaces: [surf(0, 'bio-0', 0, 11, 0, 2000)], scale: SCALE }
      const w = placeWalker(long, { surface: 0, x: 100 }, 1)
      const plan = planTrip(long, tripStart(w, long), 1900, 11, clear)!
      const trip: Trip = { ...plan, i: 0 }
      expect(pathLength(tripPath(trip, w, long))).toBeGreaterThan(LONG_TRIP_PX * 2) // long: a trip would speed up
      const moved = (pace?: number) => walkerAt(stepTrip(trip, w, long, 0.1, pace).walker, long).x - 100
      expect(moved(WANDER_SPEED)).toBeCloseTo(WANDER_SPEED * 0.1 * SCALE, 6)
      expect(moved()).toBeGreaterThan(WANDER_SPEED * 0.1 * SCALE * 1.2)
    })

    it('lands a hop in flight before setting off', () => {
      let w = placeWalker(t, { surface: 0, x: 690 }, 1)
      for (let i = 0; w.kind !== 'hop' && i < 600; i++) w = wander(w, t, 1 / 60)
      expect(w.kind).toBe('hop')
      const from = tripStart(w, t)
      expect(from).toMatchObject((w as Walker & { kind: 'hop' }).hop.to)
      const plan = planTrip(t, from, 300, 11, clear)!
      const r = drive({ ...plan, i: 0 }, w)
      expect(r.state).toBe('arrived')
      expect(walkerAt(r.walker, t)).toMatchObject({ surface: 0, x: 300 })
    })

    it('is lost when the robot is not where its route goes on from', () => {
      const plan = planTrip(t, { surface: 0, x: 200 }, 300, 60, clear)!
      const elsewhere = placeWalker(t, { surface: 2, x: 200 }, 1)
      expect(stepTrip({ ...plan, i: 0 }, elsewhere, t, 1 / 60).state).toBe('lost')
    })

    it('keeps its feet and legs sound', () => {
      const w = placeWalker(t, { surface: 0, x: 650 }, 1)
      let trip: Trip = { ...planTrip(t, tripStart(w, t), 120, 360, clear)!, i: 0 }
      let walker = w
      for (let i = 0; i < 60 * 60; i++) {
        const r = stepTrip(trip, walker, t, 1 / 60)
        trip = r.trip
        walker = r.walker
        for (const l of walkerPose(walker).legs) {
          expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 6)
          if (walker.kind === 'walk') expect(l.foot[1]).toBeGreaterThanOrEqual(MODEL.groundY + 0.03 - 1e-9)
        }
        if (r.state !== 'going') break
      }
      expect(walkerAt(walker, t).surface).toBe(4)
    })
  })

  describe('its dotted path', () => {
    it('runs from the robot to the target and erodes as it goes', () => {
      const w = placeWalker(t, { surface: 0, x: 200 }, 1)
      const plan = planTrip(t, tripStart(w, t), 600, 360, clear)!
      let trip: Trip = { ...plan, i: 0 }
      let walker: Walker = w
      let left = Infinity
      for (let i = 0; i < 60 * 60; i++) {
        const pts = tripPath(trip, walker, t)
        const at = walkerAt(walker, t)
        expect(pts[0]).toEqual([at.x, at.y])
        expect(pts.at(-1)).toEqual([600, 360])
        const n = pathLength(pts)
        expect(n).toBeLessThanOrEqual(left + 1e-6)
        left = n
        const r = stepTrip(trip, walker, t, 1 / 60)
        trip = r.trip
        walker = r.walker
        if (r.state !== 'going') break
      }
      expect(left).toBeLessThan(5)
    })
  })

  describe('past text that does not part', () => {
    // a bio line, a heading below it across the column, and a Work line below that
    const two: Surface[] = [surf(0, 'bio-0', 0, 100, 100, 600), surf(1, 'work-0', 1, 400, 100, 600)]
    const t2: Terrain = { surfaces: two, scale: SCALE }
    const heading = (x1 = 640): Rect => ({ x0: 80, y0: 250, x1, y1: 270 })
    const checks = (fixed: Rect[]): RouteChecks => ({ ...clear, fixed })
    const jumpOf = (r: { moves: Move[]; hops: (Hop | null)[] }) => {
      const i = r.moves.findIndex((m) => m.kind === 'jump')
      return { move: r.moves[i] as Extract<Move, { from: unknown }>, hop: r.hops[i]! }
    }

    it('takes a clear jump where one is near, walking to it', () => {
      // a two-line heading: passing behind it costs more than the walk out to its end and back
      const tall = checks([{ ...heading(400), y0: 180 }])
      for (const x of [380, 395]) {
        const r = planTrip(t2, { surface: 0, x }, x, 400, tall)!
        const { move, hop } = jumpOf(r)
        expect(move.from.x).toBeGreaterThan(400) // walked out to where the heading ends (moving along, it clears it)
        expect(crossesFixed(hop, t2, tall)).toBe(false)
        expect(r.to).toEqual({ surface: 1, x })
      }
    })

    it('but not from far: it walks no further out of its way than 1px for each ms behind the heading it saves', () => {
      const c = checks([heading(400)])
      const r = planTrip(t2, { surface: 0, x: 150 }, 150, 400, c)!
      const { move, hop } = jumpOf(r)
      expect(Math.abs(move.from.x - 150)).toBeLessThan(SCALE) // a clear jump is over 250px away there and as far back
      const behind = behindText(hop, t2, c)
      expect(behind.ms).toBeGreaterThan(0)
      expect(behind.ms).toBeLessThan(250) // the price of the walk it did not take
    })

    it('where nothing is clear it still gets there, crossing as little as it can, from about where it is', () => {
      const r = planTrip(t2, { surface: 0, x: 550 }, 550, 400, checks([heading()]))!
      expect(r.to).toEqual({ surface: 1, x: 550 })
      const { move, hop } = jumpOf(r)
      expect(Math.abs(move.from.x - 550)).toBeLessThan(2 * SCALE) // not a walk to the far end of the line and back
      const c = checks([heading()])
      const cost = (h: Hop) => behindText(h, t2, c).cost
      expect(cost(hop)).toBeGreaterThan(0)
      expect(cost(hop)).toBeLessThanOrEqual(cost(makeNoRiseHop(t2, move.from, move.to, hop.takeoff)))
      expect(cost(hop)).toBeLessThanOrEqual(cost(makeHop(t2, move.from, move.to, hop.takeoff)))
      expect(routeClear(t2, { surface: 0, x: 550 }, r.moves, c)).toBe(true)
    })

    // a Work entry's header at 1440px: title, then the role line and dates with a gap between
    // them narrower than the robot (55px; its flight silhouette is about 58px wide)
    const height = walkerReach().height * SCALE
    const half = walkerReach().half * SCALE
    const first = 2192
    const roleBottom = first - height - 1.2
    const header: Rect[] = [
      { x0: 381, y0: roleBottom - 40, x1: 620, y1: roleBottom - 22 }, // title
      { x0: 381, y0: roleBottom - 18, x1: 901, y1: roleBottom }, // role line
      { x0: 956, y0: roleBottom - 18, x1: 1021, y1: roleBottom }, // dates
    ]
    const gapped: Terrain = {
      scale: SCALE,
      surfaces: [surf(0, 'work-0', 3, 2052, 412, 990), surf(1, 'work-0', 4, 2076, 412, 780), surf(2, 'work-1', 1, first, 412, 990)],
    }
    const gc: RouteChecks = { ...clear, fixed: header, half }

    it('aims a jump through a gap narrower than itself at the gap’s middle, from near it', () => {
      // (from further, the walk there and back costs more than the time behind the words it saves)
      for (const x of [905, 930, 980]) {
        const p = planTrip(gapped, { surface: 0, x, facing: 1 }, 700, first, gc)!
        const { move, hop } = jumpOf(p)
        // its silhouette where it lands, just under the role line it passes last
        const s = silhouetteAt({ ...hop, t: 1 }, gapped)
        expect(Math.abs((s.x0 + s.x1) / 2 - (901 + 956) / 2), `from ${x}: lands at ${move.to.x}`).toBeLessThanOrEqual(8)
        const truth = behindTruth(hop, gapped, header)
        expect(truth.weighted).toBeLessThan(0.2 * truth.ms) // only an edge of it behind the words
      }
    })

    // the bio's last line over the first Work entry at 1440px: its role line (to 914) and dates
    // (from 948) leave a 34px gap, and the title and the "WORK" heading are above them on the left
    const drop: Terrain = { scale: SCALE, surfaces: [surf(0, 'bio-2', 5, 1758, 412, 990), surf(1, 'work-0', 1, 2004, 412, 990)] }
    const rb = 2004 - height - 1.2
    const work: Rect[] = [
      { x0: 381, y0: 1860, x1: 450, y1: 1880 }, // WORK
      { x0: 381, y0: rb - 40, x1: 640, y1: rb - 22 }, // title
      { x0: 381, y0: rb - 16, x1: 914, y1: rb }, // role line
      { x0: 948, y0: rb - 16, x1: 1021, y1: rb }, // dates
    ]
    const dc: RouteChecks = { ...clear, fixed: work, half }

    it('never walks further out of its way than 1px for each ms behind the words it saves (the robot’s own silhouette, frame by frame)', () => {
      const stride = STRIDE * SCALE
      for (const x of [420, 500, 600, 760]) {
        const p = planTrip(drop, { surface: 0, x, facing: 1 }, x, 2004, dc)!
        const { hop } = jumpOf(p)
        let walked = 0
        let at = x
        for (const m of p.moves) {
          if (m.kind === 'walk') walked += Math.abs(m.toX - at)
          at = m.kind === 'walk' ? m.toX : m.to.x
        }
        const planned = behindTruth(hop, drop, work).weighted
        // the jump from where it stands, landing either way along, then the walk back
        const direct = Math.min(
          ...[1, -1].map((d) => behindTruth(shapeHop(drop, { surface: 0, x }, { surface: 1, x: x + d * stride }, dc)!.hop, drop, work).weighted),
        )
        expect(walked - stride, `from ${x}: walked ${walked.toFixed(0)}px to spend ${planned.toFixed(0)} ms, not ${direct.toFixed(0)}`).toBeLessThanOrEqual(
          (direct - planned) * CROSSING_PX_PER_MS * 1.05 + 5,
        )
      }
    })

    it('a step that would rise into a role line just above flies without rising instead', () => {
      // standing 1.2px under a role line, as on a Work blurb's first line it can stand on
      const pair: Surface[] = [surf(0, 'work-0', 1, 300, 100, 600), surf(1, 'work-0', 2, 324, 100, 600)]
      const tp: Terrain = { surfaces: pair, scale: SCALE }
      const height = walkerReach().height * SCALE
      const role: Rect = { x0: 80, y0: 280, x1: 640, y1: 300 - height - 1.2 }
      const c = checks([role])
      for (const [a, b] of [
        [{ surface: 0, x: 200 }, { surface: 1, x: 220 }],
        [{ surface: 1, x: 220 }, { surface: 0, x: 200 }],
      ]) {
        const s = shapeHop(tp, a!, b!, c)!
        expect(s.cost).toBe(0)
        expect(s.hop.path).toBeDefined() // the no-rise flight
        expect(crossesFixed(makeHop(tp, a!, b!, s.hop.takeoff), tp, c)).toBe(true) // the usual arc would have met the role line
      }
    })

    it('passes a line it could stand on only where that line has ended', () => {
      // A Work blurb's long line, its short last line, and the next blurb's line below both
      const three: Surface[] = [surf(0, 'work-0', 2, 100, 100, 600), surf(1, 'work-0', 3, 124, 100, 300), surf(2, 'work-1', 1, 252, 100, 600)]
      const t3: Terrain = { surfaces: three, scale: SCALE }
      const past = planTrip(t3, { surface: 0, x: 500 }, 500, 252, clear)!
      expect(past.moves.filter((m) => m.kind !== 'walk').map((m) => (m as Extract<Move, { to: unknown }>).to.surface)).toEqual([2])
      const via = planTrip(t3, { surface: 0, x: 150 }, 150, 252, clear)!
      expect(via.moves.filter((m) => m.kind !== 'walk').map((m) => (m as Extract<Move, { to: unknown }>).to.surface)).toEqual([1, 2])
    })
  })

  it('steps down a paragraph to a spot right below it without turning round on every line', () => {
    const stack: Terrain = { scale: SCALE, surfaces: Array.from({ length: 10 }, (_, i) => surf(i, 'bio-0', i, 100 + 24 * i, 100, 900)) }
    const w = placeWalker(stack, { surface: 0, x: 500 }, 1)
    const plan = planTrip(stack, tripStart(w, stack), 500, 100 + 24 * 9, clear)!
    expect(hopsOf(plan.moves)).toHaveLength(9)
    let trip: Trip = { ...plan, i: 0 }
    let walker: Walker = w
    let turns = 0
    let facing = walkerAt(w, stack).facing
    for (let i = 0; i < 60 * 60; i++) {
      const r = stepTrip(trip, walker, stack, 1 / 60)
      trip = r.trip
      walker = r.walker
      const f = walkerAt(walker, stack).facing
      if (f !== facing) turns++
      facing = f
      if (r.state !== 'going') break
    }
    expect(walkerAt(walker, stack)).toMatchObject({ surface: 9, x: 500 })
    expect(turns).toBeLessThanOrEqual(1) // at most once, to walk back to the spot
  })

  describe('every hop arcs, and the robot only ever stops on a line', () => {
    const height = walkerReach().height * SCALE
    // a bio line over a Work entry whose role line sits 1.2px over its first line's reach
    const entry: Terrain = {
      scale: SCALE,
      surfaces: [surf(0, 'bio-0', 0, 100, 100, 600), surf(1, 'work-0', 1, 300, 100, 600), surf(2, 'work-0', 2, 324, 100, 600), surf(3, 'work-0', 3, 348, 100, 600)],
    }
    const role: Rect = { x0: 80, y0: 300 - height - 17, x1: 640, y1: 300 - height - 1.2 }
    const cases: [string, Terrain, RouteChecks, Start, number, number, boolean][] = [
      ['down the stack', t, clear, { surface: 0, x: 200 }, 600, 360, false],
      ['up the stack', t, clear, { surface: 4, x: 600 }, 200, 11, false],
      ['into a Work blurb and down from its first line', entry, { ...clear, fixed: [role] }, { surface: 0, x: 200 }, 200, 348, true],
      ['back up to its first line', entry, { ...clear, fixed: [role] }, { surface: 3, x: 400 }, 400, 300, true],
    ]
    for (const [name, t, c, from, x, y, noRise] of cases)
      it(name, () => {
        const surfaces = t.surfaces
        const plan = planTrip(t, from, x, y, c)!
        if (noRise) expect(plan.hops.some((h) => h?.path)).toBe(true) // a flight that does not rise into the role line
        expect(plan.moves.some((m) => m.kind !== 'walk')).toBe(true)
        // no hop with any rise or fall moves in a straight line
        plan.hops.forEach((h) => {
          if (!h) return
          const a = walkerAt({ kind: 'hop', hop: { ...h, t: 0 }, facing: 1, vdir: 1 }, t)
          const b = walkerAt({ kind: 'hop', hop: { ...h, t: 1 }, facing: 1, vdir: 1 }, t)
          if (Math.abs(b.y - a.y) < 1) return
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          let bulge = 0
          for (let k = 1; k < 100; k++) {
            const p = walkerAt({ kind: 'hop', hop: { ...h, t: k / 100 }, facing: 1, vdir: 1 }, t)
            bulge = Math.max(bulge, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len)
          }
          expect(bulge).toBeGreaterThan(1)
        })
        // driven frame by frame: wherever it stands still, it stands on a line it can stand on
        let trip: Trip = { ...plan, i: 0 }
        let w: Walker = placeWalker(t, from, from.facing ?? 1)
        let prev = walkerAt(w, t)
        for (let i = 0; i < 60 * 60; i++) {
          const r = stepTrip(trip, w, t, 1 / 60)
          trip = r.trip
          w = r.walker
          const at = walkerAt(w, t)
          if (Math.hypot(at.x - prev.x, at.y - prev.y) < 1e-9 || w.kind === 'walk') {
            const s = surfaces[at.surface]!
            expect(w.kind).toBe('walk')
            expect(s.standable).toBe(true)
            expect(at.y).toBe(s.y)
            expect(at.x).toBeGreaterThanOrEqual(s.x0 - 0.5)
            expect(at.x).toBeLessThanOrEqual(s.x1 + 0.5)
          }
          prev = at
          if (r.state !== 'going') break
        }
        expect(walkerAt(w, t).surface).toBe(plan.to.surface)
      })
  })

  it('walks a bit faster than it wanders when sent, not much', () => {
    expect(tripSpeed(0) / WANDER_SPEED).toBeGreaterThanOrEqual(1.2)
    expect(tripSpeed(0) / WANDER_SPEED).toBeLessThanOrEqual(1.4)
  })

  it('speeds up to twice wander speed on long trips', () => {
    expect(tripSpeed(0)).toBe(TRIP_SPEED)
    expect(tripSpeed(LONG_TRIP_PX)).toBe(TRIP_SPEED)
    expect(tripSpeed(2 * LONG_TRIP_PX)).toBe(2 * WANDER_SPEED)
    expect(tripSpeed(5000)).toBe(2 * WANDER_SPEED)
    let prev = 0
    for (let px = 0; px < 1500; px += 25) {
      expect(tripSpeed(px)).toBeGreaterThanOrEqual(prev)
      prev = tripSpeed(px)
    }
  })
})
