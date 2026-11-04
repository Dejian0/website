import { describe, expect, it } from 'vitest'
import { BALLISTIC_G, NO_RISE_MIN_S, NO_RISE_VX, noRiseMotion, type Motion } from '../../src/robot/ballistic.ts'

const S = 48 // px per body length

/** Positions and velocities (px/s) every dt seconds. */
function samples(m: Motion, dt = 1 / 4000) {
  const out: { s: number; x: number; y: number; vx: number; vy: number }[] = []
  for (let s = 0; s + dt <= m.dur + 1e-12; s += dt) {
    const a = m.at(s)
    const b = m.at(Math.min(m.dur, s + dt))
    out.push({ s, x: a.x, y: a.y, vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt })
  }
  return out
}

/** Furthest the path strays from the straight line between its ends, px. */
function bulge(m: Motion) {
  const a = m.at(0)
  const b = m.at(m.dur)
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  return Math.max(...samples(m).map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len))
}

describe('a hop that does not rise', () => {
  // a step down a 24px blurb line, moving 19px along, and the same step back up
  const down = noRiseMotion(405, 2004, 424, 2028, S, 1)
  const up = noRiseMotion(424, 2028, 405, 2004, S, 1)

  it('goes from its take-off to its landing', () => {
    for (const [m, a, b] of [
      [down, [405, 2004], [424, 2028]],
      [up, [424, 2028], [405, 2004]],
    ] as const) {
      expect(m.at(0)).toMatchObject({ x: a[0], y: a[1] })
      expect(m.at(m.dur).x).toBeCloseTo(b[0], 9)
      expect(m.at(m.dur).y).toBeCloseTo(b[1], 9)
    }
  })

  it('never rises above the higher of its two lines', () => {
    for (const p of samples(down)) expect(p.y).toBeGreaterThanOrEqual(2004 - 1e-9)
    for (const p of samples(up)) expect(p.y).toBeGreaterThanOrEqual(2004 - 1e-9)
  })

  it('going down, steps off level and falls under gravity', () => {
    const v = samples(down, 1 / 400)
    expect(Math.abs(v[0]!.vy)).toBeLessThan(0.02 * S) // steps off with no vertical speed
    for (let i = 1; i < v.length - 1; i++) expect((v[i]!.vy - v[i - 1]!.vy) / (v[i]!.s - v[i - 1]!.s)).toBeCloseTo(BALLISTIC_G * S, -1)
    expect(new Set(v.slice(0, -1).map((p) => p.vx.toFixed(6))).size).toBe(1) // steady along: a parabola
  })

  it('going up, leaps so its top is the landing: no vertical speed as it lands', () => {
    const v = samples(up, 1 / 400)
    expect(Math.abs(v.at(-2)!.vy)).toBeLessThan(0.05 * S)
    for (let i = 1; i < v.length - 1; i++) expect((v[i]!.vy - v[i - 1]!.vy) / (v[i]!.s - v[i - 1]!.s)).toBeCloseTo(BALLISTIC_G * S, -1)
  })

  it('is a curve, not a straight line', () => {
    expect(bulge(down)).toBeGreaterThan(2)
    expect(bulge(up)).toBeGreaterThan(2)
  })

  it('faces the way it goes, feet drawn up in flight but down to land', () => {
    expect(down.at(down.dur / 2).facing).toBe(1)
    expect(up.at(up.dur / 2).facing).toBe(-1)
    expect(down.at(down.dur / 2).lift).toBeGreaterThan(0)
    expect(down.at(0).lift).toBe(0)
    expect(down.at(down.dur).lift).toBeCloseTo(0, 9)
  })

  it('keeps a gentle pace: a blurb line takes about 0.4 s, landing under 3 body lengths/s', () => {
    expect(down.dur).toBeCloseTo(Math.sqrt((2 * 24) / (BALLISTIC_G * S)), 9)
    expect(Math.max(...samples(down).map((p) => Math.hypot(p.vx, p.vy))) / S).toBeLessThan(3)
  })

  it('with little or no drop it still takes a while, and never goes faster sideways than NO_RISE_VX', () => {
    // level, nearly level, and a long way along for its drop: the drop alone would make each a flash
    for (const [x1, y1] of [
      [430, 2004],
      [430, 2004.2],
      [405 + 3 * S, 2028],
      [405 - 3 * S, 2004 - 24],
    ] as const) {
      const m = noRiseMotion(405, 2004, x1, y1, S, 1)
      expect(m.dur).toBeGreaterThanOrEqual(NO_RISE_MIN_S)
      const v = samples(m, 1 / 400)
      expect(Math.max(...v.map((p) => Math.abs(p.vx))) / S).toBeLessThanOrEqual(NO_RISE_VX + 1e-6)
      expect(m.at(m.dur).x).toBeCloseTo(x1, 9)
      expect(m.at(m.dur).y).toBeCloseTo(y1, 9)
      for (const p of samples(m)) expect(p.y).toBeGreaterThanOrEqual(Math.min(2004, y1) - 1e-9) // still never rises
      if (y1 === 2004) continue
      // still a parabola: one steady acceleration (gentler than BALLISTIC_G where its pace sets a longer flight)
      const acc = v.slice(1, -1).map((p, i) => (p.vy - v[i]!.vy) / (p.s - v[i]!.s))
      for (const a of acc) expect(a).toBeCloseTo(acc[0]!, 0)
      expect(acc[0]!).toBeGreaterThan(0)
      expect(acc[0]!).toBeLessThanOrEqual(BALLISTIC_G * S + 1e-6)
      if (Math.abs(y1 - 2004) >= 1) expect(bulge(m)).toBeGreaterThan(1)
    }
  })
})
