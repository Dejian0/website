import { describe, expect, it } from 'vitest'
import { MIN_LEG, pickLeg, restFor, REST_S } from '../../src/interaction/roam.ts'
import type { RouteChecks } from '../../src/interaction/trip.ts'
import { MAX_HOP_DY, walkerReach, type Terrain } from '../../src/robot/walker.ts'
import type { Rect, Surface } from '../../src/terrain/terrain.ts'

const SCALE = 48
const surf = (id: number, flow: string, line: number, y: number, x0 = 100, x1 = 700, standable = true): Surface => ({ id, flow, line, x0, x1, y, standable })
// three bio paragraphs of one line each (steps apart), a short line, then a Work entry far below
// (a jump) whose second line the robot can't stand on: the Work line is an island of its own
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
const all: Rect = { x0: 0, y0: -200, x1: 800, y1: 600 }

/** A seeded random number generator (mulberry32), so each pick can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const seeds = Array.from({ length: 20 }, (_, i) => i + 1)
const dist = (s: number, x: number, from: { surface: number; x: number }) => Math.hypot(x - from.x, surfaces[s]!.y - surfaces[from.surface]!.y)

describe('pickLeg', () => {
  it('goes to a standable spot at least MIN_LEG away, along a planned route', () => {
    const from = { surface: 0, x: 400, facing: 1 as const }
    for (const seed of seeds) {
      const leg = pickLeg(t, from, all, clear, seeded(seed))
      expect(leg, `seed ${seed}`).not.toBeNull()
      expect(surfaces[leg!.to.surface]!.standable).toBe(true)
      expect(dist(leg!.to.surface, leg!.to.x, from)).toBeGreaterThanOrEqual(MIN_LEG * SCALE)
      expect(leg!.moves.length).toBeGreaterThan(0)
      expect(leg!.hops).toHaveLength(leg!.moves.length)
    }
  })

  it('keeps to what is in view: the robot whole, inside its edges', () => {
    const height = walkerReach().height * SCALE
    const view: Rect = { x0: 300, y0: -100, x1: 800, y1: 120 } // the bio's first three lines, from x 300
    for (const seed of seeds) {
      const leg = pickLeg(t, { surface: 1, x: 650 }, view, clear, seeded(seed))!
      const s = surfaces[leg.to.surface]!
      expect([0, 1, 2]).toContain(s.id)
      expect(s.y - height).toBeGreaterThanOrEqual(view.y0)
      expect(s.y).toBeLessThanOrEqual(view.y1)
      expect(leg.to.x - clear.half).toBeGreaterThanOrEqual(view.x0)
      expect(leg.to.x + clear.half).toBeLessThanOrEqual(view.x1)
    }
  })

  it('mostly strolls: most legs end on the line a step up or down', () => {
    // a ten-line paragraph, all in view: two of its lines are a step from the middle one
    const para: Terrain = { surfaces: Array.from({ length: 10 }, (_, i) => surf(i, 'bio-0', i, 11 + 46 * i)), scale: SCALE }
    const many = Array.from({ length: 60 }, (_, i) => i + 1)
    const dy = many.map((seed) => Math.abs(para.surfaces[pickLeg(para, { surface: 5, x: 400 }, all, clear, seeded(seed))!.to.surface]!.y - para.surfaces[5]!.y))
    const strolls = dy.filter((d) => d > 0 && d <= MAX_HOP_DY * SCALE).length
    expect(strolls).toBeGreaterThan(many.length * 0.6)
    expect(dy.some((d) => d > MAX_HOP_DY * SCALE)).toBe(true) // and now and then it moves on further
  })

  it('mostly keeps going the way it faces', () => {
    const para: Terrain = { surfaces: Array.from({ length: 10 }, (_, i) => surf(i, 'bio-0', i, 11 + 46 * i)), scale: SCALE }
    const many = Array.from({ length: 60 }, (_, i) => i + 1)
    for (const facing of [1, -1] as const) {
      const ahead = many.filter((seed) => Math.sign(pickLeg(para, { surface: 5, x: 400, facing }, all, clear, seeded(seed))!.to.x - 400) === facing)
      expect(ahead.length, `facing ${facing}`).toBeGreaterThan(many.length * 0.65)
    }
  })

  it('leaves an island: from a Work line with no line a step away, most legs go elsewhere', () => {
    const away = seeds.filter((seed) => {
      const leg = pickLeg(t, { surface: 4, x: 400 }, all, clear, seeded(seed))!
      return surfaces[leg.to.surface]!.flow !== 'work-0'
    })
    expect(away.length).toBeGreaterThan(seeds.length / 2)
  })

  it('goes either way along a line far enough above', () => {
    const many = Array.from({ length: 80 }, (_, i) => i + 1)
    const to = many.map((seed) => pickLeg(t, { surface: 4, x: 400 }, all, clear, seeded(seed))!.to).filter((p) => p.surface <= 2)
    expect(to.some((p) => p.x < 400)).toBe(true)
    expect(to.some((p) => p.x > 400)).toBe(true)
  })

  it('is null with nowhere far enough in view', () => {
    // only the short line is in view, and none of it is MIN_LEG from its middle
    const view: Rect = { x0: 0, y0: 149 - walkerReach().height * SCALE - 10, x1: 800, y1: 160 }
    for (const seed of seeds) expect(pickLeg(t, { surface: 3, x: 175 }, view, clear, seeded(seed))).toBeNull()
  })

  it('only goes where the route is clear', () => {
    // no hop is allowed: it can only walk along its own line
    const walkOnly: RouteChecks = { ...clear, hop: () => false }
    for (const seed of seeds) {
      const leg = pickLeg(t, { surface: 0, x: 150 }, all, walkOnly, seeded(seed))
      if (leg) expect(leg.moves.every((m) => m.kind === 'walk' && m.surface === 0)).toBe(true)
    }
  })

  it('is the same leg for the same random numbers', () => {
    const from = { surface: 2, x: 300 }
    expect(pickLeg(t, from, all, clear, seeded(7))).toEqual(pickLeg(t, from, all, clear, seeded(7)))
  })
})

describe('restFor', () => {
  it('stands between REST_S[0] and REST_S[1] seconds', () => {
    expect(restFor(() => 0)).toBe(REST_S[0])
    expect(restFor(() => 0.999999)).toBeCloseTo(REST_S[1], 4)
    expect(restFor(() => 0.5)).toBeCloseTo((REST_S[0] + REST_S[1]) / 2, 6)
  })
})
