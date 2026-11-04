import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathOverlay, pathLength, pathPolyline } from '../../src/interaction/path-overlay.ts'
import type { Move } from '../../src/terrain/planner.ts'
import type { Surface } from '../../src/terrain/terrain.ts'

const surf = (id: number, line: number, y: number, flow = 'bio-0'): Surface => ({ id, flow, line, x0: 100, x1: 700, y, standable: true })
const s: Surface[] = [surf(0, 0, 11), surf(1, 1, 57), surf(2, 0, 300, 'work-0')]
const moves: Move[] = [
  { kind: 'walk', surface: 0, toX: 400 },
  { kind: 'step', from: { surface: 0, x: 400 }, to: { surface: 1, x: 400 } },
  { kind: 'walk', surface: 1, toX: 650 },
  { kind: 'jump', from: { surface: 1, x: 650 }, to: { surface: 2, x: 690 } },
  { kind: 'walk', surface: 2, toX: 200 },
]

describe('path overlay', () => {
  it('polyline starts at robot', () => {
    const p = pathPolyline(moves, s, { surface: 0, x: 120 })
    expect(p[0]).toEqual([120, 11])
    expect(p.at(-1)).toEqual([200, 300])
    expect(p).toEqual([
      [120, 11],
      [400, 11],
      [400, 57],
      [650, 57],
      [690, 300],
      [200, 300],
    ])
  })

  it('ends at a final hop’s landing', () => {
    const p = pathPolyline(moves.slice(0, 2), s, { surface: 0, x: 120 })
    expect(p[0]).toEqual([120, 11])
    expect(p.at(-1)).toEqual([400, 57])
  })

  it('follows each hop’s arc when given one', () => {
    const arc = (a: { x: number }, b: { x: number }) => [[(a.x + b.x) / 2, 0] as [number, number]]
    const p = pathPolyline(moves, s, { surface: 0, x: 120 }, (m) => arc(m.from, m.to))
    expect(p).toEqual([
      [120, 11],
      [400, 11],
      [400, 0],
      [400, 57],
      [650, 57],
      [670, 0],
      [690, 300],
      [200, 300],
    ])
  })

  it('with nothing to do it is the robot’s own point', () => {
    expect(pathPolyline([], s, { surface: 1, x: 300 })).toEqual([[300, 57]])
  })

  it('measures its length', () => {
    expect(pathLength([[0, 0], [3, 4], [3, 10]])).toBe(11)
    expect(pathLength([[5, 5]])).toBe(0)
  })
})

// The overlay against a stand-in document that records every DOM write.
describe('path overlay drawing', () => {
  afterEach(() => vi.unstubAllGlobals())
  const fakeDom = () => {
    const writes: string[] = []
    const element = () => ({
      style: new Proxy({} as Record<string, string>, {
        set: (o, k, v) => {
          writes.push(`style.${String(k)}`)
          o[k as string] = v
          return true
        },
      }),
      id: '',
      setAttribute: (name: string) => writes.push(name),
      append: () => {},
    })
    vi.stubGlobal('document', { createElementNS: element })
    return writes
  }

  it('clearing a path that is already clear writes nothing (session.show clears it every frame)', () => {
    const writes = fakeDom()
    const overlay = new PathOverlay()
    writes.length = 0
    for (let i = 0; i < 5; i++) overlay.clear()
    expect(writes).toEqual([])
  })

  it('draws, then clears once', () => {
    const writes = fakeDom()
    const overlay = new PathOverlay()
    overlay.draw([[0, 0], [10, 0]], 0)
    expect(writes).toContain('d')
    writes.length = 0
    overlay.clear()
    expect(writes).toEqual(['d', 'style.display'])
    writes.length = 0
    overlay.clear()
    overlay.draw([[5, 5]], 0) // too short to draw: clears, already clear
    expect(writes).toEqual([])
  })
})
