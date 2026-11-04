import { expect, test } from 'vitest'
import { HERO_SCALE, heroOrigin, renderHeroSvg } from '../../src/build/hero-svg.ts'
import { robotFaces, standingPose } from '../../src/robot/model.ts'
import { fillColor, HERO_CAMERA, project } from '../../src/robot/render.ts'

// The page draws the live robot over the static one from its ground point, so heroOrigin()
// must be where the static SVG puts the ground point, in viewBox units.
test('hero origin is the static drawing’s ground point', () => {
  const svg = renderHeroSvg(HERO_SCALE)
  const polys = project(robotFaces(standingPose()), { ...HERO_CAMERA, scale: HERO_SCALE })
  const o = heroOrigin()
  const starts = [...svg.matchAll(/<path d="M([-\d.]+) ([-\d.]+)L/g)].map((m) => [Number(m[1]), Number(m[2])])
  expect(starts.length).toBe(polys.length)
  starts.forEach(([x, y], i) => {
    expect(Math.abs(x! - (polys[i]!.pts[0]![0] + o.x))).toBeLessThanOrEqual(0.005 + 1e-9)
    expect(Math.abs(y! - (polys[i]!.pts[0]![1] + o.y))).toBeLessThanOrEqual(0.005 + 1e-9)
  })
})

// The live robot takes over at p = 0 drawn shaded (lerpView's hero shade), so the static one is too.
test('the static hero is shaded as the live one draws it', () => {
  const svg = renderHeroSvg(HERO_SCALE)
  const polys = project(robotFaces(standingPose()), { ...HERO_CAMERA, scale: HERO_SCALE })
  const fills = [...svg.matchAll(/<path d="[^"]*" fill="(#[0-9a-f]+)"/g)].map((m) => m[1])
  expect(fills).toEqual(polys.map((p) => fillColor(p, 1)))
  expect(new Set(fills).size).toBeGreaterThan(2)
})

test('the static hero stands on a soft ground shadow, under its faces', () => {
  const svg = renderHeroSvg(HERO_SCALE)
  const filter = /<filter id="([\w-]+)"[^>]*><feGaussianBlur stdDeviation="[\d.]+"\/><\/filter>/.exec(svg)
  expect(filter).not.toBeNull()
  const shadow = svg.indexOf(`<path class="robot-shadow" d="M`)
  expect(shadow).toBeGreaterThan(0)
  expect(svg.slice(shadow)).toMatch(new RegExp(`^<path class="robot-shadow" d="[^"]+" fill="#000" opacity="[\\d.]+" filter="url\\(#${filter![1]}\\)"`))
  expect(shadow).toBeLessThan(svg.indexOf('<path d="M')) // painted first, under the robot
})
