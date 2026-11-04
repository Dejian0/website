import type { Vec2 } from './model.ts'

/**
 * Knee position of a two-link leg. `bend` picks the side of the hip->foot line
 * (+1 = knee on the left of the hip->foot direction; for a downward leg, +x).
 * An unreachable foot gives a straight leg pointing at the foot.
 */
export function solveKnee(hip: Vec2, foot: Vec2, thigh: number, shank: number, bend: 1 | -1): Vec2 {
  const dx = foot[0] - hip[0]
  const dy = foot[1] - hip[1]
  const d = Math.min(Math.hypot(dx, dy), thigh + shank)
  if (d < 1e-9) return [hip[0], hip[1] - thigh]
  const ux = dx / Math.hypot(dx, dy)
  const uy = dy / Math.hypot(dx, dy)
  const a = (thigh * thigh - shank * shank + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a))
  return [hip[0] + a * ux - bend * h * uy, hip[1] + a * uy + bend * h * ux]
}
