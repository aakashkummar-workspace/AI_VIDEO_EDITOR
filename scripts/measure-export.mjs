/**
 * Times a full export of a real file and watches memory while it runs.
 *
 * A diagnostic, not a test: it depends on the machine and on a file that is
 * not in the repository. Run it when you want to know whether a real timeline
 * exports in a sensible time and without exhausting memory.
 *
 *   npm run export:measure tmp-media/real-source.mp4
 */
import { chromium } from '@playwright/test'

const paths = process.argv.slice(2).map((path) => `${path.replace(/^\/+/, '')}`)
if (paths.length === 0) {
  console.error('usage: node scripts/measure-export.mjs <file under the project>')
  process.exit(1)
}

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ],
})
const page = await browser.newPage({ acceptDownloads: true })

page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
page.on('console', (message) => {
  const text = message.text()
  if (text.startsWith('[playback]')) return
  if (text.startsWith('[vite]')) return
  console.log(`[browser] ${text}`)
})

const heapMb = () =>
  page.evaluate(() => {
    const memory = performance.memory
    return memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : 0
  })

for (const path of paths) {
  await page.goto('http://localhost:5173/')
  await page.setInputFiles('[data-testid=media-input]', path)
  await page.waitForSelector('[data-testid=clip]')

  const duration = await page.getByTestId('time').textContent()
  const baseline = await heapMb()
  console.log(`\n=== ${path} ===`)
  console.log(`  timeline ${duration?.trim()}   heap before ${baseline}MB`)

  let peak = baseline
  const sampler = setInterval(async () => {
    try {
      peak = Math.max(peak, await heapMb())
    } catch {
      // The page went away; nothing to sample.
    }
  }, 250)

  const started = Date.now()
  const downloaded = page.waitForEvent('download', { timeout: 15 * 60_000 })
  await page.getByTestId('add-overlay').isEnabled()
  await page.getByRole('button', { name: 'Export' }).click()

  // Report progress as it goes, so a long export is not a silent wait, and
  // record how long it sits at zero: the audio mix runs to completion before
  // the video walk starts, and nothing moves on screen while it does.
  let lastReported = -1
  let firstMovementMs = null
  const progress = setInterval(async () => {
    try {
      const text = await page.locator('.status-busy').textContent({ timeout: 200 })
      const percent = Number.parseInt(text?.replace(/\D+/g, '') ?? '', 10)
      if (Number.isFinite(percent) && percent !== lastReported) {
        if (percent > 0 && firstMovementMs === null) {
          firstMovementMs = Date.now() - started
        }
        lastReported = percent
        process.stdout.write(`\r  encoding ${percent}%   `)
      }
    } catch {
      // No progress line on screen right now.
    }
  }, 100)

  const download = await downloaded
  const elapsed = (Date.now() - started) / 1000
  clearInterval(progress)
  clearInterval(sampler)

  const file = await download.path()
  const { size } = await (await import('node:fs/promises')).stat(file)

  process.stdout.write('\r')
  console.log(`  exported in ${elapsed.toFixed(1)}s`)
  console.log(`  wrote ${(size / 1024 / 1024).toFixed(1)}MB as ${download.suggestedFilename()}`)
  console.log(`  peak heap ${peak}MB (was ${baseline}MB before)`)
  console.log(
    `  stuck at 0% for ${((firstMovementMs ?? 0) / 1000).toFixed(1)}s` +
      ` while the audio was decoded and mixed`,
  )
}

await browser.close()
