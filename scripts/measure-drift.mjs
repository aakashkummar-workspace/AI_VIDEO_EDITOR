/**
 * Reports how far the picture lags the audio clock during real playback.
 *
 * Deliberately a diagnostic and not a test: it depends on wall-clock scheduling
 * under a real browser, so on a loaded machine it would flake, and a flaky test
 * gets ignored, then deleted, discrediting the sound tests around it. Run it by
 * hand when sync feels wrong: npm run drift
 */
import { chromium } from '@playwright/test'
import { tonesTimelineSpec } from '../tests/fixture.config.mjs'

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()

page.on('console', (message) => console.log(`[browser] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

await page.goto('http://localhost:5173/tests/harness/')
await page.waitForFunction(() => 'harness' in window)
await page.evaluate((spec) => window.harness.loadProject(spec), tonesTimelineSpec())

const passes = Number(process.argv[2] ?? 3)
const results = []

for (let pass = 0; pass < passes; pass++) {
  const stats = await page.evaluate(() => window.harness.playThrough())
  results.push(stats)
  console.log(
    `pass ${pass + 1}: maxDrift=${(stats.maxDriftMicros / 1000).toFixed(1)}ms` +
      ` underruns=${stats.audioUnderruns}` +
      ` chunks=${stats.audioChunks}` +
      ` drawn=${stats.drawn} dropped=${stats.dropped}`,
  )
}

const worst = Math.max(...results.map((r) => r.maxDriftMicros))
const underruns = results.reduce((sum, r) => sum + r.audioUnderruns, 0)

console.log(
  `\nworst drift over ${passes} passes: ${(worst / 1000).toFixed(1)}ms` +
    ` (one frame at 24fps is 41.7ms)`,
)
console.log(`total underruns: ${underruns}`)

await browser.close()
