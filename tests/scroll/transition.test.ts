import { describe, expect, it } from 'vitest'
import { initGait, poseFromGait, stepGait, WANDER_SPEED } from '../../src/robot/gait.ts'
import { boxFaces, MODEL, robotFaces, standingPose, type RobotPose, type Vec2 } from '../../src/robot/model.ts'
import { HERO_CAMERA, mirrorX, project, SIDE_CAMERA, type Polygon } from '../../src/robot/render.ts'
import { gapAt, partsCleanly, type Clearance } from '../../src/terrain/clearance.ts'
import type { Rect } from '../../src/terrain/terrain.ts'
import { LANE_GAP, lerpPose, lerpView, planLane, progress, scrollSpan, sideSwapped, STAGES, turnYaw, walkInParting, type View } from '../../src/scroll/transition.ts'
import type { PaintedLine } from '../../src/text/flow.ts'
import { fitAroundGap } from '../../src/text/split.ts'

const hero: View = { ...HERO_CAMERA, scale: 330, x: 720, y: 594, stroke: 1.6, shade: 1 }
const walker: View = { ...SIDE_CAMERA, scale: 48, x: 160, y: 870, stroke: 1.1, shade: 0 }

/** A mid-stride gait pose: the legs differ from standing and from each other. */
function midStride(): RobotPose {
  let g = initGait(0, 1)
  g = stepGait(g, 0.7, WANDER_SPEED, { x0: -5, x1: 5 })
  return poseFromGait(g)
}

describe('progress', () => {
  it('clamped', () => {
    expect(progress(-50, 0, 400)).toBe(0)
    expect(progress(900, 0, 400)).toBe(1)
  })

  it('linear in between', () => {
    expect(progress(100, 0, 400)).toBe(0.25)
    expect(progress(300, 100, 500)).toBe(0.5)
  })

  it('an empty range is a step at its end', () => {
    expect(progress(-1, 0, 0)).toBe(0)
    expect(progress(0, 0, 0)).toBe(1)
  })
})

describe('lerpView', () => {
  it('endpoints exact', () => {
    expect(lerpView(hero, walker, 0)).toEqual(hero)
    expect(lerpView(hero, walker, 1)).toEqual(walker)
  })

  it('the shading fades out as the camera turns: none once it has', () => {
    const shades = Array.from({ length: 100 }, (_, i) => lerpView(hero, walker, (i / 99) * STAGES.turn[1]).shade)
    expect(shades[0]).toBe(1)
    expect(shades.at(-1)).toBe(0)
    for (let i = 1; i < shades.length; i++) expect(shades[i]!).toBeLessThanOrEqual(shades[i - 1]!)
    expect(lerpView(hero, walker, STAGES.turn[1] / 2).shade).toBeGreaterThan(0)
  })

  it('monotonic yaw', () => {
    const yaws = Array.from({ length: 100 }, (_, i) => lerpView(hero, walker, i / 99).yaw)
    expect(yaws[0]).toBe(-0.6)
    expect(yaws.at(-1)).toBe(0)
    for (let i = 1; i < yaws.length; i++) expect(yaws[i]!).toBeGreaterThanOrEqual(yaws[i - 1]!)
  })

  it('turning round to face left, yaw falls monotonically to -π', () => {
    const left = { ...walker, yaw: turnYaw(-1) }
    const yaws = Array.from({ length: 100 }, (_, i) => lerpView(hero, left, i / 99).yaw)
    expect(yaws.at(-1)).toBe(-Math.PI)
    for (let i = 1; i < yaws.length; i++) expect(yaws[i]!).toBeLessThanOrEqual(yaws[i - 1]!)
  })

  it('reversible', () => {
    const a = Array.from({ length: 50 }, (_, i) => lerpView(hero, walker, i / 49))
    const b = Array.from({ length: 50 }, (_, i) => lerpView(hero, walker, (49 - i) / 49)).reverse()
    expect(b).toEqual(a)
    expect(lerpView(hero, walker, 0.37)).toEqual(lerpView(hero, walker, 0.37))
  })

  it('eased: starts and lands with zero speed', () => {
    const d = (p: number) => Math.abs(lerpView(hero, walker, p).x - hero.x)
    expect(d(0.01)).toBeLessThan(0.001 * Math.abs(walker.x - hero.x))
    const e = Math.abs(lerpView(hero, walker, 0.99).x - walker.x)
    expect(e).toBeLessThan(0.001 * Math.abs(walker.x - hero.x))
  })

  it('scale shrinks at an even rate (geometric), stroke thins linearly, while the camera turns', () => {
    const mid = lerpView(hero, walker, (STAGES.turn[0] + STAGES.turn[1]) / 2)
    expect(mid.scale).toBeCloseTo(Math.sqrt(hero.scale * walker.scale), 9)
    expect(mid.stroke).toBeCloseTo(1.35, 9)
    let last = Infinity
    for (let i = 0; i <= 100; i++) {
      const s = lerpView(hero, walker, i / 100).scale
      expect(s).toBeLessThanOrEqual(last)
      last = s
    }
  })

  it('out-of-range p clamps to the endpoints', () => {
    expect(lerpView(hero, walker, -0.5)).toEqual(hero)
    expect(lerpView(hero, walker, 1.5)).toEqual(walker)
  })
})

describe('lerpView through a lane', () => {
  const lane = 100
  const at = (p: number) => lerpView(hero, walker, p, lane)

  it('endpoints exact', () => {
    expect(at(0)).toEqual(hero)
    expect(at(1)).toEqual(walker)
  })

  it('the camera leads: side-on and walker-sized once it has turned, while it reaches the lane', () => {
    const v = at(STAGES.turn[1])
    expect([v.yaw, v.pitch, v.scale, v.stroke]).toEqual([walker.yaw, walker.pitch, walker.scale, walker.stroke])
    expect([v.x, v.y]).toEqual([lane, hero.y])
    expect(at(0.35).scale).toBeLessThan(1.05 * walker.scale) // mostly shrunk well before
  })

  it('stages: sideways at the hero height, down the lane, then in along the line', () => {
    for (let p = 0; p <= STAGES.turn[1]; p += 0.01) expect(at(p).y).toBe(hero.y)
    for (let p = STAGES.drop[0]; p <= STAGES.drop[1]; p += 0.01) expect(at(p).x).toBe(lane)
    for (let p = STAGES.enter[0]; p < 1; p += 0.01) expect(at(p).y).toBe(walker.y)
  })

  it('continuous: no step between nearby p moves it more than its eased speed allows', () => {
    const n = 4000
    const span = Math.max(Math.abs(hero.x - lane), Math.abs(walker.x - lane), Math.abs(walker.y - hero.y))
    for (let i = 1; i <= n; i++) {
      const a = at((i - 1) / n)
      const b = at(i / n)
      // smootherstep peaks at 1.875 / stage length per unit p; the shortest stage is 0.25
      expect(Math.abs(b.x - a.x) + Math.abs(b.y - a.y)).toBeLessThan(((1.875 / 0.25) * span) / n + 1e-9)
      expect(Math.abs(b.yaw - a.yaw)).toBeLessThan(((1.875 / 0.4) * 0.6) / n + 1e-9)
    }
  })

  it('lands without a jump: the last 1/400 of p moves it under 0.01px', () => {
    const v = at(1 - 1 / 400)
    expect(Math.abs(v.x - walker.x) + Math.abs(v.y - walker.y)).toBeLessThan(0.01)
  })
})

// A desktop-like synthetic page: centred hero text under the hero robot, then a bio column of
// lines 46px apart. Text boxes are glyph bands, as laid out (a line parted around an earlier
// walker is planned unparted); the walker lands near the start of a deep line.
describe('the lane', () => {
  const half = 30
  const height = 39
  const col = { x0: 380, x1: 1060 }
  const heroText: Rect[] = [
    { x0: 515, y0: 607, x1: 925, y1: 700 }, // name
    { x0: 421, y0: 712, x1: 1019, y1: 772 }, // description, two lines
    { x0: 606, y0: 782, x1: 833, y1: 800 }, // now
  ]
  const lines = (n: number, top: number): Rect[] =>
    Array.from({ length: n }, (_, i) => ({ x0: col.x0, y0: top + 46 * i + 11, x1: col.x1 - 40 * (i % 3), y1: top + 46 * (i + 1) }))
  const bio = lines(14, 880)
  const deep = 9 // line index the walker stands on
  const ground = bio[deep]!.y0
  const landing = col.x0 + 24
  const text = [...heroText, ...bio]
  const fixed = heroText // the text that never parts
  const above = bio[deep - 1]! // the line the walk-in parts around the robot
  const clean = () => true // every line the walk-in reaches parts cleanly around it all the way
  const room = { minX: 8, maxX: 1432 }
  const heroView: View = { ...HERO_CAMERA, scale: 330, x: 720, y: 594, stroke: 1.6, shade: 1 }
  const walkerView: View = { ...SIDE_CAMERA, scale: 48, x: landing, y: ground, stroke: 1.1, shade: 0 }
  const q = { text, fixed, top: heroView.y, bottom: ground, half, height, room, landing, walkIn: clean }
  // the robot's box at a view: its reach scales with the view (the hero's is wider and taller)
  const box = (v: View): Rect => {
    const k = v.scale / walkerView.scale
    return { x0: v.x - half * k, y0: v.y - height * k, x1: v.x + half * k, y1: v.y }
  }
  const meets = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

  it('never crosses text when a lane exists', () => {
    const { x: lane, clear } = planLane(q)
    expect(clear).toBe(true)
    expect(lane + half + LANE_GAP).toBeLessThanOrEqual(col.x0) // the left margin has room
    for (let i = 0; i <= 200; i++) {
      const b = box(lerpView(heroView, walkerView, i / 200, lane))
      // walking in, the line above parts around it (see the walk-in's parting, below)
      for (const r of text) if (r !== above) expect(meets(b, r), `p=${i / 200} ${JSON.stringify(r)}`).toBe(false)
      if (meets(b, above)) expect(i / 200, 'reaches the line above only walking in').toBeGreaterThan(STAGES.enter[0])
    }
  })

  it('a straight flight would cross it', () => {
    const crossed = Array.from({ length: 201 }, (_, i) => box(lerpView(heroView, walkerView, i / 200))).filter((b) => text.some((r) => r !== above && meets(b, r)))
    expect(crossed.length).toBeGreaterThan(20)
  })

  it('a walk-in the text cannot part around cleanly is not clear', () => {
    expect(planLane({ ...q, walkIn: () => false }).clear).toBe(false)
  })

  it('picks the side whose walk-in is clean', () => {
    // near the column's start, but only the walk-in from the right parts cleanly all the way
    const lane = planLane({ ...q, walkIn: (x) => x > col.x1 })
    expect(lane.x).toBeGreaterThan(col.x1)
    expect(lane.clear).toBe(true)
  })

  it('the walk-in keeps clear of text that does not part', () => {
    // a heading at the walker's height between the left lane and the landing: only the right is clean
    const heading: Rect = { x0: col.x0 - 40, y0: ground - 30, x1: col.x0 - 30, y1: ground - 12 }
    const lane = planLane({ ...q, text: [...text, heading], fixed: [...fixed, heading] })
    expect(lane.x).toBeGreaterThan(col.x1)
    expect(lane.clear).toBe(true)
  })

  it('picks the side that crosses less, then the side nearer the landing', () => {
    expect(planLane(q).x).toBeLessThan(col.x0) // near the column's start: the left lane
    expect(planLane({ ...q, landing: col.x1 - 30 }).x).toBeGreaterThan(col.x1) // near its end: the right lane
    // neither walk-in clean: the shorter walk across the line above
    const rough = { ...q, walkIn: () => false }
    expect(planLane(rough).x).toBeLessThan(col.x0)
    expect(planLane({ ...rough, landing: col.x1 - 30 }).x).toBeGreaterThan(col.x1)
  })

  it('with no room on one side (a phone), the side that crosses less', () => {
    // a block of text from the room's left edge: the left lane would run through it
    const block: Rect = { x0: 10, y0: 0, x1: 500, y1: 1000 }
    const b = { text: [block], fixed: [], top: 100, bottom: 900, half, height, room: { minX: 0, maxX: 1000 }, landing: 450, walkIn: clean }
    expect(planLane(b)).toEqual({ x: 500 + LANE_GAP + half, clear: true })
    // no room on either side: the drop crowds the text, and says so
    expect(planLane({ ...b, room: { minX: 0, maxX: 520 } }).clear).toBe(false)
  })

  it('stays inside the room, and drops straight onto the landing with no text beside it', () => {
    const lane = planLane({ ...q, room: { minX: 360, maxX: 1080 } })
    expect(lane.x - half).toBeGreaterThanOrEqual(360)
    expect(lane.x + half).toBeLessThanOrEqual(1080)
    expect(lane.clear).toBe(false) // squeezed into the column
    expect(planLane({ ...q, text: [], fixed: [] })).toEqual({ x: landing, clear: true })
  })
})

// The walk-in's parting, on a synthetic clearance: line 0 is above the line the walker lands on
// (line 1) and has a long word [100, 220] it can't part around; the walker reaches x ± 20 and
// 30px up, with a 5px pad, so a 50px gap; line 0's words start at x = 0.
describe('the walk-in parting', () => {
  const words = [
    { x0: 0, x1: 40 },
    { x0: 50, x1: 90 },
    { x0: 100, x1: 220 },
    { x0: 230, x1: 270 },
    { x0: 280, x1: 320 },
  ]
  const line = (index: number, y: number): PaintedLine => ({ flow: 'bio-0', index, x: 0, y, width: 320, lineHeight: 40, words })
  const c: Clearance = { lines: [line(0, 0), line(1, 40)], bandTop: [10, 50], half: 20, height: 30, pad: 5, room: { minX: -5, maxX: 400 }, maxLeftShift: 6 }
  const sil = (x: number): Rect => ({ x0: x - 18, y0: 22, x1: x + 18, y1: 50 }) // drawn, standing on line 1
  const lane = -60 // the robot's reach [-80, -40] is well clear of line 0
  const enter = (k: number) => STAGES.enter[0] + k * (STAGES.enter[1] - STAGES.enter[0])

  it('nothing parts before it walks in, wherever it is', () => {
    for (let p = 0; p < STAGES.enter[0]; p += 0.01)
      for (const x of [lane, 30, 200]) expect(walkInParting(c, p, lane, x, sil(x)).lines, `p=${p} x=${x}`).toEqual([])
  })

  it('walking in, the line above parts around the drawn robot where it parts cleanly', () => {
    expect(walkInParting(c, enter(0.5), lane, 30, sil(30)).lines).toEqual([0])
    expect(walkInParting(c, enter(0.9), lane, 280, sil(280)).lines).toEqual([0])
  })

  it('where it cannot part cleanly, nothing parts: the robot passes over the words', () => {
    // under the long word: hiding it, or moving the line's start more than 6px, is the only room
    expect(partsCleanly(c, 0, 160)).toBe(false)
    expect(walkInParting(c, enter(0.6), lane, 160, sil(160)).lines).toEqual([])
  })

  it('never leaves a gap away from the robot', () => {
    for (let k = 0; k < 1; k += 0.02)
      for (let x = -60; x <= 380; x += 7) {
        const { lines, gap } = walkInParting(c, enter(k), lane, x, sil(x))
        if (!lines.length) continue
        expect(gap[0], `k=${k} x=${x}`).toBeLessThanOrEqual(x - c.half)
        expect(gap[1], `k=${k} x=${x}`).toBeGreaterThanOrEqual(x + c.half)
        for (const j of lines) {
          const f = fitAroundGap(words, gap[0], gap[1], c.room.minX, c.room.maxX)
          expect(f.rightStart, `line ${j} k=${k} x=${x}: nothing hidden`).toBe(f.leftEnd)
          expect(f.leftShift).toBeLessThanOrEqual(c.maxLeftShift)
        }
      }
  })

  it('only the lines the drawn robot reaches part', () => {
    const high: Rect = { x0: 12, y0: -40, x1: 48, y1: 5 } // above line 0's glyph tops
    expect(walkInParting(c, enter(0.5), lane, 30, high).lines).toEqual([])
  })

  it('nothing moves the moment it starts, even from a lane closer to the text than the pad', () => {
    const near = -22 // reach [-42, -2]: 2px from line 0's first word, less than the 5px pad
    const shiftAt = (k: number) => {
      const x = near + k * 50
      const { lines, gap } = walkInParting(c, enter(k), near, x, sil(x))
      return lines.length ? fitAroundGap(words, gap[0], gap[1], c.room.minX, c.room.maxX).shift : 0
    }
    expect(shiftAt(0)).toBe(0)
    let last = 0
    for (let k = 0.001; k < 0.2; k += 0.001) {
      const s = shiftAt(k)
      expect(Math.abs(s - last), `k=${k}`).toBeLessThan(0.5) // the first word slides, never jumps
      last = s
    }
  })

  it('arrives at the walker’s own parting', () => {
    const x = 30
    const { lines, gap } = walkInParting(c, 1 - 1e-12, -22, x, sil(x)) // from the lane 2px from the text, too
    expect(walkInParting(c, STAGES.enter[0], -22, -22, sil(-22)).gap[1]).toBe(0) // which started with a 2px pad
    expect(lines).toEqual([0])
    const [l, r] = gapAt(c, x)
    expect(gap[0]).toBeCloseTo(l, 6)
    expect(gap[1]).toBeCloseTo(r, 6)
  })

  it('is a function of p and where the robot is: the same going back', () => {
    const at = (p: number) => walkInParting(c, p, lane, 30 + 100 * p, sil(30 + 100 * p))
    const up = Array.from({ length: 40 }, (_, i) => at(i / 39))
    const down = Array.from({ length: 40 }, (_, i) => at((39 - i) / 39)).reverse()
    expect(down).toEqual(up)
  })
})

describe('scrollSpan', () => {
  it('until the landing line is 55% down the viewport', () => {
    expect(scrollSpan(900, 900, 2000)).toBeCloseTo(405, 9)
  })
  it('at least 0.3 of a viewport on a tall screen', () => {
    expect(scrollSpan(980, 2560, 1200)).toBeCloseTo(768, 9)
    expect(scrollSpan(980, 2560, 500)).toBe(500) // but no more than the page scrolls
  })
  it('0 when the page cannot scroll, so p is 1 at once', () => {
    expect(scrollSpan(980, 5000, 0)).toBe(0)
    expect(progress(0, 0, scrollSpan(980, 5000, 0))).toBe(1)
  })
})

describe('lerpPose', () => {
  const stand = standingPose()
  const gait = midStride()

  it('endpoints exact', () => {
    expect(lerpPose(stand, gait, 0)).toEqual(stand)
    expect(lerpPose(stand, gait, 1)).toEqual(gait)
  })

  it('continuous at both ends', () => {
    const near = (a: RobotPose, b: RobotPose) =>
      a.legs.every((l, i) => (['hip', 'knee', 'foot'] as const).every((j) => Math.hypot(l[j][0] - b.legs[i]![j][0], l[j][1] - b.legs[i]![j][1]) < 1e-4))
    expect(near(lerpPose(stand, gait, 1e-4), stand)).toBe(true)
    expect(near(lerpPose(stand, gait, 1 - 1e-4), gait)).toBe(true)
  })

  it('keeps every link its length in between', () => {
    for (const p of [0.2, 0.5, 0.8]) {
      for (const l of lerpPose(stand, gait, p).legs) {
        expect(Math.hypot(l.knee[0] - l.hip[0], l.knee[1] - l.hip[1])).toBeCloseTo(MODEL.thigh, 9)
        expect(Math.hypot(l.foot[0] - l.knee[0], l.foot[1] - l.knee[1])).toBeCloseTo(MODEL.shank, 9)
      }
    }
  })
})

describe('hand-off', () => {
  it('turned round, the side-swapped pose draws exactly the mirrored walker', () => {
    const pose = midStride()
    const scale = 48
    const mirrored = mirrorX(project(robotFaces(pose), { ...SIDE_CAMERA, scale }))
    const turned = project(robotFaces(sideSwapped(pose)), { yaw: turnYaw(-1), pitch: 0, scale })
    // the same outlines (a face's corners may start elsewhere), tones and paint order
    const outline = (pts: Vec2[]) => pts.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).sort().join(',')
    const picture = (polys: Polygon[]) => polys.map((p) => ({ outline: outline(p.pts), tone: p.tone }))
    expect(picture(turned)).toEqual(picture(mirrored))
  })

  it('side-swapping a symmetric pose changes nothing', () => {
    expect(sideSwapped(standingPose())).toEqual(standingPose())
  })

  // The hero view places the drawing by its ground point, as the walker's does: under every
  // camera on the way (either way round), the ground point under the body centre is the origin.
  it('ground point under the body centre maps to (0, 0) along the transition', () => {
    const point = boxFaces([0, MODEL.groundY, 0], [1e-6, 1e-6, 1e-6])
    for (const facing of [1, -1] as const) {
      const w = { ...walker, yaw: turnYaw(facing) }
      for (let i = 0; i <= 20; i++) {
        const v = lerpView(hero, w, i / 20)
        const polys = project(point, v)
        expect(polys.length).toBeGreaterThan(0)
        for (const q of polys.flatMap((p) => p.pts)) {
          expect(Math.abs(q[0])).toBeLessThan(1e-3)
          expect(Math.abs(q[1])).toBeLessThan(1e-3)
        }
      }
    }
  })
})
