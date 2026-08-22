/**
 * Regenerates the committed test clip using WebCodecs inside a real browser.
 * No ffmpeg is involved. Run with: npm run fixture
 */
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { FIXTURE } from '../tests/fixture.config.mjs'

const browser = await chromium.launch()
const page = await browser.newPage()

page.on('console', (message) => console.log(`[browser] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

await page.goto('http://localhost:5173/tests/harness/')
await page.waitForFunction(() => 'harness' in window)

const bytes = await page.evaluate(
  (options) => window.harness.generateFixture(options),
  {
    frames: FIXTURE.frames,
    width: FIXTURE.width,
    height: FIXTURE.height,
    fps: FIXTURE.fps,
  },
)

writeFileSync(FIXTURE.path, Buffer.from(bytes))
console.log(`wrote ${FIXTURE.path} (${bytes.length} bytes)`)

await browser.close()
