import type { PaintedLine } from '../text/flow.ts'

export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** y = top of glyphs, page px. */
export interface Surface { id: number; flow: string; line: number; x0: number; x1: number; y: number; standable: boolean }
export interface TerrainPoint { surface: number; x: number }

/**
 * A surface is standable when no obstacle rect (non-painted DOM) intersects the band
 * [y - bodyHeight, y] above it across its span. Painted text in the band is fine: it
 * parts around the robot. A span narrower than minWidth is never standable. `glyphTop`
 * is how far the glyph tops sit below the line box top, per line when fonts differ.
 */
export function buildSurfaces(
  lines: PaintedLine[],
  obstacles: Rect[],
  bodyHeight: number,
  glyphTop: number | ((line: PaintedLine) => number),
  minWidth = 0,
): Surface[] {
  return lines.map((l, id) => {
    const y = l.y + (typeof glyphTop === 'number' ? glyphTop : glyphTop(l))
    const x0 = l.x
    const x1 = l.x + l.width
    const blocked = obstacles.some((o) => o.x0 < x1 && o.x1 > x0 && o.y0 < y && o.y1 > y - bodyHeight)
    return { id, flow: l.flow, line: l.index, x0, x1, y, standable: !blocked && x1 - x0 >= minWidth }
  })
}

/** Closest standable point to a page position; x is clamped into the surface span. */
export function nearestPoint(s: Surface[], x: number, y: number): TerrainPoint | null {
  let best: TerrainPoint | null = null
  let bestD = Infinity
  for (const f of s) {
    if (!f.standable) continue
    const cx = Math.min(Math.max(x, f.x0), f.x1)
    const d = (x - cx) ** 2 + (y - f.y) ** 2
    if (d < bestD) {
      bestD = d
      best = { surface: f.id, x: cx }
    }
  }
  return best
}
