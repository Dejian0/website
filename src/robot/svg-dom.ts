import type { Vec2 } from './model.ts'
import { bounds, fillColor, pathData, SHADOW, strokeColor, type Polygon } from './render.ts'

const SVGNS = 'http://www.w3.org/2000/svg'
const PAD = 2 // px of room around the drawing for its strokes

/** The robot's ground shadow: its footprint (render.ts groundShadow, px) and blur radius, px. */
export interface Shadow { pts: Vec2[]; blur: number }

/**
 * The live robot: an SVG sized to the drawing, moved with a transform, with one pooled
 * <path> per polygon over one for its ground shadow. Paths are in drawing coordinates (origin =
 * ground point), so a body that only moves keeps its path data, and every attribute is written
 * only when it changed. The shadow's blur spills past the SVG's box, which the CSS lets show.
 */
export class RobotSvg {
  readonly el: SVGSVGElement
  private readonly paths: SVGPathElement[] = []
  private readonly drawn: { d: string; stroke: string; fill: string; width: string; shown: boolean }[] = []
  private readonly shadow: SVGPathElement
  private readonly blur: SVGFEGaussianBlurElement
  private shadowWas = { d: '', blur: '', opacity: '' }
  private box = ''
  private at = ''

  constructor(layer: HTMLElement) {
    this.el = document.createElementNS(SVGNS, 'svg')
    this.el.setAttribute('aria-hidden', 'true')
    const filter = document.createElementNS(SVGNS, 'filter')
    filter.id = 'robot-live-shadow'
    for (const [k, v] of [['x', '-50%'], ['y', '-50%'], ['width', '200%'], ['height', '200%']]) filter.setAttribute(k!, v!)
    this.blur = document.createElementNS(SVGNS, 'feGaussianBlur')
    filter.append(this.blur)
    const defs = document.createElementNS(SVGNS, 'defs')
    defs.append(filter)
    this.shadow = document.createElementNS(SVGNS, 'path')
    this.shadow.setAttribute('class', 'robot-shadow')
    this.shadow.setAttribute('fill', '#000')
    this.shadow.setAttribute('filter', 'url(#robot-live-shadow)')
    this.shadow.setAttribute('display', 'none')
    this.shadow.setAttribute('aria-hidden', 'true') // as the faces: the drawing says nothing
    this.el.append(defs, this.shadow)
    layer.append(this.el)
  }

  /**
   * Draws `polys` (px, from project()) with their origin at page (x, y), `stroke` px wide,
   * filled at `shade` (render.ts fillColor; 0, white, by default) over `shadow` at that shade.
   */
  draw(polys: Polygon[], stroke: number, x: number, y: number, shade = 0, shadow?: Shadow): void {
    const b = bounds(polys)
    const x0 = Math.floor(b.minX) - PAD
    const y0 = Math.floor(b.minY) - PAD
    const w = Math.ceil(b.maxX) + PAD - x0
    const h = Math.ceil(b.maxY) + PAD - y0
    const box = `${x0} ${y0} ${w} ${h}`
    if (box !== this.box) {
      this.el.setAttribute('viewBox', box)
      this.el.setAttribute('width', String(w))
      this.el.setAttribute('height', String(h))
      this.box = box
    }
    const at = `translate(${(x + x0).toFixed(2)}px, ${(y + y0).toFixed(2)}px)`
    if (at !== this.at) {
      this.el.style.transform = at
      this.at = at
    }
    this.drawShadow(shadow && shade > 0 ? shadow : null, shade)
    const width = String(stroke)
    polys.forEach((p, i) => {
      const path = this.path(i)
      const was = this.drawn[i]!
      const d = pathData(p)
      const color = strokeColor(p)
      const fill = fillColor(p, shade)
      if (d !== was.d) path.setAttribute('d', (was.d = d))
      if (color !== was.stroke) path.setAttribute('stroke', (was.stroke = color))
      if (fill !== was.fill) path.setAttribute('fill', (was.fill = fill))
      if (width !== was.width) path.setAttribute('stroke-width', (was.width = width))
      if (!was.shown) {
        path.removeAttribute('display')
        was.shown = true
      }
    })
    for (let i = polys.length; i < this.paths.length; i++) {
      if (!this.drawn[i]!.shown) continue
      this.paths[i]!.setAttribute('display', 'none')
      this.drawn[i]!.shown = false
    }
  }

  /** The ground shadow at `shade`, or none. */
  private drawShadow(s: Shadow | null, shade: number): void {
    const was = this.shadowWas
    if (!s) {
      if (was.opacity !== '') this.shadow.setAttribute('display', 'none')
      was.opacity = ''
      return
    }
    const d = pathData(s)
    const blur = s.blur.toFixed(2)
    const opacity = (SHADOW.opacity * Math.min(1, shade)).toFixed(3)
    if (d !== was.d) this.shadow.setAttribute('d', (was.d = d))
    if (blur !== was.blur) this.blur.setAttribute('stdDeviation', (was.blur = blur))
    if (opacity !== was.opacity) {
      if (was.opacity === '') this.shadow.removeAttribute('display')
      this.shadow.setAttribute('opacity', (was.opacity = opacity))
    }
  }

  private path(i: number): SVGPathElement {
    let path = this.paths[i]
    if (!path) {
      path = document.createElementNS(SVGNS, 'path')
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      path.setAttribute('aria-hidden', 'true') // the drawing itself says nothing, whatever role the SVG gets
      this.el.append(path)
      this.paths.push(path)
      this.drawn.push({ d: '', stroke: '', fill: '', width: '', shown: true })
    }
    return path
  }
}
