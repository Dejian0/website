import { expect, test } from 'vitest'
import * as c from '../../src/content.ts'
import { renderRobotsTxt, renderSitemap, renderStructuredData } from '../../src/build/seo.ts'

const fixture = {
  ...c,
  person: { name: 'Ada Example', line: 'Robots that learn.', now: 'Now: arms.' },
  education: [
    { school: 'Example University', detail: 'Exchange student', dates: '2026' },
    { school: 'Other Institute', detail: 'BSc', dates: '2024 – 2027' },
  ],
  links: [
    { label: 'GitHub', href: 'https://github.com/ada' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/ada' },
  ],
}

/** The JSON inside the one <script type="application/ld+json"> element. */
function parse(html: string): unknown {
  const m = html.match(/^<script type="application\/ld\+json">([\s\S]*)<\/script>$/)
  expect(m, 'a single ld+json script element').not.toBeNull()
  return JSON.parse(m![1]!)
}

test('structured data describes a profile page about the person, with their profiles and schools', () => {
  expect(parse(renderStructuredData(fixture, 'https://example.org/'))).toEqual({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: 'https://example.org/',
    mainEntity: {
      '@type': 'Person',
      name: 'Ada Example',
      url: 'https://example.org/',
      description: 'Robots that learn.',
      sameAs: ['https://github.com/ada', 'https://www.linkedin.com/in/ada'],
      affiliation: [
        { '@type': 'CollegeOrUniversity', name: 'Example University' },
        { '@type': 'CollegeOrUniversity', name: 'Other Institute' },
      ],
    },
  })
})

test('content cannot close the script element early', () => {
  const name = 'Ada</script><script>alert(1)</script>'
  const html = renderStructuredData({ ...fixture, person: { ...fixture.person, name } }, 'https://example.org/')
  expect(html.match(/<\/script>/gi)).toHaveLength(1)
  expect((parse(html) as { mainEntity: { name: string } }).mainEntity.name).toBe(name)
})

test('robots.txt lets every crawler in and points to the sitemap', () => {
  const txt = renderRobotsTxt('https://example.org/')
  const lines = txt.split('\n')
  expect(lines).toContain('User-agent: *')
  expect(lines).toContain('Sitemap: https://example.org/sitemap.xml')
  expect(lines.filter((l) => /^disallow:\s*\S/i.test(l))).toEqual([])
})

test('sitemap lists the page', () => {
  const xml = renderSitemap('https://example.org/')
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
  expect(xml.match(/<loc>(.*?)<\/loc>/g)).toEqual(['<loc>https://example.org/</loc>'])
})
