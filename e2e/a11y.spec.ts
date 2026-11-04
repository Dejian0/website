import { expect, test, type Page } from '@playwright/test'
import { bio, contact, education, honors, site, skills, work } from '../src/content.ts'
import { HINT_IDLE, HINT_READY_COARSE, HINT_READY_FINE, ROBOT_LABEL } from '../src/interaction/controller.ts'
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
  lift: number
  hop: { from: number; to: number } | null
  push: { phase: string; tilt: number } | null
}
type Site = {
  robot(): Robot
  surfaces(): Surface[]
  setSpeed(mult: number): void
  parting(): { hidden: number; maxLeftShift: number }
  send(x: number, y: number): void
}
const robot = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot())
const surfaces = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.surfaces())
const setSpeed = (page: Page, mult: number) => page.evaluate((m) => (window as unknown as { __site: Site }).__site.setSpeed(m), mult)
const svg = (page: Page) => page.locator('#robot-layer svg')
const button = (page: Page) => page.getByRole('button', { name: ROBOT_LABEL, exact: true })
const hint = (page: Page) => page.locator('#robot-hint')
const readyText = (page: Page) =>
  page.evaluate(() => matchMedia('(pointer: coarse)').matches).then((c) => (c ? HINT_READY_COARSE : HINT_READY_FINE))

function noErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

async function booted(page: Page) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
}

/** Scrolls to y and waits for the robot to have followed (it draws on the next frame). */
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
  return p >= 1 ? probe : probe / p
}

/** The live robot is drawn at full opacity (any fade is over). */
const settled = (page: Page) => expect(svg(page)).toHaveCSS('opacity', '1')

/** Loaded and painted, scrolled to where the transition ends (p = 1), the robot shown in the text. */
async function inText(page: Page): Promise<number> {
  await booted(page)
  const end = Math.ceil(await transitionEnd(page)) + 1
  expect(await scrollAndFollow(page, end)).toBe(1)
  await settled(page)
  return end
}

/** The middle of the robot's silhouette, viewport px. */
async function robotPoint(page: Page) {
  const s = (await robot(page)).silhouette
  return page.evaluate((s) => ({ x: (s.x0 + s.x1) / 2 - scrollX, y: (s.y0 + s.y1) / 2 - scrollY }), s)
}

async function clickRobot(page: Page) {
  const at = await robotPoint(page)
  await page.mouse.click(at.x, at.y)
}

/** Robots that can be seen: the static hero drawing and the live robot, shown, with any opacity. */
const visibleRobots = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<SVGSVGElement>('#robot-static, #robot-layer svg')].filter((e) => {
        const cs = getComputedStyle(e)
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && e.getBoundingClientRect().width > 0
      }).length,
  )

/** The section the live robot is drawn in: the one holding the bottom middle of its drawing (its feet). */
const drawnIn = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('#robot-layer svg')!.getBoundingClientRect()
    const [x, y] = [r.left + r.width / 2, r.bottom - 3]
    for (const id of ['hero', 'bio']) {
      const b = document.getElementById(id)!.getBoundingClientRect()
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return id
    }
    return null
  })

/**
 * Scrolls to y and watches every frame until the robot is back at full opacity after a fade:
 * how long that took, where it was drawn whenever it could be seen (in order, repeats dropped),
 * and the most robots seen at once.
 */
function fadeTo(page: Page, y: number) {
  return page.evaluate(
    (y) =>
      new Promise<{ ms: number; places: (string | null)[]; most: number; p: number; dipped: boolean }>((resolve) => {
        const live = document.querySelector<SVGSVGElement>('#robot-layer svg')!
        const robots = [...document.querySelectorAll<SVGSVGElement>('#robot-static, #robot-layer svg')]
        const where = () => {
          const r = live.getBoundingClientRect()
          const [x, by] = [r.left + r.width / 2, r.bottom - 3]
          for (const id of ['hero', 'bio']) {
            const b = document.getElementById(id)!.getBoundingClientRect()
            if (x >= b.left && x <= b.right && by >= b.top && by <= b.bottom) return id
          }
          return null
        }
        const out = { ms: 0, places: [] as (string | null)[], most: 0, p: 0, dipped: false }
        const t0 = performance.now()
        window.scrollTo(0, y)
        const frame = () => {
          const opacity = Number(getComputedStyle(live).opacity)
          const seen = robots.filter((e) => {
            const cs = getComputedStyle(e)
            return cs.visibility !== 'hidden' && Number(cs.opacity) > 0
          }).length
          out.most = Math.max(out.most, seen)
          if (opacity > 0 && out.places.at(-1) !== where()) out.places.push(where())
          out.dipped ||= opacity < 1
          out.ms = performance.now() - t0
          if ((out.dipped && opacity === 1) || out.ms > 1500) {
            out.p = (window as unknown as { __site: Site }).__site.robot().p
            resolve(out)
          } else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
    y,
  )
}

/** What the robot looks like and where, every `every` ms for `ms`: its ground point, its transform and its drawing. */
function samples(page: Page, ms = 2000, every = 100) {
  return page.evaluate(
    ({ ms, every }) =>
      new Promise<string[]>((resolve) => {
        const site = (window as unknown as { __site: Site }).__site
        const el = document.querySelector<SVGSVGElement>('#robot-layer svg')!
        const out: string[] = []
        const take = () => {
          const r = site.robot()
          const d = [...el.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|')
          out.push(JSON.stringify([r.x, r.y, el.style.transform, el.style.opacity, d]))
        }
        take()
        const id = setInterval(() => {
          take()
          if (out.length > ms / every) {
            clearInterval(id)
            resolve(out)
          }
        }, every)
      }),
    { ms, every },
  )
}

/** Frames asked for (requestAnimationFrame calls) over `ms` of real time. */
const framesIn = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const raf = window.requestAnimationFrame
    let n = 0
    window.requestAnimationFrame = (cb) => {
      n++
      return raf.call(window, cb)
    }
    await new Promise((r) => setTimeout(r, ms))
    window.requestAnimationFrame = raf
    return n
  }, ms)

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

/**
 * Painted words whose glyph band (glyph tops to line bottom, as terrain-wiring.ts measures a
 * line's text) overlaps the robot's silhouette: the text has not parted around where it stands.
 */
const wordsOverRobot = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __site: Site }).__site.robot().silhouette
    let n = 0
    for (const span of document.querySelectorAll<HTMLElement>('.flow-paint > span:not([hidden])')) {
      if (span.style.visibility === 'hidden') continue
      const cs = getComputedStyle(span.parentElement!)
      const size = parseFloat(cs.fontSize)
      const lh = parseFloat(cs.lineHeight)
      const b = span.getBoundingClientRect()
      const top = b.top + scrollY + 0.5 * (lh - size) + 0.13 * size
      const bottom = b.top + scrollY + lh
      const x0 = b.left + scrollX
      const x1 = b.right + scrollX
      if (Math.min(x1, s.x1) - Math.max(x0, s.x0) > 0.5 && Math.min(bottom, s.y1) - Math.max(top, s.y0) > 0.5) n++
    }
    return n
  })

/** It stands on a line it can stand on, feet down, at a body-centre x inside that piece. */
async function standsOnALine(page: Page) {
  const r = await robot(page)
  expect(r.push).toBeNull()
  expect(r.hop).toBeNull()
  expect(r.lift).toBeLessThan(0.01)
  const s = (await surfaces(page))[r.surface!]!
  expect(s.standable).toBe(true)
  expect(r.y).toBeCloseTo(s.y, 6)
  expect(r.x).toBeGreaterThanOrEqual(s.x0)
  expect(r.x).toBeLessThanOrEqual(s.x1)
}

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('no continuous motion', async ({ page }) => {
    const errors = noErrors(page)
    await booted(page)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    const top = await samples(page)
    expect(new Set(top).size).toBe(1)
    await inText(page)
    await page.locator('#bio').scrollIntoViewIfNeeded()
    expect((await robot(page)).mode).toBe('wandering')
    const inBio = await samples(page)
    expect(new Set(inBio).size).toBe(1)
    await standsOnALine(page)
    expect(errors).toEqual([])
  })

  test('no frames while it stands still, in the hero, in the text, and waiting in ready mode', async ({ page }) => {
    await booted(page)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    await settled(page)
    expect(await framesIn(page, 1000)).toBeLessThanOrEqual(2)
    await inText(page)
    expect(await framesIn(page, 1000)).toBeLessThanOrEqual(2)
    await clickRobot(page)
    await expect(hint(page)).toHaveText(await readyText(page))
    const t0 = Date.now()
    expect(await framesIn(page, 1000)).toBeLessThanOrEqual(2)
    // the wait in ready mode still times out with no frames running
    await page.waitForTimeout(Math.max(0, 8300 - (Date.now() - t0)))
    await expect(hint(page)).toHaveText(HINT_IDLE)
    expect((await robot(page)).mode).toBe('wandering')
    // (the count is real: with motion allowed the robot wanders, a frame each time)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await framesIn(page, 1000)).toBeGreaterThan(20)
  })

  test('hero or text, never both', async ({ page }) => {
    const errors = noErrors(page)
    await booted(page)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    await settled(page)
    expect(await drawnIn(page)).toBe('hero')
    expect(await visibleRobots(page)).toBe(1)
    await expect(page.locator('#robot-static')).toHaveCSS('visibility', 'hidden') // it keeps its box: the hero doesn't move
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
    const end = await transitionEnd(page)

    // past the midpoint it fades out of the hero and into the text, never seen between or in both
    const down = await fadeTo(page, Math.round(0.6 * end))
    expect(down.p).toBeGreaterThan(0.5)
    expect(down.p).toBeLessThan(1)
    expect(down.places).toEqual(['hero', 'bio'])
    expect(down.most).toBe(1)
    expect(down.ms).toBeLessThanOrEqual(250)
    expect(await drawnIn(page)).toBe('bio')
    expect(await visibleRobots(page)).toBe(1)
    await standsOnALine(page)
    expect(await wordsOverRobot(page)).toBe(0)
    await expect(button(page)).not.toHaveAttribute('aria-disabled', /.*/) // it stands in the text: a button now
    await expect(hint(page)).toBeVisible()

    // scrolled back past it, the same fade the other way
    const up = await fadeTo(page, Math.round(0.4 * end))
    expect(up.p).toBeLessThan(0.5)
    expect(up.places).toEqual(['bio', 'hero'])
    expect(up.most).toBe(1)
    expect(up.ms).toBeLessThanOrEqual(250)
    expect(await visibleRobots(page)).toBe(1)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(hint(page)).toBeHidden()
    await textIsSound(page)
    expect(errors).toEqual([])
  })

  test('click-to-go fades', async ({ page }) => {
    const errors = noErrors(page)
    await inText(page)
    await clickRobot(page)
    await expect(hint(page)).toHaveText(await readyText(page))
    expect((await robot(page)).mode).toBe('ready')
    const from = await robot(page)

    // every frame from the click on: where the robot is, how it is drawn, and whether a path shows
    await page.evaluate(() => {
      const w = window as unknown as { trace: { t: number; x: number; y: number; surface: number | null; mode: string; opacity: number; path: boolean }[] }
      w.trace = []
      window.addEventListener(
        'click',
        () => {
          const t0 = performance.now()
          const site = (window as unknown as { __site: Site }).__site
          const el = document.querySelector<SVGSVGElement>('#robot-layer svg')!
          const path = document.getElementById('robot-path')!
          const frame = () => {
            const r = site.robot()
            const t = performance.now() - t0
            w.trace.push({ t, x: r.x, y: r.y, surface: r.surface, mode: r.mode, opacity: Number(getComputedStyle(el).opacity), path: path.style.display !== 'none' })
            if (t < 700) requestAnimationFrame(frame)
          }
          frame()
        },
        { capture: true, once: true },
      )
    })
    // p.blurb is a 1px sr-only box once painted: click the middle of its painted layer
    await page.locator('p.blurb[data-flow="work-1"] + .flow-paint').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { trace: { t: number }[] }).trace.at(-1)?.t ?? 0)).toBeGreaterThanOrEqual(700)
    const trace = await page.evaluate(() => (window as unknown as { trace: { t: number; x: number; y: number; surface: number | null; mode: string; opacity: number; path: boolean }[] }).trace)
    const to = trace.at(-1)!
    const all = await surfaces(page)
    expect(all[to.surface!]!.flow).toBe('work-1')
    expect(to.mode).toBe('arrived')
    // only ever where it was or where it went: no position between
    for (const f of trace) expect([`${from.x} ${from.y}`, `${to.x} ${to.y}`]).toContain(`${f.x} ${f.y}`)
    const there = trace.find((f) => f.x === to.x && f.y === to.y)!
    expect(there.t).toBeLessThanOrEqual(400)
    // it faded out and back in, fully shown again within 400ms, and no path was drawn
    expect(Math.min(...trace.map((f) => f.opacity))).toBeLessThan(0.5)
    expect(trace.find((f) => f.t > there.t && f.opacity === 1)!.t).toBeLessThanOrEqual(400)
    expect(trace.every((f) => !f.path)).toBe(true)
    // where it was, it was on its way (fading out), once the click was taken (the first sample comes before)
    expect(trace.slice(1).filter((f) => f.x === from.x && f.y === from.y).every((f) => f.mode === 'walking')).toBe(true)

    await standsOnALine(page)
    expect(await wordsOverRobot(page)).toBe(0) // the text parted around where it now stands
    await textIsSound(page)
    await expect(hint(page)).toBeHidden() // sent somewhere once: the hint is gone for good
    expect(errors).toEqual([])
  })

  test('push disabled', async ({ page }) => {
    const errors = noErrors(page)
    await inText(page)
    const before = await robot(page)
    const transform = await svg(page).evaluate((e) => (e as SVGElement).style.transform)
    const at = await robotPoint(page)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 50, at.y - 20, { steps: 6 })
    await page.waitForTimeout(200)
    const held = await robot(page)
    expect(held).toMatchObject({ x: before.x, y: before.y, mode: 'wandering', push: null })
    await page.mouse.up()
    await page.waitForTimeout(200)
    expect(await robot(page)).toMatchObject({ x: before.x, y: before.y, mode: 'wandering', push: null })
    expect(await svg(page).evaluate((e) => (e as SVGElement).style.transform)).toBe(transform)
    await expect(hint(page)).toHaveText(HINT_IDLE) // a drag is not a click either
    // a click still gets it ready
    await clickRobot(page)
    expect((await robot(page)).mode).toBe('ready')
    expect(errors).toEqual([])
  })
})

test.describe('keyboard and screen readers', () => {
  test('keyboard', async ({ page }) => {
    await inText(page)
    await setSpeed(page, 0)
    // Tab reaches the robot (after the page's links)
    let focused = false
    for (let i = 0; i < 30 && !focused; i++) {
      await page.keyboard.press('Tab')
      focused = await svg(page).evaluate((e) => e === document.activeElement)
    }
    expect(focused).toBe(true)
    await expect(page.locator(':focus')).toHaveAccessibleName(ROBOT_LABEL)
    await expect(page.locator(':focus')).toHaveRole('button')
    expect((await robot(page)).p).toBe(1)
    await expect(hint(page)).toHaveText(HINT_IDLE)
    await page.keyboard.press('Enter')
    await expect(hint(page)).toHaveText(await readyText(page))
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await expect(hint(page)).toHaveText(HINT_IDLE)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
  })

  test('a held Enter or Space toggles ready once, not at the key-repeat rate', async ({ page }) => {
    await inText(page)
    await setSpeed(page, 0)
    await button(page).focus()
    for (const key of ['Enter', ' ']) {
      await page.keyboard.down(key)
      expect((await robot(page)).mode).toBe('ready')
      for (let i = 0; i < 5; i++) await page.keyboard.down(key) // auto-repeat: repeat is true
      expect((await robot(page)).mode).toBe('ready')
      await page.keyboard.up(key)
      expect((await robot(page)).mode).toBe('ready')
      await page.keyboard.press(key) // a fresh press toggles it back
      expect((await robot(page)).mode).toBe('wandering')
    }
    // and a held Space never scrolls the page
    const y = await page.evaluate(() => scrollY)
    await page.keyboard.down(' ')
    for (let i = 0; i < 5; i++) await page.keyboard.down(' ')
    await page.keyboard.up(' ')
    expect(await page.evaluate(() => scrollY)).toBe(y)
  })

  test('the robot is an inert button until it stands in the text: aria-disabled', async ({ page }) => {
    await booted(page)
    await setSpeed(page, 0)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
    await button(page).focus()
    await page.keyboard.press('Enter')
    expect((await robot(page)).mode).toBe('wandering') // inert, as it says
    const end = Math.ceil(await transitionEnd(page)) + 1
    expect(await scrollAndFollow(page, Math.round(end * 0.9))).toBeLessThan(1)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
    expect(await scrollAndFollow(page, end)).toBe(1)
    await expect(button(page)).not.toHaveAttribute('aria-disabled', /.*/)
    await button(page).focus()
    await page.keyboard.press('Enter')
    expect((await robot(page)).mode).toBe('ready')
    expect(await scrollAndFollow(page, 0)).toBe(0)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
  })

  test('screen reader text', async ({ page }) => {
    await booted(page)
    const lists = [...education.flatMap((e) => [e.school, e.detail, e.dates]), ...honors.flatMap((h) => [h.org, h.detail, ...(h.dates ? [h.dates] : [])]), ...skills]
    const notes = [contact, site.note]
    const texts = [...bio, ...work.map((w) => w.blurb), ...lists, ...notes]
    const counts = await page.evaluate((texts) => {
      const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim()
      const exposed = (e: Element) => !e.closest('[aria-hidden="true"]') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'
      const all = [...document.body.querySelectorAll('*')]
      // the innermost elements holding each text whole, that assistive tech is shown
      return texts.map((t) => all.filter((e) => norm(e.textContent) === norm(t) && exposed(e) && ![...e.children].some((c) => norm(c.textContent) === norm(t))).length)
    }, texts)
    // once each: as often as the page has it (two Honors rows are dated 2024)
    expect(counts).toEqual(texts.map((t) => texts.filter((u) => u === t).length))
    // the source paragraphs are what is exposed: one per bio paragraph and work blurb
    expect(await page.locator('#bio p[data-flow]:not([aria-hidden])').count()).toBe(bio.length)
    expect(await page.locator('p.blurb[data-flow]:not([aria-hidden])').count()).toBe(work.length)
    // and every painted word is hidden from it, in a hidden layer
    const painted = await page.evaluate(() => ({
      spans: document.querySelectorAll('.flow-paint span').length,
      hidden: document.querySelectorAll('.flow-paint span[aria-hidden="true"]').length,
      layers: document.querySelectorAll('.flow-paint').length,
      hiddenLayers: document.querySelectorAll('.flow-paint[aria-hidden="true"]').length,
    }))
    expect(painted.spans).toBeGreaterThan(50)
    expect(painted.hidden).toBe(painted.spans)
    expect(painted.hiddenLayers).toBe(painted.layers)
    expect(painted.layers).toBe(bio.length + work.length + lists.length + notes.length)
    // the robot's drawing, hint and path say nothing beyond the button's name
    expect(await page.locator('#robot-layer svg path:not([aria-hidden="true"])').count()).toBe(0)
    await expect(hint(page)).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('#robot-path')).toHaveAttribute('aria-hidden', 'true')
  })
})

test.describe('the preference changing mid-session', () => {
  test('turned on mid-trip it stands still where it is; turned off it wanders on', async ({ page }) => {
    const errors = noErrors(page)
    await inText(page)
    await setSpeed(page, 0)
    // a trip along the line it stands on: it walks there
    const r0 = await robot(page)
    const line = (await surfaces(page))[r0.surface!]!
    await page.evaluate(({ x, y }) => (window as unknown as { __site: Site }).__site.send(x, y), { x: line.x1, y: line.y })
    await setSpeed(page, 1)
    await expect.poll(async () => (await robot(page)).lift, { timeout: 5000 }).toBeGreaterThan(1) // mid-stride, a foot up
    const walking = await robot(page)
    expect(walking.mode).toBe('walking')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(async () => (await robot(page)).mode).toBe('wandering')
    await standsOnALine(page) // feet down
    const stood = await robot(page)
    expect(stood.surface).toBe(walking.surface)
    expect(Math.abs(stood.x - walking.x)).toBeLessThan(3) // where it was
    await expect(page.locator('#robot-path')).toBeHidden()
    await settled(page)
    expect(new Set(await samples(page, 1000)).size).toBe(1)
    expect(await framesIn(page, 1000)).toBeLessThanOrEqual(2)
    expect(await wordsOverRobot(page)).toBe(0)
    await textIsSound(page)

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const x = (await robot(page)).x
    await expect.poll(async () => (await robot(page)).x, { timeout: 5000 }).not.toBe(x)
    expect(errors).toEqual([])
  })

  test('turned on mid-hop it stands where it would have landed', async ({ page }) => {
    const errors = noErrors(page)
    await inText(page)
    await setSpeed(page, 0)
    const to = (await surfaces(page)).find((s) => s.flow === 'work-2' && s.standable)!
    await page.evaluate(({ x, y }) => (window as unknown as { __site: Site }).__site.send(x, y), { x: (to.x0 + to.x1) / 2, y: to.y })
    await setSpeed(page, 1)
    await expect.poll(async () => (await robot(page)).hop, { timeout: 5000 }).not.toBeNull() // stepping down a line: in the air
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(async () => (await robot(page)).mode).toBe('wandering')
    await standsOnALine(page) // landed, feet down, on a line it can stand on
    expect(new Set(await samples(page, 1000)).size).toBe(1)
    expect(await wordsOverRobot(page)).toBe(0)
    await textIsSound(page)
    expect(errors).toEqual([])
  })

  test('turned on mid-push, the push ends and it stands on a line', async ({ page }) => {
    const errors = noErrors(page)
    await inText(page)
    await setSpeed(page, 1)
    const at = await robotPoint(page)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 30, at.y - 10, { steps: 4 })
    expect((await robot(page)).mode).toBe('pushed')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(async () => (await robot(page)).mode).toBe('wandering')
    await standsOnALine(page)
    const still = await robot(page)
    await page.mouse.move(at.x + 60, at.y - 20, { steps: 4 })
    await page.mouse.up()
    expect(await robot(page)).toMatchObject({ x: still.x, y: still.y, mode: 'wandering', push: null })
    expect(await wordsOverRobot(page)).toBe(0)
    await textIsSound(page)
    expect(errors).toEqual([])
  })

  test('turned on mid-transition it shows in the hero or the text, and turned off it flies again', async ({ page }) => {
    const errors = noErrors(page)
    await booted(page)
    await setSpeed(page, 0)
    const placed = () => svg(page).evaluate((e) => (e as SVGElement).style.transform)
    expect(await scrollAndFollow(page, 0)).toBe(0)
    const inHero = await placed() // drawn as at p = 0
    const end = await transitionEnd(page)
    expect(await scrollAndFollow(page, Math.round(0.3 * end))).toBeLessThan(0.5)
    expect(await placed()).not.toBe(inHero) // on its way
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(placed).toBe(inHero)
    expect(await drawnIn(page)).toBe('hero')
    await settled(page)
    expect(await visibleRobots(page)).toBe(1)
    const down = await fadeTo(page, Math.round(0.7 * end))
    expect(down.places).toEqual(['hero', 'bio'])
    const standing = await placed()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(placed).not.toBe(standing) // p = 0.7: on its way again
    await settled(page)
    expect(await visibleRobots(page)).toBe(1)
    expect(await scrollAndFollow(page, Math.ceil(end) + 1)).toBe(1)
    expect(await drawnIn(page)).toBe('bio')
    await textIsSound(page)
    expect(errors).toEqual([])
  })
})
