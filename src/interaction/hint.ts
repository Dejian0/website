// The small grey mono label that says what the robot will do. Where the page has a margin (wide
// screens) it sits in it, beside the robot's line. Where it has none (phones, tablets) it sits in
// the gap between paragraphs or sections nearest the robot, at the column's left edge. Never
// over text or the robot.
import type { Rect } from '../terrain/terrain.ts'

const GAP = 24 // px between the hint and the text column, in the margin
const EDGE = 8 // px it keeps from the viewport's left edge

/**
 * The vertical gaps (page px, [top, bottom]) at least h tall between the boxes that reach into
 * page x [x0, x1], and the open space below the last one.
 */
export function freeBands(boxes: Rect[], x0: number, x1: number, h: number): [number, number][] {
  const ys = boxes.filter((r) => r.x1 > x0 && r.x0 < x1 && r.y1 > r.y0).sort((a, b) => a.y0 - b.y0)
  const out: [number, number][] = []
  let bottom = -Infinity
  for (const r of ys) {
    if (bottom > -Infinity && r.y0 - bottom >= h) out.push([bottom, r.y0])
    bottom = Math.max(bottom, r.y1)
  }
  if (bottom > -Infinity) out.push([bottom, Infinity])
  return out
}

const AIR = 2 // px the hint keeps from the robot and a band's edges

/**
 * The top (page px) of an h px tall hint across x [x0, x1] in the band nearest page y: centred
 * in it, or moved up or down within it to keep clear of the robot's silhouette; null if no band
 * has room.
 */
export function nearestBand(bands: [number, number][], h: number, y: number, robot: Rect, x0: number, x1: number): number | null {
  const beside = !(x1 > robot.x0 && x0 < robot.x1)
  let best: number | null = null
  const consider = (top: number) => {
    if (best === null || Math.abs(top + h / 2 - y) < Math.abs(best + h / 2 - y)) best = top
  }
  for (const [a, b] of bands) {
    const centre = b === Infinity ? a + h / 2 : (a + b - h) / 2
    if (beside || centre + h <= robot.y0 - AIR || centre >= robot.y1 + AIR) {
      consider(centre)
      continue
    }
    const above = robot.y0 - AIR - h
    const below = robot.y1 + AIR
    if (above >= a + AIR) consider(above)
    if (below + h <= b - AIR) consider(below)
  }
  return best
}

export class Hint {
  readonly el: HTMLDivElement
  private text: string | null = null
  private size = { w: 0, h: 0 } // measured when the text changes, never per frame
  private bands: { for: Rect[] | null; w: number; list: [number, number][] } = { for: null, w: 0, list: [] }
  private drawn = { at: '', shown: false }

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'robot-hint'
    this.el.setAttribute('aria-hidden', 'true') // the robot button's name says the same to assistive tech
    this.el.style.visibility = 'hidden'
    document.body.append(this.el)
  }

  /** The text to show, or null to hide it. */
  set(text: string | null): void {
    if (text === this.text) return
    this.text = text
    if (text === null) return
    this.el.textContent = text
    this.size = { w: this.el.offsetWidth, h: this.el.offsetHeight }
  }

  /**
   * Places it for the robot's silhouette `sil` (page px) beside a text column starting at page x
   * `column`, whose text (every line's box, page px) is `text`, and shows it if it has text and
   * `live` (the robot stands in the text).
   */
  place(sil: Rect, column: number, text: Rect[], live: boolean): void {
    const { w, h } = this.size
    const body = sil.y0 + 0.3 * (sil.y1 - sil.y0)
    let x = column - GAP - w
    let y: number | null = body - h / 2
    if (x < EDGE) {
      // no margin: the nearest gap in the text, at the column's edge
      if (this.bands.for !== text || this.bands.w !== w) this.bands = { for: text, w, list: freeBands(text, column, column + w, h + 4) }
      x = column
      y = nearestBand(this.bands.list, h, body, sil, x, x + w)
    }
    const shown = this.text !== null && live && y !== null
    const d = this.drawn
    if (shown !== d.shown) this.el.style.visibility = (d.shown = shown) ? '' : 'hidden'
    if (!shown) return
    const at = `translate(${x.toFixed(1)}px, ${y!.toFixed(1)}px)`
    if (at !== d.at) this.el.style.transform = d.at = at
  }
}
