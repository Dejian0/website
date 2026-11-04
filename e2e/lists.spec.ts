import { expect, test, type Page } from '@playwright/test'
import * as c from '../src/content'
import type { Rect, Surface } from '../src/terrain/terrain.ts'
import type { PaintedLine } from '../src/text/flow.ts'

// window.__site: dev-only hook from src/debug.ts
type Site = {
  robot(): { x: number; y: number; mode: string; p: number; surface: number | null; silhouette: Rect; hop: { from: number; to: number } | null }
  surfaces(): Surface[]
  painted(): PaintedLine[]
  parting(): { hidden: number; maxLeftShift: number }
  setSpeed(mult: number): void
  place(surface: number, x: number): void
  send(x: number, y: number): void
  advance(seconds: number): void
}

// the painted flows of the lists: each Education row's school, degree and dates (and coursework), each Honors row's
// giver, award and date (where it has one), each Volunteering row's organization, role and dates, and
// each Skills row; and the notes in Contact and This site
const EDU_FLOWS = c.education.flatMap((e, i) => ['school', 'detail', 'dates', ...(e.courses ? ['courses'] : [])].map((p) => `education-${i}-${p}`))
const HONOR_FLOWS = c.honors.flatMap((h, i) => ['org', 'detail', ...(h.dates ? ['dates'] : [])].map((p) => `honors-${i}-${p}`))
const VOLUNTEER_FLOWS = c.volunteering.flatMap((_, i) => ['org', 'detail', 'dates'].map((p) => `volunteering-${i}-${p}`))
const SKILL_FLOWS = c.skills.map((_, i) => `focus-${i}`)
const NOTE_FLOWS = ['contact-0', 'site-0']
const FLOWS = [...EDU_FLOWS, ...HONOR_FLOWS, ...VOLUNTEER_FLOWS, ...SKILL_FLOWS, ...NOTE_FLOWS]
/** The section a flow is in, by its id, as terrain-wiring.ts's sectionOf() (which needs a window to import). */
const sectionOf = (flow: string) => (flow.startsWith('rule-') ? flow.slice('rule-'.length) : flow.split('-')[0]!)

async function walking(page: Page) {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
  await page.locator('#bio').scrollIntoViewIfNeeded()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot().p)).toBe(1)
  await page.evaluate(() => (window as unknown as { __site: Site }).__site.setSpeed(0))
}

/**
 * Stands the robot on each standable piece in the lists (their rows and the lines under their
 * headings), at its ends and middle, and returns what goes wrong there: fixed text (a heading, a
 * link) crossing its silhouette, a painted word of a line above crossing it, two lines of a row
 * running into each other once they part, or a word hidden.
 */
function trouble(page: Page) {
  return page.evaluate((flows) => {
    const site = (window as unknown as { __site: Site }).__site
    const toPage = (r: DOMRect): Rect => ({ x0: r.left + scrollX, y0: r.top + scrollY, x1: r.right + scrollX, y1: r.bottom + scrollY })
    const glyphs = (n: Node) => {
      const word = n.textContent!.trimEnd()
      if (!word.trim()) return []
      const range = document.createRange()
      range.setStart(n, 0)
      range.setEnd(n, word.length)
      return [...range.getClientRects()].filter((r) => r.width > 0).map(toPage)
    }
    const textRects = (e: Element) => {
      const out: Rect[] = []
      const texts = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
      for (let n = texts.nextNode(); n; n = texts.nextNode()) out.push(...glyphs(n))
      return out
    }
    const fixed = [...document.querySelectorAll('.sec > h2, .links a')].flatMap(textRects)
    const surfaces = site.surfaces()
    const glyphTop = new Map(surfaces.map((x) => [`${x.flow}:${x.line}`, x.y]))
    // each painted line of the lists: its spans, and its text band (glyph tops to line bottom)
    const lines = site.painted().filter((l) => flows.includes(l.flow))
    const spansOf = new Map(flows.map((f) => [f, [...document.querySelector(`[data-flow="${f}"]`)!.nextElementSibling!.querySelectorAll('span:not([hidden])')]]))
    const taken = new Map<string, number>()
    const rows = lines.map((l) => {
      const from = taken.get(l.flow) ?? 0
      taken.set(l.flow, from + l.words.length)
      return { l, spans: spansOf.get(l.flow)!.slice(from, from + l.words.length), top: glyphTop.get(`${l.flow}:${l.index}`)!, bottom: l.y + l.lineHeight }
    })
    // where each line's words are drawn now, in x, over its band
    const drawn = (row: (typeof rows)[number]) =>
      row.spans.filter((w) => getComputedStyle(w).visibility !== 'hidden').flatMap((w) => glyphs(w.firstChild!).map((g) => ({ ...g, y0: row.top, y1: row.bottom })))
    const hit = (q: Rect, b: Rect, slack: number) => q.x1 > b.x0 + slack && q.x0 < b.x1 - slack && q.y1 > b.y0 + slack && q.y0 < b.y1 - slack
    const hidden = site.parting().hidden
    const out: string[] = []
    let spots = 0
    for (const s of surfaces.filter((s) => s.standable && /^(education|honors|volunteering|focus|contact|site)-|^rule-/.test(s.flow))) {
      for (const x of [s.x0, (s.x0 + s.x1) / 2, s.x1]) {
        window.scrollTo(0, s.y - innerHeight / 2)
        site.place(s.id, x)
        spots++
        const r = site.robot()
        const at = `${s.flow} at ${x.toFixed(0)}`
        const b = r.silhouette
        if (r.surface !== s.id) out.push(`${at}: placed on ${r.surface}, not ${s.id}`)
        for (const g of fixed) if (hit(g, b, 0.5)) out.push(`${at}: fixed text [${g.x0.toFixed(0)}, ${g.y0.toFixed(0)}] crosses it`)
        const now = rows.map((row) => ({ row, words: drawn(row) }))
        for (const { row, words } of now) {
          if (row.l.flow === s.flow && row.l.index === s.line) continue // the line it stands on
          // WebKit rounds a Range's width up to whole px, so a right edge reads up to 1px wide
          for (const g of words) if (hit(g, b, 1)) out.push(`${at}: a word of ${row.l.flow} [${g.x0.toFixed(0)}, ${g.y0.toFixed(0)}] crosses it`)
        }
        for (let i = 0; i < now.length; i++)
          for (let j = i + 1; j < now.length; j++)
            for (const p of now[i]!.words)
              for (const q of now[j]!.words)
                if (hit(p, { ...q, x0: q.x0 - 4, x1: q.x1 + 4 }, 0)) out.push(`${at}: ${now[i]!.row.l.flow} [${p.x0.toFixed(0)}] runs into ${now[j]!.row.l.flow} [${q.x0.toFixed(0)}]`)
      }
    }
    if (site.parting().hidden !== hidden) out.push(`${site.parting().hidden - hidden} words hidden`)
    return { spots, out: out.slice(0, 12) }
  }, FLOWS)
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('every list row and note is painted, and every section has somewhere to stand', async ({ page }) => {
      await walking(page)
      const r = await page.evaluate(() => {
        const site = (window as unknown as { __site: Site }).__site
        const standable = site.surfaces().filter((s) => s.standable)
        return {
          painted: [...new Set(site.painted().map((l) => l.flow))],
          standable: [...new Set(standable.map((s) => s.flow))],
          rules: [...new Set(site.surfaces().filter((s) => s.flow.startsWith('rule-')).map((s) => s.flow))],
        }
      })
      expect(r.painted).toEqual(expect.arrayContaining(FLOWS))
      // every Skills row and note, every Education, Honors and Volunteering row (on one of its pieces), and the
      // line under each heading but Work's
      for (const f of [...SKILL_FLOWS, ...NOTE_FLOWS]) expect(r.standable, f).toContain(f)
      for (const [list, rows] of [['education', c.education], ['honors', c.honors], ['volunteering', c.volunteering]] as const)
        for (let i = 0; i < rows.length; i++) expect(r.standable.some((f) => f.startsWith(`${list}-${i}-`)), `${list} row ${i}`).toBe(true)
      // the rows' own lines are not floors: only the lines under the headings are
      const rules = ['rule-education', 'rule-honors', 'rule-volunteering', 'rule-focus', 'rule-contact', 'rule-site']
      expect(r.rules).toEqual(rules)
      for (const f of rules) expect(r.standable, f).toContain(f)
      // and so every section of the page
      const sections = await page.evaluate(() => [...document.querySelectorAll('#bio, .sec')].map((e) => e.id))
      expect(sections).toEqual(['bio', 'work', 'education', 'honors', 'volunteering', 'focus', 'contact', 'site'])
      for (const id of sections) expect(r.standable.some((f) => sectionOf(f) === id), id).toBe(true)
    })

    test('standing anywhere in the lists, nothing crosses the robot, and parted rows keep their words apart', async ({ page }) => {
      await walking(page)
      const r = await trouble(page)
      expect(r.out).toEqual([])
      expect(r.spots).toBeGreaterThan(10)
    })

    test('the line above a Skills row opens around the robot standing there; the one under its feet stays whole', async ({ page }) => {
      await walking(page)
      const r = await page.evaluate(() => {
        const site = (window as unknown as { __site: Site }).__site
        const s = site.surfaces().find((s) => s.flow === 'focus-1' && s.standable)!
        window.scrollTo(0, s.y - innerHeight / 2)
        site.place(s.id, (s.x0 + s.x1) / 2)
        const b = site.robot().silhouette
        const rows = [...document.querySelectorAll<HTMLElement>('.skills > li')]
        const gap = (e: HTMLElement) => {
          if (!e.classList.contains('gap')) return null
          const left = e.getBoundingClientRect().left + scrollX
          return [left + parseFloat(e.style.getPropertyValue('--gap-x0')), left + parseFloat(e.style.getPropertyValue('--gap-x1'))]
        }
        const there = { above: gap(rows[0]!), under: gap(rows[1]!), robot: [b.x0, b.x1] }
        site.place(site.surfaces().find((q) => q.flow === 'bio-0' && q.standable)!.id, 0)
        return { ...there, after: rows.map(gap) }
      })
      expect(r.above).not.toBeNull()
      expect(r.above![0]).toBeLessThanOrEqual(r.robot[0]!)
      expect(r.above![1]).toBeGreaterThanOrEqual(r.robot[1]!)
      expect(r.under).toBeNull()
      expect(r.after).toEqual(c.skills.map(() => null)) // closed again once it is back in the bio
    })

    test('a click on the Skills list sends it to a Skills row', async ({ page }) => {
      await walking(page)
      const r = await page.evaluate(() => {
        const site = (window as unknown as { __site: Site }).__site
        const row = document.querySelectorAll('.skills > li')[1]!
        window.scrollTo(0, row.getBoundingClientRect().top + scrollY - innerHeight / 2)
        const li = row.getBoundingClientRect()
        site.send(li.left + scrollX + 60, li.top + scrollY + li.height / 2)
        for (let i = 0; i < 60 * 90 && site.robot().mode === 'walking'; i++) site.advance(1 / 60)
        const r = site.robot()
        return { mode: r.mode, flow: r.surface === null ? null : site.surfaces()[r.surface]!.flow }
      })
      expect(r.mode).toBe('arrived')
      expect(r.flow).toMatch(/^focus-/)
    })

    test('from the start of the bio, a click sends it to each Honors and Volunteering row, the Contact note and This site', async ({ page }) => {
      await walking(page)
      const targets = [...c.honors.map((_, i) => `honors-${i}-`), ...c.volunteering.map((_, i) => `volunteering-${i}-`), 'contact-0', 'site-0']
      const r = await page.evaluate((targets) => {
        const site = (window as unknown as { __site: Site }).__site
        return targets.map((target) => {
          const start = site.surfaces().find((s) => s.flow === 'bio-0' && s.standable)!
          site.place(start.id, start.x0)
          // the last standable piece of the target, as far down the page as it goes
          const s = site.surfaces().filter((s) => s.standable && s.flow.startsWith(target)).at(-1)!
          window.scrollTo(0, s.y - innerHeight / 2)
          site.send((s.x0 + s.x1) / 2, s.y)
          let t = 0
          for (; t < 60 * 300 && site.robot().mode === 'walking'; t++) site.advance(1 / 60)
          const at = site.robot()
          return { target, mode: at.mode, flow: at.surface === null ? null : site.surfaces()[at.surface]!.flow, seconds: Math.round(t / 60) }
        })
      }, targets)
      for (const x of r) {
        expect(x.mode, x.target).toBe('arrived')
        expect(x.flow, x.target).toMatch(new RegExp(`^${x.target}`))
      }
      console.log(`[trips] ${width}: ${r.map((x) => `${x.target} ${x.seconds}s`).join(', ')}`)
    })
  })
}

// Phone widths are where a list row could cut the page in two (pieces sharing a line can't part,
// and a date wrapped onto its own line is too short to stand on): every row and note, both ways.
for (const width of [320, 360, 375, 430, 640, 768]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('a trip from the start of the bio reaches every list row and note, and one from the last heading gets back', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'the width is what matters, not the device')
      // as walking(), but scrolled all the way to the bio: on a wide phone it is in view already
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('data-text-flow', 'painted')
      await page.evaluate(() => document.getElementById('bio')!.scrollIntoView())
      await expect.poll(() => page.evaluate(() => (window as unknown as { __site: Site }).__site.robot().p)).toBe(1)
      await page.evaluate(() => (window as unknown as { __site: Site }).__site.setSpeed(0))
      const rows = [...c.education.map((_, i) => `education-${i}-`), ...c.honors.map((_, i) => `honors-${i}-`), ...c.volunteering.map((_, i) => `volunteering-${i}-`), ...SKILL_FLOWS, ...NOTE_FLOWS]
      const r = await page.evaluate((rows) => {
        const site = (window as unknown as { __site: Site }).__site
        const surfaces = site.surfaces()
        /** Sends the robot from `from` to the middle of `to` and returns the flow it arrives on. */
        const trip = (from: Surface, to: Surface) => {
          site.place(from.id, (from.x0 + from.x1) / 2)
          window.scrollTo(0, to.y - innerHeight / 2)
          site.send((to.x0 + to.x1) / 2, to.y)
          for (let t = 0; t < 60 * 300 && site.robot().mode === 'walking'; t++) site.advance(1 / 60)
          const at = site.robot()
          return at.mode === 'arrived' && at.surface !== null ? site.surfaces()[at.surface]!.flow : `${at.mode}`
        }
        const bio = surfaces.find((s) => s.flow === 'bio-0' && s.standable)!
        const down = rows.map((row) => {
          const to = surfaces.filter((s) => s.standable && s.flow.startsWith(row)).at(-1)!
          return { row, got: trip(bio, to) }
        })
        const up = trip(surfaces.find((s) => s.flow === 'rule-site')!, bio)
        return { down, up }
      }, rows)
      for (const { row, got } of r.down) expect(got, row).toMatch(new RegExp(`^${row}`))
      expect(r.up).toBe('bio-0')
    })
  })
}
