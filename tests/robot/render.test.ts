import { describe, expect, it } from 'vitest'
import { boxFaces, robotFaces, standingPose, type Face } from '../../src/robot/model.ts'
import { HERO_CAMERA, SIDE_CAMERA, bounds, faceLight, fillColor, groundShadow, mirrorX, pathData, project, strokeColor } from '../../src/robot/render.ts'

describe('project', () => {
  it('single box side-on shows one face', () => {
    const polys = project(boxFaces([0, 0, 0], [1, 1, 1]), { ...SIDE_CAMERA, scale: 100 })
    expect(polys).toHaveLength(1)
    const b = bounds(polys)
    expect(b.maxX - b.minX).toBeCloseTo(100, 9)
    expect(b.maxY - b.minY).toBeCloseTo(100, 9)
  })

  it('hero camera shows three faces of a box', () => {
    expect(project(boxFaces([0, 0, 0], [1, 1, 1]), { ...HERO_CAMERA, scale: 100 })).toHaveLength(3)
  })

  it('sorted far to near', () => {
    const polys = project(robotFaces(standingPose()), { ...HERO_CAMERA, scale: 100 })
    for (let i = 1; i < polys.length; i++) expect(polys[i - 1].depth).toBeLessThanOrEqual(polys[i].depth)
  })

  it('a camera a hair off side-on draws what side-on draws (no edge-on slivers)', () => {
    const faces = robotFaces(standingPose())
    const side = project(faces, { ...SIDE_CAMERA, scale: 48 })
    for (const cam of [{ yaw: 1e-4, pitch: 0 }, { yaw: 0, pitch: 1e-5 }, { yaw: -Math.PI + 5e-5, pitch: 2e-5 }]) {
      const near = project(faces, { ...cam, scale: 48 })
      expect(near.length, JSON.stringify(cam)).toBe(side.length)
    }
  })

  it('ground at y=0', () => {
    const b = bounds(project(robotFaces(standingPose()), { ...SIDE_CAMERA, scale: 48 }))
    expect(Math.abs(b.maxY)).toBeLessThanOrEqual(0.5)
  })
})

describe('svg helpers', () => {
  it('pathData offsets at 0.1px', () => {
    expect(pathData({ pts: [[0, 0], [10.04, 0], [10, 5.25]] }, 1, 2)).toBe('M1.0 2.0L11.0 2.0L11.0 7.3Z')
  })
  it('mirrorX flips left-right and keeps paint order', () => {
    const polys = project(robotFaces(standingPose()), { ...SIDE_CAMERA, scale: 48 })
    const m = mirrorX(polys)
    const a = bounds(polys)
    const b = bounds(m)
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-a.maxX, -a.minX, a.minY, a.maxY])
    expect(m.map((p) => p.depth)).toEqual(polys.map((p) => p.depth))
  })
})

describe('leg tones', () => {
  const faces = robotFaces(standingPose())
  const tones = (fs: typeof faces, yaw: number) => [...new Set(project(fs, { yaw, pitch: 0.2, scale: 48 }).map((p) => p.tone))]
  const far = faces.filter((f) => f.leg && f.far)
  const near = faces.filter((f) => f.leg && !f.far)
  const body = faces.filter((f) => !f.leg)

  it('legs on the far side from the camera are grey, the near side ink', () => {
    for (const yaw of [HERO_CAMERA.yaw, SIDE_CAMERA.yaw]) {
      expect(tones(far, yaw)).toEqual([1])
      expect(tones(near, yaw)).toEqual([0])
    }
  })

  it('turned round, the sides trade tones; end-on they are even', () => {
    expect(tones(far, -Math.PI)).toEqual([0])
    expect(tones(near, -Math.PI)).toEqual([1])
    for (const t of [...tones(far, -Math.PI / 2), ...tones(near, -Math.PI / 2)]) expect(t).toBeCloseTo(0.5, 9)
  })

  it('the body is always ink', () => {
    for (const yaw of [0, -0.6, -Math.PI / 2, -2.5, -Math.PI]) expect(tones(body, yaw)).toEqual([0])
  })

  it('strokeColor: ink, grey, and greys between', () => {
    const c = (tone: number) => strokeColor({ pts: [], depth: 0, tone, light: 1 })
    expect(c(0)).toBe('#111')
    expect(c(1)).toBe('#9a9a9a')
    expect(c(0.5)).toMatch(/^#([0-9a-f]{2})\1\1$/)
    const v = (tone: number) => parseInt(c(tone).slice(1, 3), 16)
    expect(v(0.25)).toBeGreaterThan(0x11)
    expect(v(0.75)).toBeGreaterThan(v(0.25))
    expect(v(0.75)).toBeLessThan(0x9a)
  })
})

describe('shading', () => {
  const box = boxFaces([0, 0, 0], [1, 1, 1])
  const centre = (f: Face) => [0, 1, 2].map((k) => f.pts.reduce((s, p) => s + p[k]!, 0) / 4)
  /** The box face whose centre lies on the `sign` side along `axis` (0 x, 1 y, 2 z). */
  const face = (axis: number, sign: 1 | -1) => box.find((f) => centre(f)[axis]! * sign > 0.4)!

  it('the light comes from above, a little from the near side and the front', () => {
    const top = faceLight(face(1, 1))
    const side = faceLight(face(2, 1))
    const front = faceLight(face(0, 1))
    expect(top).toBeGreaterThan(side)
    expect(side).toBeGreaterThan(front)
    expect(front).toBeGreaterThan(0)
    expect(top).toBeLessThanOrEqual(1)
  })

  it('faces turned away from the light get none', () => {
    for (const [axis, sign] of [[1, -1], [0, -1], [2, -1]] as const) expect(faceLight(face(axis, sign))).toBe(0)
  })

  it('each polygon carries its face’s light', () => {
    const lights = project(box, { ...HERO_CAMERA, scale: 100 }).map((p) => p.light).sort()
    expect(lights).toEqual([face(0, 1), face(2, 1), face(1, 1)].map(faceLight).sort())
  })

  it('fillColor: white unshaded, greys by how little light a face gets, paler on the far side', () => {
    const poly = (light: number, tone = 0) => ({ pts: [], depth: 0, tone, light })
    const v = (c: string) => parseInt(c.slice(1, 3), 16)
    for (const light of [0, 0.5, 1]) expect(fillColor(poly(light), 0)).toBe('#fff')
    expect(fillColor(poly(1), 1)).toBe('#fff')
    expect(fillColor(poly(0.5), 1)).toMatch(/^#([0-9a-f]{2})\1\1$/)
    expect(v(fillColor(poly(0.5), 1))).toBeLessThan(0xff)
    expect(v(fillColor(poly(0), 1))).toBeLessThan(v(fillColor(poly(0.5), 1)))
    expect(v(fillColor(poly(0, 1), 1))).toBeGreaterThan(v(fillColor(poly(0), 1)))
    expect(v(fillColor(poly(0), 0.5))).toBeGreaterThan(v(fillColor(poly(0), 1)))
    expect(v(fillColor(poly(0), 1))).toBeGreaterThanOrEqual(0xa0) // a light grey at most: it stays a line drawing
  })

  it('ground shadow: on the ground, centred under the body', () => {
    const s = groundShadow({ ...HERO_CAMERA, scale: 100 })
    expect(s).toHaveLength(4)
    expect(s.reduce((a, p) => a + p[0], 0) / 4).toBeCloseTo(0, 9)
    expect(s.reduce((a, p) => a + p[1], 0) / 4).toBeCloseTo(0, 9)
    for (const p of groundShadow({ ...SIDE_CAMERA, scale: 100 })) expect(p[1]).toBeCloseTo(0, 9) // seen level, it has no height
  })
})
