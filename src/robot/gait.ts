import { solveKnee } from './ik.ts'
import { MODEL, type LegPose, type RobotPose } from './model.ts'

/** A walkable span in body lengths, ground at y = 0. */
export interface Surface1D { x0: number; x1: number }
export interface FootState { x: number; planted: boolean; liftFrom: number; liftTo: number }
export interface GaitState { bodyX: number; facing: 1 | -1; phase: number; feet: FootState[] }

// Prototype: 48px body, 29px/s, 15px stride => 29/48 body lengths/s.
export const WANDER_SPEED = 29 / 48
const STRIDE = 15 / 48 // body lengths travelled per gait cycle
const DUTY = 0.62 // fraction of the cycle a foot is planted
const SWING = 1 - DUTY
const LIFT = 0.08
export const TURN_MARGIN = 0.5 // half the body length: keeps nose, tail and reached feet inside the span
const FOOT_CLEARANCE = 0.03 // foot point sits this far above the model's ground line

/** Order FL, FR, HL, HR; trot pairs FL+HR and FR+HL. */
const LEG_PHASE = [0, 0.5, 0.5, 0]
const LEG_FRONT = [1, 1, -1, -1]

function hipWorld(s: GaitState, i: number): number {
  return s.bodyX + s.facing * LEG_FRONT[i]! * MODEL.hipX
}

export function initGait(bodyX: number, facing: 1 | -1): GaitState {
  const s: GaitState = { bodyX, facing, phase: 0, feet: [] }
  s.feet = LEG_FRONT.map((_, i) => {
    const x = hipWorld(s, i)
    return { x, planted: true, liftFrom: x, liftTo: x }
  })
  return s
}

const MAX_HIP_DX = 0.25 // horizontal foot-to-hip limit; leg reach is ~0.28 at stance height
const MAX_SUBSTEP = 1 / 120 // seconds
const MAX_SUBDIST = 0.02 // body lengths

const ease = (t: number) => t * t * (3 - 2 * t)

/** Advance by any dt >= 0 (internally substepped so large frame gaps stay valid). */
export function stepGait(s: GaitState, dt: number, speed: number, span: Surface1D): GaitState {
  const n = Math.ceil(Math.max(dt / MAX_SUBSTEP, (Math.abs(speed) * dt) / MAX_SUBDIST))
  if (!(n > 0)) return { ...s, feet: s.feet.map((f) => ({ ...f })) }
  let cur = s
  for (let i = 0; i < n; i++) cur = stepOnce(cur, dt / n, speed, span)
  return cur
}

/**
 * Brings a stopped gait's lifted feet down, the body standing still: the swing in progress
 * finishes along the curve it was on, at the pace of walking at `speed`, landing where it was
 * heading, and the phase then holds with every foot planted. Planted feet stay put. (stepGait
 * at speed 0 leaves a swinging foot in the air.) Walking on with stepGait continues from there.
 */
export function settleGait(s: GaitState, dt: number, speed: number): GaitState {
  const i0 = s.feet.findIndex((f) => !f.planted) // trot: the swinging feet are one pair, in step
  if (i0 < 0 || !(dt > 0)) return { ...s, feet: s.feet.map((f) => ({ ...f })) }
  const q = (s.phase + LEG_PHASE[i0]!) % 1
  const q1 = Math.min(SWING, q + (Math.abs(speed) * dt) / STRIDE)
  const done = q1 >= SWING
  const e0 = ease(q / SWING)
  const frac = done || e0 >= 1 ? 1 : (ease(q1 / SWING) - e0) / (1 - e0)
  return {
    ...s,
    // landed exactly where this pair's stance starts, so stepGait plants it too
    phase: done ? (((SWING - LEG_PHASE[i0]!) % 1) + 1) % 1 : (s.phase + q1 - q) % 1,
    feet: s.feet.map((f, i) => {
      if (f.planted) return { ...f }
      const hip = hipWorld(s, i)
      const x = Math.min(hip + MAX_HIP_DX, Math.max(hip - MAX_HIP_DX, f.x + (f.liftTo - f.x) * frac))
      return { ...f, x, planted: done }
    }),
  }
}

function stepOnce(s: GaitState, dt: number, speed: number, span: Surface1D): GaitState {
  const dist = speed * dt
  const candidate = s.bodyX + s.facing * dist
  const nose = candidate + s.facing * TURN_MARGIN
  if (s.facing === 1 ? nose >= span.x1 : nose <= span.x0) return turnGait(s)
  const facing = s.facing
  const phase = (s.phase + dist / STRIDE) % 1
  const next: GaitState = { bodyX: candidate, facing, phase, feet: [] }
  next.feet = s.feet.map((f, i) => {
    const q = (phase + LEG_PHASE[i]!) % 1
    if (q >= SWING) {
      // stance: world-planted; touch down exactly on the swing target
      return f.planted ? { ...f } : { ...f, x: f.liftTo, planted: true }
    }
    // swing: aim where the hip will be at touchdown, plus half the stance travel
    const liftTo = clampSpan(hipWorld(next, i) + facing * ((SWING - q) * STRIDE + (DUTY * STRIDE) / 2), span)
    const qPrev = (s.phase + LEG_PHASE[i]!) % 1
    const ePrev = f.planted || qPrev >= SWING ? 0 : ease(qPrev / SWING)
    const frac = ePrev < 1 ? (ease(q / SWING) - ePrev) / (1 - ePrev) : 1
    // after a turn the hip can outrun a lagging foot: never let it leave the leg's reach
    const hip = hipWorld(next, i)
    const x = Math.min(hip + MAX_HIP_DX, Math.max(hip - MAX_HIP_DX, f.x + (liftTo - f.x) * frac))
    return {
      x,
      planted: false,
      liftFrom: f.planted ? f.x : f.liftFrom,
      liftTo,
    }
  })
  return next
}

function clampSpan(x: number, span: Surface1D): number {
  return Math.min(span.x1, Math.max(span.x0, x))
}

/**
 * Reverse facing. Each foot is handed to the leg whose hip now sits at the same world x
 * (FL<->HL, FR<->HR) and the phase is mirrored (q -> 1 + SWING - q for every leg), so
 * a planted foot's remaining stance travel matches its mirrored offset from the new hip:
 * no foot jumps, slides or overstretches. stepGait turns at a span end; a trip turns to face
 * its next target.
 */
export function turnGait(s: GaitState): GaitState {
  const f = s.feet
  return {
    bodyX: s.bodyX,
    facing: s.facing === 1 ? -1 : 1,
    phase: (((SWING + 0.5 - s.phase) % 1) + 1) % 1,
    feet: [f[2]!, f[3]!, f[0]!, f[1]!].map((x) => ({ ...x })),
  }
}

export function poseFromGait(s: GaitState): RobotPose {
  const groundFootY = MODEL.groundY + FOOT_CLEARANCE
  const legs = s.feet.map((f, i): LegPose => {
    const front = LEG_FRONT[i]!
    const hip: [number, number] = [front * MODEL.hipX, MODEL.hipY]
    const lift = f.planted ? 0 : Math.sin(Math.PI * Math.min(1, ((s.phase + LEG_PHASE[i]!) % 1) / SWING)) * LIFT
    const foot: [number, number] = [s.facing * (f.x - s.bodyX), groundFootY + lift]
    // X configuration: front knees point back, hind knees point forward
    return { hip, knee: solveKnee(hip, foot, MODEL.thigh, MODEL.shank, front === 1 ? -1 : 1), foot }
  })
  return { legs: legs as RobotPose['legs'], bodyPitch: 0 }
}
