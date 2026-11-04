// The interaction at run time: the controller's state and the effects it asks for, the trip
// under way, the push under way, the ready look, and the hint and dotted path on the page.
// main.ts owns the robot (its walker) and the frame loop, and hands them in.
// With reduced motion (still) nothing runs frame by frame: a trip is planned as ever but not
// walked, and main.ts puts the robot at its target out of sight (arrive, in a dip: still.ts).
import { WANDER_SPEED } from '../robot/gait.ts'
import type { RobotPose } from '../robot/model.ts'
import { landing, pushPose, releasePush, runPush, startPush, type PushState } from '../robot/push.ts'
import { lookUp, standAt, standStill, walkerAt, walkerPose, wander, type Terrain, type Walker } from '../robot/walker.ts'
import { nearestPoint, type Rect, type TerrainPoint } from '../terrain/terrain.ts'
import { deadline, HINT_IDLE, initialState, reduce, ROBOT_LABEL, type CtlEvent, type CtlState } from './controller.ts'
import { Hint } from './hint.ts'
import { pathLength, PathOverlay } from './path-overlay.ts'
import { pickLeg, restFor } from './roam.ts'
import { planTrip, stepTrip, tripPath, tripStart, type RouteChecks, type Trip } from './trip.ts'

const LOOK_S = 0.25 // s the ready look takes to come on or go
const RETRY_S = 2 // s it wanders the old way (along its lines) when no leg works, before trying again

export interface Host {
  /** The terrain the robot walks on now. */
  terrain(): Terrain
  /** What a route on it must pass. */
  checks(): RouteChecks
  /** The part of the page in view (page px): where the robot wanders to. */
  view(): Rect
  /** Asks for a frame. */
  frame(): void
}

/** Where and how to draw the robot: its ground point (page px), facing, pose, and how much lower (body lengths). */
export interface Look {
  x: number
  y: number
  facing: 1 | -1
  pose: RobotPose
  drop: number
  /**
   * Pushed, the only text that parts: the lines above this point, as for the robot standing
   * there (the line it stood on while it is held, the line it lands on once it lands); null in
   * the air: no line parts, and the words stay in front of it. Not pushed (undefined), the text
   * parts around the robot as drawn.
   */
  stand?: TerrainPoint | null
}

/** A push under way: the dynamics, and how it took hold. */
interface Push {
  s: PushState
  facing: 1 | -1
  /** The pose (and drop) it was drawn in as it took hold, which the push's pose blends from. */
  from: { pose: RobotPose; drop: number }
  /** The robot's ground point less the pointer where it took hold, and where the pointer now pulls the ground point. */
  grip: { x: number; y: number }
  pull: { x: number; y: number }
  /** The surface it stood on as it took hold (null in the air): its line parts around it while it is held. */
  stood: number | null
  vdir: 1 | -1
}

export class Session {
  ctl: CtlState
  private trip: Trip | null = null
  private tripLength = 0 // px: the trip's whole path, so its dashes stay put as it erodes
  private raise = 0 // 0..1: how far into the ready look (head up)
  private push: Push | null = null
  private readonly hint = new Hint()
  private readonly path = new PathOverlay()
  private timer = 0 // reduced motion: asks for a frame when the controller's wait or dwell is up
  // wandering (roam.ts): the leg it walks, else how long it stands first, or wanders the old way
  private leg: Trip | null = null
  private rest = 0
  private retry = 0

  /**
   * Makes `robot` (the live robot's SVG) a button and puts the hint and the path on the page.
   * still: reduced motion to begin with (setStill changes it). random: where it wanders to.
   */
  constructor(
    private readonly host: Host,
    private readonly robot: SVGSVGElement,
    coarse: boolean,
    still: boolean,
    private readonly random: () => number = Math.random,
  ) {
    this.ctl = initialState(coarse, still)
    robot.removeAttribute('aria-hidden') // a button now; its paths stay hidden
    robot.setAttribute('role', 'button')
    robot.setAttribute('tabindex', '0')
    robot.setAttribute('aria-label', ROBOT_LABEL)
    robot.setAttribute('aria-pressed', 'false')
    robot.setAttribute('aria-disabled', 'true') // until it stands in the text (show)
    document.body.prepend(this.path.el) // under the painted text (positioned, later) and the robot
    this.hint.set(HINT_IDLE) // the controller starts out wandering
  }

  /** The push under way, if any (debug). */
  get pushed(): PushState | null {
    return this.push?.s ?? null
  }

  /** Where the robot is wandering to, if it is on its way (debug). */
  get roamingTo(): TerrainPoint | null {
    return this.leg?.to ?? null
  }

  /** Reduced motion: a trip is planned and waits for main.ts to put the robot there (arrive). */
  get going(): boolean {
    return this.ctl.still && this.trip !== null
  }

  /**
   * Reduced motion on or off; returns the robot, `w`, as it now stands. Turned on, a push or a
   * trip under way ends (as a re-layout ends them) and it stands still where it is, feet down
   * (in the air, where it would have landed). Turned off, a trip waiting to arrive arrives.
   */
  setStill(on: boolean, w: Walker | null): Walker | null {
    if (on === this.ctl.still) return w
    this.endLeg()
    if (w && on) {
      this.relaid(w)
      const t = this.host.terrain()
      const at = tripStart(w, t)
      w = standAt(t, at, at.facing ?? walkerAt(w, t).facing, w.vdir)
    } else if (w) w = this.arrive(w)
    this.dispatch({ type: 'still', on }, w)
    return w
  }

  /**
   * Reduced motion: the robot as it stands at the trip's target, facing the way it went, the
   * trip over and arrived. main.ts calls it with the robot out of sight. `w` if no trip waits.
   */
  arrive(w: Walker): Walker {
    if (!this.trip) return w
    const t = this.host.terrain()
    const from = walkerAt(w, t)
    const to = this.trip.to
    const there = standAt(t, to, to.x === from.x ? from.facing : to.x > from.x ? 1 : -1, w.vdir)
    this.endTrip()
    this.dispatch({ type: 'arrived', t: performance.now() }, there)
    return there
  }

  /** Feeds the controller an event and carries out the effects; `w`: the robot now, which a trip or a push starts from. */
  dispatch(e: CtlEvent, w: Walker | null, dom?: Event): void {
    const was = this.ctl.mode
    const r = reduce(this.ctl, e)
    this.ctl = r.state
    for (const f of r.effects) {
      if (f.type === 'hint') this.hint.set(f.text)
      else if (f.type === 'preventDefault') dom?.preventDefault()
      else if (f.type === 'goTo') this.goTo(f.x, f.y, w)
      else if (f.type === 'pushStart') this.takeHold(f.x, f.y, w)
      else if (f.type === 'pushMove' && this.push) this.push.pull = { x: f.x + this.push.grip.x, y: f.y + this.push.grip.y }
      else if (f.type === 'pushRelease' && this.push) this.push.s = releasePush(this.push.s, f.vx, f.vy)
    }
    if (this.ctl.mode !== 'walking' && this.trip) this.endTrip()
    if (this.ctl.mode !== 'wandering') this.endLeg() // back to wandering, it picks a new leg from where it is then
    if (this.ctl.mode !== was || r.effects.length > 0) {
      this.robot.setAttribute('aria-pressed', String(this.ctl.mode === 'ready'))
      this.host.frame()
    }
    this.wake()
  }

  /** Reduced motion, where no frames run meanwhile: a frame (and its tick) once the controller's deadline comes. */
  private wake(): void {
    clearTimeout(this.timer)
    const due = this.ctl.still ? deadline(this.ctl) : null
    if (due !== null) this.timer = window.setTimeout(() => this.host.frame(), Math.max(0, due - performance.now()))
  }

  /** One frame of what the robot is doing, dt seconds (scaled), at time `now` (ms). With reduced motion nothing moves. */
  step(w: Walker, dt: number, now: number): Walker {
    if (this.ctl.still) return w
    const t = this.host.terrain()
    const mode = this.ctl.mode
    if (mode === 'wandering') w = this.roam(w, t, dt)
    else if (mode === 'walking' && this.trip) {
      const r = stepTrip(this.trip, w, t, dt)
      this.trip = r.trip
      w = r.walker
      if (r.state !== 'going') {
        this.endTrip()
        this.dispatch(r.state === 'arrived' ? { type: 'arrived', t: now } : { type: 'noRoute', t: now }, w)
      }
    } else if (mode === 'pushed' && this.push) w = this.stepPushed(w, t, dt, now)
    else w = standStill(w, t, dt) // ready, arrived: feet down, then still
    // head up while it waits, once on its feet
    const want = this.ctl.mode === 'ready' && w.kind === 'walk' ? 1 : 0
    this.raise = want > this.raise ? Math.min(want, this.raise + dt / LOOK_S) : Math.max(want, this.raise - dt / LOOK_S)
    return w
  }

  /**
   * One frame of wandering: walks its leg at wander speed (no path drawn); arrived, stands a
   * moment, then picks the next leg in view. With no leg to be had it wanders the old way, along
   * its lines, a while before trying again.
   */
  private roam(w: Walker, t: Terrain, dt: number): Walker {
    if (!(dt > 0)) return w // no time passes (a first frame, or held still): it sets off on nothing
    if (this.leg) {
      const r = stepTrip(this.leg, w, t, dt, WANDER_SPEED)
      this.leg = r.state === 'going' ? r.trip : null
      if (r.state === 'arrived') this.rest = restFor(this.random)
      return r.walker // lost (it was moved): the next frame picks a leg from where it is
    }
    if (this.rest > 0) {
      this.rest -= dt
      return standStill(w, t, dt)
    }
    if (this.retry > 0) {
      this.retry -= dt
      return wander(w, t, dt)
    }
    const plan = pickLeg(t, tripStart(w, t), this.host.view(), this.host.checks(), this.random)
    if (!plan) {
      this.retry = RETRY_S
      return wander(w, t, dt)
    }
    this.leg = { ...plan, i: 0 }
    return this.roam(w, t, dt)
  }

  private endLeg(): void {
    this.leg = null
    this.rest = 0
    this.retry = 0
  }

  /** Where and how to draw `w`: as it walks (with the ready look on top), or as the push has it. */
  look(w: Walker): Look {
    const t = this.host.terrain()
    const p = this.push
    if (!p) {
      const k = this.ctl.still ? Number(this.ctl.mode === 'ready') : this.raise // reduced motion: the look comes and goes at once
      const at = walkerAt(w, t)
      return { x: at.x, y: at.y, facing: at.facing, ...lookUp(walkerPose(w), k * k * (3 - 2 * k)) }
    }
    return { x: p.s.x, y: p.s.y, facing: p.facing, ...pushPose(p.s, p.facing, p.from), stand: this.standing(p, t) }
  }

  /**
   * Shows the robot as a button, with its hint and trip path, only while it stands in the text
   * (`live`: p = 1, or with reduced motion once it shows there); off it the look resets so the
   * hand-off at p = 1 draws exactly the walker, and the button says it does nothing yet
   * (aria-disabled). sil: the robot's silhouette as drawn; column, text: the text column's left
   * edge and every line of text (page px), for the hint. Reduced motion draws no path.
   */
  show(w: Walker | null, sil: Rect, column: number, text: Rect[], live: boolean): void {
    if (!live) this.raise = 0
    if (this.robot.classList.contains('live') !== live) {
      this.robot.classList.toggle('live', live)
      if (live) this.robot.removeAttribute('aria-disabled')
      else this.robot.setAttribute('aria-disabled', 'true')
    }
    const held = this.push?.s.phase === 'dragging'
    if (this.robot.classList.contains('held') !== held) this.robot.classList.toggle('held', held)
    this.hint.place(sil, column, text, live)
    if (!this.trip || !w || !live || this.ctl.still) return this.path.clear()
    const pts = tripPath(this.trip, w, this.host.terrain())
    this.path.draw(pts, this.tripLength - pathLength(pts))
  }

  /**
   * The layout changed: a trip on the old surfaces can't go on, nor a push in the old page px
   * (its lines may all be above it now). It stands where the re-layout put it, `w`, and recovers.
   */
  relaid(w: Walker | null): void {
    this.endLeg() // its moves were on the old surfaces
    if (this.push) {
      this.push = null
      this.dispatch({ type: 'recovered', t: performance.now(), lost: true }, w)
    }
    if (!this.trip) return
    this.endTrip()
    this.dispatch({ type: 'noRoute', t: performance.now() }, w)
  }

  /**
   * A press at page (px, py) takes hold of the robot where it is drawn: standing, mid-hop, or
   * mid-push (taken hold of again, it keeps its tilt).
   */
  private takeHold(px: number, py: number, w: Walker | null): void {
    if (!w) return
    const at = this.look(w)
    const was = this.push
    const s = startPush(at.x, at.y)
    this.push = {
      s: was ? { ...s, tilt: was.s.tilt, vtilt: was.s.vtilt } : s,
      facing: at.facing,
      from: { pose: at.pose, drop: at.drop },
      grip: { x: at.x - px, y: at.y - py },
      pull: { x: at.x, y: at.y },
      stood: at.stand === undefined ? (w.kind === 'walk' ? w.surface : null) : (at.stand?.surface ?? null),
      vdir: was?.vdir ?? w.vdir,
    }
  }

  /** Runs the push dt seconds (runPush). Once it stands, it is a walker again, exactly where it landed, and recovers. */
  private stepPushed(w: Walker, t: Terrain, dt: number, now: number): Walker {
    const p = this.push!
    p.s = runPush(p.s, dt, t.surfaces, p.pull)
    if (p.s.phase !== 'done') return w
    this.push = null
    // (nearestPoint is only a guard: a push lands on a standable piece)
    const at = landing(t.surfaces, p.s.x, p.s.y) ?? nearestPoint(t.surfaces, p.s.x, p.s.y)
    const stood = at ? standAt(t, at, p.facing, p.vdir) : w
    this.dispatch({ type: 'recovered', t: now }, stood)
    return stood
  }

  /** What the text parts around while pushed (see Look.stand). */
  private standing(p: Push, t: Terrain): TerrainPoint | null {
    if (p.s.phase === 'flying') return null
    if (p.s.phase !== 'dragging') return landing(t.surfaces, p.s.x, p.s.y)
    const s = p.stood === null ? undefined : t.surfaces[p.stood]
    return s?.standable ? { surface: s.id, x: Math.min(s.x1, Math.max(s.x0, p.s.x)) } : null
  }

  /**
   * Plans a trip to the reachable point nearest page (x, y) and shows its path at once. With
   * reduced motion it is not walked and has no path: it waits for arrive (already there, it
   * has arrived).
   */
  private goTo(x: number, y: number, w: Walker | null): void {
    const t = this.host.terrain()
    const plan = w && planTrip(t, tripStart(w, t), x, y, this.host.checks())
    if (!w || !plan) return this.dispatch({ type: 'noRoute', t: performance.now() }, w)
    this.trip = { ...plan, i: 0 }
    if (this.ctl.still) {
      if (plan.moves.length > 0) return // not walked: main.ts puts it there out of sight (arrive)
      this.endTrip()
      return this.dispatch({ type: 'arrived', t: performance.now() }, w) // there already: nothing to fade
    }
    const pts = tripPath(this.trip, w, t)
    this.tripLength = pathLength(pts)
    this.path.draw(pts, 0)
  }

  private endTrip(): void {
    this.trip = null
    this.path.clear()
  }
}
