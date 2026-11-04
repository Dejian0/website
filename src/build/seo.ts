import type * as Content from '../content.ts'

/** Where the site is published, with the trailing slash: canonical, link previews, sitemap. */
export const SITE_URL = 'https://dejianzhou.com/'

/**
 * schema.org data for search engines, as a <script> for the <head>: a profile page about the
 * person, tied to their other profiles (links) and their schools (education). Only facts
 * from content, and never the email, which the page keeps out of its HTML on purpose.
 */
export function renderStructuredData(c: typeof Content, url = SITE_URL): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    mainEntity: {
      '@type': 'Person',
      name: c.person.name,
      url,
      description: c.person.line,
      sameAs: c.links.map((l) => l.href),
      affiliation: c.education.map((e) => ({ '@type': 'CollegeOrUniversity', name: e.school })),
    },
  }
  // JSON escapes "<" as \u003c, so no string in it can end the script element
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

/** Every crawler, search and AI alike, may read the whole site. */
export function renderRobotsTxt(url = SITE_URL): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${url}sitemap.xml\n`
}

/** The one page. No lastmod: a build date would not say when the content changed. */
export function renderSitemap(url = SITE_URL): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${url}</loc></url>
</urlset>
`
}
