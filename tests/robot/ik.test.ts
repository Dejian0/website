import { describe, expect, it } from 'vitest'
import { solveKnee } from '../../src/robot/ik.ts'

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)

describe('solveKnee', () => {
  it('reaches foot', () => {
    const k = solveKnee([0, 0], [0, -0.5], 0.32, 0.32, 1)
    expect(k[0]).toBeCloseTo(0.19975, 4)
    expect(k[1]).toBeCloseTo(-0.25, 4)
    expect(Math.abs(dist(k, [0, 0]) - 0.32)).toBeLessThan(1e-9)
    expect(Math.abs(dist(k, [0, -0.5]) - 0.32)).toBeLessThan(1e-9)
  })
  it('bend sign flips knee x', () => {
    expect(solveKnee([0, 0], [0, -0.5], 0.32, 0.32, -1)[0]).toBeLessThan(0)
  })
  it('unreachable clamps', () => {
    const k = solveKnee([0, 0], [0, -1], 0.32, 0.32, 1)
    expect(Math.abs(k[0])).toBeLessThan(1e-9)
    expect(Math.abs(k[1] + 0.32)).toBeLessThan(1e-9)
  })
})
