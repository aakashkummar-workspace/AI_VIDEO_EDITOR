/**
 * Regenerates the committed test clip using WebCodecs inside a real browser.
 * No ffmpeg is involved. Run with: npm run fixture
 */
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_B,
  FIXTURE_MUSIC,
  FIXTURE_TONES,
  FIXTURE_TONES_44K,
} from '../tests/fixture.config.mjs'

const browser = await chromium.launch()
const page = await browser.newPage()

page.on('console', (message) => console.log(`[browser] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

await page.goto('http://localhost:5173/tests/harness/')
await page.waitForFunction(() => 'harness' in window)

for (const fixture of [
  FIXTURE,
  FIXTURE_B,
  FIXTURE_TONES,
  FIXTURE_TONES_44K,
  FIXTURE_MUSIC,
]) {
  const bytes = await page.evaluate(
    (options) => window.harness.generateFixture(options),
    {
      frames: fixture.frames,
      width: fixture.width,
      height: fixture.height,
      fps: fixture.fps,
      hueOffset: fixture.hueOffset,
      marker: fixture.marker,
      toneHz: fixture.toneHz,
      audioSampleRate: fixture.audioSampleRate,
      seconds: fixture.seconds,
    },
  )

  writeFileSync(fixture.path, Buffer.from(bytes))
  console.log(`wrote ${fixture.path} (${bytes.length} bytes)`)
}

await browser.close()
