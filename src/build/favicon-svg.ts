import { standingPose, robotFaces } from '../robot/model.ts'
import { SIDE_CAMERA, bounds, pathData, project } from '../robot/render.ts'

const SCALE = 100
const PAD = 3

/** Side-view standing robot as a black silhouette on transparent, for the tab icon. */
export function renderFaviconSvg(): string {
  const polys = project(robotFaces(standingPose()), { ...SIDE_CAMERA, scale: SCALE })
  const b = bounds(polys)
  const w = b.maxX - b.minX + PAD * 2
  const h = b.maxY - b.minY + PAD * 2
  const paths = polys
    .map((p) => `<path d="${pathData(p, PAD - b.minX, PAD - b.minY, 1)}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" fill="#000" stroke="#000" stroke-width="1" stroke-linejoin="round">${paths}</svg>\n`
}
