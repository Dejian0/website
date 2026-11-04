// DOM input for the interaction: presses on the robot, clicks and taps anywhere, keys, as
// controller events. The session reduces them and carries out the effects, preventDefault on
// the DOM event among them.
import type { CtlEvent } from './controller.ts'

export interface InputHooks {
  /** Whether the robot takes input now: once it stands in the text (p = 1). */
  live(): boolean
  /** Whether a press on the robot is in progress (the controller saw robotDown). */
  pressing(): boolean
  send(e: CtlEvent, dom: Event): void
}

const TAP_PX = 10 // a touch that moves less than this...
const TAP_MS = 800 // ...and lifts within this is a tap
const TAP_CLICK_MS = 1000 // the click a browser may send after a tap comes within this
const KEY_CLICK_MS = 500 // a click on the robot this soon after Enter/Space toggled it is that key's echo

export function listen(robot: SVGSVGElement, h: InputHooks): void {
  // the click that ends a press begun on the robot is the robot's own (its pointer events have it);
  // a press that ends with no click (a touch drag, or the browser taking it over to scroll) must
  // not leave this set, or the next click on the robot with no press (assistive tech) is lost
  let fromRobot = false
  // iOS Safari need not send a click for a tap on text with no click handler of its own, so a
  // touch tap is taken from its pointer events; the click that may follow it is then swallowed
  let tap: { x: number; y: number; t: number; id: number } | null = null
  let swallowUntil = -Infinity
  let keyToggled = -Infinity // when Enter or Space last toggled the robot
  document.addEventListener(
    'pointerdown',
    (e) => {
      fromRobot = robot.contains(e.target as Node)
      swallowUntil = -Infinity // a new press: the last tap's click came already, or never will
      tap = e.pointerType === 'touch' && e.isPrimary && !fromRobot ? { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId } : null
    },
    { capture: true },
  )
  document.addEventListener(
    'pointercancel',
    () => {
      tap = null // it became a scroll: no click follows
      fromRobot = false
    },
    { capture: true },
  )
  document.addEventListener(
    'pointerup',
    (e) => {
      const t = tap
      tap = null
      if (!t || e.pointerId !== t.id || !h.live()) return
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TAP_PX || e.timeStamp - t.t > TAP_MS) return
      h.send({ type: 'pageClick', x: e.pageX, y: e.pageY, t: e.timeStamp }, e)
      if (e.defaultPrevented) swallowUntil = e.timeStamp + TAP_CLICK_MS // it set a target: its click must not follow a link
    },
    { capture: true },
  )

  robot.addEventListener('pointerdown', (e) => {
    if (!h.live() || !e.isPrimary || e.button !== 0) return
    e.preventDefault() // a press on the robot selects no text and moves no focus
    robot.setPointerCapture(e.pointerId) // a drag off the robot still reaches it
    h.send({ type: 'robotDown', x: e.pageX, y: e.pageY, t: e.timeStamp }, e)
  })
  const press = [['pointermove', 'robotMove'], ['pointerup', 'robotUp'], ['pointercancel', 'robotCancel']] as const
  for (const [name, type] of press)
    robot.addEventListener(name, (e) => {
      if (h.pressing() && e.isPrimary) h.send({ type, x: e.pageX, y: e.pageY, t: e.timeStamp }, e)
    })

  document.addEventListener(
    'click',
    (e) => {
      // a click with no press (detail 0) never ends one, whatever press came before it
      const own = fromRobot && e.detail > 0
      fromRobot = false
      if (own) return
      if (robot.contains(e.target as Node)) {
        // no press behind it: the robot's default action from assistive tech (a screen reader's
        // browse mode, TalkBack, Voice Control), unless it echoes a key that already toggled it
        if (e.detail === 0 && !h.pressing() && h.live() && e.timeStamp - keyToggled > KEY_CLICK_MS) h.send({ type: 'activate', t: e.timeStamp }, e)
        return
      }
      if (e.timeStamp <= swallowUntil) {
        swallowUntil = -Infinity
        return e.preventDefault()
      }
      if (!h.live() || e.detail === 0) return // a link activated from the keyboard is followed as usual
      h.send({ type: 'pageClick', x: e.pageX, y: e.pageY, t: e.timeStamp }, e)
    },
    { capture: true },
  )

  document.addEventListener('keydown', (e) => {
    const focused = document.activeElement === robot
    const toggle = e.key === 'Enter' || e.key === ' '
    if (e.key !== 'Escape' && !(toggle && focused && h.live())) return
    if (toggle) {
      e.preventDefault() // Space would scroll the page
      if (e.repeat) return // held down, it toggles once, not at the key-repeat rate
      keyToggled = e.timeStamp
    }
    h.send({ type: 'key', key: e.key, t: e.timeStamp, robotFocused: focused }, e)
  })
}
