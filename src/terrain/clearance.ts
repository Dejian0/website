// Where the walker may stand, per x: only where every line its body reaches can part around
// it with every word shown and the line's start moved at most a little (spec: it may only stand
// where the space above is painted text "which then parts around it"). Pure.
import type { PaintedLine, PartRoom } from '../text/flow.ts'
import { fitAroundGap } from '../text/split.ts'
import type { Rect, Surface } from './terrain.ts'

// style.css --part-room covers the parting gap (2 x walker reach + 2 x PART_PAD) plus EDGE.
export const PART_PAD = 12 // px of air between the walker and the words a line parts around it
export const EDGE = 8 // px parted words keep from the viewport edges (more than a trailing space)
export const MAX_LEFT_SHIFT = 12 // px a parted line's start may move left
export const BESIDE = 8 // px parted words keep from the text of a line beside theirs (see besideRooms)
export const MIN_SPAN = 8 // px a standable footprint must exceed one body length by (the gait needs room)

export interface Clearance {
  lines: PaintedLine[]
  /** Per painted line: its glyph tops, page px. A line's text band runs from here to its line box bottom. */
  bandTop: number[]
  /** The walker spans ground x ± half and reaches height above the ground (px). */
  half: number
  height: number
  /** Air between the walker and the words around it (px). */
  pad: number
  room: PartRoom
  /** Per painted line, the room it parts in instead of `room` (see besideRooms). */
  rooms?: PartRoom[]
  /** Most a line's start may move left when it parts (px). */
  maxLeftShift: number
}

/** The room line j parts in: its own, else the page's. */
export function roomOf(c: Clearance, j: number): PartRoom {
  return c.rooms?.[j] ?? c.room
}

/**
 * Each line's room: `room`, less the text of the lines beside it (their line boxes overlap its
 * own in y), and `gap` px clear of it, so a line parting never runs into the line next to it,
 * as in a list row of separate pieces of text.
 */
export function besideRooms(lines: PaintedLine[], room: PartRoom, gap: number): PartRoom[] {
  const text = lines.map((l) => (l.words.length ? { x0: l.x + l.words[0]!.x0, x1: l.x + l.words.at(-1)!.x1 } : null))
  return lines.map((l, j) => {
    const own = text[j]
    if (!own) return room
    let { minX, maxX } = room
    lines.forEach((k, i) => {
      const t = text[i]
      if (i === j || !t || !(k.y < l.y + l.lineHeight && l.y < k.y + k.lineHeight)) return
      if (t.x1 <= own.x0) minX = Math.max(minX, t.x1 + gap)
      else if (t.x0 >= own.x1) maxX = Math.min(maxX, t.x0 - gap)
    })
    return minX === room.minX && maxX === room.maxX ? room : { minX, maxX }
  })
}

/** A closed interval of page x. */
export type Interval = [number, number]

const EPS = 0.5 // px: a line the walker stands on touches its feet but is not reached
const INSET = 0.01 // px kept from each interval end against rounding

/** The gap a line parts around when the walker's ground point is at x (page px). */
export function gapAt(c: Clearance, x: number): [number, number] {
  return [x - c.half - c.pad, x + c.half + c.pad]
}

/** Painted lines whose text band reaches into the open interval (top, bottom), page px. */
export function linesIn(c: Clearance, top: number, bottom: number): number[] {
  const out: number[] = []
  c.lines.forEach((l, j) => {
    if (l.y + l.lineHeight > top + EPS && c.bandTop[j]! < bottom - EPS) out.push(j)
  })
  return out
}

/** Whether line j parts around the gap at x with every word shown and its start within the cap. */
export function partsCleanly(c: Clearance, j: number, x: number): boolean {
  return partsCleanlyAround(c, j, gapAt(c, x))
}

/** Whether line j parts around `gap` (page px) with every word shown and its start within the cap. */
export function partsCleanlyAround(c: Clearance, j: number, [gl, gr]: Interval): boolean {
  const l = c.lines[j]!
  const room = roomOf(c, j)
  const f = fitAroundGap(l.words, gl - l.x, gr - l.x, room.minX - l.x, room.maxX - l.x)
  return f.rightStart === f.leftEnd && f.leftShift <= c.maxLeftShift
}

/**
 * Exactly the ground x where partsCleanly(c, j, x) holds. Splitting the line before word k
 * works when the run before it needs at most the allowed left shift A and the run from it at
 * most the room B to the right: x >= x1[k-1] + h - A and x <= x0[k] - h + B, with h the half
 * gap. fitAroundGap shows every word exactly when some split works, and then picks the one
 * with the least left shift, so the union of these intervals is the clear set.
 */
export function clearSet(c: Clearance, j: number): Interval[] {
  const l = c.lines[j]!
  const w = l.words
  const n = w.length
  if (n === 0) return [[-Infinity, Infinity]]
  const h = c.half + c.pad
  const room = roomOf(c, j)
  const A = Math.min(c.maxLeftShift, l.x + w[0]!.x0 - room.minX)
  const B = room.maxX - (l.x + w[n - 1]!.x1)
  const out: Interval[] = []
  for (let k = 0; k <= n; k++) {
    if ((k > 0 && A < 0) || (k < n && B < 0)) continue // that run is out of bounds even unmoved
    const lo = k > 0 ? l.x + w[k - 1]!.x1 + h - A : -Infinity
    const hi = k < n ? l.x + w[k]!.x0 - h + B : Infinity
    if (lo <= hi) out.push([lo, hi])
  }
  return union(out)
}

function union(iv: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const [lo, hi] of [...iv].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1]
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const [p0, p1] of a)
    for (const [q0, q1] of b) {
      const lo = Math.max(p0, q0)
      const hi = Math.min(p1, q1)
      if (lo <= hi) out.push([lo, hi])
    }
  return out
}

/** Where all of `lines` part cleanly, within [lo, hi]. */
function clearWhere(c: Clearance, lines: number[], lo: number, hi: number): Interval[] {
  return lines.reduce((set, j) => intersect(set, clearSet(c, j)), [[lo, hi]] as Interval[])
}

/** `set` less the ground x where the body (±half, plus pad) would reach a `fixed` box in the band (top, bottom). */
function clearOfFixed(c: Clearance, set: Interval[], fixed: Rect[], top: number, bottom: number): Interval[] {
  const reach = c.half + c.pad
  const blocked = union(fixed.filter((r) => r.y1 > top + EPS && r.y0 < bottom - EPS).map((r): Interval => [r.x0 - reach, r.x1 + reach]))
  return blocked.reduce(
    (out, [b0, b1]) => out.flatMap(([a0, a1]): Interval[] => [[a0, Math.min(a1, b0)], [Math.max(a0, b1), a1]].filter(([p, q]) => p! < q!) as Interval[]),
    set,
  )
}

/**
 * Splits each standable surface into the pieces where the walker can stand. A piece's x0..x1
 * is where its body centre may be: ground x where every line its body reaches parts cleanly,
 * its body (with the pad) clear of every `fixed` box reaching into the band above (text that
 * does not part, over a rule the robot walks on), and at least `margin` (the gait's turn margin)
 * inside the surface's ends. So any x a planner or the walker picks on a piece, ends included,
 * is a clear spot. Pieces whose footprint (x1 - x0 + 2 * margin) is narrower than minWidth are
 * dropped. A surface left with no piece keeps one unstandable surface with its own extent, so
 * every painted line has a surface with its flow, line and y. Ids are renumbered in the order given.
 */
export function clearSurfaces(surfaces: Surface[], c: Clearance, margin: number, minWidth: number, fixed: Rect[] = []): Surface[] {
  const out: Surface[] = []
  const push = (s: Surface, x0: number, x1: number, standable: boolean) =>
    out.push({ ...s, id: out.length, x0, x1, standable })
  for (const s of surfaces) {
    const before = out.length
    if (s.standable) {
      const lo = s.x0 + margin
      const hi = s.x1 - margin
      const reached = linesIn(c, s.y - c.height, s.y)
      for (const [a, b] of clearOfFixed(c, clearWhere(c, reached, lo, hi), fixed, s.y - c.height, s.y)) {
        const x0 = a === lo ? a : a + INSET
        const x1 = b === hi ? b : b - INSET
        if (x1 - x0 + 2 * margin >= minWidth) push(s, x0, x1, true)
      }
    }
    if (out.length === before) push(s, s.x0, s.x1, false)
  }
  return out
}

/** A moment of a move: the walker's ground x and its vertical extent (page px). */
export interface PathPoint { x: number; top: number; bottom: number }

/**
 * Whether every line a move passes through parts cleanly all along it: between each pair of
 * successive points, the lines either point reaches (with 1px to spare above) must part
 * cleanly across the x between them.
 */
export function pathClear(c: Clearance, path: PathPoint[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!
    const q = path[i]!
    const lo = Math.min(p.x, q.x)
    const hi = Math.max(p.x, q.x)
    const reached = linesIn(c, Math.min(p.top, q.top) - 1, Math.max(p.bottom, q.bottom))
    const set = clearWhere(c, reached, lo, hi)
    if (!set.some(([a, b]) => a <= lo && b >= hi)) return false
  }
  return true
}
