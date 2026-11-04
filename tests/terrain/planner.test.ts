import { describe, expect, it } from 'vitest'
import { buildSurfaces } from '../../src/terrain/terrain.ts'
import { nearestReachable, planPath, type HopFilter, type Limits, type Move } from '../../src/terrain/planner.ts'
import { BODY, GLYPH_TOP, lines, obstacles } from './fixture.ts'

const s = buildSurfaces(lines, obstacles, BODY, GLYPH_TOP)
const lim: Limits = { maxStep: 60, maxLeap: 80, maxJump: 300 }
const tight: Limits = { maxStep: 60, maxLeap: 80, maxJump: 60 }

describe('planner', () => {
  it('same line is one walk', () => {
    expect(planPath(s, { surface: 0, x: 10 }, { surface: 0, x: 300 }, lim)).toEqual([
      { kind: 'walk', surface: 0, toX: 300 },
    ])
  })
  it('down two lines', () => {
    const m = planPath(s, { surface: 0, x: 100 }, { surface: 2, x: 100 }, lim)!
    expect(m.every((x) => x.kind === 'walk' || x.kind === 'step')).toBe(true)
    let dy = 0
    for (const x of m) if (x.kind !== 'walk') dy += s[x.to.surface].y - s[x.from.surface].y
    expect(dy).toBe(92)
  })
  it('never teleports', () => {
    const m = planPath(s, { surface: 0, x: 100 }, { surface: 5, x: 50 }, lim)!
    expect(m).not.toBeNull()
    for (const x of m as Move[]) {
      if (x.kind === 'walk') continue
      expect(Math.abs(s[x.to.surface].y - s[x.from.surface].y)).toBeLessThanOrEqual(lim.maxJump)
      expect(Math.abs(x.to.x - x.from.x)).toBeLessThanOrEqual(lim.maxLeap)
    }
  })
  it('jumps between flows when allowed', () => {
    const m = planPath(s, { surface: 2, x: 100 }, { surface: 4, x: 100 }, lim)!
    expect(m.some((x) => x.kind === 'jump')).toBe(true)
  })
  it('unreachable is null', () => {
    expect(planPath(s, { surface: 0, x: 0 }, { surface: 4, x: 0 }, tight)).toBeNull()
  })
  it('unstandable target is null', () => {
    expect(planPath(s, { surface: 0, x: 0 }, { surface: 3, x: 0 }, lim)).toBeNull()
  })
  it('is deterministic', () => {
    const a = planPath(s, { surface: 0, x: 100 }, { surface: 5, x: 50 }, lim)
    const b = planPath(s, { surface: 0, x: 100 }, { surface: 5, x: 50 }, lim)
    expect(a).toEqual(b)
  })
  it('leaps from line end to next line start', () => {
    const offset = buildSurfaces(
      lines.slice(0, 2).map((l, i) => (i === 1 ? { ...l, x: 700 } : l)),
      [],
      BODY,
      GLYPH_TOP,
    )
    const m = planPath(offset, { surface: 0, x: 590 }, { surface: 1, x: 710 }, { maxStep: 60, maxLeap: 200, maxJump: 60 })!
    expect(m.find((x) => x.kind !== 'walk')?.kind).toBe('leap')
  })
  it('nearestReachable falls back', () => {
    const r = nearestReachable(s, { surface: 0, x: 0 }, 300, 310, tight)!
    expect(r.to.surface).toBeLessThanOrEqual(2)
    expect(r.moves.length).toBeGreaterThan(0)
  })
  describe('leap bound', () => {
    const disjoint = (gapEnd: number) =>
      buildSurfaces(
        [
          { ...lines[0], width: 100 },
          { ...lines[1], index: 1, x: gapEnd, width: 100 },
        ],
        [],
        BODY,
        GLYPH_TOP,
      )
    it('no leap when the gap exceeds maxLeap', () => {
      const d = disjoint(400)
      expect(planPath(d, { surface: 0, x: 50 }, { surface: 1, x: 450 }, { maxStep: 60, maxLeap: 80, maxJump: 60 })).toBeNull()
    })
    it('leaps when the gap is within maxLeap', () => {
      const d = disjoint(400)
      const m = planPath(d, { surface: 0, x: 50 }, { surface: 1, x: 450 }, { maxStep: 60, maxLeap: 300, maxJump: 60 })!
      expect(m.find((x) => x.kind !== 'walk')?.kind).toBe('leap')
    })
  })

  describe('hop filter', () => {
    it('a vetoed step is taken from another spot along the overlap', () => {
      const allow: HopFilter = (_kind, from) => from.x >= 300
      const m = planPath(s, { surface: 0, x: 100 }, { surface: 2, x: 100 }, lim, allow)!
      expect(m).not.toBeNull()
      const hops = m.filter((x) => x.kind !== 'walk') as Extract<Move, { from: unknown }>[]
      expect(hops.length).toBe(2)
      for (const h of hops) expect(h.from.x).toBeGreaterThanOrEqual(300)
      expect(m.at(-1)).toEqual({ kind: 'walk', surface: 2, toX: 100 })
    })
    it('every hop on the route passed the filter, as planned', () => {
      const seen: string[] = []
      const allow: HopFilter = (kind, from, to) => {
        seen.push(`${kind} ${from.surface}:${from.x} ${to.surface}:${to.x}`)
        return from.x % 2 === 0 // vetoes every odd x
      }
      const m = planPath(s, { surface: 0, x: 101 }, { surface: 5, x: 51 }, lim, allow)!
      expect(m).not.toBeNull()
      for (const h of m) if (h.kind !== 'walk') expect(seen).toContain(`${h.kind} ${h.from.surface}:${h.from.x} ${h.to.surface}:${h.to.x}`)
      for (const h of m) if (h.kind !== 'walk') expect(h.from.x % 2).toBe(0)
    })
    it('with every hop vetoed only the robot’s own surface is reachable', () => {
      expect(planPath(s, { surface: 0, x: 100 }, { surface: 1, x: 100 }, lim, () => false)).toBeNull()
      expect(nearestReachable(s, { surface: 0, x: 100 }, 300, 310, lim, () => false)).toEqual({
        to: { surface: 0, x: 300 },
        moves: [{ kind: 'walk', surface: 0, toX: 300 }],
      })
    })
    it('a costed spot is taken only when no free one is', () => {
      const pricey: HopFilter = (_kind, from) => (from.x < 300 ? 1e5 : true)
      const m = planPath(s, { surface: 0, x: 100 }, { surface: 1, x: 100 }, lim, pricey)!
      expect((m.find((x) => x.kind === 'step') as Extract<Move, { from: unknown }>).from.x).toBe(300)
      // all costed: still a route, from the nearest spot
      const all = planPath(s, { surface: 0, x: 100 }, { surface: 1, x: 100 }, lim, () => 1e5)!
      expect(all).toEqual([{ kind: 'step', from: { surface: 0, x: 100 }, to: { surface: 1, x: 100 } }])
    })
    it('a costed hop loses to a longer free route, but keeps the target reachable', () => {
      const three = [
        { id: 0, flow: 'a', line: 0, x0: 0, x1: 300, y: 0, standable: true },
        { id: 1, flow: 'b', line: 0, x0: 0, x1: 300, y: 200, standable: true },
        { id: 2, flow: 'c', line: 0, x0: 0, x1: 300, y: 100, standable: true },
      ]
      const wide = { maxStep: 60, maxLeap: 80, maxJump: 300 }
      const direct = (k: string, a: { surface: number }, b: { surface: number }) => (a.surface === 0 && b.surface === 1 ? 1e5 : true)
      const via = planPath(three, { surface: 0, x: 50 }, { surface: 1, x: 50 }, wide, direct)!
      expect(via.filter((x) => x.kind !== 'walk').map((x) => (x as Extract<Move, { to: unknown }>).to.surface)).toEqual([2, 1])
      // with the free way vetoed, the costed hop still gets there
      const only = planPath(three, { surface: 0, x: 50 }, { surface: 1, x: 50 }, wide, (k, a, b) => (b.surface === 2 ? false : direct(k, a, b)))!
      expect(only).toEqual([{ kind: 'jump', from: { surface: 0, x: 50 }, to: { surface: 1, x: 50 } }])
    })
    it('a vetoed leap is not taken', () => {
      const offset = buildSurfaces(
        lines.slice(0, 2).map((l, i) => (i === 1 ? { ...l, x: 700 } : l)),
        [],
        BODY,
        GLYPH_TOP,
      )
      const wide = { maxStep: 60, maxLeap: 200, maxJump: 60 }
      expect(planPath(offset, { surface: 0, x: 590 }, { surface: 1, x: 710 }, wide, (kind) => kind !== 'leap')).toBeNull()
    })
  })

  describe('stride', () => {
    const along = { ...lim, stride: 20 }
    const hops = (m: Move[]) => m.filter((x) => x.kind !== 'walk') as Extract<Move, { from: unknown }>[]

    it('a step between overlapping lines lands a stride along, the way the robot is going', () => {
      const right = hops(planPath(s, { surface: 0, x: 100 }, { surface: 2, x: 400 }, along)!)
      expect(right.map((h) => [h.from.x, h.to.x])).toEqual([
        [100, 120],
        [120, 140],
      ])
      // facing left, it steps left; having walked left to a spot, it keeps going left
      const left = hops(planPath(s, { surface: 0, x: 100, facing: -1 }, { surface: 2, x: 50 }, along)!)
      expect(left[0]).toMatchObject({ from: { x: 100 }, to: { x: 80 } })
      const walked = planPath(s, { surface: 0, x: 500 }, { surface: 1, x: 0 }, along, (_k, from) => from.x <= 300)!
      expect(hops(walked)[0]).toMatchObject({ from: { x: 300 }, to: { x: 280 } })
    })

    it('the other way at the end of the line it lands on', () => {
      const end = hops(planPath(s, { surface: 0, x: 600 }, { surface: 1, x: 500 }, along)!)
      expect(end[0]).toMatchObject({ from: { x: 600 }, to: { x: 580 } })
    })

    it('without one, a step goes straight down, as before', () => {
      expect(hops(planPath(s, { surface: 0, x: 100 }, { surface: 1, x: 100 }, lim)!)[0]).toMatchObject({ from: { x: 100 }, to: { x: 100 } })
    })
  })

  describe('a priced spot', () => {
    const step = (m: Move[]) => m.find((x) => x.kind === 'step') as Extract<Move, { from: unknown }>
    const at = (price: (x: number) => number, start: number, goal: number) =>
      step(planPath(s, { surface: 0, x: start }, { surface: 1, x: goal }, lim, (_k, from) => price(from.x))!).from.x

    it('is chosen by its price plus the walk there and back to where the robot is going', () => {
      expect(at((x) => 100 + 0.5 * x, 500, 500)).toBe(500) // cheaper far off, but not by the walk there
      expect(at((x) => 100 + 1.5 * x, 500, 500)).toBe(500) // by more than the walk there, but not there and back
      expect(at((x) => 100 + 3 * x, 500, 500)).toBe(0) // by more than the walk there and back
    })

    it('along the way to where the robot is going costs no walk', () => {
      // cheaper the further along, and walking there is on the way: it takes off as far along as it can
      expect(at((x) => 200 - x / 4, 0, 600)).toBe(600)
      // the same toward a click (nearestReachable)
      const r = nearestReachable(s, { surface: 0, x: 0 }, 600, 50, lim, (_k, from) => 200 - from.x / 4)!
      expect(r.to).toEqual({ surface: 1, x: 600 })
      expect(step(r.moves).from.x).toBe(600)
    })

    it('may turn round to land the other way, where that costs less', () => {
      // a price that only a step landing left of its spot avoids, from a spot reached walking right
      const along = { ...lim, stride: 20 }
      const m = planPath(s, { surface: 0, x: 300 }, { surface: 1, x: 300 }, along, (_k, from, to) => (to.x < from.x ? 10 : 500))!
      expect(step(m)).toMatchObject({ from: { x: 300 }, to: { x: 280 } })
    })
  })

  it('two pieces of one line are not joined, even where they overlap', () => {
    // pieces of the same line are split by a stretch the robot can't stand on
    const pieces = [
      { id: 0, flow: 'bio-0', line: 0, x0: 0, x1: 100, y: 10, standable: true },
      { id: 1, flow: 'bio-0', line: 0, x0: 80, x1: 200, y: 10, standable: true },
    ]
    expect(planPath(pieces, { surface: 0, x: 50 }, { surface: 1, x: 150 }, lim)).toBeNull()
    expect(nearestReachable(pieces, { surface: 0, x: 50 }, 150, 10, lim)?.to).toEqual({ surface: 0, x: 100 })
  })
})
