// Box-built quadruped. Units are body lengths; x forward, y up, z toward the viewer (near side z > 0).
export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
/** leg = part of a leg; far = of a far-side leg (z < 0) */
export interface Face { pts: [Vec3, Vec3, Vec3, Vec3]; far: boolean; leg?: boolean }
/** Side-plane coordinates, body frame. */
export interface LegPose { hip: Vec2; knee: Vec2; foot: Vec2 }
/** Order: FL (near), FR (far), HL (near), HR (far). */
export interface RobotPose { legs: [LegPose, LegPose, LegPose, LegPose]; bodyPitch: number }

const HIP_X = 0.36
const HIP_Y = -0.08
const LEG_Z = 0.25
const FOOT_Y = -0.62
const FOOT_H = 0.04
const FOOT_DROP = 0.01 // foot box centre sits this far below the foot point
const KNEE_DX = 0.13
const FOOT_DX = 0.02
const KNEE_Y = (HIP_Y + FOOT_Y) / 2

export const MODEL = {
  bodyLen: 1 as const,
  thigh: Math.hypot(KNEE_DX, KNEE_Y - HIP_Y),
  shank: Math.hypot(KNEE_DX + FOOT_DX, FOOT_Y - KNEE_Y),
  hipX: HIP_X,
  hipY: HIP_Y,
  legZ: LEG_Z,
  groundY: FOOT_Y - FOOT_DROP - FOOT_H / 2,
}

// vertex index = (dx>0)*4 + (dy>0)*2 + (dz>0); wound so visible faces have negative screen cross product
const BOX_FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]

/** Six faces of an axis-aligned box. */
export function boxFaces(center: Vec3, size: Vec3, far = false): Face[] {
  const [cx, cy, cz] = center
  const v: Vec3[] = []
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1])
    v.push([cx + (dx * size[0]) / 2, cy + (dy * size[1]) / 2, cz + (dz * size[2]) / 2])
  return BOX_FACES.map((f) => ({ pts: f.map((i) => v[i]) as Face['pts'], far }))
}

/** A square-section box spanning side-plane segment a -> b at depth z, thickness t. */
function linkFaces(a: Vec2, b: Vec2, z: number, t: number, far: boolean): Face[] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  const c = Math.cos(ang), s = Math.sin(ang)
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
  return boxFaces([0, 0, 0], [Math.hypot(b[0] - a[0], b[1] - a[1]) + t * 0.6, t, t], far).map((f) => ({
    far,
    pts: f.pts.map(([x, y, zz]): Vec3 => [mx + x * c - y * s, my + x * s + y * c, z + zz]) as Face['pts'],
  }))
}

export function standingPose(): RobotPose {
  const leg = (front: number): LegPose => ({
    hip: [front * HIP_X, HIP_Y],
    knee: [front * HIP_X - front * KNEE_DX, KNEE_Y], // X configuration: knees point inward
    foot: [front * HIP_X + front * FOOT_DX, FOOT_Y],
  })
  return { legs: [leg(1), leg(1), leg(-1), leg(-1)], bodyPitch: 0 }
}

export function robotFaces(pose: RobotPose): Face[] {
  const cp = Math.cos(pose.bodyPitch), sp = Math.sin(pose.bodyPitch)
  const body = [
    ...boxFaces([0, 0, 0], [1.0, 0.2, 0.4]),
    ...boxFaces([0.06, 0.13, 0], [0.5, 0.06, 0.26]), // top cover
    ...boxFaces([0.56, 0.0, 0], [0.12, 0.15, 0.3]), // front sensor head
    ...boxFaces([-0.54, 0.02, 0], [0.08, 0.12, 0.26]), // rear bumper
  ].map((f) => ({
    far: false,
    pts: f.pts.map(([x, y, z]): Vec3 => [x * cp - y * sp, x * sp + y * cp, z]) as Face['pts'],
  }))
  const faces: Face[] = body
  pose.legs.forEach((l, i) => {
    const far = i % 2 === 1
    const z = far ? -LEG_Z : LEG_Z
    const parts = [
      ...boxFaces([l.hip[0], l.hip[1] + 0.02, z], [0.13, 0.13, 0.07], far), // hip actuator
      ...linkFaces(l.hip, l.knee, z, 0.075, far), // thigh
      ...boxFaces([l.knee[0], l.knee[1], z], [0.09, 0.09, 0.06], far), // knee actuator
      ...linkFaces(l.knee, l.foot, z, 0.05, far), // shank
      ...boxFaces([l.foot[0], l.foot[1] - FOOT_DROP, z], [0.06, FOOT_H, 0.06], far), // foot
    ]
    for (const f of parts) faces.push({ ...f, leg: true })
  })
  return faces
}
