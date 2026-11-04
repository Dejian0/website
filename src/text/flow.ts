import {
  layoutWithLines,
  materializeLineRange,
  prepareWithSegments,
  type LayoutLine,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'
import { fitAroundGap, type Fit, type WordBox } from './split.ts'

/** One painted line. x, y are page px (top-left of the line box); words are line-local. */
export interface PaintedLine {
  flow: string
  index: number
  x: number
  y: number
  width: number
  lineHeight: number
  words: WordBox[]
}

interface Line {
  painted: PaintedLine
  top: number // layer-local y
  spans: HTMLSpanElement[] // one per word, same order as painted.words
  fit: Fit // current parting; whole(n) when unparted
}

/** Room a parted line may use, in page px: shown words stay inside [minX, maxX]. */
export interface PartRoom { minX: number; maxX: number }

const whole = (n: number): Fit => ({ leftEnd: n, rightStart: n, leftShift: 0, shift: 0 })

/** A word's x offset under `fit`, or null when hidden. */
function offset(fit: Fit, i: number): number | null {
  if (i < fit.leftEnd) return -fit.leftShift
  return i >= fit.rightStart ? fit.shift : null
}

// px an overlaid text is laid out wider than its box: a box that shrinks to fit its text is
// exactly as wide as the browser measures it, and Pretext's measure may come out a hair wider
const OVER_SLACK = 1

/**
 * Paints one static paragraph line by line with Pretext, one pooled span per
 * word, so a line can part around an obstacle without splitting a word.
 * The painted layer takes the paragraph's place in normal flow, with the
 * height Pretext computes; the paragraph itself stays in the DOM as `.sr-only`
 * for screen readers. CSS must give the static paragraph the same font, line
 * height, box margins and side padding as its `.flow-paint` layer.
 *
 * `over`: the layer lies over the source instead, which keeps its place in the
 * layout unseen (`.flow-under`), as a list row's pieces of text in a flex row
 * do. Its parent must be positioned, and CSS must give the layer the source's
 * colour (a sibling's, it doesn't inherit it).
 */
export class TextFlow {
  readonly source: HTMLElement
  readonly font: string
  readonly lineHeight: number
  readonly over: boolean
  private readonly prepared: PreparedTextWithSegments
  private readonly layer: HTMLDivElement
  private readonly pool: HTMLSpanElement[] = []
  private lines: Line[] = []
  private ctx: CanvasRenderingContext2D | null = null

  /** `font` must be loaded first (see `ready`): Pretext measures it once, here. */
  constructor(source: HTMLElement, font: string, lineHeight: number, over = false) {
    this.source = source
    this.font = font
    this.lineHeight = lineHeight
    this.over = over
    this.prepared = prepareWithSegments(source.textContent ?? '', font)
    this.layer = document.createElement('div')
    this.layer.className = 'flow-paint'
    this.layer.setAttribute('aria-hidden', 'true')
    this.layer.style.font = font
    this.layer.style.lineHeight = `${lineHeight}px`
  }

  /**
   * Loads every font (for `text`, since faces are split by unicode-range).
   * Resolves false if any fails or the timeout wins: then keep the static text.
   */
  static async ready(fonts: string[], timeoutMs: number, text?: string): Promise<boolean> {
    let timer = 0
    const timeout = new Promise<false>((resolve) => {
      timer = window.setTimeout(() => resolve(false), timeoutMs)
    })
    // a blocked font rejects in Chrome and Safari; check status too, since fonts.check() can't be trusted
    const loaded = Promise.all(fonts.map((f) => document.fonts.load(f, text))).then(
      (sets) => sets.every((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded')),
      () => false,
    )
    const ok = await Promise.race([loaded, timeout])
    clearTimeout(timer)
    return ok
  }

  /**
   * The content box the text wraps in, page px: the paragraph's while it is static, its
   * painted layer's once painted (CSS gives both the same box, padding included). Laid over
   * its source, always the source's.
   */
  column(): { x: number; y: number; width: number } {
    const el = this.layer.isConnected && !this.over ? this.layer : this.source
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const left = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)
    const right = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)
    return { x: box.left + scrollX + left, y: box.top + scrollY, width: box.width - left - right }
  }

  /** Lays the paragraph out at `columnWidth`, paints it and returns its lines. Clears any parting. */
  layout(columnWidth: number): PaintedLine[] {
    const { lines } = layoutWithLines(this.prepared, this.over ? columnWidth + OVER_SLACK : columnWidth, this.lineHeight)
    if (!this.layer.isConnected) this.source.after(this.layer)
    this.source.classList.add(this.over ? 'flow-under' : 'sr-only')
    this.layer.style.height = `${lines.length * this.lineHeight}px`
    if (this.over) this.lieOver()
    const box = this.layer.getBoundingClientRect()
    const x = box.left + window.scrollX
    const y = box.top + window.scrollY

    let used = 0
    this.lines = lines.map((line, index) => {
      const top = index * this.lineHeight
      const runs = this.words(line)
      const spans = runs.map((run) => {
        const span = this.span(used++)
        if (span.textContent !== run.text) span.textContent = run.text
        place(span, run.x0, top)
        return span
      })
      const words = runs.map(({ x0, x1 }) => ({ x0, x1 }))
      const painted = { flow: this.source.dataset.flow ?? '', index, x, y: y + top, width: line.width, lineHeight: this.lineHeight, words }
      return { painted, top, spans, fit: whole(words.length) }
    })
    for (let i = used; i < this.pool.length; i++) this.pool[i]!.hidden = true
    return this.lines.map((l) => l.painted)
  }

  /**
   * Parts `line` around [gapLeft, gapRight] (page px), moving words whole, and returns how.
   * Without `room`, words that reach into the gap move right. With it, shown words stay
   * inside [room.minX, room.maxX]: see fitAroundGap for how the line then uses both sides,
   * and hides the word behind the gap when neither side has room.
   */
  part(line: number, gapLeft: number, gapRight: number, room?: PartRoom): Fit | null {
    const l = this.lines[line]
    if (!l) return null
    const x = l.painted.x
    const minX = (room?.minX ?? -Infinity) - x
    const maxX = (room?.maxX ?? Infinity) - x
    const fit = fitAroundGap(l.painted.words, gapLeft - x, gapRight - x, minX, maxX)
    this.apply(l, fit)
    return fit
  }

  unpart(line: number): void {
    const l = this.lines[line]
    if (l) this.apply(l, whole(l.spans.length))
  }

  /** Removes the painted layer and shows the static paragraph again. */
  destroy(): void {
    this.layer.remove()
    this.source.classList.remove('sr-only', 'flow-under')
    this.lines = []
  }

  /** Lays the layer exactly over the source's box, in the positioned parent they share. */
  private lieOver(): void {
    const s = this.layer.style
    s.position = 'absolute'
    const parent = this.layer.offsetParent ?? document.documentElement
    const p = parent.getBoundingClientRect()
    const box = this.source.getBoundingClientRect()
    s.left = `${box.left - p.left - parent.clientLeft}px`
    s.top = `${box.top - p.top - parent.clientTop}px`
    s.width = `${box.width}px`
  }

  /** Moves (or hides) only the words whose place changes. */
  private apply(l: Line, fit: Fit): void {
    for (let i = 0; i < l.spans.length; i++) {
      const was = offset(l.fit, i)
      const now = offset(fit, i)
      if (was === now) continue
      const span = l.spans[i]!
      if (now === null) {
        span.style.visibility = 'hidden'
        continue
      }
      if (was === null) span.style.visibility = ''
      place(span, l.painted.words[i]!.x0 + now, l.top)
    }
    l.fit = fit
  }

  /**
   * Word runs of one line, positioned by summing Pretext's segment widths.
   * A run keeps the space after it, so copied text keeps its spaces.
   */
  private words(line: LayoutLine): { text: string; x0: number; x1: number }[] {
    const { segments, kinds, widths } = this.prepared
    const { start, end } = line
    const last = end.graphemeIndex > 0 ? end.segmentIndex : end.segmentIndex - 1
    const runs: { text: string; x0: number; x1: number }[] = []
    let run: { text: string; x0: number; x1: number } | null = null
    let x = 0
    for (let i = start.segmentIndex; i <= last; i++) {
      let text = segments[i]!
      let width = widths[i]!
      // a word wider than the column breaks inside a segment; measure just this line's piece
      const from = i === start.segmentIndex ? start.graphemeIndex : 0
      const to = i === end.segmentIndex ? end.graphemeIndex : 0
      if (from > 0 || to > 0) {
        const piece = {
          start: { segmentIndex: i, graphemeIndex: from },
          end: to > 0 ? { segmentIndex: i, graphemeIndex: to } : { segmentIndex: i + 1, graphemeIndex: 0 },
          width: 0,
        }
        text = materializeLineRange(this.prepared, piece).text
        width = this.measure(text)
      }
      if (kinds[i] === 'space') {
        if (run) run.text += text
        run = null
      } else {
        if (!run) runs.push((run = { text: '', x0: x, x1: x }))
        run.text += text
        run.x1 = x + width
      }
      x += width
    }
    return runs
  }

  private measure(text: string): number {
    this.ctx ??= document.createElement('canvas').getContext('2d')
    if (!this.ctx) return 0
    this.ctx.font = this.font
    return this.ctx.measureText(text).width
  }

  private span(i: number): HTMLSpanElement {
    let span = this.pool[i]
    if (!span) {
      span = document.createElement('span')
      span.setAttribute('aria-hidden', 'true')
      this.layer.append(span)
      this.pool.push(span)
    }
    span.hidden = false
    if (span.style.visibility) span.style.visibility = '' // hidden by an earlier parting
    return span
  }
}

function place(span: HTMLElement, x: number, y: number): void {
  span.style.transform = `translate(${x}px, ${y}px)`
}
