import { defineConfig } from '@playwright/test'

/**
 * Which port the suite runs against.
 *
 * 5173 is Vite's default, which means it is also the default of every other
 * Vite project on the machine - and `reuseExistingServer` cannot tell one of
 * those from ours. It will happily attach to somebody else's application and
 * report failures that are really just a different website.
 *
 * `--strictPort` is what makes that impossible: the server either gets this
 * port or refuses to start, rather than drifting to the next free one and
 * leaving the tests pointed somewhere else.
 */
const PORT = Number(process.env['PORT'] ?? 5173)
const ORIGIN = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    baseURL: ORIGIN,
    launchOptions: {
      // An AudioContext stays suspended until a user gesture. The tests drive
      // playback directly, so the policy is lifted for the test browser only.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
