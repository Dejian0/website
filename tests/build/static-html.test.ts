import { expect, test } from 'vitest'
import * as c from '../../src/content.ts'
import { escapeHtml, renderStaticContent } from '../../src/build/static-html.ts'
import { encodeEmail } from '../../src/page/email.ts'

test('contains every content string', () => {
  const html = renderStaticContent(c)
  for (const s of [
    c.person.name,
    c.person.line,
    ...c.bio,
    ...c.work.flatMap((w) => [w.title, w.role, w.org, w.dates, w.blurb]),
    ...c.education.flatMap((e) => [e.school, e.detail, e.dates, ...(e.courses ? [e.courses] : [])]),
    ...c.honors.flatMap((h) => [h.org, h.detail, ...(h.dates ? [h.dates] : [])]),
    ...c.volunteering.flatMap((v) => [v.org, v.detail, v.dates]),
    ...c.skills,
    c.contact,
    ...c.links.map((l) => l.href),
    c.site.note,
    c.site.source.label,
    c.site.source.href,
  ]) {
    expect(html).toContain(escapeHtml(s))
  }
  expect(html.match(/data-flow="work-\d"/g)).toHaveLength(c.work.length)
  expect(html.match(/data-flow="bio-\d"/g)).toHaveLength(c.bio.length)
})

test('an Honors row without a date has no dates piece', () => {
  const html = renderStaticContent({ ...c, honors: [{ org: 'A', detail: 'B' }, { org: 'C', detail: 'D', dates: '2024' }] })
  expect(html).toContain('<li class="edu-item"><span class="org" data-flow="honors-0-org">A</span><span class="detail" data-flow="honors-0-detail">B</span></li>')
  expect(html).toContain('data-flow="honors-1-dates">2024</span>')
  expect(html).not.toContain('honors-0-dates')
})

test('the HTML carries the email only encoded, in a hidden list item, never as an address or a mailto: link', () => {
  const html = renderStaticContent(c)
  expect(html).not.toContain(`${c.email.user}@${c.email.domain}`)
  expect(html).not.toContain('mailto:')
  expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/) // nothing an address harvester would match
  expect(html).toContain(`<li hidden><a class="email" data-mail="${escapeHtml(encodeEmail(c.email))}"></a></li>`)
})

test('an entry with a link has its title link to it, in a new tab', () => {
  const html = renderStaticContent({ ...c, work: [{ ...c.work[0]!, href: 'https://example.com/a?b=1&c=2' }] })
  expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" class="title-link" target="_blank" rel="noopener">')
})

test('escapeHtml maps the five special characters', () => {
  expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
})
