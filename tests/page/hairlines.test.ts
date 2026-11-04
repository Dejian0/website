import { describe, expect, it } from 'vitest'
import { gapIn, GAP_PAD } from '../../src/page/hairlines.ts'

// a hairline under a list row, and the robot drawn over [x0, x1] from its top y0 to its feet y1
const line = { x0: 100, x1: 740, y: 300 }
const sil = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })

describe('hairline gaps', () => {
  it('opens across the robot, and a little more, where the line crosses it', () => {
    expect(gapIn(line, sil(400, 280, 458, 319))).toEqual([400 - GAP_PAD, 458 + GAP_PAD])
  })

  it('keeps the line it stands on whole', () => {
    expect(gapIn(line, sil(400, 261, 458, 300))).toBeNull() // its feet on the line
    expect(gapIn(line, sil(400, 262, 458, 300.6))).toBeNull() // or not quite clear of it
  })

  it('keeps a line it is not over whole', () => {
    expect(gapIn(line, sil(400, 301, 458, 340))).toBeNull() // below the line
    expect(gapIn(line, sil(400, 240, 458, 279))).toBeNull() // above it, as on a row higher up
    expect(gapIn(line, sil(10, 280, 68, 319))).toBeNull() // beside its start
    expect(gapIn(line, null)).toBeNull() // drawn nowhere in the text
  })

  it('opens no further than the line runs', () => {
    expect(gapIn(line, sil(80, 280, 138, 319))).toEqual([100, 138 + GAP_PAD])
    expect(gapIn(line, sil(700, 280, 758, 319))).toEqual([700 - GAP_PAD, 740])
  })
})
