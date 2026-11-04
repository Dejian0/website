import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { HINT_IDLE, HINT_READY_COARSE, HINT_READY_FINE, ROBOT_LABEL } from '../src/interaction/controller.ts'
import { MAX_LEFT_SHIFT } from '../src/terrain/clearance.ts'
import type { Rect, Surface } from '../src/terrain/terrain.ts'
import type { PaintedLine } from '../src/text/flow.ts'

// window.__site: dev-only hook from src/debug.ts
type Site = {
  robot(): {
    x: number
    y: number
    mode: string
    p: number
    surface: number | null
    silhouette: Rect
    lift: number
    hop: { from: number; to: number } | null
  }
  painted(): PaintedLine[]
  surfaces(): Surface[]
  setSpeed(mult: number): void
  parting(): { hidden: number; maxLeftShift: number }
  send(x: number, y: number): void
  advance(seconds: number): void
}
const robot = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot())
const surfaces = (page: Page) => page.evaluate(() => (window as unknown as { __site: Site }).__site.surfaces())
const setSpeed = (page: Page, mult: number) => page.evaluate((m) => (window as unknown as { __site: Site }).__site.setSpeed(m), mult)
/** The flow of the surface the robot stands on. */
const flowOf = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __site: Site }).__site
    const i = s.robot().surface
    return i === null ? null : s.surfaces()[i]!.flow
  })
const hint = (page: Page) => page.locator('#robot-hint')
const readyText = (page: Page) =>
  page.evaluate(() => matchMedia('(pointer: coarse)').matches).then((c) => (c ? HINT_READY_COARSE : HINT_READY_FINE))

/** Scrolls to y and waits for the robot to have followed (it draws on the next frame). */
async function scrollAndFollow(page: Page, y: number) {
  return page.evaluate(async (y) => {
    window.scrollTo(0, y)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return (window as unknown as { __site: Site }).__site.robot().p
  }, y)
}

/** Loaded and painted, scrolled to just where the transition ends (p = 1), the robot standing still on screen. */
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
  return page.evaluate(() => {
    const s = (window as unknown as { __site: Site }).__site.robot().silhouette
    return { x: (s.x0 + s.x1) / 2 - scrollX, y: (s.y0 + s.y1) / 2 - scrollY }
  })
}

async function clickRobot(page: Page) {
  const at = await robotPoint(page)
  await page.mouse.click(at.x, at.y)
}

/** A point in the middle of a standable surface of `flow` (the index-th, from the end if negative), page px. */
async function surfacePoint(page: Page, flow: string, index = 0) {
  const s = (await surfaces(page)).filter((x) => x.flow === flow && x.standable).at(index)!
  return { x: (s.x0 + s.x1) / 2, y: s.y }
}

async function arrives(page: Page, flow: string, timeout = 10_000) {
  await expect.poll(async () => [(await robot(page)).mode, await flowOf(page)], { timeout }).toEqual(['arrived', flow])
}

function noErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
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

test('send robot to a work blurb', async ({ page }) => {
  const errors = noErrors(page)
  await standing(page)
  await expect(hint(page)).toHaveText(HINT_IDLE)
  await expect(hint(page)).toBeVisible()
  await clickRobot(page)
  await expect(hint(page)).toHaveText(await readyText(page))
  expect((await robot(page)).mode).toBe('ready')

  // the dotted path shows within 100ms of the click
  await page.evaluate(() => {
    const w = window as unknown as { clickAt: number; shownAt: number }
    window.addEventListener('click', () => (w.clickAt = performance.now()), { capture: true, once: true })
    const path = document.getElementById('robot-path')!
    new MutationObserver(() => {
      if (path.style.display !== 'none' && !w.shownAt) w.shownAt = performance.now()
    }).observe(path, { attributes: true, subtree: true })
  })
  // p.blurb is a 1px sr-only box once painted: click the middle of its painted layer
  await page.locator('p.blurb[data-flow="work-1"] + .flow-paint').click()
  await expect(page.locator('#robot-path')).toBeVisible({ timeout: 100 })
  const { clickAt, shownAt } = await page.evaluate(() => {
    const w = window as unknown as { clickAt: number; shownAt: number }
    return { clickAt: w.clickAt, shownAt: w.shownAt }
  })
  expect(shownAt - clickAt).toBeLessThan(100)
  expect(await page.locator('#robot-path path').getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+L/)
  expect((await robot(page)).mode).toBe('walking')
  await expect(hint(page)).toBeHidden()

  await setSpeed(page, 8)
  await arrives(page, 'work-1')
  await expect(page.locator('#robot-path')).toBeHidden() // it eroded away
  await expect(hint(page)).toBeHidden() // sent somewhere once: the hint is gone for good
  await textIsSound(page)
  expect(errors).toEqual([])
})

const GITHUB = 'https://github.com/Dejian0'
const stubGithub = (context: BrowserContext) =>
  context.route('https://github.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>stub</p>' }))

test('links work when not ready', async ({ page, context }) => {
  await stubGithub(context)
  await standing(page)
  await setSpeed(page, 1)
  expect((await robot(page)).mode).toBe('wandering')
  await page.locator(`.links a[href="${GITHUB}"]`).click()
  await page.waitForURL(GITHUB)
})

test('in ready mode a click on a link sends the robot there instead of following it', async ({ page, context, baseURL }) => {
  await stubGithub(context)
  await standing(page)
  await clickRobot(page)
  expect((await robot(page)).mode).toBe('ready')
  const link = page.locator(`.links a[href="${GITHUB}"]`)
  await link.scrollIntoViewIfNeeded()
  // where it goes: the line it can stand on nearest the click, the link's middle
  const nearest = await link.evaluate((a) => {
    const r = a.getBoundingClientRect()
    const x = r.left + r.width / 2 + scrollX
    const y = r.top + r.height / 2 + scrollY
    const d = (s: Surface) => (x - Math.min(Math.max(x, s.x0), s.x1)) ** 2 + (y - s.y) ** 2
    const all = (window as unknown as { __site: Site }).__site.surfaces().filter((s) => s.standable)
    return all.reduce((a, b) => (d(b) < d(a) ? b : a)).flow
  })
  await link.click()
  expect((await robot(page)).mode).toBe('walking')
  await setSpeed(page, 8)
  await arrives(page, nearest)
  expect(page.url()).toBe(new URL('/', baseURL).href) // still the page itself
})

test('unreachable click', async ({ page }) => {
  const errors = noErrors(page)
  const end = await standing(page)
  await setSpeed(page, 8)

  // the Contact heading, at the very bottom: the rule under it is somewhere to stand
  await clickRobot(page)
  const contact = page.locator('#contact h2')
  await contact.scrollIntoViewIfNeeded()
  await contact.click()
  await arrives(page, 'rule-contact', 15_000)

  // the hero, from where the transition ends (the hero is still on screen there): ready from the keyboard
  await page.getByRole('button', { name: ROBOT_LABEL }).focus()
  await page.keyboard.press('Enter')
  expect((await robot(page)).mode).toBe('ready')
  expect(await scrollAndFollow(page, end)).toBe(1)
  const hero = (await page.locator('#hero').boundingBox())!
  expect(hero.y + hero.height).toBeGreaterThan(20)
  await page.mouse.click(hero.x + 10, hero.y + hero.height - 10)
  expect((await robot(page)).mode).toBe('walking')
  await arrives(page, 'bio-0', 15_000)
  await textIsSound(page)
  expect(errors).toEqual([])
})

test('timeout', async ({ page }) => {
  await standing(page)
  await clickRobot(page)
  await expect(hint(page)).toHaveText(await readyText(page))
  await page.waitForTimeout(8500)
  await expect(hint(page)).toHaveText(HINT_IDLE)
  expect((await robot(page)).mode).toBe('wandering')
})

test('scroll back mid-trip', async ({ page }) => {
  const end = await standing(page)
  const to = await surfacePoint(page, 'work-2')
  await page.evaluate(({ x, y }) => (window as unknown as { __site: Site }).__site.send(x, y), to)
  expect((await robot(page)).mode).toBe('walking')
  await setSpeed(page, 8)
  await page.waitForTimeout(400)
  expect((await robot(page)).mode).toBe('walking') // mid-trip

  expect(await scrollAndFollow(page, 0)).toBe(0)
  const paused = await robot(page)
  await page.waitForTimeout(1000)
  const still = await robot(page)
  expect(still).toMatchObject({ p: 0, mode: 'walking', x: paused.x, y: paused.y })
  await expect(page.locator('#robot-path')).toBeHidden()

  expect(await scrollAndFollow(page, end)).toBe(1)
  await expect(page.locator('#robot-path')).toBeVisible() // the same trip: its path is back
  const going = await robot(page)
  expect(going.mode).toBe('walking')
  expect(Math.hypot(going.x - paused.x, going.y - paused.y)).toBeLessThan(60) // on from where it stopped
  await arrives(page, 'work-2')
})

test('keeps going when scrolled away', async ({ page }) => {
  await standing(page)
  const to = await surfacePoint(page, 'work-2')
  await page.evaluate(({ x, y }) => (window as unknown as { __site: Site }).__site.send(x, y), to)
  const bottom = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
  expect(await scrollAndFollow(page, bottom)).toBe(1)
  await setSpeed(page, 8)
  // it gets there (and then wanders on, to what is in view)
  await arrives(page, 'work-2', 10_000)
  expect(await page.evaluate(() => scrollY)).toBe(bottom) // the page never scrolled itself
})

test('stops in ready mode with every foot down, head up', async ({ page }) => {
  await standing(page)
  await setSpeed(page, 1)
  await expect.poll(async () => (await robot(page)).lift, { timeout: 5000 }).toBeGreaterThan(1) // mid-stride, a foot up
  const before = await robot(page)
  await clickRobot(page)
  await page.waitForTimeout(500)
  const r = await robot(page)
  expect(r.mode).toBe('ready')
  expect(r.lift).toBeLessThan(0.01)
  expect(Math.abs(r.x - before.x)).toBeLessThan(10) // it stopped where it was
  await page.waitForTimeout(500)
  expect((await robot(page)).x).toBe(r.x)
  // the head up does not take it past the reach the text parts around
  await textIsSound(page)
})

test('the robot is a button: Enter gets it ready, Escape lets it go', async ({ page }) => {
  await standing(page)
  const button = page.getByRole('button', { name: ROBOT_LABEL })
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(await page.locator('#robot-layer svg path:not([aria-hidden="true"])').count()).toBe(0)
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(hint(page)).toHaveText(await readyText(page))
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(hint(page)).toHaveText(HINT_IDLE)
  await page.keyboard.press(' ')
  expect((await robot(page)).mode).toBe('ready')
  await page.keyboard.press(' ')
  expect((await robot(page)).mode).toBe('wandering')
})

test('only in the text is the robot clickable', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  await setSpeed(page, 0)
  expect(await scrollAndFollow(page, 0)).toBe(0)
  const svg = page.locator('#robot-layer svg')
  await expect(svg).not.toHaveCSS('cursor', 'pointer')
  await expect(hint(page)).toBeHidden()
  // the big robot in the hero (the silhouette is where it will land, so aim at the drawing)
  const box = (await svg.boundingBox())!
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#robot-layer svg') !== null, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  expect(hit).toBe(true)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  expect((await robot(page)).mode).toBe('wandering')
  await standing(page)
  await expect(svg).toHaveCSS('cursor', 'pointer')
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('auto') // no custom cursor anywhere else
})

test('a drag on the robot is not a click and never leaves it stuck', async ({ page }) => {
  await standing(page)
  const at = await robotPoint(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 30, at.y - 10, { steps: 5 })
  expect((await robot(page)).mode).toBe('pushed')
  await setSpeed(page, 1) // the push runs in the robot's own time
  await page.mouse.up()
  // flung, it recovers and wanders on
  await expect.poll(async () => (await robot(page)).mode).toBe('wandering')
})

test('taps: on the robot, then on a blurb; a tapped link in ready mode is not followed', async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'touch')
  await stubGithub(context)
  await standing(page)
  let at = await robotPoint(page)
  await page.touchscreen.tap(at.x, at.y)
  await expect(hint(page)).toHaveText(HINT_READY_COARSE)
  const layer = page.locator('p.blurb[data-flow="work-1"] + .flow-paint')
  await layer.scrollIntoViewIfNeeded()
  // as iOS Safari may: no click at all for a tap on text, so the tap itself must set the target
  await page.evaluate(() => {
    const block = (e: Event) => e.stopImmediatePropagation()
    window.addEventListener('click', block, { capture: true })
    ;(window as unknown as { unblock: () => void }).unblock = () => window.removeEventListener('click', block, { capture: true })
  })
  await layer.tap()
  expect((await robot(page)).mode).toBe('walking')
  await page.evaluate(() => (window as unknown as { unblock: () => void }).unblock())
  await setSpeed(page, 8)
  await arrives(page, 'work-1')

  // ready again, then a tap on the GitHub link: it sets a target instead of opening the link
  at = await robotPoint(page)
  await page.touchscreen.tap(at.x, at.y)
  expect((await robot(page)).mode).toBe('ready')
  await page.locator(`.links a[href="${GITHUB}"]`).tap()
  expect((await robot(page)).mode).toBe('walking')
  await page.waitForTimeout(500)
  expect(page.url()).toBe(new URL('/', baseURL).href) // still the page itself
})

// --- trips past the text that does not part (headings, titles, role and date lines, links) ---

const FIXED = '.sec > h2, .entry > .title, .entry > .meta, .links a'
const DT = 1 / 120 // s of the robot's own time per measured frame

type Frame = { x: number; y: number; hop: { from: number; to: number } | null; surface: Surface }
type TripRun = {
  frames: Frame[]
  /** ms behind fixed text in each hop that passes behind any (from>to surfaces), in order. */
  hops: { key: string; ms: number }[]
  /** ms behind fixed text over the whole trip, and of that while walking (none: it walks only on lines). */
  ms: number
  walkMs: number
  /** Meetings on screen, and whether at every one the words were in front of the robot. */
  behind: number
  front: boolean
  arrived: string | null
  /** The fixed text met (entry:class), in order. */
  met: string[]
  /** px it moved along the page, walking and hopping, and how much more that is than from start to end. */
  along: number
  detour: number
}

/**
 * Runs the trip under way frame-exactly, DT at a time (__site.advance, as the frame loop at speed
 * 1 would; setSpeed(0) holds the loop meanwhile), following the robot down or up the page as a
 * reader would. Each frame's silhouette (as drawn) is checked against the glyph boxes of the
 * fixed text: the ms it overlaps them by more than 0.5px, per hop and in all, which elements
 * those were, and at each meeting on screen whether the words are in front of the robot.
 */
function runTrip(page: Page): Promise<TripRun> {
  return page.evaluate(
    ({ sel, dt }) => {
      const site = (window as unknown as { __site: Site }).__site
      const robotSvg = document.querySelector('#robot-layer svg')!
      const boxes = [...document.querySelectorAll(sel)].flatMap((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const key = `${el.closest('.entry')?.getAttribute('data-entry') ?? '-'}:${el.className || el.tagName.toLowerCase()}`
        return [...range.getClientRects()]
          .filter((r) => r.width > 0)
          .map((r) => ({ el, key, x0: r.left + scrollX, y0: r.top + scrollY, x1: r.right + scrollX, y1: r.bottom + scrollY }))
      })
      const out: TripRun = { frames: [], hops: [], ms: 0, walkMs: 0, behind: 0, front: true, arrived: null, met: [], along: 0, detour: 0 }
      let prev = site.robot()
      const start = prev.x
      let hop = null as { key: string; ms: number } | null // not narrowed to null: the loop sets it
      for (let i = 0; i < 120 / dt; i++) {
        site.advance(dt)
        const r = site.robot()
        const s = r.silhouette
        out.frames.push({ x: r.x, y: r.y, hop: r.hop, surface: site.surfaces()[r.surface!]! })
        out.along += Math.abs(r.x - prev.x)
        const key = r.hop && `${r.hop.from}>${r.hop.to}`
        if (key !== (hop?.key ?? null)) hop = key ? { key, ms: 0 } : null
        const hits = boxes.filter((b) => b.x1 > s.x0 + 0.5 && b.x0 < s.x1 - 0.5 && b.y1 > s.y0 + 0.5 && b.y0 < s.y1 - 0.5)
        if (hits.length) {
          out.ms += dt * 1000
          if (!hop) out.walkMs += dt * 1000
          else if (hop.ms === 0 && out.hops.at(-1) !== hop) out.hops.push(hop)
          if (hop) hop.ms += dt * 1000
        }
        // follow the robot (the page itself never scrolls)
        const y = r.y - innerHeight * 0.5
        if (Math.abs(y - scrollY) > innerHeight * 0.3) window.scrollTo(0, y)
        for (const b of hits) {
          if (!out.met.includes(b.key)) out.met.push(b.key)
          const cx = (Math.max(b.x0, s.x0) + Math.min(b.x1, s.x1)) / 2 - scrollX
          const cy = (Math.max(b.y0, s.y0) + Math.min(b.y1, s.y1)) / 2 - scrollY
          if (cy < 0 || cy > innerHeight) continue
          out.behind++
          const top = document.elementFromPoint(cx, cy)
          if (!top || robotSvg.contains(top) || !b.el.contains(top)) out.front = false
        }
        prev = r
        if (r.mode !== 'walking') {
          out.arrived = r.mode === 'arrived' && r.surface !== null ? site.surfaces()[r.surface]!.flow : null
          break
        }
      }
      out.detour = out.along - Math.abs(prev.x - start)
      return out
    },
    { sel: FIXED, dt: DT },
  )
}

/**
 * Every hop of the trip that rises or falls arcs (its frames are not on one straight line), and
 * wherever the robot stands still it stands on a line it can stand on: never in the air, never
 * in the empty margin. Returns how many hops it checked.
 */
function arcsAndStandsOnLines(frames: Frame[]): number {
  let hops = 0
  for (let i = 0; i < frames.length; ) {
    const h = frames[i]!.hop
    if (!h) {
      i++
      continue
    }
    let j = i
    while (j < frames.length && frames[j]!.hop?.from === h.from && frames[j]!.hop?.to === h.to) j++
    const run = frames.slice(i, j)
    const [a, b] = [run[0]!, run.at(-1)!]
    if (run.length >= 5 && Math.abs(b.y - a.y) > 4) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const bulge = Math.max(...run.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len))
      expect(bulge, `hop ${h.from}→${h.to}`).toBeGreaterThan(0.5)
      hops++
    }
    i = j
  }
  for (let i = 1; i < frames.length; i++) {
    const [p, q] = [frames[i - 1]!, frames[i]!]
    if (Math.hypot(q.x - p.x, q.y - p.y) > 0.01) continue
    expect(q.hop, `still at ${q.x.toFixed(1)},${q.y.toFixed(1)}`).toBeNull()
    expect(q.surface.standable).toBe(true)
    expect(q.y).toBeCloseTo(q.surface.y, 6)
    expect(q.x).toBeGreaterThanOrEqual(q.surface.x0 - 0.5)
    expect(q.x).toBeLessThanOrEqual(q.surface.x1 + 0.5)
  }
  return hops
}

/** What a trip may meet of the fixed text, the most ms it may spend behind it in one hop and in all, and the most px of detour. */
type Bound = { met: string[]; hop: number; trip: number; detour: number }

/**
 * The trip kept within its bound: it met exactly that fixed text, only ever in a hop, and no
 * longer than the bound per hop and in all, going no further out of its way than the bound;
 * where it met any, the words were in front of it at every meeting on screen. Logs what it
 * measured.
 */
function within(r: TripRun, b: Bound, name: string, testInfo: TestInfo) {
  const note = `${name}: met ${JSON.stringify(r.met)}, ${r.ms.toFixed(0)} ms behind (${r.hops.map((h) => `${h.key} ${h.ms.toFixed(0)}`).join(', ') || 'no hop'}), detour ${r.detour.toFixed(0)}px of ${r.along.toFixed(0)}px along`
  testInfo.annotations.push({ type: 'behind fixed text', description: note })
  console.log(`[behind] ${note}`)
  expect(r.met, name).toEqual(b.met)
  expect(r.walkMs, name).toBe(0)
  expect(Math.max(0, ...r.hops.map((h) => h.ms)), `${name}: ms behind in one hop`).toBeLessThanOrEqual(b.hop)
  expect(r.ms, `${name}: ms behind in all`).toBeLessThanOrEqual(b.trip)
  expect(r.detour, `${name}: px out of its way`).toBeLessThanOrEqual(b.detour)
  if (b.met.length === 0) return expect(r.ms, name).toBe(0)
  expect(r.ms, name).toBeGreaterThan(0)
  expect(r.behind, name).toBeGreaterThan(0) // it does pass behind them...
  expect(r.front, name).toBe(true) // ...with every word in front
}

const sendTo = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => (window as unknown as { __site: Site }).__site.send(x, y), at)

/** Stands the robot on the `index`th standable surface of `flow`, at page x (its middle by default). */
async function placeOn(page: Page, flow: string, index = 0, x?: number) {
  await page.evaluate(
    ({ flow, index, x }) => {
      const site = (window as unknown as { __site: Site } & { __site: { place(s: number, x: number): void } }).__site
      const s = site.surfaces().filter((q) => q.flow === flow && q.standable)[index]!
      site.place(s.id, x ?? (s.x0 + s.x1) / 2)
    },
    { flow, index, x },
  )
}

// ms behind fixed text and px of detour (moving along the page more than from start to end:
// strides that overshoot, walks out of the way and back), measured frame-exactly (DT) on this
// layout, with about 20% headroom (a stride where it measured none). On desktop only the role
// lines of the first two entries are met: work-0's leaves a 34px gap beside its dates (the
// robot's silhouette is 58px wide), and work-1's 117px gap is used only from near it, as the
// walk there and back costs more than the time behind the words it saves (CROSSING_PX_PER_MS).
// A phone's titles and role lines span the column.
const BOUNDS: Record<number, Record<string, Bound>> = {
  1440: {
    down: { met: ['0:meta'], hop: 180, trip: 180, detour: 180 }, // measured 142 ms, detour 144px
    through: { met: ['1:meta'], hop: 190, trip: 190, detour: 190 }, // 158, 154
    up: { met: ['1:meta', '0:meta'], hop: 180, trip: 360, detour: 90 }, // 150 + 150, 69
    'work-1 from 450': { met: ['1:meta'], hop: 190, trip: 190, detour: 20 }, // 158, 0
    'work-1 from 700': { met: ['1:meta'], hop: 190, trip: 190, detour: 50 }, // 158, 38
    'work-1 from 940': { met: [], hop: 0, trip: 0, detour: 40 }, // through the gap; 27
  },
  1280: {
    down: { met: ['0:meta'], hop: 180, trip: 180, detour: 180 }, // 142, 144
    through: { met: ['1:meta'], hop: 190, trip: 190, detour: 190 }, // 158, 154
    up: { met: ['1:meta', '0:meta'], hop: 180, trip: 360, detour: 20 }, // 150 + 150, 0
    'work-1 from 450': { met: ['1:meta'], hop: 190, trip: 190, detour: 20 }, // 158, 0
    'work-1 from 700': { met: ['1:meta'], hop: 190, trip: 190, detour: 20 }, // 158, 0
    // the line ends at 875 here, and the role line above it now reaches past that: briefly behind it; 67, 0
    'work-1 from 940': { met: ['1:meta'], hop: 90, trip: 90, detour: 20 },
  },
  390: {
    'bio to work-1': { met: ['0:title', '0:meta', '1:title', '1:meta'], hop: 400, trip: 690, detour: 760 }, // 333 + 233, 632 (strides down ~30 bio lines)
  },
}

for (const width of [1440, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('into, through and out of Work: every hop arcs, it stops only on lines, and it passes behind fixed text only briefly, the words in front', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop widths')
      const bound = BOUNDS[width]!
      await standing(page)
      // down: from the bio onto the first line of the first entry, under its role line
      await sendTo(page, await surfacePoint(page, 'work-0'))
      const into = await runTrip(page)
      expect(into.arrived).toBe('work-0')
      within(into, bound.down!, `${width} down`, testInfo)
      expect(arcsAndStandsOnLines(into.frames)).toBeGreaterThanOrEqual(2)

      // on through Work from that first line
      await sendTo(page, await surfacePoint(page, 'work-2'))
      const through = await runTrip(page)
      expect(through.arrived).toBe('work-2')
      within(through, bound.through!, `${width} through`, testInfo)
      expect(arcsAndStandsOnLines(through.frames)).toBeGreaterThanOrEqual(2)

      // up: from the second entry's first line back to the end of the bio
      await placeOn(page, 'work-1')
      await sendTo(page, await surfacePoint(page, 'bio-2', -1))
      const out = await runTrip(page)
      expect(out.arrived).toBe('bio-2')
      within(out, bound.up!, `${width} up`, testInfo)
      expect(arcsAndStandsOnLines(out.frames)).toBeGreaterThanOrEqual(2)
      await textIsSound(page)
    })

    test('into the second entry from three places along the first: through the gap in its header from near it, else briefly behind its role line', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop widths')
      await standing(page)
      for (const x of [450, 700, 940]) {
        await placeOn(page, 'work-0', 1, x) // the first entry's second line it can stand on
        await sendTo(page, await surfacePoint(page, 'work-1'))
        const r = await runTrip(page)
        expect(r.arrived).toBe('work-1')
        within(r, BOUNDS[width]![`work-1 from ${x}`]!, `${width} work-1 from ${x}`, testInfo)
        arcsAndStandsOnLines(r.frames)
      }
      await textIsSound(page)
    })
  })
}

test('on a phone a jump into Work passes behind the fixed text, never over it, and briefly', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone width')
  await standing(page)
  // the fixed text is in front of the robot layer and the dotted path
  const order = await page.evaluate((sel) => {
    const z = (el: Element) => getComputedStyle(el).zIndex
    return {
      fixed: [...document.querySelectorAll(sel)].every((el) => z(el) === '1' && getComputedStyle(el).position === 'relative'),
      layer: z(document.getElementById('robot-layer')!),
      path: z(document.getElementById('robot-path')!),
    }
  }, FIXED)
  expect(order).toEqual({ fixed: true, layer: 'auto', path: 'auto' })
  expect(page.viewportSize()!.width).toBe(390)
  await sendTo(page, await surfacePoint(page, 'work-1'))
  const r = await runTrip(page)
  expect(r.arrived).toBe('work-1')
  // no room beside the entries' headers here: it does cross, behind every word it meets
  within(r, BOUNDS[390]!['bio to work-1']!, '390 bio to work-1', testInfo)
  expect(arcsAndStandsOnLines(r.frames)).toBeGreaterThan(3)
  await textIsSound(page)
})

test('assistive tech can activate the robot: its default action toggles ready, once', async ({ page }) => {
  await standing(page)
  const svg = page.locator('#robot-layer svg')
  const activate = () => svg.dispatchEvent('click') // a click with no press: detail 0, as a screen reader's or Voice Control's
  await activate()
  expect((await robot(page)).mode).toBe('ready')
  await expect(hint(page)).toHaveText(await readyText(page))
  await activate()
  expect((await robot(page)).mode).toBe('wandering')
  // Enter toggles it; a click that echoes the same key press does not toggle it back
  await svg.focus()
  await page.keyboard.press('Enter')
  await activate()
  expect((await robot(page)).mode).toBe('ready')
  await page.waitForTimeout(600)
  await activate()
  expect((await robot(page)).mode).toBe('wandering')
  // not in the hero (p < 1)
  expect(await scrollAndFollow(page, 0)).toBe(0)
  await activate()
  expect((await robot(page)).mode).toBe('wandering')
})
