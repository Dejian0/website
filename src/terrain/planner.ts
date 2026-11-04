import { nearestPoint, type Surface, type TerrainPoint } from './terrain.ts'

export type Move =
  | { kind: 'walk'; surface: number; toX: number }
  | { kind: 'step' | 'leap' | 'jump'; from: TerrainPoint; to: TerrainPoint }
/**
 * px. stride (optional): a step or jump between overlapping surfaces lands this far along the
 * way the robot is going (or the other way at the end of the landing surface), so it moves as
 * it hops rather than straight up or down.
 */
export interface Limits { maxStep: number; maxLeap: number; maxJump: number; stride?: number }
/** Where a route starts, and optionally the way the robot faces there (for the first stride; right if not given). */
export type Start = TerrainPoint & { facing?: 1 | -1 }
/**
 * Which hops a route may use, for instance only those the text can part around all along their
 * arc, and at what price: false vetoes a hop; true allows it; a number allows it at that much
 * extra cost (px), so a route takes it only when no cheaper way exists. Without a filter, every
 * hop the limits allow is fine.
 */
export type HopFilter = (kind: 'step' | 'leap' | 'jump', from: TerrainPoint, to: TerrainPoint) => boolean | number

interface Hop { kind: 'step' | 'leap' | 'jump'; fromX: number; toX: number; extra: number }
type Dir = 1 | -1

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const TRY_STEP = 8 // px between the spots along an overlap tried for a step or jump the filter vetoed

/** x, then every TRY_STEP further out along [lo, hi] on both sides, then lo and hi. */
function* spots(x: number, lo: number, hi: number): Generator<number> {
  yield x
  for (let d = TRY_STEP; x - d > lo || x + d < hi; d += TRY_STEP) {
    if (x - d > lo) yield x - d
    if (x + d < hi) yield x + d
  }
  if (lo < x) yield lo
  if (hi > x) yield hi
}

/**
 * The hop (if any) from surface a, standing at curX, to surface b, on the way to page x `goal`.
 * Priority: step, leap, jump. Pieces of one line are separate because the robot can't stand
 * between them: no hop joins them. A step or jump between overlapping surfaces goes up or down
 * from curX (landing a stride along the way it goes: curDir, or the way it walked to the spot);
 * if `allow` vetoes or prices that, from the nearest spot along the overlap it allows free,
 * unless a priced one nearer costs less; else from the priced one that costs least. A priced
 * hop's cost is its price plus the walk there and from where it lands on toward the goal, so a
 * spot out of the way pays for the walk back too; it may also turn round to land a stride the
 * other way (a hop behind text that does not part, aiming at a gap).
 */
function hop(a: Surface, b: Surface, curX: number, curDir: Dir, lim: Limits, goal: number, allow?: HopFilter): Hop | null {
  if (a.id === b.id || !b.standable || (a.flow === b.flow && a.line === b.line)) return null
  /** The hop as `allow` prices it, or null if it vetoes it. */
  const priced = (kind: Hop['kind'], fromX: number, toX: number): Hop | null => {
    const v = allow ? allow(kind, { surface: a.id, x: fromX }, { surface: b.id, x: toX }) : true
    return v === false ? null : { kind, fromX, toX, extra: v === true ? 0 : v }
  }
  const dy = Math.abs(a.y - b.y)
  const lo = Math.max(a.x0, b.x0)
  const hi = Math.min(a.x1, b.x1)
  if (lo <= hi) {
    const kind = dy <= lim.maxStep ? 'step' : a.flow !== b.flow && dy <= lim.maxJump ? 'jump' : null
    if (!kind) return null
    const stride = lim.stride ?? 0
    let best: Hop | null = null
    const total = (h: Hop) => h.extra + Math.abs(h.fromX - curX) + Math.abs(h.toX - h.fromX) + Math.abs(h.toX - goal)
    const consider = (h: Hop | null) => {
      if (h && (!best || total(h) < total(best))) best = h
    }
    /** The nearest free hop, unless a priced one nearer costs less. */
    const free = (h: Hop) => (best && total(best) < total(h) ? best : h)
    for (const x of spots(clamp(curX, lo, hi), lo, hi)) {
      // no hop from x costs less than the walk there and on to the goal
      if (best && Math.abs(x - curX) + Math.abs(x - goal) >= total(best)) continue
      const dir: Dir = x === curX ? curDir : x > curX ? 1 : -1
      const h = priced(kind, x, along(x, dir, b, stride))
      if (h && h.extra <= 0) return free(h)
      consider(h)
      if (h && stride > 0) {
        const back = priced(kind, x, along(x, -dir as Dir, b, stride))
        if (back && back.extra <= 0) return free(back)
        consider(back)
      }
      if (!allow) break
    }
    return best
  }
  if (a.flow === b.flow && dy <= lim.maxStep) {
    // Wrap to the next line (end -> start) or back again (start -> end).
    const ends = b.line === a.line + 1 ? [a.x1, b.x0] : b.line === a.line - 1 ? [a.x0, b.x1] : null
    if (ends && Math.abs(ends[1]! - ends[0]!) <= lim.maxLeap) return priced('leap', ends[0]!, ends[1]!)
  }
  if (a.flow !== b.flow && dy <= lim.maxJump) {
    const fromX = b.x0 > a.x1 ? a.x1 : a.x0
    const toX = b.x0 > a.x1 ? b.x0 : b.x1
    if (Math.abs(toX - fromX) <= lim.maxLeap) return priced('jump', fromX, toX)
  }
  return null
}

/**
 * x moved up to `stride` along `dir`, staying on b: the other way if b leaves less than half a
 * stride ahead and more behind.
 */
function along(x: number, dir: Dir, b: Surface, stride: number): number {
  if (!(stride > 0)) return x
  const ahead = dir > 0 ? b.x1 - x : x - b.x0
  const behind = dir > 0 ? x - b.x0 : b.x1 - x
  const way = ahead >= stride / 2 || ahead >= behind ? dir : -dir
  const room = way === dir ? ahead : behind
  return room >= 1 ? x + way * Math.min(stride, room) : x
}

interface Search { cost: number[]; arrX: number[]; arrDir: Dir[]; prev: number[]; via: (Hop | null)[] }

// Walking toward the goal now or later costs the same, but later the hops' strides carry the
// robot along for free: walking costs this much more per px, so of two routes otherwise as good
// the one that walks later wins (else it walks to the goal's x at once and then strides past it).
const WALK_LATER = 0.01

/**
 * Dijkstra over surfaces; ties break on the lowest surface id, so results are stable. Costs are
 * px: walking (a hair over 1 per px: WALK_LATER), each hop's length and twice its rise or drop,
 * and the filter's price, plus how much nearer (or further from) page x `goal` each hop leaves
 * the robot. That last term telescopes along a route, so on the goal's surface the cost is the
 * whole route's including the walk on to the goal, and it keeps every edge's cost non-negative
 * (each hop's walk and length cover it).
 */
function search(s: Surface[], from: Start, lim: Limits, goal: number, allow?: HopFilter): Search {
  const n = s.length
  const r: Search = {
    cost: Array<number>(n).fill(Infinity),
    arrX: Array<number>(n).fill(0),
    arrDir: Array<Dir>(n).fill(1),
    prev: Array<number>(n).fill(-1),
    via: Array<Hop | null>(n).fill(null),
  }
  if (!s[from.surface]?.standable) return r
  const done = Array<boolean>(n).fill(false)
  r.cost[from.surface] = 0
  r.arrX[from.surface] = from.x
  r.arrDir[from.surface] = from.facing ?? 1
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && r.cost[i] < Infinity && (u < 0 || r.cost[i] < r.cost[u])) u = i
    if (u < 0) return r
    done[u] = true
    for (let v = 0; v < n; v++) {
      if (done[v]) continue
      const h = hop(s[u], s[v], r.arrX[u], r.arrDir[u], lim, goal, allow)
      if (!h) continue
      const toward = Math.abs(h.toX - goal) - Math.abs(r.arrX[u] - goal)
      const walk = (1 + WALK_LATER) * Math.abs(h.fromX - r.arrX[u])
      const c = r.cost[u] + walk + Math.abs(h.toX - h.fromX) + 2 * Math.abs(s[u].y - s[v].y) + h.extra + toward
      if (c < r.cost[v]) {
        r.cost[v] = c
        r.arrX[v] = h.toX
        r.arrDir[v] = (Math.sign(h.toX - h.fromX) || (h.fromX === r.arrX[u] ? r.arrDir[u] : Math.sign(h.fromX - r.arrX[u]))) as Dir
        r.prev[v] = u
        r.via[v] = h
      }
    }
  }
}

function route(s: Surface[], r: Search, from: TerrainPoint, to: TerrainPoint): Move[] {
  const chain: number[] = []
  for (let v = to.surface; v >= 0; v = r.prev[v]) chain.unshift(v)
  const moves: Move[] = []
  let x = from.x
  for (let i = 1; i < chain.length; i++) {
    const h = r.via[chain[i]]!
    if (h.fromX !== x) moves.push({ kind: 'walk', surface: chain[i - 1], toX: h.fromX })
    moves.push({ kind: h.kind, from: { surface: chain[i - 1], x: h.fromX }, to: { surface: chain[i], x: h.toX } })
    x = h.toX
  }
  if (x !== to.x) moves.push({ kind: 'walk', surface: to.surface, toX: to.x })
  return moves
}

/**
 * Route between two points on standable surfaces. Returns null when `from` is unstandable or
 * out of range, when `to` is unstandable or out of range, or when no route exists. An empty
 * array means `to` is already the current position. `allow` filters the hops it may use.
 */
export function planPath(s: Surface[], from: Start, to: TerrainPoint, lim: Limits, allow?: HopFilter): Move[] | null {
  if (!s[to.surface]?.standable) return null
  const r = search(s, from, lim, to.x, allow)
  if (r.cost[to.surface] === Infinity) return null
  return route(s, r, from, to)
}

/**
 * Walk as close to (x, y) as the reachable surfaces allow. Returns null when `from` is
 * unstandable or out of range, or when nothing is reachable. `moves: []` means the chosen
 * target equals the current position. `allow` filters the hops it may use.
 */
export function nearestReachable(
  s: Surface[],
  from: Start,
  x: number,
  y: number,
  lim: Limits,
  allow?: HopFilter,
): { to: TerrainPoint; moves: Move[] } | null {
  const r = search(s, from, lim, x, allow)
  const to = nearestPoint(
    s.filter((f) => r.cost[f.id] < Infinity),
    x,
    y,
  )
  return to ? { to, moves: route(s, r, from, to) } : null
}
