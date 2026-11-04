import { describe, expect, it } from 'vitest'
import { freeBands, nearestBand } from '../../src/interaction/hint.ts'
import type { Rect } from '../../src/terrain/terrain.ts'

const box = (y0: number, y1: number, x0 = 20, x1 = 300): Rect => ({ x0, y0, x1, y1 })

describe('hint bands', () => {
  // two paragraphs of 35px lines with a 22px gap, a heading further down, and a short word to the right
  const text = [box(100, 135), box(135, 170), box(192, 227), box(300, 316, 20, 80), box(320, 340, 250, 300)]

  it('finds the gaps between text across the hint’s width, tall enough for it', () => {
    expect(freeBands(text, 20, 200, 16)).toEqual([
      [170, 192],
      [227, 300],
      [316, Infinity],
    ])
    // the short word on the right only matters where the hint would reach it
    expect(freeBands(text, 20, 280, 16)).toEqual([
      [170, 192],
      [227, 300],
      [316, 320],
      [340, Infinity],
    ].filter(([a, b]) => b - a >= 16))
    expect(freeBands(text, 20, 200, 30)).toEqual([
      [227, 300],
      [316, Infinity],
    ])
  })

  it('picks the band nearest the robot that keeps clear of it', () => {
    const bands: [number, number][] = [
      [170, 192],
      [227, 300],
    ]
    const robot = { x0: 30, y0: 160, x1: 90, y1: 192 } // standing on the second paragraph's first line, reaching into the gap
    expect(nearestBand(bands, 16, 200, { x0: 400, y0: 160, x1: 460, y1: 192 }, 20, 200)).toBe(173) // beside it, the gap is fine
    expect(nearestBand(bands, 16, 200, robot, 20, 200)).toBe(255.5) // over it, the next one
    expect(nearestBand([[170, 192]], 16, 200, robot, 20, 200)).toBeNull()
  })

  it('moves up or down within a band to clear the robot', () => {
    // the robot stands on the first line below a tall gap, its head in the gap: the hint goes above it
    const robot = { x0: 20, y0: 333, x1: 65, y1: 362 }
    expect(nearestBand([[293, 362]], 16, 345, robot, 22, 105)).toBe(333 - 2 - 16)
    // its feet in a gap below: the hint goes under it
    expect(nearestBand([[300, 400]], 16, 320, { x0: 20, y0: 290, x1: 65, y1: 345 }, 22, 105)).toBe(345 + 2)
  })
})
