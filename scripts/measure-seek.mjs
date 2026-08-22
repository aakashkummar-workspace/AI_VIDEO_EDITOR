/** Drives tests/harness/measure.html and prints the timings. */
import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage()

page.on('console', (message) => console.log(`[browser] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

await page.goto('http://localhost:5173/tests/harness/measure.html')
await page.waitForFunction(() => 'measure' in window)

const results = await page.evaluate(() => window.measure.run())

for (const result of results) {
  console.log(`\n=== ${result.label} (${(result.bytes / 1024).toFixed(0)} KB) ===`)
  console.log(`  concurrent iterators: ${result.concurrent}`)
  const k = result.keyFrames
  console.log(
    `  packets=${k.packets} keyframes=${k.keyFrames}` +
      ` maxGOP=${k.maxGopSeconds}s first keyframes at ${k.first8.join(', ')}`,
  )
  console.log('  time to first frame, milliseconds:')
  for (const key of ['cold', 'warmNewSink', 'warmSameSink', 'sequential']) {
    const s = result[key]
    console.log(
      `    ${key.padEnd(13)} n=${String(s.count).padStart(2)}` +
        `  min=${String(s.min).padStart(6)}` +
        `  median=${String(s.median).padStart(6)}` +
        `  p90=${String(s.p90).padStart(6)}` +
        `  max=${String(s.max).padStart(6)}`,
    )
  }
}

await browser.close()
