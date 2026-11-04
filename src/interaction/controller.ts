// The click-to-go interaction as a pure state machine: input events in, a new state and the
// effects to carry out out. main.ts feeds it pointer, click, key and frame events and does
// the effects (hint text, trips, push hooks).

export const READY_TIMEOUT_MS = 8000, DRAG_THRESHOLD_PX = 6, ARRIVED_DWELL_MS = 3000
export const HINT_IDLE = 'Tell the robot where to go', HINT_READY_FINE = 'Click anywhere', HINT_READY_COARSE = 'Tap anywhere'
/** The robot button's accessible name. */
export const ROBOT_LABEL = 'Robot. Press Enter, then click anywhere to send it there.'

/**
 * wandering: on its own. ready: stopped, waiting for a click anywhere to say where to go.
 * walking: on a trip there. arrived: settling at the target before it wanders on. pushed:
 * held or flung by the pointer, until `recovered`; then it goes back to what it was doing.
 */
export type Mode = 'wandering' | 'ready' | 'walking' | 'arrived' | 'pushed'

export interface CtlState {
  mode: Mode
  /** A coarse pointer (touch): the ready hint says tap, not click. */
  coarse: boolean
  readySince: number
  /** Set once the robot has arrived somewhere it was sent: the hint stays hidden from then on. */
  hintHidden: boolean
  arrivedAt: number
  /** Where a press on the robot started; while dragging, the older of the two samples the release velocity is taken over. */
  down: { x: number; y: number; t: number } | null
  /** The press moved past DRAG_THRESHOLD_PX: it pushes the robot rather than clicking it. */
  dragging: boolean
  /** The latest pointer sample of the press. */
  last: { x: number; y: number; t: number } | null
  /** What a push interrupted, to go back to once it recovers: a trip, waiting in ready mode, or wandering. */
  resume: Mode
  /** Page (x, y) the last trip was sent to: a trip a push interrupted is planned there again. */
  target: { x: number; y: number } | null
  /** Reduced motion (prefers-reduced-motion: reduce): a drag on the robot never pushes it. */
  still: boolean
}

/**
 * Times are ms, positions page px. robotCancel: the browser took the press over (a touch
 * scroll, say), so it is neither a click nor a push still held. activate: the robot's default
 * action with no press or key (a screen reader's browse mode, TalkBack, Voice Control), as a
 * click on it. noRoute: a trip could not be made (or the layout changed under it). recovered:
 * a push is over and the robot stands; lost: the layout changed under the push, which ended it.
 * still: reduced motion turned on or off (a press under way is dropped).
 */
export type CtlEvent =
  | { type: 'robotDown' | 'robotMove' | 'robotUp' | 'robotCancel'; x: number; y: number; t: number }
  | { type: 'pageClick'; x: number; y: number; t: number }
  | { type: 'key'; key: string; t: number; robotFocused: boolean }
  | { type: 'tick'; t: number } | { type: 'arrived'; t: number } | { type: 'recovered'; t: number; lost?: boolean }
  | { type: 'activate'; t: number } | { type: 'noRoute'; t: number } | { type: 'still'; on: boolean }

/**
 * hint: show this text (null: hide it). goTo: plan and start a trip to page (x, y). pushStart:
 * a press at page (x, y) takes hold of the robot; pushMove: the pointer is at (x, y);
 * pushRelease: let go, with the pointer's velocity (px/s).
 */
export type Effect =
  | { type: 'hint'; text: string | null } | { type: 'goTo'; x: number; y: number } | { type: 'preventDefault' }
  | { type: 'pushStart'; x: number; y: number } | { type: 'pushMove'; x: number; y: number } | { type: 'pushRelease'; vx: number; vy: number }

// The release velocity is taken over the last VELOCITY_WINDOW_MS or so of the drag; a pointer
// held still longer than that before letting go releases at rest.
const VELOCITY_WINDOW_MS = 60

export function initialState(coarse: boolean, still = false): CtlState {
  return { mode: 'wandering', coarse, readySince: 0, hintHidden: false, arrivedAt: 0, down: null, dragging: false, last: null, resume: 'wandering', target: null, still }
}

/**
 * When the controller next changes by itself (ms): a tick then or later ends the wait in ready
 * mode or the dwell after arriving. Null: only an event changes it.
 */
export function deadline(s: CtlState): number | null {
  if (s.mode === 'ready') return s.readySince + READY_TIMEOUT_MS
  if (s.mode === 'arrived') return s.arrivedAt + ARRIVED_DWELL_MS
  return null
}

type Result = { state: CtlState; effects: Effect[] }

const hint = (s: CtlState, text: string): Effect => ({ type: 'hint', text: s.hintHidden ? null : text })
const none = (s: CtlState): Result => ({ state: s, effects: [] })

function toReady(s: CtlState, t: number): Result {
  const state: CtlState = { ...s, mode: 'ready', readySince: t }
  return { state, effects: [hint(state, s.coarse ? HINT_READY_COARSE : HINT_READY_FINE)] }
}

function toWandering(s: CtlState): Result {
  const state: CtlState = { ...s, mode: 'wandering' }
  return { state, effects: [hint(state, HINT_IDLE)] }
}

/** A click on the robot, or Enter/Space on it: ready, or out of ready again. */
function toggle(s: CtlState, t: number): Result {
  if (s.mode === 'ready') return toWandering(s)
  if (s.mode === 'pushed') return none(s)
  return toReady(s, t)
}

export function reduce(s: CtlState, e: CtlEvent): Result {
  switch (e.type) {
    case 'robotDown': {
      const p = { x: e.x, y: e.y, t: e.t }
      return none({ ...s, down: p, last: p, dragging: false })
    }
    case 'robotMove': {
      if (!s.down) return none(s)
      const p = { x: e.x, y: e.y, t: e.t }
      if (s.dragging) {
        const down = e.t - s.down.t > VELOCITY_WINDOW_MS ? s.last : s.down
        return { state: { ...s, down, last: p }, effects: [{ type: 'pushMove', x: e.x, y: e.y }] }
      }
      // with reduced motion a drag does nothing (and its release is no click: robotUp)
      if (s.still || Math.hypot(e.x - s.down.x, e.y - s.down.y) <= DRAG_THRESHOLD_PX) return none({ ...s, last: p })
      return {
        // pushed again before it recovered: it still goes back to what the first push interrupted
        state: { ...s, mode: 'pushed', dragging: true, last: p, resume: s.mode === 'pushed' ? s.resume : s.mode },
        effects: [
          { type: 'pushStart', x: s.down.x, y: s.down.y },
          { type: 'pushMove', x: e.x, y: e.y },
          { type: 'hint', text: null }, // hidden while it is pushed
        ],
      }
    }
    case 'robotUp':
    case 'robotCancel': {
      if (!s.down) return none(s)
      const released: CtlState = { ...s, down: null, last: null, dragging: false }
      if (s.dragging) {
        const from = s.down
        const dt = e.t - from.t
        const moving = e.type === 'robotUp' && dt > 0 && e.t - s.last!.t <= VELOCITY_WINDOW_MS
        const v = moving ? { vx: ((e.x - from.x) / dt) * 1000, vy: ((e.y - from.y) / dt) * 1000 } : { vx: 0, vy: 0 }
        return { state: released, effects: [{ type: 'pushRelease', ...v }] }
      }
      if (e.type === 'robotCancel' || Math.hypot(e.x - s.down.x, e.y - s.down.y) > DRAG_THRESHOLD_PX) return none(released)
      return toggle(released, e.t)
    }
    case 'pageClick': {
      if (s.mode !== 'ready') return none(s) // links and text selection work as usual
      return {
        state: { ...s, mode: 'walking', target: { x: e.x, y: e.y } },
        // goTo last: what the trip reports at once (no route, already there) comes after
        effects: [{ type: 'preventDefault' }, { type: 'hint', text: null }, { type: 'goTo', x: e.x, y: e.y }],
      }
    }
    case 'key': {
      if (e.key === 'Escape') {
        if (s.mode === 'pushed') return none({ ...s, resume: 'wandering' }) // it lets the trip or the wait go, once it recovers
        return s.mode === 'ready' || s.mode === 'walking' ? toWandering(s) : none(s)
      }
      if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && e.robotFocused) return toggle(s, e.t)
      return none(s)
    }
    case 'tick': {
      if (s.mode === 'ready' && e.t - s.readySince >= READY_TIMEOUT_MS) return toWandering(s)
      if (s.mode === 'arrived' && e.t - s.arrivedAt >= ARRIVED_DWELL_MS) return toWandering(s)
      return none(s)
    }
    case 'arrived': {
      if (s.mode !== 'walking') return none(s)
      return { state: { ...s, mode: 'arrived', arrivedAt: e.t, hintHidden: true }, effects: [{ type: 'hint', text: null }] }
    }
    case 'activate':
      return s.down ? none(s) : toggle(s, e.t)
    case 'recovered': {
      if (s.mode !== 'pushed') return none(s)
      // a trip goes on from where it landed (or gives up: noRoute), unless the layout it was
      // planned on is gone (as a re-layout ends a trip); a wait starts over
      if (s.resume === 'walking' && s.target && !e.lost) return { state: { ...s, mode: 'walking' }, effects: [{ type: 'goTo', ...s.target }] }
      if (s.resume === 'ready') return toReady(s, e.t)
      return toWandering(s)
    }
    case 'noRoute':
      return s.mode === 'walking' ? toWandering(s) : none(s)
    case 'still':
      return none({ ...s, still: e.on, down: null, last: null, dragging: false })
  }
}
