import { describe, expect, it } from 'vitest'
import { fitAroundGap, splitAtGap, type Fit, type WordBox } from '../../src/text/split.ts'

// 8 words, each 40 wide with 10 gaps: [0,40], [50,90], ..., [350,390]
const words: WordBox[] = Array.from({ length: 8 }, (_, i) => ({ x0: i * 50, x1: i * 50 + 40 }))

describe('splitAtGap', () => {
  it('no word overlaps gap', () => {
    const { leftEnd, shift } = splitAtGap(words, 95, 170)
    for (const w of words.slice(0, leftEnd)) expect(w.x1).toBeLessThanOrEqual(95)
    for (const w of words.slice(leftEnd)) expect(w.x0 + shift).toBeGreaterThanOrEqual(170)
  })

  it('whole words only', () => {
    const { leftEnd } = splitAtGap(words, 95, 170)
    expect(Number.isInteger(leftEnd)).toBe(true)
    expect(leftEnd).toBeGreaterThanOrEqual(0)
    expect(leftEnd).toBeLessThanOrEqual(8)
  })

  it('gap at start', () => {
    expect(splitAtGap(words, -10, 30).leftEnd).toBe(0)
  })

  it('gap past line end', () => {
    expect(splitAtGap(words, 500, 600)).toEqual({ leftEnd: 8, shift: 0 })
  })

  it('gap inside a space moves nothing', () => {
    expect(splitAtGap(words, 91, 99)).toEqual({ leftEnd: 2, shift: 0 })
  })
})

/** Where each word ends up under `f`: its shifted box, or null when hidden. */
function place(ws: WordBox[], f: Fit): (WordBox | null)[] {
  return ws.map((w, i) => {
    if (i < f.leftEnd) return { x0: w.x0 - f.leftShift, x1: w.x1 - f.leftShift }
    if (i >= f.rightStart) return { x0: w.x0 + f.shift, x1: w.x1 + f.shift }
    return null
  })
}

// one long word in the middle: [0,40] [50,90] [100,260] [270,310] [320,360]
const long: WordBox[] = [
  { x0: 0, x1: 40 },
  { x0: 50, x1: 90 },
  { x0: 100, x1: 260 },
  { x0: 270, x1: 310 },
  { x0: 320, x1: 360 },
]

describe('fitAroundGap', () => {
  it('unbounded, it is splitAtGap', () => {
    for (const [gl, gr] of [[95, 170], [-10, 30], [500, 600], [91, 99], [0, 400], [215, 230]]) {
      const f = fitAroundGap(words, gl!, gr!)
      const s = splitAtGap(words, gl!, gr!)
      expect(f).toEqual({ leftEnd: s.leftEnd, rightStart: s.leftEnd, leftShift: 0, shift: s.shift })
    }
  })

  it('prefers the smallest left shift that fits', () => {
    // gap [180, 230] under the long word, with 90px of room on the left: it stays left, shifted 80px
    expect(fitAroundGap(long, 180, 230, -90, 380)).toEqual({ leftEnd: 3, rightStart: 3, leftShift: 80, shift: 0 })
  })

  it('shifts the left run left when the right run would leave the bounds', () => {
    // gap [295, 345] near the end: shifting [300, 390] right would pass maxX = 400
    const f = fitAroundGap(words, 295, 345, -50, 400)
    expect(f.rightStart - f.leftEnd).toBe(0)
    expect(f.leftShift).toBeGreaterThan(0)
    const placed = place(words, f)
    for (const w of placed) {
      expect(w!.x1 <= 295 || w!.x0 >= 345).toBe(true)
      expect(w!.x0).toBeGreaterThanOrEqual(-50)
      expect(w!.x1).toBeLessThanOrEqual(400)
    }
  })

  it('hides the word behind the gap only when nothing else fits', () => {
    // the gap starts deep inside the long word; it can go neither left nor right within [-10, 380]
    const f = fitAroundGap(long, 180, 230, -10, 380)
    expect(f).toMatchObject({ leftEnd: 2, rightStart: 3 })
    const placed = place(long, f)
    expect(placed[2]).toBeNull()
    for (const w of placed.filter((w) => w !== null)) {
      expect(w.x1 <= 180 || w.x0 >= 230).toBe(true)
      expect(w.x0).toBeGreaterThanOrEqual(-10)
      expect(w.x1).toBeLessThanOrEqual(380)
    }
  })

  it('every gap position: visible words clear the gap and stay in bounds', () => {
    for (let gl = -60; gl <= 420; gl += 3) {
      const f = fitAroundGap(long, gl, gl + 50, -10, 380)
      place(long, f).forEach((w, i) => {
        if (!w) return
        expect(w.x0, `word ${i} gap ${gl}`).toBeGreaterThanOrEqual(-10)
        expect(w.x1, `word ${i} gap ${gl}`).toBeLessThanOrEqual(380)
        expect(w.x1 <= gl || w.x0 >= gl + 50, `word ${i} gap ${gl}`).toBe(true)
      })
    }
  })
})
