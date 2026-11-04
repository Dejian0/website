import type { PaintedLine } from '../../src/text/flow.ts'
import type { Rect } from '../../src/terrain/terrain.ts'

const ys = [0, 46, 92, 258, 304, 350]
export const lines: PaintedLine[] = ys.map((y, i) => ({
  flow: i < 3 ? 'bio-0' : 'work-0',
  index: i < 3 ? i : i - 3,
  x: 0,
  y,
  width: 600,
  lineHeight: 46,
  words: [],
}))
export const obstacles: Rect[] = [{ x0: 0, y0: 210, x1: 600, y1: 250 }]
export const GLYPH_TOP = 10
export const BODY = 40
