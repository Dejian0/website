import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { walkerReach, WALKER_PX, WALKER_PX_NARROW } from '../../src/robot/walker.ts'
import { besideRooms, clearSet, clearSurfaces, EDGE, linesIn, PART_PAD, partsCleanly, pathClear, type Clearance } from '../../src/terrain/clearance.ts'
import { nearestReachable, planPath, type Move } from '../../src/terrain/planner.ts'
import type { Surface } from '../../src/terrain/terrain.ts'
import { fitAroundGap } from '../../src/text/split.ts'
import type { PaintedLine } from '../../src/text/flow.ts'

// Line 0 (above) has a long word [100, 220]; line 1 is where the robot stands, reaching line 0.
// The robot spans x ± 20 (+ 5 pad: a 50px gap), 30px tall; 80px of room right of line 0's end.
const words = [
  { x0: 0, x1: 40 },
  { x0: 50, x1: 90 },
  { x0: 100, x1: 220 },
  { x0: 230, x1: 270 },
  { x0: 280, x1: 320 },
]
const line = (index: number, y: number): PaintedLine => ({ flow: 'bio-0', index, x: 0, y, width: 320, lineHeight: 40, words })
const lines = [line(0, 0), line(1, 40)]
const surf = (id: number, y: number): Surface => ({ id, flow: 'bio-0', line: id, x0: 0, x1: 320, y, standable: true })
const surfaces = [surf(0, 10), surf(1, 50)]
const MARGIN = 10
const clearance = (maxX: number): Clearance => ({
  lines,
  bandTop: [10, 50],
  half: 20,
  height: 30,
  pad: 5,
  room: { minX: -5, maxX },
  maxLeftShift: 6,
})

describe('clearance', () => {
  const c = clearance(400)
  const pieces = clearSurfaces(surfaces, c, MARGIN, 30)

  it('a line with nothing above is one piece: wherever the body centre fits on it', () => {
    expect(pieces[0]).toEqual({ ...surfaces[0], x0: MARGIN, x1: 320 - MARGIN })
  })

  it('splits a line into the pieces where the line above parts cleanly', () => {
    const under = pieces.filter((s) => s.line === 1)
    expect(under.length).toBeGreaterThan(1)
    expect(pieces.map((s) => s.id)).toEqual(pieces.map((_, i) => i))
    for (const s of under) {
      expect(s).toMatchObject({ flow: 'bio-0', line: 1, y: 50, standable: true })
      for (let x = s.x0; x <= s.x1; x += 0.05) {
        const f = fitAroundGap(words, x - 25, x + 25, -5, 400)
        expect(f.rightStart, `x ${x}`).toBe(f.leftEnd) // nothing hidden
        expect(f.leftShift, `x ${x}`).toBeLessThanOrEqual(6)
      }
    }
    // under the long word the line above can't part: no piece there
    expect(under.some((s) => s.x0 <= 200 && 200 <= s.x1)).toBe(false)
    expect(partsCleanly(c, 0, 200)).toBe(false)
  })

  it('a line with no clear piece keeps one unstandable surface', () => {
    const r = clearSurfaces(surfaces, clearance(330), MARGIN, 30)
    expect(r.filter((s) => s.line === 1)).toEqual([{ ...surfaces[1], standable: false }])
  })

  it('drops pieces narrower than minWidth', () => {
    const r = clearSurfaces(surfaces, c, MARGIN, 200)
    expect(r.filter((s) => s.line === 1)).toEqual([{ ...surfaces[1], standable: false }])
  })

  it('keeps the body clear of fixed text reaching into the band above (a list heading over its rule)', () => {
    // a rule far below the painted lines: only the fixed text boxes matter there
    const rule: Surface = { id: 0, flow: 'rule-focus', line: 0, x0: 0, x1: 400, y: 300, standable: true }
    const fixed = [
      { x0: 100, y0: 275, x1: 150, y1: 290 }, // in the band [270, 300]: the body centre keeps 25px away
      { x0: 200, y0: 240, x1: 260, y1: 270 }, // ends where the band starts: no matter
      { x0: 300, y0: 300, x1: 350, y1: 320 }, // below the rule: no matter
    ]
    const out = clearSurfaces([rule], c, MARGIN, 30, fixed)
    expect(out.map((s) => [s.x0, s.x1, s.standable])).toEqual([
      [MARGIN, expect.closeTo(75, 1), true],
      [expect.closeTo(175, 1), 400 - MARGIN, true],
    ])
    // with all of it covered, the rule keeps one unstandable surface
    const covered = clearSurfaces([rule], c, MARGIN, 30, [{ x0: 0, y0: 280, x1: 400, y1: 290 }])
    expect(covered).toEqual([{ ...rule, standable: false }])
  })

  it('parts each line within its own room, where it has one', () => {
    // line 0 with text beside it from x 338: its words stay left of 330, as with that room for all
    const own: Clearance = { ...clearance(400), rooms: [{ minX: -5, maxX: 330 }, { minX: -5, maxX: 400 }] }
    expect(clearSet(own, 0)).toEqual(clearSet(clearance(330), 0))
    expect(clearSet(own, 0)).not.toEqual(clearSet(clearance(400), 0))
    for (let x = -80; x <= 420; x += 0.25) expect(partsCleanly(own, 0, x), `x ${x}`).toBe(partsCleanly(clearance(330), 0, x))
  })

  it('clearSet is exactly where partsCleanly holds', () => {
    for (const maxX of [330, 360, 400, 520]) {
      const cc = clearance(maxX)
      const set = clearSet(cc, 0)
      for (let x = -80; x <= 420; x += 0.25) {
        const inSet = set.some(([a, b]) => a <= x && x <= b)
        expect(inSet, `maxX ${maxX} x ${x}`).toBe(partsCleanly(cc, 0, x))
      }
    }
  })

  it('a move must keep every line it passes through parting cleanly', () => {
    // dropping from line 0 to line 1 passes through line 0's band: fine near its start...
    const drop = (x0: number, x1: number) => [
      { x: x0, top: -20, bottom: 10 },
      { x: (x0 + x1) / 2, top: 0, bottom: 30 },
      { x: x1, top: 20, bottom: 50 },
    ]
    expect(pathClear(c, drop(20, 40))).toBe(true)
    // ...but not across the long word, where line 0 can't part
    expect(pathClear(c, drop(60, 200))).toBe(false)
    // a path below every line reaches nothing
    expect(pathClear(c, [{ x: 0, top: 100, bottom: 120 }, { x: 300, top: 100, bottom: 120 }])).toBe(true)
  })

  it('style.css --part-room covers the parting gap and edge at both walker sizes', () => {
    const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')
    const [wide, narrow] = [...css.matchAll(/--part-room:\s*(\d+)px/g)].map((m) => Number(m[1]))
    const need = (scale: number) => 2 * walkerReach().half * scale + 2 * PART_PAD + EDGE
    expect(wide).toBeGreaterThanOrEqual(need(WALKER_PX))
    expect(narrow).toBeGreaterThanOrEqual(need(WALKER_PX_NARROW))
  })

  it('every planned move starts and ends where the robot can stand', () => {
    // three lines: line 1 parts line 0 above it, line 2 parts line 1
    const three = [line(0, 0), line(1, 40), line(2, 80)]
    const c3: Clearance = { ...clearance(400), lines: three, bandTop: [10, 50, 90] }
    const pieces = clearSurfaces([surf(0, 10), surf(1, 50), surf(2, 90)], c3, MARGIN, 30).filter((s) => s.standable)
    const ok = (surface: number, x: number) => {
      const s = pieces.find((p) => p.id === surface)!
      expect(x, `x ${x} on piece ${surface}`).toBeGreaterThanOrEqual(s.x0)
      expect(x, `x ${x} on piece ${surface}`).toBeLessThanOrEqual(s.x1)
      for (const j of linesIn(c3, s.y - c3.height, s.y)) expect(partsCleanly(c3, j, x), `line ${j} at ${x}`).toBe(true)
    }
    const lim = { maxStep: 50, maxLeap: 120, maxJump: 100 }
    let moves = 0
    for (const a of pieces)
      for (const b of pieces) {
        const from = { surface: a.id, x: (a.x0 + a.x1) / 2 }
        const plans: (Move[] | null)[] = [planPath(pieces, from, { surface: b.id, x: b.x1 }, lim)]
        plans.push(nearestReachable(pieces, from, b.x0 - 30, b.y, lim)?.moves ?? null)
        for (const m of plans.flat()) {
          if (!m) continue
          moves++
          if (m.kind === 'walk') ok(m.surface, m.toX)
          else {
            ok(m.from.surface, m.from.x)
            ok(m.to.surface, m.to.x)
          }
        }
      }
    expect(moves).toBeGreaterThan(20)
  })
})

describe('lines side by side, as an Education row: school, degree and dates', () => {
  const at = (flow: string, x: number, y: number, ws: { x0: number; x1: number }[]): PaintedLine => ({
    flow,
    index: 0,
    x,
    y,
    width: ws.at(-1)!.x1,
    lineHeight: 20,
    words: ws,
  })
  const school = at('education-0-school', 0, 0, [{ x0: 0, x1: 60 }, { x0: 65, x1: 120 }])
  const detail = at('education-0-detail', 300, 0, [{ x0: 4, x1: 50 }])
  const dates = at('education-0-dates', 400, 3, [{ x0: 0, x1: 40 }]) // a smaller line box, lower: still beside
  const next = at('education-1-school', 0, 40, [{ x0: 0, x1: 300 }]) // the row below
  const room = { minX: -5, maxX: 1000 }

  it('each line may part only up to the text beside it, less the gap', () => {
    expect(besideRooms([school, detail, dates, next], room, 8)).toEqual([
      { minX: -5, maxX: 296 }, // detail's first word starts at 304
      { minX: 128, maxX: 392 },
      { minX: 358, maxX: 1000 },
      room,
    ])
  })

  it('a line alone, or with only lines above and below it, keeps the room', () => {
    expect(besideRooms([school], room, 8)).toEqual([room])
    expect(besideRooms([school, next], room, 8)).toEqual([room, room])
  })

  it('never widens the room', () => {
    const tight = { minX: 50, maxX: 200 }
    expect(besideRooms([school, detail], tight, 8)).toEqual([tight, { minX: 128, maxX: 200 }])
  })
})
