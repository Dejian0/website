import { defineConfig } from 'vite'
import { sitePrerender } from './src/build/prerender-plugin.ts'

export default defineConfig({
  plugins: [sitePrerender()],
})
