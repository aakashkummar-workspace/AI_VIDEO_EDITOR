import { expect, test } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_B,
  GAPPED_TIMELINE_DURATION,
  gappedTimelineSpec,
} from './fixture.config.mjs'

/**
 * Two seconds of the 30fps source plus two of the 24fps source: 60 + 48 items,
 * inside a five second timeline.
 */
const EXPECTED_FRAMES = 2 * FIXTURE.fps + 2 * FIXTURE_B.fps

test('a full play-through closes every VideoFrame it opens', async ({
  page,
}) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)

  // Two sources and a gap, so the walk crosses a clip boundary, changes source
  // mid-playback, and renders black in between. All places a frame could go.
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )

  const stats = await page.evaluate(() => window.harness.playThrough())
  console.log(
    `play-through: decoded=${stats.decoded} drawn=${stats.drawn}` +
      ` dropped=${stats.dropped} peakBuffer=${stats.peakBuffer}`,
  )

  expect(stats.decoded).toBeGreaterThan(EXPECTED_FRAMES * 0.9)
  expect(stats.drawn).toBeGreaterThan(0)
  expect(stats.decoded).toBe(stats.drawn + stats.dropped)

  const duration = await page.evaluate(() => window.harness.duration())
  expect(duration).toBe(GAPPED_TIMELINE_DURATION)

  const counts = await page.evaluate(() => window.harness.frameCounts())
  console.log(
    `frames: created=${counts.worker.created}` +
      ` closedInWorker=${counts.worker.closed}` +
      ` closedOnMain=${counts.main.closed}` +
      ` openSources=${counts.openSources}`,
  )

  // Every frame the worker created was closed exactly once, on one side or the
  // other. A leak makes this sum too small; a double close makes it too large.
  expect(counts.worker.created).toBeGreaterThan(0)
  expect(counts.worker.closed + counts.main.closed).toBe(counts.worker.created)

  // One Input per source in the project, and no more. Crossing a boundary
  // must not open a new one each time.
  expect(counts.openSources).toBe(2)
})

test('switching source at a clip boundary does not accumulate Inputs', async ({
  page,
}) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )

  // Cross the A/B boundary repeatedly by seeking back and forth.
  for (let pass = 0; pass < 5; pass++) {
    await page.evaluate((t) => window.harness.pixelsAt(t), 1_000_000)
    await page.evaluate((t) => window.harness.pixelsAt(t), 4_000_000)
  }

  const counts = await page.evaluate(() => window.harness.frameCounts())
  console.log(`after 10 source switches: openSources=${counts.openSources}`)

  expect(counts.openSources).toBe(2)
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

test('a 24fps source plays at the timeline clock, not its own rate', async ({
  page,
}) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/tests/harness/')
  await page.waitForFunction(() => 'harness' in window)
  await page.evaluate(
    (spec) => window.harness.loadProject(spec),
    gappedTimelineSpec(),
  )

  const started = Date.now()
  const { times, drawn } = await page.evaluate(() =>
    window.harness.playThrough(),
  )
  const elapsedMicros = (Date.now() - started) * 1000

  console.log(
    `played ${GAPPED_TIMELINE_DURATION / 1000}ms of timeline in` +
      ` ${Math.round(elapsedMicros / 1000)}ms, drew ${drawn} frames`,
  )

  // Real time must match timeline time. If the clock followed a source's frame
  // rate, the 24fps clip would run 25% long (or short) and this would drift.
  expect(elapsedMicros).toBeGreaterThan(GAPPED_TIMELINE_DURATION * 0.85)
  expect(elapsedMicros).toBeLessThan(GAPPED_TIMELINE_DURATION * 1.3)

  // The clip B stretch of the timeline was traversed at the same rate as A.
  const inClipB = times.filter((micros) => micros >= 3_000_000)
  expect(inClipB.length).toBeGreaterThan(20)
  expect(Math.max(...times)).toBeGreaterThan(GAPPED_TIMELINE_DURATION * 0.95)
})
