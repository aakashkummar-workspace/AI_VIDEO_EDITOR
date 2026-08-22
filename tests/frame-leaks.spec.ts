import { expect, test } from '@playwright/test'
import { FIXTURE } from './fixture.config.mjs'

test('a full play-through closes every VideoFrame it opens', async ({
  page,
}) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)

  await page.evaluate((url) => window.harness.load(url), `/${FIXTURE.path}`)

  const stats = await page.evaluate(() => window.harness.playThrough())
  console.log(
    `play-through: decoded=${stats.decoded} drawn=${stats.drawn}` +
      ` dropped=${stats.dropped} peakBuffer=${stats.peakBuffer}`,
  )

  // The clip really was played, not skipped.
  expect(stats.decoded).toBeGreaterThan(FIXTURE.frames * 0.9)
  expect(stats.drawn).toBeGreaterThan(0)
  expect(stats.decoded).toBe(stats.drawn + stats.dropped)

  const counts = await page.evaluate(() => window.harness.frameCounts())
  console.log(
    `frames: created=${counts.worker.created}` +
      ` closedInWorker=${counts.worker.closed} closedOnMain=${counts.main.closed}`,
  )

  // Every frame the worker created was closed exactly once, on one side or the
  // other. A leak makes this sum too small; a double close makes it too large.
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)
})
