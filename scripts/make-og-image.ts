// Regenerates public/og.png, the link-preview image: node scripts/make-og-image.ts
// The hero as the page opens with it, the robot over the name, at the 1.91:1 size link
// previews use (index.html states it). Only the name, so no draft wording goes stale in it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { HERO_SCALE, renderHeroSvg } from '../src/build/hero-svg.ts'
import { escapeHtml } from '../src/build/static-html.ts'
import { person } from '../src/content.ts'

const W = 1200
const H = 630

const woff2 = readFileSync(new URL('../node_modules/@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff2', import.meta.url))

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: 'Inter Tight'; font-weight: 600; src: url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2'); }
html, body { margin: 0; background: #ffffff; }
body {
  width: ${W}px; height: ${H}px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px;
  font-family: 'Inter Tight'; color: #141414; -webkit-font-smoothing: antialiased;
}
svg { display: block; width: 400px; height: auto; overflow: visible; } /* the shadow blurs past its box, as on the page */
h1 { margin: 0; font-size: 84px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
</style>${renderHeroSvg(HERO_SCALE)}<h1>${escapeHtml(person.name)}</h1>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await page.setContent(html)
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('600 84px "Inter Tight"')
  })
  if (!loaded) throw new Error('make-og-image: Inter Tight did not load')
  await page.screenshot({ path: fileURLToPath(new URL('../public/og.png', import.meta.url)) })
} finally {
  await browser.close()
}
