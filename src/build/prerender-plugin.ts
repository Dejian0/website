import type { Plugin } from 'vite'
import * as content from '../content.ts'
import { HERO_SCALE, renderHeroSvg } from './hero-svg.ts'
import { renderRobotsTxt, renderSitemap, renderStructuredData, SITE_URL } from './seo.ts'
import { escapeHtml, renderStaticContent } from './static-html.ts'

function fill(html: string, marker: string, value: string): string {
  if (!html.includes(marker)) throw new Error(`site-prerender: missing placeholder ${marker}`)
  return html.split(marker).join(value)
}

export function transformSiteHtml(html: string, c: typeof content): string {
  html = fill(html, '<!--site-title-->', escapeHtml(c.person.name))
  html = fill(html, '<!--site-description-->', escapeHtml(c.person.line))
  html = fill(html, '<!--site-url-->', escapeHtml(SITE_URL))
  html = fill(html, '<!--structured-data-->', renderStructuredData(c))
  html = fill(html, '<!--static-content-->', renderStaticContent(c))
  return fill(html, '<!--hero-robot-->', renderHeroSvg(HERO_SCALE))
}

export function sitePrerender(): Plugin {
  return {
    name: 'site-prerender',
    transformIndexHtml: (html) => transformSiteHtml(html, content),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: renderRobotsTxt() })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: renderSitemap() })
    },
  }
}
