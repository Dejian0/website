import { describe, expect, it } from 'vitest'
import { MODEL, robotFaces, type RobotPose } from '../../src/robot/model.ts'
import { WANDER_SPEED } from '../../src/robot/gait.ts'
import { bounds, project, SIDE_CAMERA } from '../../src/robot/render.ts'
import {
  flightSide,
  hopPath,
  lookUp,
  makeHop,
  makeNoRiseHop,
  placeWalker,
  READY_PITCH,
  standStill,
  walkerAt,
  walkerPose,
  walkerReach,
  wander,
  type Terrain,
  type Walker,
} from '../../src/robot/walker.ts'
import type { Surface } from '../../src/terrain/terrain.ts'

const SCALE = 48
// A bio-like stack: lines 46px apart, a paragraph gap before line 3, then a far-off work line.
const surf = (id: number, flow: string, line: number, y: number, x1: number, standable = true): Surface => ({
  id,
  flow,
  line,
  x0: 100,
  x1,
  y,
  standable,
})
const surfaces: Surface[] = [
  surf(0, 'bio-0', 0, 11, 700),
  surf(1, 'bio-0', 1, 57, 680),
  surf(2, 'bio-0', 2, 103, 300), // short last line: its right end is far from line 1's
  surf(3, 'bio-1', 0, 168, 720),
  surf(4, 'bio-1', 1, 214, 690),
  surf(5, 'work-0', 0, 500, 700), // too far below to hop to
]
const terrain: Terrain = { surfaces, scale: SCALE }

/** Runs the walker for `seconds` in `dt` steps, recording ground positions and surfaces. */
function run(w: Walker, seconds: number, dt = 1 / 60, t: Terrain = terrain) {
  const trace: { x: number; y: number; surface: number; kind: Walker['kind'] }[] = []
  for (let i = 0; i < seconds / dt; i++) {
    w = wander(w, t, dt)
    const at = walkerAt(w, t)
    trace.push({ x: at.x, y: at.y, surface: at.surface, kind: w.kind })
  }
  return { w, trace }
}

describe('walker', () => {
  it('is placed on its span, a little inside the end', () => {
    const at = walkerAt(placeWalker(terrain, { surface: 0, x: 0 }, 1), terrain)
    expect(at).toMatchObject({ surface: 0, y: 11, facing: 1 })
    expect(at.x).toBeGreaterThan(100)
    expect(at.x).toBeLessThan(100 + 0.1 * SCALE)
  })

  it('keeps its body centre on the span while walking', () => {
    const { trace } = run(placeWalker(terrain, { surface: 2, x: 200 }, 1), 60, 1 / 60, { ...terrain, canHop: () => false })
    for (const p of trace) {
      expect(p.x).toBeGreaterThanOrEqual(100)
      expect(p.x).toBeLessThanOrEqual(300)
    }
    expect(Math.max(...trace.map((p) => p.x))).toBeGreaterThan(300 - 0.05 * SCALE) // it does reach the end
  })

  it('walks along its surface at wander speed', () => {
    const { trace } = run(placeWalker(terrain, { surface: 0, x: 200 }, 1), 2)
    const end = trace[trace.length - 1]!
    expect(end).toMatchObject({ surface: 0, y: 11, kind: 'walk' })
    expect(end.x - walkerAt(placeWalker(terrain, { surface: 0, x: 200 }, 1), terrain).x).toBeCloseTo(
      WANDER_SPEED * 2 * SCALE,
      0,
    )
  })

  it('snakes down the stack, hopping at line ends, and never teleports', () => {
    const { trace } = run(placeWalker(terrain, { surface: 0, x: 100 }, 1), 400, 1 / 30)
    const order = trace.map((p) => p.surface).filter((s, i, a) => i === 0 || s !== a[i - 1])
    expect(order.slice(0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(order).not.toContain(5)
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1]!
      const b = trace[i]!
      expect(Math.hypot(b.x - a.x, b.y - a.y), `step ${i}`).toBeLessThan(SCALE * 0.5)
      if (b.kind === 'walk' && a.kind === 'walk') expect(b.surface).toBe(a.surface) // surfaces change only by hops
      if (b.kind === 'walk') expect(b.y).toBe(surfaces[b.surface]!.y)
    }
  })

  it('walks back instead of hopping when the next line ends far away', () => {
    // line 1's right end (680) is far from line 2's (300): it turns, then hops at the left end
    const { trace } = run(placeWalker(terrain, { surface: 1, x: 600 }, 1), 30, 1 / 30)
    const firstHop = trace.findIndex((p) => p.kind === 'hop')
    expect(firstHop).toBeGreaterThan(0)
    expect(trace[firstHop - 1]!.x).toBeLessThan(100 + SCALE)
  })

  it('turns back up at the bottom of the stack', () => {
    const { trace } = run(placeWalker(terrain, { surface: 4, x: 100 }, 1), 120, 1 / 30)
    const order = trace.map((p) => p.surface).filter((s, i, a) => i === 0 || s !== a[i - 1])
    expect(order.slice(0, 2)).toEqual([4, 3])
  })

  it('skips unstandable surfaces', () => {
    const t: Terrain = { scale: SCALE, surfaces: surfaces.map((s) => (s.id === 1 ? { ...s, standable: false } : s)) }
    const { trace } = run(placeWalker(t, { surface: 0, x: 100 }, 1), 120, 1 / 30, t)
    expect(trace.map((p) => p.surface)).not.toContain(1)
  })

  it('keeps leg lengths while walking and hopping', () => {
    let w = placeWalker(terrain, { surface: 0, x: 620 }, 1)
    let hopped = false
    for (let i = 0; i < 600; i++) {
      w = wander(w, terrain, 1 / 60)
      if (w.kind === 'hop') hopped = true
      for (const l of walkerPose(w).legs) {
        expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 6)
        expect(Math.hypot(l.foot[0] - l.knee[0], l.foot[1] - l.knee[1])).toBeLessThanOrEqual(MODEL.shank + 1e-6)
      }
    }
    expect(hopped).toBe(true)
  })

  it('walkerReach bounds every pose, walking and hopping', () => {
    const reach = walkerReach()
    let w = placeWalker(terrain, { surface: 0, x: 100 }, 1)
    for (let i = 0; i < 240 * 60; i++) {
      w = wander(w, terrain, 1 / 240)
      const b = bounds(project(robotFaces(walkerPose(w)), { ...SIDE_CAMERA, scale: 1 }))
      expect(Math.max(b.maxX, -b.minX)).toBeLessThanOrEqual(reach.half)
      expect(-b.minY).toBeLessThanOrEqual(reach.height + 1e-9)
    }
  })

  it('flightSide bounds its side view in flight, behind and ahead the way it faces, and is no wider than that', () => {
    const side = flightSide()
    expect(Math.max(side.back, side.front)).toBeLessThanOrEqual(walkerReach().half)
    let [back, front] = [0, 0]
    let w = placeWalker(terrain, { surface: 0, x: 100 }, 1)
    const noRise = makeNoRiseHop(terrain, { surface: 0, x: 300 }, { surface: 1, x: 320 }, walkerPose(w))
    for (let i = 0; i < 240 * 60; i++) {
      w = wander(w, terrain, 1 / 240)
      // the wander's hops (either facing) and, every so often, a no-rise hop taken off from its stride
      const hops: Walker[] = w.kind === 'hop' ? [w] : i % 40 === 0 ? [0, 0.3, 0.6, 1].map((t) => ({ kind: 'hop', hop: { ...noRise, takeoff: walkerPose(w), t }, facing: w.kind === 'walk' ? w.gait.facing : 1, vdir: 1 })) : []
      for (const h of hops) {
        const b = bounds(project(robotFaces(walkerPose(h)), { ...SIDE_CAMERA, scale: 1 })) // drawn mirrored when facing left
        back = Math.max(back, -b.minX)
        front = Math.max(front, b.maxX)
      }
    }
    expect(back).toBeLessThanOrEqual(side.back + 1e-9)
    expect(front).toBeLessThanOrEqual(side.front + 1e-9)
    expect(back).toBeGreaterThan(side.back - 0.01)
    expect(front).toBeGreaterThan(side.front - 0.01)
  })

  describe('standing still', () => {
    const GROUND = MODEL.groundY + 0.03

    it('stops where it is and brings every foot down within 0.5 s', () => {
      for (const seconds of [0.3, 0.55, 0.8, 1.05, 1.3]) {
        let w = run(placeWalker(terrain, { surface: 0, x: 300 }, 1), seconds, 1 / 240).w
        expect(w.kind).toBe('walk')
        const x = walkerAt(w, terrain).x
        for (let i = 0; i < 120; i++) w = standStill(w, terrain, 1 / 240)
        expect(walkerAt(w, terrain)).toMatchObject({ x, surface: 0 })
        for (const l of walkerPose(w).legs) expect(l.foot[1]).toBeCloseTo(GROUND, 9)
      }
    })

    it('lands a hop first, then stands', () => {
      let w = placeWalker(terrain, { surface: 0, x: 620 }, 1)
      for (let i = 0; w.kind !== 'hop' && i < 60 * 60; i++) w = wander(w, terrain, 1 / 60)
      expect(w.kind).toBe('hop')
      const to = (w as Walker & { kind: 'hop' }).hop.to
      for (let i = 0; i < 120; i++) w = standStill(w, terrain, 1 / 60)
      expect(w.kind).toBe('walk')
      expect(walkerAt(w, terrain).surface).toBe(to.surface)
      for (const l of walkerPose(w).legs) expect(l.foot[1]).toBeCloseTo(GROUND, 9)
    })
  })

  describe('the ready look', () => {
    const at = (pose: RobotPose, drop: number) => {
      const polys = project(robotFaces(pose), { ...SIDE_CAMERA, scale: 1 })
      // the head: the front sensor box, the faces furthest forward
      const b = bounds(polys)
      const head = polys.filter((p) => p.pts.every(([x]) => x >= 0.49)) // the head box spans x 0.5..0.62
      return { top: -(b.minY + drop), headTop: -(Math.min(...head.flatMap((p) => p.pts.map(([, y]) => y))) + drop), b }
    }
    const stand = walkerPose(placeWalker(terrain, { surface: 0, x: 300 }, 1))

    it('raises the head', () => {
      const up = lookUp(stand, 1)
      expect(up.pose.bodyPitch).toBe(READY_PITCH)
      expect(READY_PITCH).toBeGreaterThan(0) // the body frame is y-up: a positive pitch lifts the nose
      expect(at(up.pose, up.drop).headTop).toBeGreaterThan(at(stand, 0).headTop + 0.02)
    })

    it('stays inside walkerReach, feet on the ground, at every stage', () => {
      const reach = walkerReach()
      for (let k = 0; k <= 1; k += 0.125) {
        const { pose, drop } = lookUp(stand, k)
        const a = at(pose, drop)
        expect(a.top).toBeLessThanOrEqual(reach.height + 1e-9)
        expect(Math.max(a.b.maxX, -a.b.minX)).toBeLessThanOrEqual(reach.half)
        pose.legs.forEach((l, i) => {
          expect(l.foot[1] - drop).toBeCloseTo(stand.legs[i]!.foot[1], 9) // drawn `drop` lower: still on the ground
          expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 9)
          expect(Math.hypot(l.foot[0] - l.knee[0], l.foot[1] - l.knee[1])).toBeCloseTo(MODEL.shank, 9)
        })
      }
      expect(lookUp(stand, 0)).toEqual({ pose: stand, drop: 0 })
    })
  })

  describe('a hop that does not rise', () => {
    // down from line 0 to line 1, moving 20px along; and back up
    const stand = walkerPose(placeWalker(terrain, { surface: 0, x: 300 }, 1))
    const down = makeNoRiseHop(terrain, { surface: 0, x: 300 }, { surface: 1, x: 320 }, stand)
    const up = makeNoRiseHop(terrain, { surface: 1, x: 320 }, { surface: 0, x: 300 }, stand)
    const fly = (h: typeof down, p: number, facing: 1 | -1 = 1): Walker => ({ kind: 'hop', hop: { ...h, t: p }, facing, vdir: 1 })

    it('flies from take-off to landing and never above the higher line', () => {
      for (const [h, a, b] of [
        [down, [300, 11], [320, 57]],
        [up, [320, 57], [300, 11]],
      ] as const) {
        expect(walkerAt(fly(h, 0), terrain)).toMatchObject({ x: a[0], y: a[1] })
        const end = walkerAt(fly(h, 1), terrain)
        expect(end.x).toBeCloseTo(b[0], 9)
        expect(end.y).toBeCloseTo(b[1], 9)
        for (let k = 0; k <= 200; k++) expect(walkerAt(fly(h, k / 200), terrain).y).toBeGreaterThanOrEqual(11 - 1e-9)
      }
    })

    it('tucks its feet: its clearance path reaches no lower than the robot, and its legs stay sound', () => {
      const path = hopPath(down, terrain, 48)
      for (let k = 0; k <= 48; k++) expect(path[k]!.bottom).toBeCloseTo(walkerAt(fly(down, k / 48), terrain).y, 9)
      for (let k = 0; k <= 20; k++)
        for (const l of walkerPose(fly(down, k / 20)).legs) {
          expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 9)
          expect(l.foot[1]).toBeGreaterThanOrEqual(MODEL.groundY + 0.03 - 1e-9) // never below the ground point
        }
    })

    it('cut short (ready, Esc), it lands facing the way it flew, whatever it faced taking off', () => {
      let w = fly(up, 0.3, 1) // flying left (300 < 320) though the walker took off facing right
      for (let i = 0; i < 600 && w.kind === 'hop'; i++) w = standStill(w, terrain, 1 / 60)
      expect(w.kind).toBe('walk')
      expect(walkerAt(w, terrain).facing).toBe(-1)
    })
  })

  it('canHop can veto every hop', () => {
    const t: Terrain = { ...terrain, canHop: () => false }
    const { trace } = run(placeWalker(t, { surface: 0, x: 100 }, 1), 120, 1 / 30, t)
    expect(new Set(trace.map((p) => p.surface))).toEqual(new Set([0]))
    expect(trace.some((p) => p.kind === 'hop')).toBe(false)
  })

  it('leaves a short span whose neighbour does not line up', () => {
    // body range 124..156 on surface 0; surface 1 starts 120px to the right of its right end
    const t: Terrain = { scale: SCALE, surfaces: [surf(0, 'bio-0', 0, 11, 180), { ...surf(1, 'bio-0', 1, 57, 900), x0: 250 }] }
    const { trace } = run(placeWalker(t, { surface: 0, x: 100 }, 1), 30, 1 / 30, t)
    expect(trace.map((p) => p.surface)).toContain(1)
  })

  it('from a dead end it detours back up, keeping its way down, and does not ping-pong', () => {
    // line 1 is whole; line 2 has a right piece (a dead end) and a left piece leading to line 3
    const t: Terrain = {
      scale: SCALE,
      surfaces: [
        surf(0, 'bio-0', 0, 11, 700),
        surf(1, 'bio-0', 1, 57, 700),
        { ...surf(2, 'bio-0', 2, 103, 700), x0: 500 },
        surf(3, 'bio-0', 2, 103, 250),
        surf(4, 'bio-0', 3, 149, 200),
      ],
    }
    let w = placeWalker(t, { surface: 1, x: 600 }, 1)
    const order: number[] = []
    let detour: Walker | null = null
    for (let i = 0; i < 30 * 120 && !order.includes(4); i++) {
      w = wander(w, t, 1 / 30)
      const s = walkerAt(w, t).surface
      if (w.kind === 'walk' && order.at(-1) !== s) {
        if (order.at(-1) === 2 && s === 1) detour = w
        order.push(s)
      }
    }
    expect(order.slice(0, 3)).toEqual([1, 2, 1]) // into the dead end and back out
    expect(detour?.vdir).toBe(1) // still heading down
    expect(order).toContain(4) // found the way down on the other side
    expect(order).not.toContain(0) // without wandering up first
  })
})
