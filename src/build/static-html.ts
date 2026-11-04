import type * as Content from '../content.ts'
import { encodeEmail } from '../page/email.ts'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const e = escapeHtml

function renderEntry(w: (typeof Content.work)[number], i: number): string {
  const title = w.href
    ? `<a href="${e(w.href)}" class="title-link" target="_blank" rel="noopener">${e(w.title)}</a>`
    : e(w.title)
  return `<article class="entry" data-entry="${i}">
  <h3 class="title">${title}</h3>
  <p class="meta"><span class="org">${e(w.role)}, ${e(w.org)}</span><span class="dates">${e(w.dates)}</span></p>
  <p class="blurb" data-flow="work-${i}">${e(w.blurb)}</p>
</article>`
}

/**
 * A row of the Education or Honors list: each piece of text painted, flow `<list>-<i>-<piece>`
 * (the piece's class). A piece without text is left out.
 */
function renderRow(list: string, i: number, pieces: [piece: string, text: string | undefined][]): string {
  const spans = pieces.map(([piece, text]) => (text ? `<span class="${piece}" data-flow="${list}-${i}-${piece}">${e(text)}</span>` : ''))
  return `<li class="edu-item">${spans.join('')}</li>`
}

const renderLinks = (links: { label: string; href: string }[]) =>
  links.map((l) => `<li><a href="${e(l.href)}">${e(l.label)}</a></li>`).join('\n    ')

/** Returns the inner HTML of <main>. */
export function renderStaticContent(c: typeof Content): string {
  const bio = c.bio.map((p, i) => `<p data-flow="bio-${i}">${e(p)}</p>`).join('\n    ')
  const work = c.work.map(renderEntry).join('\n  ')
  // list rows are painted too: each Education and Honors row's pieces, and each Skills row
  const edu = c.education.map((x, i) => renderRow('education', i, [['school', x.school], ['detail', x.detail], ['dates', x.dates]])).join('\n    ')
  const honors = c.honors.map((x, i) => renderRow('honors', i, [['org', x.org], ['detail', x.detail], ['dates', x.dates]])).join('\n    ')
  const skills = c.skills.map((s, i) => `<li><span class="skill" data-flow="focus-${i}">${e(s)}</span></li>`).join('\n    ')
  // the email link has no address in the HTML: the page's script fills it in and shows it (src/page/email.ts)
  const mail = `<li hidden><a class="email" data-mail="${e(encodeEmail(c.email))}"></a></li>`

  return `<section id="hero">
  <div id="robot-anchor"><!--hero-robot--></div>
  <h1 class="name">${e(c.person.name)}</h1>
  <p class="line">${e(c.person.line)}</p>
  <p class="now">${e(c.person.now)}</p>
</section>
<section id="bio" aria-label="About">
    ${bio}
</section>
<section id="work" class="sec">
  <h2>Work</h2>
  ${work}
</section>
<section id="education" class="sec">
  <h2>Education</h2>
  <ul class="edu">
    ${edu}
  </ul>
</section>
<section id="honors" class="sec">
  <h2>Honors</h2>
  <ul class="edu">
    ${honors}
  </ul>
</section>
<section id="focus" class="sec">
  <h2>Skills</h2>
  <ul class="skills">
    ${skills}
  </ul>
</section>
<section id="contact" class="sec">
  <h2>Contact</h2>
  <p class="note" data-flow="contact-0">${e(c.contact)}</p>
  <ul class="links">
    ${mail}
    ${renderLinks(c.links)}
  </ul>
</section>
<section id="site" class="sec">
  <h2>This site</h2>
  <p class="note" data-flow="site-0">${e(c.site.note)}</p>
  <ul class="links">
    ${renderLinks([c.site.source])}
  </ul>
</section>`
}
