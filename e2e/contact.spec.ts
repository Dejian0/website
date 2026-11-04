import { expect, test } from '@playwright/test'
import * as c from '../src/content'

const address = `${c.email.user}@${c.email.domain}`

test('the page as served has no email address and no mailto: link; its script shows the email link', async ({ page, request }) => {
  // the production build, as GitHub Pages serves it
  const served = await (await request.get('http://localhost:5181/')).text()
  expect(served).not.toContain(address)
  expect(served).not.toContain('mailto:')

  await page.goto('/')
  const link = page.locator('#contact .links a.email')
  await expect(link).toBeVisible()
  await expect(link).toHaveText(address)
  await expect(link).toHaveAttribute('href', `mailto:${address}`)
  // first of Contact's links, then GitHub and LinkedIn
  await expect(page.locator('#contact .links a')).toHaveText([address, ...c.links.map((l) => l.label)])
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false, baseURL: 'http://localhost:5181' })

  test('the email link stays hidden: there is no address to show', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#contact .links li').first()).toBeHidden()
    await expect(page.getByText(c.contact)).toBeVisible()
    await expect(page.getByRole('link', { name: c.site.source.label })).toBeVisible()
  })
})
