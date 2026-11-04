import { describe, expect, it } from 'vitest'
import { dip, DIP_MS, MIDPOINT } from '../../src/interaction/still.ts'

/**
 * Runs dips frame by frame, dt ms each, with somewhere new to show the robot until it swaps
 * (or until `dropAt` ms: the move is called off). Opacity after each frame, and when it swapped.
 */
function run(dt: number, ms: number, dropAt = Infinity) {
  let opacity = 1
  let pending = true
  const out: { t: number; opacity: number }[] = []
  let swappedAt: number | null = null
  let swaps = 0
  for (let t = dt; t <= ms + 1e-9; t += dt) {
    if (t > dropAt) pending = false
    const r = dip(opacity, pending, dt)
    opacity = r.opacity
    if (r.swap) {
      swaps++
      swappedAt ??= t
      pending = false
    }
    out.push({ t, opacity })
  }
  return { out, swappedAt, swaps }
}

/** ms until opacity is back at 1 once it has dipped. */
const backAt = (out: { t: number; opacity: number }[]) => out.find((f, i) => f.opacity === 1 && out.slice(0, i).some((g) => g.opacity < 1))?.t

describe('dip', () => {
  it('pins the values: the midpoint, and each fade within the spec (200ms from hero to text, 400ms for a trip)', () => {
    expect(MIDPOINT).toBe(0.5)
    expect(DIP_MS).toBe(80)
    expect(2 * DIP_MS).toBeLessThanOrEqual(200)
  })

  it('fades out where it is, swaps once out of sight, then fades in where it now is', () => {
    const { out, swappedAt, swaps } = run(16, 400)
    expect(swaps).toBe(1)
    expect(swappedAt).toBeGreaterThanOrEqual(DIP_MS)
    expect(swappedAt).toBeLessThan(DIP_MS + 16)
    const before = out.filter((f) => f.t < swappedAt!)
    const after = out.filter((f) => f.t >= swappedAt!)
    // out, monotonically, then in, monotonically, and settled at 1
    for (let i = 1; i < before.length; i++) expect(before[i]!.opacity).toBeLessThan(before[i - 1]!.opacity)
    for (let i = 1; i < after.length; i++) expect(after[i]!.opacity).toBeGreaterThanOrEqual(after[i - 1]!.opacity)
    expect(out.at(-1)!.opacity).toBe(1)
  })

  it('takes 2 × DIP_MS in all, whatever the frame rate', () => {
    for (const dt of [1, 8, 1000 / 60, 1000 / 30, 50]) {
      const t = backAt(run(dt, 600).out)!
      expect(t, `dt ${dt}`).toBeGreaterThanOrEqual(2 * DIP_MS - 1e-6)
      expect(t, `dt ${dt}`).toBeLessThan(2 * DIP_MS + dt)
    }
  })

  it('the time left over after the swap goes into the fade in', () => {
    expect(dip(0.1, true, 16)).toEqual({ opacity: 0.1, swap: true })
    expect(dip(0, true, 0)).toEqual({ opacity: 0, swap: true }) // already out of sight: swap at once
  })

  it('a first frame (dt 0) changes nothing', () => {
    expect(dip(1, true, 0)).toEqual({ opacity: 1, swap: false })
    expect(dip(0.4, false, 0)).toEqual({ opacity: 0.4, swap: false })
  })

  it('with nothing to move it stays shown, and a move called off half-way out fades back in where it is', () => {
    expect(dip(1, false, 16)).toEqual({ opacity: 1, swap: false })
    const { out, swaps } = run(10, 300, 40)
    expect(swaps).toBe(0)
    expect(Math.min(...out.map((f) => f.opacity))).toBeCloseTo(1 - 40 / DIP_MS, 6)
    expect(out.at(-1)!.opacity).toBe(1)
  })
})
