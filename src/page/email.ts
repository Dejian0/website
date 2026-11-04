// The email address, kept out of the page's HTML and out of this repo's text as an address: the
// build writes it reversed, its @ swapped for a slash, and the page's script puts it together.
// A harvester reading the HTML (or the source) finds no address and no mailto: link; a reader
// sees the address and can copy it. Without JavaScript the link's list item stays hidden.

/** An address in two parts, so that no `user@domain` appears in the source either. */
export interface Email { user: string; domain: string }

/** The address as the HTML carries it. */
export const encodeEmail = (m: Email): string => [...`${m.user}/${m.domain}`].reverse().join('')

/** The address back from encodeEmail(). */
export const decodeEmail = (code: string): string => [...code].reverse().join('').replace('/', '@')

/** Fills in each `a[data-mail]`, its address as its text and a mailto: link, and shows its list item. */
export function revealEmail(root: ParentNode = document): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-mail]')) {
    const address = decodeEmail(a.dataset.mail ?? '')
    a.href = `mailto:${address}`
    a.textContent = address
    a.closest('li')?.removeAttribute('hidden')
  }
}
