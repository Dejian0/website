// Test hooks for the e2e specs. main.ts installs them only under import.meta.env.DEV, so the
// production build drops this module.
import type { Rect, Surface } from './terrain/terrain.ts'
import type { PaintedLine, TextFlow } from './text/flow.ts'

export interface SiteHooks {
  /**
   * x, y: page px of the walker's ground point under the body centre (where it stands, or will
   * land while the scroll transition runs); p: transition progress, 0 in the hero to 1 walking;
   * silhouette: the walker's, page px; lift: how far its highest foot is off the ground (px);
   * hop: the hop it is in (surfaces from and to), or null. Pushed, x and y are where the push has
   * it, push its phase and tilt (rad, clockwise), and surface the line it stood on while held or
   * landed on (null in the air). roaming: where it is wandering to, while on its way (else null).
   */
  robot(): {
    x: number
    y: number
    mode: string
    p: number
    surface: number | null
    silhouette: Rect
    lift: number
    hop: { from: number; to: number } | null
    push: { phase: string; tilt: number } | null
    roaming: { surface: number; x: number } | null
  }
  /**
   * The scroll transition's flight to where the walker waits, once planned (at p < 1): the lane's
   * body-centre x (page px), and whether the flight is clean, never crossing text, every line it
   * walks in past parting around it all the way. null until planned for the walker as it is.
   */
  route(): { lane: number; clear: boolean } | null
  /** Every painted line of every flow, in page order. */
  painted(): PaintedLine[]
  /**
   * The pieces of the painted lines, and of the lines under the list headings (flow
   * `rule-<section>`, line 0), where the robot can stand, in page order; each has at least one.
   */
  surfaces(): Surface[]
  /** Time scale for the robot's motion: 1 is normal, 0 stops it. */
  setSpeed(mult: number): void
  /** The TextFlow painting `p[data-flow=id]` (follows re-layout). */
  flow(id: string): TextFlow | undefined
  /** Since load: partings that hid a word (must stay 0) and the largest left shift of a line's start (px). */
  parting(): { hidden: number; maxLeftShift: number }
  /** Stands the robot on `surface` near page x, facing right, and lets it wander from there (ending any trip). */
  place(surface: number, x: number): void
  /** Sends the robot to the reachable point nearest page (x, y), as a click there in ready mode would. */
  send(x: number, y: number): void
  /**
   * Presses on the robot (the middle of its silhouette), drags the pointer by (dx, dy) px, holds
   * it there `ms` of the robot's own time and lets go, as a pointer moving (dx, dy) in ms would:
   * the push then flies at that velocity (frame-exact with setSpeed(0) and advance).
   */
  flick(dx: number, dy: number, ms: number): void
  /**
   * Advances the robot by `seconds` of its own time, as one frame at speed 1 would, and draws it:
   * for frame-exact measurements (setSpeed(0) first, so the frame loop holds it meanwhile).
   */
  advance(seconds: number): void
}

export function installDebug(hooks: SiteHooks): void {
  Object.assign(window, { __site: hooks })
}
