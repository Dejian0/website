// Push and recovery: pressed and moved, the robot follows the pointer held back by a spring;
// let go, it flies with the pointer's velocity under gravity and lands on the first line below
// it can stand on; there it stumbles (body tilted, legs splayed), slides to a stop, levels out
// (PD on the tilt) and re-plants its feet under its hips to stand as the walker does.
// Lines are one-way: it rises through them and lands on them from above. It never leaves the
// ground it could land on: off the end of everything below, it is stopped at the end; with no
// ground below it at all, it leaps up onto the nearest line, so it always ends up on one.
// Page px and seconds, y down; poses in body lengths, as model.ts. Pure.
import { nearestPoint, type Surface, type TerrainPoint } from '../terrain/terrain.ts'
import { initGait, poseFromGait } from './gait.ts'
import { solveKnee } from './ik.ts'
import { MODEL, type LegPose, type RobotPose, type Vec2 } from './model.ts'

/** px: the furthest the drag spring lets the robot follow the pointer from where it took hold. */
export const MAX_DRAG_PX = 60
/** px/s: the fastest a flick throws it (a fast swipe would send it off the page). */
export const MAX_FLICK_PX_S = 900
/** Body lengths each foot moves out from under its hip while pushed: front feet forward, hind feet back. */
export const SPLAY_BL = 0.35
/** rad: the most the body tilts either way. */
export const TILT_MAX = 0.4

/**
 * x, y: the robot's ground point (page px): under its body centre, where its lowest feet are.
 * tilt: the body's rotation on screen, rad, clockwise; vtilt its rate. dragging: held by the
 * pointer; flying: let go; recovering: landed, levelling out and re-planting; done: standing.
 * ax, ay: where the push took hold, the spring's rest point (and it can't be pressed lower).
 * held: s since then; since: s since it landed (0 until it does).
 */
export interface PushState {
  x: number
  y: number
  vx: number
  vy: number
  tilt: number
  vtilt: number
  phase: 'dragging' | 'flying' | 'recovering' | 'done'
  ax: number
  ay: number
  held: number
  since: number
}

const G = 1800 // px/s²: snappier than a hop's (ballistic.ts), as a fling is
const DRAG_W = 30 // rad/s: the drag spring's natural frequency, critically damped
const AIR_DRAG = 0.6 // 1/s on the sideways speed in flight
const IMPACT_FRICTION = 0.8 // at touchdown its feet catch: sideways speed lost per px/s it comes down at...
const FRICTION = 3000 // px/s²: ...then lost sliding along the line
const WALL_KEEP = 0.3 // of the sideways speed kept, reversed, at the end of the ground
const SLIDE_BACK = 400 // px/s: out over no ground at all, it heads back to the nearest at least this fast
const SEARCH_PX = 2000 // how far either side it looks for that
const LEAP_CLEAR = 24 // px: with no ground below it at all, its leap up to the nearest line clears that line by this
const HOME_INSET = 4 // px inside the ends of the piece it leaps for
const DRAG_TILT = 0.0006 // rad of lean per px/s of drag speed: its legs trail
const DRAG_TILT_W = 14 // rad/s, and damping ratio, of the lean
const DRAG_TILT_Z = 0.6
const RELEASE_KEEP_SPIN = 0.3 // of the lean's spin kept as the hand lets go...
const RELEASE_SPIN = 0.0005 // ...plus this much, rad/s per px/s flung sideways
const AIR_SPIN_DRAG = 2 // 1/s
// Its feet catch and the body goes on: it pitches the way it was going, at touchdown by this
// much (rad/s per px/s of sideways speed the catch takes), and while it skids by this (rad/s²)
const IMPACT_SPIN = 0.0025
const SLIDE_TORQUE = 30
const PD_W = 11 // rad/s, and damping ratio: the recovery's PD on the tilt
const PD_Z = 0.75
const SETTLED_TILT = 0.004 // rad, rad/s: level enough to stand
const SETTLED_SPIN = 0.04
const EPS = 0.5 // px a robot standing on a line may be off it by
const ROUNDING = 1e-6 // px a ground point may be past a piece's end by float rounding (the walker keeps x in body lengths)
const MAX_H = 1 / 240 // s: longest integration step

// The legs, body lengths and seconds.
const SPLAY_IN_S = 0.18 // the feet move out over this once it is taken hold of
const STEP_S = 0.24 // each re-planting step takes this...
const STEP_AT = [0.12, 0.36, 0.36, 0.12] // ...starting this long after landing: trot pairs FL+HR, then FR+HL
const STEP_LIFT = 0.07 // and lifts the foot this high
const REPLANT_S = Math.max(...STEP_AT) + STEP_S
const REACH = 0.96 * (MODEL.thigh + MODEL.shank) // a leg stretches to at most this
const LEG_FRONT = [1, 1, -1, -1]

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const smooth = (v: number) => v * v * (3 - 2 * v)

export function startPush(x: number, y: number): PushState {
  return { x, y, vx: 0, vy: 0, tilt: 0, vtilt: 0, phase: 'dragging', ax: x, ay: y, held: 0, since: 0 }
}

/**
 * Moves a held robot toward the pointer's pull at page (px, py) for dt seconds: it follows on a
 * spring, softened so it never gets further than MAX_DRAG_PX from where it took hold, and never
 * lower (pressed down, it presses into the line), leaning with its speed as its legs trail.
 */
export function dragPush(s: PushState, px: number, py: number, dt: number): PushState {
  if (s.phase !== 'dragging' || !(dt > 0)) return s
  let dx = px - s.ax
  let dy = Math.min(py, s.ay) - s.ay
  const d = Math.hypot(dx, dy)
  if (d > 0) {
    const k = (MAX_DRAG_PX * Math.tanh(d / MAX_DRAG_PX)) / d
    dx *= k
    dy *= k
  }
  const n = Math.ceil(dt / MAX_H)
  const h = dt / n
  let q = s
  for (let i = 0; i < n; i++) {
    let vx = q.vx + (DRAG_W * DRAG_W * (s.ax + dx - q.x) - 2 * DRAG_W * q.vx) * h
    let vy = q.vy + (DRAG_W * DRAG_W * (s.ay + dy - q.y) - 2 * DRAG_W * q.vy) * h
    let x = q.x + vx * h
    let y = q.y + vy * h
    const ox = x - s.ax
    const oy = y - s.ay
    const o = Math.hypot(ox, oy)
    if (o > MAX_DRAG_PX) {
      x = s.ax + (ox * MAX_DRAG_PX) / o
      y = s.ay + (oy * MAX_DRAG_PX) / o
      const out = (vx * ox + vy * oy) / o
      if (out > 0) {
        vx -= (out * ox) / o
        vy -= (out * oy) / o
      }
    }
    if (y > s.ay) {
      y = s.ay
      vy = Math.min(vy, 0)
    }
    const lean = clamp(vx * DRAG_TILT, -TILT_MAX, TILT_MAX)
    const spin = q.vtilt + (DRAG_TILT_W * DRAG_TILT_W * (lean - q.tilt) - 2 * DRAG_TILT_Z * DRAG_TILT_W * q.vtilt) * h
    q = { ...q, x, y, vx, vy, ...tilted(q.tilt, spin, h) }
  }
  return q
}

/** Lets go of a held robot with the pointer's velocity (px/s), at most MAX_FLICK_PX_S; it spins with it a little. */
export function releasePush(s: PushState, vx: number, vy: number): PushState {
  if (s.phase !== 'dragging') return s
  const v = Math.hypot(vx, vy)
  const k = v > MAX_FLICK_PX_S ? MAX_FLICK_PX_S / v : 1
  return { ...s, phase: 'flying', vx: vx * k, vy: vy * k, vtilt: s.vtilt * RELEASE_KEEP_SPIN + vx * k * RELEASE_SPIN }
}

/**
 * Advances the robot dt seconds. groundAt(x): the y of the first standable surface at or below
 * the robot over page x, or null where there is none (see groundBelow); it is asked about the
 * robot's place at the start of the call, so keep dt to a frame or less (runPush does). Flying,
 * it lands there; on the ground, it slides to a stop no further than the end of the piece it
 * landed on; held (dragPush moves it), it is only kept over ground. home(): where to head for
 * in the air with no ground below it anywhere (the nearest standable point, whatever its
 * height; see homePoint); without it, it only heads back toward ground it can find below.
 */
export function stepPush(s: PushState, dt: number, groundAt: (x: number) => number | null, home?: () => { x: number; y: number } | null): PushState {
  if (!(dt > 0) || s.phase === 'done') return s
  const n = Math.ceil(dt / MAX_H)
  for (let i = 0; i < n && s.phase !== 'done'; i++) {
    const h = dt / n
    const q = { ...s, held: s.held + h }
    if (s.phase === 'dragging') s = overGround(q, s.ax, groundAt)
    else if (s.phase === 'flying') s = fly(q, h, groundAt, home)
    else s = recover(q, h, groundAt)
  }
  return s
}

/**
 * Runs a push dt seconds over `surfaces` as the page does: in steps of at most MAX_H, held
 * toward `pull` while it is dragging, the ground looked up below where the robot is at each
 * step (groundBelow), and with none below it at all, heading for homePoint.
 */
export function runPush(s: PushState, dt: number, surfaces: Surface[], pull?: { x: number; y: number }): PushState {
  const n = Math.ceil(dt / MAX_H - 1e-9)
  for (let i = 0; i < n && s.phase !== 'done'; i++) {
    const h = dt / n
    if (s.phase === 'dragging' && pull) s = dragPush(s, pull.x, pull.y, h)
    const at = s
    s = stepPush(at, h, (x) => groundBelow(surfaces, x, at.y), () => homePoint(surfaces, at.x, at.y))
  }
  return s
}

function fly(s: PushState, h: number, groundAt: (x: number) => number | null, home?: () => { x: number; y: number } | null): PushState {
  const vx = s.vx * Math.exp(-AIR_DRAG * h)
  const vy = s.vy + G * h
  const spin = s.vtilt * Math.exp(-AIR_SPIN_DRAG * h)
  const q = overGround({ ...s, x: s.x + vx * h, y: s.y + vy * h, vx, vy, ...tilted(s.tilt, spin, h) }, s.x, groundAt, home)
  const g = groundAt(q.x)
  if (g === null || q.vy <= 0 || q.y < g) return q
  // touchdown: its feet catch, the harder the more, and it pitches over the way it was going
  const caught = Math.min(Math.abs(q.vx), IMPACT_FRICTION * q.vy) * Math.sign(q.vx)
  return { ...q, y: g, vy: 0, vx: q.vx - caught, vtilt: q.vtilt + caught * IMPACT_SPIN, phase: 'recovering', since: 0 }
}

function recover(s: PushState, h: number, groundAt: (x: number) => number | null): PushState {
  const on = (x: number) => {
    const g = groundAt(x)
    return g !== null && Math.abs(g - s.y) <= EPS
  }
  const dv = FRICTION * h
  let vx = Math.abs(s.vx) <= dv ? 0 : s.vx - Math.sign(s.vx) * dv
  let x = s.x + vx * h
  if (x !== s.x && !on(x)) {
    x = edge(on, s.x, x) // slides no further than its piece goes
    vx = 0
  }
  if (!on(x)) return { ...s, x, vx, phase: 'flying', since: 0 } // the line went (a re-layout): it falls
  const since = s.since + h
  const skid = Math.sign(vx) * SLIDE_TORQUE // its feet drag: it leans into the way it skids, the PD against it
  const spin = s.vtilt + (skid - PD_W * PD_W * s.tilt - 2 * PD_Z * PD_W * s.vtilt) * h
  const q = { ...s, x, vx, since, ...tilted(s.tilt, spin, h) }
  if (since >= REPLANT_S && vx === 0 && Math.abs(q.tilt) < SETTLED_TILT && Math.abs(q.vtilt) < SETTLED_SPIN)
    return { ...q, tilt: 0, vtilt: 0, phase: 'done' }
  return q
}

/** The tilt after h seconds spinning at `spin`, held within TILT_MAX. */
function tilted(tilt: number, spin: number, h: number): { tilt: number; vtilt: number } {
  const t = tilt + spin * h
  if (Math.abs(t) <= TILT_MAX) return { tilt: t, vtilt: spin }
  return { tilt: Math.sign(t) * TILT_MAX, vtilt: Math.sign(spin) === Math.sign(t) ? 0 : spin }
}

/**
 * Keeps s over ground: out past the end of it from `from` (over ground), it is stopped at the
 * end, bouncing back a little; out over none, it heads back to the nearest below it, or, given
 * `home` and that is above it, leaps up onto that.
 */
function overGround(s: PushState, from: number, groundAt: (x: number) => number | null, home?: () => { x: number; y: number } | null): PushState {
  if (groundAt(s.x) !== null) return s
  const has = (x: number) => groundAt(x) !== null
  if (has(from)) {
    const x = edge(has, from, s.x)
    return { ...s, x, vx: Math.sign(s.vx) === Math.sign(s.x - from) ? -s.vx * WALL_KEEP : s.vx }
  }
  const up = home?.()
  if (up && up.y < s.y - EPS) return leap(s, up)
  for (let d = 2; d <= SEARCH_PX; d += 2)
    for (const x of [s.x - d, s.x + d])
      if (has(x)) {
        const back = Math.sign(x - s.x)
        return { ...s, vx: back * Math.max(SLIDE_BACK, s.vx * back) }
      }
  return up ? leap(s, up) : s
}

/**
 * Sets s off on the ballistic arc that clears `to` by LEAP_CLEAR and comes down on it (against
 * the air drag on its sideways speed). Asked again each step on the way up, it stays on the arc.
 */
function leap(s: PushState, to: { x: number; y: number }): PushState {
  const apex = Math.min(s.y, to.y) - LEAP_CLEAR
  const up = Math.sqrt(2 * G * (s.y - apex))
  const time = up / G + Math.sqrt((2 * (to.y - apex)) / G)
  return { ...s, vx: ((to.x - s.x) * AIR_DRAG) / (1 - Math.exp(-AIR_DRAG * time)), vy: -up }
}

/** The point nearest b on the segment from a (where ok holds) to b (where it doesn't) at which ok still holds. */
function edge(ok: (x: number) => boolean, a: number, b: number): number {
  for (let i = 0; i < 24 && Math.abs(b - a) > 1e-3; i++) {
    const m = (a + b) / 2
    if (ok(m)) a = m
    else b = m
  }
  return a
}

/**
 * The y of the first standable surface at or below page y (within half a px) that page x is
 * over, its ends included; null if none. A standable surface's x0..x1 is where the body centre
 * may be with the lines above parting cleanly, so a robot landing here stands at a clear spot.
 */
export function groundBelow(surfaces: Surface[], x: number, y: number): number | null {
  let best: number | null = null
  for (const s of surfaces) {
    if (!s.standable || s.y < y - EPS || x < s.x0 - ROUNDING || x > s.x1 + ROUNDING) continue
    if (best === null || s.y < best) best = s.y
  }
  return best
}

/** The standable point nearest page (x, y), whatever its height, a little inside its piece's ends: where a robot with no ground below it heads. */
export function homePoint(surfaces: Surface[], x: number, y: number): { x: number; y: number } | null {
  const p = nearestPoint(surfaces, x, y)
  if (!p) return null
  const s = surfaces[p.surface]!
  const inset = Math.min(HOME_INSET, (s.x1 - s.x0) / 2)
  return { x: clamp(p.x, s.x0 + inset, s.x1 - inset), y: s.y }
}

/** The standable piece a robot whose ground point is page (x, y) stands on, and x on it; null if none. */
export function landing(surfaces: Surface[], x: number, y: number): TerrainPoint | null {
  for (const s of surfaces)
    if (s.standable && Math.abs(s.y - y) <= EPS && x >= s.x0 - EPS && x <= s.x1 + EPS) return { surface: s.id, x: clamp(x, s.x0, s.x1) }
  return null
}

const STAND = poseFromGait(initGait(0, 1)) // the walker standing (the same body-frame pose either way it faces)
const FOOT_Y = STAND.legs[0].foot[1] // body frame y of a planted foot
const HIP_H = MODEL.hipY - FOOT_Y // how high the hips stand over the feet

/**
 * The pose to draw a pushed robot facing `facing` in, and how much lower than its ground point
 * (body lengths, as lookUp's drop). Its feet are out by SPLAY_BL (re-planting one trot pair at a
 * time once it lands), its body comes down just enough for splayed legs to reach the ground,
 * and the whole body, hips included, tilts by s.tilt; a foot the tilt lifts out of reach hangs
 * in the air. Bones keep their lengths (IK). From `from`, the pose it was in when taken hold of
 * (the walker's), it blends over SPLAY_IN_S; done, it is exactly the walker's standing pose.
 */
export function pushPose(s: PushState, facing: 1 | -1, from?: { pose: RobotPose; drop: number }): { pose: RobotPose; drop: number } {
  const out = [0, 1, 2, 3].map((i) => {
    if (s.phase === 'dragging' || s.phase === 'flying') return { splay: 1, lift: 0 }
    const u = clamp((s.since - STEP_AT[i]!) / STEP_S, 0, 1)
    return { splay: 1 - smooth(u), lift: Math.sin(Math.PI * u) * STEP_LIFT }
  })
  let drop = 0
  for (const o of out) drop = Math.max(drop, HIP_H - Math.sqrt(REACH * REACH - (SPLAY_BL * o.splay) ** 2))
  let pitch = -facing * s.tilt || 0 // clockwise on screen: nose down facing right, up facing left
  const c = Math.cos(pitch)
  const sn = Math.sin(pitch)
  let legs = STAND.legs.map((l, i): { hip: Vec2; foot: Vec2 } => ({
    hip: [l.hip[0] * c - l.hip[1] * sn, l.hip[0] * sn + l.hip[1] * c],
    foot: [l.foot[0] + LEG_FRONT[i]! * SPLAY_BL * out[i]!.splay, FOOT_Y + drop + out[i]!.lift],
  }))
  const k = from ? smooth(clamp(s.held / SPLAY_IN_S, 0, 1)) : 1
  if (from && k < 1) {
    const mix = (a: Vec2, b: Vec2): Vec2 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
    legs = legs.map((l, i) => ({ hip: mix(from.pose.legs[i]!.hip, l.hip), foot: mix(from.pose.legs[i]!.foot, l.foot) }))
    drop = from.drop + (drop - from.drop) * k
    pitch = from.pose.bodyPitch + (pitch - from.pose.bodyPitch) * k
  }
  const posed = legs.map(({ hip, foot }, i): LegPose => {
    const v: Vec2 = [foot[0] - hip[0], foot[1] - hip[1]]
    const d = Math.hypot(v[0], v[1])
    const f: Vec2 = d > REACH ? [hip[0] + (v[0] * REACH) / d, hip[1] + (v[1] * REACH) / d] : foot
    return { hip, knee: solveKnee(hip, f, MODEL.thigh, MODEL.shank, LEG_FRONT[i]! > 0 ? -1 : 1), foot: f }
  })
  return { pose: { legs: posed as RobotPose['legs'], bodyPitch: pitch }, drop }
}
