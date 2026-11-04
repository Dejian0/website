import '@fontsource/inter-tight/400.css'
import '@fontsource/inter-tight/600.css'
import './style.css'
import { HERO_SCALE, HERO_STROKE, heroOrigin } from './build/hero-svg.ts'
import { installDebug } from './debug.ts'
import { listen } from './interaction/input.ts'
import { Session } from './interaction/session.ts'
import { dip, MIDPOINT } from './interaction/still.ts'
import type { RouteChecks } from './interaction/trip.ts'
import { revealEmail } from './page/email.ts'
import { Hairlines } from './page/hairlines.ts'
import { FLOW_FONTS, PageTerrain, sectionOf } from './page/terrain-wiring.ts'
import { robotFaces, standingPose, type RobotPose } from './robot/model.ts'
import { bounds, groundShadow, HERO_CAMERA, mirrorX, project, SHADOW, SIDE_CAMERA, type Polygon } from './robot/render.ts'
import { RobotSvg } from './robot/svg-dom.ts'
import { placeWalker, walkerAt, walkerReach, type Walker } from './robot/walker.ts'
import { lerpPose, lerpView, planLane, progress, scrollSpan, sideSwapped, turnYaw, type View } from './scroll/transition.ts'
import { EDGE } from './terrain/clearance.ts'
import type { Rect } from './terrain/terrain.ts'
import { TextFlow } from './text/flow.ts'

const FONT_TIMEOUT_MS = 3000
const STROKE = 1.1 // px; the hero uses HERO_STROKE

// first: the email link joins the links before anything measures them, painted text or not
revealEmail()

const sources = [...document.querySelectorAll<HTMLElement>('[data-flow]')]
const page = new PageTerrain(sources)
const hairlines = new Hairlines() // the lines under the headings and list rows, open where the robot crosses one
const heroSvg = document.querySelector<SVGSVGElement>('#robot-static')! // pre-rendered at build time

let robot: RobotSvg | null = null
let walker: Walker | null = null
let silhouette: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 } // the walker's, page px, from the last draw
let speed = 1 // time scale (debug)

// The interaction (src/interaction): what the robot is doing and the trip it is on; made at boot
let session: Session | null = null
let column = 0 // page x of the text column's left edge, for the hint
let text: Rect[] = [] // every line of text on the page (page px), for the hint

// The scroll transition. p runs from 0 (the hero) to 1 (the walker) over `span` of scrollY.
// While p < 1 the robot draws on its way between the two and everything it does is paused.
let hero: View | null = null
let span = { start: 0, end: 1 }
let p = 0
// the flight's lane, planned for a paused walker, and whether the flight down it is clean: it
// never crosses text, the lines it walks in past parting around it all the way (see planLane)
let route = { for: null as Walker | null, lane: 0, clear: false }
let room = { minX: 0, maxX: 0 } // page x the robot may use, from the last layout

// Reduced motion (interaction/still.ts): the robot never moves on screen. It shows in the hero
// or standing in the text (inText: past the midpoint; null until first drawn) and changes place
// only out of sight, in a dip (opacity): between the two, and to where a trip goes.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let reduced = reducedMotion.matches
let inText: boolean | null = null
let opacity = 1

/** Whether the robot stands in the text, so is a button: from p = 1, or with reduced motion while it shows there. */
const standsInText = () => !!walker && (reduced ? inText === true : p >= 1)

/** Page px snapped to the device pixel grid, as browsers place a replaced element such as an <svg>. */
const snap = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio

/** The view that lays the live robot exactly over #robot-static (viewBox, preserveAspectRatio meet). */
function heroView(svg: SVGSVGElement): View {
  const r = svg.getBoundingClientRect()
  const vb = svg.viewBox.baseVal
  const k = Math.min(r.width / vb.width, r.height / vb.height) // px per viewBox unit
  const o = heroOrigin()
  return {
    ...HERO_CAMERA,
    scale: HERO_SCALE * k,
    x: snap(r.left + scrollX) + (r.width - vb.width * k) / 2 + (o.x - vb.x) * k,
    y: snap(r.top + scrollY) + (r.height - vb.height * k) / 2 + (o.y - vb.y) * k,
    stroke: HERO_STROKE,
    shade: 1, // as the static one is drawn
  }
}

/** The robot standing in `pose` seen through view v, shaded as v says over its ground shadow. */
function drawView(pose: RobotPose, v: View): void {
  const shadow = v.shade > 0 ? { pts: groundShadow(v), blur: SHADOW.blur * v.scale } : undefined
  robot!.draw(project(robotFaces(pose), v), v.stroke, v.x, v.y, v.shade, shadow)
}

/** The lane beside the text that the flight to the walker's spot (ground point at, silhouette sil) drops down (see planLane). */
function routeFor(w: Walker, at: { x: number; y: number }, sil: Rect): typeof route {
  if (route.for !== w) {
    const reach = walkerReach()
    const s = page.terrain.scale
    const lane = planLane({
      text: page.textBoxes(),
      fixed: page.fixedText(),
      top: hero!.y,
      bottom: at.y,
      half: reach.half * s,
      height: reach.height * s,
      room,
      landing: at.x,
      walkIn: (x) => page.walkClear(x, at.x, sil.y0, sil.y1),
    })
    route = { for: w, lane: lane.x, clear: lane.clear }
  }
  return route
}

/** Re-lays the text and terrain out, re-anchors the robot and re-measures the transition, then redraws. */
function relayout(): void {
  walker = page.rebuild(walker)
  hairlines.measure()
  hero = heroView(heroSvg)
  span = { start: 0, end: scrollSpan(page.firstLineTop() ?? 0, innerHeight, document.documentElement.scrollHeight - innerHeight) }
  room = { minX: EDGE, maxX: document.documentElement.clientWidth - EDGE }
  route.for = null
  column = Math.min(...page.painted.map((l) => l.x))
  text = page.textBoxes()
  p = progress(scrollY, span.start, span.end)
  session?.relaid(walker) // a trip's moves were on the old surfaces
  draw()
  // the live robot takes over from the static one within this frame; with nowhere to stand, the static one stays
  robot!.el.style.visibility = walker ? '' : 'hidden'
  heroSvg.style.visibility = walker ? 'hidden' : '' // keeps its box, so the hero doesn't move
}

function draw(): void {
  if (!robot || !walker || !session) return showLive()
  const t = page.terrain
  const at = session.look(walker) // where the walker or the push has it
  const { pose } = at
  const y = at.y + at.drop * t.scale // drawn lower by the ready look's sit-back or a push's crouch (its pose keeps the feet down)
  const side = project(robotFaces(pose), { ...SIDE_CAMERA, scale: t.scale })
  const polys = at.facing === 1 ? side : mirrorX(side)
  const b = bounds(polys)
  silhouette = { x0: at.x + b.minX, y0: y + b.minY, x1: at.x + b.maxX, y1: y + b.maxY }
  if (reduced) return drawStill(polys, at.x, y)
  showLive()
  // pushed, only the line it stands or lands on parts, and nothing around it in the air (the words stay in front)
  if (at.stand) page.partStanding(at.stand)
  else if (at.stand === null) page.unpart()
  const pushed = at.stand !== undefined
  if (p >= 1 || !hero) {
    if (!pushed) page.partAround(silhouette, at.x) // the text makes room where the walker stands
    hairlines.open(silhouette) // pushed too: the robot is in front of them, in the air or not
    robot.draw(polys, STROKE, at.x, y)
    return
  }
  hairlines.open(null) // on its way, high above them
  // on its way: the hero's camera, size, place and standing pose blend into the walker's,
  // by a lane beside the text so it never flies through it
  const end: View = { yaw: turnYaw(at.facing), pitch: 0, scale: t.scale, x: at.x, y, stroke: STROKE, shade: 0 }
  const r = routeFor(walker, at, silhouette)
  const v = lerpView(hero, end, p, r.lane)
  // nothing parts until it walks in; then the lines it reaches part around it where they can, as
  // for the walker: walking in it is the walker's drawing at its height, moved along by v.x - at.x
  // (a push paused part-way, scrolled back mid-push, is parted as above)
  if (!pushed) {
    const dx = v.x - at.x
    page.partFlying(p, r.lane, v.x, { ...silhouette, x0: silhouette.x0 + dx, x1: silhouette.x1 + dx })
  }
  const toward = at.facing === 1 ? pose : sideSwapped(pose)
  drawView(lerpPose(standingPose(), toward, p), v)
}

/**
 * Reduced motion: in the hero as at p = 0, or standing in the text as at p = 1 (the walker's
 * `polys` at its ground point x, y), at the dip's opacity; never between. Part of draw().
 */
function drawStill(polys: Polygon[], x: number, y: number): void {
  inText ??= p >= MIDPOINT
  showLive()
  robot!.el.style.opacity = opacity < 1 ? String(opacity) : ''
  if (inText || !hero) {
    page.partAround(silhouette, x)
    hairlines.open(silhouette)
    return robot!.draw(polys, STROKE, x, y)
  }
  page.unpart()
  hairlines.open(null)
  drawView(standingPose(), hero)
}

/** Reduced motion: whether the robot is to show somewhere else, the other side of the midpoint or where a trip goes. */
const dipPending = () => session!.going || inText !== (p >= MIDPOINT)

/** Reduced motion: one frame of the dip, ms on; once out of sight the robot is put where it is to show. */
function stepDip(ms: number): void {
  const r = dip(opacity, dipPending(), ms)
  opacity = r.opacity
  if (!r.swap) return
  walker = session!.arrive(walker!)
  inText = p >= MIDPOINT
}

/** prefers-reduced-motion changed: the robot settles into the other mode where it is (see Session.setStill). */
function setReduced(on: boolean): void {
  if (on === reduced) return
  reduced = on
  if (!session) return // not booted yet: the session starts out this way
  walker = session.setStill(on, walker)
  inText = p >= MIDPOINT
  opacity = 1
  robot!.el.style.opacity = ''
  last = null
  draw()
  requestTick()
}

// --- frame loop: follows the scroll; walks unless the transition or an off-screen section pauses it ---
const sectionInView = new Map<string, boolean>() // section id -> intersecting

function shouldRun(): boolean {
  if (reduced) return !!walker && !!session && (opacity < 1 || dipPending()) // only while it fades
  // p < 1 pauses any mode (a Task 9 trip too); at p = 1 it resumes exactly as it stopped
  if (!walker || !session || p < 1) return false
  if (session.ctl.mode !== 'wandering') return true // a trip, or waiting, never pauses off-screen
  return sectionInView.get(sectionOf(page.surfaces[walkerAt(walker, page.terrain).surface]!.flow)) ?? false
}

let ticking = false // a frame is requested
let last: number | null = null // time of the last walking frame; null while paused

function requestTick(): void {
  if (ticking) return
  ticking = true
  requestAnimationFrame(tick)
}

function tick(now: number): void {
  ticking = false
  const q = progress(scrollY, span.start, span.end)
  const moved = q !== p
  p = q
  session?.dispatch({ type: 'tick', t: now }, walker)
  if (!shouldRun()) {
    last = null // stop requesting frames until a scroll, an observer or a re-layout asks again
    // with reduced motion a frame is asked for only when something changed (the ready look, the hint)
    if (moved || reduced) draw()
    return
  }
  const dt = last === null ? 0 : Math.min(0.1, Math.max(0, now - last) / 1000)
  last = now
  if (reduced) stepDip(dt * 1000) // in real time: a fade, not the robot's own motion
  else walker = session!.step(walker!, dt * speed, now) // shouldRun: there is a session
  draw()
  requestTick()
}

/** The robot is a button, with its hint and trip path, only while it stands in the text. Part of draw(). */
function showLive(): void {
  session?.show(walker, silhouette, column, text, standsInText())
}

/** What a trip's route is checked against: hops and walks the text can part around, and the text that can't. */
function routeChecks(): RouteChecks {
  const t = page.terrain
  const reach = walkerReach()
  const height = reach.height * t.scale
  return {
    hop: (h) => t.canHop?.(h) ?? true,
    walk: (i, x0, x1) => page.walkClear(x0, x1, t.surfaces[i]!.y - height, t.surfaces[i]!.y),
    fixed: page.fixedText(),
    half: reach.half * t.scale,
  }
}

let queued = false
/** Re-lays out (on the next frame) only if a column's width or place or the metrics changed. */
function scheduleRefresh(): void {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    if (!page.stale()) return // e.g. a phone's URL bar showing or hiding
    relayout()
    requestTick()
  })
}

if (import.meta.env.DEV) {
  installDebug({
    robot: () => {
      const at = walker && session?.look(walker)
      const feet = at ? at.pose.legs.map((l) => l.foot[1]) : [0]
      const lift = (Math.max(...feet) - Math.min(...feet)) * page.terrain.scale // the lowest foot is on the ground
      const mode = session?.ctl.mode ?? 'wandering'
      const hop = walker?.kind === 'hop' ? { from: walker.hop.from.surface, to: walker.hop.to.surface } : null
      const pushed = session?.pushed
      const push = pushed ? { phase: pushed.phase, tilt: pushed.tilt } : null
      const surface = !at ? null : at.stand === undefined ? walkerAt(walker!, page.terrain).surface : (at.stand?.surface ?? null)
      return { x: at?.x ?? NaN, y: at?.y ?? NaN, mode, p, surface, silhouette, lift, hop, push, roaming: session?.roamingTo ?? null }
    },
    route: () => (walker && route.for === walker ? { lane: route.lane, clear: route.clear } : null),
    painted: () => page.painted,
    surfaces: () => page.surfaces,
    setSpeed: (mult) => {
      speed = mult
    },
    flow: (id) => page.flow(id),
    parting: () => ({ ...page.parting }),
    place: (surface, x) => {
      walker = placeWalker(page.terrain, { surface, x }, 1)
      session?.relaid(walker) // a trip can't go on from somewhere else
      draw()
      requestTick()
    },
    send: (x, y) => {
      const s = session!
      if (s.ctl.mode !== 'ready') s.dispatch({ type: 'key', key: 'Enter', t: performance.now(), robotFocused: true }, walker)
      s.dispatch({ type: 'pageClick', x, y, t: performance.now() }, walker)
    },
    flick: (dx, dy, ms) => {
      if (!walker || !session || p < 1) return
      const x = (silhouette.x0 + silhouette.x1) / 2
      const y = (silhouette.y0 + silhouette.y1) / 2
      const t = performance.now()
      session.dispatch({ type: 'robotDown', x, y, t }, walker)
      session.dispatch({ type: 'robotMove', x: x + dx, y: y + dy, t: t + ms }, walker)
      walker = session.step(walker, ms / 1000, t + ms) // held while the pointer moves
      session.dispatch({ type: 'robotUp', x: x + dx, y: y + dy, t: t + ms }, walker)
      draw()
    },
    advance: (seconds) => {
      if (!walker || !session || p < 1) return
      walker = session.step(walker, seconds, performance.now())
      draw()
    },
  })
}

async function boot() {
  const text = sources.map((s) => s.textContent).join(' ')
  if (!(await TextFlow.ready(FLOW_FONTS, FONT_TIMEOUT_MS, text))) {
    document.documentElement.dataset.textFlow = 'static' // never paint with fallback widths
    return
  }
  const layer = document.createElement('div')
  layer.id = 'robot-layer'
  document.body.append(layer)
  robot = new RobotSvg(layer)
  const view = () => ({ x0: scrollX, y0: scrollY, x1: scrollX + document.documentElement.clientWidth, y1: scrollY + innerHeight })
  const s = new Session({ terrain: () => page.terrain, checks: routeChecks, view, frame: requestTick }, robot.el, matchMedia('(pointer: coarse)').matches, reduced)
  session = s
  relayout()
  document.documentElement.dataset.textFlow = 'painted'
  listen(robot.el, { live: standsInText, pressing: () => s.ctl.down !== null, send: (e, dom) => s.dispatch(e, walker, dom) })

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) sectionInView.set(e.target.id, e.isIntersecting)
      requestTick()
    },
    { rootMargin: '64px 0px' },
  )
  for (const section of document.querySelectorAll('#bio, .sec')) io.observe(section) // every section with somewhere to stand
  window.addEventListener('scroll', requestTick, { passive: true })
  window.addEventListener('resize', scheduleRefresh)
  new ResizeObserver(scheduleRefresh).observe(document.getElementById('page')!)
}

reducedMotion.addEventListener('change', (e) => setReduced(e.matches))
void boot()
