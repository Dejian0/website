import { expect, test } from '@playwright/test'
import * as c from '../src/content'

test.use({ javaScriptEnabled: false, baseURL: 'http://localhost:5181' })

test('content readable without JS', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: c.person.name })).toBeVisible()
  await expect(page.getByText(c.bio[0])).toBeVisible()
  for (const w of c.work) await expect(page.getByText(w.title, { exact: true })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
})

test('the build serves robots.txt, the sitemap and the link-preview image', async ({ request }) => {
  const robots = await request.get('/robots.txt')
  expect(robots.status()).toBe(200)
  expect(await robots.text()).toContain('Sitemap: https://dejianzhou.com/sitemap.xml')
  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  expect(await sitemap.text()).toContain('<loc>https://dejianzhou.com/</loc>')
  const og = await request.get('/og.png')
  expect(og.status()).toBe(200)
  expect(og.headers()['content-type']).toBe('image/png')
})

test('hero robot on first paint', async ({ page }) => {
  await page.goto('/')
  const robot = page.locator('#robot-static')
  await expect(robot).toBeVisible()
  expect(await robot.locator('path').count()).toBeGreaterThan(20)
  const box = await robot.boundingBox()
  const vw = await page.evaluate(() => document.documentElement.clientWidth)
  expect(Math.abs(box!.x + box!.width / 2 - vw / 2)).toBeLessThanOrEqual(2)
  if (vw >= 1000) {
    expect(box!.width / vw).toBeGreaterThanOrEqual(0.35)
    expect(box!.width / vw).toBeLessThanOrEqual(0.5)
  } else {
    expect(box!.width).toBeLessThanOrEqual(vw - 32)
  }
})
