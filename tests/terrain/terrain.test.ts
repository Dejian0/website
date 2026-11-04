import { describe, expect, it } from 'vitest'
import { buildSurfaces, nearestPoint } from '../../src/terrain/terrain.ts'
import { BODY, GLYPH_TOP, lines, obstacles } from './fixture.ts'

describe('terrain', () => {
  const s = buildSurfaces(lines, obstacles, BODY, GLYPH_TOP)
  it('standable unless DOM above', () => {
    expect(s.map((x) => x.standable)).toEqual([true, true, true, false, true, true])
  })
  it('surface y is top of glyphs', () => {
    expect(s[1].y).toBe(56)
    expect(s[1]).toMatchObject({ flow: 'bio-0', line: 1, x0: 0, x1: 600 })
  })
  it('blocked first line', () => {
    expect(s[3].standable).toBe(false)
  })
  it('obstacle beside the span does not block', () => {
    const side = buildSurfaces(lines, [{ x0: 700, y0: 210, x1: 800, y1: 250 }], BODY, GLYPH_TOP)
    expect(side[3].standable).toBe(true)
  })
  it('partial obstacle over the band blocks the whole surface', () => {
    const part = buildSurfaces(lines, [{ x0: 250, y0: 210, x1: 300, y1: 250 }], BODY, GLYPH_TOP)
    expect(part[3].standable).toBe(false)
  })
  it('minWidth makes narrow spans unstandable', () => {
    const narrow = lines.map((l, i) => (i === 1 ? { ...l, width: 30 } : l))
    const r = buildSurfaces(narrow, obstacles, BODY, GLYPH_TOP, 50)
    expect(r[1].standable).toBe(false)
    expect(r[0].standable).toBe(true)
  })
  it('glyph top can differ per line', () => {
    const r = buildSurfaces(lines, [], BODY, (l) => (l.flow === 'bio-0' ? 11 : 6))
    expect(r.map((x) => x.y)).toEqual([11, 57, 103, 264, 310, 356])
  })
  it('nearestPoint clamps', () => {
    expect(nearestPoint(s, 900, 50)).toEqual({ surface: 1, x: 600 })
  })
  it('nearestPoint skips unstandable', () => {
    expect(nearestPoint(s, 300, 268)?.surface).not.toBe(3)
  })
  it('nearestPoint with nothing standable is null', () => {
    expect(nearestPoint([], 0, 0)).toBeNull()
  })
})
