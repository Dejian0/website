/** A word's horizontal extent in line-local px. Words are runs between collapsible spaces. */
export interface WordBox { x0: number; x1: number }

/** Words [0, leftEnd) stay; words [leftEnd, n) move right by `shift`. */
export interface Parted { leftEnd: number; shift: number }

/**
 * Parts a line around the gap [gapLeft, gapRight] without splitting a word.
 * Words that end at or before the gap stay. The first word that reaches into
 * the gap and every word after it move right, just far enough to clear it.
 * `words` must be sorted left to right and must not overlap.
 */
export function splitAtGap(words: WordBox[], gapLeft: number, gapRight: number): Parted {
  let leftEnd = 0
  while (leftEnd < words.length && words[leftEnd]!.x1 <= gapLeft) leftEnd++
  if (leftEnd === words.length) return { leftEnd, shift: 0 }
  return { leftEnd, shift: Math.max(0, gapRight - words[leftEnd]!.x0) }
}

/**
 * Words [0, leftEnd) move left by `leftShift`, words [rightStart, n) move right by `shift`,
 * and the words in between (if any) are hidden.
 */
export interface Fit { leftEnd: number; rightStart: number; leftShift: number; shift: number }

/** [px outside the bounds, hidden words, left shift, right shift]: lower is better, in order. */
type Cost = [number, number, number, number]

function less(a: Cost, b: Cost): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

/**
 * Parts a line around [gapLeft, gapRight] like splitAtGap, but keeps every shown word inside
 * [minX, maxX] (line-local px). Prefers, in order: nothing outside the bounds, fewer hidden
 * words, the smallest left shift (the start of the line stays put when it can), then the
 * smallest right shift. So the run before the gap only moves left when the run after it has
 * no room. Hiding the word behind the gap is a last resort that the caller should make
 * unreachable (the walker only stands where a line parts with nothing hidden). Unbounded,
 * the result is splitAtGap's.
 */
export function fitAroundGap(words: WordBox[], gapLeft: number, gapRight: number, minX = -Infinity, maxX = Infinity): Fit {
  const n = words.length
  const outside = (l: number, r: number, a: number, b: number) =>
    (l > 0 ? Math.max(0, minX - (words[0]!.x0 - a)) : 0) + (r < n ? Math.max(0, words[n - 1]!.x1 + b - maxX) : 0)
  // splitAtGap's answer is the best one whenever it stays inside the bounds
  const { leftEnd, shift } = splitAtGap(words, gapLeft, gapRight)
  let fit: Fit = { leftEnd, rightStart: leftEnd, leftShift: 0, shift }
  let cost: Cost = [outside(leftEnd, leftEnd, 0, shift), 0, 0, shift]
  if (cost[0] === 0) return fit
  for (let l = 0; l <= n; l++) {
    const a = l > 0 ? Math.max(0, words[l - 1]!.x1 - gapLeft) : 0
    for (let r = l; r <= n; r++) {
      const b = r < n ? Math.max(0, gapRight - words[r]!.x0) : 0
      const c: Cost = [outside(l, r, a, b), r - l, a, b]
      if (less(c, cost)) {
        fit = { leftEnd: l, rightStart: r, leftShift: a, shift: b }
        cost = c
      }
    }
  }
  return fit
}
