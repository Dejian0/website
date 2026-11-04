import { describe, expect, it } from 'vitest'
import { initGait, poseFromGait } from '../../src/robot/gait.ts'
import { MODEL, type RobotPose } from '../../src/robot/model.ts'
import {
  dragPush,
  groundBelow,
  landing,
  MAX_DRAG_PX,
  MAX_FLICK_PX_S,
  pushPose,
  releasePush,
  runPush,
  SPLAY_BL,
  startPush,
  stepPush,
  TILT_MAX,
  type PushState,
} from '../../src/robot/push.ts'
import type { Surface } from '../../src/terrain/terrain.ts'

const DT = 1 / 240

/** Steps s for `seconds` against `groundAt`, calling `each` after every step. */
function run(s: PushState, seconds: number, groundAt: (x: number, y: number) => number | null, each?: (s: PushState, prev: PushState) => void) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const prev = s
    s = stepPush(s, DT, (x) => groundAt(x, prev.y))
    each?.(s, prev)
  }
  return s
}

// A line split into two pieces (the line above can't part over 260..330), a line the robot
// can't stand on, a shorter line, and a paragraph further down.
const S = (id: number, y: number, x0: number, x1: number, standable = true): Surface => ({ id, flow: 'f', line: id, x0, x1, y, standable })
const surfaces: Surface[] = [S(0, 100, 100, 260), S(1, 100, 330, 600), S(2, 146, 100, 600, false), S(3, 192, 100, 450), S(4, 400, 100, 600)]
const below = (x: number, y: number) => groundBelow(surfaces, x, y)

/** Standing as the walker stands (poseFromGait): what the push must come back to. */
const standing = (facing: 1 | -1) => poseFromGait(initGait(0, facing))

describe('push', () => {
  it('pins the interface values', () => {
    expect(MAX_DRAG_PX).toBe(60)
    expect(SPLAY_BL).toBe(0.35)
    expect(startPush(10, 20)).toMatchObject({ x: 10, y: 20, vx: 0, vy: 0, tilt: 0, vtilt: 0, phase: 'dragging' })
  })

  it('drag is spring-limited', () => {
    let s = startPush(0, 0)
    for (let i = 0; i < 240; i++) {
      s = dragPush(s, 500, 0, DT)
      expect(Math.abs(s.x)).toBeLessThanOrEqual(MAX_DRAG_PX)
    }
    expect(s.x).toBeGreaterThan(0.9 * MAX_DRAG_PX) // it follows as far as the spring lets it
    expect(s.phase).toBe('dragging')
  })

  it('a drag follows the pointer, held back, and never presses the robot into its line', () => {
    let s = startPush(0, 0)
    for (let i = 0; i < 240; i++) s = dragPush(s, 30, 0, DT)
    expect(s.x).toBeGreaterThan(20)
    expect(s.x).toBeLessThan(30)
    for (let i = 0; i < 240; i++) {
      s = dragPush(s, 0, 100, DT)
      expect(s.y).toBeLessThanOrEqual(0)
    }
    for (let i = 0; i < 240; i++) s = dragPush(s, 0, -40, DT)
    expect(s.y).toBeLessThan(-25) // lifted
    expect(Math.abs(s.tilt)).toBeLessThanOrEqual(TILT_MAX)
  })

  it('flick settles', () => {
    let s = releasePush(startPush(0, 46), 800, -400)
    expect(s.phase).toBe('flying')
    s = run(s, 3, () => 46)
    expect(s.phase).toBe('done')
    expect(Math.abs(s.tilt)).toBeLessThan(0.01)
    expect(Math.abs(s.y - 46)).toBeLessThanOrEqual(0.5)
  })

  it('always lands', () => {
    const ground = (x: number) => (x > 200 ? null : 92)
    let s = releasePush(startPush(150, 92), 3000, -300)
    let maxX = -Infinity
    s = run(s, 4, ground, (q) => (maxX = Math.max(maxX, q.x)))
    expect(s.phase).toBe('done')
    expect(s.x).toBeLessThanOrEqual(200)
    expect(maxX).toBeLessThanOrEqual(200) // never out over nothing
    expect(s.y).toBe(92)
    // held out over nothing and let go, it comes back over the line it fell from
    s = { ...startPush(150, 92), x: 230 }
    s = run(releasePush(s, 0, 0), 4, ground)
    expect(s).toMatchObject({ phase: 'done', y: 92 })
    expect(s.x).toBeLessThanOrEqual(200)
  })

  it('a flick is capped, so it never throws the robot off the page', () => {
    const s = releasePush(startPush(0, 0), 5000, -5000)
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(MAX_FLICK_PX_S + 1e-9)
  })

  it('lands on the first standable surface below, at a body-centre x inside a clear piece', () => {
    let n = 0
    for (const x0 of [110, 200, 400, 590])
      for (let vx = -900; vx <= 900; vx += 300)
        for (const vy of [-900, -600, -300, 0, 300]) {
          const s = run(releasePush(startPush(x0, 100), vx, vy), 6, below)
          const at = landing(surfaces, s.x, s.y)
          expect(s.phase, `from ${x0} at ${vx},${vy}`).toBe('done')
          expect(at, `from ${x0} at ${vx},${vy}: ${s.x},${s.y}`).not.toBeNull()
          const piece = surfaces[at!.surface]!
          expect(piece.standable).toBe(true)
          expect(s.y).toBe(piece.y)
          expect(s.x).toBeGreaterThanOrEqual(piece.x0)
          expect(s.x).toBeLessThanOrEqual(piece.x1)
          n++
        }
    expect(n).toBe(140)
    // thrown up high and coming down over the gap in the first line, it falls through to the next it can stand on
    const s = run(releasePush(startPush(250, 100), 120, -700), 6, below)
    expect(landing(surfaces, s.x, s.y)?.surface).toBe(3)
  })

  it('slides along the line it lands on, and stops at the end of its piece', () => {
    const s = run(releasePush(startPush(345, 100), -900, 0), 3, below)
    expect(s).toMatchObject({ phase: 'done', y: 100 })
    expect(s.x).toBeGreaterThanOrEqual(330) // not on into the gap before the piece...
    expect(s.x).toBeLessThan(331) // ...but right up to it
  })

  it('never rests in the air: wherever it stays still it stands on its ground', () => {
    for (const vx of [-700, 0, 500])
      for (const vy of [-800, -200, 0]) {
        run(releasePush(startPush(200, 100), vx, vy), 6, below, (s, prev) => {
          if (s.phase === 'recovering' || s.phase === 'done') expect(s.y).toBe(below(s.x, s.y))
          else if (Math.hypot(s.x - prev.x, s.y - prev.y) < 1e-9) throw new Error(`still in the air at ${s.x},${s.y}`)
        })
      }
  })

  it('the body tilts and comes back level', () => {
    let tilt = 0
    const s = run(releasePush(startPush(0, 46), 900, -300), 3, () => 46, (q) => (tilt = Math.max(tilt, Math.abs(q.tilt))))
    expect(tilt).toBeGreaterThan(0.15)
    expect(tilt).toBeLessThanOrEqual(TILT_MAX)
    expect(s).toMatchObject({ phase: 'done', tilt: 0, vtilt: 0 })
  })
})

describe('runPush: a push over the surfaces of the page, as the page runs it', () => {
  // a ragged-right paragraph: line 0 ends at 500, the lines below it reach further
  const para: Surface[] = [S(0, 100, 100, 500), S(1, 146, 100, 560), S(2, 192, 100, 540)]
  /** Taken hold of at (x, 100) and held still a moment, then let go at (vx, vy); returns the end and every x while held. */
  function fromLine(x: number, vx: number, vy: number) {
    let s = startPush(x, 100)
    const held: number[] = []
    for (let i = 0; i < 24; i++) {
      s = runPush(s, DT, para, { x, y: 100 })
      held.push(s.x)
    }
    s = releasePush(s, vx, vy)
    for (let t = 0; t < 8 && s.phase !== 'done'; t += DT) s = runPush(s, DT, para)
    return { s, held }
  }

  it('from either end of the line it stands on, it lands back on that line, right there', () => {
    for (const x of [500, 100])
      for (const [vx, vy] of [[0, 0], [0, -300]] as const) {
        const { s, held } = fromLine(x, vx, vy)
        expect(held.every((h) => h === x), `held at ${x}`).toBe(true) // no chatter at the end
        expect(s, `from ${x} at ${vx},${vy}`).toMatchObject({ phase: 'done', x, y: 100 })
        expect(landing(para, s.x, s.y)?.surface).toBe(0)
      }
  })

  it('with no ground below it anywhere, it heads for the nearest standable point and stands there', () => {
    // as after a re-layout that left every line above it
    const above: Surface[] = [S(0, 1000, 100, 500), S(1, 1046, 100, 560)]
    for (const [x, vx, vy] of [[300, 0, -200], [900, 300, 0], [50, -500, 400]] as const) {
      let s = releasePush(startPush(x, 1400), vx, vy)
      let t = 0
      for (; t < 6 && s.phase !== 'done'; t += DT) s = runPush(s, DT, above)
      expect(s.phase, `from ${x} at ${vx},${vy}`).toBe('done')
      expect(t).toBeLessThan(3)
      const at = landing(above, s.x, s.y)
      expect(at, `${s.x},${s.y}`).not.toBeNull()
      expect(above[at!.surface]!.standable).toBe(true)
    }
  })
})

describe('push pose', () => {
  const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)
  const groundFoot = MODEL.groundY + 0.03 // the gait's foot point on the ground

  /** Bones keep their lengths, no foot or knee goes below the ground, and the lowest foot is on it. */
  function sound(pose: RobotPose, drop: number, label: string) {
    const ground = groundFoot + drop // the ground line, in the body frame of a robot drawn `drop` lower
    for (const l of pose.legs) {
      expect(dist(l.hip, l.knee), label).toBeCloseTo(MODEL.thigh, 9)
      expect(dist(l.knee, l.foot), label).toBeCloseTo(MODEL.shank, 9)
      expect(l.foot[1], label).toBeGreaterThanOrEqual(ground - 1e-9)
      expect(l.knee[1], label).toBeGreaterThan(ground)
    }
    expect(Math.min(...pose.legs.map((l) => l.foot[1])), label).toBeCloseTo(ground, 9)
  }

  it('splays the legs while pushed: feet out by SPLAY_BL', () => {
    for (const facing of [1, -1] as const) {
      const s: PushState = { ...releasePush(startPush(0, 0), 0, 0), held: 1 }
      const { pose, drop } = pushPose(s, facing)
      const out = MODEL.hipX + SPLAY_BL
      expect(pose.legs.map((l) => l.foot[0])).toEqual([out, out, -out, -out].map((v) => expect.closeTo(v, 9)))
      expect(drop).toBeGreaterThan(0) // the body comes down to let them reach
      sound(pose, drop, `facing ${facing}`)
    }
  })

  it('keeps its bones through a flick and its recovery, then stands exactly as the walker does', () => {
    for (const facing of [1, -1] as const) {
      const from = { pose: standing(facing), drop: 0 }
      let last = pushPose(startPush(0, 0), facing, from)
      expect(last.pose).toEqual(standing(facing)) // takes hold without a jump
      let lifted = false
      const s = run(releasePush(startPush(0, 46), 900 * facing, -500), 3, () => 46, (q) => {
        last = pushPose(q, facing, from)
        sound(last.pose, last.drop, `${q.phase} ${q.since.toFixed(3)}`)
        if (q.phase === 'recovering' && last.pose.legs.some((l) => l.foot[1] > groundFoot + last.drop + 0.01)) lifted = true
      })
      expect(s.phase).toBe('done')
      expect(lifted).toBe(true) // its feet re-plant, stepping
      expect(last.drop).toBe(0)
      expect(last.pose).toEqual(standing(facing))
    }
  })

  it('tilts the whole body, hips with it', () => {
    const s: PushState = { ...releasePush(startPush(0, 0), 0, 0), held: 1, tilt: 0.3 }
    const right = pushPose(s, 1).pose
    // clockwise on screen: facing right the nose goes down, and the front hips with it
    expect(right.bodyPitch).toBeCloseTo(-0.3, 9)
    expect(right.legs[0].hip[1]).toBeLessThan(MODEL.hipY)
    expect(right.legs[2].hip[1]).toBeGreaterThan(MODEL.hipY)
    expect(pushPose(s, -1).pose.bodyPitch).toBeCloseTo(0.3, 9) // mirrored: the nose goes up
  })
})

describe('groundBelow and landing', () => {
  it('finds the first standable piece at or below y that x is over', () => {
    expect(below(150, 0)).toBe(100)
    expect(below(150, 100)).toBe(100) // the line it stands on
    expect(below(150, 101)).toBe(192) // past it: the next it can stand on, not the unstandable one
    expect(below(290, 0)).toBe(192) // over the gap between the first line's pieces
    expect(below(500, 101)).toBe(400)
    expect(below(650, 0)).toBeNull()
    expect(below(150, 401)).toBeNull()
    expect(below(100, 0)).toBe(100) // a piece's ends are on it
    expect(below(260, 0)).toBe(100)
    expect(below((260 / 48) * 48 + 1e-9, 0)).toBe(100) // a hair past it by rounding is still on it
  })

  it('names the piece it stands on', () => {
    expect(landing(surfaces, 200, 100)).toEqual({ surface: 0, x: 200 })
    expect(landing(surfaces, 400, 100)).toEqual({ surface: 1, x: 400 })
    expect(landing(surfaces, 290, 100)).toBeNull()
    expect(landing(surfaces, 300, 146)).toBeNull() // unstandable
    expect(landing(surfaces, 200, 120)).toBeNull()
  })
})
