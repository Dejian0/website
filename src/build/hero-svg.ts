import { standingPose, robotFaces } from '../robot/model.ts'
import { HERO_CAMERA, SHADOW, bounds, groundShadow, pathData, project, toSvgMarkup } from '../robot/render.ts'

/** ViewBox units per body length; CSS sets the displayed size. */
export const HERO_SCALE = 100
export const HERO_STROKE = 1.6 // px; vector-effect keeps it from scaling with the drawing
const PAD = 2
const INTRINSIC_W = 600 // desktop hero size; only matters if CSS fails to load

const heroPolys = (scale: number) => project(robotFaces(standingPose()), { ...HERO_CAMERA, scale })

/**
 * Where the static drawing puts the ground point under the body centre, in viewBox units.
 * The page lays the live robot over the static one from this point.
 */
export function heroOrigin(scale = HERO_SCALE): { x: number; y: number } {
  const b = bounds(heroPolys(scale))
  return { x: PAD - b.minX, y: PAD - b.minY }
}

/**
 * Still hero robot at the three-quarter camera, shaded (as the live robot draws it at p = 0) and
 * standing on its soft ground shadow. Sized by CSS; viewBox comes from the drawing bounds (the
 * shadow's blur may spill past them, which the CSS lets show).
 */
export function renderHeroSvg(scale: number): string {
  const polys = heroPolys(scale)
  const b = bounds(polys)
  const o = heroOrigin(scale)
  const w = b.maxX - b.minX + PAD * 2
  const h = b.maxY - b.minY + PAD * 2
  // 0.01 units: shown at ~3-6px per unit, 0.1 would place a corner up to 0.3px off where the
  // live robot, drawn over it at load, puts it
  const paths = toSvgMarkup(polys, { stroke: HERO_STROKE, ox: o.x, oy: o.y, digits: 2, shade: 1 })
  const shadow = pathData({ pts: groundShadow({ ...HERO_CAMERA, scale }) }, o.x, o.y, 2)
  const defs = `<defs><filter id="robot-static-shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(SHADOW.blur * scale).toFixed(2)}"/></filter></defs>`
  const ground = `<path class="robot-shadow" d="${shadow}" fill="#000" opacity="${SHADOW.opacity}" filter="url(#robot-static-shadow)"/>`
  return `<svg id="robot-static" xmlns="http://www.w3.org/2000/svg" width="${INTRINSIC_W}" height="${Math.round((INTRINSIC_W * h) / w)}" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-label="Line drawing of a four-legged robot">${defs}${ground}${paths}</svg>`
}
