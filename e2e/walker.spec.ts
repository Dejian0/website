import { expect, test, type Page } from '@playwright/test'
import type { PaintedLine } from '../src/text/flow.ts'
import { WALKER_PX, WALKER_PX_NARROW } from '../src/robot/walker.ts'
import { MAX_LEFT_SHIFT, MIN_SPAN } from '../src/terrain/clearance.ts'
import type { Rect, Surface } from '../src/terrain/terrain.ts'

// window.__site: dev-only hook from src/debug.ts
type Site = {
  robot(): { x: number; y: number; mode: string; p: number; surface: number | null; silhouette: Rect; hop: { from: number; to: number } | null }
  painted(): PaintedLine[]
  surfaces(): Surface[]
  setSpeed(mult: number): void
  parting(): { hidden: number; maxLeftShift: number }
  place(surface: number, x: number): void
  advance(seconds: number): void
}


async function walking(page: Page) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  await page.locator('#bio').scrollIntoViewIfNeeded()
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.setSpeed(8))
  await expect.poll(async () => (await robot(page)).p).toBe(1) // the scroll transition is done: it walks
}

/**
 * Problems with the robot's current state, read in one task so the robot and the text are from
 * the same frame: its surface must be standable; every painted word stays shown, one box, and
 * clear of its silhouette (except on the line it stands on); no line's start moves left by more
 * than the cap; the page never scrolls sideways. A line's text band runs from its glyph tops
 * (the y of its surfaces) to the bottom of its line box.
 */
function problems(page: Page) {
  return page.evaluate((cap) => {
    const site = (window as unknown as { __site: Site }).__site
    const r = site.robot()
    const lines = site.painted()
    const surfaces = site.surfaces()
    const bad: string[] = []
    const on = r.surface === null ? null : surfaces[r.surface]
    if (!on?.standable) bad.push(`surface ${r.surface} not standable`)
    const { scrollWidth, clientWidth } = document.documentElement
    if (scrollWidth !== clientWidth) bad.push(`overflow: scrollWidth ${scrollWidth}, clientWidth ${clientWidth}`)
    const { hidden, maxLeftShift } = site.parting()
    if (hidden > 0) bad.push(`${hidden} partings hid a word`)
    if (maxLeftShift > cap) bad.push(`a line's start moved ${maxLeftShift.toFixed(1)}px left`)
    const glyphTop = new Map(surfaces.map((x) => [`${x.flow}:${x.line}`, x.y]))
    const s = r.silhouette
    const spans = new Map<string, Element[]>()
    const next = new Map<string, number>()
    lines.forEach((line) => {
      if (!spans.has(line.flow)) {
        const layer = document.querySelector(`[data-flow="${line.flow}"]`)!.nextElementSibling!
        spans.set(line.flow, [...layer.querySelectorAll('span:not([hidden])')])
        next.set(line.flow, 0)
      }
      const own = spans.get(line.flow)!.slice(next.get(line.flow), next.get(line.flow)! + line.words.length)
      next.set(line.flow, next.get(line.flow)! + line.words.length)
      const top = glyphTop.get(`${line.flow}:${line.index}`)!
      const bottom = line.y + line.lineHeight
      const beside = (line.flow === on?.flow && line.index === on.line) || bottom <= s.y0 + 0.5 || top >= s.y1 - 0.5
      own.forEach((span, k) => {
        const text = span.textContent!
        if (getComputedStyle(span).visibility === 'hidden') {
          bad.push(`${line.flow}:${line.index} "${text.trim()}" hidden`)
          return
        }
        const range = document.createRange()
        range.setStart(span.firstChild!, 0)
        range.setEnd(span.firstChild!, text.trimEnd().length)
        const boxes = [...range.getClientRects()].filter((q) => q.width > 0)
        if (boxes.length !== 1) bad.push(`${line.flow}:${line.index} "${text}" drawn as ${boxes.length} boxes`)
        const g = range.getBoundingClientRect()
        const x0 = g.left + scrollX
        const x1 = g.right + scrollX
        const home = line.x + line.words[k]!.x0
        if (x0 < home - cap - 1) bad.push(`${line.flow}:${line.index} "${text.trim()}" moved ${(home - x0).toFixed(1)}px left`)
        if (beside) return
        // WebKit rounds a Range's width up to whole px, so a right edge reads up to 1px wide
        if (x1 > s.x0 + 1 && x0 < s.x1 - 0.5)
          bad.push(`${line.flow}:${line.index} "${text.trim()}" [${x0.toFixed(1)}, ${x1.toFixed(1)}] overlaps robot [${s.x0.toFixed(1)}, ${s.x1.toFixed(1)}]`)
      })
    })
    return { bad, surface: r.surface, x: r.x, flow: on?.flow ?? null }
  }, MAX_LEFT_SHIFT)
}

/** Polls `problems` every 100ms for `ms`; returns the problems and the surfaces visited. */
async function watch(page: Page, ms: number) {
  const bad: string[] = []
  const visited = new Set<number | null>()
  const flows = new Set<string | null>()
  for (let t = 0; t < ms; t += 100) {
    const r = await problems(page)
    bad.push(...r.bad)
    visited.add(r.surface)
    flows.add(r.flow)
    await page.waitForTimeout(100)
  }
  return { bad: [...new Set(bad)].slice(0, 10), visited, flows }
}

const robot = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot())

test('robot stands on a standable surface', async ({ page }) => {
  await walking(page)
  const r = await robot(page)
  expect(r.surface).not.toBeNull()
  const s = await page.evaluate((i) => (window as unknown as { __site: Site }).__site.surfaces()[i]!, r.surface!)
  expect(s.standable).toBe(true)
  expect(r.mode).toBe('wandering')
  expect(r.p).toBe(1)
  expect(await page.locator('#robot-layer svg path').count()).toBeGreaterThan(20)
})

test('starts at the left end of the first bio line, facing right', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  const r = await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    site.setSpeed(0)
    const r = site.robot()
    return { r, s: site.surfaces()[r.surface!]!, first: site.surfaces().find((s) => s.flow === 'bio-0' && s.line === 0)! }
  })
  expect(r.s).toEqual(r.first)
  expect(r.r.x - r.s.x0).toBeLessThan(r.r.silhouette.x1 - r.r.silhouette.x0) // within a body length of the start
  expect(r.r.x - r.r.silhouette.x0).toBeLessThan(r.r.silhouette.x1 - r.r.x) // head (the longer end) to the right
})

test('no word split and no overlap while walking', async ({ page }) => {
  await walking(page)
  const r = await watch(page, 6000)
  expect(r.bad).toEqual([])
  expect(r.visited.size).toBeGreaterThan(1) // it wanders from line to line
})

test('held still (speed 0), it sets off on no leg of its wander', async ({ page }) => {
  await walking(page)
  const moved = await page.evaluate(async () => {
    const site = (window as unknown as { __site: Site }).__site
    site.setSpeed(0)
    const out: number[] = []
    for (const s of site.surfaces().filter((s) => s.standable && s.flow.startsWith('bio')).slice(0, 8)) {
      site.place(s.id, (s.x0 + s.x1) / 2)
      const before = site.robot()
      // a few frames, which run while it wanders in view, each with no time passing
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r))
      const after = site.robot()
      if (after.x !== before.x || after.surface !== before.surface || after.hop) out.push(s.id)
    }
    return out
  })
  expect(moved).toEqual([])
})

// The old wander only hopped a line or a paragraph gap, so a Work entry was an island: left in
// the last one, which has one line to stand on at 1440px, it paced that line for good.
test('wanders out of a Work entry with one line to stand on', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the last entry has one line to stand on at 1440px')
  await walking(page)
  const r = await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    site.setSpeed(0)
    const surfaces = site.surfaces()
    const own = surfaces.filter((s) => s.standable && s.flow === 'work-2')
    window.scrollTo(0, own[0]!.y - innerHeight / 2)
    site.place(own[0]!.id, (own[0]!.x0 + own[0]!.x1) / 2)
    const seen = new Set<string>()
    for (let i = 0; i < 60 * 60; i++) {
      site.advance(1 / 60)
      const at = site.robot().surface
      if (at !== null) seen.add(surfaces[at]!.flow)
    }
    return { lines: own.length, seen: [...seen] }
  })
  expect(r.lines).toBe(1)
  expect(r.seen.filter((f) => f !== 'work-2'), 'flows it wandered to within a minute').not.toEqual([])
})

test('resize re-anchors', async ({ page }) => {
  await walking(page)
  await page.waitForTimeout(1500)
  for (const width of [1440, 390, 700, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(500)
    const r = await watch(page, 1500)
    expect(r.bad, `at ${width}`).toEqual([])
  }
})

test('walks a Work blurb at 390px without hiding a word', async ({ page }) => {
  await walking(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  // blurbs have no gutter: stand on the widest piece of a blurb line where its line above parts
  const target = await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const work = site.surfaces().filter((s) => s.standable && s.flow.startsWith('work'))
    const s = work.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0]
    if (!s) return null
    window.scrollTo(0, s.y - innerHeight / 2)
    site.place(s.id, (s.x0 + s.x1) / 2)
    return s
  })
  expect(target, 'a standable blurb piece at 390px').not.toBeNull()
  await page.waitForTimeout(200)
  const r = await watch(page, 4000)
  expect(r.bad).toEqual([])
  expect([...r.flows].some((f) => f?.startsWith('work'))).toBe(true) // it walks there (and may wander on elsewhere)
})

// Blurbs are walkable (spec), and Task 9 sends the robot to them: each needs a piece where the
// lines above can part, with a footprint (body-centre range plus one body length) of minWidth.
test('every Work blurb has somewhere to stand at 390 and 700px', async ({ page }) => {
  await walking(page)
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(500)
    const widest = await page.evaluate(() => {
      const out: Record<string, number> = {}
      for (const s of (window as unknown as { __site: Site }).__site.surfaces())
        if (s.standable) out[s.flow] = Math.max(out[s.flow] ?? 0, s.x1 - s.x0)
      return out
    })
    const body = width <= 640 ? WALKER_PX_NARROW : WALKER_PX
    for (const flow of ['work-0', 'work-1', 'work-2'])
      expect((widest[flow] ?? -Infinity) + body, `${flow} at ${width}px`).toBeGreaterThanOrEqual(body + MIN_SPAN)
  }
})

test('pauses off-screen only while wandering', async ({ page }) => {
  await walking(page)
  await page.waitForTimeout(500)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(200)
  const before = await robot(page)
  await page.waitForTimeout(1000)
  expect((await robot(page)).x).toBe(before.x)
  // and it carries on when the bio is back in view
  await page.locator('#bio').scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  expect((await robot(page)).x).not.toBe(before.x)
})

// After shot.mjs: frame-to-frame rAF intervals while the robot walks.
test('frame timing', async ({ page }) => {
  await walking(page)
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.setSpeed(1))
  await page.waitForTimeout(500)
  const t = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const t: number[] = []
        let last = performance.now()
        const end = last + 2000
        const tick = (now: number) => {
          t.push(now - last)
          last = now
          if (now < end) requestAnimationFrame(tick)
          else resolve(t)
        }
        requestAnimationFrame(tick)
      }),
  )
  t.sort((a, b) => a - b)
  const p95 = t[Math.floor(t.length * 0.95)]!
  expect(t.length).toBeGreaterThan(60)
  expect(p95).toBeLessThanOrEqual(18)
})
