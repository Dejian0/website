// Orthographic projection to SVG. Pure: no DOM access, also runs in Node at build time.
import type { Face, Vec2, Vec3 } from './model.ts'
import { MODEL } from './model.ts'

export interface Camera { yaw: number; pitch: number; scale: number } // scale = px per body length
/**
 * Screen px, y down, origin = ground point under body centre. tone: 0 = ink, 1 = far-side grey.
 * light: how squarely the face looks at the light, 0 (turned away) to 1.
 */
export interface Polygon { pts: Vec2[]; depth: number; tone: number; light: number }

// looking down enough to see the top of the body, so the still hero reads as a solid
export const HERO_CAMERA = { yaw: -0.6, pitch: 0.48 } as const
export const SIDE_CAMERA = { yaw: 0, pitch: 0 } as const

/** Yaw then pitch; returns [screenX, screenY (up), depth (larger = nearer)]. */
function view(x: number, y: number, z: number, cam: Camera): [number, number, number] {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw)
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
  const X = x * cy + z * sy
  const Z1 = -x * sy + z * cy
  return [X, y * cp - Z1 * sp, y * sp + Z1 * cp]
}

const TONE_RAMP = 0.3 // |cos yaw| below which a turning robot's leg tones cross over

/**
 * The legs on the camera's side are ink and the others grey. That is the z > 0 side while the
 * camera looks from +z (|yaw| < π/2); a robot turned round (yaw near ±π) shows its other side,
 * and near end-on the two sides' tones cross over smoothly instead of swapping at once.
 */
function faceTone(f: Face, cam: Camera): number {
  if (!f.leg) return f.far ? 1 : 0
  const toward = (f.far ? -1 : 1) * Math.cos(cam.yaw) // > 0: this leg's side faces the camera
  const t = Math.min(1, Math.max(0, (TONE_RAMP - toward) / (2 * TONE_RAMP)))
  return t * t * (3 - 2 * t)
}

// A face turned within this (as the cosine to the line of sight, ~0.06°) of edge-on is a
// hair-thin sliver whose outline only doubles its neighbours' edges. Culling it means a camera
// a hair off side-on draws exactly what side-on draws, at any scale.
const EDGE_ON = 1e-3

// The world direction the light comes from: above, a little from the front and the near side.
// Fixed in the world, so a robot turning under it shades as a solid would.
const LIGHT: Vec3 = (() => {
  const [x, y, z] = [0.25, 1, 0.55]
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})()

/** How squarely face f looks at the light: 0 when turned away, 1 when facing it. */
export function faceLight(f: Face): number {
  const [a, b, c] = f.pts
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const [wx, wy, wz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  // faces are wound so this is the outward normal (project() culls by the same product in view space)
  const n: Vec3 = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]
  return Math.max(0, (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / Math.hypot(...n))
}

/** Screen px of a view-space point: y down, origin = ground point under body centre. */
function toScreen(cam: Camera): (v: [number, number, number]) => Vec2 {
  const groundY = -view(0, MODEL.groundY, 0, cam)[1]
  return ([X, Y]) => [X * cam.scale, (-Y - groundY) * cam.scale]
}

/** Culls back-facing and edge-on faces, sorts far to near. */
export function project(faces: Face[], cam: Camera): Polygon[] {
  const px = toScreen(cam)
  const polys: Polygon[] = []
  for (const f of faces) {
    const v = f.pts.map(([x, y, z]) => view(x, y, z, cam))
    const pts = v.map(px)
    // the face normal in view space: its depth component is > 0 when the face looks at the camera
    const [a, b, c] = v
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const [wx, wy, wz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const nz = ux * wy - uy * wx
    if (!(nz > EDGE_ON * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, nz))) continue
    // depth to 1e-9, so faces level within float noise keep model order (a turned-round robot sorts as its mirror image)
    const depth = Math.round((v.reduce((s, p) => s + p[2], 0) / 4) * 1e9) / 1e9
    polys.push({ pts, depth, tone: faceTone(f, cam), light: faceLight(f) })
  }
  return polys.sort((p, q) => p.depth - q.depth)
}

export function bounds(polys: Polygon[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const all = polys.flatMap((p) => p.pts)
  return {
    minX: Math.min(...all.map((p) => p[0])),
    minY: Math.min(...all.map((p) => p[1])),
    maxX: Math.max(...all.map((p) => p[0])),
    maxY: Math.max(...all.map((p) => p[1])),
  }
}

/** The same side view facing the other way (screen x negated); paint order is unchanged. */
export function mirrorX(polys: Polygon[]): Polygon[] {
  return polys.map((p) => ({ ...p, pts: p.pts.map(([x, y]): Vec2 => [-x, y]) }))
}

// The body's footprint on the ground, body lengths each way from its centre: under the body and
// the feet, and not much past them, so the shadow stays close round the robot.
const SHADOW_HALF_X = 0.5
const SHADOW_HALF_Z = 0.32

/** The ground shadow, softened: its opacity at full shade and blur radius (body lengths). */
export const SHADOW = { opacity: 0.12, blur: 0.06 } as const

/** The footprint the ground shadow is drawn from, in the same screen px as project()'s polygons. */
export function groundShadow(cam: Camera): Vec2[] {
  const y = MODEL.groundY
  const [hx, hz] = [SHADOW_HALF_X, SHADOW_HALF_Z]
  const corners: Vec3[] = [[-hx, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz]]
  const px = toScreen(cam)
  return corners.map(([x, y, z]) => px(view(x, y, z, cam)))
}

const INK = 0x11
const GREY = 0x9a
const hexGrey = (v: number) => {
  const h = Math.round(v).toString(16).padStart(2, '0')
  return `#${h}${h}${h}`
}

// How much darker than white a face turned from the light is at full shade: the near side's
// faces, and paler the far side's (as their lines are grey), so shading never outweighs the lines.
const SHADE_NEAR = 0x58
const SHADE_FAR = 0x30

/**
 * The fill of p at `shade` (0 to 1): white at 0, as the walker always is; at 1 greyer the less
 * light the face gets. The hero is drawn at 1 and the transition fades it to 0 as it turns.
 */
export function fillColor(p: Polygon, shade: number): string {
  const s = Math.min(1, Math.max(0, shade))
  const dark = (1 - p.light) * (SHADE_NEAR + (SHADE_FAR - SHADE_NEAR) * p.tone) * s
  const v = Math.round(0xff - dark)
  return v >= 0xff ? '#fff' : hexGrey(v)
}

/** '#111' for ink, '#9a9a9a' for far-side grey, and the greys between while a robot turns. */
export function strokeColor(p: Polygon): string {
  if (p.tone <= 0) return '#111'
  if (p.tone >= 1) return '#9a9a9a'
  return hexGrey(INK + (GREY - INK) * p.tone)
}

/** SVG path data for one polygon (or any outline), offset by (ox, oy), to `digits` decimals (0.1px by default). */
export function pathData(p: { pts: Vec2[] }, ox = 0, oy = 0, digits = 1): string {
  return `M${p.pts.map(([x, y]) => `${(x + ox).toFixed(digits)} ${(y + oy).toFixed(digits)}`).join('L')}Z`
}

/** One <path> per face, offset by (ox, oy), filled at `shade` (fillColor; white by default). */
export function toSvgMarkup(polys: Polygon[], opts: { stroke: number; ox: number; oy: number; digits?: number; shade?: number }): string {
  return polys
    .map(
      (p) =>
        `<path d="${pathData(p, opts.ox, opts.oy, opts.digits)}" fill="${fillColor(p, opts.shade ?? 0)}" stroke="${strokeColor(p)}" stroke-width="${opts.stroke}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`,
    )
    .join('')
}
