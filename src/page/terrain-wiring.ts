// The walkable text as terrain: lays the painted flows out, builds the standable surfaces from
// them, keeps the robot's place in the text across a re-layout, and parts the lines it reaches.
import { TURN_MARGIN } from '../robot/gait.ts'
import { hopPath, placeWalker, walkerAt, walkerReach, WALKER_PX, WALKER_PX_NARROW, type Terrain, type Walker } from '../robot/walker.ts'
import { walkInParting } from '../scroll/transition.ts'
import { BESIDE, besideRooms, clearSurfaces, EDGE, gapAt, linesIn, MAX_LEFT_SHIFT, MIN_SPAN, PART_PAD, pathClear, roomOf, type Clearance, type Interval } from '../terrain/clearance.ts'
import { buildSurfaces, nearestPoint, type Rect, type Surface, type TerrainPoint } from '../terrain/terrain.ts'
import { TextFlow, type PaintedLine } from '../text/flow.ts'
import { hairlineOf, type Hairline } from './hairlines.ts'

// Walkable text metrics in whole px (bio after the walker prototype: 32/46, and 21/35 on
// phones as in its pickMetrics()). style.css gives the static text the same values at the
// same breakpoint, so painting starts without a visible change.
const FAMILY = '"Inter Tight"'
const metric = (size: number, lineHeight: number, weight = 400) => ({ font: `${weight} ${size}px ${FAMILY}`, size, lineHeight })
const BIO_WIDE = metric(32, 46)
const BIO_NARROW = metric(21, 35)
const BLURB = metric(16, 24)
// the lists: each Education, Honors and Volunteering row's name (school, or the organization), its detail and
// dates (and an Education row's coursework), and each Skills row
const SCHOOL = metric(16, 20, 600)
const EDU_DETAIL = metric(14, 17)
const SKILL = metric(15, 19)
const narrow = window.matchMedia('(max-width: 640px)')

/** Every font the flows paint with, for TextFlow.ready(). */
export const FLOW_FONTS = [BIO_WIDE.font, BIO_NARROW.font, BLURB.font, SCHOOL.font, EDU_DETAIL.font, SKILL.font]

// Non-painted DOM the robot must not stand under: titles, labels, the hero. (Not a heading: its
// box spans the column, while the robot only has to keep clear of its words, as fixed text.)
const OBSTACLES = '#hero > *, .entry > .title, .entry > .meta, .links > li'
// Non-painted text: the robot keeps clear of it where it stands, and its flight from the hero.
const STATIC_TEXT = '#hero .name, #hero .line, #hero .now, .sec > h2, .entry > .title, .entry > .meta, .links a'

function metrics(source: HTMLElement) {
  const flow = source.dataset.flow ?? ''
  if (flow.startsWith('bio')) return narrow.matches ? BIO_NARROW : BIO_WIDE
  // the Work blurbs, and the notes in Contact and This site, which are set as they are
  if (/^(work|contact|site)-/.test(flow)) return BLURB
  if (flow.startsWith('focus')) return SKILL
  return /-(school|org)$/.test(flow) ? SCHOOL : EDU_DETAIL
}

/** A list row's text: painted over its static copy, which keeps the row's layout (TextFlow's `over`). */
const inList = (source: HTMLElement) => /^(education|honors|volunteering|focus)-/.test(source.dataset.flow ?? '')

/** Where the glyph tops sit below the line box top, after the prototype's surfaceOffset(). */
const glyphTop = (m: { size: number; lineHeight: number }) => 0.5 * (m.lineHeight - m.size) + 0.13 * m.size

/**
 * Glyph boxes of the static text, page px: one per line of each of its text nodes (not the boxes
 * of the elements around them: an Education row's school name grows to fill the row's middle).
 */
function staticTextRects(): Rect[] {
  return [...document.querySelectorAll(STATIC_TEXT)].flatMap((e) => {
    const out: Rect[] = []
    const texts = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      if (!n.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects())
        if (r.width > 0) out.push({ x0: r.left + scrollX, y0: r.top + scrollY, x1: r.right + scrollX, y1: r.bottom + scrollY })
    }
    return out
  })
}

/** A hairline the robot can walk on (page px), as a surface of flow `flow`. */
interface Rule extends Hairline { flow: string }

// The lines under the list headings: floors, where the robot stands beside the heading's words
// (they don't part). Work's is not one: the way into Work from the bio stays a jump past its
// header. The lists' rows are painted, so the robot walks on their words.
const FLOORS = '.sec:not(#work) > h2'

/** The line under each list heading, flow `rule-<section>`, in page order. */
function ruleLines(): Rule[] {
  return [...document.querySelectorAll(FLOORS)].flatMap((h) => {
    const line = hairlineOf(h)
    return line ? [{ flow: `rule-${h.parentElement!.id}`, ...line }] : []
  })
}

/** The page section a surface's flow is in, by its id: `bio`, `work`, `education`, `honors`, `volunteering`, `focus`, `contact`, `site`, or a rule's. */
export function sectionOf(flow: string): string {
  return flow.startsWith('rule-') ? flow.slice('rule-'.length) : flow.split('-')[0]!
}

function obstacleRects(): Rect[] {
  return [...document.querySelectorAll(OBSTACLES)].map((e) => {
    const r = e.getBoundingClientRect()
    return { x0: r.left + scrollX, y0: r.top + scrollY, x1: r.right + scrollX, y1: r.bottom + scrollY }
  })
}

/** Where the robot is in the text, kept across a re-layout: line and fraction along it. */
interface Anchor { flow: string; line: number; t: number; facing: 1 | -1; vdir: 1 | -1 }

export class PageTerrain {
  painted: PaintedLine[] = [] // latest layout, every flow in page order
  surfaces: Surface[] = [] // standable pieces of the painted lines (flow, line) and the rules (flow, line 0), in page order
  terrain: Terrain = { surfaces: [], scale: WALKER_PX }
  /** Since load (debug): hiding a word is a safety net that must never fire. */
  readonly parting = { hidden: 0, maxLeftShift: 0 }

  private flows: TextFlow[] = []
  private flowById = new Map<string, TextFlow>()
  private bandTop: number[] = [] // per painted line: its glyph tops, page px
  private clearance: Clearance | null = null
  private staticText: Rect[] = []
  private rules: Rule[] = []
  private key = ''
  private readonly parted = new Map<number, Interval>() // painted line index -> the gap it parts around (page px)

  constructor(private readonly sources: HTMLElement[]) {}

  /** The TextFlow painting `p[data-flow=id]`. */
  flow(id: string): TextFlow | undefined {
    return this.flowById.get(id)
  }

  /** Whether a column's width or place, or the text metrics, changed since the last rebuild. */
  stale(): boolean {
    return this.currentKey() !== this.key
  }

  /**
   * Boxes of all the text on the page as laid out, page px: each line of the static text, and
   * each painted line from its glyph tops to its line bottom. A parting doesn't change them: the
   * robot parts the lines it reaches wherever it goes, so what it plans around is the text at rest.
   */
  textBoxes(): Rect[] {
    return [...this.staticText, ...this.painted.map((l, i) => ({ x0: l.x, y0: this.bandTop[i]!, x1: l.x + l.width, y1: l.y + l.lineHeight }))]
  }

  /** Glyph boxes of the text that does not part (hero, headings, titles, role and date lines, links), page px. */
  fixedText(): Rect[] {
    return this.staticText
  }

  /** Glyph tops of the bio's first line, page px: where the robot first lands. */
  firstLineTop(): number | null {
    const i = this.painted.findIndex((l) => l.flow === 'bio-0' && l.index === 0)
    return i < 0 ? null : this.bandTop[i]!
  }

  /**
   * Re-lays the text out and rebuilds the terrain: a line's surface is split into the pieces
   * where the lines above can part around the robot (see clearance.ts), each within the room
   * beside it, and clear of the fixed text; each rule's likewise. Returns `w` re-anchored to the
   * same place (or, for null, at the start), or null with nowhere to stand.
   */
  rebuild(w: Walker | null): Walker | null {
    const anchor = w && this.anchorOf(w)
    this.layoutFlows()
    const scale = narrow.matches ? WALKER_PX_NARROW : WALKER_PX
    const reach = walkerReach()
    const tops = new Map(this.sources.map((s) => [s.dataset.flow, glyphTop(metrics(s))]))
    const whole = buildSurfaces(this.painted, obstacleRects(), reach.height * scale, (l) => tops.get(l.flow)!, scale + MIN_SPAN)
    this.bandTop = whole.map((s) => s.y)
    this.staticText = staticTextRects()
    this.rules = ruleLines()
    const rules = this.rules.map((r): Surface => ({ id: -1, flow: r.flow, line: 0, x0: r.x0, x1: r.x1, y: r.y, standable: true }))
    const room = { minX: EDGE, maxX: document.documentElement.clientWidth - EDGE }
    // a line beside another, as an Education row's pieces, parts only up to it
    const rooms = besideRooms(this.painted, room, BESIDE)
    const c: Clearance = { lines: this.painted, bandTop: this.bandTop, half: reach.half * scale, height: reach.height * scale, pad: PART_PAD, room, rooms, maxLeftShift: MAX_LEFT_SHIFT }
    this.clearance = c
    // in page order (a stable sort keeps the lines' own order); no static text may cross the
    // robot where it stands (the hairlines may: they open around it, see hairlines.ts)
    const all = [...whole, ...rules].sort((a, b) => a.y - b.y)
    this.surfaces = clearSurfaces(all, c, TURN_MARGIN * scale, scale + MIN_SPAN, this.staticText)
    const t: Terrain = { surfaces: this.surfaces, scale }
    t.canHop = (h) => pathClear(c, hopPath(h, t))
    this.terrain = t
    this.key = this.currentKey()
    return this.placeAt(anchor)
  }

  /**
   * Whether the robot can move at its height (top to bottom, page px) from x0 to x1 with every
   * line its body reaches parting cleanly all the way, as the walker's own moves must.
   */
  walkClear(x0: number, x1: number, top: number, bottom: number): boolean {
    return pathClear(this.clearance!, [{ x: x0, top, bottom }, { x: x1, top, bottom }])
  }

  /** Closes every parted line. */
  unpart(): void {
    for (const i of this.parted.keys()) this.flowById.get(this.painted[i]!.flow)!.unpart(this.painted[i]!.index)
    this.parted.clear()
  }

  /**
   * Parts every line whose text band (glyph tops to line bottom) the silhouette reaches into,
   * around the robot's full reach at x plus the pad: the same gap clearance.ts checked.
   */
  partAround(sil: Rect, x: number): void {
    const c = this.clearance!
    this.partLines(linesIn(c, sil.y0, sil.y1), gapAt(c, x))
  }

  /**
   * Parts the text as the scroll transition has it at p < 1 (see walkInParting): nothing until
   * the robot walks in from `lane`, then only around it (drawn with silhouette `sil`, ground
   * point at x), and only the lines that part cleanly there.
   */
  partFlying(p: number, lane: number, x: number, sil: Rect): void {
    const { lines, gap } = walkInParting(this.clearance!, p, lane, x, sil)
    this.partLines(lines, gap)
  }

  /** Parts exactly `lines` (painted line indices) around `gap` (page px) and closes every other line. */
  private partLines(lines: number[], gap: Interval): void {
    this.painted.forEach((line, i) => {
      const was = this.parted.get(i)
      const flow = this.flowById.get(line.flow)!
      if (!lines.includes(i)) {
        if (was) {
          flow.unpart(line.index)
          this.parted.delete(i)
        }
        return
      }
      if (was && was[0] === gap[0] && was[1] === gap[1]) return
      const fit = flow.part(line.index, gap[0], gap[1], roomOf(this.clearance!, i))!
      if (fit.rightStart > fit.leftEnd) this.parting.hidden++
      this.parting.maxLeftShift = Math.max(this.parting.maxLeftShift, fit.leftShift)
      this.parted.set(i, gap)
    })
  }

  /**
   * Parts the lines above `at` as for the walker standing there, x held to its surface: its
   * full reach above the surface, exactly the lines clearSurfaces() checked part cleanly there.
   */
  partStanding(at: TerrainPoint): void {
    const s = this.surfaces[at.surface]!
    const c = this.clearance!
    const x = Math.min(s.x1, Math.max(s.x0, at.x))
    this.partAround({ x0: x - c.half, y0: s.y - c.height, x1: x + c.half, y1: s.y }, x)
  }

  /** Lays every flow out for the current viewport, re-preparing those whose metrics changed. */
  private layoutFlows(): void {
    this.flows = this.sources.map((source, i) => {
      const m = metrics(source)
      const flow = this.flows[i]
      if (flow && flow.font === m.font && flow.lineHeight === m.lineHeight) return flow
      flow?.destroy()
      return new TextFlow(source, m.font, m.lineHeight, inList(source))
    })
    this.flowById = new Map(this.flows.map((f) => [f.source.dataset.flow ?? '', f]))
    const widths = this.flows.map((f) => f.column().width)
    this.painted = this.flows.flatMap((flow, i) => flow.layout(widths[i]!))
    this.parted.clear() // layout() clears every parting
  }

  /** What a re-layout depends on: each flow's column width and place, and the text metrics. */
  private currentKey(): string {
    return (
      this.flows.map((f) => `${metrics(f.source).font} ${Object.values(f.column()).join(' ')}`).join('|') +
      `|${document.documentElement.clientWidth}`
    )
  }

  private anchorOf(w: Walker): Anchor {
    const at = walkerAt(w, this.terrain)
    const s = this.surfaces[at.surface]!
    const rule = this.rules.find((r) => r.flow === s.flow)
    const l = rule ? { x: rule.x0, width: rule.x1 - rule.x0 } : this.painted.find((p) => p.flow === s.flow && p.index === s.line)!
    const x = w.kind === 'hop' ? w.hop.to.x : at.x
    return { flow: s.flow, line: s.line, t: (x - l.x) / Math.max(1, l.width), facing: at.facing, vdir: w.vdir }
  }

  /** Snaps to the nearest standable point to the anchor; with none, the left end of the bio's first line. */
  private placeAt(a: Anchor | null): Walker | null {
    const spot = (a && this.spotOf(a)) ?? this.start()
    const p = spot && nearestPoint(this.surfaces, spot.x, spot.y)
    return p ? placeWalker(this.terrain, p, a?.facing ?? 1, a?.vdir ?? 1) : null
  }

  /** Where the anchor is now (page px): along its rule, or its line (else its flow's last line); null if gone. */
  private spotOf(a: Anchor): { x: number; y: number } | null {
    const rule = this.rules.find((r) => r.flow === a.flow)
    if (rule) return { x: rule.x0 + a.t * (rule.x1 - rule.x0), y: rule.y }
    const painted = this.painted
    const ofFlow = painted.flatMap((l, j) => (l.flow === a.flow ? [j] : []))
    const i = ofFlow.find((j) => painted[j]!.index === a.line) ?? ofFlow.at(-1)
    return i === undefined ? null : { x: painted[i]!.x + a.t * painted[i]!.width, y: this.bandTop[i]! }
  }

  /** The left end of the bio's first line (page px), where the robot starts. */
  private start(): { x: number; y: number } | null {
    const i = this.painted.findIndex((l) => l.flow === 'bio-0' && l.index === 0)
    return i < 0 ? null : { x: this.painted[i]!.x, y: this.bandTop[i]! }
  }
}
