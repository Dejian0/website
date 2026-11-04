import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  webServer: [
    {
      command: 'npx vite --port 5180 --strictPort',
      url: 'http://localhost:5180',
      reuseExistingServer: true,
    },
    {
      // production build, for tests that depend on the real <link> CSS (no-JS). Built afresh for
      // every run: a preview left running would serve whatever dist/ it was started on.
      command: 'npm run build && npx vite preview --port 5181 --strictPort',
      url: 'http://localhost:5181',
      reuseExistingServer: false,
    },
  ],
  use: { baseURL: 'http://localhost:5180' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
});
