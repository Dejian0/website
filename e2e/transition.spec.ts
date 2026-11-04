import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { STAGES } from '../src/scroll/transition.ts'
import { MAX_LEFT_SHIFT } from '../src/terrain/clearance.ts'
import type { Rect, Surface } from '../src/terrain/terrain.ts'
import type { PaintedLine } from '../src/text/flow.ts'

// window.__site: dev-only hook from src/debug.ts
type Site = {
  robot(): { x: number; y: number; mode: string; p: number; surface: number | null; silhouette: Rect }
  setSpeed(mult: number): void
  painted(): PaintedLine[]
  surfaces(): Surface[]
  place(surface: number, x: number): void
  send(x: number, y: number): void
  parting(): { hidden: number; maxLeftShift: number }
  route(): { lane: number; clear: boolean } | null
}
const setSpeed = (page: Page, mult: number) =>
  page.evaluate((m) => (window as unknown as { __site: Site }).__site.setSpeed(m), mult)
const robot = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot())

/** Fraction of pixels that differ between two same-size PNG screenshots (anti-aliasing ignored). */
function differing(a: Buffer, b: Buffer, diffPath?: string): number {
  const x = PNG.sync.read(a)
  const y = PNG.sync.read(b)
  expect([y.width, y.height]).toEqual([x.width, x.height])
  const diff = new PNG({ width: x.width, height: x.height })
  const n = pixelmatch(x.data, y.data, diff.data, x.width, x.height, { threshold: 0.1 })
  if (diffPath) writeFileSync(diffPath, PNG.sync.write(diff))
  return n / (x.width * x.height)
}

/** Fraction of pixels darker than near-white: the drawing's ink. */
function inked(png: Buffer): number {
  const { data, width, height } = PNG.sync.read(png)
  let n = 0
  for (let i = 0; i < data.length; i += 4) if (data[i]! < 200) n++
  return n / (width * height)
}

async function booted(page: Page) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  await setSpeed(page, 0)
}

/** Scrolls to y and waits for the robot to have followed (p is drawn on the next frame). */
async function scrollAndFollow(page: Page, y: number) {
  return page.evaluate(async (y) => {
    window.scrollTo(0, y)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return (window as unknown as { __site: Site }).__site.robot().p
  }, y)
}

/** The scroll position where p reaches 1: p is linear in scrollY from 0, so one probe finds it. */
async function transitionEnd(page: Page): Promise<number> {
  const probe = 10
  const p = await scrollAndFollow(page, probe)
  expect(p).toBeGreaterThan(0)
  expect(p).toBeLessThan(1)
  await scrollAndFollow(page, 0)
  return probe / p
}

// On the production build: there the CSS is a <link>, so the page is styled without JS.
test.describe('production build', () => {
  test.use({ baseURL: 'http://localhost:5181' })

  // Before: the page with its script held back. A delayed script would do in Chromium, but WebKit
  // holds the first paint while a deferred module script is pending, so there the static frame
  // can't be screenshotted before the takeover; an aborted script lets the page render as without JS.
  test('takeover is invisible', async ({ page }, testInfo) => {
    const script = /\/assets\/.*\.js$/
    await page.route(script, (route) => route.abort())
    await page.goto('/')
    const anchor = (await page.locator('#robot-anchor').boundingBox())!
    const nameTop = () => page.locator('.name').evaluate((e) => e.getBoundingClientRect().top + scrollY)
    const top = await nameTop()
    const before = await page.screenshot({ clip: anchor })
    expect(await page.locator('html').getAttribute('data-text-flow'), 'screenshot taken before JS ran').toBeNull()
    expect(inked(before)).toBeGreaterThan(0.01) // the static robot is drawn

    await page.unroute(script)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted', { timeout: 10_000 })
    await expect(page.locator('#robot-static')).toHaveCSS('visibility', 'hidden')
    expect(await page.locator('#robot-layer svg path').count()).toBeGreaterThan(20)
    expect(await page.locator('#robot-anchor').boundingBox()).toEqual(anchor) // the hero keeps its box
    expect(Math.abs((await nameTop()) - top)).toBeLessThanOrEqual(0.5)
    const after = await page.screenshot({ clip: anchor })
    expect(differing(before, after, testInfo.outputPath('takeover-diff.png'))).toBeLessThan(0.005)
  })
})

test('p=0, 0.5, 1 screenshots', async ({ page }, testInfo) => {
  await booted(page)
  const end = await transitionEnd(page)
  const vp = page.viewportSize()!
  for (const q of [0, 0.5, 1]) {
    const p = await scrollAndFollow(page, q === 1 ? Math.ceil(end) + 1 : Math.round(q * end))
    expect(p).toBeCloseTo(q, 2)
    const box = (await page.locator('#robot-layer svg').boundingBox())!
    expect(box.x, `p=${q}`).toBeGreaterThanOrEqual(0)
    expect(box.y, `p=${q}`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `p=${q}`).toBeLessThanOrEqual(vp.width)
    expect(box.y + box.height, `p=${q}`).toBeLessThanOrEqual(vp.height)
    await page.screenshot({ path: testInfo.outputPath(`p-${q}.png`) })
  }
})

// The hero reads as a solid: shaded faces on a soft ground shadow. Once it stands in the text it
// is the plain line drawing again, white faces and no shadow.
test('shaded hero on a ground shadow; the walker plain white', async ({ page }) => {
  await booted(page)
  const end = await transitionEnd(page)
  const look = () =>
    page.evaluate(() => {
      const svg = document.querySelector('#robot-layer svg')!
      const faces = [...svg.querySelectorAll('path:not(.robot-shadow)')].filter((e) => e.getAttribute('display') !== 'none')
      const shadow = svg.querySelector('.robot-shadow')!
      return {
        faces: faces.length,
        grey: faces.filter((e) => e.getAttribute('fill') !== '#fff').length,
        shadow: shadow.getAttribute('display') !== 'none' && Number(shadow.getAttribute('opacity')) > 0,
      }
    })
  const hero = await look()
  expect(hero.faces).toBeGreaterThan(20)
  expect(hero.grey).toBeGreaterThan(hero.faces / 2)
  expect(hero.shadow).toBe(true)
  await scrollAndFollow(page, Math.ceil(end) + 1)
  expect(await look()).toEqual({ faces: expect.any(Number), grey: 0, shadow: false })
})

// The spec's hand-off check: the render just before p reaches 1 and at 1 are the same picture,
// facing either way (facing left, the transition turns the robot round to the mirrored walker).
test('hand-off at p=1 is invisible', async ({ page }) => {
  await booted(page)
  // the hint label shows only from p = 1 and may sit just above the robot: it is not the robot's drawing
  await page.addStyleTag({ content: '#robot-hint { visibility: hidden !important; }' })
  const end = await transitionEnd(page)
  /** The page region around the walker, at scroll y. */
  const shot = async (y: number) => {
    await scrollAndFollow(page, y)
    const s = (await robot(page)).silhouette
    const scroll = await page.evaluate(() => scrollY)
    const pad = 6
    return page.screenshot({ clip: { x: s.x0 - pad, y: s.y0 - pad - scroll, width: s.x1 - s.x0 + 2 * pad, height: s.y1 - s.y0 + 2 * pad } })
  }
  const handOff = async () => {
    const at1 = await shot(Math.ceil(end) + 1)
    expect((await robot(page)).p).toBe(1)
    const before = await shot(Math.floor(end) - 1)
    expect((await robot(page)).p).toBeLessThan(1)
    expect(inked(at1)).toBeGreaterThan(0.02)
    expect(differing(before, at1)).toBeLessThan(0.005)
  }
  await scrollAndFollow(page, Math.ceil(end) + 1)
  await handOff() // facing right, at the start of the first bio line

  // walk (at p = 1) until it faces left (its head, the longer end, on the left), then freeze it
  await scrollAndFollow(page, Math.ceil(end) + 1)
  await setSpeed(page, 8)
  await expect
    .poll(async () => {
      const r = await robot(page)
      return r.x - r.silhouette.x0 > r.silhouette.x1 - r.x
    }, { timeout: 15_000 })
    .toBe(true)
  await setSpeed(page, 0)
  await handOff()
})

/**
 * The text the drawn robot overlaps now, as labels: each line of the hero's name, description
 * and now-line, and each painted word, from its glyph tops to its line bottom (as in the walker
 * spec). Glyph boxes are Range rects; the robot's box is its SVG's, less the 2px stroke pad.
 */
function crossings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const b = document.querySelector('#robot-layer svg')!.getBoundingClientRect()
    const s = { x0: b.left + 2, y0: b.top + 2, x1: b.right - 2, y1: b.bottom - 2 }
    const out: string[] = []
    const meet = (r: Rect, label: string) => {
      if (r.x1 > s.x0 + 0.5 && r.x0 < s.x1 - 0.5 && r.y1 > s.y0 + 0.5 && r.y0 < s.y1 - 0.5) out.push(label)
    }
    for (const el of document.querySelectorAll('#hero .name, #hero .line, #hero .now, #work .title, #work .meta')) {
      const range = document.createRange()
      range.selectNodeContents(el)
      for (const q of range.getClientRects()) if (q.width > 0) meet({ x0: q.left, y0: q.top, x1: q.right, y1: q.bottom }, `hero ${el.className}`)
    }
    const glyphTop = new Map(site.surfaces().map((x) => [`${x.flow}:${x.line}`, x.y]))
    const next = new Map<string, { spans: Element[]; k: number }>()
    for (const line of site.painted()) {
      if (!next.has(line.flow)) {
        const layer = document.querySelector(`[data-flow="${line.flow}"]`)!.nextElementSibling!
        next.set(line.flow, { spans: [...layer.querySelectorAll('span:not([hidden])')], k: 0 })
      }
      const f = next.get(line.flow)!
      const own = f.spans.slice(f.k, (f.k += line.words.length))
      const top = glyphTop.get(`${line.flow}:${line.index}`)! - scrollY
      const bottom = line.y + line.lineHeight - scrollY
      for (const span of own) {
        const range = document.createRange()
        range.setStart(span.firstChild!, 0)
        range.setEnd(span.firstChild!, span.textContent!.trimEnd().length)
        const g = range.getBoundingClientRect()
        meet({ x0: g.left, y0: top, x1: g.right, y1: bottom }, `${line.flow}:${line.index}`)
      }
    }
    return out
  })
}

/**
 * Stands the (frozen) walker on `flow`, on its line `minLine` or below: at the start of a line,
 * or mid-line. Returns the lines above the one it stands on, nearest first, in page order.
 */
function placeIn(page: Page, flow: string, where: 'start' | 'middle', minLine = 1) {
  return page.evaluate(
    ({ flow, where, minLine }) => {
      const site = (window as unknown as { __site: Site }).__site
      const ss = site.surfaces().filter((s) => s.standable && s.flow === flow && s.line >= minLine)
      const s = where === 'start' ? ss.sort((a, b) => a.x0 - b.x0)[0]! : ss.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0]!
      site.place(s.id, where === 'start' ? s.x0 : (s.x0 + s.x1) / 2)
      const lines = site.painted()
      const i = lines.findIndex((l) => l.flow === s.flow && l.index === s.line)
      return lines.slice(0, i).reverse().map((l) => `${l.flow}:${l.index}`)
    },
    { flow, where, minLine },
  )
}

/** Painted lines with a word moved off where it was laid out (parted), as labels. */
function partedLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const out: string[] = []
    const next = new Map<string, { spans: Element[]; k: number }>()
    for (const line of site.painted()) {
      if (!next.has(line.flow)) {
        const layer = document.querySelector(`[data-flow="${line.flow}"]`)!.nextElementSibling!
        next.set(line.flow, { spans: [...layer.querySelectorAll('span:not([hidden])')], k: 0 })
      }
      const f = next.get(line.flow)!
      const own = f.spans.slice(f.k, (f.k += line.words.length))
      const moved = own.some((span, k) => {
        const range = document.createRange()
        range.selectNodeContents(span)
        return Math.abs(range.getBoundingClientRect().left + scrollX - (line.x + line.words[k]!.x0)) > 0.5
      })
      if (moved) out.push(`${line.flow}:${line.index}`)
    }
    return out
  })
}

/**
 * Sends the robot (at p = 1) from the right end of the bio's first line to the right end of its
 * second, until it is in mid-hop on the way, at least 6px off any line, and freezes it there: the
 * same hop each time (the wander's legs go to random spots, some of which have no clean route in
 * at 1024 and 1100px; see PASSES_OVER).
 */
async function freezeMidHop(page: Page) {
  const end = await transitionEnd(page)
  await scrollAndFollow(page, Math.ceil(end) + 1)
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const site = (window as unknown as { __site: Site }).__site
        const surfaces = site.surfaces()
        const ys = surfaces.map((s) => s.y)
        const end = (line: number) => surfaces.filter((s) => s.flow === 'bio-0' && s.line === line && s.standable).at(-1)!
        site.place(end(0).id, end(0).x1)
        site.send(end(1).x1, end(1).y)
        const t0 = performance.now()
        site.setSpeed(8)
        const check = () => {
          const r = site.robot()
          const airborne = ys.every((y) => Math.abs(r.y - y) > 6)
          if (airborne || performance.now() - t0 > 15_000) {
            site.setSpeed(0)
            resolve(airborne)
          } else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
  )
}

/**
 * Flies from the hero to the walker in 0.05 steps of p; returns the samples that crossed text,
 * and the route the flight took (read walking in, while it is planned).
 */
async function flight(page: Page) {
  const end = await transitionEnd(page)
  const crossed: { p: number; text: string[] }[] = []
  let route: { lane: number; clear: boolean } | null = null
  for (let i = 0; i <= 20; i++) {
    const p = await scrollAndFollow(page, i === 20 ? Math.ceil(end) + 1 : Math.round((i / 20) * end))
    const text = await crossings(page)
    if (text.length) crossed.push({ p, text })
    if (i === 18) route = await page.evaluate(() => (window as unknown as { __site: Site }).__site.route())
  }
  return { crossed, route }
}

const parting = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.parting())

/** Since the page loaded, no parting hid a word or moved a line's start more than the cap. */
async function partedCleanly(page: Page, label: string) {
  const { hidden, maxLeftShift } = await parting(page)
  expect(hidden, `${label}: hidden words`).toBe(0)
  expect(maxLeftShift, `${label}: a line's start moved left`).toBeLessThanOrEqual(MAX_LEFT_SHIFT)
}

// The spec's anti-goal "text overlapping the robot". Where a lane beside the text exists (from
// about 920px wide) and the walk-in from it parts every line it reaches cleanly all the way
// (planLane picks the side where it does), the flight never crosses text, wherever the walker
// waits: it drops down the lane, and walking in to its spot the lines it reaches part around it,
// as for the walker (on a blurb's 24px lines its body reaches two). The partings never hide a
// word. At 1440 and 1280 every landing here has such a lane; at 1100 and 1024 most do. The one
// that doesn't, 1024's middle of a bio-2 line (the short last paragraph's second line), walks in
// under its first line, which can't part cleanly there: the robot passes over those words, which
// show through it, for two samples of the walk-in, as the walk-in does wherever a line can't part.
const PASSES_OVER: Record<string, { samples: number; lines: string[] }> = {
  '1024×768: to the middle of a bio-2 line': { samples: 2, lines: ['bio-2:0'] },
}

test('the flight keeps clear of text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop and laptop widths')
  test.setTimeout(120_000)
  const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1100, height: 900 }, { width: 1024, height: 768 }]
  for (const size of sizes) {
    const at = (where: string) => `${size.width}×${size.height}: to ${where}`
    const clean = async (where: string) => {
      const { crossed, route } = await flight(page)
      const over = PASSES_OVER[at(where)]
      if (over) {
        expect(crossed.length, `${at(where)}: samples over words`).toBeLessThanOrEqual(over.samples)
        for (const c of crossed) expect(c.p, `${at(where)}: only walking in`).toBeGreaterThan(STAGES.enter[0])
        expect([...new Set(crossed.flatMap((c) => c.text))].filter((l) => !over.lines.includes(l)), `${at(where)}: other lines`).toEqual([])
      } else expect(crossed, `${at(where)} (route ${JSON.stringify(route)})`).toEqual([])
      if (size.width >= 1280) expect(route?.clear, `${at(where)}: a clean route`).toBe(true)
    }
    await page.setViewportSize(size)
    await booted(page)
    await clean('the start of the bio')
    for (const flow of ['bio-2', 'work-2'])
      for (const where of ['start', 'middle'] as const) {
        await placeIn(page, flow, where)
        await clean(`the ${where} of a ${flow} line`)
      }
    // mid-line on a blurb's third line or below: on 24px lines the walker's body reaches the two
    // lines above, and both part around it as it walks in
    const [above1, above2] = await placeIn(page, 'work-1', 'middle', 2)
    expect(above2, 'two blurb lines above').toMatch(/^work-1:/)
    await clean('the middle of a work-1 line ≥ 2')
    const end = await transitionEnd(page)
    const halfway = (STAGES.enter[0] + STAGES.enter[1]) / 2
    const p = await scrollAndFollow(page, Math.round(halfway * end))
    expect(p).toBeGreaterThan(STAGES.enter[0])
    expect(p).toBeLessThan(1)
    expect(await crossings(page)).toEqual([])
    expect(await partedLines(page), `${at('work-1 ≥ 2')}: walking in at p=${p}`).toEqual([above2, above1])
    await partedCleanly(page, at('every landing so far')) // before the reload resets the count
    await booted(page)
    expect(await freezeMidHop(page), 'caught in mid-hop').toBe(true)
    await clean('a walker paused in mid-hop')
    await partedCleanly(page, at('a walker paused in mid-hop'))
  }
})

// The same guarantee for every spot the walker can wait at, between the widths where every spot
// has a clean route and those where none has: wherever its route is clean, the flight crosses no
// text (sampled through the drop and the walk-in).
test('wherever its route is clean, the flight crosses no text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'laptop widths')
  test.setTimeout(120_000)
  for (const size of [{ width: 1100, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size)
    await booted(page)
    const end = await transitionEnd(page)
    const ids = await page.evaluate(() => (window as unknown as { __site: Site }).__site.surfaces().filter((s) => s.standable).map((s) => s.id))
    const crossed: string[] = []
    let clean = 0
    for (const id of ids) {
      await page.evaluate((id) => {
        const site = (window as unknown as { __site: Site }).__site
        const s = site.surfaces()[id]!
        site.place(id, (s.x0 + s.x1) / 2)
      }, id)
      let route: { lane: number; clear: boolean } | null = null
      const hits: string[] = []
      for (const q of [0.6, 0.72, 0.8, 0.86, 0.92, 0.97]) {
        const p = await scrollAndFollow(page, Math.round(q * end))
        route ??= await page.evaluate(() => (window as unknown as { __site: Site }).__site.route())
        for (const t of await crossings(page)) hits.push(`p=${p.toFixed(2)} ${t}`)
      }
      if (!route?.clear) continue
      clean++
      if (hits.length) crossed.push(`${size.width}: piece ${id}: ${hits.join(', ')}`)
    }
    expect(crossed).toEqual([])
    expect(clean, `${size.width}: spots with a clean route`).toBeGreaterThan(ids.length / 2)
    await partedCleanly(page, `${size.width}`)
  }
})

// From about 893 to 912px wide the room clamps the left lane closer to the text than the pad a
// line parts with, though its drop passes none: walking in, the gap starts that much smaller, so
// nothing moves the moment it starts (it once jumped 10px at p = 0.75), then grows to the pad.
test('a lane the room crowds starts its walk-in with nothing moving', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'a laptop width')
  await page.setViewportSize({ width: 895, height: 900 })
  await booted(page)
  const end = await transitionEnd(page)
  await placeIn(page, 'bio-0', 'start')
  const { max, route } = await page.evaluate(
    async ({ from, to }) => {
      const site = (window as unknown as { __site: Site }).__site
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const xs = () => [...document.querySelectorAll('.flow-paint > span:not([hidden])')].map((e) => e.getBoundingClientRect().left)
      let last: number[] | null = null
      let max = 0
      for (let y = from; y <= to; y++) {
        window.scrollTo(0, y)
        await frame()
        const now = xs()
        if (last) max = Math.max(max, ...now.map((x, i) => Math.abs(x - last![i]!)))
        last = now
      }
      return { max, route: site.route() }
    },
    { from: Math.floor((STAGES.enter[0] - 0.02) * end), to: Math.ceil((STAGES.enter[0] + 0.03) * end) },
  )
  expect(route?.clear, 'a clean route down the crowded lane').toBe(true)
  expect(max, 'largest move of a word in one px of scroll').toBeLessThan(1)
})

// From 641 to about 920px wide there is no lane (the margin is narrower than the walker plus its
// gaps, and the hero text reaches past the bio's right gutter), so the flight takes the side
// that crosses least. Measured at 768: none to the start of the bio; to the start of a bio-2 line,
// the left lane, whose walk-in parts cleanly: 5 of 21 samples, all as it drops past the starts of
// the lines above (p ≤ 0.75), and none walking in. These bounds allow one sample more.
test('the flight at 768px crosses little text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'tablet width')
  await page.setViewportSize({ width: 768, height: 1024 })
  await booted(page)
  expect((await flight(page)).crossed.length).toBeLessThanOrEqual(1)
  await placeIn(page, 'bio-2', 'start')
  const deep = (await flight(page)).crossed
  expect(deep.length, JSON.stringify(deep)).toBeLessThanOrEqual(6)
  for (const c of deep) expect(c.p, JSON.stringify(c)).toBeLessThanOrEqual(STAGES.enter[0] + 1e-9)
  await partedCleanly(page, '768')
})

/**
 * The walker waiting at the middle of every `step`th standable piece, the flight sampled at each
 * p of `ps`: every painted line parted while the drawn robot is not inside its gap, hidden words,
 * and how many samples had a line parted. A parted line's gap is read off the page: between the
 * last word that kept its place or moved left and the first that moved right (from the line's
 * start or to its end, where all its words moved one way). The robot's box is its SVG's, less
 * the 2px stroke pad, which the SVG rounds out to whole px: hence 1px of tolerance.
 */
function partingsAway(page: Page, end: number, ps: number[], step: number) {
  return page.evaluate(
    async ({ end, ps, step }) => {
      const site = (window as unknown as { __site: Site }).__site
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const away: string[] = []
      let samples = 0
      let parted = 0
      const pieces = site.surfaces().filter((s) => s.standable).filter((_, i) => i % step === 0)
      for (const piece of pieces) {
        site.place(piece.id, (piece.x0 + piece.x1) / 2)
        for (const q of ps) {
          window.scrollTo(0, Math.round(q * end))
          await frame()
          samples++
          const p = site.robot().p
          const b = document.querySelector('#robot-layer svg')!.getBoundingClientRect()
          const s = { x0: b.left + 2, y0: b.top + 2, x1: b.right - 2, y1: b.bottom - 2 }
          const glyphTop = new Map(site.surfaces().map((x) => [`${x.flow}:${x.line}`, x.y]))
          const next = new Map<string, { spans: Element[]; k: number }>()
          let any = false
          for (const line of site.painted()) {
            if (!next.has(line.flow)) {
              const layer = document.querySelector(`[data-flow="${line.flow}"]`)!.nextElementSibling!
              next.set(line.flow, { spans: [...layer.querySelectorAll('span:not([hidden])')], k: 0 })
            }
            const f = next.get(line.flow)!
            const own = f.spans.slice(f.k, (f.k += line.words.length))
            const label = `piece ${piece.id} p=${p.toFixed(3)} ${line.flow}:${line.index}`
            const boxes = own.map((span) => {
              if (getComputedStyle(span).visibility === 'hidden') away.push(`${label}: hidden "${span.textContent}"`)
              const range = document.createRange()
              range.setStart(span.firstChild!, 0)
              range.setEnd(span.firstChild!, span.textContent!.trimEnd().length)
              return range.getBoundingClientRect()
            })
            const moved = boxes.map((g, k) => g.left + scrollX - (line.x + line.words[k]!.x0))
            if (!moved.some((m) => Math.abs(m) > 0.5)) continue
            any = true
            const k = moved.findIndex((m, i) => i > 0 && m > moved[i - 1]! + 0.5)
            const gap = k > 0 ? [boxes[k - 1]!.right, boxes[k]!.left] : moved[0]! > 0 ? [-Infinity, boxes[0]!.left] : [boxes.at(-1)!.right, Infinity]
            const top = glyphTop.get(`${line.flow}:${line.index}`)! - scrollY
            const bottom = line.y + line.lineHeight - scrollY
            const inside = s.x0 >= gap[0]! - 1 && s.x1 <= gap[1]! + 1 && s.y1 > top - 1 && s.y0 < bottom + 1
            if (!inside) away.push(`${label}: gap [${gap.map((g) => g.toFixed(1))}], robot [${s.x0.toFixed(1)}, ${s.x1.toFixed(1)}] × [${s.y0.toFixed(1)}, ${s.y1.toFixed(1)}]`)
          }
          if (any) parted++
        }
      }
      return { away, samples, parted }
    },
    { end, ps, step },
  )
}

// Where the flight can't walk in cleanly (phones, tablets: no lane, or a walk-in past words too
// wide to part around), the text still parts only around the robot: before the walk-in nothing
// parts (no gap waits where it will land), and walking in a line it reaches parts around it where
// that line parts cleanly, else stays as laid out, its words showing through the robot.
for (const { width, project } of [{ width: 390, project: 'mobile' }, { width: 768, project: 'desktop' }])
  test(`walking in at ${width}px, a line parts only around the robot`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== project, `${project} project`)
    test.setTimeout(120_000)
    if (width !== page.viewportSize()!.width) await page.setViewportSize({ width, height: 1024 })
    await booted(page)
    const end = await transitionEnd(page)
    const ps = [0.5, 0.7, 0.76, 0.79, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 0.995]
    const { away, samples, parted } = await partingsAway(page, end, ps, 3)
    expect(away, JSON.stringify(away.slice(0, 8))).toEqual([])
    expect(samples).toBeGreaterThan(300)
    expect(parted, 'lines do part walking in').toBeGreaterThan(samples / 4)
    await partedCleanly(page, `${width}`)
  })

// A phone has no lane: the text fills the width but for 22px of padding and the bio's right
// gutter. The robot shrinks first and drops down the side that crosses least. To the start of
// the bio, only the hero description's widest line (all but the full width) is in its way: at
// most 2 of the 21 samples. Deep in the bio it also walks in past the line above.
test('the flight at 390px crosses little text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone width')
  await booted(page)
  const start = (await flight(page)).crossed
  expect(start.length, JSON.stringify(start)).toBeLessThanOrEqual(2)
  expect(start.flatMap((c) => c.text).every((t) => t === 'hero line')).toBe(true)
  const [above] = await placeIn(page, 'bio-2', 'start')
  const deep = (await flight(page)).crossed
  expect(deep.length, JSON.stringify(deep)).toBeLessThanOrEqual(6) // ≤ 2 for the description, ≤ 4 walking in (p ≥ 0.8)
  for (const c of deep) expect(c.text.every((t) => t === 'hero line' || (t === above && c.p >= STAGES.enter[0])), JSON.stringify(c)).toBe(true)
})

// A tall screen shows the bio's first line above 55% already: the transition still takes 0.3 of
// a viewport of scroll. A page that can't scroll at all shows the walker at once.
test('tall viewports', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop sizes')
  await page.setViewportSize({ width: 1440, height: 2560 })
  await booted(page)
  const end = await transitionEnd(page)
  expect(end).toBeGreaterThanOrEqual(0.3 * 2560 - 1)
  expect(await scrollAndFollow(page, Math.ceil(end) + 1)).toBe(1)
  await setSpeed(page, 8)
  const x = (await robot(page)).x
  await expect.poll(async () => (await robot(page)).x).not.toBe(x)

  await page.setViewportSize({ width: 1440, height: 6000 })
  await booted(page)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0)
  expect((await robot(page)).p).toBe(1)
  await setSpeed(page, 8)
  const y = (await robot(page)).x
  await expect.poll(async () => (await robot(page)).x).not.toBe(y)
})

test('scroll back while wandering', async ({ page }) => {
  await booted(page)
  await page.locator('#bio').scrollIntoViewIfNeeded()
  const bio = await page.evaluate(() => scrollY)
  // slow, so a frame of walking is well under the 2px tolerance
  await setSpeed(page, 1)
  await expect.poll(async () => (await robot(page)).p).toBe(1)
  await page.waitForTimeout(500)
  const recorded = (await robot(page)).x

  expect(await scrollAndFollow(page, 0)).toBe(0)
  const paused = await robot(page)
  await page.waitForTimeout(1000)
  expect((await robot(page)).x).toBe(paused.x) // the walker is paused...
  expect(Math.abs(paused.x - recorded)).toBeLessThanOrEqual(2)

  expect(await scrollAndFollow(page, bio)).toBe(1) // ...and resumes where it stopped
  expect(Math.abs((await robot(page)).x - recorded)).toBeLessThanOrEqual(2)
  await page.waitForTimeout(500)
  expect((await robot(page)).x).not.toBe(paused.x)
})
