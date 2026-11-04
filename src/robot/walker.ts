// The walker's motion on the line terrain, after the prototype: it trots along one line and, at
// a line end, hops to the next line and walks back the other way, snaking down the paragraph and
// back up. Pure: surfaces in page px in, a pose and a ground point out.
import type { Surface, TerrainPoint } from '../terrain/terrain.ts'
import { initGait, poseFromGait, settleGait, stepGait, TURN_MARGIN, WANDER_SPEED, type GaitState } from './gait.ts'
import { solveKnee } from './ik.ts'
import { noRiseMotion, type Motion } from './ballistic.ts'
import { MODEL, robotFaces, type LegPose, type RobotPose, type Vec2 } from './model.ts'
import { bounds, project, SIDE_CAMERA } from './render.ts'

/** The walker's size, after the prototype's pickMetrics(): px per body length, 0.74 of that on phones. */
export const WALKER_PX = 48
export const WALKER_PX_NARROW = 48 * 0.74

/**
 * Surfaces to walk on, the walker's size in px per body length, and optionally which hops are
 * allowed (for instance only those the text can part around). A standable surface's x0..x1 is
 * where the walker's body centre may be (page px), as clearSurfaces() gives them: its nose and
 * tail reach past those ends.
 */
export interface Terrain { surfaces: Surface[]; scale: number; canHop?: (hop: Hop) => boolean }

/**
 * A ballistic arc between two terrain points (page px). With `path`, a flight that never rises
 * above the higher of its lines (ballistic.ts) instead, feet tucked.
 */
export interface Hop {
  from: TerrainPoint
  to: TerrainPoint
  t: number // progress 0..1
  dur: number // seconds
  arc: number // px the path rises above the straight line at mid-flight
  takeoff: RobotPose // legs at take-off; they swing under the hips in flight
  path?: Motion
}

/**
 * vdir: the way the wander snakes, down the page (1) or up (-1). turns: span ends reached on
 * this surface without hopping off it, so a walker on a short, isolated span looks further.
 * came: the surface it hopped here from (-1 if placed), which it doesn't hop straight back to.
 */
export type Walker =
  | { kind: 'walk'; surface: number; gait: GaitState; vdir: 1 | -1; turns: number; came: number }
  | { kind: 'hop'; hop: Hop; facing: 1 | -1; vdir: 1 | -1 }

// All lengths in body lengths.
const PLACE_INSET = 0.05 // a placed walker stands this far inside its surface, so it doesn't turn at once
const MAX_HOP_DX = 1.5 // a span-end hop lands at most this far along x...
export const FAR_HOP_DX = 3 // ...or this far once both ends of the span failed to hop
export const MAX_HOP_DY = 1.6 // ...and this far up or down: a line or a paragraph gap, never a section
const DANGLE = 0.04 // feet hang this far below standing at mid-flight
const GATHER = 0.3 // fraction of a hop over which the legs swing under the hips

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const ease = (t: number) => t * t * (3 - 2 * t)
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** Body-centre x on `s` nearest `x`, a little inside its ends. */
function inside(s: Surface, x: number, scale: number): number {
  const m = PLACE_INSET * scale
  return s.x1 - s.x0 < 2 * m ? (s.x0 + s.x1) / 2 : clamp(x, s.x0 + m, s.x1 - m)
}

/** Stands the walker at `at`, feet planted under the hips. */
export function placeWalker(t: Terrain, at: TerrainPoint, facing: 1 | -1, vdir: 1 | -1 = 1, came = -1): Walker {
  const x = inside(t.surfaces[at.surface]!, at.x, t.scale)
  return { kind: 'walk', surface: at.surface, gait: initGait(x / t.scale, facing), vdir, turns: 0, came }
}

/**
 * Stands the walker exactly at `at` (x held to its surface's ends, which it may stand on, as a
 * trip arriving at a line end does), feet planted under the hips: where a push leaves it.
 */
export function standAt(t: Terrain, at: TerrainPoint, facing: 1 | -1, vdir: 1 | -1 = 1): Walker {
  const s = t.surfaces[at.surface]!
  return { kind: 'walk', surface: at.surface, gait: initGait(clamp(at.x, s.x0, s.x1) / t.scale, facing), vdir, turns: 0, came: -1 }
}

/** Advances a wandering walker by dt seconds. */
export function wander(w: Walker, t: Terrain, dt: number): Walker {
  if (w.kind === 'hop') {
    const p = w.hop.t + dt / w.hop.dur
    // lands facing the way it flew (not necessarily the way it faced taking off)
    if (p >= 1) return placeWalker(t, w.hop.to, walkerAt({ ...w, hop: { ...w.hop, t: 1 } }, t).facing, w.vdir, w.hop.from.surface)
    return { ...w, hop: { ...w.hop, t: p } }
  }
  const s = t.surfaces[w.surface]!
  // the gait turns with its nose TURN_MARGIN out, so this keeps the body centre on [x0, x1]
  const span = { x0: s.x0 / t.scale - TURN_MARGIN, x1: s.x1 / t.scale + TURN_MARGIN }
  const gait = stepGait(w.gait, dt, WANDER_SPEED, span)
  if (gait.facing === w.gait.facing) return { ...w, gait }
  // the gait just turned at a span end: hop to the next line if it lines up, else walk back
  const x = gait.bodyX * t.scale
  const next = spanEndHop(t, s, { surface: w.surface, x }, w, poseFromGait(gait))
  if (!next) return { ...w, gait, turns: w.turns + 1 }
  return { kind: 'hop', hop: next.hop, facing: gait.facing, vdir: next.vdir }
}

/** Standable surfaces a hop away below (dir 1) or above (dir -1) `from`. */
function within(t: Terrain, from: Surface, dir: 1 | -1): Surface[] {
  return t.surfaces.filter((s) => {
    const dy = (s.y - from.y) * dir
    return s.standable && dy >= 1 && dy <= MAX_HOP_DY * t.scale
  })
}

/**
 * A hop off the end of `from` at `at`: to the nearest line in vdir that lines up (the other
 * way, reversing vdir, at the top or bottom), then the closest landing, but not straight back
 * where it came from. Once both ends of a span have failed, it also detours the other way
 * (keeping vdir), lands further along and may go back, so it never paces one span for good.
 */
function spanEndHop(t: Terrain, from: Surface, at: TerrainPoint, w: Walker & { kind: 'walk' }, takeoff: RobotPose) {
  const back = w.vdir === 1 ? -1 : 1
  const ahead = within(t, from, w.vdir)
  const dirs: (1 | -1)[] = ahead.length === 0 ? [back] : w.turns >= 2 ? [w.vdir, back] : [w.vdir]
  const maxDx = (w.turns >= 2 ? FAR_HOP_DX : MAX_HOP_DX) * t.scale
  for (const dir of dirs) {
    const landings = (dir === w.vdir ? ahead : within(t, from, dir))
      .filter((s) => s.id !== w.came || w.turns >= 2)
      .flatMap((s) => landingsOn(s, at.x, maxDx, t.scale).map((x) => ({ s, x })))
      .sort((a, b) => Math.abs(a.s.y - from.y) - Math.abs(b.s.y - from.y) || Math.abs(a.x - at.x) - Math.abs(b.x - at.x))
    for (const l of landings) {
      const hop = makeHop(t, at, { surface: l.s.id, x: l.x }, takeoff)
      // going back is a detour unless the stack ends here: the wander keeps its way
      if (!t.canHop || t.canHop(hop)) return { hop, vdir: ahead.length === 0 ? dir : w.vdir }
    }
  }
  return null
}

const LANDING_STEP = 0.25 // body lengths between the landing spots tried on one surface

/** Body-centre x on `s` within maxDx of x: the nearest, then every LANDING_STEP further away. */
function landingsOn(s: Surface, x: number, maxDx: number, scale: number): number[] {
  const near = inside(s, x, scale)
  if (Math.abs(near - x) > maxDx) return []
  const lo = Math.max(inside(s, -Infinity, scale), x - maxDx)
  const hi = Math.min(inside(s, Infinity, scale), x + maxDx)
  const out = [near]
  for (let d = LANDING_STEP * scale; d <= maxDx; d += LANDING_STEP * scale)
    for (const p of [near - d, near + d]) if (p >= lo && p <= hi) out.push(p)
  return out
}

/**
 * Stands still where it is: a hop in the air lands first (as in wander), then any foot in the
 * air comes down (settleGait), so it never freezes with a foot lifted.
 */
export function standStill(w: Walker, t: Terrain, dt: number): Walker {
  if (w.kind === 'hop') return wander(w, t, dt)
  return { ...w, gait: settleGait(w.gait, dt, WANDER_SPEED) }
}

/** Body pitch of the ready look: the body frame is y-up, so a positive pitch lifts the head. */
export const READY_PITCH = 0.08

/** Top of the side view above the ground point, body lengths. */
const topOf = (pose: RobotPose) => -bounds(project(robotFaces(pose), { ...SIDE_CAMERA, scale: 1 })).minY

/**
 * The ready look, k of the way in (0..1): the head lifts by k × READY_PITCH, and the body sits
 * back by `drop` (body lengths, feet raised in the body frame to keep them on the ground; draw
 * the robot `drop` lower) so its top stays where it was: inside walkerReach(), which every
 * clearance and parting assumes.
 */
export function lookUp(pose: RobotPose, k: number): { pose: RobotPose; drop: number } {
  if (!(k > 0)) return { pose, drop: 0 }
  const pitched = { ...pose, bodyPitch: pose.bodyPitch + READY_PITCH * Math.min(1, k) }
  const drop = Math.max(0, topOf(pitched) - topOf(pose))
  const legs = pitched.legs.map((l, i): LegPose => {
    const foot: Vec2 = [l.foot[0], l.foot[1] + drop]
    return { hip: l.hip, knee: solveKnee(l.hip, foot, MODEL.thigh, MODEL.shank, i < 2 ? -1 : 1), foot }
  })
  return { pose: { legs: legs as RobotPose['legs'], bodyPitch: pitched.bodyPitch }, drop }
}

/** A hop that never rises above the higher of its lines (see ballistic.ts): as long as its fall or leap takes. */
export function makeNoRiseHop(t: Terrain, from: TerrainPoint, to: TerrainPoint, takeoff: RobotPose): Hop {
  const path = noRiseMotion(from.x, t.surfaces[from.surface]!.y, to.x, t.surfaces[to.surface]!.y, t.scale, 1)
  return { from, to, t: 0, dur: path.dur, arc: 0, takeoff, path }
}

/** Timing and height after the prototype's leap: short and low for a line, a little longer for more. */
export function makeHop(t: Terrain, from: TerrainPoint, to: TerrainPoint, takeoff: RobotPose): Hop {
  const dy = t.surfaces[to.surface]!.y - t.surfaces[from.surface]!.y
  const dist = Math.hypot(to.x - from.x, dy) / t.scale
  return { from, to, t: 0, dur: clamp(dist * 0.15, 0.34, 0.95), arc: Math.min(0.42, 0.1 + 0.11 * dist) * t.scale, takeoff }
}

/**
 * A hop's path, sampled n times: ground x and the walker's vertical extent (page px), taken
 * conservatively as its full height above the ground point and the dangling feet below it.
 */
export function hopPath(h: Hop, t: Terrain, n = 24): { x: number; top: number; bottom: number }[] {
  const height = walkerReach().height * t.scale
  return Array.from({ length: n + 1 }, (_, i) => {
    const at = walkerAt({ kind: 'hop', hop: { ...h, t: i / n }, facing: 1, vdir: 1 }, t)
    const dangle = h.path ? 0 : Math.sin((Math.PI * i) / n) * DANGLE * t.scale // a no-rise hop tucks its feet up
    return { x: at.x, top: at.y - height, bottom: at.y + dangle }
  })
}

/** Ground point under the body centre (page px), facing, and the surface stood on (or landed on). */
export function walkerAt(w: Walker, t: Terrain): { x: number; y: number; facing: 1 | -1; surface: number } {
  if (w.kind === 'walk') return { x: w.gait.bodyX * t.scale, y: t.surfaces[w.surface]!.y, facing: w.gait.facing, surface: w.surface }
  const { from, to, t: p, arc, path } = w.hop
  if (path) {
    const a = path.at(p * w.hop.dur)
    return { x: a.x, y: a.y, facing: to.x === from.x ? w.facing : a.facing, surface: to.surface }
  }
  const e = easeInOut(p)
  const y0 = t.surfaces[from.surface]!.y
  const y1 = t.surfaces[to.surface]!.y
  return { x: from.x + (to.x - from.x) * e, y: y0 + (y1 - y0) * e - Math.sin(Math.PI * p) * arc, facing: w.facing, surface: to.surface }
}

/** Body-frame pose. In flight the feet swing from where they took off to under the hips, hanging a little. */
export function walkerPose(w: Walker): RobotPose {
  if (w.kind === 'walk') return poseFromGait(w.gait)
  if (w.hop.path) return tuckedPose(w.hop, w.hop.path)
  const { t, takeoff } = w.hop
  const stand = poseFromGait(initGait(0, w.facing))
  const k = ease(Math.min(1, t / GATHER))
  const drop = Math.sin(Math.PI * t) * DANGLE
  const legs = stand.legs.map((l, i): LegPose => {
    const a = takeoff.legs[i]!.foot
    const foot: Vec2 = [a[0] + (l.foot[0] - a[0]) * k, a[1] + (l.foot[1] - a[1]) * k - drop]
    // X configuration as in the gait: front knees point back, hind knees forward
    return { hip: l.hip, knee: solveKnee(l.hip, foot, MODEL.thigh, MODEL.shank, i < 2 ? -1 : 1), foot }
  })
  return { legs: legs as RobotPose['legs'], bodyPitch: 0 }
}

const TUCK_GATHER = 0.15 // s over which a no-rise hop's legs swing from take-off to under the hips

/** In a no-rise hop: legs swinging under the hips, feet tucked up in flight. */
function tuckedPose(h: Hop, path: Motion): RobotPose {
  const time = h.t * h.dur
  const a = path.at(time)
  const stand = poseFromGait(initGait(0, a.facing))
  const k = ease(Math.min(1, time / TUCK_GATHER))
  const legs = stand.legs.map((l, i): LegPose => {
    const from = h.takeoff.legs[i]!.foot
    const foot: Vec2 = [from[0] + (l.foot[0] - from[0]) * k, from[1] + (l.foot[1] - from[1]) * k + a.lift]
    return { hip: l.hip, knee: solveKnee(l.hip, foot, MODEL.thigh, MODEL.shank, i < 2 ? -1 : 1), foot }
  })
  return { legs: legs as RobotPose['legs'], bodyPitch: 0 }
}

let sideBL: { back: number; front: number } | null = null

/**
 * How far the walker's side view reaches behind (`back`) and ahead of (`front`) its ground point
 * in flight, the way it faces, body lengths: the box of its body, as the legs stay under it
 * (sampled over hops of both kinds taken off from poses through a stride). Narrower than
 * walkerReach().half, which covers either facing and turning round.
 */
export function flightSide(): { back: number; front: number } {
  if (sideBL) return sideBL
  let back = 0
  let front = 0
  const surfaces: Surface[] = [0, 2].map((y, id) => ({ id, flow: `f${id}`, line: 0, x0: -10, x1: 10, y, standable: true }))
  const t: Terrain = { surfaces, scale: 1 }
  let g = initGait(0, 1)
  // the legs swing from where they took off to under the hips (tucked or dangling): the ends and
  // the middle of a flight bound it (tests/robot/walker.test.ts checks every pose of the wander)
  for (let i = 0; i < 10; i++) {
    g = stepGait(g, 1 / 10, WANDER_SPEED, { x0: -100, x1: 100 }) // straight on: a stride's poses
    for (const make of [makeHop, makeNoRiseHop]) {
      const hop = make(t, { surface: 0, x: 0 }, { surface: 1, x: 0.4 }, poseFromGait(g))
      for (const k of make === makeHop ? [0, 0.5, 1] : [0.5]) {
        const b = bounds(project(robotFaces(walkerPose({ kind: 'hop', hop: { ...hop, t: k }, facing: 1, vdir: 1 })), { ...SIDE_CAMERA, scale: 1 }))
        back = Math.max(back, -b.minX)
        front = Math.max(front, b.maxX)
      }
    }
  }
  return (sideBL = { back, front })
}

let reachBL: { half: number; height: number } | null = null

/**
 * Bounds of every pose the walker takes, in body lengths around its ground point: at most
 * `half` to either side (either facing) and `height` up. Sampled over the gait, through turns,
 * and over hops; a line parted around ±half never touches the robot.
 */
export function walkerReach(): { half: number; height: number } {
  if (reachBL) return reachBL
  let half = 0
  let height = 0
  const take = (pose: RobotPose) => {
    const b = bounds(project(robotFaces(pose), { ...SIDE_CAMERA, scale: 1 }))
    half = Math.max(half, b.maxX, -b.minX)
    height = Math.max(height, -b.minY)
  }
  for (const facing of [1, -1] as const) {
    let g = initGait(0, facing)
    for (let i = 0; i < 600; i++) {
      g = stepGait(g, 1 / 40, WANDER_SPEED, { x0: -1.2, x1: 1.2 }) // short span: turns every ~2s
      take(poseFromGait(g))
      if (i % 20 === 0) {
        const hop: Walker = { kind: 'hop', facing: g.facing, vdir: 1, hop: { from: { surface: 0, x: 0 }, to: { surface: 0, x: 0 }, t: 0, dur: 1, arc: 0, takeoff: poseFromGait(g) } }
        for (let k = 0; k <= 10; k++) take(walkerPose({ ...hop, hop: { ...hop.hop, t: k / 10 } }))
      }
    }
  }
  return (reachBL = { half: half + 0.01, height })
}
