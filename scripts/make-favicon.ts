// Regenerates public/favicon.svg from the robot renderer: node scripts/make-favicon.ts
import { writeFileSync } from 'node:fs'
import { renderFaviconSvg } from '../src/build/favicon-svg.ts'

writeFileSync(new URL('../public/favicon.svg', import.meta.url), renderFaviconSvg())
