import { describe, expect, it } from 'vitest'
import {
  ARRIVED_DWELL_MS,
  deadline,
  DRAG_THRESHOLD_PX,
  HINT_IDLE,
  HINT_READY_COARSE,
  HINT_READY_FINE,
  initialState,
  READY_TIMEOUT_MS,
  reduce,
  type CtlEvent,
  type CtlState,
  type Effect,
} from '../../src/interaction/controller.ts'

/** Feeds events in order; returns the last state and every effect. */
function feed(s: CtlState, ...events: CtlEvent[]): { state: CtlState; effects: Effect[]; last: Effect[] } {
  const all: Effect[] = []
  let last: Effect[] = []
  for (const e of events) {
    const r = reduce(s, e)
    s = r.state
    last = r.effects
    all.push(...r.effects)
  }
  return { state: s, effects: all, last }
}

const click = (t: number, x = 0, y = 0): CtlEvent[] => [
  { type: 'robotDown', x, y, t },
  { type: 'robotUp', x: x + 3, y: y + 2, t: t + 80 },
]
const ready = (coarse = false, t = 1000) => feed(initialState(coarse), ...click(t)).state
const hints = (effects: Effect[]) => effects.filter((e) => e.type === 'hint').map((e) => (e as { text: string | null }).text)

describe('controller', () => {
  it('pins the interface values', () => {
    expect([READY_TIMEOUT_MS, DRAG_THRESHOLD_PX, ARRIVED_DWELL_MS]).toEqual([8000, 6, 3000])
    expect([HINT_IDLE, HINT_READY_FINE, HINT_READY_COARSE]).toEqual(['Tell the robot where to go', 'Click anywhere', 'Tap anywhere'])
    expect(initialState(true)).toEqual({
      mode: 'wandering',
      coarse: true,
      readySince: 0,
      hintHidden: false,
      arrivedAt: 0,
      down: null,
      dragging: false,
      last: null,
      resume: 'wandering',
      target: null,
      still: false,
    })
  })

  it('click robot enters ready', () => {
    const fine = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotUp', x: 3, y: 2, t: 90 })
    expect(fine.state.mode).toBe('ready')
    expect(fine.state.readySince).toBe(90)
    expect(fine.effects).toContainEqual({ type: 'hint', text: 'Click anywhere' })
    const coarse = feed(initialState(true), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotUp', x: 3, y: 2, t: 90 })
    expect(coarse.state.mode).toBe('ready')
    expect(coarse.effects).toContainEqual({ type: 'hint', text: 'Tap anywhere' })
  })

  it('drag starts push not ready', () => {
    const r = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotMove', x: 7, y: 0, t: 16 })
    expect(r.effects).toContainEqual({ type: 'pushStart', x: 0, y: 0 })
    expect(r.state.mode).not.toBe('ready')
    expect(r.state.mode).toBe('pushed')
    expect(r.state.dragging).toBe(true)
    // within the threshold it is still a click
    const near = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotMove', x: 4, y: 4, t: 16 })
    expect(near.effects).toEqual([])
    expect(feed(near.state, { type: 'robotUp', x: 4, y: 4, t: 40 }).state.mode).toBe('ready')
  })

  it('a push follows the pointer and is released with its velocity', () => {
    let s = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotMove', x: 10, y: 0, t: 20 }).state
    let r = feed(s, { type: 'robotMove', x: 30, y: -10, t: 40 })
    expect(r.last).toEqual([{ type: 'pushMove', x: 30, y: -10 }])
    s = feed(r.state, { type: 'robotMove', x: 70, y: -30, t: 80 }, { type: 'robotMove', x: 90, y: -40, t: 100 }).state
    r = feed(s, { type: 'robotUp', x: 90, y: -40, t: 104 })
    const release = r.last.find((e) => e.type === 'pushRelease') as { vx: number; vy: number }
    expect(release.vx).toBeGreaterThan(500) // ~1000 px/s to the right...
    expect(release.vy).toBeLessThan(-250) // ...and up
    expect(r.state).toMatchObject({ mode: 'pushed', down: null, dragging: false })
    const back = feed(r.state, { type: 'recovered', t: 900 })
    expect(back.state.mode).toBe('wandering')
    expect(back.effects).toContainEqual({ type: 'hint', text: HINT_IDLE })
  })

  it('once it recovers from a push it goes back to what the push interrupted', () => {
    const push = (s: CtlState, t: number) =>
      feed(s, { type: 'robotDown', x: 0, y: 0, t }, { type: 'robotMove', x: 20, y: 0, t: t + 20 }, { type: 'robotUp', x: 40, y: 0, t: t + 40 }).state
    // a trip: planned again from where it lands, to where it was sent
    const walking = reduce(ready(), { type: 'pageClick', x: 420, y: 1960, t: 3000 }).state
    let r = feed(push(walking, 4000), { type: 'recovered', t: 5000 })
    expect(r.state.mode).toBe('walking')
    expect(r.effects).toEqual([{ type: 'goTo', x: 420, y: 1960 }])
    // waiting for a click: ready again, for a full READY_TIMEOUT_MS from now
    r = feed(push(ready(), 4000), { type: 'recovered', t: 5000 })
    expect(r.state).toMatchObject({ mode: 'ready', readySince: 5000 })
    expect(r.effects).toEqual([{ type: 'hint', text: HINT_READY_FINE }])
    // arrived, or wandering: it wanders on
    const arrived = reduce(walking, { type: 'arrived', t: 4000 }).state
    expect(feed(push(arrived, 4500), { type: 'recovered', t: 5000 }).state.mode).toBe('wandering')
    expect(feed(push(initialState(false), 0), { type: 'recovered', t: 900 }).state.mode).toBe('wandering')
    // pushed again before it recovers: still the trip it was on
    r = feed(push(push(walking, 4000), 4200), { type: 'recovered', t: 5000 })
    expect(r.effects).toContainEqual({ type: 'goTo', x: 420, y: 1960 })
    // the layout changed under the push: the trip, planned on the old one, is dropped (as relaid() drops a trip); a wait goes on
    expect(feed(push(walking, 4000), { type: 'recovered', t: 5000, lost: true }).state.mode).toBe('wandering')
    expect(feed(push(ready(), 4000), { type: 'recovered', t: 5000, lost: true }).state.mode).toBe('ready')
    // Escape while pushed lets the trip go, as it would have walking
    const esc = reduce(push(walking, 4000), { type: 'key', key: 'Escape', t: 4100, robotFocused: false })
    expect(esc.state.mode).toBe('pushed')
    expect(feed(esc.state, { type: 'recovered', t: 5000 }).state.mode).toBe('wandering')
  })

  it('a cancelled press is neither a click nor a stuck push', () => {
    const tap = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotCancel', x: 0, y: 0, t: 30 })
    expect(tap.state).toMatchObject({ mode: 'wandering', down: null })
    expect(tap.effects).toEqual([])
    const drag = feed(
      initialState(false),
      { type: 'robotDown', x: 0, y: 0, t: 0 },
      { type: 'robotMove', x: 20, y: 0, t: 20 },
      { type: 'robotCancel', x: 20, y: 0, t: 30 },
    )
    expect(drag.last).toEqual([{ type: 'pushRelease', vx: 0, vy: 0 }])
    expect(drag.state).toMatchObject({ mode: 'pushed', down: null, dragging: false })
  })

  it('page click in ready', () => {
    const r = reduce(ready(), { type: 'pageClick', x: 420, y: 1960, t: 3000 })
    expect(r.effects).toContainEqual({ type: 'preventDefault' })
    expect(r.effects).toContainEqual({ type: 'goTo', x: 420, y: 1960 })
    expect(r.state.mode).toBe('walking')
    // the trip starts last, so whatever it reports at once (no route, there already) wins
    expect(r.effects.at(-1)?.type).toBe('goTo')
  })

  it('page click while wandering does nothing', () => {
    expect(reduce(initialState(false), { type: 'pageClick', x: 10, y: 10, t: 0 }).effects).toEqual([])
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    expect(reduce(walking, { type: 'pageClick', x: 10, y: 10, t: 2500 })).toEqual({ state: walking, effects: [] })
  })

  it('timeout', () => {
    const s = ready()
    expect(reduce(s, { type: 'tick', t: s.readySince + READY_TIMEOUT_MS - 1 }).state.mode).toBe('ready')
    const r = reduce(s, { type: 'tick', t: s.readySince + 8000 })
    expect(r.state.mode).toBe('wandering')
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_IDLE })
  })

  it('escape', () => {
    const r = reduce(ready(), { type: 'key', key: 'Escape', t: 2000, robotFocused: false })
    expect(r.state.mode).toBe('wandering')
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_IDLE })
    // and it cancels a trip
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    expect(reduce(walking, { type: 'key', key: 'Escape', t: 2100, robotFocused: false }).state.mode).toBe('wandering')
  })

  it('click robot again cancels', () => {
    const r = feed(ready(), ...click(2000))
    expect(r.state.mode).toBe('wandering')
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_IDLE })
  })

  it('keyboard', () => {
    const r = reduce(initialState(false), { type: 'key', key: 'Enter', t: 50, robotFocused: true })
    expect(r.state.mode).toBe('ready')
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_READY_FINE })
    expect(reduce(initialState(false), { type: 'key', key: ' ', t: 50, robotFocused: true }).state.mode).toBe('ready')
    expect(reduce(r.state, { type: 'key', key: 'Enter', t: 60, robotFocused: true }).state.mode).toBe('wandering') // toggles
    expect(reduce(initialState(false), { type: 'key', key: 'Enter', t: 50, robotFocused: false }).effects).toEqual([])
  })

  it('activating the robot (assistive tech, Voice Control) toggles ready as a click does', () => {
    const r = reduce(initialState(true), { type: 'activate', t: 70 })
    expect(r.state).toMatchObject({ mode: 'ready', readySince: 70 })
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_READY_COARSE })
    expect(reduce(r.state, { type: 'activate', t: 90 }).state.mode).toBe('wandering')
  })

  it('hint hides after first success', () => {
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    const arrived = reduce(walking, { type: 'arrived', t: 4000 })
    expect(arrived.state).toMatchObject({ mode: 'arrived', hintHidden: true, arrivedAt: 4000 })
    const later = feed(
      arrived.state,
      ...click(5000),
      { type: 'key', key: 'Escape', t: 6000, robotFocused: false },
      { type: 'key', key: 'Enter', t: 6100, robotFocused: true },
      { type: 'tick', t: 6100 + READY_TIMEOUT_MS },
      ...click(20000),
      { type: 'pageClick', x: 5, y: 5, t: 21000 },
      { type: 'noRoute', t: 21001 },
    )
    expect(hints(later.effects).length).toBeGreaterThan(3)
    expect(hints(later.effects).every((t) => t === null)).toBe(true)
  })

  it('arrived dwell', () => {
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    const s = reduce(walking, { type: 'arrived', t: 4000 }).state
    expect(reduce(s, { type: 'tick', t: 4000 + ARRIVED_DWELL_MS - 1 }).state.mode).toBe('arrived')
    expect(reduce(s, { type: 'tick', t: 4000 + ARRIVED_DWELL_MS }).state.mode).toBe('wandering')
  })

  it('no route goes back to wandering with the hint, still unsuccessful', () => {
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    const r = reduce(walking, { type: 'noRoute', t: 2001 })
    expect(r.state).toMatchObject({ mode: 'wandering', hintHidden: false })
    expect(r.effects).toContainEqual({ type: 'hint', text: HINT_IDLE })
  })

  it('a click on the robot while walking or arrived gets it ready again', () => {
    const walking = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    expect(feed(walking, ...click(2500)).state.mode).toBe('ready')
    const arrived = reduce(walking, { type: 'arrived', t: 4000 }).state
    expect(feed(arrived, ...click(4500)).state).toMatchObject({ mode: 'ready', readySince: 4580 })
  })

  it('walking hides the hint until it arrives or gives up', () => {
    const r = reduce(ready(), { type: 'pageClick', x: 1, y: 1, t: 2000 })
    expect(hints(r.effects)).toEqual([null])
  })

  it('stray events change nothing', () => {
    const s = initialState(false)
    for (const e of [
      { type: 'robotUp', x: 0, y: 0, t: 1 },
      { type: 'robotMove', x: 50, y: 0, t: 1 },
      { type: 'arrived', t: 1 },
      { type: 'recovered', t: 1 },
      { type: 'noRoute', t: 1 },
      { type: 'tick', t: 99999 },
      { type: 'key', key: 'Escape', t: 1, robotFocused: true },
    ] as CtlEvent[])
      expect(reduce(s, e)).toEqual({ state: s, effects: [] })
  })

  describe('reduced motion', () => {
    const still = () => initialState(false, true)

    it('starts as the preference says', () => {
      expect(initialState(false).still).toBe(false)
      expect(still()).toMatchObject({ mode: 'wandering', still: true })
      expect(reduce(initialState(false), { type: 'still', on: true })).toEqual({ state: still(), effects: [] })
      expect(reduce(still(), { type: 'still', on: false })).toEqual({ state: initialState(false), effects: [] })
    })

    it('a drag on the robot never pushes it, and is not a click', () => {
      const r = feed(still(), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotMove', x: 50, y: -20, t: 30 }, { type: 'robotMove', x: 80, y: -30, t: 60 })
      expect(r.effects).toEqual([])
      expect(r.state).toMatchObject({ mode: 'wandering', dragging: false })
      const up = reduce(r.state, { type: 'robotUp', x: 80, y: -30, t: 90 })
      expect(up.effects).toEqual([])
      expect(up.state).toMatchObject({ mode: 'wandering', down: null, dragging: false })
    })

    it('a click on the robot still gets it ready, and out of ready again', () => {
      const s = feed(still(), ...click(1000)).state
      expect(s.mode).toBe('ready')
      expect(feed(s, ...click(2000)).state.mode).toBe('wandering')
    })

    it('turned on or off, a press under way is dropped: its release is no click', () => {
      for (const on of [true, false]) {
        let s = reduce(on ? initialState(false) : still(), { type: 'robotDown', x: 0, y: 0, t: 0 }).state
        s = reduce(s, { type: 'still', on }).state
        expect(s).toMatchObject({ still: on, down: null, last: null, dragging: false })
        expect(reduce(s, { type: 'robotUp', x: 1, y: 1, t: 50 })).toEqual({ state: s, effects: [] })
      }
    })
  })

  it('deadline: when the controller next changes by itself, for a tick then', () => {
    expect(deadline(initialState(false))).toBeNull()
    const s = ready()
    expect(deadline(s)).toBe(s.readySince + READY_TIMEOUT_MS)
    expect(reduce(s, { type: 'tick', t: deadline(s)! - 1 }).state.mode).toBe('ready')
    expect(reduce(s, { type: 'tick', t: deadline(s)! }).state.mode).toBe('wandering')
    const walking = reduce(s, { type: 'pageClick', x: 1, y: 1, t: 2000 }).state
    expect(deadline(walking)).toBeNull()
    const arrived = reduce(walking, { type: 'arrived', t: 4000 }).state
    expect(deadline(arrived)).toBe(4000 + ARRIVED_DWELL_MS)
    expect(reduce(arrived, { type: 'tick', t: deadline(arrived)! }).state.mode).toBe('wandering')
    const pushed = feed(initialState(false), { type: 'robotDown', x: 0, y: 0, t: 0 }, { type: 'robotMove', x: 20, y: 0, t: 16 }).state
    expect(deadline(pushed)).toBeNull()
  })
})
