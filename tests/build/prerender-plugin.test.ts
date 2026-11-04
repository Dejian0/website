import { renderFaviconSvg } from '../../src/build/favicon-svg.ts'
import { expect, test } from 'vitest'
import * as c from '../../src/content.ts'
import { transformSiteHtml } from '../../src/build/prerender-plugin.ts'
import { escapeHtml } from '../../src/build/static-html.ts'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const template = readFileSync('index.html', 'utf8')

test('title and description come from content', () => {
  const out = transformSiteHtml(template, c)
  expect(out).toContain(`<meta name="description" content="${escapeHtml(c.person.line)}"`)
  expect(out).toContain(`<title>${escapeHtml(c.person.name)}</title>`)
})

test('replacement survives $ patterns in content', () => {
  const fake = { ...c, person: { ...c.person, line: "cost $& $` $' $1" } }
  const out = transformSiteHtml(template, fake)
  expect(out).toContain(`content="${escapeHtml(fake.person.line)}"`)
  expect(out).not.toContain('<!--')
})

test('missing marker throws', () => {
  expect(() => transformSiteHtml('<html></html>', c)).toThrow(/missing placeholder/)
})

test('open graph tags and theme colour', () => {
  const out = transformSiteHtml(template, c)
  expect(out).toContain(`<meta property="og:title" content="${escapeHtml(c.person.name)}"`)
  expect(out).toContain(`<meta property="og:description" content="${escapeHtml(c.person.line)}"`)
  expect(out).toContain('<meta name="theme-color" content="#ffffff"')
  expect(out).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg"')
})

test('the head names the canonical address and a large link-preview image there', () => {
  const head = transformSiteHtml(template, c).split('</head>')[0]!
  expect(head).toContain('<link rel="canonical" href="https://dejianzhou.com/"')
  expect(head).toContain('<meta property="og:url" content="https://dejianzhou.com/"')
  expect(head).toContain('<meta property="og:image" content="https://dejianzhou.com/og.png"')
  expect(head).toContain('<meta name="twitter:card" content="summary_large_image"')
})

test('the head carries the structured data', () => {
  const head = transformSiteHtml(template, c).split('</head>')[0]!
  const json = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  expect(json).not.toBeNull()
  expect(JSON.parse(json![1]!).mainEntity.name).toBe(c.person.name)
})

test('the link-preview image is a PNG of the size the head states', () => {
  const head = transformSiteHtml(template, c).split('</head>')[0]!
  const stated = (p: string) => Number(head.match(new RegExp(`<meta property="og:image:${p}" content="(\\d+)"`))?.[1])
  const png = PNG.sync.read(readFileSync('public/og.png'))
  expect([png.width, png.height]).toEqual([stated('width'), stated('height')])
  expect(png.width / png.height).toBeCloseTo(1.91, 1) // the shape LinkedIn and others crop to
})

test('the page never carries the email as an address, structured data included', () => {
  const out = transformSiteHtml(template, c)
  expect(out).not.toContain(`${c.email.user}@${c.email.domain}`)
  expect(out).not.toContain('mailto:')
})

test('committed favicon matches the renderer', () => {
  expect(readFileSync('public/favicon.svg', 'utf8')).toBe(renderFaviconSvg())
})
