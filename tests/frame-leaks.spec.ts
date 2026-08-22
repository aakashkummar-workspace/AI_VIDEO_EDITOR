import { expect, test } from '@playwright/test'
import {
  GAPPED_TIMELINE_DURATION,
  gappedTimelineSpec,
} from './fixture.config.mjs'

/** Four seconds of clips inside a five second timeline, at 30fps. */
const EXPECTED_FRAMES = 120

test('a full play-through closes every VideoFrame it opens', async ({
  page,
}) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)

  // A timeline with a gap, so the walk crosses a clip boundary and renders
  // black in between. Both are places a frame could go missing.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )

  const stats = await page.evaluate(() => window.harness.playThrough())
  console.log(
    `play-through: decoded=${stats.decoded} drawn=${stats.drawn}` +
      ` dropped=${stats.dropped} peakBuffer=${stats.peakBuffer}`,
  )

  // The whole timeline really was played, not skipped.
  expect(stats.decoded).toBeGreaterThan(EXPECTED_FRAMES * 0.9)
  expect(stats.drawn).toBeGreaterThan(0)
  expect(stats.decoded).toBe(stats.drawn + stats.dropped)

  const duration = await page.evaluate(() => window.harness.duration())
  expect(duration).toBe(GAPPED_TIMELINE_DURATION)

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

test('the playhead keeps moving through a gap', async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )

  const { times } = await page.evaluate(() => window.harness.playThrough())

  // The gap runs from 2s to 3s and emits a single black item. If the playhead
  // tracked the last drawn frame it would sit at ~2s for a full second and
  // then jump, so positions strictly inside the gap prove it follows the clock.
  const insideGap = times.filter(
    (micros) => micros > 2_100_000 && micros < 2_900_000,
  )
  console.log(`playhead reported ${insideGap.length} positions inside the gap`)

  expect(insideGap.length).toBeGreaterThan(5)
})
