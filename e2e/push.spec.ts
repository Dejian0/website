import { chromium, devices, expect, test, type CDPSession, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { HINT_READY_COARSE } from '../src/interaction/controller.ts'
import { MAX_DRAG_PX } from '../src/robot/push.ts'
import { MAX_LEFT_SHIFT } from '../src/terrain/clearance.ts'
import type { Rect, Surface } from '../src/terrain/terrain.ts'

// window.__site: dev-only hook from src/debug.ts
type Robot = {
  x: number
  y: number
  mode: string
  p: number
  surface: number | null
  silhouette: Rect
  push: { phase: string; tilt: number } | null
  hop: { from: number; to: number } | null
}
type Site = {
  robot(): Robot
  surfaces(): Surface[]
  setSpeed(mult: number): void
  parting(): { hidden: number; maxLeftShift: number }
  place(surface: number, x: number): void
  send(x: number, y: number): void
  flick(dx: number, dy: number, ms: number): void
  advance(seconds: number): void
}
const robot = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot())
const setSpeed = (page: Page, mult: number) => page.evaluate((m) => (window as unknown as { __site: Site }).__site.setSpeed(m), mult)
const svg = (page: Page) => page.locator('#robot-layer svg')
const hint = (page: Page) => page.locator('#robot-hint')
const DT = 1 / 60 // s of the robot's own time per measured frame

/** Scrolls to y and waits for the robot to have followed (it draws on the next frame). */
async function scrollAndFollow(page: Page, y: number) {
  return page.evaluate(async (y) => {
    window.scrollTo(0, y)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return (window as unknown as { __site: Site }).__site.robot().p
  }, y)
}

/** Loaded and painted, scrolled to just where the transition ends (p = 1), the robot held still (setSpeed(0)). */
async function standing(page: Page): Promise<number> {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  await setSpeed(page, 0)
  const p = await scrollAndFollow(page, 10)
  const end = p >= 1 ? 10 : Math.ceil(10 / p) + 1 // p is linear in scrollY from 0
  expect(await scrollAndFollow(page, end)).toBe(1)
  return end
}

/** The middle of the robot's silhouette, viewport px. */
async function robotPoint(page: Page) {
  const s = (await robot(page)).silhouette
  return page.evaluate((s) => ({ x: (s.x0 + s.x1) / 2 - scrollX, y: (s.y0 + s.y1) / 2 - scrollY }), s)
}

/** It stands on a line it can stand on, at a body-centre x inside that piece, and is a walker again. */
async function standsOnALine(page: Page) {
  const r = await robot(page)
  expect(r.push).toBeNull()
  expect(r.mode).not.toBe('pushed')
  const s = (await page.evaluate(() => (window as unknown as { __site: Site }).__site.surfaces()))[r.surface!]!
  expect(s.standable).toBe(true)
  expect(r.y).toBeCloseTo(s.y, 6)
  expect(r.x).toBeGreaterThanOrEqual(s.x0)
  expect(r.x).toBeLessThanOrEqual(s.x1)
}

/** No word was ever hidden, no line's start moved left past the cap, and the page never scrolls sideways. */
async function textIsSound(page: Page) {
  const r = await page.evaluate(() => ({
    parting: (window as unknown as { __site: Site }).__site.parting(),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(r.parting.hidden).toBe(0)
  expect(r.parting.maxLeftShift).toBeLessThanOrEqual(MAX_LEFT_SHIFT + 1e-9)
  expect(r.overflow).toBe(0)
}

/** Words hidden right now (a parting that couldn't show them). */
const hiddenWords = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.flow-paint > span')].filter((s) => s.style.visibility === 'hidden').length)

test('drag and recover', async ({ page }) => {
  await standing(page)
  await setSpeed(page, 1) // real time, the frame loop driving it
  const at = await robotPoint(page)
  const before = await robot(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 25, at.y, { steps: 3 })
  await page.waitForTimeout(150) // held: the body follows the pointer, held back by the spring
  const held = await robot(page)
  expect(held.mode).toBe('pushed')
  expect(held.push?.phase).toBe('dragging')
  expect(held.x - before.x).toBeGreaterThan(8)
  expect(Math.hypot(held.x - before.x, held.y - before.y)).toBeLessThanOrEqual(MAX_DRAG_PX + 1)
  await expect(svg(page)).toHaveCSS('cursor', 'grabbing')
  await expect(hint(page)).toBeHidden()
  // and on to 50px in all, let go fast: it is flung, recovers, and wanders on
  await page.mouse.move(at.x + 50, at.y, { steps: 2 })
  await page.mouse.up()
  const run = await page.evaluate(
    () =>
      new Promise<{ ms: number; phases: string[]; hidden: number }>((resolve) => {
        const site = (window as unknown as { __site: Site }).__site
        const start = performance.now()
        const out = { ms: 0, phases: [] as string[], hidden: 0 }
        const tick = (now: number) => {
          const r = site.robot()
          const phase = r.push?.phase ?? r.mode
          if (out.phases.at(-1) !== phase) out.phases.push(phase)
          out.hidden = Math.max(out.hidden, [...document.querySelectorAll<HTMLElement>('.flow-paint > span')].filter((s) => s.style.visibility === 'hidden').length)
          out.ms = now - start
          if ((!r.push && r.mode !== 'pushed') || out.ms > 4000) resolve(out)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  expect(run.ms).toBeLessThan(4000)
  expect(run.phases).toContain('recovering')
  expect(run.phases.at(-1)).toBe('wandering')
  expect(run.hidden).toBe(0)
  await standsOnALine(page)
  await expect(svg(page)).toHaveCSS('cursor', 'pointer')
  await textIsSound(page)
})

test('only in the text can it be pushed', async ({ page }) => {
  await standing(page)
  expect(await scrollAndFollow(page, 0)).toBe(0)
  const box = (await svg(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 5 })
  expect(await robot(page)).toMatchObject({ mode: 'wandering', push: null })
  await page.mouse.up()
  expect(await robot(page)).toMatchObject({ mode: 'wandering', push: null })
})

/** One frame of the robot's own time, and what it and the text are doing then. */
const frame = (page: Page) =>
  page.evaluate((dt) => {
    const site = (window as unknown as { __site: Site }).__site
    site.advance(dt)
    const r = site.robot()
    const hidden = [...document.querySelectorAll<HTMLElement>('.flow-paint > span')].filter((s) => s.style.visibility === 'hidden').length
    return { ...r, on: r.surface === null ? null : site.surfaces()[r.surface]!, hidden }
  }, DT)

/** Where the robot's silhouette and a painted word's box overlap on screen (viewport px), if they do. */
const overWords = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __site: Site }).__site.robot().silhouette
    for (const span of document.querySelectorAll('.flow-paint > span:not([hidden])')) {
      const b = span.getBoundingClientRect()
      const x0 = Math.max(b.left, s.x0 - scrollX)
      const y0 = Math.max(b.top, s.y0 - scrollY)
      const x1 = Math.min(b.right, s.x1 - scrollX)
      const y1 = Math.min(b.bottom, s.y1 - scrollY)
      if (x1 - x0 > 8 && y1 - y0 > 8 && y0 >= 0 && y1 <= innerHeight) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    }
    return null
  })

const lum = (png: PNG, i: number) => 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!

/**
 * The robot as drawn over `clip`, and the same without it: how many pixels are ink (dark) without
 * it, and how many it makes lighter. Words in front of it, it can only ever darken a pixel.
 */
async function inkUnder(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const shown = PNG.sync.read(await page.screenshot({ clip }))
  await svg(page).evaluate((e) => ((e as SVGElement).style.visibility = 'hidden'))
  const bare = PNG.sync.read(await page.screenshot({ clip }))
  await svg(page).evaluate((e) => ((e as SVGElement).style.visibility = ''))
  let ink = 0
  let lighter = 0
  for (let i = 0; i < bare.data.length; i += 4) {
    if (lum(bare, i) < 110) ink++
    if (lum(shown, i) > lum(bare, i) + 8) lighter++
  }
  return { ink, lighter }
}

test('a flick, frame by frame: legs splay, the body tilts, it lands on a clear spot and stands, every word shown and in front', async ({ page }) => {
  await standing(page)
  // mid-paragraph, the lines above it parted round it, then flicked up and to the right
  await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const s = site.surfaces().filter((q) => q.flow === 'bio-1' && q.standable)[1]!
    site.place(s.id, (s.x0 + s.x1) / 2)
    window.scrollTo(0, site.robot().y - innerHeight / 2)
  })
  expect(await scrollAndFollow(page, await page.evaluate(() => scrollY))).toBe(1)
  const before = await robot(page)
  const wide = before.silhouette.x1 - before.silhouette.x0
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.flick(30, -40, 60))
  const phases: string[] = []
  let splay = 0
  let tilt = 0
  let checked = 0
  let prev = await robot(page)
  for (let i = 0; i < 4 / DT; i++) {
    const r = await frame(page)
    const phase = r.push?.phase ?? r.mode
    if (phases.at(-1) !== phase) phases.push(phase)
    expect(r.hidden, `frame ${i}`).toBe(0)
    if (r.push?.phase === 'flying') splay = Math.max(splay, r.silhouette.x1 - r.silhouette.x0 - wide)
    tilt = Math.max(tilt, Math.abs(r.push?.tilt ?? 0))
    // never at rest in the air: wherever it stays put it stands on a line it can stand on
    if (Math.hypot(r.x - prev.x, r.y - prev.y) < 0.01) {
      expect(r.on?.standable, `still at ${r.x.toFixed(1)},${r.y.toFixed(1)} in frame ${i}`).toBe(true)
      expect(r.y).toBeCloseTo(r.on!.y, 6)
    }
    // where it is behind words in the air, they show over it
    if (r.push?.phase === 'flying' && checked < 2) {
      const clip = await overWords(page)
      if (clip) {
        const { ink, lighter } = await inkUnder(page, clip)
        if (ink > 20) {
          expect(lighter, `frame ${i}: pixels the robot lightened of ${ink} ink`).toBe(0)
          checked++
        }
      }
    }
    prev = r
    if (!r.push && r.mode !== 'pushed') break
  }
  expect(phases.slice(0, 2)).toEqual(['flying', 'recovering'])
  expect(phases.at(-1)).toBe('wandering')
  expect(checked).toBeGreaterThan(0) // it did pass behind words
  expect(splay).toBeGreaterThan(6) // feet out wider than it stands
  expect(tilt).toBeGreaterThan(0.1)
  await standsOnALine(page)
  await textIsSound(page)
})

test('a trip goes on after a push, from where the robot lands', async ({ page }) => {
  await standing(page)
  await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const s = site.surfaces().filter((q) => q.flow === 'work-1' && q.standable)[0]!
    site.send((s.x0 + s.x1) / 2, s.y)
    site.advance(0.5)
    site.flick(-30, -40, 60)
  })
  const r = await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    const modes: string[] = []
    for (let i = 0; i < 40 * 60 && site.robot().mode !== 'arrived'; i++) {
      site.advance(1 / 60)
      const m = site.robot().mode
      if (modes.at(-1) !== m) modes.push(m)
    }
    const at = site.robot()
    return { modes, flow: at.surface === null ? null : site.surfaces()[at.surface]!.flow }
  })
  expect(r.modes).toEqual(['pushed', 'walking', 'arrived'])
  expect(r.flow).toBe('work-1')
  await textIsSound(page)
})

// --- touch ---

test('tap robot shows Tap anywhere', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'touch')
  await standing(page)
  // the robot alone takes the touch over, and only while it stands in the text
  expect(await svg(page).evaluate((e) => getComputedStyle(e).touchAction)).toBe('none')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.flow-paint > span')!).touchAction)).toBe('auto')
  const at = await robotPoint(page)
  await page.touchscreen.tap(at.x, at.y)
  await expect(hint(page)).toHaveText(HINT_READY_COARSE)
  expect((await robot(page)).mode).toBe('ready')
  expect(await scrollAndFollow(page, 0)).toBe(0)
  expect(await svg(page).evaluate((e) => getComputedStyle(e).touchAction)).toBe('auto')
})

/**
 * A finger from `from` to `to` (viewport px) in `steps` moves, as the browser's own touch input
 * (CDP), held still a moment before it lifts so a scroll it makes doesn't fling on.
 */
async function swipe(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }] })
  }
  await page.waitForTimeout(150)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** Waits until the page has stopped scrolling; returns where it is. */
async function settled(page: Page): Promise<number> {
  let y = await page.evaluate(() => window.scrollY)
  for (;;) {
    await page.waitForTimeout(100)
    const now = await page.evaluate(() => window.scrollY)
    if (now === y) return now
    y = now
  }
}

/** A bio word on screen well away from the robot, viewport px. */
const wordAwayFromRobot = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __site: Site }).__site.robot().silhouette
    for (const span of document.querySelectorAll('#bio .flow-paint > span:not([hidden])')) {
      const b = span.getBoundingClientRect()
      const far = b.top + scrollY > s.y1 + 80 || b.bottom + scrollY < s.y0 - 80
      if (far && b.top > 150 && b.bottom < innerHeight - 50 && b.width > 20) return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return null
  })

// WebKit (the mobile project) takes no touch move from Playwright, so the swipes run in Chromium
// with the same phone's metrics and touch, through its own touch input: a swipe there scrolls
// natively and keeps to touch-action, as on a phone.
test('touch: a swipe elsewhere scrolls, a drag on the robot pushes it and does not, and assistive tech still gets through', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'touch')
  const { defaultBrowserType: _, ...phone } = devices['iPhone 13']
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ ...phone, baseURL: testInfo.project.use.baseURL ?? 'http://localhost:5180' })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const scrollY = () => page.evaluate(() => window.scrollY)
    const activate = () => svg(page).dispatchEvent('click') // a click with no press: detail 0, as a screen reader's

    // the hero robot is not a button: a swipe that starts on it scrolls the page
    const end = await standing(page)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    const box = (await svg(page).boundingBox())!
    await swipe(page, cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y + box.height / 2 - 150 })
    expect(await settled(page)).toBeGreaterThan(50)

    // touch scroll elsewhere: from a bio word that is not the robot
    expect(await scrollAndFollow(page, end)).toBe(1)
    await setSpeed(page, 1)
    const word = (await wordAwayFromRobot(page))!
    expect(word).not.toBeNull()
    const y0 = await scrollY()
    await swipe(page, cdp, word, { x: word.x, y: word.y - 200 })
    expect(await settled(page)).toBeGreaterThan(y0 + 50)

    // touch drag on robot does not scroll: it pushes the robot
    expect(await scrollAndFollow(page, end)).toBe(1)
    expect(await settled(page)).toBe(end)
    const at = await robotPoint(page)
    await swipe(page, cdp, at, { x: at.x + 40, y: at.y - 60 })
    expect((await robot(page)).mode).toBe('pushed')
    expect(await scrollY()).toBe(end)
    await expect.poll(async () => (await robot(page)).mode, { timeout: 4000 }).toBe('wandering')
    expect(await scrollY()).toBe(end)
    // it wanders on at once, perhaps already hopping to another line: held still, that hop lands
    await setSpeed(page, 0)
    await page.evaluate(() => {
      const site = (window as unknown as { __site: Site }).__site
      for (let i = 0; i < 600 && site.robot().hop; i++) site.advance(1 / 60)
    })
    await standsOnALine(page)

    // a press that ended with no click (that drag, or the swipe on the hero) doesn't swallow the next activation
    await activate()
    expect((await robot(page)).mode).toBe('ready')
    await expect(hint(page)).toHaveText(HINT_READY_COARSE)
    await textIsSound(page)
  } finally {
    await browser.close()
  }
})

/** Runs the robot's own time 1/60 s at a time until the push is over (at most `seconds`); returns how long it took. */
const recover = (page: Page, seconds = 6) =>
  page.evaluate((seconds) => {
    const site = (window as unknown as { __site: Site }).__site
    let t = 0
    for (; t < seconds && (site.robot().push || site.robot().mode === 'pushed'); t += 1 / 60) site.advance(1 / 60)
    return t
  }, seconds)

test('scrolled back to the top mid-push, it waits there and carries on with the same push', async ({ page }) => {
  const end = await standing(page)
  await page.evaluate(() => {
    const site = (window as unknown as { __site: Site }).__site
    site.flick(30, -40, 60)
    for (let i = 0; i < 9; i++) site.advance(1 / 60)
  })
  const mid = await robot(page)
  expect(mid.push?.phase).toBe('flying')
  expect(await scrollAndFollow(page, 0)).toBe(0)
  await setSpeed(page, 1)
  await page.waitForTimeout(300) // the frame loop holds it at p < 1
  await setSpeed(page, 0)
  expect(await robot(page)).toMatchObject({ x: mid.x, y: mid.y, push: { phase: 'flying', tilt: mid.push!.tilt } })
  expect(await scrollAndFollow(page, end)).toBe(1)
  expect(await recover(page)).toBeLessThan(4)
  await standsOnALine(page)
  await textIsSound(page)
})

/** Scrolls down to where the transition ends at this layout (p = 1); returns that scrollY. */
async function toTheText(page: Page): Promise<number> {
  const p = await scrollAndFollow(page, 10)
  const end = p >= 1 ? 10 : Math.ceil(10 / p) + 1 // p is linear in scrollY from 0
  expect(await scrollAndFollow(page, end)).toBe(1)
  return end
}

test('pushed where a trip left it, at the end of a line, it lands back on that line', async ({ page }) => {
  await standing(page)
  // a bio line whose end the line below reaches past: off that end is a fall to the line below
  const line = await page.evaluate(() => {
    const all = (window as unknown as { __site: Site }).__site.surfaces().filter((s) => s.standable && s.flow.startsWith('bio'))
    return all.find((a) => a.x1 - a.x0 > 100 && all.some((b) => b.y > a.y + 1 && b.y - a.y < 60 && b.x0 < a.x1 - 3 && b.x1 > a.x1 + 3))!
  })
  expect(line).toBeTruthy()
  // a click just past its end: the trip stops right at the end and settles there
  const r = await page.evaluate((a) => {
    const site = (window as unknown as { __site: Site }).__site
    site.send(a.x1 + 20, a.y - 4)
    for (let i = 0; i < 60 * 60 && site.robot().mode === 'walking'; i++) site.advance(1 / 60)
    return site.robot()
  }, line)
  expect(r).toMatchObject({ mode: 'arrived', surface: line.id })
  expect(r.x).toBeCloseTo(line.x1, 6)
  // up a little (well short of the line above, which it would land on), and down again
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.flick(0, -10, 100))
  expect(Math.abs((await robot(page)).x - line.x1)).toBeLessThan(1e-6) // straight up
  expect((await robot(page)).push?.phase).toBe('flying')
  expect(await recover(page)).toBeLessThan(4)
  await standsOnALine(page)
  const after = await robot(page)
  expect(after.surface).toBe(line.id)
  expect(after.x).toBeCloseTo(line.x1, 6)
  await textIsSound(page)
})

test.describe('at 390px wide', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('widened to 1440px mid-flight, the push ends where the robot stands in the new layout: it never falls on below the page', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a desktop window resized')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    // count the page's frame requests: an idle frame loop makes none
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window)
      const w = window as unknown as { frames: number }
      w.frames = 0
      window.requestAnimationFrame = (cb) => {
        w.frames++
        return raf(cb)
      }
    })
    await standing(page)
    // on the lowest place it can stand (the last line of This site's note), near the bottom of the
    // long phone-width page, flung up
    const from = await page.evaluate(() => {
      const site = (window as unknown as { __site: Site }).__site
      const s = site.surfaces().filter((q) => q.standable).at(-1)!
      site.place(s.id, (s.x0 + s.x1) / 2)
      site.flick(30, -40, 60)
      for (let i = 0; i < 9; i++) site.advance(1 / 60)
      return s.flow
    })
    expect(from).toBe('site-0')
    const before = await robot(page)
    expect(before.push?.phase).toBe('flying')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __site: Site }).__site.surfaces()[0]!.x1 - document.documentElement.clientWidth / 2)).toBeGreaterThan(0)
    // every walkable line is now above where the push had it
    const lowest = await page.evaluate(() => Math.max(...(window as unknown as { __site: Site }).__site.surfaces().map((s) => s.y)))
    expect(lowest).toBeLessThan(before.y)
    await toTheText(page)
    expect(await recover(page)).toBeLessThan(4)
    await standsOnALine(page)
    expect(await page.evaluate(() => {
      const site = (window as unknown as { __site: Site }).__site
      return site.surfaces()[site.robot().surface!]!.flow
    })).toBe(from) // where it was pushed from, in the new layout
    expect((await robot(page)).mode).toBe('wandering')
    // nothing of it below the page: the document keeps its height
    await setSpeed(page, 1)
    const height = () => page.evaluate(() => document.documentElement.scrollHeight)
    const h0 = await height()
    await page.waitForTimeout(500)
    expect(await height()).toBe(h0)
    expect((await robot(page)).silhouette.y1).toBeLessThan(h0)
    // and the frame loop goes idle: wandering in This site, which is off-screen from here
    expect(await page.evaluate(() => document.getElementById('site')!.getBoundingClientRect().top > innerHeight + 64)).toBe(true)
    await page.waitForTimeout(300)
    const f0 = await page.evaluate(() => (window as unknown as { frames: number }).frames)
    await page.waitForTimeout(500)
    expect((await page.evaluate(() => (window as unknown as { frames: number }).frames)) - f0).toBeLessThanOrEqual(2)
    await textIsSound(page)
    expect(errors).toEqual([])
  })
})
