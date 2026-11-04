// The faint dotted path of a trip: the route the robot's ground point will take, drawn at once
// and eroded from the robot's end as it goes.
import type { Vec2 } from '../robot/model.ts'
import type { Move } from '../terrain/planner.ts'
import type { Surface, TerrainPoint } from '../terrain/terrain.ts'

export type HopMove = Extract<Move, { from: TerrainPoint }>

/**
 * The ground path of `moves` from `from` (page px): the robot's point first, then each move's
 * end on its surface's glyph tops. `arc` gives a hop's points between take-off and landing,
 * so the path follows the arc the robot will fly; without it a hop is a straight segment.
 */
export function pathPolyline(moves: Move[], s: Surface[], from: TerrainPoint, arc?: (m: HopMove) => Vec2[]): Vec2[] {
  const pts: Vec2[] = [[from.x, s[from.surface]!.y]]
  for (const m of moves) {
    if (m.kind === 'walk') pts.push([m.toX, s[m.surface]!.y])
    else pts.push(...(arc?.(m) ?? []), [m.to.x, s[m.to.surface]!.y])
  }
  return pts
}

export function pathLength(pts: Vec2[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
  return n
}

const SVGNS = 'http://www.w3.org/2000/svg'
const PAD = 2 // px around the path for its stroke

/** The dotted path: an SVG at page coordinates, 1px #999, dash 2 4. */
export class PathOverlay {
  readonly el: SVGSVGElement
  private readonly path: SVGPathElement
  private drawn = true // a path may be showing: clear() has work to do (it runs every frame without a trip)

  constructor() {
    this.el = document.createElementNS(SVGNS, 'svg')
    this.el.id = 'robot-path'
    this.el.setAttribute('aria-hidden', 'true')
    this.path = document.createElementNS(SVGNS, 'path')
    this.path.setAttribute('fill', 'none')
    this.path.setAttribute('stroke', '#999')
    this.path.setAttribute('stroke-width', '1')
    this.path.setAttribute('stroke-dasharray', '2 4')
    this.path.setAttribute('vector-effect', 'non-scaling-stroke')
    this.el.append(this.path)
    this.clear()
  }

  /**
   * Draws `pts` (page px). `travelled`: how far along the whole path its first point is, so the
   * dashes stay where they were drawn while the path erodes.
   */
  draw(pts: Vec2[], travelled: number): void {
    if (pts.length < 2) return this.clear()
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x0 = Math.floor(Math.min(...xs)) - PAD
    const y0 = Math.floor(Math.min(...ys)) - PAD
    const w = Math.ceil(Math.max(...xs)) + PAD - x0
    const h = Math.ceil(Math.max(...ys)) + PAD - y0
    this.el.setAttribute('viewBox', `${x0} ${y0} ${w} ${h}`)
    this.el.setAttribute('width', String(w))
    this.el.setAttribute('height', String(h))
    this.el.style.transform = `translate(${x0}px, ${y0}px)`
    this.path.setAttribute('d', `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`)
    this.path.setAttribute('stroke-dashoffset', travelled.toFixed(1))
    this.el.style.display = ''
    this.drawn = true
  }

  /** Hides the path; once hidden, it writes nothing more. */
  clear(): void {
    if (!this.drawn) return
    this.path.setAttribute('d', '')
    this.el.style.display = 'none'
    this.drawn = false
  }
}
