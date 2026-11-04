// The hairlines under the headings and the list rows. The robot is drawn in front of them, but its
// white faces multiply with what is under them (style.css), so it never hides one by itself: each
// line is drawn by its element's ::after, and opens where the robot is drawn over it.
import type { Interval } from '../terrain/clearance.ts'
import type { Rect } from '../terrain/terrain.ts'

/** A hairline, page px: its top edge y, from x0 to x1 (1px tall). */
export interface Hairline { x0: number; x1: number; y: number }

export const GAP_PAD = 2 // px a line opens past the robot's drawing on each side

/**
 * Where `line` opens for the robot drawn over `sil` (page px): across the drawing, where the line
 * crosses it. Null where it does not, as for the line under its feet (the drawing ends there).
 */
export function gapIn(line: Hairline, sil: Rect | null): Interval | null {
  if (!sil || !(line.y > sil.y0 && line.y + 1 < sil.y1)) return null
  const a = Math.max(line.x0, sil.x0 - GAP_PAD)
  const b = Math.min(line.x1, sil.x1 + GAP_PAD)
  return a < b ? [a, b] : null
}

/** The elements whose bottom border is a hairline (style.css draws it in their ::after). */
export const HAIRLINES = '.sec > h2, .edu-item, .skills > li'

/** An element's hairline (its bottom border), page px; null if it has none. */
export function hairlineOf(e: Element): Hairline | null {
  const border = parseFloat(getComputedStyle(e).borderBottomWidth) || 0
  if (border <= 0) return null
  const r = e.getBoundingClientRect()
  return { x0: r.left + scrollX, x1: r.right + scrollX, y: r.bottom + scrollY - border }
}

interface Shown { el: HTMLElement; line: Hairline; gap: Interval | null }

/** Opens each hairline where the robot is drawn over it (see gapIn), and closes it again after. */
export class Hairlines {
  private all: Shown[] = []

  /** Measures the lines again, every one closed: after a re-layout. */
  measure(): void {
    for (const h of this.all) this.set(h, null)
    this.all = [...document.querySelectorAll<HTMLElement>(HAIRLINES)].flatMap((el) => {
      const line = hairlineOf(el)
      return line ? [{ el, line, gap: null }] : []
    })
  }

  /** Opens the lines for the robot drawn over `sil` (page px); null: it is not in the text. */
  open(sil: Rect | null): void {
    for (const h of this.all) this.set(h, gapIn(h.line, sil))
  }

  private set(h: Shown, gap: Interval | null): void {
    if (h.gap?.[0] === gap?.[0] && h.gap?.[1] === gap?.[1]) return
    h.gap = gap
    if (!gap) {
      h.el.classList.remove('gap')
      h.el.style.removeProperty('--gap-x0')
      h.el.style.removeProperty('--gap-x1')
      return
    }
    h.el.style.setProperty('--gap-x0', `${gap[0] - h.line.x0}px`)
    h.el.style.setProperty('--gap-x1', `${gap[1] - h.line.x0}px`)
    h.el.classList.add('gap')
  }
}
