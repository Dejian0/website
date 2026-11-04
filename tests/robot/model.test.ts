import { describe, expect, it } from 'vitest'
import { robotFaces, standingPose } from '../../src/robot/model.ts'

describe('model', () => {
  it('standing pose is symmetric', () => {
    const [fl, fr, hl, hr] = standingPose().legs
    expect(fl.hip[0]).toBe(fr.hip[0])
    expect(fl.knee[0]).toBe(fr.knee[0])
    expect(fl.foot[0]).toBe(fr.foot[0])
    expect(hl.hip[0]).toBe(hr.hip[0])
    expect(hl.knee[0]).toBe(hr.knee[0])
    expect(hl.foot[0]).toBe(hr.foot[0])
  })

  it('far flags', () => {
    const faces = robotFaces(standingPose())
    const BODY = 4 * 6 // body, top cover, sensor head, rear bumper come first
    expect(faces.slice(0, BODY).every((f) => !f.far)).toBe(true)
    const legs = faces.slice(BODY)
    for (const f of legs) if (f.pts.every((p) => p[2] < 0)) expect(f.far).toBe(true)
    expect(legs.some((f) => f.far)).toBe(true)
    expect(legs.some((f) => !f.far)).toBe(true)
  })
})
