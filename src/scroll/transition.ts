// The scroll-scrubbed transition from the still hero to the walker. Pure: one progress value
// p in [0, 1] picks the camera, size, place and pose, so scrolling back runs it backwards.
import { solveKnee } from '../robot/ik.ts'
import { MODEL, type LegPose, type RobotPose, type Vec2 } from '../robot/model.ts'
import { linesIn, PART_PAD, partsCleanlyAround, type Clearance, type Interval } from '../terrain/clearance.ts'
import type { Rect } from '../terrain/terrain.ts'
import type { PaintedLine } from '../text/flow.ts'

/**
 * A camera (yaw, pitch, scale px per body length) and where its ground point sits: x, y are page
 * px. shade: how shaded the robot is drawn, with its ground shadow (render.ts fillColor), 0 to 1.
 */
export interface View { yaw: number; pitch: number; scale: number; x: number; y: number; stroke: number; shade: number }

/**
 * p's stages, so the robot never flies through text. The camera (turn, size, stroke, pose) leads
 * and is done when `turn` ends, while the robot moves out sideways at the hero's height to a lane
 * beside the text. Then it drops down the lane at walker size and last walks in along its line.
 */
export const STAGES = { turn: [0, 0.4], drop: [0.4, 0.75], enter: [0.75, 1] } as const

// smootherstep: zero speed and acceleration at both ends, so the stages join without a jolt and
// the last scrolled px before p = 1 moves the robot by a few thousandths of a px at most
const ease = (t: number) => t * t * t * (t * (6 * t - 15) + 10)
const stage = ([a, b]: readonly [number, number], p: number) => ease(Math.min(1, Math.max(0, (p - a) / (b - a))))
/** a → b by s, exactly a at s = 0 and exactly b at s = 1. */
const mix = (a: number, b: number, s: number) => (s <= 0 ? a : s >= 1 ? b : a + (b - a) * s)

/** How far scrollY is through [start, end], clamped to [0, 1]; an empty range is a step at its end. */
export function progress(scrollY: number, start: number, end: number): number {
  if (!(end > start)) return scrollY >= end ? 1 : 0
  return Math.min(1, Math.max(0, (scrollY - start) / (end - start)))
}

/**
 * The scroll px over which p runs from 0 to 1: until the landing line (page y `landY`) is
 * `landAt` of the way down the viewport, but at least `minFraction` of a viewport (a tall screen
 * already shows the bio at the top) and at most the page's scroll. 0 when the page can't
 * scroll: p is then 1 at once, and the robot walks.
 */
export function scrollSpan(landY: number, viewportH: number, maxScroll: number, landAt = 0.55, minFraction = 0.3): number {
  if (!(maxScroll > 0)) return 0
  return Math.min(maxScroll, Math.max(minFraction * viewportH, landY - landAt * viewportH))
}

/**
 * The view at p: exactly `hero` at p ≤ 0 and exactly `walker` at p ≥ 1. The camera turns and
 * shrinks the robot (geometrically, at an even rate) and its shading fades during `turn`, as it moves sideways to
 * `lane` (body-centre page x; by default the walker's own x, so it drops straight onto it).
 * It drops to the walker's height during `drop`, and moves in to the walker's x during `enter`.
 */
export function lerpView(hero: View, walker: View, p: number, lane = walker.x): View {
  if (p <= 0) return { ...hero }
  if (p >= 1) return { ...walker }
  const c = stage(STAGES.turn, p)
  const enter = stage(STAGES.enter, p)
  return {
    yaw: mix(hero.yaw, walker.yaw, c),
    pitch: mix(hero.pitch, walker.pitch, c),
    scale: c >= 1 ? walker.scale : hero.scale * (walker.scale / hero.scale) ** c,
    x: enter > 0 ? mix(lane, walker.x, enter) : mix(hero.x, lane, c),
    y: mix(hero.y, walker.y, stage(STAGES.drop, p)),
    stroke: mix(hero.stroke, walker.stroke, c),
    shade: mix(hero.shade, walker.shade, c),
  }
}

/**
 * The pose at p, through the camera's stage: exactly `a` at p ≤ 0 and `b` once the camera has
 * turned. Each foot moves straight from a to b and its knee is solved again, bending the way
 * the gait bends it (front knees back, hind knees forward), so the links keep their length.
 */
export function lerpPose(a: RobotPose, b: RobotPose, p: number): RobotPose {
  const s = stage(STAGES.turn, p)
  if (s <= 0) return a
  if (s >= 1) return b
  const m = (u: Vec2, v: Vec2): Vec2 => [mix(u[0], v[0], s), mix(u[1], v[1], s)]
  const legs = a.legs.map((l, i): LegPose => {
    const hip = m(l.hip, b.legs[i]!.hip)
    const foot = m(l.foot, b.legs[i]!.foot)
    return { hip, knee: solveKnee(hip, foot, MODEL.thigh, MODEL.shank, i < 2 ? -1 : 1), foot }
  })
  return { legs: legs as RobotPose['legs'], bodyPitch: mix(a.bodyPitch, b.bodyPitch, s) }
}

/**
 * The walker's yaw. Facing right it is side-on (0). Facing left the walker is drawn mirrored
 * (mirrorX), which a camera can't reach from the hero; turned round to −π, seeing the
 * side-swapped pose, it draws the same picture. So the hero turns towards the viewer and on
 * round to face left.
 */
export const turnYaw = (facing: 1 | -1) => (facing === 1 ? 0 : -Math.PI)

/** The pose with its near and far legs trading places (FL with FR, HL with HR). */
export function sideSwapped(pose: RobotPose): RobotPose {
  const [fl, fr, hl, hr] = pose.legs
  return { legs: [fr, fl, hr, hl], bodyPitch: pose.bodyPitch }
}

export interface LaneQuery {
  text: Rect[] // glyph boxes of all the text, as laid out (never as parted), page px
  fixed: Rect[] // those of them that never part (static text)
  top: number // the drop's top: the hero's ground y
  bottom: number // the drop's bottom: the walker's ground y
  half: number // the walker's reach to either side of its body centre, px
  height: number // the walker's height above its ground point, px
  room: { minX: number; maxX: number } // page x the robot's body may use
  landing: number // the walker's body-centre x
  /**
   * Whether walking in at the walker's height from body-centre x `lane` to the landing, every
   * painted line the robot reaches parts cleanly around it all the way (PageTerrain.walkClear).
   */
  walkIn: (lane: number) => boolean
}

// px between the robot and the text beside its lane: more than the pad a line parts with, so
// a walk-in that parts the text around the robot starts with nothing moving (where the room
// clamps a lane closer, walkInParting starts its pad smaller)
export const LANE_GAP = PART_PAD + 1

/** px² of `a` inside `b`. */
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))

/**
 * The body-centre x of the lane the robot drops down at walker size: just clear of the text it
 * passes on the left or on the right, kept inside `room`. A side is clean when its drop passes no
 * text and its walk-in meets no fixed text and parts every line it reaches cleanly (`walkIn`):
 * then the flight never crosses text. A clean side wins; else the side that crosses least, its
 * drop plus the text its walk-in can't part around (where neither side has room, as on phones
 * and tablets); on a tie, the side nearer the landing. With no text beside the drop at all, the
 * landing x itself. `clear`: the side is clean.
 */
export function planLane(q: LaneQuery): { x: number; clear: boolean } {
  const y0 = q.top - q.height
  const beside = q.text.filter((r) => r.y1 > y0 && r.y0 < q.bottom && r.x1 > r.x0)
  if (beside.length === 0) return { x: q.landing, clear: true }
  const fit = (x: number) => Math.min(q.room.maxX - q.half, Math.max(q.room.minX + q.half, x))
  const covered = (a: Rect, rs: Rect[]) => rs.reduce((s, r) => s + overlap(a, r), 0)
  const side = (x: number) => {
    const drop = covered({ x0: x - q.half, y0, x1: x + q.half, y1: q.bottom }, beside)
    const enter: Rect = { x0: Math.min(x, q.landing) - q.half, y0: q.bottom - q.height, x1: Math.max(x, q.landing) + q.half, y1: q.bottom }
    const parts = covered(enter, q.fixed) === 0 && q.walkIn(x)
    return { x, clear: drop === 0 && parts, cost: drop + (parts ? 0 : covered(enter, beside)) }
  }
  const a = side(fit(Math.min(...beside.map((r) => r.x0)) - LANE_GAP - q.half))
  const b = side(fit(Math.max(...beside.map((r) => r.x1)) + LANE_GAP + q.half))
  const nearer = Math.abs(a.x - q.landing) <= Math.abs(b.x - q.landing)
  const best = a.clear !== b.clear ? (a.clear ? a : b) : Math.abs(a.cost - b.cost) > 1e-6 ? (a.cost < b.cost ? a : b) : nearer ? a : b
  return { x: best.x, clear: best.clear }
}

/**
 * How the text parts while the robot flies in, at p < 1 (on the way from the hero, through
 * `lane`): the painted lines to part (indices into c.lines) and the gap they part around, page
 * px. Before the walk-in nothing parts: a gap waiting where it will land would be away from it.
 * Walking in, it is the walker's drawing at its height, `sil` with its ground point at x (page
 * px), and each line it reaches parts around it where that line parts cleanly there, every word
 * shown and its start moved at most c.maxLeftShift; elsewhere a line stays as laid out and the
 * robot passes over its words, which show through it. The gap's pad grows over the walk-in, from
 * the room the robot has beside those lines at the lane (at most c.pad) to c.pad, so nothing
 * moves the moment it starts and at p = 1 it is the walker's own gap.
 */
export function walkInParting(c: Clearance, p: number, lane: number, x: number, sil: Rect): { lines: number[]; gap: Interval } {
  if (p < STAGES.enter[0]) return { lines: [], gap: [x, x] }
  const reached = linesIn(c, sil.y0, sil.y1)
  const start = Math.max(0, Math.min(c.pad, ...reached.map((j) => roomBeside(c.lines[j]!, lane, c.half))))
  const pad = mix(start, c.pad, stage(STAGES.enter, p))
  const gap: Interval = [x - c.half - pad, x + c.half + pad]
  return { lines: reached.filter((j) => partsCleanlyAround(c, j, gap)), gap }
}

/** px between the reach x ± half and the nearest word of `l` (negative inside them; Infinity with none). */
function roomBeside(l: PaintedLine, x: number, half: number): number {
  const first = l.words[0]
  const last = l.words.at(-1)
  if (!first || !last) return Infinity
  return Math.max(l.x + first.x0 - (x + half), x - half - (l.x + last.x1))
}
