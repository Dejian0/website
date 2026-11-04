import { describe, expect, it } from 'vitest'
import { initGait, poseFromGait, settleGait, stepGait, turnGait, WANDER_SPEED } from '../../src/robot/gait.ts'
import type { GaitState } from '../../src/robot/gait.ts'
import { MODEL } from '../../src/robot/model.ts'

const span = { x0: 0, x1: 20 }

describe('gait', () => {
  it('planted feet do not slide', () => {
    let s = initGait(2, 1)
    const last: (number | null)[] = [null, null, null, null]
    for (let i = 0; i < 480; i++) {
      s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      s.feet.forEach((f, j) => {
        if (f.planted && last[j] !== null) expect(Math.abs(f.x - last[j]!)).toBeLessThan(1e-9)
        last[j] = f.planted ? f.x : null
      })
    }
  })
  it('trot pairs', () => {
    let s = initGait(2, 1)
    let swung = false
    for (let i = 0; i < 480; i++) {
      s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      const p = s.feet.map((f) => f.planted)
      expect(p[0]).toBe(p[3])
      expect(p[1]).toBe(p[2])
      if (!p[0] || !p[1]) swung = true
    }
    expect(swung).toBe(true)
  })
  it('body advances', () => {
    let s = initGait(2, 1)
    for (let i = 0; i < 240; i++) s = stepGait(s, 1 / 240, WANDER_SPEED, span)
    expect(Math.abs((s.bodyX - 2) / WANDER_SPEED - 1)).toBeLessThan(0.01)
  })
  it('turns at span end', () => {
    let s = initGait(1, 1)
    let flipped = false
    for (let i = 0; i < 240 * 10; i++) {
      s = stepGait(s, 1 / 240, WANDER_SPEED, { x0: 0, x1: 2 })
      expect(s.bodyX).toBeGreaterThanOrEqual(0)
      expect(s.bodyX).toBeLessThanOrEqual(2)
      if (s.facing === -1) flipped = true
    }
    expect(flipped).toBe(true)
  })
  it('pose keeps feet on the ground and legs reachable', () => {
    let s = initGait(2, -1)
    for (let i = 0; i < 480; i++) {
      s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      const pose = poseFromGait(s)
      pose.legs.forEach((l) => {
        expect(l.foot[1]).toBeGreaterThanOrEqual(MODEL.groundY + 0.03 - 1e-9)
        expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 9)
      })
    }
  })

  // invariants checked after every step
  const reach = MODEL.thigh + MODEL.shank
  function check(s: GaitState, sp: { x0: number; x1: number }) {
    const pose = poseFromGait(s)
    pose.legs.forEach((l, i) => {
      const front = i < 2 ? 1 : -1
      const hipW = s.bodyX + s.facing * front * MODEL.hipX
      const footW = s.bodyX + s.facing * l.foot[0]
      expect(Math.abs(s.feet[i]!.x - footW)).toBeLessThan(1e-9)
      expect(Math.hypot(l.foot[0] - l.hip[0], l.foot[1] - l.hip[1])).toBeLessThanOrEqual(reach + 1e-6)
      expect(Math.abs(hipW - s.bodyX - s.facing * l.hip[0])).toBeLessThan(1e-9)
      expect(Math.hypot(l.foot[0] - l.knee[0], l.foot[1] - l.knee[1])).toBeCloseTo(MODEL.shank, 6)
      expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 6)
      expect(s.feet[i]!.x).toBeGreaterThanOrEqual(sp.x0 - 1e-9)
      expect(s.feet[i]!.x).toBeLessThanOrEqual(sp.x1 + 1e-9)
    })
    expect(s.bodyX - 0.5).toBeGreaterThanOrEqual(sp.x0 - 1e-9)
    expect(s.bodyX + 0.5).toBeLessThanOrEqual(sp.x1 + 1e-9)
  }

  for (const sp of [{ x0: 0, x1: 2 }, { x0: 0, x1: 20 }]) {
    it(`turns keep feet reachable, planted and in span (span ${sp.x1})`, () => {
      let s = initGait(sp.x1 === 2 ? 1 : 10, 1)
      const last: (number | null)[] = [null, null, null, null]
      let turns = 0
      const steps = sp.x1 === 2 ? 240 * 12 : 240 * 70
      for (let i = 0; i < steps; i++) {
        const prev = s.facing
        s = stepGait(s, 1 / 240, WANDER_SPEED, sp)
        if (s.facing !== prev) {
          turns++
          // feet change owner across a turn: FL<->HL, FR<->HR
          const l = last.slice()
          last[0] = l[2]!; last[1] = l[3]!; last[2] = l[0]!; last[3] = l[1]!
        }
        check(s, sp)
        const p = s.feet.map((f) => f.planted)
        expect(p[0]).toBe(p[3])
        expect(p[1]).toBe(p[2])
        s.feet.forEach((f, j) => {
          if (f.planted && last[j] !== null) expect(Math.abs(f.x - last[j]!)).toBeLessThan(1e-9)
          last[j] = f.planted ? f.x : null
        })
      }
      expect(turns).toBeGreaterThanOrEqual(2)
    })
  }

  describe('stopping', () => {
    const GROUND = MODEL.groundY + 0.03
    // stopped at many moments of the stride, including mid-swing and just after a turn
    const stops = Array.from({ length: 24 }, (_, k) => 7 + k * 11)

    it('settleGait brings every foot down within 0.5 s, the body standing still', () => {
      for (const n of stops) {
        let s = initGait(2, 1)
        for (let i = 0; i < n; i++) s = stepGait(s, 1 / 240, WANDER_SPEED, { x0: 0, x1: 3 })
        const x = s.bodyX
        const facing = s.facing
        for (let i = 0; i < 120; i++) {
          const before = poseFromGait(s)
          s = settleGait(s, 1 / 240, WANDER_SPEED)
          check(s, { x0: -1, x1: 5 })
          // smoothly: no foot moves more than a walking step's worth in one 1/240 s step
          poseFromGait(s).legs.forEach((l, j) => {
            expect(Math.hypot(l.foot[0] - before.legs[j]!.foot[0], l.foot[1] - before.legs[j]!.foot[1])).toBeLessThan(0.02)
          })
        }
        expect(s.bodyX).toBe(x)
        expect(s.facing).toBe(facing)
        expect(s.feet.every((f) => f.planted)).toBe(true)
        for (const l of poseFromGait(s).legs) expect(l.foot[1]).toBeCloseTo(GROUND, 9)
      }
    })

    it('a stride stopped mid-swing really had a foot in the air', () => {
      let s = initGait(2, 1)
      for (let i = 0; i < 30; i++) s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      expect(Math.max(...poseFromGait(s).legs.map((l) => l.foot[1]))).toBeGreaterThan(GROUND + 0.01)
      // stepGait at speed 0 leaves it there: that is what settleGait is for
      expect(Math.max(...poseFromGait(stepGait(s, 0.5, 0, span)).legs.map((l) => l.foot[1]))).toBeGreaterThan(GROUND + 0.01)
    })

    it('walks on from a settled stance without a foot jumping', () => {
      let s = initGait(2, 1)
      for (let i = 0; i < 30; i++) s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      for (let i = 0; i < 120; i++) s = settleGait(s, 1 / 240, WANDER_SPEED)
      const was = s.feet.map((f) => f.x)
      const next = stepGait(s, 1 / 240, WANDER_SPEED, span)
      next.feet.forEach((f, j) => expect(Math.abs(f.x - was[j]!)).toBeLessThan(0.02))
    })

    it('turnGait faces the other way with every foot where it was', () => {
      let s = initGait(2, 1)
      for (let i = 0; i < 50; i++) s = stepGait(s, 1 / 240, WANDER_SPEED, span)
      const t = turnGait(s)
      expect(t.facing).toBe(-1)
      expect(t.bodyX).toBe(s.bodyX)
      expect(t.feet.map((f) => f.x).sort()).toEqual(s.feet.map((f) => f.x).sort())
      check(t, span)
    })
  })

  it('large dt stays valid', () => {
    const sp = { x0: 0, x1: 20 }
    check(stepGait(initGait(10, 1), 1.0, WANDER_SPEED, sp), sp)
    check(stepGait(initGait(10, -1), 30, WANDER_SPEED, sp), sp)
    let s = initGait(1, 1)
    for (let i = 0; i < 300; i++) {
      s = stepGait(s, 0.1, 2 * WANDER_SPEED, { x0: 0, x1: 3 })
      check(s, { x0: 0, x1: 3 })
    }
  })
})
