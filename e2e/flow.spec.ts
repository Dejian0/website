import { expect, test, type Page } from '@playwright/test'
import * as c from '../src/content'
import type { PaintedLine } from '../src/text/flow.ts'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

async function painted(page: Page) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  // these tests drive the flows directly: keep the walker at its start, which parts no line
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.setSpeed(0))
  // asStatic(f) shows the static render in the same page (each source as it is without painting,
  // its layer hidden), runs f, then paints again. A bio or blurb paragraph is .sr-only while
  // painted, a list row's text .flow-under (in place, unseen): see TextFlow.
  await page.evaluate(() => {
    ;(window as unknown as Helpers).asStatic = <T>(f: () => T): T => {
      const sources = [...document.querySelectorAll('[data-flow]')]
      const was = sources.map((s) => ['sr-only', 'flow-under'].filter((k) => s.classList.contains(k)))
      const layers = [...document.querySelectorAll<HTMLElement>('.flow-paint')]
      for (const s of sources) s.classList.remove('sr-only', 'flow-under')
      for (const l of layers) l.style.display = 'none'
      try {
        return f()
      } finally {
        sources.forEach((s, i) => s.classList.add(...was[i]!))
        for (const l of layers) l.style.display = ''
      }
    }
  })
}

type Helpers = { asStatic<T>(f: () => T): T }

// Each painted span is one word plus the space after it, so a layer's spans concatenate
// to its paragraph; paragraphs (one flow each) are joined with a space.
test('painted text matches source', async ({ page }) => {
  await painted(page)
  const text = (scope: string) =>
    page.evaluate((scope) => {
      const join = (sel: string, f: (e: Element) => string) =>
        [...document.querySelectorAll(`${scope} ${sel}`)].map(f).join(' ')
      return {
        source: join('[data-flow]', (p) => p.textContent!),
        painted: join('.flow-paint', (l) => [...l.querySelectorAll('span:not([hidden])')].map((s) => s.textContent).join('')),
      }
    }, scope)
  for (const scope of ['#bio', '#work', '#education', '#focus']) {
    const t = await text(scope)
    expect(norm(t.source).length, scope).toBeGreaterThan(scope === '#education' ? 60 : 100)
    expect(norm(t.painted), scope).toBe(norm(t.source))
  }
})

// window.__site: dev-only hook from src/debug.ts
type Site = {
  flow(id: string): {
    layout(columnWidth: number): PaintedLine[]
    part(line: number, gapLeft: number, gapRight: number): void
    unpart(line: number): void
  }
  painted(): PaintedLine[]
  setSpeed(mult: number): void
}

// Checks each PaintedLine word box against where its span's glyphs are drawn, and against
// where the static paragraph draws that word (static render shown in the same page, then
// restored). With `narrow`, only bio-1 is checked, laid out (and the static paragraph sized)
// at that width, so words wider than the column break mid-word.
function wordBoxMismatches(page: Page, narrow: number | null) {
  return page.evaluate((narrow) => {
    const site = (window as unknown as { __site: Site }).__site
    const { asStatic } = window as unknown as Helpers
    const bad: string[] = []
    let words = 0
    let midWord = 0 // line ends that fall inside a word
    // the word's glyph extent: a Range over its text without the trailing space
    const glyphs = (node: Node, from: number, to: number) => {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      return [...range.getClientRects()].filter((q) => q.width > 0)
    }
    const sources = narrow
      ? [document.querySelector<HTMLElement>('p[data-flow="bio-1"]')!]
      : [...document.querySelectorAll<HTMLElement>('[data-flow]')]
    const boxes = sources.map((source) => {
      const id = source.dataset.flow!
      let lines = site.painted().filter((l) => l.flow === id)
      if (narrow) {
        source.style.boxSizing = 'content-box' // the column is `narrow` wide, beside any gutter
        source.style.width = `${narrow}px`
        lines = site.flow(id).layout(narrow)
      }
      const spans = [...source.nextElementSibling!.querySelectorAll('span:not([hidden])')]
      const out: { text: string; offset: number; x0: number; y: number }[] = []
      let k = 0
      let offset = 0 // spans carry their spaces, so they concatenate to the source text
      for (const line of lines) {
        if (line.index < lines.length - 1 && /\p{L}$/u.test(spans[k + line.words.length - 1]!.textContent!)) midWord++
        for (const w of line.words) {
          const text = spans[k++]!.textContent!
          const word = text.trimEnd()
          const [g] = glyphs(spans[k - 1]!.firstChild!, 0, word.length)
          const x0 = line.x + w.x0
          const x1 = line.x + w.x1
          const gy = g!.top + scrollY
          if (Math.abs(g!.left + scrollX - x0) > 1 || Math.abs(g!.right + scrollX - x1) > 1)
            bad.push(`${id}:${line.index} "${word}" box [${x0}, ${x1}] glyphs [${g!.left + scrollX}, ${g!.right + scrollX}]`)
          if (gy < line.y || gy >= line.y + line.lineHeight) bad.push(`${id}:${line.index} "${word}" drawn at y ${gy}`)
          out.push({ text: word, offset, x0, y: gy })
          offset += text.length
          words++
        }
      }
      if (k !== spans.length) bad.push(`${id}: ${spans.length} spans, ${k} word boxes`)
      return out
    })
    asStatic(() =>
      sources.forEach((source, i) => {
        for (const b of boxes[i]!) {
          const id = source.dataset.flow
          if (source.textContent!.slice(b.offset, b.offset + b.text.length) !== b.text) {
            bad.push(`${id} "${b.text}" is not at source offset ${b.offset}`)
            continue
          }
          const rects = glyphs(source.firstChild!, b.offset, b.offset + b.text.length)
          if (rects.length !== 1) bad.push(`${id} "${b.text}" sits on ${rects.length} static lines`)
          else if (Math.abs(rects[0]!.left + scrollX - b.x0) > 1 || Math.abs(rects[0]!.top + scrollY - b.y) > 1)
            bad.push(`${id} "${b.text}" static at ${rects[0]!.left + scrollX}, ${rects[0]!.top + scrollY}; painted ${b.x0}, ${b.y}`)
        }
      }),
    )
    return { words, midWord, bad: bad.slice(0, 10) }
  }, narrow)
}

test('word boxes match glyphs', async ({ page }) => {
  await painted(page)
  const r = await wordBoxMismatches(page, null)
  expect(r.bad).toEqual([])
  // every word of the bio, the blurbs and the lists (a word may be painted in pieces, as at a hyphen)
  const lists = [...c.education.flatMap((e) => [e.school, e.detail, e.dates]), ...c.skills]
  expect(r.words).toBeGreaterThanOrEqual([...c.bio, ...c.work.map((w) => w.blurb), ...lists].join(' ').split(/\s+/).length)
})

test('word boxes match glyphs when a word is wider than the column', async ({ page }) => {
  await painted(page)
  const r = await wordBoxMismatches(page, 80)
  expect(r.bad).toEqual([])
  expect(r.midWord).toBeGreaterThan(0)
})

test('part never overlaps the gap and never splits a word', async ({ page }) => {
  await painted(page)
  const r = await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const GAP = 60
    const bad: string[] = []
    const words: Record<string, string[]> = {}
    let steps = 0
    let moved = 0
    const glyphs = (spans: Element[]) =>
      spans.map((s) => {
        const range = document.createRange()
        range.setStart(s.firstChild!, 0)
        range.setEnd(s.firstChild!, s.textContent!.trimEnd().length)
        const q = range.getBoundingClientRect()
        return { x0: q.left + scrollX, x1: q.right + scrollX }
      })
    for (const id of ['bio-1', 'work-0']) {
      const flow = site.flow(id)
      const spans = [...document.querySelector(`p[data-flow="${id}"]`)!.nextElementSibling!.querySelectorAll('span:not([hidden])')]
      words[id] = spans.map((s) => s.textContent!.trim())
      let first = 0
      for (const line of site.painted().filter((l) => l.flow === id)) {
        const own = spans.slice(first, (first += line.words.length))
        const texts = own.map((s) => s.textContent!)
        // whole words: one word per span, and inside a line spans only break at spaces
        texts.forEach((t, i) => {
          if (/\s/.test(t.trim()) || (i < texts.length - 1 && !/\s$/.test(t)))
            bad.push(`${id}:${line.index} span "${t}" is not a whole word`)
        })
        const home = glyphs(own)
        for (let gapLeft = line.x - GAP; gapLeft <= line.x + line.width; gapLeft += 10) {
          const gapRight = gapLeft + GAP
          flow.part(line.index, gapLeft, gapRight)
          steps++
          const now = glyphs(own)
          if (now.some((g, i) => Math.abs(g.x0 - home[i]!.x0) > 0.5)) moved++
          // WebKit rounds a Range's width up to whole px, so a glyph's right edge reads up to 1px wide
          now.forEach((g, i) => {
            if (g.x1 > gapLeft + 1 && g.x0 < gapRight - 0.5)
              bad.push(`${id}:${line.index} gap [${gapLeft}, ${gapRight}] overlaps "${texts[i]}" [${g.x0}, ${g.x1}]`)
          })
          if (own.some((s, i) => s.textContent !== texts[i])) bad.push(`${id}:${line.index} span text changed`)
          flow.unpart(line.index)
          glyphs(own).forEach((g, i) => {
            if (Math.abs(g.x0 - home[i]!.x0) > 0.5) bad.push(`${id}:${line.index} "${texts[i]}" not back after unpart`)
          })
        }
      }
    }
    return { steps, moved, words, bad: bad.slice(0, 10) }
  })
  expect(r.bad).toEqual([])
  expect(r.steps).toBeGreaterThan(100)
  expect(r.moved).toBeGreaterThan(r.steps / 2)
  // a hyphenated word is one span; only at a line end may it break after its hyphen, as static
  // text does (a break inside a line is caught above as "not a whole word")
  const w = r.words['work-0']!
  expect(w.includes('tendon-driven') || w[w.indexOf('tendon-') + 1] === 'driven').toBe(true)
})

test('no overflow', async ({ page }) => {
  await painted(page)
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBe(clientWidth)
})

// How far the content below each flow sits from where the static render puts it: shows
// the static render in the same page (sources in flow, layers hidden), then restores.
function shiftFromStatic(page: Page) {
  return page.evaluate(() => {
    const { asStatic } = window as unknown as Helpers
    const tops = () =>
      [...document.querySelectorAll('#work h2, article[data-entry], #education h2, #honors h2, .edu-item, #focus h2, .skills > li, #contact h2, #site h2')].map(
        (e) => e.getBoundingClientRect().top + window.scrollY,
      )
    const layers = document.querySelectorAll('.flow-paint').length
    const painted = tops()
    const stat = asStatic(tops)
    return { anchors: stat.length, layers, max: Math.max(...stat.map((y, i) => Math.abs(y - painted[i]!))) }
  })
}

// a painted layer for each bio paragraph and Work blurb, each Education row's three pieces, each
// Honors row's two or three, each Skills row, and the notes in Contact and This site
const HONOR_PIECES = c.honors.reduce((n, h) => n + (h.dates ? 3 : 2), 0)
const FLOWS = c.bio.length + c.work.length + 3 * c.education.length + HONOR_PIECES + c.skills.length + 2
const FIXED_ANCHORS = c.work.length + 6 + c.education.length + c.honors.length + c.skills.length // shiftFromStatic's: entries, headings, rows

test('activation does not shift content', async ({ page }) => {
  await painted(page)
  const { anchors, layers, max } = await shiftFromStatic(page)
  expect([anchors, layers]).toEqual([FIXED_ANCHORS, FLOWS])
  expect(max).toBeLessThanOrEqual(1)
})

test('resize across the breakpoint keeps painted text in place', async ({ page }) => {
  await painted(page)
  for (const width of [1440, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const { layers, max } = await shiftFromStatic(page)
    expect(layers, `layers at ${width}`).toBe(FLOWS)
    expect(max, `shift at ${width}`).toBeLessThanOrEqual(1)
    const sizes = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('p[data-flow="bio-0"]')!
      return [getComputedStyle(p).fontSize, getComputedStyle(p.nextElementSibling!).fontSize]
    })
    expect(sizes[1], `painted font size at ${width}`).toBe(sizes[0])
  }
})

test('font blocked keeps static text', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // the aborted font requests themselves are logged by the browser; anything else is ours
    if (m.type() === 'error' && !m.location().url.includes('inter-tight')) errors.push(m.text())
  })
  await page.route('**/*inter-tight*', (r) => r.abort())
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'static')
  const p = page.locator('p[data-flow="bio-0"]')
  await expect(p).toBeVisible()
  await expect(p).not.toHaveClass(/sr-only/)
  expect(await page.locator('.flow-paint span').count()).toBe(0)
  expect(errors).toEqual([])
})
